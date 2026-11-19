/**
 * Wave 10 combat, damage redirection/prevention shields, life floor, attack directives,
 * end-combat phase (CR 725.2), and fight/bite excess damage runtime primitives.
 *
 * Strictly below `effectsDamageAndMana.ts` in the runtime import DAG (imports types only from
 * `effectsDamageAndMana.ts`) so `copyPreventionAndEffects.ts`, `effectsDamageAndMana.ts`,
 * `combat.ts`, `effectsSteps.ts`, and `effectsWave10.ts` can all call into it with zero cycles.
 */
import type { Amount, EffectStep, ObjectFilter } from '../ir.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import type {
	CardInstance,
	CombatAttacker,
	DamagePreventionShieldEntry,
	GameState,
	ManaColor,
	PlayerGameState,
	ScryfallCard,
	TargetRef,
	ZoneType
} from '../types.ts';
import { H, addLog, hasKeyword } from './engineHost.ts';
import { instanceFaceOptions, resolveObjectFaces } from './faces.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import type { EffectRunAccess, SourceDamageInfo } from './effectsDamageAndMana.ts';

function addShield(state: GameState, entry: DamagePreventionShieldEntry): void {
	if (typeof entry.remaining === 'number' && entry.remaining <= 0) return;
	(state.damagePreventionShields ??= []).push(entry);
}

let wave10PreventReplyDepth = 0;

function findBattlefieldPerm(
	state: GameState,
	instanceId: string
): { perm: CardInstance; controllerId: string } | null {
	for (const p of state.players) {
		for (const perm of p.battlefield) {
			if (perm.instanceId === instanceId && !perm.phasedOut) {
				return { perm, controllerId: p.playerId };
			}
		}
	}
	return null;
}

function resolveDamageSourceMeta(
	state: GameState,
	sourceInst?: CardInstance,
	sourceId?: string,
	sourceCard?: ScryfallCard,
	sourceControllerId?: string
): {
	colors: ManaColor[];
	types: string[];
	subtypes: string[];
	controllerId?: string;
	isCreature: boolean;
} {
	if (sourceInst) {
		const live = findBattlefieldPerm(state, sourceInst.instanceId);
		if (live) {
			const ev = evaluatePermanent(state, live.perm);
			const words = ev.typeLine.split(/[\s—]+/).filter(Boolean);
			const view = resolveObjectFaces(effectiveCardForObject(live.perm), { zone: 'battlefield' });
			return {
				colors: ev.colors,
				types: words,
				subtypes: view.subtypes,
				controllerId: live.controllerId,
				isCreature: ev.isCreature
			};
		}
		const view = resolveObjectFaces(effectiveCardForObject(sourceInst), { zone: sourceInst.zone });
		return {
			colors: view.colors,
			types: view.types,
			subtypes: view.subtypes,
			controllerId: sourceControllerId ?? sourceInst.controllerId,
			isCreature: view.types.includes('Creature')
		};
	}
	const stackItem = sourceId
		? state.stack.find((it) => it.id === sourceId || it.sourceInstanceId === sourceId)
		: undefined;
	const effCard = sourceCard ?? stackItem?.card;
	const ctrl = sourceControllerId ?? stackItem?.controllerId;
	if (effCard) {
		const view = resolveObjectFaces(effCard, {});
		return {
			colors: view.colors,
			types: view.types,
			subtypes: view.subtypes,
			controllerId: ctrl,
			isCreature: view.types.includes('Creature')
		};
	}
	return {
		colors: [],
		types: [],
		subtypes: [],
		controllerId: ctrl,
		isCreature: false
	};
}

/**
 * Checks Wave 10 source qualifiers on a `DamagePreventionShieldEntry`.
 * Returns `false` if the shield does not match the damage source.
 */
export function shieldMatchesWave10Source(
	state: GameState,
	shield: DamagePreventionShieldEntry,
	opts: {
		sourceInst?: CardInstance;
		sourceId?: string;
		sourceCard?: ScryfallCard;
		sourceControllerId?: string;
	}
): boolean {
	if (
		!shield.fromNotControlledBy &&
		!shield.fromSourceColors?.length &&
		!shield.fromSourceNotSubtypes?.length
	) {
		return true;
	}
	const meta = resolveDamageSourceMeta(
		state,
		opts.sourceInst,
		opts.sourceId,
		opts.sourceCard,
		opts.sourceControllerId
	);
	if (shield.fromNotControlledBy && meta.controllerId === shield.fromNotControlledBy) {
		return false;
	}
	if (
		shield.fromSourceColors &&
		shield.fromSourceColors.length > 0 &&
		!shield.fromSourceColors.some((c) => meta.colors.includes(c))
	) {
		return false;
	}
	if (shield.fromSourceNotSubtypes && shield.fromSourceNotSubtypes.length > 0) {
		const live = opts.sourceInst ? findBattlefieldPerm(state, opts.sourceInst.instanceId) : null;
		const ev = live ? evaluatePermanent(state, live.perm) : null;
		for (const sub of shield.fromSourceNotSubtypes) {
			const hasSub = ev ? ev.hasSubType(sub) : meta.subtypes.includes(sub);
			if (hasSub) return false;
		}
	}
	return true;
}

