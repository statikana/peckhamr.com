/**
 * Runtime helpers and resolution state machine for Wave 3 (Track P9) CR 702 keywords:
 * - Echo (CR 702.30)
 * - Madness (CR 702.35, CR 400.7k)
 * - Cascade (CR 702.85)
 * - Rebound (CR 702.88)
 * - Undying (CR 702.93) + CR 704.8 LKI
 * - Persist (CR 702.79) + CR 704.8 LKI
 * - Modular (CR 702.43) + CR 704.8 LKI
 * - Soulshift (CR 702.46)
 * - Improvise (CR 702.126, CR 118.10)
 * - Dash (CR 702.109)
 * - Ninjutsu & Commander ninjutsu (CR 702.49, CR 508.4, CR 903.8)
 * - Scavenge (CR 702.97)
 * - Toxic (CR 702.164)
 * - Bloodthirst (CR 702.54)
 * - Flanking (CR 702.25)
 * - Fabricate (CR 702.123)
 * - Unleash (CR 702.98)
 * - Extort (CR 702.101)
 * - Riot (CR 702.136)
 *
 * Pure IR and GameState metadata only — zero card-name comparisons and zero runtime rules-text reads.
 */
import { compileCard } from '../compiler/index.ts';
import type { CostDef, ModalDef, TargetSpec, TokenSpec } from '../ir.ts';
import { parseManaCost, type ManaCostRequirement } from '../oracle.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import type {
	CardInstance,
	ChoiceAnswer,
	CostPayment,
	CounterType,
	DelayedTrigger,
	GameState,
	ManaColor,
	PendingPrompt,
	PlayerGameState,
	ScryfallCard,
	SerializedPlannedCost,
	SpellModifications,
	StackItem,
	TargetRef
} from '../types.ts';
import { buildCostChoiceRequest, enqueueChoicePrompt, registerPromptHandler } from './choices.ts';
import {
	chooseCostPayment,
	effectiveSpellManaCost,
	keywordAltCost,
	payTapAndManaCostParts,
	planCosts,
	serializeCostPlanParts,
	spellAdditionalCost,
	spellCastRestrictions,
	spellChoosesX,
	executeCostPaymentParts,
	type CostContext
} from './costs.ts';
import {
	activeAbilityDefs,
	effectiveManaValue,
	instanceFaceOptions,
	resolveObjectFaces
} from './faces.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import {
	evaluatePermanent,
	inspectCardContinuousBreakdown,
	type EvaluatedPermanent
} from './layers.ts';
import { objectManaValue } from './objectFilter.ts';
import { checkGlobalCastPermissionsAndRestrictions, playerLifeTotalCantChange } from './replace.ts';
import {
	allocateEchoTick,
	moveObject,
	withHypotheticalBattlefieldPresence
} from './zones.ts';

export interface Wave3FinalizeCastOptions {
	targets: TargetRef[];
	targetsBySpec?: TargetRef[][];
	chosenModes?: number[];
	xValue: number;
	castOptionId?: string;
	faceIndex?: number;
	fused?: boolean;
	spellMods?: SpellModifications;
	exSourceName?: string;
	descriptions?: string[];
	additionalIncomplete?: boolean;
}

export interface Wave3Host {
	uid: (prefix: string, state: GameState) => string;
	addLog: (
		state: GameState,
		kind: 'rule' | 'cast' | 'combat' | 'trigger' | 'life' | 'sba' | 'system',
		text: string,
		actorId?: string
	) => void;
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
	specTargetCandidates: (
		state: GameState,
		actorId: string,
		sourceCard: ScryfallCard,
		sourceInst: CardInstance | undefined,
		spec: TargetSpec
	) => TargetRef[];
	validateModalChoice: (
		state: GameState,
		actorId: string,
		sourceCard: ScryfallCard,
		sourceInst: CardInstance | undefined,
		modal: ModalDef,
		providedModes: number[] | undefined,
		targets: TargetRef[]
	) => { ok: true; chosenModes: number[]; targetsBySpec: TargetRef[][] } | { ok: false; error: string };
	finalizeCastSpell: (
		state: GameState,
		actor: PlayerGameState,
		inst: CardInstance,
		sourcePlayer: PlayerGameState,
		sourceZone: 'hand' | 'command' | 'exile' | 'graveyard',
		opts: Wave3FinalizeCastOptions
	) => void;
	resumeStackItem: (state: GameState, item: StackItem) => void;
	shuffleArray: <T>(state: GameState, arr: T[]) => T[];
	gainPlayerLife: (state: GameState, player: PlayerGameState, amount: number) => number;
	createTokens: (
		state: GameState,
		controller: PlayerGameState,
		spec: TokenSpec,
		count: number,
		sourceName: string
	) => CardInstance[];
	addCountersToPermanent: (
		state: GameState,
		perm: CardInstance,
		counterType: CounterType,
		amount: number
	) => number;
}

let wave3Host: Wave3Host | null = null;

export function registerWave3Host(host: Wave3Host): void {
	wave3Host = host;
}

function requireHost(): Wave3Host {
	if (!wave3Host) {
		throw new Error('Wave3Host has not been registered.');
	}
	return wave3Host;
}

// ---- Echo (CR 702.30) -----------------------------------------------------------------------

/**
 * CR 702.30a: Advances `activePlayer`'s upkeep boundary timestamps immediately before upkeep
 * triggers are matched so `cameUnderControlSinceLastUpkeep` holds both when the trigger fires and
 * when its intervening-if condition is re-checked on resolution (`CR 603.4`).
 */
export function recordUpkeepBeginForEcho(state: GameState, activePlayer: PlayerGameState): void {
	activePlayer.previousUpkeepBeganAt = activePlayer.currentUpkeepBeganAt ?? 0;
	activePlayer.currentUpkeepBeganAt = allocateEchoTick(state);
}

/**
 * CR 702.30a: True iff `perm` entered the battlefield or last came under `controllerId`'s control
 * since the beginning of `controllerId`'s most recent prior upkeep step.
 */
export function cameUnderControlSinceLastUpkeep(
	state: GameState,
	controllerId: string,
	perm: CardInstance | undefined
): boolean {
	if (!perm || perm.zone !== 'battlefield' || perm.phasedOut) return false;
	if (perm.controllerId !== controllerId) return false;
	const controller = state.players.find((p) => p.playerId === controllerId);
	if (!controller) return false;
	const cameAt = perm.cameUnderControlAt ?? 1;
	const prevUpkeep = controller.previousUpkeepBeganAt ?? 0;
	return cameAt > prevUpkeep;
}

// ---- Madness (CR 702.35) & Rebound (CR 702.88) & Dash (CR 702.109) --------------------------

export function cardHasMadness(card: ScryfallCard): boolean {
	const def = compileCard(card);
	const face0 = def.faces[0];
	if (!face0) return false;
	return face0.abilities.some((ab) => {
		if (ab.kind !== 'keyword') return false;
		const { name: kwId } = ab.keyword;
		return kwId === 'madness';
	});
}

export function cardHasRebound(card: ScryfallCard, faceIndex = 0): boolean {
	const def = compileCard(card);
	const face = def.faces[faceIndex] ?? def.faces[0];
	if (!face) return false;
	return face.abilities.some((ab) => {
		if (ab.kind !== 'keyword') return false;
		const { name: kwId } = ab.keyword;
		return kwId === 'rebound';
	});
}

export function buildDashBounceDelayedTrigger(
	id: string,
	controllerId: string,
	perm: CardInstance,
	sourceCard: ScryfallCard,
	createdAtTurn: number
): DelayedTrigger {
	const view = resolveObjectFaces(effectiveCardForObject(perm), instanceFaceOptions(perm, 'battlefield'));
	return {
		id,
		controllerId,
		sourceInstanceId: perm.instanceId,
		sourceCard,
		triggerPhase: 'end_step',
		createdAtTurn,
		title: `${view.name} — Dash Delayed Return Trigger`,
		description: `At the beginning of the next end step, return ${view.name} from the battlefield to its owner's hand.`,
		delayedEffect: {
			kind: 'dashBounce',
			targetInstanceId: perm.instanceId,
			targetObjectVersion: perm.objectVersion
		}
	};
}

export function buildReboundDelayedTrigger(
	id: string,
	controllerId: string,
	exiledCard: CardInstance,
	sourceCard: ScryfallCard,
	createdAtTurn: number
): DelayedTrigger {
	return {
		id,
		controllerId,
		sourceInstanceId: exiledCard.instanceId,
		sourceCard,
		triggerPhase: 'upkeep',
		onlyOnPlayerTurnId: controllerId,
		targetPlayerId: controllerId,
		createdAtTurn,
		title: `${sourceCard.name} (Rebound)`,
		description: `At the beginning of your next upkeep, you may cast ${sourceCard.name} from exile without paying its mana cost (CR 702.88a).`,
		delayedEffect: {
			kind: 'reboundCast',
			targetInstanceId: exiledCard.instanceId,
			targetObjectVersion: exiledCard.objectVersion
		}
	};
}

