/**
 * Wave 9 compiler effect extensions (pure compiler helpers, zero runtime state).
 *
 * Keeps `compiler/effects.ts` clean while covering:
 * - Generalized 3-sentence `dig` ("Exile top N ... Choose one of them ... play that card",
 *   "with mana value less than X", "back on top of your library in any order")
 * - Extended `search` ("Search your library for ... and cast that card without paying its mana cost")
 * - `exileUntil` life-payment cast ("by paying life equal to the spell's mana value rather than paying its mana cost")
 * - `copySpell` target lookback across intermediate steps (*Narset's Reversal*, *Chain of Vapor*)
 * - `graveyardCast` / `castFree` riders ("the flashback cost is equal to that card's mana cost",
 *   *Rod of Absorption*, *Emet-Selch*, *Blue Mage's Cane*, *Aven Interrupter* plotted)
 * - Delayed spell/effect triggers ("until end of turn / until your next turn, whenever ...", *Moraug* next combat)
 * - *Krile*, *Puca's Covenant*, *Slinn Voda*, *Conformer Shuriken*, *Field-Tested Frying Pan*, *Haunted One*, *Burning Curiosity*
 */
import type {
	Amount,
	Condition,
	Duration,
	EffectParams,
	EffectStep,
	ObjectFilter,
	PlayerFilter,
	PlayerRef,
	Ref,
	Span,
	TargetSpec,
	TriggerDef
} from '../ir.ts';
import type { TriggerParse } from './triggers.ts';

export interface EffectsWave9ParserLike {
	context: import('./effects.ts').EffectContext;
	steps: EffectStep[];
	targets: TargetSpec[];
	unparsed: Span[];
	lastObject?: { ref: Ref; stepIndex: number };
	lastPlayer?: import('../ir.ts').Selector;
	lastOptionalStep?: number;
	lastSentenceStepStart?: number;
	definedX?: Amount;
	push(step: EffectStep, actsOnObjects: boolean): number;
	addTarget(spec: TargetSpec): number;
	itRef(): Ref | null;
	mark(): unknown;
	rollback(m: unknown): void;
}

export interface EffectsWave9Helpers {
	objectFilter: (phrase: string) => ObjectFilter | null;
	objectPhrase: (
		p: EffectsWave9ParserLike,
		phrase: string
	) => { selector: import('../ir.ts').Selector; ref?: Ref; fromZone?: import('../types.ts').ZoneType; plural?: boolean } | null;
	playerPhrase: (p: EffectsWave9ParserLike, phrase: string) => import('../ir.ts').Selector | null;
	singlePlayer: (sel: import('../ir.ts').Selector) => PlayerRef | null;
	amountWord: (p: EffectsWave9ParserLike, raw: string) => Amount | null;
	equalTo: (p: EffectsWave9ParserLike, raw: string) => Amount | null;
	singularSubtype: (raw: string) => string | null;
	clauses: (p: EffectsWave9ParserLike, text: string, offset: number) => boolean;
	parseSubEffects: (
		text: string,
		offset: number,
		context: import('./effects.ts').EffectContext,
		trigger?: TriggerDef,
		seedLastObject?: { ref: Ref; verb: EffectStep['verb'] }
	) => { steps: EffectStep[]; targets: TargetSpec[]; unparsed: Span[] };
	parseTriggerHeader: (text: string, offset?: number) => TriggerParse | null;
	stepOptionalChooser: (step: EffectStep) => PlayerRef | undefined;
}

const YOU: import('../ir.ts').Selector = { k: 'player', filter: { relation: 'you' } };

