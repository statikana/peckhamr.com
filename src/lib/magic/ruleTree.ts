import {
	detectTargetRequirement,
	parseActivatedAbilities,
	parseAdditionalCostsAndRestrictions,
	parseManaCost,
	parseSpellOrAbilityEffects,
	parseTriggeredEffects,
	type AdditionalCastRequirements,
	type ManaCostRequirement
} from './oracle.ts';
import type {
	CardInstance,
	GameState,
	LibrarySearchInterceptorInfo,
	ManaColor,
	ParsedActivatedAbility,
	ParsedEffect,
	PlayerGameState,
	ScryfallCard,
	TargetRequirementInfo,
	ZoneType
} from './types.ts';
import {
	crossCheckLayerResult,
	getBoardSnapshot,
	layerCacheCheckEnabled,
	type BoardEntry,
	type BoardSnapshot
} from './runtime/layerCache.ts';

export type RulePath =
	| 'cast.normal'
	| 'cast.overload'
	| 'activated.attach'
	| 'activated.loyalty'
	| 'activated.mana'
	| 'activated.ability'
	| 'trigger.on_cast'
	| 'trigger.on_etb'
	| 'trigger.on_dies'
	| 'trigger.on_attack'
	| 'trigger.on_combat_damage_player'
	| 'trigger.on_attach'
	| 'trigger.on_landfall'
	| 'trigger.on_counter_placed'
	| 'trigger.on_end_step'
	| 'hook.cost_modifier'
	| 'hook.trigger_multiplier'
	| 'hook.counter_multiplier'
	| 'hook.stat_modifier'
	| 'hook.grant_keyword'
	| 'hook.stax_restriction';

export type RuleEventName =
	| 'on_cast'
	| 'on_etb'
	| 'on_dies'
	| 'on_attack'
	| 'on_combat_damage_player'
	| 'on_attach'
	| 'on_landfall'
	| 'on_counter_placed'
	| 'on_end_step';

export interface TargetLegalityPredicate {
	zone: 'battlefield' | 'stack' | 'graveyard' | 'player' | 'any' | 'none';
	controller: 'self_controller' | 'opponent' | 'any';
	owner: 'self_owner' | 'opponent' | 'any';
	cardType?: string;
	sameZone: boolean;
	targetInfo: TargetRequirementInfo;
}

export interface ActionRuleNode {
	id: string;
	path:
		| 'cast.normal'
		| 'cast.overload'
		| 'activated.attach'
		| 'activated.loyalty'
		| 'activated.mana'
		| 'activated.ability';
	label: string;
	item: 'self';
	manaCost: string;
	requiresTap: boolean;
	requiresSacrificeSelf: boolean;
	lifeCost: number;
	loyaltyCost: number | null;
	additionalCosts: AdditionalCastRequirements;
	timing: 'instant' | 'sorcery' | 'mana';
	targetLegality: TargetLegalityPredicate;
	targetAmount: {
		min: number;
		max: number;
	};
	action: {
		op: 'attach' | 'resolve_effects' | 'add_mana';
		item: 'self';
		target: 'target[0]' | 'targets' | 'self' | 'none';
		effects: ParsedEffect[];
		producesMana?: ManaColor[];
		producesAmount?: number;
	};
	emitsEvents: RuleEventName[];
	requiresGuidedResolution: boolean;
}

export interface TriggerRuleNode {
	id: string;
	path:
		| 'trigger.on_cast'
		| 'trigger.on_etb'
		| 'trigger.on_dies'
		| 'trigger.on_attack'
		| 'trigger.on_combat_damage_player'
		| 'trigger.on_attach'
		| 'trigger.on_landfall'
		| 'trigger.on_counter_placed'
		| 'trigger.on_end_step';
	event: RuleEventName;
	conditionText: string;
	appliesToSelfOnly: boolean;
	cardTypeFilter?: string;
	enteredCardTypeFilter?: string;
	nontokenOnly?: boolean;
	includeSelf?: boolean;
	spellFilter?: 'InstantOrSorcery' | 'Creature' | 'Noncreature' | 'Any';
	casterFilter?: 'self' | 'any' | 'opponent';
	isMagecraftOrInstantSorceryTrigger?: boolean;
	attackerSubtypeFilter?: string;
	effects: ParsedEffect[];
}

export interface BoardModifierHookNode {
	id: string;
	path:
		| 'hook.cost_modifier'
		| 'hook.trigger_multiplier'
		| 'hook.counter_multiplier'
		| 'hook.stat_modifier'
		| 'hook.grant_keyword'
		| 'hook.stax_restriction';
	label: string;
	activeZones: Array<'battlefield' | 'command'>;
	appliesToController: 'self' | 'opponent' | 'all';
	targetPath?: RulePath;
	cardTypeFilter?: string;
	costMode?: 'set_zero' | 'reduce_generic' | 'increase_generic';
	costDeltaGeneric?: number;
	multiplier?: number;
	powerDelta?: number;
	toughnessDelta?: number;
	grantedKeywords?: string[];
	excludeSelf?: boolean;
	requiresArtifactCountAtLeast?: number;
}

export interface CardRuleTree {
	cardId: string;
	cardName: string;
	paths: Partial<Record<RulePath, Array<ActionRuleNode | TriggerRuleNode | BoardModifierHookNode>>>;
	actions: ActionRuleNode[];
	triggers: TriggerRuleNode[];
	hooks: BoardModifierHookNode[];
}

export interface ActiveBoardHook {
	sourceInstanceId: string;
	sourceCardName: string;
	controllerId: string;
	hook: BoardModifierHookNode;
}

export interface EvaluatedActionNode extends ActionRuleNode {
	effectiveManaCost: string;
	effectiveCostRequirement: ManaCostRequirement;
	appliedHooks: string[];
}

const RULE_TREE_CACHE = new Map<string, CardRuleTree>();

export function clearRuleTreeCache(): void {
	RULE_TREE_CACHE.clear();
}

function addNodeToPathMap(
	paths: CardRuleTree['paths'],
	path: RulePath,
	node: ActionRuleNode | TriggerRuleNode | BoardModifierHookNode
): void {
	const existing = paths[path] || [];
	existing.push(node);
	paths[path] = existing;
}

function buildTargetLegalityPredicate(targetInfo: TargetRequirementInfo): TargetLegalityPredicate {
	const controller: TargetLegalityPredicate['controller'] =
		targetInfo.controllerFilter === 'you'
			? 'self_controller'
			: targetInfo.controllerFilter === 'opponent'
				? 'opponent'
				: 'any';
	const owner: TargetLegalityPredicate['owner'] =
		targetInfo.zone === 'graveyard' && targetInfo.controllerFilter === 'you'
			? 'self_owner'
			: targetInfo.zone === 'graveyard' && targetInfo.controllerFilter === 'opponent'
				? 'opponent'
				: 'any';

	return {
		zone: targetInfo.zone,
		controller,
		owner,
		cardType: targetInfo.cardTypeFilter,
		sameZone: targetInfo.sameGraveyard,
		targetInfo
	};
}

/**
 * Compiles a ScryfallCard's Oracle text into a standardized tree of labeled paths (`CardRuleTree`).
 * Compiled on demand and memoized so cards are never re-parsed unnecessarily.
 */
