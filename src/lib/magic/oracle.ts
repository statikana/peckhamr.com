import type {
	LibrarySearchDestination,
	LibrarySearchSpec,
	ManaColor,
	ManaPool,
	ParsedActivatedAbility,
	ParsedEffect,
	ScryfallCard,
	StructuredTriggeredAbility,
	TargetKind,
	TargetRequirementInfo,
	TriggerCondition,
	TriggerScope
} from './types.ts';

import { replaceSelfReferences, stripReminderText } from './compiler/normalize.ts';

export type { ParsedActivatedAbility };

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

export function getCardRulesText(card: ScryfallCard): string {
	return card.oracleText || '';
}

export function getStackItemRulesText(item: { card: ScryfallCard; oracleText?: string }): string {
	return item.oracleText || item.card.oracleText || '';
}

export function getStackItemTargetRequirement(
	item: { kind: string; card: ScryfallCard; oracleText?: string },
	sourceCard?: ScryfallCard
): TargetRequirementInfo | null {
	const text = item.oracleText || '';
	if (item.kind !== 'spell' && item.kind !== 'activated' && !/\btarget\b/i.test(text)) {
		return null;
	}
	return item.kind === 'spell' && sourceCard
		? detectTargetRequirement(sourceCard.oracleText || '')
		: detectTargetRequirement(text);
}

export function cardEntersAsCopyOfAnyCreature(card: ScryfallCard): boolean {
	return /enter(?:s)? (?:the battlefield )?as a copy of any creature/i.test(card.oracleText || '');
}

export function spellExilesSelfOnResolution(card: ScryfallCard): boolean {
	return /exile\s+~|exile\s+teferi's protection|exile\s+time stop/i.test(card.oracleText || '');
}

export function getCardExtraLandPlays(card: ScryfallCard): number {
	const text = card.oracleText || '';
	const m = text.match(/\byou may play (an|one|two|three|four|\d+) additional lands?\b/i);
	if (!m) return 0;
	const word = m[1].toLowerCase();
	if (word === 'an' || word === 'one') return 1;
	if (word === 'two') return 2;
	if (word === 'three') return 3;
	if (word === 'four') return 4;
	return parseInt(word, 10) || 1;
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

export function getPermanentManaProduction(
	card: ScryfallCard,
	commanderIdentity: ManaColor[]
): {
	canTapForMana: boolean;
	colors: ManaColor[];
	amount: number;
} {
	const tLine = card.typeLine;
	const text = card.oracleText;
	// Strip parenthetical reminder text (e.g. Treasure token reminder text on Storm-Kiln Artist)
	const cleanText = text.replace(/\([^)]*\)/g, '');

	// Basic land types
	const landColors: ManaColor[] = [];
	if (tLine.includes('Plains')) landColors.push('W');
	if (tLine.includes('Island')) landColors.push('U');
	if (tLine.includes('Swamp')) landColors.push('B');
	if (tLine.includes('Mountain')) landColors.push('R');
	if (tLine.includes('Forest')) landColors.push('G');
	if (landColors.length > 0) {
		return { canTapForMana: true, colors: landColors, amount: 1 };
	}

	// Sol Ring or multi-colorless rocks
	if (cleanText.includes('{T}: Add {C}{C}{C}')) {
		return { canTapForMana: true, colors: ['C'], amount: 3 };
	}
	if (cleanText.includes('{T}: Add {C}{C}')) {
		return { canTapForMana: true, colors: ['C'], amount: 2 };
	}

	// Command Tower / Arcane Signet / Commander's Sphere / Chromatic Lantern (anchored so Exotic Orchard is not treated as unconditional)
	if (
		/\{T\}:\s*Add\s+one\s+mana\s+of\s+any\s+color\s*\.?$/im.test(cleanText) ||
		cleanText.toLowerCase().includes("commander's color identity")
	) {
		const cols: ManaColor[] =
			commanderIdentity.length > 0 ? commanderIdentity : ['W', 'U', 'B', 'R', 'G'];
		return { canTapForMana: true, colors: cols, amount: 1 };
	}

	// Explicit "{T}: Add {X}" where cost before ':' is only {T} (no mana/sacrifice/discard cost)
	for (const rawLine of cleanText.split('\n')) {
		const line = rawLine.trim();
		const tapManaMatch = line.match(/^\{T\}:\s*Add\s+((?:\{[WUBRGC]\}(?:\s*(?:,|or)\s*)?)+)/i);
		if (tapManaMatch) {
			const symStr = tapManaMatch[1];
			const syms = (symStr.match(/\{([WUBRGC])\}/gi) || []).map((s) =>
				s.slice(1, -1).toUpperCase()
			) as ManaColor[];
			const uniqueCols = Array.from(new Set(syms));
			const isOr = /or/i.test(symStr);
			return {
				canTapForMana: true,
				colors: uniqueCols.length > 0 ? uniqueCols : ['C'],
				amount: isOr ? 1 : syms.length || 1
			};
		}
		const dynManaMatch =
			line.match(/^\{T\}:\s*Add\s+\{([WUBRGC])\}\s+for\s+each\b/i) ||
			line.match(/^\{T\}:\s*Add\s+an\s+amount\s+of\s+\{([WUBRGC])\}/i);
		if (dynManaMatch) {
			const col = dynManaMatch[1].toUpperCase() as ManaColor;
			return { canTapForMana: true, colors: [col], amount: 1 };
		}
	}

	return { canTapForMana: false, colors: [], amount: 0 };
}

