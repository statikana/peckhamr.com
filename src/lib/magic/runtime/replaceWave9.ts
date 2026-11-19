/**
 * Wave 12 (Wave 9S) — Token Replacements, Draw Replacements, Proliferate Multipliers,
 * Damage Prevention Riders, Dies-Exile Reflexive Triggers, Zone-ETB Blocks & Clone Extras.
 *
 * Upholds ENGINE_INVARIANTS.md:
 * - Zero rules-text reads
 * - Zero card-name comparisons or precon card names
 * - Zero raw typeLine reads outside exempt files (uses resolveObjectFaces / activeCharacteristics)
 * - Zero IR stored in GameState
 * - Bounded loops only
 */
import type { CopyModificationSpec, ObjectFilter, StaticDef, TokenSpec } from '../ir.ts';
import { buildTokenScryfallCard, withStackItemText } from '../oracle.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import {
	createEmptyCounterMap,
	type CardInstance,
	type CounterType,
	type GameState,
	type PlayerGameState,
	type StackItem,
	type TargetRef,
	type ZoneType
} from '../types.ts';
import {
	activeAbilityDefs,
	activeCharacteristics,
	instanceFaceOptions,
	resolveObjectFaces
} from './faces.ts';
import { noteLayerInputsChanged, withStableLayerInputs } from './layerCache.ts';
import { permanentHasLostAllAbilities } from './layers.ts';
import { evaluateAmount, evaluateCondition, matchesObjectFilter } from './objectFilter.ts';
import { uid } from './random.ts';
import { forEachActiveStaticOnBattlefield } from './staticsDynamicAndCosts.ts';
import { allocateTimestamp } from './zones.ts';

function predefinedTokenToSpec(kind: 'clue' | 'food' | 'treasure'): TokenSpec {
	if (kind === 'clue') {
		return {
			name: 'Clue',
			typeLine: 'Token Artifact — Clue',
			power: 0,
			toughness: 0,
			colors: [],
			keywords: []
		};
	}
	if (kind === 'food') {
		return {
			name: 'Food',
			typeLine: 'Token Artifact — Food',
			power: 0,
			toughness: 0,
			colors: [],
			keywords: []
		};
	}
	return {
		name: 'Treasure',
		typeLine: 'Token Artifact — Treasure',
		power: 0,
		toughness: 0,
		colors: [],
		keywords: []
	};
}

/**
 * Applies Wave 9S `tokenReplacement` statics (*Divine Visitation*, *Fisher's Talent*, *Academy Manufactor*).
 * Enforces CR 614.5/616.1 fixed-point application where each replacement applies at most once per event.
 */
