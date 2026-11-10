import { shuffleWith, uid, type RngHolder } from './random.ts';
import { enqueueChoicePrompt, registerPromptHandler } from './choices.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import type { CardInstance, CounterType, GameState, PlayerGameState, ZoneType } from '../types.ts';
import { emitEvent, type LeftBattlefieldInfo } from './events.ts';
import { noteLayerInputsChanged, whileLayerInputsChange } from './layerCache.ts';
import { counterMultiplier, resolveZoneChangeReplacements } from './replace.ts';

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
}

export function allocateTimestamp(state: GameState): number {
	state.nextTimestamp = (state.nextTimestamp || 100) + 1;
	return state.nextTimestamp;
}

export function createEmptyCounters(): Record<CounterType, number> {
	return {
		'+1/+1': 0,
		'-1/-1': 0,
		loyalty: 0,
		charge: 0,
		shield: 0,
		stun: 0,
		lore: 0,
		time: 0
	};
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
 * went to (after replacement effects), which is also the event's `to`.
 */
export function moveObject(
	state: GameState,
	obj: CardInstance,
	to: ZoneType,
	opts: MoveOptions
): ZoneType {
	// Phase 6c: a zone change ends any layer-cache stable-input scope's trust (no-op outside one).
	return whileLayerInputsChange(state, () => moveObjectInner(state, obj, to, opts));
}

function moveObjectInner(
	state: GameState,
	obj: CardInstance,
	to: ZoneType,
	opts: MoveOptions
): ZoneType {
	const { from } = opts;
	// CR 304.4 / 307.4: If an instant or sorcery would enter the battlefield, it remains in its previous zone.
	if (to === 'battlefield') {
		const effectiveTypeLine = (obj.copiableCard ?? obj.card).typeLine;
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
	let pendingZoneRep: ReturnType<typeof resolveZoneChangeReplacements> | undefined;
	let promptCommanderRedirect = false;
	if (opts.graveyardReplacement && to === 'graveyard') {
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
	}
	if (
		!pendingZoneRep?.pendingOptions &&
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
		(dest === 'hand' || dest === 'graveyard' || dest === 'library' || dest === 'command') && owner
			? owner
			: receiver;

	if (opts.leaveBattlefieldReset) {
		if (obj.printedCard) {
			obj.card = obj.printedCard;
			obj.printedCard = undefined;
		}
		if (obj.copiableCard) obj.copiableCard = undefined;
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
		obj.transformed = false;
		obj.isFaceDown = false;
		obj.goadedByPlayerIds = undefined;
		obj.playableFromExileBy = undefined;
		obj.enteredWithX = undefined;
	}
	if (opts.controllerId !== undefined) obj.controllerId = opts.controllerId;
	if (opts.bumpVersion) obj.objectVersion = (obj.objectVersion || 1) + 1;
	if (opts.newTimestamp) obj.enteredTimestamp = allocateTimestamp(state);
	// CR 306.5b: A planeswalker entering the battlefield receives starting loyalty counters (with counter multipliers).
	if (dest === 'battlefield') {
		const effectiveCard = obj.copiableCard ?? obj.card;
		if (
			effectiveCard.typeLine.includes('Planeswalker') &&
			effectiveCard.loyalty !== undefined &&
			(obj.counters.loyalty || 0) === 0
		) {
			const baseLoyalty = parseInt(String(effectiveCard.loyalty), 10) || 0;
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
	if (dest !== 'stack' && !ceases) {
		const at = typeof opts.insert === 'function' ? opts.insert(dest) : opts.insert;
		if (at !== 'deferred') insertInto(effectiveReceiver[dest as PlayerZone], obj, at);
		if (shuffleDestLibrary && dest === 'library') {
			shuffleLibrary(state, effectiveReceiver);
		}
	}
	if (pendingZoneRep?.pendingOptions && pendingZoneRep.pendingOptions.length >= 2 && !ceases) {
		const description = `Multiple replacement effects would modify how ${obj.card.name} moves to ${dest}. Choose which applies first (CR 616.1):`;
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
					holderId: effectiveReceiver.playerId,
					currentZone: dest,
					fromZone,
					fromPlayerId,
					appliedIds: pendingZoneRep.appliedIds,
					lkiLostAllAbilities: Boolean(lki?.lostAllAbilities),
					commanderRedirect: Boolean(opts.commanderRedirect)
				}
			},
			choice: {
				kind: 'chooseReplacement',
				options: pendingZoneRep.pendingOptions.map((r) => ({ id: r.id, label: r.label }))
			}
		});
		return dest;
	}
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
			choice: {
				kind: 'yesNo',
				question: description
			}
		});
	}
	return dest;
}

