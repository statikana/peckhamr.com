/**
 * Track P4 runtime helpers:
 * 1. Library top / bottom / top-or-bottom / Nth-from-top placement (CR 401.2, 401.4, 401.7)
 * 2. Next-untap freeze & Exert keyword action (CR 502.3, 611.2b, 701.43a–d)
 * 3. ETB chosen creature type & chosen color (CR 614.1c, 614.12, 105.4, 205.3m)
 * 4. Multi-color combination & filter mana bundle helpers (CR 106.1a–b, 605.1a)
 *
 * Purely operates on compiled IR, CardInstance state, and characteristics — zero card names
 * and zero runtime rules-text reads.
 */
import { canPayManaCost, parseManaCost, type ManaCostRequirement } from '../oracle.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import type { CardInstance, GameState, ManaColor, ManaPool, PlayerGameState } from '../types.ts';
import { emitEvent } from './events.ts';
import { instanceFaceOptions, resolveObjectFaces, type ResolvedObjectView } from './faces.ts';
import { noteLayerInputsChanged } from './layerCache.ts';

function viewCardInstance(card: CardInstance): ResolvedObjectView {
	return resolveObjectFaces(effectiveCardForObject(card), instanceFaceOptions(card));
}

// ---- 1. Library Placement (CR 401.2, 401.4, 401.7) ------------------------------------------

/**
 * CR 401.7: If an effect causes a player to put a card into a library "Nth from the top", and
 * that library has fewer than N cards in it, the player puts that card on the bottom of that
 * library. `fromTop` is 1-based (`1` = top = index `0`, `2` = second from top = index `1`, etc.).
 */
export function computeLibraryInsertIndex(
	fromTop: number | undefined,
	position: 'top' | 'bottom',
	libraryLength: number
): number {
	const safeLen = Math.max(0, libraryLength);
	if (fromTop !== undefined && Number.isFinite(fromTop)) {
		const idx = Math.trunc(fromTop) - 1;
		return Math.max(0, Math.min(idx, safeLen));
	}
	return position === 'top' ? 0 : safeLen;
}

/**
 * Deterministic bot choice for `['Put on top of library', 'Put on bottom of library']` (or
 * `['Put second from top of library', 'Put on bottom of library']`).
 * Returns `0` for top/second-from-top, `1` for bottom.
 */
export function chooseBotLibraryPlacement(
	chooser: PlayerGameState,
	owner: PlayerGameState,
	card: CardInstance
): 0 | 1 {
	if (chooser.playerId !== owner.playerId) {
		// Opponent's card: bury threats/cards on the bottom of their library.
		return 1;
	}
	const ch = viewCardInstance(card);
	if (ch.types.includes('Land')) {
		const landsAvailable =
			chooser.battlefield.filter((p) => viewCardInstance(p).types.includes('Land')).length +
			chooser.hand.filter((c) => viewCardInstance(c).types.includes('Land')).length;
		return landsAvailable >= 5 ? 1 : 0;
	}
	return 0;
}

function scoreCardForLibraryDraw(owner: PlayerGameState, card: CardInstance): number {
	const ch = viewCardInstance(card);
	const landCount = owner.battlefield.filter((p) =>
		viewCardInstance(p).types.includes('Land')
	).length;
	if (ch.types.includes('Land')) {
		return landCount < 3 ? 80 : 10;
	}
	const mv = ch.manaValue ?? 0;
	if (mv <= Math.max(2, landCount + 1)) {
		return 60 + Math.min(mv, 6) * 5;
	}
	return Math.max(15, 55 - (mv - landCount) * 6);
}

/**
 * CR 401.4: Deterministic ordering for bots moving multiple cards to the top or bottom of a
 * single library simultaneously. For `'top'`, index 0 will end up as the topmost card of the library.
 */
export function orderBotSimultaneousLibraryCards(
	owner: PlayerGameState,
	cards: readonly CardInstance[],
	position: 'top' | 'bottom'
): CardInstance[] {
	return [...cards].sort((a, b) => {
		const sa = scoreCardForLibraryDraw(owner, a);
		const sb = scoreCardForLibraryDraw(owner, b);
		if (sa !== sb) return position === 'top' ? sb - sa : sa - sb;
		return a.instanceId.localeCompare(b.instanceId);
	});
}

