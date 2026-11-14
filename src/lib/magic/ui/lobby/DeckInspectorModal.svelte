<script lang="ts">
	import {
		cardSupportReport,
		deckUnsupportedCards,
		displayAbilityText,
		type UnsupportedAbilityReport
	} from '../../compiler/support.ts';
	import ManaSymbol from '../../ManaSymbol.svelte';
	import ManaText from '../../ManaText.svelte';
	import { matchesScryfallQuery } from '../../search.ts';
	import type { MagicDeck, ScryfallCard } from '../../types.ts';

	export interface DeckCardUpdateParams {
		cardName: string;
		operation: 'set_qty' | 'remove' | 'promote_commander' | 'demote_commander';
		quantity?: number;
		fromCommander?: boolean;
	}

	interface Props {
		deck: MagicDeck | null;
		cardsPerRow?: number;
		statusMsg?: string;
		errorMsg?: string;
		addingCardBusy?: boolean;
		searchingScryfallBusy?: boolean;
		searchResults?: ScryfallCard[];
		onClose: () => void;
		onClonePrecon: (preconId: string) => void;
		onSearchScryfall: (query: string, explicitTrigger?: boolean) => void;
		onClearSearchResults: () => void;
		onAddCard: (
			card: ScryfallCard,
			quantity: number,
			asCommander: boolean
		) => boolean | Promise<boolean>;
		onUpdateCard: (params: DeckCardUpdateParams) => boolean | Promise<boolean>;
		onHoverCard: (card: ScryfallCard | null, entering: boolean) => void;
	}

	let {
		deck,
		cardsPerRow = $bindable(5),
		statusMsg = $bindable(''),
		errorMsg = $bindable(''),
		addingCardBusy = false,
		searchingScryfallBusy = false,
		searchResults = [],
		onClose,
		onClonePrecon,
		onSearchScryfall,
		onClearSearchResults,
		onAddCard,
		onUpdateCard,
		onHoverCard
	}: Props = $props();

	let inspectSortBy = $state<'none' | 'cmc' | 'name' | 'color' | 'type'>('none');
	let inspectSortDir = $state<'asc' | 'desc'>('asc');
	let inspectSearchQuery = $state('');
	let addCardQtyInput = $state(1);
	let showScryfallDropdown = $state(false);
	let dropdownHighlightIdx = $state(-1);
	let activeCardMenuKey = $state<string | null>(null);
	let customMenuQty = $state(1);
	let lastDeckId = $state<string | null>(null);

	$effect(() => {
		const currentId = deck?.id ?? null;
		if (currentId !== lastDeckId) {
			lastDeckId = currentId;
			inspectSearchQuery = '';
			activeCardMenuKey = null;
			showScryfallDropdown = false;
			dropdownHighlightIdx = -1;
		}
	});

	const isInspectedReadOnly = $derived(
		Boolean(deck && (deck.isPrecon || deck.userId === 'system_precon'))
	);

	// Plan section 2.7: abilities the engine won't automate. A warning only; never a legality error.
	const inspectedUnsupported = $derived(
		deck ? deckUnsupportedCards(deck.commanders, deck.cards) : []
	);

	const UNSUPPORTED_REASON_LABEL: Record<UnsupportedAbilityReport['reason'], string> = {
		unparsed: 'text not understood',
		keyword_not_implemented: 'keyword not implemented',
		static_not_compiled: 'static ability not enforced',
		multiface: 'multi-face card',
		event_not_implemented: 'trigger event not implemented'
	};

	function unsupportedCount(card: ScryfallCard): number {
		return cardSupportReport(card).unsupported.length;
	}

	function abilitiesNotAutomatedLabel(n: number): string {
		return `${n} ${n === 1 ? 'ability' : 'abilities'} not automated`;
	}

	/** Hover text for the per-card badge: each unsupported ability, from the card's own text. */
	function unsupportedTooltip(card: ScryfallCard): string {
		const lines = cardSupportReport(card).unsupported.map((u) => {
			const text = displayAbilityText(u.text, u.face) || '(whole card)';
			const missed = u.unparsed.length
				? ` [not understood: ${u.unparsed.map((t) => displayAbilityText(t, u.face)).join(' … ')}]`
				: '';
			return `• ${text} (${UNSUPPORTED_REASON_LABEL[u.reason]})${missed}`;
		});
		return `Not automated: resolved manually in game\n${lines.join('\n')}`;
	}

	const filteredInspectedCommanders = $derived.by(() => {
		if (!deck) return [];
		return (deck.commanders || []).filter((cmd) =>
			matchesScryfallQuery(cmd, inspectSearchQuery, 1)
		);
	});

	const sortedInspectedCards = $derived.by(() => {
		if (!deck) return [];
		const raw = (deck.cards || []).filter((entry) =>
			matchesScryfallQuery(entry.card, inspectSearchQuery, entry.quantity)
		);
		if (inspectSortBy === 'none') return raw;
		const dir = inspectSortDir === 'desc' ? -1 : 1;
		const colorRank = (card: ScryfallCard): number => {
			if (card.typeLine.includes('Land') && (!card.colors || card.colors.length === 0)) {
				return 7;
			}
			const cols = card.colors?.length ? card.colors : card.colorIdentity || [];
			if (cols.length === 0) return 6;
			if (cols.length > 1) return 5;
			const order: Record<string, number> = { W: 0, U: 1, B: 2, R: 3, G: 4 };
			return order[cols[0]] ?? 6;
		};
		const typeRank = (card: ScryfallCard): number => {
			const t = card.typeLine;
			if (t.includes('Land')) return 0;
			if (t.includes('Creature')) return 1;
			if (t.includes('Planeswalker')) return 2;
			if (t.includes('Artifact')) return 3;
			if (t.includes('Enchantment')) return 4;
			if (t.includes('Battle')) return 5;
			if (t.includes('Instant')) return 6;
			if (t.includes('Sorcery')) return 7;
			return 8;
		};
		return [...raw].sort((a, b) => {
			let cmp = 0;
			if (inspectSortBy === 'cmc') {
				const aLand = a.card.typeLine.includes('Land') ? 0 : 1;
				const bLand = b.card.typeLine.includes('Land') ? 0 : 1;
				if (aLand !== bLand) cmp = aLand - bLand;
				else if (a.card.cmc !== b.card.cmc) cmp = a.card.cmc - b.card.cmc;
				else cmp = a.card.name.localeCompare(b.card.name);
			} else if (inspectSortBy === 'name') {
				cmp = a.card.name.localeCompare(b.card.name);
			} else if (inspectSortBy === 'color') {
				const ca = colorRank(a.card);
				const cb = colorRank(b.card);
				if (ca !== cb) cmp = ca - cb;
				else if (a.card.cmc !== b.card.cmc) cmp = a.card.cmc - b.card.cmc;
				else cmp = a.card.name.localeCompare(b.card.name);
			} else if (inspectSortBy === 'type') {
				const ta = typeRank(a.card);
				const tb = typeRank(b.card);
				if (ta !== tb) cmp = ta - tb;
				else if (a.card.cmc !== b.card.cmc) cmp = a.card.cmc - b.card.cmc;
				else cmp = a.card.name.localeCompare(b.card.name);
			}
			return cmp * dir;
		});
	});

	function openCardMenu(key: string, currentQty: number, e: MouseEvent) {
		e.stopPropagation();
		if (activeCardMenuKey === key) {
			activeCardMenuKey = null;
		} else {
			activeCardMenuKey = key;
			customMenuQty = currentQty;
		}
	}

	function getInspectedDeckCardQty(candidate: ScryfallCard): number {
		if (!deck) return 0;
		const targetLow = candidate.name.toLowerCase();
		let total = 0;
		for (const c of deck.commanders) {
			if (c.name.toLowerCase() === targetLow) total += 1;
		}
		for (const e of deck.cards) {
			if (e.card.name.toLowerCase() === targetLow) total += e.quantity;
		}
		return total;
	}

	function handleHybridSearchInput() {
		dropdownHighlightIdx = -1;
		showScryfallDropdown = false;
		onClearSearchResults();
	}

	async function handleSelectDropdownCard(selectedCard: ScryfallCard, asCommander = false) {
		const ok = await onAddCard(selectedCard, addCardQtyInput, asCommander);
		if (ok) {
			showScryfallDropdown = false;
			dropdownHighlightIdx = -1;
		}
	}

	async function handleUpdateCard(params: DeckCardUpdateParams) {
		const ok = await onUpdateCard(params);
		if (!ok) return;
		if (
			params.operation === 'remove' ||
			params.operation === 'promote_commander' ||
			params.operation === 'demote_commander' ||
			(params.operation === 'set_qty' && (params.quantity ?? 1) <= 0)
		) {
			activeCardMenuKey = null;
		} else if (params.operation === 'set_qty') {
			customMenuQty = Math.min(99, Math.max(1, Math.floor(params.quantity ?? 1)));
		}
	}

	function handleHybridSearchKeydown(e: KeyboardEvent) {
		if (!showScryfallDropdown) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (searchResults.length > 0) {
				dropdownHighlightIdx = Math.min(
					searchResults.length - 1,
					dropdownHighlightIdx + 1
				);
				onHoverCard(searchResults[dropdownHighlightIdx] || null, true);
			}
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (searchResults.length > 0) {
				dropdownHighlightIdx = Math.max(-1, dropdownHighlightIdx - 1);
				onHoverCard(
					dropdownHighlightIdx >= 0 ? searchResults[dropdownHighlightIdx] : null,
					true
				);
			}
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			showScryfallDropdown = false;
			dropdownHighlightIdx = -1;
		} else if (e.key === 'Enter') {
			if (dropdownHighlightIdx >= 0 && searchResults[dropdownHighlightIdx]) {
				e.preventDefault();
				void handleSelectDropdownCard(searchResults[dropdownHighlightIdx], false);
			}
		}
	}
