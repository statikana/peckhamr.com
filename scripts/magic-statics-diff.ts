/**
 * Compares the static/replacement grammar (compiler/statics.ts) with (A) the Phase 1 adapter and
 * (B) what the runtime actually does.
 *
 * Usage:
 *   node scripts/magic-statics-diff.ts <oracle-cards.jsonl.gz> [--out <report.md>]
 *
 * (A) The adapter only compiles board hooks (cost modifiers, multipliers); every other static line
 *     is `static_not_compiled`, so most rows are "line not claimed" there.
 * (B) The engine enforces most statics by scanning rules text at runtime (ruleTree.ts layer code and
 *     rule helpers). For each static line, a one-line card with that text is put on a probe board
 *     with creatures, lands and an enchantment for both players, and what evaluatePermanent and the
 *     rule helpers report (with the card minus without it) is compared with what the grammar's IR
 *     predicts. A mismatch is a grammar error or an engine bug; the report lists them.
 */
import { writeFileSync } from 'node:fs';

import { compileCard } from '../src/lib/magic/compiler/index.ts';
import { normalizeFace, type NormalizedLine } from '../src/lib/magic/compiler/normalize.ts';
import { parseStaticAbility, type StaticItem } from '../src/lib/magic/compiler/statics.ts';
import { createCardInstance, createInitialGameState, playerHasHexproofFrom, playerHasShroud } from '../src/lib/magic/engine.ts';
import { cardEntersTapped } from '../src/lib/magic/oracle.ts';
import { PRECON_DECKS } from '../src/lib/magic/precons.ts';
import {
	checkGlobalCastPermissionsAndRestrictions,
	checkGraveyardReplacementZone,
	evaluatePermanent,
	getLibrarySearchInterceptor,
	playerCannotLoseGame,
	playerCannotWinGame
} from '../src/lib/magic/ruleTree.ts';
import { normalizeScryfallCard } from '../src/lib/magic/scryfall.ts';
import { DEFAULT_LOBBY_RULES, type CardInstance, type GameState, type LobbySeat, type MagicDeck, type ScryfallCard } from '../src/lib/magic/types.ts';
import type { Amount, Condition, ObjectFilter, StaticDef } from '../src/lib/magic/ir.ts';
import { canonical, classify, renderReport, summaryRow, type DiffRow, type Side } from './magic-diff.ts';
import { buildTemplater, NON_GAME_LAYOUTS, preconCards, readBulk } from './magic-shared.ts';

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

// ---- Static lines ---------------------------------------------------------------------------

