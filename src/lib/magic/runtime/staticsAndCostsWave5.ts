/**
 * Wave 5 Track P14 — Statics & Costs Wave 5 runtime module.
 *
 * Implements:
 * 1. Devotion (`CR 700.5a–b`) for Layer 4 Theros Gods, Layer 7a/7c CDAs & pumps, and cost modifiers.
 * 2. Graveyard continuous statics (`CR 113.6b`, Wonder / Brawn / Anger / Filth / Valor / Glory).
 * 3. Self-Safe Aura Protection attachment exemptions (`CR 702.16n, 702.16p, 704.5m`).
 * 4. Super-Trample (`CR 510.1c–d`), Defender-override attack rules (`CR 702.3b`), and static Goad (`CR 701.15`).
 * 5. Commander designation (`CR 903.3a`) & deck copy-limit (`CR 903.5b, 100.2a`) IR queries.
 * 6. Turn-slotted & self graveyard/exile play permissions (`CR 305.1, 601.3e`: Muldrotha, Karador, Kess, Lurrus, Conduit, Gravecrawler, Squee, Misthollow Griffin, Eternal Scourge).
 * 7. Static damage prevention & Phantom / Polukranos counter-removal prevention (`CR 615.1, 615.5–6, 615.10, 615.12`).
 * 8. Behold (`CR 701.4a–b`), Waterbend (`CR 701.67a–b`), and Wave 5 Amount & ObjectFilter evaluators.
 *
 * Pure IR-driven runtime evaluation: zero raw rules-text reads, zero card-name branches, zero direct zone mutations.
 */
import { compileCard } from '../compiler/index.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import type {
	AbilityDef,
	Amount,
	Compare,
	Condition,
	CostDef,
	ObjectFilter,
	PlayerRef,
	StaticDef
} from '../ir.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import type {
	CardInstance,
	CastCostAid,
	CastOption,
	CastOptionOptionalCost,
	CounterType,
	GameState,
	ManaColor,
	PlayerGameState,
	ScryfallCard,
	SpellModifications,
	TargetRef,
	ZoneType
} from '../types.ts';
import { emitEvent } from './events.ts';
import {
	activeAbilityDefs,
	activeCharacteristics,
	instanceFaceOptions,
	resolveObjectFaces
} from './faces.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { splitSubtypes } from './layers.ts';
import {
	evaluateCondition,
	matchesObjectFilter,
	objectManaValue,
	type FilterContext
} from './objectFilter.ts';
import {
	forEachActiveStaticOnBattlefield
} from './staticsDynamicAndCosts.ts';
import {
	getActiveCombatRulesForPermanent
} from './staticsLayersAndRestrictions.ts';
import { handlePreventedDamageRiderWave9 } from './replaceWave9.ts';
import { moveObject, shuffleLibrary } from './zones.ts';

// ---- 1. Devotion (CR 700.5a–b) --------------------------------------------------------------

const DEVOTION_COLORS: ReadonlySet<string> = new Set(['W', 'U', 'B', 'R', 'G']);

/**
 * CR 700.5a–b: Counts mana symbols in `manaCost` that contain at least one color in `colors`.
 * Hybrid symbols (e.g. `{W/U}`, `{2/W}`, `{W/P}`, `{W/U/P}`) count at most ONCE even when
 * checking devotion to two colors (`colors = ['W', 'U']`).
 */
export function countManaSymbolsForDevotion(
	manaCost: string,
	colors: readonly ManaColor[]
): number {
	if (!manaCost || colors.length === 0) return 0;
	let wantMask = 0;
	for (let i = 0; i < colors.length; i++) {
		const c = colors[i];
		if (c === 'W') wantMask |= 1;
		else if (c === 'U') wantMask |= 2;
		else if (c === 'B') wantMask |= 4;
		else if (c === 'R') wantMask |= 8;
		else if (c === 'G') wantMask |= 16;
	}
	if (wantMask === 0) return 0;
	let count = 0;
	const len = manaCost.length;
	for (let i = 0; i < len; i++) {
		if (manaCost.charCodeAt(i) !== 123 /* '{' */) continue;
		const close = manaCost.indexOf('}', i + 1);
		if (close < 0) break;
		let matched = false;
		for (let j = i + 1; j < close; j++) {
			const ch = manaCost[j];
			if (!DEVOTION_COLORS.has(ch)) continue;
			const bit =
				ch === 'W' ? 1 : ch === 'U' ? 2 : ch === 'B' ? 4 : ch === 'R' ? 8 : ch === 'G' ? 16 : 0;
			if ((wantMask & bit) !== 0) {
				matched = true;
				break;
			}
		}
		if (matched) count += 1;
		i = close;
	}
	return count;
}

/**
 * Resolves the post-Layer-1 copiable mana cost of a battlefield permanent for devotion (`CR 700.5a`,
 * `CR 708.2a` face-down = `''`, `CR 707.9` `noManaCost` = `''`).
 */
export function permanentCopiableManaCostForDevotion(
	perm: CardInstance,
	state?: GameState
): string {
	if (perm.isFaceDown) return '';
	let effCard = perm.copiableCard ?? perm.card;
	let noManaCost = Boolean(perm.copiableState?.except?.noManaCost);
	let copyFaceIdx = perm.copiableState?.faceIndex;
	if (state?.timedContinuousEffects) {
		for (let i = 0; i < state.timedContinuousEffects.length; i++) {
			const eff = state.timedContinuousEffects[i];
			if (!eff.layer1a) continue;
			const hit = eff.affected.some(
				(a) =>
					a.instanceId === perm.instanceId &&
					(a.objectVersion === undefined || a.objectVersion === perm.objectVersion)
			);
			if (!hit) continue;
			effCard = eff.layer1a.card;
			noManaCost = Boolean(eff.layer1a.except?.noManaCost);
			copyFaceIdx = eff.layer1a.faceIndex;
		}
	}
	if (noManaCost) return '';
	if (copyFaceIdx !== undefined) {
		return resolveObjectFaces(effCard, { zone: 'battlefield', faceIndex: copyFaceIdx }).manaCost;
	}
	return resolveObjectFaces(effCard, instanceFaceOptions(perm, 'battlefield')).manaCost;
}

/**
 * Computes `playerId`'s devotion to `colors` across all phased-in battlefield permanents they
 * currently control (post-Layer-2 evaluated controller).
 */
export function computeDevotionToColors(
	state: GameState,
	playerId: string,
	colors: readonly ManaColor[]
): number {
	if (!playerId || colors.length === 0) return 0;
	let total = 0;
	for (let pi = 0; pi < state.players.length; pi++) {
		const p = state.players[pi];
		if (p.lost) continue;
		for (let bi = 0; bi < p.battlefield.length; bi++) {
			const perm = p.battlefield[bi];
			if (perm.phasedOut) continue;
			const evalPerm = evaluatePermanent(state, perm);
			if (evalPerm.controllerId !== playerId) continue;
			const mc = permanentCopiableManaCostForDevotion(perm, state);
			total += countManaSymbolsForDevotion(mc, colors);
		}
	}
	return total;
}

/**
 * Direct workList devotion helper for `runtime/layers.ts` (`evaluateLayerAmount`) using post-Layer-1
 * `manaCost` and post-Layer-2 `controllerId` without re-entering `evaluateBoard`.
 */
