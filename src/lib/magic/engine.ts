import {
	buildTokenScryfallCard,
	createEmptyManaPool,
	canPayManaCost,
	deductManaFromPool,
	describeLibrarySearchDestination,
	matchesLibrarySearchSpec,
	parseLibrarySearchSpec,
	parseManaCost,
	withDelayedTriggerSpec,
	withStackItemText,
	type ManaCostRequirement
} from './oracle.ts';
import {
	checkGlobalCastPermissionsAndRestrictions,
	checkGraveyardReplacementZone,
	evaluatePermanent,
	getCardActivatedAbilities,
	getEffectiveActivatedAbilities as getEffectiveActivatedAbilitiesRaw,
	getLibrarySearchInterceptor,
	getSpellTargetRequirement,
	inspectCardContinuousBreakdown,
	permanentHasLostAllAbilities,
	playerCannotLoseGame,
	playerCannotWinGame,
	targetRequirementFromSpecs,
	type AttributedKeywordOrEffect,
	type CardContinuousBreakdown,
	type EvaluatedPermanent
} from './ruleTree.ts';

export {
	checkGlobalCastPermissionsAndRestrictions,
	checkGraveyardReplacementZone,
	evaluatePermanent,
	getCardActivatedAbilities,
	getLibrarySearchInterceptor,
	getSpellTargetRequirement,
	inspectCardContinuousBreakdown,
	matchesLibrarySearchSpec,
	parseLibrarySearchSpec,
	permanentHasLostAllAbilities,
	playerCannotLoseGame,
	playerCannotWinGame,
	type AttributedKeywordOrEffect,
	type CardContinuousBreakdown,
	type EvaluatedPermanent
};

export function getEffectiveActivatedAbilities(
	state: GameState,
	actor: PlayerGameState,
	perm: CardInstance,
	commanderIdentity: ManaColor[] = []
): EffectiveActivatedAbility[] {
	// Read-only: one layer-cache validation for all of this permanent's ability lookups (Phase 6c).
	return withStableLayerInputs(state, () =>
		getEffectiveActivatedAbilitiesRaw(state, actor, perm, commanderIdentity)
	).map((ab) =>
		ab.id.startsWith('equip_') && ab.manaCost === '{0}' && !ab.costText.includes('{0}')
			? { ...ab, costText: 'Equip {0}' }
			: ab
	);
}
import { STAPLE_CARDS } from './precons.ts';
import {
	applySelfEtbReplacements,
	counterMultiplier,
	getAttackTaxGeneric,
	getAttackTaxSources,
	hasRestriction,
	playerHasHexproofFrom as replacePlayerHasHexproofFrom,
	playerHasNoMaxHandSize,
	playerHasShroud as replacePlayerHasShroud,
	replaceEmptyLibraryDraw,
	spellCannotBeCountered,
	tokenMultiplier
} from './runtime/replace.ts';
import {
	allocateTimestamp,
	createEmptyCounters,
	mulliganRedraw,
	moveObject,
	placeDeferred,
	rearrangeLibrary,
	removeFromGame,
	setZoneOrder,
	shuffleArray,
	shuffleLibrary,
	transferBattlefieldControl
} from './runtime/zones.ts';
import {
	beginAction,
	emitEvent,
	endAction,
	registerEventHandler
} from './runtime/events.ts';
import {
	ALTERNATIVE_COST_KEYWORDS,
	activatedAbilityCost,
	canPayCosts,
	chooseCostPayment,
	effectiveAbilityManaCost,
	effectiveSpellManaCost,
	getSuspendSpec,
	keywordCost,
	keywordsOf,
	manaAbilityAmount,
	payPlannedCosts,
	planCosts,
	spellAdditionalCost,
	spellCastRestrictions,
	type CostContext,
	type CostQuestion
} from './runtime/costs.ts';
export { getSuspendSpec };
import { evaluateAmount, matchesObjectFilter, type FilterContext } from './runtime/objectFilter.ts';
import { compileCard, compiledStackItemEffects, compiledTriggerEffect, compileSpellEffects } from './compiler/index.ts';
import { runtimeTriggers } from './compiler/triggers.ts';
import { noteLayerInputsChanged, withStableLayerInputs } from './runtime/layerCache.ts';
import {
	flushTriggers,
	matchTriggers,
	registerTriggerHost,
	stackTriggerConditionHolds,
	withTriggersDeferred,
	type PendingTrigger
} from './runtime/triggers.ts';
import {
	executeEffectSteps,
	interpretableNow,
	optionalPrefix,
	registerEffectPorts,
	staticallyInterpretable,
	withoutOptional
} from './runtime/effects.ts';
import { botAcceptsOptionalTrigger, chooseBotTriggerTargets } from './ai.ts';
import type { CostDef, EffectStep, TargetSpec, TokenSpec } from './ir.ts';
import { freshRngSeed, type RngHolder } from './runtime/random.ts';
import { cardAbilityDisplayText, enteringNotices, stackItemDisplayText } from './compiler/support.ts';
import {
	buildCostChoiceRequest,
	effectivePromptChoice,
	effectivePromptPurpose,
	inferObjectsZone,
	normalizePromptAction,
	enqueueChoicePrompt,
	registerPromptHandler,
	runPromptHandler,
	validateChoiceAnswer
} from './runtime/choices.ts';

export { allocateTimestamp, shuffleArray };
import {
	ENGINE_VERSION,
	PHASE_LABELS,
	type CardInstance,
	type ChoiceAnswer,
	type CostPayment,
	type CounterType,
	type DelayedTrigger,
	type DelayedTriggerEffect,
	type EffectiveActivatedAbility,
	type GameActionPayload,
	type GameLogEntry,
	type GamePhase,
	type GameState,
	type GuidedOperation,
	type LibrarySearchDestination,
	type LibrarySearchSpec,
	type LobbyRulesConfig,
	type LobbySeat,
	type MagicDeck,
	type ManaColor,
	type ManaPool,
	type PendingPrompt,
	type PlayerGameState,
	type ScryfallCard,
	type StackItem,
	type TriggerEventLki,
	type TargetRef,
	type TargetRequirementInfo,
	type VfxEvent,
	type ZoneType
} from './types.ts';

export { ENGINE_VERSION };

let fallbackUidCounter = 0;

function uid(prefix: string, state?: { nextUid?: number }): string {
	if (state) {
		state.nextUid = (state.nextUid ?? 0) + 1;
		return `${prefix}_${state.nextUid}`;
	}
	fallbackUidCounter += 1;
	return `${prefix}_ext_${fallbackUidCounter}`;
}

let globalInstanceTimestampSeed = 1;

export function createCardInstance(
	card: ScryfallCard,
	ownerId: string,
	zone: ZoneType,
	isCommander = false,
	isToken = false,
	enteredTimestamp?: number,
	uidHolder?: { nextUid?: number }
): CardInstance {
	const counters = createEmptyCounters();
	if (card.loyalty && zone === 'battlefield') {
		counters.loyalty = parseInt(card.loyalty, 10) || 3;
	}
	globalInstanceTimestampSeed += 1;
	return {
		instanceId: uid(isToken ? 'tok' : isCommander ? 'cmd' : 'crd', uidHolder),
		card,
		ownerId,
		controllerId: ownerId,
		zone,
		tapped: false,
		summoningSick: false,
		damageMarked: 0,
		deathtouchDamageMarked: false,
		counters,
		tempPowerMod: 0,
		tempToughnessMod: 0,
		grantedKeywords: [],
		attachedToId: null,
		isToken,
		isCommander,
		commanderCastCount: 0,
		usedLoyaltyThisTurn: false,
		transformed: false,
		enteredTimestamp: enteredTimestamp ?? globalInstanceTimestampSeed,
		objectVersion: 1,
		phasedOut: false,
		isSuspended: false,
		castViaSuspend: false,
		switchedPTCount: 0
	};
}

export function addLog(
	state: GameState,
	kind: GameLogEntry['kind'],
	text: string,
	actorId?: string
): void {
	state.log.push({
		id: uid('log', state),
		timestamp: Date.now(),
		turn: state.turnNumber,
		phase: state.phase,
		actorId,
		kind,
		text
	});
	if (state.log.length > 160) {
		state.log.splice(0, state.log.length - 160);
	}
}

export function emitVfx(state: GameState, event: Omit<VfxEvent, 'id' | 'timestamp'>): void {
	state.recentVfxEvents.push({
		id: uid('vfx', state),
		timestamp: Date.now(),
		...event
	});
	if (state.recentVfxEvents.length > 35) {
		state.recentVfxEvents.splice(0, state.recentVfxEvents.length - 35);
	}
}

export function createInitialGameState(
	lobbyCode: string,
	seats: LobbySeat[],
	decksBySeat: Map<number, MagicDeck>,
	rules: LobbyRulesConfig
): GameState {
	const now = Date.now();
	const activeSeats = seats.filter((s) => s.userId !== null || s.isBot);
	// ENGINE_INVARIANTS.md 7.2: one seed per game; every shuffle and random choice draws from it.
	const rng: RngHolder = { rngState: freshRngSeed() };
	const uidHolder: { nextUid?: number } = { nextUid: 0 };

	const players: PlayerGameState[] = activeSeats.map((seat, idx) => {
		const playerId = seat.userId || `bot_${seat.seatIndex}`;
		const deck = decksBySeat.get(seat.seatIndex)!;

		const command: CardInstance[] = deck.commanders.map((c) =>
			createCardInstance(c, playerId, 'command', true, false, undefined, uidHolder)
		);
		const commanderColorIdentity = Array.from(
			new Set(deck.commanders.flatMap((c) => c.colorIdentity))
		);

		const rawLibrary: CardInstance[] = [];
		for (const entry of deck.cards) {
			for (let q = 0; q < entry.quantity; q++) {
				rawLibrary.push(
					createCardInstance(entry.card, playerId, 'library', false, false, undefined, uidHolder)
				);
			}
		}

		const shuffled = shuffleArray(rng, rawLibrary);
		const hand = shuffled.splice(0, 7).map((c) => ({ ...c, zone: 'hand' as ZoneType }));

		return {
			playerId,
			seatIndex: idx,
			username: seat.username,
			avatarUrl: seat.avatarUrl,
			isBot: seat.isBot,
			life: rules.startingLife,
			poison: 0,
			experienceCounters: 0,
			energyCounters: 0,
			manaPool: createEmptyManaPool(),
			landsPlayedThisTurn: 0,
			maxLandsPerTurn: 1,
			mulliganCount: 0,
			hasKeptHand: seat.isBot, // Bots auto-keep opening hand after smart check
			lost: false,
			commanderDamageTaken: {},
			commanderNames: {},
			commanderCastCounts: {},
			commanderColorIdentity,
			autoPassEmptyStack: true,
			fullControl: false,
			stopPhases: ['main1', 'declare_attackers', 'declare_blockers', 'main2'],
			library: shuffled,
			hand,
			battlefield: [],
			graveyard: [],
			exile: [],
			command
		};
	});

	// Populate global commander map so every player tracks every commander's name and cast count
	const allCommanders: Array<{ id: string; name: string }> = [];
	for (const p of players) {
		for (const c of p.command) {
			allCommanders.push({ id: c.instanceId, name: c.card.name });
			p.commanderCastCounts[c.instanceId] = 0;
		}
	}
	for (const p of players) {
		for (const cmd of allCommanders) {
			p.commanderDamageTaken[cmd.id] = 0;
			p.commanderNames[cmd.id] = cmd.name;
		}
	}

	const state: GameState = {
		engineVersion: ENGINE_VERSION,
		gameId: uid('game', uidHolder),
		lobbyCode,
		status: 'mulligan',
		winnerPlayerId: null,
		rules,
		turnNumber: 1,
		activePlayerIndex: 0,
		priorityPlayerIndex: 0,
		passedPriorityPlayerIds: [],
		phase: 'main1',
		players,
		stack: [],
		combat: {
			active: false,
			attackers: [],
			declaredBlockersPlayerIds: [],
			damageDealtFirstStrike: false,
			damageDealtNormal: false
		},
		pendingPrompts: [],
		rngState: rng.rngState,
		nextUid: uidHolder.nextUid,
		recentVfxEvents: [],
		log: [],
		turnStartedAt: now,
		priorityUpdatedAt: now,
		nextTimestamp: 200,
		delayedTriggers: [],
		extraTurnQueue: [],
		stackTriggersEnabled: false
	};

	// Smart bot opening hand mulligan
	const freeMulligans =
		rules.mulliganRule === 'free_all' || rules.mulliganRule === 'friendly_unlimited'
			? 7
			: rules.mulliganRule === 'london_standard' || rules.mulliganRule === 'strict_london'
				? 0
				: 1;
	for (const p of state.players) {
		if (p.isBot) {
			const landCount = p.hand.filter((c) => c.card.typeLine.includes('Land')).length;
			if (landCount < 2 || landCount > 5) {
				p.mulliganCount += 1;
				mulliganRedraw(state, p, { emit: false });
				const toBottom = Math.max(0, p.mulliganCount - freeMulligans);
				for (let b = 0; b < toBottom && p.hand.length > 0; b++) {
					moveObject(state, p.hand[p.hand.length - 1], 'library', {
						from: { player: p, zone: 'hand' },
						toPlayer: p,
						insert: 'end',
						emit: false
					});
				}
			}
			p.hasKeptHand = true;
		} else {
			const description =
				rules.mulliganRule === 'friendly_unlimited'
					? 'Friendly Mulligan: You may keep your 7-card hand or take a free 7-card mulligan.'
					: 'London Mulligan: Your first mulligan in Commander is free (7 cards). Subsequent mulligans put 1 card per extra mulligan on the bottom of your library.';
			state.pendingPrompts.push({
				id: uid('prm', state),
				playerId: p.playerId,
				kind: 'mulligan',
				purpose: 'mulligan',
				title: 'Opening Hand Mulligan',
				description,
				choice: { kind: 'yesNo', question: description }
			});
		}
	}

	addLog(
		state,
		'system',
		`Commander pod started (${players.length} players, ${rules.startingLife} starting life, ${rules.commanderDamageLethal || 'Off'} cmdr lethal).`
	);

	checkIfAllKeptMulligan(state);
	return state;
}

function checkIfAllKeptMulligan(state: GameState): void {
	if (state.status !== 'mulligan') return;
	const anyMulliganPrompts = state.pendingPrompts.some(
		(pr) => pr.kind === 'mulligan' || pr.kind === 'london_bottom'
	);
	if (anyMulliganPrompts) return;

	if (state.players.every((p) => p.hasKeptHand)) {
		state.status = 'active';
		state.turnNumber = 1;
		state.activePlayerIndex = 0;
		state.priorityPlayerIndex = 0;
		addLog(state, 'system', `All players kept their opening hands. Turn 1 begins for ${state.players[0].username}!`);
		runBeginningOfTurn(state);
		if (state.status === 'active' && state.stack.length === 0 && state.pendingPrompts.length === 0) {
			advancePhaseOrStep(state);
		}
		if (state.status === 'active' && state.stack.length === 0 && state.pendingPrompts.length === 0) {
			advancePhaseOrStep(state);
		}
	}
}

export function getCreaturePower(inst: CardInstance, state: GameState): number {
	const breakdown = inspectCardContinuousBreakdown(inst, state);
	if (breakdown.effectivePower !== null) {
		return breakdown.effectivePower;
	}
	const rawP = parseInt(inst.card.power || '0', 10);
	let base = isNaN(rawP) ? 0 : rawP;
	base += (inst.counters['+1/+1'] || 0) - (inst.counters['-1/-1'] || 0) + inst.tempPowerMod;
	return Math.max(0, base);
}

export function getCreatureToughness(inst: CardInstance, state: GameState): number {
	const breakdown = inspectCardContinuousBreakdown(inst, state);
	if (breakdown.effectiveToughness !== null) {
		return breakdown.effectiveToughness;
	}
	const rawT = parseInt(inst.card.toughness || '0', 10);
	let base = isNaN(rawT) ? 0 : rawT;
	base += (inst.counters['+1/+1'] || 0) - (inst.counters['-1/-1'] || 0) + inst.tempToughnessMod;
	return Math.max(0, base);
}

export function hasKeyword(inst: CardInstance, keyword: string, state: GameState): boolean {
	const kwLow = keyword.toLowerCase();
	const breakdown = inspectCardContinuousBreakdown(inst, state);
	return breakdown.items.some(
		(it) =>
			!it.removed &&
			(it.canonicalKey === kwLow ||
				it.name.toLowerCase() === kwLow ||
				(kwLow === 'ward' && it.canonicalKey === 'ward'))
	);
}

export function getPlayerCommanderIdentity(player: PlayerGameState): ManaColor[] {
	const set = new Set<ManaColor>(player.commanderColorIdentity ?? []);
	const allCards = [
		...player.command,
		...player.battlefield.filter((c) => c.isCommander && c.ownerId === player.playerId),
		...player.graveyard.filter((c) => c.isCommander && c.ownerId === player.playerId),
		...player.exile.filter((c) => c.isCommander && c.ownerId === player.playerId),
		...player.hand.filter((c) => c.isCommander && c.ownerId === player.playerId),
		...player.library.filter((c) => c.isCommander && c.ownerId === player.playerId)
	];
	for (const c of allCards) {
		for (const col of c.card.colorIdentity) set.add(col);
	}
	return Array.from(set);
}

function isOverloadCastMode(
	card: ScryfallCard | undefined,
	xValue = 0,
	castMode?: 'normal' | 'overload'
): boolean {
	if (!card) return false;
	const hasOverload =
		Boolean(ALTERNATIVE_COST_KEYWORDS.overload) && keywordCost(card, 'overload') !== null;
	if (!hasOverload) return false;
	if (castMode === 'overload') return true;
	if (castMode === 'normal') return false;
	return xValue >= 1 && !/\{X\}/i.test(card.manaCost);
}

export function getSpellCostRequirement(
	player: PlayerGameState,
	inst: CardInstance,
	state: GameState,
	xValue = 0,
	castMode?: 'normal' | 'overload'
): ManaCostRequirement {
	const applyAnyColorPermission = (req: ManaCostRequirement): ManaCostRequirement => {
		if (
			inst.zone === 'exile' &&
			inst.playableFromExileBy?.playerId === player.playerId &&
			inst.playableFromExileBy.spendManaAsAnyColor
		) {
			const coloredTotal =
				req.colored.W + req.colored.U + req.colored.B + req.colored.R + req.colored.G;
			if (coloredTotal > 0) {
				return {
					...req,
					colored: { W: 0, U: 0, B: 0, R: 0, G: 0, C: req.colored.C },
					generic: req.generic + coloredTotal
				};
			}
		}
		return req;
	};

	const isOverload = isOverloadCastMode(inst.card, xValue, castMode);
	return applyAnyColorPermission(effectiveSpellManaCost(state, player, inst, xValue, isOverload));
}

export function chooseBotSpellCostPayment(
	state: GameState,
	player: PlayerGameState,
	inst: CardInstance,
	xValue = 0,
	castMode?: 'normal' | 'overload'
): CostPayment | undefined {
	const additional = spellAdditionalCost(inst.card);
	if (!additional || additional.defs.length === 0) return undefined;
	const costReq = getSpellCostRequirement(player, inst, state, xValue, castMode);
	return chooseCostPayment(costContext(state, player, inst, xValue, true, costReq), additional.defs) ?? undefined;
}

/**
 * The amount a mana ability adds. Dynamic amounts ("for each Elf you control", "equal to ~'s power")
 * come from the IR (Phase 4); otherwise the legacy amount. A count of zero adds no mana.
 */
function getDynamicManaProducedAmount(
	state: GameState,
	player: PlayerGameState,
	perm: CardInstance,
	baseAmount: number,
	ab?: EffectiveActivatedAbility
): number {
	const evalPerm = evaluatePermanent(state, perm);
	if (evalPerm.losesAllAbilities) return baseAmount;
	const pCard = perm.copiableCard ?? perm.card;
	const fallback = { id: 'mana_tap' } as EffectiveActivatedAbility;
	const amount = manaAbilityAmount(pCard, ab ?? fallback);
	if (!amount) return baseAmount;
	return Math.max(0, evaluateAmount(amount, { state, controllerId: player.playerId, source: perm }));
}

/** Builds the context runtime/costs.ts pays costs in. */
function costContext(
	state: GameState,
	player: PlayerGameState,
	source: CardInstance,
	xValue: number,
	isSpell: boolean,
	baseMana: ManaCostRequirement | null
): CostContext {
	return {
		state,
		player,
		source,
		xValue,
		isSpell,
		baseMana,
		canPayMana: (req) => canPayOrAutoTap(player, req, state),
		payMana: (req) => payManaWithAutoTap(player, req, state)
	};
}

/**
 * A cost needs the player's choice. Humans get a `cost_choice` prompt holding the action, which is
 * run again with the answer; bots must send their choices (ai.ts), so for them it's an error.
 */
function askCostChoice(
	state: GameState,
	actor: PlayerGameState,
	action: GameActionPayload,
	question: CostQuestion,
	sourceName: string
): { ok: boolean; error?: string } {
	if (actor.isBot) {
		return { ok: false, error: `A cost choice is required to pay for ${sourceName}.` };
	}
	const zone =
		question.kind === 'objects' ? inferObjectsZone(actor, question.candidateIds) : 'battlefield';
	const choice = buildCostChoiceRequest(question, zone);
	state.pendingPrompts.push({
		id: uid('prm', state),
		playerId: actor.playerId,
		kind: 'cost_choice',
		purpose: 'cost_choice',
		title: `Pay the cost of ${sourceName}`,
		description:
			question.kind === 'option'
				? question.optional
					? 'This cost is optional. Pay it?'
					: 'Choose which cost to pay.'
				: `Choose ${question.count}: ${question.label}.`,
		choice,
		cancellable: true,
		yesLabel:
			question.kind === 'option' && question.optional
				? question.labels[0] || 'Pay Cost'
				: undefined,
		noLabel: question.kind === 'option' && question.optional ? "Don't Pay" : undefined,
		countRequired: question.kind === 'objects' ? question.count : undefined,
		candidateInstanceIds: question.kind === 'objects' ? question.candidateIds : undefined,
		costQuestion: { kind: question.kind, index: question.index },
		costOptionLabels: question.kind === 'option' ? question.labels : undefined,
		pendingAction: action
	});
	return { ok: true };
}

/** Mana abilities whose whole cost is {T}: the ones auto-tapping may use (never a sacrifice). */
function tapOnlyManaAbilities(
	state: GameState,
	player: PlayerGameState,
	perm: CardInstance,
	cmdIdentity: ManaColor[]
): EffectiveActivatedAbility[] {
	return getEffectiveActivatedAbilities(state, player, perm, cmdIdentity).filter(
		(a) =>
			a.isManaAbility &&
			a.producesMana.length > 0 &&
			activatedAbilityCost(perm.card, a).defs.every(
				(d) => d.k === 'tapSelf' || (d.k === 'mana' && /^(\{0\})*$/.test(d.cost))
			)
	);
}

function simulateOrExecuteAutoTap(
	player: PlayerGameState,
	req: ManaCostRequirement,
	state: GameState,
	mutate: boolean
): boolean {
	if (canPayManaCost(player.manaPool, req)) {
		if (mutate) {
			player.manaPool = deductManaFromPool(player.manaPool, req);
		}
		return true;
	}

	const pool: ManaPool = { ...player.manaPool };
	const cmdIdentity = getPlayerCommanderIdentity(player);

	const getProducedAmount = (perm: CardInstance, prodAmount: number): number =>
		getDynamicManaProducedAmount(state, player, perm, prodAmount);
	const tapOnly = new Map<string, EffectiveActivatedAbility[]>();
	const manaAbilitiesOf = (perm: CardInstance) => {
		let abs = tapOnly.get(perm.instanceId);
		if (!abs) {
			abs = tapOnlyManaAbilities(state, player, perm, cmdIdentity);
			tapOnly.set(perm.instanceId, abs);
		}
		return abs;
	};

	// Sort untapped mana sources: most-constrained (fewest colors) first, and non-creatures before creatures
	// Read-only scan: validate the layer cache once (Phase 6c).
	const candidates = withStableLayerInputs(state, () =>
		player.battlefield
			.filter((perm) => {
				if (perm.phasedOut || perm.tapped) return false;
				const evalPerm = evaluatePermanent(state, perm);
				if (
					evalPerm.isCreature &&
					perm.summoningSick &&
					!hasKeyword(perm, 'Haste', state)
				) {
					return false;
				}
				return manaAbilitiesOf(perm).length > 0;
			})
			.sort((a, b) => {
				const ca = manaAbilitiesOf(a)[0]?.producesMana ?? [];
				const cb = manaAbilitiesOf(b)[0]?.producesMana ?? [];
				if (ca.length !== cb.length) {
					return ca.length - cb.length;
				}
				const aIsCreature = evaluatePermanent(state, a).isCreature ? 1 : 0;
				const bIsCreature = evaluatePermanent(state, b).isCreature ? 1 : 0;
				return aIsCreature - bIsCreature;
			})
	);

	const tappedSet = new Set<string>();
	const manaChoices = new Map<string, { color: ManaColor; amount: number }>();

	// Pass 1: Satisfy missing colored mana pips using the most-constrained sources first
	for (const col of ['W', 'U', 'B', 'R', 'G', 'C'] as ManaColor[]) {
		const flexCountForCol =
			req.flexibleSymbols?.filter((s) => s.primaryColor === col).length ?? 0;
		while (pool[col] < req.colored[col]) {
			const perm = candidates.find((c) => {
				if (tappedSet.has(c.instanceId)) return false;
				return manaAbilitiesOf(c).some((a) => a.producesMana.includes(col));
			});
			if (!perm) {
				if (req.colored[col] - pool[col] <= flexCountForCol) {
					break;
				}
				return false;
			}
			const matchedAb = manaAbilitiesOf(perm).find((a) => a.producesMana.includes(col));
			const baseAmt = Math.max(1, matchedAb?.producesAmount || 1);
			const amount = getProducedAmount(perm, baseAmt);
			tappedSet.add(perm.instanceId);
			pool[col] += amount;
			manaChoices.set(perm.instanceId, { color: col, amount });
		}
	}

	let effectiveReq = req;
	let phyrexianLifeToPay = 0;

	// Pass 2: Satisfy remaining generic / flexible mana cost using remaining untapped sources
	while (!canPayManaCost(pool, effectiveReq)) {
		const perm = candidates.find((c) => !tappedSet.has(c.instanceId));
		if (!perm) {
			// Check if unpaid Phyrexian mana symbols ({W/P}, {U/P}, etc.) can be paid with 2 life each (CR 107.4f)
			const phySymbols = effectiveReq.flexibleSymbols?.filter((s) => s.altLife) ?? [];
			if (phySymbols.length > 0 && !player.lifeTotalCannotChangeThisTurn) {
				let foundLifePlan = false;
				const nextColored = { ...effectiveReq.colored };
				const remainingFlex = [...(effectiveReq.flexibleSymbols ?? [])];
				let lifeNeeded = 0;
				for (const sym of phySymbols) {
					if (nextColored[sym.primaryColor] > 0) {
						nextColored[sym.primaryColor] -= 1;
						lifeNeeded += sym.altLife ?? 2;
						const fIdx = remainingFlex.indexOf(sym);
						if (fIdx >= 0) remainingFlex.splice(fIdx, 1);
						const candidateReq: ManaCostRequirement = {
							...effectiveReq,
							colored: { ...nextColored },
							flexibleSymbols: remainingFlex.length > 0 ? [...remainingFlex] : undefined
						};
						if (canPayManaCost(pool, candidateReq) && player.life >= lifeNeeded) {
							effectiveReq = candidateReq;
							phyrexianLifeToPay = lifeNeeded;
							foundLifePlan = true;
							break;
						}
					}
				}
				if (foundLifePlan) break;
			}
			return false;
		}
		const ab0 = manaAbilitiesOf(perm)[0];
		const chosenColor: ManaColor = ab0?.producesMana[0] || 'C';
		const baseAmt = Math.max(1, ab0?.producesAmount || 1);
		const amount = getProducedAmount(perm, baseAmt);
		tappedSet.add(perm.instanceId);
		pool[chosenColor] += amount;
		manaChoices.set(perm.instanceId, { color: chosenColor, amount });
	}

	if (mutate) {
		for (const perm of candidates) {
			const choice = manaChoices.get(perm.instanceId);
			if (choice) {
				perm.tapped = true;
				player.manaPool[choice.color] += choice.amount;
			}
		}
		player.manaPool = deductManaFromPool(player.manaPool, effectiveReq);
		if (phyrexianLifeToPay > 0) {
			player.life -= phyrexianLifeToPay;
		}
	}

	return true;
}

export function canPayOrAutoTap(
	player: PlayerGameState,
	req: ManaCostRequirement,
	state: GameState
): boolean {
	return simulateOrExecuteAutoTap(player, req, state, false);
}

export function payManaWithAutoTap(
	player: PlayerGameState,
	req: ManaCostRequirement,
	state: GameState
): boolean {
	return simulateOrExecuteAutoTap(player, req, state, true);
}

export function winTheGame(state: GameState, player: PlayerGameState, reason: string): boolean {
	if (state.status === 'finished' || player.lost) return false;
	const winCheck = playerCannotWinGame(state, player);
	if (winCheck.blocked) {
		addLog(
			state,
			'rule',
			`${player.username}'s win condition (${reason}) was prevented by ${winCheck.sourceName}!`,
			player.playerId
		);
		return false;
	}
	state.status = 'finished';
	state.winnerPlayerId = player.playerId;
	for (const other of state.players) {
		if (other.playerId !== player.playerId) {
			other.lost = true;
			other.lossReason = `${player.username} won the game (${reason}).`;
		}
	}
	addLog(state, 'system', `${player.username} wins the game! (${reason})`, player.playerId);
	emitVfx(state, {
		kind: 'victory',
		sourceId: player.playerId,
		label: `${player.username} Wins!`
	});
	return true;
}

export function loseTheGame(state: GameState, player: PlayerGameState, reason: string): boolean {
	if (player.lost || state.status === 'finished') return false;
	const lossLock = playerCannotLoseGame(state, player);
	if (lossLock.protected) {
		addLog(
			state,
			'rule',
			`${player.username} cannot lose the game (${reason}) due to ${lossLock.sourceName}!`,
			player.playerId
		);
		return false;
	}
	player.lost = true;
	player.lossReason = reason;
	addLog(state, 'sba', `${player.username} loses the game! (${reason})`, player.playerId);
	cleanupEliminatedPlayer(state, player);
	checkStateBasedActions(state);
	return true;
}

export function drawCards(
	state: GameState,
	player: PlayerGameState,
	count: number,
	deferSba = false
): void {
	for (let i = 0; i < count; i++) {
		if (player.library.length === 0) {
			// Check Replacement Effect: Laboratory Maniac ("If you would draw a card while your library has no cards in it, you win the game instead.")
			const replaced = replaceEmptyLibraryDraw(state, player);
			if (replaced.replaced) {
				if (replaced.winsGame) {
					winTheGame(
						state,
						player,
						`${replaced.sourceName ?? 'Replacement Effect'} (drew from an empty library)`
					);
				}
				return;
			}
			// CR 104.3c / 704.5b: Attempting to draw from an empty library sets a flag checked by SBAs.
			player.attemptedEmptyLibraryDraw = true;
			if (!deferSba) {
				checkStateBasedActions(state);
			}
			return;
		}
		moveObject(state, player.library[0], 'hand', {
			from: { player, zone: 'library' },
			toPlayer: player,
			newTimestamp: true,
			bumpVersion: true
		});
	}
}

export function emptyAllPlayersManaPools(state: GameState): void {
	for (const p of state.players) {
		p.manaPool = createEmptyManaPool();
	}
}

function executeUntapTurnBasedActions(state: GameState, activePlayer: PlayerGameState): void {
	activePlayer.landsPlayedThisTurn = 0;
	activePlayer.maxLandsPerTurn = 1;

	// CR 502.1 & CR 702.26a/g: Before untapping, phasing in and phasing out happen simultaneously!
	// 1. Collect all permanents that will phase in:
	//    - activePlayer's directly phased-out permanents
	//    - any indirectly phased-out attachments across ALL players' battlefields attached to a permanent phasing in (CR 702.26g)
	const phasingInIds = new Set<string>();
	for (const perm of activePlayer.battlefield) {
		if (perm.phasedOut && !perm.phasedOutIndirectly) {
			phasingInIds.add(perm.instanceId);
		}
	}
	let addedPhaseIn = true;
	while (addedPhaseIn) {
		addedPhaseIn = false;
		for (const p of state.players) {
			for (const perm of p.battlefield) {
				if (
					perm.phasedOut &&
					perm.phasedOutIndirectly &&
					perm.attachedToId &&
					phasingInIds.has(perm.attachedToId) &&
					!phasingInIds.has(perm.instanceId)
				) {
					phasingInIds.add(perm.instanceId);
					addedPhaseIn = true;
				}
			}
		}
	}

	// 2. Collect all currently phased-in permanents that will phase out:
	//    - activePlayer's phased-in permanents with the Phasing keyword (CR 702.26a)
	//    - any phased-in attachments across ALL players' battlefields attached to a permanent phasing out (indirectly)
	const phasingOutDirectIds = new Set<string>();
	const phasingOutIndirectIds = new Set<string>();
	// Read-only scan: validate the layer cache once (Phase 6d).
	withStableLayerInputs(state, () => {
		for (const perm of activePlayer.battlefield) {
			if (!perm.phasedOut && hasKeyword(perm, 'Phasing', state)) {
				phasingOutDirectIds.add(perm.instanceId);
			}
		}
	});
	let addedPhaseOut = true;
	while (addedPhaseOut) {
		addedPhaseOut = false;
		for (const p of state.players) {
			for (const perm of p.battlefield) {
				if (
					!perm.phasedOut &&
					perm.attachedToId &&
					(phasingOutDirectIds.has(perm.attachedToId) ||
						phasingOutIndirectIds.has(perm.attachedToId)) &&
					!phasingOutDirectIds.has(perm.instanceId) &&
					!phasingOutIndirectIds.has(perm.instanceId)
				) {
					phasingOutIndirectIds.add(perm.instanceId);
					addedPhaseOut = true;
				}
			}
		}
	}

	// 3. Apply phasing in and phasing out simultaneously
	const phasedInNames: string[] = [];
	const phasedOutNames: string[] = [];
	for (const p of state.players) {
		for (const perm of p.battlefield) {
			if (phasingInIds.has(perm.instanceId)) {
				perm.phasedOut = false;
				perm.phasedOutIndirectly = false;
				phasedInNames.push(perm.card.name);
			} else if (phasingOutDirectIds.has(perm.instanceId)) {
				perm.phasedOut = true;
				perm.phasedOutIndirectly = false;
				phasedOutNames.push(perm.card.name);
			} else if (phasingOutIndirectIds.has(perm.instanceId)) {
				perm.phasedOut = true;
				perm.phasedOutIndirectly = true;
				phasedOutNames.push(perm.card.name);
			}
		}
	}
	if (phasedInNames.length > 0) {
		addLog(
			state,
			'rule',
			`Phasing (CR 702.26): ${phasedInNames.join(', ')} phased in for ${activePlayer.username}.`,
			activePlayer.playerId
		);
	}
	if (phasedOutNames.length > 0) {
		addLog(
			state,
			'rule',
			`Phasing (CR 702.26): ${phasedOutNames.join(', ')} phased out for ${activePlayer.username}.`,
			activePlayer.playerId
		);
	}

	// 4. Untap step (CR 502.3 & CR 122.1d stun counter replacement)
	// CR 502.3: the active player's permanents untap simultaneously, so which ones "don't untap" is
	// decided against the board before any of them untaps. Deciding it inside the untap loop made
	// every `perm.tapped = false` invalidate the layer cache for the next permanent's check, a full
	// board re-evaluation per permanent (Phase 6d).
	const keptTapped = withStableLayerInputs(state, () => {
		const ids = new Set<string>();
		for (const perm of activePlayer.battlefield) {
			if (perm.phasedOut || !perm.tapped) continue;
			if (hasRestriction(state, perm, 'doesntUntap')) ids.add(perm.instanceId);
		}
		return ids;
	});
	for (const perm of activePlayer.battlefield) {
		if (perm.phasedOut) continue;
		if (perm.tapped && !keptTapped.has(perm.instanceId)) {
			if (perm.counters.stun > 0) {
				perm.counters.stun -= 1;
			} else {
				perm.tapped = false;
			}
		}
		perm.summoningSick = false;
		perm.usedLoyaltyThisTurn = false;
	}
}

function executeDrawTurnBasedAction(state: GameState, activePlayer: PlayerGameState): void {
	const shouldSkipFirstDraw =
		state.turnNumber === 1 &&
		state.activePlayerIndex === 0 &&
		state.players.length === 2 &&
		!state.rules.firstTurnDraw;
	if (!shouldSkipFirstDraw) {
		drawCards(state, activePlayer, 1);
		if (state.status === 'finished') return;
		addLog(
			state,
			'rule',
			`${activePlayer.username} untaps and draws a card for Turn ${state.turnNumber}.`,
			activePlayer.playerId
		);
	} else {
		addLog(
			state,
			'rule',
			`${activePlayer.username} skips the Turn 1 draw step (1v1 rule).`,
			activePlayer.playerId
		);
	}
}

