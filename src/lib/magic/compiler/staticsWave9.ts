import type {
	AbilityDef,
	Amount,
	Condition,
	CostDef,
	ObjectFilter,
	ReplacementDef,
	Span,
	StaticDef,
	TokenSpec
} from '../ir.ts';
import type { CounterType, ManaColor, ZoneType } from '../types.ts';
import { normalizeCounterName } from '../types.ts';
import { COUNTERS, parseCost, parseObjectPhrase } from './costs.ts';

export type Wave9StaticItem =
	| { kind: 'static'; static: StaticDef }
	| { kind: 'replacement'; replacement: ReplacementDef };

export interface Wave9StaticHelpers {
	parseCountAmount: (s: string) => Amount | null;
	parseObjectPhraseWithQualifiers: (raw: string, allowDisjunction?: boolean) => ObjectFilter | null;
	parseStaticCondition: (cond: string, subject?: 'self' | 'attachedTo') => Condition | null;
}

const COLOR_MAP: Record<string, ManaColor> = {
	white: 'W',
	blue: 'U',
	black: 'B',
	red: 'R',
	green: 'G'
};

const WORD_NUM: Record<string, number> = {
	zero: 0,
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
	twelve: 12
};

function parseSmallNumber(raw: string): number | null {
	const t = raw.trim().toLowerCase();
	if (/^\d+$/.test(t)) return parseInt(t, 10);
	if (WORD_NUM[t] !== undefined) return WORD_NUM[t];
	return null;
}

function parseColorWords(raw: string): ManaColor[] | null {
	const t = raw.trim().toLowerCase();
	if (t === 'colorless') return [];
	const parts = t
		.split(/(?:,\s*and\s+|\s+and\s+|,\s*)/)
		.map((p) => p.trim())
		.filter(Boolean);
	if (parts.length === 0) return null;
	const out: ManaColor[] = [];
	for (const p of parts) {
		const c = COLOR_MAP[p];
		if (!c) return null;
		if (!out.includes(c)) out.push(c);
	}
	return out;
}

function parseCounterWord(raw: string): CounterType | null {
	const norm = normalizeCounterName(raw.trim().replace(/\s+counters?$/i, ''));
	if (norm) return norm;
	const low = raw.trim().toLowerCase().replace(/\s+counters?$/i, '');
	return COUNTERS[low] ?? null;
}

function titleCaseWords(raw: string): string[] {
	return raw
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1));
}

function parsePermanentQualityFilter(raw: string, helpers: Wave9StaticHelpers): ObjectFilter | null {
	const t = raw.trim();
	const permMatch = t.match(/^(.+?)\s+permanent$/i);
	if (permMatch) {
		const sub = helpers.parseObjectPhraseWithQualifiers(`${permMatch[1]} creature`, true) ??
			parseObjectPhrase(`${permMatch[1]} creature`);
		if (!sub) return null;
		const { types: _drop, ...rest } = sub;
		return { ...rest, notTypes: [...(rest.notTypes ?? []), 'Instant', 'Sorcery'] };
	}
	if (/^colorless$/i.test(t)) return { colors: [] };
	if (/^colorless\s+(.+)$/i.test(t)) {
		const restRaw = t.replace(/^colorless\s+/i, '').trim();
		const inner =
			helpers.parseObjectPhraseWithQualifiers(`${restRaw} card`, true) ??
			parseObjectPhrase(`${restRaw} card`);
		return inner ? { ...inner, colors: [] } : { colors: [] };
	}
	return (
		helpers.parseObjectPhraseWithQualifiers(`${t} card`, true) ??
		parseObjectPhrase(`${t} card`)
	);
}

/**
 * Multi-sentence Wave 9S static/replacement patterns evaluated on the normalized static paragraph.
 */