export function resolveDashBounceDelayedTrigger(
	state: GameState,
	controller: PlayerGameState,
	targetInstanceId: string,
	targetObjectVersion?: number
): void {
	const host = requireHost();
	for (const pl of state.players) {
		if (pl.lost) continue;
		const perm = pl.battlefield.find((c) => c.instanceId === targetInstanceId);
		if (!perm || perm.phasedOut) continue;
		if (targetObjectVersion !== undefined && perm.objectVersion !== targetObjectVersion) return;
		const owner = state.players.find((o) => o.playerId === perm.ownerId) ?? pl;
		const name = resolveObjectFaces(effectiveCardForObject(perm), instanceFaceOptions(perm, 'battlefield')).name;
		moveObject(state, perm, 'hand', {
			from: 'anyBattlefield',
			toPlayer: owner,
			detachAttachments: true,
			commanderRedirect: true,
			leaveBattlefieldReset: true,
			bumpVersion: true,
			newTimestamp: true,
			ceaseToExist: 'tokens'
		});
		host.addLog(
			state,
			'trigger',
			`Dash delayed trigger returned ${name} to ${owner.username}'s hand (CR 702.109a).`,
			controller.playerId
		);
		return;
	}
}

// ---- Toxic (CR 702.164) ---------------------------------------------------------------------

/**
 * CR 702.164b: Sums the toxic values across all active (non-removed) `toxic` abilities on `evaluated`.
 */
export function sumEvaluatedToxic(evaluated: EvaluatedPermanent): number {
	let total = 0;
	for (const item of evaluated.breakdown.items) {
		if (item.removed || item.canonicalKey !== 'toxic') continue;
		const m = /^toxic\s+(\d+)$/i.exec(item.name.trim());
		if (m) {
			const n = parseInt(m[1], 10);
			if (n > 0) total += n;
		}
	}
	return total;
}

export function sumPermanentToxic(state: GameState, perm: CardInstance): number {
	if (perm.zone !== 'battlefield' || perm.phasedOut) return 0;
	return sumEvaluatedToxic(evaluatePermanent(state, perm));
}

// ---- Unleash (CR 702.98), Riot (CR 702.136), Bloodthirst (CR 702.54), Modular (CR 702.43) ---

/**
 * CR 614.12: Evaluates `obj` as it would exist on the battlefield under `ctrl`'s control to count
 * active instances of a continuous/ETB keyword (`'riot'` or `'unleash'`).
 */
export function countEnteringKeywordInstances(
	state: GameState,
	obj: CardInstance,
	ctrl: PlayerGameState,
	kwName: 'riot' | 'unleash'
): number {
	if (obj.isFaceDown) return 0;
	const card = effectiveCardForObject(obj);
	const faceOpts = instanceFaceOptions(obj, 'battlefield');
	const view = resolveObjectFaces(card, faceOpts);
	const isCreature = view.types.includes('Creature') || view.typeLine.includes('Creature');
	if (!isCreature && kwName === 'riot') {
		// Still check if a Layer 4 effect on the board animates it on entry.
	}
	const innateCount = activeAbilityDefs(card, faceOpts).filter(
		(ab) => ab.kind === 'keyword' && ab.keyword.name === kwName
	).length;

	return withHypotheticalBattlefieldPresence(state, ctrl, obj, () => {
		const breakdown = inspectCardContinuousBreakdown(obj, state);
		let total = 0;
		for (const item of breakdown.items) {
			if (item.removed || item.canonicalKey !== kwName) continue;
			if (item.isInnate) {
				total += Math.max(1, innateCount) + (item.grantCount ?? 0);
			} else {
				total += item.grantCount ?? 1;
			}
		}
		return total;
	});
}

export interface Wave3EtbChoicePromptSpec {
	kind: 'unleash' | 'riot';
	riotIndex?: number;
	riotTotal?: number;
}

/**
 * Returns the next pending human ETB choice (`Unleash` or `Riot`) for `obj` entering under `ctrl`.
 */
export function nextWave3EtbChoice(
	state: GameState,
	obj: CardInstance,
	ctrl: PlayerGameState
): Wave3EtbChoicePromptSpec | null {
	if (obj.isFaceDown) return null;
	if (!obj.unleashChoiceDone) {
		const unleashCount = countEnteringKeywordInstances(state, obj, ctrl, 'unleash');
		if (unleashCount > 0) {
			return { kind: 'unleash' };
		}
	}
	const riotTotal = countEnteringKeywordInstances(state, obj, ctrl, 'riot');
	const done = obj.riotChoicesDone ?? 0;
	if (riotTotal > done) {
		return { kind: 'riot', riotIndex: done + 1, riotTotal };
	}
	return null;
}

/**
 * Bot heuristic for `Unleash` and `Riot` ETB self-replacements.
 */
export function applyBotWave3EtbChoices(
	state: GameState,
	obj: CardInstance,
	ctrl: PlayerGameState
): { unleashCounters: number; riotCounters: number } {
	let unleashCounters = 0;
	let riotCounters = 0;
	if (!obj.unleashChoiceDone) {
		const unleashCount = countEnteringKeywordInstances(state, obj, ctrl, 'unleash');
		if (unleashCount > 0) {
			obj.unleashChoiceDone = true;
			unleashCounters = 1;
		}
	}
	const riotTotal = countEnteringKeywordInstances(state, obj, ctrl, 'riot');
	const done = obj.riotChoicesDone ?? 0;
	if (riotTotal > done) {
		const activePlayer = state.players[state.activePlayerIndex];
		const canAttackThisTurn =
			activePlayer?.playerId === ctrl.playerId &&
			(state.phase === 'upkeep' || state.phase === 'draw' || state.phase === 'main1' || state.phase === 'begin_combat');
		for (let i = done; i < riotTotal; i++) {
			if (canAttackThisTurn && !obj.riotHaste) {
				obj.riotHaste = true;
			} else {
				riotCounters += 1;
			}
		}
		obj.riotChoicesDone = riotTotal;
	}
	return { unleashCounters, riotCounters };
}

/**
 * Places ETB `+1/+1` counters from `Modular N`, `Bloodthirst N/X`, and any chosen `Unleash` / `Riot`
 * counter options onto `obj` once `obj` is on the battlefield (immediately before `ZoneChange` emits).
 */
export function applyWave3EtbCounters(
	state: GameState,
	obj: CardInstance,
	placeCounters: ((state: GameState, perm: CardInstance, counter: CounterType, amount: number) => number) | null,
	extraPlusOneCounters = 0
): void {
	if (obj.isFaceDown) return;
	const card = effectiveCardForObject(obj);
	const abilities = activeAbilityDefs(card, instanceFaceOptions(obj, 'battlefield'));
	const ctrlId = obj.controllerId || obj.defaultControllerId || obj.ownerId;

	let totalOpponentDamage = 0;
	let anyOpponentDealtDamage = false;
	for (const pl of state.players) {
		if (pl.lost || pl.playerId === ctrlId) continue;
		const dmg = pl.damageDealtToThisTurn ?? 0;
		if (dmg > 0) {
			anyOpponentDealtDamage = true;
			totalOpponentDamage += dmg;
		}
	}

	let plusOneToPlace = extraPlusOneCounters;
	for (const ab of abilities) {
		if (ab.kind !== 'keyword') continue;
		const kw = ab.keyword;
		const { name: kwId } = kw;
		if (kwId === 'modular' && (kw.n ?? 0) > 0) {
			plusOneToPlace += kw.n!;
		} else if (kwId === 'bloodthirst' && anyOpponentDealtDamage) {
			if (kw.param === 'X') {
				plusOneToPlace += totalOpponentDamage;
			} else if ((kw.n ?? 0) > 0) {
				plusOneToPlace += kw.n!;
			}
		}
	}

	if (plusOneToPlace > 0) {
		if (placeCounters) {
			placeCounters(state, obj, '+1/+1', plusOneToPlace);
		} else {
			obj.counters['+1/+1'] = (obj.counters['+1/+1'] ?? 0) + plusOneToPlace;
		}
	}

	if (obj.riotHaste || obj.dashed) {
		obj.summoningSick = false;
	}
}

/**
 * CR 702.98a: "As long as it has a +1/+1 counter on it, it can't block."
 */