export function parseActivatedAbilities(
	card: ScryfallCard,
	commanderIdentity: ManaColor[]
): ParsedActivatedAbility[] {
	const abilities: ParsedActivatedAbility[] = [];
	const lines = card.oracleText.split('\n');

	// Check intrinsic mana production
	const manaProd = getPermanentManaProduction(card, commanderIdentity);
	if (manaProd.canTapForMana) {
		abilities.push({
			id: 'mana_tap',
			label: `Tap: Add ${manaProd.amount > 1 ? `${manaProd.amount}x ` : ''}${manaProd.colors.map((c) => `{${c}}`).join('/')}`,
			costText: '{T}',
			manaCost: '',
			requiresTap: true,
			requiresSacrificeSelf: false,
			lifeCost: 0,
			loyaltyCost: null,
			isManaAbility: true,
			producesMana: manaProd.colors,
			producesAmount: manaProd.amount,
			effectText: `Add ${manaProd.colors.map((c) => `{${c}}`).join(' or ')}`,
			requiresTarget: false,
			targetKind: 'none'
		});
	}

	lines.forEach((rawLine, idx) => {
		const line = rawLine.trim();
		if (!line) return;

		// Check Equipment "Equip {cost}" ability (e.g., "Equip {0}", "Equip {1}", "Equip—{2}")
		const equipMatch = line.match(/^Equip(?:\s+[a-zA-Z ]+)?\s*[—-]?\s*(\{[0-9WUBRGCX/]+\}(?:\{[0-9WUBRGCX/]+\})*)/i);
		if (equipMatch) {
			const equipCost = equipMatch[1];
			abilities.push({
				id: `equip_${idx}`,
				label: `Equip ${equipCost}: Attach to target creature you control`,
				costText: `Equip ${equipCost}`,
				manaCost: equipCost,
				requiresTap: false,
				requiresSacrificeSelf: false,
				lifeCost: 0,
				loyaltyCost: null,
				isManaAbility: false,
				sorcerySpeedOnly: true,
				producesMana: [],
				producesAmount: 0,
				effectText: 'Attach to target creature you control.',
				requiresTarget: true,
				targetKind: 'controlled_creature'
			});
			return;
		}

		if (!line.includes(':')) return;

		// Skip pure mana lines already captured
		if (/^\{T\}:\s*Add\s+/i.test(line) || /^\(\{T\}:\s*Add/i.test(line)) return;

		// Check Planeswalker loyalty ability: "+1: ...", "-2: ...", "0: ..."
		const loyaltyMatch = line.match(/^([+-−]?\d+):\s*(.+)$/);
		if (loyaltyMatch && card.typeLine.includes('Planeswalker')) {
			const lVal = parseInt(loyaltyMatch[1].replace('−', '-'), 10);
			const effectText = loyaltyMatch[2].trim();
			const targetInfo = detectTargetRequirement(effectText);
			abilities.push({
				id: `loyalty_${idx}`,
				label: `${lVal >= 0 ? `+${lVal}` : lVal}: ${effectText.slice(0, 48)}`,
				costText: `${lVal >= 0 ? `+${lVal}` : lVal}`,
				manaCost: '',
				requiresTap: false,
				requiresSacrificeSelf: false,
				lifeCost: 0,
				loyaltyCost: lVal,
				isManaAbility: false,
				sorcerySpeedOnly: true,
				producesMana: [],
				producesAmount: 0,
				effectText,
				requiresTarget: targetInfo.requiresTarget,
				targetKind: targetInfo.targetKind
			});
			return;
		}

		const colonIdx = line.indexOf(':');
		if (colonIdx <= 0) return;
		const costPart = line.slice(0, colonIdx).trim();
		const effectPart = line.slice(colonIdx + 1).trim();

		// Exclude keyword reminder lines like "Magecraft — Whenever..." or "Landfall —"
		if (/whenever|when |at the beginning/i.test(costPart)) return;

		const requiresTap = /\{T\}/i.test(costPart);
		const requiresSacrificeSelf = new RegExp(`sacrifice ${escapeRegex(card.name)}|sacrifice this`, 'i').test(
			costPart
		);
		const manaSymbols = (costPart.match(/\{[0-9WUBRGCX/]+\}/gi) || [])
			.filter((s) => s.toUpperCase() !== '{T}' && s.toUpperCase() !== '{Q}')
			.join('');

		const lifeMatch = costPart.match(/Pay (\d+) life/i);
		const lifeCost = lifeMatch ? parseInt(lifeMatch[1], 10) : 0;
		const sorcerySpeedOnly = /activate only as a sorcery|equip only as a sorcery/i.test(effectPart);

		const targetInfo = detectTargetRequirement(effectPart);
		// CR 605.1a: no target, adds mana, not a loyalty ability. Its cost can be more than {T}
		// ("{T}, Sacrifice this artifact: Add one mana of any color." on a Treasure).
		const manaEffect = targetInfo.requiresTarget ? null : parseManaEffect(effectPart, commanderIdentity);
		abilities.push({
			id: `act_${idx}`,
			label: `${costPart}: ${effectPart.slice(0, 45)}`,
			costText: costPart,
			manaCost: manaSymbols,
			requiresTap,
			requiresSacrificeSelf,
			lifeCost,
			loyaltyCost: null,
			isManaAbility: manaEffect !== null,
			sorcerySpeedOnly,
			producesMana: manaEffect?.colors ?? [],
			producesAmount: manaEffect?.amount ?? 0,
			effectText: effectPart,
			requiresTarget: targetInfo.requiresTarget,
			targetKind: targetInfo.targetKind
		});
	});

	return abilities;
}

/** The mana an "Add ..." effect produces, or null if the effect isn't (only) adding mana. */
function parseManaEffect(
	effectText: string,
	commanderIdentity: ManaColor[]
): { colors: ManaColor[]; amount: number } | null {
	const text = effectText.replace(/\([^)]*\)/g, '').trim();
	const anyColors: ManaColor[] = commanderIdentity.length > 0 ? commanderIdentity : ['W', 'U', 'B', 'R', 'G'];
	if (/^add one mana of any color(?: in your commander's color identity)?\.$/i.test(text)) {
		return { colors: anyColors, amount: 1 };
	}
	const anyOne = text.match(/^add (two|three) mana of any one color\.$/i);
	if (anyOne) return { colors: anyColors, amount: anyOne[1].toLowerCase() === 'two' ? 2 : 3 };
	const syms = (s: string) => (s.match(/\{([WUBRGC])\}/gi) || []).map((m) => m[1].toUpperCase() as ManaColor);
	if (/^add (?:\{[WUBRGC]\})+\.$/i.test(text)) {
		const all = syms(text);
		return { colors: Array.from(new Set(all)), amount: all.length };
	}
	if (/^add \{[WUBRGC]\}(?:, \{[WUBRGC]\})*,? or \{[WUBRGC]\}\.$/i.test(text)) {
		return { colors: Array.from(new Set(syms(text))), amount: 1 };
	}
	const dynamic = text.match(/^add (?:\{([WUBRGC])\} for each\b|an amount of \{([WUBRGC])\})/i);
	if (dynamic) return { colors: [(dynamic[1] ?? dynamic[2]).toUpperCase() as ManaColor], amount: 1 };
	return null;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WORD_NUMBERS: Record<string, number> = {
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
	ten: 10,
	eleven: 11,
	twelve: 12,
	thirteen: 13,
	twenty: 20,
	thirty: 30,
	forty: 40,
	fifty: 50,
	hundred: 100
};

function parseWordOrNumber(str: string | undefined, fallback = 1): number {
	if (!str) return fallback;
	const clean = str.trim().toLowerCase();
	if (WORD_NUMBERS[clean] !== undefined) return WORD_NUMBERS[clean];
	const n = parseInt(clean, 10);
	return isNaN(n) ? fallback : n;
}

export interface AdditionalCastRequirements {
	sacrificePermanentType: string | null;
	sacrificeAnother: boolean;
	discardCount: number;
	lifeCost: number;
	onlyDuringCombat: boolean;
	onlyDuringYourTurn: boolean;
	onlyBeforeAttackersDeclared: boolean;
}

export function parseAdditionalCostsAndRestrictions(
	cardOrText: ScryfallCard | string
): AdditionalCastRequirements {
	const rawText = typeof cardOrText === 'string' ? cardOrText : cardOrText.oracleText;
	const clean = rawText.replace(/\([^)]*\)/g, ' ');
	const low = clean.toLowerCase();

	let sacrificePermanentType: string | null = null;
	let sacrificeAnother = false;
	let discardCount = 0;
	let lifeCost = 0;

	const addCostMatch = low.match(/as an additional cost to cast this spell,\s*([^.]+)/i);
	if (addCostMatch) {
		const clause = addCostMatch[1];
		if (/sacrifice another creature/i.test(clause)) {
			sacrificePermanentType = 'Creature';
			sacrificeAnother = true;
		} else if (/sacrifice a creature/i.test(clause)) {
			sacrificePermanentType = 'Creature';
		} else if (/sacrifice an artifact/i.test(clause)) {
			sacrificePermanentType = 'Artifact';
		} else if (/sacrifice a land/i.test(clause)) {
			sacrificePermanentType = 'Land';
		} else if (/sacrifice an enchantment/i.test(clause)) {
			sacrificePermanentType = 'Enchantment';
		} else if (/sacrifice a permanent/i.test(clause)) {
			sacrificePermanentType = 'Permanent';
		}

		const discMatch = clause.match(/discard (a|an|one|two|three|four|\d+) cards?/i);
		if (discMatch) {
			discardCount = parseWordOrNumber(discMatch[1], 1);
		}

		const lifeMatch = clause.match(/pay (\d+) life/i);
		if (lifeMatch) {
			lifeCost = parseInt(lifeMatch[1], 10) || 0;
		}
	}

	const onlyDuringCombat = /cast this spell only during combat/i.test(low);
	const onlyDuringYourTurn = /cast this spell only during your turn/i.test(low);
	const onlyBeforeAttackersDeclared = /cast this spell only before attackers are declared/i.test(low);

	return {
		sacrificePermanentType,
		sacrificeAnother,
		discardCount,
		lifeCost,
		onlyDuringCombat,
		onlyDuringYourTurn,
		onlyBeforeAttackersDeclared
	};
}

function detectSingleClauseTarget(rawClause: string): TargetRequirementInfo {
	const clean = rawClause.replace(/\([^)]*\)/g, ' ');
	const low = clean.toLowerCase();

	if (!/\btarget\b/i.test(low)) {
		return {
			requiresTarget: false,
			targetKind: 'none',
			minTargets: 0,
			maxTargets: 0,
			zone: 'none',
			sameGraveyard: false,
			controllerFilter: 'any'
		};
	}

	const isUpTo = /\bup to (?:a|an|one|two|three|four|five|six|\d+) target\b/i.test(low);
	const countMatch = low.match(
		/\b(?:(one|two|three|four|five|six|\d+)\s+target\b|\btarget\s+(one|two|three|four|five|six|\d+)\b)/i
	);
	const parsedCount = countMatch
		? parseWordOrNumber(countMatch[1] || countMatch[2], 1)
		: 1;
	const minTargets = isUpTo ? 0 : parsedCount;
	const maxTargets = parsedCount;

	// 1. Check Graveyard targets (e.g. "target creature card from a graveyard", "you may target two cards in a graveyard")
	if (/\bgraveyards?\b/i.test(low)) {
		const isPluralGraveyards =
			/\b(?:in|from)\s+(?:any number of\s+)?graveyards\b/i.test(low) &&
			!/\b(?:single|same)\s+graveyard\b/i.test(low);
		const sameGraveyard = !isPluralGraveyards;

		let controllerFilter: 'any' | 'you' | 'opponent' = 'any';
		if (/\byour graveyard\b/i.test(low)) controllerFilter = 'you';
		else if (/\ban opponent's graveyard\b|\bopponents' graveyards\b/i.test(low)) {
			controllerFilter = 'opponent';
		}

		let cardTypeFilter: string | undefined;
		const beforeGraveyard = low.split(/graveyard/)[0] || low;
		if (/\binstant or sorcery cards?\b/i.test(beforeGraveyard)) {
			cardTypeFilter = 'InstantOrSorcery';
		} else if (/\bcreature cards?\b|\bcreatures?\b/i.test(beforeGraveyard)) {
			cardTypeFilter = 'Creature';
		} else if (/\bartifact cards?\b/i.test(beforeGraveyard)) {
			cardTypeFilter = 'Artifact';
		} else if (/\benchantment cards?\b/i.test(beforeGraveyard)) {
			cardTypeFilter = 'Enchantment';
		} else if (/\bland cards?\b/i.test(beforeGraveyard)) {
			cardTypeFilter = 'Land';
		} else if (/\bpermanent cards?\b/i.test(beforeGraveyard)) {
			cardTypeFilter = 'Permanent';
		} else if (/\bnonland cards?\b/i.test(beforeGraveyard)) {
			cardTypeFilter = 'NonlandPermanent';
		}

		return {
			requiresTarget: minTargets > 0,
			targetKind: 'graveyard_card',
			minTargets,
			maxTargets,
			zone: 'graveyard',
			sameGraveyard,
			controllerFilter,
			cardTypeFilter
		};
	}

	// 2. Check Stack / Spell targets (e.g. "target spell", "target noncreature spell", "target instant or sorcery spell")
	if (/\btarget\s+(?:[a-z]+\s+)*spells?\b/i.test(low)) {
		let controllerFilter: 'any' | 'you' | 'opponent' = 'any';
		if (/\byou don't control\b|\ban opponent controls\b/i.test(low)) {
			controllerFilter = 'opponent';
		} else if (/\byou control\b/i.test(low)) {
			controllerFilter = 'you';
		}

		let cardTypeFilter: string | undefined;
		if (/\btarget noncreature spells?\b/i.test(low)) {
			cardTypeFilter = 'Noncreature';
		} else if (/\btarget instant or sorcery spells?\b/i.test(low)) {
			cardTypeFilter = 'InstantOrSorcery';
		} else if (/\btarget creature spells?\b/i.test(low)) {
			cardTypeFilter = 'Creature';
		} else if (/\btarget artifact spells?\b/i.test(low)) {
			cardTypeFilter = 'Artifact';
		} else if (/\btarget enchantment spells?\b/i.test(low)) {
			cardTypeFilter = 'Enchantment';
		} else if (/\btarget instant spells?\b/i.test(low)) {
			cardTypeFilter = 'Instant';
		} else if (/\btarget sorcery spells?\b/i.test(low)) {
			cardTypeFilter = 'Sorcery';
		}

		return {
			requiresTarget: minTargets > 0,
			targetKind: 'spell',
			minTargets,
			maxTargets,
			zone: 'stack',
			sameGraveyard: false,
			controllerFilter,
			cardTypeFilter
		};
	}

	// 3. Check Any Target
	if (/\bany target\b/i.test(low)) {
		return {
			requiresTarget: minTargets > 0,
			targetKind: 'any',
			minTargets,
			maxTargets,
			zone: 'any',
			sameGraveyard: false,
			controllerFilter: 'any'
		};
	}

	// 4. Check Player / Opponent Target
	if (/\btarget players?\b|\btarget opponents?\b/i.test(low)) {
		const isOpponentOnly = /\btarget opponents?\b/i.test(low);
		return {
			requiresTarget: minTargets > 0,
			targetKind: 'player',
			minTargets,
			maxTargets,
			zone: 'player',
			sameGraveyard: false,
			controllerFilter: isOpponentOnly ? 'opponent' : 'any'
		};
	}

	// 5. Battlefield Permanent Targets
	let controllerFilter: 'any' | 'you' | 'opponent' = 'any';
	if (/\byou don't control\b|\ban opponent controls\b/i.test(low)) {
		controllerFilter = 'opponent';
	} else if (/\byou control\b/i.test(low)) {
		controllerFilter = 'you';
	}

	if (/\btarget creatures? you control\b/i.test(low)) {
		return {
			requiresTarget: minTargets > 0,
			targetKind: 'controlled_creature',
			minTargets,
			maxTargets,
			zone: 'battlefield',
			sameGraveyard: false,
			controllerFilter: 'you',
			cardTypeFilter: 'Creature'
		};
	}

	if (/\btarget artifact or enchantment\b/i.test(low)) {
		return {
			requiresTarget: minTargets > 0,
			targetKind: 'artifact_or_enchantment',
			minTargets,
			maxTargets,
			zone: 'battlefield',
			sameGraveyard: false,
			controllerFilter,
			cardTypeFilter: 'ArtifactOrEnchantment'
		};
	}

	if (/\btarget artifact or creature\b|\btarget creature or artifact\b/i.test(low)) {
		return {
			requiresTarget: minTargets > 0,
			targetKind: 'permanent',
			minTargets,
			maxTargets,
			zone: 'battlefield',
			sameGraveyard: false,
			controllerFilter,
			cardTypeFilter: 'ArtifactOrCreature'
		};
	}

	if (/\btarget creature or planeswalker\b/i.test(low)) {
		return {
			requiresTarget: minTargets > 0,
			targetKind: 'permanent',
			minTargets,
			maxTargets,
			zone: 'battlefield',
			sameGraveyard: false,
			controllerFilter,
			cardTypeFilter: 'CreatureOrPlaneswalker'
		};
	}

	if (/\btarget nonland permanents?\b/i.test(low)) {
		return {
			requiresTarget: minTargets > 0,
			targetKind: 'nonland_permanent',
			minTargets,
			maxTargets,
			zone: 'battlefield',
			sameGraveyard: false,
			controllerFilter,
			cardTypeFilter: 'NonlandPermanent'
		};
	}

	if (/\btarget creatures?\b|\btarget attacking creatures?\b|\btarget blocking creatures?\b/i.test(low)) {
		return {
			requiresTarget: minTargets > 0,
			targetKind: controllerFilter === 'you' ? 'controlled_creature' : 'creature',
			minTargets,
			maxTargets,
			zone: 'battlefield',
			sameGraveyard: false,
			controllerFilter,
			cardTypeFilter: 'Creature'
		};
	}

	if (/\btarget artifacts?\b/i.test(low)) {
		return {
			requiresTarget: minTargets > 0,
			targetKind: 'permanent',
			minTargets,
			maxTargets,
			zone: 'battlefield',
			sameGraveyard: false,
			controllerFilter,
			cardTypeFilter: 'Artifact'
		};
	}

	if (/\btarget enchantments?\b/i.test(low)) {
		return {
			requiresTarget: minTargets > 0,
			targetKind: 'permanent',
			minTargets,
			maxTargets,
			zone: 'battlefield',
			sameGraveyard: false,
			controllerFilter,
			cardTypeFilter: 'Enchantment'
		};
	}

	if (/\btarget planeswalkers?\b/i.test(low)) {
		return {
			requiresTarget: minTargets > 0,
			targetKind: 'permanent',
			minTargets,
			maxTargets,
			zone: 'battlefield',
			sameGraveyard: false,
			controllerFilter,
			cardTypeFilter: 'Planeswalker'
		};
	}

	if (/\btarget lands?\b/i.test(low)) {
		return {
			requiresTarget: minTargets > 0,
			targetKind: 'permanent',
			minTargets,
			maxTargets,
			zone: 'battlefield',
			sameGraveyard: false,
			controllerFilter,
			cardTypeFilter: 'Land'
		};
	}

	if (/\btarget permanents?\b/i.test(low)) {
		return {
			requiresTarget: minTargets > 0,
			targetKind: 'permanent',
			minTargets,
			maxTargets,
			zone: 'battlefield',
			sameGraveyard: false,
			controllerFilter,
			cardTypeFilter: 'Permanent'
		};
	}

	return {
		requiresTarget: minTargets > 0,
		targetKind: 'any',
		minTargets,
		maxTargets,
		zone: 'any',
		sameGraveyard: false,
		controllerFilter
	};
}

