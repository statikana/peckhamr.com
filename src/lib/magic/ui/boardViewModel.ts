import { compileCard } from '../compiler/index.ts';
import {
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
import { DUNGEON_SPECS } from '../oracle.ts';
import { evaluatePermanent, type EvaluatedPermanent } from '../ruleTree.ts';
import { getSuspendSpec } from '../runtime/costs.ts';
import { instanceFaceOptions, resolveObjectFaces } from '../runtime/faces.ts';
import { withStableLayerInputs } from '../runtime/layerCache.ts';
import { splitSubtypes } from '../runtime/layers.ts';
import { totalSnowManaInPool } from '../runtime/staticsDynamicAndCosts.ts';
import { effectiveCardForObject } from '../scryfall.ts';
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
	isGoaded: boolean;
	isSaddled: boolean;
	isRingBearer: boolean;
	isPrepared: boolean;
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
	ringLevel: number;
	ringBearerId: string | null;
	ringAbilities: string[];
	snowManaTotal: number;
	snowManaByColor: Partial<Record<ManaColor, number>>;
	commanders: CardInstance[];
	emblems: CardInstance[];
	dungeonCommandCards: CardInstance[];
	restrictedManaEntries: RestrictedManaEntry[];
	commanderDamageEntries: CommanderDamageEntry[];
	protectionFromEverythingThisTurn: boolean;
	cannotLoseGameThisTurn: boolean;
	lifeTotalCannotChangeThisTurn: boolean;
	damagePreventionShield: number;
	preventAllCombatDamageThisTurn: boolean;
	turnShieldBadges: PlayerShieldBadge[];
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
	initiativePlayerId: string | null;
	attachmentsByHostId: Record<string, CardInstance[]>;
	hostByAttachmentId: Record<string, CardInstance>;
	permanentsById: Record<string, PermanentView>;
	frontRow: PermanentView[];
	backRow: PermanentView[];
	opponentBoardsById: Record<string, PermanentView[]>;
	playerStatusesById: Record<string, PlayerStatusView>;
	handPlayabilityById: Record<string, HandCardPlayabilityView>;
	commandPlayabilityById: Record<string, boolean>;
	playableGraveyardIds: string[];
	playableExileIds: string[];
	playableExileCards: CardInstance[];
	permittedExileCards: CardInstance[];
	waitingOnPlayerIds: string[];
}

