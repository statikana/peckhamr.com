/**
 * Frozen copy of the pre-cache (Phase 6a) layer evaluation code from ruleTree.ts, kept verbatim as a
 * reference implementation. layerCache.test.ts compares the cached evaluation against it on mutated
 * boards. It's a .test.ts file only so the architecture ratchet treats it as test code; delete it in
 * Phase 6 proper once the layer engine is rewritten (its oracle-text reads are intentional).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CardInstance, GameState, ScryfallCard } from '../types.ts';
import type { AttributedKeywordOrEffect, CardContinuousBreakdown, EvaluatedPermanent } from '../ruleTree.ts';

const CANONICAL_COMBAT_KEYWORDS: Array<{ key: string; label: string; regex: RegExp }> = [
	{ key: 'flying', label: 'Flying', regex: /\bflying\b/i },
	{ key: 'first strike', label: 'First strike', regex: /\bfirst strike\b/i },
	{ key: 'double strike', label: 'Double strike', regex: /\bdouble strike\b/i },
	{ key: 'deathtouch', label: 'Deathtouch', regex: /\bdeathtouch\b/i },
	{ key: 'defender', label: 'Defender', regex: /\bdefender\b/i },
	{ key: 'flash', label: 'Flash', regex: /\bflash\b/i },
	{ key: 'haste', label: 'Haste', regex: /\bhaste\b/i },
	{ key: 'hexproof', label: 'Hexproof', regex: /\bhexproof\b/i },
	{ key: 'indestructible', label: 'Indestructible', regex: /\bindestructible\b/i },
	{ key: 'infect', label: 'Infect', regex: /\binfect\b/i },
	{ key: 'lifelink', label: 'Lifelink', regex: /\blifelink\b/i },
	{ key: 'menace', label: 'Menace', regex: /\bmenace\b/i },
	{ key: 'reach', label: 'Reach', regex: /\breach\b/i },
	{ key: 'shroud', label: 'Shroud', regex: /\bshroud\b/i },
	{ key: 'trample', label: 'Trample', regex: /\btrample\b/i },
	{ key: 'vigilance', label: 'Vigilance', regex: /\bvigilance\b/i },
	{ key: 'changeling', label: 'Changeling', regex: /\bchangeling\b/i },
	{ key: 'evolve', label: 'Evolve', regex: /\bevolve\b/i },
	{ key: 'cascade', label: 'Cascade', regex: /\bcascade\b/i }
];

export function extractSelfInnateKeywordsAndAbilities(card: ScryfallCard): Array<{
	canonicalKey: string;
	name: string;
	kind: 'keyword' | 'ability';
}> {
	const results: Array<{ canonicalKey: string; name: string; kind: 'keyword' | 'ability' }> = [];
	const seenKeys = new Set<string>();

	const addResult = (canonicalKey: string, name: string, kind: 'keyword' | 'ability') => {
		const k = canonicalKey.toLowerCase();
		if (seenKeys.has(k)) return;
		seenKeys.add(k);
		results.push({ canonicalKey: k, name, kind });
	};

	const lines = (card.oracleText || '')
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);

	const isEquipment = card.typeLine.includes('Equipment');
	const isAura = card.typeLine.includes('Aura');

	// 1. Scan lines that grant innate keywords to the card itself (not "equipped creature has..." or "other creatures you control have...")
	for (const line of lines) {
		const low = line.toLowerCase();
		const isGrantingToOthers =
			low.startsWith('equipped ') ||
			low.startsWith('enchanted ') ||
			low.startsWith('creatures ') ||
			low.startsWith('other ') ||
			low.startsWith('you, ') ||
			low.startsWith('all ') ||
			low.startsWith('each ') ||
			low.startsWith('whenever ') ||
			low.startsWith('when ') ||
			low.startsWith('at the beginning ') ||
			low.includes('opponents control lose') ||
			low.includes('target creature gains') ||
			low.includes('it gains ');

		if (!isGrantingToOthers && !low.includes(':')) {
			for (const kw of CANONICAL_COMBAT_KEYWORDS) {
				if (kw.regex.test(line)) {
					addResult(kw.key, kw.label, 'keyword');
				}
			}

			const wardMatch = line.match(/\bward\s*(\{[^}]+\}|\d+)?/i);
			if (wardMatch) {
				const wardCost = wardMatch[1] ? ` ${wardMatch[1]}` : '';
				addResult('ward', `Ward${wardCost}`, 'keyword');
			}

			const protMatch = line.match(/\b(protection from [a-z ,]+?)(?:[.\n]|$)/i);
			if (protMatch) {
				const label =
					protMatch[1].charAt(0).toUpperCase() + protMatch[1].slice(1).trim();
				addResult('protection', label, 'keyword');
			}

			if (/this spell can't be countered/i.test(line)) {
				addResult("can't be countered", "Can't be countered", 'keyword');
			}
			if (/can't be blocked/i.test(line) && !low.startsWith('except')) {
				addResult('unblockable', 'Unblockable', 'keyword');
			}
		}

		// Equip keyword on Equipment
		const equipMatch = line.match(/^equip\s+(\{[^}]+\}|\d+)/i);
		if (equipMatch) {
			addResult('equip', `Equip ${equipMatch[1]}`, 'keyword');
		}

		// Enchant keyword on Auras
		const enchantMatch = line.match(/^enchant\s+([a-z ,]+)/i);
		if (enchantMatch && isAura) {
			addResult('enchant', `Enchant ${enchantMatch[1]}`, 'keyword');
		}
	}

	// Also check card.keywords for keywords that belong to the card itself (filtering out keywords that only appear in "Equipped/Enchanted/Other creatures" clauses)
	for (const rawKw of card.keywords || []) {
		const kwLow = rawKw.toLowerCase();
		if (seenKeys.has(kwLow)) continue;
		if (kwLow === 'equip' || kwLow === 'enchant') continue;

		// If this is an Equipment or Aura (and not a Creature), keywords like Haste/Shroud/Trample in `card.keywords` are for the equipped/enchanted permanent unless stated otherwise
		if ((isEquipment || isAura) && !card.typeLine.includes('Creature') && kwLow !== 'flash' && kwLow !== 'indestructible') {
			continue;
		}

		// Verify the keyword isn't exclusively inside a clause granting it to other permanents
		const matchingLines = lines.filter((l) => l.toLowerCase().includes(kwLow));
		const onlyGrantsToOthers =
			matchingLines.length > 0 &&
			matchingLines.every((l) => {
				const ll = l.toLowerCase();
				return (
					ll.includes('other creatures') ||
					ll.includes('creatures you control') ||
					ll.includes('permanents you control') ||
					ll.includes('equipped creature') ||
					ll.includes('enchanted creature') ||
					ll.includes('it gains ') ||
					ll.includes('opponents control lose')
				);
			});
		if (!onlyGrantsToOthers) {
			addResult(kwLow, rawKw, 'keyword');
		}
	}

	// 2. Summarize innate abilities on the card
	for (const line of lines) {
		const low = line.toLowerCase();
		if (low.startsWith('eminence')) {
			addResult('ability_eminence', 'Eminence Ability', 'ability');
		} else if (low.startsWith('landfall')) {
			addResult('ability_landfall', 'Landfall Trigger', 'ability');
		} else if (low.startsWith('magecraft')) {
			addResult('ability_magecraft', 'Magecraft Trigger', 'ability');
		} else if (/at the beginning of your end step.*proliferate/i.test(low)) {
			addResult('ability_endstep_proliferate', 'End Step: Proliferate', 'ability');
		} else if (low.startsWith('when ') && low.includes('enters')) {
			addResult('ability_etb', 'Enters Battlefield Trigger', 'ability');
		} else if (low.startsWith('whenever ') && low.includes('attacks')) {
			addResult('ability_attack', 'Attack Trigger', 'ability');
		} else if (low.startsWith('whenever ') && low.includes('combat damage')) {
			addResult('ability_combat_dmg', 'Combat Damage Trigger', 'ability');
		} else if (low.startsWith('whenever ') && low.includes('cast')) {
			addResult('ability_cast_trig', 'Spell Cast Trigger', 'ability');
		} else if (/^\{t\}:\s*add\s+([^\n.]+)/i.test(line)) {
			const m = line.match(/^\{t\}:\s*add\s+([^\n.]+)/i);
			addResult('ability_mana', `Mana Ability: Add ${m ? m[1] : 'Mana'}`, 'ability');
		} else if (/no maximum hand size/i.test(low)) {
			addResult('ability_no_max_hand', 'No Maximum Hand Size', 'ability');
		} else if (/equipped creature/i.test(low)) {
			addResult('ability_equip_buff', 'Grants Equipped Creature Buff', 'ability');
		} else if (/enchanted (?:creature|permanent)/i.test(low)) {
			addResult('ability_enchant_mod', 'Modifies Enchanted Permanent', 'ability');
		} else if (/opponents control lose/i.test(low)) {
			addResult('ability_strip_kw', 'Removes Opponent Keywords', 'ability');
		} else if (/(?:other )?[a-z]*\s*creatures you control (?:get|have)/i.test(low)) {
			addResult('ability_lord', 'Anthem / Lord Effect', 'ability');
		} else if (/spells you cast cost/i.test(low)) {
			addResult('ability_cost_mod', 'Spell Cost Reduction', 'ability');
		} else if (/twice that many \+1\/\+1 counters/i.test(low)) {
			addResult('ability_counter_doubler', 'Doubles +1/+1 Counters', 'ability');
		} else if (/triggers an additional time/i.test(low)) {
			addResult('ability_trigger_doubler', 'Doubles Triggered Abilities', 'ability');
		} else if (/control your opponents while they['’]re searching their libraries/i.test(low)) {
			addResult('ability_search_control', 'Control Opponents Searching Libraries', 'ability');
		} else if (/while an opponent is searching their library, they exile each card they find/i.test(low)) {
			addResult('ability_search_exile_steal', 'Exile & Play Opponent Searched Cards', 'ability');
		} else if (line.includes(':') && !low.startsWith('equip')) {
			addResult('ability_activated', 'Activated Ability', 'ability');
		}
	}

	return results;
}

/**
 * Checks whether a battlefield permanent has lost all of its innate abilities due to an attached Aura
 * (`Darksteel Mutation`, `Kenrith's Transformation`, `Imprisoned in the Moon`, `Song of the Dryads`)
 * or a global enchantment (`Humility`, `Dress Down`, `Blood Moon`).
 */