export function hasUnleashCantBlock(state: GameState, perm: CardInstance): boolean {
	if (perm.zone !== 'battlefield' || perm.phasedOut) return false;
	if ((perm.counters['+1/+1'] ?? 0) <= 0) return false;
	const ev = evaluatePermanent(state, perm);
	return ev.breakdown.items.some((it) => !it.removed && it.canonicalKey === 'unleash');
}

/**
 * Captures non-innate Layer 6 granted `'dies'` keywords (`undying`, `persist`) from a permanent's
 * evaluated breakdown right before it leaves the battlefield (`CR 603.10a`, `CR 704.8`).
 */
export function extractGrantedDeathKeywords(
	state: GameState,
	perm: CardInstance,
	preEvaluated?: EvaluatedPermanent
): Record<string, number> | undefined {
	if (perm.phasedOut) return undefined;
	const ev = preEvaluated ?? evaluatePermanent(state, perm);
	let out: Record<string, number> | undefined;
	for (const item of ev.breakdown.items) {
		if (item.removed) continue;
		if (item.canonicalKey !== 'undying' && item.canonicalKey !== 'persist') continue;
		const count = item.grantCount ?? (item.isInnate ? 0 : 1);
		if (count > 0) {
			out ??= {};
			out[item.canonicalKey] = (out[item.canonicalKey] ?? 0) + count;
		}
	}
	return out;
}

// ---- Ninjutsu & Commander ninjutsu (CR 702.49, CR 508.4, CR 903.8) --------------------------

export function isNinjutsuWindowOpen(state: GameState): boolean {
	return Boolean(state.combat.active && state.combat.blockersDeclared);
}

export function isUnblockedAttackerForPlayer(
	state: GameState,
	perm: CardInstance,
	controllerId: string
): boolean {
	if (!state.combat.active || !state.combat.blockersDeclared) return false;
	if (perm.zone !== 'battlefield' || perm.phasedOut) return false;
	if (perm.controllerId !== controllerId) return false;
	return state.combat.attackers.some(
		(a) =>
			a.attackerInstanceId === perm.instanceId &&
			a.controllerId === controllerId &&
			!a.wasBlocked &&
			a.blockerInstanceIds.length === 0
	);
}

export function captureNinjutsuAttackTargetFromParts(
	state: GameState,
	parts: readonly SerializedPlannedCost[]
): { defenderPlayerId: string; defenderPlaneswalkerId?: string | null } | undefined {
	for (const part of parts) {
		if (part.def.k !== 'returnToHand') continue;
		const chosenId = part.objectIds?.[0];
		if (!chosenId) continue;
		const atk = state.combat.attackers.find((a) => a.attackerInstanceId === chosenId);
		if (atk) {
			return {
				defenderPlayerId: atk.defenderPlayerId,
				...(atk.defenderPlaneswalkerId ? { defenderPlaneswalkerId: atk.defenderPlaneswalkerId } : {})
			};
		}
	}
	return undefined;
}

function resolveNinjutsuStackItem(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState,
	allowCommandZone: boolean
): void {
	const host = requireHost();
	const zones: Array<'hand' | 'command'> = allowCommandZone ? ['hand', 'command'] : ['hand'];
	let foundZone: 'hand' | 'command' | null = null;
	let inst: CardInstance | undefined;
	for (const z of zones) {
		const cand = controller[z].find((c) => c.instanceId === item.sourceInstanceId);
		if (cand && (item.sourceObjectVersion === undefined || cand.objectVersion === item.sourceObjectVersion)) {
			foundZone = z;
			inst = cand;
			break;
		}
	}
	if (!inst || !foundZone) {
		host.addLog(
			state,
			'rule',
			`${item.title} did nothing because ${item.card.name} is no longer in its activation zone (CR 400.7).`,
			controller.playerId
		);
		return;
	}

	inst.isFaceDown = false;
	inst.faceDownSpec = undefined;
	inst.faceDownLabel = undefined;
	const enteringView = resolveObjectFaces(effectiveCardForObject(inst), instanceFaceOptions(inst, 'battlefield'));
	inst.tapped = true;
	inst.summoningSick = !enteringView.keywords.includes('Haste');
	inst.defaultControllerId = controller.playerId;

	moveObject(state, inst, 'battlefield', {
		from: { player: controller, zone: foundZone },
		toPlayer: controller,
		controllerId: controller.playerId,
		bumpVersion: true,
		newTimestamp: true
	});

	if (inst.zone === 'battlefield' && state.combat.active && item.ninjutsuAttackTarget) {
		const { defenderPlayerId, defenderPlaneswalkerId } = item.ninjutsuAttackTarget;
		const defPlayer = state.players.find((p) => p.playerId === defenderPlayerId && !p.lost);
		if (defPlayer) {
			let validPwId: string | undefined;
			if (defenderPlaneswalkerId) {
				const pw = defPlayer.battlefield.find(
					(b) => !b.phasedOut && b.instanceId === defenderPlaneswalkerId
				);
				if (pw) validPwId = pw.instanceId;
			}
			// CR 702.49c & CR 508.4: Enters tapped and attacking the same player/planeswalker;
			// never emits AttackDeclared so "Whenever ~ attacks" abilities do not trigger.
			if (!defenderPlaneswalkerId || validPwId) {
				state.combat.attackers.push({
					attackerInstanceId: inst.instanceId,
					controllerId: controller.playerId,
					defenderPlayerId: defPlayer.playerId,
					...(validPwId ? { defenderPlaneswalkerId: validPwId } : {}),
					blockerInstanceIds: [],
					wasBlocked: false
				});
			}
		}
	}

	host.addLog(
		state,
		'combat',
		`${controller.username} put ${enteringView.name} onto the battlefield tapped and attacking via ${allowCommandZone ? 'Commander ninjutsu' : 'Ninjutsu'} (CR 702.49c).`,
		controller.playerId
	);
}

// ---- Triggered Exile Cast Helpers (Madness, Cascade, Rebound) -------------------------------

interface FaceCastSetup {
	faceIndex: number;
	faceName: string;
	manaCost?: string;
	costDefs: CostDef[];
	isFree: boolean;
	choosesX: boolean;
	modal?: ModalDef;
	nonModalSpecs: TargetSpec[];
	additionalIncomplete: boolean;
}

function getFaceSpellModalAndTargets(
	card: ScryfallCard,
	faceIndex: number
): { modal?: ModalDef; nonModalSpecs: TargetSpec[] } {
	const faceOpts = { zone: 'stack' as const, faceIndex };
	const abilities = activeAbilityDefs(card, faceOpts);
	const view = resolveObjectFaces(card, faceOpts);
	if (view.subtypes.includes('Aura')) {
		const specs: TargetSpec[] = [];
		for (const ab of abilities) {
			if (ab.kind !== 'keyword') continue;
			const { name: kwId } = ab.keyword;
			if (kwId === 'enchant') {
				if (ab.keyword.enchantPlayer) {
					return {
						nonModalSpecs: [
							{ kind: 'player', filter: {}, player: ab.keyword.enchantPlayer, min: 1, max: 1 }
						]
					};
				}
				specs.push({
					kind: 'object',
					filter: { zone: 'battlefield', ...(ab.keyword.enchantFilter ?? {}) },
					min: specs.length === 0 ? 1 : 0,
					max: specs.length === 0 ? 1 : 0
				});
			}
		}
		if (specs.length === 0) {
			specs.push({ kind: 'object', filter: { zone: 'battlefield' }, min: 1, max: 1 });
		}
		return { nonModalSpecs: specs };
	}
	if (!view.types.includes('Instant') && !view.types.includes('Sorcery')) {
		return { nonModalSpecs: [] };
	}
	const nonModalSpecs: TargetSpec[] = [];
	for (const ab of abilities) {
		if (ab.kind === 'spell') {
			if (ab.modal) return { modal: ab.modal, nonModalSpecs: [] };
			nonModalSpecs.push(...ab.targets);
		} else if (ab.kind === 'unsupported' && ab.id === 'cast' && ab.targets) {
			nonModalSpecs.push(...ab.targets);
		}
	}
	return { nonModalSpecs };
}

function checkSpellCastTimingRestrictions(
	state: GameState,
	actorId: string,
	card: ScryfallCard,
	faceIndex: number
): boolean {
	const activePlayer = state.players[state.activePlayerIndex];
	for (const r of spellCastRestrictions(card, faceIndex, false)) {
		if (r === 'duringCombat' && !state.combat.active) return false;
		if (r === 'duringYourTurn' && activePlayer?.playerId !== actorId) return false;
		if (
			r === 'beforeAttackers' &&
			(!state.combat.active || state.phase !== 'begin_combat')
		) {
			return false;
		}
	}
	return true;
}

