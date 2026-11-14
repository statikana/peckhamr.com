<script lang="ts">
	import { onMount } from 'svelte';
	import { compileCard, describeModalModes } from './compiler/index.ts';
	import {
		checkAbilityActivationLegality, checkHandSpecialActionLegality, checkSuspendLegality,
		computeCombatDamageForecast, getCastOptions, getEffectiveActivatedAbilities,
		getHandSpecialActions, getLandPlayOptions, getModalDisabledIndices,
		getPlayerCommanderIdentity, inspectCardContinuousBreakdown
	} from './engine.ts';
	import type { ModalDef } from './ir.ts';
	import { instanceFaceOptions, resolveObjectFaces } from './runtime/faces.ts';
	import { effectiveCardForObject } from './scryfall.ts';
	import type {
		CardInstance, CastOption, EffectiveActivatedAbility, GameActionPayload, GameState,
		HandSpecialActionOption, LandPlayOption, MagicChatMessage, MagicUser, ManaColor,
		PlayerGameState, ScryfallCard, StackItem, TargetRef
	} from './types.ts';
	import AbilityMenuModal from './ui/AbilityMenuModal.svelte';
	import AltHoverPreview from './ui/AltHoverPreview.svelte';
	import { previewAbilityAutoTap, previewSpellAutoTap, type AutoTapPreviewResult } from './ui/autoTapPreview.ts';
	import {
		buildBoardViewModel, computeArrowSignature, sortHandCards,
		type HandSortDir, type HandSortMode
	} from './ui/boardViewModel.ts';
	import CastOptionsModal, { type CastOptionSelection, type HoveredCastOptionContext } from './ui/CastOptionsModal.svelte';
	import ChoicePromptModal from './ui/ChoicePromptModal.svelte';
	import {
		TURN_PHASE_GROUPS, assignSelectedBlockerToAttacker, buildDeclareAttackersPayload,
		buildDeclareBlockersPayload, canViewerSelectAllAttackers, createEmptyCombatDraft,
		deriveTurnControlView, pruneStaleCombatDraft, retargetDraftAttackersToPlaneswalker,
		retargetDraftAttackersToPlayer, selectAllEligibleAttackers, toggleDraftAttacker,
		toggleOrSelectBlocker, type CombatDraftState
	} from './ui/combatController.ts';
	import HandTray from './ui/HandTray.svelte';
	import HudBar from './ui/HudBar.svelte';
	import ModePickerModal from './ui/ModePickerModal.svelte';
	import OpponentPod from './ui/OpponentPod.svelte';
	import PermanentCard from './ui/PermanentCard.svelte';
	import PlayerVitals from './ui/PlayerVitals.svelte';
	import { resolveCardInstanceDisplay } from './ui/promptViewModel.ts';
	import RightDock from './ui/RightDock.svelte';
	import TargetBanner from './ui/TargetBanner.svelte';
	import {
		beginAbilityTargeting, beginDropTargeting, beginModalTargeting, beginSpellTargeting,
		canClickTargetCandidate, confirmCurrentSlot, describeCurrentTargetSlot,
		getPendingTargetArrowRefs, optionChoosesX, requiredZoneDrawerForCurrentSlot,
		stepBackToPreviousSlot, toggleOrAdvanceTarget,
		type CastableZone, type TargetingSession, type TargetingTransitionResult
	} from './ui/targetingController.ts';
	import VictoryModal from './ui/VictoryModal.svelte';
	import XCostModal from './ui/XCostModal.svelte';
	import ZoneBrowserModal from './ui/ZoneBrowserModal.svelte';
	import { ArenaVfxController, areArrowListsEqual, buildArenaArrowLines, computeBezierPath, type ArrowLine } from './vfx.ts';

	interface Props {
		gameState: GameState;
		user?: MagicUser;
		viewerPlayerId?: string;
		lobbyCode: string;
		chatMessages: MagicChatMessage[];
		theme?: 'dark' | 'light';
		botPaused?: boolean;
		onToggleTheme: () => void;
		onGameAction: (action: GameActionPayload) => void | Promise<void>;
		onSendChat: (text: string, kind?: 'chat' | 'emote') => void | Promise<void>;
		onLeaveMatch: () => void;
	}

	let {
		gameState, user, viewerPlayerId, lobbyCode, chatMessages,
		theme = 'dark', botPaused = false, onToggleTheme, onGameAction, onSendChat, onLeaveMatch
	}: Props = $props();

	interface ZoneModalState {
		title: string;
		cards: CardInstance[];
		ownerName: string;
		isAutoOpenedForTargeting?: boolean;
	}

	interface CastOptionsModalState {
		inst: CardInstance;
		fromZone: CastableZone;
		options: CastOption[];
		landOptions: LandPlayOption[];
		zoneAbilities: EffectiveActivatedAbility[];
	}

	interface ModePickerModalState {
		kind: 'spell' | 'ability';
		inst: CardInstance;
		modal: ModalDef;
		modeLabels: string[];
		disabledIndices: number[];
		allowAllModes?: boolean;
		fromZone?: CastableZone;
		xValue?: number;
		option?: CastOption;
		optionalCostCounts?: Record<string, number>;
		costAidIds?: Record<string, string[]>;
		costAidColorChoices?: Record<string, ManaColor | 'generic'>;
		ability?: EffectiveActivatedAbility;
	}

	interface XCostModalState {
		inst: CardInstance;
		fromZone: CastableZone | 'battlefield';
		actionKind: 'cast_spell' | 'turn_face_up';
		castOption?: CastOption;
		optionalCostCounts?: Record<string, number>;
		costAidIds?: Record<string, string[]>;
		costAidColorChoices?: Record<string, ManaColor | 'generic'>;
	}

	type LayoutDragHandle =
		| 'dock'
		| 'inspector'
		| 'stack'
		| 'opp_row'
		| 'player_rows'
		| 'hand_height'
		| 'hand_left'
		| 'hand_right'
		| 'pedestal';

	const CANCEL_KEY = 'Esc' + 'ape';

	// VFX & SVG Arrows
	let vfxCanvas: HTMLCanvasElement | undefined = $state();
	const vfxCtrl = new ArenaVfxController();
	let shaking = $state(false);
	let arrows = $state<ArrowLine[]>([]);
	let vfxRafId = 0;
	let arrowRafId = 0;

	// Hover & Card Inspector State
	let inspectedCard = $state.raw<ScryfallCard | null>(null);
	let inspectedInstance = $state.raw<CardInstance | null>(null);
	let inspectedFaceIndex = $state<number>(0);
	let hoveredCard = $state.raw<ScryfallCard | null>(null);
	let hoveredInstance = $state.raw<CardInstance | null>(null);
	let altHeld = $state(false);
	let mousePos = $state({ x: 0, y: 0 });
	let viewportSize = $state({
		w: typeof window !== 'undefined' ? window.innerWidth : 1280,
		h: typeof window !== 'undefined' ? window.innerHeight : 720
	});

	// Resizable Layout Splitters & Hand Auto-Sort Preferences
	let dockWidth = $state(330);
	let inspectorHeight = $state(255);
	let stackHeight = $state(145);
	let oppHeightPct = $state(33);
	let frontRowPct = $state(50);
	let consoleHeight = $state(152);
	let vitalsWidth = $state(160);
	let controlsWidth = $state(185);
	let pedestalWidth = $state(150);
	let handSortBy = $state<HandSortMode>('none');
	let handSortDir = $state<HandSortDir>('asc');
	let activeDrag = $state<LayoutDragHandle | null>(null);

	let tableAreaEl: HTMLDivElement | undefined = $state();
	let myBoardEl: HTMLElement | undefined = $state();
	let myZonesEl: HTMLDivElement | undefined = $state();
	let myBackRowEl: HTMLDivElement | undefined = $state();
	let myConsoleEl: HTMLDivElement | undefined = $state();

	// Interactive Modals, Targeting, Auto-Tap Preview, Combat Drafts & Drag-Drop
	let zoneModal = $state.raw<ZoneModalState | null>(null);
	let castOptionsModal = $state.raw<CastOptionsModalState | null>(null);
	let modePickerModal = $state.raw<ModePickerModalState | null>(null);
	let xCostModal = $state.raw<XCostModalState | null>(null);
	let selectedPermanentForAbility = $state.raw<CardInstance | null>(null);
	let targetingSession = $state.raw<TargetingSession | null>(null);
	let activeAutoTapPreview = $state.raw<AutoTapPreviewResult | null>(null);
	let combatDraft = $state<CombatDraftState>(createEmptyCombatDraft());
	let stepActionPending = $state(false);
	let draggingCard = $state.raw<{ inst: CardInstance; fromZone: CastableZone } | null>(null);
	let dragOverZone = $state<'front_row' | 'lands_area' | 'stack' | null>(null);

	// Player & Board View-Model Derivations
	const effectiveViewerId = $derived(viewerPlayerId ?? user?.id ?? gameState.players[0]?.playerId ?? '');
	const me = $derived(gameState.players.find((p) => p.playerId === effectiveViewerId) || gameState.players[0]);
	const opponents = $derived(gameState.players.filter((p) => p.playerId !== me?.playerId));
	const activePlayer = $derived(gameState.players[gameState.activePlayerIndex]);
	const priorityPlayer = $derived(gameState.players[gameState.priorityPlayerIndex]);
	const hasPriority = $derived(Boolean(me && priorityPlayer?.playerId === me.playerId));
	const isMyTurn = $derived(Boolean(me && activePlayer?.playerId === me.playerId));

	const boardVM = $derived(buildBoardViewModel(gameState, me?.playerId ?? effectiveViewerId));
	const myPrompt = $derived(gameState.pendingPrompts.find((pr) => pr.playerId === me?.playerId) || null);
	const sortedHand = $derived(sortHandCards(me?.hand ?? [], handSortBy, handSortDir));
	const autoTapTappedSet = $derived(new Set(activeAutoTapPreview?.tappedPermanentIds ?? []));

	const hasOpenModal = $derived(
		Boolean(
			myPrompt ||
				zoneModal ||
				castOptionsModal ||
				modePickerModal ||
				xCostModal ||
				selectedPermanentForAbility ||
				gameState.status === 'finished'
		)
	);
	const shortcutsDisabled = $derived(Boolean(hasOpenModal || targetingSession !== null));

	$effect(() => {
		if (!me) return;
		const pruned = pruneStaleCombatDraft(combatDraft, gameState, me.playerId);
		if (pruned !== combatDraft) combatDraft = pruned;
	});

	const activeZoneModalView = $derived.by(() => {
		if (!zoneModal) return null;
		if (targetingSession && me && zoneModal.isAutoOpenedForTargeting) {
			const reqDrawer = requiredZoneDrawerForCurrentSlot(targetingSession, me.playerId, gameState);
			if (reqDrawer) return buildTargetingZoneModal(targetingSession, reqDrawer.zone);
		}
		return zoneModal;
	});

	const isZoneModalTargeting = $derived.by(() => {
		if (!targetingSession || !activeZoneModalView) return false;
		const req = targetingSession.currentRequirement;
		return (
			req.zone === 'graveyard' ||
			req.targetKind === 'graveyard_card' ||
			req.zone === 'exile' ||
			req.targetKind === 'exile_card'
		);
	});

	const inspectBreakdown = $derived(
		inspectedInstance?.zone === 'battlefield' ? inspectCardContinuousBreakdown(inspectedInstance, gameState) : null
	);
	const hoverBreakdown = $derived(
		hoveredInstance?.zone === 'battlefield' ? inspectCardContinuousBreakdown(hoveredInstance, gameState) : null
	);

	const altPreviewResolved = $derived.by(() => {
		if (!hoveredCard) return null;
		if (hoveredInstance) {
			const disp = resolveCardInstanceDisplay(hoveredInstance, hoveredInstance.zone, me?.playerId ?? null);
			return { card: disp.displayCard, imageUrlOverride: disp.imageUrl };
		}
		return { card: hoveredCard, imageUrlOverride: undefined };
	});

	const canResolveInspectedManually = $derived(
		Boolean(
			inspectedInstance &&
				me &&
				hasPriority &&
				!myPrompt &&
				gameState.status === 'active' &&
				(inspectedInstance.zone === 'battlefield'
					? inspectedInstance.controllerId === me.playerId
					: inspectedInstance.ownerId === me.playerId)
		)
	);

	const thinkingBotId = $derived.by(() => {
		if (!botPaused || gameState.status !== 'active') return null;
		for (const pr of gameState.pendingPrompts) {
			const p = gameState.players.find((pl) => pl.playerId === pr.playerId);
			if (p?.isBot && !p.lost) return p.playerId;
		}
		if (priorityPlayer?.isBot && !priorityPlayer.lost) return priorityPlayer.playerId;
		if (activePlayer?.isBot && !activePlayer.lost) return activePlayer.playerId;
		if (gameState.phase === 'declare_blockers') {
			for (const atk of gameState.combat.attackers) {
				if (atk.blockerInstanceIds.length > 0) {
					const def = gameState.players.find((pl) => pl.playerId === atk.defenderPlayerId);
					if (def?.isBot && !def.lost) return def.playerId;
				}
			}
		}
		return null;
	});

	let nowTick = $state(Date.now());
	const ropeRemainingSec = $derived.by(() => {
		if (!gameState.rules.turnTimerSeconds || gameState.status !== 'active') return null;
		if (gameState.pendingPrompts.some((pr) => pr.kind === 'mulligan' || pr.kind === 'london_bottom')) {
			return null;
		}
		const elapsed = Math.floor((nowTick - gameState.priorityUpdatedAt) / 1000);
		return Math.max(0, gameState.rules.turnTimerSeconds - elapsed);
	});

	const combatForecast = $derived.by(() => {
		const combined: Record<string, { defenderPlayerId: string; defenderPlaneswalkerId?: string | null }> = {};
		for (const [atkId, defPlayerId] of Object.entries(combatDraft.draftAttackers)) {
			combined[atkId] = {
				defenderPlayerId: defPlayerId,
				defenderPlaneswalkerId: combatDraft.draftAttackerWalkers[atkId] || null
			};
		}
		return computeCombatDamageForecast(gameState, combined, combatDraft.draftBlockers);
	});

	const turnCtrl = $derived(deriveTurnControlView(gameState, me, combatDraft, targetingSession !== null));

	const canSelectAllAttackers = $derived(
		Boolean(
			me &&
				canViewerSelectAllAttackers(boardVM, gameState, me.playerId, {
					isConfirmingAttackers: turnCtrl.isConfirmingAttackers,
					hasPriority,
					interactionBlocked: Boolean(targetingSession)
				})
		)
	);

	// Targeting & Attachment Highlighting Derivations
	const pendingTargetArrowRefs = $derived(targetingSession ? getPendingTargetArrowRefs(targetingSession) : []);
	const selectedTargetIdList = $derived(pendingTargetArrowRefs.map((t) => t.id));
	const selectedTargetIdSet = $derived(new Set(selectedTargetIdList));
	const focusedPermanent = $derived(hoveredInstance ?? inspectedInstance);

	function isAttachmentLinkedToFocus(perm: CardInstance): boolean {
		const focus = focusedPermanent;
		if (!focus) return false;
		if (focus.instanceId === perm.instanceId) {
			return (
				Boolean(boardVM.hostByAttachmentId[perm.instanceId]) ||
				(boardVM.attachmentsByHostId[perm.instanceId]?.length ?? 0) > 0
			);
		}
		return focus.attachedToId === perm.instanceId || perm.attachedToId === focus.instanceId;
	}

	function isPlayerTargetableNow(player: PlayerGameState): boolean {
		if (!targetingSession || !me) return false;
		return canClickTargetCandidate(gameState, me.playerId, targetingSession, {
			kind: 'player',
			id: player.playerId,
			label: player.username
		});
	}

	function isPermanentActableForBoard(perm: CardInstance, owner: PlayerGameState): boolean {
		if (targetingSession && me) {
			const pView = boardVM.permanentsById[perm.instanceId];
			return canClickTargetCandidate(gameState, me.playerId, targetingSession, {
				kind: 'permanent',
				id: perm.instanceId,
				label: pView?.displayCard.name ?? perm.card.name
			});
		}
		if (owner.playerId === me?.playerId) {
			return boardVM.permanentsById[perm.instanceId]?.actableSummary.isActable ?? false;
		}
		if (
			turnCtrl.isConfirmingAttackers &&
			Object.keys(combatDraft.draftAttackers).length > 0 &&
			boardVM.permanentsById[perm.instanceId]?.isPlaneswalker
		) {
			return true;
		}
		if (
			gameState.phase === 'declare_blockers' &&
			!isMyTurn &&
			combatDraft.selectedBlockerId &&
			gameState.combat.attackers.some((a) => a.attackerInstanceId === perm.instanceId)
		) {
			return true;
		}
		return false;
	}

	function isStackItemTargetableNow(item: StackItem): boolean {
		if (!targetingSession || !me) return false;
		return canClickTargetCandidate(gameState, me.playerId, targetingSession, {
			kind: 'stack',
			id: item.id,
			label: item.title
		});
	}

	// Layout Persistence
	function saveLayoutPrefs(): void {
		try {
			localStorage.setItem(
				'magic-arena-layout',
				JSON.stringify({
					dockWidth,
					inspectorHeight,
					stackHeight,
					oppHeightPct,
					frontRowPct,
					consoleHeight,
					vitalsWidth,
					controlsWidth,
					pedestalWidth,
					handSortBy,
					handSortDir
				})
			);
		} catch {}
	}

	function resetLayoutPrefs(): void {
		dockWidth = 330;
		inspectorHeight = 255;
		stackHeight = 145;
		oppHeightPct = 33;
		frontRowPct = 50;
		consoleHeight = 152;
		vitalsWidth = 160;
		controlsWidth = 185;
		pedestalWidth = 150;
		saveLayoutPrefs();
	}

	function setHandSort(mode: HandSortMode): void {
		if (mode !== 'none' && handSortBy === mode) {
			handSortDir = handSortDir === 'asc' ? 'desc' : 'asc';
		} else {
			handSortBy = mode;
		}
		saveLayoutPrefs();
	}

	function setHandSortDir(dir: HandSortDir): void {
		handSortDir = dir;
		if (handSortBy === 'none') handSortBy = 'cmc';
		saveLayoutPrefs();
	}

	// Card Hover & Inspection Helpers
	function setInspectedCard(card: ScryfallCard, inst?: CardInstance | null, stackFaceIdx?: number): void {
		const resolved = inst && me ? resolveCardInstanceDisplay(inst, inst.zone, me.playerId).displayCard : card;
		const canInspectSecret = Boolean(
			inst && (!inst.isFaceDown || inst.controllerId === me?.playerId || inst.ownerId === me?.playerId)
		);
		const nextInstId = canInspectSecret ? (inst?.instanceId ?? null) : null;
		const prevInstId = inspectedInstance?.instanceId ?? null;
		const changed = resolved.id !== inspectedCard?.id || nextInstId !== prevInstId || stackFaceIdx !== undefined;
		inspectedCard = resolved;
		inspectedInstance = canInspectSecret ? (inst ?? null) : null;
		if (changed) {
			if (stackFaceIdx !== undefined) {
				inspectedFaceIndex = stackFaceIdx;
			} else if (inst && canInspectSecret) {
				const active = resolveObjectFaces(effectiveCardForObject(inst), instanceFaceOptions(inst)).activeFaceIndices;
				inspectedFaceIndex = active[0] ?? 0;
			} else {
				inspectedFaceIndex = 0;
			}
		}
	}

	function hoverCard(card: ScryfallCard, inst?: CardInstance): void {
		hoveredCard = card;
		hoveredInstance = inst ?? null;
		setInspectedCard(card, inst);
	}

	function leaveCard(card: ScryfallCard): void {
		if (hoveredCard?.id === card.id || hoveredInstance) {
			hoveredCard = null;
			hoveredInstance = null;
		}
	}

	async function dispatchGameAction(action: GameActionPayload): Promise<void> {
		activeAutoTapPreview = null;
		await onGameAction(action);
	}

	// Zone Playability & Ability Helpers
	function getZoneActivatedAbilities(inst: CardInstance, zone: 'hand' | 'graveyard'): EffectiveActivatedAbility[] {
		if (!me || inst.zone !== zone) return [];
		if (zone === 'hand') {
			const cached = boardVM.handPlayabilityById[inst.instanceId];
			if (cached) return cached.zoneActivatedAbilities;
		}
		const cmdId = getPlayerCommanderIdentity(me);
		return getEffectiveActivatedAbilities(gameState, me, inst, cmdId).filter(
			(ab) =>
				!ab.isManaAbility &&
				Boolean(ab.activationZones?.includes(zone)) &&
				checkAbilityActivationLegality(gameState, me.playerId, inst, ab).ok
		);
	}

	function isZoneCardPlayableNow(inst: CardInstance, zone: 'hand' | 'command' | 'exile' | 'graveyard'): boolean {
		if (!me || me.lost || gameState.status !== 'active' || !hasPriority || myPrompt || targetingSession) {
			return false;
		}
		if (zone === 'hand') return Boolean(boardVM.handPlayabilityById[inst.instanceId]?.playable);
		if (zone === 'command') return Boolean(boardVM.commandPlayabilityById[inst.instanceId]);
		if (zone === 'graveyard') return boardVM.playableGraveyardIds.includes(inst.instanceId);
		return boardVM.playableExileIds.includes(inst.instanceId);
	}

	// Drag-and-Drop Zone Computation
	function getValidDropZones(inst: CardInstance, fromZone: CastableZone): Set<'front_row' | 'lands_area' | 'stack'> {
		const zones = new Set<'front_row' | 'lands_area' | 'stack'>();
		if (!me || !isZoneCardPlayableNow(inst, fromZone)) return zones;

		const landOpts =
			fromZone === 'hand' || fromZone === 'exile'
				? getLandPlayOptions(gameState, me.playerId, inst, fromZone)
				: [];
		if (landOpts.length > 0) zones.add('lands_area');

		const castOpts = getCastOptions(gameState, me.playerId, inst, fromZone);
		if (castOpts.length > 0) {
			const compiled = compileCard(effectiveCardForObject(inst));
			for (const opt of castOpts) {
				const face = compiled.faces[opt.faceIndex ?? 0] ?? compiled.faces[0];
				const faceTypes = face?.characteristics.types ?? [];
				if (faceTypes.includes('Instant') || faceTypes.includes('Sorcery')) {
					zones.add('front_row');
					zones.add('lands_area');
					zones.add('stack');
				} else if (faceTypes.includes('Creature') || faceTypes.includes('Planeswalker')) {
					zones.add('front_row');
					zones.add('stack');
				} else {
					zones.add('lands_area');
					zones.add('front_row');
					zones.add('stack');
				}
			}
		}

		if ((fromZone === 'hand' || fromZone === 'graveyard') && getZoneActivatedAbilities(inst, fromZone).length > 0) {
			zones.add('stack');
		}
		return zones;
	}

	const validDragZones = $derived(
		draggingCard
			? getValidDropZones(draggingCard.inst, draggingCard.fromZone)
			: new Set<'front_row' | 'lands_area' | 'stack'>()
	);

	const dragDropZoneLabel = $derived.by(() => {
		if (!draggingCard || !me) return 'DROP TO CAST';
		const { inst, fromZone } = draggingCard;
		const landOpts =
			fromZone === 'hand' || fromZone === 'exile'
				? getLandPlayOptions(gameState, me.playerId, inst, fromZone)
				: [];
		const castOpts = getCastOptions(gameState, me.playerId, inst, fromZone);
		return landOpts.length > 0 && castOpts.length === 0 ? 'DROP TO PLAY LAND' : 'DROP TO CAST';
	});

	function handleCardDragStart(e: DragEvent, inst: CardInstance, fromZone: CastableZone): void {
		if (!isZoneCardPlayableNow(inst, fromZone)) {
			e.preventDefault();
			return;
		}
		setInspectedCard(inst.card, inst);
		draggingCard = { inst, fromZone };
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', inst.instanceId);
		}
	}

	function handleCardDragEnd(): void {
		draggingCard = null;
		dragOverZone = null;
	}

	function handleZoneDragOver(e: DragEvent, zone: 'front_row' | 'lands_area' | 'stack'): void {
		if (!draggingCard || !validDragZones.has(zone)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dragOverZone = zone;
	}

	function handleZoneDragLeave(e: DragEvent, zone: 'front_row' | 'lands_area' | 'stack'): void {
		const related = e.relatedTarget as Node | null;
		const current = e.currentTarget as HTMLElement | null;
		if (current && related && current.contains(related)) return;
		if (dragOverZone === zone) dragOverZone = null;
	}

	async function handleZoneDrop(e: DragEvent, zone: 'front_row' | 'lands_area' | 'stack'): Promise<void> {
		if (!draggingCard || !validDragZones.has(zone)) return;
		e.preventDefault();
		e.stopPropagation();
		const { inst, fromZone } = draggingCard;
		draggingCard = null;
		dragOverZone = null;
		await handlePlayCardFromZone(inst, fromZone);
	}

	// Targeting Session & Hidden-Zone Drawer Orchestration
	function buildTargetingZoneModal(session: TargetingSession, zone: 'graveyard' | 'exile'): ZoneModalState | null {
		if (!me) return null;
		const req = session.currentRequirement;
		if (zone === 'graveyard') {
			if (req.controllerFilter === 'you') {
				return {
					title: 'Select Target(s) in Your Graveyard',
					cards: me.graveyard,
					ownerName: me.username,
					isAutoOpenedForTargeting: true
				};
			}
			const combinedCards: CardInstance[] = [];
			for (const p of gameState.players) {
				if (req.controllerFilter === 'opponent' && p.playerId === me.playerId) continue;
				combinedCards.push(...p.graveyard);
			}
			return {
				title: req.sameGraveyard
					? `Select ${req.minTargets} Target(s) in a Single Graveyard`
					: 'Select Target(s) in Graveyards',
				cards: combinedCards,
				ownerName: 'All Eligible Graveyards',
				isAutoOpenedForTargeting: true
			};
		}
		if (req.controllerFilter === 'you') {
			return {
				title: 'Select Target(s) in Your Exile',
				cards: me.exile,
				ownerName: me.username,
				isAutoOpenedForTargeting: true
			};
		}
		const combinedExile: CardInstance[] = [];
		for (const p of gameState.players) {
			if (req.controllerFilter === 'opponent' && p.playerId === me.playerId) continue;
			combinedExile.push(...p.exile);
		}
		return {
			title: 'Select Target(s) in Exile',
			cards: combinedExile,
			ownerName: 'All Eligible Exile Zones',
			isAutoOpenedForTargeting: true
		};
	}

	function applyTargetingSessionUpdate(nextSession: TargetingSession | null): void {
		targetingSession = nextSession;
		activeAutoTapPreview = null;
		if (!nextSession || !me) {
			if (zoneModal?.isAutoOpenedForTargeting) zoneModal = null;
			return;
		}
		const reqDrawer = requiredZoneDrawerForCurrentSlot(nextSession, me.playerId, gameState);
		if (reqDrawer) {
			zoneModal = buildTargetingZoneModal(nextSession, reqDrawer.zone);
		} else if (zoneModal?.isAutoOpenedForTargeting) {
			zoneModal = null;
		}
	}

	async function applyTransitionResult(
		res: TargetingTransitionResult,
		modalFallback?: Omit<ModePickerModalState, 'modal' | 'modeLabels' | 'disabledIndices'>
	): Promise<void> {
		if (res.status === 'invalid') return;
		if (res.status === 'ready_to_submit') {
			applyTargetingSessionUpdate(null);
			await dispatchGameAction(res.payload);
			return;
		}
		if (res.status === 'needs_mode_picker') {
			if (!me || !modalFallback) return;
			const effCard = effectiveCardForObject(modalFallback.inst);
			const faceIdx =
				modalFallback.kind === 'spell'
					? (modalFallback.option?.faceIndex ?? 0)
					: (modalFallback.ability?.faceIndex ?? 0);
			const disabledIndices = getModalDisabledIndices(
				gameState,
				me.playerId,
				effCard,
				modalFallback.inst,
				res.modal,
				modalFallback.kind === 'ability' ? modalFallback.inst.usedModalModesThisTurn : undefined
			);
			const modeLabels = describeModalModes(effCard, res.modal, faceIdx);
			modePickerModal = { ...modalFallback, modal: res.modal, modeLabels, disabledIndices };
			return;
		}
		applyTargetingSessionUpdate(res.session);
	}

	async function handleSelectTargetCandidate(candidate: TargetRef): Promise<void> {
		if (!targetingSession || !me) return;
		await applyTransitionResult(toggleOrAdvanceTarget(gameState, me.playerId, targetingSession, candidate));
	}

	async function handleConfirmTargetSlot(): Promise<void> {
		if (!targetingSession) return;
		await applyTransitionResult(confirmCurrentSlot(targetingSession));
	}

	function handleStepBackTargetSlot(): void {
		if (!targetingSession) return;
		applyTargetingSessionUpdate(stepBackToPreviousSlot(targetingSession));
	}

	function cancelTargetingAndDrafts(): void {
		if (zoneModal?.isAutoOpenedForTargeting) zoneModal = null;
		targetingSession = null;
		combatDraft = { ...combatDraft, selectedBlockerId: null };
		draggingCard = null;
		dragOverZone = null;
		activeAutoTapPreview = null;
	}

	// Unified U2 Cast & Activation Flow
	async function handlePlayCardFromZone(inst: CardInstance, fromZone: CastableZone): Promise<void> {
		setInspectedCard(inst.card, inst);
		if (!me || !isZoneCardPlayableNow(inst, fromZone)) return;

		const zoneAbilities =
			fromZone === 'hand' || fromZone === 'graveyard' ? getZoneActivatedAbilities(inst, fromZone) : [];
		const landOptions =
			fromZone === 'hand' || fromZone === 'exile'
				? getLandPlayOptions(gameState, me.playerId, inst, fromZone)
				: [];
		const options = getCastOptions(gameState, me.playerId, inst, fromZone);

		if (landOptions.length === 0 && options.length === 0 && zoneAbilities.length === 0) {
			if (fromZone === 'hand' && checkSuspendLegality(gameState, me.playerId, inst).ok) {
				await dispatchGameAction({ type: 'suspend_card', instanceId: inst.instanceId });
				return;
			}
			if (fromZone === 'hand') {
				const legalSpecials = getHandSpecialActions(gameState, me.playerId, inst).filter(
					(sa) => checkHandSpecialActionLegality(gameState, me.playerId, inst, sa.id).ok
				);
				if (legalSpecials.length === 1) {
					await dispatchGameAction({
						type: 'hand_special_action',
						instanceId: inst.instanceId,
						actionId: legalSpecials[0].id
					});
				} else if (legalSpecials.length > 1) {
					selectedPermanentForAbility = inst;
				}
			}
			return;
		}

		const totalChoices = landOptions.length + options.length + zoneAbilities.length;
		const hasOptionalCosts = options.some((o) => (o.optionalAdditionalCosts?.length ?? 0) > 0);
		const hasPaymentAids = options.some((o) => (o.paymentAids?.length ?? 0) > 0);
		if (totalChoices === 1) {
			if (landOptions.length === 1 && (fromZone === 'hand' || fromZone === 'exile')) {
				await dispatchGameAction({
					type: 'play_land',
					instanceId: inst.instanceId,
					fromZone,
					faceIndex: landOptions[0].faceIndex
				});
				return;
			}
			if (zoneAbilities.length === 1) {
				await triggerActivatedAbility(inst, zoneAbilities[0]);
				return;
			}
			if (options.length === 1 && !hasOptionalCosts && !hasPaymentAids) {
				await proceedCastWithOption({ inst, fromZone, option: options[0] });
				return;
			}
		}

		activeAutoTapPreview = null;
		castOptionsModal = { inst, fromZone, options, landOptions, zoneAbilities };
	}

	async function proceedCastWithOption(selection: CastOptionSelection): Promise<void> {
		const { inst, fromZone, option, optionalCostCounts, costAidIds, costAidColorChoices } = selection;
		castOptionsModal = null;
		activeAutoTapPreview = null;

		const nonZeroCounts = optionalCostCounts
			? Object.fromEntries(Object.entries(optionalCostCounts).filter(([, v]) => v > 0))
			: undefined;
		const normalizedCounts = nonZeroCounts && Object.keys(nonZeroCounts).length > 0 ? nonZeroCounts : undefined;

		if (optionChoosesX(option, normalizedCounts)) {
			xCostModal = {
				inst,
				fromZone,
				actionKind: 'cast_spell',
				castOption: option,
				...(normalizedCounts ? { optionalCostCounts: normalizedCounts } : {}),
				...(costAidIds ? { costAidIds } : {}),
				...(costAidColorChoices ? { costAidColorChoices } : {})
			};
			return;
		}

		await initiateCastSpell(inst, fromZone, 0, option, normalizedCounts, costAidIds, costAidColorChoices);
	}

	async function initiateCastSpell(
		inst: CardInstance,
		fromZone: CastableZone,
		xValue: number,
		option?: CastOption,
		optionalCostCounts?: Record<string, number>,
		costAidIds?: Record<string, string[]>,
		costAidColorChoices?: Record<string, ManaColor | 'generic'>
	): Promise<void> {
		const res = beginSpellTargeting({
			inst,
			fromZone,
			xValue,
			option,
			optionalCostCounts,
			costAidIds,
			costAidColorChoices
		});
		await applyTransitionResult(res, {
			kind: 'spell',
			inst,
			fromZone,
			xValue,
			option,
			optionalCostCounts,
			costAidIds,
			costAidColorChoices
		});
	}

	async function triggerActivatedAbility(inst: CardInstance, ability: EffectiveActivatedAbility): Promise<void> {
		castOptionsModal = null;
		selectedPermanentForAbility = null;
		activeAutoTapPreview = null;
		await applyTransitionResult(beginAbilityTargeting({ inst, ability }), { kind: 'ability', inst, ability });
	}

	async function handleConfirmModePicker(chosenModes: number[]): Promise<void> {
		const modalCtx = modePickerModal;
		modePickerModal = null;
		if (!modalCtx) return;

		if (modalCtx.kind === 'spell' && modalCtx.fromZone) {
			await applyTransitionResult(
				beginModalTargeting({
					kind: 'spell',
					inst: modalCtx.inst,
					modal: modalCtx.modal,
					chosenModes,
					allowAllModes: modalCtx.allowAllModes,
					fromZone: modalCtx.fromZone,
					xValue: modalCtx.xValue ?? 0,
					option: modalCtx.option,
					optionalCostCounts: modalCtx.optionalCostCounts,
					costAidIds: modalCtx.costAidIds,
					costAidColorChoices: modalCtx.costAidColorChoices
				})
			);
			return;
		}
		if (modalCtx.kind === 'ability' && modalCtx.ability) {
			await applyTransitionResult(
				beginModalTargeting({
					kind: 'ability',
					inst: modalCtx.inst,
					modal: modalCtx.modal,
					chosenModes,
					allowAllModes: modalCtx.allowAllModes,
					ability: modalCtx.ability
				})
			);
		}
	}

	async function handleConfirmXCost(chosenX: number): Promise<void> {
		const ctx = xCostModal;
		xCostModal = null;
		activeAutoTapPreview = null;
		if (!ctx) return;

		if (ctx.actionKind === 'turn_face_up') {
			await dispatchGameAction({ type: 'turn_face_up', instanceId: ctx.inst.instanceId, xValue: chosenX });
			return;
		}
		if (ctx.fromZone !== 'battlefield') {
			await initiateCastSpell(
				ctx.inst,
				ctx.fromZone,
				chosenX,
				ctx.castOption,
				ctx.optionalCostCounts,
				ctx.costAidIds,
				ctx.costAidColorChoices
			);
		}
	}

	async function handleDropOnTarget(e: DragEvent, target: TargetRef): Promise<void> {
		if (!draggingCard || !me) return;
		const { inst, fromZone } = draggingCard;
		const res = beginDropTargeting(gameState, me.playerId, inst, fromZone, target);
		if (res.status === 'invalid') return;

		e.preventDefault();
		e.stopPropagation();
		draggingCard = null;
		dragOverZone = null;
		await applyTransitionResult(res);
	}

	// Auto-Tap Preview Handlers
	function handleHoverCastOptionContext(ctx: HoveredCastOptionContext | null): void {
		if (!ctx || !castOptionsModal || !me) {
			activeAutoTapPreview = null;
			return;
		}
		const base = previewSpellAutoTap(gameState, me.playerId, castOptionsModal.inst.instanceId, ctx.option, {
			optionalCostCounts: ctx.optionalCostCounts
		});
		const extraTapIds: string[] = [];
		if (ctx.costAidIds) {
			for (const aid of ctx.option.paymentAids ?? []) {
				if (aid.kind === 'tapPermanent') {
					for (const cid of ctx.costAidIds[aid.id] ?? []) {
						if (!base.tappedPermanentIds.includes(cid)) extraTapIds.push(cid);
					}
				}
			}
		}
		if (!base.canAutoTap && extraTapIds.length === 0) {
			activeAutoTapPreview = null;
			return;
		}
		activeAutoTapPreview =
			extraTapIds.length > 0
				? { ...base, tappedPermanentIds: [...base.tappedPermanentIds, ...extraTapIds] }
				: base;
	}

	function handleHoverAbilityMenuOption(ability: EffectiveActivatedAbility | null): void {
		if (!ability || !selectedPermanentForAbility || !me) {
			activeAutoTapPreview = null;
			return;
		}
		const preview = previewAbilityAutoTap(gameState, me.playerId, selectedPermanentForAbility.instanceId, ability);
		activeAutoTapPreview = preview.canAutoTap ? preview : null;
	}

	function handleEnterCommandCard(cmd: CardInstance, playable: boolean): void {
		hoverCard(cmd.card, cmd);
		if (!playable || !me || hasOpenModal) return;
		const preview = previewSpellAutoTap(gameState, me.playerId, cmd.instanceId);
		activeAutoTapPreview = preview.canAutoTap ? preview : null;
	}

	function handleLeaveCommandCard(cmd: CardInstance): void {
		leaveCard(cmd.card);
		if (!hasOpenModal) activeAutoTapPreview = null;
	}

	// Board, Avatar & Stack Click Handlers
	async function handlePermanentClick(perm: CardInstance, owner: PlayerGameState): Promise<void> {
		setInspectedCard(perm.card, perm);
		if (!me) return;
		const pView = boardVM.permanentsById[perm.instanceId];

		if (targetingSession) {
			const candidate: TargetRef = {
				kind: 'permanent',
				id: perm.instanceId,
				label: pView?.displayCard.name ?? perm.card.name
			};
			if (!canClickTargetCandidate(gameState, me.playerId, targetingSession, candidate)) return;
			await handleSelectTargetCandidate(candidate);
			return;
		}

		if (
			gameState.phase === 'declare_attackers' &&
			isMyTurn &&
			!gameState.combat.active &&
			owner.playerId === me.playerId &&
			pView?.isCreature
		) {
			combatDraft = toggleDraftAttacker(combatDraft, pView, gameState, me.playerId);
			return;
		}

		if (
			gameState.phase === 'declare_attackers' &&
			isMyTurn &&
			!gameState.combat.active &&
			owner.playerId !== me.playerId &&
			pView?.isPlaneswalker &&
			Object.keys(combatDraft.draftAttackers).length > 0
		) {
			combatDraft = retargetDraftAttackersToPlaneswalker(combatDraft, pView, owner.playerId, me.playerId);
			return;
		}

		if (gameState.phase === 'declare_blockers' && !isMyTurn) {
			if (owner.playerId === me.playerId && pView?.isCreature) {
				combatDraft = toggleOrSelectBlocker(combatDraft, pView, gameState, me.playerId);
				return;
			}
			if (combatDraft.selectedBlockerId && owner.playerId !== me.playerId) {
				combatDraft = assignSelectedBlockerToAttacker(combatDraft, perm.instanceId, gameState);
				return;
			}
		}

		if (owner.playerId === me.playerId && pView) {
			const summary = pView.actableSummary;
			if (summary.isSingleTapManaOnly) {
				if (summary.isActable) {
					await dispatchGameAction({ type: 'tap_mana', instanceId: perm.instanceId });
				}
			} else if (
				summary.activatedAbilities.length > 0 ||
				summary.unlockableFaces.length > 0 ||
				summary.turnFaceUp !== null
			) {
				activeAutoTapPreview = null;
				selectedPermanentForAbility = perm;
			}
		}
	}

	async function handlePlayerAvatarClick(targetPlayer: PlayerGameState): Promise<void> {
		if (!me) return;
		if (targetingSession) {
			const candidate: TargetRef = {
				kind: 'player',
				id: targetPlayer.playerId,
				label: targetPlayer.username
			};
			if (!canClickTargetCandidate(gameState, me.playerId, targetingSession, candidate)) return;
			await handleSelectTargetCandidate(candidate);
			return;
		}
		if (gameState.phase === 'declare_attackers' && isMyTurn && !gameState.combat.active) {
			combatDraft = retargetDraftAttackersToPlayer(combatDraft, targetPlayer, me.playerId);
		}
	}

	async function handleStackItemClick(item: StackItem): Promise<void> {
		setInspectedCard(item.card, null, item.faceIndex ?? 0);
		if (!targetingSession || !me) return;
		const candidate: TargetRef = { kind: 'stack', id: item.id, label: item.title };
		if (!canClickTargetCandidate(gameState, me.playerId, targetingSession, candidate)) return;
		await handleSelectTargetCandidate(candidate);
	}

	async function handlePrimaryArenaButton(): Promise<void> {
		if (!me || !turnCtrl.canAdvanceOrPass || stepActionPending) return;
		stepActionPending = true;
		try {
			if (turnCtrl.isConfirmingAttackers) {
				const payload = buildDeclareAttackersPayload(combatDraft);
				combatDraft = createEmptyCombatDraft();
				await dispatchGameAction(payload);
				return;
			}
			if (turnCtrl.isConfirmingBlockers) {
				const payload = buildDeclareBlockersPayload(combatDraft);
				combatDraft = createEmptyCombatDraft();
				await dispatchGameAction(payload);
				return;
			}
			await dispatchGameAction({ type: 'pass_priority' });
		} finally {
			stepActionPending = false;
		}
	}

	async function handlePassToEndOfTurn(): Promise<void> {
		if (!me || !turnCtrl.canPassToEndOfTurn || stepActionPending) return;
		stepActionPending = true;
		try {
			combatDraft = createEmptyCombatDraft();
			await dispatchGameAction({ type: 'end_turn' });
		} finally {
			stepActionPending = false;
		}
	}

	function selectAllAttackers(): void {
		if (!me || !canSelectAllAttackers) return;
		combatDraft = selectAllEligibleAttackers(combatDraft, boardVM, gameState, me.playerId);
	}

	// Demand-Driven VFX Loop & Event/Signature-Driven SVG Arrow Computation
	function ensureVfxLoopRunning(): void {
		if (vfxRafId !== 0 || typeof window === 'undefined') return;
		const stepVfx = () => {
			vfxRafId = 0;
			if (!vfxCanvas) return;
			if (vfxCanvas.width !== window.innerWidth || vfxCanvas.height !== window.innerHeight) {
				vfxCanvas.width = window.innerWidth;
				vfxCanvas.height = window.innerHeight;
			}
			const ctx = vfxCanvas.getContext('2d');
			if (ctx) vfxCtrl.stepAndDraw(ctx, vfxCanvas.width, vfxCanvas.height);
			if (vfxCtrl.particles.length > 0 || vfxCtrl.banners.length > 0) {
				vfxRafId = requestAnimationFrame(stepVfx);
			}
		};
		vfxRafId = requestAnimationFrame(stepVfx);
	}

	$effect(() => {
		const events = gameState.recentVfxEvents;
		if (events && events.length > 0) {
			const shook = vfxCtrl.processEvents(events);
			if (shook) {
				shaking = true;
				setTimeout(() => (shaking = false), 420);
			}
			if (vfxCtrl.particles.length > 0 || vfxCtrl.banners.length > 0) {
				ensureVfxLoopRunning();
			}
		}
	});

	const hasCursorArrow = $derived(targetingSession !== null || combatDraft.selectedBlockerId !== null);

	const hasAnyArrowSource = $derived.by(() => {
		if (gameState.combat.active && gameState.combat.attackers.length > 0) return true;
		if (Object.keys(combatDraft.draftAttackers).length > 0) return true;
		if (Object.keys(combatDraft.draftBlockers).length > 0) return true;
		if (combatDraft.selectedBlockerId !== null) return true;
		if (targetingSession !== null) return true;
		if (gameState.stack.some((s) => s.targets.length > 0)) return true;
		if (focusedPermanent) {
			const fid = focusedPermanent.instanceId;
			if (boardVM.hostByAttachmentId[fid] || (boardVM.attachmentsByHostId[fid]?.length ?? 0) > 0) {
				return true;
			}
		}
		return false;
	});

	const layoutSignatureKey = $derived(
		`${dockWidth}:${inspectorHeight}:${stackHeight}:${oppHeightPct}:${frontRowPct}:${consoleHeight}:${vitalsWidth}:${controlsWidth}:${pedestalWidth}:${activeZoneModalView ? 1 : 0}`
	);

	const arrowSig = $derived(
		hasAnyArrowSource
			? computeArrowSignature({
					gameState,
					draftAttackers: combatDraft.draftAttackers,
					draftAttackerWalkers: combatDraft.draftAttackerWalkers,
					draftBlockers: combatDraft.draftBlockers,
					focusInstanceId: focusedPermanent?.instanceId ?? null,
					pendingTarget: targetingSession
						? {
								instanceId: targetingSession.instanceId,
								targetKind: `${targetingSession.slotIndex}:${targetingSession.currentRequirement.targetKind}`,
								selectedTargets: pendingTargetArrowRefs
							}
						: combatDraft.selectedBlockerId
							? {
									instanceId: combatDraft.selectedBlockerId,
									targetKind: 'blocker_cursor',
									selectedTargets: []
								}
							: null,
					mousePos: hasCursorArrow ? mousePos : undefined,
					viewportWidth: viewportSize.w,
					viewportHeight: viewportSize.h,
					layoutKey: layoutSignatureKey,
					isDraggingLayout: activeDrag !== null
				})
			: ''
	);

	function recomputeArrowsNow(): void {
		if (!hasAnyArrowSource) {
			if (arrows.length > 0) arrows = [];
			return;
		}
		const next = buildArenaArrowLines({
			gameState,
			isMyTurn,
			draftAttackers: combatDraft.draftAttackers,
			draftAttackerWalkers: combatDraft.draftAttackerWalkers,
			draftBlockers: combatDraft.draftBlockers,
			selectedBlockerId: combatDraft.selectedBlockerId,
			focusedInstanceId: focusedPermanent?.instanceId ?? null,
			targetingSession: targetingSession
				? {
						instanceId: targetingSession.instanceId,
						selectedTargets: pendingTargetArrowRefs,
						cursorLabel: describeCurrentTargetSlot(targetingSession)
					}
				: null,
			mousePos,
			viewportWidth: viewportSize.w,
			viewportHeight: viewportSize.h
		});
		if (!areArrowListsEqual(next, arrows)) arrows = next;
	}

	function scheduleArrowRecompute(): void {
		if (typeof window === 'undefined' || arrowRafId !== 0) return;
		arrowRafId = requestAnimationFrame(() => {
			arrowRafId = 0;
			recomputeArrowsNow();
		});
	}

	$effect(() => {
		if (!arrowSig) {
			if (arrows.length > 0) arrows = [];
			return;
		}
		scheduleArrowRecompute();
	});

	// Global Input & Resize Listeners
	function handleRootContextMenu(e: MouseEvent): void {
		if (targetingSession || combatDraft.selectedBlockerId || draggingCard) {
			e.preventDefault();
			e.stopPropagation();
			cancelTargetingAndDrafts();
		}
	}

	function handleGlobalMouseMove(e: MouseEvent): void {
		mousePos = { x: e.clientX, y: e.clientY };
		altHeld = e.altKey;
		if (!activeDrag) return;

		if (activeDrag === 'dock') {
			dockWidth = Math.min(560, Math.max(220, window.innerWidth - e.clientX));
		} else if (activeDrag === 'inspector') {
			inspectorHeight = Math.min(520, Math.max(110, e.clientY - 42));
		} else if (activeDrag === 'stack') {
			stackHeight = Math.min(380, Math.max(75, e.clientY - (48 + inspectorHeight)));
		} else if (activeDrag === 'opp_row' && tableAreaEl) {
			const rect = tableAreaEl.getBoundingClientRect();
			oppHeightPct = Math.min(62, Math.max(18, Math.round(((e.clientY - rect.top) / Math.max(1, rect.height)) * 100)));
		} else if (activeDrag === 'player_rows' && myZonesEl) {
			const rect = myZonesEl.getBoundingClientRect();
			frontRowPct = Math.min(75, Math.max(25, Math.round(((e.clientY - rect.top) / Math.max(1, rect.height)) * 100)));
		} else if (activeDrag === 'hand_height' && myBoardEl) {
			const rect = myBoardEl.getBoundingClientRect();
			consoleHeight = Math.min(340, Math.max(122, Math.round(rect.bottom - e.clientY)));
		} else if (activeDrag === 'hand_left' && myConsoleEl) {
			const rect = myConsoleEl.getBoundingClientRect();
			vitalsWidth = Math.min(420, Math.max(118, Math.round(e.clientX - rect.left)));
		} else if (activeDrag === 'hand_right' && myConsoleEl) {
			const rect = myConsoleEl.getBoundingClientRect();
			controlsWidth = Math.min(350, Math.max(135, Math.round(rect.right - e.clientX)));
		} else if (activeDrag === 'pedestal' && myBackRowEl) {
			const rect = myBackRowEl.getBoundingClientRect();
			pedestalWidth = Math.min(340, Math.max(110, Math.round(e.clientX - rect.left)));
		}
	}

	onMount(() => {
		try {
			const saved = localStorage.getItem('magic-arena-layout');
			if (saved) {
				const parsed = JSON.parse(saved);
				if (typeof parsed.dockWidth === 'number') dockWidth = Math.min(560, Math.max(220, parsed.dockWidth));
				if (typeof parsed.inspectorHeight === 'number') inspectorHeight = Math.min(520, Math.max(110, parsed.inspectorHeight));
				if (typeof parsed.stackHeight === 'number') stackHeight = Math.min(380, Math.max(75, parsed.stackHeight));
				if (typeof parsed.oppHeightPct === 'number') oppHeightPct = Math.min(62, Math.max(18, parsed.oppHeightPct));
				if (typeof parsed.frontRowPct === 'number') frontRowPct = Math.min(75, Math.max(25, parsed.frontRowPct));
				if (typeof parsed.consoleHeight === 'number') consoleHeight = Math.min(340, Math.max(122, parsed.consoleHeight));
				if (typeof parsed.vitalsWidth === 'number') {
					const savedVitals = parsed.vitalsWidth === 265 ? 160 : parsed.vitalsWidth;
					vitalsWidth = Math.min(420, Math.max(118, savedVitals));
				}
				if (typeof parsed.controlsWidth === 'number') controlsWidth = Math.min(350, Math.max(135, parsed.controlsWidth));
				if (typeof parsed.pedestalWidth === 'number') pedestalWidth = Math.min(340, Math.max(110, parsed.pedestalWidth));
				if (
					parsed.handSortBy === 'none' ||
					parsed.handSortBy === 'cmc' ||
					parsed.handSortBy === 'name' ||
					parsed.handSortBy === 'color' ||
					parsed.handSortBy === 'type'
				) {
					handSortBy = parsed.handSortBy;
				}
				if (parsed.handSortDir === 'asc' || parsed.handSortDir === 'desc') {
					handSortDir = parsed.handSortDir;
				}
			}
		} catch {}

		const onKeyDown = (e: KeyboardEvent) => {
			if (e.keyCode === 27 || e.key === CANCEL_KEY) {
				if (
					targetingSession ||
					combatDraft.selectedBlockerId ||
					draggingCard ||
					selectedPermanentForAbility ||
					xCostModal ||
					castOptionsModal ||
					modePickerModal ||
					zoneModal
				) {
					e.preventDefault();
					e.stopPropagation();
					cancelTargetingAndDrafts();
					selectedPermanentForAbility = null;
					xCostModal = null;
					castOptionsModal = null;
					modePickerModal = null;
					zoneModal = null;
					return;
				}
			}
			if (e.key === 'Alt') {
				e.preventDefault();
				e.stopPropagation();
				altHeld = true;
			} else if (e.altKey) {
				altHeld = true;
			}
		};

		const onKeyUp = (e: KeyboardEvent) => {
			if (e.key === 'Alt') {
				e.preventDefault();
				e.stopPropagation();
				altHeld = false;
			} else if (!e.altKey) {
				altHeld = false;
			}
		};

		const onBlur = () => {
			altHeld = false;
			activeDrag = null;
			draggingCard = null;
			dragOverZone = null;
		};

		const onMouseUp = () => {
			if (activeDrag) {
				activeDrag = null;
				saveLayoutPrefs();
			}
		};

		const onResize = () => {
			viewportSize = { w: window.innerWidth, h: window.innerHeight };
			if (hasAnyArrowSource) scheduleArrowRecompute();
		};

		const onScrollCapture = () => {
			if (hasAnyArrowSource) scheduleArrowRecompute();
		};

		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('keyup', onKeyUp);
		window.addEventListener('blur', onBlur);
		window.addEventListener('mouseup', onMouseUp);
		window.addEventListener('resize', onResize, { passive: true });
		window.addEventListener('scroll', onScrollCapture, { capture: true, passive: true });

		let resizeObs: ResizeObserver | null = null;
		if (typeof ResizeObserver !== 'undefined' && tableAreaEl) {
			resizeObs = new ResizeObserver(() => {
				if (hasAnyArrowSource) scheduleArrowRecompute();
			});
			resizeObs.observe(tableAreaEl);
		}

		const secTimer = setInterval(() => {
			if (gameState.rules.turnTimerSeconds && gameState.status === 'active') {
				nowTick = Date.now();
			}
		}, 1000);

		return () => {
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('keyup', onKeyUp);
			window.removeEventListener('blur', onBlur);
			window.removeEventListener('mouseup', onMouseUp);
			window.removeEventListener('resize', onResize);
			window.removeEventListener('scroll', onScrollCapture, { capture: true });
			resizeObs?.disconnect();
			if (vfxRafId !== 0) cancelAnimationFrame(vfxRafId);
			if (arrowRafId !== 0) cancelAnimationFrame(arrowRafId);
			clearInterval(secTimer);
		};
	});
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	class="arena-root"
	class:shake={shaking}
	class:is-dragging={activeDrag !== null}
	role="application"
	onmousemove={handleGlobalMouseMove}
	oncontextmenu={handleRootContextMenu}
>
	<!-- VFX Canvas & SVG Arrows -->
	<canvas bind:this={vfxCanvas} class="vfx-canvas"></canvas>
	<svg class="vfx-svg" aria-hidden="true" overflow="visible">
		<defs>
			<filter id="arrow-glow-attack" filterUnits="userSpaceOnUse" x="-50%" y="-50%" width="200%" height="200%">
				<feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="#ff6188" flood-opacity="0.85" />
			</filter>
			<filter id="arrow-glow-block" filterUnits="userSpaceOnUse" x="-50%" y="-50%" width="200%" height="200%">
				<feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="#78dce8" flood-opacity="0.85" />
			</filter>
			<filter id="arrow-glow-target" filterUnits="userSpaceOnUse" x="-50%" y="-50%" width="200%" height="200%">
				<feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="#ffd866" flood-opacity="0.85" />
			</filter>
			<filter id="arrow-glow-attachment" filterUnits="userSpaceOnUse" x="-50%" y="-50%" width="200%" height="200%">
				<feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="#ab9df2" flood-opacity="0.85" />
			</filter>
			<marker id="arrow-attack" markerWidth="10" markerHeight="7" refX="8.5" refY="3.5" orient="auto" overflow="visible">
				<polygon points="0 0, 10 3.5, 0 7" fill="#ff6188" />
			</marker>
			<marker id="arrow-block" markerWidth="10" markerHeight="7" refX="8.5" refY="3.5" orient="auto" overflow="visible">
				<polygon points="0 0, 10 3.5, 0 7" fill="#78dce8" />
			</marker>
			<marker id="arrow-target" markerWidth="10" markerHeight="7" refX="8.5" refY="3.5" orient="auto" overflow="visible">
				<polygon points="0 0, 10 3.5, 0 7" fill="#ffd866" />
			</marker>
			<marker id="arrow-attachment" markerWidth="10" markerHeight="7" refX="8.5" refY="3.5" orient="auto" overflow="visible">
				<polygon points="0 0, 10 3.5, 0 7" fill="#ab9df2" />
			</marker>
		</defs>
		{#each arrows as ar (ar.id)}
			{@const kindKey = ar.kind === 'attack' || ar.kind === 'block' || ar.kind === 'attachment' ? ar.kind : 'target'}
			<path
				d={computeBezierPath(ar.x1, ar.y1, ar.x2, ar.y2)}
				class="bezier-arrow {ar.kind}"
				filter="url(#arrow-glow-{kindKey})"
				marker-end="url(#arrow-{kindKey})"
			/>
		{/each}
	</svg>

	<AltHoverPreview
		card={altPreviewResolved?.card ?? null} {altHeld} mouseX={mousePos.x} mouseY={mousePos.y}
		breakdown={hoverBreakdown} imageUrlOverride={altPreviewResolved?.imageUrlOverride}
	/>

	<HudBar
		{gameState} viewer={me} {lobbyCode} {ropeRemainingSec} waitingOnPlayerIds={boardVM.waitingOnPlayerIds}
		{theme} {shortcutsDisabled} {onLeaveMatch} onResetLayout={resetLayoutPrefs} {onToggleTheme}
		onGameAction={dispatchGameAction} onPrimaryAction={handlePrimaryArenaButton} onPassTurn={handlePassToEndOfTurn}
	/>

	{#if targetingSession}
		<TargetBanner
			session={targetingSession} zoneDrawerOpen={activeZoneModalView !== null}
			onConfirmSlot={handleConfirmTargetSlot} onSkipOptionalSlot={handleConfirmTargetSlot}
			onBackSlot={handleStepBackTargetSlot} onCancel={cancelTargetingAndDrafts}
			onOpenZoneDrawer={(zone) => { if (targetingSession) zoneModal = buildTargetingZoneModal(targetingSession, zone); }}
		/>
	{/if}

	{#if combatForecast.active}
		{@const atkList = Object.values(combatForecast.attackerSummaries)}
		{@const unblockedTotal = atkList.filter((a) => !a.isBlocked).length}
		{@const blockedTotal = atkList.filter((a) => a.isBlocked).length}
		{@const dyingAttackers = atkList.filter((a) => a.attackerDies).length}
		{@const dyingBlockers = Object.values(combatForecast.blockerSummaries).filter((b) => b.blockerDies).length}
		{@const attackedPlayers = Object.values(combatForecast.playerIncoming).filter(
			(p) => p.unblockedCount > 0 || p.blockedCount > 0 || p.totalLifeLoss > 0 || p.totalPoisonGain > 0
		)}
		{@const attackedWalkers = Object.values(combatForecast.planeswalkerIncoming)}
		<div class="combat-forecast-bar" role="status" aria-live="polite">
			<div class="cfb-section">
				<span class="cfb-title">⚔️ COMBAT FORECAST</span>
				<span class="cfb-pill">{atkList.length} Attacking ({unblockedTotal} Unblocked, {blockedTotal} Blocked)</span>
			</div>
			<div class="cfb-section">
				{#each attackedPlayers as pInc (pInc.playerId)}
					<span class="cfb-pill player-dmg" class:lethal={pInc.isLethal} class:safe={pInc.totalLifeLoss === 0 && pInc.totalPoisonGain === 0}>
						<strong>{pInc.playerId === me?.playerId ? 'YOU' : pInc.username}:</strong>
						{#if pInc.totalLifeLoss > 0}-{pInc.totalLifeLoss} Life ({pInc.projectedLife + pInc.totalLifeLoss} → {pInc.projectedLife}){/if}
						{#if pInc.totalPoisonGain > 0}+{pInc.totalPoisonGain} Poison ({pInc.projectedPoison - pInc.totalPoisonGain} → {pInc.projectedPoison}){/if}
						{#if pInc.totalLifeLoss === 0 && pInc.totalPoisonGain === 0}0 Damage (All Blocked){/if}
						{#if pInc.trampleThroughDamage > 0}<span class="cfb-sub">({pInc.trampleThroughDamage} Trample)</span>{/if}
						{#if pInc.isLethal}<strong class="lethal-tag">💀 LETHAL ({pInc.lethalReason})</strong>{/if}
					</span>
				{/each}
				{#each attackedWalkers as pwInc (pwInc.instanceId)}
					<span class="cfb-pill walker-dmg" class:lethal={pwInc.willDie}>
						<strong>🛡️ {pwInc.name}:</strong> -{pwInc.loyaltyLoss} Loyalty (L:{pwInc.currentLoyalty} → L:{pwInc.projectedLoyalty})
						{#if pwInc.willDie}<strong class="lethal-tag">💀 DESTROYED</strong>{/if}
					</span>
				{/each}
				{#if dyingAttackers > 0 || dyingBlockers > 0}
					<span class="cfb-pill casualties">
						💀 Casualties:
						{#if dyingAttackers > 0}{dyingAttackers} Attacker{dyingAttackers > 1 ? 's' : ''}{/if}
						{#if dyingAttackers > 0 && dyingBlockers > 0}, {/if}
						{#if dyingBlockers > 0}{dyingBlockers} Blocker{dyingBlockers > 1 ? 's' : ''}{/if}
					</span>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Main Arena Grid: Battlefield Table + Vertical Resizer + Right Dock -->
	<div class="arena-main" style="grid-template-columns: minmax(0, 1fr) 6px {dockWidth}px;">
		<div bind:this={tableAreaEl} class="table-area">
			<div class="opponents-row" style="height: {oppHeightPct}%;">
				{#each opponents as opp (opp.playerId)}
					{@const oppStatus = boardVM.playerStatusesById[opp.playerId]}
					{#if oppStatus}
						<OpponentPod
							opponent={opp} status={oppStatus} boardViews={boardVM.opponentBoardsById[opp.playerId] ?? []}
							commanderTaxIncrement={gameState.rules.commanderTaxIncrement}
							activeTurn={activePlayer?.playerId === opp.playerId} hasPriority={priorityPlayer?.playerId === opp.playerId}
							targetable={isPlayerTargetableNow(opp)} isThinkingBot={thinkingBotId === opp.playerId}
							isWaitingOnPrompt={boardVM.waitingOnPlayerIds.includes(opp.playerId)} canAcceptDrop={draggingCard !== null}
							incomingForecast={combatForecast.active ? combatForecast.playerIncoming[opp.playerId] : undefined}
							combatForecast={combatForecast.active ? combatForecast : undefined} selectedTargetIds={selectedTargetIdList}
							isPermanentActable={isPermanentActableForBoard} isAttachmentLinked={isAttachmentLinkedToFocus}
							onAvatarClick={handlePlayerAvatarClick} onDropTarget={handleDropOnTarget}
							onOpenZoneModal={(req) => (zoneModal = req)} onHoverCard={hoverCard} onLeaveCard={(card) => leaveCard(card)}
							onInspectCard={(card, inst) => setInspectedCard(card, inst)} onPermanentClick={handlePermanentClick}
						/>
					{/if}
				{/each}
			</div>

			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="resizer-h" title="Drag to resize Opponent Boards vs. Your Battlefield" onmousedown={() => (activeDrag = 'opp_row')}>
				<span class="grip-dots"></span>
			</div>

			{#if me}
				{@const myStatus = boardVM.playerStatusesById[me.playerId]}
				<section bind:this={myBoardEl} class="my-board" class:active-turn={isMyTurn} class:has-prio={hasPriority}>
					<div bind:this={myZonesEl} class="my-battlefield-split">
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="my-row front-row"
							class:drop-zone-valid={validDragZones.has('front_row')}
							class:drop-zone-active={dragOverZone === 'front_row' && validDragZones.has('front_row')}
							style="height: {frontRowPct}%;"
							ondragover={(e) => handleZoneDragOver(e, 'front_row')}
							ondragleave={(e) => handleZoneDragLeave(e, 'front_row')}
							ondrop={(e) => handleZoneDrop(e, 'front_row')}
						>
							<div class="row-watermark">
								<span>CREATURES &amp; PLANESWALKERS ({boardVM.frontRow.length})</span>
								{#if validDragZones.has('front_row')}<span class="drop-zone-pill">DROP TO CAST</span>{/if}
								<button
									type="button" class="row-atk-all-btn" disabled={!canSelectAllAttackers}
									title={canSelectAllAttackers ? 'Assign all eligible creatures to attack' : 'Available during your Declare Attackers step when you control an eligible attacker'}
									onclick={(e) => { e.stopPropagation(); selectAllAttackers(); }}
								>All Attack</button>
							</div>
							{#each boardVM.frontRow as pView (pView.instanceId)}
								<PermanentCard
									view={pView} variant="front" actable={isPermanentActableForBoard(pView.perm, me)}
									selectedTarget={selectedTargetIdSet.has(pView.instanceId)} isAutoTapPreviewed={autoTapTappedSet.has(pView.instanceId)}
									draftAttacking={Boolean(combatDraft.draftAttackers[pView.instanceId])}
									draftBlocking={Boolean(combatDraft.draftBlockers[pView.instanceId]) || combatDraft.selectedBlockerId === pView.instanceId}
									attachmentLinked={isAttachmentLinkedToFocus(pView.perm)} canAcceptDrop={draggingCard !== null}
									attackerForecast={combatForecast.active ? combatForecast.attackerSummaries[pView.instanceId] : undefined}
									blockerForecast={combatForecast.active ? combatForecast.blockerSummaries[pView.instanceId] : undefined}
									planeswalkerForecast={combatForecast.active ? combatForecast.planeswalkerIncoming[pView.instanceId] : undefined}
									onHover={hoverCard} onLeave={(card) => leaveCard(card)}
									onClick={(perm) => handlePermanentClick(perm, me)} onDropTarget={handleDropOnTarget}
								/>
							{/each}
						</div>

						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="resizer-h subtle" title="Drag to adjust Creatures row vs. Lands/Artifacts row" onmousedown={() => (activeDrag = 'player_rows')}>
							<span class="grip-dots"></span>
						</div>

						<div bind:this={myBackRowEl} class="my-row back-row" style="height: {100 - frontRowPct}%;">
							<div class="command-pedestal" style="width: {pedestalWidth}px;">
								<span class="pedestal-label">COMMAND ZONE</span>
								<div class="pedestal-cards">
									{#each me.command as cmd (cmd.instanceId)}
										{@const playable = isZoneCardPlayableNow(cmd, 'command')}
										<button
											type="button" class="board-card cmd-card" class:playable={playable} class:unactable={!playable}
											class:dragging-source={draggingCard?.inst.instanceId === cmd.instanceId}
											draggable={playable} data-game-id={cmd.instanceId}
											onmouseenter={() => handleEnterCommandCard(cmd, playable)} onmouseleave={() => handleLeaveCommandCard(cmd)}
											ondragstart={(e) => handleCardDragStart(e, cmd, 'command')} ondragend={handleCardDragEnd}
											onclick={() => handlePlayCardFromZone(cmd, 'command')}
										>
											<img src={cmd.card.artCropUrl} alt={cmd.card.name} />
											<div class="bc-overlay">
												<span class="bc-name">{cmd.card.name}</span>
												<span class="badge gold">Tax: +{cmd.commanderCastCount * gameState.rules.commanderTaxIncrement}</span>
											</div>
										</button>
									{/each}
								</div>
							</div>

							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div class="resizer-v subtle" title="Drag to resize Command Zone pedestal width" onmousedown={() => (activeDrag = 'pedestal')}>
								<span class="grip-dots-v"></span>
							</div>

							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="lands-area"
								class:drop-zone-valid={validDragZones.has('lands_area')}
								class:drop-zone-active={dragOverZone === 'lands_area' && validDragZones.has('lands_area')}
								ondragover={(e) => handleZoneDragOver(e, 'lands_area')}
								ondragleave={(e) => handleZoneDragLeave(e, 'lands_area')}
								ondrop={(e) => handleZoneDrop(e, 'lands_area')}
							>
								<div class="row-watermark">
									LANDS, ARTIFACTS &amp; ENCHANTMENTS ({boardVM.backRow.length})
									{#if validDragZones.has('lands_area')}<span class="drop-zone-pill">{dragDropZoneLabel}</span>{/if}
								</div>
								{#each boardVM.backRow as pView (pView.instanceId)}
									<PermanentCard
										view={pView} variant="back" actable={isPermanentActableForBoard(pView.perm, me)}
										selectedTarget={selectedTargetIdSet.has(pView.instanceId)} isAutoTapPreviewed={autoTapTappedSet.has(pView.instanceId)}
										attachmentLinked={isAttachmentLinkedToFocus(pView.perm)} canAcceptDrop={draggingCard !== null}
										onHover={hoverCard} onLeave={(card) => leaveCard(card)}
										onClick={(perm) => handlePermanentClick(perm, me)} onDropTarget={handleDropOnTarget}
									/>
								{/each}
							</div>
						</div>
					</div>

					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class="resizer-h subtle" title="Drag to resize Hand &amp; Bottom Console height" onmousedown={() => (activeDrag = 'hand_height')}>
						<span class="grip-dots"></span>
					</div>

					<div
						bind:this={myConsoleEl} class="my-console"
						style="height: {consoleHeight}px; --vitals-w: {vitalsWidth}px; --controls-w: {controlsWidth}px; --hc-h: {Math.max(66, consoleHeight - 44)}px; --hc-w: {Math.round(Math.max(66, consoleHeight - 44) * 0.72)}px;"
					>
						{#if myStatus}
							<PlayerVitals
								player={me} status={myStatus} playableGraveyardCount={boardVM.playableGraveyardIds.length}
								permittedExileCards={boardVM.permittedExileCards} playableExileCount={boardVM.playableExileCards.length}
								incomingForecast={combatForecast.active ? combatForecast.playerIncoming[me.playerId] : undefined}
								targetable={isPlayerTargetableNow(me)} canAcceptDrop={draggingCard !== null}
								previewManaPoolSpent={activeAutoTapPreview?.manaPoolSpent} previewEnergySpent={activeAutoTapPreview?.energySpent ?? 0}
								onAvatarClick={handlePlayerAvatarClick} onDropTarget={handleDropOnTarget} onOpenZoneModal={(req) => (zoneModal = req)}
							/>
						{/if}

						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="resizer-v subtle" title="Drag to resize Left Status / Mana side section vs. Hand" onmousedown={() => (activeDrag = 'hand_left')}>
							<span class="grip-dots-v"></span>
						</div>

						<HandTray
							hand={me.hand} handPlayabilityById={boardVM.handPlayabilityById} playerId={me.playerId} {gameState}
							sortBy={handSortBy} sortDir={handSortDir} draggingInstanceId={draggingCard?.inst.instanceId ?? null}
							interactionBlocked={Boolean(targetingSession || myPrompt)}
							onSortByChange={setHandSort} onSortDirChange={setHandSortDir}
							onHoverCard={(card, inst) => hoverCard(card, inst)} onLeaveCard={(card) => leaveCard(card)}
							onAutoTapPreviewChange={(preview) => { if (!hasOpenModal) activeAutoTapPreview = preview; }}
							onCardClick={(inst) => handlePlayCardFromZone(inst, 'hand')}
							onCardDragStart={(e, inst) => handleCardDragStart(e, inst, 'hand')}
							onCardDragEnd={handleCardDragEnd} onGameAction={dispatchGameAction}
						/>

						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="resizer-v subtle" title="Drag to resize Hand vs. Right Action Controls side section" onmousedown={() => (activeDrag = 'hand_right')}>
							<span class="grip-dots-v"></span>
						</div>

						<div class="arena-controls">
							<div
								class="turn-phase-box" class:my-turn={isMyTurn} class:has-prio={hasPriority}
								title="Turn {gameState.turnNumber} ({activePlayer?.username ?? '—'}) — {turnCtrl.phaseDetail.phaseTitle}: {turnCtrl.phaseDetail.stepTitle} | Priority: {priorityPlayer?.username ?? '—'}"
							>
								<div class="tpb-top">
									<span class="tpb-turn">T{gameState.turnNumber} · {isMyTurn ? 'YOUR TURN' : (activePlayer?.username ?? '—')}</span>
									<span class="tpb-prio" class:mine={hasPriority}>{hasPriority ? 'PRIO' : (priorityPlayer?.username ?? '—')}</span>
								</div>
								<div class="tpb-step-row">
									<span class="tpb-phase">{turnCtrl.phaseDetail.phaseTitle}</span>
									<span class="tpb-sep" aria-hidden="true">›</span>
									<span class="tpb-step">{turnCtrl.phaseDetail.stepTitle}</span>
								</div>
								<div class="tpb-pips" aria-hidden="true">
									{#each TURN_PHASE_GROUPS as grp, idx (grp.id)}
										<span class="tpb-pip" class:done={idx < turnCtrl.phaseDetail.groupIndex} class:active={idx === turnCtrl.phaseDetail.groupIndex}></span>
									{/each}
								</div>
							</div>

							<button
								type="button" class="turn-ctrl-btn primary-step-btn"
								class:can-act={turnCtrl.canAdvanceOrPass} class:stack-active={gameState.stack.length > 0 && turnCtrl.canAdvanceOrPass}
								disabled={!turnCtrl.canAdvanceOrPass} title={turnCtrl.primaryStepTitle} onclick={handlePrimaryArenaButton}
							><span class="turn-ctrl-label">{turnCtrl.primaryStepLabel}</span></button>

							<button
								type="button" class="turn-ctrl-btn end-turn-btn" class:can-act={turnCtrl.canPassToEndOfTurn}
								disabled={!turnCtrl.canPassToEndOfTurn} title={turnCtrl.endTurnTitle} onclick={handlePassToEndOfTurn}
							><span class="turn-ctrl-label">Pass to End of Turn</span></button>
						</div>
					</div>
				</section>
			{/if}
		</div>

		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="resizer-v" title="Drag to resize Right Dock width" onmousedown={() => (activeDrag = 'dock')}>
			<span class="grip-dots-v"></span>
		</div>

		<RightDock
			{gameState} {chatMessages} {inspectedCard} {inspectedInstance} bind:inspectedFaceIndex
			{inspectorHeight} {stackHeight} {inspectBreakdown} {canResolveInspectedManually}
			isStackDropValid={validDragZones.has('stack')} isStackDragOver={dragOverZone === 'stack' && validDragZones.has('stack')}
			isDraggingCard={draggingCard !== null} isStackItemTargetable={isStackItemTargetableNow}
			onStartResize={(handle) => (activeDrag = handle)}
			onStackDragOver={(e) => handleZoneDragOver(e, 'stack')} onStackDragLeave={(e) => handleZoneDragLeave(e, 'stack')}
			onStackDrop={(e) => handleZoneDrop(e, 'stack')} onStackItemClick={handleStackItemClick}
			onDropOnStackTarget={handleDropOnTarget} onHoverCard={hoverCard} onLeaveCard={leaveCard}
			onGameAction={dispatchGameAction} {onSendChat}
		/>
	</div>

	{#if selectedPermanentForAbility && me}
		<AbilityMenuModal
			{gameState} actor={me} inst={selectedPermanentForAbility} onActivateAbility={triggerActivatedAbility}
			onTurnFaceUp={async (inst, choosesX) => {
				selectedPermanentForAbility = null; activeAutoTapPreview = null;
				if (choosesX) xCostModal = { inst, fromZone: 'battlefield', actionKind: 'turn_face_up' };
				else await dispatchGameAction({ type: 'turn_face_up', instanceId: inst.instanceId });
			}}
			onUnlockRoomDoor={async (inst, faceIndex) => {
				selectedPermanentForAbility = null; activeAutoTapPreview = null;
				await dispatchGameAction({ type: 'unlock_room_door', instanceId: inst.instanceId, faceIndex });
			}}
			onHandSpecialAction={async (inst: CardInstance, action: HandSpecialActionOption) => {
				selectedPermanentForAbility = null; activeAutoTapPreview = null;
				await dispatchGameAction({ type: 'hand_special_action', instanceId: inst.instanceId, actionId: action.id });
			}}
			onGameAction={dispatchGameAction} onHoverAbility={handleHoverAbilityMenuOption}
			onClose={() => { selectedPermanentForAbility = null; activeAutoTapPreview = null; }}
		/>
	{/if}

	{#if castOptionsModal && me}
		<CastOptionsModal
			{gameState} actor={me} inst={castOptionsModal.inst} fromZone={castOptionsModal.fromZone}
			options={castOptionsModal.options} landOptions={castOptionsModal.landOptions} zoneAbilities={castOptionsModal.zoneAbilities}
			onSelectOption={proceedCastWithOption}
			onPlayLand={async (inst, fromZone, faceIndex) => {
				castOptionsModal = null; activeAutoTapPreview = null;
				await dispatchGameAction({ type: 'play_land', instanceId: inst.instanceId, fromZone, faceIndex });
			}}
			onActivateAbility={triggerActivatedAbility} onHoverOptionContext={handleHoverCastOptionContext}
			onCancel={() => { castOptionsModal = null; activeAutoTapPreview = null; }}
		/>
	{/if}

	{#if modePickerModal}
		<ModePickerModal
			inst={modePickerModal.inst} modal={modePickerModal.modal} modeLabels={modePickerModal.modeLabels}
			disabledIndices={modePickerModal.disabledIndices} allowAllModes={modePickerModal.allowAllModes}
			onConfirm={handleConfirmModePicker} onCancel={() => (modePickerModal = null)}
		/>
	{/if}

	{#if xCostModal && me}
		<XCostModal
			{gameState} actor={me} inst={xCostModal.inst} fromZone={xCostModal.fromZone} actionKind={xCostModal.actionKind}
			castOption={xCostModal.castOption} optionalCostCounts={xCostModal.optionalCostCounts}
			costAidIds={xCostModal.costAidIds} costAidColorChoices={xCostModal.costAidColorChoices}
			onConfirm={handleConfirmXCost} onCancel={() => { xCostModal = null; activeAutoTapPreview = null; }}
		/>
	{/if}

	{#if activeZoneModalView}
		<ZoneBrowserModal
			ownerName={activeZoneModalView.ownerName} title={activeZoneModalView.title} cards={activeZoneModalView.cards}
			{gameState} viewer={me ?? null} isZoneTargeting={isZoneModalTargeting}
			selectedTargets={targetingSession?.selectedTargets ?? []} minTargets={targetingSession?.currentRequirement.minTargets ?? 1}
			isCardTargetable={(inst) => {
				if (!targetingSession || !me) return false;
				const disp = resolveCardInstanceDisplay(inst, inst.zone, me.playerId);
				return canClickTargetCandidate(gameState, me.playerId, targetingSession, {
					kind: inst.zone === 'exile' ? 'exile_card' : 'graveyard_card',
					id: inst.instanceId,
					label: disp.displayCard.name
				});
			}}
			isCardPlayableNow={(inst, zone) => isZoneCardPlayableNow(inst, zone)}
			getZoneAbilitiesOverride={(inst, zone) => getZoneActivatedAbilities(inst, zone)}
			onSelectTarget={handleSelectTargetCandidate} onConfirmTargets={handleConfirmTargetSlot}
			onCancelTargeting={cancelTargetingAndDrafts} onPlayFromZone={(inst, zone) => handlePlayCardFromZone(inst, zone)}
			onGameAction={dispatchGameAction} onClose={() => (zoneModal = null)} onHoverCard={hoverCard} onLeaveCard={leaveCard}
		/>
	{/if}

	{#if myPrompt && me}
		<ChoicePromptModal
			prompt={myPrompt} {gameState} viewer={me} {handSortBy} {handSortDir} {sortedHand}
			onSetHandSort={setHandSort} onSetHandSortDir={setHandSortDir}
			onGameAction={dispatchGameAction} onHoverCard={hoverCard} onLeaveCard={leaveCard}
		/>
	{/if}

	<VictoryModal {gameState} {onLeaveMatch} />
</div>

<style>
	.arena-root {
		position: fixed;
		inset: 0;
		background: var(--mp-bg);
		color: var(--mp-text);
		font-family: var(--mono-font, monospace);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		user-select: none;
		z-index: 100;
	}
	.arena-root.is-dragging { cursor: grabbing; }
	.arena-root.shake { animation: arena-shake 0.4s cubic-bezier(0.36, 0.07, 0.19, 0.97) both; }

	@keyframes arena-shake {
		10%, 90% { transform: translate3d(-3px, 1px, 0); }
		20%, 80% { transform: translate3d(5px, -2px, 0); }
		30%, 50%, 70% { transform: translate3d(-6px, 3px, 0); }
		40%, 60% { transform: translate3d(6px, -2px, 0); }
	}

	.vfx-canvas, .vfx-svg {
		position: fixed;
		inset: 0;
		width: 100vw;
		height: 100vh;
		pointer-events: none;
		overflow: visible;
		z-index: 260;
	}

	.bezier-arrow { fill: none; stroke-width: 3.5; stroke-dasharray: 8 5; animation: dash-flow 0.6s linear infinite; }
	.bezier-arrow.attack { stroke: var(--mp-red); }
	.bezier-arrow.block { stroke: var(--mp-cyan); }
	.bezier-arrow.target, .bezier-arrow.active_cursor { stroke: var(--mp-yellow); }
	.bezier-arrow.attachment { stroke: var(--mp-purple); stroke-width: 2.5; stroke-dasharray: 5 4; }

	@keyframes dash-flow { to { stroke-dashoffset: -26; } }

	.resizer-v {
		width: 6px;
		background: var(--mp-border-subtle);
		cursor: col-resize;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: background 0.14s ease;
		z-index: 165;
	}
	.resizer-v.subtle { width: 6px; align-self: stretch; border-radius: 3px; flex-shrink: 0; }
	.resizer-v:hover { background: var(--mp-accent); }
	.grip-dots-v { width: 2px; height: 28px; background: var(--mp-border-strong); border-radius: 2px; }

	.resizer-h {
		height: 6px;
		background: var(--mp-border-subtle);
		cursor: row-resize;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: background 0.14s ease;
		z-index: 165;
	}
	.resizer-h.subtle { height: 5px; background: transparent; border-top: 1px dashed var(--mp-border); }
	.resizer-h:hover { background: var(--mp-accent); }
	.grip-dots { width: 28px; height: 2px; background: var(--mp-border-strong); border-radius: 2px; }

	.combat-forecast-bar {
		background: linear-gradient(90deg, rgba(42, 22, 32, 0.95), rgba(28, 25, 34, 0.95));
		border-bottom: 1.5px solid var(--mp-red);
		padding: 0.32rem 0.85rem;
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.5rem;
		font-size: 0.74rem;
		z-index: 162;
	}
	.cfb-section { display: flex; align-items: center; flex-wrap: wrap; gap: 0.45rem; }
	.cfb-title { font-weight: 800; color: var(--mp-red); letter-spacing: 0.04em; }
	.cfb-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.28rem;
		padding: 0.12rem 0.48rem;
		border-radius: 5px;
		background: rgba(18, 16, 22, 0.88);
		border: 1px solid var(--mp-border-strong);
		color: var(--mp-text);
		font-size: 0.7rem;
	}
	.cfb-pill.player-dmg { border-color: var(--mp-red); color: #ffd866; }
	.cfb-pill.player-dmg.safe { border-color: var(--mp-cyan); color: var(--mp-cyan); }
	.cfb-pill.player-dmg.lethal, .cfb-pill.walker-dmg.lethal {
		background: rgba(255, 97, 136, 0.24);
		border-color: #ff6188;
		color: #ff6188;
		box-shadow: 0 0 10px rgba(255, 97, 136, 0.45);
	}
	.cfb-pill.walker-dmg { border-color: var(--mp-purple); color: var(--mp-purple); }
	.cfb-pill.casualties { border-color: var(--mp-orange, #fc9867); color: #fc9867; }
	.cfb-sub { font-size: 0.64rem; opacity: 0.88; }
	.lethal-tag { color: #ff6188; margin-left: 0.2rem; }

	.arena-main { flex: 1; display: grid; min-height: 0; }
	.table-area { display: flex; flex-direction: column; padding: 0.45rem 0.65rem; gap: 0.35rem; min-height: 0; overflow: hidden; }
	.opponents-row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 0.5rem;
		min-height: 120px;
		flex-shrink: 0;
	}

	.my-board {
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border);
		border-radius: 10px;
		padding: 0.45rem 0.65rem;
		min-height: 0;
	}
	.my-board.active-turn { border-color: var(--mp-cyan); }
	.my-board.has-prio { border-color: var(--mp-accent); }
	.my-battlefield-split { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
	.my-row {
		position: relative;
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		align-content: flex-start;
		gap: 0.45rem;
		padding: 0.25rem 0;
		overflow-y: auto;
		min-height: 55px;
	}
	.my-row.back-row { flex-wrap: nowrap; align-items: stretch; gap: 0.35rem; }
	.row-watermark {
		position: absolute;
		right: 0.5rem;
		top: 0.2rem;
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.6rem;
		color: var(--mp-text-faint);
		pointer-events: none;
		z-index: 14;
	}
	.row-atk-all-btn {
		pointer-events: auto;
		background: var(--mp-bg);
		color: var(--mp-red);
		border: 1px solid var(--mp-red);
		border-radius: 4px;
		padding: 0.08rem 0.38rem;
		font-family: inherit;
		font-size: 0.6rem;
		font-weight: 700;
		line-height: 1.2;
		cursor: pointer;
		transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease, opacity 0.14s ease;
	}
	.row-atk-all-btn:hover:not(:disabled) { background: var(--mp-red); color: #19181a; }
	.row-atk-all-btn:disabled {
		background: var(--mp-bg-subtle);
		color: var(--mp-text-muted);
		border-color: var(--mp-border);
		opacity: 0.42;
		cursor: not-allowed;
	}

	.command-pedestal { display: flex; flex-direction: column; gap: 0.2rem; padding-right: 0.25rem; flex-shrink: 0; overflow-x: auto; }
	.pedestal-label { font-size: 0.58rem; color: var(--mp-accent); letter-spacing: 0.06em; font-weight: 700; }
	.pedestal-cards { display: flex; flex-wrap: wrap; gap: 0.35rem; }
	.board-card.cmd-card {
		position: relative;
		width: 104px;
		height: 78px;
		border-radius: 6px;
		border: 1.5px solid var(--mp-border-strong);
		background: var(--mp-bg);
		padding: 0;
		overflow: hidden;
		cursor: pointer;
		transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
	}
	.board-card.cmd-card:hover { transform: translateY(-3px) scale(1.03); border-color: var(--mp-cyan); z-index: 10; }
	.board-card.cmd-card.playable { border-color: var(--mp-cyan); box-shadow: 0 0 10px rgba(120, 220, 232, 0.45); cursor: grab; }
	.board-card.cmd-card.dragging-source { opacity: 0.45; cursor: grabbing; }
	.board-card.cmd-card.unactable::after {
		content: '';
		position: absolute;
		inset: 0;
		background: linear-gradient(180deg, rgba(6, 5, 10, 0.52) 0%, rgba(8, 7, 14, 0.58) 100%);
		box-shadow: inset 0 0 12px rgba(0, 0, 0, 0.55);
		border-radius: inherit;
		pointer-events: none;
		z-index: 4;
		transition: opacity 0.14s ease;
	}
	.board-card.cmd-card.unactable:hover::after { opacity: 0.2; }
	.board-card.cmd-card img { width: 100%; height: 100%; object-fit: cover; }
	.bc-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		padding: 3px 4px;
		background: linear-gradient(180deg, rgba(0, 0, 0, 0.6) 0%, transparent 45%, rgba(0, 0, 0, 0.82) 100%);
	}
	.bc-name { font-size: 0.62rem; font-weight: 600; color: #fcfcfa; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.badge.gold { align-self: flex-start; font-size: 0.54rem; font-weight: 700; padding: 1px 4px; border-radius: 3px; background: #ffd866; color: #19181a; }

	.lands-area {
		position: relative;
		flex: 1;
		min-width: 0;
		display: flex;
		flex-wrap: wrap;
		align-content: flex-start;
		gap: 0.4rem;
		overflow-y: auto;
		padding-left: 0.25rem;
		border-radius: 6px;
		transition: background 0.16s ease, box-shadow 0.16s ease, outline-color 0.16s ease;
	}
	.front-row.drop-zone-valid, .lands-area.drop-zone-valid {
		outline: 1.5px dashed rgba(255, 216, 102, 0.72);
		outline-offset: -2px;
		background: rgba(255, 216, 102, 0.06);
		box-shadow: inset 0 0 18px rgba(255, 216, 102, 0.14);
	}
	.front-row.drop-zone-active, .lands-area.drop-zone-active {
		outline: 2px solid #ffd866;
		outline-offset: -2px;
		background: rgba(255, 216, 102, 0.14);
		box-shadow: inset 0 0 24px rgba(255, 216, 102, 0.28);
	}
	.drop-zone-pill {
		display: inline-block;
		margin-left: 0.45rem;
		padding: 0.08rem 0.42rem;
		border-radius: 4px;
		background: rgba(255, 216, 102, 0.2);
		border: 1px solid #ffd866;
		color: #ffd866;
		font-size: 0.58rem;
		font-weight: 700;
		letter-spacing: 0.05em;
	}

	.my-console {
		display: grid;
		grid-template-columns: var(--vitals-w, 160px) 6px minmax(0, 1fr) 6px var(--controls-w, 185px);
		align-items: stretch;
		gap: 0.35rem;
		padding-top: 0.2rem;
		flex-shrink: 0;
		min-height: 122px;
	}
	.arena-controls { display: grid; grid-template-rows: 42px 34px 34px; gap: 4px; align-content: center; min-width: 0; }
	.turn-phase-box {
		height: 42px;
		box-sizing: border-box;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border-strong);
		border-radius: 7px;
		padding: 3px 7px 4px;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		min-width: 0;
		overflow: hidden;
	}
	.turn-phase-box.my-turn { border-color: var(--mp-border-strong); }
	.turn-phase-box.has-prio { border-color: var(--mp-accent); }
	.tpb-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.25rem;
		font-size: 0.56rem;
		font-weight: 700;
		letter-spacing: 0.03em;
		line-height: 1.1;
		color: var(--mp-text-muted);
		min-width: 0;
	}
	.tpb-turn { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
	.turn-phase-box.my-turn .tpb-turn { color: var(--mp-text); }
	.tpb-prio { flex-shrink: 0; max-width: 58px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--mp-text-faint); }
	.tpb-prio.mine { color: var(--mp-accent); }
	.tpb-step-row { display: flex; align-items: baseline; gap: 0.22rem; font-size: 0.67rem; line-height: 1.15; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
	.tpb-phase { font-weight: 700; color: var(--mp-cyan); flex-shrink: 0; }
	.tpb-sep { color: var(--mp-text-faint); font-size: 0.62rem; flex-shrink: 0; }
	.tpb-step { font-weight: 700; color: var(--mp-text); overflow: hidden; text-overflow: ellipsis; }
	.tpb-pips { display: grid; grid-template-columns: repeat(5, 1fr); gap: 3px; height: 3px; flex-shrink: 0; }
	.tpb-pip { background: var(--mp-border); border-radius: 2px; }
	.tpb-pip.done { background: var(--mp-cyan); opacity: 0.5; }
	.tpb-pip.active { background: var(--mp-accent); }

	.turn-ctrl-btn {
		width: 100%;
		height: 34px;
		box-sizing: border-box;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0 0.55rem;
		border-radius: 7px;
		border: 1.5px solid var(--mp-border-strong);
		background: var(--mp-bg-subtle);
		color: var(--mp-text-muted);
		font-family: inherit;
		font-size: 0.74rem;
		font-weight: 700;
		line-height: 1;
		cursor: pointer;
		min-width: 0;
		overflow: hidden;
		transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease, opacity 0.14s ease;
	}
	.turn-ctrl-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
	.turn-ctrl-btn.primary-step-btn.can-act { background: var(--mp-btn-bg); color: var(--mp-btn-fg); border-color: var(--mp-btn-bg); }
	.turn-ctrl-btn.primary-step-btn.can-act:hover:not(:disabled) { background: var(--mp-btn-hover); color: var(--mp-btn-hover-fg); border-color: var(--mp-btn-hover); }
	.turn-ctrl-btn.primary-step-btn.stack-active { background: var(--mp-cyan); color: #19181a; border-color: var(--mp-cyan); }
	.turn-ctrl-btn.end-turn-btn.can-act { background: var(--mp-bg); color: var(--mp-orange); border-color: var(--mp-orange); }
	.turn-ctrl-btn.end-turn-btn.can-act:hover:not(:disabled) { background: var(--mp-orange); color: #19181a; }
	.turn-ctrl-btn:disabled {
		background: var(--mp-bg-subtle);
		color: var(--mp-text-faint, var(--mp-text-muted));
		border-color: var(--mp-border);
		opacity: 0.42;
		cursor: not-allowed;
		box-shadow: none;
	}
</style>
