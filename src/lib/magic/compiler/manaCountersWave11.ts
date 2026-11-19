/**
 * Wave 11 compiler extensions for conditional mana, mana spending restrictions,
 * cast/activation restrictions, counters/math, P/T doubling, draw difference,
 * life exchange, and protection (pure compiler helpers, zero runtime state).
 */
import type {
	AbilityDef,
	Amount,
	Condition,
	Duration,
	EffectStep,
	ObjectFilter,
	PlayerRef,
	Ref,
	Selector,
	Span,
	TargetSpec,
	TokenSpec
} from '../ir.ts';
import type { CounterType, ManaColor, ManaSpendingRestrictionSpec, PlainManaObjectFilter } from '../types.ts';
import { COUNTERS } from './costs.ts';
import type { EffectsWave9ParserLike } from './effectsWave9.ts';
import type { EffectsWave10Helpers } from './effectsWave10.ts';

export interface EffectsWave11Helpers extends EffectsWave10Helpers {
	compileQuotedAbilityString: (abilityText: string, cardName?: string) => AbilityDef[];
	buildTokenSpec: (power: number, toughness: number, desc: string, withClause: string) => TokenSpec;
	colorWord: (raw: string) => ManaColor | null;
	keywordList: (text: string, allowOr?: boolean) => string[] | null;
	parseManaRestriction: (text: string) => ManaSpendingRestrictionSpec | null;
}

const YOU: Selector = { k: 'player', filter: { relation: 'you' } };
const NONE: Selector = { k: 'none' };

const CARD_TYPES_MAP: Record<string, string> = {
	artifact: 'Artifact',
	artifacts: 'Artifact',
	battle: 'Battle',
	battles: 'Battle',
	creature: 'Creature',
	creatures: 'Creature',
	enchantment: 'Enchantment',
	enchantments: 'Enchantment',
	instant: 'Instant',
	instants: 'Instant',
	kindred: 'Kindred',
	land: 'Land',
	lands: 'Land',
	planeswalker: 'Planeswalker',
	planeswalkers: 'Planeswalker',
	sorcery: 'Sorcery',
	sorceries: 'Sorcery'
};

function parseCounterNameW11(raw: string): CounterType | null {
	const cleaned = raw.trim().toLowerCase().replace(/\s+counters?$/, '').trim();
	return COUNTERS[cleaned] ?? (cleaned ? (cleaned as CounterType) : null);
}

// ---- 1. Mana Spending Restrictions (CR 106.6) -----------------------------------------------

export function parseManaRestrictionWave11(
	rawText: string,
	singularSubtype: (s: string) => string | null
): ManaSpendingRestrictionSpec | null {
	const t = rawText.trim().replace(/\.$/, '').trim();

	// "This mana can't be spent to pay generic mana costs"
	if (/^this mana can't be spent to pay generic mana costs$/i.test(t)) {
		return { disallowGeneric: true };
	}

	// "Spend this mana only to cast a creature spell of the chosen type, and that spell can't be countered"
	if (
		/^spend this mana only to cast a creature spell of the chosen type, and that spell can't be countered$/i.test(
			t
		)
	) {
		return {
			allowSpells: { filter: { types: ['Creature'], ofChosenType: true } },
			onSpendCantBeCountered: true
		};
	}

	// "Spend this mana only to cast a creature spell of the chosen type or activate an ability of a creature source of the chosen type"
	if (
		/^spend this mana only to cast a creature spell of the chosen type or activate an ability of a creature source of the chosen type$/i.test(
			t
		)
	) {
		return {
			allowSpells: { filter: { types: ['Creature'], ofChosenType: true } },
			allowAbilities: { sourceFilter: { types: ['Creature'], ofChosenType: true } }
		};
	}

	// "Spend this mana only to cast an Elemental spell or activate an ability of an Elemental"
	const subtypeSpellOrAb = t.match(
		/^spend this mana only to cast (?:a|an) ([A-Za-z'-]+) spell or activate an ability of (?:a|an) ([A-Za-z'-]+)$/i
	);
	if (subtypeSpellOrAb) {
		const s1 = singularSubtype(subtypeSpellOrAb[1]);
		const s2 = singularSubtype(subtypeSpellOrAb[2]);
		if (s1 && s2) {
			return {
				allowSpells: { filter: { subtypes: [s1] } },
				allowAbilities: { sourceFilter: { subtypes: [s2] } }
			};
		}
	}

	// "Spend this mana only to cast instant, sorcery, Demon, and Spirit spells"
	const onlyMultiCast = t.match(/^spend this mana only to cast (.+?) spells$/i);
	if (onlyMultiCast) {
		const parts = onlyMultiCast[1]
			.replace(/,\s*(?:and|or|and\/or)\s+/gi, ', ')
			.replace(/\s+(?:and|or|and\/or)\s+/gi, ', ')
			.split(/\s*,\s*/)
			.map((s) => s.trim())
			.filter(Boolean);
		if (parts.length >= 2) {
			const types: string[] = [];
			const subtypes: string[] = [];
			let valid = true;
			for (const part of parts) {
				const ct = CARD_TYPES_MAP[part.toLowerCase()];
				if (ct) {
					types.push(ct);
				} else {
					const st = singularSubtype(part);
					if (st) subtypes.push(st);
					else {
						valid = false;
						break;
					}
				}
			}
			if (valid && (types.length > 0 || subtypes.length > 0)) {
				const anyOf: PlainManaObjectFilter[] = [];
				if (types.length > 0) anyOf.push({ types });
				if (subtypes.length > 0) anyOf.push({ subtypes });
				return {
					allowSpells: {
						filter: anyOf.length === 1 ? anyOf[0] : { anyOf }
					}
				};
			}
		}
	}

	return null;
}

// ---- 2. Activation Restrictions & Conditions ------------------------------------------------

export function parseActivateOnlyWave11(sTrim: string): {
	activatorWho?: 'opponent';
	sorcery?: boolean;
	onceEachTurn?: boolean;
	condition?: Condition;
} | null {
	const t = sTrim.trim().replace(/\.$/, '').trim();

	const onlyOpp = t.match(/^only your opponents may activate this ability(\s+and only as a sorcery)?$/i);
	if (onlyOpp) {
		return { activatorWho: 'opponent', sorcery: Boolean(onlyOpp[1]) };
	}

	if (/^activate only if you created a token this turn$/i.test(t)) {
		return { condition: { k: 'createdTokenThisTurn' } };
	}

	const sameNameLands = t.match(
		/^activate only if you control (three|two|four|\d+) or more lands with the same name$/i
	);
	if (sameNameLands) {
		const wordMap: Record<string, number> = { two: 2, three: 3, four: 4 };
		const min = /^\d+$/.test(sameNameLands[1])
			? parseInt(sameNameLands[1], 10)
			: (wordMap[sameNameLands[1].toLowerCase()] ?? 3);
		return { condition: { k: 'sameNameLandsControlledAtLeast', min } };
	}

	if (
		/^activate only if enchanted creature is white and untapped and only once each turn$/i.test(t)
	) {
		return {
			condition: { k: 'attachedPermanentMatches', colors: ['W'], untapped: true },
			onceEachTurn: true
		};
	}

	return null;
}

// ---- 3. Wave 11 Amounts ---------------------------------------------------------------------