function buildFaceCastSetup(
	state: GameState,
	actor: PlayerGameState,
	inst: CardInstance,
	faceIndex: number,
	mode: { kind: 'free' } | { kind: 'madness'; manaCost?: string; costDefs: CostDef[] }
): FaceCastSetup | null {
	const host = requireHost();
	const card = effectiveCardForObject(inst);
	const view = resolveObjectFaces(card, { zone: 'stack', faceIndex });
	if (view.types.includes('Land')) return null;

	const globalPerm = checkGlobalCastPermissionsAndRestrictions(state, actor, inst, 'exile');
	if (globalPerm.blocked || !globalPerm.ok) return null;
	if (!checkSpellCastTimingRestrictions(state, actor.playerId, card, faceIndex)) return null;

	const additional = spellAdditionalCost(card, faceIndex, false);
	const combinedCostDefs: CostDef[] = [
		...(mode.kind === 'madness' ? mode.costDefs : []),
		...(additional?.defs ?? [])
	];
	const isFree = mode.kind === 'free';
	const baseCostArg = isFree
		? ({ kind: 'free' } as const)
		: ({ kind: 'alternative', manaCost: mode.manaCost, costDefs: mode.costDefs } as const);

	// Check payability at X = 0
	const reqAtZero = effectiveSpellManaCost(state, actor, inst, 0, baseCostArg, undefined, faceIndex);
	if (combinedCostDefs.length > 0) {
		const ctx = host.costContext(state, actor, inst, 0, true, reqAtZero);
		if (!chooseCostPayment(ctx, combinedCostDefs)) return null;
	} else if (!host.canPayOrAutoTap(actor, reqAtZero, state)) {
		return null;
	}

	const { modal, nonModalSpecs } = getFaceSpellModalAndTargets(card, faceIndex);
	if (modal) {
		const legalModes: number[] = [];
		for (let i = 0; i < modal.modes.length; i++) {
			const ok = modal.modes[i].targets.every(
				(sp) => sp.min <= 0 || host.specTargetCandidates(state, actor.playerId, card, inst, sp).length >= sp.min
			);
			if (ok) legalModes.push(i);
		}
		const enough =
			modal.min === 0 || modal.upTo
				? true
				: modal.allowRepeat && !modal.oncePerTurnUnique
					? legalModes.length > 0
					: legalModes.length >= modal.min;
		if (!enough) return null;
	} else {
		for (const sp of nonModalSpecs) {
			if (sp.min > 0 && host.specTargetCandidates(state, actor.playerId, card, inst, sp).length < sp.min) {
				return null;
			}
		}
	}

	const choosesX = !isFree && spellChoosesX(card, baseCostArg, undefined, faceIndex, false, false);
	return {
		faceIndex,
		faceName: view.name,
		manaCost: mode.kind === 'madness' ? mode.manaCost : undefined,
		costDefs: combinedCostDefs,
		isFree,
		choosesX,
		modal,
		nonModalSpecs,
		additionalIncomplete: Boolean(additional && !additional.complete)
	};
}

function maxAffordableX(
	state: GameState,
	actor: PlayerGameState,
	inst: CardInstance,
	setup: FaceCastSetup
): number {
	const host = requireHost();
	const baseCostArg = setup.isFree
		? ({ kind: 'free' } as const)
		: ({ kind: 'alternative', manaCost: setup.manaCost, costDefs: setup.costDefs } as const);
	let best = 0;
	for (let x = 1; x <= 20; x++) {
		const req = effectiveSpellManaCost(state, actor, inst, x, baseCostArg, undefined, setup.faceIndex);
		const ok =
			setup.costDefs.length > 0
				? Boolean(chooseCostPayment(host.costContext(state, actor, inst, x, true, req), setup.costDefs))
				: host.canPayOrAutoTap(actor, req, state);
		if (ok) best = x;
		else break;
	}
	return best;
}

function activeSpecsForSetup(setup: FaceCastSetup, chosenModes?: number[]): TargetSpec[] {
	if (setup.modal) {
		const modes = chosenModes ?? [];
		const out: TargetSpec[] = [];
		for (const m of modes) {
			const branch = setup.modal.modes[m];
			if (branch) out.push(...branch.targets);
		}
		return out;
	}
	return setup.nonModalSpecs;
}

function chooseBotModesAndTargets(
	state: GameState,
	actor: PlayerGameState,
	inst: CardInstance,
	setup: FaceCastSetup
): { chosenModes?: number[]; targets: TargetRef[]; targetsBySpec?: TargetRef[][] } | null {
	const host = requireHost();
	const card = effectiveCardForObject(inst);
	let chosenModes: number[] | undefined;
	if (setup.modal) {
		const picked: number[] = [];
		for (let i = 0; i < setup.modal.modes.length && picked.length < setup.modal.max; i++) {
			const ok = setup.modal.modes[i].targets.every(
				(sp) => sp.min <= 0 || host.specTargetCandidates(state, actor.playerId, card, inst, sp).length >= sp.min
			);
			if (ok) picked.push(i);
		}
		while (setup.modal.allowRepeat && picked.length > 0 && picked.length < setup.modal.min) {
			picked.push(picked[0]);
		}
		if (picked.length < setup.modal.min && !setup.modal.upTo) return null;
		chosenModes = picked;
	}
	const specs = activeSpecsForSetup(setup, chosenModes);
	const targets: TargetRef[] = [];
	const targetsBySpec: TargetRef[][] = [];
	const usedAcrossOtherTarget = new Set<string>();
	for (const sp of specs) {
		const cands = host
			.specTargetCandidates(state, actor.playerId, card, inst, sp)
			.filter((c) => !sp.otherTarget || !usedAcrossOtherTarget.has(`${c.kind}:${c.id}`));
		if (cands.length < sp.min) return null;
		const want = sp.min > 0 ? sp.min : Math.min(sp.max, cands.length > 0 ? 1 : 0);
		const picked = cands.slice(0, want);
		for (const p of picked) usedAcrossOtherTarget.add(`${p.kind}:${p.id}`);
		targets.push(...picked);
		targetsBySpec.push(picked);
	}
	return {
		...(chosenModes ? { chosenModes } : {}),
		targets,
		...(specs.length > 0 ? { targetsBySpec } : {})
	};
}

function executeTriggerCastNow(
	state: GameState,
	actor: PlayerGameState,
	inst: CardInstance,
	owner: PlayerGameState,
	setup: FaceCastSetup,
	xValue: number,
	chosenModes: number[] | undefined,
	targets: TargetRef[],
	targetsBySpec: TargetRef[][] | undefined,
	costPayment: CostPayment | undefined,
	exSourceName: 'Madness' | 'Cascade' | 'Rebound'
): boolean {
	const host = requireHost();
	const baseCostArg = setup.isFree
		? ({ kind: 'free' } as const)
		: ({ kind: 'alternative', manaCost: setup.manaCost, costDefs: setup.costDefs } as const);
	const req = effectiveSpellManaCost(state, actor, inst, xValue, baseCostArg, undefined, setup.faceIndex);

	let descriptions: string[] = [];
	if (setup.costDefs.length > 0) {
		const ctx = host.costContext(state, actor, inst, xValue, true, req);
		const resolvedPayment = costPayment ?? chooseCostPayment(ctx, setup.costDefs);
		if (!resolvedPayment) return false;
		const plan = planCosts(ctx, setup.costDefs, resolvedPayment);
		if (!plan.ok || plan.question) return false;
		const parts = serializeCostPlanParts(ctx, plan);
		payTapAndManaCostParts(ctx, parts, plan.mana, descriptions);
		const paid = executeCostPaymentParts(ctx, parts, 0, 0, descriptions);
		descriptions = paid.descriptions;
	} else {
		if (!host.payManaWithAutoTap(actor, req, state)) return false;
	}

	host.finalizeCastSpell(state, actor, inst, owner, 'exile', {
		targets,
		...(targetsBySpec ? { targetsBySpec } : {}),
		...(chosenModes ? { chosenModes } : {}),
		xValue,
		castOptionId:
			exSourceName === 'Madness'
				? 'exile:madness'
				: exSourceName === 'Cascade'
					? 'exile:cascade'
					: 'exile:rebound',
		faceIndex: setup.faceIndex,
		spellMods: {
			castSummarySuffix:
				exSourceName === 'Madness'
					? ' (Madness)'
					: exSourceName === 'Cascade'
						? ' (Cascaded)'
						: ' (Rebound)'
		},
		exSourceName,
		descriptions,
		additionalIncomplete: setup.additionalIncomplete
	});
	return true;
}

