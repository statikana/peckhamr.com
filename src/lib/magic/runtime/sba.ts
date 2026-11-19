import { type EvaluatedPermanent, evaluatePermanent, playerCannotLoseGame } from '../ruleTree.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import type {
	CardInstance,
	CounterType,
	GameState,
	PlayerGameState,
	StackItem,
	TargetRef
} from '../types.ts';
import { enqueueChoicePrompt } from './choices.ts';
import { applyDamagePreventionShields, isDamageUnpreventable } from './copyPreventionAndEffects.ts';
import { releaseExiledUntilOpponentMonarch } from './effectsWave11.ts';
import { applyDungeonCompletionSba, applyRoleTokenSba, handleInitiativePlayerEliminated } from './effectsWave5.ts';
import {
	addLog,
	advancePriorityToNextPlayer,
	emitVfx,
	findPermanentOnBoard,
	getCreaturePower,
	getSagaFinalChapterNumber,
	H,
	movePermanentToZone,
	revealFaceDownObjects
} from './engineHost.ts';
import { emitEvent } from './events.ts';
import { activeAbilityDefs, instanceFaceOptions } from './faces.ts';
import {
	checkBattleStateBasedActions,
	checkSpeedAscendAndDayNightSbas,
	isPermanentBattle,
	onBattleDefenseCountersRemoved,
	onPlayerLostLifeCheckSpeedTrigger
} from './framesBattlesAndKeywordsWave5.ts';
import {
	checkP21AuraPermanentAttachment,
	collectGraveyardAuraAttachCandidates,
	ensureSpaceSculptorSectors,
	isAuraGraveyardAttachmentLegal
} from './framesWave7.ts';
import { recordPlayerLifeLossWave4, tryUmbraArmorInsteadOfDestroy } from './keywordsWave4.ts';
import {
	checkStoriedDesignations,
	enforceSoulbondPairs,
	isFortificationIllegalAttachment
} from './keywordsWave6.ts';
import { noteLayerInputsChanged, withStableLayerInputs } from './layerCache.ts';
import { matchesObjectFilter } from './objectFilter.ts';
import { uid } from './random.ts';
import { isPermanentExemptFromLegendRule } from './staticsWave6.ts';
import { playerDontLoseAtZeroOrLessLife } from './staticsWave7.ts';
import { playerProtectedFromSourceWave8 } from './staticsWave8.ts';
import { checkStateTriggers, flushTriggers, peekPendingTriggers } from './triggers.ts';
import { getAttachedCardsOnBoard } from './viewerRedaction.ts';
import {
	moveObject,
	removeFromGame,
	returnLinkedExiledForSources,
	setZoneOrder,
	syncBattlefieldControllers,
	transferBattlefieldControl
} from './zones.ts';

function getAuraEnchantParams(aura: CardInstance, evalAura: EvaluatedPermanent): string[] {
	const params: string[] = [];
	if (!evalAura.losesAllAbilities) {
		for (const ab of activeAbilityDefs(
			effectiveCardForObject(aura),
			instanceFaceOptions(aura, 'battlefield')
		)) {
			if (ab.kind === 'keyword' && ab.keyword.name.toLowerCase() === 'enchant') {
				params.push((ab.keyword.param ?? 'permanent').trim());
			}
		}
	}
	for (const kwLine of evalAura.keywords) {
		if (kwLine.toLowerCase().startsWith('enchant ')) {
			const p = kwLine.slice('enchant '.length).trim();
			if (p && !params.some((existing) => existing.toLowerCase() === p.toLowerCase())) {
				params.push(p);
			}
		}
	}
	return params;
}

function matchesSingleEnchantParamOnPermanent(
	enchantParam: string,
	auraController: PlayerGameState,
	evalHost: EvaluatedPermanent,
	hostController: PlayerGameState
): boolean {
	let param = enchantParam.toLowerCase().trim();
	if (
		param === 'player' ||
		param === 'opponent' ||
		param === 'an opponent' ||
		param === 'you'
	) {
		return false;
	}
	if (param.includes('you control')) {
		if (hostController.playerId !== auraController.playerId) return false;
		param = param.replace(/\byou control\b/g, '').trim();
	} else if (param.includes('opponent controls')) {
		if (hostController.playerId === auraController.playerId) return false;
		param = param.replace(/\ban?\s+opponent controls\b|\bopponent controls\b/g, '').trim();
	}

	if (param.includes('nonland')) {
		if (evalHost.isLand) return false;
		param = param.replace(/\bnonland\b/g, '').trim();
	}
	if (!param || param.includes('permanent')) return true;

	const disjuncts = param
		.split(/\s*(?:,|\bor\b)\s*/)
		.map((d) => d.trim())
		.filter(Boolean);
	if (disjuncts.length === 0) return true;

	return disjuncts.some((d) => {
		if (d === 'creature') return evalHost.isCreature;
		if (d === 'artifact') return evalHost.isArtifact;
		if (d === 'enchantment') return evalHost.isEnchantment;
		if (d === 'land') return evalHost.isLand;
		if (d === 'planeswalker') return evalHost.isPlaneswalker;
		if (d === 'battle') return evalHost.typeLine.includes('Battle');
		return evalHost.hasSubType(d) || evalHost.typeLine.toLowerCase().includes(d);
	});
}

function isAuraAttachmentLegal(
	state: GameState,
	aura: CardInstance,
	auraController: PlayerGameState,
	evalAura: EvaluatedPermanent,
	host: CardInstance,
	hostController: PlayerGameState
): boolean {
	// CR 303.4d: An Aura can't enchant itself. If this occurs somehow, the Aura is put into its owner's graveyard.
	// CR 303.4d: An Aura that's also a creature can't enchant anything.
	if (aura.instanceId === host.instanceId) return false;
	if (evalAura.isCreature) return false;
	if (host.phasedOut) return false;
	// --- Track P14: CR 702.16n, 702.16p attachment exemption check ---
	if (H().hasProtectionFrom(host, aura.copiableCard ?? aura.card, state, aura, true)) return false;
	// --- End Track P14 ---
	// --- Track P21: Structured `enchantFilter` & reanimated-creature Aura legality ---
	const p21PermCheck = checkP21AuraPermanentAttachment(
		state,
		aura,
		auraController,
		evalAura,
		host,
		matchesObjectFilter
	);
	if (p21PermCheck === 'legal') return true;
	if (p21PermCheck === 'illegal') return false;
	// --- End Track P21 ---

	const enchantParams = getAuraEnchantParams(aura, evalAura);
	// CR 704.5m / 303.4c: If an Aura has lost all its enchant abilities, it can't legally enchant anything.
	if (enchantParams.length === 0) return !evalAura.losesAllAbilities;

	const evalHost = evaluatePermanent(state, host);
	// CR 702.5c: If an Aura has multiple instances of enchant, all of its enchant abilities must be satisfied.
	return enchantParams.every((p) =>
		matchesSingleEnchantParamOnPermanent(p, auraController, evalHost, hostController)
	);
}

