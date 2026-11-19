/**
 * Wave 7 Track P20a — Static `ObjectFilter` Parity, Layer 1/2/4/6/7 Grants, `CR 614/615`
 * Replacements & Regeneration, `CR 614.12` ETB Player/Parity/Basic-Land Anchors, & Rule-Modifying Stax.
 *
 * Upholds ENGINE_INVARIANTS.md:
 * - Zero rules-text reads
 * - Zero card-name comparisons or precon card names in code
 * - Zero direct zone mutations
 * - Zero IR in `GameState`
 * - Bounded loops only
 */
import type {
	CopyModificationSpec,
	ObjectFilter,
	ReplacementDef,
	StaticDef
} from '../ir.ts';
import { buildTokenScryfallCard } from '../oracle.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import {
	createEmptyCounterMap,
	type CardInstance,
	type CounterType,
	type GameState,
	type ManaColor,
	type PlayerGameState,
	type ScryfallCard,
	type StackItem,
	type ZoneType
} from '../types.ts';
import {
	activeAbilityDefs,
	instanceFaceOptions,
	resolveObjectFaces,
	type ResolveObjectFacesOptions
} from './faces.ts';
import { withStableLayerInputs } from './layerCache.ts';
import { evaluatePermanent, permanentHasLostAllAbilities } from './layers.ts';
import { evaluateAmount, evaluateCondition, matchesObjectFilter } from './objectFilter.ts';
import { activeRuleModifiers } from './replace.ts';
import {
	boardMayGrantReplacementAbility,
	collectActiveGrantedReplacementDefs,
	forEachActiveStaticOnBattlefield
} from './staticsDynamicAndCosts.ts';
import { getGrantedSpellKeywordsForSpell } from './staticsWave6.ts';

function forEachActiveReplacementOnBattlefield(
	state: GameState,
	filterEvent: ReplacementDef['replaces']['event'],
	visit: (perm: CardInstance, controllerId: string, def: ReplacementDef) => void,
	excludeInstanceId?: string
): void {
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut || (excludeInstanceId && perm.instanceId === excludeInstanceId)) continue;
			const card = effectiveCardForObject(perm);
			if (!card) continue;
			if (permanentHasLostAllAbilities(perm, state).lost) continue;
			const ev = evaluatePermanent(state, perm);
			for (const ab of activeAbilityDefs(card, instanceFaceOptions(perm, 'battlefield'))) {
				if (ab.kind === 'replacement' && ab.replacement.replaces.event === filterEvent) {
					visit(perm, ev.controllerId, ab.replacement);
				}
			}
		}
	}
	if (!boardMayGrantReplacementAbility(state, filterEvent)) return;
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut || (excludeInstanceId && perm.instanceId === excludeInstanceId)) continue;
			const granted = collectActiveGrantedReplacementDefs(state, perm);
			if (granted.length === 0) continue;
			const ev = evaluatePermanent(state, perm);
			for (const rep of granted) {
				if (rep.replaces.event === filterEvent) {
					visit(perm, ev.controllerId, rep);
				}
			}
		}
	}
}

export const BASIC_LAND_TYPE_OPTIONS: readonly string[] = [
	'Plains',
	'Island',
	'Swamp',
	'Mountain',
	'Forest'
];

export const ALL_LAND_TYPE_OPTIONS: readonly string[] = [
	'Plains',
	'Island',
	'Swamp',
	'Mountain',
	'Forest',
	'Cave',
	'Desert',
	'Gate',
	'Lair',
	'Locus',
	'Mine',
	'Power-Plant',
	'Sphere',
	'Tower',
	'Town',
	"Urza's"
];

const FIVE_COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

// ---- 1. Parity, Half-Starting-Life, Most-Common-Color & Chosen-Player Helpers ----------------

/**
 * CR 107.1c: Zero is an even number (`0 % 2 === 0`). Evaluates mana-value parity directly or
 * against `source.chosenParity` (`'odd' | 'even'`).
 */
export function matchesManaValueParity(
	mv: number,
	mode: NonNullable<ObjectFilter['manaValueParity']>,
	source?: CardInstance
): boolean {
	const intMv = Math.max(0, Math.trunc(mv));
	const isEven = intMv % 2 === 0;
	switch (mode) {
		case 'even':
			return isEven;
		case 'odd':
			return !isEven;
		case 'chosenQuality': {
			const chosen = source?.chosenParity;
			if (!chosen) return false;
			return chosen === 'even' ? isEven : !isEven;
		}
		case 'chosenParity': {
			const chosen = source?.chosenParity;
			if (!chosen) return false;
			return chosen === 'even' ? isEven : !isEven;
		}
		case 'notChosenQuality': {
			const chosen = source?.chosenParity;
			if (!chosen) return false;
			return chosen === 'even' ? !isEven : isEven;
		}
	}
}

