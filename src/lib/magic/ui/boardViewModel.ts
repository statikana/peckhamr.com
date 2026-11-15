import { compileCard } from '../compiler/index.ts';
import {
	canPayOrAutoTap,
	checkAbilityActivationLegality,
	checkHandSpecialActionLegality,
	checkSpellCastLegality,
	checkSuspendLegality,
	checkUnlockRoomDoorLegality,
	getCastOptions,
	getEffectiveActivatedAbilities,
	getHandSpecialActions,
	getLandPlayOptions,
	getPlayerCommanderIdentity,
	getTurnFaceUpDisplay
} from '../engine.ts';
import type { Amount, CostDef, ModalDef, ObjectFilter } from '../ir.ts';
import { KEYWORD_LABELS, STATIC_CONTINUOUS_KEYWORDS } from '../keywords.ts';
import { DUNGEON_SPECS, parseManaCost } from '../oracle.ts';
import { evaluatePermanent, type EvaluatedPermanent } from '../ruleTree.ts';
import { describeCost, getSuspendSpec } from '../runtime/costs.ts';
import { getCommanderTaxLifeCostP20b } from '../runtime/costsWave7.ts';
import { isP16aSourceConditionCurrentlyMet } from '../runtime/effectsWave6.ts';
import { instanceFaceOptions, resolveObjectFaces } from '../runtime/faces.ts';
import { checkCompanionSpecialActionLegality } from '../runtime/framesModalsWave6.ts';
import {
	cardHasEscalate,
	computeModalModeAdditionalCosts
} from '../runtime/keywordsWave4.ts';
import { withStableLayerInputs } from '../runtime/layerCache.ts';
import { splitSubtypes } from '../runtime/layers.ts';
import { evaluateAmount, evaluateCondition } from '../runtime/objectFilter.ts';
import { activeRuleModifiers } from '../runtime/replace.ts';
import {
	forEachActiveStaticOnBattlefield,
	KEYWORD_COUNTER_SET,
	totalSnowManaInPool
} from '../runtime/staticsDynamicAndCosts.ts';
import { getPlayerTopOfLibraryVisibility } from '../runtime/staticsLayersAndRestrictions.ts';
import {
	getRequiredFlagbearerIdsForActor,
	isPlayerHandRevealedToViewer,
	isPlayerTopLibraryRevealedByGlobalStatic,
	parseNonStandardPtCounter
} from '../runtime/staticsWave6.ts';
import { playerDontLoseAtZeroOrLessLife } from '../runtime/staticsWave7.ts';
import { activeFaceIndexForObject, effectiveCardForObject } from '../scryfall.ts';
import type {
	CardInstance,
	CastOption,
	CounterType,
	EffectiveActivatedAbility,
	GameState,
	HandSpecialActionOption,
	LandPlayOption,
	ManaColor,
	ManaPool,
	PlayerGameState,
	ScryfallCard,
	TargetRef
} from '../types.ts';

export const FACE_DOWN_ART_URI =
	'data:image/svg+xml;utf8,' +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 168"><rect width="120" height="168" rx="8" fill="#1b1824" stroke="#6b5b7b" stroke-width="4"/><circle cx="60" cy="84" r="28" fill="none" stroke="#8a74a8" stroke-width="3"/><text x="60" y="92" text-anchor="middle" fill="#c7b8df" font-family="serif" font-size="28" font-weight="bold">?</text></svg>'
	);

const ALL_MANA_COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];

const KNOWN_CARD_TYPES = [
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

export const EMBLEM_ART_URI =
	'data:image/svg+xml;utf8,' +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 168"><rect width="120" height="168" rx="8" fill="#181622" stroke="#ab9df2" stroke-width="4"/><polygon points="60,26 92,46 84,96 60,122 36,96 28,46" fill="#262038" stroke="#ffd866" stroke-width="3"/><circle cx="60" cy="70" r="14" fill="none" stroke="#ab9df2" stroke-width="2.5"/><text x="60" y="146" text-anchor="middle" fill="#ffd866" font-family="sans-serif" font-size="13" font-weight="bold">EMBLEM</text></svg>'
	);

export const DUNGEON_ART_URI =
	'data:image/svg+xml;utf8,' +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 168"><rect width="120" height="168" rx="8" fill="#171920" stroke="#78dce8" stroke-width="4"/><path d="M36 118 V66 A24 24 0 0 1 84 66 V118 Z" fill="#232834" stroke="#ffd866" stroke-width="3"/><circle cx="60" cy="78" r="8" fill="#ffd866"/><text x="60" y="146" text-anchor="middle" fill="#78dce8" font-family="sans-serif" font-size="12" font-weight="bold">DUNGEON</text></svg>'
	);

/** CR 701.54c: Cumulative Ring-bearer abilities unlocked at each Ring temptation level (1..4). */
export const RING_LEVEL_ABILITY_SUMMARIES: readonly string[] = [
	"Lv. 1: Your Ring-bearer is legendary and can't be blocked by creatures with greater power.",
	'Lv. 2: Whenever your Ring-bearer attacks, draw a card, then discard a card.',
	"Lv. 3: Whenever your Ring-bearer becomes blocked by a creature, that creature's controller sacrifices it at end of combat.",
	'Lv. 4: Whenever your Ring-bearer deals combat damage to a player, each opponent loses 3 life.'
];

export function getRingAbilitiesForLevel(ringLevel: number): string[] {
	const clamped = Math.min(RING_LEVEL_ABILITY_SUMMARIES.length, Math.max(0, Math.trunc(ringLevel)));
	return RING_LEVEL_ABILITY_SUMMARIES.slice(0, clamped);
}

export type CounterBadgeKind =
	| 'plus'
	| 'minus'
	| 'keyword'
	| 'loyalty'
	| 'defense'
	| 'lore'
	| 'charge'
	| 'shield'
	| 'stun'
	| 'time'
	| 'age'
	| 'other';

export interface CounterBadgeEntry {
	type: CounterType;
	count: number;
	badgeKind: CounterBadgeKind;
	label: string;
	shortLabel: string;
	description: string;
	powerDelta?: number;
	toughnessDelta?: number;
}

export interface PermanentDisplayCard {
	card: ScryfallCard;
	name: string;
	imageUrl: string;
	artCropUrl: string;
	typeLine: string;
	isFaceDown: boolean;
}

export interface UnlockableFaceView {
	faceIndex: number;
	name: string;
	manaCost: string;
	check: { ok: boolean; error?: string };
}

export interface RoomDoorView {
	faceIndex: number;
	name: string;
	manaCost: string;
	unlocked: boolean;
}

export type DungeonId = keyof typeof DUNGEON_SPECS;

export interface ActiveDungeonView {
	dungeonId: DungeonId;
	dungeonName: string;
	roomIndex: number;
	roomName: string;
	roomEffectText: string;
	totalRooms: number;
	pendingCompletion: boolean;
}

export type TurnFaceUpSummary = NonNullable<ReturnType<typeof getTurnFaceUpDisplay>>;

export interface PermanentActableSummary {
	activatedAbilities: EffectiveActivatedAbility[];
	legalActivatedAbilityIds: string[];
	turnFaceUp: TurnFaceUpSummary | null;
	unlockableFaces: UnlockableFaceView[];
	preparationCopyOption: CastOption | null;
	preparationCopyFaceName: string | null;
	preparationCopyManaCost: string | null;
	preparationCopyCheck: { ok: boolean; error?: string } | null;
	canAttackNow: boolean;
	canBlockNow: boolean;
	isSingleTapManaOnly: boolean;
	isActable: boolean;
}

export interface ModalModeCostView {
	perModeBadges: Array<string | null>;
	escalateStepCost: string | null;
	escalateBadge: string | null;
	selectedTotalCostBadge: string | null;
	hasModeCosts: boolean;
}

export interface CompanionView {
	card: ScryfallCard;
	canMoveToHand: boolean;
	illegalityReason: string | null;
}

export interface TopOfLibraryView {
	topCard: CardInstance | null;
	card: ScryfallCard | null;
	visibility: 'revealed' | 'look' | 'known' | 'hidden';
	isRevealedToAll: boolean;
	isLookableByViewer: boolean;
	libraryLandPlayOptions: LandPlayOption[];
	libraryCastOptions: CastOption[];
	canPlayOrCast: boolean;
}

const CHOSEN_COLOR_NAMES: Record<ManaColor, string> = {
	W: 'White',
	U: 'Blue',
	B: 'Black',
	R: 'Red',
	G: 'Green',
	C: 'Colorless'
};

export function formatPermanentChosenDescriptor(
	perm: CardInstance,
	players?: ReadonlyArray<Pick<PlayerGameState, 'playerId' | 'username'>>
): string | null {
	const parts: string[] = [];
	if (perm.chosenCardName) parts.push(perm.chosenCardName);
	if (perm.chosenSubType) parts.push(perm.chosenSubType);
	if (perm.chosenColor) parts.push(CHOSEN_COLOR_NAMES[perm.chosenColor] ?? perm.chosenColor);
	if (perm.chosenAnchorWord) parts.push(`"${perm.chosenAnchorWord}"`);
	if (perm.chosenPlayerId) {
		const resolvedPlayerName =
			players?.find((p) => p.playerId === perm.chosenPlayerId)?.username ?? perm.chosenPlayerId;
		parts.push(`Player: ${resolvedPlayerName}`);
	}
	if (perm.chosenParity) {
		parts.push(`Parity: ${perm.chosenParity === 'odd' ? 'Odd' : 'Even'}`);
	}
	return parts.length > 0 ? parts.join(' • ') : null;
}

export interface PermanentView {
	instanceId: string;
	perm: CardInstance;
	controllerId: string;
	evaluated: EvaluatedPermanent;
	displayCard: PermanentDisplayCard;
	types: string[];
	subtypes: string[];
	colors: ManaColor[];
	hasLostAllAbilities: boolean;
	isCreature: boolean;
	isPlaneswalker: boolean;
	isBattle: boolean;
	isEquipment: boolean;
	power: number;
	toughness: number;
	displayToughness: number;
	hasDefender: boolean;
	hasHaste: boolean;
	isSummoningSickVisual: boolean;
	countersList: CounterBadgeEntry[];
	classLevel: number | null;
	caseSolved: boolean | null;
	mergedComponentNames: string[];
	mutateCount: number;
	meldedComponentNames: string[];
	isFlipped: boolean;
	pairedWithId: string | null;
	pairedPartnerName: string | null;
	hauntedByNames: string[];
	isSuspected: boolean;
	isGoaded: boolean;
	goadedByNames: string[];
	isHarnessed: boolean;
	isRenowned: boolean;
	hasEnduringStory: boolean;
	isSaddled: boolean;
	isRingBearer: boolean;
	isPrepared: boolean;
	isPrototyped: boolean;
	regenerationShields: number;
	isFlagbearer: boolean;
	chosenDescriptor: string | null;
	isStolen: boolean;
	ownerName: string | null;
	isFrozen: boolean;
	frozenBySourceNames: string[];
	assimilatedBySourceName: string | null;
	assignsNoCombatDamageThisTurn: boolean;
	mustAttackThisTurn: boolean;
	mustBlockThisTurn: boolean;
	mustBeBlockedThisTurn: boolean;
	cantBlockAttackerCount: number;
	cantBlockAttackerNames: string[];
	isMonstrous: boolean;
	linkedExileCount: number;
	linkedExileLabels: string[];
	protectorId: string | null;
	protectorName: string | null;
	canBeAttackedAsBattle: boolean;
	roomDoors: RoomDoorView[];
	attachments: CardInstance[];
	host: CardInstance | null;
	actableSummary: PermanentActableSummary;
}

export interface RestrictedManaEntry {
	restriction: string;
	pool: ManaPool;
	total: number;
	colors: Array<{ color: ManaColor; amount: number }>;
	label: string;
	description: string;
}

export interface CommanderDamageEntry {
	commanderId: string;
	commanderName: string;
	shortName: string;
	damage: number;
	lethalThreshold: number;
}

export interface PlayerShieldBadge {
	id: string;
	label: string;
	description: string;
	tone: 'gold' | 'cyan' | 'purple' | 'green';
}

export interface RuleLockBadge {
	id: string;
	label: string;
	description: string;
	sourceName: string | null;
	tone: 'gold' | 'cyan' | 'purple' | 'green' | 'red' | 'amber';
}

export interface PlayerStatusView {
	playerId: string;
	username: string;
	life: number;
	poison: number;
	energyCounters: number;
	experienceCounters: number;
	radCounters: number;
	isMonarch: boolean;
	hasInitiative: boolean;
	activeDungeon: ActiveDungeonView | null;
	completedDungeonCount: number;
	completedDungeonNames: string[];
	speed: number;
	isMaxSpeed: boolean;
	hasCitysBlessing: boolean;
	hasEnduringStory: boolean;
	cannotCastSpellsForRestOfGame: boolean;
	epicSpellNames: string[];
	ringLevel: number;
	ringBearerId: string | null;
	ringAbilities: string[];
	snowManaTotal: number;
	snowManaByColor: Partial<Record<ManaColor, number>>;
	creatureManaTotal: number;
	creatureManaByColor: Partial<Record<ManaColor, number>>;
	basicLandManaTotal: number;
	basicLandManaByColor: Partial<Record<ManaColor, number>>;
	treasureManaTotal: number;
	treasureManaByColor: Partial<Record<ManaColor, number>>;
	commanderTaxAsLifePerCast: number | null;
	commanders: CardInstance[];
	emblems: CardInstance[];
	dungeonCommandCards: CardInstance[];
	restrictedManaEntries: RestrictedManaEntry[];
	commanderDamageEntries: CommanderDamageEntry[];
	protectionFromEverythingThisTurn: boolean;
	cannotLoseGameThisTurn: boolean;
	lifeTotalCannotChangeThisTurn: boolean;
	staticCannotLoseGame: boolean;
	dontLoseAtZeroOrLessLife: boolean;
	staticLifeTotalLocked: boolean;
	damagePreventionShield: number;
	preventAllCombatDamageThisTurn: boolean;
	turnShieldBadges: PlayerShieldBadge[];
	attackTaxPerCreature: string | null;
	attackTaxSources: string[];
	unspentManaRetentionLabel: string | null;
	activeRuleLocks: RuleLockBadge[];
	companionView: CompanionView | null;
	topOfLibraryView: TopOfLibraryView | null;
}

export interface HandSpecialActionView extends HandSpecialActionOption {
	legal: boolean;
}