function isAuraPlayerAttachmentLegal(
	aura: CardInstance,
	auraController: PlayerGameState,
	evalAura: EvaluatedPermanent,
	hostPlayer: PlayerGameState,
	// --- Track P22a ---
	state?: GameState
	// --- End Track P22a ---
): boolean {
	if (hostPlayer.lost) return false;
	if (evalAura.isCreature) return false;
	if (hostPlayer.protectionFromEverythingThisTurn) return false;
	// --- Track P22a: CR 702.16j Player protection from chosen card type unattaches/blocks Auras ---
	if (
		state &&
		playerProtectedFromSourceWave8(
			state,
			hostPlayer.playerId,
			aura.copiableCard ?? aura.card,
			aura
		)
	) {
		return false;
	}
	// --- End Track P22a ---

	const enchantParams = getAuraEnchantParams(aura, evalAura);
	if (enchantParams.length === 0) return false;

	// CR 702.5c: All enchant abilities on the Aura must be satisfied by the enchanted player.
	return enchantParams.every((raw) => {
		const param = raw.toLowerCase().trim();
		if (param === 'player' || param.includes('player')) {
			if (param.includes('opponent')) {
				return hostPlayer.playerId !== auraController.playerId;
			}
			return true;
		}
		if (param === 'opponent' || param === 'an opponent') {
			return hostPlayer.playerId !== auraController.playerId;
		}
		if (param === 'you') {
			return hostPlayer.playerId === auraController.playerId;
		}
		return false;
	});
}

function isAuraHarmful(aura: CardInstance): boolean {
	for (const ab of activeAbilityDefs(
		effectiveCardForObject(aura),
		instanceFaceOptions(aura, 'battlefield')
	)) {
		if (ab.kind !== 'static') continue;
		if (ab.static.k === 'restriction') return true;
		if (ab.static.k === 'continuous') {
			if (ab.static.mod.k === 'removeAllAbilities') return true;
			if (ab.static.mod.k === 'pt') {
				const pw = ab.static.mod.power;
				const tg = ab.static.mod.toughness;
				if ((pw.k === 'const' && pw.n < 0) || (tg.k === 'const' && tg.n < 0)) return true;
			}
		}
	}
	return false;
}

/**
 * CR 303.4f–g: Returns the legal object/player ids that `aura` may enchant when entering the
 * battlefield under `controller`'s control without being cast, ranked by the bot heuristic.
 */
export function legalAuraAttachCandidates(
	state: GameState,
	aura: CardInstance,
	controller: PlayerGameState
): string[] {
	const evalAura = evaluatePermanent(state, aura);
	const harmful = isAuraHarmful(aura);
	const permCandidates: Array<{ id: string; preferred: boolean; score: number }> = [];
	for (const p of state.players) {
		if (p.lost) continue;
		for (const host of p.battlefield) {
			if (isAuraAttachmentLegal(state, aura, controller, evalAura, host, p)) {
				const isOwn = p.playerId === controller.playerId;
				const preferred = harmful ? !isOwn : isOwn;
				const evalHost = evaluatePermanent(state, host);
				const score =
					host.card.cmc + (evalHost.isCreature ? getCreaturePower(host, state) : 0);
				permCandidates.push({ id: host.instanceId, preferred, score });
			}
		}
	}
	permCandidates.sort((a, b) => {
		if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
		return a.preferred ? b.score - a.score : a.score - b.score;
	});

	const playerCandidates: Array<{ id: string; preferred: boolean; score: number }> = [];
	for (const p of state.players) {
		// --- Track P22a ---
		if (!p.lost && isAuraPlayerAttachmentLegal(aura, controller, evalAura, p, state)) {
		// --- End Track P22a ---
			const isOwn = p.playerId === controller.playerId;
			const preferred = harmful ? !isOwn : isOwn;
			playerCandidates.push({ id: p.playerId, preferred, score: p.life });
		}
	}
	playerCandidates.sort((a, b) => {
		if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
		return b.score - a.score;
	});

	return [
		...permCandidates.map((c) => c.id),
		...playerCandidates.map((c) => c.id),
		// --- Track P21: Graveyard card candidates for "Enchant [type] card in a graveyard" Auras ---
		...collectGraveyardAuraAttachCandidates(state, aura, controller, matchesObjectFilter)
		// --- End Track P21 ---
	];
}

/**
 * CR 704.3: State-Based Actions are checked in an iterative fixpoint loop
 * until a pass produces no state-based actions.
 */