export function parseAmountWave11(
	p: EffectsWave9ParserLike,
	raw: string,
	h: EffectsWave11Helpers
): Amount | null {
	const t = raw.trim().replace(/^the\s+/i, '').trim();

	// "twice X"
	if (/^twice\s+X$/i.test(raw.trim())) {
		return { k: 'mul', factor: 2, of: { k: 'x' } };
	}

	// "number of cards in defending player's hand minus the number of cards in your hand"
	if (/^number of cards in defending player's hand minus the number of cards in your hand$/i.test(t)) {
		return { k: 'handSizeDifference', targetPlayer: { k: 'defendingPlayer' } };
	}

	// "difference" (in context of hand size or poison counters)
	if (/^difference$/i.test(t)) {
		if (p.lastPlayer) {
			const pr = h.singlePlayer(p.lastPlayer);
			if (pr) return { k: 'handSizeDifference', targetPlayer: pr };
		}
		const prevCond = p.steps[p.steps.length - 1]?.condition;
		if (prevCond?.k === 'playerHasFewerCountersThan') {
			return {
				k: 'playerCounterDifference',
				player: { k: 'you' },
				counter: prevCond.counter,
				target: prevCond.max
			};
		}
		return { k: 'handSizeDifference', cap: 7 };
	}

	// "number of coins that came up heads"
	if (/^number of coins that came up heads$/i.test(t)) {
		return { k: 'coinHeadsCount' };
	}

	// "number of different mana values among cards in your graveyard"
	if (/^number of different mana values among cards in your graveyard$/i.test(t)) {
		return { k: 'p17bMetric', metric: 'distinctManaValuesInGraveyard' };
	}

	// "number of different powers among creatures you control"
	if (/^number of different powers among creatures you control$/i.test(t)) {
		return { k: 'distinctPowersControlled' };
	}

	// "number of differently named tokens you control"
	if (/^number of differently named tokens you control$/i.test(t)) {
		return { k: 'distinctNamesCount', of: { zone: 'battlefield', controller: 'you', token: true } };
	}

	// "amount of life you gained this turn"
	if (/^amount of life you gained this turn$/i.test(t)) {
		return { k: 'p17bMetric', metric: 'lifeGainedThisTurn' };
	}

	// "number of tokens you created this turn"
	if (/^number of tokens you created this turn$/i.test(t)) {
		return { k: 'tokensCreatedThisTurn' };
	}

	// "each nontoken creature that died under your control this turn"
	if (/^(?:number of )?nontoken creatures? that died under your control this turn$/i.test(t)) {
		return { k: 'nontokenCreaturesDiedThisTurn', controller: 'you' };
	}
	if (/^(?:number of )?nontoken creatures? that died this turn$/i.test(t)) {
		return { k: 'nontokenCreaturesDiedThisTurn', controller: 'any' };
	}

	// "number of cards that were put into your graveyard from your hand or library this turn"
	if (/^number of cards that were put into your graveyard from your hand or library this turn$/i.test(t)) {
		return { k: 'cardsPutIntoGraveyardFromHandOrLibraryThisTurn' };
	}

	// "damage dealt to your opponents this turn"
	if (/^(?:amount of )?damage dealt to your opponents this turn$/i.test(t)) {
		return { k: 'damageDealtToOpponentsThisTurn' };
	}

	// "amount of damage dealt to ~ this turn by sources they controlled"
	if (/^amount of damage dealt to ~ this turn by sources they controlled$/i.test(t)) {
		return { k: 'damageDealtToSelfByPlayerThisTurn', player: { k: 'eachLoopPlayer' } };
	}

	// "each player who lost life this turn"
	if (/^(?:number of )?players? who lost life this turn$/i.test(t)) {
		return { k: 'playersLostLifeThisTurnCount' };
	}

	// "greatest power among creatures you controlled as you cast ~"
	if (/^greatest power among creatures you controlled as you cast ~$/i.test(t)) {
		return {
			k: 'greatestStatAmongControlledAsCast',
			stat: 'power',
			filter: { zone: 'battlefield', types: ['Creature'], controller: 'you' }
		};
	}

	// "number of colors of mana spent to cast ~"
	if (/^number of colors of mana spent to cast ~$/i.test(t)) {
		return { k: 'colorsOfManaSpentToCast' };
	}

	// "number of counters among creatures you control" / "permanents you control"
	const cntAmong = t.match(/^number of counters among (.+)$/i);
	if (cntAmong) {
		const f = h.objectFilter(cntAmong[1].trim());
		if (f) return { k: 'totalCountersAmong', filter: { ...f, zone: 'battlefield' } };
	}

	// "number of opponents who control a creature with power N or greater"
	const oppCtrl = t.match(/^number of opponents who control (?:a|an) (.+)$/i);
	if (oppCtrl) {
		const f = h.objectFilter(oppCtrl[1].trim());
		if (f) return { k: 'opponentsControllingFilterCount', filter: { ...f, zone: 'battlefield' } };
	}

	// "number of counters on it" (with LKI fallback for dies/leaves triggers)
	if (/^number of counters on (?:it|~)$/i.test(t)) {
		return { k: 'countersOn', counter: 'any', of: { k: 'self' } };
	}

	// "your Ring-bearer's power"
	if (/^your ring-bearer's power$/i.test(t)) {
		return { k: 'ringBearerPower' };
	}

	// "number of creatures they control of the chosen type"
	if (/^number of creatures they control of the chosen type$/i.test(t)) {
		return {
			k: 'count',
			of: {
				zone: 'battlefield',
				types: ['Creature'],
				ofChosenType: true,
				controllerRef: p.lastPlayer ? (h.singlePlayer(p.lastPlayer) ?? { k: 'target', index: 0 }) : { k: 'target', index: 0 }
			}
		};
	}

	// "number of creatures target player controls"
	if (/^number of creatures target player controls$/i.test(t)) {
		const tIdx = p.targets.findIndex((tg) => tg.kind === 'player');
		const ref: PlayerRef = tIdx >= 0 ? { k: 'target', index: tIdx } : { k: 'target', index: 0 };
		return {
			k: 'count',
			of: { zone: 'battlefield', types: ['Creature'], controllerRef: ref }
		};
	}

	// "number of tapped creatures target opponent controls"
	if (/^(?:number of )?tapped creatures? target opponent controls$/i.test(t)) {
		const tIdx = p.targets.findIndex((tg) => tg.kind === 'player');
		const ref: PlayerRef = tIdx >= 0 ? { k: 'target', index: tIdx } : { k: 'target', index: 0 };
		return {
			k: 'count',
			of: { zone: 'battlefield', types: ['Creature'], tapped: true, controllerRef: ref }
		};
	}

	// "greatest power among creatures they control"
	if (/^greatest power among creatures they control$/i.test(t)) {
		const tIdx = p.targets.findIndex((tg) => tg.kind === 'player');
		const ref: PlayerRef = tIdx >= 0 ? { k: 'target', index: tIdx } : { k: 'target', index: 0 };
		return {
			k: 'greatestStatAmong',
			stat: 'power',
			filter: { zone: 'battlefield', types: ['Creature'], controllerRef: ref }
		};
	}

	// "mana value of that card" (after dig / reveal)
	if (/^mana value of that card$/i.test(t) && p.lastObject) {
		return { k: 'stat', of: p.lastObject.ref, stat: 'manaValue' };
	}

	// "sacrificed creature's power" / "mana value of the sacrificed permanent"
	if (/^sacrificed creature's power$/i.test(t)) {
		return { k: 'sacrificedCostStat', stat: 'power' };
	}
	if (/^mana value of the sacrificed permanent$/i.test(t)) {
		return { k: 'sacrificedCostStat', stat: 'manaValue' };
	}

	// "power of target creature you control"
	if (/^power of target creature you control$/i.test(t)) {
		const ref: Ref = p.lastObject?.ref ?? { k: 'target', index: 0 };
		return { k: 'stat', of: ref, stat: 'power' };
	}

	// "number of cards in your hand"
	if (/^number of cards in your hand$/i.test(t)) {
		return { k: 'cardsIn', zone: 'hand', of: { k: 'you' } };
	}

	// "number of <X> counters on ~"
	const ctrSelf = t.match(/^number of ([a-z0-9+/ -]+?) counters? on ~$/i);
	if (ctrSelf) {
		const cname = parseCounterNameW11(ctrSelf[1]);
		if (cname) return { k: 'countersOn', counter: cname, of: { k: 'self' } };
	}

	// "number of lore counters on ~"
	if (/^number of lore counters on ~$/i.test(t)) {
		return { k: 'countersOn', counter: 'lore', of: { k: 'self' } };
	}

	// "opponent(s) you have"
	if (/^(?:number of )?opponents?(?: you have)?$/i.test(t)) {
		return { k: 'opponentCount' };
	}

	// "equipped attacking creature(s) you control"
	if (/^(?:number of )?equipped attacking creatures? you control$/i.test(t)) {
		return {
			k: 'count',
			of: { zone: 'battlefield', types: ['Creature'], controller: 'you', attacking: true, equipped: true }
		};
	}

	return null;
}

// ---- 4. Wave 11 Conditions ------------------------------------------------------------------

