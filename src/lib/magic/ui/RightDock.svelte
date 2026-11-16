<script lang="ts">
	import type { CardContinuousBreakdown } from '../engine.ts';
	import { resolveObjectFaces, stackItemFaceOptions } from '../runtime/faces.ts';
	import type {
		CardInstance,
		GameActionPayload,
		GameState,
		MagicChatMessage,
		ScryfallCard,
		StackItem,
		TargetRef
	} from '../types.ts';
	import CardInspector from './CardInspector.svelte';
	import { FACE_DOWN_ART_URI } from './promptViewModel.ts';
	import { feedTailTrigger, stickyBottom } from './stickyScroll.ts';

	const EMOTES = ['Good Game', 'Nice Play', 'Thinking...', 'Oops', 'Countered', 'Let It Resolve'];

	let {
		gameState,
		viewerId,
		chatMessages,
		inspectedCard,
		inspectedInstance = null,
		inspectedFaceIndex = $bindable(0),
		inspectorHeight = 240,
		stackHeight = 160,
		inspectBreakdown,
		canResolveInspectedManually = false,
		isStackDropValid = false,
		isStackDragOver = false,
		isDraggingCard = false,
		isStackItemTargetable,
		onStartResize,
		onStackDragOver,
		onStackDragLeave,
		onStackDrop,
		onStackItemClick,
		onDropOnStackTarget,
		onHoverCard,
		onLeaveCard,
		onGameAction,
		onSendChat
	}: {
		gameState: GameState;
		viewerId?: string;
		chatMessages: MagicChatMessage[];
		inspectedCard: ScryfallCard | null;
		inspectedInstance?: CardInstance | null;
		inspectedFaceIndex?: number;
		inspectorHeight?: number;
		stackHeight?: number;
		inspectBreakdown?: CardContinuousBreakdown | null;
		canResolveInspectedManually?: boolean;
		isStackDropValid?: boolean;
		isStackDragOver?: boolean;
		isDraggingCard?: boolean;
		isStackItemTargetable?: (item: StackItem) => boolean;
		onStartResize?: (handle: 'inspector' | 'stack') => void;
		onStackDragOver?: (e: DragEvent) => void;
		onStackDragLeave?: (e: DragEvent) => void;
		onStackDrop?: (e: DragEvent) => void;
		onStackItemClick?: (item: StackItem) => void;
		onDropOnStackTarget?: (e: DragEvent, target: TargetRef) => void;
		onHoverCard?: (card: ScryfallCard, inst?: CardInstance) => void;
		onLeaveCard?: (card: ScryfallCard) => void;
		onGameAction: (action: GameActionPayload) => void | Promise<void>;
		onSendChat: (text: string, kind?: 'chat' | 'emote') => void | Promise<void>;
	} = $props();

	let dockTab = $state<'chat' | 'log'>('chat');
	let chatInput = $state('');
	let chatForceNonce = $state(0);

	function stackItemDisplay(item: StackItem): {
		name: string;
		imageUrl: string;
		artCropUrl: string;
	} {
		const view = resolveObjectFaces(item.card, stackItemFaceOptions(item));
		if (item.isFaceDown) {
			return {
				name: item.faceDownLabel || item.title,
				imageUrl: FACE_DOWN_ART_URI,
				artCropUrl: FACE_DOWN_ART_URI
			};
		}
		return {
			name: view.name || item.title,
			imageUrl: view.imageUrl || item.card.imageUrl || FACE_DOWN_ART_URI,
			artCropUrl:
				view.artCropUrl ||
				item.card.artCropUrl ||
				view.imageUrl ||
				item.card.imageUrl ||
				FACE_DOWN_ART_URI
		};
	}

	async function submitChat() {
		const msg = chatInput.trim();
		if (!msg) return;
		chatInput = '';
		chatForceNonce += 1;
		await onSendChat(msg, 'chat');
	}

	async function sendEmote(em: string) {
		chatForceNonce += 1;
		await onSendChat(em, 'emote');
	}
</script>

