import type {
	CardLayout,
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
	// --- Track P11 ---
	/** CR 107.4h: count of {S} snow mana symbols required (payable with any mana produced by a Snow source). */
	snow?: number;
	// --- End Track P11 ---
}

// --- Track P11 ---
export interface ParseManaCostOptions {
	coloredReduction?: Partial<Record<ManaColor, number>>;
	hybridColoredReduction?: Array<[ManaColor, ManaColor]>;
	coloredOnly?: boolean;
	minTotalMana?: number;
}
// --- End Track P11 ---

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

export interface PredefinedTokenDef extends TokenCreationSpec {
	oracleText: string;
	// --- Track P5 ---
	/** CR 111.10i: transforming double-faced predefined token (e.g. Incubator -> Phyrexian). */
	layout?: CardLayout;
	backFace?: PredefinedTokenDef;
}

/**
 * CR 111.10a–g, u, v, x: single authoritative table for predefined tokens.
 * Both `buildTokenScryfallCard` and the compiler's `tokenPhrase` read from this table.
 */
export const PREDEFINED_TOKEN_DEFS = {
	treasure: {
		name: 'Treasure',
		typeLine: 'Token Artifact — Treasure',
		colors: [],
		power: 0,
		toughness: 0,
		keywords: [],
		oracleText: '{T}, Sacrifice this artifact: Add one mana of any color.'
	},
	food: {
		name: 'Food',
		typeLine: 'Token Artifact — Food',
		colors: [],
		power: 0,
		toughness: 0,
		keywords: [],
		oracleText: '{2}, {T}, Sacrifice this token: You gain 3 life.'
	},
	gold: {
		name: 'Gold',
		typeLine: 'Token Artifact — Gold',
		colors: [],
		power: 0,
		toughness: 0,
		keywords: [],
		oracleText: 'Sacrifice this token: Add one mana of any color.'
	},
	walker: {
		name: 'Walker',
		typeLine: 'Token Creature — Zombie',
		colors: ['B'],
		power: 2,
		toughness: 2,
		keywords: [],
		oracleText: ''
	},
	shard: {
		name: 'Shard',
		typeLine: 'Token Enchantment — Shard',
		colors: [],
		power: 0,
		toughness: 0,
		keywords: [],
		oracleText: '{2}, Sacrifice this token: Scry 1, then draw a card.'
	},
	clue: {
		name: 'Clue',
		typeLine: 'Token Artifact — Clue',
		colors: [],
		power: 0,
		toughness: 0,
		keywords: [],
		oracleText: '{2}, Sacrifice this token: Draw a card.'
	},
	blood: {
		name: 'Blood',
		typeLine: 'Token Artifact — Blood',
		colors: [],
		power: 0,
		toughness: 0,
		keywords: [],
		oracleText: '{1}, {T}, Discard a card, Sacrifice this token: Draw a card.'
	},
	lander: {
		name: 'Lander',
		typeLine: 'Token Artifact — Lander',
		colors: [],
		power: 0,
		toughness: 0,
		keywords: [],
		oracleText:
			'{2}, {T}, Sacrifice this token: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.'
	},
	mutagen: {
		name: 'Mutagen',
		typeLine: 'Token Artifact — Mutagen',
		colors: [],
		power: 0,
		toughness: 0,
		keywords: [],
		oracleText:
			'{1}, {T}, Sacrifice this token: Put a +1/+1 counter on target creature. Activate only as a sorcery.'
	},
	heartwood: {
		name: 'Heartwood',
		typeLine: 'Token Artifact — Heartwood',
		colors: ['R', 'G'],
		power: 0,
		toughness: 0,
		keywords: [],
		oracleText: '{T}: Add {R} or {G}.'
	},
	powerstone: {
		name: 'Powerstone',
		typeLine: 'Token Artifact — Powerstone',
		colors: [],
		power: 0,
		toughness: 0,
		keywords: [],
		oracleText: "{T}: Add {C}. This mana can't be spent to cast a nonartifact spell."
	},
	vibranium: {
		name: 'Vibranium',
		typeLine: 'Token Artifact — Vibranium',
		colors: [],
		power: 0,
		toughness: 0,
		keywords: ['Indestructible'],
		oracleText: "{T}: Add {C}. This mana can't be spent to cast a nonartifact spell."
	},
	junk: {
		name: 'Junk',
		typeLine: 'Token Artifact — Junk',
		colors: [],
		power: 0,
		toughness: 0,
		keywords: [],
		oracleText:
			'{T}, Sacrifice this token: Exile the top card of your library. You may play that card this turn. Activate only as a sorcery.'
	},
	map: {
		name: 'Map',
		typeLine: 'Token Artifact — Map',
		colors: [],
		power: 0,
		toughness: 0,
		keywords: [],
		oracleText:
			'{1}, {T}, Sacrifice this token: Target creature you control explores. Activate only as a sorcery.'
	},
	// --- Track P5 (CR 111.10i / 701.53a) ---
	incubator: {
		name: 'Incubator',
		typeLine: 'Token Artifact — Incubator',
		colors: [],
		power: 0,
		toughness: 0,
		keywords: [],
		oracleText: '{2}: Transform this token.',
		layout: 'transform',
		backFace: {
			name: 'Phyrexian Token',
			typeLine: 'Token Artifact Creature — Phyrexian',
			colors: [],
			power: 0,
			toughness: 0,
			keywords: [],
			oracleText: ''
		}
	}
} satisfies Record<string, PredefinedTokenDef>;

