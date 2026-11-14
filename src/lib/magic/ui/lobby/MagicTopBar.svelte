<script lang="ts">
	import type { MagicUser } from '../../types.ts';

	interface DevAccountPreset {
		username: string;
		provider: string;
		email?: string;
	}

	interface Props {
		homeHref: string;
		user: MagicUser | null;
		activeTab: 'lobbies' | 'decks';
		userDeckCount: number;
		theme: 'light' | 'dark';
		testPresets?: DevAccountPreset[];
		onSelectTab: (tab: 'lobbies' | 'decks') => void;
		onLogout: () => void;
		onToggleTheme: () => void;
		onDevLogin?: (preset: DevAccountPreset) => void;
	}

	let {
		homeHref,
		user,
		activeTab,
		userDeckCount,
		theme,
		testPresets = [],
		onSelectTab,
		onLogout,
		onToggleTheme,
		onDevLogin
	}: Props = $props();

	let showDevMenu = $state(false);
</script>

<svelte:window onclick={() => (showDevMenu = false)} />

<header class="topbar">
	<div class="brand-nav">
		<a href={homeHref} class="brand-link">peckhamr.com</a>
		<span class="sep">/</span>
		<span class="brand-current">magic commander</span>
	</div>

	<div class="user-nav">
		{#if user}
			<button
				type="button"
				class="tab-btn"
				class:active={activeTab === 'lobbies'}
				onclick={() => onSelectTab('lobbies')}
			>
				Private Lobbies
			</button>
			<button
				type="button"
				class="tab-btn"
				class:active={activeTab === 'decks'}
				onclick={() => onSelectTab('decks')}
			>
				{user.provider === 'guest' ? 'Decks & Precons' : `My Decks (${userDeckCount})`}
			</button>
			<span class="user-chip">
				<span class="provider-dot {user.provider}"></span>
				{#if user.provider === 'guest'}
					<span class="guest-tag">[GUEST]</span>
				{/if}
				{user.username}
			</span>

			{#if onDevLogin && testPresets.length > 0}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="dev-quick-wrap" onclick={(e) => e.stopPropagation()}>
					<button
						type="button"
						class="btn-outline"
						title="Quickly switch local test seat account"
						onclick={() => (showDevMenu = !showDevMenu)}
					>
						Switch Seat ▾
					</button>
					{#if showDevMenu}
						<div class="dev-quick-menu" role="menu">
							{#each testPresets as preset, idx (preset.username)}
								<button
									type="button"
									class="dev-quick-item"
									class:current={user.username === preset.username}
									onclick={() => {
										showDevMenu = false;
										onDevLogin(preset);
									}}
								>
									<span class="dq-seat">Seat {idx + 1}</span>
									<strong>{preset.username}</strong>
								</button>
							{/each}
						</div>
					{/if}
				</div>
			{/if}

			<button type="button" class="btn-outline" onclick={onLogout}>
				{user.provider === 'guest' ? 'Leave Guest' : 'Sign Out'}
			</button>
		{/if}

		<button
			type="button"
			class="theme-btn"
			onclick={onToggleTheme}
			aria-label="Toggle color theme"
			title={theme === 'light' ? 'Switch to Monokai Pro Dark' : 'Switch to Monokai Pro Light'}
		>
			<svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">
				{#if theme === 'light'}
					<path
						d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z"
						fill="currentColor"
					/>
				{:else}
					<circle cx="10" cy="10" r="4.2" fill="currentColor" />
					<path
						d="M10 1.5v2.2M10 16.3v2.2M1.5 10h2.2M16.3 10h2.2M4 4l1.6 1.6M14.4 14.4L16 16M16 4l-1.6 1.6M5.6 14.4L4 16"
						stroke="currentColor"
						stroke-width="1.6"
						stroke-linecap="round"
					/>
				{/if}
			</svg>
			<span>{theme === 'light' ? 'Dark' : 'Light'}</span>
		</button>
	</div>
</header>

<style>
	.topbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.75rem;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid var(--mp-border);
	}
	.brand-nav,
	.user-nav {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		flex-wrap: wrap;
	}
	.brand-link {
		color: var(--mp-text-muted);
		font-size: 0.85rem;
	}
	.brand-current {
		font-weight: 700;
		color: var(--mp-accent);
	}
	.sep {
		color: var(--mp-text-faint);
	}

	.theme-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.34rem 0.65rem;
		border-radius: 6px;
		border: 1px solid var(--mp-border-strong);
		background: var(--mp-bg-elevated);
		color: var(--mp-text-muted);
		font-family: inherit;
		font-size: 0.76rem;
		font-weight: 600;
		cursor: pointer;
		transition:
			color 0.15s ease,
			border-color 0.15s ease;
	}
	.theme-btn:hover {
		color: var(--mp-accent);
		border-color: var(--mp-accent);
	}

	.tab-btn {
		background: var(--mp-bg-elevated);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 6px;
		padding: 0.38rem 0.75rem;
		font-family: inherit;
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
	}
	.tab-btn.active {
		background: var(--mp-btn-bg);
		color: var(--mp-btn-fg);
		border-color: var(--mp-btn-bg);
	}

	.user-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.8rem;
		padding: 0.3rem 0.6rem;
		border-radius: 6px;
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border);
	}
	.provider-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--mp-green);
	}
	.provider-dot.guest {
		background: var(--mp-cyan);
	}
	.guest-tag {
		font-size: 0.7rem;
		font-weight: 700;
		color: var(--mp-cyan);
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

	.dev-quick-wrap {
		position: relative;
	}
	.dev-quick-menu {
		position: absolute;
		top: calc(100% + 4px);
		right: 0;
		z-index: 90;
		min-width: 190px;
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border-strong);
		border-radius: 7px;
		padding: 0.3rem;
		box-shadow: 0 12px 28px rgba(0, 0, 0, 0.55);
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.dev-quick-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1px solid transparent;
		border-radius: 5px;
		padding: 0.36rem 0.55rem;
		font-family: inherit;
		font-size: 0.74rem;
		cursor: pointer;
		text-align: left;
	}
	.dev-quick-item:hover,
	.dev-quick-item.current {
		border-color: var(--mp-cyan);
	}
	.dq-seat {
		font-size: 0.65rem;
		color: var(--mp-cyan);
	}
</style>