export function applyTokenReplacementsWave9(
	state: GameState,
	recipient: PlayerGameState,
	spec: TokenSpec,
	count: number
): Array<{ spec: TokenSpec; count: number }> {
	if (count <= 0) return [];
	let entries: Array<{ spec: TokenSpec; count: number; appliedIds: Set<string> }> = [
		{ spec, count, appliedIds: new Set<string>() }
	];

	const activeReps: Array<{ id: string; perm: CardInstance; def: Extract<StaticDef, { k: 'tokenReplacement' }> }> = [];
	withStableLayerInputs(state, () => {
		let repIdx = 0;
		forEachActiveStaticOnBattlefield(
			state,
			(perm, controllerId, _name, def) => {
				if (def.k !== 'tokenReplacement' || controllerId !== recipient.playerId) return;
				if (def.condition && !evaluateCondition(def.condition, { state, controllerId, source: perm })) {
					return;
				}
				activeReps.push({ id: `${perm.instanceId}:${repIdx++}`, perm, def });
			},
			'tokenReplacement'
		);
	});
	if (activeReps.length === 0) return entries.map((e) => ({ spec: e.spec, count: e.count }));

	for (let pass = 0; pass < 8; pass++) {
		let changed = false;
		const nextEntries: typeof entries = [];
		for (const entry of entries) {
			const faceView = resolveObjectFaces(buildTokenScryfallCard('preview_tok', entry.spec), { zone: 'battlefield' });
			let didReplace = false;
			for (const rep of activeReps) {
				if (entry.appliedIds.has(rep.id)) continue;
				const d = rep.def;
				if (d.mode === 'oneOfEach' && d.matchSubtypes?.length) {
					const matchesSub = d.matchSubtypes.some((sub) =>
						faceView.subtypes.some((s) => s.toLowerCase() === sub.toLowerCase())
					);
					if (!matchesSub) continue;
					const nextApplied = new Set(entry.appliedIds);
					nextApplied.add(rep.id);
					for (const sub of d.matchSubtypes) {
						const low = sub.toLowerCase();
						if (low === 'clue' || low === 'food' || low === 'treasure') {
							nextEntries.push({
								spec: {
									...predefinedTokenToSpec(low),
									...(entry.spec.tapped ? { tapped: true } : {})
								},
								count: entry.count,
								appliedIds: new Set(nextApplied)
							});
						}
					}
					didReplace = true;
					changed = true;
					break;
				}
				if (d.mode === 'replaceSpec' && d.replacementToken) {
					const matches = d.matchSubtypes?.length
						? d.matchSubtypes.some((sub) =>
								faceView.subtypes.some((s) => s.toLowerCase() === sub.toLowerCase())
							)
						: faceView.types.includes('Creature');
					if (!matches) continue;
					const nextApplied = new Set(entry.appliedIds);
					nextApplied.add(rep.id);
					const repTok = d.replacementToken;
					nextEntries.push({
						spec: {
							name: repTok.name,
							typeLine: repTok.typeLine,
							power: repTok.power,
							toughness: repTok.toughness,
							colors: [...repTok.colors],
							keywords: repTok.keywords ? [...repTok.keywords] : [],
							...(repTok.isLegendary ? { legendary: true } : {}),
							...(entry.spec.tapped ? { tapped: true } : {})
						},
						count: entry.count,
						appliedIds: nextApplied
					});
					didReplace = true;
					changed = true;
					break;
				}
			}
			if (!didReplace) nextEntries.push(entry);
		}
		entries = nextEntries;
		if (!changed) break;
	}
	return entries.map((e) => ({ spec: e.spec, count: e.count }));
}

/**
 * Returns the proliferate multiplier active for `playerId` (*Tekuthal, Inquiry Dominus* = 2).
 */
export function getProliferateMultiplierWave9(state: GameState, playerId: string): number {
	let mult = 1;
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut || permanentHasLostAllAbilities(perm, state).lost) continue;
			const pCard = effectiveCardForObject(perm);
			for (const ab of activeAbilityDefs(pCard, instanceFaceOptions(perm, 'battlefield'))) {
				if (ab.kind !== 'replacement') continue;
				const rep = ab.replacement;
				if (rep.replaces.event !== 'proliferate') continue;
				if (rep.replaces.filter?.player?.relation === 'you' && p.playerId !== playerId) continue;
				if (rep.condition && !evaluateCondition(rep.condition, { state, controllerId: p.playerId, source: perm })) {
					continue;
				}
				if (!Array.isArray(rep.with) && rep.with.k === 'modify' && rep.with.proliferateMultiplier) {
					mult *= rep.with.proliferateMultiplier;
				}
			}
		}
	}
	return Math.max(1, Math.min(16, mult));
}

let inNotionThiefDraw = false;

/**
 * Evaluates Wave 9S draw replacements (*Notion Thief*, *Abundance*, *Out of the Tombs*) for a single draw.
 */