export function getCardRuleTree(
	card: ScryfallCard,
	commanderIdentity: ManaColor[] = ['W', 'U', 'B', 'R', 'G']
): CardRuleTree {
	const cacheKey = `${card.id || card.name}::${card.oracleText}::${commanderIdentity.join('')}`;
	const cached = RULE_TREE_CACHE.get(cacheKey);
	if (cached) return cached;

	const paths: CardRuleTree['paths'] = {};
	const actions: ActionRuleNode[] = [];
	const triggers: TriggerRuleNode[] = [];
	const hooks: BoardModifierHookNode[] = [];

	const isLandOnly = card.typeLine.includes('Land') && !card.typeLine.includes('Creature');
	const isInstantSpeed =
		card.typeLine.includes('Instant') ||
		card.keywords.some((k) => k.toLowerCase() === 'flash') ||
		/\bflash\b/i.test(card.oracleText.split('\n')[0] || '');

	// 1. Cast Action Path ("cast.normal" and optional "cast.overload")
	if (!isLandOnly) {
		const parsedCast = parseSpellOrAbilityEffects(card);
		const addCosts = parseAdditionalCostsAndRestrictions(card.oracleText);
		const isAura = card.typeLine.includes('Aura');

		const castNode: ActionRuleNode = {
			id: 'cast_normal',
			path: 'cast.normal',
			label: `Cast ${card.name}`,
			item: 'self',
			manaCost: card.manaCost || '{0}',
			requiresTap: false,
			requiresSacrificeSelf: Boolean(addCosts.sacrificePermanentType),
			lifeCost: addCosts.lifeCost,
			loyaltyCost: null,
			additionalCosts: addCosts,
			timing: isInstantSpeed ? 'instant' : 'sorcery',
			targetLegality: buildTargetLegalityPredicate(parsedCast.targetInfo),
			targetAmount: {
				min: parsedCast.targetInfo.minTargets,
				max: parsedCast.targetInfo.maxTargets
			},
			action: {
				op: isAura ? 'attach' : 'resolve_effects',
				item: 'self',
				target: parsedCast.targetInfo.requiresTarget
					? parsedCast.targetInfo.maxTargets === 1
						? 'target[0]'
						: 'targets'
					: 'none',
				effects: parsedCast.effects
			},
			emitsEvents: isAura ? ['on_cast', 'on_attach'] : ['on_cast'],
			requiresGuidedResolution: parsedCast.requiresGuidedResolution
		};

		actions.push(castNode);
		addNodeToPathMap(paths, 'cast.normal', castNode);

		// Overload alternative path (e.g. Cyclonic Rift)
		const overloadMatch = card.oracleText.match(/overload\s+((?:\{[^}]+\})+)/i);
		if (overloadMatch) {
			const noTargetInfo: TargetRequirementInfo = {
				requiresTarget: false,
				targetKind: 'none',
				minTargets: 0,
				maxTargets: 0,
				zone: 'none',
				sameGraveyard: false,
				controllerFilter: 'any'
			};
			const overloadNode: ActionRuleNode = {
				...castNode,
				id: 'cast_overload',
				path: 'cast.overload',
				label: `Overload ${card.name}`,
				manaCost: overloadMatch[1],
				targetLegality: buildTargetLegalityPredicate(noTargetInfo),
				targetAmount: { min: 0, max: 0 },
				action: {
					op: 'resolve_effects',
					item: 'self',
					target: 'none',
					effects: parsedCast.effects
				}
			};
			actions.push(overloadNode);
			addNodeToPathMap(paths, 'cast.overload', overloadNode);
		}
	}

	// 2. Activated Ability Paths ("activated.attach", "activated.loyalty", "activated.mana", "activated.ability")
	const parsedAbilities = parseActivatedAbilities(card, commanderIdentity);
	for (const ab of parsedAbilities) {
		const isAttach =
			ab.id.startsWith('equip_') ||
			/^equip\b/i.test(ab.label) ||
			/^attach\b/i.test(ab.effectText);

		const path: ActionRuleNode['path'] = isAttach
			? 'activated.attach'
			: ab.loyaltyCost !== null
				? 'activated.loyalty'
				: ab.isManaAbility
					? 'activated.mana'
					: 'activated.ability';

		const targetInfo: TargetRequirementInfo = isAttach
			? {
					requiresTarget: true,
					targetKind: 'controlled_creature',
					minTargets: 1,
					maxTargets: 1,
					zone: 'battlefield',
					sameGraveyard: false,
					controllerFilter: 'you',
					cardTypeFilter: 'Creature'
				}
			: ab.targetKind === 'controlled_creature'
				? {
						requiresTarget: true,
						targetKind: 'controlled_creature',
						minTargets: 1,
						maxTargets: 1,
						zone: 'battlefield',
						sameGraveyard: false,
						controllerFilter: 'you',
						cardTypeFilter: 'Creature'
					}
				: detectTargetRequirement(ab.effectText);

		const parsedAbEffects = isAttach
			? { effects: [{ kind: 'equip_target' as const, amount: 1 }], requiresGuidedResolution: false }
			: parseSpellOrAbilityEffects(card, ab.effectText);

		const actionNode: ActionRuleNode = {
			id: ab.id,
			path,
			label: ab.label,
			item: 'self',
			manaCost: ab.manaCost || (isAttach ? '{0}' : ''),
			requiresTap: ab.requiresTap,
			requiresSacrificeSelf: ab.requiresSacrificeSelf,
			lifeCost: ab.lifeCost,
			loyaltyCost: ab.loyaltyCost,
			additionalCosts: {
				lifeCost: ab.lifeCost,
				sacrificePermanentType: ab.requiresSacrificeSelf ? 'Permanent' : null,
				sacrificeAnother: false,
				discardCount: 0,
				onlyDuringCombat: false,
				onlyBeforeAttackersDeclared: false,
				onlyDuringYourTurn: Boolean(ab.sorcerySpeedOnly)
			},
			timing: ab.isManaAbility
				? 'mana'
				: ab.sorcerySpeedOnly || ab.loyaltyCost !== null || isAttach
					? 'sorcery'
					: 'instant',
			targetLegality: buildTargetLegalityPredicate(targetInfo),
			targetAmount: {
				min: targetInfo.requiresTarget ? targetInfo.minTargets : 0,
				max: targetInfo.requiresTarget ? targetInfo.maxTargets : 0
			},
			action: {
				op: isAttach ? 'attach' : ab.isManaAbility ? 'add_mana' : 'resolve_effects',
				item: 'self',
				target: targetInfo.requiresTarget ? 'target[0]' : 'none',
				effects: parsedAbEffects.effects,
				producesMana: ab.producesMana,
				producesAmount: ab.producesAmount
			},
			emitsEvents: isAttach ? ['on_attach'] : [],
			requiresGuidedResolution: false
		};

		actions.push(actionNode);
		addNodeToPathMap(paths, path, actionNode);
	}

	// 3. Triggered Ability Paths ("trigger.on_etb", "trigger.on_dies", "trigger.on_attack", "trigger.on_attach", etc.)
	const etbEffects = parseTriggeredEffects(card, 'etb');
	if (etbEffects.length > 0) {
		const node: TriggerRuleNode = {
			id: 'trig_etb',
			path: 'trigger.on_etb',
			event: 'on_etb',
			conditionText: 'When this permanent enters the battlefield',
			appliesToSelfOnly: true,
			effects: etbEffects
		};
		triggers.push(node);
		addNodeToPathMap(paths, 'trigger.on_etb', node);
	}

	const diesEffects = parseTriggeredEffects(card, 'dies');
	if (diesEffects.length > 0) {
		const node: TriggerRuleNode = {
			id: 'trig_dies',
			path: 'trigger.on_dies',
			event: 'on_dies',
			conditionText: 'When this permanent dies',
			appliesToSelfOnly: true,
			effects: diesEffects
		};
		triggers.push(node);
		addNodeToPathMap(paths, 'trigger.on_dies', node);
	}

	const attackEffects = parseTriggeredEffects(card, 'attack');
	if (attackEffects.length > 0) {
		const node: TriggerRuleNode = {
			id: 'trig_attack',
			path: 'trigger.on_attack',
			event: 'on_attack',
			conditionText: 'Whenever this creature attacks',
			appliesToSelfOnly: true,
			effects: attackEffects
		};
		triggers.push(node);
		addNodeToPathMap(paths, 'trigger.on_attack', node);
	}

	// Parse structured line-by-line triggers: on_attach, observer on_etb, Landfall, on_cast, on_counter_placed, observer on_attack, on_combat_damage_player
	const cNameLow = card.name.toLowerCase();
	const cShortLow = cNameLow.split(',')[0].trim();
	const lines = card.oracleText.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i].trim();
		const line = rawLine.replace(/^[A-Za-z]+\s*[—\-]\s*/, '').trim();
		const low = line.toLowerCase();
		const commaIdx = line.indexOf(',');
		if (commaIdx <= 0) continue;

		const header = line.slice(0, commaIdx).trim();
		const headerLow = header.toLowerCase();
		const clause = line.slice(commaIdx + 1).trim();

		// 3a. "on_attach" triggers ("Whenever ~ becomes attached..." or "Whenever an Equipment becomes attached...")
		if (
			low.startsWith('whenever ') &&
			(low.includes('becomes attached') || low.includes('is attached') || low.includes('you attach'))
		) {
			const parsedTrig = parseSpellOrAbilityEffects(card, clause);
			if (parsedTrig.effects.length > 0) {
				const appliesToSelfOnly =
					low.includes(cNameLow) || low.includes('this equipment') || low.includes('this aura');
				const node: TriggerRuleNode = {
					id: `trig_attach_${i}`,
					path: 'trigger.on_attach',
					event: 'on_attach',
					conditionText: header,
					appliesToSelfOnly,
					effects: parsedTrig.effects
				};
				triggers.push(node);
				addNodeToPathMap(paths, 'trigger.on_attach', node);
			}
			continue;
		}

		// 3b. Landfall triggers ("Whenever a land enters [the battlefield] under your control, ...")
		if (
			/^whenever a land (?:enters(?: the battlefield)? under your control|you control enters)/i.test(
				headerLow
			)
		) {
			const parsedTrig = parseSpellOrAbilityEffects(card, clause);
			if (parsedTrig.effects.length > 0) {
				const node: TriggerRuleNode = {
					id: `trig_landfall_${i}`,
					path: 'trigger.on_landfall',
					event: 'on_etb',
					conditionText: header,
					appliesToSelfOnly: false,
					enteredCardTypeFilter: 'Land',
					effects: parsedTrig.effects
				};
				triggers.push(node);
				addNodeToPathMap(paths, 'trigger.on_landfall', node);
				addNodeToPathMap(paths, 'trigger.on_etb', node);
			}
			continue;
		}

		// 3c. Observer ETB triggers ("Whenever [~ or ]another [nontoken] <Type> enters [the battlefield] under your control, ...")
		const obsEtbMatch = header.match(
			/^whenever (?:.+?\s+or\s+)?another\s+(?:(nontoken)\s+)?([a-zA-Z]+)\s+(?:enters(?: the battlefield)? under your control|you control enters)$/i
		);
		if (obsEtbMatch) {
			const nontokenOnly = Boolean(obsEtbMatch[1]);
			const rawSubtype = obsEtbMatch[2];
			const subtype = rawSubtype.charAt(0).toUpperCase() + rawSubtype.slice(1).toLowerCase();
			const includeSelf = /\bor another\b/i.test(headerLow);
			const parsedTrig = parseSpellOrAbilityEffects(card, clause);
			const effs = [...parsedTrig.effects];
			const dmgIdx = effs.findIndex((e) => e.kind === 'damage_target');
			if (dmgIdx >= 0) {
				effs[dmgIdx] = {
					kind: 'damage_each_opponent',
					amount: effs[dmgIdx].amount
				};
			}
			if (effs.length > 0) {
				const node: TriggerRuleNode = {
					id: `trig_obs_etb_${i}`,
					path: 'trigger.on_etb',
					event: 'on_etb',
					conditionText: header,
					appliesToSelfOnly: false,
					enteredCardTypeFilter: subtype,
					nontokenOnly,
					includeSelf,
					effects: effs
				};
				triggers.push(node);
				addNodeToPathMap(paths, 'trigger.on_etb', node);
			}
			continue;
		}

		// 3d. Spell-cast / Magecraft triggers ("Whenever you cast [or copy] an instant or sorcery / creature / noncreature spell, ..." or "Whenever a player casts a spell, ...")
		if (
			/^whenever you cast (?:or copy )?an instant or sorcery spell$/i.test(headerLow) ||
			/^whenever you cast a (creature|noncreature) spell$/i.test(headerLow) ||
			/^whenever a player casts a spell$/i.test(headerLow)
		) {
			const isInstantOrSorcery = /instant or sorcery/i.test(headerLow);
			const isCreature = /\ba creature spell\b/i.test(headerLow);
			const isNoncreature = /\ba noncreature spell\b/i.test(headerLow);
			const isAnyPlayer = /\ba player casts a spell\b/i.test(headerLow);
			const parsedTrig = parseSpellOrAbilityEffects(card, clause);
			if (parsedTrig.effects.length > 0) {
				const node: TriggerRuleNode = {
					id: `trig_cast_${i}`,
					path: 'trigger.on_cast',
					event: 'on_cast',
					conditionText: header,
					appliesToSelfOnly: false,
					spellFilter: isInstantOrSorcery
						? 'InstantOrSorcery'
						: isCreature
							? 'Creature'
							: isNoncreature
								? 'Noncreature'
								: 'Any',
					casterFilter: isAnyPlayer ? 'any' : 'self',
					isMagecraftOrInstantSorceryTrigger: isInstantOrSorcery,
					effects: parsedTrig.effects
				};
				triggers.push(node);
				addNodeToPathMap(paths, 'trigger.on_cast', node);
			}
			continue;
		}

		// 3e. +1/+1 counter placed on self ("Whenever a +1/+1 counter is placed/put on ~, ...")
		if (
			headerLow.startsWith('whenever a +1/+1 counter is ') &&
			(headerLow.includes(cNameLow) ||
				headerLow.includes(cShortLow) ||
				headerLow.includes('this creature'))
		) {
			const parsedTrig = parseSpellOrAbilityEffects(card, clause);
			if (parsedTrig.effects.length > 0) {
				const node: TriggerRuleNode = {
					id: `trig_counter_${i}`,
					path: 'trigger.on_counter_placed',
					event: 'on_counter_placed',
					conditionText: header,
					appliesToSelfOnly: true,
					effects: parsedTrig.effects
				};
				triggers.push(node);
				addNodeToPathMap(paths, 'trigger.on_counter_placed', node);
			}
			continue;
		}

		// 3f. Observer attack triggers ("Whenever one or more <Subtype>s you control attack, ..." or "Whenever a <Subtype> you control attacks, ...")
		const obsMultiAtkMatch = header.match(
			/^whenever one or more ([a-zA-Z]+)s you control attack$/i
		);
		if (obsMultiAtkMatch) {
			const rawSub = obsMultiAtkMatch[1];
			const subtype = rawSub.charAt(0).toUpperCase() + rawSub.slice(1).toLowerCase();
			const effs: ParsedEffect[] = [];
			if (/draw that many cards/i.test(clause)) {
				effs.push({
					kind: 'draw',
					amount: 1,
					dynamicFormula: `attacking_subtype_count:${subtype}`
				});
			} else {
				const parsedTrig = parseSpellOrAbilityEffects(card, clause);
				effs.push(...parsedTrig.effects);
			}
			if (effs.length > 0) {
				const node: TriggerRuleNode = {
					id: `trig_obs_atk_${i}`,
					path: 'trigger.on_attack',
					event: 'on_attack',
					conditionText: header,
					appliesToSelfOnly: false,
					attackerSubtypeFilter: subtype,
					effects: effs
				};
				triggers.push(node);
				addNodeToPathMap(paths, 'trigger.on_attack', node);
			}
			continue;
		}

		const obsSingleAtkMatch = header.match(/^whenever a ([a-zA-Z]+) you control attacks$/i);
		if (obsSingleAtkMatch) {
			const rawSub = obsSingleAtkMatch[1];
			const subtype = rawSub.charAt(0).toUpperCase() + rawSub.slice(1).toLowerCase();
			const parsedTrig = parseSpellOrAbilityEffects(card, clause);
			if (parsedTrig.effects.length > 0) {
				const node: TriggerRuleNode = {
					id: `trig_obs_atk_each_${i}`,
					path: 'trigger.on_attack',
					event: 'on_attack',
					conditionText: header,
					appliesToSelfOnly: false,
					attackerSubtypeFilter: subtype,
					effects: parsedTrig.effects
				};
				triggers.push(node);
				addNodeToPathMap(paths, 'trigger.on_attack', node);
			}
			continue;
		}

		// 3g. Combat damage to player ("Whenever ~ deals combat damage to a player [or planeswalker], ...")
		if (
			headerLow.startsWith('whenever ') &&
			headerLow.includes('deals combat damage to a player') &&
			(headerLow.includes(cNameLow) ||
				headerLow.includes(cShortLow) ||
				headerLow.includes('this creature'))
		) {
			const parsedTrig = parseSpellOrAbilityEffects(card, clause);
			if (parsedTrig.effects.length > 0) {
				const node: TriggerRuleNode = {
					id: `trig_combat_dmg_${i}`,
					path: 'trigger.on_combat_damage_player',
					event: 'on_combat_damage_player',
					conditionText: header,
					appliesToSelfOnly: true,
					effects: parsedTrig.effects
				};
				triggers.push(node);
				addNodeToPathMap(paths, 'trigger.on_combat_damage_player', node);
			}
			continue;
		}
	}

	// 4. Static Board-State Hooks ("hook.cost_modifier", "hook.stat_modifier", "hook.grant_keyword", etc.)
	const fullLow = card.oracleText.toLowerCase();

	// 4a. Free Attach / Equip Cost Modifier Hooks
	if (
		/equip abilities you activate cost \{0\}/i.test(fullLow) ||
		/equipment you control have equip \{0\}/i.test(fullLow) ||
		/things can be attached for free|attach.*for free|equip.*for free/i.test(fullLow)
	) {
		const requiresArtifactCountAtLeast = /three or more artifacts|metalcraft/i.test(fullLow)
			? 3
			: undefined;
		const hookNode: BoardModifierHookNode = {
			id: 'hook_free_attach',
			path: 'hook.cost_modifier',
			label: `${card.name}: Set attach/equip mana_cost to {0}`,
			activeZones: ['battlefield'],
			appliesToController: 'self',
			targetPath: 'activated.attach',
			costMode: 'set_zero',
			costDeltaGeneric: 0,
			requiresArtifactCountAtLeast
		};
		hooks.push(hookNode);
		addNodeToPathMap(paths, 'hook.cost_modifier', hookNode);
	} else {
		const equipReduceMatch = fullLow.match(
			/equip abilities you activate cost \{(\d+)\} less/i
		);
		if (equipReduceMatch) {
			const red = parseInt(equipReduceMatch[1], 10) || 1;
			const hookNode: BoardModifierHookNode = {
				id: 'hook_reduce_attach',
				path: 'hook.cost_modifier',
				label: `${card.name}: Reduce attach/equip mana_cost by {${red}}`,
				activeZones: ['battlefield'],
				appliesToController: 'self',
				targetPath: 'activated.attach',
				costMode: 'reduce_generic',
				costDeltaGeneric: red
			};
			hooks.push(hookNode);
			addNodeToPathMap(paths, 'hook.cost_modifier', hookNode);
		}
	}

	// 4b. Spell Cost Modifier Hooks (e.g., Eminence, "<Type> spells you cast cost {N} less to cast")
	const spellDiscountMatch = fullLow.match(
		/(?:(other)\s+)?(dragon|elf|goblin|merfolk|zombie|vampire|angel|artifact|enchantment|instant and sorcery|creature|noncreature)\s+spells you cast cost \{(\d+)\} less to cast/i
	);
	if (spellDiscountMatch) {
		const excludeSelf = Boolean(spellDiscountMatch[1]);
		const rawType = spellDiscountMatch[2].toLowerCase();
		const red = parseInt(spellDiscountMatch[3], 10) || 1;
		const typeFilter =
			rawType === 'instant and sorcery'
				? 'InstantOrSorcery'
				: rawType.charAt(0).toUpperCase() + rawType.slice(1);
		const inCommandZoneToo = /command zone/i.test(fullLow);
		const hookNode: BoardModifierHookNode = {
			id: inCommandZoneToo ? 'hook_eminence_spell_discount' : 'hook_spell_discount',
			path: 'hook.cost_modifier',
			label: `${card.name}: ${typeFilter} spells cost {${red}} less`,
			activeZones: inCommandZoneToo ? ['battlefield', 'command'] : ['battlefield'],
			appliesToController: 'self',
			targetPath: 'cast.normal',
			cardTypeFilter: typeFilter,
			costMode: 'reduce_generic',
			costDeltaGeneric: red,
			excludeSelf
		};
		hooks.push(hookNode);
		addNodeToPathMap(paths, 'hook.cost_modifier', hookNode);
	}

	// 4c. Counter & Trigger Multipliers (Corpsejack Menace, Veyran)
	if (/twice that many \+1\/\+1 counters/i.test(fullLow)) {
		const hookNode: BoardModifierHookNode = {
			id: 'hook_counter_doubler',
			path: 'hook.counter_multiplier',
			label: `${card.name}: Double +1/+1 counters placed`,
			activeZones: ['battlefield'],
			appliesToController: 'self',
			multiplier: 2
		};
		hooks.push(hookNode);
		addNodeToPathMap(paths, 'hook.counter_multiplier', hookNode);
	}

	if (/triggers an additional time/i.test(fullLow)) {
		const hookNode: BoardModifierHookNode = {
			id: 'hook_trigger_doubler',
			path: 'hook.trigger_multiplier',
			label: `${card.name}: Instant/Sorcery triggers trigger an additional time`,
			activeZones: ['battlefield'],
			appliesToController: 'self',
			multiplier: 2
		};
		hooks.push(hookNode);
		addNodeToPathMap(paths, 'hook.trigger_multiplier', hookNode);
	}

	const tree: CardRuleTree = {
		cardId: card.id || card.name,
		cardName: card.name,
		paths,
		actions,
		triggers,
		hooks
	};

	RULE_TREE_CACHE.set(cacheKey, tree);
	return tree;
}