export interface HandCardPlayabilityView {
	instanceId: string;
	playable: boolean;
	isLand: boolean;
	canPlayLand: boolean;
	landOptions: LandPlayOption[];
	castOptions: CastOption[];
	suspendSpec: { timeCounters: number; cost: string; suspendCost: string } | null;
	canSuspend: boolean;
	specialActions: HandSpecialActionView[];
	zoneActivatedAbilities: EffectiveActivatedAbility[];
}

export interface BoardViewModel {
	viewerId: string;
	dayNight: 'day' | 'night' | null;
	spellsCastByActivePlayerThisTurn: number;
	prevTurnSpellsCastByActivePlayer: number;
	monarchPlayerId: string | null;
	initiativePlayerId: string | null;
	globalRuleLocks: RuleLockBadge[];
	attachmentsByHostId: Record<string, CardInstance[]>;
	hostByAttachmentId: Record<string, CardInstance>;
	permanentsById: Record<string, PermanentView>;
	frontRow: PermanentView[];
	backRow: PermanentView[];
	opponentBoardsById: Record<string, PermanentView[]>;
	playerStatusesById: Record<string, PlayerStatusView>;
	handPlayabilityById: Record<string, HandCardPlayabilityView>;
	commandPlayabilityById: Record<string, boolean>;
	companionView: CompanionView | null;
	gyLandPlayOptions: Record<string, LandPlayOption[]>;
	hasPlayableGraveyardActions: boolean;
	playableGraveyardIds: string[];
	playableExileIds: string[];
	playableExileCards: CardInstance[];
	permittedExileCards: CardInstance[];
	exileHauntingTargetNameById: Record<string, string>;
	topOfLibraryView: TopOfLibraryView | null;
	topOfLibraryByPlayerId: Record<string, TopOfLibraryView>;
	revealedOpponentHandsByPlayerId: Record<string, CardInstance[]>;
	waitingOnPlayerIds: string[];
}

const KNOWN_CORE_COUNTER_ORDER: readonly CounterType[] = [
	'loyalty',
	'defense',
	'lore',
	'level',
	'charge',
	'shield',
	'stun',
	'time',
	'fade',
	'age'
];

const KNOWN_CORE_COUNTER_SET: ReadonlySet<string> = new Set<string>(KNOWN_CORE_COUNTER_ORDER);

function isKeywordAbilityCounterName(type: string): boolean {
	const lower = type.trim().toLowerCase();
	if (!lower || KNOWN_CORE_COUNTER_SET.has(lower)) return false;
	return KEYWORD_COUNTER_SET.has(lower) || STATIC_CONTINUOUS_KEYWORDS.has(lower);
}

function formatSignedPtComponent(val: number, zeroSign: '+' | '-'): string {
	if (val > 0) return `+${val}`;
	if (val < 0) return `${val}`;
	return `${zeroSign}0`;
}

