import type { ManaColor, ScryfallCard } from './types.ts';

const COLOR_MAP: Record<string, ManaColor[]> = {
	w: ['W'],
	white: ['W'],
	u: ['U'],
	blue: ['U'],
	b: ['B'],
	black: ['B'],
	r: ['R'],
	red: ['R'],
	g: ['G'],
	green: ['G'],
	azorius: ['W', 'U'],
	dimir: ['U', 'B'],
	rakdos: ['B', 'R'],
	gruul: ['R', 'G'],
	selesnya: ['G', 'W'],
	orzhov: ['W', 'B'],
	izzet: ['U', 'R'],
	golgari: ['B', 'G'],
	boros: ['R', 'W'],
	simic: ['G', 'U'],
	esper: ['W', 'U', 'B'],
	grixis: ['U', 'B', 'R'],
	jund: ['B', 'R', 'G'],
	naya: ['R', 'G', 'W'],
	bant: ['G', 'W', 'U'],
	abzan: ['W', 'B', 'G'],
	jeskai: ['U', 'R', 'W'],
	sultai: ['B', 'G', 'U'],
	mardu: ['R', 'W', 'B'],
	temur: ['G', 'U', 'R'],
	wubrg: ['W', 'U', 'B', 'R', 'G'],
	fivecolor: ['W', 'U', 'B', 'R', 'G']
};

const RARITY_RANK: Record<string, number> = {
	common: 0,
	c: 0,
	uncommon: 1,
	u: 1,
	rare: 2,
	r: 2,
	mythic: 3,
	m: 3,
	special: 4,
	s: 4,
	bonus: 4
};

function compareNumbers(actual: number, op: string, target: number): boolean {
	if (Number.isNaN(actual) || Number.isNaN(target)) return false;
	switch (op) {
		case ':':
		case '=':
			return actual === target;
		case '!=':
			return actual !== target;
		case '<':
			return actual < target;
		case '<=':
			return actual <= target;
		case '>':
			return actual > target;
		case '>=':
			return actual >= target;
		default:
			return actual === target;
	}
}

function parseColorSpec(val: string): {
	isColorless: boolean;
	isMulticolor: boolean;
	isMonocolor: boolean;
	numericCount: number | null;
	colors: Set<ManaColor>;
} {
	const low = val.trim().toLowerCase();
	if (low === 'c' || low === 'colorless') {
		return {
			isColorless: true,
			isMulticolor: false,
			isMonocolor: false,
			numericCount: null,
			colors: new Set()
		};
	}
	if (low === 'm' || low === 'multicolor' || low === 'multicolored') {
		return {
			isColorless: false,
			isMulticolor: true,
			isMonocolor: false,
			numericCount: null,
			colors: new Set()
		};
	}
	if (low === 'mono' || low === 'monocolor' || low === 'monocolored') {
		return {
			isColorless: false,
			isMulticolor: false,
			isMonocolor: true,
			numericCount: null,
			colors: new Set()
		};
	}
	if (/^\d+$/.test(low)) {
		return {
			isColorless: false,
			isMulticolor: false,
			isMonocolor: false,
			numericCount: parseInt(low, 10),
			colors: new Set()
		};
	}
	if (COLOR_MAP[low]) {
		return {
			isColorless: false,
			isMulticolor: false,
			isMonocolor: false,
			numericCount: null,
			colors: new Set(COLOR_MAP[low])
		};
	}

	const colors = new Set<ManaColor>();
	for (const ch of low) {
		if (ch === 'w') colors.add('W');
		else if (ch === 'u') colors.add('U');
		else if (ch === 'b') colors.add('B');
		else if (ch === 'r') colors.add('R');
		else if (ch === 'g') colors.add('G');
	}
	return {
		isColorless: false,
		isMulticolor: false,
		isMonocolor: false,
		numericCount: null,
		colors
	};
}

