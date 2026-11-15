import { shuffleWith, uid, type RngHolder } from './random.ts';
import { compileCard } from '../compiler/index.ts';
import { enqueueChoicePrompt, registerPromptHandler } from './choices.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import {
	createEmptyCounterMap,
	type CardInstance,
	type CounterType,
	type GameState,
	type PlayerGameState,
	type ZoneType
} from '../types.ts';
import { emitEvent, type LeftBattlefieldInfo } from './events.ts';
import { instanceFaceOptions, resolveObjectFaces } from './faces.ts';
import { noteLayerInputsChanged, whileLayerInputsChange, withStableLayerInputs } from './layerCache.ts';
import {
	counterMultiplier,
	applySelfEtbReplacements,
	cardEntersTapped,
	placeRegisteredCounters,
	resolveZoneChangeReplacements,
	selfEtbChoiceSpec,
	type SelfEtbChoiceSpec
} from './replace.ts';
import { matchesObjectFilter } from './objectFilter.ts';
// --- Track P8 ---
import {
	applyCopiedPermanentToInstance,
	botShouldPayShocklandLife,
	findLegalCloneCandidates,
	findSelfCloneReplacementSpec,
	markHandCardRevealedToAll,
	playerCantPayLifeForEtb,
	type SelfCloneReplacementSpec
} from './staticsLayersAndRestrictions.ts';
import {
	buildColorChoiceOptions,
	buildCreatureSubtypeOptions,
	chooseBotBestColor,
	chooseBotBestCreatureSubtype,
	COLOR_CODE_BY_LABEL
} from './tuckFreezeChosen.ts';
import { flushTriggers, stashPreLeaveGrantedTriggers } from './triggers.ts';
// --- Track P7 ---
import {
	recordZoneChangeTurnHistory,
	shouldExileInsteadOfDying
} from './copyPreventionAndEffects.ts';
// --- Track P9 ---
import {
	applyBotWave3EtbChoices,
	applyWave3EtbCounters,
	cardHasMadness,
	extractGrantedDeathKeywords,
	nextWave3EtbChoice
} from './keywordsWave3.ts';
// --- Track P12 ---
import {
	applyWave4EtbCountersAndSetup,
	executeDevourSacrifices,
	findDevourKeywordDef,
	legalDevourSacrificeCandidates
} from './keywordsWave4.ts';
// --- End Track P12 ---
// --- Track P11 ---
import {
	boardMayNeedControllerSync,
	buildCardNameChoiceOptions,
	chooseBotBestCardName,
	collectExternalEtbCounters,
	externalPermanentEntersTapped,
	peekPreLeaveGrantedReplacements,
	stashPreLeaveGrantedReplacements
} from './staticsDynamicAndCosts.ts';
// --- End Track P11 ---

/**
 * The single zone-change module (ENGINE_ARCHITECTURE_PLAN.md section 2.3, Phase 2).
 *
 * This is the only runtime file allowed to add cards to or remove cards from a player's zones; the
 * architecture ratchet enforces that. Every zone change goes through `moveObject`, which emits
 * exactly one ZoneChange event. Reordering a zone (shuffles, scry, graveyard order) and removing
 * objects from the game (token clean-up, a player leaving) aren't zone changes; they use the other
 * helpers here and emit nothing.
 *
 * Phase 2 is behaviour-preserving. The old zone-change sites didn't agree on bookkeeping (some bump
 * objectVersion, some assign a timestamp, some do both or neither), so moveObject does nothing
 * implicitly: each caller states what its site did. Unifying these is rules work for later phases.
 */

export type PlayerZone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command';

export interface ZoneLocation {
	player: PlayerGameState;
	zone: PlayerZone;
}

type InsertAt = 'end' | 'start' | number | 'deferred';

export interface MoveOptions {
	/**
	 * Where the object is now.
	 * - `{ player, zone }`: remove the first entry with this instanceId from that player's zone.
	 * - `'anyBattlefield'`: remove it from every player's battlefield (the object may be controlled
	 *   by someone other than its owner).
	 * - `'stack'`: a spell leaving the stack. Spells live on the stack as StackItems, so there's
	 *   nothing to remove; the caller passes the object that represents the card afterwards.
	 * - `'none'`: the object is new (a token being created).
	 * Moving to `'stack'` removes the object from its zone and inserts it nowhere; the caller pushes
	 * the StackItem.
	 */
	from: ZoneLocation | 'anyBattlefield' | 'stack' | 'none';
	/** Whose zone receives the object. Defaults to its owner. */
	toPlayer?: PlayerGameState;
	/**
	 * Array position in the receiving zone: 'end' (push; default), 'start' (unshift) or an index.
	 * The top of a library is index 0; the top of a graveyard is the end. A function picks the
	 * position from the actual destination (after replacement effects). 'deferred' removes the
	 * object and does the bookkeeping now but inserts it nowhere; the caller must put it in place
	 * later with `placeDeferred`. (A bot's "search, shuffle, then put the cards on top" needs the
	 * cards out of the library while it shuffles and while ETB triggers from the same search run.)
	 */
	insert?: InsertAt | ((dest: ZoneType) => InsertAt);
	/** Increment objectVersion (CR 400.7 new object). */
	bumpVersion?: boolean;
	/** Assign a fresh enteredTimestamp via allocateTimestamp. */
	newTimestamp?: boolean;
	/** Set `obj.zone` to the destination (default true). */
	setZone?: boolean;
	/** Set `obj.controllerId`. */
	controllerId?: string;
	/**
	 * Apply the "leaves the battlefield" reset that movePermanentToZone always did: clear the copy
	 * effect, untap, clear damage, temporary modifiers, granted keywords, attachment, counters,
	 * phasing and suspend flags. (The controller is *not* reset.)
	 */
	leaveBattlefieldReset?: boolean;
	/** Clear `attachedToId` on every battlefield permanent attached to this object. */
	detachAttachments?: boolean;
	/** If the destination is the graveyard, apply graveyard replacement effects (Rest in Peace). */
	graveyardReplacement?: boolean;
	/** CR 903.9b as the engine applies it: a bot's commander going to hand or library goes to the command zone. */
	commanderRedirect?: boolean;
	/**
	 * The object leaves its zone but isn't put anywhere: 'tokens' for tokens leaving the battlefield
	 * (CR 111.7), 'always' when the caller wants the object gone (Treasure sacrificed for mana).
	 */
	ceaseToExist?: 'tokens' | 'always';
	/**
	 * Runs after all bookkeeping, just before the object is inserted. For sites that computed
	 * something (e.g. haste) with the object in that in-between state.
	 */
	beforeInsert?: (obj: CardInstance, dest: ZoneType) => void;
	/** Suppress ZoneChange event emission when false (e.g. pregame mulligan). */
	emit?: boolean;
	/** Optional SBA log metadata so deferred zone-replacement moves log only when the move finishes. */
	sbaLog?: SbaMoveLog;
	/** Stack item/step context propagated into downstream commander_zone_choice prompts. */
	resumeStackItemId?: string;
	resumeStepIndex?: number;
	/**
	 * When set, emits a `CardDiscarded` event once the discard move finishes (including after any
	 * graveyard replacement choice; CR 702.29c–d).
	 */
	discardReason?: 'discard' | 'cycle';
	/** Player who discarded the card (defaults to `fromPlayerId ?? obj.ownerId`). */
	discardPlayerId?: string;
	// --- Track P9 ---
	/** CR 614.1c: Counters the object enters the battlefield with (e.g. Undying / Persist). */
	withCounters?: { counter: CounterType; count: number };
	/**
	 * When true, defers linked-exile one-shot returns (`CR 610.3`) to the caller (used by SBA
	 * multi-object batching so simultaneous battlefield returns happen after all SBA deaths settle).
	 */
	skipLinkedReturn?: boolean;
	// --- Track P10 ---
	/** Player who sacrificed this permanent (`CR 701.21a`), emitting a `Sacrificed` event. */
	sacrificedByPlayerId?: string;
	/** Suppresses per-card `GraveyardLeaveBatch` when a caller emits a single batch event for simultaneous graveyard leaves. */
	suppressGraveyardLeaveBatch?: boolean;
	// --- End Track P10 ---
}

export interface SbaMoveLog {
	kind: 'dying' | 'legend' | 'aura' | 'saga';
	controllerId: string;
	controllerUsername: string;
	legName?: string;
}

export type MoveResult = ZoneType | 'pending';

export function allocateTimestamp(state: GameState): number {
	state.nextTimestamp = (state.nextTimestamp || 100) + 1;
	return state.nextTimestamp;
}

// --- Track P9 ---
/**
 * CR 702.30a Echo: Monotonic clock independent of CR 613 `state.nextTimestamp` so tracking upkeep
 * boundaries and permanent control-gain never perturbs continuous-effect timestamps.
 */
export function allocateEchoTick(state: GameState): number {
	state.echoClock = (state.echoClock ?? 0) + 1;
	return state.echoClock;
}

/**
 * CR 614.12 look-ahead helper: evaluates `fn` while `obj` is hypothetically present in
 * `ctrl.battlefield` so entering-the-battlefield replacement checks stay inside `zones.ts`.
 */
export function withHypotheticalBattlefieldPresence<T>(
	state: GameState,
	ctrl: PlayerGameState,
	obj: CardInstance,
	fn: () => T
): T {
	const alreadyOnBf = ctrl.battlefield.includes(obj);
	const prevZone = obj.zone;
	const prevCtrl = obj.controllerId;
	obj.zone = 'battlefield';
	obj.controllerId = ctrl.playerId;
	if (!alreadyOnBf) ctrl.battlefield.push(obj);
	noteLayerInputsChanged(state);
	try {
		return fn();
	} finally {
		if (!alreadyOnBf) {
			const idx = ctrl.battlefield.lastIndexOf(obj);
			if (idx >= 0) ctrl.battlefield.splice(idx, 1);
		}
		obj.zone = prevZone;
		obj.controllerId = prevCtrl;
		noteLayerInputsChanged(state);
	}
}

export function createEmptyCounters(): Record<CounterType, number> {
	// --- Track P11 ---
	return createEmptyCounterMap();
	// --- End Track P11 ---
}

/** Shuffles a copy of `items` with the game's seeded generator (ENGINE_INVARIANTS.md 7.2). */
export function shuffleArray<T>(holder: RngHolder, items: T[]): T[] {
	return shuffleWith(holder, items);
}

function removeFirst(list: CardInstance[], instanceId: string): boolean {
	const idx = list.findIndex((c) => c.instanceId === instanceId);
	if (idx < 0) return false;
	list.splice(idx, 1);
	return true;
}

function insertInto(
	list: CardInstance[],
	obj: CardInstance,
	at: Exclude<InsertAt, 'deferred'> | undefined
): void {
	if (at === undefined || at === 'end') list.push(obj);
	else if (at === 'start') list.unshift(obj);
	else list.splice(at, 0, obj);
}

/**
 * Performs one zone change and emits one ZoneChange event. Returns the zone the object actually
 * went to (after replacement effects), or `'pending'` when the move pauses for a human replacement
 * choice (CR 616.1).
 */
export function moveObject(
	state: GameState,
	obj: CardInstance,
	to: ZoneType,
	opts: MoveOptions
): MoveResult {
	// Phase 6c: a zone change ends any layer-cache stable-input scope's trust (no-op outside one).
	return whileLayerInputsChange(state, () => moveObjectInner(state, obj, to, opts));
}

function pushSbaLog(
	state: GameState,
	obj: CardInstance,
	dest: ZoneType,
	replacedBy: string | null,
	sbaLog: SbaMoveLog
): void {
	let text: string;
	if (sbaLog.kind === 'dying') {
		if (dest === 'exile') {
			text = `${obj.card.name} was exiled instead of dying${replacedBy ? ` (${replacedBy})` : ''} (State-Based Action).`;
		} else if (dest === 'graveyard') {
			text = `${obj.card.name} died (State-Based Action).`;
		} else {
			text = `${obj.card.name} was put into ${dest} instead of dying${replacedBy ? ` (${replacedBy})` : ''} (State-Based Action).`;
		}
	} else if (sbaLog.kind === 'saga') {
		text = `Saga SBA (CR 704.5s): ${obj.card.name} was sacrificed into ${sbaLog.controllerUsername}'s ${dest}${replacedBy ? ` (${replacedBy})` : ''}.`;
	} else {
		text = `Legend Rule (CR 704.5j): Duplicate ${sbaLog.legName ?? obj.card.name} was put into ${sbaLog.controllerUsername}'s ${dest}.`;
	}
	state.log.push({
		id: uid('log', state),
		timestamp: Date.now(),
		turn: state.turnNumber,
		phase: state.phase,
		actorId: sbaLog.controllerId,
		kind: 'sba',
		text
	});
	if (state.log.length > 160) {
		state.log.shift();
	}
}

