/**
 * Runtime helpers, frame mechanics, cast-cost generalizations, and resolution handlers
 * for Wave 4 (Track P12):
 *
 * - P12.1 Card Frames & Cost Generalizations:
 *   - Class (CR 717)
 *   - Case / To solve / Solved (CR 720, CR 702.169)
 *   - Spree (CR 702.172), Tiered (CR 702.183), Escalate (CR 702.120)
 *   - Exhaust (CR 702.177), Boast (CR 702.142), Forecast (CR 702.57)
 *   - Card-level additional cast costs ("As an additional cost to cast this spell, ...")
 *
 * - P12.2 35 Wave 4 CR 702 Keywords:
 *   Aftermath (702.127), Afflict (702.130), Awaken (702.113), Backup (702.165),
 *   Bargain (702.166), Bestow (702.103), Champion (702.72), Decayed (702.147),
 *   Dethrone (702.105), Devour (702.82), Dredge (702.52), Embalm (702.128),
 *   Emerge (702.119), Encore (702.141), Enlist (702.154), Escalate (702.120),
 *   Eternalize (702.129), Firebending (702.189), Harmonize (702.180), Ingest (702.115),
 *   Melee (702.121), Mentor (702.134), Miracle (702.94), Mobilize (702.181),
 *   Myriad (702.116), Outlast (702.107), Rampage (702.23), Recover (702.59),
 *   Renown (702.112), Spectacle (702.137), Split second (702.61), Sunburst (702.44),
 *   Surge (702.117), Training (702.149), Umbra armor (702.89).
 *
 * Pure IR and GameState metadata only — zero card-name comparisons and zero runtime rules-text reads.
 */
import { compileCard } from '../compiler/index.ts';
import type { RuntimeTrigger } from '../compiler/triggers.ts';
import type {
	AbilityDef,
	Amount,
	Condition,
	CopyModificationSpec,
	CostDef,
	KeywordDef,
	ModalDef,
	ObjectFilter,
	TargetSpec,
	TokenSpec
} from '../ir.ts';
import { parseManaCost, type ManaCostRequirement } from '../oracle.ts';
import { effectiveCardForObject } from '../scryfall.ts';
// --- Track P22a ---
import { hasSelfGraveyardKeywordCastWave8 } from './staticsWave8.ts';
// --- End Track P22a ---
import type {
	CardInstance,
	CastCostAid,
	CastOption,
	CastOptionOptionalCost,
	CounterType,
	DelayedTrigger,
	GameState,
	ManaColor,
	PlayerGameState,
	ScryfallCard,
	SpellModifications,
	StackItem,
	TargetRef,
	TargetRequirementInfo
} from '../types.ts';
import { enqueueChoicePrompt, registerPromptHandler } from './choices.ts';
import {
	effectiveSpellManaCost,
	spellAdditionalCost,
	spellChoosesX,
	spellOptionalAdditionalCosts,
	type CostContext
} from './costs.ts';
import type { emitEvent } from './events.ts';
import {
	activeAbilityDefs,
	effectiveManaValue,
	instanceFaceOptions,
	resolveObjectFaces,
	stackItemFaceOptions
} from './faces.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { evaluatePermanent } from './layers.ts';
import { evaluateAmount, objectPower, type FilterContext } from './objectFilter.ts';
import { playerLifeTotalCantChange } from './replace.ts';
import { allocateTimestamp, moveObject } from './zones.ts';
// --- Track P22b ---
import { snapshotP22bLifeLostLastTurn } from './triggersWave8.ts';
// --- End Track P22b ---

export interface Wave4RuntimeTrigger extends RuntimeTrigger {
	wave4Tag?: string;
	wave4N?: number;
	wave4CostText?: string;
}

export interface Wave4FinalizeCastOptions {
	targets: TargetRef[];
	targetsBySpec?: TargetRef[][];
	chosenModes?: number[];
	xValue: number;
	castOptionId?: string;
	faceIndex?: number;
	fused?: boolean;
	spellMods?: SpellModifications;
	awakenTargetId?: string;
	awakenTargetVersion?: number;
	descriptions?: string[];
}

export interface Wave4Host {
	uid: (prefix: string, state: GameState) => string;
	addLog: (
		state: GameState,
		kind: 'rule' | 'cast' | 'combat' | 'trigger' | 'life' | 'sba' | 'system',
		text: string,
		actorId?: string
	) => void;
	emitEvent: typeof emitEvent;
	flushTriggers: (state: GameState) => void;
	canPayOrAutoTap: (
		player: PlayerGameState,
		req: ManaCostRequirement,
		state: GameState,
		phyrexianLifeCount?: number,
		reservedObjectIds?: ReadonlySet<string>
	) => boolean;
	payManaWithAutoTap: (
		player: PlayerGameState,
		req: ManaCostRequirement,
		state: GameState,
		phyrexianLifeCount?: number,
		reservedObjectIds?: ReadonlySet<string>
	) => boolean;
	costContext: (
		state: GameState,
		player: PlayerGameState,
		source: CardInstance,
		xValue: number,
		isSpell: boolean,
		baseMana: ManaCostRequirement | null
	) => CostContext;
	createTokens: (
		state: GameState,
		controller: PlayerGameState,
		spec: TokenSpec,
		count: number,
		sourceName: string
	) => CardInstance[];
	copyPermanentAsToken: (
		state: GameState,
		controller: PlayerGameState,
		original: CardInstance,
		sourceName: string,
		notLegendary?: boolean,
		exceptPT?: { power: number; toughness: number },
		copyMod?: CopyModificationSpec,
		copyOpts?: { tapped?: boolean; tappedAndAttacking?: boolean }
	) => CardInstance;
	addCountersToPermanent: (
		state: GameState,
		perm: CardInstance,
		counterType: CounterType,
		amount: number
	) => number;
	tapPermanent: (state: GameState, perm: CardInstance) => void;
	finalizeCastSpell: (
		state: GameState,
		actor: PlayerGameState,
		inst: CardInstance,
		sourcePlayer: PlayerGameState,
		sourceZone: 'hand' | 'command' | 'exile' | 'graveyard',
		opts: Wave4FinalizeCastOptions
	) => void;
	resumeStackItem: (state: GameState, item: StackItem) => void;
	drawSingleCardWithoutDredge: (
		state: GameState,
		player: PlayerGameState,
		deferSba: boolean
	) => void;
	drawCards: (
		state: GameState,
		player: PlayerGameState,
		count: number,
		deferSba?: boolean
	) => void;
	markHandCardRevealedToAll: (state: GameState, inst: CardInstance) => void;
}

let wave4Host: Wave4Host | null = null;

export function registerWave4Host(host: Wave4Host): void {
	wave4Host = host;
}

function requireHost(): Wave4Host {
	if (!wave4Host) {
		throw new Error('Wave4Host has not been registered.');
	}
	return wave4Host;
}

function findPermanentAcrossPlayers(
	state: GameState,
	instanceId: string
): { inst: CardInstance; owner: PlayerGameState } | null {
	for (const p of state.players) {
		const inst = p.battlefield.find((c) => c.instanceId === instanceId);
		if (inst && !inst.phasedOut) return { inst, owner: p };
	}
	return null;
}

// ============================================================================
// 1. P12 ObjectFilter, Condition, & Amount Evaluators
// ============================================================================

export function matchesP12ObjectFilter(
	obj: CardInstance,
	filter: ObjectFilter,
	ctx: FilterContext,
	matchesFilterFn?: (obj: CardInstance, filter: ObjectFilter, ctx: FilterContext) => boolean
): boolean {
	const state = ctx.state;
	if (filter.anyOf?.length) {
		if (!matchesFilterFn || !filter.anyOf.some((sub) => matchesFilterFn(obj, sub, ctx))) {
			return false;
		}
	}
	if (filter.artifactEnchantmentOrToken) {
		if (!obj.isToken) {
			if (obj.zone === 'battlefield' && state) {
				const ev = evaluatePermanent(state, obj);
				if (!ev.isArtifact && !ev.isEnchantment) return false;
			} else {
				const face = resolveObjectFaces(effectiveCardForObject(obj), instanceFaceOptions(obj));
				if (!face.types.includes('Artifact') && !face.types.includes('Enchantment')) return false;
			}
		}
	}
	if (filter.powerLessThanSource) {
		const candPower = objectPower(state, obj);
		if (candPower === null) return false;
		let srcPower: number | null = null;
		if (
			state &&
			ctx.source &&
			ctx.source.zone === 'battlefield' &&
			!ctx.source.phasedOut &&
			(ctx.stackItem?.sourceObjectVersion === undefined ||
				ctx.source.objectVersion === ctx.stackItem.sourceObjectVersion)
		) {
			srcPower = evaluatePermanent(state, ctx.source).power;
		} else if (ctx.stackItem?.sourceLkiPower !== undefined) {
			srcPower = ctx.stackItem.sourceLkiPower;
		} else if (ctx.source?.lastKnownPower !== undefined) {
			srcPower = ctx.source.lastKnownPower;
		} else if (ctx.source) {
			srcPower = objectPower(state, ctx.source);
		}
		if (srcPower === null || candPower >= srcPower) return false;
	}
	if (filter.untappedNonattackingSummoningReady) {
		if (obj.zone !== 'battlefield' || obj.phasedOut || obj.tapped) return false;
		if (state?.combat.attackers.some((a) => a.attackerInstanceId === obj.instanceId)) {
			return false;
		}
		if (obj.summoningSick) {
			const hasHaste = state
				? evaluatePermanent(state, obj).keywords.some((k) => k.toLowerCase() === 'haste')
				: false;
			if (!hasHaste) return false;
		}
	}
	return true;
}