/**
 * Collects all active `BoardModifierHookNode`s from the current `GameState` (battlefield + command zone Eminence).
 */
export function collectActiveBoardHooks(state: GameState): ActiveBoardHook[] {
	const activeHooks: ActiveBoardHook[] = [];

	for (const player of state.players) {
		if (player.lost) continue;

		for (const perm of player.battlefield) {
			if (perm.phasedOut || permanentHasLostAllAbilities(perm, state).lost) continue;
			const pCard = perm.copiableCard ?? perm.card;
			const tree = getCardRuleTree(pCard);
			for (const h of tree.hooks) {
				if (h.activeZones.includes('battlefield')) {
					if (
						h.requiresArtifactCountAtLeast &&
						player.battlefield.filter((b) => !b.phasedOut && evaluatePermanent(state, b).isArtifact)
							.length < h.requiresArtifactCountAtLeast
					) {
						continue;
					}
					activeHooks.push({
						sourceInstanceId: perm.instanceId,
						sourceCardName: pCard.name,
						controllerId: player.playerId,
						hook: h
					});
				}
			}
		}

		for (const cmd of player.command) {
			const tree = getCardRuleTree(cmd.card);
			for (const h of tree.hooks) {
				if (h.activeZones.includes('command')) {
					activeHooks.push({
						sourceInstanceId: cmd.instanceId,
						sourceCardName: cmd.card.name,
						controllerId: player.playerId,
						hook: h
					});
				}
			}
		}
	}

	return activeHooks;
}

function matchesHookCardTypeFilter(card: ScryfallCard, filter?: string): boolean {
	if (!filter) return true;
	const t = card.typeLine;
	if (filter === 'InstantOrSorcery') {
		return t.includes('Instant') || t.includes('Sorcery');
	}
	if (filter === 'Noncreature') {
		return !t.includes('Creature');
	}
	return t.includes(filter);
}

/**
 * Evaluates a specific action path or ability ID on a `CardInstance` against the live `GameState`,
 * dynamically applying any active `BoardModifierHookNode`s (such as setting `activated.attach` mana_cost to `{0}`).
 */
export function evaluateActionNode(
	state: GameState,
	actorId: string,
	source: CardInstance,
	pathOrId: RulePath | string,
	xValue = 0
): EvaluatedActionNode | null {
	const actor = state.players.find((p) => p.playerId === actorId);
	const tree = getCardRuleTree(source.card);
	const baseNode = tree.actions.find((a) => a.path === pathOrId || a.id === pathOrId);
	if (!baseNode) return null;

	const activeHooks = collectActiveBoardHooks(state);
	const appliedHooks: string[] = [];

	let forceZeroCost = false;
	let genericReduction = 0;
	let genericIncrease = 0;

	for (const entry of activeHooks) {
		const { hook, controllerId, sourceCardName } = entry;
		if (hook.path !== 'hook.cost_modifier') continue;
		if (hook.appliesToController === 'self' && controllerId !== actorId) continue;
		if (hook.appliesToController === 'opponent' && controllerId === actorId) continue;
		const matchesTargetPath =
			!hook.targetPath ||
			hook.targetPath === baseNode.path ||
			(hook.targetPath === 'cast.normal' && baseNode.path === 'cast.overload');
		if (!matchesTargetPath) continue;
		if (!matchesHookCardTypeFilter(source.card, hook.cardTypeFilter)) continue;

		if (hook.excludeSelf && sourceCardName === source.card.name) {
			continue;
		}

		if (hook.costMode === 'set_zero') {
			forceZeroCost = true;
			appliedHooks.push(hook.label || `${sourceCardName} (set cost to {0})`);
		} else if (hook.costMode === 'reduce_generic' && hook.costDeltaGeneric) {
			genericReduction += hook.costDeltaGeneric;
			appliedHooks.push(hook.label || `${sourceCardName} (-{${hook.costDeltaGeneric}})`);
		} else if (hook.costMode === 'increase_generic' && hook.costDeltaGeneric) {
			genericIncrease += hook.costDeltaGeneric;
			appliedHooks.push(hook.label || `${sourceCardName} (+{${hook.costDeltaGeneric}})`);
		}
	}

	// Handle Commander Tax on cast.normal / cast.overload from Command Zone
	if (
		(baseNode.path === 'cast.normal' || baseNode.path === 'cast.overload') &&
		source.isCommander &&
		source.zone === 'command' &&
		actor
	) {
		const castCount = actor.commanderCastCounts?.[source.instanceId] ?? source.commanderCastCount ?? 0;
		if (castCount > 0) {
			const tax = castCount * state.rules.commanderTaxIncrement;
			genericIncrease += tax;
			appliedHooks.push(`Commander Tax (+{${tax}})`);
		}
	}

	// Self-discount rule ("This spell costs {N} less to cast for each creature on the battlefield.")
	if (baseNode.path === 'cast.normal' || baseNode.path === 'cast.overload') {
		const selfCreatureDiscountMatch = source.card.oracleText.match(
			/this spell costs \{(\d+)\} less to cast for each creature on the battlefield/i
		);
		if (selfCreatureDiscountMatch) {
			const perCreature = parseInt(selfCreatureDiscountMatch[1], 10) || 1;
			let totalCreatures = 0;
			for (const p of state.players) {
				totalCreatures += p.battlefield.filter(
					(c) => !c.phasedOut && evaluatePermanent(state, c).isCreature
				).length;
			}
			const discount = totalCreatures * perCreature;
			if (discount > 0) {
				genericReduction += discount;
				appliedHooks.push(`${source.card.name} (-{${discount}} for creatures on board)`);
			}
		}
	}

	let effectiveManaCost = baseNode.manaCost;
	let effectiveCostRequirement: ManaCostRequirement;

	if (forceZeroCost) {
		effectiveManaCost = '{0}';
		effectiveCostRequirement = parseManaCost('{0}');
	} else {
		effectiveCostRequirement = parseManaCost(
			baseNode.manaCost,
			xValue,
			genericIncrease,
			genericReduction
		);
		if (
			baseNode.path === 'activated.attach' &&
			genericReduction > 0 &&
			effectiveCostRequirement.totalCmc === 0
		) {
			effectiveManaCost = '{0}';
		}
	}

	return {
		...baseNode,
		effectiveManaCost,
		effectiveCostRequirement,
		appliedHooks
	};
}

/**
 * Returns the activated abilities of a permanent with all active board-state hooks applied
 * (e.g., if a free-attach hook is on the board, `Equip {2}` has its `manaCost` modified to `{0}`).
 */
export function getEffectiveActivatedAbilities(
	state: GameState,
	actor: PlayerGameState,
	perm: CardInstance,
	commanderIdentity: ManaColor[] = ['W', 'U', 'B', 'R', 'G']
): ParsedActivatedAbility[] {
	// Check if permanent lost all abilities (and if it gained a new mana ability from Imprisoned in the Moon / Song of the Dryads / Blood Moon)
	const breakdown = inspectCardContinuousBreakdown(perm, state);
	const allInnateRemoved = breakdown.items.some(
		(it) => it.isInnate && it.removed && it.removedBy.length > 0
	);

	let rawAbilities = allInnateRemoved ? [] : parseActivatedAbilities(perm.card, commanderIdentity);

	// Add granted mana abilities from continuous type-changing effects (Imprisoned in the Moon, Song of the Dryads, Blood Moon, Urborg, Yavimaya)
	for (const item of breakdown.items) {
		if (!item.removed && !item.isInnate && item.name.startsWith('Mana Ability: Add ')) {
			const colorMatch = item.name.match(/Add \{([WUBRGC])\}/);
			if (colorMatch) {
				const col = colorMatch[1] as ManaColor;
				const abId = `granted_mana_${col.toLowerCase()}`;
				if (!rawAbilities.some((a) => a.id === abId)) {
					rawAbilities = [
						...rawAbilities,
						{
							id: abId,
							label: `{T}: Add {${col}} (${item.sources.join(', ')})`,
							costText: '{T}',
							manaCost: '{0}',
							requiresTap: true,
							requiresSacrificeSelf: false,
							lifeCost: 0,
							loyaltyCost: null,
							isManaAbility: true,
							producesMana: [col],
							producesAmount: 1,
							effectText: `Add {${col}}.`,
							requiresTarget: false,
							targetKind: 'none'
						}
					];
				}
			}
		}
	}

	return rawAbilities.map((ab) => {
		const evaluated = evaluateActionNode(state, actor.playerId, perm, ab.id);
		if (!evaluated) return ab;
		if (evaluated.effectiveManaCost !== ab.manaCost) {
			return {
				...ab,
				manaCost: evaluated.effectiveManaCost,
				label:
					evaluated.path === 'activated.attach' && evaluated.effectiveManaCost === '{0}'
						? `Equip {0} (was ${ab.manaCost})`
						: ab.label
			};
		}
		return ab;
	});
}

// ============================================================================
// Continuous Layer & Keyword / Effect Attribution Engine (MTG Layers 4, 6, 7)
// ============================================================================

export interface AttributedKeywordOrEffect {
	id: string;
	canonicalKey: string;
	name: string;
	kind: 'keyword' | 'ability' | 'stat_mod' | 'type_mod';
	isInnate: boolean;
	sources: string[]; // e.g. ['innate'] or ['Lightning Greaves']
	removed: boolean;
	removedBy: string[]; // e.g. ['Shadowspear'] or ['Arcane Lighthouse'] or ['Darksteel Mutation']
}

export interface CardContinuousBreakdown {
	baseTypeLine: string;
	effectiveTypeLine: string;
	typeModified: boolean;
	typeModifiedBy: string[];
	basePower: number | null;
	baseToughness: number | null;
	effectivePower: number | null;
	effectiveToughness: number | null;
	ptModifiedBy: string[];
	items: AttributedKeywordOrEffect[];
}

const CANONICAL_COMBAT_KEYWORDS: Array<{ key: string; label: string; regex: RegExp }> = [
	{ key: 'flying', label: 'Flying', regex: /\bflying\b/i },
	{ key: 'first strike', label: 'First strike', regex: /\bfirst strike\b/i },
	{ key: 'double strike', label: 'Double strike', regex: /\bdouble strike\b/i },
	{ key: 'deathtouch', label: 'Deathtouch', regex: /\bdeathtouch\b/i },
	{ key: 'defender', label: 'Defender', regex: /\bdefender\b/i },
	{ key: 'flash', label: 'Flash', regex: /\bflash\b/i },
	{ key: 'haste', label: 'Haste', regex: /\bhaste\b/i },
	{ key: 'hexproof', label: 'Hexproof', regex: /\bhexproof\b/i },
	{ key: 'indestructible', label: 'Indestructible', regex: /\bindestructible\b/i },
	{ key: 'infect', label: 'Infect', regex: /\binfect\b/i },
	{ key: 'lifelink', label: 'Lifelink', regex: /\blifelink\b/i },
	{ key: 'menace', label: 'Menace', regex: /\bmenace\b/i },
	{ key: 'reach', label: 'Reach', regex: /\breach\b/i },
	{ key: 'shroud', label: 'Shroud', regex: /\bshroud\b/i },
	{ key: 'trample', label: 'Trample', regex: /\btrample\b/i },
	{ key: 'vigilance', label: 'Vigilance', regex: /\bvigilance\b/i },
	{ key: 'changeling', label: 'Changeling', regex: /\bchangeling\b/i },
	{ key: 'evolve', label: 'Evolve', regex: /\bevolve\b/i },
	{ key: 'cascade', label: 'Cascade', regex: /\bcascade\b/i }
];

// ----------------------------------------------------------------------------
// Phase 6a: pure text memos for the layer code. Every function here is a pure function of its
// string arguments, so the memos can never go stale; they're bounded by the card pool's texts.
// ----------------------------------------------------------------------------

