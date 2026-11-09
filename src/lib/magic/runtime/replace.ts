/**
 * Runtime interpreter for compiled rule modifiers, restrictions, multipliers, and replacement
 * effects (ENGINE_ARCHITECTURE_PLAN.md section 2.4, Phase 7).
 *
 * Evaluates StaticDef (ruleModifier, restriction, multiplier) and ReplacementDef entries produced
 * by compileCard(card) across active battlefield permanents (and spells on the stack for spell
 * restrictions), respecting ability loss (CR 613 layer 6), phasing (CR 702.26b), and static
 * conditions ("As long as ...").
 */
import { compileCard } from '../compiler/index.ts';
import type {
	Amount,
	Condition,
	EventPattern,
	ObjectFilter,
	PlayerFilter,
	ReplacementDef,
	RestrictionKind,
	RuleModKind,
	StaticDef
} from '../ir.ts';
import { permanentHasLostAllAbilities } from '../ruleTree.ts';
import type {
	CardInstance,
	CounterType,
	GameState,
	LibrarySearchInterceptorInfo,
	PlayerGameState,
	ScryfallCard,
	StackItem,
	ZoneType
} from '../types.ts';
import type { LeftBattlefieldInfo } from './events.ts';
import {
	evaluateAmount,
	evaluateCondition,
	matchesObjectFilter,
	type FilterContext
} from './objectFilter.ts';

// ---- Condition & Amount Evaluation ----------------------------------------------------------

function zoneOfPlayer(player: PlayerGameState, zone: ZoneType): CardInstance[] {
	switch (zone) {
		case 'library':
			return player.library;
		case 'hand':
			return player.hand;
		case 'battlefield':
			return player.battlefield;
		case 'graveyard':
			return player.graveyard;
		case 'exile':
			return player.exile;
		case 'command':
			return player.command;
		default:
			return [];
	}
}

export function evalReplaceAmount(amount: Amount, ctx: FilterContext): number {
	if (amount.k === 'cardsIn') {
		let player: PlayerGameState | undefined;
		if (amount.of.k === 'you') {
			player = ctx.state.players.find((p) => p.playerId === ctx.controllerId);
		} else if (amount.of.k === 'activePlayer') {
			player = ctx.state.players[ctx.state.activePlayerIndex];
		} else {
			player = ctx.state.players.find((p) => p.playerId === ctx.controllerId);
		}
		if (!player) return 0;
		if (amount.zone === 'battlefield') {
			return player.battlefield.filter((c) => !c.phasedOut).length;
		}
		return zoneOfPlayer(player, amount.zone).length;
	}
	if (amount.k === 'negate') return -evalReplaceAmount(amount.of, ctx);
	if (amount.k === 'sum') {
		return amount.args.reduce((acc, x) => acc + evalReplaceAmount(x, ctx), 0);
	}
	if (amount.k === 'min') {
		return amount.args.length ? Math.min(...amount.args.map((x) => evalReplaceAmount(x, ctx))) : 0;
	}
	if (amount.k === 'max') {
		return amount.args.length ? Math.max(...amount.args.map((x) => evalReplaceAmount(x, ctx))) : 0;
	}
	return evaluateAmount(amount, ctx);
}

export function evalReplaceCondition(cond: Condition | undefined, ctx: FilterContext): boolean {
	if (!cond) return true;
	switch (cond.k) {
		case 'and':
			return cond.of.every((c) => evalReplaceCondition(c, ctx));
		case 'or':
			return cond.of.some((c) => evalReplaceCondition(c, ctx));
		case 'not':
			return !evalReplaceCondition(cond.of, ctx);
		case 'compare': {
			const left = evalReplaceAmount(cond.left, ctx);
			const right = evalReplaceAmount(cond.right, ctx);
			switch (cond.op) {
				case '=':
					return left === right;
				case '<':
					return left < right;
				case '<=':
					return left <= right;
				case '>':
					return left > right;
				case '>=':
					return left >= right;
			}
			return false;
		}
		default:
			return evaluateCondition(cond, ctx);
	}
}

// ---- Active Permanent Discovery -------------------------------------------------------------

interface ActivePermanent {
	perm: CardInstance;
	card: ScryfallCard;
	controllerId: string;
	player: PlayerGameState;
}

