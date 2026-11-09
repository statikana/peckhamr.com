import { STAPLE_CARDS } from './precons.ts';
import { splitSubtypes } from './runtime/layers.ts';
import { isScryfallSyntaxQuery, matchesScryfallQuery } from './search.ts';
import type { DeckCardEntry, ManaColor, ScryfallCard } from './types.ts';

export interface ParsedDeckLine {
	quantity: number;
	name: string;
	isCommander: boolean;
}

const BASIC_LAND_NAMES = new Set([
	'plains',
	'island',
	'swamp',
	'mountain',
	'forest',
	'wastes',
	'snow-covered plains',
	'snow-covered island',
	'snow-covered swamp',
	'snow-covered mountain',
	'snow-covered forest'
]);

const MULTI_COPY_CARDS = new Set([
	'relentless rats',
	'rat colony',
	'shadowborn apostle',
	'persistent petitioners',
	"dragon's approach",
	'slime against humanity',
	'hare apparent',
	'templar knight'
]);

const CAPPED_COPY_CARDS: Record<string, number> = {
	'seven dwarves': 7,
	'nazgûl': 9,
	'nazgul': 9
};

export function parseDecklistText(rawText: string): {
	commanderLines: ParsedDeckLine[];
	mainboardLines: ParsedDeckLine[];
} {
	const lines = rawText.split(/\r?\n/);
	let currentSection: 'main' | 'commander' | 'ignore' = 'main';
	const commanderLines: ParsedDeckLine[] = [];
	const mainboardLines: ParsedDeckLine[] = [];

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;

		// Check section headers
		const lower = line.toLowerCase();
		if (
			lower === 'commander' ||
			lower === 'commander:' ||
			lower === 'commanders' ||
			lower === 'commanders:' ||
			lower.startsWith('// commander')
		) {
			currentSection = 'commander';
			continue;
		}
		if (
			lower === 'deck' ||
			lower === 'deck:' ||
			lower === 'mainboard' ||
			lower === 'mainboard:' ||
			lower === 'maindeck:' ||
			lower.startsWith('// deck') ||
			lower.startsWith('// main') ||
			lower.startsWith('// creatures') ||
			lower.startsWith('// lands') ||
			lower.startsWith('// artifacts') ||
			lower.startsWith('// instants') ||
			lower.startsWith('// sorceries') ||
			lower.startsWith('// enchantments') ||
			lower.startsWith('// planeswalkers')
		) {
			currentSection = 'main';
			continue;
		}
		if (lower === 'maybeboard' || lower === 'maybeboard:' || lower.startsWith('// maybe')) {
			currentSection = 'ignore';
			continue;
		}
		if (line.startsWith('//') || line.startsWith('#')) {
			continue;
		}
		if (currentSection === 'ignore') continue;

		let isCmdrTag = currentSection === 'commander';
		let work = line;

		if (/\*cmdr\*|\[commander\]|\(commander\)/i.test(work)) {
			isCmdrTag = true;
			work = work.replace(/\*cmdr\*|\[commander\]|\(commander\)/gi, '').trim();
		}

		// Strip trailing foil markers, category tags (#Ramp), and set/collector codes like (CMM) 361
		work = work
			.replace(/\*F\*|\*E\*/gi, '')
			.replace(/#[a-zA-Z0-9_-]+/g, '')
			.replace(/\s+\([a-zA-Z0-9]{2,6}\)\s+[0-9a-zA-Z★†-]+.*$/, '')
			.replace(/\s+\([a-zA-Z0-9]{2,6}\)$/, '')
			.trim();

		const qtyMatch = work.match(/^(\d+)x?\s+(.+)$/i);
		let quantity = 1;
		let cardName = work;
		if (qtyMatch) {
			quantity = Math.max(1, parseInt(qtyMatch[1], 10));
			cardName = qtyMatch[2].trim();
		}

		// Handle split/double-faced names where user pasted "Front // Back"
		if (cardName.includes('//')) {
			cardName = cardName.split('//')[0].trim();
		}

		if (!cardName) continue;

		if (isCmdrTag) {
			commanderLines.push({ quantity, name: cardName, isCommander: true });
			// If user put "Commander:" and then didn't put a "Deck:" header, switch back to main after 1-2 lines if needed
		} else {
			mainboardLines.push({ quantity, name: cardName, isCommander: false });
		}
	}

	// If user had a Commander: header and no Deck: header, move lines after the first 1 (or 2 partners) to mainboard
	if (commanderLines.length > 2 && mainboardLines.length === 0) {
		const first = commanderLines.shift()!;
		mainboardLines.push(...commanderLines.map((c) => ({ ...c, isCommander: false })));
		commanderLines.length = 0;
		commanderLines.push(first);
	}

	return { commanderLines, mainboardLines };
}

