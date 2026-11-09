/**
 * Generic choice protocol (ENGINE_ARCHITECTURE_PLAN.md §2.8, Phase 8).
 *
 * Unifies player prompts under 6 generic choice shapes (`yesNo`, `chooseObjects`, `chooseMode`,
 * `chooseNumber`, `orderObjects`, `chooseReplacement`) and a single `{ type: 'choice', promptId,
 * answer, cancel }` action payload, while normalizing legacy action aliases into the same flow.
 *
 * Step E2: prompts carry their continuation as plain data (`PendingPrompt.continuation`); there are
 * no callbacks, so a prompt answered after the server reloads the state from JSON still continues.
 */
import type { CostQuestion } from './costs.ts';
import {
	ENGINE_VERSION,
	type CardInstance,
	type ChoiceAnswer,
	type ChoiceKind,
	type ChoiceRequest,
	type GameActionPayload,
	type GameState,
	type GuidedOperation,
	type PendingPrompt,
	type PendingPromptKind,
	type PlayerGameState,
	type PromptPurpose,
	type ZoneType
} from '../types.ts';

export {
	ENGINE_VERSION,
	type ChoiceAnswer,
	type ChoiceKind,
	type ChoiceRequest,
	type GuidedOperation,
	type PendingPromptKind,
	type PromptPurpose
};

export const ALL_CHOICE_KINDS: readonly ChoiceKind[] = [
	'yesNo',
	'chooseObjects',
	'chooseMode',
	'chooseNumber',
	'orderObjects',
	'chooseReplacement'
] as const;

export const ALL_PROMPT_PURPOSES: readonly PromptPurpose[] = [
	'mulligan',
	'london_bottom',
	'discard_to_hand_size',
	'commander_zone_choice',
	'end_turn',
	'search_library',
	'scry_choice',
	'guided_resolution',
	'legend_rule',
	'cost_choice',
	'trigger_targets',
	'trigger_order',
	'trigger_may',
	'generic'
] as const;

/** Compile-time and runtime exhaustiveness guard over all `ChoiceRequest['kind']` variants. */
export function assertExhaustiveChoiceKind(choice: ChoiceRequest): ChoiceKind {
	switch (choice.kind) {
		case 'yesNo':
		case 'chooseObjects':
		case 'chooseMode':
		case 'chooseNumber':
		case 'orderObjects':
		case 'chooseReplacement':
			return choice.kind;
		default: {
			const _exhaustive: never = choice;
			return _exhaustive;
		}
	}
}

/**
 * A named prompt handler: code registered once at module load, referred to from a prompt by name
 * (`continuation: { kind: 'handler', name, data }`). The prompt itself holds only plain data, so it
 * still works after the server reloads the state from JSON (Invariant 7.1). There is deliberately no
 * way to attach a closure to a prompt.
 */
export type PromptHandler = (
	state: GameState,
	prompt: PendingPrompt,
	answer: ChoiceAnswer
) => void;

const promptHandlers = new Map<string, PromptHandler>();

/** Registers (or replaces) the handler for `continuation: { kind: 'handler', name }` prompts. */
export function registerPromptHandler(name: string, handler: PromptHandler): void {
	promptHandlers.set(name, handler);
}

/** Runs the named handler of an answered prompt, if it has one. Returns whether one ran. */
export function runPromptHandler(state: GameState, prompt: PendingPrompt, answer: ChoiceAnswer): boolean {
	const c = prompt.continuation;
	if (c?.kind !== 'handler') return false;
	const handler = promptHandlers.get(c.name);
	if (!handler) return false;
	handler(state, prompt, answer);
	return true;
}

/**
 * Pushes a choice prompt onto `state.pendingPrompts`, filling in its generic `choice` and
 * `purpose`. What happens when it's answered is described by the prompt's data (`purpose`,
 * `continuation`, `triggerStackItemId`, ...), never by a callback.
 */
export function enqueueChoicePrompt(state: GameState, prompt: PendingPrompt): PendingPrompt {
	const enriched: PendingPrompt = {
		...prompt,
		choice: prompt.choice ?? effectivePromptChoice(prompt, state),
		purpose: prompt.purpose ?? effectivePromptPurpose(prompt)
	};
	state.pendingPrompts.push(enriched);
	return enriched;
}

