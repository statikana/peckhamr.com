import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createCardInstance, createInitialGameState } from './engine.ts';
import { PRECON_DECKS, STAPLE_CARDS } from './precons.ts';
import { evaluatePermanent, permanentHasLostAllAbilities } from './ruleTree.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type ScryfallCard
} from './types.ts';

/**
 * Layer snapshots (ENGINE_ARCHITECTURE_PLAN.md, Phase 6 entry condition).
 *
 * Pins what today's continuous-effect code (inspectCardContinuousBreakdown,
 * permanentHasLostAllAbilities, evaluatePermanent) reports for every permanent on a set of boards,
 * so the Phase 6 rewrite shows every difference. A changed snapshot must be either a regression or
 * a documented rules fix. Entries listed in a scenario's `knownWrong` record current behaviour that
 * is wrong; when Phase 6 fixes one, its snapshot changes on purpose.
 *
 * Expected output: layers.snapshot.json. Regenerate after an intended change with
 *   UPDATE_LAYER_SNAPSHOTS=1 node --test src/lib/magic/layers.snapshot.test.ts
 * and review the diff. Regeneration refuses to run under CI.
 */

const SNAPSHOT_PATH = join(new URL('.', import.meta.url).pathname, 'layers.snapshot.json');
const UPDATE = process.env.UPDATE_LAYER_SNAPSHOTS === '1';
if (UPDATE && process.env.CI) {
	throw new Error('UPDATE_LAYER_SNAPSHOTS must not be set in CI; regenerate locally and commit the diff.');
}

// ---- Cards ----------------------------------------------------------------------------------

function real(name: string): ScryfallCard {
	const card = STAPLE_CARDS[name.toLowerCase()];
	if (!card) throw new Error(`Not a precon card: ${name}`);
	return card;
}