/**
 * Exact integer comparison of `life` against `startingLife / 2` (`life * 2 <op> startingLife`),
 * avoiding floating-point or odd-starting-life rounding bugs.
 */
export function comparePlayerLifeToHalfStarting(
	life: number,
	startingLife: number,
	op: '<=' | '<' | '>=' | '>'
): boolean {
	const lhs = life * 2;
	const rhs = startingLife;
	switch (op) {
		case '<=':
			return lhs <= rhs;
		case '<':
			return lhs < rhs;
		case '>=':
			return lhs >= rhs;
		case '>':
			return lhs > rhs;
	}
}

export function getStartingLifeTotal(state: GameState): number {
	return state.rules?.startingLife ?? 20;
}

export function evaluateLifeCompareHalfStarting(
	state: GameState,
	controllerId: string,
	who: 'you' | 'anyOpponent',
	op: '<=' | '<' | '>=' | '>'
): boolean {
	const starting = getStartingLifeTotal(state);
	if (who === 'you') {
		const you = state.players.find((p) => p.playerId === controllerId);
		if (!you) return false;
		return comparePlayerLifeToHalfStarting(you.life, starting, op);
	}
	for (const p of state.players) {
		if (p.lost || p.playerId === controllerId) continue;
		if (comparePlayerLifeToHalfStarting(p.life, starting, op)) return true;
	}
	return false;
}

export function countOpponentsWithLifeLessThanHalfStarting(
	state: GameState,
	controllerId: string
): number {
	const starting = getStartingLifeTotal(state);
	let count = 0;
	for (const p of state.players) {
		if (p.lost || p.playerId === controllerId) continue;
		if (comparePlayerLifeToHalfStarting(p.life, starting, '<')) {
			count++;
		}
	}
	return count;
}

/**
 * Evaluates `"as long as <color> is the most common color among all permanents [or is tied for most common]"`.
 * Per Gatherer rulings, if no colored permanents are on the battlefield, all five colors are tied at 0
 * (`allowTie === true` -> `true`; `allowTie === false` -> `false`).
 */
export function evaluateMostCommonColorFromCounts(
	counts: Readonly<Record<ManaColor, number>>,
	color: ManaColor,
	allowTie: boolean
): boolean {
	const targetCount = counts[color] ?? 0;
	let maxCount = 0;
	for (const c of FIVE_COLORS) {
		const v = counts[c] ?? 0;
		if (v > maxCount) maxCount = v;
	}
	if (targetCount < maxCount) return false;
	if (allowTie) return true;
	for (const c of FIVE_COLORS) {
		if (c === color) continue;
		if ((counts[c] ?? 0) >= targetCount) return false;
	}
	return true;
}

export function countPermanentColorsOnBattlefield(
	state: GameState
): Record<ManaColor, number> {
	const counts: Record<ManaColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			const cols = evaluatePermanent(state, perm).colors;
			for (const c of FIVE_COLORS) {
				if (cols.includes(c)) counts[c]++;
			}
		}
	}
	return counts;
}

export function evaluateMostCommonColorOnBattlefield(
	state: GameState,
	color: ManaColor,
	allowTie: boolean
): boolean {
	return withStableLayerInputs(state, () =>
		evaluateMostCommonColorFromCounts(countPermanentColorsOnBattlefield(state), color, allowTie)
	);
}

/**
 * Counts cards in `source.chosenPlayerId`'s `zone` matching optional `filter`.
 */
export function evaluateChosenPlayerZoneCount(
	state: GameState,
	source: CardInstance | undefined,
	controllerId: string,
	zone: ZoneType,
	filter?: ObjectFilter
): number {
	const chosenPid = source?.chosenPlayerId;
	if (!chosenPid) return 0;
	const pl = state.players.find((p) => p.playerId === chosenPid && !p.lost);
	if (!pl) return 0;
	const list: readonly CardInstance[] =
		zone === 'hand'
			? pl.hand
			: zone === 'graveyard'
				? pl.graveyard
				: zone === 'library'
					? pl.library
					: zone === 'exile'
						? pl.exile
						: zone === 'battlefield'
							? pl.battlefield.filter((b) => !b.phasedOut)
							: zone === 'command'
								? pl.command
								: [];
	if (!filter) return list.length;
	let count = 0;
	for (const inst of list) {
		if (matchesObjectFilter(inst, filter, { state, controllerId, source, zone })) {
			count++;
		}
	}
	return count;
}

