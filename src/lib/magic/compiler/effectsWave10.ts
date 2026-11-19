/**
 * Wave 10 compiler effect extensions (pure compiler helpers, zero runtime state).
 *
 * Covers:
 * - Multiplayer / per-player loops (`forEachPlayerLoop`: eachOpponent, eachPlayer, eachOtherPlayer,
 *   turnOrderStartingWithYou, turnOrderStartingWithNextOpponent, chooseOpponent, chooseRandomOpponent)
 * - Punishers & opponent-choice splits (`punisherChoice`, `unlessCost`, `Coin of Fate`, `Deliver Unto Evil`, `Tasigur`)
 * - Type-partition sacrifice (`partitionKeepByTypes`: *Cataclysmic Gearhulk*, *Tragic Arrogance*,
 *   *Liliana, Dreadhorde General*, *Archfiend of Depravity*, *Planetary Annihilation*, *Promise of Loyalty*)
 * - Greatest/least stat controlled selectors (*Soul Shatter*, *Crackling Doom*, *Flare of Malice*, *Papalymo*),
 *   base P/T & powerOrToughness (*Angelic Aberration*, *Warping Wail*), same-name sweepers (*Maelstrom Pulse*,
 *   *Legions to Ashes*, *Echoing Return*), `isColored` (*All Is Dust*, *Ugin*), `differentControllers` (*Cloud's Limit Break*)
 * - Combat prevention/redirection shields (*Deflecting Palm*, *Comeuppance*, *Honorable Passage*, *Mirror Strike*,
 *   *Reflect Damage*, *Angel's Grace*, *Gatta and Luzzu*, *Surge of Salvation*, *Arachnogenesis*, *Galadhrim Ambush*,
 *   *Riot Control*, *Gideon's Sacrifice*, *Boros Fury-Shield*), *Kardur*, *Akroan War*, *Trench Behemoth*,
 *   *Mandate of Peace*, *Tifa*, *Ram Through*, *The Last Agni Kai*, *Misleading Signpost*, *Ruhan*,
 *   *Territorial Hellkite*, *Vial Smasher*, *Soulfire Eruption*, *Deadly Tempest*, *Tombstone Stairwell*, etc.
 */
import type {
	Amount,
	Condition,
	CostDef,
	DamagePreventionSpec,
	EffectStep,
	ObjectFilter,
	PlayerRef,
	Ref,
	Selector,
	Span,
	TargetSpec,
	TriggerDef
} from '../ir.ts';
import type { ManaColor } from '../types.ts';
import type { EffectsWave9ParserLike } from './effectsWave9.ts';

export interface EffectsWave10Helpers {
	objectFilter: (phrase: string) => ObjectFilter | null;
	objectPhrase: (
		p: EffectsWave9ParserLike,
		phrase: string
	) => { selector: Selector; ref?: Ref; fromZone?: import('../types.ts').ZoneType; plural?: boolean } | null;
	targetPhrase: (p: EffectsWave9ParserLike, text: string) => Omit<TargetSpec, 'min' | 'max'> | null;
	playerPhrase: (p: EffectsWave9ParserLike, phrase: string) => Selector | null;
	singlePlayer: (sel: Selector) => PlayerRef | null;
	amountWord: (p: EffectsWave9ParserLike, raw: string) => Amount | null;
	equalTo: (p: EffectsWave9ParserLike, raw: string) => Amount | null;
	numberWord: (raw: string) => number | null;
	singularSubtype: (raw: string) => string | null;
	parseCost: (raw: string) => CostDef[] | null;
	clauses: (p: EffectsWave9ParserLike, text: string, offset: number) => boolean;
	sentence: (p: EffectsWave9ParserLike, text: string, span: Span, optional?: boolean) => boolean;
	parseSubEffects: (
		text: string,
		offset: number,
		context: import('./effects.ts').EffectContext,
		trigger?: TriggerDef,
		seedLastObject?: { ref: Ref; verb: EffectStep['verb'] }
	) => { steps: EffectStep[]; targets: TargetSpec[]; unparsed: Span[] };
}

const YOU: Selector = { k: 'player', filter: { relation: 'you' } };
const NONE: Selector = { k: 'none' };

const COLOR_WORD_TO_CODE: Readonly<Record<string, ManaColor>> = {
	white: 'W',
	blue: 'U',
	black: 'B',
	red: 'R',
	green: 'G',
	colorless: 'C'
};

function refToSelectorW10(ref: Ref): Selector {
	switch (ref.k) {
		case 'self':
			return { k: 'self' };
		case 'binding':
			return { k: 'binding', name: ref.name };
		case 'target':
			return { k: 'target', index: ref.index };
		case 'eventObject':
			return { k: 'eventObject' };
		case 'attachedTo':
			return { k: 'attachedTo' };
		default:
			return { k: 'self' };
	}
}

function parseColorListW10(raw: string): ManaColor[] | null {
	const cleaned = raw
		.trim()
		.toLowerCase()
		.replace(/\s+and\/or\s+/g, ', ')
		.replace(/\s+or\s+/g, ', ')
		.replace(/\s+and\s+/g, ', ');
	const parts = cleaned.split(/\s*,\s*/).filter(Boolean);
	const out: ManaColor[] = [];
	for (const p of parts) {
		const code = COLOR_WORD_TO_CODE[p];
		if (!code) return null;
		if (!out.includes(code)) out.push(code);
	}
	return out.length > 0 ? out : null;
}

function parseSubtypeListW10(raw: string, singularSubtype: (s: string) => string | null): string[] | null {
	const cleaned = raw
		.trim()
		.replace(/,\s*(?:and\/or|or|and)\s+/gi, ', ')
		.replace(/\s+(?:and\/or|or|and)\s+/gi, ', ');
	const parts = cleaned
		.split(/\s*,\s*/)
		.map((s) => s.trim().replace(/^an?\s+/i, ''))
		.filter(Boolean);
	if (parts.length === 0) return null;
	const out: string[] = [];
	for (const p of parts) {
		const sub = singularSubtype(p);
		if (!sub) return null;
		out.push(sub);
	}
	return out;
}

function parseTypesListW10(raw: string): string[] | null {
	const map: Record<string, string> = {
		artifact: 'Artifact',
		artifacts: 'Artifact',
		creature: 'Creature',
		creatures: 'Creature',
		enchantment: 'Enchantment',
		enchantments: 'Enchantment',
		planeswalker: 'Planeswalker',
		planeswalkers: 'Planeswalker',
		land: 'Land',
		lands: 'Land',
		battle: 'Battle',
		battles: 'Battle'
	};
	const cleaned = raw
		.trim()
		.toLowerCase()
		.replace(/,\s*(?:and\/or|or|and)\s+/g, ', ')
		.replace(/\s+(?:and\/or|or|and)\s+/g, ', ');
	const parts = cleaned.split(/\s*,\s*/).map((s) => s.replace(/^an?\s+/, '').trim()).filter(Boolean);
	const out: string[] = [];
	for (const p of parts) {
		const t = map[p];
		if (!t) return null;
		if (!out.includes(t)) out.push(t);
	}
	return out.length > 0 ? out : null;
}

function parseStatW10(raw: string): 'power' | 'toughness' | 'manaValue' | null {
	const low = raw.trim().toLowerCase();
	if (low === 'power') return 'power';
	if (low === 'toughness') return 'toughness';
	if (low === 'mana value') return 'manaValue';
	return null;
}

function normalizeCostVerbPhraseW10(raw: string): string {
	return raw
		.trim()
		.replace(/,\s*of their choice/gi, '')
		.replace(/\s+of their choice$/i, '')
		.replace(/\b(sacrifices|discards|exiles|pays)\b/gi, (_, v: string) => v.slice(0, -1));
}