// ---- 2. Next-Untap Freeze & Exert (CR 502.3, 611.2b, 701.43a–d) -----------------------------

/**
 * CR 502.3 / 611.2b / 701.43b: Consumes a pending "doesn't untap during its controller's next
 * untap step" flag on `perm` during its controller's untap step. Returns `true` if the permanent
 * was frozen (and therefore must NOT untap during this untap step). Even if `perm` was already
 * untapped when the untap step began, the flag is consumed and cleared.
 */
export function consumeNextUntapFreeze(perm: CardInstance): boolean {
	if (perm.doesntUntapNextUntapStep) {
		perm.doesntUntapNextUntapStep = undefined;
		return true;
	}
	return false;
}

/**
 * Marks a battlefield permanent so it won't untap during its controller's next untap step.
 */
export function applyNextUntapFreeze(perm: CardInstance): boolean {
	if (perm.zone !== 'battlefield' || perm.phasedOut) return false;
	perm.doesntUntapNextUntapStep = true;
	return true;
}

/**
 * CR 701.43a–c: Exerts a permanent on the battlefield.
 * - An object that isn't on the battlefield can't be exerted (CR 701.43c).
 * - A permanent can be exerted even if it isn't tapped or has already been exerted in the current
 *   turn (CR 701.43b).
 */
export function exertPermanent(state: GameState, perm: CardInstance, actorId: string): boolean {
	if (perm.zone !== 'battlefield' || perm.phasedOut) return false;
	perm.doesntUntapNextUntapStep = true;
	perm.exertedThisTurn = true;
	noteLayerInputsChanged(state);
	emitEvent(state, {
		kind: 'Exerted',
		playerId: actorId,
		objectId: perm.instanceId,
		object: perm
	});
	return true;
}

// ---- 3. ETB Chosen Creature Type & Chosen Color (CR 614.1c, 614.12, 105.4, 205.3m) ----------

export const FIVE_MANA_COLORS: readonly ('W' | 'U' | 'B' | 'R' | 'G')[] = ['W', 'U', 'B', 'R', 'G'];

export const COLOR_LABEL_BY_CODE: Record<'W' | 'U' | 'B' | 'R' | 'G', string> = {
	W: 'White',
	U: 'Blue',
	B: 'Black',
	R: 'Red',
	G: 'Green'
};

export const COLOR_CODE_BY_LABEL: Record<string, ManaColor> = {
	white: 'W',
	w: 'W',
	blue: 'U',
	u: 'U',
	black: 'B',
	b: 'B',
	red: 'R',
	r: 'R',
	green: 'G',
	g: 'G'
};

export const PROTECTION_KEYWORD_BY_COLOR: Record<ManaColor, string> = {
	W: 'protection from white',
	U: 'protection from blue',
	B: 'protection from black',
	R: 'protection from red',
	G: 'protection from green',
	C: 'protection from colorless'
};

export function buildColorChoiceOptions(exclude?: ManaColor): {
	labels: string[];
	colors: ('W' | 'U' | 'B' | 'R' | 'G')[];
} {
	const colors = FIVE_MANA_COLORS.filter((c) => c !== exclude);
	return {
		colors,
		labels: colors.map((c) => COLOR_LABEL_BY_CODE[c])
	};
}

function addColorPipsWeight(
	scores: Record<'W' | 'U' | 'B' | 'R' | 'G', number>,
	card: CardInstance,
	weight: number
): void {
	const ch = viewCardInstance(card);
	for (const c of ch.colors) {
		if (c !== 'C') scores[c] += weight;
	}
	if (ch.manaCost) {
		const req = parseManaCost(ch.manaCost);
		for (const c of FIVE_MANA_COLORS) {
			if (req.colored[c] > 0) scores[c] += req.colored[c] * weight;
		}
		for (const flex of req.flexibleSymbols ?? []) {
			if (flex.altColor) {
				if (flex.primaryColor !== 'C') scores[flex.primaryColor] -= weight * 0.5;
				if (flex.altColor !== 'C') scores[flex.altColor] += weight * 0.5;
			}
		}
	}
}