export function computeWorkListDevotionToColors(
	workItems: ReadonlyArray<{ controllerId: string; manaCost: string }>,
	playerId: string,
	colors: readonly ManaColor[]
): number {
	if (!playerId || colors.length === 0) return 0;
	let total = 0;
	for (let i = 0; i < workItems.length; i++) {
		const item = workItems[i];
		if (item.controllerId !== playerId) continue;
		total += countManaSymbolsForDevotion(item.manaCost, colors);
	}
	return total;
}

// ---- 2. Graveyard Continuous Statics (CR 113.6b) --------------------------------------------

const graveyardContinuousCache = new WeakMap<ScryfallCard, boolean>();

export function cardHasGraveyardContinuousStatic(card: ScryfallCard): boolean {
	const cached = graveyardContinuousCache.get(card);
	if (cached !== undefined) return cached;
	const def = compileCard(card);
	let found = false;
	for (let fi = 0; fi < def.faces.length && !found; fi++) {
		const abilities = def.faces[fi].abilities;
		for (let ai = 0; ai < abilities.length; ai++) {
			const ab = abilities[ai];
			if (
				ab.kind === 'static' &&
				ab.static.k === 'continuous' &&
				ab.static.activeInZone === 'graveyard'
			) {
				found = true;
				break;
			}
		}
	}
	graveyardContinuousCache.set(card, found);
	return found;
}

export function collectGraveyardContinuousStaticsForPlayer(
	player: PlayerGameState
): Array<{
	cardInst: CardInstance;
	staticDef: Extract<StaticDef, { k: 'continuous' }>;
}> {
	const out: Array<{
		cardInst: CardInstance;
		staticDef: Extract<StaticDef, { k: 'continuous' }>;
	}> = [];
	for (let i = 0; i < player.graveyard.length; i++) {
		const inst = player.graveyard[i];
		const card = effectiveCardForObject(inst);
		if (!cardHasGraveyardContinuousStatic(card)) continue;
		const abilities = activeAbilityDefs(card, instanceFaceOptions(inst, 'graveyard'));
		for (let ai = 0; ai < abilities.length; ai++) {
			const ab = abilities[ai];
			if (
				ab.kind === 'static' &&
				ab.static.k === 'continuous' &&
				ab.static.activeInZone === 'graveyard'
			) {
				out.push({ cardInst: inst, staticDef: ab.static });
			}
		}
	}
	return out;
}

// ---- 3. Self-Safe Aura Protection (CR 702.16n, 702.16p, 704.5m) -----------------------------

export interface ProtectionAttachmentExemptionInfo {
	mode: 'self' | 'allAuras' | 'controlledAuras' | 'controlledAttachments';
	sourceId: string;
	controllerId: string;
}

export function isAttachmentExemptFromProtectionGrant(
	attachment: CardInstance,
	state: GameState,
	exemption: ProtectionAttachmentExemptionInfo | undefined
): boolean {
	if (!exemption) return false;
	if (exemption.mode === 'self') {
		return attachment.instanceId === exemption.sourceId;
	}
	const evalAtt = evaluatePermanent(state, attachment);
	const isAura = /\bAura\b/.test(evalAtt.typeLine);
	const isEquipment = /\bEquipment\b/.test(evalAtt.typeLine);
	if (exemption.mode === 'allAuras') {
		return isAura;
	}
	if (exemption.mode === 'controlledAuras') {
		return isAura && evalAtt.controllerId === exemption.controllerId;
	}
	if (exemption.mode === 'controlledAttachments') {
		return (isAura || isEquipment) && evalAtt.controllerId === exemption.controllerId;
	}
	return false;
}

/**
 * Checks whether a single lowercased protection keyword string (e.g. `"protection from all colors"`)
 * matches the given source colors and typeLine.
 */
export function doesProtectionQualityMatchSource(
	kwLower: string,
	srcColors: readonly ManaColor[],
	srcTypeLine: string
): boolean {
	if (!kwLower.includes('protection from')) return false;
	if (/protection from everything/i.test(kwLower)) return true;
	if (/protection from all colors/i.test(kwLower) && srcColors.length > 0) return true;
	if (/protection from multicolored/i.test(kwLower) && srcColors.length >= 2) return true;
	if (/protection from monocolored/i.test(kwLower) && srcColors.length === 1) return true;
	if (/protection from colorless/i.test(kwLower) && srcColors.length === 0) return true;
	if (/protection from [^.\n]*\bwhite\b/i.test(kwLower) && srcColors.includes('W')) return true;
	if (/protection from [^.\n]*\bblue\b/i.test(kwLower) && srcColors.includes('U')) return true;
	if (/protection from [^.\n]*\bblack\b/i.test(kwLower) && srcColors.includes('B')) return true;
	if (/protection from [^.\n]*\bred\b/i.test(kwLower) && srcColors.includes('R')) return true;
	if (/protection from [^.\n]*\bgreen\b/i.test(kwLower) && srcColors.includes('G')) return true;
	if (/protection from creatures/i.test(kwLower) && srcTypeLine.includes('Creature')) return true;
	if (/protection from instants/i.test(kwLower) && srcTypeLine.includes('Instant')) return true;
	if (/protection from sorceries/i.test(kwLower) && srcTypeLine.includes('Sorcery')) return true;
	if (/protection from artifacts/i.test(kwLower) && srcTypeLine.includes('Artifact')) return true;
	if (/protection from enchantments/i.test(kwLower) && srcTypeLine.includes('Enchantment')) {
		return true;
	}
	if (/protection from lands/i.test(kwLower) && srcTypeLine.includes('Land')) return true;
	if (/protection from planeswalkers/i.test(kwLower) && srcTypeLine.includes('Planeswalker')) {
		return true;
	}
	// --- Track P22a ---
	if (/protection from battles/i.test(kwLower) && srcTypeLine.includes('Battle')) return true;
	if (
		/protection from (?:kindred|tribal)/i.test(kwLower) &&
		(srcTypeLine.includes('Kindred') || srcTypeLine.includes('Tribal'))
	) {
		return true;
	}
	// --- End Track P22a ---
	return false;
}

// ---- 4. Super-Trample, Defender Override, & Static Goad -------------------------------------

/** CR 510.1c–d: "You may have [creature] assign its combat damage as though it weren't blocked." */
export function creatureMayAssignCombatDamageAsThoughUnblocked(
	state: GameState,
	creature: CardInstance
): boolean {
	for (const entry of getActiveCombatRulesForPermanent(state, creature)) {
		if (entry.rule.kind === 'assignCombatDamageAsThoughUnblocked') {
			return true;
		}
	}
	return false;
}

/** CR 508.1c, 702.3b: "[creature] can attack as though it didn't have defender." */
export function creatureCanAttackDespiteDefender(
	state: GameState,
	creature: CardInstance
): boolean {
	for (const entry of getActiveCombatRulesForPermanent(state, creature)) {
		if (entry.rule.kind === 'canAttackDespiteDefender') {
			return true;
		}
	}
	return false;
}