const TEXT_MEMO_LIMIT = 200_000;
let textMemoSize = 0;
const lowerMemo = new Map<string, string>();
const linesMemo = new Map<string, string[]>();
const matchMemo = new Map<RegExp, Map<string, RegExpMatchArray | null>>();
const keywordsInMemo = new Map<string, Array<{ key: string; label: string; regex: RegExp }>>();
const wordRegexMemo = new Map<string, RegExp>();

function noteTextMemoEntry(): void {
	textMemoSize += 1;
	if (textMemoSize > TEXT_MEMO_LIMIT) {
		lowerMemo.clear();
		linesMemo.clear();
		matchMemo.clear();
		keywordsInMemo.clear();
		wordRegexMemo.clear();
		textMemoSize = 0;
	}
}

/** `s.toLowerCase()`, memoised. */
function lowerOf(s: string): string {
	let v = lowerMemo.get(s);
	if (v === undefined) {
		v = s.toLowerCase();
		noteTextMemoEntry();
		lowerMemo.set(s, v);
	}
	return v;
}

/** `s.split('\n')`, memoised. The returned array is shared: never mutate it. */
function linesOf(s: string): readonly string[] {
	let v = linesMemo.get(s);
	if (v === undefined) {
		v = s.split('\n');
		noteTextMemoEntry();
		linesMemo.set(s, v);
	}
	return v;
}

/**
 * `s.match(re)` for a non-global regex, memoised per (regex object, string). The regex must be a
 * module-level constant (a literal inside a function is a new object on every evaluation). The
 * returned match is shared: never mutate it.
 */
function memoMatch(re: RegExp, s: string): RegExpMatchArray | null {
	let byText = matchMemo.get(re);
	if (!byText) {
		byText = new Map();
		matchMemo.set(re, byText);
	}
	let v = byText.get(s);
	if (v === undefined) {
		v = s.match(re);
		noteTextMemoEntry();
		byText.set(s, v);
	}
	return v;
}

/** `re.test(s)` for a non-global regex, memoised. */
function memoTest(re: RegExp, s: string): boolean {
	return memoMatch(re, s) !== null;
}

/** The canonical keywords whose regex matches `s`, in table order. Shared: never mutate. */
function keywordsIn(s: string): ReadonlyArray<{ key: string; label: string; regex: RegExp }> {
	let v = keywordsInMemo.get(s);
	if (v === undefined) {
		v = CANONICAL_COMBAT_KEYWORDS.filter((kw) => kw.regex.test(s));
		noteTextMemoEntry();
		keywordsInMemo.set(s, v);
	}
	return v;
}

/** `new RegExp(`\\b${word}\\b`, 'i')`, memoised by word. */
function wordRegex(word: string): RegExp {
	let v = wordRegexMemo.get(word);
	if (v === undefined) {
		v = new RegExp(`\\b${word}\\b`, 'i');
		noteTextMemoEntry();
		wordRegexMemo.set(word, v);
	}
	return v;
}

/** The single place the layer code reads a card's rules text. */
function layerCardText(card: ScryfallCard): string {
	return card.oracleText;
}

// Layer-code patterns, hoisted so `memoMatch` can key on them. Each is used exactly as the inline
// literal it replaced, against the same (original-case or lowercased) string.
const RE_ENCHANTED_LOSES_ALL =
	/enchanted (?:creature|permanent)\b.*\bloses all (?:other )?(?:card types and )?abilities/i;
const RE_LOSES_ALL_ABILITIES = /loses all abilities/i;
const RE_OPALESCENCE = /each other non-aura enchantment is a creature in addition/i;
const RE_ENCHANTED_ART_CREATURE =
	/enchanted (?:creature|permanent)\b[^.\n]*?\bis an? ([a-z]+) artifact creature\b/i;
const RE_ENCHANTED_CREATURE_SUB =
	/enchanted (?:creature|permanent)\b[^.\n]*?\bis an? (?:(?:white|blue|black|red|green|colorless) )?([a-z]+) creature\b/i;
const RE_ENCHANTED_LAND =
	/enchanted (?:creature|permanent)\b[^.\n]*?\bis a (?:colorless )?(?:(plains|island|swamp|mountain|forest) )?land\b/i;
const RE_ALL_CREATURES_LOSE = /(?:^|\b)all creatures lose all abilities/i;
const RE_CREATURES_LOSE_LINE = /^creatures lose all abilities/im;
const RE_NONBASIC_LANDS_ARE_TEST = /nonbasic lands are (?:plains|islands|swamps|mountains|forests)\b/i;
const RE_NONBASIC_LANDS_ARE = /nonbasic lands are (plains|islands|swamps|mountains|forests)\b/i;
const RE_BASE_PT = /base power and toughness (\d+)\/(\d+)/i;
const RE_EACH_LAND_IS = /each land is an? (plains|island|swamp|mountain|forest) in addition/i;
const RE_ALL_PERMANENTS_ARTIFACTS = /all permanents are artifacts in addition/i;
const RE_EVERY_CREATURE_TYPE = /creatures you control are every creature type/i;
const RE_WITH_TAP_ADD_SYM = /with "\{t\}:\s*add \{([wubrgc])\}"/i;
const RE_ATTACHED_PT = /(?:equipped|enchanted) creature gets ([+-]\d+)\/([+-]\d+)/i;
const RE_LANDS_ANY_COLOR = /lands you control have "\{t\}:\s*add one mana of any color\.?"/i;
const RE_PW_AND_CREATURES_HAVE =
	/(?:you,\s*)?planeswalkers you control,?\s*and (other )?creatures you control have ([^.\n]+)/i;
const RE_PT_LORD = /^(other )?(?:([a-z]+) )?creatures you control get ([+-]\d+)\/([+-]\d+)/i;
const RE_KW_LORD =
	/^(other )?(?:([a-z]+) )?creatures you control (?:get [+-]\d+\/[+-]\d+ and )?have ([^.\n]+)/i;
const RE_PROTECTION_FROM = /\b(protection from [a-z ,]+?)(?:[.\n]|$)/i;
const RE_OPPONENTS_LOSE = /(creatures|permanents) your opponents control lose ([^.\n]+)/i;

function isEnchantedLosesAllText(low: string): boolean {
	return memoTest(RE_ENCHANTED_LOSES_ALL, low) || memoTest(RE_LOSES_ALL_ABILITIES, low);
}

function isGlobalCreaturesLoseAllText(low: string): boolean {
	return memoTest(RE_ALL_CREATURES_LOSE, low) || memoTest(RE_CREATURES_LOSE_LINE, low);
}

// ----------------------------------------------------------------------------
// Phase 6a: per-board layer view (see runtime/layerCache.ts for the validation strategy).
// ----------------------------------------------------------------------------

type StripSource = { name: string; timestamp: number };

interface LayerEntry extends BoardEntry {
	name: string;
	text: string;
	low: string;
	/** Has an attached ability-stripping Aura (that isn't itself stripped). */
	stripped: boolean;
	/** Text has a controller-scoped grant (anthem, lord, land mana, every creature type). */
	hasControllerGrant: boolean;
}

interface LayerView {
	snap: BoardSnapshot;
	/** Active objects in board order. */
	entries: LayerEntry[];
	/** Active objects in timestamp order. */
	sorted: LayerEntry[];
	/** Unstripped Opalescence-style sources, in board order. */
	opalescenceSourceIds: string[];
	/** Unstripped objects that can make something lose all abilities, in board order. */
	lostRelevant: LayerEntry[];
	/** Unstripped "nonbasic lands are <type>" sources, in timestamp order. */
	nonbasicLandSetters: LayerEntry[];
	/** Unstripped additive type changers (Opalescence, Urborg, Mycosynth, Maskwood), timestamp order. */
	additiveTypeSources: LayerEntry[];
	/** Unstripped "(all) creatures lose all abilities" sources, in timestamp order. */
	globalLoseAllSources: LayerEntry[];
	/** "<…> your opponents control lose <…>" sources (stripped or not), in timestamp order. */
	opponentKeywordRemovers: LayerEntry[];
	stripMemo: Map<string, StripSource[]>;
	lostMemo: Map<CardInstance, { lost: boolean; sources: string[] }>;
}

const LAYER_VIEW_KEY = 'ruleTree.layerView';

function computeStripSources(
	snap: BoardSnapshot,
	permId: string,
	visited: Set<string>
): StripSource[] {
	if (visited.has(permId)) return [];
	visited.add(permId);
	const result: StripSource[] = [];
	for (const other of snap.attachedTo.get(permId) ?? []) {
		const oCard = other.card;
		const oLow = lowerOf(layerCardText(oCard));
		if (isEnchantedLosesAllText(oLow)) {
			if (computeStripSources(snap, other.perm.instanceId, visited).length === 0) {
				result.push({ name: oCard.name, timestamp: other.timestamp });
			}
		}
	}
	return result;
}

/**
 * Checks whether a battlefield permanent has lost all of its innate abilities due to an attached Aura
 * (`Darksteel Mutation`, `Kenrith's Transformation`, `Imprisoned in the Moon`, `Song of the Dryads`).
 * Memoised per board; the result is shared: never mutate it.
 */
function getAttachedAbilityStrippingAuraSources(view: LayerView, permId: string): StripSource[] {
	let v = view.stripMemo.get(permId);
	if (v === undefined) {
		v = computeStripSources(view.snap, permId, new Set());
		view.stripMemo.set(permId, v);
	}
	return v;
}

function getLayerView(snap: BoardSnapshot): LayerView {
	const cached = snap.memo.get(LAYER_VIEW_KEY) as LayerView | undefined;
	if (cached) return cached;
	const view: LayerView = {
		snap,
		entries: [],
		sorted: [],
		opalescenceSourceIds: [],
		lostRelevant: [],
		nonbasicLandSetters: [],
		additiveTypeSources: [],
		globalLoseAllSources: [],
		opponentKeywordRemovers: [],
		stripMemo: new Map(),
		lostMemo: new Map()
	};
	const byEntry = new Map<BoardEntry, LayerEntry>();
	for (const e of snap.active) {
		const text = layerCardText(e.card);
		const le: LayerEntry = {
			...e,
			name: e.card.name,
			text,
			low: lowerOf(text),
			stripped: getAttachedAbilityStrippingAuraSources(view, e.perm.instanceId).length > 0,
			hasControllerGrant: false
		};
		le.hasControllerGrant = textHasControllerGrant(text, le.low);
		byEntry.set(e, le);
		view.entries.push(le);
		if (le.stripped) continue;
		if (memoTest(RE_OPALESCENCE, le.text)) view.opalescenceSourceIds.push(le.perm.instanceId);
		if (
			isEnchantedLosesAllText(le.low) ||
			isGlobalCreaturesLoseAllText(le.low) ||
			memoTest(RE_NONBASIC_LANDS_ARE_TEST, le.low)
		) {
			view.lostRelevant.push(le);
		}
	}
	view.sorted = snap.sorted.map((e) => byEntry.get(e)!);
	for (const le of view.sorted) {
		if (memoTest(RE_OPPONENTS_LOSE, le.text)) view.opponentKeywordRemovers.push(le);
		if (le.stripped) continue;
		if (memoTest(RE_NONBASIC_LANDS_ARE, le.low)) view.nonbasicLandSetters.push(le);
		if (
			memoTest(RE_OPALESCENCE, le.low) ||
			memoTest(RE_EACH_LAND_IS, le.low) ||
			memoTest(RE_ALL_PERMANENTS_ARTIFACTS, le.low) ||
			memoTest(RE_EVERY_CREATURE_TYPE, le.low)
		) {
			view.additiveTypeSources.push(le);
		}
		if (isGlobalCreaturesLoseAllText(le.low)) view.globalLoseAllSources.push(le);
	}
	snap.memo.set(LAYER_VIEW_KEY, view);
	return view;
}

/**
 * Whether the controller-scoped grant block of the layer evaluation can do anything for an object
 * with this text: it only acts on these patterns (the lines loop skips trigger and activated lines).
 */
function textHasControllerGrant(text: string, low: string): boolean {
	if (memoTest(RE_LANDS_ANY_COLOR, low) || memoTest(RE_EVERY_CREATURE_TYPE, low)) return true;
	for (const line of linesOf(text)) {
		const lLow = lowerOf(line);
		if (lLow.startsWith('whenever ') || lLow.startsWith('when ') || lLow.includes(':')) continue;
		if (
			memoTest(RE_PW_AND_CREATURES_HAVE, line) ||
			memoTest(RE_PT_LORD, line) ||
			memoTest(RE_KW_LORD, line)
		) {
			return true;
		}
	}
	return false;
}

function currentLayerView(state: GameState): LayerView {
	return getLayerView(getBoardSnapshot(state));
}

// ----------------------------------------------------------------------------

const INNATE_MEMO = new WeakMap<
	ScryfallCard,
	{
		text: string;
		typeLine: string;
		keywords: string[] | undefined;
		keywordsKey: string;
		result: Array<{ canonicalKey: string; name: string; kind: 'keyword' | 'ability' }>;
	}
>();

/**
 * Memoised `extractSelfInnateKeywordsAndAbilities`, keyed by card object and re-validated against
 * the fields it reads. The result is shared: never mutate it (callers copy each entry).
 */
function innateKeywordsAndAbilitiesOf(
	card: ScryfallCard
): ReadonlyArray<{ canonicalKey: string; name: string; kind: 'keyword' | 'ability' }> {
	const text = layerCardText(card);
	const keywordsKey = (card.keywords || []).join('\u0000');
	const hit = INNATE_MEMO.get(card);
	if (
		hit &&
		hit.text === text &&
		hit.typeLine === card.typeLine &&
		hit.keywords === card.keywords &&
		hit.keywordsKey === keywordsKey
	) {
		return hit.result;
	}
	const result = extractSelfInnateKeywordsAndAbilities(card);
	INNATE_MEMO.set(card, { text, typeLine: card.typeLine, keywords: card.keywords, keywordsKey, result });
	return result;
}

