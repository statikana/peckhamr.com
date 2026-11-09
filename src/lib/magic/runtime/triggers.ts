/**
 * Trigger matching (ENGINE_ARCHITECTURE_PLAN.md section 2.3, Phase 5).
 *
 * One engine for every triggered ability. For each game event (runtime/events.ts) it walks the
 * compiled TriggerDefs of the objects in the relevant zones (the battlefield; the graveyard for
 * `fromZone: 'graveyard'` abilities such as Nether Shadow; the spell itself for "When you cast ~";
 * the last known information of an object that just left the battlefield for leaves-the-battlefield
 * abilities, CR 603.10a) and records each match as a pending trigger. Nothing runs at match time.
 *
 * `flushTriggers` then puts the pending triggers "on the stack" in APNAP order (CR 603.3b): the
 * active player's first, then each other player's in turn order. The engine calls it at the points
 * where a player would next receive priority (end of state-based actions, phase changes, the end of
 * every action) and where the pre-Phase-5 engine ran triggers directly (after the log line of the
 * zone change, so log order and `landsPlayedThisTurn` are as before).
 *
 * Intervening-if conditions (CR 603.4) are checked when the event happens and again on resolution.
 *
 * This file never reads rules text or card names: it reads compiled IR (compiler/triggers.ts
 * `runtimeTriggers`) and evaluated permanents (ruleTree.ts `evaluatePermanent`).
 */
import { compileCard } from '../compiler/index.ts';
import { runtimeTriggers, type RuntimeTrigger } from '../compiler/triggers.ts';
import type { Amount, Condition, EventFilter, EventKind, ObjectFilter, TriggerDef } from '../ir.ts';
import { evaluatePermanent, permanentHasLostAllAbilities } from '../ruleTree.ts';
import type { CardInstance, GameState, ScryfallCard } from '../types.ts';
import type { GameEvent } from './events.ts';
import { triggerMultiplier } from './replace.ts';

/**
 * How a pending trigger is executed. 'stack': a StackItem that resolves when all players pass.
 * 'inline': resolved immediately at the flush, in the order it would resolve from the stack. The
 * pre-Phase-5 engine put only battlefield upkeep / end-step triggers on the stack and ran every
 * other trigger immediately; existing tests pin that timing, so each event kind keeps it until
 * Phase 8 adds the choice protocol (ordering and target prompts) and everything moves to the stack.
 * See `modeFor`.
 */
export type TriggerMode = 'stack' | 'inline';

export interface PendingTrigger {
	ability: RuntimeTrigger;
	/** The object whose ability triggered (for a leaves-the-battlefield trigger, the object that left). */
	source: CardInstance;
	/** The card whose ability it is: copiable values (CR 707.2), or the look-back card (CR 603.10a). */
	sourceCard: ScryfallCard;
	controllerId: string;
	mode: TriggerMode;
	/** Short description for titles and the log ("ETB", "Landfall", "Attack", ...). */
	label: string;
	/** The object the event was about, when it isn't the source ("that creature"). */
	eventObject?: CardInstance;
	/** The player the event was about (the player dealt combat damage). */
	eventPlayerId?: string;
	/** The amount the event carried: damage dealt, or the entering creature's power. */
	amount?: number;
	/** Match order (deterministic tie-break for a player's own simultaneous triggers). */
	order: number;
}

/** What the engine provides to execute triggers (injected to avoid an import cycle with engine.ts). */
export interface TriggerHost {
	/** Resolves one triggered ability now. The single place trigger effects are executed. */
	executeInline(state: GameState, trigger: PendingTrigger): void;
	/** Puts one triggered ability on the stack. */
	putOnStack(state: GameState, trigger: PendingTrigger): void;
}

let host: TriggerHost | null = null;

export function registerTriggerHost(h: TriggerHost): void {
	host = h;
}

// ---- Compiled triggers per card -------------------------------------------------------------

interface CardTriggers {
	all: RuntimeTrigger[];
	/** Event kinds any alternative of any ability listens to. */
	events: Set<EventKind>;
}

const CARD_TRIGGERS = new WeakMap<ScryfallCard, CardTriggers>();

function triggersOf(card: ScryfallCard): CardTriggers {
	let entry = CARD_TRIGGERS.get(card);
	if (!entry) {
		const all = runtimeTriggers(compileCard(card));
		const events = new Set<EventKind>();
		for (const t of all) for (const alt of alternatives(t.trigger)) events.add(alt.event);
		entry = { all, events };
		CARD_TRIGGERS.set(card, entry);
	}
	return entry;
}