function pushEtbRuleLog(state: GameState, actorId: string, text: string): void {
	state.log.push({
		id: uid('log', state),
		timestamp: Date.now(),
		turn: state.turnNumber,
		phase: state.phase,
		actorId,
		kind: 'rule',
		text
	});
	if (state.log.length > 160) {
		state.log.shift();
	}
}

function ensureCopiedPlaneswalkerStartingLoyalty(state: GameState, obj: CardInstance): void {
	const bfView = resolveObjectFaces(
		effectiveCardForObject(obj),
		instanceFaceOptions(obj, 'battlefield')
	);
	if (
		!bfView.isFaceDown &&
		bfView.types.includes('Planeswalker') &&
		bfView.loyalty !== undefined &&
		(obj.counters.loyalty || 0) === 0
	) {
		const baseLoyalty = bfView.loyalty;
		if (baseLoyalty > 0) {
			const mult = counterMultiplier(state, obj, 'loyalty');
			obj.counters.loyalty = baseLoyalty * mult;
		}
	}
}

function enqueueNextEtbChoicePrompt(
	state: GameState,
	obj: CardInstance,
	chooser: PlayerGameState,
	spec: SelfEtbChoiceSpec | null,
	baseData: Record<string, unknown>,
	// --- Track P8 ---
	cloneSpec?: SelfCloneReplacementSpec | null
): boolean {
	const objName = resolveObjectFaces(
		effectiveCardForObject(obj),
		instanceFaceOptions(obj, 'battlefield')
	).name;
	// --- Track P8: Non-stack Generalized Clone self-ETB choice ---
	if (cloneSpec && !baseData.cloneAnswered) {
		const candidates = findLegalCloneCandidates(state, chooser.playerId, obj, cloneSpec.copyOf);
		if (candidates.length > 0) {
			const description = cloneSpec.copyOptional
				? `You may have ${objName} enter the battlefield as a copy of a legal permanent on the battlefield (CR 707.5).`
				: `Choose a permanent on the battlefield for ${objName} to enter as a copy of (CR 707.5).`;
			enqueueChoicePrompt(state, {
				id: uid('prm', state),
				playerId: chooser.playerId,
				kind: 'chooseObjects',
				purpose: 'etb_choice',
				title: `${objName} — Choose Permanent to Copy`,
				description,
				continuation: {
					kind: 'handler',
					name: 'etb_choice',
					data: {
						...baseData,
						choiceField: 'cloneCopy'
					}
				},
				choice: {
					kind: 'chooseObjects',
					candidates: candidates.map((c) => c.instanceId),
					defaultObjectIds: [candidates[0].instanceId],
					min: cloneSpec.copyOptional ? 0 : 1,
					max: 1,
					zone: 'battlefield',
					reason: description
				}
			});
			return true;
		}
	}
	if (spec?.chooseColor && !obj.chosenColor) {
		const { labels } = buildColorChoiceOptions(spec.chooseColor.exclude);
		const description = `As ${objName} enters the battlefield, choose a color${spec.chooseColor.exclude ? ` other than ${spec.chooseColor.exclude}` : ''} (CR 105.4, 614.12):`;
		enqueueChoicePrompt(state, {
			id: uid('prm', state),
			playerId: chooser.playerId,
			kind: 'chooseMode',
			purpose: 'etb_choice',
			title: `${objName} — Choose a Color`,
			description,
			continuation: {
				kind: 'handler',
				name: 'etb_choice',
				data: {
					...baseData,
					choiceField: 'color'
				}
			},
			choice: {
				kind: 'chooseMode',
				modes: labels,
				min: 1,
				max: 1
			}
		});
		return true;
	}
	if (spec?.chooseSubType === 'creature' && !obj.chosenSubType) {
		const subtypeLabels = buildCreatureSubtypeOptions(state, chooser, obj);
		const description = `As ${objName} enters the battlefield, choose a creature type (CR 205.3m, 614.12):`;
		enqueueChoicePrompt(state, {
			id: uid('prm', state),
			playerId: chooser.playerId,
			kind: 'chooseMode',
			purpose: 'etb_choice',
			title: `${objName} — Choose a Creature Type`,
			description,
			continuation: {
				kind: 'handler',
				name: 'etb_choice',
				data: {
					...baseData,
					choiceField: 'creatureSubtype'
				}
			},
			choice: {
				kind: 'chooseMode',
				modes: subtypeLabels,
				min: 1,
				max: 1
			}
		});
		return true;
	}
	// --- Track P11: Choose Card Name & Choose Counter ETB choices (CR 201.2a, 614.12) ---
	if (spec?.chooseCardName && !obj.chosenCardName) {
		const cardNameLabels = buildCardNameChoiceOptions(
			state,
			chooser,
			obj,
			Boolean(spec.chooseCardName.nonlandOnly)
		);
		const qualifier = spec.chooseCardName.nonlandOnly ? 'nonland card name' : 'card name';
		const description = `As ${objName} enters the battlefield, choose a ${qualifier} (CR 201.2a, 614.12):`;
		enqueueChoicePrompt(state, {
			id: uid('prm', state),
			playerId: chooser.playerId,
			kind: 'chooseMode',
			purpose: 'etb_choice',
			title: `${objName} — Choose a Card Name`,
			description,
			continuation: {
				kind: 'handler',
				name: 'etb_choice',
				data: {
					...baseData,
					choiceField: 'cardName'
				}
			},
			choice: {
				kind: 'chooseMode',
				modes: cardNameLabels,
				min: 1,
				max: 1
			}
		});
		return true;
	}
	if (spec?.chooseCounter && spec.chooseCounter.length > 0 && !obj.etbCounterChoiceDone) {
		const counterOptions = spec.chooseCounter;
		const description = `As ${objName} enters the battlefield, choose a counter to put on it (CR 122.1b, 614.12):`;
		enqueueChoicePrompt(state, {
			id: uid('prm', state),
			playerId: chooser.playerId,
			kind: 'chooseMode',
			purpose: 'etb_choice',
			title: `${objName} — Choose a Counter`,
			description,
			continuation: {
				kind: 'handler',
				name: 'etb_choice',
				data: {
					...baseData,
					choiceField: 'etbCounter',
					counterOptions
				}
			},
			choice: {
				kind: 'chooseMode',
				modes: counterOptions.map((c) => `Enter with a ${c} counter`),
				min: 1,
				max: 1
			}
		});
		return true;
	}
	// --- End Track P11 ---
	// --- Track P8: Shocklands (`As ~ enters, you may pay N life. If you don't, it enters tapped.`) ---
	if (spec?.payLifeOrEnterTapped !== undefined && !baseData.shocklandAnswered) {
		const lifeCost = spec.payLifeOrEnterTapped;
		if (playerCantPayLifeForEtb(state, chooser, lifeCost)) {
			obj.tapped = true;
		} else if (!obj.tapped) {
			const description = `As ${objName} enters the battlefield, pay ${lifeCost} life? If you don't, ${objName} enters tapped (CR 614.12).`;
			enqueueChoicePrompt(state, {
				id: uid('prm', state),
				playerId: chooser.playerId,
				kind: 'yesNo',
				purpose: 'etb_choice',
				title: `${objName} — Pay ${lifeCost} Life?`,
				description,
				yesLabel: `Pay ${lifeCost} life (enter untapped)`,
				noLabel: 'Enter tapped',
				continuation: {
					kind: 'handler',
					name: 'etb_choice',
					data: {
						...baseData,
						choiceField: 'payLifeOrEnterTapped',
						lifeCost
					}
				},
				choice: {
					kind: 'yesNo',
					question: description
				}
			});
			return true;
		}
	}
	// --- Track P8: Reveal lands (`As ~ enters, you may reveal a <filter> card from your hand. If you don't, ~ enters tapped.`) ---
	if (spec?.revealFromHandOrEnterTapped && !baseData.revealLandAnswered) {
		const revealCandidates = chooser.hand.filter(
			(c) =>
				c.instanceId !== obj.instanceId &&
				matchesObjectFilter(c, spec.revealFromHandOrEnterTapped!, {
					state,
					controllerId: chooser.playerId,
					source: obj,
					zone: 'hand'
				})
		);
		if (revealCandidates.length === 0) {
			obj.tapped = true;
		} else if (!obj.tapped) {
			const description = `As ${objName} enters the battlefield, you may reveal a matching card from your hand. If you don't, ${objName} enters tapped (CR 614.12, 701.20a).`;
			enqueueChoicePrompt(state, {
				id: uid('prm', state),
				playerId: chooser.playerId,
				kind: 'chooseObjects',
				purpose: 'etb_choice',
				title: `${objName} — Reveal a Card from Hand?`,
				description,
				continuation: {
					kind: 'handler',
					name: 'etb_choice',
					data: {
						...baseData,
						choiceField: 'revealFromHandOrEnterTapped'
					}
				},
				choice: {
					kind: 'chooseObjects',
					candidates: revealCandidates.map((c) => c.instanceId),
					defaultObjectIds: [revealCandidates[0].instanceId],
					min: 0,
					max: 1,
					zone: 'hand',
					reason: description
				}
			});
			return true;
		}
	}
	// --- Track P9 ---
	const wave3Choice = nextWave3EtbChoice(state, obj, chooser);
	if (wave3Choice?.kind === 'unleash') {
		const description = `As ${objName} enters the battlefield, you may have it enter with a +1/+1 counter on it (CR 702.98a). It can't block as long as it has a +1/+1 counter on it.`;
		enqueueChoicePrompt(state, {
			id: uid('prm', state),
			playerId: chooser.playerId,
			kind: 'chooseMode',
			purpose: 'etb_choice',
			title: `${objName} — Unleash`,
			description,
			continuation: {
				kind: 'handler',
				name: 'etb_choice',
				data: {
					...baseData,
					choiceField: 'unleash'
				}
			},
			choice: {
				kind: 'chooseMode',
				modes: ['Enter with a +1/+1 counter (Unleash)', 'Enter without a +1/+1 counter'],
				min: 1,
				max: 1
			}
		});
		return true;
	}
	if (wave3Choice?.kind === 'riot') {
		const suffix =
			(wave3Choice.riotTotal ?? 1) > 1
				? ` (${wave3Choice.riotIndex}/${wave3Choice.riotTotal})`
				: '';
		const description = `As ${objName} enters the battlefield, choose one for Riot${suffix} (CR 702.136a):`;
		enqueueChoicePrompt(state, {
			id: uid('prm', state),
			playerId: chooser.playerId,
			kind: 'chooseMode',
			purpose: 'etb_choice',
			title: `${objName} — Riot${suffix}`,
			description,
			continuation: {
				kind: 'handler',
				name: 'etb_choice',
				data: {
					...baseData,
					choiceField: 'riot'
				}
			},
			choice: {
				kind: 'chooseMode',
				modes: ['Enter with a +1/+1 counter', 'Gain haste'],
				min: 1,
				max: 1
			}
		});
		return true;
	}
	// --- Track P12: Devour (CR 702.82a) ---
	const devourKw = findDevourKeywordDef(obj);
	if (devourKw && obj.devouredCount === undefined) {
		const devourCands = legalDevourSacrificeCandidates(
			state,
			obj,
			chooser.playerId,
			devourKw,
			matchesObjectFilter
		);
		if (devourCands.length > 0) {
			const nLabel = devourKw.devourX ? 'X' : String(devourKw.n ?? 1);
			const description = `As ${objName} enters the battlefield, you may sacrifice any number of matching permanents for Devour ${nLabel} (CR 702.82a).`;
			enqueueChoicePrompt(state, {
				id: uid('prm', state),
				playerId: chooser.playerId,
				kind: 'chooseObjects',
				purpose: 'etb_choice',
				title: `${objName} — Devour ${nLabel}`,
				description,
				candidateInstanceIds: devourCands.map((c) => c.instanceId),
				countRequired: 0,
				continuation: {
					kind: 'handler',
					name: 'etb_choice',
					data: {
						...(baseData as Record<string, string | number | boolean | null | string[] | Record<string, number>>),
						choiceField: 'devour'
					}
				},
				choice: {
					kind: 'chooseObjects',
					candidates: devourCands.map((c) => c.instanceId),
					min: 0,
					max: devourCands.length,
					zone: 'battlefield',
					reason: `Choose permanents to sacrifice for ${objName}'s Devour ${nLabel}.`
				}
			});
			return true;
		}
		obj.devouredCount = 0;
	}
	// --- End Track P12 ---
	return false;
}