export function normalizeScryfallCard(raw: Record<string, any>): ScryfallCard {
	const faces = Array.isArray(raw.card_faces) ? raw.card_faces : [];
	const front = faces[0] || raw;
	const back = faces[1] || null;

	const imageUris = raw.image_uris || front.image_uris || {};
	const backImageUris = back?.image_uris || {};
	const name = String(front.name || raw.name || 'Unknown Card');
	const encodedName = encodeURIComponent(name);

	const imageUrl =
		imageUris.normal ||
		imageUris.large ||
		`https://api.scryfall.com/cards/named?exact=${encodedName}&format=image&version=normal`;
	const artCropUrl =
		imageUris.art_crop ||
		imageUris.normal ||
		`https://api.scryfall.com/cards/named?exact=${encodedName}&format=image&version=art_crop`;

	const typeLine = String(raw.type_line || front.type_line || '');
	const oracleText = String(
		raw.oracle_text ??
			(faces.length > 0 ? faces.map((f: any) => f.oracle_text || '').join('\n//\n') : '')
	);
	const manaCost = String(raw.mana_cost ?? front.mana_cost ?? '');
	const colors = (raw.colors || front.colors || []) as ManaColor[];
	const colorIdentity = (raw.color_identity || []) as ManaColor[];
	const keywords = (raw.keywords || []) as string[];
	const legalCommander =
		!raw.legalities ||
		raw.legalities.commander === 'legal' ||
		raw.legalities.commander === 'restricted';

	const isLegendary = typeLine.includes('Legendary');
	const isCreatureOrVehicle =
		typeLine.includes('Creature') ||
		typeLine.includes('Vehicle') ||
		typeLine.includes('Spacecraft');
	const canBeCommander =
		(isLegendary && isCreatureOrVehicle) ||
		oracleText.toLowerCase().includes('can be your commander');

	const hasPartner =
		keywords.includes('Partner') ||
		keywords.includes('Friends forever') ||
		keywords.includes("Doctor's companion") ||
		oracleText.includes('Partner');
	const hasChooseBackground = oracleText.includes('Choose a Background');
	const isBackground = typeLine.includes('Background');

	return {
		id: String(raw.id || `scry_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`),
		oracleId: raw.oracle_id ? String(raw.oracle_id) : undefined,
		name,
		manaCost,
		cmc: Number(raw.cmc ?? 0),
		typeLine,
		oracleText,
		colors,
		colorIdentity,
		keywords,
		power: front.power !== undefined ? String(front.power) : raw.power !== undefined ? String(raw.power) : undefined,
		toughness:
			front.toughness !== undefined
				? String(front.toughness)
				: raw.toughness !== undefined
					? String(raw.toughness)
					: undefined,
		loyalty:
			front.loyalty !== undefined
				? String(front.loyalty)
				: raw.loyalty !== undefined
					? String(raw.loyalty)
					: undefined,
		imageUrl,
		artCropUrl,
		rarity: raw.rarity ? String(raw.rarity) : undefined,
		setCode: raw.set ? String(raw.set) : undefined,
		collectorNumber: raw.collector_number ? String(raw.collector_number) : undefined,
		legalCommander,
		canBeCommander,
		hasPartner,
		hasChooseBackground,
		isBackground,
		backFace: back
			? {
					name: String(back.name || ''),
					manaCost: String(back.mana_cost || ''),
					typeLine: String(back.type_line || ''),
					oracleText: String(back.oracle_text || ''),
					power: back.power !== undefined ? String(back.power) : undefined,
					toughness: back.toughness !== undefined ? String(back.toughness) : undefined,
					loyalty: back.loyalty !== undefined ? String(back.loyalty) : undefined,
					imageUrl: backImageUris.normal || imageUrl
			  }
			: undefined
	};
}