export function runBeginningOfTurn(state: GameState): void {
	const activePlayer = state.players[state.activePlayerIndex];
	if (!activePlayer || activePlayer.lost) return;

	// Clear "until your next turn" effects (e.g., Teferi's Protection)
	activePlayer.cannotLoseGameThisTurn = false;
	activePlayer.lifeTotalCannotChangeThisTurn = false;
	activePlayer.protectionFromEverythingThisTurn = false;
	activePlayer.preventAllCombatDamageThisTurn = false;
	activePlayer.spellsCastThisTurn = 0;

	// 1. Untap step (CR 502): turn-based actions execute before PhaseBegin('untap') triggers (CR 703.3)
	beginPhase(state, 'untap', activePlayer);
	emptyAllPlayersManaPools(state);

	// 2. Upkeep step (CR 503): active player receives priority in upkeep (CR 503.1a / 500.2)
	beginPhase(state, 'upkeep', activePlayer);
	state.priorityPlayerIndex = state.activePlayerIndex;
	state.passedPriorityPlayerIds = [];
	state.turnStartedAt = Date.now();
	state.priorityUpdatedAt = Date.now();
	emitVfx(state, {
		kind: 'phase_change',
		label: `Turn ${state.turnNumber}: ${activePlayer.username} — Upkeep`
	});
	checkStateBasedActions(state);
}

/**
 * Applies one player action. Events emitted while it runs are dispatched synchronously and the
 * queue is drained when the outermost call returns (see runtime/events.ts).
 */
export function applyGameAction(
	state: GameState,
	actorId: string,
	action: GameActionPayload
): { ok: boolean; error?: string } {
	beginAction(state);
	try {
		const res = applyGameActionInner(state, actorId, action);
		// Pending triggers live outside GameState (runtime/triggers.ts); none may outlive the action,
		// or the lobby server's JSON round trip would drop them. Normally already flushed.
		flushTriggers(state);
		return res;
	} finally {
		endAction(state);
	}
}

