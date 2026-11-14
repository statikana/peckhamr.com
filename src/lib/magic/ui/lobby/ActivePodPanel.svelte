<script lang="ts">
	import ManaSymbol from '../../ManaSymbol.svelte';
	import type {
		BotSpeed,
		LobbyRulesConfig,
		MagicChatMessage,
		MagicDeck,
		MagicLobby,
		MagicUser
	} from '../../types.ts';

	interface Props {
		lobby: MagicLobby;
		user: MagicUser;
		userDecks: MagicDeck[];
		preconDecks: MagicDeck[];
		chatMessages: MagicChatMessage[];
		lobbyChatWidth?: number;
		lobbyChatHeight?: number;
		onBackToAllLobbies: () => void;
		onLeaveLobby: (code: string) => void;
		onCopyInviteLink: () => void;
		onSelectDeck: (deckId: string) => void;
		onAddBot: (seatIndex: number) => void;
		onRemoveBot: (seatIndex: number) => void;
		onTransferHost: (targetUserId: string) => void;
		onStartMatch: () => void;
		onEnterMatch: () => void;
		onUpdateRules: (partial: Partial<LobbyRulesConfig>) => void;
		onSendChat: (message: string, kind?: 'chat' | 'emote') => void | Promise<void>;
	}

	let {
		lobby,
		user,
		userDecks,
		preconDecks,
		chatMessages,
		lobbyChatWidth = $bindable(330),
		lobbyChatHeight = $bindable(360),
		onBackToAllLobbies,
		onLeaveLobby,
		onCopyInviteLink,
		onSelectDeck,
		onAddBot,
		onRemoveBot,
		onTransferHost,
		onStartMatch,
		onEnterMatch,
		onUpdateRules,
		onSendChat
	}: Props = $props();

	let lobbyChatInput = $state('');
	let resizingChatCol = $state(false);
	let resizeStartX = 0;
	let resizeStartWidth = 330;

	const isHost = $derived(lobby.hostUserId === user.id);

	function safeCssArtUrl(url: string | undefined): string {
		if (!url) return '';
		return url.replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
	}

	function startLobbyChatResize(e: MouseEvent) {
		e.preventDefault();
		resizingChatCol = true;
		resizeStartX = e.clientX;
		resizeStartWidth = lobbyChatWidth;
	}

	function handleWindowMouseMove(e: MouseEvent) {
		if (!resizingChatCol) return;
		const dx = resizeStartX - e.clientX;
		lobbyChatWidth = Math.max(250, Math.min(540, resizeStartWidth + dx));
	}

	function stopLobbyChatResize() {
		resizingChatCol = false;
	}
</script>

<svelte:window
	onmousemove={handleWindowMouseMove}
	onmouseup={stopLobbyChatResize}
	onblur={stopLobbyChatResize}
/>

