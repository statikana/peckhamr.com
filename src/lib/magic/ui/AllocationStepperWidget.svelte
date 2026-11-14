<script lang="ts">
	import type { CardInstance, ScryfallCard } from '../types.ts';
	import {
		adjustAllocation,
		allocatedTotal,
		createAllocationState,
		isValidAllocation,
		remainingAllocation,
		type AllocationState
	} from './promptViewModel.ts';

	export interface AllocationTargetItem {
		id: string;
		label: string;
		sublabel?: string;
		imageUrl?: string;
		card?: ScryfallCard;
		instance?: CardInstance;
	}

	let {
		targets,
		amountToDistribute,
		minPerTarget = 1,
		maxPerTarget,
		initialAllocations,
		unitLabel = 'damage',
		confirmLabel,
		cancellable = false,
		onConfirm,
		onCancel,
		onHoverCard,
		onLeaveCard
	}: {
		targets: AllocationTargetItem[];
		amountToDistribute: number;
		minPerTarget?: number;
		maxPerTarget?: Record<string, number>;
		initialAllocations?: Record<string, number>;
		unitLabel?: string;
		confirmLabel?: string;
		cancellable?: boolean;
		onConfirm: (allocations: Record<string, number>) => void | Promise<void>;
		onCancel?: () => void | Promise<void>;
		onHoverCard?: (card: ScryfallCard, inst?: CardInstance) => void;
		onLeaveCard?: (card: ScryfallCard) => void;
	} = $props();

	let stateKey = $state('');
	let allocState = $state<AllocationState>({
		targetIds: [],
		amountToDistribute: 0,
		minPerTarget: 1,
		allocations: {}
	});

	$effect(() => {
		const key = `${targets.map((t) => t.id).join(',')}|${amountToDistribute}|${minPerTarget}`;
		if (stateKey !== key) {
			stateKey = key;
			allocState = createAllocationState({
				targetIds: targets.map((t) => t.id),
				amountToDistribute,
				minPerTarget,
				maxPerTarget,
				initial: initialAllocations
			});
		}
	});

	const totalAllocated = $derived(allocatedTotal(allocState));
	const unallocated = $derived(remainingAllocation(allocState));
	const valid = $derived(isValidAllocation(allocState));

	function step(targetId: string, delta: number) {
		allocState = adjustAllocation(allocState, targetId, delta);
	}
</script>

