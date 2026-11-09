import {
	createEmptyManaPool,
	canPayManaCost,
	cardEntersTapped,
	cardHasPrintedUnblockable,
	deductManaFromPool,
	describeLibrarySearchDestination,
	detectTargetRequirement,
	getPermanentManaProduction,
	matchesLibrarySearchSpec,
	parseActivatedAbilities,
	parseAdditionalCostsAndRestrictions,
	parseDelayedTriggersFromSpell,
	parseLibrarySearchSpec,
	parseManaCost,
	parseSpellOrAbilityEffects,
	parseSuspendClause,
	type ManaCostRequirement,
	type ParsedActivatedAbility
} from './oracle.ts';
import {
	checkGlobalCastPermissionsAndRestrictions,
	checkGraveyardReplacementZone,
	collectActiveBoardHooks,
	evaluateActionNode,
	evaluatePermanent,
	getCardRuleTree,
	getEffectiveActivatedAbilities as getEffectiveActivatedAbilitiesRaw,
	getLibrarySearchInterceptor,
	inspectCardContinuousBreakdown,
	permanentHasLostAllAbilities,
	playerCannotLoseGame,
	playerCannotWinGame,
	type ActiveBoardHook,
	type ActionRuleNode,
	type AttributedKeywordOrEffect,
	type BoardModifierHookNode,
	type CardContinuousBreakdown,
	type CardRuleTree,
	type EvaluatedActionNode,
	type EvaluatedPermanent,
	type RulePath,
	type TriggerRuleNode
} from './ruleTree.ts';

export {
	checkGlobalCastPermissionsAndRestrictions,
	checkGraveyardReplacementZone,
	collectActiveBoardHooks,
	evaluateActionNode,
	evaluatePermanent,
	getCardRuleTree,
	getLibrarySearchInterceptor,
	inspectCardContinuousBreakdown,
	matchesLibrarySearchSpec,
	parseLibrarySearchSpec,
	permanentHasLostAllAbilities,
	playerCannotLoseGame,
	playerCannotWinGame,
	parseSuspendClause,
	type ActiveBoardHook,
	type ActionRuleNode,
	type AttributedKeywordOrEffect,
	type BoardModifierHookNode,
	type CardContinuousBreakdown,
	type CardRuleTree,
	type EvaluatedActionNode,
	type EvaluatedPermanent,
	type RulePath,
	type TriggerRuleNode
};

export function getEffectiveActivatedAbilities(
	state: GameState,
	actor: PlayerGameState,
	perm: CardInstance,
	commanderIdentity: ManaColor[] = ['W', 'U', 'B', 'R', 'G']
): ParsedActivatedAbility[] {
	return getEffectiveActivatedAbilitiesRaw(state, actor, perm, commanderIdentity).map((ab) =>
		ab.id.startsWith('equip_') && ab.manaCost === '{0}' && !ab.costText.includes('{0}')
			? { ...ab, costText: 'Equip {0}' }
			: ab
	);
}
import { STAPLE_CARDS } from './precons.ts';
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
	effectiveSpellManaCost,
	keywordCost,
	manaAbilityAmount,
	payPlannedCosts,
	planCosts,
	spellAdditionalCost,
	type CostContext,
	type CostQuestion
} from './runtime/costs.ts';
import { evaluateAmount } from './runtime/objectFilter.ts';
import {
	flushTriggers,
	matchTriggers,
	registerTriggerHost,
	stackTriggerConditionHolds,
	type PendingTrigger
} from './runtime/triggers.ts';

export { allocateTimestamp, shuffleArray };
import {
	PHASE_LABELS,
	type CardInstance,
	type CostPayment,
	type CounterType,
	type DelayedTrigger,
	type GameActionPayload,
	type GameLogEntry,
	type GamePhase,
	type GameState,
	type LibrarySearchDestination,
	type LibrarySearchSpec,
	type LobbyRulesConfig,
	type LobbySeat,
	type MagicDeck,
	type ManaColor,
	type ManaPool,
	type ParsedEffect,
	type PlayerGameState,
	type ScryfallCard,
	type StackItem,
	type TargetKind,
	type TargetRef,
	type TargetRequirementInfo,
	type VfxEvent,
	type ZoneType
} from './types.ts';