/** CR 701.15: Returns all goader player IDs (turn-based goad + static "Enchanted creature is goaded"). */
export function getEffectiveGoaderPlayerIds(
	state: GameState,
	creature: CardInstance
): string[] {
	const base = creature.goadedByPlayerIds;
	let extra: string[] | undefined;
	for (const entry of getActiveCombatRulesForPermanent(state, creature)) {
		if (entry.rule.kind === 'isGoaded') {
			const goaderId = evaluatePermanent(state, entry.sourcePerm).controllerId;
			if (!extra) extra = [];
			if (!extra.includes(goaderId) && (!base || !base.includes(goaderId))) {
				extra.push(goaderId);
			}
		}
	}
	if (!extra || extra.length === 0) return base ?? [];
	return base && base.length > 0 ? [...base, ...extra] : extra;
}

// ---- 5. Commander & Deck Designations (CR 903.3a, 903.5b) -----------------------------------

export function cardHasCommanderDesignation(card: ScryfallCard): boolean {
	const def = compileCard(card);
	for (let fi = 0; fi < def.faces.length; fi++) {
		const abilities = def.faces[fi].abilities;
		for (let ai = 0; ai < abilities.length; ai++) {
			const ab = abilities[ai];
			if (ab.kind === 'static' && ab.static.k === 'commanderDesignation') {
				return true;
			}
		}
	}
	return false;
}

export function getCardDeckCopyLimit(card: ScryfallCard): number | 'any' | undefined {
	const def = compileCard(card);
	for (let fi = 0; fi < def.faces.length; fi++) {
		const abilities = def.faces[fi].abilities;
		for (let ai = 0; ai < abilities.length; ai++) {
			const ab = abilities[ai];
			if (ab.kind === 'static' && ab.static.k === 'deckCopyLimit') {
				return ab.static.limit;
			}
		}
	}
	return undefined;
}

// ---- 6. Turn-Slotted & Self Graveyard / Exile Play Permissions (CR 305.1, 601.3e) -----------

const PERMANENT_TYPES_FOR_SLOTS = [
	'Artifact',
	'Battle',
	'Creature',
	'Enchantment',
	'Kindred',
	'Land',
	'Planeswalker'
] as const;

function isSlotUsed(player: PlayerGameState, slotKey: string): boolean {
	return Boolean(player.usedStaticPlaySlotsThisTurn?.includes(slotKey));
}

export function consumeWave5StaticPlaySlot(
	player: PlayerGameState,
	slotKey: string | undefined
): void {
	if (!slotKey) return;
	if (!player.usedStaticPlaySlotsThisTurn) {
		player.usedStaticPlaySlotsThisTurn = [slotKey];
	} else if (!player.usedStaticPlaySlotsThisTurn.includes(slotKey)) {
		player.usedStaticPlaySlotsThisTurn.push(slotKey);
	}
}

function getZonePlayStaticsOnPermanent(
	state: GameState,
	perm: CardInstance
): Array<{ abTag: string; sourceName: string; staticDef: Extract<StaticDef, { k: 'zonePlayPermission' }> }> {
	const out: Array<{
		abTag: string;
		sourceName: string;
		staticDef: Extract<StaticDef, { k: 'zonePlayPermission' }>;
	}> = [];
	if (perm.phasedOut) return out;
	const evalPerm = evaluatePermanent(state, perm);
	const srcName = perm.isFaceDown
		? (perm.faceDownLabel || 'Face-Down Permanent')
		: evalPerm.effectiveName;
	if (!evalPerm.losesAllAbilities) {
		const abilities = activeAbilityDefs(
			effectiveCardForObject(perm),
			instanceFaceOptions(perm, 'battlefield')
		);
		for (let i = 0; i < abilities.length; i++) {
			const ab = abilities[i];
			if (ab.kind === 'static' && ab.static.k === 'zonePlayPermission') {
				out.push({
					abTag: `${perm.instanceId}:${perm.objectVersion}:ab${i}`,
					sourceName: srcName,
					staticDef: ab.static
				});
			}
		}
	}
	return out;
}

/**
 * Checks whether `actorId` has an active turn-slotted land play permission for `landCard` from `zone`
 * (`graveyard` or `library` or `exile`), returning `{ sourceName, slotKey }` if available.
 */
export function getWave5SlottedLandPlayPermission(
	state: GameState,
	actorId: string,
	zone: 'library' | 'graveyard' | 'exile',
	landCard?: CardInstance
): { sourceName: string; slotKey: string } | null {
	const actor = state.players.find((p) => p.playerId === actorId && !p.lost);
	if (!actor) return null;
	const isYourTurn = state.players[state.activePlayerIndex]?.playerId === actorId;
	for (let i = 0; i < actor.battlefield.length; i++) {
		const perm = actor.battlefield[i];
		const entries = getZonePlayStaticsOnPermanent(state, perm);
		for (let ei = 0; ei < entries.length; ei++) {
			const { abTag, sourceName, staticDef: st } = entries[ei];
			if (st.zone !== zone || !st.allowLands || st.affects === 'self') continue;
			const slotMode = st.slotMode ?? 'unlimited';
			if (slotMode === 'unlimited') continue; // Handled by Track P8 unlimited land permission
			if (st.duringYourTurnOnly && !isYourTurn) continue;
			const fctx: FilterContext = { state, controllerId: actorId, source: perm };
			if (st.condition && !evaluateCondition(st.condition, fctx)) continue;
			if (slotMode === 'oncePerTurn') {
				const slotKey = `${abTag}:once`;
				if (!isSlotUsed(actor, slotKey)) {
					return { sourceName, slotKey };
				}
			} else if (slotMode === 'perPermanentType') {
				const landTypes = landCard
					? activeCharacteristics(effectiveCardForObject(landCard), { zone, faceIndex: 0 }).types
					: ['Land'];
				// Prefer the 'Land' slot first so Artifact Lands don't needlessly burn 'Artifact' unless 'Land' is spent.
				const orderedTypes = landTypes.includes('Land')
					? ['Land', ...PERMANENT_TYPES_FOR_SLOTS.filter((t) => t !== 'Land' && landTypes.includes(t))]
					: PERMANENT_TYPES_FOR_SLOTS.filter((t) => landTypes.includes(t));
				for (let ti = 0; ti < orderedTypes.length; ti++) {
					const slotKey = `${abTag}:type:${orderedTypes[ti]}`;
					if (!isSlotUsed(actor, slotKey)) {
						return { sourceName, slotKey };
					}
				}
			}
		}
	}
	return null;
}

/**
 * Checks whether `inst` in `exile` has an active Wave 5 cast/play permission for `actorId`
 * (e.g. Squee, the Immortal; Misthollow Griffin; Eternal Scourge; or external exile zonePlayPermission).
 */