export function tryParseWave9WholeStatic(
	text: string,
	offset: number,
	spanLength: number,
	helpers: Wave9StaticHelpers
): Wave9StaticItem[] | null {
	const norm = text.replace(/’/g, "'").replace(/\s+/g, ' ').trim();
	const body = norm.replace(/\.$/, '');
	const span: Span = { start: offset, end: offset + spanLength };

	// 1. Abundance: interactive land/nonland draw replacement
	if (
		/^If you would draw a card, you may instead choose land or nonland and reveal cards from the top of your library until you reveal a card of the chosen kind\. Put that card into your hand and put all other cards revealed this way on the bottom of your library in any order$/i.test(
			body
		)
	) {
		return [
			{
				kind: 'replacement',
				replacement: {
					replaces: { event: 'draw', filter: { player: { relation: 'you' } } },
					with: { k: 'modify', abundanceDrawChoice: true }
				}
			}
		];
	}

	// 2. Azula-style exiled play with flash + any mana color:
	//    "During your turn, you may cast cards exiled with ~ and you may cast them as though they had flash. Mana of any type can be spent to cast those spells."
	if (
		/^During your turn, you may cast cards exiled with ~ and you may cast them as though they had flash\. Mana of any type can be spent to cast those spells$/i.test(
			body
		)
	) {
		return [
			{
				kind: 'static',
				static: {
					k: 'zonePlayPermission',
					zone: 'exile',
					exiledWithSelf: true,
					allowSpells: true,
					duringYourTurnOnly: true,
					grantFlash: true,
					spendManaAsAnyColor: true
				}
			}
		];
	}

	// 3. Djinn Illuminatus-style replicate grant equal to mana cost:
	//    "Each instant and sorcery spell you cast has replicate. The replicate cost is equal to its mana cost"
	const repM = body.match(
		/^Each (.+?) spells? you cast has replicate\. The replicate cost is equal to its mana cost$/i
	);
	if (repM) {
		const f =
			helpers.parseObjectPhraseWithQualifiers(`${repM[1].replace(/\s+and\s+/gi, ' or ')} card`, true) ??
			parseObjectPhrase(`${repM[1].replace(/\s+and\s+/gi, ' or ')} card`);
		if (f) {
			return [
				{
					kind: 'static',
					static: { k: 'spellGrantKeyword', filter: f, keywords: ['replicate'] }
				}
			];
		}
	}

	// 4. Duplicant-style exiled creature P/T + creature types copy:
	//    "As long as a card exiled with ~ is a creature card, ~ has the power, toughness, and creature types of the last creature card exiled with it. It's still a Shapeshifter"
	const dupM = body.match(
		/^As long as a card exiled with ~ is a creature card, ~ has the power, toughness, and creature types of the last creature card exiled with it\. It's still an? ([A-Z][A-Za-z'-]+)$/i
	);
	if (dupM) {
		const keptSubtype = dupM[1];
		return [
			{
				kind: 'static',
				static: {
					k: 'continuous',
					layer: '4',
					affected: 'self',
					mod: { k: 'copyStatsAndSubtypesFromLastExiled', includeSubtypes: true }
				}
			},
			{
				kind: 'static',
				static: {
					k: 'continuous',
					layer: '4',
					affected: 'self',
					mod: { k: 'addTypes', types: [], subtypes: [keptSubtype] }
				}
			},
			{
				kind: 'static',
				static: {
					k: 'continuous',
					layer: '7b',
					affected: 'self',
					mod: { k: 'copyStatsAndSubtypesFromLastExiled' }
				}
			}
		];
	}

	// 5. Edgar-style graveyard cast once per turn + enters tapped:
	//    "Once during each of your turns, you may cast an artifact spell from your graveyard. If you cast a spell this way, that artifact enters tapped"
	const edgarM = body.match(
		/^Once during each of your turns, you may cast (?:a|an) (.+?) spell from your graveyard\. If you cast a spell this way, (?:that .+? )?enters tapped$/i
	);
	if (edgarM) {
		const filter =
			helpers.parseObjectPhraseWithQualifiers(`${edgarM[1]} card`, true) ??
			parseObjectPhrase(`${edgarM[1]} card`);
		if (filter) {
			return [
				{
					kind: 'static',
					static: {
						k: 'zonePlayPermission',
						zone: 'graveyard',
						allowSpells: true,
						spellFilter: filter,
						duringYourTurnOnly: true,
						slotMode: 'oncePerTurn',
						entersTapped: true
					}
				}
			];
		}
	}

	// 6. Nowhere to Run-style ignore hexproof + suppress opponent ward triggers:
	//    "Creatures your opponents control can be the targets of spells and abilities as though they didn't have hexproof. Ward abilities of those creatures don't trigger"
	if (
		/^Creatures your opponents control can be the targets of spells and abilities as though they didn't have hexproof\. Ward abilities of those creatures don't trigger$/i.test(
			body
		)
	) {
		return [
			{ kind: 'static', static: { k: 'ruleModifier', rule: 'ignoreHexproof', who: { relation: 'you' } } },
			{ kind: 'static', static: { k: 'ruleModifier', rule: 'suppressWardTriggers', who: { relation: 'you' } } }
		];
	}

	// 7. Out of the Tombs-style empty library draw replacement:
	//    "If you would draw a card while your library has no cards in it, instead return a creature card from your graveyard to the battlefield. If you can't, you lose the game"
	const emptyDrawM = body.match(
		/^If you would draw a card while your library has no cards in it, instead return (?:a|an) (.+?) card from your graveyard to the battlefield\. If you can't, you lose the game$/i
	);
	if (emptyDrawM) {
		const filter =
			helpers.parseObjectPhraseWithQualifiers(`${emptyDrawM[1]} card`, true) ??
			parseObjectPhrase(`${emptyDrawM[1]} card`);
		if (filter) {
			return [
				{
					kind: 'replacement',
					replacement: {
						replaces: { event: 'draw', filter: { player: { relation: 'you' } } },
						condition: {
							k: 'compare',
							left: { k: 'cardsIn', zone: 'library', of: { k: 'you' } },
							op: '=',
							right: { k: 'const', n: 0 }
						},
						with: { k: 'modify', emptyLibraryGraveyardReanimate: { filter } }
					}
				}
			];
		}
	}

	// 8. Phyrexian Vindicator-style prevent all damage to self + reflexive any other target damage trigger:
	//    "If damage would be dealt to ~, prevent that damage. When damage is prevented this way, ~ deals that much damage to any other target"
	if (
		/^If damage would be dealt to ~, prevent that damage\. When damage is prevented this way, ~ deals that much damage to any other target$/i.test(
			body
		)
	) {
		return [
			{
				kind: 'static',
				static: {
					k: 'staticDamagePrevention',
					target: 'self',
					amount: 'all',
					onPrevented: {
						k: 'reflexiveDamageTrigger',
						target: {
							kind: 'objectOrPlayer',
							filter: { zone: 'battlefield', other: true, types: ['Creature', 'Planeswalker', 'Battle'] },
							player: { relation: 'any' },
							min: 1,
							max: 1
						},
						toAmount: 'prevented'
					}
				}
			}
		];
	}

	// 9. Temple of the Dragon Queen-style reveal or control type ETB tapped:
	//    "As ~ enters, you may reveal a Dragon card from your hand. ~ enters tapped unless you revealed a Dragon card this way or you control a Dragon"
	const revealOrCtrlM = body.match(
		/^As ~ enters(?: the battlefield)?, you may reveal (?:a|an) (.+?) card from your hand\. ~ enters tapped unless you revealed (?:a|an) \1 card this way or you control (?:a|an) \1$/i
	);
	if (revealOrCtrlM) {
		const filter =
			helpers.parseObjectPhraseWithQualifiers(revealOrCtrlM[1], true) ??
			parseObjectPhrase(revealOrCtrlM[1]);
		if (filter) {
			return [
				{
					kind: 'replacement',
					replacement: {
						selfReplacement: true,
						replaces: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
						with: {
							k: 'modify',
							revealFromHandOrEnterTapped: filter,
							revealUnlessControls: filter
						}
					}
				}
			];
		}
	}

	// 10. Thundermane Dragon-style library cast + haste until end of turn:
	//     "You may cast creature spells with power 4 or greater from the top of your library. If you cast a creature spell this way, it gains haste until end of turn"
	const libHasteM = body.match(
		/^You may cast (.+?) spells?(?: with power (\d+) or greater)? from the top of your library\. If you cast (?:a|an) .+? spell this way, it gains haste until end of turn$/i
	);
	if (libHasteM) {
		const baseFilter =
			helpers.parseObjectPhraseWithQualifiers(`${libHasteM[1]} card`, true) ??
			parseObjectPhrase(`${libHasteM[1]} card`);
		if (baseFilter) {
			const minPow = libHasteM[2] ? parseInt(libHasteM[2], 10) : undefined;
			return [
				{
					kind: 'static',
					static: {
						k: 'zonePlayPermission',
						zone: 'library',
						allowSpells: true,
						spellFilter:
							minPow !== undefined
								? { ...baseFilter, power: { op: '>=', value: { k: 'const', n: minPow } } }
								: baseFilter,
						grantHasteUntilEndOfTurn: true
					}
				}
			];
		}
	}

	// 11. Urborg Scavengers-style keyword copying from cards exiled with self:
	//     "~ has <kw1> as long as a card exiled with it has <kw1>. The same is true for <kwList>"
	const scavM = body.match(
		/^~ has ([a-z ]+?) as long as a card exiled with it has \1\. The same is true for (.+)$/i
	);
	if (scavM) {
		const kws = [
			scavM[1].trim().toLowerCase(),
			...scavM[2]
				.split(/,\s*and\s+|,\s*|\s+and\s+/)
				.map((x) => x.trim().toLowerCase())
				.filter(Boolean)
		];
		return [
			{
				kind: 'static',
				static: {
					k: 'continuous',
					layer: '6',
					affected: 'self',
					mod: { k: 'copyKeywordsFromExiled', keywords: [...new Set(kws)] }
				}
			}
		];
	}

	// 12. Valentin-style opponent nontoken dies -> exile + reflexive pay {N} to create token:
	//     'If a nontoken creature an opponent controls would die, exile it instead. When you do, you may pay {2}. If you do, create a 1/1 black and green Pest creature token with "When ~ dies, you gain 1 life."'
	const valM = body.match(
		/^If a nontoken creature an opponent controls would die, exile it instead\. When you do, you may pay (\{[^}]+\})\. If you do, create (?:a|an) (\d+)\/(\d+) (.+?) ([A-Z][A-Za-z'-]+) creature token with "([^"]+)"$/i
	);
	if (valM) {
		const colors = parseColorWords(valM[4]);
		if (colors) {
			return [
				{
					kind: 'replacement',
					replacement: {
						replaces: {
							event: 'zoneChange',
							filter: {
								from: 'battlefield',
								to: 'graveyard',
								object: { types: ['Creature'], controller: 'opponent', token: false }
							}
						},
						with: {
							k: 'modify',
							to: 'exile',
							diesExileAndReflexive: {
								payManaCost: valM[1],
								tokenSpec: {
									name: valM[5],
									typeLine: `Token Creature — ${valM[5]}`,
									power: parseInt(valM[2], 10),
									toughness: parseInt(valM[3], 10),
									colors,
									triggerText: valM[6]
								}
							}
						}
					}
				}
			];
		}
	}

	// 13. Vigor-style prevent damage + put +1/+1 counters per 1 prevented:
	//     "If damage would be dealt to another creature you control, prevent that damage. Put a +1/+1 counter on that creature for each 1 damage prevented this way"
	if (
		/^If damage would be dealt to another creature you control, prevent that damage\. Put a \+1\/\+?1 counter on that creature for each 1 damage prevented this way$/i.test(
			body
		)
	) {
		return [
			{
				kind: 'static',
				static: {
					k: 'staticDamagePrevention',
					target: {
						filter: { zone: 'battlefield', types: ['Creature'], controller: 'you', other: true }
					},
					amount: 'all',
					onPrevented: { k: 'putPlusCountersPerDamage' }
				}
			}
		];
	}

	// 14. Dynamic keyword lines ("Mobilize X, where X is ...", "Firebending X, where X is ..."):
	const dynKwM = body.match(/^(Mobilize|Firebending)\s+X,\s*where X is (.+)$/i);
	if (dynKwM) {
		const kwName = dynKwM[1].toLowerCase();
		let amt = helpers.parseCountAmount(dynKwM[2]);
		if (!amt) {
			const gyM = dynKwM[2].match(/^the number of (.+?) cards? in your graveyard$/i);
			if (gyM) {
				const f =
					helpers.parseObjectPhraseWithQualifiers(`${gyM[1]} card`, true) ??
					parseObjectPhrase(`${gyM[1]} card`);
				if (f) amt = { k: 'count', of: { ...f, zone: 'graveyard', owner: 'you' } };
			}
		}
		if (amt) {
			return [
				{
					kind: 'static',
					static: {
						k: 'continuous',
						layer: '6',
						affected: 'self',
						mod: {
							k: 'grantAbility',
							ability: { kind: 'keyword', keyword: { name: kwName, dynamicAmount: amt }, span }
						}
					}
				}
			];
		}
	}

	return null;
}

