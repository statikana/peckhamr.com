<script lang="ts">
	import type { MagicUser } from '../../types.ts';

	export interface LobbySummaryItem {
		code: string;
		name: string;
		status: string;
		hostUserId: string;
		playerCount: number;
		maxPlayers: number;
		updatedAt: number;
	}

	interface Props {
		user: MagicUser;
		joinCodeInput?: string;
		newLobbyName?: string;
		myLobbies: LobbySummaryItem[];
		onJoinLobby: (code: string) => void;
		onCreateLobby: () => void;
		onLeaveLobby: (code: string) => void;
		onLogout: () => void;
	}

	let {
		user,
		joinCodeInput = $bindable(''),
		newLobbyName = $bindable(''),
		myLobbies,
		onJoinLobby,
		onCreateLobby,
		onLeaveLobby,
		onLogout
	}: Props = $props();
</script>

<div class="lobby-hub-grid">
	<section class="card-panel">
		<h2>Join Private Lobby with Invite Code</h2>
		<p class="panel-sub">
			Enter a 6-character private invite code shared by the lobby host to take an open seat.
		</p>
		<form
			class="form-row"
			onsubmit={(e) => {
				e.preventDefault();
				onJoinLobby(joinCodeInput);
			}}
		>
			<input
				type="text"
				placeholder="e.g. EDH7X9"
				maxlength="8"
				bind:value={joinCodeInput}
			/>
			<button type="submit" class="btn-accent">Join Pod</button>
		</form>
	</section>

	<section class="card-panel">
		<h2>Create Private Commander Lobby</h2>
		{#if user.provider === 'guest'}
			<p class="panel-sub">
				You are currently browsing as a Guest (<strong>{user.username}</strong>). Sign in
				with a Google or GitHub account to create and host new private lobbies and save
				custom decks.
			</p>
			<div class="form-row">
				<button type="button" class="btn-outline" onclick={onLogout}>
					Sign In with Account to Host
				</button>
			</div>
		{:else}
			<p class="panel-sub">
				Host a private pod with a 6-character invite code, customize Commander rules, and
				invite friends or guests.
			</p>
			<div class="form-row">
				<input
					type="text"
					placeholder="{user.username}'s Commander Pod"
					bind:value={newLobbyName}
				/>
				<button type="button" class="btn-accent" onclick={onCreateLobby}>
					Create Private Lobby
				</button>
			</div>
		{/if}
	</section>
</div>

{#if myLobbies.length > 0}
	<section class="card-panel">
		<h2>Your Recent &amp; Active Commander Pods</h2>
		<div class="lobby-list">
			{#each myLobbies as l (l.code)}
				<div class="lobby-row">
					<div>
						<span class="code-badge">{l.code}</span>
						<strong>{l.name}</strong>
						<span class="status-tag {l.status}">{l.status}</span>
					</div>
					<div class="lobby-row-right">
						<span>{l.playerCount}/{l.maxPlayers} Seats</span>
						<button
							type="button"
							class="btn-accent"
							onclick={() => onJoinLobby(l.code)}
						>
							{l.status === 'active' ? 'Rejoin Match' : 'Open Lobby'}
						</button>
						<button
							type="button"
							class="btn-outline"
							onclick={() => onLeaveLobby(l.code)}
						>
							Leave
						</button>
					</div>
				</div>
			{/each}
		</div>
	</section>
{/if}

<style>
	.lobby-hub-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}
	@media (max-width: 760px) {
		.lobby-hub-grid {
			grid-template-columns: 1fr;
		}
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
	.form-row {
		display: flex;
		gap: 0.5rem;
	}
	.form-row input {
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
	.lobby-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.lobby-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
		padding: 0.6rem 0.75rem;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border);
		border-radius: 6px;
	}
	.lobby-row-right {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		font-size: 0.8rem;
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
	.status-tag {
		margin-left: 0.45rem;
		font-size: 0.7rem;
		color: var(--mp-text-muted);
		text-transform: uppercase;
	}
</style>