function activePermanents(state: GameState): ActivePermanent[] {
	const out: ActivePermanent[] = [];
	for (const player of state.players) {
		if (player.lost) continue;
		for (const perm of player.battlefield) {
			if (perm.phasedOut) continue;
			if (permanentHasLostAllAbilities(perm, state).lost) continue;
			out.push({
				perm,
				card: perm.copiableCard ?? perm.card,
				controllerId: player.playerId,
				player
			});
		}
	}
	return out;
}

function resolvePlayer(
	state: GameState,
	playerOrId: PlayerGameState | string
): PlayerGameState | undefined {
	return typeof playerOrId === 'string'
		? state.players.find((p) => p.playerId === playerOrId)
		: playerOrId;
}

function matchesPlayerFilter(
	who: PlayerFilter,
	sourceControllerId: string,
	targetPlayerId: string,
	_state: GameState
): boolean {
	switch (who.relation) {
		case 'you':
			return targetPlayerId === sourceControllerId;
		case 'each_opponent':
		case 'opponent':
			return targetPlayerId !== sourceControllerId;
		case 'each_player':
		case 'any':
			return true;
		default:
			return false;
	}
}

function isBattlefieldActiveZone(def: StaticDef): boolean {
	if ('activeZones' in def && def.activeZones && !def.activeZones.includes('battlefield')) {
		return false;
	}
	return true;
}

// ---- Rule Modifiers -------------------------------------------------------------------------

export interface ActiveRuleModifier {
	def: Extract<StaticDef, { k: 'ruleModifier' }>;
	source: CardInstance;
	sourceName: string;
	controllerId: string;
}

/**
 * Returns active rule modifiers on the battlefield, optionally filtered by rule kind and/or the
 * player affected by `def.who`.
 */
export function activeRuleModifiers(
	state: GameState,
	rule?: RuleModKind,
	affectedPlayerId?: string
): ActiveRuleModifier[] {
	const out: ActiveRuleModifier[] = [];
	for (const { perm, card, controllerId } of activePermanents(state)) {
		const compiled = compileCard(card);
		const face = compiled.faces[0];
		if (!face) continue;
		for (const ability of face.abilities) {
			if (ability.kind !== 'static' || ability.static.k !== 'ruleModifier') continue;
			const def = ability.static;
			if (!isBattlefieldActiveZone(def)) continue;
			if (rule !== undefined && def.rule !== rule) continue;
			if (
				affectedPlayerId !== undefined &&
				!matchesPlayerFilter(def.who, controllerId, affectedPlayerId, state)
			) {
				continue;
			}
			if (!evalReplaceCondition(def.condition, { state, controllerId, source: perm })) {
				continue;
			}
			out.push({
				def,
				source: perm,
				sourceName: card.name,
				controllerId
			});
		}
	}
	return out;
}

/**
 * Checks whether a player has no maximum hand size (Reliquary Tower, Thought Vessel, etc.).
 */
export function playerHasNoMaxHandSize(
	state: GameState,
	playerOrId: PlayerGameState | string
): boolean {
	const targetPlayer = resolvePlayer(state, playerOrId);
	if (!targetPlayer) return false;
	return activeRuleModifiers(state, 'noMaxHandSize', targetPlayer.playerId).length > 0;
}

/**
 * Checks if a player is prevented from losing the game by a static rule-modifying effect
 * (e.g., Platinum Angel). Respects Layer 6 ability-removal effects (e.g., Humility).
 */
export function playerCannotLoseGame(
	state: GameState,
	playerOrId: PlayerGameState | string
): { protected: boolean; sourceName?: string } {
	const targetPlayer = resolvePlayer(state, playerOrId);
	if (!targetPlayer) return { protected: false };
	if (targetPlayer.cannotLoseGameThisTurn) {
		return { protected: true, sourceName: 'Turn Protection Effect' };
	}
	const mods = activeRuleModifiers(state, 'cantLose', targetPlayer.playerId);
	if (mods.length > 0) {
		return { protected: true, sourceName: mods[0].sourceName };
	}
	return { protected: false };
}