/** Builds the generic `ChoiceRequest` for a Phase 4 `CostQuestion`. */
export function buildCostChoiceRequest(
	question: CostQuestion,
	zone: ZoneType = 'battlefield'
): ChoiceRequest {
	if (question.kind === 'option') {
		if (question.optional) {
			return {
				kind: 'yesNo',
				question: question.labels[0]
					? `This cost is optional (${question.labels[0]}). Pay it?`
					: 'This cost is optional. Pay it?'
			};
		}
		return {
			kind: 'chooseMode',
			modes: question.labels,
			min: 1,
			max: 1
		};
	}
	return {
		kind: 'chooseObjects',
		candidates: question.candidateIds,
		min: question.count,
		max: question.count,
		zone,
		reason: question.label
	};
}

/** Infers the zone of candidate objects for a cost question across a player's zones. */
export function inferObjectsZone(player: PlayerGameState, candidateIds: string[]): ZoneType {
	const first = candidateIds[0];
	if (!first) return 'battlefield';
	if (player.hand.some((c) => c.instanceId === first)) return 'hand';
	if (player.graveyard.some((c) => c.instanceId === first)) return 'graveyard';
	if (player.exile.some((c) => c.instanceId === first)) return 'exile';
	if (player.library.some((c) => c.instanceId === first)) return 'library';
	if (player.command.some((c) => c.instanceId === first)) return 'command';
	return 'battlefield';
}

/** Determines the semantic purpose of a prompt (whether created generically or with a legacy kind). */
export function effectivePromptPurpose(prompt: PendingPrompt): PromptPurpose {
	if (prompt.purpose) return prompt.purpose;
	switch (prompt.kind) {
		case 'mulligan':
		case 'london_bottom':
		case 'discard_to_hand_size':
		case 'commander_zone_choice':
		case 'search_library':
		case 'scry_choice':
		case 'guided_resolution':
		case 'legend_rule':
		case 'cost_choice':
			return prompt.kind;
		default:
			return 'generic';
	}
}

/**
 * Returns the `ChoiceRequest` descriptor for any `PendingPrompt`, synthesizing one if a test
 * pushed a legacy prompt literal without an explicit `choice` field.
 */
export function effectivePromptChoice(prompt: PendingPrompt, state?: GameState): ChoiceRequest {
	if (prompt.choice) return prompt.choice;
	const actor = state?.players.find((p) => p.playerId === prompt.playerId);

	switch (prompt.kind) {
		case 'mulligan':
		case 'commander_zone_choice':
		case 'guided_resolution':
		case 'yesNo':
			return {
				kind: 'yesNo',
				question: prompt.description || prompt.title
			};

		case 'london_bottom':
		case 'discard_to_hand_size': {
			const req = prompt.countRequired ?? 1;
			const candidates =
				prompt.candidateInstanceIds ?? (actor ? actor.hand.map((c) => c.instanceId) : []);
			return {
				kind: 'chooseObjects',
				candidates,
				min: req,
				max: req,
				zone: 'hand',
				reason: prompt.description || prompt.title
			};
		}

		case 'legend_rule': {
			const candidates =
				prompt.candidateInstanceIds ?? (actor ? actor.battlefield.map((c) => c.instanceId) : []);
			return {
				kind: 'chooseObjects',
				candidates,
				min: 1,
				max: 1,
				zone: 'battlefield',
				reason: prompt.description || prompt.title
			};
		}

		case 'search_library': {
			const libOwner =
				state?.players.find(
					(p) => p.playerId === (prompt.targetLibraryOwnerId || prompt.playerId)
				) ?? actor;
			const candidates =
				prompt.candidateInstanceIds ?? (libOwner ? libOwner.library.map((c) => c.instanceId) : []);
			const canFail = prompt.canFailToFind !== false;
			return {
				kind: 'chooseObjects',
				candidates,
				min: canFail ? 0 : 1,
				max: 1,
				zone: 'library',
				reason: prompt.description || prompt.title
			};
		}

		case 'scry_choice':
		case 'orderObjects': {
			const objectIds =
				prompt.candidateInstanceIds ?? (actor ? actor.library.map((c) => c.instanceId) : []);
			return {
				kind: 'orderObjects',
				objectIds,
				allowSplitBottom: prompt.allowBottom !== false,
				allowShuffle: Boolean(prompt.allowShuffle),
				reason: prompt.description || prompt.title
			};
		}

		case 'cost_choice': {
			if (prompt.costQuestion?.kind === 'option' || prompt.costOptionLabels) {
				const labels = prompt.costOptionLabels ?? [];
				const isOptional =
					labels.length === 2 &&
					(prompt.description.toLowerCase().includes('optional') || labels[1] === '');
				if (isOptional) {
					return {
						kind: 'yesNo',
						question: prompt.description || prompt.title
					};
				}
				return {
					kind: 'chooseMode',
					modes: labels,
					min: 1,
					max: 1
				};
			}
			const req = prompt.countRequired ?? 1;
			const cands = prompt.candidateInstanceIds ?? [];
			return {
				kind: 'chooseObjects',
				candidates: cands,
				min: req,
				max: req,
				zone: actor ? inferObjectsZone(actor, cands) : 'battlefield',
				reason: prompt.description || prompt.title
			};
		}

		case 'chooseObjects':
			return {
				kind: 'chooseObjects',
				candidates: prompt.candidateInstanceIds ?? [],
				min: prompt.countRequired ?? 1,
				max: prompt.countRequired ?? 1,
				zone: prompt.destinationZone ?? 'battlefield',
				reason: prompt.description || prompt.title
			};

		case 'chooseMode':
			return {
				kind: 'chooseMode',
				modes: prompt.costOptionLabels ?? [],
				min: 1,
				max: 1
			};

		case 'chooseNumber':
			return {
				kind: 'chooseNumber',
				min: 0,
				max: prompt.countRequired ?? 0,
				reason: prompt.description || prompt.title
			};

		case 'chooseReplacement':
			return {
				kind: 'chooseReplacement',
				options: []
			};
	}
}

