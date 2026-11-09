import { compileCard, compileSpellEffects } from './compiler/index.ts';
import {
	addLog,
	applyGameAction,
	checkAbilityActivationLegality,
	checkSpellCastLegality,
	chooseBotSpellCostPayment,
	evaluatePermanent,
	getAllLegalTargetsForRequirement,
	getCreaturePower,
	getCreatureToughness,
	getEffectiveActivatedAbilities,
	getPlayerCommanderIdentity,
	hasKeyword
} from './engine.ts';
import type { EffectStep, RestrictionKind, TargetSpec } from './ir.ts';
import { parseSpellOrAbilityEffects } from './oracle.ts';
import { chooseBotAnswer } from './runtime/choices.ts';
import { evaluateCondition, matchesObjectFilter } from './runtime/objectFilter.ts';
import type { CardInstance, GameState, PlayerGameState, ScryfallCard, StackItem, TargetRef } from './types.ts';

/**
 * Whether `perm` currently has any of `restriction` active on the battlefield, from its own
 * compiled static abilities (unless it has lost all abilities or is face down), from an attached
 * Aura/Equipment, or from another active permanent's static restriction filter.
 */
export function hasRestriction(
	state: GameState,
	perm: CardInstance,
	restriction: RestrictionKind | RestrictionKind[]
): boolean {
	const kinds = Array.isArray(restriction) ? restriction : [restriction];
	for (const player of state.players) {
		if (player.lost) continue;
		for (const source of player.battlefield) {
			if (source.phasedOut || source.isFaceDown) continue;
			if (evaluatePermanent(state, source).losesAllAbilities) continue;
			const card = source.copiableCard ?? source.card;
			const ctx = {
				state,
				controllerId: source.controllerId || player.playerId,
				source
			};
			for (const ab of compileCard(card).faces[0].abilities) {
				if (ab.kind !== 'static' || ab.static.k !== 'restriction') continue;
				const def = ab.static;
				if (!kinds.includes(def.restriction)) continue;
				const affected =
					def.affected === 'self'
						? source.instanceId === perm.instanceId
						: def.affected === 'attachedTo'
							? source.attachedToId === perm.instanceId
							: matchesObjectFilter(perm, def.affected, ctx);
				if (!affected) continue;
				if (def.condition && !evaluateCondition(def.condition, ctx)) continue;
				return true;
			}
		}
	}
	return false;
}

function cardSpellSteps(card: ScryfallCard): EffectStep[] {
	const face = compileCard(card).faces[0];
	const parsed = compileSpellEffects(card);
	return [
		...face.abilities.flatMap((a) =>
			a.kind === 'spell' ? [...a.effect, ...(a.modal?.modes.flatMap((m) => m.effect) ?? [])] : []
		),
		...(parsed?.steps ?? []),
		...(parsed?.modal?.modes.flatMap((m) => m.effect) ?? [])
	];
}

function isCounterSpellCard(card: ScryfallCard): boolean {
	return cardSpellSteps(card).some((s) => s.verb === 'counterSpell');
}

function isProtectionTrickCard(card: ScryfallCard): boolean {
	const types = compileCard(card).faces[0].characteristics.types;
	if (!types.includes('Instant')) return false;
	return cardSpellSteps(card).some((s) => {
		if (s.verb !== 'grant') return false;
		const kws = (s.params?.keywords ?? []).map((k) => k.toLowerCase());
		return kws.includes('hexproof') && kws.includes('indestructible');
	});
}

function isCreatureBoardWipeCard(card: ScryfallCard): boolean {
	return cardSpellSteps(card).some(
		(s) =>
			(s.verb === 'destroy' || s.verb === 'exile') &&
			s.subject.k === 'all' &&
			Boolean(s.subject.filter.types?.includes('Creature')) &&
			!s.subject.filter.controller
	);
}

function cardSpellTargetSpec(card: ScryfallCard): TargetSpec | undefined {
	for (const ab of compileCard(card).faces[0].abilities) {
		if (ab.kind === 'spell' && ab.targets.length > 0) return ab.targets[0];
	}
	return undefined;
}