function extractSelfInnateKeywordsAndAbilities(card: ScryfallCard): Array<{
	canonicalKey: string;
	name: string;
	kind: 'keyword' | 'ability';
}> {
	const results: Array<{ canonicalKey: string; name: string; kind: 'keyword' | 'ability' }> = [];
	const seenKeys = new Set<string>();

	const addResult = (canonicalKey: string, name: string, kind: 'keyword' | 'ability') => {
		const k = canonicalKey.toLowerCase();
		if (seenKeys.has(k)) return;
		seenKeys.add(k);
		results.push({ canonicalKey: k, name, kind });
	};

	const lines = (layerCardText(card) || '')
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);

	const isEquipment = card.typeLine.includes('Equipment');
	const isAura = card.typeLine.includes('Aura');

	// 1. Scan lines that grant innate keywords to the card itself (not "equipped creature has..." or "other creatures you control have...")
	for (const line of lines) {
		const low = line.toLowerCase();
		const isGrantingToOthers =
			low.startsWith('equipped ') ||
			low.startsWith('enchanted ') ||
			low.startsWith('creatures ') ||
			low.startsWith('other ') ||
			low.startsWith('you, ') ||
			low.startsWith('all ') ||
			low.startsWith('each ') ||
			low.startsWith('whenever ') ||
			low.startsWith('when ') ||
			low.startsWith('at the beginning ') ||
			low.includes('opponents control lose') ||
			low.includes('target creature gains') ||
			low.includes('it gains ');

		if (!isGrantingToOthers && !low.includes(':')) {
			for (const kw of CANONICAL_COMBAT_KEYWORDS) {
				if (kw.regex.test(line)) {
					addResult(kw.key, kw.label, 'keyword');
				}
			}

			const wardMatch = line.match(/\bward\s*(\{[^}]+\}|\d+)?/i);
			if (wardMatch) {
				const wardCost = wardMatch[1] ? ` ${wardMatch[1]}` : '';
				addResult('ward', `Ward${wardCost}`, 'keyword');
			}

			const protMatch = line.match(/\b(protection from [a-z ,]+?)(?:[.\n]|$)/i);
			if (protMatch) {
				const label =
					protMatch[1].charAt(0).toUpperCase() + protMatch[1].slice(1).trim();
				addResult('protection', label, 'keyword');
			}

			if (/this spell can't be countered/i.test(line)) {
				addResult("can't be countered", "Can't be countered", 'keyword');
			}
			if (/can't be blocked/i.test(line) && !low.startsWith('except')) {
				addResult('unblockable', 'Unblockable', 'keyword');
			}
		}

		// Equip keyword on Equipment
		const equipMatch = line.match(/^equip\s+(\{[^}]+\}|\d+)/i);
		if (equipMatch) {
			addResult('equip', `Equip ${equipMatch[1]}`, 'keyword');
		}

		// Enchant keyword on Auras
		const enchantMatch = line.match(/^enchant\s+([a-z ,]+)/i);
		if (enchantMatch && isAura) {
			addResult('enchant', `Enchant ${enchantMatch[1]}`, 'keyword');
		}
	}

	// Also check card.keywords for keywords that belong to the card itself (filtering out keywords that only appear in "Equipped/Enchanted/Other creatures" clauses)
	for (const rawKw of card.keywords || []) {
		const kwLow = rawKw.toLowerCase();
		if (seenKeys.has(kwLow)) continue;
		if (kwLow === 'equip' || kwLow === 'enchant') continue;

		// If this is an Equipment or Aura (and not a Creature), keywords like Haste/Shroud/Trample in `card.keywords` are for the equipped/enchanted permanent unless stated otherwise
		if ((isEquipment || isAura) && !card.typeLine.includes('Creature') && kwLow !== 'flash' && kwLow !== 'indestructible') {
			continue;
		}

		// Verify the keyword isn't exclusively inside a clause granting it to other permanents
		const matchingLines = lines.filter((l) => l.toLowerCase().includes(kwLow));
		const onlyGrantsToOthers =
			matchingLines.length > 0 &&
			matchingLines.every((l) => {
				const ll = l.toLowerCase();
				return (
					ll.includes('other creatures') ||
					ll.includes('creatures you control') ||
					ll.includes('permanents you control') ||
					ll.includes('equipped creature') ||
					ll.includes('enchanted creature') ||
					ll.includes('it gains ') ||
					ll.includes('opponents control lose')
				);
			});
		if (!onlyGrantsToOthers) {
			addResult(kwLow, rawKw, 'keyword');
		}
	}

	// 2. Summarize innate abilities on the card
	for (const line of lines) {
		const low = line.toLowerCase();
		if (low.startsWith('eminence')) {
			addResult('ability_eminence', 'Eminence Ability', 'ability');
		} else if (low.startsWith('landfall')) {
			addResult('ability_landfall', 'Landfall Trigger', 'ability');
		} else if (low.startsWith('magecraft')) {
			addResult('ability_magecraft', 'Magecraft Trigger', 'ability');
		} else if (/at the beginning of your end step.*proliferate/i.test(low)) {
			addResult('ability_endstep_proliferate', 'End Step: Proliferate', 'ability');
		} else if (low.startsWith('when ') && low.includes('enters')) {
			addResult('ability_etb', 'Enters Battlefield Trigger', 'ability');
		} else if (low.startsWith('whenever ') && low.includes('attacks')) {
			addResult('ability_attack', 'Attack Trigger', 'ability');
		} else if (low.startsWith('whenever ') && low.includes('combat damage')) {
			addResult('ability_combat_dmg', 'Combat Damage Trigger', 'ability');
		} else if (low.startsWith('whenever ') && low.includes('cast')) {
			addResult('ability_cast_trig', 'Spell Cast Trigger', 'ability');
		} else if (/^\{t\}:\s*add\s+([^\n.]+)/i.test(line)) {
			const m = line.match(/^\{t\}:\s*add\s+([^\n.]+)/i);
			addResult('ability_mana', `Mana Ability: Add ${m ? m[1] : 'Mana'}`, 'ability');
		} else if (/no maximum hand size/i.test(low)) {
			addResult('ability_no_max_hand', 'No Maximum Hand Size', 'ability');
		} else if (/equipped creature/i.test(low)) {
			addResult('ability_equip_buff', 'Grants Equipped Creature Buff', 'ability');
		} else if (/enchanted (?:creature|permanent)/i.test(low)) {
			addResult('ability_enchant_mod', 'Modifies Enchanted Permanent', 'ability');
		} else if (/opponents control lose/i.test(low)) {
			addResult('ability_strip_kw', 'Removes Opponent Keywords', 'ability');
		} else if (/(?:other )?[a-z]*\s*creatures you control (?:get|have)/i.test(low)) {
			addResult('ability_lord', 'Anthem / Lord Effect', 'ability');
		} else if (/spells you cast cost/i.test(low)) {
			addResult('ability_cost_mod', 'Spell Cost Reduction', 'ability');
		} else if (/twice that many \+1\/\+1 counters/i.test(low)) {
			addResult('ability_counter_doubler', 'Doubles +1/+1 Counters', 'ability');
		} else if (/triggers an additional time/i.test(low)) {
			addResult('ability_trigger_doubler', 'Doubles Triggered Abilities', 'ability');
		} else if (/control your opponents while they['’]re searching their libraries/i.test(low)) {
			addResult('ability_search_control', 'Control Opponents Searching Libraries', 'ability');
		} else if (/while an opponent is searching their library, they exile each card they find/i.test(low)) {
			addResult('ability_search_exile_steal', 'Exile & Play Opponent Searched Cards', 'ability');
		} else if (line.includes(':') && !low.startsWith('equip')) {
			addResult('ability_activated', 'Activated Ability', 'ability');
		}
	}

	return results;
}
/**
 * Checks whether a permanent has lost all of its abilities due to an attached Aura
 * (`Darksteel Mutation`, `Kenrith's Transformation`, `Imprisoned in the Moon`, `Song of the Dryads`)
 * or a global enchantment (`Humility`, `Dress Down`, `Blood Moon`).
 */
export function permanentHasLostAllAbilities(
	perm: CardInstance,
	state: GameState
): { lost: boolean; sources: string[] } {
	const r = lostAllAbilitiesIn(currentLayerView(state), perm);
	const out = { lost: r.lost, sources: [...r.sources] };
	if (layerCacheCheckEnabled()) {
		crossCheckLayerResult(
			'permanentHasLostAllAbilities',
			out,
			() => permanentHasLostAllAbilities(perm, state),
			(ref) => ref.permanentHasLostAllAbilities(perm, state)
		);
	}
	return out;
}

/**
 * Memoised per board for objects that are on the battlefield (their own fields are part of the
 * board fingerprint). The result is shared: never mutate it.
 */
function lostAllAbilitiesIn(
	view: LayerView,
	perm: CardInstance
): { lost: boolean; sources: string[] } {
	const cacheable = view.snap.objects.has(perm);
	if (cacheable) {
		const hit = view.lostMemo.get(perm);
		if (hit) return hit;
	}
	const r = computeLostAllAbilities(view, perm);
	if (cacheable) view.lostMemo.set(perm, r);
	return r;
}

function computeLostAllAbilities(
	view: LayerView,
	perm: CardInstance
): { lost: boolean; sources: string[] } {
	const sources: string[] = [];
	const baseCard = perm.copiableCard ?? perm.card;
	const hasOpalescenceOnBoard = view.opalescenceSourceIds.some((id) => id !== perm.instanceId);

	let effectiveTypeLine = perm.isFaceDown ? 'Creature' : baseCard.typeLine;
	const attachedTypePerms = [...(view.snap.attachedTo.get(perm.instanceId) ?? [])].sort(
		(a, b) => a.timestamp - b.timestamp
	);
	for (const att of attachedTypePerms) {
		if (getAttachedAbilityStrippingAuraSources(view, att.perm.instanceId).length > 0) continue;
		const aText = layerCardText(att.card);
		const artCreatureMatch = memoMatch(RE_ENCHANTED_ART_CREATURE, aText);
		const creatureSubMatch = !artCreatureMatch
			? memoMatch(RE_ENCHANTED_CREATURE_SUB, aText)
			: null;
		const landMatch = memoMatch(RE_ENCHANTED_LAND, aText);
		if (artCreatureMatch) {
			effectiveTypeLine = `Artifact Creature — ${artCreatureMatch[1]}`;
		} else if (creatureSubMatch) {
			effectiveTypeLine = `Creature — ${creatureSubMatch[1]}`;
		} else if (landMatch) {
			effectiveTypeLine = landMatch[1] ? `Land — ${landMatch[1]}` : 'Land';
		}
	}

	const isCreature =
		effectiveTypeLine.includes('Creature') ||
		(hasOpalescenceOnBoard &&
			effectiveTypeLine.includes('Enchantment') &&
			!effectiveTypeLine.includes('Aura'));
	const isNonBasicLand =
		effectiveTypeLine.includes('Land') && !baseCard.typeLine.includes('Basic');

	// Only unstripped objects with one of the three patterns can contribute (in board order).
	for (const other of view.lostRelevant) {
		const oName = other.name;
		const oLow = other.low;

		if (other.perm.attachedToId === perm.instanceId) {
			if (isEnchantedLosesAllText(oLow)) {
				if (!sources.includes(oName)) sources.push(oName);
			}
		}

		if (isCreature && isGlobalCreaturesLoseAllText(oLow)) {
			if (!sources.includes(oName)) sources.push(oName);
		}

		if (isNonBasicLand && memoTest(RE_NONBASIC_LANDS_ARE_TEST, oLow)) {
			if (!sources.includes(oName)) sources.push(oName);
		}
	}

	return { lost: sources.length > 0, sources };
}

function addSubtypeToTypeLine(typeLine: string, subtype: string): string {
	if (new RegExp(`\\b${subtype}\\b`, 'i').test(typeLine)) return typeLine;
	if (typeLine.includes('—')) {
		return `${typeLine} ${subtype}`;
	}
	return `${typeLine} — ${subtype}`;
}

function addCardTypeToTypeLine(typeLine: string, cardType: string): string {
	if (new RegExp(`\\b${cardType}\\b`, 'i').test(typeLine)) return typeLine;
	if (typeLine.includes('—')) {
		const [left, right] = typeLine.split('—');
		return `${left.trim()} ${cardType} — ${right.trim()}`;
	}
	return `${typeLine.trim()} ${cardType}`;
}