/** Validates a `ChoiceAnswer` against its `ChoiceRequest`. */
export function validateChoiceAnswer(
	choice: ChoiceRequest,
	answer: ChoiceAnswer | undefined
): { ok: true } | { ok: false; error: string } {
	if (!answer) {
		return { ok: false, error: 'Missing choice answer.' };
	}
	if (choice.kind !== answer.kind) {
		return {
			ok: false,
			error: `Expected a ${choice.kind} choice answer, got ${answer.kind}.`
		};
	}

	switch (choice.kind) {
		case 'yesNo': {
			const a = answer as Extract<ChoiceAnswer, { kind: 'yesNo' }>;
			if (typeof a.yes !== 'boolean') {
				return { ok: false, error: 'Yes/No answer must provide a boolean `yes` field.' };
			}
			return { ok: true };
		}

		case 'chooseObjects': {
			const a = answer as Extract<ChoiceAnswer, { kind: 'chooseObjects' }>;
			if (!Array.isArray(a.objectIds)) {
				return { ok: false, error: 'Object choice must provide an `objectIds` array.' };
			}
			if (new Set(a.objectIds).size !== a.objectIds.length) {
				return { ok: false, error: 'Duplicate object IDs are not allowed.' };
			}
			// Special case: if min > 0 but there are 0 candidates available (e.g. empty library on mandatory tutor), allow []
			if (choice.candidates.length === 0 && a.objectIds.length === 0) {
				return { ok: true };
			}
			if (a.objectIds.length < choice.min || a.objectIds.length > choice.max) {
				if (choice.min === choice.max) {
					return { ok: false, error: `Please select exactly ${choice.min} object(s).` };
				}
				return {
					ok: false,
					error: `Please select between ${choice.min} and ${choice.max} object(s).`
				};
			}
			const allowed = new Set(choice.candidates);
			for (const id of a.objectIds) {
				if (!allowed.has(id)) {
					return {
						ok: false,
						error: 'Strict Rules Violation: Chosen object is not an eligible candidate.'
					};
				}
			}
			return { ok: true };
		}

		case 'chooseMode': {
			const a = answer as Extract<ChoiceAnswer, { kind: 'chooseMode' }>;
			if (!Array.isArray(a.indices)) {
				return { ok: false, error: 'Mode choice must provide an `indices` array.' };
			}
			if (new Set(a.indices).size !== a.indices.length) {
				return { ok: false, error: 'Cannot choose the same mode multiple times.' };
			}
			if (a.indices.length < choice.min || a.indices.length > choice.max) {
				return { ok: false, error: 'Choose the required number of modes.' };
			}
			for (const idx of a.indices) {
				if (!Number.isInteger(idx) || idx < 0 || idx >= choice.modes.length) {
					return { ok: false, error: `Mode index ${idx} is out of range.` };
				}
			}
			return { ok: true };
		}

		case 'chooseNumber': {
			const a = answer as Extract<ChoiceAnswer, { kind: 'chooseNumber' }>;
			if (typeof a.n !== 'number' || !Number.isInteger(a.n)) {
				return { ok: false, error: 'Number choice must be an integer.' };
			}
			if (a.n < choice.min || a.n > choice.max) {
				return {
					ok: false,
					error: `Chosen number ${a.n} must be between ${choice.min} and ${choice.max}.`
				};
			}
			return { ok: true };
		}

		case 'orderObjects': {
			const a = answer as Extract<ChoiceAnswer, { kind: 'orderObjects' }>;
			if (!Array.isArray(a.topIds)) {
				return { ok: false, error: 'Order choice must provide `topIds`.' };
			}
			const bottomIds = a.bottomIds ?? [];
			if (!Array.isArray(bottomIds)) {
				return { ok: false, error: '`bottomIds` must be an array when provided.' };
			}
			if (choice.allowSplitBottom === false && bottomIds.length > 0) {
				return { ok: false, error: 'Putting cards on the bottom is not allowed for this choice.' };
			}
			if (!choice.allowShuffle && a.shuffle) {
				return { ok: false, error: 'Shuffling is not allowed for this choice.' };
			}
			const seen = new Set<string>();
			const allowed = new Set(choice.objectIds);
			for (const id of [...a.topIds, ...bottomIds]) {
				if (seen.has(id)) {
					return { ok: false, error: 'Duplicate object ID in ordered list.' };
				}
				seen.add(id);
				if (allowed.size > 0 && !allowed.has(id)) {
					return { ok: false, error: `Object ${id} is not part of this ordering choice.` };
				}
			}
			return { ok: true };
		}

		case 'chooseReplacement': {
			const a = answer as Extract<ChoiceAnswer, { kind: 'chooseReplacement' }>;
			if (typeof a.id !== 'string' || !choice.options.some((opt) => opt.id === a.id)) {
				return { ok: false, error: 'Please select a valid replacement effect option.' };
			}
			return { ok: true };
		}
	}
}