export function resolveDrawReplacementWave9(
	state: GameState,
	player: PlayerGameState,
	callbacks: {
		drawSingleForPlayer: (s: GameState, targetPlayer: PlayerGameState) => 'drawn' | 'stopped';
		moveCardToHand: (s: GameState, card: CardInstance, owner: PlayerGameState) => void;
		moveCardToBattlefield: (s: GameState, card: CardInstance, owner: PlayerGameState) => void;
		markPlayerLost: (s: GameState, loser: PlayerGameState, reason: string) => void;
		addLog: (s: GameState, kind: 'rule' | 'cast', msg: string, playerId: string) => void;
	}
): { replaced: boolean; result: 'drawn' | 'stopped' } {
	const activePlayerId = state.players[state.activePlayerIndex]?.playerId;
	const isFirstDrawInDrawStep =
		activePlayerId === player.playerId &&
		state.phase === 'draw' &&
		!player.drewFirstCardInDrawStepThisTurn;

	// 1. Steal opponent extra draws (*Notion Thief*)
	if (!inNotionThiefDraw && !isFirstDrawInDrawStep) {
		for (const p of state.players) {
			if (p.lost || p.playerId === player.playerId) continue;
			for (const perm of p.battlefield) {
				if (perm.phasedOut || permanentHasLostAllAbilities(perm, state).lost) continue;
				const pCard = effectiveCardForObject(perm);
				for (const ab of activeAbilityDefs(pCard, instanceFaceOptions(perm, 'battlefield'))) {
					if (ab.kind !== 'replacement') continue;
					const rep = ab.replacement;
					if (rep.replaces.event !== 'draw') continue;
					if (Array.isArray(rep.with) || rep.with.k !== 'modify' || !rep.with.stealOpponentExtraDraws) {
						continue;
					}
					if (
						rep.condition &&
						!evaluateCondition(rep.condition, { state, controllerId: p.playerId, source: perm })
					) {
						continue;
					}
					inNotionThiefDraw = true;
					try {
						callbacks.addLog(
							state,
							'rule',
							`${pCard.name} replaced ${player.username}'s draw: ${p.username} draws instead.`,
							p.playerId
						);
						const res = callbacks.drawSingleForPlayer(state, p);
						return { replaced: true, result: res };
					} finally {
						inNotionThiefDraw = false;
					}
				}
			}
		}
	}

	// 2. Empty-library graveyard reanimate (*Out of the Tombs*)
	if (player.library.length === 0) {
		for (const perm of player.battlefield) {
			if (perm.phasedOut || permanentHasLostAllAbilities(perm, state).lost) continue;
			const pCard = effectiveCardForObject(perm);
			for (const ab of activeAbilityDefs(pCard, instanceFaceOptions(perm, 'battlefield'))) {
				if (ab.kind !== 'replacement') continue;
				const rep = ab.replacement;
				if (rep.replaces.event !== 'draw') continue;
				if (
					Array.isArray(rep.with) ||
					rep.with.k !== 'modify' ||
					!rep.with.emptyLibraryGraveyardReanimate
				) {
					continue;
				}
				const spec = rep.with.emptyLibraryGraveyardReanimate;
				const cand = [...player.graveyard]
					.reverse()
					.find((g) =>
						matchesObjectFilter(g, { ...spec.filter, zone: 'graveyard' }, {
							state,
							controllerId: player.playerId,
							source: perm,
							zone: 'graveyard'
						})
					);
				if (cand) {
					callbacks.moveCardToBattlefield(state, cand, player);
					callbacks.addLog(
						state,
						'rule',
						`${pCard.name} returned ${cand.card.name} from graveyard to the battlefield instead of drawing.`,
						player.playerId
					);
					return { replaced: true, result: 'drawn' };
				}
				callbacks.markPlayerLost(
					state,
					player,
					`${pCard.name}: empty library and no matching card in graveyard.`
				);
				return { replaced: true, result: 'stopped' };
			}
		}
	}

	// 3. Interactive / smart land-or-nonland top reveal (*Abundance*)
	if (player.library.length > 0) {
		for (const perm of player.battlefield) {
			if (perm.phasedOut || permanentHasLostAllAbilities(perm, state).lost) continue;
			const pCard = effectiveCardForObject(perm);
			for (const ab of activeAbilityDefs(pCard, instanceFaceOptions(perm, 'battlefield'))) {
				if (ab.kind !== 'replacement') continue;
				const rep = ab.replacement;
				if (rep.replaces.event !== 'draw') continue;
				if (Array.isArray(rep.with) || rep.with.k !== 'modify' || !rep.with.abundanceDrawChoice) {
					continue;
				}
				let choice = player.abundanceNextChoice;
				if (choice) {
					delete player.abundanceNextChoice;
				} else {
					const handLands = player.hand.filter((c) =>
						resolveObjectFaces(effectiveCardForObject(c), instanceFaceOptions(c, 'hand')).types.includes('Land')
					).length;
					choice = handLands <= 1 ? 'land' : 'nonland';
				}
				const skipped: CardInstance[] = [];
				let hit: CardInstance | undefined;
				for (const c of player.library) {
					const isLand = resolveObjectFaces(
						effectiveCardForObject(c),
						instanceFaceOptions(c, 'library')
					).types.includes('Land');
					if ((choice === 'land' && isLand) || (choice === 'nonland' && !isLand)) {
						hit = c;
						break;
					}
					skipped.push(c);
				}
				const skipSet = new Set(skipped);
				player.library = [...player.library.filter((c) => !skipSet.has(c)), ...skipped];
				if (hit) {
					callbacks.moveCardToHand(state, hit, player);
					callbacks.addLog(
						state,
						'rule',
						`${player.username} chose ${choice} (${pCard.name}) and put ${hit.card.name} into hand.`,
						player.playerId
					);
				} else {
					callbacks.addLog(
						state,
						'rule',
						`${player.username} chose ${choice} (${pCard.name}) but found none in library.`,
						player.playerId
					);
				}
				return { replaced: true, result: 'drawn' };
			}
		}
	}

	return { replaced: false, result: 'drawn' };
}

