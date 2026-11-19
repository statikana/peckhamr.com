/**
 * Wave 6 — Track P18b runtime helpers:
 * - Meld (`CR 713.1–8`, `CR 701.42`)
 * - Kamigawa Flip (`CR 710.1–5`)
 * - Infinity / Harness (`CR 702.186`, `CR 701.64`)
 * - Companion deck validation & `{3}` special action (`CR 702.139`, `CR 116.2g`)
 * - Offering flash & mana-cost reduction (`CR 702.48a–c`)
 * - Expanded Modals (`CR 700.2d,e,i`, `CR 607.2d`) & Siege/Anchor ETB choice (`CR 614.12c`)
 * - Loyalty multi-activation static (`CR 606.3`) & `staticallyInterpretableP18b`
 */
import { cardAbilities } from '../compiler/index.ts';
import type {
	Amount,
	CompanionDeckConditionId,
	Condition,
	EffectParams,
	EffectStep,
	ModalDef,
	ObjectFilter,
	Selector,
	SpellCastRestrictionKind,
	TargetSpec
} from '../ir.ts';
import { parseManaCost, type ManaCostRequirement } from '../oracle.ts';
import { effectiveCardForObject, getCardFaces, resolveMeldResultCard } from '../scryfall.ts';
import type {
	CardInstance,
	CastCostAid,
	CastOption,
	CastOptionOptionalCost,
	GameState,
	ManaColor,
	PlayerGameState,
	ScryfallCard,
	TargetRequirementInfo,
	ZoneType
} from '../types.ts';
import { activeAbilityDefs, instanceFaceOptions, resolveObjectFaces } from './faces.ts';
import { staticallyInterpretableP15 } from './framesBattlesAndKeywordsWave5.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { splitSubtypes } from './layers.ts';
import type { FilterContext } from './objectFilter.ts';

// ---- Interpretability Normalization (Compiler + Runtime Agreement) --------------------------

function normalizeP18bConditionForCheck(cond: Condition): Condition {
	switch (cond.k) {
		case 'anchorWordChosen':
		case 'youWereAttackedThisCombat':
			return { k: 'isYourTurn' };
		case 'not':
			return { k: 'not', of: normalizeP18bConditionForCheck(cond.of) };
		case 'and':
			return { k: 'and', of: cond.of.map(normalizeP18bConditionForCheck) };
		case 'or':
			return { k: 'or', of: cond.of.map(normalizeP18bConditionForCheck) };
		default:
			return cond;
	}
}

function normalizeP18bSelectorForCheck(sel: Selector): Selector {
	if (sel.k === 'all') {
		return sel;
	}
	return sel;
}

function normalizeP18bStepForCheck(step: EffectStep): EffectStep {
	let verb = step.verb;
	let subject = normalizeP18bSelectorForCheck(step.subject);
	if (verb === 'meld' || verb === 'harness') {
		verb = 'suspect';
		if (subject.k === 'none') {
			subject = { k: 'self' };
		}
	}
	return {
		...step,
		verb,
		subject,
		...(step.condition ? { condition: normalizeP18bConditionForCheck(step.condition) } : {}),
		...(step.delayed
			? {
					delayed: {
						...step.delayed,
						effect: step.delayed.effect.map(normalizeP18bStepForCheck)
					}
				}
			: {}),
		...(step.params
			? {
					params: {
						...step.params,
						...(step.params.condition
							? { condition: normalizeP18bConditionForCheck(step.params.condition) }
							: {}),
						...(step.params.winFlipEffect
							? { winFlipEffect: step.params.winFlipEffect.map(normalizeP18bStepForCheck) }
							: {}),
						...(step.params.loseFlipEffect
							? { loseFlipEffect: step.params.loseFlipEffect.map(normalizeP18bStepForCheck) }
							: {}),
						...(step.params.reflexiveTrigger
							? {
									reflexiveTrigger: {
										...step.params.reflexiveTrigger,
										targets: step.params.reflexiveTrigger.targets.map((t) => ({
											...t,
											...(t.condition
												? { condition: normalizeP18bConditionForCheck(t.condition) }
												: {})
										})),
										effect: step.params.reflexiveTrigger.effect.map(normalizeP18bStepForCheck)
									}
								}
							: {})
					}
				}
			: {})
	};
}

export function staticallyInterpretableP18b(
	parse: {
		steps: readonly EffectStep[];
		targets: readonly TargetSpec[];
		unparsed: readonly unknown[];
		modal?: ModalDef;
	},
	isTriggered = false
): boolean {
	if (parse.modal?.prefixEffect && parse.modal.prefixEffect.length > 0) {
		if (
			!staticallyInterpretableP15(
				{
					steps: parse.modal.prefixEffect.map(normalizeP18bStepForCheck),
					targets: [],
					unparsed: []
				},
				isTriggered
			)
		) {
			return false;
		}
	}
	if (parse.modal?.suffixEffect && parse.modal.suffixEffect.length > 0) {
		if (
			!staticallyInterpretableP15(
				{
					steps: parse.modal.suffixEffect.map(normalizeP18bStepForCheck),
					targets: [],
					unparsed: []
				},
				isTriggered
			)
		) {
			return false;
		}
	}
	return staticallyInterpretableP15(
		{
			steps: parse.steps.map(normalizeP18bStepForCheck),
			targets: parse.targets.map((t) => ({
				...t,
				...(t.condition ? { condition: normalizeP18bConditionForCheck(t.condition) } : {})
			})),
			unparsed: [...parse.unparsed],
			...(parse.modal
				? {
						modal: {
							...parse.modal,
							...(parse.modal.conditionalChooseAll
								? {
										conditionalChooseAll: normalizeP18bConditionForCheck(
											parse.modal.conditionalChooseAll
										)
									}
								: {}),
							modes: parse.modal.modes.map((m) => ({
								...m,
								targets: m.targets.map((t) => ({
									...t,
									...(t.condition
										? { condition: normalizeP18bConditionForCheck(t.condition) }
										: {})
								})),
								effect: m.effect.map(normalizeP18bStepForCheck)
							}))
						}
					}
				: {})
		},
		isTriggered
	);
}