export function detectTargetRequirement(
	text: string,
	cardTypeLine?: string
): TargetRequirementInfo {
	// For permanent spells (non-Aura, non-Instant, non-Sorcery), casting the spell itself does not target on the stack
	if (cardTypeLine !== undefined) {
		const isInstantOrSorcery =
			cardTypeLine.includes('Instant') || cardTypeLine.includes('Sorcery');
		const isAura = cardTypeLine.includes('Aura');
		if (!isInstantOrSorcery && !isAura) {
			return {
				requiresTarget: false,
				targetKind: 'none',
				minTargets: 0,
				maxTargets: 0,
				zone: 'none',
				sameGraveyard: false,
				controllerFilter: 'any'
			};
		}
		if (isAura) {
			const clean = text.replace(/\([^)]*\)/g, ' ').toLowerCase();
			if (clean.includes('enchant creature you control')) {
				return detectSingleClauseTarget('target creature you control');
			}
			if (clean.includes('enchant permanent') || clean.includes('enchant creature, land')) {
				return detectSingleClauseTarget('target permanent');
			}
			if (clean.includes('enchant creature')) {
				return detectSingleClauseTarget('target creature');
			}
			if (clean.includes('enchant artifact')) {
				return detectSingleClauseTarget('target artifact');
			}
			if (clean.includes('enchant player')) {
				return detectSingleClauseTarget('target player');
			}
			return detectSingleClauseTarget('target permanent');
		}
	}

	const clean = text.replace(/\([^)]*\)/g, ' ');
	const low = clean.toLowerCase();

	// Handle modal spells ("Choose one —", "Choose one or more —")
	if (low.includes('choose one') && (clean.includes('•') || clean.includes('—'))) {
		const parts = clean
			.split(/•|\n/)
			.map((s) => s.trim())
			.filter((s) => s.length > 0 && !/choose one/i.test(s));
		if (parts.length > 0) {
			const branches = parts.map((p) => detectSingleClauseTarget(p));
			const firstTargeted = branches.find((b) => b.requiresTarget) || branches[0];
			return {
				...firstTargeted,
				isModal: true,
				modalBranches: branches
			};
		}
	}

	return detectSingleClauseTarget(clean);
}

