/**
 * Wave 8 — Track P22d runtime module (`effectsWave8.ts`):
 * - Extended `exileUntil` execution: `hitAction: 'stayExiled'` (*Undying Flames*, *The Tenth Doctor*)
 *   and explicit `actor` casting/exiling third-party libraries (*Dazzling Sphinx*, *Chaos Wand*).
 * - Extended `dig` execution: `keepTo: 'exile' | 'castFree'`, `rest: 'exile'`, `keepMaxManaValue`,
 *   `dig.playFromExile`, `keepAttackingPlayer`, binding kept cards, and `stepDecisions` tracking
 *   (*Cosmic Cube*, *Sunbird's Invocation*, *Keldon Flamesage*).
 * - Extended `preventDamage`: `chooseSource` (choose permanent or stack source),
 *   `nextDamageEventOnly` (`CR 615.4`), and `onPrevented` riders (`gainLifeEqual`,
 *   `putCountersEqual`, `dealDamageEqual`, `drawEqual`, `drawOne`) (*Cho-Arrim Alchemist*,
 *   *Refraction Trap*, *Test of Faith*).
 *
 * Strictly adheres to ENGINE_INVARIANTS.md:
 * - Zero rules-text reads at runtime.
 * - Zero card-name comparisons at runtime.
 * - Zero direct zone mutations (all zone moves route through `runtime/zones.ts`).
 * - Zero unbounded loops; 100% plain-JSON state & continuations; deterministic PRNG (`nextRandom`).
 */

import type {
	DamagePreventionSpec,
	EffectStep,
	ObjectFilter,
	Selector
} from '../ir.ts';
import type {
	CardInstance,
	ChoiceAnswer,
	CounterType,
	DamagePreventionShieldEntry,
	GameState,
	PlayerGameState,
	TargetRef,
	ZoneType
} from '../types.ts';
import {
	addDamagePreventionShield,
	registerEnteredAttackingCombatant
} from './copyPreventionAndEffects.ts';
import { executeCastFree } from './effectsWave6.ts';
import { getP19aRuntimeHost, type P19aStepHost } from './effectsWave7.ts';
import { resolveObjectFaces } from './faces.ts';
import {
	matchesObjectFilter,
	objectManaValue,
	type FilterContext
} from './objectFilter.ts';
import { nextRandom } from './random.ts';
import { moveObject, rearrangeLibrary, shuffleLibrary } from './zones.ts';

function shuffleIdsDeterministic(state: GameState, ids: readonly string[]): string[] {
	const arr = [...ids];
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(nextRandom(state) * (i + 1));
		[arr[i], arr[j]] = [arr[j]!, arr[i]!];
	}
	return arr;
}

function cardHasCastableSpellFace(inst: CardInstance): boolean {
	const base = resolveObjectFaces(inst.copiableCard ?? inst.card, {
		zone: inst.zone,
		faceIndex: inst.activeFaceIndex
	});
	if (!base.types.includes('Land')) return true;
	const faces = (inst.copiableCard ?? inst.card).faces;
	return Boolean(
		faces &&
			faces.some(
				(_, idx) =>
					!resolveObjectFaces(inst.copiableCard ?? inst.card, {
						zone: inst.zone,
						faceIndex: idx
					}).types.includes('Land')
			)
	);
}

/**
 * Resolves `exileUntil` when Wave 8 fields (`hitAction === 'stayExiled'` or `spec.actor`) are used.
 */
