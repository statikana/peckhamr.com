/**
 * Runtime helpers, Aura graveyard/complex filter legality, Trample over planeswalkers,
 * Suspend X, Craft shared-card-type validation, Panglacial library-search casting,
 * Space Beleren sectors, and Wave 7 override resolution handlers (Track P21).
 *
 * Pure IR and GameState metadata only — zero card-name literal comparisons,
 * zero runtime printed-text reads, and zero direct zone array mutations.
 */
import { compileCard } from '../compiler/index.ts';
import type {
	KeywordDef,
	ObjectFilter,
	TargetSpec
} from '../ir.ts';
import { withStackItemText } from '../oracle.ts';
import { effectiveCardForObject, makeInherentAbilityCard } from '../scryfall.ts';
import {
	createEmptyCounterMap,
	type CardInstance,
	type CastOption,
	type CounterType,
	type GameState,
	type PlayerGameState,
	type ScryfallCard,
	type SpellModifications,
	type StackItem,
	type TargetRef
} from '../types.ts';
import { enqueueChoicePrompt, registerPromptHandler } from './choices.ts';
import { emitEvent } from './events.ts';
import {
	activeAbilityDefs,
	instanceFaceOptions,
	resolveObjectFaces
} from './faces.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { evaluatePermanent, type EvaluatedPermanent } from './layers.ts';
import type { FilterContext } from './objectFilter.ts';
import { attachObject, moveObject, shuffleLibrary } from './zones.ts';

export type Wave7EffectTag =
	| 'spellweaverVolute'
	| 'spaceSectorLock'
	| 'spaceSectorCounters'
	| 'spaceSectorDestroy'
	| 'necromancyFlashCleanup'
	| 'sacrificeSelfCleanup'
	| 'timetwister';

export interface Wave7Host {
	uid: (prefix: string, state: GameState) => string;
	addLog: (
		state: GameState,
		kind: 'rule' | 'cast' | 'combat' | 'trigger' | 'life' | 'sba' | 'system',
		message: string,
		playerId?: string
	) => void;
	drawCards: (state: GameState, player: PlayerGameState, count: number) => void;
	addCountersToPermanent: (
		state: GameState,
		perm: CardInstance,
		counter: CounterType,
		amount: number
	) => void;
	hasKeyword: (perm: CardInstance, keyword: string, state: GameState) => boolean;
	matchesObjectFilter: (obj: CardInstance, filter: ObjectFilter, ctx: FilterContext) => boolean;
	resumeStackItem: (state: GameState, stackItemId: string) => void;
	flushTriggers: (state: GameState) => void;
	checkStateBasedActions: (state: GameState) => void;
}

let registeredHost: Wave7Host | null = null;

export function registerWave7Host(host: Wave7Host): void {
	registeredHost = host;
}

function getHost(): Wave7Host {
	if (!registeredHost) {
		throw new Error('Wave7Host has not been registered.');
	}
	return registeredHost;
}

// ============================================================================
// 1. Trample over planeswalkers (CR 702.19c–f)
// ============================================================================

export function getTrampleCapabilities(
	perm: CardInstance,
	state: GameState,
	hasKw: (p: CardInstance, kw: string, s: GameState) => boolean
): { hasTrample: boolean; hasTrampleOverPlaneswalkers: boolean } {
	const hasTrampleOverPlaneswalkers = hasKw(perm, 'Trample over planeswalkers', state);
	const hasTrample = hasKw(perm, 'Trample', state) || hasTrampleOverPlaneswalkers;
	return { hasTrample, hasTrampleOverPlaneswalkers };
}

/**
 * CR 702.19c–f: Computes combat damage split between a planeswalker and its controller
 * when an attacking creature has `Trample over planeswalkers` (including `CR 702.19e`
 * carry-over to the defending player when the attacked planeswalker was removed from combat).
 */
export function computePlaneswalkerTrampleSplit(opts: {
	remainingDamage: number;
	defWalker: CardInstance | undefined;
	attackingPlaneswalker: boolean;
	hasTrampleOverPlaneswalkers: boolean;
	assignedDamageOnPlaneswalker: Map<string, number>;
}): { pwDamage: number; playerDamage: number } | null {
	const {
		remainingDamage,
		defWalker,
		attackingPlaneswalker,
		hasTrampleOverPlaneswalkers,
		assignedDamageOnPlaneswalker
	} = opts;
	if (remainingDamage <= 0) return null;

	if (defWalker) {
		const alreadyAssigned = assignedDamageOnPlaneswalker.get(defWalker.instanceId) ?? 0;
		if (!hasTrampleOverPlaneswalkers) {
			assignedDamageOnPlaneswalker.set(defWalker.instanceId, alreadyAssigned + remainingDamage);
			return { pwDamage: remainingDamage, playerDamage: 0 };
		}
		const loyalty = Math.max(0, defWalker.counters.loyalty ?? 0);
		const neededForPw = Math.max(0, loyalty - alreadyAssigned);
		const pwDamage = Math.min(remainingDamage, neededForPw);
		const playerDamage = Math.max(0, remainingDamage - pwDamage);
		assignedDamageOnPlaneswalker.set(defWalker.instanceId, alreadyAssigned + pwDamage);
		return { pwDamage, playerDamage };
	}

	// CR 702.19e: Attacked planeswalker left combat -> damage carries over to defending player.
	if (attackingPlaneswalker && hasTrampleOverPlaneswalkers) {
		return { pwDamage: 0, playerDamage: remainingDamage };
	}

	return null;
}

