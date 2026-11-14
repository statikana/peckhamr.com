/**
 * Track P5 — Self-contained CR 701 keyword action handlers:
 * - Amass [Subtype] N (CR 701.47a–d)
 * - Incubate N (CR 701.53a–c, CR 111.10i)
 * - Populate (CR 701.36a–b, CR 707.2, CR 707.8a)
 * - Manifest (CR 701.40a–g), Cloak (CR 701.58a–h), Manifest dread (CR 701.62a–b)
 * - Monstrosity N (CR 701.37a–c)
 * - Bolster N (CR 701.39a)
 * - Adapt N (CR 701.46a)
 */
import { compileCard } from '../compiler/index.ts';
import type { Amount, EffectStep, ObjectFilter, PlayerRef, Selector, TokenSpec } from '../ir.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import { getCardFaces } from '../scryfall.ts';
import type {
	CardInstance,
	ChoiceAnswer,
	FaceDownSpec,
	GameState,
	PlayerGameState,
	ScryfallCard,
	ZoneType
} from '../types.ts';
import { keywordAltCost } from './costs.ts';
import type { EffectPorts } from './effects.ts';
import { emitEvent } from './events.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { matchesObjectFilter, objectManaValue } from './objectFilter.ts';
import { tokenMultiplier } from './replace.ts';
import { flushTriggers } from './triggers.ts';
import {
	allocateTimestamp,
	moveObject,
	syncBattlefieldControllers,
	type MoveResult
} from './zones.ts';

export interface KeywordActionHost {
	readonly state: GameState;
	readonly ports: EffectPorts;
	readonly you: PlayerGameState;
	readonly title: string;
	readonly sourceCard: ScryfallCard;
	readonly sourceId: string;
	readonly sourceObjectVersion?: number;
	readonly stepIndex: number;
	readonly canPause: boolean;
	readonly answers: Record<string, ChoiceAnswer>;
	amount(a: Amount | undefined, fallback?: number): number;
	objects(sel: Selector): CardInstance[];
	players(sel: Selector): PlayerGameState[];
	playerRef(ref: PlayerRef): PlayerGameState | null;
	matches(
		c: CardInstance,
		f: ObjectFilter,
		zone: 'battlefield' | 'graveyard' | 'hand' | 'library' | 'exile'
	): boolean;
	locate(id: string): {
		inst: CardInstance;
		holder: PlayerGameState;
		zone: 'battlefield' | 'graveyard' | 'exile' | 'hand' | 'library';
	} | null;
	bind(step: EffectStep, objs: CardInstance[]): void;
	answered(
		chooserOrKey: PlayerGameState | string,
		candidates: CardInstance[],
		min: number,
		max?: number
	): CardInstance[] | null;
	pauseForChoice(
		chooser: PlayerGameState,
		title: string,
		description: string,
		candidates: string[],
		min: number,
		max: number,
		zone: ZoneType,
		defaultObjectIds?: string[],
		answerKey?: string
	): void;
	runIndexedBatch(
		batchKey: string,
		captureIds: () => string[],
		applyAt: (id: string, index: number) => MoveResult | string | void
	): { total: number; paused: boolean };
}

function resolveActors(host: KeywordActionHost, step: EffectStep): PlayerGameState[] {
	if (step.subject.k === 'player' || step.subject.k === 'playerRef') {
		return host.players(step.subject).filter((pl) => !pl.lost);
	}
	if (step.actor) {
		const pl = host.playerRef(step.actor);
		return pl && !pl.lost ? [pl] : [];
	}
	return host.you.lost ? [] : [host.you];
}

function controlledArmies(state: GameState, actor: PlayerGameState): CardInstance[] {
	return actor.battlefield.filter((perm) => {
		if (perm.phasedOut) return false;
		const ev = evaluatePermanent(state, perm);
		return ev.isCreature && ev.hasSubType('Army');
	});
}

// ---- 1. Amass [Subtype] N (CR 701.47a–d) --------------------------------------------------------