export interface NormalizedChoiceAction {
	promptId: string;
	answer?: ChoiceAnswer;
	cancel?: boolean;
	operations?: GuidedOperation[];
}

/**
 * Converts either `{ type: 'choice' }` or a legacy prompt-response action payload into a single
 * normalized choice structure. Returns `null` if `action` does not apply to `prompt`.
 */
export function normalizePromptAction(
	prompt: PendingPrompt,
	action: GameActionPayload,
	state?: GameState
): NormalizedChoiceAction | null {
	const choice = effectivePromptChoice(prompt, state);
	const purpose = effectivePromptPurpose(prompt);

	if (action.type === 'choice') {
		// Allow answering a yesNo cost_choice with chooseMode or vice versa
		let answer = action.answer;
		if (purpose === 'cost_choice' && answer) {
			if (choice.kind === 'yesNo' && answer.kind === 'chooseMode' && answer.indices.length === 1) {
				const idx = answer.indices[0];
				if (idx === 0 || idx === 1) {
					answer = { kind: 'yesNo', yes: idx === 0 };
				}
			} else if (choice.kind === 'chooseMode' && answer.kind === 'yesNo') {
				answer = { kind: 'chooseMode', indices: [answer.yes ? 0 : 1] };
			}
		}
		return {
			promptId: action.promptId,
			answer,
			cancel: action.cancel,
			operations: action.operations
		};
	}

	switch (action.type) {
		case 'mulligan_keep':
			if (purpose !== 'mulligan') return null;
			return { promptId: prompt.id, answer: { kind: 'yesNo', yes: true } };

		case 'mulligan_take':
			if (purpose !== 'mulligan') return null;
			return { promptId: prompt.id, answer: { kind: 'yesNo', yes: false } };

		case 'london_bottom':
			if (purpose !== 'london_bottom') return null;
			return {
				promptId: prompt.id,
				answer: { kind: 'chooseObjects', objectIds: action.instanceIds ?? [] }
			};

		case 'cost_choice': {
			if (purpose !== 'cost_choice') return null;
			if (action.cancel) {
				return { promptId: action.promptId, cancel: true };
			}
			if (prompt.costQuestion?.kind === 'option') {
				if (action.option === undefined) {
					return { promptId: action.promptId, answer: undefined };
				}
				if (choice.kind === 'yesNo') {
					if (action.option === 0 || action.option === 1) {
						return {
							promptId: action.promptId,
							answer: { kind: 'yesNo', yes: action.option === 0 }
						};
					}
					return {
						promptId: action.promptId,
						answer: { kind: 'chooseMode', indices: [action.option] }
					};
				}
				return {
					promptId: action.promptId,
					answer: { kind: 'chooseMode', indices: [action.option] }
				};
			}
			return {
				promptId: action.promptId,
				answer: { kind: 'chooseObjects', objectIds: action.instanceIds ?? [] }
			};
		}

		case 'commander_zone_choice':
		case 'commander_zone_decision':
			if (purpose !== 'commander_zone_choice') return null;
			return {
				promptId: prompt.id,
				answer: { kind: 'yesNo', yes: Boolean(action.sendToCommandZone) }
			};

		case 'discard_cards':
		case 'discard_hand_size':
			if (purpose !== 'discard_to_hand_size') return null;
			return {
				promptId: prompt.id,
				answer: { kind: 'chooseObjects', objectIds: action.instanceIds ?? [] }
			};

		case 'search_library_pick':
			if (purpose !== 'search_library') return null;
			return {
				promptId: prompt.id,
				answer: {
					kind: 'chooseObjects',
					objectIds: action.instanceId === null ? [] : [action.instanceId]
				}
			};

		case 'scry_resolve':
		case 'scry_decision':
			if (purpose !== 'scry_choice') return null;
			return {
				promptId: prompt.id,
				answer: {
					kind: 'orderObjects',
					topIds: action.topInstanceIds ?? [],
					bottomIds: action.bottomInstanceIds ?? [],
					shuffle: action.shuffleAfter
				}
			};

		case 'legend_rule_choice':
		case 'legend_rule_keep':
			if (purpose !== 'legend_rule') return null;
			return {
				promptId: prompt.id,
				answer: { kind: 'chooseObjects', objectIds: [action.keepInstanceId] }
			};

		case 'guided_resolve':
		case 'guided_resolution_finish':
			if (purpose !== 'guided_resolution') return null;
			return {
				promptId: prompt.id,
				answer: { kind: 'yesNo', yes: true },
				operations: action.operations ?? []
			};

		default:
			return null;
	}
}