// ============================================================================
// 2. ObjectFilter P21 Extensions (`hasAnotherAuraAttached`, `attachedToRef`)
// ============================================================================

export function matchesP21ObjectFilter(
	obj: CardInstance,
	filter: ObjectFilter,
	ctx: FilterContext
): boolean {
	if (filter.hasAnotherAuraAttached !== undefined) {
		const onBattlefield = obj.zone === 'battlefield' && !obj.phasedOut;
		let foundOtherAura = false;
		if (onBattlefield) {
			const excludeId = ctx.source?.instanceId;
			for (const p of ctx.state.players) {
				if (p.lost) continue;
				for (const perm of p.battlefield) {
					if (perm.phasedOut) continue;
					if (perm.instanceId === excludeId) continue;
					if (perm.attachedToId !== obj.instanceId) continue;
					if (evaluatePermanent(ctx.state, perm).hasSubType('Aura')) {
						foundOtherAura = true;
						break;
					}
				}
				if (foundOtherAura) break;
			}
		}
		if (foundOtherAura !== filter.hasAnotherAuraAttached) return false;
	}
	return true;
}

// ============================================================================
// 3. Graveyard & Complex `Enchant [filter]` Aura Legality (CR 303.4, 702.5a, 704.5m)
// ============================================================================

export function getAuraEnchantKeywordDefs(
	aura: CardInstance,
	evalAura?: EvaluatedPermanent
): KeywordDef[] {
	if (evalAura?.losesAllAbilities) return [];
	const out: KeywordDef[] = [];
	const faceZone = aura.zone === 'battlefield' ? 'battlefield' : aura.zone;
	for (const ab of activeAbilityDefs(
		effectiveCardForObject(aura),
		instanceFaceOptions(aura, faceZone)
	)) {
		if (ab.kind === 'keyword' && ab.keyword.name.toLowerCase() === 'enchant') {
			out.push(ab.keyword);
		}
	}
	return out;
}

export function isGraveyardOrReanimatingAura(state: GameState, obj: CardInstance): boolean {
	const evalObj = obj.zone === 'battlefield' ? evaluatePermanent(state, obj) : undefined;
	const kws = getAuraEnchantKeywordDefs(obj, evalObj);
	if (kws.some((k) => k.enchantFilter?.zone === 'graveyard')) return true;
	// Animated Aura without a printed `enchant` keyword (e.g. Necromancy becoming an Aura on ETB).
	if (evalObj && evalObj.hasSubType('Aura') && kws.length === 0) return true;
	return false;
}

/**
 * Evaluates P21 Aura attachment legality onto a battlefield permanent `host`.
 * Returns `'legal'`, `'illegal'`, or `'defer'` (use standard string-based `enchantParams` check).
 */
export function checkP21AuraPermanentAttachment(
	state: GameState,
	aura: CardInstance,
	auraController: PlayerGameState,
	evalAura: EvaluatedPermanent,
	host: CardInstance,
	matchesFilterFn: (obj: CardInstance, filter: ObjectFilter, ctx: FilterContext) => boolean
): 'legal' | 'illegal' | 'defer' {
	// Dynamic transition: "enchant creature put onto the battlefield with ~"
	if (aura.auraReanimatedHostId !== undefined) {
		if (evalAura.losesAllAbilities) return 'illegal';
		if (host.zone !== 'battlefield' || host.phasedOut) return 'illegal';
		const evalHost = evaluatePermanent(state, host);
		if (!evalHost.isCreature) return 'illegal';
		const link = host.reanimatedByAura;
		if (
			!link ||
			link.sourceInstanceId !== aura.instanceId ||
			link.sourceObjectVersion !== (aura.objectVersion ?? 1)
		) {
			return 'illegal';
		}
		return 'legal';
	}

	const kws = getAuraEnchantKeywordDefs(aura, evalAura);
	const filterKws = kws.filter((k) => k.enchantFilter !== undefined);
	if (filterKws.length === 0) return 'defer';

	for (const kw of filterKws) {
		const ef = kw.enchantFilter!;
		// While still carrying `zone: 'graveyard'`, cannot legally enchant a battlefield permanent.
		if (ef.zone === 'graveyard') return 'illegal';
		if (
			!matchesFilterFn(host, ef, {
				state,
				controllerId: auraController.playerId,
				source: aura
			})
		) {
			return 'illegal';
		}
	}
	return 'legal';
}

/**
 * CR 303.4 / CR 704.5m: Checks whether `aura` on the battlefield is legally enchanting
 * a card in a graveyard (`aura.attachedToId`).
 */
export function isAuraGraveyardAttachmentLegal(
	state: GameState,
	aura: CardInstance,
	auraController: PlayerGameState,
	evalAura: EvaluatedPermanent,
	matchesFilterFn: (obj: CardInstance, filter: ObjectFilter, ctx: FilterContext) => boolean
): boolean {
	if (!aura.attachedToId) return false;
	if (aura.auraReanimatedHostId !== undefined) return false;
	if (evalAura.isCreature || evalAura.losesAllAbilities) return false;

	const kws = getAuraEnchantKeywordDefs(aura, evalAura);
	if (kws.length === 0) return false;
	if (!kws.every((k) => k.enchantFilter?.zone === 'graveyard')) return false;

	let gyCard: CardInstance | undefined;
	for (const p of state.players) {
		if (p.lost) continue;
		const found = p.graveyard.find((c) => c.instanceId === aura.attachedToId);
		if (found) {
			gyCard = found;
			break;
		}
	}
	if (!gyCard) return false;

	return kws.every((kw) =>
		matchesFilterFn(gyCard!, kw.enchantFilter!, {
			state,
			controllerId: auraController.playerId,
			source: aura
		})
	);
}