/**
 * CR 604.3a: Unconditional self Layer 4 subtype-adding static abilities printed on a card
 * (e.g. `"~ is also a Cleric, Rogue, Warrior, and Wizard"`) function as CDAs in all zones.
 */
export function getSelfCdaAddedSubtypes(
	card: ScryfallCard,
	faceOpts?: ResolveObjectFacesOptions
): string[] {
	if (faceOpts?.isFaceDown) return [];
	const defs = activeAbilityDefs(card, faceOpts);
	const out: string[] = [];
	for (const ab of defs) {
		if (ab.kind !== 'static') continue;
		const st = ab.static;
		if (
			st.k === 'continuous' &&
			st.layer === '4' &&
			st.affected === 'self' &&
			!st.condition &&
			!st.activeInZone &&
			st.mod.k === 'addTypes' &&
			st.mod.types.length === 0 &&
			st.mod.subtypes?.length
		) {
			for (const sub of st.mod.subtypes) {
				if (!out.includes(sub)) out.push(sub);
			}
		}
	}
	return out;
}

// ---- 2. Spell Damage Keywords on Resolving Stack Spells (CR 702.15d, 702.2) -----------------

export function getGrantedSpellDamageKeywordsForStackItem(
	state: GameState,
	item: StackItem | undefined
): {
	hasLifelink: boolean;
	hasDeathtouch: boolean;
	hasWither: boolean;
	hasInfect: boolean;
} {
	const globalWither = hasGlobalAllDamageWither(state);
	if (!item || item.kind !== 'spell') {
		return {
			hasLifelink: false,
			hasDeathtouch: false,
			hasWither: globalWither,
			hasInfect: false
		};
	}
	const synthInst: CardInstance = {
		instanceId: item.sourceInstanceId ?? item.id,
		card: item.card,
		ownerId: item.controllerId,
		controllerId: item.controllerId,
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
		isToken: Boolean(item.isCopy),
		isCommander: Boolean(item.commanderCastCount && item.commanderCastCount > 0),
		commanderCastCount: item.commanderCastCount ?? 0,
		usedLoyaltyThisTurn: false,
		transformed: false,
		...(item.castFromZone ? { castFromZone: item.castFromZone } : {}),
		...(item.copiableState ? { copiableState: item.copiableState } : {})
	};
	const granted = getGrantedSpellKeywordsForSpell(
		state,
		item.controllerId,
		synthInst,
		item.faceIndex ?? 0,
		Boolean(item.fused)
	);
	const set = new Set(granted.map((k) => k.toLowerCase()));
	return {
		hasLifelink: set.has('lifelink'),
		hasDeathtouch: set.has('deathtouch'),
		hasWither: globalWither || set.has('wither'),
		hasInfect: set.has('infect')
	};
}

export function hasGlobalAllDamageWither(state: GameState): boolean {
	return activeRuleModifiers(state, 'allDamageHasWither').length > 0;
}

// ---- 3. ETB Choices, Clone Quoted Abilities, & External Lands Enter Untapped ----------------

export function getLegalEtbPlayerCandidates(
	state: GameState,
	controllerId: string,
	mode: 'any' | 'opponent'
): PlayerGameState[] {
	return state.players.filter(
		(p) => !p.lost && (mode === 'any' || p.playerId !== controllerId)
	);
}

export function chooseBotPlayerForEtb(
	state: GameState,
	ctrl: PlayerGameState,
	mode: 'any' | 'opponent'
): string | undefined {
	const opponents = state.players
		.filter((p) => !p.lost && p.playerId !== ctrl.playerId)
		.sort((a, b) => a.life - b.life || (a.seatIndex ?? 0) - (b.seatIndex ?? 0));
	if (opponents.length > 0) return opponents[0].playerId;
	if (mode === 'any' && !ctrl.lost) return ctrl.playerId;
	return undefined;
}

export function chooseBotLandSubtype(
	state: GameState,
	ctrl: PlayerGameState,
	kind: 'basicLand' | 'land'
): string {
	const colorToBasic: Record<string, string> = {
		W: 'Plains',
		U: 'Island',
		B: 'Swamp',
		R: 'Mountain',
		G: 'Forest'
	};
	const counts: Record<string, number> = {
		Plains: 0,
		Island: 0,
		Swamp: 0,
		Mountain: 0,
		Forest: 0
	};
	for (const hc of ctrl.hand) {
		const view = resolveObjectFaces(effectiveCardForObject(hc), instanceFaceOptions(hc, 'hand'));
		for (const c of view.colors) {
			const basic = colorToBasic[c];
			if (basic) counts[basic] = (counts[basic] ?? 0) + 1;
		}
	}
	let best = 'Forest';
	let bestScore = -1;
	for (const basic of BASIC_LAND_TYPE_OPTIONS) {
		const score = counts[basic] ?? 0;
		if (score > bestScore) {
			bestScore = score;
			best = basic;
		}
	}
	void state;
	void kind;
	return best;
}