export function chooseBotBestColor(
	_state: GameState,
	player: PlayerGameState,
	exclude?: ManaColor,
	enteringObj?: CardInstance
): ManaColor {
	const { colors } = buildColorChoiceOptions(exclude);
	if (colors.length === 0) return 'W';
	const scores: Record<'W' | 'U' | 'B' | 'R' | 'G', number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
	for (const c of player.hand) {
		if (c.instanceId !== enteringObj?.instanceId) addColorPipsWeight(scores, c, 3);
	}
	for (const p of player.battlefield) {
		if (p.instanceId !== enteringObj?.instanceId) addColorPipsWeight(scores, p, 3);
	}
	for (const c of player.command) {
		addColorPipsWeight(scores, c, 4);
	}
	for (const c of player.library) {
		addColorPipsWeight(scores, c, 1);
	}
	let best = colors[0];
	let bestScore = scores[best];
	for (let i = 1; i < colors.length; i++) {
		const col = colors[i];
		if (scores[col] > bestScore) {
			best = col;
			bestScore = scores[col];
		}
	}
	return best;
}

const NON_CREATURE_SUBTYPES_LOWER = new Set(
	[
		'Plains',
		'Island',
		'Swamp',
		'Mountain',
		'Forest',
		'Gate',
		'Locus',
		'Cave',
		'Desert',
		'Lair',
		'Sphere',
		'Tower',
		'Mine',
		'Power-Plant',
		'Town',
		"Urza's",
		'Equipment',
		'Treasure',
		'Clue',
		'Food',
		'Blood',
		'Map',
		'Powerstone',
		'Gold',
		'Shard',
		'Lander',
		'Mutagen',
		'Heartwood',
		'Junk',
		'Vibranium',
		'Vehicle',
		'Spacecraft',
		'Bobblehead',
		'Fortification',
		'Contraption',
		'Attraction',
		'Aura',
		'Saga',
		'Class',
		'Case',
		'Room',
		'Background',
		'Shrine',
		'Role',
		'Cartouche',
		'Curse',
		'Rune',
		'Siege',
		'Arcane',
		'Adventure',
		'Lesson',
		'Trap',
		'Chorus',
		'Omen'
	].map((s) => s.toLowerCase())
);

/**
 * CR 205.3m: Canonical creature types list. Used to build deterministic `chooseMode` option lists
 * when a permanent enters with "As ~ enters, choose a creature type."
 */
