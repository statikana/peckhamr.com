/**
 * Wave 9 trigger header & intervening-if condition parsers (pure compiler helper).
 *
 * Extracted from `compiler/triggers.ts` to keep that module clean and readable while covering
 * the remaining trigger headers, complex intervening-if clauses, and object filter qualifiers.
 */
import type {
	Condition,
	EventFilter,
	ObjectFilter,
	PlayerFilter,
	TriggerDef
} from '../ir.ts';
import type { CounterType } from '../types.ts';

export interface TriggersWave9Helpers {
	parseObjectPhrase: (phrase: string) => ObjectFilter | null;
	objectSubject: (phrase: string) => { object?: ObjectFilter | 'self' | 'attachedTo'; oneOrMore?: boolean; orSelf?: boolean } | null;
	parseCounterType: (raw: string) => CounterType | null;
	numberWord: (raw: string) => number | null;
	objectFilterProblem: (f: ObjectFilter | undefined) => string | null;
}

const ABILITY_TYPE_WORDS: Record<string, string> = {
	artifact: 'Artifact',
	artifacts: 'Artifact',
	creature: 'Creature',
	creatures: 'Creature',
	land: 'Land',
	lands: 'Land',
	enchantment: 'Enchantment',
	enchantments: 'Enchantment',
	planeswalker: 'Planeswalker',
	planeswalkers: 'Planeswalker',
	battle: 'Battle',
	battles: 'Battle'
};

function parseAnyOfTypeList(raw: string, zone?: ObjectFilter['zone']): ObjectFilter | null {
	const cleaned = raw
		.trim()
		.replace(/^an?\s+/i, '')
		.replace(/,\s*or\s+/gi, ', ')
		.replace(/\s+or\s+/gi, ', ');
	const parts = cleaned
		.split(/\s*,\s*/)
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	if (parts.length === 0) return null;
	const mapped: ObjectFilter[] = [];
	for (const p of parts) {
		const canonical = ABILITY_TYPE_WORDS[p];
		if (!canonical) return null;
		mapped.push({ types: [canonical], ...(zone ? { zone } : {}) });
	}
	return mapped.length === 1 ? mapped[0] : { anyOf: mapped, ...(zone ? { zone } : {}) };
}

export function parseWave9ObjectQualifiers(
	rest: string,
	outer: ObjectFilter,
	parseCounterType: (raw: string) => CounterType | null,
	numberWord: (raw: string) => number | null
): { handled: boolean; rest: string } {
	// "with power or toughness 1 or less / 2 or greater" (*Arnyn, Deathbloom Botanist*)
	const ptOr = rest.match(/^(.+?)\s+with power or toughness (\S+) or (less|lower|greater|more|higher)$/i);
	if (ptOr && outer.powerOrToughness === undefined) {
		const n = numberWord(ptOr[2]);
		if (n !== null) {
			const dir = ptOr[3].toLowerCase();
			outer.powerOrToughness = {
				op: dir === 'less' || dir === 'lower' ? '<=' : '>=',
				value: { k: 'const', n }
			};
			return { handled: true, rest: ptOr[1].trim() };
		}
	}
	// "with a <counter> counter on it" (*Necroskitter*, *The Reaper, King No More*)
	const withTypedCounter = rest.match(/^(.+?)\s+with (?:a|an) (.+?) counter on (?:it|them)$/i);
	if (withTypedCounter && outer.hasCounters === undefined) {
		const ct = parseCounterType(withTypedCounter[2].trim());
		if (ct) {
			outer.hasCounters = ct;
			return { handled: true, rest: withTypedCounter[1].trim() };
		}
	}
	// "with a counter on it" (*Puca's Covenant* etc.)
	const withAnyCounter = rest.match(/^(.+?)\s+with a counter on (?:it|them)$/i);
	if (withAnyCounter && outer.hasAnyCounter === undefined) {
		outer.hasAnyCounter = true;
		return { handled: true, rest: withAnyCounter[1].trim() };
	}
	return { handled: false, rest };
}