<aside class="arena-dock">
	<!-- Clicked Card Info Panel -->
	<CardInspector
		{inspectedCard}
		{inspectedInstance}
		bind:inspectedFaceIndex
		height={inspectorHeight}
		{gameState}
		{viewerId}
		breakdownOverride={inspectBreakdown}
		canResolveManually={canResolveInspectedManually}
		{onGameAction}
	/>

	<!-- Horizontal Splitter: Card Info vs Stack -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="resizer-h"
		title="Drag to resize Clicked Card Info panel"
		onmousedown={() => onStartResize?.('inspector')}
	>
		<span class="grip-dots"></span>
	</div>

	<!-- The Stack (LIFO) -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="stack-panel"
		class:drop-zone-valid={isStackDropValid}
		class:drop-zone-active={isStackDragOver && isStackDropValid}
		style="height: {stackHeight}px;"
		ondragover={(e) => onStackDragOver?.(e)}
		ondragleave={(e) => onStackDragLeave?.(e)}
		ondrop={(e) => onStackDrop?.(e)}
	>
		<div class="dock-head">
			<span>THE STACK ({gameState.stack.length})</span>
			{#if isStackDropValid}
				<span class="drop-zone-pill">DROP ON STACK TO CAST</span>
			{:else}
				<span class="lifo-hint">Resolves Top -&gt; Down</span>
			{/if}
		</div>

		{#if gameState.stack.length === 0}
			<div class="stack-empty">Stack is empty</div>
		{:else}
			<div class="stack-list">
				{#each [...gameState.stack].reverse() as item, idx (item.id)}
					{@const targetable = isStackItemTargetable ? isStackItemTargetable(item) : false}
					{@const stkDisp = stackItemDisplay(item)}
					<button
						type="button"
						class="stack-card"
						class:top-of-stack={idx === 0}
						class:targetable-stack={targetable}
						data-game-id={item.id}
						onmouseenter={() => !item.isFaceDown && onHoverCard?.(item.card)}
						onmouseleave={() => !item.isFaceDown && onLeaveCard?.(item.card)}
						onclick={() => onStackItemClick?.(item)}
						ondragover={(e) => {
							if (isDraggingCard) e.preventDefault();
						}}
						ondrop={(e) =>
							onDropOnStackTarget?.(e, {
								kind: 'stack',
								id: item.id,
								label: item.title
							})}
					>
						<img src={stkDisp.artCropUrl} alt={stkDisp.name} />
						<div class="stk-info">
							<span class="stk-title">#{gameState.stack.length - idx}: {stkDisp.name}</span>
							{#if item.spellMods?.castSummarySuffix}
								<span class="stk-target">
									{item.spellMods.label || item.spellMods.castSummarySuffix.trim()}
								</span>
							{/if}
							{#if item.optionalCostCounts}
								{@const paidOptionalTotal = Object.values(item.optionalCostCounts).reduce(
									(s, n) => s + n,
									0
								)}
								{#if paidOptionalTotal > 0}
									<span class="stk-target">
										Additional Cost{paidOptionalTotal > 1 ? ` ×${paidOptionalTotal}` : ''}
									</span>
								{/if}
							{/if}
							{#if item.targets.length > 0}
								<span class="stk-target">
									Target -&gt; {item.targets.map((t) => t.label).join(', ')}
								</span>
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
		onmousedown={() => onStartResize?.('stack')}
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

		{#key dockTab}
			{#if dockTab === 'chat'}
				<div
					class="chat-feed"
					use:stickyBottom={{
						trigger: feedTailTrigger(chatMessages),
						forceNonce: chatForceNonce,
						resetKey: 'chat'
					}}
				>
					{#each chatMessages as m (m.id)}
						<div class="chat-msg kind-{m.kind}">
							<span class="cm-user">{m.username}:</span>
							<span class="cm-text">{m.message}</span>
						</div>
					{/each}
				</div>
				<div class="emote-row">
					{#each EMOTES as em (em)}
						<button type="button" class="emote-btn" onclick={() => sendEmote(em)}>
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
					<input type="text" placeholder="Message pod..." bind:value={chatInput} />
					<button type="submit">Send</button>
				</form>
			{:else}
				<div
					class="chat-feed"
					use:stickyBottom={{
						trigger: feedTailTrigger(gameState.log),
						resetKey: 'log'
					}}
				>
					{#each gameState.log as entry (entry.id)}
						<div class="log-entry kind-{entry.kind}">
							<span class="le-turn">[T{entry.turn}]</span>
							<span>{entry.text}</span>
						</div>
					{/each}
				</div>
			{/if}
		{/key}
	</div>
</aside>

<style>
	.arena-dock {
		background: var(--mp-bg-elevated, #221f22);
		display: flex;
		flex-direction: column;
		min-height: 0;
		z-index: 160;
	}
	.resizer-h {
		height: 6px;
		background: var(--mp-border-subtle, #2f2b33);
		cursor: row-resize;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: background 0.14s ease;
	}
	.resizer-h:hover {
		background: var(--mp-accent, #ffd866);
	}
	.grip-dots {
		width: 24px;
		height: 2px;
		border-radius: 2px;
		background: var(--mp-text-muted, #939293);
		opacity: 0.6;
	}
	.stack-panel {
		padding: 0.45rem 0.6rem;
		overflow-y: auto;
		flex-shrink: 0;
	}
	.stack-panel.drop-zone-valid {
		outline: 1.5px dashed var(--mp-cyan, #78dce8);
		outline-offset: -3px;
	}
	.stack-panel.drop-zone-active {
		background: rgba(120, 220, 232, 0.12);
	}
	.dock-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 0.68rem;
		font-weight: 700;
		color: var(--mp-accent, #ffd866);
		margin-bottom: 0.3rem;
	}
	.drop-zone-pill {
		background: var(--mp-cyan, #78dce8);
		color: #19181a;
		border-radius: 3px;
		padding: 1px 5px;
		font-size: 0.58rem;
		font-weight: 800;
	}
	.lifo-hint {
		color: var(--mp-text-muted, #939293);
		font-weight: 400;
		font-size: 0.62rem;
	}
	.stack-empty {
		font-size: 0.7rem;
		color: var(--mp-text-muted, #939293);
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
		background: var(--mp-bg, #19181a);
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 5px;
		padding: 0.25rem 0.4rem;
		color: var(--mp-text, #fcfcfa);
		font-family: inherit;
		text-align: left;
		cursor: pointer;
	}
	.stack-card.top-of-stack {
		border-color: var(--mp-cyan, #78dce8);
	}
	.stack-card.targetable-stack {
		border-color: var(--mp-yellow, #ffd866);
		box-shadow: 0 0 8px rgba(255, 216, 102, 0.55);
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
		color: var(--mp-accent, #ffd866);
		font-size: 0.62rem;
	}
	.chat-panel {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	.dock-tabs {
		display: grid;
		grid-template-columns: 1fr 1fr;
		border-bottom: 1px solid var(--mp-border, #3e3a42);
	}
	.dock-tabs button {
		background: var(--mp-bg, #19181a);
		color: var(--mp-text-muted, #939293);
		border: none;
		padding: 0.4rem;
		font-family: inherit;
		font-size: 0.7rem;
		font-weight: 600;
		cursor: pointer;
	}
	.dock-tabs button.active {
		background: var(--mp-bg-elevated, #221f22);
		color: var(--mp-cyan, #78dce8);
		border-bottom: 2px solid var(--mp-cyan, #78dce8);
	}
	.chat-feed {
		flex: 1;
		min-height: 0;
		padding: 0.5rem;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.72rem;
	}
	.chat-msg .cm-user {
		font-weight: 700;
		color: var(--mp-cyan, #78dce8);
		margin-right: 0.25rem;
	}
	.chat-msg.kind-system {
		color: var(--mp-orange, #fc9867);
	}
	.chat-msg.kind-emote {
		color: var(--mp-purple, #ab9df2);
		font-style: italic;
	}
	.log-entry {
		font-size: 0.68rem;
		line-height: 1.35;
		color: var(--mp-text-body, #e3e1e4);
		border-left: 2px solid var(--mp-border-strong, #524c58);
		padding-left: 0.38rem;
	}
	.log-entry.kind-cast {
		border-color: var(--mp-cyan, #78dce8);
	}
	.log-entry.kind-combat {
		border-color: var(--mp-red, #ff6188);
	}
	.log-entry.kind-sba {
		border-color: var(--mp-orange, #fc9867);
		color: var(--mp-orange, #fc9867);
	}
	.le-turn {
		color: var(--mp-text-muted, #939293);
		margin-right: 0.25rem;
	}
	.emote-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem;
		padding: 0.28rem 0.45rem;
		border-top: 1px solid var(--mp-border, #3e3a42);
	}
	.emote-btn {
		background: var(--mp-bg, #19181a);
		color: var(--mp-text-muted, #939293);
		border: 1px solid var(--mp-border, #3e3a42);
		border-radius: 3px;
		font-family: inherit;
		font-size: 0.62rem;
		padding: 0.12rem 0.34rem;
		cursor: pointer;
	}
	.emote-btn:hover {
		border-color: var(--mp-purple, #ab9df2);
		color: var(--mp-purple, #ab9df2);
	}
	.chat-form {
		display: flex;
		gap: 0.3rem;
		padding: 0.4rem;
		border-top: 1px solid var(--mp-border, #3e3a42);
	}
	.chat-form input {
		flex: 1;
		background: var(--mp-bg, #19181a);
		color: var(--mp-text, #fcfcfa);
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 4px;
		padding: 0.3rem 0.5rem;
		font-family: inherit;
		font-size: 0.74rem;
	}
	.chat-form button {
		background: var(--mp-btn-bg, #ffd866);
		color: var(--mp-btn-fg, #19181a);
		border: none;
		border-radius: 4px;
		padding: 0.3rem 0.65rem;
		font-family: inherit;
		font-size: 0.74rem;
		font-weight: 700;
		cursor: pointer;
	}
</style>