/**
 * CR 303.4f: Collects legal graveyard card ids for a graveyard-enchanting Aura entering
 * the battlefield without being cast.
 */
export function collectGraveyardAuraAttachCandidates(
	state: GameState,
	aura: CardInstance,
	controller: PlayerGameState,
	matchesFilterFn: (obj: CardInstance, filter: ObjectFilter, ctx: FilterContext) => boolean
): string[] {
	const kws = getAuraEnchantKeywordDefs(aura);
	if (kws.length === 0 || !kws.every((k) => k.enchantFilter?.zone === 'graveyard')) {
		return [];
	}
	const ids: string[] = [];
	for (const p of state.players) {
		if (p.lost) continue;
		for (const c of p.graveyard) {
			if (
				kws.every((kw) =>
					matchesFilterFn(c, kw.enchantFilter!, {
						state,
						controllerId: controller.playerId,
						source: aura
					})
				)
			) {
				ids.push(c.instanceId);
			}
		}
	}
	return ids;
}

// ============================================================================
// 4. Suspend X (CR 702.62a — "Suspend X—{cost}. X can't be 0.")
// ============================================================================

export function getSuspendXSpec(card: ScryfallCard): { suspendCost: string } | null {
	for (const ab of activeAbilityDefs(card, { zone: 'hand', faceIndex: 0 })) {
		if (
			ab.kind === 'keyword' &&
			ab.keyword.name.toLowerCase() === 'suspend' &&
			ab.keyword.suspendX &&
			ab.keyword.cost
		) {
			return { suspendCost: ab.keyword.cost };
		}
	}
	return null;
}

export function substituteSuspendXManaCost(rawCost: string, xVal: number): string {
	return rawCost.replace(/\{X\}/gi, `{${Math.max(1, Math.floor(xVal))}}`);
}

// ============================================================================
// 5. Craft with two that share a card type (CR 702.167 — Eye of Ojer Taq)
// ============================================================================

const CORE_CARD_TYPES = [
	'Artifact',
	'Battle',
	'Creature',
	'Enchantment',
	'Instant',
	'Kindred',
	'Land',
	'Planeswalker',
	'Sorcery'
] as const;

function getCandidateCardTypes(state: GameState, cand: CardInstance): string[] {
	if (cand.zone === 'battlefield' && !cand.phasedOut) {
		const ev = evaluatePermanent(state, cand);
		return CORE_CARD_TYPES.filter((t) => ev.typeLine.includes(t));
	}
	const view = resolveObjectFaces(
		effectiveCardForObject(cand),
		instanceFaceOptions(cand, cand.zone)
	);
	return CORE_CARD_TYPES.filter((t) => view.types.includes(t));
}

/**
 * Returns `'not_applicable'` if `perm`'s Craft ability does not set `craftShareCardType`,
 * `[idA, idB]` if two distinct materials in `actor.graveyard ∪ actor.battlefield` share a card type,
 * or `null` if no legal pair exists.
 */
export function selectCraftShareCardTypeMaterials(
	state: GameState,
	actor: PlayerGameState,
	perm: CardInstance,
	preferredIds?: readonly string[]
): 'not_applicable' | [string, string] | null {
	let hasShareCardType = false;
	for (const ab of activeAbilityDefs(
		effectiveCardForObject(perm),
		instanceFaceOptions(perm, perm.zone === 'battlefield' ? 'battlefield' : perm.zone)
	)) {
		if (
			ab.kind === 'keyword' &&
			ab.keyword.name.toLowerCase() === 'craft' &&
			ab.keyword.craftShareCardType
		) {
			hasShareCardType = true;
			break;
		}
	}
	if (!hasShareCardType) return 'not_applicable';

	const pool: CardInstance[] = [
		...actor.graveyard,
		...actor.battlefield.filter((b) => b.instanceId !== perm.instanceId && !b.phasedOut)
	];
	if (pool.length < 2) return null;

	// If explicit material ids were supplied, verify those exact two distinct candidates share a type.
	if (preferredIds && preferredIds.length >= 2) {
		const first = pool.find((c) => c.instanceId === preferredIds[0]);
		const second = pool.find(
			(c) => c.instanceId === preferredIds[1] && c.instanceId !== preferredIds[0]
		);
		if (!first || !second) return null;
		const typesA = getCandidateCardTypes(state, first);
		const typesB = getCandidateCardTypes(state, second);
		return typesA.some((t) => typesB.includes(t))
			? [first.instanceId, second.instanceId]
			: null;
	}

	const typedPool = pool.map((cand) => ({
		id: cand.instanceId,
		types: getCandidateCardTypes(state, cand)
	}));
	for (let i = 0; i < typedPool.length; i++) {
		const a = typedPool[i];
		if (a.types.length === 0) continue;
		for (let j = i + 1; j < typedPool.length; j++) {
			const b = typedPool[j];
			if (a.types.some((t) => b.types.includes(t))) {
				return [a.id, b.id];
			}
		}
	}
	return null;
}

// ============================================================================
// 6. Panglacial Wurm — Cast from Library While Searching (CR 601.3e, 701.23g)
// ============================================================================

