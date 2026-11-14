<script lang="ts">
	import { deckUnsupportedCards } from '../../compiler/support.ts';
	import ManaSymbol from '../../ManaSymbol.svelte';
	import type { MagicDeck, ScryfallCard } from '../../types.ts';

	interface Props {
		userDecks: MagicDeck[];
		preconDecks: MagicDeck[];
		onOpenImportModal: () => void;
		onInspectDeck: (deck: MagicDeck) => void;
		onDeleteDeck: (deckId: string) => void;
		onClonePrecon: (preconId: string) => void;
		onHoverCard: (card: ScryfallCard | null, entering: boolean) => void;
	}

	let {
		userDecks,
		preconDecks,
		onOpenImportModal,
		onInspectDeck,
		onDeleteDeck,
		onClonePrecon,
		onHoverCard
	}: Props = $props();

	function safeCssArtUrl(url: string | undefined): string {
		if (!url) return '';
		return url.replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
	}
</script>

<!-- Deck Manager & Scryfall Importer (User's Editable Saved Decks) -->
<section class="card-panel">
	<div class="lobby-title-bar">
		<div>
			<div class="section-head-row">
				<h2>My Saved Decks ({userDecks.length})</h2>
				<span class="deck-mode-tag editable">Editable</span>
			</div>
			<p class="panel-sub">
				Your personal Commander decks. Add, remove, or swap cards anytime, or import a list
				from Moxfield, Archidekt, or MTG Arena.
			</p>
		</div>
		<button type="button" class="btn-accent" onclick={onOpenImportModal}>
			+ Import Commander Deck
		</button>
	</div>

	{#if userDecks.length === 0}
		<div class="empty-decks">
			You haven't saved any custom decks yet. Click <strong>+ Import Commander Deck</strong>
			above or copy one of the <strong>Default Reference Decks</strong> below to start
			customizing.
		</div>
	{:else}
		<div class="deck-grid">
			{#each userDecks as d (d.id)}
				{@const leadCmdr = d.commanders[0] || null}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="deck-card saved-deck-card"
					onmouseenter={() => onHoverCard(leadCmdr, true)}
					onmouseleave={() => onHoverCard(leadCmdr, false)}
				>
					<div
						class="deck-banner"
						style="background-image: linear-gradient(180deg, rgba(16,14,20,0.22), rgba(16,14,20,0.92)), url('{safeCssArtUrl(leadCmdr?.artCropUrl)}');"
					>
						<div class="banner-top-row">
							<span class="legality-pill" class:legal={d.isLegal}>
								{d.isLegal ? 'Commander Legal' : 'Rule 0 / Issues'}
							</span>
							{#if deckUnsupportedCards(d.commanders, d.cards).length > 0}
								{@const n = deckUnsupportedCards(d.commanders, d.cards).length}
								<span
									class="unsupported-pill"
									title="{n} {n === 1 ? 'card has' : 'cards have'} abilities that won't be automated. Open the deck to see which."
								>
									{n} not automated
								</span>
							{/if}
							<span class="deck-mode-pill editable">Editable</span>
						</div>
						<h3>{d.name}</h3>
						<span class="cmdr-sub">
							Commander: {d.commanders.map((c) => c.name).join(' // ')}
						</span>
					</div>
					<div class="deck-Card-body">
						<div class="deck-meta-row">
							<span>{d.cardCount} Cards</span>
							<span class="mana-row">
								{#if d.colorIdentity.length > 0}
									{#each d.colorIdentity as c, ci (ci)}
										<ManaSymbol symbol={c} size={17} />
									{/each}
								{:else}
									<ManaSymbol symbol="C" size={17} />
								{/if}
							</span>
						</div>
						<div class="deck-actions">
							<button
								type="button"
								class="btn-outline small"
								onclick={() => onInspectDeck(d)}
							>
								Edit / Inspect
							</button>
							<button
								type="button"
								class="btn-outline small danger"
								onclick={() => onDeleteDeck(d.id)}
							>
								Delete
							</button>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</section>

<!-- Default Reference / Starter Commander Precon Decks (Read-Only Templates) -->
<section class="card-panel ref-catalog-panel">
	<div class="section-head-row">
		<h2>Default Reference Decks</h2>
		<span class="deck-mode-tag readonly">Read-Only Templates</span>
	</div>
	<p class="panel-sub">
		Built-in 100-card Commander archetypes provided to play as-is, refer to, or copy into
		<strong>My Saved Decks</strong> if you want to customize them.
	</p>
	<div class="precon-ref-list">
		{#each preconDecks as p (p.id)}
			{@const leadCmdr = p.commanders[0] || null}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="precon-ref-row"
				onmouseenter={() => onHoverCard(leadCmdr, true)}
				onmouseleave={() => onHoverCard(leadCmdr, false)}
			>
				<div
					class="precon-ref-art"
					style="background-image: linear-gradient(135deg, rgba(16,14,20,0.12), rgba(16,14,20,0.72)), url('{safeCssArtUrl(leadCmdr?.artCropUrl)}');"
				>
					<span class="precon-ref-count">{p.cardCount} Cards</span>
				</div>

				<div class="precon-ref-main">
					<div class="precon-ref-top">
						<h3>{p.name}</h3>
						<span class="deck-mode-pill readonly">Reference Only</span>
						<span class="mana-row">
							{#each p.colorIdentity as c, ci (ci)}
								<ManaSymbol symbol={c} size={16} />
							{/each}
						</span>
					</div>
					<div class="precon-ref-cmdr">
						Commander: <strong>{p.commanders.map((c) => c.name).join(' // ')}</strong>
					</div>
					<p class="precon-ref-desc">{p.description}</p>
				</div>

				<div class="precon-ref-actions">
					<button
						type="button"
						class="btn-outline small"
						onclick={() => onInspectDeck(p)}
					>
						Refer / View List
					</button>
					<button
						type="button"
						class="btn-accent small"
						onclick={() => onClonePrecon(p.id)}
					>
						+ Copy to My Decks
					</button>
				</div>
			</div>
		{/each}
	</div>
</section>

<style>
	.mana-row {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
	}
	.card-panel {
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border);
		border-radius: 8px;
		padding: 1.1rem;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}
	.card-panel h2 {
		margin: 0;
		font-size: 1.1rem;
	}
	.panel-sub {
		margin: 0;
		font-size: 0.8rem;
		color: var(--mp-text-muted);
	}
	.lobby-title-bar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.75rem;
	}
	.empty-decks {
		padding: 0.85rem;
		border-radius: 6px;
		background: var(--mp-bg);
		border: 1px dashed var(--mp-border-strong);
		font-size: 0.8rem;
		color: var(--mp-text-body);
	}
	.btn-accent {
		background: var(--mp-btn-bg);
		color: var(--mp-btn-fg);
		border: 1px solid var(--mp-btn-bg);
		border-radius: 6px;
		padding: 0.48rem 0.9rem;
		font-family: inherit;
		font-size: 0.82rem;
		font-weight: 700;
		cursor: pointer;
	}
	.btn-outline {
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 6px;
		padding: 0.42rem 0.75rem;
		font-family: inherit;
		font-size: 0.78rem;
		cursor: pointer;
	}
	.btn-outline.small,
	.btn-accent.small {
		padding: 0.28rem 0.55rem;
		font-size: 0.72rem;
	}
	.btn-outline.danger:hover {
		border-color: var(--mp-red);
		color: var(--mp-red);
	}

	.section-head-row {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		flex-wrap: wrap;
	}
	.deck-mode-tag,
	.deck-mode-pill {
		display: inline-flex;
		align-items: center;
		line-height: 1.2;
		font-size: 0.64rem;
		font-weight: 700;
		padding: 0.14rem 0.44rem;
		border-radius: 4px;
		letter-spacing: 0.02em;
	}
	.deck-mode-tag.editable,
	.deck-mode-pill.editable {
		background: rgba(255, 216, 102, 0.18);
		color: #ffd866;
		border: 1px solid rgba(255, 216, 102, 0.5);
	}
	.deck-mode-tag.readonly,
	.deck-mode-pill.readonly {
		background: rgba(120, 220, 232, 0.14);
		color: var(--mp-cyan);
		border: 1px solid rgba(120, 220, 232, 0.45);
	}
	.deck-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(265px, 1fr));
		gap: 0.85rem;
	}
	.deck-card {
		background: var(--mp-bg);
		border: 1px solid var(--mp-border-strong);
		border-radius: 8px;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		transition: border-color 0.14s ease;
	}
	.saved-deck-card:hover {
		border-color: rgba(255, 216, 102, 0.65);
	}
	.ref-catalog-panel {
		border-style: dashed;
	}
	.precon-ref-list {
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
	}
	.precon-ref-row {
		display: grid;
		grid-template-columns: 155px 1fr auto;
		align-items: center;
		gap: 0.9rem;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border);
		border-left: 3px solid var(--mp-cyan);
		border-radius: 8px;
		padding: 0.55rem 0.75rem 0.55rem 0.55rem;
		transition:
			border-color 0.14s ease,
			background 0.14s ease;
	}
	.precon-ref-row:hover {
		border-color: var(--mp-cyan);
		background: rgba(120, 220, 232, 0.04);
	}
	@media (max-width: 720px) {
		.precon-ref-row {
			grid-template-columns: 1fr;
			gap: 0.6rem;
		}
	}
	.precon-ref-art {
		height: 82px;
		border-radius: 6px;
		background-size: cover;
		background-position: center;
		border: 1px solid var(--mp-border-strong);
		display: flex;
		align-items: flex-end;
		justify-content: flex-end;
		padding: 0.32rem;
	}
	.precon-ref-count {
		font-size: 0.62rem;
		font-weight: 700;
		background: rgba(25, 24, 26, 0.88);
		color: #fcfcfa;
		border: 1px solid var(--mp-border-strong);
		border-radius: 4px;
		padding: 0.08rem 0.35rem;
	}
	.precon-ref-main {
		display: flex;
		flex-direction: column;
		gap: 0.22rem;
		min-width: 0;
	}
	.precon-ref-top {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.precon-ref-top h3 {
		margin: 0;
		font-size: 0.92rem;
		color: var(--mp-text);
	}
	.precon-ref-cmdr {
		font-size: 0.74rem;
		color: var(--mp-text-muted);
	}
	.precon-ref-cmdr strong {
		color: #ffd866;
	}
	.precon-ref-desc {
		margin: 0.1rem 0 0 0;
		font-size: 0.74rem;
		color: var(--mp-text-body);
		line-height: 1.4;
	}
	.precon-ref-actions {
		display: flex;
		flex-direction: column;
		gap: 0.38rem;
		flex-shrink: 0;
	}
	@media (max-width: 720px) {
		.precon-ref-actions {
			flex-direction: row;
		}
	}
	.deck-banner {
		height: 125px;
		background-size: cover;
		background-position: center;
		padding: 0.65rem;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		color: #fcfcfa;
	}
	.banner-top-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.4rem;
	}
	.deck-banner h3 {
		margin: 0.2rem 0 0.1rem 0;
		font-size: 0.95rem;
	}
	.cmdr-sub {
		font-size: 0.74rem;
		color: #ffd866;
	}
	.legality-pill {
		align-self: flex-start;
		font-size: 0.64rem;
		font-weight: 700;
		padding: 0.12rem 0.42rem;
		border-radius: 3px;
		background: rgba(255, 97, 136, 0.85);
		color: #19181a;
	}
	.legality-pill.legal {
		background: rgba(169, 220, 118, 0.9);
	}
	.unsupported-pill {
		align-self: center;
		font-size: 0.64rem;
		font-weight: 700;
		padding: 0.12rem 0.42rem;
		border-radius: 3px;
		background: rgba(255, 216, 102, 0.9);
		color: #19181a;
		white-space: nowrap;
	}
	.deck-Card-body {
		padding: 0.7rem;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		gap: 0.55rem;
		flex: 1;
	}
	.deck-meta-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 0.75rem;
		color: var(--mp-text-muted);
	}
	.deck-actions {
		display: flex;
		justify-content: space-between;
		gap: 0.45rem;
	}
</style>
