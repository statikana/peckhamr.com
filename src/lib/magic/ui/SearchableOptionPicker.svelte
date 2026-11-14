<script lang="ts">
	import { filterStringOptions } from './promptViewModel.ts';

	let {
		options,
		initialValue = '',
		limit = 60,
		placeholder = 'Type to search options...',
		confirmLabel = 'Confirm Choice',
		cancellable = false,
		singleClickConfirm = false,
		onConfirm,
		onCancel
	}: {
		options: readonly string[];
		initialValue?: string;
		limit?: number;
		placeholder?: string;
		confirmLabel?: string;
		cancellable?: boolean;
		singleClickConfirm?: boolean;
		onConfirm: (chosen: string) => void | Promise<void>;
		onCancel?: () => void | Promise<void>;
	} = $props();

	let query = $state('');
	let selectedOption = $state<string>('');
	let highlightIndex = $state(0);

	$effect(() => {
		if (!selectedOption && initialValue && options.includes(initialValue)) {
			selectedOption = initialValue;
		}
	});

	const filtered = $derived(filterStringOptions(options, query, limit));
	const canSubmit = $derived(selectedOption.length > 0 && options.includes(selectedOption));

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (filtered.length > 0) {
				highlightIndex = Math.min(filtered.length - 1, highlightIndex + 1);
				selectedOption = filtered[highlightIndex];
			}
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (filtered.length > 0) {
				highlightIndex = Math.max(0, highlightIndex - 1);
				selectedOption = filtered[highlightIndex];
			}
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const pick = selectedOption || filtered[highlightIndex] || filtered[0];
			if (pick && options.includes(pick)) {
				selectedOption = pick;
				onConfirm(pick);
			}
		} else if ((e.keyCode === 27 || e.key === 'Esc' + 'ape') && cancellable && onCancel) {
			e.preventDefault();
			onCancel();
		}
	}

	function selectItem(opt: string, idx: number) {
		selectedOption = opt;
		highlightIndex = idx;
		if (singleClickConfirm) {
			onConfirm(opt);
		}
	}
</script>

<div class="option-picker">
	<div class="picker-head">
		<input
			type="search"
			class="picker-search"
			bind:value={query}
			{placeholder}
			oninput={() => (highlightIndex = 0)}
			onkeydown={handleKeydown}
		/>
		<span class="picker-count">
			Showing {filtered.length} of {options.length}
		</span>
	</div>

	{#if filtered.length === 0}
		<div class="picker-empty">No matching options for "{query}".</div>
	{:else}
		<div class="picker-grid" role="listbox" aria-label="Available options">
			{#each filtered as opt, idx (opt)}
				{@const isSelected = selectedOption === opt}
				<button
					type="button"
					role="option"
					aria-selected={isSelected}
					class="picker-item"
					class:selected={isSelected}
					class:highlighted={highlightIndex === idx && !isSelected}
					onclick={() => selectItem(opt, idx)}
				>
					{opt}
				</button>
			{/each}
		</div>
	{/if}

	<div class="picker-actions">
		{#if !singleClickConfirm}
			<button
				type="button"
				class="arena-main-btn"
				class:can-act={canSubmit}
				disabled={!canSubmit}
				onclick={() => canSubmit && onConfirm(selectedOption)}
			>
				{selectedOption ? `${confirmLabel}: ${selectedOption}` : confirmLabel}
			</button>
		{/if}
		{#if cancellable && onCancel}
			<button type="button" class="hud-btn" onclick={() => onCancel()}>
				Cancel
			</button>
		{/if}
	</div>
</div>

<style>
	.option-picker {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.picker-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.picker-search {
		flex: 1 1 220px;
		background: var(--mp-bg, #19181a);
		color: var(--mp-text, #fcfcfa);
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 6px;
		padding: 0.42rem 0.65rem;
		font-family: inherit;
		font-size: 0.78rem;
	}
	.picker-search:focus {
		outline: none;
		border-color: var(--mp-accent, #ffd866);
	}
	.picker-count {
		font-size: 0.68rem;
		color: var(--mp-text-muted, #939293);
	}
	.picker-empty {
		padding: 0.85rem;
		text-align: center;
		font-size: 0.76rem;
		color: var(--mp-text-muted, #939293);
		background: var(--mp-bg, #19181a);
		border: 1px dashed var(--mp-border, #3e3a42);
		border-radius: 6px;
	}
	.picker-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(135px, 1fr));
		gap: 0.4rem;
		max-height: 40vh;
		overflow-y: auto;
		padding: 0.25rem;
	}
	.picker-item {
		background: var(--mp-bg, #19181a);
		color: var(--mp-text, #fcfcfa);
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 6px;
		padding: 0.42rem 0.55rem;
		font-family: inherit;
		font-size: 0.74rem;
		font-weight: 600;
		text-align: left;
		cursor: pointer;
	}
	.picker-item:hover,
	.picker-item.highlighted {
		border-color: var(--mp-cyan, #78dce8);
	}
	.picker-item.selected {
		background: rgba(255, 216, 102, 0.16);
		border-color: var(--mp-accent, #ffd866);
		color: var(--mp-accent, #ffd866);
	}
	.picker-actions {
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