<div class="active-lobby-layout" style="--lobby-chat-w: {lobbyChatWidth}px;">
	<div class="lobby-left-col">
		<section class="card-panel">
			<div class="lobby-title-bar">
				<div class="lobby-title-left">
					<button type="button" class="btn-outline" onclick={onBackToAllLobbies}>
						All Lobbies
					</button>
					<button
						type="button"
						class="btn-outline"
						onclick={() => onLeaveLobby(lobby.code)}
					>
						Leave Lobby
					</button>
					<h2>{lobby.name}</h2>
				</div>
				<div class="invite-box">
					<span class="invite-label">INVITE CODE:</span>
					<span class="code-badge large">{lobby.code}</span>
					<button type="button" class="btn-outline" onclick={onCopyInviteLink}>
						Copy Invite Link
					</button>
				</div>
			</div>

			<!-- 4-Seat Pod Grid -->
			<div class="seats-grid">
				{#each lobby.seats as seat (seat.seatIndex)}
					<div
						class="seat-card"
						class:occupied={seat.userId !== null || seat.isBot}
						class:mine={seat.userId === user.id}
					>
						{#if seat.commanderArtUrl}
							<div
								class="seat-art"
								style="background-image: linear-gradient(90deg, rgba(20,18,26,0.92) 25%, rgba(20,18,26,0.55) 100%), url('{safeCssArtUrl(seat.commanderArtUrl)}');"
							></div>
						{/if}
						<div class="seat-content">
							<div class="seat-top">
								<span class="seat-idx">SEAT #{seat.seatIndex + 1}</span>
								{#if seat.userId === lobby.hostUserId}
									<span class="host-pill">[HOST]</span>
								{:else if seat.isBot}
									<span class="bot-pill">[AI BOT]</span>
								{:else if seat.isGuest}
									<span class="guest-pill">[GUEST]</span>
								{/if}
							</div>

							{#if seat.userId !== null || seat.isBot}
								<div class="seat-player-row">
									<span class="seat-player">{seat.username}</span>
									{#if seat.colorIdentity.length > 0}
										<span class="mana-row">
											{#each seat.colorIdentity as c, ci (ci)}
												<ManaSymbol symbol={c} size={16} />
											{/each}
										</span>
									{/if}
								</div>
								<div class="seat-deck">
									<span>Deck: {seat.deckName || 'No Deck'}</span>
									{#if seat.commanderNames.length > 0}
										<span class="seat-cmdr">
											Commander: {seat.commanderNames.join(' // ')}
										</span>
									{/if}
								</div>

								{#if seat.userId === user.id}
									<div class="seat-deck-picker">
										<label>
											Choose Your Deck:
											<select
												value={seat.deckId}
												onchange={(e) =>
													onSelectDeck(
														(e.currentTarget as HTMLSelectElement).value
													)}
											>
												<optgroup label="Starter Commander Precons (100 Cards)">
													{#each preconDecks as p (p.id)}
														<option value={p.id}>
															[Precon] {p.name} ({p.colorIdentity.join('')})
														</option>
													{/each}
												</optgroup>
												{#if userDecks.length > 0}
													<optgroup label="My Imported Decks">
														{#each userDecks as d (d.id)}
															<option value={d.id}>
																{d.name} ({d.cardCount} cards · {d.isLegal
																	? 'Legal'
																	: 'Rule 0'})
															</option>
														{/each}
													</optgroup>
												{/if}
											</select>
										</label>
									</div>
								{/if}

								{#if isHost && seat.isBot && lobby.status === 'waiting'}
									<button
										type="button"
										class="btn-outline small"
										onclick={() => onRemoveBot(seat.seatIndex)}
									>
										Remove Bot
									</button>
								{:else if isHost && seat.userId && seat.userId !== user.id && !seat.isBot}
									<button
										type="button"
										class="btn-outline small"
										onclick={() => seat.userId && onTransferHost(seat.userId)}
									>
										Make Host
									</button>
								{/if}
							{:else}
								<div class="seat-empty">
									Waiting for player via code {lobby.code}...
								</div>
								{#if isHost && lobby.status === 'waiting'}
									<button
										type="button"
										class="btn-outline small"
										onclick={() => onAddBot(seat.seatIndex)}
									>
										+ Add AI Commander Bot
									</button>
								{/if}
							{/if}
						</div>
					</div>
				{/each}
			</div>

			<div class="launch-bar">
				{#if lobby.status === 'active' && lobby.gameState}
					<button type="button" class="btn-launch" onclick={onEnterMatch}>
						Enter Live Commander Arena
					</button>
				{:else if isHost}
					<button type="button" class="btn-launch" onclick={onStartMatch}>
						Start Commander Match ({lobby.seats.filter((s) => s.userId || s.isBot)
							.length} Players)
					</button>
				{:else}
					<span class="waiting-host"
						>Waiting for the lobby host to launch the match...</span
					>
				{/if}
			</div>
		</section>

		<!-- Host Rule 0 & Strict Rules Configurator -->
		<section class="card-panel">
			<div class="rules-head">
				<h2>Lobby Rules &amp; Host Customizations</h2>
				<span class="rules-sub">
					{isHost
						? 'You are the Host — changes sync live to all players'
						: 'Read-only (Host controls rules)'}
				</span>
			</div>

			<div class="rules-grid">
				<label>
					<span>Starting Life Total</span>
					<select
						disabled={!isHost}
						value={lobby.rules.startingLife}
						onchange={(e) =>
							onUpdateRules({
								startingLife: parseInt(
									(e.currentTarget as HTMLSelectElement).value,
									10
								)
							})}
					>
						<option value={20}>20 Life (1v1 / Brawl)</option>
						<option value={30}>30 Life (Fast Commander)</option>
						<option value={40}>40 Life (Official Commander Default)</option>
						<option value={50}>50 Life (Extended)</option>
						<option value={60}>60 Life (Marathon)</option>
					</select>
				</label>

				<label>
					<span>Commander Lethal Combat Damage</span>
					<select
						disabled={!isHost}
						value={lobby.rules.commanderDamageLethal}
						onchange={(e) =>
							onUpdateRules({
								commanderDamageLethal: parseInt(
									(e.currentTarget as HTMLSelectElement).value,
									10
								)
							})}
					>
						<option value={21}>21 Combat Damage (Official CR 903.10a)</option>
						<option value={15}>15 Combat Damage</option>
						<option value={25}>25 Combat Damage</option>
						<option value={0}>Disabled (No Commander Damage Lethal)</option>
					</select>
				</label>

				<label>
					<span>Commander Tax per Previous Cast</span>
					<select
						disabled={!isHost}
						value={lobby.rules.commanderTaxIncrement}
						onchange={(e) =>
							onUpdateRules({
								commanderTaxIncrement: parseInt(
									(e.currentTarget as HTMLSelectElement).value,
									10
								)
							})}
					>
						<option value={2}>+{2} Generic Mana (Official CR 903.8)</option>
						<option value={1}>+{1} Generic Mana</option>
						<option value={0}>+{0} (No Commander Tax)</option>
						<option value={3}>+{3} Generic Mana</option>
					</select>
				</label>

				<label>
					<span>Poison Counters Lethal</span>
					<select
						disabled={!isHost}
						value={lobby.rules.poisonLethal}
						onchange={(e) =>
							onUpdateRules({
								poisonLethal: parseInt(
									(e.currentTarget as HTMLSelectElement).value,
									10
								)
							})}
					>
						<option value={10}>10 Poison Counters (Official CR 704.5c)</option>
						<option value={15}>15 Poison Counters (House Rule)</option>
						<option value={20}>20 Poison Counters</option>
						<option value={0}>Disabled</option>
					</select>
				</label>

				<label>
					<span>Mulligan Policy</span>
					<select
						disabled={!isHost}
						value={lobby.rules.mulliganRule}
						onchange={(e) =>
							onUpdateRules({
								mulliganRule: (e.currentTarget as HTMLSelectElement)
									.value as LobbyRulesConfig['mulliganRule']
							})}
					>
						<option value="london_1free">London Mulligan (1st Mulligan Free)</option>
						<option value="friendly_unlimited"
							>Friendly Unlimited Free Mulligans</option
						>
						<option value="strict_london">Strict London (No Free Mulligan)</option>
					</select>
				</label>

				<label>
					<span>Deck Legality Enforcement</span>
					<select
						disabled={!isHost}
						value={lobby.rules.deckValidationMode}
						onchange={(e) =>
							onUpdateRules({
								deckValidationMode: (e.currentTarget as HTMLSelectElement)
									.value as LobbyRulesConfig['deckValidationMode']
							})}
					>
						<option value="strict_commander"
							>Strict Commander (100-card Singleton + Color Identity)</option
						>
						<option value="rule0_relaxed"
							>Rule 0 Anything Goes (Allow Custom / Non-Standard Decks)</option
						>
					</select>
				</label>

				<label>
					<span>Cards With Unsupported Abilities</span>
					<select
						disabled={!isHost}
						value={lobby.rules.allowUnsupportedCards === false ? 'block' : 'allow'}
						onchange={(e) =>
							onUpdateRules({
								allowUnsupportedCards:
									(e.currentTarget as HTMLSelectElement).value !== 'block'
							})}
					>
						<option value="allow">Allow (Players Resolve Them Manually)</option>
						<option value="block"
							>Block (Refuse to Start if Any Deck Has One)</option
						>
					</select>
				</label>

				<label>
					<span>MTG Arena Turn / Priority Rope Timer</span>
					<select
						disabled={!isHost}
						value={lobby.rules.turnTimerSeconds}
						onchange={(e) =>
							onUpdateRules({
								turnTimerSeconds: parseInt(
									(e.currentTarget as HTMLSelectElement).value,
									10
								)
							})}
					>
						<option value={90}>90 Seconds per Priority Window</option>
						<option value={60}>60 Seconds (Rapid)</option>
						<option value={120}>120 Seconds</option>
						<option value={0}>Untimed (Casual Pod)</option>
					</select>
				</label>

				<label>
					<span>AI Bot Action Pacing</span>
					<select
						disabled={!isHost}
						value={lobby.rules.botSpeed ?? 'normal'}
						onchange={(e) =>
							onUpdateRules({
								botSpeed: (e.currentTarget as HTMLSelectElement).value as BotSpeed
							})}
					>
						<option value="normal">Normal (0.9–1.6s per Action, Default)</option>
						<option value="fast">Fast (0.4–0.7s per Action)</option>
						<option value="slow">Slow (1.8–3.0s per Action)</option>
						<option value="instant">Instant (No Delay)</option>
					</select>
				</label>

				<label>
					<span>Pod Size (Max Seats)</span>
					<select
						disabled={!isHost || lobby.status !== 'waiting'}
						value={lobby.rules.maxPlayers}
						onchange={(e) =>
							onUpdateRules({
								maxPlayers: parseInt(
									(e.currentTarget as HTMLSelectElement).value,
									10
								) as 2 | 3 | 4
							})}
					>
						<option value={4}>4 Players (Standard Commander Pod)</option>
						<option value={3}>3 Players</option>
						<option value={2}>2 Players (1v1 Duel Commander)</option>
					</select>
				</label>
			</div>
		</section>
	</div>

	<!-- Vertical Drag Splitter for Chat Width -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="lobby-col-resizer"
		title="Drag to resize Live Pod Chat width"
		onmousedown={startLobbyChatResize}
	></div>

	<!-- Right Column: Live Pod Chat -->
	<aside class="lobby-chat-col card-panel">
		<div class="chat-panel-head">
			<h2>Live Pod Chat</h2>
			<label class="size-ctrl">
				<span>Height</span>
				<input
					type="range"
					class="sq-range"
					min="200"
					max="680"
					step="20"
					style="--range-pct: {Math.round(((lobbyChatHeight - 200) / (680 - 200)) * 100)}%;"
					bind:value={lobbyChatHeight}
				/>
			</label>
		</div>
		<div class="lobby-chat-feed" style="height: {lobbyChatHeight}px;">
			{#each chatMessages as m (m.id)}
				<div class="lchat-item kind-{m.kind}">
					<strong>{m.username}:</strong>
					<span>{m.message}</span>
				</div>
			{/each}
		</div>
		<form
			class="form-row"
			onsubmit={async (e) => {
				e.preventDefault();
				if (!lobbyChatInput.trim()) return;
				const text = lobbyChatInput.trim();
				lobbyChatInput = '';
				await onSendChat(text, 'chat');
			}}
		>
			<input type="text" placeholder="Message the pod..." bind:value={lobbyChatInput} />
			<button type="submit" class="btn-accent">Send</button>
		</form>
	</aside>
</div>

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
	.form-row {
		display: flex;
		gap: 0.5rem;
	}
	.form-row input,
	select {
		flex: 1;
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 6px;
		padding: 0.48rem 0.65rem;
		font-family: inherit;
		font-size: 0.82rem;
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
	.btn-outline.small {
		padding: 0.28rem 0.55rem;
		font-size: 0.72rem;
	}
	.code-badge {
		font-weight: 700;
		background: var(--mp-bg-subtle);
		color: var(--mp-accent);
		border: 1px solid var(--mp-border-strong);
		padding: 0.18rem 0.5rem;
		border-radius: 4px;
		margin-right: 0.5rem;
	}
	.code-badge.large {
		font-size: 1.05rem;
		letter-spacing: 0.08em;
	}

	.active-lobby-layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 8px var(--lobby-chat-w, 330px);
		gap: 0.5rem;
		align-items: start;
	}
	@media (max-width: 900px) {
		.active-lobby-layout {
			grid-template-columns: 1fr;
		}
		.lobby-col-resizer {
			display: none;
		}
	}
	.lobby-col-resizer {
		width: 8px;
		align-self: stretch;
		cursor: col-resize;
		border-radius: 4px;
		background: transparent;
		transition: background 0.15s ease;
	}
	.lobby-col-resizer:hover {
		background: var(--mp-accent);
	}

	.lobby-left-col {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.lobby-title-bar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.75rem;
	}
	.lobby-title-left {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		flex-wrap: wrap;
	}
	.invite-box {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		flex-wrap: wrap;
	}
	.invite-label {
		font-size: 0.72rem;
		color: var(--mp-text-muted);
	}

	.seats-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}
	@media (max-width: 680px) {
		.seats-grid {
			grid-template-columns: 1fr;
		}
	}
	.seat-card {
		position: relative;
		border-radius: 8px;
		border: 1px dashed var(--mp-border-strong);
		background: var(--mp-bg);
		padding: 0.85rem;
		overflow: hidden;
		min-height: 138px;
	}
	.seat-card.occupied {
		border-style: solid;
	}
	.seat-card.mine {
		border-color: var(--mp-cyan);
	}
	.seat-art {
		position: absolute;
		inset: 0;
		background-size: cover;
		background-position: center;
		opacity: 0.32;
		pointer-events: none;
	}
	.seat-content {
		position: relative;
		z-index: 2;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.seat-top {
		display: flex;
		justify-content: space-between;
		font-size: 0.7rem;
		color: var(--mp-text-muted);
	}
	.host-pill,
	.bot-pill {
		font-weight: 700;
		color: var(--mp-accent);
	}
	.guest-pill {
		font-weight: 700;
		color: var(--mp-cyan);
	}
	.seat-player-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.4rem;
	}
	.seat-player {
		font-size: 1rem;
		font-weight: 700;
	}
	.seat-deck {
		display: flex;
		flex-direction: column;
		font-size: 0.76rem;
		color: var(--mp-text-body);
	}
	.seat-cmdr {
		color: var(--mp-cyan);
		font-size: 0.72rem;
	}
	.seat-deck-picker label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.72rem;
		margin-top: 0.25rem;
	}
	.seat-empty {
		font-size: 0.78rem;
		color: var(--mp-text-muted);
	}

	.launch-bar {
		display: flex;
		justify-content: flex-end;
		padding-top: 0.4rem;
	}
	.btn-launch {
		background: linear-gradient(135deg, #e14775, #d45c1e);
		color: #ffffff;
		border: none;
		border-radius: 8px;
		padding: 0.75rem 1.35rem;
		font-family: inherit;
		font-size: 0.92rem;
		font-weight: 700;
		cursor: pointer;
	}
	.waiting-host {
		font-size: 0.8rem;
		color: var(--mp-text-muted);
	}

	.rules-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.rules-sub {
		font-size: 0.74rem;
		color: var(--mp-text-muted);
	}
	.rules-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}
	@media (max-width: 680px) {
		.rules-grid {
			grid-template-columns: 1fr;
		}
	}
	.rules-grid label {
		display: flex;
		flex-direction: column;
		gap: 0.28rem;
		font-size: 0.76rem;
		font-weight: 600;
	}

	.chat-panel-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
	}
	.size-ctrl {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		font-size: 0.72rem;
		color: var(--mp-text-muted);
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

	.lobby-chat-feed {
		overflow-y: auto;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border);
		border-radius: 6px;
		padding: 0.6rem;
		display: flex;
		flex-direction: column;
		gap: 0.38rem;
		font-size: 0.78rem;
	}
	.lchat-item.kind-system {
		color: var(--mp-orange);
	}
</style>
