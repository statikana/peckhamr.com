/**
 * Wave 11 compiler effect extensions (pure compiler helpers, zero runtime state).
 *
 * Covers:
 * - Token copies, named/legendary/CDA/quoted-ability tokens, compound tokens, "It gains haste"
 * - Animate extensions ("It's still a land", quoted triggers/CDAs, type-overwriting animate,
 *   removeTypes, becomeCopy keepSelfName/keepThisAbility/addSupertypes, support X, firebending/annihilator N)
 * - Attachment, zone-swap (Reins of Power, Trickster-God's Heist), Phasing lock, Exile-until-monarch,
 *   Gather Specimens, Endless Detour, Desertion, Rod of Absorption, repeatSequence
 * - Wave 9–10 unparsed cleanup (dig/search/cast-from-exile/graveyard/hand, Tempting Offer, etc.)
 */
import type {
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
import type { CounterType, ManaColor } from '../types.ts';
import type { EffectsWave9ParserLike } from './effectsWave9.ts';
import {
	parseAmountWave11,
	parseConditionWave11,
	parseSentenceManaCountersWave11,
	type EffectsWave11Helpers
} from './manaCountersWave11.ts';

const YOU: Selector = { k: 'player', filter: { relation: 'you' } };
const NONE: Selector = { k: 'none' };

function refToSelW11(ref: Ref): Selector {
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

export function isWave11GrantableKeyword(k: string): boolean {
	return (
		/^firebending \d+$/i.test(k) ||
		/^annihilator \d+$/i.test(k) ||
		/^sunburst$/i.test(k) ||
		/^crew \d+$/i.test(k)
	);
}

// ---- 1. Extended ObjectFilters & TargetSpecs ------------------------------------------------

export function parseObjectFilterWave11(
	rawPhrase: string,
	h: EffectsWave11Helpers
): ObjectFilter | null {
	const t = rawPhrase.trim();

	if (/^creature cards? in your graveyard that were put there from the battlefield this turn$/i.test(t)) {
		return {
			zone: 'graveyard',
			owner: 'you',
			types: ['Creature'],
			enteredGraveyardFromBattlefieldThisTurn: true
		};
	}
	if (/^permanent cards? with cycling abilities$/i.test(t)) {
		return {
			zone: 'graveyard',
			owner: 'you',
			types: ['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle'],
			withCyclingAbility: true
		};
	}
	if (/^artifact and\/or non-Aura enchantment cards? each with mana value X or less$/i.test(t)) {
		return {
			zone: 'graveyard',
			owner: 'you',
			types: ['Artifact', 'Enchantment'],
			notSubtypes: ['Aura'],
			manaValueCompare: { op: '<=', value: { k: 'x' } }
		};
	}
	if (/^noncreature artifacts?$/i.test(t)) {
		return { types: ['Artifact'], notTypes: ['Creature'] };
	}
	if (/^nonbasic, noncreature permanents?$/i.test(t)) {
		return { notSupertypes: ['Basic'], notTypes: ['Creature'] };
	}
	if (/^Scions and Spawns you control$/i.test(t)) {
		return { zone: 'battlefield', subtypes: ['Scion', 'Spawn'], controller: 'you' };
	}
	if (/^creature tokens? you control that entered this turn$/i.test(t)) {
		return { zone: 'battlefield', types: ['Creature'], token: true, controller: 'you', enteredThisTurn: true };
	}
	if (/^permanent that player controls with an even mana value$/i.test(t)) {
		return { zone: 'battlefield', controllerRef: { k: 'eachLoopPlayer' }, manaValueParity: 'even' };
	}
	if (/^permanent card with an odd mana value$/i.test(t)) {
		return { zone: 'graveyard', owner: 'you', manaValueParity: 'odd' };
	}
	if (/^exiled card an opponent owns with a void counter on it$/i.test(t)) {
		return { zone: 'exile', owner: 'opponent', hasCounters: 'void' };
	}
	if (/^aura and\/or equipment cards?$/i.test(t)) {
		return { subtypes: ['Aura', 'Equipment'] };
	}
	if (/^equipment you control$/i.test(t)) {
		return { zone: 'battlefield', subtypes: ['Equipment'], controller: 'you' };
	}
	if (/^equipped attacking creatures? you control$/i.test(t)) {
		return { zone: 'battlefield', types: ['Creature'], controller: 'you', attacking: true, equipped: true };
	}
	if (/^creatures? that(?:'s| is) attacking one of your opponents$/i.test(t)) {
		return { zone: 'battlefield', types: ['Creature'], attacking: true };
	}
	if (/^Human or artifact an opponent controls$/i.test(t)) {
		return {
			zone: 'battlefield',
			controller: 'opponent',
			anyOf: [{ subtypes: ['Human'] }, { types: ['Artifact'] }]
		};
	}
	if (/^creature or planeswalker$/i.test(t)) {
		return { types: ['Creature', 'Planeswalker'] };
	}
	if (/^creature and planeswalker$/i.test(t)) {
		return { types: ['Creature', 'Planeswalker'] };
	}
	if (/^artifact or land that player controls$/i.test(t)) {
		return {
			zone: 'battlefield',
			types: ['Artifact', 'Land'],
			controllerRef: { k: 'eachLoopPlayer' }
		};
	}
	if (/^creature defending player controls with power less than ~'s power$/i.test(t)) {
		return {
			zone: 'battlefield',
			types: ['Creature'],
			controllerRef: { k: 'defendingPlayer' },
			powerLessThanSource: true
		};
	}
	if (/^nonland permanent an opponent controls with mana value less than or equal to that spell's mana value$/i.test(t)) {
		return {
			zone: 'battlefield',
			notTypes: ['Land'],
			controller: 'opponent',
			manaValueLteEventObject: true
		};
	}
	if (/^creature with power (\d+) or greater$/i.test(t)) {
		const nVal = parseInt(t.match(/(\d+)/)![1], 10);
		return { zone: 'battlefield', types: ['Creature'], power: { op: '>=', value: { k: 'const', n: nVal } } };
	}
	if (/^non-Dragon creature an opponent controls$/i.test(t)) {
		return { zone: 'battlefield', types: ['Creature'], notSubtypes: ['Dragon'], controller: 'opponent' };
	}
	if (/^land card with a basic land type$/i.test(t)) {
		return {
			zone: 'library',
			types: ['Land'],
			subtypes: ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']
		};
	}
	if (/^instant, sorcery, or creature card$/i.test(t)) {
		return { types: ['Instant', 'Sorcery', 'Creature'] };
	}
	if (/^creature or land cards?$/i.test(t)) {
		return { types: ['Creature', 'Land'] };
	}
	if (/^nonland permanent card$/i.test(t)) {
		return {
			types: ['Artifact', 'Creature', 'Enchantment', 'Planeswalker', 'Battle'],
			notTypes: ['Land']
		};
	}
	if (/^creature card that shares a creature type with the sacrificed creature$/i.test(t)) {
		return { types: ['Creature'], sharesCreatureTypeWithSelf: true };
	}
	void h;
	return null;
}

// ---- 2. Token Parser (Named, Legendary, CDA, Nested Quotes, Twice X) ------------------------

export function parseTokenCreationWave11(
	p: EffectsWave9ParserLike,
	rawBody: string,
	span: Span,
	h: EffectsWave11Helpers
): boolean {
	const t = rawBody.trim();

	// 1. Named legendary token:
	// "create <Name>, a legendary P/T <color> <Subtype> [artifact] [creature] token [with <kw/abilities>]"
	const namedTokM = t.match(
		/^create ([A-Z][A-Za-z0-9' -]+?), (?:a|an) (legendary )?(\d+)\/(\d+) ((?:(?:white|blue|black|red|green|colorless)(?:,? and |, | ))*)([A-Z][A-Za-z' -]*?)(?: (artifact|enchantment))?(?: (creature))? tokens?(?: with (.+))?$/
	);
	if (namedTokM) {
		const tokName = namedTokM[1].trim();
		const isLeg = Boolean(namedTokM[2]);
		const pw = parseInt(namedTokM[3], 10);
		const tg = parseInt(namedTokM[4], 10);
		const colorStr = (namedTokM[5] ?? '').trim();
		const subStr = namedTokM[6].trim();
		const extraType = namedTokM[7]?.toLowerCase();
		const hasCreature = Boolean(namedTokM[8]);
		const withRaw = (namedTokM[9] ?? '').trim();

		const kwList = withRaw ? h.keywordList(withRaw) : [];
		if (withRaw && !kwList) return false;

		const colors: ManaColor[] = [];
		for (const w of colorStr.toLowerCase().split(/,? and |, |\s+/).filter(Boolean)) {
			const c = h.colorWord(w);
			if (c && c !== 'C' && !colors.includes(c)) colors.push(c);
		}
		const typesList = ['Token'];
		if (isLeg) typesList.push('Legendary');
		if (extraType === 'artifact') typesList.push('Artifact');
		if (extraType === 'enchantment') typesList.push('Enchantment');
		if (hasCreature) typesList.push('Creature');
		const typeLine = `${typesList.join(' ')} — ${subStr}`;

		p.push(
			{
				verb: 'createToken',
				subject: YOU,
				amount: { k: 'const', n: 1 },
				params: {
					token: {
						name: tokName,
						power: pw,
						toughness: tg,
						colors,
						typeLine,
						keywords: kwList ?? [],
						...(isLeg ? { legendary: true } : {})
					}
				},
				bindAs: 'created',
				span
			},
			false
		);
		p.lastObject = { ref: { k: 'binding', name: 'created' }, stepIndex: p.steps.length - 1 };
		return true;
	}

	// 2. CDA token without P/T in header:
	// "create a <colors> <Subtype> creature token with \"~'s power and toughness are each equal to ...\""
	const cdaTokM = t.match(
		/^create (a|an|\S+) ((?:(?:white|blue|black|red|green|colorless)(?:,? and |, | ))*)([A-Z][A-Za-z' -]*?) creature tokens? with [“"]([^”"]+)[”"]$/
	);
	if (cdaTokM) {
		const amt = h.amountWord(p, cdaTokM[1].toLowerCase());
		const qText = cdaTokM[4].trim();
		const defs = h.compileQuotedAbilityString(qText, 'Token');
		if (!amt || defs.length === 0) return false;
		const spec = h.buildTokenSpec(0, 0, `${cdaTokM[2]}${cdaTokM[3]}`.trim(), '');
		p.push(
			{
				verb: 'createToken',
				subject: YOU,
				amount: amt,
				params: {
					token: {
						...spec,
						colors: [...spec.colors],
						keywords: [...spec.keywords],
						quotedAbilities: [qText]
					}
				},
				bindAs: 'created',
				span
			},
			false
		);
		p.lastObject = { ref: { k: 'binding', name: 'created' }, stepIndex: p.steps.length - 1 };
		return true;
	}

	// 3. Token with nested single-quoted ability inside double quotes (*Nesting Dragon*):
	// e.g. create a 0/2 red Dragon Egg creature token with defender and "When ~ dies, create a 2/2 red Dragon creature token with flying and '{R}: ~ gets +1/+0 until end of turn.'"
	const nestedTokM = t.match(
		/^create (a|an|\S+) (\d+)\/(\d+) ((?:(?:white|blue|black|red|green|colorless)(?:,? and |, | ))*)([A-Z][A-Za-z' ]*?) creature tokens? with (?:([a-z, ]+?)(?:,? and )?)?[“"]([^”"]+)[”"]$/
	);
	if (nestedTokM && nestedTokM[7].includes("'")) {
		const amt = h.amountWord(p, nestedTokM[1].toLowerCase());
		const plainKwRaw = (nestedTokM[6] ?? '').trim();
		const kwList = plainKwRaw ? h.keywordList(plainKwRaw) : [];
		if (!amt || (plainKwRaw && !kwList)) return false;
		const normalizedQuote = nestedTokM[7].trim().replace(/'([^']+)'/g, '"$1"');
		const defs = h.compileQuotedAbilityString(normalizedQuote, 'Token');
		if (defs.length === 0) return false;
		const spec = h.buildTokenSpec(
			parseInt(nestedTokM[2], 10),
			parseInt(nestedTokM[3], 10),
			`${nestedTokM[4]}${nestedTokM[5]}`.trim(),
			plainKwRaw
		);
		p.push(
			{
				verb: 'createToken',
				subject: YOU,
				amount: amt,
				params: {
					token: {
						...spec,
						colors: [...spec.colors],
						keywords: kwList ?? [...spec.keywords],
						quotedAbilities: [normalizedQuote]
					}
				},
				bindAs: 'created',
				span
			},
			false
		);
		p.lastObject = { ref: { k: 'binding', name: 'created' }, stepIndex: p.steps.length - 1 };
		return true;
	}

	// 4. "create twice X P/T ... token with \"...\"" (*Pest Infestation*)
	const twiceTokM = t.match(
		/^create twice X (\d+)\/(\d+) ((?:(?:white|blue|black|red|green|colorless)(?:,? and |, | ))*)([A-Z][A-Za-z' ]*?) creature tokens?(?: with [“"]([^”"]+)[”"])?$/
	);
	if (twiceTokM) {
		const qText = twiceTokM[5]?.trim();
		if (qText && h.compileQuotedAbilityString(qText, 'Token').length === 0) return false;
		const spec = h.buildTokenSpec(
			parseInt(twiceTokM[1], 10),
			parseInt(twiceTokM[2], 10),
			`${twiceTokM[3]}${twiceTokM[4]}`.trim(),
			''
		);
		p.push(
			{
				verb: 'createToken',
				subject: YOU,
				amount: { k: 'mul', factor: 2, of: { k: 'x' } },
				params: {
					token: {
						...spec,
						colors: [...spec.colors],
						keywords: [...spec.keywords],
						...(qText ? { quotedAbilities: [qText] } : {})
					}
				},
				bindAs: 'created',
				span
			},
			false
		);
		p.lastObject = { ref: { k: 'binding', name: 'created' }, stepIndex: p.steps.length - 1 };
		return true;
	}

	// 5. Compound tokens: "create <A> and <B>" (e.g. "create X 1/1 white Halfling creature tokens and X Food tokens",
	// "Create a Treasure token and a 2/2 blue Bird creature token with flying")
	const compM = t.match(/^create (.+? tokens?) and (?!that\b)(.+? tokens?(?: with .+)?)$/i);
	if (compM) {
		const mark = p.mark();
		const ok1 = h.sentence(p, `create ${compM[1].trim()}`, span);
		const ok2 = ok1 && h.sentence(p, `create ${compM[2].trim()}`, span);
		if (ok1 && ok2) return true;
		p.rollback(mark);
	}

	// 6. "create three tapped X/X green Treefolk creature tokens, where X is <expr>" (*Assemble the Entmoot*)
	// or "create X ... tokens, where X is <expr>" (*Thalisse*, *Welcome the Dead*, *Will of the Mardu*, *Notorious Throng*)
	const createWhereM = t.match(/^create (?:(tapped)\s+)?(.+?),\s*where X is (.+)$/i);
	if (createWhereM) {
		const amtExpr = parseAmountWave11(p, createWhereM[3].trim(), h) ?? h.equalTo(p, createWhereM[3].trim());
		if (amtExpr) {
			const prevDefX = p.definedX;
			p.definedX = amtExpr;
			const mark = p.mark();
			const prefix = createWhereM[1] ? 'create tapped ' : 'create ';
			const ok = h.sentence(p, `${prefix}${createWhereM[2].trim()}`, span);
			p.definedX = prevDefX;
			if (ok) {
				// Substitute { k: 'x' } in the newly created step's amount and dynamicTokenPT
				const st = p.steps[p.steps.length - 1];
				if (st) {
					if (st.amount?.k === 'x') st.amount = amtExpr;
					if (st.params?.dynamicTokenPT) {
						if (st.params.dynamicTokenPT.power.k === 'x') st.params.dynamicTokenPT.power = amtExpr;
						if (st.params.dynamicTokenPT.toughness.k === 'x') st.params.dynamicTokenPT.toughness = amtExpr;
					}
				}
				return true;
			}
			p.rollback(mark);
		}
	}

	// 7. "create a <token> for each <expr>" (*Big Apple, 3 a.m.*, *Gadrak*, *Vile Redeemer*)
	const createForEachM = t.match(/^create (.+? tokens?(?: with .+)?) for each (.+)$/i);
	if (createForEachM) {
		const amt = parseAmountWave11(p, createForEachM[2].trim(), h) ?? h.equalTo(p, createForEachM[2].trim());
		if (amt) {
			const mark = p.mark();
			if (h.sentence(p, `create ${createForEachM[1].trim()}`, span)) {
				const st = p.steps[p.steps.length - 1];
				if (st?.verb === 'createToken') {
					st.amount = amt;
					return true;
				}
			}
			p.rollback(mark);
		}
	}

	// 8. "create a number of <tokens> equal to <expr>" (*Will of the Mardu*)
	const createNumEqM = t.match(/^create a number of (.+? tokens?) equal to (.+)$/i);
	if (createNumEqM) {
		const amt = parseAmountWave11(p, createNumEqM[2].trim(), h) ?? h.equalTo(p, createNumEqM[2].trim());
		if (amt) {
			const mark = p.mark();
			if (h.sentence(p, `create a ${createNumEqM[1].trim()}`, span)) {
				const st = p.steps[p.steps.length - 1];
				if (st?.verb === 'createToken') {
					st.amount = amt;
					return true;
				}
			}
			p.rollback(mark);
		}
	}

	return false;
}

// ---- 3. Token Copy & Copy Modification Parser -----------------------------------------------

export function parseCopyAndAnimateWave11(
	p: EffectsWave9ParserLike,
	rawText: string,
	span: Span,
	h: EffectsWave11Helpers
): boolean {
	const t = rawText.trim().replace(/\.$/, '').trim();

	// 1. "For each token you control, create a token that's a copy of that permanent" (*Second Harvest*)
	if (/^for each token you control, create a token that's a copy of that permanent$/i.test(t)) {
		p.push(
			{
				verb: 'copyPermanent',
				subject: { k: 'all', filter: { zone: 'battlefield', controller: 'you', token: true } },
				amount: { k: 'const', n: 1 },
				bindAs: 'created',
				span
			},
			true
		);
		p.lastObject = { ref: { k: 'binding', name: 'created' }, stepIndex: p.steps.length - 1 };
		return true;
	}

	// 2. *Redoubled Stormsinger*: "for each creature token you control that entered this turn, create a tapped and attacking token that's a copy of that token"
	if (
		/^for each creature token you control that entered this turn, create a tapped and attacking token that's a copy of that token$/i.test(
			t
		)
	) {
		p.push(
			{
				verb: 'copyPermanent',
				subject: {
					k: 'all',
					filter: { zone: 'battlefield', types: ['Creature'], token: true, controller: 'you', enteredThisTurn: true }
				},
				amount: { k: 'const', n: 1 },
				params: { tapped: true, tappedAndAttacking: true },
				bindAs: 'created',
				span
			},
			true
		);
		p.lastObject = { ref: { k: 'binding', name: 'created' }, stepIndex: p.steps.length - 1 };
		return true;
	}

	// 3. *Hazel of the Rootbloom*: "create a token that's a copy of target token you control. If that token is a Squirrel, instead create two tokens that are copies of it."
	if (/^create a token that's a copy of target token you control$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', token: true, controller: 'you' },
			min: 1,
			max: 1
		});
		p.push(
			{
				verb: 'copyPermanent',
				subject: { k: 'target', index: idx },
				amount: { k: 'const', n: 1 },
				bindAs: 'created',
				span
			},
			true
		);
		p.lastObject = { ref: { k: 'binding', name: 'created' }, stepIndex: p.steps.length - 1 };
		return true;
	}
	if (/^if that token is a ([A-Z][a-z]+), instead create two tokens that are copies of it$/i.test(t)) {
		const sub = t.match(/is a ([A-Z][a-z]+),/i)![1];
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'copyPermanent' && prev.subject.k === 'target') {
			prev.amount = {
				k: 'conditional',
				condition: {
					k: 'matchesFilter',
					target: { k: 'target', index: prev.subject.index },
					filter: { subtypes: [sub] }
				},
				then: { k: 'const', n: 2 },
				else: { k: 'const', n: 1 }
			};
			return true;
		}
	}

	// 4. *Chandra, Flameshaper* +1:
	// "Create a token that's a copy of target creature you control, except it has haste and \"At the beginning of the end step, sacrifice ~.\""
	if (
		/^create a token that's a copy of target creature you control, except it has haste and [“"]At the beginning of the end step, sacrifice ~\.?[”"]$/i.test(
			t
		)
	) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'], controller: 'you' },
			min: 1,
			max: 1
		});
		p.push(
			{
				verb: 'copyPermanent',
				subject: { k: 'target', index: idx },
				amount: { k: 'const', n: 1 },
				params: {
					copyMod: {
						addKeywords: ['Haste'],
						addedAbilityTexts: ['At the beginning of the end step, sacrifice ~.']
					}
				},
				bindAs: 'created',
				span
			},
			true
		);
		p.lastObject = { ref: { k: 'binding', name: 'created' }, stepIndex: p.steps.length - 1 };
		return true;
	}

	// 5. *Espers to Magicite*:
	// "Create a token that's a copy of that card, except it's an artifact and it loses all other card types"
	if (
		/^create a token that's a copy of that card, except it's an artifact and it loses all other card types$/i.test(
			t
		)
	) {
		const ref = p.lastObject?.ref ?? { k: 'binding', name: 'exiled' };
		p.push(
			{
				verb: 'copyPermanent',
				subject: refToSelW11(ref),
				amount: { k: 'const', n: 1 },
				params: { copyMod: { setTypes: ['Artifact'] } },
				bindAs: 'created',
				span
			},
			true
		);
		p.lastObject = { ref: { k: 'binding', name: 'created' }, stepIndex: p.steps.length - 1 };
		return true;
	}

	// 6. *Foggy Swamp Visions*: "For each creature card exiled this way, create a token that's a copy of it"
	if (/^for each creature card exiled this way, create a token that's a copy of it$/i.test(t)) {
		const ref = p.lastObject?.ref ?? { k: 'binding', name: 'exiled' };
		p.push(
			{
				verb: 'copyPermanent',
				subject: refToSelW11(ref),
				amount: { k: 'const', n: 1 },
				bindAs: 'created',
				span
			},
			true
		);
		p.lastObject = { ref: { k: 'binding', name: 'created' }, stepIndex: p.steps.length - 1 };
		return true;
	}

	// 7. *Saw in Half*:
	// "If that creature dies this way, its controller creates two tokens that are copies of that creature, except their power is half that creature's power and their toughness is half that creature's toughness. Round up each time."
	if (
		/^if that creature dies this way, its controller creates two tokens that are copies of that creature, except their power is half that creature's power and their toughness is half that creature's toughness$/i.test(
			t
		)
	) {
		const ref: Ref = p.lastObject?.ref ?? { k: 'target', index: 0 };
		if (p.lastObject && ref.k === 'binding') {
			const prevStep = p.steps[p.lastObject.stepIndex];
			if (prevStep && !prevStep.bindAs) prevStep.bindAs = ref.name;
		}
		p.push(
			{
				verb: 'copyPermanent',
				subject: refToSelW11(ref),
				actor: { k: 'controllerOf', of: ref },
				amount: { k: 'const', n: 2 },
				condition: { k: 'diedThisWay', ref },
				params: { copyMod: { halvePT: { round: 'up' } } },
				bindAs: 'created',
				span
			},
			true
		);
		p.lastObject = { ref: { k: 'binding', name: 'created' }, stepIndex: p.steps.length - 1 };
		return true;
	}
	if (/^round up each time$/i.test(t)) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'copyPermanent' && prev.params?.copyMod?.halvePT) return true;
	}

	// 8. *Raging Ravine* / *Druid Class* 3 / *Vraska* -2 / *Nogi* / *Flayer of Loyalties* / *Weeping Angel*:
	// "It's still a land."
	if (/^it's still a land$/i.test(t)) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'animate') {
			const setT = prev.params?.setTypes ?? prev.params?.addTypes ?? ['Creature'];
			const setS = prev.params?.setSubtypes ?? prev.params?.addSubtypes;
			prev.params = {
				...prev.params,
				setTypes: undefined,
				setSubtypes: undefined,
				addTypes: setT,
				...(setS?.length ? { addSubtypes: setS } : {}),
				keepExistingTypes: true,
				stillALand: true
			};
			return true;
		}
	}

	// *Raging Ravine*: "Until end of turn, ~ becomes a 3/3 red and green Elemental creature with \"Whenever ~ attacks, put a +1/+1 counter on it.\""
	const animQuotedTrigM = t.match(
		/^(?:until end of turn,\s+)?(~|target .+?) becomes (?:a |an )?(?:(\d+)\/(\d+) )?((?:(?:white|blue|black|red|green|colorless)(?:,? and |, | ))*)([A-Z][A-Za-z' ]*?) creature(?:s)? with (?:([a-z, ]+?) and )?[“"]([^”"]+)[”"]$/i
	);
	if (animQuotedTrigM) {
		const subjRaw = animQuotedTrigM[1].trim();
		const qText = animQuotedTrigM[7].trim();
		if (h.compileQuotedAbilityString(qText, 'Permanent').length === 0) return false;
		const plainKw = animQuotedTrigM[6]?.trim();
		const kwList = plainKw ? h.keywordList(plainKw) : [];
		if (plainKw && !kwList) return false;
		let subj: Selector = { k: 'self' };
		if (!/^~$/.test(subjRaw)) {
			const tp = h.targetPhrase(p, subjRaw.replace(/^target\s+/i, ''));
			if (!tp) return false;
			const idx = p.addTarget({ ...tp, min: 1, max: 1 });
			subj = { k: 'target', index: idx };
		}
		const colors: ManaColor[] = [];
		for (const w of (animQuotedTrigM[4] ?? '').toLowerCase().split(/,? and |, |\s+/).filter(Boolean)) {
			const c = h.colorWord(w);
			if (c && c !== 'C' && !colors.includes(c)) colors.push(c);
		}
		const sub = h.singularSubtype(animQuotedTrigM[5].trim()) ?? animQuotedTrigM[5].trim();
		const eot = /^until end of turn,/i.test(t);
		p.push(
			{
				verb: 'animate',
				subject: subj,
				params: {
					duration: eot ? 'endOfTurn' : 'permanent',
					setTypes: ['Creature'],
					setSubtypes: [sub],
					...(colors.length > 0 ? { setColors: colors } : {}),
					...(animQuotedTrigM[2]
						? {
								setPower: { k: 'const', n: parseInt(animQuotedTrigM[2], 10) },
								setToughness: { k: 'const', n: parseInt(animQuotedTrigM[3], 10) }
							}
						: {}),
					...(kwList && kwList.length > 0 ? { addKeywords: kwList } : {}),
					grantedAbilityTexts: [qText]
				},
				span
			},
			true
		);
		return true;
	}

	// *Druid Class* 3: "target land you control becomes a creature with haste and \"~'s power and toughness are each equal to the number of lands you control.\""
	if (
		/^target land you control becomes a creature with haste and [“"]~'s power and toughness are each equal to the number of lands you control\.?[”"]$/i.test(
			t
		)
	) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Land'], controller: 'you' },
			min: 1,
			max: 1
		});
		const landCount: Amount = { k: 'count', of: { zone: 'battlefield', types: ['Land'], controller: 'you' } };
		p.push(
			{
				verb: 'animate',
				subject: { k: 'target', index: idx },
				params: {
					duration: 'permanent',
					setTypes: ['Creature'],
					addKeywords: ['Haste'],
					setPower: landCount,
					setToughness: landCount,
					grantedAbilityTexts: ["~'s power and toughness are each equal to the number of lands you control."]
				},
				span
			},
			true
		);
		return true;
	}

	// *Vraska* -2: "Target creature becomes a Treasure artifact with \"{T}, Sacrifice ~: Add one mana of any color\" and loses all other card types and abilities"
	if (
		/^target creature becomes a Treasure artifact with [“"]\{T\}, Sacrifice ~: Add one mana of any color[”"] and loses all other card types and abilities$/i.test(
			t
		)
	) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'] },
			min: 1,
			max: 1
		});
		p.push(
			{
				verb: 'animate',
				subject: { k: 'target', index: idx },
				params: {
					duration: 'permanent',
					setTypes: ['Artifact'],
					setSubtypes: ['Treasure'],
					removeAllAbilities: true,
					grantedAbilityTexts: ['{T}, Sacrifice ~: Add one mana of any color.']
				},
				span
			},
			true
		);
		return true;
	}

	// *Nogi*: "until end of turn, ~ becomes a Dragon with base power and toughness 5/5 and gains flying"
	const nogiM = t.match(
		/^until end of turn, ~ becomes (?:a |an )?([A-Z][a-z]+) with base power and toughness (\d+)\/(\d+) and gains ([a-z]+)$/i
	);
	if (nogiM) {
		const sub = h.singularSubtype(nogiM[1]) ?? nogiM[1];
		const kws = h.keywordList(nogiM[4]);
		if (kws) {
			p.push(
				{
					verb: 'animate',
					subject: { k: 'self' },
					params: {
						duration: 'endOfTurn',
						setTypes: ['Creature'],
						setSubtypes: [sub],
						setPower: { k: 'const', n: parseInt(nogiM[2], 10) },
						setToughness: { k: 'const', n: parseInt(nogiM[3], 10) },
						addKeywords: kws
					},
					span
				},
				true
			);
			return true;
		}
	}

	// *Flayer of Loyalties*: "Until end of turn, it has base power and toughness 10/10 and gains trample, annihilator 2, and haste"
	const flayerM = t.match(
		/^until end of turn, it has base power and toughness (\d+)\/(\d+) and gains (.+)$/i
	);
	if (flayerM && p.lastObject) {
		const kws = h.keywordList(flayerM[3]);
		if (kws) {
			p.push(
				{
					verb: 'animate',
					subject: refToSelW11(p.lastObject.ref),
					params: {
						duration: 'endOfTurn',
						keepExistingTypes: true,
						setPower: { k: 'const', n: parseInt(flayerM[1], 10) },
						setToughness: { k: 'const', n: parseInt(flayerM[2], 10) },
						addKeywords: kws
					},
					span
				},
				true
			);
			return true;
		}
	}

	// *Weeping Angel*: "~ isn't a creature until end of turn"
	if (/^~ isn't a creature until end of turn$/i.test(t)) {
		p.push(
			{
				verb: 'animate',
				subject: { k: 'self' },
				params: {
					duration: 'endOfTurn',
					removeTypes: ['Creature'],
					keepExistingTypes: true
				},
				span
			},
			true
		);
		return true;
	}

	// *Blitzball Stadium* act_1: "Until end of turn, target creature gains \"Whenever ~ deals combat damage to a player, draw a card for each kind of counter on it\" and it can't be blocked this turn"
	if (
		/^until end of turn, target creature gains [“"]Whenever ~ deals combat damage to a player, draw a card for each kind of counter on it[”"] and it can't be blocked this turn$/i.test(
			t
		)
	) {
		const idx = p.addTarget({ kind: 'object', filter: { zone: 'battlefield', types: ['Creature'] }, min: 1, max: 1 });
		p.push(
			{
				verb: 'grant',
				subject: { k: 'target', index: idx },
				params: {
					duration: 'endOfTurn',
					grantedAbilityTexts: ['Whenever ~ deals combat damage to a player, draw a card for each kind of counter on it.']
				},
				span
			},
			true
		);
		p.push(
			{
				verb: 'combatRestriction',
				subject: { k: 'target', index: idx },
				params: { combatRestriction: { kind: 'cantBeBlocked' }, duration: 'endOfTurn' },
				span
			},
			true
		);
		return true;
	}

	// *Hunter's Prowess*: "Until end of turn, target creature gets +3/+3 and gains trample and \"Whenever ~ deals combat damage to a player, draw that many cards.\""
	if (
		/^until end of turn, target creature gets \+3\/\+3 and gains trample and [“"]Whenever ~ deals combat damage to a player, draw that many cards\.?[”"]$/i.test(
			t
		)
	) {
		const idx = p.addTarget({ kind: 'object', filter: { zone: 'battlefield', types: ['Creature'] }, min: 1, max: 1 });
		p.push(
			{
				verb: 'pump',
				subject: { k: 'target', index: idx },
				amount: { k: 'const', n: 3 },
				params: { toughness: { k: 'const', n: 3 }, duration: 'endOfTurn' },
				span
			},
			true
		);
		p.push(
			{
				verb: 'grant',
				subject: { k: 'target', index: idx },
				params: {
					duration: 'endOfTurn',
					keywords: ['Trample'],
					grantedAbilityTexts: ['Whenever ~ deals combat damage to a player, draw that many cards.']
				},
				span
			},
			true
		);
		return true;
	}

	// *Gogo* / *Irma* / *Kimahri* / *Sarkhan* — becomeCopy with keepSelfName
	// *Gogo*: "you may have ~ become a copy of another target creature you control until end of turn, except its name is ~. If you do, ~ and that creature each get +2/+0 and gain haste until end of turn and attack this turn if able."
	if (
		/^you may have ~ become a copy of another target creature you control until end of turn, except its name is ~$/i.test(
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
				verb: 'becomeCopy',
				subject: { k: 'self' },
				optional: { chooser: { k: 'you' } },
				params: {
					copySource: { k: 'target', index: idx },
					duration: 'endOfTurn',
					copyMod: { keepSelfName: true }
				},
				span
			},
			true
		);
		p.lastOptionalStep = p.steps.length - 1;
		return true;
	}
	if (
		/^if you do, ~ and that creature each get \+2\/\+0 and gain haste until end of turn and attack this turn if able$/i.test(
			t
		) &&
		p.steps[p.steps.length - 1]?.verb === 'becomeCopy'
	) {
		const bcIdx = p.steps.length - 1;
		const tIdx = p.steps[bcIdx].params?.copySource?.k === 'target' ? p.steps[bcIdx].params!.copySource.index : 0;
		for (const subj of [{ k: 'self' } as Selector, { k: 'target', index: tIdx } as Selector]) {
			p.push(
				{
					verb: 'pump',
					subject: subj,
					amount: { k: 'const', n: 2 },
					params: { toughness: { k: 'const', n: 0 }, duration: 'endOfTurn' },
					ifPrecedingAccepted: bcIdx,
					span
				},
				true
			);
			p.push(
				{
					verb: 'grant',
					subject: subj,
					params: { keywords: ['Haste'], mustAttackThisTurn: true, duration: 'endOfTurn' },
					ifPrecedingAccepted: bcIdx,
					span
				},
				true
			);
		}
		return true;
	}

	// *Irma*: "~ becomes a copy of up to one other target creature you control, except its name is ~ and it has this ability"
	if (
		/^~ becomes a copy of up to one other target creature you control, except its name is ~ and it has this ability$/i.test(
			t
		)
	) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'], controller: 'you', other: true },
			min: 0,
			max: 1
		});
		p.push(
			{
				verb: 'becomeCopy',
				subject: { k: 'self' },
				params: {
					copySource: { k: 'target', index: idx },
					duration: 'permanent',
					copyMod: { keepSelfName: true, keepThisAbility: true }
				},
				span
			},
			true
		);
		p.lastObject = { ref: { k: 'self' }, stepIndex: p.steps.length - 1 };
		return true;
	}

	// *Kimahri*: "Then you may have ~ become a copy of that creature, except its name is ~ and it has vigilance and this ability"
	if (
		/^then you may have ~ become a copy of that creature, except its name is ~ and it has vigilance and this ability$/i.test(
			t
		)
	) {
		const ref = p.lastObject?.ref ?? { k: 'target', index: 0 };
		p.push(
			{
				verb: 'becomeCopy',
				subject: { k: 'self' },
				optional: { chooser: { k: 'you' } },
				params: {
					copySource: refToSelW11(ref),
					duration: 'permanent',
					copyMod: { keepSelfName: true, addKeywords: ['Vigilance'], keepThisAbility: true }
				},
				span
			},
			true
		);
		return true;
	}

	// *Sarkhan, Soul Aflame*: "you may have ~ become a copy of it until end of turn, except its name is ~ and it's legendary in addition to its other types"
	if (
		/^you may have ~ become a copy of it until end of turn, except its name is ~ and it's legendary in addition to its other types$/i.test(
			t
		)
	) {
		p.push(
			{
				verb: 'becomeCopy',
				subject: { k: 'self' },
				optional: { chooser: { k: 'you' } },
				params: {
					copySource: { k: 'eventObject' },
					duration: 'endOfTurn',
					copyMod: { keepSelfName: true, addSupertypes: ['Legendary'] }
				},
				span
			},
			true
		);
		return true;
	}

	// *Dance of the Manse* / *Ghost Vacuum* / *Ever After* / *Terror of Towashi* / *Afterlife from the Loam*
	if (/^if X is 6 or more, those permanents are 4\/4 creatures in addition to their other types$/i.test(t)) {
		const ref = p.lastObject?.ref ?? { k: 'binding', name: 'moved' };
		p.push(
			{
				verb: 'animate',
				subject: refToSelW11(ref),
				condition: { k: 'compare', left: { k: 'x' }, op: '>=', right: { k: 'const', n: 6 } },
				params: {
					duration: 'permanent',
					addTypes: ['Creature'],
					keepExistingTypes: true,
					setPower: { k: 'const', n: 4 },
					setToughness: { k: 'const', n: 4 }
				},
				span
			},
			true
		);
		return true;
	}
	if (/^each of them is a (\d+)\/(\d+) ([A-Z][a-z]+) in addition to its other types$/i.test(t)) {
		const m = t.match(/is a (\d+)\/(\d+) ([A-Z][a-z]+)/i)!;
		const ref = p.lastObject?.ref ?? { k: 'binding', name: 'moved' };
		p.push(
			{
				verb: 'animate',
				subject: refToSelW11(ref),
				params: {
					duration: 'permanent',
					addTypes: ['Creature'],
					addSubtypes: [h.singularSubtype(m[3]) ?? m[3]],
					keepExistingTypes: true,
					setPower: { k: 'const', n: parseInt(m[1], 10) },
					setToughness: { k: 'const', n: parseInt(m[2], 10) }
				},
				span
			},
			true
		);
		return true;
	}
	if (/^(?:each of those creatures|it|they)(?:'s|'re| is| are) (?:a )?(?:(black|white|blue|red|green) )?([A-Z][a-z]+)s? in addition to (?:its|their) other (?:colors and )?types$/i.test(t)) {
		const m = t.match(/(?:(black|white|blue|red|green) )?([A-Z][a-z]+)s? in addition to/i)!;
		const col = m[1] ? h.colorWord(m[1].toLowerCase()) : null;
		const sub = h.singularSubtype(m[2]) ?? m[2];
		const ref = p.lastObject?.ref ?? { k: 'binding', name: 'moved' };
		p.push(
			{
				verb: 'animate',
				subject: refToSelW11(ref),
				params: {
					duration: 'permanent',
					addSubtypes: [sub],
					...(col && col !== 'C' ? { addColors: [col] } : {}),
					keepExistingTypes: true
				},
				span
			},
			true
		);
		return true;
	}

	// *Llanowar Greenwidow*: "It gains \"If ~ would leave the battlefield, exile it instead of putting it anywhere else.\""
	if (/^it gains [“"]If ~ would leave the battlefield, exile it instead of putting it anywhere else\.?[”"]$/i.test(t)) {
		p.push(
			{
				verb: 'exileInsteadOfDying',
				subject: { k: 'self' },
				params: { duration: 'permanent' },
				span
			},
			false
		);
		return true;
	}

	// *Opportunistic Dragon*: "choose target Human or artifact an opponent controls. For as long as ~ remains on the battlefield, gain control of that permanent, it loses all abilities, and it can't attack or block."
	if (
		/^for as long as ~ remains on the battlefield, gain control of that permanent, it loses all abilities, and it can't attack or block$/i.test(
			t
		)
	) {
		const ref = p.lastObject?.ref ?? { k: 'target', index: 0 };
		const sel = refToSelW11(ref);
		p.push(
			{
				verb: 'gainControl',
				subject: sel,
				params: { duration: 'forAsLongAsYouControlSelf' },
				span
			},
			true
		);
		p.push(
			{
				verb: 'animate',
				subject: sel,
				params: { removeAllAbilities: true, keepExistingTypes: true, duration: 'forAsLongAsYouControlSelf' },
				span
			},
			true
		);
		p.push(
			{
				verb: 'combatRestriction',
				subject: sel,
				params: { combatRestriction: { kind: 'cantAttackOrBlock' }, duration: 'forAsLongAsYouControlSelf' },
				span
			},
			true
		);
		return true;
	}

	return false;
}