/** "Whenever ~ enters or attacks": the main TriggerDef and each `or` alternative. */
function alternatives(def: TriggerDef): TriggerDef[] {
	return def.or ? [def, ...def.or] : [def];
}

// ---- Pending queue (transient, never in GameState) ------------------------------------------

interface SimultaneousLkiEntry {
	obj: CardInstance;
	card: ScryfallCard;
	controllerId: string;
	lostAllAbilities: boolean;
	typeLine: string;
	hasAllCreatureTypes: boolean;
	tapped: boolean;
	colors: string[];
}

interface TriggerChannel {
	pending: PendingTrigger[];
	nextOrder: number;
	flushing: number;
	deferFlush: number;
	simultaneousLki?: Map<CardInstance, SimultaneousLkiEntry>;
}

const channels = new WeakMap<GameState, TriggerChannel>();

function channel(state: GameState): TriggerChannel {
	let ch = channels.get(state);
	if (!ch) {
		ch = { pending: [], nextOrder: 1, flushing: 0, deferFlush: 0 };
		channels.set(state, ch);
	}
	return ch;
}

/**
 * CR 603.10a: When multiple permanents are destroyed simultaneously (e.g. "Destroy all creatures"),
 * capture each permanent's pre-destruction LKI before any are moved from the battlefield so that
 * every permanent leaving the battlefield in the batch sees the simultaneous zone changes of the
 * others, then flush all resulting triggers together in APNAP order (CR 603.3b).
 */
export function withSimultaneousDestroyLki(
	state: GameState,
	perms: CardInstance[],
	fn: () => void
): void {
	if (perms.length <= 1) {
		fn();
		flushTriggers(state);
		return;
	}
	const ch = channel(state);
	const map = new Map<CardInstance, SimultaneousLkiEntry>();
	for (const perm of perms) {
		if (perm.zone !== 'battlefield' || perm.phasedOut) continue;
		const ev = evaluatePermanent(state, perm);
		const lost = permanentHasLostAllAbilities(perm, state).lost;
		map.set(perm, {
			obj: perm,
			card: perm.copiableCard ?? perm.card,
			controllerId: perm.controllerId,
			lostAllAbilities: lost,
			typeLine: ev.typeLine,
			hasAllCreatureTypes: ev.hasAllCreatureTypes,
			tapped: perm.tapped,
			colors: perm.isFaceDown ? [] : [...ev.colors]
		});
	}
	const prevMap = ch.simultaneousLki;
	ch.simultaneousLki = map;
	ch.deferFlush += 1;
	try {
		fn();
	} finally {
		ch.deferFlush -= 1;
		ch.simultaneousLki = prevMap;
	}
	flushTriggers(state);
}

export function hasPendingTriggers(state: GameState): boolean {
	return (channels.get(state)?.pending.length ?? 0) > 0;
}

/** For tests: the triggers waiting for the next flush. */
export function peekPendingTriggers(state: GameState): readonly PendingTrigger[] {
	return channels.get(state)?.pending ?? [];
}

// ---- Objects as triggers see them -----------------------------------------------------------

/** The object an event is about, with the characteristics trigger filters check. */
interface Subject {
	obj: CardInstance;
	controllerId: string;
	isToken: boolean;
	tapped: boolean;
	colors: string[];
	typeLine: () => string;
	hasSubtype: (subtype: string) => boolean;
}

function battlefieldSubject(state: GameState, obj: CardInstance, controllerId: string): Subject {
	let evaluated: ReturnType<typeof evaluatePermanent> | undefined;
	const ev = () => (evaluated ??= evaluatePermanent(state, obj));
	return {
		obj,
		controllerId,
		isToken: obj.isToken,
		tapped: obj.tapped,
		get colors() {
			return obj.isFaceDown ? [] : ev().colors;
		},
		typeLine: () => ev().typeLine,
		hasSubtype: (s) => ev().hasSubType(s)
	};
}

function printedSubject(obj: CardInstance, card: ScryfallCard, controllerId: string, allCreatureTypes = false, typeLine = card.typeLine, tapped = obj.tapped, colors: string[] = card.colors): Subject {
	return {
		obj,
		controllerId,
		isToken: obj.isToken,
		tapped,
		colors,
		typeLine: () => typeLine,
		hasSubtype: (s) => hasWord(subtypePart(typeLine), s) || (allCreatureTypes && hasWord(typeLine, 'Creature'))
	};
}