function shieldProtectsTargetForRedirect(
	state: GameState,
	shield: DamagePreventionShieldEntry,
	targetKind: 'permanent' | 'player',
	targetId: string,
	targetPerm: CardInstance | undefined,
	targetControllerId: string | undefined
): boolean {
	switch (shield.targetKind) {
		case 'any':
			return true;
		case 'player':
			return targetKind === 'player' && shield.targetId === targetId;
		case 'permanent':
			return (
				targetKind === 'permanent' &&
				shield.targetId === targetId &&
				Boolean(targetPerm) &&
				(shield.targetObjectVersion === undefined ||
					(targetPerm!.objectVersion ?? 1) === shield.targetObjectVersion)
			);
		case 'permanentsControlledBy': {
			if (targetKind !== 'permanent' || !targetPerm) return false;
			if (targetControllerId !== shield.targetId) return false;
			if (shield.targetTypes?.length) {
				const ev = evaluatePermanent(state, targetPerm);
				const words = ev.typeLine.split(/[\s—]+/);
				if (!shield.targetTypes.some((t) => words.includes(t))) return false;
			}
			return true;
		}
		case 'playerAndPermanentsControlledBy': {
			if (targetKind === 'player') return targetId === shield.targetId;
			if (!targetPerm || targetControllerId !== shield.targetId) return false;
			if (shield.targetTypes?.length) {
				const ev = evaluatePermanent(state, targetPerm);
				const words = ev.typeLine.split(/[\s—]+/);
				if (!shield.targetTypes.some((t) => words.includes(t))) return false;
			}
			return true;
		}
	}
}

function shieldMatchesSourceForRedirect(
	state: GameState,
	shield: DamagePreventionShieldEntry,
	opts: {
		sourceInst?: CardInstance;
		sourceId?: string;
		sourceCard?: ScryfallCard;
		sourceControllerId?: string;
		sourceTypes?: readonly string[];
	}
): boolean {
	if (shield.fromSourceStackItemId !== undefined) {
		const actualId = opts.sourceInst?.instanceId ?? opts.sourceId;
		if (
			!actualId ||
			(actualId !== shield.fromSourceStackItemId && actualId !== shield.fromSourceInstanceId)
		) {
			return false;
		}
	} else if (shield.fromSourceInstanceId !== undefined) {
		const actualId = opts.sourceInst?.instanceId ?? opts.sourceId;
		if (!actualId || actualId !== shield.fromSourceInstanceId) return false;
		if (shield.fromSourceObjectVersion !== undefined) {
			const live = findBattlefieldPerm(state, actualId);
			if (live) {
				if ((live.perm.objectVersion ?? 1) !== shield.fromSourceObjectVersion) return false;
			} else if (opts.sourceInst && (opts.sourceInst.objectVersion ?? 1) !== shield.fromSourceObjectVersion) {
				return false;
			}
		}
	}
	if (shield.fromAttackingOnly) {
		const actualId = opts.sourceInst?.instanceId ?? opts.sourceId;
		if (!actualId || !state.combat.active) return false;
		if (!state.combat.attackers.some((a) => a.attackerInstanceId === actualId)) return false;
	}
	if (shield.fromSourceTypes?.length) {
		const meta = resolveDamageSourceMeta(
			state,
			opts.sourceInst,
			opts.sourceId,
			opts.sourceCard,
			opts.sourceControllerId
		);
		const types = meta.types.length > 0 ? meta.types : [...(opts.sourceTypes ?? [])];
		if (!shield.fromSourceTypes.some((t) => types.includes(t))) return false;
	}
	return shieldMatchesWave10Source(state, shield, opts);
}

/**
 * CR 614.9: Resolves dynamic redirection shields (*Mirror Strike*, *Reflect Damage*, *Gideon's Sacrifice*).
 * Each shield applies at most once per damage event via `redirectedByIds` (CR 614.5).
 */
export function resolveWave10DamageRedirection(
	state: GameState,
	opts: {
		isCombat: boolean;
		targetKind: 'permanent' | 'player';
		targetId: string;
		targetPerm?: CardInstance;
		targetControllerId?: string;
		sourceInst?: CardInstance;
		sourceId?: string;
		sourceCard?: ScryfallCard;
		sourceControllerId?: string;
		sourceTypes?: readonly string[];
		redirectedByIds: Set<string>;
	}
):
	| { kind: 'permanent'; perm: CardInstance }
	| { kind: 'player'; player: PlayerGameState }
	| null {
	const shields = state.damagePreventionShields;
	if (!shields || shields.length === 0) return null;

	for (let i = 0; i < shields.length; i++) {
		const shield = shields[i];
		if (!shield.redirectTo || opts.redirectedByIds.has(shield.id)) continue;
		if (shield.combatOnly && !opts.isCombat) continue;
		if (
			!shieldProtectsTargetForRedirect(
				state,
				shield,
				opts.targetKind,
				opts.targetId,
				opts.targetPerm,
				opts.targetControllerId
			)
		) {
			continue;
		}
		if (!shieldMatchesSourceForRedirect(state, shield, opts)) continue;

		if (shield.redirectTo === 'chosenPermanent') {
			if (!shield.redirectTargetId) continue;
			if (opts.targetKind === 'permanent' && opts.targetId === shield.redirectTargetId) continue;
			const dest = findBattlefieldPerm(state, shield.redirectTargetId);
			if (
				!dest ||
				(shield.redirectTargetVersion !== undefined &&
					(dest.perm.objectVersion ?? 1) !== shield.redirectTargetVersion)
			) {
				continue;
			}
			opts.redirectedByIds.add(shield.id);
			if (shield.nextEventOnly) {
				state.damagePreventionShields = shields.filter((_, idx) => idx !== i);
			}
			return { kind: 'permanent', perm: dest.perm };
		}

		if (shield.redirectTo === 'sourceController') {
			const meta = resolveDamageSourceMeta(
				state,
				opts.sourceInst,
				opts.sourceId,
				opts.sourceCard,
				opts.sourceControllerId
			);
			const ctrl = meta.controllerId
				? state.players.find((p) => p.playerId === meta.controllerId && !p.lost)
				: undefined;
			if (!ctrl) continue;
			opts.redirectedByIds.add(shield.id);
			if (shield.nextEventOnly) {
				state.damagePreventionShields = shields.filter((_, idx) => idx !== i);
			}
			return { kind: 'player', player: ctrl };
		}
	}
	return null;
}

/**
 * Replacement floor (*Angel's Grace*: "damage that would reduce your life total to less than 1
 * reduces it to 1 instead"). Applies even if damage can't be prevented (CR 614 vs 615).
 */
