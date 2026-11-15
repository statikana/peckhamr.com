<script lang="ts">
	import {
		applyCastCostAids,
		checkSpellCastLegality,
		checkTurnFaceUpLegality,
		formatManaRequirement,
		getCastOptions,
		getSpellOptionCostRequirement
	} from '../engine.ts';
	import ManaText from '../ManaText.svelte';
	import { effectiveCardForObject } from '../scryfall.ts';
	import type {
		CardInstance,
		CastOption,
		GameState,
		ManaColor,
		PlayerGameState
	} from '../types.ts';
	import { computeMaxAffordableX, type CastableZone } from './targetingController.ts';

	const QUICK_PICKS = [0, 1, 2, 3, 5] as const;

	let {
		gameState,
		actor,
		inst,
		fromZone,
		actionKind = 'cast_spell',
		castOption,
		optionalCostCounts,
		costAidIds,
		costAidColorChoices,
		initialX,
		maxAffordableX,
		onConfirm,
		onCancel
	}: {
		gameState: GameState;
		actor: PlayerGameState;
		inst: CardInstance;
		fromZone: CastableZone | 'battlefield';
		actionKind?: 'cast_spell' | 'turn_face_up';
		castOption?: CastOption;
		optionalCostCounts?: Record<string, number>;
		costAidIds?: Record<string, string[]>;
		costAidColorChoices?: Record<string, ManaColor | 'generic'>;
		initialX?: number;
		maxAffordableX?: number;
		onConfirm: (xValue: number) => void | Promise<void>;
		onCancel: () => void;
	} = $props();

	const effectiveMaxX = $derived(
		maxAffordableX !== undefined
			? Math.max(0, Math.floor(maxAffordableX))
			: computeMaxAffordableX({
					gameState,
					actorId: actor.playerId,
					inst,
					fromZone,
					actionKind,
					castOption,
					optionalCostCounts,
					costAidIds,
					costAidColorChoices
				})
	);

	const selectedAidTotal = $derived(
		costAidIds ? Object.values(costAidIds).reduce((sum, list) => sum + list.length, 0) : 0
	);

	let lastSessionKey = '';
	let xValue = $state(1);
	let minimized = $state(false);

	$effect.pre(() => {
		const nextKey = `${inst.instanceId}:${actionKind}:${castOption?.id ?? ''}:${fromZone}`;
		if (nextKey !== lastSessionKey) {
			lastSessionKey = nextKey;
			if (initialX !== undefined) {
				xValue = Math.max(0, Math.floor(initialX));
			} else if (selectedAidTotal > 0) {
				xValue = Math.max(selectedAidTotal, Math.min(2, effectiveMaxX ?? 0));
			} else {
				xValue = (effectiveMaxX ?? 0) >= 1 ? 1 : 0;
			}
			minimized = false;
		}
	});

	const effCard = $derived(effectiveCardForObject(inst));
	const cardTitle = $derived(
		inst.isFaceDown &&
			inst.controllerId !== actor.playerId &&
			inst.ownerId !== actor.playerId &&
			!inst.faceDownSpec?.knownToPlayerIds?.includes(actor.playerId)
			? inst.faceDownLabel || 'Face-Down Permanent'
			: effCard.name
	);

	const resolvedOption = $derived.by<CastOption | undefined>(() => {
		if (actionKind === 'turn_face_up') return undefined;
		if (castOption) return castOption;
		const opts = getCastOptions(gameState, actor.playerId, inst, fromZone);
		return opts.find((o) => o.id === 'printed') ?? opts[0];
	});

	const costPreviewText = $derived.by<string | null>(() => {
		if (actionKind === 'turn_face_up' || !resolvedOption) return null;
		const req = getSpellOptionCostRequirement(
			gameState,
			actor.playerId,
			inst,
			resolvedOption,
			xValue,
			optionalCostCounts
		);
		if (!req) return null;
		if (costAidIds && Object.keys(costAidIds).length > 0) {
			const applied = applyCastCostAids(req, resolvedOption, costAidIds, costAidColorChoices);
			if (applied.ok) {
				return formatManaRequirement(applied.remainingReq, false);
			}
		}
		return formatManaRequirement(req, false);
	});

	const legality = $derived.by<{ ok: boolean; error?: string }>(() => {
		if (xValue < 0 || !Number.isFinite(xValue)) {
			return { ok: false, error: 'X must be 0 or greater.' };
		}
		if (actionKind === 'turn_face_up') {
			return checkTurnFaceUpLegality(gameState, actor.playerId, inst, xValue);
		}
		const hasStrictAids = Boolean(costAidIds && Object.keys(costAidIds).length > 0);
		return checkSpellCastLegality(
			gameState,
			actor.playerId,
			inst,
			fromZone,
			xValue,
			resolvedOption?.id,
			optionalCostCounts,
			resolvedOption?.faceIndex,
			resolvedOption?.fused,
			costAidIds,
			costAidColorChoices,
			hasStrictAids
		);
	});

	function setClampedX(next: number) {
		if (!Number.isFinite(next)) return;
		xValue = Math.max(0, Math.floor(next));
	}

	function stepX(delta: number) {
		setClampedX(xValue + delta);
	}