function enqueueWave3Prompt(
	state: GameState,
	item: StackItem,
	playerId: string,
	promptFields: Omit<PendingPrompt, 'id' | 'playerId' | 'continuation'>
): void {
	const host = requireHost();
	enqueueChoicePrompt(state, {
		...promptFields,
		id: host.uid('prm', state),
		playerId,
		triggerStackItemId: item.id,
		continuation: {
			kind: 'handler',
			name: 'wave3_keyword',
			data: { stackItemId: item.id }
		}
	});
}

/**
 * Drives the interactive / bot cast flow for `Madness`, `Cascade`, and `Rebound` from `exile`.
 * Returns `'paused'` if waiting on a human choice prompt, `'cast'` if cast onto `state.stack`,
 * or `'declined'` if not cast.
 */
function runExileTriggerCastFlow(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState,
	inst: CardInstance,
	owner: PlayerGameState,
	eligibleSetups: FaceCastSetup[],
	exSourceName: 'Madness' | 'Cascade' | 'Rebound',
	costLabel?: string
): 'paused' | 'cast' | 'declined' {
	const host = requireHost();
	if (eligibleSetups.length === 0) return 'declined';

	if (controller.isBot) {
		const sorted = [...eligibleSetups].sort(
			(a, b) =>
				effectiveManaValue(inst.card, { zone: 'stack', faceIndex: b.faceIndex }) -
				effectiveManaValue(inst.card, { zone: 'stack', faceIndex: a.faceIndex })
		);
		const pickedSetup = sorted[0];
		const xVal = pickedSetup.choosesX ? maxAffordableX(state, controller, inst, pickedSetup) : 0;
		const mt = chooseBotModesAndTargets(state, controller, inst, pickedSetup);
		if (!mt) return 'declined';
		const ok = executeTriggerCastNow(
			state,
			controller,
			inst,
			owner,
			pickedSetup,
			xVal,
			mt.chosenModes,
			mt.targets,
			mt.targetsBySpec,
			undefined,
			exSourceName
		);
		return ok ? 'cast' : 'declined';
	}

	const resume = (item.wave3Resume ??= {
		step: 'ask_may',
		cardId: inst.instanceId,
		cardVersion: inst.objectVersion
	});

	if (resume.step === 'declined') {
		return 'declined';
	}

	if (resume.step === 'ask_may') {
		const cardDisplay =
			eligibleSetups.length > 1
				? eligibleSetups.map((s) => s.faceName).join(' // ')
				: eligibleSetups[0].faceName;
		const desc =
			exSourceName === 'Madness'
				? `You may cast ${cardDisplay} from exile for its madness cost (${costLabel ?? '{0}'}) instead of putting it into your graveyard (CR 702.35a).`
				: `You may cast ${cardDisplay} from exile without paying its mana cost (${exSourceName}, CR ${exSourceName === 'Cascade' ? '702.85a' : '702.88a'}).`;
		enqueueWave3Prompt(state, item, controller.playerId, {
			kind: 'yesNo',
			purpose: 'trigger_may',
			title: `${exSourceName} — Cast ${cardDisplay}?`,
			description: desc,
			yesLabel: exSourceName === 'Madness' ? `Cast (${costLabel ?? '{0}'})` : 'Cast for Free',
			noLabel: exSourceName === 'Madness' ? 'Put into Graveyard' : 'Decline',
			choice: { kind: 'yesNo', question: desc }
		});
		return 'paused';
	}

	if (resume.chosenFaceIndex === undefined) {
		if (eligibleSetups.length === 1) {
			resume.chosenFaceIndex = eligibleSetups[0].faceIndex;
		} else {
			resume.step = 'ask_face';
			const labels = eligibleSetups.map((s) => s.faceName);
			enqueueWave3Prompt(state, item, controller.playerId, {
				kind: 'chooseMode',
				purpose: 'trigger_modes',
				title: `${exSourceName} — Choose Face to Cast`,
				description: `Choose which face of ${inst.card.name} to cast without paying its mana cost:`,
				choice: { kind: 'chooseMode', modes: labels, min: 1, max: 1 }
			});
			return 'paused';
		}
	}

	const setup = eligibleSetups.find((s) => s.faceIndex === resume.chosenFaceIndex);
	if (!setup) return 'declined';

	if (resume.xValue === undefined) {
		if (!setup.choosesX) {
			resume.xValue = 0;
		} else {
			const maxX = maxAffordableX(state, controller, inst, setup);
			resume.step = 'ask_x';
			enqueueWave3Prompt(state, item, controller.playerId, {
				kind: 'chooseNumber',
				purpose: 'generic',
				title: `${setup.faceName} — Choose X`,
				description: `Choose a value for X for ${setup.faceName} (0–${maxX}):`,
				choice: {
					kind: 'chooseNumber',
					min: 0,
					max: maxX,
					reason: `Choose X for ${setup.faceName}`,
					defaultNumber: maxX
				}
			});
			return 'paused';
		}
	}

	const card = effectiveCardForObject(inst);
	if (setup.modal && !resume.chosenModes) {
		const modeLabels = setup.modal.modes.map((_, idx) => `Mode ${idx + 1}`);
		const disabledIndices: number[] = [];
		for (let i = 0; i < setup.modal.modes.length; i++) {
			const ok = setup.modal.modes[i].targets.every(
				(sp) => sp.min <= 0 || host.specTargetCandidates(state, controller.playerId, card, inst, sp).length >= sp.min
			);
			if (!ok) disabledIndices.push(i);
		}
		resume.step = 'ask_modes';
		enqueueWave3Prompt(state, item, controller.playerId, {
			kind: 'chooseMode',
			purpose: 'trigger_modes',
			title: `${setup.faceName} — Choose Mode(s)`,
			description: `Choose ${setup.modal.min}–${setup.modal.max} mode(s) for ${setup.faceName}:`,
			choice: {
				kind: 'chooseMode',
				modes: modeLabels,
				min: setup.modal.upTo ? 0 : setup.modal.min,
				max: setup.modal.max,
				...(setup.modal.allowRepeat ? { allowRepeat: true } : {}),
				...(disabledIndices.length > 0 ? { disabledIndices } : {})
			}
		});
		return 'paused';
	}

	const specs = activeSpecsForSetup(setup, resume.chosenModes);
	const chosenTargetIds = (resume.chosenTargetIds ??= []);
	const targetKinds = (resume.targetKinds ??= []);

	// Collect targets spec-by-spec; stored flat per spec or indexed by spec cursor
	const specCountsKey = resume.costOptions; // keep separate
	void specCountsKey;
	let cursorSpec = 0;
	const targetsBySpec: TargetRef[][] = [];
	let flatCursor = 0;
	for (let sIdx = 0; sIdx < specs.length; sIdx++) {
		const sp = specs[sIdx];
		const cands = host
			.specTargetCandidates(state, controller.playerId, card, inst, sp)
			.filter((c) => {
				if (!sp.otherTarget) return true;
				for (let prev = 0; prev < flatCursor; prev++) {
					if (targetKinds[prev] === c.kind && chosenTargetIds[prev] === c.id) return false;
				}
				return true;
			});
		if (cands.length < sp.min) return 'declined';

		// Check if we already recorded choices for this spec in chosenTargetIds via sentinel or single-target spec
		const remainingRecorded = chosenTargetIds.length - flatCursor;
		if (sp.min === 0 && sp.max === 0) {
			targetsBySpec.push([]);
			cursorSpec++;
			continue;
		}
		if (remainingRecorded <= 0) {
			if (sp.min === sp.max && cands.length === sp.min) {
				for (const c of cands) {
					chosenTargetIds.push(c.id);
					targetKinds.push(c.kind);
					flatCursor++;
				}
				targetsBySpec.push(cands);
				cursorSpec++;
				continue;
			}
			// Prompt human for this TargetSpec
			resume.step = `ask_target:${sIdx}`;
			const allObjects = cands.every((c) => c.kind !== 'player' && c.kind !== 'stack');
			if (allObjects) {
				const z = typeof sp.filter.zone === 'string' && sp.filter.zone !== 'stack' ? sp.filter.zone : 'battlefield';
				enqueueWave3Prompt(state, item, controller.playerId, {
					kind: 'chooseObjects',
					purpose: 'trigger_targets',
					title: `${setup.faceName} — Choose Target(s)`,
					description: `Choose ${sp.min === sp.max ? sp.min : `${sp.min}–${sp.max}`} target(s) for ${setup.faceName}:`,
					candidateInstanceIds: cands.map((c) => c.id),
					countRequired: sp.min,
					choice: {
						kind: 'chooseObjects',
						candidates: cands.map((c) => c.id),
						min: sp.min,
						max: Math.min(sp.max, cands.length),
						zone: z,
						reason: `${setup.faceName} — Choose Target(s)`
					}
				});
			} else {
				enqueueWave3Prompt(state, item, controller.playerId, {
					kind: 'chooseMode',
					purpose: 'trigger_targets',
					title: `${setup.faceName} — Choose Target(s)`,
					description: `Choose ${sp.min === sp.max ? sp.min : `${sp.min}–${sp.max}`} target(s) for ${setup.faceName}:`,
					choice: {
						kind: 'chooseMode',
						modes: cands.map((c) => c.label),
						min: sp.min,
						max: Math.min(sp.max, cands.length)
					}
				});
			}
			return 'paused';
		}

		// Consume recorded targets for this spec
		if (chosenTargetIds[flatCursor] === '__NONE__') {
			flatCursor += 1;
			targetsBySpec.push([]);
			cursorSpec++;
			continue;
		}
		const bucket: TargetRef[] = [];
		while (flatCursor < chosenTargetIds.length && bucket.length < sp.max) {
			if (chosenTargetIds[flatCursor] === '__SPEC_END__') {
				flatCursor += 1;
				break;
			}
			const id = chosenTargetIds[flatCursor];
			const kind = targetKinds[flatCursor];
			const match = cands.find((c) => c.id === id && c.kind === kind);
			if (!match) return 'declined';
			bucket.push(match);
			flatCursor += 1;
		}
		if (bucket.length < sp.min) return 'declined';
		targetsBySpec.push(bucket);
		cursorSpec++;
	}
	void cursorSpec;

	const flatTargets = targetsBySpec.flat();

	// Step through non-mana cost choices if needed
	const baseCostArg = setup.isFree
		? ({ kind: 'free' } as const)
		: ({ kind: 'alternative', manaCost: setup.manaCost, costDefs: setup.costDefs } as const);
	const req = effectiveSpellManaCost(state, controller, inst, resume.xValue, baseCostArg, undefined, setup.faceIndex);
	const payment: CostPayment = {
		...(resume.costOptions ? { options: resume.costOptions } : {}),
		...(resume.costObjects ? { objects: resume.costObjects } : {})
	};

	if (setup.costDefs.length > 0) {
		const ctx = host.costContext(state, controller, inst, resume.xValue, true, req);
		const plan = planCosts(ctx, setup.costDefs, payment);
		if (!plan.ok) return 'declined';
		if (plan.question) {
			resume.step = plan.question.kind === 'option' ? `ask_cost_opt:${plan.question.index}` : `ask_cost_obj:${plan.question.index}`;
			const reqChoice = buildCostChoiceRequest(plan.question);
			enqueueWave3Prompt(state, item, controller.playerId, {
				kind: reqChoice.kind,
				purpose: 'cost_choice',
				title: `${setup.faceName} — Pay Cost`,
				description: plan.question.kind === 'option' ? 'Choose how to pay the cost:' : plan.question.label,
				...(reqChoice.kind === 'chooseObjects'
					? {
							candidateInstanceIds: reqChoice.candidates,
							countRequired: reqChoice.min
						}
					: {}),
				choice: reqChoice
			});
			return 'paused';
		}
	}

	const ok = executeTriggerCastNow(
		state,
		controller,
		inst,
		owner,
		setup,
		resume.xValue,
		resume.chosenModes,
		flatTargets,
		specs.length > 0 ? targetsBySpec : undefined,
		payment,
		exSourceName
	);
	return ok ? 'cast' : 'declined';
}

