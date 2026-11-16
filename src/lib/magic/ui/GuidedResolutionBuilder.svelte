<script lang="ts">
	import type { CounterType, GameState, GuidedOperation } from '../types.ts';
	import { resolveCardInstanceDisplay } from './promptViewModel.ts';

	let {
		promptId,
		gameState,
		viewerId,
		yesLabel = 'Apply & Complete Resolution',
		cancellable = false,
		onSubmit,
		onCancel
	}: {
		promptId: string;
		gameState: GameState;
		viewerId: string;
		yesLabel?: string;
		cancellable?: boolean;
		onSubmit: (operations: GuidedOperation[]) => void | Promise<void>;
		onCancel?: () => void | Promise<void>;
	} = $props();

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

	const GUIDED_COUNTERS: CounterType[] = [
		'+1/+1',
		'-1/-1',
		'loyalty',
		'charge',
		'shield',
		'stun',
		'lore',
		'time',
		'age'
	];

	const GUIDED_ZONES = ['battlefield', 'hand', 'graveyard', 'exile', 'library', 'command'] as const;

	let guidedOps = $state<GuidedOperation[]>([]);
	let guidedPromptId = $state<string | null>(null);
	let guidedOpKind = $state<GuidedOpKind>('draw_cards');
	let guidedTargetId = $state('');
	let guidedAmount = $state(1);
	let guidedZone = $state<(typeof GUIDED_ZONES)[number]>('graveyard');
	let guidedCounter = $state<CounterType>('+1/+1');
	let guidedTokenName = $state('Token');
	let guidedTokenPower = $state(1);
	let guidedTokenToughness = $state(1);

	$effect(() => {
		if (guidedPromptId !== promptId) {
			guidedPromptId = promptId;
			guidedOps = [];
		}
	});

	const viewerPlayer = $derived(gameState.players.find((p) => p.playerId === viewerId) ?? null);

	/** Players and visible cards an operation can act on (libraries and others' hands stay hidden). */
	const guidedTargets = $derived.by(() => {
		const out: Array<{ id: string; label: string; kind: 'player' | 'card'; zone?: string }> = [];
		for (const p of gameState.players) {
			out.push({ id: p.playerId, label: `Player: ${p.username}`, kind: 'player' });
		}
		for (const p of gameState.players) {
			for (const c of p.battlefield) {
				const disp = resolveCardInstanceDisplay(c, 'battlefield', viewerId);
				out.push({
					id: c.instanceId,
					label: `${disp.displayCard.name} (${p.username}'s battlefield)`,
					kind: 'card',
					zone: 'battlefield'
				});
			}
		}
		for (const p of gameState.players) {
			for (const zone of ['graveyard', 'exile', 'command'] as const) {
				for (const c of p[zone]) {
					const disp = resolveCardInstanceDisplay(c, zone, viewerId);
					out.push({
						id: c.instanceId,
						label: `${disp.displayCard.name} (${p.username}'s ${zone})`,
						kind: 'card',
						zone
					});
				}
			}
		}
		for (const c of viewerPlayer?.hand ?? []) {
			const disp = resolveCardInstanceDisplay(c, 'hand', viewerId);
			out.push({
				id: c.instanceId,
				label: `${disp.displayCard.name} (your hand)`,
				kind: 'card',
				zone: 'hand'
			});
		}
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

	function guidedLabel(op: GuidedOperation): string {
		const target = op.targetId
			? (guidedTargets.find((t) => t.id === op.targetId)?.label ?? 'target')
			: '';
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
		const needsTarget =
			guidedOpKind !== 'create_token' &&
			guidedOpKind !== 'draw_cards' &&
			guidedOpKind !== 'mill';
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
</script>

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
		onclick={() => onSubmit([...guidedOps])}
	>
		{yesLabel}
	</button>
	{#if cancellable && onCancel}
		<button type="button" class="hud-btn" onclick={() => onCancel()}>
			Cancel
		</button>
	{/if}
</div>

<style>
	.guided-builder {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.guided-box {
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
		align-items: flex-end;
	}
	.guided-box label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.76rem;
		color: var(--mp-text, #fcfcfa);
	}
	.guided-box select,
	.guided-box input {
		background: var(--mp-bg, #19181a);
		color: var(--mp-text, #fcfcfa);
		border: 1px solid var(--mp-border-strong, #524c58);
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
		color: var(--mp-text-body, #e3e1e4);
	}
	.guided-op-remove {
		margin-left: 0.4rem;
		background: none;
		border: none;
		color: var(--mp-text, #fcfcfa);
		cursor: pointer;
	}
	.guided-hint {
		margin: 0;
		font-size: 0.76rem;
		opacity: 0.8;
		color: var(--mp-text-muted, #939293);
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
	.hud-btn:hover {
		border-color: var(--mp-accent, #ffd866);
	}
</style>