/** Parses Wave 10 object filter qualifiers. */
export function parseObjectFilterWave10(
	raw: string,
	parseFilter: (sub: string) => ObjectFilter | null,
	singularSubtype: (s: string) => string | null,
	numberWord: (s: string) => number | null
): ObjectFilter | null {
	const t = raw.trim();

	// "... that are one or more colors" / "... that's one or more colors" (*All Is Dust*, *Ugin*)
	const coloredM = t.match(/^(.+?)\s+(?:that are|that's) one or more colors$/i);
	if (coloredM) {
		const inner = parseFilter(coloredM[1].trim());
		if (inner) return { ...inner, isColored: true };
	}

	// "... that aren't of the chosen type" (*Crippling Fear*)
	const notChosenM = t.match(/^(.+?)\s+that (?:isn't|aren't) of the chosen type$/i);
	if (notChosenM) {
		const inner = parseFilter(notChosenM[1].trim());
		if (inner) return { ...inner, notOfChosenType: true };
	}

	// "... without a <counter> counter on it" (*Wave Goodbye*)
	const withoutCtrM = t.match(/^(.+?)\s+without (?:a|an) ([a-z0-9+/ -]+?) counter on (?:it|them)$/i);
	if (withoutCtrM) {
		const inner = parseFilter(withoutCtrM[1].trim());
		const ct = withoutCtrM[2].trim().toLowerCase() as import('../types.ts').CounterType;
		if (inner) return { ...inner, notHasCounters: ct };
	}

	// "... that didn't enter this turn" (*Let the Galaxy Burn*)
	const notEntM = t.match(/^(.+?)\s+that didn't enter this turn$/i);
	if (notEntM) {
		const inner = parseFilter(notEntM[1].trim());
		if (inner) return { ...inner, notEnteredThisTurn: true };
	}

	// "... created with ~" (*Tombstone Stairwell*)
	const createdSelfM = t.match(/^(.+?)\s+created with ~$/i);
	if (createdSelfM) {
		const sub = createdSelfM[1].trim();
		const inner = /^tokens?$/i.test(sub) ? ({ token: true } as ObjectFilter) : parseFilter(sub);
		if (inner) return { ...inner, createdWithSelf: true };
	}

	// "... each with base power or toughness N or less/greater" (*Angelic Aberration*)
	const basePtM = t.match(
		/^(.+?)\s+(?:each )?with base power or toughness (\S+) or (less|lower|greater|more|higher)$/i
	);
	if (basePtM) {
		const n = numberWord(basePtM[2]);
		const inner = parseFilter(basePtM[1].trim());
		if (n !== null && inner) {
			const dir = basePtM[3].toLowerCase();
			return {
				...inner,
				basePowerOrToughness: {
					op: dir === 'less' || dir === 'lower' ? '<=' : '>=',
					value: { k: 'const', n }
				}
			};
		}
	}

	// "... with power or toughness N or less/greater" (*Warping Wail*)
	const ptOrM = t.match(
		/^(.+?)\s+(?:each )?with power or toughness (\S+) or (less|lower|greater|more|higher)$/i
	);
	if (ptOrM) {
		const n = numberWord(ptOrM[2]);
		const inner = parseFilter(ptOrM[1].trim());
		if (n !== null && inner) {
			const dir = ptOrM[3].toLowerCase();
			return {
				...inner,
				powerOrToughness: {
					op: dir === 'less' || dir === 'lower' ? '<=' : '>=',
					value: { k: 'const', n }
				}
			};
		}
	}

	// "... that's an Insect, Rat, Spider, or Squirrel" / "... that isn't an Insect, Rat, Spider, or Squirrel"
	const isSubListM = t.match(/^(.+?)\s+(?:that's|that are)\s+(?:a |an )?(.+)$/i);
	if (isSubListM && !/one or more colors|attacking|blocking|tapped|untapped|of the chosen/i.test(isSubListM[2])) {
		const subs = parseSubtypeListW10(isSubListM[2], singularSubtype);
		const inner = parseFilter(isSubListM[1].trim());
		if (subs && inner) {
			return { ...inner, subtypes: [...(inner.subtypes ?? []), ...subs] };
		}
	}
	const notSubM = t.match(/^(.+?)\s+that (?:isn't|aren't) (?:a |an )?(.+)$/i);
	if (notSubM && !/of the chosen type|colorless/i.test(notSubM[2])) {
		const subs = parseSubtypeListW10(notSubM[2], singularSubtype);
		const inner = parseFilter(notSubM[1].trim());
		if (subs && inner) {
			return { ...inner, notSubtypes: [...(inner.notSubtypes ?? []), ...subs] };
		}
	}

	// "other permanents" (*God-Eternal Bontu*)
	if (/^other permanents?$/i.test(t)) {
		return { other: true };
	}

	// "... <controller> with/without/that ..." (*Scourge of Fleets*)
	const ctrlBeforeM = t.match(
		/^(.+?)\s+(you control|you don't control|an opponent controls|your opponents control|opponents control)\s+((?:with|without|that)\s+.+)$/i
	);
	if (ctrlBeforeM) {
		const reordered = `${ctrlBeforeM[1].trim()} ${ctrlBeforeM[3].trim()} ${ctrlBeforeM[2].trim()}`;
		const res = parseFilter(reordered);
		if (res) return res;
	}

	// "... with the greatest (power|toughness|mana value) among <types> [that player/they control]" (*Soul Shatter*)
	const greatestM = t.match(
		/^(.+?)\s+with the (greatest|least) (power|toughness|mana value) among ([^,]+?)(?:\s+(?:they|that player) controls?)?$/i
	);
	if (greatestM) {
		const which = greatestM[2].toLowerCase() === 'greatest' ? 'greatest' : 'least';
		const stat = parseStatW10(greatestM[3]);
		const poolTypes = parseTypesListW10(greatestM[4]);
		const inner = parseFilter(greatestM[1].trim().replace(/^(?:an?\s+)/i, ''));
		if (stat && poolTypes && inner) {
			if (which === 'greatest') {
				return {
					...inner,
					greatestStatAmongControlled: stat,
					greatestStatAmongControlledTypes: poolTypes
				};
			}
			return {
				...inner,
				leastStatAmongControlled: stat,
				greatestStatAmongControlledTypes: poolTypes
			};
		}
	}

	// "... whose controller was dealt combat damage by ~ this turn" (*Steel Hellkite*)
	const cdCtrlM = t.match(
		/^(.+?)\s+(?:with mana value X\s+)?whose controller was dealt combat damage by ~ this turn$/i
	);
	if (cdCtrlM) {
		const inner = parseFilter(cdCtrlM[1].trim());
		if (inner) {
			const hasMvX = /\bwith mana value X\b/i.test(t);
			return {
				...inner,
				...(hasMvX ? { manaValueCompare: { op: '=', value: { k: 'x' } } } : {}),
				controllerDealtCombatDamageBySelfThisTurn: true
			};
		}
	}

	// "... with mana value equal to the number of <counter> counters on ~" (*Blast Zone*)
	const mvEqCtrM = t.match(/^(.+?)\s+with mana value equal to the number of ([a-z0-9+/ -]+?) counters on ~$/i);
	if (mvEqCtrM) {
		const inner = parseFilter(mvEqCtrM[1].trim());
		const counterRaw = mvEqCtrM[2].trim().toLowerCase();
		if (inner && counterRaw) {
			return {
				...inner,
				manaValueCompare: {
					op: '=',
					value: { k: 'countersOn', of: { k: 'self' }, counter: counterRaw as import('../types.ts').CounterType }
				}
			};
		}
	}

	// Trailing controller qualifier when objectFilter didn't call splitController (*Riot Control*, *Scourge of Fleets*)
	const trailCtrlM = t.match(
		/^(.+?)\s+(you control|you don't control|an opponent controls|your opponents control|opponents control)$/i
	);
	if (trailCtrlM) {
		const inner = parseFilter(trailCtrlM[1].trim());
		if (inner) {
			return {
				...inner,
				controller: trailCtrlM[2].toLowerCase() === 'you control' ? 'you' : 'opponent'
			};
		}
	}

	return null;
}

/** Parses Wave 10 target phrases (`differentControllers`, `chosenByEventPlayer`, `any other target`). */
export function parseTargetSpecWave10(
	phrase: string,
	parseFilter: (sub: string) => ObjectFilter | null
): Omit<TargetSpec, 'min' | 'max'> | null {
	const t = phrase.trim();
	if (/^any other target$/i.test(t)) {
		return { kind: 'objectOrPlayer', filter: {}, otherTarget: true };
	}
	// *Cloud's Limit Break*: "tapped creatures with different controllers"
	const diffCtrlM = t.match(/^(.+?)\s+with different controllers$/i);
	if (diffCtrlM) {
		const f = parseFilter(diffCtrlM[1].trim());
		if (f) return { kind: 'object', filter: { zone: 'battlefield', ...f }, differentControllers: true };
	}
	// *Bladegriff Prototype*: "nonland permanent of that player's choice that one of your opponents controls"
	const oppChoiceM = t.match(/^(.+?)\s+of that player's choice that one of your opponents controls$/i);
	if (oppChoiceM) {
		const f = parseFilter(oppChoiceM[1].trim());
		if (f) {
			return {
				kind: 'object',
				filter: { zone: 'battlefield', controller: 'opponent', ...f },
				chosenByEventPlayer: true
			};
		}
	}
	return null;
}

/** Parses Wave 10 dynamic Amount expressions. */
export function parseAmountWave10(
	p: EffectsWave9ParserLike,
	raw: string,
	h: EffectsWave10Helpers
): Amount | null {
	const t = raw.trim();

	// "the number of opponents who control more <filter> than you" (*Heidegger*)
	const oppMoreM = t.match(/^(?:the number of )?opponents who control more (.+?) than you$/i);
	if (oppMoreM) {
		const f = h.objectFilter(oppMoreM[1].trim());
		if (f) return { k: 'opponentsControllingMoreCount', filter: f };
	}

	// "the number of opponents who have N or fewer cards in hand" (*Bandit's Talent*)
	const oppHandM = t.match(/^(?:the number of )?opponents? who (?:has|have) (\S+) or fewer cards in hand$/i);
	if (oppHandM) {
		const n = h.numberWord(oppHandM[1]);
		if (n !== null) return { k: 'opponentsWithHandMaxCount', max: n };
	}

	// "the number of your opponents who were dealt combat damage by ~ or a Dragon this turn" (*Estinien*)
	const estM = t.match(
		/^(?:the number of )?(?:your )?opponents who were dealt combat damage by ~ or (?:a|an) ([a-z]+) this turn$/i
	);
	if (estM) {
		const sub = h.singularSubtype(estM[1].trim());
		if (sub) return { k: 'opponentsDealtCombatDamageBySelfOrSubtypeThisTurn', subtype: sub };
	}

	// "the number of creatures attacking you / attacking them" (*Arachnogenesis*, *Within Range*)
	const atkToM = t.match(/^(?:the number of )?creatures attacking (you|them|that player)$/i);
	if (atkToM) {
		const who = atkToM[1].toLowerCase();
		const pl: PlayerRef = who === 'you' ? { k: 'you' } : { k: 'eachLoopPlayer' };
		return { k: 'attackingCountToPlayer', player: pl };
	}

	// "the number of spells you've cast this turn" (*Noise Marine*, *Volcanic Torrent*)
	if (/^(?:the number of )?spells you(?:'ve| have) cast this turn$/i.test(t)) {
		return { k: 'spellsCastThisTurnCount', who: 'you' };
	}

	// "the number of instants and/or sorcery cards in your graveyard" -> fallback
	const gyCountM = t.match(/^(?:the number of )?(.+?) in (your|that player's) graveyard$/i);
	if (gyCountM) {
		const f = h.objectFilter(gyCountM[1].trim());
		if (f) {
			return {
				k: 'count',
				of: {
					...f,
					zone: 'graveyard',
					...(gyCountM[2].toLowerCase() === 'your' ? { owner: 'you' as const } : { ownerRef: { k: 'eachLoopPlayer' } })
				}
			};
		}
	}

	const xPlusM = t.match(/^(?:X|\{X\})\s+plus\s+(\S+)$/i);
	if (xPlusM) {
		const n = h.numberWord(xPlusM[1]);
		if (n !== null) {
			return { k: 'sum', args: [{ k: 'x' }, { k: 'const', n }] };
		}
	}

	// "the total mana value of those cards" (*Command the Dreadhorde*, *Combustible Gearhulk*)
	if (/^(?:the )?total mana value of those cards$/i.test(t)) {
		if (p.lastObject?.ref.k === 'target') {
			return { k: 'totalManaValueOfTargetSpec', index: p.lastObject.ref.index };
		}
		if (p.steps.some((s) => s.verb === 'mill')) {
			return { k: 'countedThisWay', kind: 'milledTotalManaValue' };
		}
		if (p.targets.length > 0) {
			return { k: 'totalManaValueOfTargetSpec', index: 0 };
		}
	}

	// "a third of their life, rounded up" (*Dire Fleet Ravager*)
	const fracM = t.match(/^a (half|third|quarter) of (?:their|that player's|your) life, rounded (up|down)$/i);
	if (fracM) {
		const denom = fracM[1].toLowerCase() === 'half' ? 2 : fracM[1].toLowerCase() === 'third' ? 3 : 4;
		return {
			k: 'fractionalLifeLoss',
			player: { k: 'eachLoopPlayer' },
			denominator: denom,
			round: fracM[2].toLowerCase() === 'up' ? 'up' : 'down'
		};
	}

	if (/^(?:the number of )?opponents who (?:drew a card|did|searched a library) this way$/i.test(t)) {
		return { k: 'countedThisWay', kind: 'opponentsDidThisWay' };
	}
	if (/^(?:the number of )?opponents who (?:didn't|couldn't)$/i.test(t)) {
		return { k: 'countedThisWay', kind: 'opponentsDidntThisWay' };
	}
	if (/^(?:the number of )?nonland cards revealed this way$/i.test(t)) {
		return { k: 'countedThisWay', kind: 'nonlandRevealedThisWay' };
	}
	if (/^(?:the number of )?land cards put into a graveyard this way$/i.test(t)) {
		return { k: 'countedThisWay', kind: 'landCardsPutIntoGraveyardThisWay' };
	}
	if (/^(?:the number of )?creatures (?:they|that player) controlled that were destroyed this way$/i.test(t)) {
		return { k: 'countedThisWay', kind: 'destroyedControlledByPlayerThisWay' };
	}
	if (/^(?:the number of )?creatures dealt damage this way$/i.test(t)) {
		return { k: 'countedThisWay', kind: 'creaturesDealtDamageThisWay' };
	}
	if (/^(?:the number of )?counters among creatures (?:target player|you) controls$/i.test(t)) {
		const who = /you control/i.test(t)
			? ({ k: 'you' } as const)
			: (() => {
					const sel = h.playerPhrase(p, 'target player');
					return sel ? h.singlePlayer(sel) ?? ({ k: 'you' } as const) : ({ k: 'you' } as const);
				})();
		return { k: 'countersAmongControlled', filter: { types: ['Creature'] }, player: who };
	}

	return null;
}

/** Parses Wave 10 resolution / intervening-if conditions. */
export function parseConditionWave10(
	p: EffectsWave9ParserLike,
	rawCondText: string,
	h: EffectsWave10Helpers
): Condition | null {
	const t = rawCondText.trim().replace(/^if\s+/i, '');

	if (/^it's the first combat phase of your turn$/i.test(t)) {
		return { k: 'isFirstCombatPhaseOfTurn' };
	}
	if (/^(?:that player|they) (?:has|have) more cards in hand than you$/i.test(t)) {
		return { k: 'opponentHasMoreCardsInHandThan', who: { k: 'chosenOpponent' } };
	}
	if (/^an opponent controls more lands than you$/i.test(t)) {
		return {
			k: 'compare',
			left: { k: 'opponentsControllingMoreCount', filter: { types: ['Land'] } },
			op: '>=',
			right: { k: 'const', n: 1 }
		};
	}
	if (
		/^you control (?:a|the) creature with the greatest power(?: or tied for the greatest power)?(?: among creatures on the battlefield)?$/i.test(
			t
		)
	) {
		return {
			k: 'playerControlsFilter',
			player: { k: 'you' },
			filter: { types: ['Creature'], greatestStatAmongControlled: 'power' }
		};
	}
	const pwrGeM = t.match(/^~'s power is (\S+) or greater$/i);
	if (pwrGeM) {
		const n = h.numberWord(pwrGeM[1]);
		if (n !== null) {
			return { k: 'compare', left: { k: 'stat', of: { k: 'self' }, stat: 'power' }, op: '>=', right: { k: 'const', n } };
		}
	}
	return null;
}

function attachOnPreventedRiderW10(
	p: EffectsWave9ParserLike,
	specUpdate: Partial<DamagePreventionSpec>
): boolean {
	for (let i = p.steps.length - 1; i >= 0; i--) {
		const st = p.steps[i]!;
		if (st.verb === 'preventDamage' && st.params?.preventSpec) {
			st.params.preventSpec = { ...st.params.preventSpec, ...specUpdate };
			return true;
		}
	}
	return false;
}

function addPartitionStep(
	p: EffectsWave9ParserLike,
	span: Span,
	params: NonNullable<EffectStep['params']>,
	actor?: PlayerRef
): true {
	p.push({ verb: 'partitionKeepByTypes', subject: NONE, ...(actor ? { actor } : {}), params, span }, false);
	return true;
}

function pushWithPendingRepeat(
	p: EffectsWave9ParserLike,
	step: EffectStep,
	actsOnObjects: boolean
): void {
	const last = p.steps[p.steps.length - 1];
	if (
		step.verb === 'punisherChoice' &&
		step.params?.punisher &&
		last?.verb === 'punisherChoice' &&
		last.params?.punisher?.repeatCount &&
		last.params.punisher.defaultSteps.length === 0 &&
		!last.params.punisher.unlessCost &&
		!last.params.punisher.unlessEffect
	) {
		step.params.punisher.repeatCount = last.params.punisher.repeatCount;
		p.steps[p.steps.length - 1] = step;
		return;
	}
	p.push(step, actsOnObjects);
}

/** Main Wave 10 sentence & clause parser. */
export function parseSentenceWave10(
	p: EffectsWave9ParserLike,
	text: string,
	span: Span,
	h: EffectsWave10Helpers
): boolean {
	const t = text.trim();
	const low = t.toLowerCase();

	// 1. End combat phase (*Mandate of Peace*)
	if (low === 'end the combat phase') {
		p.push({ verb: 'endCombatPhase', subject: NONE, span }, false);
		return true;
	}

	// 2. Reselect attack target (*Misleading Signpost*)
	if (/^reselect which player or permanent target attacking creature is attacking$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'], attacking: true },
			min: 1,
			max: 1
		});
		p.push({ verb: 'reselectAttackTarget', subject: { k: 'target', index: idx }, span }, true);
		return true;
	}

	// 3. *Gideon's Sacrifice* / *Gatta and Luzzu* preambles
	if (/^choose a creature or planeswalker you control$/i.test(t)) {
		return true;
	}
	const chooseTargetObjM = t.match(/^choose (another )?(up to one )?target (.+)$/i);
	if (chooseTargetObjM) {
		const isAnother = Boolean(chooseTargetObjM[1]);
		const isUpToOne = Boolean(chooseTargetObjM[2]);
		const spec = h.targetPhrase(p, chooseTargetObjM[3].trim());
		if (spec) {
			const idx = p.addTarget({
				...spec,
				min: isUpToOne ? 0 : 1,
				max: 1,
				...(isAnother ? { otherTarget: true } : {})
			});
			if (spec.kind === 'player') {
				p.lastPlayer = { k: 'playerRef', ref: { k: 'target', index: idx } };
			} else {
				p.lastObject = { ref: { k: 'target', index: idx }, stepIndex: p.steps.length };
			}
			return true;
		}
	}

	// 4. *Angel's Grace* life floor
	if (
		/^(?:until end of turn,\s*)?damage that would reduce your life total to less than 1 reduces it to 1 instead$/i.test(
			t
		)
	) {
		p.push(
			{
				verb: 'preventDamage',
				subject: YOU,
				params: {
					preventSpec: {
						mode: 'all',
						combatOnly: false,
						scope: 'subject',
						minLifeFloor: 1
					}
				},
				span
			},
			false
		);
		return true;
	}

	// 5. *Comeuppance* main shield & follow-up riders
	if (
		/^prevent all damage that would be dealt to you and planeswalkers you control this turn by sources you don't control$/i.test(
			t
		)
	) {
		p.push(
			{
				verb: 'preventDamage',
				subject: NONE,
				params: {
					preventSpec: {
						mode: 'all',
						combatOnly: false,
						scope: 'subject',
						youAndPlaneswalkersYouControl: true,
						fromSourcesYouDontControl: true
					}
				},
				span
			},
			false
		);
		return true;
	}
	if (/^if damage from a creature source is prevented this way, ~ deals that much damage to that creature$/i.test(t)) {
		return attachOnPreventedRiderW10(p, {
			onPreventedCreature: { kind: 'dealDamageEqual', to: 'sourceCreature' }
		});
	}
	if (
		/^if damage from a noncreature source is prevented this way, ~ deals that much damage to (?:that|the) source's controller$/i.test(
			t
		)
	) {
		return attachOnPreventedRiderW10(p, {
			onPreventedNoncreature: { kind: 'dealDamageEqual', to: 'sourceController' }
		});
	}

	// 6. *Deflecting Palm* & *Honorable Passage* follow-up rider
	const palmRiderM = t.match(
		/^if damage (?:(from (?:a|an) [a-z]+ source) )?is prevented this way, ~ deals that much damage to (?:that|the) source's controller$/i
	);
	if (palmRiderM) {
		const colorCols = palmRiderM[1]
			? parseColorListW10(palmRiderM[1].replace(/^from (?:a|an) /i, '').replace(/ source$/i, ''))
			: null;
		return attachOnPreventedRiderW10(p, {
			onPreventedToDamageSourceController: true,
			...(colorCols ? { redirectSourceColorFilter: colorCols } : {})
		});
	}

	// 7. *Reflect Damage*, *Mirror Strike*, *Gideon's Sacrifice*
	if (
		/^the next time a source of your choice would deal damage this turn, that damage is dealt to that source's controller instead$/i.test(
			t
		)
	) {
		p.push(
			{
				verb: 'preventDamage',
				subject: NONE,
				params: {
					preventSpec: {
						mode: 'all',
						combatOnly: false,
						scope: 'any',
						chooseSource: true,
						nextDamageEventOnly: true,
						redirectTo: 'sourceController'
					}
				},
				span
			},
			false
		);
		return true;
	}
	if (
		/^all combat damage that would be dealt to you this turn by target unblocked creature is dealt to its controller instead$/i.test(
			t
		)
	) {
		const srcIdx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'], attacking: true },
			min: 1,
			max: 1
		});
		p.push(
			{
				verb: 'preventDamage',
				subject: YOU,
				params: {
					preventSpec: {
						mode: 'all',
						combatOnly: true,
						scope: 'subject',
						fromSource: { k: 'target', index: srcIdx },
						redirectTo: 'sourceController'
					}
				},
				span
			},
			false
		);
		return true;
	}
	if (
		/^all damage that would be dealt this turn to you and permanents you control is dealt to the chosen permanent instead$/i.test(
			t
		)
	) {
		p.push(
			{
				verb: 'preventDamage',
				subject: NONE,
				params: {
					preventSpec: {
						mode: 'all',
						combatOnly: false,
						scope: 'subject',
						allDamageToYouAndPerms: true,
						redirectTo: 'chosenPermanent'
					}
				},
				span
			},
			false
		);
		return true;
	}

	// 8. *Surge of Salvation*, *Arachnogenesis*, *Galadhrim Ambush*, *Gatta and Luzzu*, *Boros Fury-Shield*
	const surgeM = t.match(/^prevent all (combat )?damage that (.+?) sources would deal to (.+?) this turn$/i);
	if (surgeM) {
		const cols = parseColorListW10(surgeM[2]);
		const targetObj = h.objectPhrase(p, surgeM[3].trim());
		if (cols && targetObj) {
			p.push(
				{
					verb: 'preventDamage',
					subject: targetObj.selector,
					params: {
						preventSpec: {
							mode: 'all',
							combatOnly: Boolean(surgeM[1]),
							scope: 'subject',
							fromSourceColors: cols
						}
					},
					span
				},
				false
			);
			return true;
		}
	}
	const nonSubFogM = t.match(/^prevent all (combat )?damage that would be dealt this turn by non-([a-z]+) creatures$/i);
	if (nonSubFogM) {
		const sub = h.singularSubtype(nonSubFogM[2].trim());
		if (sub) {
			p.push(
				{
					verb: 'preventDamage',
					subject: NONE,
					params: {
						preventSpec: {
							mode: 'all',
							combatOnly: Boolean(nonSubFogM[1]),
							scope: 'any',
							fromSourceNotSubtypes: [sub]
						}
					},
					span
				},
				false
			);
			return true;
		}
	}
	if (
		/^if damage would be dealt to that creature this turn, prevent that damage and put that many \+1\/\+1 counters on it$/i.test(
			t
		) &&
		p.itRef()
	) {
		const it = p.itRef()!;
		p.push(
			{
				verb: 'preventDamage',
				subject: refToSelectorW10(it),
				params: {
					preventSpec: {
						mode: 'all',
						combatOnly: false,
						scope: 'subject',
						onPrevented: { kind: 'putCountersEqual', counter: '+1/+1' }
					}
				},
				span
			},
			false
		);
		return true;
	}
	if (
		/^if \{R\} was spent to cast ~, ~ deals damage to that creature's controller equal to the creature's power$/i.test(
			t
		)
	) {
		let ref: Ref | null = p.itRef() ?? null;
		if (!ref) {
			for (let i = p.steps.length - 1; i >= 0; i--) {
				const ps = p.steps[i]!;
				if (ps.verb === 'preventDamage') {
					const fs = ps.params?.preventSpec?.fromSource;
					if (fs && fs.k === 'target') {
						ref = { k: 'target', index: fs.index };
						break;
					}
					if (ps.subject.k === 'target') {
						ref = { k: 'target', index: ps.subject.index };
						break;
					}
				}
			}
		}
		if (ref) {
			p.push(
				{
					verb: 'damage',
					subject: { k: 'playerRef', ref: { k: 'controllerOf', of: ref } },
					amount: { k: 'stat', of: ref, stat: 'power', lki: true },
					condition: { k: 'sameColorManaSpentAtLeast', min: 1, color: 'R' },
					params: {
						damageSource: { k: 'self' }
					},
					span
				},
				false
			);
			return true;
		}
	}

	// 9. *Kardur*, *The Akroan War* II, *Trench Behemoth*, *Tifa*, *Ruhan*, *Territorial Hellkite*
	const kardurM = t.match(
		/^until your next turn, creatures your opponents control attack each combat if able( and attack a player other than you if able)?$/i
	);
	if (kardurM) {
		p.push(
			{
				verb: 'combatRestriction',
				subject: NONE,
				params: {
					untilYourNextTurnCombatDirective: {
						mustAttack: true,
						...(kardurM[1] ? { avoidYou: true } : {})
					}
				},
				span
			},
			false
		);
		return true;
	}
	if (/^target creature an opponent controls attacks during its controller's next combat phase if able$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'], controller: 'opponent' },
			min: 1,
			max: 1
		});
		p.push(
			{
				verb: 'combatRestriction',
				subject: { k: 'target', index: idx },
				params: { mustAttackNextCombat: true },
				span
			},
			true
		);
		return true;
	}
	if (/^if it's the first combat phase of your turn, there is an additional combat phase after this phase$/i.test(t)) {
		p.push(
			{
				verb: 'extraCombatPhase',
				subject: NONE,
				condition: { k: 'isFirstCombatPhaseOfTurn' },
				span
			},
			false
		);
		return true;
	}
	const randOppM = t.match(/^choose an opponent at random( that ~ didn't attack during your last combat)?$/i);
	if (randOppM) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'chooseRandomOpponent',
					chooseRandomOpponent: true,
					...(randOppM[1] ? { excludeAttackedLastCombat: true } : {})
				},
				span
			},
			false
		);
		p.lastPlayer = { k: 'playerRef', ref: { k: 'chosenOpponent' } };
		return true;
	}
	if (/^choose an opponent$/i.test(t)) {
		p.push({ verb: 'forEachPlayerLoop', subject: NONE, params: { loopPlayers: 'chooseOpponent' }, span }, false);
		p.lastPlayer = { k: 'playerRef', ref: { k: 'chosenOpponent' } };
		return true;
	}
	if (/^~ attacks that player this combat if able$/i.test(t)) {
		p.push(
			{
				verb: 'combatRestriction',
				subject: { k: 'self' },
				params: { mustAttackPlayerRef: { k: 'chosenOpponent' } },
				span
			},
			false
		);
		return true;
	}
	if (/^if you can't choose an opponent this way, tap ~$/i.test(t)) {
		p.push(
			{
				verb: 'tap',
				subject: { k: 'self' },
				condition: undefined,
				ifPrecedingDeclined: Math.max(0, p.steps.length - 2),
				span
			},
			false
		);
		return true;
	}

	// 10. *Ram Through*, *The Last Agni Kai*, *Vial Smasher*, *Soulfire Eruption*, *Tombstone Stairwell*
	if (/^if the creature you control has trample, excess damage is dealt to that creature's controller instead$/i.test(t)) {
		for (let i = p.steps.length - 1; i >= 0; i--) {
			if (p.steps[i]!.verb === 'damage') {
				p.steps[i]!.params = { ...(p.steps[i]!.params ?? {}), excessDamageToControllerIfTrample: true };
				return true;
			}
		}
		return false;
	}
	const agniM = t.match(/^if the creature the opponent controls is dealt excess damage this way, add that much \{([WUBRGC])\}$/i);
	if (agniM) {
		for (let i = p.steps.length - 1; i >= 0; i--) {
			if (p.steps[i]!.verb === 'fight') {
				p.steps[i]!.params = {
					...(p.steps[i]!.params ?? {}),
					excessDamageToMana: agniM[1].toUpperCase() as ManaColor
				};
				return true;
			}
		}
		return false;
	}
	const dmgOppPwM = t.match(/^~ deals damage equal to (.+?) to that player or a planeswalker that player controls$/i);
	if (dmgOppPwM) {
		const amt = h.equalTo(p, dmgOppPwM[1].trim());
		if (amt) {
			p.push(
				{
					verb: 'damage',
					subject: NONE,
					amount: amt,
					params: { orPlaneswalkerControlledBy: { k: 'chosenOpponent' }, damageSource: { k: 'self' } },
					span
				},
				false
			);
			return true;
		}
	}
	if (/^for each of them, exile the top card of your library, then ~ deals damage equal to that card's mana value to that permanent or player$/i.test(t)) {
		p.push(
			{
				verb: 'damage',
				subject: { k: 'target', index: Math.max(0, p.targets.length - 1) },
				params: { soulfireExileDamagePerTarget: true, damageSource: { k: 'self' } },
				span
			},
			false
		);
		return true;
	}
	if (/^they can't be regenerated$/i.test(t)) {
		for (let i = p.steps.length - 1; i >= 0; i--) {
			if (p.steps[i]!.verb === 'destroy') {
				p.steps[i]!.params = { ...(p.steps[i]!.params ?? {}), cantBeRegenerated: true };
				return true;
			}
		}
		return false;
	}

	// 11. *Solar Blaze*, *The Akroan War* III, *Rakdos Charm* mode 3 ("Each [tapped ]creature deals ...")
	const eachCrSelfDmgM = t.match(/^each (tapped )?creature deals damage to itself equal to its power$/i);
	if (eachCrSelfDmgM) {
		p.push(
			{
				verb: 'damage',
				subject: NONE,
				params: {
					eachCreatureDealsDamage: {
						filter: { types: ['Creature'], ...(eachCrSelfDmgM[1] ? { tapped: true } : {}) },
						to: 'self',
						amount: 'power'
					}
				},
				span
			},
			false
		);
		return true;
	}
	const eachCrCtrlDmgM = t.match(/^each creature deals (\S+) damage to its controller$/i);
	if (eachCrCtrlDmgM) {
		const amt = h.amountWord(p, eachCrCtrlDmgM[1].toLowerCase());
		if (amt) {
			p.push(
				{
					verb: 'damage',
					subject: NONE,
					params: {
						eachCreatureDealsDamage: {
							filter: { types: ['Creature'] },
							to: 'controller',
							amount: amt
						}
					},
					span
				},
				false
			);
			return true;
		}
	}

	// 12. *All Is Dust*, *Wave Goodbye*, *Brilliant Restoration*, *Maelstrom Pulse*, *Legions to Ashes*, *Echoing Return*, *Fell the Mighty*, *Scourge of Fleets*, *Crippling Fear*
	const allDustM = t.match(/^each (player|opponent) sacrifices all (.+?) they control(?: (.+))?$/i);
	if (allDustM) {
		const fullDesc = `${allDustM[2].trim()}${allDustM[3] ? ` ${allDustM[3].trim()}` : ''}`;
		const f = h.objectFilter(fullDesc);
		if (f) {
			const rel = allDustM[1].toLowerCase() === 'opponent' ? 'eachOpponent' : 'eachPlayer';
			p.push(
				{
					verb: 'forEachPlayerLoop',
					subject: NONE,
					params: {
						loopPlayers: rel,
						loopSteps: [
							{
								verb: 'sacrifice',
								subject: { k: 'all', filter: { zone: 'battlefield', ...f, controllerRef: { k: 'eachLoopPlayer' } } },
								actor: { k: 'eachLoopPlayer' },
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
	}
	if (/^creatures that aren't of the chosen type get ([+-]\d+)\/([+-]\d+) until end of turn$/i.test(t)) {
		const m = t.match(/^creatures that aren't of the chosen type get ([+-]\d+)\/([+-]\d+) until end of turn$/i)!;
		p.push(
			{
				verb: 'pump',
				subject: { k: 'all', filter: { zone: 'battlefield', types: ['Creature'], notOfChosenType: true } },
				amount: { k: 'const', n: parseInt(m[1], 10) },
				params: { toughness: { k: 'const', n: parseInt(m[2], 10) }, duration: 'endOfTurn' },
				span
			},
			false
		);
		return true;
	}
	if (/^return all artifact and enchantment cards from your graveyard to the battlefield$/i.test(t)) {
		p.push(
			{
				verb: 'move',
				subject: { k: 'all', filter: { zone: 'graveyard', owner: 'you', anyOf: [{ types: ['Artifact'] }, { types: ['Enchantment'] }] } },
				params: { from: 'graveyard', to: 'battlefield' },
				span
			},
			false
		);
		return true;
	}
	if (/^return each creature without a \+1\/\+1 counter on it to its owner's hand$/i.test(t)) {
		p.push(
			{
				verb: 'bounce',
				subject: { k: 'all', filter: { zone: 'battlefield', types: ['Creature'], notHasCounters: '+1/+1' } },
				span
			},
			false
		);
		return true;
	}
	if (/^destroy target nonland permanent and all other permanents with the same name as that permanent$/i.test(t)) {
		const idx = p.addTarget({ kind: 'object', filter: { zone: 'battlefield', notTypes: ['Land'] }, min: 1, max: 1 });
		p.push({ verb: 'destroy', subject: { k: 'target', index: idx }, span }, true);
		p.push(
			{
				verb: 'destroy',
				subject: { k: 'all', filter: { zone: 'battlefield', sameNameAsTarget: true, sameNameAsTargetIndex: idx } },
				span
			},
			false
		);
		return true;
	}
	if (/^exile target nonland permanent an opponent controls and all tokens that player controls with the same name as that permanent$/i.test(t)) {
		const idx = p.addTarget({ kind: 'object', filter: { zone: 'battlefield', notTypes: ['Land'], controller: 'opponent' }, min: 1, max: 1 });
		p.push({ verb: 'exile', subject: { k: 'target', index: idx }, span }, true);
		p.push(
			{
				verb: 'exile',
				subject: {
					k: 'all',
					filter: { zone: 'battlefield', token: true, sameNameAsTarget: true, sameNameAsTargetIndex: idx, controllerOfTargetIndex: idx }
				},
				span
			},
			false
		);
		return true;
	}
	if (/^return target creature card and all other cards with the same name as that card from your graveyard to your hand$/i.test(t)) {
		const idx = p.addTarget({ kind: 'object', filter: { zone: 'graveyard', types: ['Creature'], owner: 'you' }, min: 1, max: 1 });
		p.push({ verb: 'move', subject: { k: 'target', index: idx }, params: { from: 'graveyard', to: 'hand' }, span }, true);
		p.push(
			{
				verb: 'move',
				subject: { k: 'all', filter: { zone: 'graveyard', owner: 'you', sameNameAsTarget: true, sameNameAsTargetIndex: idx } },
				params: { from: 'graveyard', to: 'hand' },
				span
			},
			false
		);
		return true;
	}
	if (/^destroy all creatures with power greater than target creature's power$/i.test(t)) {
		const idx = p.addTarget({ kind: 'object', filter: { zone: 'battlefield', types: ['Creature'] }, min: 1, max: 1 });
		p.push(
			{
				verb: 'destroy',
				subject: {
					k: 'all',
					filter: {
						zone: 'battlefield',
						types: ['Creature'],
						power: { op: '>', value: { k: 'stat', of: { k: 'target', index: idx }, stat: 'power' } }
					}
				},
				span
			},
			false
		);
		return true;
	}

	// 13. *Acidic Soil*, *Deadly Tempest*, *Villainous Wrath*, *One Ring* III, *Parallectric Feedback*, *Refuse*, *Viashino Heretic*, *Noise Marine*, *Volcanic Torrent*, *Let the Galaxy Burn*
	const acidicM = t.match(/^~ deals damage to each (player|opponent) equal to (?:the number of )?(.+?) they control$/i);
	if (acidicM) {
		const f = h.objectFilter(acidicM[2].trim());
		if (f) {
			const rel = acidicM[1].toLowerCase() === 'opponent' ? 'eachOpponent' : 'eachPlayer';
			p.push(
				{
					verb: 'forEachPlayerLoop',
					subject: NONE,
					params: {
						loopPlayers: rel,
						loopSteps: [
							{
								verb: 'damage',
								subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } },
								amount: { k: 'count', of: { zone: 'battlefield', ...f, controllerRef: { k: 'eachLoopPlayer' } } },
								params: { damageSource: { k: 'self' } },
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
	}
	if (/^each player loses life equal to the number of creatures they controlled that were destroyed this way$/i.test(t)) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachPlayer',
					loopSteps: [
						{
							verb: 'loseLife',
							subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } },
							amount: { k: 'countedThisWay', kind: 'destroyedControlledByPlayerThisWay' },
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
	const oneRing3M = t.match(/^each opponent loses (\S+) life for each (.+?) card in that player's graveyard$/i);
	if (oneRing3M) {
		const amt = h.numberWord(oneRing3M[1]);
		const f = h.objectFilter(`${oneRing3M[2].trim()} card`);
		if (amt !== null && f) {
			const countAmt: Amount = { k: 'count', of: { ...f, zone: 'graveyard', ownerRef: { k: 'eachLoopPlayer' } } };
			const finalAmt: Amount = amt === 1 ? countAmt : { k: 'mul', factor: amt, of: countAmt };
			p.push(
				{
					verb: 'forEachPlayerLoop',
					subject: NONE,
					params: {
						loopPlayers: 'eachOpponent',
						loopSteps: [
							{
								verb: 'loseLife',
								subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } },
								amount: finalAmt,
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
	}
	const vilWrathM = t.match(/^target (opponent|player) loses life equal to (?:the number of )?(.+?) they control$/i);
	if (vilWrathM) {
		const f = h.objectFilter(vilWrathM[2].trim());
		if (f) {
			const idx = p.addTarget({
				kind: 'player',
				filter: {},
				player: { relation: vilWrathM[1].toLowerCase() === 'opponent' ? 'opponent' : 'any' },
				min: 1,
				max: 1
			});
			p.push(
				{
					verb: 'loseLife',
					subject: { k: 'playerRef', ref: { k: 'target', index: idx } },
					amount: { k: 'count', of: { zone: 'battlefield', ...f, controllerRef: { k: 'target', index: idx } } },
					span
				},
				false
			);
			return true;
		}
	}
	if (/^~ deals damage to target spell's controller equal to that spell's mana value$/i.test(t)) {
		const idx = p.addTarget({ kind: 'object', filter: { zone: 'stack', stackKind: 'spell' }, min: 1, max: 1 });
		p.push(
			{
				verb: 'damage',
				subject: { k: 'playerRef', ref: { k: 'controllerOf', of: { k: 'target', index: idx } } },
				amount: { k: 'stat', of: { k: 'target', index: idx }, stat: 'manaValue', lki: true },
				params: { damageSource: { k: 'self' } },
				span
			},
			false
		);
		return true;
	}
	const artCtrlDmgM = t.match(/^~ deals damage to that ([a-z]+)'s controller equal to the \1's mana value$/i);
	if (artCtrlDmgM && p.itRef()) {
		const it = p.itRef()!;
		p.push(
			{
				verb: 'damage',
				subject: { k: 'playerRef', ref: { k: 'controllerOf', of: it } },
				amount: { k: 'stat', of: it, stat: 'manaValue', lki: true },
				params: { damageSource: { k: 'self' } },
				span
			},
			false
		);
		return true;
	}

	// 14. *Swarmyard Massacre*
	const swarmM = t.match(
		/^(?:then\s+)?each creature that isn't ([^g]+?) gets ([+-]\d+)\/([+-]\d+) until end of turn for each (.+?)$/i
	);
	if (swarmM) {
		const subs = parseSubtypeListW10(swarmM[1].trim(), h.singularSubtype);
		const cntFilter = h.objectFilter(swarmM[4].replace(/^creature you control that's /i, 'creature you control that is ').trim()) ??
			h.objectFilter(`creature you control ${swarmM[4].replace(/^creature you control\s+/i, '')}`);
		if (subs && cntFilter) {
			const mult = parseInt(swarmM[2], 10);
			const cntAmt: Amount = { k: 'count', of: { zone: 'battlefield', ...cntFilter } };
			p.push(
				{
					verb: 'pump',
					subject: { k: 'all', filter: { zone: 'battlefield', types: ['Creature'], notSubtypes: subs } },
					amount: mult === 1 ? cntAmt : { k: 'mul', factor: mult, of: cntAmt },
					params: {
						toughness: mult === 1 ? cntAmt : { k: 'mul', factor: mult, of: cntAmt },
						duration: 'endOfTurn'
					},
					span
				},
				false
			);
			return true;
		}
	}

	// 15. Type-partition sacrifice (*Cataclysmic Gearhulk*, *Tragic Arrogance*, *Liliana* -9, *Archfiend*, *Planetary*, *Promise of Loyalty*)
	if (
		/^(?:each player|each opponent|that player) chooses an artifact, a creature, an enchantment, and a planeswalker from among the nonland permanents they control, then sacrifices the rest$/i.test(
			t
		)
	) {
		return addPartitionStep(p, span, {
			partitionTypes: ['Artifact', 'Creature', 'Enchantment', 'Planeswalker'],
			partitionChooser: 'eachPlayer',
			partitionNonlandOnly: true
		});
	}
	if (/^for each player, you choose from among the permanents that player controls an artifact, a creature, an enchantment, and a planeswalker$/i.test(t)) {
		return addPartitionStep(p, span, {
			partitionTypes: ['Artifact', 'Creature', 'Enchantment', 'Planeswalker'],
			partitionChooser: 'you',
			partitionNonlandOnly: true
		});
	}
	if (/^then each player sacrifices all other nonland permanents they control$/i.test(t)) {
		if (p.steps.some((s) => s.verb === 'partitionKeepByTypes')) return true;
	}
	if (/^each opponent chooses a permanent they control of each permanent type and sacrifices the rest$/i.test(t)) {
		return addPartitionStep(
			p,
			span,
			{
				partitionAllTypes: true,
				partitionChooser: 'eachPlayer'
			},
			{ k: 'eachLoopPlayer' }
		);
	}
	const archfiendM = t.match(/^(?:that player|each opponent) chooses up to (\S+) creatures? they control, then sacrifices the rest$/i);
	if (archfiendM) {
		const n = h.numberWord(archfiendM[1]);
		if (n !== null) {
			return addPartitionStep(
				p,
				span,
				{
					partitionTypes: ['Creature'],
					keepCountPerPlayer: { k: 'const', n },
					partitionChooser: 'eachPlayer'
				},
				{ k: 'eventPlayer' }
			);
		}
	}
	const planM = t.match(/^each player chooses (\S+) lands? they control, then sacrifices the rest$/i);
	if (planM) {
		const n = h.numberWord(planM[1]);
		if (n !== null) {
			return addPartitionStep(p, span, {
				partitionTypes: ['Land'],
				keepCountPerPlayer: { k: 'const', n },
				partitionChooser: 'eachPlayer'
			});
		}
	}
	if (/^each player puts a vow counter on a creature they control and sacrifices the rest$/i.test(t)) {
		return addPartitionStep(p, span, {
			partitionTypes: ['Creature'],
			keepCountPerPlayer: { k: 'const', n: 1 },
			partitionChooser: 'eachPlayer',
			partitionPutVowCounter: true
		});
	}
	if (/^each of those creatures can't attack you or planeswalkers you control for as long as it has a vow counter on it$/i.test(t)) {
		if (p.steps.some((s) => s.verb === 'partitionKeepByTypes' && s.params?.partitionPutVowCounter)) {
			return true;
		}
	}

	// 16. Greatest-stat sacrifice / bounce (*Soul Shatter*, *Crackling Doom*, *Flare of Malice*, *Papalymo*, *Summon: Valefor*)
	const oppSacGreatestM = t.match(
		/^(each opponent(?: who lost life this turn)?) sacrifices (a .+? with the greatest (?:power|toughness|mana value) among .+?(?:that player|they) controls?)$/i
	);
	if (oppSacGreatestM) {
		const filter = h.objectFilter(oppSacGreatestM[2].trim());
		if (filter) {
			const lostLifeOnly = /who lost life this turn/i.test(oppSacGreatestM[1]);
			const innerStep: EffectStep = {
				verb: 'sacrifice',
				subject: { k: 'all', filter: { zone: 'battlefield', ...filter, controllerRef: { k: 'eachLoopPlayer' } } },
				amount: { k: 'const', n: 1 },
				actor: { k: 'eachLoopPlayer' },
				...(lostLifeOnly ? { condition: { k: 'playerLostLifeThisTurn', player: { k: 'eachLoopPlayer' } } } : {}),
				span
			};
			p.push(
				{ verb: 'forEachPlayerLoop', subject: NONE, params: { loopPlayers: 'eachOpponent', loopSteps: [innerStep] }, span },
				false
			);
			return true;
		}
	}
	const valeforM = t.match(
		/^each opponent chooses (a .+? with the greatest (?:power|toughness|mana value) among .+?(?:that player|they) controls?)$/i
	);
	if (valeforM) {
		const filter = h.objectFilter(valeforM[1].trim());
		if (filter) {
			p.push(
				{
					verb: 'forEachPlayerLoop',
					subject: NONE,
					params: {
						loopPlayers: 'eachOpponent',
						loopSteps: [
							{
								verb: 'bounce',
								subject: { k: 'all', filter: { zone: 'battlefield', ...filter, controllerRef: { k: 'eachLoopPlayer' } } },
								amount: { k: 'const', n: 1 },
								actor: { k: 'eachLoopPlayer' },
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
	}
	if (/^return those creatures to their owners' hands$/i.test(t) && p.steps.some((s) => s.verb === 'forEachPlayerLoop')) {
		return true;
	}

	// 17. *Living Death*, *Twilight's Call*, *Balthor the Defiled*, *Patriarch's Bidding*
	if (
		/^each player exiles all creature cards from their graveyard, then sacrifices all creatures they control, then puts all cards they exiled this way onto the battlefield$/i.test(
			t
		)
	) {
		const bName = `ld_${p.steps.length}`;
		p.push({ verb: 'exile', subject: { k: 'all', filter: { zone: 'graveyard', types: ['Creature'] } }, bindAs: bName, span }, false);
		p.push({ verb: 'sacrifice', subject: { k: 'all', filter: { zone: 'battlefield', types: ['Creature'], controller: 'any' } }, span }, false);
		p.push({ verb: 'move', subject: { k: 'binding', name: bName }, params: { from: 'exile', to: 'battlefield' }, span }, false);
		return true;
	}
	const eachPlReturnGyM = t.match(/^each player returns all (.+?) cards from their graveyard to the battlefield$/i);
	if (eachPlReturnGyM) {
		const subPhrase = eachPlReturnGyM[1].trim();
		let filter: ObjectFilter | null = null;
		if (/^black and all red creature$/i.test(subPhrase)) {
			filter = { anyOf: [{ colors: ['B'], types: ['Creature'] }, { colors: ['R'], types: ['Creature'] }] };
		} else {
			filter = h.objectFilter(`${subPhrase} cards`);
		}
		if (filter) {
			p.push(
				{
					verb: 'forEachPlayerLoop',
					subject: NONE,
					params: {
						loopPlayers: 'eachPlayer',
						loopSteps: [
							{
								verb: 'move',
								subject: { k: 'all', filter: { zone: 'graveyard', ownerRef: { k: 'eachLoopPlayer' }, ...filter } },
								params: { from: 'graveyard', to: 'battlefield' },
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
	}
	if (/^each player chooses a creature type$/i.test(t)) {
		p.push({ verb: 'chooseDesignation', subject: YOU, params: { chooseKind: 'creatureType' }, span }, false);
		return true;
	}
	if (/^each player returns all creature cards of a type chosen this way from their graveyard to the battlefield$/i.test(t)) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachPlayer',
					loopSteps: [
						{
							verb: 'move',
							subject: { k: 'all', filter: { zone: 'graveyard', types: ['Creature'], ofChosenType: true, ownerRef: { k: 'eachLoopPlayer' } } },
							params: { from: 'graveyard', to: 'battlefield' },
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

	// 18. *Torment of Hailfire* repeat-process standalone sentence & Punishers
	const repStandaloneM = t.match(/^repeat the following process (\S+) times$/i);
	if (repStandaloneM) {
		const repAmt = h.amountWord(p, repStandaloneM[1].toLowerCase());
		if (repAmt) {
			p.push(
				{
					verb: 'punisherChoice',
					subject: NONE,
					params: {
						punisher: { players: 'eachOpponent', defaultSteps: [], unlessWho: { k: 'eachLoopPlayer' }, repeatCount: repAmt }
					},
					span
				},
				false
			);
			return true;
		}
	}

	// *Perplex*: "Counter target spell unless its controller discards their hand."
	if (/^counter target spell unless its controller discards their hand$/i.test(t)) {
		const idx = p.addTarget({ kind: 'object', filter: { zone: 'stack', stackKind: 'spell' }, min: 1, max: 1 });
		p.push(
			{
				verb: 'punisherChoice',
				subject: NONE,
				params: {
					punisher: {
						players: 'subjectPlayer',
						defaultSteps: [{ verb: 'counterSpell', subject: { k: 'target', index: idx }, span }],
						unlessCost: [{ k: 'discardHand' }],
						unlessWho: { k: 'controllerOf', of: { k: 'target', index: idx } }
					}
				},
				span
			},
			false
		);
		return true;
	}

	// *Enchanter's Bane*: "target enchantment deals damage equal to its mana value to its controller unless that player sacrifices it"
	if (/^target enchantment deals damage equal to its mana value to its controller unless that player sacrifices it$/i.test(t)) {
		const idx = p.addTarget({ kind: 'object', filter: { zone: 'battlefield', types: ['Enchantment'] }, min: 1, max: 1 });
		const tRef: Ref = { k: 'target', index: idx };
		p.push(
			{
				verb: 'punisherChoice',
				subject: NONE,
				params: {
					punisher: {
						players: 'subjectPlayer',
						defaultSteps: [
							{
								verb: 'damage',
								subject: { k: 'playerRef', ref: { k: 'controllerOf', of: tRef } },
								amount: { k: 'stat', of: tRef, stat: 'manaValue', lki: true },
								params: { damageSource: { k: 'target', index: idx } },
								span
							}
						],
						unlessEffect: [{ verb: 'sacrifice', subject: { k: 'target', index: idx }, actor: { k: 'controllerOf', of: tRef }, span }],
						unlessWho: { k: 'controllerOf', of: tRef }
					}
				},
				span
			},
			false
		);
		return true;
	}

	// General "<effect> unless <player> <cost1> or <cost2>" (*Torment*, *Mogis*, *Tergrid*, *Nicol Bolas*, *Bandit's Talent*)
	const unlessM = t.match(/^(.+?)\s+unless\s+(that player|they|its controller)\s+(.+)$/i);
	if (unlessM) {
		const effectPart = unlessM[1].trim();
		const costPart = unlessM[3].trim();
		const trySingleCost = (raw: string): CostDef[] | null => {
			const norm = normalizeCostVerbPhraseW10(raw);
			return h.parseCost(norm);
		};
		const costs =
			trySingleCost(costPart) ??
			(/\s+or\s+/i.test(costPart)
				? (() => {
						const parts = costPart.split(/\s+or\s+/i);
						const opts: CostDef[][] = [];
						for (const pt of parts) {
							const parsed = trySingleCost(pt);
							if (!parsed) return null;
							opts.push(parsed);
						}
						return [{ k: 'choice', options: opts } as CostDef];
					})()
				: null);
		const isSimpleSingleManaTax =
			costs !== null &&
			costs.length === 1 &&
			costs[0]!.k === 'mana' &&
			!/\s+or\s+/i.test(costPart) &&
			!/\blife\b/i.test(costPart) &&
			!/^each (?:opponent|player)/i.test(effectPart);
		if (costs && !isSimpleSingleManaTax) {
			const defSub = h.parseSubEffects(effectPart, span.start, p.context);
			if (defSub.unparsed.length === 0 && defSub.steps.length > 0) {
				const firstSubj = defSub.steps[0]!.subject;
				const isEachOpp =
					(firstSubj.k === 'player' && firstSubj.filter.relation === 'each_opponent') ||
					/^each opponent/i.test(effectPart);
				const isEachPl = firstSubj.k === 'player' && firstSubj.filter.relation === 'each_player';
				const actuallySimpleSingleMana =
					!isEachOpp &&
					!isEachPl &&
					costs.length === 1 &&
					costs[0]!.k === 'mana' &&
					!/\s+or\s+/i.test(costPart) &&
					!/\blife\b/i.test(costPart);
				if (!actuallySimpleSingleMana) {
				const who: PlayerRef =
					isEachOpp || isEachPl
						? { k: 'eachLoopPlayer' }
						: firstSubj.k === 'playerRef'
							? firstSubj.ref
							: /^its controller/i.test(unlessM[2])
								? { k: 'controllerOf', of: p.itRef() ?? { k: 'target', index: 0 } }
								: { k: 'eventPlayer' };
				const fixedDef =
					isEachOpp || isEachPl
						? defSub.steps.map((s) => ({
								...s,
								subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } } as Selector
							}))
						: defSub.steps;
				for (const ts of defSub.targets) p.addTarget(ts);
				pushWithPendingRepeat(
					p,
					{
						verb: 'punisherChoice',
						subject: NONE,
						params: {
							punisher: {
								players: isEachOpp ? 'eachOpponent' : isEachPl ? 'eachPlayer' : 'subjectPlayer',
								defaultSteps: fixedDef,
								unlessCost: costs,
								unlessWho: who
							}
						},
						span
					},
					false
				);
				return true;
				}
			}
		}
	}

	// 19. *Braids, Arisen Nightmare*, *Fandaniel*, *Plaguecrafter*, *Refurbished Familiar*, *Star Athlete*, *Combustible Gearhulk*
	const braiMayM = t.match(/^each opponent may (.+)$/i);
	if (braiMayM && /sacrifice|discard/i.test(braiMayM[1])) {
		const rawCost = braiMayM[1].trim();
		let optCost = h.parseCost(normalizeCostVerbPhraseW10(rawCost));
		if (!optCost && /permanent(?: of their choice)? that shares a card type with it/i.test(rawCost)) {
			const sacIdx = p.steps.findIndex((st) => st.verb === 'sacrifice');
			const bName = sacIdx >= 0 ? (p.steps[sacIdx]!.bindAs ??= `b_sac_${sacIdx}`) : 'b_sac_0';
			optCost = [
				{
					k: 'sacrifice',
					count: { k: 'const', n: 1 },
					filter: { sharesCardTypeWithBinding: bName }
				}
			];
		}
		if (optCost) {
			p.push(
				{
					verb: 'punisherChoice',
					subject: NONE,
					params: {
						punisher: {
							players: 'eachOpponent',
							mayFirst: true,
							unlessCost: optCost,
							unlessWho: { k: 'eachLoopPlayer' },
							defaultSteps: []
						}
					},
					span
				},
				false
			);
			return true;
		}
	}
	const plagueSacM = t.match(/^each (player|opponent) (sacrifices|discards) (.+?)(?: of their choice)?$/i);
	if (plagueSacM && /\bor\b/i.test(plagueSacM[3])) {
		const costStr = `${plagueSacM[2].replace(/s$/i, '')} ${plagueSacM[3].trim()}`;
		const cDefs = h.parseCost(normalizeCostVerbPhraseW10(costStr));
		if (cDefs) {
			p.push(
				{
					verb: 'punisherChoice',
					subject: NONE,
					params: {
						punisher: {
							players: plagueSacM[1].toLowerCase() === 'opponent' ? 'eachOpponent' : 'eachPlayer',
							mandatoryIfAble: true,
							unlessCost: cDefs,
							unlessWho: { k: 'eachLoopPlayer' },
							defaultSteps: []
						}
					},
					span
				},
				false
			);
			return true;
		}
	}
	const prevPun = p.steps[p.steps.length - 1];
	const forEachWhoDoesntM = t.match(/^(?:for )?each (opponent|player) who (?:doesn't|can't|couldn't)(?:,\s*|\s+)(.+)$/i);
	if (forEachWhoDoesntM && prevPun) {
		let followRaw = forEachWhoDoesntM[2].trim();
		if (/^(?:discards|sacrifices|loses|draws|mills|gains|exiles|puts|creates|taps)\b/i.test(followRaw)) {
			followRaw = `that player ${followRaw}`;
		}
		const followSub = h.parseSubEffects(followRaw, span.start, p.context);
		if (followSub.unparsed.length === 0 && followSub.steps.length > 0) {
			const retargeted = followSub.steps.map((st) =>
				st.subject.k === 'playerRef' && st.subject.ref.k === 'eventPlayer'
					? { ...st, subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } } as Selector }
					: st
			);
			if (prevPun.verb === 'punisherChoice' && prevPun.params?.punisher) {
				prevPun.params.punisher.defaultSteps.push(...retargeted);
				return true;
			}
			if (
				(prevPun.verb === 'discard' || prevPun.verb === 'sacrifice') &&
				prevPun.subject.k === 'player' &&
				(prevPun.subject.filter.relation === 'each_opponent' || prevPun.subject.filter.relation === 'each_player')
			) {
				const plScope =
					prevPun.subject.filter.relation === 'each_opponent' ? 'eachOpponent' : 'eachPlayer';
				const cnt = prevPun.amount ?? { k: 'const', n: 1 };
				const upgradeCost: CostDef[] =
					prevPun.verb === 'discard'
						? [{ k: 'discard', count: cnt }]
						: [{ k: 'sacrifice', count: cnt, filter: { types: ['Creature'] } }];
				prevPun.verb = 'punisherChoice';
				prevPun.subject = NONE;
				prevPun.params = {
					punisher: {
						players: plScope,
						mandatoryIfAble: true,
						unlessCost: upgradeCost,
						unlessWho: { k: 'eachLoopPlayer' },
						defaultSteps: retargeted
					}
				};
				return true;
			}
		}
	}
	if (/^its controller may sacrifice it$/i.test(t) && p.itRef()) {
		const it = p.itRef()!;
		p.lastPlayer = { k: 'playerRef', ref: { k: 'controllerOf', of: it } };
		p.push(
			{
				verb: 'punisherChoice',
				subject: NONE,
				params: {
					punisher: {
						players: 'subjectPlayer',
						unlessEffect: [{ verb: 'sacrifice', subject: refToSelectorW10(it), actor: { k: 'controllerOf', of: it }, span }],
						unlessWho: { k: 'controllerOf', of: it },
						defaultSteps: []
					}
				},
				span
			},
			false
		);
		return true;
	}
	const combM = t.match(/^target opponent may have you (.+)$/i);
	if (combM) {
		const oppIdx = p.addTarget({ kind: 'player', filter: {}, player: { relation: 'opponent' }, min: 1, max: 1 });
		const acceptSub = h.parseSubEffects(`you ${combM[1].trim()}`, span.start, p.context);
		if (acceptSub.unparsed.length === 0 && acceptSub.steps.length > 0) {
			p.lastPlayer = { k: 'playerRef', ref: { k: 'target', index: oppIdx } };
			p.push(
				{
					verb: 'punisherChoice',
					subject: NONE,
					params: {
						punisher: {
							players: 'subjectPlayer',
							unlessEffect: acceptSub.steps,
							defaultSteps: [],
							unlessWho: { k: 'target', index: oppIdx }
						}
					},
					span
				},
				false
			);
			return true;
		}
	}
	const combDeclineM = t.match(/^if (?:the player|that player|they) (?:doesn't|don't|declines),\s*(.+)$/i);
	if (combDeclineM && prevPun?.verb === 'punisherChoice' && prevPun.params?.punisher) {
		const rawDec = combDeclineM[1].trim();
		let decSub = h.parseSubEffects(rawDec, span.start, 'triggered');
		if ((decSub.unparsed.length > 0 || decSub.steps.length === 0) && /,\s*then\s+/i.test(rawDec)) {
			decSub = h.parseSubEffects(rawDec.replace(/,\s*then\s+/gi, '. '), span.start, 'triggered');
		}
		if (decSub.unparsed.length === 0 && decSub.steps.length > 0) {
			const repSteps = decSub.steps.map((st) =>
				st.subject.k === 'playerRef' && st.subject.ref.k === 'eventPlayer'
					? { ...st, subject: { k: 'playerRef', ref: prevPun.params!.punisher!.unlessWho } as Selector }
					: st
			);
			prevPun.params.punisher.defaultSteps.push(...repSteps);
			return true;
		}
	}

	// 20. *Coin of Fate*, *Deliver Unto Evil*, *Tasigur*
	if (/^an opponent chooses one of the exiled cards$/i.test(t)) return true;
	if (/^you put that card on the bottom of your library and return the other to the battlefield tapped$/i.test(t)) {
		p.push({ verb: 'move', subject: NONE, params: { splitExiledCostCardsToBottomAndBattlefield: true }, span }, false);
		return true;
	}
	if (/^(?:otherwise,\s*)?an opponent chooses two of them$/i.test(t)) return true;
	if (/^leave the chosen cards in your graveyard and put the rest into your hand$/i.test(t)) {
		p.push(
			{
				verb: 'move',
				subject: NONE,
				params: {
					leaveChosenInGraveyardRestToHand: true,
					condition: {
						k: 'not',
						of: { k: 'playerControlsFilter', player: { k: 'you' }, filter: { types: ['Planeswalker'], subtypes: ['Bolas'] } }
					}
				},
				span
			},
			false
		);
		return true;
	}
	const tasigurM = t.match(/^return (?:a|an) (.+?) card of an opponent's choice from your graveyard to your hand$/i);
	if (tasigurM) {
		const f = h.objectFilter(`${tasigurM[1].trim()} card`);
		if (f) {
			p.push(
				{
					verb: 'move',
					subject: { k: 'all', filter: { ...f, zone: 'graveyard', owner: 'you' } },
					amount: { k: 'const', n: 1 },
					params: { from: 'graveyard', to: 'hand', chooserOverride: 'opponent' },
					span
				},
				false
			);
			return true;
		}
	}

	// 21. *Cut a Deal*, *Syphon Mind*, *Kwain*, *Selvala*, *Author of Shadows*, *Phyrexian Scriptures*, *Endurance*, *Consuming Aberration*, *Skull Rend*
	if (/^exile all opponents' graveyards$/i.test(t) || /^exile each opponent's graveyard$/i.test(t)) {
		p.push({ verb: 'exile', subject: { k: 'all', filter: { zone: 'graveyard', owner: 'opponent' } }, span }, false);
		return true;
	}
	if (/^up to one target player puts all the cards from their graveyard on the bottom of their library in a random order$/i.test(t)) {
		const idx = p.addTarget({ kind: 'player', filter: {}, player: { relation: 'any' }, min: 0, max: 1 });
		p.push(
			{
				verb: 'move',
				subject: { k: 'all', filter: { zone: 'graveyard', ownerRef: { k: 'target', index: idx } } },
				params: { from: 'graveyard', to: 'library', position: 'bottom', randomOrder: true },
				span
			},
			false
		);
		return true;
	}
	if (/^those players each discard (\S+) cards at random$/i.test(t)) {
		const m = t.match(/^those players each discard (\S+) cards at random$/i)!;
		const amt = h.amountWord(p, m[1].toLowerCase());
		if (amt) {
			p.push(
				{
					verb: 'forEachPlayerLoop',
					subject: NONE,
					params: {
						loopPlayers: 'eachOpponent',
						loopSteps: [{ verb: 'discard', subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } }, amount: amt, params: { atRandom: true }, span }]
					},
					span
				},
				false
			);
			return true;
		}
	}
	if (/^each other player discards a card$/i.test(t)) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachOtherPlayer',
					loopSteps: [{ verb: 'discard', subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } }, amount: { k: 'const', n: 1 }, span }]
				},
				span
			},
			false
		);
		return true;
	}
	if (/^each player may draw a card, then each player who drew a card this way gains 1 life$/i.test(t)) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachPlayer',
					loopSteps: [
						{ verb: 'draw', subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } }, amount: { k: 'const', n: 1 }, actor: { k: 'eachLoopPlayer' }, optional: { chooser: { k: 'eachLoopPlayer' } }, span },
						{ verb: 'gainLife', subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } }, amount: { k: 'const', n: 1 }, ifPrecedingAccepted: 0, span }
					]
				},
				span
			},
			false
		);
		return true;
	}
	const revealTopUntilLandMillM = t.match(
		/^each (opponent|player) reveals cards from the top of their library until they reveal a land card, then puts those cards into their graveyard$/i
	);
	if (revealTopUntilLandMillM) {
		const rel = revealTopUntilLandMillM[1].toLowerCase() === 'opponent' ? 'eachOpponent' : 'eachPlayer';
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: rel,
					loopSteps: [
						{
							verb: 'dig',
							subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } },
							params: {
								dig: {
									untilFilter: { types: ['Land'] },
									revealAll: true,
									keep: 0,
									upTo: false,
									keepTo: 'graveyard',
									rest: 'graveyard'
								}
							},
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

	// 22. General `"for each <opponent|player>, <clauses>"` / `"starting with ..., each <player|opponent> <clauses>"`
	const forEachPlM = t.match(
		/^(?:(for each opponent|for each player|for each other player),\s*|(starting with you,\s*each player|starting with the next opponent in turn order,\s*each (?:player|opponent))\s+)(.+)$/i
	);
	if (forEachPlM) {
		const lead = (forEachPlM[1] ?? forEachPlM[2] ?? '').toLowerCase().trim();
		const body = forEachPlM[3].trim();
		const loopPlayers: NonNullable<EffectStep['params']>['loopPlayers'] = lead.includes('starting with the next opponent')
			? 'turnOrderStartingWithNextOpponent'
			: lead.includes('starting with you')
				? 'turnOrderStartingWithYou'
				: lead.includes('each other player')
					? 'eachOtherPlayer'
					: lead.includes('each opponent')
						? 'eachOpponent'
						: 'eachPlayer';
		const rewrittenBody = lead.startsWith('starting with') ? `that player ${body}` : body.replace(/\bthat opponent\b/gi, 'that player');
		const sub = h.parseSubEffects(rewrittenBody, span.start, p.context);
		if (sub.unparsed.length === 0 && sub.steps.length > 0) {
			const rewriteRef = (ref: PlayerRef): PlayerRef => (ref.k === 'eventPlayer' ? { k: 'eachLoopPlayer' } : ref);
			const rewriteSel = (sel: Selector): Selector => {
				if (sel.k === 'playerRef') return { k: 'playerRef', ref: rewriteRef(sel.ref) };
				if (sel.k === 'all') {
					return {
						k: 'all',
						filter: {
							...sel.filter,
							...(sel.filter.controllerRef ? { controllerRef: rewriteRef(sel.filter.controllerRef) } : {}),
							...(sel.filter.ownerRef ? { ownerRef: rewriteRef(sel.filter.ownerRef) } : {})
						}
					};
				}
				return sel;
			};
			const loopSteps = sub.steps.map((st) => ({
				...st,
				subject: rewriteSel(st.subject),
				...(st.actor ? { actor: rewriteRef(st.actor) } : {})
			}));
			for (const ts of sub.targets) p.addTarget(ts);
			p.push({ verb: 'forEachPlayerLoop', subject: NONE, params: { loopPlayers, loopSteps }, span }, false);
			return true;
		}
	}

	// 23. *Dire Fleet Ravager*, *Nicol Bolas, Dragon-God* -8, *Shatter the Sky*, *Snort*/*Ruin Grinder*, *Blasphemous Edict*
	if (/^each player loses a third of their life, rounded up$/i.test(t)) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachPlayer',
					loopSteps: [
						{
							verb: 'loseLife',
							subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } },
							amount: { k: 'fractionalLifeLoss', player: { k: 'eachLoopPlayer' }, denominator: 3, round: 'up' },
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
	if (/^each opponent who doesn't control a legendary creature or planeswalker loses the game$/i.test(t)) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachOpponent',
					loopSteps: [
						{
							verb: 'lose',
							subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } },
							params: {
								condition: {
									k: 'not',
									of: {
										k: 'playerControlsFilter',
										player: { k: 'eachLoopPlayer' },
										filter: { anyOf: [{ supertypes: ['Legendary'], types: ['Creature'] }, { types: ['Planeswalker'] }] }
									}
								}
							},
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
	const shatterM = t.match(/^each player who controls a (.+?) draws a card$/i);
	if (shatterM) {
		const f = h.objectFilter(shatterM[1].trim());
		if (f) {
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
								amount: { k: 'const', n: 1 },
								condition: { k: 'playerControlsFilter', player: { k: 'eachLoopPlayer' }, filter: f },
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
	}
	const wheelM = t.match(/^each player may discard their hand and draw (\S+) cards?$/i);
	if (wheelM) {
		const drawAmt = h.amountWord(p, wheelM[1].toLowerCase());
		if (drawAmt) {
			p.push(
				{
					verb: 'forEachPlayerLoop',
					subject: NONE,
					params: {
						loopPlayers: 'eachPlayer',
						loopSteps: [
							{
								verb: 'discardHand',
								subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } },
								actor: { k: 'eachLoopPlayer' },
								optional: { chooser: { k: 'eachLoopPlayer' } },
								params: { drawAfterDiscardHand: drawAmt },
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
	}
	const snortDamageM = t.match(/^(?:then\s+)?~ deals (\S+) damage to each opponent who discarded their hand this way$/i);
	if (snortDamageM) {
		const dmgAmt = h.amountWord(p, snortDamageM[1].toLowerCase());
		if (dmgAmt) {
			p.push(
				{
					verb: 'forEachPlayerLoop',
					subject: NONE,
					params: {
						loopPlayers: 'eachOpponent',
						loopSteps: [
							{
								verb: 'damage',
								subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } },
								amount: dmgAmt,
								condition: { k: 'playerDiscardedHandThisWay' },
								params: { damageSource: { k: 'self' } },
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
	}
	// 24. *The Lord of Pain*, *Perch Protection*, *Surge of Salvation*, *Riot Control*, *Scourge of Fleets*, *Let the Galaxy Burn*
	if (/^~ deals damage equal to that spell's mana value to the chosen player$/i.test(t) && p.lastPlayer) {
		p.push(
			{
				verb: 'damage',
				subject: p.lastPlayer,
				amount: { k: 'stat', of: { k: 'eventObject' }, stat: 'manaValue', lki: true },
				params: { damageSource: { k: 'self' } },
				span
			},
			false
		);
		return true;
	}
	if (
		/^all permanents you control phase out,\s*and until your next turn,\s*your life total can't change and you gain protection from everything$/i.test(
			t
		)
	) {
		p.push({ verb: 'phaseOut', subject: { k: 'all', filter: { zone: 'battlefield', controller: 'you' } }, span }, false);
		p.push(
			{
				verb: 'grantPlayer',
				subject: YOU,
				params: { playerRules: ['lifeTotalCantChange', 'protectionFromEverything'], duration: 'untilYourNextTurn' },
				span
			},
			false
		);
		return true;
	}
	if (/^you and permanents you control gain hexproof until end of turn$/i.test(t)) {
		p.push(
			{ verb: 'grantPlayer', subject: YOU, params: { playerRules: ['hexproof'], duration: 'endOfTurn' }, span },
			false
		);
		p.push(
			{
				verb: 'grant',
				subject: { k: 'all', filter: { zone: 'battlefield', controller: 'you' } },
				params: { keywords: ['Hexproof'], duration: 'endOfTurn' },
				span
			},
			false
		);
		return true;
	}
	const gainForEachM = t.match(/^(?:you )?gain (\S+) life for each (.+)$/i);
	if (gainForEachM) {
		const baseN = h.numberWord(gainForEachM[1]);
		const f = h.objectFilter(gainForEachM[2].trim());
		if (baseN !== null && f) {
			const cntAmt: Amount = { k: 'count', of: { zone: 'battlefield', ...f } };
			p.push(
				{
					verb: 'gainLife',
					subject: YOU,
					amount: baseN === 1 ? cntAmt : { k: 'mul', factor: baseN, of: cntAmt },
					span
				},
				false
			);
			return true;
		}
	}
	const bounceEachM = t.match(/^return each (.+?) to (?:its|their) owner's? hand$/i);
	if (bounceEachM) {
		const f = h.objectFilter(bounceEachM[1].trim());
		if (f) {
			p.push({ verb: 'bounce', subject: { k: 'all', filter: { zone: 'battlefield', ...f } }, span }, false);
			return true;
		}
	}
	const dealsAmtToEachM = t.match(/^~ deals (.+?) damage to each (.+)$/i);
	if (dealsAmtToEachM && !/opponent|player/i.test(dealsAmtToEachM[2])) {
		const amt = parseAmountWave10(p, dealsAmtToEachM[1].trim(), h) ?? h.amountWord(p, dealsAmtToEachM[1].trim().toLowerCase());
		const f = h.objectFilter(dealsAmtToEachM[2].trim());
		if (amt && f) {
			p.push(
				{
					verb: 'damage',
					subject: { k: 'all', filter: { zone: 'battlefield', ...f } },
					amount: amt,
					params: { damageSource: { k: 'self' } },
					span
				},
				false
			);
			return true;
		}
	}

	// 25. *God-Eternal Bontu*, *Angelic Aberration*, *Eldrazi Monument*, *Noxious Gearhulk*, *Cut a Deal*, *Syphon Mind*, *Bandit's Talent*
	const anySacM = t.match(/^(?:then\s+)?sacrifice any number of (.+)$/i);
	if (anySacM) {
		const f = h.objectFilter(anySacM[1].trim());
		if (f) {
			p.push(
				{
					verb: 'sacrifice',
					subject: { k: 'all', filter: { zone: 'battlefield', controller: 'you', ...f } },
					amount: { k: 'anyNumber' },
					span
				},
				true
			);
			return true;
		}
	}
	if (/^(?:then\s+)?draw that many cards$/i.test(t) && p.steps[p.steps.length - 1]?.verb === 'sacrifice') {
		p.push({ verb: 'draw', subject: YOU, amount: { k: 'countedThisWay', kind: 'sacrificedThisWay' }, span }, false);
		return true;
	}
	const createThatManyM = t.match(/^(?:then\s+)?(?:you )?create that many (.+?) tokens?(.*)$/i);
	if (createThatManyM && p.steps[p.steps.length - 1]?.verb === 'sacrifice') {
		const oneSub = h.parseSubEffects(`create a ${createThatManyM[1].trim()} token${createThatManyM[2]}`, span.start, p.context);
		if (oneSub.unparsed.length === 0 && oneSub.steps.length === 1 && oneSub.steps[0]!.verb === 'createToken') {
			const tokStep = { ...oneSub.steps[0]!, amount: { k: 'countedThisWay', kind: 'sacrificedThisWay' } as Amount, span };
			p.push(tokStep, true);
			return true;
		}
	}
	if (/^if you can't,\s*sacrifice ~$/i.test(t)) {
		const sacIdx = p.steps.length - 1;
		if (sacIdx >= 0 && p.steps[sacIdx]!.verb === 'sacrifice') {
			p.push({ verb: 'sacrifice', subject: { k: 'self' }, ifPrecedingDeclined: sacIdx, span }, false);
			return true;
		}
	}
	if (/^if a creature is destroyed this way,\s*you gain life equal to its toughness$/i.test(t)) {
		let dIdx = -1;
		for (let i = p.steps.length - 1; i >= 0; i--) {
			if (p.steps[i]!.verb === 'destroy') {
				dIdx = i;
				break;
			}
		}
		if (dIdx >= 0) {
			const bName = p.steps[dIdx]!.bindAs ?? `b_dest_${dIdx}`;
			p.steps[dIdx]!.bindAs = bName;
			p.push(
				{
					verb: 'gainLife',
					subject: YOU,
					amount: { k: 'stat', of: { k: 'binding', name: bName }, stat: 'toughness', lki: true },
					ifPrecedingAccepted: dIdx,
					span
				},
				false
			);
			return true;
		}
	}
	if (/^each opponent draws a card,\s*then you draw a card for each opponent who drew a card this way$/i.test(t)) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachOpponent',
					loopSteps: [{ verb: 'draw', subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } }, amount: { k: 'const', n: 1 }, span }]
				},
				span
			},
			false
		);
		p.push({ verb: 'draw', subject: YOU, amount: { k: 'countedThisWay', kind: 'opponentsDrewThisWay' }, span }, false);
		return true;
	}
	if (/^(?:you )?draw a card for each card discarded this way$/i.test(t)) {
		p.push({ verb: 'draw', subject: YOU, amount: { k: 'countedThisWay', kind: 'discardedThisWay' }, span }, false);
		return true;
	}
	const addDrawForEachM = t.match(/^draw an additional card for each (.+)$/i);
	if (addDrawForEachM) {
		const amt = parseAmountWave10(p, addDrawForEachM[1].trim(), h);
		if (amt) {
			p.push({ verb: 'draw', subject: YOU, amount: amt, span }, false);
			return true;
		}
	}

	// 26. *Bane of Bala Ged*, *Observed Stasis*, *Lightmine Field*, *Myr Battlesphere*, *Soul of Shandalar*, *Vincent*, *Gollum*, *Tombstone Stairwell*, *Adeline*, *Tergrid*, *Grenzo*
	const defExM = t.match(/^defending player exiles (\S+) (.+?) they control$/i);
	if (defExM) {
		const amt = h.amountWord(p, defExM[1].toLowerCase());
		const f = h.objectFilter(defExM[2].trim());
		if (amt && f) {
			p.push(
				{
					verb: 'exile',
					subject: { k: 'all', filter: { zone: 'battlefield', ...f, controllerRef: { k: 'defendingPlayer' } } },
					amount: amt,
					actor: { k: 'defendingPlayer' },
					span
				},
				true
			);
			return true;
		}
	}
	if (/^remove enchanted creature from combat$/i.test(t)) {
		p.push({ verb: 'removeFromCombat', subject: { k: 'attachedTo' }, span }, false);
		return true;
	}
	if (/^(?:then\s+)?draw a card for each tapped creature its controller controls$/i.test(t)) {
		p.push(
			{
				verb: 'draw',
				subject: YOU,
				amount: {
					k: 'count',
					of: { zone: 'battlefield', types: ['Creature'], tapped: true, controllerRef: { k: 'controllerOf', of: { k: 'attachedTo' } } }
				},
				span
			},
			false
		);
		return true;
	}
	if (/^~ deals damage to each of those creatures equal to the number of attacking creatures$/i.test(t)) {
		p.push(
			{
				verb: 'damage',
				subject: { k: 'all', filter: { zone: 'battlefield', types: ['Creature'], attacking: true } },
				amount: { k: 'count', of: { zone: 'battlefield', types: ['Creature'], attacking: true } },
				params: { damageSource: { k: 'self' } },
				span
			},
			false
		);
		return true;
	}
	if (/^~ gets \+X\/\+0 until end of turn and deals X damage to the player or planeswalker it's attacking$/i.test(t)) {
		const xAmt: Amount = { k: 'countedThisWay', kind: 'tappedThisWay' };
		p.push(
			{
				verb: 'pump',
				subject: { k: 'self' },
				amount: xAmt,
				params: { toughness: { k: 'const', n: 0 }, duration: 'endOfTurn' },
				span
			},
			false
		);
		p.push(
			{
				verb: 'damage',
				subject: NONE,
				amount: xAmt,
				params: { damageAttackedTargetBySelf: true, damageSource: { k: 'self' } },
				span
			},
			false
		);
		return true;
	}
	const shandalarM = t.match(
		/^(?:~|it) deals (\d+) damage to target player or planeswalker and (\d+) damage to up to one target creature that player or that planeswalker's controller controls$/i
	);
	if (shandalarM) {
		const idx0 = p.addTarget({ kind: 'objectOrPlayer', filter: { zone: 'battlefield', types: ['Planeswalker'] }, player: { relation: 'any' }, min: 1, max: 1 });
		const idx1 = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'], controllerOfTargetIndex: idx0 },
			min: 0,
			max: 1
		});
		p.push({ verb: 'damage', subject: { k: 'target', index: idx0 }, amount: { k: 'const', n: parseInt(shandalarM[1], 10) }, params: { damageSource: { k: 'self' } }, span }, true);
		p.push({ verb: 'damage', subject: { k: 'target', index: idx1 }, amount: { k: 'const', n: parseInt(shandalarM[2], 10) }, params: { damageSource: { k: 'self' } }, span }, false);
		return true;
	}
	const vincentM = t.match(/^it deals that much damage to each other opponent if ~'s power is (\d+) or greater$/i);
	if (vincentM) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				condition: { k: 'compare', left: { k: 'stat', of: { k: 'self' }, stat: 'power' }, op: '>=', right: { k: 'const', n: parseInt(vincentM[1], 10) } },
				params: {
					loopPlayers: 'eachOpponent',
					excludeEventPlayer: true,
					loopSteps: [
						{
							verb: 'damage',
							subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } },
							amount: { k: 'eventAmount' },
							params: { damageSource: { k: 'self' } },
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
	if (/^each opponent dealt combat damage this game by a creature named ~ loses life equal to the amount of life you gained this turn$/i.test(t)) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachOpponent',
					loopSteps: [
						{
							verb: 'loseLife',
							subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } },
							amount: { k: 'p17bMetric', metric: 'lifeGainedThisTurn' },
							condition: { k: 'wasDealtCombatDamageBySelfNameThisGame', player: { k: 'eachLoopPlayer' } },
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
	if (/^each player creates a 2\/2 black Zombie creature token with haste named Tombspawn for each creature card in their graveyard$/i.test(t)) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachPlayer',
					loopSteps: [
						{
							verb: 'createToken',
							subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } },
							actor: { k: 'eachLoopPlayer' },
							amount: { k: 'count', of: { zone: 'graveyard', types: ['Creature'], ownerRef: { k: 'eachLoopPlayer' } } },
							params: {
								token: {
									name: 'Tombspawn',
									power: 2,
									toughness: 2,
									colors: ['B'],
									typeLine: 'Creature — Zombie',
									keywords: ['Haste']
								}
							},
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
	const adelineM = t.match(
		/^for each opponent,\s*create (?:a|an) (\d+)\/(\d+) ([a-z]+) ([A-Za-z]+) creature token that's tapped and attacking that player or a planeswalker they control$/i
	);
	if (adelineM) {
		const cols = parseColorListW10(adelineM[3]) ?? [];
		const sub = h.singularSubtype(adelineM[4]) ?? adelineM[4];
		p.push(
			{
				verb: 'createToken',
				subject: YOU,
				amount: { k: 'const', n: 1 },
				params: {
					token: {
						name: sub,
						power: parseInt(adelineM[1], 10),
						toughness: parseInt(adelineM[2], 10),
						colors: cols,
						typeLine: `Creature — ${sub}`,
						keywords: []
					},
					tappedAndAttacking: true,
					perOpponentTappedAttacking: 'all'
				},
				span
			},
			true
		);
		return true;
	}
	if (/^you may put that card from a graveyard onto the battlefield under your control$/i.test(t)) {
		p.push(
			{
				verb: 'move',
				subject: { k: 'eventObject' },
				params: { from: 'graveyard', to: 'battlefield', underYourControl: true },
				optional: { chooser: { k: 'you' } },
				span
			},
			true
		);
		return true;
	}
	if (/^exile the top card of that player's library$/i.test(t)) {
		const bName = `b_ex_${p.steps.length}`;
		p.push(
			{
				verb: 'exile',
				subject: { k: 'libraryTop', player: { k: 'eventPlayer' } },
				amount: { k: 'const', n: 1 },
				bindAs: bName,
				span
			},
			true
		);
		p.lastObject = { ref: { k: 'binding', name: bName }, stepIndex: p.steps.length - 1 };
		return true;
	}
	if (
		/^until end of turn,\s*you may cast that card and you may spend mana as though it were mana of any color to cast that spell$/i.test(
			t
		) &&
		p.itRef()?.k === 'binding'
	) {
		const bName = (p.itRef() as { k: 'binding'; name: string }).name;
		p.push(
			{
				verb: 'grantPlayFromExile',
				subject: { k: 'binding', name: bName },
				params: { playFromExile: { duration: 'thisTurn', spellsOnly: true, spendManaAsAnyColor: true } },
				span
			},
			false
		);
		return true;
	}

	// 27. *Special Move*, *Hideous Taskmaster*, *Shellshock*, *Intellectual Offering*, *Kroxa*, *Druid of Purification*, *Sadistic Shell Game*
	const footTossM = t.match(/^target (.+?) deals damage equal to its power to any other target$/i);
	if (footTossM) {
		const f = h.objectFilter(footTossM[1].trim());
		if (f) {
			const idx0 = p.addTarget({ kind: 'object', filter: { zone: 'battlefield', ...f }, min: 1, max: 1 });
			const idx1 = p.addTarget({ kind: 'objectOrPlayer', filter: {}, otherTarget: true, min: 1, max: 1 });
			p.lastObject = { ref: { k: 'target', index: idx0 }, stepIndex: p.steps.length };
			p.push(
				{
					verb: 'damage',
					subject: { k: 'target', index: idx1 },
					amount: { k: 'stat', of: { k: 'target', index: idx0 }, stat: 'power' },
					params: { damageSource: { k: 'target', index: idx0 } },
					span
				},
				false
			);
			return true;
		}
	}
	const hideGrantM = t.match(/^they gain trample, haste, and annihilator (\d+) until end of turn$/i);
	if (hideGrantM && p.itRef()) {
		p.push(
			{
				verb: 'grant',
				subject: refToSelectorW10(p.itRef()!),
				params: {
					keywords: ['Trample', 'Haste'],
					grantedAbilityTexts: [`Annihilator ${hideGrantM[1]}`],
					duration: 'endOfTurn'
				},
				span
			},
			false
		);
		return true;
	}
	const perOppChooseM = t.match(/^for each opponent,\s*choose up to one target (.+?) that player controls$/i);
	if (perOppChooseM) {
		const f = h.objectFilter(perOppChooseM[1].trim());
		if (f) {
			const idx = p.addTarget({
				kind: 'object',
				filter: { zone: 'battlefield', ...f, controller: 'opponent' },
				min: 0,
				max: 99,
				perOpponent: true
			});
			p.lastObject = { ref: { k: 'target', index: idx }, stepIndex: p.steps.length };
			return true;
		}
	}
	if (/^~ deals X damage to each of those creatures$/i.test(t) && p.itRef()?.k === 'target') {
		p.push(
			{
				verb: 'damage',
				subject: refToSelectorW10(p.itRef()!),
				amount: { k: 'x' },
				params: { damageSource: { k: 'self' } },
				span
			},
			false
		);
		return true;
	}
	const mutagenM = t.match(/^you create (?:a|an) ([A-Za-z]+) token for each creature dealt damage this way$/i);
	if (mutagenM) {
		const sub = h.parseSubEffects(`create a ${mutagenM[1]} token`, span.start, p.context);
		if (sub.unparsed.length === 0 && sub.steps.length === 1 && sub.steps[0]!.verb === 'createToken') {
			p.push({ ...sub.steps[0]!, amount: { k: 'countedThisWay', kind: 'creaturesDealtDamageThisWay' }, span }, true);
			return true;
		}
	}
	const youAndThatDrawM = t.match(/^you and that player each draw (\S+) cards?$/i);
	if (youAndThatDrawM) {
		const amt = h.amountWord(p, youAndThatDrawM[1].toLowerCase());
		if (amt) {
			p.push({ verb: 'draw', subject: YOU, amount: amt, span }, false);
			p.push({ verb: 'draw', subject: { k: 'playerRef', ref: { k: 'chosenOpponent' } }, amount: amt, span }, false);
			return true;
		}
	}
	if (/^untap all nonland permanents you control and all nonland permanents that player controls$/i.test(t)) {
		p.push({ verb: 'untap', subject: { k: 'all', filter: { zone: 'battlefield', notTypes: ['Land'], controller: 'you' } }, span }, false);
		p.push(
			{
				verb: 'untap',
				subject: { k: 'all', filter: { zone: 'battlefield', notTypes: ['Land'], controllerRef: { k: 'chosenOpponent' } } },
				span
			},
			false
		);
		return true;
	}
	const kroxaM = t.match(
		/^each opponent discards a card,\s*then each opponent who didn't discard a nonland card this way loses (\S+) life$/i
	);
	if (kroxaM) {
		const dmgAmt = h.amountWord(p, kroxaM[1].toLowerCase());
		if (dmgAmt) {
			p.push(
				{
					verb: 'forEachPlayerLoop',
					subject: NONE,
					params: {
						loopPlayers: 'eachOpponent',
						loopSteps: [
							{ verb: 'discard', subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } }, amount: { k: 'const', n: 1 }, span },
							{
								verb: 'loseLife',
								subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } },
								amount: dmgAmt,
								condition: { k: 'playerDidntDiscardNonlandThisWay' },
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
	}
	if (/^starting with you,\s*each player may choose an artifact or enchantment you don't control$/i.test(t)) {
		const bName = `b_druid_${p.steps.length}`;
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				bindAs: bName,
				params: {
					loopPlayers: 'turnOrderStartingWithYou',
					chooseObjectToBind: {
						filter: {
							zone: 'battlefield',
							controller: 'opponent',
							anyOf: [{ types: ['Artifact'] }, { types: ['Enchantment'] }]
						},
						optional: true
					}
				},
				span
			},
			true
		);
		return true;
	}
	if (/^starting with the next opponent in turn order,\s*each player chooses a creature you don't control$/i.test(t)) {
		const bName = `b_shell_${p.steps.length}`;
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				bindAs: bName,
				params: {
					loopPlayers: 'turnOrderStartingWithNextOpponent',
					chooseObjectToBind: {
						filter: { zone: 'battlefield', controller: 'opponent', types: ['Creature'] },
						optional: false
					}
				},
				span
			},
			true
		);
		return true;
	}
	if (
		/^destroy (?:each permanent chosen this way|the chosen creatures)$/i.test(t) &&
		p.steps[p.steps.length - 1]?.verb === 'forEachPlayerLoop' &&
		p.steps[p.steps.length - 1]?.bindAs
	) {
		const bName = p.steps[p.steps.length - 1]!.bindAs!;
		p.push({ verb: 'destroy', subject: { k: 'binding', name: bName }, span }, false);
		return true;
	}

	const eachSacM = t.match(/^each (player|opponent) sacrifices (\S+) (.+?)(?: of their choice)?$/i);
	if (eachSacM) {
		const cnt = h.amountWord(p, eachSacM[2].toLowerCase());
		const f = h.objectFilter(eachSacM[3].trim());
		if (cnt && f) {
			const rel = eachSacM[1].toLowerCase() === 'opponent' ? 'eachOpponent' : 'eachPlayer';
			p.push(
				{
					verb: 'forEachPlayerLoop',
					subject: NONE,
					params: {
						loopPlayers: rel,
						loopSteps: [
							{
								verb: 'sacrifice',
								subject: { k: 'all', filter: { zone: 'battlefield', ...f, controllerRef: { k: 'eachLoopPlayer' } } },
								amount: cnt,
								actor: { k: 'eachLoopPlayer' },
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
	}

	return false;
}