/**
 * CR 707.9a: Applies `CopyModificationSpec.addSupertypes` and `CopyModificationSpec.addedAbilityTexts`
 * onto `destPerm.copiableState` after `applyCopiedPermanentToInstance` runs, using a synthetic
 * `mergedComponents` entry so `activeAbilityDefs` compiles the added abilities from structured IR.
 */
export function applyWave7CopyModificationExtras(
	destPerm: CardInstance,
	mods: CopyModificationSpec | undefined
): void {
	if (!mods || !destPerm.copiableState) return;
	if (mods.addSupertypes?.length) {
		const except = (destPerm.copiableState.except ??= {});
		const existing =
			except.supertypes ??
			resolveObjectFaces(destPerm.copiableState.card, {
				...instanceFaceOptions(destPerm, 'battlefield'),
				copiableState: undefined
			}).supertypes;
		const mergedSupers = [...existing];
		for (const sup of mods.addSupertypes) {
			if (!mergedSupers.includes(sup)) mergedSupers.push(sup);
		}
		except.supertypes = mergedSupers;
		if (except.removeSupertypes?.length) {
			const addedLower = new Set(mods.addSupertypes.map((s) => s.toLowerCase()));
			const remaining = except.removeSupertypes.filter((s) => !addedLower.has(s.toLowerCase()));
			if (remaining.length > 0) except.removeSupertypes = remaining;
			else delete except.removeSupertypes;
		}
	}
	if (mods.addedAbilityTexts?.length) {
		const effName =
			destPerm.copiableState.except?.names?.[0] ??
			destPerm.copiableState.card.name ??
			destPerm.card.name;
		const normalizedLines = mods.addedAbilityTexts.map((line) => line.replace(/~/g, effName));
		const extraCard = buildTokenScryfallCard(`copy_extra_${destPerm.instanceId}`, {
			name: effName,
			power: 0,
			toughness: 0,
			colors: [],
			typeLine: 'Creature',
			keywords: [],
			quotedAbilities: normalizedLines
		});
		const priorSubComponents = destPerm.copiableState.mergedComponents
			? destPerm.copiableState.mergedComponents.slice(1)
			: [];
		destPerm.copiableState.mergedComponents = [
			destPerm.copiableState.card,
			...priorSubComponents,
			extraCard
		];
	}
}

/**
 * CR 614.12: Checks external battlefield replacements that cause matching permanents to enter
 * untapped (e.g. `"Lands you control enter untapped"`, `"Gates you control enter untapped"`).
 */
export function externalPermanentEntersUntapped(
	state: GameState,
	enteringPerm: CardInstance,
	controllerId: string
): boolean {
	let entersUntapped = false;
	forEachActiveReplacementOnBattlefield(
		state,
		'zoneChange',
		(repSource, repControllerId, rep) => {
			if (entersUntapped) return;
			if (Array.isArray(rep.with) || rep.with.k !== 'modify' || !rep.with.untapped) return;
			if (rep.replaces.filter?.to !== 'battlefield') return;
			const objFilter = rep.replaces.filter?.object;
			if (objFilter === 'self') return;
			if (objFilter && typeof objFilter === 'object') {
				if (objFilter.other && enteringPerm.instanceId === repSource.instanceId) return;
				const viewPerm: CardInstance =
					enteringPerm.controllerId === controllerId
						? enteringPerm
						: { ...enteringPerm, controllerId };
				if (
					!matchesObjectFilter(viewPerm, objFilter, {
						state,
						controllerId: repControllerId,
						source: repSource,
						zone: 'battlefield'
					})
				) {
					return;
				}
			}
			if (
				rep.condition &&
				!evaluateCondition(rep.condition, {
					state,
					controllerId: repControllerId,
					source: repSource
				})
			) {
				return;
			}
			entersUntapped = true;
		}
	);
	return entersUntapped;
}