export function executeExileUntilWave8(host: P19aStepHost, step: EffectStep): void {
	const spec = step.params?.exileUntilSpec;
	const rt = getP19aRuntimeHost();
	if (!spec) return;
	const s = host.state;
	const you = host.you;

	const libPlayers = spec.libraryOwner ? host.players(spec.libraryOwner) : [you];
	if (libPlayers.length === 0) return;

	const castActor =
		(spec.actor ? host.players({ k: 'playerRef', ref: spec.actor })[0] : undefined) ?? you;

	const stateKey = `p22d_exile_until:${host.stepIndex}`;
	const savedState = host.answers[stateKey];

	for (let pIdx = 0; pIdx < libPlayers.length; pIdx++) {
		const libPl = libPlayers[pIdx]!;
		if (libPl.lost) continue;
		const plDoneKey = `${stateKey}:done:${libPl.playerId}`;
		if (host.answers[plDoneKey]) continue;

		const plExiledKey = `${stateKey}:exiled:${libPl.playerId}`;
		let exiledIds: string[] = [];
		let hitId: string | null = null;

		const existingExiled = host.answers[plExiledKey];
		if (existingExiled && existingExiled.kind === 'chooseObjects') {
			const raw = existingExiled.objectIds;
			hitId = raw[0] === '__NONE__' ? null : (raw[0] ?? null);
			exiledIds = raw.slice(1);
		} else {
			const fctx: FilterContext = {
				state: s,
				controllerId: castActor.playerId,
				source: host.locate(host.sourceId)?.inst,
				stackItem: host.item,
				zone: 'exile'
			};
			const maxCards = Math.min(250, libPl.library.length);
			for (let guard = 0; guard < maxCards; guard++) {
				const topCard = libPl.library[0];
				if (!topCard) break;
				moveObject(s, topCard, 'exile', {
					from: { player: libPl, zone: 'library' },
					toPlayer: libPl,
					bumpVersion: true,
					newTimestamp: true
				});
				exiledIds.push(topCard.instanceId);
				if (matchesObjectFilter(topCard, spec.filter, fctx)) {
					hitId = topCard.instanceId;
					break;
				}
			}
			host.answers[plExiledKey] = {
				kind: 'chooseObjects',
				objectIds: [hitId ?? '__NONE__', ...exiledIds]
			};
		}

		const hitInst = hitId
			? s.players.flatMap((pl) => pl.exile).find((c) => c.instanceId === hitId)
			: undefined;

		if (hitInst) {
			if (spec.hitAction === 'stayExiled' || spec.hitAction === 'none') {
				host.bind(step, [hitInst]);
			} else if (spec.hitAction === 'playThisTurn' || spec.hitAction === 'playUntilEndOfNextTurn') {
				const turnSerial = s.turnSerial ?? s.turnNumber;
				hitInst.playableFromExileBy = {
					playerId: castActor.playerId,
					sourceName: host.sourceCard.name,
					duration:
						spec.hitAction === 'playUntilEndOfNextTurn'
							? 'untilEndOfYourNextTurn'
							: 'thisTurn',
					expiresAtEndOfTurn: spec.hitAction === 'playThisTurn',
					...(spec.hitAction === 'playUntilEndOfNextTurn'
						? {
								expiresOnCleanupOfPlayerId: castActor.playerId,
								grantedOnTurnSerial: turnSerial
							}
						: {}),
					spendManaAsAnyColor: Boolean(spec.spendManaAsAnyColor),
					...(spec.spellsOnly ? { spellsOnly: true } : {})
				};
				host.bind(step, [hitInst]);
			} else if (spec.hitAction === 'hand') {
				const owner = s.players.find((pl) => pl.playerId === hitInst.ownerId) ?? libPl;
				moveObject(s, hitInst, 'hand', {
					from: { player: owner, zone: 'exile' },
					toPlayer: castActor,
					bumpVersion: true,
					newTimestamp: true
				});
				host.bind(step, [hitInst]);
			} else if (spec.hitAction === 'battlefield') {
				const owner = s.players.find((pl) => pl.playerId === hitInst.ownerId) ?? libPl;
				moveObject(s, hitInst, 'battlefield', {
					from: { player: owner, zone: 'exile' },
					toPlayer: castActor,
					controllerId: castActor.playerId,
					bumpVersion: true,
					newTimestamp: true
				});
				rt?.triggerOnEtb(s, castActor, hitInst);
				host.bind(step, [hitInst]);
			} else if (spec.hitAction === 'castFree') {
				const synBind = `__p22d_exuntil_${host.stepIndex}_${libPl.playerId}`;
				const castStep: EffectStep = {
					verb: 'castFree',
					subject: { k: 'binding', name: synBind },
					...(spec.actor ? { actor: spec.actor } : {}),
					params: {
						castFreeSpec: {
							withoutPayingManaCost: true
						}
					},
					span: step.span
				};
				host.bind({ ...step, bindAs: synBind }, [hitInst]);
				executeCastFree(host.p16aHost(), castStep);
				if (s.pendingPrompts.length > 0 && !savedState) {
					if (host.item.effectResume) {
						host.markPaused();
						return;
					}
				}
				const stillInExile = s.players
					.flatMap((pl) => pl.exile)
					.find((c) => c.instanceId === hitInst.instanceId);
				if (stillInExile && spec.fallbackToHand) {
					const owner = s.players.find((pl) => pl.playerId === stillInExile.ownerId) ?? libPl;
					moveObject(s, stillInExile, 'hand', {
						from: { player: owner, zone: 'exile' },
						toPlayer: castActor,
						bumpVersion: true,
						newTimestamp: true
					});
				}
				host.bind(step, [hitInst]);
			}
		} else {
			const allExiled = exiledIds
				.map((id) => s.players.flatMap((pl) => pl.exile).find((c) => c.instanceId === id))
				.filter((c): c is CardInstance => Boolean(c));
			host.bind(step, allExiled);
		}

		if (spec.restDestination === 'libraryBottomRandom') {
			const keepHitInExile =
				spec.hitAction === 'stayExiled' ||
				spec.hitAction === 'playThisTurn' ||
				spec.hitAction === 'playUntilEndOfNextTurn' ||
				spec.hitAction === 'none';
			const toBottomIds = exiledIds.filter((id) => !(keepHitInExile && id === hitId));
			const stillExiled = toBottomIds.filter((id) =>
				libPl.exile.some((c) => c.instanceId === id)
			);
			const orderedIds = shuffleIdsDeterministic(s, stillExiled);
			for (const id of orderedIds) {
				const cardInst = libPl.exile.find((c) => c.instanceId === id);
				if (!cardInst) continue;
				moveObject(s, cardInst, 'library', {
					from: { player: libPl, zone: 'exile' },
					toPlayer: libPl,
					insert: 'end',
					bumpVersion: true,
					newTimestamp: true
				});
			}
		} else if (spec.restDestination === 'graveyard') {
			for (const id of exiledIds) {
				if (id === hitId) continue;
				const cardInst = libPl.exile.find((c) => c.instanceId === id);
				if (!cardInst) continue;
				moveObject(s, cardInst, 'graveyard', {
					from: { player: libPl, zone: 'exile' },
					toPlayer: libPl,
					bumpVersion: true,
					newTimestamp: true
				});
			}
		}

		host.answers[plDoneKey] = { kind: 'yesNo', yes: true };
	}
}