</script>

{#if deck}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="modal-backdrop"
		onclick={() => {
			activeCardMenuKey = null;
			showScryfallDropdown = false;
		}}
	>
		<div
			class="modal-box wide inspect-modal"
			class:readonly-mode={isInspectedReadOnly}
			onclick={() => {
				activeCardMenuKey = null;
				showScryfallDropdown = false;
			}}
		>
			<div class="sleek-modal-head">
				<div class="inspect-title-block">
					<div class="inspect-title-row">
						<h3>{deck.name}</h3>
						{#if isInspectedReadOnly}
							<span class="deck-mode-pill readonly">Read-Only Reference</span>
						{:else}
							<span class="deck-mode-pill editable">Editable</span>
						{/if}
						<span class="legality-pill" class:legal={deck.isLegal}>
							{deck.isLegal ? 'Commander Legal' : 'Rule 0'}
						</span>
						{#if inspectedUnsupported.length > 0}
							<span class="unsupported-pill"
								>{inspectedUnsupported.length} not automated</span
							>
						{/if}
						<span class="inspect-count-tag">{deck.cardCount} Cards</span>
						<span class="mana-row">
							{#if deck.colorIdentity.length > 0}
								{#each deck.colorIdentity as c, ci (ci)}
									<ManaSymbol symbol={c} size={16} />
								{/each}
							{:else}
								<ManaSymbol symbol="C" size={16} />
							{/if}
						</span>
					</div>
					<div class="cmdr-sub-row">
						{#each deck.commanders as cmd (cmd.name)}
							<span class="cmdr-inline">
								<span class="cmdr-tag">CMD</span>
								<strong>{cmd.name}</strong>
								<ManaText text={cmd.manaCost} size={15} />
							</span>
						{/each}
					</div>
				</div>

				<div class="inspect-controls">
					<label class="size-ctrl">
						<span>Cards / Row</span>
						<input
							type="range"
							class="sq-range"
							min="2"
							max="8"
							step="1"
							style="--range-pct: {Math.round(((cardsPerRow - 2) / (8 - 2)) * 100)}%;"
							bind:value={cardsPerRow}
						/>
						<span class="size-val">{cardsPerRow}</span>
					</label>
					{#if isInspectedReadOnly}
						<button
							type="button"
							class="btn-accent small"
							onclick={() => onClonePrecon(deck.id)}
						>
							+ Copy to My Decks &amp; Edit
						</button>
					{/if}
					<button
						type="button"
						class="btn-outline small"
						onclick={() => {
							activeCardMenuKey = null;
							showScryfallDropdown = false;
							onClose();
						}}
					>
						Close
					</button>
				</div>
			</div>

			{#if isInspectedReadOnly}
				<div class="readonly-ref-banner">
					<span>
						<strong>Default Reference Deck (Read-Only):</strong> This starter deck is
						provided to refer to or copy. Click
						<strong>+ Copy to My Decks &amp; Edit</strong> to save your own editable
						copy.
					</span>
				</div>
			{/if}

			<div class="inspect-toolbar">
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="hybrid-search-box" onclick={(e) => e.stopPropagation()}>
					<div class="hybrid-search-bar">
						<div class="hybrid-input-wrap">
							<input
								type="text"
								class="inspect-search-input"
								bind:value={inspectSearchQuery}
								oninput={handleHybridSearchInput}
								onkeydown={handleHybridSearchKeydown}
								title={isInspectedReadOnly
									? 'Filter reference deck using Scryfall syntax (e.g. t:creature, o:draw, c:ug, mv<=3)'
									: 'Filter deck or search Scryfall to add cards using Scryfall syntax (e.g. t:creature, o:draw, c:ug, mv<=3)'}
								placeholder={isInspectedReadOnly
									? 'Search reference deck (e.g. t:creature, o:draw, mv<=3)...'
									: 'Search deck or Scryfall to add cards (e.g. t:creature, o:draw, mv<=3)...'}
							/>
							{#if inspectSearchQuery}
								<button
									type="button"
									class="search-clear-btn"
									title="Clear search"
									onclick={() => {
										inspectSearchQuery = '';
										showScryfallDropdown = false;
										dropdownHighlightIdx = -1;
										onClearSearchResults();
									}}
								>
									×
								</button>
							{/if}
						</div>

						{#if !isInspectedReadOnly}
							<button
								type="button"
								class="hybrid-dropdown-btn"
								class:open={showScryfallDropdown}
								disabled={inspectSearchQuery.trim().length < 2 &&
									!showScryfallDropdown}
								title="Open Scryfall results dropdown to add a card"
								onclick={() => {
									if (showScryfallDropdown) {
										showScryfallDropdown = false;
									} else {
										showScryfallDropdown = true;
										dropdownHighlightIdx = -1;
										onSearchScryfall(inspectSearchQuery, true);
									}
								}}
							>
								{searchingScryfallBusy ? 'Searching...' : '+ Add from Scryfall ▾'}
							</button>
						{/if}
					</div>

					{#if !isInspectedReadOnly && showScryfallDropdown}
						<div
							class="scryfall-dropdown"
							role="listbox"
							aria-label="Scryfall card results"
						>
							<div class="sdd-head">
								<span>
									{#if searchingScryfallBusy}
										Searching Scryfall for "{inspectSearchQuery.trim()}"...
									{:else if searchResults.length === 0}
										No Scryfall cards found for "{inspectSearchQuery.trim()}".
									{:else}
										Select a card to add — Use ↑/↓ + Enter or click:
									{/if}
								</span>
								<div class="sdd-head-right">
									<label
										class="sdd-qty-ctrl"
										title="Quantity to add when selecting a card"
									>
										<span>Qty</span>
										<button
											type="button"
											class="sdd-qty-step"
											disabled={addCardQtyInput <= 1}
											onclick={() =>
												(addCardQtyInput = Math.max(
													1,
													addCardQtyInput - 1
												))}
										>
											-
										</button>
										<input
											type="number"
											min="1"
											max="99"
											bind:value={addCardQtyInput}
										/>
										<button
											type="button"
											class="sdd-qty-step"
											onclick={() =>
												(addCardQtyInput = Math.min(
													99,
													addCardQtyInput + 1
												))}
										>
											+
										</button>
									</label>
									<button
										type="button"
										class="sdd-close"
										onclick={() => {
											showScryfallDropdown = false;
											dropdownHighlightIdx = -1;
										}}
									>
										Hide (Esc)
									</button>
								</div>
							</div>

							{#if searchResults.length > 0}
								<div class="sdd-list">
									{#each searchResults as resCard, idx (resCard.name)}
										{@const inDeckQty = getInspectedDeckCardQty(resCard)}
										<!-- svelte-ignore a11y_click_events_have_key_events -->
										<!-- svelte-ignore a11y_interactive_supports_focus -->
										<div
											class="sdd-item"
											class:highlighted={dropdownHighlightIdx === idx}
											role="option"
											aria-selected={dropdownHighlightIdx === idx}
											onmouseenter={() => {
												dropdownHighlightIdx = idx;
												onHoverCard(resCard, true);
											}}
											onmouseleave={() => onHoverCard(resCard, false)}
											onclick={() =>
												handleSelectDropdownCard(resCard, false)}
										>
											<img
												src={resCard.artCropUrl || resCard.imageUrl}
												alt={resCard.name}
												class="sdd-thumb"
												loading="lazy"
											/>
											<div class="sdd-info">
												<div class="sdd-title-row">
													<span class="sdd-name">{resCard.name}</span>
													{#if resCard.manaCost}
														<ManaText text={resCard.manaCost} size={13} />
													{/if}
													{#if inDeckQty > 0}
														<span class="sdd-indeck-pill"
															>In Deck: {inDeckQty}x</span
														>
													{/if}
												</div>
												<span class="sdd-type">{resCard.typeLine}</span>
											</div>
											<div class="sdd-actions">
												<button
													type="button"
													class="sdd-add-btn"
													disabled={addingCardBusy}
													onclick={(e) => {
														e.stopPropagation();
														void handleSelectDropdownCard(
															resCard,
															false
														);
													}}
												>
													+ {addCardQtyInput}x
												</button>
												<button
													type="button"
													class="sdd-cmd-btn"
													disabled={addingCardBusy}
													title="Add as Commander"
													onclick={(e) => {
														e.stopPropagation();
														void handleSelectDropdownCard(
															resCard,
															true
														);
													}}
												>
													+ CMD
												</button>
											</div>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{/if}
				</div>

				<div class="inspect-sort-bar" role="group" aria-label="Sort deck cards">
					<span class="sort-label">Sort:</span>
					{#each ([
						['none', 'Default'],
						['cmc', 'CMC'],
						['name', 'Name'],
						['color', 'Color'],
						['type', 'Type']
					] as const) as [mode, label] (mode)}
						<button
							type="button"
							class="inspect-sort-pill"
							class:active={inspectSortBy === mode}
							onclick={() => {
								if (mode !== 'none' && inspectSortBy === mode) {
									inspectSortDir = inspectSortDir === 'asc' ? 'desc' : 'asc';
								} else {
									inspectSortBy = mode;
								}
							}}
						>
							{label}
						</button>
					{/each}
					<span class="sort-sep">|</span>
					<button
						type="button"
						class="inspect-sort-pill"
						class:active={inspectSortBy !== 'none' && inspectSortDir === 'asc'}
						onclick={() => {
							inspectSortDir = 'asc';
							if (inspectSortBy === 'none') inspectSortBy = 'cmc';
						}}
					>
						ASC
					</button>
					<button
						type="button"
						class="inspect-sort-pill"
						class:active={inspectSortBy !== 'none' && inspectSortDir === 'desc'}
						onclick={() => {
							inspectSortDir = 'desc';
							if (inspectSortBy === 'none') inspectSortBy = 'cmc';
						}}
					>
						DESC
					</button>
				</div>

				<span class="alt-hint">[Hold ALT: Cursor Preview]</span>
			</div>

			{#if statusMsg}
				<div class="inspect-inline-notice ok">
					<span>{statusMsg}</span>
					<button type="button" onclick={() => (statusMsg = '')}>×</button>
				</div>
			{/if}
			{#if errorMsg}
				<div class="inspect-inline-notice err">
					<span>{errorMsg}</span>
					<button type="button" onclick={() => (errorMsg = '')}>×</button>
				</div>
			{/if}

			{#if deck.validationErrors.length > 0}
				<div class="validation-warn">
					<strong>Commander Legality Notices:</strong>
					<ul>
						{#each deck.validationErrors as err, ei (ei)}
							<li>{err}</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if inspectedUnsupported.length > 0}
				<details class="unsupported-warn">
					<summary>
						<strong>
							{inspectedUnsupported.length}
							{inspectedUnsupported.length === 1 ? 'card has' : 'cards have'} abilities
							that won't be automated.
						</strong>
						You can still play them: in game those abilities are resolved manually. A
						lobby host can block such cards.
					</summary>
					<ul>
						{#each inspectedUnsupported as item (item.card.name)}
							<li>
								<strong>{item.card.name}</strong>
								{#if item.isCommander}<span class="ic-qty cmd-qty">CMD</span>{/if}
								<ul>
									{#each item.report.unsupported as u, i (i)}
										<li>
											<span class="unsupported-text"
												>{displayAbilityText(u.text, u.face) ||
													'(whole card)'}</span
											>
											<span class="unsupported-reason"
												>({UNSUPPORTED_REASON_LABEL[u.reason]})</span
											>
											{#if u.unparsed.length > 0}
												<span class="unsupported-missed">
													Not understood:
													{#each u.unparsed as frag, j (j)}
														<mark
															>{displayAbilityText(frag, u.face)}</mark
														>
													{/each}
												</span>
											{/if}
										</li>
									{/each}
								</ul>
							</li>
						{/each}
					</ul>
				</details>
			{/if}

			<div
				class="inspect-cards-grid"
				style="grid-template-columns: repeat({cardsPerRow}, minmax(0, 1fr));"
			>
				{#each filteredInspectedCommanders as cmd (cmd.name)}
					{@const menuKey = `cmd:${cmd.name}`}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="inspect-card-item cmd"
						onmouseenter={() => onHoverCard(cmd, true)}
						onmouseleave={() => onHoverCard(cmd, false)}
					>
						<div class="inspect-img-wrap">
							<img src={cmd.imageUrl} alt={cmd.name} loading="lazy" />
						</div>
						<div class="inspect-card-meta">
							<div class="inspect-card-caption">
								<span class="ic-name" title={cmd.name}>
									<span class="ic-qty cmd-qty">CMD</span>
									{cmd.name}
								</span>
								{#if cmd.manaCost}
									<span class="ic-mana"
										><ManaText text={cmd.manaCost} size={13} /></span
									>
								{/if}
							</div>
							<div class="inspect-card-sub-row">
								{#if !isInspectedReadOnly}
									<button
										type="button"
										class="card-dots-btn"
										class:open={activeCardMenuKey === menuKey}
										title="Card options"
										onclick={(e) => openCardMenu(menuKey, 1, e)}
									>
										•••
									</button>
								{/if}
								<span class="inspect-card-sub"
									>{cmd.typeLine.split('—')[0].trim()}</span
								>
								{#if unsupportedCount(cmd) > 0}
									<span
										class="unsupported-badge"
										title={unsupportedTooltip(cmd)}
									>
										{abilitiesNotAutomatedLabel(unsupportedCount(cmd))}
									</span>
								{/if}
							</div>
						</div>

						{#if !isInspectedReadOnly && activeCardMenuKey === menuKey}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<div class="card-dots-menu" onclick={(e) => e.stopPropagation()}>
								<div class="cdm-head">
									<span class="cdm-title" title={cmd.name}>{cmd.name}</span>
									<button
										type="button"
										class="cdm-close"
										onclick={() => (activeCardMenuKey = null)}
									>
										×
									</button>
								</div>
								<button
									type="button"
									class="cdm-action-btn"
									onclick={() =>
										handleUpdateCard({
											cardName: cmd.name,
											operation: 'demote_commander',
											fromCommander: true
										})}
								>
									Move to Mainboard
								</button>
								<button
									type="button"
									class="cdm-action-btn danger"
									onclick={() =>
										handleUpdateCard({
											cardName: cmd.name,
											operation: 'remove',
											fromCommander: true
										})}
								>
									Remove Card
								</button>
							</div>
						{/if}
					</div>
				{/each}
				{#each sortedInspectedCards as entry (entry.card.name)}
					{@const menuKey = `main:${entry.card.name}`}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="inspect-card-item"
						onmouseenter={() => onHoverCard(entry.card, true)}
						onmouseleave={() => onHoverCard(entry.card, false)}
					>
						<div class="inspect-img-wrap">
							<img src={entry.card.imageUrl} alt={entry.card.name} loading="lazy" />
						</div>
						<div class="inspect-card-meta">
							<div class="inspect-card-caption">
								<span class="ic-name" title={entry.card.name}>
									<span class="ic-qty">{entry.quantity}x</span>
									{entry.card.name}
								</span>
								{#if entry.card.manaCost}
									<span class="ic-mana"
										><ManaText text={entry.card.manaCost} size={13} /></span
									>
								{/if}
							</div>
							<div class="inspect-card-sub-row">
								{#if !isInspectedReadOnly}
									<button
										type="button"
										class="card-dots-btn"
										class:open={activeCardMenuKey === menuKey}
										title="Change quantity or remove card"
										onclick={(e) => openCardMenu(menuKey, entry.quantity, e)}
									>
										•••
									</button>
								{/if}
								<span class="inspect-card-sub"
									>{entry.card.typeLine.split('—')[0].trim()}</span
								>
								{#if unsupportedCount(entry.card) > 0}
									<span
										class="unsupported-badge"
										title={unsupportedTooltip(entry.card)}
									>
										{abilitiesNotAutomatedLabel(unsupportedCount(entry.card))}
									</span>
								{/if}
							</div>
						</div>

						{#if !isInspectedReadOnly && activeCardMenuKey === menuKey}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<div class="card-dots-menu" onclick={(e) => e.stopPropagation()}>
								<div class="cdm-head">
									<span class="cdm-title" title={entry.card.name}
										>{entry.card.name}</span
									>
									<button
										type="button"
										class="cdm-close"
										onclick={() => (activeCardMenuKey = null)}
									>
										×
									</button>
								</div>
								<div class="cdm-qty-row">
									<span class="cdm-qty-label">Qty</span>
									<div class="cdm-stepper">
										<button
											type="button"
											class="cdm-step-btn"
											disabled={entry.quantity <= 1}
											onclick={() =>
												handleUpdateCard({
													cardName: entry.card.name,
													operation: 'set_qty',
													quantity: entry.quantity - 1
												})}
										>
											-
										</button>
										<input
											type="number"
											min="1"
											max="99"
											class="cdm-qty-input"
											bind:value={customMenuQty}
											onchange={() =>
												handleUpdateCard({
													cardName: entry.card.name,
													operation: 'set_qty',
													quantity: customMenuQty
												})}
											onkeydown={(e) => {
												if (e.key === 'Enter') {
													e.preventDefault();
													void handleUpdateCard({
														cardName: entry.card.name,
														operation: 'set_qty',
														quantity: customMenuQty
													});
												}
											}}
										/>
										<button
											type="button"
											class="cdm-step-btn"
											onclick={() =>
												handleUpdateCard({
													cardName: entry.card.name,
													operation: 'set_qty',
													quantity: entry.quantity + 1
												})}
										>
											+
										</button>
									</div>
								</div>
								<button
									type="button"
									class="cdm-action-btn"
									onclick={() =>
										handleUpdateCard({
											cardName: entry.card.name,
											operation: 'promote_commander'
										})}
								>
									Set as Commander
								</button>
								<button
									type="button"
									class="cdm-action-btn danger"
									onclick={() =>
										handleUpdateCard({
											cardName: entry.card.name,
											operation: 'remove'
										})}
								>
									Remove Card
								</button>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	</div>
{/if}

<style>
	.mana-row {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
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
	.deck-mode-pill.editable {
		background: rgba(255, 216, 102, 0.18);
		color: #ffd866;
		border: 1px solid rgba(255, 216, 102, 0.5);
	}
	.deck-mode-pill.readonly {
		background: rgba(120, 220, 232, 0.14);
		color: var(--mp-cyan);
		border: 1px solid rgba(120, 220, 232, 0.45);
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

	.cmdr-sub-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		margin-top: 0.2rem;
		font-size: 0.78rem;
	}
	.cmdr-inline {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}

	.size-ctrl {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		font-size: 0.72rem;
		color: var(--mp-text-muted);
	}
	.size-val {
		font-size: 0.72rem;
		font-weight: 700;
		color: var(--mp-text);
		min-width: 16px;
		text-align: center;
	}
	.sq-range {
		-webkit-appearance: none;
		appearance: none;
		width: 96px;
		height: 8px;
		padding: 0;
		border-radius: 3px;
		border: 1px solid var(--mp-border-strong);
		background: linear-gradient(
			90deg,
			#ffd866 0%,
			#ffd866 var(--range-pct, 50%),
			var(--mp-bg) var(--range-pct, 50%),
			var(--mp-bg) 100%
		);
		cursor: pointer;
		outline: none;
	}
	.sq-range::-webkit-slider-runnable-track {
		height: 6px;
		border-radius: 2px;
		background: transparent;
	}
	.sq-range::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 14px;
		height: 14px;
		margin-top: -4px;
		border-radius: 3px;
		background: #ffd866;
		border: 1.5px solid #19181a;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
		cursor: pointer;
		transition: transform 0.1s ease;
	}
	.sq-range::-webkit-slider-thumb:hover {
		transform: scale(1.08);
	}
	.sq-range::-moz-range-track {
		height: 6px;
		border-radius: 2px;
		background: transparent;
		border: none;
	}
	.sq-range::-moz-range-progress {
		height: 6px;
		border-radius: 2px;
		background: #ffd866;
	}
	.sq-range::-moz-range-thumb {
		width: 12px;
		height: 12px;
		border-radius: 3px;
		background: #ffd866;
		border: 1.5px solid #19181a;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
		cursor: pointer;
		transition: transform 0.1s ease;
	}
	.sq-range::-moz-range-thumb:hover {
		transform: scale(1.08);
	}

	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(8, 7, 12, 0.76);
		backdrop-filter: blur(2px);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 200;
		padding: 1rem;
	}
	.modal-box {
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border-strong);
		border-radius: 10px;
		padding: 1.15rem 1.25rem;
		max-width: 600px;
		width: 100%;
		max-height: 88vh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
		font-family: var(--mono-font, monospace);
		color: var(--mp-text);
	}
	.modal-box.wide {
		max-width: 980px;
	}
	.sleek-modal-head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 0.75rem;
		flex-wrap: wrap;
		padding-bottom: 0.7rem;
		border-bottom: 1px solid var(--mp-border);
	}
	.sleek-modal-head h3 {
		margin: 0;
		font-size: 1rem;
		color: var(--mp-text);
	}

	.inspect-title-block {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.inspect-title-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.inspect-title-row h3 {
		line-height: 1.2;
	}
	.inspect-title-row .legality-pill {
		align-self: center;
		display: inline-flex;
		align-items: center;
		line-height: 1.2;
		font-size: 0.66rem;
		padding: 0.14rem 0.44rem;
		border-radius: 4px;
	}
	.inspect-count-tag {
		align-self: center;
		display: inline-flex;
		align-items: center;
		line-height: 1.2;
		font-size: 0.66rem;
		color: var(--mp-text-muted);
		background: var(--mp-bg);
		border: 1px solid var(--mp-border);
		padding: 0.14rem 0.44rem;
		border-radius: 4px;
	}
	.cmdr-tag {
		font-size: 0.6rem;
		font-weight: 700;
		padding: 0.06rem 0.32rem;
		border-radius: 3px;
		background: rgba(255, 216, 102, 0.18);
		color: var(--mp-accent);
		border: 1px solid rgba(255, 216, 102, 0.45);
	}
	.inspect-controls {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
	.inspect-toolbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.65rem;
		flex-wrap: wrap;
		padding: 0.4rem 0.55rem;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border);
		border-radius: 6px;
	}
	.hybrid-search-box {
		position: relative;
		flex: 1 1 360px;
		max-width: 540px;
	}
	.hybrid-search-bar {
		display: flex;
		align-items: stretch;
		gap: 0.35rem;
	}
	.hybrid-input-wrap {
		position: relative;
		flex: 1;
		display: flex;
		align-items: center;
		min-width: 0;
	}
	.inspect-search-input {
		width: 100%;
		background: var(--mp-bg-elevated);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 5px;
		padding: 0.32rem 1.65rem 0.32rem 0.58rem;
		font-family: inherit;
		font-size: 0.72rem;
	}
	.inspect-search-input:focus {
		outline: none;
		border-color: #ffd866;
	}
	.search-clear-btn {
		position: absolute;
		right: 4px;
		background: transparent;
		border: none;
		color: var(--mp-text-muted);
		font-size: 0.85rem;
		line-height: 1;
		padding: 0.1rem 0.3rem;
		cursor: pointer;
	}
	.search-clear-btn:hover {
		color: var(--mp-text);
	}
	.readonly-ref-banner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.65rem;
		padding: 0.42rem 0.68rem;
		border-radius: 6px;
		background: rgba(120, 220, 232, 0.1);
		border: 1px solid rgba(120, 220, 232, 0.4);
		color: var(--mp-text-body);
		font-size: 0.73rem;
	}
	.readonly-ref-banner strong {
		color: var(--mp-cyan);
	}
	.hybrid-dropdown-btn {
		flex-shrink: 0;
		background: var(--mp-bg-elevated);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 5px;
		padding: 0.28rem 0.55rem;
		font-family: inherit;
		font-size: 0.66rem;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.12s ease;
	}
	.hybrid-dropdown-btn:hover:not(:disabled),
	.hybrid-dropdown-btn.open {
		border-color: #ffd866;
		background: #ffd866;
		color: #19181a;
	}
	.hybrid-dropdown-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.scryfall-dropdown {
		position: absolute;
		top: calc(100% + 5px);
		left: 0;
		right: 0;
		z-index: 60;
		background: var(--mp-bg-elevated);
		border: 1.5px solid #ffd866;
		border-radius: 8px;
		box-shadow: 0 16px 38px rgba(0, 0, 0, 0.78);
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}
	.sdd-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		flex-wrap: wrap;
		padding: 0.4rem 0.6rem;
		background: var(--mp-bg);
		border-bottom: 1px solid var(--mp-border);
		font-size: 0.66rem;
		color: var(--mp-text-muted);
	}
	.sdd-head-right {
		display: inline-flex;
		align-items: center;
		gap: 0.55rem;
		flex-shrink: 0;
	}
	.sdd-qty-ctrl {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border-strong);
		border-radius: 4px;
		padding: 0.08rem 0.32rem;
		font-size: 0.64rem;
		font-weight: 700;
		color: var(--mp-text-muted);
	}
	.sdd-qty-ctrl input {
		width: 30px;
		background: transparent;
		border: none;
		color: var(--mp-text);
		font-family: inherit;
		font-size: 0.68rem;
		font-weight: 700;
		text-align: center;
		padding: 0.06rem 0;
	}
	.sdd-qty-ctrl input:focus {
		outline: none;
	}
	.sdd-qty-step {
		background: var(--mp-bg);
		border: 1px solid var(--mp-border);
		color: var(--mp-text);
		border-radius: 3px;
		width: 17px;
		height: 17px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-family: inherit;
		font-size: 0.68rem;
		font-weight: 700;
		line-height: 1;
		padding: 0;
		cursor: pointer;
	}
	.sdd-qty-step:hover:not(:disabled) {
		border-color: #ffd866;
		color: #ffd866;
	}
	.sdd-qty-step:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}
	.sdd-close {
		background: transparent;
		border: none;
		color: var(--mp-text-muted);
		font-family: inherit;
		font-size: 0.66rem;
		cursor: pointer;
	}
	.sdd-close:hover {
		color: var(--mp-text);
	}
	.sdd-list {
		max-height: 290px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
	}
	.sdd-item {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.38rem 0.55rem;
		border-bottom: 1px solid var(--mp-border);
		cursor: pointer;
		transition: background 0.1s ease;
	}
	.sdd-item:last-child {
		border-bottom: none;
	}
	.sdd-item:hover,
	.sdd-item.highlighted {
		background: rgba(255, 216, 102, 0.12);
	}
	.sdd-thumb {
		width: 38px;
		height: 30px;
		object-fit: cover;
		border-radius: 4px;
		border: 1px solid var(--mp-border-strong);
		flex-shrink: 0;
	}
	.sdd-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.sdd-title-row {
		display: flex;
		align-items: center;
		gap: 0.38rem;
		min-width: 0;
	}
	.sdd-name {
		font-size: 0.74rem;
		font-weight: 700;
		color: var(--mp-text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.sdd-indeck-pill {
		font-size: 0.58rem;
		font-weight: 700;
		padding: 0.04rem 0.32rem;
		border-radius: 3px;
		background: rgba(120, 220, 232, 0.16);
		border: 1px solid var(--mp-cyan);
		color: var(--mp-cyan);
		flex-shrink: 0;
	}
	.sdd-type {
		font-size: 0.62rem;
		color: var(--mp-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.sdd-actions {
		display: flex;
		align-items: center;
		gap: 0.28rem;
		flex-shrink: 0;
	}
	.sdd-add-btn {
		background: #ffd866;
		color: #19181a;
		border: 1px solid #ffd866;
		border-radius: 4px;
		padding: 0.22rem 0.48rem;
		font-family: inherit;
		font-size: 0.64rem;
		font-weight: 700;
		cursor: pointer;
	}
	.sdd-add-btn:hover:not(:disabled) {
		filter: brightness(1.06);
	}
	.sdd-cmd-btn {
		background: var(--mp-bg);
		color: var(--mp-text-muted);
		border: 1px solid var(--mp-border-strong);
		border-radius: 4px;
		padding: 0.22rem 0.38rem;
		font-family: inherit;
		font-size: 0.6rem;
		font-weight: 700;
		cursor: pointer;
	}
	.sdd-cmd-btn:hover:not(:disabled) {
		border-color: #ffd866;
		color: var(--mp-text);
	}
	.inspect-inline-notice {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
		padding: 0.38rem 0.6rem;
		border-radius: 5px;
		font-size: 0.74rem;
	}
	.inspect-inline-notice.ok {
		background: rgba(169, 220, 118, 0.14);
		border: 1px solid var(--mp-green);
		color: var(--mp-text);
	}
	.inspect-inline-notice.err {
		background: rgba(255, 97, 136, 0.14);
		border: 1px solid var(--mp-red);
		color: var(--mp-text);
	}
	.inspect-inline-notice button {
		background: transparent;
		border: none;
		color: inherit;
		font-size: 0.9rem;
		cursor: pointer;
	}
	.inspect-sort-bar {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		flex-wrap: wrap;
	}
	.sort-label {
		font-size: 0.66rem;
		color: var(--mp-text-muted);
		margin-right: 0.15rem;
	}
	.sort-sep {
		font-size: 0.65rem;
		color: var(--mp-border-strong);
		margin: 0 0.1rem;
	}
	.inspect-sort-pill {
		background: var(--mp-bg-elevated);
		color: var(--mp-text-muted);
		border: 1px solid var(--mp-border);
		border-radius: 4px;
		padding: 0.12rem 0.42rem;
		font-family: inherit;
		font-size: 0.64rem;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.12s ease;
	}
	.inspect-sort-pill:hover {
		border-color: var(--mp-accent);
		color: var(--mp-text);
	}
	.inspect-sort-pill.active {
		background: #ffd866;
		color: #19181a;
		border-color: #ffd866;
	}
	.alt-hint {
		font-size: 0.66rem;
		color: var(--mp-text-muted);
	}
	.inspect-cards-grid {
		display: grid;
		gap: 0.65rem;
		max-height: 60vh;
		overflow-y: auto;
		padding: 0.15rem 0.2rem 0.25rem 0;
	}
	.inspect-card-item {
		position: relative;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border);
		border-radius: 8px;
		padding: 0.35rem;
		display: flex;
		flex-direction: column;
		gap: 0.32rem;
		transition:
			border-color 0.14s ease,
			transform 0.14s ease;
	}
	.inspect-card-item:hover {
		border-color: var(--mp-accent);
		transform: translateY(-2px);
	}
	.inspect-card-item.cmd {
		border-color: rgba(255, 216, 102, 0.55);
		background: linear-gradient(180deg, rgba(255, 216, 102, 0.06), var(--mp-bg));
	}
	.inspect-img-wrap {
		width: 100%;
		border-radius: 5px;
		overflow: hidden;
		background: var(--mp-bg-subtle);
	}
	.inspect-img-wrap img {
		width: 100%;
		display: block;
		border-radius: 5px;
	}
	.inspect-card-meta {
		display: flex;
		flex-direction: column;
		gap: 0.18rem;
		padding: 0 0.1rem;
		min-width: 0;
	}
	.inspect-card-caption {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.3rem;
		font-size: 0.68rem;
		min-width: 0;
	}
	.ic-name {
		font-weight: 600;
		color: var(--mp-text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}
	.ic-qty {
		color: var(--mp-text-muted);
		font-weight: 700;
		margin-right: 0.15rem;
	}
	.ic-qty.cmd-qty {
		color: var(--mp-accent);
	}
	.ic-mana {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
	}
	.inspect-card-sub-row {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
	}
	.card-dots-btn {
		flex-shrink: 0;
		background: var(--mp-bg-elevated);
		color: var(--mp-text-muted);
		border: 1px solid var(--mp-border-strong);
		border-radius: 4px;
		padding: 0.05rem 0.32rem;
		font-family: inherit;
		font-size: 0.56rem;
		line-height: 1.2;
		letter-spacing: 0.05em;
		cursor: pointer;
		transition: all 0.12s ease;
	}
	.card-dots-btn:hover,
	.card-dots-btn.open {
		border-color: #ffd866;
		color: #19181a;
		background: #ffd866;
	}
	.inspect-card-sub {
		font-size: 0.6rem;
		color: var(--mp-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}
	.card-dots-menu {
		position: absolute;
		left: 0.35rem;
		right: 0.35rem;
		bottom: 2.3rem;
		z-index: 35;
		background: var(--mp-bg-elevated);
		border: 1.5px solid #ffd866;
		border-radius: 7px;
		padding: 0.45rem;
		display: flex;
		flex-direction: column;
		gap: 0.38rem;
		box-shadow: 0 10px 26px rgba(0, 0, 0, 0.72);
	}
	.cdm-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.3rem;
		padding-bottom: 0.22rem;
		border-bottom: 1px solid var(--mp-border);
	}
	.cdm-title {
		font-size: 0.64rem;
		font-weight: 700;
		color: var(--mp-text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.cdm-close {
		background: transparent;
		border: none;
		color: var(--mp-text-muted);
		font-size: 0.82rem;
		line-height: 1;
		padding: 0 0.15rem;
		cursor: pointer;
	}
	.cdm-qty-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.3rem;
	}
	.cdm-qty-label {
		font-size: 0.62rem;
		font-weight: 600;
		color: var(--mp-text-muted);
	}
	.cdm-stepper {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
	}
	.cdm-step-btn {
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 4px;
		width: 20px;
		height: 20px;
		padding: 0;
		font-family: inherit;
		font-size: 0.72rem;
		font-weight: 700;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.cdm-step-btn:hover:not(:disabled) {
		border-color: #ffd866;
		color: #ffd866;
	}
	.cdm-step-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.cdm-qty-input {
		width: 36px;
		height: 20px;
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 4px;
		text-align: center;
		font-family: inherit;
		font-size: 0.66rem;
		font-weight: 700;
		padding: 0 2px;
	}
	.cdm-action-btn {
		width: 100%;
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 4px;
		padding: 0.24rem 0.35rem;
		font-family: inherit;
		font-size: 0.62rem;
		font-weight: 600;
		cursor: pointer;
		text-align: center;
		transition: all 0.12s ease;
	}
	.cdm-action-btn:hover {
		border-color: #ffd866;
	}
	.cdm-action-btn.danger {
		color: var(--mp-red);
		border-color: rgba(255, 97, 136, 0.45);
	}
	.cdm-action-btn.danger:hover {
		background: rgba(255, 97, 136, 0.14);
		border-color: var(--mp-red);
	}
	.validation-warn {
		background: rgba(255, 97, 136, 0.12);
		border: 1px solid var(--mp-red);
		border-radius: 6px;
		padding: 0.65rem;
		font-size: 0.76rem;
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
	.unsupported-badge {
		margin-left: auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.58rem;
		font-weight: 700;
		padding: 0.06rem 0.3rem;
		border-radius: 3px;
		border: 1px solid rgba(255, 216, 102, 0.6);
		background: rgba(255, 216, 102, 0.14);
		color: #ffd866;
		cursor: help;
	}
	.unsupported-warn {
		background: rgba(255, 216, 102, 0.08);
		border: 1px solid rgba(255, 216, 102, 0.55);
		border-radius: 6px;
		padding: 0.55rem 0.65rem;
		font-size: 0.74rem;
	}
	.unsupported-warn summary {
		cursor: pointer;
	}
	.unsupported-warn ul {
		margin: 0.35rem 0 0;
		padding-left: 1.1rem;
	}
	.unsupported-warn li {
		margin: 0.15rem 0;
	}
	.unsupported-reason {
		color: var(--mp-text-muted);
		font-size: 0.68rem;
	}
	.unsupported-missed {
		display: block;
		font-size: 0.68rem;
	}
	.unsupported-missed mark {
		background: rgba(255, 216, 102, 0.22);
		color: inherit;
		padding: 0 0.15rem;
		border-radius: 2px;
		margin-right: 0.3rem;
	}
</style>