// ---- Meld (CR 713.1–8, CR 701.42) -----------------------------------------------------------

export function isMeldedPermanent(
	inst: Pick<CardInstance, 'meldedComponents'> | undefined | null
): boolean {
	return Boolean(inst?.meldedComponents && inst.meldedComponents.length === 2);
}

/**
 * CR 713.3b: The mana value of a melded permanent is the sum of the mana values of its front faces.
 * CR 713.5c: A permanent that's a copy of a melded permanent has no mana cost, so its mana value is 0.
 */
export function computeMeldedManaValue(
	meldedComponents: readonly [ScryfallCard, ScryfallCard],
	isCopyOfMelded: boolean
): number {
	if (isCopyOfMelded) return 0;
	let sum = 0;
	for (let i = 0; i < 2; i++) {
		const comp = meldedComponents[i];
		const front = getCardFaces(comp)[0];
		if (front && front.manaCost) {
			sum += parseManaCost(front.manaCost).totalCmc;
		} else if (front?.cmc !== undefined) {
			sum += front.cmc;
		} else {
			sum += comp.cmc || 0;
		}
	}
	return sum;
}

export interface MeldRuntimeCallbacks {
	evaluatePermanentName: (state: GameState, perm: CardInstance) => string;
	moveFromBattlefield: (state: GameState, perm: CardInstance, dest: 'exile') => unknown;
	mergeExiledPairOntoBattlefield: (
		state: GameState,
		controller: PlayerGameState,
		exiledPrimary: CardInstance,
		exiledPartner: CardInstance,
		meldedCard: ScryfallCard,
		components: [ScryfallCard, ScryfallCard],
		enterTapped: boolean
	) => CardInstance | null;
	addLog: (
		state: GameState,
		kind: 'rule' | 'cast' | 'combat' | 'trigger' | 'life',
		text: string,
		actorId?: string
	) => void;
}

/**
 * CR 701.42a–c / CR 713.4: Executes a Meld instruction (`exile them, then meld them into [Result]`).
 * Requires `controller` to both own and control `sourcePerm` and a distinct permanent matching
 * `params.meldPartnerName` (both attacking when `params.meldPartnerMustAttack` is true).
 * If either card fails to enter exile (e.g. token ceases to exist per CR 701.42c, or commander
 * replacement sends one to the command zone per CR 701.42b), they do not meld.
 */
export function executeMeldStep(
	state: GameState,
	controller: PlayerGameState,
	sourceId: string | undefined,
	sourceObjectVersion: number | undefined,
	params: EffectParams | undefined,
	cb: MeldRuntimeCallbacks
): CardInstance | null {
	if (!sourceId || !params?.meldPartnerName) return null;
	const sourcePerm = controller.battlefield.find(
		(b) =>
			b.instanceId === sourceId &&
			!b.phasedOut &&
			(sourceObjectVersion === undefined || (b.objectVersion ?? 1) === sourceObjectVersion)
	);
	if (!sourcePerm) return null;
	// CR 701.42a: Controller must both own and control the primary meld card.
	if (sourcePerm.ownerId !== controller.playerId || sourcePerm.controllerId !== controller.playerId) {
		return null;
	}

	const mustAttack = Boolean(params.meldPartnerMustAttack);
	const attackerMap = new Map<string, { defenderPlayerId: string; defenderPlaneswalkerId?: string | null; defenderBattleId?: string | null }>();
	if (state.combat?.active) {
		for (const atk of state.combat.attackers) {
			attackerMap.set(atk.attackerInstanceId, {
				defenderPlayerId: atk.defenderPlayerId,
				defenderPlaneswalkerId: atk.defenderPlaneswalkerId,
				defenderBattleId: atk.defenderBattleId
			});
		}
	}
	if (mustAttack && !attackerMap.has(sourcePerm.instanceId)) {
		return null;
	}

	const sourceCardBase = sourcePerm.printedCard ?? sourcePerm.card;
	const shortSelfName = sourceCardBase.name.split(', ')[0];
	const targetPartnerLower = params.meldPartnerName
		.replace(/~/g, shortSelfName)
		.trim()
		.toLowerCase();
	let partnerPerm: CardInstance | undefined;
	for (const cand of controller.battlefield) {
		if (cand.instanceId === sourcePerm.instanceId || cand.phasedOut) continue;
		if (cand.ownerId !== controller.playerId || cand.controllerId !== controller.playerId) continue;
		if (mustAttack && !attackerMap.has(cand.instanceId)) continue;
		const candNameLower = cb.evaluatePermanentName(state, cand).trim().toLowerCase();
		if (candNameLower === targetPartnerLower) {
			partnerPerm = cand;
			break;
		}
	}
	if (!partnerPerm) return null;

	const prevAttackAssignment = attackerMap.get(sourcePerm.instanceId) ?? attackerMap.get(partnerPerm.instanceId);
	const cardA = sourcePerm.printedCard ?? sourcePerm.card;
	const cardB = partnerPerm.printedCard ?? partnerPerm.card;
	const sourceIsCopyOrToken = Boolean(sourcePerm.isToken || sourcePerm.copiableCard || sourcePerm.copiableState);
	const partnerIsCopyOrToken = Boolean(partnerPerm.isToken || partnerPerm.copiableCard || partnerPerm.copiableState);

	// Step 1: Exile both permanents.
	cb.moveFromBattlefield(state, sourcePerm, 'exile');
	cb.moveFromBattlefield(state, partnerPerm, 'exile');

	// CR 701.42b–c: Only printed meld cards that both reached exile can meld onto the battlefield.
	if (sourceIsCopyOrToken || partnerIsCopyOrToken) return null;
	if (sourcePerm.zone !== 'exile' || partnerPerm.zone !== 'exile') return null;

	const expandedResultName = params.meldResultName
		? params.meldResultName.replace(/~/g, shortSelfName)
		: undefined;
	const meldedCard = resolveMeldResultCard(cardA, cardB, expandedResultName);
	const enterTapped = Boolean(params.meldTappedAndAttacking);
	const meldedPerm = cb.mergeExiledPairOntoBattlefield(
		state,
		controller,
		sourcePerm,
		partnerPerm,
		meldedCard,
		[cardA, cardB],
		enterTapped
	);
	if (!meldedPerm) return null;

	if (params.meldTappedAndAttacking && state.combat?.active) {
		let defPlayerId = prevAttackAssignment?.defenderPlayerId;
		if (!defPlayerId) {
			const opp = state.players.find((p) => !p.lost && p.playerId !== controller.playerId);
			defPlayerId = opp?.playerId;
		}
		if (defPlayerId) {
			state.combat.attackers.push({
				attackerInstanceId: meldedPerm.instanceId,
				controllerId: controller.playerId,
				defenderPlayerId: defPlayerId,
				...(prevAttackAssignment?.defenderPlaneswalkerId
					? { defenderPlaneswalkerId: prevAttackAssignment.defenderPlaneswalkerId }
					: {}),
				...(prevAttackAssignment?.defenderBattleId
					? { defenderBattleId: prevAttackAssignment.defenderBattleId }
					: {}),
				blockerInstanceIds: []
			});
			meldedPerm.creatureAttackedThisTurn = true;
		}
	}

	const resultView = resolveObjectFaces(meldedPerm.card, instanceFaceOptions(meldedPerm, 'battlefield'));
	cb.addLog(
		state,
		'rule',
		`${controller.username} melded ${cardA.name} and ${cardB.name} into ${resultView.name} (CR 713.4).`,
		controller.playerId
	);
	return meldedPerm;
}