export function isPlayerSearchingOwnLibrary(state: GameState, playerId: string): boolean {
	return state.pendingPrompts.some(
		(pr) =>
			pr.playerId === playerId &&
			(pr.purpose === 'search_library' ||
				pr.kind === 'search_library' ||
				(pr.choice?.kind === 'chooseObjects' && pr.choice.zone === 'library')) &&
			(pr.targetLibraryOwnerId || pr.playerId) === playerId
	);
}

export function cardHasCastFromLibraryWhileSearching(
	inst: CardInstance,
	faceIndex = 0
): boolean {
	const card = effectiveCardForObject(inst);
	for (const ab of activeAbilityDefs(card, { zone: 'library', faceIndex })) {
		if (ab.kind === 'static' && ab.static.k === 'castFromLibraryWhileSearching') {
			return true;
		}
	}
	return false;
}

export function findCastWhileSearchingLibraryCard(
	state: GameState,
	actor: PlayerGameState,
	instanceId: string
): CardInstance | undefined {
	if (!isPlayerSearchingOwnLibrary(state, actor.playerId)) return undefined;
	const found = actor.library.find((c) => c.instanceId === instanceId);
	if (!found) return undefined;
	return cardHasCastFromLibraryWhileSearching(found, 0) ? found : undefined;
}

export function collectWave7LibrarySearchCastOptions(opts: {
	state: GameState;
	actorId: string;
	inst: CardInstance;
	faceIndex: number;
	isMultiFace: boolean;
	faceName: string;
	faceManaCost: string;
	taxSuffix: string;
	mandatoryAdditionalCosts?: CastOption['mandatoryAdditionalCosts'];
	optionalAdditionalCosts?: CastOption['optionalAdditionalCosts'];
	paymentAids?: CastOption['paymentAids'];
	adventureMods?: SpellModifications;
	requiresTarget: boolean;
	choosesX: boolean;
}): CastOption[] {
	const {
		state,
		actorId,
		inst,
		faceIndex,
		isMultiFace,
		faceName,
		faceManaCost,
		taxSuffix,
		mandatoryAdditionalCosts,
		optionalAdditionalCosts,
		paymentAids,
		adventureMods,
		requiresTarget,
		choosesX
	} = opts;
	if (!isPlayerSearchingOwnLibrary(state, actorId)) return [];
	if (!cardHasCastFromLibraryWhileSearching(inst, faceIndex)) return [];

	const id = isMultiFace
		? `library:while-searching:face:${faceIndex}`
		: 'library:while-searching';
	return [
		{
			id,
			label: isMultiFace
				? `Cast ${faceName} from Library while Searching`
				: 'Cast from Library while Searching',
			costDisplay: `${faceManaCost || '{0}'}${taxSuffix}`,
			fromZone: 'library',
			permission: 'library_top_permission',
			...(isMultiFace ? { faceIndex } : {}),
			baseCost: { kind: 'printed' },
			...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
			...(optionalAdditionalCosts?.length ? { optionalAdditionalCosts } : {}),
			...(paymentAids?.length ? { paymentAids } : {}),
			timing: 'instant_only',
			spellMods: { ...(adventureMods ?? {}) },
			choosesX,
			requiresTarget
		}
	];
}

/**
 * Removes a card that was just cast out of a library mid-search from any active
 * `search_library` prompt candidate lists so the search prompt remains consistent.
 */
export function pruneCastCardFromActiveLibrarySearchPrompts(
	state: GameState,
	castInstanceId: string
): void {
	for (const pr of state.pendingPrompts) {
		if (pr.candidateInstanceIds) {
			pr.candidateInstanceIds = pr.candidateInstanceIds.filter((id) => id !== castInstanceId);
		}
		if (pr.choice?.kind === 'chooseObjects' && pr.choice.zone === 'library') {
			pr.choice.candidates = pr.choice.candidates.filter((id) => id !== castInstanceId);
		}
	}
}

// ============================================================================
// 7. Space Beleren — Sectors (`alpha`, `beta`, `gamma`) & Combat Lock
// ============================================================================

const SPACE_SECTORS = ['alpha', 'beta', 'gamma'] as const;
type SpaceSector = (typeof SPACE_SECTORS)[number];

export function boardHasSpaceSculptor(state: GameState): {
	active: boolean;
	controllerId: string | null;
} {
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			const ev = evaluatePermanent(state, perm);
			if (ev.losesAllAbilities) continue;
			for (const ab of activeAbilityDefs(
				effectiveCardForObject(perm),
				instanceFaceOptions(perm, 'battlefield')
			)) {
				if (ab.kind === 'static' && ab.static.k === 'spaceSculptorSectors') {
					return { active: true, controllerId: p.playerId };
				}
			}
		}
	}
	return { active: false, controllerId: null };
}

/**
 * Assigns sectors to any unassigned creatures while a `spaceSculptorSectors` permanent
 * is on the battlefield ("Opponents assign first"). Bots assign deterministically;
 * human controllers receive a `chooseMode` prompt if no sector prompt is already pending.
 */
