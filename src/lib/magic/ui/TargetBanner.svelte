<script lang="ts">
	import {
		canConfirmCurrentSlot,
		canSkipOptionalSlot,
		describeCurrentTargetSlot,
		type TargetingSession
	} from './targetingController.ts';

	let {
		session,
		zoneDrawerOpen = false,
		onConfirmSlot,
		onSkipOptionalSlot,
		onBackSlot,
		onCancel,
		onOpenZoneDrawer
	}: {
		session: TargetingSession;
		zoneDrawerOpen?: boolean;
		onConfirmSlot: () => void | Promise<void>;
		onSkipOptionalSlot?: () => void | Promise<void>;
		onBackSlot?: () => void | Promise<void>;
		onCancel: () => void;
		onOpenZoneDrawer?: (zone: 'graveyard' | 'exile') => void;
	} = $props();

	const slotNumber = $derived(session.slotIndex + 1);
	const req = $derived(session.currentRequirement);
	const selectedCount = $derived(session.selectedTargets.length);
	const canSkip = $derived(canSkipOptionalSlot(session));
	const canConfirm = $derived(canConfirmCurrentSlot(session));
	const slotPrompt = $derived(describeCurrentTargetSlot(session));
	const isDividing = $derived(Boolean(session.awaitingDivision));
	const canStepBack = $derived(session.slotIndex > 0 || isDividing);
	const showConfirmBtn = $derived(
		!isDividing && (req.maxTargets > 1 || req.minTargets === 0) && !canSkip
	);
	const targetableHiddenZone = $derived<'graveyard' | 'exile' | null>(
		req.zone === 'graveyard' || req.targetKind === 'graveyard_card'
			? 'graveyard'
			: req.zone === 'exile' || req.targetKind === 'exile_card'
				? 'exile'
				: null
	);
</script>

<div class="targeting-banner target-banner" role="region" aria-label="Target Selection">
	<div class="targeting-banner-info">
		{#if session.totalSlots > 1}
			<span class="slot-pill" data-testid="targeting-slot-pill">
				Slot {slotNumber} of {session.totalSlots}
			</span>
		{/if}
		<span class="slot-prompt">
			{slotPrompt} for <strong>{session.card.name}</strong>
		</span>
		{#if req.maxTargets > 1}
			<span class="count-pill">
				{selectedCount}/{req.maxTargets}
			</span>
		{/if}
		<span class="cancel-hint">[Esc / Right-Click]</span>
	</div>

	<div class="target-banner-actions">
		{#if targetableHiddenZone && !zoneDrawerOpen && onOpenZoneDrawer}
			<button
				type="button"
				class="hud-btn active-ctrl"
				onclick={() => onOpenZoneDrawer(targetableHiddenZone)}
			>
				{targetableHiddenZone === 'exile' ? 'Open Exile' : 'Open Graveyards'}
			</button>
		{/if}
		{#if canStepBack && onBackSlot}
			<button
				type="button"
				class="hud-btn"
				data-testid="target-back-slot-btn"
				onclick={onBackSlot}
			>
				{isDividing ? '← Edit Targets' : '← Back to Previous Slot'}
			</button>
		{/if}
		{#if canSkip}
			<button
				type="button"
				class="hud-btn active-ctrl"
				data-testid="skip-optional-target-btn"
				onclick={() => (onSkipOptionalSlot ? onSkipOptionalSlot() : onConfirmSlot())}
			>
				Skip Optional Target
			</button>
		{/if}
		{#if showConfirmBtn}
			<button
				type="button"
				class="hud-btn"
				class:active-ctrl={canConfirm}
				data-testid="confirm-targets-btn"
				disabled={!canConfirm}
				onclick={onConfirmSlot}
			>
				Confirm {selectedCount > 0 ? `${selectedCount} ` : ''}Target(s)
			</button>
		{/if}
		<button
			type="button"
			class="hud-btn danger"
			data-testid="cancel-targeting-btn"
			onclick={onCancel}
		>
			Cancel (Esc / Right-Click)
		</button>
	</div>
</div>

<style>
	.targeting-banner {
		background: var(--mp-bg-subtle);
		border-bottom: 1.5px solid var(--mp-accent);
		color: var(--mp-accent);
		padding: 0.42rem 1rem;
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.75rem 1rem;
		font-size: 0.8rem;
		z-index: 165;
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
	}
	.targeting-banner-info {
		display: inline-flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.slot-pill {
		display: inline-flex;
		align-items: center;
		padding: 0.14rem 0.5rem;
		border-radius: 999px;
		background: rgba(255, 216, 102, 0.16);
		border: 1px solid var(--mp-accent);
		color: var(--mp-accent);
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.03em;
	}
	.slot-prompt {
		color: var(--mp-text);
	}
	.slot-prompt strong {
		color: var(--mp-accent);
	}
	.count-pill {
		display: inline-flex;
		align-items: center;
		padding: 0.1rem 0.42rem;
		border-radius: 4px;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border-strong);
		color: var(--mp-cyan);
		font-size: 0.72rem;
		font-weight: 700;
	}
	.cancel-hint {
		font-size: 0.7rem;
		color: var(--mp-text-muted);
	}
	.target-banner-actions {
		display: inline-flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.45rem;
	}
	.hud-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.32rem;
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 4px;
		padding: 0.26rem 0.58rem;
		font-size: 0.72rem;
		font-family: inherit;
		cursor: pointer;
	}
	.hud-btn:hover:not(:disabled) {
		border-color: var(--mp-accent);
		color: var(--mp-accent);
	}
	.hud-btn.active-ctrl {
		border-color: var(--mp-accent);
		color: var(--mp-accent);
		font-weight: 700;
	}
	.hud-btn.danger:hover:not(:disabled) {
		border-color: var(--mp-red);
		color: var(--mp-red);
	}
	.hud-btn:disabled {
		opacity: 0.42;
		cursor: not-allowed;
	}
</style>