// ---- Harness / Infinity (CR 701.64, CR 702.186) ---------------------------------------------

export function executeHarnessStep(state: GameState, perm: CardInstance): boolean {
	if (perm.zone !== 'battlefield' || perm.phasedOut) return false;
	if (perm.isHarnessed) return false;
	perm.isHarnessed = true;
	noteLayerInputsChanged(state);
	return true;
}

// ---- Loyalty Multi-Activation Static (CR 606.3) ---------------------------------------------

export function getPermanentMaxLoyaltyActivationsPerTurn(
	state: GameState,
	perm: CardInstance,
	losesAllAbilities: boolean
): number {
	if (losesAllAbilities || perm.isFaceDown) {
		const ctrl = state.players.find((pl) => pl.playerId === perm.controllerId);
		return 1 + (ctrl?.extraLoyaltyActivationsThisTurn ?? 0);
	}
	const card = effectiveCardForObject(perm);
	let max = 1;
	for (const ab of activeAbilityDefs(card, instanceFaceOptions(perm, 'battlefield'))) {
		if (ab.kind === 'static' && ab.static.k === 'loyaltyActivationsPerTurn') {
			if (ab.static.max > max) max = ab.static.max;
		}
	}
	const ctrl = state.players.find((pl) => pl.playerId === perm.controllerId);
	return max + (ctrl?.extraLoyaltyActivationsThisTurn ?? 0);
}

// ---- Companion (CR 702.139, CR 116.2g) ------------------------------------------------------

const PERMANENT_CARD_TYPES = new Set([
	'Artifact',
	'Battle',
	'Creature',
	'Enchantment',
	'Land',
	'Planeswalker'
]);

const NONLAND_SHAREABLE_TYPES = [
	'Artifact',
	'Battle',
	'Creature',
	'Enchantment',
	'Instant',
	'Kindred',
	'Planeswalker',
	'Sorcery'
] as const;

const KAHEERA_SUBTYPES = new Set(['cat', 'elemental', 'nightmare', 'dinosaur', 'beast']);

const ACTIVATED_KEYWORDS = new Set([
	'boast',
	'channel',
	'commander ninjutsu',
	'crew',
	'cycling',
	'embalm',
	'encore',
	'equip',
	'eternalize',
	'exhaust',
	'fortify',
	'level up',
	'ninjutsu',
	'outlast',
	'reconfigure',
	'reinforce',
	'saddle',
	'scavenge',
	'transfigure',
	'transmute',
	'typecycling',
	'unearth'
]);

export function getCardCompanionConditionId(card: ScryfallCard): CompanionDeckConditionId | null {
	for (const ab of cardAbilities(card)) {
		if (ab.kind === 'static' && ab.static.k === 'companionCondition') {
			return ab.static.companionId;
		}
	}
	return null;
}

function cardFrontCharacteristicsForDeckCheck(card: ScryfallCard): {
	name: string;
	manaCost: string;
	manaValue: number;
	types: string[];
	subtypes: string[];
	isPermanent: boolean;
	isLand: boolean;
} {
	const faces = getCardFaces(card);
	const front = faces[0];
	const frontView = resolveObjectFaces(card, { zone: 'library', faceIndex: 0 });
	const types = frontView.types
		.map((w) => (w === 'Tribal' ? 'Kindred' : w))
		.filter(
			(w) =>
				PERMANENT_CARD_TYPES.has(w) ||
				w === 'Instant' ||
				w === 'Sorcery' ||
				w === 'Kindred'
		);
	const subtypes = [...frontView.subtypes];
	const manaCost = front?.manaCost ?? card.manaCost ?? '';
	// CR 712.8a / 709.4b: Split cards in deck have combined mana value; MDFCs/DFCs/Adventures use front face.
	const isSplit = card.layout === 'split';
	const manaValue = isSplit
		? faces.reduce((acc, f) => acc + (f.manaCost ? parseManaCost(f.manaCost).totalCmc : (f.cmc ?? 0)), 0)
		: manaCost
			? parseManaCost(manaCost).totalCmc
			: (front?.cmc ?? card.cmc ?? 0);
	const isPermanent = types.some((t) => PERMANENT_CARD_TYPES.has(t));
	const isLand = types.includes('Land');
	return {
		name: card.name,
		manaCost: isSplit ? faces.map((f) => f.manaCost).join('') : manaCost,
		manaValue,
		types,
		subtypes,
		isPermanent,
		isLand
	};
}