export function getAttachedAbilityStrippingAuraSources(
	perm: CardInstance,
	state: GameState,
	visited: Set<string> = new Set()
): Array<{ name: string; timestamp: number }> {
	if (visited.has(perm.instanceId)) return [];
	visited.add(perm.instanceId);
	const result: Array<{ name: string; timestamp: number }> = [];
	let fallbackOrder = 0;
	for (const p of state.players) {
		if (p.lost) continue;
		for (const other of p.battlefield) {
			if (other.phasedOut) continue;
			fallbackOrder += 1;
			if (other.attachedToId !== perm.instanceId) continue;
			const oCard = other.copiableCard ?? other.card;
			const oLow = oCard.oracleText.toLowerCase();
			if (
				/enchanted (?:creature|permanent)\b.*\bloses all (?:other )?(?:card types and )?abilities/i.test(
					oLow
				) ||
				/loses all abilities/i.test(oLow)
			) {
				if (getAttachedAbilityStrippingAuraSources(other, state, visited).length === 0) {
					result.push({
						name: oCard.name,
						timestamp: other.enteredTimestamp ?? fallbackOrder
					});
				}
			}
		}
	}
	return result;
}

export function permanentHasLostAllAbilities(
	perm: CardInstance,
	state: GameState
): { lost: boolean; sources: string[] } {
	const sources: string[] = [];
	const baseCard = perm.copiableCard ?? perm.card;
	const hasOpalescenceOnBoard = state.players.some(
		(pl) =>
			!pl.lost &&
			pl.battlefield.some(
				(b) =>
					!b.phasedOut &&
					b.instanceId !== perm.instanceId &&
					getAttachedAbilityStrippingAuraSources(b, state).length === 0 &&
					/each other non-aura enchantment is a creature in addition/i.test(
						(b.copiableCard ?? b.card).oracleText
					)
			)
	);

	let effectiveTypeLine = perm.isFaceDown ? 'Creature' : baseCard.typeLine;
	const attachedTypePerms: Array<{ perm: CardInstance; timestamp: number }> = [];
	let order = 0;
	for (const p of state.players) {
		if (p.lost) continue;
		for (const other of p.battlefield) {
			if (other.phasedOut) continue;
			order += 1;
			if (other.attachedToId === perm.instanceId) {
				attachedTypePerms.push({ perm: other, timestamp: other.enteredTimestamp ?? order });
			}
		}
	}
	attachedTypePerms.sort((a, b) => a.timestamp - b.timestamp);
	for (const { perm: att } of attachedTypePerms) {
		if (getAttachedAbilityStrippingAuraSources(att, state).length > 0) continue;
		const aCard = att.copiableCard ?? att.card;
		const artCreatureMatch = aCard.oracleText.match(
			/enchanted (?:creature|permanent)\b[^.\n]*?\bis an? ([a-z]+) artifact creature\b/i
		);
		const creatureSubMatch = !artCreatureMatch
			? aCard.oracleText.match(
					/enchanted (?:creature|permanent)\b[^.\n]*?\bis an? (?:(?:white|blue|black|red|green|colorless) )?([a-z]+) creature\b/i
				)
			: null;
		const landMatch = aCard.oracleText.match(
			/enchanted (?:creature|permanent)\b[^.\n]*?\bis a (?:colorless )?(?:(plains|island|swamp|mountain|forest) )?land\b/i
		);
		if (artCreatureMatch) {
			effectiveTypeLine = `Artifact Creature — ${artCreatureMatch[1]}`;
		} else if (creatureSubMatch) {
			effectiveTypeLine = `Creature — ${creatureSubMatch[1]}`;
		} else if (landMatch) {
			effectiveTypeLine = landMatch[1] ? `Land — ${landMatch[1]}` : 'Land';
		}
	}

	const isCreature =
		effectiveTypeLine.includes('Creature') ||
		(hasOpalescenceOnBoard &&
			effectiveTypeLine.includes('Enchantment') &&
			!effectiveTypeLine.includes('Aura'));
	const isNonBasicLand =
		effectiveTypeLine.includes('Land') && !baseCard.typeLine.includes('Basic');

	for (const p of state.players) {
		if (p.lost) continue;
		for (const other of p.battlefield) {
			if (other.phasedOut) continue;
			if (getAttachedAbilityStrippingAuraSources(other, state).length > 0) continue;
			const oCard = other.copiableCard ?? other.card;
			const oName = oCard.name;
			const oLow = oCard.oracleText.toLowerCase();

			if (other.attachedToId === perm.instanceId) {
				if (
					/enchanted (?:creature|permanent)\b.*\bloses all (?:other )?(?:card types and )?abilities/i.test(
						oLow
					) ||
					/loses all abilities/i.test(oLow)
				) {
					if (!sources.includes(oName)) sources.push(oName);
				}
			}

			if (
				isCreature &&
				(/(?:^|\b)all creatures lose all abilities/i.test(oLow) ||
					/^creatures lose all abilities/im.test(oLow))
			) {
				if (!sources.includes(oName)) sources.push(oName);
			}

			if (
				isNonBasicLand &&
				/nonbasic lands are (?:plains|islands|swamps|mountains|forests)\b/i.test(oLow)
			) {
				if (!sources.includes(oName)) sources.push(oName);
			}
		}
	}

	return { lost: sources.length > 0, sources };
}

