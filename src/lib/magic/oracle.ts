import type {
	DelayedTrigger,
	LibrarySearchDestination,
	LibrarySearchSpec,
	ManaColor,
	ManaPool,
	ScryfallCard,
	StackItem,
	TokenCreationSpec
} from './types.ts';

export interface FlexibleManaSymbol {
	primaryColor: ManaColor;
	altColor?: ManaColor;
	altGeneric?: number;
	altLife?: number;
}

export interface ManaCostRequirement {
	colored: Record<ManaColor, number>;
	generic: number;
	hasX: boolean;
	xCount: number;
	totalCmc: number;
	flexibleSymbols?: FlexibleManaSymbol[];
}

export function withStackItemText(
	item: Omit<StackItem, 'oracleText'>,
	textOrCard: string | ScryfallCard
): StackItem {
	return {
		...item,
		oracleText: typeof textOrCard === 'string' ? textOrCard : textOrCard.oracleText
	};
}

export function withDelayedTriggerSpec(
	base: Omit<DelayedTrigger, 'oracleText'>,
	spec: { oracleText: string }
): DelayedTrigger {
	return {
		...base,
		oracleText: spec.oracleText
	};
}

export function buildTokenScryfallCard(
	id: string,
	spec: TokenCreationSpec
): ScryfallCard {
	const isTreasure = /\bTreasure\b/.test(spec.typeLine);
	return {
		id,
		name: spec.name,
		manaCost: '',
		cmc: 0,
		typeLine: spec.typeLine,
		oracleText: isTreasure
			? '{T}, Sacrifice this artifact: Add one mana of any color.'
			: spec.keywords.join(', '),
		colors: spec.colors,
		colorIdentity: spec.colors,
		keywords: spec.keywords,
		power: isTreasure ? undefined : String(spec.power),
		toughness: isTreasure ? undefined : String(spec.toughness),
		imageUrl: `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(spec.name.replace(' Token', ''))}&format=image&version=normal`,
		artCropUrl: `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(spec.name.replace(' Token', ''))}&format=image&version=art_crop`,
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		hasPartnerWith: undefined,
		isBackground: false
	} as ScryfallCard;
}

export function createEmptyManaPool(): ManaPool {
	return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
}

export function getTotalManaInPool(pool: ManaPool): number {
	return pool.W + pool.U + pool.B + pool.R + pool.G + pool.C;
}

export function parseManaCost(
	manaCostStr: string,
	xValue = 0,
	additionalGeneric = 0,
	genericReduction = 0
): ManaCostRequirement {
	const colored: Record<ManaColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
	let generic = Math.max(0, additionalGeneric);
	let hasX = false;
	let xCount = 0;
	let hybridExtraCmc = 0;
	const flexibleSymbols: FlexibleManaSymbol[] = [];

	const symbols = manaCostStr.match(/\{([^}]+)\}/g) || [];
	for (const rawSym of symbols) {
		const sym = rawSym.slice(1, -1).toUpperCase();
		if (sym === 'X') {
			hasX = true;
			xCount += 1;
		} else if (/^\d+$/.test(sym)) {
			generic += parseInt(sym, 10);
		} else if (sym === 'W' || sym === 'U' || sym === 'B' || sym === 'R' || sym === 'G' || sym === 'C') {
			colored[sym] += 1;
		} else if (sym.includes('/')) {
			// CR 107.4e-f / 202.3f: Hybrid {W/U}, monocolored hybrid {2/W} (MV 2), or Phyrexian {W/P}
			const parts = sym.split('/');
			const cols = parts.filter(
				(p): p is ManaColor =>
					p === 'W' || p === 'U' || p === 'B' || p === 'R' || p === 'G' || p === 'C'
			);
			const numPart = parts.find((p) => /^\d+$/.test(p));
			const hasPhyrexian = parts.includes('P');
			const firstCol = cols[0];
			if (firstCol) {
				colored[firstCol] += 1;
				if (cols.length >= 2) {
					flexibleSymbols.push({ primaryColor: firstCol, altColor: cols[1] });
				} else if (numPart) {
					const numVal = parseInt(numPart, 10);
					flexibleSymbols.push({ primaryColor: firstCol, altGeneric: numVal });
					if (numVal > 1) {
						hybridExtraCmc += numVal - 1;
					}
				} else if (hasPhyrexian) {
					flexibleSymbols.push({ primaryColor: firstCol, altLife: 2 });
				}
			} else if (numPart) {
				generic += parseInt(numPart, 10);
			} else {
				generic += 1;
			}
		}
	}

	generic += xCount * Math.max(0, xValue);
	generic = Math.max(0, generic - Math.max(0, genericReduction));

	const totalColored = colored.W + colored.U + colored.B + colored.R + colored.G + colored.C;
	return {
		colored,
		generic,
		hasX,
		xCount,
		totalCmc: totalColored + generic + hybridExtraCmc,
		...(flexibleSymbols.length > 0 ? { flexibleSymbols } : {})
	};
}