export function applyWave10LifeFloor(state: GameState, pl: PlayerGameState, dmg: number): number {
	if (dmg <= 0 || !state.damagePreventionShields?.length) return dmg;
	let floor: number | undefined;
	for (const shield of state.damagePreventionShields) {
		if (shield.minLifeFloor === undefined) continue;
		if (shield.targetKind === 'player' && shield.targetId === pl.playerId) {
			floor = floor === undefined ? shield.minLifeFloor : Math.max(floor, shield.minLifeFloor);
		} else if (shield.targetKind === 'any') {
			floor = floor === undefined ? shield.minLifeFloor : Math.max(floor, shield.minLifeFloor);
		}
	}
	if (floor === undefined) return dmg;
	if (pl.life >= floor && pl.life - dmg < floor) {
		return Math.max(0, pl.life - floor);
	}
	return dmg;
}

/**
 * Executes Wave 10 prevented-damage side riders (*Comeuppance*, *Deflecting Palm*, *Honorable Passage*).
 */
export function handleDamagePreventedWave10(
	state: GameState,
	shield: DamagePreventionShieldEntry,
	preventedAmount: number,
	opts: {
		sourceId?: string;
		sourceInst?: CardInstance;
		sourceCard?: ScryfallCard;
		sourceControllerId?: string;
	},
	callbacks: {
		dealDamageToPermanent: (
			state: GameState,
			target: CardInstance,
			amount: number,
			sourceId: string,
			srcInfo: SourceDamageInfo
		) => number;
		dealDamageToPlayer: (
			state: GameState,
			target: PlayerGameState,
			amount: number,
			sourceId: string,
			srcInfo: SourceDamageInfo
		) => number;
		addLog: (state: GameState, kind: 'rule' | 'cast' | 'trigger' | 'life' | 'combat', text: string, actorId?: string) => void;
	}
): void {
	if (preventedAmount <= 0 || wave10PreventReplyDepth >= 8) return;
	const hasWave10Rider =
		Boolean(shield.onPreventedCreature) ||
		Boolean(shield.onPreventedNoncreature) ||
		Boolean(shield.onPreventedToDamageSourceController);
	if (!hasWave10Rider) return;

	const meta = resolveDamageSourceMeta(
		state,
		opts.sourceInst,
		opts.sourceId,
		opts.sourceCard,
		opts.sourceControllerId
	);
	const srcView = shield.sourceCard ? resolveObjectFaces(shield.sourceCard, {}) : null;
	const replySrcId = shield.sourceInstanceId ?? shield.id;
	const replySrcInfo: SourceDamageInfo = {
		colors: srcView?.colors ?? [],
		types: srcView?.types ?? ['Instant'],
		hasDeathtouch: false,
		hasLifelink: false,
		hasWither: false,
		hasInfect: false,
		...(shield.sourceCard ? { sourceCard: shield.sourceCard } : {}),
		sourceControllerId: shield.controllerId
	};

	wave10PreventReplyDepth++;
	try {
		if (shield.onPreventedToDamageSourceController) {
			if (
				shield.redirectSourceColorFilter &&
				shield.redirectSourceColorFilter.length > 0 &&
				!shield.redirectSourceColorFilter.some((c) => meta.colors.includes(c))
			) {
				return;
			}
			const ctrl = meta.controllerId
				? state.players.find((p) => p.playerId === meta.controllerId && !p.lost)
				: undefined;
			if (ctrl) {
				callbacks.dealDamageToPlayer(state, ctrl, preventedAmount, replySrcId, replySrcInfo);
				callbacks.addLog(
					state,
					'rule',
					`${shield.sourceName} dealt ${preventedAmount} damage to ${ctrl.username}.`,
					shield.controllerId
				);
			}
			return;
		}

		if (meta.isCreature && shield.onPreventedCreature) {
			if (shield.onPreventedCreature.to === 'sourceCreature') {
				const srcId = opts.sourceInst?.instanceId ?? opts.sourceId;
				const live = srcId ? findBattlefieldPerm(state, srcId) : null;
				if (live) {
					callbacks.dealDamageToPermanent(state, live.perm, preventedAmount, replySrcId, replySrcInfo);
					callbacks.addLog(
						state,
						'rule',
						`${shield.sourceName} dealt ${preventedAmount} damage to ${live.perm.card.name}.`,
						shield.controllerId
					);
				}
			} else {
				const ctrl = meta.controllerId
					? state.players.find((p) => p.playerId === meta.controllerId && !p.lost)
					: undefined;
				if (ctrl) {
					callbacks.dealDamageToPlayer(state, ctrl, preventedAmount, replySrcId, replySrcInfo);
				}
			}
			return;
		}

		if (!meta.isCreature && shield.onPreventedNoncreature) {
			const ctrl = meta.controllerId
				? state.players.find((p) => p.playerId === meta.controllerId && !p.lost)
				: undefined;
			if (ctrl) {
				callbacks.dealDamageToPlayer(state, ctrl, preventedAmount, replySrcId, replySrcInfo);
				callbacks.addLog(
					state,
					'rule',
					`${shield.sourceName} dealt ${preventedAmount} damage to ${ctrl.username}.`,
					shield.controllerId
				);
			}
		}
	} finally {
		wave10PreventReplyDepth--;
	}
}

export function needsPreventWave10(step: EffectStep): boolean {
	const spec = step.params?.preventSpec;
	if (!spec) return false;
	return Boolean(
		spec.redirectTo ||
			spec.minLifeFloor !== undefined ||
			spec.allDamageToYouAndPerms ||
			spec.youAndPlaneswalkersYouControl ||
			spec.fromSourcesYouDontControl ||
			spec.fromSourceColors?.length ||
			spec.fromSourceNotSubtypes?.length ||
			spec.onPreventedCreature ||
			spec.onPreventedNoncreature ||
			spec.onPreventedToDamageSourceController ||
			(spec.fromSource?.k === 'all' && spec.fromSource.filter.notSubtypes?.length)
	);
}