/**
 * Checks `cantEnterFromZones` (*Grafdigger's Cage*, *Soulless Jailer*) when an object moves to the battlefield.
 */
export function checkCantEnterFromZonesWave9(
	state: GameState,
	obj: CardInstance,
	fromZone: ZoneType | null
): boolean {
	if (!fromZone) return false;
	let blocked = false;
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut || permanentHasLostAllAbilities(perm, state).lost) continue;
			const pCard = effectiveCardForObject(perm);
			for (const ab of activeAbilityDefs(pCard, instanceFaceOptions(perm, 'battlefield'))) {
				if (ab.kind !== 'static' || ab.static.k !== 'cantEnterFromZones') continue;
				const st = ab.static;
				if (!st.zones.includes(fromZone)) continue;
				if (st.condition && !evaluateCondition(st.condition, { state, controllerId: p.playerId, source: perm })) {
					continue;
				}
				if (
					matchesObjectFilter(obj, { ...st.filter, zone: fromZone }, {
						state,
						controllerId: p.playerId,
						source: perm,
						zone: fromZone
					})
				) {
					blocked = true;
					return true;
				}
			}
		}
	}
	return blocked;
}

/**
 * Handles `diesExileAndReflexive` (*Valentin, Dean of the Vein*) on battlefield -> graveyard moves.
 */
export function checkDiesExileAndReflexiveWave9(
	state: GameState,
	obj: CardInstance
): StackItem | null {
	if (obj.isToken) return null;
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut || permanentHasLostAllAbilities(perm, state).lost) continue;
			const pCard = effectiveCardForObject(perm);
			for (const ab of activeAbilityDefs(pCard, instanceFaceOptions(perm, 'battlefield'))) {
				if (ab.kind !== 'replacement') continue;
				const rep = ab.replacement;
				if (rep.replaces.event !== 'zoneChange') continue;
				if (Array.isArray(rep.with) || rep.with.k !== 'modify' || !rep.with.diesExileAndReflexive) {
					continue;
				}
				const f = rep.replaces.filter;
				if (f?.from !== 'battlefield' || f?.to !== 'graveyard') continue;
				const fObj = f.object && typeof f.object === 'object' ? f.object : undefined;
				if (
					fObj &&
					!matchesObjectFilter(obj, { ...fObj, zone: 'battlefield' }, {
						state,
						controllerId: p.playerId,
						source: perm
					})
				) {
					continue;
				}
				if (rep.condition && !evaluateCondition(rep.condition, { state, controllerId: p.playerId, source: perm })) {
					continue;
				}
				const reflexive = rep.with.diesExileAndReflexive;
				const stackItem = withStackItemText(
					{
						id: uid('w9_dies_ref', state),
						sourceInstanceId: perm.instanceId,
						card: pCard,
						controllerId: p.playerId,
						kind: 'triggered',
						title: `${pCard.name} — Pay ${reflexive.payManaCost} for Token`,
						targets: [],
						xValue: 0,
						requiresGuidedResolution: false,
						createdAt: allocateTimestamp(state),
						wave9Tag: 'dies_exile_reflexive',
						wave9PayCost: reflexive.payManaCost,
						wave9TokenData: {
							name: reflexive.tokenSpec.name,
							typeLine: reflexive.tokenSpec.typeLine,
							power: reflexive.tokenSpec.power,
							toughness: reflexive.tokenSpec.toughness,
							colors: [...reflexive.tokenSpec.colors],
							quotedAbilities: [reflexive.tokenSpec.triggerText]
						}
					},
					`When you do, you may pay ${reflexive.payManaCost}. If you do, create a ${reflexive.tokenSpec.power}/${reflexive.tokenSpec.toughness} ${reflexive.tokenSpec.name} creature token with "${reflexive.tokenSpec.triggerText}"`
				);
				return stackItem;
			}
		}
	}
	return null;
}

