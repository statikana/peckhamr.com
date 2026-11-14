<script lang="ts">
	import ManaSymbol from '../../ManaSymbol.svelte';

	interface DevAccountPreset {
		username: string;
		provider: string;
		email?: string;
	}

	interface Props {
		guestNameInput?: string;
		guestJoinCodeInput?: string;
		customTestName?: string;
		authNotice: string;
		googleAuthHref: string;
		githubAuthHref: string;
		testPresets: DevAccountPreset[];
		onGuestJoin: () => void;
		onDevLogin: (preset: DevAccountPreset) => void;
	}

	let {
		guestNameInput = $bindable(''),
		guestJoinCodeInput = $bindable(''),
		customTestName = $bindable(''),
		authNotice,
		googleAuthHref,
		githubAuthHref,
		testPresets,
		onGuestJoin,
		onDevLogin
	}: Props = $props();
</script>

<section class="auth-hero">
	<div class="auth-card">
		<div class="auth-badge-row">
			<span class="auth-badge">COMMANDER / EDH LIVE ARENA</span>
			<span class="mana-row">
				<ManaSymbol symbol="W" size={18} />
				<ManaSymbol symbol="U" size={18} />
				<ManaSymbol symbol="B" size={18} />
				<ManaSymbol symbol="R" size={18} />
				<ManaSymbol symbol="G" size={18} />
				<ManaSymbol symbol="T" size={18} />
			</span>
		</div>
		<h1>Magic: The Gathering Commander</h1>
		<p class="auth-sub">
			Strictly rules-enforced 4-player Commander pods with live Scryfall deck imports,
			LIFO Stack &amp; priority engine, Commander Tax &amp; 21 combat damage tracking,
			customizable Host Rule 0 settings, VFX, and live pod chat.
		</p>

		<!-- Guest Quick Join for Private Lobbies -->
		<div class="guest-join-box">
			<div class="guest-join-head">
				<strong>Join Private Lobby as Guest</strong>
				<span class="guest-join-sub"
					>No account required — enter a display name &amp; invite code</span
				>
			</div>
			<form
				class="guest-join-form"
				onsubmit={(e) => {
					e.preventDefault();
					onGuestJoin();
				}}
			>
				<input
					type="text"
					placeholder="Your Guest Display Name..."
					maxlength="32"
					bind:value={guestNameInput}
				/>
				<input
					type="text"
					class="guest-code-input"
					placeholder="Invite Code (e.g. EDH7X9)"
					maxlength="8"
					bind:value={guestJoinCodeInput}
				/>
				<button type="submit" class="btn-accent">
					{guestJoinCodeInput.trim() ? 'Join Pod as Guest' : 'Continue as Guest'}
				</button>
			</form>
		</div>

		<div class="auth-section-label">
			<span>Full Account Sign-In (Host Lobbies &amp; Save Decks)</span>
		</div>

		{#if authNotice}
			<div class="oauth-notice">{authNotice}</div>
		{/if}

		<div class="oauth-buttons">
			<a class="oauth-btn google" href={googleAuthHref}>
				<span class="oauth-icon">G</span>
				<span>Continue with Google OAuth</span>
			</a>
			<a class="oauth-btn github" href={githubAuthHref}>
				<span class="oauth-icon">GH</span>
				<span>Continue with GitHub OAuth</span>
			</a>
		</div>

		<div class="dev-switcher">
			<div class="dev-head">
				<span>Multi-Seat / Local OAuth Test Accounts</span>
				<span class="dev-caption">
					Per-tab session isolation — open 4 tabs to test a 4-human pod
				</span>
			</div>
			<div class="preset-grid">
				{#each testPresets as pw, idx (pw.username)}
					<button type="button" class="preset-btn" onclick={() => onDevLogin(pw)}>
						<span class="seat-num">Seat {idx + 1}</span>
						<strong>{pw.username}</strong>
						<span class="prov-tag">{pw.provider}</span>
					</button>
				{/each}
			</div>
			<form
				class="custom-login-row"
				onsubmit={(e) => {
					e.preventDefault();
					if (customTestName.trim()) {
						onDevLogin({
							username: customTestName.trim(),
							provider: 'github'
						});
					}
				}}
			>
				<input
					type="text"
					placeholder="Or enter custom Planeswalker account name..."
					bind:value={customTestName}
				/>
				<button type="submit" class="btn-accent">Sign In</button>
			</form>
		</div>
	</div>
</section>

<style>
	.mana-row {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
	}

	.auth-hero {
		display: flex;
		justify-content: center;
		padding: 1.5rem 0;
	}
	.auth-card {
		max-width: 42rem;
		width: 100%;
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border-strong);
		border-radius: 10px;
		padding: 1.75rem;
		display: flex;
		flex-direction: column;
		gap: 1.1rem;
	}
	.auth-badge-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.auth-badge {
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		color: var(--mp-accent);
		background: var(--mp-bg-subtle);
		padding: 0.25rem 0.6rem;
		border-radius: 4px;
	}
	.auth-card h1 {
		margin: 0;
		font-size: 1.65rem;
	}
	.auth-sub {
		margin: 0;
		color: var(--mp-text-body);
		font-size: 0.9rem;
		line-height: 1.55;
	}
	.guest-join-box {
		padding: 0.95rem 1rem;
		border-radius: 8px;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border-strong);
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
	}
	.guest-join-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 0.35rem;
		font-size: 0.84rem;
	}
	.guest-join-sub {
		font-size: 0.72rem;
		color: var(--mp-text-muted);
	}
	.guest-join-form {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.guest-join-form input {
		flex: 1 1 160px;
		background: var(--mp-bg-elevated);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 6px;
		padding: 0.48rem 0.65rem;
		font-family: inherit;
		font-size: 0.82rem;
	}
	.guest-join-form input.guest-code-input {
		flex: 0 1 170px;
		text-transform: uppercase;
		font-weight: 700;
		letter-spacing: 0.04em;
	}
	.auth-section-label {
		font-size: 0.74rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--mp-text-muted);
		padding-top: 0.25rem;
	}
	.oauth-notice {
		padding: 0.65rem;
		border-radius: 6px;
		background: var(--mp-bg-subtle);
		border-left: 3px solid var(--mp-orange);
		font-size: 0.78rem;
	}
	.oauth-buttons {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}
	@media (max-width: 640px) {
		.oauth-buttons {
			grid-template-columns: 1fr;
		}
	}
	.oauth-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.55rem;
		padding: 0.7rem 1rem;
		border-radius: 6px;
		font-weight: 700;
		font-size: 0.85rem;
		border: 1px solid var(--mp-border-strong);
		background: var(--mp-bg);
		color: var(--mp-text);
		transition:
			border-color 0.15s ease,
			transform 0.15s ease;
	}
	.oauth-btn:hover {
		border-color: var(--mp-accent);
		transform: translateY(-1px);
	}
	.oauth-icon {
		font-weight: 800;
		color: var(--mp-accent);
	}

	.dev-switcher {
		border-top: 1px solid var(--mp-border);
		padding-top: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
	}
	.dev-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		flex-wrap: wrap;
		font-size: 0.78rem;
		font-weight: 700;
	}
	.dev-caption {
		font-size: 0.7rem;
		font-weight: 400;
		color: var(--mp-text-muted);
	}
	.preset-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(145px, 1fr));
		gap: 0.5rem;
	}
	.preset-btn {
		background: var(--mp-bg);
		border: 1px solid var(--mp-border-strong);
		border-radius: 6px;
		padding: 0.5rem 0.65rem;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.15rem;
		font-family: inherit;
		color: var(--mp-text);
		cursor: pointer;
	}
	.preset-btn:hover {
		border-color: var(--mp-cyan);
	}
	.seat-num {
		font-size: 0.65rem;
		color: var(--mp-cyan);
	}
	.prov-tag {
		font-size: 0.62rem;
		color: var(--mp-text-muted);
	}
	.custom-login-row {
		display: flex;
		gap: 0.5rem;
	}
	.custom-login-row input {
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
</style>