function hasRepeatedManaSymbol(manaCost: string): boolean {
	const symbols = manaCost.toUpperCase().match(/\{[^}]+\}/g);
	if (!symbols || symbols.length <= 1) return false;
	const seen = new Set<string>();
	for (const sym of symbols) {
		const inner = sym.slice(1, -1).trim();
		// Generic numeric symbols like {2} are single symbols (cannot repeat in standard templating, and {0} doesn't repeat).
		if (/^\d+$/.test(inner)) continue;
		if (seen.has(inner)) return true;
		seen.add(inner);
	}
	return false;
}

function cardHasActivatedAbilityInDeck(card: ScryfallCard, subtypes: string[]): boolean {
	// Intrinsic basic land mana abilities count as activated abilities on permanent cards!
	const lowerSubs = subtypes.map((s) => s.toLowerCase());
	if (
		lowerSubs.includes('plains') ||
		lowerSubs.includes('island') ||
		lowerSubs.includes('swamp') ||
		lowerSubs.includes('mountain') ||
		lowerSubs.includes('forest')
	) {
		return true;
	}
	for (const ab of cardAbilities(card)) {
		if (ab.kind === 'activated') return true;
		if (ab.kind === 'unsupported' && ab.id && (ab.id.startsWith('act_') || ab.id.startsWith('loyalty_') || ab.id === 'mana_tap')) {
			return true;
		}
		if (ab.kind === 'keyword') {
			const kw = ab.keyword.name.toLowerCase();
			if (ACTIVATED_KEYWORDS.has(kw) || kw.endsWith('cycling')) return true;
		}
	}
	return false;
}

/**
 * CR 702.139a–c: Validates whether `startingDeckCards` (commanders + main deck) satisfies
 * `companion`'s deckbuilding condition.
 */
export function validateCompanionDeckCondition(
	companion: ScryfallCard,
	startingDeckCards: readonly ScryfallCard[],
	minimumDeckSize = 60
): { ok: boolean; error?: string } {
	const cid = getCardCompanionConditionId(companion);
	if (!cid) {
		return { ok: false, error: `${companion.name} does not have a compiled Companion ability.` };
	}

	switch (cid) {
		case 'lurrus': {
			for (const c of startingDeckCards) {
				const ch = cardFrontCharacteristicsForDeckCheck(c);
				if (ch.isPermanent && ch.manaValue > 2) {
					return {
						ok: false,
						error: `Companion condition failed (${companion.name}): ${c.name} is a permanent card with mana value ${ch.manaValue} (> 2).`
					};
				}
			}
			return { ok: true };
		}
		case 'yorion': {
			const required = minimumDeckSize + 20;
			if (startingDeckCards.length < required) {
				return {
					ok: false,
					error: `Companion condition failed (${companion.name}): starting deck has ${startingDeckCards.length} cards (needs at least ${required}).`
				};
			}
			return { ok: true };
		}
		case 'kaheera': {
			for (const c of startingDeckCards) {
				const ch = cardFrontCharacteristicsForDeckCheck(c);
				if (!ch.types.includes('Creature')) continue;
				const hasChangeling = cardAbilities(c).some(
					(ab) => ab.kind === 'keyword' && ab.keyword.name.toLowerCase() === 'changeling'
				);
				if (hasChangeling) continue;
				const okSub = ch.subtypes.some((s) => KAHEERA_SUBTYPES.has(s.toLowerCase()));
				if (!okSub) {
					return {
						ok: false,
						error: `Companion condition failed (${companion.name}): creature card ${c.name} is not a Cat, Elemental, Nightmare, Dinosaur, or Beast.`
					};
				}
			}
			return { ok: true };
		}
		case 'jegantha': {
			for (const c of startingDeckCards) {
				const ch = cardFrontCharacteristicsForDeckCheck(c);
				if (hasRepeatedManaSymbol(ch.manaCost)) {
					return {
						ok: false,
						error: `Companion condition failed (${companion.name}): ${c.name} has repeated mana symbols in its mana cost (${ch.manaCost}).`
					};
				}
			}
			return { ok: true };
		}
		case 'obosh': {
			for (const c of startingDeckCards) {
				const ch = cardFrontCharacteristicsForDeckCheck(c);
				if (!ch.isLand && ch.manaValue % 2 === 0) {
					return {
						ok: false,
						error: `Companion condition failed (${companion.name}): nonland card ${c.name} has even mana value ${ch.manaValue}.`
					};
				}
			}
			return { ok: true };
		}
		case 'gyruda': {
			for (const c of startingDeckCards) {
				const ch = cardFrontCharacteristicsForDeckCheck(c);
				if (!ch.isLand && ch.manaValue % 2 !== 0) {
					return {
						ok: false,
						error: `Companion condition failed (${companion.name}): nonland card ${c.name} has odd mana value ${ch.manaValue}.`
					};
				}
			}
			return { ok: true };
		}
		case 'zirda': {
			for (const c of startingDeckCards) {
				const ch = cardFrontCharacteristicsForDeckCheck(c);
				if (ch.isPermanent && !cardHasActivatedAbilityInDeck(c, ch.subtypes)) {
					return {
						ok: false,
						error: `Companion condition failed (${companion.name}): permanent card ${c.name} has no activated ability.`
					};
				}
			}
			return { ok: true };
		}
		case 'umori': {
			const nonlands = startingDeckCards
				.map((c) => cardFrontCharacteristicsForDeckCheck(c))
				.filter((ch) => !ch.isLand);
			if (nonlands.length === 0) return { ok: true };
			const shared = NONLAND_SHAREABLE_TYPES.some((t) =>
				nonlands.every((ch) => ch.types.includes(t))
			);
			if (!shared) {
				return {
					ok: false,
					error: `Companion condition failed (${companion.name}): nonland cards do not all share a card type.`
				};
			}
			return { ok: true };
		}
		case 'keruga': {
			for (const c of startingDeckCards) {
				const ch = cardFrontCharacteristicsForDeckCheck(c);
				if (!ch.isLand && ch.manaValue < 3) {
					return {
						ok: false,
						error: `Companion condition failed (${companion.name}): nonland card ${c.name} has mana value ${ch.manaValue} (< 3).`
					};
				}
			}
			return { ok: true };
		}
		case 'lutri': {
			const seenNonland = new Set<string>();
			for (const c of startingDeckCards) {
				const ch = cardFrontCharacteristicsForDeckCheck(c);
				if (ch.isLand) continue;
				const key = ch.name.toLowerCase();
				if (seenNonland.has(key)) {
					return {
						ok: false,
						error: `Companion condition failed (${companion.name}): duplicate nonland card ${c.name}.`
					};
				}
				seenNonland.add(key);
			}
			return { ok: true };
		}
	}
}