function subtypePart(typeLine: string): string {
	const idx = typeLine.indexOf('—');
	return idx >= 0 ? typeLine.slice(idx + 1) : '';
}

function hasWord(text: string, word: string): boolean {
	return text.split(/[\s—]+/).includes(word);
}

/** Whose point of view a filter is read from: "another" excludes `id`, "you" is `controllerId`. */
interface Viewer {
	id: string;
	controllerId: string;
}

const viewerOf = (source: Source): Viewer => ({ id: source.obj.instanceId, controllerId: source.controllerId });

/** Does `subject` match an ObjectFilter, from the point of view of the trigger's source? */
function filterMatches(f: ObjectFilter, subject: Subject, source: Viewer): boolean {
	if (f.other && subject.obj.instanceId === source.id) return false;
	const typeLine = f.types || f.supertypes || f.notTypes ? subject.typeLine() : '';
	if (f.types && !f.types.some((t) => hasWord(typeLine, t))) return false;
	if (f.notTypes && f.notTypes.some((t) => hasWord(typeLine, t))) return false;
	if (f.supertypes && !f.supertypes.some((t) => hasWord(typeLine, t))) return false;
	if (f.subtypes && !f.subtypes.some((s) => subject.hasSubtype(s))) return false;
	if (f.controller === 'you' && subject.controllerId !== source.controllerId) return false;
	if (f.controller === 'opponent' && subject.controllerId === source.controllerId) return false;
	if (f.token !== undefined && subject.isToken !== f.token) return false;
	if (f.tapped !== undefined && subject.tapped !== f.tapped) return false;
	if (f.colors && !f.colors.some((c) => subject.colors.includes(c))) return false;
	return true;
}

/** EventFilter.object (+ orSelf) against the event's object. */
function objectMatches(filter: EventFilter, subject: Subject, source: Source): boolean {
	const o = filter.object;
	const isSelf = subject.obj.instanceId === source.obj.instanceId;
	if (o === 'self') return isSelf;
	if (o === 'attachedTo') return source.obj.attachedToId === subject.obj.instanceId;
	if (filter.orSelf && isSelf) return true;
	return filterMatches(o ?? {}, subject, viewerOf(source));
}

// ---- Sources --------------------------------------------------------------------------------

/** An object whose triggered abilities are being checked. */
interface Source {
	obj: CardInstance;
	card: ScryfallCard;
	controllerId: string;
	zone: 'battlefield' | 'graveyard' | 'stack';
	/** Look-back for an object that left the battlefield (CR 603.10a). */
	lostAllAbilities?: boolean;
	isLookBack?: boolean;
}

/**
 * Every object whose abilities can trigger on `kind`: battlefield permanents (not phased out) and
 * graveyard cards with `fromZone: 'graveyard'` abilities, in seat order then zone order. Players who
 * have left the game are skipped (CR 800.4a).
 */
function sources(state: GameState, kind: EventKind): Source[] {
	const out: Source[] = [];
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			const card = perm.copiableCard ?? perm.card;
			if (triggersOf(card).events.has(kind)) {
				out.push({ obj: perm, card, controllerId: p.playerId, zone: 'battlefield' });
			}
		}
		for (const c of p.graveyard) {
			const t = triggersOf(c.card);
			if (t.events.has(kind) && t.all.some((a) => a.trigger.fromZone === 'graveyard')) {
				out.push({ obj: c, card: c.card, controllerId: p.playerId, zone: 'graveyard' });
			}
		}
	}
	return out;
}

/**
 * The abilities of `source` that function in its zone, each with its alternatives for `kind` that
 * pass the cheap `pre` check (event fields only). Ability loss is checked last because it's costly.
 */
function abilitiesFor(
	state: GameState,
	source: Source,
	kind: EventKind,
	pre: (alt: TriggerDef) => boolean = () => true
): Array<{ ability: RuntimeTrigger; alts: TriggerDef[] }> {
	const out: Array<{ ability: RuntimeTrigger; alts: TriggerDef[] }> = [];
	for (const ability of triggersOf(source.card).all) {
		const zone = ability.trigger.fromZone ?? 'battlefield';
		// "When you cast ~" functions while the spell is on the stack (CR 603.2, 113.6).
		if (source.zone === 'stack' ? kind !== 'cast' : zone !== source.zone) continue;
		const alts = alternatives(ability.trigger).filter((a) => a.event === kind && pre(a));
		if (alts.length > 0) out.push({ ability, alts });
	}
	if (out.length === 0) return out;
	// CR 613 layer 6: a permanent that lost all abilities has no triggered abilities.
	if (source.lostAllAbilities ?? (source.zone === 'battlefield' && permanentHasLostAllAbilities(source.obj, state).lost)) {
		return [];
	}
	return out;
}