export const CORE_CREATURE_SUBTYPES: readonly string[] = [
	'Advisor',
	'Aetherborn',
	'Alien',
	'Ally',
	'Angel',
	'Antelope',
	'Ape',
	'Archer',
	'Archon',
	'Armadillo',
	'Army',
	'Artificer',
	'Assassin',
	'Assembly-Worker',
	'Astartes',
	'Atog',
	'Aurochs',
	'Avatar',
	'Azra',
	'Badger',
	'Balloon',
	'Barbarian',
	'Bard',
	'Basilisk',
	'Bat',
	'Bear',
	'Beast',
	'Beaver',
	'Beeble',
	'Beholder',
	'Berserker',
	'Bird',
	'Blinkmoth',
	'Boar',
	'Bringer',
	'Brushwagg',
	'Camarid',
	'Camel',
	'Capybara',
	'Caribou',
	'Carrier',
	'Cat',
	'Centaur',
	'Child',
	'Chimera',
	'Citizen',
	'Cleric',
	'Clown',
	'Cockatrice',
	'Construct',
	'Coward',
	'Coyote',
	'Crab',
	'Crocodile',
	'Ctan',
	'Custodes',
	'Cyberman',
	'Cyclops',
	'Dalek',
	'Dauthi',
	'Demigod',
	'Demon',
	'Deserter',
	'Detective',
	'Devil',
	'Dinosaur',
	'Djinn',
	'Doctor',
	'Dog',
	'Dragon',
	'Drake',
	'Dreadnought',
	'Drone',
	'Druid',
	'Dryad',
	'Dwarf',
	'Efreet',
	'Egg',
	'Elder',
	'Eldrazi',
	'Elemental',
	'Elephant',
	'Elf',
	'Elk',
	'Employee',
	'Eye',
	'Faerie',
	'Ferret',
	'Fish',
	'Flagbearer',
	'Fox',
	'Fractal',
	'Frog',
	'Fungus',
	'Gamer',
	'Gargoyle',
	'Germ',
	'Giant',
	'Gith',
	'Gnoll',
	'Gnome',
	'Goat',
	'Goblin',
	'God',
	'Golem',
	'Gorgon',
	'Graveborn',
	'Gremlin',
	'Griffin',
	'Guest',
	'Hag',
	'Halfling',
	'Hamster',
	'Harpy',
	'Hellion',
	'Hippo',
	'Hippogriff',
	'Homarid',
	'Homunculus',
	'Horror',
	'Horse',
	'Human',
	'Hydra',
	'Hyena',
	'Illusion',
	'Imp',
	'Incarnation',
	'Inkling',
	'Inquisitor',
	'Insect',
	'Jackal',
	'Jellyfish',
	'Juggernaut',
	'Kavu',
	'Kirin',
	'Kithkin',
	'Knight',
	'Kobold',
	'Kor',
	'Kraken',
	'Lamia',
	'Lammasu',
	'Leech',
	'Leviathan',
	'Lhurgoyf',
	'Licid',
	'Lizard',
	'Llama',
	'Manticore',
	'Masticore',
	'Mercenary',
	'Merfolk',
	'Metathran',
	'Minion',
	'Minotaur',
	'Mite',
	'Mole',
	'Monger',
	'Mongoose',
	'Monk',
	'Monkey',
	'Moonfolk',
	'Mount',
	'Mouse',
	'Mutant',
	'Myr',
	'Mystic',
	'Naga',
	'autilus',
	'Necron',
	'Nephilim',
	'Nightmare',
	'Nightstalker',
	'Ninja',
	'Noble',
	'Noggle',
	'Nomad',
	'Nymph',
	'Octopus',
	'Ogre',
	'Ooze',
	'Orb',
	'Orc',
	'Orgg',
	'Otter',
	'Ouphe',
	'Ox',
	'Oyster',
	'Pangolin',
	'Peasant',
	'Pegasus',
	'Pentavite',
	'Performer',
	'Pest',
	'Phelddagrif',
	'Phoenix',
	'Phyrexian',
	'Pilot',
	'Pincher',
	'Pirate',
	'Plant',
	'Porcupine',
	'Possum',
	'Praetor',
	'Primarch',
	'Prism',
	'Processor',
	'Rabbit',
	'Raccoon',
	'Ranger',
	'Rat',
	'Rebel',
	'Reflection',
	'Rhino',
	'Rigger',
	'Robot',
	'Rogue',
	'Sable',
	'Salamander',
	'Samurai',
	'Sand',
	'Saproling',
	'Satyr',
	'Scarecrow',
	'Scientist',
	'Scion',
	'Scorpion',
	'Scout',
	'Sculpture',
	'Serf',
	'Serpent',
	'Servo',
	'Shade',
	'Shaman',
	'Shapeshifter',
	'Shark',
	'Sheep',
	'Siren',
	'Skeleton',
	'Skunk',
	'Slith',
	'Sliver',
	'Sloth',
	'Slug',
	'Snail',
	'Snake',
	'Soldier',
	'Soltari',
	'Spawn',
	'Specter',
	'Spellshaper',
	'Sphinx',
	'Spider',
	'Spike',
	'Spirit',
	'Splinter',
	'Sponge',
	'Squid',
	'Squirrel',
	'Starfish',
	'Surrakar',
	'Survivor',
	'Synth',
	'Tentacle',
	'Tetravite',
	'Thalakos',
	'Thopter',
	'Thrull',
	'Tiefling',
	'Time Lord',
	'Toy',
	'Treefolk',
	'Trilobite',
	'Triskelavite',
	'Troll',
	'Turtle',
	'Tyranid',
	'Unicorn',
	'Vampire',
	'Varmint',
	'Vedalken',
	'Viashino',
	'Volver',
	'Wall',
	'Walrus',
	'Warlock',
	'Warrior',
	'Weasel',
	'Weird',
	'Werewolf',
	'Whale',
	'Wizard',
	'Wolf',
	'Wolverine',
	'Wombat',
	'Worm',
	'Wraith',
	'Wurm',
	'Yeti',
	'Zombie',
	'Zubera'
].map((s) => (s === 'autilus' ? 'Nautilus' : s));

const CORE_CREATURE_SUBTYPES_BY_LOWER = new Map<string, string>(
	CORE_CREATURE_SUBTYPES.map((s) => [s.toLowerCase(), s])
);

