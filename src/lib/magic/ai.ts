import {
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
import { cardHasPrintedUnblockable, parseSpellOrAbilityEffects } from './oracle.ts';
import type { CardInstance, GameState, PlayerGameState, TargetRef } from './types.ts';

export function hasAnyLegalInstantResponse(state: GameState, player: PlayerGameState): boolean {
	for (const cardInst of player.hand) {
		if (cardInst.card.typeLine.includes('Land') && !cardInst.card.typeLine.includes('Creature')) {
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

export function runAutomatedPriorityAndBots(state: GameState): void {
	let safetyCounter = 0;
	const MAX_STEPS = 80;

	while (safetyCounter < MAX_STEPS && state.status === 'active' && state.pendingPrompts.length === 0) {
		safetyCounter++;
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
			const shouldAutoPassUnrespondableOpponentStack =
				state.stack.length > 0 &&
				state.stack.every((s) => s.controllerId !== priorityPlayer.playerId) &&
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
				if (cardHasPrintedUnblockable(atkCard.card)) continue;
				if (hasKeyword(atkCard, 'Menace', state)) continue; // Keep simple single blocks safe

				const atkFly = hasKeyword(atkCard, 'Flying', state);
				const candidate = bot.battlefield.find((b) => {
					if (b.phasedOut || usedBlockers.has(b.instanceId) || b.tapped) return false;
					if (!evaluatePermanent(state, b).isCreature) return false;
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
			const land = bot.hand.find((c) => c.card.typeLine.includes('Land'));
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
				if (c.card.typeLine.includes('Land')) return false;
				const oLow = c.card.oracleText.toLowerCase();
				if (oLow.includes('counter target')) return false;
				// Do not waste pure protection tricks on an empty board / proactive main phase
				if (
					c.card.typeLine.includes('Instant') &&
					oLow.includes('gain hexproof and indestructible')
				) {
					return false;
				}
				// Do not cast board wipes if opponents control fewer than 2 creatures
				if (
					(oLow.includes('destroy all creatures') || oLow.includes('exile all creatures')) &&
					opponentCreatureCount < 2
				) {
					return false;
				}
				return checkSpellCastLegality(state, bot.playerId, c, 'hand', 0).ok;
			})
			.sort((a, b) => a.card.cmc - b.card.cmc);

		for (const cardInst of castable) {
			const targets = chooseBotTargetsForCard(state, bot, cardInst);
			const parsed = parseSpellOrAbilityEffects(cardInst.card);
			if (parsed.requiresTarget && targets.length < parsed.targetInfo.minTargets) continue;

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
	const parsed = parseSpellOrAbilityEffects(cardInst.card);
	if (!parsed.requiresTarget) return [];

	if (parsed.targetKind === 'controlled_creature') {
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

	if (parsed.targetKind === 'player') {
		const topOpp = opponents.sort((a, b) => b.life - a.life)[0];
		return [{ kind: 'player', id: topOpp.playerId, label: topOpp.username }];
	}

	// Find highest-CMC / highest-power opponent permanent without Hexproof/Shroud
	const enemyPermanents: Array<{ inst: CardInstance; owner: PlayerGameState }> = [];
	for (const opp of opponents) {
		for (const perm of opp.battlefield) {
			if (perm.phasedOut) continue;
			if (hasKeyword(perm, 'Hexproof', state) || hasKeyword(perm, 'Shroud', state)) continue;
			const evalPerm = evaluatePermanent(state, perm);
			if (parsed.targetKind === 'creature' && !evalPerm.isCreature) continue;
			if (
				parsed.targetKind === 'artifact_or_enchantment' &&
				!evalPerm.isArtifact &&
				!evalPerm.isEnchantment
			) {
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

	if (parsed.targetKind === 'any') {
		const topOpp = opponents.sort((a, b) => b.life - a.life)[0];
		return [{ kind: 'player', id: topOpp.playerId, label: topOpp.username }];
	}

	const allLegal = getAllLegalTargetsForRequirement(
		state,
		bot.playerId,
		parsed.targetInfo,
		cardInst.card,
		cardInst.instanceId
	);
	if (allLegal.length >= parsed.targetInfo.minTargets) {
		return allLegal.slice(0, parsed.targetInfo.minTargets);
	}

	return [];
}