export function ensureSpaceSculptorSectors(state: GameState): void {
	const sculptor = boardHasSpaceSculptor(state);
	if (!sculptor.active) return;

	const alreadyPrompting = state.pendingPrompts.some((pr) => {
		const cont = pr.continuation;
		if (cont?.kind !== 'handler') return false;
		const handlerId = cont.name;
		return handlerId === 'p21_space_sector_assign';
	});
	if (alreadyPrompting) return;

	// Order players: opponents of Space Sculptor's controller in APNAP order first, then controller.
	const orderedPlayers: PlayerGameState[] = [];
	const totalPlayers = state.players.length;
	for (let offset = 0; offset < totalPlayers; offset++) {
		const p = state.players[(state.activePlayerIndex + offset) % totalPlayers];
		if (!p.lost && p.playerId !== sculptor.controllerId) {
			orderedPlayers.push(p);
		}
	}
	const ctrlPlayer = state.players.find(
		(p) => !p.lost && p.playerId === sculptor.controllerId
	);
	if (ctrlPlayer) orderedPlayers.push(ctrlPlayer);

	for (const p of orderedPlayers) {
		for (const perm of p.battlefield) {
			if (perm.phasedOut || perm.spaceSector) continue;
			if (!evaluatePermanent(state, perm).isCreature) continue;
			if (p.isBot) {
				perm.spaceSector = 'alpha';
				continue;
			}
			const host = getHost();
			enqueueChoicePrompt(state, {
				id: host.uid('prm', state),
				playerId: p.playerId,
				kind: 'chooseMode',
				purpose: 'generic',
				title: `Assign Sector — ${perm.card.name}`,
				description: `Choose a sector (alpha, beta, or gamma) for ${perm.card.name}.`,
				continuation: {
					kind: 'handler',
					name: 'p21_space_sector_assign',
					data: {
						permId: perm.instanceId,
						permVersion: perm.objectVersion ?? 1
					}
				},
				choice: {
					kind: 'chooseMode',
					modes: ['alpha', 'beta', 'gamma'],
					min: 1,
					max: 1,
					defaultIndices: [0]
				}
			});
			return;
		}
	}
}

export function isSpaceSectorBlockIllegal(
	state: GameState,
	attacker: CardInstance,
	blocker: CardInstance
): boolean {
	const currentSerial = state.turnSerial ?? state.turnNumber;
	if (state.spaceSectorBlockLockTurnSerial !== currentSerial) return false;
	if (!attacker.spaceSector) return false;
	return blocker.spaceSector !== attacker.spaceSector;
}

// ============================================================================
// 8. Necromancy Cleanup Sacrifice Trigger Enqueue (CR 514.3a)
// ============================================================================

export function enqueueP21CleanupDelayedTriggers(state: GameState): void {
	const host = getHost();
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut || !perm.sacrificeAtNextCleanupStep) continue;
			perm.sacrificeAtNextCleanupStep = false;
			const trigCard = makeInherentAbilityCard(
				`__p21_cleanup_sac_${perm.instanceId}`,
				perm.card.name,
				'Sacrifice this permanent at the beginning of the cleanup step.'
			);
			const stackItem: StackItem = withStackItemText(
				{
					id: host.uid('stk', state),
					sourceInstanceId: perm.instanceId,
					sourceObjectVersion: perm.objectVersion ?? 1,
					card: trigCard,
					ownerId: perm.ownerId,
					controllerId: p.playerId,
					kind: 'triggered',
					title: `${perm.card.name} — Cleanup Sacrifice`,
					targets: [],
					xValue: 0,
					createdAt: state.turnNumber,
					wave5Tag: 'p21:sacrificeSelfCleanup'
				},
				trigCard
			);
			state.stack.push(stackItem);
			host.addLog(
				state,
				'trigger',
				`${perm.card.name}'s delayed cleanup sacrifice ability triggers.`,
				p.playerId
			);
		}
	}
}

// ============================================================================
// 9. Wave 7 Custom Effect Dispatcher (`resolveWave7Effect`)
// ============================================================================

function findLegalTargetForInstantCopy(
	state: GameState,
	controller: PlayerGameState,
	card: ScryfallCard
): { ok: true; targets: TargetRef[]; targetsBySpec?: TargetRef[][] } | { ok: false } {
	const def = compileCard(card);
	const spellAb = def.faces[0]?.abilities.find((a) => a.kind === 'spell');
	const specs: TargetSpec[] = spellAb?.kind === 'spell' ? spellAb.targets : [];
	if (specs.length === 0) {
		return { ok: true, targets: [] };
	}
	const host = getHost();
	const chosen: TargetRef[] = [];
	const bySpec: TargetRef[][] = [];
	for (const sp of specs) {
		if (sp.min <= 0) {
			bySpec.push([]);
			continue;
		}
		if (sp.kind === 'player') {
			const opp = state.players.find((p) => !p.lost && p.playerId !== controller.playerId);
			const pl =
				sp.player?.relation === 'you'
					? controller
					: (opp ?? state.players.find((p) => !p.lost));
			if (!pl) return { ok: false };
			const ref: TargetRef = { kind: 'player', id: pl.playerId };
			chosen.push(ref);
			bySpec.push([ref]);
			continue;
		}
		if (sp.kind === 'objectOrPlayer') {
			const opp = state.players.find((p) => !p.lost && p.playerId !== controller.playerId);
			if (opp) {
				const ref: TargetRef = { kind: 'player', id: opp.playerId };
				chosen.push(ref);
				bySpec.push([ref]);
				continue;
			}
			const selfRef: TargetRef = { kind: 'player', id: controller.playerId };
			chosen.push(selfRef);
			bySpec.push([selfRef]);
			continue;
		}
		// sp.kind === 'object'
		const zone = sp.filter.zone ?? 'battlefield';
		let matchedRef: TargetRef | null = null;
		if (zone === 'battlefield') {
			for (const p of state.players) {
				if (p.lost) continue;
				for (const perm of p.battlefield) {
					if (perm.phasedOut) continue;
					if (
						host.matchesObjectFilter(perm, sp.filter, {
							state,
							controllerId: controller.playerId
						})
					) {
						matchedRef = { kind: 'permanent', id: perm.instanceId };
						break;
					}
				}
				if (matchedRef) break;
			}
		} else if (zone === 'stack') {
			const st = state.stack.find((s) => s.kind === 'spell');
			if (st) matchedRef = { kind: 'stack_item', id: st.id };
		} else if (zone === 'graveyard') {
			for (const p of state.players) {
				if (p.lost) continue;
				const gy = p.graveyard.find((c) =>
					host.matchesObjectFilter(c, sp.filter, {
						state,
						controllerId: controller.playerId
					})
				);
				if (gy) {
					matchedRef = { kind: 'graveyard_card', id: gy.instanceId };
					break;
				}
			}
		}
		if (!matchedRef) return { ok: false };
		chosen.push(matchedRef);
		bySpec.push([matchedRef]);
	}
	return { ok: true, targets: chosen, targetsBySpec: bySpec };
}