/**
 * Handles damage prevention `onPrevented` riders (*Vigor*, *Weeping Angel*, *Phyrexian Vindicator*).
 */
export function handlePreventedDamageRiderWave9(
	state: GameState,
	staticPerm: CardInstance,
	controllerId: string,
	targetKind: 'permanent' | 'player',
	targetPerm: CardInstance | undefined,
	preventedAmount: number,
	onPrevented: NonNullable<Extract<StaticDef, { k: 'staticDamagePrevention' }>['onPrevented']>,
	callbacks: {
		shuffleIntoLibrary: (s: GameState, perm: CardInstance) => void;
	}
): void {
	if (preventedAmount <= 0) return;
	if (onPrevented.k === 'putPlusCountersPerDamage' && targetKind === 'permanent' && targetPerm) {
		targetPerm.counters['+1/+1'] = (targetPerm.counters['+1/+1'] ?? 0) + preventedAmount;
		noteLayerInputsChanged(state);
		return;
	}
	if (onPrevented.k === 'shuffleTargetIntoLibrary' && targetKind === 'permanent' && targetPerm) {
		callbacks.shuffleIntoLibrary(state, targetPerm);
		return;
	}
	if (onPrevented.k === 'reflexiveDamageTrigger') {
		const staticCard = effectiveCardForObject(staticPerm);
		// Pick a default legal opponent or opponent creature target; tests or guided mode can override target via queue
		const targetRef = pickReflexiveDamageTarget(state, controllerId, staticPerm.instanceId);
		if (!targetRef) return;
		const stackItem = withStackItemText(
			{
				id: uid('w9_dmg_ref', state),
				sourceInstanceId: staticPerm.instanceId,
				card: staticCard,
				controllerId,
				kind: 'triggered',
				title: `${staticCard.name} — Prevented Damage Trigger`,
				targets: [targetRef],
				xValue: 0,
				eventAmount: preventedAmount,
				requiresGuidedResolution: false,
				createdAt: allocateTimestamp(state),
				wave9ReflexiveOnPrevented: true
			},
			`When damage is prevented this way, ~ deals ${preventedAmount} damage to any other target.`
		);
		state.stack.push(stackItem);
	}
}

function pickReflexiveDamageTarget(
	state: GameState,
	controllerId: string,
	selfId: string
): TargetRef | null {
	const oppCreature = state.players
		.filter((p) => !p.lost && p.playerId !== controllerId)
		.flatMap((p) => p.battlefield)
		.find((b) => {
			if (b.phasedOut || b.instanceId === selfId) return false;
			return resolveObjectFaces(effectiveCardForObject(b), instanceFaceOptions(b, 'battlefield')).types.includes(
				'Creature'
			);
		});
	if (oppCreature) {
		return { kind: 'permanent', id: oppCreature.instanceId, label: oppCreature.card.name };
	}
	const opp = state.players.find((p) => !p.lost && p.playerId !== controllerId);
	if (opp) {
		return { kind: 'player', id: opp.playerId, label: opp.username };
	}
	return null;
}