export function resolveFlexibleManaRequirement(
	pool: ManaPool,
	req: ManaCostRequirement,
	availableLife?: number
): {
	colored: Record<ManaColor, number>;
	generic: number;
	lifePaid: number;
} {
	const colored: Record<ManaColor, number> = { ...req.colored };
	let generic = req.generic;
	let lifePaid = 0;

	if (req.flexibleSymbols && req.flexibleSymbols.length > 0) {
		for (const flex of req.flexibleSymbols) {
			if (pool[flex.primaryColor] < colored[flex.primaryColor]) {
				if (flex.altColor !== undefined && pool[flex.altColor] > colored[flex.altColor]) {
					colored[flex.primaryColor] -= 1;
					colored[flex.altColor] += 1;
				} else if (flex.altGeneric !== undefined) {
					colored[flex.primaryColor] -= 1;
					generic += flex.altGeneric;
				} else if (
					flex.altLife !== undefined &&
					availableLife !== undefined &&
					availableLife >= lifePaid + flex.altLife
				) {
					colored[flex.primaryColor] -= 1;
					lifePaid += flex.altLife;
				}
			}
		}
	}

	return { colored, generic, lifePaid };
}

export function canPayManaCost(
	pool: ManaPool,
	req: ManaCostRequirement,
	availableLife?: number
): boolean {
	const resolved = resolveFlexibleManaRequirement(pool, req, availableLife);
	const colors: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];
	let remainingPool = 0;
	for (const c of colors) {
		if (pool[c] < resolved.colored[c]) {
			return false;
		}
		remainingPool += pool[c] - resolved.colored[c];
	}
	return remainingPool >= resolved.generic;
}

export function deductManaFromPool(
	pool: ManaPool,
	req: ManaCostRequirement,
	onPayLife?: (life: number) => void
): ManaPool {
	const resolved = resolveFlexibleManaRequirement(pool, req);
	if (resolved.lifePaid > 0 && onPayLife) {
		onPayLife(resolved.lifePaid);
	}
	const next: ManaPool = { ...pool };
	const colors: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];
	for (const c of colors) {
		next[c] = Math.max(0, next[c] - resolved.colored[c]);
	}

	let remGeneric = resolved.generic;
	// Spend colorless C first for generic costs, then colors with highest surplus
	if (remGeneric > 0 && next.C > 0) {
		const take = Math.min(next.C, remGeneric);
		next.C -= take;
		remGeneric -= take;
	}

	const colorOrder: ManaColor[] = ['G', 'R', 'B', 'U', 'W'];
	while (remGeneric > 0) {
		// Pick color with largest remaining count
		let bestColor: ManaColor | null = null;
		let bestAmt = 0;
		for (const c of colorOrder) {
			if (next[c] > bestAmt) {
				bestAmt = next[c];
				bestColor = c;
			}
		}
		if (!bestColor || bestAmt <= 0) break;
		next[bestColor] -= 1;
		remGeneric -= 1;
	}

	return next;
}

