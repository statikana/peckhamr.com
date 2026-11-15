import {
	buildTokenScryfallCard,
	canPayManaCost,
	createEmptyManaPool,
	describeLibrarySearchDestination,
	matchesLibrarySearchSpec,
	parseLibrarySearchSpec,
	parseManaCost,
	withDelayedTriggerSpec,
	withStackItemText,
	type ManaCostRequirement
} from './oracle.ts';
import {
	addManaToPlayerPool,
	canSpendRestrictedMana,
	combinedManaPoolForSpend,
	deductManaForSpendContext,
	getTotalPooledManaForContext
} from './runtime/mana.ts';
import {
	checkGlobalCastPermissionsAndRestrictions,
	evaluatePermanent,
	getCardActivatedAbilities,
	getEffectiveActivatedAbilities as getEffectiveActivatedAbilitiesRaw,
	getLibrarySearchInterceptor,
	getSpellTargetRequirement,
	inspectCardContinuousBreakdown,
	modalTargetRequirement,
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
	checkGlobalAbilityActivationRestrictions,
	counterMultiplier,
	getAttackTaxGeneric,
	getAttackTaxSources,
	hasRestriction,
	matchesPlayerFilter,
	playerHasHexproofFrom as replacePlayerHasHexproofFrom,
	playerHasNoMaxHandSize,
	playerHasShroud as replacePlayerHasShroud,
	playerLifeTotalCantChange,
	registerCounterPlacement,
	replaceEmptyLibraryDraw,
	resolveCounterReplacements,
	spellCannotBeCountered,
	tokenMultiplier
} from './runtime/replace.ts';
// --- Track P8 ---
import {
	applyCopiedPermanentToInstance,
	findLegalCloneCandidates,
	findSelfCloneReplacementSpec,
	getActiveTopOfLibrarySpellPermissionSource,
	getActiveZoneLandPlayPermissionSource,
	getGlobalAttackCapError,
	getPlayerTopOfLibraryVisibility,
	getStaticAttackRestrictionReason,
	getStaticBlockerPairRestrictionReason,
	permanentCantAttackAlone,
	validateAndSolveDefenderBlockersP8
} from './runtime/staticsLayersAndRestrictions.ts';
import {
	allocateTimestamp,
	attachObject,
	createEmptyCounters,
	mulliganRedraw,
	moveObject,
	placeDeferred,
	rearrangeLibrary,
	removeFromGame,
	returnLinkedExiledForSource,
	returnLinkedExiledForSources,
	setZoneOrder,
	shuffleArray,
	shuffleLibrary,
	syncBattlefieldControllers,
	tapPermanent,
	transferBattlefieldControl,
	type MoveResult,
	type SbaMoveLog
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
	alternativeCostMetaById,
	applyCastCostAids,
	canPayCosts,
	chooseCostPayment,
	computeKickerTracking,
	describeCost,
	effectiveAbilityManaCost,
	effectiveSpellManaCost,
	executeCostPaymentParts,
	expandOptionalAdditionalCosts,
	formatManaRequirement,
	getObjectKickerInfo,
	getSuspendSpec,
	hasReturnToHandOptionalCost,
	isCastConditionMet,
	isObjectEscaped,
	isObjectEvoked,
	keywordAltCost,
	keywordCost,
	keywordsOf,
	manaAbilityAmount,
	payPlannedCosts,
	payTapAndManaCostParts,
	planCosts,
	serializeCostPlanParts,
	spellAdditionalCost,
	spellCastRestrictions,
	spellChoosesX,
	spellOptionalAdditionalCosts,
	validateOptionalCostCounts,
	type CostContext,
	type CostQuestion
} from './runtime/costs.ts';
import {
	hasChooseAllModesOptionalCost,
	isConditionMetWithKicker,
	isObjectBlitzed,
	isObjectForetold
} from './runtime/kicker.ts';
import {
	buildBlitzSacrificeDelayedTrigger,
	buildTrackP3CastOptions,
	enumerateHandSpecialActions,
	hasExileKeywordPermission
} from './runtime/orthogonalKeywords.ts';
import {
	buildTrackP6CastOptions,
	buildWarpExileDelayedTrigger
} from './runtime/striatedFrames.ts';
export { applyCastCostAids, formatManaRequirement, getSuspendSpec };
import { getKeywordSpec } from './keywords.ts';
import {
	evaluateAmount,
	evaluateCondition,
	matchesObjectFilter,
	objectManaValue,
	type FilterContext
} from './runtime/objectFilter.ts';
import {
	FIVE_MANA_COLORS,
	applyNextUntapFreeze,
	computeLibraryInsertIndex,
	consumeNextUntapFreeze,
	expandCombinationBundles,
	formatManaBundle,
	pickBestBundleForRequirement,
	pickCombinationForRequirement,
	scoreBundleForRequirement
} from './runtime/tuckFreezeChosen.ts';
import {
	compileCard,
	compiledStackItemEffects,
	compiledTriggerEffect,
	compileSpellEffects,
	describeModalModes,
	expandModalEffects,
	getAbilityModal,
	resolveCompiledDelayedSteps
} from './compiler/index.ts';
import {
	activeFaceIndexForObject,
	effectiveCardForObject,
	getCardFaces,
	scrubFaceDownCard,
	scrubFaceDownStackItem
} from './scryfall.ts';
import {
	activeAbilityDefs,
	activeCharacteristics,
	effectiveManaValue,
	instanceFaceOptions,
	matchesColorFilter,
	resolveObjectFaces,
	stackItemFaceOptions
} from './runtime/faces.ts';
import { parseCost } from './compiler/costs.ts';
import { runtimeTriggers } from './compiler/triggers.ts';
import { buildBoardSnapshot, noteLayerInputsChanged, withStableLayerInputs } from './runtime/layerCache.ts';
import {
	flushInlineTriggers,
	flushTriggers,
	matchTriggers,
	peekPendingTriggers,
	registerTriggerHost,
	stackTriggerConditionHolds,
	withTriggersDeferred,
	type PendingTrigger
} from './runtime/triggers.ts';
import {
	applyLifelinkGain,
	dealDamageToPermanent,
	dealDamageToPlayer,
	executeEffectSteps,
	gainPlayerLife,
	interpretableNow,
	optionalPrefix,
	registerEffectPorts,
	sourceDamageInfo,
	staticallyInterpretable,
	type PayOptionalCostResult,
	type SourceDamageInfo,
	type StackItemRetargetSlot
} from './runtime/effects.ts';
import { chooseBotModalTriggerModes, chooseBotTriggerTargets } from './ai.ts';
import type { CostDef, EffectStep, ModalDef, TargetSpec, TokenSpec } from './ir.ts';
import { deriveIdSalt, freshRngSeed, hash32, uid, type RngHolder, type UidHolder } from './runtime/random.ts';
import { cardAbilityDisplayText, enteringNotices, stackItemDisplayText } from './compiler/support.ts';
import {
	buildCostChoiceRequest,
	effectivePromptChoice,
	effectivePromptPurpose,
	inferObjectsZone,
	normalizePromptAction,
	enqueueChoicePrompt,
	pickScryOrSurveilSplit,
	registerPromptHandler,
	runPromptHandler,
	validateChoiceAnswer
} from './runtime/choices.ts';

export { allocateTimestamp, shuffleArray };
import {
	ENGINE_VERSION,
	PHASE_LABELS,
	type CardInstance,
	type CastCostAid,
	type CastOption,
	type ChoiceAnswer,
	type ChoiceRequest,
	type CompiledDelayedEffect,
	type CopiableState,
	type CostPayment,
	type CounterType,
	type DelayedTrigger,
	type DelayedTriggerEffect,
	type EffectiveActivatedAbility,
	type EffectBindingSnapshot,
	type EffectResumeFrame,
	type GameActionPayload,
	type GameLogEntry,
	type GamePhase,
	type GameState,
	type GuidedOperation,
	type HandSpecialActionOption,
	type LandPlayOption,
	type LibrarySearchDestination,
	type LibrarySearchSpec,
	type LobbyRulesConfig,
	type LobbySeat,
	type MagicDeck,
	type MagicLobby,
	type ManaColor,
	type ManaPool,
	type ManaRider,
	type ManaSpendContext,
	type PendingCostPayment,
	type PendingPrompt,
	type PlayerGameState,
	type ProcedureContinuation,
	type PromptPurpose,
	type ScryfallCard,
	type SerializedBoundRef,
	type SerializedPlannedCost,
	type FaceDownSpec,
	type SpellModifications,
	type StackItem,
	type TriggerEventLki,
	type TargetRef,
	type TargetRequirementInfo,
	type VfxEvent,
	type ZoneType
} from './types.ts';

export { ENGINE_VERSION };

/**
 * Timestamp for instances created without an explicit one. The engine always passes one
 * (createInitialGameState numbers its cards per game; everything else uses allocateTimestamp), so
 * this process-wide counter only serves external callers such as tests, like uid's fallback counter.
 */
let globalInstanceTimestampSeed = 1;

export function createCardInstance(
	card: ScryfallCard,
	ownerId: string,
	zone: ZoneType,
	isCommander = false,
	isToken = false,
	enteredTimestamp?: number,
	uidHolder?: UidHolder
): CardInstance {
	const counters = createEmptyCounters();
	if (card.loyalty && zone === 'battlefield') {
		counters.loyalty = parseInt(card.loyalty, 10) || 3;
	}
	if (enteredTimestamp === undefined) globalInstanceTimestampSeed += 1;
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
	const initialSeed = freshRngSeed();
	const rng: RngHolder = { rngState: initialSeed };
	const idSalt = deriveIdSalt(initialSeed);
	const uidHolder: UidHolder = { nextUid: 0, idSalt };
	// Starting cards are numbered per game so a new game never depends on what the process created
	// before it. They are all off the battlefield, and every battlefield entry takes a fresh
	// allocateTimestamp, so these values never order layer effects.
	let initialTimestamp = 1;

	const players: PlayerGameState[] = activeSeats.map((seat, idx) => {
		const playerId = seat.userId || `bot_${seat.seatIndex}`;
		const deck = decksBySeat.get(seat.seatIndex)!;

		const command: CardInstance[] = deck.commanders.map((c) =>
			createCardInstance(c, playerId, 'command', true, false, ++initialTimestamp, uidHolder)
		);
		const commanderColorIdentity = Array.from(
			new Set(deck.commanders.flatMap((c) => c.colorIdentity))
		);

		const rawLibrary: CardInstance[] = [];
		for (const entry of deck.cards) {
			for (let q = 0; q < entry.quantity; q++) {
				rawLibrary.push(
					createCardInstance(entry.card, playerId, 'library', false, false, ++initialTimestamp, uidHolder)
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
			restrictedMana: {},
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
			stopPhases: [],
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
		turnSerial: 1,
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
		idSalt,
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
		for (const p of state.players) {
			const pregameBattlefieldCards = p.hand.filter((c) => {
				const abilities = activeAbilityDefs(effectiveCardForObject(c));
				return abilities.some(
					(a) => a.kind === 'static' && a.static.k === 'pregameAction' && a.static.action === 'beginOnBattlefield'
				);
			});
			for (const inst of pregameBattlefieldCards) {
				inst.defaultControllerId = p.playerId;
				inst.controllerId = p.playerId;
				moveObject(state, inst, 'battlefield', {
					from: { player: p, zone: 'hand' },
					toPlayer: p,
					controllerId: p.playerId,
					newTimestamp: true,
					bumpVersion: true
				});
				addLog(
					state,
					'rule',
					`${p.username} began the game with ${inst.card.name} on the battlefield (CR 103.6a).`,
					p.playerId
				);
			}
		}
		state.status = 'active';
		state.turnNumber = 1;
		state.turnSerial = 1;
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

type CastableSourceZone = 'hand' | 'command' | 'exile' | 'graveyard' | 'library';

function optionTargetsBecomeEach(
	sourceCard: ScryfallCard | undefined,
	optionOrId?: CastOption | string
): boolean {
	if (!optionOrId) return false;
	if (typeof optionOrId !== 'string') return Boolean(optionOrId.spellMods.targetsBecomeEach);
	if (!sourceCard) return false;
	const found = alternativeCostMetaById(optionOrId);
	if (!found || !found.meta.targetsBecomeEach) return false;
	return keywordAltCost(sourceCard, found.keyword) !== null;
}

const SUPPORTED_MULTIFACE_LAYOUTS = new Set(['split', 'modal_dfc', 'adventure']);

function cardHasSupportedMultiFace(card: ScryfallCard): boolean {
	const layout =
		card.layout ?? (card.backFace ? 'transform' : card.faces && card.faces.length >= 2 ? 'split' : 'normal');
	return Boolean(card.faces && card.faces.length >= 2 && SUPPORTED_MULTIFACE_LAYOUTS.has(layout));
}

function buildCastPaymentAids(
	state: GameState,
	actor: PlayerGameState | undefined,
	inst: CardInstance,
	fromZone: CastableSourceZone,
	faceIndex: number,
	fused: boolean,
	isFaceDown: boolean
): CastCostAid[] | undefined {
	if (!actor || isFaceDown) return undefined;
	const effectiveCard = effectiveCardForObject(inst);
	const abilities = activeAbilityDefs(effectiveCard, { zone: 'stack', faceIndex, fused });
	const hasKw = (kw: string): boolean =>
		abilities.some((a) => a.kind === 'keyword' && a.keyword.name === kw) ||
		Boolean(inst.grantedKeywords?.some((k) => k.toLowerCase() === kw));

	const aids: CastCostAid[] = [];
	if (hasKw('convoke')) {
		const candidateIds: string[] = [];
		const colorsByCandidate: Record<string, ManaColor[]> = {};
		for (const perm of actor.battlefield) {
			if (perm.tapped || perm.phasedOut) continue;
			const ev = evaluatePermanent(state, perm);
			if (!ev.isCreature) continue;
			candidateIds.push(perm.instanceId);
			colorsByCandidate[perm.instanceId] = [...ev.colors];
		}
		if (candidateIds.length > 0) {
			aids.push({
				id: 'aid:convoke',
				label: 'Convoke — Tap creatures to pay mana',
				kind: 'tapPermanent',
				candidateIds,
				colorsByCandidate,
				paysGeneric: 1
			});
		}
	}
	if (hasKw('delve')) {
		const candidateIds = actor.graveyard
			.filter((c) => !(fromZone === 'graveyard' && c.instanceId === inst.instanceId))
			.map((c) => c.instanceId);
		if (candidateIds.length > 0) {
			aids.push({
				id: 'aid:delve',
				label: 'Delve — Exile graveyard cards for generic mana',
				kind: 'exileCard',
				candidateIds,
				paysGeneric: 1
			});
		}
	}
	return aids.length > 0 ? aids : undefined;
}

function enumerateCandidateCastOptions(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: CastableSourceZone
): CastOption[] {
	const card = inst.copiableCard ?? inst.card;
	if (fromZone === 'graveyard' && inst.ownerId !== actorId) {
		return [];
	}

	const def = compileCard(card);
	const layout =
		card.layout ?? (card.backFace ? 'transform' : card.faces && card.faces.length >= 2 ? 'split' : 'normal');
	const isMultiFace = cardHasSupportedMultiFace(card);
	const exileAllowed = fromZone === 'exile' ? inst.playableFromExileBy?.allowedFaceIndices : undefined;
	const hasFaceDownKw = (fi: number) =>
		Object.keys(ALTERNATIVE_COST_KEYWORDS).some(
			(kw) => Boolean(ALTERNATIVE_COST_KEYWORDS[kw]?.faceDown) && keywordAltCost(card, kw, fi) !== null
		);

	const candidateFaceIndices: number[] = isMultiFace
		? def.faces
				.map((_, fi) => fi)
				.filter((fi) => {
					const types = def.faces[fi]?.characteristics.types ?? [];
					const isLandOnly = types.includes('Land') && !types.includes('Creature');
					if (isLandOnly && !(fi === 0 && hasFaceDownKw(fi))) return false;
					if (exileAllowed && !exileAllowed.includes(fi)) return false;
					return true;
				})
		: (() => {
				const types = def.faces[0]?.characteristics.types ?? [];
				const isLandOnly = types.includes('Land') && !types.includes('Creature');
				if (isLandOnly && !hasFaceDownKw(0)) return [];
				if (exileAllowed && !exileAllowed.includes(0)) return [];
				return [0];
			})();

	if (candidateFaceIndices.length === 0) {
		return [];
	}

	const actor = state.players.find((p) => p.playerId === actorId);
	const castCount =
		inst.isCommander && fromZone === 'command' && actor
			? (actor.commanderCastCounts?.[inst.instanceId] ?? inst.commanderCastCount ?? 0)
			: 0;
	const taxSuffix = castCount > 0 ? ` + {${castCount * state.rules.commanderTaxIncrement}}` : '';

	const options: CastOption[] = [];

	for (const fi of candidateFaceIndices) {
		const faceDef = def.faces[fi];
		if (!faceDef) continue;
		const faceChars = faceDef.characteristics;
		const faceTypes = faceChars.types;
		const faceManaCost = faceChars.manaCost;
		const faceName = faceDef.name;
		const isAdventureFace = isMultiFace && layout === 'adventure' && fi === 1;
		const faceIndexProp = isMultiFace ? { faceIndex: fi } : {};
		const idFor = (baseId: string) => (fi === 0 ? baseId : `face:${fi}:${baseId}`);

		const additional = spellAdditionalCost(card, fi, false);
		const mandatoryAdditionalCosts =
			additional && additional.defs.length > 0 ? additional.defs : undefined;
		const optionalAdditionalCosts = spellOptionalAdditionalCosts(card, fi, false);
		const optionalProp =
			optionalAdditionalCosts.length > 0 ? { optionalAdditionalCosts } : {};
		const facePaymentAids = buildCastPaymentAids(state, actor, inst, fromZone, fi, false, false);
		const paymentAidsProp = facePaymentAids ? { paymentAids: facePaymentAids } : {};
		const targetInfo = getSpellTargetRequirement(card, { faceIndex: fi } as CastOption);
		const adventureMods: Partial<SpellModifications> = isAdventureFace
			? { exileAdventureOnResolve: true }
			: {};

		let hasZonePermission = false;
		const isLandOnlyFace = faceTypes.includes('Land') && !faceTypes.includes('Creature');

		if (fromZone === 'hand' || fromZone === 'command') {
			hasZonePermission = true;
			if (!isLandOnlyFace) {
				const baseCost: CastOption['baseCost'] = { kind: 'printed' };
				const label = isAdventureFace
					? `Cast Adventure: ${faceName}`
					: isMultiFace
						? `Cast ${faceName}`
						: 'Cast Normally';
				options.push({
					id: idFor('normal'),
					label,
					costDisplay: `${faceManaCost || '{0}'}${taxSuffix}`,
					fromZone,
					permission: 'zone_default',
					...faceIndexProp,
					baseCost,
					...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
					...optionalProp,
					...paymentAidsProp,
					timing: 'default',
					spellMods: { ...adventureMods },
					choosesX: spellChoosesX(card, baseCost, undefined, fi, false),
					requiresTarget: targetInfo.requiresTarget
				});
			}
		} else if (fromZone === 'exile') {
			if (inst.castViaSuspend && fi === 0 && !isLandOnlyFace) {
				const baseCost: CastOption['baseCost'] = { kind: 'free' };
				options.push({
					id: 'exile:suspend',
					label: 'Cast via Suspend',
					costDisplay: '{0}',
					fromZone: 'exile',
					permission: 'exile_permission',
					...faceIndexProp,
					baseCost,
					...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
					...optionalProp,
					...paymentAidsProp,
					timing: 'default',
					spellMods: {},
					choosesX: spellChoosesX(card, baseCost, undefined, fi, false),
					requiresTarget: targetInfo.requiresTarget
				});
			} else if (inst.playableFromExileBy?.playerId === actorId) {
				hasZonePermission = true;
				if (!isLandOnlyFace) {
					const freeExile = Boolean(inst.playableFromExileBy.withoutPayingManaCost);
					const baseCost: CastOption['baseCost'] = freeExile ? { kind: 'free' } : { kind: 'printed' };
					const src = inst.playableFromExileBy.sourceName;
					const freeSuffix = freeExile ? ' — Free' : '';
					const label = isAdventureFace
						? src
							? `Cast Adventure: ${faceName} from Exile${freeSuffix} (${src})`
							: `Cast Adventure: ${faceName} from Exile${freeSuffix}`
						: isMultiFace
							? src
								? `Cast ${faceName} from Exile${freeSuffix} (${src})`
								: `Cast ${faceName} from Exile${freeSuffix}`
							: src
								? `Cast from Exile${freeSuffix} (${src})`
								: `Cast from Exile${freeSuffix}`;
					options.push({
						id: idFor('exile:permission'),
						label,
						costDisplay: `${freeExile ? '{0}' : faceManaCost || '{0}'}${taxSuffix}`,
						fromZone: 'exile',
						permission: 'exile_permission',
						...faceIndexProp,
						baseCost,
						...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
						...optionalProp,
						...paymentAidsProp,
						timing: 'default',
						spellMods: { ...adventureMods },
						choosesX: spellChoosesX(card, baseCost, undefined, fi, false),
						requiresTarget: targetInfo.requiresTarget
					});
				}
			}
		// --- Track P8 ---
		} else if (fromZone === 'library') {
			if (actor?.library[0]?.instanceId === inst.instanceId) {
				const srcName = getActiveTopOfLibrarySpellPermissionSource(
					state,
					actorId,
					inst,
					fi,
					false
				);
				if (srcName !== null && !isLandOnlyFace) {
					hasZonePermission = true;
					const baseCost: CastOption['baseCost'] = { kind: 'printed' };
					const label = isAdventureFace
						? `Cast Adventure: ${faceName} from Library (${srcName})`
						: isMultiFace
							? `Cast ${faceName} from Library (${srcName})`
							: `Cast from Top of Library (${srcName})`;
					options.push({
						id: idFor('library:top'),
						label,
						costDisplay: `${faceManaCost || '{0}'}${taxSuffix}`,
						fromZone: 'library',
						permission: 'library_top_permission',
						...faceIndexProp,
						baseCost,
						...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
						...optionalProp,
						...paymentAidsProp,
						timing: 'default',
						spellMods: { ...adventureMods },
						choosesX: spellChoosesX(card, baseCost, undefined, fi, false),
						requiresTarget: targetInfo.requiresTarget
					});
				}
			}
		}

		if (
			!inst.castViaSuspend &&
			!(fromZone === 'exile' && inst.playableFromExileBy?.withoutPayingManaCost)
		) {
			for (const [kwName, meta] of Object.entries(ALTERNATIVE_COST_KEYWORDS)) {
				if (meta.castTransformedBackFace) continue;
				const altCost = keywordAltCost(card, kwName, fi);
				if (!altCost) continue;
				if (!(meta.zones as readonly string[]).includes(fromZone)) continue;
				if (meta.requiresZonePermission && !hasZonePermission) continue;
				if (meta.faceDown) {
					if (isMultiFace && layout !== 'modal_dfc' && fi > 0) continue;
					const baseCost: CastOption['baseCost'] = {
						kind: 'alternative',
						manaCost: meta.faceDown.castManaCost
					};
					const turnUpSummary = describeTurnUpCost(altCost.manaCost, altCost.costDefs);
					const faceDownSpec: FaceDownSpec = {
						kind: meta.faceDown.kind,
						castManaCost: meta.faceDown.castManaCost,
						...(meta.faceDown.wardCost ? { wardCost: meta.faceDown.wardCost } : {}),
						...(altCost.manaCost !== undefined ? { turnUpManaCost: altCost.manaCost } : {}),
						...(altCost.costDefs.length > 0 ? { turnUpCostDefs: altCost.costDefs } : {}),
						...(turnUpSummary ? { turnUpCost: turnUpSummary } : {})
					};
					const spellMods: SpellModifications = {
						castFaceDown: faceDownSpec,
						...(meta.castSummarySuffix ? { castSummarySuffix: meta.castSummarySuffix } : {}),
						...(meta.stackBadgeLabel ? { label: meta.stackBadgeLabel } : {})
					};
					options.push({
						id: idFor(meta.id),
						label: meta.label,
						costDisplay: `${meta.faceDown.castManaCost}${taxSuffix}`,
						fromZone,
						permission: fromZone === 'exile' ? 'exile_permission' : 'zone_default',
						...faceIndexProp,
						baseCost,
						timing: meta.timing ?? 'default',
						spellMods,
						choosesX: false,
						requiresTarget: false
					});
					continue;
				}
				if (isLandOnlyFace) continue;
				if (meta.disallowLand && faceTypes.includes('Land')) continue;
				if (meta.spellTypes && meta.spellTypes.length > 0) {
					if (!meta.spellTypes.some((t) => faceTypes.includes(t))) continue;
				}
				const baseCost: CastOption['baseCost'] = {
					kind: 'alternative',
					...(altCost.manaCost !== undefined ? { manaCost: altCost.manaCost } : {}),
					...(altCost.costDefs.length > 0 ? { costDefs: altCost.costDefs } : {})
				};
				const spellMods: SpellModifications = {
					...adventureMods,
					...(meta.targetsBecomeEach ? { targetsBecomeEach: true } : {}),
					...(meta.exileOnLeaveStack ? { exileOnLeaveStack: true } : {}),
					...(meta.evoked ? { evoked: true } : {}),
					...(meta.escaped ? { escaped: true } : {}),
					...(meta.blitzed ? { blitzed: true } : {}),
					...(meta.warped ? { warped: true } : {}),
					...(meta.castSummarySuffix ? { castSummarySuffix: meta.castSummarySuffix } : {}),
					...(meta.stackBadgeLabel ? { label: meta.stackBadgeLabel } : {})
				};
				options.push({
					id: idFor(meta.id),
					label: isMultiFace ? `${meta.label} (${faceName})` : meta.label,
					costDisplay: `${altCost.display}${taxSuffix}`,
					fromZone,
					permission: 'keyword_alt',
					...faceIndexProp,
					baseCost,
					...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
					...optionalProp,
					...paymentAidsProp,
					timing: meta.timing ?? 'default',
					spellMods,
					choosesX: spellChoosesX(card, baseCost, undefined, fi, false),
					requiresTarget: meta.targetsBecomeEach ? false : targetInfo.requiresTarget
				});
			}
		}
	}

	if (fromZone !== 'library') {
		options.push(
			...buildTrackP3CastOptions({
				state,
				actorId,
				inst,
				card,
				def,
				fromZone,
				taxSuffix,
				keywordAltCost,
				spellAdditionalCost,
				spellOptionalAdditionalCosts,
				buildPaymentAids: (zone, faceIdx, isFused, isFree) =>
					buildCastPaymentAids(state, actor, inst, zone, faceIdx, isFused, isFree),
				getSpellTargetRequirement,
				spellChoosesX
			}),
			...buildTrackP6CastOptions({
				state,
				actorId,
				inst,
				card,
				def,
				fromZone,
				isMultiFace,
				layout,
				candidateFaceIndices,
				taxSuffix,
				spellAdditionalCost,
				spellOptionalAdditionalCosts,
				buildPaymentAids: (zone, faceIdx, isFused, isFree) =>
					buildCastPaymentAids(state, actor, inst, zone, faceIdx, isFused, isFree),
				getSpellTargetRequirement,
				spellChoosesX
			})
		);
	}

	// CR 702.102: Split card with Fuse cast from hand as both halves (left then right).
	if (
		isMultiFace &&
		layout === 'split' &&
		fromZone === 'hand' &&
		!inst.castViaSuspend &&
		def.faces.length >= 2 &&
		!def.faces[0].characteristics.types.includes('Land') &&
		!def.faces[1].characteristics.types.includes('Land')
	) {
		const hasFuse = def.faces.some((f) =>
			f.abilities.some((a) => {
				if (a.kind !== 'keyword') return false;
				const { name: kwName } = a.keyword;
				return kwName === 'fuse';
			})
		);
		if (hasFuse) {
			const baseCost: CastOption['baseCost'] = { kind: 'printed' };
			const combinedMana = `${def.faces[0].characteristics.manaCost || ''}${def.faces[1].characteristics.manaCost || ''}`;
			const fusedAdditional = spellAdditionalCost(card, 0, true);
			const fusedOptional = spellOptionalAdditionalCosts(card, 0, true);
			const fusedPaymentAids = buildCastPaymentAids(state, actor, inst, 'hand', 0, true, false);
			const fusedTargetInfo = getSpellTargetRequirement(card, {
				faceIndex: 0,
				fused: true
			} as CastOption);
			options.push({
				id: 'fuse',
				label: `Fuse: ${def.faces[0].name} // ${def.faces[1].name}`,
				costDisplay: `${combinedMana || '{0}'}${taxSuffix}`,
				fromZone: 'hand',
				permission: 'zone_default',
				faceIndex: 0,
				fused: true,
				baseCost,
				...(fusedAdditional && fusedAdditional.defs.length > 0
					? { mandatoryAdditionalCosts: fusedAdditional.defs }
					: {}),
				...(fusedOptional.length > 0 ? { optionalAdditionalCosts: fusedOptional } : {}),
				...(fusedPaymentAids ? { paymentAids: fusedPaymentAids } : {}),
				timing: 'default',
				spellMods: { castSummarySuffix: ' (Fused)', label: 'Fused' },
				choosesX: spellChoosesX(card, baseCost, undefined, 0, true),
				requiresTarget: fusedTargetInfo.requiresTarget
			});
		}
	}

	return options;
}

function resolveCastOptionForAction(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: ZoneType,
	optionId?: string,
	faceIndex?: number,
	fused?: boolean
): { ok: true; option: CastOption } | { ok: false; error: string } {
	const card = inst.copiableCard ?? inst.card;
	const def = compileCard(card);
	const allLandFaces =
		def.faces.length > 0 &&
		def.faces.every(
			(f) => f.characteristics.types.includes('Land') && !f.characteristics.types.includes('Creature')
		);
	if (
		fromZone !== 'hand' &&
		fromZone !== 'command' &&
		fromZone !== 'exile' &&
		fromZone !== 'graveyard' &&
		fromZone !== 'library'
	) {
		return { ok: false, error: 'Spells can only be cast from your Hand, Command Zone, or Exile.' };
	}
	if (
		fromZone === 'exile' &&
		inst.playableFromExileBy?.playerId !== actorId &&
		!inst.castViaSuspend &&
		!hasExileKeywordPermission(inst, actorId)
	) {
		return {
			ok: false,
			error: `You do not have permission to cast ${inst.card.name} from Exile.`
		};
	}

	const candidates = enumerateCandidateCastOptions(state, actorId, inst, fromZone);

	if (optionId !== undefined) {
		const match = candidates.find((o) => o.id === optionId);
		if (match) {
			if (allLandFaces && !match.spellMods?.castFaceDown) {
				return { ok: false, error: 'Lands are played using Play Land, not cast as spells.' };
			}
			return { ok: true, option: match };
		}

		const altMeta = alternativeCostMetaById(optionId);
		if (altMeta) {
			if (
				inst.castViaSuspend ||
				(fromZone === 'exile' && inst.playableFromExileBy?.withoutPayingManaCost)
			) {
				return {
					ok: false,
					error: 'Only one alternative cost can be applied to a spell (CR 118.9a).'
				};
			}
			const hasAltOnAnyFace = def.faces.some((_, fi) => keywordAltCost(card, altMeta.keyword, fi) !== null);
			if (!hasAltOnAnyFace) {
				const kwLabel = `${altMeta.keyword[0].toUpperCase()}${altMeta.keyword.slice(1)}`;
				return { ok: false, error: `${inst.card.name} does not have ${kwLabel}.` };
			}
		}
		if (fromZone === 'graveyard') {
			return { ok: false, error: 'Spells can only be cast from your Hand, Command Zone, or Exile.' };
		}
		if (allLandFaces && !altMeta?.meta.faceDown) {
			return { ok: false, error: 'Lands are played using Play Land, not cast as spells.' };
		}
		return {
			ok: false,
			error: `Cast option '${optionId}' is not valid for ${inst.card.name} from ${fromZone}.`
		};
	}

	if (allLandFaces) {
		return { ok: false, error: 'Lands are played using Play Land, not cast as spells.' };
	}

	if (fused) {
		const fusedOpt = candidates.find((o) => o.fused);
		if (fusedOpt) return { ok: true, option: fusedOpt };
		return {
			ok: false,
			error: `${inst.card.name} cannot be cast fused from ${fromZone}.`
		};
	}

	if (faceIndex !== undefined) {
		const requestedFace = def.faces[faceIndex];
		if (
			requestedFace &&
			requestedFace.characteristics.types.includes('Land') &&
			!requestedFace.characteristics.types.includes('Creature')
		) {
			return { ok: false, error: 'Lands are played using Play Land, not cast as spells.' };
		}
		const faceOpt = candidates.find((o) => (o.faceIndex ?? 0) === faceIndex && !o.fused);
		if (faceOpt) return { ok: true, option: faceOpt };
		return {
			ok: false,
			error: `Face ${faceIndex} of ${inst.card.name} cannot be cast from ${fromZone}.`
		};
	}

	if (candidates.length === 0) {
		return {
			ok: false,
			error:
				fromZone === 'graveyard'
					? 'Spells can only be cast from your Hand, Command Zone, or Exile.'
					: `No cast option is available for ${inst.card.name} from ${fromZone}.`
		};
	}

	const defaultOpt =
		candidates.find((o) => o.id === 'normal') ??
		candidates.find((o) => o.id === 'library:top') ??
		candidates.find((o) => o.id === 'exile:suspend') ??
		candidates.find((o) => o.id === 'exile:permission') ??
		candidates.find((o) => o.id === 'exile:foretell') ??
		candidates.find((o) => o.id === 'exile:plot') ??
		candidates.find((o) => o.id === 'exile:warp') ??
		(candidates.length === 1 ? candidates[0] : undefined);
	if (!defaultOpt) {
		return { ok: false, error: 'Choose how to cast this spell (optionId is required).' };
	}
	return { ok: true, option: defaultOpt };
}

export interface PlannedCastCostAids {
	costAidIds: Record<string, string[]>;
	costAidColorChoices: Record<string, ManaColor | 'generic'>;
	remainingReq: ManaCostRequirement;
	reservedTapIds: Set<string>;
	reservedExileIds: Set<string>;
}

/**
 * Greedily selects eligible `CastCostAid` candidates (`tapPermanent` / `exileCard`) to satisfy or
 * reduce `costReq` when casting a spell, stopping early unless `preferUseAids` is true.
 */
export function planCastCostAids(
	state: GameState,
	actor: PlayerGameState,
	option: CastOption,
	costReq: ManaCostRequirement,
	spendCtx: ManaSpendContext = { isSpell: false },
	phyrexianLifeCount?: number,
	reservedIds?: ReadonlySet<string>,
	preferUseAids = false
): PlannedCastCostAids {
	const emptyResult: PlannedCastCostAids = {
		costAidIds: {},
		costAidColorChoices: {},
		remainingReq: costReq,
		reservedTapIds: new Set<string>(),
		reservedExileIds: new Set<string>()
	};
	const aids = option.paymentAids;
	if (!aids || aids.length === 0) return emptyResult;
	if (!preferUseAids && canPayOrAutoTap(actor, costReq, state, phyrexianLifeCount, spendCtx, reservedIds)) {
		return emptyResult;
	}

	const remaining: ManaCostRequirement = {
		...costReq,
		colored: { ...costReq.colored }
	};
	const costAidIds: Record<string, string[]> = {};
	const costAidColorChoices: Record<string, ManaColor | 'generic'> = {};
	const used = new Set<string>(reservedIds);
	const reservedTapIds = new Set<string>();
	const reservedExileIds = new Set<string>();
	const currentReserved = (): ReadonlySet<string> | undefined => (used.size > 0 ? used : undefined);
	const canCurrentlyPay = (): boolean =>
		canPayOrAutoTap(actor, remaining, state, phyrexianLifeCount, spendCtx, currentReserved());

	const aidColors: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];
	const hasGraveyardCastKeyword = (c: CardInstance): boolean =>
		compileCard(c.card).faces.some((f) =>
			f.abilities.some(
				(a) =>
					a.kind === 'keyword' &&
					Boolean(ALTERNATIVE_COST_KEYWORDS[a.keyword.name]?.zones.includes('graveyard'))
			)
		);

	for (const aid of aids) {
		if (aid.kind !== 'exileCard') continue;
		const eligible = aid.candidateIds
			.filter((id) => !used.has(id))
			.map((id) => actor.graveyard.find((c) => c.instanceId === id))
			.filter((c): c is CardInstance => Boolean(c))
			.sort((a, b) => {
				const aGy = hasGraveyardCastKeyword(a) ? 1 : 0;
				const bGy = hasGraveyardCastKeyword(b) ? 1 : 0;
				if (aGy !== bGy) return aGy - bGy;
				return (a.card.cmc ?? 0) - (b.card.cmc ?? 0);
			});
		const maxRed = aid.maxGenericReduction ?? remaining.generic;
		let reduced = 0;
		for (const c of eligible) {
			if (!preferUseAids && canCurrentlyPay()) break;
			if (remaining.generic < aid.paysGeneric || reduced + aid.paysGeneric > maxRed) break;
			used.add(c.instanceId);
			reservedExileIds.add(c.instanceId);
			(costAidIds[aid.id] ??= []).push(c.instanceId);
			costAidColorChoices[c.instanceId] = 'generic';
			remaining.generic -= aid.paysGeneric;
			reduced += aid.paysGeneric;
		}
	}

	const cmdIdentity = getPlayerCommanderIdentity(actor);
	const pickTapFromPool = (
		aid: CastCostAid,
		pool: Array<{ perm: CardInstance; colors: ManaColor[] }>,
		keepGoingWhenPayable: boolean
	): void => {
		const remainingPool = [...pool];
		while (remainingPool.length > 0 && (keepGoingWhenPayable || !canCurrentlyPay())) {
			const neededColors = aidColors.filter((c) => remaining.colored[c] > 0);
			const canPayGeneric = remaining.generic >= aid.paysGeneric;
			if (neededColors.length === 0 && !canPayGeneric) break;

			let bestIdx = -1;
			let bestChoice: ManaColor | 'generic' | null = null;
			let bestRank = Number.POSITIVE_INFINITY;

			for (let i = 0; i < remainingPool.length; i++) {
				const { perm, colors } = remainingPool[i];
				const matchingNeeded = colors.filter((c) => remaining.colored[c] > 0);
				if (matchingNeeded.length === 0 && !canPayGeneric) continue;
				const pow = evaluatePermanent(state, perm).power;
				if (matchingNeeded.length > 0) {
					// Most-constrained color-matching permanent first, then lower power.
					const rank = matchingNeeded.length * 1000 + colors.length * 100 + pow;
					if (rank < bestRank) {
						bestRank = rank;
						bestIdx = i;
						bestChoice = matchingNeeded[0];
					}
				} else if (canPayGeneric) {
					const rank = 100_000 + colors.length * 100 + pow;
					if (rank < bestRank) {
						bestRank = rank;
						bestIdx = i;
						bestChoice = 'generic';
					}
				}
			}

			if (bestIdx < 0 || !bestChoice) break;
			const [{ perm }] = remainingPool.splice(bestIdx, 1);
			used.add(perm.instanceId);
			reservedTapIds.add(perm.instanceId);
			(costAidIds[aid.id] ??= []).push(perm.instanceId);
			costAidColorChoices[perm.instanceId] = bestChoice;
			if (bestChoice === 'generic') {
				remaining.generic -= aid.paysGeneric;
			} else {
				remaining.colored[bestChoice] -= 1;
			}
		}
	};

	for (const aid of aids) {
		if (aid.kind !== 'tapPermanent') continue;
		const nonMana: Array<{ perm: CardInstance; colors: ManaColor[] }> = [];
		const manaDorks: Array<{ perm: CardInstance; colors: ManaColor[] }> = [];
		for (const id of aid.candidateIds) {
			if (used.has(id)) continue;
			const perm = actor.battlefield.find((c) => c.instanceId === id);
			if (!perm || perm.tapped || perm.phasedOut) continue;
			const colors = aid.colorsByCandidate?.[id] ?? [];
			const hasManaAb = autoTapManaAbilities(state, actor, perm, cmdIdentity, spendCtx).length > 0;
			if (hasManaAb) manaDorks.push({ perm, colors });
			else nonMana.push({ perm, colors });
		}
		pickTapFromPool(aid, nonMana, preferUseAids);
		if (!canCurrentlyPay()) {
			pickTapFromPool(aid, manaDorks, false);
		}
	}

	return { costAidIds, costAidColorChoices, remainingReq: remaining, reservedTapIds, reservedExileIds };
}

function canPayManaWithPaymentAids(
	state: GameState,
	actor: PlayerGameState,
	option: CastOption,
	costReq: ManaCostRequirement,
	spendCtx: ManaSpendContext,
	phyrexianLifeCount?: number,
	reservedIds?: ReadonlySet<string>
): { ok: boolean; reservedAidIds: Set<string> } {
	if (canPayOrAutoTap(actor, costReq, state, phyrexianLifeCount, spendCtx, reservedIds)) {
		return { ok: true, reservedAidIds: new Set<string>() };
	}
	if (!option.paymentAids || option.paymentAids.length === 0) {
		return { ok: false, reservedAidIds: new Set<string>() };
	}
	const planned = planCastCostAids(
		state,
		actor,
		option,
		costReq,
		spendCtx,
		phyrexianLifeCount,
		reservedIds,
		false
	);
	const reserved = new Set<string>(reservedIds);
	for (const id of planned.reservedTapIds) reserved.add(id);
	for (const id of planned.reservedExileIds) reserved.add(id);
	const ok = canPayOrAutoTap(actor, planned.remainingReq, state, phyrexianLifeCount, spendCtx, reserved);
	return { ok, reservedAidIds: reserved };
}

export function getSpellOptionCostRequirement(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	option: CastOption,
	xValue = 0,
	optionalCostCounts?: Record<string, number>
): ManaCostRequirement | null {
	const actor = state.players.find((p) => p.playerId === actorId);
	if (!actor) return null;
	return withStableLayerInputs(state, () =>
		getSpellCostRequirementForOption(actor, inst, state, xValue, option, optionalCostCounts)
	);
}

/**
 * Enumerates all currently legal ways `actorId` can cast `inst` from `fromZone` (CR 601.2, 118.9).
 * Read-only: shares one layer-cache validation across all option checks.
 */
export function getCastOptions(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: CastableSourceZone
): CastOption[] {
	return withStableLayerInputs(state, () => getCastOptionsInner(state, actorId, inst, fromZone));
}

function getCastOptionsInner(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: CastableSourceZone
): CastOption[] {
	const candidates = enumerateCandidateCastOptions(state, actorId, inst, fromZone);
	return candidates.filter((opt) => {
		if (checkSpellCastOptionLegalityInner(state, actorId, inst, fromZone, 0, opt).ok) {
			return true;
		}
		if (opt.choosesX && checkSpellCastOptionLegalityInner(state, actorId, inst, fromZone, 1, opt).ok) {
			return true;
		}
		return false;
	});
}

function hasGlobalSpendManaAsAnyColor(state: GameState, player: PlayerGameState): boolean {
	for (const p of state.players) {
		for (const perm of p.battlefield) {
			if (perm.phasedOut || evaluatePermanent(state, perm).losesAllAbilities) continue;
			for (const ab of activeAbilityDefs(
				effectiveCardForObject(perm),
				instanceFaceOptions(perm, 'battlefield')
			)) {
				if (
					ab.kind === 'static' &&
					ab.static.k === 'ruleModifier' &&
					ab.static.rule === 'spendManaAsAnyColor'
				) {
					if (matchesPlayerFilter(ab.static.who, perm.controllerId, player.playerId, state)) {
						return true;
					}
				}
			}
		}
	}
	return false;
}

function getSpellCostRequirementForOption(
	player: PlayerGameState,
	inst: CardInstance,
	state: GameState,
	xValue: number,
	option: CastOption,
	optionalCostCounts?: Record<string, number>
): ManaCostRequirement {
	const applyAnyColorPermission = (req: ManaCostRequirement): ManaCostRequirement => {
		const fromExile =
			inst.zone === 'exile' &&
			inst.playableFromExileBy?.playerId === player.playerId &&
			inst.playableFromExileBy.spendManaAsAnyColor;
		const fromGlobal = hasGlobalSpendManaAsAnyColor(state, player);
		if (fromExile || fromGlobal) {
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

	const { manaCosts: extraManaCosts } = expandOptionalAdditionalCosts(option, optionalCostCounts);
	return applyAnyColorPermission(
		effectiveSpellManaCost(
			state,
			player,
			inst,
			xValue,
			option.baseCost,
			extraManaCosts,
			option.faceIndex ?? 0,
			option.fused ?? false,
			option.spellMods?.castFaceDown,
			option.spellMods?.prototyped
		)
	);
}

export function getSpellCostRequirement(
	player: PlayerGameState,
	inst: CardInstance,
	state: GameState,
	xValue = 0,
	optionId?: string,
	optionalCostCounts?: Record<string, number>
): ManaCostRequirement {
	const fromZone: CastableSourceZone =
		inst.zone === 'command' ||
		inst.zone === 'exile' ||
		inst.zone === 'graveyard' ||
		inst.zone === 'library'
			? inst.zone
			: 'hand';
	const resolved = resolveCastOptionForAction(state, player.playerId, inst, fromZone, optionId);
	if (resolved.ok) {
		return getSpellCostRequirementForOption(
			player,
			inst,
			state,
			xValue,
			resolved.option,
			optionalCostCounts
		);
	}
	const altMeta = optionId ? alternativeCostMetaById(optionId) : null;
	const altCost = altMeta ? keywordAltCost(inst.copiableCard ?? inst.card, altMeta.keyword) : null;
	const fallbackBase: CastOption['baseCost'] =
		altCost !== null
			? {
					kind: 'alternative',
					...(altCost.manaCost !== undefined ? { manaCost: altCost.manaCost } : {}),
					...(altCost.costDefs.length > 0 ? { costDefs: altCost.costDefs } : {})
				}
			: { kind: 'printed' };
	return effectiveSpellManaCost(state, player, inst, xValue, fallbackBase);
}

export function chooseBotSpellCostPayment(
	state: GameState,
	player: PlayerGameState,
	inst: CardInstance,
	xValue = 0,
	optionId?: string,
	optionalCostCounts?: Record<string, number>
): CostPayment | undefined {
	const fromZone: CastableSourceZone =
		inst.zone === 'command' ||
		inst.zone === 'exile' ||
		inst.zone === 'graveyard' ||
		inst.zone === 'library'
			? inst.zone
			: 'hand';
	const resolved = resolveCastOptionForAction(state, player.playerId, inst, fromZone, optionId);
	const altDefs =
		resolved.ok && resolved.option.baseCost.kind === 'alternative'
			? (resolved.option.baseCost.costDefs ?? [])
			: [];
	const { nonManaDefs: extraNonManaDefs } = resolved.ok
		? expandOptionalAdditionalCosts(resolved.option, optionalCostCounts)
		: { nonManaDefs: [] };
	const optFace = resolved.ok ? (resolved.option.faceIndex ?? 0) : 0;
	const optFused = resolved.ok ? Boolean(resolved.option.fused) : false;
	const additional =
		resolved.ok && resolved.option.spellMods?.castFaceDown
			? null
			: spellAdditionalCost(inst.card, optFace, optFused);
	const mandatoryDefs = resolved.ok
		? (resolved.option.mandatoryAdditionalCosts ?? [])
		: (additional?.defs ?? []);
	const defs = [...altDefs, ...mandatoryDefs, ...extraNonManaDefs];
	if (defs.length === 0) return undefined;
	const costReq = getSpellCostRequirement(
		player,
		inst,
		state,
		xValue,
		optionId,
		optionalCostCounts
	);
	const spendCtx = spellSpendContext(inst, {
		faceIndex: optFace,
		fused: optFused,
		isFaceDown: Boolean(resolved.ok && resolved.option.spellMods?.castFaceDown)
	});
	return chooseCostPayment(costContext(state, player, inst, xValue, true, costReq, undefined, spendCtx), defs) ?? undefined;
}

/** Picks a legal `CostPayment` for activating `ab` on `perm` (used by bots before calling `activate_ability`). */
export function chooseBotAbilityCostPayment(
	state: GameState,
	player: PlayerGameState,
	perm: CardInstance,
	ab: EffectiveActivatedAbility
): CostPayment | undefined {
	const abilityCost = activatedAbilityCost(perm.card, ab);
	const abilityMana = effectiveAbilityManaCost(
		state,
		player.playerId,
		ab.id,
		ab.manaCost,
		ab.costKeyword
	).requirement;
	return (
		chooseCostPayment(costContext(state, player, perm, 0, false, abilityMana), abilityCost.defs) ??
		undefined
	);
}

/** Builds a ManaSpendContext for casting `inst` with the selected face/fuse/face-down mode. */
export function spellSpendContext(
	inst: CardInstance,
	opts?: { faceIndex?: number; fused?: boolean; isFaceDown?: boolean }
): ManaSpendContext {
	if (opts?.isFaceDown) return { isSpell: true, isArtifactSpell: false };
	const resolved = resolveObjectFaces(effectiveCardForObject(inst), {
		zone: 'stack',
		faceIndex: opts?.faceIndex,
		fused: opts?.fused
	});
	return {
		isSpell: true,
		isArtifactSpell: /\bArtifact\b/i.test(resolved.typeLine)
	};
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
	if (evalPerm.losesAllAbilities && (!ab || (!ab.manaAmount && !ab.grantSourceCard))) {
		return baseAmount;
	}
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
	baseMana: ManaCostRequirement | null,
	phyrexianLifeCount?: number,
	spendCtx: ManaSpendContext = { isSpell: false },
	reservedObjectIds?: ReadonlySet<string>,
	canPayManaOverride?: (req: ManaCostRequirement, reservedIds?: ReadonlySet<string>) => boolean
): CostContext {
	const combineReserved = (reservedIds?: ReadonlySet<string>): ReadonlySet<string> | undefined => {
		if (!reservedObjectIds?.size) return reservedIds;
		if (!reservedIds?.size) return reservedObjectIds;
		const merged = new Set<string>(reservedObjectIds);
		for (const id of reservedIds) merged.add(id);
		return merged;
	};
	return {
		state,
		player,
		source,
		xValue,
		isSpell,
		baseMana,
		reservedObjectIds,
		spendCtx,
		canPayMana: canPayManaOverride
			? (req, reservedIds) => canPayManaOverride(req, combineReserved(reservedIds))
			: (req, reservedIds) =>
					canPayOrAutoTap(player, req, state, phyrexianLifeCount, spendCtx, combineReserved(reservedIds)),
		payMana: (req) => payManaWithAutoTap(player, req, state, phyrexianLifeCount, spendCtx, reservedObjectIds)
	};
}

function resolveCostSourceCard(state: GameState, pcp: PendingCostPayment): CardInstance {
	if (pcp.kind === 'cast_spell') {
		const sp = state.players.find((p) => p.playerId === pcp.sourcePlayerId);
		const zone = pcp.sourceZone ?? 'hand';
		const inst = sp?.[zone].find((c) => c.instanceId === pcp.sourceInstanceId);
		if (inst) return inst;
	} else if (pcp.kind === 'hand_special_action') {
		const sp = state.players.find((p) => p.playerId === pcp.actorId);
		const inst = sp?.hand.find((c) => c.instanceId === pcp.sourceInstanceId);
		if (inst) return inst;
	}
	const found =
		findCardAnywhere(state, pcp.sourceInstanceId)?.inst ??
		state.pendingZoneMoves?.find((c) => c.instanceId === pcp.sourceInstanceId);
	if (found) return found;
	const fallbackCard =
		pcp.sourceCard ??
		({
			id: pcp.sourceInstanceId,
			name: 'Unknown Card',
			manaCost: '',
			cmc: 0,
			typeLine: '',
			colors: [],
			colorIdentity: [],
			imageUrl: ''
		} as unknown as ScryfallCard);
	const inst = createCardInstance(
		fallbackCard,
		pcp.actorId,
		'graveyard',
		false,
		false,
		undefined,
		state
	);
	inst.instanceId = pcp.sourceInstanceId;
	if (pcp.sourceObjectVersion !== undefined) inst.objectVersion = pcp.sourceObjectVersion;
	return inst;
}

function finalizeCastSpell(
	state: GameState,
	actor: PlayerGameState,
	inst: CardInstance,
	sourcePlayer: PlayerGameState,
	sourceZone: 'hand' | 'command' | 'exile' | 'graveyard' | 'library',
	opts: {
		targets: TargetRef[];
		targetsBySpec?: TargetRef[][];
		chosenModes?: number[];
		xValue: number;
		castOptionId?: string;
		faceIndex?: number;
		fused?: boolean;
		spellMods?: SpellModifications;
		optionalCostCounts?: Record<string, number>;
		exSourceName?: string;
		descriptions?: string[];
		aidDescriptions?: string[];
		additionalIncomplete?: boolean;
		manaColorsSpent?: ManaColor[];
	}
): void {
	const actorId = actor.playerId;
	const stackFaceIdx = opts.faceIndex ?? 0;
	const stackFused = Boolean(opts.fused);
	const castFaceDownSpec = opts.spellMods?.castFaceDown;
	const faceDownLabel = castFaceDownSpec ? allocateFaceDownLabel(state) : undefined;
	const stackView = resolveObjectFaces(effectiveCardForObject(inst), {
		zone: 'stack',
		faceIndex: stackFaceIdx,
		fused: stackFused,
		...(opts.spellMods?.prototyped ? { prototyped: true } : {}),
		...(castFaceDownSpec ? { isFaceDown: true, faceDownSpec: castFaceDownSpec } : {})
	});
	const spellDisplayName = faceDownLabel ?? stackView.name;
	if (opts.aidDescriptions && opts.aidDescriptions.length > 0) {
		addLog(
			state,
			'rule',
			`${actor.username} ${opts.aidDescriptions.join('; ')} while casting ${spellDisplayName}.`,
			actorId
		);
	}
	if (opts.descriptions && opts.descriptions.length > 0) {
		addLog(state, 'rule', `${actor.username} ${opts.descriptions.join('; ')} as an additional cost.`, actorId);
	}
	if (opts.additionalIncomplete) {
		addLog(state, 'rule', `The additional cost of ${spellDisplayName} isn't automated; pay it manually.`, actorId);
	}

	const wasForetoldCard = sourceZone === 'exile' && Boolean(inst.foretoldByPlayerId);
	const effectiveSpellMods: SpellModifications | undefined =
		wasForetoldCard && !opts.spellMods?.foretold
			? { ...opts.spellMods, foretold: true }
			: opts.spellMods;
	const exSourceName =
		opts.exSourceName ??
		inst.playableFromExileBy?.sourceName ??
		(effectiveSpellMods?.foretold
			? 'Foretell'
			: opts.castOptionId === 'exile:plot'
				? 'Plot'
				: opts.castOptionId === 'exile:warp' || inst.warpedByOwnerId
					? 'Warp'
					: undefined);
	if (castFaceDownSpec) {
		inst.isFaceDown = true;
		inst.faceDownSpec = { ...castFaceDownSpec };
		inst.faceDownLabel = faceDownLabel;
	} else if (inst.isFaceDown) {
		// CR 702.143a / CR 601.2a: Casting a face-down card in exile for a face-up option turns it face up on the stack.
		inst.isFaceDown = false;
		inst.faceDownSpec = undefined;
		inst.faceDownLabel = undefined;
	}
	inst.prototyped = effectiveSpellMods?.prototyped ? true : undefined;
	inst.manaColorsSpent = opts.manaColorsSpent ? [...opts.manaColorsSpent] : undefined;
	moveObject(state, inst, 'stack', {
		from: { player: sourcePlayer, zone: sourceZone },
		newTimestamp: true,
		bumpVersion: true
	});
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

	const { targets, targetsBySpec, chosenModes, xValue: xVal, castOptionId, optionalCostCounts } = opts;
	const spellMods = effectiveSpellMods;
	const hasSpellMods = Boolean(spellMods && Object.keys(spellMods).length > 0);
	const stackItem: StackItem = withStackItemText(
		{
			id: uid('stk', state),
			sourceInstanceId: inst.instanceId,
			sourceObjectVersion: inst.objectVersion,
			card: inst.card,
			ownerId: inst.ownerId,
			controllerId: actorId,
			kind: 'spell',
			title: spellDisplayName,
			...(opts.manaColorsSpent ? { manaColorsSpent: [...opts.manaColorsSpent] } : {}),
			...(opts.faceIndex !== undefined ? { faceIndex: opts.faceIndex } : {}),
			...(opts.fused ? { fused: true } : {}),
			...(castFaceDownSpec
				? { isFaceDown: true, faceDownSpec: { ...castFaceDownSpec }, faceDownLabel }
				: {}),
			targets,
			...(targetsBySpec ? { targetsBySpec } : {}),
			...(chosenModes ? { chosenModes: [...chosenModes] } : {}),
			targetObjectVersions: captureTargetObjectVersions(state, targets),
			xValue: xVal,
			...(castOptionId ? { castOptionId } : {}),
			...(hasSpellMods ? { spellMods } : {}),
			...(optionalCostCounts ? { optionalCostCounts } : {}),
			commanderCastCount: inst.commanderCastCount,
			requiresGuidedResolution: false,
			createdAt: Date.now()
		},
		castFaceDownSpec ? '' : inst.card
	);

	state.stack.push(stackItem);

	if (actor.manaRiders && actor.manaRiders.length > 0) {
		const matchingRiders: ManaRider[] = [];
		const remainingRiders: ManaRider[] = [];
		for (const rider of actor.manaRiders) {
			const matches = rider.condition?.sharesCreatureTypeWithCommander
				? matchesObjectFilter(
						inst,
						{ types: ['Creature'], sharesTypeWithCommander: true },
						{
							state,
							controllerId: actorId
						}
					)
				: false;
			if (matches) {
				matchingRiders.push(rider);
			} else {
				remainingRiders.push(rider);
			}
		}
		actor.manaRiders = remainingRiders;
		for (const rider of matchingRiders) {
			const scryAmount = rider.scryAmount ?? 1;
			const riderCard = rider.sourceCard ?? inst.card;
			const riderStackItem: StackItem = withStackItemText(
				{
					id: uid('stk', state),
					sourceInstanceId: rider.sourceInstanceId ?? inst.instanceId,
					card: riderCard,
					ownerId: actorId,
					controllerId: actorId,
					kind: 'triggered',
					title: `${riderCard.name} (Scry ${scryAmount})`,
					targets: [],
					requiresGuidedResolution: false,
					createdAt: Date.now(),
					xValue: 0,
					delayedEffect: { kind: 'scry', amount: scryAmount }
				},
				riderCard
			);
			state.stack.push(riderStackItem);
			addLog(
				state,
				'trigger',
				`${riderCard.name} triggered: Scry ${scryAmount}.`,
				actorId
			);
		}
	}
	state.passedPriorityPlayerIds = [];
	state.priorityUpdatedAt = Date.now();

	const targetDesc =
		targets.length > 0 ? ` targeting ${targets.map((t) => t.label).join(', ')}` : '';
	const kickerInfo = optionalCostCounts
		? computeKickerTracking(
				inst.card,
				optionalCostCounts,
				{ spellMods },
				stackFaceIdx,
				stackFused
			)
		: { count: 0, tags: [] };
	const kickedSuffix = kickerInfo.count > 0 ? ' (kicked)' : '';
	const summarySuffix = `${spellMods?.castSummarySuffix ?? ''}${kickedSuffix}`;
	addLog(
		state,
		'cast',
		`${actor.username} cast ${spellDisplayName}${summarySuffix}${sourceZone === 'command' ? ` from Command Zone (Cast #${inst.commanderCastCount})` : sourceZone === 'graveyard' ? ' from Graveyard' : sourceZone === 'library' ? ' from Top of Library' : sourceZone === 'exile' ? ` from Exile (${exSourceName || 'Exile Permission'})` : ''}${targetDesc}.`,
		actorId
	);

	emitVfx(state, {
		kind: sourceZone === 'command' ? 'commander_cast' : 'spell_cast',
		sourceId: actorId,
		targetId: targets[0]?.id,
		label: spellDisplayName
	});

	emitEvent(state, { kind: 'Cast', playerId: actor.playerId, objectId: inst.instanceId, object: inst });
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
	resetTriggerLoopTracking(state);
	flushTriggers(state);
	checkStateBasedActions(state);
}

function finalizeActivateAbility(
	state: GameState,
	actor: PlayerGameState,
	pcp: PendingCostPayment
): void {
	const actorId = actor.playerId;
	const perm =
		findPermanentOnBoard(state, pcp.sourceInstanceId)?.inst ??
		resolveCostSourceCard(state, pcp);
	const card = pcp.sourceCard ?? perm.card;
	const targets = pcp.targets ?? [];
	const effectText = pcp.effectText ?? '';
	if (
		pcp.onceEachTurn &&
		(perm.zone === 'battlefield' || perm.zone === 'hand' || perm.zone === 'graveyard') &&
		perm.objectVersion === pcp.sourceObjectVersion &&
		pcp.abilityId
	) {
		perm.activatedAbilityIdsThisTurn = [
			...(perm.activatedAbilityIdsThisTurn ?? []),
			pcp.abilityId
		];
	}
	const abModal = pcp.abilityId
		? getAbilityModal(card, pcp.abilityId, pcp.faceIndex ?? 0, pcp.grantSourceCard)
		: undefined;
	recordUsedModalModes(perm, pcp.sourceObjectVersion, abModal, pcp.chosenModes);
	if (pcp.descriptions.length > 0) {
		addLog(state, 'rule', `${actor.username} ${pcp.descriptions.join('; ')} to activate ${card.name}.`, actorId);
	}
	if (pcp.abilityCostIncomplete) {
		addLog(state, 'rule', `Part of the cost of ${card.name}'s ability isn't automated; pay it manually.`, actorId);
	}

	const isCrewCost =
		pcp.costKeyword === 'crew' ||
		pcp.parts.some((pt) => pt.def.k === 'tapSubsetSum' && pt.def.restrictionTag === 'crew');
	const crewedByIds = isCrewCost
		? pcp.parts.flatMap((pt) =>
				pt.def.k === 'tapSubsetSum' && pt.def.restrictionTag === 'crew'
					? (pt.objectIds ?? [])
					: []
			)
		: undefined;
	const isSaddleCost =
		pcp.costKeyword === 'saddle' ||
		pcp.parts.some((pt) => pt.def.k === 'tapSubsetSum' && pt.def.restrictionTag === 'saddle');
	const saddledByIds = isSaddleCost
		? pcp.parts.flatMap((pt) =>
				pt.def.k === 'tapSubsetSum' && pt.def.restrictionTag === 'saddle'
					? (pt.objectIds ?? [])
					: []
			)
		: undefined;

	const sourceExertedThisTurn = Boolean(pcp.sourceExertedThisTurn || perm.exertedThisTurn);
	const sourceChosenSubType = pcp.sourceChosenSubType ?? perm.chosenSubType;
	const sourceChosenColor = pcp.sourceChosenColor ?? perm.chosenColor;

	const stackItem: StackItem = withStackItemText(
		{
			id: uid('stk', state),
			sourceInstanceId: pcp.sourceInstanceId,
			sourceObjectVersion: pcp.sourceObjectVersion ?? perm.objectVersion,
			sourceLkiPower: pcp.sourceLkiPower ?? 0,
			sourceLkiToughness: pcp.sourceLkiToughness ?? 0,
			...(pcp.sourceEvoked ? { sourceEvoked: true } : {}),
			...(pcp.sourceEscaped ? { sourceEscaped: true } : {}),
			...(pcp.sourceForetold ? { sourceForetold: true } : {}),
			...(pcp.sourceBlitzed ? { sourceBlitzed: true } : {}),
			...(sourceExertedThisTurn ? { sourceExertedThisTurn: true } : {}),
			...(sourceChosenSubType ? { sourceChosenSubType } : {}),
			...(sourceChosenColor ? { sourceChosenColor } : {}),
			...(perm.isMonstrous ? { sourceMonstrous: true } : {}),
			card,
			...(pcp.grantSourceCard ? { grantSourceCard: pcp.grantSourceCard } : {}),
			...(pcp.faceIndex !== undefined ? { faceIndex: pcp.faceIndex } : {}),
			...(crewedByIds !== undefined ? { crewedByIds } : {}),
			...(saddledByIds !== undefined ? { saddledByIds } : {}),
			...(pcp.tappedCostPower !== undefined ? { tappedCostPower: pcp.tappedCostPower } : {}),
			...(pcp.stationTappedId ? { stationTappedId: pcp.stationTappedId } : {}),
			...(pcp.stationTappedVersion !== undefined ? { stationTappedVersion: pcp.stationTappedVersion } : {}),
			controllerId: actorId,
			kind: 'activated',
			abilityId: pcp.abilityId,
			title: `${resolveObjectFaces(card, { zone: perm.zone, faceIndex: pcp.faceIndex ?? 0 }).name} Ability`,
			targets,
			...(pcp.targetsBySpec ? { targetsBySpec: pcp.targetsBySpec } : {}),
			...(pcp.chosenModes ? { chosenModes: [...pcp.chosenModes] } : {}),
			targetObjectVersions: captureTargetObjectVersions(state, targets),
			xValue: pcp.xValue ?? 0,
			requiresGuidedResolution: false,
			createdAt: Date.now()
		},
		effectText
	);

	state.stack.push(stackItem);
	state.passedPriorityPlayerIds = [];
	addLog(state, 'cast', `${actor.username} activated ${card.name}: "${effectText}".`, actorId);
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
	resetTriggerLoopTracking(state);
	flushTriggers(state);
	checkStateBasedActions(state);
}

function finalizeTapMana(
	state: GameState,
	actor: PlayerGameState,
	pcp: PendingCostPayment
): void {
	const actorId = actor.playerId;
	const perm =
		findPermanentOnBoard(state, pcp.sourceInstanceId)?.inst ??
		resolveCostSourceCard(state, pcp);
	const card = pcp.sourceCard ?? perm.card;
	const abStub =
		pcp.abilityId || pcp.manaRestriction || pcp.freezesSelfUntap
			? ({
					...(pcp.abilityId ? { id: pcp.abilityId } : {}),
					...(pcp.faceIndex !== undefined ? { faceIndex: pcp.faceIndex } : {}),
					...(pcp.manaRestriction ? { manaRestriction: pcp.manaRestriction } : {}),
					...(pcp.onceEachTurn ? { activationRestrictions: ['onceEachTurn'] } : {}),
					...(pcp.freezesSelfUntap ? { freezesSelfUntap: true } : {})
				} as EffectiveActivatedAbility)
			: undefined;
	const chosenColor = pcp.chosenColor;
	const chosenBundle = pcp.chosenBundle;
	const amount = pcp.amount ?? 0;
	const tappedSource = pcp.parts.some((part) => part.def.k === 'tapSelf');
	resetTriggerLoopTracking(state);
	resolveActivatedManaAbility(
		state,
		actor,
		perm,
		abStub,
		chosenColor,
		amount,
		tappedSource,
		chosenBundle
	);
	flushTriggers(state);
	if (pcp.descriptions.length > 0 || pcp.sacrificeSelfInCost) {
		const manaSummary =
			chosenBundle && chosenBundle.length > 0
				? formatManaBundle(chosenBundle)
				: chosenColor && amount > 0
					? `${amount > 1 ? `${amount}x ` : ''}{${chosenColor}}`
					: null;
		addLog(
			state,
			'rule',
			manaSummary
				? `${actor.username} activated ${card.name} for ${manaSummary}${pcp.descriptions.length > 0 ? ` (${pcp.descriptions.join('; ')})` : ''}.`
				: `${actor.username} activated ${card.name} for no mana (CR 106.5)${pcp.descriptions.length > 0 ? ` (${pcp.descriptions.join('; ')})` : ''}.`,
			actorId
		);
	}
	checkStateBasedActions(state);
}

function executeOrResumePendingCostPayment(
	state: GameState,
	pcp: PendingCostPayment,
	ctx: CostContext
): { ok: true } {
	pcp.aidDescriptions ??= [];
	if (!pcp.tapsAndManaDone) {
		if (pcp.costKeyword === 'station') {
			const tapPart = pcp.parts.find(
				(pt) => !pt.isCostAid && pt.def.k === 'tapOthers' && (pt.objectIds?.length ?? 0) > 0
			);
			const tappedId = tapPart?.objectIds?.[0];
			if (tappedId) {
				const foundTapped = findPermanentOnBoard(state, tappedId);
				pcp.stationTappedId = tappedId;
				if (foundTapped) {
					pcp.stationTappedVersion = foundTapped.inst.objectVersion ?? 1;
					pcp.tappedCostPower = Math.max(0, evaluatePermanent(state, foundTapped.inst).power);
				}
			}
		}
		payTapAndManaCostParts(ctx, pcp.parts, pcp.manaPaid ?? null, pcp.descriptions, pcp.aidDescriptions);
		pcp.tapsAndManaDone = true;
		if (ctx.spendCtx?.capturedColorsSpent) {
			pcp.manaColorsSpent = ctx.spendCtx.capturedColorsSpent;
		}
	}
	const paid = executeCostPaymentParts(
		ctx,
		pcp.parts,
		pcp.nextPartIndex,
		pcp.nextObjectIndex,
		pcp.descriptions,
		pcp.costKeyword,
		pcp.aidDescriptions
	);
	if (paid.paused) {
		pcp.nextPartIndex = paid.nextPartIndex ?? pcp.nextPartIndex;
		pcp.nextObjectIndex = paid.nextObjectIndex ?? pcp.nextObjectIndex;
		state.pendingCostPayment = pcp;
		flushTriggers(state);
		return { ok: true };
	}
	delete state.pendingCostPayment;
	const actor = ctx.player;
	if (pcp.kind === 'cast_spell') {
		const sourcePlayer =
			state.players.find((p) => p.playerId === pcp.sourcePlayerId) ?? actor;
		const sourceZone = pcp.sourceZone ?? 'hand';
		const inst = sourcePlayer[sourceZone].find(
			(c) => c.instanceId === pcp.sourceInstanceId
		);
		if (inst) {
			finalizeCastSpell(state, actor, inst, sourcePlayer, sourceZone, {
				targets: pcp.targets ?? [],
				targetsBySpec: pcp.targetsBySpec,
				chosenModes: pcp.chosenModes,
				xValue: pcp.xValue ?? 0,
				castOptionId: pcp.castOptionId,
				faceIndex: pcp.faceIndex,
				fused: pcp.fused,
				spellMods: pcp.spellMods,
				optionalCostCounts: pcp.optionalCostCounts,
				exSourceName: pcp.exSourceName,
				descriptions: pcp.descriptions,
				aidDescriptions: pcp.aidDescriptions,
				additionalIncomplete: pcp.additionalIncomplete,
				manaColorsSpent: pcp.manaColorsSpent
			});
		}
	} else if (pcp.kind === 'activate_ability') {
		finalizeActivateAbility(state, actor, pcp);
	} else if (pcp.kind === 'turn_face_up') {
		finalizeTurnFaceUp(state, actor, pcp);
	} else if (pcp.kind === 'hand_special_action') {
		finalizeHandSpecialAction(state, actor, pcp);
	} else {
		finalizeTapMana(state, actor, pcp);
	}
	return { ok: true };
}

function resumePendingCostPayment(state: GameState): void {
	const pcp = state.pendingCostPayment;
	if (!pcp) return;
	const actor = state.players.find((p) => p.playerId === pcp.actorId);
	if (!actor) {
		delete state.pendingCostPayment;
		return;
	}
	const source = resolveCostSourceCard(state, pcp);
	const spendCtx: ManaSpendContext =
		pcp.kind === 'cast_spell'
			? spellSpendContext(source, {
					faceIndex: pcp.faceIndex,
					fused: pcp.fused,
					isFaceDown: Boolean(pcp.spellMods?.castFaceDown)
				})
			: { isSpell: false };
	const reservedIds =
		pcp.kind === 'hand_special_action' ? new Set<string>([pcp.sourceInstanceId]) : undefined;
	const ctx = costContext(
		state,
		actor,
		source,
		pcp.xValue ?? 0,
		pcp.kind === 'cast_spell',
		pcp.manaPaid ?? null,
		undefined,
		spendCtx,
		reservedIds
	);
	executeOrResumePendingCostPayment(state, pcp, ctx);
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
				: question.minTotal !== undefined
					? `Choose any number with total ${question.metric ?? 'power'} ${question.minTotal}+: ${question.label}.`
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

function isTapOnlyManaCost(defs: CostDef[]): boolean {
	return defs.every((d) => d.k === 'tapSelf' || (d.k === 'mana' && /^(\{0\})*$/.test(d.cost)));
}

function manaCostPayEnergyAmount(defs: CostDef[]): number | null {
	let energy = 0;
	let hasTap = false;
	for (const d of defs) {
		if (d.k === 'tapSelf') {
			hasTap = true;
		} else if (d.k === 'mana' && /^(\{0\})*$/.test(d.cost)) {
			// zero-mana component
		} else if (d.k === 'payEnergy' && d.count.k === 'const' && d.count.n > 0) {
			energy += d.count.n;
		} else {
			return null;
		}
	}
	return hasTap && energy > 0 ? energy : null;
}

function isSacrificeSelfNonCreatureManaCost(defs: CostDef[], isCreature: boolean): boolean {
	if (isCreature) return false;
	const hasSacSelf = defs.some(
		(d) => d.k === 'sacrifice' && d.filter === 'self' && d.count.k === 'const' && d.count.n === 1
	);
	if (!hasSacSelf) return false;
	return defs.every(
		(d) =>
			d.k === 'tapSelf' ||
			(d.k === 'mana' && /^(\{0\})*$/.test(d.cost)) ||
			(d.k === 'sacrifice' && d.filter === 'self' && d.count.k === 'const' && d.count.n === 1)
	);
}

function checkActivationRestrictionsOnly(
	state: GameState,
	actorId: string,
	perm: CardInstance,
	ab: EffectiveActivatedAbility
): { ok: boolean; error?: string } {
	if (
		ab.activationCondition &&
		!evaluateCondition(ab.activationCondition, { state, controllerId: actorId, source: perm })
	) {
		return {
			ok: false,
			error: `${perm.card.name}: Activation condition is not met.`
		};
	}
	const restrictions = ab.activationRestrictions;
	if (!restrictions?.length) return { ok: true };
	const activePlayer = state.players[state.activePlayerIndex];
	if (restrictions.includes('onceEachTurn') && perm.activatedAbilityIdsThisTurn?.includes(ab.id)) {
		return {
			ok: false,
			error: `${perm.card.name}: This ability can only be activated once each turn.`
		};
	}
	if (restrictions.includes('duringYourTurn') && activePlayer?.playerId !== actorId) {
		return {
			ok: false,
			error: `${perm.card.name}: This ability can only be activated during your turn.`
		};
	}
	if (
		restrictions.includes('duringYourUpkeep') &&
		(activePlayer?.playerId !== actorId || state.phase !== 'upkeep')
	) {
		return {
			ok: false,
			error: `${perm.card.name}: This ability can only be activated during your upkeep.`
		};
	}
	if (
		restrictions.includes('duringCombat') &&
		!(
			state.phase === 'begin_combat' ||
			state.phase === 'declare_attackers' ||
			state.phase === 'declare_blockers' ||
			state.phase === 'first_strike_damage' ||
			state.phase === 'combat_damage' ||
			state.phase === 'end_combat'
		)
	) {
		return {
			ok: false,
			error: `${perm.card.name}: This ability can only be activated during combat.`
		};
	}
	return { ok: true };
}

/**
 * Mana abilities that auto-tapping may use:
 * - Tier 0 (preferred): `{T}`-only mana abilities (lands, mana rocks, mana dorks).
 * - Tier 1 (fallback after `{T}`-only sources): `{T}, Sacrifice ~` mana abilities on non-creature
 *   permanents (such as Treasure tokens).
 * Within each cost tier, higher-output mana abilities (e.g. Goldspan's 2-mana Treasure ability)
 * sort ahead of lower-output ones.
 */
function autoTapManaAbilities(
	state: GameState,
	player: PlayerGameState,
	perm: CardInstance,
	cmdIdentity: ManaColor[],
	spendCtx: ManaSpendContext = { isSpell: false }
): EffectiveActivatedAbility[] {
	if (!checkGlobalAbilityActivationRestrictions(state, player.playerId, perm, true).ok) {
		return [];
	}
	const evalPerm = evaluatePermanent(state, perm);
	const noManaCtx = costContext(state, player, perm, 0, false, null);
	const scored: Array<{
		ab: EffectiveActivatedAbility;
		tier: number;
		freezes: number;
		restricted: number;
		amount: number;
	}> = [];
	for (const a of getEffectiveActivatedAbilities(state, player, perm, cmdIdentity)) {
		if (!a.isManaAbility || a.producesMana.length === 0) continue;
		if (a.manaRestriction && !canSpendRestrictedMana(a.manaRestriction, spendCtx)) continue;
		if (!checkActivationRestrictionsOnly(state, player.playerId, perm, a).ok) continue;
		const defs = activatedAbilityCost(perm.card, a).defs;
		let tier = -1;
		if (isTapOnlyManaCost(defs)) {
			if (!canPayCosts(noManaCtx, defs)) continue;
			tier = 0;
		} else if (manaCostPayEnergyAmount(defs) !== null) {
			if (!canPayCosts(noManaCtx, defs)) continue;
			tier = 1;
		} else if (isSacrificeSelfNonCreatureManaCost(defs, evalPerm.isCreature)) {
			if (!canPayCosts(noManaCtx, defs)) continue;
			tier = 2;
		}
		if (tier < 0) continue;
		const amount = getDynamicManaProducedAmount(
			state,
			player,
			perm,
			Math.max(1, a.producesAmount || 1),
			a
		);
		if (amount <= 0) continue;
		scored.push({
			ab: a,
			tier,
			freezes: a.freezesSelfUntap ? 1 : 0,
			restricted: a.manaRestriction ? 0 : 1,
			amount
		});
	}
	scored.sort(
		(x, y) =>
			x.tier - y.tier ||
			x.freezes - y.freezes ||
			x.restricted - y.restricted ||
			y.amount - x.amount
	);
	return scored.map((s) => s.ab);
}

function hasUntappedManaSources(
	state: GameState,
	player: PlayerGameState,
	spendCtx: ManaSpendContext = { isSpell: false }
): boolean {
	const cmdIdentity = getPlayerCommanderIdentity(player);
	return withStableLayerInputs(state, () =>
		player.battlefield.some((perm) => {
			if (perm.phasedOut) return false;
			return autoTapManaAbilities(state, player, perm, cmdIdentity, spendCtx).length > 0;
		})
	);
}

/**
 * CR 107.4f & CR 601.2f-h: Convert `lifeCount` Phyrexian mana symbols (`{W/P}`, `{U/P}`, etc.)
 * into 2 life each before auto-tapping so Pass 2 only taps lands for the remaining mana cost.
 */
function applyPhyrexianLifeChoice(
	req: ManaCostRequirement,
	lifeCount: number
): { manaReq: ManaCostRequirement; lifeToPay: number } {
	if (lifeCount <= 0 || !req.flexibleSymbols?.some((s) => s.altLife)) {
		return { manaReq: req, lifeToPay: 0 };
	}
	const nextColored = { ...req.colored };
	const remainingFlex = [...(req.flexibleSymbols ?? [])];
	let lifeToPay = 0;
	let remainingToConvert = lifeCount;
	for (let i = 0; i < remainingFlex.length && remainingToConvert > 0; ) {
		const sym = remainingFlex[i];
		if (sym.altLife && nextColored[sym.primaryColor] > 0) {
			nextColored[sym.primaryColor] -= 1;
			lifeToPay += sym.altLife;
			remainingFlex.splice(i, 1);
			remainingToConvert -= 1;
		} else {
			i += 1;
		}
	}
	return {
		manaReq: {
			...req,
			colored: nextColored,
			flexibleSymbols: remainingFlex.length > 0 ? remainingFlex : undefined
		},
		lifeToPay
	};
}

function maybeAskPhyrexianCostChoice(
	state: GameState,
	actor: PlayerGameState,
	action: Extract<
		GameActionPayload,
		{
			type:
				| 'cast_spell'
				| 'activate_ability'
				| 'tap_mana'
				| 'unlock_room_door'
				| 'turn_face_up'
				| 'hand_special_action';
		}
	>,
	req: ManaCostRequirement,
	sourceName: string,
	spendCtx: ManaSpendContext = { isSpell: false },
	canPayCheck?: (candidateReq: ManaCostRequirement) => boolean
): { ok: boolean; error?: string } | null {
	if (actor.isBot || action.costPayment?.phyrexianLifeCount !== undefined) return null;
	const phySymbols = req.flexibleSymbols?.filter((s) => s.altLife) ?? [];
	if (phySymbols.length === 0) return null;
	const canPayLife = !playerLifeTotalCantChange(state, actor);
	const maxLifeCount = canPayLife ? Math.min(phySymbols.length, Math.floor(actor.life / 2)) : 0;
	if (maxLifeCount <= 0) return null;
	// No mana possible: keep today's behavior of paying life without prompting (unless payment aids are available).
	if (
		!canPayCheck &&
		getTotalPooledManaForContext(actor, spendCtx) === 0 &&
		!hasUntappedManaSources(state, actor, spendCtx)
	) {
		return null;
	}
	const canPay =
		canPayCheck ?? ((candidateReq: ManaCostRequirement) => canPayOrAutoTap(actor, candidateReq, state, undefined, spendCtx));
	if (!canPay(req)) return null;
	const labels: string[] = [];
	for (let k = 0; k <= maxLifeCount; k++) {
		const manaSymbols = phySymbols
			.slice(k)
			.map((s) => `{${s.primaryColor}}`)
			.join('');
		const lifeAmt = 2 * k;
		if (k === 0) {
			labels.push(`Pay ${manaSymbols}`);
		} else if (manaSymbols.length > 0) {
			labels.push(`Pay ${manaSymbols} and ${lifeAmt} life`);
		} else {
			labels.push(`Pay ${lifeAmt} life`);
		}
	}
	state.pendingPrompts.push({
		id: uid('prm', state),
		playerId: actor.playerId,
		kind: 'cost_choice',
		purpose: 'cost_choice',
		title: `Pay the cost of ${sourceName}`,
		description: `Choose how to pay Phyrexian mana for ${sourceName}.`,
		choice: {
			kind: 'chooseMode',
			modes: labels,
			min: 1,
			max: 1
		},
		cancellable: true,
		costQuestion: { kind: 'phyrexian', index: 0 },
		costOptionLabels: labels,
		pendingAction: action
	});
	return { ok: true };
}

function applySingleHybridChoice(
	req: ManaCostRequirement,
	choice: number
): ManaCostRequirement {
	const flex = req.flexibleSymbols ?? [];
	const idx = flex.findIndex((s) => !s.altLife);
	if (idx < 0) return req;
	const sym = flex[idx];
	const nextColored = { ...req.colored };
	let nextGeneric = req.generic;
	if (choice === 1) {
		if (sym.altColor !== undefined) {
			nextColored[sym.primaryColor] = Math.max(0, nextColored[sym.primaryColor] - 1);
			nextColored[sym.altColor] += 1;
		} else if (sym.altGeneric !== undefined) {
			nextColored[sym.primaryColor] = Math.max(0, nextColored[sym.primaryColor] - 1);
			nextGeneric += sym.altGeneric;
		}
	}
	const remainingFlex = flex.filter((_, i) => i !== idx);
	return {
		...req,
		colored: nextColored,
		generic: nextGeneric,
		flexibleSymbols: remainingFlex.length > 0 ? remainingFlex : undefined
	};
}

function resolveHybridCostChoice(
	state: GameState,
	actor: PlayerGameState,
	action: Extract<
		GameActionPayload,
		{
			type:
				| 'cast_spell'
				| 'activate_ability'
				| 'tap_mana'
				| 'unlock_room_door'
				| 'turn_face_up'
				| 'hand_special_action';
		}
	>,
	req: ManaCostRequirement,
	sourceName: string,
	spendCtx: ManaSpendContext = { isSpell: false },
	canPayCheck?: (candidateReq: ManaCostRequirement) => boolean
): { promptResult?: { ok: boolean; error?: string }; resolvedReq: ManaCostRequirement } {
	let currentReq = req;
	const hybridChoices = action.costPayment?.hybridChoices ?? [];
	let choiceIdx = 0;
	while (choiceIdx < hybridChoices.length && currentReq.flexibleSymbols?.some((s) => !s.altLife)) {
		const c = hybridChoices[choiceIdx];
		if (c === 0 || c === 1) {
			currentReq = applySingleHybridChoice(currentReq, c);
		}
		choiceIdx += 1;
	}
	if (actor.isBot) {
		return { resolvedReq: currentReq };
	}
	const canPay =
		canPayCheck ??
		((candidateReq: ManaCostRequirement) =>
			canPayOrAutoTap(actor, candidateReq, state, action.costPayment?.phyrexianLifeCount, spendCtx));
	while (currentReq.flexibleSymbols?.some((s) => !s.altLife)) {
		const sym = currentReq.flexibleSymbols.find((s) => !s.altLife)!;
		const req0 = applySingleHybridChoice(currentReq, 0);
		const req1 = applySingleHybridChoice(currentReq, 1);
		const canPay0 = canPay(req0);
		const canPay1 = canPay(req1);
		if (canPay0 && !canPay1) {
			currentReq = req0;
			choiceIdx += 1;
			continue;
		}
		if (!canPay0 && canPay1) {
			currentReq = req1;
			choiceIdx += 1;
			continue;
		}
		if (canPay0 && canPay1) {
			const label0 = `Pay {${sym.primaryColor}}`;
			const label1 =
				sym.altColor !== undefined
					? `Pay {${sym.altColor}}`
					: `Pay {${sym.altGeneric ?? 2}}`;
			const labels = [label0, label1];
			state.pendingPrompts.push({
				id: uid('prm', state),
				playerId: actor.playerId,
				kind: 'cost_choice',
				purpose: 'cost_choice',
				title: `Pay the cost of ${sourceName}`,
				description: `Choose how to pay hybrid mana for ${sourceName} (CR 107.4e).`,
				choice: {
					kind: 'chooseMode',
					modes: labels,
					min: 1,
					max: 1,
					defaultIndices: [0]
				},
				cancellable: true,
				costQuestion: { kind: 'hybrid', index: choiceIdx },
				costOptionLabels: labels,
				pendingAction: action
			});
			return { promptResult: { ok: true }, resolvedReq: currentReq };
		}
		break;
	}
	return { resolvedReq: currentReq };
}

const TAP_MANA_ABILITY_CHOICE_HANDLER = 'tap_mana_ability_choice';
const TAP_MANA_COLOR_CHOICE_HANDLER = 'tap_mana_color_choice';
const TAP_MANA_BUNDLE_CHOICE_HANDLER = 'tap_mana_bundle_choice';

registerPromptHandler(TAP_MANA_ABILITY_CHOICE_HANDLER, (state, prompt, answer) => {
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	const instanceId = typeof data?.instanceId === 'string' ? data.instanceId : '';
	const abilityIds =
		typeof data?.abilityIdsCsv === 'string' && data.abilityIdsCsv.length > 0
			? data.abilityIdsCsv.split('\u001f')
			: [];
	const idx = answer.kind === 'chooseMode' ? (answer.indices[0] ?? 0) : 0;
	const abilityId = abilityIds[idx] ?? abilityIds[0];
	const preferredColor =
		typeof data?.preferredColor === 'string' && data.preferredColor.length > 0
			? (data.preferredColor as ManaColor)
			: undefined;
	const chosenBundle =
		typeof data?.chosenBundleCsv === 'string' && data.chosenBundleCsv.length > 0
			? (data.chosenBundleCsv.split(',') as ManaColor[])
			: undefined;
	const costPayment =
		typeof data?.costPaymentJson === 'string'
			? (JSON.parse(data.costPaymentJson) as CostPayment)
			: undefined;
	applyGameActionInner(state, prompt.playerId, {
		type: 'tap_mana',
		instanceId,
		...(abilityId ? { abilityId } : {}),
		...(preferredColor ? { preferredColor } : {}),
		...(chosenBundle ? { chosenBundle } : {}),
		...(costPayment ? { costPayment } : {})
	});
});

registerPromptHandler(TAP_MANA_COLOR_CHOICE_HANDLER, (state, prompt, answer) => {
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	const instanceId = typeof data?.instanceId === 'string' ? data.instanceId : '';
	const abilityId =
		typeof data?.abilityId === 'string' && data.abilityId.length > 0 ? data.abilityId : undefined;
	const colors =
		typeof data?.colorsCsv === 'string' && data.colorsCsv.length > 0
			? (data.colorsCsv.split(',') as ManaColor[])
			: (['W', 'U', 'B', 'R', 'G'] as ManaColor[]);
	const idx = answer.kind === 'chooseMode' ? (answer.indices[0] ?? 0) : 0;
	const preferredColor = colors[idx] ?? colors[0];
	const costPayment =
		typeof data?.costPaymentJson === 'string'
			? (JSON.parse(data.costPaymentJson) as CostPayment)
			: undefined;
	applyGameActionInner(state, prompt.playerId, {
		type: 'tap_mana',
		instanceId,
		...(abilityId ? { abilityId } : {}),
		preferredColor,
		...(costPayment ? { costPayment } : {})
	});
});

registerPromptHandler(TAP_MANA_BUNDLE_CHOICE_HANDLER, (state, prompt, answer) => {
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	const instanceId = typeof data?.instanceId === 'string' ? data.instanceId : '';
	const abilityId =
		typeof data?.abilityId === 'string' && data.abilityId.length > 0 ? data.abilityId : undefined;
	const bundles =
		typeof data?.bundlesCsv === 'string' && data.bundlesCsv.length > 0
			? data.bundlesCsv.split('|').map((s) => s.split(',') as ManaColor[])
			: [];
	const idx = answer.kind === 'chooseMode' ? (answer.indices[0] ?? 0) : 0;
	const chosenBundle = bundles[idx] ?? bundles[0];
	const costPayment =
		typeof data?.costPaymentJson === 'string'
			? (JSON.parse(data.costPaymentJson) as CostPayment)
			: undefined;
	applyGameActionInner(state, prompt.playerId, {
		type: 'tap_mana',
		instanceId,
		...(abilityId ? { abilityId } : {}),
		...(chosenBundle ? { chosenBundle } : {}),
		...(costPayment ? { costPayment } : {})
	});
});

/**
 * CR 106.12, 605.1b, 605.3b, 605.4a: Single funnel for resolving an activated mana ability of `perm`
 * after its activation costs (such as `{T}`) have been paid. Records `onceEachTurn`, adds the
 * produced mana to `player.manaPool`, emits `TappedForMana`, and resolves triggered mana abilities
 * immediately without using the stack (`flushInlineTriggers`).
 */
function resolveActivatedManaAbility(
	state: GameState,
	player: PlayerGameState,
	perm: CardInstance,
	ab: EffectiveActivatedAbility | undefined,
	chosenColor: ManaColor | undefined,
	amount: number,
	tappedForMana = true,
	chosenBundle?: readonly ManaColor[]
): void {
	if (ab?.activationRestrictions?.includes('onceEachTurn')) {
		perm.activatedAbilityIdsThisTurn = [...(perm.activatedAbilityIdsThisTurn ?? []), ab.id];
	}
	if (ab?.freezesSelfUntap) {
		applyNextUntapFreeze(perm);
	}
	if (chosenBundle && chosenBundle.length > 0) {
		for (const col of chosenBundle) {
			addManaToPlayerPool(player, col, 1, ab?.manaRestriction);
		}
		const abilityDef = activeAbilityDefs(
			effectiveCardForObject(perm),
			instanceFaceOptions(perm, 'battlefield')
		).find((a) => a.kind === 'activated' && (ab?.id ? a.id === ab.id : a.isMana));
		if (abilityDef && abilityDef.kind === 'activated') {
			for (const eff of abilityDef.effect) {
				if (eff.verb === 'addMana' && eff.delayed) {
					for (const col of chosenBundle) {
						(player.manaRiders ??= []).push({
							id: uid('rider', state),
							color: col,
							sourceInstanceId: perm.instanceId,
							sourceCard: effectiveCardForObject(perm),
							condition: { sharesCreatureTypeWithCommander: true },
							scryAmount: 1
						});
					}
				}
			}
		}
	} else if (chosenColor && amount > 0) {
		addManaToPlayerPool(player, chosenColor, amount, ab?.manaRestriction);
		const abilityDef = activeAbilityDefs(
			effectiveCardForObject(perm),
			instanceFaceOptions(perm, 'battlefield')
		).find((a) => a.kind === 'activated' && (ab?.id ? a.id === ab.id : a.isMana));
		if (abilityDef && abilityDef.kind === 'activated') {
			for (const eff of abilityDef.effect) {
				if (eff.verb === 'addMana' && eff.delayed) {
					for (let i = 0; i < amount; i++) {
						(player.manaRiders ??= []).push({
							id: uid('rider', state),
							color: chosenColor,
							sourceInstanceId: perm.instanceId,
							sourceCard: effectiveCardForObject(perm),
							condition: { sharesCreatureTypeWithCommander: true },
							scryAmount: 1
						});
					}
				}
			}
		}
	}
	if (tappedForMana) {
		// CR 605.1b, 605.4a: triggered mana abilities ("Whenever you tap a land for mana") resolve immediately.
		emitEvent(state, {
			kind: 'TappedForMana',
			playerId: player.playerId,
			objectId: perm.instanceId,
			object: perm
		});
		flushInlineTriggers(state);
	}
}

function simulateOrExecuteManaOnly(
	player: PlayerGameState,
	manaReq: ManaCostRequirement,
	state: GameState,
	mutate: boolean,
	lifeToPay: number,
	spendCtx: ManaSpendContext = { isSpell: false },
	reservedTapIds?: ReadonlySet<string>,
	filterDepth = 0
): boolean {
	if (lifeToPay > 0 && (playerLifeTotalCantChange(state, player) || player.life < lifeToPay)) {
		return false;
	}
	const initialPool = combinedManaPoolForSpend(player, spendCtx);
	if (canPayManaCost(initialPool, manaReq)) {
		if (mutate) {
			deductManaForSpendContext(player, manaReq, spendCtx);
			if (lifeToPay > 0) {
				player.life -= lifeToPay;
			}
		}
		return true;
	}

	const pool: ManaPool = { ...initialPool };
	const cmdIdentity = getPlayerCommanderIdentity(player);

	const getProducedAmount = (
		perm: CardInstance,
		prodAmount: number,
		ab?: EffectiveActivatedAbility
	): number => getDynamicManaProducedAmount(state, player, perm, prodAmount, ab);
	const autoMana = new Map<string, EffectiveActivatedAbility[]>();
	const manaAbilitiesOf = (perm: CardInstance) => {
		let abs = autoMana.get(perm.instanceId);
		if (!abs) {
			abs = autoTapManaAbilities(state, player, perm, cmdIdentity, spendCtx);
			autoMana.set(perm.instanceId, abs);
		}
		return abs;
	};
	const permCostTier = (perm: CardInstance): number => {
		const abs = manaAbilitiesOf(perm);
		return abs.some((a) => isTapOnlyManaCost(activatedAbilityCost(perm.card, a).defs)) ? 0 : 1;
	};
	const permFreezes = (perm: CardInstance): number =>
		manaAbilitiesOf(perm).every((a) => a.freezesSelfUntap) ? 1 : 0;

	// Sort untapped mana sources: {T}-only before sacrifice-self (and tokens before nontokens when sacrificing),
	// pain-free {T} sources before depletion-freezing {T} sources, restricted sources before unrestricted sources,
	// then most-constrained (fewest colors) first, then non-creatures before creatures.
	// Read-only scan: validate the layer cache once (Phase 6c).
	const candidates = withStableLayerInputs(state, () =>
		player.battlefield
			.filter((perm) => {
				if (perm.phasedOut) return false;
				if (reservedTapIds?.has(perm.instanceId)) return false;
				return manaAbilitiesOf(perm).length > 0;
			})
			.sort((a, b) => {
				const ta = permCostTier(a);
				const tb = permCostTier(b);
				if (ta !== tb) return ta - tb;
				if (ta === 0) {
					const fa = permFreezes(a);
					const fb = permFreezes(b);
					if (fa !== fb) return fa - fb;
				}
				if (ta === 1) {
					const aNonToken = a.isToken ? 0 : 1;
					const bNonToken = b.isToken ? 0 : 1;
					if (aNonToken !== bNonToken) return aNonToken - bNonToken;
				}
				const aRestr = manaAbilitiesOf(a)[0]?.manaRestriction ? 0 : 1;
				const bRestr = manaAbilitiesOf(b)[0]?.manaRestriction ? 0 : 1;
				if (aRestr !== bRestr) return aRestr - bRestr;
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
	let availableEnergy = player.energyCounters || 0;
	const abilityEnergyCost = (perm: CardInstance, ab: EffectiveActivatedAbility | undefined): number =>
		ab ? (manaCostPayEnergyAmount(activatedAbilityCost(perm.card, ab).defs) ?? 0) : 0;
	const manaChoices = new Map<
		string,
		{
			color: ManaColor;
			amount: number;
			bundle?: ManaColor[];
			ab: EffectiveActivatedAbility | undefined;
		}
	>();

	const applyChosenAbilityToPool = (
		perm: CardInstance,
		ab: EffectiveActivatedAbility | undefined,
		preferredCol?: ManaColor
	) => {
		const baseAmt = Math.max(1, ab?.producesAmount || 1);
		const amount = getProducedAmount(perm, baseAmt, ab);
		availableEnergy -= abilityEnergyCost(perm, ab);
		tappedSet.add(perm.instanceId);
		if (ab?.manaBundles && ab.manaBundles.length > 0) {
			const eligibleBundles = preferredCol
				? ab.manaBundles.filter((b) => b.includes(preferredCol))
				: ab.manaBundles;
			const bundle = pickBestBundleForRequirement(
				eligibleBundles.length > 0 ? eligibleBundles : ab.manaBundles,
				pool,
				manaReq,
				preferredCol
			);
			for (const c of bundle) pool[c] += 1;
			manaChoices.set(perm.instanceId, {
				color: bundle[0] ?? preferredCol ?? 'C',
				amount: bundle.length,
				bundle,
				ab
			});
			return;
		}
		if (ab?.manaCombinationColors) {
			const allowed =
				ab.manaCombinationColors === 'any' ? FIVE_MANA_COLORS : ab.manaCombinationColors;
			const bundle = pickCombinationForRequirement(
				allowed,
				amount,
				pool,
				manaReq,
				preferredCol,
				player
			);
			for (const c of bundle) pool[c] += 1;
			manaChoices.set(perm.instanceId, {
				color: bundle[0] ?? preferredCol ?? 'C',
				amount: bundle.length,
				bundle,
				ab
			});
			return;
		}
		const chosenColor: ManaColor = preferredCol ?? ab?.producesMana[0] ?? 'C';
		pool[chosenColor] += amount;
		manaChoices.set(perm.instanceId, { color: chosenColor, amount, ab });
	};

	let greedySucceeded = true;

	// Pass 1: Satisfy missing colored mana pips using the most-constrained sources first.
	// Any remaining Phyrexian symbol not already converted to life must be paid with its primaryColor.
	for (const col of ['W', 'U', 'B', 'R', 'G', 'C'] as ManaColor[]) {
		const flexCountForCol =
			manaReq.flexibleSymbols?.filter((s) => s.primaryColor === col && !s.altLife).length ?? 0;
		while (pool[col] < manaReq.colored[col]) {
			const perm =
				candidates.find((c) => {
					if (tappedSet.has(c.instanceId)) return false;
					return manaAbilitiesOf(c).some(
						(a) =>
							!a.freezesSelfUntap &&
							a.producesMana.includes(col) &&
							abilityEnergyCost(c, a) <= availableEnergy
					);
				}) ??
				candidates.find((c) => {
					if (tappedSet.has(c.instanceId)) return false;
					return manaAbilitiesOf(c).some(
						(a) => a.producesMana.includes(col) && abilityEnergyCost(c, a) <= availableEnergy
					);
				});
			if (!perm) {
				if (manaReq.colored[col] - pool[col] <= flexCountForCol) {
					break;
				}
				greedySucceeded = false;
				break;
			}
			const matchedAb =
				manaAbilitiesOf(perm).find(
					(a) =>
						!a.freezesSelfUntap &&
						a.producesMana.includes(col) &&
						abilityEnergyCost(perm, a) <= availableEnergy
				) ??
				manaAbilitiesOf(perm).find(
					(a) => a.producesMana.includes(col) && abilityEnergyCost(perm, a) <= availableEnergy
				);
			applyChosenAbilityToPool(perm, matchedAb, col);
		}
		if (!greedySucceeded) break;
	}

	// Pass 2: Satisfy remaining generic / non-Phyrexian flexible mana cost using remaining untapped sources
	while (greedySucceeded && !canPayManaCost(pool, manaReq)) {
		const perm =
			candidates.find(
				(c) =>
					!tappedSet.has(c.instanceId) &&
					manaAbilitiesOf(c).some(
						(a) => !a.freezesSelfUntap && abilityEnergyCost(c, a) <= availableEnergy
					)
			) ??
			candidates.find(
				(c) =>
					!tappedSet.has(c.instanceId) &&
					manaAbilitiesOf(c).some((a) => abilityEnergyCost(c, a) <= availableEnergy)
			);
		if (!perm) {
			greedySucceeded = false;
			break;
		}
		const ab0 =
			manaAbilitiesOf(perm).find(
				(a) => !a.freezesSelfUntap && abilityEnergyCost(perm, a) <= availableEnergy
			) ?? manaAbilitiesOf(perm).find((a) => abilityEnergyCost(perm, a) <= availableEnergy);
		applyChosenAbilityToPool(perm, ab0);
	}

	if (!greedySucceeded) {
		if (filterDepth >= 2) return false;
		const clonePlayerMana = (p: PlayerGameState): PlayerGameState => ({
			...p,
			manaPool: { ...p.manaPool },
			restrictedMana: p.restrictedMana
				? Object.fromEntries(
						Object.entries(p.restrictedMana).map(([k, v]) => [k, v ? { ...v } : v])
					)
				: undefined
		});
		const abilitySpendCtx: ManaSpendContext = { isSpell: false };

		for (const fPerm of player.battlefield) {
			if (fPerm.phasedOut || fPerm.tapped || reservedTapIds?.has(fPerm.instanceId)) continue;
			if (!checkGlobalAbilityActivationRestrictions(state, player.playerId, fPerm, true).ok) continue;
			for (const fAb of getEffectiveActivatedAbilities(state, player, fPerm, cmdIdentity)) {
				if (!fAb.isManaAbility || fAb.producesMana.length === 0) continue;
				if (fAb.manaRestriction && !canSpendRestrictedMana(fAb.manaRestriction, spendCtx)) {
					continue;
				}
				if (!checkActivationRestrictionsOnly(state, player.playerId, fPerm, fAb).ok) continue;
				const fDefs = activatedAbilityCost(fPerm.card, fAb).defs;
				if (isTapOnlyManaCost(fDefs)) continue;
				if (
					!fDefs.some((d) => d.k === 'tapSelf') ||
					!fDefs.every((d) => d.k === 'tapSelf' || d.k === 'mana')
				) {
					continue;
				}
				const inReq = parseManaCost(fAb.manaCost === '{0}' ? '' : fAb.manaCost);
				const inTotal = inReq.totalCmc;
				if (inTotal < 1 || inTotal > 2) continue;

				const fAmt = getProducedAmount(fPerm, Math.max(1, fAb.producesAmount || 1), fAb);
				if (fAmt <= 0) continue;
				let outBundles: ManaColor[][];
				if (fAb.manaBundles && fAb.manaBundles.length > 0) {
					outBundles = fAb.manaBundles.map((b) => [...b]);
				} else if (fAb.manaCombinationColors) {
					const allowed =
						fAb.manaCombinationColors === 'any' ? FIVE_MANA_COLORS : fAb.manaCombinationColors;
					outBundles =
						fAmt <= 4
							? expandCombinationBundles(allowed, fAmt)
							: [pickCombinationForRequirement(allowed, fAmt, initialPool, manaReq, undefined, player)];
				} else {
					outBundles = fAb.producesMana.map((c) => Array(fAmt).fill(c) as ManaColor[]);
				}
				outBundles.sort(
					(x, y) =>
						scoreBundleForRequirement(initialPool, y, manaReq) -
						scoreBundleForRequirement(initialPool, x, manaReq)
				);

				// Way A: pay Filter-land input from existing floating mana pool
				if (canPayManaCost(combinedManaPoolForSpend(player, abilitySpendCtx), inReq)) {
					for (const bundle of outBundles) {
						const sim = clonePlayerMana(player);
						deductManaForSpendContext(sim, inReq, abilitySpendCtx);
						for (const c of bundle) addManaToPlayerPool(sim, c, 1, fAb.manaRestriction);
						const nextReserved = new Set<string>([...(reservedTapIds ?? []), fPerm.instanceId]);
						if (
							simulateOrExecuteManaOnly(
								sim,
								manaReq,
								state,
								false,
								lifeToPay,
								spendCtx,
								nextReserved,
								filterDepth + 1
							)
						) {
							if (!mutate) return true;
							deductManaForSpendContext(player, inReq, abilitySpendCtx);
							tapPermanent(state, fPerm);
							resolveActivatedManaAbility(
								state,
								player,
								fPerm,
								fAb,
								bundle[0],
								bundle.length,
								true,
								bundle
							);
							return simulateOrExecuteManaOnly(
								player,
								manaReq,
								state,
								true,
								lifeToPay,
								spendCtx,
								nextReserved,
								filterDepth + 1
							);
						}
					}
				}

				// Way B: tap one {T}-only feeder source to pay Filter-land input
				for (const feeder of candidates) {
					if (feeder.instanceId === fPerm.instanceId) continue;
					for (const feedAb of manaAbilitiesOf(feeder)) {
						if (feedAb.manaRestriction) continue;
						const feedDefs = activatedAbilityCost(feeder.card, feedAb).defs;
						if (!isTapOnlyManaCost(feedDefs)) continue;
						const feedAmt = getProducedAmount(
							feeder,
							Math.max(1, feedAb.producesAmount || 1),
							feedAb
						);
						if (feedAmt <= 0) continue;
						const feedOutputs: Array<{ color: ManaColor; amount: number; bundle?: ManaColor[] }> =
							feedAb.manaBundles && feedAb.manaBundles.length > 0
								? feedAb.manaBundles.map((b) => ({
										color: b[0] ?? 'C',
										amount: b.length,
										bundle: [...b]
									}))
								: feedAb.producesMana.map((c) => ({ color: c, amount: feedAmt }));
						for (const fo of feedOutputs) {
							const simAfterFeed = clonePlayerMana(player);
							if (fo.bundle) {
								for (const c of fo.bundle) addManaToPlayerPool(simAfterFeed, c, 1);
							} else {
								addManaToPlayerPool(simAfterFeed, fo.color, fo.amount);
							}
							if (
								!canPayManaCost(
									combinedManaPoolForSpend(simAfterFeed, abilitySpendCtx),
									inReq
								)
							) {
								continue;
							}
							deductManaForSpendContext(simAfterFeed, inReq, abilitySpendCtx);
							const nextReserved = new Set<string>([
								...(reservedTapIds ?? []),
								fPerm.instanceId,
								feeder.instanceId
							]);
							for (const bundle of outBundles) {
								const sim2 = clonePlayerMana(simAfterFeed);
								for (const c of bundle) addManaToPlayerPool(sim2, c, 1, fAb.manaRestriction);
								if (
									simulateOrExecuteManaOnly(
										sim2,
										manaReq,
										state,
										false,
										lifeToPay,
										spendCtx,
										nextReserved,
										filterDepth + 1
									)
								) {
									if (!mutate) return true;
									tapPermanent(state, feeder);
									resolveActivatedManaAbility(
										state,
										player,
										feeder,
										feedAb,
										fo.color,
										fo.amount,
										true,
										fo.bundle
									);
									deductManaForSpendContext(player, inReq, abilitySpendCtx);
									tapPermanent(state, fPerm);
									resolveActivatedManaAbility(
										state,
										player,
										fPerm,
										fAb,
										bundle[0],
										bundle.length,
										true,
										bundle
									);
									return simulateOrExecuteManaOnly(
										player,
										manaReq,
										state,
										true,
										lifeToPay,
										spendCtx,
										nextReserved,
										filterDepth + 1
									);
								}
							}
						}
					}
				}
			}
		}
		return false;
	}

	if (mutate) {
		for (const perm of candidates) {
			const choice = manaChoices.get(perm.instanceId);
			if (choice) {
				const defs = choice.ab ? activatedAbilityCost(perm.card, choice.ab).defs : [{ k: 'tapSelf' as const }];
				const tappedSource = defs.some((d) => d.k === 'tapSelf');
				if (defs.some((d) => d.k === 'sacrifice' || d.k === 'payEnergy')) {
					const ctx = costContext(state, player, perm, 0, false, null);
					const plan = planCosts(ctx, defs);
					if (!plan.ok || plan.question) return false;
					payPlannedCosts(ctx, plan);
				} else {
					tapPermanent(state, perm);
				}
				resolveActivatedManaAbility(
					state,
					player,
					perm,
					choice.ab,
					choice.color,
					choice.amount,
					tappedSource,
					choice.bundle
				);
			}
		}
		deductManaForSpendContext(player, manaReq, spendCtx);
		if (lifeToPay > 0) {
			player.life -= lifeToPay;
		}
	}

	return true;
}

function simulateOrExecuteAutoTap(
	player: PlayerGameState,
	req: ManaCostRequirement,
	state: GameState,
	mutate: boolean,
	phyrexianLifeCount?: number,
	spendCtx: ManaSpendContext = { isSpell: false },
	reservedTapIds?: ReadonlySet<string>
): boolean {
	const phySymbols = req.flexibleSymbols?.filter((s) => s.altLife) ?? [];
	if (phySymbols.length === 0) {
		return simulateOrExecuteManaOnly(player, req, state, mutate, 0, spendCtx, reservedTapIds);
	}

	const canPayLife = !playerLifeTotalCantChange(state, player);
	const maxLifeCount = canPayLife ? Math.min(phySymbols.length, Math.floor(player.life / 2)) : 0;

	if (phyrexianLifeCount !== undefined) {
		if (phyrexianLifeCount < 0 || phyrexianLifeCount > phySymbols.length) {
			return false;
		}
		const { manaReq, lifeToPay } = applyPhyrexianLifeChoice(req, phyrexianLifeCount);
		return simulateOrExecuteManaOnly(player, manaReq, state, mutate, lifeToPay, spendCtx, reservedTapIds);
	}

	// Bot heuristic: pay Phyrexian symbols with life while life > 10; otherwise prefer mana and only
	// fall back to life when mana cannot cover the colored symbols.
	let preferredK = 0;
	if (player.isBot) {
		while (preferredK < maxLifeCount && player.life - 2 * preferredK > 10) {
			preferredK += 1;
		}
	}
	const kOrder: number[] = [];
	for (let k = preferredK; k >= 0; k--) kOrder.push(k);
	for (let k = preferredK + 1; k <= maxLifeCount; k++) kOrder.push(k);

	for (const k of kOrder) {
		const { manaReq, lifeToPay } = applyPhyrexianLifeChoice(req, k);
		if (simulateOrExecuteManaOnly(player, manaReq, state, false, lifeToPay, spendCtx, reservedTapIds)) {
			return mutate
				? simulateOrExecuteManaOnly(player, manaReq, state, true, lifeToPay, spendCtx, reservedTapIds)
				: true;
		}
	}
	return false;
}

export function canPayOrAutoTap(
	player: PlayerGameState,
	req: ManaCostRequirement,
	state: GameState,
	phyrexianLifeCount?: number,
	spendCtx: ManaSpendContext = { isSpell: false },
	reservedTapIds?: ReadonlySet<string>
): boolean {
	return simulateOrExecuteAutoTap(player, req, state, false, phyrexianLifeCount, spendCtx, reservedTapIds);
}

export function payManaWithAutoTap(
	player: PlayerGameState,
	req: ManaCostRequirement,
	state: GameState,
	phyrexianLifeCount?: number,
	spendCtx: ManaSpendContext = { isSpell: false },
	reservedTapIds?: ReadonlySet<string>
): boolean {
	return simulateOrExecuteAutoTap(player, req, state, true, phyrexianLifeCount, spendCtx, reservedTapIds);
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
	revealFaceDownObjects(state);
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
				break;
			}
			// CR 104.3c / 704.5b: Attempting to draw from an empty library sets a flag checked by SBAs.
			player.attemptedEmptyLibraryDraw = true;
			if (!deferSba) {
				checkStateBasedActions(state);
			}
			break;
		}
		const drawnCard = player.library[0];
		moveObject(state, drawnCard, 'hand', {
			from: { player, zone: 'library' },
			toPlayer: player,
			commanderRedirect: true,
			newTimestamp: true,
			bumpVersion: true
		});
		if (state.status !== 'mulligan' && drawnCard.zone === 'hand') {
			const drawnPlayers = state.playersDrawnThisTurn ?? (state.playersDrawnThisTurn = []);
			if (!drawnPlayers.includes(player.playerId)) {
				drawnPlayers.push(player.playerId);
			}
			player.cardsDrawnThisTurn = (player.cardsDrawnThisTurn ?? 0) + 1;
			emitEvent(state, {
				kind: 'CardDrawn',
				playerId: player.playerId,
				objectId: drawnCard.instanceId,
				object: drawnCard
			});
		}
	}
	if (state.status !== 'mulligan' && !deferSba) {
		flushTriggers(state);
	}
}

export function emptyAllPlayersManaPools(state: GameState): void {
	for (const p of state.players) {
		p.manaPool = createEmptyManaPool();
		p.restrictedMana = {};
		p.manaRiders = [];
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
					!phasingOutIndirectIds.has(perm.instanceId)
				) {
					// CR 702.26h: If an object would simultaneously phase out directly and indirectly,
					// it just phases out indirectly.
					phasingOutDirectIds.delete(perm.instanceId);
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
	if (phasedInNames.length > 0 || phasedOutNames.length > 0) {
		noteLayerInputsChanged(state);
		syncBattlefieldControllers(state);
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
		const frozenNextUntap = consumeNextUntapFreeze(perm);
		if (!frozenNextUntap && perm.tapped && !keptTapped.has(perm.instanceId)) {
			if (perm.counters.stun > 0) {
				perm.counters.stun -= 1;
			} else {
				perm.tapped = false;
			}
		}
		perm.summoningSick = false;
		perm.usedLoyaltyThisTurn = false;
		perm.activatedAbilityIdsThisTurn = undefined;
		perm.usedModalModesThisTurn = undefined;
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

/**
 * Clears "until your next turn" effects created by `playerId`, including protection/prevention flags
 * and goad obligations (CR 701.15a, CR 800.4m).
 */
export function expirePlayerUntilNextTurnEffects(state: GameState, playerId: string): void {
	const player = state.players.find((p) => p.playerId === playerId);
	if (player) {
		player.cannotLoseGameThisTurn = false;
		player.lifeTotalCannotChangeThisTurn = false;
		player.protectionFromEverythingThisTurn = false;
		player.preventAllCombatDamageThisTurn = false;
	}
	for (const p of state.players) {
		for (const perm of p.battlefield) {
			if (!perm.goadedByPlayerIds) continue;
			const hasEntry = perm.goadedByPlayerIds.includes(playerId);
			const exp = perm.goadExpirations?.[playerId];
			if (!hasEntry && exp === undefined) continue;
			// Only remove goad created by `playerId` when its duration was untilYourNextTurn (or unspecified).
			if (exp === undefined || exp === 'untilYourNextTurn') {
				perm.goadedByPlayerIds = perm.goadedByPlayerIds.filter((id) => id !== playerId);
				if (perm.goadedByPlayerIds.length === 0) perm.goadedByPlayerIds = undefined;
				if (perm.goadExpirations) {
					delete perm.goadExpirations[playerId];
					if (Object.keys(perm.goadExpirations).length === 0) perm.goadExpirations = undefined;
				}
			}
		}
	}
}

export function runBeginningOfTurn(state: GameState): void {
	const activePlayer = state.players[state.activePlayerIndex];
	if (!activePlayer || activePlayer.lost) return;

	// Clear "until your next turn" effects (e.g., Teferi's Protection, goad per CR 701.15a)
	expirePlayerUntilNextTurnEffects(state, activePlayer.playerId);
	for (const p of state.players) {
		p.spellsCastThisTurn = 0;
		p.cardsDrawnThisTurn = 0;
	}
	state.playersDrawnThisTurn = [];
	state.triggeredOnceThisTurn = undefined;

	// 1. Untap step (CR 502): turn-based actions execute before PhaseBegin('untap') triggers (CR 703.3)
	beginPhase(state, 'untap', activePlayer);
	emptyAllPlayersManaPools(state);

	// 2. Upkeep step (CR 503): active player receives priority in upkeep (CR 503.1a / 500.2)
	beginPhase(state, 'upkeep', activePlayer);
	givePriorityToActiveOrNextPlayer(state);
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

/**
 * Ends an active or mulligan game whose `engineVersion` is missing or mismatches `ENGINE_VERSION`
 * (PLAN §2.6). Returns `true` when it transitioned the game to `'finished'` and appended a system
 * log entry; returns `false` if the version matches or the game was already `'finished'`.
 */
export function enforceEngineVersion(state: GameState): boolean {
	if (state.engineVersion === ENGINE_VERSION) return false;
	if (state.status === 'finished') return false;
	state.status = 'finished';
	addLog(
		state,
		'system',
		`Match ended: game state engineVersion (${state.engineVersion ?? 'missing'}) is incompatible with current engineVersion (${ENGINE_VERSION}).`
	);
	return true;
}

/**
 * Load-time version gate for a `MagicLobby`: if the lobby has an active/mulligan `gameState` with a
 * missing or mismatched `engineVersion`, ends the game and marks the lobby `'finished'`, bumps
 * `lobby.version`, and returns `true` so the caller can persist the ended state before responding.
 */
export function enforceLobbyEngineVersion(lobby: MagicLobby, now = Date.now()): boolean {
	if (!lobby.gameState) return false;
	if (!enforceEngineVersion(lobby.gameState)) return false;
	lobby.status = 'finished';
	lobby.version += 1;
	lobby.updatedAt = now;
	return true;
}

function applyGameActionInner(
	state: GameState,
	actorId: string,
	action: GameActionPayload
): { ok: boolean; error?: string } {
	if (state.status === 'finished') {
		return { ok: false, error: 'Game has already finished.' };
	}

	if (enforceEngineVersion(state)) {
		return {
			ok: false,
			error: `Match ended due to incompatible engineVersion (${state.engineVersion ?? 'missing'} vs ${ENGINE_VERSION}).`
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
			resetTriggerLoopTracking(state);
			addLog(state, 'rule', `${actor.username} is resolving an ability of ${card.name} manually.`, actor.playerId);
			return { ok: true };
		}
		case 'tap_mana': {
			const perm = actor.battlefield.find((c) => c.instanceId === action.instanceId);
			if (!perm || perm.phasedOut) {
				return { ok: false, error: 'Permanent not found on your battlefield.' };
			}
			const cmdId = getPlayerCommanderIdentity(actor);
			const manaAbs = getEffectiveActivatedAbilities(state, actor, perm, cmdId).filter((a) => a.isManaAbility);
			if (manaAbs.length === 0) {
				return { ok: false, error: `${perm.card.name} does not have an active mana ability.` };
			}
			const globalAbCheck = checkGlobalAbilityActivationRestrictions(state, actorId, perm, true);
			if (!globalAbCheck.ok) return globalAbCheck;

			const preferred = action.preferredColor;
			const requestedBundle = action.chosenBundle;
			let ab: EffectiveActivatedAbility | undefined;
			if (action.abilityId) {
				ab = manaAbs.find((a) => a.id === action.abilityId);
				if (!ab) return { ok: false, error: 'Mana ability not found on this permanent.' };
			} else {
				const matchingAbs =
					requestedBundle && requestedBundle.length > 0
						? manaAbs.filter((a) => requestedBundle.every((c) => a.producesMana.includes(c)))
						: preferred
							? manaAbs.filter((a) => a.producesMana.includes(preferred))
							: manaAbs.filter((a) => a.producesMana.length > 0);
				const payableAbs = matchingAbs.filter((candidate) => {
					if (!checkActivationRestrictionsOnly(state, actorId, perm, candidate).ok) return false;
					const cDefs = activatedAbilityCost(perm.card, candidate).defs;
					const cReq = parseManaCost(candidate.manaCost === '{0}' ? '' : candidate.manaCost);
					const cCtx = costContext(state, actor, perm, 0, false, cReq);
					return canPayCosts(cCtx, cDefs);
				});
				// Deduplicate functionally identical mana abilities (e.g. two copies of the same granter, or
				// two {T}-only 1-mana abilities when preferredColor already fixes the output color).
				const distinctPayableAbs: EffectiveActivatedAbility[] = [];
				const seenSignatures = new Set<string>();
				for (const candidate of payableAbs) {
					const cDefs = activatedAbilityCost(perm.card, candidate).defs;
					const amt = getDynamicManaProducedAmount(
						state,
						actor,
						perm,
						Math.max(1, candidate.producesAmount),
						candidate
					);
					const colorSig = preferred ? preferred : candidate.producesMana.join(',');
					const sig = `${JSON.stringify(cDefs)}|${JSON.stringify(candidate.activationRestrictions ?? [])}|${JSON.stringify(candidate.activationCondition ?? null)}|${Boolean(candidate.freezesSelfUntap)}|${JSON.stringify(candidate.manaBundles ?? null)}|${JSON.stringify(candidate.manaCombinationColors ?? null)}|${amt}|${colorSig}`;
					if (!seenSignatures.has(sig)) {
						seenSignatures.add(sig);
						distinctPayableAbs.push(candidate);
					}
				}
				if (!actor.isBot && distinctPayableAbs.length > 1) {
					let bestIdx = 0;
					let bestAmt = -1;
					let bestFreezes = 1;
					for (let i = 0; i < distinctPayableAbs.length; i++) {
						const amt = getDynamicManaProducedAmount(
							state,
							actor,
							perm,
							Math.max(1, distinctPayableAbs[i].producesAmount),
							distinctPayableAbs[i]
						);
						const frz = distinctPayableAbs[i].freezesSelfUntap ? 1 : 0;
						if (amt > bestAmt || (amt === bestAmt && frz < bestFreezes)) {
							bestAmt = amt;
							bestFreezes = frz;
							bestIdx = i;
						}
					}
					enqueueChoicePrompt(state, {
						id: uid('prm', state),
						playerId: actor.playerId,
						kind: 'chooseMode',
						purpose: 'generic',
						title: `${perm.card.name} — Choose Mana Ability`,
						description: `Choose which mana ability of ${perm.card.name} to activate.`,
						cancellable: true,
						continuation: {
							kind: 'handler',
							name: TAP_MANA_ABILITY_CHOICE_HANDLER,
							data: {
								instanceId: perm.instanceId,
								abilityIdsCsv: distinctPayableAbs.map((a) => a.id).join('\u001f'),
								preferredColor: preferred ?? null,
								chosenBundleCsv: requestedBundle ? requestedBundle.join(',') : null,
								costPaymentJson: action.costPayment ? JSON.stringify(action.costPayment) : null
							}
						},
						choice: {
							kind: 'chooseMode',
							modes: distinctPayableAbs.map((a) => a.label),
							min: 1,
							max: 1,
							defaultIndices: [bestIdx]
						}
					});
					return { ok: true };
				}
				if (payableAbs.length > 0) {
					ab = [...payableAbs].sort((x, y) => {
						const diff =
							getDynamicManaProducedAmount(state, actor, perm, Math.max(1, y.producesAmount), y) -
							getDynamicManaProducedAmount(state, actor, perm, Math.max(1, x.producesAmount), x);
						if (diff !== 0) return diff;
						return (x.freezesSelfUntap ? 1 : 0) - (y.freezesSelfUntap ? 1 : 0);
					})[0];
				} else {
					ab =
						(preferred && manaAbs.find((a) => a.producesMana.includes(preferred))) ||
						manaAbs.find((a) => a.producesMana.length > 0) ||
						manaAbs[0];
				}
			}
			const allowedColors = ab.producesMana;
			let chosenColor: ManaColor | undefined =
				preferred && allowedColors.includes(preferred) ? preferred : allowedColors[0];

			if (ab.activationRestrictions?.length || ab.activationCondition) {
				const manaAbLegality = checkAbilityActivationLegality(state, actorId, perm, ab);
				if (!manaAbLegality.ok) return manaAbLegality;
			}

			// Phase 4: the ability's whole cost from the IR ({T}, and e.g. "Sacrifice this artifact").
			const cost = activatedAbilityCost(perm.card, ab);
			const rawTapMana = parseManaCost(ab.manaCost === '{0}' ? '' : ab.manaCost);
			const hybTapChoice = resolveHybridCostChoice(state, actor, action, rawTapMana, perm.card.name);
			if (hybTapChoice.promptResult) return hybTapChoice.promptResult;
			const ctx = costContext(state, actor, perm, 0, false, hybTapChoice.resolvedReq);
			const plan = planCosts(ctx, cost.defs, action.costPayment);
			if (!plan.ok) return { ok: false, error: plan.error };
			if (plan.question) return askCostChoice(state, actor, action, plan.question, perm.card.name);

			const baseAmount = Math.max(1, ab.producesAmount);
			const dynamicAmount = getDynamicManaProducedAmount(state, actor, perm, baseAmount, ab);
			let chosenBundle: ManaColor[] | undefined;

			if ((ab.manaBundles && ab.manaBundles.length > 0) || ab.manaCombinationColors) {
				const combAllowed =
					ab.manaCombinationColors === 'any'
						? [...FIVE_MANA_COLORS]
						: (ab.manaCombinationColors ?? []);
				let candidateBundles: ManaColor[][] = [];
				if (ab.manaBundles && ab.manaBundles.length > 0) {
					candidateBundles = ab.manaBundles.map((b) => [...b]);
				} else if (dynamicAmount > 0 && combAllowed.length > 0) {
					candidateBundles =
						dynamicAmount <= 5
							? expandCombinationBundles(combAllowed, dynamicAmount)
							: combAllowed.map((c) => Array(dynamicAmount).fill(c) as ManaColor[]);
				}
				const canonicalBundleKey = (b: readonly ManaColor[]) => [...b].sort().join(',');
				if (candidateBundles.length === 0) {
					chosenColor = undefined;
				} else if (requestedBundle && requestedBundle.length > 0) {
					const reqKey = canonicalBundleKey(requestedBundle);
					const matched = candidateBundles.find((b) => canonicalBundleKey(b) === reqKey);
					if (matched) {
						chosenBundle = [...matched];
					} else if (
						ab.manaCombinationColors &&
						requestedBundle.length === dynamicAmount &&
						requestedBundle.every((c) => combAllowed.includes(c))
					) {
						chosenBundle = [...requestedBundle];
					} else {
						return { ok: false, error: 'Invalid mana combination choice.' };
					}
				} else if (candidateBundles.length === 1) {
					chosenBundle = [...candidateBundles[0]];
				} else if (
					preferred &&
					ab.manaCombinationColors &&
					combAllowed.includes(preferred) &&
					dynamicAmount > 0
				) {
					chosenBundle = Array(dynamicAmount).fill(preferred) as ManaColor[];
				} else if (actor.isBot) {
					chosenBundle = ab.manaCombinationColors
						? pickCombinationForRequirement(
								combAllowed,
								dynamicAmount,
								actor.manaPool,
								null,
								preferred,
								actor
							)
						: pickBestBundleForRequirement(candidateBundles, actor.manaPool, null, preferred);
				} else {
					const bestDefault = ab.manaCombinationColors
						? pickCombinationForRequirement(
								combAllowed,
								dynamicAmount,
								actor.manaPool,
								null,
								preferred,
								actor
							)
						: pickBestBundleForRequirement(candidateBundles, actor.manaPool, null, preferred);
					const bestKey = canonicalBundleKey(bestDefault);
					const defaultIdx = Math.max(
						0,
						candidateBundles.findIndex((b) => canonicalBundleKey(b) === bestKey)
					);
					enqueueChoicePrompt(state, {
						id: uid('prm', state),
						playerId: actor.playerId,
						kind: 'chooseMode',
						purpose: 'generic',
						title: `${perm.card.name} — Choose Mana Combination`,
						description: `Choose mana to add from ${perm.card.name}.`,
						cancellable: true,
						continuation: {
							kind: 'handler',
							name: TAP_MANA_BUNDLE_CHOICE_HANDLER,
							data: {
								instanceId: perm.instanceId,
								abilityId: ab.id,
								bundlesCsv: candidateBundles.map((b) => b.join(',')).join('|'),
								costPaymentJson: action.costPayment ? JSON.stringify(action.costPayment) : null
							}
						},
						choice: {
							kind: 'chooseMode',
							modes: candidateBundles.map((b) => formatManaBundle(b)),
							min: 1,
							max: 1,
							defaultIndices: [defaultIdx]
						}
					});
					return { ok: true };
				}
			} else if (!actor.isBot && !preferred && allowedColors.length > 1) {
				const defaultIdx = chosenColor ? Math.max(0, allowedColors.indexOf(chosenColor)) : 0;
				const reason = `Choose a color of mana to add from ${perm.card.name} (${allowedColors.join(', ')}).`;
				enqueueChoicePrompt(state, {
					id: uid('prm', state),
					playerId: actor.playerId,
					kind: 'chooseMode',
					purpose: 'generic',
					title: `${perm.card.name} — Choose Mana Color`,
					description: reason,
					cancellable: true,
					continuation: {
						kind: 'handler',
						name: TAP_MANA_COLOR_CHOICE_HANDLER,
						data: {
							instanceId: perm.instanceId,
							abilityId: ab.id,
							colorsCsv: allowedColors.join(','),
							costPaymentJson: action.costPayment ? JSON.stringify(action.costPayment) : null
						}
					},
					choice: {
						kind: 'chooseMode',
						modes: allowedColors,
						min: 1,
						max: 1,
						defaultIndices: [defaultIdx]
					}
				});
				return { ok: true };
			}

			if (chosenBundle && chosenBundle.length > 0) {
				chosenColor = chosenBundle[0];
			}
			const amount = chosenBundle
				? chosenBundle.length
				: chosenColor
					? dynamicAmount
					: 0;

			const parts = serializeCostPlanParts(ctx, plan);
			const pcp: PendingCostPayment = {
				kind: 'tap_mana',
				actorId,
				sourceInstanceId: perm.instanceId,
				sourceCard: perm.card,
				abilityId: ab.id,
				...(ab.faceIndex !== undefined ? { faceIndex: ab.faceIndex } : {}),
				chosenColor,
				...(chosenBundle ? { chosenBundle } : {}),
				...(ab.freezesSelfUntap ? { freezesSelfUntap: true } : {}),
				amount,
				...(ab.manaRestriction ? { manaRestriction: ab.manaRestriction } : {}),
				onceEachTurn: Boolean(ab.activationRestrictions?.includes('onceEachTurn')),
				sacrificeSelfInCost: cost.defs.some((d) => d.k === 'sacrifice' && d.filter === 'self'),
				parts,
				manaPaid: plan.mana,
				tapsAndManaDone: false,
				nextPartIndex: 0,
				nextObjectIndex: 0,
				descriptions: []
			};
			return executeOrResumePendingCostPayment(state, pcp, ctx);
		}

		case 'play_land': {
			let landInst: CardInstance | undefined;
			let sourcePlayer: PlayerGameState = actor;
			let sourceZone: 'hand' | 'exile' | 'library' | 'graveyard' = 'hand';

			const handIdx = actor.hand.findIndex((c) => c.instanceId === action.instanceId);
			if (handIdx >= 0 && (!action.fromZone || action.fromZone === 'hand')) {
				landInst = actor.hand[handIdx];
				sourcePlayer = actor;
				sourceZone = 'hand';
			} else if (!action.fromZone || action.fromZone === 'exile') {
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
			// --- Track P8 ---
			if (
				!landInst &&
				(!action.fromZone || action.fromZone === 'library') &&
				actor.library[0]?.instanceId === action.instanceId
			) {
				landInst = actor.library[0];
				sourcePlayer = actor;
				sourceZone = 'library';
			}
			if (!landInst && (!action.fromZone || action.fromZone === 'graveyard')) {
				const gyIdx = actor.graveyard.findIndex((c) => c.instanceId === action.instanceId);
				if (gyIdx >= 0) {
					landInst = actor.graveyard[gyIdx];
					sourcePlayer = actor;
					sourceZone = 'graveyard';
				}
			}

			if (!landInst) {
				return { ok: false, error: 'Land card not found in your hand or playable Exile.' };
			}

			const landLegality = checkLandPlayLegality(
				state,
				actorId,
				landInst,
				sourceZone,
				action.faceIndex
			);
			if (!landLegality.ok) {
				return landLegality;
			}
			const resolvedFace = resolveLandPlayFaceIndex(
				effectiveCardForObject(landInst),
				landInst,
				sourceZone,
				action.faceIndex
			);
			if (!resolvedFace.ok) return resolvedFace;

			const exSourceName =
				sourceZone === 'exile'
					? landInst.playableFromExileBy?.sourceName
					: sourceZone === 'library' || sourceZone === 'graveyard'
						? (getActiveZoneLandPlayPermissionSource(state, actorId, sourceZone, landInst) ??
							undefined)
						: undefined;
			landInst.playableFromExileBy = undefined;
			landInst.tapped = false;
			landInst.summoningSick = true;
			landInst.defaultControllerId = actorId;
			if (cardHasSupportedMultiFace(effectiveCardForObject(landInst)) || resolvedFace.faceIndex !== 0) {
				landInst.activeFaceIndex = resolvedFace.faceIndex;
			}
			const playedFaceName = resolveObjectFaces(
				effectiveCardForObject(landInst),
				instanceFaceOptions(landInst, 'battlefield')
			).name;
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
				`${actor.username} played ${playedFaceName}${sourceZone === 'exile' ? ` from Exile (${exSourceName || 'Exile Permission'})` : sourceZone === 'library' ? ` from Top of Library (${exSourceName || 'Library Permission'})` : sourceZone === 'graveyard' ? ` from Graveyard (${exSourceName || 'Graveyard Permission'})` : ''}.`,
				actorId
			);

			resetTriggerLoopTracking(state);
			flushTriggers(state);

			checkStateBasedActions(state);
			return { ok: true };
		}

		case 'turn_face_up': {
			const perm = actor.battlefield.find((c) => c.instanceId === action.instanceId);
			if (!perm) {
				return { ok: false, error: 'Face-down permanent not found on your battlefield.' };
			}
			const xRaw = action.xValue ?? 0;
			const legality = checkTurnFaceUpLegality(state, actorId, perm, xRaw, action.costPayment);
			if (!legality.ok) {
				return legality;
			}
			const spec = perm.faceDownSpec!;
			const turnUpManaCost = spec.turnUpManaCost;
			const turnUpCostDefs = spec.turnUpCostDefs ?? [];
			const choosesX = hasXInTurnUpCost(turnUpManaCost, turnUpCostDefs);
			const effectiveX = choosesX ? Math.max(0, xRaw) : 0;
			const promptName = perm.faceDownLabel || 'Face-Down Permanent';
			const baseReq = resolveTurnUpManaRequirement(turnUpManaCost, effectiveX);
			let effectiveReq = baseReq;
			if (effectiveReq) {
				const phyChoice = maybeAskPhyrexianCostChoice(
					state,
					actor,
					action,
					effectiveReq,
					promptName
				);
				if (phyChoice) return phyChoice;
				const hybChoice = resolveHybridCostChoice(
					state,
					actor,
					action,
					effectiveReq,
					promptName
				);
				if (hybChoice.promptResult) return hybChoice.promptResult;
				effectiveReq = hybChoice.resolvedReq;
			}
			if (turnUpCostDefs.length > 0) {
				const ctx = costContext(
					state,
					actor,
					perm,
					effectiveX,
					false,
					effectiveReq,
					action.costPayment?.phyrexianLifeCount
				);
				const plan = planCosts(ctx, turnUpCostDefs, action.costPayment);
				if (!plan.ok) return { ok: false, error: plan.error };
				if (plan.question) return askCostChoice(state, actor, action, plan.question, promptName);
				const parts = serializeCostPlanParts(ctx, plan);
				const pcp: PendingCostPayment = {
					kind: 'turn_face_up',
					actorId,
					sourceInstanceId: perm.instanceId,
					xValue: effectiveX,
					sourceCard: perm.card,
					parts,
					manaPaid: plan.mana,
					tapsAndManaDone: false,
					nextPartIndex: 0,
					nextObjectIndex: 0,
					descriptions: []
				};
				return executeOrResumePendingCostPayment(state, pcp, ctx);
			}
			if (
				effectiveReq &&
				!payManaWithAutoTap(
					actor,
					effectiveReq,
					state,
					action.costPayment?.phyrexianLifeCount
				)
			) {
				return {
					ok: false,
					error: `Insufficient mana to turn ${promptName} face up (requires ${turnUpManaCost || '{0}'}).`
				};
			}
			completeTurnFaceUp(
				state,
				actor,
				perm,
				effectiveX,
				turnUpManaCost ? [turnUpManaCost] : []
			);
			return { ok: true };
		}

		case 'unlock_room_door': {
			const perm = actor.battlefield.find((c) => c.instanceId === action.instanceId);
			if (!perm) {
				return { ok: false, error: 'Room permanent not found on your battlefield.' };
			}
			const legality = checkUnlockRoomDoorLegality(state, actorId, perm, action.faceIndex);
			if (!legality.ok) {
				return legality;
			}
			const effectiveCard = effectiveCardForObject(perm);
			const faceDef = compileCard(effectiveCard).faces[action.faceIndex];
			if (!faceDef) {
				return { ok: false, error: 'Invalid Room door face index.' };
			}
			const unlockReq = parseManaCost(faceDef.characteristics.manaCost);
			const phyUnlockChoice = maybeAskPhyrexianCostChoice(
				state,
				actor,
				action,
				unlockReq,
				faceDef.name
			);
			if (phyUnlockChoice) return phyUnlockChoice;
			const hybUnlockChoice = resolveHybridCostChoice(
				state,
				actor,
				action,
				unlockReq,
				faceDef.name
			);
			if (hybUnlockChoice.promptResult) return hybUnlockChoice.promptResult;
			if (
				!payManaWithAutoTap(
					actor,
					hybUnlockChoice.resolvedReq,
					state,
					action.costPayment?.phyrexianLifeCount
				)
			) {
				return {
					ok: false,
					error: `Insufficient mana to unlock ${faceDef.name} (requires ${faceDef.characteristics.manaCost}).`
				};
			}
			perm.unlockedFaces = Array.from(new Set([...(perm.unlockedFaces ?? []), action.faceIndex])).sort(
				(a, b) => a - b
			);
			noteLayerInputsChanged(state);
			state.passedPriorityPlayerIds = [];
			addLog(
				state,
				'rule',
				`${actor.username} unlocked ${faceDef.name} on ${perm.card.name} (CR 709.5e).`,
				actorId
			);
			resetTriggerLoopTracking(state);
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
			resetTriggerLoopTracking(state);
			checkStateBasedActions(state);
			return { ok: true };
		}

		case 'hand_special_action': {
			const handIdx = actor.hand.findIndex((c) => c.instanceId === action.instanceId);
			if (handIdx < 0) {
				return { ok: false, error: 'Card not found in your hand.' };
			}
			const inst = actor.hand[handIdx];
			const legality = checkHandSpecialActionLegality(
				state,
				actorId,
				inst,
				action.actionId,
				action.costPayment
			);
			if (!legality.ok) {
				return legality;
			}
			const actionOpt = enumerateHandSpecialActions(effectiveCardForObject(inst)).find(
				(o) => o.id === action.actionId
			)!;
			const topManaStr = actionOpt.costDefs
				.filter((d): d is Extract<CostDef, { k: 'mana' }> => d.k === 'mana')
				.map((d) => d.cost)
				.join('');
			const nonManaDefs = actionOpt.costDefs.filter((d) => d.k !== 'mana');
			const promptName =
				actionOpt.id === 'special:foretell' ? 'Foretell' : `${inst.card.name} (${actionOpt.label})`;
			let effectiveReq = topManaStr ? parseManaCost(topManaStr) : null;
			if (effectiveReq) {
				const phyChoice = maybeAskPhyrexianCostChoice(
					state,
					actor,
					action,
					effectiveReq,
					promptName
				);
				if (phyChoice) return phyChoice;
				const hybChoice = resolveHybridCostChoice(
					state,
					actor,
					action,
					effectiveReq,
					promptName
				);
				if (hybChoice.promptResult) return hybChoice.promptResult;
				effectiveReq = hybChoice.resolvedReq;
			}
			if (nonManaDefs.length > 0) {
				const reservedSelf = new Set<string>([inst.instanceId]);
				const ctx = costContext(
					state,
					actor,
					inst,
					0,
					false,
					effectiveReq,
					action.costPayment?.phyrexianLifeCount,
					undefined,
					reservedSelf
				);
				const plan = planCosts(ctx, nonManaDefs, action.costPayment);
				if (!plan.ok) return { ok: false, error: plan.error };
				if (plan.question) return askCostChoice(state, actor, action, plan.question, promptName);
				const parts = serializeCostPlanParts(ctx, plan);
				const pcp: PendingCostPayment = {
					kind: 'hand_special_action',
					actorId,
					sourceInstanceId: inst.instanceId,
					specialActionId: actionOpt.id,
					sourceCard: inst.card,
					parts,
					manaPaid: plan.mana,
					tapsAndManaDone: false,
					nextPartIndex: 0,
					nextObjectIndex: 0,
					descriptions: []
				};
				return executeOrResumePendingCostPayment(state, pcp, ctx);
			}
			if (
				effectiveReq &&
				!payManaWithAutoTap(
					actor,
					effectiveReq,
					state,
					action.costPayment?.phyrexianLifeCount
				)
			) {
				return {
					ok: false,
					error: `Insufficient mana to pay ${actionOpt.label} (${actionOpt.costDisplay}).`
				};
			}
			completeHandSpecialAction(state, actor, inst, actionOpt.id, []);
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

			// Locate card in hand, command zone, graveyard, playable exile, or top of library
			let inst: CardInstance | undefined;
			let sourcePlayer: PlayerGameState = actor;
			let sourceZone: 'hand' | 'command' | 'exile' | 'graveyard' | 'library' = 'hand';

			const handIdx = actor.hand.findIndex((c) => c.instanceId === action.instanceId);
			if (handIdx >= 0 && (!action.fromZone || action.fromZone === 'hand')) {
				inst = actor.hand[handIdx];
				sourceZone = 'hand';
			} else {
				const cmdIdx = actor.command.findIndex((c) => c.instanceId === action.instanceId);
				if (cmdIdx >= 0 && (!action.fromZone || action.fromZone === 'command')) {
					inst = actor.command[cmdIdx];
					sourceZone = 'command';
				} else {
					const gyIdx = actor.graveyard.findIndex((c) => c.instanceId === action.instanceId);
					if (gyIdx >= 0 && (!action.fromZone || action.fromZone === 'graveyard')) {
						inst = actor.graveyard[gyIdx];
						sourceZone = 'graveyard';
					} else if (!action.fromZone || action.fromZone === 'exile') {
						for (const p of state.players) {
							const exIdx = p.exile.findIndex(
								(c) =>
									c.instanceId === action.instanceId &&
									(c.playableFromExileBy?.playerId === actorId ||
										hasExileKeywordPermission(c, actorId))
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
			}
			// --- Track P8 ---
			if (
				!inst &&
				(!action.fromZone || action.fromZone === 'library') &&
				actor.library[0]?.instanceId === action.instanceId
			) {
				inst = actor.library[0];
				sourcePlayer = actor;
				sourceZone = 'library';
			}

			if (!inst) {
				return {
					ok: false,
					error: 'Card not found in your Hand, Command Zone, Graveyard, or playable Exile.'
				};
			}

			const resolvedOpt = resolveCastOptionForAction(
				state,
				actorId,
				inst,
				sourceZone,
				action.optionId,
				action.faceIndex,
				action.fused
			);
			if (!resolvedOpt.ok) {
				return resolvedOpt;
			}
			const castOption = resolvedOpt.option;
			const optCountsValidation = validateOptionalCostCounts(castOption, action.optionalCostCounts);
			if (!optCountsValidation.ok) {
				return { ok: false, error: optCountsValidation.error };
			}
			const normalizedOptCounts = optCountsValidation.normalized;
			const hasOptCounts = Object.keys(normalizedOptCounts).length > 0;
			const { manaCosts: extraManaCosts, nonManaDefs: extraNonManaDefs } = expandOptionalAdditionalCosts(
				castOption,
				normalizedOptCounts
			);
			const castChoosesX =
				castOption.choosesX ||
				extraManaCosts.some((c) => /\{X\}/i.test(c)) ||
				JSON.stringify(extraNonManaDefs).includes('"k":"x"');
			const rawXVal = action.xValue || 0;
			const xVal = castChoosesX ? rawXVal : 0;
			const legality = checkSpellCastLegality(
				state,
				actorId,
				inst,
				sourceZone,
				xVal,
				castOption.id,
				hasOptCounts ? normalizedOptCounts : undefined,
				undefined,
				undefined,
				action.costAidIds,
				action.costAidColorChoices,
				true
			);
			if (!legality.ok) {
				return legality;
			}

			const spellTargetInfo = getSpellTargetRequirement(
				inst.card,
				castOption,
				hasOptCounts ? normalizedOptCounts : undefined
			);
			const targets = action.targets || [];
			const optFaceIdx = castOption.faceIndex ?? 0;
			const optFused = Boolean(castOption.fused);
			const compiledModal = castOption.spellMods?.castFaceDown
				? undefined
				: compileSpellEffects(inst.card, optFaceIdx, optFused)?.modal;
			const activeSpec = (sp: TargetSpec) =>
				!sp.condition || isCastConditionMet(sp.condition, inst.card, normalizedOptCounts, castOption);
			const chooseAllModes = hasChooseAllModesOptionalCost(
				castOption,
				hasOptCounts ? normalizedOptCounts : undefined
			);
			let chosenModes = action.modes ?? (action as { chosenModes?: number[] }).chosenModes;
			let targetsBySpec: TargetRef[][] | undefined;
			if (compiledModal) {
				const modalVal = validateModalChoice(
					state,
					actorId,
					inst.card,
					inst,
					compiledModal,
					chosenModes,
					targets,
					activeSpec,
					undefined,
					chooseAllModes
				);
				if (!modalVal.ok) return modalVal;
				chosenModes = modalVal.chosenModes;
				targetsBySpec = modalVal.targetsBySpec;
			} else {
				const targetValidation = validateChosenTargets(
					state,
					actorId,
					targets,
					spellTargetInfo,
					inst.card,
					inst.instanceId,
					xVal,
					castOption
				);
				if (!targetValidation.ok) {
					return targetValidation;
				}
				if (!optionTargetsBecomeEach(inst.card, castOption)) {
					targetsBySpec = partitionTargetsBySpecs(targets, spellTargetInfo, inst.card);
				}
			}

			// Check & pay mana cost (including Commander Tax if from Command Zone, or any-color mana if exiled with Opposition Agent!)
			const costReq = getSpellCostRequirementForOption(
				actor,
				inst,
				state,
				xVal,
				castOption,
				hasOptCounts ? normalizedOptCounts : undefined
			);
			const isFaceDownCast = Boolean(castOption.spellMods?.castFaceDown);
			const spendCtx = spellSpendContext(inst, {
				faceIndex: optFaceIdx,
				fused: optFused,
				isFaceDown: isFaceDownCast
			});
			const spellPromptName = isFaceDownCast ? 'Face-Down Spell' : inst.card.name;
			const baseManaDisplay =
				castOption.baseCost.kind === 'alternative'
					? (castOption.baseCost.manaCost ?? '')
					: castOption.baseCost.kind === 'free'
						? ''
						: resolveObjectFaces(effectiveCardForObject(inst), {
								zone: 'stack',
								faceIndex: optFaceIdx,
								fused: optFused
							}).manaCost;
			const displayedManaCost =
				`${baseManaDisplay}${extraManaCosts.join('')}` || (castOption.baseCost.kind === 'free' ? '{0}' : '');
			const manaError = `Insufficient mana to cast ${spellPromptName} (requires ${displayedManaCost || '{0}'}${sourceZone === 'command' && inst.commanderCastCount > 0 ? ` + {${inst.commanderCastCount * state.rules.commanderTaxIncrement}} Commander Tax` : ''}).`;
			const canPayCandidateWithAids = (candidateReq: ManaCostRequirement): boolean => {
				if (action.costAidIds && Object.keys(action.costAidIds).length > 0) {
					const r = applyCastCostAids(
						candidateReq,
						castOption,
						action.costAidIds,
						action.costAidColorChoices
					);
					if (!r.ok) return false;
					const res = new Set<string>([...r.tapIds, ...r.exileIds]);
					return canPayOrAutoTap(
						actor,
						r.remainingReq,
						state,
						action.costPayment?.phyrexianLifeCount,
						spendCtx,
						res
					);
				}
				return canPayManaWithPaymentAids(
					state,
					actor,
					castOption,
					candidateReq,
					spendCtx,
					action.costPayment?.phyrexianLifeCount
				).ok;
			};
			const phySpellChoice = maybeAskPhyrexianCostChoice(
				state,
				actor,
				action,
				costReq,
				spellPromptName,
				spendCtx,
				castOption.paymentAids?.length ? canPayCandidateWithAids : undefined
			);
			if (phySpellChoice) return phySpellChoice;
			const hybSpellChoice = resolveHybridCostChoice(
				state,
				actor,
				action,
				costReq,
				spellPromptName,
				spendCtx,
				castOption.paymentAids?.length ? canPayCandidateWithAids : undefined
			);
			if (hybSpellChoice.promptResult) return hybSpellChoice.promptResult;
			const effectiveCostReq = hybSpellChoice.resolvedReq;

			const aidResult = applyCastCostAids(
				effectiveCostReq,
				castOption,
				action.costAidIds,
				action.costAidColorChoices
			);
			if (!aidResult.ok) {
				return { ok: false, error: aidResult.error };
			}
			const remainingCostReq = aidResult.remainingReq;
			const aidTapIds = aidResult.tapIds;
			const aidExileIds = aidResult.exileIds;
			const reservedAidIds = new Set<string>([...aidTapIds, ...aidExileIds]);
			const tapAidParts: SerializedPlannedCost[] =
				aidTapIds.length > 0
					? [
							{
								def: {
									k: 'tapOthers',
									count: { k: 'const', n: aidTapIds.length },
									filter: { types: ['Creature'] }
								},
								objectIds: aidTapIds,
								objectNames: aidTapIds.map(
									(id) => actor.battlefield.find((c) => c.instanceId === id)?.card.name ?? id
								),
								isCostAid: true
							}
						]
					: [];
			const exileAidParts: SerializedPlannedCost[] =
				aidExileIds.length > 0
					? [
							{
								def: {
									k: 'exileFrom',
									zone: 'graveyard',
									count: { k: 'const', n: aidExileIds.length }
								},
								objectIds: aidExileIds,
								objectNames: aidExileIds.map(
									(id) => actor.graveyard.find((c) => c.instanceId === id)?.card.name ?? id
								),
								isCostAid: true
							}
						]
					: [];

			// Phase 4: additional costs (plus any non-mana alternative costDefs and optional additional costs)
			// from the IR, paid together with the mana (nothing is paid unless everything can be).
			const additional = isFaceDownCast ? null : spellAdditionalCost(inst.card, optFaceIdx, optFused);
			const altCostDefs =
				castOption.baseCost.kind === 'alternative' ? (castOption.baseCost.costDefs ?? []) : [];
			const combinedCostDefs = [
				...altCostDefs,
				...(castOption.mandatoryAdditionalCosts ?? []),
				...extraNonManaDefs
			];
			for (const p of state.players) {
				if (p.lost) continue;
				for (const perm of p.battlefield) {
					if (perm.phasedOut || evaluatePermanent(state, perm).losesAllAbilities) continue;
					if (!targets.some((t) => t.id === perm.instanceId)) continue;
					const pCard = perm.copiableCard ?? perm.card;
					const abilities = activeAbilityDefs(pCard, instanceFaceOptions(perm, 'battlefield'));
					for (const ab of abilities) {
						if (ab.kind !== 'static' || ab.static.k !== 'costModifier') continue;
						const mod = ab.static;
						if (mod.affects.k !== 'spell' || !mod.affects.filter.targetsSelf) continue;
						if (!matchesPlayerFilter(mod.who, perm.controllerId, actor.playerId, state)) continue;
						if (mod.delta.additionalCosts) {
							combinedCostDefs.push(...mod.delta.additionalCosts);
						}
					}
				}
			}
			const paidReturnToHand = hasReturnToHandOptionalCost(castOption, normalizedOptCounts);
			const paidChooseAllModes = hasChooseAllModesOptionalCost(
				castOption,
				hasOptCounts ? normalizedOptCounts : undefined
			);
			const nextSummarySuffix = `${castOption.spellMods?.castSummarySuffix ?? ''}${paidReturnToHand ? ' (Buyback)' : ''}${paidChooseAllModes ? ' (Entwined)' : ''}`;
			const effectiveSpellMods: SpellModifications | undefined =
				paidReturnToHand || paidChooseAllModes
					? {
							...castOption.spellMods,
							...(paidReturnToHand ? { returnToHandOnResolve: true } : {}),
							...(nextSummarySuffix ? { castSummarySuffix: nextSummarySuffix } : {})
						}
					: castOption.spellMods;
			if (combinedCostDefs.length > 0 || tapAidParts.length > 0 || exileAidParts.length > 0) {
				const ctx = costContext(
					state,
					actor,
					inst,
					xVal,
					true,
					remainingCostReq,
					action.costPayment?.phyrexianLifeCount,
					spendCtx,
					reservedAidIds.size > 0 ? reservedAidIds : undefined
				);
				let parts: SerializedPlannedCost[] = [];
				let manaPaid: ManaCostRequirement | null = remainingCostReq;
				if (combinedCostDefs.length > 0) {
					const plan = planCosts(ctx, combinedCostDefs, action.costPayment);
					if (!plan.ok) {
						return { ok: false, error: plan.error.startsWith('Insufficient mana') ? manaError : plan.error };
					}
					if (plan.question) return askCostChoice(state, actor, action, plan.question, spellPromptName);
					parts = serializeCostPlanParts(ctx, plan);
					manaPaid = plan.mana;
				} else if (
					!canPayOrAutoTap(
						actor,
						remainingCostReq,
						state,
						action.costPayment?.phyrexianLifeCount,
						spendCtx,
						reservedAidIds
					)
				) {
					return { ok: false, error: manaError };
				}
				const pcp: PendingCostPayment = {
					kind: 'cast_spell',
					actorId,
					sourceInstanceId: inst.instanceId,
					sourcePlayerId: sourcePlayer.playerId,
					sourceZone,
					targets,
					...(targetsBySpec ? { targetsBySpec } : {}),
					...(chosenModes ? { chosenModes: [...chosenModes] } : {}),
					xValue: xVal,
					castOptionId: castOption.id,
					...(castOption.faceIndex !== undefined ? { faceIndex: castOption.faceIndex } : {}),
					...(castOption.fused ? { fused: true } : {}),
					spellMods: effectiveSpellMods,
					...(hasOptCounts ? { optionalCostCounts: normalizedOptCounts } : {}),
					...(inst.playableFromExileBy?.sourceName
						? { exSourceName: inst.playableFromExileBy.sourceName }
						: {}),
					sourceCard: inst.card,
					additionalIncomplete: Boolean(additional && !additional.complete),
					parts: [...tapAidParts, ...parts, ...exileAidParts],
					manaPaid,
					tapsAndManaDone: false,
					nextPartIndex: 0,
					nextObjectIndex: 0,
					descriptions: [],
					aidDescriptions: []
				};
				return executeOrResumePendingCostPayment(state, pcp, ctx);
			}
			if (
				!payManaWithAutoTap(
					actor,
					remainingCostReq,
					state,
					action.costPayment?.phyrexianLifeCount,
					spendCtx,
					reservedAidIds
				)
			) {
				return { ok: false, error: manaError };
			}
			finalizeCastSpell(state, actor, inst, sourcePlayer, sourceZone, {
				targets,
				targetsBySpec,
				chosenModes,
				xValue: xVal,
				castOptionId: castOption.id,
				faceIndex: castOption.faceIndex,
				fused: castOption.fused,
				spellMods: effectiveSpellMods,
				...(hasOptCounts ? { optionalCostCounts: normalizedOptCounts } : {}),
				additionalIncomplete: Boolean(additional && !additional.complete),
				manaColorsSpent: spendCtx.capturedColorsSpent
			});
			return { ok: true };
		}

		case 'activate_ability': {
			// Locate source card across actor's battlefield or hand and verify zone legality
			const foundTarget = findActivatedAbilityTarget(
				state,
				actor,
				action.instanceId,
				action.abilityId
			);
			if (!foundTarget.ok) {
				return foundTarget;
			}
			const { source: perm, ability: ab } = foundTarget;

			if (ab.isManaAbility) {
				if (perm.zone !== 'battlefield') {
					return { ok: false, error: 'Mana abilities can only be tapped on the battlefield.' };
				}
				return applyGameAction(state, actorId, {
					type: 'tap_mana',
					instanceId: perm.instanceId,
					abilityId: ab.id,
					preferredColor:
						ab.producesMana.length === 1 || actor.isBot ? ab.producesMana[0] : undefined,
					costPayment: action.costPayment
				});
			}

			const abLegality = checkAbilityActivationLegality(state, actorId, perm, ab);
			if (!abLegality.ok) {
				return abLegality;
			}

			const abXValue = Math.max(0, Math.floor(action.xValue ?? 0));
			const abTargetInfo: TargetRequirementInfo = ab.targetInfo;

			const targets = action.targets || [];
			const abModal =
				ab.modal ?? getAbilityModal(perm.card, ab.id, ab.faceIndex ?? 0, ab.grantSourceCard);
			let chosenModes = action.chosenModes;
			let targetsBySpec: TargetRef[][] | undefined;
			if (abModal) {
				const modalVal = validateModalChoice(
					state,
					actorId,
					perm.card,
					perm,
					abModal,
					chosenModes,
					targets,
					() => true,
					perm.usedModalModesThisTurn
				);
				if (!modalVal.ok) return modalVal;
				chosenModes = modalVal.chosenModes;
				targetsBySpec = modalVal.targetsBySpec;
			} else if (ab.requiresTarget || targets.length > 0) {
				const targetValidation = validateChosenTargets(
					state,
					actorId,
					targets,
					abTargetInfo,
					perm.card,
					perm.instanceId,
					abXValue
				);
				if (!targetValidation.ok) {
					return targetValidation;
				}
				targetsBySpec = partitionTargetsBySpecs(targets, abTargetInfo, perm.card);
			}

			// Phase 4: pay the whole cost from the IR. Mana comes from effectiveAbilityManaCost (cost
			// modifiers applied); everything else from the ability's CostDefs.
			const abilityCost = activatedAbilityCost(perm.card, ab);
			const abilityMana = effectiveAbilityManaCost(
				state,
				actorId,
				ab.id,
				ab.manaCost,
				ab.costKeyword,
				abXValue
			).requirement;
			const phyAbilityChoice = maybeAskPhyrexianCostChoice(
				state,
				actor,
				action,
				abilityMana,
				perm.card.name
			);
			if (phyAbilityChoice) return phyAbilityChoice;
			const hybAbilityChoice = resolveHybridCostChoice(
				state,
				actor,
				action,
				abilityMana,
				perm.card.name
			);
			if (hybAbilityChoice.promptResult) return hybAbilityChoice.promptResult;
			const abilityCtx = costContext(
				state,
				actor,
				perm,
				abXValue,
				false,
				hybAbilityChoice.resolvedReq,
				action.costPayment?.phyrexianLifeCount
			);
			const abilityPlan = planCosts(abilityCtx, abilityCost.defs, action.costPayment);
			if (!abilityPlan.ok) return { ok: false, error: abilityPlan.error };
			if (abilityPlan.question) return askCostChoice(state, actor, action, abilityPlan.question, perm.card.name);
			const preCostEval = perm.zone === 'battlefield' ? evaluatePermanent(state, perm) : null;
			const sourceLkiPower = preCostEval ? preCostEval.power : 0;
			const sourceLkiToughness = preCostEval ? preCostEval.toughness : 0;
			const parts = serializeCostPlanParts(abilityCtx, abilityPlan);
			const pcp: PendingCostPayment = {
				kind: 'activate_ability',
				actorId,
				sourceInstanceId: perm.instanceId,
				sourceCard: perm.card,
				abilityId: ab.id,
				...(ab.faceIndex !== undefined ? { faceIndex: ab.faceIndex } : {}),
				...(ab.costKeyword ? { costKeyword: ab.costKeyword } : {}),
				...(abXValue > 0 ? { xValue: abXValue } : {}),
				targets,
				...(targetsBySpec ? { targetsBySpec } : {}),
				...(chosenModes ? { chosenModes: [...chosenModes] } : {}),
				sourceObjectVersion: perm.objectVersion,
				sourceLkiPower,
				sourceLkiToughness,
				...(perm.evoked ? { sourceEvoked: true } : {}),
				...(perm.escaped ? { sourceEscaped: true } : {}),
				...(perm.foretold ? { sourceForetold: true } : {}),
				...(perm.blitzed ? { sourceBlitzed: true } : {}),
				...(perm.exertedThisTurn ? { sourceExertedThisTurn: true } : {}),
				...(perm.chosenSubType ? { sourceChosenSubType: perm.chosenSubType } : {}),
				...(perm.chosenColor ? { sourceChosenColor: perm.chosenColor } : {}),
				onceEachTurn: Boolean(ab.activationRestrictions?.includes('onceEachTurn')),
				effectText: ab.effectText,
				abilityCostIncomplete: !abilityCost.complete,
				...(ab.grantSourceCard ? { grantSourceCard: ab.grantSourceCard } : {}),
				parts,
				manaPaid: abilityPlan.mana,
				tapsAndManaDone: false,
				nextPartIndex: 0,
				nextObjectIndex: 0,
				descriptions: []
			};
			return executeOrResumePendingCostPayment(state, pcp, abilityCtx);
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
			return performDeclareAttackers(state, actor, action.assignments, false);
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

			const validated = validateDefenderBlockerAssignments(state, actor, action.assignments);
			if (!validated.ok) {
				return { ok: false, error: validated.error };
			}

			let allDeclared = false;
			withTriggersDeferred(state, () => {
				applyValidatedDefenderBlockers(state, actor, action.assignments, validated.blockerCountsByAttacker);
				allDeclared = advanceBotBlockerDeclarations(state);
				if (allDeclared) {
					checkStateBasedActions(state);
				}
			});

			if (!allDeclared) {
				const defendersInOrder = getAttackedDefenderIdsInTurnOrder(state);
				const nextUndecidedDefenderId = defendersInOrder.find(
					(defId) => !state.combat.declaredBlockersPlayerIds.includes(defId)
				);
				const nextDefIdx = nextUndecidedDefenderId
					? state.players.findIndex((p) => p.playerId === nextUndecidedDefenderId)
					: -1;
				if (nextDefIdx >= 0) {
					state.priorityPlayerIndex = nextDefIdx;
				} else {
					givePriorityToActiveOrNextPlayer(state);
				}
				state.passedPriorityPlayerIds = [];
				state.priorityUpdatedAt = Date.now();
				return { ok: true };
			}

			// CR 509.1i, 509.2, 117.5: All attacked defenders have declared blockers; put block/phase-begin
			// triggers on the stack in APNAP order before giving priority to the active player.
			emitEvent(state, {
				kind: 'PhaseBegin',
				phase: 'declare_blockers',
				activePlayerId: activePlayer?.playerId ?? null
			});
			flushTriggers(state);
			givePriorityToActiveOrNextPlayer(state);
			state.passedPriorityPlayerIds = [];
			state.priorityUpdatedAt = Date.now();
			checkStateBasedActions(state);
			return { ok: true };
		}

		case 'pass_priority': {
			if (priorityPlayer.playerId !== actorId) {
				return { ok: false, error: 'You do not currently hold priority.' };
			}

			// CR 508.1d / 701.15b / 703.4i: Active player cannot pass out of declare_attackers without declaring attackers
			// if they control a creature that must attack this combat if able.
			if (
				isUnconfirmedAttackersStep(state) &&
				state.stack.length === 0 &&
				actorId === activePlayer.playerId &&
				!actor.isBot
			) {
				const zeroAtkRes = completeUnconfirmedZeroAttackersDeclaration(
					state,
					activePlayer,
					actor
				);
				if (!zeroAtkRes.ok) {
					return zeroAtkRes;
				}
				if (zeroAtkRes.triggeredOrPrompted) {
					state.priorityUpdatedAt = Date.now();
					checkStateBasedActions(state);
					return { ok: true };
				}
			}

			// If an attacked defender passes priority in declare_blockers without having declared blockers yet, record 0 blockers
			if (
				state.phase === 'declare_blockers' &&
				state.stack.length === 0 &&
				!state.combat.blockersDeclared &&
				state.combat.attackers.some((a) => a.defenderPlayerId === actorId)
			) {
				if (!state.combat.declaredBlockersPlayerIds) {
					state.combat.declaredBlockersPlayerIds = [];
				}
				if (!state.combat.declaredBlockersPlayerIds.includes(actorId)) {
					// --- Track P8 (CR 509.1c) ---
					const zeroBlockerCheck = validateDefenderBlockerAssignments(state, actor, []);
					if (!zeroBlockerCheck.ok) {
						return { ok: false, error: zeroBlockerCheck.error };
					}
					let allDeclared = false;
					withTriggersDeferred(state, () => {
						applyValidatedDefenderBlockers(state, actor, [], new Map());
						allDeclared = advanceBotBlockerDeclarations(state);
						if (allDeclared) {
							checkStateBasedActions(state);
						}
					});
					if (!allDeclared) {
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
					} else {
						emitEvent(state, {
							kind: 'PhaseBegin',
							phase: 'declare_blockers',
							activePlayerId: activePlayer?.playerId ?? null
						});
						flushTriggers(state);
						givePriorityToActiveOrNextPlayer(state);
						state.passedPriorityPlayerIds = [];
						state.priorityUpdatedAt = Date.now();
						checkStateBasedActions(state);
						return { ok: true };
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

			// CR 508.1d / 701.15b / 703.4i: Mandatory attack requirements cannot be bypassed by ending the turn
			// before attackers have been declared in combat.
			const preCombatOrUnconfirmedAttackers =
				state.phase === 'upkeep' ||
				state.phase === 'draw' ||
				state.phase === 'main1' ||
				state.phase === 'begin_combat' ||
				isUnconfirmedAttackersStep(state);
			if (preCombatOrUnconfirmedAttackers) {
				const violation = findMandatoryAttackerViolation(state, activePlayer);
				if (violation) {
					return { ok: false, error: violation };
				}
			}

			addLog(state, 'rule', `${actor.username} ended their turn.`, actorId);

			// CR 500.2 / 513.1: Advance step-by-step through remaining phases/steps of the turn, running
			// turn-based actions and step-begin triggers and passing priority around the table in each step.
			const startingTurnNumber = state.turnNumber;
			const startingActiveIndex = state.activePlayerIndex;
			let safety = 0;

			while (
				state.status === 'active' &&
				state.turnNumber === startingTurnNumber &&
				state.activePlayerIndex === startingActiveIndex &&
				state.stack.length === 0 &&
				state.pendingPrompts.length === 0 &&
				safety < 32
			) {
				safety += 1;

				// Re-check mandatory attack requirements before leaving declare_attackers with 0 attackers
				// (e.g. if an intermediate step's trigger created/untapped/goaded a creature).
				if (isUnconfirmedAttackersStep(state)) {
					const zeroAtkRes = completeUnconfirmedZeroAttackersDeclaration(state, activePlayer);
					if (!zeroAtkRes.ok || zeroAtkRes.triggeredOrPrompted) {
						break;
					}
				}

				if (!state.passedPriorityPlayerIds.includes(actorId)) {
					state.passedPriorityPlayerIds.push(actorId);
				}

				let stoppedOnOpponent = false;
				const count = state.players.length;
				for (let step = 1; step < count; step++) {
					const oppIdx = (state.activePlayerIndex + step) % count;
					const opp = state.players[oppIdx];
					if (!opp || opp.lost) continue;
					if (state.passedPriorityPlayerIds.includes(opp.playerId)) continue;

					const isDefendingInBlockers =
						state.phase === 'declare_blockers' &&
						state.combat.attackers.some((a) => a.defenderPlayerId === opp.playerId) &&
						!(state.combat.declaredBlockersPlayerIds || []).includes(opp.playerId);
					const hasExplicitPhaseStop = opp.stopPhases.includes(state.phase);
					const wantsPriority =
						isDefendingInBlockers ||
						(!opp.isBot &&
							(opp.fullControl || !opp.autoPassEmptyStack || hasExplicitPhaseStop));

					if (wantsPriority) {
						state.priorityPlayerIndex = oppIdx;
						stoppedOnOpponent = true;
						break;
					}

					state.passedPriorityPlayerIds.push(opp.playerId);
				}

				if (stoppedOnOpponent) {
					break;
				}

				state.passedPriorityPlayerIds = [];
				advancePhaseOrStep(state);

				if (
					state.status === 'active' &&
					state.turnNumber === startingTurnNumber &&
					state.activePlayerIndex === startingActiveIndex &&
					state.priorityPlayerIndex === state.activePlayerIndex &&
					activePlayer.stopPhases.includes(state.phase)
				) {
					break;
				}
			}

			state.priorityUpdatedAt = Date.now();
			checkStateBasedActions(state);
			return { ok: true };
		}

		default:
			return { ok: false, error: `Action ${action.type} is not valid right now.` };
	}
}

function chooseBotRequiredAttackAssignments(
	state: GameState,
	bot: PlayerGameState
): Array<{ attackerInstanceId: string; defenderPlayerId: string; defenderPlaneswalkerId?: string | null }> {
	const opponents = state.players
		.filter((p) => p.playerId !== bot.playerId && !p.lost)
		.sort((a, b) => b.life - a.life);
	if (opponents.length === 0) return [];
	const taxFreeOpponents = opponents.filter((p) => getAttackTaxGeneric(state, p) === 0);
	if (taxFreeOpponents.length === 0) return [];

	return withStableLayerInputs(state, () => {
		const assignments: Array<{
			attackerInstanceId: string;
			defenderPlayerId: string;
			defenderPlaneswalkerId?: string | null;
		}> = [];
		for (const c of bot.battlefield) {
			if (
				c.phasedOut ||
				!evaluatePermanent(state, c).isCreature ||
				c.tapped ||
				(c.summoningSick && !hasKeyword(c, 'Haste', state)) ||
				hasKeyword(c, 'Defender', state) ||
				hasRestriction(state, c, 'cantAttack')
			) {
				continue;
			}
			const isGoaded = Boolean(c.goadedByPlayerIds && c.goadedByPlayerIds.length > 0);
			const mustAttack = isGoaded || hasRestriction(state, c, 'attacksEachCombat');
			if (!mustAttack) continue;

			let candidateDefenders = taxFreeOpponents.filter(
				(p) => getStaticAttackRestrictionReason(state, c, p.playerId) === null
			);
			if (candidateDefenders.length === 0) continue;
			if (isGoaded) {
				const nonGoaders = candidateDefenders.filter(
					(p) => !c.goadedByPlayerIds!.includes(p.playerId)
				);
				if (nonGoaders.length > 0) {
					candidateDefenders = nonGoaders;
				}
			}
			const idx = assignments.length;
			const nextCandidate = [
				...assignments,
				{
					attackerInstanceId: c.instanceId,
					defenderPlayerId: candidateDefenders[idx % candidateDefenders.length]!.playerId
				}
			];
			if (getGlobalAttackCapError(state, nextCandidate) !== null) continue;
			assignments.push(nextCandidate[nextCandidate.length - 1]!);
		}
		// CR 508.1c–d: If a single required creature has cantAttackAlone, join another legal creature if possible; else return [].
		if (assignments.length === 1) {
			const solePerm = bot.battlefield.find(
				(c) => c.instanceId === assignments[0]!.attackerInstanceId
			);
			if (solePerm && permanentCantAttackAlone(state, solePerm)) {
				let partnerAdded = false;
				for (const other of bot.battlefield) {
					if (
						other.instanceId === solePerm.instanceId ||
						other.phasedOut ||
						!evaluatePermanent(state, other).isCreature ||
						other.tapped ||
						(other.summoningSick && !hasKeyword(other, 'Haste', state)) ||
						hasKeyword(other, 'Defender', state) ||
						hasRestriction(state, other, 'cantAttack')
					) {
						continue;
					}
					const partnerDef = taxFreeOpponents.find(
						(p) => getStaticAttackRestrictionReason(state, other, p.playerId, 2) === null
					);
					if (!partnerDef) continue;
					const pair = [
						assignments[0]!,
						{ attackerInstanceId: other.instanceId, defenderPlayerId: partnerDef.playerId }
					];
					if (getGlobalAttackCapError(state, pair) === null) {
						assignments.push(pair[1]!);
						partnerAdded = true;
						break;
					}
				}
				if (!partnerAdded) return [];
			}
		}
		return assignments;
	});
}

export function chooseBotAttackAssignments(
	state: GameState,
	bot: PlayerGameState
): Array<{ attackerInstanceId: string; defenderPlayerId: string; defenderPlaneswalkerId?: string | null }> {
	const opponents = state.players
		.filter((p) => p.playerId !== bot.playerId && !p.lost)
		.sort((a, b) => b.life - a.life);
	if (opponents.length === 0) return [];

	const requiredAssignments = chooseBotRequiredAttackAssignments(state, bot);
	const requiredIds = new Set(requiredAssignments.map((a) => a.attackerInstanceId));

	const optionalAttackers = withStableLayerInputs(state, () =>
		bot.battlefield.filter(
			(c) =>
				!requiredIds.has(c.instanceId) &&
				!c.phasedOut &&
				evaluatePermanent(state, c).isCreature &&
				!c.tapped &&
				(!c.summoningSick || hasKeyword(c, 'Haste', state)) &&
				!hasKeyword(c, 'Defender', state) &&
				!hasRestriction(state, c, 'cantAttack') &&
				getCreaturePower(c, state) >= 2
		)
	);

	const assignments = [...requiredAssignments];
	for (const atk of optionalAttackers) {
		const legalOpponents = opponents.filter(
			(p) => getStaticAttackRestrictionReason(state, atk, p.playerId) === null
		);
		if (legalOpponents.length === 0) continue;
		const idx = assignments.length;
		const nextCandidate = [
			...assignments,
			{
				attackerInstanceId: atk.instanceId,
				defenderPlayerId: legalOpponents[idx % legalOpponents.length]!.playerId
			}
		];
		if (getGlobalAttackCapError(state, nextCandidate) !== null) continue;
		assignments.push(nextCandidate[nextCandidate.length - 1]!);
	}
	if (assignments.length === 1) {
		const solePerm = bot.battlefield.find(
			(c) => c.instanceId === assignments[0]!.attackerInstanceId
		);
		if (solePerm && permanentCantAttackAlone(state, solePerm)) {
			return requiredAssignments;
		}
	}
	return assignments;
}

function executeBotDeclareAttackersTurnBasedAction(
	state: GameState,
	bot: PlayerGameState
): void {
	const assignments = chooseBotAttackAssignments(state, bot);
	let res = performDeclareAttackers(state, bot, assignments, true);
	if (!res.ok) {
		const requiredOnly = chooseBotRequiredAttackAssignments(state, bot);
		res = performDeclareAttackers(state, bot, requiredOnly, true);
	}
	if (!res.ok) {
		addLog(
			state,
			'rule',
			res.error ?? `${bot.username} could not satisfy attack requirements; declaring no attackers.`,
			bot.playerId
		);
		// Last resort: declare no attackers through the normal path so combat state is reset the same way.
		performDeclareAttackers(state, bot, [], true, true);
	}
}

function performDeclareAttackers(
	state: GameState,
	actor: PlayerGameState,
	assignments: Array<{
		attackerInstanceId: string;
		defenderPlayerId: string;
		defenderPlaneswalkerId?: string | null;
	}>,
	fromPhaseEntry: boolean,
	/** Only for the bot's last-resort empty declaration, after a 'rule' line has been logged. */
	ignoreAttackRequirements = false
): { ok: boolean; error?: string } {
	const actorId = actor.playerId;
	const validAttackers = [];
	let totalPropagandaTaxGeneric = 0;
	const seenAttackerIds = new Set<string>();

	for (const assign of assignments) {
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

		// --- Track P8 (CR 508.1c) ---
		const staticAtkErr = getStaticAttackRestrictionReason(
			state,
			creature,
			defender.playerId,
			assignments.length
		);
		if (staticAtkErr) {
			return { ok: false, error: staticAtkErr };
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
					getAttackTaxGeneric(state, p) === 0 &&
					getStaticAttackRestrictionReason(
						state,
						creature,
						p.playerId,
						Math.max(assignments.length, 1)
					) === null
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

	// --- Track P8 (CR 508.1c): Global attacker caps (Silent Arbiter / Dueling Grounds / Crawlspace) ---
	const globalAtkCapErr = getGlobalAttackCapError(state, assignments);
	if (globalAtkCapErr) {
		return { ok: false, error: globalAtkCapErr };
	}

	// Enforce Goad / Attack requirements (CR 508.1d: must satisfy as many requirements as possible without violating restrictions)
	const assignedIds = new Set(assignments.map((a) => a.attackerInstanceId));
	const mandatoryViolation = ignoreAttackRequirements
		? null
		: findMandatoryAttackerViolation(state, actor, assignedIds, assignments);
	if (mandatoryViolation) {
		return { ok: false, error: mandatoryViolation };
	}

	// Pay attack tax if applicable
	if (totalPropagandaTaxGeneric > 0) {
		const taxReq = parseManaCost(`{${totalPropagandaTaxGeneric}}`);
		if (!payManaWithAutoTap(actor, taxReq, state)) {
			const taxSources = Array.from(
				new Set(
					assignments
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
		for (const assign of assignments) {
			const creature = actor.battlefield.find(
				(c) => c.instanceId === assign.attackerInstanceId
			)!;
			if (hasKeyword(creature, 'Vigilance', state)) ids.add(creature.instanceId);
		}
		return ids;
	});
	for (const assign of assignments) {
		const creature = actor.battlefield.find(
			(c) => c.instanceId === assign.attackerInstanceId
		)!;
		const defender = state.players.find(
			(p) => p.playerId === assign.defenderPlayerId && !p.lost
		)!;
		if (!vigilantIds.has(creature.instanceId)) {
			tapPermanent(state, creature);
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

	const wasAwaiting = Boolean(state.combat.awaitingAttackersDeclaration);
	state.combat.active = true;
	state.combat.awaitingAttackersDeclaration = false;
	state.combat.attackers = validAttackers;
	state.combat.declaredBlockersPlayerIds = [];
	state.combat.blockersDeclared = false;
	state.combat.damageDealtFirstStrike = false;
	state.combat.damageDealtNormal = false;
	state.combat.dealtFirstStrikeDamageIds = [];
	noteLayerInputsChanged(state);

	resetTriggerLoopTracking(state);
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
	} else {
		addLog(state, 'combat', `${actor.username} declared no attackers.`, actorId);
	}

	if (!fromPhaseEntry) {
		if (wasAwaiting) {
			emitEvent(state, {
				kind: 'PhaseBegin',
				phase: 'declare_attackers',
				activePlayerId: actor.playerId
			});
		}
		flushTriggers(state);
		// CR 508.2: Active player receives priority in declare_attackers after attackers are declared
		givePriorityToActiveOrNextPlayer(state);
		state.passedPriorityPlayerIds = [];
		state.priorityUpdatedAt = Date.now();
		checkStateBasedActions(state);
	}
	return { ok: true };
}

function getPendingCombatDeclarationError(state: GameState): string | null {
	if (state.phase === 'declare_attackers' && state.combat.awaitingAttackersDeclaration) {
		return 'Attackers must be declared before players receive priority in the Declare Attackers step (CR 508.1, 508.2).';
	}
	if (
		state.phase === 'declare_blockers' &&
		state.combat.active &&
		state.combat.attackers.length > 0 &&
		!state.combat.blockersDeclared
	) {
		return 'Blockers must be declared before players receive priority in the Declare Blockers step (CR 509.1, 509.2).';
	}
	return null;
}

export function isCombatDeclarationPending(state: GameState): boolean {
	return getPendingCombatDeclarationError(state) !== null;
}

function isUnconfirmedAttackersStep(state: GameState): boolean {
	return state.phase === 'declare_attackers' && !state.combat.active;
}

function completeUnconfirmedZeroAttackersDeclaration(
	state: GameState,
	activePlayer: PlayerGameState,
	logActor?: PlayerGameState
): { ok: true; triggeredOrPrompted: boolean } | { ok: false; error: string } {
	const violation = findMandatoryAttackerViolation(state, activePlayer);
	if (violation) {
		return { ok: false, error: violation };
	}
	const wasAwaiting = Boolean(state.combat.awaitingAttackersDeclaration);
	state.combat.active = true;
	state.combat.awaitingAttackersDeclaration = false;
	state.combat.attackers = [];
	state.combat.declaredBlockersPlayerIds = [];
	state.combat.blockersDeclared = false;
	noteLayerInputsChanged(state);
	if (logActor) {
		addLog(state, 'combat', `${logActor.username} declared no attackers.`, logActor.playerId);
	}
	if (wasAwaiting) {
		emitEvent(state, {
			kind: 'PhaseBegin',
			phase: 'declare_attackers',
			activePlayerId: activePlayer.playerId
		});
		flushTriggers(state);
		if (state.stack.length > 0 || state.pendingPrompts.length > 0) {
			givePriorityToActiveOrNextPlayer(state);
			state.passedPriorityPlayerIds = [];
			return { ok: true, triggeredOrPrompted: true };
		}
	}
	return { ok: true, triggeredOrPrompted: false };
}

function getBlockerRestrictionReason(
	state: GameState,
	blocker: CardInstance,
	attacker: CardInstance
): string | null {
	if (
		hasKeyword(attacker, 'Flying', state) &&
		!hasKeyword(blocker, 'Flying', state) &&
		!hasKeyword(blocker, 'Reach', state)
	) {
		return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} (has Flying; blocker needs Flying or Reach).`;
	}
	if (hasRestriction(state, attacker, 'cantBeBlocked')) {
		return `Strict Rules Violation: ${attacker.card.name} cannot be blocked.`;
	}
	if (hasProtectionFrom(attacker, blocker.copiableCard ?? blocker.card, state, blocker)) {
		return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} due to Protection (CR 702.16e).`;
	}
	if (hasKeyword(attacker, 'Fear', state)) {
		const evalBlocker = evaluatePermanent(state, blocker);
		if (!evalBlocker.isArtifact && !evalBlocker.colors.includes('B')) {
			return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} (has Fear; blocker must be an artifact creature and/or black creature, CR 702.36b).`;
		}
	}
	if (hasKeyword(attacker, 'Intimidate', state)) {
		const evalAtk = evaluatePermanent(state, attacker);
		const evalBlocker = evaluatePermanent(state, blocker);
		if (
			!evalBlocker.isArtifact &&
			!evalAtk.colors.some((c) => evalBlocker.colors.includes(c))
		) {
			return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} (has Intimidate; blocker must be an artifact creature and/or share a color with it, CR 702.13b).`;
		}
	}
	if (hasKeyword(attacker, 'Shadow', state) !== hasKeyword(blocker, 'Shadow', state)) {
		return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} due to Shadow (CR 702.28b).`;
	}
	if (hasKeyword(attacker, 'Horsemanship', state) && !hasKeyword(blocker, 'Horsemanship', state)) {
		return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} (has Horsemanship, CR 702.31b).`;
	}
	const evalAttackerLandwalk = evaluatePermanent(state, attacker);
	const defendingPlayer = state.players.find((p) => p.playerId === blocker.controllerId);
	if (defendingPlayer) {
		const defPermanents = defendingPlayer.battlefield.filter((perm) => !perm.phasedOut);
		for (const kw of evalAttackerLandwalk.activeKeywords) {
			const spec = getKeywordSpec(kw);
			if (
				spec?.status === 'implemented' &&
				spec.implementation?.kind === 'primitive' &&
				spec.implementation.landwalkFilter
			) {
				const landFilter = spec.implementation.landwalkFilter;
				if (
					defPermanents.some((perm) =>
						matchesObjectFilter(perm, landFilter, { state, controllerId: defendingPlayer.playerId })
					)
				) {
					return `Strict Rules Violation: ${blocker.card.name} cannot block ${attacker.card.name} (has ${spec.displayLabel ?? kw}, CR 702.14c).`;
				}
			}
		}
	}
	// --- Track P8 (CR 509.1b, 702.118b) ---
	return getStaticBlockerPairRestrictionReason(state, blocker, attacker);
}

export function canBlock(
	state: GameState,
	blocker: CardInstance,
	attacker: CardInstance
): boolean {
	return getBlockerRestrictionReason(state, blocker, attacker) === null;
}

export function chooseBotBlockAssignments(
	state: GameState,
	bot: PlayerGameState
): Array<{ blockerInstanceId: string; attackerInstanceId: string }> {
	const attacksAgainstBot = state.combat.attackers.filter(
		(a) => a.defenderPlayerId === bot.playerId
	);
	if (attacksAgainstBot.length === 0) return [];
	return withStableLayerInputs(state, () => {
		const assignments: Array<{ blockerInstanceId: string; attackerInstanceId: string }> = [];
		const usedBlockers = new Set<string>();

		for (const atk of attacksAgainstBot) {
			if (atk.blockerInstanceIds.length > 0) continue;
			const atkOwner = state.players.find((p) => p.playerId === atk.controllerId);
			const atkCard = atkOwner?.battlefield.find(
				(c) => !c.phasedOut && c.instanceId === atk.attackerInstanceId
			);
			if (!atkCard) continue;
			if (hasRestriction(state, atkCard, 'cantBeBlocked')) continue;
			if (hasKeyword(atkCard, 'Menace', state)) continue;

			const candidate = bot.battlefield.find((b) => {
				if (b.phasedOut || usedBlockers.has(b.instanceId) || b.tapped) return false;
				const evalBlocker = evaluatePermanent(state, b);
				if (!evalBlocker.isCreature) return false;
				if (hasRestriction(state, b, 'cantBlock')) return false;
				if (!canBlock(state, b, atkCard)) return false;
				const bTough = getCreatureToughness(b, state);
				const aPwr = getCreaturePower(atkCard, state);
				return bTough > aPwr || aPwr >= 4 || bot.life <= aPwr;
			});

			if (candidate) {
				usedBlockers.add(candidate.instanceId);
				assignments.push({
					blockerInstanceId: candidate.instanceId,
					attackerInstanceId: atk.attackerInstanceId
				});
			}
		}

		// CR 509.1c: Include any remaining untapped creatures that must block each combat if able.
		for (const b of bot.battlefield) {
			if (b.phasedOut || usedBlockers.has(b.instanceId) || b.tapped) continue;
			const evalBlocker = evaluatePermanent(state, b);
			if (!evalBlocker.isCreature) continue;
			if (hasRestriction(state, b, 'cantBlock')) continue;
			if (!hasRestriction(state, b, 'blocksEachCombat')) continue;

			const legalAtks = attacksAgainstBot.filter((atk) => {
				const atkOwner = state.players.find((p) => p.playerId === atk.controllerId);
				const atkCard = atkOwner?.battlefield.find(
					(c) => !c.phasedOut && c.instanceId === atk.attackerInstanceId
				);
				if (!atkCard) return false;
				if (!canBlock(state, b, atkCard)) return false;
				if (hasKeyword(atkCard, 'Menace', state)) {
					const alreadyAssigned = assignments.some(
						(a) => a.attackerInstanceId === atk.attackerInstanceId
					);
					if (!alreadyAssigned) return false;
				}
				return true;
			});
			if (legalAtks.length > 0) {
				const chosenAtk =
					legalAtks.find(
						(atk) => !assignments.some((a) => a.attackerInstanceId === atk.attackerInstanceId)
					) ?? legalAtks[0]!;
				usedBlockers.add(b.instanceId);
				assignments.push({
					blockerInstanceId: b.instanceId,
					attackerInstanceId: chosenAtk.attackerInstanceId
				});
			}
		}

		return assignments;
	});
}

function validateDefenderBlockerAssignments(
	state: GameState,
	actor: PlayerGameState,
	assignments: Array<{ blockerInstanceId: string; attackerInstanceId: string }>
):
	| { ok: true; blockerCountsByAttacker: Map<string, string[]> }
	| { ok: false; error: string } {
	// --- Track P8 (CR 509.1a–c) ---
	const res = validateAndSolveDefenderBlockersP8(
		state,
		actor,
		assignments,
		getBlockerRestrictionReason
	);
	return res.ok
		? { ok: true, blockerCountsByAttacker: res.blockerCountsByAttacker }
		: { ok: false, error: res.error };
}

function applyValidatedDefenderBlockers(
	state: GameState,
	actor: PlayerGameState,
	assignments: Array<{ blockerInstanceId: string; attackerInstanceId: string }>,
	blockerCountsByAttacker: Map<string, string[]>
): void {
	const actorId = actor.playerId;
	for (const atkEntry of state.combat.attackers) {
		if (atkEntry.defenderPlayerId === actorId) {
			atkEntry.blockerInstanceIds =
				blockerCountsByAttacker.get(atkEntry.attackerInstanceId) || [];
			if (atkEntry.blockerInstanceIds.length > 0) {
				atkEntry.wasBlocked = true;
			}
		}
	}
	noteLayerInputsChanged(state);

	if (!state.combat.declaredBlockersPlayerIds) {
		state.combat.declaredBlockersPlayerIds = [];
	}
	if (!state.combat.declaredBlockersPlayerIds.includes(actorId)) {
		state.combat.declaredBlockersPlayerIds.push(actorId);
	}

	resetTriggerLoopTracking(state);
	if (assignments.length > 0) {
		addLog(
			state,
			'combat',
			`${actor.username} declared ${assignments.length} blocker(s).`,
			actorId
		);
		emitVfx(state, {
			kind: 'block_declare',
			sourceId: actorId,
			amount: assignments.length
		});
		emitEvent(state, {
			kind: 'BlockersDeclared',
			playerId: actorId,
			blocks: assignments.map((a) => ({
				blockerId: a.blockerInstanceId,
				attackerId: a.attackerInstanceId
			}))
		});
	} else {
		addLog(state, 'combat', `${actor.username} declared no blockers.`, actorId);
	}
}

/**
 * Advances through any consecutive bot defenders in turn order during the declare_blockers
 * turn-based action (CR 509.1, 703.4j). Returns true if all attacked defenders have now
 * declared blockers, or false if an undecided human defender must declare blockers next.
 */
function advanceBotBlockerDeclarations(state: GameState): boolean {
	if (!state.combat.declaredBlockersPlayerIds) {
		state.combat.declaredBlockersPlayerIds = [];
	}
	const defendersInOrder = getAttackedDefenderIdsInTurnOrder(state);
	for (const defId of defendersInOrder) {
		if (state.combat.declaredBlockersPlayerIds.includes(defId)) continue;
		const defPlayer = state.players.find((p) => p.playerId === defId && !p.lost);
		if (!defPlayer) {
			state.combat.declaredBlockersPlayerIds.push(defId);
			continue;
		}
		if (!defPlayer.isBot) {
			state.combat.blockersDeclared = false;
			return false;
		}
		let assignments = chooseBotBlockAssignments(state, defPlayer);
		let validated = validateDefenderBlockerAssignments(state, defPlayer, assignments);
		while (!validated.ok && assignments.length > 0) {
			let removedIndex = -1;
			for (let i = assignments.length - 1; i >= 0; i--) {
				const candidate = assignments.filter((_, idx) => idx !== i);
				const check = validateDefenderBlockerAssignments(state, defPlayer, candidate);
				if (check.ok) {
					assignments = candidate;
					validated = check;
					removedIndex = i;
					break;
				}
			}
			if (validated.ok) break;
			for (let i = assignments.length - 1; i >= 0; i--) {
				const single = [assignments[i]!];
				const blocker = defPlayer.battlefield.find(
					(c) => c.instanceId === single[0]!.blockerInstanceId
				);
				const atkEntry = state.combat.attackers.find(
					(a) => a.attackerInstanceId === single[0]!.attackerInstanceId
				);
				const atkOwner = state.players.find((p) => p.playerId === atkEntry?.controllerId);
				const atkCard = atkOwner?.battlefield.find(
					(c) => c.instanceId === atkEntry?.attackerInstanceId
				);
				if (
					!blocker ||
					blocker.phasedOut ||
					blocker.tapped ||
					!evaluatePermanent(state, blocker).isCreature ||
					hasRestriction(state, blocker, 'cantBlock') ||
					!atkEntry ||
					atkEntry.defenderPlayerId !== defPlayer.playerId ||
					(atkCard && !canBlock(state, blocker, atkCard))
				) {
					removedIndex = i;
					break;
				}
			}
			if (removedIndex < 0) {
				removedIndex = assignments.length - 1;
			}
			assignments = assignments.filter((_, idx) => idx !== removedIndex);
			validated = validateDefenderBlockerAssignments(state, defPlayer, assignments);
		}
		if (!validated.ok) {
			// --- Track P8 (CR 509.1c): Use exact maximum-requirement solver assignment ---
			const solved = validateAndSolveDefenderBlockersP8(
				state,
				defPlayer,
				[],
				getBlockerRestrictionReason
			);
			if (solved.ok) {
				applyValidatedDefenderBlockers(
					state,
					defPlayer,
					[],
					solved.blockerCountsByAttacker
				);
			} else {
				const optValidated = validateDefenderBlockerAssignments(
					state,
					defPlayer,
					solved.bestLegalAssignment
				);
				if (optValidated.ok) {
					applyValidatedDefenderBlockers(
						state,
						defPlayer,
						solved.bestLegalAssignment,
						optValidated.blockerCountsByAttacker
					);
				} else {
					addLog(state, 'rule', validated.error, defPlayer.playerId);
					applyValidatedDefenderBlockers(state, defPlayer, [], new Map());
				}
			}
		} else {
			applyValidatedDefenderBlockers(
				state,
				defPlayer,
				assignments,
				validated.blockerCountsByAttacker
			);
		}
	}
	state.combat.blockersDeclared = true;
	return true;
}

function findMandatoryAttackerViolation(
	state: GameState,
	actor: PlayerGameState,
	assignedIds: Set<string> = new Set(),
	currentAssignments: ReadonlyArray<{
		attackerInstanceId: string;
		defenderPlayerId: string;
		defenderPlaneswalkerId?: string | null;
	}> = []
): string | null {
	return withStableLayerInputs(state, () => {
		const taxFreeOpponents = state.players.filter(
			(p) => p.playerId !== actor.playerId && !p.lost && getAttackTaxGeneric(state, p) === 0
		);
		if (taxFreeOpponents.length === 0) return null;

		for (const perm of actor.battlefield) {
			if (perm.phasedOut || !evaluatePermanent(state, perm).isCreature) continue;
			const isGoaded = Boolean(perm.goadedByPlayerIds && perm.goadedByPlayerIds.length > 0);
			const mustAttack = isGoaded || hasRestriction(state, perm, 'attacksEachCombat');
			if (mustAttack && !assignedIds.has(perm.instanceId)) {
				const canAttack =
					!perm.tapped &&
					(!perm.summoningSick || hasKeyword(perm, 'Haste', state)) &&
					!hasKeyword(perm, 'Defender', state) &&
					!hasRestriction(state, perm, 'cantAttack');
				if (!canAttack) continue;

				// --- Track P8 (CR 508.1c–d): Check defender-specific restrictions, cantAttackAlone, and global caps ---
				const legalDefender = taxFreeOpponents.find((p) => {
					if (getStaticAttackRestrictionReason(state, perm, p.playerId) !== null) return false;
					if (currentAssignments.length > 0) {
						return (
							getGlobalAttackCapError(state, [
								...currentAssignments,
								{ attackerInstanceId: perm.instanceId, defenderPlayerId: p.playerId }
							]) === null
						);
					}
					return (
						getGlobalAttackCapError(state, [
							{ attackerInstanceId: perm.instanceId, defenderPlayerId: p.playerId }
						]) === null
					);
				});
				if (!legalDefender) continue;

				if (assignedIds.size === 0 && permanentCantAttackAlone(state, perm)) {
					const hasLegalPartner = actor.battlefield.some((other) => {
						if (
							other.instanceId === perm.instanceId ||
							other.phasedOut ||
							!evaluatePermanent(state, other).isCreature ||
							other.tapped ||
							(other.summoningSick && !hasKeyword(other, 'Haste', state)) ||
							hasKeyword(other, 'Defender', state) ||
							hasRestriction(state, other, 'cantAttack')
						) {
							return false;
						}
						return taxFreeOpponents.some(
							(p) =>
								getStaticAttackRestrictionReason(state, other, p.playerId, 2) === null &&
								getGlobalAttackCapError(state, [
									{
										attackerInstanceId: perm.instanceId,
										defenderPlayerId: legalDefender.playerId
									},
									{ attackerInstanceId: other.instanceId, defenderPlayerId: p.playerId }
								]) === null
						);
					});
					if (!hasLegalPartner) continue;
				}

				return `Strict Rules Violation: ${perm.card.name} ${isGoaded ? 'is Goaded and ' : ''}must attack this combat if able.`;
			}
		}
		return null;
	});
}

function handleMulliganAction(
	state: GameState,
	actor: PlayerGameState,
	action: GameActionPayload
): { ok: boolean; error?: string } {
	const prIdx = state.pendingPrompts.findIndex((p) => p.playerId === actor.playerId);
	if (action.type === 'choice') {
		const pr = state.pendingPrompts.find(
			(p) => p.playerId === actor.playerId && p.id === action.promptId
		);
		if (!pr) {
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
		return { ok: false, error: 'Invalid choice for mulligan prompt.' };
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
		const bottomIdx = state.pendingPrompts.findIndex(
			(p) => p.playerId === actor.playerId && p.kind === 'london_bottom'
		);
		const pr = bottomIdx >= 0 ? state.pendingPrompts[bottomIdx] : undefined;
		if (!pr) {
			return { ok: false, error: 'No London Mulligan bottom prompt active.' };
		}
		const required = pr.countRequired ?? 1;
		const ids = Array.isArray(action.instanceIds) ? action.instanceIds : [];
		if (ids.length !== required) {
			return { ok: false, error: `Please select exactly ${required} card(s).` };
		}
		const seen = new Set<string>();
		const allowedCandidates =
			pr.candidateInstanceIds && pr.candidateInstanceIds.length > 0
				? new Set(pr.candidateInstanceIds)
				: pr.choice?.kind === 'chooseObjects'
					? new Set(pr.choice.candidates)
					: null;
		const handIds = new Set(actor.hand.map((c) => c.instanceId));
		for (const id of ids) {
			if (seen.has(id)) {
				return { ok: false, error: 'Duplicate object IDs are not allowed.' };
			}
			seen.add(id);
			if ((allowedCandidates && !allowedCandidates.has(id)) || !handIds.has(id)) {
				return {
					ok: false,
					error: 'Strict Rules Violation: Chosen card is not eligible for London bottom.'
				};
			}
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
		state.pendingPrompts.splice(bottomIdx, 1);
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

	// Steps C+D: triggered-ability target, order and legacy leading-"you may" prompts.
	// Prompts with a `continuation` (such as IR `effect_choice` optional steps) flow below.
	if (
		!prompt.continuation &&
		(purpose === 'trigger_modes' ||
			purpose === 'trigger_targets' ||
			purpose === 'trigger_order' ||
			purpose === 'trigger_may')
	) {
		return resolveTriggerPrompt(state, prompt, promptIdx, normalized.answer);
	}

	// Phase 4/8: a cost choice. The answer is merged into the waiting action's costPayment and the
	// action runs again from scratch (re-checking legality); on failure the prompt is restored.
	if (purpose === 'cost_choice') {
		const pending = prompt.pendingAction;
		if (normalized.cancel) {
			state.pendingPrompts.splice(promptIdx, 1);
			return { ok: true };
		}
		if (
			!pending ||
			(pending.type !== 'cast_spell' &&
				pending.type !== 'activate_ability' &&
				pending.type !== 'tap_mana' &&
				pending.type !== 'turn_face_up' &&
				pending.type !== 'unlock_room_door' &&
				pending.type !== 'hand_special_action')
		) {
			return { ok: false, error: 'Invalid or stale cost choice prompt.' };
		}
		const valid = validateChoiceAnswer(choice, normalized.answer);
		if (!valid.ok) {
			return { ok: false, error: valid.error };
		}
		state.pendingPrompts.splice(promptIdx, 1);
		const payment: CostPayment = {
			options: [...(pending.costPayment?.options ?? [])],
			objects: [...(pending.costPayment?.objects ?? [])],
			...(pending.costPayment?.phyrexianLifeCount !== undefined
				? { phyrexianLifeCount: pending.costPayment.phyrexianLifeCount }
				: {}),
			...(pending.costPayment?.hybridChoices
				? { hybridChoices: [...pending.costPayment.hybridChoices] }
				: {})
		};
		const q = prompt.costQuestion;
		if (q?.kind === 'option' || q?.kind === 'phyrexian' || q?.kind === 'hybrid') {
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
			if (q.kind === 'phyrexian') {
				payment.phyrexianLifeCount = opt;
			} else if (q.kind === 'hybrid') {
				const nextHyb = [...(payment.hybridChoices ?? [])];
				nextHyb[q.index] = opt;
				payment.hybridChoices = nextHyb;
			} else {
				payment.options![q.index] = opt;
			}
		} else if (q?.kind === 'objects' && normalized.answer?.kind === 'chooseObjects') {
			payment.objects![q.index] = normalized.answer.objectIds;
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
		resolveEndTurnChoice(state, actor, normalized.answer.yes);
		checkStateBasedActions(state);
		resumeAfterPrompt(state, prompt);
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
		state.pendingProcedure = {
			kind: 'legend_rule',
			actorId: actor.playerId,
			keepInstanceId,
			remainingInstanceIds: cands.filter((id) => id !== keepInstanceId),
			nextIndex: 0
		};
		advanceLegendRuleProcedure(state);
		return { ok: true };
	}

	if (purpose === 'commander_zone_choice') {
		const valid = validateChoiceAnswer(choice, normalized.answer);
		if (!valid.ok || normalized.answer?.kind !== 'yesNo') {
			return { ok: false, error: valid.ok ? 'Invalid commander zone choice.' : valid.error };
		}
		state.pendingPrompts.splice(promptIdx, 1);
		const proc =
			prompt.continuation?.kind === 'procedure' &&
			prompt.continuation.procedure.kind === 'commander_zone_choice'
				? prompt.continuation.procedure
				: undefined;
		const commanderId = proc?.commanderInstanceId ?? prompt.commanderInstanceId;
		const destZone = proc?.destinationZone ?? prompt.destinationZone;
		resolveCommanderZoneChoice(state, actor, normalized.answer.yes, commanderId, destZone);
		checkStateBasedActions(state);
		resumeAfterPrompt(state, prompt);
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
		state.pendingPrompts.splice(promptIdx, 1);
		state.pendingProcedure = {
			kind: 'discard_to_hand_size',
			actorId: actor.playerId,
			chosenIds: [...chosenIds],
			nextIndex: 0,
			discardCount: req
		};
		advanceDiscardToHandSizeProcedure(state);
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
					const isAura = (found.copiableCard ?? found.card).typeLine.includes('Aura');
					if (isAura) {
						const attachCands = legalAuraAttachCandidates(state, found, libraryOwner);
						if (attachCands.length === 0) {
							addLog(
								state,
								'rule',
								`${found.card.name} remained in ${libraryOwner.username}'s library because there is no legal object or player for it to enchant (CR 303.4g).`,
								libraryOwner.playerId
							);
						} else if (!libraryOwner.isBot) {
							shuffleLibrary(state, libraryOwner);
							enqueueChoicePrompt(state, {
								id: uid('prm', state),
								playerId: libraryOwner.playerId,
								kind: 'chooseObjects',
								purpose: 'generic',
								title: 'Search Library — Choose what Aura will enchant',
								description: `Choose a legal object or player for ${found.card.name} to enchant as it enters the battlefield (CR 303.4f).`,
								continuation: {
									kind: 'procedure',
									procedure: {
										kind: 'aura_library_attach_choice',
										auraId: found.instanceId,
										libraryOwnerId: libraryOwner.playerId,
										enterTapped: Boolean(prompt.enterTapped),
										...(prompt.continuation?.kind === 'effect_resume'
											? {
													resumeStackItemId: prompt.continuation.stackItemId,
													resumeStepIndex: prompt.continuation.stepIndex
												}
											: {})
									}
								},
								choice: {
									kind: 'chooseObjects',
									min: 1,
									max: 1,
									candidates: attachCands,
									defaultObjectIds: [attachCands[0]],
									zone: 'battlefield',
									reason: `Choose a legal object or player for ${found.card.name} to enchant as it enters the battlefield (CR 303.4f).`
								}
							});
							return { ok: true };
						} else {
							attachObject(state, found, attachCands[0]);
						}
					}
					if (!isAura || found.attachedToId) {
						found.tapped = Boolean(prompt.enterTapped);
						found.summoningSick = true;
						found.defaultControllerId = libraryOwner.playerId;
						applySelfEtbReplacements(state, found);
						moveObject(state, found, 'battlefield', {
							from: fromLibrary,
							toPlayer: libraryOwner,
							controllerId: libraryOwner.playerId,
							newTimestamp: !isAura,
							bumpVersion: true
						});
						if (isAura && found.attachedToId) {
							const attachedTarget = findPermanentOnBoard(state, found.attachedToId);
							if (attachedTarget) {
								emitEvent(state, {
									kind: 'Attached',
									attachmentId: found.instanceId,
									attachment: found,
									hostId: attachedTarget.inst.instanceId,
									host: attachedTarget.inst
								});
							}
						}
						addLog(
							state,
							'rule',
							`${libraryOwner.username} searched their library and put ${found.card.name} onto the battlefield${found.tapped ? ' tapped' : ''}.`,
							libraryOwner.playerId
						);
						flushTriggers(state);
					}
				} else if (prompt.destinationZone === 'library' && prompt.putOnTop) {
					// Put it on top, then shuffle the rest: the same as the old "remove, shuffle, put on top".
					moveObject(state, found, 'library', {
						from: fromLibrary,
						toPlayer: libraryOwner,
						insert: 'start',
						commanderRedirect: true,
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
					moveObject(state, found, 'hand', {
						from: fromLibrary,
						toPlayer: libraryOwner,
						commanderRedirect: true
					});
					addLog(
						state,
						'rule',
						prompt.searchSpec?.reveal
							? `${libraryOwner.username} searched their library, revealed ${found.card.name}, put it into hand, and shuffled.`
							: `${libraryOwner.username} searched their library for a card, put it into hand, and shuffled.`,
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
								? matchesLibrarySearchSpec(
										c.card,
										prompt.searchSpec,
										resolveObjectFaces(c.card, instanceFaceOptions(c)).colors
									)
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

	if (prompt.continuation?.kind !== 'effect_choice' && (purpose === 'scry_choice' || choice.kind === 'orderObjects')) {
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

		const isGraveyardSplit =
			prompt.splitMode === 'graveyard' ||
			(choice.kind === 'orderObjects' && choice.splitLabel === 'graveyard');

		if (isGraveyardSplit) {
			rearrangeLibrary(actor, topList, topList, []);
			const c = prompt.continuation;
			const resumeStackItemId =
				c?.kind === 'effect_resume'
					? c.stackItemId
					: c?.kind === 'procedure' && 'resumeStackItemId' in c.procedure
						? c.procedure.resumeStackItemId
						: undefined;
			const resumeStepIndex =
				c?.kind === 'effect_resume'
					? c.stepIndex
					: c?.kind === 'procedure' && 'resumeStepIndex' in c.procedure
						? c.procedure.resumeStepIndex
						: undefined;
			state.pendingPrompts.splice(promptIdx, 1);
			state.pendingProcedure = {
				kind: 'surveil_graveyard',
				actorId: actor.playerId,
				remainingIds: bottomList.map((card) => card.instanceId),
				nextIndex: 0,
				surveilCount: extracted.length,
				topCount: topList.length,
				graveyardCount: bottomList.length,
				...(resumeStackItemId ? { resumeStackItemId } : {}),
				...(resumeStepIndex !== undefined ? { resumeStepIndex } : {})
			};
			advanceSurveilGraveyardProcedure(state);
			resumeAfterPrompt(state, prompt);
			return { ok: true };
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
		const manualItem =
			c?.kind === 'manual_resolution'
				? state.stack.find((s) => s.id === c.stackItemId)
				: undefined;
		if (c?.kind === 'manual_resolution' && !manualItem) {
			return { ok: false, error: 'That spell or ability is no longer on the stack.' };
		}
		state.pendingPrompts.splice(promptIdx, 1);
		applyGuidedOperations(state, actor, ops);
		if (c?.kind === 'manual_resolution' && manualItem) {
			addLog(state, 'cast', `${actor.username} resolved ${manualItem.title} manually${ops.length > 0 ? ` (${ops.length} operation${ops.length === 1 ? '' : 's'})` : ''}.`, actor.playerId);
			manualItem.manualResolution = 'done';
			resumeStackItem(state, manualItem);
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

	// Step E2 / Track B1: a paused IR resolution waiting for this player's choice (any ChoiceAnswer).
	if (prompt.continuation?.kind === 'effect_choice') {
		const valid = validateChoiceAnswer(choice, normalized.answer);
		if (!valid.ok || !normalized.answer) {
			return { ok: false, error: valid.ok ? 'Missing choice answer.' : valid.error };
		}
		const c = prompt.continuation;
		const item = state.stack.find((s) => s.id === c.stackItemId);
		if (!item?.effectResume || item.effectResume.stepIndex !== c.stepIndex) {
			return { ok: false, error: 'That effect choice is no longer pending.' };
		}
		state.pendingPrompts.splice(promptIdx, 1);
		const answerKey = c.answerKey ?? actor.playerId;
		item.effectResume.answers[answerKey] = normalized.answer;
		resumeStackItem(state, item);
		return { ok: true };
	}

	// Standalone generic / procedure choice prompt (yesNo, chooseObjects, chooseMode, chooseNumber, chooseReplacement)
	if (normalized.cancel && prompt.cancellable) {
		state.pendingPrompts.splice(promptIdx, 1);
		return { ok: true };
	}
	const valid = validateChoiceAnswer(choice, normalized.answer);
	if (!valid.ok || !normalized.answer) {
		return { ok: false, error: valid.ok ? 'Missing choice answer.' : valid.error };
	}
	if (prompt.continuation?.kind === 'procedure') {
		const procCheck = validateProcedurePrompt(state, prompt.continuation.procedure);
		if (!procCheck.ok) {
			return procCheck;
		}
	}
	state.pendingPrompts.splice(promptIdx, 1);
	if (prompt.continuation?.kind === 'procedure') {
		executeProcedureContinuation(
			state,
			actor,
			prompt,
			prompt.continuation.procedure,
			normalized.answer
		);
	} else if (!runPromptHandler(state, prompt, normalized.answer)) {
		// A generic prompt continues only through a named handler or procedure (plain data).
		// Without one, answering just records the answer in the log.
		addLog(state, 'rule', `${actor.username} answered "${prompt.title}".`, actor.playerId);
	}
	checkStateBasedActions(state);
	resumeAfterPrompt(state, prompt);
	return { ok: true };
}

function hasBlockingReplacementOrCommanderPrompt(state: GameState): boolean {
	return (
		Boolean(state.pendingZoneMoves && state.pendingZoneMoves.length > 0) ||
		state.pendingPrompts.some(
			(p) =>
				p.choice?.kind === 'chooseReplacement' ||
				p.kind === 'chooseReplacement' ||
				p.kind === 'commander_zone_choice'
		)
	);
}

function linkNewlyQueuedReplacements(
	state: GameState,
	promptsBefore: number,
	resumeStackItemId?: string,
	resumeStepIndex?: number
): void {
	if (!resumeStackItemId || resumeStepIndex === undefined) return;
	for (const pr of state.pendingPrompts.slice(promptsBefore)) {
		if (pr.continuation?.kind === 'handler') {
			const data = (pr.continuation.data ??= {});
			data.resumeStackItemId = resumeStackItemId;
			data.resumeStepIndex = resumeStepIndex;
		}
	}
}

function resolveEndTurnChoice(state: GameState, actor: PlayerGameState, yes: boolean): void {
	if (yes) {
		endTheTurnImmediately(state, actor.playerId);
	} else {
		addLog(state, 'rule', `${actor.username} chose not to end the turn.`, actor.playerId);
	}
}

function resolveCommanderZoneChoice(
	state: GameState,
	actor: PlayerGameState,
	yes: boolean,
	commanderInstanceId: string | undefined,
	destinationZone: ZoneType | undefined
): void {
	if (yes) {
		const gIdx = actor.graveyard.findIndex((c) => c.instanceId === commanderInstanceId);
		const eIdx = actor.exile.findIndex((c) => c.instanceId === commanderInstanceId);
		const hIdx = actor.hand.findIndex((c) => c.instanceId === commanderInstanceId);
		const lIdx = actor.library.findIndex((c) => c.instanceId === commanderInstanceId);
		let cmd: CardInstance | undefined;
		let cmdFrom: 'graveyard' | 'exile' | 'hand' | 'library' = 'graveyard';
		if (gIdx >= 0) cmd = actor.graveyard[gIdx];
		else if (eIdx >= 0) {
			cmd = actor.exile[eIdx];
			cmdFrom = 'exile';
		} else if (hIdx >= 0) {
			cmd = actor.hand[hIdx];
			cmdFrom = 'hand';
		} else if (lIdx >= 0) {
			cmd = actor.library[lIdx];
			cmdFrom = 'library';
		}

		if (cmd) {
			cmd.damageMarked = 0;
			cmd.deathtouchDamageMarked = false;
			cmd.tapped = false;
			moveObject(state, cmd, 'command', { from: { player: actor, zone: cmdFrom }, toPlayer: actor });
			const crRule = cmdFrom === 'hand' || cmdFrom === 'library' ? 'CR 903.9b' : 'CR 903.9a';
			addLog(
				state,
				'rule',
				`${actor.username} returned Commander ${cmd.card.name} to the Command Zone (${crRule}).`,
				actor.playerId
			);
		}
		return;
	}
	const cmd =
		actor.graveyard.find((c) => c.instanceId === commanderInstanceId) ??
		actor.exile.find((c) => c.instanceId === commanderInstanceId);
	if (cmd) {
		cmd.commanderSbaDeclinedVersion = cmd.objectVersion ?? 1;
	}
	addLog(
		state,
		'rule',
		`${actor.username} chose to leave Commander in ${destinationZone}.`,
		actor.playerId
	);
}

function advanceLegendRuleProcedure(state: GameState): void {
	const proc = state.pendingProcedure;
	if (!proc || proc.kind !== 'legend_rule') return;
	const actor = state.players.find((p) => p.playerId === proc.actorId);
	while (proc.nextIndex < proc.remainingInstanceIds.length) {
		const cid = proc.remainingInstanceIds[proc.nextIndex];
		proc.nextIndex += 1;
		const found = findPermanentOnBoard(state, cid);
		if (!found) continue;
		const moveRes = movePermanentToZone(state, found.inst, 'graveyard');
		if (moveRes === 'pending' || hasBlockingReplacementOrCommanderPrompt(state)) {
			return;
		}
	}
	state.pendingProcedure = undefined;
	if (actor) {
		addLog(
			state,
			'sba',
			`${actor.username} resolved the Legend Rule (CR 704.5j).`,
			actor.playerId
		);
	}
	checkStateBasedActions(state);
	flushTriggers(state);
}

function advanceDiscardToHandSizeProcedure(state: GameState): void {
	const proc = state.pendingProcedure;
	if (!proc || proc.kind !== 'discard_to_hand_size') return;
	const actor = state.players.find((p) => p.playerId === proc.actorId);
	if (!actor) {
		state.pendingProcedure = undefined;
		return;
	}
	while (proc.nextIndex < proc.chosenIds.length) {
		const id = proc.chosenIds[proc.nextIndex];
		proc.nextIndex += 1;
		const idx = actor.hand.findIndex((c) => c.instanceId === id);
		if (idx < 0) continue;
		const moveRes = moveObject(state, actor.hand[idx], 'graveyard', {
			from: { player: actor, zone: 'hand' },
			toPlayer: actor,
			graveyardReplacement: true,
			commanderRedirect: true
		});
		if (moveRes === 'pending' || hasBlockingReplacementOrCommanderPrompt(state)) {
			return;
		}
	}
	state.pendingProcedure = undefined;
	addLog(
		state,
		'rule',
		`${actor.username} discarded ${proc.discardCount} card(s) down to maximum hand size.`,
		actor.playerId
	);
	completeTurnCleanupAndPassTurn(state);
}

function finishCombatDamagePhase(state: GameState): void {
	if (state.status === 'finished') return;
	const active = state.players[state.activePlayerIndex];
	emitEvent(state, {
		kind: 'PhaseBegin',
		phase: state.phase,
		activePlayerId: active?.playerId ?? null
	});
	flushTriggers(state);
	givePriorityToActiveOrNextPlayer(state);
	state.passedPriorityPlayerIds = [];
	checkStateBasedActions(state);
}

function validateProcedurePrompt(
	state: GameState,
	proc: ProcedureContinuation
): { ok: true } | { ok: false; error: string } {
	if (proc.kind === 'clone_copy_choice') {
		if (!state.stack.some((s) => s.id === proc.stackItemId)) {
			return { ok: false, error: 'That copy choice is no longer pending on the stack.' };
		}
	} else if (proc.kind === 'ward_payment_choice') {
		if (!state.stack.some((s) => s.id === proc.wardStackItemId)) {
			return { ok: false, error: 'That Ward payment choice is no longer pending on the stack.' };
		}
	}
	return { ok: true };
}

function executeProcedureContinuation(
	state: GameState,
	actor: PlayerGameState,
	prompt: PendingPrompt,
	proc: ProcedureContinuation,
	answer: ChoiceAnswer
): void {
	switch (proc.kind) {
		case 'ward_payment_choice': {
			const wardItem = state.stack.find((s) => s.id === proc.wardStackItemId);
			const targetItem = state.stack.find((s) => s.id === proc.targetStackItemId);
			const accepted = answer.kind === 'yesNo' ? answer.yes : false;
			if (wardItem) wardItem.optionalAccepted = accepted;
			if (targetItem && !accepted) targetItem.declineWard = true;
			return;
		}
		case 'clone_copy_choice': {
			if (answer.kind !== 'chooseObjects') return;
			const item = state.stack.find((s) => s.id === proc.stackItemId);
			if (!item) return;
			item.cloneCopyChoice = answer.objectIds[0] ?? null;
			return;
		}
		case 'aura_library_attach_choice': {
			if (answer.kind !== 'chooseObjects') return;
			const libraryOwner = state.players.find((p) => p.playerId === proc.libraryOwnerId);
			const found = libraryOwner?.library.find((c) => c.instanceId === proc.auraId);
			const chosenHostId = answer.objectIds[0] ?? null;
			if (!libraryOwner || !found || !chosenHostId) return;
			attachObject(state, found, chosenHostId);
			found.tapped = proc.enterTapped;
			found.summoningSick = true;
			found.defaultControllerId = libraryOwner.playerId;
			applySelfEtbReplacements(state, found);
			const promptsBefore = state.pendingPrompts.length;
			const moveRes = moveObject(state, found, 'battlefield', {
				from: { player: libraryOwner, zone: 'library' },
				toPlayer: libraryOwner,
				controllerId: libraryOwner.playerId,
				bumpVersion: true
			});
			if (moveRes === 'pending') {
				linkNewlyQueuedReplacements(state, promptsBefore, proc.resumeStackItemId, proc.resumeStepIndex);
				return;
			}
			const attachedTarget = findPermanentOnBoard(state, chosenHostId);
			if (attachedTarget) {
				emitEvent(state, {
					kind: 'Attached',
					attachmentId: found.instanceId,
					attachment: found,
					hostId: attachedTarget.inst.instanceId,
					host: attachedTarget.inst
				});
			}
			addLog(
				state,
				'rule',
				`${libraryOwner.username} searched their library and put ${found.card.name} onto the battlefield${found.tapped ? ' tapped' : ''}.`,
				libraryOwner.playerId
			);
			flushTriggers(state);
			return;
		}
		case 'commander_zone_choice': {
			const yes = answer.kind === 'yesNo' ? answer.yes : false;
			resolveCommanderZoneChoice(state, actor, yes, proc.commanderInstanceId, proc.destinationZone);
			return;
		}
		case 'end_turn': {
			const yes = answer.kind === 'yesNo' ? answer.yes : false;
			resolveEndTurnChoice(state, actor, yes);
			return;
		}
		default: {
			runPromptHandler(state, prompt, answer);
		}
	}
}

function advanceSurveilGraveyardProcedure(state: GameState): void {
	const proc = state.pendingProcedure;
	if (!proc || proc.kind !== 'surveil_graveyard') return;
	const actor = state.players.find((p) => p.playerId === proc.actorId);
	if (!actor) {
		state.pendingProcedure = undefined;
		return;
	}
	while (proc.nextIndex < proc.remainingIds.length) {
		const id = proc.remainingIds[proc.nextIndex];
		proc.nextIndex += 1;
		const idx = actor.library.findIndex((c) => c.instanceId === id);
		if (idx < 0) continue;
		const moveRes = moveObject(state, actor.library[idx], 'graveyard', {
			from: { player: actor, zone: 'library' },
			toPlayer: actor,
			graveyardReplacement: true,
			bumpVersion: true,
			newTimestamp: true,
			...(proc.resumeStackItemId ? { resumeStackItemId: proc.resumeStackItemId } : {}),
			...(proc.resumeStepIndex !== undefined ? { resumeStepIndex: proc.resumeStepIndex } : {})
		});
		if (moveRes === 'pending' || hasBlockingReplacementOrCommanderPrompt(state)) {
			return;
		}
	}
	state.pendingProcedure = undefined;
	addLog(
		state,
		'rule',
		`${actor.username} surveilled ${proc.surveilCount} (${proc.topCount} on top, ${proc.graveyardCount} into graveyard).`,
		actor.playerId
	);
	emitEvent(state, {
		kind: 'Surveilled',
		playerId: actor.playerId,
		count: proc.surveilCount,
		graveyardCount: proc.graveyardCount
	});
	flushTriggers(state);
}

function resumePendingProcedure(state: GameState): void {
	const proc = state.pendingProcedure;
	if (!proc) return;
	if (proc.kind === 'legend_rule') {
		advanceLegendRuleProcedure(state);
		return;
	}
	if (proc.kind === 'discard_to_hand_size') {
		advanceDiscardToHandSizeProcedure(state);
		return;
	}
	if (proc.kind === 'surveil_graveyard') {
		const stackItemId = proc.resumeStackItemId;
		const stepIndex = proc.resumeStepIndex;
		advanceSurveilGraveyardProcedure(state);
		if (!state.pendingProcedure && stackItemId && stepIndex !== undefined) {
			const item = state.stack.find((s) => s.id === stackItemId);
			if (item?.effectResume?.stepIndex === stepIndex && !stackItemAwaitsPrompt(state, item)) {
				resumeStackItem(state, item);
			}
		}
		return;
	}
	if (proc.kind === 'combat_damage_step') {
		state.pendingProcedure = undefined;
		checkStateBasedActions(state);
		finishCombatDamagePhase(state);
	}
}

/**
 * Step E2 / Track B1: resumes any enclosing cost payment, rules procedure, or paused stack item
 * once blocking replacement/commander prompts finish.
 */
function resumeAfterPrompt(state: GameState, prompt: PendingPrompt): void {
	if (hasBlockingReplacementOrCommanderPrompt(state)) {
		return;
	}
	if (state.pendingCostPayment) {
		resumePendingCostPayment(state);
		return;
	}
	if (state.pendingProcedure) {
		resumePendingProcedure(state);
		return;
	}
	const c = prompt.continuation;
	if (c?.kind === 'effect_resume') {
		const item = state.stack.find((s) => s.id === c.stackItemId);
		if (!item?.effectResume || item.effectResume.stepIndex !== c.stepIndex) return;
		if (stackItemAwaitsPrompt(state, item)) return;
		resumeStackItem(state, item);
		return;
	}
	if (c?.kind === 'procedure') {
		const proc = c.procedure;
		if (proc.kind === 'clone_copy_choice') {
			const item = state.stack.find((s) => s.id === proc.stackItemId);
			if (!item || stackItemAwaitsPrompt(state, item)) return;
			resumeStackItem(state, item);
			return;
		}
		if (proc.kind === 'ward_payment_choice') {
			const item = state.stack.find((s) => s.id === proc.wardStackItemId);
			if (!item || stackItemAwaitsPrompt(state, item)) return;
			resumeStackItem(state, item);
			return;
		}
		const resumeStackItemId =
			'resumeStackItemId' in proc ? proc.resumeStackItemId : undefined;
		const resumeStepIndex =
			'resumeStepIndex' in proc ? proc.resumeStepIndex : undefined;
		if (resumeStackItemId && resumeStepIndex !== undefined) {
			const item = state.stack.find((s) => s.id === resumeStackItemId);
			if (!item?.effectResume || item.effectResume.stepIndex !== resumeStepIndex) return;
			if (stackItemAwaitsPrompt(state, item)) return;
			resumeStackItem(state, item);
			return;
		}
	}
	if (c?.kind === 'handler') {
		const resumeStackItemId =
			typeof c.data?.resumeStackItemId === 'string' ? c.data.resumeStackItemId : null;
		const resumeStepIndex =
			typeof c.data?.resumeStepIndex === 'number' ? c.data.resumeStepIndex : null;
		if (resumeStackItemId && resumeStepIndex !== null) {
			const item = state.stack.find((s) => s.id === resumeStackItemId);
			if (!item?.effectResume || item.effectResume.stepIndex !== resumeStepIndex) return;
			if (stackItemAwaitsPrompt(state, item)) return;
			resumeStackItem(state, item);
			return;
		}
	}
	const activeItem = state.stack.find((s) => Boolean(s.resolutionStarted) && Boolean(s.effectResume));
	if (activeItem && !stackItemAwaitsPrompt(state, activeItem)) {
		resumeStackItem(state, activeItem);
	}
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
				if (player && amount !== 0) {
					if (amount > 0) {
						if (gainPlayerLife(state, player, amount)) {
							addLog(state, 'life', `${player.username} gained ${amount} life (manual).`, actor.playerId);
						}
					} else if (!playerLifeTotalCantChange(state, player)) {
						player.life += amount;
						addLog(state, 'life', `${player.username} lost ${Math.abs(amount)} life (manual).`, actor.playerId);
					}
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
					if (dest === 'battlefield') found.inst.summoningSick = true;
					moveObject(state, found.inst, dest, {
						from: { player: found.holder, zone: found.zone as Exclude<ZoneType, 'stack'> },
						toPlayer,
						...(dest === 'battlefield' ? { controllerId: actor.playerId } : {}),
						bumpVersion: true,
						newTimestamp: true
					});
				}
				const isHiddenToHidden =
					(found.zone === 'hand' || found.zone === 'library') &&
					(dest === 'hand' || dest === 'library');
				addLog(
					state,
					'rule',
					`${isHiddenToHidden ? 'A card' : found.inst.card.name} was moved from ${found.zone} to ${dest} (manual).`,
					actor.playerId
				);
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
					if (op.op === 'tap') {
						tapPermanent(state, found.inst);
					} else if (found.inst.tapped) {
						found.inst.tapped = false;
						noteLayerInputsChanged(state);
					}
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

/**
 * CR 800.4j: If the active player has left the game during their turn, the turn continues
 * without an active player and the next player in turn order receives priority instead.
 */
function givePriorityToActiveOrNextPlayer(state: GameState): void {
	state.priorityPlayerIndex = state.activePlayerIndex;
	if (state.players[state.priorityPlayerIndex]?.lost) {
		advancePriorityToNextPlayer(state);
	}
}

export function moveStackSpellToZone(
	state: GameState,
	stackItem: StackItem,
	dest: 'graveyard' | 'exile' | 'hand' | 'library' = 'graveyard',
	libraryOpts?: { position?: 'top' | 'bottom'; fromTop?: number }
): void {
	if (stackItem.kind !== 'spell' || stackItem.isCopy) return;
	// CR 702.34a (and similar stack-exit replacements): exile instead of putting it anywhere else.
	if (stackItem.spellMods?.exileOnLeaveStack) {
		dest = 'exile';
	}
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
	const cardInst = createCardInstance(
		stackItem.card,
		owner.playerId,
		dest,
		isCmd,
		false,
		allocateTimestamp(state)
	);
	cardInst.instanceId = stackItem.sourceInstanceId;
	cardInst.commanderCastCount = castCount;
	cardInst.zone = 'stack' as ZoneType;
	if (stackItem.faceIndex !== undefined) {
		cardInst.activeFaceIndex = stackItem.faceIndex;
	}
	if (stackItem.isFaceDown) {
		addLog(
			state,
			'rule',
			`CR 708.9: ${stackItem.faceDownLabel || 'Face-Down Spell'} left the stack to ${dest} and is revealed as ${stackItem.card.name}.`,
			owner.playerId
		);
	}
	moveObject(state, cardInst, dest, {
		from: 'stack',
		toPlayer: owner,
		graveyardReplacement: dest === 'graveyard',
		commanderRedirect: true,
		insert: (actual) =>
			actual === 'library'
				? computeLibraryInsertIndex(
						libraryOpts?.fromTop,
						libraryOpts?.position ?? 'top',
						owner.library.length
					)
				: 'end'
	});
	// CR 716.3d: Resolving Adventure spell exiles itself with permission for its controller to cast its main face.
	if (
		dest === 'exile' &&
		cardInst.zone === 'exile' &&
		stackItem.spellMods?.exileAdventureOnResolve &&
		!stackItem.spellMods?.exileOnLeaveStack
	) {
		cardInst.playableFromExileBy = {
			playerId: stackItem.controllerId,
			spendManaAsAnyColor: false,
			sourceName: `${stackItem.title} (Adventure)`,
			allowedFaceIndices: [0],
			onAdventure: true
		};
		addLog(
			state,
			'rule',
			`${cardInst.card.name} is exiled on an Adventure and may be cast from Exile (CR 716.3d).`,
			stackItem.controllerId
		);
	}
}

export function addCountersToPermanent(
	state: GameState,
	perm: CardInstance,
	type: CounterType,
	amount: number
): number {
	if (amount <= 0) return 0;
	if (hasRestriction(state, perm, 'cantHaveCounters')) return 0;
	const res = resolveCounterReplacements(state, perm, type, amount);
	if (res.pendingOptions && res.pendingOptions.length >= 2) {
		const description = `Multiple replacement effects would modify putting ${res.amount} ${type} counter(s) on ${perm.card.name}. Choose which applies first (CR 616.1):`;
		enqueueChoicePrompt(state, {
			id: uid('prm', state),
			playerId: res.chooserId,
			kind: 'chooseReplacement',
			purpose: 'generic',
			title: 'Choose Replacement Effect (CR 616.1)',
			description,
			continuation: {
				kind: 'handler',
				name: 'counter_replacement_choice',
				data: {
					permId: perm.instanceId,
					counterType: type,
					currentAmount: res.amount,
					appliedIds: res.appliedIds
				}
			},
			choice: {
				kind: 'chooseReplacement',
				options: res.pendingOptions.map((r) => ({ id: r.id, label: r.label }))
			}
		});
		return 0;
	}
	const effectiveAmount = res.amount;
	if (effectiveAmount <= 0) return 0;
	const previousCount = perm.counters[type] || 0;
	const newCount = previousCount + effectiveAmount;
	perm.counters[type] = newCount;
	noteLayerInputsChanged(state);
	emitEvent(state, {
		kind: 'CounterPlaced',
		objectId: perm.instanceId,
		object: perm,
		counterType: type,
		amount: effectiveAmount,
		previousCount,
		newCount
	});
	// "Whenever a +1/+1 counter is put on ~" ran here before Phase 5; keep that timing when already on board.
	if (findPermanentOnBoard(state, perm.instanceId)) {
		flushTriggers(state);
	}
	return effectiveAmount;
}

registerCounterPlacement(addCountersToPermanent);

registerPromptHandler('counter_replacement_choice', (state, prompt, answer) => {
	if (answer.kind !== 'chooseReplacement') return;
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	if (!data) return;
	const permId = typeof data.permId === 'string' ? data.permId : '';
	const counterType = (data.counterType as CounterType | undefined) ?? '+1/+1';
	const currentAmount = typeof data.currentAmount === 'number' ? data.currentAmount : 0;
	const appliedIds = Array.isArray(data.appliedIds) ? (data.appliedIds as string[]) : [];
	const resumeStackItemId =
		typeof data.resumeStackItemId === 'string' ? data.resumeStackItemId : undefined;
	const resumeStepIndex =
		typeof data.resumeStepIndex === 'number' ? data.resumeStepIndex : undefined;
	const found = findPermanentOnBoard(state, permId);
	if (!found || currentAmount <= 0) return;
	const perm = found.inst;

	const nextRes = resolveCounterReplacements(
		state,
		perm,
		counterType,
		currentAmount,
		new Set(appliedIds),
		answer.id
	);
	if (nextRes.pendingOptions && nextRes.pendingOptions.length >= 2) {
		const description = `Multiple replacement effects would modify putting ${nextRes.amount} ${counterType} counter(s) on ${perm.card.name}. Choose which applies next (CR 616.1f):`;
		enqueueChoicePrompt(state, {
			id: uid('prm', state),
			playerId: nextRes.chooserId,
			kind: 'chooseReplacement',
			purpose: 'generic',
			title: 'Choose Replacement Effect (CR 616.1)',
			description,
			continuation: {
				kind: 'handler',
				name: 'counter_replacement_choice',
				data: {
					permId: perm.instanceId,
					counterType,
					currentAmount: nextRes.amount,
					appliedIds: nextRes.appliedIds,
					...(resumeStackItemId !== undefined ? { resumeStackItemId } : {}),
					...(resumeStepIndex !== undefined ? { resumeStepIndex } : {})
				}
			},
			choice: {
				kind: 'chooseReplacement',
				options: nextRes.pendingOptions.map((r) => ({ id: r.id, label: r.label }))
			}
		});
		return;
	}
	const effectiveAmount = nextRes.amount;
	const previousCount = perm.counters[counterType] || 0;
	const newCount = previousCount + effectiveAmount;
	perm.counters[counterType] = newCount;
	noteLayerInputsChanged(state);
	emitEvent(state, {
		kind: 'CounterPlaced',
		objectId: perm.instanceId,
		object: perm,
		counterType,
		amount: effectiveAmount,
		previousCount,
		newCount
	});
	flushTriggers(state);
});

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
				const isCompiled = dt.delayedEffect?.kind === 'compiledDelayed';
				const targets: TargetRef[] = [];
				if (!isCompiled && dt.targetInstanceId) {
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
				const compiledMeta =
					delayedEffect?.kind === 'compiledDelayed' ? delayedEffect : undefined;
				const phaseLabel =
					phase === 'upkeep'
						? 'Delayed Upkeep Trigger'
						: phase === 'end_combat'
							? 'Delayed End of Combat Trigger'
							: 'Delayed End Step Trigger';
				const stkItem: StackItem = withStackItemText(
					{
						id: uid('stk', state),
						sourceInstanceId: compiledMeta ? (dt.sourceInstanceId ?? dt.id) : dt.id,
						card: dt.sourceCard,
						controllerId: dt.controllerId,
						kind: 'triggered',
						title: `${dt.sourceCard.name} (${phaseLabel})`,
						targets,
						targetObjectVersions: captureTargetObjectVersions(state, targets),
						xValue: compiledMeta?.xValue ?? 0,
						...(compiledMeta?.kickedCount !== undefined ? { sourceKickedCount: compiledMeta.kickedCount } : {}),
						...(compiledMeta?.kickedTags?.length ? { sourceKickedTags: [...compiledMeta.kickedTags] } : {}),
						...(compiledMeta?.kickedTagCounts ? { sourceKickedTagCounts: { ...compiledMeta.kickedTagCounts } } : {}),
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
 * CR 715.2d: A Saga's final chapter number is the greatest value among chapter abilities it has.
 * If a Saga somehow has no chapter abilities (e.g. it lost all abilities), its final chapter
 * number is 0.
 */
export function getSagaFinalChapterNumber(state: GameState, perm: CardInstance): number {
	if (perm.phasedOut || perm.isFaceDown) return 0;
	const ev = evaluatePermanent(state, perm);
	if (!ev.hasSubType('Saga') || ev.hasLostAllAbilities) return 0;
	const abilities = activeAbilityDefs(
		effectiveCardForObject(perm),
		instanceFaceOptions(perm, 'battlefield')
	);
	let maxChapter = 0;
	for (const ab of abilities) {
		const trig =
			ab.kind === 'triggered'
				? ab.trigger
				: ab.kind === 'unsupported'
					? ab.trigger
					: undefined;
		if (trig?.isChapterAbility && trig.chapterNumbers) {
			for (const ch of trig.chapterNumbers) {
				if (ch > maxChapter) maxChapter = ch;
			}
		}
	}
	return maxChapter;
}

/**
 * CR 715.3b: As a player's precombat main phase begins, that player puts a lore counter on each
 * Saga they control with one or more chapter abilities. This turn-based action doesn't use the stack.
 */
function executePrecombatMainSagaLoreTurnBasedAction(
	state: GameState,
	activePlayer: PlayerGameState
): void {
	for (const perm of [...activePlayer.battlefield]) {
		if (perm.zone !== 'battlefield' || perm.phasedOut) continue;
		if (getSagaFinalChapterNumber(state, perm) <= 0) continue;
		addCountersToPermanent(state, perm, 'lore', 1);
	}
}

const MONARCH_DESIGNATION_CARD: ScryfallCard = buildTokenScryfallCard('monarch-designation', {
	name: 'The Monarch',
	typeLine: 'Designation',
	power: 0,
	toughness: 0,
	colors: [],
	keywords: []
});

function pushMonarchInherentTrigger(
	state: GameState,
	monarchPlayer: PlayerGameState,
	inherentTrigger: NonNullable<StackItem['inherentTrigger']>,
	title: string,
	description: string
): void {
	const stkItem: StackItem = withStackItemText(
		{
			id: uid('mtrig', state),
			sourceInstanceId: `designation_monarch_${monarchPlayer.playerId}`,
			card: MONARCH_DESIGNATION_CARD,
			ownerId: monarchPlayer.playerId,
			controllerId: monarchPlayer.playerId,
			kind: 'triggered',
			title,
			targets: [],
			xValue: 0,
			inherentTrigger,
			requiresGuidedResolution: false,
			createdAt: Date.now()
		},
		description
	);
	state.stack.push(stkItem);
	addLog(
		state,
		'trigger',
		`${title} triggered (${monarchPlayer.username}): "${description}"`,
		monarchPlayer.playerId
	);
}

/**
 * CR 726.1–3: Makes `playerId` the monarch. If that player is already the monarch, nothing
 * changes and no `BecameMonarch` event is emitted (CR 726.3).
 */
export function setMonarch(state: GameState, playerId: string): void {
	const target = state.players.find((p) => p.playerId === playerId && !p.lost);
	if (!target) return;
	const previousMonarchId = state.monarchPlayerId ?? null;
	if (previousMonarchId === playerId) return;
	state.monarchPlayerId = playerId;
	noteLayerInputsChanged(state);
	addLog(state, 'rule', `${target.username} became the monarch (CR 726).`, playerId);
	emitEvent(state, {
		kind: 'BecameMonarch',
		playerId,
		previousMonarchId
	});
	flushTriggers(state);
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
	// wait until state-based actions have been checked (CR 704.3, 603.3).
	let stepTurnBasedPaused = false;
	withTriggersDeferred(state, () => {
		if (phase === 'untap' && active && !active.lost) {
			executeUntapTurnBasedActions(state, active);
		} else if (phase === 'draw' && active && !active.lost) {
			executeDrawTurnBasedAction(state, active);
		} else if (phase === 'main1' && active && !active.lost) {
			executePrecombatMainSagaLoreTurnBasedAction(state, active);
		} else if (phase === 'declare_attackers') {
			state.combat.active = false;
			state.combat.attackers = [];
			state.combat.declaredBlockersPlayerIds = [];
			state.combat.blockersDeclared = false;
			state.combat.damageDealtFirstStrike = false;
			state.combat.damageDealtNormal = false;
			state.combat.dealtFirstStrikeDamageIds = [];
			state.combat.awaitingAttackersDeclaration = false;
			noteLayerInputsChanged(state);
			if (active && !active.lost) {
				if (active.isBot) {
					executeBotDeclareAttackersTurnBasedAction(state, active);
				} else {
					state.combat.awaitingAttackersDeclaration = true;
					stepTurnBasedPaused = true;
				}
			}
		} else if (phase === 'declare_blockers') {
			state.combat.declaredBlockersPlayerIds = [];
			state.combat.blockersDeclared = false;
			stepTurnBasedPaused = !advanceBotBlockerDeclarations(state);
		} else if (phase === 'first_strike_damage') {
			stepTurnBasedPaused = executeCombatDamageStep(state, true);
		} else if (phase === 'combat_damage') {
			stepTurnBasedPaused = executeCombatDamageStep(state, false);
		} else if (phase === 'end_step' && active) {
			for (const p of state.players) {
				for (const ex of p.exile) {
					if (ex.playableFromExileBy?.expiresAtNextEndStepOfPlayerId === active.playerId) {
						ex.playableFromExileBy = undefined;
					}
				}
			}
		} else if (phase === 'cleanup') {
			clearEndOfTurnAndDamage(state);
		}
		if (
			!stepTurnBasedPaused &&
			(phase === 'first_strike_damage' || phase === 'combat_damage') &&
			hasBlockingReplacementOrCommanderPrompt(state)
		) {
			state.pendingProcedure = {
				kind: 'combat_damage_step',
				phase: 'after_damage',
				isFirstStrikeStep: phase === 'first_strike_damage'
			};
			stepTurnBasedPaused = true;
		}
		if (
			!stepTurnBasedPaused &&
			(phase === 'declare_attackers' ||
				phase === 'declare_blockers' ||
				phase === 'first_strike_damage' ||
				phase === 'combat_damage')
		) {
			checkStateBasedActions(state);
		}
	});
	if (stepTurnBasedPaused || state.status === 'finished') return;
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
	'SpellCopied',
	'AttackDeclared',
	'BlockersDeclared',
	'DamageDealt',
	'CounterPlaced',
	'CounterRemoved',
	'BecameTarget',
	'Attached',
	'TappedForMana',
	'GainLife',
	'CardDrawn',
	'BecomesTapped',
	'CardDiscarded',
	'Transformed',
	'TurnedFaceUp',
	'Investigated',
	'Surveilled',
	'Explored',
	'Connived',
	'BecomesCrewed',
	'BecomesSaddled',
	'Foretold',
	'Plotted',
	'CombatDamageBatchPlayer',
	'BecameMonarch',
	'Exerted',
	'Amassed',
	'ManifestDread',
	'BecameMonstrous'
] as const) {
	registerEventHandler(kind, (state, ev) => matchTriggers(state, ev));
}
registerEventHandler('Cast', (state, ev) => {
	matchTriggers(state, ev);
	noteUnautomatedOnCast(state, ev.object, ev.playerId);
});
registerEventHandler('ZoneChange', (state, ev) => {
	matchTriggers(state, ev);
	if (ev.to === 'battlefield' && !ev.ceasedToExist) noteUnautomatedOnEnter(state, ev.object);
});

/**
 * CR 702.85a / 702.88a / Step E2: when an instant or sorcery is cast, log any unsupported keyword
 * or static notices on it once so players know to resolve them manually.
 */
function noteUnautomatedOnCast(state: GameState, obj: CardInstance, playerId: string): void {
	if (obj.isFaceDown) return;
	const card = obj.copiableCard ?? obj.card;
	if (!/\b(?:Instant|Sorcery)\b/.test(card.typeLine)) return;
	for (const n of enteringNotices(card)) {
		addLog(
			state,
			'rule',
			`${card.name}: ${n.text} is not automated — resolve manually.`,
			playerId
		);
	}
}

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
	if ((ev.phase === 'end_step' || ev.phase === 'upkeep' || ev.phase === 'end_combat') && activePlayer) {
		flushTriggers(state);
		if (ev.phase === 'end_step' && !activePlayer.lost && state.monarchPlayerId === activePlayer.playerId) {
			pushMonarchInherentTrigger(
				state,
				activePlayer,
				{ kind: 'monarchEndStepDraw', drawPlayerId: activePlayer.playerId },
				'The Monarch (End Step)',
				"At the beginning of the monarch's end step, that player draws a card."
			);
		}
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
			manaValue: objectManaValue(state, onBattlefield.inst)
		};
	}
	const lki = t.eventLki;
	return {
		controllerId: lki?.controllerId ?? obj.controllerId,
		ownerId: obj.ownerId,
		power: lki?.power ?? obj.lastKnownPower ?? (parseInt(obj.card.power ?? '0', 10) || 0),
		toughness: lki?.toughness ?? obj.lastKnownToughness ?? (parseInt(obj.card.toughness ?? '0', 10) || 0),
		manaValue: objectManaValue(state, obj)
	};
}

/**
 * Builds the stack item for a triggered ability (also the "dummy" item an inline trigger resolves
 * with). The event the ability refers to is recorded in the `event*` fields, never in `targets`
 * ("that creature", "that player", "that many"; CR 603.7c); `eventObjectId` defaults to the source
 * ("When ~ enters, ... it ..."). `targets` holds only the targets chosen for the ability.
 */
function triggerSourcePublicName(state: GameState, t: PendingTrigger): string {
	const foundSource = findPermanentOnBoard(state, t.source.instanceId);
	const src = foundSource?.inst ?? t.source;
	if (src.isFaceDown) {
		return src.faceDownLabel || 'Face-Down Permanent';
	}
	return (t.faceIndex !== undefined ? t.sourceCard.faces?.[t.faceIndex]?.name : undefined) ?? t.sourceCard.name;
}

function triggeredStackItem(state: GameState, t: PendingTrigger, idPrefix: string): StackItem {
	const foundSource = findPermanentOnBoard(state, t.source.instanceId);
	const sourceEval = foundSource ? evaluatePermanent(state, foundSource.inst) : undefined;
	const sourceLkiPower = sourceEval?.power ?? t.source.lastKnownPower;
	const sourceLkiToughness = sourceEval?.toughness ?? t.source.lastKnownToughness;
	const eventObj = t.eventObject ?? t.source;
	const kickerLki = getObjectKickerInfo(state, t.sourceCard, t.source.instanceId);
	const sourceEvoked = isObjectEvoked(state, t.source.instanceId, undefined, t.source);
	const sourceEscaped = isObjectEscaped(state, t.source.instanceId, undefined, t.source);
	const sourceForetold = t.sourceForetold ?? isObjectForetold(state, t.source.instanceId, undefined, t.source);
	const sourceBlitzed = t.sourceBlitzed ?? isObjectBlitzed(state, t.source.instanceId, undefined, t.source);
	const sourceExertedThisTurn = Boolean(
		t.sourceExertedThisTurn ?? foundSource?.inst.exertedThisTurn ?? t.source.exertedThisTurn
	);
	const sourceChosenSubType =
		t.sourceChosenSubType ?? foundSource?.inst.chosenSubType ?? t.source.chosenSubType;
	const sourceChosenColor =
		t.sourceChosenColor ?? foundSource?.inst.chosenColor ?? t.source.chosenColor;
	const sourceMonstrous = t.sourceMonstrous ?? Boolean((foundSource?.inst ?? t.source).isMonstrous);
	const sourceObjForProto = foundSource?.inst ?? t.source;
	const sourcePrototyped = Boolean(
		sourceObjForProto.prototyped || sourceObjForProto.copiableState?.prototyped
	);
	const sourceIsFaceDown = Boolean(foundSource?.inst.isFaceDown);
	const sourceFaceDownLabel = foundSource?.inst.faceDownLabel;
	const sourceFaceDownSpec = foundSource?.inst.faceDownSpec;
	const faceTitleName =
		(t.faceIndex !== undefined ? t.sourceCard.faces?.[t.faceIndex]?.name : undefined) ??
		t.sourceCard.name;
	const titleSource = sourceIsFaceDown ? sourceFaceDownLabel || 'Face-Down Permanent' : faceTitleName;
	const hasKickerInfo =
		kickerLki.count > 0 ||
		kickerLki.tags.length > 0 ||
		Boolean(kickerLki.tagCounts && Object.keys(kickerLki.tagCounts).length > 0);
	return withStackItemText(
		{
			id: uid(idPrefix, state),
			sourceInstanceId: t.source.instanceId,
			sourceObjectVersion: t.source.objectVersion,
			sourceLkiPower,
			sourceLkiToughness,
			...(hasKickerInfo
				? {
						sourceKickedCount: kickerLki.count,
						sourceKickedTags: [...kickerLki.tags],
						...(kickerLki.tagCounts && Object.keys(kickerLki.tagCounts).length > 0
							? { sourceKickedTagCounts: { ...kickerLki.tagCounts } }
							: {})
					}
				: {}),
			...(sourceEvoked ? { sourceEvoked: true } : {}),
			...(sourceEscaped ? { sourceEscaped: true } : {}),
			...(sourceForetold ? { sourceForetold: true } : {}),
			...(sourceBlitzed ? { sourceBlitzed: true } : {}),
			...(sourceExertedThisTurn ? { sourceExertedThisTurn: true } : {}),
			...(sourceChosenSubType ? { sourceChosenSubType } : {}),
			...(sourceChosenColor ? { sourceChosenColor } : {}),
			...(sourceMonstrous ? { sourceMonstrous: true } : {}),
			...(sourcePrototyped ? { sourcePrototyped: true } : {}),
			card: t.sourceCard,
			...(t.faceIndex !== undefined ? { faceIndex: t.faceIndex } : {}),
			...(sourceIsFaceDown
				? {
						isFaceDown: true,
						...(sourceFaceDownSpec ? { faceDownSpec: { ...sourceFaceDownSpec } } : {}),
						...(sourceFaceDownLabel ? { faceDownLabel: sourceFaceDownLabel } : {})
					}
				: {}),
			controllerId: t.controllerId,
			kind: 'triggered',
			title: `${titleSource} (${t.label})`,
			targets: [],
			xValue:
				t.ability.trigger.event === 'turnFaceUp' ||
				t.ability.trigger.event === 'becameMonstrous' ||
				Boolean(t.isBecameMonstrous)
					? (t.amount ?? 0)
					: 0,
			requiresGuidedResolution: false,
			createdAt: Date.now(),
			lkiPower: t.amount,
			triggeredAbilityIndex: t.ability.abilityIndex,
			...(t.ability.grantedKeyword ? { grantedKeyword: t.ability.grantedKeyword } : {}),
			eventObjectId: eventObj.instanceId,
			eventObjectVersion: eventObj.objectVersion,
			...(t.eventPlayer ? { eventPlayerId: t.eventPlayer } : {}),
			...(t.defendingPlayerId ? { defendingPlayerId: t.defendingPlayerId } : {}),
			...(t.amount !== undefined ? { eventAmount: t.amount } : {}),
			...(t.targetStackItemId ? { eventStackItemId: t.targetStackItemId } : {}),
			...(t.triggerEventStackItem ? { triggerEventStackItem: t.triggerEventStackItem } : {}),
			...(t.stormCount !== undefined ? { stormCount: t.stormCount } : {}),
			...(t.isChapterAbility || t.ability.trigger.isChapterAbility ? { isChapterAbility: true } : {}),
			...(t.ability.ward ? { wardCost: t.ability.ward.cost } : {}),
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
	return compiledTriggerEffect(
		item.card,
		item.triggeredAbilityIndex,
		item.grantedKeyword,
		item.faceIndex ?? 0,
		item.chosenModes
	);
}

/** The ModalDef for a modal triggered stack item, if any. */
function triggerItemModal(item: StackItem): ModalDef | undefined {
	if (item.kind !== 'triggered' || item.triggeredAbilityIndex === undefined) return undefined;
	return compiledTriggerEffect(item.card, item.triggeredAbilityIndex, item.grantedKeyword, item.faceIndex ?? 0)?.modal;
}

function recordUsedModalModes(
	perm: CardInstance | undefined,
	expectedVersion: number | undefined,
	modal: ModalDef | undefined,
	chosenModes: number[] | undefined
): void {
	if (
		!perm ||
		!modal?.oncePerTurnUnique ||
		!chosenModes?.length ||
		(perm.zone !== 'battlefield' && perm.zone !== 'hand') ||
		(expectedVersion !== undefined && perm.objectVersion !== expectedVersion)
	) {
		return;
	}
	const prev = perm.usedModalModesThisTurn ?? [];
	const next = [...prev];
	for (const idx of chosenModes) {
		if (!next.includes(idx)) next.push(idx);
	}
	perm.usedModalModesThisTurn = next;
}

function modalCandidateModeStatus(
	state: GameState,
	controllerId: string,
	sourceCard: ScryfallCard,
	sourceInst: CardInstance | undefined,
	modal: ModalDef,
	usedModes: number[] | undefined,
	activeSpecFilter: (sp: TargetSpec) => boolean = () => true
): { disabledIndices: number[]; legalModes: number[] } {
	const disabledIndices: number[] = [];
	const legalModes: number[] = [];
	for (let i = 0; i < modal.modes.length; i++) {
		if (modal.oncePerTurnUnique && usedModes?.includes(i)) {
			disabledIndices.push(i);
			continue;
		}
		const modeSpecs = modal.modes[i].targets.filter(activeSpecFilter);
		const hasLegal = modeSpecs.every(
			(spec) => spec.min <= 0 || specTargetCandidates(state, controllerId, sourceCard, sourceInst, spec).length >= spec.min
		);
		if (hasLegal) legalModes.push(i);
		else disabledIndices.push(i);
	}
	return { disabledIndices, legalModes };
}

export function getModalDisabledIndices(
	state: GameState,
	actorId: string,
	sourceCard: ScryfallCard,
	sourceInst: CardInstance | undefined,
	modal: ModalDef,
	usedModes?: number[]
): number[] {
	return modalCandidateModeStatus(state, actorId, sourceCard, sourceInst, modal, usedModes).disabledIndices;
}

function hasLegalModalCombination(modal: ModalDef, legalModes: number[]): boolean {
	if (modal.min === 0 || modal.upTo) return true;
	if (modal.allowRepeat && !modal.oncePerTurnUnique) return legalModes.length > 0;
	return legalModes.length >= modal.min;
}

function validateModalChoice(
	state: GameState,
	actorId: string,
	sourceCard: ScryfallCard,
	sourceInst: CardInstance | undefined,
	modal: ModalDef,
	providedModes: number[] | undefined,
	targets: TargetRef[],
	activeSpecFilter: (sp: TargetSpec) => boolean = () => true,
	usedModes?: number[],
	chooseAllModes = false
):
	| { ok: true; chosenModes: number[]; targetsBySpec: TargetRef[][] }
	| { ok: false; error: string } {
	let chosenModes = providedModes;
	if (chooseAllModes) {
		const allModeIndices = modal.modes.map((_, idx) => idx);
		if (!chosenModes) {
			chosenModes = allModeIndices;
		} else if (
			!Array.isArray(chosenModes) ||
			chosenModes.length !== allModeIndices.length ||
			chosenModes.some((m, idx) => m !== idx)
		) {
			return {
				ok: false,
				error: `Choosing all modes of ${sourceCard.name} requires all ${modal.modes.length} modes in printed order (CR 702.42b).`
			};
		}
	} else if (!chosenModes && modal.max === 1) {
		// "Choose one" call without naming the mode: pick the first unused mode whose targets fit.
		const fit = modal.modes.findIndex((m, idx) => {
			if (modal.oncePerTurnUnique && usedModes?.includes(idx)) return false;
			const mTargets = m.targets.filter(activeSpecFilter);
			const minT = mTargets.reduce((s, sp) => s + sp.min, 0);
			const maxT = mTargets.reduce((s, sp) => s + sp.max, 0);
			if (targets.length < minT || targets.length > maxT) return false;
			let cur = 0;
			return mTargets.every((spec) => {
				const count = spec.min === spec.max ? spec.min : Math.min(spec.max, targets.length - cur);
				const slice = targets.slice(cur, cur + count);
				cur += count;
				if (new Set(slice.map((t) => `${t.kind}:${t.id}`)).size !== slice.length) return false;
				const cands = specTargetCandidates(state, actorId, sourceCard, sourceInst, spec);
				return slice.every((t) => cands.some((c) => c.kind === t.kind && c.id === t.id));
			});
		});
		if (fit >= 0) chosenModes = [fit];
		else if (modal.min === 0 && targets.length === 0) chosenModes = [];
	}

	let effectiveMax = modal.max;
	if (modal.conditionalChooseAll) {
		const ctx: FilterContext = {
			state,
			controllerId: actorId,
			source: sourceInst
		};
		if (evaluateCondition(modal.conditionalChooseAll, ctx)) {
			effectiveMax = modal.modes.length;
		}
	}

	if (
		!chooseAllModes &&
		(!Array.isArray(chosenModes) ||
			chosenModes.length < modal.min ||
			chosenModes.length > effectiveMax ||
			(!modal.allowRepeat && new Set(chosenModes).size !== chosenModes.length) ||
			chosenModes.some((m) => !Number.isInteger(m) || m < 0 || m >= modal.modes.length))
	) {
		return {
			ok: false,
			error: `Choose ${modal.min}–${effectiveMax} mode(s) for ${sourceCard.name}.`
		};
	}
	if (!Array.isArray(chosenModes)) {
		return {
			ok: false,
			error: `Choose ${modal.min}–${modal.max} mode(s) for ${sourceCard.name}.`
		};
	}

	if (modal.oncePerTurnUnique && usedModes?.length) {
		const dup = chosenModes.find((m) => usedModes.includes(m));
		if (dup !== undefined) {
			return {
				ok: false,
				error: `Mode ${dup + 1} of ${sourceCard.name} has already been chosen this turn.`
			};
		}
	}

	const allSpecs: { modeIndex: number; spec: TargetSpec; active: boolean }[] = [];
	for (let modeIndex = 0; modeIndex < chosenModes.length; modeIndex++) {
		const m = chosenModes[modeIndex];
		for (const spec of modal.modes[m].targets) {
			allSpecs.push({ modeIndex, spec, active: activeSpecFilter(spec) });
		}
	}

	const activeEntries = allSpecs.filter((e) => e.active);
	const minRequired = activeEntries.reduce((sum, r) => sum + r.spec.min, 0);
	const maxAllowed = activeEntries.reduce((sum, r) => sum + r.spec.max, 0);
	if (targets.length < minRequired || targets.length > maxAllowed) {
		return {
			ok: false,
			error: `${sourceCard.name} requires ${minRequired === maxAllowed ? minRequired : `${minRequired}–${maxAllowed}`} target(s) for the chosen mode(s).`
		};
	}

	const counts = activeEntries.map((r) => r.spec.min);
	let extra = targets.length - minRequired;
	for (let k = 0; k < activeEntries.length && extra > 0; k++) {
		const add = Math.min(extra, activeEntries[k].spec.max - counts[k]);
		if (add > 0) {
			counts[k] += add;
			extra -= add;
		}
	}

	const targetsBySpec: TargetRef[][] = [];
	let activeCursor = 0;
	let targetCursor = 0;
	for (const entry of allSpecs) {
		if (!entry.active) {
			targetsBySpec.push([]);
			continue;
		}
		const count = counts[activeCursor++];
		const slice = targets.slice(targetCursor, targetCursor + count);
		targetCursor += count;
		const uniqueInSpec = new Set(slice.map((t) => `${t.kind}:${t.id}`));
		if (uniqueInSpec.size !== slice.length) {
			return {
				ok: false,
				error: 'Strict Rules Violation: The same object cannot be chosen multiple times for the same target requirement (CR 115.3).'
			};
		}
		const legal = specTargetCandidates(state, actorId, sourceCard, sourceInst, entry.spec);
		for (const t of slice) {
			if (!legal.some((c) => c.kind === t.kind && c.id === t.id)) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${t.label} is not a legal target for mode ${chosenModes[entry.modeIndex] + 1} of ${sourceCard.name}.`
				};
			}
		}
		targetsBySpec.push(slice);
	}
	return { ok: true, chosenModes, targetsBySpec };
}

/** The interpreter's EffectContext fields for a triggered ability's event (CR 603.7c). */
function triggerEventContext(item: StackItem) {
	return {
		eventObjectId: item.eventObjectId,
		eventObjectVersion: item.eventObjectVersion,
		eventPlayerId: item.eventPlayerId,
		defendingPlayerId: item.defendingPlayerId,
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
		if (state.triggersPlacedThisTurn) {
			state.triggersPlacedThisTurn.resolutionSerial = (state.triggersPlacedThisTurn.resolutionSerial ?? 0) + 1;
		}
		executeTriggerEffects(state, controller, triggeredStackItem(state, t, 'trg'));
		addLog(
			state,
			'trigger',
			`${triggerSourcePublicName(state, t)} (${t.label}) triggered for ${controller.username}.`,
			controller.playerId
		);
	},
	putOnStack: putTriggerOnStack,
	orderSimultaneous: askTriggerOrder
	// Step E2: no `canExecute` filter. Every matched ability triggers; one the engine can't run is
	// resolved manually (human) or by its legacy effects / skipped (bot) as it resolves.
});

/**
 * CR 104.4b / CR 731: number of repeated trigger-resolution cycles for the same
 * `(sourceInstanceId, abilityIndex)` within a turn (since the last voluntary player action)
 * before the engine detects a mandatory or optional loop.
 */
export const LOOP_TRIGGER_THRESHOLD = 30;
/**
 * A runaway safety cap: triggered abilities that keep retriggering each other would otherwise grow
 * the stack (and the bot loop) without end. Past this size new triggers pause for manual resolution.
 */
export const MAX_STACK_FOR_TRIGGERS = 300;
/**
 * Hard backstop ceiling for total triggered abilities put on the stack in a single turn.
 */
export const MAX_TRIGGERS_PER_TURN = 2000;

/**
 * Clears per-ability loop tracking when a player takes a voluntary game action so a player-driven
 * combo or repeated activations in the same turn start a fresh loop-detection window.
 */
function resetTriggerLoopTracking(state: GameState): void {
	if (state.triggersPlacedThisTurn?.byAbility) {
		delete state.triggersPlacedThisTurn.byAbility;
	}
}

/** Whether a triggered stack item has an optional ("may") choice (CR 731.2b). */
function triggerItemIsOptional(item: StackItem): boolean {
	const compiled = triggerItemEffect(item);
	if (!compiled || !staticallyInterpretable(compiled, true)) return false;
	return optionalPrefix(compiled.steps) > 0 || compiled.steps.some((s) => Boolean(s.optional));
}

/**
 * Computes both an exact board fingerprint (derived from `buildBoardSnapshot(state).active` over each
 * active permanent's `instanceId@objectVersion`, controller, tapped state, attachment, and `+1/+1`,
 * `-1/-1`, and `loyalty` counters) and a token-normalized board fingerprint (coalescing identical
 * tokens by name, typeLine, controller, and tapped state so mandatory token-creation loops also
 * repeat their normalized fingerprint). Includes per-player life, poison, lost status, library size,
 * hand size, and commander damage taken because under CR 104.4b a sequence that changes a
 * game-ending resource (life, poison, library, commander damage) will eventually end the game and is
 * not an unbreakable infinite loop.
 */
function computeLoopBoardFingerprints(state: GameState): { exactFp: string; normFp: string } {
	const snap = buildBoardSnapshot(state);
	const playerSegment = state.players
		.map((p) => {
			const cmdDmg = Object.keys(p.commanderDamageTaken)
				.sort()
				.map((k) => `${k}=${p.commanderDamageTaken[k]}`)
				.join('|');
			return `${p.playerId}:${p.life}:${p.poison}:${p.energyCounters || 0}:${p.lost ? 1 : 0}:${p.library.length}:${p.hand.length}:${cmdDmg}`;
		})
		.join(';') + `@monarch:${state.monarchPlayerId ?? ''}`;
	const exactBoard = snap.active
		.map(
			({ perm, playerId }) =>
				`${perm.instanceId}@${perm.objectVersion ?? 0}:${perm.controllerId ?? playerId}:${perm.tapped ? 1 : 0}:${perm.attachedToId ?? ''}:${perm.counters['+1/+1']},${perm.counters['-1/-1']},${perm.counters.loyalty},${perm.counters.lore || 0}`
		)
		.join(',');
	const parts: string[] = [];
	for (const p of state.players) {
		const tokenKinds = new Set<string>();
		const nonTokenEntries: string[] = [];
		for (const c of p.battlefield) {
			if (c.isToken) {
				tokenKinds.add(`${c.card.name}|${c.card.typeLine}|${c.controllerId ?? p.playerId}|${c.tapped ? 1 : 0}`);
			} else {
				nonTokenEntries.push(
					`${c.instanceId}@${c.objectVersion ?? 0}:${c.controllerId ?? p.playerId}:${c.tapped ? 1 : 0}:${c.counters['+1/+1']},${c.counters['-1/-1']},${c.counters.loyalty}`
				);
			}
		}
		parts.push(`${p.playerId}:[${nonTokenEntries.join(',')}]:[${[...tokenKinds].sort().join(',')}]`);
	}
	return {
		exactFp: `${exactBoard}#${playerSegment}`,
		normFp: `${parts.join(';')}#${playerSegment}`
	};
}

/** Enqueues a standalone guided_resolution prompt so a human player can resolve or intervene manually. */
export function enqueueGuidedResolutionPrompt(
	state: GameState,
	playerId: string,
	title: string,
	description: string,
	question: string
): void {
	enqueueChoicePrompt(state, {
		id: uid('prm', state),
		playerId,
		kind: 'guided_resolution',
		purpose: 'guided_resolution',
		title,
		description,
		yesLabel: 'Done',
		choice: { kind: 'yesNo', question }
	});
}

function handleTriggerBackstopReached(state: GameState, t: PendingTrigger, reason: string): null {
	addLog(state, 'rule', reason, t.controllerId);
	const activePlayers = state.players.filter((p) => !p.lost);
	const human =
		activePlayers.find((p) => !p.isBot && p.playerId === t.controllerId) ??
		activePlayers.find((p) => !p.isBot && p.playerId === state.players[state.activePlayerIndex]?.playerId) ??
		activePlayers.find((p) => !p.isBot);
	if (human) {
		if (!state.pendingPrompts.some((p) => p.purpose === 'guided_resolution')) {
			enqueueGuidedResolutionPrompt(
				state,
				human.playerId,
				`Trigger Safety Cap Reached (${t.sourceCard.name})`,
				reason,
				'The runaway trigger safety cap was reached. Apply any manual adjustments below, then click Done.'
			);
		}
	} else {
		revealFaceDownObjects(state);
		state.status = 'finished';
		state.winnerPlayerId = null;
		state.winnerId = undefined;
		state.pendingPrompts = [];
		state.stack = [];
	}
	return null;
}

const MANDATORY_LOOP_HANDLER = 'mandatory_loop_choice';

registerPromptHandler(MANDATORY_LOOP_HANDLER, (state, prompt, answer) => {
	const mode = answer.kind === 'chooseMode' ? (answer.indices[0] ?? 0) : 0;
	const data = (prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined) as
		| { abilityKey?: string; sourceName?: string; label?: string }
		| undefined;
	if (mode === 0) {
		revealFaceDownObjects(state);
		state.status = 'finished';
		state.winnerPlayerId = null;
		state.winnerId = undefined;
		state.pendingPrompts = [];
		state.stack = [];
		addLog(
			state,
			'rule',
			`CR 104.4b: The game ended in a draw due to an unbreakable mandatory trigger loop${data?.sourceName ? ` (${data.sourceName})` : ''}.`,
			prompt.playerId
		);
		return;
	}
	const byAbility = state.triggersPlacedThisTurn?.byAbility;
	if (byAbility) {
		for (const [k, entry] of Object.entries(byAbility)) {
			const currentLimit = entry.limit ?? LOOP_TRIGGER_THRESHOLD;
			if (k === data?.abilityKey || entry.cycles >= currentLimit) {
				entry.limit = currentLimit + LOOP_TRIGGER_THRESHOLD;
			}
		}
	}
	addLog(
		state,
		'rule',
		`Continuing mandatory trigger loop for ${LOOP_TRIGGER_THRESHOLD} more trigger cycles.`,
		prompt.playerId
	);
});

/** Target specs the trigger target choice supports (zones it can enumerate). */
function triggerSpecsSupported(specs: TargetSpec[]): boolean {
	return specs.every((sp) => {
		if (sp.kind === 'player') return true;
		const z = sp.filter.zone ?? 'battlefield';
		return z === 'battlefield' || z === 'graveyard' || z === 'stack' || z === 'exile';
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
	if (owner !== controllerId && (hasKeyword(inst, 'Hexproof', state) || hasHexproofFromQuality(inst, sourceCard, state))) return false;
	return !hasProtectionFrom(inst, sourceCard, state);
}

/** Every legal target for one target spec (CR 115, 603.3d). */
export function specTargetCandidates(
	state: GameState,
	controllerId: string,
	sourceCard: ScryfallCard,
	source: CardInstance | undefined,
	spec: TargetSpec,
	excludeStackItemId?: string,
	stackItem?: StackItem
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
	const ctx: FilterContext = {
		state,
		controllerId,
		source,
		...(stackItem ? { stackItem } : {})
	};
	const zone = spec.filter.zone ?? 'battlefield';
	if (zone === 'stack') {
		const stackKind = spec.filter.stackKind ?? 'spell';
		for (const stk of state.stack) {
			if (excludeStackItemId && stk.id === excludeStackItemId) continue;
			if (stackKind === 'spell' && stk.kind !== 'spell') continue;
			if (stackKind === 'ability' && stk.kind !== 'activated' && stk.kind !== 'triggered') continue;
			if (stackKind === 'activatedAbility' && stk.kind !== 'activated') continue;
			if (stackKind === 'triggeredAbility' && stk.kind !== 'triggered') continue;
			if (
				source &&
				(stk.id === source.instanceId ||
					(stk.kind === 'spell' && stk.sourceInstanceId === source.instanceId))
			) {
				continue;
			}
			if (spec.filter.controller === 'opponent' && stk.controllerId === controllerId) continue;
			if (spec.filter.controller === 'you' && stk.controllerId !== controllerId) continue;
			if (stk.kind === 'spell' && stk.card) {
				const stkFace = resolveObjectFaces(stk.card, stackItemFaceOptions(stk));
				if (spec.filter.types?.length && !spec.filter.types.some((t) => stkFace.types.includes(t))) {
					continue;
				}
				if (spec.filter.notTypes?.length && spec.filter.notTypes.some((t) => stkFace.types.includes(t))) {
					continue;
				}
				if (spec.filter.colors?.length && !matchesColorFilter(stkFace.colors, spec.filter.colors)) {
					continue;
				}
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
		} else if (zone === 'exile') {
			for (const c of p.exile) {
				if (matchesObjectFilter(c, spec.filter, ctx)) out.push({ kind: 'exile_card', id: c.instanceId, label: c.card.name });
			}
		}
	}
	return out;
}

/** Every legal target for one target spec of a triggered ability (CR 115, 603.3d). */
function triggerTargetCandidates(state: GameState, item: StackItem, spec: TargetSpec): TargetRef[] {
	return specTargetCandidates(
		state,
		item.controllerId,
		item.card,
		triggerSourceObject(state, item),
		spec,
		item.id,
		item
	);
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
function assignOrPromptTriggerTargets(
	state: GameState,
	controller: PlayerGameState,
	item: StackItem,
	specs: TargetSpec[],
	candidates: TargetRef[][]
): void {
	const steps = triggerItemEffect(item)?.steps ?? [];
	const targetsBySpec: TargetRef[][] = specs.map(() => []);
	specs.forEach((spec, i) => {
		const priorChosen =
			spec.otherTarget && i > 0
				? new Set(
						targetsBySpec
							.slice(0, i)
							.flat()
							.map((t) => `${t.kind}:${t.id}`)
					)
				: null;
		const legal = priorChosen
			? candidates[i].filter((c) => !priorChosen.has(`${c.kind}:${c.id}`))
			: candidates[i];
		const max = Math.min(spec.max, legal.length);
		if (controller.isBot) {
			targetsBySpec[i] = chooseBotTriggerTargets(state, controller, steps, i, spec, legal);
		} else if (legal.length === spec.min && max === spec.min) {
			// Forced: exactly as many legal targets as required.
			targetsBySpec[i] = [...legal];
		} else {
			targetsBySpec[i] = [];
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
	if (specs.length > 0) {
		item.targetsBySpec = targetsBySpec;
		item.targets = targetsBySpec.flat();
	}
	item.targetObjectVersions = captureTargetObjectVersions(state, item.targets);
	// CR 115.1, 603.3d, 702.21a: permanents targeted as a triggered ability goes on the stack trigger Ward / becomes-target abilities.
	for (const t of item.targets) {
		const targeted = t.kind === 'permanent' ? findPermanentOnBoard(state, t.id) : null;
		if (targeted) {
			emitEvent(state, {
				kind: 'BecameTarget',
				objectId: t.id,
				object: targeted.inst,
				by: 'ability',
				controllerId: item.controllerId,
				stackItemId: item.id
			});
		}
	}
}

function putTriggerOnStack(state: GameState, t: PendingTrigger): StackItem | null {
	if (state.status === 'finished') return null;
	if (state.stack.length >= MAX_STACK_FOR_TRIGGERS) {
		return handleTriggerBackstopReached(
			state,
			t,
			`${triggerSourcePublicName(state, t)}'s ${t.label} was not put onto the Stack: the stack already holds ${state.stack.length} objects (runaway trigger loop safety cap).`
		);
	}
	const currentTurnKey = state.turnSerial ?? state.turnNumber;
	const placed =
		state.triggersPlacedThisTurn?.turn === currentTurnKey
			? state.triggersPlacedThisTurn
			: { turn: currentTurnKey, count: 0 };
	state.triggersPlacedThisTurn = placed;
	if (placed.count >= MAX_TRIGGERS_PER_TURN) {
		if (placed.count === MAX_TRIGGERS_PER_TURN) {
			placed.count++;
			return handleTriggerBackstopReached(
				state,
				t,
				`Triggered abilities are no longer put onto the Stack this turn: ${MAX_TRIGGERS_PER_TURN} already were (runaway trigger loop safety cap).`
			);
		}
		return null;
	}
	const controller = state.players.find((p) => p.playerId === t.controllerId);
	if (!controller) return null;
	const item = triggeredStackItem(state, t, 'stk');
	const modal = t.ability.effect?.modal ?? triggerItemModal(item);
	const foundSrcPerm = findPermanentOnBoard(state, t.source.instanceId);
	const srcObj = triggerSourceObject(state, item);
	const usedModes =
		foundSrcPerm && foundSrcPerm.inst.objectVersion === t.source.objectVersion
			? foundSrcPerm.inst.usedModalModesThisTurn
			: undefined;

	let needsHumanModePrompt = false;
	let modalDisabledIndices: number[] = [];
	if (modal && !item.chosenModes) {
		const status = modalCandidateModeStatus(
			state,
			t.controllerId,
			item.card,
			srcObj,
			modal,
			usedModes
		);
		modalDisabledIndices = status.disabledIndices;
		if (!hasLegalModalCombination(modal, status.legalModes)) {
			addLog(
				state,
				'rule',
				`${item.title} was removed from the Stack: no legal modes can be chosen (CR 700.2b / 603.3c).`,
				t.controllerId
			);
			return null;
		}
		if (controller.isBot) {
			const picked = chooseBotModalTriggerModes(state, controller, item, modal, usedModes);
			if (picked.length === 0) {
				addLog(
					state,
					'rule',
					`${item.title} was removed from the Stack: no mode was chosen (CR 603.3c).`,
					t.controllerId
				);
				return null;
			}
			item.chosenModes = picked;
			recordUsedModalModes(foundSrcPerm?.inst, t.source.objectVersion, modal, picked);
		} else if (!modal.allowRepeat && !modal.upTo && status.legalModes.length === modal.min && modal.min === modal.max) {
			item.chosenModes = [...status.legalModes];
			recordUsedModalModes(foundSrcPerm?.inst, t.source.objectVersion, modal, item.chosenModes);
		} else {
			needsHumanModePrompt = true;
		}
	}

	const specs = needsHumanModePrompt ? [] : triggerItemTargetSpecs(item);
	const candidates = specs.map((spec) => triggerTargetCandidates(state, item, spec));
	if (!needsHumanModePrompt) {
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
	}

	// Phase 4 (CR 104.4b, CR 731): detect repeated trigger-resolution cycles for the same
	// `(sourceInstanceId, abilityIndex)` without an intervening voluntary player action.
	const abilityKey = `${t.source.instanceId}:${t.ability.abilityIndex}`;
	const currentResSerial = placed.resolutionSerial ?? 0;
	const byAbility = placed.byAbility ?? (placed.byAbility = {});
	let loopEntry = byAbility[abilityKey];
	if (!loopEntry) {
		const { exactFp, normFp } = computeLoopBoardFingerprints(state);
		loopEntry = {
			cycles: 1,
			lastResolutionSerial: currentResSerial,
			lastExactFp: exactFp,
			lastNormFp: normFp,
			cycled: false
		};
		byAbility[abilityKey] = loopEntry;
	} else if (loopEntry.lastResolutionSerial !== currentResSerial) {
		const { exactFp, normFp } = computeLoopBoardFingerprints(state);
		const cycled =
			exactFp === loopEntry.lastExactFp ||
			normFp === loopEntry.lastNormFp;
		loopEntry.cycles += 1;
		loopEntry.lastResolutionSerial = currentResSerial;
		loopEntry.lastExactFp = exactFp;
		loopEntry.lastNormFp = normFp;
		loopEntry.cycled = cycled;
	}
	const allowedLimit = loopEntry.limit ?? LOOP_TRIGGER_THRESHOLD;
	if (loopEntry.cycles > allowedLimit && loopEntry.cycled) {
		if (triggerItemIsOptional(item)) {
			if (controller.isBot) {
				item.optionalAccepted = false;
				addLog(
					state,
					'rule',
					`CR 731.2b: ${controller.username} (bot) declined the optional trigger ${item.title} after ${allowedLimit} iterations to break a loop (runaway trigger loop safety cap).`,
					controller.playerId
				);
			} else {
				addLog(
					state,
					'rule',
					`CR 731.2b: Optional trigger loop detected on ${item.title} (${allowedLimit} iterations); choose whether to continue or decline when it resolves.`,
					controller.playerId
				);
			}
		} else {
			addLog(
				state,
				'rule',
				`CR 104.4b: Mandatory trigger loop detected on ${item.title} after ${allowedLimit} iterations (runaway trigger loop safety cap).`,
				controller.playerId
			);
			const activePlayers = state.players.filter((p) => !p.lost);
			const human =
				activePlayers.find((p) => !p.isBot && p.playerId === controller.playerId) ??
				activePlayers.find((p) => !p.isBot && p.playerId === state.players[state.activePlayerIndex]?.playerId) ??
				activePlayers.find((p) => !p.isBot);
			if (!human) {
				revealFaceDownObjects(state);
				state.status = 'finished';
				state.winnerPlayerId = null;
				state.winnerId = undefined;
				state.pendingPrompts = [];
				state.stack = [];
				return null;
			}
			const alreadyPrompted = state.pendingPrompts.some(
				(p) => p.continuation?.kind === 'handler' && p.continuation.name === MANDATORY_LOOP_HANDLER
			);
			if (!alreadyPrompted) {
				const reason = `Mandatory trigger loop detected on ${item.title} (${allowedLimit} iterations). Choose how to proceed:`;
				enqueueChoicePrompt(state, {
					id: uid('prm', state),
					playerId: human.playerId,
					kind: 'chooseMode',
					purpose: 'generic',
					title: `Mandatory Trigger Loop (${t.sourceCard.name})`,
					description: reason,
					continuation: {
						kind: 'handler',
						name: MANDATORY_LOOP_HANDLER,
						data: { abilityKey, sourceName: t.sourceCard.name, label: t.label }
					},
					choice: {
						kind: 'chooseMode',
						modes: [
							'End the game in a draw (CR 104.4b)',
							`Let it run ${LOOP_TRIGGER_THRESHOLD} more triggers`
						],
						min: 1,
						max: 1
					}
				});
			}
		}
	}

	state.stack.push(item);
	placed.count++;
	addLog(state, 'trigger', `${triggerSourcePublicName(state, t)}'s ${t.label} was put onto the Stack.`, t.controllerId);

	if (needsHumanModePrompt && modal) {
		const modeLabels = describeModalModes(item.card, modal, item.faceIndex ?? 0);
		const reason =
			modal.min === modal.max
				? `Choose ${modal.min} mode(s) for ${item.title}.`
				: `Choose ${modal.min}–${modal.max} mode(s) for ${item.title}.`;
		enqueueChoicePrompt(state, {
			id: uid('prm', state),
			playerId: controller.playerId,
			kind: 'chooseMode',
			purpose: 'trigger_modes',
			title: `Choose Mode (${item.card.name})`,
			description: reason,
			triggerStackItemId: item.id,
			choice: {
				kind: 'chooseMode',
				modes: modeLabels,
				min: modal.min,
				max: modal.max,
				...(modal.allowRepeat ? { allowRepeat: true } : {}),
				...(modalDisabledIndices.length > 0 ? { disabledIndices: modalDisabledIndices } : {})
			}
		});
		return item;
	}

	assignOrPromptTriggerTargets(state, controller, item, specs, candidates);
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
	if (!item) {
		return { ok: false, error: 'That triggered ability is no longer on the stack.' };
	}
	if (purpose === 'trigger_modes') {
		if (answer?.kind !== 'chooseMode') {
			return { ok: false, error: 'Choose the required mode(s).' };
		}
		const modal = triggerItemModal(item);
		const controller = state.players.find((p) => p.playerId === item.controllerId);
		if (!modal || !controller) {
			return { ok: false, error: 'That modal trigger is no longer valid.' };
		}
		const foundSrcPerm = findPermanentOnBoard(state, item.sourceInstanceId);
		const usedModes =
			foundSrcPerm && foundSrcPerm.inst.objectVersion === item.sourceObjectVersion
				? foundSrcPerm.inst.usedModalModesThisTurn
				: undefined;
		if (modal.oncePerTurnUnique && usedModes?.some((u) => answer.indices.includes(u))) {
			return { ok: false, error: 'A chosen mode has already been chosen this turn.' };
		}
		const expanded = expandModalEffects(modal, answer.indices);
		if (!expanded) {
			return { ok: false, error: 'Invalid mode selection.' };
		}
		const candidates = expanded.targets.map((spec) => triggerTargetCandidates(state, item, spec));
		const impossible = expanded.targets.findIndex((spec, i) => spec.min > 0 && candidates[i].length < spec.min);
		if (impossible >= 0) {
			return { ok: false, error: 'A chosen mode has no legal targets.' };
		}

		state.pendingPrompts.splice(promptIdx, 1);
		if (answer.indices.length === 0) {
			const idx = state.stack.indexOf(item);
			if (idx >= 0) state.stack.splice(idx, 1);
			addLog(
				state,
				'rule',
				`${item.title} was removed from the Stack (no mode chosen, CR 603.3c).`,
				item.controllerId
			);
			flushTriggers(state);
			return { ok: true };
		}
		item.chosenModes = [...answer.indices];
		recordUsedModalModes(foundSrcPerm?.inst, item.sourceObjectVersion, modal, item.chosenModes);
		addLog(
			state,
			'trigger',
			`${controller.username} chose mode(s) ${answer.indices.map((i) => i + 1).join(', ')} for ${item.title}.`,
			item.controllerId
		);
		const specs = triggerItemTargetSpecs(item);
		assignOrPromptTriggerTargets(state, controller, item, specs, candidates);
		flushTriggers(state);
		return { ok: true };
	}
	if (purpose === 'trigger_targets') {
		if (answer?.kind !== 'chooseObjects') {
			return { ok: false, error: 'Choose the required targets.' };
		}
		const specIdx = prompt.triggerTargetSpecIndex ?? 0;
		const specs = triggerItemTargetSpecs(item);
		const spec = specs[specIdx];
		if (!spec) {
			return { ok: false, error: 'That target requirement is no longer valid.' };
		}
		state.pendingPrompts.splice(promptIdx, 1);
		const legal = triggerTargetCandidates(state, item, spec);
		const chosen = answer.objectIds
			.map((id) => legal.find((c) => c.id === id))
			.filter((c): c is TargetRef => Boolean(c));
		if (!item.targetsBySpec) {
			item.targetsBySpec = specs.map((_, idx) =>
				idx === specIdx ? [] : idx === 0 ? [...item.targets] : []
			);
		}
		item.targetsBySpec[specIdx] = chosen;
		item.targets = item.targetsBySpec.flat();
		item.targetObjectVersions = captureTargetObjectVersions(state, item.targets);
		addLog(
			state,
			'trigger',
			`${item.title} targets ${chosen.length > 0 ? chosen.map((c) => c.label).join(', ') : 'nothing'}.`,
			item.controllerId
		);
		for (const t of chosen) {
			const targeted = t.kind === 'permanent' ? findPermanentOnBoard(state, t.id) : null;
			if (targeted) {
				emitEvent(state, {
					kind: 'BecameTarget',
					objectId: t.id,
					object: targeted.inst,
					by: 'ability',
					controllerId: item.controllerId,
					stackItemId: item.id
				});
			}
		}
		flushTriggers(state);
		return { ok: true };
	}
	// trigger_may: record the answer and finish resolving the ability (it stayed on the stack).
	if (answer?.kind !== 'yesNo') {
		return { ok: false, error: 'Expected a yes/no choice.' };
	}
	state.pendingPrompts.splice(promptIdx, 1);
	item.optionalAccepted = answer.yes;
	// Resume by id: triggers that fired meanwhile may sit above it on the stack.
	resumeStackItem(state, item);
	return { ok: true };
}

function itemWard(item: StackItem): { cost: string; costDefs?: CostDef[] } | undefined {
	if (item.kind !== 'triggered') return undefined;
	if (item.triggeredAbilityIndex !== undefined) {
		const compiled = runtimeTriggers(compileCard(item.card), item.faceIndex ?? 0).find(
			(x) => x.abilityIndex === item.triggeredAbilityIndex
		)?.ward;
		if (compiled) return compiled;
	}
	if (item.wardCost !== undefined) {
		const parsed = parseCost(item.wardCost);
		return { cost: item.wardCost, costDefs: parsed.defs };
	}
	return undefined;
}

function resolveWardTrigger(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState,
	ward: { cost: string; costDefs?: CostDef[] }
): boolean {
	const srcLabel = item.isFaceDown ? (item.faceDownLabel || 'Face-Down Permanent') : item.card.name;
	const targetItem = state.stack.find((s) => s.id === (item.eventStackItemId ?? item.targets[0]?.id));
	if (!targetItem) return true;
	const opp = state.players.find((p) => p.playerId === targetItem.controllerId);
	const wardCost = (ward.cost || '{1}').trim();
	const lifeDef = ward.costDefs?.find((d): d is Extract<CostDef, { k: 'payLife' }> => d.k === 'payLife');
	const lifeCost = lifeDef && lifeDef.amount.k === 'const' ? lifeDef.amount.n : undefined;
	const req = lifeCost === undefined ? parseManaCost(wardCost) : undefined;
	const canAfford = Boolean(
		opp &&
			!targetItem.declineWard &&
			(lifeCost !== undefined
				? !playerLifeTotalCantChange(state, opp) && opp.life >= lifeCost
				: req
					? canPayOrAutoTap(opp, req, state)
					: false)
	);
	if (opp && !opp.isBot && canAfford && item.optionalAccepted === undefined) {
		const question = `Pay ward cost ${wardCost}?`;
		enqueueChoicePrompt(state, {
			id: uid('prm', state),
			playerId: opp.playerId,
			kind: 'yesNo',
			purpose: 'generic',
			title: `Ward (${srcLabel})`,
			description: question,
			yesLabel: `Pay ${wardCost}`,
			noLabel: 'Decline (counter)',
			continuation: {
				kind: 'procedure',
				procedure: {
					kind: 'ward_payment_choice',
					wardStackItemId: item.id,
					targetStackItemId: targetItem.id
				}
			},
			choice: { kind: 'yesNo', question }
		});
		return false;
	}
	let paid = false;
	if (opp && canAfford && (opp.isBot || item.optionalAccepted === true)) {
		if (lifeCost !== undefined) {
			opp.life -= lifeCost;
			paid = true;
			addLog(
				state,
				'rule',
				`${opp.username} paid ${lifeCost} life for ${srcLabel}'s Ward (CR 702.21a).`,
				opp.playerId
			);
		} else if (req) {
			payManaWithAutoTap(opp, req, state);
			paid = true;
			addLog(
				state,
				'rule',
				`${opp.username} paid ${wardCost} for ${srcLabel}'s Ward (CR 702.21a).`,
				opp.playerId
			);
		}
	}
	if (!paid) {
		if (targetItem.kind === 'spell' && spellCannotBeCountered(state, targetItem)) {
			addLog(
				state,
				'rule',
				`${targetItem.title} could not be countered by ${srcLabel}'s Ward (CR 702.21a)!`,
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
					`${srcLabel}'s Ward countered ${countered.title} (CR 702.21a)!`,
					controller.playerId
				);
			}
		}
	}
	return true;
}

function resolveDelayedTriggerEffect(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState,
	eff: DelayedTriggerEffect
): void {
	if (eff.kind === 'sacrifice') {
		const found = findPermanentOnBoard(state, eff.targetInstanceId);
		if (
			found &&
			!found.inst.phasedOut &&
			found.controller.playerId === controller.playerId &&
			(eff.targetObjectVersion === undefined || found.inst.objectVersion === eff.targetObjectVersion)
		) {
			const permName = found.inst.card.name;
			movePermanentToZone(state, found.inst, 'graveyard');
			addLog(
				state,
				'cast',
				`${controller.username} sacrificed ${permName} (${item.title}).`,
				controller.playerId
			);
		}
		return;
	}
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
	if (eff.kind === 'warpExile') {
		const found = findPermanentOnBoard(state, eff.targetInstanceId);
		if (
			found &&
			!found.inst.phasedOut &&
			(eff.targetObjectVersion === undefined || found.inst.objectVersion === eff.targetObjectVersion)
		) {
			const targetInst = found.inst;
			emitVfx(state, { kind: 'exile', targetId: targetInst.instanceId, label: targetInst.card.name });
			movePermanentToZone(state, targetInst, 'exile');
			// CR 702.185a / 702.185b: If exiled this way, its owner may cast it after the current turn has ended.
			if (targetInst.zone === 'exile' && !targetInst.isToken) {
				targetInst.warpedByOwnerId = targetInst.ownerId;
				targetInst.warpedTurnSerial = state.turnSerial ?? state.turnNumber;
			}
			addLog(
				state,
				'cast',
				`${item.title} exiled ${targetInst.card.name} (Warp — castable from exile on a later turn).`,
				controller.playerId
			);
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
		return;
	}
	if (eff.kind === 'scry') {
		initiateLibraryScryOrSurveil(state, controller, item, eff.amount, 'scry', false);
		return;
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
	if (item.kind === 'spell') {
		const types = resolveObjectFaces(item.card, stackItemFaceOptions(item)).types;
		return types.includes('Instant') || types.includes('Sorcery');
	}
	return (
		item.triggeredAbilityIndex !== undefined &&
		!itemWard(item) &&
		!item.delayedEffect &&
		!item.inherentTrigger
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
 * stays on the stack (`resolutionStarted: true`) and resumes here by id once answered; any
 * triggers that fired while it was paused stay in `state.pendingTriggers` and flush after it
 * finishes resolving and leaves the stack (CR 603.3, 608.2n).
 */
function resumeStackItem(state: GameState, item: StackItem): void {
	if (!state.stack.includes(item)) return;
	withTriggersDeferred(state, () => resolveStackItemNow(state, item));
	flushTriggers(state);
}

/** Whether a resolving item still waits for one of its prompts (it must not resolve again meanwhile). */
function stackItemAwaitsPrompt(state: GameState, item: StackItem): boolean {
	return state.pendingPrompts.some((p) => {
		if (p.triggerStackItemId === item.id) return true;
		const c = p.continuation;
		if (!c) return false;
		if (c.kind === 'effect_choice' || c.kind === 'effect_resume' || c.kind === 'manual_resolution') {
			return c.stackItemId === item.id;
		}
		if (c.kind === 'procedure') {
			const proc = c.procedure;
			if ('stackItemId' in proc && proc.stackItemId === item.id) return true;
			if ('wardStackItemId' in proc && proc.wardStackItemId === item.id) return true;
			if ('resumeStackItemId' in proc && proc.resumeStackItemId === item.id) return true;
			return false;
		}
		if (c.kind === 'handler') {
			return (
				c.data?.wardStackItemId === item.id ||
				c.data?.stackItemId === item.id ||
				c.data?.resumeStackItemId === item.id
			);
		}
		return false;
	});
}

function rehydrateDelayedBindings(
	state: GameState,
	boundRefs: SerializedBoundRef[]
): Record<string, EffectBindingSnapshot[]> {
	const out: Record<string, EffectBindingSnapshot[]> = {};
	for (const ref of boundRefs) {
		const found = findCardAnywhere(state, ref.id);
		// CR 603.7c & CR 400.7: Omit bound objects that changed zones or objectVersion since trigger creation.
		if (!found || found.zone !== ref.expectedZone) continue;
		if ((found.inst.objectVersion ?? 1) !== ref.objectVersion) continue;
		(out[ref.key] ??= []).push({ id: ref.id, lki: { ...ref.lki } });
	}
	return out;
}

function filterDelayedTargets(state: GameState, eff: CompiledDelayedEffect): TargetRef[] {
	return eff.targets.filter((t) => {
		if (t.kind === 'player') {
			const pl = state.players.find((p) => p.playerId === t.id);
			return Boolean(pl && !pl.lost);
		}
		if (t.kind === 'stack') return state.stack.some((s) => s.id === t.id);
		const found = findCardAnywhere(state, t.id);
		if (!found) return false;
		const expectedVer = eff.targetObjectVersions?.[t.id];
		if (expectedVer !== undefined && (found.inst.objectVersion ?? 1) !== expectedVer) return false;
		return true;
	});
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
			item.sourceInstanceId,
			item
		)
	) {
		removeItemFromStack();
		addLog(
			state,
			'rule',
			`${item.title} did not resolve because its intervening-if condition is no longer met (CR 603.4).`,
			controller.playerId
		);
		givePriorityToActiveOrNextPlayer(state);
		state.passedPriorityPlayerIds = [];
		checkStateBasedActions(state);
		return;
	}

	// Check if all targets are still legal (Fizzle rule CR 608.2b)
	if (!resuming && item.targets.length > 0) {
		const triggerSpecs = item.kind === 'triggered' ? triggerItemTargetSpecs(item) : [];
		const isTargetValid = (t: TargetRef) =>
			isTargetStillValid(state, t, item.controllerId, item.card, item) &&
			(triggerSpecs.length === 0 || triggerTargetStillLegal(state, item, triggerSpecs, t));
		let validTargets: TargetRef[];
		if (item.targetsBySpec) {
			let bucketSpecs: Array<TargetSpec | undefined> | undefined;
			if (item.kind === 'triggered' && triggerSpecs.length === item.targetsBySpec.length) {
				bucketSpecs = triggerSpecs;
			} else if (!item.chosenModes && !item.card?.typeLine.includes('Aura')) {
				const comp = compiledStackItemEffects(item);
				if (comp && !comp.modal && comp.targets.length > 0) {
					const itemKicker = getObjectKickerInfo(state, item.card, item.sourceInstanceId, item);
					const activeCompSpecs = comp.targets.filter(
						(sp) => !sp.condition || isConditionMetWithKicker(sp.condition, itemKicker)
					);
					if (activeCompSpecs.length === item.targetsBySpec.length) {
						bucketSpecs = activeCompSpecs;
					}
				}
			}
			item.targetsBySpec = item.targetsBySpec.map((bucket, idx) => {
				const bSpec = bucketSpecs?.[idx];
				return bucket.filter((t) => {
					if (!isTargetValid(t)) return false;
					if (!bSpec) return true;
					if (item.kind === 'triggered') {
						return triggerTargetCandidates(state, item, bSpec).some(
							(c) => c.kind === t.kind && c.id === t.id
						);
					}
					return validateTargetLegality(
						state,
						item.controllerId,
						t,
						targetRequirementFromSpecs([bSpec]),
						item.card,
						item.sourceInstanceId
					).ok;
				});
			});
			validTargets = item.targetsBySpec.flat();
		} else {
			validTargets = item.targets.filter(isTargetValid);
		}
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
			givePriorityToActiveOrNextPlayer(state);
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
		if (item.kind === 'triggered' && state.triggersPlacedThisTurn) {
			state.triggersPlacedThisTurn.resolutionSerial = (state.triggersPlacedThisTurn.resolutionSerial ?? 0) + 1;
		}
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
		if (!resolveWardTrigger(state, item, controller, ward)) return;
		triggerPathCounts.interpreter++;
		removeItemFromStack();
		givePriorityToActiveOrNextPlayer(state);
		state.passedPriorityPlayerIds = [];
		checkStateBasedActions(state);
		return;
	}
	if (item.delayedEffect) {
		if (item.delayedEffect.kind === 'compiledDelayed') {
			const eff = item.delayedEffect;
			const compiled = resolveCompiledDelayedSteps(eff);
			if (compiled && staticallyInterpretable(compiled, true)) {
				const initialBindings = rehydrateDelayedBindings(state, eff.boundRefs);
				const delayedTargets = filterDelayedTargets(state, eff);
				const result = executeEffectSteps(
					state,
					{
						controller,
						sourceId: item.sourceInstanceId,
						sourceCard: eff.sourceCard,
						title: item.title,
						item,
						targets: delayedTargets,
						targetSpecs: compiled.targets,
						xValue: eff.xValue ?? item.xValue,
						...(eff.eventObjectId ? { eventObjectId: eff.eventObjectId } : {}),
						...(eff.eventObjectVersion !== undefined ? { eventObjectVersion: eff.eventObjectVersion } : {}),
						...(eff.eventPlayerId ? { eventPlayerId: eff.eventPlayerId } : {}),
						...(eff.defendingPlayerId ? { defendingPlayerId: eff.defendingPlayerId } : {}),
						...(eff.eventLki ? { eventLki: eff.eventLki } : {}),
						...(eff.stepPath.length > 0 ? { stepPathPrefix: eff.stepPath } : {}),
						initialBindings
					},
					compiled.steps,
					item.effectResume
				);
				if (result.paused) return;
				delete item.effectResume;
				if (result.turnEnded) return;
			}
			syncBattlefieldControllers(state);
			triggerPathCounts.interpreter++;
			removeItemFromStack();
			givePriorityToActiveOrNextPlayer(state);
			state.passedPriorityPlayerIds = [];
			checkStateBasedActions(state);
			return;
		}
		resolveDelayedTriggerEffect(state, item, controller, item.delayedEffect);
		triggerPathCounts.interpreter++;
		removeItemFromStack();
		givePriorityToActiveOrNextPlayer(state);
		state.passedPriorityPlayerIds = [];
		checkStateBasedActions(state);
		return;
	}
	if (item.inherentTrigger) {
		const inh = item.inherentTrigger;
		if (inh.kind === 'monarchEndStepDraw') {
			const drawPlayer = state.players.find((p) => p.playerId === inh.drawPlayerId && !p.lost);
			if (drawPlayer) {
				drawCards(state, drawPlayer, 1, true);
				addLog(
					state,
					'rule',
					`${drawPlayer.username} drew a card from The Monarch (CR 726.2).`,
					drawPlayer.playerId
				);
			}
		} else if (inh.kind === 'monarchCombatDamage') {
			setMonarch(state, inh.newMonarchPlayerId);
		}
		triggerPathCounts.interpreter++;
		removeItemFromStack();
		givePriorityToActiveOrNextPlayer(state);
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
	const targetsBecomeEach = Boolean(item.spellMods?.targetsBecomeEach);
	const interpreted =
		!item.manualResolution &&
		compiled !== null &&
		staticallyInterpretable(compiled, item.kind === 'triggered') &&
		(item.effectResume !== undefined ||
			interpretableNow(state, item, compiled, controller, targetsBecomeEach));
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
	let librarySelf: { position: 'top' | 'bottom'; fromTop?: number } | undefined;
	const steps: EffectStep[] = compiled?.steps ?? [];
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
				targetsBecomeEach,
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
		librarySelf = result.librarySelf;
	}

	if (item.kind === 'triggered') triggerPathCounts[interpreted ? 'interpreter' : 'manual']++;

	// CR 707.5: Before a Clone-style permanent spell leaves the stack to enter the battlefield,
	// a human controller chooses which creature on the battlefield (if any) it enters as a copy of.
	if (
		item.kind === 'spell' &&
		!controller.isBot &&
		item.cloneCopyChoice === undefined &&
		item.targets[0]?.kind !== 'permanent'
	) {
		// --- Track P8: Generalized Clone (CR 707.5, 707.9) ---
		const cloneSpec = findSelfCloneReplacementSpec(item.card, stackItemFaceOptions(item));
		if (cloneSpec) {
			const cloneCandidates = findLegalCloneCandidates(
				state,
				controller.playerId,
				undefined,
				cloneSpec.copyOf
			);
			if (cloneCandidates.length > 0) {
				const reasonText = cloneSpec.copyOptional
					? `You may have ${item.card.name} enter the battlefield as a copy of a matching permanent (CR 707.5).`
					: `Choose a matching permanent for ${item.card.name} to enter the battlefield as a copy of (CR 707.5).`;
				enqueueChoicePrompt(state, {
					id: uid('prm', state),
					playerId: controller.playerId,
					kind: 'chooseObjects',
					purpose: 'generic',
					title: `${item.card.name} — Choose a Permanent to Copy`,
					description: reasonText,
					continuation: {
						kind: 'procedure',
						procedure: {
							kind: 'clone_copy_choice',
							stackItemId: item.id
						}
					},
					choice: {
						kind: 'chooseObjects',
						min: cloneSpec.copyOptional ? 0 : 1,
						max: 1,
						candidates: cloneCandidates.map((c) => c.instanceId),
						defaultObjectIds: [cloneCandidates[0].instanceId],
						zone: 'battlefield',
						reason: reasonText
					}
				});
				return;
			}
		}
	}

	// CR 608.2n: As the final part of resolution, the resolving spell or ability leaves the stack.
	removeItemFromStack();

	// If this was a spell, move it to Battlefield (for permanents; copies become tokens per CR 111.13 / 608.3f / 707.10f)
	// or Graveyard/Exile (for nontoken Instants/Sorceries).
	if (item.kind === 'spell') {
		const stackFaceOpts = stackItemFaceOptions(item);
		const stackView = resolveObjectFaces(item.card, stackFaceOpts);
		const stackTypes = stackView.types;
		const stackSubtypes = stackView.subtypes;
		const isPermanent = stackTypes.some(
			(t) =>
				t === 'Creature' ||
				t === 'Artifact' ||
				t === 'Enchantment' ||
				t === 'Planeswalker' ||
				t === 'Battle'
		);

		const cardOwnerId = item.isCopy ? controller.playerId : item.ownerId || controller.playerId;
		const cardOwner = state.players.find((p) => p.playerId === cardOwnerId) || controller;
		const wasCommander = !item.isCopy && cardOwner.commanderNames[item.sourceInstanceId] !== undefined;
		const castCount = item.isCopy
			? 0
			: (cardOwner.commanderCastCounts?.[item.sourceInstanceId] ??
				item.commanderCastCount ??
				0);

		if (isPermanent) {
			const auraTargetId =
				stackSubtypes.includes('Aura') &&
				(item.targets[0]?.kind === 'permanent' || item.targets[0]?.kind === 'player')
					? item.targets[0].id
					: null;
			const perm = createCardInstance(
				item.card,
				cardOwnerId,
				'battlefield',
				wasCommander,
				Boolean(item.isCopy),
				auraTargetId ? 0 : allocateTimestamp(state),
				item.isCopy ? state : undefined
			);
			const idTaken =
				Boolean(item.isCopy) &&
				(state.stack.some((s) => s.id !== item.id && s.sourceInstanceId === item.sourceInstanceId) ||
					Boolean(findCardAnywhere(state, item.sourceInstanceId)));
			if (!idTaken && item.sourceInstanceId) {
				perm.instanceId = item.sourceInstanceId;
			}
			perm.controllerId = controller.playerId;
			perm.defaultControllerId = controller.playerId;
			perm.commanderCastCount = castCount;
			perm.summoningSick = true;
			perm.enteredWithX = item.xValue;
			perm.manaColorsSpent = item.manaColorsSpent ? [...item.manaColorsSpent] : undefined;
			const isPrototypedSpell = Boolean(
				item.spellMods?.prototyped || item.copiableState?.prototyped
			);
			const effectiveModsForKicker = isPrototypedSpell
				? { ...item.spellMods, prototyped: true }
				: item.spellMods;
			const resolvedKicker = computeKickerTracking(
				item.card,
				item.optionalCostCounts,
				{ spellMods: effectiveModsForKicker },
				item.faceIndex ?? 0,
				item.fused ?? false
			);
			perm.kickedCount = resolvedKicker.count > 0 ? resolvedKicker.count : undefined;
			perm.kickedTags = resolvedKicker.tags.length > 0 ? resolvedKicker.tags : undefined;
			perm.kickedTagCounts =
				resolvedKicker.tagCounts && Object.keys(resolvedKicker.tagCounts).length > 0
					? resolvedKicker.tagCounts
					: undefined;
			perm.evoked = item.spellMods?.evoked ? true : undefined;
			perm.escaped = item.spellMods?.escaped ? true : undefined;
			perm.foretold = item.spellMods?.foretold ? true : undefined;
			perm.blitzed = item.spellMods?.blitzed ? true : undefined;
			perm.prototyped = isPrototypedSpell ? true : undefined;
			// Reset pre-filled loyalty so moveObject initializes loyalty with counterMultiplier (CR 306.5b)
			perm.counters.loyalty = 0;

			if (item.isFaceDown) {
				perm.isFaceDown = true;
				if (item.faceDownSpec) {
					perm.faceDownSpec = { ...item.faceDownSpec };
				}
				perm.faceDownLabel = item.faceDownLabel ?? allocateFaceDownLabel(state);
			} else if (item.faceIndex !== undefined) {
				perm.activeFaceIndex = item.faceIndex;
				// CR 702.146b / CR 712.8c: A transforming DFC cast transformed (e.g. via Disturb) enters transformed.
				if (
					item.faceIndex === 1 &&
					(item.spellMods?.castTransformed ||
						item.card.layout === 'transform' ||
						Boolean(item.card.backFace))
				) {
					perm.transformed = true;
				}
			}
			if (item.copiableState) {
				perm.copiableState = JSON.parse(JSON.stringify(item.copiableState)) as CopiableState;
				perm.copiableCard = item.copiableState.card;
			}
			// CR 709.5d: A Room permanent cast as a spell enters with the chosen half's door unlocked.
			if (stackSubtypes.includes('Room')) {
				perm.unlockedFaces = [item.faceIndex ?? 0];
			}

			// --- Track P8: Generalized Clone (CR 707.2, 707.5, 707.9) ---
			const cloneSpec = findSelfCloneReplacementSpec(item.card, stackFaceOpts);
			if (cloneSpec) {
				const cloneCandidates = findLegalCloneCandidates(
					state,
					controller.playerId,
					perm,
					cloneSpec.copyOf
				);
				let targetPerm: CardInstance | undefined;
				if (item.cloneCopyChoice !== undefined) {
					targetPerm = item.cloneCopyChoice
						? cloneCandidates.find((c) => c.instanceId === item.cloneCopyChoice)
						: undefined;
					if (!targetPerm && !cloneSpec.copyOptional) {
						targetPerm = cloneCandidates[0];
					}
				} else if (item.targets[0]?.kind === 'permanent') {
					targetPerm = findPermanentOnBoard(state, item.targets[0].id)?.inst;
				} else {
					targetPerm = cloneCandidates[0];
				}
				if (targetPerm) {
					const displayName = applyCopiedPermanentToInstance(
						perm,
						targetPerm,
						cloneSpec.copyModifications,
						item.card
					);
					if (cloneSpec.tapped) {
						perm.tapped = true;
					}
					addLog(
						state,
						'cast',
						`${item.card.name} entered the battlefield as a copy of ${displayName} (CR 707.2).`,
						controller.playerId
					);
				}
			}

			if (auraTargetId) {
				attachObject(state, perm, auraTargetId);
			}
			const enteredName = perm.isFaceDown
				? perm.faceDownLabel || 'Face-Down Permanent'
				: resolveObjectFaces(
						effectiveCardForObject(perm),
						instanceFaceOptions(perm, 'battlefield')
					).name;
			applySelfEtbReplacements(state, perm);
			const moveRes = moveObject(state, perm, 'battlefield', {
				from: 'stack',
				toPlayer: controller
			});
			syncBattlefieldControllers(state);
			if (item.spellMods?.blitzed && (perm.zone === 'battlefield' || moveRes === 'pending')) {
				(state.delayedTriggers ??= []).push(
					buildBlitzSacrificeDelayedTrigger(uid('dtrig', state), controller.playerId, perm, item.card)
				);
			}
			if (item.spellMods?.warped && perm.zone === 'battlefield') {
				(state.delayedTriggers ??= []).push(
					buildWarpExileDelayedTrigger(uid('dtrig', state), controller.playerId, perm)
				);
			}
			if (perm.zone === 'battlefield') {
				addLog(
					state,
					'cast',
					`${enteredName} entered the battlefield under ${controller.username}'s control.`,
					controller.playerId
				);
				if (stackSubtypes.includes('Aura') && perm.attachedToId) {
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
			}
			flushTriggers(state);
		} else if (!item.isCopy) {
			// CR 702.27a: If the buyback cost was paid, put the resolving spell into its owner's hand
			// instead of into that player's graveyard (moveStackSpellToZone still overrides with
			// exileOnLeaveStack per CR 702.34a when cast via Flashback).
			if (exiledBySelfReference || item.spellMods?.exileAdventureOnResolve) {
				moveStackSpellToZone(state, item, 'exile');
			} else if (librarySelf) {
				moveStackSpellToZone(state, item, 'library', librarySelf);
			} else {
				const dest = item.spellMods?.returnToHandOnResolve ? 'hand' : 'graveyard';
				moveStackSpellToZone(state, item, dest);
			}
		}
	}

	givePriorityToActiveOrNextPlayer(state);
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
		enqueueChoicePrompt(state, {
			id: uid('prm', state),
			playerId: activePlayer.playerId,
			kind: 'yesNo',
			purpose: 'end_turn',
			title: `End the Turn? (${sourceName})`,
			description,
			yesLabel: 'End the Turn Now',
			noLabel: 'Decline (Keep Playing Turn)',
			continuation: {
				kind: 'procedure',
				procedure: {
					kind: 'end_turn',
					actorId: activePlayer.playerId,
					sourceName
				}
			},
			choice: {
				kind: 'yesNo',
				question: description
			}
		});
	}
}

/** Builds Layer 1a copiable card and CopiableState from a target permanent (CR 707.2, 707.8a, 708.2, 712.6d, 719.3d). */
function buildCopiedPermanentFields(
	target: CardInstance,
	notLegendary = false,
	exceptPT?: { power: number; toughness: number },
	isTokenCopy = false
): {
	baseCardToCopy: ScryfallCard;
	copiableState: CopiableState;
	displayName: string;
} {
	if (target.isFaceDown) {
		const strippedSpec = target.faceDownSpec ? { ...target.faceDownSpec } : undefined;
		if (strippedSpec) {
			delete strippedSpec.turnUpCost;
			delete strippedSpec.knownToPlayerIds;
			if (notLegendary && strippedSpec.supertypes) {
				strippedSpec.supertypes = strippedSpec.supertypes.filter(
					(s) => s.toLowerCase() !== 'legendary'
				);
			}
			if (exceptPT) {
				strippedSpec.power = exceptPT.power;
				strippedSpec.toughness = exceptPT.toughness;
			}
		}
		const label = target.faceDownLabel || 'Face-Down Creature';
		const baseCardToCopy = scrubFaceDownCard(label, 'battlefield', strippedSpec);
		return {
			baseCardToCopy,
			copiableState: {
				card: baseCardToCopy,
				...(exceptPT
					? { except: { power: exceptPT.power, toughness: exceptPT.toughness } }
					: {})
			},
			displayName: label
		};
	}

	const sourceCard = effectiveCardForObject(target);
	const baseCardToCopy = JSON.parse(JSON.stringify(sourceCard)) as ScryfallCard;
	if (notLegendary) {
		baseCardToCopy.typeLine = baseCardToCopy.typeLine.replace(/\bLegendary\s+/g, '');
		for (const f of baseCardToCopy.faces ?? []) {
			if (f.typeLine) f.typeLine = f.typeLine.replace(/\bLegendary\s+/g, '');
		}
	}
	const faceIdx = activeFaceIndexForObject(target);
	// CR 707.8a: A token created as a copy of a transforming permanent is a transforming token
	// with both faces (unless the copied permanent was itself a single-face copy).
	const isTransformingTokenCopy =
		isTokenCopy &&
		baseCardToCopy.layout === 'transform' &&
		!target.copiableState?.isSingleFaceCopy &&
		(baseCardToCopy.faces?.length ?? 0) > 1;
	const isSingleFaceCopy = isTransformingTokenCopy
		? false
		: faceIdx > 0 ||
			Boolean(target.transformed) ||
			Boolean(target.copiableState?.isSingleFaceCopy) ||
			((baseCardToCopy.layout === 'transform' || baseCardToCopy.layout === 'modal_dfc') &&
				(baseCardToCopy.faces?.length ?? 0) > 1);
	const isPrototyped = Boolean(target.prototyped || target.copiableState?.prototyped);
	const hasExcept = Boolean(target.copiableState?.except || notLegendary || exceptPT);
	const copiableState: CopiableState = {
		card: baseCardToCopy,
		...(!isTransformingTokenCopy && (faceIdx > 0 || isSingleFaceCopy)
			? { faceIndex: faceIdx, isSingleFaceCopy: true }
			: {}),
		...(isPrototyped ? { prototyped: true } : {}),
		...(hasExcept
			? {
					except: {
						...target.copiableState?.except,
						...(notLegendary ? { removeSupertypes: ['Legendary'] } : {}),
						...(exceptPT ? { power: exceptPT.power, toughness: exceptPT.toughness } : {})
					}
				}
			: {})
	};
	const view = resolveObjectFaces(baseCardToCopy, {
		zone: 'battlefield',
		faceIndex: faceIdx,
		isSingleFaceCopy,
		prototyped: isPrototyped
	});
	return {
		baseCardToCopy,
		copiableState,
		displayName: view.name || baseCardToCopy.name
	};
}

/** "Create a token that's a copy of ..." (CR 707.2, CR 707.8a: copiable values + transforming DFC token support). */
function copyPermanentAsToken(
	state: GameState,
	controller: PlayerGameState,
	original: CardInstance,
	sourceName: string,
	notLegendary = false,
	exceptPT?: { power: number; toughness: number }
): CardInstance {
	const { baseCardToCopy, copiableState, displayName } = buildCopiedPermanentFields(
		original,
		notLegendary,
		exceptPT,
		true
	);
	const tokenInst = createCardInstance(
		baseCardToCopy,
		controller.playerId,
		'battlefield',
		false,
		true,
		allocateTimestamp(state),
		state
	);
	tokenInst.copiableState = copiableState;
	tokenInst.copiableCard = baseCardToCopy;
	const origFaceIdx = activeFaceIndexForObject(original);
	if (
		!copiableState.isSingleFaceCopy &&
		baseCardToCopy.layout === 'transform' &&
		(original.transformed || origFaceIdx > 0)
	) {
		tokenInst.transformed = true;
		tokenInst.activeFaceIndex = origFaceIdx > 0 ? origFaceIdx : 1;
	}
	if (copiableState.prototyped) {
		tokenInst.prototyped = true;
	}
	tokenInst.summoningSick = true;
	moveObject(state, tokenInst, 'battlefield', { from: 'none', toPlayer: controller });
	addLog(
		state,
		'trigger',
		`${sourceName} created a token copy of ${displayName}!`,
		controller.playerId
	);
	flushTriggers(state);
	return tokenInst;
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

/** CR 506.4 / 701.19a: Removes a permanent from combat (as attacker and/or blocker). */
function removePermanentFromCombat(state: GameState, instanceId: string): void {
	if (!state.combat.active) return;
	state.combat.attackers = state.combat.attackers.filter((a) => a.attackerInstanceId !== instanceId);
	for (const atk of state.combat.attackers) {
		atk.blockerInstanceIds = atk.blockerInstanceIds.filter((id) => id !== instanceId);
	}
	if (state.combat.dealtFirstStrikeDamageIds) {
		state.combat.dealtFirstStrikeDamageIds = state.combat.dealtFirstStrikeDamageIds.filter(
			(id) => id !== instanceId
		);
	}
	noteLayerInputsChanged(state);
}

/**
 * CR 701.19a / CR 614.8: If `perm` has a regeneration shield and can be regenerated this turn,
 * consumes 1 shield, removes all damage marked on it, taps it, and removes it from combat.
 */
function tryRegenerateInsteadOfDestroy(
	state: GameState,
	perm: CardInstance,
	canBeRegenerated = true
): boolean {
	if (!canBeRegenerated || perm.cantBeRegeneratedThisTurn) return false;
	const shields = perm.regenerationShields ?? 0;
	if (shields <= 0) return false;
	perm.regenerationShields = shields - 1 > 0 ? shields - 1 : undefined;
	perm.damageMarked = 0;
	perm.deathtouchDamageMarked = false;
	tapPermanent(state, perm);
	removePermanentFromCombat(state, perm.instanceId);
	addLog(state, 'rule', `${perm.card.name} regenerated instead of being destroyed.`);
	return true;
}

/** Destroy (CR 701.7) by a spell or ability: indestructible, regeneration, then dies triggers. */
function destroyPermanentByEffect(
	state: GameState,
	inst: CardInstance,
	title: string,
	actorId: string,
	canBeRegenerated = true
): MoveResult | 'skipped' {
	if (hasKeyword(inst, 'Indestructible', state)) {
		addLog(state, 'rule', `${inst.card.name} is Indestructible and was not destroyed.`);
		return 'skipped';
	}
	const found = findPermanentOnBoard(state, inst.instanceId);
	if (!found) return 'skipped';
	if (tryRegenerateInsteadOfDestroy(state, inst, canBeRegenerated)) {
		return 'skipped';
	}
	emitVfx(state, { kind: 'destroy', targetId: inst.instanceId, label: inst.card.name });
	const dest = movePermanentToZone(state, inst, 'graveyard');
	addLog(state, 'cast', `${title} destroyed ${inst.card.name}.`, actorId);
	if (dest !== 'pending') {
		flushTriggers(state);
	}
	return dest;
}

/** Scry N, surveil N, or "look at the top N cards, then put them back in any order": bot decision or prompt. */
function initiateLibraryScryOrSurveil(
	state: GameState,
	controller: PlayerGameState,
	item: StackItem,
	amount: number,
	mode: 'scry' | 'rearrange' | 'surveil',
	mayShuffle: boolean
): void {
	if (amount <= 0) return;
	const count = Math.min(amount, controller.library.length);
	if (count <= 0) {
		if (mode === 'surveil') {
			addLog(
				state,
				'rule',
				`${controller.username} surveilled ${amount} (library is empty).`,
				controller.playerId
			);
			emitEvent(state, {
				kind: 'Surveilled',
				playerId: controller.playerId,
				count: amount,
				graveyardCount: 0
			});
			flushTriggers(state);
		}
		return;
	}
	if (mode === 'scry' || mode === 'surveil') {
		const isSurveil = mode === 'surveil';
		if (controller.isBot) {
			const topCards = controller.library.slice(0, count);
			const { topIds, bottomIds } = pickScryOrSurveilSplit(controller, topCards);
			const byId = new Map(topCards.map((c) => [c.instanceId, c]));
			const keepTop = topIds.map((id) => byId.get(id)!).filter(Boolean);
			const moveOther = bottomIds.map((id) => byId.get(id)!).filter(Boolean);
			if (isSurveil) {
				rearrangeLibrary(controller, keepTop, keepTop, []);
				state.pendingProcedure = {
					kind: 'surveil_graveyard',
					actorId: controller.playerId,
					remainingIds: moveOther.map((c) => c.instanceId),
					nextIndex: 0,
					surveilCount: count,
					topCount: keepTop.length,
					graveyardCount: moveOther.length
				};
				advanceSurveilGraveyardProcedure(state);
			} else {
				rearrangeLibrary(controller, topCards, keepTop, moveOther);
				addLog(
					state,
					'rule',
					`${controller.username} scried ${count} (${keepTop.length} on top, ${moveOther.length} on bottom).`,
					controller.playerId
				);
			}
		} else {
			const topCards = controller.library.slice(0, count);
			const topIds = topCards.map((c) => c.instanceId);
			const description = isSurveil
				? `Look at the top ${count} card(s) of your library. Put any number into your graveyard and the rest back on top in any order.`
				: `Look at the top ${count} card(s) of your library. Put any number on the bottom in any order and the rest on top in any order.`;
			state.pendingPrompts.push({
				id: uid('prm', state),
				playerId: controller.playerId,
				kind: 'scry_choice',
				purpose: 'scry_choice',
				title: isSurveil ? `Surveil ${count} (${item.card.name})` : `Scry ${count} (${item.card.name})`,
				description,
				countRequired: count,
				candidateInstanceIds: topIds,
				allowBottom: true,
				...(isSurveil ? { splitMode: 'graveyard' as const } : {}),
				allowShuffle: false,
				choice: {
					kind: 'orderObjects',
					objectIds: topIds,
					allowSplitBottom: true,
					...(isSurveil ? { splitLabel: 'graveyard' as const } : {}),
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

function findSourceCardForOptionalCost(state: GameState, item: StackItem): CardInstance {
	for (const zone of ['battlefield', 'graveyard', 'exile', 'hand', 'command', 'library'] as const) {
		for (const pl of state.players) {
			const inst = pl[zone].find((c) => c.instanceId === item.sourceInstanceId);
			if (inst) return inst;
		}
	}
	const base = createCardInstance(item.card, item.controllerId, 'stack', false, false, 0);
	return { ...base, instanceId: item.sourceInstanceId };
}

function buildOptionalCostContext(
	state: GameState,
	player: PlayerGameState,
	item: StackItem
): CostContext {
	const source = findSourceCardForOptionalCost(state, item);
	return costContext(state, player, source, item.xValue ?? 0, false, null, undefined, {
		isSpell: false
	});
}

function canPayOptionalCost(
	state: GameState,
	player: PlayerGameState,
	item: StackItem,
	defs: CostDef[]
): boolean {
	return canPayCosts(buildOptionalCostContext(state, player, item), defs);
}

function payOptionalCost(
	state: GameState,
	player: PlayerGameState,
	item: StackItem,
	stepIndex: number,
	defs: CostDef[],
	answers: Record<string, ChoiceAnswer>,
	pending?: EffectResumeFrame['pendingOptionalCost']
): PayOptionalCostResult {
	const ctx = buildOptionalCostContext(state, player, item);
	if (pending && pending.stepIndex === stepIndex) {
		if (!pending.tapsAndManaDone) {
			payTapAndManaCostParts(ctx, pending.parts, null, pending.descriptions);
			pending.tapsAndManaDone = true;
		}
		const promptsBefore = state.pendingPrompts.length;
		const paid = executeCostPaymentParts(
			ctx,
			pending.parts,
			pending.nextPartIndex,
			pending.nextObjectIndex,
			pending.descriptions
		);
		if (paid.paused) {
			return {
				status: 'paused',
				pending: {
					...pending,
					nextPartIndex: paid.nextPartIndex ?? pending.nextPartIndex,
					nextObjectIndex: paid.nextObjectIndex ?? pending.nextObjectIndex
				},
				queued: state.pendingPrompts.slice(promptsBefore)
			};
		}
		addLog(
			state,
			'cast',
			`${player.username} paid ${describeCost(defs)} for ${item.card.name}${pending.descriptions.length > 0 ? ` (${pending.descriptions.join('; ')})` : ''}.`,
			player.playerId
		);
		return { status: 'paid' };
	}

	let payment: CostPayment | undefined;
	if (player.isBot) {
		const chosen = chooseCostPayment(ctx, defs);
		if (!chosen) return { status: 'failed' };
		payment = chosen;
	} else {
		const objects: string[][] = [];
		for (let qIdx = 0; qIdx < defs.length + 4; qIdx++) {
			const ans = answers[`__opt_cost_${stepIndex}_obj_${qIdx}`];
			if (ans?.kind === 'chooseObjects') {
				objects[qIdx] = ans.objectIds;
			} else {
				break;
			}
		}
		if (objects.length > 0) payment = { objects };
	}

	const plan = planCosts(ctx, defs, payment);
	if (!plan.ok) return { status: 'failed' };
	if (plan.question) {
		if (plan.question.kind !== 'objects' || player.isBot) return { status: 'failed' };
		return {
			status: 'needChoice',
			answerKey: `__opt_cost_${stepIndex}_obj_${plan.question.index}`,
			zone: inferObjectsZone(player, plan.question.candidateIds),
			label: plan.question.label,
			count: plan.question.count,
			candidateIds: plan.question.candidateIds
		};
	}

	const serializedParts = serializeCostPlanParts(ctx, plan);
	const descriptions: string[] = [];
	payTapAndManaCostParts(ctx, serializedParts, plan.mana, descriptions);
	const promptsBefore = state.pendingPrompts.length;
	const paid = executeCostPaymentParts(ctx, serializedParts, 0, 0, descriptions);
	if (paid.paused) {
		return {
			status: 'paused',
			pending: {
				stepIndex,
				parts: serializedParts,
				nextPartIndex: paid.nextPartIndex ?? 0,
				nextObjectIndex: paid.nextObjectIndex ?? 0,
				descriptions,
				tapsAndManaDone: true
			},
			queued: state.pendingPrompts.slice(promptsBefore)
		};
	}
	addLog(
		state,
		'cast',
		`${player.username} paid ${describeCost(defs)} for ${item.card.name}${descriptions.length > 0 ? ` (${descriptions.join('; ')})` : ''}.`,
		player.playerId
	);
	return { status: 'paid' };
}

function stackItemTargetSpecsAndSteps(
	state: GameState,
	orig: StackItem
): { specs: TargetSpec[]; steps: EffectStep[] } {
	if (orig.kind === 'triggered') {
		if (itemWard(orig) || orig.delayedEffect || orig.inherentTrigger) return { specs: [], steps: [] };
		const eff = triggerItemEffect(orig);
		return { specs: eff?.targets ?? [], steps: eff?.steps ?? [] };
	}
	if (orig.kind === 'activated') {
		const eff = compiledStackItemEffects(orig);
		return { specs: eff?.targets ?? [], steps: eff?.steps ?? [] };
	}
	if (orig.spellMods?.targetsBecomeEach) return { specs: [], steps: [] };
	const eff = compiledStackItemEffects(orig);
	if (eff) {
		const kickerInfo = getObjectKickerInfo(state, orig.card, orig.sourceInstanceId, orig);
		const specs = eff.targets.filter(
			(ts) => !ts.condition || isConditionMetWithKicker(ts.condition, kickerInfo)
		);
		return { specs, steps: eff.steps };
	}
	const req = getSpellTargetRequirement(
		orig.card,
		{
			...(orig.faceIndex !== undefined ? { faceIndex: orig.faceIndex } : {}),
			...(orig.fused !== undefined ? { fused: orig.fused } : {}),
			...(orig.spellMods ? { spellMods: orig.spellMods } : {})
		},
		orig.optionalCostCounts
	);
	return { specs: req.targetSpecs ?? [], steps: [] };
}

function distributeStackItemTargetsBySpec(orig: StackItem, specs: TargetSpec[]): TargetRef[][] {
	if (specs.length === 0) return [];
	if (orig.targetsBySpec && orig.targetsBySpec.length === specs.length) {
		return orig.targetsBySpec.map((b) => b.map((t) => ({ ...t })));
	}
	const counts = specs.map((s) => s.min);
	const minRequired = counts.reduce((sum, n) => sum + n, 0);
	let extra = Math.max(0, orig.targets.length - minRequired);
	for (let i = 0; i < specs.length && extra > 0; i++) {
		const add = Math.min(extra, Math.max(0, specs[i].max - counts[i]));
		if (add > 0) {
			counts[i] += add;
			extra -= add;
		}
	}
	const out: TargetRef[][] = [];
	let cur = 0;
	for (let i = 0; i < specs.length; i++) {
		const take = Math.min(counts[i], Math.max(0, orig.targets.length - cur));
		out.push(orig.targets.slice(cur, cur + take).map((t) => ({ ...t })));
		cur += take;
	}
	return out;
}

function getStackItemRetargetSlots(
	state: GameState,
	orig: StackItem,
	copyControllerId: string
): StackItemRetargetSlot[] {
	const { specs } = stackItemTargetSpecsAndSteps(state, orig);
	if (specs.length === 0) return [];
	const bySpec = distributeStackItemTargetsBySpec(orig, specs);
	const sourceObj = orig.kind === 'spell' ? undefined : triggerSourceObject(state, orig);
	const sourceCard = orig.copiableState?.card ?? orig.card;
	return specs.map((spec, idx) => {
		const cands = specTargetCandidates(state, copyControllerId, sourceCard, sourceObj, spec).filter(
			(c) => !(c.kind === 'stack' && c.id === orig.id)
		);
		const zone: ZoneType | 'player' =
			spec.kind === 'player' ? 'player' : ((spec.filter.zone as ZoneType | undefined) ?? 'battlefield');
		return {
			spec,
			originalTargets: bySpec[idx] ?? [],
			legalCandidates: cands,
			zone
		};
	});
}

function validateStackItemRetarget(
	state: GameState,
	orig: StackItem,
	copyControllerId: string,
	targetsBySpec: TargetRef[][]
): boolean {
	const slots = getStackItemRetargetSlots(state, orig, copyControllerId);
	if (targetsBySpec.length !== slots.length) return false;
	for (let i = 0; i < slots.length; i++) {
		const sl = slots[i];
		const chosen = targetsBySpec[i] ?? [];
		const uniq = new Set(chosen.map((t) => `${t.kind}:${t.id}`));
		if (uniq.size !== chosen.length) return false;
		const unchangedSlot =
			chosen.length === sl.originalTargets.length &&
			chosen.every((x, idx) => x.kind === sl.originalTargets[idx]?.kind && x.id === sl.originalTargets[idx]?.id);
		if (unchangedSlot) continue;
		if (chosen.length < sl.spec.min || chosen.length > sl.spec.max) return false;
		for (const t of chosen) {
			const keptOriginal = sl.originalTargets.some((o) => o.kind === t.kind && o.id === t.id);
			const isLegalNew = sl.legalCandidates.some((c) => c.kind === t.kind && c.id === t.id);
			if (!keptOriginal && !isLegalNew) return false;
		}
	}
	return true;
}

function chooseBotStackItemRetarget(
	state: GameState,
	bot: PlayerGameState,
	orig: StackItem,
	slots: StackItemRetargetSlot[],
	copyIndex: number
): { targets: TargetRef[]; targetsBySpec: TargetRef[][] } {
	const { steps } = stackItemTargetSpecsAndSteps(state, orig);
	const targetsBySpec: TargetRef[][] = slots.map((sl, sIdx) => {
		if (sl.spec.min > 0 && sl.legalCandidates.length < sl.spec.min) {
			return sl.originalTargets.map((t) => ({ ...t }));
		}
		const ranked = chooseBotTriggerTargets(state, bot, steps, sIdx, sl.spec, sl.legalCandidates);
		if (ranked.length < sl.spec.min) {
			return sl.originalTargets.map((t) => ({ ...t }));
		}
		if (copyIndex > 0 && sl.spec.min === 1 && sl.spec.max === 1 && ranked[0]?.kind === 'permanent') {
			const firstFound = findPermanentOnBoard(state, ranked[0].id);
			if (firstFound && firstFound.controller.playerId !== bot.playerId) {
				const oppPerms = sl.legalCandidates.filter((c) => {
					if (c.kind !== 'permanent') return false;
					const f = findPermanentOnBoard(state, c.id);
					return Boolean(f && f.controller.playerId !== bot.playerId);
				});
				if (oppPerms.length > 1) {
					return [{ ...oppPerms[copyIndex % oppPerms.length] }];
				}
			}
		}
		return ranked.map((t) => ({ ...t }));
	});
	if (validateStackItemRetarget(state, orig, bot.playerId, targetsBySpec)) {
		return { targets: targetsBySpec.flat(), targetsBySpec };
	}
	const fallbackBySpec = slots.map((sl) => sl.originalTargets.map((t) => ({ ...t })));
	return { targets: orig.targets.map((t) => ({ ...t })), targetsBySpec: fallbackBySpec };
}

function pushCopiedStackItem(
	state: GameState,
	controller: PlayerGameState,
	orig: StackItem,
	targets: TargetRef[],
	targetsBySpec: TargetRef[][] | undefined,
	opts?: { exceptColors?: ManaColor[]; nonLegendary?: boolean }
): StackItem {
	let copiableState: CopiableState | undefined = orig.copiableState
		? (JSON.parse(JSON.stringify(orig.copiableState)) as CopiableState)
		: undefined;
	const origPrototyped = Boolean(orig.spellMods?.prototyped || orig.copiableState?.prototyped);
	if (opts?.exceptColors !== undefined || opts?.nonLegendary || origPrototyped) {
		const base: CopiableState = copiableState ?? {
			card: orig.card,
			...(orig.faceIndex !== undefined ? { faceIndex: orig.faceIndex } : {}),
			...(orig.fused !== undefined ? { fused: orig.fused } : {}),
			...(origPrototyped ? { prototyped: true } : {})
		};
		if (origPrototyped) {
			base.prototyped = true;
		}
		if (opts?.exceptColors !== undefined || opts?.nonLegendary) {
			base.except = { ...(base.except ?? {}) };
			if (opts.exceptColors !== undefined) {
				base.except.colors = [...opts.exceptColors];
			}
			if (opts.nonLegendary) {
				const cardCopy = JSON.parse(JSON.stringify(base.card)) as ScryfallCard;
				cardCopy.typeLine = cardCopy.typeLine.replace(/\bLegendary\s+/g, '');
				for (const f of cardCopy.faces ?? []) {
					if (f.typeLine) f.typeLine = f.typeLine.replace(/\bLegendary\s+/g, '');
				}
				base.card = cardCopy;
				const rem = new Set(base.except.removeSupertypes ?? []);
				rem.add('Legendary');
				base.except.removeSupertypes = [...rem];
			}
		}
		copiableState = base;
	}

	const copyCard = copiableState?.card ?? orig.card;
	const targetObjectVersions = captureTargetObjectVersions(state, targets);

	if (orig.kind === 'spell') {
		const copyInstanceId = uid('copy', state);
		const copyItem: StackItem = withStackItemText(
			{
				id: uid('stk', state),
				sourceInstanceId: copyInstanceId,
				sourceObjectVersion: 1,
				card: copyCard,
				...(orig.faceIndex !== undefined ? { faceIndex: orig.faceIndex } : {}),
				...(orig.fused ? { fused: true } : {}),
				...(orig.isFaceDown
					? {
							isFaceDown: true,
							...(orig.faceDownSpec ? { faceDownSpec: { ...orig.faceDownSpec } } : {}),
							...(orig.faceDownLabel ? { faceDownLabel: orig.faceDownLabel } : {})
						}
					: {}),
				...(copiableState ? { copiableState } : {}),
				ownerId: controller.playerId,
				controllerId: controller.playerId,
				kind: 'spell',
				title: `${orig.card.name} (Copy)`,
				targets: targets.map((t) => ({ ...t })),
				...(targetsBySpec
					? { targetsBySpec: targetsBySpec.map((b) => b.map((t) => ({ ...t }))) }
					: {}),
				...(targetObjectVersions && Object.keys(targetObjectVersions).length > 0
					? { targetObjectVersions }
					: {}),
				xValue: orig.xValue,
				...(orig.chosenModes ? { chosenModes: [...orig.chosenModes] } : {}),
				...(orig.optionalCostCounts
					? { optionalCostCounts: { ...orig.optionalCostCounts } }
					: {}),
				...(orig.spellMods ? { spellMods: { ...orig.spellMods } } : {}),
				requiresGuidedResolution: orig.requiresGuidedResolution,
				isCopy: true,
				createdAt: Date.now()
			},
			stackItemDisplayText(orig)
		);
		state.stack.push(copyItem);
		const dummyObj: CardInstance = {
			instanceId: copyInstanceId,
			objectVersion: 1,
			card: orig.card,
			...(copiableState ? { copiableState, copiableCard: copiableState.card } : {}),
			...(origPrototyped ? { prototyped: true } : {}),
			ownerId: controller.playerId,
			controllerId: controller.playerId,
			defaultControllerId: controller.playerId,
			zone: 'stack',
			tapped: false,
			summoningSick: false,
			damageMarked: 0,
			deathtouchDamageMarked: false,
			tempPowerMod: 0,
			tempToughnessMod: 0,
			grantedKeywords: [],
			attachedToId: null,
			counters: createEmptyCounters(),
			isCommander: false,
			commanderCastCount: 0,
			usedLoyaltyThisTurn: false,
			transformed: false,
			isToken: false,
			enteredTimestamp: allocateTimestamp(state)
		};
		emitEvent(state, {
			kind: 'SpellCopied',
			playerId: controller.playerId,
			objectId: copyInstanceId,
			object: dummyObj
		});
		for (const t of copyItem.targets) {
			const targeted = t.kind === 'permanent' ? findPermanentOnBoard(state, t.id) : null;
			if (targeted && !targeted.inst.phasedOut) {
				emitEvent(state, {
					kind: 'BecameTarget',
					objectId: t.id,
					object: targeted.inst,
					by: 'spell',
					controllerId: controller.playerId,
					stackItemId: copyItem.id
				});
			}
		}
		flushTriggers(state);
		addLog(
			state,
			'cast',
			`${controller.username} copied ${orig.card.name} on the stack${copyItem.targets.length > 0 ? ` targeting ${copyItem.targets.map((t) => t.label).join(', ')}` : ''} (CR 707.10).`,
			controller.playerId
		);
		return copyItem;
	}

	// CR 707.10b: A copy of an activated or triggered ability has the same source as the original ability.
	const copyItem: StackItem = withStackItemText(
		{
			id: uid('stk', state),
			sourceInstanceId: orig.sourceInstanceId,
			...(orig.sourceObjectVersion !== undefined
				? { sourceObjectVersion: orig.sourceObjectVersion }
				: {}),
			...(orig.sourceLkiPower !== undefined ? { sourceLkiPower: orig.sourceLkiPower } : {}),
			...(orig.sourceLkiToughness !== undefined
				? { sourceLkiToughness: orig.sourceLkiToughness }
				: {}),
			...(orig.sourceKickedCount !== undefined
				? { sourceKickedCount: orig.sourceKickedCount }
				: {}),
			...(orig.sourceKickedTags ? { sourceKickedTags: [...orig.sourceKickedTags] } : {}),
			...(orig.sourceKickedTagCounts
				? { sourceKickedTagCounts: { ...orig.sourceKickedTagCounts } }
				: {}),
			...(orig.sourceEvoked ? { sourceEvoked: true } : {}),
			...(orig.sourceEscaped ? { sourceEscaped: true } : {}),
			...(orig.sourceForetold ? { sourceForetold: true } : {}),
			...(orig.sourceBlitzed ? { sourceBlitzed: true } : {}),
			...(orig.sourceExertedThisTurn ? { sourceExertedThisTurn: true } : {}),
			...(orig.sourceChosenSubType ? { sourceChosenSubType: orig.sourceChosenSubType } : {}),
			...(orig.sourceChosenColor ? { sourceChosenColor: orig.sourceChosenColor } : {}),
			...(orig.sourceMonstrous ? { sourceMonstrous: true } : {}),
			...(orig.sourcePrototyped ? { sourcePrototyped: true } : {}),
			card: orig.card,
			...(orig.faceIndex !== undefined ? { faceIndex: orig.faceIndex } : {}),
			...(orig.isFaceDown
				? {
						isFaceDown: true,
						...(orig.faceDownSpec ? { faceDownSpec: { ...orig.faceDownSpec } } : {}),
						...(orig.faceDownLabel ? { faceDownLabel: orig.faceDownLabel } : {})
					}
				: {}),
			controllerId: controller.playerId,
			kind: orig.kind,
			title: `${orig.title} (Copy)`,
			targets: targets.map((t) => ({ ...t })),
			...(targetsBySpec
				? { targetsBySpec: targetsBySpec.map((b) => b.map((t) => ({ ...t }))) }
				: {}),
			...(targetObjectVersions && Object.keys(targetObjectVersions).length > 0
				? { targetObjectVersions }
				: {}),
			xValue: orig.xValue,
			...(orig.abilityId ? { abilityId: orig.abilityId } : {}),
			...(orig.grantSourceCard ? { grantSourceCard: orig.grantSourceCard } : {}),
			...(orig.crewedByIds ? { crewedByIds: [...orig.crewedByIds] } : {}),
			...(orig.saddledByIds ? { saddledByIds: [...orig.saddledByIds] } : {}),
			...(orig.tappedCostPower !== undefined ? { tappedCostPower: orig.tappedCostPower } : {}),
			...(orig.stationTappedId ? { stationTappedId: orig.stationTappedId } : {}),
			...(orig.stationTappedVersion !== undefined
				? { stationTappedVersion: orig.stationTappedVersion }
				: {}),
			...(orig.triggeredAbilityIndex !== undefined
				? { triggeredAbilityIndex: orig.triggeredAbilityIndex }
				: {}),
			...(orig.grantedKeyword ? { grantedKeyword: orig.grantedKeyword } : {}),
			...(orig.delayedEffect ? { delayedEffect: orig.delayedEffect } : {}),
			...(orig.inherentTrigger ? { inherentTrigger: { ...orig.inherentTrigger } } : {}),
			...(orig.wardCost !== undefined ? { wardCost: orig.wardCost } : {}),
			...(orig.chosenModes ? { chosenModes: [...orig.chosenModes] } : {}),
			...(orig.eventObjectId ? { eventObjectId: orig.eventObjectId } : {}),
			...(orig.eventObjectVersion !== undefined
				? { eventObjectVersion: orig.eventObjectVersion }
				: {}),
			...(orig.eventPlayerId ? { eventPlayerId: orig.eventPlayerId } : {}),
			...(orig.defendingPlayerId ? { defendingPlayerId: orig.defendingPlayerId } : {}),
			...(orig.eventAmount !== undefined ? { eventAmount: orig.eventAmount } : {}),
			...(orig.eventStackItemId ? { eventStackItemId: orig.eventStackItemId } : {}),
			...(orig.eventLki ? { eventLki: { ...orig.eventLki } } : {}),
			...(orig.triggerEventStackItem
				? { triggerEventStackItem: JSON.parse(JSON.stringify(orig.triggerEventStackItem)) as StackItem }
				: {}),
			...(orig.stormCount !== undefined ? { stormCount: orig.stormCount } : {}),
			requiresGuidedResolution: orig.requiresGuidedResolution,
			isCopy: true,
			createdAt: Date.now()
		},
		stackItemDisplayText(orig)
	);
	state.stack.push(copyItem);
	for (const t of copyItem.targets) {
		const targeted = t.kind === 'permanent' ? findPermanentOnBoard(state, t.id) : null;
		if (targeted && !targeted.inst.phasedOut) {
			emitEvent(state, {
				kind: 'BecameTarget',
				objectId: t.id,
				object: targeted.inst,
				by: 'ability',
				controllerId: controller.playerId,
				stackItemId: copyItem.id
			});
		}
	}
	flushTriggers(state);
	addLog(
		state,
		'cast',
		`${controller.username} copied ability ${orig.title} on the stack${copyItem.targets.length > 0 ? ` targeting ${copyItem.targets.map((t) => t.label).join(', ')}` : ''} (CR 707.10b).`,
		controller.playerId
	);
	return copyItem;
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
	tryRegenerateInsteadOfDestroy,
	canPayOptionalCost,
	payOptionalCost,
	moveFromBattlefield: (state, inst, to, libraryOpts) =>
		movePermanentToZone(state, inst, to, undefined, libraryOpts),
	moveStackSpellToLibrary: (state, target, libraryOpts) => {
		const idx = state.stack.indexOf(target);
		if (idx >= 0) {
			const [removed] = state.stack.splice(idx, 1);
			moveStackSpellToZone(state, removed, 'library', libraryOpts);
		}
	},
	counterSpell: counterStackItemByEffect,
	createToken: createTokenOnBoard,
	copyPermanentAsToken,
	triggerOnEtb: (state) => flushTriggers(state),
	triggerOnAttach: (state, _controller, attached, to) => {
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
		initiateLibraryScryOrSurveil(state, player, item, count, mode, mayShuffle),
	search: (state, player, spec, item) =>
		initiateLibrarySearch(state, player, spec, item),
	phaseOut: phaseOutPermanent,
	transformPermanent,
	flipPermanent,
	endTurn: endTheTurnImmediately,
	activePlayerMayEndTurn,
	win: (state, player, reason) => void winTheGame(state, player, reason),
	lose: (state, player, reason) => void loseTheGame(state, player, reason),
	legalAuraAttachCandidates,
	getStackItemRetargetSlots,
	validateStackItemRetarget,
	chooseBotStackItemRetarget,
	pushCopiedStackItem,
	setMonarch,
	allocateFaceDownLabel
});

/**
 * CR 702.26: Phasing Out a permanent also indirectly phases out any Auras/Equipment attached to it.
 * Phased-out permanents do not change zones (no LTB/ETB triggers fire!).
 */
export function phaseOutPermanent(state: GameState, perm: CardInstance): void {
	if (perm.phasedOut) return;
	const phasedIds = new Set<string>([perm.instanceId]);
	perm.phasedOut = true;
	perm.phasedOutIndirectly = false;
	// Indirectly phase out any Auras/Equipment/Fortifications attached to this permanent (CR 702.26g)
	let added = true;
	while (added) {
		added = false;
		for (const p of state.players) {
			for (const other of p.battlefield) {
				if (
					!other.phasedOut &&
					other.attachedToId &&
					phasedIds.has(other.attachedToId) &&
					!phasedIds.has(other.instanceId)
				) {
					other.phasedOut = true;
					other.phasedOutIndirectly = true;
					phasedIds.add(other.instanceId);
					added = true;
				}
			}
		}
	}
	noteLayerInputsChanged(state);
	// Remove from combat if attacking, blocking, or being attacked as a planeswalker (CR 506.4, 506.4c)
	state.combat.attackers = state.combat.attackers.filter(
		(a) => !phasedIds.has(a.attackerInstanceId)
	);
	for (const atk of state.combat.attackers) {
		atk.blockerInstanceIds = atk.blockerInstanceIds.filter((id) => !phasedIds.has(id));
		if (atk.defenderPlaneswalkerId && phasedIds.has(atk.defenderPlaneswalkerId)) {
			atk.defenderPlaneswalkerId = 'removed';
		}
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
	noteLayerInputsChanged(state);

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

	givePriorityToActiveOrNextPlayer(state);
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
	if (!globalCheck.ok) {
		return { ok: false, error: globalCheck.error };
	}
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
 * Enumerates intrinsic hand special actions (CR 116.2h Foretell, CR 116.2k Plot) on `inst`.
 */
export function getHandSpecialActions(
	_state: GameState,
	actorId: string,
	inst: CardInstance
): HandSpecialActionOption[] {
	if (inst.zone !== 'hand' || inst.ownerId !== actorId) return [];
	return enumerateHandSpecialActions(effectiveCardForObject(inst));
}

/**
 * Checks whether `actorId` may take the hand special action `actionId` on `inst` (CR 116.2h, CR 116.2k).
 */
export function checkHandSpecialActionLegality(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	actionId: string,
	costPayment?: CostPayment
): { ok: boolean; error?: string } {
	return withStableLayerInputs(state, () => {
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
		if (inst.zone !== 'hand' || !actor.hand.some((c) => c.instanceId === inst.instanceId)) {
			return { ok: false, error: 'Card must be in your hand.' };
		}
		const actionOpt = enumerateHandSpecialActions(effectiveCardForObject(inst)).find(
			(o) => o.id === actionId
		);
		if (!actionOpt) {
			return { ok: false, error: 'Special action is not available on this card.' };
		}
		const pendingCombatErr = getPendingCombatDeclarationError(state);
		if (pendingCombatErr) {
			return { ok: false, error: pendingCombatErr };
		}
		const priorityPlayer = state.players[state.priorityPlayerIndex];
		if (priorityPlayer?.playerId !== actorId) {
			return { ok: false, error: 'You do not currently hold priority.' };
		}
		const activePlayer = state.players[state.activePlayerIndex];
		if (activePlayer?.playerId !== actorId) {
			return { ok: false, error: `${actionOpt.label} can only be used during your turn.` };
		}
		if (actionOpt.sorcerySpeedOnly) {
			if (state.phase !== 'main1' && state.phase !== 'main2') {
				return {
					ok: false,
					error: `${actionOpt.label} can only be used during your Main Phase.`
				};
			}
			if (state.stack.length > 0) {
				return {
					ok: false,
					error: `${actionOpt.label} cannot be used while the Stack is not empty.`
				};
			}
		}
		const topManaStr = actionOpt.costDefs
			.filter((d): d is Extract<CostDef, { k: 'mana' }> => d.k === 'mana')
			.map((d) => d.cost)
			.join('');
		const nonManaDefs = actionOpt.costDefs.filter((d) => d.k !== 'mana');
		const req = topManaStr ? parseManaCost(topManaStr) : null;
		if (nonManaDefs.length > 0) {
			const reservedSelf = new Set<string>([inst.instanceId]);
			if (
				!canPayCosts(
					costContext(
						state,
						actor,
						inst,
						0,
						false,
						req,
						costPayment?.phyrexianLifeCount,
						undefined,
						reservedSelf
					),
					nonManaDefs
				)
			) {
				return {
					ok: false,
					error: `You can't pay the cost for ${actionOpt.label} (${actionOpt.costDisplay}).`
				};
			}
		} else if (req && !canPayOrAutoTap(actor, req, state, costPayment?.phyrexianLifeCount)) {
			return {
				ok: false,
				error: `Insufficient mana for ${actionOpt.label} (requires ${actionOpt.costDisplay}).`
			};
		}
		return { ok: true };
	});
}

export function chooseBotHandSpecialActionCostPayment(
	state: GameState,
	player: PlayerGameState,
	inst: CardInstance,
	actionId: string
): CostPayment | undefined {
	const actionOpt = enumerateHandSpecialActions(effectiveCardForObject(inst)).find(
		(o) => o.id === actionId
	);
	if (!actionOpt) return undefined;
	const topManaStr = actionOpt.costDefs
		.filter((d): d is Extract<CostDef, { k: 'mana' }> => d.k === 'mana')
		.map((d) => d.cost)
		.join('');
	const nonManaDefs = actionOpt.costDefs.filter((d) => d.k !== 'mana');
	if (nonManaDefs.length === 0) return undefined;
	const req = topManaStr ? parseManaCost(topManaStr) : null;
	const reservedSelf = new Set<string>([inst.instanceId]);
	return (
		chooseCostPayment(
			costContext(state, player, inst, 0, false, req, undefined, undefined, reservedSelf),
			nonManaDefs
		) ?? undefined
	);
}

function completeHandSpecialAction(
	state: GameState,
	actor: PlayerGameState,
	inst: CardInstance,
	actionId: string,
	descriptions: string[]
): void {
	const actorId = actor.playerId;
	const costSuffix = descriptions.length > 0 ? ` (${descriptions.join('; ')})` : '';
	if (actionId === 'special:foretell') {
		const faceDownLabel = allocateFaceDownLabel(state);
		inst.isFaceDown = true;
		inst.faceDownLabel = faceDownLabel;
		inst.faceDownSpec = { kind: 'other', knownToPlayerIds: [actorId] };
		moveObject(state, inst, 'exile', {
			from: { player: actor, zone: 'hand' },
			toPlayer: actor,
			newTimestamp: true,
			bumpVersion: true,
			beforeInsert: (moved, dest) => {
				if (dest === 'exile') {
					moved.knownToPlayerIds = [actorId];
					moved.foretoldByPlayerId = actorId;
					moved.foretoldTurnNumber = state.turnNumber;
				} else {
					moved.isFaceDown = false;
					moved.faceDownLabel = undefined;
					moved.faceDownSpec = undefined;
				}
			}
		});
		state.passedPriorityPlayerIds = [];
		state.priorityUpdatedAt = Date.now();
		addLog(
			state,
			'rule',
			`${actor.username} exiled a card from hand face down${costSuffix} (CR 116.2h).`,
			actorId
		);
		emitVfx(state, {
			kind: 'exile',
			sourceId: actorId,
			targetId: inst.instanceId,
			label: faceDownLabel
		});
		if (inst.zone === 'exile') {
			emitEvent(state, {
				kind: 'Foretold',
				playerId: actorId,
				objectId: inst.instanceId,
				card: inst
			});
		}
		resetTriggerLoopTracking(state);
		flushTriggers(state);
		checkStateBasedActions(state);
		return;
	}

	if (actionId === 'special:plot') {
		moveObject(state, inst, 'exile', {
			from: { player: actor, zone: 'hand' },
			toPlayer: actor,
			newTimestamp: true,
			bumpVersion: true,
			beforeInsert: (moved, dest) => {
				if (dest === 'exile') {
					moved.plottedByPlayerId = actorId;
					moved.plottedTurnNumber = state.turnNumber;
				}
			}
		});
		state.passedPriorityPlayerIds = [];
		state.priorityUpdatedAt = Date.now();
		addLog(
			state,
			'rule',
			`${actor.username} plotted ${inst.card.name}${costSuffix} (CR 116.2k).`,
			actorId
		);
		emitVfx(state, {
			kind: 'exile',
			sourceId: actorId,
			targetId: inst.instanceId,
			label: `${inst.card.name} (Plotted)`
		});
		if (inst.zone === 'exile') {
			emitEvent(state, {
				kind: 'Plotted',
				playerId: actorId,
				objectId: inst.instanceId,
				card: inst
			});
		}
		resetTriggerLoopTracking(state);
		flushTriggers(state);
		checkStateBasedActions(state);
	}
}

function finalizeHandSpecialAction(
	state: GameState,
	actor: PlayerGameState,
	pcp: PendingCostPayment
): void {
	const inst = actor.hand.find((c) => c.instanceId === pcp.sourceInstanceId);
	if (!inst || !pcp.specialActionId) return;
	completeHandSpecialAction(state, actor, inst, pcp.specialActionId, pcp.descriptions);
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
		matchesLibrarySearchSpec(
			c.card,
			searchSpec,
			resolveObjectFaces(c.card, instanceFaceOptions(c)).colors
		)
	);
	const canFailToFind =
		searchSpec.statedQuality || searchSpec.upTo || matchingCards.length === 0;

	if (decisionPlayer.isBot) {
		const topCardsToPlace: CardInstance[] = [];
		for (const dest of searchSpec.destinations) {
			const idx = searchingPlayer.library.findIndex((c) =>
				matchesLibrarySearchSpec(
					c.card,
					searchSpec,
					resolveObjectFaces(c.card, instanceFaceOptions(c)).colors
				)
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
				const isAura = (found.copiableCard ?? found.card).typeLine.includes('Aura');
				if (isAura) {
					const attachCands = legalAuraAttachCandidates(state, found, searchingPlayer);
					if (attachCands.length === 0) {
						addLog(
							state,
							'rule',
							`${found.card.name} remained in ${searchingPlayer.username}'s library because there is no legal object or player for it to enchant (CR 303.4g).`,
							searchingPlayer.playerId
						);
						continue;
					}
					attachObject(state, found, attachCands[0]);
				}
				found.tapped = Boolean(dest.tapped);
				found.summoningSick = true;
				found.defaultControllerId = searchingPlayer.playerId;
				applySelfEtbReplacements(state, found);
				moveObject(state, found, 'battlefield', {
					from: fromLibrary,
					toPlayer: searchingPlayer,
					controllerId: searchingPlayer.playerId,
					newTimestamp: !isAura,
					bumpVersion: true
				});
				if (isAura && found.attachedToId) {
					const attachedTarget = findPermanentOnBoard(state, found.attachedToId);
					if (attachedTarget) {
						emitEvent(state, {
							kind: 'Attached',
							attachmentId: found.instanceId,
							attachment: found,
							hostId: attachedTarget.inst.instanceId,
							host: attachedTarget.inst
						});
					}
				}
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
					insert: (actual) => (actual === 'library' ? 'deferred' : 'end'),
					commanderRedirect: true,
					newTimestamp: true,
					bumpVersion: true
				});
				if (found.zone === 'library') {
					topCardsToPlace.push(found);
				}
			} else {
				moveObject(state, found, 'hand', {
					from: fromLibrary,
					toPlayer: searchingPlayer,
					commanderRedirect: true
				});
				addLog(
					state,
					'rule',
					searchSpec.reveal
						? `${searchingPlayer.username} searched their library, revealed ${found.card.name}, and put it into hand.`
						: `${searchingPlayer.username} searched their library for a card and put it into hand.`,
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
	inst.summoningSick = true;
	if (spec.tapped) inst.tapped = true;
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
		if (controller.poison === 0) {
			if ((controller.experienceCounters || 0) > 0) {
				controller.experienceCounters = (controller.experienceCounters || 0) + 1;
			}
			if ((controller.energyCounters || 0) > 0) {
				controller.energyCounters = (controller.energyCounters || 0) + 1;
			}
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
				if ((opp.experienceCounters || 0) > 0) {
					opp.experienceCounters = (opp.experienceCounters || 0) + 1;
				}
				if ((opp.energyCounters || 0) > 0) {
					opp.energyCounters = (opp.energyCounters || 0) + 1;
				}
			}
		}
	}
	noteLayerInputsChanged(state);
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
			emitVfx(state, { kind: 'phase_change', label: 'Combat — Declare Attackers' });
			beginPhase(state, 'declare_attackers', activePlayer);
			break;

		case 'declare_attackers':
			if (state.combat.active && state.combat.attackers.length > 0) {
				beginPhase(state, 'declare_blockers', activePlayer);
				if (!state.combat.blockersDeclared) {
					const defendersInOrder = getAttackedDefenderIdsInTurnOrder(state);
					const nextDefenderId =
						defendersInOrder.find(
							(defId) => !state.combat.declaredBlockersPlayerIds.includes(defId)
						) || state.combat.attackers[0].defenderPlayerId;
					const defIdx = state.players.findIndex((p) => p.playerId === nextDefenderId);
					if (defIdx >= 0) {
						state.priorityPlayerIndex = defIdx;
					} else {
						givePriorityToActiveOrNextPlayer(state);
					}
					state.passedPriorityPlayerIds = [];
					checkStateBasedActions(state);
					return;
				}
				break;
			} else {
				// CR 508.8: If no creatures are declared as attackers, skip declare_blockers, combat_damage, and end_combat
				state.combat.active = false;
				state.combat.attackers = [];
				state.combat.declaredBlockersPlayerIds = [];
				state.combat.blockersDeclared = false;
				state.combat.dealtFirstStrikeDamageIds = [];
				noteLayerInputsChanged(state);
				if ((state.additionalCombatPhases ?? 0) > 0) {
					state.additionalCombatPhases!--;
					beginPhase(state, 'begin_combat', activePlayer);
					emitVfx(state, { kind: 'phase_change', label: 'Combat — Beginning of Additional Combat' });
					addLog(state, 'rule', `${activePlayer.username} begins an additional combat phase.`);
				} else {
					beginPhase(state, 'main2', activePlayer);
					emitVfx(state, { kind: 'phase_change', label: 'Postcombat Main Phase 2' });
				}
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
			noteLayerInputsChanged(state);
			if ((state.additionalCombatPhases ?? 0) > 0) {
				state.additionalCombatPhases!--;
				beginPhase(state, 'begin_combat', activePlayer);
				emitVfx(state, { kind: 'phase_change', label: 'Combat — Beginning of Additional Combat' });
				addLog(state, 'rule', `${activePlayer.username} begins an additional combat phase.`);
			} else {
				beginPhase(state, 'main2', activePlayer);
				emitVfx(state, { kind: 'phase_change', label: 'Postcombat Main Phase 2' });
			}
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

	givePriorityToActiveOrNextPlayer(state);
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

const COMBAT_DAMAGE_ASSIGNMENT_HANDLER = 'combat_damage_assignment';

function executeCombatDamageStep(
	state: GameState,
	isFirstStrikeStep: boolean,
	chosenDamage: Record<string, number> = {}
): boolean {
	if (!state.combat.dealtFirstStrikeDamageIds) {
		state.combat.dealtFirstStrikeDamageIds = [];
	}

	// CR 510.2: All combat damage in a step is assigned and dealt simultaneously.
	// Snapshot combatant characteristics BEFORE any Infect/Wither -1/-1 counters or damageMarked mutations apply!
	interface CombatantSnapshot {
		power: number;
		toughness: number;
		damageMarkedBefore: number;
		hasFS: boolean;
		hasDS: boolean;
		hasTrample: boolean;
		dealsNow: boolean;
		srcInfo: SourceDamageInfo;
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
		const srcInfo = sourceDamageInfo(state, perm, perm.copiableCard ?? perm.card);
		snapshots.set(perm.instanceId, {
			power: getCreaturePower(perm, state),
			toughness: getCreatureToughness(perm, state),
			damageMarkedBefore: perm.damageMarked,
			hasFS,
			hasDS,
			hasTrample: hasKeyword(perm, 'Trample', state),
			dealsNow,
			srcInfo
		});
	};

	withStableLayerInputs(state, () => {
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
	});

	type AttackerDamageAssignment =
		| { kind: 'none_pw_left' }
		| { kind: 'none_blocked_left' }
		| { kind: 'planeswalker'; target: CardInstance; amount: number; mode: 'unblocked' | 'trample' }
		| { kind: 'player'; target: PlayerGameState; amount: number; mode: 'unblocked' | 'trample' }
		| { kind: 'blocker'; target: CardInstance; amount: number };

	interface ScheduledCombatEntry {
		attacker: CardInstance;
		atkPlayer: PlayerGameState;
		defPlayer: PlayerGameState;
		atkSnap: CombatantSnapshot;
		blockers: CardInstance[];
		attackerAssignments: AttackerDamageAssignment[];
		blockerAssignments: Array<{
			blocker: CardInstance;
			bSnap: CombatantSnapshot;
			amount: number;
		}>;
	}

	// CR 510.1: First compute all combat damage assignments before dealing any damage (CR 510.2).
	const assignedDamageOnPerm = new Map<string, number>();
	const assignedDeathtouchOnPerm = new Set<string>();
	const scheduledCombats: ScheduledCombatEntry[] = []; [];

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
		const atkPower = atkSnap.power;
		const atkDeathtouch = atkSnap.srcInfo.hasDeathtouch;
		const atkTrample = atkSnap.hasTrample;

		const blockers = atkEntry.blockerInstanceIds
			.map((id) => defPlayer.battlefield.find((c) => !c.phasedOut && c.instanceId === id))
			.filter((b): b is CardInstance => Boolean(b));

		// Check if all combat damage is prevented this turn (e.g., Fog)
		const combatDamagePrevented =
			atkPlayer.preventAllCombatDamageThisTurn || defPlayer.preventAllCombatDamageThisTurn;

		const attackerAssignments: AttackerDamageAssignment[] = [];
		if (attackerDealsNow && atkPower > 0 && !combatDamagePrevented) {
			let remainingDamage = atkPower;
			const attackingPlaneswalker = Boolean(atkEntry.defenderPlaneswalkerId);
			const defWalker =
				atkEntry.defenderPlaneswalkerId && atkEntry.defenderPlaneswalkerId !== 'removed'
					? defPlayer.battlefield.find(
							(c) =>
								!c.phasedOut &&
								c.instanceId === atkEntry.defenderPlaneswalkerId &&
								evaluatePermanent(state, c).isPlaneswalker
						)
					: undefined;

			if (!atkEntry.wasBlocked && blockers.length === 0) {
				if (defWalker) {
					attackerAssignments.push({
						kind: 'planeswalker',
						target: defWalker,
						amount: remainingDamage,
						mode: 'unblocked'
					});
				} else if (!attackingPlaneswalker) {
					attackerAssignments.push({
						kind: 'player',
						target: defPlayer,
						amount: remainingDamage,
						mode: 'unblocked'
					});
				} else {
					attackerAssignments.push({ kind: 'none_pw_left' });
				}
			} else if (atkEntry.wasBlocked && blockers.length === 0 && !atkTrample) {
				attackerAssignments.push({ kind: 'none_blocked_left' });
			} else {
				// CR 702.19f: A creature with Trample attacking a planeswalker that left combat cannot assign excess
				// damage to the defending player; all damage must be assigned to its blockers (or 0 if none remain).
				const canTrampleOver = atkTrample && (!attackingPlaneswalker || Boolean(defWalker));
				let allPriorBlockersLethal = true;
				for (let i = 0; i < blockers.length; i++) {
					const b = blockers[i];
					const bSnap = snapshots.get(b.instanceId)!;
					const bTough = bSnap.toughness;
					const alreadyAssignedOrMarked =
						assignedDamageOnPerm.get(b.instanceId) ?? bSnap.damageMarkedBefore;
					const remTough = Math.max(0, bTough - alreadyAssignedOrMarked);
					const lethalNeeded =
						remTough === 0 || assignedDeathtouchOnPerm.has(b.instanceId)
							? 0
							: atkDeathtouch
								? 1
								: remTough;

					const isLastBlocker = i === blockers.length - 1;
					const autoDmg =
						isLastBlocker && (!canTrampleOver || !allPriorBlockersLethal)
							? remainingDamage
							: Math.min(remainingDamage, lethalNeeded);

					let dmgToBlocker = autoDmg;
					// CR 510.1c–d, 702.19b: When blocked by multiple creatures, human controller divides combat damage
					// among the blockers (and with Trample, must assign lethal to all blockers before excess tramples over).
					if (!atkPlayer.isBot && (blockers.length >= 2 || canTrampleOver) && remainingDamage > 0) {
						const minDmg = isLastBlocker
							? canTrampleOver && allPriorBlockersLethal && remainingDamage > lethalNeeded
								? lethalNeeded
								: remainingDamage
							: 0;
						const maxDmg = remainingDamage;
						if (minDmg < maxDmg) {
							const key = `${attacker.instanceId}:${b.instanceId}`;
							const chosen = chosenDamage[key];
							if (chosen === undefined) {
								const reason = `Assign combat damage from ${attacker.card.name} (${remainingDamage} remaining) to blocker ${b.card.name} (${minDmg}–${maxDmg}; lethal is ${lethalNeeded}).`;
								enqueueChoicePrompt(state, {
									id: uid('prm', state),
									playerId: atkPlayer.playerId,
									kind: 'chooseNumber',
									purpose: 'generic',
									title: `Combat Damage — ${attacker.card.name} → ${b.card.name}`,
									description: reason,
									continuation: {
										kind: 'handler',
										name: COMBAT_DAMAGE_ASSIGNMENT_HANDLER,
										data: {
											isFirstStrikeStep,
											chosenDamage,
											key
										}
									},
									choice: {
										kind: 'chooseNumber',
										min: minDmg,
										max: maxDmg,
										defaultNumber: Math.max(minDmg, Math.min(maxDmg, autoDmg)),
										reason
									}
								});
								return true;
							}
							dmgToBlocker = Math.max(minDmg, Math.min(maxDmg, chosen));
						}
					}

					if (dmgToBlocker < lethalNeeded) {
						allPriorBlockersLethal = false;
					}

					if (dmgToBlocker > 0) {
						assignedDamageOnPerm.set(b.instanceId, alreadyAssignedOrMarked + dmgToBlocker);
						if (atkDeathtouch) assignedDeathtouchOnPerm.add(b.instanceId);
						attackerAssignments.push({
							kind: 'blocker',
							target: b,
							amount: dmgToBlocker
						});
						remainingDamage -= dmgToBlocker;
					}
				}

				if (canTrampleOver && allPriorBlockersLethal && remainingDamage > 0) {
					if (defWalker) {
						attackerAssignments.push({
							kind: 'planeswalker',
							target: defWalker,
							amount: remainingDamage,
							mode: 'trample'
						});
					} else if (!attackingPlaneswalker) {
						attackerAssignments.push({
							kind: 'player',
							target: defPlayer,
							amount: remainingDamage,
							mode: 'trample'
						});
					}
				}
			}
		}

		const blockerAssignments: ScheduledCombatEntry['blockerAssignments'] = [];
		if (!combatDamagePrevented) {
			for (const b of blockers) {
				const bSnap = snapshots.get(b.instanceId)!;
				const blockerDealsNow = bSnap.dealsNow;
				if (blockerDealsNow && bSnap.power > 0) {
					blockerAssignments.push({ blocker: b, bSnap, amount: bSnap.power });
				}
			}
		}

		scheduledCombats.push({
			attacker,
			atkPlayer,
			defPlayer,
			atkSnap,
			blockers,
			attackerAssignments,
			blockerAssignments
		});
	}

	// CR 510.2: Deal all assigned combat damage simultaneously through the unified damage pipeline.
	const combatDamagedPlayers = new Map<string, CardInstance[]>();
	for (const sched of scheduledCombats) {
		const { attacker, atkPlayer, defPlayer, atkSnap, blockers, attackerAssignments, blockerAssignments } =
			sched;
		if (isFirstStrikeStep) {
			if (atkSnap.dealsNow && !state.combat.dealtFirstStrikeDamageIds.includes(attacker.instanceId)) {
				state.combat.dealtFirstStrikeDamageIds.push(attacker.instanceId);
			}
			for (const b of blockers) {
				const bSnap = snapshots.get(b.instanceId);
				if (bSnap?.dealsNow && !state.combat.dealtFirstStrikeDamageIds.includes(b.instanceId)) {
					state.combat.dealtFirstStrikeDamageIds.push(b.instanceId);
				}
			}
		}
		const atkInfect = atkSnap.srcInfo.hasInfect;
		const atkLifelink = atkSnap.srcInfo.hasLifelink;
		let totalDealtByAttacker = 0;

		for (const asgn of attackerAssignments) {
			if (asgn.kind === 'none_pw_left') {
				// CR 506.4c / 510.1b / 702.19f: An unblocked creature whose attacked planeswalker left combat deals no combat damage.
				addLog(
					state,
					'combat',
					`${attacker.card.name} was attacking a planeswalker that left combat, so it deals no combat damage (CR 506.4c, 510.1b).`,
					atkPlayer.playerId
				);
			} else if (asgn.kind === 'none_blocked_left') {
				// CR 509.1h / 510.1c: An attacking creature that became blocked remains blocked even if all blockers
				// left the battlefield before combat damage. Without Trample, it assigns 0 combat damage!
				addLog(
					state,
					'combat',
					`${attacker.card.name} was blocked (its blocker left combat) and does not have Trample, so it deals no combat damage (CR 510.1c).`,
					atkPlayer.playerId
				);
			} else if (asgn.kind === 'planeswalker') {
				const dealt = dealDamageToPermanent(
					state,
					asgn.target,
					asgn.amount,
					attacker.instanceId,
					atkSnap.srcInfo,
					{
						combat: true,
						actorId: atkPlayer.playerId,
						vfxLabel:
							asgn.mode === 'trample'
								? `Trample -${asgn.amount} Loyalty`
								: `-${asgn.amount} Loyalty`
					}
				);
				totalDealtByAttacker += dealt;
				if (dealt > 0) {
					addLog(
						state,
						'combat',
						asgn.mode === 'trample'
							? `${attacker.card.name} trampled over for ${dealt} combat damage to ${asgn.target.card.name}!`
							: `${attacker.card.name} dealt ${dealt} unblocked combat damage to ${asgn.target.card.name}.`,
						atkPlayer.playerId
					);
				}
			} else if (asgn.kind === 'blocker') {
				const dealt = dealDamageToPermanent(
					state,
					asgn.target,
					asgn.amount,
					attacker.instanceId,
					atkSnap.srcInfo,
					{
						combat: true,
						actorId: atkPlayer.playerId
					}
				);
				totalDealtByAttacker += dealt;
			} else if (asgn.kind === 'player') {
				const dealt = dealDamageToPlayer(
					state,
					asgn.target,
					asgn.amount,
					attacker.instanceId,
					atkSnap.srcInfo,
					{
						combat: true,
						vfxSourceId: attacker.instanceId,
						vfxLabel:
							asgn.mode === 'trample'
								? atkInfect
									? `Trample +${asgn.amount} Poison`
									: `Trample -${asgn.amount}`
								: atkInfect
									? `+${asgn.amount} Poison`
									: `-${asgn.amount}`
					}
				);
				totalDealtByAttacker += dealt;
				if (dealt > 0) {
					const damagedAttackers = combatDamagedPlayers.get(asgn.target.playerId);
					if (!damagedAttackers) {
						combatDamagedPlayers.set(asgn.target.playerId, [attacker]);
					} else if (!damagedAttackers.some((c) => c.instanceId === attacker.instanceId)) {
						damagedAttackers.push(attacker);
					}
					// Track Commander Combat Damage (CR 903.10a)
					if (attacker.isCommander) {
						defPlayer.commanderDamageTaken[attacker.instanceId] =
							(defPlayer.commanderDamageTaken[attacker.instanceId] || 0) + dealt;
					}
					if (asgn.mode === 'trample') {
						addLog(
							state,
							'combat',
							`${attacker.card.name} trampled over for ${dealt} ${atkInfect ? 'Infect (Poison) ' : ''}combat damage to ${defPlayer.username}!`,
							atkPlayer.playerId
						);
					} else if (attacker.isCommander) {
						addLog(
							state,
							'combat',
							`Commander ${attacker.card.name} dealt ${dealt} combat damage to ${defPlayer.username} (Total: ${defPlayer.commanderDamageTaken[attacker.instanceId]}/${state.rules.commanderDamageLethal || '∞'}).`,
							atkPlayer.playerId
						);
					} else {
						addLog(
							state,
							'combat',
							`${attacker.card.name} dealt ${dealt} unblocked ${atkInfect ? 'Infect (Poison) ' : ''}combat damage to ${defPlayer.username}.`,
							atkPlayer.playerId
						);
					}
				}
			}
		}

		if (atkLifelink && totalDealtByAttacker > 0) {
			const lifeBefore = atkPlayer.life;
			applyLifelinkGain(state, atkPlayer, totalDealtByAttacker);
			if (atkPlayer.life > lifeBefore) {
				emitVfx(state, {
					kind: 'heal',
					targetId: atkPlayer.playerId,
					amount: totalDealtByAttacker,
					label: `+${totalDealtByAttacker} Lifelink`
				});
			}
		}

		for (const bAsgn of blockerAssignments) {
			const dealtByBlocker = dealDamageToPermanent(
				state,
				attacker,
				bAsgn.amount,
				bAsgn.blocker.instanceId,
				bAsgn.bSnap.srcInfo,
				{
					combat: true,
					actorId: defPlayer.playerId
				}
			);
			if (bAsgn.bSnap.srcInfo.hasLifelink && dealtByBlocker > 0) {
				applyLifelinkGain(state, defPlayer, dealtByBlocker);
			}
		}
	}

	// CR 603.2c: Emit one batch event per player dealt combat damage in this step, before SBAs run.
	for (const [damagedPlayerId, attackers] of combatDamagedPlayers) {
		emitEvent(state, {
			kind: 'CombatDamageBatchPlayer',
			damagedPlayerId,
			attackers
		});
		// CR 726.2: Inherent triggered ability controlled by the monarch at trigger time:
		// "Whenever a creature deals combat damage to the monarch, its controller becomes the monarch."
		if (state.monarchPlayerId === damagedPlayerId) {
			const monarchPlayer = state.players.find((p) => p.playerId === damagedPlayerId && !p.lost);
			if (monarchPlayer) {
				for (const atk of attackers) {
					const newMonarchPlayerId = atk.controllerId || atk.ownerId;
					pushMonarchInherentTrigger(
						state,
						monarchPlayer,
						{ kind: 'monarchCombatDamage', newMonarchPlayerId },
						'The Monarch (Combat Damage)',
						'Whenever a creature deals combat damage to the monarch, its controller becomes the monarch.'
					);
				}
			}
		}
	}

	if (isFirstStrikeStep) {
		state.combat.damageDealtFirstStrike = true;
	} else {
		state.combat.damageDealtNormal = true;
	}
	return false;
}

registerPromptHandler(COMBAT_DAMAGE_ASSIGNMENT_HANDLER, (state, prompt, answer) => {
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	const isFirstStrikeStep = Boolean(data?.isFirstStrikeStep);
	const prevChosen =
		data?.chosenDamage && typeof data.chosenDamage === 'object'
			? (data.chosenDamage as Record<string, number>)
			: {};
	const key = typeof data?.key === 'string' ? data.key : '';
	const n = answer.kind === 'chooseNumber' ? answer.n : 0;
	const nextChosen: Record<string, number> = key ? { ...prevChosen, [key]: n } : { ...prevChosen };

	let paused = false;
	withTriggersDeferred(state, () => {
		paused = executeCombatDamageStep(state, isFirstStrikeStep, nextChosen);
		if (!paused && !hasBlockingReplacementOrCommanderPrompt(state)) {
			checkStateBasedActions(state);
		}
	});
	if (paused || state.status === 'finished') return;
	if (hasBlockingReplacementOrCommanderPrompt(state)) {
		state.pendingProcedure = {
			kind: 'combat_damage_step',
			phase: 'after_damage',
			isFirstStrikeStep
		};
		return;
	}
	finishCombatDamagePhase(state);
});

function clearEndOfTurnAndDamage(state: GameState): void {
	state.timedKeywordEffects = undefined;
	if (state.timedContinuousEffects?.length) {
		const persisting = state.timedContinuousEffects.filter(
			(eff) => eff.expires && eff.expires !== 'endOfTurn'
		);
		state.timedContinuousEffects = persisting.length > 0 ? persisting : undefined;
	}
	for (const p of state.players) {
		p.manaPool = createEmptyManaPool();
		p.restrictedMana = {};
		p.preventAllCombatDamageThisTurn = false;
		for (const perm of p.battlefield) {
			perm.damageMarked = 0;
			perm.deathtouchDamageMarked = false;
			perm.tempPowerMod = 0;
			perm.tempToughnessMod = 0;
			perm.grantedKeywords = [];
			perm.switchedPTCount = 0;
			perm.activatedAbilityIdsThisTurn = undefined;
			perm.usedModalModesThisTurn = undefined;
			perm.regenerationShields = undefined;
			perm.cantBeRegeneratedThisTurn = undefined;
			perm.crewedThisTurnByIds = undefined;
			perm.saddledThisTurn = undefined;
			perm.saddledThisTurnByIds = undefined;
			perm.exertedThisTurn = undefined;
			if (perm.goadExpirations) {
				for (const [goaderId, dur] of Object.entries(perm.goadExpirations)) {
					if (dur === 'endOfTurn') {
						delete perm.goadExpirations[goaderId];
						if (perm.goadedByPlayerIds) {
							perm.goadedByPlayerIds = perm.goadedByPlayerIds.filter((id) => id !== goaderId);
						}
					}
				}
				if (perm.goadedByPlayerIds && perm.goadedByPlayerIds.length === 0) {
					perm.goadedByPlayerIds = undefined;
				}
				if (Object.keys(perm.goadExpirations).length === 0) {
					perm.goadExpirations = undefined;
				}
			}
		}
		const cleanupActivePlayer = state.players[state.activePlayerIndex];
		const currentTurnSerial = state.turnSerial ?? state.turnNumber;
		for (const ex of p.exile) {
			const perm = ex.playableFromExileBy;
			if (!perm) continue;
			if (perm.expiresAtEndOfTurn) {
				ex.playableFromExileBy = undefined;
			} else if (
				perm.duration === 'untilEndOfYourNextTurn' &&
				cleanupActivePlayer?.playerId === perm.expiresOnCleanupOfPlayerId &&
				currentTurnSerial > (perm.grantedOnTurnSerial ?? 0)
			) {
				ex.playableFromExileBy = undefined;
			}
		}
	}
	noteLayerInputsChanged(state);
	syncBattlefieldControllers(state);
}

function runCleanupStep(state: GameState): void {
	emptyAllPlayersManaPools(state);
	const activePlayer = state.players[state.activePlayerIndex];

	// Check if activePlayer has Reliquary Tower / Thought Vessel for unlimited hand size
	const hasNoMaxHandSize =
		state.rules.maxHandSize >= 99 || playerHasNoMaxHandSize(state, activePlayer);

	const maxHand = hasNoMaxHandSize ? 999 : state.rules.maxHandSize;
	if (!activePlayer.lost && activePlayer.hand.length > maxHand) {
		const excess = activePlayer.hand.length - maxHand;
		if (activePlayer.isBot) {
			for (const c of activePlayer.hand.slice(0, excess)) {
				moveObject(state, c, 'graveyard', {
					from: { player: activePlayer, zone: 'hand' },
					toPlayer: activePlayer,
					graveyardReplacement: true,
					commanderRedirect: true
				});
			}
			beginPhase(state, 'cleanup', activePlayer);
			completeTurnCleanupAndPassTurn(state);
		} else {
			beginPhase(state, 'cleanup', activePlayer);
			const candidateIds = activePlayer.hand.map((c) => c.instanceId);
			const description = `Cleanup Step: Select ${excess} card(s) from your hand to discard.`;
			enqueueChoicePrompt(state, {
				id: uid('prm', state),
				playerId: activePlayer.playerId,
				kind: 'discard_to_hand_size',
				purpose: 'discard_to_hand_size',
				title: `Discard Down to ${maxHand} Cards`,
				description,
				countRequired: excess,
				candidateInstanceIds: candidateIds,
				continuation: {
					kind: 'procedure',
					procedure: {
						kind: 'discard_to_hand_size',
						actorId: activePlayer.playerId,
						chosenIds: [],
						nextIndex: 0,
						discardCount: excess
					}
				},
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
		givePriorityToActiveOrNextPlayer(state);
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
				state.turnSerial = (state.turnSerial ?? state.turnNumber) + 1;
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
		if (state.players[nextIdx].lost) {
			// CR 800.4m: "until your next turn" effects created by a player who left the game expire when their next turn would begin.
			expirePlayerUntilNextTurnEffects(state, state.players[nextIdx].playerId);
			continue;
		}
		if (nextIdx <= baseIdx) {
			state.turnNumber += 1;
		}
		state.turnSerial = (state.turnSerial ?? state.turnNumber) + 1;
		state.activePlayerIndex = nextIdx;
		break;
	}

	runBeginningOfTurn(state);
}

function getAuraEnchantParams(aura: CardInstance, evalAura: EvaluatedPermanent): string[] {
	const params: string[] = [];
	if (!evalAura.losesAllAbilities) {
		for (const ab of activeAbilityDefs(
			effectiveCardForObject(aura),
			instanceFaceOptions(aura, 'battlefield')
		)) {
			if (ab.kind === 'keyword' && ab.keyword.name.toLowerCase() === 'enchant') {
				params.push((ab.keyword.param ?? 'permanent').trim());
			}
		}
	}
	for (const kwLine of evalAura.keywords) {
		if (kwLine.toLowerCase().startsWith('enchant ')) {
			const p = kwLine.slice('enchant '.length).trim();
			if (p && !params.some((existing) => existing.toLowerCase() === p.toLowerCase())) {
				params.push(p);
			}
		}
	}
	return params;
}

function matchesSingleEnchantParamOnPermanent(
	enchantParam: string,
	auraController: PlayerGameState,
	evalHost: EvaluatedPermanent,
	hostController: PlayerGameState
): boolean {
	let param = enchantParam.toLowerCase().trim();
	if (
		param === 'player' ||
		param === 'opponent' ||
		param === 'an opponent' ||
		param === 'you'
	) {
		return false;
	}
	if (param.includes('you control')) {
		if (hostController.playerId !== auraController.playerId) return false;
		param = param.replace(/\byou control\b/g, '').trim();
	} else if (param.includes('opponent controls')) {
		if (hostController.playerId === auraController.playerId) return false;
		param = param.replace(/\ban?\s+opponent controls\b|\bopponent controls\b/g, '').trim();
	}

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

function isAuraAttachmentLegal(
	state: GameState,
	aura: CardInstance,
	auraController: PlayerGameState,
	evalAura: EvaluatedPermanent,
	host: CardInstance,
	hostController: PlayerGameState
): boolean {
	// CR 303.4d: An Aura can't enchant itself. If this occurs somehow, the Aura is put into its owner's graveyard.
	// CR 303.4d: An Aura that's also a creature can't enchant anything.
	if (aura.instanceId === host.instanceId) return false;
	if (evalAura.isCreature) return false;
	if (host.phasedOut) return false;
	if (hasProtectionFrom(host, aura.copiableCard ?? aura.card, state, aura)) return false;

	const enchantParams = getAuraEnchantParams(aura, evalAura);
	// CR 704.5m / 303.4c: If an Aura has lost all its enchant abilities, it can't legally enchant anything.
	if (enchantParams.length === 0) return !evalAura.losesAllAbilities;

	const evalHost = evaluatePermanent(state, host);
	// CR 702.5c: If an Aura has multiple instances of enchant, all of its enchant abilities must be satisfied.
	return enchantParams.every((p) =>
		matchesSingleEnchantParamOnPermanent(p, auraController, evalHost, hostController)
	);
}

function isAuraPlayerAttachmentLegal(
	aura: CardInstance,
	auraController: PlayerGameState,
	evalAura: EvaluatedPermanent,
	hostPlayer: PlayerGameState
): boolean {
	if (hostPlayer.lost) return false;
	if (evalAura.isCreature) return false;
	if (hostPlayer.protectionFromEverythingThisTurn) return false;

	const enchantParams = getAuraEnchantParams(aura, evalAura);
	if (enchantParams.length === 0) return false;

	// CR 702.5c: All enchant abilities on the Aura must be satisfied by the enchanted player.
	return enchantParams.every((raw) => {
		const param = raw.toLowerCase().trim();
		if (param === 'player' || param.includes('player')) {
			if (param.includes('opponent')) {
				return hostPlayer.playerId !== auraController.playerId;
			}
			return true;
		}
		if (param === 'opponent' || param === 'an opponent') {
			return hostPlayer.playerId !== auraController.playerId;
		}
		if (param === 'you') {
			return hostPlayer.playerId === auraController.playerId;
		}
		return false;
	});
}

function isAuraHarmful(aura: CardInstance): boolean {
	for (const ab of activeAbilityDefs(
		effectiveCardForObject(aura),
		instanceFaceOptions(aura, 'battlefield')
	)) {
		if (ab.kind !== 'static') continue;
		if (ab.static.k === 'restriction') return true;
		if (ab.static.k === 'continuous') {
			if (ab.static.mod.k === 'removeAllAbilities') return true;
			if (ab.static.mod.k === 'pt') {
				const pw = ab.static.mod.power;
				const tg = ab.static.mod.toughness;
				if ((pw.k === 'const' && pw.n < 0) || (tg.k === 'const' && tg.n < 0)) return true;
			}
		}
	}
	return false;
}

/**
 * CR 303.4f–g: Returns the legal object/player ids that `aura` may enchant when entering the
 * battlefield under `controller`'s control without being cast, ranked by the bot heuristic.
 */
export function legalAuraAttachCandidates(
	state: GameState,
	aura: CardInstance,
	controller: PlayerGameState
): string[] {
	const evalAura = evaluatePermanent(state, aura);
	const harmful = isAuraHarmful(aura);
	const permCandidates: Array<{ id: string; preferred: boolean; score: number }> = [];
	for (const p of state.players) {
		if (p.lost) continue;
		for (const host of p.battlefield) {
			if (isAuraAttachmentLegal(state, aura, controller, evalAura, host, p)) {
				const isOwn = p.playerId === controller.playerId;
				const preferred = harmful ? !isOwn : isOwn;
				const evalHost = evaluatePermanent(state, host);
				const score =
					host.card.cmc + (evalHost.isCreature ? getCreaturePower(host, state) : 0);
				permCandidates.push({ id: host.instanceId, preferred, score });
			}
		}
	}
	permCandidates.sort((a, b) => {
		if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
		return a.preferred ? b.score - a.score : a.score - b.score;
	});

	const playerCandidates: Array<{ id: string; preferred: boolean; score: number }> = [];
	for (const p of state.players) {
		if (!p.lost && isAuraPlayerAttachmentLegal(aura, controller, evalAura, p)) {
			const isOwn = p.playerId === controller.playerId;
			const preferred = harmful ? !isOwn : isOwn;
			playerCandidates.push({ id: p.playerId, preferred, score: p.life });
		}
	}
	playerCandidates.sort((a, b) => {
		if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
		return b.score - a.score;
	});

	return [
		...permCandidates.map((c) => c.id),
		...playerCandidates.map((c) => c.id)
	];
}

/**
 * CR 704.3: State-Based Actions are checked in an iterative fixpoint loop
 * until a pass produces no state-based actions.
 */
export function checkStateBasedActions(state: GameState): void {
	if (state.status !== 'active') return;
	// CR 616.1, 704.3, 704.4: While a replacement-choice prompt (`counter_replacement_choice` or
	// `zone_replacement_choice`), pending zone move, pending cost payment, pending procedure, or
	// mid-resolution stack item is active, do not check SBAs yet;
	// `resumeStackItem` / `resumeAfterPrompt` runs `checkStateBasedActions` once it finishes.
	if (state.pendingPrompts.some((pr) => pr.choice?.kind === 'chooseReplacement')) return;
	if (state.pendingZoneMoves && state.pendingZoneMoves.length > 0) return;
	if (state.pendingCostPayment) return;
	if (state.pendingProcedure) return;
	if (state.stack.some((s) => Boolean(s.resolutionStarted))) return;

	syncBattlefieldControllers(state);

	let maxIterations = 25;
	let anyActionTaken = true;

	while (anyActionTaken && maxIterations-- > 0) {
		if (state.pendingPrompts.some((pr) => pr.choice?.kind === 'chooseReplacement')) break;
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

		// CR 506.4: Remove from combat any attacking or blocking permanent that left the battlefield,
		// phased out, stopped being a creature, or became a battle.
		if (state.combat.active && state.combat.attackers.length > 0) {
			const isCombatCreature = (id: string): boolean => {
				const snap = prePassSnapshot.get(id);
				return Boolean(
					snap && snap.evalPerm.isCreature && !snap.evalPerm.typeLine.includes('Battle')
				);
			};
			const prevAtkCount = state.combat.attackers.length;
			let combatChanged = false;
			state.combat.attackers = state.combat.attackers.filter((atk) =>
				isCombatCreature(atk.attackerInstanceId)
			);
			if (state.combat.attackers.length !== prevAtkCount) combatChanged = true;
			for (const atk of state.combat.attackers) {
				if (atk.blockerInstanceIds.length > 0) {
					const prevBlkLen = atk.blockerInstanceIds.length;
					atk.blockerInstanceIds = atk.blockerInstanceIds.filter(isCombatCreature);
					if (atk.blockerInstanceIds.length !== prevBlkLen) combatChanged = true;
				}
				if (atk.defenderPlaneswalkerId && atk.defenderPlaneswalkerId !== 'removed') {
					const pwSnap = prePassSnapshot.get(atk.defenderPlaneswalkerId);
					const defPlayer = state.players.find((p) => p.playerId === atk.defenderPlayerId);
					const onDefBattlefield = defPlayer?.battlefield.some(
						(c) => !c.phasedOut && c.instanceId === atk.defenderPlaneswalkerId
					);
					if (!pwSnap || !onDefBattlefield || !pwSnap.evalPerm.isPlaneswalker) {
						atk.defenderPlaneswalkerId = 'removed';
					}
				}
			}
			if (combatChanged) noteLayerInputsChanged(state);
		}

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
			kind: 'aura' | 'dying' | 'legend' | 'saga';
			legName?: string;
		}> = [];
		const queuedIds = new Set<string>();
		const queueToGraveyard = (
			perm: CardInstance,
			controller: PlayerGameState,
			kind: 'aura' | 'dying' | 'legend' | 'saga',
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
							if (targetFound) {
								if (
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
							} else {
								const targetPlayer = state.players.find(
									(pl) => pl.playerId === perm.attachedToId && !pl.lost
								);
								if (
									!targetPlayer ||
									!isAuraPlayerAttachmentLegal(perm, p, evalPerm, targetPlayer)
								) {
									perm.attachedToId = null;
									noteLayerInputsChanged(state);
									queueToGraveyard(perm, p, 'aura');
								}
							}
						}
					} else if (isEquipment && perm.attachedToId) {
						const targetFound = findPermanentOnBoard(state, perm.attachedToId);
						if (
							evalPerm.isCreature ||
							perm.instanceId === perm.attachedToId ||
							!targetFound ||
							!evaluatePermanent(state, targetFound.inst).typeLine.includes('Creature') ||
							hasProtectionFrom(targetFound.inst, perm.copiableCard ?? perm.card, state, perm)
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
							if (evalPerm.keywords.some((k) => k.toLowerCase() === 'indestructible')) {
								// CR 704.5h: Clear deathtouch damage flag once SBAs have been checked and creature survived
								if (perm.deathtouchDamageMarked) perm.deathtouchDamageMarked = false;
							} else if (tryRegenerateInsteadOfDestroy(state, perm, true)) {
								// CR 701.19a / 704.5g-h: Regenerated instead of lethal/deathtouch destruction
							} else {
								dies = true;
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
									countRequired: 1,
									continuation: {
										kind: 'procedure',
										procedure: {
											kind: 'legend_rule',
											actorId: p.playerId,
											keepInstanceId: '',
											remainingInstanceIds: cands,
											nextIndex: 0
										}
									}
								});
							}
						}
					}
				}

				// 5. Saga final-chapter SBA (CR 715.4, CR 704.5s):
				// Sacrifice any Saga with finalChapterNumber > 0 and lore >= finalChapterNumber that isn't
				// the source of a chapter ability currently on the stack or waiting to be placed there.
				const pendingNow = peekPendingTriggers(state);
				for (const perm of p.battlefield) {
					if (perm.phasedOut || perm.isFaceDown || queuedIds.has(perm.instanceId)) continue;
					const finalCh = getSagaFinalChapterNumber(state, perm);
					if (finalCh <= 0) continue;
					if ((perm.counters.lore || 0) < finalCh) continue;
					const hasChapterOnStack = state.stack.some(
						(s) => Boolean(s.isChapterAbility) && s.sourceInstanceId === perm.instanceId
					);
					if (hasChapterOnStack) continue;
					const hasChapterPending = pendingNow.some(
						(t) =>
							(Boolean(t.isChapterAbility) || Boolean(t.ability.trigger.isChapterAbility)) &&
							t.source.instanceId === perm.instanceId
					);
					if (hasChapterPending) continue;
					queueToGraveyard(perm, p, 'saga');
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

		// Why the batch/replay loop resets battlefields between items:
		// All SBAs in a single pass happen simultaneously (CR 704.3, 603.10a, 704.8), but movePermanentToZone
		// moves one permanent at a time (evaluating replacement effects, capturing LKI, and matching triggers).
		// Rewinding battlefields and previously moved batch items before each movePermanentToZone call ensures
		// every dying permanent in the batch sees the full pre-batch board, then restores all post-move results.
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
				destZone: 'graveyard' | 'exile' | 'command' | 'library' | 'hand' | 'battlefield' | 'pending';
				insertIndex: number;
				owner: PlayerGameState | undefined;
			}
		>();
		const pendingLinkedReturns: Array<{ leavingId: string; leavingVersion: number }> = [];

		for (const p of state.players) {
			if (p.lost) continue;

			const playerBatch = sbaGraveyardBatch.filter((item) => item.controller.playerId === p.playerId);
			for (const item of playerBatch) {
				if (sbaGraveyardBatch.length > 1 && preBattlefields && preItemStates) {
					for (const [pl, bf] of preBattlefields.entries()) {
						setZoneOrder(pl, 'battlefield', [...bf]);
					}
					for (const prev of postResults.values()) {
						if (prev.owner && prev.destZone !== 'pending') {
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
				const leavingVersion = item.perm.objectVersion || 1;
				const actualDest = movePermanentToZone(
					state,
					item.perm,
					'graveyard',
					{
						kind: item.kind,
						controllerId: item.controller.playerId,
						controllerUsername: item.controller.username,
						...(item.kind === 'legend' ? { legName: item.legName } : {})
					},
					sbaGraveyardBatch.length > 1 ? { skipLinkedReturn: true } : undefined
				);
				if (sbaGraveyardBatch.length > 1 && actualDest !== 'battlefield' && actualDest !== 'pending') {
					pendingLinkedReturns.push({ leavingId: item.perm.instanceId, leavingVersion });
				}

				if (sbaGraveyardBatch.length > 1) {
					const owner = state.players.find((pl) => pl.playerId === item.perm.ownerId);
					const destZone: 'graveyard' | 'exile' | 'command' | 'library' | 'hand' | 'battlefield' | 'pending' =
						actualDest === 'pending' || actualDest === 'stack' ? 'pending' : actualDest;
					const insertIndex =
						owner && destZone !== 'pending'
							? owner[destZone].findIndex((c) => c.instanceId === item.perm.instanceId)
							: -1;
					postResults.set(item.perm.instanceId, {
						perm: item.perm,
						postState: {
							...item.perm,
							counters: { ...item.perm.counters },
							grantedKeywords: [...item.perm.grantedKeywords]
						},
						destZone,
						insertIndex,
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
					if (res.owner && res.destZone !== 'pending' && !res.perm.isToken) {
						const curZone = res.owner[res.destZone];
						if (!curZone.some((c) => c.instanceId === res.perm.instanceId)) {
							const nextZone = [...curZone];
							const at =
								res.insertIndex >= 0 && res.insertIndex <= nextZone.length
									? res.insertIndex
									: nextZone.length;
							nextZone.splice(at, 0, res.perm);
							setZoneOrder(res.owner, res.destZone, nextZone);
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
					enqueueChoicePrompt(state, {
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
						continuation: {
							kind: 'procedure',
							procedure: {
								kind: 'commander_zone_choice',
								commanderInstanceId: cmd.instanceId,
								destinationZone: cmd.zone
							}
						},
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
			returnLinkedExiledForSources(state, pendingLinkedReturns);
		}
		if (syncBattlefieldControllers(state)) {
			anyActionTaken = true;
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
		revealFaceDownObjects(state);
	} else if (remaining.length === 1 && state.players.length > 1) {
		// CR 104.2a: A player still in the game wins if all opponents have left the game.
		// This happens immediately and overrides all effects that would preclude that player from winning.
		const winner = remaining[0];
		if (winner) {
			state.status = 'finished';
			state.winnerPlayerId = winner.playerId;
			state.winnerId = winner.playerId;
			addLog(
				state,
				'system',
				`${winner.username} wins the Commander match!`,
				winner.playerId
			);
			revealFaceDownObjects(state);
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

	// CR 708.9: Reveal all face-down permanents and spells owned by the leaving player.
	revealFaceDownObjects(state, elimId);

	// 1. Remove pending prompts and delayed triggers for eliminated player (CR 800.4d)
	state.pendingPrompts = state.pendingPrompts.filter((pr) => pr.playerId !== elimId);
	if (state.delayedTriggers) {
		state.delayedTriggers = state.delayedTriggers.filter((dt) => dt.controllerId !== elimId);
	}

	// 2. Clean up the Stack for the eliminated player (CR 800.4a)
	// - Objects owned by the eliminated player leave the game.
	// - Objects on the stack not represented by cards controlled by the eliminated player cease to exist.
	// - Card-backed spells still controlled by the eliminated player are exiled.
	const remainingStack: StackItem[] = [];
	for (const item of state.stack) {
		const itemOwnerId = item.ownerId || item.controllerId;
		if (itemOwnerId === elimId) {
			continue;
		}
		if (item.controllerId === elimId) {
			if (item.kind === 'spell' && !item.isCopy) {
				const owner = state.players.find((pl) => pl.playerId === itemOwnerId && !pl.lost);
				if (owner) {
					moveStackSpellToZone(state, item, 'exile');
				}
			}
			continue;
		}
		remainingStack.push(item);
	}
	state.stack = remainingStack;

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
	noteLayerInputsChanged(state);

	// 4. Handle permanents on the eliminated player's battlefield (CR 800.4a, 800.4c):
	// - First, any control-changing TimedContinuousEffects giving the eliminated player control end.
	// - Then, any foreign-owned permanents with an alive default controller return to that player
	//   (preserving defaultControllerId so syncBattlefieldControllers can re-apply any other Layer 2
	//   effects such as another alive player's Control Magic), and any remaining foreign permanents
	//   are exiled.
	// - Finally, all objects owned by the eliminated player leave the game, and controllers sync.
	if (state.timedContinuousEffects?.length) {
		const remaining = state.timedContinuousEffects.filter(
			(eff) => eff.layer2?.controllerId !== elimId
		);
		state.timedContinuousEffects = remaining.length > 0 ? remaining : undefined;
		noteLayerInputsChanged(state);
	}
	const leftBattlefieldIds = new Set<string>();
	for (const perm of [...eliminated.battlefield]) {
		if (perm.ownerId !== elimId) {
			const defaultCtrlId = perm.defaultControllerId ?? perm.ownerId;
			const defaultCtrl =
				defaultCtrlId !== elimId
					? state.players.find((pl) => pl.playerId === defaultCtrlId && !pl.lost)
					: undefined;
			if (defaultCtrl) {
				perm.controllerId = defaultCtrl.playerId;
				transferBattlefieldControl(perm, eliminated, defaultCtrl, state, {
					preserveDefaultController: true
				});
			} else {
				leftBattlefieldIds.add(perm.instanceId);
				const owner = state.players.find((pl) => pl.playerId === perm.ownerId && !pl.lost);
				if (owner) {
					movePermanentToZone(state, perm, 'exile');
				}
			}
		} else {
			leftBattlefieldIds.add(perm.instanceId);
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
		for (const c of other.battlefield) {
			if (c.ownerId === elimId) leftBattlefieldIds.add(c.instanceId);
		}
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
	}
	for (const other of state.players) {
		if (other.playerId === elimId) continue;
		for (const b of other.battlefield) {
			if (b.attachedToId && leftBattlefieldIds.has(b.attachedToId)) {
				b.attachedToId = null;
			}
		}
	}
	syncBattlefieldControllers(state);

	state.passedPriorityPlayerIds = state.passedPriorityPlayerIds.filter((id) => id !== elimId);

	// CR 726.4 / CR 800.4k: If the monarch leaves the game, the active player becomes the monarch
	// at the same time as that player leaves the game. If the active player is leaving the game (or
	// has already lost), the next living player in turn order becomes the monarch.
	const alive = state.players.filter((p) => !p.lost);
	if (state.monarchPlayerId === elimId) {
		const active = state.players[state.activePlayerIndex];
		let successor: PlayerGameState | undefined;
		if (active && !active.lost && active.playerId !== elimId) {
			successor = active;
		} else {
			const nPlayers = state.players.length;
			for (let step = 1; step <= nPlayers; step++) {
				const cand = state.players[(state.activePlayerIndex + step) % nPlayers];
				if (cand && !cand.lost && cand.playerId !== elimId) {
					successor = cand;
					break;
				}
			}
		}
		if (successor) {
			if (alive.length > 1 && state.status === 'active') {
				setMonarch(state, successor.playerId);
				state.passedPriorityPlayerIds = [];
			} else {
				state.monarchPlayerId = successor.playerId;
				noteLayerInputsChanged(state);
			}
		} else {
			state.monarchPlayerId = null;
			noteLayerInputsChanged(state);
		}
	}

	// 5. CR 800.4a / 800.4j: If the game continues (2+ alive players remain) and the eliminated
	// player held priority, pass priority to the next alive player in turn order (or resolve top
	// of stack / end phase if all remaining players had already passed priority). The turn
	// continues to completion without an active player if the active player left the game.
	if (alive.length > 1 && state.status === 'active') {
		const priorityPlayer = state.players[state.priorityPlayerIndex];
		if (priorityPlayer?.playerId === elimId) {
			const allAlivePassed =
				state.passedPriorityPlayerIds.length > 0 &&
				alive.every((p) => state.passedPriorityPlayerIds.includes(p.playerId));
			if (allAlivePassed) {
				state.passedPriorityPlayerIds = [];
				if (state.stack.length > 0) {
					resolveTopOfStack(state);
				} else {
					advancePhaseOrStep(state);
				}
			} else {
				advancePriorityToNextPlayer(state);
			}
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
	dest: ZoneType,
	sbaLog?: SbaMoveLog,
	moveOpts?: {
		skipLinkedReturn?: boolean;
		position?: 'top' | 'bottom';
		fromTop?: number;
	}
): MoveResult {
	inst.defaultControllerId = undefined;
	const owner = state.players.find((p) => p.playerId === inst.ownerId);
	return moveObject(state, inst, dest, {
		from: 'anyBattlefield',
		detachAttachments: true,
		graveyardReplacement: true,
		commanderRedirect: true,
		leaveBattlefieldReset: true,
		bumpVersion: true,
		newTimestamp: true,
		insert: (actual) =>
			actual === 'library'
				? computeLibraryInsertIndex(
						moveOpts?.fromTop,
						moveOpts?.position ?? 'top',
						owner?.library.length ?? 0
					)
				: 'end',
		ceaseToExist: 'tokens',
		sbaLog,
		...(moveOpts?.skipLinkedReturn ? { skipLinkedReturn: true } : {})
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

function sourceEffectiveQualities(
	state: GameState,
	sCard: ScryfallCard,
	sPerm?: CardInstance
): { colors: ManaColor[]; typeLine: string } {
	const evalSource =
		sPerm && sPerm.zone === 'battlefield' && !sPerm.phasedOut
			? evaluatePermanent(state, sPerm)
			: null;
	if (evalSource) {
		return {
			colors: sPerm!.isFaceDown ? [] : evalSource.colors,
			typeLine: evalSource.typeLine
		};
	}
	const offFace = resolveObjectFaces(sCard, sPerm ? instanceFaceOptions(sPerm) : undefined);
	return { colors: offFace.colors, typeLine: offFace.typeLine };
}

export function hasProtectionFrom(
	targetPerm: CardInstance,
	sourceCard: ScryfallCard | undefined,
	state: GameState,
	sourcePerm?: CardInstance
): boolean {
	if (!sourceCard || targetPerm.phasedOut) return false;
	const evalTarget = evaluatePermanent(state, targetPerm);
	const combined = evalTarget.activeKeywords.map((k) => k.toLowerCase()).join('\n');
	if (!combined.includes('protection from')) return false;

	const { colors: srcColors, typeLine: srcTypeLine } = sourceEffectiveQualities(
		state,
		sourceCard,
		sourcePerm
	);

	if (/protection from everything/i.test(combined)) return true;
	if (/protection from all colors/i.test(combined) && srcColors.length > 0) return true;
	if (/protection from multicolored/i.test(combined) && srcColors.length >= 2) return true;
	if (/protection from monocolored/i.test(combined) && srcColors.length === 1) return true;
	if (/protection from colorless/i.test(combined) && srcColors.length === 0) return true;
	if (/protection from [^.\n]*\bwhite\b/i.test(combined) && srcColors.includes('W')) return true;
	if (/protection from [^.\n]*\bblue\b/i.test(combined) && srcColors.includes('U')) return true;
	if (/protection from [^.\n]*\bblack\b/i.test(combined) && srcColors.includes('B')) return true;
	if (/protection from [^.\n]*\bred\b/i.test(combined) && srcColors.includes('R')) return true;
	if (/protection from [^.\n]*\bgreen\b/i.test(combined) && srcColors.includes('G')) return true;
	if (/protection from creatures/i.test(combined) && srcTypeLine.includes('Creature')) {
		return true;
	}
	if (/protection from instants/i.test(combined) && srcTypeLine.includes('Instant')) {
		return true;
	}
	if (/protection from sorceries/i.test(combined) && srcTypeLine.includes('Sorcery')) {
		return true;
	}
	if (/protection from artifacts/i.test(combined) && srcTypeLine.includes('Artifact')) {
		return true;
	}
	if (/protection from enchantments/i.test(combined) && srcTypeLine.includes('Enchantment')) {
		return true;
	}
	if (/protection from lands/i.test(combined) && srcTypeLine.includes('Land')) {
		return true;
	}
	if (/protection from planeswalkers/i.test(combined) && srcTypeLine.includes('Planeswalker')) {
		return true;
	}

	return false;
}

/** CR 702.11d: "Hexproof from [quality]" prevents spells/abilities with that quality controlled by an opponent from targeting this permanent. */
export function hasHexproofFromQuality(
	targetPerm: CardInstance,
	sourceCard: ScryfallCard | undefined,
	state: GameState,
	sourcePerm?: CardInstance
): boolean {
	if (!sourceCard || targetPerm.phasedOut) return false;
	const evalTarget = evaluatePermanent(state, targetPerm);
	const combined = evalTarget.activeKeywords.map((k) => k.toLowerCase()).join('\n');
	if (!combined.includes('hexproof from')) return false;

	const { colors: srcColors, typeLine: srcTypeLine } = sourceEffectiveQualities(
		state,
		sourceCard,
		sourcePerm
	);

	if (/hexproof from everything/i.test(combined)) return true;
	if (/hexproof from all colors/i.test(combined) && srcColors.length > 0) return true;
	if (/hexproof from multicolored/i.test(combined) && srcColors.length >= 2) return true;
	if (/hexproof from monocolored/i.test(combined) && srcColors.length === 1) return true;
	if (/hexproof from colorless/i.test(combined) && srcColors.length === 0) return true;
	if (/hexproof from [^.\n]*\bwhite\b/i.test(combined) && srcColors.includes('W')) return true;
	if (/hexproof from [^.\n]*\bblue\b/i.test(combined) && srcColors.includes('U')) return true;
	if (/hexproof from [^.\n]*\bblack\b/i.test(combined) && srcColors.includes('B')) return true;
	if (/hexproof from [^.\n]*\bred\b/i.test(combined) && srcColors.includes('R')) return true;
	if (/hexproof from [^.\n]*\bgreen\b/i.test(combined) && srcColors.includes('G')) return true;
	if (/hexproof from creatures/i.test(combined) && srcTypeLine.includes('Creature')) {
		return true;
	}
	if (/hexproof from instants/i.test(combined) && srcTypeLine.includes('Instant')) {
		return true;
	}
	if (/hexproof from sorceries/i.test(combined) && srcTypeLine.includes('Sorcery')) {
		return true;
	}
	if (/hexproof from artifacts/i.test(combined) && srcTypeLine.includes('Artifact')) {
		return true;
	}
	if (/hexproof from enchantments/i.test(combined) && srcTypeLine.includes('Enchantment')) {
		return true;
	}
	if (/hexproof from lands/i.test(combined) && srcTypeLine.includes('Land')) {
		return true;
	}
	if (/hexproof from planeswalkers/i.test(combined) && srcTypeLine.includes('Planeswalker')) {
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
					: kind === 'exile_card'
						? 'exile'
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

	// 1. Stack spell or ability target validation
	if (
		target.kind === 'stack' ||
		info.zone === 'stack' ||
		targetKind === 'spell' ||
		targetKind === 'stack'
	) {
		if (
			target.kind !== 'stack' &&
			(info.zone === 'stack' || targetKind === 'spell' || targetKind === 'stack')
		) {
			return {
				ok: false,
				error: 'Strict Rules Violation: This spell or ability must target an object on the Stack.'
			};
		}
		const inStack = state.stack.find(
			(s) => s.id === target.id || (s.kind === 'spell' && s.sourceInstanceId === target.id)
		);
		if (!inStack) return { ok: false, error: 'Target spell or ability is not on the Stack.' };
		const stackSpec = info.targetSpecs?.find(
			(s) =>
				s.kind === 'object' &&
				(s.filter.zone === 'stack' || targetKind === 'spell' || targetKind === 'stack')
		);
		const stackKind = info.stackKind ?? stackSpec?.filter.stackKind ?? 'spell';
		if (stackKind === 'spell' && inStack.kind !== 'spell') {
			return {
				ok: false,
				error: 'Strict Rules Violation: Target on the Stack is an ability, not a spell.'
			};
		}
		if (stackKind === 'ability' && inStack.kind !== 'activated' && inStack.kind !== 'triggered') {
			return {
				ok: false,
				error: 'Strict Rules Violation: Target on the Stack must be an activated or triggered ability.'
			};
		}
		if (stackKind === 'activatedAbility' && inStack.kind !== 'activated') {
			return {
				ok: false,
				error: 'Strict Rules Violation: Target on the Stack must be an activated ability.'
			};
		}
		if (stackKind === 'triggeredAbility' && inStack.kind !== 'triggered') {
			return {
				ok: false,
				error: 'Strict Rules Violation: Target on the Stack must be a triggered ability.'
			};
		}
		if (
			sourceInstanceId &&
			(inStack.id === sourceInstanceId ||
				(inStack.kind === 'spell' && inStack.sourceInstanceId === sourceInstanceId))
		) {
			return {
				ok: false,
				error: 'Strict Rules Violation: A spell or ability cannot target itself on the Stack.'
			};
		}
		if (info.controllerFilter === 'opponent' && inStack.controllerId === actorId) {
			return {
				ok: false,
				error: 'Strict Rules Violation: Must target a spell or ability controlled by an opponent.'
			};
		}
		if (info.controllerFilter === 'you' && inStack.controllerId !== actorId) {
			return {
				ok: false,
				error: 'Strict Rules Violation: Must target a spell or ability you control.'
			};
		}
		if (info.cardTypeFilter && inStack.kind === 'spell') {
			const stkTypes = resolveObjectFaces(inStack.card, stackItemFaceOptions(inStack)).types;
			const sType = stkTypes.join(' ');
			if (info.cardTypeFilter === 'Noncreature' && stkTypes.includes('Creature')) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is a Creature spell (requires a noncreature spell).`
				};
			}
			if (
				info.cardTypeFilter === 'Permanent' &&
				!stkTypes.some(
					(t) =>
						t === 'Creature' ||
						t === 'Artifact' ||
						t === 'Enchantment' ||
						t === 'Planeswalker' ||
						t === 'Battle'
				)
			) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is not a permanent spell.`
				};
			}
			if (info.cardTypeFilter === 'Creature' && !stkTypes.includes('Creature')) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is not a Creature spell.`
				};
			}
			if (
				info.cardTypeFilter === 'InstantOrSorcery' &&
				!stkTypes.includes('Instant') &&
				!stkTypes.includes('Sorcery')
			) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is not an Instant or Sorcery spell.`
				};
			}
			if (info.cardTypeFilter === 'Instant' && !stkTypes.includes('Instant')) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is not an Instant spell.`
				};
			}
			if (info.cardTypeFilter === 'Sorcery' && !stkTypes.includes('Sorcery')) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is not a Sorcery spell.`
				};
			}
			if (info.cardTypeFilter === 'Artifact' && !stkTypes.includes('Artifact')) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is not an Artifact spell.`
				};
			}
			if (info.cardTypeFilter === 'Enchantment' && !stkTypes.includes('Enchantment')) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} is not an Enchantment spell.`
				};
			}
			void sType;
		}
		if (
			inStack.kind === 'spell' &&
			stackSpec?.kind === 'object' &&
			stackSpec.filter.colors?.length
		) {
			const sColors = resolveObjectFaces(inStack.card, stackItemFaceOptions(inStack)).colors;
			if (!matchesColorFilter(sColors, stackSpec.filter.colors)) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${inStack.card.name} does not match the required spell color.`
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

	// 2b. Exile card target validation (CR 607.2a linked exile / exile-zone targets)
	if (target.kind === 'exile_card' || info.zone === 'exile' || targetKind === 'exile_card') {
		if (target.kind !== 'exile_card') {
			return {
				ok: false,
				error: 'Strict Rules Violation: This spell or ability must target a card in exile.'
			};
		}
		let foundOwner: PlayerGameState | undefined;
		let foundCard: CardInstance | undefined;
		for (const p of state.players) {
			const c = p.exile.find((x) => x.instanceId === target.id);
			if (c) {
				foundOwner = p;
				foundCard = c;
				break;
			}
		}
		if (!foundCard || !foundOwner) {
			return { ok: false, error: 'Target card is not in exile.' };
		}
		if (info.controllerFilter === 'you' && foundOwner.playerId !== actorId) {
			return { ok: false, error: 'Strict Rules Violation: Must target your card in exile.' };
		}
		if (info.controllerFilter === 'opponent' && foundOwner.playerId === actorId) {
			return { ok: false, error: "Strict Rules Violation: Must target an opponent's card in exile." };
		}
		const sourceInst = sourceInstanceId ? findCardAnywhere(state, sourceInstanceId)?.inst : undefined;
		const spec = info.targetSpecs?.[0];
		if (spec?.kind === 'object' && !matchesObjectFilter(foundCard, spec.filter, { state, controllerId: actorId, source: sourceInst })) {
			return {
				ok: false,
				error: `Strict Rules Violation: ${foundCard.card.name} does not match the exile target filter.`
			};
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
		const playerSpecs =
			info.targetSpecs?.filter((ts) => ts.kind === 'player' || ts.kind === 'objectOrPlayer') ?? [];
		const specRequiresOpponent =
			playerSpecs.length > 0 &&
			playerSpecs.every(
				(ts) => ts.player?.relation === 'opponent' || ts.player?.relation === 'each_opponent'
			);
		const specRequiresYou =
			playerSpecs.length > 0 && playerSpecs.every((ts) => ts.player?.relation === 'you');
		if ((info.controllerFilter === 'opponent' || specRequiresOpponent) && p.playerId === actorId) {
			return {
				ok: false,
				error: 'Strict Rules Violation: Must target an opponent.'
			};
		}
		if ((info.controllerFilter === 'you' || specRequiresYou) && p.playerId !== actorId) {
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
	if (
		found.controller.playerId !== actorId &&
		(hasKeyword(found.inst, 'Hexproof', state) ||
			hasHexproofFromQuality(found.inst, sourceCard, state))
	) {
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
			const isAuraSpell = Boolean(sourceCard?.typeLine.includes('Aura'));
			const matchesFilter = isAuraSpell
				? objectSpecs.every((ts) => matchesObjectFilter(found.inst, ts.filter, fctx))
				: objectSpecs.some((ts) => matchesObjectFilter(found.inst, ts.filter, fctx));
			if (!matchesFilter) {
				return {
					ok: false,
					error: `Strict Rules Violation: ${found.inst.card.name} is not a legal target.`
				};
			}
		}
	}

	return { ok: true };
}

function partitionTargetsBySpecs(
	targets: TargetRef[],
	info: TargetRequirementInfo,
	sourceCard?: ScryfallCard
): TargetRef[][] | undefined {
	if (sourceCard?.typeLine.includes('Aura')) return undefined;
	const specs = info.targetSpecs;
	if (!specs || specs.length === 0) return undefined;
	const counts = specs.map((sp) => (sp.max > 0 ? sp.min : 0));
	let extra = targets.length - counts.reduce((a, b) => a + b, 0);
	for (let k = 0; k < specs.length && extra > 0; k++) {
		if (specs[k].max <= 0) continue;
		const add = Math.min(extra, specs[k].max - counts[k]);
		if (add > 0) {
			counts[k] += add;
			extra -= add;
		}
	}
	let cursor = 0;
	return specs.map((_, k) => {
		const slice = targets.slice(cursor, cursor + counts[k]);
		cursor += counts[k];
		return slice;
	});
}

export function validateChosenTargets(
	state: GameState,
	actorId: string,
	targets: TargetRef[],
	info: TargetRequirementInfo,
	sourceCard?: ScryfallCard,
	sourceInstanceId?: string,
	xValue = 0,
	optionOrId?: CastOption | string
): { ok: boolean; error?: string } {
	if (optionTargetsBecomeEach(sourceCard, optionOrId)) {
		if (targets.length > 0) {
			return {
				ok: false,
				error: `Strict Rules Violation: ${sourceCard?.name || 'This spell'} changes 'target' to 'each' and cannot have targets (CR 702.96b).`
			};
		}
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
				optionOrId
			);
			if (res.ok) return { ok: true };
			if (res.error) lastErr = res.error;
		}
		return { ok: false, error: lastErr };
	}

	if (!info.requiresTarget && targets.length === 0) {
		return { ok: true };
	}
	if (!info.requiresTarget && info.maxTargets === 0 && targets.length > 0) {
		const copyFaceOpts =
			optionOrId && typeof optionOrId === 'object'
				? { zone: 'stack' as const, faceIndex: optionOrId.faceIndex ?? 0, fused: optionOrId.fused }
				: undefined;
		const allowsCopyHint =
			sourceCard &&
			activeAbilityDefs(sourceCard, copyFaceOpts).some(
				(ab) =>
					ab.kind === 'replacement' &&
					!Array.isArray(ab.replacement.with) &&
					ab.replacement.with.k === 'modify' &&
					Boolean(ab.replacement.with.copyOf)
			);
		if (!allowsCopyHint) {
			return {
				ok: false,
				error: `${sourceCard?.name || 'Spell or ability'} does not take any targets.`
			};
		}
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

	const activeSpecs = !sourceCard?.typeLine.includes('Aura')
		? info.targetSpecs?.filter((sp) => sp.max > 0)
		: undefined;
	if (activeSpecs && activeSpecs.length > 1) {
		const counts = activeSpecs.map((sp) => sp.min);
		let extra = targets.length - counts.reduce((a, b) => a + b, 0);
		for (let k = 0; k < activeSpecs.length && extra > 0; k++) {
			const add = Math.min(extra, activeSpecs[k].max - counts[k]);
			if (add > 0) {
				counts[k] += add;
				extra -= add;
			}
		}
		let cursor = 0;
		const seenInPriorSpecs = new Set<string>();
		for (let k = 0; k < activeSpecs.length; k++) {
			const spec = activeSpecs[k];
			const specTargets = targets.slice(cursor, cursor + counts[k]);
			cursor += counts[k];
			const uniqueInSpec = new Set(specTargets.map((t) => `${t.kind}:${t.id}`));
			if (uniqueInSpec.size !== specTargets.length) {
				return {
					ok: false,
					error: 'Strict Rules Violation: The same object cannot be chosen multiple times for the same target requirement (CR 115.3).'
				};
			}
			if (spec.otherTarget) {
				for (const t of specTargets) {
					if (seenInPriorSpecs.has(`${t.kind}:${t.id}`)) {
						return {
							ok: false,
							error: 'Strict Rules Violation: "Another target" must be a different object from earlier target(s) (CR 115.3).'
						};
					}
				}
			}
			const specInfo = targetRequirementFromSpecs([spec]);
			for (const t of specTargets) {
				const res = validateTargetLegality(state, actorId, t, specInfo, sourceCard, sourceInstanceId);
				if (!res.ok) return res;
				seenInPriorSpecs.add(`${t.kind}:${t.id}`);
			}
		}
	} else {
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

	if (info.zone === 'exile' || info.targetKind === 'exile_card') {
		for (const p of state.players) {
			for (const c of p.exile) {
				const ref: TargetRef = { kind: 'exile_card', id: c.instanceId, label: c.card.name };
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
	optionOrId?: CastOption | string
): { ok: boolean; error?: string } {
	return withStableLayerInputs(state, () =>
		hasRequiredLegalTargetsInner(
			state,
			actorId,
			info,
			sourceCard,
			sourceInstanceId,
			xValue,
			optionOrId
		)
	);
}

function hasRequiredLegalTargetsInner(
	state: GameState,
	actorId: string,
	info: TargetRequirementInfo,
	sourceCard?: ScryfallCard,
	sourceInstanceId?: string,
	xValue = 0,
	optionOrId?: CastOption | string
): { ok: boolean; error?: string } {
	if (!info.requiresTarget || info.minTargets <= 0) {
		return { ok: true };
	}

	if (optionTargetsBecomeEach(sourceCard, optionOrId)) {
		return { ok: true };
	}

	if (info.isModal && info.modalBranches && info.modalBranches.length > 0) {
		for (const branch of info.modalBranches) {
			if (
				hasRequiredLegalTargets(
					state,
					actorId,
					branch,
					sourceCard,
					sourceInstanceId,
					xValue,
					optionOrId
				).ok
			) {
				return { ok: true };
			}
		}
		return {
			ok: false,
			error: `Illegal Cast: No mode of ${sourceCard?.name || 'this spell'} has valid legal targets.`
		};
	}

	const activeSpecs = !sourceCard?.typeLine.includes('Aura')
		? info.targetSpecs?.filter((sp) => sp.max > 0)
		: undefined;
	if (activeSpecs && activeSpecs.length > 1) {
		for (const spec of activeSpecs) {
			if (spec.min <= 0) continue;
			const specInfo = targetRequirementFromSpecs([spec]);
			const res = hasRequiredLegalTargetsInner(
				state,
				actorId,
				specInfo,
				sourceCard,
				sourceInstanceId,
				xValue,
				optionOrId
			);
			if (!res.ok) return res;
		}
		return { ok: true };
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

	if (info.zone === 'exile' || info.targetKind === 'exile_card') {
		const allExileTargets = getAllLegalTargetsForRequirement(
			state,
			actorId,
			info,
			sourceCard,
			sourceInstanceId
		);
		if (allExileTargets.length < info.minTargets) {
			return {
				ok: false,
				error: `Illegal Cast: ${sourceCard?.name || 'Spell'} requires at least ${info.minTargets} valid target card(s) in exile.`
			};
		}
		return { ok: true };
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

/** Whether `actorId` may pass to end of turn (`end_turn`) right now. Read-only. */
export function checkEndTurnLegality(
	state: GameState,
	actorId: string
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
	const activePlayer = state.players[state.activePlayerIndex];
	if (!activePlayer || activePlayer.playerId !== actorId) {
		return { ok: false, error: 'You can only pass to end of turn during your own turn.' };
	}
	const priorityPlayer = state.players[state.priorityPlayerIndex];
	if (!priorityPlayer || priorityPlayer.playerId !== actorId) {
		return { ok: false, error: 'You must hold priority to pass to end of turn.' };
	}
	if (state.stack.length > 0) {
		return { ok: false, error: 'Resolve all spells and abilities on the Stack before ending your turn.' };
	}
	if (state.phase === 'cleanup') {
		return { ok: false, error: 'Already in the Cleanup Step.' };
	}
	const preCombatOrUnconfirmedAttackers =
		state.phase === 'upkeep' ||
		state.phase === 'draw' ||
		state.phase === 'main1' ||
		state.phase === 'begin_combat' ||
		isUnconfirmedAttackersStep(state);
	if (preCombatOrUnconfirmedAttackers) {
		const violation = findMandatoryAttackerViolation(state, activePlayer);
		if (violation) {
			return { ok: false, error: violation };
		}
	}
	return { ok: true };
}

/** Whether `actorId`'s draft attacker selection satisfies mandatory attack requirements right now. Read-only. */
export function checkMandatoryAttackersSatisfied(
	state: GameState,
	actorId: string,
	assignedAttackerIds: Iterable<string>
): { ok: boolean; error?: string } {
	const actor = state.players.find((p) => p.playerId === actorId);
	if (!actor || actor.lost) {
		return { ok: false, error: 'Player is not active in this game.' };
	}
	const violation = findMandatoryAttackerViolation(state, actor, new Set(assignedAttackerIds));
	if (violation) {
		return { ok: false, error: violation };
	}
	return { ok: true };
}

/** Whether `actorId` may play the land `inst` now. Read-only, one validation (Phase 6d). */
function resolveLandPlayFaceIndex(
	card: ScryfallCard,
	inst: CardInstance,
	fromZone: ZoneType,
	requestedFaceIndex?: number
): { ok: true; faceIndex: number } | { ok: false; error: string } {
	const def = compileCard(card);
	const exileAllowed = fromZone === 'exile' ? inst.playableFromExileBy?.allowedFaceIndices : undefined;
	if (requestedFaceIndex !== undefined) {
		const face = def.faces[requestedFaceIndex];
		if (!face || !face.characteristics.types.includes('Land')) {
			return { ok: false, error: `${card.name} does not have a Land face at index ${requestedFaceIndex}.` };
		}
		if (exileAllowed && !exileAllowed.includes(requestedFaceIndex)) {
			return {
				ok: false,
				error: `You do not have permission to play that face of ${card.name} from Exile.`
			};
		}
		return { ok: true, faceIndex: requestedFaceIndex };
	}
	const fi = def.faces.findIndex(
		(f, i) => f.characteristics.types.includes('Land') && (!exileAllowed || exileAllowed.includes(i))
	);
	if (fi < 0) {
		return { ok: false, error: `${card.name} is not a Land card.` };
	}
	return { ok: true, faceIndex: fi };
}

export function getLandPlayOptions(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: 'hand' | 'exile' | 'library' | 'graveyard' = 'hand'
): LandPlayOption[] {
	return withStableLayerInputs(state, () => {
		const card = effectiveCardForObject(inst);
		const def = compileCard(card);
		const out: LandPlayOption[] = [];
		for (let fi = 0; fi < def.faces.length; fi++) {
			const face = def.faces[fi];
			if (!face.characteristics.types.includes('Land')) continue;
			if (!checkLandPlayLegalityInner(state, actorId, inst, fromZone, fi).ok) continue;
			const view = resolveObjectFaces(card, { zone: fromZone, faceIndex: fi });
			out.push({
				faceIndex: fi,
				label: face.name,
				typeLine: view.typeLine,
				fromZone
			});
		}
		return out;
	});
}

export function checkLandPlayLegality(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: ZoneType = 'hand',
	faceIndex?: number
): { ok: boolean; error?: string } {
	return withStableLayerInputs(state, () =>
		checkLandPlayLegalityInner(state, actorId, inst, fromZone, faceIndex)
	);
}

function checkLandPlayLegalityInner(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: ZoneType = 'hand',
	faceIndex?: number
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
		if (inst.playableFromExileBy.spellsOnly) {
			return {
				ok: false,
				error: `${inst.card.name} may only be cast as a spell from Exile, not played as a land (CR 601.1a).`
			};
		}
	// --- Track P8 (CR 305.1, 401.5) ---
	} else if (fromZone === 'library') {
		if (actor.library[0]?.instanceId !== inst.instanceId) {
			return { ok: false, error: `${inst.card.name} is not the top card of your library.` };
		}
		if (!getActiveZoneLandPlayPermissionSource(state, actorId, 'library', inst)) {
			return {
				ok: false,
				error: `You do not have permission to play ${inst.card.name} from the top of your library.`
			};
		}
	} else if (fromZone === 'graveyard') {
		if (!actor.graveyard.some((c) => c.instanceId === inst.instanceId)) {
			return { ok: false, error: `${inst.card.name} is not in your graveyard.` };
		}
		if (!getActiveZoneLandPlayPermissionSource(state, actorId, 'graveyard', inst)) {
			return {
				ok: false,
				error: `You do not have permission to play ${inst.card.name} from your graveyard.`
			};
		}
	} else if (fromZone !== 'hand') {
		return { ok: false, error: 'Lands can only be played from your hand (or from Exile with an active play permission).' };
	}
	const resolvedFace = resolveLandPlayFaceIndex(effectiveCardForObject(inst), inst, fromZone, faceIndex);
	if (!resolvedFace.ok) {
		return resolvedFace;
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
		for (const ab of activeAbilityDefs(
			effectiveCardForObject(perm),
			instanceFaceOptions(perm, 'battlefield')
		)) {
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

function allocateFaceDownLabel(state: GameState): string {
	const next = (state.faceDownLabelAllocCounter ?? 0) + 1;
	state.faceDownLabelAllocCounter = next;
	return `Face-Down #${next}`;
}

function describeTurnUpCost(manaCost?: string, costDefs?: CostDef[]): string {
	const parts: string[] = [];
	if (manaCost) parts.push(manaCost);
	if (costDefs && costDefs.length > 0) parts.push(describeCost(costDefs));
	return parts.join(', ');
}

/**
 * CR 708.9: Reveals face-down permanents and spells to all players (when a player leaves the
 * game or at the end of a game).
 */
function revealFaceDownObjects(state: GameState, ownerFilterId?: string): void {
	for (const p of state.players) {
		for (const perm of p.battlefield) {
			if (!perm.isFaceDown) continue;
			if (ownerFilterId && perm.ownerId !== ownerFilterId) continue;
			const label = perm.faceDownLabel || 'Face-Down Permanent';
			perm.isFaceDown = false;
			perm.faceDownSpec = undefined;
			perm.faceDownLabel = undefined;
			addLog(
				state,
				'rule',
				`CR 708.9: ${label} is revealed as ${perm.card.name}.`,
				perm.controllerId
			);
		}
	}
	for (const item of state.stack) {
		if (!item.isFaceDown) continue;
		const itemOwnerId = item.ownerId || item.controllerId;
		if (ownerFilterId && itemOwnerId !== ownerFilterId) continue;
		const label = item.faceDownLabel || 'Face-Down Spell';
		item.isFaceDown = false;
		item.faceDownSpec = undefined;
		item.faceDownLabel = undefined;
		addLog(
			state,
			'rule',
			`CR 708.9: ${label} on the stack is revealed as ${item.card.name}.`,
			item.controllerId
		);
	}
	for (const p of state.players) {
		for (const ex of p.exile) {
			if (!ex.isFaceDown || !ex.foretoldByPlayerId) continue;
			if (ownerFilterId && ex.ownerId !== ownerFilterId) continue;
			const label = ex.faceDownLabel || 'Face-Down Card';
			ex.isFaceDown = false;
			ex.faceDownSpec = undefined;
			ex.faceDownLabel = undefined;
			addLog(
				state,
				'rule',
				`CR 702.143f: ${label} in exile is revealed as ${ex.card.name}.`,
				ex.ownerId
			);
		}
	}
}

/**
 * CR 701.27a–f / CR 712.10–12a: Transforms a double-faced permanent on the battlefield.
 */
export function transformPermanent(state: GameState, perm: CardInstance): boolean {
	if (!findPermanentOnBoard(state, perm.instanceId)) return false;
	// CR 712.12a: A double-faced permanent can't transform while it's face down.
	if (perm.isFaceDown) {
		addLog(
			state,
			'rule',
			`${perm.faceDownLabel || 'Face-Down Permanent'} can't transform while it is face down (CR 712.12a).`,
			perm.controllerId
		);
		return false;
	}
	const effCard = effectiveCardForObject(perm);
	const faces = getCardFaces(effCard);
	// CR 701.27d: Non-DFCs / non-transforming DFCs cannot transform; nothing happens.
	if (effCard.layout !== 'transform' || faces.length < 2) return false;
	const oldIdx = activeFaceIndexForObject(perm);
	const newTransformed = oldIdx === 0;
	const nextFaceIdx = newTransformed ? 1 : 0;
	// CR 701.27e: If the face the permanent would transform into is an instant or sorcery face, nothing happens.
	if (/\b(?:Instant|Sorcery)\b/.test(faces[nextFaceIdx]?.typeLine ?? '')) return false;
	const oldName = faces[oldIdx]?.name ?? effCard.name;
	const newName = faces[nextFaceIdx]?.name ?? effCard.name;
	perm.transformed = newTransformed;
	perm.activeFaceIndex = nextFaceIdx;
	noteLayerInputsChanged(state);
	addLog(
		state,
		'rule',
		`${oldName} transformed into ${newName} (CR 701.27a).`,
		perm.controllerId
	);
	emitEvent(state, {
		kind: 'Transformed',
		objectId: perm.instanceId,
		object: perm,
		toFaceIndex: perm.activeFaceIndex
	});
	flushTriggers(state);
	return true;
}

/**
 * CR 710.1–2: Flips a flip permanent on the battlefield to its flipped (second) half.
 * Once flipped, a permanent cannot flip back.
 */
export function flipPermanent(state: GameState, perm: CardInstance): boolean {
	if (!findPermanentOnBoard(state, perm.instanceId)) return false;
	if (perm.isFaceDown) return false;
	const effCard = effectiveCardForObject(perm);
	const faces = getCardFaces(effCard);
	if (effCard.layout !== 'flip' || faces.length < 2) return false;
	if (activeFaceIndexForObject(perm) !== 0) return false;
	const oldName = faces[0]?.name ?? effCard.name;
	const newName = faces[1]?.name ?? effCard.name;
	perm.activeFaceIndex = 1;
	noteLayerInputsChanged(state);
	addLog(
		state,
		'rule',
		`${oldName} flipped into ${newName} (CR 710.1).`,
		perm.controllerId
	);
	return true;
}

function hasXInTurnUpCost(manaCost?: string, costDefs?: CostDef[]): boolean {
	if (manaCost && /\{X\}/i.test(manaCost)) return true;
	if (!costDefs || costDefs.length === 0) return false;
	return JSON.stringify(costDefs).includes('"k":"x"');
}

function resolveTurnUpManaRequirement(
	manaCost: string | undefined,
	xValue: number
): ManaCostRequirement | null {
	if (manaCost === undefined) return null;
	return parseManaCost(manaCost, Math.max(0, xValue));
}

export interface TurnFaceUpDisplayInfo {
	costDisplay: string;
	choosesX: boolean;
	legal: boolean;
	error?: string;
}

export function getTurnFaceUpDisplay(
	state: GameState,
	actorId: string,
	perm: CardInstance
): TurnFaceUpDisplayInfo | null {
	if (!perm?.isFaceDown || !perm.faceDownSpec) return null;
	const spec = perm.faceDownSpec;
	if (spec.turnUpManaCost === undefined && (spec.turnUpCostDefs?.length ?? 0) === 0) {
		return null;
	}
	const costDisplay =
		describeTurnUpCost(spec.turnUpManaCost, spec.turnUpCostDefs) || spec.turnUpCost || '{0}';
	const choosesX = hasXInTurnUpCost(spec.turnUpManaCost, spec.turnUpCostDefs);
	const firstCheck = checkTurnFaceUpLegality(state, actorId, perm, 0);
	const check =
		!firstCheck.ok && choosesX ? checkTurnFaceUpLegality(state, actorId, perm, 1) : firstCheck;
	return {
		costDisplay,
		choosesX,
		legal: check.ok,
		...(check.error ? { error: check.error } : {})
	};
}

/**
 * Checks whether `actorId` may take the special action to turn `inst` face up (CR 116.2b, 708.7).
 */
export function checkTurnFaceUpLegality(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	xValue = 0,
	costPayment?: CostPayment
): { ok: boolean; error?: string } {
	return withStableLayerInputs(state, () => {
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
		if (inst.zone !== 'battlefield' || inst.controllerId !== actorId || inst.phasedOut) {
			return { ok: false, error: 'Permanent must be an active permanent you control on the battlefield.' };
		}
		if (!inst.isFaceDown) {
			return { ok: false, error: 'Permanent is already face up.' };
		}
		const spec = inst.faceDownSpec;
		const turnUpManaCost = spec?.turnUpManaCost;
		const turnUpCostDefs = spec?.turnUpCostDefs ?? [];
		if (!spec || (turnUpManaCost === undefined && turnUpCostDefs.length === 0)) {
			return { ok: false, error: 'This face-down permanent cannot be turned face up.' };
		}
		const priorityPlayer = state.players[state.priorityPlayerIndex];
		const pendingCombatErr = getPendingCombatDeclarationError(state);
		if (pendingCombatErr) {
			return { ok: false, error: pendingCombatErr };
		}
		if (priorityPlayer?.playerId !== actorId) {
			return { ok: false, error: 'You do not currently hold priority.' };
		}
		const choosesX = hasXInTurnUpCost(turnUpManaCost, turnUpCostDefs);
		const effectiveX = choosesX ? Math.max(0, xValue) : 0;
		const req = resolveTurnUpManaRequirement(turnUpManaCost, effectiveX);
		if (turnUpCostDefs.length > 0) {
			if (
				!canPayCosts(
					costContext(state, actor, inst, effectiveX, false, req, costPayment?.phyrexianLifeCount),
					turnUpCostDefs
				)
			) {
				return {
					ok: false,
					error: `You can't pay the turn-face-up cost (${describeTurnUpCost(turnUpManaCost, turnUpCostDefs)}).`
				};
			}
		} else if (req && !canPayOrAutoTap(actor, req, state, costPayment?.phyrexianLifeCount)) {
			return {
				ok: false,
				error: `Insufficient mana to turn ${inst.faceDownLabel || 'Face-Down Permanent'} face up (requires ${turnUpManaCost}).`
			};
		}
		return { ok: true };
	});
}

export function chooseBotTurnFaceUpPayment(
	state: GameState,
	player: PlayerGameState,
	perm: CardInstance,
	xValue = 0
): CostPayment | undefined {
	const spec = perm.faceDownSpec;
	const defs = spec?.turnUpCostDefs ?? [];
	if (defs.length === 0) return undefined;
	const req = resolveTurnUpManaRequirement(spec?.turnUpManaCost, xValue);
	return chooseCostPayment(costContext(state, player, perm, xValue, false, req), defs) ?? undefined;
}

function completeTurnFaceUp(
	state: GameState,
	actor: PlayerGameState,
	perm: CardInstance,
	xValue: number,
	descriptions: string[]
): void {
	const wasLabel = perm.faceDownLabel || 'Face-Down Permanent';
	const spec = perm.faceDownSpec;
	perm.isFaceDown = false;
	perm.faceDownSpec = undefined;
	perm.faceDownLabel = undefined;
	// CR 712.12a: Turning a face-down double-faced permanent face up leaves its front face up.
	perm.transformed = false;
	perm.activeFaceIndex = 0;
	noteLayerInputsChanged(state);
	state.passedPriorityPlayerIds = [];
	state.priorityUpdatedAt = Date.now();
	const costSuffix = descriptions.length > 0 ? ` (${descriptions.join(', ')})` : '';
	addLog(
		state,
		'rule',
		`${actor.username} turned ${wasLabel} face up as ${perm.card.name}${costSuffix} (CR 708.7).`,
		actor.playerId
	);
	if (spec?.kind === 'megamorph') {
		addCountersToPermanent(state, perm, '+1/+1', 1);
	}
	noteLayerInputsChanged(state);
	emitEvent(state, {
		kind: 'TurnedFaceUp',
		objectId: perm.instanceId,
		object: perm,
		playerId: actor.playerId,
		...(xValue > 0 ? { xValue } : {})
	});
	resetTriggerLoopTracking(state);
	flushTriggers(state);
	checkStateBasedActions(state);
}

function finalizeTurnFaceUp(
	state: GameState,
	actor: PlayerGameState,
	pcp: PendingCostPayment
): void {
	const perm = findPermanentOnBoard(state, pcp.sourceInstanceId)?.inst;
	if (!perm || !perm.isFaceDown) return;
	completeTurnFaceUp(state, actor, perm, pcp.xValue ?? 0, pcp.descriptions);
}

/**
 * Whether `actorId` may unlock the Room door at `faceIndex` on `inst` (CR 709.5e).
 */
export function checkUnlockRoomDoorLegality(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	faceIndex: number
): { ok: boolean; error?: string } {
	return withStableLayerInputs(state, () => {
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
		if (inst.zone !== 'battlefield' || inst.controllerId !== actorId || inst.phasedOut) {
			return { ok: false, error: 'Room must be an active permanent you control on the battlefield.' };
		}
		const activePlayer = state.players[state.activePlayerIndex];
		const priorityPlayer = state.players[state.priorityPlayerIndex];
		if (activePlayer?.playerId !== actorId) {
			return { ok: false, error: 'Room doors can only be unlocked on your turn at Sorcery speed.' };
		}
		if (priorityPlayer?.playerId !== actorId) {
			return { ok: false, error: 'You must hold priority to unlock a Room door.' };
		}
		if (state.phase !== 'main1' && state.phase !== 'main2') {
			return { ok: false, error: 'Room doors can only be unlocked during your Main Phase.' };
		}
		if (state.stack.length > 0) {
			return { ok: false, error: 'Room doors cannot be unlocked while the Stack is not empty.' };
		}
		const card = effectiveCardForObject(inst);
		const def = compileCard(card);
		const face = def.faces[faceIndex];
		if (def.layout !== 'split' || !face || !face.characteristics.subtypes.includes('Room')) {
			return { ok: false, error: `${card.name} does not have a Room door at face ${faceIndex}.` };
		}
		if ((inst.unlockedFaces ?? []).includes(faceIndex)) {
			return { ok: false, error: `${face.name} is already unlocked.` };
		}
		const costStr = face.characteristics.manaCost;
		if (!costStr) {
			return { ok: false, error: `${face.name} has no mana cost to unlock.` };
		}
		const req = parseManaCost(costStr);
		if (!canPayOrAutoTap(actor, req, state)) {
			return {
				ok: false,
				error: `Insufficient mana to unlock ${face.name} (requires ${costStr}).`
			};
		}
		return { ok: true };
	});
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
	optionId?: string,
	optionalCostCounts?: Record<string, number>,
	faceIndex?: number,
	fused?: boolean,
	costAidIds?: Record<string, string[]>,
	costAidColorChoices?: Record<string, ManaColor | 'generic'>,
	strictCostAids = false
): { ok: boolean; error?: string } {
	return withStableLayerInputs(state, () =>
		checkSpellCastLegalityInner(
			state,
			actorId,
			inst,
			fromZone,
			xValue,
			optionId,
			optionalCostCounts,
			faceIndex,
			fused,
			costAidIds,
			costAidColorChoices,
			strictCostAids
		)
	);
}

function checkSpellCastLegalityInner(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: ZoneType = 'hand',
	xValue = 0,
	optionId?: string,
	optionalCostCounts?: Record<string, number>,
	faceIndex?: number,
	fused?: boolean,
	costAidIds?: Record<string, string[]>,
	costAidColorChoices?: Record<string, ManaColor | 'generic'>,
	strictCostAids = false
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
	const resolved = resolveCastOptionForAction(
		state,
		actorId,
		inst,
		fromZone,
		optionId,
		faceIndex,
		fused
	);
	if (!resolved.ok) {
		return { ok: false, error: resolved.error };
	}
	return checkSpellCastOptionLegalityInner(
		state,
		actorId,
		inst,
		resolved.option.fromZone,
		xValue,
		resolved.option,
		optionalCostCounts,
		costAidIds,
		costAidColorChoices,
		strictCostAids
	);
}

function checkSpellCastOptionLegalityInner(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	fromZone: CastableSourceZone,
	xValue: number,
	option: CastOption,
	optionalCostCounts?: Record<string, number>,
	costAidIds?: Record<string, string[]>,
	costAidColorChoices?: Record<string, ManaColor | 'generic'>,
	strictCostAids = false
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

	const activePlayer = state.players[state.activePlayerIndex];
	const priorityPlayer = state.players[state.priorityPlayerIndex];
	const pendingCombatErr = getPendingCombatDeclarationError(state);
	if (pendingCombatErr) {
		return { ok: false, error: pendingCombatErr };
	}
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

	const isFaceDownCast = Boolean(option.spellMods?.castFaceDown);
	const castName = isFaceDownCast ? 'Face-Down Spell' : inst.card.name;
	const castFaceOpts = {
		zone: 'stack' as const,
		faceIndex: option.faceIndex ?? 0,
		fused: option.fused,
		...(option.spellMods?.prototyped ? { prototyped: true } : {}),
		...(option.spellMods?.castFaceDown
			? { isFaceDown: true, faceDownSpec: option.spellMods.castFaceDown }
			: {})
	};
	const effectiveCard = effectiveCardForObject(inst);
	const castChars = activeCharacteristics(effectiveCard, castFaceOpts);
	const castAbilities = activeAbilityDefs(effectiveCard, castFaceOpts);
	const hasFaceFlash =
		castAbilities.some((a) => {
			if (a.kind !== 'keyword') return false;
			const { name: kwName } = a.keyword;
			return kwName === 'flash';
		}) || Boolean(inst.grantedKeywords?.some((k) => k.toLowerCase() === 'flash'));
	const isInstantSpeed =
		option.timing !== 'sorcery_only' &&
		(option.timing === 'instant_only' ||
			(castChars.types.includes('Instant') && !castChars.types.includes('Sorcery')) ||
			hasFaceFlash ||
			globalCastCheck.grantsFlash);
	if (!isInstantSpeed) {
		if (activePlayer?.playerId !== actorId) {
			return {
				ok: false,
				error: `${castName} can only be cast on your turn at Sorcery speed.`
			};
		}
		if (state.phase !== 'main1' && state.phase !== 'main2') {
			return {
				ok: false,
				error: `${castName} can only be cast during your Main Phase (1 or 2).`
			};
		}
		if (state.stack.length > 0) {
			return {
				ok: false,
				error: `${castName} cannot be cast while spells/abilities are on the Stack.`
			};
		}
	}

	// Check timing restrictions from the IR
	const castRestrictions = isFaceDownCast
		? []
		: spellCastRestrictions(inst.card, option.faceIndex ?? 0, option.fused ?? false);
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
	const castManaCost = resolveObjectFaces(effectiveCard, castFaceOpts).manaCost;
	if (
		option.baseCost.kind === 'printed' &&
		castManaCost === '' &&
		!castChars.types.includes('Land')
	) {
		return {
			ok: false,
			error:
				fromZone === 'hand'
					? `${inst.card.name} has no mana cost and cannot be cast normally from hand (use Suspend instead).`
					: `${inst.card.name} has no mana cost and cannot be cast for its printed cost (CR 118.6).`
		};
	}
	const optCountsValidation = validateOptionalCostCounts(option, optionalCostCounts);
	if (!optCountsValidation.ok) {
		return { ok: false, error: optCountsValidation.error };
	}
	const normalizedOptCounts = optCountsValidation.normalized;
	const hasOptCounts = Object.keys(normalizedOptCounts).length > 0;
	const { nonManaDefs: extraNonManaDefs } = expandOptionalAdditionalCosts(option, normalizedOptCounts);
	const costReq = getSpellCostRequirementForOption(
		actor,
		inst,
		state,
		xValue,
		option,
		hasOptCounts ? normalizedOptCounts : undefined
	);
	const spendCtx = spellSpendContext(inst, {
		faceIndex: option.faceIndex,
		fused: option.fused,
		isFaceDown: Boolean(option.spellMods?.castFaceDown)
	});
	let effectiveManaReq = costReq;
	let reservedAidIds = new Set<string>();
	if (
		strictCostAids &&
		!(costReq.flexibleSymbols?.length && costAidIds && Object.keys(costAidIds).length > 0)
	) {
		const aidRes = applyCastCostAids(costReq, option, costAidIds, costAidColorChoices);
		if (!aidRes.ok) {
			return { ok: false, error: aidRes.error };
		}
		effectiveManaReq = aidRes.remainingReq;
		for (const id of aidRes.tapIds) reservedAidIds.add(id);
		for (const id of aidRes.exileIds) reservedAidIds.add(id);
		if (!canPayOrAutoTap(actor, effectiveManaReq, state, undefined, spendCtx, reservedAidIds)) {
			return {
				ok: false,
				error: `Insufficient mana to cast ${castName}.`
			};
		}
	} else {
		const manaAidCheck = canPayManaWithPaymentAids(
			state,
			actor,
			option,
			costReq,
			spendCtx
		);
		if (!manaAidCheck.ok) {
			return {
				ok: false,
				error: `Insufficient mana to cast ${castName}.`
			};
		}
		reservedAidIds = manaAidCheck.reservedAidIds;
	}
	// Phase 4: additional costs (plus any non-mana alternative costDefs and optional additional costs)
	// from the IR, together with the mana.
	const altCostDefs =
		option.baseCost.kind === 'alternative' ? (option.baseCost.costDefs ?? []) : [];
	const combinedCostDefs = [
		...altCostDefs,
		...(option.mandatoryAdditionalCosts ?? []),
		...extraNonManaDefs
	];
	if (
		combinedCostDefs.length > 0 &&
		!canPayCosts(
			costContext(
				state,
				actor,
				inst,
				xValue,
				true,
				effectiveManaReq,
				undefined,
				spendCtx,
				reservedAidIds.size > 0 ? reservedAidIds : undefined,
				strictCostAids
					? undefined
					: (req, resIds) => canPayManaWithPaymentAids(state, actor, option, req, spendCtx, undefined, resIds).ok
			),
			combinedCostDefs
		)
	) {
		return {
			ok: false,
			error: `Illegal Cast: you can't pay the additional cost of ${castName}.`
		};
	}

	// Check target legality (including multi-target & single-graveyard constraints)
	const spellCompiled = isFaceDownCast
		? null
		: compileSpellEffects(inst.card, option.faceIndex ?? 0, Boolean(option.fused));
	if (spellCompiled?.modal && !option.fused && !isFaceDownCast) {
		const activeSpec = (sp: TargetSpec) =>
			!sp.condition || isCastConditionMet(sp.condition, inst.card, normalizedOptCounts, option);
		const status = modalCandidateModeStatus(
			state,
			actorId,
			inst.card,
			inst,
			spellCompiled.modal,
			undefined,
			activeSpec
		);
		if (hasChooseAllModesOptionalCost(option, hasOptCounts ? normalizedOptCounts : undefined)) {
			if (status.legalModes.length < spellCompiled.modal.modes.length) {
				return {
					ok: false,
					error: `Illegal Cast: Choosing all modes of ${castName} requires every mode to have legal targets (CR 702.42b).`
				};
			}
			const spellTargetInfo = getSpellTargetRequirement(
				inst.card,
				option,
				hasOptCounts ? normalizedOptCounts : undefined
			);
			const targetCheck = hasRequiredLegalTargets(
				state,
				actorId,
				spellTargetInfo,
				inst.card,
				inst.instanceId,
				xValue,
				option
			);
			if (!targetCheck.ok) {
				return targetCheck;
			}
		} else if (!hasLegalModalCombination(spellCompiled.modal, status.legalModes)) {
			return {
				ok: false,
				error: `Illegal Cast: No valid mode combination of ${castName} has legal targets.`
			};
		}
	} else {
		const spellTargetInfo = getSpellTargetRequirement(
			inst.card,
			option,
			hasOptCounts ? normalizedOptCounts : undefined
		);
		const targetCheck = hasRequiredLegalTargets(
			state,
			actorId,
			spellTargetInfo,
			inst.card,
			inst.instanceId,
			xValue,
			option
		);
		if (!targetCheck.ok) {
			return targetCheck;
		}
	}

	return { ok: true };
}

function findActivatedAbilityTarget(
	state: GameState,
	actor: PlayerGameState,
	instanceId: string,
	abilityId: string
):
	| { ok: true; source: CardInstance; ability: EffectiveActivatedAbility }
	| { ok: false; error: string } {
	const bfPerm = actor.battlefield.find((c) => c.instanceId === instanceId);
	const handCard = bfPerm ? undefined : actor.hand.find((c) => c.instanceId === instanceId);
	const graveCard =
		bfPerm || handCard ? undefined : actor.graveyard.find((c) => c.instanceId === instanceId);
	const source = bfPerm ?? handCard ?? graveCard;
	if (!source) {
		return {
			ok: false,
			error: 'Card not found on your battlefield, in your hand, or in your graveyard.'
		};
	}
	if (source.zone === 'battlefield' && source.phasedOut) {
		return { ok: false, error: 'Permanent not found on your battlefield.' };
	}
	const cmdId = getPlayerCommanderIdentity(actor);
	const abilities = getEffectiveActivatedAbilities(state, actor, source, cmdId);
	const ab = abilities.find((a) => a.id === abilityId);
	if (!ab) {
		return {
			ok: false,
			error:
				source.zone === 'hand'
					? 'Ability not found on this card in hand.'
					: source.zone === 'graveyard'
						? 'Ability not found on this card in your graveyard.'
						: 'Ability not found on this permanent.'
		};
	}
	const allowedZones = ab.activationZones ?? ['battlefield'];
	if (!allowedZones.includes(source.zone)) {
		return {
			ok: false,
			error: `${source.card.name}: This ability cannot be activated from ${source.zone}.`
		};
	}
	return { ok: true, source, ability: ab };
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
	const actor = state.players.find((p) => p.playerId === actorId);
	if (!actor || actor.lost) {
		return { ok: false, error: 'Player is not active in this game.' };
	}
	const allowedZones = ab.activationZones ?? ['battlefield'];
	if (perm.zone === 'battlefield') {
		if (perm.phasedOut) {
			return { ok: false, error: `${perm.card.name} is phased out.` };
		}
		if (!actor.battlefield.some((c) => c.instanceId === perm.instanceId)) {
			return { ok: false, error: 'Permanent not found on your battlefield.' };
		}
		if (!allowedZones.includes('battlefield')) {
			return {
				ok: false,
				error: `${perm.card.name}: This ability cannot be activated from the battlefield.`
			};
		}
	} else if (perm.zone === 'hand') {
		if (!actor.hand.some((c) => c.instanceId === perm.instanceId)) {
			return { ok: false, error: 'Card not found in your hand.' };
		}
		if (!allowedZones.includes('hand')) {
			return {
				ok: false,
				error: `${perm.card.name}: This ability cannot be activated from your hand.`
			};
		}
	} else if (perm.zone === 'graveyard') {
		if (!actor.graveyard.some((c) => c.instanceId === perm.instanceId)) {
			return { ok: false, error: 'Card not found in your graveyard.' };
		}
		if (!allowedZones.includes('graveyard')) {
			return {
				ok: false,
				error: `${perm.card.name}: This ability cannot be activated from your graveyard.`
			};
		}
	} else {
		return {
			ok: false,
			error: `${perm.card.name}: This ability cannot be activated from ${perm.zone}.`
		};
	}

	const effectiveAbs = getEffectiveActivatedAbilities(
		state,
		actor,
		perm,
		getPlayerCommanderIdentity(actor)
	);
	if (!effectiveAbs.some((a) => a.id === ab.id)) {
		if (perm.zone === 'battlefield') {
			const abilityLoss = permanentHasLostAllAbilities(perm, state);
			if (abilityLoss.lost) {
				return {
					ok: false,
					error: `${perm.card.name} has lost all abilities (${abilityLoss.sources[0] || 'continuous effect'}).`
				};
			}
		}
		return { ok: false, error: `Ability not found on ${perm.card.name}.` };
	}

	// CR 101.2, 602.5a–b, 604.1: Global rule-modifying & static ability-activation restrictions.
	const globalAbCheck = checkGlobalAbilityActivationRestrictions(
		state,
		actorId,
		perm,
		ab.isManaAbility
	);
	if (!globalAbCheck.ok) {
		return globalAbCheck;
	}

	// Phase 4: the whole cost from the IR ({T}/{Q} with summoning sickness, sacrifices, discards,
	// "tap N untapped ...", life, counters and mana), checked by runtime/costs.ts.
	const abilityMana = effectiveAbilityManaCost(
		state,
		actorId,
		ab.id,
		ab.manaCost,
		ab.costKeyword
	).requirement;
	const abilityCost = activatedAbilityCost(perm.card, ab);
	const costCtx = costContext(state, actor, perm, 0, false, abilityMana);
	const checkCost = (): { ok: boolean; error?: string } => {
		if (canPayCosts(costCtx, abilityCost.defs)) return { ok: true };
		const plan = planCosts(costCtx, abilityCost.defs);
		return { ok: false, error: plan.ok ? `You can't pay the cost of ${perm.card.name}'s ability.` : plan.error };
	};

	const activePlayer = state.players[state.activePlayerIndex];

	// CR 602.5b / 602.5c: Enforce activation restrictions ("Activate only ...").
	if (
		ab.activationCondition &&
		!evaluateCondition(ab.activationCondition, { state, controllerId: actorId, source: perm })
	) {
		return {
			ok: false,
			error: `${perm.card.name}: Activation condition is not met.`
		};
	}
	const restrictions = ab.activationRestrictions;
	if (restrictions?.length) {
		if (restrictions.includes('onceEachTurn') && perm.activatedAbilityIdsThisTurn?.includes(ab.id)) {
			return {
				ok: false,
				error: `${perm.card.name}: This ability can only be activated once each turn.`
			};
		}
		if (restrictions.includes('duringYourTurn') && activePlayer?.playerId !== actorId) {
			return {
				ok: false,
				error: `${perm.card.name}: This ability can only be activated during your turn.`
			};
		}
		if (
			restrictions.includes('duringYourUpkeep') &&
			(activePlayer?.playerId !== actorId || state.phase !== 'upkeep')
		) {
			return {
				ok: false,
				error: `${perm.card.name}: This ability can only be activated during your upkeep.`
			};
		}
		if (
			restrictions.includes('duringCombat') &&
			!(
				state.phase === 'begin_combat' ||
				state.phase === 'declare_attackers' ||
				state.phase === 'declare_blockers' ||
				state.phase === 'first_strike_damage' ||
				state.phase === 'combat_damage' ||
				state.phase === 'end_combat'
			)
		) {
			return {
				ok: false,
				error: `${perm.card.name}: This ability can only be activated during combat.`
			};
		}
	}

	if (ab.isManaAbility) {
		return checkCost();
	}

	const pendingCombatErr = getPendingCombatDeclarationError(state);
	if (pendingCombatErr) {
		return { ok: false, error: pendingCombatErr };
	}

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

	const abModal =
		ab.modal ?? getAbilityModal(perm.card, ab.id, ab.faceIndex ?? 0, ab.grantSourceCard);
	if (abModal) {
		const status = modalCandidateModeStatus(
			state,
			actorId,
			perm.card,
			perm,
			abModal,
			perm.usedModalModesThisTurn
		);
		if (!hasLegalModalCombination(abModal, status.legalModes)) {
			return {
				ok: false,
				error: `${perm.card.name}: No legal mode combination is available.`
			};
		}
	} else if (ab.requiresTarget) {
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
		} else if (t.kind === 'exile_card') {
			for (const p of state.players) {
				const found = p.exile.find((c) => c.instanceId === t.id);
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
		const stk = state.stack.find(
			(s) => s.id === target.id || (s.kind === 'spell' && s.sourceInstanceId === target.id)
		);
		if (!stk) return false;
		if (
			expectedVersion !== undefined &&
			stk.kind === 'spell' &&
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
	if (target.kind === 'exile_card') {
		let foundCard: CardInstance | undefined;
		for (const p of state.players) {
			const c = p.exile.find((x) => x.instanceId === target.id);
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
		(hasKeyword(found.inst, 'Hexproof', state) ||
			hasHexproofFromQuality(found.inst, sourceCard, state))
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
			targetInfo = getSpellTargetRequirement(
				(sourceCard ?? item.card)!,
				{ faceIndex: item.faceIndex, fused: item.fused } as CastOption,
				item.optionalCostCounts
			);
		} else if (item.kind === 'activated' && item.abilityId && (sourceCard || item.card)) {
			const faceOpts =
				item.faceIndex !== undefined
					? { zone: 'battlefield' as const, faceIndex: item.faceIndex }
					: undefined;
			const ab = getCardActivatedAbilities((sourceCard ?? item.card)!, [], undefined, faceOpts).find(
				(a) => a.id === item.abilityId
			);
			targetInfo = ab?.targetInfo;
			if (!targetInfo) {
				const comp = compiledStackItemEffects(item);
				if (comp) targetInfo = targetRequirementFromSpecs(comp.targets);
			}
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
			const itemKicker = getObjectKickerInfo(state, item.card, item.sourceInstanceId, item);
			const activeCompiledTargets = compiled.targets.filter(
				(ts) => !ts.condition || isConditionMetWithKicker(ts.condition, itemKicker)
			);
			const objectSpecs = activeCompiledTargets.filter(
				(ts) => ts.kind === 'object' || ts.kind === 'objectOrPlayer'
			);
			if (objectSpecs.length > 0) {
				const sourceInst = findPermanentOnBoard(state, item.sourceInstanceId)?.inst;
				const fctx: FilterContext = {
					state,
					controllerId: controllerId || item.controllerId,
					source: sourceInst,
					stackItem: item,
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

/**
 * Purposes whose candidate lists and descriptions are already public on the table:
 * - `trigger_targets`: target candidates on the battlefield (CR 603.3d).
 * - `trigger_order`: triggered ability items already placed on the stack (CR 603.3b).
 * All other purposes default to redacted for non-viewing players.
 */
const PUBLIC_PROMPT_PURPOSES: ReadonlySet<PromptPurpose> = new Set<PromptPurpose>([
	'trigger_modes',
	'trigger_targets',
	'trigger_order'
]);

function isPublicPromptForOpponent(pr: PendingPrompt): boolean {
	const purpose = effectivePromptPurpose(pr);
	if (!PUBLIC_PROMPT_PURPOSES.has(purpose)) return false;
	if (purpose === 'trigger_targets') {
		return !pr.choice || (pr.choice.kind === 'chooseObjects' && pr.choice.zone === 'battlefield');
	}
	return true;
}

function redactChoiceForOpponent(choice: ChoiceRequest): ChoiceRequest {
	switch (choice.kind) {
		case 'yesNo':
			return { kind: 'yesNo', question: 'Opponent is choosing…' };
		case 'chooseObjects':
			return {
				kind: 'chooseObjects',
				candidates: [],
				min: choice.min,
				max: choice.max,
				zone: choice.zone,
				reason: 'Opponent is choosing…'
			};
		case 'chooseMode':
			return {
				kind: 'chooseMode',
				modes: [],
				min: choice.min,
				max: choice.max,
				...(choice.allowRepeat ? { allowRepeat: true } : {})
			};
		case 'chooseNumber':
			return {
				kind: 'chooseNumber',
				min: choice.min,
				max: choice.max,
				reason: 'Opponent is choosing…'
			};
		case 'orderObjects':
			return {
				kind: 'orderObjects',
				objectIds: [],
				...(choice.allowSplitBottom !== undefined
					? { allowSplitBottom: choice.allowSplitBottom }
					: {}),
				...(choice.allowShuffle !== undefined ? { allowShuffle: choice.allowShuffle } : {}),
				reason: 'Opponent is choosing…'
			};
		case 'chooseReplacement':
			return { kind: 'chooseReplacement', options: [] };
	}
}

function redactPromptForOpponent(pr: PendingPrompt): PendingPrompt {
	if (isPublicPromptForOpponent(pr)) {
		return {
			id: pr.id,
			playerId: pr.playerId,
			kind: pr.kind,
			...(pr.purpose !== undefined ? { purpose: pr.purpose } : {}),
			title: pr.title,
			description: pr.description,
			...(pr.choice !== undefined ? { choice: pr.choice } : {}),
			...(pr.triggerStackItemId !== undefined
				? { triggerStackItemId: pr.triggerStackItemId }
				: {}),
			...(pr.triggerTargetSpecIndex !== undefined
				? { triggerTargetSpecIndex: pr.triggerTargetSpecIndex }
				: {})
		};
	}
	return {
		id: pr.id,
		playerId: pr.playerId,
		kind: pr.kind,
		...(pr.purpose !== undefined ? { purpose: pr.purpose } : {}),
		title: pr.title,
		description: 'Opponent is choosing…',
		...(pr.choice !== undefined ? { choice: redactChoiceForOpponent(pr.choice) } : {}),
		...(pr.triggerStackItemId !== undefined
			? { triggerStackItemId: pr.triggerStackItemId }
			: {})
	};
}

function scrubFaceDownInstance(
	inst: CardInstance,
	zone: 'battlefield' | 'exile',
	viewerId: string | null
): void {
	if (!inst.isFaceDown) return;
	// CR 708.5: controller and knownToPlayerIds may look at face-down permanents on the battlefield.
	// CR 406.3: face-down exiled cards may only be looked at by players explicitly listed in knownToPlayerIds.
	const known = Boolean(
		viewerId !== null &&
			(inst.knownToPlayerIds?.includes(viewerId) ||
				inst.faceDownSpec?.knownToPlayerIds?.includes(viewerId))
	);
	const canSee =
		zone === 'battlefield' ? (viewerId !== null && viewerId === inst.controllerId) || known : known;
	if (canSee) return;

	delete inst.printedCard;
	delete inst.copiableCard;
	delete inst.copiableState;
	inst.transformed = false;
	delete inst.activeFaceIndex;
	delete inst.unlockedFaces;
	if (inst.faceDownSpec) {
		delete inst.faceDownSpec.turnUpCost;
		delete inst.faceDownSpec.turnUpManaCost;
		delete inst.faceDownSpec.turnUpCostDefs;
	}
	const label =
		inst.faceDownLabel || (zone === 'battlefield' ? 'Face-Down Creature' : 'Face-Down Card');
	inst.card = scrubFaceDownCard(label, zone, inst.faceDownSpec);
}

export function sanitizeGameStateForViewer(state: GameState, viewerId: string | null): GameState {
	// --- Track P8 (CR 401.5): Capture mid-cast/activation flag before deleting pendingCostPayment ---
	const midCastOrActivation = Boolean(state.pendingCostPayment);
	const clone: GameState = JSON.parse(JSON.stringify(state));
	delete clone.rngState;
	delete clone.nextUid;
	delete clone.idSalt;
	delete clone.pendingTriggers;
	delete clone.pendingCostPayment;
	delete clone.pendingProcedure;

	for (const item of clone.stack) {
		delete item.effectResume;
		scrubFaceDownStackItem(item, viewerId);
		if (item.triggerEventStackItem) {
			scrubFaceDownStackItem(item.triggerEventStackItem, viewerId);
		}
	}

	const activeHandCandidateIds = new Set<string>();
	if (viewerId !== null) {
		for (const pr of clone.pendingPrompts) {
			if (
				pr.playerId === viewerId &&
				pr.choice?.kind === 'chooseObjects' &&
				pr.choice.zone === 'hand'
			) {
				for (const cid of pr.choice.candidates) activeHandCandidateIds.add(cid);
			}
		}
	}

	for (const p of clone.players) {
		p.handCount = p.hand.length;
		p.libraryCount = p.library.length;
		if (p.playerId !== viewerId) {
			// Hide opponent hand contents unless revealed to viewerId (CR 701.20a) or referenced by an active hand choice prompt
			p.hand =
				viewerId === null
					? []
					: p.hand.filter(
							(c) =>
								Boolean(c.knownToPlayerIds?.includes(viewerId)) ||
								activeHandCandidateIds.has(c.instanceId)
						);
		}
		for (const perm of p.battlefield) {
			scrubFaceDownInstance(perm, 'battlefield', viewerId);
		}
		for (const ex of p.exile) {
			scrubFaceDownInstance(ex, 'exile', viewerId);
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
			// --- Track P8 (CR 401.5): Top-of-library look / reveal visibility ---
			const topVis = getPlayerTopOfLibraryVisibility(state, p.playerId);
			if (topVis.revealToAll) {
				p.library = p.library.slice(0, 1);
			} else if (
				topVis.lookByController &&
				viewerId === p.playerId &&
				!midCastOrActivation
			) {
				p.library = p.library.slice(0, 1);
			} else {
				p.library = [];
			}
		}
	}

	if (clone.pendingZoneMoves) {
		clone.pendingZoneMoves = clone.pendingZoneMoves.filter((c) => {
			if (c.isFaceDown) return false;
			const promptCont = state.pendingPrompts.find(
				(pr) =>
					pr.continuation?.kind === 'handler' &&
					pr.continuation.data?.objectId === c.instanceId
			)?.continuation;
			const promptData = promptCont?.kind === 'handler' ? promptCont.data : undefined;
			const originZone = (promptData?.fromZone as ZoneType | undefined) ?? c.zone;
			const originPlayerId =
				(promptData?.fromPlayerId as string | undefined) ?? c.ownerId ?? c.controllerId;
			if (
				originZone === 'hand' &&
				originPlayerId !== viewerId &&
				!(viewerId !== null && c.knownToPlayerIds?.includes(viewerId))
			) {
				return false;
			}
			if (originZone === 'library') {
				const isSearchingOriginLibrary =
					viewerId !== null &&
					state.pendingPrompts.some(
						(pr) =>
							pr.playerId === viewerId &&
							(effectivePromptPurpose(pr) === 'search_library' ||
								(pr.choice?.kind === 'chooseObjects' && pr.choice.zone === 'library')) &&
							(pr.targetLibraryOwnerId || pr.playerId) === originPlayerId
					);
				if (!isSearchingOriginLibrary) return false;
			}
			return true;
		});
		if (clone.pendingZoneMoves.length === 0) {
			delete clone.pendingZoneMoves;
		}
	}

	clone.pendingPrompts = clone.pendingPrompts.map((pr) => {
		if (pr.playerId === viewerId) {
			if (pr.stackItem) {
				delete pr.stackItem.effectResume;
				scrubFaceDownStackItem(pr.stackItem, viewerId);
			}
			return pr;
		}
		return redactPromptForOpponent(pr);
	});

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
		const attackingPlaneswalker = Boolean(atk.defenderPlaneswalkerId);
		const defWalkerFound =
			atk.defenderPlaneswalkerId && atk.defenderPlaneswalkerId !== 'removed'
				? findPermanentOnBoard(state, atk.defenderPlaneswalkerId)
				: null;
		const defWalker =
			defWalkerFound &&
			defWalkerFound.controller.playerId === atk.defenderPlayerId &&
			!defWalkerFound.inst.phasedOut &&
			evaluatePermanent(state, defWalkerFound.inst).isPlaneswalker
				? defWalkerFound.inst
				: null;

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
			} else if (defPlayer && !attackingPlaneswalker) {
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
				} else if (defPlayer && !attackingPlaneswalker) {
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