/**
 * Applies Wave 9S copy modification extras (`additionalCounters` for *Altered Ego*, `conditionalTypeCounters` for *Spark Double*).
 */
export function applyWave9CopyModificationExtras(
	perm: CardInstance,
	mods: CopyModificationSpec | undefined,
	state: GameState
): void {
	if (!mods) return;
	if (mods.additionalCounters) {
		const amt =
			mods.additionalCounters.amount.k === 'x'
				? perm.enteredWithX ?? 0
				: evaluateAmount(mods.additionalCounters.amount, {
						state,
						controllerId: perm.controllerId,
						source: perm
					});
		if (amt > 0) {
			perm.counters[mods.additionalCounters.counter] =
				(perm.counters[mods.additionalCounters.counter] ?? 0) + amt;
			noteLayerInputsChanged(state);
		}
	}
	if (mods.conditionalTypeCounters?.length) {
		const faceTypes = resolveObjectFaces(
			effectiveCardForObject(perm),
			instanceFaceOptions(perm, 'battlefield')
		).types;
		for (const entry of mods.conditionalTypeCounters) {
			if (faceTypes.includes(entry.type) && entry.count > 0) {
				perm.counters[entry.counter] = (perm.counters[entry.counter] ?? 0) + entry.count;
				noteLayerInputsChanged(state);
			}
		}
	}
}

/**
 * Checks whether a card has a `copyFromGraveyards` ETB replacement (*Echoing Deeps*) and applies it on ETB.
 */
export function applyGraveyardCopyEtbWave9(
	state: GameState,
	perm: CardInstance,
	controllerId: string,
	applyCopyFn: (
		dest: CardInstance,
		sourceObj: CardInstance,
		mods: CopyModificationSpec | undefined,
		origCard: CardInstance['card'],
		st: GameState
	) => string,
	chosenTargetId?: string
): boolean {
	const card = effectiveCardForObject(perm);
	for (const ab of activeAbilityDefs(card, instanceFaceOptions(perm, 'battlefield'))) {
		if (ab.kind !== 'replacement') continue;
		const rep = ab.replacement;
		if (
			rep.replaces.event !== 'zoneChange' ||
			Array.isArray(rep.with) ||
			rep.with.k !== 'modify' ||
			!rep.with.copyFromGraveyards
		) {
			continue;
		}
		const spec = rep.with.copyFromGraveyards;
		const candidates: CardInstance[] = [];
		for (const p of state.players) {
			for (const g of p.graveyard) {
				if (
					matchesObjectFilter(g, { ...spec.filter, zone: 'graveyard' }, {
						state,
						controllerId,
						source: perm,
						zone: 'graveyard'
					})
				) {
					candidates.push(g);
				}
			}
		}
		if (candidates.length === 0) return false;
		const picked = chosenTargetId ? candidates.find((c) => c.instanceId === chosenTargetId) : candidates[0];
		if (!picked) return false;
		const origCard = perm.printedCard ?? perm.card;
		applyCopyFn(perm, picked, spec.copyModifications, origCard, state);
		if (spec.tappedIfCopied) perm.tapped = true;
		noteLayerInputsChanged(state);
		return true;
	}
	return false;
}

/**
 * Checks `revealUnlessControls` bypass (*Temple of the Dragon Queen*) when entering the battlefield.
 */
export function controllerControlsRevealBypassWave9(
	state: GameState,
	controllerId: string,
	perm: CardInstance,
	filter?: ObjectFilter
): boolean {
	if (!filter) return false;
	const p = state.players.find((pl) => pl.playerId === controllerId);
	if (!p) return false;
	return p.battlefield.some(
		(b) =>
			!b.phasedOut &&
			b.instanceId !== perm.instanceId &&
			matchesObjectFilter(b, { ...filter, zone: 'battlefield' }, {
				state,
				controllerId,
				source: perm
			})
	);
}

/**
 * Returns creature cards in `player.hand` eligible for `etbDiscardForKeywordCounters`.
 */
