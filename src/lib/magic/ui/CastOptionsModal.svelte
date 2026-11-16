<script module lang="ts">
	import type {
		CardInstance,
		CastOption,
		EffectiveActivatedAbility,
		LandPlayOption,
		ManaColor
	} from '../types.ts';
	import type { CastableZone } from './targetingController.ts';

	export interface CastOptionSelection {
		inst: CardInstance;
		fromZone: CastableZone;
		option: CastOption;
		optionalCostCounts?: Record<string, number>;
		costAidIds?: Record<string, string[]>;
		costAidColorChoices?: Record<string, ManaColor | 'generic'>;
	}

	export interface HoveredCastOptionContext {
		option: CastOption;
		optionalCostCounts?: Record<string, number>;
		costAidIds?: Record<string, string[]>;
		costAidColorChoices?: Record<string, ManaColor | 'generic'>;
	}
</script>

<script lang="ts">
	import { cardAbilityDisplayText } from '../compiler/support.ts';
	import {
		applyCastCostAids,
		checkSpellCastLegality,
		formatManaRequirement,
		getSpellOptionCostRequirement
	} from '../engine.ts';
	import ManaText from '../ManaText.svelte';
	import { effectiveCardForObject, getCardFaces } from '../scryfall.ts';
	import type { CastCostAid, GameState, PlayerGameState } from '../types.ts';
	import { buildBoardViewModel, formatCommanderTaxDisplay } from './boardViewModel.ts';
	import { optionChoosesX } from './targetingController.ts';

	let {
		gameState,
		actor,
		inst,
		fromZone,
		options,
		landOptions = [],
		zoneAbilities = [],
		initialOptionalCounts,
		initialSelectedAidIds,
		initialAidColorChoices,
		onSelectOption,
		onPlayLand,
		onActivateAbility,
		onHoverOption,
		onHoverOptionContext,
		onCancel
	}: {
		gameState: GameState;
		actor: PlayerGameState;
		inst: CardInstance;
		fromZone: CastableZone;
		options: CastOption[];
		landOptions?: LandPlayOption[];
		zoneAbilities?: EffectiveActivatedAbility[];
		initialOptionalCounts?: Record<string, number>;
		initialSelectedAidIds?: Record<string, string[]>;
		initialAidColorChoices?: Record<string, ManaColor | 'generic'>;
		onSelectOption: (selection: CastOptionSelection) => void | Promise<void>;
		onPlayLand?: (
			inst: CardInstance,
			fromZone: 'hand' | 'exile',
			faceIndex?: number
		) => void | Promise<void>;
		onActivateAbility?: (
			inst: CardInstance,
			ability: EffectiveActivatedAbility
		) => void | Promise<void>;
		onHoverOption?: (option: CastOption | null) => void;
		onHoverOptionContext?: (ctx: HoveredCastOptionContext | null) => void;
		onCancel: () => void;
	} = $props();

	let lastInstId = '';
	let optionalCounts = $state<Record<string, number>>({});
	let selectedAidIds = $state<Record<string, string[]>>({});
	let aidColorChoices = $state<Record<string, ManaColor | 'generic'>>({});
	let minimized = $state(false);

	$effect.pre(() => {
		const nextId = inst.instanceId;
		if (nextId !== lastInstId) {
			lastInstId = nextId;
			optionalCounts = initialOptionalCounts ? { ...initialOptionalCounts } : {};
			selectedAidIds = initialSelectedAidIds ? { ...initialSelectedAidIds } : {};
			aidColorChoices = initialAidColorChoices ? { ...initialAidColorChoices } : {};
			minimized = false;
		}
	});

	const effCard = $derived(effectiveCardForObject(inst));
	const faces = $derived(getCardFaces(effCard));
	const fullDisplayText = $derived(cardAbilityDisplayText(effCard));
	const faceDisplayTexts = $derived(fullDisplayText.split(/\n\s*\/\/\s*\n/));

	const actorStatus = $derived(
		buildBoardViewModel(gameState, actor.playerId).playerStatusesById[actor.playerId] ?? null
	);
	const commanderTaxDisplay = $derived(
		fromZone === 'command' && inst.isCommander
			? formatCommanderTaxDisplay(
					gameState,
					actor,
					inst,
					actorStatus?.commanderTaxAsLifePerCast ?? null
				)
			: null
	);

	const modalOptionalCosts = $derived(
		Array.from(
			new Map(
				options
					.flatMap((o) => o.optionalAdditionalCosts ?? [])
					.map((oc) => [oc.id, oc] as const)
			).values()
		)
	);

	const modalPaymentAids = $derived(
		Array.from(
			new Map(
				options.flatMap((o) => o.paymentAids ?? []).map((aid) => [aid.id, aid] as const)
			).values()
		)
	);

	function clearHover() {
		onHoverOption?.(null);
		onHoverOptionContext?.(null);
	}

	function handleCancel() {
		clearHover();
		onCancel();
	}

	function aidCandidateLabel(kind: CastCostAid['kind'], candidateId: string): string {
		const cardInst =
			kind === 'tapPermanent'
				? actor.battlefield.find((c) => c.instanceId === candidateId)
				: actor.graveyard.find((c) => c.instanceId === candidateId);
		return cardInst ? effectiveCardForObject(cardInst).name : candidateId;
	}

	function toggleCastAidCandidate(aidId: string, candidateId: string) {
		const currentList = selectedAidIds[aidId] ?? [];
		const nextAidIds = { ...selectedAidIds };
		const nextColors = { ...aidColorChoices };
		if (currentList.includes(candidateId)) {
			const filtered = currentList.filter((id) => id !== candidateId);
			if (filtered.length > 0) nextAidIds[aidId] = filtered;
			else delete nextAidIds[aidId];
			delete nextColors[candidateId];
		} else {
			nextAidIds[aidId] = [...currentList, candidateId];
		}
		selectedAidIds = nextAidIds;
		aidColorChoices = nextColors;
	}

	function setCastAidColorChoice(candidateId: string, rawChoice: string) {
		const nextColors = { ...aidColorChoices };
		if (!rawChoice) delete nextColors[candidateId];
		else nextColors[candidateId] = rawChoice as ManaColor | 'generic';
		aidColorChoices = nextColors;
	}

	function buildOptionFilters(opt: CastOption) {
		const optCounts = Object.fromEntries(
			Object.entries(optionalCounts).filter(
				([id, v]) => v > 0 && opt.optionalAdditionalCosts?.some((c) => c.id === id)
			)
		);
		const optAidIds = Object.fromEntries(
			Object.entries(selectedAidIds).filter(
				([aidId, ids]) => ids.length > 0 && opt.paymentAids?.some((a) => a.id === aidId)
			)
		);
		const optSelectedSet = new Set(Object.values(optAidIds).flat());
		const optAidColors = Object.fromEntries(
			Object.entries(aidColorChoices).filter(([id]) => optSelectedSet.has(id))
		);
		return {
			optCounts,
			optAidIds,
			optAidColors,
			selectedAidTotal: Object.values(optAidIds).reduce((s, ids) => s + ids.length, 0)
		};
	}

	function enterOptionHover(opt: CastOption) {
		const { optCounts, optAidIds, optAidColors } = buildOptionFilters(opt);
		onHoverOption?.(opt);
		onHoverOptionContext?.({
			option: opt,
			...(Object.keys(optCounts).length > 0 ? { optionalCostCounts: optCounts } : {}),
			...(Object.keys(optAidIds).length > 0 ? { costAidIds: optAidIds } : {}),
			...(Object.keys(optAidColors).length > 0 ? { costAidColorChoices: optAidColors } : {})
		});
	}