/**
 * Computes a deterministic bot answer for any of the 6 generic choice shapes.
 */
export function chooseBotAnswer(
	state: GameState,
	player: PlayerGameState,
	prompt: PendingPrompt
): ChoiceAnswer {
	const choice = effectivePromptChoice(prompt, state);
	const purpose = effectivePromptPurpose(prompt);

	switch (choice.kind) {
		case 'yesNo': {
			if (purpose === 'cost_choice') {
				return { kind: 'yesNo', yes: false };
			}
			return { kind: 'yesNo', yes: true };
		}

		case 'chooseObjects': {
			const count = choice.min > 0 ? choice.min : Math.min(1, choice.candidates.length);
			const byId = new Map<string, CardInstance>();
			for (const p of state.players) {
				for (const z of [p.battlefield, p.hand, p.graveyard, p.exile, p.library, p.command]) {
					for (const c of z) byId.set(c.instanceId, c);
				}
			}
			const sorted = [...choice.candidates].sort((idA, idB) => {
				const a = byId.get(idA);
				const b = byId.get(idB);
				if (!a || !b) return 0;
				if (a.isToken !== b.isToken) return a.isToken ? -1 : 1;
				return a.card.cmc - b.card.cmc;
			});
			return {
				kind: 'chooseObjects',
				objectIds: sorted.slice(0, count)
			};
		}

		case 'chooseMode': {
			const indices: number[] = [];
			const count = Math.min(Math.max(1, choice.min), choice.modes.length);
			for (let i = 0; i < count; i++) indices.push(i);
			return { kind: 'chooseMode', indices };
		}

		case 'chooseNumber':
			return { kind: 'chooseNumber', n: choice.max };

		case 'orderObjects': {
			const libMap = new Map(player.library.map((c) => [c.instanceId, c]));
			const cards = choice.objectIds
				.map((id) => libMap.get(id))
				.filter((c): c is CardInstance => Boolean(c));
			const landCount =
				player.battlefield.filter((b) => b.card.typeLine.includes('Land')).length +
				player.hand.filter((h) => h.card.typeLine.includes('Land')).length;

			if (choice.allowSplitBottom !== false) {
				const topIds: string[] = [];
				const bottomIds: string[] = [];
				for (const c of cards) {
					const isLand = c.card.typeLine.includes('Land');
					if ((landCount >= 4 && isLand) || (landCount < 3 && !isLand && c.card.cmc > 4)) {
						bottomIds.push(c.instanceId);
					} else {
						topIds.push(c.instanceId);
					}
				}
				return { kind: 'orderObjects', topIds, bottomIds, shuffle: false };
			}

			const ordered = [...cards].sort((a, b) => {
				const aLand = a.card.typeLine.includes('Land') ? 1 : 0;
				const bLand = b.card.typeLine.includes('Land') ? 1 : 0;
				return landCount < 3 ? bLand - aLand : aLand - bLand;
			});
			return {
				kind: 'orderObjects',
				topIds: ordered.map((c) => c.instanceId),
				bottomIds: [],
				shuffle: false
			};
		}

		case 'chooseReplacement':
			return {
				kind: 'chooseReplacement',
				id: choice.options[0]?.id ?? ''
			};
	}
}