// ---- Madness, Cascade, Rebound, Fabricate, Extort Stack Resolution --------------------------

function shuffleRemainingCascadeExiledToBottom(
	state: GameState,
	controller: PlayerGameState,
	exiledIds: readonly string[]
): void {
	const host = requireHost();
	const remaining: CardInstance[] = [];
	for (const id of exiledIds) {
		const found = controller.exile.find((c) => c.instanceId === id);
		if (found) remaining.push(found);
	}
	if (remaining.length === 0) return;
	host.shuffleArray(state, remaining);
	for (const card of remaining) {
		moveObject(state, card, 'library', {
			from: { player: controller, zone: 'exile' },
			toPlayer: controller,
			insert: 'end',
			bumpVersion: true,
			newTimestamp: true
		});
	}
	host.addLog(
		state,
		'trigger',
		`${controller.username} put ${remaining.length} exiled card(s) on the bottom of their library in a random order (Cascade, CR 702.85a).`,
		controller.playerId
	);
}

function resolveMadnessTrigger(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState
): 'paused' | 'done' {
	const host = requireHost();
	const owner = state.players.find((p) => p.playerId === item.controllerId) ?? controller;
	const targetId = item.eventObjectId ?? item.sourceInstanceId;
	const expectedVer = item.wave3Resume?.cardVersion ?? item.eventObjectVersion ?? item.sourceObjectVersion;
	const inst = owner.exile.find((c) => c.instanceId === targetId);
	if (!inst || inst.madnessOwnerId !== controller.playerId || (expectedVer !== undefined && inst.objectVersion !== expectedVer)) {
		return 'done';
	}

	const madnessCost = keywordAltCost(effectiveCardForObject(inst), 'madness', 0);
	if (!madnessCost) {
		inst.madnessOwnerId = undefined;
		moveObject(state, inst, 'graveyard', {
			from: { player: owner, zone: 'exile' },
			toPlayer: owner,
			graveyardReplacement: true,
			commanderRedirect: true,
			bumpVersion: true,
			newTimestamp: true
		});
		return 'done';
	}

	const setup = buildFaceCastSetup(state, controller, inst, 0, {
		kind: 'madness',
		manaCost: madnessCost.manaCost,
		costDefs: madnessCost.costDefs
	});
	const eligible = setup ? [setup] : [];
	const res = runExileTriggerCastFlow(
		state,
		item,
		controller,
		inst,
		owner,
		eligible,
		'Madness',
		madnessCost.display
	);
	if (res === 'paused') return 'paused';
	if (res === 'declined' && owner.exile.includes(inst)) {
		inst.madnessOwnerId = undefined;
		moveObject(state, inst, 'graveyard', {
			from: { player: owner, zone: 'exile' },
			toPlayer: owner,
			graveyardReplacement: true,
			commanderRedirect: true,
			bumpVersion: true,
			newTimestamp: true
		});
		host.addLog(
			state,
			'trigger',
			`${controller.username} did not cast ${inst.card.name} via Madness; put into ${owner.username}'s graveyard (CR 702.35a).`,
			controller.playerId
		);
	}
	delete item.wave3Resume;
	return 'done';
}

function resolveCascadeTrigger(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState
): 'paused' | 'done' {
	const host = requireHost();
	const cascadeSpellMv = item.triggerEventStackItem
		? objectManaValue(state, item.triggerEventStackItem)
		: objectManaValue(state, item);

	let resume = item.wave3Resume;
	if (!resume) {
		const exiledIds: string[] = [];
		let hitInst: CardInstance | undefined;
		while (controller.library.length > 0) {
			const top = controller.library[0];
			moveObject(state, top, 'exile', {
				from: { player: controller, zone: 'library' },
				toPlayer: controller,
				bumpVersion: true,
				newTimestamp: true
			});
			if (top.zone === 'exile') {
				exiledIds.push(top.instanceId);
			}
			const exileView = resolveObjectFaces(effectiveCardForObject(top), { zone: 'exile' });
			if (!exileView.types.includes('Land') && exileView.manaValue < cascadeSpellMv) {
				if (top.zone === 'exile') hitInst = top;
				break;
			}
		}
		if (exiledIds.length > 0) {
			host.addLog(
				state,
				'trigger',
				`${controller.username} exiled ${exiledIds.length} card(s) for Cascade (MV < ${cascadeSpellMv}).`,
				controller.playerId
			);
		}
		resume = item.wave3Resume = {
			step: 'ask_may',
			cardId: hitInst?.instanceId,
			cardVersion: hitInst?.objectVersion,
			exiledIds
		};
	}

	const exiledIds = resume.exiledIds ?? [];
	const hitInst = resume.cardId
		? controller.exile.find(
				(c) =>
					c.instanceId === resume!.cardId &&
					(resume!.cardVersion === undefined || c.objectVersion === resume!.cardVersion)
			)
		: undefined;

	if (!hitInst) {
		shuffleRemainingCascadeExiledToBottom(state, controller, exiledIds);
		delete item.wave3Resume;
		return 'done';
	}

	const hitCard = effectiveCardForObject(hitInst);
	const layout = hitCard.layout;
	const candidateFaces =
		layout === 'modal_dfc' || layout === 'split' || layout === 'adventure' ? [0, 1] : [0];
	const eligibleSetups: FaceCastSetup[] = [];
	for (const fi of candidateFaces) {
		if (!compileCard(hitCard).faces[fi]) continue;
		const stackView = resolveObjectFaces(hitCard, { zone: 'stack', faceIndex: fi });
		// CR 702.85a: Resulting spell on the stack must ALSO have mana value < cascade spell's MV.
		if (stackView.types.includes('Land')) continue;
		const stackMv = effectiveManaValue(hitCard, { zone: 'stack', faceIndex: fi });
		if (stackMv >= cascadeSpellMv) continue;
		const setup = buildFaceCastSetup(state, controller, hitInst, fi, { kind: 'free' });
		if (setup) eligibleSetups.push(setup);
	}

	const owner = state.players.find((p) => p.playerId === hitInst.ownerId) ?? controller;
	const res = runExileTriggerCastFlow(
		state,
		item,
		controller,
		hitInst,
		owner,
		eligibleSetups,
		'Cascade'
	);
	if (res === 'paused') return 'paused';

	shuffleRemainingCascadeExiledToBottom(state, controller, exiledIds);
	delete item.wave3Resume;
	return 'done';
}

