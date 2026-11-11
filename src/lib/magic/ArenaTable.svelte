<script lang="ts">
	import { onMount } from 'svelte';
	import {
		canPayOrAutoTap,
		checkAbilityActivationLegality,
		checkEndTurnLegality,
		checkLandPlayLegality,
		checkMandatoryAttackersSatisfied,
		checkSpellCastLegality,
		checkSuspendLegality,
		computeCombatDamageForecast,
		getAttachedCardsOnBoard,
		getCreaturePower,
		getCreatureToughness,
		getEffectiveActivatedAbilities,
		getHostCardOnBoard,
		getPlayerCommanderIdentity,
		getSpellCostRequirement,
		getSpellTargetRequirement,
		getSuspendSpec,
		hasKeyword,
		inspectCardContinuousBreakdown,
		validateTargetLegality
	} from './engine';
	import ManaSymbol from './ManaSymbol.svelte';
	import ManaText from './ManaText.svelte';
	import { parseManaCost } from './oracle';
	import { keywordCost, spellChoosesX } from './runtime/costs';
	import { matchesScryfallQuery } from './search';
	import { cardSupportReport, displayAbilityText, unsupportedKindLabel } from './compiler/support';
	import { effectivePromptChoice, effectivePromptPurpose } from './runtime/choices';
	import {
		PHASE_LABELS,
		PHASE_ORDER,
		type CardInstance,
		type CounterType,
		type GameActionPayload,
		type GamePhase,
		type GuidedOperation,
		type GameState,
		type MagicChatMessage,
		type MagicUser,
		type ManaColor,
		type PlayerGameState,
		type ScryfallCard,
		type TargetRef,
		type TargetRequirementInfo
	} from './types';
	import {
		ArenaVfxController,
		computeBezierPath,
		getElementCenterByGameId,
		type ArrowLine
	} from './vfx';

	let {
		gameState,
		user,
		lobbyCode,
		chatMessages,
		theme,
		botPaused = false,
		onToggleTheme,
		onGameAction,
		onSendChat,
		onLeaveMatch
	}: {
		gameState: GameState;
		user: MagicUser;
		lobbyCode: string;
		chatMessages: MagicChatMessage[];
		theme: 'light' | 'dark';
		botPaused?: boolean;
		onToggleTheme: () => void;
		onGameAction: (action: GameActionPayload) => Promise<void>;
		onSendChat: (text: string, kind?: 'chat' | 'emote') => Promise<void>;
		onLeaveMatch: () => void;
	} = $props();

	let vfxCanvas: HTMLCanvasElement | undefined = $state();
	const vfxCtrl = new ArenaVfxController();
	let shaking = $state(false);
	let arrows = $state.raw<ArrowLine[]>([]);

	// Clicked Card Inspector & Hold-ALT Floating Hover Preview
	// Engine objects are held raw, never as deep proxies: legality checks briefly mutate them (e.g.
	// tapping a permanent to test a cost), which Svelte forbids on proxies while rendering.
	let inspectedCard = $state.raw<ScryfallCard | null>(null);
	let inspectedInstance = $state.raw<CardInstance | null>(null);
	let hoveredCard = $state.raw<ScryfallCard | null>(null);
	let hoveredInstance = $state.raw<CardInstance | null>(null);
	let altHeld = $state(false);
	let mousePos = $state({ x: 0, y: 0 });

	const hoverBreakdown = $derived(
		hoveredCard ? inspectCardContinuousBreakdown(hoveredInstance ?? hoveredCard, gameState) : null
	);
	const inspectBreakdown = $derived(
		inspectedCard
			? inspectCardContinuousBreakdown(inspectedInstance ?? inspectedCard, gameState)
			: null
	);
	// Plan section 2.7: abilities the engine doesn't automate (E2 resolves them manually).
	const inspectUnsupported = $derived(inspectedCard ? cardSupportReport(inspectedCard).unsupported : []);

	// Adjustable / Resizable Section Dimensions & Hand Auto-Sort (persisted in localStorage)
	type HandSortMode = 'none' | 'cmc' | 'name' | 'color' | 'type';
	type HandSortDir = 'asc' | 'desc';
	let handSortBy = $state<HandSortMode>('none');
	let handSortDir = $state<HandSortDir>('asc');

	let dockWidth = $state(330); // Right sidebar width (px)
	let inspectorHeight = $state(255); // Clicked card info height (px)
	let stackHeight = $state(145); // Stack panel height (px); Chat takes remaining height
	let oppHeightPct = $state(33); // Opponent row height (%)
	let frontRowPct = $state(50); // Player front row vs back row split (%)
	let consoleHeight = $state(152); // Bottom Hand & Console height (px)
	let vitalsWidth = $state(160); // Left Hand side section (Life/Mana/Zones) width (px)
	let controlsWidth = $state(185); // Right Hand side section (Action Controls) width (px)
	let pedestalWidth = $state(150); // Command Zone pedestal side width (px)

	let activeDrag = $state<
		| null
		| 'dock'
		| 'inspector'
		| 'stack'
		| 'opp_row'
		| 'player_rows'
		| 'hand_height'
		| 'hand_left'
		| 'hand_right'
		| 'pedestal'
	>(null);
	let tableAreaEl: HTMLDivElement | undefined = $state();
	let myBoardEl: HTMLElement | undefined = $state();
	let myZonesEl: HTMLDivElement | undefined = $state();
	let myBackRowEl: HTMLDivElement | undefined = $state();
	let myConsoleEl: HTMLDivElement | undefined = $state();

	function setHandSort(mode: HandSortMode) {
		if (mode !== 'none' && handSortBy === mode) {
			handSortDir = handSortDir === 'asc' ? 'desc' : 'asc';
		} else {
			handSortBy = mode;
		}
		saveLayoutPrefs();
	}

	function setHandSortDir(dir: HandSortDir) {
		handSortDir = dir;
		if (handSortBy === 'none') {
			handSortBy = 'cmc';
		}
		saveLayoutPrefs();
	}

	function saveLayoutPrefs() {
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

	function resetLayoutPrefs() {
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

	let zoneModal = $state<{
		title: string;
		cards: CardInstance[];
		ownerName: string;
	} | null>(null);
	let zoneSearchQuery = $state('');
	let librarySearchQuery = $state('');

	// Targeting state when casting a targeted spell or ability
	let pendingTargetAction = $state<{
		mode: 'spell' | 'ability';
		instanceId: string;
		abilityId?: string;
		card: ScryfallCard;
		targetKind: string;
		targetInfo: TargetRequirementInfo;
		selectedTargets: TargetRef[];
		fromZone?: 'hand' | 'command' | 'exile';
		xValue: number;
	} | null>(null);

	// Drag-and-drop state for hand and command zone cards
	let draggingCard = $state.raw<{ inst: CardInstance; fromZone: 'hand' | 'command' | 'exile' } | null>(null);
	let dragOverZone = $state<'front_row' | 'lands_area' | 'stack' | null>(null);

	let xCostModalCard = $state.raw<{ inst: CardInstance; fromZone: 'hand' | 'command' | 'exile' } | null>(null);
	let xCostValue = $state(1);

	// Activated abilities menu on a permanent (raw: see inspectedCard above)
	let selectedPermanentForAbility = $state.raw<CardInstance | null>(null);

	// Combat drafts
	let draftAttackers = $state<Record<string, string>>({});
	let draftAttackerWalkers = $state<Record<string, string | null>>({});
	let draftBlockers = $state<Record<string, string>>({});
	let selectedBlockerId = $state<string | null>(null);

	const combatForecast = $derived.by(() => {
		const combinedDraftAttackers: Record<
			string,
			{ defenderPlayerId: string; defenderPlaneswalkerId?: string | null }
		> = {};
		for (const [atkId, defPlayerId] of Object.entries(draftAttackers)) {
			combinedDraftAttackers[atkId] = {
				defenderPlayerId: defPlayerId,
				defenderPlaneswalkerId: draftAttackerWalkers[atkId] || null
			};
		}
		return computeCombatDamageForecast(gameState, combinedDraftAttackers, draftBlockers);
	});

	function isAttachmentLinkedToHover(perm: CardInstance): boolean {
		const focus = hoveredInstance || inspectedInstance;
		if (!focus) return false;
		if (focus.instanceId === perm.instanceId) {
			return Boolean(perm.attachedToId) || getAttachedCardsOnBoard(gameState, perm.instanceId).length > 0;
		}
		return (
			focus.attachedToId === perm.instanceId ||
			perm.attachedToId === focus.instanceId
		);
	}

	// Prompt selections (generic chooseObjects / chooseMode / chooseNumber)
	let selectedPromptCardIds = $state<string[]>([]);
	let selectedPromptModes = $state<number[]>([]);
	let selectedPromptNumber = $state<number>(0);
	let choiceStatePromptId = $state<string | null>(null);


	// Right dock tabs & chat
	let dockTab = $state<'chat' | 'log'>('chat');
	let chatInput = $state('');

	const EMOTES = [
		'Good Game',
		'Nice Play',
		'Thinking...',
		'Oops',
		'Countered',
		'Your Go'
	];

	const me = $derived(
		gameState.players.find((p) => p.playerId === user.id) || gameState.players[0]
	);
	const opponents = $derived(
		gameState.players.filter((p) => p.playerId !== me?.playerId)
	);
	const activePlayer = $derived(gameState.players[gameState.activePlayerIndex]);
	const priorityPlayer = $derived(gameState.players[gameState.priorityPlayerIndex]);
	const hasPriority = $derived(priorityPlayer?.playerId === me?.playerId);
	const isMyTurn = $derived(activePlayer?.playerId === me?.playerId);

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

	const myPrompt = $derived(
		gameState.pendingPrompts.find((pr) => pr.playerId === me?.playerId) || null
	);
	const myChoice = $derived(myPrompt ? effectivePromptChoice(myPrompt, gameState) : null);
	const myPromptPurpose = $derived(myPrompt ? effectivePromptPurpose(myPrompt) : null);

	// Guided (manual) resolution, step E2: the player builds a list of operations, applied in order by
	// the server (which validates them) when they finish resolving.
	type GuidedOpKind = GuidedOperation['op'];
	const GUIDED_OP_LABELS: Record<GuidedOpKind, string> = {
		draw_cards: 'Draw cards',
		modify_life: 'Gain / lose life',
		deal_damage: 'Deal damage',
		move_zone: 'Move a card',
		add_counter: 'Add / remove counters',
		create_token: 'Create tokens',
		tap: 'Tap',
		untap: 'Untap',
		mill: 'Mill cards'
	};
	const GUIDED_COUNTERS: CounterType[] = ['+1/+1', '-1/-1', 'loyalty', 'charge', 'shield', 'stun', 'lore', 'time'];
	const GUIDED_ZONES = ['battlefield', 'hand', 'graveyard', 'exile', 'library', 'command'] as const;
	let guidedOps = $state<GuidedOperation[]>([]);
	let guidedOpKind = $state<GuidedOpKind>('draw_cards');
	let guidedTargetId = $state('');
	let guidedAmount = $state(1);
	let guidedZone = $state<(typeof GUIDED_ZONES)[number]>('graveyard');
	let guidedCounter = $state<CounterType>('+1/+1');
	let guidedTokenName = $state('Token');
	let guidedTokenPower = $state(1);
	let guidedTokenToughness = $state(1);
	let guidedPromptId = $state<string | null>(null);

	/** Players and visible cards an operation can act on (libraries and others' hands stay hidden). */
	const guidedTargets = $derived.by(() => {
		const out: Array<{ id: string; label: string; kind: 'player' | 'card'; zone?: string }> = [];
		for (const p of gameState.players) out.push({ id: p.playerId, label: `Player: ${p.username}`, kind: 'player' });
		for (const p of gameState.players) {
			for (const c of p.battlefield) out.push({ id: c.instanceId, label: `${c.card.name} (${p.username}'s battlefield)`, kind: 'card', zone: 'battlefield' });
		}
		for (const p of gameState.players) {
			for (const zone of ['graveyard', 'exile', 'command'] as const) {
				for (const c of p[zone]) out.push({ id: c.instanceId, label: `${c.card.name} (${p.username}'s ${zone})`, kind: 'card', zone });
			}
		}
		for (const c of me?.hand ?? []) out.push({ id: c.instanceId, label: `${c.card.name} (your hand)`, kind: 'card', zone: 'hand' });
		return out;
	});
	const guidedTargetChoices = $derived(
		guidedTargets.filter((t) => {
			switch (guidedOpKind) {
				case 'draw_cards':
				case 'mill':
				case 'modify_life':
					return t.kind === 'player';
				case 'deal_damage':
					return t.kind === 'player' || t.zone === 'battlefield';
				case 'add_counter':
				case 'tap':
				case 'untap':
					return t.zone === 'battlefield';
				case 'move_zone':
					return t.kind === 'card';
				case 'create_token':
					return false;
			}
		})
	);

	$effect(() => {
		// A new guided prompt starts with an empty operation list.
		const id = myPromptPurpose === 'guided_resolution' ? (myPrompt?.id ?? null) : null;
		if (id !== guidedPromptId) {
			guidedPromptId = id;
			guidedOps = [];
		}
	});

	function guidedLabel(op: GuidedOperation): string {
		const target = op.targetId ? (guidedTargets.find((t) => t.id === op.targetId)?.label ?? 'target') : '';
		switch (op.op) {
			case 'draw_cards':
			case 'mill':
				return `${GUIDED_OP_LABELS[op.op]}: ${op.amount} (${target || 'you'})`;
			case 'modify_life':
				return `${target}: ${(op.amount ?? 0) > 0 ? '+' : ''}${op.amount} life`;
			case 'deal_damage':
				return `${op.amount} damage to ${target}`;
			case 'move_zone':
				return `Move ${target} to ${op.destinationZone}`;
			case 'add_counter':
				return `${(op.amount ?? 0) > 0 ? '+' : ''}${op.amount} ${op.counterType} counter(s) on ${target}`;
			case 'create_token':
				return `Create ${op.amount}× ${op.tokenName} ${op.tokenPower}/${op.tokenToughness}`;
			case 'tap':
			case 'untap':
				return `${GUIDED_OP_LABELS[op.op]} ${target}`;
		}
	}

	function addGuidedOp(): void {
		const needsTarget = guidedOpKind !== 'create_token' && guidedOpKind !== 'draw_cards' && guidedOpKind !== 'mill';
		const targetId = guidedTargetChoices.some((t) => t.id === guidedTargetId) ? guidedTargetId : '';
		if (needsTarget && !targetId) return;
		const amount = Math.trunc(Number(guidedAmount) || 0);
		const op: GuidedOperation = { op: guidedOpKind };
		if (targetId) op.targetId = targetId;
		if (guidedOpKind === 'move_zone') op.destinationZone = guidedZone;
		else if (guidedOpKind === 'add_counter') {
			op.counterType = guidedCounter;
			op.amount = amount;
		} else if (guidedOpKind === 'create_token') {
			op.amount = Math.max(1, amount);
			op.tokenName = guidedTokenName;
			op.tokenPower = Math.max(0, Math.trunc(Number(guidedTokenPower) || 0));
			op.tokenToughness = Math.max(0, Math.trunc(Number(guidedTokenToughness) || 0));
		} else if (guidedOpKind !== 'tap' && guidedOpKind !== 'untap') op.amount = amount;
		guidedOps = [...guidedOps, op];
	}

	/** Step E2 escape hatch: the inspected card is mine and I may act, so I can apply an ability by hand. */
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

	const myCreaturesAndWalkers = $derived(
		(me?.battlefield || []).filter((c) => {
			const effType = inspectCardContinuousBreakdown(c, gameState).effectiveTypeLine;
			return effType.includes('Creature') || effType.includes('Planeswalker');
		})
	);
	const myBackRow = $derived(
		(me?.battlefield || []).filter((c) => {
			const effType = inspectCardContinuousBreakdown(c, gameState).effectiveTypeLine;
			return !effType.includes('Creature') && !effType.includes('Planeswalker');
		})
	);

	function getColorSortRank(card: ScryfallCard): number {
		if (card.typeLine.includes('Land') && (!card.colors || card.colors.length === 0)) {
			return 7;
		}
		const cols = card.colors && card.colors.length > 0 ? card.colors : card.colorIdentity || [];
		if (cols.length === 0) return 6;
		if (cols.length > 1) return 5;
		const order: Record<string, number> = { W: 0, U: 1, B: 2, R: 3, G: 4 };
		return order[cols[0]] ?? 6;
	}

	function getTypeSortRank(card: ScryfallCard): number {
		const t = card.typeLine;
		if (t.includes('Land')) return 0;
		if (t.includes('Creature')) return 1;
		if (t.includes('Planeswalker')) return 2;
		if (t.includes('Artifact')) return 3;
		if (t.includes('Enchantment')) return 4;
		if (t.includes('Battle')) return 5;
		if (t.includes('Instant')) return 6;
		if (t.includes('Sorcery')) return 7;
		return 8;
	}

	const sortedHand = $derived.by(() => {
		const raw = me?.hand || [];
		if (handSortBy === 'none') return raw;
		const dir = handSortDir === 'desc' ? -1 : 1;
		const copy = [...raw];
		copy.sort((a, b) => {
			let cmp = 0;
			if (handSortBy === 'cmc') {
				const aLand = a.card.typeLine.includes('Land') ? 0 : 1;
				const bLand = b.card.typeLine.includes('Land') ? 0 : 1;
				if (aLand !== bLand) cmp = aLand - bLand;
				else if (a.card.cmc !== b.card.cmc) cmp = a.card.cmc - b.card.cmc;
				else cmp = a.card.name.localeCompare(b.card.name);
			} else if (handSortBy === 'name') {
				cmp = a.card.name.localeCompare(b.card.name);
			} else if (handSortBy === 'color') {
				const ca = getColorSortRank(a.card);
				const cb = getColorSortRank(b.card);
				if (ca !== cb) cmp = ca - cb;
				else if (a.card.cmc !== b.card.cmc) cmp = a.card.cmc - b.card.cmc;
				else cmp = a.card.name.localeCompare(b.card.name);
			} else if (handSortBy === 'type') {
				const ta = getTypeSortRank(a.card);
				const tb = getTypeSortRank(b.card);
				if (ta !== tb) cmp = ta - tb;
				else if (a.card.cmc !== b.card.cmc) cmp = a.card.cmc - b.card.cmc;
				else cmp = a.card.name.localeCompare(b.card.name);
			}
			return cmp * dir;
		});
		return copy;
	});

	// Rope Timer calculation (only active after mulliganning has finished and the round has started)
	let nowTick = $state(Date.now());
	const ropeRemainingSec = $derived.by(() => {
		if (!gameState.rules.turnTimerSeconds || gameState.status !== 'active') return null;
		if (
			gameState.pendingPrompts.some(
				(pr) => pr.kind === 'mulligan' || pr.kind === 'london_bottom'
			)
		) {
			return null;
		}
		const elapsed = Math.floor((nowTick - gameState.priorityUpdatedAt) / 1000);
		return Math.max(0, gameState.rules.turnTimerSeconds - elapsed);
	});

	// Floating ALT preview coordinates & adaptive side-details layout clamped to viewport
	const altPreviewPos = $derived.by(() => {
		const w = typeof window !== 'undefined' ? window.innerWidth : 1280;
		const h = typeof window !== 'undefined' ? window.innerHeight : 720;
		const imgW = 246;
		const imgH = 342;
		const detailsH = 148;
		const sideDetailsW = 224;

		const stackedTotalH = imgH + detailsH;
		const idealStackedY = mousePos.y - stackedTotalH * 0.42;
		const wouldOverflowVertically =
			idealStackedY < 14 || idealStackedY + stackedTotalH > h - 14 || h < 660;

		const sideMode = wouldOverflowVertically && w >= imgW + sideDetailsW + 40;
		const totalW = sideMode ? imgW + sideDetailsW : imgW;
		const totalH = sideMode ? imgH : stackedTotalH;

		let x = mousePos.x + 24;
		let placeLeft = false;
		if (x + totalW > w - 12) {
			if (mousePos.x - 24 - totalW >= 12) {
				x = mousePos.x - 24 - totalW;
				placeLeft = true;
			} else {
				x = Math.max(12, w - totalW - 12);
			}
		}

		let y = mousePos.y - totalH * 0.45;
		if (y < 12) y = 12;
		if (y + totalH > h - 12) y = Math.max(12, h - totalH - 12);

		return { x, y, sideMode, placeLeft };
	});

	function recomputeArrows() {
		const next: ArrowLine[] = [];
		if (gameState.combat.active) {
			for (const atk of gameState.combat.attackers) {
				const p1 = getElementCenterByGameId(atk.attackerInstanceId);
				const p2 = getElementCenterByGameId(atk.defenderPlaneswalkerId || atk.defenderPlayerId);
				if (p1 && p2) {
					next.push({
						id: `atk_${atk.attackerInstanceId}`,
						x1: p1.x,
						y1: p1.y,
						x2: p2.x,
						y2: p2.y,
						kind: 'attack'
					});
				}
				for (const bId of atk.blockerInstanceIds) {
					const bp = getElementCenterByGameId(bId);
					if (bp && p1) {
						next.push({
							id: `blk_${bId}_${atk.attackerInstanceId}`,
							x1: bp.x,
							y1: bp.y,
							x2: p1.x,
							y2: p1.y,
							kind: 'block'
						});
					}
				}
			}
		}

		if (gameState.phase === 'declare_attackers' && isMyTurn) {
			for (const [atkId, defId] of Object.entries(draftAttackers)) {
				const p1 = getElementCenterByGameId(atkId);
				const p2 = getElementCenterByGameId(draftAttackerWalkers[atkId] || defId);
				if (p1 && p2) {
					next.push({
						id: `draft_atk_${atkId}`,
						x1: p1.x,
						y1: p1.y,
						x2: p2.x,
						y2: p2.y,
						kind: 'attack'
					});
				}
			}
		}

		if (gameState.phase === 'declare_blockers') {
			for (const [blkId, atkId] of Object.entries(draftBlockers)) {
				const p1 = getElementCenterByGameId(blkId);
				const p2 = getElementCenterByGameId(atkId);
				if (p1 && p2) {
					next.push({
						id: `draft_blk_${blkId}`,
						x1: p1.x,
						y1: p1.y,
						x2: p2.x,
						y2: p2.y,
						kind: 'block'
					});
				}
			}
		}

		// Attachment link arrows for any hovered or inspected Aura / Equipment or Host Character
		const focusInst = hoveredInstance || inspectedInstance;
		for (const p of gameState.players) {
			for (const c of p.battlefield) {
				if (!c.attachedToId || c.phasedOut) continue;
				const isFocusedLink =
					focusInst &&
					(focusInst.instanceId === c.instanceId || focusInst.instanceId === c.attachedToId);
				if (isFocusedLink) {
					const srcPos = getElementCenterByGameId(c.instanceId);
					const dstPos = getElementCenterByGameId(c.attachedToId);
					if (srcPos && dstPos) {
						next.push({
							id: `att_${c.instanceId}_${c.attachedToId}`,
							x1: srcPos.x,
							y1: srcPos.y,
							x2: dstPos.x,
							y2: dstPos.y,
							kind: 'attachment'
						});
					}
				}
			}
		}

		for (const item of gameState.stack) {
			const sPos = getElementCenterByGameId(item.id);
			if (!sPos) continue;
			for (const t of item.targets) {
				const tPos = getElementCenterByGameId(t.id);
				if (tPos) {
					next.push({
						id: `stk_t_${item.id}_${t.id}`,
						x1: sPos.x,
						y1: sPos.y,
						x2: tPos.x,
						y2: tPos.y,
						kind: 'target'
					});
				}
			}
		}

		if (pendingTargetAction) {
			const src = getElementCenterByGameId(pendingTargetAction.instanceId) || {
				x: window.innerWidth * 0.5,
				y: window.innerHeight * 0.85
			};
			for (const selT of pendingTargetAction.selectedTargets) {
				const tPos = getElementCenterByGameId(selT.id);
				if (tPos) {
					next.push({
						id: `sel_t_${selT.id}`,
						x1: src.x,
						y1: src.y,
						x2: tPos.x,
						y2: tPos.y,
						kind: 'target'
					});
				}
			}
			next.push({
				id: 'cursor_target',
				x1: src.x,
				y1: src.y,
				x2: mousePos.x,
				y2: mousePos.y,
				kind: 'active_cursor',
				label: `Target (${pendingTargetAction.targetKind})`
			});
		}

		// Runs every animation frame: only replace the array when an arrow actually changed.
		if (
			next.length !== arrows.length ||
			next.some((ar, i) => {
				const old = arrows[i];
				return (
					ar.id !== old.id ||
					ar.x1 !== old.x1 ||
					ar.y1 !== old.y1 ||
					ar.x2 !== old.x2 ||
					ar.y2 !== old.y2 ||
					ar.kind !== old.kind ||
					ar.label !== old.label
				);
			})
		) {
			arrows = next;
		}
	}

	function cancelTargeting() {
		if (pendingTargetAction?.targetInfo.zone === 'graveyard') {
			zoneModal = null;
			zoneSearchQuery = '';
		}
		pendingTargetAction = null;
		selectedBlockerId = null;
		draggingCard = null;
		dragOverZone = null;
	}

	function handleRootContextMenu(e: MouseEvent) {
		if (pendingTargetAction || selectedBlockerId || draggingCard) {
			e.preventDefault();
			e.stopPropagation();
			cancelTargeting();
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
			if (e.key === 'Escape') {
				if (
					pendingTargetAction ||
					selectedBlockerId ||
					draggingCard ||
					selectedPermanentForAbility ||
					xCostModalCard ||
					zoneModal
				) {
					e.preventDefault();
					e.stopPropagation();
					cancelTargeting();
					selectedPermanentForAbility = null;
					xCostModalCard = null;
					zoneModal = null;
					zoneSearchQuery = '';
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

		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('keyup', onKeyUp);
		window.addEventListener('blur', onBlur);
		window.addEventListener('mouseup', onMouseUp);

		let animId = 0;
		const tick = () => {
			if (vfxCanvas) {
				if (
					vfxCanvas.width !== window.innerWidth ||
					vfxCanvas.height !== window.innerHeight
				) {
					vfxCanvas.width = window.innerWidth;
					vfxCanvas.height = window.innerHeight;
				}
				const ctx = vfxCanvas.getContext('2d');
				if (ctx) {
					vfxCtrl.stepAndDraw(ctx, vfxCanvas.width, vfxCanvas.height);
				}
			}
			recomputeArrows();
			animId = requestAnimationFrame(tick);
		};
		animId = requestAnimationFrame(tick);

		const secTimer = setInterval(() => {
			nowTick = Date.now();
		}, 1000);

		return () => {
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('keyup', onKeyUp);
			window.removeEventListener('blur', onBlur);
			window.removeEventListener('mouseup', onMouseUp);
			cancelAnimationFrame(animId);
			clearInterval(secTimer);
		};
	});

	let lastPromptId = $state<string | null>(null);
	$effect(() => {
		const pid = myPrompt?.id ?? null;
		if (pid !== lastPromptId) {
			lastPromptId = pid;
			selectedPromptCardIds = [];
		}
	});

	$effect(() => {
		if (gameState.recentVfxEvents) {
			const shook = vfxCtrl.processEvents(gameState.recentVfxEvents);
			if (shook) {
				shaking = true;
				setTimeout(() => (shaking = false), 420);
			}
		}
	});

	function handleGlobalMouseMove(e: MouseEvent) {
		mousePos = { x: e.clientX, y: e.clientY };
		altHeld = e.altKey;

		if (!activeDrag) return;

		if (activeDrag === 'dock') {
			const nextW = window.innerWidth - e.clientX;
			dockWidth = Math.min(560, Math.max(220, nextW));
		} else if (activeDrag === 'inspector') {
			const hudBottom = 42;
			const nextH = e.clientY - hudBottom;
			inspectorHeight = Math.min(520, Math.max(110, nextH));
		} else if (activeDrag === 'stack') {
			const stackTop = 42 + inspectorHeight + 6;
			const nextH = e.clientY - stackTop;
			stackHeight = Math.min(380, Math.max(75, nextH));
		} else if (activeDrag === 'opp_row' && tableAreaEl) {
			const rect = tableAreaEl.getBoundingClientRect();
			const pct = ((e.clientY - rect.top) / Math.max(1, rect.height)) * 100;
			oppHeightPct = Math.min(62, Math.max(18, Math.round(pct)));
		} else if (activeDrag === 'player_rows' && myZonesEl) {
			const rect = myZonesEl.getBoundingClientRect();
			const pct = ((e.clientY - rect.top) / Math.max(1, rect.height)) * 100;
			frontRowPct = Math.min(75, Math.max(25, Math.round(pct)));
		} else if (activeDrag === 'hand_height' && myBoardEl) {
			const rect = myBoardEl.getBoundingClientRect();
			const nextH = rect.bottom - e.clientY;
			consoleHeight = Math.min(340, Math.max(122, Math.round(nextH)));
		} else if (activeDrag === 'hand_left' && myConsoleEl) {
			const rect = myConsoleEl.getBoundingClientRect();
			const nextW = e.clientX - rect.left;
			vitalsWidth = Math.min(420, Math.max(118, Math.round(nextW)));
		} else if (activeDrag === 'hand_right' && myConsoleEl) {
			const rect = myConsoleEl.getBoundingClientRect();
			const nextW = rect.right - e.clientX;
			controlsWidth = Math.min(350, Math.max(135, Math.round(nextW)));
		} else if (activeDrag === 'pedestal' && myBackRowEl) {
			const rect = myBackRowEl.getBoundingClientRect();
			const nextW = e.clientX - rect.left;
			pedestalWidth = Math.min(340, Math.max(110, Math.round(nextW)));
		}
	}

	function hoverCard(card: ScryfallCard, inst?: CardInstance) {
		hoveredCard = card;
		hoveredInstance = inst ?? null;
		inspectedCard = card;
		inspectedInstance = inst ?? null;
	}

	function leaveCard(card: ScryfallCard) {
		if (hoveredCard?.id === card.id) {
			hoveredCard = null;
			hoveredInstance = null;
		}
	}

	function isCardPlayableNow(inst: CardInstance, fromZone: 'hand' | 'command' | 'exile'): boolean {
		if (!me || !hasPriority || gameState.status !== 'active' || myPrompt || pendingTargetAction) {
			return false;
		}
		if (inst.card.typeLine.includes('Land') && !inst.card.typeLine.includes('Creature')) {
			return checkLandPlayLegality(gameState, me.playerId, inst, fromZone).ok;
		}
		if (
			spellChoosesX(inst.card) ||
			keywordCost(inst.card, 'overload') !== null
		) {
			return (
				checkSpellCastLegality(gameState, me.playerId, inst, fromZone, 0).ok ||
				checkSpellCastLegality(gameState, me.playerId, inst, fromZone, 1).ok
			);
		}
		if (checkSpellCastLegality(gameState, me.playerId, inst, fromZone, 0).ok) {
			return true;
		}
		if (fromZone === 'hand' && checkSuspendLegality(gameState, me.playerId, inst).ok) {
			return true;
		}
		return false;
	}

	function isPermanentActableNow(perm: CardInstance, owner: PlayerGameState): boolean {
		if (!me || gameState.status !== 'active' || myPrompt) return false;

		if (pendingTargetAction) {
			if (pendingTargetAction.selectedTargets.some((t) => t.id === perm.instanceId)) {
				return true;
			}
			const ref: TargetRef = { kind: 'permanent', id: perm.instanceId, label: perm.card.name };
			return validateTargetLegality(
				gameState,
				me.playerId,
				ref,
				pendingTargetAction.targetInfo,
				pendingTargetAction.card,
				pendingTargetAction.instanceId
			).ok;
		}

		if (owner.playerId !== me.playerId) {
			if (gameState.phase === 'declare_blockers' && !isMyTurn && hasPriority && selectedBlockerId) {
				return gameState.combat.attackers.some(
					(a) => a.attackerInstanceId === perm.instanceId && a.defenderPlayerId === me.playerId
				);
			}
			return false;
		}

		if (!hasPriority) return false;

		if (
			gameState.phase === 'declare_attackers' &&
			isMyTurn &&
			!gameState.combat.active &&
			gameState.stack.length === 0
		) {
			if (
				perm.card.typeLine.includes('Creature') &&
				!perm.tapped &&
				(!perm.summoningSick || hasKeyword(perm, 'Haste', gameState)) &&
				!hasKeyword(perm, 'Defender', gameState)
			) {
				return true;
			}
		}

		if (
			gameState.phase === 'declare_blockers' &&
			!isMyTurn &&
			gameState.combat.active &&
			gameState.stack.length === 0 &&
			!(gameState.combat.declaredBlockersPlayerIds || []).includes(me.playerId)
		) {
			if (
				perm.card.typeLine.includes('Creature') &&
				!perm.tapped &&
				gameState.combat.attackers.some((a) => a.defenderPlayerId === me.playerId)
			) {
				return true;
			}
		}

		const cmdId = getPlayerCommanderIdentity(me);
		const abilities = getEffectiveActivatedAbilities(gameState, me, perm, cmdId);
		for (const ab of abilities) {
			if (checkAbilityActivationLegality(gameState, me.playerId, perm, ab).ok) {
				return true;
			}
		}

		return false;
	}

	function isPlayerTargetableNow(targetPlayer: PlayerGameState): boolean {
		if (!me || !pendingTargetAction) return false;
		const ref: TargetRef = {
			kind: 'player',
			id: targetPlayer.playerId,
			label: targetPlayer.username
		};
		return validateTargetLegality(
			gameState,
			me.playerId,
			ref,
			pendingTargetAction.targetInfo,
			pendingTargetAction.card,
			pendingTargetAction.instanceId
		).ok;
	}

	function isStackItemTargetableNow(item: (typeof gameState.stack)[0]): boolean {
		if (!me || !pendingTargetAction) return false;
		const ref: TargetRef = {
			kind: 'stack',
			id: item.id,
			label: item.title
		};
		return validateTargetLegality(
			gameState,
			me.playerId,
			ref,
			pendingTargetAction.targetInfo,
			pendingTargetAction.card,
			pendingTargetAction.instanceId
		).ok;
	}

	function isGraveyardCardTargetableNow(cardInst: CardInstance): boolean {
		if (!me || !pendingTargetAction) return false;
		if (pendingTargetAction.selectedTargets.some((t) => t.id === cardInst.instanceId)) {
			return true;
		}
		if (
			pendingTargetAction.targetInfo.zone === 'graveyard' &&
			pendingTargetAction.targetInfo.sameGraveyard &&
			pendingTargetAction.selectedTargets.length > 0
		) {
			const firstId = pendingTargetAction.selectedTargets[0].id;
			const firstOwner = gameState.players.find((p) =>
				p.graveyard.some((c) => c.instanceId === firstId)
			);
			const candOwner = gameState.players.find((p) =>
				p.graveyard.some((c) => c.instanceId === cardInst.instanceId)
			);
			if (firstOwner && candOwner && firstOwner.playerId !== candOwner.playerId) {
				return false;
			}
		}
		const ref: TargetRef = {
			kind: 'graveyard_card',
			id: cardInst.instanceId,
			label: cardInst.card.name
		};
		return validateTargetLegality(
			gameState,
			me.playerId,
			ref,
			pendingTargetAction.targetInfo,
			pendingTargetAction.card,
			pendingTargetAction.instanceId
		).ok;
	}

	async function addOrSubmitTarget(tRef: TargetRef) {
		if (!pendingTargetAction || !me) return;

		const existingIdx = pendingTargetAction.selectedTargets.findIndex(
			(t) => t.id === tRef.id && t.kind === tRef.kind
		);
		if (existingIdx >= 0) {
			pendingTargetAction.selectedTargets = pendingTargetAction.selectedTargets.filter(
				(_, idx) => idx !== existingIdx
			);
			return;
		}

		const valRes = validateTargetLegality(
			gameState,
			me.playerId,
			tRef,
			pendingTargetAction.targetInfo,
			pendingTargetAction.card,
			pendingTargetAction.instanceId
		);
		if (!valRes.ok) return;

		if (
			pendingTargetAction.targetInfo.zone === 'graveyard' &&
			pendingTargetAction.targetInfo.sameGraveyard &&
			pendingTargetAction.selectedTargets.length > 0
		) {
			const firstId = pendingTargetAction.selectedTargets[0].id;
			const firstOwner = gameState.players.find((p) =>
				p.graveyard.some((c) => c.instanceId === firstId)
			);
			const candOwner = gameState.players.find((p) =>
				p.graveyard.some((c) => c.instanceId === tRef.id)
			);
			if (firstOwner && candOwner && firstOwner.playerId !== candOwner.playerId) {
				return;
			}
		}

		const nextTargets = [...pendingTargetAction.selectedTargets, tRef];
		const maxReq = Math.max(1, pendingTargetAction.targetInfo.maxTargets);

		if (nextTargets.length >= maxReq) {
			pendingTargetAction.selectedTargets = nextTargets;
			await submitSelectedTargets();
		} else {
			pendingTargetAction.selectedTargets = nextTargets;
		}
	}

	async function submitSelectedTargets() {
		if (!pendingTargetAction) return;
		const pending = pendingTargetAction;
		if (pending.selectedTargets.length < pending.targetInfo.minTargets) return;

		pendingTargetAction = null;
		if (pending.targetInfo.zone === 'graveyard') {
			zoneModal = null;
			zoneSearchQuery = '';
		}

		if (pending.mode === 'spell') {
			await onGameAction({
				type: 'cast_spell',
				instanceId: pending.instanceId,
				fromZone: pending.fromZone,
				xValue: pending.xValue,
				targets: pending.selectedTargets
			});
		} else if (pending.mode === 'ability' && pending.abilityId) {
			await onGameAction({
				type: 'activate_ability',
				instanceId: pending.instanceId,
				abilityId: pending.abilityId,
				targets: pending.selectedTargets
			});
		}
	}

	function getValidDropZones(
		inst: CardInstance,
		fromZone: 'hand' | 'command' | 'exile'
	): Set<'front_row' | 'lands_area' | 'stack'> {
		const zones = new Set<'front_row' | 'lands_area' | 'stack'>();
		if (!isCardPlayableNow(inst, fromZone)) return zones;

		const t = inst.card.typeLine;
		if (t.includes('Land') && !t.includes('Creature')) {
			zones.add('lands_area');
			return zones;
		}
		if (t.includes('Instant') || t.includes('Sorcery')) {
			zones.add('front_row');
			zones.add('lands_area');
			zones.add('stack');
			return zones;
		}
		if (t.includes('Creature') || t.includes('Planeswalker')) {
			zones.add('front_row');
			zones.add('stack');
			return zones;
		}
		// Artifacts, Enchantments, Battles
		zones.add('lands_area');
		zones.add('front_row');
		zones.add('stack');
		return zones;
	}

	const validDragZones = $derived(
		draggingCard
			? getValidDropZones(draggingCard.inst, draggingCard.fromZone)
			: new Set<'front_row' | 'lands_area' | 'stack'>()
	);

	function handleCardDragStart(
		e: DragEvent,
		inst: CardInstance,
		fromZone: 'hand' | 'command'
	) {
		if (!isCardPlayableNow(inst, fromZone)) {
			e.preventDefault();
			return;
		}
		inspectedCard = inst.card;
		draggingCard = { inst, fromZone };
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', inst.instanceId);
		}
	}

	function handleCardDragEnd() {
		draggingCard = null;
		dragOverZone = null;
	}

	function handleZoneDragOver(
		e: DragEvent,
		zone: 'front_row' | 'lands_area' | 'stack'
	) {
		if (!draggingCard || !validDragZones.has(zone)) return;
		e.preventDefault();
		if (e.dataTransfer) {
			e.dataTransfer.dropEffect = 'move';
		}
		dragOverZone = zone;
	}

	function handleZoneDragLeave(
		e: DragEvent,
		zone: 'front_row' | 'lands_area' | 'stack'
	) {
		const related = e.relatedTarget as Node | null;
		const current = e.currentTarget as HTMLElement | null;
		if (current && related && current.contains(related)) return;
		if (dragOverZone === zone) {
			dragOverZone = null;
		}
	}

	async function handleZoneDrop(
		e: DragEvent,
		zone: 'front_row' | 'lands_area' | 'stack'
	) {
		if (!draggingCard || !validDragZones.has(zone)) return;
		e.preventDefault();
		e.stopPropagation();
		const { inst, fromZone } = draggingCard;
		draggingCard = null;
		dragOverZone = null;
		await handleCardClickInHandOrCommand(inst, fromZone);
	}

	async function handleDropOnTarget(e: DragEvent, tRef: TargetRef) {
		if (!draggingCard || !me) return;
		const { inst, fromZone } = draggingCard;
		const targetInfo = getSpellTargetRequirement(inst.card);
		if (!targetInfo.requiresTarget) return;

		const isValidTarget = validateTargetLegality(
			gameState,
			me.playerId,
			tRef,
			targetInfo,
			inst.card,
			inst.instanceId
		).ok;
		if (!isValidTarget) return;

		e.preventDefault();
		e.stopPropagation();
		draggingCard = null;
		dragOverZone = null;

		if (targetInfo.minTargets <= 1 && targetInfo.maxTargets <= 1) {
			await onGameAction({
				type: 'cast_spell',
				instanceId: inst.instanceId,
				fromZone,
				xValue: 0,
				targets: [tRef]
			});
		} else {
			await initiateCastSpell(inst, fromZone, 0);
			await addOrSubmitTarget(tRef);
		}
	}

	async function handleCardClickInHandOrCommand(
		inst: CardInstance,
		fromZone: 'hand' | 'command' | 'exile'
	) {
		inspectedCard = inst.card;
		if (!isCardPlayableNow(inst, fromZone)) return;

		if (inst.card.typeLine.includes('Land') && (fromZone === 'hand' || fromZone === 'exile')) {
			await onGameAction({ type: 'play_land', instanceId: inst.instanceId, fromZone });
			return;
		}

		if (
			fromZone === 'hand' &&
			!checkSpellCastLegality(gameState, me!.playerId, inst, 'hand', 0).ok &&
			checkSuspendLegality(gameState, me!.playerId, inst).ok
		) {
			await onGameAction({ type: 'suspend_card', instanceId: inst.instanceId });
			return;
		}

		if (spellChoosesX(inst.card) && !xCostModalCard) {
			xCostModalCard = { inst, fromZone };
			xCostValue = 2;
			return;
		}

		await initiateCastSpell(inst, fromZone, 0);
	}

	function openGraveyardTargetingModalIfNeeded(targetInfo: TargetRequirementInfo) {
		if (targetInfo.zone !== 'graveyard' || !me) return;
		if (targetInfo.controllerFilter === 'you') {
			zoneModal = {
				title: 'Select Target(s) in Your Graveyard',
				cards: me.graveyard,
				ownerName: me.username
			};
		} else {
			const combinedCards: CardInstance[] = [];
			for (const p of gameState.players) {
				if (targetInfo.controllerFilter === 'opponent' && p.playerId === me.playerId) continue;
				combinedCards.push(...p.graveyard);
			}
			zoneModal = {
				title: targetInfo.sameGraveyard
					? `Select ${targetInfo.minTargets} Target(s) in a Single Graveyard`
					: 'Select Target(s) in Graveyards',
				cards: combinedCards,
				ownerName: 'All Eligible Graveyards'
			};
		}
	}

	async function initiateCastSpell(
		inst: CardInstance,
		fromZone: 'hand' | 'command' | 'exile',
		xVal: number
	) {
		const targetInfo = getSpellTargetRequirement(inst.card);
		const isOverloadRift =
			xVal >= 1 && keywordCost(inst.card, 'overload') !== null;
		if (targetInfo.requiresTarget && !isOverloadRift) {
			pendingTargetAction = {
				mode: 'spell',
				instanceId: inst.instanceId,
				card: inst.card,
				targetKind: targetInfo.targetKind,
				targetInfo,
				selectedTargets: [],
				fromZone,
				xValue: xVal
			};
			openGraveyardTargetingModalIfNeeded(targetInfo);
			return;
		}

		await onGameAction({
			type: 'cast_spell',
			instanceId: inst.instanceId,
			fromZone,
			xValue: xVal
		});
	}

	async function handlePermanentClick(perm: CardInstance, owner: PlayerGameState) {
		inspectedCard = perm.card;
		inspectedInstance = perm;

		if (pendingTargetAction) {
			if (!isPermanentActableNow(perm, owner)) {
				return;
			}
			const tRef: TargetRef = {
				kind: 'permanent',
				id: perm.instanceId,
				label: perm.card.name
			};
			await addOrSubmitTarget(tRef);
			return;
		}

		if (
			gameState.phase === 'declare_attackers' &&
			isMyTurn &&
			owner.playerId === me.playerId &&
			perm.card.typeLine.includes('Creature')
		) {
			if (draftAttackers[perm.instanceId]) {
				delete draftAttackers[perm.instanceId];
				delete draftAttackerWalkers[perm.instanceId];
				draftAttackers = { ...draftAttackers };
				draftAttackerWalkers = { ...draftAttackerWalkers };
			} else {
				const firstAliveOpp = opponents.find((o) => !o.lost);
				if (firstAliveOpp) {
					draftAttackers = {
						...draftAttackers,
						[perm.instanceId]: firstAliveOpp.playerId
					};
				}
			}
			return;
		}

		if (
			gameState.phase === 'declare_attackers' &&
			isMyTurn &&
			owner.playerId !== me.playerId &&
			perm.card.typeLine.includes('Planeswalker') &&
			Object.keys(draftAttackers).length > 0
		) {
			const updatedDef: Record<string, string> = {};
			const updatedWalkers: Record<string, string | null> = {};
			for (const atkId of Object.keys(draftAttackers)) {
				updatedDef[atkId] = owner.playerId;
				updatedWalkers[atkId] = perm.instanceId;
			}
			draftAttackers = updatedDef;
			draftAttackerWalkers = updatedWalkers;
			return;
		}

		if (gameState.phase === 'declare_blockers' && !isMyTurn) {
			if (owner.playerId === me.playerId && perm.card.typeLine.includes('Creature')) {
				if (draftBlockers[perm.instanceId]) {
					delete draftBlockers[perm.instanceId];
					draftBlockers = { ...draftBlockers };
					selectedBlockerId = null;
				} else {
					selectedBlockerId = perm.instanceId;
					const atksOnMe = gameState.combat.attackers.filter(
						(a) => a.defenderPlayerId === me.playerId
					);
					if (atksOnMe.length === 1) {
						draftBlockers = {
							...draftBlockers,
							[perm.instanceId]: atksOnMe[0].attackerInstanceId
						};
						selectedBlockerId = null;
					}
				}
				return;
			}
			if (selectedBlockerId && owner.playerId !== me.playerId) {
				const isAttacker = gameState.combat.attackers.some(
					(a) => a.attackerInstanceId === perm.instanceId
				);
				if (isAttacker) {
					draftBlockers = {
						...draftBlockers,
						[selectedBlockerId]: perm.instanceId
					};
					selectedBlockerId = null;
					return;
				}
			}
		}

		if (owner.playerId === me.playerId) {
			const cmdId = getPlayerCommanderIdentity(me);
			const abilities = getEffectiveActivatedAbilities(gameState, me, perm, cmdId);
			if (abilities.length === 1 && abilities[0].isManaAbility) {
				await onGameAction({ type: 'tap_mana', instanceId: perm.instanceId });
			} else if (abilities.length > 0) {
				selectedPermanentForAbility = perm;
			}
		}
	}

	async function handlePlayerAvatarClick(targetPlayer: PlayerGameState) {
		if (pendingTargetAction) {
			if (!isPlayerTargetableNow(targetPlayer)) {
				return;
			}
			const tRef: TargetRef = {
				kind: 'player',
				id: targetPlayer.playerId,
				label: targetPlayer.username
			};
			await addOrSubmitTarget(tRef);
			return;
		}

		if (
			gameState.phase === 'declare_attackers' &&
			isMyTurn &&
			targetPlayer.playerId !== me.playerId &&
			!targetPlayer.lost
		) {
			const updated: Record<string, string> = {};
			for (const atkId of Object.keys(draftAttackers)) {
				updated[atkId] = targetPlayer.playerId;
			}
			draftAttackers = updated;
			draftAttackerWalkers = {};
		}
	}

	async function handleStackItemClick(item: (typeof gameState.stack)[0]) {
		inspectedCard = item.card;
		if (pendingTargetAction) {
			if (!isStackItemTargetableNow(item)) return;
			const tRef: TargetRef = {
				kind: 'stack',
				id: item.id,
				label: item.title
			};
			await addOrSubmitTarget(tRef);
		}
	}

	const TURN_PHASE_GROUPS = [
		{ id: 'beginning', label: 'Beginning' },
		{ id: 'main1', label: 'Main 1' },
		{ id: 'combat', label: 'Combat' },
		{ id: 'main2', label: 'Main 2' },
		{ id: 'ending', label: 'Ending' }
	] as const;

	type TurnPhaseGroupId = (typeof TURN_PHASE_GROUPS)[number]['id'];

	const PHASE_STEP_DETAILS: Record<
		GamePhase,
		{
			group: TurnPhaseGroupId;
			groupIndex: number;
			phaseTitle: string;
			stepTitle: string;
			nextLabel: string;
		}
	> = {
		untap: {
			group: 'beginning',
			groupIndex: 0,
			phaseTitle: 'Beginning',
			stepTitle: 'Untap',
			nextLabel: 'Next: Upkeep'
		},
		upkeep: {
			group: 'beginning',
			groupIndex: 0,
			phaseTitle: 'Beginning',
			stepTitle: 'Upkeep',
			nextLabel: 'Next: Draw'
		},
		draw: {
			group: 'beginning',
			groupIndex: 0,
			phaseTitle: 'Beginning',
			stepTitle: 'Draw',
			nextLabel: 'Next: Main 1'
		},
		main1: {
			group: 'main1',
			groupIndex: 1,
			phaseTitle: 'Main 1',
			stepTitle: 'Precombat',
			nextLabel: 'Next: Combat'
		},
		begin_combat: {
			group: 'combat',
			groupIndex: 2,
			phaseTitle: 'Combat',
			stepTitle: 'Begin Combat',
			nextLabel: 'Next: Attackers'
		},
		declare_attackers: {
			group: 'combat',
			groupIndex: 2,
			phaseTitle: 'Combat',
			stepTitle: 'Attackers',
			nextLabel: 'Next: Blockers'
		},
		declare_blockers: {
			group: 'combat',
			groupIndex: 2,
			phaseTitle: 'Combat',
			stepTitle: 'Blockers',
			nextLabel: 'Next: Damage'
		},
		first_strike_damage: {
			group: 'combat',
			groupIndex: 2,
			phaseTitle: 'Combat',
			stepTitle: 'First Strike',
			nextLabel: 'Next: Damage'
		},
		combat_damage: {
			group: 'combat',
			groupIndex: 2,
			phaseTitle: 'Combat',
			stepTitle: 'Damage',
			nextLabel: 'Next: End Combat'
		},
		end_combat: {
			group: 'combat',
			groupIndex: 2,
			phaseTitle: 'Combat',
			stepTitle: 'End Combat',
			nextLabel: 'Next: Main 2'
		},
		main2: {
			group: 'main2',
			groupIndex: 3,
			phaseTitle: 'Main 2',
			stepTitle: 'Postcombat',
			nextLabel: 'Next: End Step'
		},
		end_step: {
			group: 'ending',
			groupIndex: 4,
			phaseTitle: 'Ending',
			stepTitle: 'End Step',
			nextLabel: 'Next: Cleanup'
		},
		cleanup: {
			group: 'ending',
			groupIndex: 4,
			phaseTitle: 'Ending',
			stepTitle: 'Cleanup',
			nextLabel: 'Pass Priority'
		}
	};

	const currentPhaseDetail = $derived(PHASE_STEP_DETAILS[gameState.phase]);

	const isConfirmingAttackers = $derived(
		Boolean(
			me &&
				gameState.stack.length === 0 &&
				gameState.phase === 'declare_attackers' &&
				isMyTurn &&
				!gameState.combat.active
		)
	);

	const isConfirmingBlockers = $derived(
		Boolean(
			me &&
				gameState.stack.length === 0 &&
				gameState.phase === 'declare_blockers' &&
				!isMyTurn &&
				gameState.combat.attackers.some((a) => a.defenderPlayerId === me.playerId) &&
				!(gameState.combat.declaredBlockersPlayerIds || []).includes(me.playerId)
		)
	);

	const mandatoryAttackersCheck = $derived.by(() => {
		if (!me || !isConfirmingAttackers) return { ok: true as boolean, error: undefined as string | undefined };
		return checkMandatoryAttackersSatisfied(gameState, me.playerId, Object.keys(draftAttackers));
	});

	const canAdvanceOrPass = $derived(
		Boolean(
			me &&
				!me.lost &&
				gameState.status === 'active' &&
				hasPriority &&
				gameState.pendingPrompts.length === 0 &&
				!pendingTargetAction &&
				mandatoryAttackersCheck.ok
		)
	);

	const primaryStepLabel = $derived.by(() => {
		if (gameState.stack.length > 0) {
			return `Resolve Stack (${gameState.stack.length})`;
		}
		if (isConfirmingAttackers) {
			const count = Object.keys(draftAttackers).length;
			if (count > 0) return `Attack with ${count}`;
			if (!mandatoryAttackersCheck.ok) return 'Must Attack';
			return 'No Attacks';
		}
		if (isConfirmingBlockers) {
			const count = Object.keys(draftBlockers).length;
			return count > 0 ? `Confirm ${count} Block${count > 1 ? 's' : ''}` : 'No Blocks';
		}
		if (isMyTurn) {
			if (
				gameState.phase === 'declare_attackers' &&
				gameState.combat.active &&
				gameState.combat.attackers.length === 0
			) {
				return 'Next: Main 2';
			}
			return currentPhaseDetail.nextLabel;
		}
		return 'Pass Priority';
	});

	const primaryStepTitle = $derived.by(() => {
		if (!me || me.lost || gameState.status !== 'active') {
			return 'Game is not currently active.';
		}
		if (pendingTargetAction) {
			return 'Finish or cancel target selection first.';
		}
		if (gameState.pendingPrompts.length > 0) {
			return 'Resolve the active prompt first.';
		}
		if (!hasPriority) {
			return `Waiting for priority (${priorityPlayer?.username ?? 'opponent'}).`;
		}
		if (!mandatoryAttackersCheck.ok) {
			return mandatoryAttackersCheck.error ?? 'A creature you control must attack this combat if able.';
		}
		if (gameState.stack.length > 0) {
			return 'Pass priority to resolve the top item on the Stack.';
		}
		if (isConfirmingAttackers) {
			return Object.keys(draftAttackers).length > 0
				? 'Confirm declared attackers.'
				: 'Declare no attackers and advance to Main Phase 2.';
		}
		if (isConfirmingBlockers) {
			return Object.keys(draftBlockers).length > 0
				? 'Confirm declared blockers.'
				: 'Declare no blockers.';
		}
		return isMyTurn
			? `Pass priority to advance from ${currentPhaseDetail.phaseTitle} (${currentPhaseDetail.stepTitle}).`
			: 'Pass priority.';
	});

	const endTurnLegality = $derived.by(() => {
		if (!me) return { ok: false, error: 'Player is not active in this game.' };
		if (pendingTargetAction) return { ok: false, error: 'Finish or cancel target selection first.' };
		return checkEndTurnLegality(gameState, me.playerId);
	});

	const canPassToEndOfTurn = $derived(endTurnLegality.ok);

	const endTurnTitle = $derived(
		endTurnLegality.ok
			? 'Pass priority through remaining phases and steps to end your turn.'
			: (endTurnLegality.error ?? 'Cannot pass to end of turn right now.')
	);

	function isEligibleDraftAttacker(c: CardInstance): boolean {
		if (c.phasedOut || c.tapped) return false;
		const isCreature =
			c.card.typeLine.includes('Creature') ||
			inspectCardContinuousBreakdown(c, gameState).effectiveTypeLine.includes('Creature');
		if (!isCreature) return false;
		if (c.summoningSick && !hasKeyword(c, 'Haste', gameState)) return false;
		if (hasKeyword(c, 'Defender', gameState)) return false;
		return true;
	}

	const canSelectAllAttackers = $derived.by(() => {
		if (!me || !isConfirmingAttackers || !hasPriority || pendingTargetAction || gameState.pendingPrompts.length > 0) {
			return false;
		}
		if (!opponents.some((o) => !o.lost)) return false;
		return me.battlefield.some((c) => isEligibleDraftAttacker(c));
	});

	async function handlePrimaryArenaButton() {
		if (!me || !canAdvanceOrPass) return;

		if (isConfirmingAttackers) {
			const assignments = Object.entries(draftAttackers).map(
				([attackerInstanceId, defenderPlayerId]) => ({
					attackerInstanceId,
					defenderPlayerId,
					defenderPlaneswalkerId: draftAttackerWalkers[attackerInstanceId] || null
				})
			);
			draftAttackers = {};
			draftAttackerWalkers = {};
			await onGameAction({ type: 'declare_attackers', assignments });
			return;
		}

		if (isConfirmingBlockers) {
			const assignments = Object.entries(draftBlockers).map(
				([blockerInstanceId, attackerInstanceId]) => ({
					blockerInstanceId,
					attackerInstanceId
				})
			);
			draftBlockers = {};
			selectedBlockerId = null;
			await onGameAction({ type: 'declare_blockers', assignments });
			return;
		}

		await onGameAction({ type: 'pass_priority' });
	}

	async function handlePassToEndOfTurn() {
		if (!me || !canPassToEndOfTurn) return;
		draftAttackers = {};
		draftAttackerWalkers = {};
		await onGameAction({ type: 'end_turn' });
	}

	function selectAllAttackers() {
		if (!me || !canSelectAllAttackers) return;
		const firstOpp = opponents.find((o) => !o.lost);
		if (!firstOpp) return;
		const next: Record<string, string> = {};
		for (const c of me.battlefield) {
			if (isEligibleDraftAttacker(c)) {
				next[c.instanceId] = firstOpp.playerId;
			}
		}
		draftAttackers = next;
	}

	function togglePromptCardSelection(instanceId: string, maxReq: number) {
		if (selectedPromptCardIds.includes(instanceId)) {
			selectedPromptCardIds = selectedPromptCardIds.filter((id) => id !== instanceId);
		} else if (selectedPromptCardIds.length < maxReq) {
			selectedPromptCardIds = [...selectedPromptCardIds, instanceId];
		}
	}

	function togglePromptModeSelection(modeIdx: number, maxReq: number) {
		if (selectedPromptModes.includes(modeIdx)) {
			selectedPromptModes = selectedPromptModes.filter((idx) => idx !== modeIdx);
		} else if (selectedPromptModes.length < maxReq) {
			selectedPromptModes = [...selectedPromptModes, modeIdx];
		}
	}

	/** Choice candidates that aren't cards: players (target player) and stack items. */
	function nonCardCandidates(candidateIds: string[]): Array<{ id: string; label: string }> {
		const out: Array<{ id: string; label: string }> = [];
		for (const id of candidateIds) {
			const pl = gameState.players.find((p) => p.playerId === id);
			if (pl) {
				out.push({ id, label: `Player: ${pl.username}${pl.playerId === me?.playerId ? ' (you)' : ''} (${pl.life} life)` });
				continue;
			}
			const item = gameState.stack.find((s) => s.id === id);
			if (item) out.push({ id, label: `Stack: ${item.title}` });
		}
		return out;
	}

	function resolveCandidateObjects(candidateIds: string[]): CardInstance[] {
		const idSet = new Set(candidateIds);
		const pool: CardInstance[] = [];
		for (const p of gameState.players) {
			pool.push(...p.hand, ...p.battlefield, ...p.graveyard, ...p.exile, ...p.command, ...p.library);
		}
		const byId = new Map(pool.map((c) => [c.instanceId, c]));
		return candidateIds
			.map((id) => byId.get(id))
			.filter((c): c is CardInstance => Boolean(c && idSet.has(c.instanceId)));
	}

	// Scry & Top-Library Rearrange (e.g., Ponder) Ordered State
	let scryPromptId = $state<string | null>(null);
	let scryTopOrder = $state<string[]>([]);
	let scryBottomOrder = $state<string[]>([]);

	$effect(() => {
		if (myPrompt) {
			if (choiceStatePromptId !== myPrompt.id) {
				choiceStatePromptId = myPrompt.id;
				selectedPromptCardIds =
					myChoice?.kind === 'chooseObjects' && myChoice.defaultObjectIds
						? [...myChoice.defaultObjectIds]
						: [];
				selectedPromptModes =
					myChoice?.kind === 'chooseMode' && myChoice.defaultIndices
						? [...myChoice.defaultIndices]
						: [];
				selectedPromptNumber =
					myChoice?.kind === 'chooseNumber'
						? (myChoice.defaultNumber ?? myChoice.min)
						: 0;
			}
		} else {
			choiceStatePromptId = null;
			selectedPromptCardIds = [];
			selectedPromptModes = [];
		}

		if (myPrompt && myChoice?.kind === 'orderObjects') {
			if (scryPromptId !== myPrompt.id) {
				scryPromptId = myPrompt.id;
				const initialIds =
					myChoice.objectIds.length > 0
						? [...myChoice.objectIds]
						: (me?.library || []).map((c) => c.instanceId);
				scryTopOrder = initialIds;
				scryBottomOrder = [];
			}
		} else {
			scryPromptId = null;
			scryTopOrder = [];
			scryBottomOrder = [];
		}
	});

	function moveScryCardZone(instanceId: string, toBottom: boolean) {
		if (toBottom) {
			if (scryTopOrder.includes(instanceId)) {
				scryTopOrder = scryTopOrder.filter((id) => id !== instanceId);
				scryBottomOrder = [...scryBottomOrder, instanceId];
			}
		} else {
			if (scryBottomOrder.includes(instanceId)) {
				scryBottomOrder = scryBottomOrder.filter((id) => id !== instanceId);
				scryTopOrder = [...scryTopOrder, instanceId];
			}
		}
	}

	function shiftScryCardOrder(instanceId: string, dir: -1 | 1) {
		const topIdx = scryTopOrder.indexOf(instanceId);
		if (topIdx >= 0) {
			const nextIdx = topIdx + dir;
			if (nextIdx >= 0 && nextIdx < scryTopOrder.length) {
				const copy = [...scryTopOrder];
				[copy[topIdx], copy[nextIdx]] = [copy[nextIdx], copy[topIdx]];
				scryTopOrder = copy;
			}
			return;
		}
		const botIdx = scryBottomOrder.indexOf(instanceId);
		if (botIdx >= 0) {
			const nextIdx = botIdx + dir;
			if (nextIdx >= 0 && nextIdx < scryBottomOrder.length) {
				const copy = [...scryBottomOrder];
				[copy[botIdx], copy[nextIdx]] = [copy[nextIdx], copy[botIdx]];
				scryBottomOrder = copy;
			}
		}
	}

	async function submitChat() {
		if (!chatInput.trim()) return;
		const msg = chatInput.trim();
		chatInput = '';
		await onSendChat(msg, 'chat');
	}
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
	<!-- VFX Canvas Layer -->
	<canvas bind:this={vfxCanvas} class="vfx-canvas"></canvas>

	<!-- SVG Targeting & Combat Arrows Layer -->
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
			<path
				d={computeBezierPath(ar.x1, ar.y1, ar.x2, ar.y2)}
				class="bezier-arrow {ar.kind}"
				filter={ar.kind === 'attack'
					? 'url(#arrow-glow-attack)'
					: ar.kind === 'block'
						? 'url(#arrow-glow-block)'
						: ar.kind === 'attachment'
							? 'url(#arrow-glow-attachment)'
							: 'url(#arrow-glow-target)'}
				marker-end={ar.kind === 'attack'
					? 'url(#arrow-attack)'
					: ar.kind === 'block'
						? 'url(#arrow-block)'
						: ar.kind === 'attachment'
							? 'url(#arrow-attachment)'
							: 'url(#arrow-target)'}
			/>
		{/each}
	</svg>

	<!-- Hold ALT Floating Card Image Preview Over Mouse -->
	{#if altHeld && hoveredCard}
		<div
			class="alt-hover-preview"
			class:side-details={altPreviewPos.sideMode}
			class:place-left={altPreviewPos.placeLeft}
			style="left: {altPreviewPos.x}px; top: {altPreviewPos.y}px;"
		>
			<img src={hoveredCard.imageUrl} alt={hoveredCard.name} />
			<div class="alt-preview-meta">
				<div class="alt-preview-head">
					<strong>{hoveredCard.name}</strong>
					<ManaText text={hoveredCard.manaCost} size={16} />
				</div>
				<div class="alt-preview-type">
					{hoverBreakdown ? hoverBreakdown.effectiveTypeLine : hoveredCard.typeLine}
					{#if hoverBreakdown?.typeModified}
						<span class="type-mod-note">
							(was {hoverBreakdown.baseTypeLine} — {hoverBreakdown.typeModifiedBy.join(', ')})
						</span>
					{/if}
				</div>
				{#if hoverBreakdown && hoverBreakdown.effectivePower !== null && hoverBreakdown.effectiveToughness !== null}
					<div class="alt-preview-pt">
						<span>P/T: <strong>{hoverBreakdown.effectivePower}/{hoverBreakdown.effectiveToughness}</strong></span>
						{#if hoverBreakdown.ptModifiedBy.length > 0}
							<span class="pt-mod-note">
								(base {hoverBreakdown.basePower ?? 0}/{hoverBreakdown.baseToughness ?? 0}: {hoverBreakdown.ptModifiedBy.join(', ')})
							</span>
						{/if}
					</div>
				{/if}
				{#if hoverBreakdown && hoverBreakdown.items.length > 0}
					<div class="alt-kw-section">
						<div class="alt-kw-title">KEYWORDS &amp; EFFECTS</div>
						<div class="alt-kw-list">
							{#each hoverBreakdown.items as item (item.id)}
								<div class="alt-kw-row" class:is-removed={item.removed}>
									<span class="kw-name" class:crossed-out={item.removed}>
										{item.name}
									</span>
									{#each item.sources as src}
										<span class="kw-source" class:innate={src === 'innate'} class:granted={src !== 'innate'}>
											({src})
										</span>
									{/each}
									{#if item.removed && item.removedBy.length > 0}
										<span class="kw-removed-by">
											(removed by {item.removedBy.join(', ')})
										</span>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				{/if}
				{#if hoveredCard.oracleText}
					<div class="alt-preview-oracle">
						<ManaText text={hoveredCard.oracleText} size={15} />
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Top Arena HUD Bar -->
	<header class="arena-hud">
		<div class="hud-left">
			<button type="button" class="hud-btn" onclick={onLeaveMatch}>
				Back to Pod ({lobbyCode})
			</button>
			<span class="turn-pill">TURN {gameState.turnNumber}</span>
			<span class="active-pill">
				Active: <strong>{activePlayer?.username}</strong>
			</span>
			<span class="priority-pill" class:mine={hasPriority}>
				Priority: <strong>{priorityPlayer?.username}</strong>
			</span>
		</div>

		<!-- Phase Ladder -->
		<div class="phase-ladder">
			{#each PHASE_ORDER as ph}
				{#if ph !== 'untap' && ph !== 'cleanup' && ph !== 'first_strike_damage' && ph !== 'end_combat'}
					<button
						type="button"
						class="phase-step"
						class:current={gameState.phase === ph}
						class:stopped={me?.stopPhases.includes(ph)}
						title="Click to toggle Phase Stop on {PHASE_LABELS[ph]}"
						onclick={() => onGameAction({ type: 'toggle_stop_phase', phase: ph })}
					>
						{PHASE_LABELS[ph]}
					</button>
				{/if}
			{/each}
		</div>

		<div class="hud-right">
			<span class="alt-hint" title="Hold Alt while hovering over any card to preview over cursor">
				[Hold ALT: Preview]
			</span>
			{#if ropeRemainingSec !== null}
				<span class="rope-pill" class:urgent={ropeRemainingSec <= 15}>
					Timer: {ropeRemainingSec}s
				</span>
			{/if}
			<button
				type="button"
				class="hud-btn"
				title="Reset adjustable panel sizes to defaults"
				onclick={resetLayoutPrefs}
			>
				Reset Layout
			</button>
			<button
				type="button"
				class="hud-btn"
				class:active-ctrl={me?.fullControl}
				onclick={() =>
					onGameAction({ type: 'toggle_full_control', enabled: !me?.fullControl })}
			>
				{me?.fullControl ? 'Full Control: ON' : 'Full Control: OFF'}
			</button>
			<button
				type="button"
				class="hud-btn danger"
				onclick={() => onGameAction({ type: 'concede' })}
			>
				Concede
			</button>
			<button
				type="button"
				class="theme-btn"
				onclick={onToggleTheme}
				aria-label="Toggle color theme"
				title={theme === 'light' ? 'Switch to Monokai Pro Dark' : 'Switch to Monokai Pro Light'}
			>
				<svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">
					{#if theme === 'light'}
						<path
							d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z"
							fill="currentColor"
						/>
					{:else}
						<circle cx="10" cy="10" r="4.2" fill="currentColor" />
						<path
							d="M10 1.5v2.2M10 16.3v2.2M1.5 10h2.2M16.3 10h2.2M4 4l1.6 1.6M14.4 14.4L16 16M16 4l-1.6 1.6M5.6 14.4L4 16"
							stroke="currentColor"
							stroke-width="1.6"
							stroke-linecap="round"
						/>
					{/if}
				</svg>
				<span>{theme === 'light' ? 'Dark' : 'Light'}</span>
			</button>
		</div>
	</header>

	<!-- Active Targeting Banner -->
	{#if pendingTargetAction}
		<div class="target-banner">
			<span>
				Select
				{#if pendingTargetAction.targetInfo.maxTargets > 1}
					<strong>
						{pendingTargetAction.selectedTargets.length}/{pendingTargetAction.targetInfo.maxTargets}
					</strong>
				{:else}
					a
				{/if}
				valid <strong>{pendingTargetAction.targetKind.replace(/_/g, ' ')}</strong> target(s) for
				<strong>{pendingTargetAction.card.name}</strong>
				<span class="cancel-hint">[Right-Click or ESC to cancel]</span>
			</span>
			<div class="target-banner-actions">
				{#if pendingTargetAction.targetInfo.zone === 'graveyard' && !zoneModal}
					<button
						type="button"
						class="hud-btn active-ctrl"
						onclick={() => openGraveyardTargetingModalIfNeeded(pendingTargetAction!.targetInfo)}
					>
						Open Graveyards
					</button>
				{/if}
				{#if pendingTargetAction.selectedTargets.length >= pendingTargetAction.targetInfo.minTargets && pendingTargetAction.targetInfo.maxTargets > 1}
					<button
						type="button"
						class="hud-btn active-ctrl"
						onclick={submitSelectedTargets}
					>
						Confirm {pendingTargetAction.selectedTargets.length} Target(s)
					</button>
				{/if}
				<button type="button" class="hud-btn" onclick={cancelTargeting}>
					Cancel Targeting
				</button>
			</div>
		</div>
	{/if}

	<!-- Combat Damage Forecast Layover Bar -->
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
				<span class="cfb-pill atk-count">
					{atkList.length} Attacking ({unblockedTotal} Unblocked, {blockedTotal} Blocked)
				</span>
			</div>

			<div class="cfb-section">
				{#each attackedPlayers as pInc (pInc.playerId)}
					<span
						class="cfb-pill player-dmg"
						class:lethal={pInc.isLethal}
						class:safe={pInc.totalLifeLoss === 0 && pInc.totalPoisonGain === 0}
					>
						<strong>{pInc.playerId === me?.playerId ? 'YOU' : pInc.username}:</strong>
						{#if pInc.totalLifeLoss > 0}
							-{pInc.totalLifeLoss} Life ({pInc.projectedLife + pInc.totalLifeLoss} → {pInc.projectedLife})
						{/if}
						{#if pInc.totalPoisonGain > 0}
							+{pInc.totalPoisonGain} Poison ({pInc.projectedPoison - pInc.totalPoisonGain} → {pInc.projectedPoison})
						{/if}
						{#if pInc.totalLifeLoss === 0 && pInc.totalPoisonGain === 0}
							0 Damage (All Blocked)
						{/if}
						{#if pInc.trampleThroughDamage > 0}
							<span class="cfb-sub">({pInc.trampleThroughDamage} Trample)</span>
						{/if}
						{#if pInc.isLethal}
							<strong class="lethal-tag">💀 LETHAL ({pInc.lethalReason})</strong>
						{/if}
					</span>
				{/each}

				{#each attackedWalkers as pwInc (pwInc.instanceId)}
					<span class="cfb-pill walker-dmg" class:lethal={pwInc.willDie}>
						<strong>🛡️ {pwInc.name}:</strong>
						-{pwInc.loyaltyLoss} Loyalty (L:{pwInc.currentLoyalty} → L:{pwInc.projectedLoyalty})
						{#if pwInc.willDie}
							<strong class="lethal-tag">💀 DESTROYED</strong>
						{/if}
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

	<!-- Main Arena Grid: Battlefield Table + Vertical Resizer + Right Stack/Chat Dock -->
	<div class="arena-main" style="grid-template-columns: minmax(0, 1fr) 6px {dockWidth}px;">
		<div bind:this={tableAreaEl} class="table-area">
			<!-- Opponent Quadrants Row -->
			<div class="opponents-row" style="height: {oppHeightPct}%;">
				{#each opponents as opp (opp.playerId)}
					<section
						class="opp-board"
						class:active-turn={activePlayer?.playerId === opp.playerId}
						class:has-prio={priorityPlayer?.playerId === opp.playerId}
						class:eliminated={opp.lost}
					>
						<div class="opp-header">
							<button
								type="button"
								class="player-badge"
								class:targetable-player={isPlayerTargetableNow(opp)}
								data-game-id={opp.playerId}
								onclick={() => handlePlayerAvatarClick(opp)}
								ondragover={(e) => {
									if (draggingCard) e.preventDefault();
								}}
								ondrop={(e) =>
									handleDropOnTarget(e, {
										kind: 'player',
										id: opp.playerId,
										label: opp.username
									})}
							>
								<span class="p-name">
									{opp.username}
									{#if opp.isBot}<span class="bot-tag">BOT</span>{/if}
								</span>
								<span class="life-orb" class:low={opp.life <= 10}>Life: {opp.life}</span>
								{#if opp.poison > 0}
									<span class="poison-orb">Poison: {opp.poison}</span>
								{/if}
								{#if combatForecast.active && combatForecast.playerIncoming[opp.playerId]}
									{@const oppInc = combatForecast.playerIncoming[opp.playerId]}
									{#if oppInc.unblockedCount > 0 || oppInc.blockedCount > 0}
										<span
											class="incoming-dmg-layover"
											class:lethal={oppInc.isLethal}
											class:all-blocked={oppInc.totalLifeLoss === 0 && oppInc.totalPoisonGain === 0}
										>
											{#if oppInc.totalLifeLoss > 0}
												⚔️ -{oppInc.totalLifeLoss} ({opp.life}→{oppInc.projectedLife})
											{:else if oppInc.totalPoisonGain > 0}
												☠️ +{oppInc.totalPoisonGain} Psn
											{:else}
												🛡️ 0 DMG
											{/if}
											{#if oppInc.isLethal} 💀{/if}
										</span>
									{/if}
								{/if}
							</button>
							{#if thinkingBotId === opp.playerId}
								<span class="bot-thinking-pill" aria-live="polite">{opp.username} is thinking…</span>
							{/if}

							<div class="opp-zones">
								<span class="z-chip" title="Cards in Hand">Hand: {opp.handCount ?? opp.hand.length}</span>
								<span class="z-chip" title="Cards in Library">Lib: {opp.libraryCount ?? opp.library.length}</span>
								<button
									type="button"
									class="z-chip clickable"
									onclick={() =>
										(zoneModal = {
											title: 'Graveyard',
											cards: opp.graveyard,
											ownerName: opp.username
										})}
								>
									GY: {opp.graveyard.length}
								</button>
								<button
									type="button"
									class="z-chip clickable"
									onclick={() =>
										(zoneModal = {
											title: 'Exile',
											cards: opp.exile,
											ownerName: opp.username
										})}
								>
									Exile: {opp.exile.length}
								</button>
							</div>
						</div>

						<!-- Commander Damage Taken Bar -->
						<div class="cmd-dmg-bar">
							{#each Object.entries(opp.commanderDamageTaken) as [cmdId, dmg]}
								{#if dmg > 0}
									<span class="cmd-dmg-pill" title="Commander Combat Damage from {opp.commanderNames[cmdId]}">
										CMD {opp.commanderNames[cmdId]?.split(',')[0]}: {dmg}/{gameState.rules.commanderDamageLethal || 'INF'}
									</span>
								{/if}
							{/each}
						</div>

						<!-- Opponent Battlefield + Command Zone -->
						<div class="opp-field">
							{#each opp.command as cmd (cmd.instanceId)}
								<button
									type="button"
									class="mini-card cmd-zone-card unactable"
									data-game-id={cmd.instanceId}
									onmouseenter={() => hoverCard(cmd.card, cmd)}
									onmouseleave={() => leaveCard(cmd.card)}
									onclick={() => {
										inspectedCard = cmd.card;
										inspectedInstance = cmd;
									}}
								>
									<img src={cmd.card.artCropUrl} alt={cmd.card.name} loading="lazy" />
									<span class="mc-tag">CMD (+{cmd.commanderCastCount * gameState.rules.commanderTaxIncrement})</span>
									<span class="mc-name">{cmd.card.name}</span>
								</button>
							{/each}

							{#each opp.battlefield as perm (perm.instanceId)}
								{@const actable = isPermanentActableNow(perm, opp)}
								{@const atkInfo = combatForecast.attackerSummaries[perm.instanceId]}
								{@const blkInfo = combatForecast.blockerSummaries[perm.instanceId]}
								{@const pwInfo = combatForecast.planeswalkerIncoming[perm.instanceId]}
								{@const attachedHere = getAttachedCardsOnBoard(gameState, perm.instanceId)}
								{@const hostCard = getHostCardOnBoard(gameState, perm.attachedToId)}
								<button
									type="button"
									class="mini-card"
									class:tapped={perm.tapped}
									class:unactable={!actable}
									class:selected-target={pendingTargetAction?.selectedTargets.some(
										(t) => t.id === perm.instanceId
									)}
									class:attacking={Boolean(atkInfo)}
									class:blocking={Boolean(blkInfo)}
									class:attachment-linked={isAttachmentLinkedToHover(perm)}
									data-game-id={perm.instanceId}
									onmouseenter={() => hoverCard(perm.card, perm)}
									onmouseleave={() => leaveCard(perm.card)}
									onclick={() => handlePermanentClick(perm, opp)}
									ondragover={(e) => {
										if (draggingCard) e.preventDefault();
									}}
									ondrop={(e) =>
										handleDropOnTarget(e, {
											kind: 'permanent',
											id: perm.instanceId,
											label: perm.card.name
										})}
								>
									<img src={perm.card.artCropUrl} alt={perm.card.name} loading="lazy" />
									{#if atkInfo}
										<span class="combat-mini-banner atk" class:blocked={atkInfo.isBlocked}>
											⚔️ ATK{#if atkInfo.isBlocked} (BLK){/if}{#if atkInfo.attackerDies} 💀{/if}
										</span>
									{:else if blkInfo}
										<span class="combat-mini-banner blk">
											🛡️ BLK{#if blkInfo.blockerDies} 💀{/if}
										</span>
									{/if}
									{#if pwInfo}
										<span class="pw-dmg-layover" class:lethal={pwInfo.willDie}>
											⚔️ -{pwInfo.loyaltyLoss} (L:{pwInfo.projectedLoyalty}){#if pwInfo.willDie} 💀{/if}
										</span>
									{/if}
									{#if hostCard}
										<span class="attach-mini-tag" title="Attached to {hostCard.card.name}">
											🔗→{hostCard.card.name.split(',')[0]}
										</span>
									{:else if attachedHere.length > 0}
										<span
											class="attach-mini-tag host"
											title="Attached: {attachedHere.map((a) => a.card.name).join(', ')}"
										>
											🗡️×{attachedHere.length}
										</span>
									{/if}
									<span class="mc-name">{perm.card.name}</span>
									{#if perm.counters['+1/+1'] > 0}
										<span class="counter-badge">+{perm.counters['+1/+1']}</span>
									{/if}
									{#if perm.card.typeLine.includes('Creature')}
										<span class="pt-badge" class:damaged={perm.damageMarked > 0}>
											{getCreaturePower(perm, gameState)}/{getCreatureToughness(perm, gameState) - perm.damageMarked}
										</span>
									{/if}
								</button>
							{/each}
						</div>
					</section>
				{/each}
			</div>

			<!-- Horizontal Splitter: Opponent Row vs Local Player Board -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="resizer-h"
				title="Drag to resize Opponent Zone vs. Your Battlefield"
				onmousedown={() => (activeDrag = 'opp_row')}
			>
				<span class="grip-dots"></span>
			</div>

			<!-- Local Player Board -->
			{#if me}
				<section
					bind:this={myBoardEl}
					class="my-board"
					class:active-turn={isMyTurn}
					class:has-prio={hasPriority}
				>
					<div bind:this={myZonesEl} class="my-battlefield-split">
						<!-- Front Row: Creatures & Planeswalkers -->
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
								<span>CREATURES &amp; PLANESWALKERS ({myCreaturesAndWalkers.length})</span>
								{#if validDragZones.has('front_row')}
									<span class="drop-zone-pill">DROP TO CAST</span>
								{/if}
								<button
									type="button"
									class="row-atk-all-btn"
									disabled={!canSelectAllAttackers}
									title={canSelectAllAttackers
										? 'Assign all eligible creatures to attack'
										: 'Available during your Declare Attackers step when you control an eligible attacker'}
									onclick={(e) => {
										e.stopPropagation();
										selectAllAttackers();
									}}
								>
									All Attack
								</button>
							</div>
							{#each myCreaturesAndWalkers as perm (perm.instanceId)}
								{@const actable = isPermanentActableNow(perm, me)}
								{@const atkInfo = combatForecast.attackerSummaries[perm.instanceId]}
								{@const blkInfo = combatForecast.blockerSummaries[perm.instanceId]}
								{@const pwInfo = combatForecast.planeswalkerIncoming[perm.instanceId]}
								{@const attachedHere = getAttachedCardsOnBoard(gameState, perm.instanceId)}
								<button
									type="button"
									class="board-card"
									class:tapped={perm.tapped}
									class:phased-out={perm.phasedOut}
									class:playable={actable}
									class:unactable={!actable}
									class:selected-target={pendingTargetAction?.selectedTargets.some(
										(t) => t.id === perm.instanceId
									)}
									class:sick={perm.summoningSick && !hasKeyword(perm, 'Haste', gameState)}
									class:attacking={Boolean(atkInfo)}
									class:blocking={Boolean(blkInfo)}
									class:draft-atk={Boolean(draftAttackers[perm.instanceId])}
									class:draft-blk={Boolean(draftBlockers[perm.instanceId]) || selectedBlockerId === perm.instanceId}
									class:attachment-linked={isAttachmentLinkedToHover(perm)}
									data-game-id={perm.instanceId}
									onmouseenter={() => hoverCard(perm.card, perm)}
									onmouseleave={() => leaveCard(perm.card)}
									onclick={() => handlePermanentClick(perm, me)}
									ondragover={(e) => {
										if (draggingCard) e.preventDefault();
									}}
									ondrop={(e) =>
										handleDropOnTarget(e, {
											kind: 'permanent',
											id: perm.instanceId,
											label: perm.card.name
										})}
								>
									<img src={perm.card.artCropUrl} alt={perm.card.name} loading="lazy" />
									{#if atkInfo}
										<div class="combat-card-banner atk-banner" class:blocked={atkInfo.isBlocked}>
											<span>⚔️ ATK → {(atkInfo.defenderPlaneswalkerName || atkInfo.defenderName).split(',')[0]}</span>
											<span class="combat-sub">
												{#if atkInfo.isBlocked}
													🛡️ Blocked ({atkInfo.blockerIds.length}){#if atkInfo.damageToDefender > 0} · 💥{atkInfo.damageToDefender}{/if}
												{:else}
													🔥 {atkInfo.damageToDefender || atkInfo.poisonToDefender} Unblocked
												{/if}
												{#if atkInfo.attackerDies} · 💀 DIES{/if}
											</span>
										</div>
									{:else if blkInfo}
										<div class="combat-card-banner blk-banner">
											<span>🛡️ BLK → {blkInfo.blockingAttackerName.split(',')[0]}</span>
											{#if blkInfo.blockerDies}
												<span class="combat-sub">💀 DIES IN COMBAT</span>
											{/if}
										</div>
									{/if}
									{#if pwInfo}
										<div class="pw-dmg-layover" class:lethal={pwInfo.willDie}>
											⚔️ -{pwInfo.loyaltyLoss} LOYALTY (L:{pwInfo.currentLoyalty}→{pwInfo.projectedLoyalty})
											{#if pwInfo.willDie} 💀{/if}
										</div>
									{/if}
									{#if attachedHere.length > 0}
										<div class="attached-items-strip" title="Attached: {attachedHere.map((a) => a.card.name).join(', ')}">
											{#each attachedHere as att (att.instanceId)}
												<span class="attached-pill">
													{att.card.typeLine.includes('Equipment') ? '🗡️' : '✨'} {att.card.name.split(',')[0]}
												</span>
											{/each}
										</div>
									{/if}
									<div class="bc-overlay">
										<span class="bc-name">{perm.card.name}</span>
										<div class="bc-badges">
											{#if perm.phasedOut}<span class="badge purple">PHASED</span>{/if}
											{#if perm.isCommander}<span class="badge gold">CMD</span>{/if}
											{#if perm.isToken}<span class="badge cyan">TOK</span>{/if}
											{#if perm.tapped}<ManaSymbol symbol="T" size={15} />{/if}
											{#if perm.counters['+1/+1'] > 0}
												<span class="badge green">+{perm.counters['+1/+1']}/+{perm.counters['+1/+1']}</span>
											{/if}
											{#if perm.counters.loyalty > 0}
												<span class="badge purple">L:{perm.counters.loyalty}</span>
											{/if}
										</div>
										{#if perm.card.typeLine.includes('Creature')}
											<span class="bc-pt" class:damaged={perm.damageMarked > 0}>
												{getCreaturePower(perm, gameState)}/{getCreatureToughness(perm, gameState) - perm.damageMarked}
											</span>
										{/if}
									</div>
								</button>
							{/each}
						</div>

						<!-- Horizontal Splitter: Creatures Row vs Lands/Command Row -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="resizer-h subtle"
							title="Drag to adjust Creatures row vs. Lands/Artifacts row"
							onmousedown={() => (activeDrag = 'player_rows')}
						>
							<span class="grip-dots"></span>
						</div>

						<!-- Back Row: Lands, Artifacts, Enchantments + Command Zone Pedestal -->
						<div
							bind:this={myBackRowEl}
							class="my-row back-row"
							style="height: {100 - frontRowPct}%;"
						>
							<!-- Command Zone Pedestal (Adjustable Width) -->
							<div class="command-pedestal" style="width: {pedestalWidth}px;">
								<span class="pedestal-label">COMMAND ZONE</span>
								<div class="pedestal-cards">
									{#each me.command as cmd (cmd.instanceId)}
										{@const playable = isCardPlayableNow(cmd, 'command')}
										<button
											type="button"
											class="board-card cmd-card"
											class:playable={playable}
											class:unactable={!playable}
											class:dragging-source={draggingCard?.inst.instanceId === cmd.instanceId}
											draggable={playable}
											data-game-id={cmd.instanceId}
											onmouseenter={() => hoverCard(cmd.card, cmd)}
											onmouseleave={() => leaveCard(cmd.card)}
											ondragstart={(e) => handleCardDragStart(e, cmd, 'command')}
											ondragend={handleCardDragEnd}
											onclick={() => handleCardClickInHandOrCommand(cmd, 'command')}
										>
											<img src={cmd.card.artCropUrl} alt={cmd.card.name} />
											<div class="bc-overlay">
												<span class="bc-name">{cmd.card.name}</span>
												<span class="badge gold">
													Tax: +{cmd.commanderCastCount * gameState.rules.commanderTaxIncrement}
												</span>
											</div>
										</button>
									{/each}
								</div>
							</div>

							<!-- Vertical Splitter: Command Zone Pedestal vs Lands Row -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="resizer-v subtle"
								title="Drag to resize Command Zone pedestal width"
								onmousedown={() => (activeDrag = 'pedestal')}
							>
								<span class="grip-dots-v"></span>
							</div>

							<!-- Middle Zone: Lands, Artifacts & Enchantments -->
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
									LANDS, ARTIFACTS &amp; ENCHANTMENTS ({myBackRow.length})
									{#if validDragZones.has('lands_area')}
										<span class="drop-zone-pill">
											{draggingCard?.inst.card.typeLine.includes('Land')
												? 'DROP TO PLAY LAND'
												: 'DROP TO CAST'}
										</span>
									{/if}
								</div>
								{#each myBackRow as perm (perm.instanceId)}
									{@const actable = isPermanentActableNow(perm, me)}
									{@const hostCard = getHostCardOnBoard(gameState, perm.attachedToId)}
									{@const attachedHere = getAttachedCardsOnBoard(gameState, perm.instanceId)}
									<button
										type="button"
										class="board-card compact"
										class:tapped={perm.tapped}
										class:playable={actable}
										class:unactable={!actable}
										class:selected-target={pendingTargetAction?.selectedTargets.some(
											(t) => t.id === perm.instanceId
										)}
										class:attachment-linked={isAttachmentLinkedToHover(perm)}
										data-game-id={perm.instanceId}
										onmouseenter={() => hoverCard(perm.card, perm)}
										onmouseleave={() => leaveCard(perm.card)}
										onclick={() => handlePermanentClick(perm, me)}
										ondragover={(e) => {
											if (draggingCard) e.preventDefault();
										}}
										ondrop={(e) =>
											handleDropOnTarget(e, {
												kind: 'permanent',
												id: perm.instanceId,
												label: perm.card.name
											})}
									>
										<img src={perm.card.artCropUrl} alt={perm.card.name} loading="lazy" />
										{#if hostCard}
											<div class="attached-items-strip on-attachment" title="Attached to {hostCard.card.name}">
												<span class="attached-pill host-ref">
													🔗 → {hostCard.card.name.split(',')[0]}
												</span>
											</div>
										{:else if attachedHere.length > 0}
											<div class="attached-items-strip" title="Attached: {attachedHere.map((a) => a.card.name).join(', ')}">
												{#each attachedHere as att (att.instanceId)}
													<span class="attached-pill">
														{att.card.typeLine.includes('Equipment') ? '🗡️' : '✨'} {att.card.name.split(',')[0]}
													</span>
												{/each}
											</div>
										{/if}
										<div class="bc-overlay">
											<span class="bc-name">{perm.card.name}</span>
											{#if perm.tapped}
												<span class="tapped-icon"><ManaSymbol symbol="T" size={14} /></span>
											{/if}
										</div>
									</button>
								{/each}
							</div>
						</div>
					</div>

					<!-- Horizontal Splitter: Battlefield Rows vs Hand & Bottom Console -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="resizer-h subtle"
						title="Drag to resize Hand &amp; Bottom Console height"
						onmousedown={() => (activeDrag = 'hand_height')}
					>
						<span class="grip-dots"></span>
					</div>

					<!-- Bottom Action Console: Adjustable Left Vitals + Center Hand (with Auto-Sort) + Adjustable Right Action Controls -->
					<div
						bind:this={myConsoleEl}
						class="my-console"
						style="height: {consoleHeight}px; --vitals-w: {vitalsWidth}px; --controls-w: {controlsWidth}px; --hc-h: {Math.max(66, consoleHeight - 44)}px; --hc-w: {Math.round(Math.max(66, consoleHeight - 44) * 0.72)}px;"
					>
						<!-- Left Side Section: Avatar, Life, Mana Pool, Library/Graveyard/Exile (Vertical Layout) -->
						<div class="my-vitals">
							<button
								type="button"
								class="my-avatar-btn"
								class:targetable-player={isPlayerTargetableNow(me)}
								data-game-id={me.playerId}
								onclick={() => handlePlayerAvatarClick(me)}
								ondragover={(e) => {
									if (draggingCard) e.preventDefault();
								}}
								ondrop={(e) =>
									handleDropOnTarget(e, {
										kind: 'player',
										id: me.playerId,
										label: me.username
									})}
							>
								<div class="my-vitals-top">
									<span class="my-life" class:low={me.life <= 10}>LIFE {me.life}</span>
									{#if me.poison > 0}
										<span class="poison-orb">POISON {me.poison}</span>
									{/if}
								</div>
								{#if combatForecast.active && combatForecast.playerIncoming[me.playerId]}
									{@const myInc = combatForecast.playerIncoming[me.playerId]}
									{#if myInc.unblockedCount > 0 || myInc.blockedCount > 0}
										<div
											class="incoming-dmg-layover my-incoming"
											class:lethal={myInc.isLethal}
											class:all-blocked={myInc.totalLifeLoss === 0 && myInc.totalPoisonGain === 0}
										>
											{#if myInc.totalLifeLoss > 0}
												⚔️ INCOMING: -{myInc.totalLifeLoss} LIFE ({me.life} → {myInc.projectedLife})
											{:else if myInc.totalPoisonGain > 0}
												☠️ INCOMING: +{myInc.totalPoisonGain} POISON ({me.poison} → {myInc.projectedPoison})
											{:else}
												🛡️ 0 DAMAGE (ALL BLOCKED)
											{/if}
											{#if myInc.isLethal} · 💀 LETHAL!{/if}
										</div>
									{/if}
								{/if}
								<span class="my-uname" title={me.username}>{me.username}</span>
							</button>

							<!-- Mana Pool Orbs with Vector Mana Symbols (3x2 Vertical Grid) -->
							<div class="mana-pool">
								{#each (['W', 'U', 'B', 'R', 'G', 'C'] as ManaColor[]) as col}
									<span class="mana-orb" class:filled={me.manaPool[col] > 0}>
										<ManaSymbol symbol={col} size={15} />
										<span>{me.manaPool[col]}</span>
									</span>
								{/each}
							</div>

							<div class="my-zones">
								<span class="z-chip" title="Lands played this turn">
									Lands {me.landsPlayedThisTurn}/{me.maxLandsPerTurn}
								</span>
								<span class="z-chip">Lib {me.libraryCount ?? me.library.length}</span>
								<button
									type="button"
									class="z-chip clickable"
									onclick={() =>
										(zoneModal = {
											title: 'Your Graveyard',
											cards: me.graveyard,
											ownerName: me.username
										})}
								>
									GY {me.graveyard.length}
								</button>
								<button
									type="button"
									class="z-chip clickable"
									onclick={() =>
										(zoneModal = {
											title: 'Your Exile',
											cards: me.exile,
											ownerName: me.username
										})}
								>
									Exile {me.exile.length}
								</button>
								{#if gameState.players.some((p) => p.exile.some((c) => c.playableFromExileBy?.playerId === me.playerId))}
									{@const myPlayableExileCards = gameState.players.flatMap((p) =>
										p.exile.filter((c) => c.playableFromExileBy?.playerId === me.playerId)
									)}
									<button
										type="button"
										class="z-chip clickable"
										title="Cards exiled by Opposition Agent or other effects that you may play from Exile"
										onclick={() =>
											(zoneModal = {
												title: 'Playable from Exile',
												cards: myPlayableExileCards,
												ownerName: me.username
											})}
									>
										✨ Stolen ({myPlayableExileCards.length})
									</button>
								{/if}
							</div>
						</div>

						<!-- Vertical Splitter: Left Vitals Side Section vs Center Hand Section -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="resizer-v subtle"
							title="Drag to resize Left Status / Mana side section vs. Hand"
							onmousedown={() => (activeDrag = 'hand_left')}
						>
							<span class="grip-dots-v"></span>
						</div>

						<!-- Center: Hand Tray with Auto-Sort Toolbar + Curved Interactive Hand -->
						<div class="hand-tray">
							<div class="hand-toolbar">
								<span class="hand-count-label">HAND ({sortedHand.length})</span>
								<div class="hand-sort-group" role="group" aria-label="Auto-sort hand">
									<span class="sort-caption">Sort:</span>
									{#each ([
										['none', 'None'],
										['cmc', 'CMC'],
										['name', 'Name'],
										['color', 'Color'],
										['type', 'Type']
									] as const) as [mode, label]}
										<button
											type="button"
											class="sort-pill"
											class:active={handSortBy === mode}
											onclick={() => setHandSort(mode)}
										>
											{label}
										</button>
									{/each}
									<span class="sort-divider" aria-hidden="true">|</span>
									<button
										type="button"
										class="sort-pill dir-pill"
										class:active={handSortBy !== 'none' && handSortDir === 'asc'}
										title="Sort Ascending"
										onclick={() => setHandSortDir('asc')}
									>
										ASC
									</button>
									<button
										type="button"
										class="sort-pill dir-pill"
										class:active={handSortBy !== 'none' && handSortDir === 'desc'}
										title="Sort Descending"
										onclick={() => setHandSortDir('desc')}
									>
										DESC
									</button>
								</div>
							</div>

							<div class="hand-fan">
								{#each sortedHand as cardInst, idx (cardInst.instanceId)}
									{@const playable = isCardPlayableNow(cardInst, 'hand')}
									{@const suspendClause = getSuspendSpec(cardInst.card)}
									{@const canSuspend = me ? checkSuspendLegality(gameState, me.playerId, cardInst).ok : false}
									{@const offset = idx - (sortedHand.length - 1) / 2}
									<div class="hand-card-wrap" style="--fan-rot: {offset * 1.4}deg; --fan-y: {Math.abs(offset) * 1.5}px;">
										<button
											type="button"
											class="hand-card"
											class:playable={playable}
											class:unactable={!playable}
											class:dragging-source={draggingCard?.inst.instanceId === cardInst.instanceId}
											draggable={playable}
											data-game-id={cardInst.instanceId}
											onmouseenter={() => hoverCard(cardInst.card, cardInst)}
											onmouseleave={() => leaveCard(cardInst.card)}
											ondragstart={(e) => handleCardDragStart(e, cardInst, 'hand')}
											ondragend={handleCardDragEnd}
											onclick={() => handleCardClickInHandOrCommand(cardInst, 'hand')}
										>
											<img src={cardInst.card.imageUrl} alt={cardInst.card.name} loading="lazy" />
											<span class="hc-cost">
												{#if cardInst.card.manaCost}
													<ManaText text={cardInst.card.manaCost} size={14} />
												{:else if suspendClause}
													Susp {suspendClause.suspendCost}
												{:else}
													Land
												{/if}
											</span>
										</button>
										{#if suspendClause && canSuspend}
											<button
												type="button"
												class="hc-suspend-btn"
												title="Suspend {suspendClause.timeCounters} — {suspendClause.suspendCost}"
												onclick={async (e) => {
													e.stopPropagation();
													await onGameAction({ type: 'suspend_card', instanceId: cardInst.instanceId });
												}}
											>
												⏳ Suspend ({suspendClause.timeCounters})
											</button>
										{/if}
									</div>
								{/each}
							</div>
						</div>

						<!-- Vertical Splitter: Center Hand Section vs Right Action Controls Side Section -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="resizer-v subtle"
							title="Drag to resize Hand vs. Right Action Controls side section"
							onmousedown={() => (activeDrag = 'hand_right')}
						>
							<span class="grip-dots-v"></span>
						</div>

						<!-- Right Side Section: Turn Phase/Step Info + Fixed-Slot Turn Action Buttons -->
						<div class="arena-controls">
							<div
								class="turn-phase-box"
								class:my-turn={isMyTurn}
								class:has-prio={hasPriority}
								title="Turn {gameState.turnNumber} ({activePlayer?.username ?? '—'}) — {currentPhaseDetail.phaseTitle}: {currentPhaseDetail.stepTitle} | Priority: {priorityPlayer?.username ?? '—'}"
							>
								<div class="tpb-top">
									<span class="tpb-turn">
										T{gameState.turnNumber} · {isMyTurn ? 'YOUR TURN' : (activePlayer?.username ?? '—')}
									</span>
									<span class="tpb-prio" class:mine={hasPriority}>
										{hasPriority ? 'PRIO' : (priorityPlayer?.username ?? '—')}
									</span>
								</div>
								<div class="tpb-step-row">
									<span class="tpb-phase">{currentPhaseDetail.phaseTitle}</span>
									<span class="tpb-sep" aria-hidden="true">›</span>
									<span class="tpb-step">{currentPhaseDetail.stepTitle}</span>
								</div>
								<div class="tpb-pips" aria-hidden="true">
									{#each TURN_PHASE_GROUPS as grp, idx (grp.id)}
										<span
											class="tpb-pip"
											class:done={idx < currentPhaseDetail.groupIndex}
											class:active={idx === currentPhaseDetail.groupIndex}
										></span>
									{/each}
								</div>
							</div>

							<button
								type="button"
								class="turn-ctrl-btn primary-step-btn"
								class:can-act={canAdvanceOrPass}
								class:stack-active={gameState.stack.length > 0 && canAdvanceOrPass}
								disabled={!canAdvanceOrPass}
								title={primaryStepTitle}
								onclick={handlePrimaryArenaButton}
							>
								<span class="turn-ctrl-label">{primaryStepLabel}</span>
							</button>

							<button
								type="button"
								class="turn-ctrl-btn end-turn-btn"
								class:can-act={canPassToEndOfTurn}
								disabled={!canPassToEndOfTurn}
								title={endTurnTitle}
								onclick={handlePassToEndOfTurn}
							>
								<span class="turn-ctrl-label">Pass to End of Turn</span>
							</button>
						</div>
					</div>
				</section>
			{/if}
		</div>

		<!-- Vertical Splitter: Battlefield Table vs Right Dock -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="resizer-v"
			title="Drag to resize Right Dock width"
			onmousedown={() => (activeDrag = 'dock')}
		>
			<span class="grip-dots-v"></span>
		</div>

		<!-- Right Sidebar: Adjustable Clicked Card Info + Adjustable Stack + Live Chat / Rules Log -->
		<aside class="arena-dock">
			<!-- Clicked Card Info Panel -->
			<div class="card-zoom-box" style="height: {inspectorHeight}px;">
				{#if inspectedCard}
					<div class="zoom-inner">
						<img src={inspectedCard.imageUrl} alt={inspectedCard.name} class="zoom-img" />
						<div class="zoom-meta">
							<div class="zoom-title">
								<strong>{inspectedCard.name}</strong>
								<ManaText text={inspectedCard.manaCost} size={16} />
							</div>
							<div class="zoom-type">
								{inspectBreakdown ? inspectBreakdown.effectiveTypeLine : inspectedCard.typeLine}
								{#if inspectBreakdown?.typeModified}
									<span class="type-mod-note">
										(was {inspectBreakdown.baseTypeLine} — {inspectBreakdown.typeModifiedBy.join(', ')})
									</span>
								{/if}
							</div>
							{#if inspectBreakdown && inspectBreakdown.items.length > 0}
								<div class="alt-kw-section compact">
									<div class="alt-kw-title">KEYWORDS &amp; EFFECTS</div>
									<div class="alt-kw-list">
										{#each inspectBreakdown.items as item (item.id)}
											<div class="alt-kw-row" class:is-removed={item.removed}>
												<span class="kw-name" class:crossed-out={item.removed}>
													{item.name}
												</span>
												{#each item.sources as src}
													<span class="kw-source" class:innate={src === 'innate'} class:granted={src !== 'innate'}>
														({src})
													</span>
												{/each}
												{#if item.removed && item.removedBy.length > 0}
													<span class="kw-removed-by">
														(removed by {item.removedBy.join(', ')})
													</span>
												{/if}
											</div>
										{/each}
									</div>
								</div>
							{/if}
							<div class="zoom-oracle">
								<ManaText text={inspectedCard.oracleText} size={15} />
							</div>
							{#if inspectUnsupported.length > 0}
								<div class="zoom-unsupported">
									<div class="zoom-unsupported-title">Not automated</div>
									{#each inspectUnsupported as u, i (i)}
										<div class="zoom-unsupported-row">
											<span class="zoom-unsupported-kind">{unsupportedKindLabel(u.kind)}:</span>
											<ManaText text={displayAbilityText(u.text, u.face) || '(whole card)'} size={13} />
											{#if canResolveInspectedManually && inspectedInstance && u.kind !== 'mana' && u.kind !== 'multiface'}
												<button
													type="button"
													class="zoom-resolve-btn"
													title="Apply this ability by hand with guided operations (doesn't use the stack)"
													onclick={() =>
														inspectedInstance &&
														onGameAction({ type: 'resolve_manually', instanceId: inspectedInstance.instanceId, abilityIndex: i })}
												>
													Resolve manually
												</button>
											{/if}
										</div>
									{/each}
								</div>
							{/if}
							{#if inspectBreakdown && inspectBreakdown.effectivePower !== null && inspectBreakdown.effectiveToughness !== null}
								<div class="zoom-pt">
									{inspectBreakdown.effectivePower}/{inspectBreakdown.effectiveToughness}
								</div>
							{:else if inspectedCard.power !== undefined}
								<div class="zoom-pt">{inspectedCard.power}/{inspectedCard.toughness}</div>
							{/if}
						</div>
					</div>
				{:else}
					<div class="zoom-placeholder">
						Click or hover any card to inspect details (Hold ALT to float over cursor)
					</div>
				{/if}
			</div>

			<!-- Horizontal Splitter: Card Info vs Stack -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="resizer-h"
				title="Drag to resize Clicked Card Info panel"
				onmousedown={() => (activeDrag = 'inspector')}
			>
				<span class="grip-dots"></span>
			</div>

			<!-- The Stack (LIFO) -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="stack-panel"
				class:drop-zone-valid={validDragZones.has('stack')}
				class:drop-zone-active={dragOverZone === 'stack' && validDragZones.has('stack')}
				style="height: {stackHeight}px;"
				ondragover={(e) => handleZoneDragOver(e, 'stack')}
				ondragleave={(e) => handleZoneDragLeave(e, 'stack')}
				ondrop={(e) => handleZoneDrop(e, 'stack')}
			>
				<div class="dock-head">
					<span>THE STACK ({gameState.stack.length})</span>
					{#if validDragZones.has('stack')}
						<span class="drop-zone-pill">DROP ON STACK TO CAST</span>
					{:else}
						<span class="lifo-hint">Resolves Top -> Down</span>
					{/if}
				</div>
				{#if gameState.stack.length === 0}
					<div class="stack-empty">Stack is empty</div>
				{:else}
					<div class="stack-list">
						{#each [...gameState.stack].reverse() as item, idx (item.id)}
							{@const targetable = isStackItemTargetableNow(item)}
							<button
								type="button"
								class="stack-card"
								class:top-of-stack={idx === 0}
								class:targetable-stack={targetable}
								data-game-id={item.id}
								onmouseenter={() => hoverCard(item.card)}
								onmouseleave={() => leaveCard(item.card)}
								onclick={() => handleStackItemClick(item)}
								ondragover={(e) => {
									if (draggingCard) e.preventDefault();
								}}
								ondrop={(e) =>
									handleDropOnTarget(e, {
										kind: 'stack',
										id: item.id,
										label: item.title
									})}
							>
								<img src={item.card.artCropUrl} alt={item.title} />
								<div class="stk-info">
									<span class="stk-title">#{gameState.stack.length - idx}: {item.title}</span>
									{#if item.targets.length > 0}
										<span class="stk-target">Target -> {item.targets.map((t) => t.label).join(', ')}</span>
									{/if}
								</div>
							</button>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Horizontal Splitter: Stack vs Chat/Log -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="resizer-h"
				title="Drag to resize Stack vs. Chat height"
				onmousedown={() => (activeDrag = 'stack')}
			>
				<span class="grip-dots"></span>
			</div>

			<!-- Tabbed Live Chat & Rules Audit Log -->
			<div class="chat-panel">
				<div class="dock-tabs">
					<button
						type="button"
						class:active={dockTab === 'chat'}
						onclick={() => (dockTab = 'chat')}
					>
						Pod Chat ({chatMessages.length})
					</button>
					<button
						type="button"
						class:active={dockTab === 'log'}
						onclick={() => (dockTab = 'log')}
					>
						Rules Log ({gameState.log.length})
					</button>
				</div>

				{#if dockTab === 'chat'}
					<div class="chat-feed">
						{#each chatMessages as m (m.id)}
							<div class="chat-msg kind-{m.kind}">
								<span class="cm-user">{m.username}:</span>
								<span class="cm-text">{m.message}</span>
							</div>
						{/each}
					</div>
					<div class="emote-row">
						{#each EMOTES as em}
							<button type="button" class="emote-btn" onclick={() => onSendChat(em, 'emote')}>
								{em}
							</button>
						{/each}
					</div>
					<form
						class="chat-form"
						onsubmit={(e) => {
							e.preventDefault();
							submitChat();
						}}
					>
						<input
							type="text"
							placeholder="Message pod..."
							bind:value={chatInput}
						/>
						<button type="submit">Send</button>
					</form>
				{:else}
					<div class="chat-feed">
						{#each [...gameState.log].reverse() as entry (entry.id)}
							<div class="log-entry kind-{entry.kind}">
								<span class="le-turn">[T{entry.turn}]</span>
								<span>{entry.text}</span>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</aside>
	</div>

	<!-- Activated Ability Selector Modal -->
	{#if selectedPermanentForAbility && me}
		{@const abilities = getEffectiveActivatedAbilities(
			gameState,
			me,
			selectedPermanentForAbility,
			getPlayerCommanderIdentity(me)
		)}
		<div class="modal-backdrop">
			<div class="arena-modal">
				<h3>{selectedPermanentForAbility.card.name} — Abilities</h3>
				<div class="modal-desc">
					<ManaText text={selectedPermanentForAbility.card.oracleText} size={15} />
				</div>
				<div class="ability-list">
					{#each abilities as ab (ab.id)}
						{@const abCheck = checkAbilityActivationLegality(
							gameState,
							me.playerId,
							selectedPermanentForAbility,
							ab
						)}
						<button
							type="button"
							class="ability-choice-btn"
							disabled={!abCheck.ok}
							title={abCheck.error || ab.label}
							onclick={async () => {
								const perm = selectedPermanentForAbility!;
								selectedPermanentForAbility = null;
								if (ab.requiresTarget) {
									const abTargetInfo: TargetRequirementInfo = ab.targetInfo;
									pendingTargetAction = {
										mode: 'ability',
										instanceId: perm.instanceId,
										abilityId: ab.id,
										card: perm.card,
										targetKind: ab.targetInfo.targetKind,
										targetInfo: abTargetInfo,
										selectedTargets: [],
										xValue: 0
									};
									openGraveyardTargetingModalIfNeeded(abTargetInfo);
								} else {
									await onGameAction({
										type: 'activate_ability',
										instanceId: perm.instanceId,
										abilityId: ab.id
									});
								}
							}}
						>
							<ManaText text={ab.label} size={15} />
						</button>
					{/each}
				</div>
				<button
					type="button"
					class="hud-btn"
					onclick={() => (selectedPermanentForAbility = null)}
				>
					Close
				</button>
			</div>
		</div>
	{/if}

	<!-- X-Cost Selector Modal -->
	{#if xCostModalCard}
		<div class="modal-backdrop">
			<div class="arena-modal">
				<h3>Choose Value for X — {xCostModalCard.inst.card.name}</h3>
				<div class="x-selector">
					<input type="number" min="0" max="25" bind:value={xCostValue} />
				</div>
				<div class="modal-actions">
					<button
						type="button"
						class="arena-main-btn can-act"
						onclick={async () => {
							const item = xCostModalCard!;
							xCostModalCard = null;
							await initiateCastSpell(item.inst, item.fromZone, xCostValue);
						}}
					>
						Cast with X = {xCostValue}
					</button>
					<button type="button" class="hud-btn" onclick={() => (xCostModalCard = null)}>
						Cancel
					</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- Zone Browser Modal (Graveyard / Exile / Graveyard Target Selection) -->
	{#if zoneModal}
		{@const filteredZoneCards = zoneModal.cards.filter((c) =>
			matchesScryfallQuery(c.card, zoneSearchQuery)
		)}
		{@const isGraveTargeting = pendingTargetAction?.targetInfo.zone === 'graveyard'}
		<div class="modal-backdrop">
			<div class="arena-modal wide">
				<div class="modal-head-row">
					<h3>{zoneModal.ownerName} — {zoneModal.title} ({filteredZoneCards.length}/{zoneModal.cards.length})</h3>
					<input
						type="search"
						class="modal-scryfall-input"
						bind:value={zoneSearchQuery}
						placeholder="Scryfall search (e.g. t:creature mv<=3 o:draw)..."
					/>
				</div>
				<div class="modal-card-grid">
					{#each filteredZoneCards as c (c.instanceId)}
						{#if isGraveTargeting}
							{@const canTarget = isGraveyardCardTargetableNow(c)}
							{@const isSelected = pendingTargetAction?.selectedTargets.some(
								(t) => t.id === c.instanceId
							)}
							<button
								type="button"
								class="modal-card-item selectable"
								class:selected={isSelected}
								disabled={!canTarget}
								onmouseenter={() => hoverCard(c.card)}
								onmouseleave={() => leaveCard(c.card)}
								onclick={() =>
									addOrSubmitTarget({
										kind: 'graveyard_card',
										id: c.instanceId,
										label: c.card.name
									})}
							>
								<img src={c.card.imageUrl} alt={c.card.name} />
								<span>{c.card.name}</span>
							</button>
						{:else}
							{@const isMyGraveyard = me && zoneModal.title.includes('Graveyard') && zoneModal.ownerName === me.username}
							{@const gyIndex = zoneModal.cards.findIndex((item) => item.instanceId === c.instanceId)}
							{@const canPlayFromExile = Boolean(me && c.zone === 'exile' && c.playableFromExileBy?.playerId === me.playerId && isCardPlayableNow(c, 'exile'))}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="modal-card-item"
								onmouseenter={() => hoverCard(c.card, c)}
								onmouseleave={() => leaveCard(c.card)}
							>
								<img src={c.card.imageUrl} alt={c.card.name} />
								<span>{c.card.name}</span>
								{#if c.isSuspended && c.counters.time > 0}
									<span class="badge purple">⏳ {c.counters.time} Time (Suspended)</span>
								{/if}
								{#if me && c.playableFromExileBy?.playerId === me.playerId}
									<span class="badge gold">✨ Playable ({c.playableFromExileBy.sourceName})</span>
									<button
										type="button"
										class="scry-zone-toggle to-top"
										disabled={!canPlayFromExile}
										onclick={async () => {
											zoneModal = null;
											zoneSearchQuery = '';
											await handleCardClickInHandOrCommand(c, 'exile');
										}}
									>
										{c.card.typeLine.includes('Land') ? '▶ Play Land from Exile' : '▶ Cast from Exile'}
									</button>
								{/if}
								{#if zoneModal.title.includes('Graveyard') && gyIndex >= 0}
									<div class="gy-order-bar">
										<span class="gy-rank">
											#{zoneModal.cards.length - gyIndex}
											{gyIndex === zoneModal.cards.length - 1 ? '(Top)' : gyIndex === 0 ? '(Bottom)' : ''}
										</span>
										{#if isMyGraveyard && zoneModal.cards.length > 1}
											<button
												type="button"
												class="gy-move-btn"
												disabled={gyIndex >= zoneModal.cards.length - 1}
												title="Move toward Top of Graveyard (CR 404.2)"
												onclick={async () => {
													const ids = zoneModal!.cards.map((x) => x.instanceId);
													const tmp = ids[gyIndex];
													ids[gyIndex] = ids[gyIndex + 1];
													ids[gyIndex + 1] = tmp;
													await onGameAction({ type: 'reorder_graveyard', instanceIds: ids });
												}}
											>
												⬆
											</button>
											<button
												type="button"
												class="gy-move-btn"
												disabled={gyIndex <= 0}
												title="Move toward Bottom of Graveyard (CR 404.2)"
												onclick={async () => {
													const ids = zoneModal!.cards.map((x) => x.instanceId);
													const tmp = ids[gyIndex];
													ids[gyIndex] = ids[gyIndex - 1];
													ids[gyIndex - 1] = tmp;
													await onGameAction({ type: 'reorder_graveyard', instanceIds: ids });
												}}
											>
												⬇
											</button>
										{/if}
									</div>
								{/if}
							</div>
						{/if}
					{/each}
				</div>
				<div class="modal-actions">
					{#if isGraveTargeting && pendingTargetAction && pendingTargetAction.selectedTargets.length >= pendingTargetAction.targetInfo.minTargets}
						<button
							type="button"
							class="arena-main-btn can-act"
							onclick={submitSelectedTargets}
						>
							Confirm {pendingTargetAction.selectedTargets.length} Target(s)
						</button>
					{/if}
					<button
						type="button"
						class="hud-btn"
						onclick={() => {
							if (isGraveTargeting) {
								cancelTargeting();
							} else {
								zoneModal = null;
								zoneSearchQuery = '';
							}
						}}
					>
						{isGraveTargeting ? 'Cancel Targeting' : 'Close'}
					</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- Blocking Prompts (Mulligan / London Bottom / Commander Zone Choice / Library Search / Guided Resolution) -->
	{#if myPrompt && me && myChoice}
		<div class="modal-backdrop">
			<div class="arena-modal wide">
				<h3>{myPrompt.title}</h3>
				<p class="modal-desc">{myPrompt.description}</p>

				{#if myChoice.kind === 'yesNo'}
					{#if myPromptPurpose === 'mulligan'}
						<div class="hand-toolbar modal-sort-bar">
							<span class="hand-count-label">OPENING HAND ({sortedHand.length})</span>
							<div class="hand-sort-group" role="group" aria-label="Auto-sort hand">
								<span class="sort-caption">Sort:</span>
								{#each ([
									['none', 'None'],
									['cmc', 'CMC'],
									['name', 'Name'],
									['color', 'Color'],
									['type', 'Type']
								] as const) as [mode, label]}
									<button
										type="button"
										class="sort-pill"
										class:active={handSortBy === mode}
										onclick={() => setHandSort(mode)}
									>
										{label}
									</button>
								{/each}
								<span class="sort-divider" aria-hidden="true">|</span>
								<button
									type="button"
									class="sort-pill dir-pill"
									class:active={handSortBy !== 'none' && handSortDir === 'asc'}
									title="Sort Ascending"
									onclick={() => setHandSortDir('asc')}
								>
									ASC
								</button>
								<button
									type="button"
									class="sort-pill dir-pill"
									class:active={handSortBy !== 'none' && handSortDir === 'desc'}
									title="Sort Descending"
									onclick={() => setHandSortDir('desc')}
								>
									DESC
								</button>
							</div>
						</div>
						<div class="modal-card-grid">
							{#each sortedHand as c (c.instanceId)}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div
									class="modal-card-item"
									onmouseenter={() => hoverCard(c.card)}
									onmouseleave={() => leaveCard(c.card)}
								>
									<img src={c.card.imageUrl} alt={c.card.name} />
									<span>{c.card.name}</span>
								</div>
							{/each}
						</div>
					{/if}

					{#if myPromptPurpose === 'guided_resolution'}
						<div class="guided-builder">
							<div class="guided-box">
								<label>
									Operation
									<select bind:value={guidedOpKind}>
										{#each Object.entries(GUIDED_OP_LABELS) as [k, label] (k)}
											<option value={k}>{label}</option>
										{/each}
									</select>
								</label>
								{#if guidedOpKind !== 'create_token'}
									<label>
										{guidedOpKind === 'draw_cards' || guidedOpKind === 'mill' ? 'Player (default: you)' : 'Target'}
										<select bind:value={guidedTargetId}>
											<option value="">—</option>
											{#each guidedTargetChoices as t (t.id)}
												<option value={t.id}>{t.label}</option>
											{/each}
										</select>
									</label>
								{/if}
								{#if guidedOpKind === 'move_zone'}
									<label>
										To
										<select bind:value={guidedZone}>
											{#each GUIDED_ZONES as z (z)}
												<option value={z}>{z}</option>
											{/each}
										</select>
									</label>
								{/if}
								{#if guidedOpKind === 'add_counter'}
									<label>
										Counter
										<select bind:value={guidedCounter}>
											{#each GUIDED_COUNTERS as c (c)}
												<option value={c}>{c}</option>
											{/each}
										</select>
									</label>
								{/if}
								{#if guidedOpKind === 'create_token'}
									<label>
										Token name
										<input type="text" maxlength="40" bind:value={guidedTokenName} />
									</label>
									<label>
										P/T
										<span class="guided-pt">
											<input type="number" min="0" max="100" bind:value={guidedTokenPower} />
											<input type="number" min="0" max="100" bind:value={guidedTokenToughness} />
										</span>
									</label>
								{/if}
								{#if guidedOpKind !== 'move_zone' && guidedOpKind !== 'tap' && guidedOpKind !== 'untap'}
									<label>
										{guidedOpKind === 'modify_life' || guidedOpKind === 'add_counter' ? 'Amount (+/-)' : 'Amount'}
										<input type="number" min="-100" max="100" bind:value={guidedAmount} />
									</label>
								{/if}
								<button type="button" class="hud-btn" onclick={addGuidedOp}>Add</button>
							</div>
							{#if guidedOps.length > 0}
								<ol class="guided-op-list">
									{#each guidedOps as op, i (i)}
										<li>
											{guidedLabel(op)}
											<button
												type="button"
												class="guided-op-remove"
												aria-label="Remove operation"
												onclick={() => (guidedOps = guidedOps.filter((_, j) => j !== i))}
											>
												×
											</button>
										</li>
									{/each}
								</ol>
							{:else}
								<p class="guided-hint">No operations yet. Add what the ability does, in order, then finish.</p>
							{/if}
						</div>
						<div class="modal-actions">
							<button
								type="button"
								class="arena-main-btn can-act"
								onclick={() =>
									onGameAction({
										type: 'choice',
										promptId: myPrompt.id,
										answer: { kind: 'yesNo', yes: true },
										operations: guidedOps
									})}
							>
								{myPrompt.yesLabel || 'Apply & Complete Resolution'}
							</button>
							{#if myPrompt.cancellable}
								<button
									type="button"
									class="hud-btn"
									onclick={() => onGameAction({ type: 'choice', promptId: myPrompt.id, cancel: true })}
								>
									Cancel
								</button>
							{/if}
						</div>
					{:else}
						{@const yesLabel =
							myPrompt.yesLabel ||
							(myPromptPurpose === 'mulligan'
								? `Keep Hand (Mulligans taken: ${me.mulliganCount})`
								: myPromptPurpose === 'commander_zone_choice'
									? 'Return to Command Zone (Recommended)'
									: myPromptPurpose === 'end_turn'
										? 'End the Turn Now (Exile All Spells/Abilities on Stack)'
										: 'Yes')}
						{@const noLabel =
							myPrompt.noLabel ||
							(myPromptPurpose === 'mulligan'
								? 'Mulligan (Draw New 7)'
								: myPromptPurpose === 'commander_zone_choice'
									? `Leave in ${myPrompt.destinationZone}`
									: myPromptPurpose === 'end_turn'
										? 'Decline (Continue Turn Normally)'
										: 'No')}
						<div class="modal-actions">
							<button
								type="button"
								class="arena-main-btn can-act"
								onclick={() =>
									onGameAction({
										type: 'choice',
										promptId: myPrompt.id,
										answer: { kind: 'yesNo', yes: true }
									})}
							>
								{yesLabel}
							</button>
							<button
								type="button"
								class="hud-btn"
								onclick={() =>
									onGameAction({
										type: 'choice',
										promptId: myPrompt.id,
										answer: { kind: 'yesNo', yes: false }
									})}
							>
								{noLabel}
							</button>
						</div>
						{#if myPromptPurpose === 'cost_choice'}
							<div class="modal-actions">
								<button
									type="button"
									class="hud-btn"
									onclick={() =>
										onGameAction({
											type: 'choice',
											promptId: myPrompt.id,
											cancel: true
										})}
								>
									Cancel
								</button>
							</div>
						{/if}
					{/if}
				{:else if myChoice.kind === 'chooseObjects'}
					{#if myChoice.zone === 'library'}
						{@const searchedOwner =
							gameState.players.find(
								(p) => p.playerId === (myPrompt.targetLibraryOwnerId || me.playerId)
							) || me}
						{@const eligibleLibCards =
							myChoice.candidates.length > 0
								? searchedOwner.library.filter((c) =>
										myChoice.candidates.includes(c.instanceId)
									)
								: searchedOwner.library}
						{@const filteredLibCards = eligibleLibCards.filter((c) =>
							matchesScryfallQuery(c.card, librarySearchQuery)
						)}
						<div class="modal-head-row">
							<span class="hand-count-label">
								ELIGIBLE IN {searchedOwner.playerId === me.playerId ? 'YOUR' : `${searchedOwner.username.toUpperCase()}'S`} LIBRARY ({filteredLibCards.length}/{eligibleLibCards.length})
							</span>
							<input
								type="search"
								class="modal-scryfall-input"
								bind:value={librarySearchQuery}
								placeholder="Scryfall search (e.g. t:land, t:basic, mv<=2, o:draw)..."
							/>
						</div>
						<div class="modal-card-grid">
							{#each filteredLibCards as c (c.instanceId)}
								<button
									type="button"
									class="modal-card-item selectable"
									class:selected={selectedPromptCardIds.includes(c.instanceId)}
									onmouseenter={() => hoverCard(c.card, c)}
									onmouseleave={() => leaveCard(c.card)}
									onclick={() => {
										if (myChoice.max === 1) {
											librarySearchQuery = '';
											onGameAction({
												type: 'choice',
												promptId: myPrompt.id,
												answer: { kind: 'chooseObjects', objectIds: [c.instanceId] }
											});
										} else {
											togglePromptCardSelection(c.instanceId, myChoice.max);
										}
									}}
								>
									<img src={c.card.imageUrl} alt={c.card.name} />
									<span>{c.card.name}</span>
								</button>
							{/each}
						</div>
						<div class="modal-actions">
							{#if myChoice.max > 1}
								{@const isLibReady =
									selectedPromptCardIds.length >= myChoice.min &&
									selectedPromptCardIds.length <= myChoice.max}
								<button
									type="button"
									class="arena-main-btn"
									class:can-act={isLibReady}
									disabled={!isLibReady}
									onclick={async () => {
										const ids = [...selectedPromptCardIds];
										selectedPromptCardIds = [];
										librarySearchQuery = '';
										await onGameAction({
											type: 'choice',
											promptId: myPrompt.id,
											answer: { kind: 'chooseObjects', objectIds: ids }
										});
									}}
								>
									Confirm Selection ({selectedPromptCardIds.length}/{myChoice.max})
								</button>
							{/if}
							{#if myChoice.min === 0}
								<button
									type="button"
									class="hud-btn"
									onclick={() => {
										librarySearchQuery = '';
										onGameAction({
											type: 'choice',
											promptId: myPrompt.id,
											answer: { kind: 'chooseObjects', objectIds: [] }
										});
									}}
								>
									Fail to Find (Shuffle Without Picking)
								</button>
							{/if}
						</div>
					{:else}
						{@const minReq = myChoice.min}
						{@const maxReq = myChoice.max}
						{@const isReadyToConfirm =
							selectedPromptCardIds.length >= minReq && selectedPromptCardIds.length <= maxReq}
						{@const candidateCards =
							myChoice.zone === 'hand'
								? sortedHand.filter(
										(c) =>
											myChoice.candidates.length === 0 ||
											myChoice.candidates.includes(c.instanceId)
									)
								: resolveCandidateObjects(myChoice.candidates)}
						{#if myChoice.zone === 'hand'}
							<div class="hand-toolbar modal-sort-bar">
								<span class="hand-count-label">
									SELECT {minReq === maxReq ? maxReq : `${minReq}-${maxReq}`} CARD(S) ({selectedPromptCardIds.length}/{maxReq})
								</span>
								<div class="hand-sort-group" role="group" aria-label="Auto-sort hand">
									<span class="sort-caption">Sort:</span>
									{#each ([
										['none', 'None'],
										['cmc', 'CMC'],
										['name', 'Name'],
										['color', 'Color'],
										['type', 'Type']
									] as const) as [mode, label]}
										<button
											type="button"
											class="sort-pill"
											class:active={handSortBy === mode}
											onclick={() => setHandSort(mode)}
										>
											{label}
										</button>
									{/each}
									<span class="sort-divider" aria-hidden="true">|</span>
									<button
										type="button"
										class="sort-pill dir-pill"
										class:active={handSortBy !== 'none' && handSortDir === 'asc'}
										title="Sort Ascending"
										onclick={() => setHandSortDir('asc')}
									>
										ASC
									</button>
									<button
										type="button"
										class="sort-pill dir-pill"
										class:active={handSortBy !== 'none' && handSortDir === 'desc'}
										title="Sort Descending"
										onclick={() => setHandSortDir('desc')}
									>
										DESC
									</button>
								</div>
							</div>
						{/if}
						<div class="modal-card-grid">
							{#each candidateCards as c (c.instanceId)}
								<button
									type="button"
									class="modal-card-item selectable"
									class:selected={selectedPromptCardIds.includes(c.instanceId)}
									onmouseenter={() => hoverCard(c.card)}
									onmouseleave={() => leaveCard(c.card)}
									onclick={() => togglePromptCardSelection(c.instanceId, maxReq)}
								>
									<img src={c.card.imageUrl} alt={c.card.name} />
									<span>{c.card.name}</span>
								</button>
							{/each}
							{#each nonCardCandidates(myChoice.candidates) as nc (nc.id)}
								<button
									type="button"
									class="modal-card-item selectable"
									class:selected={selectedPromptCardIds.includes(nc.id)}
									onclick={() => togglePromptCardSelection(nc.id, maxReq)}
								>
									<span>{nc.label}</span>
								</button>
							{/each}
						</div>
						<div class="modal-actions">
							<button
								type="button"
								class="arena-main-btn"
								class:can-act={isReadyToConfirm}
								disabled={!isReadyToConfirm}
								onclick={async () => {
									if (!isReadyToConfirm) return;
									const ids = [...selectedPromptCardIds];
									selectedPromptCardIds = [];
									await onGameAction({
										type: 'choice',
										promptId: myPrompt.id,
										answer: { kind: 'chooseObjects', objectIds: ids }
									});
								}}
							>
								Confirm Selection ({selectedPromptCardIds.length}/{maxReq})
							</button>
							{#if myPromptPurpose === 'cost_choice'}
								<button
									type="button"
									class="hud-btn"
									onclick={() =>
										onGameAction({
											type: 'choice',
											promptId: myPrompt.id,
											cancel: true
										})}
								>
									Cancel
								</button>
							{/if}
						</div>
					{/if}
				{:else if myChoice.kind === 'chooseMode'}
					{#if myChoice.min === 1 && myChoice.max === 1}
						<div class="modal-actions">
							{#each myChoice.modes as label, i (i)}
								<button
									type="button"
									class={i === 0 ? 'arena-main-btn can-act' : 'hud-btn'}
									onclick={() =>
										onGameAction({
											type: 'choice',
											promptId: myPrompt.id,
											answer: { kind: 'chooseMode', indices: [i] }
										})}
								>
									{label}
								</button>
							{/each}
						</div>
					{:else}
						{@const isModeReady =
							selectedPromptModes.length >= myChoice.min &&
							selectedPromptModes.length <= myChoice.max}
						<div class="modal-actions">
							{#each myChoice.modes as label, i (i)}
								<button
									type="button"
									class={selectedPromptModes.includes(i) ? 'arena-main-btn can-act' : 'hud-btn'}
									onclick={() => togglePromptModeSelection(i, myChoice.max)}
								>
									{label}
								</button>
							{/each}
						</div>
						<div class="modal-actions">
							<button
								type="button"
								class="arena-main-btn"
								class:can-act={isModeReady}
								disabled={!isModeReady}
								onclick={async () => {
									const indices = [...selectedPromptModes];
									selectedPromptModes = [];
									await onGameAction({
										type: 'choice',
										promptId: myPrompt.id,
										answer: { kind: 'chooseMode', indices }
									});
								}}
							>
								Confirm Modes ({selectedPromptModes.length}/{myChoice.max})
							</button>
						</div>
					{/if}
					{#if myPromptPurpose === 'cost_choice'}
						<div class="modal-actions">
							<button
								type="button"
								class="hud-btn"
								onclick={() =>
									onGameAction({
										type: 'choice',
										promptId: myPrompt.id,
										cancel: true
									})}
							>
								Cancel
							</button>
						</div>
					{/if}
				{:else if myChoice.kind === 'chooseNumber'}
					<div class="guided-box">
						<label>
							Choose Number ({myChoice.min}–{myChoice.max}):
							<input
								type="number"
								min={myChoice.min}
								max={myChoice.max}
								bind:value={selectedPromptNumber}
							/>
						</label>
					</div>
					<div class="modal-actions">
						<button
							type="button"
							class="arena-main-btn can-act"
							onclick={() =>
								onGameAction({
									type: 'choice',
									promptId: myPrompt.id,
									answer: {
										kind: 'chooseNumber',
										n: Math.min(
											myChoice.max,
											Math.max(myChoice.min, Math.trunc(selectedPromptNumber))
										)
									}
								})}
						>
							Confirm ({selectedPromptNumber})
						</button>
					</div>
				{:else if myChoice.kind === 'orderObjects' && myPromptPurpose === 'trigger_order'}
					{@const stackById = new Map(gameState.stack.map((s) => [s.id, s]))}
					<div class="scry-section">
						<div class="scry-section-head">
							<strong>TRIGGERED ABILITIES ({scryTopOrder.length})</strong>
							<span class="scry-hint">#1 resolves first — use ◀ / ▶ to rearrange order</span>
						</div>
						<div class="modal-card-grid">
							{#each scryTopOrder as id, idx (id)}
								{@const item = stackById.get(id)}
								<div class="modal-card-item scry-card-item" role="group" aria-label="Trigger #{idx + 1}">
									<div class="scry-rank-pill top-rank">#{idx + 1}{idx === 0 ? ' (Resolves First)' : ''}</div>
									{#if item?.card.imageUrl}
										<img src={item.card.imageUrl} alt={item.card.name} />
									{/if}
									<span class="scry-card-name">{item?.title ?? id}</span>
									<div class="scry-controls-row">
										<button
											type="button"
											class="gy-move-btn"
											disabled={idx === 0}
											onclick={() => shiftScryCardOrder(id, -1)}
										>
											◀ Earlier
										</button>
										<button
											type="button"
											class="gy-move-btn"
											disabled={idx === scryTopOrder.length - 1}
											onclick={() => shiftScryCardOrder(id, 1)}
										>
											Later ▶
										</button>
									</div>
								</div>
							{/each}
						</div>
					</div>
					<div class="modal-actions">
						<button
							type="button"
							class="arena-main-btn can-act"
							onclick={async () => {
								const topIds = [...scryTopOrder];
								scryTopOrder = [];
								await onGameAction({
									type: 'choice',
									promptId: myPrompt.id,
									answer: { kind: 'orderObjects', topIds, bottomIds: [], shuffle: false }
								});
							}}
						>
							Confirm Order
						</button>
					</div>
				{:else if myChoice.kind === 'orderObjects'}
					{@const canBottom = myChoice.allowSplitBottom !== false}
					{@const canShuffle = Boolean(myChoice.allowShuffle)}
					{@const libMap = new Map((me?.library || []).map((c) => [c.instanceId, c]))}
					{@const topCards = scryTopOrder.map((id) => libMap.get(id)).filter((c): c is CardInstance => Boolean(c))}
					{@const bottomCards = scryBottomOrder.map((id) => libMap.get(id)).filter((c): c is CardInstance => Boolean(c))}

					<div class="scry-section">
						<div class="scry-section-head">
							<strong>TOP OF LIBRARY ({topCards.length})</strong>
							<span class="scry-hint">#1 is the very top card (drawn next) — use ◀ / ▶ to rearrange order</span>
						</div>
						{#if topCards.length === 0}
							<div class="scry-empty">No cards remaining on top (all sent to bottom).</div>
						{:else}
							<div class="modal-card-grid">
								{#each topCards as c, idx (c.instanceId)}
									<div
										class="modal-card-item scry-card-item"
										role="group"
										aria-label="Top card #{idx + 1}: {c.card.name}"
										onmouseenter={() => hoverCard(c.card, c)}
										onmouseleave={() => leaveCard(c.card)}
									>
										<div class="scry-rank-pill top-rank">
											TOP #{idx + 1}{idx === 0 ? ' (Next Draw)' : ''}
										</div>
										<img src={c.card.imageUrl} alt={c.card.name} />
										<span class="scry-card-name">{c.card.name}</span>
										<div class="scry-controls-row">
											<button
												type="button"
												class="gy-move-btn"
												disabled={idx === 0}
												title="Move earlier (closer to #1 Top)"
												onclick={() => shiftScryCardOrder(c.instanceId, -1)}
											>
												◀ Earlier
											</button>
											<button
												type="button"
												class="gy-move-btn"
												disabled={idx === topCards.length - 1}
												title="Move later (deeper from #1 Top)"
												onclick={() => shiftScryCardOrder(c.instanceId, 1)}
											>
												Later ▶
											</button>
										</div>
										{#if canBottom}
											<button
												type="button"
												class="scry-zone-toggle to-bottom"
												onclick={() => moveScryCardZone(c.instanceId, true)}
											>
												⬇ Put on Bottom
											</button>
										{/if}
									</div>
								{/each}
							</div>
						{/if}
					</div>

					{#if canBottom && bottomCards.length > 0}
						<div class="scry-section bottom-sec">
							<div class="scry-section-head">
								<strong>BOTTOM OF LIBRARY ({bottomCards.length})</strong>
								<span class="scry-hint">Put on the bottom of your library in this order</span>
							</div>
							<div class="modal-card-grid">
								{#each bottomCards as c, idx (c.instanceId)}
									<div
										class="modal-card-item scry-card-item selected"
										role="group"
										aria-label="Bottom card #{idx + 1}: {c.card.name}"
										onmouseenter={() => hoverCard(c.card, c)}
										onmouseleave={() => leaveCard(c.card)}
									>
										<div class="scry-rank-pill bot-rank">BOTTOM #{idx + 1}</div>
										<img src={c.card.imageUrl} alt={c.card.name} />
										<span class="scry-card-name">{c.card.name}</span>
										<div class="scry-controls-row">
											<button
												type="button"
												class="gy-move-btn"
												disabled={idx === 0}
												onclick={() => shiftScryCardOrder(c.instanceId, -1)}
											>
												◀
											</button>
											<button
												type="button"
												class="gy-move-btn"
												disabled={idx === bottomCards.length - 1}
												onclick={() => shiftScryCardOrder(c.instanceId, 1)}
											>
												▶
											</button>
										</div>
										<button
											type="button"
											class="scry-zone-toggle to-top"
											onclick={() => moveScryCardZone(c.instanceId, false)}
										>
											⬆ Return to Top
										</button>
									</div>
								{/each}
							</div>
						</div>
					{/if}

					<div class="modal-actions">
						{#if canShuffle}
							<button
								type="button"
								class="hud-btn active-ctrl"
								onclick={async () => {
									const topIds = [...scryTopOrder];
									const bottomIds = [...scryBottomOrder];
									scryTopOrder = [];
									scryBottomOrder = [];
									await onGameAction({
										type: 'choice',
										promptId: myPrompt.id,
										answer: {
											kind: 'orderObjects',
											topIds,
											bottomIds,
											shuffle: true
										}
									});
								}}
							>
								🔀 Put Back &amp; Shuffle Library
							</button>
						{/if}
						<button
							type="button"
							class="arena-main-btn can-act"
							onclick={async () => {
								const topIds = [...scryTopOrder];
								const bottomIds = [...scryBottomOrder];
								scryTopOrder = [];
								scryBottomOrder = [];
								await onGameAction({
									type: 'choice',
									promptId: myPrompt.id,
									answer: {
										kind: 'orderObjects',
										topIds,
										bottomIds,
										shuffle: false
									}
								});
							}}
						>
							{#if canBottom}
								Confirm Scry ({topCards.length} Top / {bottomCards.length} Bottom)
							{:else}
								Keep This Top Order
							{/if}
						</button>
					</div>
				{:else if myChoice.kind === 'chooseReplacement'}
					<div class="modal-actions">
						{#each myChoice.options as opt, i (opt.id)}
							<button
								type="button"
								class={i === 0 ? 'arena-main-btn can-act' : 'hud-btn'}
								onclick={() =>
									onGameAction({
										type: 'choice',
										promptId: myPrompt.id,
										answer: { kind: 'chooseReplacement', id: opt.id }
									})}
							>
								{opt.label}
							</button>
						{/each}
					</div>
				{:else}
					{@const _exhaustiveChoice: never = myChoice}
					<p class="modal-desc">{String(_exhaustiveChoice)}</p>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Victory Banner -->
	{#if gameState.status === 'finished'}
		{@const winner = gameState.players.find((p) => p.playerId === gameState.winnerPlayerId)}
		<div class="modal-backdrop">
			<div class="arena-modal">
				<h2>{winner ? `${winner.username} Wins the Pod` : 'Match Finished'}</h2>
				<p class="modal-desc">All Commander rules and state-based actions have concluded.</p>
				<button type="button" class="arena-main-btn can-act" onclick={onLeaveMatch}>
					Return to Pod Lobby
				</button>
			</div>
		</div>
	{/if}
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
	.arena-root.is-dragging {
		cursor: grabbing;
	}

	.arena-root.shake {
		animation: arena-shake 0.4s cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
	}

	@keyframes arena-shake {
		10%, 90% { transform: translate3d(-3px, 1px, 0); }
		20%, 80% { transform: translate3d(5px, -2px, 0); }
		30%, 50%, 70% { transform: translate3d(-6px, 3px, 0); }
		40%, 60% { transform: translate3d(6px, -2px, 0); }
	}

	.vfx-canvas,
	.vfx-svg {
		position: fixed;
		inset: 0;
		width: 100vw;
		height: 100vh;
		pointer-events: none;
		overflow: visible;
		z-index: 260;
	}

	.bezier-arrow {
		fill: none;
		stroke-width: 3.5;
		stroke-dasharray: 8 5;
		animation: dash-flow 0.6s linear infinite;
	}
	.bezier-arrow.attack {
		stroke: var(--mp-red);
	}
	.bezier-arrow.block {
		stroke: var(--mp-cyan);
	}
	.bezier-arrow.target,
	.bezier-arrow.active_cursor {
		stroke: var(--mp-yellow);
	}

	@keyframes dash-flow {
		to { stroke-dashoffset: -26; }
	}

	/* Floating Hold-ALT Preview Over Mouse */
	.alt-hover-preview {
		position: fixed;
		width: 246px;
		max-height: calc(100vh - 24px);
		background: var(--mp-bg-elevated);
		border: 2px solid var(--mp-accent);
		border-radius: 10px;
		box-shadow: 0 18px 42px rgba(0, 0, 0, 0.65);
		overflow: hidden;
		pointer-events: none;
		z-index: 300;
		display: flex;
		flex-direction: column;
	}
	.alt-hover-preview.side-details {
		width: 500px;
		flex-direction: row;
		align-items: stretch;
	}
	.alt-hover-preview.side-details.place-left {
		flex-direction: row-reverse;
	}
	.alt-hover-preview img {
		width: 246px;
		height: auto;
		display: block;
		flex-shrink: 0;
		align-self: flex-start;
	}
	.alt-preview-meta {
		padding: 0.5rem 0.65rem;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.72rem;
		background: var(--mp-bg-elevated);
		border-top: 1px solid var(--mp-border);
		overflow-y: auto;
	}
	.alt-hover-preview.side-details .alt-preview-meta {
		border-top: none;
		border-left: 1px solid var(--mp-border);
		width: 254px;
		justify-content: flex-start;
	}
	.alt-hover-preview.side-details.place-left .alt-preview-meta {
		border-left: none;
		border-right: 1px solid var(--mp-border);
	}
	.alt-preview-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.4rem;
		color: var(--mp-text);
	}
	.alt-preview-type {
		font-size: 0.66rem;
		color: var(--mp-cyan);
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.type-mod-note {
		font-size: 0.6rem;
		color: var(--mp-orange);
	}
	.alt-preview-pt {
		font-size: 0.66rem;
		color: var(--mp-green);
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		align-items: baseline;
	}
	.pt-mod-note {
		font-size: 0.6rem;
		color: var(--mp-text-muted);
	}
	.alt-kw-section {
		background: var(--mp-bg);
		border: 1px solid var(--mp-border-strong);
		border-radius: 6px;
		padding: 0.32rem 0.45rem;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.alt-kw-section.compact {
		padding: 0.24rem 0.38rem;
	}
	.alt-kw-title {
		font-size: 0.58rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: var(--mp-accent);
	}
	.alt-kw-list {
		display: flex;
		flex-direction: column;
		gap: 0.16rem;
	}
	.alt-kw-row {
		font-size: 0.64rem;
		line-height: 1.28;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.24rem;
		color: var(--mp-text);
	}
	.alt-kw-row .kw-name {
		font-weight: 600;
		color: var(--mp-text);
	}
	.alt-kw-row .kw-name.crossed-out {
		text-decoration: line-through;
		text-decoration-thickness: 1.5px;
		text-decoration-color: var(--mp-red);
		color: var(--mp-text-muted);
		opacity: 0.78;
	}
	.alt-kw-row .kw-source.innate {
		color: var(--mp-text-muted);
		opacity: 0.68;
		font-size: 0.6rem;
	}
	.alt-kw-row .kw-source.granted {
		color: var(--mp-cyan);
		font-weight: 600;
		font-size: 0.6rem;
	}
	.alt-kw-row .kw-removed-by {
		color: var(--mp-red);
		font-weight: 600;
		font-size: 0.6rem;
	}
	.alt-preview-oracle {
		font-size: 0.68rem;
		color: var(--mp-text-body);
		line-height: 1.35;
	}

	/* Drag Splitters */
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
	.resizer-v:hover {
		background: var(--mp-accent);
	}
	.grip-dots-v {
		width: 2px;
		height: 28px;
		background: var(--mp-border-strong);
		border-radius: 2px;
	}

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
	.resizer-h.subtle {
		height: 5px;
		background: transparent;
		border-top: 1px dashed var(--mp-border);
	}
	.resizer-h:hover {
		background: var(--mp-accent);
	}
	.grip-dots {
		width: 28px;
		height: 2px;
		background: var(--mp-border-strong);
		border-radius: 2px;
	}

	/* Top HUD */
	.arena-hud {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		padding: 0.4rem 0.8rem;
		background: var(--mp-bg-elevated);
		border-bottom: 1px solid var(--mp-border);
		z-index: 160;
	}
	.hud-left,
	.hud-right {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		flex-wrap: wrap;
	}
	.alt-hint {
		font-size: 0.68rem;
		color: var(--mp-text-muted);
	}
	.turn-pill,
	.active-pill,
	.priority-pill,
	.rope-pill {
		font-size: 0.72rem;
		padding: 0.2rem 0.5rem;
		border-radius: 4px;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border);
	}
	.priority-pill.mine {
		border-color: var(--mp-accent);
		color: var(--mp-accent);
	}
	.rope-pill.urgent {
		border-color: var(--mp-red);
		color: var(--mp-red);
	}

	.phase-ladder {
		display: flex;
		align-items: center;
		gap: 0.22rem;
		flex-wrap: wrap;
	}
	.phase-step {
		background: var(--mp-bg);
		color: var(--mp-text-muted);
		border: 1px solid var(--mp-border);
		border-radius: 4px;
		padding: 0.18rem 0.44rem;
		font-size: 0.68rem;
		font-family: inherit;
		cursor: pointer;
	}
	.phase-step.current {
		background: var(--mp-btn-bg);
		color: var(--mp-btn-fg);
		font-weight: 700;
		border-color: var(--mp-btn-bg);
	}
	.phase-step.stopped {
		border-bottom: 2px solid var(--mp-red);
	}

	.hud-btn,
	.theme-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.32rem;
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 4px;
		padding: 0.24rem 0.55rem;
		font-size: 0.72rem;
		font-family: inherit;
		cursor: pointer;
	}
	.hud-btn:hover,
	.theme-btn:hover {
		border-color: var(--mp-accent);
		color: var(--mp-accent);
	}
	.hud-btn.active-ctrl {
		border-color: var(--mp-accent);
		color: var(--mp-accent);
	}
	.hud-btn.danger:hover {
		border-color: var(--mp-red);
		color: var(--mp-red);
	}

	.target-banner {
		background: var(--mp-bg-subtle);
		border-bottom: 1px solid var(--mp-accent);
		color: var(--mp-accent);
		padding: 0.38rem 1rem;
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 1rem;
		font-size: 0.8rem;
		z-index: 160;
	}

	/* Main Table Layout */
	.arena-main {
		flex: 1;
		display: grid;
		min-height: 0;
	}

	.table-area {
		display: flex;
		flex-direction: column;
		padding: 0.45rem 0.65rem;
		gap: 0.35rem;
		min-height: 0;
		overflow: hidden;
	}

	/* Opponent Row */
	.opponents-row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 0.5rem;
		min-height: 120px;
		flex-shrink: 0;
	}

	.opp-board {
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border);
		border-radius: 8px;
		padding: 0.4rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		overflow: hidden;
	}
	.opp-board.active-turn {
		border-color: var(--mp-cyan);
	}
	.opp-board.has-prio {
		border-color: var(--mp-accent);
	}
	.opp-board.eliminated {
		opacity: 0.42;
	}

	.opp-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.35rem;
		flex-wrap: wrap;
	}
	.player-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border-strong);
		color: var(--mp-text);
		padding: 0.2rem 0.5rem;
		border-radius: 6px;
		font-family: inherit;
		font-size: 0.74rem;
		cursor: pointer;
	}
	.player-badge:hover {
		border-color: var(--mp-red);
	}
	.bot-tag {
		font-size: 0.6rem;
		background: var(--mp-purple);
		color: #fcfcfa;
		padding: 0.06rem 0.28rem;
		border-radius: 3px;
	}
	.bot-thinking-pill {
		display: inline-flex;
		align-items: center;
		font-size: 0.68rem;
		font-style: italic;
		color: var(--mp-muted);
		background: var(--mp-bg-soft);
		border: 1px dashed var(--mp-border);
		padding: 0.14rem 0.42rem;
		border-radius: 999px;
		white-space: nowrap;
	}
	.life-orb {
		font-weight: 700;
		color: var(--mp-green);
	}
	.life-orb.low {
		color: var(--mp-red);
	}
	.poison-orb {
		color: var(--mp-purple);
		font-size: 0.7rem;
	}

	.opp-zones {
		display: flex;
		align-items: center;
		gap: 0.28rem;
		flex-wrap: wrap;
	}
	.my-zones {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.2rem;
	}
	.my-zones .z-chip {
		text-align: center;
		padding: 0.1rem 0.24rem;
		font-size: 0.62rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.z-chip {
		font-size: 0.66rem;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border);
		color: var(--mp-text-muted);
		padding: 0.12rem 0.36rem;
		border-radius: 4px;
		font-family: inherit;
	}
	.z-chip.clickable {
		cursor: pointer;
	}
	.z-chip.clickable:hover {
		border-color: var(--mp-cyan);
		color: var(--mp-cyan);
	}

	.cmd-dmg-bar {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
	}
	.cmd-dmg-pill {
		font-size: 0.62rem;
		background: var(--mp-bg);
		border: 1px solid var(--mp-red);
		color: var(--mp-red);
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
	}

	.opp-field {
		flex: 1;
		display: flex;
		flex-wrap: wrap;
		align-content: flex-start;
		gap: 0.32rem;
		overflow-y: auto;
	}
	.mini-card {
		position: relative;
		width: 66px;
		height: 50px;
		border-radius: 5px;
		border: 1px solid var(--mp-border-strong);
		background: var(--mp-bg);
		padding: 0;
		overflow: hidden;
		cursor: pointer;
		transition: transform 0.14s ease;
	}
	.mini-card img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.mini-card.tapped {
		transform: rotate(14deg);
		opacity: 0.78;
	}
	.mini-card.attacking {
		border-color: var(--mp-red);
		box-shadow: 0 0 8px var(--mp-red);
	}
	.mini-card.cmd-zone-card {
		border-color: var(--mp-yellow);
	}

	/* Transparent-ish Black Sleeve over Cards That Cannot Be Acted On */
	.hand-card.unactable::after,
	.board-card.unactable::after,
	.mini-card.unactable::after {
		content: '';
		position: absolute;
		inset: 0;
		background: linear-gradient(
			180deg,
			rgba(6, 5, 10, 0.52) 0%,
			rgba(8, 7, 14, 0.58) 100%
		);
		box-shadow: inset 0 0 12px rgba(0, 0, 0, 0.55);
		border-radius: inherit;
		pointer-events: none;
		z-index: 4;
		transition: opacity 0.14s ease;
	}
	.hand-card.unactable:hover::after,
	.board-card.unactable:hover::after,
	.mini-card.unactable:hover::after {
		opacity: 0.2;
	}
	.mc-name {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		background: rgba(15, 13, 18, 0.85);
		color: #fcfcfa;
		font-size: 0.54rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		padding: 1px 3px;
	}
	.mc-tag {
		position: absolute;
		top: 1px;
		left: 1px;
		background: #ffd866;
		color: #19181a;
		font-size: 0.5rem;
		font-weight: 700;
		padding: 0 3px;
		border-radius: 2px;
	}
	.pt-badge {
		position: absolute;
		top: 2px;
		right: 2px;
		background: #19181a;
		border: 1px solid #78dce8;
		color: #fcfcfa;
		font-size: 0.58rem;
		font-weight: 700;
		padding: 0 3px;
		border-radius: 3px;
	}
	.counter-badge {
		position: absolute;
		top: 2px;
		left: 2px;
		background: #a9dc76;
		color: #19181a;
		font-size: 0.56rem;
		font-weight: 700;
		padding: 0 3px;
		border-radius: 3px;
	}

	/* Local Player Board */
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
	.my-board.has-prio {
		border-color: var(--mp-accent);
	}

	.my-battlefield-split {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
		overflow: hidden;
	}

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
	.row-atk-all-btn:hover:not(:disabled) {
		background: var(--mp-red);
		color: #19181a;
	}
	.row-atk-all-btn:disabled {
		background: var(--mp-bg-subtle);
		color: var(--mp-text-muted);
		border-color: var(--mp-border);
		opacity: 0.42;
		cursor: not-allowed;
	}

	.board-card {
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
	.board-card.compact {
		width: 84px;
		height: 64px;
	}
	.board-card:hover {
		transform: translateY(-3px) scale(1.03);
		border-color: var(--mp-cyan);
		z-index: 10;
	}
	.board-card.tapped {
		transform: rotate(14deg) scale(0.94);
		opacity: 0.8;
	}
	.board-card.playable {
		border-color: var(--mp-cyan);
		box-shadow: 0 0 10px rgba(120, 220, 232, 0.45);
	}
	.board-card.draft-atk {
		border-color: var(--mp-red);
		box-shadow: 0 0 12px var(--mp-red);
	}
	.board-card.draft-blk {
		border-color: var(--mp-cyan);
		box-shadow: 0 0 12px var(--mp-cyan);
	}
	.board-card img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.bc-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		padding: 3px 4px;
		background: linear-gradient(180deg, rgba(0, 0, 0, 0.6) 0%, transparent 45%, rgba(0, 0, 0, 0.82) 100%);
	}
	.bc-name {
		font-size: 0.62rem;
		font-weight: 600;
		color: #fcfcfa;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.tapped-icon {
		align-self: flex-end;
	}
	.bc-badges {
		display: flex;
		align-items: center;
		gap: 2px;
		flex-wrap: wrap;
	}
	.badge {
		font-size: 0.54rem;
		font-weight: 700;
		padding: 1px 4px;
		border-radius: 3px;
	}
	.badge.gold { background: #ffd866; color: #19181a; }
	.badge.cyan { background: #78dce8; color: #19181a; }
	.badge.green { background: #a9dc76; color: #19181a; }
	.badge.purple { background: #ab9df2; color: #19181a; }

	.bc-pt {
		align-self: flex-end;
		background: #141218;
		border: 1px solid #ffd866;
		color: #fcfcfa;
		font-size: 0.66rem;
		font-weight: 700;
		padding: 0 4px;
		border-radius: 3px;
	}
	.bc-pt.damaged {
		border-color: #ff6188;
		color: #ff6188;
	}

	.my-row.back-row {
		flex-wrap: nowrap;
		align-items: stretch;
		gap: 0.35rem;
	}
	.command-pedestal {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		padding-right: 0.25rem;
		flex-shrink: 0;
		overflow-x: auto;
	}
	.pedestal-label {
		font-size: 0.58rem;
		color: var(--mp-accent);
		letter-spacing: 0.06em;
		font-weight: 700;
	}
	.pedestal-cards {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}
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

	.front-row.drop-zone-valid,
	.lands-area.drop-zone-valid,
	.stack-panel.drop-zone-valid {
		outline: 1.5px dashed rgba(255, 216, 102, 0.72);
		outline-offset: -2px;
		background: rgba(255, 216, 102, 0.06);
		box-shadow: inset 0 0 18px rgba(255, 216, 102, 0.14);
	}
	.front-row.drop-zone-active,
	.lands-area.drop-zone-active,
	.stack-panel.drop-zone-active {
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

	.hand-card.playable,
	.cmd-card.playable {
		cursor: grab;
	}
	.hand-card.dragging-source,
	.cmd-card.dragging-source {
		opacity: 0.45;
		cursor: grabbing;
	}

	.board-card.selected-target,
	.mini-card.selected-target,
	.player-badge.targetable-player,
	.my-avatar-btn.targetable-player,
	.stack-card.targetable-stack {
		border-color: #ffd866;
		box-shadow: 0 0 12px rgba(255, 216, 102, 0.55);
	}

	.target-banner-actions {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
	}
	.cancel-hint {
		margin-left: 0.4rem;
		font-size: 0.7rem;
		color: var(--mp-text-muted);
	}

	.resizer-v.subtle {
		width: 6px;
		align-self: stretch;
		border-radius: 3px;
		flex-shrink: 0;
	}

	/* Bottom Console & Curved Hand with Adjustable Side Sections */
	.my-console {
		display: grid;
		grid-template-columns: var(--vitals-w, 160px) 6px minmax(0, 1fr) 6px var(--controls-w, 185px);
		align-items: stretch;
		gap: 0.35rem;
		padding-top: 0.2rem;
		flex-shrink: 0;
		min-height: 122px;
	}

	.my-vitals {
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		gap: 0.25rem;
		min-width: 0;
		overflow-y: auto;
		overflow-x: hidden;
	}
	.my-avatar-btn {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.12rem;
		width: 100%;
		background: var(--mp-bg);
		border: 1.5px solid var(--mp-border-strong);
		border-radius: 7px;
		padding: 0.28rem 0.48rem;
		color: var(--mp-text);
		font-family: inherit;
		text-align: left;
		cursor: pointer;
	}
	.my-vitals-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.3rem;
		width: 100%;
	}
	.my-life {
		font-size: 0.94rem;
		font-weight: 700;
		line-height: 1.1;
		color: var(--mp-green);
	}
	.my-life.low {
		color: var(--mp-red);
	}
	.my-uname {
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--mp-text-muted);
		width: 100%;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.mana-pool {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.18rem;
	}
	.mana-orb {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.18rem;
		font-size: 0.62rem;
		padding: 0.08rem 0.2rem;
		border-radius: 4px;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border);
		color: var(--mp-text-muted);
	}
	.mana-orb.filled {
		border-color: var(--mp-accent);
		color: var(--mp-text);
		font-weight: 700;
	}

	/* Center Hand Tray + Auto-Sort Toolbar + Curved Hand Fan */
	.hand-tray {
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		min-width: 0;
		overflow: hidden;
	}
	.hand-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.4rem;
		padding: 0 0.25rem;
		flex-shrink: 0;
	}
	.modal-sort-bar {
		margin-bottom: 0.35rem;
	}
	.hand-count-label {
		font-size: 0.62rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		color: var(--mp-text-muted);
	}
	.hand-sort-group {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		flex-wrap: wrap;
	}
	.sort-caption {
		font-size: 0.62rem;
		color: var(--mp-text-faint);
		margin-right: 0.1rem;
	}
	.sort-pill {
		background: var(--mp-bg);
		color: var(--mp-text-muted);
		border: 1px solid var(--mp-border);
		border-radius: 4px;
		padding: 0.08rem 0.36rem;
		font-family: inherit;
		font-size: 0.62rem;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.12s ease;
	}
	.sort-pill:hover {
		border-color: var(--mp-accent);
		color: var(--mp-text);
	}
	.sort-pill.active {
		background: var(--mp-accent);
		color: var(--mp-btn-fg);
		border-color: var(--mp-accent);
	}
	.sort-divider {
		font-size: 0.6rem;
		color: var(--mp-border-strong);
		margin: 0 0.1rem;
		user-select: none;
	}
	.sort-pill.dir-pill {
		font-size: 0.58rem;
		letter-spacing: 0.03em;
	}

	.hand-fan {
		flex: 1;
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 0;
		padding: 4px 8px;
		overflow-x: auto;
		overflow-y: hidden;
	}
	.hand-card {
		position: relative;
		width: var(--hc-w, 78px);
		height: var(--hc-h, 108px);
		max-height: calc(100% - 8px);
		margin: 0 -8px;
		border-radius: 7px;
		border: 1.5px solid var(--mp-border-strong);
		background: var(--mp-bg);
		padding: 0;
		overflow: hidden;
		cursor: pointer;
		transform: translateY(var(--fan-y, 0px)) rotate(var(--fan-rot, 0deg));
		transition: transform 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, margin 0.16s ease;
		flex-shrink: 0;
	}
	.hand-card:hover {
		transform: translateY(-6px) scale(1.06) rotate(0deg);
		margin: 0 5px;
		z-index: 30;
		border-color: var(--mp-accent);
	}
	.hand-card.playable {
		border-color: var(--mp-cyan);
		box-shadow: 0 0 12px rgba(120, 220, 232, 0.5);
	}
	.hand-card img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.hc-cost {
		position: absolute;
		top: 3px;
		right: 3px;
		background: rgba(18, 16, 22, 0.88);
		color: #ffd866;
		font-size: 0.58rem;
		font-weight: 700;
		padding: 1px 4px;
		border-radius: 3px;
		display: inline-flex;
		align-items: center;
	}

	/* Arena Action Controls (Right Hand Side Section): Fixed-Slot Phase Info + Turn Buttons */
	.arena-controls {
		display: grid;
		grid-template-rows: 42px 34px 34px;
		gap: 4px;
		align-content: center;
		min-width: 0;
	}

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
	.turn-phase-box.my-turn {
		border-color: var(--mp-border-strong);
	}
	.turn-phase-box.has-prio {
		border-color: var(--mp-accent);
	}
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
	.tpb-turn {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}
	.turn-phase-box.my-turn .tpb-turn {
		color: var(--mp-text);
	}
	.tpb-prio {
		flex-shrink: 0;
		max-width: 58px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--mp-text-faint);
	}
	.tpb-prio.mine {
		color: var(--mp-accent);
	}
	.tpb-step-row {
		display: flex;
		align-items: baseline;
		gap: 0.22rem;
		font-size: 0.67rem;
		line-height: 1.15;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}
	.tpb-phase {
		font-weight: 700;
		color: var(--mp-cyan);
		flex-shrink: 0;
	}
	.tpb-sep {
		color: var(--mp-text-faint);
		font-size: 0.62rem;
		flex-shrink: 0;
	}
	.tpb-step {
		font-weight: 700;
		color: var(--mp-text);
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.tpb-pips {
		display: grid;
		grid-template-columns: repeat(5, 1fr);
		gap: 3px;
		height: 3px;
		flex-shrink: 0;
	}
	.tpb-pip {
		background: var(--mp-border);
		border-radius: 2px;
	}
	.tpb-pip.done {
		background: var(--mp-cyan);
		opacity: 0.5;
	}
	.tpb-pip.active {
		background: var(--mp-accent);
	}

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
	.turn-ctrl-label {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}
	.turn-ctrl-btn.primary-step-btn.can-act {
		background: var(--mp-btn-bg);
		color: var(--mp-btn-fg);
		border-color: var(--mp-btn-bg);
	}
	.turn-ctrl-btn.primary-step-btn.can-act:hover:not(:disabled) {
		background: var(--mp-btn-hover);
		color: var(--mp-btn-hover-fg);
		border-color: var(--mp-btn-hover);
	}
	.turn-ctrl-btn.primary-step-btn.stack-active {
		background: var(--mp-cyan);
		color: #19181a;
		border-color: var(--mp-cyan);
	}
	.turn-ctrl-btn.end-turn-btn.can-act {
		background: var(--mp-bg);
		color: var(--mp-orange);
		border-color: var(--mp-orange);
	}
	.turn-ctrl-btn.end-turn-btn.can-act:hover:not(:disabled) {
		background: var(--mp-orange);
		color: #19181a;
	}
	.turn-ctrl-btn:disabled {
		background: var(--mp-bg-subtle);
		color: var(--mp-text-faint, var(--mp-text-muted));
		border-color: var(--mp-border);
		opacity: 0.42;
		cursor: not-allowed;
		box-shadow: none;
	}

	.arena-main-btn {
		background: var(--mp-bg-subtle);
		color: var(--mp-text-muted);
		border: 2px solid var(--mp-border-strong);
		border-radius: 8px;
		padding: 0.7rem 0.8rem;
		font-family: inherit;
		font-size: 0.8rem;
		font-weight: 700;
		cursor: pointer;
		transition: all 0.16s ease;
	}
	.arena-main-btn.can-act {
		background: var(--mp-btn-bg);
		color: var(--mp-btn-fg);
		border-color: var(--mp-btn-bg);
	}
	.arena-main-btn.stack-active {
		background: var(--mp-cyan);
		color: #19181a;
		border-color: var(--mp-cyan);
	}
	.arena-main-btn:disabled {
		background: var(--mp-bg-subtle);
		color: var(--mp-text-faint, var(--mp-text-muted));
		border-color: var(--mp-border);
		opacity: 0.36;
		cursor: not-allowed;
		box-shadow: none;
	}

	/* Right Dock: Adjustable Card Zoom + Stack + Chat */
	.arena-dock {
		background: var(--mp-bg-elevated);
		display: flex;
		flex-direction: column;
		min-height: 0;
		z-index: 160;
	}

	.card-zoom-box {
		padding: 0.55rem;
		overflow-y: auto;
		flex-shrink: 0;
	}
	.zoom-inner {
		display: grid;
		grid-template-columns: 112px 1fr;
		gap: 0.55rem;
	}
	.zoom-img {
		width: 112px;
		border-radius: 6px;
		border: 1px solid var(--mp-border-strong);
	}
	.zoom-meta {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.72rem;
	}
	.zoom-title {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.3rem;
		color: var(--mp-text);
	}
	.zoom-type {
		color: var(--mp-cyan);
		font-size: 0.66rem;
	}
	.zoom-oracle {
		color: var(--mp-text-body);
		line-height: 1.38;
		font-size: 0.68rem;
	}
	.zoom-unsupported {
		border: 1px solid rgba(255, 216, 102, 0.55);
		background: rgba(255, 216, 102, 0.08);
		border-radius: 4px;
		padding: 0.25rem 0.35rem;
		font-size: 0.64rem;
		line-height: 1.3;
	}
	.zoom-unsupported-title {
		color: #ffd866;
		font-weight: 700;
		font-size: 0.6rem;
		letter-spacing: 0.02em;
		margin-bottom: 0.15rem;
	}
	.zoom-unsupported-row {
		color: var(--mp-text-body);
	}
	.zoom-unsupported-row + .zoom-unsupported-row {
		margin-top: 0.15rem;
	}
	.zoom-pt {
		align-self: flex-end;
		font-weight: 700;
		color: var(--mp-green);
	}
	.zoom-placeholder {
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--mp-text-muted);
		font-size: 0.72rem;
		text-align: center;
		padding: 0.5rem;
	}

	.stack-panel {
		padding: 0.45rem 0.6rem;
		overflow-y: auto;
		flex-shrink: 0;
	}
	.dock-head {
		display: flex;
		justify-content: space-between;
		font-size: 0.68rem;
		font-weight: 700;
		color: var(--mp-accent);
		margin-bottom: 0.3rem;
	}
	.lifo-hint {
		color: var(--mp-text-muted);
		font-weight: 400;
		font-size: 0.62rem;
	}
	.stack-empty {
		font-size: 0.7rem;
		color: var(--mp-text-muted);
		text-align: center;
		padding: 0.35rem 0;
	}
	.stack-list {
		display: flex;
		flex-direction: column;
		gap: 0.28rem;
	}
	.stack-card {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border-strong);
		border-radius: 5px;
		padding: 0.25rem 0.4rem;
		color: var(--mp-text);
		font-family: inherit;
		text-align: left;
		cursor: pointer;
	}
	.stack-card.top-of-stack {
		border-color: var(--mp-cyan);
	}
	.stack-card img {
		width: 34px;
		height: 28px;
		object-fit: cover;
		border-radius: 3px;
	}
	.stk-info {
		display: flex;
		flex-direction: column;
		font-size: 0.68rem;
		min-width: 0;
	}
	.stk-title {
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.stk-target {
		color: var(--mp-accent);
		font-size: 0.62rem;
	}

	/* Live Chat & Rules Log */
	.chat-panel {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	.dock-tabs {
		display: grid;
		grid-template-columns: 1fr 1fr;
		border-bottom: 1px solid var(--mp-border);
	}
	.dock-tabs button {
		background: var(--mp-bg);
		color: var(--mp-text-muted);
		border: none;
		padding: 0.4rem;
		font-family: inherit;
		font-size: 0.7rem;
		font-weight: 600;
		cursor: pointer;
	}
	.dock-tabs button.active {
		background: var(--mp-bg-elevated);
		color: var(--mp-cyan);
		border-bottom: 2px solid var(--mp-cyan);
	}

	.chat-feed {
		flex: 1;
		padding: 0.5rem;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.72rem;
	}
	.chat-msg .cm-user {
		font-weight: 700;
		color: var(--mp-cyan);
		margin-right: 0.25rem;
	}
	.chat-msg.kind-system {
		color: var(--mp-orange);
	}
	.chat-msg.kind-emote {
		color: var(--mp-purple);
		font-style: italic;
	}

	.log-entry {
		font-size: 0.68rem;
		line-height: 1.35;
		color: var(--mp-text-body);
		border-left: 2px solid var(--mp-border-strong);
		padding-left: 0.38rem;
	}
	.log-entry.kind-cast { border-color: var(--mp-cyan); }
	.log-entry.kind-combat { border-color: var(--mp-red); }
	.log-entry.kind-sba { border-color: var(--mp-orange); color: var(--mp-orange); }
	.le-turn {
		color: var(--mp-text-muted);
		margin-right: 0.25rem;
	}

	.emote-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem;
		padding: 0.28rem 0.45rem;
		border-top: 1px solid var(--mp-border);
	}
	.emote-btn {
		background: var(--mp-bg);
		color: var(--mp-text-muted);
		border: 1px solid var(--mp-border);
		border-radius: 3px;
		font-family: inherit;
		font-size: 0.62rem;
		padding: 0.12rem 0.34rem;
		cursor: pointer;
	}
	.emote-btn:hover {
		border-color: var(--mp-purple);
		color: var(--mp-purple);
	}

	.chat-form {
		display: flex;
		gap: 0.3rem;
		padding: 0.4rem;
		border-top: 1px solid var(--mp-border);
	}
	.chat-form input {
		flex: 1;
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 4px;
		padding: 0.3rem 0.5rem;
		font-family: inherit;
		font-size: 0.74rem;
	}
	.chat-form button {
		background: var(--mp-btn-bg);
		color: var(--mp-btn-fg);
		border: none;
		border-radius: 4px;
		padding: 0.3rem 0.65rem;
		font-family: inherit;
		font-size: 0.74rem;
		font-weight: 700;
		cursor: pointer;
	}

	/* Modals */
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(10, 8, 14, 0.78);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 200;
		padding: 1rem;
	}
	.arena-modal {
		background: var(--mp-bg-elevated);
		border: 1.5px solid var(--mp-accent);
		border-radius: 10px;
		padding: 1.15rem;
		max-width: 520px;
		width: 100%;
		max-height: 86vh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.65);
	}
	.arena-modal.wide {
		max-width: 820px;
	}
	.arena-modal h3,
	.arena-modal h2 {
		margin: 0;
		color: var(--mp-accent);
	}
	.modal-desc {
		margin: 0;
		font-size: 0.8rem;
		color: var(--mp-text-body);
		white-space: pre-line;
	}
	.modal-card-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(115px, 1fr));
		gap: 0.6rem;
		max-height: 48vh;
		overflow-y: auto;
	}
	.modal-card-item {
		background: var(--mp-bg);
		border: 1.5px solid var(--mp-border-strong);
		border-radius: 6px;
		padding: 0.3rem;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.68rem;
		color: var(--mp-text);
		font-family: inherit;
	}
	.modal-card-item.selectable {
		cursor: pointer;
	}
	.modal-card-item.selected {
		border-color: var(--mp-accent);
		box-shadow: 0 0 10px var(--mp-accent);
	}
	.modal-card-item img {
		width: 100%;
		border-radius: 4px;
	}
	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.ability-list {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.ability-choice-btn {
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 6px;
		padding: 0.55rem 0.75rem;
		font-family: inherit;
		font-size: 0.78rem;
		text-align: left;
		cursor: pointer;
	}
	.ability-choice-btn:hover:not(:disabled) {
		border-color: var(--mp-accent);
	}
	.ability-choice-btn:disabled {
		opacity: 0.42;
		cursor: not-allowed;
	}
	.modal-card-item:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}
	.guided-box {
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.guided-box label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.76rem;
	}
	.guided-builder {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.guided-box {
		align-items: flex-end;
	}
	.guided-box select {
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 4px;
		padding: 0.4rem;
		font-family: inherit;
		max-width: 16rem;
	}
	.guided-pt {
		display: flex;
		gap: 0.25rem;
	}
	.guided-pt input {
		width: 3.5rem;
	}
	.guided-op-list {
		margin: 0;
		padding-left: 1.25rem;
		font-size: 0.8rem;
	}
	.guided-op-remove {
		margin-left: 0.4rem;
		background: none;
		border: none;
		color: var(--mp-text);
		cursor: pointer;
	}
	.guided-hint {
		margin: 0;
		font-size: 0.76rem;
		opacity: 0.8;
	}
	.zoom-unsupported-kind {
		color: #ffd866;
		font-weight: 600;
		margin-right: 0.25rem;
	}
	.zoom-resolve-btn {
		display: block;
		margin-top: 0.15rem;
		font-size: 0.6rem;
		padding: 0.1rem 0.35rem;
		border-radius: 3px;
		border: 1px solid rgba(255, 216, 102, 0.55);
		background: transparent;
		color: #ffd866;
		cursor: pointer;
	}
	.guided-box input,
	.x-selector input {
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 4px;
		padding: 0.4rem;
		font-family: inherit;
	}
	.modal-head-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.65rem;
		flex-wrap: wrap;
	}
	.modal-scryfall-input {
		flex: 1 1 220px;
		max-width: 340px;
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 5px;
		padding: 0.32rem 0.55rem;
		font-family: inherit;
		font-size: 0.72rem;
	}
	.modal-scryfall-input:focus {
		outline: none;
		border-color: #ffd866;
	}
	.hand-card-wrap {
		position: relative;
		display: inline-flex;
		flex-direction: column;
		align-items: center;
	}
	.hc-suspend-btn {
		position: absolute;
		bottom: 4px;
		left: 3px;
		right: 3px;
		z-index: 6;
		background: rgba(171, 157, 242, 0.92);
		color: #19181a;
		border: 1px solid #ffd866;
		border-radius: 3px;
		padding: 1px 3px;
		font-family: inherit;
		font-size: 0.54rem;
		font-weight: 800;
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.hc-suspend-btn:hover {
		background: #ffd866;
	}
	.board-card.phased-out,
	.mini-card.phased-out {
		opacity: 0.42;
		filter: saturate(0.25) contrast(0.9);
		border-style: dashed;
	}
	.gy-order-bar {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		width: 100%;
		justify-content: center;
		margin-top: 2px;
	}
	.gy-rank {
		font-size: 0.6rem;
		color: var(--mp-muted);
		font-weight: 700;
	}
	.gy-move-btn {
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 3px;
		padding: 0 4px;
		font-size: 0.6rem;
		cursor: pointer;
	}
	.gy-move-btn:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}

	/* Attachment Link Arrow & Card Highlighting */
	.bezier-arrow.attachment {
		stroke: var(--mp-purple);
		stroke-width: 2.5;
		stroke-dasharray: 5 4;
	}

	.board-card.attachment-linked,
	.mini-card.attachment-linked {
		border-color: var(--mp-purple) !important;
		box-shadow: 0 0 14px rgba(171, 157, 242, 0.85) !important;
	}

	.attached-items-strip {
		position: absolute;
		top: 2px;
		left: 2px;
		right: 2px;
		z-index: 5;
		display: flex;
		flex-direction: column;
		gap: 1px;
		pointer-events: none;
	}
	.attached-items-strip.on-attachment {
		top: 2px;
	}
	.attached-pill {
		display: inline-block;
		max-width: 100%;
		background: rgba(25, 22, 34, 0.92);
		color: #ab9df2;
		border: 1px solid rgba(171, 157, 242, 0.75);
		border-radius: 3px;
		padding: 1px 4px;
		font-size: 0.54rem;
		font-weight: 700;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		text-align: left;
	}
	.attached-pill.host-ref {
		color: #78dce8;
		border-color: rgba(120, 220, 232, 0.8);
	}

	.attach-mini-tag {
		position: absolute;
		top: 2px;
		left: 2px;
		right: 2px;
		z-index: 5;
		background: rgba(25, 22, 34, 0.92);
		color: #78dce8;
		border: 1px solid rgba(120, 220, 232, 0.75);
		border-radius: 3px;
		padding: 0 3px;
		font-size: 0.5rem;
		font-weight: 700;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.attach-mini-tag.host {
		color: #ab9df2;
		border-color: rgba(171, 157, 242, 0.75);
		right: auto;
	}

	/* Attacking & Blocking Card Banners & Borders */
	.board-card.attacking,
	.mini-card.attacking {
		border-color: var(--mp-red) !important;
		box-shadow: 0 0 14px rgba(255, 97, 136, 0.82);
	}
	.board-card.blocking,
	.mini-card.blocking {
		border-color: var(--mp-cyan) !important;
		box-shadow: 0 0 12px rgba(120, 220, 232, 0.78);
	}

	.combat-card-banner {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		z-index: 6;
		display: flex;
		flex-direction: column;
		padding: 2px 4px;
		font-size: 0.55rem;
		font-weight: 800;
		line-height: 1.15;
		text-align: left;
		pointer-events: none;
	}
	.combat-card-banner.atk-banner {
		background: linear-gradient(90deg, rgba(255, 97, 136, 0.94), rgba(190, 45, 82, 0.92));
		color: #fff;
		border-bottom: 1px solid #ffd866;
	}
	.combat-card-banner.atk-banner.blocked {
		background: linear-gradient(90deg, rgba(252, 152, 103, 0.94), rgba(185, 92, 48, 0.92));
	}
	.combat-card-banner.blk-banner {
		background: linear-gradient(90deg, rgba(120, 220, 232, 0.94), rgba(45, 138, 156, 0.92));
		color: #19181a;
		border-bottom: 1px solid #fff;
	}
	.combat-sub {
		font-size: 0.5rem;
		font-weight: 700;
		opacity: 0.95;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.combat-mini-banner {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		z-index: 6;
		font-size: 0.5rem;
		font-weight: 800;
		padding: 1px 3px;
		text-align: center;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		pointer-events: none;
	}
	.combat-mini-banner.atk {
		background: rgba(255, 97, 136, 0.94);
		color: #fff;
	}
	.combat-mini-banner.atk.blocked {
		background: rgba(252, 152, 103, 0.94);
		color: #19181a;
	}
	.combat-mini-banner.blk {
		background: rgba(120, 220, 232, 0.94);
		color: #19181a;
	}

	/* Combat Forecast Layover Bar & Player/Planeswalker Damage Badges */
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
	.cfb-section {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.45rem;
	}
	.cfb-title {
		font-weight: 800;
		color: var(--mp-red);
		letter-spacing: 0.04em;
	}
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
	.cfb-pill.player-dmg {
		border-color: var(--mp-red);
		color: #ffd866;
	}
	.cfb-pill.player-dmg.safe {
		border-color: var(--mp-cyan);
		color: var(--mp-cyan);
	}
	.cfb-pill.player-dmg.lethal,
	.cfb-pill.walker-dmg.lethal {
		background: rgba(255, 97, 136, 0.24);
		border-color: #ff6188;
		color: #ff6188;
		box-shadow: 0 0 10px rgba(255, 97, 136, 0.45);
	}
	.cfb-pill.walker-dmg {
		border-color: var(--mp-purple);
		color: var(--mp-purple);
	}
	.cfb-pill.casualties {
		border-color: var(--mp-orange, #fc9867);
		color: #fc9867;
	}
	.cfb-sub {
		font-size: 0.64rem;
		opacity: 0.88;
	}
	.lethal-tag {
		color: #ff6188;
		margin-left: 0.2rem;
	}

	.incoming-dmg-layover {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		background: rgba(255, 97, 136, 0.22);
		border: 1px solid var(--mp-red);
		color: #ffd866;
		border-radius: 4px;
		padding: 0.08rem 0.36rem;
		font-size: 0.64rem;
		font-weight: 800;
	}
	.incoming-dmg-layover.my-incoming {
		width: 100%;
		justify-content: center;
		margin: 2px 0;
		padding: 0.14rem 0.35rem;
		font-size: 0.62rem;
	}
	.incoming-dmg-layover.all-blocked {
		background: rgba(120, 220, 232, 0.18);
		border-color: var(--mp-cyan);
		color: var(--mp-cyan);
	}
	.incoming-dmg-layover.lethal {
		background: rgba(255, 97, 136, 0.9);
		color: #fff;
		border-color: #ffd866;
		box-shadow: 0 0 10px rgba(255, 97, 136, 0.7);
	}

	.pw-dmg-layover {
		position: absolute;
		top: 2px;
		left: 2px;
		right: 2px;
		z-index: 7;
		background: rgba(255, 97, 136, 0.92);
		color: #fff;
		border: 1px solid #ffd866;
		border-radius: 3px;
		padding: 1px 4px;
		font-size: 0.54rem;
		font-weight: 800;
		text-align: center;
		pointer-events: none;
	}
	.pw-dmg-layover.lethal {
		background: #ff2e63;
		box-shadow: 0 0 8px #ff2e63;
	}

	/* Scry & Ponder Rearrange Modal Styling */
	.scry-section {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.45rem;
		background: rgba(18, 16, 22, 0.48);
		border: 1px solid var(--mp-border);
		border-radius: 7px;
	}
	.scry-section.bottom-sec {
		border-color: rgba(255, 97, 136, 0.5);
	}
	.scry-section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.4rem;
		font-size: 0.72rem;
	}
	.scry-hint {
		font-size: 0.65rem;
		color: var(--mp-text-muted);
	}
	.scry-empty {
		font-size: 0.72rem;
		color: var(--mp-text-muted);
		padding: 0.4rem 0.2rem;
	}
	.scry-card-item {
		gap: 0.28rem;
	}
	.scry-rank-pill {
		width: 100%;
		text-align: center;
		font-size: 0.6rem;
		font-weight: 800;
		padding: 2px 4px;
		border-radius: 3px;
	}
	.scry-rank-pill.top-rank {
		background: rgba(120, 220, 232, 0.18);
		color: var(--mp-cyan);
		border: 1px solid var(--mp-cyan);
	}
	.scry-rank-pill.bot-rank {
		background: rgba(255, 97, 136, 0.18);
		color: var(--mp-red);
		border: 1px solid var(--mp-red);
	}
	.scry-card-name {
		font-size: 0.65rem;
		font-weight: 600;
		text-align: center;
	}
	.scry-controls-row {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.25rem;
		width: 100%;
	}
	.scry-zone-toggle {
		width: 100%;
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border-strong);
		color: var(--mp-text);
		border-radius: 4px;
		padding: 0.18rem 0.3rem;
		font-family: inherit;
		font-size: 0.6rem;
		font-weight: 700;
		cursor: pointer;
	}
	.scry-zone-toggle.to-bottom:hover {
		border-color: var(--mp-red);
		color: var(--mp-red);
	}
	.scry-zone-toggle.to-top:hover {
		border-color: var(--mp-cyan);
		color: var(--mp-cyan);
	}
</style>