export function checkStateBasedActions(state: GameState): void {
	if (state.status !== 'active') return;
	// CR 616.1, 704.3, 704.4: While a replacement-choice prompt (`counter_replacement_choice` or
	// `zone_replacement_choice`), pending zone move, pending cost payment, pending procedure, or
	// mid-resolution stack item is active, do not check SBAs yet;
	// `resumeStackItem` / `resumeAfterPrompt` runs `checkStateBasedActions` once it finishes.
	if (state.pendingPrompts.some((pr) => pr.choice?.kind === 'chooseReplacement')) return;
	if (state.pendingZoneMoves && state.pendingZoneMoves.length > 0) return;
	if (state.pendingCostPayment) return;
	if (state.pendingProcedure) return;
	if (state.stack.some((s) => Boolean(s.resolutionStarted))) return;

	syncBattlefieldControllers(state);

	let maxIterations = 25;
	let anyActionTaken = true;

	while (anyActionTaken && maxIterations-- > 0) {
		if (state.pendingPrompts.some((pr) => pr.choice?.kind === 'chooseReplacement')) break;
		anyActionTaken = false;

		// 0. Pre-annihilation LKI snapshot (CR 704.8) before any SBAs in this pass modify the board
		const prePassSnapshot = new Map<
			string,
			{ counters: Record<CounterType, number>; evalPerm: EvaluatedPermanent }
		>();
		// Read-only scan: validate the layer cache once (Phase 6c).
		withStableLayerInputs(state, () => {
			for (const p of state.players) {
				if (p.lost) continue;
				for (const perm of p.battlefield) {
					if (perm.phasedOut) continue;
					prePassSnapshot.set(perm.instanceId, {
						counters: { ...perm.counters },
						evalPerm: evaluatePermanent(state, perm)
					});
				}
			}
		});

		// --- Track P11 ---
		let boardInvalidatedInPass = false;
		// --- End Track P11 ---

		// CR 506.4: Remove from combat any attacking or blocking permanent that left the battlefield,
		// phased out, stopped being a creature, or became a battle.
		if (state.combat.active && state.combat.attackers.length > 0) {
			const isCombatCreature = (id: string): boolean => {
				const snap = prePassSnapshot.get(id);
				return Boolean(
					snap && snap.evalPerm.isCreature && !snap.evalPerm.typeLine.includes('Battle')
				);
			};
			const prevAtkCount = state.combat.attackers.length;
			let combatChanged = false;
			state.combat.attackers = state.combat.attackers.filter((atk) =>
				isCombatCreature(atk.attackerInstanceId)
			);
			if (state.combat.attackers.length !== prevAtkCount) combatChanged = true;
			for (const atk of state.combat.attackers) {
				if (atk.blockerInstanceIds.length > 0) {
					const prevBlkLen = atk.blockerInstanceIds.length;
					atk.blockerInstanceIds = atk.blockerInstanceIds.filter(isCombatCreature);
					if (atk.blockerInstanceIds.length !== prevBlkLen) combatChanged = true;
				}
				if (atk.defenderPlaneswalkerId && atk.defenderPlaneswalkerId !== 'removed') {
					const pwSnap = prePassSnapshot.get(atk.defenderPlaneswalkerId);
					const defPlayer = state.players.find((p) => p.playerId === atk.defenderPlayerId);
					const onDefBattlefield = defPlayer?.battlefield.some(
						(c) => !c.phasedOut && c.instanceId === atk.defenderPlaneswalkerId
					);
					if (!pwSnap || !onDefBattlefield || !pwSnap.evalPerm.isPlaneswalker) {
						atk.defenderPlaneswalkerId = 'removed';
					}
				}
				// --- Track P15: CR 310.10 / CR 506.4c Battle combat removal check ---
				if (atk.defenderBattleId && atk.defenderBattleId !== 'removed') {
					const bFound = findPermanentOnBoard(state, atk.defenderBattleId);
					if (
						!bFound ||
						bFound.inst.phasedOut ||
						!isPermanentBattle(state, bFound.inst) ||
						bFound.inst.protectorId !== atk.defenderPlayerId
					) {
						atk.defenderBattleId = 'removed';
					}
				}
				// --- End Track P15 ---
			}
			if (combatChanged) {
				noteLayerInputsChanged(state);
				boardInvalidatedInPass = true;
			}
		}

		// 1. +1/+1 and -1/-1 counter annihilation (CR 704.5q)
		for (const p of state.players) {
			if (p.lost) continue;
			for (const perm of p.battlefield) {
				if (perm.phasedOut) continue;
				const plus = perm.counters['+1/+1'] || 0;
				const minus = perm.counters['-1/-1'] || 0;
				if (plus > 0 && minus > 0) {
					const cancel = Math.min(plus, minus);
					perm.counters['+1/+1'] -= cancel;
					perm.counters['-1/-1'] -= cancel;
					anyActionTaken = true;
					boardInvalidatedInPass = true;
				}
			}
		}

		// Collect all battlefield-to-graveyard SBAs across all players in this pass (CR 704.3, 603.10a)
		const sbaGraveyardBatch: Array<{
			perm: CardInstance;
			controller: PlayerGameState;
			kind: 'aura' | 'dying' | 'legend' | 'saga';
			legName?: string;
		}> = [];
		const queuedIds = new Set<string>();
		const queueToGraveyard = (
			perm: CardInstance,
			controller: PlayerGameState,
			kind: 'aura' | 'dying' | 'legend' | 'saga',
			legName?: string
		) => {
			if (queuedIds.has(perm.instanceId)) return;
			queuedIds.add(perm.instanceId);
			sbaGraveyardBatch.push({ perm, controller, kind, legName });
		};

		// Steps 2-4 only read layer results, except the `attachedToId` writes, each followed by
		// noteLayerInputsChanged (Phase 6c).
		withStableLayerInputs(state, () => {
			// --- Track P11: Reuse Step 0 evaluated snapshot while board inputs remain unchanged ---
			const getSbaEval = (inst: CardInstance): EvaluatedPermanent =>
				(!boardInvalidatedInPass ? prePassSnapshot.get(inst.instanceId)?.evalPerm : undefined) ??
				evaluatePermanent(state, inst);
			// --- End Track P11 ---
			for (const p of state.players) {
				if (p.lost) continue;

				// 2. Unattach Auras/Equipment attached to illegal/missing/non-creature permanents (CR 303.4d, 702.16c-d, 704.5m-n)
				for (const perm of p.battlefield) {
					if (perm.phasedOut) continue;
					const evalPerm = getSbaEval(perm);
					const isAura = evalPerm.hasSubType('Aura') || evalPerm.typeLine.includes('Aura');
					const isEquipment =
						evalPerm.hasSubType('Equipment') || evalPerm.typeLine.includes('Equipment');
					// --- Track P18a: CR 301.6 / CR 704.5n Fortification attachment SBA ---
					const isFortification =
						evalPerm.hasSubType('Fortification') || evalPerm.typeLine.includes('Fortification');
					// --- End Track P18a ---

					if (isAura) {
						if (!perm.attachedToId) {
							// --- Track P12: CR 702.103f Bestow ceases to be bestowed instead of going to graveyard ---
							if (perm.isBestowed) {
								perm.isBestowed = false;
								noteLayerInputsChanged(state);
								boardInvalidatedInPass = true;
								anyActionTaken = true;
							} else {
								queueToGraveyard(perm, p, 'aura');
							}
							// --- End Track P12 ---
						} else {
							const targetFound = findPermanentOnBoard(state, perm.attachedToId);
							if (targetFound) {
								if (
									!isAuraAttachmentLegal(
										state,
										perm,
										p,
										evalPerm,
										targetFound.inst,
										targetFound.controller
									)
								) {
									perm.attachedToId = null;
									// --- Track P12 + P11: CR 702.103f Bestow unattach ---
									if (perm.isBestowed) {
										perm.isBestowed = false;
										noteLayerInputsChanged(state);
										boardInvalidatedInPass = true;
										anyActionTaken = true;
									} else {
										noteLayerInputsChanged(state);
										boardInvalidatedInPass = true;
										queueToGraveyard(perm, p, 'aura');
									}
									// --- End Track P12 + P11 ---
								}
							} else {
								const targetPlayer = state.players.find(
									(pl) => pl.playerId === perm.attachedToId && !pl.lost
								);
								if (
									(!targetPlayer ||
										!isAuraPlayerAttachmentLegal(perm, p, evalPerm, targetPlayer, state)) &&
									// --- Track P21 (CR 303.4, 704.5m): Graveyard card attachment SBA ---
									!isAuraGraveyardAttachmentLegal(
										state,
										perm,
										p,
										evalPerm,
										matchesObjectFilter
									)
									// --- End Track P21 ---
								) {
									perm.attachedToId = null;
									// --- Track P12 + P11: CR 702.103f Bestow unattach ---
									if (perm.isBestowed) {
										perm.isBestowed = false;
										noteLayerInputsChanged(state);
										boardInvalidatedInPass = true;
										anyActionTaken = true;
									} else {
										noteLayerInputsChanged(state);
										boardInvalidatedInPass = true;
										queueToGraveyard(perm, p, 'aura');
									}
									// --- End Track P12 + P11 ---
								}
							}
						}
					} else if (isEquipment && perm.attachedToId) {
						const targetFound = findPermanentOnBoard(state, perm.attachedToId);
						// --- Track P12: Equip planeswalker SBA support (e.g. Luxior) ---
						const allowPw = activeAbilityDefs(
							effectiveCardForObject(perm),
							instanceFaceOptions(perm, 'battlefield')
						).some((a) => a.kind === 'keyword' && Boolean(a.keyword.equipAllowPlaneswalker));
						const targetEval = targetFound ? getSbaEval(targetFound.inst) : null;
						const validHostType = targetEval
							? targetEval.typeLine.includes('Creature') || (allowPw && targetEval.isPlaneswalker)
							: false;
						// --- End Track P12 ---
						if (
							evalPerm.isCreature ||
							perm.instanceId === perm.attachedToId ||
							!targetFound ||
							!validHostType ||
							// --- Track P14: CR 702.16n, 702.16p attachment exemption check ---
							H().hasProtectionFrom(targetFound.inst, perm.copiableCard ?? perm.card, state, perm, true)
							// --- End Track P14 ---
						) {
							// --- Track P16b ---
							const prevHostId = perm.attachedToId;
							// --- End Track P16b ---
							perm.attachedToId = null;
							noteLayerInputsChanged(state);
							boardInvalidatedInPass = true;
							anyActionTaken = true;
							// --- Track P16b ---
							emitEvent(state, {
								kind: 'Unattached',
								attachmentId: perm.instanceId,
								attachment: perm,
								hostId: prevHostId,
								...(targetFound ? { host: targetFound.inst } : {})
							});
							// --- End Track P16b ---
						}
					// --- Track P18a: CR 301.6 / CR 704.5n Unattach Fortification from non-Land or when creature ---
					} else if (isFortification && perm.attachedToId) {
						const targetFound = findPermanentOnBoard(state, perm.attachedToId);
						const targetEval = targetFound ? getSbaEval(targetFound.inst) : null;
						const hasProt = targetFound
							? H().hasProtectionFrom(
									targetFound.inst,
									perm.copiableCard ?? perm.card,
									state,
									perm,
									true
								)
							: false;
						if (
							isFortificationIllegalAttachment(
								evalPerm,
								perm.instanceId,
								perm.attachedToId,
								targetFound,
								targetEval,
								hasProt
							)
						) {
							perm.attachedToId = null;
							noteLayerInputsChanged(state);
							boardInvalidatedInPass = true;
							anyActionTaken = true;
						}
					// --- End Track P18a ---
					} else if (perm.attachedToId) {
						const targetFound = findPermanentOnBoard(state, perm.attachedToId);
						if (!targetFound) {
							// --- Track P16b ---
							const prevHostId = perm.attachedToId;
							// --- End Track P16b ---
							perm.attachedToId = null;
							noteLayerInputsChanged(state);
							boardInvalidatedInPass = true;
							anyActionTaken = true;
							// --- Track P16b ---
							emitEvent(state, {
								kind: 'Unattached',
								attachmentId: perm.instanceId,
								attachment: perm,
								hostId: prevHostId
							});
							// --- End Track P16b ---
						}
					}
				}

				// 3. Creature lethal damage / 0 toughness / Deathtouch SBA (CR 704.5f-h) & Planeswalker 0 loyalty (CR 704.5i)
				for (const perm of p.battlefield) {
					if (perm.phasedOut || queuedIds.has(perm.instanceId)) continue;
					const evalPerm = getSbaEval(perm);
					let dies = false;
					if (evalPerm.typeLine.includes('Creature')) {
						const tough = evalPerm.toughness;
						if (tough <= 0) {
							dies = true;
						} else if (perm.damageMarked >= tough || perm.deathtouchDamageMarked) {
							if (evalPerm.keywords.some((k) => k.toLowerCase() === 'indestructible')) {
								// CR 704.5h: Clear deathtouch damage flag once SBAs have been checked and creature survived
								if (perm.deathtouchDamageMarked) perm.deathtouchDamageMarked = false;
							} else if (H().tryRegenerateInsteadOfDestroy(state, perm, true)) {
								// CR 701.19a / 704.5g-h: Regenerated instead of lethal/deathtouch destruction
								boardInvalidatedInPass = true;
							// --- Track P12: CR 702.89a Umbra armor SBA replacement ---
							} else if (tryUmbraArmorInsteadOfDestroy(state, perm)) {
								boardInvalidatedInPass = true;
								anyActionTaken = true;
							// --- End Track P12 ---
							} else {
								dies = true;
							}
						}
					}
					if (!dies && evalPerm.typeLine.includes('Planeswalker') && perm.counters.loyalty <= 0) {
						dies = true;
					}
					if (dies) {
						queueToGraveyard(perm, p, 'dying');
					}
				}

				// 4. Legend Rule (CR 704.5j): Duplicate legendary permanents with the same name (skipping face-down per CR 201.2a / 708.2a)
				const legendaryByName = new Map<string, CardInstance[]>();
				for (const perm of p.battlefield) {
					if (perm.phasedOut || perm.isFaceDown || queuedIds.has(perm.instanceId)) continue;
					// --- Track P17a: CR 704.5j legend rule exemption (e.g. Mirror Box, Mirror Gallery) ---
					if (isPermanentExemptFromLegendRule(state, perm)) continue;
					// --- End Track P17a ---
					const evalPerm = getSbaEval(perm);
					const name = evalPerm.effectiveName || perm.card.name;
					if (evalPerm.typeLine.includes('Legendary') && name) {
						const list = legendaryByName.get(name) || [];
						list.push(perm);
						legendaryByName.set(name, list);
					}
				}
				for (const [legName, list] of legendaryByName.entries()) {
					if (list.length > 1) {
						if (p.isBot) {
							// Bots keep the best copy and put other copies into graveyard (CR 704.5j)
							let best = list[list.length - 1];
							let bestScore = -Infinity;
							for (let idx = 0; idx < list.length; idx++) {
								const cand = list[idx];
								const ev = getSbaEval(cand);
								const score =
									(!cand.isToken ? 100 : 0) +
									(ev.power + ev.toughness) * 10 +
									(cand.counters['+1/+1'] ?? 0) * 15 -
									(cand.counters['-1/-1'] ?? 0) * 15 +
									(cand.counters.loyalty ?? 0) * 10 +
									getAttachedCardsOnBoard(state, cand.instanceId).length * 20 +
									(!cand.tapped ? 2 : 0) +
									(!cand.summoningSick ? 2 : 0) +
									idx;
								if (score >= bestScore) {
									bestScore = score;
									best = cand;
								}
							}
							for (const cand of list) {
								if (cand.instanceId !== best.instanceId) {
									queueToGraveyard(cand, p, 'legend', legName);
								}
							}
						} else {
							const cands = list.map((c) => c.instanceId);
							const alreadyPrompted = state.pendingPrompts.some((pr) => {
								if (pr.playerId !== p.playerId) return false;
								if ((pr.purpose ?? pr.kind) !== 'legend_rule') return false;
								const prCands =
									pr.candidateInstanceIds ??
									(pr.choice?.kind === 'chooseObjects' ? pr.choice.candidates : []);
								return cands.some((id) => prCands.includes(id));
							});
							if (!alreadyPrompted) {
								enqueueChoicePrompt(state, {
									id: uid('prm', state),
									playerId: p.playerId,
									kind: 'legend_rule',
									purpose: 'legend_rule',
									title: `Legend Rule — ${legName}`,
									description: `Choose one ${legName} to keep on the battlefield. The other(s) will be put into your graveyard (CR 704.5j).`,
									candidateInstanceIds: cands,
									countRequired: 1,
									continuation: {
										kind: 'procedure',
										procedure: {
											kind: 'legend_rule',
											actorId: p.playerId,
											keepInstanceId: '',
											remainingInstanceIds: cands,
											nextIndex: 0
										}
									}
								});
							}
						}
					}
				}

				// 5. Saga final-chapter SBA (CR 715.4, CR 704.5s):
				// Sacrifice any Saga with finalChapterNumber > 0 and lore >= finalChapterNumber that isn't
				// the source of a chapter ability currently on the stack or waiting to be placed there.
				const pendingNow = peekPendingTriggers(state);
				for (const perm of p.battlefield) {
					if (perm.phasedOut || perm.isFaceDown || queuedIds.has(perm.instanceId)) continue;
					// --- Track P11: Skip Saga SBA lookup for non-Saga permanents ---
					const evalPerm = getSbaEval(perm);
					if (!evalPerm.hasSubType('Saga') && !evalPerm.typeLine.includes('Saga')) continue;
					// --- End Track P11 ---
					const finalCh = getSagaFinalChapterNumber(state, perm);
					if (finalCh <= 0) continue;
					if ((perm.counters.lore || 0) < finalCh) continue;
					const hasChapterOnStack = state.stack.some(
						(s) => Boolean(s.isChapterAbility) && s.sourceInstanceId === perm.instanceId
					);
					if (hasChapterOnStack) continue;
					const hasChapterPending = pendingNow.some(
						(t) =>
							(Boolean(t.isChapterAbility) || Boolean(t.ability.trigger.isChapterAbility)) &&
							t.source.instanceId === perm.instanceId
					);
					if (hasChapterPending) continue;
					queueToGraveyard(perm, p, 'saga');
				}
			}
		});

		// Execute all simultaneous battlefield-to-graveyard SBAs for this pass (CR 603.10a, CR 704.8),
		// preserving per-player SBA processing order while keeping all batch permanents on the battlefield
		// in their pre-batch state during each movePermanentToZone call so LKI and dies triggers see the
		// full pre-batch board across all players.
		if (sbaGraveyardBatch.length > 0) {
			anyActionTaken = true;
			for (const { perm } of sbaGraveyardBatch) {
				const pre = prePassSnapshot.get(perm.instanceId);
				if (pre) {
					perm.lastKnownCounters = { ...pre.counters };
					perm.lastKnownPower = pre.evalPerm.power;
					perm.lastKnownToughness = pre.evalPerm.toughness;
					perm.counters = { ...pre.counters };
				}
			}
		}

		// Why the batch/replay loop resets battlefields between items:
		// All SBAs in a single pass happen simultaneously (CR 704.3, 603.10a, 704.8), but movePermanentToZone
		// moves one permanent at a time (evaluating replacement effects, capturing LKI, and matching triggers).
		// Rewinding battlefields and previously moved batch items before each movePermanentToZone call ensures
		// every dying permanent in the batch sees the full pre-batch board, then restores all post-move results.
		const preBattlefields =
			sbaGraveyardBatch.length > 1
				? new Map<PlayerGameState, CardInstance[]>(
						state.players.map((pl) => [pl, [...pl.battlefield]])
					)
				: null;
		const preItemStates =
			sbaGraveyardBatch.length > 1
				? new Map<string, CardInstance>(
						sbaGraveyardBatch.map(({ perm }) => [
							perm.instanceId,
							{
								...perm,
								counters: { ...perm.counters },
								grantedKeywords: [...perm.grantedKeywords]
							}
						])
					)
				: null;
		const postResults = new Map<
			string,
			{
				perm: CardInstance;
				postState: CardInstance;
				destZone: 'graveyard' | 'exile' | 'command' | 'library' | 'hand' | 'battlefield' | 'pending';
				insertIndex: number;
				owner: PlayerGameState | undefined;
			}
		>();
		const pendingLinkedReturns: Array<{ leavingId: string; leavingVersion: number }> = [];

		for (const p of state.players) {
			if (p.lost) continue;

			const playerBatch = sbaGraveyardBatch.filter((item) => item.controller.playerId === p.playerId);
			for (const item of playerBatch) {
				if (sbaGraveyardBatch.length > 1 && preBattlefields && preItemStates) {
					for (const [pl, bf] of preBattlefields.entries()) {
						setZoneOrder(pl, 'battlefield', [...bf]);
					}
					for (const prev of postResults.values()) {
						if (prev.owner && prev.destZone !== 'pending') {
							setZoneOrder(
								prev.owner,
								prev.destZone,
								prev.owner[prev.destZone].filter((c) => c.instanceId !== prev.perm.instanceId)
							);
						}
						const preState = preItemStates.get(prev.perm.instanceId);
						if (preState) {
							Object.assign(prev.perm, preState, {
								counters: { ...preState.counters },
								grantedKeywords: [...preState.grantedKeywords]
							});
						}
					}
				}

				if (item.kind === 'dying') {
					emitVfx(state, {
						kind: 'destroy',
						targetId: item.perm.instanceId,
						label: item.perm.card.name
					});
				}
				const leavingVersion = item.perm.objectVersion || 1;
				const actualDest = movePermanentToZone(
					state,
					item.perm,
					'graveyard',
					{
						kind: item.kind,
						controllerId: item.controller.playerId,
						controllerUsername: item.controller.username,
						...(item.kind === 'legend' ? { legName: item.legName } : {})
					},
					sbaGraveyardBatch.length > 1 ? { skipLinkedReturn: true } : undefined
				);
				if (sbaGraveyardBatch.length > 1 && actualDest !== 'battlefield' && actualDest !== 'pending') {
					pendingLinkedReturns.push({ leavingId: item.perm.instanceId, leavingVersion });
				}

				if (sbaGraveyardBatch.length > 1) {
					const owner = state.players.find((pl) => pl.playerId === item.perm.ownerId);
					const destZone: 'graveyard' | 'exile' | 'command' | 'library' | 'hand' | 'battlefield' | 'pending' =
						actualDest === 'pending' || actualDest === 'stack' ? 'pending' : actualDest;
					const insertIndex =
						owner && destZone !== 'pending'
							? owner[destZone].findIndex((c) => c.instanceId === item.perm.instanceId)
							: -1;
					postResults.set(item.perm.instanceId, {
						perm: item.perm,
						postState: {
							...item.perm,
							counters: { ...item.perm.counters },
							grantedKeywords: [...item.perm.grantedKeywords]
						},
						destZone,
						insertIndex,
						owner
					});
				}
			}

			if (sbaGraveyardBatch.length > 1 && playerBatch.length > 0) {
				// Restore already-processed batch items to their post-move zones before running Step 5 & 6 for player p
				for (const pl of state.players) {
					setZoneOrder(
						pl,
						'battlefield',
						pl.battlefield.filter((c) => !postResults.has(c.instanceId))
					);
				}
				for (const res of postResults.values()) {
					Object.assign(res.perm, res.postState, {
						counters: { ...res.postState.counters },
						grantedKeywords: [...res.postState.grantedKeywords]
					});
					if (res.owner && res.destZone !== 'pending' && !res.perm.isToken) {
						const curZone = res.owner[res.destZone];
						if (!curZone.some((c) => c.instanceId === res.perm.instanceId)) {
							const nextZone = [...curZone];
							const at =
								res.insertIndex >= 0 && res.insertIndex <= nextZone.length
									? res.insertIndex
									: nextZone.length;
							nextZone.splice(at, 0, res.perm);
							setZoneOrder(res.owner, res.destZone, nextZone);
						}
					}
				}
			}

			// 5. Token cleanup outside the battlefield (CR 704.5d)
			const prevGraveLen = p.graveyard.length;
			const prevExileLen = p.exile.length;
			const prevHandLen = p.hand.length;
			const prevLibLen = p.library.length;
			removeFromGame(p, 'graveyard', (c) => c.isToken);
			removeFromGame(p, 'exile', (c) => c.isToken);
			removeFromGame(p, 'hand', (c) => c.isToken);
			removeFromGame(p, 'library', (c) => c.isToken);
			if (
				p.graveyard.length !== prevGraveLen ||
				p.exile.length !== prevExileLen ||
				p.hand.length !== prevHandLen ||
				p.library.length !== prevLibLen
			) {
				anyActionTaken = true;
			}

			// 6. Commander Zone Change SBA (CR 704.6d / 903.9a)
			const commandersInGraveOrExile = [
				...p.graveyard.filter((c) => c.isCommander),
				...p.exile.filter((c) => c.isCommander)
			];
			for (const cmd of commandersInGraveOrExile) {
				const curVersion = cmd.objectVersion ?? 1;
				if (
					cmd.commanderSbaDeclinedVersion !== undefined &&
					cmd.commanderSbaDeclinedVersion === curVersion
				) {
					continue;
				}
				if (p.isBot) {
					cmd.damageMarked = 0;
					cmd.deathtouchDamageMarked = false;
					cmd.tapped = false;
					moveObject(state, cmd, 'command', {
						from: { player: p, zone: p.graveyard.includes(cmd) ? 'graveyard' : 'exile' },
						toPlayer: p
					});
					const postEntry = postResults.get(cmd.instanceId);
					if (postEntry) {
						postEntry.destZone = 'command';
						postEntry.postState = {
							...cmd,
							counters: { ...cmd.counters },
							grantedKeywords: [...cmd.grantedKeywords]
						};
					}
					addLog(
						state,
						'sba',
						`${p.username} returned Commander ${cmd.card.name} to the Command Zone.`,
						p.playerId
					);
					anyActionTaken = true;
				} else if (
					!state.pendingPrompts.some(
						(pr) =>
							pr.kind === 'commander_zone_choice' && pr.commanderInstanceId === cmd.instanceId
					)
				) {
					const description = `${cmd.card.name} was put into your ${cmd.zone}. Under Commander Rule 903.9a, you may move it to the Command Zone.`;
					enqueueChoicePrompt(state, {
						id: uid('prm', state),
						playerId: p.playerId,
						kind: 'commander_zone_choice',
						purpose: 'commander_zone_choice',
						title: `Return ${cmd.card.name} to Command Zone?`,
						description,
						commanderInstanceId: cmd.instanceId,
						destinationZone: cmd.zone,
						yesLabel: 'Yes — Move to Command Zone',
						noLabel: `No — Leave in ${cmd.zone}`,
						continuation: {
							kind: 'procedure',
							procedure: {
								kind: 'commander_zone_choice',
								commanderInstanceId: cmd.instanceId,
								destinationZone: cmd.zone
							}
						},
						choice: {
							kind: 'yesNo',
							question: description
						}
					});
				}
			}
		}

		if (sbaGraveyardBatch.length > 1) {
			for (const pl of state.players) {
				for (const b of pl.battlefield) {
					if (b.attachedToId && queuedIds.has(b.attachedToId)) {
						b.attachedToId = null;
					}
				}
			}
			returnLinkedExiledForSources(state, pendingLinkedReturns);
		}
		if (syncBattlefieldControllers(state)) {
			anyActionTaken = true;
		}
		// --- Track P13 (CR 704.5t & CR 309.7): Role token uniqueness & Dungeon completion SBAs ---
		if (applyRoleTokenSba(state)) {
			anyActionTaken = true;
			boardInvalidatedInPass = true;
		}
		if (applyDungeonCompletionSba(state)) {
			anyActionTaken = true;
			boardInvalidatedInPass = true;
		}
		// --- End Track P13 ---
		// --- Track P15: Battle SBAs (CR 704.5p,v–y) & Speed/Ascend/Day-Night SBAs ---
		if (checkBattleStateBasedActions(state)) {
			anyActionTaken = true;
			boardInvalidatedInPass = true;
		}
		if (checkSpeedAscendAndDayNightSbas(state)) {
			anyActionTaken = true;
			boardInvalidatedInPass = true;
		}
		// --- End Track P15 ---
		// --- Track P18a: Soulbond unpair (CR 702.95e) & Storied enduring story check (CR 702.195b–c) ---
		if (enforceSoulbondPairs(state)) {
			anyActionTaken = true;
			boardInvalidatedInPass = true;
		}
		if (checkStoriedDesignations(state)) {
			anyActionTaken = true;
			boardInvalidatedInPass = true;
		}
		// --- End Track P18a ---

		// 7. Simultaneous Player Loss SBAs (CR 104.3c, 104.4a, 704.5a-c, 903.10a) — respects Platinum Angel!
		const newlyEliminated: Array<{
			player: PlayerGameState;
			reason: string;
			logText: string;
		}> = [];
		// Read-only: one layer-cache validation for every player's "can't lose" check (Phase 6d).
		const cannotLose = withStableLayerInputs(
			state,
			() => new Set(state.players.filter((p) => !p.lost && playerCannotLoseGame(state, p).protected))
		);
		for (const p of state.players) {
			if (p.lost) continue;
			if (cannotLose.has(p)) {
				if (p.attemptedEmptyLibraryDraw) {
					// CR 704.5b only checks if the player attempted to draw from an empty library since the last SBA check
					p.attemptedEmptyLibraryDraw = false;
				}
				continue;
			}
			// --- Track P20a ---
			if (p.life <= 0 && !playerDontLoseAtZeroOrLessLife(state, p.playerId)) {
			// --- End Track P20a ---
				newlyEliminated.push({
					player: p,
					reason: `Life total reached ${p.life}.`,
					logText: `${p.username} has ${p.life} life and loses the game!`
				});
			} else if (state.rules.poisonLethal > 0 && p.poison >= state.rules.poisonLethal) {
				newlyEliminated.push({
					player: p,
					reason: `Accumulated ${p.poison} Poison counters.`,
					logText: `${p.username} has ${p.poison} poison counters and loses the game!`
				});
			} else if (p.attemptedEmptyLibraryDraw) {
				newlyEliminated.push({
					player: p,
					reason: 'Attempted to draw a card from an empty library (Decked Out).',
					logText: `${p.username} lost the game: Attempted to draw a card from an empty library (Decked Out).`
				});
			} else if (state.rules.commanderDamageLethal > 0) {
				for (const [cmdId, dmg] of Object.entries(p.commanderDamageTaken)) {
					if (dmg >= state.rules.commanderDamageLethal) {
						const cmdName = p.commanderNames[cmdId] || 'a Commander';
						newlyEliminated.push({
							player: p,
							reason: `Dealt ${dmg} combat damage by ${cmdName}.`,
							logText: `${p.username} took ${dmg} Commander combat damage from ${cmdName} and loses the game!`
						});
						break;
					}
				}
			}
		}

		if (newlyEliminated.length > 0) {
			anyActionTaken = true;
			for (const { player: p, reason, logText } of newlyEliminated) {
				p.lost = true;
				p.lossReason = reason;
				p.attemptedEmptyLibraryDraw = false;
				addLog(state, 'sba', logText, p.playerId);
				// --- Track P19b ---
				emitEvent(state, { kind: 'PlayerLostGame', playerId: p.playerId });
				// --- End Track P19b ---
			}
			for (const { player: p } of newlyEliminated) {
				cleanupEliminatedPlayer(state, p);
			}
			// CR 104.2a / 104.4a: If 0 or 1 players remain after simultaneous losses, the game ends immediately
			const remainingNow = state.players.filter((p) => !p.lost);
			if (remainingNow.length <= 1 && state.players.length > 1) {
				break;
			}
		}
	}

	// CR 704.3: Flush all triggers generated during the SBA loop once after the loop stabilizes
	flushTriggers(state);
	// --- Track P16b: CR 603.8 state triggers ---
	if ((state.status as string) !== 'finished' && checkStateTriggers(state) > 0) {
		flushTriggers(state);
	}
	// --- End Track P16b ---

	// Check Win / Draw Condition (CR 104.2a / 104.4a)
	const remaining = state.players.filter((p) => !p.lost);
	if (remaining.length === 0 && state.players.length > 0) {
		state.status = 'finished';
		state.winnerPlayerId = null;
		state.winnerId = undefined;
		addLog(
			state,
			'system',
			'All remaining players lost simultaneously — the game is a draw (CR 104.4a)!'
		);
		revealFaceDownObjects(state);
	} else if (remaining.length === 1 && state.players.length > 1) {
		// CR 104.2a: A player still in the game wins if all opponents have left the game.
		// This happens immediately and overrides all effects that would preclude that player from winning.
		const winner = remaining[0];
		if (winner) {
			state.status = 'finished';
			state.winnerPlayerId = winner.playerId;
			state.winnerId = winner.playerId;
			addLog(
				state,
				'system',
				`${winner.username} wins the Commander match!`,
				winner.playerId
			);
			revealFaceDownObjects(state);
			emitVfx(state, {
				kind: 'victory',
				sourceId: winner.playerId,
				label: `${winner.username} Wins!`
			});
		}
	}
	// --- Track P21: Assign Space Beleren sectors to any unassigned creatures ---
	if (state.status === 'active') {
		ensureSpaceSculptorSectors(state);
	}
	// --- End Track P21 ---
}