export function resolveReboundDelayedTrigger(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState,
	targetInstanceId: string,
	targetObjectVersion?: number
): 'paused' | 'done' {
	let owner: PlayerGameState | undefined;
	let inst: CardInstance | undefined;
	for (const pl of state.players) {
		const cand = pl.exile.find((c) => c.instanceId === targetInstanceId);
		if (cand) {
			owner = pl;
			inst = cand;
			break;
		}
	}
	if (!inst || !owner || (targetObjectVersion !== undefined && inst.objectVersion !== targetObjectVersion)) {
		delete item.wave3Resume;
		return 'done';
	}

	const card = effectiveCardForObject(inst);
	const layout = card.layout;
	const candidateFaces =
		layout === 'modal_dfc' || layout === 'split' || layout === 'adventure' ? [0, 1] : [0];
	const eligibleSetups: FaceCastSetup[] = [];
	for (const fi of candidateFaces) {
		if (!compileCard(card).faces[fi]) continue;
		const setup = buildFaceCastSetup(state, controller, inst, fi, { kind: 'free' });
		if (setup) eligibleSetups.push(setup);
	}

	const res = runExileTriggerCastFlow(
		state,
		item,
		controller,
		inst,
		owner,
		eligibleSetups,
		'Rebound'
	);
	if (res === 'paused') return 'paused';
	delete item.wave3Resume;
	return 'done';
}

function resolveFabricateTrigger(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState,
	fabricateN: number
): 'paused' | 'done' {
	const host = requireHost();
	const n = Math.max(0, fabricateN);
	if (n <= 0) return 'done';

	const findStillOnBattlefield = (): CardInstance | undefined => {
		for (const pl of state.players) {
			if (pl.lost) continue;
			const perm = pl.battlefield.find((c) => c.instanceId === item.sourceInstanceId);
			if (
				perm &&
				!perm.phasedOut &&
				(item.sourceObjectVersion === undefined || perm.objectVersion === item.sourceObjectVersion)
			) {
				return perm;
			}
		}
		return undefined;
	};

	const createServos = () => {
		host.createTokens(
			state,
			controller,
			{
				name: 'Servo',
				power: 1,
				toughness: 1,
				colors: [],
				typeLine: 'Artifact Creature — Servo',
				keywords: []
			},
			n,
			item.card.name
		);
		host.addLog(
			state,
			'trigger',
			`${controller.username} created ${n} 1/1 colorless Servo artifact creature token(s) (Fabricate ${n}, CR 702.123a).`,
			controller.playerId
		);
	};

	const srcPerm = findStillOnBattlefield();
	// CR 702.123a: If the permanent is no longer on the battlefield when Fabricate resolves,
	// you can't put +1/+1 counters on it, so create N 1/1 Servo tokens immediately.
	if (!srcPerm) {
		createServos();
		delete item.wave3Resume;
		return 'done';
	}

	if (controller.isBot) {
		host.addCountersToPermanent(state, srcPerm, '+1/+1', n);
		host.addLog(
			state,
			'trigger',
			`${controller.username} put ${n} +1/+1 counter(s) on ${srcPerm.card.name} (Fabricate ${n}, CR 702.123a).`,
			controller.playerId
		);
		return 'done';
	}

	const resume = item.wave3Resume;
	if (!resume) {
		item.wave3Resume = { step: 'fabricate_choice' };
		const srcName = resolveObjectFaces(effectiveCardForObject(srcPerm), instanceFaceOptions(srcPerm, 'battlefield')).name;
		const desc = `Fabricate ${n}: Put ${n} +1/+1 counter(s) on ${srcName}? If you don't, create ${n} 1/1 colorless Servo artifact creature token(s) (CR 702.123a).`;
		enqueueWave3Prompt(state, item, controller.playerId, {
			kind: 'yesNo',
			purpose: 'trigger_may',
			title: `${srcName} — Fabricate ${n}`,
			description: desc,
			yesLabel: `Put ${n} +1/+1 counter(s)`,
			noLabel: `Create ${n} Servo token(s)`,
			choice: { kind: 'yesNo', question: desc }
		});
		return 'paused';
	}

	if (resume.step === 'fabricate_counters') {
		const nowPerm = findStillOnBattlefield();
		if (nowPerm) {
			host.addCountersToPermanent(state, nowPerm, '+1/+1', n);
			host.addLog(
				state,
				'trigger',
				`${controller.username} put ${n} +1/+1 counter(s) on ${nowPerm.card.name} (Fabricate ${n}, CR 702.123a).`,
				controller.playerId
			);
		} else {
			createServos();
		}
	} else {
		createServos();
	}
	delete item.wave3Resume;
	return 'done';
}

function resolveExtortTrigger(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState
): 'paused' | 'done' {
	const host = requireHost();
	const reqW = parseManaCost('{W}');
	const reqB = parseManaCost('{B}');
	const canPayW = host.canPayOrAutoTap(controller, reqW, state);
	const canPayB = host.canPayOrAutoTap(controller, reqB, state);
	if (!canPayW && !canPayB) {
		delete item.wave3Resume;
		return 'done';
	}

	const drainOpponents = (paidSym: '{W}' | '{B}') => {
		let totalLost = 0;
		for (const opp of state.players) {
			if (opp.lost || opp.playerId === controller.playerId) continue;
			if (!playerLifeTotalCantChange(state, opp)) {
				opp.life -= 1;
				totalLost += 1;
			}
		}
		if (totalLost > 0) {
			host.gainPlayerLife(state, controller, totalLost);
		}
		host.addLog(
			state,
			'life',
			`${controller.username} paid ${paidSym} for Extort: each opponent lost 1 life and ${controller.username} gained ${totalLost} life (CR 702.101a).`,
			controller.playerId
		);
	};

	if (controller.isBot) {
		const payW = canPayW;
		if (host.payManaWithAutoTap(controller, payW ? reqW : reqB, state)) {
			drainOpponents(payW ? '{W}' : '{B}');
		}
		return 'done';
	}

	const resume = item.wave3Resume;
	if (!resume) {
		item.wave3Resume = { step: 'extort_may' };
		const desc = `Extort: Pay {W/B}? If you do, each opponent loses 1 life and you gain that much life (CR 702.101a).`;
		enqueueWave3Prompt(state, item, controller.playerId, {
			kind: 'yesNo',
			purpose: 'trigger_may',
			title: `${item.card.name} — Extort`,
			description: desc,
			yesLabel: 'Pay {W/B}',
			noLabel: 'Decline',
			choice: { kind: 'yesNo', question: desc }
		});
		return 'paused';
	}

	if (resume.step === 'declined') {
		delete item.wave3Resume;
		return 'done';
	}

	if (!resume.extortColor) {
		if (canPayW && canPayB) {
			resume.step = 'extort_color';
			enqueueWave3Prompt(state, item, controller.playerId, {
				kind: 'chooseMode',
				purpose: 'cost_choice',
				title: `${item.card.name} — Pay {W} or {B}`,
				description: 'Choose whether to pay {W} or {B} for Extort:',
				choice: { kind: 'chooseMode', modes: ['Pay {W}', 'Pay {B}'], min: 1, max: 1 }
			});
			return 'paused';
		}
		resume.extortColor = canPayW ? 'W' : 'B';
	}

	const useW = resume.extortColor === 'W';
	const req = useW ? reqW : reqB;
	if (host.payManaWithAutoTap(controller, req, state)) {
		drainOpponents(useW ? '{W}' : '{B}');
	}
	delete item.wave3Resume;
	return 'done';
}

