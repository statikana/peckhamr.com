<script lang="ts">
	import ManaText from '../ManaText.svelte';
	import { effectivePromptChoice, effectivePromptPurpose } from '../runtime/choices.ts';
	import { matchesScryfallQuery } from '../search.ts';
	import type {
		CardInstance,
		GameActionPayload,
		GameState,
		ManaColor,
		PendingPrompt,
		PlayerGameState,
		ScryfallCard
	} from '../types.ts';
	import GuidedResolutionBuilder from './GuidedResolutionBuilder.svelte';
	import XValueChooser from './XValueChooser.svelte';
	import { clampXChooserValue } from './xChooserModel.ts';
	import {
		ZONE_SHORT_LABELS,
		buildOrderObjectsInitialLists,
		computeWeightProgress,
		isPromptCancellable,
		isSingleClickObjectChoice,
		moveOrderedObjectSplit,
		resolveCardInstanceDisplay,
		resolvePromptCandidates,
		shiftOrderedObjects,
		type ResolvedPromptCandidate
	} from './promptViewModel.ts';

	export type HandSortMode = 'none' | 'cmc' | 'name' | 'color' | 'type';

	let {
		prompt,
		gameState,
		viewer,
		handSortBy,
		handSortDir,
		sortedHand,
		onSetHandSort,
		onSetHandSortDir,
		onGameAction,
		onHoverCard,
		onLeaveCard
	}: {
		prompt: PendingPrompt;
		gameState: GameState;
		viewer: PlayerGameState;
		handSortBy?: HandSortMode;
		handSortDir?: 'asc' | 'desc';
		sortedHand?: CardInstance[];
		onSetHandSort?: (mode: HandSortMode) => void;
		onSetHandSortDir?: (dir: 'asc' | 'desc') => void;
		onGameAction: (action: GameActionPayload) => void | Promise<void>;
		onHoverCard?: (card: ScryfallCard, inst?: CardInstance) => void;
		onLeaveCard?: (card: ScryfallCard) => void;
	} = $props();

	let localSortBy = $state<HandSortMode>('none');
	let localSortDir = $state<'asc' | 'desc'>('asc');

	const activeSortBy = $derived(handSortBy ?? localSortBy);
	const activeSortDir = $derived(handSortDir ?? localSortDir);

	function updateSortMode(mode: HandSortMode) {
		if (onSetHandSort) onSetHandSort(mode);
		else localSortBy = mode;
	}

	function updateSortDir(dir: 'asc' | 'desc') {
		if (onSetHandSortDir) onSetHandSortDir(dir);
		else localSortDir = dir;
	}

	function colorRank(colors: ManaColor[]): number {
		if (colors.length === 0) return 6;
		if (colors.length > 1) return 5;
		const idx = ['W', 'U', 'B', 'R', 'G', 'C'].indexOf(colors[0]);
		return idx >= 0 ? idx : 7;
	}

	function typeRank(types: readonly string[]): number {
		if (types.includes('Creature')) return 0;
		if (types.includes('Planeswalker')) return 1;
		if (types.includes('Instant')) return 2;
		if (types.includes('Sorcery')) return 3;
		if (types.includes('Artifact')) return 4;
		if (types.includes('Enchantment')) return 5;
		if (types.includes('Battle')) return 6;
		if (types.includes('Land')) return 7;
		return 8;
	}

	function sortInstances(list: readonly CardInstance[]): CardInstance[] {
		if (activeSortBy === 'none') return [...list];
		const dir = activeSortDir === 'asc' ? 1 : -1;
		const copy = [...list];
		copy.sort((a, b) => {
			const da = resolveCardInstanceDisplay(a, a.zone, viewer.playerId);
			const db = resolveCardInstanceDisplay(b, b.zone, viewer.playerId);
			const ca = da.displayCard;
			const cb = db.displayCard;
			let cmp = 0;
			if (activeSortBy === 'cmc') {
				cmp = ca.cmc !== cb.cmc ? ca.cmc - cb.cmc : ca.name.localeCompare(cb.name);
			} else if (activeSortBy === 'name') {
				cmp = ca.name.localeCompare(cb.name);
			} else if (activeSortBy === 'color') {
				const ra = colorRank(ca.colors);
				const rb = colorRank(cb.colors);
				cmp = ra !== rb ? ra - rb : ca.cmc !== cb.cmc ? ca.cmc - cb.cmc : ca.name.localeCompare(cb.name);
			} else if (activeSortBy === 'type') {
				const ta = typeRank(da.types);
				const tb = typeRank(db.types);
				cmp = ta !== tb ? ta - tb : ca.cmc !== cb.cmc ? ca.cmc - cb.cmc : ca.name.localeCompare(cb.name);
			}
			return cmp * dir;
		});
		return copy;
	}

	const effectiveHand = $derived(sortedHand ?? sortInstances(viewer.hand));

	const choice = $derived(effectivePromptChoice(prompt, gameState));
	const purpose = $derived(effectivePromptPurpose(prompt));
	const cancellable = $derived(isPromptCancellable(prompt, purpose));

	let activePromptId = $state<string | null>(null);
	let peekingBattlefield = $state(false);
	let selectedObjectIds = $state<string[]>([]);
	let selectedModeIndices = $state<number[]>([]);
	let selectedNumber = $state<number>(0);
	let librarySearchQuery = $state('');
	let fastSinglePick = $state(false);

	let orderPromptId = $state<string | null>(null);
	let orderedTopIds = $state<string[]>([]);
	let orderedBottomIds = $state<string[]>([]);

	$effect(() => {
		if (activePromptId !== prompt.id) {
			activePromptId = prompt.id;
			peekingBattlefield = false;
			librarySearchQuery = '';
			selectedObjectIds =
				choice.kind === 'chooseObjects' && choice.defaultObjectIds
					? [...choice.defaultObjectIds]
					: [];
			selectedModeIndices =
				choice.kind === 'chooseMode' && choice.defaultIndices
					? [...choice.defaultIndices]
					: [];
			selectedNumber =
				choice.kind === 'chooseNumber'
					? (choice.defaultNumber ?? choice.min)
					: 0;
			fastSinglePick =
				choice.kind === 'chooseObjects' &&
				choice.zone === 'library' &&
				isSingleClickObjectChoice(choice);
		}

		if (choice.kind === 'orderObjects') {
			if (orderPromptId !== prompt.id) {
				orderPromptId = prompt.id;
				const initial = buildOrderObjectsInitialLists(gameState, viewer.playerId, choice);
				orderedTopIds = initial.topIds;
				orderedBottomIds = initial.bottomIds;
			}
		} else {
			orderPromptId = null;
			orderedTopIds = [];
			orderedBottomIds = [];
		}
	});

	function toggleObjectSelection(id: string, maxReq: number) {
		if (selectedObjectIds.includes(id)) {
			selectedObjectIds = selectedObjectIds.filter((x) => x !== id);
		} else if (maxReq === 1) {
			selectedObjectIds = [id];
		} else if (selectedObjectIds.length < maxReq) {
			selectedObjectIds = [...selectedObjectIds, id];
		}
	}

	async function handleCandidateClick(id: string, maxReq: number, singleClickEligible: boolean) {
		if (singleClickEligible && fastSinglePick) {
			librarySearchQuery = '';
			selectedObjectIds = [];
			await onGameAction({
				type: 'choice',
				promptId: prompt.id,
				answer: { kind: 'chooseObjects', objectIds: [id] }
			});
			return;
		}
		toggleObjectSelection(id, maxReq);
	}

	function toggleModeSelection(modeIdx: number, maxReq: number, disabled?: number[]) {
		if (disabled?.includes(modeIdx)) return;
		if (selectedModeIndices.includes(modeIdx)) {
			selectedModeIndices = selectedModeIndices.filter((idx) => idx !== modeIdx);
		} else if (selectedModeIndices.length < maxReq) {
			selectedModeIndices = [...selectedModeIndices, modeIdx];
		}
	}

	function adjustModeRepeat(modeIdx: number, delta: 1 | -1, maxReq: number, disabled?: number[]) {
		if (disabled?.includes(modeIdx)) return;
		if (delta > 0) {
			if (selectedModeIndices.length >= maxReq) return;
			selectedModeIndices = [...selectedModeIndices, modeIdx];
		} else {
			const pos = selectedModeIndices.lastIndexOf(modeIdx);
			if (pos < 0) return;
			const next = [...selectedModeIndices];
			next.splice(pos, 1);
			selectedModeIndices = next;
		}
	}

	function shiftOrder(id: string, dir: -1 | 1) {
		const next = shiftOrderedObjects(orderedTopIds, orderedBottomIds, id, dir);
		orderedTopIds = next.topIds;
		orderedBottomIds = next.bottomIds;
	}

	function splitOrder(id: string, toBottom: boolean) {
		const next = moveOrderedObjectSplit(orderedTopIds, orderedBottomIds, id, toBottom);
		orderedTopIds = next.topIds;
		orderedBottomIds = next.bottomIds;
	}

	function cancelPrompt() {
		onGameAction({
			type: 'choice',
			promptId: prompt.id,
			cancel: true
		});
	}

	function candidateRelationLabel(c: ResolvedPromptCandidate): string {
		if (c.isYours && c.isOwnedByViewer) return 'You';
		if (c.isYours && !c.isOwnedByViewer) return `You (Owner: ${c.ownerName})`;
		if (c.ownerId !== c.controllerId) return `${c.controllerName} (Owner: ${c.ownerName})`;
		return c.controllerName;
	}