export function executeAmass(host: KeywordActionHost, step: EffectStep): void {
	const state = host.state;
	const subtype = step.params?.amassSubtype || 'Zombie';
	const n = Math.max(0, host.amount(step.amount, 1));
	const amassedList: CardInstance[] = [];

	const { paused } = host.runIndexedBatch(
		`amass_actors:${host.stepIndex}`,
		() => resolveActors(host, step).map((pl) => pl.playerId),
		(actorId, idx) => {
			const actor = state.players.find((pl) => pl.playerId === actorId);
			if (!actor || actor.lost) return;

			const createdFlagKey = `amass_created:${host.stepIndex}:${actorId}:${idx}`;
			let armies = controlledArmies(state, actor);
			if (armies.length === 0 && !host.answers[createdFlagKey]) {
				const count = 1 * tokenMultiplier(state, actor.playerId);
				const spec: TokenSpec = {
					name: `${subtype} Army Token`,
					power: 0,
					toughness: 0,
					colors: ['B'],
					typeLine: `Token Creature — ${subtype} Army`,
					keywords: []
				};
				for (let i = 0; i < count; i++) {
					host.ports.createToken(state, actor, spec);
				}
				if (host.canPause) {
					host.answers[createdFlagKey] = { kind: 'yesNo', yes: true };
				}
				armies = controlledArmies(state, actor);
			}

			let chosen: CardInstance | undefined;
			if (armies.length === 1) {
				chosen = armies[0];
			} else if (armies.length > 1) {
				const sorted = [...armies].sort((a, b) => {
					const evA = evaluatePermanent(state, a);
					const evB = evaluatePermanent(state, b);
					return evB.power - evA.power || evB.toughness - evA.toughness;
				});
				const pickKey = `amass_pick:${host.stepIndex}:${actorId}:${idx}`;
				if (!actor.isBot && host.canPause) {
					const ans = host.answered(pickKey, armies, 1, 1);
					if (!ans) {
						host.pauseForChoice(
							actor,
							`${host.title} — Amass ${subtype} ${n}`,
							`Choose an Army creature you control to put ${n} +1/+1 counter(s) on.`,
							armies.map((c) => c.instanceId),
							1,
							1,
							'battlefield',
							[sorted[0].instanceId],
							pickKey
						);
						return;
					}
					chosen = ans[0];
				} else {
					chosen = sorted[0];
				}
			}

			if (chosen) {
				if (n > 0) {
					host.ports.addCounters(state, chosen, '+1/+1', n);
				}
				const evChosen = evaluatePermanent(state, chosen);
				if (!evChosen.hasSubType(subtype)) {
					const ts = allocateTimestamp(state);
					(state.timedContinuousEffects ??= []).push({
						timestamp: ts,
						sourceName: host.sourceCard.name,
						controllerId: actor.playerId,
						expires: 'never',
						affected: [
							{
								instanceId: chosen.instanceId,
								objectVersion: chosen.objectVersion ?? 1
							}
						],
						layer4: {
							addSubtypes: [subtype]
						}
					});
					noteLayerInputsChanged(state);
				}
				amassedList.push(chosen);
				const chosenLabel = chosen.isFaceDown
					? chosen.faceDownLabel || 'Face-Down Creature'
					: chosen.card.name;
				host.ports.addLog(
					state,
					'rule',
					`${actor.username} amassed ${subtype} ${n} on ${chosenLabel} (CR 701.47a).`,
					actor.playerId
				);
			}

			// CR 701.47b: A player "amassed" even if some or all of the amass actions were impossible.
			emitEvent(state, {
				kind: 'Amassed',
				playerId: actor.playerId,
				...(chosen ? { objectId: chosen.instanceId, object: chosen } : {}),
				subtype,
				amount: n
			});
			flushTriggers(state);
		}
	);

	if (!paused) {
		host.bind(step, amassedList);
	}
}

// ---- 2. Incubate N (CR 701.53a–c, CR 111.10i) ---------------------------------------------------