export function hasSelfEnterUnderOpponentControl(
	perm: CardInstance,
	state: GameState,
	controllerId: string
): boolean {
	if (perm.isFaceDown) return false;
	const abilities = activeAbilityDefs(
		effectiveCardForObject(perm),
		instanceFaceOptions(perm, 'battlefield')
	);
	for (const ab of abilities) {
		if (ab.kind !== 'replacement') continue;
		const rep = ab.replacement;
		if (rep.replaces.event !== 'zoneChange') continue;
		if (rep.replaces.filter?.object !== 'self' || rep.replaces.filter?.to !== 'battlefield') {
			continue;
		}
		if (Array.isArray(rep.with) || rep.with.k !== 'modify' || !rep.with.enterUnderOpponentControl) {
			continue;
		}
		if (rep.condition && !evaluateCondition(rep.condition, { state, controllerId, source: perm })) {
			continue;
		}
		return true;
	}
	return false;
}

// ---- 4. CR 614/615 Replacements: Mana Multipliers, Discard->BF, Exile-on-Die, Damage, Regen --

/**
 * CR 106.12: Evaluates multiplicative tap-for-mana static abilities (*Mana Reflection*,
 * *Nyxbloom Ancient*, *Virtue of Strength*). Multiple multipliers stack multiplicatively.
 */
export function getTapForManaMultiplier(
	state: GameState,
	tapperPlayerId: string,
	tappedPerm: CardInstance
): number {
	return withStableLayerInputs(state, () => {
		let mult = 1;
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, _sourceName, def) => {
				if (def.k !== 'tapForManaMultiplier') return;
				if (def.who !== 'all' && controllerId !== tapperPlayerId) return;
				if (
					def.condition &&
					!evaluateCondition(def.condition, { state, controllerId, source: perm })
				) {
					return;
				}
				if (
					!matchesObjectFilter(tappedPerm, def.filter, {
						state,
						controllerId,
						source: perm,
						zone: 'battlefield'
					})
				) {
					return;
				}
				if (def.factor > 1) {
					mult *= def.factor;
				}
			},
			'tapForManaMultiplier'
		);
		return mult;
	});
}

/**
 * CR 614.1a: Checks whether `cardInst` being discarded from hand into graveyard was caused by a
 * resolving spell or ability an opponent controls AND `cardInst` has a self replacement putting
 * it onto the battlefield instead.
 */
export function findSelfOpponentDiscardToBattlefield(
	state: GameState,
	cardInst: CardInstance
): { counters?: { counter: CounterType; count: number } } | null {
	let resolvingOpponentItem: StackItem | undefined;
	for (let i = state.stack.length - 1; i >= 0; i--) {
		const s = state.stack[i];
		if (s.resolutionStarted) {
			resolvingOpponentItem = s;
			break;
		}
	}
	if (!resolvingOpponentItem || resolvingOpponentItem.controllerId === cardInst.ownerId) {
		return null;
	}
	const abilities = activeAbilityDefs(
		effectiveCardForObject(cardInst),
		instanceFaceOptions(cardInst, 'hand')
	);
	for (const ab of abilities) {
		if (ab.kind !== 'replacement') continue;
		const rep = ab.replacement;
		if (Array.isArray(rep.with) || rep.with.k !== 'modify' || !rep.with.opponentDiscardToBattlefield) {
			continue;
		}
		if (
			rep.condition &&
			!evaluateCondition(rep.condition, {
				state,
				controllerId: cardInst.ownerId,
				source: cardInst
			})
		) {
			continue;
		}
		return rep.with.opponentDiscardToBattlefield;
	}
	return null;
}

/**
 * CR 614.1a: `"If a creature dealt damage by ~ this turn would die, exile it instead."`
 */
export function shouldExileCreatureDealtDamageBySourceOnDie(
	state: GameState,
	dyingObj: CardInstance
): boolean {
	const dmgList = dyingObj.damagedByThisTurn;
	if (!dmgList || dmgList.length === 0) return false;
	const ev =
		dyingObj.zone === 'battlefield' && !dyingObj.phasedOut
			? evaluatePermanent(state, dyingObj)
			: null;
	const isCreature = ev
		? ev.isCreature
		: resolveObjectFaces(
				effectiveCardForObject(dyingObj),
				instanceFaceOptions(dyingObj, 'battlefield')
			).types.includes('Creature');
	if (!isCreature) return false;

	let shouldExile = false;
	forEachActiveReplacementOnBattlefield(
		state,
		'zoneChange',
		(repSource, repControllerId, rep) => {
			if (shouldExile) return;
			if (Array.isArray(rep.with) || rep.with.k !== 'modify' || !rep.with.dealtDamageBySelfExileOnDie) {
				return;
			}
			const mode = rep.with.dealtDamageBySelfExileOnDie;
			if (!mode) return;
			if (
				mode === 'controlledSourceOpponentCreature' &&
				(ev?.controllerId ?? dyingObj.controllerId) === repControllerId
			) {
				return;
			}
			if (
				rep.condition &&
				!evaluateCondition(rep.condition, {
					state,
					controllerId: repControllerId,
					source: repSource
				})
			) {
				return;
			}
			const matched =
				mode === 'controlledSource' || mode === 'controlledSourceOpponentCreature'
					? dmgList.some(
							(entry) =>
								entry.sourceControllerId === repControllerId ||
								entry.sourceId === repSource.instanceId
						)
					: dmgList.some(
							(entry) =>
								entry.sourceId === repSource.instanceId &&
								(entry.sourceVersion === undefined ||
									entry.sourceVersion === repSource.objectVersion)
						);
			if (matched) shouldExile = true;
		}
	);
	return shouldExile;
}

