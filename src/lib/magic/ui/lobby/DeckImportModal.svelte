<script lang="ts">
	interface Props {
		open: boolean;
		importName?: string;
		importCommander?: string;
		importDecklist?: string;
		importingDeck: boolean;
		onLoadSample: () => void;
		onClose: () => void;
		onSubmit: () => void;
	}

	let {
		open,
		importName = $bindable(''),
		importCommander = $bindable(''),
		importDecklist = $bindable(''),
		importingDeck,
		onLoadSample,
		onClose,
		onSubmit
	}: Props = $props();

	const importEstimatedCount = $derived.by(() => {
		let total = 0;
		for (const raw of importDecklist.split('\n')) {
			const line = raw.trim();
			if (
				!line ||
				line.startsWith('//') ||
				line.startsWith('#') ||
				/^[a-z ]+:$/i.test(line)
			) {
				continue;
			}
			const m = line.match(/^(\d+)x?\s+/i);
			total += m ? parseInt(m[1], 10) || 1 : 1;
		}
		return total;
	});
</script>

{#if open}
	<div class="modal-backdrop">
		<div class="modal-box import-modal">
			<div class="sleek-modal-head">
				<div>
					<h3>Import Commander Deck</h3>
					<p class="sleek-modal-sub">
						Paste any Moxfield, Archidekt, or MTG Arena decklist. Cards resolve via
						Scryfall.
					</p>
				</div>
				<button type="button" class="btn-outline small" onclick={onLoadSample}>
					Load Sample 100
				</button>
			</div>

			<div class="import-meta-grid">
				<label class="field-label">
					<span class="field-head">
						<span>Deck Name</span>
					</span>
					<input
						type="text"
						class="sleek-input"
						bind:value={importName}
						placeholder="e.g. Bant Counters & Planeswalkers"
					/>
				</label>

				<label class="field-label">
					<span class="field-head">
						<span>Commander Name</span>
						<span class="field-hint">Optional if in list</span>
					</span>
					<input
						type="text"
						class="sleek-input"
						bind:value={importCommander}
						placeholder="e.g. Legendary Commander Name"
					/>
				</label>
			</div>

			<label class="field-label">
				<span class="field-head">
					<span>Card List (1 per line, e.g. <code>1 Card Name</code>)</span>
					<span
						class="field-count-pill"
						class:ready={importEstimatedCount === 100 || importEstimatedCount === 99}
					>
						{importEstimatedCount} cards detected
					</span>
				</span>
				<textarea
					class="sleek-textarea"
					rows="12"
					bind:value={importDecklist}
					placeholder="Commander:&#10;1 Legendary Commander&#10;&#10;Deck:&#10;1 Mana Artifact&#10;1 Utility Land..."
				></textarea>
			</label>

			<div class="modal-footer sleek-footer">
				<span class="footer-note"
					>Supports <code>Commander:</code> &amp; <code>Deck:</code> headers</span
				>
				<div class="footer-btns">
					<button type="button" class="btn-outline" onclick={onClose}>Cancel</button>
					<button
						type="button"
						class="btn-accent"
						disabled={importingDeck}
						onclick={onSubmit}
					>
						{importingDeck ? 'Resolving with Scryfall...' : 'Validate & Save Deck'}
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
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
	.sleek-modal-sub {
		margin: 0.2rem 0 0 0;
		font-size: 0.74rem;
		color: var(--mp-text-muted);
	}
	.import-meta-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}
	@media (max-width: 620px) {
		.import-meta-grid {
			grid-template-columns: 1fr;
		}
	}
	.field-label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--mp-text);
	}
	.field-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.4rem;
	}
	.field-hint {
		font-size: 0.66rem;
		font-weight: 400;
		color: var(--mp-text-muted);
	}
	.field-count-pill {
		font-size: 0.66rem;
		font-weight: 600;
		padding: 0.1rem 0.42rem;
		border-radius: 4px;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border-strong);
		color: var(--mp-text-muted);
	}
	.field-count-pill.ready {
		border-color: var(--mp-green);
		color: var(--mp-green);
	}
	.sleek-input,
	.sleek-textarea {
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 6px;
		padding: 0.5rem 0.65rem;
		font-family: inherit;
		font-size: 0.8rem;
		transition: border-color 0.14s ease;
	}
	.sleek-textarea {
		line-height: 1.45;
		resize: vertical;
	}
	.sleek-input:focus,
	.sleek-textarea:focus {
		outline: none;
		border-color: #ffd866;
	}
	.sleek-footer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		padding-top: 0.5rem;
		border-top: 1px solid var(--mp-border);
	}
	.footer-note {
		font-size: 0.7rem;
		color: var(--mp-text-muted);
	}
	.footer-btns {
		display: flex;
		align-items: center;
		gap: 0.55rem;
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
	.btn-accent:disabled {
		opacity: 0.55;
		cursor: not-allowed;
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
	.btn-outline.small {
		padding: 0.28rem 0.55rem;
		font-size: 0.72rem;
	}
</style>