/** Lines of a permanent that are static abilities: not keywords, triggers or activated abilities. */
function staticLines(card: ScryfallCard): NormalizedLine[] {
	if (card.backFace || card.oracleText.includes('\n//\n')) return [];
	const spell = /\b(?:Instant|Sorcery)\b/.test(card.typeLine);
	const norm = normalizeFace(card.name, card.oracleText);
	// Keyword lines as the adapter classified them (implemented or not).
	const keywordStarts = new Set(
		compileCard(card)
			.faces[0].abilities.filter((a) => a.kind === 'keyword' || (a.kind === 'unsupported' && a.reason === 'keyword_not_implemented'))
			.map((a) => a.span.start)
	);
	return norm.lines.filter((line) => {
		const body = line.body;
		if (line.abilityWord && /^[IVX]+(, [IVX]+)*$/.test(line.abilityWord)) return false; // Saga chapters
		if (/^(?:when|whenever|at)\b/i.test(body) || /^choose\b/i.test(body) || body.startsWith('•')) return false;
		if (/^(?:LEVEL |\d+\+? \||\d+-\d+ \||\d+\/\d+$)/.test(body)) return false; // level-up / station rows
		const quote = body.search(/["“]/);
		const colon = body.indexOf(':');
		if (colon > 0 && (quote < 0 || colon < quote)) return false; // activated / loyalty
		const kwSpan = [...keywordStarts].some((st) => st >= line.span.start && st < line.span.end);
		if (kwSpan) return false; // keyword line
		if (spell) return /^~ costs\b/.test(body); // instants and sorceries: only self cost changes
		return true;
	});
}

function itemDefs(items: StaticItem[]): unknown[] {
	return items.map((i) => (i.kind === 'static' ? i.static : { replacement: i.replacement }));
}

// ---- (A) adapter comparison -----------------------------------------------------------------

function adapterRows(card: ScryfallCard, lines: NormalizedLine[]): DiffRow[] {
	const def = compileCard(card);
	return lines.map((line) => {
		const parsed = parseStaticAbility(line.body);
		const grammar: Side = { complete: parsed.unparsed.length === 0, value: itemDefs(parsed.items) };
		const ab = def.faces[0].abilities.find((a) => a.span.start === line.span.start);
		const adapter: Side | undefined = ab?.kind === 'static' ? { complete: true, value: [ab.static] } : undefined;
		return {
			card: card.name,
			kind: 'static',
			text: line.body,
			bucket: classify(grammar, adapter, same),
			grammar,
			adapter,
			fragments: parsed.unparsed.map((s) => line.body.slice(s.start, s.end))
		};
	});
}

// ---- (B) runtime probes ---------------------------------------------------------------------

let subtypeWords = new Set<string>();

function probeCard(name: string, typeLine: string, extra: Partial<ScryfallCard> = {}): ScryfallCard {
	return {
		id: `probe_${name.toLowerCase().replace(/\W+/g, '_')}`,
		name,
		manaCost: '{2}',
		cmc: 2,
		typeLine,
		oracleText: '',
		colors: [],
		colorIdentity: [],
		keywords: [],
		imageUrl: '',
		artCropUrl: '',
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		...extra
	};
}

interface Probe {
	label: string;
	card: ScryfallCard;
	player: 0 | 1;
}

function probesFor(line: string): Probe[] {
	// Give the creature probes every subtype the line mentions, so lords and "other Elf" apply.
	const subs = [...new Set((line.match(/\b[A-Z][a-z]+\b/g) || []).map((w) => (w === 'Elves' ? 'Elf' : w.replace(/s$/, ''))).filter((w) => subtypeWords.has(w) && !['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Aura', 'Equipment'].includes(w)))];
	const kin = subs.length > 0 ? subs.join(' ') : 'Bear';
	return [
		{ label: 'kin', card: probeCard('Probe Kin', `Creature — ${kin}`, { power: '2', toughness: '2' }), player: 0 },
		{ label: 'flyer', card: probeCard('Probe Flyer', 'Creature — Bird', { power: '2', toughness: '2', oracleText: 'Flying', keywords: ['Flying'] }), player: 0 },
		{ label: 'rival', card: probeCard('Probe Rival', `Creature — ${kin}`, { power: '2', toughness: '2', oracleText: 'Flying', keywords: ['Flying'] }), player: 1 },
		{ label: 'land', card: probeCard('Probe Land', 'Land', { manaCost: '', cmc: 0, oracleText: '{T}: Add {C}.' }), player: 0 },
		{ label: 'basic', card: probeCard('Probe Forest', 'Basic Land — Forest', { manaCost: '', cmc: 0 }), player: 0 },
		{ label: 'relic', card: probeCard('Probe Relic', 'Enchantment', { manaCost: '{3}', cmc: 3 }), player: 0 },
		{ label: 'trinket', card: probeCard('Probe Trinket', 'Artifact', { manaCost: '{2}', cmc: 2 }), player: 0 }
	];
}

let baseState: GameState | undefined;

function freshState(): GameState {
	if (!baseState) {
		const seats: LobbySeat[] = [0, 1].map((i) => ({
			seatIndex: i,
			userId: `player_${i + 1}`,
			username: `P${i + 1}`,
			avatarUrl: '',
			isBot: false,
			deckId: PRECON_DECKS[i].id,
			deckName: PRECON_DECKS[i].name,
			commanderNames: [],
			commanderArtUrl: '',
			colorIdentity: PRECON_DECKS[i].colorIdentity,
			isDeckLegal: true,
			ready: true,
			lastHeartbeat: 0
		}));
		baseState = createInitialGameState('PROBE', seats, new Map<number, MagicDeck>([[0, PRECON_DECKS[0]], [1, PRECON_DECKS[1]]]), { ...DEFAULT_LOBBY_RULES });
	}
	const state = structuredClone(baseState);
	for (const p of state.players) {
		p.battlefield = [];
		p.graveyard = [];
		p.spellsCastThisTurn = 0;
	}
	state.activePlayerIndex = 0;
	state.phase = 'main1';
	state.stack = [];
	return state;
}

interface Board {
	state: GameState;
	insts: Map<string, CardInstance>;
	source?: CardInstance;
}

function buildBoard(probes: Probe[], source: ScryfallCard | undefined): Board {
	const state = freshState();
	const insts = new Map<string, CardInstance>();
	let ts = 0;
	const put = (card: ScryfallCard, player: 0 | 1) => {
		const owner = state.players[player].playerId;
		const inst = createCardInstance(card, owner, 'battlefield', false, false, ++ts);
		inst.controllerId = owner;
		inst.summoningSick = false;
		state.players[player].battlefield.push(inst);
		return inst;
	};
	for (const p of probes) insts.set(p.label, put(p.card, p.player));
	let src: CardInstance | undefined;
	if (source) {
		src = put(source, 0);
		if (/\b(?:Aura|Equipment)\b/.test(source.typeLine)) src.attachedToId = insts.get('kin')!.instanceId;
	}
	return { state, insts, source: src };
}

interface ObjectView {
	pt?: [number, number];
	types: string[];
	keywords: string[];
	lost: boolean;
	allTypes: boolean;
}

const TYPE_WORDS = new Set(['Artifact', 'Battle', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Instant', 'Sorcery', 'Kindred']);

function viewOf(board: Board, inst: CardInstance): ObjectView {
	const ev = evaluatePermanent(board.state, inst);
	const words = ev.effectiveTypeLine.replace('—', ' ').split(/\s+/).filter((w) => w && w !== 'All-Types' && w !== 'Basic' && w !== 'Legendary' && w !== 'Snow');
	const keywords = ev.activeKeywords.map((k) => k.toLowerCase()).filter((k) => !k.startsWith('changeling (')).sort();
	return {
		pt: ev.isCreature ? [ev.power, ev.toughness] : undefined,
		types: [...new Set(words)].sort(),
		keywords,
		lost: ev.hasLostAllAbilities,
		allTypes: ev.hasAllCreatureTypes && ev.isCreature
	};
}

type Delta = Record<string, unknown>;

function deltaOf(before: ObjectView, after: ObjectView): Delta {
	const d: Delta = {};
	if (canonical(before.pt) !== canonical(after.pt)) d.pt = after.pt ?? null;
	const addT = after.types.filter((t) => !before.types.includes(t));
	const remT = before.types.filter((t) => !after.types.includes(t));
	if (addT.length) d.typesAdded = addT;
	if (remT.length) d.typesRemoved = remT;
	const addK = after.keywords.filter((k) => !before.keywords.includes(k));
	const remK = before.keywords.filter((k) => !after.keywords.includes(k));
	if (addK.length) d.keywordsAdded = addK;
	if (remK.length) d.keywordsRemoved = remK;
	if (after.lost && !before.lost) d.lostAllAbilities = true;
	if (after.allTypes && !before.allTypes) d.allCreatureTypes = true;
	return d;
}

interface RuleView {
	flash: boolean;
	opponentCommandCastBlocked: boolean;
	opponentHandCastBlocked: boolean;
	secondSpellBlocked: boolean;
	cantLose: boolean;
	opponentCantWin: boolean;
	graveyardToExile: boolean;
	opponentSearchControlled: boolean;
	hexproof: boolean;
	shroud: boolean;
}

function rulesOf(board: Board): RuleView {
	const [p1, p2] = board.state.players;
	p1.spellsCastThisTurn = 1;
	const second = checkGlobalCastPermissionsAndRestrictions(board.state, p1, 'hand').blocked;
	p1.spellsCastThisTurn = 0;
	return {
		flash: checkGlobalCastPermissionsAndRestrictions(board.state, p1, 'hand').allowedAsThoughFlash,
		opponentCommandCastBlocked: checkGlobalCastPermissionsAndRestrictions(board.state, p2, 'command').blocked,
		opponentHandCastBlocked: checkGlobalCastPermissionsAndRestrictions(board.state, p2, 'hand').blocked,
		secondSpellBlocked: second,
		cantLose: playerCannotLoseGame(board.state, p1).protected,
		opponentCantWin: playerCannotWinGame(board.state, p2).blocked,
		graveyardToExile: checkGraveyardReplacementZone(board.state, 'graveyard').dest === 'exile',
		opponentSearchControlled: getLibrarySearchInterceptor(board.state, p2.playerId) !== null,
		hexproof: playerHasHexproofFrom(board.state, p1, p2.playerId),
		shroud: playerHasShroud(board.state, p1)
	};
}

function runtimeObservation(sourceCard: ScryfallCard, probes: Probe[]): Record<string, unknown> {
	const without = buildBoard(probes, undefined);
	const withSrc = buildBoard(probes, sourceCard);
	const out: Record<string, unknown> = {};
	for (const p of probes) {
		const d = deltaOf(viewOf(without, without.insts.get(p.label)!), viewOf(withSrc, withSrc.insts.get(p.label)!));
		if (Object.keys(d).length) out[p.label] = d;
	}
	// The source itself: compare with its printed characteristics.
	const printed: ObjectView = {
		pt: sourceCard.typeLine.includes('Creature') && /^\d+$/.test(sourceCard.power ?? '') && /^\d+$/.test(sourceCard.toughness ?? '')
			? [parseInt(sourceCard.power!, 10), parseInt(sourceCard.toughness!, 10)]
			: undefined,
		types: viewOfPrinted(sourceCard),
		keywords: [],
		lost: false,
		allTypes: false
	};
	const selfView = viewOf(withSrc, withSrc.source!);
	selfView.keywords = [];
	const selfDelta = deltaOf(printed, selfView);
	if (printed.pt === undefined && selfView.pt && sourceCard.typeLine.includes('Creature')) delete selfDelta.pt; // */* with no CDA probe
	if (Object.keys(selfDelta).length) out.self = selfDelta;

	const r0 = rulesOf(without);
	const r1 = rulesOf(withSrc);
	const rules = Object.fromEntries(Object.entries(r1).filter(([k, v]) => v !== (r0 as unknown as Record<string, boolean>)[k]));
	if (Object.keys(rules).length) out.rules = rules;
	if (cardEntersTapped(sourceCard)) out.entersTapped = true;
	return out;
}

function viewOfPrinted(card: ScryfallCard): string[] {
	return [...new Set(card.typeLine.replace('—', ' ').split(/\s+/).filter((w) => w && !['Basic', 'Legendary', 'Snow'].includes(w)))].sort();
}

// ---- (B) grammar prediction -----------------------------------------------------------------

interface Obj {
	label: string;
	player: 0 | 1;
	isSource: boolean;
	attachedToSource: boolean;
	cmc: number;
	types: string[];
	subtypes: string[];
	supertypes: string[];
	keywords: string[];
	pt?: [number, number];
	lost: boolean;
	allTypes: boolean;
	printedTypes: string[];
}

function objFromCard(label: string, card: ScryfallCard, player: 0 | 1, isSource: boolean, attached: boolean): Obj {
	const [left, right = ''] = card.typeLine.split(/\s+—\s+/);
	const words = left.split(/\s+/);
	const types = words.filter((w) => TYPE_WORDS.has(w));
	return {
		label,
		player,
		isSource,
		attachedToSource: attached,
		cmc: card.cmc,
		types,
		subtypes: right.split(/\s+/).filter(Boolean),
		supertypes: words.filter((w) => !TYPE_WORDS.has(w)),
		keywords: isSource ? [] : card.keywords.map((k) => k.toLowerCase()),
		pt: /^\d+$/.test(card.power ?? '') ? [parseInt(card.power!, 10), parseInt(card.toughness!, 10)] : undefined,
		lost: false,
		allTypes: false,
		printedTypes: viewOfPrinted(card)
	};
}

function matches(o: Obj, f: ObjectFilter, all: Obj[]): boolean {
	void all;
	if (f.types && !f.types.some((t) => o.types.includes(t))) return false;
	if (f.subtypes && !f.subtypes.some((s) => o.subtypes.includes(s) || (o.allTypes && o.types.includes('Creature')))) return false;
	if (f.supertypes && !f.supertypes.every((s) => o.supertypes.includes(s))) return false;
	if (f.notTypes && f.notTypes.some((t) => o.types.includes(t))) return false;
	if (f.notSupertypes && f.notSupertypes.some((s) => o.supertypes.includes(s))) return false;
	if (f.notSubtypes && f.notSubtypes.some((s) => o.subtypes.includes(s))) return false;
	if (f.controller === 'you' && o.player !== 0) return false;
	if (f.controller === 'opponent' && o.player !== 1) return false;
	if (f.other && o.isSource) return false;
	if (f.token === true) return false;
	if (f.zone && f.zone !== 'battlefield') return false;
	return true;
}

function amountOf(a: Amount, o: Obj, all: Obj[]): number | null {
	switch (a.k) {
		case 'const':
			return a.n;
		case 'count':
			if (a.of.zone === 'graveyard') return 0;
			return all.filter((x) => matches(x, a.of, all)).length;
		case 'stat':
			return a.of.k === 'affected' && a.stat === 'manaValue' ? o.cmc : null;
		case 'cardsIn':
			return null;
		default:
			return null;
	}
}

function conditionHolds(c: Condition | undefined, all: Obj[]): boolean | null {
	if (!c) return true;
	if (c.k === 'compare') {
		const left = c.left.k === 'count' ? all.filter((x) => matches(x, (c.left as Extract<Amount, { k: 'count' }>).of, all)).length : c.left.k === 'life' ? 40 : null;
		const right = c.right.k === 'const' ? c.right.n : null;
		if (left === null || right === null) return null;
		return c.op === '>=' ? left >= right : c.op === '<=' ? left <= right : c.op === '=' ? left === right : c.op === '>' ? left > right : left < right;
	}
	if (c.k === 'isTurnOf') return true; // the source's controller is the active player on the probe board
	if (c.k === 'not') {
		const v = conditionHolds(c.of, all);
		return v === null ? null : !v;
	}
	return null;
}

const BASIC_SUBTYPES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
const PROBEABLE_RULES: Record<string, keyof RuleView> = {
	castAsThoughFlash: 'flash',
	castOnlyFromHand: 'opponentCommandCastBlocked',
	castOnlySorcerySpeed: 'opponentHandCastBlocked',
	opponentsCantCastDuringYourTurn: 'opponentHandCastBlocked',
	oneSpellPerTurn: 'secondSpellBlocked',
	cantLose: 'cantLose',
	opponentsCantWin: 'opponentCantWin',
	searchControl: 'opponentSearchControlled',
	playerHexproof: 'hexproof',
	playerShroud: 'shroud'
};

/** What the IR says should happen on the probe board. Null if it uses something the predictor can't evaluate. */
function predict(sourceCard: ScryfallCard, probes: Probe[], items: StaticItem[]): { observation: Record<string, unknown>; probeable: boolean } | null {
	const attached = /\b(?:Aura|Equipment)\b/.test(sourceCard.typeLine);
	const objs = probes.map((p) => objFromCard(p.label, p.card, p.player, false, attached && p.label === 'kin'));
	const self = objFromCard('self', sourceCard, 0, true, false);
	const all = [...objs, self];
	const before = all.map((o) => structuredClone(o));
	let probeable = false;
	const rules: Record<string, boolean> = {};
	let entersTapped = false;

	const statics: Extract<StaticDef, { k: 'continuous' }>[] = [];
	for (const item of items) {
		if (item.kind === 'replacement') {
			const r = item.replacement;
			if (r.replaces.event === 'zoneChange' && r.replaces.filter.to === 'graveyard' && !Array.isArray(r.with) && r.with.k === 'modify' && r.with.to === 'exile') {
				rules.graveyardToExile = true;
				probeable = true;
			}
			if (r.replaces.filter.object === 'self' && !Array.isArray(r.with) && r.with.k === 'modify' && r.with.tapped) {
				entersTapped = true;
				probeable = true;
			}
			continue;
		}
		const def = item.static;
		if (def.k === 'continuous') {
			statics.push(def);
			probeable = true;
		} else if (def.k === 'ruleModifier' && PROBEABLE_RULES[def.rule]) {
			const holds = conditionHolds(def.condition, all);
			if (holds === null) return null;
			if (holds) {
				rules[PROBEABLE_RULES[def.rule]] = true;
				// Restricting opponents to sorcery timing (or to nothing during your turn) also blocks
				// their command-zone casts on the probe board, which is during P1's main phase.
				if (def.rule === 'castOnlySorcerySpeed' || def.rule === 'opponentsCantCastDuringYourTurn') rules.opponentCommandCastBlocked = true;
			}
			probeable = true;
		}
	}

	let selfTouched = false;
	const affectedBy = (def: Extract<StaticDef, { k: 'continuous' }>, o: Obj) => {
		const hit = def.affected === 'self' ? o.isSource : def.affected === 'attachedTo' ? o.attachedToSource : matches(o, def.affected, all);
		if (hit && o.isSource) selfTouched = true;
		return hit;
	};
	const layerOrder = ['1', '2', '3', '4', '5', '6', '7a', '7b', '7c', '7d'];
	for (const layer of layerOrder) {
		for (const def of statics.filter((d) => d.layer === layer)) {
			const holds = conditionHolds(def.condition, all);
			if (holds === null) return null;
			if (!holds) continue;
			for (const o of all) {
				if (!affectedBy(def, o)) continue;
				const mod = def.mod;
				switch (mod.k) {
					case 'setTypes':
						o.types = [...mod.types];
						o.subtypes = [...(mod.subtypes ?? [])];
						// CR 305.7: a basic land type set on a land removes its rules-text abilities.
						if (o.types.includes('Land') && o.subtypes.some((s) => BASIC_SUBTYPES.includes(s))) o.lost = true;
						break;
					case 'addTypes':
						o.types = [...new Set([...o.types, ...mod.types])];
						o.subtypes = [...new Set([...o.subtypes, ...(mod.subtypes ?? [])])];
						break;
					case 'setSubtypes':
						o.subtypes = [...mod.subtypes];
						if (mod.subtypes.some((s) => BASIC_SUBTYPES.includes(s))) o.lost = true; // CR 305.7
						break;
					case 'allCreatureTypes':
						if (o.types.includes('Creature')) o.allTypes = true;
						break;
					case 'setColors':
					case 'grantAbility':
						break; // not observable on the probe board
					case 'removeAllAbilities':
						o.lost = true;
						o.keywords = [];
						break;
					case 'addKeywords':
						o.keywords = [...new Set([...o.keywords, ...mod.keywords])];
						break;
					case 'removeKeywords':
						o.keywords = o.keywords.filter((k) => !mod.keywords.includes(k));
						break;
					case 'setBasePT': {
						const p = amountOf(mod.power, o, all);
						const t = amountOf(mod.toughness, o, all);
						if (p === null || t === null) return null;
						o.pt = [p, t];
						break;
					}
					case 'pt': {
						const p = amountOf(mod.power, o, all);
						const t = amountOf(mod.toughness, o, all);
						if (p === null || t === null) return null;
						if (o.pt) o.pt = [o.pt[0] + p, o.pt[1] + t];
						break;
					}
					case 'switchPT':
						if (o.pt) o.pt = [o.pt[1], o.pt[0]];
						break;
				}
			}
		}
	}
	// Abilities removed in layer 6 also remove the source's own effects, but only from objects other
	// than the source on this single-source board; the probe can't see that, so no adjustment here.

	const observation: Record<string, unknown> = {};
	for (let i = 0; i < all.length; i++) {
		const o = all[i];
		const b = before[i];
		const isCreature = o.types.includes('Creature');
		const view = (x: Obj, creature: boolean): ObjectView => ({
			pt: creature ? (x.pt ? [Math.max(0, x.pt[0]), Math.max(0, x.pt[1])] : [0, 0]) : undefined,
			types: [...new Set([...x.types, ...x.subtypes])].sort(),
			keywords: x.isSource ? [] : [...x.keywords].sort(),
			lost: x.lost,
			allTypes: x.allTypes
		});
		if (o.isSource && !selfTouched) continue;
		const bView = view(b, b.types.includes('Creature'));
		const d = deltaOf(bView, view(o, isCreature));
		if (o.isSource) delete d.lostAllAbilities; // the probe doesn't report a source losing its own abilities
		if (Object.keys(d).length) observation[o.label] = d;
	}
	if (Object.keys(rules).length) observation.rules = rules;
	if (entersTapped) observation.entersTapped = true;
	return { observation, probeable };
}

function runtimeRows(card: ScryfallCard, lines: NormalizedLine[]): DiffRow[] {
	const rows: DiffRow[] = [];
	for (const line of lines) {
		const probes = probesFor(line.raw);
		const source: ScryfallCard = { ...card, oracleText: line.raw, keywords: [] };
		const observed = runtimeObservation(source, probes);
		const parsed = parseStaticAbility(line.body);
		const prediction = parsed.unparsed.length === 0 ? predict(source, probes, parsed.items) : null;
		const grammarComplete = prediction !== null && prediction.probeable;
		const runtimeDid = Object.keys(observed).length > 0;
		if (!grammarComplete && !runtimeDid && parsed.unparsed.length === 0) continue; // nothing observable either way
		const grammar: Side = { complete: grammarComplete, value: prediction?.observation ?? {} };
		const runtime: Side = { complete: runtimeDid, value: observed };
		rows.push({
			card: card.name,
			kind: 'static',
			text: line.body,
			bucket: classify(grammar, runtime, same),
			grammar,
			adapter: runtime,
			fragments: parsed.unparsed.map((s) => line.body.slice(s.start, s.end))
		});
	}
	return rows;
}

// ---- Main -----------------------------------------------------------------------------------

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const bulkPath = argv.find((a) => !a.startsWith('--'));
	const outIdx = argv.indexOf('--out');
	const out = outIdx >= 0 ? argv[outIdx + 1] : undefined;
	if (!bulkPath) throw new Error('Usage: node scripts/magic-statics-diff.ts <oracle-cards.jsonl.gz> [--out <file>]');

	// Subtypes first: the probes and the templater need them.
	const subtypes = new Set<string>();
	const cards: ScryfallCard[] = [];
	for await (const raw of readBulk(bulkPath)) {
		if (NON_GAME_LAYOUTS.has(String(raw.layout ?? 'normal'))) continue;
		for (const tl of String(raw.type_line ?? '').split(' // ')) {
			const right = tl.split(' — ')[1];
			if (right) for (const s of right.split(/\s+/)) if (s) subtypes.add(s);
		}
		cards.push(normalizeScryfallCard(raw));
	}
	subtypeWords = subtypes;
	const templater = buildTemplater(subtypes);

	const preconA: DiffRow[] = [];
	const preconB: DiffRow[] = [];
	for (const c of preconCards()) {
		const lines = staticLines(c);
		preconA.push(...adapterRows(c, lines));
		preconB.push(...runtimeRows(c, lines));
	}
	const bulkA: DiffRow[] = [];
	const bulkB: DiffRow[] = [];
	for (const c of cards) {
		const lines = staticLines(c);
		if (lines.length === 0) continue;
		bulkA.push(...adapterRows(c, lines));
		bulkB.push(...runtimeRows(c, lines));
	}

	const partA = renderReport({
		title: 'Static grammar vs adapter',
		intro: [
			'Generated by `scripts/magic-statics-diff.ts`. Each static-ability line of a permanent (not a keyword,',
			'trigger or activated ability; for instants and sorceries only "~ costs ..." lines) is parsed by the',
			'static/replacement grammar (`compiler/statics.ts`) and compared with the Phase 1 adapter, which only',
			'compiles board hooks (cost modifiers and multipliers) and leaves every other static line as',
			'`static_not_compiled`, so most rows are "line not claimed" here. Part B below compares with the runtime.'
		],
		adapterNote: ["Lines the adapter compiled to a board hook that the grammar doesn't understand."],
		precon: preconA,
		bulk: bulkA,
		templater
	});
	const partB = renderReport({
		title: 'Static grammar vs runtime (probe boards)',
		intro: [
			'Each static line is put, as a one-line card controlled by P1, on a board with probe permanents:',
			'creatures for P1 (`kin`, given every subtype the line names, and a `flyer`) and P2 (`rival`, a flyer),',
			'a nonbasic `land`, a `basic` Forest, an enchantment (`relic`, mana value 3) and an artifact (`trinket`).',
			'Auras and Equipment are attached to `kin`. The runtime column is what `evaluatePermanent` and the rule',
			'helpers (cast permissions, can\'t lose/win, graveyard replacement, search control, player hexproof/',
			'shroud, enters tapped) report with the card minus without it; `self` compares the card with its printed',
			'characteristics. The grammar column is what its IR predicts on the same board, applying layers in order',
			'and CR 305.7. "Adapter only" here means the runtime does something for text the grammar can\'t read;',
			'"Differ" means the runtime and the IR disagree on a sentence both understand. Colour, granted mana',
			'abilities, cost modifiers, multipliers, hand size, attack tax and draw replacement are not probed.'
		],
		adapterNote: [
			"The runtime enforces something for a line the grammar can't parse. Often the runtime is matching a",
			'phrase and ignoring the rest of the sentence (a condition, a restriction); check each one.'
		],
		precon: preconB,
		bulk: bulkB,
		templater
	});

	const report = `${partA}\n${partB.replace(/^# /, '# Part B: ')}`.replace(/^# Static grammar vs adapter/, '# Part A: Static grammar vs adapter');
	if (out) writeFileSync(out, `# Static/replacement grammar\n\n${report}`);
	else process.stdout.write(report);
	console.error(`A ${summaryRow('precon', preconA)}\nA ${summaryRow('bulk', bulkA)}\nB ${summaryRow('precon', preconB)}\nB ${summaryRow('bulk', bulkB)}`);
}

await main();