function card(spec: Partial<ScryfallCard> & { name: string; typeLine: string }): ScryfallCard {
	return {
		id: `layer_${spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		manaCost: '{1}',
		cmc: 1,
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
		...spec
	};
}

// Synthetic cards with invented names, one per pattern, so the snapshots don't hinge on real names.
const SKY = card({ name: 'Skyreach Sentinel', typeLine: 'Creature — Bird Soldier', power: '2', toughness: '2', oracleText: 'Flying', keywords: ['Flying'] });
const BRUTE = card({ name: 'Thornwood Brute', typeLine: 'Creature — Beast', power: '5', toughness: '5', cmc: 5, oracleText: 'Trample', keywords: ['Trample'] });
const ELF = card({ name: 'Mossback Elf', typeLine: 'Creature — Elf Druid', power: '1', toughness: '1' });
const BEAR = card({ name: 'Hearthfield Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2', cmc: 2 });
const MARSHAL = card({ name: 'Elvenwood Marshal', typeLine: 'Creature — Elf Warrior', power: '2', toughness: '2', oracleText: 'Other Elf creatures you control get +1/+1.' });
const CHIEFTAIN = card({ name: 'Emberhorn Chieftain', typeLine: 'Creature — Goblin', power: '2', toughness: '2', oracleText: 'Goblin creatures you control get +1/+1 and have haste.' });
const BANNER = card({ name: 'Banner of the Hollow Vale', typeLine: 'Enchantment', cmc: 3, oracleText: 'Creatures you control get +1/+1.' });
const SHRINE = card({ name: 'Lanternlit Shrine', typeLine: 'Enchantment', cmc: 3, oracleText: 'Whenever you cast a spell, you gain 1 life.' });
const VEIL = card({ name: 'Veil of Unmaking', typeLine: 'Enchantment — Aura', oracleText: 'Enchant creature\nEnchanted creature loses all abilities.' });
const GLOOM = card({ name: 'Gloomweave Shroud', typeLine: 'Enchantment — Aura', oracleText: 'Enchant creature\nEnchanted creature has base power and toughness 0/1.' });
const TITAN = card({ name: 'Titanbone Mantle', typeLine: 'Enchantment — Aura', oracleText: 'Enchant creature\nEnchanted creature has base power and toughness 4/4.' });
const HYMN = card({ name: 'Verdant Sealing Hymn', typeLine: 'Enchantment — Aura', oracleText: 'Enchant permanent\nEnchanted permanent is a colorless Forest land and loses all other card types and abilities.' });
const HEX = card({ name: 'Crushing Weight Hex', typeLine: 'Enchantment — Aura', oracleText: 'Enchant creature\nEnchanted creature gets -3/-0.' });
const HARNESS = card({ name: 'Wingsteel Harness', typeLine: 'Artifact — Equipment', oracleText: 'Equipped creature gets +2/+2 and has flying.\nEquip {2}' });
const COLOSSUS = card({ name: 'Hollowroot Colossus', typeLine: 'Creature — Plant', power: '*', toughness: '*', oracleText: "Hollowroot Colossus's power and toughness are each equal to the number of creatures you control." });
const GRAVESWORN = card({ name: 'Gravesworn Horror', typeLine: 'Creature — Horror', power: '*', toughness: '*', oracleText: "Gravesworn Horror's power and toughness are each equal to the number of creature cards in all graveyards." });
const WATCHTOWER = card({ name: 'Duskmire Watchtower', typeLine: 'Land', manaCost: '', cmc: 0, oracleText: '{T}: Add {C}.' });
const SIGIL = card({ name: 'Grounding Sigil', typeLine: 'Enchantment', oracleText: 'Creatures your opponents control lose flying.' });
const WARHORN = card({ name: 'Rallying Warhorn', typeLine: 'Artifact', oracleText: '{1}: Target creature you control gains haste until end of turn.' });
const RITE = card({ name: 'Pyre Rite', typeLine: 'Sorcery', oracleText: 'Draw a card.' });

// ---- Boards ---------------------------------------------------------------------------------

class Board {
	readonly state: GameState;
	readonly players: string[];
	private ts = 0;
	private readonly labels = new Map<string, string>();
	private readonly nameCounts = new Map<string, number>();

	constructor(playerCount: number) {
		const seats: LobbySeat[] = [];
		const decks = new Map<number, MagicDeck>();
		for (let i = 0; i < playerCount; i++) {
			const deck = PRECON_DECKS[i % PRECON_DECKS.length];
			seats.push({
				seatIndex: i,
				userId: `player_${i + 1}`,
				username: `P${i + 1}`,
				avatarUrl: '',
				isBot: false,
				deckId: deck.id,
				deckName: deck.name,
				commanderNames: deck.commanders.map((c) => c.name),
				commanderArtUrl: '',
				colorIdentity: deck.colorIdentity,
				isDeckLegal: true,
				ready: true,
				lastHeartbeat: 0
			});
			decks.set(i, deck);
		}
		this.state = createInitialGameState('LAYERS', seats, decks, { ...DEFAULT_LOBBY_RULES });
		this.players = this.state.players.map((p) => p.playerId);
		for (const p of this.state.players) assert.equal(p.battlefield.length, 0);
	}

	/** Puts a permanent onto `player`'s battlefield with the next timestamp. */
	add(
		c: ScryfallCard,
		opts: { player?: number; attachTo?: CardInstance; zone?: 'battlefield' | 'graveyard'; edit?: (i: CardInstance) => void } = {}
	): CardInstance {
		const owner = this.players[opts.player ?? 0];
		const zone = opts.zone ?? 'battlefield';
		this.ts += 1;
		const inst = createCardInstance(c, owner, zone, false, false, this.ts);
		inst.controllerId = owner;
		inst.summoningSick = false;
		if (opts.attachTo) inst.attachedToId = opts.attachTo.instanceId;
		opts.edit?.(inst);
		this.state.players.find((p) => p.playerId === owner)![zone].push(inst);

		const n = (this.nameCounts.get(c.name) ?? 0) + 1;
		this.nameCounts.set(c.name, n);
		this.labels.set(inst.instanceId, n === 1 ? c.name : `${c.name} #${n}`);
		return inst;
	}

	/** Replaces instance and player ids anywhere in a string with stable labels. */
	normalize(s: string): string {
		let out = s;
		for (const [id, label] of this.labels) out = out.split(id).join(`<${label}>`);
		this.players.forEach((id, i) => (out = out.split(id).join(`<P${i + 1}>`)));
		return out;
	}

	snapshot(): Record<string, PermanentSnapshot> {
		const out: Record<string, PermanentSnapshot> = {};
		this.state.players.forEach((p, pi) => {
			for (const inst of p.battlefield) {
				out[this.labels.get(inst.instanceId)!] = this.snapshotOne(inst, pi);
			}
		});
		return out;
	}

	private snapshotOne(inst: CardInstance, playerIndex: number): PermanentSnapshot {
		const ev = evaluatePermanent(this.state, inst);
		const lost = permanentHasLostAllAbilities(inst, this.state);
		const b = ev.breakdown;
		const n = (s: string) => this.normalize(s);
		return {
			controller: `P${playerIndex + 1}`,
			...(inst.phasedOut ? { phasedOut: true } : {}),
			...(inst.attachedToId ? { attachedTo: n(inst.attachedToId) } : {}),
			effectiveTypeLine: ev.effectiveTypeLine,
			is: {
				creature: ev.isCreature,
				artifact: ev.isArtifact,
				enchantment: ev.isEnchantment,
				land: ev.isLand,
				planeswalker: ev.isPlaneswalker,
				legendary: ev.isLegendary,
				allCreatureTypes: ev.hasAllCreatureTypes
			},
			basePT: [b.basePower, b.baseToughness],
			breakdownPT: [b.effectivePower, b.effectiveToughness],
			evaluatedPT: [ev.power, ev.toughness],
			typeModifiedBy: b.typeModifiedBy.map(n),
			ptModifiedBy: b.ptModifiedBy.map(n),
			activeKeywords: ev.activeKeywords,
			lostAllAbilities: { lost: lost.lost, sources: lost.sources.map(n) },
			items: b.items.map((it) => ({
				key: n(it.canonicalKey),
				name: n(it.name),
				kind: it.kind,
				...(it.isInnate ? { innate: true } : {}),
				sources: it.sources.map(n),
				...(it.removed ? { removedBy: it.removedBy.map(n) } : {})
			}))
		};
	}
}