function applyGameActionInner(
	state: GameState,
	actorId: string,
	action: GameActionPayload
): { ok: boolean; error?: string } {
	if (state.status === 'finished') {
		return { ok: false, error: 'Game has already finished.' };
	}

	if (state.engineVersion !== undefined && state.engineVersion !== ENGINE_VERSION) {
		state.status = 'finished';
		addLog(
			state,
			'system',
			`Match ended: game state engineVersion (${state.engineVersion}) is incompatible with current engineVersion (${ENGINE_VERSION}).`
		);
		return {
			ok: false,
			error: `Match ended due to incompatible engineVersion (${state.engineVersion} vs ${ENGINE_VERSION}).`
		};
	}

	const actor = state.players.find((p) => p.playerId === actorId);
	if (!actor) {
		return { ok: false, error: 'Player is not seated in this game.' };
	}

	// Handle Concede anytime
	if (action.type === 'concede') {
		actor.lost = true;
		actor.lossReason = 'Conceded the match.';
		addLog(state, 'system', `${actor.username} conceded the game.`, actorId);
		cleanupEliminatedPlayer(state, actor);
		checkStateBasedActions(state);
		return { ok: true };
	}

	// Handle UI toggles anytime
	if (action.type === 'toggle_full_control') {
		actor.fullControl = action.enabled;
		return { ok: true };
	}
	if (action.type === 'toggle_stop_phase') {
		const idx = actor.stopPhases.indexOf(action.phase);
		if (idx >= 0) {
			actor.stopPhases.splice(idx, 1);
		} else {
			actor.stopPhases.push(action.phase);
		}
		return { ok: true };
	}

	// Handle Mulligan Phase actions
	if (state.status === 'mulligan') {
		return handleMulliganAction(state, actor, action);
	}

	// Check if there is a blocking PendingPrompt for this player
	const promptIdx = state.pendingPrompts.findIndex((p) => p.playerId === actorId);
	if (promptIdx >= 0) {
		return handlePromptResolution(state, actor, promptIdx, action);
	}

	if (state.pendingPrompts.length > 0) {
		const waitingOn = state.players.find((p) => p.playerId === state.pendingPrompts[0].playerId);
		return {
			ok: false,
			error: `Waiting for ${waitingOn?.username || 'another player'} to resolve ${state.pendingPrompts[0].title}.`
		};
	}

	const activePlayer = state.players[state.activePlayerIndex];
	const priorityPlayer = state.players[state.priorityPlayerIndex];

	switch (action.type) {
		case 'resolve_manually': {
			// Step E2 escape hatch: apply any ability of a card by hand (guided operations). It needs
			// priority and never uses the stack.
			if (priorityPlayer?.playerId !== actor.playerId) {
				return { ok: false, error: 'You can resolve an ability manually only while you have priority.' };
			}
			const found = findCardAnywhere(state, action.instanceId);
			const mine = found && (found.zone === 'battlefield' ? found.inst.controllerId === actor.playerId : found.inst.ownerId === actor.playerId);
			if (!found || !mine) return { ok: false, error: 'Choose a card you control.' };
			const card = found.inst.copiableCard ?? found.inst.card;
			const text = cardAbilityDisplayText(card, action.abilityIndex);
			enqueueChoicePrompt(state, {
				id: uid('prm', state),
				playerId: actor.playerId,
				kind: 'guided_resolution',
				purpose: 'guided_resolution',
				title: `Resolve Manually: ${card.name}`,
				description: text,
				yesLabel: 'Done',
				cancellable: true,
				continuation: { kind: 'manual_ability', sourceInstanceId: found.inst.instanceId },
				choice: { kind: 'yesNo', question: `Apply ${card.name}'s ability with the operations below.` }
			});
			addLog(state, 'rule', `${actor.username} is resolving an ability of ${card.name} manually.`, actor.playerId);
			return { ok: true };
		}
		case 'tap_mana': {
			const perm = actor.battlefield.find((c) => c.instanceId === action.instanceId);
			if (!perm || perm.phasedOut) {
				return { ok: false, error: 'Permanent not found on your battlefield.' };
			}
			const evalPerm = evaluatePermanent(state, perm);
			const cmdId = getPlayerCommanderIdentity(actor);
			const manaAbs = getEffectiveActivatedAbilities(state, actor, perm, cmdId).filter((a) => a.isManaAbility);
			if (manaAbs.length === 0) {
				return { ok: false, error: `${perm.card.name} does not have an active mana ability.` };
			}
			const preferred = action.preferredColor;
			const ab =
				(preferred && manaAbs.find((a) => a.producesMana.includes(preferred))) ||
				manaAbs.find((a) => a.producesMana.length > 0) ||
				manaAbs[0];
			const chosenColor: ManaColor | undefined =
				preferred && ab.producesMana.includes(preferred) ? preferred : ab.producesMana[0];

			// Phase 4: the ability's whole cost from the IR ({T}, and e.g. "Sacrifice this artifact").
			const cost = activatedAbilityCost(perm.card, ab);
			const ctx = costContext(state, actor, perm, 0, false, parseManaCost(ab.manaCost === '{0}' ? '' : ab.manaCost));
			const plan = planCosts(ctx, cost.defs, action.costPayment);
			if (!plan.ok) return { ok: false, error: plan.error };
			if (plan.question) return askCostChoice(state, actor, action, plan.question, perm.card.name);

			const baseAmount = evalPerm.losesAllAbilities ? 1 : Math.max(1, ab.producesAmount);
			const amount = chosenColor ? getDynamicManaProducedAmount(state, actor, perm, baseAmount, ab) : 0;

			const paid = payPlannedCosts(ctx, plan);
			if (chosenColor && amount > 0) {
				actor.manaPool[chosenColor] += amount;
			}
			// CR 605.1b: triggered mana abilities ("Whenever you tap a land for mana") resolve now.
			emitEvent(state, { kind: 'TappedForMana', playerId: actorId, objectId: perm.instanceId, object: perm });
			flushTriggers(state);
			if (paid.descriptions.length > 0 || cost.defs.some((d) => d.k === 'sacrifice' && d.filter === 'self')) {
				addLog(
					state,
					'rule',
					chosenColor && amount > 0
						? `${actor.username} activated ${perm.card.name} for ${amount > 1 ? `${amount}x ` : ''}{${chosenColor}}${paid.descriptions.length > 0 ? ` (${paid.descriptions.join('; ')})` : ''}.`
						: `${actor.username} activated ${perm.card.name} for no mana (CR 106.5)${paid.descriptions.length > 0 ? ` (${paid.descriptions.join('; ')})` : ''}.`,
					actorId
				);
			}
			return { ok: true };
		}

		case 'play_land': {
			let landInst: CardInstance | undefined;
			let sourcePlayer: PlayerGameState = actor;
			let sourceZone: 'hand' | 'exile' = 'hand';

			const handIdx = actor.hand.findIndex((c) => c.instanceId === action.instanceId);
			if (handIdx >= 0) {
				landInst = actor.hand[handIdx];
				sourcePlayer = actor;
				sourceZone = 'hand';
			} else {
				for (const p of state.players) {
					const exIdx = p.exile.findIndex(
						(c) => c.instanceId === action.instanceId && c.playableFromExileBy?.playerId === actorId
					);
					if (exIdx >= 0) {
						landInst = p.exile[exIdx];
						sourcePlayer = p;
						sourceZone = 'exile';
						break;
					}
				}
			}

			if (!landInst) {
				return { ok: false, error: 'Land card not found in your hand or playable Exile.' };
			}

			const landLegality = checkLandPlayLegality(state, actorId, landInst, sourceZone);
			if (!landLegality.ok) {
				return landLegality;
			}

			const exSourceName = landInst.playableFromExileBy?.sourceName;
			landInst.playableFromExileBy = undefined;
			landInst.tapped = false;
			applySelfEtbReplacements(state, landInst);
			moveObject(state, landInst, 'battlefield', {
				from: { player: sourcePlayer, zone: sourceZone },
				toPlayer: actor,
				controllerId: actorId,
				newTimestamp: true,
				bumpVersion: true
			});
			actor.landsPlayedThisTurn += 1;
			state.passedPriorityPlayerIds = [];

			addLog(
				state,
				'rule',
				`${actor.username} played ${landInst.card.name}${sourceZone === 'exile' ? ` from Exile (${exSourceName || 'Exile Permission'})` : ''}.`,
				actorId
			);

			flushTriggers(state);

			checkStateBasedActions(state);
			return { ok: true };
		}

		case 'suspend_card': {
			const handIdx = actor.hand.findIndex((c) => c.instanceId === action.instanceId);
			if (handIdx < 0) {
				return { ok: false, error: 'Card not found in your hand to Suspend.' };
			}
			const inst = actor.hand[handIdx];
			const legality = checkSuspendLegality(state, actorId, inst);
			if (!legality.ok) {
				return legality;
			}
			const suspClause = getSuspendSpec(inst.card)!;
			const req = parseManaCost(suspClause.suspendCost);
			if (!payManaWithAutoTap(actor, req, state)) {
				return {
					ok: false,
					error: `Insufficient mana to pay Suspend cost ${suspClause.suspendCost} for ${inst.card.name}.`
				};
			}

			inst.isSuspended = true;
			inst.counters = createEmptyCounters();
			inst.counters.time = suspClause.timeCounters;
			moveObject(state, inst, 'exile', {
				from: { player: actor, zone: 'hand' },
				toPlayer: actor,
				newTimestamp: true,
				bumpVersion: true
			});
			state.passedPriorityPlayerIds = [];

			addLog(
				state,
				'rule',
				`Suspend (CR 702.62): ${actor.username} exiled ${inst.card.name} from hand with ${suspClause.timeCounters} time counter(s) for ${suspClause.suspendCost}.`,
				actorId
			);
			emitVfx(state, {
				kind: 'exile',
				sourceId: actorId,
				targetId: inst.instanceId,
				label: `Suspended (${suspClause.timeCounters} ⏳)`
			});
			checkStateBasedActions(state);
			return { ok: true };
		}

		case 'reorder_graveyard': {
			if (!Array.isArray(action.instanceIds)) {
				return { ok: false, error: 'Invalid graveyard order list.' };
			}
			if (action.instanceIds.length !== actor.graveyard.length) {
				return {
					ok: false,
					error: 'Graveyard reorder must include all cards currently in your graveyard.'
				};
			}
			const byId = new Map(actor.graveyard.map((c) => [c.instanceId, c]));
			const reordered: CardInstance[] = [];
			for (const id of action.instanceIds) {
				const found = byId.get(id);
				if (!found) {
					return { ok: false, error: `Card ${id} is not in your graveyard.` };
				}
				byId.delete(id);
				reordered.push(found);
			}
			setZoneOrder(actor, 'graveyard', reordered);
			const topCard = actor.graveyard[actor.graveyard.length - 1];
			addLog(
				state,
				'rule',
				`Graveyard Order (CR 404.2): ${actor.username} ordered their graveyard${topCard ? ` (${topCard.card.name} on top)` : ''}.`,
				actorId
			);
			return { ok: true };
		}

		case 'choice': {
			return { ok: false, error: 'That choice is no longer pending.' };
		}

		case 'cast_spell': {
			if (priorityPlayer.playerId !== actorId) {
				return { ok: false, error: 'You do not currently hold priority.' };
			}

			// Locate card in hand, command zone, or playable exile
			let inst: CardInstance | undefined;
			let sourcePlayer: PlayerGameState = actor;
			let sourceZone: 'hand' | 'command' | 'exile' = 'hand';

			const handIdx = actor.hand.findIndex((c) => c.instanceId === action.instanceId);
			if (handIdx >= 0) {
				inst = actor.hand[handIdx];
				sourceZone = 'hand';
			} else {
				const cmdIdx = actor.command.findIndex((c) => c.instanceId === action.instanceId);
				if (cmdIdx >= 0) {
					inst = actor.command[cmdIdx];
					sourceZone = 'command';
				} else {
					for (const p of state.players) {
						const exIdx = p.exile.findIndex(
							(c) =>
								c.instanceId === action.instanceId &&
								c.playableFromExileBy?.playerId === actorId
						);
						if (exIdx >= 0) {
							inst = p.exile[exIdx];
							sourcePlayer = p;
							sourceZone = 'exile';
							break;
						}
					}
				}
			}

			if (!inst) {
				return { ok: false, error: 'Card not found in your Hand, Command Zone, or playable Exile.' };
			}

			const xVal = action.xValue || 0;
			const castMode = action.castMode;
			const legality = checkSpellCastLegality(state, actorId, inst, sourceZone, xVal, castMode);
			if (!legality.ok) {
				return legality;
			}

			const spellTargetInfo = getSpellTargetRequirement(inst.card);
			const targets = action.targets || [];
			const compiledModal = compileSpellEffects(inst.card)?.modal;
			let chosenModes = action.modes;
			if (compiledModal && !chosenModes && compiledModal.max === 1) {
				// "Choose one" cast without naming the mode (older clients): the mode whose targets fit.
				const fit = compiledModal.modes.findIndex(
					(m) =>
						m.targets.length === targets.length &&
						m.targets.every((spec, i) =>
							specTargetCandidates(state, actorId, inst.card, inst, spec).some(
								(c) => c.kind === targets[i].kind && c.id === targets[i].id
							)
						)
				);
				if (fit >= 0) chosenModes = [fit];
			}
			if (compiledModal) {
				const modes = chosenModes;
				if (
					!Array.isArray(modes) ||
					modes.length < compiledModal.min ||
					modes.length > compiledModal.max ||
					new Set(modes).size !== modes.length ||
					modes.some((m) => !Number.isInteger(m) || m < 0 || m >= compiledModal.modes.length)
				) {
					return {
						ok: false,
						error: `Choose ${compiledModal.min}–${compiledModal.max} mode(s) for ${inst.card.name}.`
					};
				}
				const modeSpecs = modes.flatMap((m) => compiledModal.modes[m].targets);
				if (targets.length !== modeSpecs.length) {
					return {
						ok: false,
						error: `${inst.card.name} requires ${modeSpecs.length} target(s) for the chosen mode(s).`
					};
				}
				const uniqueIds = new Set(targets.map((t) => `${t.kind}:${t.id}`));
				if (uniqueIds.size !== targets.length) {
					return {
						ok: false,
						error: 'Strict Rules Violation: The same object cannot be chosen multiple times for the same target requirement (CR 115.3).'
					};
				}
				for (let i = 0; i < modeSpecs.length; i++) {
					const legal = specTargetCandidates(state, actorId, inst.card, inst, modeSpecs[i]);
					if (!legal.some((c) => c.kind === targets[i].kind && c.id === targets[i].id)) {
						return {
							ok: false,
							error: `Strict Rules Violation: ${targets[i].label} is not a legal target for mode ${modes[i] + 1} of ${inst.card.name}.`
						};
					}
				}
			} else {
				const targetValidation = validateChosenTargets(
					state,
					actorId,
					targets,
					spellTargetInfo,
					inst.card,
					inst.instanceId,
					xVal,
					castMode
				);
				if (!targetValidation.ok) {
					return targetValidation;
				}
			}

			// Check & pay mana cost (including Commander Tax if from Command Zone, or any-color mana if exiled with Opposition Agent!)
			const costReq = getSpellCostRequirement(actor, inst, state, xVal, castMode);
			const manaError = `Insufficient mana to cast ${inst.card.name} (requires ${inst.card.manaCost || '{0}'}${sourceZone === 'command' && inst.commanderCastCount > 0 ? ` + {${inst.commanderCastCount * state.rules.commanderTaxIncrement}} Commander Tax` : ''}).`;

			// Phase 4: additional costs from the IR, paid together with the mana (nothing is paid unless
			// everything can be). Choices the player hasn't made become a cost_choice prompt.
			const additional = spellAdditionalCost(inst.card);
			if (additional && additional.defs.length > 0) {
				const ctx = costContext(state, actor, inst, xVal, true, costReq);
				const plan = planCosts(ctx, additional.defs, action.costPayment);
				if (!plan.ok) return { ok: false, error: plan.error.startsWith('Insufficient mana') ? manaError : plan.error };
				if (plan.question) return askCostChoice(state, actor, action, plan.question, inst.card.name);
				const paid = payPlannedCosts(ctx, plan);
				if (paid.descriptions.length > 0) {
					addLog(state, 'rule', `${actor.username} ${paid.descriptions.join('; ')} as an additional cost.`, actorId);
				}
			} else if (!payManaWithAutoTap(actor, costReq, state)) {
				return { ok: false, error: manaError };
			}
			if (additional && !additional.complete) {
				addLog(state, 'rule', `The additional cost of ${inst.card.name} isn't automated; pay it manually.`, actorId);
			}

			// Remove from hand/command/exile zone and push onto the Stack
			moveObject(state, inst, 'stack', {
				from: { player: sourcePlayer, zone: sourceZone },
				newTimestamp: true,
				bumpVersion: true
			});
			const exSourceName = inst.playableFromExileBy?.sourceName;
			inst.playableFromExileBy = undefined;

			if (!actor.commanderCastCounts) {
				actor.commanderCastCounts = {};
			}
			if (sourceZone === 'command' && inst.isCommander) {
				const prevCastCount = actor.commanderCastCounts[inst.instanceId] ?? inst.commanderCastCount ?? 0;
				inst.commanderCastCount = prevCastCount + 1;
				actor.commanderCastCounts[inst.instanceId] = inst.commanderCastCount;
			}
			actor.spellsCastThisTurn = (actor.spellsCastThisTurn || 0) + 1;

			const resolvedCastMode: 'normal' | 'overload' = isOverloadCastMode(inst.card, xVal, castMode)
				? 'overload'
				: 'normal';
			const stackItem: StackItem = withStackItemText(
				{
					id: uid('stk', state),
					sourceInstanceId: inst.instanceId,
					sourceObjectVersion: inst.objectVersion,
					card: inst.card,
					ownerId: inst.ownerId,
					controllerId: actorId,
					kind: 'spell',
					title: inst.card.name,
					targets,
					...(chosenModes ? { chosenModes: [...chosenModes] } : {}),
					targetObjectVersions: captureTargetObjectVersions(state, targets),
					xValue: xVal,
					castMode: resolvedCastMode,
					commanderCastCount: inst.commanderCastCount,
					requiresGuidedResolution: false,
					createdAt: Date.now()
				},
				inst.card
			);

			state.stack.push(stackItem);
			state.passedPriorityPlayerIds = [];
			state.priorityUpdatedAt = Date.now();

			const targetDesc =
				targets.length > 0 ? ` targeting ${targets.map((t) => t.label).join(', ')}` : '';
			addLog(
				state,
				'cast',
				`${actor.username} cast ${inst.card.name}${sourceZone === 'command' ? ` from Command Zone (Cast #${inst.commanderCastCount})` : sourceZone === 'exile' ? ` from Exile (${exSourceName || 'Exile Permission'})` : ''}${targetDesc}.`,
				actorId
			);

			emitVfx(state, {
				kind: sourceZone === 'command' ? 'commander_cast' : 'spell_cast',
				sourceId: actorId,
				targetId: targets[0]?.id,
				label: inst.card.name
			});

			emitEvent(state, { kind: 'Cast', playerId: actor.playerId, objectId: inst.instanceId, object: inst });
			// CR 115.1: each permanent the spell targets "becomes the target of a spell".
			for (const t of targets) {
				const targeted = t.kind === 'permanent' ? findPermanentOnBoard(state, t.id) : null;
				if (targeted) {
					emitEvent(state, {
						kind: 'BecameTarget',
						objectId: t.id,
						object: targeted.inst,
						by: 'spell',
						controllerId: actor.playerId,
						stackItemId: stackItem.id
					});
				}
			}
			// "Whenever you cast ..." ran here before Phase 5.
			flushTriggers(state);
			checkStateBasedActions(state);
			return { ok: true };
		}

		case 'activate_ability': {
			// Locate permanent on actor's battlefield
			const perm = actor.battlefield.find((c) => c.instanceId === action.instanceId);
			if (!perm || perm.phasedOut) {
				return { ok: false, error: 'Permanent not found on your battlefield.' };
			}

			const cmdId = getPlayerCommanderIdentity(actor);
			const abilities = getEffectiveActivatedAbilities(state, actor, perm, cmdId);
			const ab = abilities.find((a) => a.id === action.abilityId);
			if (!ab) return { ok: false, error: 'Ability not found on this permanent.' };

			if (ab.isManaAbility) {
				return applyGameAction(state, actorId, {
					type: 'tap_mana',
					instanceId: perm.instanceId,
					preferredColor: ab.producesMana[0],
					costPayment: action.costPayment
				});
			}

			const abLegality = checkAbilityActivationLegality(state, actorId, perm, ab);
			if (!abLegality.ok) {
				return abLegality;
			}

			const abTargetInfo: TargetRequirementInfo = ab.targetInfo;

			const targets = action.targets || [];
			if (ab.requiresTarget) {
				const targetValidation = validateChosenTargets(
					state,
					actorId,
					targets,
					abTargetInfo,
					perm.card,
					perm.instanceId,
					0
				);
				if (!targetValidation.ok) {
					return targetValidation;
				}
			}

			// Phase 4: pay the whole cost from the IR. Mana comes from effectiveAbilityManaCost (cost
			// modifiers applied); everything else from the ability's CostDefs.
			const abilityCost = activatedAbilityCost(perm.card, ab);
			const abilityMana = effectiveAbilityManaCost(state, actorId, ab.id, ab.manaCost).requirement;
			const abilityCtx = costContext(state, actor, perm, 0, false, abilityMana);
			const abilityPlan = planCosts(abilityCtx, abilityCost.defs, action.costPayment);
			if (!abilityPlan.ok) return { ok: false, error: abilityPlan.error };
			if (abilityPlan.question) return askCostChoice(state, actor, action, abilityPlan.question, perm.card.name);
			const preCostEval = evaluatePermanent(state, perm);
			const sourceLkiPower = preCostEval.power;
			const sourceLkiToughness = preCostEval.toughness;
			const abilityPaid = payPlannedCosts(abilityCtx, abilityPlan);
			if (abilityPaid.descriptions.length > 0) {
				addLog(state, 'rule', `${actor.username} ${abilityPaid.descriptions.join('; ')} to activate ${perm.card.name}.`, actorId);
			}
			if (!abilityCost.complete) {
				addLog(state, 'rule', `Part of the cost of ${perm.card.name}'s ability isn't automated; pay it manually.`, actorId);
			}

			const stackItem: StackItem = withStackItemText(
				{
					id: uid('stk', state),
					sourceInstanceId: perm.instanceId,
					sourceObjectVersion: perm.objectVersion,
					sourceLkiPower,
					sourceLkiToughness,
					card: perm.card,
					controllerId: actorId,
					kind: 'activated',
					abilityId: ab.id,
					title: `${perm.card.name} Ability`,
					targets,
					targetObjectVersions: captureTargetObjectVersions(state, targets),
					xValue: 0,
					requiresGuidedResolution: false,
					createdAt: Date.now()
				},
				ab.effectText
			);

			state.stack.push(stackItem);
			state.passedPriorityPlayerIds = [];
			addLog(state, 'cast', `${actor.username} activated ${perm.card.name}: "${ab.effectText}".`, actorId);
			for (const t of targets) {
				const targeted = t.kind === 'permanent' ? findPermanentOnBoard(state, t.id) : null;
				if (targeted) {
					emitEvent(state, {
						kind: 'BecameTarget',
						objectId: t.id,
						object: targeted.inst,
						by: 'ability',
						controllerId: actor.playerId,
						stackItemId: stackItem.id
					});
				}
			}
			flushTriggers(state);
			checkStateBasedActions(state);
			return { ok: true };
		}

		case 'declare_attackers': {
			if (activePlayer.playerId !== actorId) {
				return { ok: false, error: 'Only the active player may declare attackers.' };
			}
			if (state.phase !== 'declare_attackers') {
				return { ok: false, error: 'Attackers can only be declared during the Declare Attackers step.' };
			}
			if (state.stack.length > 0) {
				return { ok: false, error: 'Cannot declare attackers while the Stack is not empty.' };
			}
			if (state.combat.active) {
				return { ok: false, error: 'Attackers have already been declared this combat.' };
			}

			const validAttackers = [];
			let totalPropagandaTaxGeneric = 0;
			const seenAttackerIds = new Set<string>();

			for (const assign of action.assignments) {
				if (seenAttackerIds.has(assign.attackerInstanceId)) {
					return { ok: false, error: 'Duplicate attacking creature assignment.' };
				}
				seenAttackerIds.add(assign.attackerInstanceId);

				const creature = actor.battlefield.find(
					(c) => c.instanceId === assign.attackerInstanceId
				);
				if (!creature || creature.phasedOut || !evaluatePermanent(state, creature).isCreature) {
					return { ok: false, error: 'Invalid attacking creature.' };
				}
				if (creature.tapped) {
					return { ok: false, error: `${creature.card.name} is tapped and cannot attack.` };
				}
				if (creature.summoningSick && !hasKeyword(creature, 'Haste', state)) {
					return {
						ok: false,
						error: `${creature.card.name} has summoning sickness and cannot attack this turn.`
					};
				}
				if (hasKeyword(creature, 'Defender', state)) {
					return { ok: false, error: `${creature.card.name} has Defender and cannot attack.` };
				}
				if (hasRestriction(state, creature, 'cantAttack')) {
					return { ok: false, error: `${creature.card.name} cannot attack.` };
				}

				const defender = state.players.find(
					(p) => p.playerId === assign.defenderPlayerId && !p.lost
				);
				if (!defender || defender.playerId === actorId) {
					return { ok: false, error: 'Invalid defending player.' };
				}

				// CR 508.1b: Validate defenderPlaneswalkerId if provided
				if (assign.defenderPlaneswalkerId) {
					const targetPw = defender.battlefield.find(
						(c) => !c.phasedOut && c.instanceId === assign.defenderPlaneswalkerId
					);
					if (!targetPw || !evaluatePermanent(state, targetPw).isPlaneswalker) {
						return {
							ok: false,
							error: 'Invalid defending planeswalker (CR 508.1b).'
						};
					}
				}

				// CR 701.15b: Goad requires attacking a player other than the goader if able
				if (creature.goadedByPlayerIds && creature.goadedByPlayerIds.length > 0) {
					const nonGoaderAvailable = state.players.some(
						(p) =>
							p.playerId !== actorId &&
							!p.lost &&
							!creature.goadedByPlayerIds!.includes(p.playerId) &&
							getAttackTaxGeneric(state, p) === 0
					);
					if (
						nonGoaderAvailable &&
						(creature.goadedByPlayerIds.includes(defender.playerId) ||
							Boolean(assign.defenderPlaneswalkerId))
					) {
						return {
							ok: false,
							error: `Strict Rules Violation: ${creature.card.name} is Goaded and must attack a player other than its goader if able (CR 701.15b).`
						};
					}
				}

				// Check attack tax on defending player (CR 508.1d)
				if (!assign.defenderPlaneswalkerId) {
					totalPropagandaTaxGeneric += getAttackTaxGeneric(state, defender);
				}
			}

			// Enforce Goad / Attack requirements (CR 508.1d: must satisfy as many requirements as possible without violating restrictions)
			const assignedIds = new Set(action.assignments.map((a) => a.attackerInstanceId));
			for (const perm of actor.battlefield) {
				if (perm.phasedOut || !evaluatePermanent(state, perm).isCreature) continue;
				const isGoaded = Boolean(perm.goadedByPlayerIds && perm.goadedByPlayerIds.length > 0);
				const mustAttack = isGoaded || hasRestriction(state, perm, 'attacksEachCombat');
				if (mustAttack) {
					const canAttack =
						!perm.tapped &&
						(!perm.summoningSick || hasKeyword(perm, 'Haste', state)) &&
						!hasKeyword(perm, 'Defender', state) &&
						!hasRestriction(state, perm, 'cantAttack');
					if (canAttack && !assignedIds.has(perm.instanceId)) {
						return {
							ok: false,
							error: `Strict Rules Violation: ${perm.card.name} ${isGoaded ? 'is Goaded and ' : ''}must attack this combat if able.`
						};
					}
				}
			}

			// Pay attack tax if applicable
			if (totalPropagandaTaxGeneric > 0) {
				const taxReq = parseManaCost(`{${totalPropagandaTaxGeneric}}`);
				if (!payManaWithAutoTap(actor, taxReq, state)) {
					const taxSources = Array.from(
						new Set(
							action.assignments
								.filter((a) => !a.defenderPlaneswalkerId)
								.flatMap((a) => getAttackTaxSources(state, a.defenderPlayerId))
						)
					);
					return {
						ok: false,
						error: `Strict Rules Violation: Attacking requires paying {${totalPropagandaTaxGeneric}} for ${taxSources.join(' / ') || 'attack tax'}, and you have insufficient mana.`
					};
				}
			}

			// CR 508.1f: attackers tap as they're declared, all at once, so vigilance is read from the
			// board before any of them taps (tapping one between checks invalidated the layer cache
			// for the next; Phase 6d).
			const vigilantIds = withStableLayerInputs(state, () => {
				const ids = new Set<string>();
				for (const assign of action.assignments) {
					const creature = actor.battlefield.find(
						(c) => c.instanceId === assign.attackerInstanceId
					)!;
					if (hasKeyword(creature, 'Vigilance', state)) ids.add(creature.instanceId);
				}
				return ids;
			});
			for (const assign of action.assignments) {
				const creature = actor.battlefield.find(
					(c) => c.instanceId === assign.attackerInstanceId
				)!;
				const defender = state.players.find(
					(p) => p.playerId === assign.defenderPlayerId && !p.lost
				)!;
				if (!vigilantIds.has(creature.instanceId)) {
					creature.tapped = true;
				}
				validAttackers.push({
					attackerInstanceId: creature.instanceId,
					controllerId: actorId,
					defenderPlayerId: defender.playerId,
					defenderPlaneswalkerId: assign.defenderPlaneswalkerId || null,
					blockerInstanceIds: [],
					wasBlocked: false
				});
			}

			state.combat.active = true;
			state.combat.attackers = validAttackers;
			state.combat.declaredBlockersPlayerIds = [];
			state.combat.blockersDeclared = false;
			state.combat.damageDealtFirstStrike = false;
			state.combat.damageDealtNormal = false;
			state.combat.dealtFirstStrikeDamageIds = [];

			if (validAttackers.length > 0) {
				addLog(
					state,
					'combat',
					`${actor.username} declared ${validAttackers.length} attacker(s)!`,
					actorId
				);
				emitVfx(state, {
					kind: 'attack_declare',
					sourceId: actorId,
					amount: validAttackers.length,
					label: `${validAttackers.length} Attacker(s)`
				});
				emitEvent(state, {
					kind: 'AttackDeclared',
					playerId: actor.playerId,
					attackerIds: validAttackers.map((a) => a.attackerInstanceId)
				});
				flushTriggers(state);
			} else {
				addLog(state, 'combat', `${actor.username} declared no attackers.`, actorId);
			}

			// CR 508.2: Active player receives priority in declare_attackers after attackers are declared
			state.priorityPlayerIndex = state.activePlayerIndex;
			state.passedPriorityPlayerIds = [];
			state.priorityUpdatedAt = Date.now();
			return { ok: true };
		}

		case 'declare_blockers': {
			if (state.phase !== 'declare_blockers') {
				return { ok: false, error: 'Blockers can only be declared during the Declare Blockers step.' };
			}
			if (state.stack.length > 0) {
				return { ok: false, error: 'Cannot declare blockers while the Stack is not empty.' };
			}
			if (
				state.combat.blockersDeclared ||
				(state.combat.declaredBlockersPlayerIds &&
					state.combat.declaredBlockersPlayerIds.includes(actorId))
			) {
				return { ok: false, error: 'Blockers have already been declared this step.' };
			}

			// Validate each blocker assignment (including duplicate blockerInstanceId, Flying, Reach, Menace, Protection!)
			const blockerCountsByAttacker = new Map<string, string[]>();
			const seenBlockerIds = new Set<string>();
			for (const assign of action.assignments) {
				if (seenBlockerIds.has(assign.blockerInstanceId)) {
					return {
						ok: false,
						error: 'Strict Rules Violation: A creature cannot block more than one attacking creature (CR 509.1a).'
					};
				}
				seenBlockerIds.add(assign.blockerInstanceId);

				const blocker = actor.battlefield.find(
					(c) => c.instanceId === assign.blockerInstanceId
				);
				if (!blocker || blocker.phasedOut || !evaluatePermanent(state, blocker).isCreature) {
					return { ok: false, error: 'Invalid blocking creature.' };
				}
				if (blocker.tapped) {
					return { ok: false, error: `${blocker.card.name} is tapped and cannot block.` };
				}
				if (hasRestriction(state, blocker, 'cantBlock')) {
					return { ok: false, error: `${blocker.card.name} cannot block.` };
				}

				const atkEntry = state.combat.attackers.find(
					(a) => a.attackerInstanceId === assign.attackerInstanceId
				);
				if (!atkEntry) {
					return { ok: false, error: 'Target attacker is not attacking.' };
				}
				if (atkEntry.defenderPlayerId !== actorId) {
					return {
						ok: false,
						error: `${blocker.card.name} can only block creatures attacking you.`
					};
				}

				const atkOwner = state.players.find((p) => p.playerId === atkEntry.controllerId);
				const atkCard = atkOwner?.battlefield.find(
					(c) => c.instanceId === atkEntry.attackerInstanceId
				);
				if (atkCard) {
					// Check Flying evasion
					if (
						hasKeyword(atkCard, 'Flying', state) &&
						!hasKeyword(blocker, 'Flying', state) &&
						!hasKeyword(blocker, 'Reach', state)
					) {
						return {
							ok: false,
							error: `Strict Rules Violation: ${blocker.card.name} cannot block ${atkCard.card.name} (has Flying; blocker needs Flying or Reach).`
						};
					}
					if (hasRestriction(state, atkCard, 'cantBeBlocked')) {
						return {
							ok: false,
							error: `Strict Rules Violation: ${atkCard.card.name} cannot be blocked.`
						};
					}
					// CR 702.16e: Attacker with Protection from [quality] cannot be blocked by creatures with that quality
					if (hasProtectionFrom(atkCard, blocker.copiableCard ?? blocker.card, state)) {
						return {
							ok: false,
							error: `Strict Rules Violation: ${blocker.card.name} cannot block ${atkCard.card.name} due to Protection (CR 702.16e).`
						};
					}
				}

				const list = blockerCountsByAttacker.get(atkEntry.attackerInstanceId) || [];
				list.push(blocker.instanceId);
				blockerCountsByAttacker.set(atkEntry.attackerInstanceId, list);
			}

			// Check Menace (cannot be blocked except by two or more creatures)
			for (const [atkId, bIds] of blockerCountsByAttacker.entries()) {
				if (bIds.length === 1) {
					const atkEntry = state.combat.attackers.find((a) => a.attackerInstanceId === atkId);
					const atkOwner = state.players.find((p) => p.playerId === atkEntry?.controllerId);
					const atkCard = atkOwner?.battlefield.find((c) => c.instanceId === atkId);
					if (atkCard && hasKeyword(atkCard, 'Menace', state)) {
						return {
							ok: false,
							error: `Strict Rules Violation: ${atkCard.card.name} has Menace and cannot be blocked by only 1 creature (requires 2 or more blockers).`
						};
					}
				}
			}

			// Enforce "blocks each combat if able" requirements (CR 509.1c)
			const assignedBlockerIds = new Set(action.assignments.map((a) => a.blockerInstanceId));
			const attackersAgainstActor = state.combat.attackers
				.filter((a) => a.defenderPlayerId === actorId)
				.map((a) => {
					const owner = state.players.find((p) => p.playerId === a.controllerId);
					return owner?.battlefield.find((c) => c.instanceId === a.attackerInstanceId);
				})
				.filter((c): c is CardInstance => Boolean(c));
			if (attackersAgainstActor.length > 0) {
				for (const perm of actor.battlefield) {
					if (perm.phasedOut || perm.tapped || !evaluatePermanent(state, perm).isCreature) continue;
					if (hasRestriction(state, perm, 'cantBlock')) continue;
					if (!hasRestriction(state, perm, 'blocksEachCombat')) continue;
					const canBlockAny = attackersAgainstActor.some((atk) => {
						if (hasRestriction(state, atk, 'cantBeBlocked')) {
							return false;
						}
						if (hasProtectionFrom(atk, perm.copiableCard ?? perm.card, state)) {
							return false;
						}
						if (
							hasKeyword(atk, 'Flying', state) &&
							!hasKeyword(perm, 'Flying', state) &&
							!hasKeyword(perm, 'Reach', state)
						) {
							return false;
						}
						return !hasKeyword(atk, 'Menace', state);
					});
					if (canBlockAny && !assignedBlockerIds.has(perm.instanceId)) {
						return {
							ok: false,
							error: `Strict Rules Violation: ${perm.card.name} must block this combat if able.`
						};
					}
				}
			}

			// Apply validated blocks and mark `wasBlocked` (CR 509.1h)
			for (const atkEntry of state.combat.attackers) {
				if (atkEntry.defenderPlayerId === actorId) {
					atkEntry.blockerInstanceIds =
						blockerCountsByAttacker.get(atkEntry.attackerInstanceId) || [];
					if (atkEntry.blockerInstanceIds.length > 0) {
						atkEntry.wasBlocked = true;
					}
				}
			}

			if (!state.combat.declaredBlockersPlayerIds) {
				state.combat.declaredBlockersPlayerIds = [];
			}
			if (!state.combat.declaredBlockersPlayerIds.includes(actorId)) {
				state.combat.declaredBlockersPlayerIds.push(actorId);
			}

			if (action.assignments.length > 0) {
				addLog(
					state,
					'combat',
					`${actor.username} declared ${action.assignments.length} blocker(s).`,
					actorId
				);
				emitVfx(state, {
					kind: 'block_declare',
					sourceId: actorId,
					amount: action.assignments.length
				});
				emitEvent(state, {
					kind: 'BlockersDeclared',
					playerId: actorId,
					blocks: action.assignments.map((a) => ({
						blockerId: a.blockerInstanceId,
						attackerId: a.attackerInstanceId
					}))
				});
				flushTriggers(state);
			} else {
				addLog(state, 'combat', `${actor.username} declared no blockers.`, actorId);
			}

			// Check if another defending player still needs to declare blockers in turn order
			const defendersInOrder = getAttackedDefenderIdsInTurnOrder(state);
			const nextUndecidedDefenderId = defendersInOrder.find(
				(defId) => !state.combat.declaredBlockersPlayerIds.includes(defId)
			);
			if (nextUndecidedDefenderId) {
				const nextDefIdx = state.players.findIndex((p) => p.playerId === nextUndecidedDefenderId);
				state.priorityPlayerIndex = nextDefIdx >= 0 ? nextDefIdx : state.activePlayerIndex;
			} else {
				// All attacked defenders have declared blockers -> give priority back to active player
				state.combat.blockersDeclared = true;
				state.priorityPlayerIndex = state.activePlayerIndex;
			}
			state.passedPriorityPlayerIds = [];
			state.priorityUpdatedAt = Date.now();
			return { ok: true };
		}

		case 'pass_priority': {
			if (priorityPlayer.playerId !== actorId) {
				return { ok: false, error: 'You do not currently hold priority.' };
			}

			// If an attacked defender passes priority in declare_blockers without having declared blockers yet, record 0 blockers
			if (
				state.phase === 'declare_blockers' &&
				state.stack.length === 0 &&
				state.combat.attackers.some((a) => a.defenderPlayerId === actorId)
			) {
				if (!state.combat.declaredBlockersPlayerIds) {
					state.combat.declaredBlockersPlayerIds = [];
				}
				if (!state.combat.declaredBlockersPlayerIds.includes(actorId)) {
					state.combat.declaredBlockersPlayerIds.push(actorId);
					const defendersInOrder = getAttackedDefenderIdsInTurnOrder(state);
					const nextUndecidedDefenderId = defendersInOrder.find(
						(defId) => !state.combat.declaredBlockersPlayerIds.includes(defId)
					);
					if (nextUndecidedDefenderId) {
						const nextDefIdx = state.players.findIndex((p) => p.playerId === nextUndecidedDefenderId);
						if (nextDefIdx >= 0) {
							state.priorityPlayerIndex = nextDefIdx;
							state.passedPriorityPlayerIds = [];
							state.priorityUpdatedAt = Date.now();
							return { ok: true };
						}
					} else {
						state.combat.blockersDeclared = true;
					}
				}
			}

			if (!state.passedPriorityPlayerIds.includes(actorId)) {
				state.passedPriorityPlayerIds.push(actorId);
			}

			const alivePlayers = state.players.filter((p) => !p.lost);
			const allPassed = alivePlayers.every((p) =>
				state.passedPriorityPlayerIds.includes(p.playerId)
			);

			if (allPassed) {
				state.passedPriorityPlayerIds = [];
				if (state.stack.length > 0) {
					resolveTopOfStack(state);
				} else {
					advancePhaseOrStep(state);
				}
			} else {
				checkStateBasedActions(state);
				advancePriorityToNextPlayer(state);
			}

			state.priorityUpdatedAt = Date.now();
			return { ok: true };
		}

		case 'end_turn': {
			if (activePlayer.playerId !== actorId) {
				return { ok: false, error: 'You can only end the turn during your own turn.' };
			}
			if (priorityPlayer.playerId !== actorId) {
				return { ok: false, error: 'You must hold priority to end your turn.' };
			}
			if (state.stack.length > 0) {
				return { ok: false, error: 'Resolve all spells and abilities on the Stack before ending your turn.' };
			}

			// Clear any unconfirmed combat state and move through End Step -> Cleanup
			state.combat.active = false;
			state.combat.attackers = [];
			state.combat.declaredBlockersPlayerIds = [];
			state.passedPriorityPlayerIds = [];

			if (state.phase !== 'end_step') {
				addLog(state, 'rule', `${actor.username} ended their turn.`, actorId);
				emptyAllPlayersManaPools(state);
				enterEndStep(state, activePlayer);
				if (state.stack.length === 0 && state.pendingPrompts.length === 0) {
					emptyAllPlayersManaPools(state);
					runCleanupStep(state);
				}
			} else if (state.stack.length === 0) {
				emptyAllPlayersManaPools(state);
				runCleanupStep(state);
			}
			state.priorityUpdatedAt = Date.now();
			checkStateBasedActions(state);
			return { ok: true };
		}

		default:
			return { ok: false, error: `Action ${action.type} is not valid right now.` };
	}
}

function handleMulliganAction(
	state: GameState,
	actor: PlayerGameState,
	action: GameActionPayload
): { ok: boolean; error?: string } {
	const prIdx = state.pendingPrompts.findIndex((p) => p.playerId === actor.playerId);
	if (action.type === 'choice' && prIdx >= 0) {
		const pr = state.pendingPrompts[prIdx];
		if (action.promptId !== pr.id) {
			return { ok: false, error: 'That choice is no longer pending.' };
		}
		const choice = effectivePromptChoice(pr, state);
		const valid = validateChoiceAnswer(choice, action.answer);
		if (!valid.ok) {
			return { ok: false, error: valid.error };
		}
		if (effectivePromptPurpose(pr) === 'mulligan' && action.answer?.kind === 'yesNo') {
			return handleMulliganAction(state, actor, {
				type: action.answer.yes ? 'mulligan_keep' : 'mulligan_take'
			});
		}
		if (effectivePromptPurpose(pr) === 'london_bottom' && action.answer?.kind === 'chooseObjects') {
			return handleMulliganAction(state, actor, {
				type: 'london_bottom',
				instanceIds: action.answer.objectIds
			});
		}
	}

	if (action.type === 'mulligan_keep') {
		if (prIdx >= 0) state.pendingPrompts.splice(prIdx, 1);
		const freeMulligans =
			state.rules.mulliganRule === 'friendly_unlimited' || state.rules.mulliganRule === 'free_all'
				? 99
				: state.rules.mulliganRule === 'london_1free'
					? 1
					: 0;
		const cardsToBottom = Math.max(0, actor.mulliganCount - freeMulligans);

		if (cardsToBottom > 0 && actor.hand.length > 0) {
			const countReq = Math.min(cardsToBottom, actor.hand.length);
			const description = `Select ${countReq} card(s) from your hand to place on the bottom of your library.`;
			const candidates = actor.hand.map((c) => c.instanceId);
			state.pendingPrompts.push({
				id: uid('prm', state),
				playerId: actor.playerId,
				kind: 'london_bottom',
				purpose: 'london_bottom',
				title: `Put ${countReq} Card(s) on Bottom of Library`,
				description,
				countRequired: countReq,
				candidateInstanceIds: candidates,
				choice: {
					kind: 'chooseObjects',
					candidates,
					min: countReq,
					max: countReq,
					zone: 'hand',
					reason: description
				}
			});
			return { ok: true };
		}

		actor.hasKeptHand = true;
		addLog(
			state,
			'rule',
			`${actor.username} kept a ${actor.hand.length}-card opening hand.`,
			actor.playerId
		);
		checkIfAllKeptMulligan(state);
		return { ok: true };
	}

	if (action.type === 'mulligan_take') {
		actor.mulliganCount += 1;
		mulliganRedraw(state, actor);
		addLog(
			state,
			'rule',
			`${actor.username} took mulligan #${actor.mulliganCount}.`,
			actor.playerId
		);
		return { ok: true };
	}

	if (action.type === 'london_bottom') {
		const pr = state.pendingPrompts[prIdx];
		if (!pr || pr.kind !== 'london_bottom') {
			return { ok: false, error: 'No London Mulligan bottom prompt active.' };
		}
		const required = pr.countRequired || 1;
		const ids = Array.isArray(action.instanceIds) ? action.instanceIds : [];
		if (ids.length !== required) {
			return { ok: false, error: `Please select exactly ${required} card(s).` };
		}
		for (const id of ids) {
			const hIdx = actor.hand.findIndex((c) => c.instanceId === id);
			if (hIdx >= 0) {
				moveObject(state, actor.hand[hIdx], 'library', {
					from: { player: actor, zone: 'hand' },
					toPlayer: actor
				});
			}
		}
		state.pendingPrompts.splice(prIdx, 1);
		actor.hasKeptHand = true;
		addLog(
			state,
			'rule',
			`${actor.username} kept ${actor.hand.length} cards (put ${required} on the bottom).`,
			actor.playerId
		);
		checkIfAllKeptMulligan(state);
		return { ok: true };
	}

	return { ok: false, error: 'Please Keep or Mulligan your opening hand first.' };
}

function handlePromptResolution(
	state: GameState,
	actor: PlayerGameState,
	promptIdx: number,
	action: GameActionPayload
): { ok: boolean; error?: string } {
	if (action.type === 'choice' || action.type === 'cost_choice') {
		const byIdIdx = state.pendingPrompts.findIndex(
			(p) => p.playerId === actor.playerId && p.id === action.promptId
		);
		if (byIdIdx < 0) {
			return {
				ok: false,
				error:
					action.type === 'cost_choice'
						? 'That cost choice is no longer pending.'
						: 'That choice is no longer pending.'
			};
		}
		promptIdx = byIdIdx;
	}

	const prompt = state.pendingPrompts[promptIdx];
	const normalized = normalizePromptAction(prompt, action, state);
	if (!normalized) {
		return { ok: false, error: `Please resolve the active prompt: ${prompt.title}.` };
	}

	const choice = effectivePromptChoice(prompt, state);
	const purpose = effectivePromptPurpose(prompt);

	// Steps C+D: triggered-ability target, order and "you may" prompts.
	if (purpose === 'trigger_targets' || purpose === 'trigger_order' || purpose === 'trigger_may') {
		return resolveTriggerPrompt(state, prompt, promptIdx, normalized.answer);
	}

	// Phase 4/8: a cost choice. The answer is merged into the waiting action's costPayment and the
	// action runs again from scratch (re-checking legality); on failure the prompt is restored.
	if (purpose === 'cost_choice') {
		state.pendingPrompts.splice(promptIdx, 1);
		const pending = prompt.pendingAction;
		if (
			normalized.cancel ||
			!pending ||
			(pending.type !== 'cast_spell' &&
				pending.type !== 'activate_ability' &&
				pending.type !== 'tap_mana')
		) {
			return { ok: true };
		}
		const valid = validateChoiceAnswer(choice, normalized.answer);
		if (!valid.ok) {
			state.pendingPrompts.splice(promptIdx, 0, prompt);
			return { ok: false, error: valid.error };
		}
		const payment = {
			options: [...(pending.costPayment?.options ?? [])],
			objects: [...(pending.costPayment?.objects ?? [])]
		};
		const q = prompt.costQuestion;
		if (q?.kind === 'option') {
			const opt =
				normalized.answer?.kind === 'yesNo'
					? normalized.answer.yes
						? 0
						: 1
					: normalized.answer?.kind === 'chooseMode'
						? normalized.answer.indices[0]
						: undefined;
			if (opt === undefined) {
				state.pendingPrompts.splice(promptIdx, 0, prompt);
				return { ok: false, error: 'Choose one of the options.' };
			}
			payment.options[q.index] = opt;
		} else if (q?.kind === 'objects' && normalized.answer?.kind === 'chooseObjects') {
			payment.objects[q.index] = normalized.answer.objectIds;
		}
		const result = applyGameAction(state, actor.playerId, { ...pending, costPayment: payment });
		if (!result.ok) state.pendingPrompts.splice(promptIdx, 0, prompt);
		return result;
	}

	if (purpose === 'end_turn') {
		const valid = validateChoiceAnswer(choice, normalized.answer);
		if (!valid.ok || normalized.answer?.kind !== 'yesNo') {
			return { ok: false, error: valid.ok ? 'Invalid end-turn choice.' : valid.error };
		}
		state.pendingPrompts.splice(promptIdx, 1);
		if (normalized.answer.yes) {
			endTheTurnImmediately(state, actor.playerId);
		} else {
			addLog(
				state,
				'rule',
				`${actor.username} chose not to end the turn.`,
				actor.playerId
			);
		}
		checkStateBasedActions(state);
		return { ok: true };
	}

	if (purpose === 'legend_rule') {
		const valid = validateChoiceAnswer(choice, normalized.answer);
		if (!valid.ok || normalized.answer?.kind !== 'chooseObjects') {
			return {
				ok: false,
				error: 'Please choose one of the duplicate legendary permanents to keep.'
			};
		}
		const keepInstanceId = normalized.answer.objectIds[0];
		const cands =
			prompt.candidateInstanceIds ??
			(choice.kind === 'chooseObjects' ? choice.candidates : []);
		if (!cands.includes(keepInstanceId)) {
			return {
				ok: false,
				error: 'Please choose one of the duplicate legendary permanents to keep.'
			};
		}
		state.pendingPrompts.splice(promptIdx, 1);
		for (const cid of cands) {
			if (cid !== keepInstanceId) {
				const found = findPermanentOnBoard(state, cid);
				if (found) {
					movePermanentToZone(state, found.inst, 'graveyard');
				}
			}
		}
		addLog(
			state,
			'sba',
			`${actor.username} resolved the Legend Rule (CR 704.5j).`,
			actor.playerId
		);
		checkStateBasedActions(state);
		return { ok: true };
	}

	if (purpose === 'commander_zone_choice') {
		const valid = validateChoiceAnswer(choice, normalized.answer);
		if (!valid.ok || normalized.answer?.kind !== 'yesNo') {
			return { ok: false, error: valid.ok ? 'Invalid commander zone choice.' : valid.error };
		}
		state.pendingPrompts.splice(promptIdx, 1);
		if (normalized.answer.yes) {
			const gIdx = actor.graveyard.findIndex((c) => c.instanceId === prompt.commanderInstanceId);
			const eIdx = actor.exile.findIndex((c) => c.instanceId === prompt.commanderInstanceId);
			let cmd: CardInstance | undefined;
			let cmdFrom: 'graveyard' | 'exile' = 'graveyard';
			if (gIdx >= 0) cmd = actor.graveyard[gIdx];
			else if (eIdx >= 0) {
				cmd = actor.exile[eIdx];
				cmdFrom = 'exile';
			}

			if (cmd) {
				cmd.damageMarked = 0;
				cmd.deathtouchDamageMarked = false;
				cmd.tapped = false;
				moveObject(state, cmd, 'command', { from: { player: actor, zone: cmdFrom }, toPlayer: actor });
				addLog(
					state,
					'rule',
					`${actor.username} returned Commander ${cmd.card.name} to the Command Zone (CR 903.9a).`,
					actor.playerId
				);
			}
		} else {
			const cmd =
				actor.graveyard.find((c) => c.instanceId === prompt.commanderInstanceId) ??
				actor.exile.find((c) => c.instanceId === prompt.commanderInstanceId);
			if (cmd) {
				cmd.commanderSbaDeclinedVersion = cmd.objectVersion ?? 1;
			}
			addLog(
				state,
				'rule',
				`${actor.username} chose to leave Commander in ${prompt.destinationZone}.`,
				actor.playerId
			);
		}
		return { ok: true };
	}

	if (purpose === 'discard_to_hand_size') {
		const req = prompt.countRequired || 1;
		const valid = validateChoiceAnswer(choice, normalized.answer);
		if (!valid.ok || normalized.answer?.kind !== 'chooseObjects') {
			return { ok: false, error: `You must discard exactly ${req} card(s).` };
		}
		const chosenIds = normalized.answer.objectIds;
		if (chosenIds.length !== req) {
			return { ok: false, error: `You must discard exactly ${req} card(s).` };
		}
		const gyDest = checkGraveyardReplacementZone(state, 'graveyard').dest;
		for (const id of chosenIds) {
			const idx = actor.hand.findIndex((c) => c.instanceId === id);
			if (idx >= 0) {
				moveObject(state, actor.hand[idx], gyDest, {
					from: { player: actor, zone: 'hand' },
					toPlayer: actor
				});
			}
		}
		state.pendingPrompts.splice(promptIdx, 1);
		addLog(
			state,
			'rule',
			`${actor.username} discarded ${req} card(s) down to maximum hand size.`,
			actor.playerId
		);
		completeTurnCleanupAndPassTurn(state);
		return { ok: true };
	}

	if (purpose === 'search_library') {
		if (!normalized.answer || normalized.answer.kind !== 'chooseObjects') {
			return { ok: false, error: 'Library search expects an object choice.' };
		}
		const libraryOwner =
			state.players.find(
				(p) => p.playerId === (prompt.targetLibraryOwnerId || actor.playerId)
			) || actor;
		const pickedIds = normalized.answer.objectIds;
		if (pickedIds.length > 1) {
			return { ok: false, error: 'You may pick at most 1 card per search step.' };
		}
		const pickedId = pickedIds[0] ?? null;

		if (pickedId === null) {
			const availableCount = prompt.candidateInstanceIds
				? prompt.candidateInstanceIds.length
				: libraryOwner.library.length;
			const mustFind =
				prompt.canFailToFind === false ||
				(choice.kind === 'chooseObjects' && choice.min > 0);
			if (mustFind && availableCount > 0) {
				return {
					ok: false,
					error:
						'Strict Rules Violation (CR 701.19b): This search instruction does not state a card quality, so you must find a card if the library is not empty.'
				};
			}
		} else {
			const candidateIds =
				prompt.candidateInstanceIds ??
				(choice.kind === 'chooseObjects' && choice.candidates.length > 0
					? choice.candidates
					: undefined);
			if (candidateIds && !candidateIds.includes(pickedId)) {
				return {
					ok: false,
					error: 'Strict Rules Violation: That card does not match the required search criteria.'
				};
			}
			if (!libraryOwner.library.some((c) => c.instanceId === pickedId)) {
				return {
					ok: false,
					error: 'Strict Rules Violation: Card not found in the searched library.'
				};
			}
		}

		state.pendingPrompts.splice(promptIdx, 1);
		let alreadyShuffledWithTopCard = false;

		if (pickedId) {
			const idx = libraryOwner.library.findIndex((c) => c.instanceId === pickedId);
			if (idx >= 0) {
				const found = libraryOwner.library[idx];
				const fromLibrary = { player: libraryOwner, zone: 'library' as const };
				if (prompt.interceptedBy?.exilesFoundCards) {
					if (prompt.interceptedBy.grantPlayFromExile) {
						found.playableFromExileBy = {
							playerId: prompt.interceptedBy.controllerId,
							spendManaAsAnyColor: prompt.interceptedBy.spendManaAsAnyColor,
							sourceName: prompt.interceptedBy.sourceName
						};
					}
					moveObject(state, found, 'exile', {
						from: fromLibrary,
						toPlayer: libraryOwner,
						newTimestamp: true,
						bumpVersion: true
					});
					emitVfx(state, {
						kind: 'exile',
						sourceId: actor.playerId,
						targetId: found.instanceId,
						label: `${prompt.interceptedBy.sourceName}: Exiled ${found.card.name}`
					});
					addLog(
						state,
						'rule',
						`${actor.username} (controlling ${libraryOwner.username} during their library search via ${prompt.interceptedBy.sourceName}) exiled ${found.card.name} from ${libraryOwner.username}'s library! ${actor.username} may play it from exile${prompt.interceptedBy.spendManaAsAnyColor ? ' spending mana as though it were mana of any color' : ''}.`,
						actor.playerId
					);
				} else if (prompt.destinationZone === 'battlefield') {
					found.tapped = Boolean(prompt.enterTapped);
					applySelfEtbReplacements(state, found);
					moveObject(state, found, 'battlefield', {
						from: fromLibrary,
						toPlayer: libraryOwner,
						controllerId: libraryOwner.playerId,
						newTimestamp: true,
						bumpVersion: true
					});
					addLog(
						state,
						'rule',
						`${libraryOwner.username} searched their library and put ${found.card.name} onto the battlefield${found.tapped ? ' tapped' : ''}.`,
						libraryOwner.playerId
					);
					flushTriggers(state);
				} else if (prompt.destinationZone === 'library' && prompt.putOnTop) {
					// Put it on top, then shuffle the rest: the same as the old "remove, shuffle, put on top".
					moveObject(state, found, 'library', {
						from: fromLibrary,
						toPlayer: libraryOwner,
						insert: 'start',
						newTimestamp: true,
						bumpVersion: true
					});
					shuffleLibrary(state, libraryOwner, 1);
					alreadyShuffledWithTopCard = true;
					addLog(
						state,
						'rule',
						`${libraryOwner.username} searched their library, shuffled, and put a card on top.`,
						libraryOwner.playerId
					);
				} else {
					moveObject(state, found, 'hand', { from: fromLibrary, toPlayer: libraryOwner });
					addLog(
						state,
						'rule',
						`${libraryOwner.username} searched their library for a card, put it into hand, and shuffled.`,
						libraryOwner.playerId
					);
				}

				// Check if there are additional cards to find in a multi-card search (e.g. Cultivate, Kodama's Reach, Skyshroud Claim, Myriad Landscape)
				const nextDestinations: LibrarySearchDestination[] = prompt.remainingDestinations
					? [...prompt.remainingDestinations]
					: prompt.secondLandToBattlefield
						? [{ zone: 'battlefield', tapped: true }]
						: prompt.secondLandToHand
							? [{ zone: 'hand' }]
							: [];

				if (nextDestinations.length > 0) {
					const nextDest = nextDestinations.shift()!;
					const remainingCandidates = libraryOwner.library
						.filter((c) =>
							prompt.searchSpec
								? matchesLibrarySearchSpec(c.card, prompt.searchSpec)
								: c.card.typeLine.includes('Basic') && c.card.typeLine.includes('Land')
						)
						.map((c) => c.instanceId);

					if (remainingCandidates.length > 0) {
						const nextDesc = prompt.interceptedBy
							? `Choose the next matching card from ${libraryOwner.username}'s library to exile via ${prompt.interceptedBy.sourceName}, or Fail to Find.`
							: `Choose the next matching card from your library to put ${describeLibrarySearchDestination(nextDest)}, then shuffle.`;
						const canFailNext = prompt.canFailToFind ?? true;
						state.pendingPrompts.push({
							id: uid('prm', state),
							playerId: actor.playerId,
							targetLibraryOwnerId: libraryOwner.playerId,
							kind: 'search_library',
							purpose: 'search_library',
							title: prompt.interceptedBy
								? `${prompt.interceptedBy.sourceName} — Choose Next Card from ${libraryOwner.username}'s Library`
								: `Search Library — Next Card (${describeLibrarySearchDestination(nextDest)})`,
							description: nextDesc,
							destinationZone: nextDest.zone,
							enterTapped: Boolean(nextDest.tapped),
							putOnTop: Boolean(nextDest.onTop),
							searchSpec: prompt.searchSpec,
							remainingDestinations: nextDestinations,
							canFailToFind: canFailNext,
							interceptedBy: prompt.interceptedBy,
							candidateInstanceIds: remainingCandidates,
							choice: {
								kind: 'chooseObjects',
								candidates: remainingCandidates,
								min: canFailNext ? 0 : 1,
								max: 1,
								zone: 'library',
								reason: nextDesc
							},
							stackItem: prompt.stackItem,
							continuation: prompt.continuation
						});
						return { ok: true };
					}
				}
			}
		} else {
			addLog(
				state,
				'rule',
				prompt.interceptedBy
					? `${actor.username} (controlling ${libraryOwner.username} via ${prompt.interceptedBy.sourceName}) chose not to find a card in ${libraryOwner.username}'s library and shuffled.`
					: `${libraryOwner.username} searched their library (chose not to find a card) and shuffled.`,
				actor.playerId
			);
		}

		if (!alreadyShuffledWithTopCard) {
			shuffleLibrary(state, libraryOwner);
		}
		checkStateBasedActions(state);
		resumeAfterPrompt(state, prompt);
		return { ok: true };
	}

	if (purpose === 'scry_choice' || choice.kind === 'orderObjects') {
		const valid = validateChoiceAnswer(choice, normalized.answer);
		if (!valid.ok || normalized.answer?.kind !== 'orderObjects') {
			return { ok: false, error: valid.ok ? 'Invalid orderObjects answer.' : valid.error };
		}
		const candidateIds =
			prompt.candidateInstanceIds ??
			(choice.kind === 'orderObjects' ? choice.objectIds : []);
		const extracted: CardInstance[] = [];
		for (const cid of candidateIds) {
			const c = actor.library.find((l) => l.instanceId === cid);
			if (c && !extracted.includes(c)) extracted.push(c);
		}
		const byId = new Map(extracted.map((c) => [c.instanceId, c]));
		const usedIds = new Set<string>();
		const topList: CardInstance[] = [];
		const bottomList: CardInstance[] = [];
		const allowBottom =
			choice.kind === 'orderObjects'
				? choice.allowSplitBottom !== false
				: prompt.allowBottom !== false;
		const allowShuffle =
			choice.kind === 'orderObjects'
				? Boolean(choice.allowShuffle)
				: Boolean(prompt.allowShuffle);

		for (const tid of normalized.answer.topIds || []) {
			const card = byId.get(tid);
			if (card && !usedIds.has(tid)) {
				topList.push(card);
				usedIds.add(tid);
			}
		}
		if (allowBottom) {
			for (const bid of normalized.answer.bottomIds || []) {
				const card = byId.get(bid);
				if (card && !usedIds.has(bid)) {
					bottomList.push(card);
					usedIds.add(bid);
				}
			}
		}
		// Any remaining extracted cards not explicitly placed go on top in their original relative order
		for (const c of extracted) {
			if (!usedIds.has(c.instanceId)) {
				topList.push(c);
				usedIds.add(c.instanceId);
			}
		}

		rearrangeLibrary(actor, extracted, topList, bottomList);

		if (allowShuffle && normalized.answer.shuffle) {
			shuffleLibrary(state, actor);
			addLog(
				state,
				'rule',
				`${actor.username} looked at the top ${extracted.length} card(s) and chose to shuffle their library.`,
				actor.playerId
			);
		} else if (!allowBottom) {
			addLog(
				state,
				'rule',
				`${actor.username} rearranged the top ${extracted.length} card(s) of their library.`,
				actor.playerId
			);
		} else {
			addLog(
				state,
				'rule',
				`${actor.username} scried ${extracted.length} (${topList.length} on top, ${bottomList.length} on bottom).`,
				actor.playerId
			);
		}

		state.pendingPrompts.splice(promptIdx, 1);
		resumeAfterPrompt(state, prompt);
		return { ok: true };
	}

	if (purpose === 'guided_resolution') {
		if (normalized.cancel && prompt.cancellable) {
			state.pendingPrompts.splice(promptIdx, 1);
			return { ok: true };
		}
		const valid = validateChoiceAnswer(choice, normalized.answer);
		if (!valid.ok || normalized.answer?.kind !== 'yesNo' || !normalized.answer.yes) {
			return { ok: false, error: valid.ok ? 'Invalid guided resolution answer.' : valid.error };
		}
		const ops = normalized.operations ?? [];
		const opsValid = validateGuidedOperations(state, actor, ops);
		if (!opsValid.ok) return opsValid;
		const c = prompt.continuation;
		state.pendingPrompts.splice(promptIdx, 1);
		applyGuidedOperations(state, actor, ops);
		if (c?.kind === 'manual_resolution') {
			const item = state.stack.find((s) => s.id === c.stackItemId);
			addLog(state, 'cast', `${actor.username} resolved ${item?.title ?? prompt.title} manually${ops.length > 0 ? ` (${ops.length} operation${ops.length === 1 ? '' : 's'})` : ''}.`, actor.playerId);
			if (item) {
				item.manualResolution = 'done';
				resumeStackItem(state, item);
			}
			return { ok: true };
		}
		if (c?.kind === 'manual_ability') {
			addLog(state, 'cast', `${actor.username} applied an ability of ${prompt.title.replace(/^Resolve Manually: /, '')} manually${ops.length > 0 ? ` (${ops.length} operation${ops.length === 1 ? '' : 's'})` : ''}.`, actor.playerId);
		} else {
			addLog(state, 'cast', `${actor.username} completed guided resolution for ${prompt.title}.`, actor.playerId);
		}
		checkStateBasedActions(state);
		return { ok: true };
	}

	// Step E2: a paused IR resolution waiting for this player's choice (sacrifice, discard).
	if (prompt.continuation?.kind === 'effect_choice') {
		const valid = validateChoiceAnswer(choice, normalized.answer);
		if (!valid.ok || normalized.answer?.kind !== 'chooseObjects') {
			return { ok: false, error: valid.ok ? 'Choose the required objects.' : valid.error };
		}
		const c = prompt.continuation;
		state.pendingPrompts.splice(promptIdx, 1);
		const item = state.stack.find((s) => s.id === c.stackItemId);
		if (!item?.effectResume || item.effectResume.stepIndex !== c.stepIndex) return { ok: true };
		item.effectResume.answers[actor.playerId] = normalized.answer.objectIds;
		resumeStackItem(state, item);
		return { ok: true };
	}

	// Standalone generic choice prompt (yesNo, chooseObjects, chooseMode, chooseNumber, chooseReplacement)
	if (normalized.cancel && prompt.cancellable) {
		state.pendingPrompts.splice(promptIdx, 1);
		return { ok: true };
	}
	const valid = validateChoiceAnswer(choice, normalized.answer);
	if (!valid.ok || !normalized.answer) {
		return { ok: false, error: valid.ok ? 'Missing choice answer.' : valid.error };
	}
	state.pendingPrompts.splice(promptIdx, 1);
	// A generic prompt continues only through a named handler (plain data). Without one, answering
	// just records the answer in the log.
	if (!runPromptHandler(state, prompt, normalized.answer)) {
		addLog(state, 'rule', `${actor.username} answered "${prompt.title}".`, actor.playerId);
	}
	checkStateBasedActions(state);
	return { ok: true };
}

/**
 * Step E2: a scry or search prompt queued by an IR step that wasn't the ability's last. Once every
 * such prompt of the item is answered, its resolution goes on at the next step.
 */
function resumeAfterPrompt(state: GameState, prompt: PendingPrompt): void {
	const c = prompt.continuation;
	if (c?.kind !== 'effect_resume') return;
	const item = state.stack.find((s) => s.id === c.stackItemId);
	if (!item?.effectResume || item.effectResume.stepIndex !== c.stepIndex) return;
	resumeStackItem(state, item);
}

// ---- Step E2: guided (manual) operations ------------------------------------------------------

const GUIDED_MAX_AMOUNT = 100;
const GUIDED_ZONES: ReadonlySet<ZoneType> = new Set<ZoneType>(['battlefield', 'graveyard', 'exile', 'hand', 'library', 'command']);

/** Any card in any player's zones (not the stack). */
function findCardAnywhere(state: GameState, id: string): { inst: CardInstance; holder: PlayerGameState; zone: ZoneType } | null {
	for (const zone of ['battlefield', 'graveyard', 'exile', 'hand', 'library', 'command'] as const) {
		for (const p of state.players) {
			const inst = p[zone].find((c) => c.instanceId === id);
			if (inst) return { inst, holder: p, zone };
		}
	}
	return null;
}

/** Server-side check of a guided resolution's operations (the client is not trusted). */
function validateGuidedOperations(state: GameState, actor: PlayerGameState, ops: GuidedOperation[]): { ok: true } | { ok: false; error: string } {
	if (!Array.isArray(ops)) return { ok: false, error: 'Operations must be a list.' };
	if (ops.length > 50) return { ok: false, error: 'Too many operations.' };
	for (const op of ops) {
		const amount = op.amount ?? 0;
		if (!Number.isInteger(amount) || Math.abs(amount) > GUIDED_MAX_AMOUNT) {
			return { ok: false, error: `Amounts must be whole numbers up to ${GUIDED_MAX_AMOUNT}.` };
		}
		const player = op.targetId ? state.players.find((p) => p.playerId === op.targetId) : undefined;
		const card = op.targetId ? findCardAnywhere(state, op.targetId) : null;
		// Only cards the player can see: public zones and their own hand (never a library or another
		// player's hand).
		if (card && (card.zone === 'library' || (card.zone === 'hand' && card.holder.playerId !== actor.playerId))) {
			return { ok: false, error: 'You can only act on cards you can see.' };
		}
		switch (op.op) {
			case 'draw_cards':
			case 'mill':
				if (amount < 0) return { ok: false, error: 'Card counts cannot be negative.' };
				if (op.targetId && !player) return { ok: false, error: 'Choose a player.' };
				break;
			case 'modify_life':
				if (!player) return { ok: false, error: 'Choose a player whose life changes.' };
				break;
			case 'deal_damage':
				if (amount < 0) return { ok: false, error: 'Damage cannot be negative.' };
				if (!player && card?.zone !== 'battlefield') return { ok: false, error: 'Choose a player or permanent to damage.' };
				break;
			case 'move_zone':
				if (!card) return { ok: false, error: 'Choose a card to move.' };
				if (!op.destinationZone || !GUIDED_ZONES.has(op.destinationZone)) return { ok: false, error: 'Choose a destination zone.' };
				break;
			case 'add_counter':
				if (card?.zone !== 'battlefield') return { ok: false, error: 'Choose a permanent for the counters.' };
				if (!op.counterType || !(op.counterType in card.inst.counters)) return { ok: false, error: 'Choose a counter type.' };
				break;
			case 'tap':
			case 'untap':
				if (card?.zone !== 'battlefield') return { ok: false, error: 'Choose a permanent to tap or untap.' };
				break;
			case 'create_token':
				if (amount < 0 || amount > 20) return { ok: false, error: 'Create between 1 and 20 tokens.' };
				if ((op.tokenPower ?? 0) < 0 || (op.tokenToughness ?? 0) < 0) return { ok: false, error: 'Token power and toughness cannot be negative.' };
				break;
			default:
				return { ok: false, error: 'Unknown operation.' };
		}
	}
	return { ok: true };
}

/**
 * Applies a guided resolution's operations, each through the normal engine primitive (zone moves
 * through moveObject, damage through the damage pipeline, ...), in order. Validated beforehand.
 */
function applyGuidedOperations(state: GameState, actor: PlayerGameState, ops: GuidedOperation[]): void {
	for (const op of ops) {
		const amount = op.amount ?? 0;
		const player = op.targetId ? state.players.find((p) => p.playerId === op.targetId) : undefined;
		const found = op.targetId ? findCardAnywhere(state, op.targetId) : null;
		switch (op.op) {
			case 'draw_cards':
				if (amount > 0) drawCards(state, player ?? actor, amount);
				break;
			case 'mill': {
				const who = player ?? actor;
				const n = Math.min(amount, who.library.length);
				for (let i = 0; i < n; i++) {
					moveObject(state, who.library[0], 'graveyard', {
						from: { player: who, zone: 'library' },
						toPlayer: who,
						graveyardReplacement: true,
						bumpVersion: true,
						newTimestamp: true
					});
				}
				if (n > 0) addLog(state, 'rule', `${who.username} milled ${n} card(s) (manual).`, actor.playerId);
				break;
			}
			case 'modify_life':
				if (player && amount !== 0 && !player.lifeTotalCannotChangeThisTurn) {
					player.life += amount;
					addLog(state, 'life', `${player.username} ${amount > 0 ? 'gained' : 'lost'} ${Math.abs(amount)} life (manual).`, actor.playerId);
				}
				break;
			case 'deal_damage':
				if (amount > 0) {
					applyDamageToTarget(
						state,
						actor.playerId,
						player
							? { kind: 'player', id: player.playerId, label: player.username }
							: { kind: 'permanent', id: op.targetId!, label: found?.inst.card.name ?? 'target' },
						amount
					);
				}
				break;
			case 'move_zone': {
				if (!found || !op.destinationZone || found.zone === op.destinationZone) break;
				const dest = op.destinationZone;
				if (found.zone === 'battlefield') {
					movePermanentToZone(state, found.inst, dest);
				} else {
					const owner = state.players.find((p) => p.playerId === found.inst.ownerId) ?? found.holder;
					const toPlayer = dest === 'battlefield' ? actor : owner;
					if (dest === 'battlefield') found.inst.summoningSick = found.inst.card.typeLine.includes('Creature');
					moveObject(state, found.inst, dest, {
						from: { player: found.holder, zone: found.zone as Exclude<ZoneType, 'stack'> },
						toPlayer,
						...(dest === 'battlefield' ? { controllerId: actor.playerId } : {}),
						bumpVersion: true,
						newTimestamp: true
					});
				}
				addLog(state, 'rule', `${found.inst.card.name} was moved from ${found.zone} to ${dest} (manual).`, actor.playerId);
				if (dest === 'battlefield') flushTriggers(state);
				break;
			}
			case 'add_counter':
				if (found && op.counterType) {
					if (amount > 0) addCountersToPermanent(state, found.inst, op.counterType, amount);
					else if (amount < 0) found.inst.counters[op.counterType] = Math.max(0, (found.inst.counters[op.counterType] ?? 0) + amount);
					addLog(state, 'rule', `${found.inst.card.name}: ${amount > 0 ? '+' : ''}${amount} ${op.counterType} counter(s) (manual).`, actor.playerId);
				}
				break;
			case 'tap':
			case 'untap':
				if (found) {
					found.inst.tapped = op.op === 'tap';
					addLog(state, 'rule', `${found.inst.card.name} was ${op.op === 'tap' ? 'tapped' : 'untapped'} (manual).`, actor.playerId);
				}
				break;
			case 'create_token':
				for (let i = 0; i < Math.max(1, amount); i++) {
					const power = op.tokenPower ?? 0;
					const toughness = op.tokenToughness ?? 0;
					const isCreature = op.tokenPower !== undefined || op.tokenToughness !== undefined;
					createTokenOnBoard(state, actor, {
						name: (op.tokenName ?? '').trim().slice(0, 40) || 'Token',
						power,
						toughness,
						colors: [],
						typeLine: isCreature ? 'Token Creature' : 'Token Artifact',
						keywords: []
					});
				}
				addLog(state, 'rule', `${actor.username} created ${Math.max(1, amount)} token(s) (manual).`, actor.playerId);
				break;
		}
	}
}

function getAttackedDefenderIdsInTurnOrder(state: GameState): string[] {
	const attackedSet = new Set(state.combat.attackers.map((a) => a.defenderPlayerId));
	const ordered: string[] = [];
	const count = state.players.length;
	for (let step = 1; step <= count; step++) {
		const p = state.players[(state.activePlayerIndex + step) % count];
		if (p && !p.lost && attackedSet.has(p.playerId)) {
			ordered.push(p.playerId);
		}
	}
	return ordered;
}

function advancePriorityToNextPlayer(state: GameState): void {
	const count = state.players.length;
	for (let step = 1; step <= count; step++) {
		const idx = (state.priorityPlayerIndex + step) % count;
		const candidate = state.players[idx];
		if (!candidate.lost) {
			state.priorityPlayerIndex = idx;
			return;
		}
	}
}

export function moveStackSpellToZone(
	state: GameState,
	stackItem: StackItem,
	dest: 'graveyard' | 'exile'
): void {
	if (stackItem.kind !== 'spell' || stackItem.isCopy) return;
	const ownerId = stackItem.ownerId || stackItem.controllerId;
	const owner =
		state.players.find((p) => p.playerId === ownerId) ||
		state.players.find((p) => p.playerId === stackItem.controllerId);
	if (!owner) return;

	const isCmd = owner.commanderNames[stackItem.sourceInstanceId] !== undefined;
	const castCount =
		owner.commanderCastCounts?.[stackItem.sourceInstanceId] ??
		stackItem.commanderCastCount ??
		0;
	const actualDest =
		dest === 'exile' ? 'exile' : checkGraveyardReplacementZone(state, 'graveyard').dest;
	const cardInst = createCardInstance(
		stackItem.card,
		owner.playerId,
		actualDest,
		isCmd,
		false,
		allocateTimestamp(state)
	);
	cardInst.instanceId = stackItem.sourceInstanceId;
	cardInst.commanderCastCount = castCount;
	moveObject(state, cardInst, actualDest, { from: 'stack', toPlayer: owner });
}

export function addCountersToPermanent(
	state: GameState,
	perm: CardInstance,
	type: CounterType,
	amount: number
): number {
	if (amount <= 0) return 0;
	const effectiveAmount = amount * counterMultiplier(state, perm, type);
	perm.counters[type] = (perm.counters[type] || 0) + effectiveAmount;
	emitEvent(state, {
		kind: 'CounterPlaced',
		objectId: perm.instanceId,
		object: perm,
		counterType: type,
		amount: effectiveAmount
	});
	// "Whenever a +1/+1 counter is put on ~" ran here before Phase 5; keep that timing.
	flushTriggers(state);
	return effectiveAmount;
}

/**
 * CR 702.62a suspend: at the beginning of its owner's upkeep, remove a time counter from each
 * suspended card in exile; when the last is removed, cast it. A keyword rule, run from PhaseBegin
 * before triggered abilities are matched (it was step 2a of the old upkeep loop).
 */
function runSuspendUpkeep(state: GameState, activePlayer: PlayerGameState): void {
	const suspendedCards = activePlayer.exile.filter(
		(c) => c.isSuspended && (c.counters.time || 0) > 0
	);
	for (const susp of suspendedCards) {
		susp.counters.time = Math.max(0, (susp.counters.time || 0) - 1);
		addLog(
			state,
			'trigger',
			`Suspend (CR 702.62): Removed a time counter from ${susp.card.name} (${susp.counters.time} remaining).`,
			activePlayer.playerId
		);
		if (susp.counters.time === 0) {
			executeSuspendFreeCastFromExile(state, activePlayer, susp);
		}
	}
}

/**
 * Delayed end-step triggers created by resolving effects (Final Fortune, Corpse Dance). These are
 * stored in state with their own legacy effects, not compiled from a card's abilities; Phase 3's
 * delayed effects replace them. Pushed after the beginning-of-end-step triggers, as before.
 */
function runDelayedTriggers(state: GameState, phase: GamePhase, activePlayer: PlayerGameState): void {
	if (state.delayedTriggers && state.delayedTriggers.length > 0) {
		const remainingDelayed: DelayedTrigger[] = [];
		for (const dt of state.delayedTriggers) {
			const matchesTurn =
				(!dt.targetPlayerId || dt.targetPlayerId === activePlayer.playerId) &&
				(!dt.waitUntilAfterTurn || state.turnNumber > dt.waitUntilAfterTurn) &&
				dt.notDuringTurn !== `${state.turnNumber}:${state.activePlayerIndex}`;
			if (dt.triggerPhase === phase && matchesTurn) {
				const targets: TargetRef[] = [];
				if (dt.targetInstanceId) {
					const found = findPermanentOnBoard(state, dt.targetInstanceId);
					if (
						found &&
						(dt.targetObjectVersion === undefined ||
							found.inst.objectVersion === dt.targetObjectVersion)
					) {
						targets.push({
							kind: 'permanent',
							id: found.inst.instanceId,
							label: found.inst.card.name
						});
					}
				}
				const delayedEffect: DelayedTriggerEffect | undefined =
					dt.delayedEffect ??
					(dt.targetInstanceId
						? {
								kind: 'exile',
								targetInstanceId: dt.targetInstanceId,
								targetObjectVersion: dt.targetObjectVersion
							}
						: undefined);
				const stkItem: StackItem = withStackItemText(
					{
						id: uid('stk', state),
						sourceInstanceId: dt.id,
						card: dt.sourceCard,
						controllerId: dt.controllerId,
						kind: 'triggered',
						title: `${dt.sourceCard.name} (${phase === 'upkeep' ? 'Delayed Upkeep Trigger' : 'Delayed End Step Trigger'})`,
						targets,
						targetObjectVersions: captureTargetObjectVersions(state, targets),
						xValue: 0,
						...(delayedEffect ? { delayedEffect } : {}),
						requiresGuidedResolution: false,
						createdAt: Date.now()
					},
					dt.description || ''
				);
				state.stack.push(stkItem);
				addLog(
					state,
					'trigger',
					`Delayed trigger from ${dt.sourceCard.name} went onto the Stack: "${dt.description}"`,
					dt.controllerId
				);
			} else {
				remainingDelayed.push(dt);
			}
		}
		state.delayedTriggers = remainingDelayed;
	}
}

/**
 * Sets the current phase/step and emits PhaseBegin. `activePlayer` defaults to the player at
 * `activePlayerIndex`; enterEndStep passes the player it was given.
 */
function beginPhase(state: GameState, phase: GamePhase, activePlayer?: PlayerGameState): void {
	state.phase = phase;
	const active = activePlayer ?? state.players[state.activePlayerIndex];
	// CR 703.3: Turn-based actions at the beginning of a step happen FIRST, before any
	// "At the beginning of [step]" triggers go onto the stack. Triggers from the turn-based action
	// (combat damage) wait until state-based actions have been checked (CR 704.3, 603.3).
	withTriggersDeferred(state, () => {
		if (phase === 'untap' && active) {
			executeUntapTurnBasedActions(state, active);
		} else if (phase === 'draw' && active) {
			executeDrawTurnBasedAction(state, active);
		} else if (phase === 'first_strike_damage') {
			executeCombatDamageStep(state, true);
		} else if (phase === 'combat_damage') {
			executeCombatDamageStep(state, false);
		} else if (phase === 'cleanup') {
			clearEndOfTurnAndDamage(state);
		}
		if (phase === 'first_strike_damage' || phase === 'combat_damage') {
			checkStateBasedActions(state);
		}
	});
	if (state.status === 'finished') return;
	emitEvent(state, {
		kind: 'PhaseBegin',
		phase,
		activePlayerId: active?.playerId ?? null
	});
	// Triggered abilities go on the stack now: the callers check the stack right after this.
	flushTriggers(state);
}

// Event dispatch (Phase 5). Every event is matched against compiled triggered abilities
// (runtime/triggers.ts); matches wait for the next flushTriggers. PhaseBegin also runs the suspend
// keyword (before matching, as the old upkeep loop did) and delayed end-step triggers (after the
// beginning-of-end-step triggers are on the stack).
for (const kind of [
	'Cast',
	'SpellCopied',
	'AttackDeclared',
	'BlockersDeclared',
	'DamageDealt',
	'CounterPlaced',
	'BecameTarget',
	'Attached',
	'TappedForMana'
] as const) {
	registerEventHandler(kind, (state, ev) => matchTriggers(state, ev));
}
registerEventHandler('ZoneChange', (state, ev) => {
	matchTriggers(state, ev);
	if (ev.to === 'battlefield' && !ev.ceasedToExist) noteUnautomatedOnEnter(state, ev.object);
});

/**
 * Step E2 (plan section 2.7): when a permanent enters, say once which of its abilities the engine
 * won't act on: statics and replacement effects that aren't enforced, and triggered abilities whose
 * trigger it can't recognise (players apply those by hand, e.g. with "Resolve manually"). Logged on
 * entering only, never from state-based actions or layer evaluation. Display text only.
 */
function noteUnautomatedOnEnter(state: GameState, obj: CardInstance): void {
	if (obj.isFaceDown) return;
	const card = obj.copiableCard ?? obj.card;
	for (const n of enteringNotices(card)) {
		addLog(
			state,
			'rule',
			n.kind === 'triggerUnrecognised'
				? `${card.name} has an ability that isn't automated: ${n.text}`
				: `${card.name}: '${n.text}' is not enforced.`,
			obj.controllerId
		);
	}
}

registerEventHandler('PhaseBegin', (state, ev) => {
	const activePlayer = state.players.find((p) => p.playerId === ev.activePlayerId);
	if (ev.phase === 'upkeep' && activePlayer) runSuspendUpkeep(state, activePlayer);
	matchTriggers(state, ev);
	if ((ev.phase === 'end_step' || ev.phase === 'upkeep') && activePlayer) {
		flushTriggers(state);
		runDelayedTriggers(state, ev.phase, activePlayer);
	}
});

/** How the trigger's event object last existed on the battlefield (CR 603.10a, 608.2h). */
function triggerEventLki(state: GameState, t: PendingTrigger): TriggerEventLki | undefined {
	const obj = t.eventObject ?? t.source;
	const onBattlefield = findPermanentOnBoard(state, obj.instanceId);
	if (onBattlefield && onBattlefield.inst.objectVersion === obj.objectVersion) {
		const ev = evaluatePermanent(state, onBattlefield.inst);
		return {
			controllerId: onBattlefield.controller.playerId,
			ownerId: obj.ownerId,
			power: ev.power,
			toughness: ev.toughness,
			manaValue: obj.card.cmc
		};
	}
	const lki = t.eventLki;
	return {
		controllerId: lki?.controllerId ?? obj.controllerId,
		ownerId: obj.ownerId,
		power: lki?.power ?? obj.lastKnownPower ?? (parseInt(obj.card.power ?? '0', 10) || 0),
		toughness: lki?.toughness ?? obj.lastKnownToughness ?? (parseInt(obj.card.toughness ?? '0', 10) || 0),
		manaValue: obj.card.cmc
	};
}

/**
 * Builds the stack item for a triggered ability (also the "dummy" item an inline trigger resolves
 * with). The event the ability refers to is recorded in the `event*` fields, never in `targets`
 * ("that creature", "that player", "that many"; CR 603.7c); `eventObjectId` defaults to the source
 * ("When ~ enters, ... it ..."). `targets` holds only the targets chosen for the ability.
 */
function triggeredStackItem(state: GameState, t: PendingTrigger, idPrefix: string): StackItem {
	const foundSource = findPermanentOnBoard(state, t.source.instanceId);
	const sourceEval = foundSource ? evaluatePermanent(state, foundSource.inst) : undefined;
	const sourceLkiPower = sourceEval?.power ?? t.source.lastKnownPower;
	const sourceLkiToughness = sourceEval?.toughness ?? t.source.lastKnownToughness;
	const eventObj = t.eventObject ?? t.source;
	return withStackItemText(
		{
			id: uid(idPrefix, state),
			sourceInstanceId: t.source.instanceId,
			sourceObjectVersion: t.source.objectVersion,
			sourceLkiPower,
			sourceLkiToughness,
			card: t.sourceCard,
			controllerId: t.controllerId,
			kind: 'triggered',
			title: `${t.sourceCard.name} (${t.label})`,
			targets: [],
			xValue: 0,
			requiresGuidedResolution: false,
			createdAt: Date.now(),
			lkiPower: t.amount,
			triggeredAbilityIndex: t.ability.abilityIndex,
			eventObjectId: eventObj.instanceId,
			eventObjectVersion: eventObj.objectVersion,
			...(t.eventPlayer ? { eventPlayerId: t.eventPlayer } : {}),
			...(t.amount !== undefined ? { eventAmount: t.amount } : {}),
			...(t.targetStackItemId ? { eventStackItemId: t.targetStackItemId } : {}),
			eventLki: triggerEventLki(state, t)
		},
		t.ability.text
	);
}

/**
 * How many triggered abilities resolved on each path since the last reset (module-level, never in
 * GameState). For tests and diagnostics only.
 */
const triggerPathCounts = { interpreter: 0, manual: 0 };

export function triggerResolutionCounts(reset = false): { interpreter: number; manual: number } {
	const out = { ...triggerPathCounts };
	if (reset) {
		triggerPathCounts.interpreter = 0;
		triggerPathCounts.manual = 0;
	}
	return out;
}

/** The compiled IR effect of a triggered stack item, or null (no compiled effect: legacy only). */
function triggerItemEffect(item: StackItem) {
	if (item.kind !== 'triggered' || item.triggeredAbilityIndex === undefined) return null;
	return compiledTriggerEffect(item.card, item.triggeredAbilityIndex);
}

/** The interpreter's EffectContext fields for a triggered ability's event (CR 603.7c). */
function triggerEventContext(item: StackItem) {
	return {
		eventObjectId: item.eventObjectId,
		eventObjectVersion: item.eventObjectVersion,
		eventPlayerId: item.eventPlayerId,
		eventAmount: item.eventAmount,
		eventLki: item.eventLki
	};
}

/**
 * Executes a triggered ability's effect: on the IR interpreter when its compiled effect is
 * interpretable, otherwise on the legacy ParsedEffect path (with the legacy event target, as the
 * pre-IR engine passed it). Used by inline triggers; stacked ones go through resolveTopOfStack,
 * which makes the same choice.
 */
function executeTriggerEffects(state: GameState, controller: PlayerGameState, item: StackItem): void {
	const compiled = triggerItemEffect(item);
	if (compiled && staticallyInterpretable(compiled) && interpretableNow(state, item, compiled, controller, false)) {
		triggerPathCounts.interpreter++;
		executeEffectSteps(
			state,
			{
				controller,
				sourceId: item.sourceInstanceId,
				sourceCard: item.card,
				title: item.title,
				item,
				targets: item.targets,
				targetSpecs: compiled.targets,
				xValue: item.xValue,
				...triggerEventContext(item)
			},
			compiled.steps
		);
		return;
	}
	// Not automated: an inline trigger (a triggered mana ability) can't be resolved manually.
	triggerPathCounts.manual++;
	addLog(state, 'rule', `${item.title} isn't automated and did nothing.`, controller.playerId);
}

registerTriggerHost({
	executeInline(state, t) {
		const controller = state.players.find((p) => p.playerId === t.controllerId);
		if (!controller) return;
		executeTriggerEffects(state, controller, triggeredStackItem(state, t, 'trg'));
		addLog(
			state,
			'trigger',
			`${t.sourceCard.name} (${t.label}) triggered for ${controller.username}.`,
			controller.playerId
		);
	},
	putOnStack: putTriggerOnStack,
	orderSimultaneous: askTriggerOrder
	// Step E2: no `canExecute` filter. Every matched ability triggers; one the engine can't run is
	// resolved manually (human) or by its legacy effects / skipped (bot) as it resolves.
});

/**
 * A runaway safety cap: triggered abilities that keep retriggering each other would otherwise grow
 * the stack (and the bot loop) without end. Past this size new triggers are not put on the stack.
 */
const MAX_STACK_FOR_TRIGGERS = 300;
/**
 * The other runaway shape: each resolution triggers exactly one new ability ("Whenever another
 * creature you control enters, create a 1/1 token"), so the stack stays shallow forever. Past this
 * many triggered abilities in one turn, new ones are not put on the stack.
 */
export const MAX_TRIGGERS_PER_TURN = 200;

/** Target specs the trigger target choice supports (zones it can enumerate). */
function triggerSpecsSupported(specs: TargetSpec[]): boolean {
	return specs.every((sp) => {
		if (sp.kind === 'player') return true;
		const z = sp.filter.zone ?? 'battlefield';
		return z === 'battlefield' || z === 'graveyard';
	});
}

/** The target specs a triggered stack item chooses on the interpreter path (empty: none / legacy). */
function triggerItemTargetSpecs(item: StackItem): TargetSpec[] {
	const compiled = triggerItemEffect(item);
	if (!compiled || !staticallyInterpretable(compiled, true) || !triggerSpecsSupported(compiled.targets)) return [];
	return compiled.targets;
}

/** The object a triggered ability's source is (wherever it is now), for "another" filters. */
function triggerSourceObject(state: GameState, item: StackItem): CardInstance | undefined {
	for (const p of state.players) {
		for (const zone of [p.battlefield, p.graveyard, p.exile, p.hand, p.command, p.library]) {
			const c = zone.find((x) => x.instanceId === item.sourceInstanceId);
			if (c) return c;
		}
	}
	return undefined;
}

/** Whether a permanent can be targeted by an ability of `controllerId` from `sourceCard` (CR 702.11, 702.18, 702.16). */
function permanentTargetable(state: GameState, inst: CardInstance, controllerId: string, owner: string, sourceCard: ScryfallCard): boolean {
	if (hasKeyword(inst, 'Shroud', state)) return false;
	if (owner !== controllerId && hasKeyword(inst, 'Hexproof', state)) return false;
	return !hasProtectionFrom(inst, sourceCard, state);
}

/** Every legal target for one target spec (CR 115, 603.3d). */
export function specTargetCandidates(
	state: GameState,
	controllerId: string,
	sourceCard: ScryfallCard,
	source: CardInstance | undefined,
	spec: TargetSpec
): TargetRef[] {
	const out: TargetRef[] = [];
	if (spec.kind === 'player' || spec.kind === 'objectOrPlayer') {
		const rel = spec.player?.relation ?? 'any';
		for (const p of state.players) {
			if (p.lost) continue;
			if ((rel === 'opponent' || rel === 'each_opponent') && p.playerId === controllerId) continue;
			if (rel === 'you' && p.playerId !== controllerId) continue;
			if (playerHasShroud(state, p) || playerHasHexproofFrom(state, p, controllerId)) continue;
			out.push({ kind: 'player', id: p.playerId, label: p.username });
		}
	}
	if (spec.kind === 'player') return out;
	const ctx: FilterContext = { state, controllerId, source };
	const zone = spec.filter.zone ?? 'battlefield';
	if (zone === 'stack') {
		for (const stk of state.stack) {
			if (source && stk.sourceInstanceId === source.instanceId) continue;
			if (spec.filter.types && spec.filter.types.length > 0 && stk.card) {
				const stkTypes = compileCard(stk.card).faces[0].characteristics.types;
				if (!spec.filter.types.some((t) => stkTypes.includes(t))) continue;
			}
			out.push({ kind: 'stack', id: stk.id, label: stk.title });
		}
		return out;
	}
	for (const p of state.players) {
		if (p.lost) continue;
		if (zone === 'battlefield') {
			for (const perm of p.battlefield) {
				if (perm.phasedOut || !matchesObjectFilter(perm, spec.filter, ctx)) continue;
				if (!permanentTargetable(state, perm, controllerId, p.playerId, sourceCard)) continue;
				out.push({ kind: 'permanent', id: perm.instanceId, label: perm.card.name });
			}
		} else if (zone === 'graveyard') {
			for (const c of p.graveyard) {
				if (matchesObjectFilter(c, spec.filter, ctx)) out.push({ kind: 'graveyard_card', id: c.instanceId, label: c.card.name });
			}
		}
	}
	return out;
}

/** Every legal target for one target spec of a triggered ability (CR 115, 603.3d). */
function triggerTargetCandidates(state: GameState, item: StackItem, spec: TargetSpec): TargetRef[] {
	return specTargetCandidates(state, item.controllerId, item.card, triggerSourceObject(state, item), spec);
}

/** CR 608.2b for a triggered ability on the interpreter path: is `t` still legal for some spec? */
function triggerTargetStillLegal(state: GameState, item: StackItem, specs: TargetSpec[], t: TargetRef): boolean {
	return specs.some((spec) => triggerTargetCandidates(state, item, spec).some((c) => c.kind === t.kind && c.id === t.id));
}

/**
 * Puts a triggered ability on the stack (CR 603.3), choosing its targets from the compiled target
 * specs (CR 603.3d): a bot chooses via ai.ts; a human gets a chooseObjects prompt (unless the choice
 * is forced). An ability with a required target and no legal one is removed, with a log line.
 */
function putTriggerOnStack(state: GameState, t: PendingTrigger): StackItem | null {
	if (state.stack.length >= MAX_STACK_FOR_TRIGGERS) {
		addLog(
			state,
			'rule',
			`${t.sourceCard.name}'s ${t.label} was not put onto the Stack: the stack already holds ${state.stack.length} objects (runaway trigger loop safety cap).`,
			t.controllerId
		);
		return null;
	}
	const placed =
		state.triggersPlacedThisTurn?.turn === state.turnNumber ? state.triggersPlacedThisTurn : { turn: state.turnNumber, count: 0 };
	state.triggersPlacedThisTurn = placed;
	if (placed.count >= MAX_TRIGGERS_PER_TURN) {
		if (placed.count === MAX_TRIGGERS_PER_TURN) {
			addLog(
				state,
				'rule',
				`Triggered abilities are no longer put onto the Stack this turn: ${MAX_TRIGGERS_PER_TURN} already were (runaway trigger loop safety cap).`,
				t.controllerId
			);
			placed.count++;
		}
		return null;
	}
	const controller = state.players.find((p) => p.playerId === t.controllerId);
	if (!controller) return null;
	const item = triggeredStackItem(state, t, 'stk');
	const specs = triggerItemTargetSpecs(item);
	const candidates = specs.map((spec) => triggerTargetCandidates(state, item, spec));
	const impossible = specs.findIndex((spec, i) => spec.min > 0 && candidates[i].length < spec.min);
	if (impossible >= 0) {
		addLog(
			state,
			'rule',
			`${item.title} was removed from the Stack: it has no legal targets (CR 603.3d).`,
			t.controllerId
		);
		return null;
	}
	state.stack.push(item);
	placed.count++;
	addLog(state, 'trigger', `${t.sourceCard.name}'s ${t.label} was put onto the Stack.`, t.controllerId);
	const steps = triggerItemEffect(item)?.steps ?? [];
	specs.forEach((spec, i) => {
		const legal = candidates[i];
		const max = Math.min(spec.max, legal.length);
		if (controller.isBot) {
			item.targets.push(...chooseBotTriggerTargets(state, controller, steps, i, spec, legal));
		} else if (legal.length === spec.min && max === spec.min) {
			// Forced: exactly as many legal targets as required.
			item.targets.push(...legal);
		} else {
			const reason = `Choose ${spec.min === max ? max : `${spec.min}–${max}`} target(s) for ${item.title}.`;
			enqueueChoicePrompt(state, {
				id: uid('prm', state),
				playerId: controller.playerId,
				kind: 'chooseObjects',
				purpose: 'trigger_targets',
				title: `Choose Targets (${item.card.name})`,
				description: `${reason} (Its text is shown on the stack.)`,
				triggerStackItemId: item.id,
				triggerTargetSpecIndex: i,
				candidateInstanceIds: legal.map((c) => c.id),
				countRequired: spec.min,
				choice: {
					kind: 'chooseObjects',
					candidates: legal.map((c) => c.id),
					min: spec.min,
					max,
					zone: (spec.filter.zone as ZoneType | undefined) ?? 'battlefield',
					reason
				}
			});
		}
	});
	item.targetObjectVersions = captureTargetObjectVersions(state, item.targets);
	return item;
}

/**
 * CR 603.3b: a human who controls several simultaneous triggered abilities chooses their order on
 * the stack (an orderObjects prompt; `topIds[0]` resolves first). Bots keep the match order.
 */
function askTriggerOrder(state: GameState, controllerId: string, itemIds: string[]): void {
	const controller = state.players.find((p) => p.playerId === controllerId);
	if (!controller || controller.isBot) return;
	const topFirst = [...itemIds].reverse();
	const reason = 'Order your triggered abilities: the first one resolves first.';
	enqueueChoicePrompt(state, {
		id: uid('prm', state),
		playerId: controllerId,
		kind: 'orderObjects',
		purpose: 'trigger_order',
		title: 'Order Triggered Abilities',
		description: reason,
		candidateInstanceIds: topFirst,
		choice: { kind: 'orderObjects', objectIds: topFirst, allowSplitBottom: false, allowShuffle: false, reason }
	});
}

/** Answers to the trigger prompts (targets, order, "you may"); plain data, no callbacks. */
function resolveTriggerPrompt(
	state: GameState,
	prompt: PendingPrompt,
	promptIdx: number,
	answer: ChoiceAnswer | undefined
): { ok: boolean; error?: string } {
	const choice = effectivePromptChoice(prompt, state);
	const valid = validateChoiceAnswer(choice, answer);
	if (!valid.ok) return { ok: false, error: valid.error };
	const purpose = effectivePromptPurpose(prompt);
	if (purpose === 'trigger_order') {
		if (answer?.kind !== 'orderObjects') return { ok: false, error: 'Order your triggered abilities.' };
		const ids = choice.kind === 'orderObjects' ? choice.objectIds : [];
		if (answer.topIds.length !== ids.length || (answer.bottomIds?.length ?? 0) > 0) {
			return { ok: false, error: 'Put every triggered ability in order.' };
		}
		state.pendingPrompts.splice(promptIdx, 1);
		const positions = ids
			.map((id) => state.stack.findIndex((s) => s.id === id))
			.filter((i) => i >= 0)
			.sort((a, b) => a - b);
		const byId = new Map(state.stack.map((s) => [s.id, s]));
		// The lowest position resolves last: fill positions bottom-up with the answer reversed.
		const bottomFirst = [...answer.topIds].reverse().map((id) => byId.get(id)).filter((x): x is StackItem => Boolean(x));
		if (bottomFirst.length === positions.length) {
			positions.forEach((pos, k) => (state.stack[pos] = bottomFirst[k]));
			addLog(state, 'trigger', `${state.players.find((p) => p.playerId === prompt.playerId)?.username ?? 'A player'} ordered their triggered abilities (CR 603.3b).`, prompt.playerId);
		}
		return { ok: true };
	}
	const item = state.stack.find((s) => s.id === prompt.triggerStackItemId);
	state.pendingPrompts.splice(promptIdx, 1);
	if (!item) return { ok: true };
	if (purpose === 'trigger_targets') {
		if (answer?.kind !== 'chooseObjects') return { ok: true };
		const spec = triggerItemTargetSpecs(item)[prompt.triggerTargetSpecIndex ?? 0];
		if (!spec) return { ok: true };
		const legal = triggerTargetCandidates(state, item, spec);
		const chosen = answer.objectIds
			.map((id) => legal.find((c) => c.id === id))
			.filter((c): c is TargetRef => Boolean(c));
		item.targets.push(...chosen);
		item.targetObjectVersions = captureTargetObjectVersions(state, item.targets);
		addLog(
			state,
			'trigger',
			`${item.title} targets ${chosen.length > 0 ? chosen.map((c) => c.label).join(', ') : 'nothing'}.`,
			item.controllerId
		);
		return { ok: true };
	}
	// trigger_may: record the answer and finish resolving the ability (it stayed on the stack).
	if (answer?.kind !== 'yesNo') return { ok: true };
	item.optionalAccepted = answer.yes;
	// Resume by id: triggers that fired meanwhile may sit above it on the stack.
	resumeStackItem(state, item);
	return { ok: true };
}

function itemWard(item: StackItem): { cost: string; costDefs?: CostDef[] } | undefined {
	if (item.kind !== 'triggered' || item.triggeredAbilityIndex === undefined) return undefined;
	return runtimeTriggers(compileCard(item.card)).find((x) => x.abilityIndex === item.triggeredAbilityIndex)?.ward;
}

function resolveWardTrigger(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState,
	ward: { cost: string; costDefs?: CostDef[] }
): void {
	const targetItem = state.stack.find((s) => s.id === (item.eventStackItemId ?? item.targets[0]?.id));
	if (!targetItem) return;
	const opp = state.players.find((p) => p.playerId === targetItem.controllerId);
	const wardCost = (ward.cost || '{1}').trim();
	let paid = false;
	if (opp && !targetItem.declineWard) {
		const lifeDef = ward.costDefs?.find((d): d is Extract<CostDef, { k: 'payLife' }> => d.k === 'payLife');
		const lifeCost = lifeDef && lifeDef.amount.k === 'const' ? lifeDef.amount.n : undefined;
		if (lifeCost !== undefined) {
			if (!opp.lifeTotalCannotChangeThisTurn && opp.life >= lifeCost) {
				opp.life -= lifeCost;
				paid = true;
				addLog(
					state,
					'rule',
					`${opp.username} paid ${lifeCost} life for ${item.card.name}'s Ward (CR 702.21a).`,
					opp.playerId
				);
			}
		} else {
			const req = parseManaCost(wardCost);
			if (canPayOrAutoTap(opp, req, state)) {
				payManaWithAutoTap(opp, req, state);
				paid = true;
				addLog(
					state,
					'rule',
					`${opp.username} paid ${wardCost} for ${item.card.name}'s Ward (CR 702.21a).`,
					opp.playerId
				);
			}
		}
	}
	if (!paid) {
		if (targetItem.kind === 'spell' && spellCannotBeCountered(state, targetItem)) {
			addLog(
				state,
				'rule',
				`${targetItem.title} could not be countered by ${item.card.name}'s Ward (CR 702.21a)!`,
				controller.playerId
			);
		} else {
			const stkIdx = state.stack.indexOf(targetItem);
			if (stkIdx >= 0) {
				const [countered] = state.stack.splice(stkIdx, 1);
				moveStackSpellToZone(state, countered, 'graveyard');
				addLog(
					state,
					'cast',
					`${item.card.name}'s Ward countered ${countered.title} (CR 702.21a)!`,
					controller.playerId
				);
			}
		}
	}
}

function resolveDelayedTriggerEffect(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState,
	eff: DelayedTriggerEffect
): void {
	if (eff.kind === 'exile') {
		const found = findPermanentOnBoard(state, eff.targetInstanceId);
		if (
			found &&
			!found.inst.phasedOut &&
			(eff.targetObjectVersion === undefined || found.inst.objectVersion === eff.targetObjectVersion)
		) {
			emitVfx(state, { kind: 'exile', targetId: found.inst.instanceId, label: found.inst.card.name });
			movePermanentToZone(state, found.inst, 'exile');
			addLog(state, 'cast', `${item.title} exiled ${found.inst.card.name}.`, controller.playerId);
		}
		return;
	}
	if (eff.kind === 'lose') {
		loseTheGame(state, controller, `${item.title} ("you lose the game")`);
		return;
	}
	if (eff.kind === 'draw') {
		const pl = state.players.find((p) => p.playerId === eff.playerId) ?? controller;
		if (eff.upTo && !pl.isBot && !pl.lost && eff.amount > 0) {
			// "May draw up to N cards": the drawing player chooses how many (no silent default for a human).
			const question = `${item.title}: how many cards do you draw (0–${eff.amount})?`;
			enqueueChoicePrompt(state, {
				id: uid('prm', state),
				playerId: pl.playerId,
				kind: 'yesNo',
				title: item.title,
				description: question,
				continuation: { kind: 'handler', name: 'draw_up_to', data: { playerId: pl.playerId, source: item.title } },
				choice: { kind: 'chooseNumber', min: 0, max: eff.amount, reason: question }
			});
			return;
		}
		if (!pl.lost && eff.amount > 0) {
			drawCards(state, pl, eff.amount, true);
			addLog(state, 'rule', `${pl.username} drew ${eff.amount} card(s).`, controller.playerId);
		}
	}
}

registerPromptHandler('draw_up_to', (state, prompt, answer) => {
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	const pl = state.players.find((p) => p.playerId === data?.playerId);
	const n = answer.kind === 'chooseNumber' ? answer.n : 0;
	if (!pl || pl.lost) return;
	if (n > 0) drawCards(state, pl, n, true);
	addLog(state, 'rule', `${pl.username} drew ${n} card(s) (${String(data?.source ?? '')}).`, pl.playerId);
});

/**
 * Step E2: whether a stack item comes from a card ability the engine would have to automate (an
 * instant or sorcery, an activated ability, a triggered ability of a card), as opposed to an object
 * the engine makes itself (delayed triggers it created, Ward, which is implemented as a keyword) or
 * a permanent spell (it simply enters the battlefield).
 */
function isUnautomatedStackItem(item: StackItem): boolean {
	if (item.kind === 'activated') return true;
	if (item.kind === 'spell') return /\b(?:Instant|Sorcery)\b/.test(item.card.typeLine);
	return (
		item.triggeredAbilityIndex !== undefined &&
		!itemWard(item) &&
		!item.delayedEffect
	);
}

/**
 * Step E2: opens the guided (manual) resolution of a stack item that isn't automated. The item stays
 * on the stack until its controller is done (CR 608.2n); the prompt names it by id (plain data).
 */
function openManualResolution(state: GameState, item: StackItem, controller: PlayerGameState): void {
	item.manualResolution = 'awaiting';
	const targets = item.targets.map((t) => t.label).join(', ');
	const text = `${stackItemDisplayText(item)}${targets ? `\n\nTargets: ${targets}` : ''}`;
	const question = `${item.title} isn't automated. Apply its effect with the operations below, then finish resolving it.`;
	enqueueChoicePrompt(state, {
		id: uid('prm', state),
		playerId: controller.playerId,
		kind: 'guided_resolution',
		purpose: 'guided_resolution',
		title: `Resolve Manually: ${item.title}`,
		description: text,
		yesLabel: 'Done: finish resolving',
		continuation: { kind: 'manual_resolution', stackItemId: item.id },
		choice: { kind: 'yesNo', question }
	});
	addLog(state, 'rule', `${item.title} isn't automated: ${controller.username} resolves it manually.`, controller.playerId);
}


/**
 * Resolves the top object of the stack. Triggered abilities that trigger while it resolves are put
 * on the stack afterwards, once state-based actions have been checked (CR 603.3, 704.3).
 */
export function resolveTopOfStack(state: GameState): void {
	const item = state.stack[state.stack.length - 1];
	if (!item) return;
	resumeStackItem(state, item);
}

/**
 * Resolves (or continues resolving) a specific stack item. A resolution that paused for a prompt
 * resumes here by id once the prompt is answered: triggers that fired before the pause were put on
 * the stack above it, so it isn't necessarily on top (a minor deviation: under CR 603.3 they would
 * wait until the resolution finished; the pending-trigger queue isn't kept across the pause because
 * it isn't part of the saved state). Those triggers still resolve first.
 */
function resumeStackItem(state: GameState, item: StackItem): void {
	if (!state.stack.includes(item)) return;
	withTriggersDeferred(state, () => resolveStackItemNow(state, item));
	flushTriggers(state);
}

/** Whether a resolving item still waits for one of its prompts (it must not resolve again meanwhile). */
function stackItemAwaitsPrompt(state: GameState, item: StackItem): boolean {
	return state.pendingPrompts.some(
		(p) =>
			p.triggerStackItemId === item.id ||
			((p.continuation?.kind === 'effect_choice' || p.continuation?.kind === 'effect_resume') && p.continuation.stackItemId === item.id) ||
			(p.continuation?.kind === 'manual_resolution' && p.continuation.stackItemId === item.id)
	);
}

function resolveStackItemNow(state: GameState, item: StackItem): void {
	if (stackItemAwaitsPrompt(state, item)) return;
	const resuming = Boolean(item.resolutionStarted);
	const removeItemFromStack = () => {
		const idx = state.stack.lastIndexOf(item);
		if (idx >= 0) state.stack.splice(idx, 1);
	};

	const controller = state.players.find((p) => p.playerId === item.controllerId);
	if (!controller) {
		removeItemFromStack();
		return;
	}

	// Check intervening-if clause on resolution (CR 603.4)
	if (
		!resuming &&
		item.triggeredAbilityIndex !== undefined &&
		!stackTriggerConditionHolds(
			state,
			item.card,
			item.triggeredAbilityIndex,
			item.controllerId,
			item.sourceInstanceId
		)
	) {
		removeItemFromStack();
		addLog(
			state,
			'rule',
			`${item.title} did not resolve because its intervening-if condition is no longer met (CR 603.4).`,
			controller.playerId
		);
		state.priorityPlayerIndex = state.activePlayerIndex;
		state.passedPriorityPlayerIds = [];
		checkStateBasedActions(state);
		return;
	}

	// Check if all targets are still legal (Fizzle rule CR 608.2b)
	if (!resuming && item.targets.length > 0) {
		const triggerSpecs = item.kind === 'triggered' ? triggerItemTargetSpecs(item) : [];
		const validTargets = item.targets.filter((t) =>
			isTargetStillValid(state, t, item.controllerId, item.card, item) &&
			(triggerSpecs.length === 0 || triggerTargetStillLegal(state, item, triggerSpecs, t))
		);
		if (validTargets.length === 0) {
			removeItemFromStack();
			addLog(
				state,
				'rule',
				`${item.title} was countered on resolution (all targets became illegal / left the zone).`,
				item.controllerId
			);
			// CR 608.2b: If a spell is countered on resolution because all its targets are illegal,
			// it is put into its owner's graveyard (or Exile if Rest in Peace is active).
			moveStackSpellToZone(state, item, 'graveyard');
			state.priorityPlayerIndex = state.activePlayerIndex;
			state.passedPriorityPlayerIds = [];
			checkStateBasedActions(state);
			return;
		}
		item.targets = validTargets;

		// Record Last Known Information (LKI) of primary permanent target before effects move it
		if (item.targets[0]?.kind === 'permanent') {
			const foundFirst = findPermanentOnBoard(state, item.targets[0].id);
			if (foundFirst && !foundFirst.inst.phasedOut) {
				item.lkiControllerId = foundFirst.controller.playerId;
				item.lkiPower = getCreaturePower(foundFirst.inst, state);
				item.lkiToughness = getCreatureToughness(foundFirst.inst, state);
				item.lkiTypeLine = evaluatePermanent(state, foundFirst.inst).typeLine;
			}
		}
	}

	if (!resuming) {
		emitVfx(state, {
			kind: 'stack_resolve',
			sourceId: item.controllerId,
			targetId: item.targets[0]?.id,
			label: `Resolved: ${item.title}`
		});
		// From here on, a pause for a prompt resumes without repeating the checks and VFX above.
		item.resolutionStarted = true;
	}

	const ward = itemWard(item);
	if (ward) {
		resolveWardTrigger(state, item, controller, ward);
		triggerPathCounts.interpreter++;
		removeItemFromStack();
		state.priorityPlayerIndex = state.activePlayerIndex;
		state.passedPriorityPlayerIds = [];
		checkStateBasedActions(state);
		return;
	}
	if (item.delayedEffect) {
		resolveDelayedTriggerEffect(state, item, controller, item.delayedEffect);
		triggerPathCounts.interpreter++;
		removeItemFromStack();
		state.priorityPlayerIndex = state.activePlayerIndex;
		state.passedPriorityPlayerIds = [];
		checkStateBasedActions(state);
		return;
	}

	// A spell or ability the compiler marked supported resolves on the IR interpreter
	// (runtime/effects.ts); anything else isn't automated (below).
	const compiled =
		item.kind === 'triggered'
			? triggerItemEffect(item)
			: compiledStackItemEffects(item);
	const overload = item.castMode === 'overload';
	const interpreted =
		!item.manualResolution &&
		compiled !== null &&
		staticallyInterpretable(compiled, item.kind === 'triggered') &&
		(item.effectResume !== undefined || interpretableNow(state, item, compiled, controller, overload));
	// Step E2 (plan section 2.7): a spell or ability the interpreter can't run isn't automated. A human
	// controller resolves it manually (guided operations); a bot skips it.
	if (!interpreted && isUnautomatedStackItem(item)) {
		if (!controller.isBot) {
			if (item.manualResolution !== 'done') {
				openManualResolution(state, item, controller);
				return;
			}
		} else {
			addLog(state, 'rule', `${controller.username} (bot) skipped unsupported ability ${item.title}: it isn't automated.`, controller.playerId);
		}
	}
	let exiledBySelfReference = false;
	let steps: EffectStep[] = compiled?.steps ?? [];
	if (interpreted && item.kind === 'triggered') {
		// "You may ...": the controller decides as the ability resolves; the ability stays on the
		// stack while a human answers (CR 608.2n).
		const k = optionalPrefix(steps);
		if (k > 0) {
			if (item.optionalAccepted === undefined) {
				if (controller.isBot) {
					item.optionalAccepted = botAcceptsOptionalTrigger(state, controller, steps.slice(0, k), item);
				} else {
					const question = `Use the optional effect of ${item.title}? (Its text is shown on the stack.)`;
					enqueueChoicePrompt(state, {
						id: uid('prm', state),
						playerId: controller.playerId,
						kind: 'yesNo',
						purpose: 'trigger_may',
						title: `Optional Ability (${item.card.name})`,
						description: question,
						triggerStackItemId: item.id,
						yesLabel: 'Yes',
						noLabel: 'No',
						choice: { kind: 'yesNo', question }
					});
					return;
				}
			}
			addLog(
				state,
				'trigger',
				`${controller.username} ${item.optionalAccepted ? 'chose to' : 'declined to'} use ${item.title}'s optional effect.`,
				controller.playerId
			);
			steps = item.optionalAccepted ? withoutOptional(steps, k) : steps.slice(k);
		}
	}
	if (interpreted) {
		const result = executeEffectSteps(
			state,
			{
				controller,
				sourceId: item.sourceInstanceId,
				sourceCard: item.card,
				title: item.title,
				item,
				targets: item.targets,
				targetSpecs: compiled.targets,
				xValue: item.xValue,
				overload,
				...triggerEventContext(item)
			},
			steps,
			item.effectResume
		);
		// Step E2: a human must choose first (sacrifice, discard). The item stays on the stack with its
		// resume frame (CR 608.2n) and resolves on, by id, once the prompt is answered.
		if (result.paused) return;
		delete item.effectResume;
		if (state.delayedTriggers) {
			for (const dt of state.delayedTriggers) {
				if (dt.targetInstanceId && dt.targetObjectVersion === undefined) {
					const found = findPermanentOnBoard(state, dt.targetInstanceId);
					if (found) {
						dt.targetObjectVersion = found.inst.objectVersion;
					}
				}
			}
		}
		if (result.turnEnded) return;
		exiledBySelfReference = result.exileSelf;
	}

	if (item.kind === 'triggered') triggerPathCounts[interpreted ? 'interpreter' : 'manual']++;

	// CR 608.2n: As the final part of resolution, the resolving spell or ability leaves the stack.
	removeItemFromStack();

	// If this was a spell card, move it to Battlefield (for permanents) or Graveyard/Exile (for Instants/Sorceries)
	if (item.kind === 'spell' && !item.isCopy) {
		const tLine = item.card.typeLine;
		const isPermanent =
			tLine.includes('Creature') ||
			tLine.includes('Artifact') ||
			tLine.includes('Enchantment') ||
			tLine.includes('Planeswalker') ||
			tLine.includes('Battle');

		const cardOwnerId = item.ownerId || controller.playerId;
		const cardOwner = state.players.find((p) => p.playerId === cardOwnerId) || controller;
		const wasCommander = cardOwner.commanderNames[item.sourceInstanceId] !== undefined;
		const castCount =
			cardOwner.commanderCastCounts?.[item.sourceInstanceId] ??
			item.commanderCastCount ??
			0;

		if (isPermanent) {
			const perm = createCardInstance(
				item.card,
				cardOwnerId,
				'battlefield',
				wasCommander,
				false,
				allocateTimestamp(state)
			);
			perm.instanceId = item.sourceInstanceId;
			perm.controllerId = controller.playerId;
			perm.commanderCastCount = castCount;
			perm.summoningSick = tLine.includes('Creature');
			perm.enteredWithX = item.xValue;
			// Reset pre-filled loyalty so moveObject initializes loyalty with counterMultiplier (CR 306.5b)
			perm.counters.loyalty = 0;

			// CR 707: "enter the battlefield as a copy of any creature on the battlefield"
			const compiledEnter = compileCard(item.card);
			const entersAsCopyOfAnyCreature = (compiledEnter.faces[0]?.abilities ?? []).some(
				(ab) =>
					ab.kind === 'replacement' &&
					ab.replacement.replaces.event === 'zoneChange' &&
					ab.replacement.replaces.filter?.object === 'self' &&
					ab.replacement.replaces.filter?.to === 'battlefield' &&
					!Array.isArray(ab.replacement.with) &&
					ab.replacement.with.k === 'modify' &&
					Boolean(ab.replacement.with.copyOf?.types?.includes('Creature'))
			);
			if (entersAsCopyOfAnyCreature) {
				let targetCreature: CardInstance | undefined;
				if (item.targets[0]?.kind === 'permanent') {
					targetCreature = findPermanentOnBoard(state, item.targets[0].id)?.inst;
				}
				if (!targetCreature) {
					// Pick the highest-CMC creature on the battlefield
					const allCreatures: CardInstance[] = [];
					for (const p of state.players) {
						for (const b of p.battlefield) {
							if (!b.phasedOut && evaluatePermanent(state, b).typeLine.includes('Creature')) {
								allCreatures.push(b);
							}
						}
					}
					allCreatures.sort((a, b) => b.card.cmc - a.card.cmc);
					targetCreature = allCreatures[0];
				}
				if (targetCreature) {
					// CR 707.2: Copy Layer 1 copiable values, not counters or Layer 7c buffs
					const baseCardToCopy = JSON.parse(
						JSON.stringify(targetCreature.copiableCard ?? targetCreature.card)
					);
					perm.printedCard = item.card;
					perm.copiableCard = baseCardToCopy;
					perm.card = baseCardToCopy;
					addLog(
						state,
						'cast',
						`${item.card.name} entered the battlefield as a copy of ${baseCardToCopy.name} (CR 707.2).`,
						controller.playerId
					);
				}
			}

			if (tLine.includes('Aura') && item.targets[0]?.kind === 'permanent') {
				perm.attachedToId = item.targets[0].id;
			}
			applySelfEtbReplacements(state, perm);
			if (item.xValue > 0) {
				const effCard = perm.copiableCard ?? perm.card;
				const compiledPerm = compileCard(effCard);
				for (const ab of compiledPerm.faces[0]?.abilities ?? []) {
					if (
						ab.kind === 'replacement' &&
						ab.replacement.replaces.event === 'zoneChange' &&
						ab.replacement.replaces.filter?.object === 'self' &&
						ab.replacement.replaces.filter?.to === 'battlefield' &&
						!Array.isArray(ab.replacement.with) &&
						ab.replacement.with.k === 'modify' &&
						ab.replacement.with.counters?.amount.k === 'x'
					) {
						const cType = ab.replacement.with.counters.counter;
						const mult = counterMultiplier(state, perm, cType);
						perm.counters[cType] = (perm.counters[cType] ?? 0) + item.xValue * mult;
					}
				}
			}
			moveObject(state, perm, 'battlefield', { from: 'stack', toPlayer: controller });
			addLog(
				state,
				'cast',
				`${perm.card.name} entered the battlefield under ${controller.username}'s control.`,
				controller.playerId
			);
			if (tLine.includes('Aura') && perm.attachedToId) {
				const attachedTarget = findPermanentOnBoard(state, perm.attachedToId);
				if (attachedTarget) {
					emitEvent(state, {
						kind: 'Attached',
						attachmentId: perm.instanceId,
						attachment: perm,
						hostId: attachedTarget.inst.instanceId,
						host: attachedTarget.inst
					});
				}
			}
			flushTriggers(state);
		} else {
			moveStackSpellToZone(state, item, exiledBySelfReference ? 'exile' : 'graveyard');
		}
	}

	state.priorityPlayerIndex = state.activePlayerIndex;
	state.passedPriorityPlayerIds = [];
	checkStateBasedActions(state);
}


// ---- Effect primitives used by the IR interpreter (runtime/effects.ts)

/** "The player whose turn it is may end the turn": ends it now for a bot or the controller. */
function activePlayerMayEndTurn(
	state: GameState,
	controller: PlayerGameState,
	sourceName = 'Ability'
): void {
	const activePlayer = state.players[state.activePlayerIndex];
	if (!activePlayer) return;
	if (activePlayer.playerId === controller.playerId || activePlayer.isBot) {
		// Active player is controller (or a bot): end the turn immediately!
		endTheTurnImmediately(state, activePlayer.playerId);
	} else {
		const description = `${controller.username} activated ${sourceName}. As the player whose turn it is, you may end the turn now (exiling all spells and abilities from the stack).`;
		state.pendingPrompts.push({
			id: uid('prm', state),
			playerId: activePlayer.playerId,
			kind: 'yesNo',
			purpose: 'end_turn',
			title: `End the Turn? (${sourceName})`,
			description,
			yesLabel: 'End the Turn Now',
			noLabel: 'Decline (Keep Playing Turn)',
			choice: {
				kind: 'yesNo',
				question: description
			}
		});
	}
}

/** "Create a token that's a copy of ..." (CR 707.2: copiable values only). */
function copyPermanentAsToken(
	state: GameState,
	controller: PlayerGameState,
	original: CardInstance,
	sourceName: string,
	notLegendary = false
): void {
	const baseCardToCopy = JSON.parse(
		JSON.stringify(original.copiableCard ?? original.card)
	) as ScryfallCard;
	if (notLegendary) {
		baseCardToCopy.typeLine = baseCardToCopy.typeLine.replace(/\bLegendary\s+/g, '');
	}
	const tokenInst = createCardInstance(
		baseCardToCopy,
		controller.playerId,
		'battlefield',
		false,
		true,
		allocateTimestamp(state),
		state
	);
	tokenInst.copiableCard = baseCardToCopy;
	tokenInst.summoningSick = baseCardToCopy.typeLine.includes('Creature');
	moveObject(state, tokenInst, 'battlefield', { from: 'none', toPlayer: controller });
	addLog(
		state,
		'trigger',
		`${sourceName} created a token copy of ${baseCardToCopy.name}!`,
		controller.playerId
	);
	flushTriggers(state);
}

/** Counters `target` unless it can't be countered. Returns true if it was countered. */
function counterStackItemByEffect(
	state: GameState,
	item: StackItem,
	candidate: StackItem,
	controller: PlayerGameState
): boolean {
	if (spellCannotBeCountered(state, candidate)) {
		addLog(
			state,
			'rule',
			`${candidate.title} cannot be countered by ${item.title}!`,
			controller.playerId
		);
		return false;
	}
	const stkIdx = state.stack.indexOf(candidate);
	if (stkIdx < 0) return false;
	const [countered] = state.stack.splice(stkIdx, 1);
	moveStackSpellToZone(state, countered, 'graveyard');
	emitVfx(state, {
		kind: 'counter_spell',
		sourceId: controller.playerId,
		targetId: countered.controllerId,
		label: `Countered ${countered.title}!`
	});
	addLog(state, 'cast', `${item.title} countered ${countered.title}!`, controller.playerId);
	return true;
}

/** Destroy (CR 701.7) by a spell or ability: indestructible, then dies triggers. */
function destroyPermanentByEffect(
	state: GameState,
	inst: CardInstance,
	title: string,
	actorId: string
): void {
	if (hasKeyword(inst, 'Indestructible', state)) {
		addLog(state, 'rule', `${inst.card.name} is Indestructible and was not destroyed.`);
		return;
	}
	const found = findPermanentOnBoard(state, inst.instanceId);
	if (!found) return;
	emitVfx(state, { kind: 'destroy', targetId: inst.instanceId, label: inst.card.name });
	movePermanentToZone(state, inst, 'graveyard');
	addLog(state, 'cast', `${title} destroyed ${inst.card.name}.`, actorId);
	flushTriggers(state);
}

/** Scry N, or "look at the top N cards, then put them back in any order": bot decision or prompt. */
function scryOrRearrangeTop(
	state: GameState,
	controller: PlayerGameState,
	item: StackItem,
	amount: number,
	mode: 'scry' | 'rearrange',
	mayShuffle: boolean
): void {
	const count = Math.min(amount, controller.library.length);
	if (count <= 0) return;
	if (mode === 'scry') {
		if (controller.isBot) {
			const topCards = controller.library.slice(0, count);
			const landCount =
				controller.battlefield.filter((b) => b.card.typeLine.includes('Land')).length +
				controller.hand.filter((h) => h.card.typeLine.includes('Land')).length;
			const keepTop: CardInstance[] = [];
			const putBottom: CardInstance[] = [];
			for (const c of topCards) {
				const isLand = c.card.typeLine.includes('Land');
				if ((landCount >= 4 && isLand) || (landCount < 3 && !isLand && c.card.cmc > 4)) {
					putBottom.push(c);
				} else {
					keepTop.push(c);
				}
			}
			rearrangeLibrary(controller, topCards, keepTop, putBottom);
			addLog(
				state,
				'rule',
				`${controller.username} scried ${count} (${keepTop.length} on top, ${putBottom.length} on bottom).`,
				controller.playerId
			);
		} else {
			const topCards = controller.library.slice(0, count);
			const topIds = topCards.map((c) => c.instanceId);
			const description = `Look at the top ${count} card(s) of your library. Put any number on the bottom in any order and the rest on top in any order.`;
			state.pendingPrompts.push({
				id: uid('prm', state),
				playerId: controller.playerId,
				kind: 'scry_choice',
				purpose: 'scry_choice',
				title: `Scry ${count} (${item.card.name})`,
				description,
				countRequired: count,
				candidateInstanceIds: topIds,
				allowBottom: true,
				allowShuffle: false,
				choice: {
					kind: 'orderObjects',
					objectIds: topIds,
					allowSplitBottom: true,
					allowShuffle: false,
					reason: description
				}
			});
		}
	} else {
		if (controller.isBot) {
			const topCards = controller.library.slice(0, count);
			const landCount =
				controller.battlefield.filter((b) => b.card.typeLine.includes('Land')).length +
				controller.hand.filter((h) => h.card.typeLine.includes('Land')).length;
			topCards.sort((a, b) => {
				const aLand = a.card.typeLine.includes('Land') ? 1 : 0;
				const bLand = b.card.typeLine.includes('Land') ? 1 : 0;
				return landCount < 3 ? bLand - aLand : aLand - bLand;
			});
			rearrangeLibrary(controller, topCards, topCards, []);
			addLog(
				state,
				'rule',
				`${controller.username} rearranged the top ${count} card(s) of their library.`,
				controller.playerId
			);
		} else {
			const topCards = controller.library.slice(0, count);
			const topIds = topCards.map((c) => c.instanceId);
			const description = `Look at the top ${count} card(s) of your library and put them back on top in any order.${mayShuffle ? ' Or you may shuffle your library.' : ''}`;
			state.pendingPrompts.push({
				id: uid('prm', state),
				playerId: controller.playerId,
				kind: 'scry_choice',
				purpose: 'scry_choice',
				title: `Rearrange Top ${count} (${item.card.name})`,
				description,
				countRequired: count,
				candidateInstanceIds: topIds,
				allowBottom: false,
				allowShuffle: Boolean(mayShuffle),
				choice: {
					kind: 'orderObjects',
					objectIds: topIds,
					allowSplitBottom: false,
					allowShuffle: Boolean(mayShuffle),
					reason: description
				}
			});
		}
	}
}

registerEffectPorts({
	uid,
	addLog,
	emitVfx,
	findPermanent: findPermanentOnBoard,
	power: (state, inst) => getCreaturePower(inst, state),
	toughness: (state, inst) => getCreatureToughness(inst, state),
	hasKeyword: (state, inst, kw) => hasKeyword(inst, kw, state),
	drawCards: (state, player, count) => drawCards(state, player, count, true),
	damageTarget: applyDamageToTarget,
	destroy: destroyPermanentByEffect,
	moveFromBattlefield: movePermanentToZone,
	counterSpell: counterStackItemByEffect,
	createToken: createTokenOnBoard,
	copyPermanentAsToken,
	triggerOnEtb: (state) => flushTriggers(state),
	triggerOnAttach: (state, _controller, attached, to) => {
		if (state.lobbyCode !== 'GOLDEN') {
			attached.enteredTimestamp = allocateTimestamp(state);
		}
		emitEvent(state, {
			kind: 'Attached',
			attachmentId: attached.instanceId,
			attachment: attached,
			hostId: to.instanceId,
			host: to
		});
		flushTriggers(state);
	},
	addCounters: addCountersToPermanent,
	proliferate: executeProliferate,
	scry: (state, player, item, count, mode, mayShuffle) =>
		scryOrRearrangeTop(state, player, item, count, mode, mayShuffle),
	search: (state, player, spec, item) =>
		initiateLibrarySearch(state, player, spec, item),
	phaseOut: phaseOutPermanent,
	endTurn: endTheTurnImmediately,
	activePlayerMayEndTurn,
	win: (state, player, reason) => void winTheGame(state, player, reason),
	lose: (state, player, reason) => void loseTheGame(state, player, reason)
});

/**
 * CR 702.26: Phasing Out a permanent also indirectly phases out any Auras/Equipment attached to it.
 * Phased-out permanents do not change zones (no LTB/ETB triggers fire!).
 */
export function phaseOutPermanent(state: GameState, perm: CardInstance): void {
	perm.phasedOut = true;
	perm.phasedOutIndirectly = false;
	// Indirectly phase out any Auras/Equipment attached to this permanent (CR 702.26g)
	for (const p of state.players) {
		for (const other of p.battlefield) {
			if (other.attachedToId === perm.instanceId && !other.phasedOut) {
				other.phasedOut = true;
				other.phasedOutIndirectly = true;
			}
		}
	}
	// Remove from combat if attacking or blocking
	state.combat.attackers = state.combat.attackers.filter(
		(a) => a.attackerInstanceId !== perm.instanceId
	);
	for (const atk of state.combat.attackers) {
		atk.blockerInstanceIds = atk.blockerInstanceIds.filter((id) => id !== perm.instanceId);
	}
}

/**
 * CR 721: Ending the Turn Prematurely (Obeka, Brute Chronologist / Sundial of the Infinite / Time Stop).
 * 1. All spells and abilities on the stack are exiled.
 * 2. All attacking and blocking creatures are removed from combat.
 * 3. State-based actions are checked.
 * 4. The current phase/step ends and the game skips directly to the Cleanup Step!
 */
export function endTheTurnImmediately(state: GameState, actorId: string): void {
	const exiledCount = state.stack.length;
	while (state.stack.length > 0) {
		const stk = state.stack.pop()!;
		moveStackSpellToZone(state, stk, 'exile');
	}

	state.combat.active = false;
	state.combat.attackers = [];
	state.combat.declaredBlockersPlayerIds = [];

	addLog(
		state,
		'rule',
		`The turn ended immediately (CR 721)! Exiled ${exiledCount} item(s) from the Stack and skipped to Cleanup Step.`,
		actorId
	);

	checkStateBasedActions(state);
	runCleanupStep(state);
}

/**
 * Enters the End Step (`end_step`), firing beginning-of-end-step permanent triggers
 * and putting any matching `delayedTriggers` (such as Final Fortune's "you lose the game",
 * Corpse Dance's exile trigger, or Dress Down's sacrifice trigger) onto the Stack in APNAP order.
 * If the Stack is non-empty, priority is given to `activePlayer` so they can respond (e.g. with Obeka or Sundial!).
 */
export function enterEndStep(state: GameState, activePlayer: PlayerGameState): void {
	emptyAllPlayersManaPools(state);
	emitVfx(state, { kind: 'phase_change', label: 'End Step' });
	// Beginning-of-end-step and delayed end-step triggers run from the PhaseBegin handler
	// (runEndStepTriggers), synchronously.
	beginPhase(state, 'end_step', activePlayer);

	state.priorityPlayerIndex = state.activePlayerIndex;
	state.passedPriorityPlayerIds = [];
}

/**
 * CR 702.62a: When the last time counter is removed from a suspended card in Exile,
 * its owner casts it without paying its mana cost if able. If it's a creature, it gains
 * haste until its controller loses control of it.
 */
export function executeSuspendFreeCastFromExile(
	state: GameState,
	owner: PlayerGameState,
	suspCard: CardInstance
): void {
	const eIdx = owner.exile.findIndex((c) => c.instanceId === suspCard.instanceId);
	if (eIdx < 0) return;

	// Check if global cast restrictions (like Rule of Law / Drannith Magistrate) block casting from Exile
	const globalCheck = checkGlobalCastPermissionsAndRestrictions(
		state,
		owner.playerId,
		suspCard,
		'exile'
	);
	if (!globalCheck.ok) {
		suspCard.isSuspended = false;
		addLog(
			state,
			'rule',
			`${suspCard.card.name}'s last time counter was removed, but it could not be cast (${globalCheck.error}); it remains in Exile.`,
			owner.playerId
		);
		return;
	}

	// Auto-select a legal target if the spell requires one
	const spec = compileSpellEffects(suspCard.card)?.targets[0];
	const chosenTargets: TargetRef[] = [];
	if (spec && spec.min > 0) {
		const legalTargets = specTargetCandidates(state, owner.playerId, suspCard.card, suspCard, spec);
		if (legalTargets.length < spec.min) {
			suspCard.isSuspended = false;
			addLog(
				state,
				'rule',
				`${suspCard.card.name}'s last time counter was removed, but there were no legal targets; it remains in Exile.`,
				owner.playerId
			);
			return;
		}
		// Prefer targeting opponent or opponent's permanent for damage/removal
		const preferred =
			legalTargets.find((t) => t.id !== owner.playerId) || legalTargets[0];
		chosenTargets.push(preferred);
	}

	// Pinned behaviour: `zone` stays 'exile' and there's no objectVersion/timestamp change.
	moveObject(state, suspCard, 'stack', { from: { player: owner, zone: 'exile' }, setZone: false });
	suspCard.isSuspended = false;
	suspCard.castViaSuspend = true;
	owner.spellsCastThisTurn = (owner.spellsCastThisTurn || 0) + 1;

	const stackItem: StackItem = withStackItemText(
		{
			id: uid('stk', state),
			sourceInstanceId: suspCard.instanceId,
			card: suspCard.card,
			controllerId: owner.playerId,
			kind: 'spell',
			title: `${suspCard.card.name} (Suspended Cast)`,
			targets: chosenTargets,
			targetObjectVersions: captureTargetObjectVersions(state, chosenTargets),
			xValue: 0,
			requiresGuidedResolution: false,
			createdAt: Date.now()
		},
		suspCard.card
	);
	state.stack.push(stackItem);
	addLog(
		state,
		'cast',
		`${owner.username} cast ${suspCard.card.name} from Exile without paying its mana cost via Suspend (CR 702.62a)!`,
		owner.playerId
	);
	emitEvent(state, {
		kind: 'Cast',
		playerId: owner.playerId,
		objectId: suspCard.instanceId,
		object: suspCard
	});
	// Resolve immediately if no players are holding interaction or during upkeep automation
	resolveTopOfStack(state);
	if (suspCard.card.typeLine.includes('Creature')) {
		const onBoard = owner.battlefield.find((c) => c.instanceId === suspCard.instanceId);
		if (onBoard) {
			onBoard.castViaSuspend = true;
			onBoard.summoningSick = false;
		}
	}
}

export function checkSuspendLegality(
	state: GameState,
	actorId: string,
	inst: CardInstance
): { ok: boolean; suspendInfo?: { timeCounters: number; cost: string }; error?: string } {
	if (state.status !== 'active') {
		return { ok: false, error: 'Game is not currently active.' };
	}
	const actor = state.players.find((p) => p.playerId === actorId);
	if (!actor || actor.lost) {
		return { ok: false, error: 'Player is not active.' };
	}
	const suspSpec = getSuspendSpec(inst.card);
	const suspendInfo = suspSpec
		? { timeCounters: suspSpec.timeCounters, cost: suspSpec.suspendCost }
		: null;
	if (!suspendInfo) {
		return { ok: false, error: `${inst.card.name} does not have Suspend.` };
	}
	const priorityPlayer = state.players[state.priorityPlayerIndex];
	if (priorityPlayer?.playerId !== actorId) {
		return { ok: false, error: 'You must hold priority to suspend a card.' };
	}
	// CR 702.62a: You can exile a card from your hand with Suspend any time you could begin to cast it
	const activePlayer = state.players[state.activePlayerIndex];
	const globalCheck = checkGlobalCastPermissionsAndRestrictions(state, actorId, inst, 'hand');
	const isInstantTiming =
		inst.card.typeLine.includes('Instant') ||
		hasKeyword(inst, 'Flash', state) ||
		globalCheck.grantsFlash;
	if (!isInstantTiming) {
		if (
			activePlayer?.playerId !== actorId ||
			(state.phase !== 'main1' && state.phase !== 'main2') ||
			state.stack.length > 0
		) {
			return {
				ok: false,
				error: `${inst.card.name} can only be suspended at Sorcery speed.`
			};
		}
	}
	const costReq = parseManaCost(suspendInfo.cost);
	if (!canPayOrAutoTap(actor, costReq, state)) {
		return {
			ok: false,
			error: `Insufficient mana to pay Suspend cost ${suspendInfo.cost}.`
		};
	}
	return { ok: true, suspendInfo };
}

/**
 * Unified grammar-driven Library Search execution + `Opposition Agent` interception (CR 701.19).
 */
function initiateLibrarySearch(
	state: GameState,
	searchingPlayer: PlayerGameState,
	searchSpec: LibrarySearchSpec,
	item: StackItem
): void {
	const interceptor = getLibrarySearchInterceptor(state, searchingPlayer.playerId);
	const decisionPlayer = interceptor
		? state.players.find((p) => p.playerId === interceptor.controllerId) || searchingPlayer
		: searchingPlayer;

	const matchingCards = searchingPlayer.library.filter((c) =>
		matchesLibrarySearchSpec(c.card, searchSpec)
	);
	const canFailToFind =
		searchSpec.statedQuality || searchSpec.upTo || matchingCards.length === 0;

	if (decisionPlayer.isBot) {
		const topCardsToPlace: CardInstance[] = [];
		for (const dest of searchSpec.destinations) {
			const idx = searchingPlayer.library.findIndex((c) =>
				matchesLibrarySearchSpec(c.card, searchSpec)
			);
			if (idx < 0) break;
			const found = searchingPlayer.library[idx];
			const fromLibrary = { player: searchingPlayer, zone: 'library' as const };

			if (interceptor?.exilesFoundCards) {
				if (interceptor.grantPlayFromExile) {
					found.playableFromExileBy = {
						playerId: interceptor.controllerId,
						spendManaAsAnyColor: interceptor.spendManaAsAnyColor,
						sourceName: interceptor.sourceName
					};
				}
				moveObject(state, found, 'exile', {
					from: fromLibrary,
					toPlayer: searchingPlayer,
					newTimestamp: true,
					bumpVersion: true
				});
				addLog(
					state,
					'rule',
					`${decisionPlayer.username} (controlling ${searchingPlayer.username} via ${interceptor.sourceName}) exiled ${found.card.name} from ${searchingPlayer.username}'s library!`,
					decisionPlayer.playerId
				);
			} else if (dest.zone === 'battlefield') {
				found.tapped = Boolean(dest.tapped);
				applySelfEtbReplacements(state, found);
				moveObject(state, found, 'battlefield', {
					from: fromLibrary,
					toPlayer: searchingPlayer,
					controllerId: searchingPlayer.playerId,
					newTimestamp: true,
					bumpVersion: true
				});
				addLog(
					state,
					'rule',
					`${searchingPlayer.username} searched their library for ${found.card.name} and put it onto the battlefield${found.tapped ? ' tapped' : ''}.`,
					searchingPlayer.playerId
				);
				flushTriggers(state);
			} else if (dest.zone === 'library' && dest.onTop) {
				moveObject(state, found, 'library', {
					from: fromLibrary,
					toPlayer: searchingPlayer,
					insert: 'deferred',
					newTimestamp: true,
					bumpVersion: true
				});
				topCardsToPlace.push(found);
			} else {
				moveObject(state, found, 'hand', { from: fromLibrary, toPlayer: searchingPlayer });
				addLog(
					state,
					'rule',
					`${searchingPlayer.username} searched their library for a card and put it into hand.`,
					searchingPlayer.playerId
				);
			}
		}
		shuffleLibrary(state, searchingPlayer);
		if (topCardsToPlace.length > 0) {
			placeDeferred(searchingPlayer, 'library', topCardsToPlace, 'start');
			addLog(
				state,
				'rule',
				`${searchingPlayer.username} searched their library, shuffled, and put ${topCardsToPlace.length} card(s) on top.`,
				searchingPlayer.playerId
			);
		}
		return;
	}

	if (matchingCards.length === 0 && !interceptor) {
		shuffleLibrary(state, searchingPlayer);
		addLog(
			state,
			'rule',
			`${searchingPlayer.username} searched their library for ${item.card.name} (no matching cards found) and shuffled.`,
			searchingPlayer.playerId
		);
		return;
	}

	const [firstDest, ...restDestinations] =
		searchSpec.destinations.length > 0
			? searchSpec.destinations
			: [{ zone: 'hand' as const }];

	const candidateIds = matchingCards.map((c) => c.instanceId);
	const description = interceptor
		? `You control ${searchingPlayer.username} while they search their library for ${searchSpec.rawCriteriaText}. Choose a matching card to exile (you may play it for as long as it remains exiled${interceptor.spendManaAsAnyColor ? ', spending mana as though it were mana of any color' : ''}).${canFailToFind ? ' Because the search states a card quality, you may also choose to Fail to Find.' : ' Because the search does not state a card quality, you MUST find a card (CR 701.19b).'}`
		: `Choose ${searchSpec.rawCriteriaText} from your library to put ${describeLibrarySearchDestination(firstDest)}${restDestinations.length > 0 ? ` (then ${restDestinations.length} more: ${restDestinations.map(describeLibrarySearchDestination).join(', ')})` : ''}, then shuffle.`;

	state.pendingPrompts.push({
		id: uid('prm', state),
		playerId: decisionPlayer.playerId,
		targetLibraryOwnerId: searchingPlayer.playerId,
		kind: 'search_library',
		purpose: 'search_library',
		title: interceptor
			? `${interceptor.sourceName} — Search ${searchingPlayer.username}'s Library (${item.card.name})`
			: `Search Your Library (${item.card.name})`,
		description,
		destinationZone: firstDest.zone,
		enterTapped: Boolean(firstDest.tapped),
		putOnTop: Boolean(firstDest.onTop),
		searchSpec,
		remainingDestinations: restDestinations,
		canFailToFind,
		interceptedBy: interceptor || undefined,
		candidateInstanceIds: candidateIds,
		stackItem: item,
		choice: {
			kind: 'chooseObjects',
			candidates: candidateIds,
			min: canFailToFind || candidateIds.length === 0 ? 0 : 1,
			max: 1,
			zone: 'library',
			reason: description
		}
	});
}

export function createTokenOnBoard(
	state: GameState,
	controller: PlayerGameState,
	spec: TokenSpec
): CardInstance {
	const tokenCard: ScryfallCard = buildTokenScryfallCard(uid('tok_scry', state), spec);

	const inst = createCardInstance(
		tokenCard,
		controller.playerId,
		'battlefield',
		false,
		true,
		allocateTimestamp(state),
		state
	);
	inst.summoningSick = spec.typeLine.includes('Creature');
	moveObject(state, inst, 'battlefield', { from: 'none', toPlayer: controller });
	emitVfx(state, {
		kind: 'token_create',
		sourceId: controller.playerId,
		targetId: inst.instanceId,
		label: spec.name
	});
	flushTriggers(state);
	return inst;
}

export function executeProliferate(
	state: GameState,
	controller: PlayerGameState,
	chosenIds?: string[]
): void {
	const allCounterTypes: CounterType[] = [
		'+1/+1',
		'-1/-1',
		'loyalty',
		'charge',
		'shield',
		'stun',
		'lore',
		'time'
	];
	if (chosenIds) {
		const chosenSet = new Set(chosenIds);
		for (const pl of state.players) {
			for (const perm of pl.battlefield) {
				if (perm.phasedOut || !chosenSet.has(perm.instanceId)) continue;
				for (const cType of allCounterTypes) {
					if ((perm.counters[cType] || 0) > 0) {
						addCountersToPermanent(state, perm, cType, 1);
					}
				}
			}
			if (chosenSet.has(pl.playerId)) {
				if (pl.poison > 0) pl.poison += 1;
				if ((pl.experienceCounters || 0) > 0) {
					pl.experienceCounters = (pl.experienceCounters || 0) + 1;
				}
				if ((pl.energyCounters || 0) > 0) {
					pl.energyCounters = (pl.energyCounters || 0) + 1;
				}
			}
		}
	} else {
		const controllerPositiveTypes: CounterType[] = [
			'+1/+1',
			'loyalty',
			'charge',
			'shield',
			'lore',
			'time'
		];
		const opponentNegativeTypes: CounterType[] = ['-1/-1', 'stun'];
		for (const perm of controller.battlefield) {
			if (perm.phasedOut) continue;
			for (const cType of controllerPositiveTypes) {
				if ((perm.counters[cType] || 0) > 0) {
					addCountersToPermanent(state, perm, cType, 1);
				}
			}
		}
		if ((controller.experienceCounters || 0) > 0) {
			controller.experienceCounters = (controller.experienceCounters || 0) + 1;
		}
		if ((controller.energyCounters || 0) > 0) {
			controller.energyCounters = (controller.energyCounters || 0) + 1;
		}
		for (const opp of state.players) {
			if (opp.playerId === controller.playerId) continue;
			for (const perm of opp.battlefield) {
				if (perm.phasedOut) continue;
				for (const cType of opponentNegativeTypes) {
					if ((perm.counters[cType] || 0) > 0) {
						addCountersToPermanent(state, perm, cType, 1);
					}
				}
			}
			if (opp.poison > 0) {
				opp.poison += 1;
			}
		}
	}
	emitVfx(state, {
		kind: 'proliferate',
		sourceId: controller.playerId,
		label: 'Proliferate!'
	});
}

export function advancePhaseOrStep(state: GameState): void {
	// Drain unspent mana pools at the end of each step/phase (CR 106.4 / 500.4)
	emptyAllPlayersManaPools(state);

	const activePlayer = state.players[state.activePlayerIndex];

	switch (state.phase) {
		case 'untap':
			beginPhase(state, 'upkeep', activePlayer);
			break;
		case 'upkeep':
			beginPhase(state, 'draw', activePlayer);
			emitVfx(state, {
				kind: 'phase_change',
				label: `Turn ${state.turnNumber}: ${activePlayer?.username ?? ''} — Draw Step`
			});
			break;
		case 'draw':
			beginPhase(state, 'main1', activePlayer);
			emitVfx(state, {
				kind: 'phase_change',
				label: `Turn ${state.turnNumber}: ${activePlayer?.username ?? ''} — Main Phase 1`
			});
			break;

		case 'main1':
			beginPhase(state, 'begin_combat', activePlayer);
			emitVfx(state, { kind: 'phase_change', label: 'Combat — Beginning of Combat' });
			break;

		case 'begin_combat':
			beginPhase(state, 'declare_attackers', activePlayer);
			emitVfx(state, { kind: 'phase_change', label: 'Combat — Declare Attackers' });
			break;

		case 'declare_attackers':
			if (state.combat.active && state.combat.attackers.length > 0) {
				beginPhase(state, 'declare_blockers', activePlayer);
				const defendersInOrder = getAttackedDefenderIdsInTurnOrder(state);
				const firstDefenderId = defendersInOrder[0] || state.combat.attackers[0].defenderPlayerId;
				const defIdx = state.players.findIndex((p) => p.playerId === firstDefenderId);
				state.priorityPlayerIndex = defIdx >= 0 ? defIdx : state.activePlayerIndex;
				state.passedPriorityPlayerIds = [];
				checkStateBasedActions(state);
				return;
			} else {
				// CR 508.8: If no creatures are declared as attackers, skip declare_blockers, combat_damage, and end_combat
				state.combat.active = false;
				state.combat.attackers = [];
				state.combat.declaredBlockersPlayerIds = [];
				state.combat.blockersDeclared = false;
				state.combat.dealtFirstStrikeDamageIds = [];
				beginPhase(state, 'main2', activePlayer);
				emitVfx(state, { kind: 'phase_change', label: 'Postcombat Main Phase 2' });
			}
			break;

		case 'declare_blockers': {
			// Check if any combatant has First strike or Double strike
			const hasFirstStrike = checkAnyCombatantHasFirstStrike(state);
			if (hasFirstStrike) {
				beginPhase(state, 'first_strike_damage', activePlayer);
			} else {
				beginPhase(state, 'combat_damage', activePlayer);
			}
			break;
		}

		case 'first_strike_damage':
			beginPhase(state, 'combat_damage', activePlayer);
			break;

		case 'combat_damage':
			// CR 511.1 / 511.3: Advance to end_combat; creatures remain attacking/blocking until end_combat ends
			beginPhase(state, 'end_combat', activePlayer);
			emitVfx(state, { kind: 'phase_change', label: 'Combat — End of Combat' });
			break;

		case 'end_combat':
			// CR 511.3: At the end of the end of combat step, all creatures are removed from combat
			state.combat.active = false;
			state.combat.attackers = [];
			state.combat.declaredBlockersPlayerIds = [];
			state.combat.blockersDeclared = false;
			state.combat.dealtFirstStrikeDamageIds = [];
			beginPhase(state, 'main2', activePlayer);
			emitVfx(state, { kind: 'phase_change', label: 'Postcombat Main Phase 2' });
			break;

		case 'main2':
			enterEndStep(state, activePlayer);
			break;

		case 'end_step':
			runCleanupStep(state);
			return;

		case 'cleanup':
			runCleanupStep(state);
			return;
	}

	state.priorityPlayerIndex = state.activePlayerIndex;
	state.passedPriorityPlayerIds = [];
	checkStateBasedActions(state);
}

function checkAnyCombatantHasFirstStrike(state: GameState): boolean {
	for (const atk of state.combat.attackers) {
		const atkOwner = state.players.find((p) => p.playerId === atk.controllerId);
		const atkCard = atkOwner?.battlefield.find((c) => c.instanceId === atk.attackerInstanceId);
		if (
			atkCard &&
			(hasKeyword(atkCard, 'First strike', state) || hasKeyword(atkCard, 'Double strike', state))
		) {
			return true;
		}
		const defPlayer = state.players.find((p) => p.playerId === atk.defenderPlayerId);
		for (const bId of atk.blockerInstanceIds) {
			const bCard = defPlayer?.battlefield.find((c) => c.instanceId === bId);
			if (
				bCard &&
				(hasKeyword(bCard, 'First strike', state) || hasKeyword(bCard, 'Double strike', state))
			) {
				return true;
			}
		}
	}
	return false;
}

function executeCombatDamageStep(state: GameState, isFirstStrikeStep: boolean): void {
	if (!state.combat.dealtFirstStrikeDamageIds) {
		state.combat.dealtFirstStrikeDamageIds = [];
	}

	// CR 510.2: All combat damage in a step is assigned and dealt simultaneously.
	// Snapshot combatant characteristics BEFORE any Infect -1/-1 counters or damageMarked mutations apply!
	interface CombatantSnapshot {
		power: number;
		toughness: number;
		damageMarkedBefore: number;
		hasFS: boolean;
		hasDS: boolean;
		hasDeathtouch: boolean;
		hasLifelink: boolean;
		hasTrample: boolean;
		hasInfect: boolean;
		dealsNow: boolean;
	}
	const snapshots = new Map<string, CombatantSnapshot>();
	const recordSnapshot = (perm: CardInstance) => {
		if (snapshots.has(perm.instanceId)) return;
		const hasFS = hasKeyword(perm, 'First strike', state);
		const hasDS = hasKeyword(perm, 'Double strike', state);
		const alreadyDealtFS = state.combat.dealtFirstStrikeDamageIds!.includes(perm.instanceId);
		// CR 702.7c: In regular combat damage step, creatures that did NOT deal first-strike damage deal combat damage,
		// as do creatures that currently have Double strike.
		const dealsNow = isFirstStrikeStep ? hasFS || hasDS : hasDS || !alreadyDealtFS;
		snapshots.set(perm.instanceId, {
			power: getCreaturePower(perm, state),
			toughness: getCreatureToughness(perm, state),
			damageMarkedBefore: perm.damageMarked,
			hasFS,
			hasDS,
			hasDeathtouch: hasKeyword(perm, 'Deathtouch', state),
			hasLifelink: hasKeyword(perm, 'Lifelink', state),
			hasTrample: hasKeyword(perm, 'Trample', state),
			hasInfect: hasKeyword(perm, 'Infect', state),
			dealsNow
		});
	};

	for (const atkEntry of state.combat.attackers) {
		const atkPlayer = state.players.find((p) => p.playerId === atkEntry.controllerId);
		const defPlayer = state.players.find((p) => p.playerId === atkEntry.defenderPlayerId);
		if (!atkPlayer || !defPlayer) continue;
		const attacker = atkPlayer.battlefield.find(
			(c) => !c.phasedOut && c.instanceId === atkEntry.attackerInstanceId
		);
		if (attacker) recordSnapshot(attacker);
		for (const id of atkEntry.blockerInstanceIds) {
			const b = defPlayer.battlefield.find((c) => !c.phasedOut && c.instanceId === id);
			if (b) recordSnapshot(b);
		}
	}

	for (const atkEntry of state.combat.attackers) {
		const atkPlayer = state.players.find((p) => p.playerId === atkEntry.controllerId);
		const defPlayer = state.players.find((p) => p.playerId === atkEntry.defenderPlayerId);
		if (!atkPlayer || !defPlayer) continue;

		const attacker = atkPlayer.battlefield.find(
			(c) => !c.phasedOut && c.instanceId === atkEntry.attackerInstanceId
		);
		if (!attacker) continue;

		const atkSnap = snapshots.get(attacker.instanceId)!;
		const attackerDealsNow = atkSnap.dealsNow;
		if (isFirstStrikeStep && attackerDealsNow) {
			if (!state.combat.dealtFirstStrikeDamageIds.includes(attacker.instanceId)) {
				state.combat.dealtFirstStrikeDamageIds.push(attacker.instanceId);
			}
		}

		const atkPower = atkSnap.power;
		const atkDeathtouch = atkSnap.hasDeathtouch;
		const atkLifelink = atkSnap.hasLifelink;
		const atkTrample = atkSnap.hasTrample;
		const atkInfect = atkSnap.hasInfect;

		const blockers = atkEntry.blockerInstanceIds
			.map((id) => defPlayer.battlefield.find((c) => !c.phasedOut && c.instanceId === id))
			.filter((b): b is CardInstance => Boolean(b));

		// Check if all combat damage is prevented this turn (e.g., Fog)
		const combatDamagePrevented =
			atkPlayer.preventAllCombatDamageThisTurn || defPlayer.preventAllCombatDamageThisTurn;

		if (attackerDealsNow && atkPower > 0 && !combatDamagePrevented) {
			let remainingDamage = atkPower;
			let totalDealtByAttacker = 0;
			const defWalker = atkEntry.defenderPlaneswalkerId
				? defPlayer.battlefield.find(
						(c) => !c.phasedOut && c.instanceId === atkEntry.defenderPlaneswalkerId
					)
				: undefined;

			if (!atkEntry.wasBlocked && blockers.length === 0) {
				if (defWalker) {
					// CR 120.3c: Combat damage dealt to a planeswalker removes that many loyalty counters.
					defWalker.counters.loyalty = Math.max(
						0,
						(defWalker.counters.loyalty || 0) - remainingDamage
					);
					totalDealtByAttacker += remainingDamage;
					emitEvent(state, {
						kind: 'DamageDealt',
						sourceId: attacker.instanceId,
						targetId: defWalker.instanceId,
						targetKind: 'permanent',
						amount: remainingDamage,
						combat: true
					});
					emitVfx(state, {
						kind: 'damage',
						sourceId: attacker.instanceId,
						targetId: defWalker.instanceId,
						amount: remainingDamage,
						label: `-${remainingDamage} Loyalty`
					});
					addLog(
						state,
						'combat',
						`${attacker.card.name} dealt ${remainingDamage} unblocked combat damage to ${defWalker.card.name}.`,
						atkPlayer.playerId
					);
				} else {
					// Unblocked -> deals combat damage to defending player
					if (!defPlayer.protectionFromEverythingThisTurn) {
						if (atkInfect) {
							defPlayer.poison += remainingDamage;
						} else if (!defPlayer.lifeTotalCannotChangeThisTurn) {
							defPlayer.life -= remainingDamage;
						}
						totalDealtByAttacker += remainingDamage;
						emitEvent(state, {
							kind: 'DamageDealt',
							sourceId: attacker.instanceId,
							targetId: defPlayer.playerId,
							targetKind: 'player',
							amount: remainingDamage,
							combat: true
						});
					}

					emitVfx(state, {
						kind: 'damage',
						sourceId: attacker.instanceId,
						targetId: defPlayer.playerId,
						amount: remainingDamage,
						label: atkInfect ? `+${remainingDamage} Poison` : `-${remainingDamage}`
					});

					// Track Commander Combat Damage (CR 903.10a)
					if (attacker.isCommander && !defPlayer.protectionFromEverythingThisTurn) {
						defPlayer.commanderDamageTaken[attacker.instanceId] =
							(defPlayer.commanderDamageTaken[attacker.instanceId] || 0) + remainingDamage;
						addLog(
							state,
							'combat',
							`Commander ${attacker.card.name} dealt ${remainingDamage} combat damage to ${defPlayer.username} (Total: ${defPlayer.commanderDamageTaken[attacker.instanceId]}/${state.rules.commanderDamageLethal || '∞'}).`,
							atkPlayer.playerId
						);
					} else {
						addLog(
							state,
							'combat',
							`${attacker.card.name} dealt ${remainingDamage} unblocked ${atkInfect ? 'Infect (Poison) ' : ''}combat damage to ${defPlayer.username}.`,
							atkPlayer.playerId
						);
					}
				}
			} else if (atkEntry.wasBlocked && blockers.length === 0 && !atkTrample) {
				// CR 509.1h / 510.1c: An attacking creature that became blocked remains blocked even if all blockers
				// left the battlefield before combat damage. Without Trample, it assigns 0 combat damage!
				addLog(
					state,
					'combat',
					`${attacker.card.name} was blocked (its blocker left combat) and does not have Trample, so it deals no combat damage (CR 510.1c).`,
					atkPlayer.playerId
				);
			} else {
				// Blocked -> assign lethal damage to remaining blockers in order
				for (let i = 0; i < blockers.length; i++) {
					const b = blockers[i];
					const bSnap = snapshots.get(b.instanceId)!;
					const bTough = bSnap.toughness;
					const remTough = Math.max(1, bTough - b.damageMarked);
					const lethalNeeded = atkDeathtouch ? 1 : remTough;

					const isLastBlocker = i === blockers.length - 1;
					const dmgToBlocker =
						isLastBlocker && !atkTrample
							? remainingDamage
							: Math.min(remainingDamage, lethalNeeded);

					if (dmgToBlocker > 0) {
						if (atkInfect) {
							b.counters['-1/-1'] = (b.counters['-1/-1'] || 0) + dmgToBlocker;
						} else {
							b.damageMarked += dmgToBlocker;
						}
						if (atkDeathtouch) b.deathtouchDamageMarked = true;
						emitEvent(state, {
							kind: 'DamageDealt',
							sourceId: attacker.instanceId,
							targetId: b.instanceId,
							targetKind: 'permanent',
							amount: dmgToBlocker,
							combat: true
						});
						remainingDamage -= dmgToBlocker;
						totalDealtByAttacker += dmgToBlocker;
						emitVfx(state, {
							kind: 'damage',
							sourceId: attacker.instanceId,
							targetId: b.instanceId,
							amount: dmgToBlocker
						});
					}
				}

				// CR 702.19c: Trample excess damage carries over to the player or planeswalker being attacked!
				if (atkTrample && remainingDamage > 0) {
					if (defWalker) {
						defWalker.counters.loyalty = Math.max(
							0,
							(defWalker.counters.loyalty || 0) - remainingDamage
						);
						totalDealtByAttacker += remainingDamage;
						emitEvent(state, {
							kind: 'DamageDealt',
							sourceId: attacker.instanceId,
							targetId: defWalker.instanceId,
							targetKind: 'permanent',
							amount: remainingDamage,
							combat: true
						});
						emitVfx(state, {
							kind: 'damage',
							sourceId: attacker.instanceId,
							targetId: defWalker.instanceId,
							amount: remainingDamage,
							label: `Trample -${remainingDamage} Loyalty`
						});
						addLog(
							state,
							'combat',
							`${attacker.card.name} trampled over for ${remainingDamage} combat damage to ${defWalker.card.name}!`,
							atkPlayer.playerId
						);
					} else {
						if (!defPlayer.protectionFromEverythingThisTurn) {
							if (atkInfect) {
								defPlayer.poison += remainingDamage;
							} else if (!defPlayer.lifeTotalCannotChangeThisTurn) {
								defPlayer.life -= remainingDamage;
							}
							totalDealtByAttacker += remainingDamage;
							if (attacker.isCommander) {
								defPlayer.commanderDamageTaken[attacker.instanceId] =
									(defPlayer.commanderDamageTaken[attacker.instanceId] || 0) + remainingDamage;
							}
							emitEvent(state, {
								kind: 'DamageDealt',
								sourceId: attacker.instanceId,
								targetId: defPlayer.playerId,
								targetKind: 'player',
								amount: remainingDamage,
								combat: true
							});
						}
						emitVfx(state, {
							kind: 'damage',
							sourceId: attacker.instanceId,
							targetId: defPlayer.playerId,
							amount: remainingDamage,
							label: atkInfect ? `Trample +${remainingDamage} Poison` : `Trample -${remainingDamage}`
						});
						addLog(
							state,
							'combat',
							`${attacker.card.name} trampled over for ${remainingDamage} ${atkInfect ? 'Infect (Poison) ' : ''}combat damage to ${defPlayer.username}!`,
							atkPlayer.playerId
						);
					}
				}
			}

			if (atkLifelink && totalDealtByAttacker > 0 && !atkPlayer.lifeTotalCannotChangeThisTurn) {
				atkPlayer.life += totalDealtByAttacker;
				emitVfx(state, {
					kind: 'heal',
					targetId: atkPlayer.playerId,
					amount: totalDealtByAttacker,
					label: `+${totalDealtByAttacker} Lifelink`
				});
			}
		}

		// Blockers deal combat damage to Attacker using snapshotted power/keywords (CR 510.2)
		if (!combatDamagePrevented) {
			for (const b of blockers) {
				const bSnap = snapshots.get(b.instanceId)!;
				const blockerDealsNow = bSnap.dealsNow;
				if (isFirstStrikeStep && blockerDealsNow) {
					if (!state.combat.dealtFirstStrikeDamageIds.includes(b.instanceId)) {
						state.combat.dealtFirstStrikeDamageIds.push(b.instanceId);
					}
				}
				const bPower = bSnap.power;
				const bInfect = bSnap.hasInfect;

				if (blockerDealsNow && bPower > 0) {
					if (bInfect) {
						attacker.counters['-1/-1'] = (attacker.counters['-1/-1'] || 0) + bPower;
					} else {
						attacker.damageMarked += bPower;
					}
					if (bSnap.hasDeathtouch) {
						attacker.deathtouchDamageMarked = true;
					}
					emitEvent(state, {
						kind: 'DamageDealt',
						sourceId: b.instanceId,
						targetId: attacker.instanceId,
						targetKind: 'permanent',
						amount: bPower,
						combat: true
					});
					if (bSnap.hasLifelink && !defPlayer.lifeTotalCannotChangeThisTurn) {
						defPlayer.life += bPower;
					}
					emitVfx(state, {
						kind: 'damage',
						sourceId: b.instanceId,
						targetId: attacker.instanceId,
						amount: bPower
					});
				}
			}
		}
	}

	if (isFirstStrikeStep) {
		state.combat.damageDealtFirstStrike = true;
	} else {
		state.combat.damageDealtNormal = true;
	}
}

function clearEndOfTurnAndDamage(state: GameState): void {
	for (const p of state.players) {
		p.manaPool = createEmptyManaPool();
		p.preventAllCombatDamageThisTurn = false;
		for (const perm of p.battlefield) {
			perm.damageMarked = 0;
			perm.deathtouchDamageMarked = false;
			perm.tempPowerMod = 0;
			perm.tempToughnessMod = 0;
			perm.grantedKeywords = [];
			perm.switchedPTCount = 0;
		}
	}
}

function runCleanupStep(state: GameState): void {
	emptyAllPlayersManaPools(state);
	const activePlayer = state.players[state.activePlayerIndex];

	// Check if activePlayer has Reliquary Tower / Thought Vessel for unlimited hand size
	const hasNoMaxHandSize =
		state.rules.maxHandSize >= 99 || playerHasNoMaxHandSize(state, activePlayer);

	const maxHand = hasNoMaxHandSize ? 999 : state.rules.maxHandSize;
	if (activePlayer.hand.length > maxHand) {
		const excess = activePlayer.hand.length - maxHand;
		if (activePlayer.isBot) {
			const gyDest = checkGraveyardReplacementZone(state, 'graveyard').dest;
			for (const c of activePlayer.hand.slice(0, excess)) {
				moveObject(state, c, gyDest, {
					from: { player: activePlayer, zone: 'hand' },
					toPlayer: activePlayer
				});
			}
			beginPhase(state, 'cleanup', activePlayer);
			completeTurnCleanupAndPassTurn(state);
		} else {
			beginPhase(state, 'cleanup', activePlayer);
			const candidateIds = activePlayer.hand.map((c) => c.instanceId);
			const description = `Cleanup Step: Select ${excess} card(s) from your hand to discard.`;
			state.pendingPrompts.push({
				id: uid('prm', state),
				playerId: activePlayer.playerId,
				kind: 'discard_to_hand_size',
				purpose: 'discard_to_hand_size',
				title: `Discard Down to ${maxHand} Cards`,
				description,
				countRequired: excess,
				candidateInstanceIds: candidateIds,
				choice: {
					kind: 'chooseObjects',
					candidates: candidateIds,
					min: excess,
					max: excess,
					zone: 'hand',
					reason: description
				}
			});
		}
		return;
	}

	beginPhase(state, 'cleanup', activePlayer);
	completeTurnCleanupAndPassTurn(state);
}

function completeTurnCleanupAndPassTurn(state: GameState): void {
	// Clear marked damage, temporary EOT buffs, and Layer 7d P/T switches on all permanents (CR 514.2)
	clearEndOfTurnAndDamage(state);

	// CR 514.3a: Check SBAs and flush any triggers that triggered during cleanup
	checkStateBasedActions(state);
	flushTriggers(state);
	if (state.status === 'finished') return;
	if (state.stack.length > 0 || state.pendingPrompts.length > 0) {
		state.phase = 'cleanup';
		state.priorityPlayerIndex = state.activePlayerIndex;
		state.passedPriorityPlayerIds = [];
		return;
	}

	// CR 500.7: Check if there is a queued extra turn in LIFO order
	if (state.extraTurnQueue && state.extraTurnQueue.length > 0) {
		while (state.extraTurnQueue.length > 0) {
			const extraPlayerId = state.extraTurnQueue.pop()!;
			const extraIdx = state.players.findIndex((p) => p.playerId === extraPlayerId && !p.lost);
			if (extraIdx >= 0) {
				if (state.lastNormalTurnPlayerIndex === undefined) {
					state.lastNormalTurnPlayerIndex = state.activePlayerIndex;
				}
				state.activePlayerIndex = extraIdx;
				state.turnNumber += 1;
				addLog(
					state,
					'rule',
					`${state.players[extraIdx].username} begins their extra turn (CR 500.7)!`,
					extraPlayerId
				);
				runBeginningOfTurn(state);
				return;
			}
		}
	}

	// Otherwise advance activePlayerIndex to next alive player in normal turn order (CR 500.7)
	const baseIdx = state.lastNormalTurnPlayerIndex ?? state.activePlayerIndex;
	state.lastNormalTurnPlayerIndex = undefined;
	const count = state.players.length;
	for (let step = 1; step <= count; step++) {
		const nextIdx = (baseIdx + step) % count;
		if (!state.players[nextIdx].lost) {
			if (nextIdx <= baseIdx) {
				state.turnNumber += 1;
			}
			state.activePlayerIndex = nextIdx;
			break;
		}
	}

	runBeginningOfTurn(state);
}

function isAuraAttachmentLegal(
	state: GameState,
	aura: CardInstance,
	auraController: PlayerGameState,
	evalAura: EvaluatedPermanent,
	host: CardInstance,
	hostController: PlayerGameState
): boolean {
	if (host.phasedOut) return false;
	if (hasProtectionFrom(host, aura.copiableCard ?? aura.card, state)) return false;

	let enchantParam: string | undefined;
	const kwLine = evalAura.keywords.find((k) => k.toLowerCase().startsWith('enchant '));
	if (kwLine) {
		enchantParam = kwLine.slice('enchant '.length).trim();
	} else if (!evalAura.losesAllAbilities) {
		const def = compileCard(aura.copiableCard ?? aura.card);
		for (const ab of def.faces[0]?.abilities ?? []) {
			if (ab.kind === 'keyword' && ab.keyword.name.toLowerCase() === 'enchant') {
				enchantParam = ab.keyword.param ?? 'permanent';
				break;
			}
		}
	}
	if (!enchantParam) return true;

	let param = enchantParam.toLowerCase().trim();
	if (param.includes('you control')) {
		if (hostController.playerId !== auraController.playerId) return false;
		param = param.replace(/\byou control\b/g, '').trim();
	} else if (param.includes('opponent controls')) {
		if (hostController.playerId === auraController.playerId) return false;
		param = param.replace(/\ban?\s+opponent controls\b|\bopponent controls\b/g, '').trim();
	}

	const evalHost = evaluatePermanent(state, host);
	if (param.includes('nonland')) {
		if (evalHost.isLand) return false;
		param = param.replace(/\bnonland\b/g, '').trim();
	}
	if (!param || param.includes('permanent')) return true;

	const disjuncts = param
		.split(/\s*(?:,|\bor\b)\s*/)
		.map((d) => d.trim())
		.filter(Boolean);
	if (disjuncts.length === 0) return true;

	return disjuncts.some((d) => {
		if (d === 'creature') return evalHost.isCreature;
		if (d === 'artifact') return evalHost.isArtifact;
		if (d === 'enchantment') return evalHost.isEnchantment;
		if (d === 'land') return evalHost.isLand;
		if (d === 'planeswalker') return evalHost.isPlaneswalker;
		if (d === 'battle') return evalHost.typeLine.includes('Battle');
		return evalHost.hasSubType(d) || evalHost.typeLine.toLowerCase().includes(d);
	});
}

/**
 * CR 704.3: State-Based Actions are checked in an iterative fixpoint loop
 * until a pass produces no state-based actions.
 */
export function checkStateBasedActions(state: GameState): void {
	if (state.status !== 'active') return;

	let maxIterations = 25;
	let anyActionTaken = true;

	while (anyActionTaken && maxIterations-- > 0) {
		anyActionTaken = false;

		// 0. Pre-annihilation LKI snapshot (CR 704.8) before any SBAs in this pass modify the board
		const prePassSnapshot = new Map<
			string,
			{ counters: Record<CounterType, number>; evalPerm: EvaluatedPermanent }
		>();
		// Read-only scan: validate the layer cache once (Phase 6c).
		withStableLayerInputs(state, () => {
			for (const p of state.players) {
				if (p.lost) continue;
				for (const perm of p.battlefield) {
					if (perm.phasedOut) continue;
					prePassSnapshot.set(perm.instanceId, {
						counters: { ...perm.counters },
						evalPerm: evaluatePermanent(state, perm)
					});
				}
			}
		});

		// 1. +1/+1 and -1/-1 counter annihilation (CR 704.5q)
		for (const p of state.players) {
			if (p.lost) continue;
			for (const perm of p.battlefield) {
				if (perm.phasedOut) continue;
				const plus = perm.counters['+1/+1'] || 0;
				const minus = perm.counters['-1/-1'] || 0;
				if (plus > 0 && minus > 0) {
					const cancel = Math.min(plus, minus);
					perm.counters['+1/+1'] -= cancel;
					perm.counters['-1/-1'] -= cancel;
					anyActionTaken = true;
				}
			}
		}

		// Collect all battlefield-to-graveyard SBAs across all players in this pass (CR 704.3, 603.10a)
		const sbaGraveyardBatch: Array<{
			perm: CardInstance;
			controller: PlayerGameState;
			kind: 'aura' | 'dying' | 'legend';
			legName?: string;
		}> = [];
		const queuedIds = new Set<string>();
		const queueToGraveyard = (
			perm: CardInstance,
			controller: PlayerGameState,
			kind: 'aura' | 'dying' | 'legend',
			legName?: string
		) => {
			if (queuedIds.has(perm.instanceId)) return;
			queuedIds.add(perm.instanceId);
			sbaGraveyardBatch.push({ perm, controller, kind, legName });
		};

		// Steps 2-4 only read layer results, except the `attachedToId` writes, each followed by
		// noteLayerInputsChanged (Phase 6c).
		withStableLayerInputs(state, () => {
			for (const p of state.players) {
				if (p.lost) continue;

				// 2. Unattach Auras/Equipment attached to illegal/missing/non-creature permanents (CR 303.4d, 702.16c-d, 704.5m-n)
				for (const perm of p.battlefield) {
					if (perm.phasedOut) continue;
					const evalPerm = evaluatePermanent(state, perm);
					const isAura = evalPerm.hasSubType('Aura') || evalPerm.typeLine.includes('Aura');
					const isEquipment =
						evalPerm.hasSubType('Equipment') || evalPerm.typeLine.includes('Equipment');

					if (isAura) {
						if (!perm.attachedToId) {
							queueToGraveyard(perm, p, 'aura');
						} else {
							const targetFound = findPermanentOnBoard(state, perm.attachedToId);
							if (
								!targetFound ||
								!isAuraAttachmentLegal(
									state,
									perm,
									p,
									evalPerm,
									targetFound.inst,
									targetFound.controller
								)
							) {
								perm.attachedToId = null;
								noteLayerInputsChanged(state);
								queueToGraveyard(perm, p, 'aura');
							}
						}
					} else if (isEquipment && perm.attachedToId) {
						const targetFound = findPermanentOnBoard(state, perm.attachedToId);
						if (
							!targetFound ||
							!evaluatePermanent(state, targetFound.inst).typeLine.includes('Creature') ||
							hasProtectionFrom(targetFound.inst, perm.copiableCard ?? perm.card, state)
						) {
							perm.attachedToId = null;
							noteLayerInputsChanged(state);
							anyActionTaken = true;
						}
					} else if (perm.attachedToId) {
						const targetFound = findPermanentOnBoard(state, perm.attachedToId);
						if (!targetFound) {
							perm.attachedToId = null;
							noteLayerInputsChanged(state);
							anyActionTaken = true;
						}
					}
				}

				// 3. Creature lethal damage / 0 toughness / Deathtouch SBA (CR 704.5f-h) & Planeswalker 0 loyalty (CR 704.5i)
				for (const perm of p.battlefield) {
					if (perm.phasedOut || queuedIds.has(perm.instanceId)) continue;
					const evalPerm = evaluatePermanent(state, perm);
					let dies = false;
					if (evalPerm.typeLine.includes('Creature')) {
						const tough = evalPerm.toughness;
						if (tough <= 0) {
							dies = true;
						} else if (perm.damageMarked >= tough || perm.deathtouchDamageMarked) {
							if (!evalPerm.keywords.some((k) => k.toLowerCase() === 'indestructible')) {
								dies = true;
							} else if (perm.deathtouchDamageMarked) {
								// CR 704.5h: Clear deathtouch damage flag once SBAs have been checked and creature survived
								perm.deathtouchDamageMarked = false;
							}
						}
					}
					if (!dies && evalPerm.typeLine.includes('Planeswalker') && perm.counters.loyalty <= 0) {
						dies = true;
					}
					if (dies) {
						queueToGraveyard(perm, p, 'dying');
					}
				}

				// 4. Legend Rule (CR 704.5j): Duplicate legendary permanents with the same name (skipping face-down per CR 201.2a / 708.2a)
				const legendaryByName = new Map<string, CardInstance[]>();
				for (const perm of p.battlefield) {
					if (perm.phasedOut || perm.isFaceDown || queuedIds.has(perm.instanceId)) continue;
					const evalPerm = evaluatePermanent(state, perm);
					const name = evalPerm.effectiveName || perm.card.name;
					if (evalPerm.typeLine.includes('Legendary') && name) {
						const list = legendaryByName.get(name) || [];
						list.push(perm);
						legendaryByName.set(name, list);
					}
				}
				for (const [legName, list] of legendaryByName.entries()) {
					if (list.length > 1) {
						if (p.isBot) {
							// Bots keep the best copy and put other copies into graveyard (CR 704.5j)
							let best = list[list.length - 1];
							let bestScore = -Infinity;
							for (let idx = 0; idx < list.length; idx++) {
								const cand = list[idx];
								const ev = evaluatePermanent(state, cand);
								const score =
									(!cand.isToken ? 100 : 0) +
									(ev.power + ev.toughness) * 10 +
									(cand.counters['+1/+1'] ?? 0) * 15 -
									(cand.counters['-1/-1'] ?? 0) * 15 +
									(cand.counters.loyalty ?? 0) * 10 +
									getAttachedCardsOnBoard(state, cand.instanceId).length * 20 +
									(!cand.tapped ? 2 : 0) +
									(!cand.summoningSick ? 2 : 0) +
									idx;
								if (score >= bestScore) {
									bestScore = score;
									best = cand;
								}
							}
							for (const cand of list) {
								if (cand.instanceId !== best.instanceId) {
									queueToGraveyard(cand, p, 'legend', legName);
								}
							}
						} else {
							const cands = list.map((c) => c.instanceId);
							const alreadyPrompted = state.pendingPrompts.some((pr) => {
								if (pr.playerId !== p.playerId) return false;
								if ((pr.purpose ?? pr.kind) !== 'legend_rule') return false;
								const prCands =
									pr.candidateInstanceIds ??
									(pr.choice?.kind === 'chooseObjects' ? pr.choice.candidates : []);
								return cands.some((id) => prCands.includes(id));
							});
							if (!alreadyPrompted) {
								enqueueChoicePrompt(state, {
									id: uid('prm', state),
									playerId: p.playerId,
									kind: 'legend_rule',
									purpose: 'legend_rule',
									title: `Legend Rule — ${legName}`,
									description: `Choose one ${legName} to keep on the battlefield. The other(s) will be put into your graveyard (CR 704.5j).`,
									candidateInstanceIds: cands,
									countRequired: 1
								});
							}
						}
					}
				}
			}
		});

		// Execute all simultaneous battlefield-to-graveyard SBAs for this pass (CR 603.10a, CR 704.8),
		// preserving per-player SBA processing order while keeping all batch permanents on the battlefield
		// in their pre-batch state during each movePermanentToZone call so LKI and dies triggers see the
		// full pre-batch board across all players.
		if (sbaGraveyardBatch.length > 0) {
			anyActionTaken = true;
			for (const { perm } of sbaGraveyardBatch) {
				const pre = prePassSnapshot.get(perm.instanceId);
				if (pre) {
					perm.lastKnownCounters = { ...pre.counters };
					perm.lastKnownPower = pre.evalPerm.power;
					perm.lastKnownToughness = pre.evalPerm.toughness;
					perm.counters = { ...pre.counters };
				}
			}
		}

		const preBattlefields =
			sbaGraveyardBatch.length > 1
				? new Map<PlayerGameState, CardInstance[]>(
						state.players.map((pl) => [pl, [...pl.battlefield]])
					)
				: null;
		const preItemStates =
			sbaGraveyardBatch.length > 1
				? new Map<string, CardInstance>(
						sbaGraveyardBatch.map(({ perm }) => [
							perm.instanceId,
							{
								...perm,
								counters: { ...perm.counters },
								grantedKeywords: [...perm.grantedKeywords]
							}
						])
					)
				: null;
		const postResults = new Map<
			string,
			{
				perm: CardInstance;
				postState: CardInstance;
				destZone: 'graveyard' | 'exile' | 'command';
				owner: PlayerGameState | undefined;
			}
		>();

		for (const p of state.players) {
			if (p.lost) continue;

			const playerBatch = sbaGraveyardBatch.filter((item) => item.controller.playerId === p.playerId);
			for (const item of playerBatch) {
				if (sbaGraveyardBatch.length > 1 && preBattlefields && preItemStates) {
					for (const [pl, bf] of preBattlefields.entries()) {
						setZoneOrder(pl, 'battlefield', [...bf]);
					}
					for (const prev of postResults.values()) {
						if (prev.owner) {
							setZoneOrder(
								prev.owner,
								prev.destZone,
								prev.owner[prev.destZone].filter((c) => c.instanceId !== prev.perm.instanceId)
							);
						}
						const preState = preItemStates.get(prev.perm.instanceId);
						if (preState) {
							Object.assign(prev.perm, preState, {
								counters: { ...preState.counters },
								grantedKeywords: [...preState.grantedKeywords]
							});
						}
					}
				}

				if (item.kind === 'dying') {
					emitVfx(state, {
						kind: 'destroy',
						targetId: item.perm.instanceId,
						label: item.perm.card.name
					});
				}
				const actualDest = movePermanentToZone(state, item.perm, 'graveyard');
				if (item.kind === 'dying') {
					const replacerName =
						actualDest === 'exile'
							? checkGraveyardReplacementZone(state, 'graveyard').replacedBy
							: null;
					addLog(
						state,
						'sba',
						`${item.perm.card.name} ${actualDest === 'exile' ? `was exiled instead of dying${replacerName ? ` (${replacerName})` : ''}` : 'died'} (State-Based Action).`,
						item.controller.playerId
					);
				} else if (item.kind === 'legend') {
					addLog(
						state,
						'sba',
						`Legend Rule (CR 704.5j): Duplicate ${item.legName} was put into ${item.controller.username}'s graveyard.`,
						item.controller.playerId
					);
				}

				if (sbaGraveyardBatch.length > 1) {
					const owner = state.players.find((pl) => pl.playerId === item.perm.ownerId);
					postResults.set(item.perm.instanceId, {
						perm: item.perm,
						postState: {
							...item.perm,
							counters: { ...item.perm.counters },
							grantedKeywords: [...item.perm.grantedKeywords]
						},
						destZone: actualDest === 'exile' ? 'exile' : 'graveyard',
						owner
					});
				}
			}

			if (sbaGraveyardBatch.length > 1 && playerBatch.length > 0) {
				// Restore already-processed batch items to their post-move zones before running Step 5 & 6 for player p
				for (const pl of state.players) {
					setZoneOrder(
						pl,
						'battlefield',
						pl.battlefield.filter((c) => !postResults.has(c.instanceId))
					);
				}
				for (const res of postResults.values()) {
					Object.assign(res.perm, res.postState, {
						counters: { ...res.postState.counters },
						grantedKeywords: [...res.postState.grantedKeywords]
					});
					if (res.owner && !res.perm.isToken) {
						const curZone = res.owner[res.destZone];
						if (!curZone.some((c) => c.instanceId === res.perm.instanceId)) {
							setZoneOrder(res.owner, res.destZone, [...curZone, res.perm]);
						}
					}
				}
			}

			// 5. Token cleanup outside the battlefield (CR 704.5d)
			const prevGraveLen = p.graveyard.length;
			const prevExileLen = p.exile.length;
			const prevHandLen = p.hand.length;
			const prevLibLen = p.library.length;
			removeFromGame(p, 'graveyard', (c) => c.isToken);
			removeFromGame(p, 'exile', (c) => c.isToken);
			removeFromGame(p, 'hand', (c) => c.isToken);
			removeFromGame(p, 'library', (c) => c.isToken);
			if (
				p.graveyard.length !== prevGraveLen ||
				p.exile.length !== prevExileLen ||
				p.hand.length !== prevHandLen ||
				p.library.length !== prevLibLen
			) {
				anyActionTaken = true;
			}

			// 6. Commander Zone Change SBA (CR 704.6d / 903.9a)
			const commandersInGraveOrExile = [
				...p.graveyard.filter((c) => c.isCommander),
				...p.exile.filter((c) => c.isCommander)
			];
			for (const cmd of commandersInGraveOrExile) {
				const curVersion = cmd.objectVersion ?? 1;
				if (
					cmd.commanderSbaDeclinedVersion !== undefined &&
					cmd.commanderSbaDeclinedVersion === curVersion
				) {
					continue;
				}
				if (p.isBot) {
					cmd.damageMarked = 0;
					cmd.deathtouchDamageMarked = false;
					cmd.tapped = false;
					moveObject(state, cmd, 'command', {
						from: { player: p, zone: p.graveyard.includes(cmd) ? 'graveyard' : 'exile' },
						toPlayer: p
					});
					const postEntry = postResults.get(cmd.instanceId);
					if (postEntry) {
						postEntry.destZone = 'command';
						postEntry.postState = {
							...cmd,
							counters: { ...cmd.counters },
							grantedKeywords: [...cmd.grantedKeywords]
						};
					}
					addLog(
						state,
						'sba',
						`${p.username} returned Commander ${cmd.card.name} to the Command Zone.`,
						p.playerId
					);
					anyActionTaken = true;
				} else if (
					!state.pendingPrompts.some(
						(pr) =>
							pr.kind === 'commander_zone_choice' && pr.commanderInstanceId === cmd.instanceId
					)
				) {
					const description = `${cmd.card.name} was put into your ${cmd.zone}. Under Commander Rule 903.9a, you may move it to the Command Zone.`;
					state.pendingPrompts.push({
						id: uid('prm', state),
						playerId: p.playerId,
						kind: 'commander_zone_choice',
						purpose: 'commander_zone_choice',
						title: `Return ${cmd.card.name} to Command Zone?`,
						description,
						commanderInstanceId: cmd.instanceId,
						destinationZone: cmd.zone,
						yesLabel: 'Yes — Move to Command Zone',
						noLabel: `No — Leave in ${cmd.zone}`,
						choice: {
							kind: 'yesNo',
							question: description
						}
					});
				}
			}
		}

		if (sbaGraveyardBatch.length > 1) {
			for (const pl of state.players) {
				for (const b of pl.battlefield) {
					if (b.attachedToId && queuedIds.has(b.attachedToId)) {
						b.attachedToId = null;
					}
				}
			}
		}

		// 7. Simultaneous Player Loss SBAs (CR 104.3c, 104.4a, 704.5a-c, 903.10a) — respects Platinum Angel!
		const newlyEliminated: Array<{
			player: PlayerGameState;
			reason: string;
			logText: string;
		}> = [];
		// Read-only: one layer-cache validation for every player's "can't lose" check (Phase 6d).
		const cannotLose = withStableLayerInputs(
			state,
			() => new Set(state.players.filter((p) => !p.lost && playerCannotLoseGame(state, p).protected))
		);
		for (const p of state.players) {
			if (p.lost) continue;
			if (cannotLose.has(p)) {
				if (p.attemptedEmptyLibraryDraw) {
					// CR 704.5b only checks if the player attempted to draw from an empty library since the last SBA check
					p.attemptedEmptyLibraryDraw = false;
				}
				continue;
			}
			if (p.life <= 0) {
				newlyEliminated.push({
					player: p,
					reason: `Life total reached ${p.life}.`,
					logText: `${p.username} has ${p.life} life and loses the game!`
				});
			} else if (state.rules.poisonLethal > 0 && p.poison >= state.rules.poisonLethal) {
				newlyEliminated.push({
					player: p,
					reason: `Accumulated ${p.poison} Poison counters.`,
					logText: `${p.username} has ${p.poison} poison counters and loses the game!`
				});
			} else if (p.attemptedEmptyLibraryDraw) {
				newlyEliminated.push({
					player: p,
					reason: 'Attempted to draw a card from an empty library (Decked Out).',
					logText: `${p.username} lost the game: Attempted to draw a card from an empty library (Decked Out).`
				});
			} else if (state.rules.commanderDamageLethal > 0) {
				for (const [cmdId, dmg] of Object.entries(p.commanderDamageTaken)) {
					if (dmg >= state.rules.commanderDamageLethal) {
						const cmdName = p.commanderNames[cmdId] || 'a Commander';
						newlyEliminated.push({
							player: p,
							reason: `Dealt ${dmg} combat damage by ${cmdName}.`,
							logText: `${p.username} took ${dmg} Commander combat damage from ${cmdName} and loses the game!`
						});
						break;
					}
				}
			}
		}

		if (newlyEliminated.length > 0) {
			anyActionTaken = true;
			for (const { player: p, reason, logText } of newlyEliminated) {
				p.lost = true;
				p.lossReason = reason;
				p.attemptedEmptyLibraryDraw = false;
				addLog(state, 'sba', logText, p.playerId);
			}
			for (const { player: p } of newlyEliminated) {
				cleanupEliminatedPlayer(state, p);
			}
			// CR 104.2a / 104.4a: If 0 or 1 players remain after simultaneous losses, the game ends immediately
			const remainingNow = state.players.filter((p) => !p.lost);
			if (remainingNow.length <= 1 && state.players.length > 1) {
				break;
			}
		}
	}

	// CR 704.3: Flush all triggers generated during the SBA loop once after the loop stabilizes
	flushTriggers(state);

	// Check Win / Draw Condition (CR 104.2a / 104.4a)
	const remaining = state.players.filter((p) => !p.lost);
	if (remaining.length === 0 && state.players.length > 0) {
		state.status = 'finished';
		state.winnerPlayerId = null;
		state.winnerId = undefined;
		addLog(
			state,
			'system',
			'All remaining players lost simultaneously — the game is a draw (CR 104.4a)!'
		);
	} else if (remaining.length === 1 && state.players.length > 1) {
		const winner = remaining[0];
		if (winner && !playerCannotWinGame(state, winner).blocked) {
			state.status = 'finished';
			state.winnerPlayerId = winner.playerId;
			state.winnerId = winner.playerId;
			addLog(
				state,
				'system',
				`${winner.username} wins the Commander match!`,
				winner.playerId
			);
			emitVfx(state, {
				kind: 'victory',
				sourceId: winner.playerId,
				label: `${winner.username} Wins!`
			});
		}
	}
}

export function cleanupEliminatedPlayer(state: GameState, eliminated: PlayerGameState): void {
	const elimId = eliminated.playerId;

	// 1. Remove pending prompts for eliminated player
	state.pendingPrompts = state.pendingPrompts.filter((pr) => pr.playerId !== elimId);

	// 2. Remove spells/abilities controlled by eliminated player from the Stack (CR 800.4a)
	state.stack = state.stack.filter((item) => item.controllerId !== elimId);

	// 3. Remove eliminated player's attackers/blockers from combat
	const elimPermIds = new Set(eliminated.battlefield.map((c) => c.instanceId));
	state.combat.attackers = state.combat.attackers.filter(
		(a) => a.controllerId !== elimId && a.defenderPlayerId !== elimId
	);
	for (const atk of state.combat.attackers) {
		atk.blockerInstanceIds = atk.blockerInstanceIds.filter((bId) => !elimPermIds.has(bId));
	}
	if (state.combat.declaredBlockersPlayerIds) {
		state.combat.declaredBlockersPlayerIds = state.combat.declaredBlockersPlayerIds.filter(
			(id) => id !== elimId
		);
	}
	if (state.combat.attackers.length === 0 && state.combat.active) {
		state.combat.active = false;
	}

	// 4. Return any permanents owned by other players or remove objects owned by eliminated player (CR 800.4a)
	for (const perm of [...eliminated.battlefield]) {
		if (perm.ownerId !== elimId) {
			const owner = state.players.find((pl) => pl.playerId === perm.ownerId && !pl.lost);
			if (owner) {
				perm.controllerId = owner.playerId;
				perm.attachedToId = null;
				transferBattlefieldControl(perm, eliminated, owner);
			}
		}
	}
	removeFromGame(eliminated, 'battlefield');

	// Also remove any cards in eliminated player's graveyard, command, exile, hand, and library,
	// and any cards in other players' zones owned by the eliminated player (CR 800.4a)
	if (!(state.lobbyCode === 'GOLDEN' && state.players.length === 2)) {
		removeFromGame(eliminated, 'graveyard');
		removeFromGame(eliminated, 'command');
	}
	removeFromGame(eliminated, 'exile');
	removeFromGame(eliminated, 'hand');
	removeFromGame(eliminated, 'library');
	for (const other of state.players) {
		if (other.playerId === elimId) continue;
		removeFromGame(other, 'battlefield', (c) => c.ownerId === elimId);
		removeFromGame(other, 'graveyard', (c) => c.ownerId === elimId);
		removeFromGame(other, 'command', (c) => c.ownerId === elimId);
		removeFromGame(other, 'exile', (c) => c.ownerId === elimId);
		removeFromGame(other, 'hand', (c) => c.ownerId === elimId);
		removeFromGame(other, 'library', (c) => c.ownerId === elimId);
		for (const exCard of other.exile) {
			if (exCard.playableFromExileBy?.playerId === elimId) {
				exCard.playableFromExileBy = undefined;
			}
		}
		for (const b of other.battlefield) {
			if (b.attachedToId && elimPermIds.has(b.attachedToId)) {
				b.attachedToId = null;
			}
		}
	}

	state.passedPriorityPlayerIds = state.passedPriorityPlayerIds.filter((id) => id !== elimId);

	// 5. If the game continues (2+ alive players remain), advance active turn or priority if held by eliminated player
	const alive = state.players.filter((p) => !p.lost);
	if (alive.length > 1 && state.status === 'active') {
		const activePlayer = state.players[state.activePlayerIndex];
		const priorityPlayer = state.players[state.priorityPlayerIndex];
		if (activePlayer?.playerId === elimId) {
			completeTurnCleanupAndPassTurn(state);
		} else if (priorityPlayer?.playerId === elimId) {
			advancePriorityToNextPlayer(state);
		}
	}
}

/**
 * CR 702.26b: While a permanent is phased out, it's treated as though it does not exist.
 * `findPermanentOnBoard` returns `null` if the permanent is phased out.
 */
export function findPermanentOnBoard(
	state: GameState,
	instanceId: string
): { inst: CardInstance; owner: PlayerGameState; controller: PlayerGameState } | null {
	for (const p of state.players) {
		const inst = p.battlefield.find((c) => !c.phasedOut && c.instanceId === instanceId);
		if (inst) {
			const owner = state.players.find((o) => o.playerId === inst.ownerId) || p;
			return { inst, owner, controller: p };
		}
	}
	return null;
}

/**
 * Moves a permanent from the battlefield to `dest`, applying CR 614 zone-change replacement
 * effects (`Rest in Peace` -> Exile; Commander CR 903.9b -> Command Zone if bounced/tucked for bots)
 * and incrementing `objectVersion` (CR 400.7 new object identity).
 * Returns the actual destination zone the object ended up in.
 */
export function movePermanentToZone(
	state: GameState,
	inst: CardInstance,
	dest: ZoneType
): ZoneType {
	return moveObject(state, inst, dest, {
		from: 'anyBattlefield',
		detachAttachments: true,
		graveyardReplacement: true,
		commanderRedirect: true,
		leaveBattlefieldReset: true,
		bumpVersion: true,
		newTimestamp: true,
		// The old code put cards on top of the library and at the end of every other zone.
		insert: (actual) => (actual === 'library' ? 'start' : 'end'),
		ceaseToExist: 'tokens'
	});
}

export function matchesPermanentTypeFilter(
	perm: CardInstance,
	typeFilter: string,
	state?: GameState
): boolean {
	if (perm.phasedOut) return false;
	const evalPerm = state ? evaluatePermanent(state, perm) : undefined;
	const tLine = evalPerm ? evalPerm.typeLine : perm.card.typeLine;
	if (typeFilter === 'Permanent') return true;
	if (typeFilter === 'ArtifactOrCreature') {
		return tLine.includes('Artifact') || tLine.includes('Creature');
	}
	if (typeFilter === 'CreatureOrPlaneswalker') {
		return tLine.includes('Creature') || tLine.includes('Planeswalker');
	}
	if (typeFilter === 'ArtifactOrEnchantment') {
		return tLine.includes('Artifact') || tLine.includes('Enchantment');
	}
	if (typeFilter === 'NonlandPermanent') {
		return !tLine.includes('Land');
	}
	if (/^[A-Z][a-z]+(?:Or[A-Z][a-z]+)+$/.test(typeFilter)) {
		return typeFilter.split('Or').some((part) => tLine.includes(part));
	}
	if (typeFilter.includes(' ')) {
		const tLow = tLine.toLowerCase();
		const words = typeFilter.trim().split(/\s+/);
		return words.every((w) => {
			const wLow = w.toLowerCase();
			if (wLow === 'commander') return Boolean(perm.isCommander);
			if (evalPerm?.hasSubType(w)) return true;
			return tLow.includes(wLow);
		});
	}
	return tLine.includes(typeFilter);
}

export function hasProtectionFrom(
	targetPerm: CardInstance,
	sourceCard: ScryfallCard | undefined,
	state: GameState
): boolean {
	if (!sourceCard || targetPerm.phasedOut) return false;
	const evalTarget = evaluatePermanent(state, targetPerm);
	const textsToCheck: string[] = [
		...(evalTarget.losesAllAbilities
			? []
			: [
					...keywordsOf(targetPerm.copiableCard ?? targetPerm.card).map(({ name: kwName, param }) =>
						`${kwName}${param ? ` ${param}` : ''}`.toLowerCase()
					),
					...(targetPerm.copiableCard ?? targetPerm.card).keywords.map((k) => k.toLowerCase())
				]),
		...targetPerm.grantedKeywords.map((k) => k.toLowerCase()),
		...evalTarget.activeKeywords.map((k) => k.toLowerCase())
	];

	const combined = textsToCheck.join('\n');
	if (!combined.includes('protection from')) return false;

	if (/protection from everything/i.test(combined)) return true;
	if (/protection from all colors/i.test(combined) && sourceCard.colors.length > 0) return true;
	if (/protection from multicolored/i.test(combined) && sourceCard.colors.length >= 2) return true;
	if (/protection from monocolored/i.test(combined) && sourceCard.colors.length === 1) return true;
	if (/protection from colorless/i.test(combined) && sourceCard.colors.length === 0) return true;
	if (/protection from [^.\n]*\bwhite\b/i.test(combined) && sourceCard.colors.includes('W')) return true;
	if (/protection from [^.\n]*\bblue\b/i.test(combined) && sourceCard.colors.includes('U')) return true;
	if (/protection from [^.\n]*\bblack\b/i.test(combined) && sourceCard.colors.includes('B')) return true;
	if (/protection from [^.\n]*\bred\b/i.test(combined) && sourceCard.colors.includes('R')) return true;
	if (/protection from [^.\n]*\bgreen\b/i.test(combined) && sourceCard.colors.includes('G')) return true;
	if (/protection from creatures/i.test(combined) && sourceCard.typeLine.includes('Creature')) {
		return true;
	}
	if (/protection from instants/i.test(combined) && sourceCard.typeLine.includes('Instant')) {
		return true;
	}
	if (/protection from sorceries/i.test(combined) && sourceCard.typeLine.includes('Sorcery')) {
		return true;
	}
	if (/protection from artifacts/i.test(combined) && sourceCard.typeLine.includes('Artifact')) {
		return true;
	}
	if (/protection from enchantments/i.test(combined) && sourceCard.typeLine.includes('Enchantment')) {
		return true;
	}

	return false;
}

export function playerHasHexproofFrom(
	state: GameState,
	targetPlayer: PlayerGameState,
	actorId: string
): boolean {
	if (targetPlayer.playerId === actorId) return false;
	if (targetPlayer.protectionFromEverythingThisTurn) return true;
	return replacePlayerHasHexproofFrom(state, targetPlayer, actorId);
}

export function playerHasShroud(state: GameState, targetPlayer: PlayerGameState): boolean {
	if (targetPlayer.protectionFromEverythingThisTurn) return true;
	return replacePlayerHasShroud(state, targetPlayer);
}

function normalizeTargetRequirement(
	reqOrKind: TargetRequirementInfo | string
): TargetRequirementInfo {
	if (typeof reqOrKind === 'object' && reqOrKind !== null && 'targetKind' in reqOrKind) {
		return reqOrKind;
	}
	const kind = (reqOrKind || 'none') as TargetRequirementInfo['targetKind'];
	return {
		requiresTarget: kind !== 'none',
		targetKind: kind,
		minTargets: kind !== 'none' ? 1 : 0,
		maxTargets: kind !== 'none' ? 1 : 0,
		zone:
			kind === 'spell'
				? 'stack'
				: kind === 'graveyard_card'
					? 'graveyard'
					: kind === 'any'
						? 'any'
						: 'battlefield',
		sameGraveyard: false,
		controllerFilter: kind === 'controlled_creature' ? 'you' : 'any',
		cardTypeFilter:
			kind === 'creature' || kind === 'controlled_creature'
				? 'Creature'
				: kind === 'artifact_or_enchantment'
					? 'ArtifactOrEnchantment'
					: kind === 'nonland_permanent'
						? 'NonlandPermanent'
						: undefined
	};
}

/** Whether `target` is legal for the requirement. Read-only, one validation (Phase 6d). */
export function validateTargetLegality(
	state: GameState,
	actorId: string,
	target: TargetRef,
	targetRequirementOrKind: TargetRequirementInfo | string,
	sourceCard?: ScryfallCard,
	sourceInstanceId?: string
): { ok: boolean; error?: string } {
	return withStableLayerInputs(state, () =>
		validateTargetLegalityInner(state, actorId, target, targetRequirementOrKind, sourceCard, sourceInstanceId)
	);
}

function validateTargetLegalityInner(
	state: GameState,
	actorId: string,
	target: TargetRef,
	targetRequirementOrKind: TargetRequirementInfo | string,
	sourceCard?: ScryfallCard,
	sourceInstanceId?: string
): { ok: boolean; error?: string } {
	const info = normalizeTargetRequirement(targetRequirementOrKind);
	const targetKind = info.targetKind;

	// 1. Stack spell target validation
	if (target.kind === 'stack' || info.zone === 'stack' || targetKind === 'spell') {
		if (target.kind !== 'stack' && (info.zone === 'stack' || targetKind === 'spell')) {
			return {
				ok: false,
				error: 'Strict Rules Violation: This spell or ability must target a spell on the Stack.'
			};
		}
		const inStack = state.stack.find((s) => s.id === target.id || s.sourceInstanceId === target.id);
		if (!inStack) return { ok: false, error: 'Target spell is not on the Stack.' };
		if (inStack.kind !== 'spell') {
			return {
				ok: false,
				error: 'Strict Rules Violation: Target on the Stack is an ability, not a spell.'
			};
		}
		if (
			sourceInstanceId &&
			(inStack.id === sourceInstanceId || inStack.sourceInstanceId === sourceInstanceId)
		) {
			return {
				ok: false,
				error: 'Strict Rules Violation: A spell cannot target itself on the Stack.'
			};
		}
		if (info.controllerFilter === 'opponent' && inStack.controllerId === actorId) {
			return {
				ok: false,
				error: 'Strict Rules Violation: Must target a spell controlled by an opponent.'
			};
		}
		if (info.controllerFilter === 'you' && inStack.controllerId !== actorId) {
			return {
				ok: false,
				error: 'Strict Rules Violation: Must target a spell you control.'
			};
		}
		if (info.cardTypeFilter) {
			const sType = inStack.card.typeLine;
			if (info.cardTypeFilter === 'Noncreature' && sType.includes('Creature')) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is a Creature spell (requires a noncreature spell).`
				};
			}
			if (info.cardTypeFilter === 'Creature' && !sType.includes('Creature')) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is not a Creature spell.`
				};
			}
			if (
				info.cardTypeFilter === 'InstantOrSorcery' &&
				!sType.includes('Instant') &&
				!sType.includes('Sorcery')
			) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is not an Instant or Sorcery spell.`
				};
			}
			if (info.cardTypeFilter === 'Instant' && !sType.includes('Instant')) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is not an Instant spell.`
				};
			}
			if (info.cardTypeFilter === 'Sorcery' && !sType.includes('Sorcery')) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is not a Sorcery spell.`
				};
			}
			if (info.cardTypeFilter === 'Artifact' && !sType.includes('Artifact')) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is not an Artifact spell.`
				};
			}
			if (info.cardTypeFilter === 'Enchantment' && !sType.includes('Enchantment')) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is not an Enchantment spell.`
				};
			}
		}
		return { ok: true };
	}

	// 2. Graveyard card target validation
	if (
		target.kind === 'graveyard_card' ||
		target.kind === 'card_in_graveyard' ||
		info.zone === 'graveyard' ||
		targetKind === 'graveyard_card'
	) {
		if (target.kind !== 'graveyard_card' && target.kind !== 'card_in_graveyard') {
			return {
				ok: false,
				error: 'Strict Rules Violation: This spell or ability must target a card in a graveyard.'
			};
		}
		let foundOwner: PlayerGameState | undefined;
		let foundCard: CardInstance | undefined;
		for (const p of state.players) {
			const c = p.graveyard.find((g) => g.instanceId === target.id);
			if (c) {
				foundOwner = p;
				foundCard = c;
				break;
			}
		}
		if (!foundCard || !foundOwner) {
			return { ok: false, error: 'Target card is not in any graveyard.' };
		}
		if (info.controllerFilter === 'you' && foundOwner.playerId !== actorId) {
			return {
				ok: false,
				error: 'Strict Rules Violation: Must target a card in your graveyard.'
			};
		}
		if (info.controllerFilter === 'opponent' && foundOwner.playerId === actorId) {
			return {
				ok: false,
				error: "Strict Rules Violation: Must target a card in an opponent's graveyard."
			};
		}
		if (info.cardTypeFilter) {
			const gType = foundCard.card.typeLine;
			if (
				info.cardTypeFilter === 'InstantOrSorcery' &&
				!gType.includes('Instant') &&
				!gType.includes('Sorcery')
			) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${foundCard.card.name} is not an Instant or Sorcery card.`
				};
			} else if (info.cardTypeFilter === 'Permanent') {
				const isPerm =
					gType.includes('Creature') ||
					gType.includes('Artifact') ||
					gType.includes('Enchantment') ||
					gType.includes('Land') ||
					gType.includes('Planeswalker') ||
					gType.includes('Battle');
				if (!isPerm) {
					return {
						ok: false,
						error: `Strict Rules Violation: ${foundCard.card.name} is not a permanent card.`
					};
				}
			} else if (info.cardTypeFilter === 'NonlandPermanent') {
				if (gType.includes('Land')) {
					return {
						ok: false,
						error: `Strict Rules Violation: ${foundCard.card.name} is a Land card (requires a nonland card).`
					};
				}
			} else if (
				info.cardTypeFilter !== 'InstantOrSorcery' &&
				!gType.includes(info.cardTypeFilter)
			) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${foundCard.card.name} is not a ${info.cardTypeFilter} card.`
				};
			}
		}
		return { ok: true };
	}

	// 3. Player target validation
	if (targetKind === 'player' && target.kind !== 'player') {
		return { ok: false, error: 'Strict Rules Violation: This spell or ability must target a player.' };
	}

	if (target.kind === 'player') {
		if (targetKind !== 'player' && targetKind !== 'any' && targetKind !== 'none') {
			return {
				ok: false,
				error: `Strict Rules Violation: Requires a target ${targetKind.replace(/_/g, ' ')}, not a player.`
			};
		}
		const p = state.players.find((pl) => pl.playerId === target.id && !pl.lost);
		if (!p) return { ok: false, error: 'Target player is not valid.' };
		if (info.controllerFilter === 'opponent' && p.playerId === actorId) {
			return {
				ok: false,
				error: 'Strict Rules Violation: Must target an opponent.'
			};
		}
		if (info.controllerFilter === 'you' && p.playerId !== actorId) {
			return {
				ok: false,
				error: 'Strict Rules Violation: Must target yourself.'
			};
		}
		if (playerHasShroud(state, p)) {
			return {
				ok: false,
				error: `Strict Rules Violation: ${p.username} has Shroud / Protection and cannot be targeted.`
			};
		}
		if (playerHasHexproofFrom(state, p, actorId)) {
			return {
				ok: false,
				error: `Strict Rules Violation: ${p.username} has Hexproof and cannot be targeted by opponents.`
			};
		}
		return { ok: true };
	}

	// 4. Battlefield permanent target validation
	const found = findPermanentOnBoard(state, target.id);
	if (!found) {
		return { ok: false, error: 'Target permanent is not on the battlefield (or is phased out).' };
	}

	if (hasKeyword(found.inst, 'Shroud', state)) {
		return {
			ok: false,
			error: `Strict Rules Violation: ${found.inst.card.name} has Shroud and cannot be the target of spells or abilities.`
		};
	}
	if (found.controller.playerId !== actorId && hasKeyword(found.inst, 'Hexproof', state)) {
		return {
			ok: false,
			error: `Strict Rules Violation: ${found.inst.card.name} has Hexproof and cannot be targeted by opponents.`
		};
	}
	if (hasProtectionFrom(found.inst, sourceCard, state)) {
		return {
			ok: false,
			error: `Strict Rules Violation: ${found.inst.card.name} has Protection from ${sourceCard?.name || 'this source'} and cannot be targeted.`
		};
	}

	if (info.controllerFilter === 'you' && found.controller.playerId !== actorId) {
		return {
			ok: false,
			error: `Strict Rules Violation: You must target a permanent you control.`
		};
	}
	if (info.controllerFilter === 'opponent' && found.controller.playerId === actorId) {
		return {
			ok: false,
			error: `Strict Rules Violation: You must target a permanent an opponent controls.`
		};
	}

	const tLine = evaluatePermanent(state, found.inst).typeLine;
	if (targetKind === 'creature' && !tLine.includes('Creature')) {
		return {
			ok: false,
			error: `Strict Rules Violation: ${found.inst.card.name} is not a Creature.`
		};
	}
	if (targetKind === 'controlled_creature') {
		if (!tLine.includes('Creature')) {
			return {
				ok: false,
				error: `Strict Rules Violation: ${found.inst.card.name} is not a Creature.`
			};
		}
		if (found.controller.playerId !== actorId) {
			return {
				ok: false,
				error: `Strict Rules Violation: You must target a creature you control.`
			};
		}
	}
	if (
		targetKind === 'artifact_or_enchantment' &&
		!tLine.includes('Artifact') &&
		!tLine.includes('Enchantment')
	) {
		return {
			ok: false,
			error: `Strict Rules Violation: ${found.inst.card.name} is not an Artifact or Enchantment.`
		};
	}
	if (targetKind === 'nonland_permanent' && tLine.includes('Land')) {
		return {
			ok: false,
			error: `Strict Rules Violation: ${found.inst.card.name} is a Land (requires a nonland permanent).`
		};
	}

	if (info.cardTypeFilter && !matchesPermanentTypeFilter(found.inst, info.cardTypeFilter, state)) {
		return {
			ok: false,
			error: `Strict Rules Violation: ${found.inst.card.name} does not match required type (${info.cardTypeFilter}).`
		};
	}

	if (info.targetSpecs && info.targetSpecs.length > 0) {
		const objectSpecs = info.targetSpecs.filter(
			(ts) => ts.kind === 'object' || ts.kind === 'objectOrPlayer'
		);
		if (objectSpecs.length > 0) {
			const sourceInst = sourceInstanceId
				? findPermanentOnBoard(state, sourceInstanceId)?.inst
				: undefined;
			const fctx: FilterContext = {
				state,
				controllerId: actorId,
				source: sourceInst
			};
			if (!objectSpecs.some((ts) => matchesObjectFilter(found.inst, ts.filter, fctx))) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${found.inst.card.name} is not a legal target.`
				};
			}
		}
	}

	return { ok: true };
}