/**
 * Executes Wave 10 `preventDamage` and damage redirection steps (*Comeuppance*, *Deflecting Palm*,
 * *Honorable Passage*, *Mirror Strike*, *Reflect Damage*, *Angel's Grace*, *Gideon's Sacrifice*,
 * *Surge of Salvation*, *Arachnogenesis*, *Galadhrim Ambush*).
 */
export function executePreventWave10(
	run: EffectRunAccess,
	step: EffectStep,
	uid: (prefix: string, state: GameState) => string
): boolean {
	const spec = step.params?.preventSpec;
	if (!spec || !needsPreventWave10(step)) return false;

	const s = run.state;
	const you = run.you;
	const remaining: number | 'infinite' =
		spec.mode === 'all' ? 'infinite' : Math.max(0, run.amount(step.amount, 1));
	if (remaining !== 'infinite' && remaining <= 0) return true;

	let fromSourceInstanceId: string | undefined;
	let fromSourceObjectVersion: number | undefined;
	let fromSourceStackItemId: string | undefined;
	let fromSourceTypes: string[] | undefined;
	let fromSourceNotSubtypes: string[] | undefined = spec.fromSourceNotSubtypes
		? [...spec.fromSourceNotSubtypes]
		: undefined;
	let fromAttackingOnly: boolean | undefined;

	if (spec.chooseSource) {
		const srcKey = `w10_prevent_src:${run.stepIndex}`;
		const bfCandidates = s.players.flatMap((pl) => pl.battlefield.filter((c) => !c.phasedOut));
		const stackCandidates = s.stack.filter((it) => it.id !== run.ctx.item.id);
		const candidateIds = [
			...bfCandidates.map((c) => c.instanceId),
			...stackCandidates.map((it) => it.id)
		];
		if (candidateIds.length === 0) return true;

		let pickedId: string | undefined;
		const savedSrc = run.answers[srcKey];
		if (savedSrc?.kind === 'chooseObjects' && savedSrc.objectIds[0]) {
			pickedId = savedSrc.objectIds[0];
		} else if (!you.isBot && run.canPause) {
			run.pauseForChoice(
				you,
				`${run.ctx.title} — Choose Damage Source`,
				'Choose a source of your choice.',
				candidateIds,
				1,
				1,
				bfCandidates.length > 0 ? 'battlefield' : 'stack',
				[candidateIds[0]!],
				srcKey
			);
			return true;
		} else {
			const oppStack = stackCandidates.find((it) => it.controllerId !== you.playerId);
			const oppBf = bfCandidates
				.filter((c) => c.controllerId !== you.playerId)
				.sort(
					(a, b) =>
						(evaluatePermanent(s, b).power || 0) - (evaluatePermanent(s, a).power || 0)
				)[0];
			pickedId = oppStack?.id ?? oppBf?.instanceId ?? candidateIds[0]!;
			run.answers[srcKey] = { kind: 'chooseObjects', objectIds: [pickedId] };
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
			if (spec.fromSource.filter.notSubtypes?.length) {
				fromSourceNotSubtypes = [
					...(fromSourceNotSubtypes ?? []),
					...spec.fromSource.filter.notSubtypes
				];
			}
			if (spec.fromSource.filter.attacking) {
				fromAttackingOnly = true;
			}
		} else {
			const srcObj = run.objects(spec.fromSource)[0];
			if (!srcObj) return true;
			fromSourceInstanceId = srcObj.instanceId;
			if (srcObj.zone === 'battlefield') {
				fromSourceObjectVersion = srcObj.objectVersion ?? 1;
			}
		}
	}

	let redirectTargetId: string | undefined;
	let redirectTargetVersion: number | undefined;
	if (spec.redirectTo === 'chosenPermanent') {
		const redKey = `w10_redirect_perm:${run.stepIndex}`;
		const candidates = you.battlefield.filter((c) => {
			if (c.phasedOut) return false;
			const ev = evaluatePermanent(s, c);
			return ev.isCreature || ev.isPlaneswalker;
		});
		if (candidates.length === 0) return true;
		let chosen: CardInstance | undefined;
		const saved = run.answers[redKey];
		if (saved?.kind === 'chooseObjects' && saved.objectIds[0]) {
			chosen = candidates.find((c) => c.instanceId === saved.objectIds[0]) ?? candidates[0];
		} else if (!you.isBot && run.canPause && candidates.length > 1) {
			run.pauseForChoice(
				you,
				`${run.ctx.title} — Choose Creature or Planeswalker`,
				'Choose a creature or planeswalker you control to receive redirected damage.',
				candidates.map((c) => c.instanceId),
				1,
				1,
				'battlefield',
				[candidates[0]!.instanceId],
				redKey
			);
			return true;
		} else {
			chosen = [...candidates].sort(
				(a, b) => evaluatePermanent(s, b).toughness - evaluatePermanent(s, a).toughness
			)[0];
		}
		if (!chosen) return true;
		redirectTargetId = chosen.instanceId;
		redirectTargetVersion = chosen.objectVersion ?? 1;
	}

	const baseFields = {
		controllerId: you.playerId,
		sourceName: run.ctx.sourceCard.name || run.ctx.title,
		sourceInstanceId: run.ctx.sourceId,
		sourceCard: run.ctx.sourceCard,
		combatOnly: spec.combatOnly,
		remaining,
		...(fromSourceInstanceId !== undefined ? { fromSourceInstanceId } : {}),
		...(fromSourceObjectVersion !== undefined ? { fromSourceObjectVersion } : {}),
		...(fromSourceStackItemId !== undefined ? { fromSourceStackItemId } : {}),
		...(fromSourceTypes ? { fromSourceTypes } : {}),
		...(fromSourceNotSubtypes?.length ? { fromSourceNotSubtypes } : {}),
		...(fromAttackingOnly ? { fromAttackingOnly: true } : {}),
		...(spec.nextDamageEventOnly ? { nextEventOnly: true } : {}),
		...(spec.redirectTo ? { redirectTo: spec.redirectTo } : {}),
		...(redirectTargetId ? { redirectTargetId } : {}),
		...(redirectTargetVersion !== undefined ? { redirectTargetVersion } : {}),
		...(spec.redirectSourceColorFilter?.length
			? { redirectSourceColorFilter: [...spec.redirectSourceColorFilter] }
			: {}),
		...(spec.redirectSourceKind ? { redirectSourceKind: spec.redirectSourceKind } : {}),
		...(spec.minLifeFloor !== undefined ? { minLifeFloor: spec.minLifeFloor } : {}),
		...(spec.fromSourcesYouDontControl ? { fromNotControlledBy: you.playerId } : {}),
		...(spec.fromSourceColors?.length ? { fromSourceColors: [...spec.fromSourceColors] } : {}),
		...(spec.onPreventedToDamageSourceController
			? { onPreventedToDamageSourceController: true }
			: {}),
		...(spec.onPreventedCreature ? { onPreventedCreature: { ...spec.onPreventedCreature } } : {}),
		...(spec.onPreventedNoncreature ? { onPreventedNoncreature: { ...spec.onPreventedNoncreature } } : {})
	};

	if (spec.allDamageToYouAndPerms) {
		addShield(s, {
			...baseFields,
			id: uid('pshield', s),
			targetKind: 'playerAndPermanentsControlledBy',
			targetId: you.playerId
		});
		return true;
	}

	if (spec.youAndPlaneswalkersYouControl) {
		addShield(s, {
			...baseFields,
			id: uid('pshield', s),
			targetKind: 'playerAndPermanentsControlledBy',
			targetId: you.playerId,
			targetTypes: ['Planeswalker']
		});
		return true;
	}

	if (spec.scope === 'youAndCreaturesYouControl') {
		addShield(s, {
			...baseFields,
			id: uid('pshield', s),
			targetKind: 'playerAndPermanentsControlledBy',
			targetId: you.playerId,
			targetTypes: ['Creature']
		});
		return true;
	}

	if (spec.scope === 'any') {
		addShield(s, {
			...baseFields,
			id: uid('pshield', s),
			targetKind: 'any'
		});
		return true;
	}

	const sel = step.subject;
	if (sel.k === 'target') {
		const refs = run.targetsForSpecIndex(sel.index);
		for (const t of refs) {
			if (t.kind === 'player') {
				addShield(s, {
					...baseFields,
					id: uid('pshield', s),
					targetKind: 'player',
					targetId: t.id
				});
			} else if (t.kind === 'permanent') {
				const perm = run.locate(t.id)?.inst;
				if (perm && perm.zone === 'battlefield' && !perm.phasedOut) {
					addShield(s, {
						...baseFields,
						id: uid('pshield', s),
						targetKind: 'permanent',
						targetId: perm.instanceId,
						targetObjectVersion: perm.objectVersion ?? 1
					});
				}
			}
		}
		return true;
	}

	if (sel.k === 'player' || sel.k === 'playerRef') {
		for (const pl of run.players(sel)) {
			addShield(s, {
				...baseFields,
				id: uid('pshield', s),
				targetKind: 'player',
				targetId: pl.playerId
			});
		}
		return true;
	}

	const objs = run.objects(sel).filter((o) => o.zone === 'battlefield' && !o.phasedOut);
	for (const o of objs) {
		addShield(s, {
			...baseFields,
			id: uid('pshield', s),
			targetKind: 'permanent',
			targetId: o.instanceId,
			targetObjectVersion: o.objectVersion ?? 1
		});
	}
	return true;
}