// ---- 4. Attachments, Zone-Swaps, Exile-Until, Dig/Search/Cast Cleanup ----------------------

export function parseSentenceWave11(
	p: EffectsWave9ParserLike,
	rawText: string,
	span: Span,
	h: EffectsWave11Helpers
): boolean {
	if (parseSentenceManaCountersWave11(p, rawText, span, h)) return true;

	const t = rawText.trim().replace(/\.$/, '').trim();

	// Token creation & copy/animate extensions
	if (/^create\b/i.test(t) && parseTokenCreationWave11(p, t, span, h)) return true;
	if (parseCopyAndAnimateWave11(p, t, span, h)) return true;

	// Trailing "if <condition>" wrapper on any Wave 11 sentence (e.g. *Transpose*, *Fisher's Talent*, *Vines of Vastwood*, *Cache Grab*)
	const leadIfM = t.match(/^if ([^,]+),\s*(.+)$/i);
	if (
		leadIfM &&
		!/^(?:you (?:do|don't|do not|win(?: the clash)?|lose the flip)|(?:that player|the player|they) (?:does|do|doesn't|don't))$/i.test(
			leadIfM[1].trim()
		)
	) {
		const cond = parseConditionWave11(p, leadIfM[1].trim(), h);
		if (cond) {
			const before = p.steps.length;
			const mark = p.mark();
			const parseSubList = (body: string): boolean => {
				if (h.clauses(p, body, span.start)) return true;
				p.rollback(mark);
				const parts = body.replace(/,\s+and\s+/gi, ', ').split(/,\s+/).map((s) => s.trim()).filter(Boolean);
				if (parts.length <= 1) return false;
				for (const part of parts) {
					if (!h.sentence(p, part, span)) {
						p.rollback(mark);
						return false;
					}
				}
				return true;
			};
			if (parseSubList(leadIfM[2].trim())) {
				for (let i = before; i < p.steps.length; i++) {
					p.steps[i].condition = p.steps[i].condition
						? { k: 'and', of: [cond, p.steps[i].condition!] }
						: cond;
				}
				return true;
			}
			p.rollback(mark);
		}
	}
	const trailIfM = t.match(/^(.+?)\s+(if\s+.+)$/i);
	if (trailIfM && !/\bunless\b/i.test(trailIfM[2])) {
		const cond = parseConditionWave11(p, trailIfM[2].trim(), h);
		if (cond) {
			const before = p.steps.length;
			const mark = p.mark();
			if (h.clauses(p, trailIfM[1].trim(), span.start)) {
				for (let i = before; i < p.steps.length; i++) {
					p.steps[i].condition = p.steps[i].condition
						? { k: 'and', of: [cond, p.steps[i].condition!] }
						: cond;
				}
				return true;
			}
			p.rollback(mark);
		}
	}

	// *Vile Redeemer*: "Those tokens have \"Sacrifice ~: Add {C}.\""
	if (/^those tokens have [“"]([^”"]+)[”"]$/i.test(t)) {
		const qText = t.match(/[“"]([^”"]+)[”"]/)![1].trim();
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'createToken' && prev.params?.token && h.compileQuotedAbilityString(qText, 'Token').length > 0) {
			prev.params.token = {
				...prev.params.token,
				quotedAbilities: [...(prev.params.token.quotedAbilities ?? []), qText]
			};
			return true;
		}
	}

	// *Assemble the Entmoot*: "Put a reach counter on each of them"
	if (/^put a ([a-z]+) counter on each of them$/i.test(t) && p.lastObject) {
		const cname = t.match(/^put a ([a-z]+) counter/i)![1].toLowerCase() as CounterType;
		p.push(
			{
				verb: 'putCounters',
				subject: refToSelW11(p.lastObject.ref),
				amount: { k: 'const', n: 1 },
				params: { counter: cname },
				span
			},
			false
		);
		return true;
	}

	// *Legion Warboss*: "That token gains haste until end of turn and attacks this combat if able"
	if (/^that token gains haste until end of turn and attacks this combat if able$/i.test(t) && p.lastObject) {
		const sel = refToSelW11(p.lastObject.ref);
		p.push(
			{
				verb: 'grant',
				subject: sel,
				params: { keywords: ['Haste'], mustAttackThisTurn: true, duration: 'endOfTurn' },
				span
			},
			false
		);
		return true;
	}

	// *Cloud* / *Barret* / *Yuffie* / *Zack Fair* / *Unfinished Business* — Attachments
	if (/^attach up to one target Equipment you control to it$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', subtypes: ['Equipment'], controller: 'you' },
			min: 0,
			max: 1
		});
		p.push({ verb: 'attach', subject: { k: 'self' }, params: { attachObject: { k: 'target', index: idx } }, span }, true);
		return true;
	}
	if (/^attach up to one target Equipment you control to target ([A-Z][a-z]+) you control$/i.test(t)) {
		const sub = t.match(/to target ([A-Z][a-z]+) you control$/i)![1];
		const eqIdx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', subtypes: ['Equipment'], controller: 'you' },
			min: 0,
			max: 1
		});
		const crIdx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', subtypes: [h.singularSubtype(sub) ?? sub], controller: 'you' },
			min: 1,
			max: 1
		});
		p.push(
			{
				verb: 'attach',
				subject: { k: 'target', index: crIdx },
				params: { attachObject: { k: 'target', index: eqIdx } },
				span
			},
			true
		);
		return true;
	}
	if (/^(?:then )?you may attach an Equipment you control to ~$/i.test(t)) {
		p.push(
			{
				verb: 'attach',
				subject: { k: 'self' },
				optional: { chooser: { k: 'you' } },
				params: {
					attachObject: { k: 'all', filter: { zone: 'battlefield', subtypes: ['Equipment'], controller: 'you' } },
					choiceCount: { k: 'const', n: 1 }
				},
				span
			},
			false
		);
		return true;
	}
	if (/^put ~'s counters on that creature and attach an Equipment that was attached to ~ to that creature$/i.test(t)) {
		const ref = p.itRef() ?? p.lastObject?.ref ?? { k: 'target', index: 0 };
		const sel = refToSelW11(ref);
		p.push({ verb: 'putCounters', subject: sel, params: { copyCountersFrom: { k: 'self' } }, span }, false);
		p.push({ verb: 'attach', subject: sel, params: { attachEquipmentFromSelfLki: true }, span }, false);
		return true;
	}
	if (
		/^return target creature card from your graveyard to the battlefield, then return up to two target Aura and\/or Equipment cards from your graveyard to the battlefield attached to that creature$/i.test(
			t
		)
	) {
		const crIdx = p.addTarget({
			kind: 'object',
			filter: { zone: 'graveyard', owner: 'you', types: ['Creature'] },
			min: 1,
			max: 1
		});
		const attIdx = p.addTarget({
			kind: 'object',
			filter: { zone: 'graveyard', owner: 'you', subtypes: ['Aura', 'Equipment'] },
			min: 0,
			max: 2
		});
		p.push(
			{
				verb: 'move',
				subject: { k: 'target', index: crIdx },
				params: { from: 'graveyard', to: 'battlefield', underYourControl: true },
				bindAs: 'moved',
				span
			},
			true
		);
		p.push(
			{
				verb: 'move',
				subject: { k: 'target', index: attIdx },
				params: {
					from: 'graveyard',
					to: 'battlefield',
					underYourControl: true,
					attachedToSelector: { k: 'target', index: crIdx }
				},
				span
			},
			true
		);
		return true;
	}

	// *Hellkite Courser* / *Command Beacon* / *Leadership Vacuum* / *Talon Gates of Madara* / *It That Betrays*
	if (/^you may put a commander you own from the command zone onto the battlefield$/i.test(t)) {
		p.push(
			{
				verb: 'move',
				subject: { k: 'all', filter: { zone: 'command', owner: 'you', isCommander: true } },
				optional: { chooser: { k: 'you' } },
				params: {
					from: 'command',
					to: 'battlefield',
					underYourControl: true,
					choiceCount: { k: 'const', n: 1 },
					upTo: true
				},
				bindAs: 'moved',
				span
			},
			false
		);
		p.lastObject = { ref: { k: 'binding', name: 'moved' }, stepIndex: p.steps.length - 1 };
		return true;
	}
	if (/^it gains haste$/i.test(t) && p.lastObject) {
		p.push(
			{
				verb: 'grant',
				subject: refToSelW11(p.lastObject.ref),
				params: { keywords: ['Haste'], duration: 'endOfTurn' },
				span
			},
			false
		);
		return true;
	}
	if (/^return it to the command zone at the beginning of the next end step$/i.test(t) && p.lastObject) {
		const ref = p.lastObject.ref;
		p.push(
			{
				verb: 'delayedTrigger',
				subject: NONE,
				delayed: {
					trigger: { event: 'phaseBegin', filter: { phase: 'end_step' }, scope: 'each_turn' },
					effect: [{ verb: 'move', subject: refToSelW11(ref), params: { to: 'command' }, span }]
				},
				span
			},
			false
		);
		return true;
	}
	if (/^put your commander into your hand from the command zone$/i.test(t)) {
		p.push(
			{
				verb: 'move',
				subject: { k: 'all', filter: { zone: 'command', owner: 'you', isCommander: true } },
				params: { from: 'command', to: 'hand', choiceCount: { k: 'const', n: 1 } },
				span
			},
			false
		);
		return true;
	}
	if (/^target player returns each commander they control from the battlefield to the command zone$/i.test(t)) {
		const idx = p.addTarget({ kind: 'player', filter: {}, player: { relation: 'any' }, min: 1, max: 1 });
		p.push(
			{
				verb: 'move',
				subject: {
					k: 'all',
					filter: { zone: 'battlefield', isCommander: true, controllerRef: { k: 'target', index: idx } }
				},
				params: { from: 'battlefield', to: 'command' },
				span
			},
			false
		);
		return true;
	}
	if (/^put ~ from your hand onto the battlefield$/i.test(t)) {
		p.push(
			{
				verb: 'move',
				subject: { k: 'self' },
				params: { from: 'hand', to: 'battlefield', underYourControl: true },
				span
			},
			false
		);
		return true;
	}
	if (/^put that card onto the battlefield under your control$/i.test(t)) {
		p.push(
			{
				verb: 'move',
				subject: { k: 'eventObject' },
				params: { to: 'battlefield', underYourControl: true },
				span
			},
			false
		);
		return true;
	}

	// *The Trickster-God's Heist* II: "You may exchange control of two target nonbasic, noncreature permanents that share a card type"
	if (/^you may exchange control of two target nonbasic, noncreature permanents that share a card type$/i.test(t)) {
		const f: ObjectFilter = { zone: 'battlefield', notSupertypes: ['Basic'], notTypes: ['Creature'] };
		const i0 = p.addTarget({ kind: 'object', filter: f, min: 1, max: 1 });
		const i1 = p.addTarget({ kind: 'object', filter: f, min: 1, max: 1, otherTarget: true, sharesCardTypeWithTargetIndex: i0 });
		p.push(
			{
				verb: 'exchange',
				subject: { k: 'target', index: i0 },
				optional: { chooser: { k: 'you' } },
				params: { exchangeSpec: { kind: 'control', second: { k: 'target', index: i1 } } },
				span
			},
			true
		);
		return true;
	}

	// *The Phasing of Zhalfir* I/II: "It can't phase in for as long as you control ~"
	if (/^it can't phase in for as long as you control ~$/i.test(t)) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'phaseOut') {
			prev.params = { ...prev.params, cantPhaseInWhileSourceControlled: true };
			return true;
		}
	}

	// *Palace Jailer*: "exile target creature an opponent controls until an opponent becomes the monarch"
	if (/^exile target creature an opponent controls until an opponent becomes the monarch$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'], controller: 'opponent' },
			min: 1,
			max: 1
		});
		p.push(
			{
				verb: 'exile',
				subject: { k: 'target', index: idx },
				params: { untilOpponentBecomesMonarch: true },
				span
			},
			true
		);
		return true;
	}

	// *Reins of Power*: "Untap all creatures you control and all creatures target opponent controls. You and that opponent each gain control of all creatures the other controls until end of turn. Those creatures gain haste until end of turn."
	if (/^untap all creatures you control and all creatures target opponent controls$/i.test(t)) {
		const idx = p.addTarget({ kind: 'player', filter: {}, player: { relation: 'opponent' }, min: 1, max: 1 });
		p.push(
			{ verb: 'untap', subject: { k: 'all', filter: { zone: 'battlefield', types: ['Creature'], controller: 'you' } }, span },
			false
		);
		p.push(
			{
				verb: 'untap',
				subject: { k: 'all', filter: { zone: 'battlefield', types: ['Creature'], controllerRef: { k: 'target', index: idx } } },
				span
			},
			false
		);
		p.lastPlayer = { k: 'target', index: idx };
		return true;
	}
	if (/^you and that opponent each gain control of all creatures the other controls until end of turn$/i.test(t)) {
		const oppRef = p.lastPlayer ?? { k: 'target', index: 0 };
		p.push(
			{
				verb: 'exchange',
				subject: YOU,
				params: {
					exchangeSpec: {
						kind: 'swapAllControlledCreatures',
						second: oppRef,
						duration: 'endOfTurn'
					}
				},
				bindAs: 'swapped',
				span
			},
			false
		);
		p.lastObject = { ref: { k: 'binding', name: 'swapped' }, stepIndex: p.steps.length - 1 };
		return true;
	}
	if (/^those creatures gain haste until end of turn$/i.test(t) && p.lastObject) {
		p.push(
			{
				verb: 'grant',
				subject: refToSelW11(p.lastObject.ref),
				params: { keywords: ['Haste'], duration: 'endOfTurn' },
				span
			},
			false
		);
		return true;
	}

	// *Gather Specimens*: "If a creature would enter the battlefield under an opponent's control this turn, it enters under your control instead"
	if (/^if a creature would enter the battlefield under an opponent's control this turn, it enters under your control instead$/i.test(t)) {
		p.push(
			{
				verb: 'grantPlayer',
				subject: YOU,
				params: { stealOpponentEnteringCreaturesUntilEndOfTurn: true },
				span
			},
			false
		);
		return true;
	}

	// *Endless Detour*: "The owner of target spell, nonland permanent, or card in a graveyard puts it on their choice of the top or bottom of their library"
	if (
		/^the owner of target spell, nonland permanent, or card in a graveyard puts it on their choice of the top or bottom of their library$/i.test(
			t
		)
	) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: ['stack', 'battlefield', 'graveyard'], notTypes: ['Land'] },
			zones: ['stack', 'battlefield', 'graveyard'],
			alsoSpells: true,
			min: 1,
			max: 1
		});
		p.push(
			{
				verb: 'move',
				subject: { k: 'target', index: idx },
				params: { to: 'library', position: 'topOrBottom', libraryChoiceBy: 'owner' },
				span
			},
			true
		);
		return true;
	}

	// *Desertion*: "If an artifact or creature spell is countered this way, put that card onto the battlefield under your control instead of into its owner's graveyard"
	if (
		/^if an artifact or creature spell is countered this way, put that card onto the battlefield under your control instead of into its owner's graveyard$/i.test(
			t
		)
	) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'counterSpell') {
			prev.params = { ...prev.params, onCounteredPutUnderYourControlFilter: { types: ['Artifact', 'Creature'] } };
			return true;
		}
	}

	// *Rod of Absorption*: "exile it instead of putting it into a graveyard as it resolves"
	if (/^exile it instead of putting it into a graveyard as it resolves$/i.test(t)) {
		p.push(
			{
				verb: 'grant',
				subject: { k: 'self' },
				params: { exileResolvingSpellToLinked: true, duration: 'endOfTurn' },
				span
			},
			false
		);
		return true;
	}

	// *Kogla and Yidaro*: "Shuffle ~ into your library from your graveyard, then draw a card"
	if (/^shuffle ~ into your library from your graveyard, then draw a card$/i.test(t)) {
		p.push({ verb: 'move', subject: { k: 'self' }, params: { from: 'graveyard', to: 'library' }, span }, false);
		p.push({ verb: 'draw', subject: YOU, amount: { k: 'const', n: 1 }, span }, false);
		return true;
	}

	// *Ever After*: "Put ~ on the bottom of its owner's library"
	if (/^put ~ on the bottom of its owner's library$/i.test(t)) {
		p.push({ verb: 'move', subject: { k: 'self' }, params: { to: 'library', position: 'bottom' }, span }, false);
		return true;
	}

	// *Continue?*: "Choose up to four target creature cards in your graveyard that were put there from the battlefield this turn. Return them to the battlefield."
	if (/^choose up to four target creature cards in your graveyard that were put there from the battlefield this turn$/i.test(t)) {
		p.addTarget({
			kind: 'object',
			filter: {
				zone: 'graveyard',
				owner: 'you',
				types: ['Creature'],
				enteredGraveyardFromBattlefieldThisTurn: true
			},
			min: 0,
			max: 4
		});
		p.lastObject = { ref: { k: 'target', index: p.targets.length - 1 }, stepIndex: p.steps.length - 1 };
		return true;
	}
	if (/^return them to the battlefield$/i.test(t) && p.lastObject) {
		p.push(
			{
				verb: 'move',
				subject: refToSelW11(p.lastObject.ref),
				params: { from: 'graveyard', to: 'battlefield', underYourControl: true },
				span
			},
			true
		);
		return true;
	}

	// *Rescue from the Underworld*: "Return that card and the sacrificed card to the battlefield under your control at the beginning of your next upkeep"
	if (/^return that card and the sacrificed card to the battlefield under your control at the beginning of your next upkeep$/i.test(t)) {
		p.push(
			{
				verb: 'delayedTrigger',
				subject: NONE,
				params: { returnTargetAndSacrificedAtUpkeep: true },
				delayed: {
					trigger: { event: 'phaseBegin', filter: { phase: 'upkeep' }, scope: 'controller_turn' },
					effect: [{ verb: 'move', subject: { k: 'target', index: 0 }, params: { from: 'graveyard', to: 'battlefield', underYourControl: true }, span }],
					nextTurn: true
				},
				span
			},
			false
		);
		return true;
	}

	// *Together Forever*: "When that creature dies this turn, return that card to its owner's hand"
	if (/^when that creature dies this turn, return that card to its owner's hand$/i.test(t) && p.lastObject) {
		const ref = p.lastObject.ref;
		p.push(
			{
				verb: 'delayedTrigger',
				subject: refToSelW11(ref),
				params: {
					registerWave9DelayedTrigger: { duration: 'thisTurn', bindSubjectAsWatched: true }
				},
				delayed: {
					trigger: { event: 'zoneChange', filter: { from: 'battlefield', to: 'graveyard', object: {} } },
					effect: [{ verb: 'move', subject: { k: 'eventObject' }, params: { from: 'graveyard', to: 'hand' }, span }]
				},
				span
			},
			false
		);
		return true;
	}

	// *Ugin, the Ineffable* +1: "Exile the top card of your library face down and look at it. Create a 2/2 colorless Spirit creature token. When that token leaves the battlefield, put the exiled card into your hand."
	if (/^exile the top card of your library face down and look at it$/i.test(t)) {
		p.push(
			{
				verb: 'exile',
				subject: { k: 'libraryTop' },
				amount: { k: 'const', n: 1 },
				params: { faceDown: true, lookOnly: true },
				bindAs: 'exiled',
				span
			},
			false
		);
		p.lastObject = { ref: { k: 'binding', name: 'exiled' }, stepIndex: p.steps.length - 1 };
		return true;
	}
	if (/^when that token leaves the battlefield, put the exiled card into your hand$/i.test(t)) {
		p.push(
			{
				verb: 'delayedTrigger',
				subject: { k: 'binding', name: 'created' },
				params: {
					registerWave9DelayedTrigger: { duration: 'untilYourNextTurn', bindSubjectAsWatched: true }
				},
				delayed: {
					trigger: { event: 'zoneChange', filter: { from: 'battlefield', object: {} } },
					effect: [{ verb: 'move', subject: { k: 'binding', name: 'exiled' }, params: { from: 'exile', to: 'hand' }, span }]
				},
				span
			},
			false
		);
		return true;
	}

	// *Hoarder's Greed* / *Insatiable Frugivore* / *Tyrant of Discord*:
	// "If you win, repeat this process." / "If you do, repeat this process." / "If a nonland permanent is sacrificed this way, repeat this process."
	const repeatM = t.match(/^(if .+?),\s*repeat this process$/i);
	if (repeatM && p.steps.length > 0) {
		const rHdr = repeatM[1].trim();
		const cond = /^if you win$/i.test(rHdr)
			? ({ k: 'wonClashThisWay' } as const)
			: /^if you do$/i.test(rHdr)
				? ({ k: 'didLastOptionalStep' } as const)
				: parseConditionWave11(p, rHdr, h);
		if (cond) {
			const startIdx = p.lastSentenceStepStart !== undefined ? 0 : 0;
			const bodySteps = p.steps.splice(startIdx);
			p.push(
				{
					verb: 'repeatSequence',
					subject: NONE,
					params: { repeatSequence: { steps: bodySteps, condition: cond, maxIterations: 20 } },
					span
				},
				false
			);
			return true;
		}
	}

	// *Tyrant of Discord*: "target opponent chooses a permanent they control at random and sacrifices it"
	if (/^target opponent chooses a permanent they control at random and sacrifices it$/i.test(t)) {
		const idx = p.addTarget({ kind: 'player', filter: {}, player: { relation: 'opponent' }, min: 1, max: 1 });
		p.push(
			{
				verb: 'sacrifice',
				subject: { k: 'all', filter: { zone: 'battlefield', controllerRef: { k: 'target', index: idx } } },
				actor: { k: 'target', index: idx },
				amount: { k: 'const', n: 1 },
				params: { atRandom: true },
				span
			},
			false
		);
		return true;
	}

	// *Plumb the Forbidden*: "When you do, copy ~ for each creature sacrificed this way"
	if (/^when you do, copy ~ for each creature sacrificed this way$/i.test(t)) {
		p.push(
			{
				verb: 'copySpell',
				subject: { k: 'self' },
				condition: { k: 'additionalCostPaidThisSpell' },
				params: { copySpellPerSacrificedCost: true, mayChooseNewTargets: true },
				span
			},
			false
		);
		return true;
	}

	// *Sevinne's Reclamation*: "If ~ was cast from a graveyard, you may copy ~ and may choose a new target for the copy"
	if (/^if ~ was cast from a graveyard, you may copy ~ and may choose a new target for the copy$/i.test(t)) {
		p.push(
			{
				verb: 'copySpell',
				subject: { k: 'self' },
				condition: { k: 'spellCastFromGraveyard' },
				optional: { chooser: { k: 'you' } },
				params: { count: { k: 'const', n: 1 }, mayChooseNewTargets: true },
				span
			},
			false
		);
		return true;
	}

	// *Tersa Lightshatter*: "exile a card at random from your graveyard"
	if (/^exile a card at random from your graveyard$/i.test(t)) {
		p.push(
			{
				verb: 'exile',
				subject: { k: 'all', filter: { zone: 'graveyard', owner: 'you' } },
				amount: { k: 'const', n: 1 },
				params: { atRandom: true },
				bindAs: 'exiled',
				span
			},
			false
		);
		p.lastObject = { ref: { k: 'binding', name: 'exiled' }, stepIndex: p.steps.length - 1 };
		return true;
	}

	// "You may exile it face down" + "Until end of turn, you may play cards exiled with ~. Spells you cast this way cost {2} less to cast."
	if (/^you may exile it face down$/i.test(t)) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'dig') {
			p.steps[p.steps.length - 1] = {
				verb: 'exile',
				subject: { k: 'libraryTop' },
				amount: { k: 'const', n: 1 },
				optional: { chooser: { k: 'you' } },
				params: { faceDown: true, lookOnly: true },
				bindAs: 'exiled',
				span: { start: prev.span.start, end: span.end }
			};
			p.lastObject = { ref: { k: 'binding', name: 'exiled' }, stepIndex: p.steps.length - 1 };
			return true;
		}
		const ref = p.lastObject?.ref ?? { k: 'binding', name: 'exiled' };
		p.push(
			{
				verb: 'exile',
				subject: refToSelW11(ref),
				optional: { chooser: { k: 'you' } },
				params: { faceDown: true },
				span
			},
			false
		);
		return true;
	}
	if (/^until end of turn, you may play cards exiled with ~$/i.test(t)) {
		p.push(
			{
				verb: 'grantPlayFromExile',
				subject: { k: 'all', filter: { zone: 'exile', exiledWithSelf: true } },
				params: { playFromExile: { duration: 'thisTurn' } },
				span
			},
			false
		);
		return true;
	}
	const costLessThisWayM = t.match(/^spells you cast this way cost \{(\d+)\} less to cast$/i);
	if (costLessThisWayM) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'grantPlayFromExile' && prev.params?.playFromExile) {
			prev.params.playFromExile = {
				...prev.params.playFromExile,
				costReductionGeneric: parseInt(costLessThisWayM[1], 10)
			};
			return true;
		}
	}

	// *Soul Partition*: "A spell cast by an opponent this way costs {2} more to cast"
	const oppTaxM = t.match(/^a spell cast by an opponent this way costs \{(\d+)\} more to cast$/i);
	if (oppTaxM) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'grantPlayFromExile') {
			prev.params = { ...prev.params, castSpellCostTaxForOpponents: parseInt(oppTaxM[1], 10) };
			return true;
		}
	}

	// *Lobelia*: "look at the top card of each opponent's library and exile those cards face down"
	if (/^look at the top card of each opponent's library and exile those cards face down$/i.test(t)) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachOpponent',
					loopSteps: [
						{
							verb: 'exile',
							subject: { k: 'libraryTop', player: { k: 'eachLoopPlayer' } },
							amount: { k: 'const', n: 1 },
							params: { faceDown: true },
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

	// *Etali, Primal Storm* / *Lobelia* / *Gix* / *Dauthi Voidwalker* / *Kefka* / *Author of Shadows* / *Blightwing Bandit* / *King Narfi's Betrayal* / *Summon: Esper Valigarmanda* / *Furious Rise* / *Mosswort Bridge* / *Spinerock Knoll* / *Windbrisk Heights* / *Fight Rigging* / *Neriv* / *Siphon Insight* / *Locke* / *Breaching Dragonstorm* / *In Search of Greatness* / *Mysterious Stranger* / *Hildibrand Manderville* / *Chainer* / *Conduit of Worlds*
	if (
		/^exile the top card of each player's library, then you may cast any number of spells from among those cards without paying their mana costs$/i.test(
			t
		)
	) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachPlayer',
					loopSteps: [
						{
							verb: 'exile',
							subject: { k: 'libraryTop', player: { k: 'eachLoopPlayer' } },
							amount: { k: 'const', n: 1 },
							bindAs: 'exiled',
							span
						}
					]
				},
				span
			},
			false
		);
		p.push(
			{
				verb: 'castFree',
				subject: { k: 'binding', name: 'exiled' },
				params: { castFreeSpec: { withoutPayingManaCost: true, upToCount: 99 }, castAnyNumberFromExiled: true },
				span
			},
			false
		);
		return true;
	}

	// Generic "You may (play|cast) (that card|the exiled card|a card exiled with ~|cards exiled with ~|...) [this turn|until ...|for as long as it remains exiled] [without paying ...]"
	const playExiledM = t.match(
		/^(?:(until end of turn|during any turn you attacked with a commander),\s+)?you may (play|cast) (?:((?:any number of )?spells from among )?(that card|those cards|the exiled card|cards exiled this way|a card exiled with ~|cards exiled with ~|an instant or sorcery card exiled with ~|a spell from among those cards|it))(?: (for as long as it remains exiled|until you exile another card with ~|this turn))?(?: (without paying (?:its|their) mana costs?))?(?:,\s*and (?:you may spend mana as though it were mana of any color|mana of any type can be spent) to cast (?:that spell|those spells|it))?$/i
	);
	if (playExiledM) {
		const isCastOnly = playExiledM[2].toLowerCase() === 'cast';
		const what = playExiledM[4].toLowerCase();
		const free = Boolean(playExiledM[6]);
		const anyColor = /any (?:color|type)/i.test(t);
		const durText = (playExiledM[1] ?? playExiledM[5] ?? 'this turn').toLowerCase();
		const dur = /remains exiled|exile another/i.test(durText) ? 'asLongAsExiled' : 'thisTurn';
		const exiledRef = !what.includes('exiled with ~') ? p.itRef() : null;
		const subj: Selector = what.includes('exiled with ~')
			? {
					k: 'all',
					filter: {
						zone: 'exile',
						exiledWithSelf: true,
						...(what.includes('instant or sorcery') ? { types: ['Instant', 'Sorcery'] } : {})
					}
				}
			: exiledRef
				? refToSelW11(exiledRef)
				: { k: 'binding', name: 'exiled' };

		if (free && (playExiledM[3] || what.includes('a card') || what.includes('the exiled card'))) {
			p.push(
				{
					verb: 'castFree',
					subject: subj,
					params: {
						castFreeSpec: {
							withoutPayingManaCost: true,
							upToCount: playExiledM[3] ? 99 : 1,
							...(what.includes('exiled with ~') ? { exiledWithSelf: true } : {})
						},
						...(playExiledM[3] ? { castAnyNumberFromExiled: true } : {})
					},
					span
				},
				false
			);
			return true;
		}
		p.push(
			{
				verb: 'grantPlayFromExile',
				subject: subj,
				params: {
					playFromExile: {
						duration: dur,
						...(isCastOnly ? { spellsOnly: true } : {}),
						...(free ? { withoutPayingManaCost: true } : {}),
						...(anyColor ? { spendManaAsAnyColor: true } : {})
					}
				},
				span
			},
			false
		);
		return true;
	}

	// *Dauthi Voidwalker*: "Choose an exiled card an opponent owns with a void counter on it. You may play it this turn without paying its mana cost."
	if (/^choose an exiled card an opponent owns with a void counter on it$/i.test(t)) {
		p.push(
			{
				verb: 'exile',
				subject: { k: 'all', filter: { zone: 'exile', owner: 'opponent', hasCounters: 'void' } },
				amount: { k: 'const', n: 1 },
				params: { choiceCount: { k: 'const', n: 1 } },
				bindAs: 'exiled',
				span
			},
			false
		);
		p.lastObject = { ref: { k: 'binding', name: 'exiled' }, stepIndex: p.steps.length - 1 };
		return true;
	}
	if (/^you may play it this turn without paying its mana cost$/i.test(t)) {
		p.push(
			{
				verb: 'grantPlayFromExile',
				subject: { k: 'binding', name: 'exiled' },
				params: { playFromExile: { duration: 'thisTurn', withoutPayingManaCost: true } },
				span
			},
			false
		);
		return true;
	}

	// *Gix*: "You may play lands and cast spells from among cards exiled this way without paying their mana costs"
	if (/^you may play lands and cast spells from among cards exiled this way without paying their mana costs$/i.test(t)) {
		p.push(
			{
				verb: 'grantPlayFromExile',
				subject: { k: 'binding', name: 'exiled' },
				params: { playFromExile: { duration: 'thisTurn', withoutPayingManaCost: true } },
				span
			},
			false
		);
		return true;
	}

	// *Author of Shadows*: "Choose a nonland card exiled this way"
	if (/^choose a nonland card exiled this way$/i.test(t)) {
		p.push(
			{
				verb: 'grantPlayFromExile',
				subject: { k: 'binding', name: 'exiled' },
				params: {
					moveFilter: { notTypes: ['Land'] },
					choiceCount: { k: 'const', n: 1 },
					playFromExile: { duration: 'asLongAsExiled', spellsOnly: true, spendManaAsAnyColor: true }
				},
				span
			},
			false
		);
		return true;
	}

	// *Blightwing Bandit*: "look at the top card of that player's library, then exile it face down"
	if (/^look at the top card of that player's library, then exile it face down$/i.test(t)) {
		p.push(
			{
				verb: 'exile',
				subject: { k: 'libraryTop', player: { k: 'activePlayer' } },
				amount: { k: 'const', n: 1 },
				params: { faceDown: true },
				bindAs: 'exiled',
				span
			},
			false
		);
		p.lastObject = { ref: { k: 'binding', name: 'exiled' }, stepIndex: p.steps.length - 1 };
		return true;
	}

	// *Breaching Dragonstorm*: "You may cast it without paying its mana cost if that spell's mana value is 8 or less. If you don't, put that card into your hand."
	if (/^you may cast it without paying its mana cost if that spell's mana value is (\d+) or less$/i.test(t)) {
		const maxMv = parseInt(t.match(/(\d+)/)![1], 10);
		p.push(
			{
				verb: 'castFree',
				subject: { k: 'binding', name: 'exiled' },
				optional: { chooser: { k: 'you' } },
				params: {
					castFreeSpec: {
						withoutPayingManaCost: true,
						filter: { manaValue: { op: '<=', value: { k: 'const', n: maxMv } } }
					}
				},
				span
			},
			false
		);
		return true;
	}
	if (/^if you don't, put that card into your hand$/i.test(t)) {
		const prevIdx = p.steps.length - 1;
		p.push(
			{
				verb: 'move',
				subject: { k: 'binding', name: 'exiled' },
				ifPrecedingDeclined: prevIdx,
				params: { from: 'exile', to: 'hand' },
				span
			},
			false
		);
		return true;
	}

	// *Siphon Insight*: "Look at the top two cards of target opponent's library. Exile one of them face down and put the other on the bottom of that library."
	if (/^look at the top two cards of target opponent's library$/i.test(t)) {
		const idx = p.addTarget({ kind: 'player', filter: {}, player: { relation: 'opponent' }, min: 1, max: 1 });
		p.push(
			{
				verb: 'dig',
				subject: { k: 'target', index: idx },
				amount: { k: 'const', n: 2 },
				params: {
					lookOnly: true,
					dig: { keep: 1, upTo: false, keepTo: 'exile', rest: 'libraryBottom' }
				},
				bindAs: 'exiled',
				span
			},
			false
		);
		p.lastPlayer = { k: 'target', index: idx };
		p.lastObject = { ref: { k: 'binding', name: 'exiled' }, stepIndex: p.steps.length - 1 };
		return true;
	}
	if (/^exile one of them face down and put the other on the bottom of that library$/i.test(t)) {
		return p.steps[p.steps.length - 1]?.verb === 'dig';
	}

	// *Chainer, Nightmare Adept* / *Conduit of Worlds* / *Hildibrand Manderville*
	if (/^you may cast a creature spell from your graveyard this turn$/i.test(t)) {
		p.push(
			{
				verb: 'grantGraveyardCast',
				subject: { k: 'all', filter: { zone: 'graveyard', owner: 'you', types: ['Creature'] } },
				params: { graveyardCastSpec: { duration: 'thisTurn' } },
				span
			},
			false
		);
		return true;
	}
	if (/^if you haven't cast a spell this turn, you may cast that card$/i.test(t) && p.lastObject) {
		p.push(
			{
				verb: 'grantGraveyardCast',
				subject: refToSelW11(p.lastObject.ref),
				condition: { k: 'noSpellCastThisTurn' },
				params: { graveyardCastSpec: { duration: 'thisTurn' } },
				span
			},
			false
		);
		return true;
	}
	if (/^if you do, you can't cast additional spells this turn$/i.test(t)) {
		p.push(
			{
				verb: 'grantPlayer',
				subject: YOU,
				params: { playerRules: ['cantCastAdditionalSpellsThisTurn'] },
				span
			},
			false
		);
		return true;
	}
	if (/^you may cast it from your graveyard as an Adventure until the end of your next turn$/i.test(t)) {
		p.push(
			{
				verb: 'grantGraveyardCast',
				subject: { k: 'self' },
				params: {
					graveyardCastSpec: { duration: 'untilEndOfYourNextTurn' },
					grantGraveyardAdventureUntilEndOfNextTurn: true
				},
				span
			},
			false
		);
		return true;
	}

	// *In Search of Greatness*: "you may cast a permanent spell from your hand with mana value equal to 1 plus the greatest mana value among other permanents you control without paying its mana cost. If you don't, scry 1."
	if (
		/^you may cast a permanent spell from your hand with mana value equal to 1 plus the greatest mana value among other permanents you control without paying its mana cost$/i.test(
			t
		)
	) {
		p.push(
			{
				verb: 'castFree',
				subject: {
					k: 'all',
					filter: {
						zone: 'hand',
						owner: 'you',
						types: ['Artifact', 'Creature', 'Enchantment', 'Planeswalker', 'Battle']
					}
				},
				optional: { chooser: { k: 'you' } },
				params: {
					castFreeSpec: {
						withoutPayingManaCost: true,
						upToCount: 1,
						totalMaxMv: {
							k: 'sum',
							args: [
								{ k: 'const', n: 1 },
								{ k: 'greatestStatAmong', filter: { zone: 'battlefield', other: true, controller: 'you' }, stat: 'manaValue' }
							]
						}
					}
				},
				span
			},
			false
		);
		return true;
	}
	if (/^if you don't, scry (\d+)$/i.test(t)) {
		const nVal = parseInt(t.match(/(\d+)/)![1], 10);
		p.push(
			{
				verb: 'scry',
				subject: YOU,
				amount: { k: 'const', n: nVal },
				ifPrecedingDeclined: p.steps.length - 1,
				span
			},
			false
		);
		return true;
	}

	// *Kefka*: "exile a card at random from each opponent's graveyard" + "Then each player who owns a spell you cast this way loses life equal to its mana value"
	if (/^exile a card at random from each opponent's graveyard$/i.test(t)) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachOpponent',
					loopSteps: [
						{
							verb: 'exile',
							subject: { k: 'all', filter: { zone: 'graveyard', ownerRef: { k: 'eachLoopPlayer' } } },
							amount: { k: 'const', n: 1 },
							params: { atRandom: true },
							bindAs: 'exiled',
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
	if (/^then each player who owns a spell you cast this way loses life equal to its mana value$/i.test(t)) {
		// Handled cleanly as optional follow-up or life loss tracking on bound exiled cast spells
		return true;
	}

	// *Mysterious Stranger*: "for each graveyard with an instant or sorcery card in it, exile target instant or sorcery card from that graveyard. If two or more cards are exiled this way, choose one of them at random and copy it."
	if (/^for each graveyard with an instant or sorcery card in it, exile target instant or sorcery card from that graveyard$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'graveyard', types: ['Instant', 'Sorcery'] },
			perOpponent: false,
			min: 0,
			max: 99
		});
		p.push(
			{
				verb: 'exile',
				subject: { k: 'target', index: idx },
				bindAs: 'exiled',
				span
			},
			true
		);
		p.lastObject = { ref: { k: 'binding', name: 'exiled' }, stepIndex: p.steps.length - 1 };
		return true;
	}
	if (/^if two or more cards are exiled this way, choose one of them at random and copy it$/i.test(t)) {
		p.push(
			{
				verb: 'castFree',
				subject: { k: 'binding', name: 'exiled' },
				condition: { k: 'exiledCountAtLeast', min: 2 },
				params: {
					castFreeSpec: { copyCardFirst: true, withoutPayingManaCost: true, upToCount: 1 },
					atRandom: true
				},
				span
			},
			false
		);
		return true;
	}

	// *Omenpath Journey*: "search your library for up to five land cards that have different names, exile them, then shuffle"
	if (/^search your library for up to five land cards that have different names, exile them, then shuffle$/i.test(t)) {
		p.push(
			{
				verb: 'search',
				subject: YOU,
				params: {
					search: {
						filter: { types: ['Land'] },
						count: 5,
						upTo: true,
						statedQuality: true,
						differentNames: true,
						destinations: [{ zone: 'exile' }],
						description: 'up to five land cards that have different names'
					}
				},
				span
			},
			false
		);
		return true;
	}
	if (/^choose a card at random exiled with ~ and put it onto the battlefield tapped$/i.test(t)) {
		p.push(
			{
				verb: 'move',
				subject: { k: 'all', filter: { zone: 'exile', exiledWithSelf: true } },
				params: { from: 'exile', to: 'battlefield', tapped: true, underYourControl: true, chooseAtRandomFromExiledWithSelf: true },
				span
			},
			false
		);
		return true;
	}

	// *Currency Converter*: "Whenever you discard a card, you may exile that card from your graveyard" + "Put a card exiled with ~ into its owner's graveyard"
	if (/^you may exile that card from your graveyard$/i.test(t)) {
		p.push(
			{
				verb: 'exile',
				subject: { k: 'eventObject' },
				optional: { chooser: { k: 'you' } },
				span
			},
			false
		);
		return true;
	}
	if (/^put a card exiled with ~ into its owner's graveyard$/i.test(t)) {
		p.push(
			{
				verb: 'move',
				subject: { k: 'all', filter: { zone: 'exile', exiledWithSelf: true } },
				params: { from: 'exile', to: 'graveyard', choiceCount: { k: 'const', n: 1 } },
				bindAs: 'moved',
				span
			},
			false
		);
		p.lastObject = { ref: { k: 'binding', name: 'moved' }, stepIndex: p.steps.length - 1 };
		return true;
	}

	// *Necropotence* / *Tinybones*: "exile that card from your graveyard" / "exile it from their graveyard with a stash counter on it"
	if (/^exile that card from your graveyard$/i.test(t)) {
		p.push({ verb: 'exile', subject: { k: 'eventObject' }, span }, false);
		return true;
	}
	if (/^exile it from their graveyard with a ([a-z]+) counter on it$/i.test(t)) {
		const cname = t.match(/with a ([a-z]+) counter/i)![1].toLowerCase() as CounterType;
		p.push(
			{
				verb: 'exile',
				subject: { k: 'eventObject' },
				params: { exileWithCounters: { counter: cname, count: 1 } },
				span
			},
			false
		);
		return true;
	}
	if (/^exile the top card of your library face down$/i.test(t)) {
		p.push(
			{
				verb: 'exile',
				subject: { k: 'libraryTop' },
				amount: { k: 'const', n: 1 },
				params: { faceDown: true },
				bindAs: 'exiled',
				span
			},
			false
		);
		p.lastObject = { ref: { k: 'binding', name: 'exiled' }, stepIndex: p.steps.length - 1 };
		return true;
	}
	if (/^put that card into your hand at the beginning of your next end step$/i.test(t)) {
		p.push(
			{
				verb: 'delayedTrigger',
				subject: NONE,
				delayed: {
					trigger: { event: 'phaseBegin', filter: { phase: 'end_step' }, scope: 'controller_turn' },
					effect: [{ verb: 'move', subject: { k: 'binding', name: 'exiled' }, params: { from: 'exile', to: 'hand' }, span }]
				},
				span
			},
			false
		);
		return true;
	}

	// *Azula, Cunning Usurper*: "target opponent exiles a nontoken creature they control, then they exile a nonland card from their graveyard"
	if (/^target opponent exiles a nontoken creature they control, then they exile a nonland card from their graveyard$/i.test(t)) {
		const idx = p.addTarget({ kind: 'player', filter: {}, player: { relation: 'opponent' }, min: 1, max: 1 });
		p.push(
			{
				verb: 'exile',
				subject: { k: 'all', filter: { zone: 'battlefield', types: ['Creature'], token: false, controllerRef: { k: 'target', index: idx } } },
				actor: { k: 'target', index: idx },
				amount: { k: 'const', n: 1 },
				params: { choiceCount: { k: 'const', n: 1 } },
				span
			},
			false
		);
		p.push(
			{
				verb: 'exile',
				subject: { k: 'all', filter: { zone: 'graveyard', notTypes: ['Land'], ownerRef: { k: 'target', index: idx } } },
				actor: { k: 'target', index: idx },
				amount: { k: 'const', n: 1 },
				params: { choiceCount: { k: 'const', n: 1 } },
				span
			},
			false
		);
		return true;
	}

	// *Oblivion Sower*: "target opponent exiles the top four cards of their library, then you may put any number of land cards that player owns from exile onto the battlefield under your control"
	if (/^target opponent exiles the top (\S+) cards of their library, then you may put any number of land cards that player owns from exile onto the battlefield under your control$/i.test(t)) {
		const m = t.match(/top (\S+) cards/i)!;
		const amt = h.amountWord(p, m[1]) ?? { k: 'const', n: 4 };
		const idx = p.addTarget({ kind: 'player', filter: {}, player: { relation: 'opponent' }, min: 1, max: 1 });
		p.push({ verb: 'exile', subject: { k: 'libraryTop', player: { k: 'target', index: idx } }, amount: amt, span }, false);
		p.push(
			{
				verb: 'move',
				subject: { k: 'all', filter: { zone: 'exile', types: ['Land'], ownerRef: { k: 'target', index: idx }, exiledByAnyPlayer: true } },
				optional: { chooser: { k: 'you' } },
				params: { from: 'exile', to: 'battlefield', underYourControl: true, choiceCount: { k: 'const', n: 99 }, upTo: true },
				span
			},
			false
		);
		return true;
	}

	// *Summon: Esper Valigarmanda* I & *King Narfi's Betrayal* I:
	if (/^exile an instant or sorcery card from each graveyard$/i.test(t) || /^then you may exile a creature or planeswalker card from each graveyard$/i.test(t)) {
		const isInstantSorc = /instant or sorcery/i.test(t);
		const isMay = /you may/i.test(t);
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				...(isMay ? { optional: { chooser: { k: 'you' } } } : {}),
				params: {
					loopPlayers: 'eachPlayer',
					loopSteps: [
						{
							verb: 'exile',
							subject: {
								k: 'all',
								filter: {
									zone: 'graveyard',
									ownerRef: { k: 'eachLoopPlayer' },
									types: isInstantSorc ? ['Instant', 'Sorcery'] : ['Creature', 'Planeswalker']
								}
							},
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

	// *Winds of Abandon* / *Boseiju* / *Celebrate the Harvest* / *Nissa's Pilgrimage* / *Verdant Mastery* / *Scholar of New Horizons* / *Descendants' Fury* / *Yuna's Whistle* / *Zimone's Experiment* / *Ripples of Undeath* / *Kindred Summons* / *Selvala, Explorer Returned*
	if (/^for each creature exiled this way, its controller searches their library for a basic land card$/i.test(t)) {
		const ref = p.lastObject?.ref ?? { k: 'target', index: 0 };
		p.push(
			{
				verb: 'search',
				subject: { k: 'playerRef', ref: { k: 'controllerOf', of: ref } },
				actor: { k: 'controllerOf', of: ref },
				params: {
					search: {
						filter: { supertypes: ['Basic'], types: ['Land'] },
						count: 1,
						upTo: true,
						statedQuality: true,
						destinations: [{ zone: 'battlefield', tapped: true }],
						targetControllerAsActor: true,
						description: 'a basic land card'
					}
				},
				span
			},
			false
		);
		return true;
	}
	if (/^those players put those cards onto the battlefield tapped, then shuffle$/i.test(t)) {
		return p.steps[p.steps.length - 1]?.verb === 'search';
	}
	if (/^that player may search their library for a land card with a basic land type, put it onto the battlefield, then shuffle$/i.test(t)) {
		const ref = p.lastObject?.ref ?? { k: 'target', index: 0 };
		p.push(
			{
				verb: 'search',
				subject: { k: 'playerRef', ref: { k: 'controllerOf', of: ref } },
				actor: { k: 'controllerOf', of: ref },
				optional: { chooser: { k: 'controllerOf', of: ref } },
				params: {
					search: {
						filter: { types: ['Land'], subtypes: ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'] },
						count: 1,
						upTo: true,
						statedQuality: true,
						destinations: [{ zone: 'battlefield' }],
						targetControllerAsActor: true,
						description: 'a land card with a basic land type'
					}
				},
				span
			},
			false
		);
		return true;
	}
	if (
		/^search your library for up to X basic land cards, where X is the number of different powers among creatures you control$/i.test(
			t
		)
	) {
		p.push(
			{
				verb: 'search',
				subject: YOU,
				amount: { k: 'distinctPowersControlled' },
				params: {
					search: {
						filter: { supertypes: ['Basic'], types: ['Land'] },
						count: 99,
						upTo: true,
						statedQuality: true,
						destinations: [{ zone: 'battlefield', tapped: true }],
						description: 'basic land cards'
					}
				},
				span
			},
			false
		);
		return true;
	}
	if (/^put those cards onto the battlefield tapped, then shuffle$/i.test(t) && p.steps[p.steps.length - 1]?.verb === 'search') {
		return true;
	}
	if (/^search your library for up to (two|three) basic Forest cards, reveal those cards, and put one onto the battlefield tapped and the rest into your hand$/i.test(t)) {
		const cnt = /three/i.test(t) ? 3 : 2;
		p.push(
			{
				verb: 'search',
				subject: YOU,
				params: {
					search: {
						filter: { supertypes: ['Basic'], types: ['Land'], subtypes: ['Forest'] },
						count: cnt,
						upTo: true,
						statedQuality: true,
						reveal: true,
						destinations: [{ zone: 'battlefield', tapped: true }, { zone: 'hand' }],
						description: 'basic Forest cards'
					}
				},
				span
			},
			false
		);
		return true;
	}
	if (/^if there are two or more instant and\/or sorcery cards in your graveyard, search your library for up to three basic Forest cards instead of two$/i.test(t)) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'search' && prev.params?.search) {
			prev.amount = {
				k: 'conditional',
				condition: {
					k: 'compare',
					left: { k: 'count', of: { zone: 'graveyard', owner: 'you', types: ['Instant', 'Sorcery'] } },
					op: '>=',
					right: { k: 'const', n: 2 }
				},
				then: { k: 'const', n: 3 },
				else: { k: 'const', n: 2 }
			};
			return true;
		}
	}
	if (/^search your library for up to four basic land cards and reveal them$/i.test(t)) {
		p.push(
			{
				verb: 'search',
				subject: YOU,
				params: {
					search: {
						filter: { supertypes: ['Basic'], types: ['Land'] },
						count: 4,
						upTo: true,
						statedQuality: true,
						reveal: true,
						destinations: [{ zone: 'battlefield', tapped: true }, { zone: 'battlefield', tapped: true }, { zone: 'hand' }],
						description: 'up to four basic land cards'
					}
				},
				span
			},
			false
		);
		return true;
	}
	if (
		/^put one of them onto the battlefield tapped under an opponent's control if the \{3\}\{G\} cost was paid$/i.test(t) ||
		/^put two of them onto the battlefield tapped under your control and the rest into your hand$/i.test(t)
	) {
		return p.steps[p.steps.length - 1]?.verb === 'search';
	}
	if (/^search your library for a Plains card and reveal it$/i.test(t)) {
		p.push(
			{
				verb: 'search',
				subject: YOU,
				params: {
					search: {
						filter: { types: ['Land'], subtypes: ['Plains'] },
						count: 1,
						upTo: true,
						statedQuality: true,
						reveal: true,
						destinations: [{ zone: 'hand' }],
						description: 'a Plains card'
					}
				},
				bindAs: 'searched',
				span
			},
			false
		);
		return true;
	}
	if (/^if an opponent controls more lands than you, you may put that card onto the battlefield tapped$/i.test(t)) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'search' && prev.params?.search) {
			prev.params.search = {
				...prev.params.search,
				destinations: [{ zone: 'battlefield', tapped: true }]
			};
			return true;
		}
	}
	if (/^if you don't put the card onto the battlefield, put it into your hand$/i.test(t)) {
		return p.steps.some((s) => s.verb === 'search');
	}

	// *Descendants' Fury*: "you may sacrifice one of them. If you do, reveal cards from the top of your library until you reveal a creature card that shares a creature type with the sacrificed creature. Put that card onto the battlefield and the rest on the bottom of your library in a random order."
	if (/^you may sacrifice one of them$/i.test(t)) {
		p.push(
			{
				verb: 'sacrifice',
				subject: { k: 'all', filter: { zone: 'battlefield', types: ['Creature'], controller: 'you' } },
				optional: { chooser: { k: 'you' } },
				amount: { k: 'const', n: 1 },
				bindAs: 'sacrificed',
				span
			},
			false
		);
		p.lastOptionalStep = p.steps.length - 1;
		p.lastObject = { ref: { k: 'binding', name: 'sacrificed' }, stepIndex: p.steps.length - 1 };
		return true;
	}
	if (/^if you do, reveal cards from the top of your library until you reveal a creature card that shares a creature type with the sacrificed creature$/i.test(t)) {
		p.push(
			{
				verb: 'dig',
				subject: YOU,
				amount: { k: 'const', n: 1 },
				ifPrecedingAccepted: p.steps.length - 1,
				params: {
					dig: {
						keep: 1,
						upTo: false,
						keepTo: 'battlefield',
						rest: 'libraryBottom',
						restRandom: true,
						untilFilter: { types: ['Creature'], sharesCreatureTypeWithSelf: true }
					}
				},
				bindAs: 'revealed',
				span
			},
			false
		);
		return true;
	}
	if (/^put that card onto the battlefield and the rest on the bottom of your library in a random order$/i.test(t)) {
		return p.steps[p.steps.length - 1]?.verb === 'dig';
	}

	// *Yuna's Whistle*: "When you reveal a creature card this way, put X +1/+1 counters on target creature you control, where X is the mana value of that card."
	if (
		/^when you reveal a creature card this way, put X \+1\/\+1 counters on target creature you control, where X is the mana value of that card$/i.test(
			t
		)
	) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'], controller: 'you' },
			min: 1,
			max: 1
		});
		p.push(
			{
				verb: 'putCounters',
				subject: { k: 'target', index: idx },
				amount: { k: 'stat', of: { k: 'binding', name: 'revealed' }, stat: 'manaValue' },
				condition: { k: 'didRevealThisWay' },
				params: { counter: '+1/+1' },
				span
			},
			true
		);
		return true;
	}

	// *Zimone's Experiment*: "You may reveal up to two creature and/or land cards from among them, then put the rest on the bottom of your library in a random order. Put all land cards revealed this way onto the battlefield tapped and put all creature cards revealed this way into your hand."
	if (/^you may reveal up to two creature and\/or land cards from among them, then put the rest on the bottom of your library in a random order$/i.test(t)) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'dig') {
			prev.params = {
				...prev.params,
				dig: {
					keep: 2,
					upTo: true,
					keepFilter: { types: ['Creature', 'Land'] },
					keepTo: 'hand',
					rest: 'libraryBottom',
					restRandom: true,
					revealKept: true,
					destinationBuckets: [
						{ filter: { types: ['Land'] }, destination: 'battlefield', tapped: true },
						{ filter: { types: ['Creature'] }, destination: 'hand' }
					]
				}
			};
			return true;
		}
	}
	if (/^put all land cards revealed this way onto the battlefield tapped and put all creature cards revealed this way into your hand$/i.test(t)) {
		return p.steps[p.steps.length - 1]?.verb === 'dig';
	}

	// *Ripples of Undeath*: "Then you may pay {1} and 3 life. If you do, put a card from among those cards into your hand."
	if (/^then you may pay \{1\} and 3 life$/i.test(t)) {
		p.push(
			{
				verb: 'payCost',
				subject: YOU,
				optional: {
					chooser: { k: 'you' },
					cost: [{ k: 'mana', cost: '{1}' }, { k: 'payLife', amount: { k: 'const', n: 3 } }]
				},
				span
			},
			false
		);
		p.lastOptionalStep = p.steps.length - 1;
		return true;
	}
	if (/^if you do, put a card from among those cards into your hand$/i.test(t)) {
		const ref = p.lastObject?.ref ?? { k: 'binding', name: 'milled' };
		p.push(
			{
				verb: 'move',
				subject: refToSelW11(ref),
				ifPrecedingAccepted: p.steps.length - 1,
				params: { from: 'graveyard', to: 'hand', choiceCount: { k: 'const', n: 1 } },
				span
			},
			false
		);
		return true;
	}

	// *Kindred Summons*: "Choose a creature type. Reveal cards from the top of your library until you reveal X creature cards of the chosen type, where X is the number of creatures you control of that type. Put those cards onto the battlefield, then shuffle the rest of the revealed cards into your library."
	if (/^reveal cards from the top of your library until you reveal X creature cards of the chosen type, where X is the number of creatures you control of that type$/i.test(t)) {
		const cnt: Amount = { k: 'count', of: { zone: 'battlefield', types: ['Creature'], controller: 'you', ofChosenType: true } };
		p.push(
			{
				verb: 'dig',
				subject: YOU,
				amount: cnt,
				params: {
					dig: {
						keep: 99,
						upTo: false,
						keepTo: 'battlefield',
						rest: 'libraryBottom',
						shuffleRest: true,
						untilFilter: { types: ['Creature'], ofChosenType: true }
					}
				},
				span
			},
			false
		);
		return true;
	}
	if (/^put those cards onto the battlefield, then shuffle the rest of the revealed cards into your library$/i.test(t)) {
		return p.steps[p.steps.length - 1]?.verb === 'dig';
	}

	// *Selvala, Explorer Returned*: "Each player reveals the top card of their library. For each nonland card revealed this way, add {G} and you gain 1 life."
	if (/^each player reveals the top card of their library$/i.test(t)) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachPlayer',
					loopSteps: [{ verb: 'reveal', subject: { k: 'libraryTop', player: { k: 'eachLoopPlayer' } }, amount: { k: 'const', n: 1 }, span }]
				},
				span
			},
			false
		);
		return true;
	}
	if (/^for each nonland card revealed this way, add \{G\} and you gain 1 life$/i.test(t)) {
		const amt: Amount = { k: 'countedThisWay', kind: 'nonlandRevealedThisWay' };
		p.push({ verb: 'addMana', subject: YOU, amount: amt, params: { mana: ['G'] }, span }, false);
		p.push({ verb: 'gainLife', subject: YOU, amount: amt, span }, false);
		return true;
	}

	// *Colossal Grave-Reaver*: "put one of them onto the battlefield"
	if (/^put one of them onto the battlefield$/i.test(t)) {
		p.push(
			{
				verb: 'move',
				subject: { k: 'eventObject' },
				params: { from: 'graveyard', to: 'battlefield', underYourControl: true, choiceCount: { k: 'const', n: 1 } },
				span
			},
			false
		);
		return true;
	}

	// *Broodcaller Scourge*: "you may put a permanent card with mana value less than or equal to that damage from your hand onto the battlefield"
	if (/^you may put a permanent card with mana value less than or equal to that damage from your hand onto the battlefield$/i.test(t)) {
		p.push(
			{
				verb: 'move',
				subject: {
					k: 'all',
					filter: {
						zone: 'hand',
						owner: 'you',
						types: ['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle'],
						manaValueLteEventAmount: true
					}
				},
				optional: { chooser: { k: 'you' } },
				params: { from: 'hand', to: 'battlefield', underYourControl: true, choiceCount: { k: 'const', n: 1 }, upTo: true },
				span
			},
			false
		);
		return true;
	}

	// *Fear of Burning Alive*: "~ deals that amount of damage to target creature that player controls"
	if (/^~ deals that amount of damage to target creature that player controls$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'], controllerRef: { k: 'eventPlayer' } },
			min: 1,
			max: 1
		});
		p.push({ verb: 'damage', subject: { k: 'target', index: idx }, amount: { k: 'eventAmount' }, span }, true);
		return true;
	}

	// *Blood Seeker*: "you may have that player lose 1 life"
	if (/^you may have that player lose (\d+) life$/i.test(t)) {
		const amt = parseInt(t.match(/(\d+)/)![1], 10);
		p.push(
			{
				verb: 'loseLife',
				subject: { k: 'playerRef', ref: { k: 'eventPlayer' } },
				optional: { chooser: { k: 'you' } },
				amount: { k: 'const', n: amt },
				span
			},
			false
		);
		return true;
	}

	// *Guardian of Tazeem*: "If that land is an Island, that creature doesn't untap during its controller's next untap step"
	if (/^if that land is an Island, that creature doesn't untap during its controller's next untap step$/i.test(t)) {
		const ref = p.lastObject?.ref ?? { k: 'target', index: 0 };
		p.push(
			{
				verb: 'freezeUntap',
				subject: refToSelW11(ref),
				condition: { k: 'matchesFilter', target: { k: 'eventObject' }, filter: { subtypes: ['Island'] } },
				span
			},
			true
		);
		return true;
	}

	// *Hammerhead Tyrant*: "return up to one target nonland permanent an opponent controls with mana value less than or equal to that spell's mana value to its owner's hand"
	if (/^return up to one target nonland permanent an opponent controls with mana value less than or equal to that spell's mana value to its owner's hand$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', notTypes: ['Land'], controller: 'opponent', manaValueLteEventObject: true },
			min: 0,
			max: 1
		});
		p.push({ verb: 'bounce', subject: { k: 'target', index: idx }, span }, true);
		return true;
	}

	// *Comet Storm*: "Choose any target, then choose another target for each time ~ was kicked. ~ deals X damage to each of them."
	if (/^choose any target, then choose another target for each time ~ was kicked$/i.test(t)) {
		p.addTarget({
			kind: 'objectOrPlayer',
			filter: { zone: 'battlefield', types: ['Creature', 'Planeswalker', 'Battle'] },
			player: { relation: 'any' },
			min: 1,
			max: 99,
			dynamicCount: { k: 'sum', args: [{ k: 'const', n: 1 }, { k: 'kickedCount' }] }
		});
		p.lastObject = { ref: { k: 'target', index: p.targets.length - 1 }, stepIndex: p.steps.length - 1 };
		return true;
	}
	if (/^~ deals X damage to each of them$/i.test(t)) {
		p.push({ verb: 'damage', subject: { k: 'target', index: 0 }, amount: { k: 'x' }, span }, true);
		return true;
	}

	// *Decimate*: "Destroy target artifact, target creature, target enchantment, and target land"
	if (/^destroy target artifact, target creature, target enchantment, and target land$/i.test(t)) {
		for (const tp of ['Artifact', 'Creature', 'Enchantment', 'Land']) {
			const idx = p.addTarget({ kind: 'object', filter: { zone: 'battlefield', types: [tp] }, min: 1, max: 1 });
			p.push({ verb: 'destroy', subject: { k: 'target', index: idx }, span }, true);
		}
		return true;
	}

	// *Everything Pizza*: "Each of your opponents discards a card"
	if (/^each of your opponents discards a card$/i.test(t)) {
		p.push({ verb: 'discard', subject: { k: 'player', filter: { relation: 'each_opponent' } }, amount: { k: 'const', n: 1 }, span }, false);
		return true;
	}

	// *Gleaming Splendor*: "Two target players each draw a card"
	if (/^two target players each draw a card$/i.test(t)) {
		const idx = p.addTarget({ kind: 'player', filter: {}, player: { relation: 'any' }, min: 2, max: 2 });
		p.push({ verb: 'draw', subject: { k: 'target', index: idx }, amount: { k: 'const', n: 1 }, span }, false);
		return true;
	}

	// *Suspended Sentence*: only fallback when no punisher/loop or standard player ref context exists
	if (
		/^that player loses (\d+) life$/i.test(t) &&
		p.context !== 'triggered' &&
		!p.lastPlayer &&
		p.lastObject &&
		!p.steps.some((st) => st.verb === 'punisherChoice' || st.verb === 'forEachPlayerLoop')
	) {
		const nVal = parseInt(t.match(/(\d+)/)![1], 10);
		const pr: PlayerRef = { k: 'controllerOf', of: p.lastObject.ref };
		p.push({ verb: 'loseLife', subject: { k: 'playerRef', ref: pr }, amount: { k: 'const', n: nVal }, span }, false);
		return true;
	}

	// *Calamity of the Titans* / *Titan's Presence*
	if (/^exile each creature and planeswalker with mana value less than the revealed card's mana value$/i.test(t)) {
		p.push(
			{
				verb: 'exile',
				subject: {
					k: 'all',
					filter: { zone: 'battlefield', types: ['Creature', 'Planeswalker'], manaValueLtRevealedCostCard: true }
				},
				span
			},
			true
		);
		return true;
	}
	if (/^exile target creature if its power is less than or equal to the revealed card's power$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'] },
			min: 1,
			max: 1
		});
		p.push(
			{
				verb: 'exile',
				subject: { k: 'target', index: idx },
				params: { moveFilter: { powerLteRevealedCostCard: true } },
				span
			},
			true
		);
		return true;
	}

	// *Desecrate Reality*: "For each opponent, exile up to one target permanent that player controls with an even mana value" + "If at least three colorless mana was spent to cast ~, return a permanent card with an odd mana value from your graveyard to the battlefield"
	if (/^for each opponent, exile up to one target permanent that player controls with an even mana value$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', controller: 'opponent', manaValueParity: 'even' },
			perOpponent: true,
			min: 0,
			max: 99
		});
		p.push({ verb: 'exile', subject: { k: 'target', index: idx }, span }, true);
		return true;
	}
	if (/^if at least three colorless mana was spent to cast ~, return a permanent card with an odd mana value from your graveyard to the battlefield$/i.test(t)) {
		p.push(
			{
				verb: 'move',
				subject: { k: 'all', filter: { zone: 'graveyard', owner: 'you', manaValueParity: 'odd' } },
				condition: { k: 'sameColorManaSpentAtLeast', min: 3, color: 'C' },
				params: { from: 'graveyard', to: 'battlefield', underYourControl: true, choiceCount: { k: 'const', n: 1 } },
				span
			},
			false
		);
		return true;
	}

	// *Parapet Thrasher* bullets
	if (/^destroy target artifact that opponent controls$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Artifact'], controllerRef: { k: 'eventPlayer' } },
			min: 1,
			max: 1
		});
		p.push({ verb: 'destroy', subject: { k: 'target', index: idx }, span }, true);
		return true;
	}
	if (/^~ deals (\d+) damage to each other opponent$/i.test(t)) {
		const dmg = parseInt(t.match(/(\d+)/)![1], 10);
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachOpponent',
					excludeEventPlayer: true,
					loopSteps: [{ verb: 'damage', subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } }, amount: { k: 'const', n: dmg }, span }]
				},
				span
			},
			false
		);
		return true;
	}

	// *SOLDIER Military Program*: "Put a +1/+1 counter on each of up to two Soldiers you control"
	if (/^put a \+1\/\+?1 counter on each of up to two Soldiers you control$/i.test(t)) {
		p.push(
			{
				verb: 'putCounters',
				subject: { k: 'all', filter: { zone: 'battlefield', subtypes: ['Soldier'], controller: 'you' } },
				amount: { k: 'const', n: 1 },
				params: { counter: '+1/+1', choiceCount: { k: 'const', n: 2 }, upTo: true },
				span
			},
			false
		);
		return true;
	}

	// *Terastodon*: "For each permanent put into a graveyard this way, its controller creates a 3/3 green Elephant creature token"
	if (/^for each permanent put into a graveyard this way, its controller creates a 3\/3 green Elephant creature token$/i.test(t)) {
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
							amount: { k: 'countedThisWay', kind: 'destroyedControlledByPlayerThisWay' },
							params: { token: h.buildTokenSpec(3, 3, 'green Elephant', '') },
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

	// *Temur Battle Rage*: "That creature also gains trample until end of turn if you control a creature with power 4 or greater"
	if (/^that creature also gains trample until end of turn if you control a creature with power 4 or greater$/i.test(t)) {
		const ref = p.lastObject?.ref ?? { k: 'target', index: 0 };
		p.push(
			{
				verb: 'grant',
				subject: refToSelW11(ref),
				condition: { k: 'controlsFilter', filter: { zone: 'battlefield', types: ['Creature'], power: { op: '>=', value: { k: 'const', n: 4 } } } },
				params: { keywords: ['Trample'], duration: 'endOfTurn' },
				span
			},
			false
		);
		return true;
	}

	// *Ultimate Magic: Meteor*: "If ~ was cast from exile, for each opponent, choose an artifact or land that player controls" + "Destroy the chosen permanents"
	if (/^for each opponent, choose an artifact or land that player controls$/i.test(t)) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachOpponent',
					loopSteps: [
						{
							verb: 'destroy',
							subject: { k: 'all', filter: { zone: 'battlefield', types: ['Artifact', 'Land'], controllerRef: { k: 'eachLoopPlayer' } } },
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
	if (/^destroy the chosen permanents$/i.test(t)) {
		return p.steps[p.steps.length - 1]?.verb === 'forEachPlayerLoop';
	}

	// *Windgrace's Judgment*: "For any number of opponents, destroy target nonland permanent that player controls"
	if (/^for any number of opponents, destroy target nonland permanent that player controls$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', notTypes: ['Land'], controller: 'opponent' },
			perOpponent: true,
			min: 0,
			max: 99
		});
		p.push({ verb: 'destroy', subject: { k: 'target', index: idx }, span }, true);
		return true;
	}

	// *Worldsoul's Rage*: "Put up to X land cards from your hand and/or graveyard onto the battlefield tapped"
	if (/^put up to X land cards from your hand and\/or graveyard onto the battlefield tapped$/i.test(t)) {
		p.push(
			{
				verb: 'move',
				subject: { k: 'all', filter: { zone: ['hand', 'graveyard'], owner: 'you', types: ['Land'] } },
				amount: { k: 'x' },
				params: { to: 'battlefield', tapped: true, underYourControl: true, choiceCount: { k: 'x' }, upTo: true },
				span
			},
			false
		);
		return true;
	}

	// *Dread Tiller*: "you may put a land card from your hand or graveyard onto the battlefield tapped"
	if (/^you may put a land card from your hand or graveyard onto the battlefield tapped$/i.test(t)) {
		p.push(
			{
				verb: 'move',
				subject: { k: 'all', filter: { zone: ['hand', 'graveyard'], owner: 'you', types: ['Land'] } },
				optional: { chooser: { k: 'you' } },
				params: { to: 'battlefield', tapped: true, underYourControl: true, choiceCount: { k: 'const', n: 1 }, upTo: true },
				span
			},
			false
		);
		return true;
	}

	// *Loamcrafter Faun*: "you may discard one or more land cards. When you do, return up to that many target nonland permanent cards from your graveyard to your hand."
	if (/^you may discard one or more land cards$/i.test(t)) {
		p.push(
			{
				verb: 'discard',
				subject: YOU,
				optional: { chooser: { k: 'you' } },
				amount: { k: 'const', n: 99 },
				params: { moveFilter: { types: ['Land'] }, upTo: true },
				span
			},
			false
		);
		return true;
	}
	if (/^when you do, return up to that many target nonland permanent cards from your graveyard to your hand$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'graveyard', owner: 'you', notTypes: ['Land'] },
			min: 0,
			max: 99,
			dynamicCount: { k: 'countedThisWay', kind: 'discardedThisWay' },
			dynamicUpTo: true
		});
		p.push(
			{
				verb: 'move',
				subject: { k: 'target', index: idx },
				ifPrecedingAccepted: p.steps.length - 1,
				params: { from: 'graveyard', to: 'hand' },
				span
			},
			true
		);
		return true;
	}

	// *Malfegor*: "Each opponent sacrifices a creature of their choice for each card discarded this way"
	if (/^each opponent sacrifices a creature of their choice for each card discarded this way$/i.test(t)) {
		p.push(
			{
				verb: 'sacrifice',
				subject: { k: 'all', filter: { zone: 'battlefield', types: ['Creature'] } },
				actor: { k: 'eachLoopPlayer' },
				amount: { k: 'countedThisWay', kind: 'discardedThisWay' },
				span
			},
			false
		);
		// Wrap as forEachPlayerLoop eachOpponent
		const sacStep = p.steps.pop()!;
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: { loopPlayers: 'eachOpponent', loopSteps: [sacStep] },
				span
			},
			false
		);
		return true;
	}

	// *Martial Impetus*: "each other creature that's attacking one of your opponents gets +1/+1 until end of turn"
	if (/^each other creature that's attacking one of your opponents gets \+1\/\+?1 until end of turn$/i.test(t)) {
		p.push(
			{
				verb: 'pump',
				subject: { k: 'all', filter: { zone: 'battlefield', types: ['Creature'], attacking: true, other: true } },
				amount: { k: 'const', n: 1 },
				params: { toughness: { k: 'const', n: 1 }, duration: 'endOfTurn' },
				span
			},
			true
		);
		return true;
	}

	// *Selective Obliteration*: "Each player chooses a color. Then exile each permanent unless it's colorless or it's only the color its controller chose."
	if (/^each player chooses a color$/i.test(t)) {
		p.push({ verb: 'chooseDesignation', subject: NONE, params: { chooseKind: 'color' }, span }, false);
		return true;
	}
	if (/^then exile each permanent unless it's colorless or it's only the color its controller chose$/i.test(t)) {
		p.push(
			{
				verb: 'exile',
				subject: { k: 'all', filter: { zone: 'battlefield', isColored: true } },
				span
			},
			true
		);
		return true;
	}

	// *Twins of Discord*: "choose odd or even. Creatures with mana value of that quality can't block this turn."
	if (/^choose odd or even$/i.test(t)) {
		p.push(
			{
				verb: 'combatRestriction',
				subject: NONE,
				params: { chooseOddOrEvenCantBlockThisTurn: true, duration: 'endOfTurn' },
				span
			},
			false
		);
		return true;
	}
	if (/^creatures with mana value of that quality can't block this turn$/i.test(t)) {
		return p.steps[p.steps.length - 1]?.verb === 'combatRestriction';
	}

	// *The Horus Heresy* III: "Starting with you, each player chooses a creature. Destroy each creature chosen this way."
	if (/^starting with you, each player chooses a creature$/i.test(t)) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'turnOrderStartingWithYou',
					chooseObjectToBind: { filter: { zone: 'battlefield', types: ['Creature'] } }
				},
				bindAs: 'chosen_by_loop',
				span
			},
			false
		);
		return true;
	}
	if (/^destroy each creature chosen this way$/i.test(t)) {
		p.push({ verb: 'destroy', subject: { k: 'binding', name: 'chosen_by_loop' }, span }, true);
		return true;
	}

	// *The Rise of Sozin*: "put any number of target creature cards with total mana value X or less from that player's graveyard onto the battlefield under your control"
	if (/^put any number of target creature cards with total mana value X or less from that player's graveyard onto the battlefield under your control$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'graveyard', types: ['Creature'], ownerRef: { k: 'eventPlayer' } },
			min: 0,
			max: 99,
			maxTotalManaValue: 99
		});
		p.push(
			{
				verb: 'move',
				subject: { k: 'target', index: idx },
				params: { from: 'graveyard', to: 'battlefield', underYourControl: true },
				span
			},
			true
		);
		return true;
	}

	// *The Elder Dragon War* II: "Discard any number of cards, then draw that many cards"
	if (/^discard any number of cards, then draw that many cards$/i.test(t)) {
		p.push({ verb: 'discard', subject: YOU, amount: { k: 'const', n: 99 }, params: { upTo: true }, span }, false);
		p.push({ verb: 'draw', subject: YOU, amount: { k: 'countedThisWay', kind: 'discardedThisWay' }, span }, false);
		return true;
	}

	// *Evolutionary Escalation*: "put three +1/+1 counters on target creature you control and three +1/+1 counters on target creature an opponent controls"
	if (/^put three \+1\/\+1 counters on target creature you control and three \+1\/\+1 counters on target creature an opponent controls$/i.test(t)) {
		const i0 = p.addTarget({ kind: 'object', filter: { zone: 'battlefield', types: ['Creature'], controller: 'you' }, min: 1, max: 1 });
		const i1 = p.addTarget({ kind: 'object', filter: { zone: 'battlefield', types: ['Creature'], controller: 'opponent' }, min: 1, max: 1 });
		p.push({ verb: 'putCounters', subject: { k: 'target', index: i0 }, amount: { k: 'const', n: 3 }, params: { counter: '+1/+1' }, span }, true);
		p.push({ verb: 'putCounters', subject: { k: 'target', index: i1 }, amount: { k: 'const', n: 3 }, params: { counter: '+1/+1' }, span }, true);
		return true;
	}

	// *Dark Intimations*: "Each opponent sacrifices a creature or planeswalker of their choice, then discards a card"
	if (/^each opponent sacrifices a creature or planeswalker of their choice, then discards a card$/i.test(t)) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachOpponent',
					loopSteps: [
						{
							verb: 'sacrifice',
							subject: { k: 'all', filter: { zone: 'battlefield', types: ['Creature', 'Planeswalker'], controllerRef: { k: 'eachLoopPlayer' } } },
							actor: { k: 'eachLoopPlayer' },
							amount: { k: 'const', n: 1 },
							span
						},
						{
							verb: 'discard',
							subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } },
							amount: { k: 'const', n: 1 },
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

	// *Crypt Incursion*: "Exile all creature cards from target player's graveyard. You gain 3 life for each card exiled this way."
	if (/^you gain (\d+) life for each card exiled this way$/i.test(t)) {
		const mult = parseInt(t.match(/(\d+)/)![1], 10);
		p.push(
			{
				verb: 'gainLife',
				subject: YOU,
				amount: { k: 'mul', factor: mult, of: { k: 'countedThisWay', kind: 'exiledThisWay' } },
				span
			},
			false
		);
		return true;
	}

	// *Eventide's Shadow*: "Remove any number of counters from among permanents on the battlefield. You draw cards and lose life equal to the number of counters removed this way."
	if (/^remove any number of counters from among permanents on the battlefield$/i.test(t)) {
		p.push(
			{
				verb: 'removeCounters',
				subject: { k: 'all', filter: { zone: 'battlefield', hasAnyCounter: true } },
				amount: { k: 'const', n: 99 },
				params: { counter: 'any', upTo: true },
				span
			},
			false
		);
		return true;
	}
	if (/^you draw cards and lose life equal to the number of counters removed this way$/i.test(t)) {
		const amt: Amount = { k: 'countersRemovedThisWay' };
		p.push({ verb: 'draw', subject: YOU, amount: amt, span }, false);
		p.push({ verb: 'loseLife', subject: YOU, amount: amt, span }, false);
		return true;
	}

	// *Kaya, Geist Hunter* -2: "Until end of turn, if one or more tokens would be created under your control, twice that many of those tokens are created instead"
	if (/^until end of turn, if one or more tokens would be created under your control, twice that many of those tokens are created instead$/i.test(t)) {
		p.push(
			{
				verb: 'grantPlayer',
				subject: YOU,
				params: { doubleTokensThisTurn: true },
				span
			},
			false
		);
		return true;
	}

	// *Rejoin the Fight*: "Then starting with the next opponent in turn order, each opponent chooses a creature card in your graveyard that hasn't been chosen. Return each card chosen this way to the battlefield under your control."
	if (/^then starting with the next opponent in turn order, each opponent chooses a creature card in your graveyard that hasn't been chosen$/i.test(t)) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'turnOrderStartingWithNextOpponent',
					chooseObjectToBind: { filter: { zone: 'graveyard', owner: 'you', types: ['Creature'], notYetChosenInStep: true } }
				},
				bindAs: 'chosen_by_loop',
				span
			},
			false
		);
		return true;
	}
	if (/^return each card chosen this way to the battlefield under your control$/i.test(t)) {
		p.push(
			{
				verb: 'move',
				subject: { k: 'binding', name: 'chosen_by_loop' },
				params: { from: 'graveyard', to: 'battlefield', underYourControl: true },
				span
			},
			false
		);
		return true;
	}

	// *Glorybringer*: "it deals 4 damage to target non-Dragon creature an opponent controls"
	if (/^it deals (\d+) damage to target non-Dragon creature an opponent controls$/i.test(t)) {
		const dmg = parseInt(t.match(/(\d+)/)![1], 10);
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'], notSubtypes: ['Dragon'], controller: 'opponent' },
			min: 1,
			max: 1
		});
		p.push({ verb: 'damage', subject: { k: 'target', index: idx }, amount: { k: 'const', n: dmg }, span }, true);
		return true;
	}

	// *Herald of the Forgotten*: "return any number of target permanent cards with cycling abilities from your graveyard to the battlefield"
	if (/^return any number of target permanent cards with cycling abilities from your graveyard to the battlefield$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: {
				zone: 'graveyard',
				owner: 'you',
				types: ['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle'],
				withCyclingAbility: true
			},
			min: 0,
			max: 99
		});
		p.push(
			{
				verb: 'move',
				subject: { k: 'target', index: idx },
				params: { from: 'graveyard', to: 'battlefield', underYourControl: true },
				span
			},
			true
		);
		return true;
	}

	// *Lulu, Stern Guardian*: "choose target creature attacking you"
	if (/^choose target creature attacking you$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'], attacking: true, controller: 'opponent' },
			min: 1,
			max: 1
		});
		p.lastObject = { ref: { k: 'target', index: idx }, stepIndex: p.steps.length - 1 };
		return true;
	}

	// *Eumidian Wastewaker*: "you and defending player each discard a card or sacrifice a permanent. You draw a card for each land card put into a graveyard this way."
	if (/^you and defending player each discard a card or sacrifice a permanent$/i.test(t)) {
		const makeStep = (who: PlayerRef): EffectStep => ({
			verb: 'punisherChoice',
			subject: { k: 'playerRef', ref: who },
			params: {
				punisher: {
					unlessWho: who,
					unlessCost: [{ k: 'discard', count: { k: 'const', n: 1 } }],
					defaultSteps: [
						{
							verb: 'sacrifice',
							subject: { k: 'all', filter: { zone: 'battlefield', controllerRef: who } },
							actor: who,
							amount: { k: 'const', n: 1 },
							span
						}
					]
				}
			},
			span
		});
		p.push(makeStep({ k: 'you' }), false);
		p.push(makeStep({ k: 'defendingPlayer' }), false);
		return true;
	}
	if (/^you draw a card for each land card put into a graveyard this way$/i.test(t)) {
		p.push({ verb: 'draw', subject: YOU, amount: { k: 'countedThisWay', kind: 'landCardsPutIntoGraveyardThisWay' }, span }, false);
		return true;
	}

	// *Tempting Offer* cards: *Tempt with Bunnies*, *Tempt with Discovery*, *Tempt with Vengeance*
	if (/^(?:each opponent|then each opponent) may draw a card and create a 1\/1 white Rabbit creature token$/i.test(t)) {
		const tok = h.buildTokenSpec(1, 1, 'white Rabbit', '');
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachOpponent',
					loopSteps: [
						{
							verb: 'draw',
							subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } },
							actor: { k: 'eachLoopPlayer' },
							optional: { chooser: { k: 'eachLoopPlayer' } },
							amount: { k: 'const', n: 1 },
							span
						},
						{
							verb: 'createToken',
							subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } },
							actor: { k: 'eachLoopPlayer' },
							ifPrecedingAccepted: 0,
							amount: { k: 'const', n: 1 },
							params: { token: tok },
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
	if (/^for each opponent who does, you draw a card and you create a 1\/1 white Rabbit creature token$/i.test(t)) {
		const tok = h.buildTokenSpec(1, 1, 'white Rabbit', '');
		const amt: Amount = { k: 'countedThisWay', kind: 'opponentsDidThisWay' };
		p.push({ verb: 'draw', subject: YOU, amount: amt, span }, false);
		p.push({ verb: 'createToken', subject: YOU, amount: amt, params: { token: tok }, span }, false);
		return true;
	}
	if (/^(?:each opponent may )?search (?:your|their) library for a land card and put it onto the battlefield$/i.test(t)) {
		const isOpp = /each opponent may/i.test(t);
		if (!isOpp) {
			p.push(
				{
					verb: 'search',
					subject: YOU,
					params: {
						search: {
							filter: { types: ['Land'] },
							count: 1,
							upTo: true,
							statedQuality: true,
							destinations: [{ zone: 'battlefield' }],
							description: 'a land card'
						}
					},
					span
				},
				false
			);
			return true;
		}
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachOpponent',
					loopSteps: [
						{
							verb: 'search',
							subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } },
							actor: { k: 'eachLoopPlayer' },
							optional: { chooser: { k: 'eachLoopPlayer' } },
							params: {
								search: {
									filter: { types: ['Land'] },
									count: 1,
									upTo: true,
									statedQuality: true,
									destinations: [{ zone: 'battlefield' }],
									description: 'a land card'
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
	if (/^for each opponent who searches a library this way, search your library for a land card and put it onto the battlefield$/i.test(t)) {
		p.push(
			{
				verb: 'search',
				subject: YOU,
				amount: { k: 'countedThisWay', kind: 'opponentsDidThisWay' },
				params: {
					search: {
						filter: { types: ['Land'] },
						count: 99,
						upTo: true,
						statedQuality: true,
						destinations: [{ zone: 'battlefield' }],
						description: 'land cards'
					}
				},
				span
			},
			false
		);
		return true;
	}
	if (/^then each player who searched a library this way shuffles$/i.test(t)) {
		return true;
	}
	if (/^each opponent may create X 1\/1 red Elemental creature tokens with haste$/i.test(t)) {
		const tok = h.buildTokenSpec(1, 1, 'red Elemental', 'haste');
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachOpponent',
					loopSteps: [
						{
							verb: 'createToken',
							subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } },
							actor: { k: 'eachLoopPlayer' },
							optional: { chooser: { k: 'eachLoopPlayer' } },
							amount: { k: 'x' },
							params: { token: tok },
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
	if (/^for each opponent who does, create X 1\/1 red Elemental creature tokens with haste$/i.test(t)) {
		const tok = h.buildTokenSpec(1, 1, 'red Elemental', 'haste');
		p.push(
			{
				verb: 'createToken',
				subject: YOU,
				amount: { k: 'mul', factor: 1, of: { k: 'x' } },
				params: { token: tok, multiplyByOpponentsDidThisWay: true },
				span
			},
			false
		);
		return true;
	}

	// *Selvala's Stampede*:
	if (/^reveal cards from the top of your library until you reveal a creature card for each wild vote$/i.test(t)) {
		p.push(
			{
				verb: 'dig',
				subject: YOU,
				amount: { k: 'const', n: 1 },
				params: {
					dig: {
						keep: 99,
						upTo: false,
						keepTo: 'battlefield',
						rest: 'libraryBottom',
						shuffleRest: true,
						untilFilter: { types: ['Creature'] }
					}
				},
				span
			},
			false
		);
		return true;
	}
	if (/^put those creature cards onto the battlefield, then shuffle the rest into your library$/i.test(t)) {
		return p.steps[p.steps.length - 1]?.verb === 'dig';
	}
	if (/^you may put a permanent card from your hand onto the battlefield for each free vote$/i.test(t)) {
		p.push(
			{
				verb: 'move',
				subject: { k: 'all', filter: { zone: 'hand', owner: 'you', types: ['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle'] } },
				optional: { chooser: { k: 'you' } },
				params: { from: 'hand', to: 'battlefield', underYourControl: true, choiceCount: { k: 'const', n: 1 }, upTo: true },
				span
			},
			false
		);
		return true;
	}

	// *Mimic Vat* Imprint: "If you do, return each other card exiled with ~ to its owner's graveyard"
	if (/^if you do, return each other card exiled with ~ to its owner's graveyard$/i.test(t)) {
		p.push(
			{
				verb: 'move',
				subject: { k: 'all', filter: { zone: 'exile', exiledWithSelf: true, other: true } },
				ifPrecedingAccepted: p.steps.length - 1,
				params: { from: 'exile', to: 'graveyard' },
				span
			},
			false
		);
		return true;
	}

	// *Interceptor, Shadow's Hound*: "If you do, return ~ from your graveyard to the battlefield tapped and attacking"
	if (/^if you do, return ~ from your graveyard to the battlefield tapped and attacking$/i.test(t)) {
		p.push(
			{
				verb: 'move',
				subject: { k: 'self' },
				ifPrecedingAccepted: p.steps.length - 1,
				params: { from: 'graveyard', to: 'battlefield', tapped: true, entersTappedAndAttacking: true, underYourControl: true },
				span
			},
			false
		);
		return true;
	}

	// *Ulamog's Nullifier*: "you may put two cards your opponents own from exile into their owners' graveyards. If you do, counter target spell."
	if (/^you may put two cards your opponents own from exile into their owners' graveyards$/i.test(t)) {
		p.push(
			{
				verb: 'move',
				subject: { k: 'all', filter: { zone: 'exile', owner: 'opponent', exiledByAnyPlayer: true } },
				optional: { chooser: { k: 'you' } },
				amount: { k: 'const', n: 2 },
				params: { from: 'exile', to: 'graveyard', choiceCount: { k: 'const', n: 2 } },
				span
			},
			false
		);
		return true;
	}

	// *Hithlain Rope* (general playerToYourRight):
	if (/^the player to your right gains control of ~$/i.test(t)) {
		p.push(
			{
				verb: 'gainControl',
				subject: { k: 'self' },
				actor: { k: 'playerToYourRight' },
				params: { duration: 'permanent' },
				span
			},
			false
		);
		return true;
	}

	// *Breach the Multiverse* / *Afterlife from the Loam*:
	// "For each player, choose [up to one target] <filter> card in that player's graveyard. Put those cards onto the battlefield under your control."
	const forEachGravM = t.match(
		/^for each player, choose (up to one target )?(.+?) in that player's graveyard$/i
	);
	if (forEachGravM) {
		const isUpTo = Boolean(forEachGravM[1]);
		const f = parseObjectFilterWave11(forEachGravM[2].trim(), h) ?? h.objectFilter(forEachGravM[2].trim());
		if (f) {
			if (isUpTo) {
				const idx = p.addTarget({
					kind: 'object',
					filter: { ...f, zone: 'graveyard' },
					min: 0,
					max: 99
				});
				p.push(
					{
						verb: 'move',
						subject: { k: 'target', index: idx },
						params: { from: 'graveyard', to: 'battlefield', underYourControl: true },
						bindAs: 'moved',
						span
					},
					true
				);
				p.lastObject = { ref: { k: 'binding', name: 'moved' }, stepIndex: p.steps.length - 1 };
				return true;
			}
			p.push(
				{
					verb: 'forEachPlayerLoop',
					subject: NONE,
					params: {
						loopPlayers: 'eachPlayer',
						chooseObjectToBind: { filter: { ...f, zone: 'graveyard', ownerRef: { k: 'eachLoopPlayer' } } }
					},
					bindAs: 'chosen_by_loop',
					span
				},
				false
			);
			p.lastObject = { ref: { k: 'binding', name: 'chosen_by_loop' }, stepIndex: p.steps.length - 1 };
			return true;
		}
	}
	if (/^put those cards onto the battlefield under your control$/i.test(t)) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'move' && prev.params?.to === 'battlefield') return true;
		if (p.lastObject) {
			p.push(
				{
					verb: 'move',
					subject: refToSelW11(p.lastObject.ref),
					params: { from: 'graveyard', to: 'battlefield', underYourControl: true },
					bindAs: 'moved',
					span
				},
				false
			);
			p.lastObject = { ref: { k: 'binding', name: 'moved' }, stepIndex: p.steps.length - 1 };
			return true;
		}
	}

	// *Necromantic Selection*: "Destroy all creatures, then return a creature card put into a graveyard this way to the battlefield under your control"
	if (/^destroy all creatures, then return a creature card put into a graveyard this way to the battlefield under your control$/i.test(t)) {
		p.push(
			{
				verb: 'destroy',
				subject: { k: 'all', filter: { zone: 'battlefield', types: ['Creature'] } },
				bindAs: 'destroyed',
				span
			},
			true
		);
		p.push(
			{
				verb: 'move',
				subject: { k: 'binding', name: 'destroyed' },
				params: { from: 'graveyard', to: 'battlefield', underYourControl: true, choiceCount: { k: 'const', n: 1 } },
				bindAs: 'moved',
				span
			},
			false
		);
		p.lastObject = { ref: { k: 'binding', name: 'moved' }, stepIndex: p.steps.length - 1 };
		return true;
	}

	// "When you do, exile target creature defending player controls with power less than ~'s power until ~ leaves the battlefield."
	if (/^when you do, exile target creature defending player controls with power less than ~'s power until ~ leaves the battlefield$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'], controllerRef: { k: 'defendingPlayer' }, powerLtSelf: true },
			min: 1,
			max: 1
		});
		p.push(
			{
				verb: 'exile',
				subject: { k: 'target', index: idx },
				params: { untilSourceLeaves: true, duration: 'untilSourceLeaves' },
				span
			},
			true
		);
		return true;
	}

	// "Exile all creature cards from target player's graveyard"
	if (/^exile all creature cards from target player's graveyard$/i.test(t)) {
		const idx = p.addTarget({ kind: 'player', filter: {}, player: { relation: 'any' }, min: 1, max: 1 });
		p.push(
			{
				verb: 'exile',
				subject: { k: 'all', filter: { zone: 'graveyard', types: ['Creature'], ownerRef: { k: 'target', index: idx } } },
				bindAs: 'exiled',
				span
			},
			true
		);
		p.lastPlayer = { k: 'target', index: idx };
		p.lastObject = { ref: { k: 'binding', name: 'exiled' }, stepIndex: p.steps.length - 1 };
		return true;
	}

	// "When you do, destroy up to one target creature with mana value less than or equal to the number of counters among permanents you control"
	if (/^when you do, destroy up to one target creature with mana value less than or equal to the number of counters among permanents you control$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'], manaValueLteTotalCounters: true },
			min: 0,
			max: 1
		});
		p.push({ verb: 'destroy', subject: { k: 'target', index: idx }, span }, true);
		return true;
	}

	// "When you do, if it has four or more quest counters on it, put a +1/+1 counter on target creature you control"
	const whenIfCtrM = t.match(
		/^when you do,\s*if it has (\S+) or more ([a-z0-9+/ -]+?) counters? on it,\s*put (?:a|an) (\S+) counter on target creature you control$/i
	);
	if (whenIfCtrM) {
		const min = h.numberWord(whenIfCtrM[1]) ?? 4;
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'], controller: 'you' },
			min: 1,
			max: 1
		});
		p.push(
			{
				verb: 'putCounters',
				subject: { k: 'target', index: idx },
				amount: { k: 'const', n: 1 },
				condition: { k: 'sourceHasCounter', counter: whenIfCtrM[2].toLowerCase() as CounterType, min },
				params: { counter: whenIfCtrM[3] as CounterType },
				span
			},
			true
		);
		return true;
	}

	// "When you do, choose up to one target creature card exiled this way"
	if (/^when you do, choose up to one target creature card exiled this way$/i.test(t)) {
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'exile', types: ['Creature'] },
			min: 0,
			max: 1
		});
		p.lastObject = { ref: { k: 'target', index: idx }, stepIndex: -1 };
		return true;
	}

	// "you may cast your commander from the command zone without paying its mana cost"
	if (/^you may cast your commander from the command zone without paying its mana cost$/i.test(t)) {
		p.push(
			{
				verb: 'castFree',
				subject: { k: 'all', filter: { zone: 'command', owner: 'you', isCommander: true } },
				optional: { chooser: { k: 'you' } },
				params: { castFreeSpec: { withoutPayingManaCost: true, upToCount: 1 } },
				span
			},
			false
		);
		return true;
	}

	// "it deals 4 damage to target non-Dragon creature an opponent controls"
	const nonSubDmg = t.match(/^it deals (\d+) damage to target non-([A-Za-z]+) creature an opponent controls$/i);
	if (nonSubDmg) {
		const dmgVal = parseInt(nonSubDmg[1], 10);
		const st = h.singularSubtype(nonSubDmg[2]);
		if (st) {
			const idx = p.addTarget({
				kind: 'object',
				filter: { zone: 'battlefield', types: ['Creature'], controller: 'opponent', notSubtypes: [st] },
				min: 1,
				max: 1
			});
			p.push({ verb: 'damage', subject: { k: 'target', index: idx }, amount: { k: 'const', n: dmgVal }, span }, true);
			return true;
		}
	}

	// "each player may discard a card" / "Each player who discarded a card this way draws a card"
	if (/^each player may discard a card$/i.test(t)) {
		p.push(
			{
				verb: 'forEachPlayerLoop',
				subject: NONE,
				params: {
					loopPlayers: 'eachPlayer',
					loopSteps: [
						{
							verb: 'discard',
							subject: { k: 'playerRef', ref: { k: 'eachLoopPlayer' } },
							amount: { k: 'const', n: 1 },
							optional: { chooser: { k: 'eachLoopPlayer' } },
							span
						}
					]
				},
				bindAs: 'discardedPlayers',
				span
			},
			false
		);
		return true;
	}
	if (/^each player who discarded a card this way draws a card$/i.test(t)) {
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
							condition: { k: 'didLastOptionalStep' },
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

	// "exile a number of cards from the top of your library equal to the number of differently named tokens you control"
	if (/^exile a number of cards from the top of your library equal to the number of differently named tokens you control$/i.test(t)) {
		p.push(
			{
				verb: 'exile',
				subject: { k: 'libraryTop' },
				amount: { k: 'distinctNamesCount', of: { zone: 'battlefield', controller: 'you', token: true } },
				bindAs: 'exiled',
				span
			},
			false
		);
		p.lastObject = { ref: { k: 'binding', name: 'exiled' }, stepIndex: p.steps.length - 1 };
		return true;
	}

	// "they lose 1 life and you put a -1/-1 counter on up to one target creature they control"
	if (/^they lose 1 life and you put a -1\/-1 counter on up to one target creature they control$/i.test(t)) {
		p.push({ verb: 'loseLife', subject: { k: 'playerRef', ref: { k: 'eventPlayer' } }, amount: { k: 'const', n: 1 }, span }, false);
		const idx = p.addTarget({
			kind: 'object',
			filter: { zone: 'battlefield', types: ['Creature'], controllerRef: { k: 'eventPlayer' } },
			min: 0,
			max: 1
		});
		p.push({ verb: 'putCounters', subject: { k: 'target', index: idx }, amount: { k: 'const', n: 1 }, params: { counter: '-1/-1' }, span }, true);
		return true;
	}

	// "You may cast ~ as though it had flash if you control an attacking legendary creature"
	if (/^you may cast ~ as though it had flash if you control an attacking legendary creature$/i.test(t)) {
		p.push(
			{
				verb: 'grantPlayer',
				subject: YOU,
				params: { flashCastCondition: { k: 'controlAttackingLegendary' } },
				span
			},
			false
		);
		return true;
	}

	// "target opponent sacrifices a creature of their choice, discards a card, and loses 3 life"
	if (/^target opponent sacrifices a creature of their choice, discards a card, and loses 3 life$/i.test(t)) {
		const idx = p.addTarget({ kind: 'player', filter: {}, player: { relation: 'opponent' }, min: 1, max: 1 });
		p.push(
			{ verb: 'sacrifice', subject: { k: 'all', filter: { zone: 'battlefield', types: ['Creature'], controllerRef: { k: 'target', index: idx } } }, actor: { k: 'target', index: idx }, amount: { k: 'const', n: 1 }, span },
			true
		);
		p.push({ verb: 'discard', subject: { k: 'target', index: idx }, amount: { k: 'const', n: 1 }, span }, false);
		p.push({ verb: 'loseLife', subject: { k: 'target', index: idx }, amount: { k: 'const', n: 3 }, span }, false);
		return true;
	}

	// "that player exiles the top two cards of their library and you draw two cards"
	if (/^that player exiles the top two cards of their library and you draw two cards$/i.test(t)) {
		p.push(
			{ verb: 'exile', subject: { k: 'libraryTop', player: { k: 'eventPlayer' } }, actor: { k: 'eventPlayer' }, amount: { k: 'const', n: 2 }, span },
			false
		);
		p.push({ verb: 'draw', subject: YOU, amount: { k: 'const', n: 2 }, span }, false);
		return true;
	}

	// "if you cast a creature spell this way, it gains haste and \"At the beginning of the end step, sacrifice ~.\""
	if (/^if you cast a creature spell this way, it gains haste and [“"]at the beginning of the end step, sacrifice ~\.?[”"]$/i.test(t)) {
		p.push(
			{
				verb: 'grant',
				subject: { k: 'binding', name: 'exiled' },
				condition: { k: 'castTriggerCreatureSpell' },
				params: {
					keywords: ['Haste'],
					grantedAbilityTexts: ['At the beginning of the end step, sacrifice ~.'],
					duration: 'permanent'
				},
				span
			},
			false
		);
		return true;
	}

	return false;
}