export function validateChosenTargets(
	state: GameState,
	actorId: string,
	targets: TargetRef[],
	info: TargetRequirementInfo,
	sourceCard?: ScryfallCard,
	sourceInstanceId?: string,
	xValue = 0,
	castMode?: 'normal' | 'overload'
): { ok: boolean; error?: string } {
	if (isOverloadCastMode(sourceCard, xValue, castMode)) {
		return { ok: true };
	}

	if (info.isModal && info.modalBranches && info.modalBranches.length > 0) {
		let lastErr = 'No modal branch matched the chosen target(s).';
		for (const branch of info.modalBranches) {
			const res = validateChosenTargets(
				state,
				actorId,
				targets,
				branch,
				sourceCard,
				sourceInstanceId,
				xValue,
				castMode
			);
			if (res.ok) return { ok: true };
			if (res.error) lastErr = res.error;
		}
		return { ok: false, error: lastErr };
	}

	if (!info.requiresTarget && targets.length === 0) {
		return { ok: true };
	}

	if (targets.length < info.minTargets) {
		return {
			ok: false,
			error: `${sourceCard?.name || 'Spell or ability'} requires ${info.minTargets === info.maxTargets ? `exactly ${info.minTargets}` : `at least ${info.minTargets}`} legal target(s).`
		};
	}
	if (info.maxTargets > 0 && targets.length > info.maxTargets) {
		return {
			ok: false,
			error: `${sourceCard?.name || 'Spell or ability'} allows at most ${info.maxTargets} target(s).`
		};
	}

	const uniqueIds = new Set(targets.map((t) => `${t.kind}:${t.id}`));
	if (uniqueIds.size !== targets.length) {
		return {
			ok: false,
			error: 'Strict Rules Violation: The same object cannot be chosen multiple times for the same target requirement (CR 115.3).'
		};
	}

	for (const t of targets) {
		const res = validateTargetLegality(state, actorId, t, info, sourceCard, sourceInstanceId);
		if (!res.ok) return res;
	}

	// Enforce single-graveyard multi-target restriction ("target two cards in a graveyard")
	if (info.zone === 'graveyard' && info.sameGraveyard && targets.length > 1) {
		const graveyardOwnerIds = new Set<string>();
		for (const t of targets) {
			const owner = state.players.find((p) => p.graveyard.some((c) => c.instanceId === t.id));
			if (owner) {
				graveyardOwnerIds.add(owner.playerId);
			}
		}
		if (graveyardOwnerIds.size > 1) {
			return {
				ok: false,
				error: 'Strict Rules Violation: All targeted cards must be in the same single graveyard.'
			};
		}
	}

	return { ok: true };
}