</script>

{#if peekingBattlefield}
	<div class="peek-banner-shell" role="region" aria-label="Minimized prompt banner">
		<div class="peek-banner">
			<span class="peek-indicator">⏳ Prompt Active:</span>
			<strong class="peek-title">{prompt.title}</strong>
			<button
				type="button"
				class="arena-main-btn can-act compact"
				onclick={() => (peekingBattlefield = false)}
			>
				↩ Restore Prompt
			</button>
		</div>
	</div>
{:else}
	<div class="modal-backdrop">
		<div class="arena-modal wide">
			<div class="modal-head-row">
				<h3>{prompt.title}</h3>
				<button
					type="button"
					class="peek-btn"
					title="Temporarily hide this prompt to inspect the battlefield and zones"
					onclick={() => (peekingBattlefield = true)}
				>
					👁 Peek Battlefield
				</button>
			</div>

			{#if prompt.description}
				<p class="modal-desc">{prompt.description}</p>
			{/if}

			{#if choice.kind === 'yesNo'}
				{#if purpose === 'mulligan'}
					<div class="hand-toolbar modal-sort-bar">
						<span class="hand-count-label">OPENING HAND ({effectiveHand.length})</span>
						<div class="hand-sort-group" role="group" aria-label="Auto-sort hand">
							<span class="sort-caption">Sort:</span>
							{#each ([
								['none', 'None'],
								['cmc', 'CMC'],
								['name', 'Name'],
								['color', 'Color'],
								['type', 'Type']
							] as const) as [mode, label] (mode)}
								<button
									type="button"
									class="sort-pill"
									class:active={activeSortBy === mode}
									onclick={() => updateSortMode(mode)}
								>
									{label}
								</button>
							{/each}
							<span class="sort-divider" aria-hidden="true">|</span>
							<button
								type="button"
								class="sort-pill dir-pill"
								class:active={activeSortBy !== 'none' && activeSortDir === 'asc'}
								title="Sort Ascending"
								onclick={() => updateSortDir('asc')}
							>
								ASC
							</button>
							<button
								type="button"
								class="sort-pill dir-pill"
								class:active={activeSortBy !== 'none' && activeSortDir === 'desc'}
								title="Sort Descending"
								onclick={() => updateSortDir('desc')}
							>
								DESC
							</button>
						</div>
					</div>
					<div class="modal-card-grid">
						{#each effectiveHand as c (c.instanceId)}
							{@const disp = resolveCardInstanceDisplay(c, 'hand', viewer.playerId)}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="modal-card-item"
								onmouseenter={() => onHoverCard?.(disp.displayCard, c)}
								onmouseleave={() => onLeaveCard?.(disp.displayCard)}
							>
								<img src={disp.imageUrl} alt={disp.displayCard.name} />
								<span>{disp.displayCard.name}</span>
							</div>
						{/each}
					</div>
				{/if}

				{#if purpose === 'guided_resolution'}
					<GuidedResolutionBuilder
						promptId={prompt.id}
						{gameState}
						viewerId={viewer.playerId}
						yesLabel={prompt.yesLabel || 'Apply & Complete Resolution'}
						{cancellable}
						onSubmit={(operations) =>
							onGameAction({
								type: 'choice',
								promptId: prompt.id,
								answer: { kind: 'yesNo', yes: true },
								operations
							})}
						onCancel={cancelPrompt}
					/>
				{:else}
					{@const yesLabel =
						prompt.yesLabel ||
						(purpose === 'mulligan'
							? `Keep Hand (Mulligans taken: ${viewer.mulliganCount})`
							: purpose === 'commander_zone_choice'
								? 'Return to Command Zone (Recommended)'
								: purpose === 'end_turn'
									? 'End the Turn Now (Exile All Spells/Abilities on Stack)'
									: 'Yes')}
					{@const noLabel =
						prompt.noLabel ||
						(purpose === 'mulligan'
							? 'Mulligan (Draw New 7)'
							: purpose === 'commander_zone_choice'
								? `Leave in ${prompt.destinationZone}`
								: purpose === 'end_turn'
									? 'Decline (Continue Turn Normally)'
									: 'No')}
					<div class="modal-actions">
						<button
							type="button"
							class="arena-main-btn can-act"
							onclick={() =>
								onGameAction({
									type: 'choice',
									promptId: prompt.id,
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
									promptId: prompt.id,
									answer: { kind: 'yesNo', yes: false }
								})}
						>
							{noLabel}
						</button>
						{#if cancellable}
							<button type="button" class="hud-btn" onclick={cancelPrompt}>
								Cancel
							</button>
						{/if}
					</div>
				{/if}
			{:else if choice.kind === 'chooseObjects'}
				{@const singleClickEligible = isSingleClickObjectChoice(choice)}
				{#if choice.zone === 'library'}
					{@const searchedOwner =
						gameState.players.find(
							(p) => p.playerId === (prompt.targetLibraryOwnerId || viewer.playerId)
						) || viewer}
					{@const libSourceIds =
						choice.candidates.length > 0
							? choice.candidates
							: searchedOwner.library.map((c) => c.instanceId)}
					{@const resolvedLib = resolvePromptCandidates(gameState, viewer.playerId, libSourceIds)}
					{@const filteredLibCandidates = resolvedLib.candidates.filter((c) =>
						matchesScryfallQuery(c.displayCard, librarySearchQuery)
					)}
					{@const libProgress = computeWeightProgress(selectedObjectIds, choice)}
					<div class="modal-head-row">
						<span class="hand-count-label">
							ELIGIBLE IN {searchedOwner.playerId === viewer.playerId ? 'YOUR' : `${searchedOwner.username.toUpperCase()}'S`} LIBRARY ({filteredLibCandidates.length}/{resolvedLib.candidates.length})
						</span>
						<div class="head-controls">
							{#if singleClickEligible}
								<label class="fast-pick-toggle">
									<input type="checkbox" bind:checked={fastSinglePick} />
									<span>⚡ 1-Click Pick</span>
								</label>
							{/if}
							<input
								type="search"
								class="modal-scryfall-input"
								bind:value={librarySearchQuery}
								placeholder="Scryfall search (e.g. t:land, t:basic, mv<=2, o:draw)..."
							/>
						</div>
					</div>
					<div class="modal-card-grid">
						{#each filteredLibCandidates as c (c.id)}
							<button
								type="button"
								class="modal-card-item selectable"
								class:selected={selectedObjectIds.includes(c.id)}
								onmouseenter={() => onHoverCard?.(c.displayCard, c.inst)}
								onmouseleave={() => onLeaveCard?.(c.displayCard)}
								onclick={() => handleCandidateClick(c.id, choice.max, singleClickEligible)}
							>
								<div class="candidate-pills">
									<span class="cand-pill zone-pill">{ZONE_SHORT_LABELS[c.zone]}</span>
									<span class="cand-pill" class:yours={c.isYours} class:opp={!c.isYours}>
										{candidateRelationLabel(c)}
									</span>
								</div>
								<img src={c.imageUrl} alt={c.displayCard.name} />
								<span>{c.displayCard.name}</span>
							</button>
						{/each}
					</div>
					<div class="modal-actions">
						{#if !singleClickEligible || !fastSinglePick}
							<button
								type="button"
								class="arena-main-btn"
								class:can-act={libProgress.isReady}
								disabled={!libProgress.isReady}
								onclick={async () => {
									if (!libProgress.isReady) return;
									const ids = [...selectedObjectIds];
									selectedObjectIds = [];
									librarySearchQuery = '';
									await onGameAction({
										type: 'choice',
										promptId: prompt.id,
										answer: { kind: 'chooseObjects', objectIds: ids }
									});
								}}
							>
								Confirm Selection ({selectedObjectIds.length}/{choice.max})
							</button>
						{/if}
						{#if choice.min === 0}
							<button
								type="button"
								class="hud-btn"
								onclick={() => {
									librarySearchQuery = '';
									onGameAction({
										type: 'choice',
										promptId: prompt.id,
										answer: { kind: 'chooseObjects', objectIds: [] }
									});
								}}
							>
								Fail to Find (Shuffle Without Picking)
							</button>
						{/if}
						{#if cancellable}
							<button type="button" class="hud-btn" onclick={cancelPrompt}>
								Cancel
							</button>
						{/if}
					</div>
				{:else}
					{@const progress = computeWeightProgress(selectedObjectIds, choice)}
					{@const isPureViewerHand =
						choice.zone === 'hand' &&
						(choice.candidates.length === 0 ||
							choice.candidates.every((id) => viewer.hand.some((c) => c.instanceId === id)))}
					{@const sourceIds = isPureViewerHand
						? effectiveHand
								.filter(
									(c) =>
										choice.candidates.length === 0 || choice.candidates.includes(c.instanceId)
								)
								.map((c) => c.instanceId)
						: choice.candidates}
					{@const resolved = resolvePromptCandidates(gameState, viewer.playerId, sourceIds)}

					{#if progress.hasWeightConstraint && progress.requiredWeightSum !== null}
						<div class="weight-progress-box">
							<div class="weight-progress-top">
								<span class="hand-count-label">
									Selected {progress.weightLabel}: {progress.selectedWeightSum} / {progress.requiredWeightSum}
								</span>
								{#if progress.remainingWeight > 0}
									<span class="weight-rem">Need {progress.remainingWeight} more</span>
								{:else}
									<span class="weight-done">Requirement met</span>
								{/if}
							</div>
							<div class="weight-bar-track">
								<div
									class="weight-bar-fill"
									class:met={progress.weightSatisfied}
									style="width: {Math.round(progress.progressRatio * 100)}%;"
								></div>
							</div>
						</div>
					{/if}

					<div class="hand-toolbar modal-sort-bar">
						<span class="hand-count-label">
							SELECT {choice.min === choice.max ? choice.max : `${choice.min}-${choice.max}`} OBJECT(S) ({selectedObjectIds.length}/{choice.max})
						</span>
						<div class="head-controls">
							{#if singleClickEligible}
								<label class="fast-pick-toggle">
									<input type="checkbox" bind:checked={fastSinglePick} />
									<span>⚡ 1-Click Pick</span>
								</label>
							{/if}
							{#if isPureViewerHand}
								<div class="hand-sort-group" role="group" aria-label="Auto-sort hand">
									<span class="sort-caption">Sort:</span>
									{#each ([
										['none', 'None'],
										['cmc', 'CMC'],
										['name', 'Name'],
										['color', 'Color'],
										['type', 'Type']
									] as const) as [mode, label] (mode)}
										<button
											type="button"
											class="sort-pill"
											class:active={activeSortBy === mode}
											onclick={() => updateSortMode(mode)}
										>
											{label}
										</button>
									{/each}
									<span class="sort-divider" aria-hidden="true">|</span>
									<button
										type="button"
										class="sort-pill dir-pill"
										class:active={activeSortBy !== 'none' && activeSortDir === 'asc'}
										onclick={() => updateSortDir('asc')}
									>
										ASC
									</button>
									<button
										type="button"
										class="sort-pill dir-pill"
										class:active={activeSortBy !== 'none' && activeSortDir === 'desc'}
										onclick={() => updateSortDir('desc')}
									>
										DESC
									</button>
								</div>
							{/if}
						</div>
					</div>

					<div class="modal-card-grid">
						{#each resolved.candidates as c (c.id)}
							<button
								type="button"
								class="modal-card-item selectable"
								class:selected={selectedObjectIds.includes(c.id)}
								onmouseenter={() => onHoverCard?.(c.displayCard, c.inst)}
								onmouseleave={() => onLeaveCard?.(c.displayCard)}
								onclick={() => handleCandidateClick(c.id, choice.max, singleClickEligible)}
							>
								<div class="candidate-pills">
									<span class="cand-pill zone-pill">{ZONE_SHORT_LABELS[c.zone]}</span>
									<span class="cand-pill" class:yours={c.isYours} class:opp={!c.isYours}>
										{candidateRelationLabel(c)}
									</span>
								</div>
								<img src={c.imageUrl} alt={c.stackItem?.title || c.displayCard.name} />
								<span>{c.stackItem?.title || c.displayCard.name}</span>
								{#if choice.weightsById && choice.weightsById[c.id] !== undefined}
									<span class="badge cyan">{choice.weightsById[c.id]} {progress.weightLabel}</span>
								{/if}
							</button>
						{/each}
						{#each resolved.nonCardCandidates as nc (nc.id)}
							<button
								type="button"
								class="modal-card-item selectable non-card-tile"
								class:selected={selectedObjectIds.includes(nc.id)}
								onclick={() => handleCandidateClick(nc.id, choice.max, singleClickEligible)}
							>
								<span class="cand-pill zone-pill">
									{nc.kind === 'player' ? 'Player' : 'Option'}
								</span>
								<span class="non-card-label">{nc.label}</span>
							</button>
						{/each}
					</div>

					<div class="modal-actions">
						{#if !singleClickEligible || !fastSinglePick}
							<button
								type="button"
								class="arena-main-btn"
								class:can-act={progress.isReady}
								disabled={!progress.isReady}
								onclick={async () => {
									if (!progress.isReady) return;
									const ids = [...selectedObjectIds];
									selectedObjectIds = [];
									await onGameAction({
										type: 'choice',
										promptId: prompt.id,
										answer: { kind: 'chooseObjects', objectIds: ids }
									});
								}}
							>
								{#if progress.hasWeightConstraint && progress.requiredWeightSum !== null}
									Confirm ({progress.selectedWeightSum}/{progress.requiredWeightSum} {progress.weightLabel})
								{:else}
									Confirm Selection ({selectedObjectIds.length}/{choice.max})
								{/if}
							</button>
						{/if}
						{#if cancellable}
							<button type="button" class="hud-btn" onclick={cancelPrompt}>
								Cancel
							</button>
						{/if}
					</div>
				{/if}
			{:else if choice.kind === 'chooseMode'}
				{@const disabledSet = new Set(choice.disabledIndices ?? [])}
				{#if !choice.allowRepeat && choice.min === 1 && choice.max === 1}
					<div class="mode-picker-list">
						{#each choice.modes as label, i (i)}
							{@const isDisabled = disabledSet.has(i)}
							<button
								type="button"
								class={i === 0 && !isDisabled ? 'arena-main-btn can-act mode-option-btn' : 'hud-btn mode-option-btn'}
								disabled={isDisabled}
								title={isDisabled ? 'Mode unavailable (no legal targets or already chosen this turn)' : label}
								onclick={() =>
									onGameAction({
										type: 'choice',
										promptId: prompt.id,
										answer: { kind: 'chooseMode', indices: [i] }
									})}
							>
								<ManaText text={label} size={14} />
							</button>
						{/each}
					</div>
				{:else if choice.allowRepeat}
					{@const isModeReady =
						selectedModeIndices.length >= choice.min &&
						selectedModeIndices.length <= choice.max}
					<div class="mode-picker-list">
						{#each choice.modes as label, i (i)}
							{@const isDisabled = disabledSet.has(i)}
							{@const pickedCount = selectedModeIndices.filter((x) => x === i).length}
							<div class="mode-repeat-row" class:disabled={isDisabled}>
								<span class="mode-repeat-label">
									<ManaText text={label} size={14} />
								</span>
								<div class="mode-repeat-controls">
									<button
										type="button"
										class="hud-btn mini-btn"
										disabled={pickedCount === 0}
										onclick={() => adjustModeRepeat(i, -1, choice.max, choice.disabledIndices)}
									>
										−
									</button>
									<span class="mode-count-badge">×{pickedCount}</span>
									<button
										type="button"
										class="hud-btn mini-btn"
										disabled={isDisabled || selectedModeIndices.length >= choice.max}
										onclick={() => adjustModeRepeat(i, 1, choice.max, choice.disabledIndices)}
									>
										+
									</button>
								</div>
							</div>
						{/each}
					</div>
					<div class="modal-actions">
						<button
							type="button"
							class="arena-main-btn"
							class:can-act={isModeReady}
							disabled={!isModeReady}
							onclick={async () => {
								const indices = [...selectedModeIndices];
								selectedModeIndices = [];
								await onGameAction({
									type: 'choice',
									promptId: prompt.id,
									answer: { kind: 'chooseMode', indices }
								});
							}}
						>
							Confirm Modes ({selectedModeIndices.length}/{choice.max})
						</button>
					</div>
				{:else}
					{@const isModeReady =
						selectedModeIndices.length >= choice.min &&
						selectedModeIndices.length <= choice.max}
					<div class="mode-picker-list">
						{#each choice.modes as label, i (i)}
							{@const isDisabled = disabledSet.has(i)}
							<button
								type="button"
								class={selectedModeIndices.includes(i) ? 'arena-main-btn can-act mode-option-btn' : 'hud-btn mode-option-btn'}
								disabled={isDisabled}
								title={isDisabled ? 'Mode unavailable (no legal targets or already chosen this turn)' : label}
								onclick={() => toggleModeSelection(i, choice.max, choice.disabledIndices)}
							>
								<ManaText text={label} size={14} />
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
								const indices = [...selectedModeIndices];
								selectedModeIndices = [];
								await onGameAction({
									type: 'choice',
									promptId: prompt.id,
									answer: { kind: 'chooseMode', indices }
								});
							}}
						>
							Confirm Modes ({selectedModeIndices.length}/{choice.max})
						</button>
					</div>
				{/if}
				{#if cancellable}
					<div class="modal-actions">
						<button type="button" class="hud-btn" onclick={cancelPrompt}>
							Cancel
						</button>
					</div>
				{/if}
			{:else if choice.kind === 'chooseNumber'}
				{@const clampedN = clampXChooserValue(selectedNumber, choice.min, choice.max)}
				<XValueChooser
					value={clampedN}
					min={choice.min}
					max={choice.max}
					badgeLabel={choice.reason.includes('X') ? 'X' : '#'}
					rangeCaption={`Range ${choice.min}–${choice.max}`}
					testIdPrefix="choice-num"
					onChange={(next) => (selectedNumber = next)}
					onSubmit={() =>
						onGameAction({
							type: 'choice',
							promptId: prompt.id,
							answer: {
								kind: 'chooseNumber',
								n: clampXChooserValue(selectedNumber, choice.min, choice.max)
							}
						})}
				/>

				<div class="modal-actions">
					<button
						type="button"
						class="arena-main-btn can-act"
						onclick={() =>
							onGameAction({
								type: 'choice',
								promptId: prompt.id,
								answer: {
									kind: 'chooseNumber',
									n: clampXChooserValue(selectedNumber, choice.min, choice.max)
								}
							})}
					>
						Confirm ({clampedN})
					</button>
					{#if cancellable}
						<button type="button" class="hud-btn" onclick={cancelPrompt}>
							Cancel
						</button>
					{/if}
				</div>
			{:else if choice.kind === 'orderObjects'}
				{@const orderModel = buildOrderObjectsInitialLists(gameState, viewer.playerId, {
					objectIds: [...orderedTopIds, ...orderedBottomIds],
					allowSplitBottom: choice.allowSplitBottom,
					splitLabel: choice.splitLabel,
					allowShuffle: choice.allowShuffle
				})}
				{#if purpose === 'trigger_order'}
					<div class="scry-section">
						<div class="scry-section-head">
							<strong>TRIGGERED ABILITIES ({orderedTopIds.length})</strong>
							<span class="scry-hint">#1 resolves first — use ◀ / ▶ to rearrange order</span>
						</div>
						<div class="modal-card-grid">
							{#each orderedTopIds as id, idx (id)}
								{@const c = orderModel.candidatesById.get(id)}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div
									class="modal-card-item scry-card-item"
									role="group"
									aria-label="Trigger #{idx + 1}"
									onmouseenter={() => c && onHoverCard?.(c.displayCard, c.inst)}
									onmouseleave={() => c && onLeaveCard?.(c.displayCard)}
								>
									<div class="scry-rank-pill top-rank">
										#{idx + 1}{idx === 0 ? ' (Resolves First)' : ''}
									</div>
									{#if c?.imageUrl}
										<img src={c.imageUrl} alt={c.stackItem?.title || c.displayCard.name} />
									{/if}
									<span class="scry-card-name">
										{c?.stackItem?.title ?? c?.displayCard.name ?? id}
									</span>
									<div class="scry-controls-row">
										<button
											type="button"
											class="gy-move-btn"
											disabled={idx === 0}
											onclick={() => shiftOrder(id, -1)}
										>
											◀ Earlier
										</button>
										<button
											type="button"
											class="gy-move-btn"
											disabled={idx === orderedTopIds.length - 1}
											onclick={() => shiftOrder(id, 1)}
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
								const topIds = [...orderedTopIds];
								orderedTopIds = [];
								await onGameAction({
									type: 'choice',
									promptId: prompt.id,
									answer: { kind: 'orderObjects', topIds, bottomIds: [], shuffle: false }
								});
							}}
						>
							Confirm Order
						</button>
						{#if cancellable}
							<button type="button" class="hud-btn" onclick={cancelPrompt}>
								Cancel
							</button>
						{/if}
					</div>
				{:else}
					{@const canBottom = choice.allowSplitBottom !== false}
					{@const isGraveyardSplit = choice.splitLabel === 'graveyard'}
					{@const canShuffle = Boolean(choice.allowShuffle)}
					{@const isLibraryOrder = canBottom || orderModel.inferredZone === 'library'}
					{@const primaryHeader = isLibraryOrder
						? `TOP OF LIBRARY (${orderedTopIds.length})`
						: orderModel.inferredZone === 'graveyard'
							? `GRAVEYARD ORDER (${orderedTopIds.length})`
							: orderModel.inferredZone === 'exile'
								? `EXILED CARDS ORDER (${orderedTopIds.length})`
								: orderModel.inferredZone === 'battlefield'
									? `BATTLEFIELD ORDER (${orderedTopIds.length})`
									: `ORDERED OBJECTS (${orderedTopIds.length})`}
					{@const primaryHint = isLibraryOrder
						? '#1 is the very top card (drawn next) — use ◀ / ▶ to rearrange order'
						: '#1 is first in order — use ◀ / ▶ to rearrange'}

					<div class="scry-section">
						<div class="scry-section-head">
							<strong>{primaryHeader}</strong>
							<span class="scry-hint">{primaryHint}</span>
						</div>
						{#if orderedTopIds.length === 0}
							<div class="scry-empty">
								{isGraveyardSplit
									? 'No cards remaining on top (all sent to graveyard).'
									: 'No cards remaining on top (all sent to bottom).'}
							</div>
						{:else}
							<div class="modal-card-grid">
								{#each orderedTopIds as id, idx (id)}
									{@const c = orderModel.candidatesById.get(id)}
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div
										class="modal-card-item scry-card-item"
										role="group"
										aria-label="Ordered item #{idx + 1}: {c?.displayCard.name ?? id}"
										onmouseenter={() => c && onHoverCard?.(c.displayCard, c.inst)}
										onmouseleave={() => c && onLeaveCard?.(c.displayCard)}
									>
										<div class="scry-rank-pill top-rank">
											{isLibraryOrder ? `TOP #${idx + 1}${idx === 0 ? ' (Next Draw)' : ''}` : `#${idx + 1}`}
										</div>
										{#if c && !isLibraryOrder}
											<div class="candidate-pills">
												<span class="cand-pill zone-pill">{ZONE_SHORT_LABELS[c.zone]}</span>
												<span class="cand-pill" class:yours={c.isYours} class:opp={!c.isYours}>
													{candidateRelationLabel(c)}
												</span>
											</div>
										{/if}
										{#if c?.imageUrl}
											<img src={c.imageUrl} alt={c.displayCard.name} />
										{/if}
										<span class="scry-card-name">{c?.displayCard.name ?? id}</span>
										<div class="scry-controls-row">
											<button
												type="button"
												class="gy-move-btn"
												disabled={idx === 0}
												title="Move earlier"
												onclick={() => shiftOrder(id, -1)}
											>
												◀ Earlier
											</button>
											<button
												type="button"
												class="gy-move-btn"
												disabled={idx === orderedTopIds.length - 1}
												title="Move later"
												onclick={() => shiftOrder(id, 1)}
											>
												Later ▶
											</button>
										</div>
										{#if canBottom}
											<button
												type="button"
												class="scry-zone-toggle to-bottom"
												onclick={() => splitOrder(id, true)}
											>
												{isGraveyardSplit ? '⬇ Put into Graveyard' : '⬇ Put on Bottom'}
											</button>
										{/if}
									</div>
								{/each}
							</div>
						{/if}
					</div>

					{#if canBottom && orderedBottomIds.length > 0}
						<div class="scry-section bottom-sec">
							<div class="scry-section-head">
								<strong>
									{isGraveyardSplit
										? `GRAVEYARD (${orderedBottomIds.length})`
										: `BOTTOM OF LIBRARY (${orderedBottomIds.length})`}
								</strong>
								<span class="scry-hint">
									{isGraveyardSplit
										? 'Put into your graveyard in this order'
										: 'Put on the bottom of your library in this order'}
								</span>
							</div>
							<div class="modal-card-grid">
								{#each orderedBottomIds as id, idx (id)}
									{@const c = orderModel.candidatesById.get(id)}
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div
										class="modal-card-item scry-card-item selected"
										role="group"
										aria-label="{isGraveyardSplit ? 'Graveyard' : 'Bottom'} card #{idx + 1}: {c?.displayCard.name ?? id}"
										onmouseenter={() => c && onHoverCard?.(c.displayCard, c.inst)}
										onmouseleave={() => c && onLeaveCard?.(c.displayCard)}
									>
										<div class="scry-rank-pill bot-rank">
											{isGraveyardSplit ? 'GRAVEYARD' : 'BOTTOM'} #{idx + 1}
										</div>
										{#if c?.imageUrl}
											<img src={c.imageUrl} alt={c.displayCard.name} />
										{/if}
										<span class="scry-card-name">{c?.displayCard.name ?? id}</span>
										<div class="scry-controls-row">
											<button
												type="button"
												class="gy-move-btn"
												disabled={idx === 0}
												onclick={() => shiftOrder(id, -1)}
											>
												◀
											</button>
											<button
												type="button"
												class="gy-move-btn"
												disabled={idx === orderedBottomIds.length - 1}
												onclick={() => shiftOrder(id, 1)}
											>
												▶
											</button>
										</div>
										<button
											type="button"
											class="scry-zone-toggle to-top"
											onclick={() => splitOrder(id, false)}
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
									const topIds = [...orderedTopIds];
									const bottomIds = [...orderedBottomIds];
									orderedTopIds = [];
									orderedBottomIds = [];
									await onGameAction({
										type: 'choice',
										promptId: prompt.id,
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
								const topIds = [...orderedTopIds];
								const bottomIds = [...orderedBottomIds];
								orderedTopIds = [];
								orderedBottomIds = [];
								await onGameAction({
									type: 'choice',
									promptId: prompt.id,
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
								{isGraveyardSplit
									? `Confirm Surveil (${orderedTopIds.length} Top / ${orderedBottomIds.length} Graveyard)`
									: `Confirm Scry (${orderedTopIds.length} Top / ${orderedBottomIds.length} Bottom)`}
							{:else if isLibraryOrder}
								Keep This Top Order
							{:else}
								Confirm Order
							{/if}
						</button>
						{#if cancellable}
							<button type="button" class="hud-btn" onclick={cancelPrompt}>
								Cancel
							</button>
						{/if}
					</div>
				{/if}
			{:else if choice.kind === 'chooseReplacement'}
				<div class="modal-actions">
					{#each choice.options as opt, i (opt.id)}
						<button
							type="button"
							class={i === 0 ? 'arena-main-btn can-act' : 'hud-btn'}
							onclick={() =>
								onGameAction({
									type: 'choice',
									promptId: prompt.id,
									answer: { kind: 'chooseReplacement', id: opt.id }
								})}
						>
							{opt.label}
						</button>
					{/each}
					{#if cancellable}
						<button type="button" class="hud-btn" onclick={cancelPrompt}>
							Cancel
						</button>
					{/if}
				</div>
			{:else}
				{@const _exhaustiveChoice: never = choice}
				<p class="modal-desc">{String(_exhaustiveChoice)}</p>
			{/if}
		</div>
	</div>
{/if}

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(10, 8, 14, 0.78);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 200;
		padding: 1rem;
		font-family: var(--mono-font, monospace);
	}
	.arena-modal {
		background: var(--mp-bg-elevated, #221f22);
		border: 1.5px solid var(--mp-accent, #ffd866);
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
		max-width: 840px;
	}
	.arena-modal h3 {
		margin: 0;
		color: var(--mp-accent, #ffd866);
	}
	.modal-desc {
		margin: 0;
		font-size: 0.8rem;
		color: var(--mp-text-body, #e3e1e4);
		white-space: pre-line;
	}
	.modal-head-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.65rem;
		flex-wrap: wrap;
	}
	.head-controls {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		flex-wrap: wrap;
	}
	.peek-btn {
		background: var(--mp-bg, #19181a);
		color: var(--mp-cyan, #78dce8);
		border: 1px solid var(--mp-cyan, #78dce8);
		border-radius: 6px;
		padding: 0.28rem 0.6rem;
		font-family: inherit;
		font-size: 0.7rem;
		font-weight: 700;
		cursor: pointer;
	}
	.peek-btn:hover {
		background: rgba(120, 220, 232, 0.14);
	}
	.peek-banner-shell {
		position: fixed;
		top: 0.65rem;
		left: 0;
		right: 0;
		display: flex;
		justify-content: center;
		pointer-events: none;
		z-index: 225;
		font-family: var(--mono-font, monospace);
	}
	.peek-banner {
		pointer-events: auto;
		display: flex;
		align-items: center;
		gap: 0.65rem;
		padding: 0.45rem 0.9rem;
		background: var(--mp-bg-elevated, #221f22);
		border: 1.5px solid var(--mp-accent, #ffd866);
		border-radius: 999px;
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65);
	}
	.peek-indicator {
		font-size: 0.7rem;
		color: var(--mp-cyan, #78dce8);
		font-weight: 700;
	}
	.peek-title {
		font-size: 0.78rem;
		color: var(--mp-text, #fcfcfa);
	}
	.fast-pick-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.68rem;
		font-weight: 700;
		color: var(--mp-accent, #ffd866);
		background: var(--mp-bg, #19181a);
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 5px;
		padding: 0.2rem 0.48rem;
		cursor: pointer;
	}
	.modal-scryfall-input {
		flex: 1 1 220px;
		max-width: 340px;
		background: var(--mp-bg, #19181a);
		color: var(--mp-text, #fcfcfa);
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 5px;
		padding: 0.32rem 0.55rem;
		font-family: inherit;
		font-size: 0.72rem;
	}
	.modal-scryfall-input:focus {
		outline: none;
		border-color: var(--mp-accent, #ffd866);
	}
	.hand-toolbar.modal-sort-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		flex-wrap: wrap;
		padding: 0.3rem 0.5rem;
		background: var(--mp-bg, #19181a);
		border: 1px solid var(--mp-border, #3e3a42);
		border-radius: 6px;
	}
	.hand-count-label {
		font-size: 0.7rem;
		font-weight: 700;
		color: var(--mp-accent, #ffd866);
	}
	.hand-sort-group {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex-wrap: wrap;
	}
	.sort-caption {
		font-size: 0.65rem;
		color: var(--mp-text-muted, #939293);
	}
	.sort-pill {
		background: var(--mp-bg-elevated, #221f22);
		color: var(--mp-text-muted, #939293);
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 4px;
		padding: 0.14rem 0.42rem;
		font-family: inherit;
		font-size: 0.64rem;
		font-weight: 700;
		cursor: pointer;
	}
	.sort-pill.active {
		background: rgba(120, 220, 232, 0.16);
		color: var(--mp-cyan, #78dce8);
		border-color: var(--mp-cyan, #78dce8);
	}
	.sort-divider {
		color: var(--mp-border-strong, #524c58);
		font-size: 0.65rem;
	}
	.weight-progress-box {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding: 0.4rem 0.55rem;
		background: var(--mp-bg, #19181a);
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 6px;
	}
	.weight-progress-top {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 0.7rem;
	}
	.weight-rem {
		color: var(--mp-orange, #fc9867);
		font-weight: 700;
		font-size: 0.66rem;
	}
	.weight-done {
		color: var(--mp-green, #a9dc76);
		font-weight: 700;
		font-size: 0.66rem;
	}
	.weight-bar-track {
		height: 6px;
		border-radius: 999px;
		background: var(--mp-bg-elevated, #221f22);
		overflow: hidden;
	}
	.weight-bar-fill {
		height: 100%;
		background: var(--mp-cyan, #78dce8);
		transition: width 0.15s ease;
	}
	.weight-bar-fill.met {
		background: var(--mp-green, #a9dc76);
	}
	.modal-card-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(125px, 1fr));
		gap: 0.6rem;
		max-height: 48vh;
		overflow-y: auto;
	}
	.modal-card-item {
		background: var(--mp-bg, #19181a);
		border: 1.5px solid var(--mp-border-strong, #524c58);
		border-radius: 6px;
		padding: 0.32rem;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.68rem;
		color: var(--mp-text, #fcfcfa);
		font-family: inherit;
	}
	.modal-card-item.selectable {
		cursor: pointer;
	}
	.modal-card-item.selected {
		border-color: var(--mp-accent, #ffd866);
		box-shadow: 0 0 10px var(--mp-accent, #ffd866);
	}
	.modal-card-item img {
		width: 100%;
		border-radius: 4px;
	}
	.non-card-tile {
		justify-content: center;
		min-height: 92px;
		padding: 0.55rem;
		text-align: center;
	}
	.non-card-label {
		font-weight: 700;
		font-size: 0.74rem;
	}
	.candidate-pills {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.2rem;
		width: 100%;
	}
	.cand-pill {
		font-size: 0.56rem;
		font-weight: 700;
		padding: 1px 5px;
		border-radius: 3px;
		max-width: 100%;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.cand-pill.zone-pill {
		background: rgba(171, 157, 242, 0.16);
		color: var(--mp-purple, #ab9df2);
		border: 1px solid rgba(171, 157, 242, 0.45);
	}
	.cand-pill.yours {
		background: rgba(169, 220, 118, 0.15);
		color: var(--mp-green, #a9dc76);
		border: 1px solid rgba(169, 220, 118, 0.45);
	}
	.cand-pill.opp {
		background: rgba(252, 152, 103, 0.15);
		color: var(--mp-orange, #fc9867);
		border: 1px solid rgba(252, 152, 103, 0.45);
	}
	.badge.cyan {
		background: rgba(120, 220, 232, 0.16);
		color: var(--mp-cyan, #78dce8);
		border: 1px solid rgba(120, 220, 232, 0.5);
		border-radius: 4px;
		padding: 1px 5px;
		font-size: 0.6rem;
		font-weight: 700;
	}
	.mode-picker-list {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		margin: 0.4rem 0;
	}
	.mode-option-btn {
		text-align: left;
		justify-content: flex-start;
		width: 100%;
	}
	.mode-repeat-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.65rem;
		padding: 0.4rem 0.55rem;
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.03);
	}
	.mode-repeat-row.disabled {
		opacity: 0.45;
	}
	.mode-repeat-label {
		flex: 1;
		text-align: left;
		font-size: 0.85rem;
	}
	.mode-repeat-controls {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		flex-shrink: 0;
	}
	.mode-count-badge {
		min-width: 1.8rem;
		text-align: center;
		font-weight: 600;
		font-size: 0.85rem;
	}
	.scry-section {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.45rem;
		background: rgba(18, 16, 22, 0.48);
		border: 1px solid var(--mp-border, #3e3a42);
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
		color: var(--mp-text-muted, #939293);
	}
	.scry-empty {
		font-size: 0.72rem;
		color: var(--mp-text-muted, #939293);
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
		color: var(--mp-cyan, #78dce8);
		border: 1px solid var(--mp-cyan, #78dce8);
	}
	.scry-rank-pill.bot-rank {
		background: rgba(255, 97, 136, 0.18);
		color: var(--mp-red, #ff6188);
		border: 1px solid var(--mp-red, #ff6188);
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
	.gy-move-btn {
		background: var(--mp-bg, #19181a);
		color: var(--mp-text, #fcfcfa);
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 3px;
		padding: 0 4px;
		font-size: 0.6rem;
		cursor: pointer;
	}
	.gy-move-btn:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}
	.scry-zone-toggle {
		width: 100%;
		background: var(--mp-bg-elevated, #221f22);
		border: 1px solid var(--mp-border-strong, #524c58);
		color: var(--mp-text, #fcfcfa);
		border-radius: 4px;
		padding: 0.18rem 0.3rem;
		font-family: inherit;
		font-size: 0.6rem;
		font-weight: 700;
		cursor: pointer;
	}
	.scry-zone-toggle.to-bottom:hover {
		border-color: var(--mp-red, #ff6188);
		color: var(--mp-red, #ff6188);
	}
	.scry-zone-toggle.to-top:hover {
		border-color: var(--mp-cyan, #78dce8);
		color: var(--mp-cyan, #78dce8);
	}
	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.arena-main-btn {
		background: var(--mp-bg-subtle, #252229);
		color: var(--mp-text-muted, #939293);
		border: 2px solid var(--mp-border-strong, #524c58);
		border-radius: 8px;
		padding: 0.7rem 0.8rem;
		font-family: inherit;
		font-size: 0.8rem;
		font-weight: 700;
		cursor: pointer;
	}
	.arena-main-btn.can-act {
		background: var(--mp-btn-bg, #ffd866);
		color: var(--mp-btn-fg, #19181a);
		border-color: var(--mp-btn-bg, #ffd866);
	}
	.arena-main-btn.compact {
		padding: 0.32rem 0.72rem;
		font-size: 0.72rem;
		border-radius: 999px;
	}
	.arena-main-btn:disabled {
		opacity: 0.36;
		cursor: not-allowed;
	}
	.hud-btn {
		background: var(--mp-bg, #19181a);
		color: var(--mp-text, #fcfcfa);
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 6px;
		padding: 0.45rem 0.75rem;
		font-family: inherit;
		font-size: 0.76rem;
		font-weight: 600;
		cursor: pointer;
	}
	.hud-btn.mini-btn {
		padding: 0.25rem 0.55rem;
		font-size: 0.74rem;
	}
	.hud-btn:hover:not(:disabled) {
		border-color: var(--mp-accent, #ffd866);
	}
	.hud-btn:disabled {
		opacity: 0.38;
		cursor: not-allowed;
	}
</style>