/**
 * CR 508.7: Reselects which player or permanent target attacking creature is attacking (*Misleading Signpost*).
 */
export function executeReselectAttackTargetWave10(run: EffectRunAccess, step: EffectStep): void {
	const s = run.state;
	if (!s.combat.active || s.combat.attackers.length === 0) return;
	const targetPerm = run.objects(step.subject)[0];
	if (!targetPerm) return;
	const atk = s.combat.attackers.find((a) => a.attackerInstanceId === targetPerm.instanceId);
	if (!atk) return;

	const options: Array<{ label: string; defenderPlayerId: string; defenderPlaneswalkerId?: string }> = [];
	for (const pl of s.players) {
		if (pl.lost || pl.playerId === atk.controllerId) continue;
		options.push({
			label: `Attack ${pl.username}`,
			defenderPlayerId: pl.playerId
		});
		for (const perm of pl.battlefield) {
			if (perm.phasedOut) continue;
			const ev = evaluatePermanent(s, perm);
			const isBattle = ev.typeLine.split(/[\s—]+/).includes('Battle');
			if (ev.isPlaneswalker || isBattle) {
				options.push({
					label: `Attack ${perm.card.name} (${pl.username})`,
					defenderPlayerId: pl.playerId,
					defenderPlaneswalkerId: perm.instanceId
				});
			}
		}
	}
	if (options.length === 0) return;

	let chosenIdx = 0;
	if (!run.you.isBot && run.canPause && options.length > 1) {
		const ans = run.p13AskFn()(
			run.you,
			`w10_reselect:${run.stepIndex}`,
			{
				kind: 'chooseMode',
				modes: options.map((o) => o.label),
				min: 1,
				max: 1,
				defaultIndices: [0]
			},
			`${run.ctx.title} — Reselect Attack Target`,
			`Choose which player or permanent ${targetPerm.card.name} is attacking.`
		);
		if (run.result.paused || !ans || ans === 'PAUSED' || ans.kind !== 'chooseMode') return;
		chosenIdx = ans.indices[0] ?? 0;
	} else {
		// Bot heuristic: redirect attacker away from `you` toward another opponent (highest life)
		const nonYouIdx = options.findIndex(
			(o) => !o.defenderPlaneswalkerId && o.defenderPlayerId !== run.you.playerId
		);
		chosenIdx = nonYouIdx >= 0 ? nonYouIdx : 0;
	}
	const picked = options[chosenIdx] ?? options[0]!;
	atk.defenderPlayerId = picked.defenderPlayerId;
	if (picked.defenderPlaneswalkerId) {
		atk.defenderPlaneswalkerId = picked.defenderPlaneswalkerId;
	} else {
		delete atk.defenderPlaneswalkerId;
	}
	noteLayerInputsChanged(s);
	addLog(
		s,
		'rule',
		`${targetPerm.card.name} is now ${picked.label.replace(/^Attack /, 'attacking ')}.`,
		run.you.playerId
	);
}