export function parseSpellOrAbilityEffects(
	card: ScryfallCard,
	overrideText?: string
): {
	effects: ParsedEffect[];
	requiresTarget: boolean;
	targetKind: TargetKind;
	targetInfo: TargetRequirementInfo;
	requiresGuidedResolution: boolean;
} {
	const rawInput = overrideText ?? card.oracleText;
	const effects: ParsedEffect[] = [];

	const targetInfo = detectTargetRequirement(
		rawInput,
		overrideText === undefined ? card.typeLine : undefined
	);

	const isInstantOrSorcery =
		card.typeLine.includes('Instant') || card.typeLine.includes('Sorcery');

	// CRITICAL RULE (CR 608.3): When casting a Permanent spell (Creature, Artifact, Enchantment,
	// Planeswalker, Battle — i.e., overrideText === undefined and not an Instant/Sorcery), resolving
	// the permanent spell on the Stack simply puts it onto the battlefield. It must NEVER execute its
	// activated abilities (e.g., Lathril's "{T}, Tap ten untapped Elves: Each opponent loses 10 life...")
	// or triggered abilities as spell-resolution effects on cast!
	if (overrideText === undefined && !isInstantOrSorcery) {
		return {
			effects: [],
			requiresTarget: targetInfo.requiresTarget,
			targetKind: targetInfo.targetKind,
			targetInfo,
			requiresGuidedResolution: false
		};
	}

	// Strip reminder text and, when parsing a spell's own cast text (overrideText === undefined),
	// strip any activated ability lines (e.g. Cycling) or triggered ability lines.
	const rawText =
		overrideText === undefined
			? rawInput
					.replace(/\([^)]*\)/g, ' ')
					.split('\n')
					.filter((line) => {
						const trimmed = line.trim();
						if (!trimmed) return false;
						if (/^(?:cycling|equip|reinforce|channel|forecast|transmute|unearth|ninjutsu|encore)\b/i.test(trimmed)) {
							return false;
						}
						if (/^(?:when|whenever|at the beginning)\b/i.test(trimmed)) {
							return false;
						}
						const colonIdx = trimmed.indexOf(':');
						if (colonIdx > 0 && colonIdx < 65 && !/^choose\b/i.test(trimmed)) {
							return false;
						}
						return true;
					})
					.join('\n')
			: rawInput.replace(/\([^)]*\)/g, ' ');
	const low = rawText.toLowerCase();

	// 0. Equip attachment
	if (low.includes('attach to target creature you control')) {
		effects.push({ kind: 'equip_target', amount: 1 });
	}

	// 1. Counter target spell
	if (low.includes('counter target') && low.includes('spell')) {
		effects.push({ kind: 'counter_target_spell', amount: 1 });
	}

	// 2. Scry X or Look at top X and put them back in any order (e.g., Ponder)
	const scryMatch = low.match(/scry (\d+|one|two|three|four)/i);
	if (scryMatch) {
		effects.push({ kind: 'scry', amount: parseWordOrNumber(scryMatch[1], 1) });
	}
	const rearrangeMatch = low.match(
		/look at the top (\d+|one|two|three|four|five) cards of your library,\s*then put them back in any order/i
	);
	if (rearrangeMatch) {
		effects.push({
			kind: 'rearrange_top',
			amount: parseWordOrNumber(rearrangeMatch[1], 3),
			mayShuffle: low.includes('you may shuffle')
		});
	}

	// 3. Draw X cards
	const drawMatch = low.match(/(?:target player )?draws? (a|one|two|three|four|five|\d+) cards?/i);
	if (drawMatch && !low.includes('whenever') && !low.includes('may draw a card unless')) {
		effects.push({ kind: 'draw', amount: parseWordOrNumber(drawMatch[1], 1) });
	}

	// 4. Destroy all creatures / board wipes
	if (
		low.includes('destroy all creatures') ||
		low.includes('exile all creatures')
	) {
		effects.push({ kind: 'destroy_all_creatures', amount: 1 });
	} else if (low.includes('destroy target')) {
		effects.push({ kind: 'destroy_target', amount: 1 });
	}

	// 5. Exile target / Exile all graveyards
	if (low.includes('exile target') && !low.includes('exile all')) {
		effects.push({ kind: 'exile_target', amount: 1 });
	}
	if (/\bexile all graveyards\b/i.test(low) && overrideText !== undefined) {
		effects.push({ kind: 'exile_all_graveyards', amount: 1 });
	}

	// 6. Return target to hand (Bounce)
	if (low.includes('return target') && low.includes("owner's hand")) {
		effects.push({ kind: 'bounce_target', amount: 1 });
	}

	// 7. Damage to any target / target creature / each creature / each opponent
	const dmgAllMatch = low.match(/deals (\d+) damage to each creature/i);
	if (dmgAllMatch) {
		effects.push({ kind: 'damage_all_creatures', amount: parseInt(dmgAllMatch[1], 10) });
	}
	const dmgOppMatch = low.match(/deals (\d+) damage to each opponent/i);
	if (dmgOppMatch && !low.includes('whenever')) {
		effects.push({ kind: 'damage_each_opponent', amount: parseInt(dmgOppMatch[1], 10) });
	}
	if (/deals damage equal to that creature's power to any target/i.test(low) && !low.includes('whenever')) {
		effects.push({
			kind: 'damage_each_opponent',
			amount: 1,
			dynamicFormula: 'entered_power'
		});
	}
	const dmgTargetMatch = low.match(/deals (\d+) damage to (?:any target|target creature|target player)/i);
	if (dmgTargetMatch && !low.includes('whenever')) {
		effects.push({ kind: 'damage_target', amount: parseInt(dmgTargetMatch[1], 10) });
	}

	// 8. Life gain / loss
	if (/its controller gains life equal to its power/i.test(low)) {
		effects.push({
			kind: 'gain_life',
			amount: 0,
			dynamicFormula: 'target_power',
			recipient: 'target_controller'
		});
	}
	const gainLifeMatch = low.match(/gain (\d+) life/i);
	if (gainLifeMatch) {
		effects.push({ kind: 'gain_life', amount: parseInt(gainLifeMatch[1], 10) });
	}
	const loseLifeSelfMatch = low.match(/(?:you|you draw \w+ cards? and) lose (\d+) life/i);
	if (loseLifeSelfMatch) {
		effects.push({ kind: 'gain_life', amount: -parseInt(loseLifeSelfMatch[1], 10) });
	}
	const oppLoseMatch = low.match(/each opponent loses (\d+) life/i);
	if (oppLoseMatch) {
		effects.push({ kind: 'lose_life_opponents', amount: parseInt(oppLoseMatch[1], 10) });
	}
	const loseSubtypeCountMatch = low.match(
		/(?:target opponent|each opponent) loses life equal to the number of ([a-z]+) you control/i
	);
	if (loseSubtypeCountMatch && !low.includes('whenever')) {
		let rawSub = loseSubtypeCountMatch[1].toLowerCase();
		if (rawSub === 'elves') rawSub = 'elf';
		else if (rawSub.endsWith('s')) rawSub = rawSub.slice(0, -1);
		const subtype = rawSub.charAt(0).toUpperCase() + rawSub.slice(1);
		effects.push({
			kind: 'lose_life_opponents',
			amount: 1,
			dynamicFormula: `count_subtype:${subtype}`
		});
	}

	// 9. Search library (general grammar-driven LibrarySearchSpec parser)
	if (low.includes('search your library') || low.includes('search their library')) {
		const searchSpec = parseLibrarySearchSpec(rawText);
		if (searchSpec) {
			const isTargetControllerSearch =
				/its controller (?:may )?search(?:es)? their library/i.test(low);
			const recipient = isTargetControllerSearch ? 'target_controller' : undefined;
			const firstDest = searchSpec.destinations[0];
			if (firstDest?.zone === 'battlefield') {
				effects.push({
					kind: 'search_land_to_battlefield',
					amount: searchSpec.count,
					tapped: firstDest.tapped,
					searchSpec,
					recipient
				});
			} else {
				effects.push({
					kind: 'search_library_to_hand',
					amount: searchSpec.count,
					searchSpec,
					recipient
				});
			}
		}
	}

	// 10. Create tokens
	const tokenMatch = rawText.match(
		/creates? (a|one|two|three|four|that many|\d+) (\d+)\/(\d+) ([a-zA-Z ,]+?) creature tokens?(?: with ([a-zA-Z ,]+))?/i
	);
	if (tokenMatch && !low.includes('whenever')) {
		const isThatMany = tokenMatch[1].toLowerCase() === 'that many';
		const count = isThatMany ? 1 : parseWordOrNumber(tokenMatch[1], 1);
		const power = parseInt(tokenMatch[2], 10);
		const toughness = parseInt(tokenMatch[3], 10);
		const desc = tokenMatch[4].trim();
		const kwRaw = tokenMatch[5] ? tokenMatch[5].trim() : '';
		const isTargetControllerToken = /its controller creates/i.test(low);
		effects.push({
			kind: 'create_token',
			amount: count,
			tokenSpec: buildTokenSpec(power, toughness, desc, kwRaw),
			dynamicFormula: isThatMany ? 'combat_damage_dealt' : undefined,
			recipient: isTargetControllerToken ? 'target_controller' : undefined
		});
	} else if (low.includes('create a treasure token') && !low.includes('whenever')) {
		effects.push({
			kind: 'create_token',
			amount: 1,
			tokenSpec: {
				name: 'Treasure',
				power: 0,
				toughness: 0,
				colors: [],
				typeLine: 'Token Artifact — Treasure',
				keywords: []
			}
		});
	} else if (/create a token that's a copy of it/i.test(low) && !low.includes('whenever')) {
		effects.push({
			kind: 'copy_target_permanent',
			amount: 1
		});
	}

	// 11. Proliferate
	if (low.includes('proliferate') && !low.includes('whenever') && !low.includes('at the beginning')) {
		effects.push({ kind: 'proliferate', amount: 1 });
	}

	// 12. Put +1/+1 counters
	const cNameLow = card.name.toLowerCase();
	const cShortLow = cNameLow.split(',')[0].trim();
	const selfCounterRe = new RegExp(
		`put (a|one|two|three|four|\\d+) \\+1\\/\\+1 counters? on (?:it|this creature|${escapeRegex(cNameLow)}|${escapeRegex(cShortLow)})(?:$|[^a-z])`,
		'i'
	);
	const selfCounterMatch = low.match(selfCounterRe);
	if (low.includes('put a +1/+1 counter on each creature you control')) {
		effects.push({ kind: 'add_counters_team', amount: 1, counterType: '+1/+1' });
	} else if (low.includes('put a +1/+1 counter on target creature')) {
		effects.push({ kind: 'add_counters_target', amount: 1, counterType: '+1/+1' });
	} else if (selfCounterMatch && !low.includes('whenever')) {
		effects.push({
			kind: 'add_counters_self',
			amount: parseWordOrNumber(selfCounterMatch[1], 1),
			counterType: '+1/+1'
		});
	}

	// 13. Pump team, self, or target until end of turn
	const pumpTeamMatch = low.match(
		/creatures you control (?:gain ([a-z ]+?) and )?get \+(\d+|x)\/\+(\d+|x) until end of turn/i
	);
	if (pumpTeamMatch) {
		const rawGrant = pumpTeamMatch[1]?.trim().toLowerCase();
		const grantedKeyword =
			rawGrant === 'trample'
				? 'Trample'
				: rawGrant
					? rawGrant.charAt(0).toUpperCase() + rawGrant.slice(1)
					: undefined;
		const isX =
			pumpTeamMatch[2].toLowerCase() === 'x' ||
			low.includes('where x is the number of creatures you control');
		effects.push({
			kind: 'pump_team_eot',
			amount: isX ? 1 : parseInt(pumpTeamMatch[2], 10),
			toughnessAmount: isX ? 1 : parseInt(pumpTeamMatch[3], 10),
			dynamicFormula: isX ? 'count_subtype:Creature' : undefined,
			grantedKeyword
		});
	}
	const selfPumpRe = new RegExp(
		`(?:this creature|${escapeRegex(cNameLow)}|${escapeRegex(cShortLow)}) gets \\+(\\d+)\\/\\+(\\d+) until end of turn`,
		'i'
	);
	const selfPumpMatch = low.match(selfPumpRe);
	if (selfPumpMatch && !low.includes('whenever')) {
		effects.push({
			kind: 'pump_self_eot',
			amount: parseInt(selfPumpMatch[1], 10),
			toughnessAmount: parseInt(selfPumpMatch[2], 10)
		});
	}
	const grantKwTargetMatch = low.match(
		/\bit gains (double strike|first strike|trample|flying|haste|lifelink|deathtouch|vigilance|indestructible|hexproof) until end of turn/i
	);
	if (grantKwTargetMatch && !low.includes('whenever')) {
		const rawKw = grantKwTargetMatch[1].toLowerCase();
		const grantedKeyword = rawKw.charAt(0).toUpperCase() + rawKw.slice(1);
		effects.push({
			kind: 'grant_keyword_target_eot',
			amount: 1,
			grantedKeyword
		});
	}

	// 14. Ritual mana (e.g., Jeska's Will)
	const ritualMatch = rawText.match(/Add (\{[WUBRGC]\}(?:\{[WUBRGC]\})+)/);
	if (ritualMatch && (card.typeLine.includes('Instant') || card.typeLine.includes('Sorcery'))) {
		const syms = (ritualMatch[1].match(/\{([WUBRGC])\}/g) || []).map((s) =>
			s.slice(1, -1)
		) as ManaColor[];
		if (syms.length > 0) {
			effects.push({ kind: 'add_mana', amount: syms.length, manaColors: syms });
		}
	}

	// 15. Reanimate from graveyard / Return from graveyard to hand
	if (low.includes('return the top creature card of your graveyard to the battlefield')) {
		effects.push({
			kind: 'reanimate_target',
			amount: 1,
			dynamicFormula: 'top_creature_of_graveyard'
		});
	} else if (
		low.includes('from a graveyard onto the battlefield') ||
		low.includes('from your graveyard onto the battlefield')
	) {
		effects.push({ kind: 'reanimate_target', amount: 1 });
	} else if (
		overrideText !== undefined &&
		/return target (?:[a-z]+ )?card from your graveyard to your hand/i.test(low)
	) {
		effects.push({ kind: 'return_from_graveyard_to_hand', amount: 1 });
	}

	// 16. Premature Turn Ending (Obeka, Sundial of the Infinite, Time Stop — CR 721)
	if (low.includes('the player whose turn it is may end the turn')) {
		effects.push({ kind: 'may_end_the_turn', amount: 1 });
	} else if (/\bend the turn\b/i.test(low)) {
		effects.push({ kind: 'end_the_turn', amount: 1 });
	}

	// 17. Extra Turns (Time Warp, Final Fortune — CR 500.7)
	if (/\b(?:take|takes) an extra turn after this one\b/i.test(low)) {
		effects.push({ kind: 'extra_turn', amount: 1 });
	}

	// 18. Phasing (Teferi's Protection, Slip Out the Back — CR 702.26)
	if (low.includes('all permanents you control phase out')) {
		effects.push({ kind: 'phase_out_team', amount: 1 });
	} else if (/\bphases? out\b/i.test(low)) {
		effects.push({ kind: 'phase_out_target', amount: 1 });
	}

	// 19. Layer 7d Power/Toughness Switching (Inside Out, Twisted Image — CR 613.4d)
	if (/\bswitch (?:target creature's|its) power and toughness\b/i.test(low)) {
		effects.push({ kind: 'switch_pt_target', amount: 1 });
	}

	// 20. Win / Lose the Game effects (Thassa's Oracle, Felidar Sovereign)
	if (/\byou win the game\b/i.test(low) && !low.includes('instead')) {
		const isDevotionBlue =
			/greater than or equal to the number of cards in your library,\s*you win the game/i.test(
				low
			);
		effects.push({
			kind: 'win_the_game',
			amount: 1,
			dynamicFormula: isDevotionBlue ? 'devotion_blue_gte_library' : undefined
		});
	}
	if (
		/\byou lose the game\b/i.test(low) &&
		!low.includes("can't lose the game") &&
		!low.includes('at the beginning of')
	) {
		effects.push({ kind: 'lose_the_game_self', amount: 1 });
	}

	// 21. Return self from graveyard (Nether Shadow)
	if (
		low.includes(`put ${cNameLow} onto the battlefield`) ||
		low.includes(`return ${cNameLow} from your graveyard to the battlefield`) ||
		low.includes('put this card onto the battlefield') ||
		low.includes('return this card from your graveyard to the battlefield')
	) {
		effects.push({ kind: 'return_self_from_graveyard', amount: 1 });
	}

	const requiresGuidedResolution = isInstantOrSorcery && effects.length === 0 && rawText.trim().length > 0;

	return {
		effects,
		requiresTarget: targetInfo.requiresTarget,
		targetKind: targetInfo.targetKind,
		targetInfo,
		requiresGuidedResolution
	};
}