export function classifyCounterBadge(type: string, count: number): CounterBadgeEntry {
	switch (type) {
		case '+1/+1':
			return {
				type: '+1/+1',
				count,
				badgeKind: 'plus',
				label: `+${count}/+${count}`,
				shortLabel: `+${count}`,
				description: `${count} × +1/+1 counter${count === 1 ? '' : 's'} (+${count}/+${count} P/T, CR 122.1a)`,
				powerDelta: count,
				toughnessDelta: count
			};
		case '-1/-1':
			return {
				type: '-1/-1',
				count,
				badgeKind: 'minus',
				label: `-${count}/-${count}`,
				shortLabel: `-${count}`,
				description: `${count} × -1/-1 counter${count === 1 ? '' : 's'} (-${count}/-${count} P/T, CR 122.1a)`,
				powerDelta: -count,
				toughnessDelta: -count
			};
	}

	const arbitraryPt = parseNonStandardPtCounter(type);
	if (arbitraryPt) {
		const rawParts = type.split('/');
		const pZeroSign: '+' | '-' = rawParts[0]?.startsWith('-') ? '-' : '+';
		const tZeroSign: '+' | '-' = rawParts[1]?.startsWith('-') ? '-' : '+';
		const dP = arbitraryPt.p * count || 0;
		const dT = arbitraryPt.t * count || 0;
		const deltaStr = `${formatSignedPtComponent(dP, pZeroSign)}/${formatSignedPtComponent(dT, tZeroSign)}`;
		const badgeKind: CounterBadgeKind =
			dP + dT >= 0 && (dP > 0 || dT > 0) ? 'plus' : 'minus';
		return {
			type: type as CounterType,
			count,
			badgeKind,
			label: count === 1 ? deltaStr : `${deltaStr} (${count}×${type})`,
			shortLabel: deltaStr,
			description: `${count} × ${type} counter${count === 1 ? '' : 's'} (${deltaStr} P/T, CR 122.1a)`,
			powerDelta: dP,
			toughnessDelta: dT
		};
	}

	switch (type) {
		case 'loyalty':
			return {
				type: 'loyalty',
				count,
				badgeKind: 'loyalty',
				label: `L:${count}`,
				shortLabel: `L:${count}`,
				description: `${count} loyalty counter${count === 1 ? '' : 's'} (CR 306.5)`
			};
		case 'defense':
			return {
				type: 'defense',
				count,
				badgeKind: 'defense',
				label: `Def:${count}`,
				shortLabel: `Def:${count}`,
				description: `${count} defense counter${count === 1 ? '' : 's'} (CR 310.4)`
			};
		case 'lore':
			return {
				type: 'lore',
				count,
				badgeKind: 'lore',
				label: `Lore:${count}`,
				shortLabel: `Lore:${count}`,
				description: `${count} lore counter${count === 1 ? '' : 's'} (CR 714)`
			};
		case 'charge':
			return {
				type: 'charge',
				count,
				badgeKind: 'charge',
				label: `Chg:${count}`,
				shortLabel: `Chg:${count}`,
				description: `${count} charge counter${count === 1 ? '' : 's'}`
			};
		case 'shield':
			return {
				type: 'shield',
				count,
				badgeKind: 'shield',
				label: `Shld:${count}`,
				shortLabel: `Shld:${count}`,
				description: `${count} shield counter${count === 1 ? '' : 's'} (CR 122.1c)`
			};
		case 'stun':
			return {
				type: 'stun',
				count,
				badgeKind: 'stun',
				label: `Stun:${count}`,
				shortLabel: `Stun:${count}`,
				description: `${count} stun counter${count === 1 ? '' : 's'} (CR 122.1d)`
			};
		case 'time':
			return {
				type: 'time',
				count,
				badgeKind: 'time',
				label: `Time:${count}`,
				shortLabel: `Time:${count}`,
				description: `${count} time counter${count === 1 ? '' : 's'}`
			};
		case 'age':
			return {
				type: 'age',
				count,
				badgeKind: 'age',
				label: `Age:${count}`,
				shortLabel: `Age:${count}`,
				description: `${count} age counter${count === 1 ? '' : 's'}`
			};
	}

	if (isKeywordAbilityCounterName(type)) {
		const lower = type.trim().toLowerCase();
		const kwDisplay =
			KEYWORD_LABELS[lower] ?? `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
		const displayWithCount = count > 1 ? `${kwDisplay} ×${count}` : kwDisplay;
		return {
			type: type as CounterType,
			count,
			badgeKind: 'keyword',
			label: displayWithCount,
			shortLabel: displayWithCount,
			description: `${count} × ${kwDisplay} keyword counter${count === 1 ? '' : 's'} (grants ${kwDisplay}, CR 122.1b)`
		};
	}

	return {
		type: type as CounterType,
		count,
		badgeKind: 'other',
		label: `${type}:${count}`,
		shortLabel: `${type}:${count}`,
		description: `${count} ${type} counter${count === 1 ? '' : 's'}`
	};
}

export function extractCounterBadges(counters: Record<string, number> | undefined): CounterBadgeEntry[] {
	if (!counters) return [];
	const out: CounterBadgeEntry[] = [];
	const seen = new Set<string>();

	// 1. Standard +1/+1 and -1/-1 counters first.
	for (const stdPt of ['+1/+1', '-1/-1'] as const) {
		const raw = counters[stdPt];
		if (typeof raw === 'number' && raw !== 0) {
			out.push(classifyCounterBadge(stdPt, raw));
			seen.add(stdPt);
		}
	}

	// 2. Arbitrary ±M/±N counters (CR 122.1a), sorted deterministically (plus before minus, then lexicographical).
	const arbitraryEntries = Object.keys(counters)
		.filter(
			(k) =>
				!seen.has(k) &&
				typeof counters[k] === 'number' &&
				counters[k] !== 0 &&
				parseNonStandardPtCounter(k) !== null
		)
		.map((k) => classifyCounterBadge(k, counters[k]))
		.sort((a, b) => {
			const aRank = a.badgeKind === 'plus' ? 0 : 1;
			const bRank = b.badgeKind === 'plus' ? 0 : 1;
			return aRank !== bRank ? aRank - bRank : a.type.localeCompare(b.type);
		});
	for (const arbEntry of arbitraryEntries) {
		out.push(arbEntry);
		seen.add(arbEntry.type);
	}

	// 3. Core mechanic counters (loyalty, defense, lore, level, charge, shield, stun, time, fade, age).
	for (const coreKey of KNOWN_CORE_COUNTER_ORDER) {
		if (seen.has(coreKey)) continue;
		const raw = counters[coreKey];
		if (typeof raw === 'number' && raw !== 0) {
			out.push(classifyCounterBadge(coreKey, raw));
			seen.add(coreKey);
		}
	}

	// 4. Keyword ability counters (CR 122.1b).
	for (const [key, raw] of Object.entries(counters)) {
		if (seen.has(key)) continue;
		if (typeof raw === 'number' && raw !== 0 && isKeywordAbilityCounterName(key)) {
			out.push(classifyCounterBadge(key, raw));
			seen.add(key);
		}
	}

	// 5. Remaining named counters.
	for (const [key, raw] of Object.entries(counters)) {
		if (seen.has(key)) continue;
		if (typeof raw === 'number' && raw !== 0) {
			out.push(classifyCounterBadge(key, raw));
			seen.add(key);
		}
	}

	return out;
}

function parseTypesAndSubtypes(effectiveTypeLine: string): { types: string[]; subtypes: string[] } {
	const dashIdx = effectiveTypeLine.indexOf('—');
	const left = dashIdx >= 0 ? effectiveTypeLine.slice(0, dashIdx) : effectiveTypeLine;
	const right = dashIdx >= 0 ? effectiveTypeLine.slice(dashIdx + 1).trim() : '';
	const types: string[] = [];
	for (const t of KNOWN_CARD_TYPES) {
		if (left.includes(t)) types.push(t);
	}
	const subtypes = right ? splitSubtypes(right) : [];
	return { types, subtypes };
}

export function getPermanentRoomDoors(perm: CardInstance): RoomDoorView[] {
	if (perm.isFaceDown) return [];
	const effCard = effectiveCardForObject(perm);
	if ((effCard.layout ?? 'normal') !== 'split') return [];
	const compiled = compileCard(effCard);
	if (compiled.faces.length < 2) return [];
	if (!compiled.faces.some((f) => f.characteristics.subtypes.includes('Room'))) return [];
	const unlockedSet = new Set(perm.unlockedFaces ?? []);
	const out: RoomDoorView[] = [];
	for (let fi = 0; fi < compiled.faces.length; fi++) {
		const f = compiled.faces[fi];
		if (!f.characteristics.subtypes.includes('Room')) continue;
		out.push({
			faceIndex: fi,
			name: f.name,
			manaCost: f.characteristics.manaCost || '{0}',
			unlocked: unlockedSet.has(fi)
		});
	}
	return out;
}

export function getPermanentUnlockableFaces(
	gameState: GameState,
	viewerId: string,
	perm: CardInstance
): UnlockableFaceView[] {
	if (perm.isFaceDown) return [];
	const effCard = effectiveCardForObject(perm);
	const compiled = compileCard(effCard);
	if (compiled.faces.length < 2) return [];
	const out: UnlockableFaceView[] = [];
	for (let fi = 0; fi < compiled.faces.length; fi++) {
		const f = compiled.faces[fi];
		const isLockedRoom =
			f.characteristics.subtypes.includes('Room') && !(perm.unlockedFaces ?? []).includes(fi);
		if (!isLockedRoom) continue;
		out.push({
			faceIndex: fi,
			name: f.name,
			manaCost: f.characteristics.manaCost || '',
			check: checkUnlockRoomDoorLegality(gameState, viewerId, perm, fi)
		});
	}
	return out;
}

function describeRestriction(restriction: string): { label: string; description: string } {
	if (restriction === 'artifactSpellOrNonSpell') {
		return {
			label: 'Artifact / Ability',
			description: "Artifact spells & abilities only — can't spend on nonartifact spells"
		};
	}
	const humanized = restriction
		.replace(/([A-Z])/g, ' $1')
		.replace(/^./, (ch) => ch.toUpperCase())
		.trim();
	return {
		label: humanized,
		description: `Restricted mana (${humanized})`
	};
}

function formatCostComponents(
	manaCosts: readonly string[],
	costDefs: readonly CostDef[],
	dedupeManaDefs = false
): string {
	const extraMana = dedupeManaDefs
		? []
		: costDefs.filter((d): d is Extract<CostDef, { k: 'mana' }> => d.k === 'mana').map((d) => d.cost);
	const allMana = [...manaCosts, ...extraMana];
	const nonManaDefs = costDefs.filter((d) => d.k !== 'mana');
	const parts: string[] = [];
	if (allMana.length > 0) parts.push(allMana.join(''));
	if (nonManaDefs.length > 0) parts.push(describeCost(nonManaDefs));
	return parts.join(', ');
}

/**
 * Pure per-mode additional cost readout for modal spells & abilities (`CR 700.2h` Spree / Tiered
 * `ModalDef.perModeCosts` and `CR 702.120` Escalate). Zero rules-text parsing or keyword literals.
 */
export function extractModalModeCostView(
	modal: ModalDef,
	options?: {
		card?: ScryfallCard;
		faceIndex?: number;
		selectedModes?: readonly number[];
	}
): ModalModeCostView {
	const card = options?.card;
	const faceIndex = options?.faceIndex ?? 0;
	const selectedModes = options?.selectedModes ?? [];

	const perModeBadges: Array<string | null> = modal.modes.map((_, idx) => {
		if (!modal.perModeCosts) return null;
		const defs = modal.perModeCosts[idx];
		if (!defs) return null;
		if (defs.length === 0) return '+ {0}';
		const formatted = formatCostComponents([], defs, false);
		return formatted ? `+ ${formatted}` : '+ {0}';
	});

	let escalateStepCost: string | null = null;
	let escalateBadge: string | null = null;
	let escalateDuplicatesManaDef = false;
	if (card && cardHasEscalate(card, faceIndex)) {
		const probeModal: ModalDef = modal.perModeCosts
			? { ...modal, perModeCosts: undefined }
			: modal;
		const step = computeModalModeAdditionalCosts(card, faceIndex, probeModal, [0, 1]);
		escalateDuplicatesManaDef = step.manaCosts.length > 0;
		const formatted = formatCostComponents(
			step.manaCosts,
			step.costDefs,
			escalateDuplicatesManaDef
		);
		if (formatted) {
			escalateStepCost = `+ ${formatted}`;
			escalateBadge = `+ ${formatted} per extra mode`;
		}
	}

	let selectedTotalCostBadge: string | null = null;
	if (selectedModes.length > 0) {
		if (card) {
			const total = computeModalModeAdditionalCosts(card, faceIndex, modal, [...selectedModes]);
			const formatted = formatCostComponents(
				total.manaCosts,
				total.costDefs,
				escalateDuplicatesManaDef
			);
			if (formatted) {
				selectedTotalCostBadge = `+ ${formatted}`;
			} else if (modal.perModeCosts) {
				selectedTotalCostBadge = '+ {0}';
			}
		} else if (modal.perModeCosts) {
			const defs: CostDef[] = [];
			for (const mIdx of selectedModes) {
				const entry = modal.perModeCosts[mIdx];
				if (entry) defs.push(...entry);
			}
			const formatted = formatCostComponents([], defs, false);
			selectedTotalCostBadge = formatted ? `+ ${formatted}` : '+ {0}';
		}
	}

	const hasModeCosts = perModeBadges.some((b) => b !== null) || escalateStepCost !== null;
	return {
		perModeBadges,
		escalateStepCost,
		escalateBadge,
		selectedTotalCostBadge,
		hasModeCosts
	};
}

/**
 * Resolves the battlefield permanent name haunted by an exiled card (`CR 702.55` Haunt),
 * respecting `hauntingTargetVersion` (`CR 400.7`) and phased-out status.
 */
export function resolveExileHauntingTargetName(
	gameState: GameState,
	exileCard: CardInstance,
	permanentsById?: Record<string, Pick<PermanentView, 'perm' | 'displayCard'>>
): string | null {
	const targetId = exileCard.hauntingTargetId;
	if (!targetId) return null;
	if (permanentsById) {
		const pv = permanentsById[targetId];
		if (!pv || pv.perm.phasedOut) return null;
		if (
			exileCard.hauntingTargetVersion !== undefined &&
			pv.perm.objectVersion !== undefined &&
			exileCard.hauntingTargetVersion !== pv.perm.objectVersion
		) {
			return null;
		}
		return pv.displayCard.name;
	}
	for (const p of gameState.players) {
		for (const perm of p.battlefield) {
			if (perm.instanceId !== targetId || perm.phasedOut) continue;
			if (
				exileCard.hauntingTargetVersion !== undefined &&
				perm.objectVersion !== undefined &&
				exileCard.hauntingTargetVersion !== perm.objectVersion
			) {
				return null;
			}
			if (perm.isFaceDown) {
				return perm.faceDownLabel || 'Face-Down Creature';
			}
			const effCard = effectiveCardForObject(perm);
			const faceOpts = {
				...instanceFaceOptions(perm, 'battlefield'),
				...(perm.isFlipped && effCard.layout === 'flip' ? { faceIndex: 1 } : {})
			};
			return resolveObjectFaces(effCard, faceOpts).name || effCard.name;
		}
	}
	return null;
}

function extractActiveDungeonView(player: PlayerGameState): ActiveDungeonView | null {
	const ad = player.activeDungeon;
	if (!ad) return null;
	const spec = DUNGEON_SPECS[ad.dungeonId];
	if (!spec) return null;
	const roomIdx = Math.max(0, Math.min(spec.rooms.length - 1, ad.roomIndex));
	const room = spec.rooms[roomIdx];
	return {
		dungeonId: ad.dungeonId,
		dungeonName: spec.name,
		roomIndex: roomIdx,
		roomName: room?.name ?? `Room ${roomIdx + 1}`,
		roomEffectText: room?.effectText ?? '',
		totalRooms: spec.rooms.length,
		pendingCompletion: Boolean(ad.pendingCompletion)
	};
}

function extractCompanionView(
	gameState: GameState,
	player: PlayerGameState,
	viewerId: string
): CompanionView | null {
	if (!player.companion || player.companionMovedToHand) {
		return null;
	}
	if (player.playerId !== viewerId) {
		return {
			card: player.companion,
			canMoveToHand: false,
			illegalityReason: 'Opponent designated card (CR 702.139a).'
		};
	}
	const legality = checkCompanionSpecialActionLegality(gameState, player.playerId);
	if (!legality.ok) {
		return {
			card: player.companion,
			canMoveToHand: false,
			illegalityReason: legality.reason ?? 'Cannot use special action right now.'
		};
	}
	const canPay = canPayOrAutoTap(player, parseManaCost('{3}'), gameState, undefined, {
		isSpell: false
	});
	if (!canPay) {
		return {
			card: player.companion,
			canMoveToHand: false,
			illegalityReason: 'Insufficient mana to pay {3} (CR 116.2g).'
		};
	}
	return {
		card: player.companion,
		canMoveToHand: true,
		illegalityReason: null
	};
}

function extractTopOfLibraryView(
	gameState: GameState,
	player: PlayerGameState,
	viewerId: string,
	viewerCanActNow: boolean
): TopOfLibraryView {
	const topVis = getPlayerTopOfLibraryVisibility(gameState, player.playerId);
	const isRevealedToAll = Boolean(
		topVis.revealToAll || isPlayerTopLibraryRevealedByGlobalStatic(gameState, player.playerId)
	);
	const isLookableByViewer = Boolean(
		topVis.lookByController && player.playerId === viewerId && !gameState.pendingCostPayment
	);
	const candidateTop = player.library[0] ?? null;
	const isKnownToViewer = Boolean(
		candidateTop && viewerId && candidateTop.knownToPlayerIds?.includes(viewerId)
	);
	const topCard =
		candidateTop && (isRevealedToAll || isLookableByViewer || isKnownToViewer)
			? candidateTop
			: null;
	const visibility: TopOfLibraryView['visibility'] = !topCard
		? 'hidden'
		: isRevealedToAll
			? 'revealed'
			: isLookableByViewer
				? 'look'
				: 'known';
	const isViewerLibrary = player.playerId === viewerId;
	const libraryLandPlayOptions =
		topCard && isViewerLibrary && viewerCanActNow
			? getLandPlayOptions(gameState, viewerId, topCard, 'library')
			: [];
	const libraryCastOptions =
		topCard && isViewerLibrary && viewerCanActNow
			? getCastOptions(gameState, viewerId, topCard, 'library')
			: [];
	const canPlayOrCast = libraryLandPlayOptions.length > 0 || libraryCastOptions.length > 0;
	return {
		topCard,
		card: topCard?.card ?? null,
		visibility,
		isRevealedToAll,
		isLookableByViewer,
		libraryLandPlayOptions,
		libraryCastOptions,
		canPlayOrCast
	};
}

function extractPlayerAttackTax(
	gameState: GameState,
	defenderPlayer: PlayerGameState
): { attackTaxPerCreature: string | null; attackTaxSources: string[] } {
	let genericTotal = 0;
	const manaSymbols: string[] = [];
	const sources: string[] = [];
	const defenderPlayerId = defenderPlayer.playerId;

	const pushSource = (name: string) => {
		if (name && !sources.includes(name)) sources.push(name);
	};

	const accumulateTaxParams = (
		params: Record<string, unknown> | undefined,
		controllerId: string,
		source: CardInstance | undefined,
		sourceName: string
	) => {
		let added = false;
		if (typeof params?.cost === 'string') {
			const parsed = parseManaCost(params.cost);
			if (parsed.generic > 0) {
				genericTotal += parsed.generic;
				added = true;
			}
			for (const col of ALL_MANA_COLORS) {
				const count = parsed.colored[col] || 0;
				for (let k = 0; k < count; k++) {
					manaSymbols.push(`{${col}}`);
					added = true;
				}
			}
		} else if (typeof params?.manaSymbol === 'string') {
			const sym = params.manaSymbol.startsWith('{')
				? params.manaSymbol
				: `{${params.manaSymbol}}`;
			const perUnit =
				params.dynamicAmount && source
					? Math.max(
							0,
							evaluateAmount(params.dynamicAmount as Amount, {
								state: gameState,
								controllerId,
								source
							})
						)
					: 1;
			for (let k = 0; k < perUnit; k++) {
				manaSymbols.push(sym);
				added = true;
			}
		} else {
			const base = typeof params?.generic === 'number' ? params.generic : 0;
			const dyn = params?.dynamicAmount as Amount | undefined;
			let unit = Math.max(0, base);
			if (dyn && source) {
				const mult = Math.max(
					0,
					evaluateAmount(dyn, {
						state: gameState,
						controllerId,
						source
					})
				);
				unit = base > 0 ? base * mult : mult;
			}
			if (unit > 0) {
				genericTotal += unit;
				added = true;
			}
		}
		if (added) pushSource(sourceName);
	};

	forEachActiveStaticOnBattlefield(
		gameState,
		(perm, controllerId, sourceName, def) => {
			if (def.k !== 'ruleModifier' || def.rule !== 'attackTax') return;
			if (
				def.condition &&
				!evaluateCondition(def.condition, { state: gameState, controllerId, source: perm })
			) {
				return;
			}
			const params = def.params;
			if (params?.affected === 'self' || params?.affected === 'attachedTo') return;
			const affectedFilter =
				params?.affected && typeof params.affected === 'object'
					? (params.affected as ObjectFilter)
					: undefined;
			const hasExplicitAffected = Boolean(params?.affected);
			const defendingMode =
				(params?.defending as
					| 'you'
					| 'planeswalkersYouControl'
					| 'youOrPlaneswalkersYouControl'
					| undefined) ?? (hasExplicitAffected ? undefined : 'you');

			if (defendingMode === 'planeswalkersYouControl') return;
			if (defendingMode === 'you' || defendingMode === 'youOrPlaneswalkersYouControl') {
				if (controllerId !== defenderPlayerId) return;
				if (affectedFilter?.controller === 'you') return;
			} else {
				// Global attack tax without defending restriction: verify opponents attacking defenderPlayerId are taxed.
				if (affectedFilter?.controller === 'you' && controllerId === defenderPlayerId) return;
				if (
					!hasExplicitAffected &&
					def.who.relation === 'you' &&
					controllerId === defenderPlayerId
				) {
					return;
				}
			}

			accumulateTaxParams(params, controllerId, perm, sourceName);
		},
		'ruleModifier',
		['attackTax']
	);

	// Check command-zone emblems controlled by defenderPlayer for attackTax rules.
	for (const cmdObj of defenderPlayer.command) {
		if (!cmdObj.isEmblem) continue;
		const compiled = compileCard(cmdObj.card);
		for (const face of compiled.faces) {
			for (const ab of face.abilities) {
				if (ab.kind !== 'static' || ab.static.k !== 'ruleModifier') continue;
				if (ab.static.rule !== 'attackTax') continue;
				accumulateTaxParams(
					ab.static.params,
					defenderPlayerId,
					cmdObj,
					cmdObj.card.name
				);
			}
		}
	}

	if (genericTotal <= 0 && manaSymbols.length === 0) {
		return { attackTaxPerCreature: null, attackTaxSources: [] };
	}
	const parts: string[] = [];
	if (genericTotal > 0) parts.push(`{${genericTotal}}`);
	for (const sym of manaSymbols) parts.push(sym);
	return {
		attackTaxPerCreature: parts.join(''),
		attackTaxSources: sources
	};
}

function describeSpellLockFilterShort(
	filter: ObjectFilter | undefined,
	source: CardInstance | null
): string {
	if (!filter) return '';
	if (filter.manaValueParity === 'even') return 'Even MV';
	if (filter.manaValueParity === 'odd') return 'Odd MV';
	if (filter.manaValueParity === 'chosenQuality') {
		if (source?.chosenParity === 'even') return 'Even MV';
		if (source?.chosenParity === 'odd') return 'Odd MV';
		return 'Chosen Parity';
	}
	if (filter.manaValueParity === 'notChosenQuality') {
		if (source?.chosenParity === 'even') return 'Odd MV';
		if (source?.chosenParity === 'odd') return 'Even MV';
		return 'Non-Chosen Parity';
	}
	if (filter.ofChosenColor) {
		return source?.chosenColor
			? (CHOSEN_COLOR_NAMES[source.chosenColor] ?? source.chosenColor)
			: 'Chosen Color';
	}
	if (filter.ofChosenType) {
		return source?.chosenSubType ?? 'Chosen Type';
	}
	if (filter.ofChosenName) {
		return source?.chosenCardName ? `"${source.chosenCardName}"` : 'Chosen Name';
	}
	if (filter.notTypes && filter.notTypes.length > 0) {
		if (filter.notTypes.length === 1) {
			return `Non${filter.notTypes[0].toLowerCase()}`;
		}
		return `Non-(${filter.notTypes.join('/')})`;
	}
	if (filter.types && filter.types.length > 0) {
		return filter.types.join('/');
	}
	if (filter.colors && filter.colors.length > 0) {
		return filter.colors.map((c) => CHOSEN_COLOR_NAMES[c] ?? c).join('/');
	}
	if (filter.castNotFromHand || filter.castFromOutsideHand) {
		return 'Non-Hand';
	}
	if (filter.castFromZoneFilter || filter.castFromZone) {
		const z = filter.castFromZoneFilter ?? filter.castFromZone ?? '';
		return z ? `${z.charAt(0).toUpperCase()}${z.slice(1)}` : 'Zone';
	}
	return 'Matching';
}

function extractPlayerStaticRuleTelemetry(
	gameState: GameState,
	player: PlayerGameState,
	cannotLoseGameThisTurn: boolean,
	lifeTotalCannotChangeThisTurn: boolean,
	turnShieldBadges: PlayerShieldBadge[]
): {
	staticCannotLoseGame: boolean;
	dontLoseAtZeroOrLessLife: boolean;
	staticLifeTotalLocked: boolean;
	unspentManaRetentionLabel: string | null;
	commanderTaxAsLifePerCast: number | null;
	activeRuleLocks: RuleLockBadge[];
} {
	const activeRuleLocks: RuleLockBadge[] = [];
	const pushLock = (badge: RuleLockBadge) => {
		if (!activeRuleLocks.some((b) => b.id === badge.id && b.label === badge.label)) {
			activeRuleLocks.push(badge);
		}
	};

	const cantLoseMods = activeRuleModifiers(gameState, 'cantLose', player.playerId);
	const staticCannotLoseGame = cantLoseMods.length > 0;
	if (staticCannotLoseGame) {
		const srcNames = Array.from(new Set(cantLoseMods.map((m) => m.sourceName))).join(', ');
		pushLock({
			id: 'cant_lose_static',
			label: "Can't Lose",
			description: `${player.username} can't lose the game (${srcNames})`,
			sourceName: cantLoseMods[0].sourceName,
			tone: 'gold'
		});
		if (!cannotLoseGameThisTurn) {
			turnShieldBadges.push({
				id: 'static_cant_lose',
				label: "Can't Lose",
				description: `Can't lose the game (${srcNames})`,
				tone: 'gold'
			});
		}
	}

	const zeroLifeMods = activeRuleModifiers(
		gameState,
		'dontLoseAtZeroOrLessLife',
		player.playerId
	);
	const dontLoseAtZeroOrLessLife =
		zeroLifeMods.length > 0 || playerDontLoseAtZeroOrLessLife(gameState, player.playerId);
	if (dontLoseAtZeroOrLessLife) {
		const srcNames =
			zeroLifeMods.length > 0
				? Array.from(new Set(zeroLifeMods.map((m) => m.sourceName))).join(', ')
				: 'Active static';
		pushLock({
			id: 'zero_life_safe',
			label: '≤0 Life Safe',
			description: `${player.username} doesn't lose the game for having 0 or less life (${srcNames})`,
			sourceName: zeroLifeMods[0]?.sourceName ?? null,
			tone: 'gold'
		});
		turnShieldBadges.push({
			id: 'static_zero_life_safe',
			label: '≤0 Life Safe',
			description: `Doesn't lose the game for having 0 or less life (${srcNames})`,
			tone: 'gold'
		});
	}

	const lifeLockMods = activeRuleModifiers(gameState, 'lifeTotalCantChange', player.playerId);
	const staticLifeTotalLocked = lifeLockMods.length > 0;
	if (staticLifeTotalLocked) {
		const srcNames = Array.from(new Set(lifeLockMods.map((m) => m.sourceName))).join(', ');
		pushLock({
			id: 'life_locked_static',
			label: 'Life Locked',
			description: `${player.username}'s life total can't change (${srcNames})`,
			sourceName: lifeLockMods[0].sourceName,
			tone: 'purple'
		});
		if (!lifeTotalCannotChangeThisTurn) {
			turnShieldBadges.push({
				id: 'static_life_locked',
				label: 'Life Locked',
				description: `Life total can't change (${srcNames})`,
				tone: 'purple'
			});
		}
	}

	// Unspent mana retention / conversion (CR 106.4 / CR 500.4)
	let unspentManaRetentionLabel: string | null = null;
	let manaRetentionSource: string | null = null;
	let manaRetentionDesc = '';
	forEachActiveStaticOnBattlefield(
		gameState,
		(perm, controllerId, sourceName, def) => {
			if (def.k !== 'retainUnspentMana') return;
			if (def.players !== 'all' && controllerId !== player.playerId) return;
			if (
				def.condition &&
				!evaluateCondition(def.condition, { state: gameState, controllerId, source: perm })
			) {
				return;
			}
			if (def.convertTo) {
				unspentManaRetentionLabel = `Mana → {${def.convertTo}}`;
				manaRetentionSource = sourceName;
				manaRetentionDesc = `Unspent mana becomes {${def.convertTo}} instead of emptying (${sourceName})`;
			} else if (def.colors === 'all') {
				unspentManaRetentionLabel = 'Retains Mana';
				manaRetentionSource = sourceName;
				manaRetentionDesc = `Doesn't lose unspent mana as steps and phases end (${sourceName})`;
			} else if (def.colors.length > 0 && !unspentManaRetentionLabel) {
				const symStr = def.colors.map((c) => `{${c}}`).join('');
				unspentManaRetentionLabel = `Retains ${symStr}`;
				manaRetentionSource = sourceName;
				manaRetentionDesc = `Doesn't lose unspent ${symStr} mana as steps and phases end (${sourceName})`;
			}
		},
		'retainUnspentMana'
	);
	if (!unspentManaRetentionLabel && player.unemptiedManaColorsThisTurn) {
		if (player.unemptiedManaColorsThisTurn === 'all') {
			unspentManaRetentionLabel = 'Retains Mana';
			manaRetentionDesc = "Doesn't lose unspent mana as steps and phases end this turn";
		} else if (player.unemptiedManaColorsThisTurn.length > 0) {
			const symStr = player.unemptiedManaColorsThisTurn.map((c) => `{${c}}`).join('');
			unspentManaRetentionLabel = `Retains ${symStr}`;
			manaRetentionDesc = `Doesn't lose unspent ${symStr} mana as steps and phases end this turn`;
		}
	}
	if (unspentManaRetentionLabel) {
		pushLock({
			id: 'retain_mana',
			label: unspentManaRetentionLabel,
			description: manaRetentionDesc,
			sourceName: manaRetentionSource,
			tone: 'green'
		});
	}

	// Spell-per-turn caps & cast locks
	const oneSpellMods = activeRuleModifiers(gameState, 'oneSpellPerTurn', player.playerId);
	if (oneSpellMods.length > 0) {
		const srcNames = Array.from(new Set(oneSpellMods.map((m) => m.sourceName))).join(', ');
		const castCount = player.spellsCastThisTurn ?? 0;
		pushLock({
			id: 'one_spell_per_turn',
			label: 'Max 1 Spell/Turn',
			description: `Can't cast more than 1 spell each turn (${castCount}/1 cast this turn — ${srcNames})`,
			sourceName: oneSpellMods[0].sourceName,
			tone: 'amber'
		});
	}

	const filteredCapMods = activeRuleModifiers(
		gameState,
		'filteredSpellCapPerTurn',
		player.playerId
	);
	for (const mod of filteredCapMods) {
		const max = typeof mod.def.params?.max === 'number' ? mod.def.params.max : 1;
		const filterShort = describeSpellLockFilterShort(
			mod.def.params?.filter as ObjectFilter | undefined,
			mod.source
		);
		const label = filterShort
			? `Max ${max} ${filterShort}/Turn`
			: `Max ${max} Spell${max === 1 ? '' : 's'}/Turn`;
		pushLock({
			id: `filtered_cap:${label}`,
			label,
			description: `Can't cast more than ${max} ${filterShort ? filterShort.toLowerCase() + ' ' : ''}spell${max === 1 ? '' : 's'} each turn (${mod.sourceName})`,
			sourceName: mod.sourceName,
			tone: 'amber'
		});
	}

	const cantCastMods = activeRuleModifiers(
		gameState,
		'cantCastMatchingSpells',
		player.playerId
	);
	for (const mod of cantCastMods) {
		const fromZones = mod.def.params?.fromZones as string[] | undefined;
		if (fromZones && fromZones.length > 0) {
			const zLabel =
				fromZones.includes('graveyard') && fromZones.includes('library')
					? 'No GY/Lib Cast'
					: fromZones.includes('graveyard')
						? 'No GY Cast'
						: `No ${fromZones.join('/')} Cast`;
			pushLock({
				id: `cant_cast_zones:${fromZones.join(',')}`,
				label: zLabel,
				description: `Can't cast spells from ${fromZones.join(' or ')} (${mod.sourceName})`,
				sourceName: mod.sourceName,
				tone: 'red'
			});
			continue;
		}
		const filterShort = describeSpellLockFilterShort(
			mod.def.params?.filter as ObjectFilter | undefined,
			mod.source
		);
		const label = filterShort ? `No ${filterShort} Spells` : 'Spell Lock';
		pushLock({
			id: `cant_cast:${label}`,
			label,
			description: `Can't cast ${filterShort ? filterShort.toLowerCase() + ' ' : ''}spells (${mod.sourceName})`,
			sourceName: mod.sourceName,
			tone: 'red'
		});
	}

	const chosenNameLockMods = activeRuleModifiers(
		gameState,
		'cantCastChosenName',
		player.playerId
	);
	for (const mod of chosenNameLockMods) {
		const chosen = mod.source?.chosenCardName;
		if (!chosen) continue;
		pushLock({
			id: `cant_cast_name:${chosen}`,
			label: `No "${chosen}"`,
			description: `Can't cast spells with the chosen name "${chosen}" (${mod.sourceName})`,
			sourceName: mod.sourceName,
			tone: 'red'
		});
	}

	const handOnlyMods = activeRuleModifiers(gameState, 'castOnlyFromHand', player.playerId);
	if (handOnlyMods.length > 0) {
		const srcNames = Array.from(new Set(handOnlyMods.map((m) => m.sourceName))).join(', ');
		pushLock({
			id: 'cast_only_from_hand',
			label: 'Hand Cast Only',
			description: `Can't cast spells from anywhere other than hand (${srcNames})`,
			sourceName: handOnlyMods[0].sourceName,
			tone: 'amber'
		});
	}

	const sorceryOnlyMods = activeRuleModifiers(
		gameState,
		'castOnlySorcerySpeed',
		player.playerId
	);
	if (sorceryOnlyMods.length > 0) {
		const srcNames = Array.from(new Set(sorceryOnlyMods.map((m) => m.sourceName))).join(', ');
		pushLock({
			id: 'cast_sorcery_only',
			label: 'Sorcery Speed Only',
			description: `Can cast spells only any time a sorcery could be cast (${srcNames})`,
			sourceName: sorceryOnlyMods[0].sourceName,
			tone: 'amber'
		});
	}

	const oppTurnMods = activeRuleModifiers(
		gameState,
		'opponentsCantCastDuringYourTurn',
		player.playerId
	);
	if (oppTurnMods.length > 0) {
		const activePid = gameState.players[gameState.activePlayerIndex]?.playerId;
		const lockedRightNow = oppTurnMods.some((m) => m.controllerId === activePid);
		const srcNames = Array.from(new Set(oppTurnMods.map((m) => m.sourceName))).join(', ');
		pushLock({
			id: 'opp_turn_lock',
			label: lockedRightNow ? 'No Cast This Turn' : 'No Opp-Turn Cast',
			description: `Can't cast spells during ${srcNames}'s controller's turn`,
			sourceName: oppTurnMods[0].sourceName,
			tone: lockedRightNow ? 'red' : 'amber'
		});
	}

	const noSearchMods = activeRuleModifiers(gameState, 'cantSearchLibraries', player.playerId);
	if (noSearchMods.length > 0) {
		const srcNames = Array.from(new Set(noSearchMods.map((m) => m.sourceName))).join(', ');
		pushLock({
			id: 'no_search',
			label: 'No Tutoring',
			description: `Can't search libraries (${srcNames})`,
			sourceName: noSearchMods[0].sourceName,
			tone: 'red'
		});
	}

	const noDrawMods = activeRuleModifiers(gameState, 'cantDrawCards', player.playerId);
	if (noDrawMods.length > 0) {
		const srcNames = Array.from(new Set(noDrawMods.map((m) => m.sourceName))).join(', ');
		pushLock({
			id: 'no_draws',
			label: 'No Draws',
			description: `Can't draw cards (${srcNames})`,
			sourceName: noDrawMods[0].sourceName,
			tone: 'red'
		});
	} else {
		const extraDrawMods = activeRuleModifiers(gameState, 'cantDrawExtraCards', player.playerId);
		if (extraDrawMods.length > 0) {
			const srcNames = Array.from(new Set(extraDrawMods.map((m) => m.sourceName))).join(', ');
			pushLock({
				id: 'no_extra_draws',
				label: 'Max 1 Draw/Turn',
				description: `Can't draw more than one card each turn (${srcNames})`,
				sourceName: extraDrawMods[0].sourceName,
				tone: 'amber'
			});
		}
	}

	const untapCapMods = activeRuleModifiers(gameState, 'untapStepCap', player.playerId);
	for (const mod of untapCapMods) {
		const max = typeof mod.def.params?.max === 'number' ? mod.def.params.max : 1;
		pushLock({
			id: `untap_cap:${max}`,
			label: `Untap Cap: ${max}`,
			description: `No more than ${max} permanent${max === 1 ? '' : 's'} untap during untap step (${mod.sourceName})`,
			sourceName: mod.sourceName,
			tone: 'cyan'
		});
	}

	let commanderTaxAsLifePerCast: number | null = null;
	forEachActiveStaticOnBattlefield(
		gameState,
		(perm, controllerId, _sourceName, def) => {
			if (def.k !== 'commanderTaxAsLife') return;
			if (controllerId !== player.playerId) return;
			if (
				def.condition &&
				!evaluateCondition(def.condition, { state: gameState, controllerId, source: perm })
			) {
				return;
			}
			if (
				commanderTaxAsLifePerCast === null ||
				def.lifePerCast < commanderTaxAsLifePerCast
			) {
				commanderTaxAsLifePerCast = def.lifePerCast;
			}
		},
		'commanderTaxAsLife'
	);

	return {
		staticCannotLoseGame,
		dontLoseAtZeroOrLessLife,
		staticLifeTotalLocked,
		unspentManaRetentionLabel,
		commanderTaxAsLifePerCast,
		activeRuleLocks
	};
}