const COMBAT_PHASES = new Set<string>([
	'begin_combat',
	'declare_attackers',
	'declare_blockers',
	'first_strike_damage',
	'combat_damage',
	'end_combat'
]);

let registeredEndCombatHooksW10: {
	expireEndOfCombat: (state: GameState) => void;
	advanceFromEndedCombat: (state: GameState, activePlayer: PlayerGameState) => void;
} | null = null;

export function registerEndCombatHooksWave10(hooks: {
	expireEndOfCombat: (state: GameState) => void;
	advanceFromEndedCombat: (state: GameState, activePlayer: PlayerGameState) => void;
}): void {
	registeredEndCombatHooksW10 = hooks;
}

/**
 * CR 725.2: Ends the combat phase immediately (*Mandate of Peace*).
 * Does nothing outside a combat phase (CR 725.2g).
 */
export function executeEndCombatPhaseWave10(
	run: EffectRunAccess,
	hooks?: {
		expireEndOfCombat: (state: GameState) => void;
		advanceFromEndedCombat: (state: GameState, activePlayer: PlayerGameState) => void;
	}
): void {
	const resolvedHooks = hooks ?? registeredEndCombatHooksW10;
	if (!resolvedHooks) return;
	const s = run.state;
	if (!COMBAT_PHASES.has(s.phase)) return;

	// CR 725.2a: Un-stacked waiting triggers cease to exist.
	s.pendingTriggers = [];

	// CR 725.2b: Exile every object on the stack, including the resolving object.
	const exiledCount = s.stack.length;
	while (s.stack.length > 0) {
		const stk = s.stack.pop()!;
		H().moveStackSpellToZone(s, stk, 'exile');
	}
	run.result.turnEnded = true;

	// CR 725.2d: Remove all creatures and planeswalkers from combat & expire untilEndOfCombat effects.
	s.combat.active = false;
	s.combat.attackers = [];
	delete s.combat.bands;
	s.combat.declaredBlockersPlayerIds = [];
	s.combat.blockersDeclared = false;
	s.combat.dealtFirstStrikeDamageIds = [];
	resolvedHooks.expireEndOfCombat(s);
	noteLayerInputsChanged(s);

	addLog(
		s,
		'rule',
		`Combat phase ended immediately (CR 725.2); exiled ${exiledCount} item(s) from the stack.`,
		run.you.playerId
	);

	// CR 725.2c: Check SBAs, then skip to postcombat main phase (or additional combat phase).
	H().checkStateBasedActions(s);
	const activePlayer = s.players[s.activePlayerIndex];
	if (activePlayer) {
		resolvedHooks.advanceFromEndedCombat(s, activePlayer);
	}
}

/**
 * Computes lethal threshold on a creature/planeswalker BEFORE damage is marked (CR 120.10).
 */
export function computeLethalThresholdBefore(
	state: GameState,
	target: CardInstance,
	hasDeathtouch: boolean
): number {
	const ev = evaluatePermanent(state, target);
	if (ev.isPlaneswalker) return Math.max(0, target.counters.loyalty || 0);
	if (!ev.isCreature) return 0;
	if (hasDeathtouch) return target.deathtouchDamageMarked ? 0 : 1;
	return Math.max(0, ev.toughness - target.damageMarked);
}

/**
 * Returns effective goader player IDs from active Wave 10 until-your-next-turn directives (*Kardur, Doomscourge*).
 */
export function getWave10EffectiveGoaderIds(state: GameState, perm: CardInstance): string[] {
	const dirs = state.untilYourNextTurnCombatDirectives;
	if (!dirs || dirs.length === 0) return [];
	const out: string[] = [];
	for (const d of dirs) {
		if (d.mustAttack && d.avoidYou && perm.controllerId !== d.sourcePlayerId) {
			if (!out.includes(d.sourcePlayerId)) out.push(d.sourcePlayerId);
		}
	}
	return out;
}

/**
 * True if Wave 10 combat directives require `perm` to attack (*The Akroan War* II, *Trench Behemoth*).
 */
export function hasWave10MustAttackDirective(state: GameState, perm: CardInstance): boolean {
	if (perm.mustAttackNextCombat || perm.mustAttackPlayerIdThisTurn) return true;
	if (state.gambitActiveCombatDirective?.attackerIds.includes(perm.instanceId)) return true;
	const dirs = state.untilYourNextTurnCombatDirectives;
	if (!dirs || dirs.length === 0) return false;
	return dirs.some((d) => d.mustAttack && perm.controllerId !== d.sourcePlayerId);
}

/**
 * Checks *Promise of Loyalty* vow-counter attack restrictions and active Gambit combat directive.
 */
export function getWave10AttackRestrictionReason(
	state: GameState,
	attacker: CardInstance,
	defenderPlayerId: string
): string | null {
	if (
		state.gambitActiveCombatDirective?.attackerIds.includes(attacker.instanceId) &&
		defenderPlayerId === state.gambitActiveCombatDirective.casterPlayerId
	) {
		return `${attacker.card.name} can't attack that player or planeswalkers they control this combat.`;
	}
	const list = attacker.cantAttackPlayerWhileCounter;
	if (!list || list.length === 0) return null;
	for (const entry of list) {
		if (
			entry.playerId === defenderPlayerId &&
			((attacker.counters as Record<string, number>)[entry.counter] ?? 0) > 0
		) {
			return `${attacker.card.name} can't attack that player or planeswalkers they control while it has a ${entry.counter} counter on it.`;
		}
	}
	return null;
}