function applySectorCounterOrDestroy(
	state: GameState,
	controller: PlayerGameState,
	sector: SpaceSector,
	mode: 'counters' | 'destroy'
): void {
	const host = getHost();
	if (mode === 'counters') {
		for (const p of state.players) {
			if (p.lost) continue;
			for (const perm of p.battlefield) {
				if (perm.phasedOut || perm.spaceSector !== sector) continue;
				if (!evaluatePermanent(state, perm).isCreature) continue;
				host.addCountersToPermanent(state, perm, '+1/+1', 1);
			}
		}
		host.addLog(
			state,
			'rule',
			`${controller.username} puts a +1/+1 counter on each creature in the ${sector} sector.`,
			controller.playerId
		);
		return;
	}

	const toDestroy: Array<{ perm: CardInstance; owner: PlayerGameState }> = [];
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut || perm.spaceSector !== sector) continue;
			if (!evaluatePermanent(state, perm).isCreature) continue;
			if (host.hasKeyword(perm, 'Indestructible', state)) continue;
			const owner = state.players.find((pl) => pl.playerId === perm.ownerId) ?? p;
			toDestroy.push({ perm, owner });
		}
	}
	for (const { perm, owner } of toDestroy) {
		moveObject(state, perm, 'graveyard', {
			from: 'anyBattlefield',
			toPlayer: owner,
			bumpVersion: true,
			leaveBattlefieldReset: true,
			detachAttachments: true,
			graveyardReplacement: true,
			commanderRedirect: true,
			ceaseToExist: 'tokens'
		});
	}
	host.addLog(
		state,
		'rule',
		`${controller.username} destroys all creatures in the ${sector} sector.`,
		controller.playerId
	);
}