function clampManaProvenanceByColor(
	raw: Partial<Record<ManaColor, number>> | undefined,
	pool: ManaPool
): { byColor: Partial<Record<ManaColor, number>>; total: number } {
	const byColor: Partial<Record<ManaColor, number>> = {};
	let total = 0;
	if (!raw) return { byColor, total };
	for (const color of ALL_MANA_COLORS) {
		const clamped = Math.max(0, Math.min(pool[color] || 0, raw[color] || 0));
		if (clamped > 0) {
			byColor[color] = clamped;
			total += clamped;
		}
	}
	return { byColor, total };
}

export interface CommanderTaxDisplay {
	castCount: number;
	isLifeTax: boolean;
	lifePerCast: number | null;
	totalLife: number;
	manaIncrement: number;
	badgeText: string;
	compactText: string;
}

export function formatCommanderTaxDisplay(
	gameState: GameState,
	player: PlayerGameState,
	cmd: CardInstance,
	statusCommanderTaxAsLifePerCast?: number | null,
	faceIndex = 0,
	fused = false
): CommanderTaxDisplay | null {
	const castCount = player.commanderCastCounts?.[cmd.instanceId] ?? cmd.commanderCastCount ?? 0;
	if (castCount <= 0) return null;
	const selfTax = getCommanderTaxLifeCostP20b(gameState, player, cmd, faceIndex, fused);
	let lifePerCast: number | null = statusCommanderTaxAsLifePerCast ?? null;
	if (selfTax.applies && castCount > 0) {
		const selfLifePerCast = Math.round(selfTax.totalLife / castCount);
		if (lifePerCast === null || selfLifePerCast < lifePerCast) {
			lifePerCast = selfLifePerCast;
		}
	}
	if (lifePerCast !== null) {
		const totalLife = Math.max(0, castCount * lifePerCast);
		return {
			castCount,
			isLifeTax: true,
			lifePerCast,
			totalLife,
			manaIncrement: 0,
			badgeText: `Tax: ${totalLife} life`,
			compactText: `Tax: ${totalLife} life`
		};
	}
	const manaIncrement = castCount * (gameState.rules.commanderTaxIncrement || 2);
	return {
		castCount,
		isLifeTax: false,
		lifePerCast: null,
		totalLife: 0,
		manaIncrement,
		badgeText: `Tax: +${manaIncrement}`,
		compactText: `+${manaIncrement}`
	};
}