export interface Wave8DigEnv {
	matches: (inst: CardInstance, filter: ObjectFilter, zone: ZoneType) => boolean;
	answered: (
		key: string,
		candidates: CardInstance[],
		min: number,
		max: number
	) => CardInstance[] | null;
	setStepDecision: (stepIndex: number, decided: boolean) => void;
	addLog: (msg: string, playerId: string) => void;
	moveDigCardToBattlefield: (
		o: CardInstance,
		pl: PlayerGameState,
		tapped: boolean,
		attacking: boolean
	) => void;
	pauseForOrder: (
		chooser: PlayerGameState,
		title: string,
		description: string,
		objectIds: string[],
		answerKey: string
	) => void;
	subStepIndex: number;
	setSubStepIndex: (idx: number) => void;
}

/**
 * Handles Wave 8 `dig` variants: `keepTo: 'exile' | 'castFree'`, `rest: 'exile'`,
 * `keepMaxManaValue`, `dig.playFromExile`, and `keepAttackingPlayer`.
 * Returns `true` if handled (or paused), `false` to fall back to standard `dig`.
 */
export function executeDigWave8(
	host: P19aStepHost,
	step: EffectStep,
	env: Wave8DigEnv
): boolean {
	const dig = step.params?.dig;
	if (!dig) return false;
	const usesWave8 =
		dig.keepTo === 'exile' ||
		dig.keepTo === 'castFree' ||
		dig.rest === 'exile' ||
		dig.keepMaxManaValue !== undefined ||
		dig.playFromExile !== undefined ||
		dig.keepAttackingPlayer !== undefined;
	if (!usesWave8) return false;

	const s = host.state;
	const libOwner = host.players(step.subject)[0] ?? host.you;
	const chooser =
		(step.actor ? host.players({ k: 'playerRef', ref: step.actor })[0] : undefined) ?? libOwner;

	const topKey = `dig_top:${host.stepIndex}`;
	const keepAnsKey = `dig_keep:${host.stepIndex}`;
	const keptFrozenKey = `dig_kept_ids:${host.stepIndex}`;
	const restFrozenKey = `dig_rest_ids:${host.stepIndex}`;
	const orderAnsKey = `dig_order:${host.stepIndex}`;
	const keepDoneKey = `dig_keep_done:${host.stepIndex}`;

	let topIds: string[];
	const savedTop = host.answers[topKey];
	if (savedTop?.kind === 'chooseObjects') {
		topIds = savedTop.objectIds;
	} else if (dig.untilFilter) {
		if (libOwner.library.length === 0) {
			if (dig.shuffleRest) shuffleLibrary(s, libOwner);
			host.bind(step, []);
			return true;
		}
		const revealed: CardInstance[] = [];
		let matchedCard: CardInstance | undefined;
		for (let i = 0; i < libOwner.library.length; i++) {
			const c = libOwner.library[i]!;
			revealed.push(c);
			c.knownToPlayerIds = s.players.filter((x) => !x.lost).map((x) => x.playerId);
			if (env.matches(c, dig.untilFilter, 'library')) {
				matchedCard = c;
				break;
			}
		}
		topIds = revealed.map((c) => c.instanceId);
		host.answers[topKey] = { kind: 'chooseObjects', objectIds: topIds };
		const keptList = dig.restToHand ? revealed : matchedCard ? [matchedCard] : [];
		const restList = dig.restToHand
			? []
			: revealed.filter((c) => c.instanceId !== matchedCard?.instanceId);
		host.answers[keptFrozenKey] = {
			kind: 'chooseObjects',
			objectIds: keptList.map((c) => c.instanceId)
		};
		host.answers[restFrozenKey] = {
			kind: 'chooseObjects',
			objectIds: restList.map((c) => c.instanceId)
		};
		host.bind(step, keptList);
		env.addLog(
			`${libOwner.username} revealed ${revealed.map((c) => c.card.name).join(', ')} from their library.`,
			libOwner.playerId
		);
	} else {
		const count = Math.min(Math.max(0, host.amount(step.amount)), libOwner.library.length);
		if (count <= 0) {
			if (dig.upTo || dig.keepTo === 'castFree') env.setStepDecision(host.stepIndex, false);
			host.bind(step, []);
			return true;
		}
		const topCards = libOwner.library.slice(0, count);
		topIds = topCards.map((c) => c.instanceId);
		host.answers[topKey] = { kind: 'chooseObjects', objectIds: topIds };
		if (dig.revealAll) {
			env.addLog(
				`${libOwner.username} revealed ${topCards.map((c) => c.card.name).join(', ')} from the top of their library.`,
				libOwner.playerId
			);
		}
	}

	let keptIds: string[];
	let restIds: string[];
	const savedKept = host.answers[keptFrozenKey];
	const savedRest = host.answers[restFrozenKey];
	if (savedKept?.kind === 'chooseObjects' && savedRest?.kind === 'chooseObjects') {
		keptIds = savedKept.objectIds;
		restIds = savedRest.objectIds;
	} else {
		const topCards = topIds
			.map((id) => libOwner.library.find((c) => c.instanceId === id))
			.filter((c): c is CardInstance => Boolean(c));
		const mvCap =
			dig.keepMaxManaValue !== undefined
				? dig.keepMaxManaValue.k === 'x' && step.amount && step.amount.k !== 'x'
					? host.amount(step.amount)
					: host.amount(dig.keepMaxManaValue)
				: undefined;
		const eligible = topCards.filter((c) => {
			if (dig.keepFilter && !env.matches(c, dig.keepFilter, 'library')) return false;
			if (mvCap !== undefined && objectManaValue(s, c) > mvCap) return false;
			if (dig.keepTo === 'castFree' && !cardHasCastableSpellFace(c)) return false;
			return true;
		});

		let kept: CardInstance[];
		if (dig.keepAllMatching) {
			kept = eligible;
		} else {
			const max = Math.min(dig.keep, eligible.length);
			const min = dig.upTo ? 0 : max;
			const needsPrompt = max > 0 && (dig.upTo || eligible.length > min);
			if (needsPrompt && !chooser.isBot && host.canPause && !host.answers[keepAnsKey]) {
				const title = `${host.title} — Look at top ${topIds.length} card(s)`;
				const labelDesc = dig.keepLabel ? `${dig.keepLabel} ` : '';
				const destDesc =
					dig.keepTo === 'castFree'
						? 'to cast without paying its mana cost'
						: dig.keepTo === 'exile'
							? 'to exile'
							: dig.keepTo === 'hand'
								? 'into your hand'
								: dig.keepTo === 'battlefield'
									? dig.keepTapped
										? 'onto the battlefield tapped'
										: 'onto the battlefield'
									: dig.keepTo === 'graveyard'
										? 'into your graveyard'
										: 'on top of your library';
				const restDesc =
					dig.rest === 'exile'
						? 'the rest are exiled.'
						: dig.rest === 'graveyard'
							? 'the rest go into your graveyard.'
							: 'the rest go on the bottom.';
				host.pauseForChoice(
					chooser,
					title,
					`Choose ${min === max ? max : `up to ${max}`} ${labelDesc}card(s) ${destDesc}; ${restDesc}`,
					eligible.map((c) => c.instanceId),
					min,
					max,
					'library',
					undefined,
					keepAnsKey
				);
				return true;
			}
			if (max <= 0) {
				kept = [];
			} else if (host.answers[keepAnsKey]?.kind === 'chooseObjects') {
				kept = env.answered(keepAnsKey, eligible, min, max) ?? [];
			} else if (chooser.isBot && (dig.keepTo === 'battlefield' || dig.keepTo === 'castFree')) {
				kept = [...eligible]
					.sort((a, b) => objectManaValue(s, b) - objectManaValue(s, a))
					.slice(0, max);
			} else {
				kept = eligible.slice(0, max);
			}
		}

		keptIds = kept.map((c) => c.instanceId);
		const keptSet = new Set(keptIds);
		restIds = topCards.filter((c) => !keptSet.has(c.instanceId)).map((c) => c.instanceId);
		host.answers[keptFrozenKey] = { kind: 'chooseObjects', objectIds: keptIds };
		host.answers[restFrozenKey] = { kind: 'chooseObjects', objectIds: restIds };
		host.bind(step, kept);
		if (dig.upTo || dig.keepTo === 'castFree') {
			env.setStepDecision(host.stepIndex, kept.length > 0);
		}
		if (dig.revealKept && !dig.revealAll && kept.length > 0) {
			env.addLog(
				`${chooser.username} revealed ${kept.map((c) => c.card.name).join(', ')}.`,
				chooser.playerId
			);
		}
	}

	let orderedRestIds = [...restIds];
	if (dig.rest === 'libraryBottom' && restIds.length > 1) {
		const savedOrder = host.answers[orderAnsKey];
		if (savedOrder?.kind === 'orderObjects') {
			orderedRestIds = savedOrder.topIds.filter((id) => restIds.includes(id));
		} else if (dig.restRandom) {
			orderedRestIds = shuffleIdsDeterministic(s, orderedRestIds);
			host.answers[orderAnsKey] = { kind: 'orderObjects', topIds: orderedRestIds };
		} else if (dig.restOrder === 'any' && !libOwner.isBot && host.canPause) {
			env.pauseForOrder(
				libOwner,
				`${host.title} — Order cards on bottom`,
				`Put the remaining ${restIds.length} card(s) on the bottom of your library in any order.`,
				restIds,
				orderAnsKey
			);
			return true;
		}
	}

	if (dig.keepTo !== 'libraryTop' && !host.answers[keepDoneKey]) {
		const keptExiled: CardInstance[] = [];
		for (const id of keptIds) {
			const o = libOwner.library.find((c) => c.instanceId === id);
			if (!o) continue;
			if (dig.keepTo === 'hand') {
				moveObject(s, o, 'hand', {
					from: { player: libOwner, zone: 'library' },
					toPlayer: chooser,
					newTimestamp: true,
					bumpVersion: true
				});
			} else if (dig.keepTo === 'graveyard') {
				moveObject(s, o, 'graveyard', {
					from: { player: libOwner, zone: 'library' },
					toPlayer: libOwner,
					newTimestamp: true,
					bumpVersion: true
				});
			} else if (dig.keepTo === 'battlefield') {
				env.moveDigCardToBattlefield(o, chooser, Boolean(dig.keepTapped), Boolean(dig.keepAttacking));
				if (dig.keepAttackingPlayer && o.zone === 'battlefield' && s.combat.active) {
					const defPl = host.players({ k: 'playerRef', ref: dig.keepAttackingPlayer })[0];
					if (defPl) {
						registerEnteredAttackingCombatant(s, chooser, o);
						const atkEntry = s.combat.attackers.find(
							(a) => a.attackerInstanceId === o.instanceId
						);
						if (atkEntry) {
							atkEntry.defenderPlayerId = defPl.playerId;
							atkEntry.defenderPlaneswalkerId = null;
						}
					}
				}
			} else if (dig.keepTo === 'exile' || dig.keepTo === 'castFree') {
				const owner = s.players.find((pl) => pl.playerId === o.ownerId) ?? libOwner;
				moveObject(s, o, 'exile', {
					from: { player: libOwner, zone: 'library' },
					toPlayer: owner,
					newTimestamp: true,
					bumpVersion: true
				});
				if (dig.keepTo === 'exile' && dig.playFromExile && o.zone === 'exile') {
					const playSpec = dig.playFromExile;
					const dur = playSpec.duration ?? 'thisTurn';
					o.playableFromExileBy = {
						playerId: chooser.playerId,
						spendManaAsAnyColor: Boolean(playSpec.spendManaAsAnyColor),
						sourceName: host.sourceCard.name || host.title,
						duration: dur,
						...(dur === 'thisTurn' ? { expiresAtEndOfTurn: true } : {}),
						...(dur === 'untilEndOfYourNextTurn'
							? {
									expiresOnCleanupOfPlayerId: chooser.playerId,
									grantedOnTurnSerial: s.turnSerial ?? s.turnNumber
								}
							: {}),
						...(dur === 'untilYourNextEndStep'
							? { expiresAtNextEndStepOfPlayerId: chooser.playerId }
							: {}),
						...(playSpec.spellsOnly ? { spellsOnly: true } : {}),
						...(playSpec.withoutPayingManaCost ? { withoutPayingManaCost: true } : {})
					};
				}
				keptExiled.push(o);
			}
		}

		if (dig.keepTo === 'castFree') {
			const synBind = `__p22d_dig_castfree_${host.stepIndex}`;
			const existingInExile = keptIds
				.map((id) => s.players.flatMap((pl) => pl.exile).find((c) => c.instanceId === id))
				.filter((c): c is CardInstance => Boolean(c));
			const castTargets = keptExiled.length > 0 ? keptExiled : existingInExile;
			if (castTargets.length > 0) {
				if (host.answers[keepAnsKey]) {
					for (let i = 0; i < castTargets.length; i++) {
						const askKey = `castfree:ask:${host.stepIndex}:${i}`;
						if (!host.answers[askKey]) {
							host.answers[askKey] = { kind: 'yesNo', yes: true };
						}
					}
				}
				const castStep: EffectStep = {
					verb: 'castFree',
					subject: { k: 'binding', name: synBind },
					...(step.actor ? { actor: step.actor } : {}),
					params: {
						castFreeSpec: {
							withoutPayingManaCost: true
						}
					},
					span: step.span
				};
				const hadPauseBefore = s.pendingPrompts.length > 0;
				host.bind({ ...step, bindAs: synBind }, castTargets);
				executeCastFree(host.p16aHost(), castStep);
				if (s.pendingPrompts.length > 0 && !hadPauseBefore) {
					host.markPaused();
					return true;
				}
			}
		}

		// Re-bind kept cards in their destination zone so downstream steps ("the exiled card", "that card") find them!
		const reboundKept = keptIds
			.map((id) => host.locate(id)?.inst)
			.filter((c): c is CardInstance => Boolean(c));
		host.bind(step, reboundKept);
		host.answers[keepDoneKey] = { kind: 'yesNo', yes: true };
		env.setSubStepIndex(0);
	}

	if (dig.rest === 'exile') {
		for (const id of orderedRestIds) {
			const o = libOwner.library.find((c) => c.instanceId === id);
			if (!o) continue;
			const owner = s.players.find((pl) => pl.playerId === o.ownerId) ?? libOwner;
			moveObject(s, o, 'exile', {
				from: { player: libOwner, zone: 'library' },
				toPlayer: owner,
				newTimestamp: true,
				bumpVersion: true
			});
		}
	} else if (dig.rest === 'graveyard') {
		for (const id of orderedRestIds) {
			const o = libOwner.library.find((c) => c.instanceId === id);
			if (!o) continue;
			moveObject(s, o, 'graveyard', {
				from: { player: libOwner, zone: 'library' },
				toPlayer: libOwner,
				newTimestamp: true,
				bumpVersion: true
			});
		}
	} else if (dig.restToHand) {
		for (const id of orderedRestIds) {
			const o = libOwner.library.find((c) => c.instanceId === id);
			if (!o) continue;
			moveObject(s, o, 'hand', {
				from: { player: libOwner, zone: 'library' },
				toPlayer: libOwner,
				newTimestamp: true,
				bumpVersion: true
			});
		}
	} else if (dig.rest === 'libraryTop') {
		const keptInLib =
			dig.keepTo === 'libraryTop'
				? keptIds
						.map((id) => libOwner.library.find((c) => c.instanceId === id))
						.filter((c): c is CardInstance => Boolean(c))
				: [];
		const restInLib = orderedRestIds
			.map((id) => libOwner.library.find((c) => c.instanceId === id))
			.filter((c): c is CardInstance => Boolean(c));
		rearrangeLibrary(libOwner, [...keptInLib, ...restInLib], [...keptInLib, ...restInLib], []);
	} else {
		const keptInLib =
			dig.keepTo === 'libraryTop'
				? keptIds
						.map((id) => libOwner.library.find((c) => c.instanceId === id))
						.filter((c): c is CardInstance => Boolean(c))
				: [];
		const restInLib = orderedRestIds
			.map((id) => libOwner.library.find((c) => c.instanceId === id))
			.filter((c): c is CardInstance => Boolean(c));
		rearrangeLibrary(libOwner, [...keptInLib, ...restInLib], keptInLib, restInLib);
	}

	if (dig.shuffleRest) {
		shuffleLibrary(s, libOwner);
	}

	env.addLog(
		`${libOwner.username} looked at the top ${topIds.length} card(s) of their library (${keptIds.length} kept, ${restIds.length} rest).`,
		libOwner.playerId
	);
	return true;
}