export function parseSuspendClause(
	card: ScryfallCard
): { timeCounters: number; suspendCost: string; cost: string } | null {
	const m = card.oracleText.replace(/\([^)]*\)/g, '').match(/Suspend\s+(\d+)\s*[—\-]\s*(\{[^\n]+)/i);
	if (!m) return null;
	const timeCounters = Math.max(1, parseInt(m[1], 10) || 1);
	const suspendCost = (m[2].match(/\{[^}]+\}/g) || []).join('') || '{1}';
	return { timeCounters, suspendCost, cost: suspendCost };
}

export function parseDelayedTriggersFromSpell(card: ScryfallCard): Array<{
	triggerPhase: 'end_step' | 'upkeep';
	title: string;
	oracleText: string;
	description: string;
	forNextTurnOfController?: boolean;
	effects: ParsedEffect[];
}> {
	const out: Array<{
		triggerPhase: 'end_step' | 'upkeep';
		title: string;
		oracleText: string;
		description: string;
		forNextTurnOfController?: boolean;
		effects: ParsedEffect[];
	}> = [];
	const low = card.oracleText.toLowerCase();

	if (low.includes("at the beginning of that turn's end step, you lose the game") ||
		low.includes('at the beginning of the next end step, you lose the game')) {
		out.push({
			triggerPhase: 'end_step',
			title: `${card.name} — Delayed End Step Trigger`,
			oracleText: 'At the beginning of the end step, you lose the game.',
			description: 'At the beginning of the end step, you lose the game.',
			forNextTurnOfController: low.includes("that turn's end step"),
			effects: [{ kind: 'lose_the_game_self', amount: 1 }]
		});
	}

	if (low.includes('exile it at the beginning of the next end step')) {
		out.push({
			triggerPhase: 'end_step',
			title: `${card.name} — Delayed Exile Trigger`,
			oracleText: 'At the beginning of the next end step, exile the returned creature.',
			description: 'At the beginning of the next end step, exile the returned creature.',
			effects: [{ kind: 'exile_target', amount: 1 }]
		});
	}

	return out;
}