/**
 * Checks if a player is prevented from winning the game by an opponent's static rule-modifying
 * effect (e.g., Platinum Angel's "your opponents can't win the game").
 */
export function playerCannotWinGame(
	state: GameState,
	playerOrId: PlayerGameState | string
): { blocked: boolean; sourceName?: string } {
	const targetPlayer = resolvePlayer(state, playerOrId);
	if (!targetPlayer) return { blocked: false };
	const mods = activeRuleModifiers(state, 'opponentsCantWin', targetPlayer.playerId);
	if (mods.length > 0) {
		return { blocked: true, sourceName: mods[0].sourceName };
	}
	return { blocked: false };
}

/**
 * Checks whether `targetPlayer` has hexproof against `actorId`.
 */
export function playerHasHexproofFrom(
	state: GameState,
	targetPlayer: PlayerGameState,
	actorId: string
): boolean {
	if (targetPlayer.playerId === actorId) return false;
	return activeRuleModifiers(state, 'playerHexproof', targetPlayer.playerId).length > 0;
}

/**
 * Checks whether `targetPlayer` has shroud.
 */
export function playerHasShroud(state: GameState, targetPlayer: PlayerGameState): boolean {
	return activeRuleModifiers(state, 'playerShroud', targetPlayer.playerId).length > 0;
}

/**
 * Computes the total generic mana tax per attacking creature required to attack `defenderOrId`
 * (e.g., Propaganda, Ghostly Prison, or any `{N}` attack tax effect).
 */
export function getAttackTaxGeneric(
	state: GameState,
	defenderOrId: PlayerGameState | string
): number {
	const defender = resolvePlayer(state, defenderOrId);
	if (!defender) return 0;
	let total = 0;
	for (const mod of activeRuleModifiers(state, 'attackTax', defender.playerId)) {
		const costStr = typeof mod.def.params?.cost === 'string' ? mod.def.params.cost : '';
		const m = costStr.match(/^\{(\d+)\}$/);
		if (m) {
			total += parseInt(m[1], 10);
		}
	}
	return total;
}

/**
 * Evaluates global cast permissions (Leyline of Anticipation, Vedalken Orrery, type-filtered flash)
 * and restrictions (Rule of Law, Drannith Magistrate, Grand Abolisher, Teferi, Time Raveler).
 */