/**
 * Resolves Wave 3 custom stack items (`Madness`, `Cascade`, `Fabricate`, `Extort`, `Ninjutsu`, `Commander ninjutsu`).
 * Returns `'unhandled'` when the item should proceed through the standard IR interpreter.
 */
export function resolveWave3StackItem(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState
): 'unhandled' | 'paused' | 'done' {
	if (item.kind === 'activated' && item.abilityId) {
		const rawId = item.abilityId.replace(/^f\d+:/, '');
		if (rawId.startsWith('ninjutsu_')) {
			resolveNinjutsuStackItem(state, item, controller, false);
			return 'done';
		}
		if (rawId.startsWith('commander_ninjutsu_')) {
			resolveNinjutsuStackItem(state, item, controller, true);
			return 'done';
		}
		return 'unhandled';
	}

	if (item.kind === 'triggered') {
		if (item.grantedKeyword === 'extort') {
			return resolveExtortTrigger(state, item, controller);
		}
		if (item.triggeredAbilityIndex !== undefined && item.triggeredAbilityIndex >= 0) {
			const face = compileCard(item.card).faces[item.faceIndex ?? 0];
			const ab = face?.abilities[item.triggeredAbilityIndex];
			if (ab?.kind === 'keyword') {
				switch (ab.keyword.name) {
					case 'madness':
						return resolveMadnessTrigger(state, item, controller);
					case 'cascade':
						return resolveCascadeTrigger(state, item, controller);
					case 'fabricate':
						return resolveFabricateTrigger(state, item, controller, ab.keyword.n ?? 1);
					case 'extort':
						return resolveExtortTrigger(state, item, controller);
				}
			}
		}
	}

	return 'unhandled';
}

// ---- Plain-Data Prompt Continuation Handler -------------------------------------------------

registerPromptHandler('wave3_keyword', (state: GameState, prompt: PendingPrompt, answer: ChoiceAnswer) => {
	const host = requireHost();
	const cont = prompt.continuation;
	const stackItemId =
		cont?.kind === 'handler' && typeof cont.data?.stackItemId === 'string'
			? cont.data.stackItemId
			: prompt.triggerStackItemId;
	if (!stackItemId) return;
	const item = state.stack.find((s) => s.id === stackItemId);
	if (!item) return;

	const resume = (item.wave3Resume ??= { step: 'declined' });
	const step = resume.step;

	if (step === 'fabricate_choice') {
		resume.step = answer.kind === 'yesNo' && answer.yes ? 'fabricate_counters' : 'fabricate_tokens';
		host.resumeStackItem(state, item);
		return;
	}

	if (step === 'extort_may') {
		resume.step = answer.kind === 'yesNo' && answer.yes ? 'extort_pay' : 'declined';
		host.resumeStackItem(state, item);
		return;
	}

	if (step === 'extort_color') {
		const idx = answer.kind === 'chooseMode' ? (answer.indices[0] ?? 0) : 0;
		resume.extortColor = idx === 1 ? 'B' : 'W';
		resume.step = 'extort_pay';
		host.resumeStackItem(state, item);
		return;
	}

	if (step === 'ask_may') {
		resume.step = answer.kind === 'yesNo' && answer.yes ? 'accepted' : 'declined';
		host.resumeStackItem(state, item);
		return;
	}

	if (step === 'ask_face') {
		const inst = state.players.flatMap((p) => p.exile).find((c) => c.instanceId === resume.cardId);
		if (!inst || answer.kind !== 'chooseMode') {
			resume.step = 'declined';
			host.resumeStackItem(state, item);
			return;
		}
		const card = effectiveCardForObject(inst);
		const candidateFaces =
			card.layout === 'modal_dfc' || card.layout === 'split' || card.layout === 'adventure'
				? [0, 1]
				: [0];
		const cascadeSpellMv = item.triggerEventStackItem
			? objectManaValue(state, item.triggerEventStackItem)
			: objectManaValue(state, item);
		const isCascade = Boolean(resume.exiledIds);
		const controller = state.players.find((p) => p.playerId === item.controllerId);
		const eligibleFaces: number[] = [];
		if (controller) {
			for (const fi of candidateFaces) {
				if (!compileCard(card).faces[fi]) continue;
				const sv = resolveObjectFaces(card, { zone: 'stack', faceIndex: fi });
				if (sv.types.includes('Land')) continue;
				if (isCascade && effectiveManaValue(card, { zone: 'stack', faceIndex: fi }) >= cascadeSpellMv) {
					continue;
				}
				if (buildFaceCastSetup(state, controller, inst, fi, { kind: 'free' })) {
					eligibleFaces.push(fi);
				}
			}
		}
		const chosenIdx = answer.indices[0] ?? 0;
		resume.chosenFaceIndex = eligibleFaces[chosenIdx] ?? eligibleFaces[0] ?? 0;
		resume.step = 'accepted';
		host.resumeStackItem(state, item);
		return;
	}

	if (step === 'ask_x') {
		resume.xValue = answer.kind === 'chooseNumber' ? Math.max(0, answer.n) : 0;
		resume.step = 'accepted';
		host.resumeStackItem(state, item);
		return;
	}

	if (step === 'ask_modes') {
		if (answer.kind !== 'chooseMode') {
			resume.step = 'declined';
		} else {
			resume.chosenModes = [...answer.indices];
			resume.step = 'accepted';
		}
		host.resumeStackItem(state, item);
		return;
	}

	if (step.startsWith('ask_target:')) {
		const sIdx = parseInt(step.slice('ask_target:'.length), 10);
		const inst = state.players.flatMap((p) => p.exile).find((c) => c.instanceId === resume.cardId);
		const controller = state.players.find((p) => p.playerId === item.controllerId);
		if (!inst || !controller) {
			resume.step = 'declined';
			host.resumeStackItem(state, item);
			return;
		}
		const card = effectiveCardForObject(inst);
		const { modal, nonModalSpecs } = getFaceSpellModalAndTargets(card, resume.chosenFaceIndex ?? 0);
		const specs = modal
			? (resume.chosenModes ?? []).flatMap((m) => modal.modes[m]?.targets ?? [])
			: nonModalSpecs;
		const sp = specs[sIdx];
		if (!sp) {
			resume.step = 'declined';
			host.resumeStackItem(state, item);
			return;
		}
		const chosenTargetIds = (resume.chosenTargetIds ??= []);
		const targetKinds = (resume.targetKinds ??= []);
		const cands = host
			.specTargetCandidates(state, controller.playerId, card, inst, sp)
			.filter((c) => {
				if (!sp.otherTarget) return true;
				for (let prev = 0; prev < chosenTargetIds.length; prev++) {
					if (targetKinds[prev] === c.kind && chosenTargetIds[prev] === c.id) return false;
				}
				return true;
			});

		let picked: TargetRef[] = [];
		if (answer.kind === 'chooseObjects') {
			picked = answer.objectIds
				.map((id) => cands.find((c) => c.id === id))
				.filter((c): c is TargetRef => Boolean(c));
		} else if (answer.kind === 'chooseMode') {
			picked = answer.indices
				.map((i) => cands[i])
				.filter((c): c is TargetRef => Boolean(c));
		}
		if (picked.length === 0 && sp.min === 0) {
			chosenTargetIds.push('__NONE__');
			targetKinds.push('none');
		} else {
			for (const p of picked) {
				chosenTargetIds.push(p.id);
				targetKinds.push(p.kind);
			}
			if (picked.length < sp.max) {
				chosenTargetIds.push('__SPEC_END__');
				targetKinds.push('none');
			}
		}
		resume.step = 'accepted';
		host.resumeStackItem(state, item);
		return;
	}

	if (step.startsWith('ask_cost_opt:')) {
		const idx = parseInt(step.slice('ask_cost_opt:'.length), 10);
		const opts = (resume.costOptions ??= []);
		if (answer.kind === 'yesNo') {
			opts[idx] = answer.yes ? 0 : 1;
		} else if (answer.kind === 'chooseMode') {
			opts[idx] = answer.indices[0] ?? 0;
		}
		resume.step = 'accepted';
		host.resumeStackItem(state, item);
		return;
	}

	if (step.startsWith('ask_cost_obj:')) {
		const idx = parseInt(step.slice('ask_cost_obj:'.length), 10);
		const objs = (resume.costObjects ??= []);
		if (answer.kind === 'chooseObjects') {
			objs[idx] = [...answer.objectIds];
		}
		resume.step = 'accepted';
		host.resumeStackItem(state, item);
		return;
	}

	host.resumeStackItem(state, item);
});
