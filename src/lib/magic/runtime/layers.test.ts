import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createCardInstance, createInitialGameState } from '../engine.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import {
	evaluatePermanent,
	inspectCardContinuousBreakdown,
	permanentHasLostAllAbilities
} from '../ruleTree.ts';
import {
	DEFAULT_LOBBY_RULES,
	type CardInstance,
	type GameState,
	type LobbySeat,
	type MagicDeck,
	type ScryfallCard
} from '../types.ts';

function staple(name: string): ScryfallCard {
	const card = STAPLE_CARDS[name.toLowerCase()];
	if (!card) throw new Error(`Not a precon card: ${name}`);
	return card;
}

function synthetic(spec: Partial<ScryfallCard> & { name: string; typeLine: string }): ScryfallCard {
	return {
		id: `layers_test_${spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
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

class TestBoard {
	readonly state: GameState;
	readonly players: string[];
	private ts = 0;

	constructor(playerCount = 2) {
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
		this.state = createInitialGameState('LAYERS_TEST', seats, decks, { ...DEFAULT_LOBBY_RULES });
		this.players = this.state.players.map((p) => p.playerId);
	}

	add(
		card: ScryfallCard,
		opts: { player?: number; attachTo?: CardInstance; zone?: 'battlefield' | 'graveyard' } = {}
	): CardInstance {
		const owner = this.players[opts.player ?? 0];
		const zone = opts.zone ?? 'battlefield';
		this.ts += 1;
		const inst = createCardInstance(card, owner, zone, false, false, this.ts);
		inst.controllerId = owner;
		inst.summoningSick = false;
		if (opts.attachTo) inst.attachedToId = opts.attachTo.instanceId;
		this.state.players[opts.player ?? 0][zone].push(inst);
		return inst;
	}
}

const FLYER = synthetic({
	name: 'Windcrest Falcon',
	typeLine: 'Creature — Bird',
	power: '2',
	toughness: '2',
	oracleText: 'Flying',
	keywords: ['Flying']
});

const BEAR = synthetic({
	name: 'Ashwood Bear',
	typeLine: 'Creature — Bear',
	power: '2',
	toughness: '2'
});

const TRINKET = synthetic({
	name: 'Brass Cogwork',
	typeLine: 'Artifact',
	oracleText: ''
});

describe('Phase 6 layer engine (from IR): rules & bug regressions', () => {
	it('Song of the Dryads (and synthetic basic-land type-setting Auras) removes rules-text abilities (CR 205.1a / CR 305.7, D-Audit-5)', () => {
		const b = new TestBoard();
		const flyer = b.add(FLYER);
		b.add(staple('Song of the Dryads'), { attachTo: flyer });

		const ev = evaluatePermanent(b.state, flyer);
		const lost = permanentHasLostAllAbilities(flyer, b.state);
		assert.equal(ev.effectiveTypeLine, 'Land — Forest');
		assert.equal(ev.isCreature, false);
		assert.equal(ev.isLand, true);
		assert.equal(lost.lost, true);
		assert.deepEqual(lost.sources, ['Song of the Dryads']);
		assert.deepEqual(ev.activeKeywords, []);

		// Synthetic Aura with an invented name setting Plains land type
		const b2 = new TestBoard();
		const target = b2.add(FLYER);
		const plainsAura = synthetic({
			name: 'alabaster tether',
			typeLine: 'Enchantment — Aura',
			oracleText: 'Enchant permanent\nEnchanted permanent is a colorless Plains land.'
		});
		b2.add(plainsAura, { attachTo: target });
		const ev2 = evaluatePermanent(b2.state, target);
		assert.equal(ev2.effectiveTypeLine, 'Land — Plains');
		assert.equal(ev2.hasLostAllAbilities, true);
		assert.deepEqual(ev2.activeKeywords, []);

		// Song of the Dryads on an Opalescence-animated enchantment
		const b3 = new TestBoard();
		b3.add(staple('Opalescence'));
		const shrine = b3.add(
			synthetic({
				name: 'Duskbell Shrine',
				typeLine: 'Enchantment',
				cmc: 3,
				oracleText: 'Whenever you cast a spell, you gain 1 life.'
			})
		);
		b3.add(staple('Song of the Dryads'), { attachTo: shrine });
		const ev3 = evaluatePermanent(b3.state, shrine);
		assert.equal(ev3.effectiveTypeLine, 'Land — Forest');
		assert.equal(ev3.isCreature, false);
		assert.equal(ev3.hasLostAllAbilities, true);
		assert.deepEqual(ev3.lostAllAbilitiesBy, ['Song of the Dryads']);
	});

	it('Blood Moon + Urborg dependency (CR 613.8): Urborg loses its abilities before it can grant Swamp', () => {
		for (const bloodMoonFirst of [false, true]) {
			const b = new TestBoard();
			const tower = b.add(staple('Command Tower'));
			const forest = b.add(staple('Forest'));
			let urborg: CardInstance;
			if (bloodMoonFirst) {
				b.add(staple('Blood Moon'));
				urborg = b.add(staple('Urborg, Tomb of Yawgmoth'));
			} else {
				urborg = b.add(staple('Urborg, Tomb of Yawgmoth'));
				b.add(staple('Blood Moon'));
			}

			const evTower = evaluatePermanent(b.state, tower);
			const evUrborg = evaluatePermanent(b.state, urborg);
			const evForest = evaluatePermanent(b.state, forest);

			assert.equal(evTower.effectiveTypeLine, 'Land — Mountain');
			assert.equal(evTower.hasSubType('Swamp'), false);
			assert.equal(evUrborg.effectiveTypeLine, 'Legendary Land — Mountain');
			assert.equal(evUrborg.hasSubType('Swamp'), false);
			assert.equal(evUrborg.hasLostAllAbilities, true);
			assert.equal(evForest.effectiveTypeLine, 'Basic Land — Forest');
			assert.equal(evForest.hasSubType('Swamp'), false);
		}
	});

	it('negative power is not clamped to 0, and subsequent buffs add from the negative value (CR 107.1b)', () => {
		const b = new TestBoard();
		const bear = b.add(BEAR);
		const hex = synthetic({
			name: 'Leaden Weight',
			typeLine: 'Enchantment — Aura',
			oracleText: 'Enchant creature\nEnchanted creature gets -3/-0.'
		});
		b.add(hex, { attachTo: bear });

		const ev1 = evaluatePermanent(b.state, bear);
		const bd1 = inspectCardContinuousBreakdown(bear, b.state);
		assert.equal(bd1.effectivePower, -1);
		assert.equal(ev1.power, -1);
		assert.equal(ev1.toughness, 2);

		// Adding a +2/+0 anthem brings power from -1 to +1 (not from 0 to +2)
		b.add(
			synthetic({
				name: 'War Drums',
				typeLine: 'Enchantment',
				oracleText: 'Creatures you control get +2/+0.'
			})
		);
		const ev2 = evaluatePermanent(b.state, bear);
		assert.equal(ev2.power, 1);
	});

	it('Storm-Kiln Artist and self "for each" P/T modifiers scale with matching permanents', () => {
		const b = new TestBoard();
		const artist = b.add(staple('Storm-Kiln Artist'));
		assert.equal(evaluatePermanent(b.state, artist).power, 2);
		assert.equal(evaluatePermanent(b.state, artist).toughness, 2);

		b.add(TRINKET);
		b.add(TRINKET);
		b.add(TRINKET, { player: 1 }); // opponent's artifact doesn't count
		const ev = evaluatePermanent(b.state, artist);
		assert.equal(ev.power, 4);
		assert.equal(ev.toughness, 2);
	});

	it('attached and anthem "for each" P/T modifiers scale with the count instead of applying a flat buff', () => {
		const b = new TestBoard();
		const bear = b.add(BEAR);

		// Lashwrithe-style Equipment with 0 Swamps controlled -> +0/+0
		const lash = synthetic({
			name: 'Mire Whip',
			typeLine: 'Artifact — Equipment',
			oracleText: 'Equipped creature gets +1/+1 for each Swamp you control.\nEquip {2}'
		});
		b.add(lash, { attachTo: bear });
		assert.equal(evaluatePermanent(b.state, bear).power, 2);
		assert.equal(evaluatePermanent(b.state, bear).toughness, 2);

		// Add 2 Swamps -> +2/+2 -> 4/4
		const swamp = synthetic({ name: 'Swamp', typeLine: 'Basic Land — Swamp' });
		b.add(swamp);
		b.add(swamp);
		assert.equal(evaluatePermanent(b.state, bear).power, 4);
		assert.equal(evaluatePermanent(b.state, bear).toughness, 4);

		// All That Glitters-style Aura ("for each artifact and/or enchantment you control")
		const glitters = synthetic({
			name: 'Starlight Mantle',
			typeLine: 'Enchantment — Aura',
			oracleText: 'Enchant creature\nEnchanted creature gets +1/+1 for each artifact and/or enchantment you control.'
		});
		b.add(glitters, { attachTo: bear });
		// Controls Mire Whip (Artifact) + Starlight Mantle (Enchantment) = 2 -> +2/+2 more -> 6/6
		assert.equal(evaluatePermanent(b.state, bear).power, 6);
		assert.equal(evaluatePermanent(b.state, bear).toughness, 6);

		// Hold the Gates-style anthem ("Creatures you control get +0/+1 for each Gate you control and have vigilance.")
		const gatesAnthem = synthetic({
			name: 'Citadel Watch',
			typeLine: 'Enchantment',
			oracleText: 'Creatures you control get +0/+1 for each Gate you control and have vigilance.'
		});
		b.add(gatesAnthem);
		// Citadel Watch is also an enchantment so Starlight Mantle goes from +2/+2 to +3/+3 (7/7),
		// while 0 Gates means Citadel Watch adds +0/+0 and grants Vigilance.
		const ev0Gates = evaluatePermanent(b.state, bear);
		assert.equal(ev0Gates.power, 7);
		assert.equal(ev0Gates.toughness, 7);
		assert.ok(ev0Gates.activeKeywords.includes('Vigilance'));

		b.add(synthetic({ name: 'Guildgate', typeLine: 'Land — Gate' }));
		assert.equal(evaluatePermanent(b.state, bear).toughness, 8);
	});

	it('reminder text on Auras and Equipment does not leak fake keywords (Spider Climb, Shimmering Wings)', () => {
		const b = new TestBoard();
		const bear1 = b.add(BEAR);
		const spiderClimb = synthetic({
			name: 'Spider Climb',
			typeLine: 'Enchantment — Aura',
			oracleText: 'Enchant creature\nEnchanted creature gets +0/+3 and has reach. (It can block creatures with flying.)'
		});
		b.add(spiderClimb, { attachTo: bear1 });
		const ev1 = evaluatePermanent(b.state, bear1);
		assert.deepEqual(ev1.activeKeywords, ['Reach']);
		assert.equal(ev1.power, 2);
		assert.equal(ev1.toughness, 5);

		const bear2 = b.add(BEAR);
		const shimmeringWings = synthetic({
			name: 'Shimmering Wings',
			typeLine: 'Enchantment — Aura',
			oracleText: "Enchant creature\nEnchanted creature has flying. (It can't be blocked except by creatures with flying or reach.)"
		});
		b.add(shimmeringWings, { attachTo: bear2 });
		const ev2 = evaluatePermanent(b.state, bear2);
		assert.deepEqual(ev2.activeKeywords, ['Flying']);
	});

	it('negative or quoted keywords on Auras and Equipment are not granted as static keywords (Sky Tether, Deviant Glee, Giant\'s Amulet)', () => {
		const b = new TestBoard();
		const bear1 = b.add(BEAR);
		b.add(
			synthetic({
				name: 'Sky Tether',
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature\nEnchanted creature has defender and loses flying.'
			}),
			{ attachTo: bear1 }
		);
		assert.ok(!evaluatePermanent(b.state, bear1).activeKeywords.includes('Flying'));

		const bear2 = b.add(BEAR);
		b.add(
			synthetic({
				name: 'Deviant Glee',
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature\nEnchanted creature gets +2/+1 and has "{B}: This creature gains trample until end of turn."'
			}),
			{ attachTo: bear2 }
		);
		assert.ok(!evaluatePermanent(b.state, bear2).activeKeywords.includes('Trample'));

		const bear3 = b.add(BEAR);
		b.add(
			synthetic({
				name: "Giant's Amulet",
				typeLine: 'Artifact — Equipment',
				oracleText: 'Equipped creature gets +0/+1 and has "As long as this creature is untapped, it has hexproof."\nEquip {1}'
			}),
			{ attachTo: bear3 }
		);
		assert.ok(!evaluatePermanent(b.state, bear3).activeKeywords.includes('Hexproof'));
	});

	it('"As long as ..." conditions on anthems and Auras are checked before applying', () => {
		const b = new TestBoard();
		const bear = b.add(BEAR);
		const trainer = b.add(
			synthetic({
				name: 'Weapons Trainer',
				typeLine: 'Creature — Human Soldier Ally',
				power: '3',
				toughness: '2',
				oracleText: 'Other creatures you control get +1/+0 as long as you control an Equipment.'
			})
		);
		// No Equipment yet -> bear stays 2/2
		assert.equal(evaluatePermanent(b.state, bear).power, 2);

		// Add an Equipment -> bear becomes 3/2, trainer stays 3/2 ("Other")
		b.add(
			synthetic({
				name: 'Short Sword',
				typeLine: 'Artifact — Equipment',
				oracleText: 'Equipped creature gets +1/+1.\nEquip {1}'
			})
		);
		assert.equal(evaluatePermanent(b.state, bear).power, 3);
		assert.equal(evaluatePermanent(b.state, trainer).power, 3);

		// Abzan Runemark: +2/+2 unconditionally, vigilance only when controlling a red or white permanent
		const b2 = new TestBoard();
		const target = b2.add(BEAR);
		b2.add(
			synthetic({
				name: 'Abzan Runemark',
				typeLine: 'Enchantment — Aura',
				colors: ['G'],
				oracleText:
					'Enchant creature\nEnchanted creature gets +2/+2.\nEnchanted creature has vigilance as long as you control a red or white permanent.'
			}),
			{ attachTo: target }
		);
		const evBefore = evaluatePermanent(b2.state, target);
		assert.equal(evBefore.power, 4);
		assert.equal(evBefore.toughness, 4);
		assert.deepEqual(evBefore.activeKeywords, []);

		b2.add(synthetic({ name: 'Sunlit Banner', typeLine: 'Enchantment', colors: ['W'] }));
		const evAfter = evaluatePermanent(b2.state, target);
		assert.deepEqual(evAfter.activeKeywords, ['Vigilance']);

		// Unmodelled condition (dungeon completion) does not apply unconditionally
		const b3 = new TestBoard();
		const ally = b3.add(BEAR);
		b3.add(
			synthetic({
				name: 'Nadaar, Selfless Paladin',
				typeLine: 'Legendary Creature — Dragon Knight',
				power: '3',
				toughness: '3',
				oracleText: "Other creatures you control get +1/+1 as long as you've completed a dungeon."
			})
		);
		assert.equal(evaluatePermanent(b3.state, ally).power, 2);
	});

	it('"Enchanted permanent gets +X/+Y and has <kw>" applies both the P/T buff and the keyword', () => {
		const b = new TestBoard();
		const bear = b.add(BEAR);
		b.add(
			synthetic({
				name: 'Silken Strength',
				typeLine: 'Enchantment — Aura',
				oracleText: 'Enchant creature or Vehicle\nEnchanted permanent gets +1/+2 and has reach.'
			}),
			{ attachTo: bear }
		);
		const ev = evaluatePermanent(b.state, bear);
		assert.equal(ev.power, 3);
		assert.equal(ev.toughness, 4);
		assert.deepEqual(ev.activeKeywords, ['Reach']);
	});

	it('expanded keywords (ward, fear, intimidate, wither, prowess) and scoped hexproof on attached grants', () => {
		const b = new TestBoard();
		const bear1 = b.add(BEAR);
		b.add(
			synthetic({
				name: 'Winged Boots',
				typeLine: 'Artifact — Equipment',
				oracleText: 'Equipped creature has flying and ward {4}.\nEquip {1}'
			}),
			{ attachTo: bear1 }
		);
		b.add(
			synthetic({
				name: 'Blight Sickle',
				typeLine: 'Artifact — Equipment',
				oracleText: 'Equipped creature gets +1/+0 and has wither.\nEquip {2}'
			}),
			{ attachTo: bear1 }
		);
		const ev1 = evaluatePermanent(b.state, bear1);
		assert.equal(ev1.power, 3);
		assert.deepEqual(ev1.activeKeywords, ['Flying', 'Ward {4}', 'Wither']);

		const bear2 = b.add(BEAR);
		b.add(
			synthetic({
				name: 'Dragonfire Blade',
				typeLine: 'Artifact — Equipment',
				oracleText: 'Equipped creature gets +2/+2 and has hexproof from monocolored.\nEquip {4}'
			}),
			{ attachTo: bear2 }
		);
		const ev2 = evaluatePermanent(b.state, bear2);
		assert.equal(ev2.power, 4);
		assert.equal(ev2.toughness, 4);
		assert.deepEqual(ev2.activeKeywords, ['Hexproof from monocolored']);
		assert.ok(!ev2.activeKeywords.includes('Hexproof'));
	});
});