/**
 * CR 116.2g / CR 702.139a: Checks whether `actorId` can currently pay `{3}` as a sorcery-speed
 * special action to put their designated companion from outside the game into their hand.
 */
export function checkCompanionSpecialActionLegality(
	state: GameState,
	actorId: string
): { ok: boolean; reason?: string } {
	if (state.status !== 'active') return { ok: false, reason: 'Game is not active.' };
	if (state.pendingPrompts.length > 0) return { ok: false, reason: 'A prompt is currently pending.' };
	const actor = state.players.find((p) => p.playerId === actorId);
	if (!actor || actor.lost) return { ok: false, reason: 'Player is not active.' };
	if (!actor.companion) return { ok: false, reason: 'No companion is designated.' };
	if (actor.companionMovedToHand) {
		return { ok: false, reason: 'Companion has already been put into hand this game (CR 702.139a).' };
	}
	const priorityPlayer = state.players[state.priorityPlayerIndex];
	if (priorityPlayer?.playerId !== actorId) {
		return { ok: false, reason: 'You do not currently have priority.' };
	}
	const activePlayer = state.players[state.activePlayerIndex];
	if (activePlayer?.playerId !== actorId) {
		return { ok: false, reason: 'Companion special action can only be taken during your main phase (CR 116.2g).' };
	}
	if (state.phase !== 'main1' && state.phase !== 'main2') {
		return { ok: false, reason: 'Companion special action can only be taken during a main phase (CR 116.2g).' };
	}
	if (state.stack.length > 0) {
		return { ok: false, reason: 'Companion special action requires an empty stack (CR 116.2g).' };
	}
	return { ok: true };
}

// ---- Offering (CR 702.48a–c) ----------------------------------------------------------------

export interface OfferingSpec {
	filter: ObjectFilter;
	quality: string;
}

export function findOfferingSpecs(card: ScryfallCard, faceIndex = 0): OfferingSpec[] {
	const out: OfferingSpec[] = [];
	for (const ab of activeAbilityDefs(card, { zone: 'stack', faceIndex })) {
		if (ab.kind === 'static' && ab.static.k === 'offering') {
			out.push({ filter: ab.static.filter, quality: ab.static.quality });
		}
	}
	return out;
}

/**
 * CR 702.48c: Computes the reduced mana cost string when sacrificing a permanent with mana cost
 * `sacrificedManaCost` to cast an Offering spell with `printedManaCost`.
 * Colored mana symbols reduce matching colored mana first; excess colored mana and generic mana
 * reduce generic mana in the spell's cost.
 */
export function computeOfferingReducedManaCost(
	printedManaCost: string,
	sacrificedPerm: CardInstance
): string {
	// Face-down permanents, melded permanents, and copies of melded permanents have no mana cost (CR 708.2, 713.3b).
	if (sacrificedPerm.isFaceDown || isMeldedPermanent(sacrificedPerm)) {
		return printedManaCost || '{0}';
	}
	if (sacrificedPerm.copiableState?.except?.noManaCost) {
		return printedManaCost || '{0}';
	}
	const sacView = resolveObjectFaces(
		effectiveCardForObject(sacrificedPerm),
		instanceFaceOptions(sacrificedPerm, 'battlefield')
	);
	const sacManaCost = sacView.manaCost || '';
	if (!sacManaCost) return printedManaCost || '{0}';

	const printedTokens = (printedManaCost.toUpperCase().match(/\{[^}]+\}/g) ?? []).map((t) =>
		t.slice(1, -1).trim()
	);
	const sacTokens = (sacManaCost.toUpperCase().match(/\{[^}]+\}/g) ?? []).map((t) =>
		t.slice(1, -1).trim()
	);

	let printedGeneric = 0;
	const remainingSymbols: string[] = [];
	for (const tok of printedTokens) {
		if (/^\d+$/.test(tok)) {
			printedGeneric += parseInt(tok, 10);
		} else {
			remainingSymbols.push(tok);
		}
	}

	let genericReduction = 0;
	for (const sTok of sacTokens) {
		if (/^\d+$/.test(sTok)) {
			genericReduction += parseInt(sTok, 10);
			continue;
		}
		if (sTok === 'X' || sTok === 'Y' || sTok === 'Z') {
			// X in a permanent's mana cost on the battlefield is 0 (CR 107.3g).
			continue;
		}
		// Exact symbol match first (e.g. 'W', 'C', 'W/U', 'W/P').
		const exactIdx = remainingSymbols.indexOf(sTok);
		if (exactIdx !== -1) {
			remainingSymbols.splice(exactIdx, 1);
			continue;
		}
		// Single color ('W', 'U', 'B', 'R', 'G', 'C') can also reduce a hybrid containing that color.
		if (/^[WUBRGC]$/.test(sTok)) {
			const hybIdx = remainingSymbols.findIndex((r) => r.split('/').includes(sTok));
			if (hybIdx !== -1) {
				remainingSymbols.splice(hybIdx, 1);
				continue;
			}
			genericReduction += 1;
			continue;
		}
		// Hybrid symbol in sacrificed permanent's mana cost (e.g. 'W/U' or '2/W').
		if (sTok.includes('/')) {
			const parts = sTok.split('/');
			const colorPart = parts.find((p) => /^[WUBRGC]$/.test(p));
			if (colorPart) {
				const cIdx = remainingSymbols.indexOf(colorPart);
				if (cIdx !== -1) {
					remainingSymbols.splice(cIdx, 1);
					continue;
				}
			}
			const numPart = parts.find((p) => /^\d+$/.test(p));
			genericReduction += numPart ? parseInt(numPart, 10) : 1;
			continue;
		}
		genericReduction += 1;
	}

	const finalGeneric = Math.max(0, printedGeneric - genericReduction);
	const outParts: string[] = [];
	// Keep X symbols at front, then generic, then remaining colored/special symbols.
	const xSymbols = remainingSymbols.filter((r) => r === 'X');
	const nonXSymbols = remainingSymbols.filter((r) => r !== 'X');
	for (const x of xSymbols) outParts.push(`{${x}}`);
	if (finalGeneric > 0) outParts.push(`{${finalGeneric}}`);
	for (const sym of nonXSymbols) outParts.push(`{${sym}}`);
	return outParts.length > 0 ? outParts.join('') : '{0}';
}