function parseWordOrNumber(raw: string, fallback = 1): number {
	const map: Record<string, number> = {
		a: 1,
		an: 1,
		one: 1,
		two: 2,
		three: 3,
		four: 4,
		five: 5,
		six: 6,
		seven: 7,
		eight: 8,
		nine: 9,
		ten: 10
	};
	const low = raw.trim().toLowerCase();
	if (low in map) return map[low];
	const parsed = parseInt(low, 10);
	return isNaN(parsed) ? fallback : parsed;
}

export function buildTokenSpec(
	power: number,
	toughness: number,
	desc: string,
	kwRaw: string
): TokenCreationSpec {
	const colors: ManaColor[] = [];
	const lowDesc = desc.toLowerCase();
	if (lowDesc.includes('white')) colors.push('W');
	if (lowDesc.includes('blue')) colors.push('U');
	if (lowDesc.includes('black')) colors.push('B');
	if (lowDesc.includes('red')) colors.push('R');
	if (lowDesc.includes('green')) colors.push('G');

	const subtypeWords = desc
		.split(/\s+/)
		.filter(
			(w) =>
				!['white', 'blue', 'black', 'red', 'green', 'colorless', 'and'].includes(w.toLowerCase())
		)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1));
	const subtype = subtypeWords.join(' ') || 'Spirit';

	const keywords: string[] = [];
	if (/flying/i.test(kwRaw)) keywords.push('Flying');
	if (/haste/i.test(kwRaw)) keywords.push('Haste');
	if (/trample/i.test(kwRaw)) keywords.push('Trample');
	if (/lifelink/i.test(kwRaw)) keywords.push('Lifelink');
	if (/deathtouch/i.test(kwRaw)) keywords.push('Deathtouch');
	if (/vigilance/i.test(kwRaw)) keywords.push('Vigilance');
	if (/menace/i.test(kwRaw)) keywords.push('Menace');

	return {
		name: `${subtype} Token`,
		power,
		toughness,
		colors,
		typeLine: `Token Creature — ${subtype}`,
		keywords
	};
}

const KNOWN_CARD_TYPES = [
	'Land',
	'Creature',
	'Artifact',
	'Enchantment',
	'Instant',
	'Sorcery',
	'Planeswalker',
	'Battle'
] as const;

const KNOWN_SEARCH_SUBTYPES = [
	'Plains',
	'Island',
	'Swamp',
	'Mountain',
	'Forest',
	'Desert',
	'Gate',
	'Cave',
	'Sphere',
	'Locus',
	'Equipment',
	'Aura',
	'Vehicle',
	'Shrine',
	'Saga',
	'Clue',
	'Food',
	'Treasure',
	'Dragon',
	'Elf',
	'Goblin',
	'Zombie',
	'Vampire',
	'Angel',
	'Demon',
	'Wizard',
	'Warrior',
	'Rogue',
	'Cleric',
	'Sliver',
	'Elemental',
	'Dinosaur',
	'Merfolk',
	'Human',
	'Spirit',
	'Beast',
	'Hydra',
	'Knight',
	'Soldier',
	'Faerie',
	'Praetor',
	'Phyrexian',
	'Eldrazi',
	'Rat',
	'Cat',
	'Dog',
	'Bird'
] as const;

const NON_SUBTYPE_CAPITALIZED_WORDS = new Set([
	'Search',
	'Up',
	'One',
	'Two',
	'Three',
	'Four',
	'Basic',
	'Nonbasic',
	'Legendary',
	'Nonlegendary',
	'Nonland',
	'Noncreature',
	'Nonartifact',
	'Permanent',
	'Card',
	'Cards',
	'White',
	'Blue',
	'Black',
	'Red',
	'Green',
	'Colorless',
	'Multicolored',
	...KNOWN_CARD_TYPES
]);

/**
 * Grammar-driven parser for MTG "search your/their library for [criteria]..." instructions.
 * Produces a structured `LibrarySearchSpec` covering card types, subtypes, supertypes,
 * mana value bounds, `statedQuality` (CR 701.19b "Fail to Find" eligibility), and destinations.
 */