function matchColorSet(
	cardColorsRaw: ManaColor[],
	op: string,
	val: string,
	isIdentity: boolean
): boolean {
	const cardColors = new Set<ManaColor>(
		(cardColorsRaw || []).filter((c): c is ManaColor =>
			['W', 'U', 'B', 'R', 'G'].includes(c)
		)
	);
	const spec = parseColorSpec(val);

	if (spec.isColorless) {
		return op === '!=' ? cardColors.size > 0 : cardColors.size === 0;
	}
	if (spec.isMulticolor) {
		return op === '!=' ? cardColors.size <= 1 : cardColors.size > 1;
	}
	if (spec.isMonocolor) {
		return op === '!=' ? cardColors.size !== 1 : cardColors.size === 1;
	}
	if (spec.numericCount !== null) {
		return compareNumbers(cardColors.size, op, spec.numericCount);
	}

	const qColors = spec.colors;
	if (qColors.size === 0) return true;

	const isSubset = Array.from(cardColors).every((c) => qColors.has(c));
	const isSuperset = Array.from(qColors).every((c) => cardColors.has(c));
	const isExact = isSubset && isSuperset;

	switch (op) {
		case '=':
			return isExact;
		case '!=':
			return !isExact;
		case '<=':
			return isSubset;
		case '<':
			return isSubset && cardColors.size < qColors.size;
		case '>=':
			return isSuperset;
		case '>':
			return isSuperset && cardColors.size > qColors.size;
		case ':':
		default:
			// Scryfall convention: `id:ug` means fits within UG (<=), whereas `c:ug` means has at least U and G (>=)
			return isIdentity ? isSubset : isSuperset;
	}
}

function getCardProducedColors(card: ScryfallCard): Set<ManaColor> {
	const out = new Set<ManaColor>();
	const text = (card.oracleText || '') + '\n' + (card.backFace?.oracleText || '');
	const tLine = (card.typeLine || '') + ' ' + (card.backFace?.typeLine || '');
	if (tLine.includes('Plains')) out.add('W');
	if (tLine.includes('Island')) out.add('U');
	if (tLine.includes('Swamp')) out.add('B');
	if (tLine.includes('Mountain')) out.add('R');
	if (tLine.includes('Forest')) out.add('G');

	if (/add\s+[^\n.]*\{W\}/i.test(text)) out.add('W');
	if (/add\s+[^\n.]*\{U\}/i.test(text)) out.add('U');
	if (/add\s+[^\n.]*\{B\}/i.test(text)) out.add('B');
	if (/add\s+[^\n.]*\{R\}/i.test(text)) out.add('R');
	if (/add\s+[^\n.]*\{G\}/i.test(text)) out.add('G');
	if (/add\s+[^\n.]*\{C\}/i.test(text)) out.add('C');
	if (/any\s+color/i.test(text)) {
		out.add('W');
		out.add('U');
		out.add('B');
		out.add('R');
		out.add('G');
	}
	return out;
}