export function resolveWave7Effect(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState,
	tag: Wave7EffectTag
): 'done' | 'paused' {
	const host = getHost();

	if (tag === 'spaceSectorLock') {
		ensureSpaceSculptorSectors(state);
		state.spaceSectorBlockLockTurnSerial = state.turnSerial ?? state.turnNumber;
		host.addLog(
			state,
			'rule',
			`Until end of turn, creatures in each sector can be blocked only by creatures in the same sector.`,
			controller.playerId
		);
		return 'done';
	}

	if (tag === 'spaceSectorCounters' || tag === 'spaceSectorDestroy') {
		ensureSpaceSculptorSectors(state);
		const mode = tag === 'spaceSectorCounters' ? 'counters' : 'destroy';
		if (item.wave5Resume?.step === 'p21_sector_chosen') {
			const idx = item.wave5Resume.chosenNumber ?? 0;
			const sector = SPACE_SECTORS[Math.max(0, Math.min(2, idx))] ?? 'alpha';
			delete item.wave5Resume;
			applySectorCounterOrDestroy(state, controller, sector, mode);
			return 'done';
		}
		if (controller.isBot) {
			let bestSector: SpaceSector = 'alpha';
			let bestScore = -1;
			for (const s of SPACE_SECTORS) {
				let count = 0;
				for (const p of state.players) {
					if (p.lost) continue;
					const wantOwn = mode === 'counters';
					if (wantOwn !== (p.playerId === controller.playerId)) continue;
					for (const perm of p.battlefield) {
						if (!perm.phasedOut && perm.spaceSector === s && evaluatePermanent(state, perm).isCreature) {
							count++;
						}
					}
				}
				if (count > bestScore) {
					bestScore = count;
					bestSector = s;
				}
			}
			applySectorCounterOrDestroy(state, controller, bestSector, mode);
			return 'done';
		}
		item.wave5Resume = { step: 'await_p21_sector' };
		enqueueChoicePrompt(state, {
			id: host.uid('prm', state),
			playerId: controller.playerId,
			kind: 'chooseMode',
			purpose: 'generic',
			title: `${item.card.name} — Choose Sector`,
			description:
				mode === 'counters'
					? 'Choose a sector to put a +1/+1 counter on each creature in it.'
					: 'Choose a sector to destroy all creatures in it.',
			continuation: {
				kind: 'handler',
				name: 'p21_wave7_resume',
				data: { stackItemId: item.id, nextStep: 'p21_sector_chosen' }
			},
			choice: {
				kind: 'chooseMode',
				modes: ['alpha', 'beta', 'gamma'],
				min: 1,
				max: 1,
				defaultIndices: [0]
			}
		});
		return 'paused';
	}

	if (tag === 'necromancyFlashCleanup') {
		for (const p of state.players) {
			if (p.lost) continue;
			const perm = p.battlefield.find(
				(c) => !c.phasedOut && c.instanceId === item.sourceInstanceId
			);
			if (perm) {
				if (perm.castAtNonSorceryTiming) {
					perm.sacrificeAtNextCleanupStep = true;
				}
				break;
			}
		}
		return 'done';
	}

	if (tag === 'sacrificeSelfCleanup') {
		for (const p of state.players) {
			if (p.lost) continue;
			const perm = p.battlefield.find(
				(c) =>
					!c.phasedOut &&
					c.instanceId === item.sourceInstanceId &&
					(item.sourceObjectVersion === undefined ||
						(c.objectVersion ?? 1) === item.sourceObjectVersion)
			);
			if (perm) {
				const owner = state.players.find((pl) => pl.playerId === perm.ownerId) ?? p;
				moveObject(state, perm, 'graveyard', {
					from: { player: p, zone: 'battlefield' },
					toPlayer: owner,
					bumpVersion: true,
					leaveBattlefieldReset: true,
					detachAttachments: true,
					graveyardReplacement: true,
					commanderRedirect: true,
					ceaseToExist: 'tokens'
				});
				emitEvent(state, {
					kind: 'Sacrificed',
					playerId: p.playerId,
					objectId: perm.instanceId,
					object: perm
				});
				host.addLog(
					state,
					'rule',
					`${p.username} sacrifices ${perm.card.name} at the beginning of the cleanup step.`,
					p.playerId
				);
				break;
			}
		}
		return 'done';
	}

	if (tag === 'timetwister') {
		const totalPlayers = state.players.length;
		const apnapPlayers: PlayerGameState[] = [];
		for (let offset = 0; offset < totalPlayers; offset++) {
			const p = state.players[(state.activePlayerIndex + offset) % totalPlayers];
			if (!p.lost) apnapPlayers.push(p);
		}
		for (const p of apnapPlayers) {
			const handSnap = [...p.hand];
			for (const c of handSnap) {
				const owner = state.players.find((pl) => pl.playerId === c.ownerId) ?? p;
				moveObject(state, c, 'library', {
					from: { player: p, zone: 'hand' },
					toPlayer: owner,
					bumpVersion: true,
					commanderRedirect: true
				});
			}
			const gySnap = [...p.graveyard];
			for (const c of gySnap) {
				const owner = state.players.find((pl) => pl.playerId === c.ownerId) ?? p;
				moveObject(state, c, 'library', {
					from: { player: p, zone: 'graveyard' },
					toPlayer: owner,
					bumpVersion: true,
					commanderRedirect: true
				});
			}
			shuffleLibrary(state, p);
		}
		for (const p of apnapPlayers) {
			host.drawCards(state, p, 7);
		}
		return 'done';
	}

	if (tag === 'spellweaverVolute') {
		let volute: CardInstance | undefined;
		for (const p of state.players) {
			if (p.lost) continue;
			const found = p.battlefield.find(
				(c) => !c.phasedOut && c.instanceId === item.sourceInstanceId
			);
			if (found) {
				volute = found;
				break;
			}
		}
		const enchantedId = volute?.attachedToId;
		if (!enchantedId) return 'done';

		let gyCard: CardInstance | undefined;
		let gyOwner: PlayerGameState | undefined;
		for (const p of state.players) {
			if (p.lost) continue;
			const found = p.graveyard.find((c) => c.instanceId === enchantedId);
			if (found) {
				gyCard = found;
				gyOwner = p;
				break;
			}
		}
		if (!gyCard || !gyOwner) return 'done';

		const targetSel = findLegalTargetForInstantCopy(state, controller, gyCard.card);
		if (!targetSel.ok) return 'done';

		if (!item.wave5Resume && !controller.isBot) {
			item.wave5Resume = { step: 'await_volute_may' };
			enqueueChoicePrompt(state, {
				id: host.uid('prm', state),
				playerId: controller.playerId,
				kind: 'yesNo',
				purpose: 'generic',
				title: `${item.card.name} — Cast Copy of ${gyCard.card.name}`,
				description: `Cast a copy of ${gyCard.card.name} without paying its mana cost?`,
				continuation: {
					kind: 'handler',
					name: 'p21_wave7_resume',
					data: { stackItemId: item.id, nextStep: 'volute_may_answered' }
				},
				choice: {
					kind: 'yesNo',
					question: `Cast a copy of ${gyCard.card.name} without paying its mana cost?`
				}
			});
			return 'paused';
		}

		if (
			item.wave5Resume?.step === 'volute_may_answered' &&
			item.wave5Resume.chosenNumber === 0
		) {
			delete item.wave5Resume;
			return 'done';
		}

		if (item.wave5Resume?.step !== 'volute_reattach_chosen') {
			// 1. Cast the copy onto the stack without paying its mana cost.
			const copyId = host.uid('p21copy', state);
			const copyInst: CardInstance = {
				instanceId: copyId,
				card: gyCard.card,
				ownerId: controller.playerId,
				controllerId: controller.playerId,
				zone: 'stack',
				tapped: false,
				summoningSick: false,
				damageMarked: 0,
				deathtouchDamageMarked: false,
				counters: createEmptyCounterMap(),
				tempPowerMod: 0,
				tempToughnessMod: 0,
				grantedKeywords: [],
				attachedToId: null,
				isToken: true,
				isCommander: false,
				commanderCastCount: 0,
				usedLoyaltyThisTurn: false,
				transformed: false
			};
			const compiledCopy = compileCard(gyCard.card);
			const copyStackItem: StackItem = withStackItemText(
				{
					id: host.uid('stk', state),
					sourceInstanceId: copyId,
					card: gyCard.card,
					ownerId: controller.playerId,
					controllerId: controller.playerId,
					kind: 'spell',
					title: `${gyCard.card.name} (Copy)`,
					targets: targetSel.targets,
					...(targetSel.targetsBySpec ? { targetsBySpec: targetSel.targetsBySpec } : {}),
					xValue: 0,
					requiresGuidedResolution: !compiledCopy.fullySupported,
					createdAt: state.turnNumber,
					isCopy: true,
					faceIndex: 0,
					manaSpentCount: 0,
					manaColorsSpent: []
				},
				gyCard.card
			);
			state.stack.push(copyStackItem);
			controller.spellsCastThisTurn = (controller.spellsCastThisTurn ?? 0) + 1;
			if (state.players[state.activePlayerIndex]?.playerId === controller.playerId) {
				state.spellsCastByActivePlayerThisTurn =
					(state.spellsCastByActivePlayerThisTurn ?? 0) + 1;
			}
			emitEvent(state, {
				kind: 'Cast',
				playerId: controller.playerId,
				objectId: copyId,
				object: copyInst
			});
			host.addLog(
				state,
				'cast',
				`${controller.username} casts a copy of ${gyCard.card.name} without paying its mana cost.`,
				controller.playerId
			);

			// 2. Exile the enchanted instant card from its owner's graveyard.
			moveObject(state, gyCard, 'exile', {
				from: { player: gyOwner, zone: 'graveyard' },
				toPlayer: gyOwner,
				newTimestamp: true,
				bumpVersion: true
			});

			// 3. Reattach Volute to another instant card in a graveyard if one exists.
			if (!volute || volute.zone !== 'battlefield') {
				delete item.wave5Resume;
				return 'done';
			}
			const otherInstants: CardInstance[] = [];
			for (const p of state.players) {
				if (p.lost) continue;
				for (const c of p.graveyard) {
					const types = resolveObjectFaces(
						effectiveCardForObject(c),
						instanceFaceOptions(c, 'graveyard')
					).types;
					if (types.includes('Instant')) {
						otherInstants.push(c);
					}
				}
			}
			if (otherInstants.length === 0) {
				volute.attachedToId = null;
				noteLayerInputsChanged(state);
				delete item.wave5Resume;
				return 'done';
			}
			if (otherInstants.length === 1 || controller.isBot) {
				attachObject(state, volute, otherInstants[0].instanceId);
				delete item.wave5Resume;
				return 'done';
			}

			item.wave5Resume = { step: 'await_volute_reattach' };
			enqueueChoicePrompt(state, {
				id: host.uid('prm', state),
				playerId: controller.playerId,
				kind: 'chooseObjects',
				purpose: 'generic',
				title: `${volute.card.name} — Attach to Another Instant Card`,
				description: `Choose another instant card in a graveyard to attach ${volute.card.name} to.`,
				continuation: {
					kind: 'handler',
					name: 'p21_wave7_resume',
					data: { stackItemId: item.id, nextStep: 'volute_reattach_chosen' }
				},
				choice: {
					kind: 'chooseObjects',
					candidates: otherInstants.map((c) => c.instanceId),
					min: 1,
					max: 1,
					defaultObjectIds: [otherInstants[0].instanceId],
					zone: 'graveyard',
					reason: `Attach ${volute.card.name} to another instant card in a graveyard.`
				}
			});
			return 'paused';
		}

		// Resumed after choosing which graveyard instant to reattach Volute to.
		const pickedId = item.wave5Resume.chosenObjectIds?.[0];
		delete item.wave5Resume;
		if (volute && volute.zone === 'battlefield' && pickedId) {
			attachObject(state, volute, pickedId);
		}
		return 'done';
	}

	return 'done';
}