export function checkGlobalCastPermissionsAndRestrictions(
	state: GameState,
	actorOrId: PlayerGameState | string,
	fromZoneOrInst?: ZoneType | CardInstance,
	maybeFromZone?: ZoneType
): {
	allowedAsThoughFlash: boolean;
	grantsFlash: boolean;
	blocked: boolean;
	ok: boolean;
	error?: string;
} {
	const actor = resolvePlayer(state, actorOrId);
	const spellInst =
		typeof fromZoneOrInst === 'object' && fromZoneOrInst !== null ? fromZoneOrInst : undefined;
	const fromZone: ZoneType =
		maybeFromZone ?? (typeof fromZoneOrInst === 'string' ? fromZoneOrInst : 'hand');
	if (!actor) {
		return {
			allowedAsThoughFlash: false,
			grantsFlash: false,
			blocked: true,
			ok: false,
			error: 'Player not found.'
		};
	}

	let allowedAsThoughFlash = false;
	const activePlayer = state.players[state.activePlayerIndex];
	const mods = activeRuleModifiers(state, undefined, actor.playerId);

	// 1. Check "as though they had flash" permissions
	for (const mod of mods) {
		if (mod.def.rule !== 'castAsThoughFlash') continue;
		const spellsFilter = mod.def.params?.spells as ObjectFilter | undefined;
		if (!spellsFilter) {
			allowedAsThoughFlash = true;
		} else if (spellInst) {
			const viewInst: CardInstance =
				spellInst.controllerId === actor.playerId
					? spellInst
					: { ...spellInst, controllerId: actor.playerId };
			if (
				matchesObjectFilter(viewInst, spellsFilter, {
					state,
					controllerId: mod.controllerId,
					source: mod.source
				})
			) {
				allowedAsThoughFlash = true;
			}
		}
	}

	// 2. Check global & opponent Stax restrictions ("Can't beats Can" — CR 101.2)
	for (const mod of mods) {
		const p = state.players.find((pl) => pl.playerId === mod.controllerId);
		switch (mod.def.rule) {
			case 'oneSpellPerTurn': {
				if ((actor.spellsCastThisTurn || 0) >= 1) {
					return {
						allowedAsThoughFlash,
						grantsFlash: allowedAsThoughFlash,
						blocked: true,
						ok: false,
						error: `Illegal Cast: ${mod.sourceName} prevents each player from casting more than one spell each turn.`
					};
				}
				break;
			}
			case 'castOnlyFromHand': {
				if (fromZone !== 'hand') {
					return {
						allowedAsThoughFlash,
						grantsFlash: allowedAsThoughFlash,
						blocked: true,
						ok: false,
						error: `Illegal Cast: ${mod.sourceName} prevents opponents from casting spells from anywhere other than their hands (blocks Command Zone / Exile / Graveyard casts).`
					};
				}
				break;
			}
			case 'opponentsCantCastDuringYourTurn': {
				if (activePlayer?.playerId === mod.controllerId) {
					return {
						allowedAsThoughFlash,
						grantsFlash: allowedAsThoughFlash,
						blocked: true,
						ok: false,
						error: `Illegal Cast: ${mod.sourceName} prevents opponents from casting spells during ${p?.username ?? mod.controllerId}'s turn.`
					};
				}
				break;
			}
			case 'castOnlySorcerySpeed': {
				const atSorceryTiming =
					activePlayer?.playerId === actor.playerId &&
					(state.phase === 'main1' || state.phase === 'main2') &&
					state.stack.length === 0;
				if (!atSorceryTiming) {
					return {
						allowedAsThoughFlash,
						grantsFlash: allowedAsThoughFlash,
						blocked: true,
						ok: false,
						error: `Illegal Cast: ${mod.sourceName} restricts you to casting spells only at Sorcery speed.`
					};
				}
				break;
			}
		}
	}

	return {
		allowedAsThoughFlash,
		grantsFlash: allowedAsThoughFlash,
		blocked: false,
		ok: true
	};
}

/**
 * Checks for active opponent library-search interceptors (e.g., Opposition Agent).
 * Uses timestamp ordering (CR 613.7) when multiple opponents control search interceptors.
 */
export function getLibrarySearchInterceptor(
	state: GameState,
	searchingPlayerId: string
): LibrarySearchInterceptorInfo | null {
	const candidates: Array<{
		info: LibrarySearchInterceptorInfo;
		timestamp: number;
	}> = [];

	for (const { perm, card, controllerId } of activePermanents(state)) {
		if (controllerId === searchingPlayerId) continue;
		const compiled = compileCard(card);
		const face = compiled.faces[0];
		if (!face) continue;

		let controlsSearch = false;
		let exilesFoundCards = false;
		let grantPlayFromExile = false;
		let spendManaAsAnyColor = false;

		for (const ability of face.abilities) {
			if (
				ability.kind !== 'static' ||
				ability.static.k !== 'ruleModifier' ||
				ability.static.rule !== 'searchControl'
			) {
				continue;
			}
			const def = ability.static;
			if (!isBattlefieldActiveZone(def)) continue;
			if (!matchesPlayerFilter(def.who, controllerId, searchingPlayerId, state)) continue;
			if (!evalReplaceCondition(def.condition, { state, controllerId, source: perm })) continue;

			const p = def.params;
			if (p?.exilesFoundCards) exilesFoundCards = true;
			if (p?.grantPlayFromExile) grantPlayFromExile = true;
			if (p?.spendManaAsAnyColor) spendManaAsAnyColor = true;
			if (!p?.exilesFoundCards && !p?.grantPlayFromExile) {
				controlsSearch = true;
			}
		}

		if (controlsSearch || exilesFoundCards) {
			candidates.push({
				info: {
					controllerId,
					sourceInstanceId: perm.instanceId,
					sourceName: card.name,
					exilesFoundCards,
					grantPlayFromExile,
					spendManaAsAnyColor
				},
				timestamp: perm.enteredTimestamp ?? 0
			});
		}
	}

	if (candidates.length === 0) return null;

	candidates.sort((a, b) => b.timestamp - a.timestamp);
	return candidates[0].info;
}