// ---- Matching -------------------------------------------------------------------------------

interface MatchExtras {
	label: string;
	eventObject?: CardInstance;
	eventPlayerId?: string;
	amount?: number;
	times?: number;
}

function record(state: GameState, source: Source, ability: RuntimeTrigger, kind: EventKind, extras: MatchExtras): void {
	// CR 603.4: an intervening-if condition must be true when the event happens.
	if (ability.condition && !evaluateCondition(state, ability.condition, source.controllerId, source.obj.instanceId)) {
		return;
	}
	const ch = channel(state);
	for (let i = 0; i < (extras.times ?? 1); i++) {
		ch.pending.push({
			ability,
			source: source.obj,
			sourceCard: source.card,
			controllerId: source.controllerId,
			mode: modeFor(kind, source),
			label: extras.label,
			eventObject: extras.eventObject && extras.eventObject !== source.obj ? extras.eventObject : undefined,
			eventPlayerId: extras.eventPlayerId,
			amount: extras.amount,
			order: ch.nextOrder++
		});
	}
}

/**
 * Pre-Phase-5 timing, kept per event kind (see TriggerMode): beginning-of-step triggers of
 * permanents use the stack; everything else (including graveyard upkeep triggers) runs inline.
 */
function modeFor(kind: EventKind, source: Source): TriggerMode {
	return kind === 'phaseBegin' && source.zone === 'battlefield' ? 'stack' : 'inline';
}

/** Matches one event against every triggered ability. Called for every emitted event. */
export function matchTriggers(state: GameState, ev: GameEvent): void {
	switch (ev.kind) {
		case 'ZoneChange':
			return matchZoneChange(state, ev);
		case 'Cast':
			return matchCast(state, ev.playerId, ev.object, false);
		case 'SpellCopied':
			return matchCast(state, ev.playerId, ev.object, true);
		case 'AttackDeclared':
			return matchAttack(state, ev.playerId, ev.attackerIds);
		case 'BlockersDeclared':
			return matchBlocks(state, ev.playerId, ev.blocks);
		case 'DamageDealt':
			return matchDamage(state, ev);
		case 'PhaseBegin':
			return matchPhase(state, ev);
		case 'CounterPlaced':
			return matchCounter(state, ev);
		case 'BecameTarget':
			return matchTargeted(state, ev);
		case 'Attached':
			return matchAttached(state, ev);
	}
}

