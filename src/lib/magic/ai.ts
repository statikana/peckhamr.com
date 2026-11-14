import { compileSpellEffects } from './compiler/index.ts';
import { effectiveCardForObject } from './scryfall.ts';
import {
	activeAbilityDefs,
	activeCharacteristics,
	instanceFaceOptions
} from './runtime/faces.ts';
import {
	addLog,
	applyGameAction,
	checkAbilityActivationLegality,
	checkSpellCastLegality,
	checkTurnFaceUpLegality,
	chooseBotAttackAssignments,
	chooseBotBlockAssignments,
	chooseBotSpellCostPayment,
	chooseBotTurnFaceUpPayment,
	evaluatePermanent,
	getCastOptions,
	getCreaturePower,
	getCreatureToughness,
	getEffectiveActivatedAbilities,
	getLandPlayOptions,
	getPlayerCommanderIdentity,
	getSpellTargetRequirement,
	getTurnFaceUpDisplay,
	hasKeyword,
	specTargetCandidates
} from './engine.ts';
import type { EffectStep, RestrictionKind, TargetSpec } from './ir.ts';
import { chooseBotAnswer, effectivePromptChoice, effectivePromptPurpose } from './runtime/choices.ts';
import { withStableLayerInputs } from './runtime/layerCache.ts';
import { evaluateCondition, matchesObjectFilter } from './runtime/objectFilter.ts';
import type {
	BotSpeed,
	CardInstance,
	CastOption,
	ChoiceAnswer,
	GamePhase,
	GameState,
	PendingPrompt,
	PlayerGameState,
	ScryfallCard,
	StackItem,
	TargetRef
} from './types.ts';

/**
 * Whether `perm` currently has any of `restriction` active on the battlefield, from its own
 * compiled static abilities (unless it has lost all abilities or is face down), from an attached
 * Aura/Equipment, or from another active permanent's static restriction filter.
 */
export function hasRestriction(
	state: GameState,
	perm: CardInstance,
	restriction: RestrictionKind | RestrictionKind[]
): boolean {
	// Read-only: one layer-cache validation for the whole scan (Phase 6d).
	return withStableLayerInputs(state, () => hasRestrictionInner(state, perm, restriction));
}

function hasRestrictionInner(
	state: GameState,
	perm: CardInstance,
	restriction: RestrictionKind | RestrictionKind[]
): boolean {
	const kinds = Array.isArray(restriction) ? restriction : [restriction];
	for (const player of state.players) {
		if (player.lost) continue;
		for (const source of player.battlefield) {
			if (source.phasedOut || source.isFaceDown) continue;
			if (evaluatePermanent(state, source).losesAllAbilities) continue;
			const card = effectiveCardForObject(source);
			const ctx = {
				state,
				controllerId: source.controllerId || player.playerId,
				source
			};
			for (const ab of activeAbilityDefs(card, instanceFaceOptions(source, 'battlefield'))) {
				if (ab.kind !== 'static' || ab.static.k !== 'restriction') continue;
				const def = ab.static;
				if (!kinds.includes(def.restriction)) continue;
				const affected =
					def.affected === 'self'
						? source.instanceId === perm.instanceId
						: def.affected === 'attachedTo'
							? source.attachedToId === perm.instanceId
							: matchesObjectFilter(perm, def.affected, ctx);
				if (!affected) continue;
				if (def.condition && !evaluateCondition(def.condition, ctx)) continue;
				return true;
			}
		}
	}
	return false;
}

function cardSpellSteps(card: ScryfallCard, faceIndex = 0, fused = false): EffectStep[] {
	const abilities = fused
		? [
				...activeAbilityDefs(card, { zone: 'stack', faceIndex: 0 }),
				...activeAbilityDefs(card, { zone: 'stack', faceIndex: 1 })
			]
		: activeAbilityDefs(card, { zone: 'stack', faceIndex });
	const parsed = compileSpellEffects(card, faceIndex, fused);
	return [
		...abilities.flatMap((a) =>
			a.kind === 'spell' ? [...a.effect, ...(a.modal?.modes.flatMap((m) => m.effect) ?? [])] : []
		),
		...(parsed?.steps ?? []),
		...(parsed?.modal?.modes.flatMap((m) => m.effect) ?? [])
	];
}

function isCounterSpellCard(card: ScryfallCard, faceIndex = 0, fused = false): boolean {
	return cardSpellSteps(card, faceIndex, fused).some((s) => s.verb === 'counterSpell');
}

function isProtectionTrickCard(card: ScryfallCard, faceIndex = 0, fused = false): boolean {
	const types = activeCharacteristics(card, { zone: 'stack', faceIndex }).types;
	if (!types.includes('Instant')) return false;
	return cardSpellSteps(card, faceIndex, fused).some((s) => {
		if (s.verb !== 'grant') return false;
		const kws = (s.params?.keywords ?? []).map((k) => k.toLowerCase());
		return kws.includes('hexproof') && kws.includes('indestructible');
	});
}

function isCreatureBoardWipeCard(card: ScryfallCard, faceIndex = 0, fused = false): boolean {
	return cardSpellSteps(card, faceIndex, fused).some(
		(s) =>
			(s.verb === 'destroy' || s.verb === 'exile') &&
			s.subject.k === 'all' &&
			Boolean(s.subject.filter.types?.includes('Creature')) &&
			!s.subject.filter.controller
	);
}

function cardSpellTargetSpec(card: ScryfallCard, faceIndex = 0): TargetSpec | undefined {
	for (const ab of activeAbilityDefs(card, { zone: 'stack', faceIndex })) {
		if (ab.kind === 'spell' && ab.targets.length > 0) return ab.targets[0];
		if (ab.kind === 'keyword') {
			const { name: kwName, enchantFilter } = ab.keyword;
			if (kwName === 'enchant' && enchantFilter) {
				return { kind: 'object', filter: { zone: 'battlefield', ...enchantFilter }, min: 1, max: 1 };
			}
		}
		if (ab.kind === 'unsupported' && ab.id === 'cast' && ab.targets && ab.targets.length > 0) {
			return ab.targets[0];
		}
	}
	return undefined;
}