</script>

{#if minimized}
	<div class="modal-peek-bar" data-testid="x-cost-peek-bar" role="region" aria-label="Minimized X Selector">
		<span class="peek-title">
			Choose X ({xValue}) — <strong>{cardTitle}</strong>
		</span>
		<div class="peek-actions">
			<button
				type="button"
				class="hud-btn active-ctrl"
				data-testid="restore-modal-btn"
				onclick={() => (minimized = false)}
			>
				👁 Return to X Selector
			</button>
			<button type="button" class="hud-btn danger" onclick={onCancel}>
				Cancel
			</button>
		</div>
	</div>
{:else}
	<div class="modal-backdrop">
		<div class="arena-modal" role="dialog" aria-modal="true" aria-label="Choose Value for X">
			<div class="modal-head-row">
				<h3>Choose Value for X — {cardTitle}</h3>
				<button
					type="button"
					class="hud-btn peek-btn"
					data-testid="peek-battlefield-btn"
					onclick={() => (minimized = true)}
				>
					👁 Peek Battlefield
				</button>
			</div>

			<div class="x-hint-row">
				<span class="max-hint" data-testid="x-max-affordable-hint">
					Max affordable X: <strong>{effectiveMaxX !== null ? effectiveMaxX : 'None'}</strong>
				</span>
				{#if costPreviewText}
					<span class="cost-preview">
						Total mana: <ManaText text={costPreviewText} size={14} />
					</span>
				{/if}
			</div>

			<div class="x-stepper-row">
				<button
					type="button"
					class="hud-btn step-btn"
					data-testid="x-step-minus-5"
					disabled={xValue <= 0}
					onclick={() => stepX(-5)}
				>
					−5
				</button>
				<button
					type="button"
					class="hud-btn step-btn"
					data-testid="x-step-minus-1"
					disabled={xValue <= 0}
					onclick={() => stepX(-1)}
				>
					−1
				</button>
				<input
					type="number"
					class="x-number-input"
					data-testid="x-value-input"
					min="0"
					step="1"
					value={xValue}
					oninput={(e) => {
						const parsed = parseInt(e.currentTarget.value, 10);
						setClampedX(Number.isNaN(parsed) ? 0 : parsed);
					}}
				/>
				<button
					type="button"
					class="hud-btn step-btn"
					data-testid="x-step-plus-1"
					onclick={() => stepX(1)}
				>
					+1
				</button>
				<button
					type="button"
					class="hud-btn step-btn"
					data-testid="x-step-plus-5"
					onclick={() => stepX(5)}
				>
					+5
				</button>
			</div>

			<div class="x-quick-picks" role="group" aria-label="Quick X presets">
				{#each QUICK_PICKS as preset (preset)}
					<button
						type="button"
						class="hud-btn pill-btn"
						class:active-ctrl={xValue === preset}
						data-testid="x-quick-{preset}"
						onclick={() => setClampedX(preset)}
					>
						{preset}
					</button>
				{/each}
				<button
					type="button"
					class="hud-btn pill-btn"
					class:active-ctrl={effectiveMaxX !== null && xValue === effectiveMaxX}
					data-testid="x-quick-max"
					disabled={effectiveMaxX === null}
					onclick={() => {
						if (effectiveMaxX !== null) setClampedX(effectiveMaxX);
					}}
				>
					Max ({effectiveMaxX !== null ? effectiveMaxX : '—'})
				</button>
			</div>

			{#if !legality.ok && legality.error}
				<div class="x-legality-error" data-testid="x-legality-error">
					{legality.error}
				</div>
			{/if}

			<div class="modal-actions">
				<button
					type="button"
					class="arena-main-btn"
					class:can-act={legality.ok}
					data-testid="confirm-x-btn"
					disabled={!legality.ok}
					title={legality.ok ? undefined : legality.error}
					onclick={() => onConfirm(xValue)}
				>
					{actionKind === 'turn_face_up' ? 'Turn Face Up' : 'Cast'} with X = {xValue}
				</button>
				<button type="button" class="hud-btn" onclick={onCancel}>
					Cancel
				</button>
			</div>
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
	}
	.arena-modal {
		background: var(--mp-bg-elevated);
		border: 1.5px solid var(--mp-accent);
		border-radius: 10px;
		padding: 1.15rem;
		max-width: 480px;
		width: 100%;
		max-height: 86vh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.65);
	}
	.modal-head-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.65rem;
		flex-wrap: wrap;
	}
	.arena-modal h3 {
		margin: 0;
		color: var(--mp-accent);
	}
	.x-hint-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
		font-size: 0.82rem;
		color: var(--mp-text-body);
	}
	.max-hint strong {
		color: var(--mp-cyan);
	}
	.cost-preview {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	.x-stepper-row {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
	}
	.x-number-input {
		width: 5.5rem;
		text-align: center;
		font-size: 1.1rem;
		font-weight: 700;
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1.5px solid var(--mp-border-strong);
		border-radius: 6px;
		padding: 0.38rem 0.5rem;
		font-family: inherit;
	}
	.x-number-input:focus {
		outline: none;
		border-color: var(--mp-accent);
	}
	.step-btn {
		min-width: 2.5rem;
		justify-content: center;
		font-weight: 700;
	}
	.x-quick-picks {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		flex-wrap: wrap;
	}
	.pill-btn {
		border-radius: 999px;
		padding: 0.22rem 0.68rem;
	}
	.x-legality-error {
		font-size: 0.78rem;
		color: #fca5a5;
		text-align: center;
	}
	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.modal-peek-bar {
		position: fixed;
		top: 0.65rem;
		left: 50%;
		transform: translateX(-50%);
		z-index: 205;
		display: flex;
		align-items: center;
		gap: 0.85rem;
		padding: 0.45rem 0.9rem;
		background: var(--mp-bg-elevated);
		border: 1.5px solid var(--mp-accent);
		border-radius: 999px;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
		font-size: 0.8rem;
		color: var(--mp-text);
	}
	.peek-title strong {
		color: var(--mp-accent);
	}
	.peek-actions {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
	}
	.arena-main-btn {
		background: var(--mp-bg-subtle);
		color: var(--mp-text-muted);
		border: 2px solid var(--mp-border-strong);
		border-radius: 8px;
		padding: 0.65rem 0.8rem;
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
	.arena-main-btn:disabled {
		background: var(--mp-bg-subtle);
		color: var(--mp-text-faint, var(--mp-text-muted));
		border-color: var(--mp-border);
		opacity: 0.36;
		cursor: not-allowed;
	}
	.hud-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 4px;
		padding: 0.3rem 0.6rem;
		font-size: 0.76rem;
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