export function executeIncubate(host: KeywordActionHost, step: EffectStep): void {
	const state = host.state;
	const n = Math.max(0, host.amount(step.amount, 0));
	const repeat = Math.max(0, host.amount(step.params?.count, 1));
	if (repeat <= 0) return;

	const created: CardInstance[] = [];
	const spec: TokenSpec = {
		name: 'Incubator Token',
		power: 0,
		toughness: 0,
		colors: [],
		typeLine: 'Token Artifact — Incubator',
		keywords: [],
		...(step.params?.tapped ? { tapped: true } : {})
	};

	for (const actor of resolveActors(host, step)) {
		const totalTokens = repeat * tokenMultiplier(state, actor.playerId);
		for (let i = 0; i < totalTokens; i++) {
			const tok = host.ports.createToken(state, actor, spec);
			if (n > 0 && tok.zone === 'battlefield') {
				host.ports.addCounters(state, tok, '+1/+1', n);
			}
			created.push(tok);
		}
		if (totalTokens > 0) {
			host.ports.addLog(
				state,
				'rule',
				`${actor.username} incubated ${n}${totalTokens > 1 ? ` (${totalTokens}x Incubator tokens)` : ''} (CR 701.53a).`,
				actor.playerId
			);
		}
		flushTriggers(state);
	}

	host.bind(step, created);
}

// ---- 3. Populate (CR 701.36a–b, CR 707.2, CR 707.8a) --------------------------------------------

export function executePopulate(host: KeywordActionHost, step: EffectStep): void {
	const state = host.state;
	const repeat = Math.max(0, host.amount(step.amount, 1));
	if (repeat <= 0) return;

	const created: CardInstance[] = [];
	const { paused } = host.runIndexedBatch(
		`populate_batch:${host.stepIndex}`,
		() => {
			const entries: string[] = [];
			for (const actor of resolveActors(host, step)) {
				for (let r = 0; r < repeat; r++) {
					entries.push(`${actor.playerId}:${r}`);
				}
			}
			return entries;
		},
		(entry, iter) => {
			const colonIdx = entry.indexOf(':');
			const actorId = colonIdx >= 0 ? entry.slice(0, colonIdx) : entry;
			const actor = state.players.find((pl) => pl.playerId === actorId);
			if (!actor || actor.lost) return;

			const candidates = actor.battlefield.filter(
				(perm) => !perm.phasedOut && perm.isToken && evaluatePermanent(state, perm).isCreature
			);
			// CR 701.36b: If you control no creature tokens when instructed to populate, nothing happens.
			if (candidates.length === 0) return;

			const scoreToken = (perm: CardInstance): number => {
				const ev = evaluatePermanent(state, perm);
				return (ev.power + ev.toughness) * 10 + objectManaValue(state, perm) + ev.keywords.length;
			};
			const sorted = [...candidates].sort((a, b) => scoreToken(b) - scoreToken(a));

			let chosen: CardInstance;
			if (candidates.length === 1) {
				chosen = candidates[0];
			} else if (!actor.isBot && host.canPause) {
				const pickKey = `pop:${host.stepIndex}:${actorId}:${iter}`;
				const ans = host.answered(pickKey, candidates, 1, 1);
				if (!ans) {
					host.pauseForChoice(
						actor,
						`${host.title} — Populate`,
						'Choose a creature token you control to create a copy of.',
						candidates.map((c) => c.instanceId),
						1,
						1,
						'battlefield',
						[sorted[0].instanceId],
						pickKey
					);
					return;
				}
				chosen = ans[0];
			} else {
				chosen = sorted[0];
			}

			const mult = tokenMultiplier(state, actor.playerId);
			for (let m = 0; m < mult; m++) {
				const copy = host.ports.copyPermanentAsToken(
					state,
					actor,
					chosen,
					host.sourceCard.name,
					false
				);
				created.push(copy);
			}
		}
	);

	if (!paused && created.length > 0) {
		host.bind(step, created);
	}
}

// ---- 4. Manifest (CR 701.40), Cloak (CR 701.58), & Manifest dread (CR 701.62) -------------------