/**
 * CR 702.48c: Reduces a total `ManaCostRequirement` by `sacrificedPerm`'s mana cost.
 * Colored/colorless symbols reduce matching symbols first; any excess colored/colorless mana and
 * generic mana reduce generic mana in `baseReq`.
 */
export function reduceManaCostReqByOffering(
	baseReq: ManaCostRequirement,
	sacrificedPerm: CardInstance
): ManaCostRequirement {
	if (
		sacrificedPerm.isFaceDown ||
		isMeldedPermanent(sacrificedPerm) ||
		sacrificedPerm.copiableState?.except?.noManaCost
	) {
		return { ...baseReq, colored: { ...baseReq.colored } };
	}
	const sacView = resolveObjectFaces(
		effectiveCardForObject(sacrificedPerm),
		instanceFaceOptions(sacrificedPerm, 'battlefield')
	);
	if (!sacView.manaCost) {
		return { ...baseReq, colored: { ...baseReq.colored } };
	}
	const sacReq = parseManaCost(sacView.manaCost, 0);
	const nextColored: Record<ManaColor, number> = { ...baseReq.colored };
	let excessToGeneric = 0;
	const cols: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];
	for (const col of cols) {
		const sub = sacReq.colored[col] || 0;
		if (sub <= 0) continue;
		const cur = nextColored[col] || 0;
		const matched = Math.min(cur, sub);
		nextColored[col] = cur - matched;
		excessToGeneric += sub - matched;
	}
	const nextGeneric = Math.max(0, baseReq.generic - (sacReq.generic + excessToGeneric));
	const colorSum = cols.reduce((acc, c) => acc + (nextColored[c] || 0), 0);
	const flexSum = (baseReq.flexibleSymbols ?? []).reduce(
		(acc, f) => acc + (f.altGeneric ?? 1),
		0
	);
	return {
		...baseReq,
		generic: nextGeneric,
		colored: nextColored,
		totalCmc: nextGeneric + colorSum + flexSum + (baseReq.snow ?? 0)
	};
}

export function collectOfferingCastOptionsForCard(args: {
	state: GameState;
	actor: PlayerGameState | undefined;
	actorId: string;
	inst: CardInstance;
	fromZone: ZoneType;
	taxSuffix: string;
	mandatoryAdditionalCosts?: import('../ir.ts').CostDef[];
	optionalAdditionalCosts?: CastOptionOptionalCost[];
	buildPaymentAids: (
		zone: CastOption['fromZone'],
		faceIdx: number,
		isFused: boolean,
		isFree: boolean
	) => CastCostAid[] | undefined;
	getSpellTargetRequirement: (
		card: ScryfallCard,
		faceIndex?: number,
		fused?: boolean
	) => TargetRequirementInfo;
	choosesX: boolean;
	matchesFilterFn: (obj: CardInstance, filter: ObjectFilter, ctx: FilterContext) => boolean;
}): CastOption[] {
	const { state, actor, actorId, inst, fromZone, taxSuffix, matchesFilterFn } = args;
	if (!actor) return [];
	if (fromZone !== 'hand' && fromZone !== 'command') return [];
	const card = effectiveCardForObject(inst);
	const specs = findOfferingSpecs(card, 0);
	if (specs.length === 0) return [];

	const out: CastOption[] = [];
	const faceView = resolveObjectFaces(card, { zone: 'stack', faceIndex: 0 });
	const printedManaCost = faceView.manaCost || '{0}';
	const targetInfo = args.getSpellTargetRequirement(card, 0, false);
	const aids = args.buildPaymentAids(fromZone, 0, false, false);

	for (const spec of specs) {
		const ctx: FilterContext = { state, controllerId: actorId, source: inst };
		const cands = actor.battlefield.filter(
			(b) =>
				!b.phasedOut &&
				matchesFilterFn(b, { ...spec.filter, controller: 'you', zone: 'battlefield' }, ctx)
		);
		if (cands.length === 0) continue;
		out.push({
			id: 'alt:offering',
			label: `${spec.quality} offering`,
			costDisplay: `${printedManaCost}${taxSuffix}, Sacrifice a ${spec.quality}`,
			fromZone,
			permission: 'zone_default',
			baseCost: { kind: 'printed' },
			...(args.mandatoryAdditionalCosts?.length
				? { mandatoryAdditionalCosts: args.mandatoryAdditionalCosts }
				: {}),
			...(args.optionalAdditionalCosts?.length
				? { optionalAdditionalCosts: args.optionalAdditionalCosts }
				: {}),
			...(aids?.length ? { paymentAids: aids } : {}),
			timing: 'instant_only',
			spellMods: {
				castSummarySuffix: ` (${spec.quality} offering)`,
				label: `${spec.quality} offering`
			},
			choosesX: args.choosesX,
			requiresTarget: targetInfo.requiresTarget,
			offeringBaseCost: printedManaCost,
			offeringCandidateIds: cands.map((c) => c.instanceId),
			offeringQuality: spec.quality
		});
		break;
	}
	return out;
}