export function cleanupEliminatedPlayer(state: GameState, eliminated: PlayerGameState): void {
	const elimId = eliminated.playerId;

	// CR 708.9: Reveal all face-down permanents and spells owned by the leaving player.
	revealFaceDownObjects(state, elimId);

	// 1. Remove pending prompts and delayed triggers for eliminated player (CR 800.4d)
	state.pendingPrompts = state.pendingPrompts.filter((pr) => pr.playerId !== elimId);
	if (state.delayedTriggers) {
		state.delayedTriggers = state.delayedTriggers.filter((dt) => dt.controllerId !== elimId);
	}

	// 2. Clean up the Stack for the eliminated player (CR 800.4a)
	// - Objects owned by the eliminated player leave the game.
	// - Objects on the stack not represented by cards controlled by the eliminated player cease to exist.
	// - Card-backed spells still controlled by the eliminated player are exiled.
	const remainingStack: StackItem[] = [];
	for (const item of state.stack) {
		const itemOwnerId = item.ownerId || item.controllerId;
		if (itemOwnerId === elimId) {
			continue;
		}
		if (item.controllerId === elimId) {
			if (item.kind === 'spell' && !item.isCopy) {
				const owner = state.players.find((pl) => pl.playerId === itemOwnerId && !pl.lost);
				if (owner) {
					H().moveStackSpellToZone(state, item, 'exile');
				}
			}
			continue;
		}
		remainingStack.push(item);
	}
	state.stack = remainingStack;

	// 3. Remove eliminated player's attackers/blockers from combat
	const elimPermIds = new Set(eliminated.battlefield.map((c) => c.instanceId));
	state.combat.attackers = state.combat.attackers.filter(
		(a) => a.controllerId !== elimId && a.defenderPlayerId !== elimId
	);
	for (const atk of state.combat.attackers) {
		atk.blockerInstanceIds = atk.blockerInstanceIds.filter((bId) => !elimPermIds.has(bId));
	}
	if (state.combat.declaredBlockersPlayerIds) {
		state.combat.declaredBlockersPlayerIds = state.combat.declaredBlockersPlayerIds.filter(
			(id) => id !== elimId
		);
	}
	if (state.combat.attackers.length === 0 && state.combat.active) {
		state.combat.active = false;
	}
	noteLayerInputsChanged(state);

	// 4. Handle permanents on the eliminated player's battlefield (CR 800.4a, 800.4c):
	// - First, any control-changing TimedContinuousEffects giving the eliminated player control end.
	// - Then, any foreign-owned permanents with an alive default controller return to that player
	//   (preserving defaultControllerId so syncBattlefieldControllers can re-apply any other Layer 2
	//   effects such as another alive player's Control Magic), and any remaining foreign permanents
	//   are exiled.
	// - Finally, all objects owned by the eliminated player leave the game, and controllers sync.
	if (state.timedContinuousEffects?.length) {
		const remaining = state.timedContinuousEffects.filter(
			(eff) => eff.layer2?.controllerId !== elimId
		);
		state.timedContinuousEffects = remaining.length > 0 ? remaining : undefined;
		noteLayerInputsChanged(state);
	}
	const leftBattlefieldIds = new Set<string>();
	for (const perm of [...eliminated.battlefield]) {
		if (perm.ownerId !== elimId) {
			const defaultCtrlId = perm.defaultControllerId ?? perm.ownerId;
			const defaultCtrl =
				defaultCtrlId !== elimId
					? state.players.find((pl) => pl.playerId === defaultCtrlId && !pl.lost)
					: undefined;
			if (defaultCtrl) {
				perm.controllerId = defaultCtrl.playerId;
				transferBattlefieldControl(perm, eliminated, defaultCtrl, state, {
					preserveDefaultController: true
				});
			} else {
				leftBattlefieldIds.add(perm.instanceId);
				const owner = state.players.find((pl) => pl.playerId === perm.ownerId && !pl.lost);
				if (owner) {
					movePermanentToZone(state, perm, 'exile');
				}
			}
		} else {
			leftBattlefieldIds.add(perm.instanceId);
		}
	}
	removeFromGame(eliminated, 'battlefield');

	// Also remove any cards in eliminated player's graveyard, command, exile, hand, and library,
	// and any cards in other players' zones owned by the eliminated player (CR 800.4a)
	if (!(state.lobbyCode === 'GOLDEN' && state.players.length === 2)) {
		removeFromGame(eliminated, 'graveyard');
		removeFromGame(eliminated, 'command');
	}
	removeFromGame(eliminated, 'exile');
	removeFromGame(eliminated, 'hand');
	removeFromGame(eliminated, 'library');
	for (const other of state.players) {
		if (other.playerId === elimId) continue;
		for (const c of other.battlefield) {
			if (c.ownerId === elimId) leftBattlefieldIds.add(c.instanceId);
		}
		removeFromGame(other, 'battlefield', (c) => c.ownerId === elimId);
		removeFromGame(other, 'graveyard', (c) => c.ownerId === elimId);
		removeFromGame(other, 'command', (c) => c.ownerId === elimId);
		removeFromGame(other, 'exile', (c) => c.ownerId === elimId);
		removeFromGame(other, 'hand', (c) => c.ownerId === elimId);
		removeFromGame(other, 'library', (c) => c.ownerId === elimId);
		for (const exCard of other.exile) {
			if (exCard.playableFromExileBy?.playerId === elimId) {
				exCard.playableFromExileBy = undefined;
			}
			// --- Track P13 ---
			if (exCard.airbentCastPermission?.playerId === elimId) {
				delete exCard.airbentCastPermission;
			}
			// --- End Track P13 ---
		}
		// --- Track P13 ---
		for (const gyCard of other.graveyard) {
			if (gyCard.playableFromGraveyardBy?.playerId === elimId) {
				delete gyCard.playableFromGraveyardBy;
			}
		}
		// --- End Track P13 ---
	}
	for (const other of state.players) {
		if (other.playerId === elimId) continue;
		for (const b of other.battlefield) {
			if (b.attachedToId && leftBattlefieldIds.has(b.attachedToId)) {
				b.attachedToId = null;
			}
		}
	}
	syncBattlefieldControllers(state);

	state.passedPriorityPlayerIds = state.passedPriorityPlayerIds.filter((id) => id !== elimId);

	// CR 726.4 / CR 800.4k: If the monarch leaves the game, the active player becomes the monarch
	// at the same time as that player leaves the game. If the active player is leaving the game (or
	// has already lost), the next living player in turn order becomes the monarch.
	const alive = state.players.filter((p) => !p.lost);
	if (state.monarchPlayerId === elimId) {
		const active = state.players[state.activePlayerIndex];
		let successor: PlayerGameState | undefined;
		if (active && !active.lost && active.playerId !== elimId) {
			successor = active;
		} else {
			const nPlayers = state.players.length;
			for (let step = 1; step <= nPlayers; step++) {
				const cand = state.players[(state.activePlayerIndex + step) % nPlayers];
				if (cand && !cand.lost && cand.playerId !== elimId) {
					successor = cand;
					break;
				}
			}
		}
		if (successor) {
			if (alive.length > 1 && state.status === 'active') {
				H().setMonarch(state, successor.playerId);
				state.passedPriorityPlayerIds = [];
			} else {
				state.monarchPlayerId = successor.playerId;
				releaseExiledUntilOpponentMonarch(state, successor.playerId);
				noteLayerInputsChanged(state);
			}
		} else {
			state.monarchPlayerId = null;
			noteLayerInputsChanged(state);
		}
	}
	// --- Track P13 (CR 725.4 / CR 800.4k): Initiative succession when holder leaves the game ---
	if (state.initiativePlayerId === elimId) {
		if (alive.length > 1 && state.status === 'active') {
			handleInitiativePlayerEliminated(state, elimId);
			state.passedPriorityPlayerIds = [];
		} else {
			const nextAlive = alive.find((p) => p.playerId !== elimId);
			state.initiativePlayerId = nextAlive?.playerId ?? null;
			noteLayerInputsChanged(state);
		}
	}
	// --- End Track P13 ---

	// 5. CR 800.4a / 800.4j: If the game continues (2+ alive players remain) and the eliminated
	// player held priority, pass priority to the next alive player in turn order (or resolve top
	// of stack / end phase if all remaining players had already passed priority). The turn
	// continues to completion without an active player if the active player left the game.
	if (alive.length > 1 && state.status === 'active') {
		const priorityPlayer = state.players[state.priorityPlayerIndex];
		if (priorityPlayer?.playerId === elimId) {
			const allAlivePassed =
				state.passedPriorityPlayerIds.length > 0 &&
				alive.every((p) => state.passedPriorityPlayerIds.includes(p.playerId));
			if (allAlivePassed) {
				state.passedPriorityPlayerIds = [];
				if (state.stack.length > 0) {
					H().resolveTopOfStack(state);
				} else {
					H().advancePhaseOrStep(state);
				}
			} else {
				advancePriorityToNextPlayer(state);
			}
		}
	}
}

