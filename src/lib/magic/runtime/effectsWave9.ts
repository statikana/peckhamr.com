/**
 * Wave 9: Runtime execution for Wave 9 dig/search variants, spell-created delayed triggers
 * (`registerWave9DelayedTrigger`), and per-opponent tapped-and-attacking token creation.
 *
 * Pure data / IR execution: zero rules-text reads, zero card-name branches.
 */
import { compileCard } from '../compiler/index.ts';
import type { EffectStep, ObjectFilter, TokenSpec } from '../ir.ts';
import type {
	CardInstance,
	GameState,
	PlayerGameState,
	ScryfallCard,
	StackItem,
	TargetRef,
	Wave7SpellDelayedTrigger
} from '../types.ts';
import type { EffectRunAccess } from './effectsDamageAndMana.ts';
import { effectPorts } from './effectsDamageAndMana.ts';
import { H } from './engineHost.ts';
import { objectManaValue } from './objectFilter.ts';
import { nextRandom } from './random.ts';
import { spellCannotBeCopied, tokenMultiplier } from './replace.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import { withSimultaneousZoneBatch } from './triggers.ts';
import { moveObject, shuffleLibrary } from './zones.ts';

export interface DigWave9Helpers {
	matches: (
		inst: CardInstance,
		filter: ObjectFilter,
		zone: 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile'
	) => boolean;
	answered: (key: string, candidates: CardInstance[], min: number, max: number) => CardInstance[] | null;
	setStepDecision: (stepIdx: number, dec: boolean) => void;
	addLog: (msg: string, pid?: string) => void;
	moveDigCardToBattlefield: (o: CardInstance, pl: PlayerGameState, tapped: boolean, attacking: boolean) => void;
	pauseForOrder: (chooser: PlayerGameState, title: string, desc: string, ids: string[], key: string) => void;
	executeCastFreeStep?: (castStep: EffectStep) => void;
}