function matchZoneChange(state: GameState, ev: Extract<GameEvent, { kind: 'ZoneChange' }>): void {
	const obj = ev.object;
	if (ev.to === 'battlefield' && obj.phasedOut) return;
	const batchLki = ev.from === 'battlefield' ? channel(state).simultaneousLki : undefined;
	const objBatchInfo = batchLki?.get(obj);
	const subject: Subject =
		ev.to === 'battlefield'
			? battlefieldSubject(state, obj, ev.toPlayerId ?? obj.controllerId)
			: objBatchInfo
				? printedSubject(
						obj,
						objBatchInfo.card,
						objBatchInfo.controllerId,
						objBatchInfo.hasAllCreatureTypes,
						objBatchInfo.typeLine,
						objBatchInfo.tapped,
						objBatchInfo.colors
					)
				: ev.lki
					? printedSubject(obj, ev.lki.card, ev.lki.controllerId, ev.lki.hasAllCreatureTypes, ev.lki.typeLine, ev.lki.tapped)
					: printedSubject(obj, obj.card, obj.ownerId);
	const enters = ev.to === 'battlefield';
	const label = (source: Source, alt: TriggerDef) => {
		const self = source.obj === obj;
		if (alt.filter.from === 'battlefield') return alt.filter.to === 'graveyard' ? 'Dies' : 'Leaves the Battlefield';
		if (!enters) return 'Zone Change';
		if (self) return 'ETB';
		const o = alt.filter.object;
		return typeof o === 'object' && o.types?.length === 1 && o.types[0] === 'Land' ? 'Landfall' : 'ETB Trigger';
	};
	const fits = (alt: TriggerDef) =>
		(alt.filter.from === undefined || alt.filter.from === ev.from) &&
		(alt.filter.to === undefined || alt.filter.to === ev.to) &&
		(alt.filter.from !== undefined || alt.filter.to !== undefined);
	let amount: number | undefined;
	const enteredPower = () => {
		if (!enters) return undefined;
		return (amount ??= subject.typeLine().includes('Creature') ? evaluatePermanent(state, obj).power : 0);
	};

	const candidates = sources(state, 'zoneChange');
	// CR 603.10a: an object leaving the battlefield checks its own leaves-the-battlefield abilities as
	// it last existed there. When multiple permanents leave simultaneously, all permanents in the batch
	// also look back to the state immediately before the simultaneous event.
	if (ev.from === 'battlefield') {
		if (batchLki) {
			for (const [peerPerm, info] of batchLki) {
				if (candidates.some((c) => c.obj === peerPerm)) continue;
				if (!triggersOf(info.card).events.has('zoneChange')) continue;
				candidates.push({
					obj: peerPerm,
					card: info.card,
					controllerId: info.controllerId,
					zone: 'battlefield',
					lostAllAbilities: info.lostAllAbilities,
					isLookBack: true
				});
			}
		} else if (ev.lki) {
			candidates.push({
				obj,
				card: ev.lki.card,
				controllerId: ev.lki.controllerId,
				zone: 'battlefield',
				lostAllAbilities: ev.lki.lostAllAbilities,
				isLookBack: true
			});
		}
	}
	for (const source of candidates) {
		for (const { ability, alts } of abilitiesFor(state, source, 'zoneChange', fits)) {
			const alt = alts.find((a) => objectMatches(a.filter, subject, source));
			if (!alt) continue;
			// Only look-back objects check leaves-the-battlefield triggers; other permanents see the event normally.
			if ((source.obj === obj || source.isLookBack) && ev.from === 'battlefield' && alt.filter.from !== 'battlefield') continue;
			const times =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, {
							event: 'zoneChange',
							object: obj,
							from: ev.from,
							to: ev.to,
							lki: ev.lki
						})
					: 1;
			record(state, source, ability, 'zoneChange', { label: label(source, alt), eventObject: obj, amount: enteredPower(), times });
		}
	}
}

function matchCast(state: GameState, casterId: string, spell: CardInstance, isCopy: boolean): void {
	const subject = printedSubject(spell, spell.card, casterId);
	const candidates = sources(state, 'cast');
	if (!isCopy) candidates.push({ obj: spell, card: spell.card, controllerId: casterId, zone: 'stack' });
	for (const source of candidates) {
		for (const { ability, alts } of abilitiesFor(state, source, 'cast')) {
			const alt = alts.find((a) => {
				if (isCopy && !a.filter.orCopy) return false;
				const rel = a.filter.player?.relation ?? 'any';
				if (rel === 'you' && casterId !== source.controllerId) return false;
				if (rel === 'opponent' && casterId === source.controllerId) return false;
				// "When you cast ~" only from the stack; other cast triggers only from other zones.
				if ((a.filter.object === 'self') !== (source.zone === 'stack')) return false;
				return objectMatches(a.filter, subject, source);
			});
			if (!alt) continue;
			const times =
				source.zone === 'battlefield'
					? triggerMultiplier(state, source.obj, source.controllerId, {
							event: 'cast',
							spell,
							casterId,
							isCopy
						})
					: 1;
			record(state, source, ability, 'cast', { label: 'On Cast', times });
		}
	}
}

function permanentById(state: GameState, id: string): { obj: CardInstance; controllerId: string } | null {
	for (const p of state.players) {
		const obj = p.battlefield.find((c) => c.instanceId === id && !c.phasedOut);
		if (obj) return { obj, controllerId: p.playerId };
	}
	return null;
}

function matchAttack(state: GameState, attackingPlayerId: string, attackerIds: string[]): void {
	const attackers = attackerIds
		.map((id) => permanentById(state, id))
		.filter((a): a is NonNullable<typeof a> => Boolean(a))
		.map((a) => battlefieldSubject(state, a.obj, a.controllerId));
	for (const source of sources(state, 'attacks')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'attacks')) {
			for (const alt of alts) {
				const f = alt.filter;
				if (f.object === undefined) {
					// "Whenever you attack".
					if (f.player?.relation === 'you' && attackingPlayerId === source.controllerId && attackers.length > 0) {
						const times =
							source.zone === 'battlefield'
								? triggerMultiplier(state, source.obj, source.controllerId, {
										event: 'attacks',
										attackers: attackers.map((s) => s.obj)
									})
								: 1;
						record(state, source, ability, 'attacks', { label: 'Attack', times });
						break;
					}
					continue;
				}
				const matching = attackers.filter((s) => objectMatches(f, s, source));
				if (matching.length === 0) continue;
				if (f.object === 'self' || f.oneOrMore) {
					const times =
						source.zone === 'battlefield'
							? triggerMultiplier(state, source.obj, source.controllerId, {
									event: 'attacks',
									attackers: matching.map((s) => s.obj)
								})
							: 1;
					record(state, source, ability, 'attacks', { label: 'Attack', times });
				} else {
					for (const s of matching) {
						const times =
							source.zone === 'battlefield'
								? triggerMultiplier(state, source.obj, source.controllerId, {
										event: 'attacks',
										object: s.obj,
										attackers: [s.obj]
									})
								: 1;
						record(state, source, ability, 'attacks', { label: 'Attack Trigger', eventObject: s.obj, times });
					}
				}
				break;
			}
		}
	}
}