export function parseLibrarySearchSpec(oracleText: string): LibrarySearchSpec | null {
	const match = oracleText.match(
		/search (?:your|their) library for (.+?)(?:(?:,\s*|\s+and\s+)(?=(?:reveal|put|exile|shuffle|then)\b)|[.;\n]|$)([^\n]*)/i
	);
	if (!match) return null;

	const rawCriteria = match[1].trim();
	const restOfParagraph = (match[2] || '').trim();
	const fullClause = `${rawCriteria}, ${restOfParagraph}`;

	const upTo = /\bup to\b/i.test(rawCriteria);
	const qtyMatch = rawCriteria.match(/^(?:up to\s+)?(a|an|one|two|three|four|\d+)\b/i);
	const count = qtyMatch ? parseWordOrNumber(qtyMatch[1], 1) : 1;

	const requireBasic = /\bbasic\b/i.test(rawCriteria) && !/\bnonbasic\b/i.test(rawCriteria);
	const requireLegendary =
		/\blegendary\b/i.test(rawCriteria) && !/\bnonlegendary\b/i.test(rawCriteria);

	const disallowedTypes: string[] = [];
	if (/\bnonbasic\b/i.test(rawCriteria)) disallowedTypes.push('Basic');
	if (/\bnonland\b/i.test(rawCriteria)) disallowedTypes.push('Land');
	if (/\bnoncreature\b/i.test(rawCriteria)) disallowedTypes.push('Creature');
	if (/\bnonartifact\b/i.test(rawCriteria)) disallowedTypes.push('Artifact');
	if (/\bnonenchantment\b/i.test(rawCriteria)) disallowedTypes.push('Enchantment');

	const allowedTypes: string[] = [];
	for (const cType of KNOWN_CARD_TYPES) {
		const re = new RegExp(`\\b${cType}\\b`, 'i');
		if (re.test(rawCriteria)) {
			allowedTypes.push(cType);
		}
	}

	const allowedSubtypes: string[] = [];
	for (const sub of KNOWN_SEARCH_SUBTYPES) {
		const re = new RegExp(`\\b${sub}\\b`, 'i');
		if (re.test(rawCriteria)) {
			allowedSubtypes.push(sub);
		}
	}

	// Also detect any other capitalized subtype words before "card/cards" (e.g. "Rebel", "Mercenary")
	const beforeCard = rawCriteria.split(/\bcards?\b/i)[0] || rawCriteria;
	const capWords = beforeCard.match(/\b[A-Z][a-z]+\b/g) || [];
	for (const word of capWords) {
		if (!NON_SUBTYPE_CAPITALIZED_WORDS.has(word) && !allowedSubtypes.includes(word)) {
			allowedSubtypes.push(word);
		}
	}

	const allowedColors: ManaColor[] = [];
	if (/\bwhite\b/i.test(rawCriteria)) allowedColors.push('W');
	if (/\bblue\b/i.test(rawCriteria)) allowedColors.push('U');
	if (/\bblack\b/i.test(rawCriteria)) allowedColors.push('B');
	if (/\bred\b/i.test(rawCriteria)) allowedColors.push('R');
	if (/\bgreen\b/i.test(rawCriteria)) allowedColors.push('G');
	if (/\bcolorless\b/i.test(rawCriteria)) allowedColors.push('C');

	let maxCmc: number | undefined;
	let exactCmc: number | undefined;
	const maxCmcMatch = fullClause.match(/mana value (\d+) or less/i);
	if (maxCmcMatch) {
		maxCmc = parseInt(maxCmcMatch[1], 10);
	} else {
		const exactCmcMatch = fullClause.match(/mana value (\d+)(?!\s+or\b)/i);
		if (exactCmcMatch) {
			exactCmc = parseInt(exactCmcMatch[1], 10);
		}
	}

	const statedQuality = Boolean(
		requireBasic ||
			requireLegendary ||
			allowedTypes.length > 0 ||
			allowedSubtypes.length > 0 ||
			disallowedTypes.length > 0 ||
			allowedColors.length > 0 ||
			maxCmc !== undefined ||
			exactCmc !== undefined
	);

	let destinations: LibrarySearchDestination[] = [];
	const splitDestMatch = fullClause.match(
		/put one onto the battlefield(\s+tapped)? and the other into (?:your|their) hand/i
	);
	if (splitDestMatch) {
		destinations = [
			{ zone: 'battlefield', tapped: Boolean(splitDestMatch[1]) },
			{ zone: 'hand' }
		];
	} else if (/onto the battlefield/i.test(fullClause)) {
		const tapped = /onto the battlefield\s+tapped/i.test(fullClause);
		destinations = Array.from({ length: count }, () => ({ zone: 'battlefield', tapped }));
	} else if (
		/put (?:it|that card|them|those cards) on top\b|on top of (?:your|their) library/i.test(
			fullClause
		)
	) {
		destinations = Array.from({ length: count }, () => ({ zone: 'library', onTop: true }));
	} else {
		destinations = Array.from({ length: count }, () => ({ zone: 'hand' }));
	}

	return {
		statedQuality,
		upTo,
		count,
		requireBasic: requireBasic || undefined,
		requireLegendary: requireLegendary || undefined,
		allowedTypes,
		allowedSubtypes,
		disallowedTypes,
		allowedColors: allowedColors.length > 0 ? allowedColors : undefined,
		maxCmc,
		exactCmc,
		destinations,
		rawCriteriaText: rawCriteria
	};
}