const KNOWN_COUNTER_ORDER: readonly CounterType[] = [
	'+1/+1',
	'-1/-1',
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

function classifyCounterBadge(type: string, count: number): CounterBadgeEntry {
	switch (type) {
		case '+1/+1':
			return {
				type: '+1/+1',
				count,
				badgeKind: 'plus',
				label: `+${count}/+${count}`,
				shortLabel: `+${count}`
			};
		case '-1/-1':
			return {
				type: '-1/-1',
				count,
				badgeKind: 'minus',
				label: `-${count}/-${count}`,
				shortLabel: `-${count}`
			};
		case 'loyalty':
			return {
				type: 'loyalty',
				count,
				badgeKind: 'loyalty',
				label: `L:${count}`,
				shortLabel: `L:${count}`
			};
		case 'defense':
			return {
				type: 'defense',
				count,
				badgeKind: 'defense',
				label: `Def:${count}`,
				shortLabel: `Def:${count}`
			};
		case 'lore':
			return {
				type: 'lore',
				count,
				badgeKind: 'lore',
				label: `Lore:${count}`,
				shortLabel: `Lore:${count}`
			};
		case 'charge':
			return {
				type: 'charge',
				count,
				badgeKind: 'charge',
				label: `Chg:${count}`,
				shortLabel: `Chg:${count}`
			};
		case 'shield':
			return {
				type: 'shield',
				count,
				badgeKind: 'shield',
				label: `Shld:${count}`,
				shortLabel: `Shld:${count}`
			};
		case 'stun':
			return {
				type: 'stun',
				count,
				badgeKind: 'stun',
				label: `Stun:${count}`,
				shortLabel: `Stun:${count}`
			};
		case 'time':
			return {
				type: 'time',
				count,
				badgeKind: 'time',
				label: `Time:${count}`,
				shortLabel: `Time:${count}`
			};
		case 'age':
			return {
				type: 'age',
				count,
				badgeKind: 'age',
				label: `Age:${count}`,
				shortLabel: `Age:${count}`
			};
		default:
			return {
				type: type as CounterType,
				count,
				badgeKind: 'other',
				label: `${type}:${count}`,
				shortLabel: `${type}:${count}`
			};
	}
}

export function extractCounterBadges(counters: Record<string, number> | undefined): CounterBadgeEntry[] {
	if (!counters) return [];
	const out: CounterBadgeEntry[] = [];
	const seen = new Set<string>();
	for (const known of KNOWN_COUNTER_ORDER) {
		const raw = counters[known];
		if (typeof raw === 'number' && raw !== 0) {
			out.push(classifyCounterBadge(known, raw));
			seen.add(known);
		}
	}
	for (const [key, raw] of Object.entries(counters)) {
		if (seen.has(key)) continue;
		if (typeof raw === 'number' && raw !== 0) {
			out.push(classifyCounterBadge(key, raw));
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

function extractPlayerStatus(gameState: GameState, player: PlayerGameState): PlayerStatusView {
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

	return {
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
		ringLevel,
		ringBearerId,
		ringAbilities,
		snowManaTotal,
		snowManaByColor,
		commanders,
		emblems,
		dungeonCommandCards,
		restrictedManaEntries,
		commanderDamageEntries,
		protectionFromEverythingThisTurn,
		cannotLoseGameThisTurn,
		lifeTotalCannotChangeThisTurn,
		damagePreventionShield,
		preventAllCombatDamageThisTurn,
		turnShieldBadges
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
		gameState.pendingPrompts.map((pr) => `${pr.id}:${pr.playerId}:${pr.kind}`).join(','),
		(gameState.timedKeywordEffects ?? []).length,
		(gameState.timedContinuousEffects ?? []).length
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
			p.manaPool.C
		);
		if (p.snowManaByColor) {
			for (const col of ALL_MANA_COLORS) {
				const sv = p.snowManaByColor[col] || 0;
				if (sv) parts.push(`snow:${col}=${sv}`);
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
		for (const perm of p.battlefield) {
			parts.push(
				perm.instanceId,
				perm.objectVersion ?? 0,
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
				perm.usedLoyaltyThisTurn,
				(perm.activatedAbilityIdsThisTurn ?? []).join(','),
				(perm.goadedByPlayerIds ?? []).join(','),
				perm.saddledThisTurn ?? false,
				(perm.grantedKeywords ?? []).join(',')
			);
			for (const [ct, cv] of Object.entries(perm.counters || {})) {
				if (cv) parts.push(`${ct}=${cv}`);
			}
		}
		for (const c of p.hand) {
			parts.push(c.instanceId, c.objectVersion ?? 0);
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
				c.isSuspended ?? false
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

	// Step 1 (O(B)): Index all active battlefield permanents by instanceId, then link attachments in O(B).
	const activeById = new Map<string, CardInstance>();
	for (const player of gameState.players) {
		playerStatusesById[player.playerId] = extractPlayerStatus(gameState, player);
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
			const faceView = resolveObjectFaces(effCard, instanceFaceOptions(perm, 'battlefield'));
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
			const isGoaded = Boolean(perm.goadedByPlayerIds && perm.goadedByPlayerIds.length > 0);
			const isSaddled = Boolean(perm.saddledThisTurn);
			const controllerPlayer = gameState.players.find((pl) => pl.playerId === evaluated.controllerId);
			const isRingBearer = Boolean(
				!perm.phasedOut &&
					isCreature &&
					controllerPlayer &&
					controllerPlayer.ringBearerId === perm.instanceId
			);
			const isPrepared = Boolean(perm.isPrepared);
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
				isGoaded,
				isSaddled,
				isRingBearer,
				isPrepared,
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

	// Step 3: Precompute hand, command, graveyard, and exile playability for the viewer.
	const handPlayabilityById: Record<string, HandCardPlayabilityView> = {};
	const commandPlayabilityById: Record<string, boolean> = {};
	const playableGraveyardIds: string[] = [];
	const playableExileIds: string[] = [];
	const playableExileCards: CardInstance[] = [];
	const permittedExileCards: CardInstance[] = [];

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
				const canCastGy = getCastOptions(gameState, viewerId, gyCard, 'graveyard').length > 0;
				const canActGy =
					!canCastGy &&
					getZoneLegalActivatedAbilities(
						gameState,
						viewer,
						viewerCmdIdentity,
						gyCard,
						'graveyard'
					).length > 0;
				if (canCastGy || canActGy) {
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

	return {
		viewerId,
		dayNight: gameState.dayNight ?? null,
		spellsCastByActivePlayerThisTurn: gameState.spellsCastByActivePlayerThisTurn ?? 0,
		prevTurnSpellsCastByActivePlayer: gameState.prevTurnSpellsCastByActivePlayer ?? 0,
		initiativePlayerId: gameState.initiativePlayerId ?? null,
		attachmentsByHostId,
		hostByAttachmentId,
		permanentsById,
		frontRow,
		backRow,
		opponentBoardsById,
		playerStatusesById,
		handPlayabilityById,
		commandPlayabilityById,
		playableGraveyardIds,
		playableExileIds,
		playableExileCards,
		permittedExileCards,
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