export interface Wave8PreventEnv {
	objects: (sel: Selector) => CardInstance[];
	players: (sel: Selector) => PlayerGameState[];
	targetsForSpecIndex: (idx: number) => TargetRef[];
	locate: (
		id: string
	) => { inst: CardInstance; holder: PlayerGameState; zone: ZoneType } | undefined;
	matches: (inst: CardInstance, filter: ObjectFilter, zone: ZoneType) => boolean;
	targetsBecomeEach: boolean;
	uid: (prefix: string) => string;
}

function resolveOnPreventedRecipient(
	spec: NonNullable<DamagePreventionSpec['onPrevented']>,
	host: P19aStepHost,
	env: Wave8PreventEnv,
	fallbackPerm?: CardInstance
): DamagePreventionShieldEntry['onPrevented'] | undefined {
	const rec = spec.recipient;
	let targetKind: 'player' | 'permanent' | undefined;
	let targetId: string | undefined;
	let targetObjectVersion: number | undefined;

	if (rec) {
		if (rec.k === 'target') {
			const t = env.targetsForSpecIndex(rec.index)[0];
			if (t?.kind === 'player') {
				targetKind = 'player';
				targetId = t.id;
			} else if (t?.kind === 'permanent') {
				const perm = env.locate(t.id)?.inst;
				if (perm && perm.zone === 'battlefield' && !perm.phasedOut) {
					targetKind = 'permanent';
					targetId = perm.instanceId;
					targetObjectVersion = perm.objectVersion ?? 1;
				}
			}
		} else if (rec.k === 'player' || rec.k === 'playerRef') {
			const pl = env.players(rec)[0];
			if (pl) {
				targetKind = 'player';
				targetId = pl.playerId;
			}
		} else {
			const obj = env.objects(rec).find((o) => o.zone === 'battlefield' && !o.phasedOut);
			if (obj) {
				targetKind = 'permanent';
				targetId = obj.instanceId;
				targetObjectVersion = obj.objectVersion ?? 1;
			}
		}
	} else if (spec.kind === 'putCountersEqual' && fallbackPerm) {
		targetKind = 'permanent';
		targetId = fallbackPerm.instanceId;
		targetObjectVersion = fallbackPerm.objectVersion ?? 1;
	} else if (
		spec.kind === 'gainLifeEqual' ||
		spec.kind === 'drawEqual' ||
		spec.kind === 'drawOne'
	) {
		targetKind = 'player';
		targetId = host.you.playerId;
	}

	if (
		(spec.kind === 'dealDamageEqual' || spec.kind === 'putCountersEqual') &&
		(!targetKind || !targetId)
	) {
		return undefined;
	}

	return {
		kind: spec.kind,
		...(spec.counter ? { counter: spec.counter } : {}),
		...(targetKind ? { targetKind } : {}),
		...(targetId ? { targetId } : {}),
		...(targetObjectVersion !== undefined ? { targetObjectVersion } : {})
	};
}