export function buildManifestOrCloakFaceDownSpec(
	card: ScryfallCard,
	controllerId: string,
	kind: 'manifest' | 'cloak'
): FaceDownSpec {
	const compiled = compileCard(card);
	const irFront = compiled.faces[0];
	const rawFront = getCardFaces(card)[0];
	const frontTypes = irFront?.characteristics.types ?? [];
	const isInstantOrSorcery = frontTypes.includes('Instant') || frontTypes.includes('Sorcery');
	const isCreature = frontTypes.includes('Creature');
	const printedManaCost = (rawFront?.manaCost ?? card.manaCost ?? '').trim();

	const spec: FaceDownSpec = {
		kind,
		knownToPlayerIds: [controllerId],
		...(kind === 'cloak' ? { wardCost: '{2}' } : {})
	};

	// CR 701.40g / 701.58g: Instant or sorcery cards can never be turned face up via manifest/cloak.
	if (isInstantOrSorcery) {
		return spec;
	}

	// CR 701.40b / 701.58b: A manifested/cloaked creature card with a mana cost may be turned face up
	// any time its controller has priority by paying its mana cost.
	if (isCreature && printedManaCost !== '') {
		spec.turnUpManaCost = printedManaCost;
		spec.turnUpCost = printedManaCost;
		return spec;
	}

	// CR 701.40c / 701.58c: A manifested/cloaked card with morph, megamorph, or disguise may be turned
	// face up for that ability's turn-face-up cost (e.g. a land with morph or mana-costless morph).
	const altCost =
		keywordAltCost(card, 'morph', 0) ??
		keywordAltCost(card, 'megamorph', 0) ??
		keywordAltCost(card, 'disguise', 0);
	if (altCost) {
		if (altCost.manaCost !== undefined) spec.turnUpManaCost = altCost.manaCost;
		if (altCost.costDefs.length > 0) spec.turnUpCostDefs = altCost.costDefs;
		spec.turnUpCost = altCost.display;
	}

	return spec;
}

export function manifestOrCloakCard(
	host: KeywordActionHost,
	controller: PlayerGameState,
	inst: CardInstance,
	kind: 'manifest' | 'cloak',
	tapped = false
): CardInstance | null {
	if (inst.isToken || inst.zone === 'battlefield') return null;
	const located = host.locate(inst.instanceId);
	if (!located || located.zone === 'battlefield') return null;
	const state = host.state;
	const label = host.ports.allocateFaceDownLabel(state);

	// Prepare face-down characteristics BEFORE moveObject so the permanent enters as a 2/2 colorless
	// nameless creature without firing printed ETB abilities (CR 701.40a, 701.58a, 708.3).
	inst.isFaceDown = true;
	inst.faceDownSpec = buildManifestOrCloakFaceDownSpec(inst.card, controller.playerId, kind);
	inst.faceDownLabel = label;
	inst.transformed = false;
	inst.activeFaceIndex = 0;
	inst.summoningSick = true;
	inst.tapped = tapped;
	inst.defaultControllerId = controller.playerId;

	moveObject(state, inst, 'battlefield', {
		from: { zone: located.zone, player: located.holder },
		toPlayer: controller,
		controllerId: controller.playerId,
		bumpVersion: true,
		newTimestamp: true
	});
	syncBattlefieldControllers(state);
	noteLayerInputsChanged(state);

	host.ports.addLog(
		state,
		'rule',
		`${controller.username} ${kind === 'cloak' ? 'cloaked' : 'manifested'} a card face down as ${label} (CR ${kind === 'cloak' ? '701.58a' : '701.40a'}).`,
		controller.playerId
	);
	flushTriggers(state);
	return (inst.zone as ZoneType) === 'battlefield' ? inst : null;
}

function scoreCardForFaceDownPick(state: GameState, inst: CardInstance): number {
	const compiled = compileCard(inst.card);
	const frontTypes = compiled.faces[0]?.characteristics.types ?? [];
	const isCreature = frontTypes.includes('Creature') ? 1 : 0;
	return isCreature * 1000 + objectManaValue(state, inst);
}