function evaluateIsProperty(card: ScryfallCard, prop: string): boolean {
	const p = prop.trim().toLowerCase();
	const tl = (card.typeLine || '').toLowerCase();
	const ot = (card.oracleText || '').toLowerCase();
	const cols = (card.colors || []).filter((c) => ['W', 'U', 'B', 'R', 'G'].includes(c));

	switch (p) {
		case 'commander':
		case 'brawler':
			return Boolean(card.canBeCommander);
		case 'partner':
			return Boolean(card.hasPartner);
		case 'background':
			return Boolean(card.isBackground);
		case 'legendary':
			return tl.includes('legendary');
		case 'historic':
			return tl.includes('legendary') || tl.includes('artifact') || tl.includes('saga');
		case 'permanent':
			return (
				tl.includes('creature') ||
				tl.includes('artifact') ||
				tl.includes('enchantment') ||
				tl.includes('land') ||
				tl.includes('planeswalker') ||
				tl.includes('battle')
			);
		case 'spell':
			return !tl.includes('land');
		case 'creature':
		case 'land':
		case 'artifact':
		case 'enchantment':
		case 'instant':
		case 'sorcery':
		case 'planeswalker':
		case 'battle':
		case 'equipment':
		case 'aura':
		case 'vehicle':
		case 'saga':
		case 'snow':
		case 'basic':
			return tl.includes(p);
		case 'dfc':
		case 'transform':
		case 'mdfc':
		case 'doublefaced':
			return Boolean(card.backFace);
		case 'multicolor':
		case 'multicolored':
		case 'gold':
			return cols.length > 1;
		case 'monocolor':
		case 'monocolored':
			return cols.length === 1;
		case 'colorless':
			return cols.length === 0;
		case 'vanilla':
			return tl.includes('creature') && !ot.trim();
		case 'modal':
			return ot.includes('•') || ot.includes('choose one') || ot.includes('choose two');
		case 'etb':
			return ot.includes('enters the battlefield') || ot.includes('enters tapped');
		default:
			return tl.includes(p) || ot.includes(p);
	}
}

function evaluateAtomicClause(
	card: ScryfallCard,
	rawAtom: string,
	quantity = 1
): boolean {
	let atom = rawAtom.trim();
	if (!atom) return true;

	let negated = false;
	if (atom.startsWith('-') && atom.length > 1) {
		negated = true;
		atom = atom.slice(1).trim();
	}

	const res = evaluatePositiveAtom(card, atom, quantity);
	return negated ? !res : res;
}