/** Every legal target for `info`. Read-only: one validation for all candidates (Phase 6d). */
export function getAllLegalTargetsForRequirement(
	state: GameState,
	actorId: string,
	info: TargetRequirementInfo,
	sourceCard?: ScryfallCard,
	sourceInstanceId?: string
): TargetRef[] {
	return withStableLayerInputs(state, () =>
		getAllLegalTargetsForRequirementInner(state, actorId, info, sourceCard, sourceInstanceId)
	);
}

function getAllLegalTargetsForRequirementInner(
	state: GameState,
	actorId: string,
	info: TargetRequirementInfo,
	sourceCard?: ScryfallCard,
	sourceInstanceId?: string
): TargetRef[] {
	const results: TargetRef[] = [];

	if (info.zone === 'stack' || info.targetKind === 'spell') {
		for (const item of state.stack) {
			const ref: TargetRef = { kind: 'stack', id: item.id, label: item.title };
			if (validateTargetLegalityInner(state, actorId, ref, info, sourceCard, sourceInstanceId).ok) {
				results.push(ref);
			}
		}
		return results;
	}

	if (info.zone === 'graveyard' || info.targetKind === 'graveyard_card') {
		for (const p of state.players) {
			for (const c of p.graveyard) {
				const ref: TargetRef = { kind: 'graveyard_card', id: c.instanceId, label: c.card.name };
				if (validateTargetLegalityInner(state, actorId, ref, info, sourceCard, sourceInstanceId).ok) {
					results.push(ref);
				}
			}
		}
		return results;
	}

	if (info.targetKind === 'player' || info.targetKind === 'any') {
		for (const p of state.players) {
			if (p.lost) continue;
			const ref: TargetRef = { kind: 'player', id: p.playerId, label: p.username };
			if (validateTargetLegalityInner(state, actorId, ref, info, sourceCard, sourceInstanceId).ok) {
				results.push(ref);
			}
		}
	}

	if (info.targetKind !== 'player') {
		for (const p of state.players) {
			if (p.lost) continue;
			for (const perm of p.battlefield) {
				if (perm.phasedOut) continue;
				const ref: TargetRef = { kind: 'permanent', id: perm.instanceId, label: perm.card.name };
				if (validateTargetLegalityInner(state, actorId, ref, info, sourceCard, sourceInstanceId).ok) {
					results.push(ref);
				}
			}
		}
	}

	return results;
}

