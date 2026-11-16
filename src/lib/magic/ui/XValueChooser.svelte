<script lang="ts">
	import {
		buildXQuickPresets,
		clampXChooserValue,
		computeXChooserSliderBounds,
		parseXChooserText
	} from './xChooserModel.ts';

	let {
		value,
		min = 0,
		max = null,
		suggestedMax = null,
		badgeLabel = 'X',
		rangeCaption = null,
		testIdPrefix,
		onChange,
		onSubmit
	}: {
		value: number;
		min?: number;
		max?: number | null;
		suggestedMax?: number | null;
		badgeLabel?: string;
		rangeCaption?: string | null;
		testIdPrefix?: string;
		onChange: (next: number) => void;
		onSubmit?: () => void;
	} = $props();

	const bounds = $derived(
		computeXChooserSliderBounds({
			value,
			min,
			max,
			suggestedMax
		})
	);

	const clampedValue = $derived(clampXChooserValue(value, bounds.min, bounds.max));
	const showJumpSteps = $derived(bounds.max === null || bounds.sliderMax - bounds.min > 6);
	const presets = $derived(
		buildXQuickPresets({
			min: bounds.min,
			max: bounds.max,
			suggestedMax
		})
	);

	let isEditingText = $state(false);
	let draftText = $state('');

	function testId(suffix: string): string | undefined {
		return testIdPrefix ? `${testIdPrefix}-${suffix}` : undefined;
	}

	function commitValue(rawNext: number) {
		const next = clampXChooserValue(rawNext, bounds.min, bounds.max);
		onChange(next);
		if (isEditingText) {
			draftText = String(next);
		}
	}

	function stepBy(delta: number) {
		commitValue(clampedValue + delta);
	}

	function handleTextFocus(e: FocusEvent & { currentTarget: HTMLInputElement }) {
		isEditingText = true;
		draftText = String(clampedValue);
		e.currentTarget.select();
	}

	function handleTextInput(e: Event & { currentTarget: HTMLInputElement }) {
		const raw = e.currentTarget.value;
		draftText = raw;
		const parsed = parseXChooserText(raw, bounds.min, bounds.max);
		if (parsed !== null) {
			onChange(parsed);
		}
	}

	function handleTextBlur() {
		const parsed = parseXChooserText(draftText, bounds.min, bounds.max);
		isEditingText = false;
		if (parsed !== null) {
			onChange(parsed);
		}
		draftText = String(clampedValue);
	}

	function handleTextKeydown(e: KeyboardEvent) {
		const step = e.shiftKey ? 5 : 1;
		if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
			e.preventDefault();
			stepBy(step);
		} else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
			e.preventDefault();
			stepBy(-step);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			handleTextBlur();
			onSubmit?.();
		}
	}

	const inputDisplayValue = $derived(isEditingText ? draftText : String(clampedValue));
	const canStepDown = $derived(clampedValue > bounds.min);
	const canStepUp = $derived(bounds.max === null || clampedValue < bounds.max);
</script>