function evaluatePositiveAtom(
	card: ScryfallCard,
	atom: string,
	quantity: number
): boolean {
	// Exact name match: !"Card Name" or !CardName
	if (atom.startsWith('!')) {
		const exactTarget = atom
			.slice(1)
			.replace(/^"(.*)"$/, '$1')
			.trim()
			.toLowerCase();
		const fullLow = card.name.toLowerCase();
		const frontLow = fullLow.split('//')[0].trim();
		return fullLow === exactTarget || frontLow === exactTarget;
	}

	// Operator match: key(:|=|!=|<=|>=|<|>)value
	const opMatch = atom.match(/^([a-zA-Z]+)(!=|<=|>=|:|=|<|>)(.+)$/);
	if (!opMatch) {
		const needle = atom.replace(/^"(.*)"$/, '$1').trim().toLowerCase();
		if (!needle) return true;
		const fullLow = card.name.toLowerCase();
		const backLow = (card.backFace?.name || '').toLowerCase();
		return fullLow.includes(needle) || backLow.includes(needle);
	}

	const key = opMatch[1].toLowerCase();
	const op = opMatch[2];
	const val = opMatch[3].replace(/^"(.*)"$/, '$1').trim();
	const valLow = val.toLowerCase();

	const fullType = `${card.typeLine || ''} ${card.backFace?.typeLine || ''}`.toLowerCase();
	const fullOracle = `${card.oracleText || ''}\n${card.backFace?.oracleText || ''}`.toLowerCase();
	const fullName = `${card.name || ''} ${card.backFace?.name || ''}`.toLowerCase();
	const frontNameLow = card.name.split('//')[0].trim().toLowerCase();

	switch (key) {
		case 't':
		case 'type': {
			const hit = fullType.includes(valLow);
			return op === '!=' ? !hit : hit;
		}
		case 'o':
		case 'oracle':
		case 'fo': {
			const expandedNeedle = valLow.replace(/~/g, frontNameLow);
			const hit = fullOracle.includes(expandedNeedle) || fullOracle.includes(valLow);
			return op === '!=' ? !hit : hit;
		}
		case 'n':
		case 'name': {
			if (op === '=') return fullName === valLow || frontNameLow === valLow;
			const hit = fullName.includes(valLow);
			return op === '!=' ? !hit : hit;
		}
		case 'mv':
		case 'cmc':
		case 'manavalue': {
			if (valLow === 'even') return Math.floor(card.cmc) % 2 === 0;
			if (valLow === 'odd') return Math.floor(card.cmc) % 2 === 1;
			return compareNumbers(card.cmc, op, parseFloat(valLow));
		}
		case 'c':
		case 'color': {
			return matchColorSet(card.colors || [], op, valLow, false);
		}
		case 'id':
		case 'identity':
		case 'ci':
		case 'commander': {
			return matchColorSet(card.colorIdentity || [], op, valLow, true);
		}
		case 'm':
		case 'mana': {
			const costLow = (card.manaCost || '').toLowerCase();
			const cleanCost = costLow.replace(/[{}]/g, '');
			const cleanVal = valLow.replace(/[{}]/g, '');
			const hit = costLow.includes(valLow) || cleanCost.includes(cleanVal);
			return op === '!=' ? !hit : hit;
		}
		case 'pow':
		case 'power': {
			if (card.power === undefined) return false;
			if (valLow === '*' || opMatch[3] === '*') return card.power === '*';
			if (valLow === 'tou' || valLow === 'toughness') {
				return compareNumbers(
					parseFloat(card.power),
					op,
					parseFloat(card.toughness ?? 'NaN')
				);
			}
			return compareNumbers(parseFloat(card.power), op, parseFloat(valLow));
		}
		case 'tou':
		case 'toughness': {
			if (card.toughness === undefined) return false;
			if (valLow === '*' || opMatch[3] === '*') return card.toughness === '*';
			if (valLow === 'pow' || valLow === 'power') {
				return compareNumbers(
					parseFloat(card.toughness),
					op,
					parseFloat(card.power ?? 'NaN')
				);
			}
			return compareNumbers(parseFloat(card.toughness), op, parseFloat(valLow));
		}
		case 'pt': {
			if (card.power === undefined || card.toughness === undefined) return false;
			const sum = parseFloat(card.power) + parseFloat(card.toughness);
			return compareNumbers(sum, op, parseFloat(valLow));
		}
		case 'loy':
		case 'loyalty': {
			if (card.loyalty === undefined) return false;
			return compareNumbers(parseFloat(card.loyalty), op, parseFloat(valLow));
		}
		case 'kw':
		case 'keyword': {
			const kwHit =
				(card.keywords || []).some((k) => k.toLowerCase().includes(valLow)) ||
				fullOracle.includes(valLow);
			return op === '!=' ? !kwHit : kwHit;
		}
		case 'r':
		case 'rarity': {
			const cardRank = RARITY_RANK[(card.rarity || 'common').toLowerCase()];
			const targetRank = RARITY_RANK[valLow];
			if (cardRank === undefined || targetRank === undefined) {
				return (card.rarity || '').toLowerCase() === valLow;
			}
			return compareNumbers(cardRank, op, targetRank);
		}
		case 's':
		case 'set':
		case 'e':
		case 'edition': {
			const setLow = (card.setCode || '').toLowerCase();
			return op === '!=' ? setLow !== valLow : setLow === valLow;
		}
		case 'is': {
			return evaluateIsProperty(card, valLow);
		}
		case 'not': {
			return !evaluateIsProperty(card, valLow);
		}
		case 'f':
		case 'format':
		case 'legal': {
			if (valLow === 'commander' || valLow === 'edh') {
				return card.legalCommander !== false;
			}
			return true;
		}
		case 'banned': {
			if (valLow === 'commander' || valLow === 'edh') {
				return card.legalCommander === false;
			}
			return false;
		}
		case 'produces':
		case 'p': {
			const produced = getCardProducedColors(card);
			if (valLow === 'c' || valLow === 'colorless') {
				return produced.has('C');
			}
			const req = parseColorSpec(valLow).colors;
			if (req.size === 0) return produced.size > 0;
			return Array.from(req).every((c) => produced.has(c));
		}
		case 'qty':
		case 'q':
		case 'copies': {
			return compareNumbers(quantity, op, parseFloat(valLow));
		}
		default: {
			// Unknown key fallback: search full card text
			return (
				fullName.includes(valLow) ||
				fullType.includes(valLow) ||
				fullOracle.includes(valLow)
			);
		}
	}
}