// ---- Restrictions ---------------------------------------------------------------------------

function matchesRestrictionKind(defKind: RestrictionKind, queried: RestrictionKind): boolean {
	if (defKind === queried) return true;
	if (defKind === 'cantAttackOrBlock' && (queried === 'cantAttack' || queried === 'cantBlock')) {
		return true;
	}
	return false;
}

function isOnBattlefield(state: GameState, instanceId: string): boolean {
	for (const p of state.players) {
		if (p.battlefield.some((c) => c.instanceId === instanceId)) return true;
	}
	return false;
}

/**
 * Checks whether `obj` has a static restriction (`cantBeCountered`, `cantAttack`, `cantBlock`,
 * `cantAttackOrBlock`, `cantBeBlocked`, `doesntUntap`, `attacksEachCombat`, `blocksEachCombat`)
 * from its own static abilities or from any active permanent on the battlefield.
 */
export function hasRestriction(
	state: GameState,
	obj: CardInstance,
	restriction: RestrictionKind
): boolean {
	const onBf = isOnBattlefield(state, obj.instanceId);
	const canCheckSelf =
		!onBf || (!obj.phasedOut && !permanentHasLostAllAbilities(obj, state).lost);

	if (canCheckSelf) {
		const selfCard = obj.copiableCard ?? obj.card;
		const selfDef = compileCard(selfCard);
		const face = selfDef.faces[0];
		if (face) {
			for (const ability of face.abilities) {
				if (ability.kind !== 'static' || ability.static.k !== 'restriction') continue;
				const def = ability.static;
				if (def.affected !== 'self') continue;
				if (!matchesRestrictionKind(def.restriction, restriction)) continue;
				if (
					evalReplaceCondition(def.condition, {
						state,
						controllerId: obj.controllerId,
						source: obj
					})
				) {
					return true;
				}
			}
		}
	}

	for (const { perm, card, controllerId } of activePermanents(state)) {
		const compiled = compileCard(card);
		const face = compiled.faces[0];
		if (!face) continue;
		for (const ability of face.abilities) {
			if (ability.kind !== 'static' || ability.static.k !== 'restriction') continue;
			const def = ability.static;
			if (!isBattlefieldActiveZone(def)) continue;
			if (!matchesRestrictionKind(def.restriction, restriction)) continue;
			if (!evalReplaceCondition(def.condition, { state, controllerId, source: perm })) {
				continue;
			}
			if (def.affected === 'self') {
				if (perm.instanceId === obj.instanceId) return true;
			} else if (def.affected === 'attachedTo') {
				if (perm.attachedToId === obj.instanceId) return true;
			} else if (
				matchesObjectFilter(obj, def.affected, {
					state,
					controllerId,
					source: perm
				})
			) {
				return true;
			}
		}
	}

	return false;
}

/**
 * Checks whether a spell `StackItem` cannot be countered (`cantBeCountered` on the spell itself or
 * granted by a battlefield permanent such as "Creature spells you control can't be countered").
 */
export function spellCannotBeCountered(state: GameState, item: StackItem): boolean {
	if (item.kind !== 'spell' || !item.card) return false;
	const stackObj: CardInstance = {
		instanceId: item.sourceInstanceId,
		card: item.card,
		ownerId: item.ownerId ?? item.controllerId,
		controllerId: item.controllerId,
		zone: 'stack',
		tapped: false,
		summoningSick: false,
		counters: { '+1/+1': 0, '-1/-1': 0, loyalty: 0, charge: 0, shield: 0, stun: 0, lore: 0, time: 0 },
		isToken: false,
		damageMarked: 0,
		deathtouchDamageMarked: false,
		attachedToId: null,
		tempPowerMod: 0,
		tempToughnessMod: 0,
		grantedKeywords: [],
		usedLoyaltyThisTurn: false,
		isCommander: false,
		commanderCastCount: 0,
		transformed: false
	};
	return hasRestriction(state, stackObj, 'cantBeCountered');
}

// ---- Replacement Effects --------------------------------------------------------------------

export interface ActiveReplacement {
	def: ReplacementDef;
	source: CardInstance;
	sourceName: string;
	controllerId: string;
}