/**
 * CR 614.1a: `"If ~ would be put into a graveyard from the battlefield, instead exile it and take an extra turn after this one."`
 */
export function hasSelfExileAndExtraTurnOnBattlefieldToGraveyard(
	state: GameState,
	leavingObj: CardInstance
): boolean {
	if (leavingObj.isFaceDown || leavingObj.phasedOut) return false;
	if (leavingObj.zone === 'battlefield' && permanentHasLostAllAbilities(leavingObj, state).lost) {
		return false;
	}
	const abilities = activeAbilityDefs(
		effectiveCardForObject(leavingObj),
		instanceFaceOptions(leavingObj, 'battlefield')
	);
	const ctrlId = leavingObj.controllerId || leavingObj.ownerId;
	for (const ab of abilities) {
		if (ab.kind !== 'replacement') continue;
		const rep = ab.replacement;
		if (
			Array.isArray(rep.with) ||
			rep.with.k !== 'modify' ||
			!rep.with.exileAndExtraTurnOnBattlefieldToGraveyard
		) {
			continue;
		}
		if (
			rep.condition &&
			!evaluateCondition(rep.condition, { state, controllerId: ctrlId, source: leavingObj })
		) {
			continue;
		}
		return true;
	}
	return false;
}

/**
 * CR 614.1a: `"If a source you control would deal noncombat damage to a creature an opponent controls, put that many -1/-1 counters on that creature instead."`
 */
export function shouldReplaceNoncombatDamageWithMinusCounters(
	state: GameState,
	target: CardInstance,
	evTargetIsCreature: boolean,
	isCombat: boolean,
	sourceControllerId: string | undefined
): boolean {
	if (isCombat || !evTargetIsCreature || !sourceControllerId) return false;
	const targetCtrlId = evaluatePermanent(state, target).controllerId;
	if (targetCtrlId === sourceControllerId) return false;
	let replaceWithCounters = false;
	forEachActiveReplacementOnBattlefield(
		state,
		'damage',
		(repSource, repControllerId, rep) => {
			if (replaceWithCounters || repControllerId !== sourceControllerId) return;
			if (
				Array.isArray(rep.with) ||
				rep.with.k !== 'modify' ||
				!rep.with.noncombatDamageToOpponentCreatureAsMinusCounters
			) {
				return;
			}
			if (
				rep.condition &&
				!evaluateCondition(rep.condition, {
					state,
					controllerId: repControllerId,
					source: repSource
				})
			) {
				return;
			}
			replaceWithCounters = true;
		}
	);
	return replaceWithCounters;
}

/**
 * CR 614.7a: Applies `chosenPlayerDamageMod` multipliers/additions
 * (`"If a source would deal damage to the chosen player or a permanent they control, it deals double that damage instead."`).
 */
export function applyChosenPlayerDamageModifiers(
	state: GameState,
	baseDamage: number,
	opts: {
		isCombat: boolean;
		targetKind: 'player' | 'permanent';
		targetPlayerId?: string;
		targetPermanent?: CardInstance;
	}
): number {
	if (baseDamage <= 0) return 0;
	const effPlayerId =
		opts.targetKind === 'player'
			? opts.targetPlayerId
			: opts.targetPermanent
				? evaluatePermanent(state, opts.targetPermanent).controllerId
				: undefined;
	if (!effPlayerId) return baseDamage;

	let addDelta = 0;
	let factor = 1;
	forEachActiveReplacementOnBattlefield(
		state,
		'damage',
		(repSource, repControllerId, rep) => {
			if (
				Array.isArray(rep.with) ||
				rep.with.k !== 'modify' ||
				!rep.with.chosenPlayerDamageMod
			) {
				return;
			}
			const dm = rep.with.chosenPlayerDamageMod;
			if (!repSource.chosenPlayerId || repSource.chosenPlayerId !== effPlayerId) return;
			if (dm.combatOnly && !opts.isCombat) return;
			if (dm.noncombatOnly && opts.isCombat) return;
			const ctx = {
				state,
				controllerId: repControllerId,
				source: repSource
			};
			if (rep.condition && !evaluateCondition(rep.condition, ctx)) {
				return;
			}
			if (dm.mode === 'add' && dm.add) {
				addDelta += Math.max(0, evaluateAmount(dm.add, ctx));
			} else if (dm.mode === 'double') {
				factor *= 2;
			} else if (dm.mode === 'triple') {
				factor *= 3;
			}
		}
	);
	return (baseDamage + addDelta) * factor;
}