/**
 * Handles Wave 8 `preventDamage` steps that specify `chooseSource`, `nextDamageEventOnly`,
 * or `onPrevented` riders. Returns `true` if handled/paused, `false` for standard shields.
 */
export function executePreventWave8(
	host: P19aStepHost,
	step: EffectStep,
	env: Wave8PreventEnv
): boolean {
	const spec = step.params?.preventSpec;
	if (!spec) return false;
	if (!spec.chooseSource && !spec.nextDamageEventOnly && !spec.onPrevented) {
		return false;
	}

	const s = host.state;
	const you = host.you;
	const remaining: number | 'infinite' =
		spec.mode === 'all' ? 'infinite' : Math.max(0, host.amount(step.amount, 1));
	if (remaining !== 'infinite' && remaining <= 0) return true;

	let fromSourceInstanceId: string | undefined;
	let fromSourceObjectVersion: number | undefined;
	let fromSourceStackItemId: string | undefined;
	let fromSourceTypes: string[] | undefined;
	let fromAttackingOnly: boolean | undefined;

	if (spec.chooseSource) {
		const srcKey = `prevent_choose_src:${host.stepIndex}`;
		const bfCandidates = s.players.flatMap((pl) =>
			pl.battlefield.filter((c) => !c.phasedOut)
		);
		const stackCandidates = s.stack.filter((it) => it.id !== host.item.id);
		const candidateIds = [
			...bfCandidates.map((c) => c.instanceId),
			...stackCandidates.map((it) => it.id)
		];
		if (candidateIds.length === 0) return true;

		let pickedId: string | undefined;
		const savedSrc = host.answers[srcKey];
		if (savedSrc?.kind === 'chooseObjects' && savedSrc.objectIds[0]) {
			pickedId = savedSrc.objectIds[0];
		} else if (!you.isBot && host.canPause) {
			host.pauseForChoice(
				you,
				`${host.title} — Choose Damage Source`,
				`Choose a source of your choice whose damage will be prevented.`,
				candidateIds,
				1,
				1,
				bfCandidates.length > 0 ? 'battlefield' : 'stack',
				[candidateIds[0]!],
				srcKey
			);
			return true;
		} else {
			// Bot heuristic: prefer an opponent's spell on the stack or highest-power attacking/opponent creature.
			const oppStack = stackCandidates.find((it) => it.controllerId !== you.playerId);
			const oppBf = bfCandidates
				.filter((c) => c.controllerId !== you.playerId)
				.sort((a, b) => (parseInt(b.card.power ?? '0', 10) || 0) - (parseInt(a.card.power ?? '0', 10) || 0))[0];
			pickedId = oppStack?.id ?? oppBf?.instanceId ?? candidateIds[0]!;
			host.answers[srcKey] = { kind: 'chooseObjects', objectIds: [pickedId] };
		}

		const stackPick = stackCandidates.find((it) => it.id === pickedId);
		if (stackPick) {
			fromSourceStackItemId = stackPick.id;
			fromSourceInstanceId = stackPick.sourceInstanceId;
		} else {
			const permPick = bfCandidates.find((c) => c.instanceId === pickedId);
			if (!permPick) return true;
			fromSourceInstanceId = permPick.instanceId;
			fromSourceObjectVersion = permPick.objectVersion ?? 1;
		}
	} else if (spec.fromSource) {
		if (spec.fromSource.k === 'all') {
			if (spec.fromSource.filter.types?.length) {
				fromSourceTypes = [...spec.fromSource.filter.types];
			}
			if (spec.fromSource.filter.attacking) {
				fromAttackingOnly = true;
			}
		} else {
			const srcObj = env.objects(spec.fromSource)[0];
			if (!srcObj) return true;
			fromSourceInstanceId = srcObj.instanceId;
			if (srcObj.zone === 'battlefield') {
				fromSourceObjectVersion = srcObj.objectVersion ?? 1;
			}
		}
	}

	const buildBase = (fallbackPerm?: CardInstance) => {
		const onPrevented = spec.onPrevented
			? resolveOnPreventedRecipient(spec.onPrevented, host, env, fallbackPerm)
			: undefined;
		return {
			controllerId: you.playerId,
			sourceName: host.sourceCard.name || host.title,
			combatOnly: spec.combatOnly,
			remaining,
			...(fromSourceInstanceId !== undefined ? { fromSourceInstanceId } : {}),
			...(fromSourceObjectVersion !== undefined ? { fromSourceObjectVersion } : {}),
			...(fromSourceStackItemId !== undefined ? { fromSourceStackItemId } : {}),
			...(fromSourceTypes ? { fromSourceTypes } : {}),
			...(fromAttackingOnly ? { fromAttackingOnly: true } : {}),
			...(spec.nextDamageEventOnly ? { nextEventOnly: true } : {}),
			...(onPrevented ? { onPrevented } : {})
		};
	};

	if (spec.scope === 'any') {
		addDamagePreventionShield(s, {
			...buildBase(),
			id: env.uid('pshield'),
			targetKind: 'any'
		});
		return true;
	}

	if (spec.scope === 'youAndCreaturesYouControl') {
		addDamagePreventionShield(s, {
			...buildBase(),
			id: env.uid('pshield'),
			targetKind: 'playerAndPermanentsControlledBy',
			targetId: you.playerId,
			targetTypes: ['Creature']
		});
		return true;
	}

	const sel = step.subject;
	if (sel.k === 'target' && !env.targetsBecomeEach) {
		const refs = env.targetsForSpecIndex(sel.index);
		const boundPerms: CardInstance[] = [];
		for (const t of refs) {
			if (t.kind === 'player') {
				const pl = s.players.find((x) => x.playerId === t.id && !x.lost);
				if (pl) {
					addDamagePreventionShield(s, {
						...buildBase(),
						id: env.uid('pshield'),
						targetKind: 'player',
						targetId: pl.playerId
					});
				}
			} else if (t.kind === 'permanent') {
				const perm = env.locate(t.id)?.inst;
				if (perm && perm.zone === 'battlefield' && !perm.phasedOut) {
					boundPerms.push(perm);
					addDamagePreventionShield(s, {
						...buildBase(perm),
						id: env.uid('pshield'),
						targetKind: 'permanent',
						targetId: perm.instanceId,
						targetObjectVersion: perm.objectVersion ?? 1,
						...(spec.alsoPreventDealtBySubject ? { alsoPreventDealtByTarget: true } : {})
					});
				}
			}
		}
		host.bind(step, boundPerms);
		return true;
	}

	if (sel.k === 'player' || sel.k === 'playerRef') {
		for (const pl of env.players(sel)) {
			addDamagePreventionShield(s, {
				...buildBase(),
				id: env.uid('pshield'),
				targetKind: 'player',
				targetId: pl.playerId
			});
		}
		return true;
	}

	const objs = env.objects(sel).filter((o) => {
		if (o.zone !== 'battlefield' || o.phasedOut) return false;
		if (
			sel.k === 'self' &&
			host.item.sourceObjectVersion !== undefined &&
			(o.objectVersion ?? 1) !== host.item.sourceObjectVersion
		) {
			return false;
		}
		return true;
	});
	host.bind(step, objs);
	for (const o of objs) {
		addDamagePreventionShield(s, {
			...buildBase(o),
			id: env.uid('pshield'),
			targetKind: 'permanent',
			targetId: o.instanceId,
			targetObjectVersion: o.objectVersion ?? 1,
			...(spec.alsoPreventDealtBySubject ? { alsoPreventDealtByTarget: true } : {})
		});
	}
	return true;
}