function finalizeZoneMove(
	state: GameState,
	obj: CardInstance,
	fromZone: ZoneType | null,
	fromPlayerId: string | null,
	receiver: PlayerGameState,
	initialDest: ZoneType,
	initialShuffle: boolean,
	replacedBy: string | null,
	lki: LeftBattlefieldInfo | undefined,
	opts: MoveOptions
): MoveResult {
	const owner = state.players.find((p) => p.playerId === obj.ownerId);
	let dest: ZoneType = initialDest;
	let shuffleDestLibrary = initialShuffle;
	let effectiveReplacedBy = replacedBy;
	let promptCommanderRedirect = false;

	// CR 702.84a: "If it would leave the battlefield, exile it instead of putting it anywhere else."
	// Note: an effect already moving it directly to 'exile' is NOT replaced (CR 702.84a ruling).
	if (fromZone === 'battlefield' && obj.unearthLeaveExile && dest !== 'exile' && dest !== 'battlefield') {
		dest = 'exile';
		shuffleDestLibrary = false;
		effectiveReplacedBy = effectiveReplacedBy ?? 'Unearth';
	}
	// --- Track P7 (CR 614.1a): "If that creature would die this turn, exile it instead." ---
	if (fromZone === 'battlefield' && dest === 'graveyard' && shouldExileInsteadOfDying(state, obj)) {
		dest = 'exile';
		shuffleDestLibrary = false;
		effectiveReplacedBy = effectiveReplacedBy ?? 'Exile instead of dying';
	}
	// --- End Track P7 ---
	// --- Track P11 (CR 122.1d): Finality counter exiles instead of dying ---
	if (
		fromZone === 'battlefield' &&
		dest === 'graveyard' &&
		((lki?.counters?.finality ?? 0) > 0 || (obj.counters.finality ?? 0) > 0)
	) {
		dest = 'exile';
		shuffleDestLibrary = false;
		effectiveReplacedBy = effectiveReplacedBy ?? 'Finality counter';
	}
	// --- End Track P11 ---

	if (
		opts.commanderRedirect &&
		obj.isCommander &&
		(dest === 'hand' || dest === 'library')
	) {
		if (owner?.isBot) {
			dest = 'command';
			shuffleDestLibrary = false;
		} else if (owner) {
			promptCommanderRedirect = true;
		}
	}

	// CR 400.3: A card moving to hand, graveyard, library, or command zone always goes to its owner's zone.
	const effectiveReceiver =
		(dest === 'hand' ||
			dest === 'graveyard' ||
			dest === 'library' ||
			dest === 'command' ||
			(dest === 'exile' && effectiveReplacedBy === 'Madness')) &&
		owner
			? owner
			: receiver;

	const leavingFaceDownLabel =
		fromZone === 'battlefield' && dest !== 'battlefield' && obj.isFaceDown
			? (obj.faceDownLabel || 'Face-Down Permanent')
			: null;

	if (opts.leaveBattlefieldReset) {
		if (obj.printedCard) {
			obj.card = obj.printedCard;
			obj.printedCard = undefined;
		}
		if (obj.copiableCard) obj.copiableCard = undefined;
		obj.copiableState = undefined;
	}
	if (opts.setZone !== false) obj.zone = dest;
	if (opts.leaveBattlefieldReset) {
		obj.controllerId = obj.ownerId;
		obj.tapped = false;
		obj.damageMarked = 0;
		obj.deathtouchDamageMarked = false;
		obj.tempPowerMod = 0;
		obj.tempToughnessMod = 0;
		obj.grantedKeywords = [];
		obj.attachedToId = null;
		obj.counters = createEmptyCounters();
		obj.phasedOut = false;
		obj.phasedOutIndirectly = false;
		obj.isSuspended = false;
		obj.castViaSuspend = false;
		obj.switchedPTCount = 0;
		obj.usedLoyaltyThisTurn = false;
		obj.activatedAbilityIdsThisTurn = undefined;
		obj.usedModalModesThisTurn = undefined;
		obj.transformed = false;
		obj.activeFaceIndex = undefined;
		obj.unlockedFaces = undefined;
		obj.isFaceDown = false;
		obj.faceDownSpec = undefined;
		obj.faceDownLabel = undefined;
		obj.goadedByPlayerIds = undefined;
		obj.goadExpirations = undefined;
		obj.playableFromExileBy = undefined;
		obj.enteredWithX = undefined;
		obj.kickedCount = undefined;
		obj.kickedTags = undefined;
		obj.kickedTagCounts = undefined;
		obj.prototyped = undefined;
		obj.evoked = undefined;
		obj.escaped = undefined;
		obj.manaColorsSpent = undefined;
		obj.foretold = undefined;
		obj.blitzed = undefined;
		obj.saddledThisTurn = undefined;
		obj.saddledThisTurnByIds = undefined;
		obj.unearthLeaveExile = undefined;
		obj.regenerationShields = undefined;
		obj.cantBeRegeneratedThisTurn = undefined;
		obj.crewedThisTurnByIds = undefined;
		obj.defaultControllerId = undefined;
		// --- Track P4 (CR 400.7) ---
		obj.doesntUntapNextUntapStep = undefined;
		obj.exertedThisTurn = undefined;
		obj.chosenSubType = undefined;
		obj.chosenColor = undefined;
		// --- Track P5 (CR 701.37b / 400.7) ---
		obj.isMonstrous = undefined;
		obj.monstrosityX = undefined;
		// --- Track P7 (CR 400.7) ---
		obj.wasCast = undefined;
		obj.castFromZone = undefined;
		// --- Track P14 (CR 400.7 / 723.3b) ---
		obj.isPrepared = undefined;
		// --- End Track P14 ---
		// --- Track P9 (CR 400.7) ---
		obj.cameUnderControlAt = undefined;
		obj.dashed = undefined;
		obj.riotHaste = undefined;
		obj.riotChoicesDone = undefined;
		obj.unleashChoiceDone = undefined;
		// --- Track P10 (CR 400.7) ---
		obj.isSuspected = undefined;
		obj.detainedByPlayerIds = undefined;
		obj.damagedByThisTurn = undefined;
		obj.manaSpentCount = undefined;
		// --- End Track P10 ---
		// --- Track P11 (CR 400.7) ---
		obj.chosenCardName = undefined;
		obj.etbCounterChoiceDone = undefined;
		obj.counterTimestamps = undefined;
		// --- End Track P11 ---
		// --- Track P14 (CR 400.7 / 723.3b) ---
		obj.isPrepared = undefined;
		// --- End Track P14 ---
		const prevObjVersion = obj.objectVersion || 1;
		const pruneLeftPerm = <T extends { affected: Array<{ instanceId: string; objectVersion?: number }> }>(
			list: T[] | undefined
		): T[] | undefined => {
			if (!list || list.length === 0) return list;
			const next: T[] = [];
			for (const eff of list) {
				const remaining = eff.affected.filter(
					(a) => !(a.instanceId === obj.instanceId && (a.objectVersion === undefined || a.objectVersion === prevObjVersion))
				);
				if (remaining.length > 0) {
					next.push(remaining.length === eff.affected.length ? eff : { ...eff, affected: remaining });
				}
			}
			return next.length > 0 ? next : undefined;
		};
		state.timedContinuousEffects = pruneLeftPerm(state.timedContinuousEffects);
		state.timedKeywordEffects = pruneLeftPerm(state.timedKeywordEffects);
	}
	if (dest !== 'battlefield') {
		obj.kickedCount = undefined;
		obj.kickedTags = undefined;
		obj.kickedTagCounts = undefined;
		obj.evoked = undefined;
		obj.escaped = undefined;
		obj.foretold = undefined;
		obj.blitzed = undefined;
		obj.saddledThisTurn = undefined;
		obj.saddledThisTurnByIds = undefined;
		obj.unearthLeaveExile = undefined;
		obj.defaultControllerId = undefined;
		// --- Track P4 (CR 400.7) ---
		obj.doesntUntapNextUntapStep = undefined;
		obj.exertedThisTurn = undefined;
		obj.chosenSubType = undefined;
		obj.chosenColor = undefined;
		// --- Track P5 (CR 701.37b / 400.7) ---
		obj.isMonstrous = undefined;
		obj.monstrosityX = undefined;
		// --- Track P7 (CR 400.7) ---
		obj.wasCast = undefined;
		obj.castFromZone = undefined;
		// --- Track P14 (CR 400.7 / 723.3b) ---
		obj.isPrepared = undefined;
		// --- End Track P14 ---
		// --- Track P9 (CR 400.7) ---
		obj.cameUnderControlAt = undefined;
		obj.riotHaste = undefined;
		obj.riotChoicesDone = undefined;
		obj.unleashChoiceDone = undefined;
		// --- Track P10 (CR 400.7) ---
		obj.isSuspected = undefined;
		obj.detainedByPlayerIds = undefined;
		obj.damagedByThisTurn = undefined;
		// --- End Track P10 ---
		// --- Track P12 (CR 400.7 / 717.2b / 720.3b) ---
		obj.classLevel = undefined;
		obj.isSolved = undefined;
		obj.isRenowned = undefined;
		obj.isBestowed = undefined;
		obj.exhaustedAbilityIds = undefined;
		obj.creatureAttackedThisTurn = undefined;
		obj.devouredCount = undefined;
		obj.encoreMustAttackPlayerId = undefined;
		// --- End Track P12 ---
		// --- Track P11 (CR 400.7) ---
		obj.chosenCardName = undefined;
		obj.etbCounterChoiceDone = undefined;
		obj.counterTimestamps = undefined;
		// --- End Track P11 ---
		// --- Track P14 (CR 400.7 / 723.3b) ---
		obj.isPrepared = undefined;
		// --- End Track P14 ---
		if (dest !== 'stack') {
			obj.manaColorsSpent = undefined;
			// --- Track P10 ---
			obj.manaSpentCount = undefined;
			// --- End Track P10 ---
			obj.dashed = undefined;
			obj.prototyped = undefined;
			obj.activeFaceIndex = undefined;
			obj.transformed = false;
		}
	}
	if (opts.controllerId !== undefined) obj.controllerId = opts.controllerId;
	const leavingVersion = obj.objectVersion || 1;
	if (fromZone === 'exile') {
		// CR 400.7: Leaving exile clears linked-exile, foretell, plot, warp, and until-source-leaves tracking.
		obj.exiledBy = undefined;
		obj.untilSourceLeavesReturn = undefined;
		if (dest !== 'exile') {
			obj.madnessOwnerId = undefined;
			obj.foretoldByPlayerId = undefined;
			obj.foretoldTurnNumber = undefined;
			obj.plottedByPlayerId = undefined;
			obj.plottedTurnNumber = undefined;
			obj.warpedByOwnerId = undefined;
			obj.warpedTurnSerial = undefined;
			if (dest !== 'battlefield' && dest !== 'stack' && obj.isFaceDown) {
				obj.isFaceDown = false;
				obj.faceDownSpec = undefined;
				obj.faceDownLabel = undefined;
			}
		}
	}
	if (fromZone !== dest) {
		// CR 400.7 / CR 701.20d: Zone change creates a new object and clears revealed-hand visibility
		// as well as any once-per-turn trigger tracking in the destination zone (CR 603.2i).
		obj.knownToPlayerIds = undefined;
		// --- Track P12 ---
		obj.discardedByPlayerIdThisTurn = undefined;
		obj.discardedTurnSerial = undefined;
		// --- End Track P12 ---
		if (state.triggeredOnceThisTurn?.length) {
			const prefix = `${obj.instanceId}:${dest}:`;
			const remaining = state.triggeredOnceThisTurn.filter((k) => !k.startsWith(prefix));
			state.triggeredOnceThisTurn = remaining.length > 0 ? remaining : undefined;
		}
	}
	if (opts.bumpVersion) obj.objectVersion = (obj.objectVersion || 1) + 1;
	if (opts.newTimestamp) obj.enteredTimestamp = allocateTimestamp(state);
	// CR 306.5b: A planeswalker entering the battlefield receives starting loyalty counters (with counter multipliers).
	if (dest === 'battlefield') {
		if (!obj.defaultControllerId) {
			obj.defaultControllerId = opts.controllerId ?? effectiveReceiver.playerId;
		}
		const bfView = resolveObjectFaces(
			effectiveCardForObject(obj),
			instanceFaceOptions(obj, 'battlefield')
		);
		if (
			!bfView.isFaceDown &&
			bfView.types.includes('Planeswalker') &&
			bfView.loyalty !== undefined &&
			(obj.counters.loyalty || 0) === 0
		) {
			const baseLoyalty = bfView.loyalty;
			if (baseLoyalty > 0) {
				const mult = counterMultiplier(state, obj, 'loyalty');
				obj.counters.loyalty = baseLoyalty * mult;
			}
		}
	}
	opts.beforeInsert?.(obj, dest);

	const ceases =
		opts.ceaseToExist === 'always' ||
		(opts.ceaseToExist === 'tokens' && obj.isToken && dest !== 'battlefield');
	const isEnteringBattlefield =
		dest === 'battlefield' &&
		!ceases &&
		(fromZone !== 'battlefield' || Boolean(opts.leaveBattlefieldReset));
	let wave3ExtraCounters = 0;
	// --- Track P11 ---
	let chosenEtbCounter: CounterType | undefined;
	// --- End Track P11 ---
	if (isEnteringBattlefield) {
		// --- Track P9 ---
		obj.cameUnderControlAt = allocateEchoTick(state);
		obj.lastKnownCounters = undefined;
		obj.lastKnownPower = undefined;
		obj.lastKnownToughness = undefined;
	}
	if (isEnteringBattlefield && !obj.isFaceDown) {
		const ctrlId = opts.controllerId ?? obj.controllerId ?? effectiveReceiver.playerId;
		const ctrl = state.players.find((p) => p.playerId === ctrlId) ?? effectiveReceiver;
		obj.controllerId = ctrl.playerId;

		const buildPendingEtbData = (): Record<string, unknown> => {
			const resolvedInsert = typeof opts.insert === 'function' ? opts.insert(dest) : opts.insert;
			const insertSpec =
				typeof resolvedInsert === 'number' ||
				resolvedInsert === 'start' ||
				resolvedInsert === 'end' ||
				resolvedInsert === 'deferred'
					? resolvedInsert
					: 'end';
			return {
				objectId: obj.instanceId,
				toPlayerId: effectiveReceiver.playerId,
				fromZone,
				fromPlayerId,
				lkiJson: lki ? JSON.stringify(lki) : null,
				setZone: opts.setZone !== false,
				emit: opts.emit !== false,
				insertSpec,
				sbaLogJson: opts.sbaLog ? JSON.stringify(opts.sbaLog) : null,
				replacedBy: effectiveReplacedBy,
				wave3ExtraCounters: 0,
				withCountersJson: opts.withCounters ? JSON.stringify(opts.withCounters) : null,
				...(opts.resumeStackItemId ? { resumeStackItemId: opts.resumeStackItemId } : {}),
				...(opts.resumeStepIndex !== undefined ? { resumeStepIndex: opts.resumeStepIndex } : {})
			};
		};

		// --- Track P8: Non-stack Generalized Clone self-ETB replacement (CR 707.5, 707.9) ---
		if (fromZone !== 'stack' && !obj.copiableState && !obj.copiableCard) {
			const cloneSpec = findSelfCloneReplacementSpec(
				effectiveCardForObject(obj),
				instanceFaceOptions(obj, 'battlefield')
			);
			if (cloneSpec) {
				const cloneCandidates = findLegalCloneCandidates(
					state,
					ctrl.playerId,
					obj,
					cloneSpec.copyOf
				);
				if (cloneCandidates.length > 0) {
					if (ctrl.isBot) {
						const origCard = obj.printedCard ?? obj.card;
						const displayName = applyCopiedPermanentToInstance(
							obj,
							cloneCandidates[0],
							cloneSpec.copyModifications,
							origCard,
							state
						);
						if (cloneSpec.tapped) obj.tapped = true;
						ensureCopiedPlaneswalkerStartingLoyalty(state, obj);
						applySelfEtbReplacements(state, obj);
						pushEtbRuleLog(
							state,
							ctrl.playerId,
							`${origCard.name} entered the battlefield as a copy of ${displayName} (CR 707.2).`
						);
					} else {
						const baseData = buildPendingEtbData();
						if (enqueueNextEtbChoicePrompt(state, obj, ctrl, null, baseData, cloneSpec)) {
							obj.zone = fromZone ?? 'hand';
							(state.pendingZoneMoves ??= []).push(obj);
							return 'pending';
						}
					}
				}
			}
		}

		// --- Track P8: Conditional ETB tapped duals (Fast, Slow, Check, Tango, Crowd) ---
		if (!obj.tapped && cardEntersTapped(effectiveCardForObject(obj), state, ctrl.playerId, obj)) {
			obj.tapped = true;
		}
		// --- Track P11 (CR 614.12): External enters-tapped replacements ---
		if (
			!obj.tapped &&
			withHypotheticalBattlefieldPresence(state, ctrl, obj, () =>
				externalPermanentEntersTapped(state, obj, ctrl.playerId)
			)
		) {
			obj.tapped = true;
		}
		// --- End Track P11 ---

		const etbSpec = selfEtbChoiceSpec(state, obj);
		if (ctrl.isBot) {
			if (etbSpec) {
				if (etbSpec.chooseColor && !obj.chosenColor) {
					obj.chosenColor = chooseBotBestColor(state, ctrl, etbSpec.chooseColor.exclude, obj);
				}
				if (etbSpec.chooseSubType === 'creature' && !obj.chosenSubType) {
					obj.chosenSubType = chooseBotBestCreatureSubtype(state, ctrl, obj);
				}
				// --- Track P11 ---
				if (etbSpec.chooseCardName && !obj.chosenCardName) {
					obj.chosenCardName = chooseBotBestCardName(
						state,
						ctrl,
						obj,
						Boolean(etbSpec.chooseCardName.nonlandOnly)
					);
				}
				if (
					etbSpec.chooseCounter &&
					etbSpec.chooseCounter.length > 0 &&
					!obj.etbCounterChoiceDone
				) {
					obj.etbCounterChoiceDone = true;
					chosenEtbCounter = etbSpec.chooseCounter[0];
				}
				// --- End Track P11 ---
				if (etbSpec.payLifeOrEnterTapped !== undefined) {
					const lifeCost = etbSpec.payLifeOrEnterTapped;
					const objName = resolveObjectFaces(
						effectiveCardForObject(obj),
						instanceFaceOptions(obj, 'battlefield')
					).name;
					if (
						!playerCantPayLifeForEtb(state, ctrl, lifeCost) &&
						!obj.tapped &&
						botShouldPayShocklandLife(state, ctrl, obj, lifeCost)
					) {
						ctrl.life -= lifeCost;
						noteLayerInputsChanged(state);
						pushEtbRuleLog(
							state,
							ctrl.playerId,
							`${ctrl.username} paid ${lifeCost} life for ${objName}.`
						);
					} else {
						obj.tapped = true;
					}
				}
				if (etbSpec.revealFromHandOrEnterTapped) {
					const revealCandidates = ctrl.hand.filter(
						(c) =>
							c.instanceId !== obj.instanceId &&
							matchesObjectFilter(c, etbSpec.revealFromHandOrEnterTapped!, {
								state,
								controllerId: ctrl.playerId,
								source: obj,
								zone: 'hand'
							})
					);
					if (revealCandidates.length > 0 && !obj.tapped) {
						const objName = resolveObjectFaces(
							effectiveCardForObject(obj),
							instanceFaceOptions(obj, 'battlefield')
						).name;
						markHandCardRevealedToAll(state, revealCandidates[0]);
						pushEtbRuleLog(
							state,
							ctrl.playerId,
							`${ctrl.username} revealed ${revealCandidates[0].card.name} from hand for ${objName}.`
						);
					} else {
						obj.tapped = true;
					}
				}
			}
			const botWave3 = applyBotWave3EtbChoices(state, obj, ctrl);
			wave3ExtraCounters = botWave3.unleashCounters + botWave3.riotCounters;
			// --- Track P12 ---
			const botDevourKw = findDevourKeywordDef(obj);
			if (botDevourKw && obj.devouredCount === undefined) {
				const dCands = legalDevourSacrificeCandidates(
					state,
					obj,
					ctrl.playerId,
					botDevourKw,
					matchesObjectFilter
				);
				const fodder = dCands.filter((c) => c.isToken).map((c) => c.instanceId);
				if (fodder.length > 0) {
					executeDevourSacrifices(state, obj, ctrl, fodder);
				} else {
					obj.devouredCount = 0;
				}
			}
			// --- End Track P12 ---
		} else {
			const baseData = buildPendingEtbData();
			if (enqueueNextEtbChoicePrompt(state, obj, ctrl, etbSpec, baseData, null)) {
				obj.zone = fromZone ?? 'hand';
				(state.pendingZoneMoves ??= []).push(obj);
				return 'pending';
			}
		}
	}
	if (dest !== 'stack' && !ceases) {
		const at = typeof opts.insert === 'function' ? opts.insert(dest) : opts.insert;
		if (at !== 'deferred') insertInto(effectiveReceiver[dest as PlayerZone], obj, at);
		// --- Track P12 ---
		if (dest === 'graveyard' && fromZone !== 'graveyard') {
			state.cardsPutIntoGraveyardThisTurn = (state.cardsPutIntoGraveyardThisTurn ?? 0) + 1;
			noteLayerInputsChanged(state);
		}
		// --- End Track P12 ---
		if (isEnteringBattlefield) {
			if (opts.withCounters && opts.withCounters.count > 0) {
				placeRegisteredCounters(state, obj, opts.withCounters.counter, opts.withCounters.count);
			}
			if (!obj.isFaceDown) {
				applyWave3EtbCounters(state, obj, placeRegisteredCounters, wave3ExtraCounters);
				// --- Track P11 ---
				if (chosenEtbCounter) {
					placeRegisteredCounters(state, obj, chosenEtbCounter, 1);
				}
				const extEtbCounters = collectExternalEtbCounters(
					state,
					obj,
					obj.controllerId || effectiveReceiver.playerId
				);
				for (const ec of extEtbCounters) {
					placeRegisteredCounters(state, obj, ec.counter, ec.amount);
				}
				// --- End Track P11 ---
			}
			// --- Track P12 ---
			applyWave4EtbCountersAndSetup(state, obj, placeRegisteredCounters);
			// --- End Track P12 ---
			noteLayerInputsChanged(state);
		}
		if (shuffleDestLibrary && dest === 'library') {
			shuffleLibrary(state, effectiveReceiver);
		}
	}
	if (opts.sbaLog) {
		pushSbaLog(state, obj, dest, effectiveReplacedBy, opts.sbaLog);
	}
	if (leavingFaceDownLabel) {
		state.log.push({
			id: uid('log', state),
			timestamp: Date.now(),
			turn: state.turnNumber,
			phase: state.phase,
			actorId: obj.ownerId,
			kind: 'rule',
			text: `CR 708.9: ${leavingFaceDownLabel} left the battlefield and is revealed as ${(obj.printedCard ?? obj.card).name}.`
		});
		if (state.log.length > 160) {
			state.log.shift();
		}
	}
	// --- Track P7: record Morbid / Revolt / LTB pruning BEFORE emitting ZoneChange triggers ---
	const wasCreatureOnBf = Boolean(lki?.typeLine && lki.typeLine.split(/[\s—]+/).includes('Creature'));
	recordZoneChangeTurnHistory(
		state,
		fromZone ?? 'none',
		dest,
		lki?.controllerId ?? fromPlayerId ?? obj.ownerId,
		wasCreatureOnBf,
		obj
	);
	// --- End Track P7 ---
	// --- Track P12: CR 702.187b–c Mayhem discard tracking ---
	if (opts.discardReason && dest === 'graveyard' && !ceases) {
		obj.discardedByPlayerIdThisTurn = opts.discardPlayerId ?? fromPlayerId ?? obj.ownerId;
		obj.discardedTurnSerial = state.turnSerial ?? state.turnNumber;
	}
	// --- End Track P12 ---
	if (opts.emit !== false) {
		emitZoneChange(
			state,
			obj,
			fromZone,
			dest,
			fromPlayerId,
			dest === 'stack' || ceases ? null : effectiveReceiver.playerId,
			ceases,
			lki
		);
		if (opts.discardReason) {
			emitEvent(state, {
				kind: 'CardDiscarded',
				playerId: opts.discardPlayerId ?? fromPlayerId ?? obj.ownerId,
				objectId: obj.instanceId,
				object: obj,
				reason: opts.discardReason,
				destZone: dest
			});
		}
		// --- Track P10 ---
		if (fromZone === 'battlefield' && opts.sacrificedByPlayerId && lki) {
			emitEvent(state, {
				kind: 'Sacrificed',
				playerId: opts.sacrificedByPlayerId,
				objectId: obj.instanceId,
				object: obj,
				lki
			});
		}
		if (fromZone === 'graveyard' && dest !== 'graveyard' && !opts.suppressGraveyardLeaveBatch) {
			emitEvent(state, {
				kind: 'GraveyardLeaveBatch',
				ownerId: fromPlayerId ?? obj.ownerId,
				objects: [obj]
			});
		}
		// --- End Track P10 ---
		if (dest === 'battlefield' && fromZone !== 'battlefield' && !ceases) {
			maybePlaceSagaEtbLoreCounter(state, obj);
		}
	}
	if (
		promptCommanderRedirect &&
		owner &&
		!ceases &&
		!state.pendingPrompts.some(
			(pr) => pr.kind === 'commander_zone_choice' && pr.commanderInstanceId === obj.instanceId
		)
	) {
		const description = `${obj.card.name} was put into your ${dest}. Under Commander Rule 903.9b, you may move it to the Command Zone instead.`;
		enqueueChoicePrompt(state, {
			id: uid('prm', state),
			playerId: owner.playerId,
			kind: 'commander_zone_choice',
			purpose: 'commander_zone_choice',
			title: 'Return Commander to Command Zone?',
			description,
			commanderInstanceId: obj.instanceId,
			destinationZone: dest,
			yesLabel: 'Yes — Move to Command Zone',
			noLabel: `No — Leave in ${dest}`,
			continuation: {
				kind: 'procedure',
				procedure: {
					kind: 'commander_zone_choice',
					commanderInstanceId: obj.instanceId,
					destinationZone: dest,
					...(opts.resumeStackItemId ? { resumeStackItemId: opts.resumeStackItemId } : {}),
					...(opts.resumeStepIndex !== undefined ? { resumeStepIndex: opts.resumeStepIndex } : {})
				}
			},
			choice: {
				kind: 'yesNo',
				question: description
			}
		});
	}
	if (fromZone === 'battlefield' && dest !== 'battlefield' && !opts.skipLinkedReturn) {
		returnLinkedExiledForSource(state, obj.instanceId, leavingVersion);
		syncBattlefieldControllers(state);
	}
	return dest;
}