export function shouldDealDamageToPlayerAsInfect(state: GameState, playerId: string): boolean {
	return activeRuleModifiers(state, 'damageToYouAsInfect', playerId).length > 0;
}

export function shouldPlayerSkipExtraTurn(
	state: GameState,
	playerId: string
): { skip: boolean; sourceName?: string } {
	const mods = activeRuleModifiers(state, 'skipExtraTurns', playerId);
	if (mods.length > 0) {
		return { skip: true, sourceName: mods[0].sourceName };
	}
	return { skip: false };
}

/**
 * CR 701.19: `"If ~ would be destroyed, regenerate it."`
 */
export function hasActiveSelfRegenerateOnDestroy(
	state: GameState,
	perm: CardInstance
): boolean {
	if (perm.zone !== 'battlefield' || perm.phasedOut || perm.isFaceDown) return false;
	if (permanentHasLostAllAbilities(perm, state).lost) return false;
	const abilities = activeAbilityDefs(
		effectiveCardForObject(perm),
		instanceFaceOptions(perm, 'battlefield')
	);
	const ctrlId = evaluatePermanent(state, perm).controllerId;
	for (const ab of abilities) {
		if (ab.kind !== 'replacement') continue;
		const rep = ab.replacement;
		if (
			Array.isArray(rep.with) ||
			rep.with.k !== 'modify' ||
			!rep.with.regenerateSelfOnDestroy
		) {
			continue;
		}
		if (
			rep.condition &&
			!evaluateCondition(rep.condition, { state, controllerId: ctrlId, source: perm })
		) {
			continue;
		}
		return true;
	}
	return false;
}

// ---- 5. Slice P20a.4: Pseudo-Haste Activation, Cleanup-Sac Flash, Shroud Locks, <=0 Life ----

/**
 * CR 602.5a: `"You may activate abilities of [filter] as though those creatures had haste."`
 */
export function canActivateAsThoughHaste(
	state: GameState,
	activatorId: string,
	sourcePerm: CardInstance
): boolean {
	if (sourcePerm.zone !== 'battlefield' || sourcePerm.phasedOut) return false;
	return withStableLayerInputs(state, () => {
		let allowed = false;
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, _sourceName, def) => {
				if (allowed || def.k !== 'activateAsThoughHaste') return;
				if (controllerId !== activatorId) return;
				if (
					def.condition &&
					!evaluateCondition(def.condition, { state, controllerId, source: perm })
				) {
					return;
				}
				if (
					matchesObjectFilter(sourcePerm, def.filter, {
						state,
						controllerId,
						source: perm,
						zone: 'battlefield'
					})
				) {
					allowed = true;
				}
			},
			'activateAsThoughHaste'
		);
		return allowed;
	});
}

/**
 * Returns true when `spellInst` was cast at non-sorcery timing solely via its own
 * `"You may cast ~ as though it had flash. If you cast it any time a sorcery couldn't have been cast,
 * the controller of the permanent it becomes sacrifices it at the beginning of the next cleanup step."`
 */
export function spellReliesOnCleanupSacrificeFlash(
	state: GameState,
	actorId: string,
	spellInst: CardInstance,
	atSorceryTiming: boolean,
	hasOtherFlashGrant: boolean
): boolean {
	if (atSorceryTiming || hasOtherFlashGrant) return false;
	const defs = activeAbilityDefs(effectiveCardForObject(spellInst), instanceFaceOptions(spellInst));
	for (const ab of defs) {
		if (
			ab.kind !== 'static' ||
			ab.static.k !== 'ruleModifier' ||
			ab.static.rule !== 'castAsThoughFlash'
		) {
			continue;
		}
		if (!ab.static.params?.selfOnly || !ab.static.params?.sacrificeAtNextCleanupIfNonSorcery) {
			continue;
		}
		if (
			!ab.static.condition ||
			evaluateCondition(ab.static.condition, { state, controllerId: actorId, source: spellInst })
		) {
			return true;
		}
	}
	return false;
}

/**
 * CR 115.1: `"Cards in graveyards can't be the targets of spells or abilities."`
 */