function uid(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

let globalInstanceTimestampSeed = 1;

export function createCardInstance(
	card: ScryfallCard,
	ownerId: string,
	zone: ZoneType,
	isCommander = false,
	isToken = false,
	enteredTimestamp?: number
): CardInstance {
	const counters = createEmptyCounters();
	if (card.loyalty && zone === 'battlefield') {
		counters.loyalty = parseInt(card.loyalty, 10) || 3;
	}
	globalInstanceTimestampSeed += 1;
	return {
		instanceId: uid(isToken ? 'tok' : isCommander ? 'cmd' : 'crd'),
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
		id: uid('log'),
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
		id: uid('vfx'),
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

	const players: PlayerGameState[] = activeSeats.map((seat, idx) => {
		const playerId = seat.userId || `bot_${seat.seatIndex}`;
		const deck = decksBySeat.get(seat.seatIndex)!;

		const command: CardInstance[] = deck.commanders.map((c) =>
			createCardInstance(c, playerId, 'command', true, false)
		);

		const rawLibrary: CardInstance[] = [];
		for (const entry of deck.cards) {
			for (let q = 0; q < entry.quantity; q++) {
				rawLibrary.push(createCardInstance(entry.card, playerId, 'library', false, false));
			}
		}

		const shuffled = shuffleArray(rawLibrary);
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
		gameId: uid('game'),
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
	for (const p of state.players) {
		if (p.isBot) {
			const landCount = p.hand.filter((c) => c.card.typeLine.includes('Land')).length;
			if (landCount < 2 || landCount > 5) {
				// Take 1 free mulligan
				mulliganRedraw(state, p);
			}
			p.hasKeptHand = true;
		} else {
			state.pendingPrompts.push({
				id: uid('prm'),
				playerId: p.playerId,
				kind: 'mulligan',
				title: 'Opening Hand Mulligan',
				description:
					rules.mulliganRule === 'friendly_unlimited'
						? 'Friendly Mulligan: You may keep your 7-card hand or take a free 7-card mulligan.'
						: 'London Mulligan: Your first mulligan in Commander is free (7 cards). Subsequent mulligans put 1 card per extra mulligan on the bottom of your library.'
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
		beginPhase(state, 'untap');
		addLog(state, 'system', `All players kept their opening hands. Turn 1 begins for ${state.players[0].username}!`);
		runBeginningOfTurn(state);
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
	const set = new Set<ManaColor>();
	const allCards = [
		...player.command,
		...player.battlefield.filter((c) => c.isCommander),
		...player.graveyard.filter((c) => c.isCommander),
		...player.exile.filter((c) => c.isCommander),
		...player.hand.filter((c) => c.isCommander)
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
	ab?: ParsedActivatedAbility
): number {
	const evalPerm = evaluatePermanent(state, perm);
	if (evalPerm.losesAllAbilities) return baseAmount;
	const pCard = perm.copiableCard ?? perm.card;
	const fallback = { id: 'mana_tap' } as ParsedActivatedAbility;
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
	state.pendingPrompts.push({
		id: uid('prm'),
		playerId: actor.playerId,
		kind: 'cost_choice',
		title: `Pay the cost of ${sourceName}`,
		description:
			question.kind === 'option'
				? question.optional
					? 'This cost is optional. Pay it?'
					: 'Choose which cost to pay.'
				: `Choose ${question.count}: ${question.label}.`,
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
): ParsedActivatedAbility[] {
	return getEffectiveActivatedAbilities(state, player, perm, cmdIdentity).filter(
		(a) =>
			a.isManaAbility &&
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
	const tapOnly = new Map<string, ParsedActivatedAbility[]>();
	const manaAbilitiesOf = (perm: CardInstance) => {
		let abs = tapOnly.get(perm.instanceId);
		if (!abs) {
			abs = tapOnlyManaAbilities(state, player, perm, cmdIdentity);
			tapOnly.set(perm.instanceId, abs);
		}
		return abs;
	};

	// Sort untapped mana sources: most-constrained (fewest colors) first, and non-creatures before creatures
	const candidates = player.battlefield
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
			const pa = getPermanentManaProduction(a.card, cmdIdentity);
			const pb = getPermanentManaProduction(b.card, cmdIdentity);
			if (pa.colors.length !== pb.colors.length) {
				return pa.colors.length - pb.colors.length;
			}
			const aIsCreature = evaluatePermanent(state, a).isCreature ? 1 : 0;
			const bIsCreature = evaluatePermanent(state, b).isCreature ? 1 : 0;
			return aIsCreature - bIsCreature;
		});

	const tappedSet = new Set<string>();
	const manaChoices = new Map<string, { color: ManaColor; amount: number }>();

	// Pass 1: Satisfy missing colored mana pips using the most-constrained sources first
	for (const col of ['W', 'U', 'B', 'R', 'G', 'C'] as ManaColor[]) {
		while (pool[col] < req.colored[col]) {
			const perm = candidates.find((c) => {
				if (tappedSet.has(c.instanceId)) return false;
				return manaAbilitiesOf(c).some((a) => a.producesMana.includes(col));
			});
			if (!perm) {
				return false;
			}
			const prod = getPermanentManaProduction(perm.card, cmdIdentity);
			const amount = getProducedAmount(perm, prod.amount);
			tappedSet.add(perm.instanceId);
			pool[col] += amount;
			manaChoices.set(perm.instanceId, { color: col, amount });
		}
	}

	// Pass 2: Satisfy remaining generic mana cost using remaining untapped sources
	while (!canPayManaCost(pool, req)) {
		const perm = candidates.find((c) => !tappedSet.has(c.instanceId));
		if (!perm) {
			return false;
		}
		const chosenColor: ManaColor = manaAbilitiesOf(perm)[0]?.producesMana[0] || 'C';
		const prod = getPermanentManaProduction(perm.card, cmdIdentity);
		const amount = getProducedAmount(perm, prod.amount);
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
		player.manaPool = deductManaFromPool(player.manaPool, req);
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

export function drawCards(state: GameState, player: PlayerGameState, count: number): void {
	for (let i = 0; i < count; i++) {
		if (player.library.length === 0) {
			// Check Replacement Effect: Laboratory Maniac ("If you would draw a card while your library has no cards in it, you win the game instead.")
			const hasLabMan = player.battlefield.some(
				(b) =>
					!b.phasedOut &&
					!permanentHasLostAllAbilities(b, state).lost &&
					((b.copiableCard ?? b.card).name === 'Laboratory Maniac' ||
						/if you would draw a card while your library has no cards in it, you win the game instead/i.test(
							(b.copiableCard ?? b.card).oracleText
						))
			);
			if (hasLabMan) {
				winTheGame(state, player, 'Laboratory Maniac (drew from an empty library)');
				return;
			}
			loseTheGame(
				state,
				player,
				'Attempted to draw a card from an empty library (Decked Out).'
			);
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

function runDrawStepAndEnterMain1(state: GameState, activePlayer: PlayerGameState): void {
	beginPhase(state, 'draw');
	const shouldSkipFirstDraw =
		state.turnNumber === 1 && state.players.length === 2 && !state.rules.firstTurnDraw;
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

	if (state.stack.length === 0) {
		beginPhase(state, 'main1');
	}
	state.priorityPlayerIndex = state.activePlayerIndex;
	state.passedPriorityPlayerIds = [];
	state.turnStartedAt = Date.now();
	state.priorityUpdatedAt = Date.now();
	emitVfx(state, {
		kind: 'phase_change',
		label: `Turn ${state.turnNumber}: ${activePlayer.username} — Main Phase 1`
	});
	checkStateBasedActions(state);
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

	// 1. Untap step (CR 502)
	beginPhase(state, 'untap');
	activePlayer.landsPlayedThisTurn = 0;
	activePlayer.maxLandsPerTurn = 1;
	activePlayer.manaPool = createEmptyManaPool();

	// CR 502.1 & CR 702.26: Before untapping, all phased-out permanents controlled by activePlayer phase in simultaneously (without triggering ETB!)
	const phasedInNames: string[] = [];
	for (const perm of activePlayer.battlefield) {
		if (perm.phasedOut) {
			perm.phasedOut = false;
			perm.phasedOutIndirectly = false;
			phasedInNames.push(perm.card.name);
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

	for (const perm of activePlayer.battlefield) {
		if (perm.phasedOut) continue;
		if (perm.counters.stun > 0) {
			perm.counters.stun -= 1;
		} else {
			perm.tapped = false;
		}
		perm.summoningSick = false;
		perm.usedLoyaltyThisTurn = false;
	}

	// 2. Upkeep step (CR 503). Beginning-of-upkeep triggers run from the PhaseBegin handler
	// (runUpkeepTriggers), synchronously, before the stack check below.
	beginPhase(state, 'upkeep', activePlayer);

	// If any upkeep triggers are on the stack, pause in Upkeep so players can respond (CR 503.1)
	if (state.stack.length > 0) {
		state.priorityPlayerIndex = state.activePlayerIndex;
		state.passedPriorityPlayerIds = [];
		state.turnStartedAt = Date.now();
		state.priorityUpdatedAt = Date.now();
		emitVfx(state, {
			kind: 'phase_change',
			label: `Turn ${state.turnNumber}: ${activePlayer.username} — Upkeep`
		});
		checkStateBasedActions(state);
		return;
	}

	// 3. Draw step & enter Precombat Main Phase (main1)
	runDrawStepAndEnterMain1(state, activePlayer);
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
		return applyGameActionInner(state, actorId, action);
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
			const ab = (preferred && manaAbs.find((a) => a.producesMana.includes(preferred))) || manaAbs[0];
			const chosenColor: ManaColor =
				preferred && ab.producesMana.includes(preferred) ? preferred : ab.producesMana[0] || 'C';

			// Phase 4: the ability's whole cost from the IR ({T}, and e.g. "Sacrifice this artifact").
			const cost = activatedAbilityCost(perm.card, ab);
			const ctx = costContext(state, actor, perm, 0, false, parseManaCost(ab.manaCost === '{0}' ? '' : ab.manaCost));
			const plan = planCosts(ctx, cost.defs, action.costPayment);
			if (!plan.ok) return { ok: false, error: plan.error };
			if (plan.question) return askCostChoice(state, actor, action, plan.question, perm.card.name);

			const prod = getPermanentManaProduction(perm.card, cmdId);
			const legacyAmount = ab.id === 'mana_tap' ? prod.amount : ab.producesAmount;
			const baseAmount = evalPerm.losesAllAbilities ? 1 : Math.max(1, legacyAmount);
			const amount = getDynamicManaProducedAmount(state, actor, perm, baseAmount, ab);

			const paid = payPlannedCosts(ctx, plan);
			actor.manaPool[chosenColor] += amount;
			if (paid.descriptions.length > 0 || cost.defs.some((d) => d.k === 'sacrifice' && d.filter === 'self')) {
				addLog(
					state,
					'rule',
					`${actor.username} activated ${perm.card.name} for ${amount > 1 ? `${amount}x ` : ''}{${chosenColor}}${paid.descriptions.length > 0 ? ` (${paid.descriptions.join('; ')})` : ''}.`,
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
			landInst.tapped = cardEntersTapped(landInst.card);
			moveObject(state, landInst, 'battlefield', {
				from: { player: sourcePlayer, zone: sourceZone },
				toPlayer: actor,
				controllerId: actorId,
				newTimestamp: true,
				bumpVersion: true
			});
			actor.landsPlayedThisTurn += 1;

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
			const suspClause = parseSuspendClause(inst.card)!;
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

		case 'obeka_end_turn_choice': {
			return { ok: false, error: 'No active Obeka end-the-turn prompt.' };
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

			const parsed = parseSpellOrAbilityEffects(inst.card);
			const targets = action.targets || [];
			const targetValidation = validateChosenTargets(
				state,
				actorId,
				targets,
				parsed.targetInfo,
				inst.card,
				inst.instanceId,
				xVal,
				castMode
			);
			if (!targetValidation.ok) {
				return targetValidation;
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
			const stackItem: StackItem = {
				id: uid('stk'),
				sourceInstanceId: inst.instanceId,
				sourceObjectVersion: inst.objectVersion,
				card: inst.card,
				ownerId: inst.ownerId,
				controllerId: actorId,
				kind: 'spell',
				title: inst.card.name,
				oracleText: inst.card.oracleText,
				targets,
				xValue: xVal,
				castMode: resolvedCastMode,
				commanderCastCount: inst.commanderCastCount,
				parsedEffects: parsed.effects,
				requiresGuidedResolution: parsed.requiresGuidedResolution,
				createdAt: Date.now()
			};

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
					emitEvent(state, { kind: 'BecameTarget', objectId: t.id, object: targeted.inst, by: 'spell', controllerId: actor.playerId });
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

			const evaluatedNode = evaluateActionNode(state, actorId, perm, ab.id);
			const abTargetInfo: TargetRequirementInfo =
				evaluatedNode?.targetLegality.targetInfo ??
				(ab.targetKind === 'controlled_creature'
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
					: detectTargetRequirement(ab.effectText));

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

			// Phase 4: pay the whole cost from the IR. Mana comes from the evaluated action node (cost
			// modifiers applied); everything else from the ability's CostDefs.
			const abilityCost = activatedAbilityCost(perm.card, ab);
			const abilityMana = evaluatedNode
				? evaluatedNode.effectiveCostRequirement
				: parseManaCost(ab.manaCost === '{0}' ? '' : ab.manaCost);
			const abilityCtx = costContext(state, actor, perm, 0, false, abilityMana);
			const abilityPlan = planCosts(abilityCtx, abilityCost.defs, action.costPayment);
			if (!abilityPlan.ok) return { ok: false, error: abilityPlan.error };
			if (abilityPlan.question) return askCostChoice(state, actor, action, abilityPlan.question, perm.card.name);
			const abilityPaid = payPlannedCosts(abilityCtx, abilityPlan);
			if (abilityPaid.descriptions.length > 0) {
				addLog(state, 'rule', `${actor.username} ${abilityPaid.descriptions.join('; ')} to activate ${perm.card.name}.`, actorId);
			}
			if (!abilityCost.complete) {
				addLog(state, 'rule', `Part of the cost of ${perm.card.name}'s ability isn't automated; pay it manually.`, actorId);
			}

			const parsed = parseSpellOrAbilityEffects(perm.card, ab.effectText);
			const stackItem: StackItem = {
				id: uid('stk'),
				sourceInstanceId: perm.instanceId,
				sourceObjectVersion: perm.objectVersion,
				card: perm.card,
				controllerId: actorId,
				kind: 'activated',
				title: `${perm.card.name} Ability`,
				oracleText: ab.effectText,
				targets,
				xValue: 0,
				parsedEffects: parsed.effects,
				requiresGuidedResolution: false,
				createdAt: Date.now()
			};

			state.stack.push(stackItem);
			state.passedPriorityPlayerIds = [];
			addLog(state, 'cast', `${actor.username} activated ${perm.card.name}: "${ab.effectText}".`, actorId);
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

			const validAttackers = [];
			let totalPropagandaTaxGeneric = 0;

			for (const assign of action.assignments) {
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

				const defender = state.players.find(
					(p) => p.playerId === assign.defenderPlayerId && !p.lost
				);
				if (!defender || defender.playerId === actorId) {
					return { ok: false, error: 'Invalid defending player.' };
				}

				// Check Propaganda / Ghostly Prison tax on defending player (CR 508.1d)
				if (!assign.defenderPlaneswalkerId) {
					for (const defPerm of defender.battlefield) {
						if (defPerm.phasedOut || permanentHasLostAllAbilities(defPerm, state).lost) continue;
						const defCard = defPerm.copiableCard ?? defPerm.card;
						if (
							defCard.name === 'Propaganda' ||
							defCard.name === 'Ghostly Prison' ||
							/creatures can't attack you unless their controller pays \{2\} for each creature/i.test(
								defCard.oracleText
							)
						) {
							totalPropagandaTaxGeneric += 2;
						}
					}
				}
			}

			// Enforce Goad / Attack requirements (CR 508.1d: must satisfy as many requirements as possible without violating restrictions)
			const assignedIds = new Set(action.assignments.map((a) => a.attackerInstanceId));
			for (const perm of actor.battlefield) {
				if (perm.phasedOut || !evaluatePermanent(state, perm).isCreature) continue;
				if (perm.goadedByPlayerIds && perm.goadedByPlayerIds.length > 0) {
					const canAttack =
						!perm.tapped &&
						(!perm.summoningSick || hasKeyword(perm, 'Haste', state)) &&
						!hasKeyword(perm, 'Defender', state);
					if (canAttack && !assignedIds.has(perm.instanceId)) {
						return {
							ok: false,
							error: `Strict Rules Violation: ${perm.card.name} is Goaded and must attack this combat if able.`
						};
					}
				}
			}

			// Pay Propaganda / Ghostly Prison tax if applicable
			if (totalPropagandaTaxGeneric > 0) {
				const taxReq = parseManaCost(`{${totalPropagandaTaxGeneric}}`);
				if (!payManaWithAutoTap(actor, taxReq, state)) {
					return {
						ok: false,
						error: `Strict Rules Violation: Attacking requires paying {${totalPropagandaTaxGeneric}} for Propaganda / Ghostly Prison, and you have insufficient mana.`
					};
				}
			}

			for (const assign of action.assignments) {
				const creature = actor.battlefield.find(
					(c) => c.instanceId === assign.attackerInstanceId
				)!;
				const defender = state.players.find(
					(p) => p.playerId === assign.defenderPlayerId && !p.lost
				)!;
				if (!hasKeyword(creature, 'Vigilance', state)) {
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

			state.combat.active = validAttackers.length > 0;
			state.combat.attackers = validAttackers;
			state.combat.declaredBlockersPlayerIds = [];
			state.combat.damageDealtFirstStrike = false;
			state.combat.damageDealtNormal = false;

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
				// Attack triggers ran here before Phase 5.
				flushTriggers(state);
				// Advance into declare_blockers step and give priority to defending player(s) in turn order
				beginPhase(state, 'declare_blockers');
				const defendersInOrder = getAttackedDefenderIdsInTurnOrder(state);
				const firstDefenderId = defendersInOrder[0] || validAttackers[0].defenderPlayerId;
				const defIdx = state.players.findIndex((p) => p.playerId === firstDefenderId);
				state.priorityPlayerIndex = defIdx >= 0 ? defIdx : state.activePlayerIndex;
				state.passedPriorityPlayerIds = [];
			} else {
				// No attackers declared -> skip straight to Postcombat Main Phase (main2)
				addLog(state, 'combat', `${actor.username} declared no attackers. Moving to Main Phase 2.`, actorId);
				state.combat.active = false;
				beginPhase(state, 'main2');
				state.priorityPlayerIndex = state.activePlayerIndex;
				state.passedPriorityPlayerIds = [];
			}
			state.priorityUpdatedAt = Date.now();
			return { ok: true };
		}

		case 'declare_blockers': {
			if (state.phase !== 'declare_blockers') {
				return { ok: false, error: 'Blockers can only be declared during the Declare Blockers step.' };
			}

			// Validate each blocker assignment (including Flying, Reach, Menace!)
			const blockerCountsByAttacker = new Map<string, string[]>();
			for (const assign of action.assignments) {
				const blocker = actor.battlefield.find(
					(c) => c.instanceId === assign.blockerInstanceId
				);
				if (!blocker || blocker.phasedOut || !evaluatePermanent(state, blocker).isCreature) {
					return { ok: false, error: 'Invalid blocking creature.' };
				}
				if (blocker.tapped) {
					return { ok: false, error: `${blocker.card.name} is tapped and cannot block.` };
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
					if (
						!permanentHasLostAllAbilities(atkCard, state).lost &&
						cardHasPrintedUnblockable(atkCard.card)
					) {
						return {
							ok: false,
							error: `Strict Rules Violation: ${atkCard.card.name} cannot be blocked.`
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

			// If in declare_attackers with empty stack and active player passes without attacking, treat as 0 attackers
			if (state.phase === 'declare_attackers' && state.stack.length === 0 && !state.combat.active) {
				beginPhase(state, 'main2');
				state.priorityPlayerIndex = state.activePlayerIndex;
				state.passedPriorityPlayerIds = [];
				addLog(state, 'combat', `${actor.username} skipped combat and moved to Main Phase 2.`, actorId);
				return { ok: true };
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
				enterEndStep(state, activePlayer);
			} else if (state.stack.length === 0) {
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
	if (action.type === 'mulligan_keep') {
		if (prIdx >= 0) state.pendingPrompts.splice(prIdx, 1);
		const freeMulligans =
			state.rules.mulliganRule === 'friendly_unlimited'
				? 99
				: state.rules.mulliganRule === 'london_1free'
					? 1
					: 0;
		const cardsToBottom = Math.max(0, actor.mulliganCount - freeMulligans);

		if (cardsToBottom > 0 && actor.hand.length > 0) {
			const countReq = Math.min(cardsToBottom, actor.hand.length);
			state.pendingPrompts.push({
				id: uid('prm'),
				playerId: actor.playerId,
				kind: 'london_bottom',
				title: `Put ${countReq} Card(s) on Bottom of Library`,
				description: `Select ${countReq} card(s) from your hand to place on the bottom of your library.`,
				countRequired: countReq
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
	const prompt = state.pendingPrompts[promptIdx];

	// Phase 4: a cost choice. The answer is merged into the waiting action's costPayment and the
	// action runs again from scratch (re-checking legality); on failure the prompt is restored.
	if (prompt.kind === 'cost_choice' && action.type === 'cost_choice') {
		if (action.promptId !== prompt.id) return { ok: false, error: 'That cost choice is no longer pending.' };
		state.pendingPrompts.splice(promptIdx, 1);
		const pending = prompt.pendingAction;
		if (
			action.cancel ||
			!pending ||
			(pending.type !== 'cast_spell' && pending.type !== 'activate_ability' && pending.type !== 'tap_mana')
		) {
			return { ok: true };
		}
		const payment = {
			options: [...(pending.costPayment?.options ?? [])],
			objects: [...(pending.costPayment?.objects ?? [])]
		};
		const q = prompt.costQuestion;
		if (q?.kind === 'option') {
			if (action.option === undefined) {
				state.pendingPrompts.splice(promptIdx, 0, prompt);
				return { ok: false, error: 'Choose one of the options.' };
			}
			payment.options[q.index] = action.option;
		} else if (q?.kind === 'objects') {
			payment.objects[q.index] = action.instanceIds ?? [];
		}
		const result = applyGameAction(state, actor.playerId, { ...pending, costPayment: payment });
		if (!result.ok) state.pendingPrompts.splice(promptIdx, 0, prompt);
		return result;
	}

	if (prompt.kind === 'obeka_end_turn_choice' && action.type === 'obeka_end_turn_choice') {
		state.pendingPrompts.splice(promptIdx, 1);
		if (action.endTurn) {
			endTheTurnImmediately(state, actor.playerId);
		} else {
			addLog(
				state,
				'rule',
				`${actor.username} chose not to end the turn with Obeka, Brute Chronologist.`,
				actor.playerId
			);
		}
		checkStateBasedActions(state);
		return { ok: true };
	}

	if (prompt.kind === 'legend_rule' && action.type === 'legend_rule_choice') {
		const cands = prompt.candidateInstanceIds || [];
		if (!cands.includes(action.keepInstanceId)) {
			return { ok: false, error: 'Please choose one of the duplicate legendary permanents to keep.' };
		}
		state.pendingPrompts.splice(promptIdx, 1);
		for (const cid of cands) {
			if (cid !== action.keepInstanceId) {
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

	if (prompt.kind === 'commander_zone_choice' && action.type === 'commander_zone_choice') {
		state.pendingPrompts.splice(promptIdx, 1);
		if (action.sendToCommandZone) {
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
			addLog(
				state,
				'rule',
				`${actor.username} chose to leave Commander in ${prompt.destinationZone}.`,
				actor.playerId
			);
		}
		return { ok: true };
	}

	if (prompt.kind === 'discard_to_hand_size' && action.type === 'discard_cards') {
		const req = prompt.countRequired || 1;
		if (action.instanceIds.length !== req) {
			return { ok: false, error: `You must discard exactly ${req} card(s).` };
		}
		const gyDest = checkGraveyardReplacementZone(state, 'graveyard').dest;
		for (const id of action.instanceIds) {
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

	if (prompt.kind === 'search_library' && action.type === 'search_library_pick') {
		const libraryOwner =
			state.players.find(
				(p) => p.playerId === (prompt.targetLibraryOwnerId || actor.playerId)
			) || actor;

		if (action.instanceId === null) {
			const availableCount = prompt.candidateInstanceIds
				? prompt.candidateInstanceIds.length
				: libraryOwner.library.length;
			if (prompt.canFailToFind === false && availableCount > 0) {
				return {
					ok: false,
					error:
						'Strict Rules Violation (CR 701.19b): This search instruction does not state a card quality, so you must find a card if the library is not empty.'
				};
			}
		} else {
			if (
				prompt.candidateInstanceIds &&
				!prompt.candidateInstanceIds.includes(action.instanceId)
			) {
				return {
					ok: false,
					error: 'Strict Rules Violation: That card does not match the required search criteria.'
				};
			}
			if (!libraryOwner.library.some((c) => c.instanceId === action.instanceId)) {
				return {
					ok: false,
					error: 'Strict Rules Violation: Card not found in the searched library.'
				};
			}
		}

		state.pendingPrompts.splice(promptIdx, 1);
		let alreadyShuffledWithTopCard = false;

		if (action.instanceId) {
			const idx = libraryOwner.library.findIndex((c) => c.instanceId === action.instanceId);
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
					const selfEntersTapped = cardEntersTapped(found.card);
					found.tapped = Boolean(prompt.enterTapped) || selfEntersTapped;
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
					shuffleLibrary(libraryOwner, 1);
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
						state.pendingPrompts.push({
							id: uid('prm'),
							playerId: actor.playerId,
							targetLibraryOwnerId: libraryOwner.playerId,
							kind: 'search_library',
							title: prompt.interceptedBy
								? `${prompt.interceptedBy.sourceName} — Choose Next Card from ${libraryOwner.username}'s Library`
								: `Search Library — Next Card (${describeLibrarySearchDestination(nextDest)})`,
							description: prompt.interceptedBy
								? `Choose the next matching card from ${libraryOwner.username}'s library to exile via ${prompt.interceptedBy.sourceName}, or Fail to Find.`
								: `Choose the next matching card from your library to put ${describeLibrarySearchDestination(nextDest)}, then shuffle.`,
							destinationZone: nextDest.zone,
							enterTapped: Boolean(nextDest.tapped),
							putOnTop: Boolean(nextDest.onTop),
							searchSpec: prompt.searchSpec,
							remainingDestinations: nextDestinations,
							canFailToFind: prompt.canFailToFind ?? true,
							interceptedBy: prompt.interceptedBy,
							candidateInstanceIds: remainingCandidates,
							stackItem: prompt.stackItem,
							continuationEffects: prompt.continuationEffects
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
			shuffleLibrary(libraryOwner);
		}
		if (prompt.continuationEffects && prompt.continuationEffects.length > 0 && prompt.stackItem) {
			for (const eff of prompt.continuationEffects) {
				executeParsedEffect(state, libraryOwner, prompt.stackItem, eff);
			}
		}
		checkStateBasedActions(state);
		return { ok: true };
	}

	if (prompt.kind === 'scry_choice' && action.type === 'scry_resolve') {
		const candidateIds = prompt.candidateInstanceIds || [];
		const extracted: CardInstance[] = [];
		for (const cid of candidateIds) {
			const c = actor.library.find((l) => l.instanceId === cid);
			if (c && !extracted.includes(c)) extracted.push(c);
		}
		const byId = new Map(extracted.map((c) => [c.instanceId, c]));
		const usedIds = new Set<string>();
		const topList: CardInstance[] = [];
		const bottomList: CardInstance[] = [];

		for (const tid of action.topInstanceIds || []) {
			const card = byId.get(tid);
			if (card && !usedIds.has(tid)) {
				topList.push(card);
				usedIds.add(tid);
			}
		}
		if (prompt.allowBottom !== false) {
			for (const bid of action.bottomInstanceIds || []) {
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

		if (prompt.allowShuffle && action.shuffleAfter) {
			shuffleLibrary(actor);
			addLog(
				state,
				'rule',
				`${actor.username} looked at the top ${extracted.length} card(s) and chose to shuffle their library.`,
				actor.playerId
			);
		} else if (prompt.allowBottom === false) {
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
		if (prompt.continuationEffects && prompt.continuationEffects.length > 0 && prompt.stackItem) {
			for (const eff of prompt.continuationEffects) {
				executeParsedEffect(state, actor, prompt.stackItem, eff);
			}
			checkStateBasedActions(state);
		}
		return { ok: true };
	}

	if (prompt.kind === 'guided_resolution' && action.type === 'guided_resolve') {
		state.pendingPrompts.splice(promptIdx, 1);
		for (const op of action.operations) {
			if (op.op === 'draw_cards' && op.amount) {
				drawCards(state, actor, op.amount);
			} else if (op.op === 'modify_life' && op.targetId && op.amount) {
				const tp = state.players.find((p) => p.playerId === op.targetId);
				if (tp && !tp.lifeTotalCannotChangeThisTurn) tp.life += op.amount;
			} else if (op.op === 'deal_damage' && op.targetId && op.amount) {
				applyDamageToTarget(
					state,
					actor.playerId,
					{ kind: 'permanent', id: op.targetId, label: 'target' },
					op.amount
				);
			} else if (op.op === 'move_zone' && op.targetId && op.destinationZone) {
				const found = findPermanentOnBoard(state, op.targetId);
				if (found) {
					movePermanentToZone(state, found.inst, op.destinationZone);
				}
			}
		}
		addLog(state, 'cast', `${actor.username} completed guided resolution for ${prompt.title}.`, actor.playerId);
		checkStateBasedActions(state);
		return { ok: true };
	}

	return { ok: false, error: `Please resolve the active prompt: ${prompt.title}.` };
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
	let effectiveAmount = amount;
	if (type === '+1/+1') {
		let multiplier = 1;
		const activeHooks = collectActiveBoardHooks(state);
		for (const entry of activeHooks) {
			if (
				entry.hook.path === 'hook.counter_multiplier' &&
				entry.controllerId === perm.controllerId &&
				entry.hook.multiplier
			) {
				multiplier *= entry.hook.multiplier;
			}
		}
		effectiveAmount = amount * multiplier;
	}
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
function runDelayedEndStepTriggers(state: GameState, activePlayer: PlayerGameState): void {
	if (state.delayedTriggers && state.delayedTriggers.length > 0) {
		const remainingDelayed: DelayedTrigger[] = [];
		for (const dt of state.delayedTriggers) {
			const matchesTurn =
				(!dt.targetPlayerId || dt.targetPlayerId === activePlayer.playerId) &&
				(!dt.waitUntilAfterTurn || state.turnNumber > dt.waitUntilAfterTurn);
			if (dt.triggerPhase === 'end_step' && matchesTurn) {
				const targets: TargetRef[] = [];
				if (dt.targetInstanceId) {
					const found = findPermanentOnBoard(state, dt.targetInstanceId);
					if (found) {
						targets.push({
							kind: 'permanent',
							id: found.inst.instanceId,
							label: found.inst.card.name
						});
					}
				}
				const stkItem: StackItem = {
					id: uid('stk'),
					sourceInstanceId: dt.id,
					card: dt.sourceCard,
					controllerId: dt.controllerId,
					kind: 'triggered',
					title: `${dt.sourceCard.name} (Delayed End Step Trigger)`,
					oracleText: dt.description || dt.oracleText || '',
					targets,
					xValue: 0,
					parsedEffects: dt.effects,
					requiresGuidedResolution: false,
					createdAt: Date.now()
				};
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
	emitEvent(state, {
		kind: 'PhaseBegin',
		phase,
		activePlayerId: (activePlayer ?? state.players[state.activePlayerIndex])?.playerId ?? null
	});
	// Beginning-of-step triggers go on the stack now: the callers check the stack right after this.
	flushTriggers(state);
}

// Event dispatch (Phase 5). Every event is matched against compiled triggered abilities
// (runtime/triggers.ts); matches wait for the next flushTriggers. PhaseBegin also runs the suspend
// keyword (before matching, as the old upkeep loop did) and delayed end-step triggers (after the
// beginning-of-end-step triggers are on the stack).
for (const kind of [
	'ZoneChange',
	'Cast',
	'SpellCopied',
	'AttackDeclared',
	'BlockersDeclared',
	'DamageDealt',
	'CounterPlaced',
	'BecameTarget',
	'Attached'
] as const) {
	registerEventHandler(kind, (state, ev) => matchTriggers(state, ev));
}
registerEventHandler('PhaseBegin', (state, ev) => {
	const activePlayer = state.players.find((p) => p.playerId === ev.activePlayerId);
	if (ev.phase === 'upkeep' && activePlayer) runSuspendUpkeep(state, activePlayer);
	matchTriggers(state, ev);
	if (ev.phase === 'end_step' && activePlayer) {
		flushTriggers(state);
		runDelayedEndStepTriggers(state, activePlayer);
	}
});

/**
 * Builds the stack item for a triggered ability (also the "dummy" item an inline trigger resolves
 * with). `targets[0]` is the object or player the event was about, as the old triggerOnX functions
 * passed it; `lkiPower` is the damage dealt or the entering creature's power.
 */
function triggeredStackItem(state: GameState, t: PendingTrigger, idPrefix: string): StackItem {
	const targets: TargetRef[] = [];
	if (t.eventPlayerId) {
		const pl = state.players.find((p) => p.playerId === t.eventPlayerId);
		targets.push({ kind: 'player', id: t.eventPlayerId, label: pl?.username ?? t.eventPlayerId });
	} else if (t.eventObject) {
		targets.push({ kind: 'permanent', id: t.eventObject.instanceId, label: t.eventObject.card.name });
	}
	return {
		id: uid(idPrefix),
		sourceInstanceId: t.source.instanceId,
		card: t.sourceCard,
		controllerId: t.controllerId,
		kind: 'triggered',
		title: `${t.sourceCard.name} (${t.label})`,
		oracleText: t.ability.legacy.clause,
		targets,
		xValue: 0,
		parsedEffects: t.ability.legacy.effects,
		requiresGuidedResolution: false,
		createdAt: Date.now(),
		lkiPower: t.amount,
		triggeredAbilityIndex: t.ability.abilityIndex
	};
}

/**
 * Executes a triggered ability's effect. THE single place trigger effects run (inline triggers here;
 * stacked ones through resolveTopOfStack's parsedEffects loop). It uses the legacy ParsedEffect path
 * until Phase 3's IR interpreter replaces this body with one call (interpret t.ability's effect).
 */
function executeTriggerEffects(state: GameState, controller: PlayerGameState, item: StackItem): void {
	for (const eff of item.parsedEffects) {
		executeParsedEffect(state, controller, item, eff);
	}
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
	putOnStack(state, t) {
		state.stack.push(triggeredStackItem(state, t, 'stk'));
		addLog(state, 'trigger', `${t.sourceCard.name}'s ${t.label} was put onto the Stack.`, t.controllerId);
	}
});

export function resolveTopOfStack(state: GameState): void {
	const item = state.stack.pop();
	if (!item) return;

	const controller = state.players.find((p) => p.playerId === item.controllerId);
	if (!controller) return;

	// Check intervening-if clause on resolution (CR 603.4)
	if (
		(item.triggeredAbilityIndex !== undefined &&
			!stackTriggerConditionHolds(
				state,
				item.card,
				item.triggeredAbilityIndex,
				item.controllerId,
				item.sourceInstanceId
			)) ||
		(item.interveningIfClause === 'life_40_or_more' && controller.life < 40)
	) {
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
	if (item.targets.length > 0) {
		const validTargets = item.targets.filter((t) =>
			isTargetStillValid(state, t, item.controllerId, item.card)
		);
		if (validTargets.length === 0) {
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

	emitVfx(state, {
		kind: 'stack_resolve',
		sourceId: item.controllerId,
		targetId: item.targets[0]?.id,
		label: `Resolved: ${item.title}`
	});

	let turnEndedDuringResolution = false;

	// Execute parsed effects (pausing continuation effects if a human Scry or Library Search prompt is created)
	for (let i = 0; i < item.parsedEffects.length; i++) {
		const eff = item.parsedEffects[i];
		if (eff.kind === 'end_the_turn') {
			endTheTurnImmediately(state, controller.playerId);
			turnEndedDuringResolution = true;
			break;
		}
		if ((eff.kind === 'scry' || eff.kind === 'rearrange_top') && !controller.isBot) {
			const count = Math.min(eff.amount, controller.library.length);
			if (count > 0) {
				const topCards = controller.library.slice(0, count);
				const isRearrangeOnly = eff.kind === 'rearrange_top';
				state.pendingPrompts.push({
					id: uid('prm'),
					playerId: controller.playerId,
					kind: 'scry_choice',
					title: isRearrangeOnly
						? `Rearrange Top ${count} (${item.card.name})`
						: `Scry ${count} (${item.card.name})`,
					description: isRearrangeOnly
						? `Look at the top ${count} card(s) of your library and put them back on top in any order.${eff.mayShuffle ? ' Or you may shuffle your library.' : ''}`
						: `Look at the top ${count} card(s) of your library. Put any number on the bottom in any order and the rest on top in any order.`,
					countRequired: count,
					candidateInstanceIds: topCards.map((c) => c.instanceId),
					allowBottom: !isRearrangeOnly,
					allowShuffle: Boolean(eff.mayShuffle),
					stackItem: item,
					continuationEffects: item.parsedEffects.slice(i + 1)
				});
				break;
			}
			continue;
		}
		const promptsBefore = state.pendingPrompts.length;
		executeParsedEffect(state, controller, item, eff);
		if (state.pendingPrompts.length > promptsBefore && i + 1 < item.parsedEffects.length) {
			const latestPrompt = state.pendingPrompts[state.pendingPrompts.length - 1];
			if (latestPrompt.kind === 'search_library') {
				latestPrompt.stackItem = item;
				latestPrompt.continuationEffects = item.parsedEffects.slice(i + 1);
				break;
			}
		}
	}

	if (turnEndedDuringResolution) {
		return;
	}

	// Register any delayed triggers created by this spell (e.g., Final Fortune's end-step loss trigger)
	if (item.kind === 'spell') {
		const delayedSpecs = parseDelayedTriggersFromSpell(item.card);
		for (const spec of delayedSpecs) {
			if (item.card.name === 'Corpse Dance') continue; // Corpse Dance registers its delayed trigger with the specific reanimated creature ID inside executeParsedEffect
			if (!state.delayedTriggers) state.delayedTriggers = [];
			state.delayedTriggers.push({
				id: uid('dtrig'),
				sourceInstanceId: item.sourceInstanceId,
				sourceCard: item.card,
				controllerId: controller.playerId,
				triggerPhase: spec.triggerPhase,
				targetPlayerId: spec.forNextTurnOfController ? controller.playerId : undefined,
				waitUntilAfterTurn: spec.forNextTurnOfController ? state.turnNumber : undefined,
				title: spec.title,
				oracleText: spec.oracleText,
				effects: spec.effects,
				description: spec.description,
				createdAtTurn: state.turnNumber
			});
		}
	}

	// Handle graveyard-targeting return-to-hand or exile effects
	const graveTargets = item.targets.filter((t) => t.kind === 'graveyard_card');
	if (graveTargets.length > 0) {
		const oLow = item.oracleText.toLowerCase();
		if (oLow.includes('return') && oLow.includes('hand')) {
			for (const gt of graveTargets) {
				for (const p of state.players) {
					const gIdx = p.graveyard.findIndex((c) => c.instanceId === gt.id);
					if (gIdx >= 0) {
						const card = p.graveyard[gIdx];
						moveObject(state, card, 'hand', {
							from: { player: p, zone: 'graveyard' },
							toPlayer: p,
							bumpVersion: true
						});
						addLog(
							state,
							'cast',
							`${item.title} returned ${card.card.name} from ${p.username}'s graveyard to hand.`,
							controller.playerId
						);
						break;
					}
				}
			}
		} else if (oLow.includes('exile')) {
			for (const gt of graveTargets) {
				for (const p of state.players) {
					const gIdx = p.graveyard.findIndex((c) => c.instanceId === gt.id);
					if (gIdx >= 0) {
						const card = p.graveyard[gIdx];
						moveObject(state, card, 'exile', {
							from: { player: p, zone: 'graveyard' },
							toPlayer: p,
							bumpVersion: true
						});
						addLog(
							state,
							'cast',
							`${item.title} exiled ${card.card.name} from ${p.username}'s graveyard.`,
							controller.playerId
						);
						break;
					}
				}
			}
		}
	}

	if (item.requiresGuidedResolution && !controller.isBot) {
		state.pendingPrompts.push({
			id: uid('prm'),
			playerId: controller.playerId,
			kind: 'guided_resolution',
			title: `Resolve ${item.card.name}`,
			description: item.oracleText,
			stackItem: item
		});
	}

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

			// CR 707: Clone / "enter the battlefield as a copy of any creature on the battlefield"
			if (
				/enter(?:s)? (?:the battlefield )?as a copy of any creature/i.test(item.card.oracleText)
			) {
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
					perm.copiableCard = baseCardToCopy;
					perm.card = baseCardToCopy;
					addLog(
						state,
						'cast',
						`Clone entered the battlefield as a copy of ${baseCardToCopy.name} (CR 707.2).`,
						controller.playerId
					);
				}
			}

			if (tLine.includes('Aura') && item.targets[0]?.kind === 'permanent') {
				perm.attachedToId = item.targets[0].id;
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
			// Check if spell exiles itself on resolution (e.g. Teferi's Protection, Time Stop)
			const exilesSelf = /exile\s+~|exile\s+teferi's protection|exile\s+time stop/i.test(
				item.card.oracleText
			);
			moveStackSpellToZone(state, item, exilesSelf ? 'exile' : 'graveyard');
		}
	}

	state.priorityPlayerIndex = state.activePlayerIndex;
	state.passedPriorityPlayerIds = [];
	checkStateBasedActions(state);
}

function executeParsedEffect(
	state: GameState,
	controller: PlayerGameState,
	item: StackItem,
	eff: ParsedEffect
): void {
	const resolveRecipientPlayer = (): PlayerGameState => {
		if (eff.recipient === 'target_controller') {
			if (item.lkiControllerId) {
				const lkiPlayer = state.players.find((p) => p.playerId === item.lkiControllerId);
				if (lkiPlayer) return lkiPlayer;
			}
			const t0 = item.targets[0];
			if (t0?.kind === 'permanent') {
				const found = findPermanentOnBoard(state, t0.id);
				if (found) return found.controller;
			}
		}
		return controller;
	};

	switch (eff.kind) {
		case 'end_the_turn': {
			endTheTurnImmediately(state, controller.playerId);
			break;
		}

		case 'may_end_the_turn': {
			const activePlayer = state.players[state.activePlayerIndex];
			if (!activePlayer) break;
			if (activePlayer.playerId === controller.playerId || activePlayer.isBot) {
				// Active player is controller (or a bot): end the turn immediately!
				endTheTurnImmediately(state, activePlayer.playerId);
			} else {
				state.pendingPrompts.push({
					id: uid('prm'),
					playerId: activePlayer.playerId,
					kind: 'obeka_end_turn_choice',
					title: 'End the Turn? (Obeka, Brute Chronologist)',
					description: `${controller.username} activated Obeka, Brute Chronologist. As the player whose turn it is, you may end the turn now (exiling all spells and abilities from the stack).`
				});
			}
			break;
		}

		case 'extra_turn': {
			if (!state.extraTurnQueue) state.extraTurnQueue = [];
			const count = Math.max(1, eff.amount || 1);
			for (let i = 0; i < count; i++) {
				// CR 500.7: Extra turns are added in LIFO order
				state.extraTurnQueue.push(controller.playerId);
			}
			addLog(
				state,
				'rule',
				`${controller.username} will take ${count} extra turn(s) after this one (CR 500.7)!`,
				controller.playerId
			);
			break;
		}

		case 'phase_out_team': {
			// Teferi's Protection: life total can't change, protection from everything, all permanents you control phase out
			controller.lifeTotalCannotChangeThisTurn = true;
			controller.protectionFromEverythingThisTurn = true;
			for (const perm of controller.battlefield) {
				if (!perm.phasedOut) {
					phaseOutPermanent(state, perm);
				}
			}
			addLog(
				state,
				'rule',
				`All permanents controlled by ${controller.username} phased out, and their life total cannot change until their next turn (CR 702.26)!`,
				controller.playerId
			);
			break;
		}

		case 'phase_out_target': {
			const target = item.targets[0];
			if (target) {
				const found = findPermanentOnBoard(state, target.id);
				if (found) {
					phaseOutPermanent(state, found.inst);
					addLog(
						state,
						'cast',
						`${item.title} caused ${found.inst.card.name} to phase out (CR 702.26)!`,
						controller.playerId
					);
				}
			}
			break;
		}

		case 'switch_pt_target': {
			const target = item.targets[0];
			if (target) {
				const found = findPermanentOnBoard(state, target.id);
				if (found) {
					found.inst.switchedPTCount = (found.inst.switchedPTCount || 0) + 1;
					addLog(
						state,
						'cast',
						`${item.title} switched ${found.inst.card.name}'s power and toughness until end of turn (Layer 7d).`,
						controller.playerId
					);
				}
			}
			break;
		}

		case 'win_the_game': {
			if (eff.dynamicFormula === 'devotion_blue_gte_library') {
				let blueDevotion = 0;
				for (const perm of controller.battlefield) {
					if (perm.phasedOut) continue;
					const uMatches = perm.card.manaCost.match(/\{U\}/gi);
					if (uMatches) blueDevotion += uMatches.length;
				}
				if (blueDevotion >= controller.library.length) {
					winTheGame(
						state,
						controller,
						`${item.card.name} ETB (Devotion to Blue ${blueDevotion} >= Library ${controller.library.length})`
					);
				}
				break;
			}
			winTheGame(state, controller, `${item.card.name} win condition`);
			break;
		}

		case 'lose_the_game_self': {
			loseTheGame(state, controller, `${item.title} ("you lose the game")`);
			break;
		}

		case 'sacrifice_self': {
			const found = findPermanentOnBoard(state, item.sourceInstanceId);
			if (found) {
				movePermanentToZone(state, found.inst, 'graveyard');
				addLog(
					state,
					'rule',
					`${controller.username} sacrificed ${found.inst.card.name}.`,
					controller.playerId
				);
			}
			break;
		}

		case 'return_self_from_graveyard': {
			const gIdx = controller.graveyard.findIndex((c) => c.instanceId === item.sourceInstanceId);
			if (gIdx >= 0) {
				const card = controller.graveyard[gIdx];
				moveObject(state, card, 'battlefield', {
					from: { player: controller, zone: 'graveyard' },
					toPlayer: controller,
					controllerId: controller.playerId,
					newTimestamp: true,
					bumpVersion: true,
					// Haste was checked with the card out of the graveyard but not yet on the battlefield.
					beforeInsert: (c) => {
						c.summoningSick = !hasKeyword(c, 'Haste', state);
					}
				});
				addLog(
					state,
					'trigger',
					`${card.card.name} returned from ${controller.username}'s graveyard to the battlefield!`,
					controller.playerId
				);
				flushTriggers(state);
			}
			break;
		}

		case 'exile_all_graveyards': {
			let exiledTotal = 0;
			for (const p of state.players) {
				// Top card first, so exile receives the graveyard in reverse order (pinned behaviour).
				while (p.graveyard.length > 0) {
					moveObject(state, p.graveyard[p.graveyard.length - 1], 'exile', {
						from: { player: p, zone: 'graveyard' },
						toPlayer: p,
						bumpVersion: true
					});
					exiledTotal++;
				}
			}
			addLog(
				state,
				'trigger',
				`${item.title} exiled all ${exiledTotal} card(s) from all graveyards!`,
				controller.playerId
			);
			break;
		}

		case 'return_from_graveyard_to_hand': {
			const graveTarget = item.targets.find(
				(t) => t.kind === 'graveyard_card' || t.kind === 'card_in_graveyard'
			);
			let gIdx = -1;
			if (graveTarget) {
				gIdx = controller.graveyard.findIndex((c) => c.instanceId === graveTarget.id);
			}
			if (gIdx < 0 && controller.graveyard.length > 0) {
				gIdx = controller.graveyard.length - 1;
			}
			if (gIdx >= 0) {
				const ret = controller.graveyard[gIdx];
				moveObject(state, ret, 'hand', {
					from: { player: controller, zone: 'graveyard' },
					toPlayer: controller,
					bumpVersion: true
				});
				addLog(
					state,
					'trigger',
					`${item.card.name} returned ${ret.card.name} from graveyard to hand.`,
					controller.playerId
				);
			}
			break;
		}

		case 'copy_target_permanent': {
			const target = item.targets[0];
			const found = target ? findPermanentOnBoard(state, target.id) : null;
			if (found && !found.inst.phasedOut) {
				const baseCardToCopy = JSON.parse(
					JSON.stringify(found.inst.copiableCard ?? found.inst.card)
				) as ScryfallCard;
				const tokenInst = createCardInstance(
					baseCardToCopy,
					controller.playerId,
					'battlefield',
					false,
					true,
					allocateTimestamp(state)
				);
				tokenInst.copiableCard = baseCardToCopy;
				tokenInst.summoningSick = baseCardToCopy.typeLine.includes('Creature');
				moveObject(state, tokenInst, 'battlefield', { from: 'none', toPlayer: controller });
				addLog(
					state,
					'trigger',
					`${item.card.name} created a token copy of ${baseCardToCopy.name}!`,
					controller.playerId
				);
				flushTriggers(state);
			}
			break;
		}

		case 'counter_target_spell': {
			for (const target of item.targets) {
				const stkIdx = state.stack.findIndex(
					(s) => s.id === target.id || s.sourceInstanceId === target.id
				);
				if (stkIdx >= 0) {
					const candidate = state.stack[stkIdx];
					const cLow = candidate.card.oracleText.toLowerCase();
					if (cLow.includes("can't be countered") || cLow.includes('cannot be countered')) {
						addLog(
							state,
							'rule',
							`${candidate.title} cannot be countered by ${item.title}!`,
							controller.playerId
						);
						continue;
					}
					const [countered] = state.stack.splice(stkIdx, 1);
					moveStackSpellToZone(state, countered, 'graveyard');
					emitVfx(state, {
						kind: 'counter_spell',
						sourceId: controller.playerId,
						targetId: countered.controllerId,
						label: `Countered ${countered.title}!`
					});
					addLog(state, 'cast', `${item.title} countered ${countered.title}!`, controller.playerId);
				}
			}
			break;
		}

		case 'draw': {
			let count = eff.amount;
			if (eff.dynamicFormula?.startsWith('attacking_subtype_count:')) {
				const subtype = eff.dynamicFormula.split(':')[1];
				count = state.combat.attackers.filter((atk) => {
					if (atk.controllerId !== controller.playerId) return false;
					const perm = controller.battlefield.find(
						(b) => !b.phasedOut && b.instanceId === atk.attackerInstanceId
					);
					if (!perm) return false;
					const evalPerm = evaluatePermanent(state, perm);
					return evalPerm.hasSubType(subtype) || evalPerm.typeLine.includes(subtype);
				}).length;
			}
			if (count > 0) {
				drawCards(state, controller, count);
				addLog(state, 'rule', `${controller.username} drew ${count} card(s).`, controller.playerId);
			}
			break;
		}

		case 'scry': {
			const count = Math.min(eff.amount, controller.library.length);
			if (count <= 0) break;
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
				state.pendingPrompts.push({
					id: uid('prm'),
					playerId: controller.playerId,
					kind: 'scry_choice',
					title: `Scry ${count} (${item.card.name})`,
					description: `Look at the top ${count} card(s) of your library. Put any number on the bottom in any order and the rest on top in any order.`,
					countRequired: count,
					candidateInstanceIds: topCards.map((c) => c.instanceId),
					allowBottom: true,
					allowShuffle: false
				});
			}
			break;
		}

		case 'rearrange_top': {
			const count = Math.min(eff.amount, controller.library.length);
			if (count <= 0) break;
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
				state.pendingPrompts.push({
					id: uid('prm'),
					playerId: controller.playerId,
					kind: 'scry_choice',
					title: `Rearrange Top ${count} (${item.card.name})`,
					description: `Look at the top ${count} card(s) of your library and put them back on top in any order.${eff.mayShuffle ? ' Or you may shuffle your library.' : ''}`,
					countRequired: count,
					candidateInstanceIds: topCards.map((c) => c.instanceId),
					allowBottom: false,
					allowShuffle: Boolean(eff.mayShuffle)
				});
			}
			break;
		}

		case 'equip_target': {
			const equipFound = findPermanentOnBoard(state, item.sourceInstanceId);
			const target = item.targets[0];
			const targetFound = target ? findPermanentOnBoard(state, target.id) : null;
			if (
				equipFound &&
				targetFound &&
				targetFound.controller.playerId === controller.playerId &&
				evaluatePermanent(state, targetFound.inst).typeLine.includes('Creature')
			) {
				equipFound.inst.attachedToId = targetFound.inst.instanceId;
				addLog(
					state,
					'cast',
					`${controller.username} attached ${equipFound.inst.card.name} to ${targetFound.inst.card.name}.`,
					controller.playerId
				);
				emitEvent(state, {
					kind: 'Attached',
					attachmentId: equipFound.inst.instanceId,
					attachment: equipFound.inst,
					hostId: targetFound.inst.instanceId,
					host: targetFound.inst
				});
				flushTriggers(state);
			}
			break;
		}

		case 'gain_life': {
			const recipientPlayer = resolveRecipientPlayer();
			const amount =
				eff.dynamicFormula === 'target_power'
					? Math.max(0, item.lkiPower ?? 0)
					: eff.amount;
			if (!recipientPlayer.lifeTotalCannotChangeThisTurn) {
				recipientPlayer.life += amount;
			}
			emitVfx(state, {
				kind: amount >= 0 ? 'heal' : 'damage',
				targetId: recipientPlayer.playerId,
				amount: Math.abs(amount),
				label: `${amount >= 0 ? '+' : ''}${amount} Life`
			});
			break;
		}

		case 'lose_life_opponents': {
			let amount = eff.amount;
			if (eff.dynamicFormula?.startsWith('count_subtype:')) {
				const subtype = eff.dynamicFormula.split(':')[1];
				amount = controller.battlefield.filter((b) => {
					if (b.phasedOut) return false;
					const evalPerm = evaluatePermanent(state, b);
					return evalPerm.hasSubType(subtype) || evalPerm.typeLine.includes(subtype);
				}).length;
			}
			for (const opp of state.players) {
				if (opp.playerId !== controller.playerId && !opp.lost) {
					if (!opp.lifeTotalCannotChangeThisTurn) {
						opp.life -= amount;
					}
					emitVfx(state, {
						kind: 'damage',
						sourceId: controller.playerId,
						targetId: opp.playerId,
						amount
					});
				}
			}
			addLog(
				state,
				'life',
				`Each opponent lost ${amount} life from ${item.title}.`,
				controller.playerId
			);
			break;
		}

		case 'damage_target': {
			const target = item.targets[0];
			if (target) {
				applyDamageToTarget(state, controller.playerId, target, eff.amount);
			}
			break;
		}

		case 'damage_each_opponent': {
			let amount = eff.amount;
			if (eff.dynamicFormula === 'entered_power') {
				if (item.lkiPower !== undefined) {
					amount = item.lkiPower;
				} else if (item.targets[0]?.kind === 'permanent') {
					const found = findPermanentOnBoard(state, item.targets[0].id);
					amount = found ? getCreaturePower(found.inst, state) : 0;
				} else {
					amount = 0;
				}
			}
			if (amount <= 0) break;
			for (const opp of state.players) {
				if (opp.playerId !== controller.playerId && !opp.lost) {
					if (!opp.lifeTotalCannotChangeThisTurn && !opp.protectionFromEverythingThisTurn) {
						opp.life -= amount;
					}
					if (!opp.protectionFromEverythingThisTurn) {
						emitEvent(state, {
							kind: 'DamageDealt',
							sourceId: item.sourceInstanceId,
							targetId: opp.playerId,
							targetKind: 'player',
							amount,
							combat: false
						});
					}
					emitVfx(state, {
						kind: 'damage',
						sourceId: controller.playerId,
						targetId: opp.playerId,
						amount
					});
				}
			}
			break;
		}

		case 'damage_all_creatures': {
			for (const p of state.players) {
				for (const perm of p.battlefield) {
					if (perm.phasedOut) continue;
					if (evaluatePermanent(state, perm).typeLine.includes('Creature')) {
						perm.damageMarked += eff.amount;
						emitEvent(state, {
							kind: 'DamageDealt',
							sourceId: item.sourceInstanceId,
							targetId: perm.instanceId,
							targetKind: 'permanent',
							amount: eff.amount,
							combat: false
						});
						emitVfx(state, {
							kind: 'damage',
							targetId: perm.instanceId,
							amount: eff.amount
						});
					}
				}
			}
			addLog(state, 'combat', `${item.title} dealt ${eff.amount} damage to each creature!`, controller.playerId);
			break;
		}

		case 'destroy_target': {
			const target = item.targets[0];
			if (!target) break;
			const found = findPermanentOnBoard(state, target.id);
			if (found && !found.inst.phasedOut) {
				if (hasKeyword(found.inst, 'Indestructible', state)) {
					addLog(state, 'rule', `${found.inst.card.name} is Indestructible and was not destroyed.`);
				} else {
					emitVfx(state, { kind: 'destroy', targetId: found.inst.instanceId, label: found.inst.card.name });
					movePermanentToZone(state, found.inst, 'graveyard');
					addLog(state, 'cast', `${item.title} destroyed ${found.inst.card.name}.`, controller.playerId);
					flushTriggers(state);
				}
			}
			break;
		}

		case 'destroy_all_creatures': {
			const toDestroy: { perm: CardInstance; controller: PlayerGameState }[] = [];
			const isExileAll = item.oracleText.toLowerCase().includes('exile all');
			for (const p of state.players) {
				for (const perm of p.battlefield) {
					if (perm.phasedOut) continue;
					if (evaluatePermanent(state, perm).typeLine.includes('Creature')) {
						if (isExileAll || !hasKeyword(perm, 'Indestructible', state)) {
							toDestroy.push({ perm, controller: p });
						}
					}
				}
			}
			for (const { perm } of toDestroy) {
				emitVfx(state, { kind: isExileAll ? 'exile' : 'destroy', targetId: perm.instanceId });
				movePermanentToZone(state, perm, isExileAll ? 'exile' : 'graveyard');
			}
			flushTriggers(state);
			addLog(
				state,
				'cast',
				`${item.title} wiped ${toDestroy.length} creature(s) from the battlefield!`,
				controller.playerId
			);
			break;
		}

		case 'exile_target': {
			const target = item.targets[0];
			if (!target) break;
			const found = findPermanentOnBoard(state, target.id);
			if (found && !found.inst.phasedOut) {
				emitVfx(state, { kind: 'exile', targetId: found.inst.instanceId, label: found.inst.card.name });
				movePermanentToZone(state, found.inst, 'exile');
				addLog(state, 'cast', `${item.title} exiled ${found.inst.card.name}.`, controller.playerId);
			}
			break;
		}

		case 'bounce_target': {
			const isOverloadBounce = isOverloadCastMode(item.card, item.xValue, item.castMode);
			if (isOverloadBounce) {
				for (const p of state.players) {
					if (p.playerId === controller.playerId) continue;
					const nonLands = p.battlefield.filter(
						(b) => !b.phasedOut && !evaluatePermanent(state, b).typeLine.includes('Land')
					);
					for (const perm of nonLands) {
						movePermanentToZone(state, perm, 'hand');
					}
				}
				addLog(
					state,
					'cast',
					`${controller.username} resolved Overloaded ${item.card.name}!`,
					controller.playerId
				);
			} else {
				const target = item.targets[0];
				if (target) {
					const found = findPermanentOnBoard(state, target.id);
					if (found && !found.inst.phasedOut) {
						movePermanentToZone(state, found.inst, 'hand');
						addLog(state, 'cast', `${item.title} returned ${found.inst.card.name} to hand.`, controller.playerId);
					}
				}
			}
			break;
		}

		case 'search_land_to_battlefield':
		case 'search_library_to_hand': {
			const recipientPlayer = resolveRecipientPlayer();
			initiateLibrarySearch(state, recipientPlayer, eff, item);
			break;
		}

		case 'create_token': {
			if (eff.tokenSpec) {
				const recipientPlayer = resolveRecipientPlayer();
				const count =
					eff.dynamicFormula === 'combat_damage_dealt'
						? Math.max(0, item.lkiPower ?? eff.amount)
						: eff.amount;
				for (let i = 0; i < count; i++) {
					createTokenOnBoard(state, recipientPlayer, eff.tokenSpec);
				}
				if (count > 0) {
					addLog(
						state,
						'cast',
						`${recipientPlayer.username} created ${count}x ${eff.tokenSpec.name}.`,
						recipientPlayer.playerId
					);
				}
			}
			break;
		}

		case 'proliferate': {
			executeProliferate(state, controller);
			break;
		}

		case 'add_counters_self': {
			const found = findPermanentOnBoard(state, item.sourceInstanceId);
			if (found && !found.inst.phasedOut) {
				const cType = eff.counterType || '+1/+1';
				addCountersToPermanent(state, found.inst, cType, eff.amount);
			}
			break;
		}

		case 'add_counters_team': {
			const cType = eff.counterType || '+1/+1';
			let placedAmount = eff.amount;
			for (const perm of controller.battlefield) {
				if (perm.phasedOut) continue;
				if (evaluatePermanent(state, perm).typeLine.includes('Creature')) {
					placedAmount = addCountersToPermanent(state, perm, cType, eff.amount);
				}
			}
			addLog(
				state,
				'cast',
				`${controller.username} put ${placedAmount} ${cType} counter(s) on each creature they control!`,
				controller.playerId
			);
			break;
		}

		case 'add_counters_target': {
			const target = item.targets[0];
			if (target) {
				const found = findPermanentOnBoard(state, target.id);
				if (found && !found.inst.phasedOut) {
					const cType = eff.counterType || '+1/+1';
					addCountersToPermanent(state, found.inst, cType, eff.amount);
				}
			}
			break;
		}

		case 'pump_self_eot': {
			const found = findPermanentOnBoard(state, item.sourceInstanceId);
			if (found && !found.inst.phasedOut) {
				found.inst.tempPowerMod += eff.amount;
				found.inst.tempToughnessMod += eff.toughnessAmount ?? eff.amount;
			}
			break;
		}

		case 'pump_team_eot': {
			let pAmt = eff.amount;
			let tAmt = eff.toughnessAmount ?? eff.amount;
			if (eff.dynamicFormula?.startsWith('count_subtype:')) {
				const subtype = eff.dynamicFormula.split(':')[1];
				const count = controller.battlefield.filter((b) => {
					if (b.phasedOut) return false;
					const evalPerm = evaluatePermanent(state, b);
					return evalPerm.hasSubType(subtype) || evalPerm.typeLine.includes(subtype);
				}).length;
				pAmt = count;
				tAmt = count;
			}
			for (const perm of controller.battlefield) {
				if (perm.phasedOut) continue;
				if (evaluatePermanent(state, perm).typeLine.includes('Creature')) {
					perm.tempPowerMod += pAmt;
					perm.tempToughnessMod += tAmt;
					if (eff.grantedKeyword && !perm.grantedKeywords.includes(eff.grantedKeyword)) {
						perm.grantedKeywords.push(eff.grantedKeyword);
					}
				}
			}
			break;
		}

		case 'grant_keyword_target_eot': {
			const kw = eff.grantedKeyword;
			if (!kw) break;
			for (const t of item.targets) {
				const found = findPermanentOnBoard(state, t.id);
				if (found && !found.inst.phasedOut) {
					if (!found.inst.grantedKeywords.includes(kw)) {
						found.inst.grantedKeywords.push(kw);
					}
				}
			}
			break;
		}

		case 'add_mana': {
			for (const c of eff.manaColors || ['R']) {
				controller.manaPool[c] += 1;
			}
			break;
		}

		case 'reanimate_target': {
			// Check Corpse Dance ("top creature card of your graveyard" — CR 404.2 graveyard order!)
			if (eff.dynamicFormula === 'top_creature_of_graveyard') {
				let topIdx = -1;
				for (let i = controller.graveyard.length - 1; i >= 0; i--) {
					if (controller.graveyard[i].card.typeLine.includes('Creature')) {
						topIdx = i;
						break;
					}
				}
				if (topIdx >= 0) {
					const reanimated = controller.graveyard[topIdx];
					reanimated.summoningSick = false;
					if (!reanimated.grantedKeywords.includes('Haste')) {
						reanimated.grantedKeywords.push('Haste');
					}
					moveObject(state, reanimated, 'battlefield', {
						from: { player: controller, zone: 'graveyard' },
						toPlayer: controller,
						controllerId: controller.playerId,
						newTimestamp: true,
						bumpVersion: true
					});
					addLog(
						state,
						'cast',
						`Corpse Dance reanimated the top creature card of ${controller.username}'s graveyard (${reanimated.card.name}) with Haste (CR 404.2)!`,
						controller.playerId
					);
					flushTriggers(state);
					if (!state.delayedTriggers) state.delayedTriggers = [];
					state.delayedTriggers.push({
						id: uid('dtrig'),
						sourceCard: item.card,
						controllerId: controller.playerId,
						triggerPhase: 'end_step',
						targetInstanceId: reanimated.instanceId,
						effects: [
							{
								kind: 'exile_target',
								amount: 1
							}
						],
						description: `At the beginning of the next end step, exile ${reanimated.card.name}.`
					});
				}
				break;
			}

			const graveTargets = item.targets.filter((t) => t.kind === 'graveyard_card');
			if (graveTargets.length > 0) {
				for (const gt of graveTargets) {
					for (const p of state.players) {
						const gIdx = p.graveyard.findIndex((c) => c.instanceId === gt.id);
						if (gIdx >= 0) {
							const reanimated = p.graveyard[gIdx];
							reanimated.summoningSick = reanimated.card.typeLine.includes('Creature');
							moveObject(state, reanimated, 'battlefield', {
								from: { player: p, zone: 'graveyard' },
								toPlayer: controller,
								controllerId: controller.playerId,
								newTimestamp: true,
								bumpVersion: true
							});
							addLog(
								state,
								'cast',
								`${controller.username} reanimated ${reanimated.card.name} onto the battlefield!`,
								controller.playerId
							);
							flushTriggers(state);
							break;
						}
					}
				}
				break;
			}
			// Fallback: Reanimate top creature from graveyard (searching from top = end of array)
			for (const p of state.players) {
				let gIdx = -1;
				for (let i = p.graveyard.length - 1; i >= 0; i--) {
					if (p.graveyard[i].card.typeLine.includes('Creature')) {
						gIdx = i;
						break;
					}
				}
				if (gIdx >= 0) {
					const creature = p.graveyard[gIdx];
					creature.summoningSick = true;
					moveObject(state, creature, 'battlefield', {
						from: { player: p, zone: 'graveyard' },
						toPlayer: controller,
						controllerId: controller.playerId,
						newTimestamp: true,
						bumpVersion: true
					});
					addLog(
						state,
						'cast',
						`${controller.username} reanimated ${creature.card.name} onto the battlefield!`,
						controller.playerId
					);
					flushTriggers(state);
					break;
				}
			}
			break;
		}
	}
}

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
	emitVfx(state, { kind: 'phase_change', label: 'End Step' });
	// Beginning-of-end-step and delayed end-step triggers run from the PhaseBegin handler
	// (runEndStepTriggers), synchronously.
	beginPhase(state, 'end_step', activePlayer);

	state.priorityPlayerIndex = state.activePlayerIndex;
	state.passedPriorityPlayerIds = [];

	// If nothing is on the stack during the End Step, proceed to Cleanup Step automatically
	if (state.stack.length === 0) {
		runCleanupStep(state);
	}
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
	const parsed = parseSpellOrAbilityEffects(suspCard.card);
	const chosenTargets: TargetRef[] = [];
	if (parsed.targetInfo.requiresTarget && parsed.targetInfo.minTargets > 0) {
		const legalTargets = getAllLegalTargetsForRequirement(
			state,
			owner.playerId,
			parsed.targetInfo,
			suspCard.card,
			suspCard.instanceId
		);
		if (legalTargets.length < parsed.targetInfo.minTargets) {
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

	const stackItem: StackItem = {
		id: uid('stk'),
		sourceInstanceId: suspCard.instanceId,
		card: suspCard.card,
		controllerId: owner.playerId,
		kind: 'spell',
		title: `${suspCard.card.name} (Suspended Cast)`,
		oracleText: suspCard.card.oracleText,
		targets: chosenTargets,
		xValue: 0,
		parsedEffects: parsed.effects,
		requiresGuidedResolution: false,
		createdAt: Date.now()
	};
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
	const suspendInfo = parseSuspendClause(inst.card);
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

function buildFallbackLibrarySearchSpec(eff: ParsedEffect, item: StackItem): LibrarySearchSpec {
	const parsedFromOracle = parseLibrarySearchSpec(item.oracleText || item.card.oracleText || '');
	if (parsedFromOracle) return parsedFromOracle;

	if (eff.kind === 'search_land_to_battlefield') {
		const isMyriad = item.card.name === 'Myriad Landscape';
		const count = Math.max(1, eff.amount || 1);
		const destinations: LibrarySearchDestination[] =
			count >= 2 && !isMyriad
				? [{ zone: 'battlefield', tapped: eff.tapped ?? true }, { zone: 'hand' }]
				: Array.from({ length: count }, () => ({
						zone: 'battlefield' as const,
						tapped: eff.tapped ?? true
					}));
		return {
			statedQuality: true,
			upTo: count > 1,
			count,
			requireBasic: true,
			allowedTypes: ['Land'],
			allowedSubtypes: [],
			disallowedTypes: [],
			destinations,
			rawCriteriaText: count > 1 ? 'up to two basic land cards' : 'a basic land card'
		};
	}

	return {
		statedQuality: false,
		upTo: false,
		count: Math.max(1, eff.amount || 1),
		allowedTypes: [],
		allowedSubtypes: [],
		disallowedTypes: [],
		destinations: [{ zone: 'hand' }],
		rawCriteriaText: 'a card'
	};
}

/**
 * Unified grammar-driven Library Search execution + `Opposition Agent` interception (CR 701.19).
 */
function initiateLibrarySearch(
	state: GameState,
	searchingPlayer: PlayerGameState,
	eff: ParsedEffect,
	item: StackItem
): void {
	const searchSpec = eff.searchSpec || buildFallbackLibrarySearchSpec(eff, item);
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
				const selfEntersTapped = cardEntersTapped(found.card);
				found.tapped = Boolean(dest.tapped) || selfEntersTapped;
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
		shuffleLibrary(searchingPlayer);
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
		shuffleLibrary(searchingPlayer);
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

	state.pendingPrompts.push({
		id: uid('prm'),
		playerId: decisionPlayer.playerId,
		targetLibraryOwnerId: searchingPlayer.playerId,
		kind: 'search_library',
		title: interceptor
			? `${interceptor.sourceName} — Search ${searchingPlayer.username}'s Library (${item.card.name})`
			: `Search Your Library (${item.card.name})`,
		description: interceptor
			? `You control ${searchingPlayer.username} while they search their library for ${searchSpec.rawCriteriaText}. Choose a matching card to exile (you may play it for as long as it remains exiled${interceptor.spendManaAsAnyColor ? ', spending mana as though it were mana of any color' : ''}).${canFailToFind ? ' Because the search states a card quality, you may also choose to Fail to Find.' : ' Because the search does not state a card quality, you MUST find a card (CR 701.19b).'}`
			: `Choose ${searchSpec.rawCriteriaText} from your library to put ${describeLibrarySearchDestination(firstDest)}${restDestinations.length > 0 ? ` (then ${restDestinations.length} more: ${restDestinations.map(describeLibrarySearchDestination).join(', ')})` : ''}, then shuffle.`,
		destinationZone: firstDest.zone,
		enterTapped: Boolean(firstDest.tapped),
		putOnTop: Boolean(firstDest.onTop),
		searchSpec,
		remainingDestinations: restDestinations,
		canFailToFind,
		interceptedBy: interceptor || undefined,
		candidateInstanceIds: matchingCards.map((c) => c.instanceId),
		stackItem: item
	});
}

function autoFetchBasicLandToBattlefield(
	state: GameState,
	player: PlayerGameState,
	tapped: boolean
): void {
	const idx = player.library.findIndex((c) => c.card.typeLine.includes('Basic Land'));
	if (idx >= 0) {
		const land = player.library[idx];
		land.tapped = tapped;
		moveObject(state, land, 'battlefield', {
			from: { player, zone: 'library' },
			toPlayer: player,
			controllerId: player.playerId,
			newTimestamp: true,
			bumpVersion: true
		});
		addLog(
			state,
			'rule',
			`${player.username} searched their library for ${land.card.name} and put it onto the battlefield${tapped ? ' tapped' : ''}.`,
			player.playerId
		);
		flushTriggers(state);
	}
}

export function createTokenOnBoard(
	state: GameState,
	controller: PlayerGameState,
	spec: NonNullable<ParsedEffect['tokenSpec']>
): CardInstance {
	const isTreasure = spec.name === 'Treasure';
	const tokenCard: ScryfallCard = {
		id: uid('tok_scry'),
		name: spec.name,
		manaCost: '',
		cmc: 0,
		typeLine: spec.typeLine,
		oracleText: isTreasure
			? '{T}, Sacrifice this artifact: Add one mana of any color.'
			: spec.keywords.join(', '),
		colors: spec.colors,
		colorIdentity: spec.colors,
		keywords: spec.keywords,
		power: isTreasure ? undefined : String(spec.power),
		toughness: isTreasure ? undefined : String(spec.toughness),
		imageUrl: `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(spec.name.replace(' Token', ''))}&format=image&version=normal`,
		artCropUrl: `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(spec.name.replace(' Token', ''))}&format=image&version=art_crop`,
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false
	};

	const inst = createCardInstance(
		tokenCard,
		controller.playerId,
		'battlefield',
		false,
		true,
		allocateTimestamp(state)
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

export function executeProliferate(state: GameState, controller: PlayerGameState): void {
	for (const perm of controller.battlefield) {
		if (perm.phasedOut) continue;
		if (perm.counters['+1/+1'] > 0) {
			addCountersToPermanent(state, perm, '+1/+1', 1);
		}
		if (perm.counters.loyalty > 0) {
			addCountersToPermanent(state, perm, 'loyalty', 1);
		}
		if (perm.counters.charge > 0) {
			addCountersToPermanent(state, perm, 'charge', 1);
		}
	}
	for (const opp of state.players) {
		if (opp.playerId !== controller.playerId && opp.poison > 0) {
			opp.poison += 1;
		}
	}
	emitVfx(state, {
		kind: 'proliferate',
		sourceId: controller.playerId,
		label: 'Proliferate!'
	});
}

export function advancePhaseOrStep(state: GameState): void {
	// Drain unspent mana pools at the end of each step/phase (CR 500.4)
	for (const p of state.players) {
		p.manaPool = createEmptyManaPool();
	}

	const activePlayer = state.players[state.activePlayerIndex];

	switch (state.phase) {
		case 'untap':
		case 'upkeep':
			if (activePlayer) {
				runDrawStepAndEnterMain1(state, activePlayer);
			} else {
				beginPhase(state, 'main1');
			}
			break;
		case 'draw':
			beginPhase(state, 'main1');
			break;

		case 'main1':
			beginPhase(state, 'declare_attackers');
			emitVfx(state, { kind: 'phase_change', label: 'Combat — Declare Attackers' });
			break;

		case 'begin_combat':
			beginPhase(state, 'declare_attackers');
			break;

		case 'declare_attackers':
			if (state.combat.active && state.combat.attackers.length > 0) {
				beginPhase(state, 'declare_blockers');
			} else {
				beginPhase(state, 'main2');
			}
			break;

		case 'declare_blockers': {
			// Check if any combatant has First strike or Double strike
			const hasFirstStrike = checkAnyCombatantHasFirstStrike(state);
			if (hasFirstStrike) {
				beginPhase(state, 'first_strike_damage');
				executeCombatDamageStep(state, true);
			} else {
				beginPhase(state, 'combat_damage');
				executeCombatDamageStep(state, false);
			}
			break;
		}

		case 'first_strike_damage':
			beginPhase(state, 'combat_damage');
			executeCombatDamageStep(state, false);
			break;

		case 'combat_damage':
			state.combat.active = false;
			state.combat.attackers = [];
			beginPhase(state, 'main2');
			emitVfx(state, { kind: 'phase_change', label: 'Postcombat Main Phase 2' });
			break;

		case 'end_combat':
			beginPhase(state, 'main2');
			break;

		case 'main2':
			enterEndStep(state, activePlayer);
			break;

		case 'end_step':
			runCleanupStep(state);
			break;

		case 'cleanup':
			completeTurnCleanupAndPassTurn(state);
			break;
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
	for (const atkEntry of state.combat.attackers) {
		const atkPlayer = state.players.find((p) => p.playerId === atkEntry.controllerId);
		const defPlayer = state.players.find((p) => p.playerId === atkEntry.defenderPlayerId);
		if (!atkPlayer || !defPlayer) continue;

		const attacker = atkPlayer.battlefield.find(
			(c) => !c.phasedOut && c.instanceId === atkEntry.attackerInstanceId
		);
		if (!attacker) continue;

		const atkHasFS = hasKeyword(attacker, 'First strike', state);
		const atkHasDS = hasKeyword(attacker, 'Double strike', state);
		const attackerDealsNow = isFirstStrikeStep
			? atkHasFS || atkHasDS
			: !atkHasFS || atkHasDS || !state.combat.damageDealtFirstStrike;

		const atkPower = getCreaturePower(attacker, state);
		const atkDeathtouch = hasKeyword(attacker, 'Deathtouch', state);
		const atkLifelink = hasKeyword(attacker, 'Lifelink', state);
		const atkTrample = hasKeyword(attacker, 'Trample', state);
		const atkInfect = hasKeyword(attacker, 'Infect', state);

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
					flushTriggers(state);
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

					flushTriggers(state);
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
					const bTough = getCreatureToughness(b, state);
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

				// Trample excess damage carries over to defending player!
				if (atkTrample && remainingDamage > 0) {
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

		// Blockers deal combat damage to Attacker
		if (!combatDamagePrevented) {
			for (const b of blockers) {
				const bHasFS = hasKeyword(b, 'First strike', state);
				const bHasDS = hasKeyword(b, 'Double strike', state);
				const blockerDealsNow = isFirstStrikeStep
					? bHasFS || bHasDS
					: !bHasFS || bHasDS || !state.combat.damageDealtFirstStrike;
				const bPower = getCreaturePower(b, state);
				const bInfect = hasKeyword(b, 'Infect', state);

				if (blockerDealsNow && bPower > 0) {
					if (bInfect) {
						attacker.counters['-1/-1'] = (attacker.counters['-1/-1'] || 0) + bPower;
					} else {
						attacker.damageMarked += bPower;
					}
					if (hasKeyword(b, 'Deathtouch', state)) {
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
					if (hasKeyword(b, 'Lifelink', state) && !defPlayer.lifeTotalCannotChangeThisTurn) {
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

	flushTriggers(state);
	checkStateBasedActions(state);
}

function runCleanupStep(state: GameState): void {
	beginPhase(state, 'cleanup');
	const activePlayer = state.players[state.activePlayerIndex];

	// Check if activePlayer has Reliquary Tower / Thought Vessel for unlimited hand size
	const hasNoMaxHandSize =
		state.rules.maxHandSize >= 99 ||
		activePlayer.battlefield.some(
			(c) =>
				!c.phasedOut &&
				!permanentHasLostAllAbilities(c, state).lost &&
				(c.card.name === 'Reliquary Tower' ||
					c.card.name === 'Thought Vessel' ||
					c.card.oracleText.toLowerCase().includes('no maximum hand size'))
		);

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
			completeTurnCleanupAndPassTurn(state);
		} else {
			state.pendingPrompts.push({
				id: uid('prm'),
				playerId: activePlayer.playerId,
				kind: 'discard_to_hand_size',
				title: `Discard Down to ${maxHand} Cards`,
				description: `Cleanup Step: Select ${excess} card(s) from your hand to discard.`,
				countRequired: excess
			});
		}
		return;
	}

	completeTurnCleanupAndPassTurn(state);
}

function completeTurnCleanupAndPassTurn(state: GameState): void {
	// Clear marked damage, temporary EOT buffs, and Layer 7d P/T switches on all permanents (CR 514.2)
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

	// CR 500.7: Check if there is a queued extra turn in LIFO order
	if (state.extraTurnQueue && state.extraTurnQueue.length > 0) {
		while (state.extraTurnQueue.length > 0) {
			const extraPlayerId = state.extraTurnQueue.pop()!;
			const extraIdx = state.players.findIndex((p) => p.playerId === extraPlayerId && !p.lost);
			if (extraIdx >= 0) {
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

	// Otherwise advance activePlayerIndex to next alive player in normal turn order
	const count = state.players.length;
	for (let step = 1; step <= count; step++) {
		const nextIdx = (state.activePlayerIndex + step) % count;
		if (!state.players[nextIdx].lost) {
			if (nextIdx <= state.activePlayerIndex) {
				state.turnNumber += 1;
			}
			state.activePlayerIndex = nextIdx;
			break;
		}
	}

	runBeginningOfTurn(state);
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

		for (const p of state.players) {
			// 1. +1/+1 and -1/-1 counter annihilation (CR 704.5q)
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

			// 2. Unattach Auras/Equipment attached to illegal/missing/non-creature permanents (CR 704.5m-n)
			const unattachedAurasToGraveyard: CardInstance[] = [];
			for (const perm of p.battlefield) {
				if (perm.phasedOut || !perm.attachedToId) continue;
				const targetFound = findPermanentOnBoard(state, perm.attachedToId);
				if (!targetFound) {
					perm.attachedToId = null;
					if (perm.card.typeLine.includes('Aura')) {
						unattachedAurasToGraveyard.push(perm);
					}
					anyActionTaken = true;
				} else if (
					perm.card.typeLine.includes('Equipment') &&
					!evaluatePermanent(state, targetFound.inst).typeLine.includes('Creature')
				) {
					perm.attachedToId = null;
					anyActionTaken = true;
				}
			}
			for (const aura of unattachedAurasToGraveyard) {
				movePermanentToZone(state, aura, 'graveyard');
			}

			// 3. Creature lethal damage / 0 toughness / Deathtouch SBA (CR 704.5f-h)
			const dyingPermanents: { perm: CardInstance; hadLostAbilities: boolean }[] = [];
			for (const perm of p.battlefield) {
				if (perm.phasedOut) continue;
				const evalPerm = evaluatePermanent(state, perm);
				if (evalPerm.typeLine.includes('Creature')) {
					const tough = evalPerm.toughness;
					if (tough <= 0) {
						dyingPermanents.push({ perm, hadLostAbilities: evalPerm.hasLostAllAbilities });
					} else if (
						(perm.damageMarked >= tough || perm.deathtouchDamageMarked) &&
						!evalPerm.keywords.some((k) => k.toLowerCase() === 'indestructible')
					) {
						dyingPermanents.push({ perm, hadLostAbilities: evalPerm.hasLostAllAbilities });
					}
				} else if (evalPerm.typeLine.includes('Planeswalker') && perm.counters.loyalty <= 0) {
					dyingPermanents.push({ perm, hadLostAbilities: evalPerm.hasLostAllAbilities });
				}
			}

			for (const { perm: dying, hadLostAbilities } of dyingPermanents) {
				anyActionTaken = true;
				emitVfx(state, { kind: 'destroy', targetId: dying.instanceId, label: dying.card.name });
				const actualDest = movePermanentToZone(state, dying, 'graveyard');
				addLog(
					state,
					'sba',
					`${dying.card.name} ${actualDest === 'exile' ? 'was exiled instead of dying (Rest in Peace)' : 'died'} (State-Based Action).`,
					p.playerId
				);
				// CR 700.4: "Dies" means "is put into a graveyard from the battlefield"; if Rest in Peace
				// exiled it instead, the ZoneChange goes to exile and dies triggers don't match.
				flushTriggers(state);
			}

			// 4. Legend Rule (CR 704.5j): Duplicate legendary permanents with the same name
			const legendaryByName = new Map<string, CardInstance[]>();
			for (const perm of p.battlefield) {
				if (perm.phasedOut) continue;
				const evalPerm = evaluatePermanent(state, perm);
				if (evalPerm.typeLine.includes('Legendary')) {
					const list = legendaryByName.get(perm.card.name) || [];
					list.push(perm);
					legendaryByName.set(perm.card.name, list);
				}
			}
			for (const [legName, list] of legendaryByName.entries()) {
				if (list.length > 1) {
					anyActionTaken = true;
					// Keep the newest copy and put earlier copies into graveyard (not destruction, so Indestructible doesn't prevent it)
					for (let i = 0; i < list.length - 1; i++) {
						movePermanentToZone(state, list[i], 'graveyard');
						addLog(
							state,
							'sba',
							`Legend Rule (CR 704.5j): Duplicate ${legName} was put into ${p.username}'s graveyard.`,
							p.playerId
						);
					}
				}
			}

			// 5. Token cleanup outside the battlefield (CR 704.5d)
			const prevGraveLen = p.graveyard.length;
			const prevExileLen = p.exile.length;
			const prevHandLen = p.hand.length;
			removeFromGame(p, 'graveyard', (c) => c.isToken);
			removeFromGame(p, 'exile', (c) => c.isToken);
			removeFromGame(p, 'hand', (c) => c.isToken);
			if (
				p.graveyard.length !== prevGraveLen ||
				p.exile.length !== prevExileLen ||
				p.hand.length !== prevHandLen
			) {
				anyActionTaken = true;
			}

			// 6. Commander Zone Change SBA (CR 903.9a)
			const commandersInGraveOrExile = [
				...p.graveyard.filter((c) => c.isCommander),
				...p.exile.filter((c) => c.isCommander)
			];
			for (const cmd of commandersInGraveOrExile) {
				if (p.isBot) {
					cmd.damageMarked = 0;
					cmd.deathtouchDamageMarked = false;
					cmd.tapped = false;
					moveObject(state, cmd, 'command', {
						from: { player: p, zone: p.graveyard.includes(cmd) ? 'graveyard' : 'exile' },
						toPlayer: p
					});
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
					state.pendingPrompts.push({
						id: uid('prm'),
						playerId: p.playerId,
						kind: 'commander_zone_choice',
						title: `Return ${cmd.card.name} to Command Zone?`,
						description: `${cmd.card.name} was put into your ${cmd.zone}. Under Commander Rule 903.9a, you may move it to the Command Zone.`,
						commanderInstanceId: cmd.instanceId,
						destinationZone: cmd.zone
					});
				}
			}

			// 7. Player Loss SBAs (CR 704.5a-c, CR 903.10a) — respects Platinum Angel!
			if (!p.lost && !playerCannotLoseGame(state, p).protected) {
				let newlyLost = false;
				if (p.life <= 0) {
					p.lost = true;
					newlyLost = true;
					p.lossReason = `Life total reached ${p.life}.`;
					addLog(state, 'sba', `${p.username} has ${p.life} life and loses the game!`, p.playerId);
				} else if (state.rules.poisonLethal > 0 && p.poison >= state.rules.poisonLethal) {
					p.lost = true;
					newlyLost = true;
					p.lossReason = `Accumulated ${p.poison} Poison counters.`;
					addLog(
						state,
						'sba',
						`${p.username} has ${p.poison} poison counters and loses the game!`,
						p.playerId
					);
				} else if (state.rules.commanderDamageLethal > 0) {
					for (const [cmdId, dmg] of Object.entries(p.commanderDamageTaken)) {
						if (dmg >= state.rules.commanderDamageLethal) {
							const cmdName = p.commanderNames[cmdId] || 'a Commander';
							p.lost = true;
							newlyLost = true;
							p.lossReason = `Dealt ${dmg} combat damage by ${cmdName}.`;
							addLog(
								state,
								'sba',
								`${p.username} took ${dmg} Commander combat damage from ${cmdName} and loses the game!`,
								p.playerId
							);
							break;
						}
					}
				}
				if (newlyLost) {
					anyActionTaken = true;
					cleanupEliminatedPlayer(state, p);
				}
			}
		}
	}

	// Check Win Condition (Last player standing)
	const remaining = state.players.filter((p) => !p.lost);
	if (remaining.length <= 1 && state.players.length > 1) {
		const winner = remaining[0];
		if (winner && !playerCannotWinGame(state, winner).blocked) {
			state.status = 'finished';
			state.winnerPlayerId = winner.playerId;
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

	// Also remove any cards on other players' battlefields or zones owned by the eliminated player (CR 800.4a)
	removeFromGame(eliminated, 'exile');
	removeFromGame(eliminated, 'hand');
	removeFromGame(eliminated, 'library');
	for (const other of state.players) {
		if (other.playerId === elimId) continue;
		removeFromGame(other, 'battlefield', (c) => c.ownerId === elimId);
		removeFromGame(other, 'exile', (c) => c.ownerId === elimId);
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
	const tLine = state ? evaluatePermanent(state, perm).typeLine : perm.card.typeLine;
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
					(targetPerm.copiableCard ?? targetPerm.card).oracleText.toLowerCase(),
					...(targetPerm.copiableCard ?? targetPerm.card).keywords.map((k) => k.toLowerCase())
				]),
		...targetPerm.grantedKeywords.map((k) => k.toLowerCase()),
		...evalTarget.activeKeywords.map((k) => k.toLowerCase())
	];

	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (!perm.phasedOut && perm.attachedToId === targetPerm.instanceId) {
				textsToCheck.push((perm.copiableCard ?? perm.card).oracleText.toLowerCase());
			}
		}
	}

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
	return targetPlayer.battlefield.some((perm) => {
		if (perm.phasedOut || permanentHasLostAllAbilities(perm, state).lost) return false;
		// "You have hexproof", "You and other creatures you control have hexproof", "You, planeswalkers you control, and ... have hexproof"
		return /(?:^|[.\n]\s*)you(?: have|(?:,| and)[^.\n]*? have) hexproof\b/i.test(
			(perm.copiableCard ?? perm.card).oracleText
		);
	});
}

export function playerHasShroud(state: GameState, targetPlayer: PlayerGameState): boolean {
	if (targetPlayer.protectionFromEverythingThisTurn) return true;
	return targetPlayer.battlefield.some((perm) => {
		if (perm.phasedOut || permanentHasLostAllAbilities(perm, state).lost) return false;
		return perm.card.oracleText.toLowerCase().includes('you have shroud');
	});
}

function normalizeTargetRequirement(
	reqOrKind: TargetRequirementInfo | TargetKind | string
): TargetRequirementInfo {
	if (typeof reqOrKind === 'object' && reqOrKind !== null && 'targetKind' in reqOrKind) {
		return reqOrKind;
	}
	const kind = (reqOrKind || 'none') as TargetKind;
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

export function validateTargetLegality(
	state: GameState,
	actorId: string,
	target: TargetRef,
	targetRequirementOrKind: TargetRequirementInfo | TargetKind | string,
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

export function getAllLegalTargetsForRequirement(
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
			if (validateTargetLegality(state, actorId, ref, info, sourceCard, sourceInstanceId).ok) {
				results.push(ref);
			}
		}
		return results;
	}

	if (info.zone === 'graveyard' || info.targetKind === 'graveyard_card') {
		for (const p of state.players) {
			for (const c of p.graveyard) {
				const ref: TargetRef = { kind: 'graveyard_card', id: c.instanceId, label: c.card.name };
				if (validateTargetLegality(state, actorId, ref, info, sourceCard, sourceInstanceId).ok) {
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
			if (validateTargetLegality(state, actorId, ref, info, sourceCard, sourceInstanceId).ok) {
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
				if (validateTargetLegality(state, actorId, ref, info, sourceCard, sourceInstanceId).ok) {
					results.push(ref);
				}
			}
		}
	}

	return results;
}

export function hasRequiredLegalTargets(
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

export function checkLandPlayLegality(
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
	if (actor.landsPlayedThisTurn >= actor.maxLandsPerTurn) {
		return {
			ok: false,
			error: `You have already played your maximum of ${actor.maxLandsPerTurn} land(s) this turn.`
		};
	}
	return { ok: true };
}

export function checkSpellCastLegality(
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

	// Check oracle timing restrictions & additional costs
	const addCosts = parseAdditionalCostsAndRestrictions(inst.card.oracleText);
	if (addCosts.onlyDuringYourTurn && activePlayer?.playerId !== actorId) {
		return {
			ok: false,
			error: `Illegal Cast: ${inst.card.name} can only be cast during your turn.`
		};
	}
	if (addCosts.onlyDuringCombat) {
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
	if (addCosts.onlyBeforeAttackersDeclared) {
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
	const parsed = parseSpellOrAbilityEffects(inst.card);
	const targetCheck = hasRequiredLegalTargets(
		state,
		actorId,
		parsed.targetInfo,
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

export function checkAbilityActivationLegality(
	state: GameState,
	actorId: string,
	perm: CardInstance,
	ab: ParsedActivatedAbility
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
	const evaluatedNode = evaluateActionNode(state, actorId, perm, ab.id);
	const abilityMana = evaluatedNode
		? evaluatedNode.effectiveCostRequirement
		: parseManaCost(ab.manaCost === '{0}' ? '' : ab.manaCost);
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
		const abTargetInfo: TargetRequirementInfo =
			evaluatedNode?.targetLegality.targetInfo ??
			(ab.targetKind === 'controlled_creature'
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
				: detectTargetRequirement(ab.effectText));

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

function isTargetStillValid(
	state: GameState,
	target: TargetRef,
	controllerId?: string,
	sourceCard?: ScryfallCard
): boolean {
	if (target.kind === 'player') {
		const p = state.players.find((pl) => pl.playerId === target.id && !pl.lost);
		if (!p) return false;
		if (playerHasShroud(state, p)) return false;
		if (controllerId && playerHasHexproofFrom(state, p, controllerId)) return false;
		return true;
	}
	if (target.kind === 'stack') {
		return state.stack.some((s) => s.id === target.id || s.sourceInstanceId === target.id);
	}
	if (target.kind === 'graveyard_card') {
		return state.players.some((p) => p.graveyard.some((c) => c.instanceId === target.id));
	}
	const found = findPermanentOnBoard(state, target.id);
	if (!found) return false;
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
					pr.kind === 'search_library' &&
					(pr.targetLibraryOwnerId || pr.playerId) === p.playerId
			);
		const scryPrompt =
			p.playerId === viewerId
				? clone.pendingPrompts.find(
						(pr) => pr.playerId === viewerId && pr.kind === 'scry_choice'
					)
				: undefined;
		if (scryPrompt && scryPrompt.candidateInstanceIds) {
			p.library = p.library.filter((c) =>
				scryPrompt.candidateInstanceIds!.includes(c.instanceId)
			);
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