function extractPlayerStatus(
	gameState: GameState,
	player: PlayerGameState,
	viewerId: string,
	viewerCanActNow: boolean
): { status: PlayerStatusView; topView: TopOfLibraryView } {
	const poison = player.poison || 0;
	const energyCounters = player.energyCounters || 0;
	const experienceCounters = player.experienceCounters || 0;
	const radCounters = (player as { radCounters?: number }).radCounters ?? 0;
	const isMonarch = gameState.monarchPlayerId === player.playerId;
	const hasInitiative = gameState.initiativePlayerId === player.playerId;
	const activeDungeon = extractActiveDungeonView(player);
	const completedDungeonNames = [...(player.completedDungeonNames ?? [])];
	const completedDungeonCount = Math.max(
		player.dungeonsCompletedCount ?? 0,
		completedDungeonNames.length
	);
	const speed = Math.max(0, player.speed ?? 0);
	const isMaxSpeed = speed >= 4;
	const hasCitysBlessing = Boolean(player.hasCitysBlessing);
	const hasEnduringStory = Boolean(player.hasEnduringStory);
	const cannotCastSpellsForRestOfGame = Boolean(player.cannotCastSpellsForRestOfGame);
	const epicSpellNames = (player.epicSpells ?? []).map(
		(entry) =>
			resolveObjectFaces(entry.card, { zone: 'stack', faceIndex: entry.faceIndex ?? 0 }).name ||
			entry.card.name
	);
	const ringLevel = Math.max(0, player.ringLevel ?? 0);
	const ringBearerId = player.ringBearerId ?? null;
	const ringAbilities = getRingAbilitiesForLevel(ringLevel);

	const snowManaTotal = totalSnowManaInPool(player);
	const snowManaByColor: Partial<Record<ManaColor, number>> = {};
	if (player.snowManaByColor) {
		for (const color of ALL_MANA_COLORS) {
			const clamped = Math.max(
				0,
				Math.min(player.manaPool[color] || 0, player.snowManaByColor[color] || 0)
			);
			if (clamped > 0) {
				snowManaByColor[color] = clamped;
			}
		}
	}

	// CR 106.6 source-provenance mana telemetry clamped against live `player.manaPool`
	const creatureProv = clampManaProvenanceByColor(player.creatureManaByColor, player.manaPool);
	const basicLandProv = clampManaProvenanceByColor(player.basicLandManaByColor, player.manaPool);
	const treasureProv = clampManaProvenanceByColor(player.treasureManaByColor, player.manaPool);
	let totalUnrestrictedPoolMana = 0;
	const nonZeroPoolColors: ManaColor[] = [];
	for (const color of ALL_MANA_COLORS) {
		const amt = Math.max(0, player.manaPool[color] || 0);
		if (amt > 0) {
			totalUnrestrictedPoolMana += amt;
			nonZeroPoolColors.push(color);
		}
	}
	const clampedScalarTreasure = Math.max(
		0,
		Math.min(totalUnrestrictedPoolMana, player.treasureManaInPool ?? 0)
	);
	const treasureManaTotal = Math.min(
		totalUnrestrictedPoolMana,
		Math.max(treasureProv.total, clampedScalarTreasure)
	);
	const treasureManaByColor: Partial<Record<ManaColor, number>> = { ...treasureProv.byColor };
	if (treasureManaTotal > treasureProv.total && nonZeroPoolColors.length === 1) {
		const onlyCol = nonZeroPoolColors[0];
		treasureManaByColor[onlyCol] = Math.min(
			player.manaPool[onlyCol] || 0,
			treasureManaTotal
		);
	}

	const commanders: CardInstance[] = [];
	const emblems: CardInstance[] = [];
	const dungeonCommandCards: CardInstance[] = [];
	for (const cmdObj of player.command) {
		if (cmdObj.isEmblem) {
			emblems.push(cmdObj);
		} else if (cmdObj.isDungeon) {
			dungeonCommandCards.push(cmdObj);
		} else {
			commanders.push(cmdObj);
		}
	}

	const restrictedManaEntries: RestrictedManaEntry[] = [];
	if (player.restrictedMana) {
		for (const [restriction, pool] of Object.entries(player.restrictedMana)) {
			if (!pool) continue;
			let total = 0;
			const colors: Array<{ color: ManaColor; amount: number }> = [];
			for (const color of ALL_MANA_COLORS) {
				const amount = pool[color] || 0;
				if (amount > 0) {
					total += amount;
					colors.push({ color, amount });
				}
			}
			if (total > 0) {
				const meta = describeRestriction(restriction);
				restrictedManaEntries.push({
					restriction,
					pool: { ...pool },
					total,
					colors,
					label: meta.label,
					description: meta.description
				});
			}
		}
	}

	const commanderDamageEntries: CommanderDamageEntry[] = [];
	const lethalThreshold = gameState.rules.commanderDamageLethal || 0;
	for (const [commanderId, dmg] of Object.entries(player.commanderDamageTaken || {})) {
		if (dmg > 0) {
			const fullName = player.commanderNames?.[commanderId] || 'Commander';
			const shortName = fullName.split(',')[0] || fullName;
			commanderDamageEntries.push({
				commanderId,
				commanderName: fullName,
				shortName,
				damage: dmg,
				lethalThreshold
			});
		}
	}

	const protectionFromEverythingThisTurn = Boolean(player.protectionFromEverythingThisTurn);
	const cannotLoseGameThisTurn = Boolean(player.cannotLoseGameThisTurn);
	const lifeTotalCannotChangeThisTurn = Boolean(player.lifeTotalCannotChangeThisTurn);
	const damagePreventionShield = Math.max(0, player.damagePreventionShield ?? 0);
	const preventAllCombatDamageThisTurn = Boolean(player.preventAllCombatDamageThisTurn);

	const turnShieldBadges: PlayerShieldBadge[] = [];
	if (protectionFromEverythingThisTurn) {
		turnShieldBadges.push({
			id: 'protection',
			label: 'Protection',
			description: 'Protection from everything until next turn',
			tone: 'gold'
		});
	}
	if (cannotLoseGameThisTurn) {
		turnShieldBadges.push({
			id: 'cant_lose',
			label: "Can't Lose",
			description: "Can't lose the game this turn",
			tone: 'gold'
		});
	}
	if (lifeTotalCannotChangeThisTurn) {
		turnShieldBadges.push({
			id: 'life_locked',
			label: 'Life Locked',
			description: "Life total can't change this turn",
			tone: 'purple'
		});
	}
	if (damagePreventionShield > 0) {
		turnShieldBadges.push({
			id: 'prevent_n',
			label: `Prevent ${damagePreventionShield}`,
			description: `Prevents the next ${damagePreventionShield} damage`,
			tone: 'cyan'
		});
	}
	if (preventAllCombatDamageThisTurn) {
		turnShieldBadges.push({
			id: 'prevent_combat',
			label: 'Fog Shield',
			description: 'Prevents all combat damage this turn',
			tone: 'green'
		});
	}

	const { attackTaxPerCreature, attackTaxSources } = extractPlayerAttackTax(gameState, player);
	const {
		staticCannotLoseGame,
		dontLoseAtZeroOrLessLife,
		staticLifeTotalLocked,
		unspentManaRetentionLabel,
		commanderTaxAsLifePerCast,
		activeRuleLocks
	} = extractPlayerStaticRuleTelemetry(
		gameState,
		player,
		cannotLoseGameThisTurn,
		lifeTotalCannotChangeThisTurn,
		turnShieldBadges
	);

	const companionView = extractCompanionView(gameState, player, viewerId);
	const topView = extractTopOfLibraryView(gameState, player, viewerId, viewerCanActNow);

	return {
		status: {
			playerId: player.playerId,
			username: player.username,
			life: player.life,
			poison,
			energyCounters,
			experienceCounters,
			radCounters,
			isMonarch,
			hasInitiative,
			activeDungeon,
			completedDungeonCount,
			completedDungeonNames,
			speed,
			isMaxSpeed,
			hasCitysBlessing,
			hasEnduringStory,
			cannotCastSpellsForRestOfGame,
			epicSpellNames,
			ringLevel,
			ringBearerId,
			ringAbilities,
			snowManaTotal,
			snowManaByColor,
			creatureManaTotal: creatureProv.total,
			creatureManaByColor: creatureProv.byColor,
			basicLandManaTotal: basicLandProv.total,
			basicLandManaByColor: basicLandProv.byColor,
			treasureManaTotal,
			treasureManaByColor,
			commanderTaxAsLifePerCast,
			commanders,
			emblems,
			dungeonCommandCards,
			restrictedManaEntries,
			commanderDamageEntries,
			protectionFromEverythingThisTurn,
			cannotLoseGameThisTurn,
			lifeTotalCannotChangeThisTurn,
			staticCannotLoseGame,
			dontLoseAtZeroOrLessLife,
			staticLifeTotalLocked,
			damagePreventionShield,
			preventAllCombatDamageThisTurn,
			turnShieldBadges,
			attackTaxPerCreature,
			attackTaxSources,
			unspentManaRetentionLabel,
			activeRuleLocks,
			companionView,
			topOfLibraryView: topView.topCard ? topView : null
		},
		topView
	};
}

function getZoneLegalActivatedAbilities(
	gameState: GameState,
	viewer: PlayerGameState,
	viewerCmdIdentity: ManaColor[],
	inst: CardInstance,
	zone: 'hand' | 'graveyard'
): EffectiveActivatedAbility[] {
	if (inst.zone !== zone) return [];
	return getEffectiveActivatedAbilities(gameState, viewer, inst, viewerCmdIdentity).filter(
		(ab) =>
			!ab.isManaAbility &&
			Boolean(ab.activationZones?.includes(zone)) &&
			checkAbilityActivationLegality(gameState, viewer.playerId, inst, ab).ok
	);
}

interface MemoEntry {
	signature: string;
	model: BoardViewModel;
}

const VIEW_MODEL_CACHE = new WeakMap<GameState, Map<string, MemoEntry>>();