function matchBlocks(state: GameState, defenderId: string, blocks: Array<{ blockerId: string; attackerId: string }>): void {
	if (blocks.length === 0) return;
	const subjectFor = (id: string) => {
		const found = permanentById(state, id);
		return found ? battlefieldSubject(state, found.obj, found.controllerId) : null;
	};
	const blockers = [...new Set(blocks.map((b) => b.blockerId))].map(subjectFor).filter((s): s is Subject => Boolean(s));
	const blocked = [...new Set(blocks.map((b) => b.attackerId))].map(subjectFor).filter((s): s is Subject => Boolean(s));
	void defenderId;
	for (const kind of ['blocks', 'becomesBlocked'] as const) {
		const subjects = kind === 'blocks' ? blockers : blocked;
		for (const source of sources(state, kind)) {
			for (const { ability, alts } of abilitiesFor(state, source, kind)) {
				const alt = alts[0];
				const matching = subjects.filter((s) => objectMatches(alt.filter, s, source));
				if (alt.filter.object === 'self') {
					if (matching.length > 0) record(state, source, ability, kind, { label: kind === 'blocks' ? 'Block' : 'Blocked' });
				} else {
					for (const s of matching) record(state, source, ability, kind, { label: kind === 'blocks' ? 'Block' : 'Blocked', eventObject: s.obj });
				}
			}
		}
	}
}

function matchDamage(state: GameState, ev: Extract<GameEvent, { kind: 'DamageDealt' }>): void {
	if (ev.amount <= 0) return;
	const dealer = permanentById(state, ev.sourceId);
	const damaged = ev.targetKind === 'permanent' ? permanentById(state, ev.targetId) : null;
	const damagedEval = damaged ? evaluatePermanent(state, damaged.obj) : null;
	const damageToFits = (to: EventFilter['damageTo']) => {
		switch (to) {
			case 'player':
				return ev.targetKind === 'player';
			case 'playerOrPlaneswalker':
				return ev.targetKind === 'player' || Boolean(damagedEval?.isPlaneswalker);
			case 'creature':
				return Boolean(damagedEval?.isCreature);
			default:
				return true;
		}
	};
	const dealerSubject = dealer ? battlefieldSubject(state, dealer.obj, dealer.controllerId) : null;
	const damagedSubject = damaged ? battlefieldSubject(state, damaged.obj, damaged.controllerId) : null;

	if (dealerSubject) {
		for (const source of sources(state, 'dealsDamage')) {
			for (const { ability, alts } of abilitiesFor(state, source, 'dealsDamage')) {
				const alt = alts.find(
					(a) => (!a.filter.combat || ev.combat) && damageToFits(a.filter.damageTo) && objectMatches(a.filter, dealerSubject, source)
				);
				if (!alt) continue;
				record(state, source, ability, 'dealsDamage', {
					label: ev.combat ? 'Combat Damage Trigger' : 'Damage Trigger',
					eventObject: damaged ? damaged.obj : dealerSubject.obj,
					eventPlayerId: ev.targetKind === 'player' ? ev.targetId : undefined,
					amount: ev.amount
				});
			}
		}
	}
	if (damagedSubject) {
		for (const source of sources(state, 'dealtDamage')) {
			for (const { ability, alts } of abilitiesFor(state, source, 'dealtDamage')) {
				if (!alts.some((a) => objectMatches(a.filter, damagedSubject, source))) continue;
				record(state, source, ability, 'dealtDamage', { label: 'Dealt Damage', eventObject: damagedSubject.obj, amount: ev.amount });
			}
		}
	}
}