export function executeManifestOrCloak(
	host: KeywordActionHost,
	step: EffectStep,
	kind: 'manifest' | 'cloak'
): void {
	const state = host.state;
	const tapped = Boolean(step.params?.tapped);
	const manifested: CardInstance[] = [];

	if (
		step.subject.k === 'libraryTop' ||
		step.subject.k === 'player' ||
		step.subject.k === 'playerRef'
	) {
		const count = Math.max(0, host.amount(step.amount, 1));
		if (count <= 0) return;
		const actors = resolveActors(host, step);
		for (const actor of actors) {
			const libOwner =
				(step.subject.k === 'libraryTop' && step.subject.player
					? host.playerRef(step.subject.player)
					: null) ?? actor;
			if (!libOwner) continue;
			for (let i = 0; i < count; i++) {
				const top = libOwner.library[0];
				if (!top) break;
				const placed = manifestOrCloakCard(host, actor, top, kind, tapped);
				if (placed) manifested.push(placed);
			}
		}
		host.bind(step, manifested);
		return;
	}

	if (step.subject.k === 'all' && step.subject.filter.zone === 'hand') {
		const ownerRel = step.subject.filter.owner;
		const filter: ObjectFilter = { ...step.subject.filter };
		delete filter.owner;
		delete filter.controller;
		const reqCount = Math.max(0, host.amount(step.amount, 1));
		if (reqCount <= 0) return;

		const resolveHandActors = (): PlayerGameState[] => {
			if (step.actor) return resolveActors(host, step);
			if (ownerRel === 'opponent') {
				return host.players({ k: 'player', filter: { relation: 'each_opponent' } }).filter((pl) => !pl.lost);
			}
			if (ownerRel === 'any') {
				return host.players({ k: 'player', filter: { relation: 'each_player' } }).filter((pl) => !pl.lost);
			}
			return resolveActors(host, step);
		};

		const { paused } = host.runIndexedBatch(
			`manifest_hand_actors:${host.stepIndex}`,
			() => resolveHandActors().map((pl) => pl.playerId),
			(actorId, idx) => {
				const actor = state.players.find((pl) => pl.playerId === actorId);
				if (!actor || actor.lost) return;
				const candidates = actor.hand.filter((c) =>
					matchesObjectFilter(c, filter, {
						state,
						controllerId: actor.playerId
					})
				);
				const max = Math.min(candidates.length, reqCount);
				const min = step.params?.upTo ? 0 : max;
				if (max <= 0) return;

				const sorted = [...candidates].sort(
					(a, b) => scoreCardForFaceDownPick(state, b) - scoreCardForFaceDownPick(state, a)
				);

				let chosenList: CardInstance[];
				if (!actor.isBot && host.canPause && (min < max || candidates.length > max)) {
					const handKey = `manifest_hand:${host.stepIndex}:${actorId}:${idx}`;
					const ans = host.answered(handKey, candidates, min, max);
					if (!ans) {
						const verbTitle = kind === 'cloak' ? 'Cloak' : 'Manifest';
						host.pauseForChoice(
							actor,
							`${host.title} — ${verbTitle} from hand`,
							`Choose ${min === max ? max : `up to ${max}`} card(s) from your hand to ${kind} face down.`,
							candidates.map((c) => c.instanceId),
							min,
							max,
							'hand',
							sorted.slice(0, min).map((c) => c.instanceId),
							handKey
						);
						return;
					}
					chosenList = ans;
				} else {
					chosenList = sorted.slice(0, max);
				}

				for (const cardInst of chosenList) {
					if (cardInst.zone !== 'hand') continue;
					const placed = manifestOrCloakCard(host, actor, cardInst, kind, tapped);
					if (placed) manifested.push(placed);
				}
			}
		);

		if (!paused && manifested.length > 0) {
			host.bind(step, manifested);
		}
		return;
	}

	const actor = resolveActors(host, step)[0] ?? host.you;
	if (!actor || actor.lost) return;
	const objs = host.objects(step.subject).filter((o) => !o.isToken && o.zone !== 'battlefield');
	for (const obj of objs) {
		const placed = manifestOrCloakCard(host, actor, obj, kind, tapped);
		if (placed) manifested.push(placed);
	}
	host.bind(step, manifested);
}