export interface ReplacementQueryContext {
	playerId?: string;
	object?: CardInstance;
	from?: ZoneType;
	to?: ZoneType;
}

/**
 * Returns active replacement effects on the battlefield whose event pattern and condition match.
 */
export function applicableReplacements(
	state: GameState,
	event: EventPattern['event'],
	ctx?: ReplacementQueryContext
): ActiveReplacement[] {
	const out: ActiveReplacement[] = [];
	for (const { perm, card, controllerId } of activePermanents(state)) {
		const compiled = compileCard(card);
		const face = compiled.faces[0];
		if (!face) continue;
		for (const ability of face.abilities) {
			if (ability.kind !== 'replacement') continue;
			const def = ability.replacement;
			if (def.replaces.event !== event) continue;
			const f = def.replaces.filter;
			if (f) {
				if (f.from !== undefined && ctx?.from !== undefined && f.from !== ctx.from) continue;
				if (f.to !== undefined && ctx?.to !== undefined && f.to !== ctx.to) continue;
				if (
					f.player &&
					ctx?.playerId !== undefined &&
					!matchesPlayerFilter(f.player, controllerId, ctx.playerId, state)
				) {
					continue;
				}
				if (f.object !== undefined) {
					if (f.object === 'self') {
						if (ctx?.object?.instanceId !== perm.instanceId) continue;
					} else if (f.object === 'attachedTo') {
						if (!ctx?.object || perm.attachedToId !== ctx.object.instanceId) continue;
					} else if (
						ctx?.object &&
						!matchesObjectFilter(ctx.object, f.object, {
							state,
							controllerId,
							source: perm
						})
					) {
						continue;
					}
				}
			}
			if (!evalReplaceCondition(def.condition, { state, controllerId, source: perm })) {
				continue;
			}
			out.push({
				def,
				source: perm,
				sourceName: card.name,
				controllerId
			});
		}
	}
	return out;
}

/**
 * Checks if a card or token moving to a graveyard should instead be exiled due to a global
 * replacement effect (e.g., Rest in Peace). Respects Layer 6 ability-removal effects (CR 614).
 */
export function checkGraveyardReplacementZone(
	state: GameState,
	desiredDestOrPlayerId: ZoneType | string = 'graveyard'
): { dest: ZoneType; replacedBy?: string } {
	const desiredDest: ZoneType =
		desiredDestOrPlayerId === 'graveyard' ||
		desiredDestOrPlayerId === 'exile' ||
		desiredDestOrPlayerId === 'hand' ||
		desiredDestOrPlayerId === 'library' ||
		desiredDestOrPlayerId === 'command' ||
		desiredDestOrPlayerId === 'battlefield'
			? desiredDestOrPlayerId
			: 'graveyard';
	if (desiredDest !== 'graveyard') return { dest: desiredDest };
	for (const rep of applicableReplacements(state, 'zoneChange', { to: 'graveyard' })) {
		if (rep.def.replaces.filter?.object === 'self') continue;
		const w = rep.def.with;
		if (!Array.isArray(w) && w.k === 'modify' && w.to) {
			return { dest: w.to, replacedBy: rep.sourceName };
		}
	}
	return { dest: desiredDest };
}

/**
 * Checks whether a draw from an empty library is replaced (e.g., Laboratory Maniac's
 * "If you would draw a card while your library has no cards in it, you win the game instead.").
 */
export function replaceEmptyLibraryDraw(
	state: GameState,
	player: PlayerGameState
): { replaced: boolean; winsGame?: boolean; sourceName?: string } {
	for (const rep of applicableReplacements(state, 'draw', { playerId: player.playerId })) {
		const w = rep.def.with;
		if (Array.isArray(w) && w.some((step) => step.verb === 'win')) {
			return { replaced: true, winsGame: true, sourceName: rep.sourceName };
		}
		if (!Array.isArray(w) && w.k === 'skip') {
			return { replaced: true, winsGame: false, sourceName: rep.sourceName };
		}
	}
	return { replaced: false };
}

/**
 * True when the card has a compiled self-replacement effect that causes it to enter the battlefield
 * tapped (`~ enters tapped.`). Conditional `"~ enters tapped unless ..."` lines are not compiled as
 * unconditional replacements and therefore do not force the permanent to enter tapped.
 */