/**
 * Validates that attackers with `mustAttackPlayerIdThisTurn` attack that player if able (*Ruhan*, *Territorial Hellkite*).
 */
export function validateWave10AttackerAssignments(
	state: GameState,
	actor: PlayerGameState,
	assignments: ReadonlyArray<{
		attackerInstanceId: string;
		defenderPlayerId: string;
		defenderPlaneswalkerId?: string | null;
	}>,
	canLegallyAttackPlayer: (perm: CardInstance, defenderPlayerId: string) => boolean
): string | null {
	for (const a of assignments) {
		const perm = actor.battlefield.find((c) => c.instanceId === a.attackerInstanceId);
		if (!perm?.mustAttackPlayerIdThisTurn) continue;
		const reqPid = perm.mustAttackPlayerIdThisTurn;
		const reqPlayer = state.players.find((p) => p.playerId === reqPid && !p.lost);
		if (!reqPlayer) continue;
		if (
			(a.defenderPlayerId !== reqPid || Boolean(a.defenderPlaneswalkerId)) &&
			canLegallyAttackPlayer(perm, reqPid)
		) {
			return `Strict Rules Violation: ${perm.card.name} must attack ${reqPlayer.username} this combat if able.`;
		}
	}
	return null;
}

export function recordCombatAttackersWave10(
	state: GameState,
	attackers: ReadonlyArray<CombatAttacker>
): void {
	for (const atk of attackers) {
		const owner = state.players.find((p) => p.playerId === atk.controllerId);
		const perm = owner?.battlefield.find((c) => c.instanceId === atk.attackerInstanceId);
		if (!perm) continue;
		const list = (perm.attackedLastCombatPlayerIds ??= []);
		if (!list.includes(atk.defenderPlayerId)) {
			list.push(atk.defenderPlayerId);
		}
	}
}

export function recordCombatDamageToPlayerWave10(
	state: GameState,
	attackerPerm: CardInstance | undefined,
	defenderPlayer: PlayerGameState,
	dealtAmount: number
): void {
	if (dealtAmount <= 0 || !attackerPerm) return;
	const ev = evaluatePermanent(state, attackerPerm);
	const lowName = ev.effectiveName.toLowerCase();
	if (lowName) {
		const names = (defenderPlayer.combatDamageDealtByCardNamesThisGame ??= []);
		if (!names.includes(lowName)) names.push(lowName);
	}
	const srcIds = (defenderPlayer.combatDamageDealtBySourceIdsThisTurn ??= []);
	if (!srcIds.includes(attackerPerm.instanceId)) srcIds.push(attackerPerm.instanceId);
	const view = resolveObjectFaces(effectiveCardForObject(attackerPerm), { zone: 'battlefield' });
	const subs = (defenderPlayer.combatDamageDealtBySubtypesThisTurn ??= []);
	for (const sub of view.subtypes) {
		if (!subs.includes(sub)) subs.push(sub);
	}
}

export function clearWave10YourNextTurnDirectives(state: GameState, activePlayerId: string): void {
	if (state.untilYourNextTurnCombatDirectives?.length) {
		state.untilYourNextTurnCombatDirectives = state.untilYourNextTurnCombatDirectives.filter(
			(d) => d.sourcePlayerId !== activePlayerId
		);
		if (state.untilYourNextTurnCombatDirectives.length === 0) {
			delete state.untilYourNextTurnCombatDirectives;
		}
	}
	for (const pl of state.players) {
		for (const perm of pl.battlefield) {
			if (perm.controllerId === activePlayerId && perm.mustAttackNextCombat) {
				delete perm.mustAttackNextCombat;
			}
		}
	}
}

export function clearWave10TurnEndState(state: GameState): void {
	for (const pl of state.players) {
		delete pl.combatDamageDealtBySourceIdsThisTurn;
		delete pl.combatDamageDealtBySubtypesThisTurn;
		for (const perm of pl.battlefield) {
			delete perm.mustAttackPlayerIdThisTurn;
		}
	}
}

function compareOpW10(val: number, op: '>=' | '<=' | '=' | '>' | '<', rhs: number): boolean {
	switch (op) {
		case '>=':
			return val >= rhs;
		case '<=':
			return val <= rhs;
		case '=':
			return val === rhs;
		case '>':
			return val > rhs;
		case '<':
			return val < rhs;
	}
}

export function hasWave10ObjectFilterFields(f: ObjectFilter): boolean {
	return Boolean(
		f.greatestStatAmongControlled !== undefined ||
			f.leastStatAmongControlled !== undefined ||
			f.sameNameAsTarget !== undefined ||
			f.isColored !== undefined ||
			f.notEnteredThisTurn !== undefined ||
			f.controllerDealtCombatDamageBySelfThisTurn !== undefined ||
			f.controllerOfTargetIndex !== undefined ||
			f.sharesCardTypeWithBinding !== undefined ||
			f.createdWithSelf !== undefined ||
			f.basePowerOrToughness !== undefined
	);
}

const MTG_CARD_TYPES_W10 = [
	'Artifact',
	'Battle',
	'Creature',
	'Enchantment',
	'Instant',
	'Kindred',
	'Land',
	'Planeswalker',
	'Sorcery'
];

function resolveTargetObjectMetaW10(
	state: GameState,
	targetRef: TargetRef | undefined,
	initialSnapshots?: Map<string, { controllerId: string; ownerId: string; manaValue: number }>
): { name?: string; controllerId?: string } | null {
	if (!targetRef) return null;
	if (targetRef.kind === 'player') return { controllerId: targetRef.id };
	for (const p of state.players) {
		for (const zone of ['battlefield', 'graveyard', 'exile', 'hand'] as const) {
			const found = p[zone].find((c) => c.instanceId === targetRef.id);
			if (found) {
				const ev = zone === 'battlefield' ? evaluatePermanent(state, found) : null;
				const name = found.isFaceDown
					? ''
					: ev
						? ev.effectiveName
						: resolveObjectFaces(effectiveCardForObject(found), instanceFaceOptions(found, zone)).name;
				return {
					name,
					controllerId: zone === 'battlefield' ? found.controllerId : found.ownerId
				};
			}
		}
	}
	const snap = initialSnapshots?.get(targetRef.id);
	return {
		name: targetRef.label,
		controllerId: snap?.controllerId
	};
}