export async function resolveCardsFromScryfall(names: string[]): Promise<{
	resolved: Map<string, ScryfallCard>;
	notFound: string[];
}> {
	const resolved = new Map<string, ScryfallCard>();
	const toFetch: string[] = [];
	const seenLower = new Set<string>();

	for (const rawName of names) {
		const key = rawName.trim().toLowerCase();
		if (!key || seenLower.has(key)) continue;
		seenLower.add(key);

		if (STAPLE_CARDS[key]) {
			resolved.set(key, STAPLE_CARDS[key]);
		} else {
			toFetch.push(rawName.trim());
		}
	}

	const notFound: string[] = [];

	// Fetch in batches of 75 via Scryfall /cards/collection
	const batchSize = 75;
	for (let i = 0; i < toFetch.length; i += batchSize) {
		const chunk = toFetch.slice(i, i + batchSize);
		try {
			const res = await fetch('https://api.scryfall.com/cards/collection', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'User-Agent': 'PeckhamrMagicCommander/1.0'
				},
				body: JSON.stringify({
					identifiers: chunk.map((n) => ({ name: n }))
				})
			});

			if (res.ok) {
				const data = (await res.json()) as {
					data?: Array<Record<string, any>>;
					not_found?: Array<{ name?: string }>;
				};
				const foundCards = data.data || [];
				for (const rawCard of foundCards) {
					const norm = normalizeScryfallCard(rawCard);
					resolved.set(norm.name.toLowerCase(), norm);
					if (rawCard.name && rawCard.name.includes('//')) {
						const frontKey = String(rawCard.name).split('//')[0].trim().toLowerCase();
						resolved.set(frontKey, norm);
					}
					// Cache in memory for subsequent imports
					STAPLE_CARDS[norm.name.toLowerCase()] = norm;
				}

				// Match requested chunk names to resolved cards or try fuzzy fallback
				for (const reqName of chunk) {
					const reqLow = reqName.toLowerCase();
					if (!resolved.has(reqLow)) {
						// Check if any resolved card starts with reqLow
						let matched = false;
						for (const [k, v] of resolved.entries()) {
							if (k.startsWith(reqLow) || v.name.toLowerCase() === reqLow) {
								resolved.set(reqLow, v);
								matched = true;
								break;
							}
						}
						if (!matched) {
							const fuzzyCard = await fetchFuzzyCard(reqName);
							if (fuzzyCard) {
								resolved.set(reqLow, fuzzyCard);
							} else {
								notFound.push(reqName);
							}
						}
					}
				}
			} else {
				for (const reqName of chunk) {
					const fuzzyCard = await fetchFuzzyCard(reqName);
					if (fuzzyCard) {
						resolved.set(reqName.toLowerCase(), fuzzyCard);
					} else {
						notFound.push(reqName);
					}
				}
			}
		} catch {
			for (const reqName of chunk) {
				notFound.push(reqName);
			}
		}
	}

	return { resolved, notFound };
}

async function fetchFuzzyCard(name: string): Promise<ScryfallCard | null> {
	try {
		const res = await fetch(
			`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`,
			{
				headers: { 'User-Agent': 'PeckhamrMagicCommander/1.0' }
			}
		);
		if (!res.ok) return null;
		const raw = (await res.json()) as Record<string, any>;
		const card = normalizeScryfallCard(raw);
		STAPLE_CARDS[card.name.toLowerCase()] = card;
		return card;
	} catch {
		return null;
	}
}