export function buildTokenSpec(
	power: number,
	toughness: number,
	desc: string,
	kwRaw: string
): NonNullable<ParsedEffect['tokenSpec']> {
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

export function parseTriggerCondition(rawCondition: string): TriggerCondition {
	const clean = rawCondition.trim().replace(/\.$/, '').toLowerCase();

	// 1. "if you have <N> or more life"
	const lifeMatch = clean.match(/^if you have (\w+|\d+) or more life$/i);
	if (lifeMatch) {
		return {
			kind: 'life_at_least',
			amount: parseWordOrNumber(lifeMatch[1], 40)
		};
	}

	// 2. "if you control <N> or more <type>s"
	const controlsMatch = clean.match(/^if you control (\w+|\d+) or more ([a-z]+)$/i);
	if (controlsMatch) {
		const count = parseWordOrNumber(controlsMatch[1], 1);
		let rawType = controlsMatch[2].toLowerCase();
		if (rawType.endsWith('s') && rawType !== 'plains') {
			rawType = rawType.slice(0, -1);
		}
		const cardType = rawType.charAt(0).toUpperCase() + rawType.slice(1);
		return {
			kind: 'controls_count_at_least',
			count,
			cardType
		};
	}

	// 3. "if <~> is in your graveyard with <N> or more creature cards above it"
	const graveMatch = clean.match(
		/^if .+ is in your graveyard with (\w+|\d+) or more creature cards above it$/i
	);
	if (graveMatch) {
		return {
			kind: 'graveyard_creatures_above_at_least',
			count: parseWordOrNumber(graveMatch[1], 3)
		};
	}

	return {
		kind: 'unrecognized',
		raw: rawCondition.trim()
	};
}

export function parseStructuredTriggeredAbilities(
	card: ScryfallCard,
	triggerType: 'etb' | 'attack' | 'dies' | 'upkeep' | 'end_step'
): StructuredTriggeredAbility[] {
	const nameLow = card.name.toLowerCase();
	const shortName = nameLow.split(',')[0].trim();
	const lines = card.oracleText.split('\n');
	const out: StructuredTriggeredAbility[] = [];

	for (const rawLine of lines) {
		const line = rawLine.trim();
		const low = line.toLowerCase();
		if (!low.includes(',')) continue;

		let matchesTrigger = false;
		let scope: TriggerScope = 'each_turn';

		if (triggerType === 'etb') {
			matchesTrigger =
				(low.startsWith('when ') || low.startsWith('whenever ')) &&
				(low.includes(`${nameLow} enters`) ||
					low.includes(`${shortName} enters`) ||
					/\bthis (?:creature|permanent|enchantment|aura|artifact|land|equipment|vehicle) enters\b/.test(low));
		} else if (triggerType === 'attack') {
			matchesTrigger =
				low.startsWith('whenever ') &&
				(low.includes(`${nameLow} attacks`) ||
					low.includes(`${shortName} attacks`) ||
					low.includes('this creature attacks'));
		} else if (triggerType === 'dies') {
			matchesTrigger =
				(low.startsWith('when ') || low.startsWith('whenever ')) &&
				(low.includes(`${nameLow} dies`) ||
					low.includes(`${shortName} dies`) ||
					low.includes('this creature dies'));
		} else if (triggerType === 'upkeep') {
			if (low.startsWith('at the beginning of your upkeep')) {
				matchesTrigger = true;
				scope = 'controller_turn';
			} else if (
				low.startsWith('at the beginning of each upkeep') ||
				low.startsWith('at the beginning of the upkeep')
			) {
				matchesTrigger = true;
				scope = 'each_turn';
			} else if (
				low.startsWith("at the beginning of each opponent's upkeep") ||
				low.startsWith("at the beginning of each other player's upkeep")
			) {
				matchesTrigger = true;
				scope = 'opponent_turn';
			}
		} else if (triggerType === 'end_step') {
			if (low.startsWith('at the beginning of your end step')) {
				matchesTrigger = true;
				scope = 'controller_turn';
			} else if (
				low.startsWith('at the beginning of each end step') ||
				low.startsWith('at the beginning of the end step')
			) {
				matchesTrigger = true;
				scope = 'each_turn';
			} else if (
				low.startsWith("at the beginning of each opponent's end step") ||
				low.startsWith("at the beginning of each other player's end step")
			) {
				matchesTrigger = true;
				scope = 'opponent_turn';
			}
		}

		if (matchesTrigger) {
			const commaIdx = line.indexOf(',');
			let effectClause = line.slice(commaIdx + 1).trim();
			let condition: TriggerCondition | undefined;

			// CR 603.4 Intervening-if clause: "When/Whenever/At [event], if [condition], [effect]."
			if (/^if\b/i.test(effectClause)) {
				const condCommaIdx = effectClause.indexOf(',');
				if (condCommaIdx < 0) {
					continue;
				}
				const condRaw = effectClause.slice(0, condCommaIdx).trim();
				effectClause = effectClause.slice(condCommaIdx + 1).trim();
				condition = parseTriggerCondition(condRaw);
				// Never fire a conditional trigger whose condition is not recognized
				if (condition.kind === 'unrecognized') {
					continue;
				}
			}

			const effects: ParsedEffect[] = [];
			if (
				effectClause.toLowerCase().includes(`sacrifice ${nameLow}`) ||
				effectClause.toLowerCase().includes(`sacrifice ${shortName}`) ||
				/sacrifice this (?:creature|permanent|artifact|enchantment)/i.test(effectClause)
			) {
				effects.push({ kind: 'sacrifice_self', amount: 1 });
			} else {
				const parsed = parseSpellOrAbilityEffects(card, effectClause);
				if (!parsed.requiresTarget || triggerType === 'etb') {
					effects.push(...parsed.effects);
				}
			}

			if (effects.length > 0) {
				out.push({
					scope,
					condition,
					effects,
					clause: line
				});
			}
		}
	}

	return out;
}

export function parseTriggeredEffects(
	card: ScryfallCard,
	triggerType: 'etb' | 'attack' | 'dies' | 'upkeep' | 'end_step'
): ParsedEffect[] {
	const structured = parseStructuredTriggeredAbilities(card, triggerType);
	const out: ParsedEffect[] = [];
	for (const ab of structured) {
		if (!ab.condition) {
			out.push(...ab.effects);
		}
	}
	return out;
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

/**
 * "~ enters tapped." Phase 7 replaces this with a replacement effect compiled into the IR. Reminder
 * text is ignored and self-references are normalised, so "This land enters tapped." matches too.
 */
export { cardEntersTapped } from './runtime/replace.ts';

/**
 * Printed "can't be blocked" text, ignoring reminder text such as Menace's "can't be blocked except
 * by two or more creatures". Phase 9 replaces this with an evaluated static ability.
 */
export function cardHasPrintedUnblockable(card: ScryfallCard): boolean {
	return stripReminderText(card.oracleText).toLowerCase().includes("can't be blocked");
}