export function cardEntersTapped(
	card: ScryfallCard,
	state?: GameState,
	controllerId?: string,
	source?: CardInstance
): boolean {
	const compiled = compileCard(card);
	const face = compiled.faces[0];
	if (!face) return false;
	for (const ability of face.abilities) {
		if (ability.kind !== 'replacement') continue;
		const rep = ability.replacement;
		if (rep.replaces.event !== 'zoneChange') continue;
		if (rep.replaces.filter?.object !== 'self' || rep.replaces.filter?.to !== 'battlefield') {
			continue;
		}
		if (Array.isArray(rep.with) || rep.with.k !== 'modify' || !rep.with.tapped) continue;
		if (rep.condition) {
			if (!state || !controllerId) return false;
			if (!evalReplaceCondition(rep.condition, { state, controllerId, source })) continue;
		}
		return true;
	}
	return false;
}

/**
 * Applies self-replacement effects (`~ enters tapped`, `~ enters with N <counter> counters on it`)
 * to `perm` as it enters the battlefield. Counter amounts are multiplied by active counter
 * multipliers on the battlefield.
 */
export function applySelfEtbReplacements(state: GameState, perm: CardInstance): void {
	const card = perm.copiableCard ?? perm.card;
	const compiled = compileCard(card);
	const face = compiled.faces[0];
	if (!face) return;
	const ctx: FilterContext = { state, controllerId: perm.controllerId, source: perm };

	for (const ability of face.abilities) {
		if (ability.kind !== 'replacement') continue;
		const rep = ability.replacement;
		if (rep.replaces.event !== 'zoneChange') continue;
		if (rep.replaces.filter?.object !== 'self' || rep.replaces.filter?.to !== 'battlefield') {
			continue;
		}
		if (Array.isArray(rep.with) || rep.with.k !== 'modify') continue;
		if (!evalReplaceCondition(rep.condition, ctx)) continue;

		if (rep.with.tapped) {
			perm.tapped = true;
		}
		if (rep.with.counters) {
			const baseAmount = Math.max(0, evalReplaceAmount(rep.with.counters.amount, ctx));
			if (baseAmount > 0) {
				const cType = rep.with.counters.counter;
				const mult = counterMultiplier(state, perm, cType);
				perm.counters[cType] = (perm.counters[cType] ?? 0) + baseAmount * mult;
			}
		}
	}
}

// ---- Multipliers ----------------------------------------------------------------------------

/**
 * Computes the combined counter multiplier for putting `counterType` counters on `perm`
 * (e.g., Corpsejack Menace for `+1/+1` counters on creatures you control, Doubling Season for any
 * counters on permanents you control).
 */
export function counterMultiplier(
	state: GameState,
	perm: CardInstance,
	counterType: CounterType
): number {
	let factor = 1;
	for (const { perm: source, card, controllerId } of activePermanents(state)) {
		const compiled = compileCard(card);
		const face = compiled.faces[0];
		if (!face) continue;
		for (const ability of face.abilities) {
			if (
				ability.kind !== 'static' ||
				ability.static.k !== 'multiplier' ||
				ability.static.what !== 'counters'
			) {
				continue;
			}
			const def = ability.static;
			if (!isBattlefieldActiveZone(def)) continue;
			if (def.counter !== undefined && def.counter !== counterType) continue;
			if (!evalReplaceCondition(def.condition, { state, controllerId, source })) continue;
			if (
				def.filter &&
				!matchesObjectFilter(perm, def.filter, {
					state,
					controllerId,
					source
				})
			) {
				continue;
			}
			factor *= def.factor;
		}
	}
	return factor;
}

/**
 * Computes the combined token-creation multiplier for tokens created under `recipientPlayerId`'s
 * control (e.g., Doubling Season, Parallel Lives, Anointed Procession).
 */