<div class="alloc-widget">
	<div class="alloc-summary">
		<div class="alloc-pool">
			<strong>
				Allocated {totalAllocated} / {allocState.amountToDistribute} {unitLabel}
			</strong>
			<span class="alloc-rem" class:done={unallocated === 0}>
				{unallocated === 0 ? 'All distributed' : `${unallocated} remaining`}
			</span>
		</div>
		{#if allocState.minPerTarget > 0 && targets.length > 0}
			<span class="alloc-rule-hint">
				CR 601.2d: each target must receive &ge; {allocState.minPerTarget}
			</span>
		{/if}
	</div>

	<div class="alloc-target-list">
		{#each targets as t (t.id)}
			{@const val = allocState.allocations[t.id] ?? 0}
			{@const belowMin = val < allocState.minPerTarget}
			{@const cap = allocState.maxPerTarget?.[t.id]}
			{@const canInc = unallocated > 0 && (cap === undefined || val < cap)}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="alloc-row"
				class:below-min={belowMin}
				onmouseenter={() => t.card && onHoverCard?.(t.card, t.instance)}
				onmouseleave={() => t.card && onLeaveCard?.(t.card)}
			>
				<div class="alloc-target-info">
					{#if t.imageUrl}
						<img src={t.imageUrl} alt={t.label} class="alloc-thumb" />
					{/if}
					<div class="alloc-labels">
						<span class="alloc-name">{t.label}</span>
						{#if t.sublabel}
							<span class="alloc-sub">{t.sublabel}</span>
						{/if}
						{#if belowMin}
							<span class="alloc-warn">Minimum {allocState.minPerTarget} required</span>
						{/if}
					</div>
				</div>

				<div class="alloc-controls">
					<button
						type="button"
						class="step-btn"
						disabled={val === 0}
						onclick={() => step(t.id, -5)}
					>
						-5
					</button>
					<button
						type="button"
						class="step-btn"
						disabled={val === 0}
						onclick={() => step(t.id, -1)}
					>
						-1
					</button>
					<span class="alloc-val" class:invalid={belowMin}>{val}</span>
					<button
						type="button"
						class="step-btn"
						disabled={!canInc}
						onclick={() => step(t.id, 1)}
					>
						+1
					</button>
					<button
						type="button"
						class="step-btn"
						disabled={!canInc}
						onclick={() => step(t.id, 5)}
					>
						+5
					</button>
				</div>
			</div>
		{/each}
	</div>

	<div class="alloc-actions">
		<button
			type="button"
			class="arena-main-btn"
			class:can-act={valid}
			disabled={!valid}
			onclick={() => valid && onConfirm({ ...allocState.allocations })}
		>
			{confirmLabel || `Confirm Distribution (${totalAllocated}/${allocState.amountToDistribute})`}
		</button>
		{#if cancellable && onCancel}
			<button type="button" class="hud-btn" onclick={() => onCancel()}>
				Cancel
			</button>
		{/if}
	</div>
</div>

<style>
	.alloc-widget {
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
	}
	.alloc-summary {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.45rem;
		padding: 0.45rem 0.65rem;
		background: var(--mp-bg, #19181a);
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 6px;
		font-size: 0.74rem;
	}
	.alloc-pool {
		display: flex;
		align-items: center;
		gap: 0.55rem;
	}
	.alloc-rem {
		padding: 0.1rem 0.45rem;
		border-radius: 999px;
		background: rgba(252, 152, 103, 0.18);
		color: var(--mp-orange, #fc9867);
		font-size: 0.66rem;
		font-weight: 700;
	}
	.alloc-rem.done {
		background: rgba(169, 220, 118, 0.18);
		color: var(--mp-green, #a9dc76);
	}
	.alloc-rule-hint {
		font-size: 0.66rem;
		color: var(--mp-text-muted, #939293);
	}
	.alloc-target-list {
		display: flex;
		flex-direction: column;
		gap: 0.42rem;
		max-height: 44vh;
		overflow-y: auto;
	}
	.alloc-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.6rem;
		padding: 0.42rem 0.6rem;
		background: var(--mp-bg, #19181a);
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 6px;
	}
	.alloc-row.below-min {
		border-color: var(--mp-red, #ff6188);
	}
	.alloc-target-info {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.alloc-thumb {
		width: 38px;
		height: 32px;
		object-fit: cover;
		border-radius: 4px;
		border: 1px solid var(--mp-border, #3e3a42);
		flex-shrink: 0;
	}
	.alloc-labels {
		display: flex;
		flex-direction: column;
		gap: 0.08rem;
		min-width: 0;
	}
	.alloc-name {
		font-size: 0.78rem;
		font-weight: 700;
		color: var(--mp-text, #fcfcfa);
	}
	.alloc-sub {
		font-size: 0.64rem;
		color: var(--mp-cyan, #78dce8);
	}
	.alloc-warn {
		font-size: 0.62rem;
		color: var(--mp-red, #ff6188);
		font-weight: 700;
	}
	.alloc-controls {
		display: flex;
		align-items: center;
		gap: 0.28rem;
		flex-shrink: 0;
	}
	.step-btn {
		background: var(--mp-bg-elevated, #221f22);
		color: var(--mp-text, #fcfcfa);
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 4px;
		padding: 0.24rem 0.45rem;
		font-family: inherit;
		font-size: 0.7rem;
		font-weight: 700;
		cursor: pointer;
	}
	.step-btn:hover:not(:disabled) {
		border-color: var(--mp-accent, #ffd866);
		color: var(--mp-accent, #ffd866);
	}
	.step-btn:disabled {
		opacity: 0.36;
		cursor: not-allowed;
	}
	.alloc-val {
		min-width: 2rem;
		text-align: center;
		font-size: 0.88rem;
		font-weight: 800;
		color: var(--mp-accent, #ffd866);
	}
	.alloc-val.invalid {
		color: var(--mp-red, #ff6188);
	}
	.alloc-actions {
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
		padding: 0.65rem 0.85rem;
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
	.arena-main-btn:disabled {
		opacity: 0.38;
		cursor: not-allowed;
	}
	.hud-btn {
		background: var(--mp-bg, #19181a);
		color: var(--mp-text, #fcfcfa);
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 6px;
		padding: 0.42rem 0.75rem;
		font-family: inherit;
		font-size: 0.76rem;
		font-weight: 600;
		cursor: pointer;
	}
</style>