export function evaluateP12Condition(
	cond: Condition,
	ctx: FilterContext,
	matchesFilterFn: (obj: CardInstance, filter: ObjectFilter, ctx: FilterContext) => boolean
): boolean | null {
	const state = ctx.state;
	const source = ctx.source;
	const player = state?.players.find((p) => p.playerId === ctx.controllerId);
	switch (cond.k) {
		case 'classLevelIs':
			return (source?.classLevel ?? 1) === cond.level;
		case 'classLevelAtLeast':
			return (source?.classLevel ?? 1) >= cond.level;
		case 'caseSolved':
			return Boolean(source?.isSolved);
		case 'caseUnsolved':
			return !source?.isSolved;
		case 'isRenowned':
			return Boolean(source?.isRenowned || ctx.stackItem?.sourceIsRenowned);
		case 'boastAttackedThisTurn':
			return Boolean(source?.creatureAttackedThisTurn);
		case 'exhaustUnused':
			return !source?.exhaustedAbilityIds?.includes(cond.abilityId);
		case 'dethroneMostLife': {
			if (!state) return false;
			const defId =
				ctx.stackItem?.defendingPlayerId ??
				(source
					? state.combat.attackers.find((a) => a.attackerInstanceId === source.instanceId)
							?.defenderPlayerId
					: undefined);
			if (!defId) return false;
			return isPlayerTiedForMostLife(state, defId);
		}
		case 'trainingGreaterAttacker': {
			if (!state || !source) return false;
			return attackerHasGreaterPowerCoAttacker(state, source, ctx.controllerId);
		}
		case 'creaturesAttackedCountThisTurn':
			return (state?.creaturesAttackedCountThisTurn ?? 0) >= cond.min;
		case 'totalPowerControlled': {
			if (!state || !player) return false;
			let total = 0;
			for (const perm of player.battlefield) {
				if (perm.phasedOut) continue;
				const ev = evaluatePermanent(state, perm);
				if (ev.isCreature) total += Math.max(0, ev.power);
			}
			return total >= cond.min;
		}
		case 'colorsAmongControlledPermanents': {
			if (!state || !player) return false;
			const colors = new Set<ManaColor>();
			for (const perm of player.battlefield) {
				if (perm.phasedOut) continue;
				const ev = evaluatePermanent(state, perm);
				for (const c of ev.colors) colors.add(c);
			}
			return colors.size >= cond.min;
		}
		case 'sourcesDealtDamageThisTurn':
			return (player?.sourcesDealtDamageIdsThisTurn?.length ?? 0) >= cond.min;
		case 'cardsPutIntoGraveyardFromAnywhereThisTurn':
			return (state?.cardsPutIntoGraveyardThisTurn ?? 0) >= cond.min;
		case 'spellsCastThisTurnCount': {
			if (!player) return false;
			if (!cond.filter) {
				return (player.spellsCastThisTurn ?? 0) >= cond.min;
			}
			const cards = player.spellsCastThisTurnCards ?? [];
			let count = 0;
			for (const card of cards) {
				const stub: CardInstance = {
					instanceId: 'cast-hist',
					card,
					ownerId: player.playerId,
					controllerId: player.playerId,
					zone: 'stack',
					tapped: false,
					summoningSick: false,
					damageMarked: 0,
					deathtouchDamageMarked: false,
					counters: {} as CardInstance['counters'],
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
				if (matchesFilterFn(stub, cond.filter, ctx)) count++;
			}
			return count >= cond.min;
		}
		default:
			return null;
	}
}

export function evaluateP12Amount(amt: Amount, ctx: FilterContext): number | null {
	if (amt.k === 'devouredCount') {
		return ctx.source?.devouredCount ?? ctx.stackItem?.sourceDevouredCount ?? 0;
	}
	if (amt.k === 'opponentCount') {
		if (!ctx.state) return 0;
		return ctx.state.players.filter((p) => !p.lost && p.playerId !== ctx.controllerId).length;
	}
	return null;
}

export function isPlayerTiedForMostLife(state: GameState, playerId: string): boolean {
	const active = state.players.filter((p) => !p.lost);
	if (active.length === 0) return false;
	const target = active.find((p) => p.playerId === playerId);
	if (!target) return false;
	let maxLife = -Infinity;
	for (const p of active) {
		if (p.life > maxLife) maxLife = p.life;
	}
	return target.life >= maxLife;
}

export function attackerHasGreaterPowerCoAttacker(
	state: GameState,
	attacker: CardInstance,
	controllerId: string
): boolean {
	if (attacker.zone !== 'battlefield' || attacker.phasedOut) return false;
	const selfPower = evaluatePermanent(state, attacker).power;
	for (const atk of state.combat.attackers) {
		if (atk.attackerInstanceId === attacker.instanceId) continue;
		if (atk.controllerId !== controllerId) continue;
		const found = findPermanentAcrossPlayers(state, atk.attackerInstanceId);
		if (!found) continue;
		const coPower = evaluatePermanent(state, found.inst).power;
		if (coPower > selfPower) return true;
	}
	return false;
}

// ============================================================================
// 2. Backup (CR 702.165), Decayed (CR 702.147), & Split Second (CR 702.61)
// ============================================================================

export function collectBackupGrantedAbilityDefs(
	state: GameState,
	perm: CardInstance
): AbilityDef[] {
	const timed = state.timedContinuousEffects;
	if (!timed || timed.length === 0) return [];
	const out: AbilityDef[] = [];
	for (const eff of timed) {
		if (!eff.backupGrant) continue;
		const aff = eff.affected.find((a) => a.instanceId === perm.instanceId);
		if (!aff) continue;
		if (aff.objectVersion !== undefined && (perm.objectVersion ?? 1) !== aff.objectVersion) {
			continue;
		}
		const def = compileCard(eff.backupGrant.sourceCard);
		const faceAbilities =
			eff.backupGrant.faceIndex > 0 && def.faces?.[eff.backupGrant.faceIndex]
				? def.faces[eff.backupGrant.faceIndex].abilities
				: (def.faces[0]?.abilities ?? []);
		const start = Math.max(0, eff.backupGrant.startAbilityIndex);
		for (let i = start; i < faceAbilities.length; i++) {
			out.push(faceAbilities[i]);
		}
	}
	return out;
}

export function collectBackupGrantedAbilityGroups(
	state: GameState,
	perm: CardInstance
): Array<{
	abilities: AbilityDef[];
	sourceInstanceId: string;
	sourceCard: ScryfallCard;
	sourceName: string;
	faceIndex: number;
	timestamp: number;
}> {
	const timed = state.timedContinuousEffects;
	if (!timed || timed.length === 0) return [];
	const out: Array<{
		abilities: AbilityDef[];
		sourceInstanceId: string;
		sourceCard: ScryfallCard;
		sourceName: string;
		faceIndex: number;
		timestamp: number;
	}> = [];
	for (const eff of timed) {
		if (!eff.backupGrant) continue;
		const aff = eff.affected.find((a) => a.instanceId === perm.instanceId);
		if (!aff) continue;
		if (aff.objectVersion !== undefined && (perm.objectVersion ?? 1) !== aff.objectVersion) {
			continue;
		}
		const def = compileCard(eff.backupGrant.sourceCard);
		const faceAbilities =
			eff.backupGrant.faceIndex > 0 && def.faces?.[eff.backupGrant.faceIndex]
				? def.faces[eff.backupGrant.faceIndex].abilities
				: (def.faces[0]?.abilities ?? []);
		const start = Math.max(0, eff.backupGrant.startAbilityIndex);
		const abilities = faceAbilities.slice(start);
		if (abilities.length > 0) {
			out.push({
				abilities,
				sourceInstanceId: String(eff.timestamp),
				sourceCard: eff.backupGrant.sourceCard,
				sourceName: eff.sourceName,
				faceIndex: eff.backupGrant.faceIndex,
				timestamp: eff.timestamp
			});
		}
	}
	return out;
}

function keywordNameOf(kw: KeywordDef): string {
	const { name } = kw;
	return name;
}

/** CR 702.61a–b: Returns the topmost spell on the stack with Split second, if any. */
export function stackSpellWithSplitSecond(state: GameState): StackItem | null {
	for (let i = state.stack.length - 1; i >= 0; i--) {
		const item = state.stack[i];
		if (item.kind !== 'spell' || !item.card || item.isFaceDown) continue;
		const abilities = activeAbilityDefs(item.card, stackItemFaceOptions(item));
		if (abilities.some((a) => a.kind === 'keyword' && keywordNameOf(a.keyword) === 'split second')) {
			return item;
		}
	}
	return null;
}

// ============================================================================
// 3. Turn-State Tracking & Firebending Red Mana Preservation (CR 702.189a)
// ============================================================================

export function resetWave4TurnStateAtTurnStart(state: GameState): void {
	state.creaturesAttackedCountThisTurn = 0;
	state.cardsPutIntoGraveyardThisTurn = 0;
	for (const p of state.players) {
		// --- Track P22b ---
		snapshotP22bLifeLostLastTurn(p);
		// --- End Track P22b ---
		delete p.lifeLostThisTurn;
		delete p.firebendingRedMana;
		delete p.sourcesDealtDamageIdsThisTurn;
		delete p.spellsCastThisTurnCards;
		for (const perm of p.battlefield) {
			delete perm.creatureAttackedThisTurn;
			delete perm.encoreMustAttackPlayerId;
		}
		for (const c of p.hand) {
			delete c.miracleTurnSerial;
		}
		for (const c of p.graveyard) {
			delete c.discardedByPlayerIdThisTurn;
			delete c.discardedTurnSerial;
		}
	}
}

export function clearWave4StepScopedState(state: GameState, leavingPhase: string): void {
	for (const p of state.players) {
		for (const c of p.hand) {
			delete c.miracleTurnSerial;
		}
	}
	const leavingCombatWithoutAttackers =
		leavingPhase === 'declare_attackers' &&
		(!state.combat.active || state.combat.attackers.length === 0);
	if (
		leavingPhase === 'end_combat' ||
		leavingCombatWithoutAttackers ||
		leavingPhase === 'cleanup' ||
		leavingPhase === 'end_step'
	) {
		for (const p of state.players) {
			delete p.firebendingRedMana;
		}
	}
}

const COMBAT_STEP_PHASES = new Set<string>([
	'begin_combat',
	'declare_attackers',
	'declare_blockers',
	'first_strike_damage',
	'combat_damage',
	'end_combat'
]);

/**
 * Returns the amount of `{R}` in `player.manaPool.R` protected by Firebending (`CR 702.189a`)
 * across step transitions inside the combat phase (before `end_combat` ends).
 */
export function preservedFirebendingRedMana(
	state: GameState,
	player: PlayerGameState
): number {
	const tracked = player.firebendingRedMana ?? 0;
	if (tracked <= 0) return 0;
	const leavingCombat =
		!COMBAT_STEP_PHASES.has(state.phase) ||
		state.phase === 'end_combat' ||
		(state.phase === 'declare_attackers' &&
			(!state.combat.active || state.combat.attackers.length === 0));
	if (leavingCombat) {
		delete player.firebendingRedMana;
		return 0;
	}
	const preserved = Math.min(player.manaPool.R, tracked);
	if (preserved > 0) {
		player.firebendingRedMana = preserved;
	} else {
		delete player.firebendingRedMana;
	}
	return preserved;
}

export function recordPlayerLifeLossWave4(player: PlayerGameState, amount: number): void {
	if (amount > 0) {
		player.lifeLostThisTurn = (player.lifeLostThisTurn ?? 0) + amount;
	}
}

export function recordDamageSourceWave4(
	state: GameState,
	sourceId: string | undefined,
	amount: number
): void {
	if (!sourceId || amount <= 0) return;
	let ctrlId: string | undefined;
	let keyId = sourceId;
	const perm = findPermanentAcrossPlayers(state, sourceId);
	if (perm) {
		ctrlId = perm.inst.controllerId;
		keyId = perm.inst.instanceId;
	} else {
		const stk = state.stack.find((s) => s.id === sourceId || s.sourceInstanceId === sourceId);
		if (stk) {
			ctrlId = stk.controllerId;
			keyId = stk.sourceInstanceId || stk.id;
		} else if (state.players.some((p) => p.playerId === sourceId)) {
			ctrlId = sourceId;
			const top = state.stack[state.stack.length - 1];
			if (top && top.controllerId === sourceId) {
				keyId = top.sourceInstanceId || top.id;
			}
		} else {
			for (const p of state.players) {
				const found =
					p.graveyard.find((c) => c.instanceId === sourceId) ??
					p.exile.find((c) => c.instanceId === sourceId) ??
					p.command.find((c) => c.instanceId === sourceId);
				if (found) {
					ctrlId = found.controllerId || found.ownerId;
					keyId = found.instanceId;
					break;
				}
			}
		}
	}
	if (!ctrlId) return;
	const ctrl = state.players.find((p) => p.playerId === ctrlId);
	if (!ctrl) return;
	const list = ctrl.sourcesDealtDamageIdsThisTurn ?? (ctrl.sourcesDealtDamageIdsThisTurn = []);
	if (!list.includes(keyId)) {
		list.push(keyId);
		noteLayerInputsChanged(state);
	}
}

export function recordSpellCastWave4(
	state: GameState,
	actor: PlayerGameState,
	card: ScryfallCard,
	faceIndex?: number
): void {
	const face = resolveObjectFaces(card, { zone: 'stack', faceIndex });
	const snapshot: ScryfallCard = {
		...card,
		name: face.name,
		manaCost: face.manaCost,
		typeLine: face.typeLine,
		colors: [...face.colors]
	};
	(actor.spellsCastThisTurnCards ??= []).push(snapshot);
	noteLayerInputsChanged(state);
}

export function recordDeclaredAttackersWave4(
	state: GameState,
	attackerPerms: CardInstance[]
): void {
	if (attackerPerms.length === 0) return;
	state.creaturesAttackedCountThisTurn =
		(state.creaturesAttackedCountThisTurn ?? 0) + attackerPerms.length;
	for (const perm of attackerPerms) {
		perm.creatureAttackedThisTurn = true;
	}
	noteLayerInputsChanged(state);
}

// ============================================================================
// 4. ETB Choices & Counters: Class (CR 717), Sunburst (CR 702.44), Devour (CR 702.82)
// ============================================================================

export function findDevourKeywordDef(obj: CardInstance): KeywordDef | null {
	if (obj.isFaceDown) return null;
	const card = effectiveCardForObject(obj);
	const abilities = activeAbilityDefs(card, instanceFaceOptions(obj));
	for (const ab of abilities) {
		if (ab.kind === 'keyword' && keywordNameOf(ab.keyword) === 'devour') {
			return ab.keyword;
		}
	}
	return null;
}

export function legalDevourSacrificeCandidates(
	state: GameState,
	entering: CardInstance,
	controllerId: string,
	kw: KeywordDef,
	matchesFilterFn: (obj: CardInstance, filter: ObjectFilter, ctx: FilterContext) => boolean
): CardInstance[] {
	const ctrl = state.players.find((p) => p.playerId === controllerId);
	if (!ctrl) return [];
	const filter: ObjectFilter = kw.devourFilter ?? { types: ['Creature'] };
	const ctx: FilterContext = { state, controllerId, source: entering };
	const out: CardInstance[] = [];
	for (const perm of ctrl.battlefield) {
		if (perm.phasedOut || perm.instanceId === entering.instanceId) continue;
		const ev = evaluatePermanent(state, perm);
		if (!filter.types?.length && !ev.isCreature) continue;
		if (!matchesFilterFn(perm, filter, ctx)) continue;
		out.push(perm);
	}
	return out;
}

export function applyWave4EtbCountersAndSetup(
	state: GameState,
	obj: CardInstance,
	placeCounterFn: (state: GameState, target: CardInstance, counter: CounterType, count: number) => void
): void {
	const card = effectiveCardForObject(obj);
	const face = resolveObjectFaces(card, instanceFaceOptions(obj));
	// CR 717.2d: A Class enters at level 1.
	if (face.subtypes.includes('Class') || /\bClass\b/.test(face.typeLine)) {
		obj.classLevel = 1;
	}
	if (obj.isFaceDown) return;

	// CR 702.44a: Sunburst
	const abilities = activeAbilityDefs(card, instanceFaceOptions(obj));
	if (abilities.some((a) => a.kind === 'keyword' && keywordNameOf(a.keyword) === 'sunburst') || obj.grantedSunburst) {
		const colorsSpent = obj.manaColorsSpent?.length ?? 0;
		if (colorsSpent > 0) {
			const isCreature = face.types.includes('Creature');
			placeCounterFn(state, obj, isCreature ? '+1/+1' : 'charge', colorsSpent);
		}
	}

	// CR 702.58a–b: Graft N — enters the battlefield with N +1/+1 counters (multiple instances sum)
	let graftTotal = 0;
	for (const ab of abilities) {
		if (ab.kind === 'keyword' && keywordNameOf(ab.keyword) === 'graft') {
			graftTotal += Math.max(0, ab.keyword.n ?? 0);
		}
	}
	if (graftTotal > 0) {
		placeCounterFn(state, obj, '+1/+1', graftTotal);
	}

	// CR 702.82a: Devour +1/+1 counters from sacrificed creatures
	const devourKw = findDevourKeywordDef(obj);
	if (devourKw && obj.devouredCount !== undefined && obj.devouredCount > 0) {
		const count = obj.devouredCount;
		const mult = devourKw.devourX ? count : Math.max(0, devourKw.n ?? 1);
		const totalCounters = count * mult;
		if (totalCounters > 0) {
			placeCounterFn(state, obj, '+1/+1', totalCounters);
		}
	}
}

export function executeDevourSacrifices(
	state: GameState,
	entering: CardInstance,
	controller: PlayerGameState,
	chosenIds: string[]
): void {
	let sacrificed = 0;
	for (const cid of chosenIds) {
		const perm = controller.battlefield.find((c) => c.instanceId === cid && !c.phasedOut);
		if (!perm) continue;
		moveObject(state, perm, 'graveyard', {
			from: { player: controller, zone: 'battlefield' }
		});
		sacrificed++;
	}
	entering.devouredCount = sacrificed;
}

// ============================================================================
// 5. Umbra Armor (CR 702.89a) & Dredge (CR 702.52a)
// ============================================================================

/**
 * CR 702.89a: "If enchanted permanent would be destroyed, instead remove all damage from it and
 * destroy this Aura." Unlike regeneration, does NOT tap or remove from combat.
 */
export function tryUmbraArmorInsteadOfDestroy(
	state: GameState,
	perm: CardInstance
): boolean {
	if (perm.zone !== 'battlefield' || perm.phasedOut) return false;
	const umbraAuras: Array<{ aura: CardInstance; owner: PlayerGameState }> = [];
	for (const p of state.players) {
		for (const cand of p.battlefield) {
			if (cand.phasedOut || cand.attachedToId !== perm.instanceId) continue;
			const ev = evaluatePermanent(state, cand);
			if (!ev.hasSubType('Aura')) continue;
			const hasUmbra = ev.keywords.some((k) => k.toLowerCase() === 'umbra armor');
			if (hasUmbra) {
				umbraAuras.push({ aura: cand, owner: p });
			}
		}
	}
	if (umbraAuras.length === 0) return false;
	const chosen = umbraAuras[0];
	perm.damageMarked = 0;
	perm.deathtouchDamageMarked = false;
	const host = requireHost();
	host.addLog(
		state,
		'rule',
		`Umbra armor (${chosen.aura.card.name}): removed all damage from ${perm.card.name} and destroyed ${chosen.aura.card.name} instead (CR 702.89a).`,
		chosen.aura.controllerId
	);
	moveObject(state, chosen.aura, 'graveyard', {
		from: { player: chosen.owner, zone: 'battlefield' }
	});
	host.flushTriggers(state);
	return true;
}

const WAVE4_DREDGE_HANDLER = 'wave4_dredge_choice';

export function findDredgeCandidates(
	player: PlayerGameState
): Array<{ inst: CardInstance; n: number }> {
	const out: Array<{ inst: CardInstance; n: number }> = [];
	for (const c of player.graveyard) {
		const abilities = activeAbilityDefs(effectiveCardForObject(c), instanceFaceOptions(c));
		for (const ab of abilities) {
			if (ab.kind === 'keyword' && keywordNameOf(ab.keyword) === 'dredge') {
				const n = ab.keyword.n ?? 0;
				if (n > 0 && player.library.length >= n) {
					out.push({ inst: c, n });
					break;
				}
			}
		}
	}
	return out;
}

export function performDredgeReplacement(
	state: GameState,
	player: PlayerGameState,
	dredgeCard: CardInstance,
	n: number
): boolean {
	if (player.library.length < n) return false;
	if (!player.graveyard.some((c) => c.instanceId === dredgeCard.instanceId)) return false;
	const host = requireHost();
	const toMill = player.library.slice(0, n);
	for (const milled of toMill) {
		moveObject(state, milled, 'graveyard', {
			from: { player, zone: 'library' },
			toPlayer: state.players.find((p) => p.playerId === milled.ownerId) ?? player
		});
	}
	moveObject(state, dredgeCard, 'hand', {
		from: { player, zone: 'graveyard' },
		toPlayer: player
	});
	host.addLog(
		state,
		'rule',
		`${player.username} dredged ${dredgeCard.card.name} (milled ${n} card(s) and returned ${dredgeCard.card.name} to hand instead of drawing, CR 702.52a).`,
		player.playerId
	);
	return true;
}

export function tryDredgeBeforeSingleDraw(
	state: GameState,
	player: PlayerGameState,
	remainingDrawsAfterThis: number,
	deferSba: boolean
): 'none' | 'replaced' | 'prompted' {
	if (state.status === 'mulligan') return 'none';
	const candidates = findDredgeCandidates(player);
	if (candidates.length === 0) return 'none';
	const host = requireHost();
	if (player.isBot) {
		const safe = candidates.find((c) => player.library.length >= c.n + 8);
		if (!safe) return 'none';
		performDredgeReplacement(state, player, safe.inst, safe.n);
		return 'replaced';
	}
	const modes = [
		'Draw a card normally',
		...candidates.map(
			(c) => `Dredge ${c.n} — ${c.inst.card.name} (mill ${c.n}, return to hand)`
		)
	];
	const nById: Record<string, number> = {};
	for (const c of candidates) nById[c.inst.instanceId] = c.n;
	enqueueChoicePrompt(state, {
		id: host.uid('prm', state),
		playerId: player.playerId,
		kind: 'chooseMode',
		purpose: 'generic',
		title: 'Dredge Replacement (CR 702.52a)',
		description: 'Choose whether to draw a card normally or replace the draw with Dredge.',
		choice: {
			kind: 'chooseMode',
			modes,
			min: 1,
			max: 1
		},
		continuation: {
			kind: 'handler',
			name: WAVE4_DREDGE_HANDLER,
			data: {
				playerId: player.playerId,
				candidateIds: candidates.map((c) => c.inst.instanceId),
				nById,
				remainingDrawsAfterThis,
				deferSba
			}
		}
	});
	return 'prompted';
}

registerPromptHandler(WAVE4_DREDGE_HANDLER, (state, prompt, answer) => {
	const host = requireHost();
	const data = (prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined) as
		| {
				playerId: string;
				candidateIds: string[];
				nById: Record<string, number>;
				remainingDrawsAfterThis: number;
				deferSba: boolean;
		  }
		| undefined;
	if (!data) return;
	const player = state.players.find((p) => p.playerId === data.playerId);
	if (!player) return;
	const choiceIdx = answer.kind === 'chooseMode' ? (answer.indices[0] ?? 0) : 0;
	if (choiceIdx <= 0) {
		host.drawSingleCardWithoutDredge(state, player, data.deferSba);
	} else {
		const candIdx = choiceIdx - 1;
		const cardId = data.candidateIds[candIdx];
		const n = cardId ? (data.nById[cardId] ?? 0) : 0;
		const dredgeCard = player.graveyard.find((c) => c.instanceId === cardId);
		if (dredgeCard && n > 0 && player.library.length >= n) {
			performDredgeReplacement(state, player, dredgeCard, n);
			if (!data.deferSba) host.flushTriggers(state);
		} else {
			host.drawSingleCardWithoutDredge(state, player, data.deferSba);
		}
	}
	if (data.remainingDrawsAfterThis > 0 && state.status !== 'finished') {
		host.drawCards(state, player, data.remainingDrawsAfterThis, data.deferSba);
	}
});

/** Marks a drawn card for Miracle (`CR 702.94a`) if it is the FIRST card drawn by `player` this turn. */
export function noteDrawnCardForMiracle(
	state: GameState,
	player: PlayerGameState,
	drawnCard: CardInstance
): void {
	if ((player.cardsDrawnThisTurn ?? 0) !== 1) return;
	const abilities = activeAbilityDefs(effectiveCardForObject(drawnCard), instanceFaceOptions(drawnCard));
	if (abilities.some((a) => a.kind === 'keyword' && keywordNameOf(a.keyword) === 'miracle')) {
		drawnCard.miracleTurnSerial = state.turnSerial ?? state.turnNumber;
		requireHost().markHandCardRevealedToAll(state, drawnCard);
	}
}

// ============================================================================
// 6. Cast Options, Modal Per-Mode Costs (Spree/Tiered/Escalate), Emerge & Harmonize
// ============================================================================

export function addManaCostRequirements(
	a: ManaCostRequirement,
	b: ManaCostRequirement
): ManaCostRequirement {
	return {
		colored: {
			W: a.colored.W + b.colored.W,
			U: a.colored.U + b.colored.U,
			B: a.colored.B + b.colored.B,
			R: a.colored.R + b.colored.R,
			G: a.colored.G + b.colored.G,
			C: a.colored.C + b.colored.C
		},
		generic: a.generic + b.generic,
		hasX: a.hasX || b.hasX,
		xCount: a.xCount + b.xCount,
		totalCmc: a.totalCmc + b.totalCmc,
		...(a.flexibleSymbols?.length || b.flexibleSymbols?.length
			? {
					flexibleSymbols: [...(a.flexibleSymbols ?? []), ...(b.flexibleSymbols ?? [])]
				}
			: {})
	};
}

export function cardHasEscalate(card: ScryfallCard, faceIndex = 0): boolean {
	const abilities = activeAbilityDefs(card, { zone: 'stack', faceIndex });
	return abilities.some((a) => a.kind === 'keyword' && keywordNameOf(a.keyword) === 'escalate');
}

export function computeModalModeAdditionalCosts(
	card: ScryfallCard,
	faceIndex: number | undefined,
	modal: ModalDef | undefined,
	chosenModes: number[] | undefined
): { manaCosts: string[]; costDefs: CostDef[] } {
	const manaCosts: string[] = [];
	const costDefs: CostDef[] = [];
	if (!chosenModes || chosenModes.length === 0) return { manaCosts, costDefs };

	if (modal?.perModeCosts) {
		for (const mIdx of chosenModes) {
			const entry = modal.perModeCosts[mIdx];
			if (!entry) continue;
			for (const cd of entry) {
				if (cd.k === 'mana') {
					manaCosts.push(cd.cost);
				} else {
					costDefs.push(cd);
				}
			}
		}
	}

	const abilities = activeAbilityDefs(card, { zone: 'stack', faceIndex });
	for (const ab of abilities) {
		if (ab.kind === 'keyword' && keywordNameOf(ab.keyword) === 'escalate') {
			const extraCount = Math.max(0, chosenModes.length - 1);
			for (let k = 0; k < extraCount; k++) {
				if (ab.keyword.cost) manaCosts.push(ab.keyword.cost);
				if (ab.keyword.costDefs?.length) costDefs.push(...ab.keyword.costDefs);
			}
		}
	}
	return { manaCosts, costDefs };
}

export function cardFaceHasAftermath(card: ScryfallCard, faceIndex: number): boolean {
	if (faceIndex <= 0) return false;
	const abilities = activeAbilityDefs(card, { zone: 'graveyard', faceIndex });
	return abilities.some((a) => a.kind === 'keyword' && keywordNameOf(a.keyword) === 'aftermath');
}

export interface Wave4CastOptionsContext {
	state: GameState;
	actor: PlayerGameState | undefined;
	actorId: string;
	inst: CardInstance;
	fromZone: 'hand' | 'command' | 'exile' | 'graveyard' | 'library';
	taxSuffix: string;
	matchesFilterFn: (obj: CardInstance, filter: ObjectFilter, ctx: FilterContext) => boolean;
	buildPaymentAids: (
		zone: 'hand' | 'command' | 'exile' | 'graveyard' | 'library',
		faceIdx: number,
		isFused: boolean,
		isFree: boolean
	) => CastCostAid[] | undefined;
	getSpellTargetRequirement: (
		card: ScryfallCard,
		option?: Partial<Pick<CastOption, 'faceIndex' | 'fused' | 'optionalAdditionalCosts' | 'spellMods'>>
	) => TargetRequirementInfo;
}

export function collectWave4CastOptionsForCard(ctx: Wave4CastOptionsContext): CastOption[] {
	const { state, actor, inst, fromZone, taxSuffix, matchesFilterFn, buildPaymentAids, getSpellTargetRequirement } =
		ctx;
	if (!actor || inst.castViaSuspend) return [];
	if (fromZone === 'exile' && inst.playableFromExileBy?.withoutPayingManaCost) return [];

	const out: CastOption[] = [];
	const card = effectiveCardForObject(inst);
	const currentTurnKey = state.turnSerial ?? state.turnNumber;

	const makeOption = (params: {
		id: string;
		label: string;
		costDisplay: string;
		zone: 'hand' | 'command' | 'graveyard';
		faceIndex?: number;
		baseCost: CastOption['baseCost'];
		timing?: CastOption['timing'];
		spellMods: SpellModifications;
		requiresTargetOverride?: boolean;
		awakenCounters?: number;
		emergeBaseCost?: string;
		emergeCandidateIds?: string[];
	}): CastOption => {
		const fi = params.faceIndex ?? 0;
		const additional = spellAdditionalCost(card, fi, false);
		const mandatoryAdditionalCosts =
			additional && additional.defs.length > 0 ? additional.defs : undefined;
		const optionalAdditionalCosts: CastOptionOptionalCost[] = spellOptionalAdditionalCosts(
			card,
			fi,
			false
		);
		const paymentAids = buildPaymentAids(params.zone, fi, false, false);
		const targetInfo = getSpellTargetRequirement(card, {
			faceIndex: fi,
			spellMods: params.spellMods
		});
		return {
			id: params.id,
			label: params.label,
			costDisplay: `${params.costDisplay}${taxSuffix}`,
			fromZone: params.zone,
			permission: 'keyword_alt',
			...(params.faceIndex !== undefined ? { faceIndex: params.faceIndex } : {}),
			baseCost: params.baseCost,
			...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
			...(optionalAdditionalCosts.length > 0 ? { optionalAdditionalCosts } : {}),
			...(paymentAids ? { paymentAids } : {}),
			timing: params.timing ?? 'default',
			spellMods: params.spellMods,
			choosesX: spellChoosesX(card, params.baseCost, undefined, fi, false),
			requiresTarget: params.requiresTargetOverride ?? targetInfo.requiresTarget,
			...(params.awakenCounters !== undefined ? { awakenCounters: params.awakenCounters } : {}),
			...(params.emergeBaseCost !== undefined ? { emergeBaseCost: params.emergeBaseCost } : {}),
			...(params.emergeCandidateIds !== undefined
				? { emergeCandidateIds: params.emergeCandidateIds }
				: {})
		};
	};

	const isCommanderFromCommand =
		fromZone === 'command' && Boolean(inst.isCommander) && inst.ownerId === actor.playerId;
	// --- Track P22a ---
	const isSelfGyBestow =
		fromZone === 'graveyard' &&
		inst.ownerId === actor.playerId &&
		hasSelfGraveyardKeywordCastWave8(card, 0, 'bestow', state, actor.playerId, inst);
	// --- End Track P22a ---

	if (fromZone === 'hand' || isCommanderFromCommand || isSelfGyBestow) {
		const abilities = activeAbilityDefs(card, { zone: fromZone, faceIndex: 0 });
		for (const ab of abilities) {
			if (ab.kind !== 'keyword') continue;
			const kw = ab.keyword;
			const kwName = keywordNameOf(kw);
			const nonManaKwDefs = (kw.costDefs ?? []).filter((d) => d.k !== 'mana');
			const altBaseCost: CastOption['baseCost'] = {
				kind: 'alternative',
				...(kw.cost !== undefined ? { manaCost: kw.cost } : {}),
				...(nonManaKwDefs.length > 0 ? { costDefs: nonManaKwDefs } : {})
			};
			const disp = kw.cost || '{0}';
			switch (kwName) {
				case 'bestow': {
					if (fromZone !== 'hand' && !isSelfGyBestow) break;
					if (kw.cost === undefined && !kw.costDefs?.length) break;
					out.push(
						makeOption({
							id: isSelfGyBestow ? 'graveyard:bestow' : 'alt:bestow',
							label: `Bestow ${disp}`,
							costDisplay: disp,
							zone: fromZone,
							baseCost: altBaseCost,
							spellMods: { bestowed: true, castSummarySuffix: ' (Bestowed)', label: 'Bestow' },
							requiresTargetOverride: true
						})
					);
					break;
				}
				case 'awaken': {
					if (fromZone !== 'hand') break;
					if ((kw.cost === undefined && !kw.costDefs?.length) || !kw.awakenN) break;
					out.push(
						makeOption({
							id: 'alt:awaken',
							label: `Awaken ${kw.awakenN} — ${disp}`,
							costDisplay: disp,
							zone: 'hand',
							baseCost: altBaseCost,
							awakenCounters: kw.awakenN,
							spellMods: {
								awakenCounters: kw.awakenN,
								castSummarySuffix: ` (Awaken ${kw.awakenN})`,
								label: `Awaken ${kw.awakenN}`
							},
							requiresTargetOverride: true
						})
					);
					break;
				}
				case 'spectacle': {
					if (fromZone !== 'hand') break;
					if (kw.cost === undefined && !kw.costDefs?.length) break;
					const oppLostLife = state.players.some(
						(p) => !p.lost && p.playerId !== actor.playerId && (p.lifeLostThisTurn ?? 0) > 0
					);
					if (oppLostLife) {
						out.push(
							makeOption({
								id: 'alt:spectacle',
								label: `Spectacle ${disp}`,
								costDisplay: disp,
								zone: 'hand',
								baseCost: altBaseCost,
								spellMods: { castSummarySuffix: ' (Spectacle)', label: 'Spectacle' }
							})
						);
					}
					break;
				}
				case 'surge': {
					if (fromZone !== 'hand') break;
					if (kw.cost === undefined && !kw.costDefs?.length) break;
					if ((actor.spellsCastThisTurn ?? 0) > 0) {
						out.push(
							makeOption({
								id: 'alt:surge',
								label: `Surge ${disp}`,
								costDisplay: disp,
								zone: 'hand',
								baseCost: altBaseCost,
								spellMods: { castSummarySuffix: ' (Surge)', label: 'Surge' }
							})
						);
					}
					break;
				}
				case 'miracle': {
					if (fromZone !== 'hand') break;
					if (kw.cost === undefined && !kw.costDefs?.length) break;
					if (inst.miracleTurnSerial !== undefined && inst.miracleTurnSerial === currentTurnKey) {
						out.push(
							makeOption({
								id: 'alt:miracle',
								label: `Miracle ${disp}`,
								costDisplay: disp,
								zone: 'hand',
								baseCost: altBaseCost,
								timing: 'instant_only',
								spellMods: {
									miracleCast: true,
									castSummarySuffix: ' (Miracle)',
									label: 'Miracle'
								}
							})
						);
					}
					break;
				}
				case 'emerge': {
					if (fromZone !== 'hand') break;
					if (kw.cost === undefined) break;
					const cands = legalEmergeCandidates(state, actor, inst, kw, matchesFilterFn);
					if (cands.length > 0) {
						out.push(
							makeOption({
								id: 'alt:emerge',
								label: `Emerge ${disp}`,
								costDisplay: disp,
								zone: 'hand',
								baseCost: altBaseCost,
								emergeBaseCost: kw.cost,
								emergeCandidateIds: cands.map((c) => c.instanceId),
								spellMods: { emerged: true, castSummarySuffix: ' (Emerge)', label: 'Emerge' }
							})
						);
					}
					break;
				}
				case 'web-slinging': {
					// CR 702.188a: Cast by paying [cost] and returning a tapped creature you control to its owner's hand.
					if (kw.cost === undefined && !kw.costDefs?.length) break;
					const hasTappedCreature = actor.battlefield.some(
						(p) => !p.phasedOut && p.tapped && evaluatePermanent(state, p).isCreature
					);
					if (!hasTappedCreature) break;
					const bounceTappedDef: CostDef = {
						k: 'returnToHand',
						count: { k: 'const', n: 1 },
						filter: { types: ['Creature'], controller: 'you', zone: 'battlefield', tapped: true }
					};
					out.push(
						makeOption({
							id: 'alt:web_slinging',
							label: `Web-slinging ${disp}`,
							costDisplay: `${disp}, Return a tapped creature you control to hand`,
							zone: fromZone,
							baseCost: {
								kind: 'alternative',
								...(kw.cost !== undefined ? { manaCost: kw.cost } : {}),
								costDefs: [...nonManaKwDefs, bounceTappedDef]
							},
							spellMods: {
								castSummarySuffix: ' (Web-slinging)',
								label: 'Web-slinging'
							}
						})
					);
					break;
				}
				case 'sneak': {
					// CR 702.190a–b: Cast during your declare blockers step by paying [cost] and returning an unblocked attacker you control to hand.
					if (kw.cost === undefined && !kw.costDefs?.length) break;
					if (
						state.phase !== 'declare_blockers' ||
						state.players[state.activePlayerIndex]?.playerId !== actor.playerId
					) {
						break;
					}
					const unblockedFilter: ObjectFilter = {
						types: ['Creature'],
						controller: 'you',
						zone: 'battlefield',
						unblockedAttacker: true
					};
					const fctx: FilterContext = { state, controllerId: actor.playerId, source: inst };
					const hasUnblockedAttacker = actor.battlefield.some(
						(p) => !p.phasedOut && matchesFilterFn(p, unblockedFilter, fctx)
					);
					if (!hasUnblockedAttacker) break;
					const bounceUnblockedDef: CostDef = {
						k: 'returnToHand',
						count: { k: 'const', n: 1 },
						filter: unblockedFilter
					};
					out.push(
						makeOption({
							id: 'alt:sneak',
							label: `Sneak ${disp}`,
							costDisplay: `${disp}, Return an unblocked attacker you control to hand`,
							zone: fromZone,
							baseCost: {
								kind: 'alternative',
								...(kw.cost !== undefined ? { manaCost: kw.cost } : {}),
								costDefs: [...nonManaKwDefs, bounceUnblockedDef]
							},
							timing: 'instant_only',
							spellMods: {
								sneaked: true,
								castSummarySuffix: ' (Sneak)',
								label: 'Sneak'
							}
						})
					);
					break;
				}
			}
		}
	} else if (fromZone === 'graveyard') {
		const face0 = resolveObjectFaces(card, { zone: 'graveyard', faceIndex: 0 });
		const isPureLand = face0.types.includes('Land') && face0.types.every((t) => t === 'Land');
		const abilities = activeAbilityDefs(card, { zone: 'graveyard', faceIndex: 0 });
		for (const ab of abilities) {
			if (ab.kind !== 'keyword') continue;
			const kw = ab.keyword;
			const kwName = keywordNameOf(kw);
			const nonManaKwDefs = (kw.costDefs ?? []).filter((d) => d.k !== 'mana');
			if (kwName === 'harmonize' && kw.cost !== undefined) {
				const disp = kw.cost || '{0}';
				out.push(
					makeOption({
						id: 'graveyard:harmonize',
						label: `Harmonize ${disp}`,
						costDisplay: disp,
						zone: 'graveyard',
						baseCost: {
							kind: 'alternative',
							manaCost: kw.cost,
							...(nonManaKwDefs.length > 0 ? { costDefs: nonManaKwDefs } : {})
						},
						spellMods: {
							exileOnLeaveStack: true,
							harmonized: true,
							castSummarySuffix: ' (Harmonize)',
							label: 'Harmonize'
						}
					})
				);
			} else if (kwName === 'beam me up' && (kw.cost !== undefined || kw.costDefs?.length)) {
				// CR 702.196a: Cast this instant or sorcery card from your graveyard by paying [cost] and returning a creature you control to hand; exile on leaving stack.
				if (!face0.types.includes('Instant') && !face0.types.includes('Sorcery')) continue;
				const hasCreature = actor.battlefield.some(
					(p) => !p.phasedOut && evaluatePermanent(state, p).isCreature
				);
				if (!hasCreature) continue;
				const disp = kw.cost || '{0}';
				const bounceCreatureDef: CostDef = {
					k: 'returnToHand',
					count: { k: 'const', n: 1 },
					filter: { types: ['Creature'], controller: 'you', zone: 'battlefield' }
				};
				out.push(
					makeOption({
						id: 'graveyard:beam_me_up',
						label: `Beam me up ${disp}`,
						costDisplay: `${disp}, Return a creature you control to hand`,
						zone: 'graveyard',
						baseCost: {
							kind: 'alternative',
							...(kw.cost !== undefined ? { manaCost: kw.cost } : {}),
							costDefs: [...nonManaKwDefs, bounceCreatureDef]
						},
						spellMods: {
							exileOnLeaveStack: true,
							castSummarySuffix: ' (Beam me up)',
							label: 'Beam me up'
						}
					})
				);
			} else if (kwName === 'mayhem' && !isPureLand) {
				// CR 702.187b–c: Cast this card from your graveyard if you discarded it this turn (does NOT exile on leaving stack).
				if (
					inst.discardedByPlayerIdThisTurn !== actor.playerId ||
					inst.discardedTurnSerial !== currentTurnKey
				) {
					continue;
				}
				if (kw.cost !== undefined || kw.costDefs?.length) {
					const disp = kw.cost || '{0}';
					out.push(
						makeOption({
							id: 'graveyard:mayhem',
							label: `Mayhem ${disp}`,
							costDisplay: disp,
							zone: 'graveyard',
							baseCost: {
								kind: 'alternative',
								...(kw.cost !== undefined ? { manaCost: kw.cost } : {}),
								...(nonManaKwDefs.length > 0 ? { costDefs: nonManaKwDefs } : {})
							},
							spellMods: {
								castSummarySuffix: ' (Mayhem)',
								label: 'Mayhem'
							}
						})
					);
				} else {
					out.push(
						makeOption({
							id: 'graveyard:mayhem',
							label: 'Cast from Graveyard (Mayhem)',
							costDisplay: card.manaCost || '{0}',
							zone: 'graveyard',
							baseCost: { kind: 'printed' },
							spellMods: {
								castSummarySuffix: ' (Mayhem)',
								label: 'Mayhem'
							}
						})
					);
				}
			}
		}
		if (card.layout === 'split' && card.faces && card.faces.length >= 2) {
			if (cardFaceHasAftermath(card, 1)) {
				const f1 = card.faces[1];
				const f1Name = f1.name;
				const f1Mana = f1.manaCost || '{0}';
				out.push(
					makeOption({
						id: 'graveyard:aftermath',
						label: `Aftermath — ${f1Name}`,
						costDisplay: f1Mana,
						zone: 'graveyard',
						faceIndex: 1,
						baseCost: { kind: 'printed' },
						spellMods: {
							exileOnLeaveStack: true,
							castSummarySuffix: ' (Aftermath)',
							label: 'Aftermath'
						}
					})
				);
			}
		}
	}
	return out;
}

/** CR 702.187c: Bare Mayhem allows playing a land card from your graveyard if you discarded it this turn. */
export function canPlayGraveyardLandViaMayhem(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	faceIndex?: number
): boolean {
	const currentTurnKey = state.turnSerial ?? state.turnNumber;
	if (
		inst.discardedByPlayerIdThisTurn !== actorId ||
		inst.discardedTurnSerial !== currentTurnKey
	) {
		return false;
	}
	const abilities = activeAbilityDefs(effectiveCardForObject(inst), {
		zone: 'graveyard',
		faceIndex: faceIndex ?? 0
	});
	return abilities.some(
		(a) =>
			a.kind === 'keyword' &&
			keywordNameOf(a.keyword) === 'mayhem' &&
			a.keyword.cost === undefined &&
			!a.keyword.costDefs?.length
	);
}

/**
 * CR 702.190b, CR 506.3a–d, CR 508.4: Places a permanent cast via Sneak into combat attacking the
 * same player or planeswalker the returned unblocked attacker was attacking, without firing
 * "Whenever ~ attacks" triggers.
 */
export function placeSneakedPermanentIntoCombat(
	state: GameState,
	controller: PlayerGameState,
	perm: CardInstance,
	attackTarget?: { defenderPlayerId: string; defenderPlaneswalkerId?: string | null }
): void {
	if (perm.zone !== 'battlefield' || perm.phasedOut || !state.combat.active) return;
	if (!evaluatePermanent(state, perm).isCreature) return; // CR 506.3a
	if (state.players[state.activePlayerIndex]?.playerId !== controller.playerId) return; // CR 506.3b
	if (!attackTarget) return; // CR 506.3c
	const defPlayer = state.players.find(
		(p) => p.playerId === attackTarget.defenderPlayerId && !p.lost && p.playerId !== controller.playerId
	);
	if (!defPlayer) return; // CR 506.3c
	if (attackTarget.defenderPlaneswalkerId) {
		const pwStillValid = defPlayer.battlefield.some(
			(c) =>
				c.instanceId === attackTarget.defenderPlaneswalkerId &&
				!c.phasedOut &&
				evaluatePermanent(state, c).isPlaneswalker
		);
		if (!pwStillValid) return; // CR 506.3c
	}
	state.combat.attackers.push({
		attackerInstanceId: perm.instanceId,
		controllerId: controller.playerId,
		defenderPlayerId: defPlayer.playerId,
		...(attackTarget.defenderPlaneswalkerId
			? { defenderPlaneswalkerId: attackTarget.defenderPlaneswalkerId }
			: {}),
		blockerInstanceIds: [],
		wasBlocked: false
	});
}

export function legalEmergeCandidates(
	state: GameState,
	actor: PlayerGameState,
	spellInst: CardInstance,
	kw: KeywordDef,
	matchesFilterFn: (obj: CardInstance, filter: ObjectFilter, ctx: FilterContext) => boolean
): CardInstance[] {
	const filter: ObjectFilter = kw.emergeFilter ?? { types: ['Creature'] };
	const ctx: FilterContext = { state, controllerId: actor.playerId, source: spellInst };
	const out: CardInstance[] = [];
	for (const perm of actor.battlefield) {
		if (perm.phasedOut) continue;
		const ev = evaluatePermanent(state, perm);
		if (!filter.types?.length && !ev.isCreature) continue;
		if (!matchesFilterFn(perm, filter, ctx)) continue;
		out.push(perm);
	}
	return out;
}

export function findPayableEmergeCandidates(
	state: GameState,
	actor: PlayerGameState,
	spellInst: CardInstance,
	option: CastOption,
	xValue: number,
	extraManaCosts: string[],
	matchesFilterFn: (obj: CardInstance, filter: ObjectFilter, ctx: FilterContext) => boolean
): Array<{ perm: CardInstance; req: ManaCostRequirement }> {
	const host = requireHost();
	const card = effectiveCardForObject(spellInst);
	const abilities = activeAbilityDefs(card, { zone: 'hand', faceIndex: option.faceIndex ?? 0 });
	const kw = abilities.find((a) => a.kind === 'keyword' && keywordNameOf(a.keyword) === 'emerge');
	if (!kw || kw.kind !== 'keyword') return [];
	const cands = legalEmergeCandidates(state, actor, spellInst, kw.keyword, matchesFilterFn);
	const out: Array<{ perm: CardInstance; req: ManaCostRequirement }> = [];
	const baseReq = effectiveSpellManaCost(
		state,
		actor,
		spellInst,
		xValue,
		option.baseCost,
		extraManaCosts,
		option.faceIndex ?? 0,
		option.fused ?? false,
		option.spellMods?.castFaceDown,
		option.spellMods?.prototyped
	);
	for (const perm of cands) {
		const mv = Math.max(0, effectiveManaValue(effectiveCardForObject(perm), instanceFaceOptions(perm)));
		const reducedReq: ManaCostRequirement = {
			...baseReq,
			generic: Math.max(0, baseReq.generic - mv)
		};
		const reserved = new Set<string>([perm.instanceId]);
		if (host.canPayOrAutoTap(actor, reducedReq, state, undefined, reserved)) {
			out.push({ perm, req: reducedReq });
		}
	}
	return out;
}

export function findPayableHarmonizeOptions(
	state: GameState,
	actor: PlayerGameState,
	spellInst: CardInstance,
	option: CastOption,
	xValue: number,
	extraManaCosts: string[]
): {
	noTapReq: ManaCostRequirement | null;
	tapCandidates: Array<{ perm: CardInstance; power: number; req: ManaCostRequirement }>;
} {
	const host = requireHost();
	const baseReq = effectiveSpellManaCost(
		state,
		actor,
		spellInst,
		xValue,
		option.baseCost,
		extraManaCosts,
		option.faceIndex ?? 0,
		option.fused ?? false,
		option.spellMods?.castFaceDown,
		option.spellMods?.prototyped
	);
	const noTapReq = host.canPayOrAutoTap(actor, baseReq, state) ? baseReq : null;
	const tapCandidates: Array<{ perm: CardInstance; power: number; req: ManaCostRequirement }> = [];
	for (const perm of actor.battlefield) {
		if (perm.phasedOut || perm.tapped) continue;
		const ev = evaluatePermanent(state, perm);
		if (!ev.isCreature) continue;
		const pwr = Math.max(0, ev.power);
		const reducedReq: ManaCostRequirement = {
			...baseReq,
			generic: Math.max(0, baseReq.generic - pwr)
		};
		const reserved = new Set<string>([perm.instanceId]);
		if (host.canPayOrAutoTap(actor, reducedReq, state, undefined, reserved)) {
			tapCandidates.push({ perm, power: pwr, req: reducedReq });
		}
	}
	tapCandidates.sort((a, b) => b.power - a.power);
	return { noTapReq, tapCandidates };
}

export const AWAKEN_LAND_TARGET_SPEC: TargetSpec = {
	kind: 'object',
	filter: {
		zone: 'battlefield',
		types: ['Land'],
		controller: 'you'
	},
	min: 1,
	max: 1
};

export function applyAwakenOnSpellResolution(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState
): void {
	const n = item.spellMods?.awakenCounters ?? 0;
	const landId = item.awakenTargetId;
	if (n <= 0 || !landId) return;
	const found = findPermanentAcrossPlayers(state, landId);
	if (!found || found.inst.controllerId !== controller.playerId) return;
	if (
		item.awakenTargetVersion !== undefined &&
		found.inst.objectVersion !== item.awakenTargetVersion
	) {
		return;
	}
	const ev = evaluatePermanent(state, found.inst);
	if (!ev.isLand) return;
	const host = requireHost();
	host.addCountersToPermanent(state, found.inst, '+1/+1', n);
	(state.timedContinuousEffects ??= []).push({
		timestamp: allocateTimestamp(state),
		sourceName: item.card?.name ?? item.title,
		controllerId: controller.playerId,
		affected: [
			{
				instanceId: found.inst.instanceId,
				objectVersion: found.inst.objectVersion ?? 1
			}
		],
		expires: 'never',
		layer4: {
			addTypes: ['Creature'],
			addSubtypes: ['Elemental']
		},
		layer6: {
			addKeywords: ['haste']
		},
		layer7b: {
			setPower: 0,
			setToughness: 0
		}
	});
	noteLayerInputsChanged(state);
	host.addLog(
		state,
		'cast',
		`Awaken ${n}: put ${n} +1/+1 counter(s) on ${found.inst.card.name} and animated it into a 0/0 Elemental creature with haste (CR 702.113a).`,
		controller.playerId
	);
}

// ============================================================================
// 7. Synthetic RuntimeTriggers for Wave 4 Custom Triggered Keywords
// ============================================================================

export const WAVE4_GRANTABLE_TRIGGER_PREFIXES = [
	'afflict',
	'decayed',
	'dethrone',
	'enlist',
	'firebending',
	'ingest',
	'melee',
	'mentor',
	'mobilize',
	'myriad',
	'rampage',
	'renown',
	'training'
] as const;

export function parseGrantedWave4TriggerKeyword(
	rawKw: string
): { base: string; n?: number } | null {
	const lc = rawKw.trim().toLowerCase();
	for (const p of WAVE4_GRANTABLE_TRIGGER_PREFIXES) {
		if (lc === p) return { base: p };
		if (lc.startsWith(`${p} `)) {
			const tail = Number.parseInt(lc.slice(p.length + 1).trim(), 10);
			if (Number.isFinite(tail) && tail > 0) return { base: p, n: tail };
		}
	}
	return null;
}

export function wave4TriggerTargetSpecs(item: StackItem): TargetSpec[] | null {
	if (item.wave4Tag === 'backup') {
		return [
			{
				kind: 'object',
				filter: { zone: 'battlefield', types: ['Creature'] },
				min: 1,
				max: 1
			}
		];
	}
	if (item.wave4Tag === 'mentor') {
		return [
			{
				kind: 'object',
				filter: {
					zone: 'battlefield',
					types: ['Creature'],
					attacking: true,
					other: true,
					powerLessThanSource: true
				},
				min: 1,
				max: 1
			}
		];
	}
	return null;
}

export function buildSingleWave4KeywordTriggers(
	kw: KeywordDef,
	abilityIndex: number,
	grantedKeyword?: string
): Wave4RuntimeTrigger[] {
	const out: Wave4RuntimeTrigger[] = [];
	const baseFields = grantedKeyword ? { grantedKeyword } : {};
	const dummySpan = { start: 0, end: 0 };
	switch (keywordNameOf(kw)) {
		case 'dethrone': {
			out.push({
				abilityIndex,
				trigger: {
					event: 'attacks',
					filter: { object: 'self', dethroneMostLife: true }
				},
				effectSupported: true,
				effect: {
					steps: [
						{
							verb: 'putCounters',
							subject: { k: 'self' },
							amount: { k: 'const', n: 1 },
							params: { counter: '+1/+1' },
							span: dummySpan
						}
					],
					targets: [],
					unparsed: []
				},
				text: 'Dethrone',
				...baseFields
			});
			break;
		}
		case 'training': {
			out.push({
				abilityIndex,
				trigger: {
					event: 'attacks',
					filter: { object: 'self', trainingGreaterAttacker: true }
				},
				effectSupported: true,
				effect: {
					steps: [
						{
							verb: 'putCounters',
							subject: { k: 'self' },
							amount: { k: 'const', n: 1 },
							params: { counter: '+1/+1' },
							span: dummySpan
						}
					],
					targets: [],
					unparsed: []
				},
				text: 'Training',
				...baseFields
			});
			break;
		}
		case 'mobilize': {
			const n = kw.n ?? 1;
			out.push({
				abilityIndex,
				trigger: {
					event: 'attacks',
					filter: { object: 'self' }
				},
				effectSupported: true,
				text: `Mobilize ${n}`,
				wave4Tag: 'mobilize',
				wave4N: n,
				...baseFields
			});
			break;
		}
		case 'firebending': {
			const n = kw.n ?? 1;
			out.push({
				abilityIndex,
				trigger: {
					event: 'attacks',
					filter: { object: 'self' }
				},
				effectSupported: true,
				text: `Firebending ${n}`,
				wave4Tag: 'firebending',
				wave4N: n,
				...baseFields
			});
			break;
		}
		case 'backup': {
			const n = kw.n ?? 1;
			out.push({
				abilityIndex,
				trigger: {
					event: 'zoneChange',
					filter: { object: 'self', to: 'battlefield' }
				},
				effectSupported: true,
				text: `Backup ${n}`,
				wave4Tag: 'backup',
				wave4N: n,
				wave4CostText: String(kw.backupAbilityStartIndex ?? abilityIndex + 1),
				...baseFields
			});
			break;
		}
		case 'myriad': {
			out.push({
				abilityIndex,
				trigger: {
					event: 'attacks',
					filter: { object: 'self' }
				},
				effectSupported: true,
				text: 'Myriad',
				wave4Tag: 'myriad',
				...baseFields
			});
			break;
		}
		case 'champion': {
			const champLabel = kw.param ? `Champion ${kw.param}` : 'Champion';
			out.push({
				abilityIndex,
				trigger: {
					event: 'zoneChange',
					filter: { object: 'self', to: 'battlefield' }
				},
				effectSupported: true,
				text: champLabel,
				wave4Tag: 'champion_etb',
				...baseFields
			});
			out.push({
				abilityIndex: abilityIndex + 1000,
				trigger: {
					event: 'zoneChange',
					filter: { object: 'self', from: 'battlefield' }
				},
				effectSupported: true,
				text: `${champLabel} (return)`,
				wave4Tag: 'champion_ltb',
				...baseFields
			});
			break;
		}
		case 'recover': {
			out.push({
				abilityIndex,
				trigger: {
					event: 'zoneChange',
					fromZone: 'graveyard',
					filter: {
						object: { types: ['Creature'], owner: 'you', other: true },
						from: 'battlefield',
						to: 'graveyard'
					}
				},
				effectSupported: true,
				text: `Recover ${kw.cost ?? kw.param ?? ''}`.trim(),
				wave4Tag: 'recover',
				wave4CostText: kw.cost ?? kw.param ?? '',
				...baseFields
			});
			break;
		}
		case 'decayed': {
			out.push({
				abilityIndex,
				trigger: {
					event: 'attacks',
					filter: { object: 'self' }
				},
				effectSupported: true,
				text: 'Decayed',
				wave4Tag: 'decayed',
				...baseFields
			});
			break;
		}
		case 'renown': {
			const n = kw.n ?? 1;
			out.push({
				abilityIndex,
				trigger: {
					event: 'dealsDamage',
					filter: { object: 'self', combat: true, damageTo: 'player' }
				},
				condition: { k: 'not', of: { k: 'isRenowned' } },
				effectSupported: true,
				text: `Renown ${n}`,
				wave4Tag: 'renown',
				wave4N: n,
				...baseFields
			});
			break;
		}
		case 'mentor': {
			out.push({
				abilityIndex,
				trigger: {
					event: 'attacks',
					filter: { object: 'self' }
				},
				effectSupported: true,
				text: 'Mentor',
				wave4Tag: 'mentor',
				...baseFields
			});
			break;
		}
		case 'enlist': {
			out.push({
				abilityIndex,
				trigger: {
					event: 'attacks',
					filter: { object: 'self' }
				},
				effectSupported: true,
				text: 'Enlist',
				wave4Tag: 'enlist',
				...baseFields
			});
			break;
		}
		case 'rampage': {
			const n = kw.n ?? 1;
			out.push({
				abilityIndex,
				trigger: {
					event: 'becomesBlocked',
					filter: { object: 'self' }
				},
				effectSupported: true,
				text: `Rampage ${n}`,
				wave4Tag: 'rampage',
				wave4N: n,
				...baseFields
			});
			break;
		}
		case 'afflict': {
			const n = kw.n ?? 1;
			out.push({
				abilityIndex,
				trigger: {
					event: 'becomesBlocked',
					filter: { object: 'self' }
				},
				effectSupported: true,
				text: `Afflict ${n}`,
				wave4Tag: 'afflict',
				wave4N: n,
				...baseFields
			});
			break;
		}
		case 'ingest': {
			out.push({
				abilityIndex,
				trigger: {
					event: 'dealsDamage',
					filter: { object: 'self', combat: true, damageTo: 'player' }
				},
				effectSupported: true,
				text: 'Ingest',
				wave4Tag: 'ingest',
				...baseFields
			});
			break;
		}
		case 'melee': {
			out.push({
				abilityIndex,
				trigger: {
					event: 'attacks',
					filter: { object: 'self' }
				},
				effectSupported: true,
				text: 'Melee',
				wave4Tag: 'melee',
				...baseFields
			});
			break;
		}
		case 'graft': {
			const n = kw.n ?? 1;
			out.push({
				abilityIndex,
				trigger: {
					event: 'zoneChange',
					filter: {
						to: 'battlefield',
						object: { types: ['Creature'], other: true }
					}
				},
				condition: {
					k: 'compare',
					left: { k: 'countersOn', counter: '+1/+1', of: { k: 'self' } },
					op: '>=',
					right: { k: 'const', n: 1 }
				},
				effectSupported: true,
				text: `Graft ${n}`,
				wave4Tag: 'graft',
				wave4N: n,
				...baseFields
			});
			break;
		}
	}
	return out;
}

export function attachWave4TagToBaseRuntimeTrigger(
	rt: RuntimeTrigger,
	abilities: readonly AbilityDef[]
): Wave4RuntimeTrigger {
	const srcAb = abilities[rt.abilityIndex];
	if (srcAb?.kind === 'triggered' && srcAb.effect.some((s) => s.verb === 'solveCase')) {
		return { ...rt, effectSupported: true, wave4Tag: 'case_solve' };
	}
	if (srcAb?.kind !== 'keyword') return rt;
	const kw = srcAb.keyword;
	switch (keywordNameOf(kw)) {
		case 'mobilize':
			return { ...rt, effectSupported: true, wave4Tag: 'mobilize', wave4N: kw.n ?? 1 };
		case 'firebending':
			return { ...rt, effectSupported: true, wave4Tag: 'firebending', wave4N: kw.n ?? 1 };
		case 'backup':
			return {
				...rt,
				effectSupported: true,
				wave4Tag: 'backup',
				wave4N: kw.n ?? 1,
				wave4CostText: String(kw.backupAbilityStartIndex ?? rt.abilityIndex + 1)
			};
		case 'myriad':
			return { ...rt, effectSupported: true, wave4Tag: 'myriad' };
		case 'champion':
			return {
				...rt,
				effectSupported: true,
				wave4Tag: rt.trigger.filter.to === 'battlefield' ? 'champion_etb' : 'champion_ltb'
			};
		case 'recover':
			return {
				...rt,
				effectSupported: true,
				wave4Tag: 'recover',
				wave4CostText: kw.cost ?? kw.param ?? ''
			};
		case 'decayed':
			return { ...rt, effectSupported: true, wave4Tag: 'decayed' };
		case 'renown':
			return { ...rt, effectSupported: true, wave4Tag: 'renown', wave4N: kw.n ?? 1 };
		case 'mentor':
			return { ...rt, effectSupported: true, wave4Tag: 'mentor' };
		case 'enlist':
			return { ...rt, effectSupported: true, wave4Tag: 'enlist' };
		case 'rampage':
			return { ...rt, effectSupported: true, wave4Tag: 'rampage', wave4N: kw.n ?? 1 };
		case 'afflict':
			return { ...rt, effectSupported: true, wave4Tag: 'afflict', wave4N: kw.n ?? 1 };
		case 'ingest':
			return { ...rt, effectSupported: true, wave4Tag: 'ingest' };
		case 'melee':
			return { ...rt, effectSupported: true, wave4Tag: 'melee' };
		case 'graft':
			return { ...rt, effectSupported: true, wave4Tag: 'graft', wave4N: kw.n ?? 1 };
		default:
			return rt;
	}
}

export function buildWave4InnateTriggers(
	_abilities: AbilityDef[]
): Wave4RuntimeTrigger[] {
	return [];
}

// ============================================================================
// 8. Resolution of Wave 4 Triggered & Activated Stack Items
// ============================================================================

const WAVE4_CHAMPION_PROMPT = 'wave4_champion_choice';
const WAVE4_RECOVER_PROMPT = 'wave4_recover_choice';
const WAVE4_ENLIST_PROMPT = 'wave4_enlist_choice';
const WAVE4_GRAFT_PROMPT = 'wave4_graft_choice';

function applyTemporaryPtBoost(
	state: GameState,
	perm: CardInstance,
	powerMod: number,
	toughnessMod: number
): void {
	if (powerMod === 0 && toughnessMod === 0) return;
	perm.tempPowerMod = (perm.tempPowerMod ?? 0) + powerMod;
	perm.tempToughnessMod = (perm.tempToughnessMod ?? 0) + toughnessMod;
	noteLayerInputsChanged(state);
}

export function resolveWave4StackItem(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState,
	matchesFilterFn: (obj: CardInstance, filter: ObjectFilter, ctx: FilterContext) => boolean
): 'none' | 'paused' | 'done' {
	const host = requireHost();
	if (item.wave4Tag === 'resolved_done') return 'done';

	if (item.kind === 'activated' && item.abilityId) {
		const classMatch = /^class_level_(\d+)$/.exec(item.abilityId);
		if (classMatch) {
			const targetLevel = Number.parseInt(classMatch[1], 10);
			const found = findPermanentAcrossPlayers(state, item.sourceInstanceId);
			if (
				found &&
				(item.sourceObjectVersion === undefined ||
					found.inst.objectVersion === item.sourceObjectVersion)
			) {
				found.inst.classLevel = targetLevel;
				noteLayerInputsChanged(state);
				host.addLog(
					state,
					'rule',
					`${found.inst.card.name} gained Class level ${targetLevel} (CR 717.2a).`,
					controller.playerId
				);
				host.emitEvent(state, {
					kind: 'ClassLevelGained',
					objectId: found.inst.instanceId,
					object: found.inst,
					controllerId: controller.playerId,
					classLevel: targetLevel
				});
				host.flushTriggers(state);
			}
			return 'done';
		}

		if (
			item.abilityId.startsWith('embalm_') ||
			item.abilityId.startsWith('eternalize_') ||
			item.abilityId.startsWith('encore_')
		) {
			const sourceTemplate = findCardAnywhereById(state, item.sourceInstanceId) ?? {
				instanceId: item.sourceInstanceId,
				card: item.card,
				ownerId: controller.playerId,
				controllerId: controller.playerId,
				zone: 'exile' as const,
				tapped: false,
				summoningSick: false,
				damageMarked: 0,
				deathtouchDamageMarked: false,
				counters: {} as CardInstance['counters'],
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
			if (item.abilityId.startsWith('embalm_')) {
				host.copyPermanentAsToken(
					state,
					controller,
					sourceTemplate,
					item.card.name,
					false,
					undefined,
					{
						setColors: ['W'],
						addSubtypes: ['Zombie'],
						noManaCost: true
					}
				);
				return 'done';
			}
			if (item.abilityId.startsWith('eternalize_')) {
				host.copyPermanentAsToken(
					state,
					controller,
					sourceTemplate,
					item.card.name,
					false,
					{ power: 4, toughness: 4 },
					{
						setColors: ['B'],
						addSubtypes: ['Zombie'],
						noManaCost: true
					}
				);
				return 'done';
			}
			if (item.abilityId.startsWith('encore_')) {
				const opponents = state.players.filter(
					(p) => !p.lost && p.playerId !== controller.playerId
				);
				for (const opp of opponents) {
					const tok = host.copyPermanentAsToken(
						state,
						controller,
						sourceTemplate,
						item.card.name,
						false,
						undefined,
						{ addKeywords: ['haste'] }
					);
					if (tok.zone === 'battlefield') {
						tok.encoreMustAttackPlayerId = opp.playerId;
						(state.delayedTriggers ??= []).push({
							id: host.uid('dtrig', state),
							controllerId: controller.playerId,
							sourceInstanceId: tok.instanceId,
							sourceCard: tok.card,
							triggerPhase: 'end_step',
							targetInstanceId: tok.instanceId,
							targetObjectVersion: tok.objectVersion,
							delayedEffect: {
								kind: 'sacrifice',
								targetInstanceId: tok.instanceId,
								targetObjectVersion: tok.objectVersion
							},
							description: `Sacrifice ${tok.card.name} (Encore, CR 702.141a).`
						});
					}
				}
				noteLayerInputsChanged(state);
				return 'done';
			}
		}
	}

	if (item.kind === 'triggered' && item.wave4Tag === 'case_solve') {
		const found = findPermanentAcrossPlayers(state, item.sourceInstanceId);
		if (
			found &&
			!found.inst.isSolved &&
			(item.sourceObjectVersion === undefined ||
				found.inst.objectVersion === item.sourceObjectVersion)
		) {
			found.inst.isSolved = true;
			noteLayerInputsChanged(state);
			host.addLog(
				state,
				'trigger',
				`${found.inst.card.name} became solved (CR 720.3a)!`,
				controller.playerId
			);
			host.emitEvent(state, {
				kind: 'CaseSolved',
				objectId: found.inst.instanceId,
				object: found.inst,
				controllerId: controller.playerId
			});
			host.flushTriggers(state);
		}
		return 'done';
	}

	if (item.kind !== 'triggered' || !item.wave4Tag) return 'none';

	const resolveDynamicKeywordN = (kwName: 'mobilize' | 'firebending', fallbackN: number): number => {
		const srcPerm = findPermanentAcrossPlayers(state, item.sourceInstanceId)?.inst;
		const faceOpts = srcPerm ? instanceFaceOptions(srcPerm, 'battlefield') : { zone: 'battlefield' as const, faceIndex: item.faceIndex ?? 0 };
		const innateKw = activeAbilityDefs(item.card, faceOpts).find(
			(a): a is Extract<AbilityDef, { kind: 'keyword' }> =>
				a.kind === 'keyword' && a.keyword.name.toLowerCase() === kwName && Boolean(a.keyword.dynamicAmount)
		);
		let dynAmt = innateKw?.keyword.dynamicAmount;
		if (!dynAmt && srcPerm) {
			for (const p of state.players) {
				for (const att of p.battlefield) {
					if (att.phasedOut || att.attachedToId !== srcPerm.instanceId) continue;
					const attDefs = activeAbilityDefs(effectiveCardForObject(att), instanceFaceOptions(att, 'battlefield'));
					for (const a of attDefs) {
						if (
							a.kind === 'static' &&
							a.static.k === 'continuous' &&
							a.static.affected === 'attachedTo' &&
							a.static.mod.k === 'grantAbility' &&
							a.static.mod.ability.kind === 'keyword' &&
							a.static.mod.ability.keyword.name.toLowerCase() === kwName &&
							a.static.mod.ability.keyword.dynamicAmount
						) {
							dynAmt = a.static.mod.ability.keyword.dynamicAmount;
							break;
						}
					}
					if (dynAmt) break;
				}
				if (dynAmt) break;
			}
		}
		if (dynAmt) {
			return Math.max(
				0,
				evaluateAmount(dynAmt, { state, controllerId: controller.playerId, source: srcPerm })
			);
		}
		return Math.max(1, fallbackN);
	};

	switch (item.wave4Tag) {
		case 'mobilize': {
			const n = resolveDynamicKeywordN('mobilize', item.wave4N ?? 1);
			if (n <= 0) return 'done';
			const tokens = host.createTokens(
				state,
				controller,
				{
					name: 'Warrior',
					power: 1,
					toughness: 1,
					colors: ['R'],
					typeLine: 'Token Creature — Warrior',
					keywords: []
				},
				n,
				item.card.name
			);
			const defId =
				item.defendingPlayerId ??
				state.combat.attackers.find((a) => a.controllerId === controller.playerId)?.defenderPlayerId ??
				state.players.find((p) => !p.lost && p.playerId !== controller.playerId)?.playerId;
			for (const tok of tokens) {
				if (tok.zone !== 'battlefield') continue;
				tok.tapped = true;
				if (state.combat.active && defId) {
					if (!state.combat.attackers.some((a) => a.attackerInstanceId === tok.instanceId)) {
						state.combat.attackers.push({
							attackerInstanceId: tok.instanceId,
							controllerId: controller.playerId,
							defenderPlayerId: defId,
							defenderPlaneswalkerId: null,
							blockerInstanceIds: []
						});
					}
				}
				(state.delayedTriggers ??= []).push({
					id: host.uid('dtrig', state),
					controllerId: controller.playerId,
					sourceInstanceId: tok.instanceId,
					sourceCard: tok.card,
					triggerPhase: 'end_step',
					targetInstanceId: tok.instanceId,
					targetObjectVersion: tok.objectVersion,
					delayedEffect: {
						kind: 'sacrifice',
						targetInstanceId: tok.instanceId,
						targetObjectVersion: tok.objectVersion
					},
					description: `Sacrifice ${tok.card.name} (Mobilize, CR 702.181a).`
				});
			}
			noteLayerInputsChanged(state);
			return 'done';
		}

		case 'firebending': {
			const n = resolveDynamicKeywordN('firebending', item.wave4N ?? 1);
			if (n <= 0) return 'done';
			controller.manaPool.R += n;
			controller.firebendingRedMana = (controller.firebendingRedMana ?? 0) + n;
			host.addLog(
				state,
				'trigger',
				`Firebending ${n}: ${controller.username} added ${'{R}'.repeat(n)} (persists until end of combat, CR 702.189a).`,
				controller.playerId
			);
			return 'done';
		}

		case 'backup': {
			const n = Math.max(1, item.wave4N ?? 1);
			const tgt = item.targets[0];
			if (!tgt || tgt.kind !== 'permanent') return 'done';
			const found = findPermanentAcrossPlayers(state, tgt.id);
			if (!found) return 'done';
			const expectedVer = item.targetObjectVersions?.[tgt.id];
			if (expectedVer !== undefined && found.inst.objectVersion !== expectedVer) return 'done';
			host.addCountersToPermanent(state, found.inst, '+1/+1', n);
			const isSelf =
				found.inst.instanceId === item.sourceInstanceId &&
				(item.sourceObjectVersion === undefined ||
					found.inst.objectVersion === item.sourceObjectVersion);
			if (!isSelf) {
				const startIdx = Number.parseInt(item.wave4CostText ?? '1', 10);
				if (Number.isFinite(startIdx) && startIdx >= 0) {
					(state.timedContinuousEffects ??= []).push({
						timestamp: allocateTimestamp(state),
						sourceName: item.card.name,
						controllerId: controller.playerId,
						affected: [
							{
								instanceId: found.inst.instanceId,
								objectVersion: found.inst.objectVersion ?? 1
							}
						],
						expires: 'endOfTurn',
						backupGrant: {
							sourceCard: item.card,
							faceIndex: item.faceIndex ?? 0,
							startAbilityIndex: startIdx
						}
					});
					noteLayerInputsChanged(state);
				}
			}
			return 'done';
		}

		case 'myriad': {
			const defId =
				item.defendingPlayerId ??
				state.combat.attackers.find((a) => a.attackerInstanceId === item.sourceInstanceId)
					?.defenderPlayerId;
			const otherOpponents = state.players.filter(
				(p) => !p.lost && p.playerId !== controller.playerId && p.playerId !== defId
			);
			if (otherOpponents.length === 0) return 'done';
			const foundSrc = findPermanentAcrossPlayers(state, item.sourceInstanceId);
			const srcTemplate = foundSrc?.inst ?? findCardAnywhereById(state, item.sourceInstanceId);
			if (!srcTemplate) return 'done';
			for (const opp of otherOpponents) {
				const tok = host.copyPermanentAsToken(
					state,
					controller,
					srcTemplate,
					item.card.name,
					false,
					undefined,
					undefined,
					{ tapped: true }
				);
				if (tok.zone === 'battlefield') {
					tok.tapped = true;
					if (state.combat.active) {
						state.combat.attackers.push({
							attackerInstanceId: tok.instanceId,
							controllerId: controller.playerId,
							defenderPlayerId: opp.playerId,
							defenderPlaneswalkerId: null,
							blockerInstanceIds: []
						});
					}
					(state.delayedTriggers ??= []).push({
						id: host.uid('dtrig', state),
						controllerId: controller.playerId,
						sourceInstanceId: tok.instanceId,
						sourceCard: tok.card,
						triggerPhase: 'end_combat',
						targetInstanceId: tok.instanceId,
						targetObjectVersion: tok.objectVersion,
						delayedEffect: {
							kind: 'exile',
							targetInstanceId: tok.instanceId,
							targetObjectVersion: tok.objectVersion
						},
						description: `Exile ${tok.card.name} at end of combat (Myriad, CR 702.116a).`
					});
				}
			}
			noteLayerInputsChanged(state);
			return 'done';
		}

		case 'champion_etb': {
			const srcFound = findPermanentAcrossPlayers(state, item.sourceInstanceId);
			const srcPerm =
				srcFound &&
				(item.sourceObjectVersion === undefined ||
					srcFound.inst.objectVersion === item.sourceObjectVersion)
					? srcFound.inst
					: null;
			const abilities = activeAbilityDefs(item.card, { faceIndex: item.faceIndex ?? 0 });
			const champKw = abilities.find(
				(a) => a.kind === 'keyword' && keywordNameOf(a.keyword) === 'champion'
			);
			const filter: ObjectFilter =
				(champKw?.kind === 'keyword' ? champKw.keyword.championFilter : undefined) ?? {
					types: ['Creature']
				};
			const ctx: FilterContext = {
				state,
				controllerId: controller.playerId,
				source: srcPerm ?? undefined,
				stackItem: item
			};
			const cands = controller.battlefield.filter((p) => {
				if (p.phasedOut) return false;
				if (p.instanceId === item.sourceInstanceId) return false;
				return matchesFilterFn(p, filter, ctx);
			});
			if (cands.length === 0) {
				if (srcPerm) {
					moveObject(state, srcPerm, 'graveyard', {
						from: { player: controller, zone: 'battlefield' }
					});
					host.addLog(
						state,
						'trigger',
						`${srcPerm.card.name} was sacrificed (no legal permanent to champion, CR 702.72a).`,
						controller.playerId
					);
					host.flushTriggers(state);
				}
				return 'done';
			}
			if (controller.isBot) {
				const pick = [...cands].sort(
					(a, b) =>
						(a.isToken ? 0 : 1) - (b.isToken ? 0 : 1) ||
						effectiveManaValue(a.card, instanceFaceOptions(a)) -
							effectiveManaValue(b.card, instanceFaceOptions(b))
				)[0];
				applyChampionChoice(state, controller, item, srcPerm, pick.instanceId);
				return 'done';
			}
			enqueueChoicePrompt(state, {
				id: host.uid('prm', state),
				playerId: controller.playerId,
				kind: 'chooseObjects',
				purpose: 'trigger_may',
				title: `Champion — ${item.card.name}`,
				description: `Choose another matching permanent you control to exile for ${item.card.name}, or choose 0 to sacrifice ${item.card.name} (CR 702.72a).`,
				candidateInstanceIds: cands.map((c) => c.instanceId),
				countRequired: 0,
				choice: {
					kind: 'chooseObjects',
					candidates: cands.map((c) => c.instanceId),
					min: 0,
					max: 1,
					zone: 'battlefield',
					reason: `Exile a permanent for ${item.card.name}'s Champion ability?`
				},
				continuation: {
					kind: 'handler',
					name: WAVE4_CHAMPION_PROMPT,
					data: { stackItemId: item.id }
				}
			});
			return 'paused';
		}

		case 'champion_ltb': {
			const linkedIds = findLinkedExiledCardsForChampion(state, item.sourceInstanceId);
			for (const exiled of linkedIds) {
				const owner = state.players.find((p) => p.playerId === exiled.ownerId);
				const holder = state.players.find((p) =>
					p.exile.some((c) => c.instanceId === exiled.instanceId)
				);
				if (!owner || !holder) continue;
				if (exiled.isToken) continue;
				delete exiled.exiledBy;
				moveObject(state, exiled, 'battlefield', {
					from: { player: holder, zone: 'exile' },
					toPlayer: owner
				});
				host.addLog(
					state,
					'trigger',
					`${exiled.card.name} returned to the battlefield from exile (Champion, CR 702.72a).`,
					owner.playerId
				);
			}
			host.flushTriggers(state);
			return 'done';
		}

		case 'recover': {
			const gyCard = controller.graveyard.find(
				(c) =>
					c.instanceId === item.sourceInstanceId &&
					(item.sourceObjectVersion === undefined || c.objectVersion === item.sourceObjectVersion)
			);
			if (!gyCard) return 'done';
			const costText = item.wave4CostText ?? '{0}';
			const manaReq = parseManaCost(costText);
			const canPay = host.canPayOrAutoTap(controller, manaReq, state);
			if (!canPay) {
				moveObject(state, gyCard, 'exile', {
					from: { player: controller, zone: 'graveyard' },
					toPlayer: controller
				});
				host.addLog(
					state,
					'trigger',
					`${controller.username} could not pay Recover ${costText}; ${gyCard.card.name} was exiled (CR 702.59a).`,
					controller.playerId
				);
				host.flushTriggers(state);
				return 'done';
			}
			if (controller.isBot) {
				host.payManaWithAutoTap(controller, manaReq, state);
				moveObject(state, gyCard, 'hand', {
					from: { player: controller, zone: 'graveyard' },
					toPlayer: controller
				});
				host.addLog(
					state,
					'trigger',
					`${controller.username} paid Recover ${costText} and returned ${gyCard.card.name} to hand (CR 702.59a).`,
					controller.playerId
				);
				host.flushTriggers(state);
				return 'done';
			}
			enqueueChoicePrompt(state, {
				id: host.uid('prm', state),
				playerId: controller.playerId,
				kind: 'yesNo',
				purpose: 'trigger_may',
				title: `Recover — ${gyCard.card.name}`,
				description: `Pay ${costText} to return ${gyCard.card.name} to your hand? If you don't, exile ${gyCard.card.name} (CR 702.59a).`,
				choice: {
					kind: 'yesNo',
					question: `Pay Recover ${costText} for ${gyCard.card.name}?`
				},
				continuation: {
					kind: 'handler',
					name: WAVE4_RECOVER_PROMPT,
					data: { stackItemId: item.id, costText }
				}
			});
			return 'paused';
		}

		case 'decayed': {
			const found = findPermanentAcrossPlayers(state, item.sourceInstanceId);
			if (
				found &&
				(item.sourceObjectVersion === undefined ||
					found.inst.objectVersion === item.sourceObjectVersion)
			) {
				const dt: DelayedTrigger = {
					id: host.uid('dtrig', state),
					controllerId: controller.playerId,
					sourceInstanceId: found.inst.instanceId,
					sourceCard: found.inst.card,
					triggerPhase: 'end_combat',
					targetInstanceId: found.inst.instanceId,
					targetObjectVersion: found.inst.objectVersion,
					delayedEffect: {
						kind: 'sacrifice',
						targetInstanceId: found.inst.instanceId,
						targetObjectVersion: found.inst.objectVersion
					},
					description: `Sacrifice ${found.inst.card.name} at end of combat (Decayed, CR 702.147a).`
				};
				(state.delayedTriggers ??= []).push(dt);
			}
			return 'done';
		}

		case 'renown': {
			const n = Math.max(1, item.wave4N ?? 1);
			const found = findPermanentAcrossPlayers(state, item.sourceInstanceId);
			if (
				found &&
				!found.inst.isRenowned &&
				(item.sourceObjectVersion === undefined ||
					found.inst.objectVersion === item.sourceObjectVersion)
			) {
				host.addCountersToPermanent(state, found.inst, '+1/+1', n);
				found.inst.isRenowned = true;
				noteLayerInputsChanged(state);
				host.addLog(
					state,
					'trigger',
					`${found.inst.card.name} became renowned (${n} +1/+1 counter(s), CR 702.112a)!`,
					controller.playerId
				);
				host.emitEvent(state, {
					kind: 'BecameRenowned',
					objectId: found.inst.instanceId,
					object: found.inst,
					controllerId: controller.playerId,
					amount: n
				});
				host.flushTriggers(state);
			}
			return 'done';
		}

		case 'mentor': {
			const tgt = item.targets[0];
			if (!tgt || tgt.kind !== 'permanent') return 'done';
			const foundTgt = findPermanentAcrossPlayers(state, tgt.id);
			if (!foundTgt) return 'done';
			const expectedVer = item.targetObjectVersions?.[tgt.id];
			if (expectedVer !== undefined && foundTgt.inst.objectVersion !== expectedVer) return 'done';
			const srcFound = findPermanentAcrossPlayers(state, item.sourceInstanceId);
			const ctx: FilterContext = {
				state,
				controllerId: controller.playerId,
				source: srcFound?.inst,
				stackItem: item
			};
			if (
				matchesFilterFn(
					foundTgt.inst,
					{
						zone: 'battlefield',
						types: ['Creature'],
						attacking: true,
						other: true,
						powerLessThanSource: true
					},
					ctx
				)
			) {
				host.addCountersToPermanent(state, foundTgt.inst, '+1/+1', 1);
			}
			return 'done';
		}

		case 'enlist': {
			const srcFound = findPermanentAcrossPlayers(state, item.sourceInstanceId);
			const srcPerm =
				srcFound &&
				(item.sourceObjectVersion === undefined ||
					srcFound.inst.objectVersion === item.sourceObjectVersion)
					? srcFound.inst
					: null;
			const ctx: FilterContext = {
				state,
				controllerId: controller.playerId,
				source: srcPerm ?? undefined,
				stackItem: item
			};
			const cands = controller.battlefield.filter(
				(p) =>
					p.instanceId !== item.sourceInstanceId &&
					matchesFilterFn(
						p,
						{
							zone: 'battlefield',
							types: ['Creature'],
							controller: 'you',
							untappedNonattackingSummoningReady: true
						},
						ctx
					)
			);
			if (cands.length === 0) return 'done';
			if (controller.isBot) {
				const best = [...cands].sort(
					(a, b) => evaluatePermanent(state, b).power - evaluatePermanent(state, a).power
				)[0];
				if (best && evaluatePermanent(state, best).power > 0) {
					applyEnlistChoice(state, controller, item, srcPerm, best.instanceId);
				}
				return 'done';
			}
			enqueueChoicePrompt(state, {
				id: host.uid('prm', state),
				playerId: controller.playerId,
				kind: 'chooseObjects',
				purpose: 'trigger_may',
				title: `Enlist — ${item.card.name}`,
				description: `You may tap an untapped nonattacking creature you control without summoning sickness to give ${item.card.name} +X/+0 until end of turn (CR 702.154a).`,
				candidateInstanceIds: cands.map((c) => c.instanceId),
				countRequired: 0,
				choice: {
					kind: 'chooseObjects',
					candidates: cands.map((c) => c.instanceId),
					min: 0,
					max: 1,
					zone: 'battlefield',
					reason: `Tap a creature to Enlist with ${item.card.name}?`
				},
				continuation: {
					kind: 'handler',
					name: WAVE4_ENLIST_PROMPT,
					data: { stackItemId: item.id }
				}
			});
			return 'paused';
		}

		case 'rampage': {
			const n = Math.max(1, item.wave4N ?? 1);
			const srcFound = findPermanentAcrossPlayers(state, item.sourceInstanceId);
			if (
				!srcFound ||
				(item.sourceObjectVersion !== undefined &&
					srcFound.inst.objectVersion !== item.sourceObjectVersion)
			) {
				return 'done';
			}
			const atkEntry = state.combat.attackers.find(
				(a) => a.attackerInstanceId === srcFound.inst.instanceId
			);
			const blockerCount = atkEntry?.blockerInstanceIds.length ?? item.eventAmount ?? 0;
			const beyondFirst = Math.max(0, blockerCount - 1);
			if (beyondFirst > 0) {
				const boost = beyondFirst * n;
				applyTemporaryPtBoost(state, srcFound.inst, boost, boost);
			}
			return 'done';
		}

		case 'afflict': {
			const n = Math.max(1, item.wave4N ?? 1);
			const defId =
				item.defendingPlayerId ??
				state.combat.attackers.find((a) => a.attackerInstanceId === item.sourceInstanceId)
					?.defenderPlayerId ??
				state.players.find((p) => !p.lost && p.playerId !== controller.playerId)?.playerId;
			const defPlayer = state.players.find((p) => p.playerId === defId && !p.lost);
			if (defPlayer && !playerLifeTotalCantChange(state, defPlayer)) {
				defPlayer.life -= n;
				recordPlayerLifeLossWave4(defPlayer, n);
				host.addLog(
					state,
					'life',
					`Afflict ${n}: ${defPlayer.username} lost ${n} life (CR 702.130a).`,
					controller.playerId
				);
			}
			return 'done';
		}

		case 'ingest': {
			const damagedId = item.eventPlayerId ?? item.defendingPlayerId;
			const damagedPlayer = state.players.find((p) => p.playerId === damagedId && !p.lost);
			if (damagedPlayer && damagedPlayer.library.length > 0) {
				const topCard = damagedPlayer.library[0];
				const owner = state.players.find((p) => p.playerId === topCard.ownerId) ?? damagedPlayer;
				moveObject(state, topCard, 'exile', {
					from: { player: damagedPlayer, zone: 'library' },
					toPlayer: owner
				});
				host.addLog(
					state,
					'trigger',
					`Ingest: ${damagedPlayer.username} exiled ${topCard.card.name} from the top of their library (CR 702.115a).`,
					controller.playerId
				);
				host.flushTriggers(state);
			}
			return 'done';
		}

		case 'melee': {
			const srcFound = findPermanentAcrossPlayers(state, item.sourceInstanceId);
			if (
				!srcFound ||
				(item.sourceObjectVersion !== undefined &&
					srcFound.inst.objectVersion !== item.sourceObjectVersion)
			) {
				return 'done';
			}
			const attackedOpponents = new Set<string>();
			for (const atk of state.combat.attackers) {
				if (atk.controllerId !== controller.playerId) continue;
				if (atk.defenderPlayerId && atk.defenderPlayerId !== controller.playerId) {
					attackedOpponents.add(atk.defenderPlayerId);
				}
			}
			const x = attackedOpponents.size;
			if (x > 0) {
				applyTemporaryPtBoost(state, srcFound.inst, x, x);
			}
			return 'done';
		}

		case 'graft': {
			// CR 702.58a, CR 603.4, CR 122.5: Intervening-if re-check + both permanents must be on battlefield.
			const srcFound = findPermanentAcrossPlayers(state, item.sourceInstanceId);
			const destFound = item.eventObjectId
				? findPermanentAcrossPlayers(state, item.eventObjectId)
				: null;
			if (
				!srcFound ||
				(item.sourceObjectVersion !== undefined &&
					srcFound.inst.objectVersion !== item.sourceObjectVersion) ||
				(srcFound.inst.counters['+1/+1'] ?? 0) < 1 ||
				!destFound ||
				(item.eventObjectVersion !== undefined &&
					destFound.inst.objectVersion !== item.eventObjectVersion) ||
				!evaluatePermanent(state, destFound.inst).isCreature
			) {
				return 'done';
			}
			if (controller.isBot) {
				if (destFound.inst.controllerId === controller.playerId) {
					srcFound.inst.counters['+1/+1'] = (srcFound.inst.counters['+1/+1'] ?? 0) - 1;
					noteLayerInputsChanged(state);
					host.addCountersToPermanent(state, destFound.inst, '+1/+1', 1);
					host.addLog(
						state,
						'trigger',
						`Graft: ${controller.username} moved a +1/+1 counter from ${srcFound.inst.card.name} onto ${destFound.inst.card.name} (CR 702.58a).`,
						controller.playerId
					);
					host.flushTriggers(state);
				}
				return 'done';
			}
			enqueueChoicePrompt(state, {
				id: host.uid('prm', state),
				playerId: controller.playerId,
				kind: 'yesNo',
				purpose: 'generic',
				title: `Graft — ${srcFound.inst.card.name}`,
				description: `Move a +1/+1 counter from ${srcFound.inst.card.name} onto ${destFound.inst.card.name}? (CR 702.58a)`,
				choice: {
					kind: 'yesNo',
					question: `Move a +1/+1 counter from ${srcFound.inst.card.name} onto ${destFound.inst.card.name}?`
				},
				continuation: {
					kind: 'handler',
					name: WAVE4_GRAFT_PROMPT,
					data: { stackItemId: item.id }
				}
			});
			return 'paused';
		}
	}

	return 'none';
}

function findCardAnywhereById(state: GameState, instanceId: string): CardInstance | null {
	for (const p of state.players) {
		for (const zone of [p.battlefield, p.exile, p.graveyard, p.hand, p.command, p.library]) {
			const c = zone.find((x) => x.instanceId === instanceId);
			if (c) return c;
		}
	}
	return null;
}

function findLinkedExiledCardsForChampion(
	state: GameState,
	championInstanceId: string
): CardInstance[] {
	const out: CardInstance[] = [];
	for (const p of state.players) {
		for (const c of p.exile) {
			if (c.exiledBy?.sourceInstanceId === championInstanceId) {
				out.push(c);
			}
		}
	}
	return out;
}

function applyChampionChoice(
	state: GameState,
	controller: PlayerGameState,
	item: StackItem,
	srcPerm: CardInstance | null,
	chosenId: string | undefined
): void {
	const host = requireHost();
	if (chosenId) {
		const targetPerm = controller.battlefield.find(
			(p) => p.instanceId === chosenId && !p.phasedOut
		);
		if (targetPerm) {
			const owner = state.players.find((p) => p.playerId === targetPerm.ownerId) ?? controller;
			moveObject(state, targetPerm, 'exile', {
				from: { player: controller, zone: 'battlefield' },
				toPlayer: owner
			});
			if (targetPerm.zone === 'exile') {
				targetPerm.exiledBy = {
					sourceInstanceId: item.sourceInstanceId,
					sourceObjectVersion: item.sourceObjectVersion ?? 1
				};
			}
			host.addLog(
				state,
				'trigger',
				`${controller.username} championed ${targetPerm.card.name} with ${item.card.name} (CR 702.72a).`,
				controller.playerId
			);
			host.flushTriggers(state);
			return;
		}
	}
	if (srcPerm && srcPerm.zone === 'battlefield') {
		moveObject(state, srcPerm, 'graveyard', {
			from: { player: controller, zone: 'battlefield' }
		});
		host.addLog(
			state,
			'trigger',
			`${srcPerm.card.name} was sacrificed (declined Champion, CR 702.72a).`,
			controller.playerId
		);
		host.flushTriggers(state);
	}
}

function applyEnlistChoice(
	state: GameState,
	controller: PlayerGameState,
	item: StackItem,
	srcPerm: CardInstance | null,
	chosenId: string | undefined
): void {
	const host = requireHost();
	if (!chosenId) return;
	const helper = controller.battlefield.find((p) => p.instanceId === chosenId && !p.phasedOut);
	if (!helper || helper.tapped) return;
	const pwr = Math.max(0, evaluatePermanent(state, helper).power);
	host.tapPermanent(state, helper);
	if (srcPerm && srcPerm.zone === 'battlefield' && pwr > 0) {
		applyTemporaryPtBoost(state, srcPerm, pwr, 0);
	}
	host.addLog(
		state,
		'trigger',
		`Enlist: ${controller.username} tapped ${helper.card.name} to give ${item.card.name} +${pwr}/+0 until end of turn (CR 702.154a).`,
		controller.playerId
	);
	host.flushTriggers(state);
}

function findResumingWave4StackItem(state: GameState, stackItemId: string): StackItem | null {
	return state.stack.find((s) => s.id === stackItemId) ?? null;
}

registerPromptHandler(WAVE4_CHAMPION_PROMPT, (state, prompt, answer) => {
	const host = requireHost();
	const data = (prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined) as
		| { stackItemId: string }
		| undefined;
	if (!data) return;
	const item = findResumingWave4StackItem(state, data.stackItemId);
	if (!item) return;
	const controller = state.players.find((p) => p.playerId === item.controllerId);
	if (!controller) return;
	const chosenId = answer.kind === 'chooseObjects' ? answer.objectIds[0] : undefined;
	const srcFound = findPermanentAcrossPlayers(state, item.sourceInstanceId);
	const srcPerm =
		srcFound &&
		(item.sourceObjectVersion === undefined ||
			srcFound.inst.objectVersion === item.sourceObjectVersion)
			? srcFound.inst
			: null;
	applyChampionChoice(state, controller, item, srcPerm, chosenId);
	item.wave4Tag = 'resolved_done';
	host.resumeStackItem(state, item);
});

registerPromptHandler(WAVE4_RECOVER_PROMPT, (state, prompt, answer) => {
	const host = requireHost();
	const data = (prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined) as
		| { stackItemId: string; costText: string }
		| undefined;
	if (!data) return;
	const item = findResumingWave4StackItem(state, data.stackItemId);
	if (!item) return;
	const controller = state.players.find((p) => p.playerId === item.controllerId);
	if (!controller) return;
	const accepted = answer.kind === 'yesNo' && answer.yes;
	const gyCard = controller.graveyard.find(
		(c) =>
			c.instanceId === item.sourceInstanceId &&
			(item.sourceObjectVersion === undefined || c.objectVersion === item.sourceObjectVersion)
	);
	if (gyCard) {
		const manaReq = parseManaCost(data.costText || '{0}');
		if (accepted && host.canPayOrAutoTap(controller, manaReq, state)) {
			host.payManaWithAutoTap(controller, manaReq, state);
			moveObject(state, gyCard, 'hand', {
				from: { player: controller, zone: 'graveyard' },
				toPlayer: controller
			});
			host.addLog(
				state,
				'trigger',
				`${controller.username} paid Recover ${data.costText} and returned ${gyCard.card.name} to hand (CR 702.59a).`,
				controller.playerId
			);
		} else {
			moveObject(state, gyCard, 'exile', {
				from: { player: controller, zone: 'graveyard' },
				toPlayer: controller
			});
			host.addLog(
				state,
				'trigger',
				`${gyCard.card.name} was exiled (declined Recover, CR 702.59a).`,
				controller.playerId
			);
		}
		host.flushTriggers(state);
	}
	item.wave4Tag = 'resolved_done';
	host.resumeStackItem(state, item);
});

registerPromptHandler(WAVE4_ENLIST_PROMPT, (state, prompt, answer) => {
	const host = requireHost();
	const data = (prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined) as
		| { stackItemId: string }
		| undefined;
	if (!data) return;
	const item = findResumingWave4StackItem(state, data.stackItemId);
	if (!item) return;
	const controller = state.players.find((p) => p.playerId === item.controllerId);
	if (!controller) return;
	const chosenId = answer.kind === 'chooseObjects' ? answer.objectIds[0] : undefined;
	const srcFound = findPermanentAcrossPlayers(state, item.sourceInstanceId);
	const srcPerm =
		srcFound &&
		(item.sourceObjectVersion === undefined ||
			srcFound.inst.objectVersion === item.sourceObjectVersion)
			? srcFound.inst
			: null;
	applyEnlistChoice(state, controller, item, srcPerm, chosenId);
	item.wave4Tag = 'resolved_done';
	host.resumeStackItem(state, item);
});

registerPromptHandler(WAVE4_GRAFT_PROMPT, (state, prompt, answer) => {
	const host = requireHost();
	const data = (prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined) as
		| { stackItemId: string }
		| undefined;
	if (!data) return;
	const item = findResumingWave4StackItem(state, data.stackItemId);
	if (!item) return;
	const controller = state.players.find((p) => p.playerId === item.controllerId);
	if (!controller) return;
	if (answer.kind === 'yesNo' && answer.yes) {
		const srcFound = findPermanentAcrossPlayers(state, item.sourceInstanceId);
		const destFound = item.eventObjectId
			? findPermanentAcrossPlayers(state, item.eventObjectId)
			: null;
		if (
			srcFound &&
			(item.sourceObjectVersion === undefined ||
				srcFound.inst.objectVersion === item.sourceObjectVersion) &&
			(srcFound.inst.counters['+1/+1'] ?? 0) >= 1 &&
			destFound &&
			(item.eventObjectVersion === undefined ||
				destFound.inst.objectVersion === item.eventObjectVersion) &&
			evaluatePermanent(state, destFound.inst).isCreature
		) {
			srcFound.inst.counters['+1/+1'] = (srcFound.inst.counters['+1/+1'] ?? 0) - 1;
			noteLayerInputsChanged(state);
			host.addCountersToPermanent(state, destFound.inst, '+1/+1', 1);
			host.addLog(
				state,
				'trigger',
				`Graft: ${controller.username} moved a +1/+1 counter from ${srcFound.inst.card.name} onto ${destFound.inst.card.name} (CR 702.58a).`,
				controller.playerId
			);
			host.flushTriggers(state);
		}
	}
	item.wave4Tag = 'resolved_done';
	host.resumeStackItem(state, item);
});