export function hasWave5ExilePlayPermission(
	state: GameState,
	actorId: string,
	inst: CardInstance
): boolean {
	if (inst.ownerId !== actorId) return false;
	const isYourTurn = state.players[state.activePlayerIndex]?.playerId === actorId;
	const card = effectiveCardForObject(inst);
	const def = compileCard(card);
	for (let fi = 0; fi < def.faces.length; fi++) {
		const abilities = def.faces[fi].abilities;
		for (let ai = 0; ai < abilities.length; ai++) {
			const ab = abilities[ai];
			if (ab.kind === 'static' && ab.static.k === 'zonePlayPermission') {
				if (ab.static.zone !== 'exile' || ab.static.affects !== 'self') continue;
				if (ab.static.duringYourTurnOnly && !isYourTurn) continue;
				if (
					ab.static.condition &&
					!evaluateCondition(ab.static.condition, {
						state,
						controllerId: actorId,
						source: inst
					})
				) {
					continue;
				}
				return true;
			}
			if (
				ab.kind === 'static' &&
				ab.static.k === 'altCastPermission' &&
				ab.static.affects === 'self' &&
				ab.static.allowedZones?.includes('exile')
			) {
				if (
					!ab.static.condition ||
					evaluateCondition(ab.static.condition, {
						state,
						controllerId: actorId,
						source: inst
					})
				) {
					return true;
				}
			}
		}
	}
	const actor = state.players.find((p) => p.playerId === actorId && !p.lost);
	if (actor) {
		for (let bi = 0; bi < actor.battlefield.length; bi++) {
			const perm = actor.battlefield[bi];
			const entries = getZonePlayStaticsOnPermanent(state, perm);
			for (let ei = 0; ei < entries.length; ei++) {
				const st = entries[ei].staticDef;
				if (st.zone !== 'exile' || st.affects === 'self' || st.allowSpells === false) continue;
				if (st.duringYourTurnOnly && !isYourTurn) continue;
				if (
					st.condition &&
					!evaluateCondition(st.condition, { state, controllerId: actorId, source: perm })
				) {
					continue;
				}
				return true;
			}
		}
	}
	return false;
}

export interface CollectWave5ZoneCastOptionsParams {
	state: GameState;
	actor: PlayerGameState | undefined;
	actorId: string;
	inst: CardInstance;
	fromZone: 'hand' | 'command' | 'exile' | 'graveyard' | 'library';
	faceIndex: number;
	isMultiFace: boolean;
	isAdventureFace: boolean;
	faceName: string;
	faceManaCost: string;
	faceTypes: readonly string[];
	taxSuffix: string;
	mandatoryAdditionalCosts?: CostDef[];
	optionalAdditionalCosts: CastOptionOptionalCost[];
	paymentAids?: CastCostAid[];
	adventureMods: Partial<SpellModifications>;
	requiresTarget: boolean;
	choosesX: boolean;
}

/**
 * Enumerates `CastOption`s granted by Wave 5 `zonePlayPermission` statics:
 * - Self graveyard/exile cast permissions (Gravecrawler, Oathsworn Vampire, Marang River Prowler, Squee, Misthollow Griffin, Eternal Scourge)
 * - Turn-slotted & unlimited controller graveyard/exile permissions (Muldrotha, Karador, Kess, Lurrus, Conduit of Worlds, Gisa and Geralf, Yawgmoth's Will)
 */
export function collectWave5ZoneCastOptions(
	params: CollectWave5ZoneCastOptionsParams
): CastOption[] {
	const {
		state,
		actor,
		actorId,
		inst,
		fromZone,
		faceIndex,
		isMultiFace,
		isAdventureFace,
		faceName,
		faceManaCost,
		faceTypes,
		taxSuffix,
		mandatoryAdditionalCosts,
		optionalAdditionalCosts,
		paymentAids,
		adventureMods,
		requiresTarget,
		choosesX
	} = params;
	if (!actor) return [];
	if (fromZone !== 'graveyard' && fromZone !== 'exile' && fromZone !== 'library') return [];
	if (fromZone === 'library' && actor.library[0]?.instanceId !== inst.instanceId) return [];
	if (inst.ownerId !== actorId) return [];
	const isLandOnlyFace = faceTypes.includes('Land') && !faceTypes.includes('Creature');
	if (isLandOnlyFace) return [];

	const out: CastOption[] = [];
	const isYourTurn = state.players[state.activePlayerIndex]?.playerId === actorId;
	const faceIndexProp = isMultiFace ? { faceIndex } : {};
	const optionalProp = optionalAdditionalCosts.length > 0 ? { optionalAdditionalCosts } : {};
	const paymentAidsProp = paymentAids && paymentAids.length > 0 ? { paymentAids } : {};
	const idPrefix = faceIndex === 0 ? '' : `face:${faceIndex}:`;
	const zoneLabel =
		fromZone === 'exile' ? 'Exile' : fromZone === 'library' ? 'Library' : 'Graveyard';
	const zonePermission: CastOption['permission'] =
		fromZone === 'exile'
			? 'exile_permission'
			: fromZone === 'library'
				? 'library_top_permission'
				: 'static_alt';

	const card = effectiveCardForObject(inst);
	const stackProxy: CardInstance = {
		...inst,
		zone: 'stack',
		activeFaceIndex: faceIndex
	};

	// 1. Self zonePlayPermission on the card itself (e.g. Gravecrawler, Squee, Misthollow Griffin, Eternal Scourge).
	const selfAbilities = activeAbilityDefs(card, { zone: fromZone, faceIndex });
	for (let ai = 0; ai < selfAbilities.length; ai++) {
		const ab = selfAbilities[ai];
		if (ab.kind !== 'static' || ab.static.k !== 'zonePlayPermission') continue;
		const st = ab.static;
		if (st.zone !== fromZone || st.affects !== 'self' || st.allowSpells === false) continue;
		if (st.duringYourTurnOnly && !isYourTurn) continue;
		const selfCtx: FilterContext = { state, controllerId: actorId, source: inst };
		if (st.condition && !evaluateCondition(st.condition, selfCtx)) continue;
		if (st.spellFilter && !matchesObjectFilter(stackProxy, st.spellFilter, selfCtx)) continue;

		const baseCost: CastOption['baseCost'] = { kind: 'printed' };
		const label = isAdventureFace
			? `Cast Adventure: ${faceName} from ${zoneLabel}`
			: isMultiFace
				? `Cast ${faceName} from ${zoneLabel}`
				: `Cast from ${zoneLabel}`;
		out.push({
			id: `${idPrefix}${fromZone}:self:${ai}`,
			label,
			costDisplay: `${faceManaCost || '{0}'}${taxSuffix}`,
			fromZone,
			permission: zonePermission,
			...faceIndexProp,
			baseCost,
			...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
			...optionalProp,
			...paymentAidsProp,
			timing: 'default',
			spellMods: {
				...adventureMods,
				...(st.exileIfPutIntoGraveyard ? { exileIfPutIntoGraveyard: true } : {})
			},
			choosesX,
			requiresTarget
		});
	}

	// 2. Controller battlefield zonePlayPermission statics (Muldrotha, Karador, Kess, Lurrus, Conduit, etc.).
	for (let bi = 0; bi < actor.battlefield.length; bi++) {
		const perm = actor.battlefield[bi];
		const entries = getZonePlayStaticsOnPermanent(state, perm);
		for (let ei = 0; ei < entries.length; ei++) {
			const { abTag, sourceName, staticDef: st } = entries[ei];
			if (st.zone !== fromZone || st.affects === 'self' || st.allowSpells === false) continue;
			if (
				st.exiledWithSelf ||
				st.requireCounter ||
				st.cardOwner ||
				st.putIntoGraveyardFromNonBattlefieldThisTurn ||
				st.grantHasteUntilEndOfTurn ||
				st.grantFlash ||
				st.spendManaAsAnyColor ||
				st.entersTapped
			) {
				continue;
			}
			if (fromZone === 'library' && (!st.slotMode || st.slotMode === 'unlimited')) continue;
			if (st.duringYourTurnOnly && !isYourTurn) continue;
			const pCtx: FilterContext = { state, controllerId: actorId, source: perm };
			if (st.condition && !evaluateCondition(st.condition, pCtx)) continue;
			if (st.spellFilter && !matchesObjectFilter(stackProxy, st.spellFilter, pCtx)) continue;

			const slotMode = st.slotMode ?? 'unlimited';
			const baseCost: CastOption['baseCost'] = { kind: 'printed' };
			const extraMods: Partial<SpellModifications> = st.exileIfPutIntoGraveyard
				? { exileIfPutIntoGraveyard: true }
				: {};

			if (slotMode === 'unlimited') {
				out.push({
					id: `${idPrefix}${fromZone}:perm:${abTag}`,
					label: isMultiFace
						? `Cast ${faceName} from ${zoneLabel} (${sourceName})`
						: `Cast from ${zoneLabel} (${sourceName})`,
					costDisplay: `${faceManaCost || '{0}'}${taxSuffix}`,
					fromZone,
					permission: zonePermission,
					...faceIndexProp,
					baseCost,
					...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
					...optionalProp,
					...paymentAidsProp,
					timing: 'default',
					spellMods: { ...adventureMods, ...extraMods },
					choosesX,
					requiresTarget
				});
			} else if (slotMode === 'oncePerTurn') {
				const slotKey = `${abTag}:once`;
				if (isSlotUsed(actor, slotKey)) continue;
				out.push({
					id: `${idPrefix}${fromZone}:slot:${slotKey}`,
					label: isMultiFace
						? `Cast ${faceName} from ${zoneLabel} (${sourceName})`
						: `Cast from ${zoneLabel} (${sourceName})`,
					costDisplay: `${faceManaCost || '{0}'}${taxSuffix}`,
					fromZone,
					permission: zonePermission,
					...faceIndexProp,
					baseCost,
					...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
					...optionalProp,
					...paymentAidsProp,
					timing: 'default',
					spellMods: { ...adventureMods, ...extraMods },
					choosesX,
					requiresTarget,
					staticPlaySlotKey: slotKey
				});
			} else if (slotMode === 'perPermanentType') {
				const matchingPermTypes = PERMANENT_TYPES_FOR_SLOTS.filter((t) => faceTypes.includes(t));
				for (let ti = 0; ti < matchingPermTypes.length; ti++) {
					const permType = matchingPermTypes[ti];
					const slotKey = `${abTag}:type:${permType}`;
					if (isSlotUsed(actor, slotKey)) continue;
					const suffix =
						matchingPermTypes.length > 1 ? `${sourceName} — ${permType}` : sourceName;
					out.push({
						id: `${idPrefix}${fromZone}:slot:${slotKey}`,
						label: isMultiFace
							? `Cast ${faceName} from ${zoneLabel} (${suffix})`
							: `Cast from ${zoneLabel} (${suffix})`,
						costDisplay: `${faceManaCost || '{0}'}${taxSuffix}`,
						fromZone,
						permission: zonePermission,
						...faceIndexProp,
						baseCost,
						...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
						...optionalProp,
						...paymentAidsProp,
						timing: 'default',
						spellMods: { ...adventureMods, ...extraMods },
						choosesX,
						requiresTarget,
						staticPlaySlotKey: slotKey
					});
				}
			}
		}
	}

	return out;
}