export function applyDamageToTarget(
	state: GameState,
	sourcePlayerId: string,
	target: TargetRef,
	amount: number
): void {
	// --- Track P7 ---
	if (amount <= 0) return;
	const unpreventable = isDamageUnpreventable(state, false);
	// --- End Track P7 ---
	const pTarget = state.players.find((p) => p.playerId === target.id);
	if (pTarget) {
		// --- Track P7 ---
		if (!unpreventable && pTarget.protectionFromEverythingThisTurn) {
			return;
		}
		amount = applyDamagePreventionShields(state, {
			amount,
			isCombat: false,
			targetKind: 'player',
			targetId: pTarget.playerId,
			sourceId: sourcePlayerId
		});
		if (amount <= 0) return;
		if (!pTarget.lifeTotalCannotChangeThisTurn) {
			pTarget.life -= amount;
			// --- Track P12 ---
			recordPlayerLifeLossWave4(pTarget, amount);
			// --- End Track P12 ---
			// --- Track P15: CR 702.178a Speed trigger check on opponent life loss ---
			if (amount > 0) {
				onPlayerLostLifeCheckSpeedTrigger(state, pTarget.playerId, amount);
			}
			// --- End Track P15 ---
		}
		if (!pTarget.protectionFromEverythingThisTurn) {
			// --- Track P9 ---
			if (amount > 0) {
				pTarget.damageDealtToThisTurn = (pTarget.damageDealtToThisTurn ?? 0) + amount;
			}
			// --- End Track P9 ---
			emitEvent(state, {
				kind: 'DamageDealt',
				sourceId: sourcePlayerId,
				targetId: pTarget.playerId,
				targetKind: 'player',
				amount,
				combat: false
			});
		}
		emitVfx(state, {
			kind: 'damage',
			sourceId: sourcePlayerId,
			targetId: pTarget.playerId,
			amount
		});
		return;
	}
	const permFound = findPermanentOnBoard(state, target.id);
	if (permFound) {
		// --- Track P7 ---
		const evalPerm = evaluatePermanent(state, permFound.inst);
		amount = applyDamagePreventionShields(state, {
			amount,
			isCombat: false,
			targetKind: 'permanent',
			targetId: permFound.inst.instanceId,
			targetPerm: permFound.inst,
			targetControllerId: permFound.owner.playerId,
			sourceId: sourcePlayerId
		});
		if (amount <= 0) return;
		// --- End Track P7 ---
		if (evalPerm.typeLine.includes('Planeswalker')) {
			permFound.inst.counters.loyalty = Math.max(0, permFound.inst.counters.loyalty - amount);
		} else if (isPermanentBattle(state, permFound.inst)) {
			// --- Track P15: CR 120.3h Damage dealt to a Battle removes defense counters ---
			const prevDef = permFound.inst.counters.defense || 0;
			const nextDef = Math.max(0, prevDef - amount);
			const removed = prevDef - nextDef;
			permFound.inst.counters.defense = nextDef;
			if (removed > 0) {
				emitEvent(state, {
					kind: 'CounterRemoved',
					objectId: permFound.inst.instanceId,
					object: permFound.inst,
					counterType: 'defense',
					amount: removed,
					previousCount: prevDef,
					newCount: nextDef
				});
			}
			onBattleDefenseCountersRemoved(state, permFound.inst, prevDef, nextDef);
			// --- End Track P15 ---
		} else {
			permFound.inst.damageMarked += amount;
		}
		emitEvent(state, {
			kind: 'DamageDealt',
			sourceId: sourcePlayerId,
			targetId: permFound.inst.instanceId,
			targetKind: 'permanent',
			amount,
			combat: false
		});
		emitVfx(state, {
			kind: 'damage',
			sourceId: sourcePlayerId,
			targetId: permFound.inst.instanceId,
			amount
		});
	}
}