function buildViewModelStateSignature(gameState: GameState, viewerId: string): string {
	const parts: Array<string | number | boolean> = [
		viewerId,
		gameState.status,
		gameState.turnNumber,
		gameState.turnSerial ?? 0,
		gameState.activePlayerIndex,
		gameState.priorityPlayerIndex,
		gameState.phase,
		gameState.monarchPlayerId ?? '',
		gameState.initiativePlayerId ?? '',
		gameState.dayNight ?? '',
		gameState.spellsCastByActivePlayerThisTurn ?? 0,
		gameState.prevTurnSpellsCastByActivePlayer ?? 0,
		gameState.stack.length,
		gameState.combat.active,
		gameState.combat.attackers.length,
		(gameState.combat.declaredBlockersPlayerIds ?? []).join(','),
		Boolean(gameState.pendingCostPayment),
		gameState.pendingPrompts
			.map(
				(pr) =>
					`${pr.id}:${pr.playerId}:${pr.kind}:${
						pr.choice?.kind === 'chooseObjects'
							? `${pr.choice.zone ?? ''}[${pr.choice.candidates.join(',')}]`
							: ''
					}`
			)
			.join(','),
		(gameState.timedKeywordEffects ?? []).length,
		(gameState.timedContinuousEffects ?? []).length,
		(gameState.timedContinuousEffects ?? [])
			.map(
				(ce) =>
					`${ce.timestamp}:${ce.layer2?.controllerId ?? ''}:${ce.layer6?.removeAllAbilities ? 1 : 0}:${(ce.layer6?.addKeywords ?? []).join(',')}:${(ce.layer6?.removeKeywords ?? []).join(',')}:${ce.sourceCondition?.broken ? 1 : 0}:${
						Array.isArray(ce.affected)
							? ce.affected.map((a) => `${a.instanceId}:${a.objectVersion ?? ''}`).join(',')
							: ''
					}`
			)
			.join(';')
	];
	for (const item of gameState.stack) {
		parts.push(item.id, item.targets.map((t) => t.id).join(','));
	}
	for (const atk of gameState.combat.attackers) {
		parts.push(
			atk.attackerInstanceId,
			atk.defenderPlayerId,
			atk.defenderPlaneswalkerId ?? '',
			atk.defenderBattleId ?? '',
			atk.blockerInstanceIds.join(',')
		);
	}
	for (const p of gameState.players) {
		const topLib = p.library[0];
		parts.push(
			p.playerId,
			p.lost,
			p.life,
			p.poison,
			p.energyCounters,
			p.experienceCounters,
			(p as { radCounters?: number }).radCounters ?? 0,
			p.speed ?? 0,
			p.hasCitysBlessing ?? false,
			p.hasEnduringStory ?? false,
			p.cannotCastSpellsForRestOfGame ?? false,
			(p.epicSpells ?? []).map((ep) => `${ep.card.id}:${ep.card.name}:${ep.faceIndex ?? 0}`).join(','),
			p.companion ? `${p.companion.id}:${p.companion.name}` : '',
			p.companionMovedToHand ?? false,
			(p.usedStaticPlaySlotsThisTurn ?? []).join(','),
			p.handCount ?? -1,
			p.libraryCount ?? -1,
			p.library.length,
			topLib
				? `${topLib.instanceId}:${topLib.objectVersion ?? 0}:${(topLib.knownToPlayerIds ?? []).join(',')}`
				: '',
			p.ringLevel ?? 0,
			p.ringBearerId ?? '',
			p.activeDungeon
				? `${p.activeDungeon.dungeonId}@${p.activeDungeon.roomIndex}:${p.activeDungeon.pendingCompletion ? 1 : 0}`
				: '',
			p.dungeonsCompletedCount ?? 0,
			(p.completedDungeonNames ?? []).join(','),
			totalSnowManaInPool(p),
			p.landsPlayedThisTurn,
			p.maxLandsPerTurn,
			p.spellsCastThisTurn ?? 0,
			(p.spellsCastThisTurnCards ?? []).length,
			p.unemptiedManaColorsThisTurn === 'all'
				? 'all'
				: (p.unemptiedManaColorsThisTurn ?? []).join(','),
			p.protectionFromEverythingThisTurn ?? false,
			p.cannotLoseGameThisTurn ?? false,
			p.lifeTotalCannotChangeThisTurn ?? false,
			p.damagePreventionShield ?? 0,
			p.preventAllCombatDamageThisTurn ?? false,
			p.manaPool.W,
			p.manaPool.U,
			p.manaPool.B,
			p.manaPool.R,
			p.manaPool.G,
			p.manaPool.C,
			p.treasureManaInPool ?? 0
		);
		if (p.snowManaByColor) {
			for (const col of ALL_MANA_COLORS) {
				const sv = p.snowManaByColor[col] || 0;
				if (sv) parts.push(`snow:${col}=${sv}`);
			}
		}
		if (p.creatureManaByColor) {
			for (const col of ALL_MANA_COLORS) {
				const cv = p.creatureManaByColor[col] || 0;
				if (cv) parts.push(`cmana:${col}=${cv}`);
			}
		}
		if (p.basicLandManaByColor) {
			for (const col of ALL_MANA_COLORS) {
				const bv = p.basicLandManaByColor[col] || 0;
				if (bv) parts.push(`blmana:${col}=${bv}`);
			}
		}
		if (p.treasureManaByColor) {
			for (const col of ALL_MANA_COLORS) {
				const tv = p.treasureManaByColor[col] || 0;
				if (tv) parts.push(`tmana:${col}=${tv}`);
			}
		}
		if (p.restrictedMana) {
			for (const [rk, rpool] of Object.entries(p.restrictedMana)) {
				if (!rpool) continue;
				parts.push(rk, rpool.W, rpool.U, rpool.B, rpool.R, rpool.G, rpool.C);
			}
		}
		for (const [cid, cdmg] of Object.entries(p.commanderDamageTaken || {})) {
			parts.push(cid, cdmg);
		}
		for (const [cid, ccnt] of Object.entries(p.commanderCastCounts || {})) {
			parts.push(`cc:${cid}=${ccnt}`);
		}
		for (const perm of p.battlefield) {
			parts.push(
				perm.instanceId,
				perm.objectVersion ?? 0,
				perm.ownerId,
				perm.controllerId,
				perm.protectorId ?? '',
				perm.tapped,
				perm.summoningSick,
				perm.damageMarked,
				perm.tempPowerMod,
				perm.tempToughnessMod,
				perm.attachedToId ?? '',
				perm.phasedOut ?? false,
				perm.isFaceDown ?? false,
				perm.faceDownLabel ?? '',
				perm.transformed,
				perm.activeFaceIndex ?? 0,
				(perm.unlockedFaces ?? []).join(','),
				perm.isPrepared ?? false,
				perm.prototyped ?? false,
				perm.copiableState?.prototyped ?? false,
				perm.copiableCard ? `${perm.copiableCard.id}:${perm.copiableCard.name}` : '',
				perm.regenerationShields ?? 0,
				perm.chosenCardName ?? '',
				perm.chosenSubType ?? '',
				perm.chosenColor ?? '',
				perm.chosenAnchorWord ?? '',
				perm.chosenPlayerId ?? '',
				perm.chosenParity ?? '',
				perm.doesntUntapNextUntapStep ?? false,
				(perm.doesntUntapWhileSource ?? [])
					.map(
						(d) =>
							`${d.sourceInstanceId}:${d.sourceObjectVersion}:${d.kind}:${d.controllerId}:${d.broken ? 1 : 0}`
					)
					.join(','),
				perm.assimilatedBy
					? `${perm.assimilatedBy.sourceInstanceId}:${perm.assimilatedBy.sourceObjectVersion}`
					: '',
				perm.assignsNoCombatDamageThisTurn ?? false,
				perm.mustAttackThisTurn ?? false,
				perm.mustBlockThisTurn ?? false,
				perm.mustBeBlockedThisTurn ?? false,
				(perm.cantBlockAttackerIdsThisTurn ?? []).join(','),
				perm.isMonstrous ?? false,
				perm.usedLoyaltyThisTurn,
				(perm.activatedAbilityIdsThisTurn ?? []).join(','),
				(perm.goadedByPlayerIds ?? []).join(','),
				perm.saddledThisTurn ?? false,
				(perm.grantedKeywords ?? []).join(','),
				perm.classLevel ?? -1,
				perm.isSolved ?? false,
				(perm.mergedComponents ?? []).map((mc) => `${mc.id}:${mc.name}`).join(','),
				(perm.copiableState?.mergedComponents ?? []).map((mc) => `${mc.id}:${mc.name}`).join(','),
				perm.mutateCount ?? -1,
				(perm.meldedComponents ?? []).map((mc) => `${mc.id}:${mc.name}`).join(','),
				perm.isFlipped ?? false,
				perm.pairedWithId ?? '',
				(perm.hauntedByCards ?? []).map((hc) => `${hc.id}:${hc.name}`).join(','),
				perm.isSuspected ?? false,
				perm.isHarnessed ?? false,
				perm.isRenowned ?? false,
				perm.hasEnduringStory ?? false
			);
			for (const [ct, cv] of Object.entries(perm.counters || {})) {
				if (cv) parts.push(`${ct}=${cv}`);
			}
		}
		for (const c of p.hand) {
			parts.push(c.instanceId, c.objectVersion ?? 0, (c.knownToPlayerIds ?? []).join(','));
		}
		for (const c of p.graveyard) {
			parts.push(c.instanceId, c.objectVersion ?? 0);
		}
		for (const c of p.exile) {
			parts.push(
				c.instanceId,
				c.objectVersion ?? 0,
				c.playableFromExileBy?.playerId ?? '',
				c.foretoldByPlayerId ?? '',
				c.foretoldTurnNumber ?? -1,
				c.plottedByPlayerId ?? '',
				c.plottedTurnNumber ?? -1,
				c.isSuspended ?? false,
				c.hauntingTargetId ?? '',
				c.hauntingTargetVersion ?? -1,
				c.exiledBy?.sourceInstanceId ?? '',
				c.exiledBy?.sourceObjectVersion ?? -1,
				c.isFaceDown ?? false,
				(c.knownToPlayerIds ?? []).join(','),
				c.copiableCard ? `${c.copiableCard.id}:${c.copiableCard.name}` : ''
			);
		}
		for (const c of p.command) {
			parts.push(
				c.instanceId,
				c.commanderCastCount,
				c.isEmblem ?? false,
				c.isRingEmblem ?? false,
				c.isDungeon ?? false,
				c.card.name
			);
		}
	}
	return parts.join('|');
}

/**
 * Computes the memoized `BoardViewModel` for `viewerId` in one O(B) battlefield pass,
 * evaluating each permanent via `evaluatePermanent` exactly once inside a single
 * `withStableLayerInputs` scope.
 */
export function buildBoardViewModel(gameState: GameState, viewerId: string): BoardViewModel {
	const resolvedViewer =
		gameState.players.find((p) => p.playerId === viewerId) ?? gameState.players[0];
	const effectiveViewerId = resolvedViewer?.playerId ?? viewerId;

	const sig = buildViewModelStateSignature(gameState, effectiveViewerId);
	let perState = VIEW_MODEL_CACHE.get(gameState);
	if (!perState) {
		perState = new Map<string, MemoEntry>();
		VIEW_MODEL_CACHE.set(gameState, perState);
	}
	const hit = perState.get(effectiveViewerId);
	if (hit && hit.signature === sig) {
		return hit.model;
	}

	const model = withStableLayerInputs(gameState, () =>
		computeBoardViewModelInner(gameState, resolvedViewer, effectiveViewerId)
	);
	perState.set(effectiveViewerId, { signature: sig, model });
	return model;
}