<div class="x-chooser-shell">
	<div class="x-dial-row">
		{#if showJumpSteps}
			<button
				type="button"
				class="dial-step-btn jump"
				data-testid={testId('step-minus-5')}
				disabled={!canStepDown}
				aria-label="Decrease by 5"
				onclick={() => stepBy(-5)}
			>
				−5
			</button>
		{/if}
		<button
			type="button"
			class="dial-step-btn"
			data-testid={testId('step-minus-1')}
			disabled={!canStepDown}
			aria-label="Decrease by 1"
			onclick={() => stepBy(-1)}
		>
			−1
		</button>

		<div class="x-medallion" title="Click to type any integer, or drag the slider below">
			<span class="x-medallion-badge" aria-hidden="true">{badgeLabel}</span>
			<input
				type="text"
				inputmode="numeric"
				pattern="[0-9-]*"
				class="x-medallion-input"
				data-testid={testId('value-input')}
				aria-label="Chosen value"
				value={inputDisplayValue}
				onfocus={handleTextFocus}
				oninput={handleTextInput}
				onblur={handleTextBlur}
				onkeydown={handleTextKeydown}
			/>
		</div>

		<button
			type="button"
			class="dial-step-btn"
			data-testid={testId('step-plus-1')}
			disabled={!canStepUp}
			aria-label="Increase by 1"
			onclick={() => stepBy(1)}
		>
			+1
		</button>
		{#if showJumpSteps}
			<button
				type="button"
				class="dial-step-btn jump"
				data-testid={testId('step-plus-5')}
				disabled={!canStepUp}
				aria-label="Increase by 5"
				onclick={() => stepBy(5)}
			>
				+5
			</button>
		{/if}
	</div>

	<div class="x-slider-wrap">
		<div class="x-slider-labels">
			<span>{bounds.min}</span>
			{#if rangeCaption}
				<span class="x-range-caption">{rangeCaption}</span>
			{/if}
			<span>
				{#if bounds.max === null && suggestedMax !== null && suggestedMax !== undefined}
					Max {suggestedMax}
				{:else}
					{bounds.sliderMax}
				{/if}
			</span>
		</div>
		<input
			type="range"
			class="x-range-slider"
			aria-label="Slide to choose value"
			min={bounds.min}
			max={bounds.sliderMax}
			step="1"
			disabled={bounds.sliderMax <= bounds.min}
			value={clampedValue}
			style="--slider-pct: {bounds.percent}%;"
			oninput={(e) => {
				const parsed = Number.parseInt(e.currentTarget.value, 10);
				if (Number.isFinite(parsed)) commitValue(parsed);
			}}
		/>
	</div>

	<div class="x-preset-row" role="group" aria-label="Quick value presets">
		{#each presets as preset (preset.testIdSuffix + ':' + preset.value)}
			{@const overBudget =
				bounds.max === null &&
				suggestedMax !== null &&
				suggestedMax !== undefined &&
				preset.value > suggestedMax}
			<button
				type="button"
				class="preset-chip"
				class:active={clampedValue === preset.value}
				class:is-max={preset.kind === 'max'}
				class:over-budget={overBudget}
				data-testid={testId(`quick-${preset.testIdSuffix}`)}
				onclick={() => commitValue(preset.value)}
			>
				{preset.label}
			</button>
		{/each}
		{#if bounds.max === null && (suggestedMax === null || suggestedMax === undefined)}
			<button
				type="button"
				class="preset-chip is-max"
				data-testid={testId('quick-max')}
				disabled
			>
				Max (—)
			</button>
		{/if}
	</div>
</div>

<style>
	.x-chooser-shell {
		display: flex;
		flex-direction: column;
		gap: 0.72rem;
		padding: 0.78rem 0.82rem;
		background: radial-gradient(circle at 50% 18%, rgba(255, 216, 102, 0.08), rgba(18, 16, 22, 0.78));
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 10px;
	}
	.x-dial-row {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		flex-wrap: wrap;
	}
	.dial-step-btn {
		min-width: 2.55rem;
		height: 2.25rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0 0.5rem;
		border-radius: 7px;
		border: 1px solid var(--mp-border-strong, #524c58);
		background: var(--mp-bg, #19181a);
		color: var(--mp-text, #fcfcfa);
		font-family: inherit;
		font-size: 0.82rem;
		font-weight: 700;
		cursor: pointer;
		transition: border-color 0.14s ease, color 0.14s ease, background 0.14s ease, transform 0.1s ease;
	}
	.dial-step-btn.jump {
		font-size: 0.76rem;
		color: var(--mp-text-body, #d6d3dc);
	}
	.dial-step-btn:hover:not(:disabled) {
		border-color: var(--mp-accent, #ffd866);
		color: var(--mp-accent, #ffd866);
		background: rgba(255, 216, 102, 0.08);
	}
	.dial-step-btn:active:not(:disabled) {
		transform: translateY(1px);
	}
	.dial-step-btn:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}
	.x-medallion {
		position: relative;
		width: 4.55rem;
		height: 4.55rem;
		border-radius: 50%;
		background: radial-gradient(circle at 32% 28%, #ebe7ef 0%, #c8c2cd 58%, #9b95a2 100%);
		border: 2.5px solid #2b2730;
		box-shadow:
			0 0 0 2px rgba(255, 216, 102, 0.62),
			0 6px 18px rgba(0, 0, 0, 0.55),
			inset 0 2px 4px rgba(255, 255, 255, 0.65);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: box-shadow 0.15s ease, transform 0.12s ease;
	}
	.x-medallion:focus-within {
		box-shadow:
			0 0 0 2.5px var(--mp-accent, #ffd866),
			0 0 18px rgba(255, 216, 102, 0.42),
			inset 0 2px 4px rgba(255, 255, 255, 0.75);
		transform: scale(1.02);
	}
	.x-medallion-badge {
		position: absolute;
		top: -0.4rem;
		right: -0.35rem;
		min-width: 1.35rem;
		height: 1.35rem;
		padding: 0 0.28rem;
		border-radius: 999px;
		background: var(--mp-bg-elevated, #221f22);
		border: 1.5px solid var(--mp-accent, #ffd866);
		color: var(--mp-accent, #ffd866);
		font-size: 0.64rem;
		font-weight: 900;
		letter-spacing: 0.03em;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.55);
	}
	.x-medallion-input {
		width: 3.6rem;
		border: none;
		background: transparent;
		text-align: center;
		font-family: inherit;
		font-size: 1.65rem;
		font-weight: 900;
		color: #19181a;
		line-height: 1;
		padding: 0;
		outline: none;
		font-variant-numeric: tabular-nums;
	}
	.x-medallion-input::selection {
		background: rgba(255, 216, 102, 0.55);
		color: #19181a;
	}
	.x-slider-wrap {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding: 0 0.15rem;
	}
	.x-slider-labels {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: 0.68rem;
		font-weight: 600;
		color: var(--mp-text-muted, #939293);
		font-variant-numeric: tabular-nums;
	}
	.x-range-caption {
		color: var(--mp-cyan, #78dce8);
		font-weight: 700;
	}
	.x-range-slider {
		-webkit-appearance: none;
		appearance: none;
		width: 100%;
		height: 8px;
		border-radius: 999px;
		background: linear-gradient(
			to right,
			var(--mp-accent, #ffd866) 0%,
			var(--mp-accent, #ffd866) var(--slider-pct, 0%),
			rgba(255, 255, 255, 0.14) var(--slider-pct, 0%),
			rgba(255, 255, 255, 0.14) 100%
		);
		outline: none;
		cursor: pointer;
	}
	.x-range-slider:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.x-range-slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--mp-accent, #ffd866);
		border: 2.5px solid #19181a;
		box-shadow: 0 0 8px rgba(255, 216, 102, 0.55);
		cursor: grab;
	}
	.x-range-slider::-moz-range-thumb {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--mp-accent, #ffd866);
		border: 2.5px solid #19181a;
		box-shadow: 0 0 8px rgba(255, 216, 102, 0.55);
		cursor: grab;
	}
	.x-preset-row {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.38rem;
		flex-wrap: wrap;
	}
	.preset-chip {
		min-width: 2.15rem;
		padding: 0.28rem 0.58rem;
		border-radius: 999px;
		border: 1px solid var(--mp-border-strong, #524c58);
		background: var(--mp-bg, #19181a);
		color: var(--mp-text, #fcfcfa);
		font-family: inherit;
		font-size: 0.74rem;
		font-weight: 700;
		cursor: pointer;
		transition: all 0.13s ease;
		font-variant-numeric: tabular-nums;
	}
	.preset-chip:hover:not(:disabled) {
		border-color: var(--mp-accent, #ffd866);
		color: var(--mp-accent, #ffd866);
	}
	.preset-chip.active {
		background: rgba(255, 216, 102, 0.18);
		border-color: var(--mp-accent, #ffd866);
		color: var(--mp-accent, #ffd866);
		box-shadow: 0 0 10px rgba(255, 216, 102, 0.2);
	}
	.preset-chip.is-max:not(.active) {
		border-color: rgba(120, 220, 232, 0.45);
		color: var(--mp-cyan, #78dce8);
	}
	.preset-chip.over-budget:not(.active) {
		opacity: 0.58;
	}
	.preset-chip:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
</style>