interface PermanentSnapshot {
	controller: string;
	phasedOut?: boolean;
	attachedTo?: string;
	effectiveTypeLine: string;
	is: Record<string, boolean>;
	basePT: Array<number | null>;
	breakdownPT: Array<number | null>;
	evaluatedPT: number[];
	typeModifiedBy: string[];
	ptModifiedBy: string[];
	activeKeywords: string[];
	lostAllAbilities: { lost: boolean; sources: string[] };
	items: Array<Record<string, unknown>>;
}

interface KnownWrong {
	/** Permanent label the entry is about. */
	permanent: string;
	/** What the engine reports today, and what the rules say instead. */
	note: string;
	/** Test that tracks the fix, if any. */
	todo?: string;
}

interface Scenario {
	name: string;
	description: string;
	players?: number;
	knownWrong?: KnownWrong[];
	build: (b: Board) => void;
}

// ---- Scenarios ------------------------------------------------------------------------------

const SCENARIOS: Scenario[] = [
	// Attached type changers (layer 4) with ability removal (layer 6) and base P/T (layer 7b).
	{
		name: 'aura/darksteel-mutation',
		description: 'Darksteel Mutation on a flyer: Insect artifact creature 0/1, indestructible, other abilities lost.',
		build: (b) => b.add(real('Darksteel Mutation'), { attachTo: b.add(SKY) })
	},
	{
		name: "aura/kenrith's-transformation",
		description: "Kenrith's Transformation on a 5/5 trampler: green Elk 3/3 with no abilities.",
		build: (b) => b.add(real("Kenrith's Transformation"), { attachTo: b.add(BRUTE) })
	},
	{
		name: 'aura/imprisoned-in-the-moon-on-creature',
		description: 'Imprisoned in the Moon on a flyer: colorless land with "{T}: Add {C}", no other types or abilities.',
		build: (b) => b.add(real('Imprisoned in the Moon'), { attachTo: b.add(SKY) })
	},
	{
		name: 'aura/imprisoned-in-the-moon-on-land',
		description: 'Imprisoned in the Moon on Command Tower.',
		build: (b) => b.add(real('Imprisoned in the Moon'), { attachTo: b.add(real('Command Tower')) })
	},
	{
		name: 'aura/song-of-the-dryads-oracle-text',
		description: 'Song of the Dryads (current Oracle text: "is a colorless Forest land.") on a flyer.',
		knownWrong: [
			{
				permanent: 'Skyreach Sentinel',
				note: 'Keeps Flying and is not marked as having lost its abilities. CR 305.7: setting a basic land type removes the abilities from its rules text; CR 205.1a: the new card type replaces Creature.',
				todo: 'D-Audit-5'
			}
		],
		build: (b) => b.add(real('Song of the Dryads'), { attachTo: b.add(SKY) })
	},
	{
		name: 'aura/forest-land-explicit-wording',
		description: 'Synthetic Song-style Aura that spells out "loses all other card types and abilities".',
		build: (b) => b.add(HYMN, { attachTo: b.add(SKY) })
	},
	{
		name: 'aura/timestamps-mutation-then-forest',
		description: 'Darksteel Mutation (earlier) then the Forest-land Aura (later) on the same creature: later wins in layer 4.',
		build: (b) => {
			const target = b.add(BEAR);
			b.add(real('Darksteel Mutation'), { attachTo: target });
			b.add(HYMN, { attachTo: target });
		}
	},
	{
		name: 'aura/timestamps-forest-then-mutation',
		description: 'The Forest-land Aura (earlier) then Darksteel Mutation (later).',
		build: (b) => {
			const target = b.add(BEAR);
			b.add(HYMN, { attachTo: target });
			b.add(real('Darksteel Mutation'), { attachTo: target });
		}
	},
	{
		name: 'aura/mutation-then-kenrith',
		description: "Darksteel Mutation then Kenrith's Transformation on the same creature (two type + base P/T setters).",
		build: (b) => {
			const target = b.add(BRUTE);
			b.add(real('Darksteel Mutation'), { attachTo: target });
			b.add(real("Kenrith's Transformation"), { attachTo: target });
		}
	},

	// "Loses all abilities", attached and global.
	{
		name: 'abilities/aura-on-lord',
		description: 'An Aura that removes all abilities from an Elf lord: the lord bonus stops applying.',
		build: (b) => {
			const lord = b.add(MARSHAL);
			b.add(ELF);
			b.add(VEIL, { attachTo: lord });
		}
	},
	{
		name: 'abilities/humility',
		description: 'Humility with a flyer, a trampler, an Elf lord and its Elf, and a creature with +1/+1 counters.',
		build: (b) => {
			b.add(SKY);
			b.add(BRUTE);
			b.add(MARSHAL);
			b.add(ELF);
			b.add(BEAR, { edit: (i) => (i.counters['+1/+1'] = 2) });
			b.add(real('Humility'));
		}
	},
	{
		name: 'abilities/dress-down',
		description: 'Dress Down ("Creatures lose all abilities.") with a flyer and an Elf lord.',
		build: (b) => {
			b.add(SKY);
			b.add(MARSHAL);
			b.add(ELF);
			b.add(real('Dress Down'));
		}
	},
	{
		name: 'abilities/anthem-before-humility',
		description: 'An anthem enchantment, then Humility: 7b sets 1/1, 7c adds +1/+1 whatever the timestamps.',
		build: (b) => {
			b.add(BANNER);
			b.add(real('Humility'));
			b.add(BEAR);
		}
	},
	{
		name: 'abilities/anthem-after-humility',
		description: 'Humility, then an anthem enchantment.',
		build: (b) => {
			b.add(real('Humility'));
			b.add(BANNER);
			b.add(BEAR);
		}
	},

	// Opalescence and Humility (the classic timestamp interaction).
	{
		name: 'opalescence/basic',
		description: 'Opalescence animates other non-Aura enchantments (base P/T = mana value), not Auras or itself.',
		build: (b) => {
			b.add(real('Opalescence'));
			b.add(SHRINE);
			b.add(real('Rest in Peace'));
			b.add(VEIL, { attachTo: b.add(BEAR) });
		}
	},
	{
		name: 'opalescence/humility-first',
		description: 'Humility (earlier) then Opalescence (later). Oracle ruling: Humility and the other enchantment are 4/4 and 3/3 (their mana values); other creatures are 1/1; all creatures lose their abilities.',
		build: (b) => {
			b.add(real('Humility'));
			b.add(real('Opalescence'));
			b.add(SHRINE);
			b.add(BEAR);
		}
	},
	{
		name: 'opalescence/opalescence-first',
		description: 'Opalescence (earlier) then Humility (later). Oracle ruling: every creature, including the animated enchantments, is 1/1 with no abilities.',
		build: (b) => {
			b.add(real('Opalescence'));
			b.add(real('Humility'));
			b.add(SHRINE);
			b.add(BEAR);
		}
	},
	{
		name: 'opalescence/forest-land-on-animated-enchantment',
		description: 'The explicit Forest-land Aura on an Opalescence-animated enchantment: it is only a land.',
		build: (b) => {
			b.add(real('Opalescence'));
			const shrine = b.add(SHRINE);
			b.add(HYMN, { attachTo: shrine });
		}
	},
	{
		name: 'opalescence/song-of-the-dryads-on-animated-enchantment',
		description: 'Song of the Dryads (Oracle text) on an Opalescence-animated enchantment.',
		knownWrong: [
			{
				permanent: 'Lanternlit Shrine',
				note: 'Not marked as having lost its rules-text abilities. CR 305.7 removes them when Song sets the Forest land type.',
				todo: 'D-Audit-5'
			}
		],
		build: (b) => {
			b.add(real('Opalescence'));
			const shrine = b.add(SHRINE);
			b.add(real('Song of the Dryads'), { attachTo: shrine });
		}
	},

	// Land type changers.
	{
		name: 'lands/blood-moon',
		description: 'Blood Moon: nonbasic lands (including legendary ones) are Mountains and lose their abilities; basics are unaffected.',
		knownWrong: ['Command Tower', 'Duskmire Watchtower', 'Urborg, Tomb of Yawgmoth', 'Forest'].map((permanent) => ({
			permanent,
			note: "Also a Swamp, from Urborg's ability, although Blood Moon made Urborg a Mountain with no abilities. Urborg's effect depends on Blood Moon's (CR 613.8), so no land is a Swamp; Forest is just a Forest."
		})),
		build: (b) => {
			b.add(real('Command Tower'));
			b.add(WATCHTOWER);
			b.add(real('Urborg, Tomb of Yawgmoth'));
			b.add(real('Forest'));
			b.add(real('Blood Moon'));
		}
	},
	{
		name: 'lands/urborg-and-yavimaya',
		description: 'Urborg and Yavimaya: each land is a Swamp and a Forest in addition to its other types.',
		build: (b) => {
			b.add(real('Island'));
			b.add(real('Command Tower'));
			b.add(real('Urborg, Tomb of Yawgmoth'));
			b.add(real('Yavimaya, Cradle of Growth'));
			b.add(WATCHTOWER, { player: 1 });
		}
	},
	{
		name: 'lands/forest-land-aura-on-yavimaya',
		description: 'The explicit Forest-land Aura on Yavimaya removes its "each land is a Forest" ability.',
		build: (b) => {
			const yav = b.add(real('Yavimaya, Cradle of Growth'));
			b.add(real('Island'));
			b.add(HYMN, { attachTo: yav });
		}
	},
	{
		name: 'lands/chromatic-lantern',
		description: 'Chromatic Lantern grants "{T}: Add one mana of any color" to its controller\'s lands only.',
		build: (b) => {
			b.add(real('Chromatic Lantern'));
			b.add(real('Forest'));
			b.add(real('Command Tower'));
			b.add(real('Island'), { player: 1 });
		}
	},

	// Global type adders.
	{
		name: 'types/mycosynth-lattice',
		description: 'Mycosynth Lattice: all permanents are artifacts in addition to their other types.',
		build: (b) => {
			b.add(real('Mycosynth Lattice'));
			b.add(BEAR);
			b.add(real('Forest'));
			b.add(BANNER);
			b.add(real('Sol Ring'), { player: 1 });
		}
	},
	{
		name: 'types/maskwood-nexus',
		description: "Maskwood Nexus: its controller's creatures are every creature type, so an Elf lord pumps a Bear; the opponent's Bear is unaffected.",
		build: (b) => {
			b.add(real('Maskwood Nexus'));
			b.add(real('Elvish Archdruid'));
			b.add(BEAR);
			b.add(BEAR, { player: 1 });
		}
	},

	// Layer 7b setters in both timestamp orders, and 7a characteristic-defining abilities.
	{
		name: 'pt/base-setters-small-then-large',
		description: 'Base P/T 0/1 Aura (earlier) then base P/T 4/4 Aura (later): the later one wins.',
		build: (b) => {
			const t = b.add(BRUTE);
			b.add(GLOOM, { attachTo: t });
			b.add(TITAN, { attachTo: t });
		}
	},
	{
		name: 'pt/base-setters-large-then-small',
		description: 'Base P/T 4/4 Aura (earlier) then base P/T 0/1 Aura (later).',
		build: (b) => {
			const t = b.add(BRUTE);
			b.add(TITAN, { attachTo: t });
			b.add(GLOOM, { attachTo: t });
		}
	},
	{
		name: 'pt/cda-creature-count',
		description: '*/* equal to the number of creatures you control (counts itself; the opponent\'s creature does not count).',
		build: (b) => {
			b.add(COLOSSUS);
			b.add(BEAR);
			b.add(ELF);
			b.add(BEAR, { player: 1 });
		}
	},
	{
		name: 'pt/cda-graveyard-creatures',
		description: '*/* equal to the number of creature cards in all graveyards (noncreature cards don\'t count).',
		build: (b) => {
			b.add(GRAVESWORN);
			b.add(BEAR, { zone: 'graveyard' });
			b.add(ELF, { player: 1, zone: 'graveyard' });
			b.add(RITE, { player: 1, zone: 'graveyard' });
		}
	},
	{
		name: 'pt/cda-under-humility',
		description: 'A */* creature under Humility: 1/1 with no abilities.',
		build: (b) => {
			b.add(COLOSSUS);
			b.add(BEAR);
			b.add(real('Humility'));
		}
	},

	// Lords, anthems and keyword grants.
	{
		name: 'grants/lords-and-anthems',
		description: 'Subtype lords ("other" and self-inclusive), an anthem, and an opposing Elf that none of them affect.',
		build: (b) => {
			b.add(real('Elvish Archdruid'));
			b.add(MARSHAL);
			b.add(ELF);
			b.add(CHIEFTAIN);
			b.add(BANNER);
			b.add(BEAR);
			b.add(ELF, { player: 1 });
		}
	},
	{
		name: 'grants/akroma-and-shalai',
		description: "Akroma's Memorial keywords and Shalai's \"other creatures you control have hexproof\"; the opponent's creature gets nothing.",
		build: (b) => {
			b.add(real("Akroma's Memorial"));
			b.add(real('Shalai, Voice of Plenty'));
			b.add(BEAR);
			b.add(BEAR, { player: 1 });
		}
	},
	{
		name: 'grants/equipment-and-auras',
		description: 'Equipment and Aura keyword and P/T grants, including a -3/-0 Aura on a 2/2.',
		knownWrong: [
			{
				permanent: 'Hearthfield Bear #3',
				note: 'Power is reported as 0; it is -1. CR 107.1b: power can be less than 0 (it matters once another effect adds power).'
			}
		],
		build: (b) => {
			b.add(real('Lightning Greaves'), { attachTo: b.add(BEAR) });
			const elf = b.add(ELF);
			b.add(real('Swiftfoot Boots'), { attachTo: elf });
			const brute = b.add(BRUTE);
			b.add(real('Shadowspear'), { attachTo: brute });
			b.add(HARNESS, { attachTo: brute });
			b.add(BEAR);
			b.add(HEX, { attachTo: b.add(BEAR) });
		}
	},

	// Keyword removal by opponents' permanents.
	{
		name: 'removal/archetype-of-imagination',
		description: "Archetype of Imagination: its controller's creatures fly; opponents' creatures lose flying, innate or granted by Equipment.",
		build: (b) => {
			b.add(real('Archetype of Imagination'));
			b.add(BEAR);
			b.add(SKY, { player: 1 });
			b.add(HARNESS, { player: 1, attachTo: b.add(BEAR, { player: 1 }) });
		}
	},
	{
		name: 'removal/synthetic-flying-removal',
		description: 'A synthetic "Creatures your opponents control lose flying." enchantment.',
		build: (b) => {
			b.add(SIGIL);
			b.add(SKY);
			b.add(SKY, { player: 1 });
		}
	},

	// Instance-level modifiers.
	{
		name: 'instance/counters-pumps-switch',
		description: '+1/+1 and -1/-1 counters, a temporary pump, and a P/T switch (7d) applied after an anthem (7c).',
		build: (b) => {
			b.add(BANNER);
			b.add(BEAR, { edit: (i) => (i.counters['+1/+1'] = 2) });
			b.add(BEAR, { edit: (i) => (i.counters['-1/-1'] = 1) });
			b.add(BEAR, { edit: (i) => ((i.tempPowerMod = 3), (i.tempToughnessMod = 0)) });
			b.add(BRUTE, {
				edit: (i) => {
					i.tempPowerMod = -4;
					i.switchedPTCount = 1;
				}
			});
		}
	},
	{
		name: 'instance/face-down-and-suspend',
		description: 'A face-down creature (2/2, no name, no abilities) and a creature cast via suspend (gains haste).',
		build: (b) => {
			b.add(SKY, { edit: (i) => (i.isFaceDown = true) });
			b.add(BEAR, { edit: (i) => (i.castViaSuspend = true) });
		}
	},
	{
		name: 'instance/granted-keyword-attribution',
		description: 'Temporary granted keywords are attributed to a permanent whose text "gains" that keyword, else to "Temporary Effect".',
		build: (b) => {
			b.add(WARHORN);
			b.add(BEAR, { edit: (i) => (i.grantedKeywords = ['haste']) });
			b.add(ELF, { edit: (i) => (i.grantedKeywords = ['lifelink']) });
		}
	},
	{
		name: 'instance/phased-out',
		description: 'Phased-out sources apply nothing (an anthem, Humility); a phased-out creature reports its printed values.',
		build: (b) => {
			b.add(BANNER, { edit: (i) => (i.phasedOut = true) });
			b.add(real('Humility'), { edit: (i) => (i.phasedOut = true) });
			b.add(SKY);
			b.add(BRUTE, { edit: (i) => (i.phasedOut = true) });
		}
	},
	{
		name: 'instance/copy-effect',
		description: 'Layer 1: a Clone copying the Elf lord; each lord pumps the other and the Elf gets both bonuses.',
		build: (b) => {
			b.add(MARSHAL);
			b.add(real('Clone'), { edit: (i) => (i.copiableCard = MARSHAL) });
			b.add(ELF);
		}
	}
];

