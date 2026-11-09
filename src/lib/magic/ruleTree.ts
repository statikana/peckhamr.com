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
// Continuous Layer & Keyword / Effect Attribution Engine (Phase 6: runtime/layers.ts)
// ============================================================================

import {
	evaluatePermanent,
	getAttachedAbilityStrippingAuraSources,
	inspectCardContinuousBreakdown,
	permanentHasLostAllAbilities,
	type AttributedKeywordOrEffect,
	type CardContinuousBreakdown,
	type EvaluatedPermanent
} from './runtime/layers.ts';

export {
	evaluatePermanent,
	getAttachedAbilityStrippingAuraSources,
	inspectCardContinuousBreakdown,
	permanentHasLostAllAbilities,
	type AttributedKeywordOrEffect,
	type CardContinuousBreakdown,
	type EvaluatedPermanent
};

export {
	checkGlobalCastPermissionsAndRestrictions,
	checkGraveyardReplacementZone,
	getLibrarySearchInterceptor,
	playerCannotLoseGame,
	playerCannotWinGame
} from './runtime/replace.ts';