/**
 * Evaluates whether a `ScryfallCard` in a library satisfies `LibrarySearchSpec`.
 */
export function matchesLibrarySearchSpec(card: ScryfallCard, spec: LibrarySearchSpec): boolean {
	const tl = card.typeLine;

	if (spec.requireBasic && !/\bBasic\b/i.test(tl)) {
		return false;
	}
	if (spec.requireLegendary && !/\bLegendary\b/i.test(tl)) {
		return false;
	}
	for (const dis of spec.disallowedTypes || []) {
		if (new RegExp(`\\b${dis}\\b`, 'i').test(tl)) {
			return false;
		}
	}
	if (spec.maxCmc !== undefined && card.cmc > spec.maxCmc) {
		return false;
	}
	if (spec.exactCmc !== undefined && card.cmc !== spec.exactCmc) {
		return false;
	}
	if (spec.allowedColors && spec.allowedColors.length > 0) {
		const wantsColorless = spec.allowedColors.includes('C');
		const cardColors = card.colors || [];
		const matchesColor =
			(wantsColorless && cardColors.length === 0) ||
			spec.allowedColors.some((c) => c !== 'C' && cardColors.includes(c));
		if (!matchesColor) return false;
	}

	const hasTypeFilter = spec.allowedTypes.length > 0;
	const hasSubtypeFilter = spec.allowedSubtypes.length > 0;

	if (hasTypeFilter && hasSubtypeFilter) {
		const matchesType = spec.allowedTypes.some((t) => new RegExp(`\\b${t}\\b`, 'i').test(tl));
		const matchesSubtype = spec.allowedSubtypes.some((s) =>
			new RegExp(`\\b${s}\\b`, 'i').test(tl)
		);
		// If criteria joined types and subtypes with "or" (e.g. "an artifact or Equipment card"), either matches;
		// otherwise (e.g. "a basic Forest land card" or "a Dragon creature card"), both must match.
		if (/\bor\b/i.test(spec.rawCriteriaText)) {
			if (!matchesType && !matchesSubtype) return false;
		} else {
			if (!matchesType || !matchesSubtype) return false;
		}
	} else if (hasTypeFilter) {
		const matchesType = spec.allowedTypes.some((t) => new RegExp(`\\b${t}\\b`, 'i').test(tl));
		if (!matchesType) return false;
	} else if (hasSubtypeFilter) {
		const matchesSubtype = spec.allowedSubtypes.some((s) =>
			new RegExp(`\\b${s}\\b`, 'i').test(tl)
		);
		if (!matchesSubtype) return false;
	}

	return true;
}

export function describeLibrarySearchDestination(dest: LibrarySearchDestination): string {
	if (dest.zone === 'battlefield') {
		return `onto the battlefield${dest.tapped ? ' tapped' : ''}`;
	}
	if (dest.zone === 'library' && dest.onTop) {
		return 'on top of the library';
	}
	return 'into hand';
}