export function hasAnyLegalInstantResponse(state: GameState, player: PlayerGameState): boolean {
	for (const cardInst of player.hand) {
		const types = compileCard(cardInst.card).faces[0].characteristics.types;
		if (types.includes('Land') && !types.includes('Creature')) {
			continue;
		}
		if (checkSpellCastLegality(state, player.playerId, cardInst, 'hand', 0).ok) {
			return true;
		}
	}
	for (const cmdInst of player.command) {
		if (checkSpellCastLegality(state, player.playerId, cmdInst, 'command', 0).ok) {
			return true;
		}
	}
	const cmdId = getPlayerCommanderIdentity(player);
	for (const perm of player.battlefield) {
		if (perm.phasedOut) continue;
		const abilities = getEffectiveActivatedAbilities(state, player, perm, cmdId);
		for (const ab of abilities) {
			if (ab.isManaAbility) continue;
			if (checkAbilityActivationLegality(state, player.playerId, perm, ab).ok) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Steps a bot loop may take per call. Tests and the golden games use the default; the lobby server
 * passes a larger budget because every triggered ability now uses the stack (a pass round per
 * trigger), and logs when even that is used up (a runaway loop, or a very long all-bot stretch).
 */
const DEFAULT_MAX_BOT_STEPS = 240;
export const SERVER_MAX_BOT_STEPS = 1500;

export function runAutomatedPriorityAndBots(
	state: GameState,
	opts: { maxSteps?: number; logOnCap?: boolean } = {}
): void {
	let safetyCounter = 0;
	const MAX_STEPS = opts.maxSteps ?? DEFAULT_MAX_BOT_STEPS;

	while (state.status === 'active') {
		if (safetyCounter >= MAX_STEPS) {
			if (opts.logOnCap) {
				addLog(state, 'system', `Automated play paused after ${MAX_STEPS} steps (safety cap); it continues with the next action.`);
			}
			break;
		}
		safetyCounter++;
		if (state.pendingPrompts.length > 0) {
			const pr = state.pendingPrompts[0];
			const promptPlayer = state.players.find((p) => p.playerId === pr.playerId);
			if (!promptPlayer || !promptPlayer.isBot) break;
			const answer = chooseBotAnswer(state, promptPlayer, pr);
			const res = applyGameAction(state, promptPlayer.playerId, {
				type: 'choice',
				promptId: pr.id,
				answer
			});
			if (!res.ok) break;
			continue;
		}
		const priorityPlayer = state.players[state.priorityPlayerIndex];
		const activePlayer = state.players[state.activePlayerIndex];
		if (!priorityPlayer || priorityPlayer.lost) break;

		if (priorityPlayer.isBot) {
			const didAct = executeBotStep(state, priorityPlayer, activePlayer);
			if (!didAct) break;
			continue;
		}

		// Human player holds priority:
		// Just like MTG Arena, if Full Control is OFF and the human does not need to declare blockers:
		// 1) If it is NOT the human's turn and the Stack is empty, auto-pass priority.
		// 2) If opponent spell(s)/abilities are on the Stack and the human has ZERO legal instant-speed
		//    spells or non-mana activated abilities to respond with, auto-pass priority so AI turns don't freeze.
		const isDefendingInBlockers =
			state.phase === 'declare_blockers' &&
			state.combat.attackers.some((a) => a.defenderPlayerId === priorityPlayer.playerId) &&
			!(state.combat.declaredBlockersPlayerIds || []).includes(priorityPlayer.playerId);

		if (!priorityPlayer.fullControl && priorityPlayer.autoPassEmptyStack && !isDefendingInBlockers) {
			const shouldAutoPassEmptyOffTurn =
				priorityPlayer.playerId !== activePlayer.playerId && state.stack.length === 0;
			// Steps C+D: the player's own triggered abilities don't stop auto-pass either (MTG Arena
			// resolves them unless Full Control is on); their own spells still do.
			const shouldAutoPassUnrespondableOpponentStack =
				state.stack.length > 0 &&
				state.stack.every((s) => s.controllerId !== priorityPlayer.playerId || s.kind === 'triggered') &&
				!hasAnyLegalInstantResponse(state, priorityPlayer);

			if (shouldAutoPassEmptyOffTurn || shouldAutoPassUnrespondableOpponentStack) {
				const res = applyGameAction(state, priorityPlayer.playerId, { type: 'pass_priority' });
				if (!res.ok) break;
				continue;
			}
		}

		break;
	}
}

function executeBotStep(
	state: GameState,
	bot: PlayerGameState,
	activePlayer: PlayerGameState
): boolean {
	const isBotsTurn = activePlayer.playerId === bot.playerId;

	// 1. If it's Declare Blockers and the bot is being attacked, assign smart legal blockers
	if (
		state.phase === 'declare_blockers' &&
		!isBotsTurn &&
		state.stack.length === 0
	) {
		const attacksAgainstBot = state.combat.attackers.filter(
			(a) => a.defenderPlayerId === bot.playerId
		);
		if (
			attacksAgainstBot.length > 0 &&
			!(state.combat.declaredBlockersPlayerIds || []).includes(bot.playerId)
		) {
			const assignments: Array<{ blockerInstanceId: string; attackerInstanceId: string }> = [];
			const usedBlockers = new Set<string>();

			for (const atk of attacksAgainstBot) {
				if (atk.blockerInstanceIds.length > 0) continue;
				const atkOwner = state.players.find((p) => p.playerId === atk.controllerId);
				const atkCard = atkOwner?.battlefield.find(
					(c) => !c.phasedOut && c.instanceId === atk.attackerInstanceId
				);
				if (!atkCard) continue;
				if (hasRestriction(state, atkCard, 'cantBeBlocked')) continue;
				if (hasKeyword(atkCard, 'Menace', state)) continue; // Keep simple single blocks safe

				const atkFly = hasKeyword(atkCard, 'Flying', state);
				const candidate = bot.battlefield.find((b) => {
					if (b.phasedOut || usedBlockers.has(b.instanceId) || b.tapped) return false;
					if (!evaluatePermanent(state, b).isCreature) return false;
					if (hasRestriction(state, b, ['cantBlock', 'cantAttackOrBlock'])) return false;
					if (atkFly && !hasKeyword(b, 'Flying', state) && !hasKeyword(b, 'Reach', state)) {
						return false;
					}
					const bTough = getCreatureToughness(b, state);
					const aPwr = getCreaturePower(atkCard, state);
					// Block if blocker survives OR attacker is lethal/big (>4 power)
					return bTough > aPwr || aPwr >= 4 || bot.life <= aPwr;
				});

				if (candidate) {
					usedBlockers.add(candidate.instanceId);
					assignments.push({
						blockerInstanceId: candidate.instanceId,
						attackerInstanceId: atk.attackerInstanceId
					});
				}
			}

			const bRes = applyGameAction(state, bot.playerId, {
				type: 'declare_blockers',
				assignments
			});
			if (bRes.ok) return true;
		}
	}

	// 2. If it's the bot's Main Phase and Stack is empty: play land, cast Commander or spells
	if (isBotsTurn && (state.phase === 'main1' || state.phase === 'main2') && state.stack.length === 0) {
		// 2a. Play a land if available
		if (bot.landsPlayedThisTurn < bot.maxLandsPerTurn) {
			const land = bot.hand.find((c) =>
				compileCard(c.card).faces[0].characteristics.types.includes('Land')
			);
			if (land) {
				const res = applyGameAction(state, bot.playerId, {
					type: 'play_land',
					instanceId: land.instanceId
				});
				if (res.ok) return true;
			}
		}

		// 2b. Try casting Commander from Command Zone if affordable and legal
		for (const cmd of bot.command) {
			if (checkSpellCastLegality(state, bot.playerId, cmd, 'command', 0).ok) {
				const targets = chooseBotTargetsForCard(state, bot, cmd);
				const costPayment = chooseBotSpellCostPayment(state, bot, cmd, 0);
				const res = applyGameAction(state, bot.playerId, {
					type: 'cast_spell',
					instanceId: cmd.instanceId,
					fromZone: 'command',
					targets,
					...(costPayment ? { costPayment } : {})
				});
				if (res.ok) return true;
			}
		}

		// 2c. Try casting a playable non-counterspell card from hand (prioritize ramp/artifacts/creatures)
		const opponentCreatureCount = state.players
			.filter((p) => p.playerId !== bot.playerId && !p.lost)
			.reduce(
				(acc, p) =>
					acc +
					p.battlefield.filter((b) => !b.phasedOut && evaluatePermanent(state, b).isCreature)
						.length,
				0
			);
		const ownPermanentCount = bot.battlefield.filter(
			(b) => !b.phasedOut && !evaluatePermanent(state, b).isLand
		).length;

		const castable = bot.hand
			.filter((c) => {
				const types = compileCard(c.card).faces[0].characteristics.types;
				if (types.includes('Land')) return false;
				if (isCounterSpellCard(c.card)) return false;
				// Do not waste pure protection tricks on an empty board / proactive main phase
				if (isProtectionTrickCard(c.card)) {
					return false;
				}
				// Do not cast board wipes if opponents control fewer than 2 creatures
				if (isCreatureBoardWipeCard(c.card) && opponentCreatureCount < 2) {
					return false;
				}
				return checkSpellCastLegality(state, bot.playerId, c, 'hand', 0).ok;
			})
			.sort((a, b) => a.card.cmc - b.card.cmc);

		for (const cardInst of castable) {
			const targets = chooseBotTargetsForCard(state, bot, cardInst);
			const spec = cardSpellTargetSpec(cardInst.card);
			const parsed = parseSpellOrAbilityEffects(cardInst.card);
			const minTargets = spec ? spec.min : parsed.requiresTarget ? parsed.targetInfo.minTargets : 0;
			if (minTargets > 0 && targets.length < minTargets) continue;

			const costPayment = chooseBotSpellCostPayment(state, bot, cardInst, 0);
			const res = applyGameAction(state, bot.playerId, {
				type: 'cast_spell',
				instanceId: cardInst.instanceId,
				targets,
				...(costPayment ? { costPayment } : {})
			});
			if (res.ok) return true;
		}

		// 2d. Try activating unattached Equipment (activated.attach) onto a controlled creature
		const ownCreatures = bot.battlefield
			.filter(
				(perm) =>
					!perm.phasedOut &&
					evaluatePermanent(state, perm).isCreature &&
					!hasKeyword(perm, 'Shroud', state)
			)
			.sort((a, b) => getCreaturePower(b, state) - getCreaturePower(a, state));
		if (ownCreatures.length > 0) {
			const cmdId = getPlayerCommanderIdentity(bot);
			for (const perm of bot.battlefield) {
				if (perm.phasedOut || perm.attachedToId) continue;
				const abilities = getEffectiveActivatedAbilities(state, bot, perm, cmdId);
				const equipAb = abilities.find((ab) => ab.id.startsWith('equip_'));
				if (
					equipAb &&
					checkAbilityActivationLegality(state, bot.playerId, perm, equipAb).ok
				) {
					const targetCreature = ownCreatures[0];
					const res = applyGameAction(state, bot.playerId, {
						type: 'activate_ability',
						instanceId: perm.instanceId,
						abilityId: equipAb.id,
						targets: [
							{
								kind: 'permanent',
								id: targetCreature.instanceId,
								label: targetCreature.card.name
							}
						]
					});
					if (res.ok) return true;
				}
			}
		}
	}

	// 3. If it's the bot's Declare Attackers step and Stack is empty
	if (isBotsTurn && state.phase === 'declare_attackers' && state.stack.length === 0 && !state.combat.active) {
		const eligibleAttackers = bot.battlefield.filter(
			(c) =>
				!c.phasedOut &&
				evaluatePermanent(state, c).isCreature &&
				!c.tapped &&
				(!c.summoningSick || hasKeyword(c, 'Haste', state)) &&
				!hasKeyword(c, 'Defender', state) &&
				!hasRestriction(state, c, ['cantAttack', 'cantAttackOrBlock']) &&
				getCreaturePower(c, state) >= 2
		);

		const opponents = state.players
			.filter((p) => p.playerId !== bot.playerId && !p.lost)
			.sort((a, b) => b.life - a.life);

		if (eligibleAttackers.length > 0 && opponents.length > 0) {
			const assignments = eligibleAttackers.map((atk, idx) => ({
				attackerInstanceId: atk.instanceId,
				defenderPlayerId: opponents[idx % opponents.length].playerId
			}));
			const res = applyGameAction(state, bot.playerId, {
				type: 'declare_attackers',
				assignments
			});
			if (res.ok) return true;
		} else {
			const res = applyGameAction(state, bot.playerId, {
				type: 'declare_attackers',
				assignments: []
			});
			if (res.ok) return true;
		}
	}

	// 4. Default: Pass priority
	const passRes = applyGameAction(state, bot.playerId, { type: 'pass_priority' });
	return passRes.ok;
}

function chooseBotTargetsForCard(
	state: GameState,
	bot: PlayerGameState,
	cardInst: CardInstance
): TargetRef[] {
	const spec = cardSpellTargetSpec(cardInst.card);
	const parsed = parseSpellOrAbilityEffects(cardInst.card);
	if (!spec && !parsed.requiresTarget) return [];

	const isControlledCreature = spec
		? spec.kind === 'object' &&
			spec.filter.controller === 'you' &&
			Boolean(spec.filter.types?.includes('Creature'))
		: parsed.targetKind === 'controlled_creature';

	if (isControlledCreature) {
		const ownCreatures = bot.battlefield
			.filter(
				(perm) =>
					!perm.phasedOut &&
					evaluatePermanent(state, perm).isCreature &&
					!hasKeyword(perm, 'Shroud', state)
			)
			.sort((a, b) => getCreaturePower(b, state) - getCreaturePower(a, state));
		if (ownCreatures.length > 0) {
			return [
				{
					kind: 'permanent',
					id: ownCreatures[0].instanceId,
					label: ownCreatures[0].card.name
				}
			];
		}
		return [];
	}

	const opponents = state.players.filter((p) => p.playerId !== bot.playerId && !p.lost);
	if (opponents.length === 0) return [];

	if ((spec && spec.kind === 'player') || (!spec && parsed.targetKind === 'player')) {
		const topOpp = opponents.sort((a, b) => b.life - a.life)[0];
		return [{ kind: 'player', id: topOpp.playerId, label: topOpp.username }];
	}

	const creatureOnly = spec
		? spec.kind === 'object' &&
			spec.filter.types?.length === 1 &&
			spec.filter.types[0] === 'Creature'
		: parsed.targetKind === 'creature';
	const artifactOrEnchantmentOnly = spec
		? spec.kind === 'object' &&
			spec.filter.types?.length === 2 &&
			spec.filter.types.includes('Artifact') &&
			spec.filter.types.includes('Enchantment')
		: parsed.targetKind === 'artifact_or_enchantment';

	// Find highest-CMC / highest-power opponent permanent without Hexproof/Shroud
	const enemyPermanents: Array<{ inst: CardInstance; owner: PlayerGameState }> = [];
	for (const opp of opponents) {
		for (const perm of opp.battlefield) {
			if (perm.phasedOut) continue;
			if (hasKeyword(perm, 'Hexproof', state) || hasKeyword(perm, 'Shroud', state)) continue;
			const evalPerm = evaluatePermanent(state, perm);
			if (creatureOnly && !evalPerm.isCreature) continue;
			if (artifactOrEnchantmentOnly && !evalPerm.isArtifact && !evalPerm.isEnchantment) {
				continue;
			}
			if (evalPerm.isLand) continue;
			enemyPermanents.push({ inst: perm, owner: opp });
		}
	}

	enemyPermanents.sort((a, b) => b.inst.card.cmc - a.inst.card.cmc);
	if (enemyPermanents.length > 0) {
		return [
			{
				kind: 'permanent',
				id: enemyPermanents[0].inst.instanceId,
				label: enemyPermanents[0].inst.card.name
			}
		];
	}

	if ((spec && spec.kind === 'objectOrPlayer') || (!spec && parsed.targetKind === 'any')) {
		const topOpp = opponents.sort((a, b) => b.life - a.life)[0];
		return [{ kind: 'player', id: topOpp.playerId, label: topOpp.username }];
	}

	// Last resort: any legal target except the bot's own permanents, itself and its own spells, so a
	// removal spell is never aimed at the bot's side when opponents have nothing to hit.
	const allLegal = getAllLegalTargetsForRequirement(
		state,
		bot.playerId,
		parsed.targetInfo,
		cardInst.card,
		cardInst.instanceId
	).filter((t) => {
		if (t.kind === 'player') return t.id !== bot.playerId;
		if (t.kind === 'permanent') return !bot.battlefield.some((p) => p.instanceId === t.id);
		if (t.kind === 'stack') return state.stack.find((s) => s.id === t.id)?.controllerId !== bot.playerId;
		return true;
	});
	if (allLegal.length > 0 && allLegal.length >= parsed.targetInfo.minTargets) {
		return allLegal.slice(0, parsed.targetInfo.minTargets);
	}

	return [];
}

// ---- Triggered abilities (steps C+D) -----------------------------------------------------------

/** Verbs that are bad for the object or player they act on. */
const HARMFUL_VERBS = new Set<EffectStep['verb']>([
	'destroy',
	'exile',
	'bounce',
	'damage',
	'loseLife',
	'sacrifice',
	'tap',
	'discard',
	'mill',
	'counterSpell',
	'phaseOut',
	'fight',
	'lose'
]);

/** Whether the steps acting on target `index` hurt it (true), help it (false). */
function targetIsHarmed(steps: EffectStep[], index: number): boolean {
	const acting = steps.filter(
		(s) =>
			(s.subject.k === 'target' && s.subject.index === index) ||
			(s.subject.k === 'playerRef' && s.subject.ref.k === 'target' && s.subject.ref.index === index)
	);
	if (acting.length === 0) return true;
	return acting.some((s) => {
		if (s.verb === 'pump') return (s.amount?.k === 'const' && s.amount.n < 0) || s.amount?.k === 'negate';
		if (s.verb === 'putCounters') return s.params?.counter === '-1/-1' || s.params?.counter === 'stun';
		// Returning a card from a graveyard to hand or the battlefield helps; exiling it hurts.
		if (s.verb === 'move') return s.params?.to === 'exile';
		return HARMFUL_VERBS.has(s.verb);
	});
}

/**
 * A bot's targets for one target spec of its triggered ability (CR 603.3d), from the legal
 * candidates the engine computed: opponents' best permanents (or the opponent with the least life)
 * for harmful effects, its own for helpful ones. Optional targets ("up to one") are only taken when
 * a candidate is on the right side.
 */
export function chooseBotTriggerTargets(
	state: GameState,
	bot: PlayerGameState,
	steps: EffectStep[],
	index: number,
	spec: TargetSpec,
	legal: TargetRef[]
): TargetRef[] {
	const harmful = targetIsHarmed(steps, index);
	const ownerOf = (t: TargetRef): string | undefined => {
		if (t.kind === 'player') return t.id;
		for (const p of state.players) {
			if (p.battlefield.some((c) => c.instanceId === t.id)) {
				return p.battlefield.find((c) => c.instanceId === t.id)!.controllerId;
			}
			if (p.graveyard.some((c) => c.instanceId === t.id)) return p.playerId;
		}
		return undefined;
	};
	const value = (t: TargetRef): number => {
		if (t.kind === 'player') {
			const p = state.players.find((x) => x.playerId === t.id);
			return p ? 100 - p.life : 0;
		}
		for (const p of state.players) {
			const c = p.battlefield.find((x) => x.instanceId === t.id) ?? p.graveyard.find((x) => x.instanceId === t.id);
			if (c) return c.card.cmc + (c.zone === 'battlefield' && evaluatePermanent(state, c).isCreature ? getCreaturePower(c, state) : 0);
		}
		return 0;
	};
	const good = (t: TargetRef) => (ownerOf(t) === bot.playerId) !== harmful;
	const ranked = [...legal].sort((a, b) => {
		const ga = good(a) ? 1 : 0;
		const gb = good(b) ? 1 : 0;
		if (ga !== gb) return gb - ga;
		// On the wrong side, prefer the least valuable; on the right side, the most.
		return ga ? value(b) - value(a) : value(a) - value(b);
	});
	const wanted = Math.max(spec.min, Math.min(spec.max, ranked.filter(good).length));
	return ranked.slice(0, Math.min(wanted, spec.max));
}

/**
 * Whether a bot uses the optional ("you may") part of its resolving triggered ability. Bots take
 * optional effects unless they would deck themselves or sacrifice their own permanents.
 */
export function botAcceptsOptionalTrigger(
	state: GameState,
	bot: PlayerGameState,
	optionalSteps: EffectStep[],
	item: StackItem
): boolean {
	void state;
	void item;
	for (const s of optionalSteps) {
		if (s.verb === 'draw' && bot.library.length <= 3) return false;
		if (s.verb === 'sacrifice' || s.verb === 'loseLife' || s.verb === 'discard') return false;
	}
	return true;
}