export function matchesObjectFilterWave10(
	state: GameState,
	obj: CardInstance,
	filter: ObjectFilter,
	ctx: {
		controllerId: string;
		source?: CardInstance;
		targets?: TargetRef[];
		evalAmount?: (a: Amount) => number;
		bindingTypes?: string[];
		initialSnapshots?: Map<string, { controllerId: string; ownerId: string; manaValue: number }>;
		readStat: {
			manaValue: (s: GameState, c: CardInstance) => number;
			power: (s: GameState, c: CardInstance) => number | null;
			toughness: (s: GameState, c: CardInstance) => number | null;
		};
	},
	zone: ZoneType
): boolean {
	const ev = zone === 'battlefield' ? evaluatePermanent(state, obj) : null;
	const view = ev ? null : resolveObjectFaces(effectiveCardForObject(obj), instanceFaceOptions(obj, zone));
	const cols = obj.isFaceDown ? [] : ev ? ev.colors : view!.colors;
	const effName = obj.isFaceDown ? '' : ev ? ev.effectiveName : view!.name;
	const ctrlId = zone === 'battlefield' ? obj.controllerId : obj.ownerId;

	if (filter.isColored !== undefined) {
		if ((cols.length >= 1) !== filter.isColored) return false;
	}
	if (filter.notEnteredThisTurn) {
		if (zone !== 'battlefield') return false;
		if (obj.enteredTurnSerial === (state.turnSerial ?? state.turnNumber)) return false;
	}
	if (filter.createdWithSelf) {
		if (!ctx.source || !obj.createdBySource) return false;
		if (
			obj.createdBySource.instanceId !== ctx.source.instanceId ||
			obj.createdBySource.objectVersion !== (ctx.source.objectVersion ?? 1)
		) {
			return false;
		}
	}
	if (filter.controllerDealtCombatDamageBySelfThisTurn) {
		if (!ctx.source) return false;
		const ctrlPl = state.players.find((p) => p.playerId === ctrlId);
		if (!ctrlPl?.combatDamageDealtBySourceIdsThisTurn?.includes(ctx.source.instanceId)) {
			return false;
		}
	}
	if (filter.basePowerOrToughness) {
		const bp = ev ? ev.breakdown.basePower : ctx.readStat.power(state, obj);
		const bt = ev ? ev.breakdown.baseToughness : ctx.readStat.toughness(state, obj);
		const rhs = ctx.evalAmount
			? ctx.evalAmount(filter.basePowerOrToughness.value)
			: filter.basePowerOrToughness.value.k === 'const'
				? filter.basePowerOrToughness.value.n
				: 0;
		const pOk = bp !== null && compareOpW10(bp, filter.basePowerOrToughness.op, rhs);
		const tOk = bt !== null && compareOpW10(bt, filter.basePowerOrToughness.op, rhs);
		if (!pOk && !tOk) return false;
	}
	if (filter.sameNameAsTarget) {
		if (obj.isFaceDown || !effName) return false;
		const tRef = ctx.targets?.[filter.sameNameAsTargetIndex ?? 0];
		const meta = resolveTargetObjectMetaW10(state, tRef, ctx.initialSnapshots);
		if (!meta?.name || effName.toLowerCase() !== meta.name.toLowerCase()) return false;
	}
	if (filter.controllerOfTargetIndex !== undefined) {
		const tRef = ctx.targets?.[filter.controllerOfTargetIndex];
		const meta = resolveTargetObjectMetaW10(state, tRef, ctx.initialSnapshots);
		if (!meta?.controllerId || ctrlId !== meta.controllerId) return false;
	}
	if (filter.sharesCardTypeWithBinding !== undefined) {
		const bTypes = ctx.bindingTypes ?? [];
		if (bTypes.length === 0) return false;
		const objTypes = (ev ? ev.typeLine.split(/[\s—]+/) : view!.types).filter((t) =>
			MTG_CARD_TYPES_W10.includes(t)
		);
		if (!objTypes.some((t) => bTypes.includes(t))) return false;
	}
	if (filter.greatestStatAmongControlled || filter.leastStatAmongControlled) {
		if (zone !== 'battlefield') return false;
		const stat = (filter.greatestStatAmongControlled ?? filter.leastStatAmongControlled)!;
		const isMax = Boolean(filter.greatestStatAmongControlled);
		const scopeTypes = filter.greatestStatAmongControlledTypes ?? filter.types;
		const ctrlPl = state.players.find((p) => p.playerId === obj.controllerId);
		if (!ctrlPl) return false;
		const read = (c: CardInstance): number | null => {
			if (stat === 'manaValue') return ctx.readStat.manaValue(state, c);
			if (stat === 'power') return ctx.readStat.power(state, c);
			return ctx.readStat.toughness(state, c);
		};
		let extreme: number | null = null;
		for (const cand of ctrlPl.battlefield) {
			if (cand.phasedOut) continue;
			if (scopeTypes && scopeTypes.length > 0) {
				const cWords = evaluatePermanent(state, cand).typeLine.split(/[\s—]+/);
				if (!scopeTypes.some((t) => cWords.includes(t))) continue;
			}
			const sv = read(cand);
			if (sv === null) continue;
			if (extreme === null || (isMax ? sv > extreme : sv < extreme)) extreme = sv;
		}
		const myVal = read(obj);
		if (extreme === null || myVal === null || myVal !== extreme) return false;
	}
	return true;
}
