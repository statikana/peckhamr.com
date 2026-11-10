<script lang="ts">
    import { onMount } from "svelte";
    import { page } from "$app/state";
    import { appUrl } from "../../lib/apps";
    import Terminal from "../../Terminal.svelte";

    let theme = $state<"light" | "dark">("light");

    function toggleTheme() {
        theme = theme === "light" ? "dark" : "light";
        document.documentElement.setAttribute("data-theme", theme);
        try {
            localStorage.setItem("peckhamr-theme", theme);
        } catch (e) {}
    }

    onMount(() => {
        const current = document.documentElement.getAttribute("data-theme");
        if (current === "dark" || current === "light") {
            theme = current;
        }
    });
</script>

<div class="terminal-fullscreen-shell">
    <header class="terminal-topbar">
        <div class="topbar-left">
            <a href={appUrl("home", "/", page.url)} class="back-link">← peckhamr.com</a>
            <span class="topbar-divider">/</span>
            <span class="topbar-prompt">guest@peckhamr.com</span>
        </div>
        <div class="topbar-actions">
            <button
                type="button"
                class="theme-toggle-btn"
                onclick={toggleTheme}
                aria-label="Toggle color theme"
                title={theme === "light" ? "Switch to Monokai Pro Dark" : "Switch to Monokai Pro Light"}
            >
                {#if theme === "light"}
                    <span class="theme-icon">☾</span>
                    <span>Dark</span>
                {:else}
                    <span class="theme-icon">☀</span>
                    <span>Light</span>
                {/if}
            </button>
        </div>
    </header>

    <main class="terminal-fullscreen-body">
        <Terminal />
    </main>
</div>

<style>
    .terminal-fullscreen-shell {
        min-height: 100vh;
        width: 100%;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        background-color: var(--mp-bg);
        color: var(--mp-text);
        transition: background-color 0.18s ease, color 0.18s ease;
    }

    .terminal-topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.65rem 1.25rem;
        background-color: var(--mp-bg-subtle);
        border-bottom: 1px solid var(--mp-border);
        font-family: var(--mono-font, monospace);
        font-size: 0.82rem;
        transition: background-color 0.18s ease, border-color 0.18s ease;
    }

    .topbar-left {
        display: flex;
        align-items: center;
        gap: 0.6rem;
    }

    .back-link {
        color: var(--mp-cyan);
        text-decoration: none;
        font-weight: 600;
    }

    .back-link:hover {
        color: var(--mp-red);
    }

    .topbar-divider {
        color: var(--mp-text-faint);
    }

    .topbar-prompt {
        color: var(--mp-green);
        font-weight: 600;
    }

    .topbar-actions {
        display: flex;
        align-items: center;
        gap: 0.75rem;
    }

    .theme-toggle-btn {
        display: inline-flex;
        align-items: center;
        gap: 0.38rem;
        background-color: var(--mp-bg-elevated);
        color: var(--mp-text-body);
        border: 1px solid var(--mp-border-strong);
        border-radius: 4px;
        padding: 0.28rem 0.62rem;
        font-family: var(--mono-font, monospace);
        font-size: 0.76rem;
        font-weight: 600;
        cursor: pointer;
        transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    }

    .theme-toggle-btn:hover {
        background-color: var(--mp-bg-hover);
        border-color: var(--mp-red);
        color: var(--mp-red);
    }

    .theme-icon {
        font-size: 0.85rem;
        line-height: 1;
        color: var(--mp-orange);
    }

    .terminal-fullscreen-body {
        flex: 1;
        width: 100%;
        box-sizing: border-box;
        padding: 1.25rem 1.5rem;
        background-color: var(--mp-bg-elevated);
        transition: background-color 0.18s ease, color 0.18s ease;
    }
</style>