export function executeManifestDread(host: KeywordActionHost, step: EffectStep): void {
	const state = host.state;
	const repeat = Math.max(0, host.amount(step.amount, 1));
	if (repeat <= 0) return;
	const tapped = Boolean(step.params?.tapped);
	const manifestedAll: CardInstance[] = [];

	const { paused } = host.runIndexedBatch(
		`manifest_dread_batch:${host.stepIndex}`,
		() => {
			const entries: string[] = [];
			for (const actor of resolveActors(host, step)) {
				for (let r = 0; r < repeat; r++) {
					entries.push(`${actor.playerId}:${r}`);
				}
			}
			return entries;
		},
		(entry, iter) => {
			const colonIdx = entry.indexOf(':');
			const actorId = colonIdx >= 0 ? entry.slice(0, colonIdx) : entry;
			const actor = state.players.find((pl) => pl.playerId === actorId);
			if (!actor || actor.lost) return;

			const top = actor.library.slice(0, 2);
			if (top.length === 0) {
				// CR 701.62b: A player manifested dread even if some or all actions were impossible.
				emitEvent(state, {
					kind: 'ManifestDread',
					playerId: actor.playerId,
					graveyardObjectIds: []
				});
				flushTriggers(state);
				return;
			}

			let toManifest: CardInstance;
			let toGraveyard: CardInstance[];

			if (top.length === 1) {
				toManifest = top[0];
				toGraveyard = [];
			} else {
				const sorted = [...top].sort(
					(a, b) => scoreCardForFaceDownPick(state, b) - scoreCardForFaceDownPick(state, a)
				);
				if (!actor.isBot && host.canPause) {
					const pickKey = `dread_pick:${host.stepIndex}:${actorId}:${iter}`;
					const ans = host.answered(pickKey, top, 1, 1);
					if (!ans) {
						host.pauseForChoice(
							actor,
							`${host.title} — Manifest dread`,
							'Look at the top two cards of your library. Choose one to manifest face down; the other goes into your graveyard.',
							top.map((c) => c.instanceId),
							1,
							1,
							'library',
							[sorted[0].instanceId],
							pickKey
						);
						return;
					}
					toManifest = ans[0];
				} else {
					toManifest = sorted[0];
				}
				toGraveyard = top.filter((c) => c.instanceId !== toManifest.instanceId);
			}

			const placed = manifestOrCloakCard(host, actor, toManifest, 'manifest', tapped);
			if (placed) manifestedAll.push(placed);

			const gyIds: string[] = [];
			for (const restCard of toGraveyard) {
				if (restCard.zone !== 'library') continue;
				const owner =
					state.players.find((pl) => pl.playerId === restCard.ownerId) ?? actor;
				moveObject(state, restCard, 'graveyard', {
					from: { zone: 'library', player: actor },
					toPlayer: owner,
					graveyardReplacement: true,
					bumpVersion: true,
					newTimestamp: true
				});
				gyIds.push(restCard.instanceId);
			}

			emitEvent(state, {
				kind: 'ManifestDread',
				playerId: actor.playerId,
				...(placed ? { manifestedObject: placed } : {}),
				graveyardObjectIds: gyIds
			});
			flushTriggers(state);
		}
	);

	if (!paused && manifestedAll.length > 0) {
		host.bind(step, manifestedAll);
	}
}

// ---- 5. Monstrosity N (CR 701.37a–c) -------------------------------------------------------------

export function executeMonstrosity(host: KeywordActionHost, step: EffectStep): void {
	const state = host.state;
	const found = host.locate(host.sourceId);
	if (
		!found ||
		found.zone !== 'battlefield' ||
		found.inst.phasedOut ||
		(host.sourceObjectVersion !== undefined &&
			(found.inst.objectVersion ?? 1) !== host.sourceObjectVersion)
	) {
		return;
	}
	const perm = found.inst;
	// CR 701.37a: If this permanent is already monstrous, nothing happens.
	if (perm.isMonstrous) return;

	const n = Math.max(0, host.amount(step.amount, 0));
	if (n > 0) {
		host.ports.addCounters(state, perm, '+1/+1', n);
	}
	perm.isMonstrous = true;
	perm.monstrosityX = n;
	noteLayerInputsChanged(state);

	const label = perm.isFaceDown ? perm.faceDownLabel || 'Face-Down Permanent' : perm.card.name;
	host.ports.addLog(
		state,
		'rule',
		`${label} became monstrous (Monstrosity ${n}) (CR 701.37a).`,
		host.you.playerId
	);

	emitEvent(state, {
		kind: 'BecameMonstrous',
		objectId: perm.instanceId,
		object: perm,
		playerId: host.you.playerId,
		amount: n
	});
	flushTriggers(state);
	host.bind(step, [perm]);
}

// ---- 6. Bolster N (CR 701.39a) -------------------------------------------------------------------