function computeBoardViewModelInner(
	gameState: GameState,
	viewer: PlayerGameState | undefined,
	viewerId: string
): BoardViewModel {
	const attachmentsByHostId: Record<string, CardInstance[]> = {};
	const hostByAttachmentId: Record<string, CardInstance> = {};
	const permanentsById: Record<string, PermanentView> = {};
	const frontRow: PermanentView[] = [];
	const backRow: PermanentView[] = [];
	const opponentBoardsById: Record<string, PermanentView[]> = {};
	const playerStatusesById: Record<string, PlayerStatusView> = {};
	const topOfLibraryByPlayerId: Record<string, TopOfLibraryView> = {};
	const revealedOpponentHandsByPlayerId: Record<string, CardInstance[]> = {};

	// Waiting status: players with active pendingPrompts when viewer has none.
	const viewerHasPrompt = gameState.pendingPrompts.some((pr) => pr.playerId === viewerId);
	const waitingOnPlayerIds: string[] = [];
	if (!viewerHasPrompt) {
		for (const pr of gameState.pendingPrompts) {
			if (!waitingOnPlayerIds.includes(pr.playerId)) {
				waitingOnPlayerIds.push(pr.playerId);
			}
		}
	}

	const activePlayer = gameState.players[gameState.activePlayerIndex];
	const priorityPlayer = gameState.players[gameState.priorityPlayerIndex];
	const hasPriority = priorityPlayer?.playerId === viewerId;
	const isViewerTurn = activePlayer?.playerId === viewerId;
	const viewerCanActNow = Boolean(
		viewer &&
			!viewer.lost &&
			gameState.status === 'active' &&
			hasPriority &&
			gameState.pendingPrompts.length === 0
	);
	const viewerCmdIdentity = viewer ? getPlayerCommanderIdentity(viewer) : [];

	const activeHandCandidateIds = new Set<string>();
	for (const pr of gameState.pendingPrompts) {
		if (
			pr.playerId === viewerId &&
			pr.choice?.kind === 'chooseObjects' &&
			pr.choice.zone === 'hand'
		) {
			for (const cid of pr.choice.candidates) {
				activeHandCandidateIds.add(cid);
			}
		}
	}

	// Step 1 (O(B)): Index all active battlefield permanents by instanceId, extract player status & visibility, and link attachments in O(B).
	const activeById = new Map<string, CardInstance>();
	for (const player of gameState.players) {
		const { status, topView } = extractPlayerStatus(gameState, player, viewerId, viewerCanActNow);
		playerStatusesById[player.playerId] = status;
		topOfLibraryByPlayerId[player.playerId] = topView;
		if (player.playerId !== viewerId) {
			const fullHandRevealed = isPlayerHandRevealedToViewer(gameState, player.playerId, viewerId);
			revealedOpponentHandsByPlayerId[player.playerId] = fullHandRevealed
				? [...player.hand]
				: player.hand.filter(
						(c) =>
							Boolean(c.knownToPlayerIds?.includes(viewerId)) ||
							activeHandCandidateIds.has(c.instanceId)
					);
		}
		for (const perm of player.battlefield) {
			if (!perm.phasedOut) {
				activeById.set(perm.instanceId, perm);
			}
		}
	}

	for (const player of gameState.players) {
		for (const perm of player.battlefield) {
			if (!perm.phasedOut && perm.attachedToId) {
				const host = activeById.get(perm.attachedToId);
				if (host) {
					(attachmentsByHostId[perm.attachedToId] ??= []).push(perm);
					hostByAttachmentId[perm.instanceId] = host;
				}
			}
		}
	}

	const activeFlagbearerIds = new Set<string>(getRequiredFlagbearerIdsForActor(gameState, viewerId));
	let probedOtherActor = false;
	for (const pl of gameState.players) {
		if (!pl.lost && pl.playerId !== viewerId) {
			probedOtherActor = true;
			for (const fid of getRequiredFlagbearerIdsForActor(gameState, pl.playerId)) {
				activeFlagbearerIds.add(fid);
			}
		}
	}
	if (!probedOtherActor) {
		for (const fid of getRequiredFlagbearerIdsForActor(gameState, '__other_actor_probe__')) {
			activeFlagbearerIds.add(fid);
		}
	}

	const isAttackStepReady =
		viewerCanActNow &&
		gameState.phase === 'declare_attackers' &&
		isViewerTurn &&
		!gameState.combat.active &&
		gameState.stack.length === 0;

	const isBlockStepReady =
		viewerCanActNow &&
		gameState.phase === 'declare_blockers' &&
		!isViewerTurn &&
		gameState.combat.active &&
		gameState.stack.length === 0 &&
		!(gameState.combat.declaredBlockersPlayerIds || []).includes(viewerId) &&
		gameState.combat.attackers.some((a) => a.defenderPlayerId === viewerId);

	const freezeSourceIdsByPermId: Record<string, string[]> = {};
	const assimilatedSourceIdByPermId: Record<string, string> = {};
	const cantBlockIdsByPermId: Record<string, string[]> = {};

	// Step 1.5 (O(E)): Index linked exile cards across all players by `${sourceInstanceId}:${sourceObjectVersion}` (CR 607.2a),
	// strictly enforcing CR 406.3 face-down exile secrecy relative to `viewerId`.
	const linkedExileLabelsBySourceKey = new Map<string, string[]>();
	for (const exOwner of gameState.players) {
		for (const exCard of exOwner.exile) {
			const link = exCard.exiledBy;
			if (!link) continue;
			const key = `${link.sourceInstanceId}:${link.sourceObjectVersion}`;
			let labels = linkedExileLabelsBySourceKey.get(key);
			if (!labels) {
				labels = [];
				linkedExileLabelsBySourceKey.set(key, labels);
			}
			const isHiddenFaceDown =
				Boolean(exCard.isFaceDown) &&
				!(viewerId && exCard.knownToPlayerIds?.includes(viewerId));
			if (isHiddenFaceDown) {
				labels.push('Face-down card');
			} else {
				labels.push(effectiveCardForObject(exCard).name);
			}
		}
	}

	// Step 2 (O(B)): Evaluate every permanent ONCE and partition into viewer frontRow/backRow and opponent boards.
	for (const player of gameState.players) {
		const isViewerBoard = player.playerId === viewerId;
		const oppList: PermanentView[] | null = isViewerBoard ? null : [];
		if (oppList) {
			opponentBoardsById[player.playerId] = oppList;
		}

		for (const perm of player.battlefield) {
			const evaluated = evaluatePermanent(gameState, perm);
			const effCard = effectiveCardForObject(perm);
			const faceOpts = {
				...instanceFaceOptions(perm, 'battlefield'),
				...(perm.isFlipped && effCard.layout === 'flip' ? { faceIndex: 1 } : {})
			};
			const faceView = resolveObjectFaces(effCard, faceOpts);
			const isFaceDown = Boolean(perm.isFaceDown);
			const displayCard: PermanentDisplayCard = isFaceDown
				? {
						card: effCard,
						name: perm.faceDownLabel || faceView.name || effCard.name,
						imageUrl: FACE_DOWN_ART_URI,
						artCropUrl: FACE_DOWN_ART_URI,
						typeLine: evaluated.effectiveTypeLine,
						isFaceDown: true
					}
				: {
						card: effCard,
						name: faceView.name || effCard.name,
						imageUrl: faceView.imageUrl || effCard.imageUrl,
						artCropUrl:
							faceView.artCropUrl || effCard.artCropUrl || faceView.imageUrl || effCard.imageUrl,
						typeLine: evaluated.effectiveTypeLine,
						isFaceDown: false
					};

			const { types, subtypes } = parseTypesAndSubtypes(evaluated.effectiveTypeLine);
			const hasDefender = evaluated.keywords.some((kw) => kw.toLowerCase() === 'defender');
			const hasHaste = evaluated.keywords.some((kw) => kw.toLowerCase() === 'haste');
			const isCreature = evaluated.isCreature;
			const isPlaneswalker = evaluated.isPlaneswalker;
			const isBattle = types.includes('Battle');
			const isEquipment = evaluated.hasSubType('Equipment');
			const power = evaluated.power;
			const toughness = evaluated.toughness;
			const displayToughness = toughness - (perm.damageMarked || 0);
			const isSummoningSickVisual = Boolean(perm.summoningSick && isCreature && !hasHaste);
			const countersList = extractCounterBadges(perm.counters);

			// CR 717 (Class) & CR 720 (Case)
			const classLevel =
				!isFaceDown && (subtypes.includes('Class') || perm.classLevel !== undefined)
					? Math.max(1, perm.classLevel ?? 1)
					: null;
			const caseSolved =
				!isFaceDown && (subtypes.includes('Case') || perm.isSolved !== undefined)
					? Boolean(perm.isSolved)
					: null;

			// CR 731 (Mutate Merged Permanents), CR 713 (Meld), & CR 710 (Flip)
			const effMerged = !isFaceDown
				? perm.copiableState
					? perm.copiableState.mergedComponents
					: perm.mergedComponents
				: undefined;
			const mergedComponentNames =
				effMerged && effMerged.length > 1 ? effMerged.map((mc) => mc.name) : [];
			const mutateCount =
				perm.mutateCount !== undefined
					? Math.max(0, perm.mutateCount)
					: !isFaceDown && !perm.copiableState && (perm.mergedComponents?.length ?? 0) > 1
						? perm.mergedComponents!.length - 1
						: 0;
			const meldedComponentNames =
				!isFaceDown && perm.meldedComponents && perm.meldedComponents.length > 0
					? perm.meldedComponents.map((mc) => mc.name)
					: [];
			const isFlipped = Boolean(
				!isFaceDown &&
					(perm.isFlipped || (faceView.layout === 'flip' && activeFaceIndexForObject(perm) === 1))
			);

			// CR 702.95 (Soulbond), CR 702.55 (Haunt), CR 701.60 (Suspect), CR 701.15 (Goad), CR 701.64 (Harness), CR 702.112 (Renown), CR 702.195 (Storied)
			const pairedWithId =
				!perm.phasedOut && perm.pairedWithId && activeById.has(perm.pairedWithId)
					? perm.pairedWithId
					: null;
			const hauntedByNames = (perm.hauntedByCards ?? []).map((hc) => hc.name);
			const isSuspected = Boolean(perm.isSuspected);
			const isGoaded = Boolean(perm.goadedByPlayerIds && perm.goadedByPlayerIds.length > 0);
			const goadedByNames = isGoaded
				? (perm.goadedByPlayerIds ?? [])
						.map((pid) => gameState.players.find((pl) => pl.playerId === pid)?.username ?? pid)
				: [];
			const isHarnessed = Boolean(perm.isHarnessed);
			const isRenowned = Boolean(perm.isRenowned);
			const hasEnduringStory = Boolean(perm.hasEnduringStory);
			const isSaddled = Boolean(perm.saddledThisTurn);
			const controllerPlayer = gameState.players.find((pl) => pl.playerId === evaluated.controllerId);
			const isRingBearer = Boolean(
				!perm.phasedOut &&
					isCreature &&
					controllerPlayer &&
					controllerPlayer.ringBearerId === perm.instanceId
			);
			const isPrepared = Boolean(perm.isPrepared);
			const isPrototyped = Boolean(!isFaceDown && (perm.prototyped || perm.copiableState?.prototyped));
			const regenerationShields = Math.max(0, perm.regenerationShields ?? 0);
			const isFlagbearer = Boolean(!perm.phasedOut && activeFlagbearerIds.has(perm.instanceId));
			const chosenDescriptor = !isFaceDown
				? formatPermanentChosenDescriptor(perm, gameState.players)
				: null;
			const isStolen = Boolean(perm.ownerId && perm.ownerId !== evaluated.controllerId);
			const ownerName = perm.ownerId
				? (gameState.players.find((pl) => pl.playerId === perm.ownerId)?.username ?? perm.ownerId)
				: null;
			const activeFreezeSourceIds: string[] = [];
			if (!perm.phasedOut && perm.doesntUntapWhileSource && perm.doesntUntapWhileSource.length > 0) {
				for (const entry of perm.doesntUntapWhileSource) {
					if (entry.broken) continue;
					if (
						isP16aSourceConditionCurrentlyMet(
							gameState,
							entry.sourceInstanceId,
							entry.sourceObjectVersion,
							entry.kind,
							entry.controllerId
						)
					) {
						if (!activeFreezeSourceIds.includes(entry.sourceInstanceId)) {
							activeFreezeSourceIds.push(entry.sourceInstanceId);
						}
					}
				}
			}
			if (activeFreezeSourceIds.length > 0) {
				freezeSourceIdsByPermId[perm.instanceId] = activeFreezeSourceIds;
			}
			const isFrozen =
				Boolean(perm.doesntUntapNextUntapStep) || activeFreezeSourceIds.length > 0;
			if (!perm.phasedOut && perm.assimilatedBy) {
				const assimSrc = activeById.get(perm.assimilatedBy.sourceInstanceId);
				if (assimSrc && (assimSrc.objectVersion ?? 1) === perm.assimilatedBy.sourceObjectVersion) {
					assimilatedSourceIdByPermId[perm.instanceId] = assimSrc.instanceId;
				}
			}
			const assignsNoCombatDamageThisTurn = Boolean(perm.assignsNoCombatDamageThisTurn);
			const mustAttackThisTurn = Boolean(perm.mustAttackThisTurn);
			const mustBlockThisTurn = Boolean(perm.mustBlockThisTurn);
			const mustBeBlockedThisTurn = Boolean(perm.mustBeBlockedThisTurn);
			const uniqueCantBlockIds: string[] = [];
			if (perm.cantBlockAttackerIdsThisTurn && perm.cantBlockAttackerIdsThisTurn.length > 0) {
				for (const aid of perm.cantBlockAttackerIdsThisTurn) {
					if (aid && !uniqueCantBlockIds.includes(aid)) {
						uniqueCantBlockIds.push(aid);
					}
				}
			}
			if (uniqueCantBlockIds.length > 0) {
				cantBlockIdsByPermId[perm.instanceId] = uniqueCantBlockIds;
			}
			const cantBlockAttackerCount = uniqueCantBlockIds.length;
			const isMonstrous = Boolean(perm.isMonstrous);
			const linkedExileRaw = linkedExileLabelsBySourceKey.get(
				`${perm.instanceId}:${perm.objectVersion ?? 1}`
			);
			const linkedExileLabels = linkedExileRaw ? [...linkedExileRaw] : [];
			const linkedExileCount = linkedExileLabels.length;
			const protectorId = isBattle ? (perm.protectorId ?? null) : null;
			const protectorPlayer = protectorId
				? gameState.players.find((pl) => pl.playerId === protectorId)
				: undefined;
			const protectorName = protectorPlayer?.username ?? null;
			// CR 310.8b: A battle can be attacked by any player EXCEPT its protector, regardless of who controls it.
			const canBeAttackedAsBattle = Boolean(
				isBattle &&
					!perm.phasedOut &&
					protectorId &&
					protectorId !== viewerId &&
					protectorPlayer &&
					!protectorPlayer.lost
			);
			const roomDoors = getPermanentRoomDoors(perm);
			const attachments = attachmentsByHostId[perm.instanceId] ?? [];
			const host = hostByAttachmentId[perm.instanceId] ?? null;

			let actableSummary: PermanentActableSummary;
			if (isViewerBoard && viewer && !perm.phasedOut) {
				const activatedAbilities = getEffectiveActivatedAbilities(
					gameState,
					viewer,
					perm,
					viewerCmdIdentity
				);
				const legalActivatedAbilityIds = viewerCanActNow
					? activatedAbilities
							.filter((ab) => checkAbilityActivationLegality(gameState, viewerId, perm, ab).ok)
							.map((ab) => ab.id)
					: [];
				const turnFaceUp = getTurnFaceUpDisplay(gameState, viewerId, perm);
				const unlockableFaces = getPermanentUnlockableFaces(gameState, viewerId, perm);

				let preparationCopyOption: CastOption | null = null;
				let preparationCopyFaceName: string | null = null;
				let preparationCopyManaCost: string | null = null;
				let preparationCopyCheck: { ok: boolean; error?: string } | null = null;
				if (isPrepared) {
					const baseCard = perm.copiableCard ?? perm.card;
					if ((baseCard.layout ?? 'normal') === 'prepare') {
						const prepFace = compileCard(baseCard).faces[1];
						if (prepFace) {
							preparationCopyFaceName = prepFace.name;
							preparationCopyManaCost = prepFace.characteristics.manaCost || '{0}';
							if (viewerCanActNow) {
								const prepOpts = getCastOptions(gameState, viewerId, perm, 'battlefield');
								preparationCopyOption =
									prepOpts.find(
										(o) =>
											o.permission === 'preparation_copy' || o.id === 'battlefield:prepare_copy'
									) ?? null;
								preparationCopyCheck = preparationCopyOption
									? { ok: true }
									: checkSpellCastLegality(
											gameState,
											viewerId,
											perm,
											'battlefield',
											0,
											'battlefield:prepare_copy',
											undefined,
											1
										);
							} else {
								preparationCopyCheck = checkSpellCastLegality(
									gameState,
									viewerId,
									perm,
									'battlefield',
									0,
									'battlefield:prepare_copy',
									undefined,
									1
								);
							}
						}
					}
				}

				const canAttackNow = Boolean(
					isAttackStepReady &&
						isCreature &&
						!perm.tapped &&
						(!perm.summoningSick || hasHaste) &&
						!hasDefender
				);
				const canBlockNow = Boolean(isBlockStepReady && isCreature && !perm.tapped);
				const isSingleTapManaOnly = Boolean(
					activatedAbilities.length === 1 &&
						activatedAbilities[0].isManaAbility &&
						unlockableFaces.length === 0 &&
						!turnFaceUp &&
						preparationCopyFaceName === null
				);
				const isActable = Boolean(
					viewerCanActNow &&
						(canAttackNow ||
							canBlockNow ||
							legalActivatedAbilityIds.length > 0 ||
							unlockableFaces.some((d) => d.check.ok) ||
							turnFaceUp?.legal ||
							preparationCopyOption !== null)
				);
				actableSummary = {
					activatedAbilities,
					legalActivatedAbilityIds,
					turnFaceUp,
					unlockableFaces,
					preparationCopyOption,
					preparationCopyFaceName,
					preparationCopyManaCost,
					preparationCopyCheck,
					canAttackNow,
					canBlockNow,
					isSingleTapManaOnly,
					isActable
				};
			} else {
				actableSummary = {
					activatedAbilities: [],
					legalActivatedAbilityIds: [],
					turnFaceUp: null,
					unlockableFaces: [],
					preparationCopyOption: null,
					preparationCopyFaceName: null,
					preparationCopyManaCost: null,
					preparationCopyCheck: null,
					canAttackNow: false,
					canBlockNow: false,
					isSingleTapManaOnly: false,
					isActable: false
				};
			}

			const permView: PermanentView = {
				instanceId: perm.instanceId,
				perm,
				controllerId: evaluated.controllerId,
				evaluated,
				displayCard,
				types,
				subtypes,
				colors: evaluated.colors,
				hasLostAllAbilities: evaluated.hasLostAllAbilities,
				isCreature,
				isPlaneswalker,
				isBattle,
				isEquipment,
				power,
				toughness,
				displayToughness,
				hasDefender,
				hasHaste,
				isSummoningSickVisual,
				countersList,
				classLevel,
				caseSolved,
				mergedComponentNames,
				mutateCount,
				meldedComponentNames,
				isFlipped,
				pairedWithId,
				pairedPartnerName: null,
				hauntedByNames,
				isSuspected,
				isGoaded,
				goadedByNames,
				isHarnessed,
				isRenowned,
				hasEnduringStory,
				isSaddled,
				isRingBearer,
				isPrepared,
				isPrototyped,
				regenerationShields,
				isFlagbearer,
				chosenDescriptor,
				isStolen,
				ownerName,
				isFrozen,
				frozenBySourceNames: [],
				assimilatedBySourceName: null,
				assignsNoCombatDamageThisTurn,
				mustAttackThisTurn,
				mustBlockThisTurn,
				mustBeBlockedThisTurn,
				cantBlockAttackerCount,
				cantBlockAttackerNames: [],
				isMonstrous,
				linkedExileCount,
				linkedExileLabels,
				protectorId,
				protectorName,
				canBeAttackedAsBattle,
				roomDoors,
				attachments,
				host,
				actableSummary
			};

			permanentsById[perm.instanceId] = permView;
			if (isViewerBoard) {
				if (isCreature || isPlaneswalker) {
					frontRow.push(permView);
				} else {
					backRow.push(permView);
				}
			} else if (oppList) {
				oppList.push(permView);
			}
		}
	}

	// Resolve Soulbond partner names and P16a source-linked names in O(B) using already-evaluated `permanentsById` views.
	for (const pv of Object.values(permanentsById)) {
		if (pv.pairedWithId) {
			pv.pairedPartnerName = permanentsById[pv.pairedWithId]?.displayCard.name ?? null;
		}
		const freezeSrcIds = freezeSourceIdsByPermId[pv.instanceId];
		if (freezeSrcIds) {
			pv.frozenBySourceNames = freezeSrcIds.map(
				(sid) => permanentsById[sid]?.displayCard.name ?? activeById.get(sid)?.card.name ?? sid
			);
		}
		const assimSrcId = assimilatedSourceIdByPermId[pv.instanceId];
		if (assimSrcId) {
			pv.assimilatedBySourceName =
				permanentsById[assimSrcId]?.displayCard.name ??
				activeById.get(assimSrcId)?.card.name ??
				assimSrcId;
		}
		const cantBlkIds = cantBlockIdsByPermId[pv.instanceId];
		if (cantBlkIds) {
			pv.cantBlockAttackerNames = cantBlkIds.map(
				(aid) => permanentsById[aid]?.displayCard.name ?? activeById.get(aid)?.card.name ?? aid
			);
		}
	}

	// Step 3: Precompute hand, command, graveyard, and exile playability for the viewer, plus exile Haunt links.
	const handPlayabilityById: Record<string, HandCardPlayabilityView> = {};
	const commandPlayabilityById: Record<string, boolean> = {};
	const gyLandPlayOptions: Record<string, LandPlayOption[]> = {};
	const playableGraveyardIds: string[] = [];
	const playableExileIds: string[] = [];
	const playableExileCards: CardInstance[] = [];
	const permittedExileCards: CardInstance[] = [];
	const exileHauntingTargetNameById: Record<string, string> = {};

	for (const player of gameState.players) {
		for (const exCard of player.exile) {
			const hauntingTargetName = resolveExileHauntingTargetName(
				gameState,
				exCard,
				permanentsById
			);
			if (hauntingTargetName) {
				exileHauntingTargetNameById[exCard.instanceId] = hauntingTargetName;
			}
		}
	}

	if (viewer) {
		for (const inst of viewer.hand) {
			const compiled = compileCard(inst.card);
			const isLand = Boolean(compiled.faces[0]?.characteristics.types.includes('Land'));
			const suspendSpec = getSuspendSpec(inst.card);
			if (viewerCanActNow) {
				const landOptions = getLandPlayOptions(gameState, viewerId, inst, 'hand');
				const castOptions = getCastOptions(gameState, viewerId, inst, 'hand');
				const canSuspend = checkSuspendLegality(gameState, viewerId, inst).ok;
				const specialActions: HandSpecialActionView[] = getHandSpecialActions(
					gameState,
					viewerId,
					inst
				).map((sa) => ({
					...sa,
					legal: checkHandSpecialActionLegality(gameState, viewerId, inst, sa.id).ok
				}));
				const zoneActivatedAbilities = getZoneLegalActivatedAbilities(
					gameState,
					viewer,
					viewerCmdIdentity,
					inst,
					'hand'
				);
				const canPlayLand = landOptions.length > 0;
				const playable =
					canPlayLand ||
					castOptions.length > 0 ||
					canSuspend ||
					specialActions.some((sa) => sa.legal) ||
					zoneActivatedAbilities.length > 0;
				handPlayabilityById[inst.instanceId] = {
					instanceId: inst.instanceId,
					playable,
					isLand,
					canPlayLand,
					landOptions,
					castOptions,
					suspendSpec,
					canSuspend,
					specialActions,
					zoneActivatedAbilities
				};
			} else {
				handPlayabilityById[inst.instanceId] = {
					instanceId: inst.instanceId,
					playable: false,
					isLand,
					canPlayLand: false,
					landOptions: [],
					castOptions: [],
					suspendSpec,
					canSuspend: false,
					specialActions: [],
					zoneActivatedAbilities: []
				};
			}
		}

		for (const cmd of viewer.command) {
			if (cmd.isEmblem || cmd.isDungeon) {
				commandPlayabilityById[cmd.instanceId] = false;
				continue;
			}
			commandPlayabilityById[cmd.instanceId] = viewerCanActNow
				? getCastOptions(gameState, viewerId, cmd, 'command').length > 0
				: false;
		}

		if (viewerCanActNow) {
			for (const gyCard of viewer.graveyard) {
				const gyLandOpts = getLandPlayOptions(gameState, viewerId, gyCard, 'graveyard');
				if (gyLandOpts.length > 0) {
					gyLandPlayOptions[gyCard.instanceId] = gyLandOpts;
				}
				const canPlayGyLand = gyLandOpts.length > 0;
				const canCastGy = getCastOptions(gameState, viewerId, gyCard, 'graveyard').length > 0;
				const canActGy =
					!canPlayGyLand &&
					!canCastGy &&
					getZoneLegalActivatedAbilities(
						gameState,
						viewer,
						viewerCmdIdentity,
						gyCard,
						'graveyard'
					).length > 0;
				if (canPlayGyLand || canCastGy || canActGy) {
					playableGraveyardIds.push(gyCard.instanceId);
				}
			}
		}

		for (const player of gameState.players) {
			for (const exCard of player.exile) {
				const isPlayableNow =
					viewerCanActNow &&
					(getLandPlayOptions(gameState, viewerId, exCard, 'exile').length > 0 ||
						getCastOptions(gameState, viewerId, exCard, 'exile').length > 0);
				if (isPlayableNow) {
					playableExileIds.push(exCard.instanceId);
					playableExileCards.push(exCard);
				}
				const hasExilePermission =
					isPlayableNow ||
					exCard.playableFromExileBy?.playerId === viewerId ||
					exCard.foretoldByPlayerId === viewerId ||
					exCard.plottedByPlayerId === viewerId;
				if (hasExilePermission) {
					permittedExileCards.push(exCard);
				}
			}
		}
	}

	const companionView = viewer ? (playerStatusesById[viewerId]?.companionView ?? null) : null;
	const viewerTopView = viewer ? topOfLibraryByPlayerId[viewerId] : undefined;
	const topOfLibraryView = viewerTopView?.topCard ? viewerTopView : null;
	const hasPlayableGraveyardActions = playableGraveyardIds.length > 0;

	const globalRuleLocks: RuleLockBadge[] = [];
	const seenGlobalLocks = new Set<string>();
	for (const pl of gameState.players) {
		if (pl.lost) continue;
		const st = playerStatusesById[pl.playerId];
		if (!st) continue;
		for (const lock of st.activeRuleLocks) {
			const dedupKey = `${lock.label}|${lock.sourceName ?? ''}`;
			if (seenGlobalLocks.has(dedupKey)) continue;
			seenGlobalLocks.add(dedupKey);
			globalRuleLocks.push(lock);
		}
	}

	return {
		viewerId,
		dayNight: gameState.dayNight ?? null,
		spellsCastByActivePlayerThisTurn: gameState.spellsCastByActivePlayerThisTurn ?? 0,
		prevTurnSpellsCastByActivePlayer: gameState.prevTurnSpellsCastByActivePlayer ?? 0,
		monarchPlayerId: gameState.monarchPlayerId ?? null,
		initiativePlayerId: gameState.initiativePlayerId ?? null,
		globalRuleLocks,
		attachmentsByHostId,
		hostByAttachmentId,
		permanentsById,
		frontRow,
		backRow,
		opponentBoardsById,
		playerStatusesById,
		handPlayabilityById,
		commandPlayabilityById,
		companionView,
		gyLandPlayOptions,
		hasPlayableGraveyardActions,
		playableGraveyardIds,
		playableExileIds,
		playableExileCards,
		permittedExileCards,
		exileHauntingTargetNameById,
		topOfLibraryView,
		topOfLibraryByPlayerId,
		revealedOpponentHandsByPlayerId,
		waitingOnPlayerIds
	};
}