export interface Wave8PreventedPorts {
	gainLife: (state: GameState, pl: PlayerGameState, amount: number) => void;
	drawCards: (state: GameState, pl: PlayerGameState, count: number) => void;
	addCounters: (state: GameState, inst: CardInstance, counter: CounterType, amount: number) => number;
	damageTarget: (state: GameState, sourcePlayerId: string, target: TargetRef, amount: number) => void;
	findPermanent: (
		state: GameState,
		id: string
	) => { inst: CardInstance; owner: PlayerGameState; controller: PlayerGameState } | null;
	addLog: (
		state: GameState,
		kind: 'rule' | 'cast' | 'trigger' | 'life' | 'combat',
		text: string,
		actorId?: string
	) => void;
}

/**
 * Executes damage-prevention side riders (`onPrevented`) when damage is actually prevented.
 */
export function handleDamagePreventedWave8(
	state: GameState,
	shield: DamagePreventionShieldEntry,
	preventedAmount: number,
	ports: Wave8PreventedPorts
): void {
	const onPrev = shield.onPrevented;
	if (!onPrev || preventedAmount <= 0) return;

	if (onPrev.kind === 'gainLifeEqual') {
		const pl =
			state.players.find((p) => p.playerId === (onPrev.targetId ?? shield.controllerId)) ??
			state.players.find((p) => p.playerId === shield.controllerId);
		if (pl && !pl.lost) {
			ports.gainLife(state, pl, preventedAmount);
			ports.addLog(
				state,
				'life',
				`${shield.sourceName}: ${pl.username} gained ${preventedAmount} life from prevented damage.`,
				pl.playerId
			);
		}
		return;
	}

	if (onPrev.kind === 'putCountersEqual') {
		const targetId = onPrev.targetId ?? shield.targetId;
		if (!targetId) return;
		const found = ports.findPermanent(state, targetId);
		if (!found) return;
		if (
			onPrev.targetObjectVersion !== undefined &&
			(found.inst.objectVersion ?? 1) !== onPrev.targetObjectVersion
		) {
			return;
		}
		const counter = (onPrev.counter ?? '+1/+1') as CounterType;
		ports.addCounters(state, found.inst, counter, preventedAmount);
		ports.addLog(
			state,
			'rule',
			`${shield.sourceName}: put ${preventedAmount} ${counter} counter(s) on ${found.inst.card.name}.`,
			shield.controllerId
		);
		return;
	}

	if (onPrev.kind === 'dealDamageEqual') {
		if (!onPrev.targetKind || !onPrev.targetId) return;
		if (onPrev.targetKind === 'permanent') {
			const found = ports.findPermanent(state, onPrev.targetId);
			if (!found) return;
			if (
				onPrev.targetObjectVersion !== undefined &&
				(found.inst.objectVersion ?? 1) !== onPrev.targetObjectVersion
			) {
				return;
			}
			ports.damageTarget(
				state,
				shield.controllerId,
				{ kind: 'permanent', id: found.inst.instanceId, label: found.inst.card.name },
				preventedAmount
			);
		} else {
			const pl = state.players.find((p) => p.playerId === onPrev.targetId && !p.lost);
			if (!pl) return;
			ports.damageTarget(
				state,
				shield.controllerId,
				{ kind: 'player', id: pl.playerId, label: pl.username },
				preventedAmount
			);
		}
		return;
	}

	if (onPrev.kind === 'drawEqual' || onPrev.kind === 'drawOne') {
		const pl =
			state.players.find((p) => p.playerId === (onPrev.targetId ?? shield.controllerId)) ??
			state.players.find((p) => p.playerId === shield.controllerId);
		if (pl && !pl.lost) {
			const n = onPrev.kind === 'drawOne' ? 1 : preventedAmount;
			ports.drawCards(state, pl, n);
		}
	}
}