function parseSubtypeExceptionList(raw: string, singularSubtype: (s: string) => string | null): string[] | null {
	const cleaned = raw
		.trim()
		.replace(/,\s*and\s+/gi, ', ')
		.replace(/\s+and\s+/gi, ', ');
	const parts = cleaned
		.split(/\s*,\s*/)
		.map((s) => s.trim())
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

/** Parses Wave 9 object filter qualifiers (`except for ...`, `that share a creature type with it`, event MV comparisons). */
export function parseObjectFilterWave9(
	raw: string,
	parseFilter: (sub: string) => ObjectFilter | null,
	singularSubtype: (s: string) => string | null
): ObjectFilter | null {
	const t = raw.trim();

	// *Wakka*: "artifact that player controls"
	const thatPlCtrlM = t.match(/^(.+?)\s+that player controls$/i);
	if (thatPlCtrlM) {
		const base = parseFilter(thatPlCtrlM[1].trim());
		if (base) {
			return { ...base, controllerRef: { k: 'eventPlayer' } };
		}
	}

	// *Haunting Voyage*: "creature cards of that type"
	const ofThatTypeM = t.match(/^(.+?)\s+of that type$/i);
	if (ofThatTypeM) {
		const base = parseFilter(ofThatTypeM[1].trim());
		if (base) {
			return { ...base, ofChosenType: true };
		}
	}

	// *Summon: Good King Mog XII*: "non-Saga token"
	const nonSubM = t.match(/^non-([A-Z][a-zA-Z'-]*)\s+(.+)$/);
	if (nonSubM) {
		const base = parseFilter(nonSubM[2].trim());
		if (base) {
			const sub = singularSubtype(nonSubM[1]) ?? nonSubM[1];
			return { ...base, notSubtypes: [...(base.notSubtypes ?? []), sub] };
		}
	}

	// *Slinn Voda*: "creatures ... except for Merfolk, Krakens, Leviathans, Octopuses, and Serpents"
	const exceptM = t.match(/^(.+?)\s+except for\s+(.+)$/i);
	if (exceptM) {
		const base = parseFilter(exceptM[1].trim());
		const subs = parseSubtypeExceptionList(exceptM[2], singularSubtype);
		if (base && subs && subs.length > 0) {
			return {
				...base,
				notSubtypes: [...(base.notSubtypes ?? []), ...subs]
			};
		}
	}

	// *Haunted One*: "creatures you control that share a creature type with it"
	const shareTypeM = t.match(/^(.+?)\s+that shares? a creature type with (?:it|~)$/i);
	if (shareTypeM) {
		const base = parseFilter(shareTypeM[1].trim());
		if (base) {
			return { ...base, sharesCreatureTypeWithSelf: true };
		}
	}

	// *Krile Baldesion*: "creature card with mana value equal to that spell's mana value"
	const mvEqEventM = t.match(/^(.+?)\s+with mana value equal to that spell's mana value$/i);
	if (mvEqEventM) {
		const base = parseFilter(mvEqEventM[1].trim());
		if (base) {
			return {
				...base,
				manaValueCompare: {
					op: '=',
					value: { k: 'stat', of: { k: 'eventObject' }, stat: 'manaValue' }
				}
			};
		}
	}

	// *Puca's Covenant*: "permanent card with mana value less than or equal to the number of counters on that creature"
	const mvLteCountersM = t.match(
		/^(.+?)\s+with mana value less than or equal to the number of counters on that (?:creature|permanent)$/i
	);
	if (mvLteCountersM) {
		const base = parseFilter(mvLteCountersM[1].trim());
		if (base) {
			return {
				...base,
				manaValueCompare: {
					op: '<=',
					value: { k: 'lkiCounterCount', counter: 'any' }
				}
			};
		}
	}

	return null;
}

/** Wave 9 dig keep-clause extensions (*Kiora, Sovereign of the Deep*, *Rowan's Grim Search*). */
export function parseDigKeepClauseWave9(
	s: string,
	p: EffectsWave9ParserLike,
	h: EffectsWave9Helpers
): Partial<NonNullable<EffectParams['dig']>> | null {
	// *Kiora*: "You may cast a spell with mana value less than X from among them without paying its mana cost"
	const kioraM = s.match(
		/^(?:you may\s+)?cast (?:(an?|.+?) )?spells? with mana value less than (\S+) from among (?:them|those cards) without paying (?:its|their) mana costs?$/i
	);
	if (kioraM) {
		const rawMv = kioraM[2].trim();
		const maxMv: Amount | null =
			rawMv.toLowerCase() === 'x' ? { k: 'x' } : h.amountWord(p, rawMv.toLowerCase());
		if (maxMv) {
			let keepFilter: ObjectFilter | undefined = {};
			if (kioraM[1] && !/^an?$/i.test(kioraM[1].trim())) {
				keepFilter = h.objectFilter(`${kioraM[1].trim()} spell`) ?? h.objectFilter(kioraM[1].trim()) ?? undefined;
			}
			if (keepFilter) {
				return {
					keep: 1,
					upTo: true,
					keepFilter,
					keepMaxManaValue: maxMv,
					keepMaxMvStrictLt: true,
					keepTo: 'castFree'
				};
			}
		}
	}

	// *Rowan's Grim Search*: "put up to two of them back on top of your library in any order"
	const topAnyOrderM = s.match(
		/^(?:you may\s+)?put (?:(up to) )?(\S+) of (?:them|those cards) back on top of your library(?: in any order)?$/i
	);
	if (topAnyOrderM) {
		const amt = h.amountWord(p, topAnyOrderM[2].toLowerCase());
		if (amt && amt.k === 'const' && amt.n >= 1) {
			return {
				keep: amt.n,
				upTo: Boolean(topAnyOrderM[1]),
				keepTo: 'libraryTop'
			};
		}
	}

	return null;
}

/** Wave 9 `exileUntil` follow-up (*Bismuth Mindrender* pay-life alternative cost). */
export function convertExileUntilFollowUpWave9(
	untilFilter: ObjectFilter,
	t: string
): import('../ir.ts').ExileUntilSpec | null {
	const lifeCastM = t.match(
		/^(?:then\s+)?(?:you|that player) may cast (?:that card|it) by paying life equal to (?:the spell's|that spell's|its) mana value rather than paying its mana cost$/i
	);
	if (lifeCastM) {
		return {
			filter: untilFilter,
			hitAction: 'castFree',
			spellsOnly: true,
			payLifeEqualManaValue: true,
			restDestination: 'stayExiled'
		};
	}
	return null;
}

/** Wave 9 condition parser hooks for effect-resolution conditions (`effects.ts`). */
export function parseWave9EffectCondition(
	rawCond: string,
	p: EffectsWave9ParserLike
): Condition | null {
	const t = rawCond.trim();
	// *Auntie Ool*: "If you don't control it"
	if (/^if you don't control (?:it|that creature)$/i.test(t)) {
		return {
			k: 'not',
			of: { k: 'matchesFilter', target: p.lastObject?.ref ?? { k: 'eventObject' }, filter: { controller: 'you' } }
		};
	}
	// *Burning Curiosity*: "If this spell's additional cost was paid"
	if (/^if (?:~|this spell)'s additional cost was paid$/i.test(t)) {
		return { k: 'additionalCostPaidThisSpell' };
	}
	// *Conformer Shuriken*: "If that creature has greater power than ~"
	if (
		/^if that creature has greater power than ~$/i.test(t) &&
		p.lastObject?.ref
	) {
		return {
			k: 'compare',
			left: { k: 'stat', of: p.lastObject.ref, stat: 'power' },
			op: '>',
			right: { k: 'stat', of: { k: 'self' }, stat: 'power' }
		};
	}
	return null;
}

/** Parses Wave 9 multi-sentence follow-ups and specialized sentences inside `sentence()`. */
export function parseSentenceWave9(
	p: EffectsWave9ParserLike,
	t: string,
	span: Span,
	h: EffectsWave9Helpers
): boolean {
	// 1. *Sphinx of Forgotten Lore*: "The flashback cost is equal to that card's mana cost."
	if (/^the flashback cost is equal to (?:its|that card's) mana cost$/i.test(t)) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'grantGraveyardCast' && prev.params?.graveyardCastSpec) {
			prev.params = {
				...prev.params,
				graveyardCastSpec: { ...prev.params.graveyardCastSpec, flashbackEqualManaCost: true }
			};
			return true;
		}
		return false;
	}

	// 2. *Aven Interrupter*: "It becomes plotted." right after exiling a spell from the stack
	if (/^it becomes plotted$/i.test(t)) {
		const prevIdx = p.steps.length - 1;
		const prev = p.steps[prevIdx];
		if (prev?.verb === 'exile') {
			const bindName = prev.bindAs ?? `b${prevIdx}`;
			prev.bindAs = bindName;
			p.push(
				{
					verb: 'grantPlayFromExile',
					subject: { k: 'binding', name: bindName },
					actor: { k: 'ownerOf', of: { k: 'binding', name: bindName } },
					params: {
						playFromExile: {
							duration: 'asLongAsExiled',
							withoutPayingManaCost: true,
							spellsOnly: true,
							plotted: true
						}
					},
					span
				},
				false
			);
			return true;
		}
		return false;
	}

	// 3. *Fireglass Mentor* / *Chandra, Flameshaper*: 3-sentence "Exile the top N cards of your library. Choose one [of them]. Until end of turn / this turn, you may play that card."
	if (/^choose one(?: of (?:them|those cards))?$/i.test(t)) {
		const prevIdx = p.steps.length - 1;
		const prev = p.steps[prevIdx];
		if (
			prev?.verb === 'exile' &&
			prev.subject.k === 'libraryTop' &&
			prev.amount
		) {
			prev.verb = 'dig';
			prev.subject = { k: 'none' };
			prev.params = {
				dig: {
					keep: 1,
					upTo: false,
					keepTo: 'exile',
					rest: 'exile',
					chooseMode: 'oneOfExiled'
				}
			};
			const bindName = prev.bindAs ?? `b${prevIdx}`;
			prev.bindAs = bindName;
			p.lastObject = { ref: { k: 'binding', name: bindName }, stepIndex: prevIdx };
			return true;
		}
		return false;
	}
	const playChosenDigM = t.match(
		/^(?:(?:until end of turn|until (?:the )?end of your next turn),\s*you may (play|cast) (?:that card|the exiled card|it)|you may (play|cast) (?:that card|the exiled card|it) (this turn|until end of turn|until (?:the )?end of your next turn))$/i
	);
	if (playChosenDigM && p.steps.length > 0) {
		const prev = p.steps[p.steps.length - 1];
		if (
			prev?.verb === 'dig' &&
			(prev.params?.dig?.chooseMode === 'oneOfExiled' || prev.params?.dig?.keepTo === 'exile')
		) {
			const verb = (playChosenDigM[1] ?? playChosenDigM[2] ?? 'play').toLowerCase();
			const dur = /next turn/i.test(t) ? ('untilEndOfYourNextTurn' as const) : ('thisTurn' as const);
			prev.params = {
				...prev.params,
				dig: {
					...prev.params.dig,
					playFromExile: {
						duration: dur,
						...(verb === 'cast' ? { spellsOnly: true } : {})
					}
				}
			};
			return true;
		}
	}

	// 4. *Narset's Reversal*: "You may choose new targets for the copy." looking back past intermediate steps (e.g. bounce)
	if (/^(?:you|they|that player) may choose new targets for (?:the|that|those|each|any|any of the) cop(?:y|ies)$/i.test(t)) {
		for (let i = p.steps.length - 1; i >= Math.max(0, p.steps.length - 4); i--) {
			if (p.steps[i].verb === 'copySpell') {
				p.steps[i].params = { ...p.steps[i].params, mayChooseNewTargets: true };
				return true;
			}
		}
	}

	// 5. *Chain of Vapor*: "Then that permanent's controller may sacrifice a land of their choice." + "If the player does, they may copy ~ and may choose a new target for that copy."
	const sacOfChoiceM = t.match(
		/^(?:then\s+)?(.+?)\s+may sacrifice (?:a|an) (.+?) of their choice$/i
	);
	if (sacOfChoiceM) {
		const actorSel = h.playerPhrase(p, sacOfChoiceM[1].trim());
		const chooser = actorSel ? h.singlePlayer(actorSel) : null;
		const sacFilter = h.objectFilter(sacOfChoiceM[2].trim());
		if (chooser && sacFilter) {
			const idx = p.push(
				{
					verb: 'sacrifice',
					subject: { k: 'all', filter: { ...sacFilter, zone: 'battlefield', controller: 'you' } },
					actor: chooser,
					amount: { k: 'const', n: 1 },
					optional: { chooser },
					span
				},
				true
			);
			p.lastOptionalStep = idx;
			return true;
		}
	}
	const chainCopyM = t.match(
		/^(?:if the player does,\s*)?they may copy ~\s+and may choose (?:a )?new targets? for that copy$/i
	);
	if (chainCopyM) {
		const optIdx = p.lastOptionalStep ?? p.steps.length - 1;
		const optStep = optIdx >= 0 ? p.steps[optIdx] : undefined;
		const actor = optStep?.optional?.chooser ?? optStep?.actor;
		if (actor) {
			p.push(
				{
					verb: 'copySpell',
					subject: { k: 'self' },
					actor,
					...(optStep?.optional && !/^they may copy/i.test(t) ? { ifPrecedingAccepted: optIdx } : {}),
					optional: { chooser: actor },
					params: { mayChooseNewTargets: true },
					span
				},
				false
			);
			return true;
		}
	}

	// 6. *Sunforger*: "Search your library for <filter> and cast that card without paying its mana cost"
	const sunforgerM = t.match(
		/^search your library for (.+?)\s+and cast (?:that card|it) without paying its mana cost$/i
	);
	if (sunforgerM) {
		const f = h.objectFilter(sunforgerM[1].trim());
		if (f) {
			delete f.zone;
			p.push(
				{
					verb: 'search',
					subject: { k: 'none' },
					params: {
						search: {
							filter: f,
							count: 1,
							upTo: false,
							statedQuality: true,
							destinations: [{ zone: 'library' }],
							castFree: true,
							description: sunforgerM[1].trim()
						}
					},
					span
				},
				false
			);
			return true;
		}
	}

	// 7. *Rod of Absorption*: "You may cast any number of spells from among cards exiled with ~ with total mana value X or less without paying their mana costs"
	const rodM = t.match(
		/^you may cast any number of spells from among cards exiled with ~ with total mana value (\S+) or less without paying their mana costs$/i
	);
	if (rodM) {
		const rawMax = rodM[1].trim();
		const totalMaxMv: Amount | null =
			rawMax.toLowerCase() === 'x' ? { k: 'x' } : h.amountWord(p, rawMax.toLowerCase());
		if (totalMaxMv) {
			const idx = p.push(
				{
					verb: 'castFree',
					subject: { k: 'all', filter: { zone: 'exile', exiledWithSelf: true } },
					optional: { chooser: { k: 'you' } },
					params: {
						castFreeSpec: {
							withoutPayingManaCost: true,
							totalMaxMv,
							exiledWithSelf: true
						}
					},
					span
				},
				false
			);
			p.lastOptionalStep = idx;
			return true;
		}
	}

	// 8. *Emet-Selch*: "you may cast target instant or sorcery card from your graveyard" (paying its mana cost on resolution)
	const castFromGyM = t.match(
		/^you may cast (target .+? (?:in|from) (?:your|a) graveyard)$/i
	);
	if (castFromGyM) {
		const mark = p.mark();
		const obj = h.objectPhrase(p, castFromGyM[1].trim());
		if (obj && obj.selector.k === 'target') {
			const idx = p.push(
				{
					verb: 'castFree',
					subject: obj.selector,
					optional: { chooser: { k: 'you' } },
					params: {
						castFreeSpec: {
							withoutPayingManaCost: false
						}
					},
					span
				},
				false
			);
			p.lastOptionalStep = idx;
			return true;
		}
		p.rollback(mark);
	}

	// 9. *Moraug*: "there's an additional combat phase after this phase" & "At the beginning of that combat, untap all creatures you control"
	if (/^there(?:'s| is) an additional combat phase after this phase$/i.test(t)) {
		p.push({ verb: 'extraCombatPhase', subject: { k: 'none' }, span }, false);
		return true;
	}
	const nextCombatM = t.match(/^at the beginning of that combat,\s*(.+)$/i);
	if (nextCombatM) {
		const sub = h.parseSubEffects(nextCombatM[1].trim(), span.start, p.context);
		if (sub.unparsed.length === 0 && sub.targets.length === 0 && sub.steps.length > 0) {
			p.push(
				{
					verb: 'delayedTrigger',
					subject: { k: 'none' },
					delayed: {
						trigger: { event: 'phaseBegin', filter: { phase: 'begin_combat' } },
						effect: sub.steps
					},
					params: {
						registerWave9DelayedTrigger: { duration: 'nextCombat' }
					},
					span
				},
				false
			);
			return true;
		}
	}

	// 10. *Firebender Ascension*: "you may copy that ability"
	if (/^you may copy that ability$/i.test(t)) {
		const idx = p.push(
			{
				verb: 'copySpell',
				subject: { k: 'eventObject' },
				optional: { chooser: { k: 'you' } },
				params: { copyEventAbility: true },
				span
			},
			false
		);
		p.lastOptionalStep = idx;
		return true;
	}

	// 11. *Azra Oddsmaker* / *Tamiyo* / *Hunter's Insight*: non-targeting "choose a creature"
	if (/^choose a creature$/i.test(t)) {
		const idx = p.push(
			{
				verb: 'tap',
				subject: { k: 'all', filter: { zone: 'battlefield', types: ['Creature'] } },
				params: { choiceCount: { k: 'const', n: 1 } },
				span
			},
			true
		);
		// Wait: choosing a creature should not tap it! Reuse `reveal` (`lookOnly: true` no-op that binds chosen creature) or handle cleanly.
		p.steps[idx].verb = 'reveal';
		p.steps[idx].params = { choiceCount: { k: 'const', n: 1 }, lookOnly: true };
		return true;
	}

	// 12. Delayed spell/effect triggers (*Showdown of the Skalds*, *Good King Mog XII*, *Massacre Girl*, *Electric Seaweed*, *Azra Oddsmaker*, *Hunter's Insight*, *Tamiyo, Field Researcher*):
	//     "Until end of turn, whenever ..., <eff>" / "Until your next turn, whenever ..., <eff>" / "Whenever ... this turn, <eff>"
	const delM =
		t.match(/^(until end of turn|until your next turn),\s*((?:when|whenever)\s+.+?),\s*(.+)$/i) ??
		t.match(/^(?:()(whenever\s+[^,]+?\s+this turn),\s*(.+))$/i);
	if (delM) {
		const durPrefix = (delM[1] ?? '').toLowerCase();
		const duration: 'thisTurn' | 'untilYourNextTurn' =
			durPrefix === 'until your next turn' ? 'untilYourNextTurn' : 'thisTurn';
		const rawHead = (delM[2] ?? '').trim().replace(/\s+this turn$/i, '');
		const innerBody = (delM[3] ?? '').trim();
		const tp = h.parseTriggerHeader(`${rawHead}, draw a card.`);
		if (tp && tp.trigger && tp.unparsed.length === 0) {
			const trig: TriggerDef = {
				...tp.trigger,
				...(tp.condition ? {} : {}),
				spellDelayed: duration === 'untilYourNextTurn' ? 'untilYourNextTurn' : 'thisTurn'
			};
			const sub = h.parseSubEffects(innerBody, span.start, 'triggered', trig);
			if (sub.unparsed.length === 0 && sub.steps.length > 0) {
				// Allow delayed trigger that references a chosen creature/pair (`watchedBoundObject`) or has targets on trigger stack item
				const usesWatched =
					Boolean(trig.filter.watchedBoundObject) &&
					(p.lastObject !== undefined || p.targets.length > 0);
				if (sub.targets.length === 0 || sub.targets.length > 0) {
					const stepSubj = usesWatched
						? (p.lastObject?.ref ? ({ k: p.lastObject.ref.k, ...(p.lastObject.ref.k === 'target' ? { index: p.lastObject.ref.index } : p.lastObject.ref.k === 'binding' ? { name: p.lastObject.ref.name } : {}) } as import('../ir.ts').Selector) : p.targets.length > 0 ? { k: 'target' as const, index: 0 } : { k: 'none' as const })
						: { k: 'none' as const };
					p.push(
						{
							verb: 'delayedTrigger',
							subject: stepSubj,
							delayed: {
								trigger: trig,
								effect: sub.steps,
								...(sub.targets.length > 0 ? { targets: sub.targets } : {})
							},
							params: {
								registerWave9DelayedTrigger: {
									duration,
									...(usesWatched ? { bindSubjectAsWatched: true } : {})
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

	// 13. *Haunted One*: "<it> and other creatures you control that share a creature type with it each get +P/+T and gain <kw> until end of turn"
	const sharePumpM = t.match(
		/^(?:it|~) and (other creatures you control that shares? a creature type with (?:it|~)) each (?:gets?|gains?) (.+?)(?: (until end of turn|until your next turn))?$/i
	);
	if (sharePumpM) {
		const otherFilter = h.objectFilter(sharePumpM[1].trim());
		if (otherFilter) {
			const dur = sharePumpM[3]?.toLowerCase() === 'until your next turn' ? 'untilYourNextTurn' : 'endOfTurn';
			// Synthesize self + other matching creatures via two paired clauses
			const selfPart = h.parseSubEffects(`~ get ${sharePumpM[2].trim()} ${sharePumpM[3] ?? 'until end of turn'}`.trim(), span.start, p.context);
			// Try canonical "gets +2/+0 and gains undying until end of turn" on both self and matching all creatures
			const pred = sharePumpM[2].trim();
			const ptAndKw = pred.match(/^([+-]\d+)\/([+-]\d+)\s+and\s+gains?\s+([a-z-]+)$/i);
			if (ptAndKw) {
				const dP = parseInt(ptAndKw[1], 10);
				const dT = parseInt(ptAndKw[2], 10);
				const kw = ptAndKw[3].toLowerCase();
				p.push(
					{
						verb: 'pump',
						subject: { k: 'self' },
						amount: { k: 'const', n: dP },
						params: { toughness: { k: 'const', n: dT }, duration: dur },
						span
					},
					false
				);
				p.push(
					{
						verb: 'grant',
						subject: { k: 'self' },
						params: { keywords: [kw], duration: dur },
						span
					},
					false
				);
				p.push(
					{
						verb: 'pump',
						subject: { k: 'all', filter: { ...otherFilter, zone: 'battlefield' } },
						amount: { k: 'const', n: dP },
						params: { toughness: { k: 'const', n: dT }, duration: dur },
						span
					},
					false
				);
				p.push(
					{
						verb: 'grant',
						subject: { k: 'all', filter: { ...otherFilter, zone: 'battlefield' } },
						params: { keywords: [kw], duration: dur },
						span
					},
					false
				);
				void selfPart;
				return true;
			}
		}
	}

	// 14. *Conformer Shuriken*: "put a number of +1/+1 counters on ~ equal to the difference" when preceded by greater-power comparison
	if (
		/^put a number of \+1\/\+1 counters on ~ equal to the difference$/i.test(t) &&
		p.lastObject?.ref
	) {
		p.push(
			{
				verb: 'putCounters',
				subject: { k: 'self' },
				amount: {
					k: 'difference',
					left: { k: 'stat', of: p.lastObject.ref, stat: 'power' },
					right: { k: 'stat', of: { k: 'self' }, stat: 'power' }
				},
				params: { counter: '+1/+1' },
				span
			},
			false
		);
		return true;
	}

	// 15. *Burning Curiosity* replacement: "exile the top N card(s)" (implied "of your library")
	const topExileShortM = t.match(/^exile the top (\S+) cards?$/i);
	if (topExileShortM) {
		const amt = h.amountWord(p, topExileShortM[1].toLowerCase());
		if (amt) {
			p.push({ verb: 'exile', subject: { k: 'libraryTop' }, amount: amt, span }, true);
			return true;
		}
	}

	// 16. *Auntie Ool*: "draw a card if you control that creature"
	if (/^draw a card if you control (?:that creature|it)$/i.test(t)) {
		p.push(
			{
				verb: 'draw',
				subject: YOU,
				amount: { k: 'const', n: 1 },
				condition: {
					k: 'matchesFilter',
					target: { k: 'eventObject' },
					filter: { controller: 'you' }
				},
				span
			},
			false
		);
		return true;
	}

	// 17. *Confounding Conundrum*: "they return a land they control to its owner's hand"
	const theyBounceM = t.match(
		/^(?:they|that player|that opponent) returns? (?:a|an) (.+?) (?:they control|that player controls) to its owner's hand$/i
	);
	if (theyBounceM) {
		const f = h.objectFilter(theyBounceM[1].trim());
		if (f) {
			p.push(
				{
					verb: 'bounce',
					actor: { k: 'eventPlayer' },
					subject: { k: 'all', filter: { ...f, zone: 'battlefield', controller: 'you' } },
					params: { choiceCount: { k: 'const', n: 1 } },
					span
				},
				true
			);
			return true;
		}
	}

	// 18. *Evercoat Ursine*: "you may play one of them without paying its mana cost"
	if (/^you may play one of (?:them|those cards) without paying its mana cost$/i.test(t)) {
		const idx = p.push(
			{
				verb: 'castFree',
				subject: { k: 'all', filter: { zone: 'exile', exiledWithSelf: true } },
				optional: { chooser: { k: 'you' } },
				params: {
					castFreeSpec: {
						withoutPayingManaCost: true,
						upToCount: 1,
						exiledWithSelf: true
					}
				},
				span
			},
			false
		);
		p.lastOptionalStep = idx;
		return true;
	}

	// 19. *Kodama of the East Tree*: "you may put a permanent card with equal or lesser mana value from your hand onto the battlefield"
	if (
		/^you may put (?:a|an) permanent card with equal or lesser mana value from your hand onto the battlefield$/i.test(
			t
		)
	) {
		const idx = p.push(
			{
				verb: 'move',
				subject: {
					k: 'all',
					filter: {
						zone: 'hand',
						owner: 'you',
						types: ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Land', 'Planeswalker'],
						manaValueCompare: {
							op: '<=',
							value: { k: 'stat', of: { k: 'eventObject' }, stat: 'manaValue' }
						}
					}
				},
				params: {
					from: 'hand',
					to: 'battlefield',
					underYourControl: true,
					choiceCount: { k: 'const', n: 1 },
					upTo: true
				},
				optional: { chooser: { k: 'you' } },
				span
			},
			true
		);
		p.lastOptionalStep = idx;
		return true;
	}

	// 20. *Szarel*: "put a number of +1/+1 counters equal to ~'s power on <target>"
	const szarelM = t.match(
		/^put a number of \+1\/\+?1 counters equal to ~'s power on (.+)$/i
	);
	if (szarelM) {
		const mark = p.mark();
		const obj = h.objectPhrase(p, szarelM[1].trim());
		if (obj) {
			p.push(
				{
					verb: 'putCounters',
					subject: obj.selector,
					amount: { k: 'stat', of: { k: 'self' }, stat: 'power' },
					params: { counter: '+1/+1' },
					span
				},
				true
			);
			return true;
		}
		p.rollback(mark);
	}

	// 21. *Ugin's Mastery*: "you may turn a face-down creature you control face up"
	if (/^you may turn a face-down creature you control face up$/i.test(t)) {
		const idx = p.push(
			{
				verb: 'turnFace',
				subject: {
					k: 'all',
					filter: { zone: 'battlefield', controller: 'you', types: ['Creature'], faceDown: true }
				},
				params: { faceDirection: 'up', choiceCount: { k: 'const', n: 1 }, upTo: true },
				optional: { chooser: { k: 'you' } },
				span
			},
			true
		);
		p.lastOptionalStep = idx;
		return true;
	}

	// 22. *Slinn Voda*: "return all creatures to their owners' hands except for <subtypes>"
	const slinnM = t.match(
		/^return (?:all )?(.+?) to (?:their owners' hands?|its owner's hand) except for (.+)$/i
	);
	if (slinnM) {
		const f = h.objectFilter(`${slinnM[1].trim()} except for ${slinnM[2].trim()}`);
		if (f) {
			p.push({ verb: 'bounce', subject: { k: 'all', filter: { ...f, zone: 'battlefield' } }, span }, true);
			return true;
		}
	}

	// 23. *Jiang Yanggu*: "then put a +1/+1 counter on that creature for each card you've discarded this turn"
	if (
		/^(?:then\s+)?put (?:a|one) \+1\/\+1 counter on (?:that creature|it) for each card you've discarded this turn$/i.test(
			t
		)
	) {
		const subj: import('../ir.ts').Selector = p.lastObject?.ref
			? p.lastObject.ref.k === 'eventObject'
				? { k: 'eventObject' }
				: p.lastObject.ref.k === 'target'
					? { k: 'target', index: p.lastObject.ref.index }
					: { k: 'eventObject' }
			: { k: 'eventObject' };
		p.push(
			{
				verb: 'putCounters',
				subject: subj,
				amount: { k: 'cardsDiscardedThisTurn' },
				params: { counter: '+1/+1' },
				span
			},
			true
		);
		return true;
	}

	// 24. *Summon: Good King Mog XII*: "create a token that's a copy of a non-Saga token you control"
	const mogM = t.match(/^create a token that's a copy of (?:a|an) (?!target\b)(.+)$/i);
	if (mogM) {
		const f = h.objectFilter(mogM[1].trim());
		if (f) {
			p.push(
				{
					verb: 'copyPermanent',
					subject: { k: 'all', filter: { ...f, zone: 'battlefield' } },
					amount: { k: 'const', n: 1 },
					params: { choiceCount: { k: 'const', n: 1 } },
					span
				},
				true
			);
			return true;
		}
	}

	// 25. *Ainok Strike Leader*: "for each opponent, create a 1/1 red Goblin creature token that's tapped and attacking that player"
	const ainokM = t.match(
		/^for each opponent,\s*create (?:a|an) (\d+)\/(\d+) (white|blue|black|red|green|colorless) ([A-Za-z]+) creature token that's tapped and attacking that player$/i
	);
	if (ainokM) {
		const cMap: Record<string, import('../types.ts').ManaColor> = {
			white: 'W',
			blue: 'U',
			black: 'B',
			red: 'R',
			green: 'G'
		};
		const cLower = ainokM[3].toLowerCase();
		const sub = h.singularSubtype(ainokM[4]) ?? ainokM[4];
		p.push(
			{
				verb: 'createToken',
				subject: YOU,
				amount: { k: 'const', n: 1 },
				params: {
					token: {
						name: sub,
						power: parseInt(ainokM[1], 10),
						toughness: parseInt(ainokM[2], 10),
						colors: cLower === 'colorless' ? [] : cMap[cLower] ? [cMap[cLower]] : [],
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

	// 26. *Shredder, Shadow Master*: "for each other opponent, create a token that's a copy of ~ tapped and attacking that player, except it isn't legendary"
	if (
		/^for each other opponent,\s*create a token that's a copy of ~ tapped and attacking that player, except it isn't legendary$/i.test(
			t
		)
	) {
		p.push(
			{
				verb: 'copyPermanent',
				subject: { k: 'self' },
				amount: { k: 'const', n: 1 },
				params: {
					nonLegendary: true,
					tappedAndAttacking: true,
					perOpponentTappedAttacking: 'other'
				},
				span
			},
			true
		);
		return true;
	}

	// 27. *Celes, Rune Knight*: "discard any number of cards, then draw that many cards plus one"
	if (/^discard any number of cards,\s*then draw that many cards plus one$/i.test(t)) {
		p.push(
			{
				verb: 'discard',
				subject: YOU,
				amount: { k: 'cardsIn', zone: 'hand', of: { k: 'you' } },
				params: { upTo: true },
				span
			},
			true
		);
		p.push(
			{
				verb: 'draw',
				subject: YOU,
				amount: { k: 'sum', args: [{ k: 'countedThisWay', kind: 'discardedThisWay' }, { k: 'const', n: 1 }] },
				span
			},
			false
		);
		return true;
	}

	// 28. *Stitch Together*: "return that card from your graveyard to the battlefield"
	if (/^return (?:that card|it) from (?:your|their|its owner's) graveyard to the battlefield$/i.test(t)) {
		const ref = p.itRef();
		if (ref) {
			const subj: import('../ir.ts').Selector =
				ref.k === 'target'
					? { k: 'target', index: ref.index }
					: ref.k === 'binding'
						? { k: 'binding', name: ref.name }
						: { k: 'eventObject' };
			p.push(
				{
					verb: 'move',
					subject: subj,
					params: { from: 'graveyard', to: 'battlefield', underYourControl: true },
					span
				},
				true
			);
			return true;
		}
	}

	// 29. *Haunting Voyage*: "return up to <N> <filter> from your graveyard to the battlefield"
	const hauntM = t.match(
		/^return up to (\S+) (.+?) from (your|a|their) graveyard to the battlefield$/i
	);
	if (hauntM) {
		const cnt = h.amountWord(p, hauntM[1].toLowerCase());
		const f = h.objectFilter(hauntM[2].trim());
		if (cnt && f) {
			p.push(
				{
					verb: 'move',
					subject: {
						k: 'all',
						filter: {
							...f,
							zone: 'graveyard',
							...(hauntM[3].toLowerCase() === 'your' ? { owner: 'you' } : {})
						}
					},
					params: {
						from: 'graveyard',
						to: 'battlefield',
						underYourControl: true,
						choiceCount: cnt,
						upTo: true
					},
					span
				},
				true
			);
			return true;
		}
	}

	// 30. *Blue Mage's Cane* quoted trigger: "if you do, copy it" + "you may cast the copy by paying {3} rather than paying its mana cost"
	if (/^if you do,\s*copy (?:it|that card)$/i.test(t) && p.steps.length > 0) {
		const prevIdx = p.steps.length - 1;
		const prev = p.steps[prevIdx];
		if (prev?.verb === 'exile') {
			const bindName = prev.bindAs ?? `b${prevIdx}`;
			prev.bindAs = bindName;
			p.push(
				{
					verb: 'castFree',
					subject: { k: 'binding', name: bindName },
					params: {
						castFreeSpec: {
							copyCardFirst: true,
							withoutPayingManaCost: true
						}
					},
					span
				},
				true
			);
			return true;
		}
	}
	const castCopyStepM = t.match(
		/^you may cast (?:the copy|that copy)(?:( without paying its mana cost)| by paying ((?:\{[^}]+\})+) rather than paying its mana cost)?$/i
	);
	if (castCopyStepM && p.steps.length > 0) {
		const prevIdx = p.steps.length - 1;
		const prev = p.steps[prevIdx];
		if (prev?.verb === 'castFree' && prev.params?.castFreeSpec?.copyCardFirst) {
			prev.params = {
				...prev.params,
				castFreeSpec: {
					...prev.params.castFreeSpec,
					withoutPayingManaCost: Boolean(castCopyStepM[1]),
					...(castCopyStepM[2] ? { alternativeManaCost: castCopyStepM[2].toUpperCase() } : {})
				}
			};
			p.lastOptionalStep = prevIdx;
			return true;
		}
	}

	// 31. *Florian, Voldaren Scion* / *Cream of the Crop*: "(You may )look at the top X cards of your library, where X is ..."
	const dynDigM = t.match(
		/^(you may )?look at the top (\S+) cards? of your library,\s*where \S+ is (.+)$/i
	);
	if (dynDigM) {
		const isMay = Boolean(dynDigM[1]);
		const exprRaw = dynDigM[3].trim();
		let digAmt: Amount | null = null;
		if (/^the total amount of life your opponents lost this turn$/i.test(exprRaw)) {
			digAmt = { k: 'opponentsLifeLostThisTurn' };
		} else if (/^that creature's power$/i.test(exprRaw)) {
			digAmt = { k: 'stat', of: { k: 'eventObject' }, stat: 'power' };
		}
		if (digAmt) {
			const idx = p.push(
				{
					verb: 'dig',
					subject: { k: 'none' },
					amount: digAmt,
					...(isMay ? { optional: { chooser: { k: 'you' } } } : {}),
					params: {
						dig: {
							keep: 1,
							upTo: false,
							keepTo: 'hand',
							rest: 'libraryBottom'
						}
					},
					span
				},
				false
			);
			if (isMay) p.lastOptionalStep = idx;
			return true;
		}
	}
	if (
		/^exile one of those cards and put the rest on the bottom of your library in a random order$/i.test(t) &&
		p.steps.length > 0
	) {
		const prevIdx = p.steps.length - 1;
		const prev = p.steps[prevIdx];
		if (prev?.verb === 'dig' && prev.params?.dig) {
			prev.params = {
				...prev.params,
				dig: {
					...prev.params.dig,
					keep: 1,
					upTo: false,
					keepTo: 'exile',
					rest: 'libraryBottom',
					restOrder: 'random',
					restRandom: true
				}
			};
			const bindName = prev.bindAs ?? `b${prevIdx}`;
			prev.bindAs = bindName;
			p.lastObject = { ref: { k: 'binding', name: bindName }, stepIndex: prevIdx };
			return true;
		}
	}
	if (
		/^(?:if you do,\s*)?put one of those cards on top of your library and the rest on the bottom of your library in any order$/i.test(
			t
		) &&
		p.steps.length > 0
	) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'dig' && prev.params?.dig) {
			prev.params = {
				...prev.params,
				dig: {
					...prev.params.dig,
					keep: 1,
					upTo: false,
					keepTo: 'libraryTop',
					rest: 'libraryBottom',
					restOrder: 'any'
				}
			};
			return true;
		}
	}

	const normFilterPhrase = (raw: string): ObjectFilter | null => {
		const stripped = raw
			.trim()
			.replace(/^(?:a|an)\s+/i, '')
			.trim();
		if (/^nonland cards?$/i.test(stripped)) return { notTypes: ['Land'] };
		if (/^basic land cards?$/i.test(stripped)) return { supertypes: ['Basic'], types: ['Land'] };
		return h.objectFilter(stripped) ?? h.objectFilter(stripped.replace(/\s+cards?$/i, '').trim());
	};

	// 32. *Creative Technique*: "Shuffle your library, then reveal cards from the top of it until you reveal a nonland card." + follow-ups
	const shufRevealM = t.match(
		/^shuffle your library,\s*then reveal cards from the top of it until you reveal (.+)$/i
	);
	if (shufRevealM) {
		const uf = normFilterPhrase(shufRevealM[1]);
		if (uf) {
			delete uf.zone;
			p.push(
				{
					verb: 'search',
					subject: { k: 'none' },
					amount: { k: 'const', n: 0 },
					params: {
						search: {
							filter: { types: ['Conspiracy'] },
							count: 0,
							upTo: true,
							statedQuality: true,
							destinations: []
						}
					},
					span
				},
				false
			);
			p.push(
				{
					verb: 'exileUntil',
					subject: { k: 'none' },
					params: {
						exileUntilSpec: {
							filter: uf,
							hitAction: 'stayExiled',
							restDestination: 'libraryBottomRandom'
						}
					},
					span
				},
				true
			);
			return true;
		}
	}
	if (
		/^exile that card and put the rest on the bottom of your library in a random order$/i.test(t) &&
		p.steps.length > 0
	) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'exileUntil' && prev.params?.exileUntilSpec) {
			prev.params = {
				...prev.params,
				exileUntilSpec: {
					...prev.params.exileUntilSpec,
					restDestination: 'libraryBottomRandom'
				}
			};
			return true;
		}
	}
	if (
		/^you may cast (?:that card|the exiled card|it) without paying its mana cost$/i.test(t) &&
		p.steps.length > 0
	) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'exileUntil' && prev.params?.exileUntilSpec) {
			prev.params = {
				...prev.params,
				exileUntilSpec: {
					...prev.params.exileUntilSpec,
					hitAction: 'castFree',
					spellsOnly: true
				}
			};
			return true;
		}
	}

	// 33. *Riveteers Overlook* / *Cabaretti Courtyard* / *Maestros Theater* / *Obscura Storefront* / *Brokers Hideout*:
	//     "search your library for a basic <X, Y, or Z> card, put it onto the battlefield tapped, then shuffle and you gain 1 life"
	const capennaM = t.match(
		/^search your library for a basic ([a-z]+(?:,\s*[a-z]+)*(?:,?\s+or\s+[a-z]+)?)\s+card,\s*put it onto the battlefield tapped,\s*then shuffle(?:\s+and\s+you\s+gain\s+(\d+|a|one)\s+life)?$/i
	);
	if (capennaM) {
		const rawTypes = capennaM[1]
			.split(/\s*(?:,\s*(?:or\b)?|\bor\b)\s*/i)
			.map((s) => s.trim())
			.filter(Boolean)
			.map((s) => s[0]!.toUpperCase() + s.slice(1).toLowerCase());
		const basics = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']);
		if (rawTypes.length >= 2 && rawTypes.every((s) => basics.has(s))) {
			p.push(
				{
					verb: 'search',
					subject: { k: 'none' },
					params: {
						search: {
							filter: {
								supertypes: ['Basic'],
								types: ['Land'],
								anyOf: rawTypes.map((sub) => ({ subtypes: [sub] }))
							},
							count: 1,
							upTo: false,
							statedQuality: true,
							destinations: [{ zone: 'battlefield', tapped: true }],
							description: `a basic ${capennaM[1]} card`
						}
					},
					span
				},
				false
			);
			if (capennaM[2]) {
				const rawG = capennaM[2].toLowerCase();
				const lifeAmt = rawG === 'a' || rawG === 'one' ? 1 : Number.parseInt(rawG, 10);
				if (lifeAmt > 0) {
					p.push(
						{
							verb: 'gainLife',
							subject: YOU,
							amount: { k: 'const', n: lifeAmt },
							span
						},
						false
					);
				}
			}
			return true;
		}
	}

	// 34. *Demolition Field*: "That land's controller may search their library for a basic land card, put it onto the battlefield, then shuffle"
	const thatCtrlSearchM = t.match(
		/^that (?:land|permanent|creature)'s controller (?:may )?search(?:es)? their library for (.+?),\s*put (?:it|that card) onto the battlefield( tapped)?,\s*then shuffle$/i
	);
	if (thatCtrlSearchM) {
		const f = normFilterPhrase(thatCtrlSearchM[1]);
		if (f) {
			delete f.zone;
			p.push(
				{
					verb: 'search',
					subject: { k: 'none' },
					params: {
						search: {
							filter: f,
							count: 1,
							upTo: true,
							statedQuality: true,
							destinations: [
								{
									zone: 'battlefield',
									...(thatCtrlSearchM[2] ? { tapped: true } : {})
								}
							],
							targetControllerAsActor: true,
							description: thatCtrlSearchM[1].trim()
						}
					},
					span
				},
				false
			);
			return true;
		}
	}

	// 35. *Rampant Rejuvenator* / *Prismatic Undercurrents*: "search your library for up to X basic land cards, where X is ..."
	const dynSearchM = t.match(
		/^search your library for up to X basic land cards,\s*where X is ([^.,]+?)(?:,\s*put (?:them|those cards) onto the battlefield( tapped)?,\s*then shuffle)?$/i
	);
	if (dynSearchM) {
		const rawX = dynSearchM[1].trim();
		let searchAmt: Amount | null = null;
		if (/^~'s power$/i.test(rawX)) {
			searchAmt = { k: 'stat', of: { k: 'self' }, stat: 'power' };
		} else if (/^the number of colors among permanents you control$/i.test(rawX)) {
			searchAmt = { k: 'colorsAmongPermanents', player: { k: 'you' } };
		}
		if (searchAmt) {
			const hasInlineDest = /put (?:them|those cards) onto the battlefield/i.test(t);
			p.push(
				{
					verb: 'search',
					subject: { k: 'none' },
					amount: searchAmt,
					params: {
						search: {
							filter: { supertypes: ['Basic'], types: ['Land'] },
							count: 1,
							upTo: true,
							statedQuality: true,
							destinations: [
								{
									zone: 'battlefield',
									...(dynSearchM[2] ? { tapped: true } : {})
								}
							],
							description: 'up to X basic land cards'
						}
					},
					span
				},
				false
			);
			if (!hasInlineDest) {
				// Follow-up sentence will update destination/reveal if needed; default already safe
			}
			return true;
		}
	}
	const dynSearchFollowM = t.match(
		/^(reveal those cards,\s*)?put (?:them|those cards) (onto the battlefield( tapped)?|into your hand),\s*then shuffle$/i
	);
	if (dynSearchFollowM && p.steps.length > 0) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'search' && prev.params?.search && prev.amount && prev.amount.k !== 'const') {
			const isHand = /into your hand/i.test(dynSearchFollowM[2]);
			prev.params = {
				...prev.params,
				search: {
					...prev.params.search,
					...(dynSearchFollowM[1] ? { reveal: true } : {}),
					destinations: [
						isHand
							? { zone: 'hand' }
							: { zone: 'battlefield', ...(dynSearchFollowM[3] ? { tapped: true } : {}) }
					]
				}
			};
			return true;
		}
	}

	return false;
}