/**
 * CR 610.3: Return all cards in exile whose `untilSourceLeavesReturn` matches
 * `(leavingId, leavingVersion)` immediately after the source permanent leaves the battlefield.
 * Simultaneous battlefield returns are inserted first so ETB triggers see all entrants (CR 610.3d).
 */
export function returnLinkedExiledForSource(
	state: GameState,
	leavingId: string,
	leavingVersion: number
): void {
	returnLinkedExiledForSources(state, [{ leavingId, leavingVersion }]);
}

/**
 * CR 610.3 / 610.3d: Return all cards in exile whose `untilSourceLeavesReturn` matches any of
 * `sources` immediately after those permanents leave the battlefield. All simultaneous battlefield
 * returns are placed onto the battlefield before any `ZoneChange` events are emitted so ETB
 * triggers see every returning permanent (CR 610.3d).
 */
export function returnLinkedExiledForSources(
	state: GameState,
	sources: ReadonlyArray<{ leavingId: string; leavingVersion: number }>
): void {
	if (sources.length === 0) return;
	const linked: Array<{
		card: CardInstance;
		fromPlayer: PlayerGameState;
		returnZone: ZoneType;
	}> = [];
	for (const p of state.players) {
		for (const c of p.exile) {
			const ret = c.untilSourceLeavesReturn;
			if (
				ret &&
				sources.some(
					(s) => ret.sourceInstanceId === s.leavingId && ret.sourceObjectVersion === s.leavingVersion
				)
			) {
				linked.push({ card: c, fromPlayer: p, returnZone: ret.returnZone });
			}
		}
	}
	if (linked.length === 0) return;

	const bfReturns: Array<{ card: CardInstance; fromPlayer: PlayerGameState; ownerPlayer: PlayerGameState }> = [];
	const nonBfReturns: Array<{ card: CardInstance; fromPlayer: PlayerGameState; returnZone: ZoneType }> = [];

	for (const entry of linked) {
		entry.card.exiledBy = undefined;
		entry.card.untilSourceLeavesReturn = undefined;
		// CR 111.8: A token that has left the battlefield cannot return to the battlefield or move zones.
		if (entry.card.isToken) continue;
		if (entry.returnZone === 'battlefield') {
			const ownerPlayer = state.players.find((p) => p.playerId === entry.card.ownerId && !p.lost);
			if (ownerPlayer) bfReturns.push({ card: entry.card, fromPlayer: entry.fromPlayer, ownerPlayer });
		} else {
			nonBfReturns.push(entry);
		}
	}

	const emitAfterAll: Array<{
		card: CardInstance;
		fromPlayerId: string;
		toPlayerId: string;
	}> = [];
	const batchEmit = bfReturns.length > 1;

	for (const { card, fromPlayer, ownerPlayer } of bfReturns) {
		const res = moveObject(state, card, 'battlefield', {
			from: { player: fromPlayer, zone: 'exile' },
			toPlayer: ownerPlayer,
			controllerId: ownerPlayer.playerId,
			bumpVersion: true,
			newTimestamp: true,
			emit: !batchEmit,
			beforeInsert: (returned, d) => {
				if (d === 'battlefield') {
					returned.summoningSick = true;
					applySelfEtbReplacements(state, returned);
				}
			}
		});
		if (res === 'battlefield') {
			state.log.push({
				id: uid('log', state),
				timestamp: Date.now(),
				turn: state.turnNumber,
				phase: state.phase,
				actorId: ownerPlayer.playerId,
				kind: 'rule',
				text: `${card.card.name} returns to the battlefield under ${ownerPlayer.username}'s control (CR 610.3c).`
			});
			if (state.log.length > 160) state.log.shift();
			if (batchEmit) {
				emitAfterAll.push({
					card,
					fromPlayerId: fromPlayer.playerId,
					toPlayerId: ownerPlayer.playerId
				});
			}
		}
	}

	for (const em of emitAfterAll) {
		emitZoneChange(state, em.card, 'exile', 'battlefield', em.fromPlayerId, em.toPlayerId, false);
		maybePlaceSagaEtbLoreCounter(state, em.card);
	}

	for (const { card, fromPlayer, returnZone } of nonBfReturns) {
		if (returnZone === 'stack' || returnZone === 'exile') continue;
		moveObject(state, card, returnZone, {
			from: { player: fromPlayer, zone: 'exile' },
			bumpVersion: true,
			commanderRedirect: true,
			emit: true
		});
	}
}