registerPromptHandler('zone_replacement_choice', (state, prompt, answer) => {
	if (answer.kind !== 'chooseReplacement') return;
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	if (!data) return;
	const objectId = typeof data.objectId === 'string' ? data.objectId : '';
	const holderId = typeof data.holderId === 'string' ? data.holderId : '';
	const currentZone = (data.currentZone as PlayerZone | undefined) ?? 'graveyard';
	const fromZone = (data.fromZone as ZoneType | null | undefined) ?? null;
	const fromPlayerId = (data.fromPlayerId as string | null | undefined) ?? null;
	const appliedIds = Array.isArray(data.appliedIds) ? (data.appliedIds as string[]) : [];
	const lkiLostAllAbilities = Boolean(data.lkiLostAllAbilities);
	const commanderRedirect = Boolean(data.commanderRedirect);

	const holder = state.players.find((p) => p.playerId === holderId);
	if (!holder) return;
	const idx = holder[currentZone].findIndex((c) => c.instanceId === objectId);
	if (idx < 0) return;
	const obj = holder[currentZone][idx];

	const nextRes = resolveZoneChangeReplacements(
		state,
		obj,
		fromZone,
		currentZone,
		new Set(appliedIds),
		lkiLostAllAbilities,
		answer.id
	);

	const owner = state.players.find((p) => p.playerId === obj.ownerId) ?? holder;
	let finalDest = nextRes.dest;
	let shuffleFinal = nextRes.shuffle;

	if (!nextRes.pendingOptions && commanderRedirect && obj.isCommander && (finalDest === 'hand' || finalDest === 'library')) {
		if (owner.isBot) {
			finalDest = 'command';
			shuffleFinal = false;
		}
	}

	const destHolder =
		finalDest === 'hand' || finalDest === 'graveyard' || finalDest === 'library' || finalDest === 'command'
			? owner
			: holder;

	if (finalDest !== currentZone || destHolder !== holder) {
		holder[currentZone].splice(idx, 1);
		obj.zone = finalDest;
		insertInto(destHolder[finalDest as PlayerZone], obj, finalDest === 'library' ? 'start' : 'end');
	}
	if (shuffleFinal && finalDest === 'library') {
		shuffleLibrary(state, destHolder);
	}

	if (nextRes.pendingOptions && nextRes.pendingOptions.length >= 2) {
		const description = `Multiple replacement effects would modify how ${obj.card.name} moves to ${finalDest}. Choose which applies next (CR 616.1f):`;
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
					holderId: destHolder.playerId,
					currentZone: finalDest,
					fromZone,
					fromPlayerId,
					appliedIds: nextRes.appliedIds,
					lkiLostAllAbilities,
					commanderRedirect
				}
			},
			choice: {
				kind: 'chooseReplacement',
				options: nextRes.pendingOptions.map((r) => ({ id: r.id, label: r.label }))
			}
		});
		return;
	}

	emitZoneChange(state, obj, fromZone, finalDest, fromPlayerId, destHolder.playerId, false);
});

function captureLki(state: GameState, obj: CardInstance): LeftBattlefieldInfo {
	const evaluated = evaluatePermanent(state, obj);
	const power = evaluated.isCreature
		? (obj.lastKnownPower ?? evaluated.breakdown.effectivePower ?? evaluated.power)
		: undefined;
	const toughness = evaluated.isCreature
		? (obj.lastKnownToughness ?? evaluated.breakdown.effectiveToughness ?? evaluated.toughness)
		: undefined;
	return {
		card: obj.copiableCard ?? obj.card,
		controllerId: obj.controllerId,
		typeLine: evaluated.typeLine,
		hasAllCreatureTypes: evaluated.hasAllCreatureTypes,
		lostAllAbilities: evaluated.hasLostAllAbilities,
		isToken: obj.isToken,
		tapped: obj.tapped,
		power,
		toughness
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
	state?: GameState
): void {
	removeFirst(fromPlayer.battlefield, perm.instanceId);
	perm.controllerId = toPlayer.playerId;
	perm.summoningSick = true;
	toPlayer.battlefield.push(perm);
	noteLayerInputsChanged(state);
	removeFromCombat(state, perm.instanceId);
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