/**
 * Single-sentence Wave 9S fallback inside `parseSentence`.
 */
export function tryParseWave9Sentence(
	rawSentence: string,
	span: Span,
	depth: number,
	helpers: Wave9StaticHelpers
): Wave9StaticItem[] | null {
	let s = rawSentence.replace(/’/g, "'").replace(/\.$/, '').trim();
	// Strip optional leading AbilityWord — if missed earlier
	s = s.replace(/^[A-Z][A-Za-z0-9' -]{1,24}\s*—\s*/, '').trim();

	// 1. "As long as ~ has a <counter> counter on it, ..." or "It's a land" / "~ is a land"
	if (/^(?:~ is|it's) a land$/i.test(s)) {
		return [
			{
				kind: 'static',
				static: { k: 'continuous', layer: '4', affected: 'self', mod: { k: 'setTypes', types: ['Land'] } }
			}
		];
	}

	// 2. Agatha first clause:
	//    "You may spend mana as though it were mana of any color to activate abilities of creatures you control"
	const spendActivateM = s.match(
		/^You may spend mana as though it were mana of any color to activate abilities of (.+?) you control$/i
	);
	if (spendActivateM) {
		const f =
			helpers.parseObjectPhraseWithQualifiers(spendActivateM[1], true) ??
			parseObjectPhrase(spendActivateM[1]);
		if (f) {
			return [
				{
					kind: 'static',
					static: {
						k: 'ruleModifier',
						rule: 'spendManaAsAnyColor',
						who: { relation: 'you' },
						params: { abilitiesOnly: true, sourceFilter: { ...f, zone: 'battlefield', controller: 'you' } }
					}
				}
			];
		}
	}

	// 3. Grant all activated / loyalty abilities from exiled cards with self or battlefield objects:
	//    "Creatures you control with +1/+1 counters on them have all activated abilities of all creature cards exiled with ~"
	//    "Foods you control have all activated abilities of all creature cards exiled with ~"
	//    "Creatures you control have all activated abilities of all land cards exiled with ~"
	const grantExiledAbM = s.match(
		/^(.+?) you control(?: with ([^ ]+) counters? on them)? have all activated abilities of all (.+?) cards? exiled with ~$/i
	);
	if (grantExiledAbM) {
		const aff =
			helpers.parseObjectPhraseWithQualifiers(grantExiledAbM[1], true) ??
			parseObjectPhrase(grantExiledAbM[1]);
		const exFilter =
			helpers.parseObjectPhraseWithQualifiers(`${grantExiledAbM[3]} card`, true) ??
			parseObjectPhrase(`${grantExiledAbM[3]} card`);
		const reqCtr = grantExiledAbM[2] ? parseCounterWord(grantExiledAbM[2]) : null;
		if (aff && exFilter && (!grantExiledAbM[2] || reqCtr)) {
			return [
				{
					kind: 'static',
					static: {
						k: 'continuous',
						layer: '6',
						affected: {
							...aff,
							zone: 'battlefield',
							controller: 'you',
							...(reqCtr ? { hasCounters: reqCtr } : {})
						},
						mod: {
							k: 'grantAbilitiesFromObjects',
							from: { k: 'exiledWithSelf', filter: exFilter }
						}
					}
				}
			];
		}
	}

	//    "~ has all activated abilities of creatures you control that don't have the same name as ~"
	if (/^~ has all activated abilities of creatures you control that don't have the same name as ~$/i.test(s)) {
		return [
			{
				kind: 'static',
				static: {
					k: 'continuous',
					layer: '6',
					affected: 'self',
					mod: {
						k: 'grantAbilitiesFromObjects',
						from: {
							k: 'battlefield',
							filter: {
								zone: 'battlefield',
								types: ['Creature'],
								controller: 'you',
								notSameNameAsSource: true
							}
						}
					}
				}
			}
		];
	}

	//    "~ has all loyalty abilities of all other planeswalkers on the battlefield"
	if (/^~ has all loyalty abilities of all other planeswalkers on the battlefield$/i.test(s)) {
		return [
			{
				kind: 'static',
				static: {
					k: 'continuous',
					layer: '6',
					affected: 'self',
					mod: {
						k: 'grantAbilitiesFromObjects',
						from: {
							k: 'battlefield',
							filter: { zone: 'battlefield', types: ['Planeswalker'], other: true }
						},
						loyaltyOnly: true
					}
				}
			}
		];
	}

	// 4. Ashling: "<Quality> spells you cast (from your hand)? gain evoke {4} as you cast them"
	const gainEvokeM = s.match(
		/^(.+?) spells you cast(?: from (your hand|your graveyard|exile))? gain evoke (\{[^}]+\}) as you cast them$/i
	);
	if (gainEvokeM) {
		const f = parsePermanentQualityFilter(gainEvokeM[1], helpers);
		if (f) {
			const zLow = gainEvokeM[2]?.toLowerCase();
			const castFromZone: ZoneType | undefined =
				zLow === 'your hand'
					? 'hand'
					: zLow === 'your graveyard'
						? 'graveyard'
						: zLow === 'exile'
							? 'exile'
							: undefined;
			return [
				{
					kind: 'static',
					static: {
						k: 'spellGrantKeyword',
						filter: { ...f, ...(castFromZone ? { castFromZone } : {}) },
						keywords: ['evoke'],
						evokeCost: gainEvokeM[3]
					}
				}
			];
		}
	}

	// 5. Zhulodok & Thrumming Stone & Rain of Riches spell keyword grants:
	//    "Colorless spells you cast from your hand with mana value 7 or greater have \"Cascade, cascade.\""
	const mvSpellKwM = s.match(
		/^(.+?) spells you cast(?: from (your hand|your graveyard|exile))?(?: with mana value (\d+) or greater)? (?:have|has) "([^"]+)"$/i
	);
	if (mvSpellKwM) {
		const f = parsePermanentQualityFilter(mvSpellKwM[1], helpers);
		if (f) {
			const zLow = mvSpellKwM[2]?.toLowerCase();
			const castFromZone: ZoneType | undefined =
				zLow === 'your hand' ? 'hand' : zLow === 'your graveyard' ? 'graveyard' : zLow === 'exile' ? 'exile' : undefined;
			const mvMin = mvSpellKwM[3] ? parseInt(mvSpellKwM[3], 10) : undefined;
			const innerKw = mvSpellKwM[4].replace(/\.$/, '').trim().toLowerCase();
			if (innerKw === 'cascade, cascade') {
				return [
					{
						kind: 'static',
						static: {
							k: 'spellGrantKeyword',
							filter: {
								...f,
								...(castFromZone ? { castFromZone } : {}),
								...(mvMin !== undefined ? { manaValue: { op: '>=', value: { k: 'const', n: mvMin } } } : {})
							},
							keywords: ['cascade'],
							cascadeCount: 2
						}
					}
				];
			}
		}
	}

	//    "Spells you cast have ripple 4"
	const rippleM = s.match(/^Spells you cast have ripple (\d+)$/i);
	if (rippleM) {
		return [
			{
				kind: 'static',
				static: {
					k: 'spellGrantKeyword',
					filter: {},
					keywords: ['ripple'],
					paramN: parseInt(rippleM[1], 10)
				}
			}
		];
	}

	//    "The first spell you cast each turn that mana from a Treasure was spent to cast has cascade"
	if (/^The first spell you cast each turn that mana from a Treasure was spent to cast has cascade$/i.test(s)) {
		return [
			{
				kind: 'static',
				static: {
					k: 'spellGrantKeyword',
					filter: {},
					keywords: ['cascade'],
					condition: { k: 'firstSpellThisTurnWithManaFrom', manaSource: 'treasure' }
				}
			}
		];
	}

	// 6. Aven Interrupter: "Spells your opponents cast from graveyards or from exile cost {2} more to cast"
	const zoneCostM = s.match(
		/^Spells (your opponents|players|you) cast from graveyards or (?:from )?exile cost (\{\d+\}) (more|less) to cast$/i
	);
	if (zoneCostM) {
		const whoRel = zoneCostM[1].toLowerCase() === 'your opponents' ? 'opponent' : zoneCostM[1].toLowerCase() === 'you' ? 'you' : 'each_player';
		const generic = parseInt(zoneCostM[2].replace(/[{}]/g, ''), 10);
		return [
			{
				kind: 'static',
				static: {
					k: 'costModifier',
					who: { relation: whoRel },
					affects: { k: 'spell', filter: { castFromZones: ['graveyard', 'exile'] } },
					delta: { mode: zoneCostM[3].toLowerCase() === 'less' ? 'reduce' : 'increase', generic }
				}
			}
		];
	}

	// 7. Professor Hojo:
	//    "The first activated ability you activate during your turn that targets a creature you control costs {2} less to activate"
	const firstTargetedAbCostM = s.match(
		/^The first activated ability you activate during your turn that targets (?:a|an) (.+?) you control costs (\{\d+\}) less to activate$/i
	);
	if (firstTargetedAbCostM) {
		const tgt =
			helpers.parseObjectPhraseWithQualifiers(firstTargetedAbCostM[1], true) ??
			parseObjectPhrase(firstTargetedAbCostM[1]);
		if (tgt) {
			const generic = parseInt(firstTargetedAbCostM[2].replace(/[{}]/g, ''), 10);
			return [
				{
					kind: 'static',
					static: {
						k: 'costModifier',
						who: { relation: 'you' },
						condition: { k: 'isTurnOf', player: { k: 'you' } },
						affects: {
							k: 'ability',
							targetsFilter: { ...tgt, controller: 'you' },
							firstMatchingThisTurn: true
						},
						delta: { mode: 'reduce', generic }
					}
				}
			];
		}
	}

	// 8. Banon / Evendo / Theater / Tinybones zone play permissions:
	//    "Once during each of your turns, you may cast a creature spell from among cards in your graveyard that were put there from anywhere other than the battlefield this turn"
	const banonM = s.match(
		/^Once during each of your turns, you may cast (?:a|an) (.+?) spell from among cards in your graveyard that were put there from anywhere other than the battlefield this turn$/i
	);
	if (banonM) {
		const f =
			helpers.parseObjectPhraseWithQualifiers(`${banonM[1]} card`, true) ??
			parseObjectPhrase(`${banonM[1]} card`);
		if (f) {
			return [
				{
					kind: 'static',
					static: {
						k: 'zonePlayPermission',
						zone: 'graveyard',
						allowSpells: true,
						spellFilter: f,
						duringYourTurnOnly: true,
						slotMode: 'oncePerTurn',
						putIntoGraveyardFromNonBattlefieldThisTurn: true
					}
				}
			];
		}
	}

	//    "you may play cards exiled with ~" / "you may play lands and cast spells from among cards exiled with ~"
	if (/^you may play (?:lands and cast spells from among )?cards exiled with ~$/i.test(s)) {
		return [
			{
				kind: 'static',
				static: {
					k: 'zonePlayPermission',
					zone: 'exile',
					exiledWithSelf: true,
					allowLands: true,
					allowSpells: true
				}
			}
		];
	}

	//    "During your turn, you may play cards you don't own with stash counters on them from exile, and mana of any type can be spent to cast those spells"
	const tinyM = s.match(
		/^(?:During your turn,\s+)?you may play cards you don't own with (\S+) counters on them from exile, and mana of any type can be spent to cast those spells$/i
	);
	if (tinyM) {
		const ctr = parseCounterWord(tinyM[1]);
		if (ctr) {
			return [
				{
					kind: 'static',
					static: {
						k: 'zonePlayPermission',
						zone: 'exile',
						allowLands: true,
						allowSpells: true,
						duringYourTurnOnly: true,
						cardOwner: 'opponents',
						requireCounter: ctr,
						spendManaAsAnyColor: true
					}
				}
			];
		}
	}

	// 9. Coin of Mastery:
	//    "Each creature you control enters with an additional +1/+1 counter on it for each mana from an artifact source spent to cast it"
	const coinM = s.match(
		/^Each (.+?) you control enters with an additional (\S+) counter on it for each mana from (?:a|an) artifact source spent to cast it$/i
	);
	if (coinM) {
		const f =
			helpers.parseObjectPhraseWithQualifiers(coinM[1], true) ??
			parseObjectPhrase(coinM[1]);
		const ctr = parseCounterWord(coinM[2]);
		if (f && ctr) {
			return [
				{
					kind: 'replacement',
					replacement: {
						replaces: {
							event: 'zoneChange',
							filter: { to: 'battlefield', object: { ...f, controller: 'you' } }
						},
						with: { k: 'modify', countersPerArtifactMana: { counter: ctr } }
					}
				}
			];
		}
	}

	// 10. Altered Ego / Echoing Deeps / Mocking Doppelganger / Spark Double ETB clone replacements:
	const alteredM = s.match(
		/^You may have ~ enter as a copy of (.+?), except it enters with X additional (\S+) counters? on it$/i
	);
	if (alteredM) {
		const rawCopyFilter = alteredM[1]
			.replace(/^any\s+/i, '')
			.replace(/\s+on the battlefield$/i, '')
			.trim();
		const f =
			helpers.parseObjectPhraseWithQualifiers(rawCopyFilter, true) ??
			parseObjectPhrase(rawCopyFilter);
		const ctr = parseCounterWord(alteredM[2]);
		if (f && ctr) {
			return [
				{
					kind: 'replacement',
					replacement: {
						selfReplacement: true,
						replaces: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
						with: {
							k: 'modify',
							copyOf: { ...f, zone: 'battlefield' },
							copyOptional: true,
							copyModifications: { additionalCounters: { counter: ctr, amount: { k: 'x' } } }
						}
					}
				}
			];
		}
	}

	const gyCloneM = s.match(
		/^You may have ~ enter (tapped )?as a copy of any (.+?) card in a graveyard, except it's (?:a|an) ([A-Z][A-Za-z'-]+) in addition to its other types$/i
	);
	if (gyCloneM) {
		const f =
			helpers.parseObjectPhraseWithQualifiers(`${gyCloneM[2]} card`, true) ??
			parseObjectPhrase(`${gyCloneM[2]} card`);
		if (f) {
			return [
				{
					kind: 'replacement',
					replacement: {
						selfReplacement: true,
						replaces: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
						with: {
							k: 'modify',
							copyFromGraveyards: {
								filter: f,
								optional: true,
								tappedIfCopied: Boolean(gyCloneM[1]),
								copyModifications: { addSubtypes: [gyCloneM[3]] }
							}
						}
					}
				}
			];
		}
	}

	const quoteCloneM = s.match(/^You may have ~ enter as a copy of (.+?), except it has "([^"]+)"$/i);
	if (quoteCloneM) {
		const f =
			helpers.parseObjectPhraseWithQualifiers(quoteCloneM[1], true) ??
			parseObjectPhrase(quoteCloneM[1]);
		if (f) {
			return [
				{
					kind: 'replacement',
					replacement: {
						selfReplacement: true,
						replaces: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
						with: {
							k: 'modify',
							copyOf: { ...f, zone: 'battlefield' },
							copyOptional: true,
							copyModifications: { addedAbilityTexts: [quoteCloneM[2]] }
						}
					}
				}
			];
		}
	}

	if (/^Other creatures with the same name as ~ are goaded$/i.test(s)) {
		return [
			{
				kind: 'static',
				static: {
					k: 'combatRule',
					affected: { zone: 'battlefield', types: ['Creature'], other: true, sameNameAsAffected: true },
					rule: { kind: 'isGoaded' }
				}
			}
		];
	}

	const sparkM = s.match(
		/^You may have ~ enter as a copy of (.+?), except it enters with an additional (\S+) counter on it if it's a creature, it enters with an additional (\S+) counter on it if it's a planeswalker, and it isn't legendary$/i
	);
	if (sparkM) {
		const f =
			helpers.parseObjectPhraseWithQualifiers(sparkM[1], true) ??
			parseObjectPhrase(sparkM[1]);
		const c1 = parseCounterWord(sparkM[2]);
		const c2 = parseCounterWord(sparkM[3]);
		if (f && c1 && c2) {
			return [
				{
					kind: 'replacement',
					replacement: {
						selfReplacement: true,
						replaces: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
						with: {
							k: 'modify',
							copyOf: { ...f, zone: 'battlefield' },
							copyOptional: true,
							copyModifications: {
								removeSupertypes: ['Legendary'],
								conditionalTypeCounters: [
									{ type: 'Creature', counter: c1, count: 1 },
									{ type: 'Planeswalker', counter: c2, count: 1 }
								]
							}
						}
					}
				}
			];
		}
	}

	// 11. Token replacement statics (Divine Visitation & Fisher's Talent):
	const divVisM = s.match(
		/^If one or more creature tokens would be created under your control, that many (\d+)\/(\d+) ([a-z ,]+) ([A-Z][A-Za-z'-]+) creature tokens(?: with (.+))? are created instead$/i
	);
	if (divVisM) {
		const colors = parseColorWords(divVisM[3]);
		if (colors) {
			const keywords = divVisM[5]
				? divVisM[5].split(/,\s*and\s+|\s+and\s+|,\s*/).map((k) => k.trim().toLowerCase()).filter(Boolean)
				: undefined;
			return [
				{
					kind: 'static',
					static: {
						k: 'tokenReplacement',
						mode: 'replaceSpec',
						replacementToken: {
							name: divVisM[4],
							typeLine: `Token Creature — ${divVisM[4]}`,
							power: parseInt(divVisM[1], 10),
							toughness: parseInt(divVisM[2], 10),
							colors,
							...(keywords ? { keywords } : {})
						}
					}
				}
			];
		}
	}

	const subTokM = s.match(
		/^If you would create (?:a|an) ([A-Z][A-Za-z'-]+) token, create (?:a|an) (\d+)\/(\d+) ([a-z ,]+) ([A-Z][A-Za-z'-]+) creature tokens? instead$/i
	);
	if (subTokM) {
		const colors = parseColorWords(subTokM[4]);
		if (colors) {
			return [
				{
					kind: 'static',
					static: {
						k: 'tokenReplacement',
						mode: 'replaceSpec',
						matchSubtypes: [subTokM[1]],
						replacementToken: {
							name: subTokM[5],
							typeLine: `Token Creature — ${subTokM[5]}`,
							power: parseInt(subTokM[2], 10),
							toughness: parseInt(subTokM[3], 10),
							colors
						}
					}
				}
			];
		}
	}

	// 12. Eye of Nidhogg & Witness Protection attached transforms:
	const eyeM = s.match(
		/^(Enchanted|Equipped) creature is (?:a|an) ([a-z ,]+) ([A-Z][A-Za-z'-]+) with base power and toughness (\d+)\/(\d+), has (.+?), and is goaded$/i
	);
	if (eyeM) {
		const colors = parseColorWords(eyeM[2]);
		if (colors) {
			const kws = eyeM[6].split(/,\s*and\s+|\s+and\s+|,\s*/).map((k) => k.trim().toLowerCase()).filter(Boolean);
			return [
				{ kind: 'static', static: { k: 'continuous', layer: '4', affected: 'attachedTo', mod: { k: 'setSubtypes', subtypes: [eyeM[3]] } } },
				{ kind: 'static', static: { k: 'continuous', layer: '5', affected: 'attachedTo', mod: { k: 'setColors', colors } } },
				{ kind: 'static', static: { k: 'continuous', layer: '7b', affected: 'attachedTo', mod: { k: 'setBasePT', power: { k: 'const', n: parseInt(eyeM[4], 10) }, toughness: { k: 'const', n: parseInt(eyeM[5], 10) } } } },
				{ kind: 'static', static: { k: 'continuous', layer: '6', affected: 'attachedTo', mod: { k: 'addKeywords', keywords: kws } } },
				{ kind: 'static', static: { k: 'combatRule', affected: 'attachedTo', rule: { kind: 'isGoaded' } } }
			];
		}
	}

	const witnessM = s.match(
		/^(Enchanted|Equipped) creature loses all abilities and is (?:a|an) ([a-z ,]+) ([A-Z][A-Za-z'-]+) creature with base power and toughness (\d+)\/(\d+) named ([A-Z][A-Za-z0-9' -]+)$/i
	);
	if (witnessM) {
		const colors = parseColorWords(witnessM[2]);
		if (colors) {
			return [
				{ kind: 'static', static: { k: 'continuous', layer: '6', affected: 'attachedTo', mod: { k: 'removeAllAbilities' } } },
				{ kind: 'static', static: { k: 'continuous', layer: '5', affected: 'attachedTo', mod: { k: 'setColors', colors } } },
				{ kind: 'static', static: { k: 'continuous', layer: '4', affected: 'attachedTo', mod: { k: 'setTypes', types: ['Creature'], subtypes: [witnessM[3]] } } },
				{ kind: 'static', static: { k: 'continuous', layer: '7b', affected: 'attachedTo', mod: { k: 'setBasePT', power: { k: 'const', n: parseInt(witnessM[4], 10) }, toughness: { k: 'const', n: parseInt(witnessM[5], 10) } } } },
				{ kind: 'static', static: { k: 'continuous', layer: '3', affected: 'attachedTo', mod: { k: 'setName', name: witnessM[6].trim() } } }
			];
		}
	}

	// 13. Infantry Shield:
	const infM = s.match(/^(Equipped|Enchanted) creature has ([a-z, ]+?) and (mobilize|firebending) X,\s*where X is its power$/i);
	if (infM) {
		const kws = infM[2].split(/,\s*/).map((x) => x.trim().toLowerCase()).filter(Boolean);
		const kwName = infM[3].toLowerCase();
		return [
			{ kind: 'static', static: { k: 'continuous', layer: '6', affected: 'attachedTo', mod: { k: 'addKeywords', keywords: kws } } },
			{
				kind: 'static',
				static: {
					k: 'continuous',
					layer: '6',
					affected: 'attachedTo',
					mod: {
						k: 'grantAbility',
						ability: {
							kind: 'keyword',
							keyword: { name: kwName, dynamicAmount: { k: 'stat', of: { k: 'self' }, stat: 'power' } },
							span
						}
					}
				}
			}
		];
	}

	// 14. Gisela half rounded up + Weeping Angel combat prevent & shuffle:
	if (/^If a source would deal damage to you or a permanent you control, prevent half that damage, rounded up$/i.test(s)) {
		return [
			{
				kind: 'static',
				static: { k: 'staticDamagePrevention', target: 'youAndControlled', amount: 'halfRoundedUp' }
			}
		];
	}
	if (/^If ~ would deal combat damage to a creature, prevent that damage and that creature's owner shuffles it into their library$/i.test(s)) {
		return [
			{
				kind: 'static',
				static: {
					k: 'staticDamagePrevention',
					combatOnly: true,
					dealtByOnly: 'self',
					target: { filter: { types: ['Creature'] } },
					amount: 'all',
					onPrevented: { k: 'shuffleTargetIntoLibrary' }
				}
			}
		];
	}

	// 15. Grafdigger's Cage & Soulless Jailer:
	const cantEnterM = s.match(/^(.+?) cards in (graveyards and libraries|graveyards|libraries) can't enter the battlefield$/i);
	if (cantEnterM) {
		const zones: ZoneType[] = /libraries/.test(cantEnterM[2].toLowerCase()) && /graveyards/.test(cantEnterM[2].toLowerCase())
			? ['graveyard', 'library']
			: /libraries/.test(cantEnterM[2].toLowerCase())
				? ['library']
				: ['graveyard'];
		const filter: ObjectFilter | null = /^permanent$/i.test(cantEnterM[1].trim())
			? { types: ['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle'] }
			: helpers.parseObjectPhraseWithQualifiers(`${cantEnterM[1]} card`, true) ?? parseObjectPhrase(`${cantEnterM[1]} card`);
		if (filter) {
			return [
				{
					kind: 'static',
					static: { k: 'cantEnterFromZones', filter, zones, who: 'all' }
				}
			];
		}
	}
	const cantCastZonesM = s.match(/^Players can't cast (.+?) spells from (graveyards or exile|graveyards|exile)$/i);
	if (cantCastZonesM) {
		const zLow = cantCastZonesM[2].toLowerCase();
		const castFromZones: ZoneType[] = zLow === 'graveyards or exile' ? ['graveyard', 'exile'] : zLow === 'graveyards' ? ['graveyard'] : ['exile'];
		const f =
			helpers.parseObjectPhraseWithQualifiers(`${cantCastZonesM[1]} card`, true) ??
			parseObjectPhrase(`${cantCastZonesM[1]} card`);
		if (f) {
			return [
				{
					kind: 'static',
					static: {
						k: 'ruleModifier',
						rule: 'cantCastMatchingSpells',
						who: { relation: 'each_player' },
						params: { filter: { ...f, castFromZones } }
					}
				}
			];
		}
	}

	// 16. Hithlain Rope:
	if (/^~ can't be sacrificed$/i.test(s)) {
		return [{ kind: 'static', static: { k: 'restriction', affected: 'self', restriction: 'cantBeSacrificed' } }];
	}

	// 17. Combat rules: Instill Energy, Public Enemy:
	if (/^(Enchanted|Equipped) creature can attack as though it had haste$/i.test(s)) {
		return [{ kind: 'static', static: { k: 'combatRule', affected: 'attachedTo', rule: { kind: 'canAttackAsThoughHaste' } } }];
	}
	if (/^All creatures attack (?:enchanted creature's|that player's) controller each combat if able$/i.test(s) || /^All creatures attack enchanted creature's controller each combat if able$/i.test(s)) {
		return [
			{
				kind: 'static',
				static: {
					k: 'combatRule',
					affected: { zone: 'battlefield', types: ['Creature'] },
					rule: { kind: 'mustAttackAttachedController' }
				}
			}
		];
	}

	// 18. Mirror Box, Moraug, Multani, Sword of the Squeak:
	if (/^Each nontoken creature you control gets \+1\/\+1 for each other creature you control with the same name as that creature$/i.test(s)) {
		const cnt: Amount = {
			k: 'count',
			of: { zone: 'battlefield', types: ['Creature'], controller: 'you', other: true, sameNameAsAffected: true }
		};
		return [
			{
				kind: 'static',
				static: {
					k: 'continuous',
					layer: '7c',
					affected: { zone: 'battlefield', types: ['Creature'], controller: 'you', token: false },
					mod: { k: 'pt', power: cnt, toughness: cnt }
				}
			}
		];
	}

	if (/^Each creature you control gets \+1\/\+0 for each time it has attacked this turn$/i.test(s)) {
		return [
			{
				kind: 'static',
				static: {
					k: 'continuous',
					layer: '7c',
					affected: { zone: 'battlefield', types: ['Creature'], controller: 'you' },
					mod: { k: 'pt', power: { k: 'timesAttackedThisTurn', of: { k: 'affected' } }, toughness: { k: 'const', n: 0 } }
				}
			}
		];
	}

	const dualCountPumpM = s.match(/^~ gets ([+-]\d+)\/([+-]\d+) for each (.+?) you control and each \3 cards? in your graveyard$/i);
	if (dualCountPumpM) {
		const bf = helpers.parseObjectPhraseWithQualifiers(dualCountPumpM[3], true) ?? parseObjectPhrase(dualCountPumpM[3]);
		const gy = helpers.parseObjectPhraseWithQualifiers(`${dualCountPumpM[3]} card`, true) ?? parseObjectPhrase(`${dualCountPumpM[3]} card`);
		if (bf && gy) {
			const total: Amount = {
				k: 'sum',
				args: [
					{ k: 'count', of: { ...bf, zone: 'battlefield', controller: 'you' } },
					{ k: 'count', of: { ...gy, zone: 'graveyard', owner: 'you' } }
				]
			};
			const dp = parseInt(dualCountPumpM[1], 10);
			const dt = parseInt(dualCountPumpM[2], 10);
			const scale = (k: number, amt: Amount): Amount => (k === 1 ? amt : k === 0 ? { k: 'const', n: 0 } : { k: 'mul', factor: k, of: amt });
			return [
				{
					kind: 'static',
					static: {
						k: 'continuous',
						layer: '7c',
						affected: 'self',
						mod: { k: 'pt', power: scale(dp, total), toughness: scale(dt, total) }
					}
				}
			];
		}
	}

	const basePtPumpM = s.match(/^Equipped creature gets ([+-]\d+)\/([+-]\d+) for each creature you control with base power or toughness (\d+)$/i);
	if (basePtPumpM) {
		const val = parseInt(basePtPumpM[3], 10);
		const cnt: Amount = {
			k: 'count',
			of: {
				zone: 'battlefield',
				types: ['Creature'],
				controller: 'you',
				basePowerOrToughness: { op: '=', value: { k: 'const', n: val } }
			}
		};
		const dp = parseInt(basePtPumpM[1], 10);
		const dt = parseInt(basePtPumpM[2], 10);
		const scale = (k: number, amt: Amount): Amount => (k === 1 ? amt : k === 0 ? { k: 'const', n: 0 } : { k: 'mul', factor: k, of: amt });
		return [
			{
				kind: 'static',
				static: {
					k: 'continuous',
					layer: '7c',
					affected: 'attachedTo',
					mod: { k: 'pt', power: scale(dp, cnt), toughness: scale(dt, cnt) }
				}
			}
		];
	}

	// 19. Notion Thief:
	if (/^If an opponent would draw a card except the first one they draw in each of their draw steps, instead that player skips that draw and you draw a card$/i.test(s)) {
		return [
			{
				kind: 'replacement',
				replacement: {
					replaces: { event: 'draw', filter: { player: { relation: 'opponent' } } },
					with: { k: 'modify', stealOpponentExtraDraws: true }
				}
			}
		];
	}

	// 20. Raphael, the Muscle:
	const doubleCountersDmgM = s.match(/^Double all damage that (.+?) with counters on them would deal$/i);
	if (doubleCountersDmgM) {
		const rawWho = doubleCountersDmgM[1].replace(/\s+you control$/i, '').trim();
		const youCtrl = /you control$/i.test(doubleCountersDmgM[1]);
		const f = helpers.parseObjectPhraseWithQualifiers(rawWho, true) ?? parseObjectPhrase(rawWho);
		if (f) {
			return [
				{
					kind: 'replacement',
					replacement: {
						replaces: { event: 'damage', filter: {} },
						with: {
							k: 'modify',
							damageMod: {
								mode: 'double',
								sourceFilter: { ...f, zone: 'battlefield', ...(youCtrl ? { controller: 'you' } : {}), hasAnyCounter: true }
							}
						}
					}
				}
			];
		}
	}

	// 21. Tekuthal:
	if (/^If you would proliferate, proliferate twice instead$/i.test(s)) {
		return [
			{
				kind: 'replacement',
				replacement: {
					replaces: { event: 'proliferate', filter: { player: { relation: 'you' } } },
					with: { k: 'modify', proliferateMultiplier: 2 }
				}
			}
		];
	}

	// 22. The Blue Spirit:
	if (/^You may cast the first creature spell you cast each turn as though it had flash$/i.test(s)) {
		return [
			{
				kind: 'static',
				static: {
					k: 'ruleModifier',
					rule: 'castAsThoughFlash',
					who: { relation: 'you' },
					params: { spells: { types: ['Creature'] }, firstMatchingThisTurn: true }
				}
			}
		];
	}

	// 23. Thought Sponge:
	const spongeM = s.match(/^~ enters(?: the battlefield)? with a number of (\S+) counters on it equal to the greatest number of cards an opponent has drawn this turn$/i);
	if (spongeM) {
		const ctr = parseCounterWord(spongeM[1]);
		if (ctr) {
			return [
				{
					kind: 'replacement',
					replacement: {
						selfReplacement: true,
						replaces: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
						with: {
							k: 'modify',
							counters: { counter: ctr, amount: { k: 'greatestOpponentCardsDrawnThisTurn' } }
						}
					}
				}
			];
		}
	}

	// 24. Twins of Discord:
	const colorlessKwM = s.match(/^Each (other )?colorless (.+?) you control has (.+)$/i);
	if (colorlessKwM) {
		const baseF = helpers.parseObjectPhraseWithQualifiers(colorlessKwM[2], true) ?? parseObjectPhrase(colorlessKwM[2]);
		const kw = colorlessKwM[3].trim().toLowerCase();
		if (baseF && /^bloodthirst \d+$/.test(kw)) {
			return [
				{
					kind: 'static',
					static: {
						k: 'continuous',
						layer: '6',
						affected: {
							...baseF,
							zone: 'battlefield',
							controller: 'you',
							colors: [],
							...(colorlessKwM[1] ? { other: true } : {})
						},
						mod: { k: 'addKeywords', keywords: [kw] }
					}
				}
			];
		}
	}

	// 25. Keep depth used to avoid unused var warning
	void depth;
	return null;
}

/**
 * Wave 9S static condition fallbacks (unspent mana, lore counters among Sagas, sacrificed nontoken permanent this turn).
 */
export function tryParseWave9Condition(
	t: string,
	helpers: Wave9StaticHelpers
): Condition | null {
	// "you have six or more unspent mana"
	const unspentM = t.match(/^you have (\S+) or more unspent mana$/i);
	if (unspentM) {
		const min = parseSmallNumber(unspentM[1]);
		if (min !== null) {
			return {
				k: 'compare',
				left: { k: 'unspentManaTotal', player: { k: 'you' } },
				op: '>=',
				right: { k: 'const', n: min }
			};
		}
	}

	// "there are four or more lore counters among Sagas you control"
	const amongCtrM = t.match(/^there are (\S+) or more (\S+) counters among (.+?) you control$/i);
	if (amongCtrM) {
		const min = parseSmallNumber(amongCtrM[1]);
		const ctr = parseCounterWord(amongCtrM[2]);
		const f = helpers.parseObjectPhraseWithQualifiers(amongCtrM[3], true) ?? parseObjectPhrase(amongCtrM[3]);
		if (min !== null && ctr && f) {
			return {
				k: 'compare',
				left: {
					k: 'countersAmong',
					filter: { ...f, zone: 'battlefield', controller: 'you' },
					counter: ctr
				},
				op: '>=',
				right: { k: 'const', n: min }
			};
		}
	}

	// "you've sacrificed a nontoken permanent this turn"
	const sacM = t.match(/^you(?:'ve| have) sacrificed (?:a|an) (.+?) this turn$/i);
	if (sacM) {
		const raw = sacM[1].trim().toLowerCase();
		let filter: ObjectFilter | null = null;
		if (raw === 'nontoken permanent') {
			filter = { token: false };
		} else if (raw === 'permanent') {
			filter = {};
		} else {
			filter = helpers.parseObjectPhraseWithQualifiers(sacM[1], true) ?? parseObjectPhrase(sacM[1]);
		}
		if (filter) {
			return { k: 'sacrificedFilterThisTurn', filter, min: 1, who: 'you' };
		}
	}

	// "an opponent lost life this turn"
	if (/^(?:an )?opponents? lost life this turn$/i.test(t)) {
		return { k: 'opponentLostLifeThisTurn' };
	}

	return null;
}

/**
 * Wave 9S count amount fallback ("the greatest number of creatures a player controls").
 */
export function tryParseWave9CountAmount(
	t: string,
	helpers: Wave9StaticHelpers
): Amount | null {
	const m = t.match(/^the greatest number of (.+?) a player controls$/i);
	if (m) {
		const f = helpers.parseObjectPhraseWithQualifiers(m[1], true) ?? parseObjectPhrase(m[1]);
		if (f) {
			return { k: 'greatestControlledCount', filter: { ...f, zone: 'battlefield' } };
		}
	}
	return null;
}