export function getEtbDiscardCreatureCandidatesWave9(
	player: PlayerGameState
): CardInstance[] {
	return player.hand.filter((c) =>
		resolveObjectFaces(effectiveCardForObject(c), instanceFaceOptions(c, 'hand')).types.includes(
			'Creature'
		)
	);
}

/**
 * Bot selection for `etbDiscardForKeywordCounters`: discards creature cards that grant new tracked keywords.
 */
export function chooseBotEtbDiscardForKeywordsWave9(
	player: PlayerGameState,
	trackedKeywords: string[]
): string[] {
	const tracked = new Set(trackedKeywords.map((k) => k.toLowerCase()));
	const covered = new Set<string>();
	const chosen: string[] = [];
	for (const c of getEtbDiscardCreatureCandidatesWave9(player)) {
		const cardKws = new Set<string>();
		const card = effectiveCardForObject(c);
		const faceOpts = instanceFaceOptions(c, 'hand');
		for (const kw of resolveObjectFaces(card, faceOpts).keywords) cardKws.add(kw.toLowerCase());
		for (const ab of activeAbilityDefs(card, faceOpts)) {
			if (ab.kind === 'keyword') cardKws.add(ab.keyword.name.toLowerCase());
		}
		let addsNew = false;
		for (const kw of cardKws) {
			if (tracked.has(kw) && !covered.has(kw)) {
				addsNew = true;
				break;
			}
		}
		if (addsNew) {
			for (const kw of cardKws) {
				if (tracked.has(kw)) covered.add(kw);
			}
			chosen.push(c.instanceId);
		}
	}
	return chosen;
}

/**
 * Runtime primitive for `etbDiscardForKeywordCounters` (CR 614.1c discard-for-keyword-counters).
 */
export function applyEtbDiscardForKeywordCountersWave9(
	state: GameState,
	perm: CardInstance,
	player: PlayerGameState,
	discardCardIds: string[],
	trackedKeywords: string[],
	discardCardFn: (s: GameState, pl: PlayerGameState, c: CardInstance) => void,
	placeCountersFn?: (s: GameState, target: CardInstance, counter: CounterType, count: number) => void
): void {
	const granted = new Set<string>();
	for (const id of discardCardIds) {
		const card = player.hand.find((h) => h.instanceId === id);
		if (!card) continue;
		for (const kw of resolveObjectFaces(effectiveCardForObject(card), instanceFaceOptions(card, 'hand')).keywords) {
			granted.add(kw.toLowerCase());
		}
		for (const ab of activeAbilityDefs(effectiveCardForObject(card), instanceFaceOptions(card, 'hand'))) {
			if (ab.kind === 'keyword') granted.add(ab.keyword.name.toLowerCase());
		}
		discardCardFn(state, player, card);
	}
	for (const kw of trackedKeywords) {
		const low = kw.toLowerCase();
		if (granted.has(low)) {
			const cKey = low as CounterType;
			if (placeCountersFn) {
				placeCountersFn(state, perm, cKey, 1);
			} else {
				perm.counters[cKey] = (perm.counters[cKey] ?? 0) + 1;
				(perm.counterTimestamps ??= {})[cKey] = allocateTimestamp(state);
			}
		}
	}
	noteLayerInputsChanged(state);
}

/**
 * Returns battlefield permanents matching `filter` (excluding `selfPerm`) that have at least 1 counter.
 */
export function getEtbRemoveCounterCandidatesWave9(
	state: GameState,
	selfPerm: CardInstance,
	controllerId: string,
	filter?: ObjectFilter
): CardInstance[] {
	const out: CardInstance[] = [];
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut || perm.instanceId === selfPerm.instanceId) continue;
			const hasAny = Object.values(perm.counters).some((v) => (v ?? 0) > 0);
			if (!hasAny) continue;
			if (
				filter &&
				!matchesObjectFilter(perm, { ...filter, zone: 'battlefield' }, {
					state,
					controllerId,
					source: selfPerm
				})
			) {
				continue;
			}
			out.push(perm);
		}
	}
	return out;
}

/**
 * Bot selection for `etbRemoveCountersForPlusCounters`: removes counters from opponents' permanents
 * (and negative counters from own permanents).
 */