function collectPlayerSubtypeWeights(
	player: PlayerGameState,
	enteringObj?: CardInstance
): Map<string, number> {
	const weights = new Map<string, number>();
	const canonicalByLower = new Map<string, string>(CORE_CREATURE_SUBTYPES_BY_LOWER);

	const scanZone = (cards: readonly CardInstance[], weight: number) => {
		for (const card of cards) {
			if (enteringObj && card.instanceId === enteringObj.instanceId) continue;
			const ch = viewCardInstance(card);
			const hasCreatureOrKindred = ch.types.includes('Creature') || ch.types.includes('Kindred');
			for (const rawSub of ch.subtypes) {
				const low = rawSub.toLowerCase();
				if (NON_CREATURE_SUBTYPES_LOWER.has(low)) continue;
				if (!hasCreatureOrKindred && !CORE_CREATURE_SUBTYPES_BY_LOWER.has(low)) continue;
				const canon = canonicalByLower.get(low) ?? rawSub;
				canonicalByLower.set(low, canon);
				weights.set(canon, (weights.get(canon) ?? 0) + weight);
			}
		}
	};

	scanZone(player.battlefield, 4);
	scanZone(player.command, 4);
	scanZone(player.hand, 3);
	scanZone(player.graveyard, 1);
	scanZone(player.exile, 1);
	scanZone(player.library, 1);
	return weights;
}

/**
 * Builds the `chooseMode` option list for "As ~ enters, choose a creature type":
 * puts creature subtypes actually present in the controller's deck/board first (most common first),
 * followed by all remaining standard CR 205.3m creature types alphabetically.
 */
export function buildCreatureSubtypeOptions(
	_state: GameState,
	player: PlayerGameState,
	enteringObj?: CardInstance
): string[] {
	const weights = collectPlayerSubtypeWeights(player, enteringObj);
	const prioritized = [...weights.entries()]
		.sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
		.map(([sub]) => sub);
	const seenLower = new Set(prioritized.map((s) => s.toLowerCase()));
	const out = [...prioritized];
	for (const sub of CORE_CREATURE_SUBTYPES) {
		if (!seenLower.has(sub.toLowerCase())) {
			seenLower.add(sub.toLowerCase());
			out.push(sub);
		}
	}
	return out;
}

export function chooseBotBestCreatureSubtype(
	state: GameState,
	player: PlayerGameState,
	enteringObj?: CardInstance
): string {
	const weights = collectPlayerSubtypeWeights(player, enteringObj);
	if (weights.size > 0) {
		const sorted = [...weights.entries()].sort((a, b) =>
			b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])
		);
		return sorted[0][0];
	}
	const opts = buildCreatureSubtypeOptions(state, player, enteringObj);
	return opts.includes('Human') ? 'Human' : (opts[0] ?? 'Human');
}

// ---- 4. Multi-Color Combination & Filter Mana Helpers (CR 106.1a–b, 605.1a) -----------------

export function formatManaBundle(bundle: readonly ManaColor[]): string {
	return bundle.map((c) => `{${c}}`).join('');
}

export function parseManaBundleLabel(label: string): ManaColor[] | null {
	const syms = [...label.matchAll(/\{([WUBRGC])\}/g)].map((m) => m[1] as ManaColor);
	return syms.length > 0 && syms.map((c) => `{${c}}`).join('') === label.trim() ? syms : null;
}

/**
 * Generates canonical non-decreasing combinations with repetition of length `count` from `colors`.
 * E.g. `expandCombinationBundles(['R', 'G'], 2)` -> `[['R', 'R'], ['R', 'G'], ['G', 'G']]`.
 */
export function expandCombinationBundles(
	colors: readonly ManaColor[],
	count: number
): ManaColor[][] {
	const uniq: ManaColor[] = [];
	for (const c of colors) {
		if (!uniq.includes(c)) uniq.push(c);
	}
	if (count <= 0 || uniq.length === 0) return [];
	const out: ManaColor[][] = [];
	const cur: ManaColor[] = [];
	const dfs = (startIdx: number, remaining: number) => {
		if (remaining === 0) {
			out.push([...cur]);
			return;
		}
		for (let i = startIdx; i < uniq.length; i++) {
			cur.push(uniq[i]);
			dfs(i, remaining - 1);
			cur.pop();
		}
	};
	dfs(0, count);
	return out;
}