export function executeDigWave9(
	run: EffectRunAccess,
	step: EffectStep,
	helpers: DigWave9Helpers
): boolean {
	const dig = step.params?.dig;
	if (!dig) return false;
	const hasGraveyardPartition = Boolean(dig.partitions?.some((pt) => pt.to === 'graveyard'));
	if (
		!hasGraveyardPartition &&
		dig.chooseMode !== 'oneOfExiled' &&
		!dig.keepMaxMvStrictLt
	) {
		return false;
	}

	const s = run.state;
	const pl = run.players(step.subject)[0] ?? run.you;

	if (hasGraveyardPartition && dig.partitions) {
		const topKey = `w9_part_top:${run.stepIndex}`;
		const count = Math.min(Math.max(0, run.amount(step.amount, 3)), pl.library.length);
		let topIds: string[];
		const savedTop = run.answers[topKey];
		if (savedTop?.kind === 'chooseObjects') {
			topIds = savedTop.objectIds;
		} else {
			topIds = pl.library.slice(0, count).map((c) => c.instanceId);
			run.answers[topKey] = { kind: 'chooseObjects', objectIds: topIds };
		}
		const topCards = topIds
			.map((id) => pl.library.find((c) => c.instanceId === id))
			.filter((c): c is CardInstance => Boolean(c));
		if (topCards.length === 0) return true;

		let rem = [...topCards];
		const chosenByPart: Array<{ part: (typeof dig.partitions)[number]; picked: CardInstance[] }> = [];
		for (let pi = 0; pi < dig.partitions.length; pi++) {
			const part = dig.partitions[pi];
			const pickCount = Math.min(part.count, rem.length);
			let picked: CardInstance[];
			if (part.to === 'libraryBottom' || rem.length <= pickCount) {
				picked = rem.slice(0, pickCount);
			} else {
				const ansKey = `w9_part_p:${run.stepIndex}:${pi}`;
				if (!pl.isBot && run.canPause && !run.answers[ansKey]) {
					run.pauseForChoice(
						pl,
						`${run.ctx.title} — Put card(s) into ${part.to}`,
						`Choose ${pickCount} card(s) to put into ${part.to === 'hand' ? 'your hand' : 'your graveyard'}.`,
						rem.map((c) => c.instanceId),
						pickCount,
						pickCount,
						'library',
						rem.slice(0, pickCount).map((c) => c.instanceId),
						ansKey
					);
					return true;
				}
				const savedPick = run.answers[ansKey];
				if (savedPick?.kind === 'chooseObjects') {
					picked = helpers.answered(ansKey, rem, pickCount, pickCount) ?? rem.slice(0, pickCount);
				} else {
					picked = rem.slice(0, pickCount);
				}
			}
			const pSet = new Set(picked.map((c) => c.instanceId));
			rem = rem.filter((c) => !pSet.has(c.instanceId));
			chosenByPart.push({ part, picked });
		}
		const movedResults: CardInstance[] = [];
		for (const { part, picked } of chosenByPart) {
			for (const card of picked) {
				const destZone = part.to === 'libraryBottom' ? 'library' : part.to;
				moveObject(s, card, destZone, {
					from: { player: pl, zone: 'library' },
					toPlayer: pl,
					...(destZone === 'library' ? { insert: 'end' } : {}),
					newTimestamp: true,
					bumpVersion: true
				});
				movedResults.push(card);
			}
		}
		run.bind(step, movedResults);
		return true;
	}

	// Case A: "Exile the top N cards of your library, then choose one of them. You may play that card this turn."
	if (dig.chooseMode === 'oneOfExiled') {
		const exiledKey = `w9_dig_exiled:${run.stepIndex}`;
		const pickKey = `w9_dig_pick:${run.stepIndex}`;
		const count = Math.min(Math.max(0, run.amount(step.amount)), pl.library.length);
		let exiledCards: CardInstance[];
		const savedExiled = run.answers[exiledKey];
		if (savedExiled?.kind === 'chooseObjects') {
			exiledCards = savedExiled.objectIds
				.map((id) => pl.exile.find((c) => c.instanceId === id))
				.filter((c): c is CardInstance => Boolean(c));
		} else {
			exiledCards = [];
			for (let i = 0; i < count; i++) {
				const top = pl.library[0];
				if (!top) break;
				moveObject(s, top, 'exile', {
					from: { player: pl, zone: 'library' },
					toPlayer: pl,
					newTimestamp: true,
					bumpVersion: true
				});
				exiledCards.push(top);
			}
			run.answers[exiledKey] = {
				kind: 'chooseObjects',
				objectIds: exiledCards.map((c) => c.instanceId)
			};
			if (exiledCards.length > 0) {
				helpers.addLog(
					`${pl.username} exiled ${exiledCards.map((c) => c.card.name).join(', ')} (${run.ctx.title}).`,
					pl.playerId
				);
			}
		}

		if (exiledCards.length === 0) {
			run.bind(step, []);
			return true;
		}

		let chosen: CardInstance | undefined;
		if (exiledCards.length === 1) {
			chosen = exiledCards[0];
		} else if (!pl.isBot && run.canPause && !run.answers[pickKey]) {
			run.pauseForChoice(
				pl,
				`${run.ctx.title} — Choose Exiled Card`,
				'Choose 1 of the exiled cards; you may play it this turn.',
				exiledCards.map((c) => c.instanceId),
				1,
				1,
				'exile',
				[exiledCards[0].instanceId],
				pickKey
			);
			return true;
		} else if (run.answers[pickKey]?.kind === 'chooseObjects') {
			const pickedId = run.answers[pickKey].objectIds[0];
			chosen = exiledCards.find((c) => c.instanceId === pickedId) ?? exiledCards[0];
		} else {
			// Bot preference: pick castable nonland or land card with lowest castable cost / nonland priority
			const sorted = [...exiledCards].sort((a, b) => objectManaValue(s, a) - objectManaValue(s, b));
			chosen = sorted[0];
		}

		if (chosen) {
			const playSpec = dig.playFromExile;
			const dur = playSpec?.duration ?? 'thisTurn';
			chosen.playableFromExileBy = {
				playerId: run.you.playerId,
				sourceName: run.ctx.title,
				duration: dur,
				...(dur === 'thisTurn' ? { expiresAtEndOfTurn: true } : {}),
				...(dur === 'untilEndOfYourNextTurn'
					? {
							expiresOnCleanupOfPlayerId: run.you.playerId,
							grantedOnTurnSerial: s.turnSerial ?? s.turnNumber
						}
					: {}),
				...(dur === 'untilYourNextEndStep'
					? { expiresAtNextEndStepOfPlayerId: run.you.playerId }
					: {}),
				...(playSpec?.spellsOnly ? { spellsOnly: true } : {}),
				...(playSpec?.withoutPayingManaCost ? { withoutPayingManaCost: true } : {}),
				spendManaAsAnyColor: Boolean(playSpec?.spendManaAsAnyColor)
			};
			run.bind(step, [chosen]);
			helpers.addLog(
				`${pl.username} chose ${chosen.card.name} to play from exile (${run.ctx.title}).`,
				pl.playerId
			);
		}
		return true;
	}

	// Case B: Bounded MV dig ("less than X" / "<= X")
	const topKey = `dig_top:${run.stepIndex}`;
	const keepAnsKey = `dig_keep:${run.stepIndex}`;
	const keptFrozenKey = `dig_kept_ids:${run.stepIndex}`;
	const restFrozenKey = `dig_rest_ids:${run.stepIndex}`;
	const orderAnsKey = `dig_order:${run.stepIndex}`;
	const keepDoneKey = `dig_keep_done:${run.stepIndex}`;

	const xCountVal = Math.max(0, run.amount(step.amount));
	let topIds: string[];
	const savedTop = run.answers[topKey];
	if (savedTop?.kind === 'chooseObjects') {
		topIds = savedTop.objectIds;
	} else {
		const count = Math.min(xCountVal, pl.library.length);
		if (count <= 0) {
			if (dig.upTo) helpers.setStepDecision(run.stepIndex, false);
			run.bind(step, []);
			return true;
		}
		const topCards = pl.library.slice(0, count);
		topIds = topCards.map((c) => c.instanceId);
		run.answers[topKey] = { kind: 'chooseObjects', objectIds: topIds };
		if (dig.revealAll) {
			helpers.addLog(
				`${pl.username} revealed ${topCards.map((c) => c.card.name).join(', ')} from the top of their library.`,
				pl.playerId
			);
		}
	}

	let keptIds: string[];
	let restIds: string[];
	const savedKept = run.answers[keptFrozenKey];
	const savedRest = run.answers[restFrozenKey];
	if (savedKept?.kind === 'chooseObjects' && savedRest?.kind === 'chooseObjects') {
		keptIds = savedKept.objectIds;
		restIds = savedRest.objectIds;
	} else {
		const topCards = topIds
			.map((id) => pl.library.find((c) => c.instanceId === id))
			.filter((c): c is CardInstance => Boolean(c));
		const maxSpec = dig.keepMaxManaValue;
		const maxMvBound =
			maxSpec === undefined
				? Number.POSITIVE_INFINITY
				: maxSpec.k === 'x' && step.amount?.k !== 'x'
					? xCountVal
					: run.amount(maxSpec);
		const eligible = topCards.filter((c) => {
			if (dig.keepFilter && !helpers.matches(c, dig.keepFilter, 'library')) return false;
			if (dig.keepTo === 'castFree' && !helpers.matches(c, { notTypes: ['Land'] }, 'library')) {
				return false;
			}
			const mv = objectManaValue(s, c);
			return dig.keepMaxMvStrictLt ? mv < maxMvBound : mv <= maxMvBound;
		});

		let kept: CardInstance[];
		if (dig.keepAllMatching) {
			kept = eligible;
		} else {
			const max = Math.min(dig.keep, eligible.length);
			const min = dig.upTo ? 0 : max;
			const needsPrompt = max > 0 && (dig.upTo || eligible.length > min);
			if (needsPrompt && !pl.isBot && run.canPause && !run.answers[keepAnsKey]) {
				run.pauseForChoice(
					pl,
					`${run.ctx.title} — Look at top ${topIds.length} card(s)`,
					`Choose ${min === max ? max : `up to ${max}`} matching card(s).`,
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
			} else if (run.answers[keepAnsKey]?.kind === 'chooseObjects') {
				kept = helpers.answered(keepAnsKey, eligible, min, max) ?? [];
			} else {
				const sorted = [...eligible].sort((a, b) => objectManaValue(s, b) - objectManaValue(s, a));
				kept = sorted.slice(0, max);
			}
		}

		keptIds = kept.map((c) => c.instanceId);
		const keptSet = new Set(keptIds);
		restIds = topCards.filter((c) => !keptSet.has(c.instanceId)).map((c) => c.instanceId);
		run.answers[keptFrozenKey] = { kind: 'chooseObjects', objectIds: keptIds };
		run.answers[restFrozenKey] = { kind: 'chooseObjects', objectIds: restIds };
		run.bind(step, kept);
		if (dig.upTo) helpers.setStepDecision(run.stepIndex, kept.length > 0);
	}

	let orderedRestIds = [...restIds];
	if (dig.rest === 'libraryBottom' && restIds.length > 1) {
		const savedOrder = run.answers[orderAnsKey];
		if (savedOrder?.kind === 'orderObjects') {
			orderedRestIds = savedOrder.topIds.filter((id) => restIds.includes(id));
		} else if (dig.restRandom) {
			for (let i = orderedRestIds.length - 1; i > 0; i--) {
				const j = Math.floor(nextRandom(s) * (i + 1));
				[orderedRestIds[i], orderedRestIds[j]] = [orderedRestIds[j], orderedRestIds[i]];
			}
			run.answers[orderAnsKey] = { kind: 'orderObjects', topIds: orderedRestIds };
		} else if (dig.restOrder === 'any' && !pl.isBot && run.canPause) {
			helpers.pauseForOrder(
				pl,
				`${run.ctx.title} — Order cards on bottom`,
				`Put the remaining ${restIds.length} card(s) on the bottom of your library in any order.`,
				restIds,
				orderAnsKey
			);
			return true;
		}
	}

	if (dig.keepTo !== 'libraryTop' && !run.answers[keepDoneKey]) {
		if (dig.keepTo === 'castFree') {
			const toCast = keptIds
				.map((id) => pl.library.find((c) => c.instanceId === id))
				.filter((c): c is CardInstance => Boolean(c));
			if (toCast.length > 0 && helpers.executeCastFreeStep) {
				const bindName = `__w9_dig_cast_${run.stepIndex}`;
				run.bindings.set(
					bindName,
					toCast.map((o) => ({ id: o.instanceId, lki: run.snapshot(o) }))
				);
				helpers.executeCastFreeStep({
					verb: 'castFree',
					subject: { k: 'binding', name: bindName },
					params: { castFreeSpec: { withoutPayingManaCost: true } },
					span: step.span
				});
			}
			run.answers[keepDoneKey] = { kind: 'yesNo', yes: true };
		} else {
			const batch = run.runIndexedBatch(
				`dig_keep_batch:${run.stepIndex}`,
				() => keptIds,
				(id) => {
					const o = pl.library.find((c) => c.instanceId === id);
					if (!o) return;
					if (dig.keepTo === 'hand') {
						moveObject(s, o, 'hand', {
							from: { player: pl, zone: 'library' },
							toPlayer: pl,
							newTimestamp: true,
							bumpVersion: true
						});
						return;
					}
					if (dig.keepTo === 'graveyard') {
						moveObject(s, o, 'graveyard', {
							from: { player: pl, zone: 'library' },
							toPlayer: pl,
							newTimestamp: true,
							bumpVersion: true
						});
						return;
					}
					if (dig.keepTo === 'battlefield') {
						helpers.moveDigCardToBattlefield(
							o,
							pl,
							Boolean(dig.keepTapped),
							Boolean(dig.keepAttacking)
						);
						return;
					}
				}
			);
			if (batch.paused) return true;
			run.answers[keepDoneKey] = { kind: 'yesNo', yes: true };
		}
	}

	for (const id of orderedRestIds) {
		const o = pl.library.find((c) => c.instanceId === id);
		if (!o) continue;
		const dest = dig.rest === 'graveyard' ? 'graveyard' : 'library';
		moveObject(s, o, dest, {
			from: { player: pl, zone: 'library' },
			toPlayer: pl,
			...(dest === 'library' ? { insert: 'end' } : {}),
			newTimestamp: true,
			bumpVersion: true
		});
	}
	return true;
}

export interface SearchWave9Helpers {
	matches: (
		inst: CardInstance,
		filter: ObjectFilter,
		zone: 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile'
	) => boolean;
	answered: (key: string, candidates: CardInstance[], min: number, max: number) => CardInstance[] | null;
	executeCastFreeStep: (castStep: EffectStep) => void;
}

export function executeSearchWave9(
	run: EffectRunAccess,
	step: EffectStep,
	helpers: SearchWave9Helpers
): boolean {
	const search = step.params?.search;
	if (!search || (!search.castFree && !search.targetControllerAsActor && !search.filter.anyOf)) return false;

	const s = run.state;
	let actor: PlayerGameState = (step.actor ? run.playerRef(step.actor) : null) ?? run.you;
	if (search.targetControllerAsActor) {
		const tgt = run.ctx.targets[0];
		if (tgt) {
			if (tgt.kind === 'player') {
				actor = run.player(tgt.id) ?? actor;
			} else {
				const lkiCtrlId = run.initialSnapshots.get(tgt.id)?.controllerId;
				const found = run.locate(tgt.id);
				const ctrlId = lkiCtrlId ?? found?.inst.controllerId;
				if (ctrlId) actor = run.player(ctrlId) ?? actor;
			}
		}
	}
	if (actor.lost) return true;

	const chosenKey = `w9_search_pick:${run.stepIndex}`;
	const doneKey = `w9_search_done:${run.stepIndex}`;
	if (run.answers[doneKey]?.kind === 'yesNo' && run.answers[doneKey].yes) return true;

	const filter: ObjectFilter = search.filter ?? {};
	const cands = actor.library.filter((c) => helpers.matches(c, filter, 'library'));
	const wantCount = Math.min(
		cands.length,
		step.amount && step.amount.k !== 'const' ? Math.max(0, run.amount(step.amount, search.count)) : search.count
	);
	const minCount = search.upTo ? 0 : wantCount;

	let picked: CardInstance[];
	const savedAns = run.answers[chosenKey];
	if (savedAns?.kind === 'chooseObjects') {
		picked = helpers.answered(chosenKey, cands, minCount, wantCount) ?? [];
	} else if (cands.length === 0 || wantCount <= 0) {
		picked = [];
	} else if (!actor.isBot && run.canPause) {
		run.pauseForChoice(
			actor,
			`${run.ctx.title} — Search Library`,
			search.castFree
				? 'Choose a card from your library to cast without paying its mana cost.'
				: `Choose up to ${wantCount} matching card(s) from your library.`,
			cands.map((c) => c.instanceId),
			minCount,
			wantCount,
			'library',
			cands.slice(0, wantCount).map((c) => c.instanceId),
			chosenKey
		);
		return true;
	} else {
		const sorted = [...cands].sort((a, b) => objectManaValue(s, b) - objectManaValue(s, a));
		picked = sorted.slice(0, wantCount);
		run.answers[chosenKey] = {
			kind: 'chooseObjects',
			objectIds: picked.map((c) => c.instanceId)
		};
	}

	shuffleLibrary(s, actor);

	if (search.castFree) {
		const targetCard = picked[0];
		if (targetCard) {
			if (!step.optional && !run.answers[`castfree:ask:${run.stepIndex}:0`]) {
				run.answers[`castfree:ask:${run.stepIndex}:0`] = { kind: 'yesNo', yes: true };
			}
			const castStep: EffectStep = {
				verb: 'castFree',
				subject: { k: 'binding', name: `__w9_search_cast_${run.stepIndex}` },
				params: { castFreeSpec: { withoutPayingManaCost: true } },
				span: step.span
			};
			run.bindings.set(`__w9_search_cast_${run.stepIndex}`, [
				{ id: targetCard.instanceId, lki: run.snapshot(targetCard) }
			]);
			helpers.executeCastFreeStep(castStep);
		}
		run.answers[doneKey] = { kind: 'yesNo', yes: true };
		return true;
	}

	// Non-castFree with targetControllerAsActor (e.g. searching that controller's library to battlefield)
	const destSpec = search.destinations[0];
	const dest = destSpec?.zone === 'hand' ? 'hand' : 'battlefield';
	for (const o of picked) {
		moveObject(s, o, dest, {
			from: { player: actor, zone: 'library' },
			toPlayer: actor,
			newTimestamp: true,
			bumpVersion: true
		});
		if (dest === 'battlefield' && destSpec?.tapped && o.zone === 'battlefield') {
			o.tapped = true;
		}
	}
	run.bind(step, picked);
	run.answers[doneKey] = { kind: 'yesNo', yes: true };
	return true;
}

export function registerWave9DelayedTriggerStep(run: EffectRunAccess, step: EffectStep): boolean {
	const spec = step.params?.registerWave9DelayedTrigger;
	if (!spec || !step.delayed) return false;
	const s = run.state;
	const p = effectPorts();
	const compiled = compileCard(run.ctx.sourceCard);
	const faceIndex = run.ctx.item.faceIndex ?? 0;
	const face = compiled.faces[faceIndex];
	if (!face) return false;

	let abilityIndex = -1;
	const stepIdx = run.stepIndex;
	for (let ai = 0; ai < face.abilities.length; ai++) {
		const ab = face.abilities[ai]!;
		if (ab.kind === 'unsupported') continue;
		const eff =
			ab.kind === 'spell' || ab.kind === 'activated' || ab.kind === 'triggered'
				? ab.effect
				: undefined;
		if (!eff) continue;
		if (eff[stepIdx]?.verb === 'delayedTrigger' && eff[stepIdx].span.start === step.span.start) {
			abilityIndex = ai;
			break;
		}
	}
	if (abilityIndex < 0) {
		for (let ai = 0; ai < face.abilities.length; ai++) {
			const ab = face.abilities[ai]!;
			const eff =
				ab.kind === 'spell' || ab.kind === 'activated' || ab.kind === 'triggered'
					? ab.effect
					: undefined;
			if (eff?.[stepIdx]?.verb === 'delayedTrigger') {
				abilityIndex = ai;
				break;
			}
		}
	}
	if (abilityIndex < 0) return false;

	const watchedObjectIds = spec.bindSubjectAsWatched
		? run.objects(step.subject).map((o) => o.instanceId)
		: undefined;

	const curTurnSerial = s.turnSerial ?? s.turnNumber;
	const entry: Wave7SpellDelayedTrigger = {
		id: p.uid('w9dt', s),
		controllerId: run.you.playerId,
		sourceInstanceId: run.ctx.sourceId,
		sourceCard: run.ctx.sourceCard,
		faceIndex,
		abilityIndex,
		subTriggerStepIndex: stepIdx,
		oneShot: spec.duration === 'nextCombat',
		expiresEndOfTurn: spec.duration === 'thisTurn' || spec.duration === 'nextCombat',
		...(spec.duration === 'untilYourNextTurn'
			? {
					untilYourNextTurnOfPlayerId: run.you.playerId,
					createdOnTurnSerial: curTurnSerial
				}
			: {}),
		...(spec.duration === 'nextCombat'
			? {
					waitForNextCombatThisTurn: true,
					...(run.lastExtraCombatSlotId ? { extraCombatSlotId: run.lastExtraCombatSlotId } : {})
				}
			: {}),
		...(watchedObjectIds && watchedObjectIds.length > 0 ? { watchedObjectIds } : {})
	};
	(s.wave7SpellDelayedTriggers ??= []).push(entry);
	p.addLog(
		s,
		'rule',
		`${run.ctx.title}: registered delayed trigger (${spec.duration}).`,
		run.you.playerId
	);
	return true;
}

export function executePerOpponentTappedAttackingStep(
	run: EffectRunAccess,
	step: EffectStep,
	createOneToken: (spec: TokenSpec, controller: PlayerGameState) => CardInstance | null,
	createOneCopy?: (template: CardInstance, controller: PlayerGameState) => CardInstance | null
): boolean {
	const mode = step.params?.perOpponentTappedAttacking;
	if (!mode) return false;
	const s = run.state;
	const defendingNow = run.ctx.defendingPlayerId;
	const opps = s.players.filter(
		(pl) =>
			!pl.lost &&
			pl.playerId !== run.you.playerId &&
			(mode === 'all' || pl.playerId !== defendingNow)
	);
	const created: CardInstance[] = [];
	const copiesPerOpp = Math.max(1, run.amount(step.amount, 1));
	const template =
		step.verb === 'copyPermanent' ? run.objects(step.subject)[0] : undefined;

	for (const opp of opps) {
		for (let i = 0; i < copiesPerOpp; i++) {
			let inst: CardInstance | null = null;
			if (step.verb === 'createToken' && step.params?.token) {
				inst = createOneToken({ ...step.params.token, tapped: true }, run.you);
			} else if (step.verb === 'copyPermanent' && template && createOneCopy) {
				inst = createOneCopy(template, run.you);
			}
			if (!inst) continue;
			inst.tapped = true;
			if (s.combat.active) {
				s.combat.attackers.push({
					attackerInstanceId: inst.instanceId,
					controllerId: run.you.playerId,
					defenderPlayerId: opp.playerId,
					blockerInstanceIds: []
				});
			}
			created.push(inst);
		}
	}
	run.bind(step, created);
	return true;
}

export function exileStackTargetsWave9(
	run: EffectRunAccess,
	step: EffectStep,
	stampExiled: (inst: CardInstance, returnZone?: 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'stack' | 'command') => void
): boolean {
	if (step.subject.k !== 'target') return false;
	const tRefs = run.targetsForSpecIndex(step.subject.index);
	const stackRefs = tRefs.filter((t) => t.kind === 'stack');
	if (stackRefs.length === 0) return false;
	const s = run.state;
	const p = effectPorts();
	const exiledCards: CardInstance[] = [];
	for (const t of stackRefs) {
		const idx = s.stack.findIndex((x) => x.id === t.id);
		if (idx < 0) continue;
		const stk = s.stack[idx];
		if (stk.id === run.ctx.item.id) continue;
		s.stack.splice(idx, 1);
		if (stk.kind === 'spell' && !stk.isCopy) {
			H().moveStackSpellToZone(s, stk, 'exile');
			const movedInst = s.players
				.flatMap((pl) => pl.exile)
				.find((c) => c.instanceId === stk.sourceInstanceId);
			if (movedInst) {
				stampExiled(movedInst, 'stack');
				exiledCards.push(movedInst);
			}
			p.addLog(s, 'cast', `${run.ctx.title} exiled ${stk.title} from the stack.`, run.you.playerId);
		} else {
			p.addLog(
				s,
				'cast',
				`${run.ctx.title} exiled ${stk.title} from the stack (ceased to exist).`,
				run.you.playerId
			);
		}
	}
	run.bind(step, exiledCards);
	run.recordCountedKind('exiledThisWay', exiledCards.length);
	return stackRefs.length === tRefs.length;
}

/**
 * CR 707.9 / *Benthic Anomaly*: For each opponent, choose a creature that player controls, then
 * create a token copy of one of those creatures except its P/T is the total P/T of all chosen
 * creatures and it is a colorless Eldrazi in addition to its other types.
 */
export function executeBenthicAnomalyCloneWave9(
	run: EffectRunAccess,
	step: EffectStep
): void {
	const s = run.state;
	const p = effectPorts();
	const you = run.you;
	const opps = run.apnapPlayers().filter((pl) => pl.playerId !== you.playerId && !pl.lost);
	const chosen: CardInstance[] = [];

	for (const opp of opps) {
		const cands = opp.battlefield.filter(
			(b) => !b.phasedOut && evaluatePermanent(s, b).isCreature
		);
		if (cands.length === 0) continue;
		const sortedByPt = [...cands].sort((a, b) => {
			const ea = evaluatePermanent(s, a);
			const eb = evaluatePermanent(s, b);
			return (eb.power ?? 0) + (eb.toughness ?? 0) - ((ea.power ?? 0) + (ea.toughness ?? 0));
		});
		const best = sortedByPt[0];
		if (cands.length === 1 || you.isBot || !run.canPause) {
			chosen.push(best);
			continue;
		}
		const oppKey = `benthic_opp:${run.stepIndex}:${opp.playerId}`;
		const ans = run.answers[oppKey];
		if (!ans || ans.kind !== 'chooseObjects' || ans.objectIds.length === 0) {
			run.pauseForChoice(
				you,
				`${run.ctx.title} — Choose Creature (${opp.username})`,
				`Choose a creature ${opp.username} controls.`,
				cands.map((c) => c.instanceId),
				1,
				1,
				'battlefield',
				[best.instanceId],
				oppKey,
				'step'
			);
			return;
		}
		const picked = cands.find((c) => c.instanceId === ans.objectIds[0]) ?? best;
		chosen.push(picked);
	}

	if (chosen.length === 0) {
		run.bind(step, []);
		run.recordEffectAmount(0);
		return;
	}

	let totalPower = 0;
	let totalToughness = 0;
	for (const c of chosen) {
		const ev = evaluatePermanent(s, c);
		totalPower += ev.power ?? 0;
		totalToughness += ev.toughness ?? 0;
	}

	let template = chosen[0];
	if (chosen.length > 1 && !you.isBot && run.canPause) {
		const copyPickKey = `benthic_copy:${run.stepIndex}`;
		const copyAns = run.answers[copyPickKey];
		if (!copyAns || copyAns.kind !== 'chooseObjects' || copyAns.objectIds.length === 0) {
			run.pauseForChoice(
				you,
				`${run.ctx.title} — Choose Creature to Copy`,
				`Choose one of the chosen creatures for the ${totalPower}/${totalToughness} colorless Eldrazi token to copy.`,
				chosen.map((c) => c.instanceId),
				1,
				1,
				'battlefield',
				[chosen[0].instanceId],
				copyPickKey,
				'step'
			);
			return;
		}
		template = chosen.find((c) => c.instanceId === copyAns.objectIds[0]) ?? chosen[0];
	}

	const mult = Math.max(
		1,
		tokenMultiplier(s, you.playerId) * (you.tokenMultiplierThisTurn ?? 1)
	);
	const made: CardInstance[] = [];
	withSimultaneousZoneBatch(s, () => {
		for (let i = 0; i < mult; i++) {
			const tok = p.copyPermanentAsToken(
				s,
				you,
				template,
				run.ctx.title,
				false,
				{ power: totalPower, toughness: totalToughness },
				{ setColors: [], addTypes: ['Creature'], addSubtypes: ['Eldrazi'] }
			);
			if (run.ctx.sourceId) {
				tok.createdBySource = {
					instanceId: run.ctx.sourceId,
					objectVersion: run.ctx.item.sourceObjectVersion ?? 1
				};
			}
			made.push(tok);
		}
	});
	you.tokensCreatedCountThisTurn = (you.tokensCreatedCountThisTurn ?? 0) + made.length;
	run.recordEffectAmount(made.length);
	run.bind(step, made);
}

/**
 * CR 707.10 / *Ulalek, Fused Atrocity*: Copy all spells the actor controls on the stack, then
 * copy all other activated and triggered abilities the actor controls on the stack, allowing
 * optional retargeting of each copy.
 */
export function executeUlalekCopyStackWave9(
	run: EffectRunAccess,
	step: EffectStep
): void {
	const s = run.state;
	const p = effectPorts();
	const copyActor = (step.actor ? run.playerRef(step.actor) : null) ?? run.you;
	const snapKey = `ulalek_snap:${run.stepIndex}`;
	let snapIds: string[];
	const existingSnap = run.answers[snapKey];
	if (existingSnap && existingSnap.kind === 'chooseObjects') {
		snapIds = existingSnap.objectIds;
	} else {
		const curId = run.ctx.item.id;
		const ctrlId = copyActor.playerId;
		const spells = s.stack
			.filter(
				(it) =>
					it.id !== curId &&
					it.controllerId === ctrlId &&
					it.kind === 'spell' &&
					!spellCannotBeCopied(s, it)
			)
			.map((it) => it.id);
		const abilities = s.stack
			.filter(
				(it) => it.id !== curId && it.controllerId === ctrlId && it.kind !== 'spell'
			)
			.map((it) => it.id);
		snapIds = [...spells, ...abilities];
		run.answers[snapKey] = { kind: 'chooseObjects', objectIds: snapIds };
	}
	if (snapIds.length === 0) return;

	const sameRefList = (a: TargetRef[], b: TargetRef[]) =>
		a.length === b.length && a.every((x, idx) => x.kind === b[idx]?.kind && x.id === b[idx]?.id);

	run.runIndexedBatch(
		`ulalek_copy_batch:${run.stepIndex}`,
		() => snapIds,
		(origId, k) => {
			const orig: StackItem | undefined = s.stack.find((it) => it.id === origId);
			if (!orig) return;
			if (orig.kind === 'spell' && spellCannotBeCopied(s, orig)) return;

			let chosenTargets: TargetRef[] = orig.targets.map((trg) => ({ ...trg }));
			let chosenTargetsBySpec: TargetRef[][] | undefined = orig.targetsBySpec
				? orig.targetsBySpec.map((bucket) => bucket.map((trg) => ({ ...trg })))
				: undefined;

			if (step.params?.mayChooseNewTargets && orig.targets.length > 0) {
				const slots = p.getStackItemRetargetSlots(s, orig, copyActor.playerId);
				const hasLegalAlternative =
					slots.length > 0 &&
					slots.some((sl) => {
						if (sl.spec.min === 0 && sl.originalTargets.length > 0) return true;
						if (sl.legalCandidates.length < sl.spec.min) return false;
						if (sl.legalCandidates.length > sl.originalTargets.length) return true;
						return !sameRefList(sl.legalCandidates, sl.originalTargets);
					});
				if (hasLegalAlternative) {
					if (copyActor.isBot || !run.canPause) {
						const botChoice = p.chooseBotStackItemRetarget(s, copyActor, orig, slots, k);
						chosenTargets = botChoice.targets;
						chosenTargetsBySpec = botChoice.targetsBySpec;
					} else {
						const ynKey = `ulalek_retarget_yn:${run.stepIndex}:${k}`;
						const ynAns = run.answers[ynKey];
						if (!ynAns || ynAns.kind !== 'yesNo') {
							const curDesc = orig.targets.map((trg) => trg.label).join(', ');
							run.pauseForYesNo(
								copyActor,
								`${run.ctx.title} — Retarget Copy`,
								`Choose new targets for copy of ${orig.title}? (Current target${orig.targets.length === 1 ? '' : 's'}: ${curDesc})`,
								ynKey,
								{ yesLabel: 'Choose new targets', noLabel: 'Keep current targets' }
							);
							return;
						}
						if (ynAns.yes) {
							const nextBySpec: TargetRef[][] = [];
							for (let sIdx = 0; sIdx < slots.length; sIdx++) {
								const sl = slots[sIdx];
								if (sl.spec.min > 0 && sl.legalCandidates.length < sl.spec.min) {
									nextBySpec.push(sl.originalTargets.map((trg) => ({ ...trg })));
									continue;
								}
								const pool: TargetRef[] = [...sl.legalCandidates];
								if (slots.length > 1) {
									for (const origT of sl.originalTargets) {
										if (!pool.some((c) => c.kind === origT.kind && c.id === origT.id)) {
											pool.push({ ...origT });
										}
									}
								}
								if (pool.length === 0) {
									nextBySpec.push([]);
									continue;
								}
								const maxPick = Math.min(sl.spec.max, pool.length);
								const slotKey = `ulalek_retarget_slot:${run.stepIndex}:${k}:${sIdx}`;
								const slotAns = run.answers[slotKey];
								if (!slotAns || slotAns.kind !== 'chooseObjects') {
									const altCands = sl.legalCandidates.filter(
										(c) => !sl.originalTargets.some((o) => o.kind === c.kind && o.id === c.id)
									);
									const defaultRefs =
										altCands.length >= sl.spec.min
											? altCands.slice(0, Math.max(1, sl.spec.min))
											: sl.legalCandidates.slice(0, sl.spec.min);
									const countDesc =
										sl.spec.min === maxPick ? `${maxPick}` : `${sl.spec.min}–${maxPick}`;
									run.pauseForChoice(
										copyActor,
										`Copy of ${orig.title} — Choose New Target`,
										`Choose ${countDesc} target(s) for copy of ${orig.title}.`,
										pool.map((c) => c.id),
										sl.spec.min,
										maxPick,
										sl.zone === 'player' ? 'battlefield' : sl.zone,
										defaultRefs.map((r) => r.id),
										slotKey,
										'step'
									);
									return;
								}
								const picked = slotAns.objectIds
									.map((id) => pool.find((c) => c.id === id))
									.filter((c): c is TargetRef => Boolean(c));
								for (const c of sl.legalCandidates) {
									if (picked.length >= sl.spec.min) break;
									if (!picked.some((x) => x.kind === c.kind && x.id === c.id)) {
										picked.push(c);
									}
								}
								nextBySpec.push(picked.slice(0, maxPick));
							}
							if (p.validateStackItemRetarget(s, orig, copyActor.playerId, nextBySpec)) {
								chosenTargetsBySpec = nextBySpec;
								chosenTargets = nextBySpec.flat();
							}
						}
					}
				}
			}

			p.pushCopiedStackItem(s, copyActor, orig, chosenTargets, chosenTargetsBySpec);
		}
	);
}