// ---- 7. Static Damage Prevention & Phantom Counter Removal (CR 615.1, 615.5–6, 615.10, 615.12)

export interface StaticDamagePreventionContext {
	amount: number;
	isCombat: boolean;
	targetKind: 'permanent' | 'player';
	targetPerm?: CardInstance;
	targetPlayerId?: string;
	sourceInstanceId?: string;
	sourceInfo?: { card?: ScryfallCard; controllerId?: string };
}

function findBattlefieldPermById(state: GameState, instanceId: string | undefined): CardInstance | undefined {
	if (!instanceId) return undefined;
	for (let pi = 0; pi < state.players.length; pi++) {
		const bf = state.players[pi].battlefield;
		for (let bi = 0; bi < bf.length; bi++) {
			const c = bf[bi];
			if (!c.phasedOut && c.instanceId === instanceId) return c;
		}
	}
	return undefined;
}

function findStackOrOffboardSourceProxy(
	state: GameState,
	sourceInstanceId: string | undefined,
	sourceInfo: { card?: ScryfallCard; controllerId?: string } | undefined
): CardInstance | undefined {
	if (sourceInstanceId) {
		for (let si = 0; si < state.stack.length; si++) {
			const s = state.stack[si];
			if (s.sourceInstanceId === sourceInstanceId || s.id === sourceInstanceId) {
				return {
					instanceId: s.sourceInstanceId,
					objectVersion: s.sourceObjectVersion ?? 1,
					card: s.card,
					ownerId: s.ownerId ?? s.controllerId,
					controllerId: s.controllerId,
					zone: 'stack',
					tapped: false,
					summoningSick: false,
					counters: {} as Record<CounterType, number>,
					damageMarked: 0,
					deathtouchDamageMarked: false,
					tempPowerMod: 0,
					tempToughnessMod: 0,
					grantedKeywords: [],
					attachedToId: null,
					isCommander: false,
					commanderCastCount: 0,
					usedLoyaltyThisTurn: false,
					transformed: false,
					isToken: false
				};
			}
		}
		for (let pi = 0; pi < state.players.length; pi++) {
			const p = state.players[pi];
			for (const z of ['graveyard', 'exile', 'hand', 'command'] as const) {
				const hit = p[z].find((c) => c.instanceId === sourceInstanceId);
				if (hit) return hit;
			}
		}
	}
	if (sourceInfo?.card) {
		return {
			instanceId: sourceInstanceId ?? 'lki_src',
			objectVersion: 1,
			card: sourceInfo.card,
			ownerId: sourceInfo.controllerId ?? '',
			controllerId: sourceInfo.controllerId ?? '',
			zone: 'stack',
			tapped: false,
			summoningSick: false,
			counters: {} as Record<CounterType, number>,
			damageMarked: 0,
			deathtouchDamageMarked: false,
			tempPowerMod: 0,
			tempToughnessMod: 0,
			grantedKeywords: [],
			attachedToId: null,
			isCommander: false,
			commanderCastCount: 0,
			usedLoyaltyThisTurn: false,
			transformed: false,
			isToken: false
		};
	}
	return undefined;
}

function areInBlockingPair(state: GameState, permAId: string, permBId: string): boolean {
	const attackers = state.combat.attackers;
	for (let i = 0; i < attackers.length; i++) {
		const a = attackers[i];
		if (a.attackerInstanceId === permAId && a.blockerInstanceIds.includes(permBId)) return true;
		if (a.attackerInstanceId === permBId && a.blockerInstanceIds.includes(permAId)) return true;
	}
	return false;
}