export function scoreBundleForRequirement(
	pool: ManaPool,
	bundle: readonly ManaColor[],
	req?: ManaCostRequirement | null,
	preferredColor?: ManaColor,
	spendAsAny = false
): number {
	const nextPool: ManaPool = { ...pool };
	for (const c of bundle) {
		nextPool[c] = (nextPool[c] ?? 0) + 1;
	}
	let score = 0;
	if (req) {
		const totalNext =
			nextPool.W + nextPool.U + nextPool.B + nextPool.R + nextPool.G + nextPool.C;
		const totalReq =
			req.generic +
			req.colored.W +
			req.colored.U +
			req.colored.B +
			req.colored.R +
			req.colored.G +
			req.colored.C;
		const payable = spendAsAny
			? nextPool.C >= req.colored.C && totalNext >= totalReq
			: canPayManaCost(nextPool, req);
		if (payable) {
			score += 10_000;
		}
		for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) {
			const needed = Math.max(0, (req.colored[c] ?? 0) - (pool[c] ?? 0));
			const added = bundle.filter((x) => x === c).length;
			score += Math.min(needed, added) * 100;
		}
		for (const flex of req.flexibleSymbols ?? []) {
			if (!flex.altColor) continue;
			const h0 = flex.primaryColor;
			const h1 = flex.altColor;
			const hasBefore = (pool[h0] ?? 0) + (pool[h1] ?? 0) > 0;
			const hasAfter = (nextPool[h0] ?? 0) + (nextPool[h1] ?? 0) > 0;
			if (!hasBefore && hasAfter) score += 60;
		}
	}
	if (preferredColor) {
		score += bundle.filter((c) => c === preferredColor).length * 10;
	}
	return score;
}

export function pickBestBundleForRequirement(
	bundles: readonly (readonly ManaColor[])[],
	pool: ManaPool,
	req?: ManaCostRequirement | null,
	preferredColor?: ManaColor,
	spendAsAny = false
): ManaColor[] {
	if (bundles.length === 0) return [];
	let best = bundles[0];
	let bestScore = scoreBundleForRequirement(pool, best, req, preferredColor, spendAsAny);
	for (let i = 1; i < bundles.length; i++) {
		const s = scoreBundleForRequirement(pool, bundles[i], req, preferredColor, spendAsAny);
		if (s > bestScore) {
			best = bundles[i];
			bestScore = s;
		}
	}
	return [...best];
}

export function pickCombinationForRequirement(
	allowedColors: readonly ManaColor[],
	count: number,
	pool: ManaPool,
	req?: ManaCostRequirement | null,
	preferredColor?: ManaColor,
	player?: PlayerGameState,
	spendAsAny = false
): ManaColor[] {
	const uniq: ManaColor[] = [];
	for (const c of allowedColors) {
		if (!uniq.includes(c)) uniq.push(c);
	}
	if (count <= 0 || uniq.length === 0) return [];
	if (count <= 4 && uniq.length <= 5) {
		const bundles = expandCombinationBundles(uniq, count);
		if (bundles.length > 0) {
			return pickBestBundleForRequirement(bundles, pool, req, preferredColor, spendAsAny);
		}
	}
	const out: ManaColor[] = [];
	const workingPool: ManaPool = { ...pool };
	if (req) {
		for (const c of uniq) {
			const deficit = Math.max(0, (req.colored[c] ?? 0) - (workingPool[c] ?? 0));
			const take = Math.min(deficit, count - out.length);
			for (let i = 0; i < take; i++) {
				out.push(c);
				workingPool[c] = (workingPool[c] ?? 0) + 1;
			}
		}
		for (const flex of req.flexibleSymbols ?? []) {
			if (!flex.altColor || out.length >= count) continue;
			const h0 = flex.primaryColor;
			const h1 = flex.altColor;
			if ((workingPool[h0] ?? 0) > 0 || (workingPool[h1] ?? 0) > 0) continue;
			const pick = uniq.includes(h0) ? h0 : uniq.includes(h1) ? h1 : null;
			if (pick) {
				out.push(pick);
				workingPool[pick] = (workingPool[pick] ?? 0) + 1;
			}
		}
	}
	let fallbackColor =
		preferredColor && uniq.includes(preferredColor) ? preferredColor : uniq[0];
	if (!preferredColor && player) {
		const bestCol = chooseBotBestColor({} as GameState, player);
		if (uniq.includes(bestCol)) fallbackColor = bestCol;
	}
	while (out.length < count) {
		out.push(fallbackColor);
	}
	return out;
}