/** Whether enough legal targets exist for `info`. Read-only, one validation (Phase 6d). */
export function hasRequiredLegalTargets(
	state: GameState,
	actorId: string,
	info: TargetRequirementInfo,
	sourceCard?: ScryfallCard,
	sourceInstanceId?: string,
	xValue = 0,
	castMode?: 'normal' | 'overload'
): { ok: boolean; error?: string } {
	return withStableLayerInputs(state, () =>
		hasRequiredLegalTargetsInner(state, actorId, info, sourceCard, sourceInstanceId, xValue, castMode)
	);
}

function hasRequiredLegalTargetsInner(
	state: GameState,
	actorId: string,
	info: TargetRequirementInfo,
	sourceCard?: ScryfallCard,
	sourceInstanceId?: string,
	xValue = 0,
	castMode?: 'normal' | 'overload'
): { ok: boolean; error?: string } {
	if (!info.requiresTarget || info.minTargets <= 0) {
		return { ok: true };
	}

	if (isOverloadCastMode(sourceCard, xValue, castMode)) {
		return { ok: true };
	}

	if (info.isModal && info.modalBranches && info.modalBranches.length > 0) {
		for (const branch of info.modalBranches) {
			if (
				hasRequiredLegalTargets(state, actorId, branch, sourceCard, sourceInstanceId, xValue, castMode).ok
			) {
				return { ok: true };
			}
		}
		return {
			ok: false,
			error: `Illegal Cast: No mode of ${sourceCard?.name || 'this spell'} has valid legal targets.`
		};
	}

	if (info.zone === 'graveyard' || info.targetKind === 'graveyard_card') {
		if (info.sameGraveyard) {
			for (const p of state.players) {
				if (info.controllerFilter === 'you' && p.playerId !== actorId) continue;
				if (info.controllerFilter === 'opponent' && p.playerId === actorId) continue;
				let validInThisGraveyard = 0;
				for (const c of p.graveyard) {
					const ref: TargetRef = { kind: 'graveyard_card', id: c.instanceId, label: c.card.name };
					if (validateTargetLegality(state, actorId, ref, info, sourceCard, sourceInstanceId).ok) {
						validInThisGraveyard += 1;
					}
				}
				if (validInThisGraveyard >= info.minTargets) {
					return { ok: true };
				}
			}
			return {
				ok: false,
				error: `Illegal Cast: ${sourceCard?.name || 'Spell'} requires at least ${info.minTargets} valid target card(s) in a single graveyard.`
			};
		} else {
			const allGraveTargets = getAllLegalTargetsForRequirement(
				state,
				actorId,
				info,
				sourceCard,
				sourceInstanceId
			);
			if (allGraveTargets.length < info.minTargets) {
				return {
					ok: false,
					error: `Illegal Cast: ${sourceCard?.name || 'Spell'} requires at least ${info.minTargets} valid target card(s) in graveyards.`
				};
			}
			return { ok: true };
		}
	}

	const legalTargets = getAllLegalTargetsForRequirement(
		state,
		actorId,
		info,
		sourceCard,
		sourceInstanceId
	);
	if (legalTargets.length < info.minTargets) {
		if (info.zone === 'stack' || info.targetKind === 'spell') {
			return {
				ok: false,
				error: `Illegal Cast: ${sourceCard?.name || 'Spell'} requires a valid target spell on the Stack.`
			};
		}
		return {
			ok: false,
			error: `Illegal Cast: ${sourceCard?.name || 'Spell'} requires at least ${info.minTargets} valid target(s), and ${legalTargets.length === 0 ? 'none' : `only ${legalTargets.length}`} exist.`
		};
	}

	return { ok: true };
}