export function findPayableOfferingCandidates(
	state: GameState,
	actor: PlayerGameState,
	spellInst: CardInstance,
	option: CastOption,
	baseReq: ManaCostRequirement,
	matchesFilterFn: (obj: CardInstance, filter: ObjectFilter, ctx: FilterContext) => boolean,
	canPayManaFn: (req: ManaCostRequirement, reserved: Set<string>) => boolean
): Array<{ perm: CardInstance; req: ManaCostRequirement; filter: ObjectFilter }> {
	const card = effectiveCardForObject(spellInst);
	const specs = findOfferingSpecs(card, option.faceIndex ?? 0);
	if (specs.length === 0) return [];
	const spec =
		(option.offeringQuality
			? specs.find((s) => s.quality === option.offeringQuality)
			: undefined) ?? specs[0];
	const ctx: FilterContext = { state, controllerId: actor.playerId, source: spellInst };
	const cands = actor.battlefield.filter(
		(b) =>
			!b.phasedOut &&
			matchesFilterFn(b, { ...spec.filter, controller: 'you', zone: 'battlefield' }, ctx)
	);
	const out: Array<{ perm: CardInstance; req: ManaCostRequirement; filter: ObjectFilter }> = [];
	for (const perm of cands) {
		const reducedReq = reduceManaCostReqByOffering(baseReq, perm);
		const reserved = new Set<string>([perm.instanceId]);
		if (canPayManaFn(reducedReq, reserved)) {
			out.push({ perm, req: reducedReq, filter: spec.filter });
		}
	}
	return out;
}

// ---- Siege / Anchor Word ETB Choice (CR 614.12c) & Condition Evaluation ---------------------

export function findAnchorWordChoiceSpec(obj: CardInstance): [string, string] | null {
	if (obj.isFaceDown) return null;
	const card = effectiveCardForObject(obj);
	for (const ab of activeAbilityDefs(card, instanceFaceOptions(obj, 'battlefield'))) {
		if (
			ab.kind === 'replacement' &&
			ab.replacement.with &&
			!Array.isArray(ab.replacement.with) &&
			ab.replacement.with.k === 'modify' &&
			ab.replacement.with.chooseAnchorWord
		) {
			return ab.replacement.with.chooseAnchorWord;
		}
	}
	return null;
}

export function evaluateP18bCondition(
	cond: Condition,
	source: CardInstance | undefined
): boolean | null {
	if (cond.k === 'anchorWordChosen') {
		const chosen = source?.chosenAnchorWord;
		if (!chosen) return false;
		return chosen.trim().toLowerCase() === cond.word.trim().toLowerCase();
	}
	return null;
}

// ---- Expanded Modals & Self Cast Restrictions (CR 700.2d,e,i, CR 607.2d, CR 601.3) ----------

export function getEffectiveUsedModalModes(
	modal: ModalDef,
	perm: CardInstance | undefined
): number[] | undefined {
	if (!perm) return undefined;
	if (modal.unchosenPermanent) {
		return perm.usedModalModesPermanent;
	}
	if (modal.oncePerTurnUnique) {
		return perm.usedModalModesThisTurn;
	}
	return undefined;
}

export function recordChosenModalModesOnPermanent(
	perm: CardInstance | undefined,
	modal: ModalDef | undefined,
	chosenModes: readonly number[] | undefined
): void {
	if (!perm || !modal || !chosenModes || chosenModes.length === 0) return;
	if (modal.oncePerTurnUnique) {
		const used = (perm.usedModalModesThisTurn ??= []);
		for (const idx of chosenModes) {
			if (!used.includes(idx)) used.push(idx);
		}
	}
	if (modal.unchosenPermanent) {
		const usedPerm = (perm.usedModalModesPermanent ??= []);
		for (const idx of chosenModes) {
			if (!usedPerm.includes(idx)) usedPerm.push(idx);
		}
	}
}

export function resolveModalEffectiveBounds(
	modal: ModalDef,
	chooseAllActive: boolean,
	xValue?: number,
	evaluatedDynamicMax?: number
): { min: number; max: number } {
	if (chooseAllActive) {
		return { min: modal.modes.length, max: modal.modes.length };
	}
	if (modal.pawprintBudget !== undefined && modal.pawprintCosts?.length) {
		const minCost = Math.max(1, Math.min(...modal.pawprintCosts));
		const maxPossible = Math.floor(modal.pawprintBudget / minCost);
		return {
			min: modal.min,
			max: Math.max(modal.min, maxPossible)
		};
	}
	if (modal.dynamicMax) {
		const dyn =
			modal.dynamicMax.k === 'x'
				? Math.max(0, xValue ?? 0)
				: Math.max(0, evaluatedDynamicMax ?? modal.max);
		const min = modal.upTo ? 0 : Math.min(dyn, modal.modes.length);
		const max = modal.allowRepeat ? dyn : Math.min(dyn, modal.modes.length);
		return { min, max };
	}
	return { min: modal.min, max: modal.max };
}