function chooseBotModalSpell(
	state: GameState,
	bot: PlayerGameState,
	cardInst: CardInstance,
	faceIndex = 0,
	fused = false
): { modes: number[]; targets: TargetRef[] } | null {
	const modal = compileSpellEffects(cardInst.card, faceIndex, fused)?.modal;
	if (!modal) return null;
	const modes: number[] = [];
	const targets: TargetRef[] = [];
	const ownerOf = (t: TargetRef): string | undefined => {
		if (t.kind === 'player') return t.id;
		for (const p of state.players) {
			if (p.battlefield.some((c) => c.instanceId === t.id)) {
				return p.battlefield.find((c) => c.instanceId === t.id)!.controllerId;
			}
			if (p.graveyard.some((c) => c.instanceId === t.id)) return p.playerId;
		}
		return undefined;
	};
	for (let i = 0; i < modal.modes.length && modes.length < modal.max; i++) {
		const mode = modal.modes[i];
		if (mode.targets.length === 0) {
			modes.push(i);
			continue;
		}
		const modeTargets: TargetRef[] = [];
		let ok = true;
		for (let sIdx = 0; sIdx < mode.targets.length; sIdx++) {
			const spec = mode.targets[sIdx];
			const harmful = targetIsHarmed(mode.effect, sIdx);
			const legal = specTargetCandidates(state, bot.playerId, cardInst.card, cardInst, spec).filter(
				(t) => (ownerOf(t) === bot.playerId) !== harmful
			);
			const chosen = chooseBotTriggerTargets(state, bot, mode.effect, sIdx, spec, legal);
			if (chosen.length < spec.min) {
				ok = false;
				break;
			}
			modeTargets.push(...chosen);
		}
		if (ok) {
			modes.push(i);
			targets.push(...modeTargets);
		}
	}
	if (modes.length < modal.min) return null;
	return { modes, targets };
}

export function hasAnyLegalInstantResponse(state: GameState, player: PlayerGameState): boolean {
	// Read-only (Phase 6d).
	return withStableLayerInputs(state, () => hasAnyLegalInstantResponseInner(state, player));
}