export async function searchScryfallCards(
	query: string,
	limit = 12
): Promise<ScryfallCard[]> {
	const trimmed = query.trim();
	if (!trimmed) return [];

	try {
		const res = await fetch(
			`https://api.scryfall.com/cards/search?q=${encodeURIComponent(trimmed)}&order=edhrec`,
			{
				headers: { 'User-Agent': 'PeckhamrMagicCommander/1.0' }
			}
		);
		if (res.ok) {
			const data = (await res.json()) as { data?: Array<Record<string, any>> };
			const rawList = (data.data || []).slice(0, limit);
			const out: ScryfallCard[] = [];
			for (const raw of rawList) {
				const card = normalizeScryfallCard(raw);
				STAPLE_CARDS[card.name.toLowerCase()] = card;
				out.push(card);
			}
			if (out.length > 0) return out;
		}
	} catch {
		// fall through to local staple search
	}

	const seen = new Set<string>();
	const localMatches: ScryfallCard[] = [];
	for (const card of Object.values(STAPLE_CARDS)) {
		const k = card.name.toLowerCase();
		if (seen.has(k)) continue;
		seen.add(k);
		if (matchesScryfallQuery(card, trimmed)) {
			localMatches.push(card);
			if (localMatches.length >= limit) break;
		}
	}
	return localMatches;
}