</script>

{#if minimized}
	<div class="modal-peek-bar" data-testid="cast-options-peek-bar" role="region" aria-label="Minimized Cast Options">
		<span class="peek-title">
			Casting <strong>{effCard.name}</strong>
		</span>
		<div class="peek-actions">
			<button
				type="button"
				class="hud-btn active-ctrl"
				data-testid="restore-modal-btn"
				onclick={() => (minimized = false)}
			>
				👁 Return to Cast Options
			</button>
			<button type="button" class="hud-btn danger" onclick={handleCancel}>
				Cancel
			</button>
		</div>
	</div>
{:else}
	<div class="modal-backdrop">
		<div class="arena-modal" role="dialog" aria-modal="true" aria-label="Cast Options for {effCard.name}">
			<div class="modal-head-row">
				<h3>
					{zoneAbilities.length > 0 || landOptions.length > 0
						? 'Choose Action'
						: 'Choose How to Cast'} — {effCard.name}
				</h3>
				<button
					type="button"
					class="hud-btn peek-btn"
					data-testid="peek-battlefield-btn"
					onclick={() => {
						clearHover();
						minimized = true;
					}}
				>
					👁 Peek Battlefield
				</button>
			</div>

			<div class="modal-desc">
				{#if faces.length >= 2}
					<div class="face-list">
						{#each faces as face, fi (fi)}
							{@const faceText = faceDisplayTexts[fi] ?? (fi === 0 ? fullDisplayText : '')}
							<div class="face-summary">
								<div class="face-header">
									<strong>{face.name}</strong>
									{#if face.manaCost}<ManaText text={face.manaCost} size={14} />{/if}
								</div>
								<div class="face-typeline">{face.typeLine}</div>
								{#if faceText}
									<ManaText text={faceText} size={14} />
								{/if}
							</div>
						{/each}
					</div>
				{:else if fullDisplayText}
					<ManaText text={fullDisplayText} size={15} />
				{/if}
			</div>

			{#if commanderTaxDisplay}
				<div
					class="commander-tax-banner"
					class:life-tax={commanderTaxDisplay.isLifeTax}
					data-testid="cast-modal-commander-tax"
				>
					{#if commanderTaxDisplay.isLifeTax}
						<span>🩸 Commander Tax (CR 903.8): <strong>{commanderTaxDisplay.badgeText}</strong></span>
					{:else}
						<span>
							Commander Tax (CR 903.8):
							<ManaText text={`Tax: +{${commanderTaxDisplay.manaIncrement}}`} size={14} />
						</span>
					{/if}
				</div>
			{/if}

			{#if modalOptionalCosts.length > 0}
				<div class="optional-cost-section">
					{#each modalOptionalCosts as oc (oc.id)}
						{@const count = optionalCounts[oc.id] ?? 0}
						{@const isDefilerPipLife = oc.id.startsWith('defiler:')}
						{#if oc.maxCount === 1}
							<label
								class="optional-cost-check"
								class:defiler-pip-life={isDefilerPipLife}
								data-testid={isDefilerPipLife ? `defiler-optional-cost-${oc.id}` : undefined}
							>
								<input
									type="checkbox"
									checked={count > 0}
									onchange={(e) => {
										const nextCount = e.currentTarget.checked ? 1 : 0;
										optionalCounts = { ...optionalCounts, [oc.id]: nextCount };
									}}
								/>
								<span>
									{#if isDefilerPipLife}
										<span class="pip-life-pill">🩸 Pip → Life</span>
										<ManaText text={oc.label} size={14} />
									{:else}
										Pay optional cost: <ManaText text={oc.costDisplay} size={14} />
									{/if}
									{#if oc.enablesTarget}<small> (enables additional target)</small>{/if}
									{#if oc.chooseAllModes}<small> (chooses all modes)</small>{/if}
								</span>
							</label>
						{:else}
							<div
								class="optional-cost-stepper-row"
								class:defiler-pip-life={isDefilerPipLife}
								data-testid={isDefilerPipLife ? `defiler-optional-cost-${oc.id}` : undefined}
							>
								<span>
									{#if isDefilerPipLife}
										<span class="pip-life-pill">🩸 Pip → Life</span>
										<ManaText text={oc.label} size={14} />
									{:else}
										Optional cost (<ManaText text={oc.costDisplay} size={14} /> each)
									{/if}
									{#if oc.enablesTarget}<small> (enables additional target)</small>{/if}
									{#if oc.chooseAllModes}<small> (chooses all modes)</small>{/if}
								</span>
								<div class="stepper-controls">
									<button
										type="button"
										class="hud-btn"
										disabled={count <= 0}
										onclick={() => {
											optionalCounts = {
												...optionalCounts,
												[oc.id]: Math.max(0, count - 1)
											};
										}}
									>
										−
									</button>
									<span class="stepper-count">{count}</span>
									<button
										type="button"
										class="hud-btn"
										disabled={count >= oc.maxCount}
										onclick={() => {
											optionalCounts = {
												...optionalCounts,
												[oc.id]: Math.min(oc.maxCount, count + 1)
											};
										}}
									>
										+
									</button>
								</div>
							</div>
						{/if}
					{/each}
				</div>
			{/if}

			{#if modalPaymentAids.length > 0}
				<div class="payment-aids-box">
					<div class="payment-aids-title">Optional Mana Payment</div>
					{#each modalPaymentAids as aid (aid.id)}
						{@const selectedForAid = selectedAidIds[aid.id] ?? []}
						<div class="payment-aid-group">
							<div class="payment-aid-label">
								{aid.label} ({selectedForAid.length} selected)
							</div>
							<div class="payment-aid-candidates">
								{#each aid.candidateIds as candId (candId)}
									{@const isChecked = selectedForAid.includes(candId)}
									{@const usedInOtherAid = Object.entries(selectedAidIds).some(
										([otherId, ids]) => otherId !== aid.id && ids.includes(candId)
									)}
									{@const candColors = aid.colorsByCandidate?.[candId] ?? []}
									{@const candColorChoice = aidColorChoices[candId] ?? ''}
									<div class="aid-candidate-chip" class:selected={isChecked}>
										<label class="aid-candidate-check">
											<input
												type="checkbox"
												checked={isChecked}
												disabled={!isChecked && usedInOtherAid}
												onchange={() => toggleCastAidCandidate(aid.id, candId)}
											/>
											<span>{aidCandidateLabel(aid.kind, candId)}</span>
										</label>
										{#if isChecked && aid.kind === 'tapPermanent'}
											<select
												class="aid-color-select"
												aria-label="Mana contribution for {aidCandidateLabel(aid.kind, candId)}"
												value={candColorChoice}
												onchange={(e) => setCastAidColorChoice(candId, e.currentTarget.value)}
											>
												<option value="">Auto</option>
												{#each candColors as col (col)}
													<option value={col}>Pay {'{' + col + '}'}</option>
												{/each}
												<option value="generic">Generic {'{1}'}</option>
											</select>
										{/if}
									</div>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			{/if}

			<div class="modal-actions">
				{#if landOptions.length > 0 && onPlayLand}
					{#each landOptions as landOpt (landOpt.faceIndex ?? landOpt.label)}
						<button
							type="button"
							class="arena-main-btn can-act"
							onclick={async () => {
								clearHover();
								if (fromZone === 'hand' || fromZone === 'exile') {
									await onPlayLand(inst, fromZone, landOpt.faceIndex);
								}
							}}
						>
							Play Land: {landOpt.label}
						</button>
					{/each}
				{/if}

				{#each options as opt (opt.id)}
					{@const { optCounts, optAidIds, optAidColors, selectedAidTotal } = buildOptionFilters(opt)}
					{@const isXOpt = optionChoosesX(opt, optCounts)}
					{@const previewX = isXOpt ? (selectedAidTotal > 0 ? selectedAidTotal : 0) : 0}
					{@const optReq = getSpellOptionCostRequirement(
						gameState,
						actor.playerId,
						inst,
						opt,
						previewX,
						optCounts
					)}
					{@const aidPreview =
						optReq && (opt.paymentAids?.length ?? 0) > 0
							? applyCastCostAids(optReq, opt, optAidIds, optAidColors)
							: null}
					{@const extraParts = (opt.optionalAdditionalCosts ?? [])
						.filter((oc) => (optCounts[oc.id] ?? 0) > 0)
						.map((oc) =>
							optCounts[oc.id] > 1 ? `${optCounts[oc.id]}× ${oc.costDisplay}` : oc.costDisplay
						)}
					{@const hasDefilerSelected = Object.entries(optCounts).some(
						([id, cnt]) => cnt > 0 && id.startsWith('defiler:')
					)}
					{@const optCmdTax =
						fromZone === 'command' && inst.isCommander
							? formatCommanderTaxDisplay(
									gameState,
									actor,
									inst,
									actorStatus?.commanderTaxAsLifePerCast ?? null,
									opt.faceIndex ?? 0,
									Boolean(opt.fused)
								)
							: null}
					{@const mainCostDisplay = aidPreview?.ok
						? formatManaRequirement(aidPreview.remainingReq, isXOpt)
						: hasDefilerSelected && optReq
							? formatManaRequirement(optReq, isXOpt)
							: opt.costDisplay}
					{@const lifeTaxParts =
						optCmdTax?.isLifeTax && optCmdTax.totalLife > 0 ? [optCmdTax.badgeText] : []}
					{@const combinedDisplay = [mainCostDisplay, ...lifeTaxParts, ...extraParts].join(' + ')}
					{@const hasStrictAids = (opt.paymentAids?.length ?? 0) > 0}
					{@const legalityPrimary = checkSpellCastLegality(
						gameState,
						actor.playerId,
						inst,
						fromZone,
						isXOpt ? (selectedAidTotal > 0 ? selectedAidTotal : 0) : 0,
						opt.id,
						optCounts,
						opt.faceIndex,
						opt.fused,
						optAidIds,
						optAidColors,
						hasStrictAids
					)}
					{@const isOptLegal =
						legalityPrimary.ok ||
						(isXOpt &&
							selectedAidTotal === 0 &&
							checkSpellCastLegality(
								gameState,
								actor.playerId,
								inst,
								fromZone,
								1,
								opt.id,
								optCounts,
								opt.faceIndex,
								opt.fused,
								optAidIds,
								optAidColors,
								hasStrictAids
							).ok)}
					{#if aidPreview && !aidPreview.ok}
						<div class="aid-error-banner">
							{opt.label}: {aidPreview.error}
						</div>
					{/if}
					<button
						type="button"
						class="arena-main-btn"
						class:can-act={isOptLegal}
						data-testid="cast-option-btn-{opt.id}"
						disabled={!isOptLegal}
						title={isOptLegal ? opt.label : (legalityPrimary.error ?? opt.label)}
						onmouseenter={() => enterOptionHover(opt)}
						onmouseleave={clearHover}
						onclick={async () => {
							clearHover();
							await onSelectOption({
								inst,
								fromZone,
								option: opt,
								...(Object.keys(optCounts).length > 0 ? { optionalCostCounts: optCounts } : {}),
								...(Object.keys(optAidIds).length > 0 ? { costAidIds: optAidIds } : {}),
								...(Object.keys(optAidColors).length > 0
									? { costAidColorChoices: optAidColors }
									: {})
							});
						}}
					>
						{opt.label} (<ManaText text={combinedDisplay} size={14} />)
					</button>
				{/each}

				{#if zoneAbilities.length > 0 && onActivateAbility}
					<div class="zone-abilities-heading">Activated Abilities</div>
					{#each zoneAbilities as ab (ab.id)}
						<button
							type="button"
							class="arena-main-btn can-act"
							onclick={async () => {
								clearHover();
								await onActivateAbility(inst, ab);
							}}
						>
							<ManaText text={ab.label} size={14} />
						</button>
					{/each}
				{/if}

				<button type="button" class="hud-btn" onclick={handleCancel}>
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
		max-width: 540px;
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
	.modal-desc {
		margin: 0;
		font-size: 0.8rem;
		color: var(--mp-text-body);
		white-space: pre-line;
	}
	.face-list {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}
	.face-summary {
		border-left: 2px solid rgba(255, 255, 255, 0.2);
		padding-left: 0.5rem;
	}
	.face-header {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-wrap: wrap;
	}
	.face-typeline {
		font-size: 0.8rem;
		opacity: 0.8;
	}
	.optional-cost-section {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.commander-tax-banner {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.35rem 0.6rem;
		border-radius: 6px;
		border: 1px solid rgba(255, 216, 102, 0.55);
		background: rgba(255, 216, 102, 0.1);
		color: #ffd866;
		font-size: 0.8rem;
	}
	.commander-tax-banner.life-tax {
		border-color: var(--mp-purple);
		background: rgba(171, 157, 242, 0.16);
		color: var(--mp-purple);
	}
	.pip-life-pill {
		display: inline-block;
		margin-right: 0.3rem;
		padding: 0.04rem 0.34rem;
		border-radius: 4px;
		font-size: 0.7rem;
		font-weight: 700;
		background: rgba(255, 97, 136, 0.18);
		border: 1px solid var(--mp-red);
		color: var(--mp-red);
	}
	.optional-cost-check {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		font-size: 0.84rem;
		color: var(--mp-text);
	}
	.optional-cost-stepper-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		font-size: 0.84rem;
		color: var(--mp-text);
	}
	.stepper-controls {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.stepper-count {
		min-width: 1.4rem;
		text-align: center;
		font-weight: 700;
	}
	.payment-aids-box {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		padding: 0.6rem 0.7rem;
		border: 1px solid rgba(255, 255, 255, 0.16);
		border-radius: 0.5rem;
		background: rgba(0, 0, 0, 0.2);
	}
	.payment-aids-title {
		font-weight: 600;
		font-size: 0.85rem;
		letter-spacing: 0.02em;
		color: var(--mp-text);
	}
	.payment-aid-group {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.payment-aid-label {
		font-size: 0.8rem;
		opacity: 0.85;
		color: var(--mp-text-body);
	}
	.payment-aid-candidates {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.aid-candidate-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.22rem 0.45rem;
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 0.35rem;
		background: rgba(255, 255, 255, 0.05);
	}
	.aid-candidate-chip.selected {
		border-color: var(--mp-accent);
		background: rgba(255, 216, 102, 0.1);
	}
	.aid-candidate-check {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		cursor: pointer;
		font-size: 0.82rem;
		color: var(--mp-text);
	}
	.aid-color-select {
		font-size: 0.75rem;
		padding: 0.1rem 0.25rem;
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 0.25rem;
		font-family: inherit;
	}
	.aid-error-banner {
		width: 100%;
		font-size: 0.78rem;
		color: #fca5a5;
	}
	.zone-abilities-heading {
		width: 100%;
		margin-top: 0.25rem;
		font-size: 0.8rem;
		opacity: 0.8;
		color: var(--mp-text-body);
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
		padding: 0.28rem 0.6rem;
		font-size: 0.74rem;
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