export type HandSortMode = 'none' | 'cmc' | 'name' | 'color' | 'type';
export type HandSortDir = 'asc' | 'desc';

function getColorSortRankFromIr(card: ScryfallCard): number {
	const face = compileCard(card).faces[0]?.characteristics;
	const types = face?.types ?? [];
	const faceColors = face?.colors ?? [];
	if (types.includes('Land') && faceColors.length === 0) {
		return 7;
	}
	const cols = faceColors.length > 0 ? faceColors : card.colorIdentity || [];
	if (cols.length === 0) return 6;
	if (cols.length > 1) return 5;
	const order: Record<string, number> = { W: 0, U: 1, B: 2, R: 3, G: 4 };
	return order[cols[0]] ?? 6;
}

function getTypeSortRankFromIr(card: ScryfallCard): number {
	const types = compileCard(card).faces[0]?.characteristics.types ?? [];
	if (types.includes('Land')) return 0;
	if (types.includes('Creature')) return 1;
	if (types.includes('Planeswalker')) return 2;
	if (types.includes('Artifact')) return 3;
	if (types.includes('Enchantment')) return 4;
	if (types.includes('Battle')) return 5;
	if (types.includes('Instant')) return 6;
	if (types.includes('Sorcery')) return 7;
	return 8;
}

export function sortHandCards(
	hand: readonly CardInstance[],
	sortBy: HandSortMode,
	sortDir: HandSortDir
): CardInstance[] {
	if (sortBy === 'none') return [...hand];
	const dir = sortDir === 'desc' ? -1 : 1;
	const copy = [...hand];
	copy.sort((a, b) => {
		let cmp = 0;
		if (sortBy === 'cmc') {
			const aLand = compileCard(a.card).faces[0]?.characteristics.types.includes('Land') ? 0 : 1;
			const bLand = compileCard(b.card).faces[0]?.characteristics.types.includes('Land') ? 0 : 1;
			if (aLand !== bLand) cmp = aLand - bLand;
			else if (a.card.cmc !== b.card.cmc) cmp = a.card.cmc - b.card.cmc;
			else cmp = a.card.name.localeCompare(b.card.name);
		} else if (sortBy === 'name') {
			cmp = a.card.name.localeCompare(b.card.name);
		} else if (sortBy === 'color') {
			const ca = getColorSortRankFromIr(a.card);
			const cb = getColorSortRankFromIr(b.card);
			if (ca !== cb) cmp = ca - cb;
			else if (a.card.cmc !== b.card.cmc) cmp = a.card.cmc - b.card.cmc;
			else cmp = a.card.name.localeCompare(b.card.name);
		} else if (sortBy === 'type') {
			const ta = getTypeSortRankFromIr(a.card);
			const tb = getTypeSortRankFromIr(b.card);
			if (ta !== tb) cmp = ta - tb;
			else if (a.card.cmc !== b.card.cmc) cmp = a.card.cmc - b.card.cmc;
			else cmp = a.card.name.localeCompare(b.card.name);
		}
		return cmp * dir;
	});
	return copy;
}

export interface ArrowSignatureTargetInfo {
	instanceId: string;
	targetKind: string;
	selectedTargets: readonly Pick<TargetRef, 'id'>[];
}

export interface ArrowSignatureInputs {
	gameState: GameState;
	draftAttackers?: Record<string, string>;
	draftAttackerWalkers?: Record<string, string | null>;
	draftAttackerBattles?: Record<string, string | null>;
	draftBlockers?: Record<string, string>;
	focusInstanceId?: string | null;
	pendingTarget?: ArrowSignatureTargetInfo | null;
	mousePos?: { x: number; y: number };
	viewportWidth?: number;
	viewportHeight?: number;
	layoutKey?: string;
	isDraggingLayout?: boolean;
}

/**
 * Computes a deterministic dirty-check signature for SVG Bezier combat/stack/attachment/targeting
 * arrows. While idle (`pendingTarget` is null and `isDraggingLayout` is false), mouse movement does
 * NOT alter the signature, eliminating 60fps `querySelector` + `getBoundingClientRect` DOM thrashing.
 */
export function computeArrowSignature(inputs: ArrowSignatureInputs): string {
	const {
		gameState,
		draftAttackers = {},
		draftAttackerWalkers = {},
		draftAttackerBattles = {},
		draftBlockers = {},
		focusInstanceId = null,
		pendingTarget = null,
		mousePos,
		viewportWidth = 0,
		viewportHeight = 0,
		layoutKey = '',
		isDraggingLayout = false
	} = inputs;

	const chunks: string[] = [
		`ph:${gameState.phase}:${gameState.activePlayerIndex}`,
		`vp:${viewportWidth}x${viewportHeight}:${layoutKey}`,
		`c:${gameState.combat.active ? 1 : 0}`
	];

	if (gameState.combat.active) {
		for (const atk of gameState.combat.attackers) {
			chunks.push(
				`atk:${atk.attackerInstanceId}->${atk.defenderPlaneswalkerId || atk.defenderBattleId || atk.defenderPlayerId}[${atk.blockerInstanceIds.join(',')}]`
			);
		}
	}

	for (const [atkId, defId] of Object.entries(draftAttackers)) {
		chunks.push(`da:${atkId}->${draftAttackerWalkers[atkId] || draftAttackerBattles[atkId] || defId}`);
	}
	for (const [blkId, atkId] of Object.entries(draftBlockers)) {
		chunks.push(`db:${blkId}->${atkId}`);
	}

	// Board geometry & attachment links
	for (const p of gameState.players) {
		const bIds: string[] = [];
		for (const perm of p.battlefield) {
			bIds.push(
				`${perm.instanceId}:${perm.tapped ? 1 : 0}:${perm.phasedOut ? 1 : 0}:${perm.attachedToId || ''}`
			);
		}
		chunks.push(`b:${p.playerId}[${bIds.join(';')}]`);
	}

	if (focusInstanceId) {
		chunks.push(`f:${focusInstanceId}`);
	}

	for (const item of gameState.stack) {
		chunks.push(`s:${item.id}->${item.targets.map((t) => t.id).join(',')}`);
	}

	if (pendingTarget) {
		const mx = mousePos ? Math.round(mousePos.x) : 0;
		const my = mousePos ? Math.round(mousePos.y) : 0;
		chunks.push(
			`pt:${pendingTarget.instanceId}:${pendingTarget.targetKind}[${pendingTarget.selectedTargets.map((t) => t.id).join(',')}]@${mx},${my}`
		);
	} else if (isDraggingLayout && mousePos) {
		chunks.push(`drag@${Math.round(mousePos.x)},${Math.round(mousePos.y)}`);
	}

	return chunks.join('|');
}