function partnerWithTarget(card: ScryfallCard): string | null {
	const m = card.oracleText.match(/\bPartner with ([^\n(.]+)/i);
	return m ? m[1].trim().toLowerCase() : null;
}

function hasFriendsForever(card: ScryfallCard): boolean {
	return (
		card.keywords.some((k) => k.toLowerCase() === 'friends forever') ||
		/\bfriends forever\b/i.test(card.oracleText)
	);
}

function hasDoctorsCompanion(card: ScryfallCard): boolean {
	return (
		card.keywords.some((k) => k.toLowerCase() === "doctor's companion") ||
		/\bdoctor's companion\b/i.test(card.oracleText)
	);
}

function isTimeLordDoctor(card: ScryfallCard): boolean {
	if (!card.typeLine.includes('Legendary') || !card.typeLine.includes('Creature')) return false;
	const dashIdx = card.typeLine.indexOf('—');
	if (dashIdx === -1) return false;
	const subs = splitSubtypes(card.typeLine.slice(dashIdx + 1).trim()).map((s) => s.toLowerCase());
	return subs.length === 2 && subs.includes('time lord') && subs.includes('doctor');
}

function hasGenericPartner(card: ScryfallCard): boolean {
	if (partnerWithTarget(card) !== null) return false;
	if (hasFriendsForever(card) || hasDoctorsCompanion(card)) return false;
	return (
		card.keywords.some((k) => k.toLowerCase() === 'partner') ||
		/\bpartner\b/i.test(card.oracleText)
	);
}

function hasChooseABackground(card: ScryfallCard): boolean {
	return Boolean(card.hasChooseBackground) || /\bchoose a background\b/i.test(card.oracleText);
}

function isLegendaryBackground(card: ScryfallCard): boolean {
	return (
		(Boolean(card.isBackground) || /\bBackground\b/.test(card.typeLine)) &&
		card.typeLine.includes('Legendary') &&
		card.typeLine.includes('Enchantment')
	);
}

function areValidCommanderPartners(c1: ScryfallCard, c2: ScryfallCard): boolean {
	// CR 702.124a: Generic Partner + Generic Partner
	if (c1.canBeCommander && c2.canBeCommander && hasGenericPartner(c1) && hasGenericPartner(c2)) {
		return true;
	}
	// CR 702.124f: Partner with [Name] + [Name]
	const pw1 = partnerWithTarget(c1);
	const pw2 = partnerWithTarget(c2);
	if (
		c1.canBeCommander &&
		c2.canBeCommander &&
		pw1 !== null &&
		pw2 !== null &&
		pw1 === c2.name.toLowerCase() &&
		pw2 === c1.name.toLowerCase()
	) {
		return true;
	}
	// CR 702.124j: Friends forever + Friends forever
	if (c1.canBeCommander && c2.canBeCommander && hasFriendsForever(c1) && hasFriendsForever(c2)) {
		return true;
	}
	// CR 702.124k: Choose a Background + Legendary Background enchantment
	if (
		(c1.canBeCommander && hasChooseABackground(c1) && isLegendaryBackground(c2)) ||
		(c2.canBeCommander && hasChooseABackground(c2) && isLegendaryBackground(c1))
	) {
		return true;
	}
	// CR 702.124m: Doctor's companion + Legendary Time Lord Doctor with no other creature types
	if (
		(c1.canBeCommander && hasDoctorsCompanion(c1) && isTimeLordDoctor(c2)) ||
		(c2.canBeCommander && hasDoctorsCompanion(c2) && isTimeLordDoctor(c1))
	) {
		return true;
	}
	return false;
}

export function validateCommanderDeck(
	commanders: ScryfallCard[],
	cards: DeckCardEntry[]
): {
	isLegal: boolean;
	errors: string[];
	colorIdentity: ManaColor[];
	totalCards: number;
} {
	const errors: string[] = [];

	if (commanders.length === 0) {
		errors.push('A Commander deck must have at least 1 Commander.');
	} else if (commanders.length > 2) {
		errors.push(`Too many Commanders (${commanders.length}); maximum is 2 with Partner/Background.`);
	} else if (commanders.length === 1) {
		const c = commanders[0];
		if (!c.canBeCommander) {
			errors.push(`${c.name} cannot legally be a Commander (not a Legendary Creature/Vehicle or allowed walker).`);
		}
	} else if (commanders.length === 2) {
		const [c1, c2] = commanders;
		if (!areValidCommanderPartners(c1, c2)) {
			errors.push(`${c1.name} and ${c2.name} do not have valid Partner / Background pairing abilities.`);
		}
	}

	const ciSet = new Set<ManaColor>();
	for (const cmd of commanders) {
		for (const col of cmd.colorIdentity) {
			ciSet.add(col);
		}
		if (!cmd.legalCommander) {
			errors.push(`Commander ${cmd.name} is banned or not legal in Commander.`);
		}
	}

	const colorOrder: ManaColor[] = ['W', 'U', 'B', 'R', 'G'];
	const colorIdentity = colorOrder.filter((c) => ciSet.has(c));

	let mainCount = 0;
	const nameCounts = new Map<string, number>();

	for (const cmd of commanders) {
		nameCounts.set(cmd.name.toLowerCase(), (nameCounts.get(cmd.name.toLowerCase()) || 0) + 1);
	}

	for (const entry of cards) {
		mainCount += entry.quantity;
		const cNameLow = entry.card.name.toLowerCase();
		const totalForCard = (nameCounts.get(cNameLow) || 0) + entry.quantity;
		nameCounts.set(cNameLow, totalForCard);

		const isBasic =
			BASIC_LAND_NAMES.has(cNameLow) || entry.card.typeLine.includes('Basic Land');
		const copyCap = CAPPED_COPY_CARDS[cNameLow];
		const allowsMulti =
			MULTI_COPY_CARDS.has(cNameLow) ||
			entry.card.oracleText.toLowerCase().includes('a deck can have any number of cards named');

		if (copyCap !== undefined) {
			if (totalForCard > copyCap) {
				errors.push(
					`Copy limit violation: ${entry.card.name} appears ${totalForCard} times (maximum is ${copyCap}).`
				);
			}
		} else if (!isBasic && !allowsMulti && totalForCard > 1) {
			errors.push(`Singleton violation: ${entry.card.name} appears ${totalForCard} times.`);
		}

		for (const col of entry.card.colorIdentity) {
			if (!ciSet.has(col)) {
				errors.push(
					`Color identity violation: ${entry.card.name} (${entry.card.colorIdentity.join('')}) is outside Commander color identity (${colorIdentity.join('') || 'C'}).`
				);
				break;
			}
		}

		if (!entry.card.legalCommander) {
			errors.push(`${entry.card.name} is banned or not legal in Commander.`);
		}
	}

	const totalCards = commanders.length + mainCount;
	if (totalCards !== 100) {
		errors.push(`Deck has ${totalCards} cards total (Commander requires exactly 100 cards including Commander).`);
	}

	return {
		isLegal: errors.length === 0,
		errors,
		colorIdentity,
		totalCards
	};
}

export const validateDeck = validateCommanderDeck;