// ---- Tests ----------------------------------------------------------------------------------

interface ScenarioSnapshot {
	description: string;
	knownWrong?: KnownWrong[];
	permanents: Record<string, PermanentSnapshot>;
}

function runScenario(s: Scenario): ScenarioSnapshot {
	const board = new Board(s.players ?? 2);
	s.build(board);
	const permanents = board.snapshot();
	for (const kw of s.knownWrong ?? []) {
		assert.ok(permanents[kw.permanent], `${s.name}: knownWrong names a missing permanent "${kw.permanent}"`);
	}
	return {
		description: s.description,
		...(s.knownWrong ? { knownWrong: s.knownWrong } : {}),
		permanents: JSON.parse(JSON.stringify(permanents))
	};
}

describe('Layer snapshots (Phase 6 baseline)', () => {
	const actual: Record<string, ScenarioSnapshot> = {};
	for (const s of SCENARIOS) actual[s.name] = runScenario(s);

	if (UPDATE) writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(actual, null, '\t')}\n`);
	const expected: Record<string, ScenarioSnapshot> = existsSync(SNAPSHOT_PATH)
		? JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))
		: {};

	for (const s of SCENARIOS) {
		it(s.name, () => {
			assert.ok(expected[s.name], `No snapshot for ${s.name}; regenerate with UPDATE_LAYER_SNAPSHOTS=1`);
			assert.deepEqual(actual[s.name], expected[s.name]);
		});
	}

	it('has no stale snapshots', () => {
		assert.deepEqual(Object.keys(expected).sort(), SCENARIOS.map((s) => s.name).sort());
	});

	it('is deterministic (a second run produces the same snapshots)', () => {
		for (const s of SCENARIOS) assert.deepEqual(runScenario(s), actual[s.name], s.name);
	});
});

describe('Layer evaluation timing (Phase 6 baseline)', () => {
	it('evaluatePermanent once per permanent on a busy 4-player board (60 permanents)', (t) => {
		const board = new Board(4);
		const perPlayer: ScryfallCard[] = [
			real('Forest'),
			real('Command Tower'),
			real('Urborg, Tomb of Yawgmoth'),
			real('Sol Ring'),
			real('Elvish Archdruid'),
			MARSHAL,
			ELF,
			BEAR,
			BRUTE,
			SKY,
			CHIEFTAIN,
			BANNER,
			SHRINE,
			real('Lightning Greaves'),
			HARNESS
		];
		const all: CardInstance[] = [];
		for (let p = 0; p < 4; p++) {
			const placed = perPlayer.map((c) => (c.typeLine.includes('Equipment') ? null : board.add(c, { player: p })));
			perPlayer.forEach((c, i) => {
				if (c.typeLine.includes('Equipment')) placed[i] = board.add(c, { player: p, attachTo: placed[6]! });
			});
			all.push(...(placed as CardInstance[]));
		}
		assert.equal(all.length, 60);

		const runs: number[] = [];
		for (let r = 0; r < 7; r++) {
			const start = performance.now();
			for (const inst of all) evaluatePermanent(board.state, inst);
			runs.push(performance.now() - start);
		}
		runs.sort((a, b) => a - b);
		const median = runs[Math.floor(runs.length / 2)];
		t.diagnostic(
			`60 permanents: median ${median.toFixed(1)} ms per full pass (${((median / 60) * 1000).toFixed(0)} µs per evaluatePermanent), min ${runs[0].toFixed(1)} ms, max ${runs[runs.length - 1].toFixed(1)} ms`
		);
	});
});