export function validatePawprintBudget(
	modal: ModalDef,
	chosenModes: readonly number[]
): { ok: boolean; reason?: string } {
	if (modal.pawprintBudget === undefined || !modal.pawprintCosts) {
		return { ok: true };
	}
	let spent = 0;
	for (const idx of chosenModes) {
		const c = modal.pawprintCosts[idx];
		if (c === undefined || c < 0) {
			return { ok: false, reason: 'Invalid pawprint mode index.' };
		}
		spent += c;
	}
	if (spent > modal.pawprintBudget) {
		return {
			ok: false,
			reason: `Selected modes cost ${spent} pawprints, exceeding budget of ${modal.pawprintBudget} (CR 700.2i).`
		};
	}
	return { ok: true };
}

export function pickPawprintModesWithinBudget(
	modal: ModalDef,
	eligibleIndices: readonly number[]
): number[] {
	if (modal.pawprintBudget === undefined || !modal.pawprintCosts || eligibleIndices.length === 0) {
		return [];
	}
	let remaining = modal.pawprintBudget;
	const out: number[] = [];
	// Prefer highest-cost affordable modes first for stronger Season plays, bounded by budget.
	const sorted = [...eligibleIndices].sort(
		(a, b) => (modal.pawprintCosts![b] ?? 1) - (modal.pawprintCosts![a] ?? 1) || a - b
	);
	for (let guard = 0; guard < 16 && remaining > 0; guard++) {
		let pickedAny = false;
		for (const idx of sorted) {
			const cost = modal.pawprintCosts[idx] ?? 1;
			if (cost > 0 && cost <= remaining) {
				if (!modal.allowRepeat && out.includes(idx)) continue;
				out.push(idx);
				remaining -= cost;
				pickedAny = true;
				break;
			}
		}
		if (!pickedAny) break;
	}
	return out;
}

export function collectSelfCastRestrictions(
	card: ScryfallCard,
	faceIndex = 0
): {
	restrictions: SpellCastRestrictionKind[];
	conditions: Condition[];
	xCantBeZero: boolean;
} {
	const restrictions: SpellCastRestrictionKind[] = [];
	const conditions: Condition[] = [];
	let xCantBeZero = false;
	for (const ab of activeAbilityDefs(card, { zone: 'stack', faceIndex })) {
		if (ab.kind === 'spell') {
			if (ab.castRestrictions) restrictions.push(...ab.castRestrictions);
			if (ab.castCondition) conditions.push(ab.castCondition);
			if (ab.xCantBeZero) xCantBeZero = true;
		} else if (ab.kind === 'unsupported' && ab.castRestrictions) {
			restrictions.push(...ab.castRestrictions);
			if (ab.castCondition) conditions.push(ab.castCondition);
		} else if (ab.kind === 'static' && ab.static.k === 'selfCastRestriction') {
			if (ab.static.restrictions) restrictions.push(...ab.static.restrictions);
			if (ab.static.castCondition) conditions.push(ab.static.castCondition);
			if (ab.static.xCantBeZero) xCantBeZero = true;
		}
	}
	return { restrictions, conditions, xCantBeZero };
}

const COMBAT_PHASES = new Set([
	'begin_combat',
	'declare_attackers',
	'declare_blockers',
	'first_strike_damage',
	'combat_damage',
	'end_combat'
]);

const AFTER_ATTACKERS_PHASES = new Set([
	'declare_attackers',
	'declare_blockers',
	'first_strike_damage',
	'combat_damage',
	'end_combat'
]);

const AFTER_BLOCKERS_PHASES = new Set([
	'declare_blockers',
	'first_strike_damage',
	'combat_damage',
	'end_combat'
]);

export function checkTimingRestrictionKind(
	state: GameState,
	actorId: string,
	r: SpellCastRestrictionKind | string
): { ok: boolean; reason?: string } {
	const activePlayerId = state.players[state.activePlayerIndex]?.playerId;
	switch (r) {
		case 'duringCombat':
			if (!COMBAT_PHASES.has(state.phase)) {
				return { ok: false, reason: 'May only be used during combat.' };
			}
			return { ok: true };
		case 'duringYourTurn':
			if (activePlayerId !== actorId) {
				return { ok: false, reason: 'May only be used during your turn.' };
			}
			return { ok: true };
		case 'duringOpponentsTurn':
			if (activePlayerId === actorId) {
				return { ok: false, reason: "May only be used during an opponent's turn." };
			}
			return { ok: true };
		case 'duringYourUpkeep':
			if (activePlayerId !== actorId || state.phase !== 'upkeep') {
				return { ok: false, reason: 'May only be used during your upkeep.' };
			}
			return { ok: true };
		case 'beforeAttackers':
			if (
				state.phase !== 'upkeep' &&
				state.phase !== 'draw' &&
				state.phase !== 'main1' &&
				state.phase !== 'begin_combat'
			) {
				return { ok: false, reason: 'May only be used before attackers are declared.' };
			}
			return { ok: true };
		case 'afterAttackers':
			if (!AFTER_ATTACKERS_PHASES.has(state.phase) || !state.combat?.active) {
				return { ok: false, reason: 'May only be used during combat after attackers are declared.' };
			}
			return { ok: true };
		case 'beforeBlockers':
			if (state.phase !== 'begin_combat' && state.phase !== 'declare_attackers') {
				return { ok: false, reason: 'May only be used during combat before blockers are declared.' };
			}
			return { ok: true };
		case 'duringBlockers':
			if (state.phase !== 'declare_blockers') {
				return { ok: false, reason: 'May only be used during the declare blockers step.' };
			}
			return { ok: true };
		case 'afterBlockers':
			if (!AFTER_BLOCKERS_PHASES.has(state.phase) || !state.combat?.blockersDeclared) {
				return { ok: false, reason: 'May only be used during combat after blockers are declared.' };
			}
			return { ok: true };
		case 'afterCombat':
			if (state.phase !== 'main2' && state.phase !== 'end_step') {
				return { ok: false, reason: 'May only be used after combat.' };
			}
			return { ok: true };
		default:
			return { ok: true };
	}
}

export type { Amount, ManaColor };