function matchPhase(state: GameState, ev: Extract<GameEvent, { kind: 'PhaseBegin' }>): void {
	if (!ev.activePlayerId) return;
	for (const source of sources(state, 'phaseBegin')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'phaseBegin')) {
			if (!alts.some((a) => a.filter.phase === ev.phase)) continue;
			const scope = ability.trigger.scope ?? 'each_turn';
			if (scope === 'controller_turn' && source.controllerId !== ev.activePlayerId) continue;
			if (scope === 'opponent_turn' && source.controllerId === ev.activePlayerId) continue;
			const step = ev.phase === 'upkeep' ? 'Upkeep' : ev.phase === 'end_step' ? 'End Step' : 'Phase';
			record(state, source, ability, 'phaseBegin', {
				label: source.zone === 'graveyard' ? `Graveyard ${step}` : `${step} Trigger`
			});
		}
	}
}

function matchCounter(state: GameState, ev: Extract<GameEvent, { kind: 'CounterPlaced' }>): void {
	if (ev.amount <= 0) return;
	for (const source of sources(state, 'counterPlaced')) {
		if (source.obj.instanceId !== ev.objectId) continue;
		for (const { ability, alts } of abilitiesFor(state, source, 'counterPlaced')) {
			if (!alts.some((a) => a.filter.object === 'self' && (!a.filter.counter || a.filter.counter === ev.counterType))) continue;
			record(state, source, ability, 'counterPlaced', { label: 'Counter Placed', amount: ev.amount });
		}
	}
}

function matchTargeted(state: GameState, ev: Extract<GameEvent, { kind: 'BecameTarget' }>): void {
	const found = permanentById(state, ev.objectId);
	if (!found) return;
	const subject = battlefieldSubject(state, found.obj, found.controllerId);
	for (const source of sources(state, 'becomesTarget')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'becomesTarget')) {
			const alt = alts.find(
				(a) =>
					(a.filter.targetedBy === 'spellOrAbility' || a.filter.targetedBy === ev.by) &&
					objectMatches(a.filter, subject, source)
			);
			if (alt) record(state, source, ability, 'becomesTarget', { label: 'Targeted', eventObject: found.obj });
		}
	}
}

function matchAttached(state: GameState, ev: Extract<GameEvent, { kind: 'Attached' }>): void {
	const attachment = permanentById(state, ev.attachmentId);
	const hostObj = permanentById(state, ev.hostId);
	if (!attachment || !hostObj) return;
	const attachmentSubject = battlefieldSubject(state, attachment.obj, attachment.controllerId);
	const hostSubject = battlefieldSubject(state, hostObj.obj, hostObj.controllerId);
	for (const source of sources(state, 'attached')) {
		for (const { ability, alts } of abilitiesFor(state, source, 'attached')) {
			const alt = alts.find(
				(a) =>
					objectMatches(a.filter, attachmentSubject, source) &&
					(!a.filter.host || filterMatches(a.filter.host, hostSubject, viewerOf(source)))
			);
			if (alt) record(state, source, ability, 'attached', { label: 'On Attach', eventObject: hostObj.obj });
		}
	}
}

// ---- Flushing: APNAP order (CR 603.3b) ------------------------------------------------------

/**
 * Players in APNAP order: the active player, then the others in turn order (CR 101.4). Players who
 * have left the game control no triggers (CR 800.4a).
 */
function apnap(state: GameState): string[] {
	const n = state.players.length;
	const out: string[] = [];
	for (let k = 0; k < n; k++) {
		const p = state.players[(state.activePlayerIndex + k) % n];
		if (p && !p.lost) out.push(p.playerId);
	}
	return out;
}

/**
 * Puts every pending trigger on the stack (or resolves it inline). The active player's triggers are
 * put on the stack first, then each other player's in turn order (CR 603.3b), so the last
 * non-active player's resolve first; inline triggers run in that resolution order. A player's own
 * simultaneous triggers are in match order (event order, then seat/zone order of their sources).
 * CR 603.3b lets the player choose that order; the choice prompt is Phase 8.
 *
 * Inline triggers run before stacked ones are pushed (the pre-Phase-5 upkeep order: graveyard
 * triggers resolved, then battlefield triggers went on the stack). Triggers that fire while a flush
 * is running are flushed by the nested flush or by the next loop iteration.
 */