function tokenizeScryfallQuery(query: string): string[] {
	const tokens: string[] = [];
	let current = '';
	let inQuotes = false;

	for (let i = 0; i < query.length; i++) {
		const ch = query[i];
		if (ch === '"') {
			inQuotes = !inQuotes;
			current += ch;
			continue;
		}
		if (!inQuotes && (ch === '(' || ch === ')')) {
			if (current.trim()) {
				tokens.push(current.trim());
				current = '';
			}
			tokens.push(ch);
			continue;
		}
		if (!inQuotes && /\s/.test(ch)) {
			if (current.trim()) {
				tokens.push(current.trim());
				current = '';
			}
			continue;
		}
		current += ch;
	}
	if (current.trim()) {
		tokens.push(current.trim());
	}
	return tokens;
}

/**
 * Evaluates whether a ScryfallCard matches a Scryfall search query string.
 * Supports boolean `OR`, `-` negation, `(...)` grouping, exact `!` matching,
 * and operators (`t:`, `o:`, `c:`, `id:`, `mv`, `cmc`, `m:`, `pow`, `tou`, `pt`,
 * `loy`, `kw:`, `r:`, `s:`, `is:`, `not:`, `f:`, `legal:`, `produces:`, `qty`).
 */
export function matchesScryfallQuery(
	card: ScryfallCard,
	rawQuery: string,
	quantity = 1
): boolean {
	const trimmed = rawQuery.trim();
	if (!trimmed) return true;

	const tokens = tokenizeScryfallQuery(trimmed);
	if (tokens.length === 0) return true;

	let pos = 0;

	function parseOrExpr(): boolean {
		let left = parseAndExpr();
		while (pos < tokens.length && tokens[pos].toLowerCase() === 'or') {
			pos++; // consume 'or'
			const right = parseAndExpr();
			left = left || right;
		}
		return left;
	}

	function parseAndExpr(): boolean {
		let result = true;
		while (
			pos < tokens.length &&
			tokens[pos] !== ')' &&
			tokens[pos].toLowerCase() !== 'or'
		) {
			const factor = parseFactor();
			result = result && factor;
		}
		return result;
	}

	function parseFactor(): boolean {
		if (pos >= tokens.length) return true;
		const tok = tokens[pos];

		if (tok === '(') {
			pos++; // consume '('
			const val = parseOrExpr();
			if (pos < tokens.length && tokens[pos] === ')') {
				pos++; // consume ')'
			}
			return val;
		}

		if (tok === '-(') {
			pos++;
			const val = parseOrExpr();
			if (pos < tokens.length && tokens[pos] === ')') {
				pos++;
			}
			return !val;
		}

		pos++;
		return evaluateAtomicClause(card, tok, quantity);
	}

	return parseOrExpr();
}

/**
 * Returns true if the input string looks like a Scryfall syntax expression
 * (rather than a simple single card name).
 */
export function isScryfallSyntaxQuery(input: string): boolean {
	const s = input.trim();
	if (!s) return false;
	return (
		/\b(t|type|o|oracle|fo|c|color|id|identity|ci|commander|mv|cmc|manavalue|m|mana|pow|power|tou|toughness|pt|loy|loyalty|kw|keyword|r|rarity|s|set|e|edition|is|not|f|format|legal|banned|produces|p)(!=|<=|>=|:|=|<|>)/i.test(
			s
		) ||
		/\s+or\s+/i.test(s) ||
		/(^|\s)-[a-zA-Z(]/.test(s)
	);
}