export function executeBolster(host: KeywordActionHost, step: EffectStep): void {
	const state = host.state;
	const n = Math.max(0, host.amount(step.amount, 1));
	const bolstered: CardInstance[] = [];

	const { paused } = host.runIndexedBatch(
		`bolster_actors:${host.stepIndex}`,
		() => resolveActors(host, step).map((pl) => pl.playerId),
		(actorId, idx) => {
			const actor = state.players.find((pl) => pl.playerId === actorId);
			if (!actor || actor.lost) return;

			const creatures = actor.battlefield.filter(
				(perm) => !perm.phasedOut && evaluatePermanent(state, perm).isCreature
			);
			if (creatures.length === 0) return;

			let minToughness = Infinity;
			const evalMap = new Map<string, ReturnType<typeof evaluatePermanent>>();
			for (const c of creatures) {
				const ev = evaluatePermanent(state, c);
				evalMap.set(c.instanceId, ev);
				if (ev.toughness < minToughness) minToughness = ev.toughness;
			}
			const leastCandidates = creatures.filter(
				(c) => (evalMap.get(c.instanceId)?.toughness ?? Infinity) === minToughness
			);

			const sorted = [...leastCandidates].sort((a, b) => {
				const evA = evalMap.get(a.instanceId)!;
				const evB = evalMap.get(b.instanceId)!;
				if (evB.power !== evA.power) return evB.power - evA.power;
				if (a.tapped !== b.tapped) return a.tapped ? 1 : -1;
				return 0;
			});

			let chosen: CardInstance;
			if (leastCandidates.length === 1) {
				chosen = leastCandidates[0];
			} else if (!actor.isBot && host.canPause) {
				const pickKey = `bolster:${host.stepIndex}:${actorId}:${idx}`;
				const ans = host.answered(pickKey, leastCandidates, 1, 1);
				if (!ans) {
					host.pauseForChoice(
						actor,
						`${host.title} — Bolster ${n}`,
						`Choose a creature you control with the least toughness (${minToughness}) to put ${n} +1/+1 counter(s) on.`,
						leastCandidates.map((c) => c.instanceId),
						1,
						1,
						'battlefield',
						[sorted[0].instanceId],
						pickKey
					);
					return;
				}
				chosen = ans[0];
			} else {
				chosen = sorted[0];
			}

			if (n > 0) {
				host.ports.addCounters(state, chosen, '+1/+1', n);
			}
			bolstered.push(chosen);
			const chosenLabel = chosen.isFaceDown
				? chosen.faceDownLabel || 'Face-Down Creature'
				: chosen.card.name;
			host.ports.addLog(
				state,
				'rule',
				`${actor.username} bolstered ${n} onto ${chosenLabel} (CR 701.39a).`,
				actor.playerId
			);
			flushTriggers(state);
		}
	);

	if (!paused && bolstered.length > 0) {
		host.bind(step, bolstered);
	}
}

// ---- 8. Adapt N (CR 701.46a) ---------------------------------------------------------------------

export function executeAdapt(host: KeywordActionHost, step: EffectStep): void {
	const state = host.state;
	let targets: CardInstance[];
	if (step.subject.k === 'self') {
		const found = host.locate(host.sourceId);
		if (
			!found ||
			found.zone !== 'battlefield' ||
			found.inst.phasedOut ||
			(host.sourceObjectVersion !== undefined &&
				(found.inst.objectVersion ?? 1) !== host.sourceObjectVersion)
		) {
			return;
		}
		targets = [found.inst];
	} else {
		targets = host
			.objects(step.subject)
			.filter((inst) => inst.zone === 'battlefield' && !inst.phasedOut);
	}

	const n = Math.max(0, host.amount(step.amount, 0));
	const adapted: CardInstance[] = [];
	for (const perm of targets) {
		// CR 701.46a: If this permanent has no +1/+1 counters on it, put N +1/+1 counters on it.
		if ((perm.counters['+1/+1'] ?? 0) > 0) continue;
		if (n > 0) {
			host.ports.addCounters(state, perm, '+1/+1', n);
		}
		const label = perm.isFaceDown ? perm.faceDownLabel || 'Face-Down Permanent' : perm.card.name;
		host.ports.addLog(state, 'rule', `${label} adapted ${n} (CR 701.46a).`, host.you.playerId);
		flushTriggers(state);
		adapted.push(perm);
	}
	if (adapted.length > 0) {
		host.bind(step, adapted);
	}
}