function hasAnyLegalInstantResponseInner(state: GameState, player: PlayerGameState): boolean {
	const cmdId = getPlayerCommanderIdentity(player);
	for (const cardInst of player.hand) {
		const handAbs = getEffectiveActivatedAbilities(state, player, cardInst, cmdId).filter(
			(ab) => !ab.isManaAbility && Boolean(ab.activationZones?.includes('hand'))
		);
		for (const ab of handAbs) {
			if (checkAbilityActivationLegality(state, player.playerId, cardInst, ab).ok) {
				return true;
			}
		}
		if (getCastOptions(state, player.playerId, cardInst, 'hand').length > 0) {
			return true;
		}
	}
	for (const cmdInst of player.command) {
		if (getCastOptions(state, player.playerId, cmdInst, 'command').length > 0) {
			return true;
		}
	}
	for (const gyInst of player.graveyard) {
		if (getCastOptions(state, player.playerId, gyInst, 'graveyard').length > 0) {
			return true;
		}
	}
	for (const perm of player.battlefield) {
		if (perm.phasedOut) continue;
		if (getTurnFaceUpDisplay(state, player.playerId, perm)?.legal) {
			return true;
		}
		const abilities = getEffectiveActivatedAbilities(state, player, perm, cmdId);
		for (const ab of abilities) {
			if (ab.isManaAbility) continue;
			if (checkAbilityActivationLegality(state, player.playerId, perm, ab).ok) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Steps a bot loop may take per call. Tests and the golden games use the default; the lobby server
 * passes a larger budget because every triggered ability now uses the stack (a pass round per
 * trigger), and logs when even that is used up (a runaway loop, or a very long all-bot stretch).
 */
const DEFAULT_MAX_BOT_STEPS = 240;
export const SERVER_MAX_BOT_STEPS = 1500;

export type BotStepResult = 'none' | 'quiet' | 'visible';

export type BotPauseKind = 'turn_start' | 'action';

export interface CombatSnapshot {
	phase: GamePhase;
	turnSerial: number;
	attackerCount: number;
	botBlockerCount: number;
}

export interface PreActionSnapshot {
	status: GameState['status'];
	turnSerial: number;
	combat: CombatSnapshot;
}

export interface BotLoopOptions {
	maxSteps?: number;
	logOnCap?: boolean;
	/** Stop after each visible bot action or bot turn start and return `{ paused: true }`. */
	pace?: boolean;
	/**
	 * Optional snapshot captured immediately before an external action (e.g. `applyGameAction` or
	 * `createInitialGameState`) so turn-based bot actions or a bot's Turn 1 initiated inside that
	 * external call also register a pacing pause.
	 */
	preAction?: PreActionSnapshot;
}

export interface BotLoopResult {
	paused: boolean;
	pausedFor?: BotPauseKind;
}

const BOT_SPEED_RANGES: Record<Exclude<BotSpeed, 'instant'>, readonly [number, number]> = {
	fast: [400, 700],
	normal: [900, 1600],
	slow: [1800, 3000]
};

export function normalizeBotSpeed(speed: BotSpeed | string | undefined | null): BotSpeed {
	if (speed === 'instant' || speed === 'fast' || speed === 'normal' || speed === 'slow') {
		return speed;
	}
	return 'normal';
}

function hashLobbyVersion(code: string, version: number): number {
	let h = 0x811c9dc5;
	const key = `${code}:${version}`;
	for (let i = 0; i < key.length; i++) {
		h ^= key.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
}

/**
 * Deterministic delay (in ms) before the next automated bot step, derived purely from
 * `(speed, kind, code, version)` — never touching `state.rng` or `Math.random`.
 */
export function botDelayMs(
	speed: BotSpeed | undefined,
	kind: BotPauseKind,
	code: string,
	version: number
): number {
	const normalized = normalizeBotSpeed(speed);
	if (normalized === 'instant') return 0;
	const [min, max] = BOT_SPEED_RANGES[normalized];
	const effectiveMax = kind === 'turn_start' ? min + Math.floor((max - min) * 0.25) : max;
	const span = effectiveMax - min + 1;
	const h = hashLobbyVersion(code, version);
	return min + (h % span);
}

function getTurnSerial(state: GameState): number {
	return state.turnSerial ?? state.turnNumber;
}

function countBotBlockers(state: GameState): number {
	let total = 0;
	for (const atk of state.combat.attackers) {
		const def = state.players.find((p) => p.playerId === atk.defenderPlayerId);
		if (def?.isBot) {
			total += atk.blockerInstanceIds.length;
		}
	}
	return total;
}

export function captureCombatSnapshot(state: GameState): CombatSnapshot {
	return {
		phase: state.phase,
		turnSerial: getTurnSerial(state),
		attackerCount: state.combat.attackers.length,
		botBlockerCount: countBotBlockers(state)
	};
}

export function capturePreActionSnapshot(state: GameState): PreActionSnapshot {
	return {
		status: state.status,
		turnSerial: getTurnSerial(state),
		combat: captureCombatSnapshot(state)
	};
}

export function didBotDeclareVisibleCombat(before: CombatSnapshot, after: GameState): boolean {
	const afterTurnSerial = getTurnSerial(after);
	const activeAfter = after.players[after.activePlayerIndex];
	if (
		after.phase === 'declare_attackers' &&
		activeAfter?.isBot &&
		!activeAfter.lost &&
		after.combat.attackers.length > 0 &&
		(before.phase !== 'declare_attackers' ||
			before.turnSerial !== afterTurnSerial ||
			after.combat.attackers.length > before.attackerCount)
	) {
		return true;
	}
	if (after.phase === 'declare_blockers') {
		const afterBotBlockers = countBotBlockers(after);
		const prevBotBlockers =
			before.phase === 'declare_blockers' && before.turnSerial === afterTurnSerial
				? before.botBlockerCount
				: 0;
		if (afterBotBlockers > prevBotBlockers) {
			return true;
		}
	}
	return false;
}

function countBotCostChoicePrompts(state: GameState, botId: string): number {
	let n = 0;
	for (const p of state.pendingPrompts) {
		if (p.playerId === botId && effectivePromptPurpose(p) === 'cost_choice') {
			n++;
		}
	}
	return n;
}

function classifyBotPromptStep(
	stateBeforeChoiceDescriptor: ReturnType<typeof effectivePromptChoice>,
	pr: PendingPrompt,
	answer: ChoiceAnswer | undefined,
	hadNewCostChoiceAfter: boolean
): 'quiet' | 'visible' {
	const purpose = effectivePromptPurpose(pr);
	if (
		purpose === 'mulligan' ||
		purpose === 'london_bottom' ||
		purpose === 'scry_choice' ||
		purpose === 'trigger_order'
	) {
		return 'quiet';
	}
	if (purpose === 'cost_choice') {
		if (hadNewCostChoiceAfter) return 'quiet';
		if (pr.pendingAction?.type === 'tap_mana') return 'quiet';
		return 'visible';
	}
	if (purpose === 'trigger_may') {
		return answer?.kind === 'yesNo' && answer.yes ? 'visible' : 'quiet';
	}
	const choice = stateBeforeChoiceDescriptor;
	switch (choice.kind) {
		case 'orderObjects':
			if (choice.objectIds.length <= 1 && !choice.allowSplitBottom && !choice.allowShuffle) {
				return 'quiet';
			}
			return 'visible';
		case 'chooseObjects':
			if (choice.candidates.length === 0 || choice.max === 0) return 'quiet';
			if (
				purpose === 'trigger_targets' &&
				answer?.kind === 'chooseObjects' &&
				answer.objectIds.length === 0
			) {
				return 'quiet';
			}
			return 'visible';
		case 'chooseMode':
			return choice.modes.length <= 1 ? 'quiet' : 'visible';
		case 'chooseReplacement':
			return choice.options.length <= 1 ? 'quiet' : 'visible';
		case 'chooseNumber':
			return choice.min === choice.max ? 'quiet' : 'visible';
		case 'yesNo':
			return 'visible';
	}
}

export function runAutomatedPriorityAndBots(
	state: GameState,
	opts: BotLoopOptions = {}
): BotLoopResult {
	const pace = Boolean(opts.pace);
	if (state.status !== 'active') {
		return { paused: false };
	}

	if (pace && opts.preAction) {
		const activeNow = state.players[state.activePlayerIndex];
		const enteredNewTurn =
			opts.preAction.status !== 'active' || opts.preAction.turnSerial !== getTurnSerial(state);
		if (enteredNewTurn && activeNow?.isBot && !activeNow.lost) {
			return { paused: true, pausedFor: 'turn_start' };
		}
		if (didBotDeclareVisibleCombat(opts.preAction.combat, state)) {
			return { paused: true, pausedFor: 'action' };
		}
	}

	let safetyCounter = 0;
	const MAX_STEPS = opts.maxSteps ?? DEFAULT_MAX_BOT_STEPS;
	const initialTurnSerial = getTurnSerial(state);

	while (state.status === 'active') {
		if (pace && getTurnSerial(state) !== initialTurnSerial) {
			const activeOnNewTurn = state.players[state.activePlayerIndex];
			if (activeOnNewTurn?.isBot && !activeOnNewTurn.lost) {
				return { paused: true, pausedFor: 'turn_start' };
			}
		}

		if (safetyCounter >= MAX_STEPS) {
			if (opts.logOnCap) {
				addLog(state, 'system', `Automated play paused after ${MAX_STEPS} steps (safety cap); it continues with the next action.`);
			}
			break;
		}
		safetyCounter++;
		if (state.pendingPrompts.length > 0) {
			const pr = state.pendingPrompts[0];
			const promptPlayer = state.players.find((p) => p.playerId === pr.playerId);
			if (!promptPlayer || !promptPlayer.isBot) break;
			const choiceDesc = pace ? effectivePromptChoice(pr, state) : undefined;
			const costChoicesBefore = pace ? countBotCostChoicePrompts(state, promptPlayer.playerId) : 0;
			const answer = chooseBotAnswer(state, promptPlayer, pr);
			const res = applyGameAction(state, promptPlayer.playerId, {
				type: 'choice',
				promptId: pr.id,
				answer
			});
			if (!res.ok) break;
			if (pace && state.status === 'active') {
				if (getTurnSerial(state) !== initialTurnSerial) {
					const activeAfterPrompt = state.players[state.activePlayerIndex];
					if (activeAfterPrompt?.isBot && !activeAfterPrompt.lost) {
						return { paused: true, pausedFor: 'turn_start' };
					}
				}
				const costChoicesAfter = countBotCostChoicePrompts(state, promptPlayer.playerId);
				const hadNewCostChoice =
					effectivePromptPurpose(pr) === 'cost_choice' && costChoicesAfter >= costChoicesBefore;
				const kind = classifyBotPromptStep(choiceDesc!, pr, answer, hadNewCostChoice);
				if (kind === 'visible') {
					return { paused: true, pausedFor: 'action' };
				}
			}
			continue;
		}
		const priorityPlayer = state.players[state.priorityPlayerIndex];
		const activePlayer = state.players[state.activePlayerIndex];
		if (!priorityPlayer || priorityPlayer.lost) break;

		if (priorityPlayer.isBot) {
			const stepResult = executeBotStep(state, priorityPlayer, activePlayer);
			if (stepResult === 'none') break;
			if (pace && state.status === 'active') {
				if (getTurnSerial(state) !== initialTurnSerial) {
					const activeAfterStep = state.players[state.activePlayerIndex];
					if (activeAfterStep?.isBot && !activeAfterStep.lost) {
						return { paused: true, pausedFor: 'turn_start' };
					}
				}
				if (stepResult === 'visible') {
					return { paused: true, pausedFor: 'action' };
				}
			}
			continue;
		}

		// Human player holds priority:
		// Just like MTG Arena, if Full Control is OFF and the human does not need to declare blockers:
		// 1) If it is NOT the human's turn and the Stack is empty, auto-pass priority.
		// 2) If opponent spell(s)/abilities are on the Stack and the human has ZERO legal instant-speed
		//    spells or non-mana activated abilities to respond with, auto-pass priority so AI turns don't freeze.
		const isDefendingInBlockers =
			state.phase === 'declare_blockers' &&
			state.combat.attackers.some((a) => a.defenderPlayerId === priorityPlayer.playerId) &&
			!(state.combat.declaredBlockersPlayerIds || []).includes(priorityPlayer.playerId);

		if (!priorityPlayer.fullControl && priorityPlayer.autoPassEmptyStack && !isDefendingInBlockers) {
			const hasStopInPhase = priorityPlayer.stopPhases?.includes(state.phase) ?? false;
			const shouldAutoPassEmptyOffTurn =
				priorityPlayer.playerId !== activePlayer.playerId &&
				state.stack.length === 0 &&
				!hasStopInPhase;
			// Steps C+D: the player's own triggered abilities don't stop auto-pass either (MTG Arena
			// resolves them unless Full Control is on); their own spells still do.
			const shouldAutoPassUnrespondableOpponentStack =
				state.stack.length > 0 &&
				state.stack.every((s) => s.controllerId !== priorityPlayer.playerId || s.kind === 'triggered') &&
				!hasAnyLegalInstantResponse(state, priorityPlayer);

			if (shouldAutoPassEmptyOffTurn || shouldAutoPassUnrespondableOpponentStack) {
				const combatBefore = pace ? captureCombatSnapshot(state) : undefined;
				const res = applyGameAction(state, priorityPlayer.playerId, { type: 'pass_priority' });
				if (!res.ok) break;
				if (pace && state.status === 'active') {
					if (getTurnSerial(state) !== initialTurnSerial) {
						const activeAfterPass = state.players[state.activePlayerIndex];
						if (activeAfterPass?.isBot && !activeAfterPass.lost) {
							return { paused: true, pausedFor: 'turn_start' };
						}
					}
					if (combatBefore && didBotDeclareVisibleCombat(combatBefore, state)) {
						return { paused: true, pausedFor: 'action' };
					}
				}
				continue;
			}
		}

		break;
	}

	return { paused: false };
}

export function executeBotStep(
	state: GameState,
	bot: PlayerGameState,
	activePlayer: PlayerGameState
): BotStepResult {
	const isBotsTurn = activePlayer.playerId === bot.playerId;

	// 1. If it's Declare Blockers and the bot is being attacked, assign smart legal blockers
	if (
		state.phase === 'declare_blockers' &&
		!isBotsTurn &&
		state.stack.length === 0
	) {
		const attacksAgainstBot = state.combat.attackers.filter(
			(a) => a.defenderPlayerId === bot.playerId
		);
		if (
			attacksAgainstBot.length > 0 &&
			!(state.combat.declaredBlockersPlayerIds || []).includes(bot.playerId)
		) {
			const assignments = chooseBotBlockAssignments(state, bot);
			const bRes = applyGameAction(state, bot.playerId, {
				type: 'declare_blockers',
				assignments
			});
			if (bRes.ok) return assignments.length > 0 ? 'visible' : 'quiet';
		}
	}

	// 2. If it's the bot's Main Phase and Stack is empty: play land, cast Commander or spells
	if (isBotsTurn && (state.phase === 'main1' || state.phase === 'main2') && state.stack.length === 0) {
		// 2a. Play a land if available (using engine getLandPlayOptions for single- and multi-face cards)
		if (bot.landsPlayedThisTurn < bot.maxLandsPerTurn) {
			for (const card of bot.hand) {
				const landOpts = getLandPlayOptions(state, bot.playerId, card, 'hand');
				if (landOpts.length === 0) continue;
				const res = applyGameAction(state, bot.playerId, {
					type: 'play_land',
					instanceId: card.instanceId,
					fromZone: 'hand',
					faceIndex: landOpts[0].faceIndex
				});
				if (res.ok) return 'visible';
			}
			for (const card of bot.exile) {
				if (card.playableFromExileBy?.playerId !== bot.playerId) continue;
				const landOpts = getLandPlayOptions(state, bot.playerId, card, 'exile');
				if (landOpts.length === 0) continue;
				const res = applyGameAction(state, bot.playerId, {
					type: 'play_land',
					instanceId: card.instanceId,
					fromZone: 'exile',
					faceIndex: landOpts[0].faceIndex
				});
				if (res.ok) return 'visible';
			}
		}

		// 2b. Try casting Commander from Command Zone if affordable and legal
		for (const cmd of bot.command) {
			// Read-only decision (Phase 6d); the cast is applied outside the scope.
			const plan = withStableLayerInputs(state, () => {
				const options = getCastOptions(state, bot.playerId, cmd, 'command');
				const opt = options.find((o) => !o.spellMods.targetsBecomeEach) ?? options[0];
				if (!opt) return null;
				const faceIndex = opt.faceIndex ?? 0;
				const optionalCostCounts = chooseBotOptionalCostCounts(state, bot, cmd, 'command', opt);
				const targetReq = getSpellTargetRequirement(cmd.card, opt, optionalCostCounts);
				const targets = targetReq.requiresTarget
					? chooseBotTargetsForCard(state, bot, cmd, opt, optionalCostCounts)
					: [];
				if (targetReq.minTargets > 0 && targets.length < targetReq.minTargets) return null;
				return {
					optionId: opt.id,
					faceIndex: opt.faceIndex,
					fused: opt.fused,
					optionalCostCounts,
					targets,
					costPayment: chooseBotSpellCostPayment(
						state,
						bot,
						cmd,
						faceIndex,
						opt.id,
						optionalCostCounts
					)
				};
			});
			if (plan) {
				const { optionId, faceIndex, fused, optionalCostCounts, targets, costPayment } = plan;
				const costBefore = countBotCostChoicePrompts(state, bot.playerId);
				const res = applyGameAction(state, bot.playerId, {
					type: 'cast_spell',
					instanceId: cmd.instanceId,
					fromZone: 'command',
					optionId,
					...(faceIndex !== undefined ? { faceIndex } : {}),
					...(fused ? { fused: true } : {}),
					...(optionalCostCounts ? { optionalCostCounts } : {}),
					targets,
					...(costPayment ? { costPayment } : {})
				});
				if (res.ok) {
					return countBotCostChoicePrompts(state, bot.playerId) > costBefore ? 'quiet' : 'visible';
				}
			}
		}

		// 2c. Try casting a playable non-counterspell card from hand (prioritize ramp/artifacts/creatures)
		// Read-only: the castable list is computed in one layer-cache validation (Phase 6d).
		const castable = withStableLayerInputs(state, () => {
			const opponentCreatureCount = state.players
				.filter((p) => p.playerId !== bot.playerId && !p.lost)
				.reduce(
					(acc, p) =>
						acc +
						p.battlefield.filter((b) => !b.phasedOut && evaluatePermanent(state, b).isCreature)
							.length,
					0
				);
			const ownPermanentCount = bot.battlefield.filter(
				(b) => !b.phasedOut && !evaluatePermanent(state, b).isLand
			).length;

			const isCandidateSpell = (c: CardInstance, zone: 'hand' | 'graveyard' | 'exile'): boolean => {
				const options = getCastOptions(state, bot.playerId, c, zone);
				if (options.length === 0) return false;
				return options.some((opt) => {
					if (opt.spellMods.castFaceDown) return true;
					const fi = opt.faceIndex ?? 0;
					const fused = opt.fused ?? false;
					if (isCounterSpellCard(c.card, fi, fused)) return false;
					if (isProtectionTrickCard(c.card, fi, fused)) return false;
					if (isCreatureBoardWipeCard(c.card, fi, fused) && opponentCreatureCount < 2) return false;
					return true;
				});
			};

			return [
				...bot.hand
					.filter((c) => isCandidateSpell(c, 'hand'))
					.sort((a, b) => a.card.cmc - b.card.cmc)
					.map((cardInst) => ({ cardInst, fromZone: 'hand' as const })),
				...bot.graveyard
					.filter((c) => isCandidateSpell(c, 'graveyard'))
					.sort((a, b) => a.card.cmc - b.card.cmc)
					.map((cardInst) => ({ cardInst, fromZone: 'graveyard' as const })),
				...bot.exile
					.filter((c) => c.playableFromExileBy?.playerId === bot.playerId && isCandidateSpell(c, 'exile'))
					.sort((a, b) => a.card.cmc - b.card.cmc)
					.map((cardInst) => ({ cardInst, fromZone: 'exile' as const }))
			];
		});

		for (const { cardInst, fromZone } of castable) {
			// Read-only decision (Phase 6d).
			const planned = withStableLayerInputs(state, () => {
				const options = getCastOptions(state, bot.playerId, cardInst, fromZone).filter((opt) => {
					if (opt.spellMods.castFaceDown) return true;
					const fi = opt.faceIndex ?? 0;
					const fused = opt.fused ?? false;
					return !isCounterSpellCard(cardInst.card, fi, fused) && !isProtectionTrickCard(cardInst.card, fi, fused);
				});
				if (options.length === 0) return null;
				const nonEachOpt = options.find((o) => !o.spellMods.targetsBecomeEach) ?? options[0];
				const optFace = nonEachOpt.faceIndex ?? 0;
				const optFused = nonEachOpt.fused ?? false;
				const modal = nonEachOpt.spellMods.castFaceDown
					? undefined
					: compileSpellEffects(cardInst.card, optFace, optFused)?.modal;
				if (modal) {
					const chosen = chooseBotModalSpell(state, bot, cardInst, optFace, optFused);
					if (!chosen) return null;
					const optionalCostCounts = chooseBotOptionalCostCounts(state, bot, cardInst, fromZone, nonEachOpt);
					return {
						targets: chosen.targets,
						modes: chosen.modes,
						optionId: nonEachOpt.id,
						faceIndex: nonEachOpt.faceIndex,
						fused: nonEachOpt.fused,
						optionalCostCounts,
						costPayment: chooseBotSpellCostPayment(
							state,
							bot,
							cardInst,
							optFace,
							nonEachOpt.id,
							optionalCostCounts
						)
					};
				}

				const eachOpt = options.find((o) => o.spellMods.targetsBecomeEach);
				if (eachOpt) {
					const eachFace = eachOpt.faceIndex ?? 0;
					const eachFused = eachOpt.fused ?? false;
					const spec = cardSpellTargetSpec(cardInst.card, eachFace);
					const harmful = targetIsHarmed(cardSpellSteps(cardInst.card, eachFace, eachFused), 0);
					let oppMatches = 0;
					let ownMatches = 0;
					if (spec?.kind === 'object') {
						const fctx = { state, controllerId: bot.playerId, source: cardInst };
						for (const p of state.players) {
							if (p.lost) continue;
							for (const perm of p.battlefield) {
								if (perm.phasedOut) continue;
								if (!matchesObjectFilter(perm, spec.filter, fctx)) continue;
								if (p.playerId === bot.playerId) ownMatches += 1;
								else oppMatches += 1;
							}
						}
					}
					const normalLegal = Boolean(options.find((o) => !o.spellMods.targetsBecomeEach));
					const shouldUseEach = harmful
						? oppMatches > ownMatches && (oppMatches >= 2 || (!normalLegal && oppMatches >= 1))
						: ownMatches >= 2 || (!normalLegal && ownMatches >= 1);
					if (shouldUseEach) {
						const optionalCostCounts = chooseBotOptionalCostCounts(
							state,
							bot,
							cardInst,
							fromZone,
							eachOpt
						);
						return {
							targets: [] as TargetRef[],
							modes: undefined as number[] | undefined,
							optionId: eachOpt.id,
							faceIndex: eachOpt.faceIndex,
							fused: eachOpt.fused,
							optionalCostCounts,
							costPayment: chooseBotSpellCostPayment(
								state,
								bot,
								cardInst,
								eachFace,
								eachOpt.id,
								optionalCostCounts
							)
						};
					}
				}
				const normalOpt = options.find((o) => !o.spellMods.targetsBecomeEach);
				if (!normalOpt) {
					return null;
				}
				const normalFace = normalOpt.faceIndex ?? 0;
				const optionalCostCounts = chooseBotOptionalCostCounts(
					state,
					bot,
					cardInst,
					fromZone,
					normalOpt
				);
				const targetReq = getSpellTargetRequirement(cardInst.card, normalOpt, optionalCostCounts);
				const targets = targetReq.requiresTarget
					? chooseBotTargetsForCard(state, bot, cardInst, normalOpt, optionalCostCounts)
					: [];
				if (targetReq.minTargets > 0 && targets.length < targetReq.minTargets) return null;
				return {
					targets,
					modes: undefined as number[] | undefined,
					optionId: normalOpt.id,
					faceIndex: normalOpt.faceIndex,
					fused: normalOpt.fused,
					optionalCostCounts,
					costPayment: chooseBotSpellCostPayment(
						state,
						bot,
						cardInst,
						normalFace,
						normalOpt.id,
						optionalCostCounts
					)
				};
			});
			if (!planned) continue;
			const { targets, modes, optionId, faceIndex, fused, optionalCostCounts, costPayment } = planned;
			const costBefore = countBotCostChoicePrompts(state, bot.playerId);
			const res = applyGameAction(state, bot.playerId, {
				type: 'cast_spell',
				instanceId: cardInst.instanceId,
				fromZone,
				targets,
				...(modes ? { modes } : {}),
				optionId,
				...(faceIndex !== undefined ? { faceIndex } : {}),
				...(fused ? { fused: true } : {}),
				...(optionalCostCounts ? { optionalCostCounts } : {}),
				...(costPayment ? { costPayment } : {})
			});
			if (res.ok) {
				return countBotCostChoicePrompts(state, bot.playerId) > costBefore ? 'quiet' : 'visible';
			}
		}

		// 2d. Try activating unattached Equipment (activated.attach) onto a controlled creature
		// Read-only (Phase 6d).
		const ownCreatures = withStableLayerInputs(state, () =>
			bot.battlefield
				.filter(
					(perm) =>
						!perm.phasedOut &&
						evaluatePermanent(state, perm).isCreature &&
						!hasKeyword(perm, 'Shroud', state)
				)
				.sort((a, b) => getCreaturePower(b, state) - getCreaturePower(a, state))
		);
		if (ownCreatures.length > 0) {
			const cmdId = getPlayerCommanderIdentity(bot);
			// Scan the battlefield in order for the next activatable Equip ability, in one read-only
			// pass per attempt (Phase 6d); a failed activation resumes the scan after that permanent.
			let next = 0;
			for (;;) {
				const found = withStableLayerInputs(state, () => {
					for (; next < bot.battlefield.length; next++) {
						const perm = bot.battlefield[next];
						if (perm.phasedOut || perm.attachedToId) continue;
						const abilities = getEffectiveActivatedAbilities(state, bot, perm, cmdId);
						const ab = abilities.find((a) => a.id.startsWith('equip_'));
						if (ab && checkAbilityActivationLegality(state, bot.playerId, perm, ab).ok) {
							next += 1;
							return { perm, equipAb: ab };
						}
					}
					return null;
				});
				if (!found) break;
				const { perm, equipAb } = found;
				const targetCreature = ownCreatures[0];
				const costBefore = countBotCostChoicePrompts(state, bot.playerId);
				const res = applyGameAction(state, bot.playerId, {
					type: 'activate_ability',
					instanceId: perm.instanceId,
					abilityId: equipAb.id,
					targets: [
						{
							kind: 'permanent',
							id: targetCreature.instanceId,
							label: targetCreature.card.name
						}
					]
				});
				if (res.ok) {
					if (equipAb.isManaAbility) return 'quiet';
					return countBotCostChoicePrompts(state, bot.playerId) > costBefore ? 'quiet' : 'visible';
				}
			}
		}

		// 2d2. Turn face-down permanents face up when affordable.
		for (const perm of [...bot.battlefield]) {
			if (perm.phasedOut || !perm.isFaceDown) continue;
			const turnUp = getTurnFaceUpDisplay(state, bot.playerId, perm);
			if (!turnUp?.legal) continue;
			let xValue = 0;
			if (turnUp.choosesX) {
				for (const candidateX of [3, 2, 1, 0]) {
					if (checkTurnFaceUpLegality(state, bot.playerId, perm, candidateX).ok) {
						xValue = candidateX;
						break;
					}
				}
			}
			const costPayment = chooseBotTurnFaceUpPayment(state, bot, perm, xValue);
			const costBefore = countBotCostChoicePrompts(state, bot.playerId);
			const res = applyGameAction(state, bot.playerId, {
				type: 'turn_face_up',
				instanceId: perm.instanceId,
				...(turnUp.choosesX ? { xValue } : {}),
				...(costPayment ? { costPayment } : {})
			});
			if (res.ok) {
				return countBotCostChoicePrompts(state, bot.playerId) > costBefore ? 'quiet' : 'visible';
			}
		}

		// 2e. Conservative fallback on bot's own main phase: activate hand-zone abilities
		// on excess lands or uncastable high-CMC cards after land drops / spells / equips.
		const mainHandRes = tryBotHandActivatedAbility(state, bot, true);
		if (mainHandRes) return mainHandRes;
	}

	// 2f. Opponent's end step: spend leftover mana on instant-speed hand-zone abilities.
	if (!isBotsTurn && state.phase === 'end_step' && state.stack.length === 0) {
		const endStepHandRes = tryBotHandActivatedAbility(state, bot, false);
		if (endStepHandRes) return endStepHandRes;
	}

	// 3. If it's the bot's Declare Attackers step and Stack is empty
	if (isBotsTurn && state.phase === 'declare_attackers' && state.stack.length === 0 && !state.combat.active) {
		const assignments = chooseBotAttackAssignments(state, bot);
		const res = applyGameAction(state, bot.playerId, {
			type: 'declare_attackers',
			assignments
		});
		if (res.ok) return assignments.length > 0 ? 'visible' : 'quiet';
	}

	// 4. Default: Pass priority
	const combatBefore = captureCombatSnapshot(state);
	const passRes = applyGameAction(state, bot.playerId, { type: 'pass_priority' });
	if (!passRes.ok) return 'none';
	if (didBotDeclareVisibleCombat(combatBefore, state)) {
		return 'visible';
	}
	return 'quiet';
}

function tryBotHandActivatedAbility(
	state: GameState,
	bot: PlayerGameState,
	isMainPhase: boolean
): BotStepResult | null {
	const ownLandsCount = withStableLayerInputs(state, () =>
		bot.battlefield.filter((b) => !b.phasedOut && evaluatePermanent(state, b).isLand).length
	);
	const cmdId = getPlayerCommanderIdentity(bot);

	for (let i = 0; i < bot.hand.length; i++) {
		const cardInst = bot.hand[i];
		const types = activeCharacteristics(cardInst.card, instanceFaceOptions(cardInst)).types;
		const isLand = types.includes('Land') && !types.includes('Creature');
		if (isMainPhase) {
			const excessLand = isLand && (bot.landsPlayedThisTurn >= bot.maxLandsPerTurn || ownLandsCount >= 5);
			const uncastableHighCmc = !isLand && cardInst.card.cmc >= 5 && ownLandsCount <= 3;
			const floodedNonTrick =
				ownLandsCount >= 6 &&
				bot.hand.length >= 2 &&
				!isCounterSpellCard(cardInst.card) &&
				!isProtectionTrickCard(cardInst.card);
			if (!excessLand && !uncastableHighCmc && !floodedNonTrick) {
				continue;
			}
		}

		const candidate = withStableLayerInputs(state, () => {
			const abilities = getEffectiveActivatedAbilities(state, bot, cardInst, cmdId);
			for (const ab of abilities) {
				if (ab.isManaAbility || !ab.activationZones?.includes('hand')) continue;
				if (!checkAbilityActivationLegality(state, bot.playerId, cardInst, ab).ok) continue;
				let targets: TargetRef[] = [];
				if (ab.requiresTarget) {
					const spec = ab.targetInfo.targetSpecs?.[0];
					if (!spec) continue;
					targets = chooseBotTargetsForSpec(state, bot, cardInst, spec);
					if (ab.targetInfo.minTargets > 0 && targets.length < ab.targetInfo.minTargets) {
						continue;
					}
				}
				return { ab, targets };
			}
			return null;
		});
		if (!candidate) continue;

		const costBefore = countBotCostChoicePrompts(state, bot.playerId);
		const res = applyGameAction(state, bot.playerId, {
			type: 'activate_ability',
			instanceId: cardInst.instanceId,
			abilityId: candidate.ab.id,
			targets: candidate.targets
		});
		if (res.ok) {
			return countBotCostChoicePrompts(state, bot.playerId) > costBefore ? 'quiet' : 'visible';
		}
	}
	return null;
}

function chooseBotOptionalCostCounts(
	state: GameState,
	bot: PlayerGameState,
	cardInst: CardInstance,
	fromZone: 'hand' | 'command' | 'exile' | 'graveyard',
	option: CastOption
): Record<string, number> | undefined {
	const optionals = option.optionalAdditionalCosts;
	if (!optionals || optionals.length === 0) return undefined;
	const altCount =
		option.baseCost.kind === 'alternative' ? (option.baseCost.costDefs?.length ?? 0) : 0;
	const mandatoryCount = option.mandatoryAdditionalCosts?.length ?? 0;
	const counts: Record<string, number> = {};
	for (const oc of optionals) {
		if (/\{X\}/i.test(oc.costDisplay) || JSON.stringify(oc.costDefs).includes('"k":"x"')) {
			continue;
		}
		const maxTry = Math.min(oc.maxCount, 5);
		const hasNonManaDef = oc.costDefs.some((d) => d.k !== 'mana');
		const faceIdx = option.faceIndex ?? 0;
		for (let step = 1; step <= maxTry; step++) {
			const candidate: Record<string, number> = { ...counts, [oc.id]: step };
			if (!checkSpellCastLegality(state, bot.playerId, cardInst, fromZone, 0, option.id, candidate, faceIdx, option.fused).ok) {
				break;
			}
			const hasAnyNonMana = altCount > 0 || mandatoryCount > 0 || hasNonManaDef;
			if (hasAnyNonMana && !chooseBotSpellCostPayment(state, bot, cardInst, faceIdx, option.id, candidate)) {
				break;
			}
			if (!option.spellMods.targetsBecomeEach) {
				const targetReq = getSpellTargetRequirement(cardInst.card, option, candidate);
				if (targetReq.requiresTarget && targetReq.minTargets > 0) {
					const picked = chooseBotTargetsForCard(state, bot, cardInst, option, candidate);
					if (picked.length < targetReq.minTargets) break;
				}
			}
			counts[oc.id] = step;
		}
	}
	return Object.keys(counts).length > 0 ? counts : undefined;
}

function chooseBotTargetsForSpec(
	state: GameState,
	bot: PlayerGameState,
	cardInst: CardInstance,
	spec: TargetSpec
): TargetRef[] {
	const isControlledCreature =
		spec.kind === 'object' &&
		spec.filter.controller === 'you' &&
		Boolean(spec.filter.types?.includes('Creature'));

	if (isControlledCreature) {
		const ownCreatures = bot.battlefield
			.filter(
				(perm) =>
					!perm.phasedOut &&
					evaluatePermanent(state, perm).isCreature &&
					!hasKeyword(perm, 'Shroud', state)
			)
			.sort((a, b) => getCreaturePower(b, state) - getCreaturePower(a, state));
		if (ownCreatures.length > 0) {
			return [
				{
					kind: 'permanent',
					id: ownCreatures[0].instanceId,
					label: ownCreatures[0].card.name
				}
			];
		}
		return [];
	}

	const opponents = state.players.filter((p) => p.playerId !== bot.playerId && !p.lost);
	if (opponents.length === 0) return [];

	if (spec.kind === 'player') {
		const topOpp = opponents.sort((a, b) => b.life - a.life)[0];
		return [{ kind: 'player', id: topOpp.playerId, label: topOpp.username }];
	}

	const creatureOnly =
		spec.kind === 'object' &&
		spec.filter.types?.length === 1 &&
		spec.filter.types[0] === 'Creature';
	const artifactOrEnchantmentOnly =
		spec.kind === 'object' &&
		spec.filter.types?.length === 2 &&
		spec.filter.types.includes('Artifact') &&
		spec.filter.types.includes('Enchantment');

	// Find highest-CMC / highest-power opponent permanent without Hexproof/Shroud
	const enemyPermanents: Array<{ inst: CardInstance; owner: PlayerGameState }> = [];
	for (const opp of opponents) {
		for (const perm of opp.battlefield) {
			if (perm.phasedOut) continue;
			if (hasKeyword(perm, 'Hexproof', state) || hasKeyword(perm, 'Shroud', state)) continue;
			const evalPerm = evaluatePermanent(state, perm);
			if (creatureOnly && !evalPerm.isCreature) continue;
			if (artifactOrEnchantmentOnly && !evalPerm.isArtifact && !evalPerm.isEnchantment) {
				continue;
			}
			if (evalPerm.isLand) continue;
			enemyPermanents.push({ inst: perm, owner: opp });
		}
	}

	enemyPermanents.sort((a, b) => b.inst.card.cmc - a.inst.card.cmc);
	if (enemyPermanents.length > 0) {
		const count = Math.max(1, spec.min);
		const picked = enemyPermanents.slice(0, count).map((e) => ({
			kind: 'permanent' as const,
			id: e.inst.instanceId,
			label: e.inst.card.name
		}));
		if (picked.length >= spec.min) return picked;
	}

	if (spec.kind === 'objectOrPlayer' && spec.min <= 1) {
		const topOpp = opponents.sort((a, b) => b.life - a.life)[0];
		return [{ kind: 'player', id: topOpp.playerId, label: topOpp.username }];
	}

	// Last resort: any legal target except the bot's own permanents, itself and its own spells, so a
	// removal spell is never aimed at the bot's side when opponents have nothing to hit.
	const allLegal = specTargetCandidates(state, bot.playerId, cardInst.card, cardInst, spec).filter((t) => {
		if (t.kind === 'player') return t.id !== bot.playerId;
		if (t.kind === 'permanent') return !bot.battlefield.some((p) => p.instanceId === t.id);
		if (t.kind === 'stack') return state.stack.find((s) => s.id === t.id)?.controllerId !== bot.playerId;
		return true;
	});
	if (allLegal.length > 0 && allLegal.length >= spec.min) {
		return allLegal.slice(0, Math.max(1, spec.min));
	}

	return [];
}

function chooseBotTargetsForCard(
	state: GameState,
	bot: PlayerGameState,
	cardInst: CardInstance,
	option?: CastOption,
	optionalCostCounts?: Record<string, number>
): TargetRef[] {
	const req = getSpellTargetRequirement(cardInst.card, option, optionalCostCounts);
	const activeSpecs = req.targetSpecs?.filter((sp) => sp.max > 0);
	if (activeSpecs && activeSpecs.length > 0) {
		const out: TargetRef[] = [];
		for (const sp of activeSpecs) {
			const picked = chooseBotTargetsForSpec(state, bot, cardInst, sp);
			if (sp.min > 0 && picked.length < sp.min) return [];
			out.push(...picked.slice(0, Math.max(sp.min, Math.min(sp.max, picked.length))));
		}
		return out;
	}
	const spec = cardSpellTargetSpec(cardInst.card, option?.faceIndex ?? 0);
	if (!spec) return [];
	return chooseBotTargetsForSpec(state, bot, cardInst, spec);
}

// ---- Triggered abilities (steps C+D) -----------------------------------------------------------

/** Verbs that are bad for the object or player they act on. */
const HARMFUL_VERBS = new Set<EffectStep['verb']>([
	'destroy',
	'exile',
	'bounce',
	'damage',
	'loseLife',
	'sacrifice',
	'tap',
	'discard',
	'mill',
	'counterSpell',
	'phaseOut',
	'fight',
	'lose'
]);

/** Whether the steps acting on target `index` hurt it (true), help it (false). */
function targetIsHarmed(steps: EffectStep[], index: number): boolean {
	const acting = steps.filter(
		(s) =>
			(s.subject.k === 'target' && s.subject.index === index) ||
			(s.subject.k === 'playerRef' && s.subject.ref.k === 'target' && s.subject.ref.index === index)
	);
	if (acting.length === 0) return true;
	return acting.some((s) => {
		if (s.verb === 'pump') return (s.amount?.k === 'const' && s.amount.n < 0) || s.amount?.k === 'negate';
		if (s.verb === 'putCounters') return s.params?.counter === '-1/-1' || s.params?.counter === 'stun';
		// Returning a card from a graveyard to hand or the battlefield helps; exiling it hurts.
		if (s.verb === 'move') return s.params?.to === 'exile';
		return HARMFUL_VERBS.has(s.verb);
	});
}

/**
 * A bot's targets for one target spec of its triggered ability (CR 603.3d), from the legal
 * candidates the engine computed: opponents' best permanents (or the opponent with the least life)
 * for harmful effects, its own for helpful ones. Optional targets ("up to one") are only taken when
 * a candidate is on the right side.
 */
export function chooseBotTriggerTargets(
	state: GameState,
	bot: PlayerGameState,
	steps: EffectStep[],
	index: number,
	spec: TargetSpec,
	legal: TargetRef[]
): TargetRef[] {
	// Read-only (Phase 6d).
	return withStableLayerInputs(state, () =>
		chooseBotTriggerTargetsInner(state, bot, steps, index, spec, legal)
	);
}

function chooseBotTriggerTargetsInner(
	state: GameState,
	bot: PlayerGameState,
	steps: EffectStep[],
	index: number,
	spec: TargetSpec,
	legal: TargetRef[]
): TargetRef[] {
	const harmful = targetIsHarmed(steps, index);
	const ownerOf = (t: TargetRef): string | undefined => {
		if (t.kind === 'player') return t.id;
		for (const p of state.players) {
			if (p.battlefield.some((c) => c.instanceId === t.id)) {
				return p.battlefield.find((c) => c.instanceId === t.id)!.controllerId;
			}
			if (p.graveyard.some((c) => c.instanceId === t.id)) return p.playerId;
		}
		return undefined;
	};
	const value = (t: TargetRef): number => {
		if (t.kind === 'player') {
			const p = state.players.find((x) => x.playerId === t.id);
			return p ? 100 - p.life : 0;
		}
		for (const p of state.players) {
			const c = p.battlefield.find((x) => x.instanceId === t.id) ?? p.graveyard.find((x) => x.instanceId === t.id);
			if (c) return c.card.cmc + (c.zone === 'battlefield' && evaluatePermanent(state, c).isCreature ? getCreaturePower(c, state) : 0);
		}
		return 0;
	};
	const good = (t: TargetRef) => (ownerOf(t) === bot.playerId) !== harmful;
	const ranked = [...legal].sort((a, b) => {
		const ga = good(a) ? 1 : 0;
		const gb = good(b) ? 1 : 0;
		if (ga !== gb) return gb - ga;
		// On the wrong side, prefer the least valuable; on the right side, the most.
		return ga ? value(b) - value(a) : value(a) - value(b);
	});
	const wanted = Math.max(spec.min, Math.min(spec.max, ranked.filter(good).length));
	return ranked.slice(0, Math.min(wanted, spec.max));
}

/**
 * Whether a bot uses the optional ("you may") part of its resolving triggered ability. Bots take
 * optional effects unless they would deck themselves or sacrifice their own permanents.
 */
export function botAcceptsOptionalTrigger(
	state: GameState,
	bot: PlayerGameState,
	optionalSteps: EffectStep[],
	item: StackItem
): boolean {
	void state;
	void item;
	for (const s of optionalSteps) {
		if (s.verb === 'draw' && bot.library.length <= 3) return false;
		if (s.verb === 'sacrifice' || s.verb === 'loseLife' || s.verb === 'discard') return false;
	}
	return true;
}