function capitalizeWord(word: string): string {
	if (!word) return word;
	return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

const BASIC_LAND_MANA_MAP: Record<string, { subtype: string; sym: string }> = {
	plains: { subtype: 'Plains', sym: 'W' },
	island: { subtype: 'Island', sym: 'U' },
	swamp: { subtype: 'Swamp', sym: 'B' },
	mountain: { subtype: 'Mountain', sym: 'R' },
	forest: { subtype: 'Forest', sym: 'G' }
};

/**
 * Evaluates a card or battlefield permanent against MTG Continuous Effect Layers 1 through 7d,
 * returning all innate keywords/abilities (`(innate)`), granted keywords/abilities (`(Source)`),
 * removed keywords/abilities (`--keyword-- (innate) (removed by Source)`), and complex type/P&T modifications.
 */
export function inspectCardContinuousBreakdown(
	cardOrInst: CardInstance | ScryfallCard,
	state?: GameState
): CardContinuousBreakdown {
	const out = inspectCardContinuousBreakdownIn(cardOrInst, state, null);
	if (state && layerCacheCheckEnabled()) {
		crossCheckLayerResult(
			'inspectCardContinuousBreakdown',
			out,
			() => inspectCardContinuousBreakdown(cardOrInst, state),
			(ref) => ref.inspectCardContinuousBreakdown(cardOrInst, state)
		);
	}
	return out;
}

function inspectCardContinuousBreakdownIn(
	cardOrInst: CardInstance | ScryfallCard,
	state: GameState | undefined,
	viewIn: LayerView | null
): CardContinuousBreakdown {
	let inst: CardInstance | null = null;
	let card: ScryfallCard;

	if ('instanceId' in cardOrInst) {
		inst = cardOrInst;
		// Layer 1 (Copy effects — CR 613.1a & CR 707.2): Use copiableCard if present
		card = cardOrInst.copiableCard ?? cardOrInst.card;
	} else {
		card = cardOrInst;
		if (state) {
			// Locate matching CardInstance on battlefield first, then other zones
			for (const p of state.players) {
				const foundBf = p.battlefield.find(
					(c) => c.card.id === card.id || c.card.name === card.name
				);
				if (foundBf) {
					inst = foundBf;
					card = foundBf.copiableCard ?? foundBf.card;
					break;
				}
			}
			if (!inst) {
				for (const p of state.players) {
					const foundOther =
						p.command.find((c) => c.card.id === card.id || c.card.name === card.name) ||
						p.hand.find((c) => c.card.id === card.id || c.card.name === card.name) ||
						p.graveyard.find((c) => c.card.id === card.id || c.card.name === card.name) ||
						p.exile.find((c) => c.card.id === card.id || c.card.name === card.name);
					if (foundOther) {
						inst = foundOther;
						break;
					}
				}
			}
		}
	}

	const isFaceDown = Boolean(inst?.isFaceDown);
	const baseTypeLine = isFaceDown ? 'Creature' : card.typeLine;
	let effectiveTypeLine = baseTypeLine;
	const typeModifiedBy: string[] = [];

	const rawP = isFaceDown ? 2 : card.power !== undefined ? parseInt(card.power, 10) : null;
	const rawT = isFaceDown ? 2 : card.toughness !== undefined ? parseInt(card.toughness, 10) : null;
	const basePower = rawP !== null && !isNaN(rawP) ? rawP : null;
	const baseToughness = rawT !== null && !isNaN(rawT) ? rawT : null;

	let workingPower = basePower;
	let workingToughness = baseToughness;
	const ptModifiedBy: string[] = [];

	// 1. Seed innate keywords & abilities from the card itself (empty if face-down per CR 702.37a)
	const innateList = isFaceDown ? [] : innateKeywordsAndAbilitiesOf(card);
	const itemTimestamps = new Map<string, number>();
	const items: AttributedKeywordOrEffect[] = innateList.map((entry, idx) => {
		const id = `innate_${idx}_${entry.canonicalKey}`;
		itemTimestamps.set(id, -Infinity);
		return {
			id,
			canonicalKey: entry.canonicalKey,
			name: entry.name,
			kind: entry.kind,
			isInnate: true,
			sources: ['innate'],
			removed: false,
			removedBy: []
		};
	});

	const isOnBattlefield = Boolean(
		inst &&
			state &&
			!inst.phasedOut &&
			(inst.zone === 'battlefield' ||
				(viewIn?.snap ?? getBoardSnapshot(state)).instanceIds.has(inst.instanceId))
	);

	if (!inst || !state || !isOnBattlefield) {
		return {
			baseTypeLine,
			effectiveTypeLine,
			typeModified: false,
			typeModifiedBy: [],
			basePower,
			baseToughness,
			effectivePower: basePower,
			effectiveToughness: baseToughness,
			ptModifiedBy: [],
			items
		};
	}

	const view = viewIn ?? currentLayerView(state);
	const isLegendary = baseTypeLine.includes('Legendary');
	const prefixLegendary = isLegendary ? 'Legendary ' : '';
	const allAbilityRemovalSources: string[] = [];
	const abilityRemovalEvents: Array<{ sourceName: string; timestamp: number }> = [];
	const recordAbilityRemoval = (sourceName: string, timestamp: number) => {
		if (!allAbilityRemovalSources.includes(sourceName)) {
			allAbilityRemovalSources.push(sourceName);
		}
		if (
			!abilityRemovalEvents.some(
				(e) => e.sourceName === sourceName && e.timestamp === timestamp
			)
		) {
			abilityRemovalEvents.push({ sourceName, timestamp });
		}
	};

	// All active (non-phased-out) battlefield permanents sorted by timestamp (CR 613.7), from the
	// per-board view. Shared: never mutate.
	const allBattlefieldPerms = view.sorted;

	// Track Layer 7b base P/T setting effects with timestamps so later timestamps win (CR 613.4b & 613.7)
	const layer7bSetters: Array<{
		sourceName: string;
		power: number | null;
		toughness: number | null;
		timestamp: number;
	}> = [];

	const grantItem = (
		canonicalKey: string,
		name: string,
		kind: 'keyword' | 'ability' | 'stat_mod' | 'type_mod',
		sourceName: string,
		grantTimestamp = 0
	) => {
		const keyLow = canonicalKey.toLowerCase();
		const existingActive = items.find(
			(it) => it.canonicalKey === keyLow && !it.removed && it.kind === kind
		);
		if (existingActive) {
			if (!existingActive.sources.includes(sourceName)) {
				existingActive.sources.push(sourceName);
			}
			const prevTs = itemTimestamps.get(existingActive.id) ?? -Infinity;
			if (grantTimestamp > prevTs) {
				itemTimestamps.set(existingActive.id, grantTimestamp);
			}
			return;
		}
		const id = `granted_${items.length}_${keyLow}`;
		itemTimestamps.set(id, grantTimestamp);
		items.push({
			id,
			canonicalKey: keyLow,
			name,
			kind,
			isInnate: false,
			sources: [sourceName],
			removed: false,
			removedBy: []
		});
	};

	const applyRemovalsUpTo = (cutoffTimestamp: number) => {
		for (const ev of abilityRemovalEvents) {
			if (ev.timestamp > cutoffTimestamp) continue;
			for (const item of items) {
				if (item.kind !== 'keyword' && item.kind !== 'ability' && !item.isInnate) continue;
				const itemTs = itemTimestamps.get(item.id) ?? -Infinity;
				if (itemTs < ev.timestamp) {
					item.removed = true;
					if (!item.removedBy.includes(ev.sourceName)) {
						item.removedBy.push(ev.sourceName);
					}
				}
			}
		}
	};

	// 2. Layer 4 (Type-changing effects) & Layer 6 (Loses all abilities) & collect Layer 7b Base P/T setters
	for (const entry of allBattlefieldPerms) {
		if (entry.perm.attachedToId !== inst.instanceId) continue;
		const { timestamp } = entry;
		if (entry.stripped) continue;
		const pName = entry.name;
		const pText = entry.text;
		const pLow = entry.low;

		// Check attached Auras/Equipment on `inst`
		{
			const losesAbilities = isEnchantedLosesAllText(pLow);
			if (losesAbilities) {
				recordAbilityRemoval(pName, timestamp);
			}

			const basePtMatch = memoMatch(RE_BASE_PT, pLow);
			const artCreatureMatch = memoMatch(RE_ENCHANTED_ART_CREATURE, pText);
			const creatureSubMatch = !artCreatureMatch
				? memoMatch(RE_ENCHANTED_CREATURE_SUB, pText)
				: null;
			const landMatch = memoMatch(RE_ENCHANTED_LAND, pText);

			if (artCreatureMatch) {
				const sub = capitalizeWord(artCreatureMatch[1]);
				effectiveTypeLine = `${prefixLegendary}Artifact Creature — ${sub}`;
				if (!typeModifiedBy.includes(pName)) typeModifiedBy.push(pName);
			} else if (creatureSubMatch) {
				const sub = capitalizeWord(creatureSubMatch[1]);
				effectiveTypeLine = `${prefixLegendary}Creature — ${sub}`;
				if (!typeModifiedBy.includes(pName)) typeModifiedBy.push(pName);
			} else if (landMatch) {
				if (landMatch[1]) {
					const sub = capitalizeWord(landMatch[1]);
					effectiveTypeLine = `${prefixLegendary}Land — ${sub}`;
				} else {
					effectiveTypeLine = `${prefixLegendary}Land`;
				}
				if (!typeModifiedBy.includes(pName)) typeModifiedBy.push(pName);
				layer7bSetters.push({ sourceName: pName, power: null, toughness: null, timestamp });
			}

			if (basePtMatch) {
				layer7bSetters.push({
					sourceName: pName,
					power: parseInt(basePtMatch[1], 10),
					toughness: parseInt(basePtMatch[2], 10),
					timestamp
				});
			}
		}
	}

	// Global Layer 4 Pass A: Type-overwriting effects ("Nonbasic lands are Mountains.")
	for (const entry of view.nonbasicLandSetters) {
		const { timestamp } = entry;
		const pName = entry.name;
		const pLow = entry.low;

		const nonbasicLandMatch = memoMatch(RE_NONBASIC_LANDS_ARE, pLow);
		if (
			nonbasicLandMatch &&
			effectiveTypeLine.includes('Land') &&
			!baseTypeLine.includes('Basic')
		) {
			const rawKey = nonbasicLandMatch[1].toLowerCase();
			const landKey = rawKey === 'plains' ? 'plains' : rawKey.replace(/s$/, '');
			const info = BASIC_LAND_MANA_MAP[landKey];
			if (info) {
				effectiveTypeLine = `${prefixLegendary}Land — ${info.subtype}`;
				if (!typeModifiedBy.includes(pName)) typeModifiedBy.push(pName);
				recordAbilityRemoval(pName, timestamp);
			}
		}
	}

	// Global Layer 4 Pass B (Additive types: Opalescence, Urborg, Yavimaya, Mycosynth Lattice, Maskwood Nexus)
	for (const entry of view.additiveTypeSources) {
		const { playerId, timestamp } = entry;
		const perm = entry.perm;
		const pName = entry.name;
		const pLow = entry.low;

		if (
			memoTest(RE_OPALESCENCE, pLow) &&
			perm.instanceId !== inst.instanceId &&
			effectiveTypeLine.includes('Enchantment') &&
			!effectiveTypeLine.includes('Aura')
		) {
			effectiveTypeLine = addCardTypeToTypeLine(effectiveTypeLine, 'Creature');
			if (!typeModifiedBy.includes(pName)) typeModifiedBy.push(pName);
			layer7bSetters.push({
				sourceName: pName,
				power: card.cmc,
				toughness: card.cmc,
				timestamp
			});
		}

		const eachLandMatch = memoMatch(RE_EACH_LAND_IS, pLow);
		if (eachLandMatch && effectiveTypeLine.includes('Land')) {
			const info = BASIC_LAND_MANA_MAP[eachLandMatch[1].toLowerCase()];
			if (info) {
				const nextType = addSubtypeToTypeLine(effectiveTypeLine, info.subtype);
				if (nextType !== effectiveTypeLine) {
					effectiveTypeLine = nextType;
				}
				if (!typeModifiedBy.includes(pName)) typeModifiedBy.push(pName);
			}
		}

		if (memoTest(RE_ALL_PERMANENTS_ARTIFACTS, pLow)) {
			const nextType = addCardTypeToTypeLine(effectiveTypeLine, 'Artifact');
			if (nextType !== effectiveTypeLine) {
				effectiveTypeLine = nextType;
				if (!typeModifiedBy.includes(pName)) typeModifiedBy.push(pName);
			}
		}

		if (
			playerId === inst.controllerId &&
			memoTest(RE_EVERY_CREATURE_TYPE, pLow) &&
			effectiveTypeLine.includes('Creature')
		) {
			effectiveTypeLine = addSubtypeToTypeLine(effectiveTypeLine, 'All-Types');
			if (!typeModifiedBy.includes(pName)) typeModifiedBy.push(pName);
		}
	}

	// Global Layer 6 ("All creatures lose all abilities..." / "Creatures lose all abilities.") & Layer 7b registration
	for (const entry of view.globalLoseAllSources) {
		const { timestamp } = entry;
		const pName = entry.name;
		const pLow = entry.low;

		if (effectiveTypeLine.includes('Creature') && isGlobalCreaturesLoseAllText(pLow)) {
			recordAbilityRemoval(pName, timestamp);
			const ptMatch = memoMatch(RE_BASE_PT, pLow);
			if (ptMatch) {
				layer7bSetters.push({
					sourceName: pName,
					power: parseInt(ptMatch[1], 10),
					toughness: parseInt(ptMatch[2], 10),
					timestamp
				});
			}
		}
	}

	// Evaluate Layer 7a (Characteristic-Defining Abilities like `*/*`)
	if (effectiveTypeLine.includes('Creature')) {
		if (workingPower === null) workingPower = 0;
		if (workingToughness === null) workingToughness = 0;
		if (
			allAbilityRemovalSources.length === 0 &&
			(card.power === '*' || card.toughness === '*')
		) {
			const cLow = lowerOf(layerCardText(card));
			if (cLow.includes('number of creatures you control')) {
				const ctrl = state.players.find((p) => p.playerId === inst!.controllerId);
				const count =
					ctrl?.battlefield.filter((b) => !b.phasedOut && b.card.typeLine.includes('Creature'))
						.length ?? 0;
				workingPower = count;
				workingToughness = count;
				ptModifiedBy.push(`${card.name} CDA (${count}/${count})`);
			} else if (cLow.includes('creature cards in all graveyards')) {
				const count = state.players.reduce(
					(acc, pl) =>
						acc + pl.graveyard.filter((g) => g.card.typeLine.includes('Creature')).length,
					0
				);
				workingPower = count;
				workingToughness = count;
				ptModifiedBy.push(`${card.name} CDA (${count}/${count})`);
			}
		}
	}

	// Evaluate Layer 7b (Set Base P/T to specific values in strict Timestamp Order — CR 613.4b & 613.7)
	layer7bSetters.sort((a, b) => a.timestamp - b.timestamp);
	for (const setter of layer7bSetters) {
		workingPower = setter.power;
		workingToughness = setter.toughness;
		if (setter.power !== null && setter.toughness !== null) {
			const label = `${setter.sourceName} (base ${setter.power}/${setter.toughness})`;
			if (!ptModifiedBy.includes(label)) {
				ptModifiedBy.push(label);
			}
		}
	}

	// Mark all innate items as removed if any `allAbilityRemovalSources` apply
	if (allAbilityRemovalSources.length > 0) {
		for (const item of items) {
			if (item.isInnate) {
				item.removed = true;
				for (const src of allAbilityRemovalSources) {
					if (!item.removedBy.includes(src)) {
						item.removedBy.push(src);
					}
				}
			}
		}
	}

	// 3. Grant new abilities from Layer 4 / Layer 6 continuous effects & Layer 7c P/T modifiers in timestamp order
	for (const entry of allBattlefieldPerms) {
		const { perm, playerId, timestamp } = entry;
		if (abilityRemovalEvents.length > 0) applyRemovalsUpTo(timestamp);
		if (entry.stripped) continue;
		const pName = entry.name;
		const pText = entry.text;
		const pLow = entry.low;

		// Attached Auras & Equipment
		if (perm.attachedToId === inst.instanceId) {
			const basePtMatch = memoMatch(RE_BASE_PT, pLow);
			const ptSuffix = basePtMatch ? ` (${basePtMatch[1]}/${basePtMatch[2]})` : '';
			const artCreatureMatch = memoMatch(RE_ENCHANTED_ART_CREATURE, pText);
			const creatureSubMatch = !artCreatureMatch
				? memoMatch(RE_ENCHANTED_CREATURE_SUB, pText)
				: null;
			const landMatch = memoMatch(RE_ENCHANTED_LAND, pText);

			if (artCreatureMatch) {
				const sub = capitalizeWord(artCreatureMatch[1]);
				grantItem(
					`type_${sub.toLowerCase()}`,
					`Type: Artifact Creature — ${sub}${ptSuffix}`,
					'type_mod',
					pName,
					timestamp
				);
			} else if (creatureSubMatch) {
				const sub = capitalizeWord(creatureSubMatch[1]);
				grantItem(
					`type_${sub.toLowerCase()}`,
					`Type: Creature — ${sub}${ptSuffix}`,
					'type_mod',
					pName,
					timestamp
				);
			} else if (landMatch) {
				if (landMatch[1]) {
					const info = BASIC_LAND_MANA_MAP[landMatch[1].toLowerCase()];
					if (info) {
						grantItem(
							`mana_${info.sym.toLowerCase()}`,
							`Mana Ability: Add {${info.sym}}`,
							'ability',
							pName,
							timestamp
						);
						grantItem(
							`type_${info.subtype.toLowerCase()}`,
							`Type: Land — ${info.subtype}`,
							'type_mod',
							pName,
							timestamp
						);
					}
				} else {
					const addSymMatch = memoMatch(RE_WITH_TAP_ADD_SYM, pText);
					if (addSymMatch) {
						const sym = addSymMatch[1].toUpperCase();
						grantItem(
							`mana_${sym.toLowerCase()}`,
							`Mana Ability: Add {${sym}}`,
							'ability',
							pName,
							timestamp
						);
					}
					grantItem('type_land', 'Type: Colorless Land', 'type_mod', pName, timestamp);
				}
			}

			// Generic attached Equipment / Aura keyword parser
			for (const line of linesOf(pText)) {
				const lLow = lowerOf(line);
				if (
					(lLow.includes('equipped creature') ||
						lLow.includes('enchanted creature') ||
						lLow.includes('enchanted permanent')) &&
					(lLow.includes('has ') || lLow.includes('gains ') || lLow.includes('and '))
				) {
					for (const kw of keywordsIn(line)) {
						grantItem(kw.key, kw.label, 'keyword', pName, timestamp);
					}
					const protMatch = memoMatch(RE_PROTECTION_FROM, line);
					if (protMatch) {
						const label =
							protMatch[1].charAt(0).toUpperCase() + protMatch[1].slice(1).trim();
						grantItem('protection', label, 'keyword', pName, timestamp);
					}
				}
			}

			// Attached P/T modifier (e.g., "Equipped creature gets +1/+1")
			const eqPtMatch = memoMatch(RE_ATTACHED_PT, pText);
			if (eqPtMatch && workingPower !== null && workingToughness !== null) {
				const dp = parseInt(eqPtMatch[1], 10) || 0;
				const dt = parseInt(eqPtMatch[2], 10) || 0;
				workingPower += dp;
				workingToughness += dt;
				const signP = dp >= 0 ? `+${dp}` : `${dp}`;
				const signT = dt >= 0 ? `+${dt}` : `${dt}`;
				grantItem(`pt_${pName}`, `${signP}/${signT}`, 'stat_mod', pName, timestamp);
				ptModifiedBy.push(`${signP}/${signT} (${pName})`);
			}
		}

		// Global Land Type-Grants
		const nonbasicLandMatch = memoMatch(RE_NONBASIC_LANDS_ARE, pLow);
		if (
			nonbasicLandMatch &&
			effectiveTypeLine.includes('Land') &&
			!baseTypeLine.includes('Basic')
		) {
			const rawKey = nonbasicLandMatch[1].toLowerCase();
			const landKey = rawKey === 'plains' ? 'plains' : rawKey.replace(/s$/, '');
			const info = BASIC_LAND_MANA_MAP[landKey];
			if (info) {
				grantItem(
					`mana_${info.sym.toLowerCase()}`,
					`Mana Ability: Add {${info.sym}}`,
					'ability',
					pName,
					timestamp
				);
				grantItem(
					`type_${info.subtype.toLowerCase()}`,
					`Type: Land — ${info.subtype}`,
					'type_mod',
					pName,
					timestamp
				);
			}
		}

		const eachLandMatch = memoMatch(RE_EACH_LAND_IS, pLow);
		if (eachLandMatch && effectiveTypeLine.includes('Land')) {
			const info = BASIC_LAND_MANA_MAP[eachLandMatch[1].toLowerCase()];
			if (info) {
				grantItem(
					`mana_${info.sym.toLowerCase()}`,
					`Mana Ability: Add {${info.sym}}`,
					'ability',
					pName,
					timestamp
				);
				grantItem(
					info.subtype === 'Forest'
						? 'type_forest_add'
						: `type_${info.subtype.toLowerCase()}`,
					`Subtype: +${info.subtype}`,
					'type_mod',
					pName,
					timestamp
				);
			}
		}

		// Controller-scoped Anthems & Lords (skipped when the text has none of the patterns below)
		if (playerId === inst.controllerId && entry.hasControllerGrant) {
			const permLostAbilities = lostAllAbilitiesIn(view, perm).lost;
			if (!permLostAbilities) {
				if (
					memoTest(RE_LANDS_ANY_COLOR, pLow) &&
					effectiveTypeLine.includes('Land')
				) {
					grantItem('mana_any', 'Mana Ability: Add Any Color', 'ability', pName, timestamp);
				}

				if (
					memoTest(RE_EVERY_CREATURE_TYPE, pLow) &&
					effectiveTypeLine.includes('Creature')
				) {
					grantItem('changeling', 'Changeling (All Creature Types)', 'keyword', pName, timestamp);
				}

				for (const line of linesOf(pText)) {
					const lLow = lowerOf(line);
					if (
						lLow.startsWith('whenever ') ||
						lLow.startsWith('when ') ||
						lLow.includes(':')
					) {
						continue;
					}

					// Multi-type grant: "You, planeswalkers you control, and other creatures you control have <kw>."
					const pwAndCreatureMatch = memoMatch(RE_PW_AND_CREATURES_HAVE, line);
					if (pwAndCreatureMatch) {
						const isOtherCreature = Boolean(pwAndCreatureMatch[1]);
						const appliesToInst =
							effectiveTypeLine.includes('Planeswalker') ||
							(effectiveTypeLine.includes('Creature') &&
								(!isOtherCreature || perm.instanceId !== inst.instanceId));
						if (appliesToInst) {
							const kwClause = pwAndCreatureMatch[2];
							for (const kw of keywordsIn(kwClause)) {
								grantItem(kw.key, kw.label, 'keyword', pName, timestamp);
							}
							const protMatch = memoMatch(RE_PROTECTION_FROM, kwClause);
							if (protMatch) {
								const label =
									protMatch[1].charAt(0).toUpperCase() + protMatch[1].slice(1).trim();
								grantItem('protection', label, 'keyword', pName, timestamp);
							}
						}
						continue;
					}

					// Creature / Subtype Lord & Anthem: "[Other] [<Subtype>] creatures you control [get +X/+Y] [and] [have <keywords>]"
					const ptLordMatch = memoMatch(RE_PT_LORD, line);
					const kwLordMatch = memoMatch(RE_KW_LORD, line);

					if ((ptLordMatch || kwLordMatch) && effectiveTypeLine.includes('Creature')) {
						const isOtherOnly = Boolean((ptLordMatch ?? kwLordMatch)?.[1]);
						if (isOtherOnly && perm.instanceId === inst.instanceId) continue;

						const subtypeReq = (ptLordMatch ?? kwLordMatch)?.[2];
						const matchesSubtype =
							!subtypeReq ||
							wordRegex(subtypeReq).test(effectiveTypeLine) ||
							effectiveTypeLine.includes('All-Types') ||
							items.some((i) => i.canonicalKey === 'changeling' && !i.removed);

						if (matchesSubtype) {
							if (ptLordMatch && workingPower !== null && workingToughness !== null) {
								const dp = parseInt(ptLordMatch[3], 10) || 0;
								const dt = parseInt(ptLordMatch[4], 10) || 0;
								workingPower += dp;
								workingToughness += dt;
								const signP = dp >= 0 ? `+${dp}` : `${dp}`;
								const signT = dt >= 0 ? `+${dt}` : `${dt}`;
								grantItem(`pt_${perm.instanceId}`, `${signP}/${signT}`, 'stat_mod', pName, timestamp);
								ptModifiedBy.push(`${signP}/${signT} (${pName})`);
							}
							if (kwLordMatch) {
								const kwClause = kwLordMatch[3];
								for (const kw of keywordsIn(kwClause)) {
									grantItem(kw.key, kw.label, 'keyword', pName, timestamp);
								}
								const protMatch = memoMatch(RE_PROTECTION_FROM, kwClause);
								if (protMatch) {
									const label =
										protMatch[1].charAt(0).toUpperCase() + protMatch[1].slice(1).trim();
									grantItem('protection', label, 'keyword', pName, timestamp);
								}
							}
						}
					}
				}
			}
		}
	}
	applyRemovalsUpTo(Infinity);

	// 4. Instance-level counters, temporary P/T buffs, Suspend haste, and temporary `grantedKeywords`
	if (inst.castViaSuspend && effectiveTypeLine.includes('Creature')) {
		grantItem('haste', 'Haste', 'keyword', 'Suspend');
	}
	const plusOnes = inst.counters['+1/+1'] || 0;
	const minusOnes = inst.counters['-1/-1'] || 0;
	if (plusOnes > 0 && workingPower !== null && workingToughness !== null) {
		workingPower += plusOnes;
		workingToughness += plusOnes;
		grantItem('counters_plus', `+${plusOnes}/+${plusOnes}`, 'stat_mod', '+1/+1 Counters');
		ptModifiedBy.push(`+${plusOnes}/+${plusOnes} (+1/+1 Counters)`);
	}
	if (minusOnes > 0 && workingPower !== null && workingToughness !== null) {
		workingPower -= minusOnes;
		workingToughness -= minusOnes;
		grantItem('counters_minus', `-${minusOnes}/-${minusOnes}`, 'stat_mod', '-1/-1 Counters');
		ptModifiedBy.push(`-${minusOnes}/-${minusOnes} (-1/-1 Counters)`);
	}
	if (
		(inst.tempPowerMod !== 0 || inst.tempToughnessMod !== 0) &&
		workingPower !== null &&
		workingToughness !== null
	) {
		workingPower += inst.tempPowerMod;
		workingToughness += inst.tempToughnessMod;
		const sp = inst.tempPowerMod >= 0 ? `+${inst.tempPowerMod}` : `${inst.tempPowerMod}`;
		const st = inst.tempToughnessMod >= 0 ? `+${inst.tempToughnessMod}` : `${inst.tempToughnessMod}`;
		grantItem('temp_pt', `${sp}/${st}`, 'stat_mod', 'Temporary Effect');
		ptModifiedBy.push(`${sp}/${st} (Temporary Effect)`);
	}

	// Layer 7d: Effects that switch a creature's power and toughness (CR 613.4d)
	if (
		workingPower !== null &&
		workingToughness !== null &&
		(inst.switchedPTCount || 0) % 2 === 1
	) {
		const prevP = workingPower;
		const prevT = workingToughness;
		workingPower = prevT;
		workingToughness = prevP;
		grantItem('switched_pt', `Switched P/T (${workingPower}/${workingToughness})`, 'stat_mod', 'P/T Switch');
		ptModifiedBy.push(`Switched P/T (${workingPower}/${workingToughness})`);
	}

	for (const gKw of inst.grantedKeywords || []) {
		const gLow = gKw.toLowerCase();
		const alreadyActive = items.some((it) => it.canonicalKey === gLow && !it.removed);
		if (!alreadyActive) {
			let sourceLabel = 'Temporary Effect';
			const controller = state.players.find((p) => p.playerId === inst!.controllerId);
			if (controller) {
				const kwGainRegex = new RegExp(`\\bgains?\\b[^.\\n]*\\b${gLow}\\b`, 'i');
				const matchingSource = controller.battlefield.find(
					(b) => !b.phasedOut && kwGainRegex.test(layerCardText(b.copiableCard ?? b.card))
				);
				if (matchingSource) {
					sourceLabel = (matchingSource.copiableCard ?? matchingSource.card).name;
				}
			}
			const matchedCanon = CANONICAL_COMBAT_KEYWORDS.find((k) => k.key === gLow);
			grantItem(gLow, matchedCanon ? matchedCanon.label : gKw, 'keyword', sourceLabel);
		}
	}

	// 5. Layer 6 Keyword-Removal Effects from Opponents' Battlefields (Shadowspear, Arcane Lighthouse, Bonds of Mortality, Archetype of Imagination, etc.)
	const removedKeywordMap = new Map<string, string[]>(); // canonicalKey -> sourceCardNames[]
	const markKeywordRemoved = (kwKey: string, sourceName: string) => {
		const k = kwKey.toLowerCase();
		const list = removedKeywordMap.get(k) ?? [];
		if (!list.includes(sourceName)) list.push(sourceName);
		removedKeywordMap.set(k, list);
	};

	// Only objects whose text has the "<…> your opponents control lose <…>" pattern can contribute.
	for (const entry of view.opponentKeywordRemovers) {
		const { perm, playerId } = entry;
		if (playerId === inst.controllerId) continue;
		if (lostAllAbilitiesIn(view, perm).lost) continue;
		const pName = entry.name;

		// Generic parser for "<creatures|permanents> your opponents control lose <keywords>"
		const loseMatch = memoMatch(RE_OPPONENTS_LOSE, entry.text);
		if (loseMatch) {
			const targetScope = loseMatch[1].toLowerCase();
			const loseClause = loseMatch[2].toLowerCase();
			if (targetScope === 'permanents' || effectiveTypeLine.includes('Creature')) {
				for (const kw of keywordsIn(loseClause)) {
					markKeywordRemoved(kw.key, pName);
				}
			}
		}
	}

	// Apply `removedKeywordMap` to matching items (both innate and granted!)
	for (const [kwKey, removerNames] of removedKeywordMap.entries()) {
		for (const item of items) {
			if (item.canonicalKey === kwKey) {
				item.removed = true;
				for (const rName of removerNames) {
					if (!item.removedBy.includes(rName)) {
						item.removedBy.push(rName);
					}
				}
			}
		}
	}

	return {
		baseTypeLine,
		effectiveTypeLine,
		typeModified: effectiveTypeLine !== baseTypeLine || typeModifiedBy.length > 0,
		typeModifiedBy,
		basePower,
		baseToughness,
		effectivePower: workingPower !== null ? Math.max(0, workingPower) : null,
		effectiveToughness: workingToughness !== null ? Math.max(0, workingToughness) : null,
		ptModifiedBy,
		items
	};
}

export interface EvaluatedPermanent {
	instanceId: string;
	effectiveName: string;
	effectiveTypeLine: string;
	typeLine: string;
	isCreature: boolean;
	isArtifact: boolean;
	isEnchantment: boolean;
	isLand: boolean;
	isPlaneswalker: boolean;
	isLegendary: boolean;
	hasAllCreatureTypes: boolean;
	losesAllAbilities: boolean;
	hasLostAllAbilities: boolean;
	lostAllAbilitiesBy: string[];
	power: number;
	toughness: number;
	activeKeywords: string[];
	keywords: string[];
	breakdown: CardContinuousBreakdown;
	hasSubType: (subType: string) => boolean;
}

export function evaluatePermanent(state: GameState, inst: CardInstance): EvaluatedPermanent {
	const view = currentLayerView(state);
	const breakdown = inspectCardContinuousBreakdownIn(inst, state, view);
	const tLine = breakdown.effectiveTypeLine;
	const lostInfo = lostAllAbilitiesIn(view, inst);
	const activeKeywords = breakdown.items
		.filter((it) => it.kind === 'keyword' && !it.removed)
		.map((it) => it.name);
	const hasAllCreatureTypes =
		tLine.includes('All-Types') ||
		breakdown.items.some((it) => it.canonicalKey === 'changeling' && !it.removed);
	const baseCard = inst.copiableCard ?? inst.card;

	const result: EvaluatedPermanent = {
		instanceId: inst.instanceId,
		effectiveName: inst.isFaceDown ? 'Face-Down Creature' : baseCard.name,
		effectiveTypeLine: tLine,
		typeLine: tLine,
		isCreature: tLine.includes('Creature'),
		isArtifact: tLine.includes('Artifact'),
		isEnchantment: tLine.includes('Enchantment'),
		isLand: tLine.includes('Land'),
		isPlaneswalker: tLine.includes('Planeswalker'),
		isLegendary: tLine.includes('Legendary'),
		hasAllCreatureTypes,
		losesAllAbilities: lostInfo.lost,
		hasLostAllAbilities: lostInfo.lost,
		lostAllAbilitiesBy: [...lostInfo.sources],
		power: breakdown.effectivePower ?? 0,
		toughness: breakdown.effectiveToughness ?? 0,
		activeKeywords,
		keywords: activeKeywords,
		breakdown,
		hasSubType: (subType: string) => {
			if (tLine.includes('Creature') && hasAllCreatureTypes) return true;
			return new RegExp(`\\b${subType}\\b`, 'i').test(tLine);
		}
	};
	if (layerCacheCheckEnabled()) {
		crossCheckLayerResult(
			'evaluatePermanent',
			result,
			() => evaluatePermanent(state, inst),
			(ref) => ref.evaluatePermanent(state, inst)
		);
	}
	return result;
}

export function playerCannotLoseGame(
	state: GameState,
	playerOrId: PlayerGameState | string
): { protected: boolean; sourceName?: string } {
	const player =
		typeof playerOrId === 'string'
			? state.players.find((p) => p.playerId === playerOrId)
			: playerOrId;
	if (!player) return { protected: false };
	if (player.cannotLoseGameThisTurn) {
		return { protected: true, sourceName: 'Turn Protection Effect' };
	}
	for (const perm of player.battlefield) {
		if (perm.phasedOut) continue;
		if (permanentHasLostAllAbilities(perm, state).lost) continue;
		const pCard = perm.copiableCard ?? perm.card;
		if (/you can't lose the game/i.test(pCard.oracleText)) {
			return { protected: true, sourceName: pCard.name };
		}
	}
	return { protected: false };
}

export function playerCannotWinGame(
	state: GameState,
	playerOrId: PlayerGameState | string
): { blocked: boolean; sourceName?: string } {
	const player =
		typeof playerOrId === 'string'
			? state.players.find((p) => p.playerId === playerOrId)
			: playerOrId;
	if (!player) return { blocked: false };
	for (const opp of state.players) {
		if (opp.lost || opp.playerId === player.playerId) continue;
		for (const perm of opp.battlefield) {
			if (perm.phasedOut) continue;
			if (permanentHasLostAllAbilities(perm, state).lost) continue;
			const pCard = perm.copiableCard ?? perm.card;
			if (/your opponents can't win the game/i.test(pCard.oracleText)) {
				return { blocked: true, sourceName: pCard.name };
			}
		}
	}
	return { blocked: false };
}

export function checkGraveyardReplacementZone(
	state: GameState,
	desiredDestOrPlayerId: ZoneType | string = 'graveyard'
): { dest: ZoneType; replacedBy?: string } {
	const desiredDest: ZoneType =
		desiredDestOrPlayerId === 'graveyard' ||
		desiredDestOrPlayerId === 'exile' ||
		desiredDestOrPlayerId === 'hand' ||
		desiredDestOrPlayerId === 'library' ||
		desiredDestOrPlayerId === 'command' ||
		desiredDestOrPlayerId === 'battlefield'
			? desiredDestOrPlayerId
			: 'graveyard';
	if (desiredDest !== 'graveyard') return { dest: desiredDest };
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			if (permanentHasLostAllAbilities(perm, state).lost) continue;
			const pCard = perm.copiableCard ?? perm.card;
			const low = pCard.oracleText.toLowerCase();
			if (
				/if a card or token would be put into a graveyard from anywhere, exile it instead/i.test(
					low
				)
			) {
				return { dest: 'exile', replacedBy: pCard.name };
			}
		}
	}
	return { dest: desiredDest };
}