export function isGraveyardTargetingBlocked(
	state: GameState
): { blocked: boolean; sourceName?: string } {
	const mods = activeRuleModifiers(state, 'graveyardCantBeTargeted');
	if (mods.length > 0) {
		return { blocked: true, sourceName: mods[0].sourceName };
	}
	return { blocked: false };
}

function matchesAffectedPermanentForTargetLock(
	affected: Extract<StaticDef, { k: 'cantBeTargetedBy' }>['affected'],
	targetPerm: CardInstance,
	staticSource: CardInstance,
	staticControllerId: string,
	state: GameState
): boolean {
	if (affected === 'self') return targetPerm.instanceId === staticSource.instanceId;
	if (affected === 'attachedTo') return staticSource.attachedToId === targetPerm.instanceId;
	return matchesObjectFilter(targetPerm, affected, {
		state,
		controllerId: staticControllerId,
		source: staticSource,
		zone: 'battlefield'
	});
}

/**
 * CR 115.1 / 702.18: Evaluates `k: 'cantBeTargetedBy'` source-filtered targeting locks on
 * battlefield permanents against a spell or ability controlled by `actorId`.
 */
export function isPermanentBlockedByCantBeTargetedBy(
	state: GameState,
	targetPerm: CardInstance,
	actorId: string,
	sourceCard: ScryfallCard | undefined,
	sourcePerm: CardInstance | undefined,
	sourceKind: 'spell' | 'ability'
): { blocked: boolean; sourceName?: string } {
	if (!sourceCard || targetPerm.zone !== 'battlefield' || targetPerm.phasedOut) {
		return { blocked: false };
	}
	return withStableLayerInputs(state, () => {
		let blockedSourceName: string | undefined;
		const srcView: CardInstance =
			sourcePerm && sourcePerm.zone === 'battlefield'
				? sourcePerm
				: {
						instanceId: sourcePerm?.instanceId ?? '__target_src__',
						card: sourceCard,
						ownerId: actorId,
						controllerId: actorId,
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
						isToken: false,
						isCommander: false,
						commanderCastCount: 0,
						usedLoyaltyThisTurn: false,
						transformed: false
					};
		const srcZone: ZoneType =
			sourcePerm && sourcePerm.zone === 'battlefield' ? 'battlefield' : 'stack';

		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, sourceName, def) => {
				if (blockedSourceName || def.k !== 'cantBeTargetedBy') return;
				if (def.opponentControllerOnly && actorId === controllerId) return;
				if (def.spellsOnly && sourceKind !== 'spell') return;
				if (def.abilitiesOnly && sourceKind !== 'ability') return;
				if (
					def.condition &&
					!evaluateCondition(def.condition, { state, controllerId, source: perm })
				) {
					return;
				}
				if (
					!matchesAffectedPermanentForTargetLock(
						def.affected,
						targetPerm,
						perm,
						controllerId,
						state
					)
				) {
					return;
				}
				if (
					def.sourceFilter &&
					!matchesObjectFilter(srcView, def.sourceFilter, {
						state,
						controllerId,
						source: perm,
						zone: srcZone
					})
				) {
					return;
				}
				blockedSourceName = sourceName;
			},
			'cantBeTargetedBy'
		);
		if (blockedSourceName) {
			return { blocked: true, sourceName: blockedSourceName };
		}
		return { blocked: false };
	});
}

/**
 * CR 104.3b: `"You don't lose the game for having 0 or less life."`
 */
export function playerDontLoseAtZeroOrLessLife(
	state: GameState,
	playerId: string
): boolean {
	return activeRuleModifiers(state, 'dontLoseAtZeroOrLessLife', playerId).length > 0;
}

/**
 * CR 601.3: Enforces `k: 'selfCastRestriction'` (`castCondition`) during global cast legality checks.
 */
export function checkWave7SelfCastRestrictions(
	state: GameState,
	actorId: string,
	spellInst: CardInstance | undefined
): { ok: boolean; error?: string } {
	if (!spellInst) return { ok: true };
	const defs = activeAbilityDefs(effectiveCardForObject(spellInst), instanceFaceOptions(spellInst));
	for (const ab of defs) {
		if (ab.kind !== 'static' || ab.static.k !== 'selfCastRestriction') continue;
		const st = ab.static;
		if (
			st.castCondition &&
			!evaluateCondition(st.castCondition, { state, controllerId: actorId, source: spellInst })
		) {
			return {
				ok: false,
				error: `Illegal Cast: ${spellInst.card.name}'s casting condition is not met.`
			};
		}
	}
	return { ok: true };
}