export function parseConditionWave11(
	p: EffectsWave9ParserLike,
	rawText: string,
	h: EffectsWave11Helpers
): Condition | null {
	const t = rawText.trim().replace(/^if\s+/i, '').trim();

	if (/^~ was cast from your hand$/i.test(t)) return { k: 'spellCastFromHand' };
	if (/^~ was cast from a graveyard$/i.test(t)) return { k: 'spellCastFromGraveyard' };
	if (/^~ was cast from exile$/i.test(t)) return { k: 'spellCastFromExile' };
	if (/^~ was kicked$/i.test(t)) return { k: 'kicked' };
	if (/^~'s prowl cost was paid$/i.test(t)) return { k: 'paidAltCost', kind: 'prowl' };
	if (/^the gift was promised$/i.test(t)) return { k: 'giftPromised' };
	if (/^you haven't cast a spell this turn$/i.test(t)) return { k: 'noSpellCastThisTurn' };
	if (/^you played a land this turn$/i.test(t)) return { k: 'playedLandThisTurn' };
	if (/^you didn't draw cards this way$/i.test(t)) return { k: 'notDrawnCardsThisWay' };
	if (/^you revealed it this way$/i.test(t)) return { k: 'didRevealThisWay' };
	if (/^a creature card was discarded this way$/i.test(t)) return { k: 'discardedCreatureThisWay' };
	if (/^a noncreature card was discarded this way$/i.test(t)) return { k: 'discardedNoncreatureThisWay' };
	if (/^the discarded card wasn't a land card$/i.test(t)) return { k: 'discardedNonlandThisWay' };
	if (/^a land card was milled this way$/i.test(t)) return { k: 'landCardMilledThisWay' };
	if (/^the player mills at least one creature card this way$/i.test(t)) {
		return { k: 'creatureCardMilledThisWay' };
	}
	if (/^a nonland permanent is sacrificed this way$/i.test(t)) {
		return { k: 'sacrificedNonlandThisWay' };
	}
	if (/^you don't put the card onto the battlefield$/i.test(t)) {
		return { k: 'didntPutOntoBattlefieldThisWay' };
	}
	if (/^you cast a creature spell this way$/i.test(t)) {
		return { k: 'castTriggerCreatureSpell' };
	}
	if (/^you have fewer than seven cards in hand$/i.test(t)) {
		return { k: 'playerHasFewerHandThan', max: 7 };
	}
	if (/^that player has more cards in hand than you$/i.test(t)) {
		const pr = p.lastPlayer ? (h.singlePlayer(p.lastPlayer) ?? { k: 'you' as const }) : { k: 'you' as const };
		return { k: 'opponentHasMoreCardsInHandThan', who: pr };
	}
	if (/^target player has fewer than nine poison counters$/i.test(t)) {
		return { k: 'targetHasFewerCountersThan', counter: 'poison', max: 9 };
	}
	if (/^you control an attacking legendary creature$/i.test(t)) {
		return { k: 'controlAttackingLegendary' };
	}
	if (/^~ has a \+1\/\+1 counter on it$/i.test(t)) {
		return { k: 'sourceHasCounter', counter: '+1/+1', min: 1 };
	}
	const selfHasCtr = t.match(/^it has (\S+) or more ([a-z0-9+/ -]+?) counters? on it$/i);
	if (selfHasCtr) {
		const min = h.numberWord(selfHasCtr[1]) ?? 1;
		const cname = parseCounterNameW11(selfHasCtr[2]);
		if (cname) return { k: 'sourceHasCounter', counter: cname, min };
	}
	if (/^there (?:are|were) three or more card types among the sacrificed permanents$/i.test(t)) {
		return { k: 'distinctCardTypesAmongSacrificedAtLeast', min: 3 };
	}
	if (/^there are three or more ribbon counters on ~$/i.test(t)) {
		return { k: 'sourceHasCounter', counter: 'ribbon', min: 3 };
	}
	if (/^two or more cards are exiled this way$/i.test(t)) {
		return { k: 'exiledCountAtLeast', min: 2 };
	}
	if (/^an opponent controls more lands than you$/i.test(t)) {
		return { k: 'opponentComparison', metric: 'lands' };
	}
	if (/^creatures you control have total power (\d+) or greater$/i.test(t)) {
		const nVal = parseInt(t.match(/(\d+)/)![1], 10);
		return {
			k: 'compare',
			left: { k: 'totalStatAmong', filter: { zone: 'battlefield', types: ['Creature'], controller: 'you' }, stat: 'power' },
			op: '>=',
			right: { k: 'const', n: nVal }
		};
	}
	if (/^an opponent was dealt (\d+) or more damage this turn$/i.test(t)) {
		const nVal = parseInt(t.match(/(\d+)/)![1], 10);
		return { k: 'playerLostLifeAtLeastThisTurn', min: nVal, opponentOnly: true };
	}
	if (/^you attacked with three or more creatures this turn$/i.test(t)) {
		return { k: 'creaturesAttackedCountThisTurn', min: 3 };
	}
	if (/^X is (\d+) or more$/i.test(t)) {
		const nVal = parseInt(t.match(/(\d+)/)![1], 10);
		return { k: 'compare', left: { k: 'x' }, op: '>=', right: { k: 'const', n: nVal } };
	}
	if (/^X is three or more$/i.test(t)) {
		return { k: 'compare', left: { k: 'x' }, op: '>=', right: { k: 'const', n: 3 } };
	}
	if (/^its power is greater than each other creature's power$/i.test(t)) {
		return { k: 'eventObjectGreatestPowerAmongAll' };
	}
	if (/^~ is your ring-bearer and the ring has tempted you two or more times this game$/i.test(t)) {
		return { k: 'ringBearerAndTemptedAtLeast', min: 2 };
	}
	if (/^you control a Squirrel or returned a Squirrel card to your hand this way$/i.test(t)) {
		return {
			k: 'or',
			of: [
				{ k: 'controlsFilter', filter: { zone: 'battlefield', subtypes: ['Squirrel'] } },
				{ k: 'returnedFilterToHandThisWay', filter: { subtypes: ['Squirrel'] } }
			]
		};
	}

	return null;
}

// ---- 5. Sentence & Clause Parser for Mana / Restrictions / Counters / Math / Protection ------

export function parseSentenceManaCountersWave11(
	p: EffectsWave9ParserLike,
	rawText: string,
	span: Span,
	h: EffectsWave11Helpers
): boolean {
	const t = rawText.trim().replace(/\.$/, '').trim();

	// 1. Mana: *Nykthos* / *Astral Cornucopia* — "Add <amount> mana of that color [equal to ... / for each ...]"
	// (Preceded by "Choose a color.")
	const addChosenColorM = t.match(
		/^add (?:an amount of )?(?:(\S+) )?mana of that color(?:\s+(?:equal to|for each)\s+(.+))?$/i
	);
	if (addChosenColorM) {
		const baseWord = addChosenColorM[1]?.toLowerCase();
		const tailExpr = addChosenColorM[2]?.trim();
		let amt: Amount | null = null;
		if (tailExpr) {
			if (/^your devotion to that color$/i.test(tailExpr)) {
				amt = { k: 'devotion', colors: ['W'] }; // runtime substitutes chosen color!
			} else if (/^charge counters? on ~$/i.test(tailExpr)) {
				amt = { k: 'countersOn', counter: 'charge', of: { k: 'self' } };
			} else {
				amt = h.equalTo(p, tailExpr) ?? parseAmountWave11(p, tailExpr, h);
			}
		} else if (baseWord) {
			amt = h.amountWord(p, baseWord);
		}
		if (amt) {
			p.push(
				{
					verb: 'addMana',
					subject: YOU,
					amount: amt,
					params: { addManaChosenColorAmount: amt, manaCombinationColors: 'any' },
					span
				},
				false
			);
			return true;
		}
	}

	// 2. *Faeburrow Elder*: "For each color among permanents you control, add one mana of that color"
	if (/^for each color among permanents you control, add one mana of that color$/i.test(t)) {
		p.push(
			{
				verb: 'addMana',
				subject: YOU,
				params: { addManaPerColorControlled: true },
				span
			},
			false
		);
		return true;
	}

	// 3. *Chrome Mox* / *Pit of Offerings*: "Add one mana of any of the exiled card's/cards' colors"
	if (/^add one mana of any of the exiled cards?'s? colors$/i.test(t)) {
		p.push(
			{
				verb: 'addMana',
				subject: YOU,
				amount: { k: 'const', n: 1 },
				params: { addManaFromExiledColors: true },
				span
			},
			false
		);
		return true;
	}

	// 4. *Incubation Druid* follow-up: "If ~ has a +1/+1 counter on it, add three mana of that type instead"
	if (/^if ~ has a \+1\/\+1 counter on it, add three mana of that type instead$/i.test(t)) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'addMana') {
			prev.amount = {
				k: 'conditional',
				condition: { k: 'sourceHasCounter', counter: '+1/+1', min: 1 },
				then: { k: 'const', n: 3 },
				else: { k: 'const', n: 1 }
			};
			return true;
		}
	}

	// 5. *River of Tears* follow-up: "If you played a land this turn, add {B} instead"
	if (/^if you played a land this turn, add \{([WUBRGC])\} instead$/i.test(t)) {
		const col = t.match(/\{([WUBRGC])\}/i)![1].toUpperCase() as ManaColor;
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'addMana') {
			const origMana = prev.params?.mana ? [...prev.params.mana] : (['U'] as ManaColor[]);
			prev.params = {
				...prev.params,
				mana: undefined,
				manaChoice: undefined
			};
			// Emit two mutually exclusive conditional addMana steps
			p.steps[p.steps.length - 1] = {
				verb: 'addMana',
				subject: YOU,
				condition: { k: 'not', of: { k: 'playedLandThisTurn' } },
				params: { mana: origMana },
				span: prev.span
			};
			p.push(
				{
					verb: 'addMana',
					subject: YOU,
					condition: { k: 'playedLandThisTurn' },
					params: { mana: [col] },
					span
				},
				false
			);
			return true;
		}
	}

	// 6. *Opal Palace* follow-up: "If you spend this mana to cast your commander, it enters with ..."
	if (
		/^if you spend this mana to cast your commander, it enters with a number of additional \+1\/\+1 counters on it equal to the number of times it's been cast from the command zone this game$/i.test(
			t
		)
	) {
		let attached = false;
		for (let i = p.steps.length - 1; i >= 0 && p.steps[i]?.verb === 'addMana'; i--) {
			const prev = p.steps[i];
			prev.params = {
				...prev.params,
				manaRestrictionSpec: {
					...prev.params?.manaRestrictionSpec,
					onSpendCommanderBonusCounters: true
				}
			};
			attached = true;
		}
		if (attached) return true;
	}

	// 7. *Yuna, Grand Summoner* / *Solar Array*: "When you next cast a creature/artifact spell this turn, ..."
	if (
		/^when you next cast a creature spell this turn, that creature enters with two additional \+1\/\+1 counters on it$/i.test(
			t
		)
	) {
		p.push(
			{
				verb: 'grantPlayer',
				subject: YOU,
				params: { nextCreatureEntersWithPlusCounters: { k: 'const', n: 2 } },
				span
			},
			false
		);
		return true;
	}
	if (/^when you next cast an artifact spell this turn, that spell gains sunburst$/i.test(t)) {
		p.push(
			{
				verb: 'grantPlayer',
				subject: YOU,
				params: { playerRules: ['nextArtifactSpellGainsSunburst'] },
				span
			},
			false
		);
		return true;
	}

	// 8. *Lux Artillery*: "it gains sunburst" (triggered on casting artifact creature spell)
	if (/^it gains sunburst$/i.test(t)) {
		p.push(
			{
				verb: 'grant',
				subject: { k: 'eventObject' },
				params: { grantTriggerSpellSunburst: true, duration: 'endOfTurn' },
				span
			},
			false
		);
		return true;
	}

	// 9. *Domri* +1: "Creature spells you cast this turn can't be countered"
	if (/^creature spells you cast this turn can't be countered$/i.test(t)) {
		p.push(
			{
				verb: 'grantPlayer',
				subject: YOU,
				params: { playerRules: ['creatureSpellsCantBeCounteredThisTurn'] },
				span
			},
			false
		);
		return true;
	}

	// 10. *Summer Bloom*: "You may play up to three additional lands this turn"
	const extraLandsM = t.match(/^you may play (?:up to )?(\S+) additional lands? this turn$/i);
	if (extraLandsM) {
		const num = h.numberWord(extraLandsM[1]) ?? 1;
		p.push(
			{
				verb: 'grantPlayer',
				subject: YOU,
				params: { playerRules: ['extraLandPlay'], extraLandPlays: num },
				span
			},
			false
		);
		return true;
	}

	// 11. *Mana Drain*: "At the beginning of your next main phase, add an amount of {C} equal to that spell's mana value"
	if (
		/^at the beginning of your next main phase, add an amount of \{C\} equal to that spell's mana value$/i.test(
			t
		)
	) {
		const ref: Ref = p.itRef() ?? p.lastObject?.ref ?? { k: 'target', index: 0 };
		p.push(
			{
				verb: 'grantPlayer',
				subject: YOU,
				params: { nextMainPhaseAddMana: { color: 'C', amount: { k: 'stat', of: ref, stat: 'manaValue', lki: true } } },
				span
			},
			false
		);
		return true;
	}

	// 12. *Abeyance*: "Until end of turn, target player can't cast instant or sorcery spells, and that player can't activate abilities that aren't mana abilities"
	if (
		/^until end of turn, target player can't cast instant or sorcery spells, and that player can't activate abilities that aren't mana abilities$/i.test(
			t
		)
	) {
		const idx = p.addTarget({ kind: 'player', filter: {}, player: { relation: 'any' }, min: 1, max: 1 });
		p.push(
			{
				verb: 'grantPlayer',
				subject: { k: 'target', index: idx },
				params: {
					playerRules: ['cantCastInstantsOrSorceriesThisTurn', 'cantActivateNonManaAbilitiesThisTurn']
				},
				span
			},
			false
		);
		return true;
	}

	// 13. *Ranger-Captain of Eos* / *Calamity's Wake*: "Your opponents/Players can't cast noncreature spells this turn"
	if (/^your opponents can't cast noncreature spells this turn$/i.test(t)) {
		p.push(
			{
				verb: 'grantPlayer',
				subject: { k: 'player', filter: { relation: 'each_opponent' } },
				params: { playerRules: ['cantCastNoncreatureSpellsThisTurn'] },
				span
			},
			false
		);
		return true;
	}
	if (/^players can't cast noncreature spells this turn$/i.test(t)) {
		p.push(
			{
				verb: 'grantPlayer',
				subject: { k: 'player', filter: { relation: 'each_player' } },
				params: { playerRules: ['cantCastNoncreatureSpellsThisTurn'] },
				span
			},
			false
		);
		return true;
	}

	// 14. *Bilbo's Gambit*: "If the gift was promised, players can't cast spells this turn"
	if (/^if the gift was promised, players can't cast spells this turn$/i.test(t)) {
		p.push(
			{
				verb: 'grantPlayer',
				subject: { k: 'player', filter: { relation: 'each_player' } },
				condition: { k: 'giftPromised' },
				params: { playerRules: ['allPlayersCantCastSpellsThisTurn'] },
				span
			},
			false
		);
		return true;
	}

	// 15. *Elspeth Conquers Death* II: "Noncreature spells your opponents cast cost {2} more to cast until your next turn"
	const ecdTaxM = t.match(
		/^noncreature spells your opponents cast cost \{(\d+)\} more to cast until your next turn$/i
	);
	if (ecdTaxM) {
		p.push(
			{
				verb: 'grantPlayer',
				subject: YOU,
				params: {
					opponentsSpellsCostMoreUntilNextTurn: {
						noncreatureOnly: true,
						mana: parseInt(ecdTaxM[1], 10)
					}
				},
				span
			},
			false
		);
		return true;
	}

	// 16. *Summon: Yojimbo* II/III: "Until your next turn, creatures can't attack you unless their controller pays {2} for each of those creatures"
	const yojimboM = t.match(
		/^until your next turn, creatures can't attack you unless their controller pays \{(\d+)\} for each of those creatures$/i
	);
	if (yojimboM) {
		p.push(
			{
				verb: 'grantPlayer',
				subject: YOU,
				params: { attackTaxUntilYourNextTurn: parseInt(yojimboM[1], 10) },
				span
			},
			false
		);
		return true;
	}

	// 17. *Scarring Memories*: "You may cast ~ as though it had flash if you control an attacking legendary creature"
	if (/^you may cast ~ as though it had flash if you control an attacking legendary creature$/i.test(t)) {
		// Static cast-time permission; handled as a no-op restriction sentence or condition.
		// Pushing nothing and returning true would leave empty steps if sole sentence; instead this is stripped or handled via card.ts RESTRICTION_SENTENCES.
		return false;
	}

	// 18. *Neheb, Dreadhorde Champion*: "you may discard any number of cards. If you do, draw that many cards and add that much {R}. Until end of turn, you don't lose this mana as steps and phases end."
	if (/^until end of turn, you don't lose this mana as steps and phases end$/i.test(t)) {
		let attached = false;
		for (let i = p.steps.length - 1; i >= 0; i--) {
			if (p.steps[i]?.verb === 'addMana') {
				p.steps[i].params = { ...p.steps[i].params, retainManaUntilEndOfTurn: true };
				attached = true;
			}
		}
		if (attached) return true;
	}
	if (/^you may discard any number of cards$/i.test(t)) {
		p.push(
			{
				verb: 'discard',
				subject: YOU,
				amount: { k: 'const', n: 99 },
				optional: { chooser: { k: 'you' } },
				params: { upTo: true },
				span
			},
			false
		);
		p.lastOptionalStep = p.steps.length - 1;
		return true;
	}
	if (/^add that much \{R\}$/i.test(t) || /^draw that many cards and add that much \{R\}$/i.test(t)) {
		const isBoth = /^draw that many cards/i.test(t);
		const amt: Amount = { k: 'countedThisWay', kind: 'discardedThisWay' };
		if (isBoth) {
			p.push({ verb: 'draw', subject: YOU, amount: amt, span }, false);
		}
		p.push(
			{
				verb: 'addMana',
				subject: YOU,
				amount: amt,
				params: { mana: ['R'] },
				span
			},
			false
		);
		return true;
	}

	// 19. *Leyline Tyrant*: "you may pay any amount of {R}. When you do, it deals that much damage to any target."
	if (/^you may pay any amount of \{R\}$/i.test(t)) {
		p.push(
			{
				verb: 'grant',
				subject: { k: 'self' },
				params: { payAnyManaForDamage: 'R', duration: 'endOfTurn' },
				span
			},
			false
		);
		p.lastOptionalStep = p.steps.length - 1;
		return true;
	}
	if (/^when you do, it deals that much damage to any target$/i.test(t)) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'grant' && prev.params?.payAnyManaForDamage) {
			const tIdx = p.addTarget({
				kind: 'objectOrPlayer',
				filter: { zone: 'battlefield', types: ['Creature', 'Planeswalker', 'Battle'] },
				player: { relation: 'any' },
				min: 1,
				max: 1
			});
			p.push(
				{
					verb: 'damage',
					subject: { k: 'target', index: tIdx },
					amount: { k: 'lastEffectAmount' },
					ifPrecedingAccepted: p.steps.length - 1,
					span
				},
				true
			);
			return true;
		}
	}

	// 20. *Well of Lost Dreams*: "you may pay {X}, where X is less than or equal to the amount of life you gained. If you do, draw X cards"
	if (/^you may pay \{X\}, where X is less than or equal to the amount of life you gained$/i.test(t)) {
		p.push(
			{
				verb: 'grant',
				subject: { k: 'self' },
				params: { payUpToLifeGainedManaToDraw: true, duration: 'endOfTurn' },
				span
			},
			false
		);
		p.lastOptionalStep = p.steps.length - 1;
		return true;
	}
	if (/^if you do, draw X cards$/i.test(t)) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'grant' && prev.params?.payUpToLifeGainedManaToDraw) {
			p.push(
				{
					verb: 'draw',
					subject: YOU,
					amount: { k: 'lastEffectAmount' },
					ifPrecedingAccepted: p.steps.length - 1,
					span
				},
				false
			);
			return true;
		}
	}

	// 21. *Goldberry, River-Daughter*:
	// - "Move a counter of each kind not on ~ from another target permanent you control onto ~"
	if (
		/^move a counter of each kind not on ~ from another target permanent you control onto ~$/i.test(t)
	) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', controller: 'you', other: true },
			min: 1,
			max: 1
		});
		p.push(
			{
				verb: 'moveCounters',
				subject: { k: 'self' },
				amount: { k: 'const', n: 1 },
				params: {
					moveCounterSpec: {
						from: { k: 'target', index: idx },
						counter: 'any',
						eachKindNotOnDest: true
					}
				},
				span
			},
			true
		);
		return true;
	}
	// - "Move one or more counters from ~ onto another target permanent you control"
	if (/^move one or more counters from ~ onto another target permanent you control$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', controller: 'you', other: true },
			min: 1,
			max: 1
		});
		p.push(
			{
				verb: 'moveCounters',
				subject: { k: 'target', index: idx },
				amount: { k: 'const', n: 1 },
				params: {
					moveCounterSpec: {
						from: { k: 'self' },
						counter: 'any',
						oneOrMore: true
					}
				},
				span
			},
			true
		);
		return true;
	}

	// 22. *Nesting Grounds* / *Resourceful Defense* / *Tidus*:
	// "Move (a|any number of) counter(s) from target <A> onto a second target <B>"
	const moveTwoTargets = t.match(
		/^(?:you may )?move (a|any number of) counters? from target (.+?) onto (?:a second )?target (.+)$/i
	);
	if (moveTwoTargets) {
		const isAnyNum = /any number/i.test(moveTwoTargets[1]);
		const srcSpec = h.targetPhrase(p, moveTwoTargets[2].trim());
		const dstSpec = h.targetPhrase(p, moveTwoTargets[3].trim());
		if (srcSpec && dstSpec) {
			const srcIdx = p.addTarget({ ...srcSpec, min: 1, max: 1 });
			const dstIdx = p.addTarget({ ...dstSpec, min: 1, max: 1, otherTarget: true });
			const isMay = /^you may /i.test(t);
			p.push(
				{
					verb: 'moveCounters',
					subject: { k: 'target', index: dstIdx },
					amount: { k: 'const', n: isAnyNum ? 999 : 1 },
					...(isMay ? { optional: { chooser: { k: 'you' } } } : {}),
					params: {
						moveCounterSpec: {
							from: { k: 'target', index: srcIdx },
							counter: 'any',
							...(isAnyNum ? { anyNumber: true, all: true } : { chooseKindOnPermanent: true })
						}
					},
					span
				},
				true
			);
			return true;
		}
	}

	// 23. *Slippery Bogbonder*: "Then move any number of counters from among creatures you control onto that creature"
	if (/^(?:then )?move any number of counters from among (.+?) onto that creature$/i.test(t)) {
		const m = t.match(/from among (.+?) onto that creature$/i)!;
		const srcFilter = h.objectFilter(m[1].trim());
		const destRef: Ref = p.lastObject?.ref ?? { k: 'target', index: 0 };
		if (srcFilter) {
			p.push(
				{
					verb: 'moveCounters',
					subject: destRef.k === 'target' ? { k: 'target', index: destRef.index } : { k: 'binding', name: destRef.k === 'binding' ? destRef.name : 'moved' },
					amount: { k: 'const', n: 999 },
					params: {
						moveCounterSpec: {
							from: { k: 'all', filter: { ...srcFilter, zone: 'battlefield' } },
							counter: 'any',
							fromAnyPermanents: true,
							anyNumber: true,
							all: true
						}
					},
					span
				},
				false
			);
			return true;
		}
	}

	// 24. *Resourceful Defense* trig / *Yuna* trig / *Oft-Nabbed Goat*:
	// "put those counters on target permanent you control" / "you may put that number of +1/+1 counters on target creature"
	if (/^put those counters on target permanent you control$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', controller: 'you' },
			min: 1,
			max: 1
		});
		p.push(
			{
				verb: 'putCounters',
				subject: { k: 'target', index: idx },
				params: { copyCountersFrom: { k: 'eventObject' } },
				span
			},
			true
		);
		return true;
	}
	if (/^(?:you may )?put that number of \+1\/\+?1 counters on target creature$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'] },
			min: 1,
			max: 1
		});
		const isMay = /^you may /i.test(t);
		p.push(
			{
				verb: 'putCounters',
				subject: { k: 'target', index: idx },
				amount: { k: 'lkiTotalCounters', of: { k: 'eventObject' } },
				...(isMay ? { optional: { chooser: { k: 'you' } } } : {}),
				params: { counter: '+1/+1' },
				span
			},
			true
		);
		return true;
	}

	// 25. *Clockspinning* & *Ichormoon Gauntlet*:
	// "Choose a counter on target permanent [or suspended card]. Remove that counter ... or put another of those counters on it."
	if (/^choose a counter on target permanent or suspended card$/i.test(t)) {
		p.addTarget({
			kind: 'object',
			filter: { zone: ['battlefield', 'exile'] },
			zones: ['battlefield', 'exile'],
			min: 1,
			max: 1
		});
		return true;
	}
	if (/^remove that counter from that permanent or card or put another of those counters on it$/i.test(t)) {
		p.push(
			{
				verb: 'moveCounters',
				subject: { k: 'target', index: 0 },
				amount: { k: 'const', n: 1 },
				params: {
					moveCounterSpec: {
						from: { k: 'target', index: 0 },
						counter: 'any',
						putOrRemoveKind: true
					}
				},
				span
			},
			true
		);
		return true;
	}
	if (/^choose a counter on target permanent$/i.test(t)) {
		p.addTarget({ kind: 'object', filter: { zone: 'battlefield' }, min: 1, max: 1 });
		return true;
	}
	if (/^put an additional counter of that kind on that permanent$/i.test(t)) {
		p.push(
			{
				verb: 'putCounters',
				subject: { k: 'target', index: 0 },
				amount: { k: 'const', n: 1 },
				params: { chooseCounterOnSubjectAndAddOne: true },
				span
			},
			true
		);
		return true;
	}

	// 26. *Aberrant Return*: "Each of them enters with an additional -1/-1 counter on it"
	const entersAddCtrM = t.match(/^each of them enters with an additional ([+-]\d+\/[+-]\d+|[a-z]+) counter on it$/i);
	if (entersAddCtrM) {
		const cname = parseCounterNameW11(entersAddCtrM[1]);
		const prev = p.steps[p.steps.length - 1];
		if (cname && prev?.verb === 'move') {
			prev.params = { ...prev.params, withCounters: { counter: cname, count: 1 } };
			return true;
		}
	}

	// 27. *Forge of Heroes* / *Elspeth Conquers Death* III:
	// "Put a +1/+1 counter on it if it's a creature and a loyalty counter on it if it's a planeswalker"
	// "Put a +1/+1 counter or a loyalty counter on it"
	if (
		/^put a \+1\/\+1 counter on it if it's a creature and a loyalty counter on it if it's a planeswalker$/i.test(
			t
		) ||
		/^put a \+1\/\+1 counter or a loyalty counter on it$/i.test(t)
	) {
		const ref = p.lastObject?.ref ?? { k: 'target', index: 0 };
		const subj: Selector =
			ref.k === 'target' ? { k: 'target', index: ref.index } : { k: 'binding', name: ref.k === 'binding' ? ref.name : 'moved' };
		p.push(
			{
				verb: 'putCounters',
				subject: subj,
				amount: { k: 'const', n: 1 },
				params: {
					conditionalCounterOnType: {
						creatureCounter: '+1/+1',
						planeswalkerCounter: 'loyalty',
						playerChooses: /or a loyalty counter/i.test(t)
					}
				},
				span
			},
			false
		);
		return true;
	}

	// 28. *Communal Brewing*:
	// "any number of target opponents each draw a card"
	// "Put an ingredient counter on ~, then put an ingredient counter on it for each card drawn this way"
	// "that creature enters with X additional +1/+1 counters on it, where X is the number of ingredient counters on ~"
	if (/^any number of target opponents each draw a card$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'player',
			filter: {},
			player: { relation: 'opponent' },
			min: 0,
			max: 99
		});
		p.push({ verb: 'draw', subject: { k: 'target', index: idx }, amount: { k: 'const', n: 1 }, span }, false);
		return true;
	}
	if (/^put an ingredient counter on ~, then put an ingredient counter on it for each card drawn this way$/i.test(t)) {
		p.push(
			{
				verb: 'putCounters',
				subject: { k: 'self' },
				amount: { k: 'sum', args: [{ k: 'const', n: 1 }, { k: 'countedThisWay', kind: 'drawnThisWay' }] },
				params: { counter: 'ingredient' as CounterType },
				span
			},
			false
		);
		return true;
	}
	if (/^that creature enters with X additional \+1\/\+1 counters on it, where X is the number of ingredient counters on ~$/i.test(t)) {
		p.push(
			{
				verb: 'putCounters',
				subject: { k: 'eventObject' },
				amount: { k: 'countersOn', counter: 'ingredient' as CounterType, of: { k: 'self' } },
				params: { counter: '+1/+1' },
				span
			},
			false
		);
		return true;
	}

	// 29. *Dark Intimations*: "That planeswalker enters with an additional loyalty counter on it"
	if (/^that planeswalker enters with an additional loyalty counter on it$/i.test(t)) {
		p.push(
			{
				verb: 'putCounters',
				subject: { k: 'eventObject' },
				amount: { k: 'const', n: 1 },
				params: { counter: 'loyalty', castBolasBonusLoyalty: true },
				span
			},
			false
		);
		return true;
	}

	// 30. *Exponential Growth*: "Until end of turn, double target creature's power X times"
	if (/^until end of turn, double target creature's power X times$/i.test(t)) {
		const idx = p.addTarget({ kind: 'object', filter: { zone: 'battlefield', types: ['Creature'] }, min: 1, max: 1 });
		p.push(
			{
				verb: 'doubleOrTriple',
				subject: { k: 'target', index: idx },
				params: {
					doubleSpec: { factor: 2, target: 'power', duration: 'endOfTurn' },
					repeatFactorCount: { k: 'x' }
				},
				span
			},
			true
		);
		return true;
	}

	// 31. *Inversion Behemoth*: "switch the power and toughness of each of any number of target creatures until end of turn"
	if (/^switch the power and toughness of each of any number of target creatures until end of turn$/i.test(t)) {
		const idx = p.addTarget({ kind: 'object', filter: { zone: 'battlefield', types: ['Creature'] }, min: 0, max: 99 });
		p.push(
			{
				verb: 'switchPT',
				subject: { k: 'target', index: idx },
				params: { duration: 'endOfTurn' },
				span
			},
			true
		);
		return true;
	}

	// 32. *Tree of Perdition*: "Exchange target opponent's life total with ~'s toughness"
	if (/^exchange target opponent's life total with ~'s toughness$/i.test(t)) {
		const idx = p.addTarget({ kind: 'player', filter: {}, player: { relation: 'opponent' }, min: 1, max: 1 });
		p.push(
			{
				verb: 'exchange',
				subject: { k: 'target', index: idx },
				params: { exchangeSpec: { kind: 'lifeAndToughness', second: { k: 'self' } } },
				span
			},
			true
		);
		return true;
	}

	// 33. *All-Seeing Arbiter*: "target creature an opponent controls gets -X/-0 until your next turn, where X is ..."
	const arbM = t.match(
		/^target creature an opponent controls gets ([+-]\d+|[-+]X)\/([+-]\d+|[-+]X) until your next turn, where X is (.+)$/i
	);
	if (arbM) {
		const amt = parseAmountWave11(p, arbM[3].trim(), h) ?? h.equalTo(p, arbM[3].trim());
		if (amt) {
			const idx = p.addTarget({
				kind: 'object',
				filter: { zone: 'battlefield', types: ['Creature'], controller: 'opponent' },
				min: 1,
				max: 1
			});
			const negAmt: Amount = arbM[1].startsWith('-') ? { k: 'negate', of: amt } : amt;
			p.push(
				{
					verb: 'pump',
					subject: { k: 'target', index: idx },
					amount: negAmt,
					params: { toughness: { k: 'const', n: 0 }, duration: 'untilYourNextTurn' },
					span
				},
				true
			);
			return true;
		}
	}

	// 34. *Blossoming Bogbeast*: "Then creatures you control gain trample and get +X/+X until end of turn, where X is the amount of life you gained this turn"
	if (
		/^then creatures you control gain trample and get \+X\/\+X until end of turn, where X is the amount of life you gained this turn$/i.test(
			t
		)
	) {
		const amt: Amount = { k: 'p17bMetric', metric: 'lifeGainedThisTurn' };
		const filt: ObjectFilter = { zone: 'battlefield', types: ['Creature'], controller: 'you' };
		p.push(
			{
				verb: 'grant',
				subject: { k: 'all', filter: filt },
				params: { keywords: ['Trample'], duration: 'endOfTurn' },
				span
			},
			true
		);
		p.push(
			{
				verb: 'pump',
				subject: { k: 'all', filter: filt },
				amount: amt,
				params: { toughness: amt, duration: 'endOfTurn' },
				span
			},
			true
		);
		return true;
	}

	// 35. *Obsessive Pursuit*: "put X +1/+1 counters on target attacking creature, where X is the number of permanents you've sacrificed this turn"
	if (
		/^put X \+1\/\+1 counters on target attacking creature, where X is the number of permanents you've sacrificed this turn$/i.test(
			t
		)
	) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'], attacking: true },
			min: 1,
			max: 1
		});
		const amt: Amount = { k: 'sacrificedPermsThisTurn' };
		p.definedX = amt;
		p.push(
			{
				verb: 'putCounters',
				subject: { k: 'target', index: idx },
				amount: amt,
				params: { counter: '+1/+1' },
				span
			},
			true
		);
		return true;
	}

	// 36. *Vraska* -9: "If target player has fewer than nine poison counters, they get a number of poison counters equal to the difference"
	if (/^if target player has fewer than nine poison counters, they get a number of poison counters equal to the difference$/i.test(t)) {
		const idx = p.addTarget({ kind: 'player', filter: {}, player: { relation: 'any' }, min: 1, max: 1 });
		p.push(
			{
				verb: 'putPlayerCounters',
				subject: { k: 'target', index: idx },
				amount: {
					k: 'playerCounterDifference',
					player: { k: 'target', index: idx },
					counter: 'poison',
					target: 9
				},
				condition: { k: 'targetHasFewerCountersThan', counter: 'poison', max: 9 },
				params: { playerCounter: 'poison' },
				span
			},
			false
		);
		return true;
	}

	// 37. *Giver of Runes*: "Another target creature you control gains protection from colorless or from the color of your choice until end of turn"
	if (
		/^another target creature you control gains protection from colorless or from the color of your choice until end of turn$/i.test(
			t
		)
	) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'], controller: 'you', other: true },
			min: 1,
			max: 1
		});
		p.push(
			{
				verb: 'grant',
				subject: { k: 'target', index: idx },
				params: { chooseProtectionColor: true, duration: 'endOfTurn' },
				span
			},
			true
		);
		return true;
	}

	// 38. *Eldritch Immunity*: "Target creature you control gains protection from each color until end of turn"
	if (/^target creature you control gains protection from each color until end of turn$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'], controller: 'you' },
			min: 1,
			max: 1
		});
		p.push(
			{
				verb: 'grant',
				subject: { k: 'target', index: idx },
				params: {
					keywords: [
						'Protection from white',
						'Protection from blue',
						'Protection from black',
						'Protection from red',
						'Protection from green'
					],
					duration: 'endOfTurn'
				},
				span
			},
			true
		);
		return true;
	}

	// 39. *Vines of Vastwood*: "Target creature can't be the target of spells or abilities your opponents control this turn"
	if (/^target creature can't be the target of spells or abilities your opponents control this turn$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'] },
			min: 1,
			max: 1
		});
		p.push(
			{
				verb: 'grant',
				subject: { k: 'target', index: idx },
				params: { keywords: ['Hexproof'], duration: 'endOfTurn' },
				span
			},
			true
		);
		return true;
	}

	// 40. *Rikku*: "until end of turn, that creature can't be blocked by creatures your opponents control"
	if (/^until end of turn, that creature can't be blocked by creatures your opponents control$/i.test(t)) {
		p.push(
			{
				verb: 'grant',
				subject: { k: 'eventObject' },
				params: { cantBeBlockedByOpponentsCreatures: true, duration: 'endOfTurn' },
				span
			},
			false
		);
		return true;
	}

	// 41. *Mutated Cultist*:
	// "remove all counters from up to one target permanent or opponent. The next spell you cast this turn costs {1} less to cast for each counter removed this way."
	if (/^remove all counters from up to one target permanent or opponent$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'objectOrPlayer',
			filter: { zone: 'battlefield' },
			player: { relation: 'opponent' },
			min: 0,
			max: 1
		});
		p.push(
			{
				verb: 'removeCounters',
				subject: { k: 'target', index: idx },
				amount: { k: 'const', n: 999 },
				params: { counter: 'any', removeAllCountersFromTargetOrPlayer: true },
				span
			},
			true
		);
		return true;
	}
	if (/^the next spell you cast this turn costs \{1\} less to cast for each counter removed this way$/i.test(t)) {
		p.push(
			{
				verb: 'grantPlayer',
				subject: YOU,
				params: { nextSpellCostReductionGeneric: { k: 'countersRemovedThisWay' } },
				span
			},
			false
		);
		return true;
	}

	// 42. *Maester Seymour*: "Monstrosity X, where X is the number of counters among creatures you control"
	if (/^monstrosity X, where X is the number of counters among creatures you control$/i.test(t)) {
		p.push(
			{
				verb: 'monstrosity',
				subject: { k: 'self' },
				amount: { k: 'totalCountersAmong', filter: { zone: 'battlefield', types: ['Creature'], controller: 'you' } },
				span
			},
			false
		);
		return true;
	}

	// 43. *Spymaster's Vault*: "Target creature you control connives X, where X is the number of creatures that died this turn"
	if (/^target creature you control connives X, where X is the number of creatures that died this turn$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'], controller: 'you' },
			min: 1,
			max: 1
		});
		p.push(
			{
				verb: 'connive',
				subject: { k: 'target', index: idx },
				amount: { k: 'creaturesDiedThisTurn', controller: 'any' },
				span
			},
			true
		);
		return true;
	}

	// 44. *Tromell*: "Proliferate X times, where X is the number of nontoken creatures you control that entered this turn"
	if (
		/^proliferate X times, where X is the number of nontoken creatures you control that entered this turn$/i.test(
			t
		)
	) {
		p.push(
			{
				verb: 'proliferate',
				subject: NONE,
				amount: {
					k: 'count',
					of: { zone: 'battlefield', types: ['Creature'], controller: 'you', token: false, enteredThisTurn: true }
				},
				span
			},
			false
		);
		return true;
	}

	// 45. *Omarthis*: "manifest a number of cards from the top of your library equal to the number of counters on it"
	if (/^manifest a number of cards from the top of your library equal to the number of counters on it$/i.test(t)) {
		p.push(
			{
				verb: 'manifest',
				subject: { k: 'libraryTop' },
				amount: { k: 'lkiCounterCount', counter: 'any' },
				span
			},
			false
		);
		return true;
	}

	// 46. *Prize Pig*: "Then if there are three or more ribbon counters on ~, remove those counters and untap it"
	if (/^then if there are three or more ribbon counters on ~, remove those counters and untap it$/i.test(t)) {
		const cond: Condition = { k: 'sourceHasCounter', counter: 'ribbon' as CounterType, min: 3 };
		p.push(
			{
				verb: 'conditionalSequence',
				subject: NONE,
				params: {
					conditionalSequence: {
						condition: cond,
						thenSteps: [
							{
								verb: 'removeCounters',
								subject: { k: 'self' },
								amount: { k: 'const', n: 999 },
								params: { counter: 'ribbon' as CounterType },
								span
							},
							{ verb: 'untap', subject: { k: 'self' }, span }
						]
					}
				},
				span
			},
			false
		);
		return true;
	}

	// 47. *Ripples of Potential*: "Proliferate, then choose any number of permanents you control that had a counter put on them this way. Those permanents phase out."
	if (/^choose any number of permanents you control that had a counter put on them this way$/i.test(t)) {
		// Binding handled on phaseOut below
		return true;
	}
	if (/^those permanents phase out$/i.test(t)) {
		p.push(
			{
				verb: 'phaseOut',
				subject: { k: 'all', filter: { zone: 'battlefield', controller: 'you' } },
				params: { choiceCount: { k: 'const', n: 99 }, upTo: true },
				span
			},
			false
		);
		return true;
	}

	// 48. *Lethal Scheme*: "Each creature that convoked ~ connives"
	if (/^each creature that convoked ~ connives$/i.test(t)) {
		p.push(
			{
				verb: 'connive',
				subject: { k: 'all', filter: { zone: 'battlefield', types: ['Creature'] } },
				params: { forEachConvokingCreatureSteps: [{ verb: 'connive', subject: { k: 'self' }, amount: { k: 'const', n: 1 }, span }] },
				span
			},
			false
		);
		return true;
	}

	// 49. *Incremental Blight*: "Put a -1/-1 counter on target creature, two -1/-1 counters on another target creature, and three -1/-1 counters on a third target creature"
	if (
		/^put a -1\/-1 counter on target creature, two -1\/-1 counters on another target creature, and three -1\/-1 counters on a third target creature$/i.test(
			t
		)
	) {
		const i0 = p.addTarget({ kind: 'object', filter: { zone: 'battlefield', types: ['Creature'] }, min: 1, max: 1 });
		const i1 = p.addTarget({ kind: 'object', filter: { zone: 'battlefield', types: ['Creature'] }, min: 1, max: 1, otherTarget: true });
		const i2 = p.addTarget({ kind: 'object', filter: { zone: 'battlefield', types: ['Creature'] }, min: 1, max: 1, otherTarget: true });
		p.push({ verb: 'putCounters', subject: { k: 'target', index: i0 }, amount: { k: 'const', n: 1 }, params: { counter: '-1/-1' }, span }, true);
		p.push({ verb: 'putCounters', subject: { k: 'target', index: i1 }, amount: { k: 'const', n: 2 }, params: { counter: '-1/-1' }, span }, true);
		p.push({ verb: 'putCounters', subject: { k: 'target', index: i2 }, amount: { k: 'const', n: 3 }, params: { counter: '-1/-1' }, span }, true);
		return true;
	}

	// 50. *Inspirit*: "put your choice of a +1/+1 counter or two charge counters on up to one other target artifact"
	if (/^put your choice of a \+1\/\+1 counter or two charge counters on up to one other target artifact$/i.test(t)) {
		const idx = p.addTarget({ kind: 'object', filter: { zone: 'battlefield', types: ['Artifact'], other: true }, min: 0, max: 1 });
		p.push(
			{
				verb: 'putCounters',
				subject: { k: 'target', index: idx },
				amount: { k: 'const', n: 1 },
				params: { counter: '+1/+1' },
				span
			},
			true
		);
		return true;
	}

	// 51. *Qarsi Revenant*: "Put a flying counter, a deathtouch counter, and a lifelink counter on target creature"
	if (/^put a flying counter, a deathtouch counter, and a lifelink counter on target creature$/i.test(t)) {
		const idx = p.addTarget({ kind: 'object', filter: { zone: 'battlefield', types: ['Creature'] }, min: 1, max: 1 });
		p.push(
			{
				verb: 'putCounters',
				subject: { k: 'target', index: idx },
				amount: { k: 'const', n: 1 },
				params: {
					multiCounters: [
						{ counter: 'flying', count: { k: 'const', n: 1 } },
						{ counter: 'deathtouch', count: { k: 'const', n: 1 } },
						{ counter: 'lifelink', count: { k: 'const', n: 1 } }
					]
				},
				span
			},
			true
		);
		return true;
	}

	// 52. *Pact of the Serpent* / *Painful Truths* / *Scroll of Isildur* III / *Soul's Majesty* / *Ancient Excavation*:
	// "Target player draws X cards and loses X life, where X is ..."
	const drawLoseM = t.match(/^(?:(target player|you) )?draws? X cards and loses? X life, where X is (.+)$/i);
	if (drawLoseM) {
		const who = drawLoseM[1]?.toLowerCase() ?? 'you';
		const amt = parseAmountWave11(p, drawLoseM[2].trim(), h) ?? h.equalTo(p, drawLoseM[2].trim());
		if (amt) {
			let subj: Selector = YOU;
			if (who === 'target player') {
				const idx = p.addTarget({ kind: 'player', filter: {}, player: { relation: 'any' }, min: 1, max: 1 });
				subj = { k: 'target', index: idx };
			}
			p.push({ verb: 'draw', subject: subj, amount: amt, span }, false);
			p.push({ verb: 'loseLife', subject: subj, amount: amt, span }, false);
			return true;
		}
	}

	// "Draw cards equal to <expr>" (not already caught by core)
	const drawEqM = t.match(/^draw cards equal to (.+)$/i);
	if (drawEqM) {
		const amt = parseAmountWave11(p, drawEqM[1].trim(), h) ?? h.equalTo(p, drawEqM[1].trim());
		if (amt) {
			p.push({ verb: 'draw', subject: YOU, amount: amt, span }, false);
			return true;
		}
	}

	// *Ancient Excavation*: "then discard a card for each card drawn this way"
	if (/^(?:then )?discard a card for each card drawn this way$/i.test(t)) {
		p.push({ verb: 'discard', subject: YOU, amount: { k: 'countedThisWay', kind: 'drawnThisWay' }, span }, false);
		return true;
	}

	// *Mr. Foxglove* second sentence: "If you didn't draw cards this way, you may put a creature card from your hand onto the battlefield"
	if (/^if you didn't draw cards this way, you may put a creature card from your hand onto the battlefield$/i.test(t)) {
		p.push(
			{
				verb: 'move',
				subject: { k: 'all', filter: { zone: 'hand', owner: 'you', types: ['Creature'] } },
				amount: { k: 'const', n: 1 },
				condition: { k: 'notDrawnCardsThisWay' },
				optional: { chooser: { k: 'you' } },
				params: { from: 'hand', to: 'battlefield', choiceCount: { k: 'const', n: 1 }, upTo: true },
				span
			},
			false
		);
		return true;
	}

	// *Kozilek*: "if you have fewer than seven cards in hand, draw cards equal to the difference"
	if (/^if you have fewer than seven cards in hand, draw cards equal to the difference$/i.test(t)) {
		p.push(
			{
				verb: 'draw',
				subject: YOU,
				amount: { k: 'handSizeDifference', cap: 7 },
				condition: { k: 'playerHasFewerHandThan', max: 7 },
				span
			},
			false
		);
		return true;
	}

	// *Slithermuse*: "If that player has more cards in hand than you, draw cards equal to the difference"
	if (/^if that player has more cards in hand than you, draw cards equal to the difference$/i.test(t)) {
		const pr = p.lastPlayer ? (h.singlePlayer(p.lastPlayer) ?? { k: 'chosenOpponent' }) : { k: 'chosenOpponent' as const };
		p.push(
			{
				verb: 'draw',
				subject: YOU,
				amount: { k: 'handSizeDifference', targetPlayer: pr },
				condition: { k: 'opponentHasMoreCardsInHandThan', who: pr },
				span
			},
			false
		);
		return true;
	}

	// *Fa'adiyah Seer*: "Draw a card and reveal it. If it isn't a land card, discard it"
	if (/^draw a card and reveal it$/i.test(t)) {
		p.push({ verb: 'draw', subject: YOU, amount: { k: 'const', n: 1 }, params: { revealDrawn: true }, span }, false);
		return true;
	}
	if (/^if it isn't a land card, discard it$/i.test(t)) {
		p.push(
			{
				verb: 'discard',
				subject: YOU,
				amount: { k: 'const', n: 1 },
				condition: { k: 'not', of: { k: 'matchesFilter', filter: { types: ['Land'] } } },
				span
			},
			false
		);
		return true;
	}

	// *Altar of Dementia*: "Target player mills cards equal to the sacrificed creature's power"
	if (/^target player mills cards equal to the sacrificed creature's power$/i.test(t)) {
		const idx = p.addTarget({ kind: 'player', filter: {}, player: { relation: 'any' }, min: 1, max: 1 });
		p.push({ verb: 'mill', subject: { k: 'target', index: idx }, amount: { k: 'sacrificedCostStat', stat: 'power' }, span }, false);
		return true;
	}

	// *Anowon*: "that player mills a card for each 1 damage dealt to them. If the player mills at least one creature card this way, you draw a card"
	if (/^that player mills a card for each 1 damage dealt to them$/i.test(t)) {
		p.push({ verb: 'mill', subject: { k: 'playerRef', ref: { k: 'eventPlayer' } }, amount: { k: 'eventAmount' }, span }, false);
		return true;
	}
	if (/^if the player mills at least one creature card this way, you draw a card$/i.test(t)) {
		p.push({ verb: 'draw', subject: YOU, amount: { k: 'const', n: 1 }, condition: { k: 'creatureCardMilledThisWay' }, span }, false);
		return true;
	}

	// *Grothama*: "each player draws cards equal to the amount of damage dealt to ~ this turn by sources they controlled"
	if (/^each player draws cards equal to the amount of damage dealt to ~ this turn by sources they controlled$/i.test(t)) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachPlayer',
					loopSteps: [
						{
							verb: 'draw',
							subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } },
							amount: { k: 'damageDealtToSelfByPlayerThisTurn', player: { k: 'eachLoopPlayer' } },
							span
						}
					]
				},
				span
			},
			false
		);
		return true;
	}

	// *One Ring to Rule Them All* I: "The Ring tempts you, then each player mills cards equal to your Ring-bearer's power"
	if (/^the ring tempts you, then each player mills cards equal to your ring-bearer's power$/i.test(t)) {
		p.push({ verb: 'temptWithRing', subject: YOU, span }, false);
		p.push(
			{
				verb: 'mill',
				subject: { k: 'player', filter: { relation: 'each_player' } },
				amount: { k: 'ringBearerPower' },
				span
			},
			false
		);
		return true;
	}

	// *Ral Zarek* -1: "Any number of target players each discard a card"
	if (/^any number of target players each discard a card$/i.test(t)) {
		const idx = p.addTarget({ kind: 'player', filter: {}, player: { relation: 'any' }, min: 0, max: 99 });
		p.push({ verb: 'discard', subject: { k: 'target', index: idx }, amount: { k: 'const', n: 1 }, span }, false);
		return true;
	}

	// *Ral Zarek* -7: "Target opponent skips their next X turns, where X is the number of coins that came up heads"
	if (/^target opponent skips their next X turns, where X is the number of coins that came up heads$/i.test(t)) {
		const idx = p.addTarget({ kind: 'player', filter: {}, player: { relation: 'opponent' }, min: 1, max: 1 });
		p.push({ verb: 'skipTurn', subject: { k: 'target', index: idx }, amount: { k: 'coinHeadsCount' }, span }, false);
		return true;
	}

	// *Nicol Bolas, God-Pharaoh* -4: "~ deals 7 damage to target opponent, creature an opponent controls, or planeswalker an opponent controls"
	if (/^~ deals (\d+) damage to target opponent, creature an opponent controls, or planeswalker an opponent controls$/i.test(t)) {
		const dmg = parseInt(t.match(/(\d+)/)![1], 10);
		const idx = p.addTarget({
			kind: 'objectOrPlayer',
			filter: { zone: 'battlefield', types: ['Creature', 'Planeswalker'], controller: 'opponent' },
			player: { relation: 'opponent' },
			min: 1,
			max: 1
		});
		p.push({ verb: 'damage', subject: { k: 'target', index: idx }, amount: { k: 'const', n: dmg }, span }, true);
		return true;
	}

	// *Nicol Bolas, Planeswalker* -9: "That player or that planeswalker's controller discards seven cards, then sacrifices seven permanents of their choice"
	if (
		/^that player or that planeswalker's controller discards seven cards, then sacrifices seven permanents of their choice$/i.test(
			t
		)
	) {
		const ref: PlayerRef = { k: 'controllerOrControllerOfPlaneswalker', targetIndex: 0 };
		p.push({ verb: 'discard', subject: { k: 'playerRef', ref }, amount: { k: 'const', n: 7 }, span }, false);
		p.push(
			{
				verb: 'sacrifice',
				subject: { k: 'all', filter: { zone: 'battlefield' } },
				actor: ref,
				amount: { k: 'const', n: 7 },
				span
			},
			false
		);
		return true;
	}

	// *Nicol Bolas, the Ravager* -12: "Exile all but the bottom card of target player's library"
	if (/^exile all but the bottom card of target player's library$/i.test(t)) {
		const idx = p.addTarget({ kind: 'player', filter: {}, player: { relation: 'any' }, min: 1, max: 1 });
		p.push(
			{
				verb: 'exile',
				subject: { k: 'target', index: idx },
				params: { exileAllExceptBottom: true },
				span
			},
			false
		);
		return true;
	}

	// *Nicol Bolas, Dragon-God* +1: "Each opponent exiles a card from their hand or a permanent they control"
	if (/^each opponent exiles a card from their hand or a permanent they control$/i.test(t)) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachOpponent',
					loopSteps: [
						{
							verb: 'exile',
							subject: { k: 'all', filter: { zone: ['hand', 'battlefield'], controllerRef: { k: 'eachLoopPlayer' } } },
							actor: { k: 'eachLoopPlayer' },
							amount: { k: 'const', n: 1 },
							params: { choiceCount: { k: 'const', n: 1 } },
							span
						}
					]
				},
				span
			},
			false
		);
		return true;
	}

	// *Rofellos's Gift*: "Reveal any number of green cards in your hand. Return an enchantment card from your graveyard to your hand for each card revealed this way."
	if (/^reveal any number of green cards in your hand$/i.test(t)) {
		p.push(
			{
				verb: 'reveal',
				subject: { k: 'all', filter: { zone: 'hand', owner: 'you', colors: ['G'] } },
				amount: { k: 'const', n: 99 },
				params: { choiceCount: { k: 'const', n: 99 }, upTo: true },
				span
			},
			false
		);
		return true;
	}
	if (/^return an enchantment card from your graveyard to your hand for each card revealed this way$/i.test(t)) {
		p.push(
			{
				verb: 'move',
				subject: { k: 'all', filter: { zone: 'graveyard', owner: 'you', types: ['Enchantment'] } },
				amount: { k: 'countedThisWay', kind: 'revealedThisWay' },
				params: { from: 'graveyard', to: 'hand', choiceCount: { k: 'countedThisWay', kind: 'revealedThisWay' }, upTo: true },
				span
			},
			false
		);
		return true;
	}

	// "its owner draws that many cards and each other player loses that much life"
	if (/^its owner draws that many cards and each other player loses that much life$/i.test(t)) {
		const amt: Amount = { k: 'lkiCounterCount', counter: '-1/-1' };
		p.push({ verb: 'draw', subject: { k: 'playerRef', ref: { k: 'ownerOf', of: { k: 'self' } } }, amount: amt, span }, false);
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachOtherPlayer',
					loopSteps: [{ verb: 'loseLife', subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } }, amount: amt, span }]
				},
				span
			},
			false
		);
		return true;
	}

	// "draw two cards and each opponent loses life equal to the mana value of the sacrificed permanent"
	if (/^draw two cards and each opponent loses life equal to the mana value of the sacrificed permanent$/i.test(t)) {
		p.push({ verb: 'draw', subject: YOU, amount: { k: 'const', n: 2 }, span }, false);
		p.push(
			{
				verb: 'loseLife',
				subject: { k: 'player', filter: { relation: 'each_opponent' } },
				amount: { k: 'sacrificedCostStat', stat: 'manaValue' },
				span
			},
			false
		);
		return true;
	}

	// "put a/an <counter> counter on ~ for each <amount>"
	const putCtrForEach = t.match(/^put (?:a|an) ([a-z0-9+/ -]+?) counter on ~ for each (.+)$/i);
	if (putCtrForEach) {
		const cname = parseCounterNameW11(putCtrForEach[1]);
		const amt = parseAmountWave11(p, putCtrForEach[2].trim(), h) ?? h.equalTo(p, putCtrForEach[2].trim());
		if (cname && amt) {
			p.push({ verb: 'putCounters', subject: { k: 'self' }, amount: amt, params: { counter: cname }, span }, false);
			return true;
		}
	}

	// "put <N> <counter> counters on ~, then mill cards equal to the number of <counter> counters on it"
	const putThenMillM = t.match(
		/^put (\S+) ([a-z0-9+/ -]+?) counters? on ~,\s*then mill cards equal to the number of ([a-z0-9+/ -]+?) counters? on (?:it|~)$/i
	);
	if (putThenMillM) {
		const nVal = h.numberWord(putThenMillM[1]);
		const c1 = parseCounterNameW11(putThenMillM[2]);
		const c2 = parseCounterNameW11(putThenMillM[3]);
		if (nVal && c1 && c2) {
			p.push({ verb: 'putCounters', subject: { k: 'self' }, amount: { k: 'const', n: nVal }, params: { counter: c1 }, span }, false);
			p.push({ verb: 'mill', subject: YOU, amount: { k: 'countersOn', counter: c2, of: { k: 'self' } }, span }, false);
			return true;
		}
	}

	// "draw a card for each <amount>"
	const drawForEachM = t.match(/^(?:then\s+)?draw a card for each (.+)$/i);
	if (drawForEachM) {
		const amt = parseAmountWave11(p, drawForEachM[1].trim(), h) ?? h.equalTo(p, drawForEachM[1].trim());
		if (amt) {
			p.push({ verb: 'draw', subject: YOU, amount: amt, span }, false);
			return true;
		}
	}

	// "you gain twice X life"
	if (/^you gain twice X life$/i.test(t)) {
		p.push({ verb: 'gainLife', subject: YOU, amount: { k: 'mul', factor: 2, of: { k: 'x' } }, span }, false);
		return true;
	}

	// "you may have target player lose N life. If you do, put three +1/+1 counters on ~."
	const mayTargetLoseLifeM = t.match(/^you may have target player lose (\S+) life$/i);
	if (mayTargetLoseLifeM) {
		const nVal = h.numberWord(mayTargetLoseLifeM[1]);
		if (nVal) {
			const idx = p.addTarget({ kind: 'player', filter: {}, player: { relation: 'any' }, min: 1, max: 1 });
			p.push(
				{
					verb: 'loseLife',
					subject: { k: 'target', index: idx },
					amount: { k: 'const', n: nVal },
					optional: { chooser: { k: 'you' } },
					span
				},
				true
			);
			p.lastOptionalStep = p.steps.length - 1;
			return true;
		}
	}

	// "if you do, you gain N life" after exiling self
	const ifExiledGainLife = t.match(/^if you do,\s*you gain (\S+) life$/i);
	if (ifExiledGainLife) {
		const nVal = h.numberWord(ifExiledGainLife[1]);
		const prev = p.steps[p.steps.length - 1];
		if (nVal && prev?.verb === 'exile' && prev.subject.k === 'self') {
			p.push(
				{
					verb: 'gainLife',
					subject: YOU,
					amount: { k: 'const', n: nVal },
					condition: { k: 'sourceExiledThisWay' },
					span
				},
				false
			);
			return true;
		}
	}

	return false;
}