function doesSourceMatchPreventionFilter(
	state: GameState,
	sourceFilter:
		| ObjectFilter
		| 'blockingOrBlockedBySelf'
		| 'blockingSelf'
		| 'blockedBySelf',
	staticPerm: CardInstance,
	controllerId: string,
	opts: StaticDamagePreventionContext
): boolean {
	const bfSrc = findBattlefieldPermById(state, opts.sourceInstanceId);
	if (sourceFilter === 'blockingOrBlockedBySelf') {
		if (!opts.sourceInstanceId) return false;
		return areInBlockingPair(state, staticPerm.instanceId, opts.sourceInstanceId);
	}
	if (sourceFilter === 'blockingSelf') {
		if (!opts.sourceInstanceId) return false;
		return state.combat.attackers.some(
			(a) =>
				a.attackerInstanceId === staticPerm.instanceId &&
				a.blockerInstanceIds.includes(opts.sourceInstanceId!)
		);
	}
	if (sourceFilter === 'blockedBySelf') {
		if (!opts.sourceInstanceId) return false;
		return state.combat.attackers.some(
			(a) =>
				a.attackerInstanceId === opts.sourceInstanceId &&
				a.blockerInstanceIds.includes(staticPerm.instanceId)
		);
	}
	const fctx: FilterContext = { state, controllerId, source: staticPerm };
	if (bfSrc) {
		return matchesObjectFilter(bfSrc, sourceFilter, fctx);
	}
	const proxy = findStackOrOffboardSourceProxy(state, opts.sourceInstanceId, opts.sourceInfo);
	if (proxy) {
		return matchesObjectFilter(proxy, sourceFilter, fctx);
	}
	return false;
}

/**
 * Applies active `staticDamagePrevention` effects (including Phantom / Polukranos counter removal)
 * to `opts.amount`, returning the remaining unprevented damage (`>= 0`).
 *
 * Respects `CR 615.10` (`unpreventable` skips damage prevention) and `CR 615.12` (Phantom /
 * Polukranos counter removal still executes even when damage can't be prevented).
 */
export function applyStaticDamagePreventionWave5(
	state: GameState,
	opts: StaticDamagePreventionContext,
	unpreventable: boolean
): number {
	let rem = opts.amount;
	if (rem <= 0) return 0;

	const bfSource = findBattlefieldPermById(state, opts.sourceInstanceId);

	forEachActiveStaticOnBattlefield(
		state,
		(staticPerm, controllerId, _sourceName, rawDef) => {
			if (rawDef.k !== 'staticDamagePrevention') return;
			const def = rawDef;
			if (rem <= 0) return;
			if (def.combatOnly && !opts.isCombat) return;
			if (def.noncombatOnly && opts.isCombat) return;

			// If damage can't be prevented (CR 615.10), pure prevention statics do nothing,
			// EXCEPT self-Phantom effects that also remove counters (CR 615.12).
			if (unpreventable && !def.phantomCounterRemoval) return;

			const fctx: FilterContext = { state, controllerId, source: staticPerm };
			if (def.condition && !evaluateCondition(def.condition, fctx)) return;

			// 1. Check dealtByOnly / target matching
			let matchesEvent = false;
			if (def.dealtByOnly === 'self') {
				matchesEvent = opts.sourceInstanceId === staticPerm.instanceId;
				if (matchesEvent && def.dealtByTargetFilter) {
					matchesEvent =
						opts.targetKind === 'permanent' &&
						opts.targetPerm !== undefined &&
						matchesObjectFilter(opts.targetPerm, def.dealtByTargetFilter, fctx);
				}
				if (matchesEvent && typeof def.target === 'object' && 'filter' in def.target) {
					matchesEvent =
						opts.targetKind === 'permanent' &&
						opts.targetPerm !== undefined &&
						matchesObjectFilter(opts.targetPerm, { ...def.target.filter, zone: 'battlefield' }, fctx);
				}
			} else if (def.dealtByOnly === 'attachedTo') {
				matchesEvent =
					Boolean(staticPerm.attachedToId) && opts.sourceInstanceId === staticPerm.attachedToId;
				if (matchesEvent && def.dealtByTargetFilter) {
					matchesEvent =
						opts.targetKind === 'permanent' &&
						opts.targetPerm !== undefined &&
						matchesObjectFilter(opts.targetPerm, def.dealtByTargetFilter, fctx);
				}
			} else {
				if (def.target === 'self') {
					matchesEvent =
						(opts.targetKind === 'permanent' &&
							opts.targetPerm?.instanceId === staticPerm.instanceId) ||
						(Boolean(def.alsoPreventDealtBy) &&
							opts.sourceInstanceId === staticPerm.instanceId);
				} else if (def.target === 'attachedTo') {
					const hostId = staticPerm.attachedToId;
					matchesEvent =
						Boolean(hostId) &&
						((opts.targetKind === 'permanent' && opts.targetPerm?.instanceId === hostId) ||
							(Boolean(def.alsoPreventDealtBy) && opts.sourceInstanceId === hostId));
				} else if (def.target === 'you') {
					matchesEvent =
						opts.targetKind === 'player' && opts.targetPlayerId === controllerId;
				} else if (def.target === 'youAndControlled') {
					matchesEvent =
						(opts.targetKind === 'player' && opts.targetPlayerId === controllerId) ||
						(opts.targetKind === 'permanent' &&
							opts.targetPerm !== undefined &&
							evaluatePermanent(state, opts.targetPerm).controllerId === controllerId);
				} else if (def.target === 'any') {
					matchesEvent = true;
				} else if ('filter' in def.target) {
					matchesEvent =
						opts.targetKind === 'permanent' &&
						opts.targetPerm !== undefined &&
						matchesObjectFilter(opts.targetPerm, def.target.filter, fctx);
				}
			}
			if (!matchesEvent) return;

			// 2. Check optional damage source filter
			if (def.sourceFilter) {
				if (
					!doesSourceMatchPreventionFilter(
						state,
						def.sourceFilter,
						staticPerm,
						controllerId,
						opts
					)
				) {
					return;
				}
			}

			// 3. Handle Phantom / Polukranos counter-removal prevention (CR 615.12)
			if (def.phantomCounterRemoval && opts.targetPerm) {
				const { counter, mode, requireCounterPresent } = def.phantomCounterRemoval;
				const avail = opts.targetPerm.counters[counter] || 0;
				if (requireCounterPresent && avail <= 0) return;
				const toRemove = mode === 'thatMany' ? Math.min(avail, rem) : Math.min(avail, 1);
				if (toRemove > 0) {
					const nextCount = avail - toRemove;
					opts.targetPerm.counters[counter] = nextCount;
					noteLayerInputsChanged(state);
					if (opts.targetPerm.zone === 'battlefield' && !opts.targetPerm.phasedOut) {
						emitEvent(state, {
							kind: 'CounterRemoved',
							objectId: opts.targetPerm.instanceId,
							object: opts.targetPerm,
							counterType: counter,
							amount: toRemove,
							previousCount: avail,
							newCount: nextCount
						});
					}
				}
				if (!unpreventable) {
					const prevented =
						def.amount === 'all'
							? rem
							: def.amount === 'halfRoundedUp'
								? Math.ceil(rem / 2)
								: Math.min(rem, def.amount);
					rem = Math.max(0, rem - prevented);
				}
				return;
			}

			// 4. Standard static damage prevention
			if (!unpreventable) {
				const prevented =
					def.amount === 'all'
						? rem
						: def.amount === 'halfRoundedUp'
							? Math.ceil(rem / 2)
							: Math.min(rem, def.amount);
				rem = Math.max(0, rem - prevented);
				if (prevented > 0 && def.onPrevented) {
					handlePreventedDamageRiderWave9(
						state,
						staticPerm,
						controllerId,
						opts.targetKind,
						opts.targetPerm,
						prevented,
						def.onPrevented,
						{
							shuffleIntoLibrary: (s, perm) => {
								moveObject(s, perm, 'library', { from: 'anyBattlefield' });
								const owner = s.players.find((pl) => pl.playerId === perm.ownerId);
								if (owner) shuffleLibrary(s, owner);
							}
						}
					);
				}
			}
		},
		'staticDamagePrevention'
	);

	// Suppress unused-var warning on bfSource while keeping source lookup available if needed.
	void bfSource;
	return rem;
}