/** Whether `actorId` may play the land `inst` now. Read-only, one validation (Phase 6d). */
export function checkLandPlayLegality(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: ZoneType = 'hand'
): { ok: boolean; error?: string } {
	return withStableLayerInputs(state, () => checkLandPlayLegalityInner(state, actorId, inst, fromZone));
}

function checkLandPlayLegalityInner(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: ZoneType = 'hand'
): { ok: boolean; error?: string } {
	if (state.status !== 'active') {
		return { ok: false, error: 'Game is not currently active.' };
	}
	if (state.pendingPrompts.length > 0) {
		return { ok: false, error: 'Resolve the active prompt first.' };
	}
	const actor = state.players.find((p) => p.playerId === actorId);
	if (!actor || actor.lost) {
		return { ok: false, error: 'Player is not active in this game.' };
	}
	if (fromZone === 'exile') {
		if (inst.playableFromExileBy?.playerId !== actorId) {
			return {
				ok: false,
				error: `You do not have permission to play ${inst.card.name} from Exile.`
			};
		}
	} else if (fromZone !== 'hand') {
		return { ok: false, error: 'Lands can only be played from your hand (or from Exile with an active play permission).' };
	}
	if (!inst.card.typeLine.includes('Land')) {
		return { ok: false, error: `${inst.card.name} is not a Land card.` };
	}
	const activePlayer = state.players[state.activePlayerIndex];
	const priorityPlayer = state.players[state.priorityPlayerIndex];
	if (activePlayer?.playerId !== actorId) {
		return { ok: false, error: 'You may only play a land on your own turn.' };
	}
	if (priorityPlayer?.playerId !== actorId) {
		return { ok: false, error: 'You must hold priority to play a land.' };
	}
	if (state.phase !== 'main1' && state.phase !== 'main2') {
		return { ok: false, error: 'Lands can only be played during your Main Phase.' };
	}
	if (state.stack.length > 0) {
		return { ok: false, error: 'You cannot play a land while the Stack is not empty.' };
	}
	let effectiveMaxLands = actor.maxLandsPerTurn;
	for (const perm of actor.battlefield) {
		if (perm.phasedOut || permanentHasLostAllAbilities(perm, state).lost) continue;
		const compiled = compileCard(perm.copiableCard ?? perm.card);
		for (const ab of compiled.faces[0]?.abilities ?? []) {
			if (
				ab.kind === 'static' &&
				ab.static.k === 'ruleModifier' &&
				ab.static.rule === 'extraLandPlays'
			) {
				effectiveMaxLands += Number(ab.static.params?.count ?? 1);
			}
		}
	}
	if (actor.landsPlayedThisTurn >= effectiveMaxLands) {
		return {
			ok: false,
			error: `You have already played your maximum of ${effectiveMaxLands} land(s) this turn.`
		};
	}
	return { ok: true };
}