export function checkGlobalCastPermissionsAndRestrictions(
	state: GameState,
	actorOrId: PlayerGameState | string,
	fromZoneOrInst: ZoneType | CardInstance,
	maybeFromZone?: ZoneType
): {
	allowedAsThoughFlash: boolean;
	grantsFlash: boolean;
	blocked: boolean;
	ok: boolean;
	error?: string;
} {
	const actor =
		typeof actorOrId === 'string'
			? state.players.find((p) => p.playerId === actorOrId)
			: actorOrId;
	const fromZone: ZoneType =
		maybeFromZone ?? (typeof fromZoneOrInst === 'string' ? fromZoneOrInst : 'hand');
	if (!actor) {
		return {
			allowedAsThoughFlash: false,
			grantsFlash: false,
			blocked: true,
			ok: false,
			error: 'Player not found.'
		};
	}

	let allowedAsThoughFlash = false;
	const activePlayer = state.players[state.activePlayerIndex];

	// 1. Check "as though they had flash" permissions on actor's battlefield
	for (const perm of actor.battlefield) {
		if (perm.phasedOut) continue;
		if (permanentHasLostAllAbilities(perm, state).lost) continue;
		const pCard = perm.copiableCard ?? perm.card;
		const low = pCard.oracleText.toLowerCase();
		if (low.includes('you may cast spells as though they had flash')) {
			allowedAsThoughFlash = true;
		}
	}

	// 2. Check global & opponent Stax restrictions ("Can't beats Can" — CR 101.2)
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			if (permanentHasLostAllAbilities(perm, state).lost) continue;
			const pCard = perm.copiableCard ?? perm.card;
			const low = pCard.oracleText.toLowerCase();

			// Rule of Law / Archon of Emeria: "Each player can't cast more than one spell each turn."
			if (low.includes("each player can't cast more than one spell each turn")) {
				if ((actor.spellsCastThisTurn || 0) >= 1) {
					return {
						allowedAsThoughFlash,
						grantsFlash: allowedAsThoughFlash,
						blocked: true,
						ok: false,
						error: `Illegal Cast: ${pCard.name} prevents each player from casting more than one spell each turn.`
					};
				}
			}

			// Opponent-only restrictions
			if (p.playerId !== actor.playerId) {
				// Drannith Magistrate: "Your opponents can't cast spells from anywhere other than their hands."
				if (
					low.includes("your opponents can't cast spells from anywhere other than their hands")
				) {
					if (fromZone !== 'hand') {
						return {
							allowedAsThoughFlash,
							grantsFlash: allowedAsThoughFlash,
							blocked: true,
							ok: false,
							error: `Illegal Cast: ${pCard.name} prevents opponents from casting spells from anywhere other than their hands (blocks Command Zone / Exile / Graveyard casts).`
						};
					}
				}

				// Grand Abolisher: "During your turn, your opponents can't cast spells..."
				if (
					activePlayer?.playerId === p.playerId &&
					low.includes("during your turn, your opponents can't cast spells")
				) {
					return {
						allowedAsThoughFlash,
						grantsFlash: allowedAsThoughFlash,
						blocked: true,
						ok: false,
						error: `Illegal Cast: ${pCard.name} prevents opponents from casting spells during ${p.username}'s turn.`
					};
				}

				// Teferi, Time Raveler: "Each opponent can cast spells only any time they could cast a sorcery."
				if (
					low.includes('each opponent can cast spells only any time they could cast a sorcery')
				) {
					const atSorceryTiming =
						activePlayer?.playerId === actor.playerId &&
						(state.phase === 'main1' || state.phase === 'main2') &&
						state.stack.length === 0;
					if (!atSorceryTiming) {
						return {
							allowedAsThoughFlash,
							grantsFlash: allowedAsThoughFlash,
							blocked: true,
							ok: false,
							error: `Illegal Cast: ${pCard.name} restricts you to casting spells only at Sorcery speed.`
						};
					}
				}
			}
		}
	}

	return {
		allowedAsThoughFlash,
		grantsFlash: allowedAsThoughFlash,
		blocked: false,
		ok: true
	};
}