// ---- 8. Wave 5 Amount & ObjectFilter Evaluators ---------------------------------------------

function resolvePlayerIdForWave5(ref: PlayerRef | undefined, ctx: FilterContext): string | null {
	if (!ref || ref.k === 'you') return ctx.controllerId;
	if (ref.k === 'activePlayer') {
		return ctx.state.players[ctx.state.activePlayerIndex]?.playerId ?? null;
	}
	if (ref.k === 'defendingPlayer' && ctx.source) {
		const atk = ctx.state.combat.attackers.find(
			(a) => a.attackerInstanceId === ctx.source!.instanceId
		);
		return atk?.defenderPlayerId ?? null;
	}
	if (ref.k === 'controllerOf' && ref.of.k === 'self' && ctx.source) {
		return ctx.source.zone === 'battlefield'
			? evaluatePermanent(ctx.state, ctx.source).controllerId
			: (ctx.source.controllerId || ctx.controllerId);
	}
	if (ref.k === 'controllerOf' && ref.of.k === 'attachedTo' && ctx.source?.attachedToId) {
		const host = findBattlefieldPermById(ctx.state, ctx.source.attachedToId);
		return host ? evaluatePermanent(ctx.state, host).controllerId : null;
	}
	if (ref.k === 'ownerOf' && ref.of.k === 'self' && ctx.source) {
		return ctx.source.ownerId;
	}
	return ctx.controllerId;
}

function getObjectEvaluatedName(state: GameState, inst: CardInstance | undefined): string {
	if (!inst || inst.isFaceDown) return '';
	if (inst.zone === 'battlefield') {
		return evaluatePermanent(state, inst).effectiveName;
	}
	return resolveObjectFaces(effectiveCardForObject(inst), instanceFaceOptions(inst, inst.zone)).name;
}

function getObjectEvaluatedColors(state: GameState, inst: CardInstance | undefined): ManaColor[] {
	if (!inst || inst.isFaceDown) return [];
	if (inst.zone === 'battlefield') {
		return evaluatePermanent(state, inst).colors;
	}
	return activeCharacteristics(effectiveCardForObject(inst), instanceFaceOptions(inst, inst.zone)).colors;
}

function getObjectStatForWave5(
	state: GameState,
	inst: CardInstance,
	stat: 'power' | 'toughness' | 'manaValue',
	_xValue = 0
): number {
	if (stat === 'manaValue') {
		return objectManaValue(state, inst);
	}
	if (inst.zone === 'battlefield') {
		const ev = evaluatePermanent(state, inst);
		return stat === 'power' ? ev.power : ev.toughness;
	}
	const chars = activeCharacteristics(effectiveCardForObject(inst), instanceFaceOptions(inst, inst.zone));
	const raw = stat === 'power' ? chars.power : chars.toughness;
	const parsed = raw !== undefined ? Number(raw) : 0;
	return Number.isFinite(parsed) ? parsed : 0;
}

function collectMatchingObjectsForWave5Filter(
	filter: ObjectFilter,
	ctx: FilterContext
): CardInstance[] {
	const zone = filter.zone ?? 'battlefield';
	const out: CardInstance[] = [];
	for (let pi = 0; pi < ctx.state.players.length; pi++) {
		const p = ctx.state.players[pi];
		if (p.lost) continue;
		if (zone === 'battlefield') {
			for (let bi = 0; bi < p.battlefield.length; bi++) {
				const c = p.battlefield[bi];
				if (!c.phasedOut && matchesObjectFilter(c, filter, ctx)) out.push(c);
			}
		} else if (
			zone === 'graveyard' ||
			zone === 'hand' ||
			zone === 'exile' ||
			zone === 'library' ||
			zone === 'command'
		) {
			const list = p[zone];
			for (let zi = 0; zi < list.length; zi++) {
				const c = list[zi];
				if (matchesObjectFilter(c, filter, ctx)) out.push(c);
			}
		}
	}
	return out;
}

export function evaluateWave5Amount(amount: Amount, ctx: FilterContext): number | null {
	switch (amount.k) {
		case 'devotion': {
			const pid = resolvePlayerIdForWave5(amount.player, ctx);
			return pid ? computeDevotionToColors(ctx.state, pid, amount.colors) : 0;
		}
		case 'targetsBeyondFirst': {
			const targets = (ctx.source as (CardInstance & { targets?: TargetRef[] }) | undefined)
				?.targets;
			return targets && targets.length > 1 ? targets.length - 1 : 0;
		}
		case 'colorsOfObject': {
			const targetObj =
				amount.of === 'attachedTo'
					? findBattlefieldPermById(ctx.state, ctx.source?.attachedToId ?? undefined)
					: ctx.source;
			return getObjectEvaluatedColors(ctx.state, targetObj).length;
		}
		case 'greatestStatAmong': {
			const matches = collectMatchingObjectsForWave5Filter(amount.filter, ctx);
			if (matches.length === 0) return 0;
			let best = 0;
			for (let i = 0; i < matches.length; i++) {
				const val = getObjectStatForWave5(ctx.state, matches[i], amount.stat, ctx.xValue ?? 0);
				if (val > best) best = val;
			}
			return best;
		}
		case 'totalStatOf': {
			const matches = collectMatchingObjectsForWave5Filter(amount.filter, ctx);
			let sum = 0;
			for (let i = 0; i < matches.length; i++) {
				sum += Math.max(
					0,
					getObjectStatForWave5(ctx.state, matches[i], amount.stat, ctx.xValue ?? 0)
				);
			}
			return sum;
		}
		case 'anyNumber':
			return 0;
		default:
			return null;
	}
}