function moveObjectInner(
	state: GameState,
	obj: CardInstance,
	to: ZoneType,
	opts: MoveOptions
): MoveResult {
	const { from } = opts;
	// CR 304.4 / 307.4: If an instant or sorcery would enter the battlefield, it remains in its previous zone.
	if (to === 'battlefield') {
		const effectiveTypeLine = resolveObjectFaces(
			effectiveCardForObject(obj),
			instanceFaceOptions(obj, 'battlefield')
		).typeLine;
		const isInstantOrSorcery =
			effectiveTypeLine.includes('Instant') || effectiveTypeLine.includes('Sorcery');
		const hasPermanentType =
			effectiveTypeLine.includes('Creature') ||
			effectiveTypeLine.includes('Artifact') ||
			effectiveTypeLine.includes('Enchantment') ||
			effectiveTypeLine.includes('Land') ||
			effectiveTypeLine.includes('Planeswalker') ||
			effectiveTypeLine.includes('Battle');
		if (isInstantOrSorcery && !hasPermanentType) {
			if (typeof from === 'object') return from.zone;
			if (from === 'anyBattlefield') return 'battlefield';
			if (from === 'stack') return 'stack';
			return obj.zone;
		}
	}
	let fromZone: ZoneType | null = null;
	let fromPlayerId: string | null = null;
	// CR 603.10a: leaves-the-battlefield triggers look back at the object as it was on the battlefield.
	// --- Track P11 ---
	if (from === 'anyBattlefield' || (typeof from === 'object' && from.zone === 'battlefield')) {
		stashPreLeaveGrantedTriggers(state, obj);
		stashPreLeaveGrantedReplacements(state, obj);
	}
	// --- End Track P11 ---
	const lki =
		from === 'anyBattlefield' || (typeof from === 'object' && from.zone === 'battlefield')
			? captureLki(state, obj)
			: undefined;
	if (lki) {
		if (lki.power !== undefined) obj.lastKnownPower = lki.power;
		if (lki.toughness !== undefined) obj.lastKnownToughness = lki.toughness;
		for (const stk of state.stack) {
			if (stk.sourceInstanceId === obj.instanceId) {
				if (lki.power !== undefined) stk.sourceLkiPower = lki.power;
				if (lki.toughness !== undefined) stk.sourceLkiToughness = lki.toughness;
				if (obj.exertedThisTurn) stk.sourceExertedThisTurn = true;
				// --- Track P11 ---
				if (obj.chosenCardName) stk.sourceChosenCardName = obj.chosenCardName;
				// --- End Track P11 ---
			}
			if (
				stk.eventObjectId === obj.instanceId &&
				(stk.eventObjectVersion === undefined || stk.eventObjectVersion === obj.objectVersion)
			) {
				stk.eventLki = {
					controllerId: lki.controllerId,
					ownerId: stk.eventLki?.ownerId ?? obj.ownerId,
					power: lki.power ?? stk.eventLki?.power ?? (parseInt(obj.card.power ?? '0', 10) || 0),
					toughness:
						lki.toughness ??
						stk.eventLki?.toughness ??
						(parseInt(obj.card.toughness ?? '0', 10) || 0),
					manaValue: stk.eventLki?.manaValue ?? (obj.card.cmc ?? 0),
					// --- Track P9 ---
					...(lki.counters
						? { counters: { ...lki.counters } }
						: stk.eventLki?.counters
							? { counters: stk.eventLki.counters }
							: {})
				};
			}
		}
	}

	if (from === 'anyBattlefield') {
		fromZone = 'battlefield';
		for (const p of state.players) {
			const idx = p.battlefield.findIndex((c) => c.instanceId === obj.instanceId);
			if (idx >= 0) {
				p.battlefield.splice(idx, 1);
				fromPlayerId ??= p.playerId;
			}
			if (opts.detachAttachments) detachFrom(p, obj.instanceId);
		}
	} else {
		if (from === 'stack') {
			fromZone = 'stack';
		} else if (from !== 'none') {
			fromZone = from.zone;
			fromPlayerId = from.player.playerId;
			removeFirst(from.player[from.zone], obj.instanceId);
		}
		if (opts.detachAttachments) {
			for (const p of state.players) detachFrom(p, obj.instanceId);
		}
	}

	if (fromZone === 'battlefield') {
		removeFromCombat(state, obj.instanceId);
	}

	const owner = state.players.find((p) => p.playerId === obj.ownerId);
	const receiver = opts.toPlayer ?? owner;
	if (!receiver) {
		// Unreachable in practice (players are never removed from state.players). movePermanentToZone
		// returned here, after removal and before any bookkeeping.
		if (opts.emit !== false) {
			emitZoneChange(state, obj, fromZone, to, fromPlayerId, null, true, lki);
		}
		return to;
	}

	let dest: ZoneType = to;
	let shuffleDestLibrary = false;
	let replacedBy: string | null = null;
	let pendingZoneRep: ReturnType<typeof resolveZoneChangeReplacements> | undefined;
	// --- Track P9 ---
	if (
		fromZone === 'hand' &&
		opts.discardReason &&
		to === 'graveyard' &&
		cardHasMadness(effectiveCardForObject(obj))
	) {
		// CR 702.35a / CR 614.15: Madness self-replacement exiles the discarded card instead of
		// putting it into its owner's graveyard, applying before external graveyard replacements.
		dest = 'exile';
		shuffleDestLibrary = false;
		replacedBy = 'Madness';
		obj.madnessOwnerId = obj.ownerId;
	} else if (fromZone === 'battlefield' && obj.unearthLeaveExile && to !== 'exile' && to !== 'battlefield') {
		// CR 702.84a: "If it would leave the battlefield, exile it instead of putting it anywhere else."
		dest = 'exile';
		shuffleDestLibrary = false;
		replacedBy = 'Unearth';
	} else if (
		// --- Track P7 (CR 614.1a): "If that creature would die this turn, exile it instead." ---
		fromZone === 'battlefield' &&
		to === 'graveyard' &&
		shouldExileInsteadOfDying(state, obj)
		// --- End Track P7 ---
	) {
		dest = 'exile';
		shuffleDestLibrary = false;
		replacedBy = 'Exile instead of dying';
	} else if (
		(opts.graveyardReplacement && (to === 'graveyard' || to === 'exile')) ||
		// --- Track P11 (CR 122.1d, CR 614.12): Finality counter & Layer 6 granted leave replacements ---
		(fromZone === 'battlefield' &&
			to === 'graveyard' &&
			((obj.counters.finality ?? 0) > 0 || peekPreLeaveGrantedReplacements(obj).length > 0))
		// --- End Track P11 ---
	) {
		pendingZoneRep = resolveZoneChangeReplacements(
			state,
			obj,
			fromZone,
			to,
			new Set(),
			Boolean(lki?.lostAllAbilities)
		);
		dest = pendingZoneRep.dest;
		shuffleDestLibrary = pendingZoneRep.shuffle;
		replacedBy = pendingZoneRep.replacedBy ?? null;
	}

	if (
		pendingZoneRep?.pendingOptions &&
		pendingZoneRep.pendingOptions.length >= 2 &&
		opts.ceaseToExist !== 'always'
	) {
		// CR 616.1: Hold the object outside all player zones until the replacement choice is answered
		// so it never lands in the graveyard first and no premature ZoneChange event or trigger fires.
		(state.pendingZoneMoves ??= []).push(obj);
		const insertSpec =
			typeof opts.insert === 'function' ? 'fn_library_start' : (opts.insert ?? 'end');
		const objDisplay = obj.isFaceDown ? (obj.faceDownLabel || 'Face-Down Permanent') : obj.card.name;
		const description = `Multiple replacement effects would modify how ${objDisplay} moves to ${dest}. Choose which applies first (CR 616.1):`;
		enqueueChoicePrompt(state, {
			id: uid('prm', state),
			playerId: pendingZoneRep.chooserId,
			kind: 'chooseReplacement',
			purpose: 'generic',
			title: 'Choose Replacement Effect (CR 616.1)',
			description,
			continuation: {
				kind: 'handler',
				name: 'zone_replacement_choice',
				data: {
					objectId: obj.instanceId,
					toPlayerId: receiver.playerId,
					currentDest: dest,
					shuffle: shuffleDestLibrary,
					replacedBy,
					fromZone,
					fromPlayerId,
					appliedIds: pendingZoneRep.appliedIds,
					lkiJson: lki ? JSON.stringify(lki) : null,
					leaveBattlefieldReset: Boolean(opts.leaveBattlefieldReset),
					controllerId: opts.controllerId ?? null,
					bumpVersion: Boolean(opts.bumpVersion),
					newTimestamp: Boolean(opts.newTimestamp),
					setZone: opts.setZone !== false,
					commanderRedirect: Boolean(opts.commanderRedirect),
					ceaseToExist: opts.ceaseToExist ?? null,
					emit: opts.emit !== false,
					insertSpec,
					sbaLogJson: opts.sbaLog ? JSON.stringify(opts.sbaLog) : null,
					discardReason: opts.discardReason ?? null,
					discardPlayerId: opts.discardPlayerId ?? null,
					// --- Track P10 ---
					sacrificedByPlayerId: opts.sacrificedByPlayerId ?? null,
					suppressGraveyardLeaveBatch: Boolean(opts.suppressGraveyardLeaveBatch)
					// --- End Track P10 ---
				}
			},
			choice: {
				kind: 'chooseReplacement',
				options: pendingZoneRep.pendingOptions.map((r) => ({ id: r.id, label: r.label }))
			}
		});
		return 'pending';
	}

	return finalizeZoneMove(
		state,
		obj,
		fromZone,
		fromPlayerId,
		receiver,
		dest,
		shuffleDestLibrary,
		replacedBy,
		lki,
		opts
	);
}