export function flushTriggers(state: GameState): void {
	if (!host) return;
	const ch = channel(state);
	if (ch.deferFlush > 0) return;
	ch.flushing += 1;
	try {
		for (let guard = 0; ch.pending.length > 0 && guard < 1000; guard++) {
			const batch = ch.pending.splice(0);
			if (state.status === 'finished') return;
			const order = apnap(state);
			const byPlayer = (mode: TriggerMode, pid: string) =>
				batch.filter((t) => t.mode === mode && t.controllerId === pid).sort((a, b) => a.order - b.order);
			const inline = [...order].reverse().flatMap((pid) => byPlayer('inline', pid));
			const stacked = order.flatMap((pid) => byPlayer('stack', pid));
			for (const t of inline) {
				if ((state.status as GameState['status']) === 'finished') return;
				// CR 603.4: checked again as it resolves.
				if (t.ability.condition && !evaluateCondition(state, t.ability.condition, t.controllerId, t.source.instanceId)) continue;
				host.executeInline(state, t);
			}
			for (const t of stacked) host.putOnStack(state, t);
		}
	} finally {
		ch.flushing -= 1;
	}
}

// ---- Intervening-if conditions (CR 603.4) ---------------------------------------------------

/**
 * Re-checks the intervening-if condition of a triggered ability on the stack (CR 603.4). True if the
 * item has no compiled condition.
 */
export function stackTriggerConditionHolds(
	state: GameState,
	card: ScryfallCard,
	abilityIndex: number,
	controllerId: string,
	sourceInstanceId: string
): boolean {
	const ability = triggersOf(card).all.find((t) => t.abilityIndex === abilityIndex);
	if (!ability?.condition) return true;
	return evaluateCondition(state, ability.condition, controllerId, sourceInstanceId);
}

/** Evaluates an IR Condition for the controller of a triggered ability. Unknown forms are false. */
export function evaluateCondition(state: GameState, cond: Condition, controllerId: string, sourceInstanceId: string): boolean {
	const controller = state.players.find((p) => p.playerId === controllerId);
	if (!controller) return false;
	switch (cond.k) {
		case 'and':
			return cond.of.every((c) => evaluateCondition(state, c, controllerId, sourceInstanceId));
		case 'or':
			return cond.of.some((c) => evaluateCondition(state, c, controllerId, sourceInstanceId));
		case 'not':
			return !evaluateCondition(state, cond.of, controllerId, sourceInstanceId);
		case 'isTurnOf':
			if (cond.player.k === 'you') return state.players[state.activePlayerIndex]?.playerId === controllerId;
			return cond.player.k === 'activePlayer';
		case 'graveyardAbove': {
			// CR 404.2: the graveyard's order matters; the top is the end of the array.
			const idx = controller.graveyard.findIndex((c) => c.instanceId === sourceInstanceId);
			if (idx < 0) return false;
			const above = controller.graveyard.slice(idx + 1);
			const viewer: Viewer = { id: sourceInstanceId, controllerId };
			const n = above.filter((c) => filterMatches(cond.filter, printedSubject(c, c.card, c.ownerId), viewer)).length;
			return n >= cond.count;
		}
		case 'compare': {
			const l = amount(state, cond.left, controllerId, sourceInstanceId);
			const r = amount(state, cond.right, controllerId, sourceInstanceId);
			if (l === null || r === null) return false;
			switch (cond.op) {
				case '>=':
					return l >= r;
				case '<=':
					return l <= r;
				case '>':
					return l > r;
				case '<':
					return l < r;
				case '=':
					return l === r;
			}
			return false;
		}
	}
	return false;
}

/** The Amount kinds conditions use. Anything else is null (the condition is then false). */
function amount(state: GameState, a: Amount, controllerId: string, sourceInstanceId: string): number | null {
	const controller = state.players.find((p) => p.playerId === controllerId);
	if (!controller) return null;
	switch (a.k) {
		case 'const':
			return a.n;
		case 'life':
			return a.of.k === 'you' ? controller.life : null;
		case 'cardsIn': {
			if (a.of.k !== 'you') return null;
			const zone = a.zone;
			return zone === 'hand' || zone === 'library' || zone === 'graveyard' || zone === 'exile' || zone === 'battlefield'
				? controller[zone].length
				: null;
		}
		case 'count': {
			const viewer: Viewer = { id: sourceInstanceId, controllerId };
			let n = 0;
			for (const p of state.players) {
				if (p.lost) continue;
				if (a.of.controller === 'you' && p.playerId !== controllerId) continue;
				if (a.of.controller === 'opponent' && p.playerId === controllerId) continue;
				for (const perm of p.battlefield) {
					if (perm.phasedOut) continue;
					if (filterMatches(a.of, battlefieldSubject(state, perm, p.playerId), viewer)) n++;
				}
			}
			return n;
		}
		default:
			return null;
	}
}