export function matchesWave5ObjectFilter(
	inst: CardInstance,
	filter: ObjectFilter,
	ctx: FilterContext
): boolean {
	if (filter.sameNameAsSource) {
		const candName = getObjectEvaluatedName(ctx.state, inst);
		const srcName = getObjectEvaluatedName(ctx.state, ctx.source);
		if (!candName || !srcName || candName !== srcName) return false;
	}
	if (filter.castFromOutsideHand !== undefined) {
		const srcZone =
			(inst as CardInstance & { castSourceZone?: ZoneType }).castSourceZone ?? inst.zone;
		const outside = srcZone !== 'hand';
		if (outside !== filter.castFromOutsideHand) return false;
	}
	if (filter.castFromZone !== undefined) {
		const srcZone =
			(inst as CardInstance & { castSourceZone?: ZoneType }).castSourceZone ?? inst.zone;
		if (srcZone !== filter.castFromZone) return false;
	}
	if (filter.sharesColorWithSelf) {
		const candColors = getObjectEvaluatedColors(ctx.state, inst);
		const selfColors = getObjectEvaluatedColors(ctx.state, ctx.source);
		if (
			candColors.length === 0 ||
			selfColors.length === 0 ||
			!candColors.some((c) => selfColors.includes(c))
		) {
			return false;
		}
	}
	if (filter.hasAnyCounter !== undefined) {
		let total = 0;
		const keys = Object.keys(inst.counters) as CounterType[];
		for (let i = 0; i < keys.length; i++) {
			total += inst.counters[keys[i]] || 0;
		}
		if ((total > 0) !== filter.hasAnyCounter) return false;
	}
	if (filter.equipped !== undefined) {
		let isEq = false;
		if (inst.zone === 'battlefield' && !inst.phasedOut) {
			for (let pi = 0; pi < ctx.state.players.length && !isEq; pi++) {
				const pl = ctx.state.players[pi];
				if (pl.lost) continue;
				for (let bi = 0; bi < pl.battlefield.length; bi++) {
					const att = pl.battlefield[bi];
					if (att.phasedOut || att.attachedToId !== inst.instanceId) continue;
					const ev = evaluatePermanent(ctx.state, att);
					if (ev.isArtifact && ev.hasSubType('Equipment')) {
						isEq = true;
						break;
					}
				}
			}
		}
		if (isEq !== filter.equipped) return false;
	}
	if (filter.enchanted !== undefined) {
		let isEnch = false;
		if (inst.zone === 'battlefield' && !inst.phasedOut) {
			for (let pi = 0; pi < ctx.state.players.length && !isEnch; pi++) {
				const pl = ctx.state.players[pi];
				if (pl.lost) continue;
				for (let bi = 0; bi < pl.battlefield.length; bi++) {
					const att = pl.battlefield[bi];
					if (att.phasedOut || att.attachedToId !== inst.instanceId) continue;
					const ev = evaluatePermanent(ctx.state, att);
					if (ev.isEnchantment && ev.hasSubType('Aura')) {
						isEnch = true;
						break;
					}
				}
			}
		}
		if (isEnch !== filter.enchanted) return false;
	}
	return true;
}

function compareWave5Nums(left: number, op: Compare['op'], right: number): boolean {
	switch (op) {
		case '=':
			return left === right;
		case '>=':
			return left >= right;
		case '<=':
			return left <= right;
		case '>':
			return left > right;
		case '<':
			return left < right;
	}
}

export function evaluateWave5Condition(cond: Condition, ctx: FilterContext): boolean | null {
	switch (cond.k) {
		case 'anyOpponentMetric': {
			for (let i = 0; i < ctx.state.players.length; i++) {
				const p = ctx.state.players[i];
				if (p.lost || p.playerId === ctx.controllerId) continue;
				const val =
					cond.metric === 'life'
						? p.life
						: cond.metric === 'hand'
							? p.hand.length
							: p.graveyard.length;
				if (compareWave5Nums(val, cond.op, cond.count)) return true;
			}
			return false;
		}
		case 'cardsDrawnThisTurnAtLeast': {
			const p = ctx.state.players.find((pl) => pl.playerId === ctx.controllerId);
			return (p?.cardsDrawnThisTurn ?? 0) >= cond.min;
		}
		case 'nthMatchingSpellThisTurn': {
			const p = ctx.state.players.find((pl) => pl.playerId === ctx.controllerId);
			if (!p) return false;
			if (!cond.filter) {
				return (p.spellsCastThisTurn ?? 0) === cond.ordinal - 1;
			}
			const cards = p.spellsCastThisTurnCards ?? [];
			let count = 0;
			for (let ci = 0; ci < cards.length; ci++) {
				const card = cards[ci];
				const stub: CardInstance = {
					instanceId: 'cast-hist-w5',
					objectVersion: 1,
					card,
					ownerId: p.playerId,
					controllerId: p.playerId,
					zone: 'stack',
					tapped: false,
					summoningSick: false,
					damageMarked: 0,
					deathtouchDamageMarked: false,
					counters: { '+1/+1': 0, '-1/-1': 0, loyalty: 0, charge: 0 } as CardInstance['counters'],
					tempPowerMod: 0,
					tempToughnessMod: 0,
					grantedKeywords: [],
					attachedToId: null,
					isToken: false,
					isCommander: false,
					commanderCastCount: 0,
					usedLoyaltyThisTurn: false,
					transformed: false
				};
				if (matchesObjectFilter(stub, cond.filter, ctx)) {
					count += 1;
				}
			}
			return count === cond.ordinal - 1;
		}
		default:
			return null;
	}
}

// ---- 9. Behold & Waterbend Cost Helpers (CR 701.4a–b, 701.67a–b) ----------------------------

export function findBeholdCandidates(
	state: GameState,
	player: PlayerGameState,
	source: CardInstance,
	isSpell: boolean,
	filter: ObjectFilter,
	used: ReadonlySet<string>
): CardInstance[] {
	const fctx: FilterContext = { state, controllerId: player.playerId, source };
	const out: CardInstance[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < player.battlefield.length; i++) {
		const perm = player.battlefield[i];
		if (perm.phasedOut || used.has(perm.instanceId)) continue;
		if (isSpell && perm.instanceId === source.instanceId) continue;
		if (matchesObjectFilter(perm, { ...filter, controller: 'you' }, fctx)) {
			out.push(perm);
			seen.add(perm.instanceId);
		}
	}
	for (let i = 0; i < player.hand.length; i++) {
		const card = player.hand[i];
		if (used.has(card.instanceId) || seen.has(card.instanceId)) continue;
		if (isSpell && card.instanceId === source.instanceId) continue;
		if (matchesObjectFilter(card, filter, fctx)) {
			out.push(card);
			seen.add(card.instanceId);
		}
	}
	return out;
}

export function findWaterbendTapCandidates(
	state: GameState,
	player: PlayerGameState,
	source: CardInstance,
	isSpell: boolean,
	excludeIds: ReadonlySet<string>
): CardInstance[] {
	const out: CardInstance[] = [];
	for (let i = 0; i < player.battlefield.length; i++) {
		const perm = player.battlefield[i];
		if (perm.phasedOut || perm.tapped || excludeIds.has(perm.instanceId)) continue;
		if (isSpell && perm.instanceId === source.instanceId) continue;
		const ev = evaluatePermanent(state, perm);
		if (ev.isArtifact || ev.isCreature) {
			out.push(perm);
		}
	}
	return out;
}

export function addCountersForCostOnPermanent(
	state: GameState,
	perm: CardInstance,
	counter: CounterType,
	amount: number
): void {
	if (amount <= 0) return;
	const prev = perm.counters[counter] || 0;
	const next = prev + amount;
	perm.counters[counter] = next;
	const ts = (state.nextTimestamp ?? 1);
	state.nextTimestamp = ts + 1;
	(perm.counterTimestamps ??= {})[counter] = ts;
	noteLayerInputsChanged(state);
	if (perm.zone === 'battlefield' && !perm.phasedOut) {
		emitEvent(state, {
			kind: 'CounterPlaced',
			objectId: perm.instanceId,
			object: perm,
			counterType: counter,
			amount,
			previousCount: prev,
			newCount: next
		});
	}
}

export { splitSubtypes };