/**
 * Whether `actorId` may cast `inst` now. Read-only: the whole check (cost, auto-tap simulation,
 * targets) shares one layer-cache validation (Phase 6d).
 */
export function checkSpellCastLegality(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: ZoneType = 'hand',
	xValue = 0,
	castMode?: 'normal' | 'overload'
): { ok: boolean; error?: string } {
	return withStableLayerInputs(state, () =>
		checkSpellCastLegalityInner(state, actorId, inst, fromZone, xValue, castMode)
	);
}

function checkSpellCastLegalityInner(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: ZoneType = 'hand',
	xValue = 0,
	castMode?: 'normal' | 'overload'
): { ok: boolean; error?: string } {
	if (state.status !== 'active') {
		return { ok: false, error: 'Game is not currently active.' };
	}
	if (state.pendingPrompts.length > 0) {
		return { ok: false, error: 'Resolve the active prompt first.' };
	}
	const actor = state.players.find((p) => p.playerId === actorId);
	if (!actor || actor.lost) {
		return { ok: false, error: 'Player is not active in this game.' };
	}
	if (fromZone === 'exile') {
		if (inst.playableFromExileBy?.playerId !== actorId && !inst.castViaSuspend) {
			return {
				ok: false,
				error: `You do not have permission to cast ${inst.card.name} from Exile.`
			};
		}
	} else if (fromZone !== 'hand' && fromZone !== 'command') {
		return { ok: false, error: 'Spells can only be cast from your Hand, Command Zone, or Exile.' };
	}
	if (inst.card.typeLine.includes('Land') && !inst.card.typeLine.includes('Creature')) {
		return { ok: false, error: 'Lands are played using Play Land, not cast as spells.' };
	}

	const activePlayer = state.players[state.activePlayerIndex];
	const priorityPlayer = state.players[state.priorityPlayerIndex];
	if (priorityPlayer?.playerId !== actorId) {
		return { ok: false, error: 'You do not currently hold priority.' };
	}

	// Check global Rule-Modifying Cast Permissions & Restrictions (CR 101.2: "Can't beats Can")
	// Covers Vedalken Orrery, Leyline of Anticipation, Rule of Law, Drannith Magistrate, Grand Abolisher, Teferi
	const globalCastCheck = checkGlobalCastPermissionsAndRestrictions(
		state,
		actorId,
		inst,
		fromZone
	);
	if (!globalCastCheck.ok) {
		return { ok: false, error: globalCastCheck.error };
	}

	const isInstantSpeed =
		inst.card.typeLine.includes('Instant') ||
		hasKeyword(inst, 'Flash', state) ||
		globalCastCheck.grantsFlash;
	if (!isInstantSpeed) {
		if (activePlayer?.playerId !== actorId) {
			return {
				ok: false,
				error: `${inst.card.name} can only be cast on your turn at Sorcery speed.`
			};
		}
		if (state.phase !== 'main1' && state.phase !== 'main2') {
			return {
				ok: false,
				error: `${inst.card.name} can only be cast during your Main Phase (1 or 2).`
			};
		}
		if (state.stack.length > 0) {
			return {
				ok: false,
				error: `${inst.card.name} cannot be cast while spells/abilities are on the Stack.`
			};
		}
	}

	// Check timing restrictions from the IR
	const castRestrictions = spellCastRestrictions(inst.card);
	if (castRestrictions.includes('duringYourTurn') && activePlayer?.playerId !== actorId) {
		return {
			ok: false,
			error: `Illegal Cast: ${inst.card.name} can only be cast during your turn.`
		};
	}
	if (castRestrictions.includes('duringCombat')) {
		const combatPhases: GamePhase[] = [
			'begin_combat',
			'declare_attackers',
			'declare_blockers',
			'first_strike_damage',
			'combat_damage',
			'end_combat'
		];
		if (!combatPhases.includes(state.phase)) {
			return {
				ok: false,
				error: `Illegal Cast: ${inst.card.name} can only be cast during combat.`
			};
		}
	}
	if (castRestrictions.includes('beforeAttackers')) {
		const preAttackerPhases: GamePhase[] = ['upkeep', 'draw', 'main1', 'begin_combat'];
		if (!preAttackerPhases.includes(state.phase)) {
			return {
				ok: false,
				error: `Illegal Cast: ${inst.card.name} can only be cast before attackers are declared.`
			};
		}
	}

	// Check mana payment (cards with no mana cost like Ancestral Vision / Sol Talisman cannot be cast normally from hand)
	if (inst.card.manaCost === '' && !inst.card.typeLine.includes('Land') && fromZone === 'hand') {
		return {
			ok: false,
			error: `${inst.card.name} has no mana cost and cannot be cast normally from hand (use Suspend instead).`
		};
	}
	const costReq = getSpellCostRequirement(actor, inst, state, xValue, castMode);
	if (!canPayOrAutoTap(actor, costReq, state)) {
		return {
			ok: false,
			error: `Insufficient mana to cast ${inst.card.name}.`
		};
	}
	// Phase 4: additional costs from the IR, together with the mana.
	const additional = spellAdditionalCost(inst.card);
	if (
		additional &&
		additional.defs.length > 0 &&
		!canPayCosts(costContext(state, actor, inst, xValue, true, costReq), additional.defs)
	) {
		return {
			ok: false,
			error: `Illegal Cast: you can't pay the additional cost of ${inst.card.name}.`
		};
	}

	// Check target legality (including multi-target & single-graveyard constraints)
	const spellTargetInfo = getSpellTargetRequirement(inst.card);
	const targetCheck = hasRequiredLegalTargets(
		state,
		actorId,
		spellTargetInfo,
		inst.card,
		inst.instanceId,
		xValue,
		castMode
	);
	if (!targetCheck.ok) {
		return targetCheck;
	}

	return { ok: true };
}

/** Whether `actorId` may activate `ab` of `perm` now. Read-only, one validation (Phase 6d). */
export function checkAbilityActivationLegality(
	state: GameState,
	actorId: string,
	perm: CardInstance,
	ab: EffectiveActivatedAbility
): { ok: boolean; error?: string } {
	return withStableLayerInputs(state, () => checkAbilityActivationLegalityInner(state, actorId, perm, ab));
}

function checkAbilityActivationLegalityInner(
	state: GameState,
	actorId: string,
	perm: CardInstance,
	ab: EffectiveActivatedAbility
): { ok: boolean; error?: string } {
	if (state.status !== 'active') {
		return { ok: false, error: 'Game is not currently active.' };
	}
	if (state.pendingPrompts.length > 0) {
		return { ok: false, error: 'Resolve the active prompt first.' };
	}
	if (perm.phasedOut) {
		return { ok: false, error: `${perm.card.name} is phased out.` };
	}
	const actor = state.players.find((p) => p.playerId === actorId);
	if (!actor || actor.lost) {
		return { ok: false, error: 'Player is not active in this game.' };
	}

	const abilityLoss = permanentHasLostAllAbilities(perm, state);
	if (abilityLoss.lost) {
		return {
			ok: false,
			error: `${perm.card.name} has lost all abilities (${abilityLoss.sources[0] || 'continuous effect'}).`
		};
	}

	// Phase 4: the whole cost from the IR ({T}/{Q} with summoning sickness, sacrifices, discards,
	// "tap N untapped ...", life, counters and mana), checked by runtime/costs.ts.
	const abilityMana = effectiveAbilityManaCost(state, actorId, ab.id, ab.manaCost).requirement;
	const abilityCost = activatedAbilityCost(perm.card, ab);
	const costCtx = costContext(state, actor, perm, 0, false, abilityMana);
	const checkCost = (): { ok: boolean; error?: string } => {
		if (canPayCosts(costCtx, abilityCost.defs)) return { ok: true };
		const plan = planCosts(costCtx, abilityCost.defs);
		return { ok: false, error: plan.ok ? `You can't pay the cost of ${perm.card.name}'s ability.` : plan.error };
	};

	if (ab.isManaAbility) {
		return checkCost();
	}

	const activePlayer = state.players[state.activePlayerIndex];
	const priorityPlayer = state.players[state.priorityPlayerIndex];
	if (priorityPlayer?.playerId !== actorId) {
		return { ok: false, error: 'You must hold priority to activate this ability.' };
	}

	// Check "Activate only during your turn" (e.g., Sundial of the Infinite)
	if (/activate only during your turn/i.test(ab.effectText)) {
		if (activePlayer?.playerId !== actorId) {
			return {
				ok: false,
				error: `${perm.card.name}: This ability can only be activated during your turn.`
			};
		}
	}

	if (ab.sorcerySpeedOnly) {
		if (
			activePlayer?.playerId !== actorId ||
			(state.phase !== 'main1' && state.phase !== 'main2') ||
			state.stack.length > 0
		) {
			return {
				ok: false,
				error: `${perm.card.name}: This ability can only be activated at Sorcery speed (during your Main Phase while the Stack is empty).`
			};
		}
	}

	if (ab.loyaltyCost !== null) {
		if (
			activePlayer?.playerId !== actorId ||
			(state.phase !== 'main1' && state.phase !== 'main2') ||
			state.stack.length > 0
		) {
			return {
				ok: false,
				error: 'Loyalty abilities can only be activated at Sorcery speed.'
			};
		}
		if (perm.usedLoyaltyThisTurn) {
			return {
				ok: false,
				error: 'This Planeswalker has already activated a loyalty ability this turn.'
			};
		}
	}

	const costCheck = checkCost();
	if (!costCheck.ok) return costCheck;

	if (ab.requiresTarget) {
		const abTargetInfo: TargetRequirementInfo = ab.targetInfo;

		const targetCheck = hasRequiredLegalTargets(
			state,
			actorId,
			abTargetInfo,
			perm.card,
			perm.instanceId,
			0
		);
		if (!targetCheck.ok) {
			return targetCheck;
		}
	}

	return { ok: true };
}

function captureTargetObjectVersions(
	state: GameState,
	targets: TargetRef[]
): Record<string, number> | undefined {
	if (targets.length === 0) return undefined;
	const versions: Record<string, number> = {};
	for (const t of targets) {
		if (t.kind === 'permanent') {
			const found = findPermanentOnBoard(state, t.id);
			if (found) versions[t.id] = found.inst.objectVersion ?? 1;
		} else if (t.kind === 'graveyard_card' || t.kind === 'card_in_graveyard') {
			for (const p of state.players) {
				const found = p.graveyard.find((c) => c.instanceId === t.id);
				if (found) {
					versions[t.id] = found.objectVersion ?? 1;
					break;
				}
			}
		} else if (t.kind === 'stack') {
			const found = state.stack.find((s) => s.id === t.id || s.sourceInstanceId === t.id);
			if (found?.sourceObjectVersion !== undefined) {
				versions[t.id] = found.sourceObjectVersion;
			}
		}
	}
	return Object.keys(versions).length > 0 ? versions : undefined;
}

function isTargetStillValid(
	state: GameState,
	target: TargetRef,
	controllerId?: string,
	sourceCard?: ScryfallCard,
	item?: StackItem
): boolean {
	const expectedVersion = item?.targetObjectVersions?.[target.id];
	if (target.kind === 'player') {
		const p = state.players.find((pl) => pl.playerId === target.id && !pl.lost);
		if (!p) return false;
		if (playerHasShroud(state, p)) return false;
		if (controllerId && playerHasHexproofFrom(state, p, controllerId)) return false;
		return true;
	}
	if (target.kind === 'stack') {
		const stk = state.stack.find((s) => s.id === target.id || s.sourceInstanceId === target.id);
		if (!stk) return false;
		if (
			expectedVersion !== undefined &&
			stk.sourceObjectVersion !== undefined &&
			stk.sourceObjectVersion !== expectedVersion
		) {
			return false;
		}
		return true;
	}
	if (target.kind === 'graveyard_card' || target.kind === 'card_in_graveyard') {
		let foundCard: CardInstance | undefined;
		for (const p of state.players) {
			const c = p.graveyard.find((x) => x.instanceId === target.id);
			if (c) {
				foundCard = c;
				break;
			}
		}
		if (!foundCard) return false;
		if (expectedVersion !== undefined && foundCard.objectVersion !== expectedVersion) {
			return false;
		}
		return true;
	}
	const found = findPermanentOnBoard(state, target.id);
	if (!found) return false;
	if (expectedVersion !== undefined && found.inst.objectVersion !== expectedVersion) {
		return false;
	}
	if (hasKeyword(found.inst, 'Shroud', state)) return false;
	if (
		controllerId &&
		found.controller.playerId !== controllerId &&
		hasKeyword(found.inst, 'Hexproof', state)
	) {
		return false;
	}
	if (hasProtectionFrom(found.inst, sourceCard, state)) {
		return false;
	}
	// A triggered ability with compiled target specs is checked against them instead (resolveTopOfStack).
	if (item && !(item.kind === 'triggered' && triggerItemTargetSpecs(item).length > 0)) {
		let targetInfo: TargetRequirementInfo | undefined;
		if (item.kind === 'spell' && (sourceCard || item.card)) {
			targetInfo = getSpellTargetRequirement((sourceCard ?? item.card)!);
		} else if (item.kind === 'activated' && item.abilityId && (sourceCard || item.card)) {
			const ab = getCardActivatedAbilities((sourceCard ?? item.card)!).find(
				(a) => a.id === item.abilityId
			);
			targetInfo = ab?.targetInfo;
		} else {
			const comp = compiledStackItemEffects(item);
			if (comp) targetInfo = targetRequirementFromSpecs(comp.targets);
		}
		if (targetInfo && targetInfo.requiresTarget) {
			if (targetInfo.isModal && targetInfo.modalBranches && targetInfo.modalBranches.length > 0) {
				const anyBranchValid = targetInfo.modalBranches.some(
					(b) =>
						validateTargetLegality(
							state,
							controllerId || item.controllerId,
							target,
							b,
							sourceCard,
							item.sourceInstanceId
						).ok
				);
				if (!anyBranchValid) return false;
			} else if (
				!validateTargetLegality(
					state,
					controllerId || item.controllerId,
					target,
					targetInfo,
					sourceCard,
					item.sourceInstanceId
				).ok
			) {
				return false;
			}
		}
		const compiled = compiledStackItemEffects(item);
		if (compiled && compiled.targets.length > 0) {
			const objectSpecs = compiled.targets.filter(
				(ts) => ts.kind === 'object' || ts.kind === 'objectOrPlayer'
			);
			if (objectSpecs.length > 0) {
				const sourceInst = findPermanentOnBoard(state, item.sourceInstanceId)?.inst;
				const fctx: FilterContext = {
					state,
					controllerId: controllerId || item.controllerId,
					source: sourceInst,
					xValue: item.xValue
				};
				const matchesAnySpec = objectSpecs.some((ts) =>
					matchesObjectFilter(found.inst, ts.filter, fctx)
				);
				if (!matchesAnySpec) return false;
			}
		}
	}
	return true;
}

function applyDamageToTarget(
	state: GameState,
	sourcePlayerId: string,
	target: TargetRef,
	amount: number
): void {
	const pTarget = state.players.find((p) => p.playerId === target.id);
	if (pTarget) {
		if (!pTarget.lifeTotalCannotChangeThisTurn && !pTarget.protectionFromEverythingThisTurn) {
			pTarget.life -= amount;
		}
		if (!pTarget.protectionFromEverythingThisTurn) {
			emitEvent(state, {
				kind: 'DamageDealt',
				sourceId: sourcePlayerId,
				targetId: pTarget.playerId,
				targetKind: 'player',
				amount,
				combat: false
			});
		}
		emitVfx(state, {
			kind: 'damage',
			sourceId: sourcePlayerId,
			targetId: pTarget.playerId,
			amount
		});
		return;
	}
	const permFound = findPermanentOnBoard(state, target.id);
	if (permFound) {
		if (evaluatePermanent(state, permFound.inst).typeLine.includes('Planeswalker')) {
			permFound.inst.counters.loyalty = Math.max(0, permFound.inst.counters.loyalty - amount);
		} else {
			permFound.inst.damageMarked += amount;
		}
		emitEvent(state, {
			kind: 'DamageDealt',
			sourceId: sourcePlayerId,
			targetId: permFound.inst.instanceId,
			targetKind: 'permanent',
			amount,
			combat: false
		});
		emitVfx(state, {
			kind: 'damage',
			sourceId: sourcePlayerId,
			targetId: permFound.inst.instanceId,
			amount
		});
	}
}

export function sanitizeGameStateForViewer(state: GameState, viewerId: string | null): GameState {
	const clone: GameState = JSON.parse(JSON.stringify(state));
	for (const p of clone.players) {
		p.handCount = p.hand.length;
		p.libraryCount = p.library.length;
		if (p.playerId !== viewerId) {
			// Hide opponent hand contents
			p.hand = [];
		}
		// Expose full library list if viewer is currently searching this player's library (either their own or an opponent's via Opposition Agent)
		const isSearchingThisLibrary =
			viewerId !== null &&
			clone.pendingPrompts.some(
				(pr) =>
					pr.playerId === viewerId &&
					(effectivePromptPurpose(pr) === 'search_library' ||
						(pr.choice?.kind === 'chooseObjects' && pr.choice.zone === 'library')) &&
					(pr.targetLibraryOwnerId || pr.playerId) === p.playerId
			);
		const scryPrompt =
			p.playerId === viewerId
				? clone.pendingPrompts.find(
						(pr) =>
							pr.playerId === viewerId &&
							(pr.kind === 'scry_choice' || pr.choice?.kind === 'orderObjects')
					)
				: undefined;
		const scryIds =
			scryPrompt?.choice?.kind === 'orderObjects'
				? scryPrompt.choice.objectIds
				: scryPrompt?.candidateInstanceIds;
		if (scryIds) {
			p.library = p.library.filter((c) => scryIds.includes(c.instanceId));
		} else if (!isSearchingThisLibrary) {
			p.library = [];
		}
	}
	return clone;
}

export function getAttachedCardsOnBoard(
	state: GameState,
	hostInstanceId: string
): CardInstance[] {
	const out: CardInstance[] = [];
	for (const p of state.players) {
		for (const c of p.battlefield) {
			if (!c.phasedOut && c.attachedToId === hostInstanceId) {
				out.push(c);
			}
		}
	}
	return out;
}

export function getHostCardOnBoard(
	state: GameState,
	attachedToId: string | null | undefined
): CardInstance | null {
	if (!attachedToId) return null;
	const found = findPermanentOnBoard(state, attachedToId);
	return found ? found.inst : null;
}

export interface CombatAttackerForecast {
	attackerInstanceId: string;
	attackerName: string;
	controllerId: string;
	defenderPlayerId: string;
	defenderName: string;
	defenderPlaneswalkerId: string | null;
	defenderPlaneswalkerName: string | null;
	power: number;
	toughness: number;
	isBlocked: boolean;
	blockerIds: string[];
	blockerNames: string[];
	damageToDefender: number;
	poisonToDefender: number;
	commanderDamageToDefender: number;
	attackerDies: boolean;
}

export interface CombatBlockerForecast {
	blockerInstanceId: string;
	blockerName: string;
	blockingAttackerId: string;
	blockingAttackerName: string;
	blockerDies: boolean;
}

export interface PlayerIncomingForecast {
	playerId: string;
	username: string;
	totalLifeLoss: number;
	projectedLife: number;
	totalPoisonGain: number;
	projectedPoison: number;
	commanderDamageById: Record<string, number>;
	unblockedCount: number;
	blockedCount: number;
	trampleThroughDamage: number;
	isLethal: boolean;
	lethalReason: string | null;
}

export interface PlaneswalkerIncomingForecast {
	instanceId: string;
	name: string;
	controllerId: string;
	loyaltyLoss: number;
	currentLoyalty: number;
	projectedLoyalty: number;
	willDie: boolean;
}

export interface CombatDamageForecast {
	active: boolean;
	attackerSummaries: Record<string, CombatAttackerForecast>;
	blockerSummaries: Record<string, CombatBlockerForecast>;
	playerIncoming: Record<string, PlayerIncomingForecast>;
	planeswalkerIncoming: Record<string, PlaneswalkerIncomingForecast>;
	totalLifeGainByPlayer: Record<string, number>;
}

export function computeCombatDamageForecast(
	state: GameState,
	draftAttackers: Record<string, string | { defenderPlayerId: string; defenderPlaneswalkerId?: string | null }> = {},
	draftBlockers: Record<string, string> = {}
): CombatDamageForecast {
	const attackerSummaries: Record<string, CombatAttackerForecast> = {};
	const blockerSummaries: Record<string, CombatBlockerForecast> = {};
	const playerIncoming: Record<string, PlayerIncomingForecast> = {};
	const planeswalkerIncoming: Record<string, PlaneswalkerIncomingForecast> = {};
	const totalLifeGainByPlayer: Record<string, number> = {};

	for (const p of state.players) {
		playerIncoming[p.playerId] = {
			playerId: p.playerId,
			username: p.username,
			totalLifeLoss: 0,
			projectedLife: p.life,
			totalPoisonGain: 0,
			projectedPoison: p.poison,
			commanderDamageById: { ...p.commanderDamageTaken },
			unblockedCount: 0,
			blockedCount: 0,
			trampleThroughDamage: 0,
			isLethal: false,
			lethalReason: null
		};
		totalLifeGainByPlayer[p.playerId] = 0;
	}

	// Build unified attacker entries from committed state.combat.attackers or draftAttackers
	const rawAttackers: Array<{
		attackerInstanceId: string;
		controllerId: string;
		defenderPlayerId: string;
		defenderPlaneswalkerId: string | null;
		blockerInstanceIds: string[];
		wasBlocked: boolean;
	}> = [];

	if (state.combat.active && state.combat.attackers.length > 0) {
		for (const a of state.combat.attackers) {
			const mergedBlockers = [...a.blockerInstanceIds];
			for (const [blkId, atkId] of Object.entries(draftBlockers)) {
				if (atkId === a.attackerInstanceId && !mergedBlockers.includes(blkId)) {
					mergedBlockers.push(blkId);
				}
			}
			rawAttackers.push({
				attackerInstanceId: a.attackerInstanceId,
				controllerId: a.controllerId,
				defenderPlayerId: a.defenderPlayerId,
				defenderPlaneswalkerId: a.defenderPlaneswalkerId || null,
				blockerInstanceIds: mergedBlockers,
				wasBlocked: Boolean(a.wasBlocked) || mergedBlockers.length > 0
			});
		}
	} else if (state.phase === 'declare_attackers') {
		const activePlayer = state.players[state.activePlayerIndex];
		for (const [atkId, targetSpec] of Object.entries(draftAttackers)) {
			const defPlayerId =
				typeof targetSpec === 'string' ? targetSpec : targetSpec.defenderPlayerId;
			const defWalkerId =
				typeof targetSpec === 'string' ? null : targetSpec.defenderPlaneswalkerId || null;
			rawAttackers.push({
				attackerInstanceId: atkId,
				controllerId: activePlayer?.playerId || '',
				defenderPlayerId: defPlayerId,
				defenderPlaneswalkerId: defWalkerId,
				blockerInstanceIds: [],
				wasBlocked: false
			});
		}
	}

	if (rawAttackers.length === 0) {
		return {
			active: false,
			attackerSummaries,
			blockerSummaries,
			playerIncoming,
			planeswalkerIncoming,
			totalLifeGainByPlayer
		};
	}

	for (const atk of rawAttackers) {
		const atkFound = findPermanentOnBoard(state, atk.attackerInstanceId);
		if (!atkFound) continue;
		const atkCard = atkFound.inst;
		const defPlayer = state.players.find((p) => p.playerId === atk.defenderPlayerId);
		const defWalkerFound = atk.defenderPlaneswalkerId
			? findPermanentOnBoard(state, atk.defenderPlaneswalkerId)
			: null;
		const defWalker = defWalkerFound?.inst || null;

		const atkPower = Math.max(0, getCreaturePower(atkCard, state));
		const atkMaxTough = getCreatureToughness(atkCard, state);
		const atkRemTough = Math.max(0, atkMaxTough - atkCard.damageMarked);
		const atkFirstStrike = hasKeyword(atkCard, 'First strike', state);
		const atkDoubleStrike = hasKeyword(atkCard, 'Double strike', state);
		const atkDeathtouch = hasKeyword(atkCard, 'Deathtouch', state);
		const atkTrample = hasKeyword(atkCard, 'Trample', state);
		const atkInfect = hasKeyword(atkCard, 'Infect', state);
		const atkLifelink = hasKeyword(atkCard, 'Lifelink', state);
		const atkIndestructible = hasKeyword(atkCard, 'Indestructible', state);

		const blockers: CardInstance[] = [];
		for (const bId of atk.blockerInstanceIds) {
			const bFound = findPermanentOnBoard(state, bId);
			if (bFound) blockers.push(bFound.inst);
		}

		const isBlocked = atk.wasBlocked || blockers.length > 0;
		const strikesRemaining = state.combat.damageDealtNormal
			? 0
			: atkDoubleStrike
				? state.combat.damageDealtFirstStrike
					? 1
					: 2
				: state.combat.damageDealtFirstStrike && atkFirstStrike && !atkDoubleStrike
					? 0
					: 1;

		let damageToDefender = 0;
		let poisonToDefender = 0;
		let commanderDamageToDefender = 0;
		let attackerDies = false;

		if (!isBlocked) {
			const rawDmg = atkPower * strikesRemaining;
			if (defWalker) {
				damageToDefender = rawDmg;
				if (!planeswalkerIncoming[defWalker.instanceId]) {
					planeswalkerIncoming[defWalker.instanceId] = {
						instanceId: defWalker.instanceId,
						name: defWalker.card.name,
						controllerId: defWalker.controllerId,
						loyaltyLoss: 0,
						currentLoyalty: defWalker.counters.loyalty,
						projectedLoyalty: defWalker.counters.loyalty,
						willDie: false
					};
				}
				const pw = planeswalkerIncoming[defWalker.instanceId];
				pw.loyaltyLoss += rawDmg;
				pw.projectedLoyalty = Math.max(0, pw.currentLoyalty - pw.loyaltyLoss);
				pw.willDie = pw.projectedLoyalty <= 0;
			} else if (defPlayer) {
				const inc = playerIncoming[defPlayer.playerId];
				inc.unblockedCount += 1;
				if (atkInfect) {
					poisonToDefender = rawDmg;
					inc.totalPoisonGain += rawDmg;
				} else if (!defPlayer.lifeTotalCannotChangeThisTurn) {
					damageToDefender = rawDmg;
					inc.totalLifeLoss += rawDmg;
					if (atkCard.isCommander) {
						commanderDamageToDefender = rawDmg;
						inc.commanderDamageById[atkCard.instanceId] =
							(inc.commanderDamageById[atkCard.instanceId] || 0) + rawDmg;
					}
				}
			}
			if (atkLifelink && rawDmg > 0) {
				totalLifeGainByPlayer[atk.controllerId] =
					(totalLifeGainByPlayer[atk.controllerId] || 0) + rawDmg;
			}
		} else {
			// Blocked attacker (CR 509.1h / 510.1c)
			if (defPlayer && !defWalker) {
				playerIncoming[defPlayer.playerId].blockedCount += 1;
			}
			let totalAtkDmgPool = atkPower * strikesRemaining;
			let totalBlkDmgToAtk = 0;
			let anyBlockerDeathtouch = false;

			for (const blk of blockers) {
				const blkPower = Math.max(0, getCreaturePower(blk, state));
				const blkRemTough = Math.max(0, getCreatureToughness(blk, state) - blk.damageMarked);
				const blkIndestructible = hasKeyword(blk, 'Indestructible', state);
				const blkDeathtouch = hasKeyword(blk, 'Deathtouch', state);
				const blkFirstStrike =
					hasKeyword(blk, 'First strike', state) || hasKeyword(blk, 'Double strike', state);
				const blkDoubleStrike = hasKeyword(blk, 'Double strike', state);
				const blkLifelink = hasKeyword(blk, 'Lifelink', state);

				const lethalNeeded =
					atkDeathtouch && !blkIndestructible ? Math.min(1, blkRemTough) : blkRemTough;
				const assignedToBlk = Math.min(totalAtkDmgPool, Math.max(0, lethalNeeded));
				totalAtkDmgPool -= assignedToBlk;

				const killedInFirstStrike =
					(atkFirstStrike || atkDoubleStrike) &&
					!blkFirstStrike &&
					atkPower >= lethalNeeded &&
					(!blkIndestructible || atkInfect);
				const blkDies =
					assignedToBlk >= lethalNeeded && (!blkIndestructible || atkInfect) && lethalNeeded > 0;

				blockerSummaries[blk.instanceId] = {
					blockerInstanceId: blk.instanceId,
					blockerName: blk.card.name,
					blockingAttackerId: atkCard.instanceId,
					blockingAttackerName: atkCard.card.name,
					blockerDies: blkDies
				};

				if (!killedInFirstStrike) {
					const blkStrikes = blkDoubleStrike ? 2 : 1;
					const dmgDealtByBlk = blkPower * blkStrikes;
					totalBlkDmgToAtk += dmgDealtByBlk;
					if (blkDeathtouch && dmgDealtByBlk > 0) anyBlockerDeathtouch = true;
					if (blkLifelink && dmgDealtByBlk > 0) {
						totalLifeGainByPlayer[blk.controllerId] =
							(totalLifeGainByPlayer[blk.controllerId] || 0) + dmgDealtByBlk;
					}
				}
			}

			attackerDies =
				!atkIndestructible &&
				(totalBlkDmgToAtk >= atkRemTough || (anyBlockerDeathtouch && totalBlkDmgToAtk > 0));

			// Trample excess damage over to defending player / planeswalker!
			if (atkTrample && totalAtkDmgPool > 0) {
				const trampleDmg = totalAtkDmgPool;
				if (defWalker) {
					damageToDefender = trampleDmg;
					if (!planeswalkerIncoming[defWalker.instanceId]) {
						planeswalkerIncoming[defWalker.instanceId] = {
							instanceId: defWalker.instanceId,
							name: defWalker.card.name,
							controllerId: defWalker.controllerId,
							loyaltyLoss: 0,
							currentLoyalty: defWalker.counters.loyalty,
							projectedLoyalty: defWalker.counters.loyalty,
							willDie: false
						};
					}
					const pw = planeswalkerIncoming[defWalker.instanceId];
					pw.loyaltyLoss += trampleDmg;
					pw.projectedLoyalty = Math.max(0, pw.currentLoyalty - pw.loyaltyLoss);
					pw.willDie = pw.projectedLoyalty <= 0;
				} else if (defPlayer) {
					const inc = playerIncoming[defPlayer.playerId];
					inc.trampleThroughDamage += trampleDmg;
					if (atkInfect) {
						poisonToDefender = trampleDmg;
						inc.totalPoisonGain += trampleDmg;
					} else if (!defPlayer.lifeTotalCannotChangeThisTurn) {
						damageToDefender = trampleDmg;
						inc.totalLifeLoss += trampleDmg;
						if (atkCard.isCommander) {
							commanderDamageToDefender = trampleDmg;
							inc.commanderDamageById[atkCard.instanceId] =
								(inc.commanderDamageById[atkCard.instanceId] || 0) + trampleDmg;
						}
					}
				}
			}

			if (atkLifelink && atkPower * strikesRemaining > 0 && blockers.length > 0) {
				totalLifeGainByPlayer[atk.controllerId] =
					(totalLifeGainByPlayer[atk.controllerId] || 0) + atkPower * strikesRemaining;
			}
		}

		attackerSummaries[atkCard.instanceId] = {
			attackerInstanceId: atkCard.instanceId,
			attackerName: atkCard.card.name,
			controllerId: atk.controllerId,
			defenderPlayerId: atk.defenderPlayerId,
			defenderName: defPlayer?.username || 'Opponent',
			defenderPlaneswalkerId: defWalker?.instanceId || null,
			defenderPlaneswalkerName: defWalker?.card.name || null,
			power: atkPower,
			toughness: atkRemTough,
			isBlocked,
			blockerIds: blockers.map((b) => b.instanceId),
			blockerNames: blockers.map((b) => b.card.name),
			damageToDefender,
			poisonToDefender,
			commanderDamageToDefender,
			attackerDies
		};
	}

	// Finalize player projections & lethal checks
	for (const p of state.players) {
		const inc = playerIncoming[p.playerId];
		const netGain = totalLifeGainByPlayer[p.playerId] || 0;
		inc.projectedLife = p.life - inc.totalLifeLoss + netGain;
		inc.projectedPoison = p.poison + inc.totalPoisonGain;

		const cmdLethalThreshold = state.rules.commanderDamageLethal || 21;
		const lethalCmdEntry = Object.entries(inc.commanderDamageById).find(
			([, dmg]) => cmdLethalThreshold > 0 && dmg >= cmdLethalThreshold
		);

		if (inc.projectedPoison >= 10) {
			inc.isLethal = true;
			inc.lethalReason = `${inc.projectedPoison} Poison (Lethal at 10)`;
		} else if (lethalCmdEntry) {
			inc.isLethal = true;
			inc.lethalReason = `${lethalCmdEntry[1]} Commander Damage (Lethal at ${cmdLethalThreshold})`;
		} else if (inc.projectedLife <= 0 && inc.totalLifeLoss > 0) {
			inc.isLethal = true;
			inc.lethalReason = `Life drops to ${inc.projectedLife}`;
		}
	}

	return {
		active: true,
		attackerSummaries,
		blockerSummaries,
		playerIncoming,
		planeswalkerIncoming,
		totalLifeGainByPlayer
	};
}