function addSubtypeToTypeLine(typeLine: string, subtype: string): string {
	if (new RegExp(`\\b${subtype}\\b`, 'i').test(typeLine)) return typeLine;
	if (typeLine.includes('—')) {
		return `${typeLine} ${subtype}`;
	}
	return `${typeLine} — ${subtype}`;
}

function addCardTypeToTypeLine(typeLine: string, cardType: string): string {
	if (new RegExp(`\\b${cardType}\\b`, 'i').test(typeLine)) return typeLine;
	if (typeLine.includes('—')) {
		const [left, right] = typeLine.split('—');
		return `${left.trim()} ${cardType} — ${right.trim()}`;
	}
	return `${typeLine.trim()} ${cardType}`;
}

function capitalizeWord(word: string): string {
	if (!word) return word;
	return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

const BASIC_LAND_MANA_MAP: Record<string, { subtype: string; sym: string }> = {
	plains: { subtype: 'Plains', sym: 'W' },
	island: { subtype: 'Island', sym: 'U' },
	swamp: { subtype: 'Swamp', sym: 'B' },
	mountain: { subtype: 'Mountain', sym: 'R' },
	forest: { subtype: 'Forest', sym: 'G' }
};

/**
 * Evaluates a card or battlefield permanent against MTG Continuous Effect Layers 1 through 7d,
 * returning all innate keywords/abilities (`(innate)`), granted keywords/abilities (`(Source)`),
 * removed keywords/abilities (`--keyword-- (innate) (removed by Source)`), and complex type/P&T modifications.
 */
export function inspectCardContinuousBreakdown(
	cardOrInst: CardInstance | ScryfallCard,
	state?: GameState
): CardContinuousBreakdown {
	let inst: CardInstance | null = null;
	let card: ScryfallCard;

	if ('instanceId' in cardOrInst) {
		inst = cardOrInst;
		// Layer 1 (Copy effects — CR 613.1a & CR 707.2): Use copiableCard if present
		card = cardOrInst.copiableCard ?? cardOrInst.card;
	} else {
		card = cardOrInst;
		if (state) {
			// Locate matching CardInstance on battlefield first, then other zones
			for (const p of state.players) {
				const foundBf = p.battlefield.find(
					(c) => c.card.id === card.id || c.card.name === card.name
				);
				if (foundBf) {
					inst = foundBf;
					card = foundBf.copiableCard ?? foundBf.card;
					break;
				}
			}
			if (!inst) {
				for (const p of state.players) {
					const foundOther =
						p.command.find((c) => c.card.id === card.id || c.card.name === card.name) ||
						p.hand.find((c) => c.card.id === card.id || c.card.name === card.name) ||
						p.graveyard.find((c) => c.card.id === card.id || c.card.name === card.name) ||
						p.exile.find((c) => c.card.id === card.id || c.card.name === card.name);
					if (foundOther) {
						inst = foundOther;
						break;
					}
				}
			}
		}
	}

	const isFaceDown = Boolean(inst?.isFaceDown);
	const baseTypeLine = isFaceDown ? 'Creature' : card.typeLine;
	let effectiveTypeLine = baseTypeLine;
	const typeModifiedBy: string[] = [];

	const rawP = isFaceDown ? 2 : card.power !== undefined ? parseInt(card.power, 10) : null;
	const rawT = isFaceDown ? 2 : card.toughness !== undefined ? parseInt(card.toughness, 10) : null;
	const basePower = rawP !== null && !isNaN(rawP) ? rawP : null;
	const baseToughness = rawT !== null && !isNaN(rawT) ? rawT : null;

	let workingPower = basePower;
	let workingToughness = baseToughness;
	const ptModifiedBy: string[] = [];

	// 1. Seed innate keywords & abilities from the card itself (empty if face-down per CR 702.37a)
	const innateList = isFaceDown ? [] : extractSelfInnateKeywordsAndAbilities(card);
	const itemTimestamps = new Map<string, number>();
	const items: AttributedKeywordOrEffect[] = innateList.map((entry, idx) => {
		const id = `innate_${idx}_${entry.canonicalKey}`;
		itemTimestamps.set(id, -Infinity);
		return {
			id,
			canonicalKey: entry.canonicalKey,
			name: entry.name,
			kind: entry.kind,
			isInnate: true,
			sources: ['innate'],
			removed: false,
			removedBy: []
		};
	});

	const isOnBattlefield = Boolean(
		inst &&
			state &&
			!inst.phasedOut &&
			(inst.zone === 'battlefield' ||
				state.players.some((p) => p.battlefield.some((b) => b.instanceId === inst!.instanceId)))
	);

	if (!inst || !state || !isOnBattlefield) {
		return {
			baseTypeLine,
			effectiveTypeLine,
			typeModified: false,
			typeModifiedBy: [],
			basePower,
			baseToughness,
			effectivePower: basePower,
			effectiveToughness: baseToughness,
			ptModifiedBy: [],
			items
		};
	}

	const isLegendary = baseTypeLine.includes('Legendary');
	const prefixLegendary = isLegendary ? 'Legendary ' : '';
	const allAbilityRemovalSources: string[] = [];
	const abilityRemovalEvents: Array<{ sourceName: string; timestamp: number }> = [];
	const recordAbilityRemoval = (sourceName: string, timestamp: number) => {
		if (!allAbilityRemovalSources.includes(sourceName)) {
			allAbilityRemovalSources.push(sourceName);
		}
		if (
			!abilityRemovalEvents.some(
				(e) => e.sourceName === sourceName && e.timestamp === timestamp
			)
		) {
			abilityRemovalEvents.push({ sourceName, timestamp });
		}
	};

	// Collect all active (non-phased-out) battlefield permanents sorted by timestamp (CR 613.7)
	const allBattlefieldPerms: Array<{ perm: CardInstance; playerId: string; timestamp: number }> = [];
	let fallbackOrder = 0;
	for (const player of state.players) {
		if (player.lost) continue;
		for (const perm of player.battlefield) {
			if (perm.phasedOut) continue;
			fallbackOrder += 1;
			allBattlefieldPerms.push({
				perm,
				playerId: player.playerId,
				timestamp: perm.enteredTimestamp ?? fallbackOrder
			});
		}
	}
	allBattlefieldPerms.sort((a, b) => a.timestamp - b.timestamp);

	// Track Layer 7b base P/T setting effects with timestamps so later timestamps win (CR 613.4b & 613.7)
	const layer7bSetters: Array<{
		sourceName: string;
		power: number | null;
		toughness: number | null;
		timestamp: number;
	}> = [];

	const grantItem = (
		canonicalKey: string,
		name: string,
		kind: 'keyword' | 'ability' | 'stat_mod' | 'type_mod',
		sourceName: string,
		grantTimestamp = 0
	) => {
		const keyLow = canonicalKey.toLowerCase();
		const existingActive = items.find(
			(it) => it.canonicalKey === keyLow && !it.removed && it.kind === kind
		);
		if (existingActive) {
			if (!existingActive.sources.includes(sourceName)) {
				existingActive.sources.push(sourceName);
			}
			const prevTs = itemTimestamps.get(existingActive.id) ?? -Infinity;
			if (grantTimestamp > prevTs) {
				itemTimestamps.set(existingActive.id, grantTimestamp);
			}
			return;
		}
		const id = `granted_${items.length}_${keyLow}`;
		itemTimestamps.set(id, grantTimestamp);
		items.push({
			id,
			canonicalKey: keyLow,
			name,
			kind,
			isInnate: false,
			sources: [sourceName],
			removed: false,
			removedBy: []
		});
	};

	const applyRemovalsUpTo = (cutoffTimestamp: number) => {
		for (const ev of abilityRemovalEvents) {
			if (ev.timestamp > cutoffTimestamp) continue;
			for (const item of items) {
				if (item.kind !== 'keyword' && item.kind !== 'ability' && !item.isInnate) continue;
				const itemTs = itemTimestamps.get(item.id) ?? -Infinity;
				if (itemTs < ev.timestamp) {
					item.removed = true;
					if (!item.removedBy.includes(ev.sourceName)) {
						item.removedBy.push(ev.sourceName);
					}
				}
			}
		}
	};

	// 2. Layer 4 (Type-changing effects) & Layer 6 (Loses all abilities) & collect Layer 7b Base P/T setters
	for (const { perm, timestamp } of allBattlefieldPerms) {
		if (getAttachedAbilityStrippingAuraSources(perm, state).length > 0) continue;
		const pCard = perm.copiableCard ?? perm.card;
		const pName = pCard.name;
		const pLow = pCard.oracleText.toLowerCase();

		// Check attached Auras/Equipment on `inst`
		if (perm.attachedToId === inst.instanceId) {
			const losesAbilities =
				/enchanted (?:creature|permanent)\b.*\bloses all (?:other )?(?:card types and )?abilities/i.test(
					pLow
				) || /loses all abilities/i.test(pLow);
			if (losesAbilities) {
				recordAbilityRemoval(pName, timestamp);
			}

			const basePtMatch = pLow.match(/base power and toughness (\d+)\/(\d+)/i);
			const artCreatureMatch = pCard.oracleText.match(
				/enchanted (?:creature|permanent)\b[^.\n]*?\bis an? ([a-z]+) artifact creature\b/i
			);
			const creatureSubMatch = !artCreatureMatch
				? pCard.oracleText.match(
						/enchanted (?:creature|permanent)\b[^.\n]*?\bis an? (?:(?:white|blue|black|red|green|colorless) )?([a-z]+) creature\b/i
					)
				: null;
			const landMatch = pCard.oracleText.match(
				/enchanted (?:creature|permanent)\b[^.\n]*?\bis a (?:colorless )?(?:(plains|island|swamp|mountain|forest) )?land\b/i
			);

			if (artCreatureMatch) {
				const sub = capitalizeWord(artCreatureMatch[1]);
				effectiveTypeLine = `${prefixLegendary}Artifact Creature — ${sub}`;
				if (!typeModifiedBy.includes(pName)) typeModifiedBy.push(pName);
			} else if (creatureSubMatch) {
				const sub = capitalizeWord(creatureSubMatch[1]);
				effectiveTypeLine = `${prefixLegendary}Creature — ${sub}`;
				if (!typeModifiedBy.includes(pName)) typeModifiedBy.push(pName);
			} else if (landMatch) {
				if (landMatch[1]) {
					const sub = capitalizeWord(landMatch[1]);
					effectiveTypeLine = `${prefixLegendary}Land — ${sub}`;
				} else {
					effectiveTypeLine = `${prefixLegendary}Land`;
				}
				if (!typeModifiedBy.includes(pName)) typeModifiedBy.push(pName);
				layer7bSetters.push({ sourceName: pName, power: null, toughness: null, timestamp });
			}

			if (basePtMatch) {
				layer7bSetters.push({
					sourceName: pName,
					power: parseInt(basePtMatch[1], 10),
					toughness: parseInt(basePtMatch[2], 10),
					timestamp
				});
			}
		}
	}

	// Global Layer 4 Pass A: Type-overwriting effects ("Nonbasic lands are Mountains.")
	for (const { perm, timestamp } of allBattlefieldPerms) {
		if (getAttachedAbilityStrippingAuraSources(perm, state).length > 0) continue;
		const pCard = perm.copiableCard ?? perm.card;
		const pName = pCard.name;
		const pLow = pCard.oracleText.toLowerCase();

		const nonbasicLandMatch = pLow.match(
			/nonbasic lands are (plains|islands|swamps|mountains|forests)\b/i
		);
		if (
			nonbasicLandMatch &&
			effectiveTypeLine.includes('Land') &&
			!baseTypeLine.includes('Basic')
		) {
			const rawKey = nonbasicLandMatch[1].toLowerCase();
			const landKey = rawKey === 'plains' ? 'plains' : rawKey.replace(/s$/, '');
			const info = BASIC_LAND_MANA_MAP[landKey];
			if (info) {
				effectiveTypeLine = `${prefixLegendary}Land — ${info.subtype}`;
				if (!typeModifiedBy.includes(pName)) typeModifiedBy.push(pName);
				recordAbilityRemoval(pName, timestamp);
			}
		}
	}

	// Global Layer 4 Pass B (Additive types: Opalescence, Urborg, Yavimaya, Mycosynth Lattice, Maskwood Nexus)
	for (const { perm, playerId, timestamp } of allBattlefieldPerms) {
		if (getAttachedAbilityStrippingAuraSources(perm, state).length > 0) continue;
		const pCard = perm.copiableCard ?? perm.card;
		const pName = pCard.name;
		const pLow = pCard.oracleText.toLowerCase();

		if (
			/each other non-aura enchantment is a creature in addition/i.test(pLow) &&
			perm.instanceId !== inst.instanceId &&
			effectiveTypeLine.includes('Enchantment') &&
			!effectiveTypeLine.includes('Aura')
		) {
			effectiveTypeLine = addCardTypeToTypeLine(effectiveTypeLine, 'Creature');
			if (!typeModifiedBy.includes(pName)) typeModifiedBy.push(pName);
			layer7bSetters.push({
				sourceName: pName,
				power: card.cmc,
				toughness: card.cmc,
				timestamp
			});
		}

		const eachLandMatch = pLow.match(
			/each land is an? (plains|island|swamp|mountain|forest) in addition/i
		);
		if (eachLandMatch && effectiveTypeLine.includes('Land')) {
			const info = BASIC_LAND_MANA_MAP[eachLandMatch[1].toLowerCase()];
			if (info) {
				const nextType = addSubtypeToTypeLine(effectiveTypeLine, info.subtype);
				if (nextType !== effectiveTypeLine) {
					effectiveTypeLine = nextType;
				}
				if (!typeModifiedBy.includes(pName)) typeModifiedBy.push(pName);
			}
		}

		if (/all permanents are artifacts in addition/i.test(pLow)) {
			const nextType = addCardTypeToTypeLine(effectiveTypeLine, 'Artifact');
			if (nextType !== effectiveTypeLine) {
				effectiveTypeLine = nextType;
				if (!typeModifiedBy.includes(pName)) typeModifiedBy.push(pName);
			}
		}

		if (
			playerId === inst.controllerId &&
			/creatures you control are every creature type/i.test(pLow) &&
			effectiveTypeLine.includes('Creature')
		) {
			effectiveTypeLine = addSubtypeToTypeLine(effectiveTypeLine, 'All-Types');
			if (!typeModifiedBy.includes(pName)) typeModifiedBy.push(pName);
		}
	}

	// Global Layer 6 ("All creatures lose all abilities..." / "Creatures lose all abilities.") & Layer 7b registration
	for (const { perm, timestamp } of allBattlefieldPerms) {
		if (getAttachedAbilityStrippingAuraSources(perm, state).length > 0) continue;
		const pCard = perm.copiableCard ?? perm.card;
		const pName = pCard.name;
		const pLow = pCard.oracleText.toLowerCase();

		if (
			effectiveTypeLine.includes('Creature') &&
			(/(?:^|\b)all creatures lose all abilities/i.test(pLow) ||
				/^creatures lose all abilities/im.test(pLow))
		) {
			recordAbilityRemoval(pName, timestamp);
			const ptMatch = pLow.match(/base power and toughness (\d+)\/(\d+)/i);
			if (ptMatch) {
				layer7bSetters.push({
					sourceName: pName,
					power: parseInt(ptMatch[1], 10),
					toughness: parseInt(ptMatch[2], 10),
					timestamp
				});
			}
		}
	}

	// Evaluate Layer 7a (Characteristic-Defining Abilities like `*/*`)
	if (effectiveTypeLine.includes('Creature')) {
		if (workingPower === null) workingPower = 0;
		if (workingToughness === null) workingToughness = 0;
		if (
			allAbilityRemovalSources.length === 0 &&
			(card.power === '*' || card.toughness === '*')
		) {
			const cLow = card.oracleText.toLowerCase();
			if (cLow.includes('number of creatures you control')) {
				const ctrl = state.players.find((p) => p.playerId === inst!.controllerId);
				const count =
					ctrl?.battlefield.filter((b) => !b.phasedOut && b.card.typeLine.includes('Creature'))
						.length ?? 0;
				workingPower = count;
				workingToughness = count;
				ptModifiedBy.push(`${card.name} CDA (${count}/${count})`);
			} else if (cLow.includes('creature cards in all graveyards')) {
				const count = state.players.reduce(
					(acc, pl) =>
						acc + pl.graveyard.filter((g) => g.card.typeLine.includes('Creature')).length,
					0
				);
				workingPower = count;
				workingToughness = count;
				ptModifiedBy.push(`${card.name} CDA (${count}/${count})`);
			}
		}
	}

	// Evaluate Layer 7b (Set Base P/T to specific values in strict Timestamp Order — CR 613.4b & 613.7)
	layer7bSetters.sort((a, b) => a.timestamp - b.timestamp);
	for (const setter of layer7bSetters) {
		workingPower = setter.power;
		workingToughness = setter.toughness;
		if (setter.power !== null && setter.toughness !== null) {
			const label = `${setter.sourceName} (base ${setter.power}/${setter.toughness})`;
			if (!ptModifiedBy.includes(label)) {
				ptModifiedBy.push(label);
			}
		}
	}

	// Mark all innate items as removed if any `allAbilityRemovalSources` apply
	if (allAbilityRemovalSources.length > 0) {
		for (const item of items) {
			if (item.isInnate) {
				item.removed = true;
				for (const src of allAbilityRemovalSources) {
					if (!item.removedBy.includes(src)) {
						item.removedBy.push(src);
					}
				}
			}
		}
	}

	// 3. Grant new abilities from Layer 4 / Layer 6 continuous effects & Layer 7c P/T modifiers in timestamp order
	for (const { perm, playerId, timestamp } of allBattlefieldPerms) {
		applyRemovalsUpTo(timestamp);
		if (getAttachedAbilityStrippingAuraSources(perm, state).length > 0) continue;
		const pCard = perm.copiableCard ?? perm.card;
		const pName = pCard.name;
		const pLow = pCard.oracleText.toLowerCase();

		// Attached Auras & Equipment
		if (perm.attachedToId === inst.instanceId) {
			const basePtMatch = pLow.match(/base power and toughness (\d+)\/(\d+)/i);
			const ptSuffix = basePtMatch ? ` (${basePtMatch[1]}/${basePtMatch[2]})` : '';
			const artCreatureMatch = pCard.oracleText.match(
				/enchanted (?:creature|permanent)\b[^.\n]*?\bis an? ([a-z]+) artifact creature\b/i
			);
			const creatureSubMatch = !artCreatureMatch
				? pCard.oracleText.match(
						/enchanted (?:creature|permanent)\b[^.\n]*?\bis an? (?:(?:white|blue|black|red|green|colorless) )?([a-z]+) creature\b/i
					)
				: null;
			const landMatch = pCard.oracleText.match(
				/enchanted (?:creature|permanent)\b[^.\n]*?\bis a (?:colorless )?(?:(plains|island|swamp|mountain|forest) )?land\b/i
			);

			if (artCreatureMatch) {
				const sub = capitalizeWord(artCreatureMatch[1]);
				grantItem(
					`type_${sub.toLowerCase()}`,
					`Type: Artifact Creature — ${sub}${ptSuffix}`,
					'type_mod',
					pName,
					timestamp
				);
			} else if (creatureSubMatch) {
				const sub = capitalizeWord(creatureSubMatch[1]);
				grantItem(
					`type_${sub.toLowerCase()}`,
					`Type: Creature — ${sub}${ptSuffix}`,
					'type_mod',
					pName,
					timestamp
				);
			} else if (landMatch) {
				if (landMatch[1]) {
					const info = BASIC_LAND_MANA_MAP[landMatch[1].toLowerCase()];
					if (info) {
						grantItem(
							`mana_${info.sym.toLowerCase()}`,
							`Mana Ability: Add {${info.sym}}`,
							'ability',
							pName,
							timestamp
						);
						grantItem(
							`type_${info.subtype.toLowerCase()}`,
							`Type: Land — ${info.subtype}`,
							'type_mod',
							pName,
							timestamp
						);
					}
				} else {
					const addSymMatch = pCard.oracleText.match(/with "\{t\}:\s*add \{([wubrgc])\}"/i);
					if (addSymMatch) {
						const sym = addSymMatch[1].toUpperCase();
						grantItem(
							`mana_${sym.toLowerCase()}`,
							`Mana Ability: Add {${sym}}`,
							'ability',
							pName,
							timestamp
						);
					}
					grantItem('type_land', 'Type: Colorless Land', 'type_mod', pName, timestamp);
				}
			}

			// Generic attached Equipment / Aura keyword parser
			for (const line of pCard.oracleText.split('\n')) {
				const lLow = line.toLowerCase();
				if (
					(lLow.includes('equipped creature') ||
						lLow.includes('enchanted creature') ||
						lLow.includes('enchanted permanent')) &&
					(lLow.includes('has ') || lLow.includes('gains ') || lLow.includes('and '))
				) {
					for (const kw of CANONICAL_COMBAT_KEYWORDS) {
						if (kw.regex.test(line)) {
							grantItem(kw.key, kw.label, 'keyword', pName, timestamp);
						}
					}
					const protMatch = line.match(/\b(protection from [a-z ,]+?)(?:[.\n]|$)/i);
					if (protMatch) {
						const label =
							protMatch[1].charAt(0).toUpperCase() + protMatch[1].slice(1).trim();
						grantItem('protection', label, 'keyword', pName, timestamp);
					}
				}
			}

			// Attached P/T modifier (e.g., "Equipped creature gets +1/+1")
			const eqPtMatch = pCard.oracleText.match(
				/(?:equipped|enchanted) creature gets ([+-]\d+)\/([+-]\d+)/i
			);
			if (eqPtMatch && workingPower !== null && workingToughness !== null) {
				const dp = parseInt(eqPtMatch[1], 10) || 0;
				const dt = parseInt(eqPtMatch[2], 10) || 0;
				workingPower += dp;
				workingToughness += dt;
				const signP = dp >= 0 ? `+${dp}` : `${dp}`;
				const signT = dt >= 0 ? `+${dt}` : `${dt}`;
				grantItem(`pt_${pName}`, `${signP}/${signT}`, 'stat_mod', pName, timestamp);
				ptModifiedBy.push(`${signP}/${signT} (${pName})`);
			}
		}

		// Global Land Type-Grants
		const nonbasicLandMatch = pLow.match(
			/nonbasic lands are (plains|islands|swamps|mountains|forests)\b/i
		);
		if (
			nonbasicLandMatch &&
			effectiveTypeLine.includes('Land') &&
			!baseTypeLine.includes('Basic')
		) {
			const rawKey = nonbasicLandMatch[1].toLowerCase();
			const landKey = rawKey === 'plains' ? 'plains' : rawKey.replace(/s$/, '');
			const info = BASIC_LAND_MANA_MAP[landKey];
			if (info) {
				grantItem(
					`mana_${info.sym.toLowerCase()}`,
					`Mana Ability: Add {${info.sym}}`,
					'ability',
					pName,
					timestamp
				);
				grantItem(
					`type_${info.subtype.toLowerCase()}`,
					`Type: Land — ${info.subtype}`,
					'type_mod',
					pName,
					timestamp
				);
			}
		}

		const eachLandMatch = pLow.match(
			/each land is an? (plains|island|swamp|mountain|forest) in addition/i
		);
		if (eachLandMatch && effectiveTypeLine.includes('Land')) {
			const info = BASIC_LAND_MANA_MAP[eachLandMatch[1].toLowerCase()];
			if (info) {
				grantItem(
					`mana_${info.sym.toLowerCase()}`,
					`Mana Ability: Add {${info.sym}}`,
					'ability',
					pName,
					timestamp
				);
				grantItem(
					info.subtype === 'Forest'
						? 'type_forest_add'
						: `type_${info.subtype.toLowerCase()}`,
					`Subtype: +${info.subtype}`,
					'type_mod',
					pName,
					timestamp
				);
			}
		}

		// Controller-scoped Anthems & Lords
		if (playerId === inst.controllerId) {
			const permLostAbilities = permanentHasLostAllAbilities(perm, state).lost;
			if (!permLostAbilities) {
				if (
					/lands you control have "\{t\}:\s*add one mana of any color\.?"/i.test(pLow) &&
					effectiveTypeLine.includes('Land')
				) {
					grantItem('mana_any', 'Mana Ability: Add Any Color', 'ability', pName, timestamp);
				}

				if (
					/creatures you control are every creature type/i.test(pLow) &&
					effectiveTypeLine.includes('Creature')
				) {
					grantItem('changeling', 'Changeling (All Creature Types)', 'keyword', pName, timestamp);
				}

				for (const line of pCard.oracleText.split('\n')) {
					const lLow = line.toLowerCase();
					if (
						lLow.startsWith('whenever ') ||
						lLow.startsWith('when ') ||
						lLow.includes(':')
					) {
						continue;
					}

					// Multi-type grant: "You, planeswalkers you control, and other creatures you control have <kw>."
					const pwAndCreatureMatch = line.match(
						/(?:you,\s*)?planeswalkers you control,?\s*and (other )?creatures you control have ([^.\n]+)/i
					);
					if (pwAndCreatureMatch) {
						const isOtherCreature = Boolean(pwAndCreatureMatch[1]);
						const appliesToInst =
							effectiveTypeLine.includes('Planeswalker') ||
							(effectiveTypeLine.includes('Creature') &&
								(!isOtherCreature || perm.instanceId !== inst.instanceId));
						if (appliesToInst) {
							const kwClause = pwAndCreatureMatch[2];
							for (const kw of CANONICAL_COMBAT_KEYWORDS) {
								if (kw.regex.test(kwClause)) {
									grantItem(kw.key, kw.label, 'keyword', pName, timestamp);
								}
							}
							const protMatch = kwClause.match(/\b(protection from [a-z ,]+?)(?:[.\n]|$)/i);
							if (protMatch) {
								const label =
									protMatch[1].charAt(0).toUpperCase() + protMatch[1].slice(1).trim();
								grantItem('protection', label, 'keyword', pName, timestamp);
							}
						}
						continue;
					}

					// Creature / Subtype Lord & Anthem: "[Other] [<Subtype>] creatures you control [get +X/+Y] [and] [have <keywords>]"
					const ptLordMatch = line.match(
						/^(other )?(?:([a-z]+) )?creatures you control get ([+-]\d+)\/([+-]\d+)/i
					);
					const kwLordMatch = line.match(
						/^(other )?(?:([a-z]+) )?creatures you control (?:get [+-]\d+\/[+-]\d+ and )?have ([^.\n]+)/i
					);

					if ((ptLordMatch || kwLordMatch) && effectiveTypeLine.includes('Creature')) {
						const isOtherOnly = Boolean((ptLordMatch ?? kwLordMatch)?.[1]);
						if (isOtherOnly && perm.instanceId === inst.instanceId) continue;

						const subtypeReq = (ptLordMatch ?? kwLordMatch)?.[2];
						const matchesSubtype =
							!subtypeReq ||
							new RegExp(`\\b${subtypeReq}\\b`, 'i').test(effectiveTypeLine) ||
							effectiveTypeLine.includes('All-Types') ||
							items.some((i) => i.canonicalKey === 'changeling' && !i.removed);

						if (matchesSubtype) {
							if (ptLordMatch && workingPower !== null && workingToughness !== null) {
								const dp = parseInt(ptLordMatch[3], 10) || 0;
								const dt = parseInt(ptLordMatch[4], 10) || 0;
								workingPower += dp;
								workingToughness += dt;
								const signP = dp >= 0 ? `+${dp}` : `${dp}`;
								const signT = dt >= 0 ? `+${dt}` : `${dt}`;
								grantItem(`pt_${perm.instanceId}`, `${signP}/${signT}`, 'stat_mod', pName, timestamp);
								ptModifiedBy.push(`${signP}/${signT} (${pName})`);
							}
							if (kwLordMatch) {
								const kwClause = kwLordMatch[3];
								for (const kw of CANONICAL_COMBAT_KEYWORDS) {
									if (kw.regex.test(kwClause)) {
										grantItem(kw.key, kw.label, 'keyword', pName, timestamp);
									}
								}
								const protMatch = kwClause.match(/\b(protection from [a-z ,]+?)(?:[.\n]|$)/i);
								if (protMatch) {
									const label =
										protMatch[1].charAt(0).toUpperCase() + protMatch[1].slice(1).trim();
									grantItem('protection', label, 'keyword', pName, timestamp);
								}
							}
						}
					}
				}
			}
		}
	}
	applyRemovalsUpTo(Infinity);

	// 4. Instance-level counters, temporary P/T buffs, Suspend haste, and temporary `grantedKeywords`
	if (inst.castViaSuspend && effectiveTypeLine.includes('Creature')) {
		grantItem('haste', 'Haste', 'keyword', 'Suspend');
	}
	const plusOnes = inst.counters['+1/+1'] || 0;
	const minusOnes = inst.counters['-1/-1'] || 0;
	if (plusOnes > 0 && workingPower !== null && workingToughness !== null) {
		workingPower += plusOnes;
		workingToughness += plusOnes;
		grantItem('counters_plus', `+${plusOnes}/+${plusOnes}`, 'stat_mod', '+1/+1 Counters');
		ptModifiedBy.push(`+${plusOnes}/+${plusOnes} (+1/+1 Counters)`);
	}
	if (minusOnes > 0 && workingPower !== null && workingToughness !== null) {
		workingPower -= minusOnes;
		workingToughness -= minusOnes;
		grantItem('counters_minus', `-${minusOnes}/-${minusOnes}`, 'stat_mod', '-1/-1 Counters');
		ptModifiedBy.push(`-${minusOnes}/-${minusOnes} (-1/-1 Counters)`);
	}
	if (
		(inst.tempPowerMod !== 0 || inst.tempToughnessMod !== 0) &&
		workingPower !== null &&
		workingToughness !== null
	) {
		workingPower += inst.tempPowerMod;
		workingToughness += inst.tempToughnessMod;
		const sp = inst.tempPowerMod >= 0 ? `+${inst.tempPowerMod}` : `${inst.tempPowerMod}`;
		const st = inst.tempToughnessMod >= 0 ? `+${inst.tempToughnessMod}` : `${inst.tempToughnessMod}`;
		grantItem('temp_pt', `${sp}/${st}`, 'stat_mod', 'Temporary Effect');
		ptModifiedBy.push(`${sp}/${st} (Temporary Effect)`);
	}

	// Layer 7d: Effects that switch a creature's power and toughness (CR 613.4d)
	if (
		workingPower !== null &&
		workingToughness !== null &&
		(inst.switchedPTCount || 0) % 2 === 1
	) {
		const prevP = workingPower;
		const prevT = workingToughness;
		workingPower = prevT;
		workingToughness = prevP;
		grantItem('switched_pt', `Switched P/T (${workingPower}/${workingToughness})`, 'stat_mod', 'P/T Switch');
		ptModifiedBy.push(`Switched P/T (${workingPower}/${workingToughness})`);
	}

	for (const gKw of inst.grantedKeywords || []) {
		const gLow = gKw.toLowerCase();
		const alreadyActive = items.some((it) => it.canonicalKey === gLow && !it.removed);
		if (!alreadyActive) {
			let sourceLabel = 'Temporary Effect';
			const controller = state.players.find((p) => p.playerId === inst!.controllerId);
			if (controller) {
				const kwGainRegex = new RegExp(`\\bgains?\\b[^.\\n]*\\b${gLow}\\b`, 'i');
				const matchingSource = controller.battlefield.find(
					(b) => !b.phasedOut && kwGainRegex.test((b.copiableCard ?? b.card).oracleText)
				);
				if (matchingSource) {
					sourceLabel = (matchingSource.copiableCard ?? matchingSource.card).name;
				}
			}
			const matchedCanon = CANONICAL_COMBAT_KEYWORDS.find((k) => k.key === gLow);
			grantItem(gLow, matchedCanon ? matchedCanon.label : gKw, 'keyword', sourceLabel);
		}
	}

	// 5. Layer 6 Keyword-Removal Effects from Opponents' Battlefields (Shadowspear, Arcane Lighthouse, Bonds of Mortality, Archetype of Imagination, etc.)
	const removedKeywordMap = new Map<string, string[]>(); // canonicalKey -> sourceCardNames[]
	const markKeywordRemoved = (kwKey: string, sourceName: string) => {
		const k = kwKey.toLowerCase();
		const list = removedKeywordMap.get(k) ?? [];
		if (!list.includes(sourceName)) list.push(sourceName);
		removedKeywordMap.set(k, list);
	};

	for (const { perm, playerId } of allBattlefieldPerms) {
		if (playerId === inst.controllerId) continue;
		if (permanentHasLostAllAbilities(perm, state).lost) continue;
		const pCard = perm.copiableCard ?? perm.card;
		const pName = pCard.name;

		// Generic parser for "<creatures|permanents> your opponents control lose <keywords>"
		const loseMatch = pCard.oracleText.match(
			/(creatures|permanents) your opponents control lose ([^.\n]+)/i
		);
		if (loseMatch) {
			const targetScope = loseMatch[1].toLowerCase();
			const loseClause = loseMatch[2].toLowerCase();
			if (targetScope === 'permanents' || effectiveTypeLine.includes('Creature')) {
				for (const kw of CANONICAL_COMBAT_KEYWORDS) {
					if (kw.regex.test(loseClause)) {
						markKeywordRemoved(kw.key, pName);
					}
				}
			}
		}
	}

	// Apply `removedKeywordMap` to matching items (both innate and granted!)
	for (const [kwKey, removerNames] of removedKeywordMap.entries()) {
		for (const item of items) {
			if (item.canonicalKey === kwKey) {
				item.removed = true;
				for (const rName of removerNames) {
					if (!item.removedBy.includes(rName)) {
						item.removedBy.push(rName);
					}
				}
			}
		}
	}

	return {
		baseTypeLine,
		effectiveTypeLine,
		typeModified: effectiveTypeLine !== baseTypeLine || typeModifiedBy.length > 0,
		typeModifiedBy,
		basePower,
		baseToughness,
		effectivePower: workingPower !== null ? Math.max(0, workingPower) : null,
		effectiveToughness: workingToughness !== null ? Math.max(0, workingToughness) : null,
		ptModifiedBy,
		items
	};
}


export function evaluatePermanent(state: GameState, inst: CardInstance): EvaluatedPermanent {
	const breakdown = inspectCardContinuousBreakdown(inst, state);
	const tLine = breakdown.effectiveTypeLine;
	const lostInfo = permanentHasLostAllAbilities(inst, state);
	const activeKeywords = breakdown.items
		.filter((it) => it.kind === 'keyword' && !it.removed)
		.map((it) => it.name);
	const hasAllCreatureTypes =
		tLine.includes('All-Types') ||
		breakdown.items.some((it) => it.canonicalKey === 'changeling' && !it.removed);
	const baseCard = inst.copiableCard ?? inst.card;

	return {
		instanceId: inst.instanceId,
		effectiveName: inst.isFaceDown ? 'Face-Down Creature' : baseCard.name,
		effectiveTypeLine: tLine,
		typeLine: tLine,
		isCreature: tLine.includes('Creature'),
		isArtifact: tLine.includes('Artifact'),
		isEnchantment: tLine.includes('Enchantment'),
		isLand: tLine.includes('Land'),
		isPlaneswalker: tLine.includes('Planeswalker'),
		isLegendary: tLine.includes('Legendary'),
		hasAllCreatureTypes,
		losesAllAbilities: lostInfo.lost,
		hasLostAllAbilities: lostInfo.lost,
		lostAllAbilitiesBy: lostInfo.sources,
		power: breakdown.effectivePower ?? 0,
		toughness: breakdown.effectiveToughness ?? 0,
		activeKeywords,
		keywords: activeKeywords,
		breakdown,
		hasSubType: (subType: string) => {
			if (tLine.includes('Creature') && hasAllCreatureTypes) return true;
			return new RegExp(`\\b${subType}\\b`, 'i').test(tLine);
		}
	};
}

describe('layer reference implementation', () => {
	it('loads', () => {
		assert.equal(typeof inspectCardContinuousBreakdown, 'function');
	});
});