export function parseTriggerHeadWave9(
	head: string,
	h: TriggersWave9Helpers
): TriggerDef | null {
	const t = head.trim();
	const whenM = t.match(/^(when|whenever)\s+(.+)$/i);
	const atM = t.match(/^at\s+the\s+beginning\s+of\s+(.+)$/i);

	if (atM) {
		const rest = atM[1].trim();
		// *Tenuous Truce*: "At the beginning of enchanted opponent's end step"
		if (/^enchanted opponent's end step$/i.test(rest)) {
			return {
				event: 'phaseBegin',
				filter: { phase: 'end_step', enchantedOpponentEndStep: true },
				scope: 'opponent_turn'
			};
		}
		return null;
	}

	if (!whenM) return null;
	const body = whenM[2].trim();

	// 1. *Ainok Strike Leader*: "Whenever you attack with ~ and/or your commander"
	if (/^you attack with ~ and\/or your commander$/i.test(body)) {
		return {
			event: 'attacks',
			filter: { player: { relation: 'you' }, object: 'self', orCommander: true }
		};
	}

	// 2. *Tenuous Truce*: "When you attack enchanted opponent or a planeswalker they control or when they attack you or a planeswalker you control"
	if (
		/^you attack enchanted opponent or a planeswalker they control or when they attack you or a planeswalker you control$/i.test(
			body
		)
	) {
		return {
			event: 'attacks',
			filter: { attackEnchantedOrAttackedByEnchanted: true }
		};
	}

	// 3. *Avalanche of Sector 7*, *Harsh Mentor*: "Whenever <player> activates an ability of <source>"
	const oppActM = body.match(/^(you|a player|an opponent) activates? an ability of (.+)$/i);
	if (oppActM) {
		const plRel: PlayerFilter['relation'] =
			oppActM[1].toLowerCase() === 'you'
				? 'you'
				: oppActM[1].toLowerCase() === 'an opponent'
					? 'opponent'
					: 'any';
		let srcDesc = oppActM[2].trim();
		let isNonManaAbility = false;
		if (/,\s*if it isn't a mana ability$/i.test(srcDesc)) {
			isNonManaAbility = true;
			srcDesc = srcDesc.replace(/,\s*if it isn't a mana ability$/i, '').trim();
		}
		let controlledByEventPlayer = false;
		const theyCtrlM = srcDesc.match(/^(.+?)\s+they control$/i);
		if (theyCtrlM) {
			controlledByEventPlayer = true;
			srcDesc = theyCtrlM[1].trim();
		}
		let onBattlefield = false;
		const onBfM = srcDesc.match(/^(.+?)\s+on the battlefield$/i);
		if (onBfM) {
			onBattlefield = true;
			srcDesc = onBfM[1].trim();
		}
		let abilitySourceFilter: EventFilter['abilitySourceFilter'] | undefined;
		if (srcDesc === '~') {
			abilitySourceFilter = 'self';
		} else {
			const anyOfTypes = parseAnyOfTypeList(srcDesc, onBattlefield ? 'battlefield' : undefined);
			if (anyOfTypes) {
				abilitySourceFilter = anyOfTypes;
			} else {
				const parsed = h.parseObjectPhrase(srcDesc);
				if (parsed) {
					if (onBattlefield) parsed.zone = 'battlefield';
					abilitySourceFilter = parsed;
				}
			}
		}
		if (
			abilitySourceFilter &&
			(typeof abilitySourceFilter !== 'object' || !h.objectFilterProblem(abilitySourceFilter))
		) {
			return {
				event: 'abilityActivated',
				filter: {
					player: { relation: plRel },
					abilitySourceFilter,
					...(controlledByEventPlayer ? { abilitySourceControlledByEventPlayer: true } : {}),
					...(isNonManaAbility ? { isNonManaAbility: true } : {})
				}
			};
		}
	}

	// 4. *Coveted Jewel*: "Whenever one or more creatures an opponent controls attack you and aren't blocked"
	if (/^one or more creatures an opponent controls attack you and aren't blocked$/i.test(body)) {
		return {
			event: 'attackedAndUnblocked',
			filter: {
				player: { relation: 'opponent' },
				object: { types: ['Creature'], controller: 'opponent' },
				attackedTarget: 'you',
				oneOrMore: true,
				attackingUnblocked: true
			}
		};
	}

	// 5. *Crawling Sensation*: "Whenever one or more <filter> cards are put into your graveyard from anywhere for the first time each turn"
	const crawlM = body.match(
		/^one or more (.+?) cards? (?:is|are) put into (your|a) graveyard from anywhere for the first time each turn$/i
	);
	if (crawlM) {
		const f = h.parseObjectPhrase(crawlM[1].trim());
		if (f && !h.objectFilterProblem(f)) {
			delete f.zone;
			if (f.token === undefined) f.token = false;
			if (crawlM[2].toLowerCase() === 'your') f.owner = 'you';
			return {
				event: 'zoneChange',
				filter: {
					object: f,
					fromAnywhere: true,
					to: 'graveyard',
					oneOrMore: true,
					firstTimeEachTurn: true
				}
			};
		}
	}

	// *Mangara, the Diplomat*: "Whenever an opponent attacks with creatures"
	const atkWithCreaturesM = body.match(/^(an opponent|you|a player) attacks? with creatures$/i);
	if (atkWithCreaturesM) {
		const who = atkWithCreaturesM[1].toLowerCase();
		return {
			event: 'attacks',
			filter: {
				player: { relation: who === 'you' ? 'you' : who === 'an opponent' ? 'opponent' : 'any' },
				oneOrMore: true
			}
		};
	}

	// 6. *Emet-Selch of the Third Seat*: "Whenever one or more opponents lose life"
	if (/^one or more opponents lose life$/i.test(body)) {
		return {
			event: 'loseLife',
			filter: { player: { relation: 'opponent' }, oneOrMore: true }
		};
	}

	// 7. *Valgavoth, Harrower of Souls*: "Whenever an opponent loses life for the first time during each of their turns"
	if (/^an opponent loses life for the first time during each of their turns$/i.test(body)) {
		return {
			event: 'loseLife',
			filter: {
				player: { relation: 'opponent' },
				firstTimeEachTurn: true,
				duringTurn: 'eventPlayer'
			}
		};
	}

	// 8. *Firebender Ascension*: "Whenever <subject> attacking causes a triggered ability of that <noun> to trigger"
	const firebenderM = body.match(
		/^(.+?) attacking causes a triggered ability of that \S+ to trigger$/i
	);
	if (firebenderM) {
		const subj = h.objectSubject(firebenderM[1].trim());
		if (subj && typeof subj.object === 'object' && !h.objectFilterProblem(subj.object)) {
			return {
				event: 'attackTriggered',
				filter: { object: subj.object }
			};
		}
	}

	// 9. *Jiang Yanggu, Alone*: "Whenever a creature you control attacks a player alone"
	const atkPlayerAloneM = body.match(/^(.+?) attacks? a player alone$/i);
	if (atkPlayerAloneM) {
		const subj = h.objectSubject(atkPlayerAloneM[1].trim());
		if (subj) {
			return {
				event: 'attacks',
				filter: {
					object: subj.object,
					alone: true,
					attackedTarget: 'anyPlayer',
					...(subj.orSelf ? { orSelf: true } : {})
				}
			};
		}
	}

	// 10. *Shredder, Shadow Master*: "Whenever ~ attacks a player"
	const atkPlayerM = body.match(/^(~|.+) attacks? a player$/i);
	if (atkPlayerM) {
		const subj = atkPlayerM[1].trim() === '~' ? { object: 'self' as const } : h.objectSubject(atkPlayerM[1].trim());
		if (subj) {
			return {
				event: 'attacks',
				filter: {
					object: subj.object,
					attackedTarget: 'anyPlayer',
					perAttackedPlayer: true,
					...('orSelf' in subj && subj.orSelf ? { orSelf: true } : {})
				}
			};
		}
	}

	// 11. *Jolly Gerbils*: "Whenever you give a gift"
	if (/^you give a gift$/i.test(body)) {
		return { event: 'giftGiven', filter: { player: { relation: 'you' } } };
	}

	// 12. *Laelia, the Blade Reforged*: "Whenever one or more cards are put into exile from your library and/or your graveyard"
	const exileFromZonesM = body.match(
		/^one or more cards? (?:is|are) put into exile from your (library|graveyard) and\/or your (library|graveyard)$/i
	);
	if (exileFromZonesM) {
		const z1 = exileFromZonesM[1].toLowerCase() as 'library' | 'graveyard';
		const z2 = exileFromZonesM[2].toLowerCase() as 'library' | 'graveyard';
		return {
			event: 'zoneChange',
			filter: {
				object: { owner: 'you' },
				to: 'exile',
				fromZones: z1 === z2 ? [z1] : [z1, z2],
				oneOrMore: true
			}
		};
	}

	// 13. *Mindblade Render*: "Whenever your opponents are dealt combat damage"
	if (/^your opponents are dealt combat damage$/i.test(body)) {
		return {
			event: 'combatDamageBatchPlayer',
			filter: {
				player: { relation: 'opponent' },
				combatDamageBatchPlayer: 'opponent',
				oneOrMore: true
			}
		};
	}

	// 14. *Pain Magnification*: "Whenever an opponent is dealt N or more damage by a single source"
	const painM = body.match(
		/^(an opponent|a player|you) (?:is|are) dealt (\S+) or more damage by a single source$/i
	);
	if (painM) {
		const minDmg = h.numberWord(painM[2]);
		if (minDmg !== null && minDmg >= 1) {
			const who = painM[1].toLowerCase();
			return {
				event: 'dealtDamage',
				filter: {
					damagedPlayer: who === 'you' ? 'you' : who === 'an opponent' ? 'opponent' : 'any',
					singleSourceDamageMin: minDmg
				}
			};
		}
	}

	// 15. *Professor Hojo*: "Whenever one or more <objects> become(s) the target of an activated ability"
	const tgtActM = body.match(/^(one or more )?(.+?) becomes? the target of an activated ability$/i);
	if (tgtActM) {
		const subj = h.objectSubject((tgtActM[1] ?? '') + tgtActM[2].trim());
		if (subj) {
			return {
				event: 'becomesTarget',
				filter: {
					object: subj.object,
					targetedBy: 'ability',
					targetedByActivatedAbility: true,
					...(tgtActM[1] || subj.oneOrMore ? { oneOrMore: true } : {}),
					...(subj.orSelf ? { orSelf: true } : {})
				}
			};
		}
	}

	// 16. *Rosie Cotton of South Lane*: "Whenever you create a token"
	if (/^you create a token$/i.test(body)) {
		return {
			event: 'tokenCreated',
			filter: { player: { relation: 'you' } }
		};
	}

	// 17. *Szarel, Genesis Shepherd*: "Whenever you sacrifice another nontoken permanent during your turn"
	const sacDuringTurnM = body.match(
		/^(you|a player|an opponent) sacrifices? (.+?) during (your|their|an opponent's) turn$/i
	);
	if (sacDuringTurnM) {
		const subj = h.objectSubject(sacDuringTurnM[2].trim());
		if (subj) {
			const rel: PlayerFilter['relation'] =
				sacDuringTurnM[1].toLowerCase() === 'you'
					? 'you'
					: sacDuringTurnM[1].toLowerCase() === 'an opponent'
						? 'opponent'
						: 'any';
			const dtRaw = sacDuringTurnM[3].toLowerCase();
			const duringTurn: EventFilter['duringTurn'] =
				dtRaw === 'your' ? 'your' : dtRaw === 'their' ? 'eventPlayer' : 'opponent';
			return {
				event: 'sacrificed',
				filter: {
					player: { relation: rel },
					object: subj.object,
					duringTurn,
					...(subj.orSelf ? { orSelf: true } : {})
				}
			};
		}
	}

	// 18. *Tameshi, Reality Architect*: "Whenever one or more <objects> are returned to hand"
	const retHandM = body.match(
		/^(one or more )?(.+?) (?:is|are) returned to (?:their owners' hands?|its owner's hand|hand)$/i
	);
	if (retHandM) {
		const subj = h.objectSubject((retHandM[1] ?? '') + retHandM[2].trim());
		if (subj) {
			return {
				event: 'zoneChange',
				filter: {
					object: subj.object,
					from: 'battlefield',
					to: 'hand',
					...(retHandM[1] || subj.oneOrMore ? { oneOrMore: true } : {}),
					...(subj.orSelf ? { orSelf: true } : {})
				}
			};
		}
	}

	// 19. *Ugin's Mastery*: "Whenever you attack with creatures with total power N or greater"
	const atkTotalPowerM = body.match(/^you attack with creatures with total power (\S+) or greater$/i);
	if (atkTotalPowerM) {
		const minPwr = h.numberWord(atkTotalPowerM[1]);
		if (minPwr !== null && minPwr >= 1) {
			return {
				event: 'attacks',
				filter: {
					player: { relation: 'you' },
					oneOrMore: true,
					attackingTotalPowerMin: minPwr
				}
			};
		}
	}

	// 20. *Azra Oddsmaker* / *Tamiyo* / *Hunter's Insight* delayed combat damage triggers when compiled standalone
	const delayedCombatM = body.match(
		/^(?:that creature|either of those creatures) deals combat damage(?: to (?:a player or planeswalker|a player))?(?: this turn)?$/i
	);
	if (delayedCombatM) {
		const dmgTo = /to a player or planeswalker/i.test(body)
			? ('playerOrPlaneswalker' as const)
			: /to a player/i.test(body)
				? ('player' as const)
				: ('any' as const);
		return {
			event: 'dealsDamage',
			filter: {
				object: { types: ['Creature'] },
				combat: true,
				damageTo: dmgTo,
				watchedBoundObject: true
			}
		};
	}

	// 21. *Syr Konrad, the Grim*: multi-OR creature dies / put into graveyard from elsewhere / leaves your graveyard
	if (
		/^another creature dies, or a creature card is put into a graveyard from anywhere other than the battlefield, or a creature card leaves your graveyard$/i.test(
			body
		)
	) {
		return {
			event: 'zoneChange',
			filter: { object: { types: ['Creature'], other: true }, from: 'battlefield', to: 'graveyard' },
			or: [
				{
					event: 'zoneChange',
					filter: {
						object: { types: ['Creature'], token: false },
						fromAnywhere: true,
						to: 'graveyard',
						notFromZone: 'battlefield'
					}
				},
				{
					event: 'zoneChange',
					filter: { object: { types: ['Creature'], token: false, owner: 'you' }, from: 'graveyard' }
				}
			]
		};
	}

	return null;
}

export function parseTriggerConditionWave9(
	t: string,
	h: TriggersWave9Helpers
): Condition | null {
	// *Moraug, Fury of Akoum*: "if it's your main phase"
	if (/^if it's your main phase$/i.test(t)) {
		return { k: 'isYourMainPhase' };
	}
	// *Wakka, Devoted Guardian*: "if a counter was put on ~ this turn"
	if (/^if a counter was put on ~ this turn$/i.test(t)) {
		return { k: 'counterPutOnSelfThisTurn' };
	}
	// *Harsh Mentor*: "if it isn't a mana ability"
	if (/^if (?:that ability|it) isn't a mana ability$/i.test(t)) {
		return { k: 'eventAbilityIsNotMana' };
	}
	// *Confounding Conundrum*: "if that player had another land enter the battlefield under their control this turn"
	if (/^if that player had another land enter the battlefield under their control this turn$/i.test(t)) {
		return { k: 'playerHadAnotherLandEnterThisTurn' };
	}
	// *Celes* / *Kotis*: "if one or more of them entered from a graveyard or was cast from a graveyard"
	if (/^if one or more of them entered from a graveyard or was cast from a graveyard$/i.test(t)) {
		return { k: 'eventEnteredOrCastFromGraveyardAny' };
	}
	// *Evercoat Ursine*: "if there are cards exiled with it"
	if (/^if there are cards? exiled with (?:it|~)$/i.test(t)) {
		return { k: 'hasCardsExiledWithSelf' };
	}
	// *Guardian Project*: "if it doesn't have the same name as another creature you control or a creature card in your graveyard"
	if (
		/^if it doesn't have the same name as another creature you control or a creature card in your graveyard$/i.test(
			t
		)
	) {
		return { k: 'noSameNameControlledOrInGraveyard' };
	}
	// *Jadar*: "if you control no creatures with decayed"
	const noCtrlKw = t.match(/^if you control no creatures with ([a-z]+)$/i);
	if (noCtrlKw) {
		return {
			k: 'compare',
			left: { k: 'count', of: { types: ['Creature'], controller: 'you', hasKeywords: [noCtrlKw[1].toLowerCase()] } },
			op: '=',
			right: { k: 'const', n: 0 }
		};
	}
	// *Kami of Transience*: "if an enchantment was put into your graveyard from the battlefield this turn"
	const yourGyM = t.match(
		/^if (?:(?:a|an)|(\S+) or more) (.+?) (?:was|were) put into your graveyard from the battlefield this turn$/i
	);
	if (yourGyM) {
		const minN = yourGyM[1] ? h.numberWord(yourGyM[1]) : 1;
		const f = h.parseObjectPhrase(yourGyM[2]);
		if (minN !== null && f && !h.objectFilterProblem(f)) {
			f.owner = 'you';
			return { k: 'zoneChangeFromToThisTurn', from: 'battlefield', to: 'graveyard', filter: f, min: minN };
		}
	}
	// *Kodama of the East Tree*: "if it wasn't put onto the battlefield with this ability"
	if (/^if it wasn't put onto the battlefield with this ability$/i.test(t)) {
		return { k: 'notPutOntoBattlefieldByThisAbility' };
	}
	// *Liberator*: "if the amount of mana spent to cast that spell is greater than ~'s power"
	if (/^if the amount of mana spent to cast that spell is greater than ~'s power$/i.test(t)) {
		return { k: 'manaSpentGreaterThanSelfPower' };
	}
	// *Lux Artillery*: "if there are thirty or more counters among artifacts and creatures you control"
	const countersAmongM = t.match(/^if there are (\S+) or more counters among (.+?) you control$/i);
	if (countersAmongM) {
		const min = h.numberWord(countersAmongM[1]);
		if (min !== null && min >= 1) {
			const groupRaw = countersAmongM[2].trim();
			const parsedGroup =
				groupRaw.toLowerCase() === 'artifacts and creatures'
					? { anyOf: [{ types: ['Artifact'], controller: 'you' as const }, { types: ['Creature'], controller: 'you' as const }] }
					: h.parseObjectPhrase(`${groupRaw} you control`);
			if (parsedGroup && !h.objectFilterProblem(parsedGroup)) {
				return { k: 'countersAmongFilterAtLeast', filter: parsedGroup, min };
			}
		}
	}
	// *Mangara, the Diplomat*: "if two or more of those creatures are attacking you and/or planeswalkers you control"
	const minAtkYouPw = t.match(
		/^if (\S+) or more of those creatures are attacking you and\/or planeswalkers you control$/i
	);
	if (minAtkYouPw) {
		const min = h.numberWord(minAtkYouPw[1]);
		if (min !== null && min >= 1) {
			return { k: 'eventMinAttackersToYouOrPlaneswalkers', min };
		}
	}
	// *Massacre Girl, Known Killer*: "if its toughness was less than 1"
	const tghLtM = t.match(/^if its toughness was less than (\S+)$/i);
	if (tghLtM) {
		const max = h.numberWord(tghLtM[1]);
		if (max !== null) {
			return { k: 'lkiToughnessLessThan', max };
		}
	}
	// *Mindblade Render*: "if any of that damage was dealt by a Warrior"
	const dmgBySubM = t.match(/^if any of that damage was dealt by (?:a|an) ([A-Za-z-]+)$/i);
	if (dmgBySubM) {
		return { k: 'eventDamageDealtBySubtype', subtype: dmgBySubM[1] };
	}
	// *Scourge of the Throne*: "if it's attacking the player with the most life or tied for most life"
	if (/^if it's attacking the player with the most life or tied for most life$/i.test(t)) {
		return { k: 'anyAttackedPlayerWithMostLife' };
	}
	// *The Chain Veil*: "if you didn't activate a loyalty ability of a planeswalker this turn"
	if (/^if you didn't activate a loyalty ability of a planeswalker this turn$/i.test(t)) {
		return { k: 'didntActivateLoyaltyThisTurn' };
	}
	// *Triskaidekaphile*: "if you have exactly thirteen cards in your hand"
	const exactHandM = t.match(/^if you have exactly (\S+) cards? in your hand$/i);
	if (exactHandM) {
		const n = h.numberWord(exactHandM[1]);
		if (n !== null && n >= 0) {
			return {
				k: 'compare',
				left: { k: 'cardsIn', zone: 'hand', of: { k: 'you' } },
				op: '=',
				right: { k: 'const', n }
			};
		}
	}

	return null;
}