// ============================================================================
// Prompt Continuation Handlers
// ============================================================================

registerPromptHandler('p21_space_sector_assign', (state, prompt, answer) => {
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	if (!data) return;
	const permId = String(data.permId ?? '');
	const permVersion = Number(data.permVersion || 1);
	const idx = answer.kind === 'chooseMode' ? (answer.indices[0] ?? 0) : 0;
	const sector = SPACE_SECTORS[Math.max(0, Math.min(2, idx))] ?? 'alpha';
	for (const p of state.players) {
		if (p.lost) continue;
		const perm = p.battlefield.find(
			(c) => c.instanceId === permId && (c.objectVersion ?? 1) === permVersion
		);
		if (perm) {
			perm.spaceSector = sector;
			break;
		}
	}
	ensureSpaceSculptorSectors(state);
});

registerPromptHandler('p21_wave7_resume', (state, prompt, answer) => {
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	if (!data) return;
	const stackItemId = String(data.stackItemId ?? '');
	const nextStep = String(data.nextStep ?? '');
	const item = state.stack.find((s) => s.id === stackItemId);
	if (!item) return;
	item.wave5Resume ??= { step: nextStep };
	item.wave5Resume.step = nextStep;
	if (answer.kind === 'yesNo') {
		item.wave5Resume.chosenNumber = answer.yes ? 1 : 0;
	} else if (answer.kind === 'chooseMode') {
		item.wave5Resume.chosenNumber = answer.indices[0] ?? 0;
	} else if (answer.kind === 'chooseObjects') {
		item.wave5Resume.chosenObjectIds = [...answer.objectIds];
	} else if (answer.kind === 'chooseNumber') {
		item.wave5Resume.chosenNumber = answer.n;
	}
	getHost().resumeStackItem(state, item.id);
});