registerPromptHandler('zone_replacement_choice', (state, prompt, answer) => {
	if (answer.kind !== 'chooseReplacement') return;
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	if (!data) return;
	const objectId = typeof data.objectId === 'string' ? data.objectId : '';
	const toPlayerId = typeof data.toPlayerId === 'string' ? data.toPlayerId : '';
	const currentDest = (data.currentDest as ZoneType | undefined) ?? 'graveyard';
	const prevShuffle = Boolean(data.shuffle);
	const prevReplacedBy = typeof data.replacedBy === 'string' ? data.replacedBy : null;
	const fromZone = (data.fromZone as ZoneType | null | undefined) ?? null;
	const fromPlayerId = (data.fromPlayerId as string | null | undefined) ?? null;
	const appliedIds = Array.isArray(data.appliedIds) ? (data.appliedIds as string[]) : [];
	const lkiJson = typeof data.lkiJson === 'string' ? data.lkiJson : null;
	const lki: LeftBattlefieldInfo | undefined = lkiJson ? (JSON.parse(lkiJson) as LeftBattlefieldInfo) : undefined;
	const leaveBattlefieldReset = Boolean(data.leaveBattlefieldReset);
	const controllerId = typeof data.controllerId === 'string' ? data.controllerId : undefined;
	const bumpVersion = Boolean(data.bumpVersion);
	const newTimestamp = Boolean(data.newTimestamp);
	const setZone = data.setZone !== false;
	const commanderRedirect = Boolean(data.commanderRedirect);
	const ceaseToExist =
		data.ceaseToExist === 'tokens' || data.ceaseToExist === 'always'
			? data.ceaseToExist
			: undefined;
	const emit = data.emit !== false;
	const insertSpec = data.insertSpec;
	const sbaLogJson = typeof data.sbaLogJson === 'string' ? data.sbaLogJson : null;
	const sbaLog: SbaMoveLog | undefined = sbaLogJson ? (JSON.parse(sbaLogJson) as SbaMoveLog) : undefined;
	const resumeStackItemId =
		typeof data.resumeStackItemId === 'string' ? data.resumeStackItemId : undefined;
	const resumeStepIndex =
		typeof data.resumeStepIndex === 'number' ? data.resumeStepIndex : undefined;
	const discardReason =
		data.discardReason === 'discard' || data.discardReason === 'cycle'
			? data.discardReason
			: undefined;
	const discardPlayerId =
		typeof data.discardPlayerId === 'string' ? data.discardPlayerId : undefined;
	// --- Track P10 ---
	const sacrificedByPlayerId =
		typeof data.sacrificedByPlayerId === 'string' ? data.sacrificedByPlayerId : undefined;
	const suppressGraveyardLeaveBatch = Boolean(data.suppressGraveyardLeaveBatch);
	// --- End Track P10 ---

	const pendingList = state.pendingZoneMoves;
	if (!pendingList) return;
	const idx = pendingList.findIndex((c) => c.instanceId === objectId);
	if (idx < 0) return;
	const obj = pendingList[idx];

	const owner = state.players.find((p) => p.playerId === obj.ownerId);
	const receiver = state.players.find((p) => p.playerId === toPlayerId) ?? owner;
	if (!receiver) return;

	whileLayerInputsChange(state, () => {
		const nextRes = resolveZoneChangeReplacements(
			state,
			obj,
			fromZone,
			currentDest,
			new Set(appliedIds),
			Boolean(lki?.lostAllAbilities),
			answer.id
		);

		const nextDest = nextRes.dest;
		const nextShuffle = prevShuffle || nextRes.shuffle;
		const nextReplacedBy = nextRes.replacedBy ?? prevReplacedBy;

		if (nextRes.pendingOptions && nextRes.pendingOptions.length >= 2) {
			const description = `Multiple replacement effects would modify how ${obj.card.name} moves to ${nextDest}. Choose which applies next (CR 616.1f):`;
			enqueueChoicePrompt(state, {
				id: uid('prm', state),
				playerId: nextRes.chooserId,
				kind: 'chooseReplacement',
				purpose: 'generic',
				title: 'Choose Replacement Effect (CR 616.1)',
				description,
				continuation: {
					kind: 'handler',
					name: 'zone_replacement_choice',
					data: {
						objectId: obj.instanceId,
						toPlayerId: receiver.playerId,
						currentDest: nextDest,
						shuffle: nextShuffle,
						replacedBy: nextReplacedBy,
						fromZone,
						fromPlayerId,
						appliedIds: nextRes.appliedIds,
						lkiJson,
						leaveBattlefieldReset,
						controllerId: controllerId ?? null,
						bumpVersion,
						newTimestamp,
						setZone,
						commanderRedirect,
						ceaseToExist: ceaseToExist ?? null,
						emit,
						insertSpec,
						sbaLogJson,
						discardReason: discardReason ?? null,
						discardPlayerId: discardPlayerId ?? null,
						// --- Track P10 ---
						sacrificedByPlayerId: sacrificedByPlayerId ?? null,
						suppressGraveyardLeaveBatch,
						// --- End Track P10 ---
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

		pendingList.splice(idx, 1);
		if (pendingList.length === 0) {
			delete state.pendingZoneMoves;
		}

		const insertOpt: MoveOptions['insert'] =
			insertSpec === 'fn_library_start'
				? (actual) => (actual === 'library' ? 'start' : 'end')
				: typeof insertSpec === 'number' ||
					  insertSpec === 'start' ||
					  insertSpec === 'end' ||
					  insertSpec === 'deferred'
					? insertSpec
					: 'end';

		finalizeZoneMove(
			state,
			obj,
			fromZone,
			fromPlayerId,
			receiver,
			nextDest,
			nextShuffle,
			nextReplacedBy,
			lki,
			{
				from: 'none',
				toPlayer: receiver,
				leaveBattlefieldReset,
				controllerId,
				bumpVersion,
				newTimestamp,
				setZone,
				commanderRedirect,
				ceaseToExist,
				emit,
				insert: insertOpt,
				sbaLog,
				...(discardReason ? { discardReason } : {}),
				...(discardPlayerId ? { discardPlayerId } : {}),
				// --- Track P10 ---
				...(sacrificedByPlayerId ? { sacrificedByPlayerId } : {}),
				...(suppressGraveyardLeaveBatch ? { suppressGraveyardLeaveBatch: true } : {}),
				// --- End Track P10 ---
				...(resumeStackItemId ? { resumeStackItemId } : {}),
				...(resumeStepIndex !== undefined ? { resumeStepIndex } : {})
			}
		);
	});
	flushTriggers(state);
});

registerPromptHandler('etb_choice', (state, prompt, answer) => {
	if (
		answer.kind !== 'chooseMode' &&
		answer.kind !== 'yesNo' &&
		answer.kind !== 'chooseObjects'
	) {
		return;
	}
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	if (!data) return;
	const objectId = typeof data.objectId === 'string' ? data.objectId : '';
	const toPlayerId = typeof data.toPlayerId === 'string' ? data.toPlayerId : '';
	const choiceField = typeof data.choiceField === 'string' ? data.choiceField : '';
	const fromZone = (data.fromZone as ZoneType | null | undefined) ?? null;
	const fromPlayerId = (data.fromPlayerId as string | null | undefined) ?? null;
	const lkiJson = typeof data.lkiJson === 'string' ? data.lkiJson : null;
	const lki: LeftBattlefieldInfo | undefined = lkiJson
		? (JSON.parse(lkiJson) as LeftBattlefieldInfo)
		: undefined;
	const setZone = data.setZone !== false;
	const emit = data.emit !== false;
	const insertSpec = data.insertSpec;
	const sbaLogJson = typeof data.sbaLogJson === 'string' ? data.sbaLogJson : null;
	const sbaLog: SbaMoveLog | undefined = sbaLogJson
		? (JSON.parse(sbaLogJson) as SbaMoveLog)
		: undefined;
	const replacedBy = typeof data.replacedBy === 'string' ? data.replacedBy : null;
	let wave3ExtraCounters = typeof data.wave3ExtraCounters === 'number' ? data.wave3ExtraCounters : 0;
	const withCountersJson = typeof data.withCountersJson === 'string' ? data.withCountersJson : null;
	const withCounters: { counter: CounterType; count: number } | undefined = withCountersJson
		? (JSON.parse(withCountersJson) as { counter: CounterType; count: number })
		: undefined;
	const resumeStackItemId =
		typeof data.resumeStackItemId === 'string' ? data.resumeStackItemId : undefined;
	const resumeStepIndex =
		typeof data.resumeStepIndex === 'number' ? data.resumeStepIndex : undefined;

	const pendingList = state.pendingZoneMoves;
	if (!pendingList) return;
	const idx = pendingList.findIndex((c) => c.instanceId === objectId);
	if (idx < 0) return;
	const obj = pendingList[idx];

	const owner = state.players.find((p) => p.playerId === obj.ownerId);
	const receiver = state.players.find((p) => p.playerId === toPlayerId) ?? owner;
	if (!receiver) return;
	const chooser =
		state.players.find((p) => p.playerId === (obj.controllerId || receiver.playerId)) ?? receiver;

	const nextData: Record<string, unknown> = {
		...data,
		objectId: obj.instanceId,
		toPlayerId: receiver.playerId,
		fromZone,
		fromPlayerId,
		lkiJson,
		setZone,
		emit,
		insertSpec,
		sbaLogJson,
		replacedBy,
		wave3ExtraCounters,
		withCountersJson,
		...(resumeStackItemId !== undefined ? { resumeStackItemId } : {}),
		...(resumeStepIndex !== undefined ? { resumeStepIndex } : {})
	};

	let awaitingMore = false;
	whileLayerInputsChange(state, () => {
		let bfView = resolveObjectFaces(
			effectiveCardForObject(obj),
			instanceFaceOptions(obj, 'battlefield')
		);
		if (choiceField === 'cloneCopy' && answer.kind === 'chooseObjects') {
			nextData.cloneAnswered = true;
			const chosenId = answer.objectIds[0];
			if (chosenId) {
				let targetPerm: CardInstance | undefined;
				for (const pl of state.players) {
					if (pl.lost) continue;
					const found = pl.battlefield.find((b) => !b.phasedOut && b.instanceId === chosenId);
					if (found) {
						targetPerm = found;
						break;
					}
				}
				const cloneSpec = findSelfCloneReplacementSpec(
					effectiveCardForObject(obj),
					instanceFaceOptions(obj, 'battlefield')
				);
				if (targetPerm) {
					const origCard = obj.printedCard ?? obj.card;
					const displayName = applyCopiedPermanentToInstance(
						obj,
						targetPerm,
						cloneSpec?.copyModifications,
						origCard,
						state
					);
					if (cloneSpec?.tapped) obj.tapped = true;
					ensureCopiedPlaneswalkerStartingLoyalty(state, obj);
					applySelfEtbReplacements(state, obj);
					if (
						!obj.tapped &&
						cardEntersTapped(effectiveCardForObject(obj), state, chooser.playerId, obj)
					) {
						obj.tapped = true;
					}
					// --- Track P11 (CR 614.12) ---
					if (
						!obj.tapped &&
						withHypotheticalBattlefieldPresence(state, chooser, obj, () =>
							externalPermanentEntersTapped(state, obj, chooser.playerId)
						)
					) {
						obj.tapped = true;
					}
					// --- End Track P11 ---
					bfView = resolveObjectFaces(
						effectiveCardForObject(obj),
						instanceFaceOptions(obj, 'battlefield')
					);
					pushEtbRuleLog(
						state,
						chooser.playerId,
						`${origCard.name} entered the battlefield as a copy of ${displayName} (CR 707.2).`
					);
				}
			}
		} else if (choiceField === 'color' && answer.kind === 'chooseMode') {
			const options = prompt.choice?.kind === 'chooseMode' ? prompt.choice.modes : [];
			const chosenIdx = answer.indices[0] ?? 0;
			const chosenLabel = options[chosenIdx] ?? options[0] ?? '';
			obj.chosenColor = COLOR_CODE_BY_LABEL[chosenLabel.toLowerCase()] ?? 'W';
			pushEtbRuleLog(
				state,
				chooser.playerId,
				`${chooser.username} chose ${chosenLabel} for ${bfView.name}.`
			);
		} else if (choiceField === 'creatureSubtype' && answer.kind === 'chooseMode') {
			const options = prompt.choice?.kind === 'chooseMode' ? prompt.choice.modes : [];
			const chosenIdx = answer.indices[0] ?? 0;
			const chosenLabel = options[chosenIdx] ?? options[0] ?? '';
			obj.chosenSubType = chosenLabel || 'Human';
			pushEtbRuleLog(
				state,
				chooser.playerId,
				`${chooser.username} chose ${chosenLabel} for ${bfView.name}.`
			);
		// --- Track P11 ---
		} else if (choiceField === 'cardName' && answer.kind === 'chooseMode') {
			const options = prompt.choice?.kind === 'chooseMode' ? prompt.choice.modes : [];
			const chosenIdx = answer.indices[0] ?? 0;
			const chosenLabel = options[chosenIdx] ?? options[0] ?? '';
			obj.chosenCardName = chosenLabel || 'Construct';
			pushEtbRuleLog(
				state,
				chooser.playerId,
				`${chooser.username} chose ${obj.chosenCardName} for ${bfView.name}.`
			);
		} else if (choiceField === 'etbCounter' && answer.kind === 'chooseMode') {
			const counterOptions = Array.isArray(data.counterOptions)
				? (data.counterOptions as CounterType[])
				: [];
			const chosenIdx = answer.indices[0] ?? 0;
			const chosenCounter = counterOptions[chosenIdx] ?? counterOptions[0];
			obj.etbCounterChoiceDone = true;
			if (chosenCounter) {
				nextData.chosenEtbCounter = chosenCounter;
				pushEtbRuleLog(
					state,
					chooser.playerId,
					`${chooser.username} chose a ${chosenCounter} counter for ${bfView.name}.`
				);
			}
		// --- End Track P11 ---
		} else if (choiceField === 'payLifeOrEnterTapped' && answer.kind === 'yesNo') {
			nextData.shocklandAnswered = true;
			const lifeCost = typeof data.lifeCost === 'number' ? data.lifeCost : 2;
			if (answer.yes && !playerCantPayLifeForEtb(state, chooser, lifeCost)) {
				chooser.life -= lifeCost;
				noteLayerInputsChanged(state);
				pushEtbRuleLog(
					state,
					chooser.playerId,
					`${chooser.username} paid ${lifeCost} life for ${bfView.name}.`
				);
			} else {
				obj.tapped = true;
				pushEtbRuleLog(
					state,
					chooser.playerId,
					`${chooser.username} chose to have ${bfView.name} enter tapped.`
				);
			}
		} else if (choiceField === 'revealFromHandOrEnterTapped' && answer.kind === 'chooseObjects') {
			nextData.revealLandAnswered = true;
			const chosenId = answer.objectIds[0];
			const revealedCard = chosenId
				? chooser.hand.find((c) => c.instanceId === chosenId)
				: undefined;
			if (revealedCard) {
				markHandCardRevealedToAll(state, revealedCard);
				pushEtbRuleLog(
					state,
					chooser.playerId,
					`${chooser.username} revealed ${revealedCard.card.name} from hand for ${bfView.name}.`
				);
			} else {
				obj.tapped = true;
				pushEtbRuleLog(
					state,
					chooser.playerId,
					`${chooser.username} chose not to reveal a card for ${bfView.name}.`
				);
			}
		} else if (choiceField === 'unleash' && answer.kind === 'chooseMode') {
			const options = prompt.choice?.kind === 'chooseMode' ? prompt.choice.modes : [];
			const chosenIdx = answer.indices[0] ?? 0;
			const chosenLabel = options[chosenIdx] ?? options[0] ?? '';
			obj.unleashChoiceDone = true;
			if (chosenIdx === 0) {
				wave3ExtraCounters += 1;
				nextData.wave3ExtraCounters = wave3ExtraCounters;
			}
			pushEtbRuleLog(
				state,
				chooser.playerId,
				`${chooser.username} chose ${chosenLabel} for ${bfView.name}.`
			);
		} else if (choiceField === 'riot' && answer.kind === 'chooseMode') {
			const options = prompt.choice?.kind === 'chooseMode' ? prompt.choice.modes : [];
			const chosenIdx = answer.indices[0] ?? 0;
			const chosenLabel = options[chosenIdx] ?? options[0] ?? '';
			obj.riotChoicesDone = (obj.riotChoicesDone ?? 0) + 1;
			if (chosenIdx === 0) {
				wave3ExtraCounters += 1;
				nextData.wave3ExtraCounters = wave3ExtraCounters;
			} else {
				obj.riotHaste = true;
			}
			pushEtbRuleLog(
				state,
				chooser.playerId,
				`${chooser.username} chose ${chosenLabel} for ${bfView.name}.`
			);
		// --- Track P12 ---
		} else if (choiceField === 'devour' && answer.kind === 'chooseObjects') {
			executeDevourSacrifices(state, obj, chooser, answer.objectIds);
			pushEtbRuleLog(
				state,
				chooser.playerId,
				`${chooser.username} sacrificed ${obj.devouredCount ?? 0} permanent(s) for ${bfView.name}'s Devour (CR 702.82a).`
			);
		// --- End Track P12 ---
		} else {
			return;
		}

		const remainingSpec = selfEtbChoiceSpec(state, obj);
		if (enqueueNextEtbChoicePrompt(state, obj, chooser, remainingSpec, nextData, null)) {
			awaitingMore = true;
			return;
		}

		pendingList.splice(idx, 1);
		if (pendingList.length === 0) {
			delete state.pendingZoneMoves;
		}

		if (setZone) obj.zone = 'battlefield';
		const at: Exclude<InsertAt, 'deferred'> =
			typeof insertSpec === 'number' || insertSpec === 'start' || insertSpec === 'end'
				? insertSpec
				: 'end';
		if (insertSpec !== 'deferred') {
			insertInto(receiver.battlefield, obj, at);
			if (withCounters && withCounters.count > 0) {
				placeRegisteredCounters(state, obj, withCounters.counter, withCounters.count);
			}
			if (!obj.isFaceDown) {
				applyWave3EtbCounters(state, obj, placeRegisteredCounters, wave3ExtraCounters);
				// --- Track P11 ---
				if (typeof nextData.chosenEtbCounter === 'string') {
					placeRegisteredCounters(state, obj, nextData.chosenEtbCounter as CounterType, 1);
				}
				const extEtbCounters = collectExternalEtbCounters(
					state,
					obj,
					obj.controllerId || receiver.playerId
				);
				for (const ec of extEtbCounters) {
					placeRegisteredCounters(state, obj, ec.counter, ec.amount);
				}
				// --- End Track P11 ---
			}
			// --- Track P12 ---
			applyWave4EtbCountersAndSetup(state, obj, placeRegisteredCounters);
			// --- End Track P12 ---
		}
		noteLayerInputsChanged(state);

		if (sbaLog) {
			pushSbaLog(state, obj, 'battlefield', replacedBy, sbaLog);
		}
		if (emit) {
			emitZoneChange(
				state,
				obj,
				fromZone,
				'battlefield',
				fromPlayerId,
				receiver.playerId,
				false,
				lki
			);
			maybePlaceSagaEtbLoreCounter(state, obj);
			if (
				obj.attachedToId &&
				(bfView.subtypes.includes('Aura') || bfView.typeLine.includes('Aura'))
			) {
				for (const pl of state.players) {
					const host = pl.battlefield.find(
						(b) => !b.phasedOut && b.instanceId === obj.attachedToId
					);
					if (host) {
						emitEvent(state, {
							kind: 'Attached',
							attachmentId: obj.instanceId,
							attachment: obj,
							hostId: host.instanceId,
							host
						});
						break;
					}
				}
			}
		}
		syncBattlefieldControllers(state);
	});
	if (!awaitingMore) {
		flushTriggers(state);
	}
});

// --- Track P10 ---
export function captureLki(state: GameState, obj: CardInstance): LeftBattlefieldInfo {
// --- End Track P10 ---
	const evaluated = evaluatePermanent(state, obj);
	const power = evaluated.isCreature
		? (obj.lastKnownPower ?? evaluated.breakdown.effectivePower ?? evaluated.power)
		: undefined;
	const toughness = evaluated.isCreature
		? (obj.lastKnownToughness ?? evaluated.breakdown.effectiveToughness ?? evaluated.toughness)
		: undefined;
	const attachedIds: string[] = [];
	for (const p of state.players) {
		for (const perm of p.battlefield) {
			if (!perm.phasedOut && perm.attachedToId === obj.instanceId) {
				attachedIds.push(perm.instanceId);
			}
		}
	}
	return {
		card: effectiveCardForObject(obj),
		controllerId: obj.controllerId,
		typeLine: evaluated.typeLine,
		hasAllCreatureTypes: evaluated.hasAllCreatureTypes,
		lostAllAbilities: evaluated.hasLostAllAbilities,
		isToken: obj.isToken,
		tapped: obj.tapped,
		power,
		toughness,
		...(obj.activeFaceIndex !== undefined ? { activeFaceIndex: obj.activeFaceIndex } : {}),
		...(obj.unlockedFaces ? { unlockedFaces: [...obj.unlockedFaces] } : {}),
		...(attachedIds.length > 0 ? { attachedIds } : {}),
		...(obj.foretold ? { foretold: true } : {}),
		...(obj.blitzed ? { blitzed: true } : {}),
		...(obj.saddledThisTurn ? { saddled: true } : {}),
		...(obj.exertedThisTurn ? { exerted: true } : {}),
		...(obj.chosenSubType ? { chosenSubType: obj.chosenSubType } : {}),
		...(obj.chosenColor ? { chosenColor: obj.chosenColor } : {}),
		...(obj.isMonstrous ? { monstrous: true } : {}),
		// --- Track P9 ---
		counters: { ...(obj.lastKnownCounters ?? obj.counters) },
		...(() => {
			const g = extractGrantedDeathKeywords(state, obj, evaluated);
			return g ? { grantedDeathKeywords: g } : {};
		})(),
		// --- Track P10 ---
		...(obj.damagedByThisTurn && obj.damagedByThisTurn.length > 0
			? { damagedByThisTurn: [...obj.damagedByThisTurn] }
			: {}),
		...(() => {
			if (!state.timedContinuousEffects?.length || evaluated.hasLostAllAbilities) return {};
			const ver = obj.objectVersion || 1;
			const texts: string[] = [];
			for (const eff of state.timedContinuousEffects) {
				if (!eff.layer6?.grantedAbilityTexts?.length) continue;
				if (
					eff.affected.some(
						(a) => a.instanceId === obj.instanceId && (a.objectVersion ?? 1) === ver
					)
				) {
					texts.push(...eff.layer6.grantedAbilityTexts);
				}
			}
			return texts.length > 0 ? { grantedAbilityTexts: texts } : {};
		})()
		// --- End Track P10 ---
	};
}

function detachFrom(p: PlayerGameState, instanceId: string): void {
	for (const perm of p.battlefield) {
		if (perm.attachedToId === instanceId) perm.attachedToId = null;
	}
}

function emitZoneChange(
	state: GameState,
	obj: CardInstance,
	from: ZoneType | null,
	to: ZoneType,
	fromPlayerId: string | null,
	toPlayerId: string | null,
	ceasedToExist: boolean,
	lki?: LeftBattlefieldInfo
): void {
	emitEvent(state, {
		kind: 'ZoneChange',
		objectId: obj.instanceId,
		object: obj,
		from,
		to,
		fromPlayerId,
		toPlayerId,
		ceasedToExist,
		...(lki ? { lki } : {})
	});
}

function sagaHasReadAhead(obj: CardInstance): boolean {
	if (obj.isFaceDown) return false;
	const card = effectiveCardForObject(obj);
	const def = compileCard(card);
	const resolved = resolveObjectFaces(card, instanceFaceOptions(obj, 'battlefield'));
	return resolved.activeFaceIndices.some((fi) => Boolean(def.faces[fi]?.hasReadAhead));
}

/**
 * CR 715.3a: As a Saga without read ahead enters the battlefield, its controller puts a lore
 * counter on it. Evaluated after battlefield insertion so layer-4 type changes (CR 614.12) and
 * counter multipliers apply accurately.
 */
function maybePlaceSagaEtbLoreCounter(state: GameState, obj: CardInstance): void {
	if (obj.zone !== 'battlefield' || obj.phasedOut || obj.isFaceDown) return;
	if ((obj.counters.lore || 0) > 0) return;
	const ev = evaluatePermanent(state, obj);
	if (!ev.hasSubType('Saga')) return;
	if (sagaHasReadAhead(obj)) return;
	placeRegisteredCounters(state, obj, 'lore', 1);
}

// ---------------------------------------------------------------------------------------------
// Not zone changes: reordering within a zone, control changes, and leaving the game. No events.
// ---------------------------------------------------------------------------------------------

/**
 * Inserts objects that an earlier `moveObject(..., { insert: 'deferred' })` already moved (and
 * reported). 'start' keeps their order, so cards[0] ends up first.
 */
export function placeDeferred(
	player: PlayerGameState,
	zone: PlayerZone,
	cards: CardInstance[],
	at: 'start' | 'end'
): void {
	if (at === 'start') player[zone].unshift(...cards);
	else player[zone].push(...cards);
	noteLayerInputsChanged();
}

/** Shuffles a library. With `keepTop`, the top `keepTop` cards stay where they are. */
export function shuffleLibrary(state: RngHolder, player: PlayerGameState, keepTop = 0): void {
	// CR 701.20d: Shuffling clears known-card identity on the shuffled portion of the library.
	const toClear = keepTop <= 0 ? player.library : player.library.slice(keepTop);
	for (const c of toClear) {
		c.knownToPlayerIds = undefined;
	}
	if (keepTop <= 0) {
		player.library = shuffleArray(state, player.library);
	} else {
		player.library = [
			...player.library.slice(0, keepTop),
			...shuffleArray(state, player.library.slice(keepTop))
		];
	}
}

/** Replaces a zone's order. `ordered` must contain exactly the zone's current objects. */
export function setZoneOrder(player: PlayerGameState, zone: PlayerZone, ordered: CardInstance[]): void {
	player[zone] = ordered;
	noteLayerInputsChanged();
}

/**
 * Takes `cards` out of the library (wherever they are), then puts `top` on top in order (top[0]
 * becomes the top card) and `bottom` on the bottom in order. Used by scry and "rearrange the top
 * N" effects; `top` and `bottom` together should be exactly `cards`.
 */
export function rearrangeLibrary(
	player: PlayerGameState,
	cards: CardInstance[],
	top: CardInstance[],
	bottom: CardInstance[]
): void {
	for (const c of cards) removeFirst(player.library, c.instanceId);
	player.library.unshift(...top);
	player.library.push(...bottom);
}

/**
 * CR 506.4: Removes a permanent from combat as an attacker or blocker (preserving `wasBlocked` on
 * any attacker it was blocking per CR 509.1h / 510.1c).
 */
export function removeFromCombat(state: GameState | undefined, instanceId: string): void {
	if (!state?.combat) return;
	state.combat.attackers = state.combat.attackers.filter(
		(atk) => atk.attackerInstanceId !== instanceId
	);
	for (const atk of state.combat.attackers) {
		atk.blockerInstanceIds = atk.blockerInstanceIds.filter((id) => id !== instanceId);
		if (atk.defenderPlaneswalkerId === instanceId) {
			atk.defenderPlaneswalkerId = 'removed';
		}
	}
}

/**
 * Moves a permanent from one player's battlefield array to another's. This is a control change,
 * not a zone change (CR 108.4, 800.4a), so no event is emitted and no bookkeeping is done.
 */
export function transferBattlefieldControl(
	perm: CardInstance,
	fromPlayer: PlayerGameState,
	toPlayer: PlayerGameState,
	state?: GameState,
	opts?: { preserveDefaultController?: boolean }
): void {
	removeFirst(fromPlayer.battlefield, perm.instanceId);
	if (!opts?.preserveDefaultController) {
		if (!perm.defaultControllerId) {
			perm.defaultControllerId = perm.controllerId || fromPlayer.playerId;
		}
		if (state) {
			const ts = (state.nextTimestamp = (state.nextTimestamp || 0) + 1);
			(state.timedContinuousEffects ??= []).push({
				timestamp: ts,
				sourceName: 'Control change',
				controllerId: toPlayer.playerId,
				expires: 'never',
				affected: [{ instanceId: perm.instanceId, objectVersion: perm.objectVersion ?? 1 }],
				layer2: { controllerId: toPlayer.playerId }
			});
		}
	}
	perm.controllerId = toPlayer.playerId;
	perm.summoningSick = true;
	perm.castViaSuspend = false;
	// --- Track P9 (CR 702.30a) ---
	if (state) {
		perm.cameUnderControlAt = allocateEchoTick(state);
	}
	toPlayer.battlefield.push(perm);
	noteLayerInputsChanged(state);
	removeFromCombat(state, perm.instanceId);
}

/**
 * CR 613.1b, 613.7, 302.6, 506.4: Synchronizes each battlefield permanent's physical
 * `player.battlefield` array and `perm.controllerId` with its evaluated Layer 2 controller.
 *
 * 1. Prunes `TimedContinuousEffect` entries whose `layer2.untilSourceLeaves` source is no longer
 *    on any active player's battlefield with matching `objectVersion` (phased-out permanents remain
 *    on the battlefield per CR 702.26d and are not pruned).
 * 2. Evaluates all active permanents via `evaluatePermanent` and moves any permanent whose
 *    `controllerId` or hosting `battlefield` differs from its evaluated Layer 2 controller,
 *    preserving `defaultControllerId`, marking `summoningSick = true` (CR 302.6), clearing
 *    `castViaSuspend` (CR 702.62a), and removing from combat (CR 506.4).
 *
 * Returns true if any permanent changed controller/battlefield.
 */
let syncingControllers = false;

export function syncBattlefieldControllers(state: GameState): boolean {
	if (syncingControllers) return false;
	syncingControllers = true;
	try {
		if (state.timedContinuousEffects?.length) {
			const boardVersions = new Map<string, number>();
			for (const p of state.players) {
				if (p.lost) continue;
				for (const c of p.battlefield) {
					boardVersions.set(c.instanceId, c.objectVersion ?? 1);
				}
			}
			const remaining = state.timedContinuousEffects.filter((eff) => {
				const usl = eff.layer2?.untilSourceLeaves;
				if (!usl) return true;
				return boardVersions.get(usl.sourceInstanceId) === usl.sourceObjectVersion;
			});
			if (remaining.length !== state.timedContinuousEffects.length) {
				state.timedContinuousEffects = remaining.length > 0 ? remaining : undefined;
				noteLayerInputsChanged(state);
			}
		}

		// --- Track P11: O(B) skip when no Layer 2 control effect or foreign permanent exists ---
		if (!boardMayNeedControllerSync(state)) return false;
		// --- End Track P11 ---

		let anyMoved = false;
		for (let pass = 0; pass < 8; pass++) {
			const moves: Array<{
				perm: CardInstance;
				fromPlayer: PlayerGameState;
				targetControllerId: string;
			}> = [];
			withStableLayerInputs(state, () => {
				for (const p of state.players) {
					if (p.lost) continue;
					for (const perm of p.battlefield) {
						if (perm.phasedOut) continue;
						const targetControllerId = evaluatePermanent(state, perm).controllerId;
						if (perm.controllerId !== targetControllerId || p.playerId !== targetControllerId) {
							moves.push({ perm, fromPlayer: p, targetControllerId });
						}
					}
				}
			});
			if (moves.length === 0) break;

			let passMoved = false;
			for (const { perm, fromPlayer, targetControllerId } of moves) {
				if (!perm.defaultControllerId) {
					perm.defaultControllerId = perm.controllerId || fromPlayer.playerId;
				}
				const targetPlayer = state.players.find((pl) => pl.playerId === targetControllerId);
				if (!targetPlayer || targetPlayer.lost) {
					// CR 800.4a / 800.4c: Previous/default controller left the game; exile foreign permanent.
					moveObject(state, perm, 'exile', {
						from: { player: fromPlayer, zone: 'battlefield' },
						detachAttachments: true,
						leaveBattlefieldReset: true,
						bumpVersion: true,
						newTimestamp: true,
						ceaseToExist: 'tokens'
					});
					passMoved = true;
					anyMoved = true;
					continue;
				}
				if (fromPlayer.playerId !== targetPlayer.playerId) {
					transferBattlefieldControl(perm, fromPlayer, targetPlayer, state, {
						preserveDefaultController: true
					});
				} else {
					perm.controllerId = targetControllerId;
					perm.summoningSick = true;
					perm.castViaSuspend = false;
					// --- Track P9 (CR 702.30a) ---
					perm.cameUnderControlAt = allocateTimestamp(state);
					noteLayerInputsChanged(state);
					removeFromCombat(state, perm.instanceId);
				}
				passMoved = true;
				anyMoved = true;
			}
			if (!passMoved) break;
		}
		return anyMoved;
	} finally {
		syncingControllers = false;
	}
}

/**
 * Removes every object matching `pred` from a zone without moving it anywhere (tokens outside the
 * battlefield cease to exist, CR 704.5d; a player leaving the game takes their objects, CR 800.4a).
 * Returns how many were removed.
 */
export function removeFromGame(
	player: PlayerGameState,
	zone: PlayerZone,
	pred: (c: CardInstance) => boolean = () => true
): number {
	const before = player[zone].length;
	player[zone] = player[zone].filter((c) => !pred(c));
	noteLayerInputsChanged();
	return before - player[zone].length;
}

/**
 * Mulligan (CR 103.5): the hand goes into the library, the library is shuffled, and the player
 * draws seven. The old code built new card objects with `{ ...c, zone }`; the copies are kept so
 * object identity behaves as before. Two ZoneChange events per card (hand to library, library to
 * hand). No objectVersion or timestamp changes, as before.
 */
export function mulliganRedraw(
	state: GameState,
	player: PlayerGameState,
	opts?: { emit?: boolean }
): void {
	for (const c of [...player.hand]) {
		moveObject(state, { ...c }, 'library', {
			from: { player, zone: 'hand' },
			toPlayer: player,
			emit: opts?.emit
		});
	}
	shuffleLibrary(state, player);
	for (const c of player.library.slice(0, 7)) {
		moveObject(state, { ...c }, 'hand', {
			from: { player, zone: 'library' },
			toPlayer: player,
			emit: opts?.emit
		});
	}
}

/**
 * CR 701.26a, CR 603.2e: Single funnel for tapping a permanent on the battlefield.
 * Only an untapped permanent can become tapped. If `perm` was untapped, sets `perm.tapped = true`,
 * notifies the layer cache, and (if on the battlefield and not phased out) emits `BecomesTapped`.
 */
export function tapPermanent(state: GameState, perm: CardInstance): boolean {
	if (perm.tapped) return false;
	perm.tapped = true;
	noteLayerInputsChanged(state);
	if (perm.zone === 'battlefield' && !perm.phasedOut) {
		emitEvent(state, {
			kind: 'BecomesTapped',
			objectId: perm.instanceId,
			object: perm
		});
	}
	return true;
}

/**
 * CR 701.3a–c, CR 613.7e: Single funnel for attaching an Aura, Equipment, or Fortification to an
 * object or player (`hostId`).
 * - CR 701.3b: If `obj` is already attached to `hostId`, does nothing and returns `false`.
 * - CR 613.7e: Otherwise sets `obj.attachedToId = hostId`, allocates a fresh `enteredTimestamp`,
 *   notifies the layer cache, and returns `true`.
 */
export function attachObject(state: GameState, obj: CardInstance, hostId: string): boolean {
	if (obj.attachedToId === hostId) return false;
	obj.attachedToId = hostId;
	obj.enteredTimestamp = allocateTimestamp(state);
	noteLayerInputsChanged(state);
	return true;
}