export function chooseBotEtbRemoveCountersWave9(
	state: GameState,
	selfPerm: CardInstance,
	controllerId: string,
	filter?: ObjectFilter
): CardInstance[] {
	const cands = getEtbRemoveCounterCandidatesWave9(state, selfPerm, controllerId, filter);
	const negKeys = new Set(['-1/-1', 'stun', 'finality', 'slumber', 'blight', 'ice']);
	return cands.filter((c) => {
		if (c.controllerId !== controllerId) return true;
		return Object.entries(c.counters).some(([k, v]) => (v ?? 0) > 0 && negKeys.has(k));
	});
}

/**
 * Runtime primitive for `etbRemoveCountersForPlusCounters` (CR 614.1c remove counters -> twice as many +1/+1 counters).
 */
export function applyEtbRemoveCountersForPlusCountersWave9(
	state: GameState,
	perm: CardInstance,
	targets: Array<{ perm: CardInstance; counter?: CounterType }>,
	multiplier = 2,
	placeCountersFn?: (s: GameState, target: CardInstance, counter: CounterType, count: number) => void
): number {
	let totalRemoved = 0;
	for (const t of targets) {
		if (t.perm.instanceId === perm.instanceId) continue;
		for (const [k, v] of Object.entries(t.perm.counters)) {
			if ((v ?? 0) <= 0) continue;
			if (t.counter && k !== t.counter) continue;
			totalRemoved += v!;
			t.perm.counters[k as CounterType] = 0;
		}
	}
	const added = totalRemoved * multiplier;
	if (added > 0) {
		if (placeCountersFn) {
			placeCountersFn(state, perm, '+1/+1', added);
		} else {
			perm.counters['+1/+1'] = (perm.counters['+1/+1'] ?? 0) + added;
		}
	}
	noteLayerInputsChanged(state);
	return added;
}

let suppressTokenRepWave9 = false;

export function isTokenReplacementSuppressedWave9(): boolean {
	return suppressTokenRepWave9;
}

export function runWithTokenReplacementSuppressedWave9<T>(fn: () => T): T {
	suppressTokenRepWave9 = true;
	try {
		return fn();
	} finally {
		suppressTokenRepWave9 = false;
	}
}

/**
 * Resolves Wave 9S plain-JSON stack trigger items (`dies_exile_reflexive`, `evoke_sac`, and `wave9ReflexiveOnPrevented`).
 */
export function resolveWave9StackTriggerItem(
	state: GameState,
	item: StackItem,
	callbacks: {
		tryPayMana: (s: GameState, pl: PlayerGameState, cost: string) => boolean;
		createToken: (s: GameState, pl: PlayerGameState, spec: TokenSpec) => CardInstance;
		dealDamage: (s: GameState, target: TargetRef, dmg: number, src: CardInstance | undefined, srcId: string, ctrlId: string) => void;
		sacrificePermanent?: (s: GameState, instanceId: string, objectVersion?: number) => void;
	}
): boolean {
	if (item.wave9ReflexiveOnPrevented) {
		const amt = item.eventAmount ?? 0;
		if (amt > 0 && item.targets[0]) {
			const src = state.players.flatMap((p) => p.battlefield).find((b) => b.instanceId === item.sourceInstanceId);
			callbacks.dealDamage(state, item.targets[0], amt, src, item.sourceInstanceId, item.controllerId);
		}
		return true;
	}
	if (item.wave9Tag === 'evoke_sac') {
		callbacks.sacrificePermanent?.(state, item.sourceInstanceId, item.sourceObjectVersion);
		return true;
	}
	if (item.wave9Tag === 'dies_exile_reflexive' && item.wave9TokenData && item.wave9PayCost) {
		const ctrl = state.players.find((p) => p.playerId === item.controllerId);
		if (ctrl && !ctrl.lost && callbacks.tryPayMana(state, ctrl, item.wave9PayCost)) {
			callbacks.createToken(state, ctrl, {
				...item.wave9TokenData,
				keywords: []
			});
		}
		return true;
	}
	return false;
}

export { createEmptyCounterMap };