/**
 * Checks if any opponent of `searchingPlayerId` controls an active permanent that intercepts
 * library searches (e.g., `Opposition Agent`: "You control your opponents while they're searching their libraries.
 * While an opponent is searching their library, they exile each card they find. You may play those cards for as
 * long as they remain exiled, and you may spend mana as though it were mana of any color to cast them.").
 *
 * Per CR 613.7 and official Opposition Agent rulings:
 * - If multiple opponents control an Opposition Agent, the one with the latest `enteredTimestamp`
 *   (most recently entered the battlefield) controls the searching player during the search.
 * - Because that controller makes all choices for the searching player (who is the owner of the exiled card
 *   choosing which replacement effect applies under CR 616.1), that controller gives themselves the exile play permission.
 */
export function getLibrarySearchInterceptor(
	state: GameState,
	searchingPlayerId: string
): LibrarySearchInterceptorInfo | null {
	const candidates: Array<{
		info: LibrarySearchInterceptorInfo;
		timestamp: number;
	}> = [];

	for (const p of state.players) {
		if (p.lost || p.playerId === searchingPlayerId) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			if (permanentHasLostAllAbilities(perm, state).lost) continue;
			const pCard = perm.copiableCard ?? perm.card;
			const low = pCard.oracleText.toLowerCase();

			const controlsSearch =
				/you control your opponents while they['’]re searching their libraries/i.test(low);
			const exilesFoundCards =
				/while an opponent is searching their library, they exile each card they find/i.test(low);

			if (controlsSearch || exilesFoundCards) {
				const grantPlayFromExile =
					/you may play those cards for as long as they remain exiled/i.test(low);
				const spendManaAsAnyColor =
					/spend mana as though it were mana of any color to cast them/i.test(low);

				candidates.push({
					info: {
						controllerId: p.playerId,
						sourceInstanceId: perm.instanceId,
						sourceName: pCard.name,
						exilesFoundCards,
						grantPlayFromExile,
						spendManaAsAnyColor
					},
					timestamp: perm.enteredTimestamp ?? 0
				});
			}
		}
	}

	if (candidates.length === 0) return null;

	// Latest timestamp wins (most recently entered the battlefield — CR 613.7)
	candidates.sort((a, b) => b.timestamp - a.timestamp);
	return candidates[0].info;
}