function matchPredefinedTokenDef(spec: TokenCreationSpec): PredefinedTokenDef | undefined {
	const nameKey = spec.name.toLowerCase();
	if (nameKey in PREDEFINED_TOKEN_DEFS) {
		return PREDEFINED_TOKEN_DEFS[nameKey as keyof typeof PREDEFINED_TOKEN_DEFS];
	}
	const dashIdx = spec.typeLine.indexOf('—');
	const altDashIdx = dashIdx >= 0 ? dashIdx : spec.typeLine.indexOf(' - ');
	const subtypePart = altDashIdx >= 0 ? spec.typeLine.slice(altDashIdx + 1) : '';
	for (const sub of subtypePart.split(/\s+/).filter(Boolean)) {
		const key = sub.toLowerCase();
		if (key !== 'walker' && key in PREDEFINED_TOKEN_DEFS) {
			return PREDEFINED_TOKEN_DEFS[key as keyof typeof PREDEFINED_TOKEN_DEFS];
		}
	}
	return undefined;
}

export function buildTokenScryfallCard(
	id: string,
	spec: TokenCreationSpec
): ScryfallCard {
	const predefined = matchPredefinedTokenDef(spec);
	const isCreature = /\bCreature\b/.test(spec.typeLine);
	const kwText = spec.keywords.join(', ');
	const abilityText = predefined?.oracleText ?? '';
	const oracleText = [kwText, abilityText].filter(Boolean).join('\n');
	const frontImg = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(spec.name.replace(' Token', ''))}&format=image&version=normal`;
	const frontArt = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(spec.name.replace(' Token', ''))}&format=image&version=art_crop`;
	// --- Track P5: Transforming DFC predefined tokens (CR 111.10i: Incubator // Phyrexian) ---
	if (predefined?.layout === 'transform' && predefined.backFace) {
		const back = predefined.backFace;
		const backIsCreature = /\bCreature\b/.test(back.typeLine);
		const backKwText = back.keywords.join(', ');
		const backOracle = [backKwText, back.oracleText].filter(Boolean).join('\n');
		const backImg = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(back.name.replace(' Token', ''))}&format=image&version=normal`;
		const backArt = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(back.name.replace(' Token', ''))}&format=image&version=art_crop`;
		return {
			id,
			name: spec.name,
			manaCost: '',
			cmc: 0,
			typeLine: spec.typeLine,
			oracleText,
			colors: spec.colors,
			colorIdentity: spec.colors,
			keywords: spec.keywords,
			power: isCreature ? String(spec.power) : undefined,
			toughness: isCreature ? String(spec.toughness) : undefined,
			imageUrl: frontImg,
			artCropUrl: frontArt,
			layout: 'transform',
			faces: [
				{
					name: spec.name,
					manaCost: '',
					typeLine: spec.typeLine,
					oracleText,
					colors: spec.colors,
					power: isCreature ? String(spec.power) : undefined,
					toughness: isCreature ? String(spec.toughness) : undefined,
					imageUrl: frontImg,
					artCropUrl: frontArt
				},
				{
					name: back.name,
					manaCost: '',
					typeLine: back.typeLine,
					oracleText: backOracle,
					colors: back.colors,
					power: backIsCreature ? String(back.power) : undefined,
					toughness: backIsCreature ? String(back.toughness) : undefined,
					imageUrl: backImg,
					artCropUrl: backArt
				}
			],
			legalCommander: true,
			canBeCommander: false,
			hasPartner: false,
			hasChooseBackground: false,
			hasPartnerWith: undefined,
			isBackground: false
		} as ScryfallCard;
	}
	return {
		id,
		name: spec.name,
		manaCost: '',
		cmc: 0,
		typeLine: spec.typeLine,
		oracleText,
		colors: spec.colors,
		colorIdentity: spec.colors,
		keywords: spec.keywords,
		power: isCreature ? String(spec.power) : undefined,
		toughness: isCreature ? String(spec.toughness) : undefined,
		imageUrl: frontImg,
		artCropUrl: frontArt,
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
	genericReduction = 0,
	// --- Track P11 ---
	options?: ParseManaCostOptions
	// --- End Track P11 ---
): ManaCostRequirement {
	const colored: Record<ManaColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
	let generic = Math.max(0, additionalGeneric);
	let hasX = false;
	let xCount = 0;
	let hybridExtraCmc = 0;
	// --- Track P11 ---
	let snow = 0;
	// --- End Track P11 ---
	const flexibleSymbols: FlexibleManaSymbol[] = [];

	const symbols = manaCostStr.match(/\{([^}]+)\}/g) || [];
	for (const rawSym of symbols) {
		const sym = rawSym.slice(1, -1).toUpperCase();
		if (sym === 'X') {
			hasX = true;
			xCount += 1;
		} else if (/^\d+$/.test(sym)) {
			generic += parseInt(sym, 10);
		} else if (sym === 'S') {
			// --- Track P11 (CR 107.4h, 202.3h, 118.7a): {S} has MV 1 and is not reduced by generic reductions ---
			snow += 1;
		} else if (sym === 'W' || sym === 'U' || sym === 'B' || sym === 'R' || sym === 'G' || sym === 'C') {
			colored[sym] += 1;
		} else if (sym.includes('/')) {
			// CR 107.4e-g / 202.3f-g: Hybrid {W/U}, {C/W}, twobrid {2/W} (MV 2), Phyrexian {W/P}, or hybrid Phyrexian {W/U/P}
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
					flexibleSymbols.push({
						primaryColor: firstCol,
						altColor: cols[1],
						// --- Track P11 (CR 107.4g): hybrid Phyrexian {W/U/P} ---
						...(hasPhyrexian ? { altLife: 2 } : {})
					});
				} else if (numPart) {
					const numVal = parseInt(numPart, 10);
					flexibleSymbols.push({
						primaryColor: firstCol,
						altGeneric: numVal,
						...(hasPhyrexian ? { altLife: 2 } : {})
					});
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

	// --- Track P11 (CR 118.7b-e): colored/hybrid cost reductions & minTotalMana floor ---
	const baseManaBeforeReduction =
		colored.W + colored.U + colored.B + colored.R + colored.G + colored.C + snow + generic;
	let effGenericReduction = Math.max(0, genericReduction);

	const reduceSingleColor = (col: ManaColor, amount: number): void => {
		let rem = Math.max(0, amount);
		for (let guard = 0; guard < 64 && rem > 0 && colored[col] > 0; guard++) {
			const flexCount = flexibleSymbols.filter((f) => f.primaryColor === col).length;
			const fixedCount = colored[col] - flexCount;
			colored[col] -= 1;
			if (fixedCount <= 0) {
				const idx = flexibleSymbols.findIndex((f) => f.primaryColor === col);
				if (idx !== -1) flexibleSymbols.splice(idx, 1);
			}
			rem -= 1;
		}
		if (rem > 0) {
			// Check if any flexible symbol has `altColor === col`
			for (let guard = 0; guard < 64 && rem > 0; guard++) {
				const altIdx = flexibleSymbols.findIndex((f) => f.altColor === col);
				if (altIdx === -1) break;
				const primary = flexibleSymbols[altIdx].primaryColor;
				if (colored[primary] <= 0) break;
				colored[primary] -= 1;
				flexibleSymbols.splice(altIdx, 1);
				rem -= 1;
			}
		}
		if (rem > 0 && !options?.coloredOnly) {
			effGenericReduction += rem;
		}
	};

	if (options?.coloredReduction) {
		const allCols: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];
		for (const c of allCols) {
			const amt = options.coloredReduction[c] ?? 0;
			if (amt > 0) reduceSingleColor(c, amt);
		}
	}
	if (options?.hybridColoredReduction) {
		for (const [c1, c2] of options.hybridColoredReduction) {
			if (colored[c1] > 0 || flexibleSymbols.some((f) => f.altColor === c1)) {
				reduceSingleColor(c1, 1);
			} else if (colored[c2] > 0 || flexibleSymbols.some((f) => f.altColor === c2)) {
				reduceSingleColor(c2, 1);
			} else if (!options.coloredOnly) {
				effGenericReduction += 1;
			}
		}
	}

	generic = Math.max(0, generic - effGenericReduction);

	if (
		options?.minTotalMana !== undefined &&
		options.minTotalMana > 0 &&
		baseManaBeforeReduction >= options.minTotalMana
	) {
		const curTotal =
			colored.W + colored.U + colored.B + colored.R + colored.G + colored.C + snow + generic;
		if (curTotal < options.minTotalMana) {
			generic += options.minTotalMana - curTotal;
		}
	}
	// --- End Track P11 ---

	const totalColored = colored.W + colored.U + colored.B + colored.R + colored.G + colored.C;
	return {
		colored,
		generic,
		hasX,
		xCount,
		totalCmc: totalColored + snow + generic + hybridExtraCmc,
		...(flexibleSymbols.length > 0 ? { flexibleSymbols } : {}),
		...(snow > 0 ? { snow } : {})
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
	availableLife?: number,
	// --- Track P11 ---
	availableSnowMana?: number
	// --- End Track P11 ---
): boolean {
	const snowReq = req.snow ?? 0;
	if (snowReq > 0 && availableSnowMana !== undefined && availableSnowMana < snowReq) {
		return false;
	}
	const resolved = resolveFlexibleManaRequirement(pool, req, availableLife);
	const colors: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];
	let remainingPool = 0;
	for (const c of colors) {
		if (pool[c] < resolved.colored[c]) {
			return false;
		}
		remainingPool += pool[c] - resolved.colored[c];
	}
	return remainingPool >= resolved.generic + snowReq;
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

	let remGeneric = resolved.generic + (req.snow ?? 0);
	// Spend colorless C first for generic costs, then colors with highest surplus
	if (remGeneric > 0 && next.C > 0) {
		const take = Math.min(next.C, remGeneric);
		next.C -= take;
		remGeneric -= take;
	}

	const colorOrder: ManaColor[] = ['G', 'R', 'B', 'U', 'W'];
	for (let guard = 0; guard < 256 && remGeneric > 0; guard++) {
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
	'Gold',
	'Shard',
	'Blood',
	'Lander',
	'Mutagen',
	'Heartwood',
	'Powerstone',
	'Junk',
	'Map',
	'Vibranium',
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

	const namedMatch = rawCriteria.match(/\bnamed\s+(.+)$/i);
	const named = namedMatch ? namedMatch[1].trim() : undefined;
	const criteriaForQualities = namedMatch
		? rawCriteria.slice(0, namedMatch.index).trim()
		: rawCriteria;

	const upTo = /\bup to\b/i.test(rawCriteria);
	const qtyMatch = rawCriteria.match(/^(?:up to\s+)?(a|an|one|two|three|four|\d+)\b/i);
	const count = qtyMatch ? parseWordOrNumber(qtyMatch[1], 1) : 1;

	const requireBasic =
		/\bbasic\b/i.test(criteriaForQualities) && !/\bnonbasic\b/i.test(criteriaForQualities);
	const requireLegendary =
		/\blegendary\b/i.test(criteriaForQualities) && !/\bnonlegendary\b/i.test(criteriaForQualities);

	const disallowedTypes: string[] = [];
	if (/\bnonbasic\b/i.test(criteriaForQualities)) disallowedTypes.push('Basic');
	if (/\bnonland\b/i.test(criteriaForQualities)) disallowedTypes.push('Land');
	if (/\bnoncreature\b/i.test(criteriaForQualities)) disallowedTypes.push('Creature');
	if (/\bnonartifact\b/i.test(criteriaForQualities)) disallowedTypes.push('Artifact');
	if (/\bnonenchantment\b/i.test(criteriaForQualities)) disallowedTypes.push('Enchantment');

	const allowedTypes: string[] = [];
	for (const cType of KNOWN_CARD_TYPES) {
		const re = new RegExp(`\\b${cType}\\b`, 'i');
		if (re.test(criteriaForQualities)) {
			allowedTypes.push(cType);
		}
	}

	const allowedSubtypes: string[] = [];
	for (const sub of KNOWN_SEARCH_SUBTYPES) {
		const re = new RegExp(`\\b${sub}\\b`, 'i');
		if (re.test(criteriaForQualities)) {
			allowedSubtypes.push(sub);
		}
	}

	// Also detect any other capitalized subtype words before "card/cards" (e.g. "Rebel", "Mercenary")
	const beforeCard = criteriaForQualities.split(/\bcards?\b/i)[0] || criteriaForQualities;
	const capWords = beforeCard.match(/\b[A-Z][a-z]+\b/g) || [];
	for (const word of capWords) {
		if (!NON_SUBTYPE_CAPITALIZED_WORDS.has(word) && !allowedSubtypes.includes(word)) {
			allowedSubtypes.push(word);
		}
	}

	const allowedColors: ManaColor[] = [];
	if (/\bwhite\b/i.test(criteriaForQualities)) allowedColors.push('W');
	if (/\bblue\b/i.test(criteriaForQualities)) allowedColors.push('U');
	if (/\bblack\b/i.test(criteriaForQualities)) allowedColors.push('B');
	if (/\bred\b/i.test(criteriaForQualities)) allowedColors.push('R');
	if (/\bgreen\b/i.test(criteriaForQualities)) allowedColors.push('G');
	if (/\bcolorless\b/i.test(criteriaForQualities)) allowedColors.push('C');

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
		named ||
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
		...(named ? { named } : {}),
		destinations,
		rawCriteriaText: rawCriteria
	};
}

/**
 * Evaluates whether a `ScryfallCard` in a library satisfies `LibrarySearchSpec`.
 */
export function matchesLibrarySearchSpec(
	card: ScryfallCard,
	spec: LibrarySearchSpec,
	overrideColors?: readonly ManaColor[] | readonly string[]
): boolean {
	if (spec.named && card.name.toLowerCase() !== spec.named.toLowerCase()) {
		return false;
	}
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
		const cardColors = overrideColors ?? card.colors ?? [];
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