export function tokenMultiplier(state: GameState, recipientPlayerId: string): number {
	let factor = 1;
	for (const { perm: source, card, controllerId } of activePermanents(state)) {
		const compiled = compileCard(card);
		const face = compiled.faces[0];
		if (!face) continue;
		for (const ability of face.abilities) {
			if (
				ability.kind !== 'static' ||
				ability.static.k !== 'multiplier' ||
				ability.static.what !== 'tokens'
			) {
				continue;
			}
			const def = ability.static;
			if (!isBattlefieldActiveZone(def)) continue;
			if (!evalReplaceCondition(def.condition, { state, controllerId, source })) continue;
			if (def.filter?.controller === 'you' && controllerId !== recipientPlayerId) continue;
			if (def.filter?.controller === 'opponent' && controllerId === recipientPlayerId) continue;
			factor *= def.factor;
		}
	}
	return factor;
}

export interface TriggerMultiplierCause {
	event: 'cast' | 'zoneChange' | 'attacks';
	spell?: CardInstance;
	casterId?: string;
	isCopy?: boolean;
	object?: CardInstance;
	lki?: LeftBattlefieldInfo;
	from?: ZoneType | null;
	to?: ZoneType;
	attackers?: CardInstance[];
}

/**
 * Computes the trigger count for a triggered ability of battlefield permanent `triggeredPerm`
 * caused by `cause` (e.g., Veyran, Panharmonicon, Drivnod, Isshin, Wulfgar).
 */
export function triggerMultiplier(
	state: GameState,
	triggeredPerm: CardInstance,
	triggeredControllerId: string,
	cause: TriggerMultiplierCause
): number {
	let times = 1;
	const permView: CardInstance =
		triggeredPerm.controllerId === triggeredControllerId
			? triggeredPerm
			: { ...triggeredPerm, controllerId: triggeredControllerId };

	for (const { perm: source, card, controllerId } of activePermanents(state)) {
		const compiled = compileCard(card);
		const face = compiled.faces[0];
		if (!face) continue;
		for (const ability of face.abilities) {
			if (
				ability.kind !== 'static' ||
				ability.static.k !== 'multiplier' ||
				ability.static.what !== 'triggers'
			) {
				continue;
			}
			const def = ability.static;
			if (!isBattlefieldActiveZone(def)) continue;
			if (!evalReplaceCondition(def.condition, { state, controllerId, source })) continue;
			if (
				def.filter &&
				!matchesObjectFilter(permView, def.filter, {
					state,
					controllerId,
					source
				})
			) {
				continue;
			}
			if (def.cause) {
				if (def.cause.event !== cause.event) continue;
				const cf = def.cause.filter;
				if (cause.event === 'cast') {
					if (cause.isCopy && !cf?.orCopy) continue;
					if (
						cf?.player &&
						cause.casterId !== undefined &&
						!matchesPlayerFilter(cf.player, controllerId, cause.casterId, state)
					) {
						continue;
					}
					if (cf?.object && typeof cf.object === 'object') {
						if (!cause.spell) continue;
						const spellView: CardInstance =
							cause.casterId && cause.spell.controllerId !== cause.casterId
								? { ...cause.spell, controllerId: cause.casterId }
								: cause.spell;
						if (
							!matchesObjectFilter(spellView, cf.object, {
								state,
								controllerId,
								source
							})
						) {
							continue;
						}
					}
				} else if (cause.event === 'zoneChange') {
					if (cf?.from !== undefined && cf.from !== cause.from) continue;
					if (cf?.to !== undefined && cf.to !== cause.to) continue;
					if (cf?.object && typeof cf.object === 'object') {
						if (!cause.object) continue;
						const objView: CardInstance = cause.lki
							? {
									...cause.object,
									card: {
										...cause.lki.card,
										typeLine: cause.lki.typeLine
									},
									controllerId: cause.lki.controllerId,
									isToken: cause.lki.isToken,
									tapped: cause.lki.tapped
								}
							: cause.object;
						if (
							!matchesObjectFilter(objView, cf.object, {
								state,
								controllerId,
								source
							})
						) {
							continue;
						}
					}
				} else if (cause.event === 'attacks') {
					if (cf?.object && typeof cf.object === 'object') {
						const atkList = cause.attackers ?? (cause.object ? [cause.object] : []);
						if (
							!atkList.some((atk) =>
								matchesObjectFilter(atk, cf.object as ObjectFilter, {
									state,
									controllerId,
									source
								})
							)
						) {
							continue;
						}
					}
				}
			}
			times *= def.factor;
		}
	}
	return times;
}
