<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { appUrl } from '$lib/apps';
	import ArenaTable from '../../lib/magic/ArenaTable.svelte';
	import {
		cardSupportReport,
		deckUnsupportedCards,
		displayAbilityText,
		type UnsupportedAbilityReport
	} from '../../lib/magic/compiler/support';
	import { inspectCardContinuousBreakdown } from '../../lib/magic/engine';
	import ManaSymbol from '../../lib/magic/ManaSymbol.svelte';
	import ManaText from '../../lib/magic/ManaText.svelte';
	import { matchesScryfallQuery } from '../../lib/magic/search';
	import {
		DEFAULT_LOBBY_RULES,
		type GameActionPayload,
		type LobbyRulesConfig,
		type MagicChatMessage,
		type MagicDeck,
		type MagicLobby,
		type MagicUser,
		type ScryfallCard
	} from '../../lib/magic/types';

	let user = $state<MagicUser | null>(null);
	let sessionToken = $state<string>('');
	let oauthConfigured = $state<{ google: boolean; github: boolean }>({
		google: false,
		github: false
	});
	let authNotice = $state('');
	let statusMsg = $state('');
	let errorMsg = $state('');
	let loading = $state(true);

	// Theme state synced with global peckhamr-theme
	let theme = $state<'light' | 'dark'>('light');

	function applyTheme(next: 'light' | 'dark') {
		theme = next === 'dark' ? 'dark' : 'light';
		if (typeof document !== 'undefined') {
			document.documentElement.setAttribute('data-theme', theme);
		}
		try {
			localStorage.setItem('peckhamr-theme', theme);
		} catch {}
	}

	function toggleTheme() {
		applyTheme(theme === 'light' ? 'dark' : 'light');
	}

	// Hold ALT for floating card preview over cursor
	let altHeld = $state(false);
	let hoveredCard = $state<ScryfallCard | null>(null);
	let mouseX = $state(0);
	let mouseY = $state(0);

	const altPreviewPos = $derived.by(() => {
		const vw = typeof window !== 'undefined' ? window.innerWidth : 1400;
		const vh = typeof window !== 'undefined' ? window.innerHeight : 900;
		const imgW = 248;
		const imgH = 345;
		const detailsH = 148;
		const sideDetailsW = 224;

		const stackedTotalH = imgH + detailsH;
		const idealStackedY = mouseY - stackedTotalH * 0.42;
		const wouldOverflowVertically =
			idealStackedY < 14 || idealStackedY + stackedTotalH > vh - 14 || vh < 660;

		const sideMode = wouldOverflowVertically && vw >= imgW + sideDetailsW + 40;
		const totalW = sideMode ? imgW + sideDetailsW : imgW;
		const totalH = sideMode ? imgH : stackedTotalH;

		let x = mouseX + 24;
		let placeLeft = false;
		if (x + totalW > vw - 12) {
			if (mouseX - 24 - totalW >= 12) {
				x = mouseX - 24 - totalW;
				placeLeft = true;
			} else {
				x = Math.max(12, vw - totalW - 12);
			}
		}

		let y = mouseY - totalH * 0.45;
		if (y < 12) y = 12;
		if (y + totalH > vh - 12) y = Math.max(12, vh - totalH - 12);

		return { x, y, sideMode, placeLeft };
	});

	// Adjustable UI dimensions in Lobby & Deck Inspector
	let lobbyChatWidth = $state(330);
	let lobbyChatHeight = $state(360);
	let inspectCardsPerRow = $state(5);
	let resizingChatCol = $state(false);
	let resizeStartX = 0;
	let resizeStartWidth = 330;

	function startLobbyChatResize(e: MouseEvent) {
		e.preventDefault();
		resizingChatCol = true;
		resizeStartX = e.clientX;
		resizeStartWidth = lobbyChatWidth;
	}

	// Navigation tabs
	let activeTab = $state<'lobbies' | 'decks'>('lobbies');

	// Decks state
	let userDecks = $state<MagicDeck[]>([]);
	let preconDecks = $state<MagicDeck[]>([]);
	let inspectedDeck = $state<MagicDeck | null>(null);
	let inspectSortBy = $state<'none' | 'cmc' | 'name' | 'color' | 'type'>('none');
	let inspectSortDir = $state<'asc' | 'desc'>('asc');
	let inspectSearchQuery = $state('');
	let addCardQtyInput = $state(1);
	let addingCardBusy = $state(false);
	let searchingScryfallBusy = $state(false);
	let addCardSearchResults = $state<ScryfallCard[]>([]);
	let showScryfallDropdown = $state(false);
	let dropdownHighlightIdx = $state(-1);
	let searchRequestSeq = 0;
	let activeCardMenuKey = $state<string | null>(null);
	let customMenuQty = $state(1);
	let inspectStatusMsg = $state('');
	let inspectErrorMsg = $state('');
	let showImportModal = $state(false);
	let importingDeck = $state(false);
	let importName = $state('');
	let importCommander = $state('');
	let importDecklist = $state('');

	const importEstimatedCount = $derived.by(() => {
		let total = 0;
		for (const raw of importDecklist.split('\n')) {
			const line = raw.trim();
			if (!line || line.startsWith('//') || line.startsWith('#') || /^[a-z ]+:$/i.test(line)) {
				continue;
			}
			const m = line.match(/^(\d+)x?\s+/i);
			total += m ? parseInt(m[1], 10) || 1 : 1;
		}
		return total;
	});

	const isInspectedReadOnly = $derived(
		Boolean(inspectedDeck && (inspectedDeck.isPrecon || inspectedDeck.userId === 'system_precon'))
	);

	function safeCssArtUrl(url: string | undefined): string {
		if (!url) return '';
		return url.replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
	}

	// Plan section 2.7: abilities the engine won't automate. A warning only; never a legality error.
	const inspectedUnsupported = $derived(
		inspectedDeck ? deckUnsupportedCards(inspectedDeck.commanders, inspectedDeck.cards) : []
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
		if (!inspectedDeck) return [];
		return (inspectedDeck.commanders || []).filter((cmd) =>
			matchesScryfallQuery(cmd, inspectSearchQuery, 1)
		);
	});

	const sortedInspectedCards = $derived.by(() => {
		if (!inspectedDeck) return [];
		const raw = (inspectedDeck.cards || []).filter((entry) =>
			matchesScryfallQuery(entry.card, inspectSearchQuery, entry.quantity)
		);
		if (inspectSortBy === 'none') return raw;
		const dir = inspectSortDir === 'desc' ? -1 : 1;
		const colorRank = (card: ScryfallCard): number => {
			if (card.typeLine.includes('Land') && (!card.colors || card.colors.length === 0)) return 7;
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

	// Lobbies state
	let myLobbies = $state<
		Array<{
			code: string;
			name: string;
			status: string;
			hostUserId: string;
			playerCount: number;
			maxPlayers: number;
			updatedAt: number;
		}>
	>([]);
	// Raw, not deep: the lobby is always replaced whole (never mutated in place), and the table runs
	// engine code over gameState, which is far slower through deep reactive proxies.
	let activeLobby = $state.raw<MagicLobby | null>(null);
	const pageHoverBreakdown = $derived(
		hoveredCard
			? inspectCardContinuousBreakdown(hoveredCard, activeLobby?.gameState || undefined)
			: null
	);
	let lobbyChat = $state<MagicChatMessage[]>([]);
	let inMatchView = $state(false);
	let actionInFlight = $state(false);

	let newLobbyName = $state('');
	let joinCodeInput = $state('');
	let guestNameInput = $state('');
	let guestJoinCodeInput = $state('');
	let lobbyChatInput = $state('');

	// Dev / Test Planeswalker presets for multi-tab testing
	const TEST_PLANESWALKERS = [
		{ username: 'Jace Beleren', provider: 'google', email: 'jace@ravnica.mtg' },
		{ username: 'Liliana Vess', provider: 'github', email: 'liliana@strixhaven.mtg' },
		{ username: 'Chandra Nalaar', provider: 'google', email: 'chandra@kaladesh.mtg' },
		{ username: 'Teferi Akosa', provider: 'github', email: 'teferi@zhalfir.mtg' }
	];
	let customTestName = $state('');

	function authHeaders(): Record<string, string> {
		const h: Record<string, string> = { 'Content-Type': 'application/json' };
		if (sessionToken) {
			h['X-Magic-Session'] = sessionToken;
		}
		return h;
	}

	async function apiFetch(path: string, init?: RequestInit): Promise<any> {
		const headers = {
			...authHeaders(),
			...(init?.headers || {})
		};
		const res = await fetch(path, { ...init, headers, cache: 'no-store' });
		const text = await res.text();
		try {
			return JSON.parse(text);
		} catch {
			return { ok: false, error: `Request failed (${res.status}).` };
		}
	}

	async function loadInitialState() {
		loading = true;
		try {
			const params = new URLSearchParams(window.location.search);
			const urlToken = params.get('session_token');
			if (urlToken) {
				sessionToken = urlToken;
				try {
					sessionStorage.setItem('magic_session_token', urlToken);
				} catch {}
			} else {
				try {
					sessionToken = sessionStorage.getItem('magic_session_token') || '';
				} catch {}
			}

			const oauthSetup = params.get('oauth_setup');
			if (oauthSetup) {
				authNotice = `${oauthSetup.toUpperCase()}_CLIENT_ID is not yet set in environment variables. Use the Quick OAuth Test Switcher below or configure GOOGLE_CLIENT_ID / GITHUB_CLIENT_ID in .env.`;
			}

			const joinParam = params.get('join');
			if (joinParam) {
				joinCodeInput = joinParam.toUpperCase();
				guestJoinCodeInput = joinParam.toUpperCase();
			}

			const meData = await apiFetch(appUrl('magic', '/api/auth?action=me'));
			if (meData.ok) {
				user = meData.user;
				oauthConfigured = meData.oauthConfigured || { google: false, github: false };
			}

			if (user) {
				await Promise.all([fetchDecks(), fetchMyLobbies()]);
				if (joinCodeInput) {
					await joinLobbyByCode(joinCodeInput);
				}
			}
		} catch (err: any) {
			errorMsg = err?.message || 'Failed to load Commander service.';
		} finally {
			loading = false;
		}
	}

	async function fetchDecks() {
		const data = await apiFetch(appUrl('magic', '/api/decks'));
		if (data.ok) {
			userDecks = data.decks || [];
			preconDecks = data.precons || [];
		}
	}

	async function fetchMyLobbies() {
		const data = await apiFetch(appUrl('magic', '/api/lobby'));
		if (data.ok) {
			myLobbies = data.myLobbies || [];
		}
	}

	async function pollActiveLobby() {
		if (!activeLobby || !user || actionInFlight) return;
		const polledCode = activeLobby.code;
		try {
			const data = await apiFetch(
				appUrl('magic', `/api/lobby?code=${encodeURIComponent(polledCode)}`)
			);
			if (actionInFlight || !activeLobby || activeLobby.code !== polledCode) return;
			if (data.ok && data.lobby) {
				const nextLobby: MagicLobby = data.lobby;
				// Same version means same content: replacing it would re-render the whole table every poll.
				if (nextLobby.version > (activeLobby.version || 0)) {
					activeLobby = nextLobby;
					if (nextLobby.status === 'active' && nextLobby.gameState) {
						inMatchView = true;
					}
				}
				lobbyChat = data.chat || [];
			}
		} catch {
			// ignore transient poll error
		}
	}

	onMount(() => {
		try {
			const saved = localStorage.getItem('peckhamr-theme');
			if (saved === 'dark' || saved === 'light') {
				applyTheme(saved);
			} else {
				const attr = document.documentElement.getAttribute('data-theme');
				applyTheme(attr === 'dark' ? 'dark' : 'light');
			}
		} catch {
			applyTheme('light');
		}

		loadInitialState();
		const timer = setInterval(() => {
			if (activeLobby && user) {
				pollActiveLobby();
			}
		}, 1200);

		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Alt') {
				e.preventDefault();
				e.stopPropagation();
				altHeld = true;
			} else if (e.altKey) {
				altHeld = true;
			}
		};
		const onKeyUp = (e: KeyboardEvent) => {
			if (e.key === 'Alt') {
				e.preventDefault();
				e.stopPropagation();
				altHeld = false;
			} else if (!e.altKey) {
				altHeld = false;
			}
		};
		const onBlur = () => {
			altHeld = false;
			resizingChatCol = false;
		};
		const onMouseMove = (e: MouseEvent) => {
			mouseX = e.clientX;
			mouseY = e.clientY;
			if (e.altKey !== altHeld) altHeld = e.altKey;
			if (resizingChatCol) {
				const dx = resizeStartX - e.clientX;
				lobbyChatWidth = Math.max(250, Math.min(540, resizeStartWidth + dx));
			}
		};
		const onMouseUp = () => {
			resizingChatCol = false;
		};

		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('keyup', onKeyUp);
		window.addEventListener('blur', onBlur);
		window.addEventListener('mousemove', onMouseMove);
		window.addEventListener('mouseup', onMouseUp);

		return () => {
			clearInterval(timer);
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('keyup', onKeyUp);
			window.removeEventListener('blur', onBlur);
			window.removeEventListener('mousemove', onMouseMove);
			window.removeEventListener('mouseup', onMouseUp);
		};
	});

	async function handleDevLogin(preset: {
		username: string;
		provider: string;
		email?: string;
	}) {
		errorMsg = '';
		const data = await apiFetch(appUrl('magic', '/api/auth'), {
			method: 'POST',
			body: JSON.stringify({
				action: 'dev_login',
				username: preset.username,
				provider: preset.provider,
				email: preset.email
			})
		});
		if (data.ok && data.user) {
			const signedUser: MagicUser = data.user;
			user = signedUser;
			sessionToken = data.token || '';
			try {
				sessionStorage.setItem('magic_session_token', sessionToken);
			} catch {}
			statusMsg = `Signed in as ${signedUser.username}`;
			await Promise.all([fetchDecks(), fetchMyLobbies()]);
			if (joinCodeInput) {
				await joinLobbyByCode(joinCodeInput);
			}
		} else {
			errorMsg = data.error || 'Sign-in failed.';
		}
	}

	async function handleGuestJoinLobby() {
		const trimmedName = guestNameInput.trim().slice(0, 32);
		const trimmedCode = guestJoinCodeInput.trim().toUpperCase();
		errorMsg = '';

		if (!trimmedName) {
			errorMsg = 'Please enter a guest display name.';
			return;
		}

		if (trimmedCode) {
			const data = await apiFetch(appUrl('magic', '/api/lobby'), {
				method: 'POST',
				body: JSON.stringify({
					action: 'join',
					code: trimmedCode,
					guestName: trimmedName
				})
			});
			if (data.user) {
				user = data.user;
				if (data.token) {
					sessionToken = data.token;
					try {
						sessionStorage.setItem('magic_session_token', sessionToken);
					} catch {}
				}
				await Promise.all([fetchDecks(), fetchMyLobbies()]);
			}
			if (data.ok && data.lobby) {
				const joinedLobby: MagicLobby = data.lobby;
				activeLobby = joinedLobby;
				lobbyChat = data.chat || [];
				if (joinedLobby.status === 'active' && joinedLobby.gameState) {
					inMatchView = true;
				}
				statusMsg = `Joined private lobby ${joinedLobby.code} as guest ${trimmedName}`;
			} else {
				joinCodeInput = trimmedCode;
				errorMsg = data.error || 'Could not join lobby.';
			}
			return;
		}

		const authData = await apiFetch(appUrl('magic', '/api/auth'), {
			method: 'POST',
			body: JSON.stringify({
				action: 'guest_login',
				username: trimmedName
			})
		});
		if (authData.ok && authData.user) {
			const guestUser: MagicUser = authData.user;
			user = guestUser;
			sessionToken = authData.token || '';
			try {
				sessionStorage.setItem('magic_session_token', sessionToken);
			} catch {}
			statusMsg = `Entered guest mode as ${guestUser.username}. Enter a 6-character invite code to join a private lobby.`;
			await Promise.all([fetchDecks(), fetchMyLobbies()]);
		} else {
			errorMsg = authData.error || 'Guest login failed.';
		}
	}

	async function leaveLobbyByCode(code: string) {
		if (!code) return;
		errorMsg = '';
		const data = await apiFetch(appUrl('magic', '/api/lobby'), {
			method: 'POST',
			body: JSON.stringify({
				action: 'leave',
				code
			})
		});
		if (activeLobby?.code === code) {
			activeLobby = null;
			inMatchView = false;
			lobbyChat = [];
		}
		if (data.deleted) {
			statusMsg = `Left lobby ${code} (lobby deleted as no human players remain).`;
		} else {
			statusMsg = `Left lobby ${code}.`;
		}
		await fetchMyLobbies();
	}

	async function transferLobbyHost(targetUserId: string) {
		if (!activeLobby || !targetUserId) return;
		errorMsg = '';
		const data = await apiFetch(appUrl('magic', '/api/lobby'), {
			method: 'POST',
			body: JSON.stringify({
				action: 'transfer_host',
				code: activeLobby.code,
				targetUserId
			})
		});
		if (data.ok && data.lobby) {
			activeLobby = data.lobby;
			lobbyChat = data.chat || [];
		} else if (data.error) {
			errorMsg = data.error;
		}
	}

	async function handleLogout() {
		if (activeLobby) {
			try {
				await apiFetch(appUrl('magic', '/api/lobby'), {
					method: 'POST',
					body: JSON.stringify({
						action: 'leave',
						code: activeLobby.code
					})
				});
			} catch {}
		}
		await apiFetch(appUrl('magic', '/api/auth'), {
			method: 'POST',
			body: JSON.stringify({ action: 'logout' })
		});
		user = null;
		sessionToken = '';
		activeLobby = null;
		inMatchView = false;
		try {
			sessionStorage.removeItem('magic_session_token');
		} catch {}
	}

	function loadSampleDecklistIntoImporter() {
		importName = 'Atraxa Superfriends & Counters';
		importCommander = "Atraxa, Praetors' Voice";
		importDecklist = [
			'Commander:',
			"1 Atraxa, Praetors' Voice",
			'',
			'Deck:',
			'1 Sol Ring',
			'1 Arcane Signet',
			'1 Chromatic Lantern',
			'1 Fellwar Stone',
			'1 Thought Vessel',
			'1 Mind Stone',
			"1 Commander's Sphere",
			'1 Lightning Greaves',
			'1 Swiftfoot Boots',
			'1 Cultivate',
			"1 Kodama's Reach",
			'1 Rampant Growth',
			'1 Farseek',
			'1 Swords to Plowshares',
			'1 Path to Exile',
			'1 Wrath of God',
			'1 Farewell',
			'1 Smothering Tithe',
			'1 Generous Gift',
			'1 Counterspell',
			'1 Arcane Denial',
			'1 Negate',
			'1 Cyclonic Rift',
			'1 Rhystic Study',
			'1 Brainstorm',
			'1 Ponder',
			'1 Preordain',
			'1 Demonic Tutor',
			'1 Toxic Deluge',
			'1 Infernal Grasp',
			"1 Night's Whisper",
			'1 Putrefy',
			'1 Mortify',
			'1 Anguished Unmaking',
			'1 Beast Within',
			'1 Heroic Intervention',
			'1 Eternal Witness',
			'1 Forgotten Ancient',
			'1 Fathom Mage',
			'1 Crystalline Crawler',
			'1 Evolution Sage',
			'1 Flux Channeler',
			'1 Grateful Apparition',
			'1 Shalai, Voice of Plenty',
			'1 Corpsejack Menace',
			'1 Command Tower',
			'1 Exotic Orchard',
			'1 Reliquary Tower',
			'1 Path of Ancestry',
			'14 Forest',
			'12 Plains',
			'12 Island',
			'12 Swamp'
		].join('\n');
	}

	async function submitDeckImport() {
		if (!importDecklist.trim()) return;
		importingDeck = true;
		errorMsg = '';
		try {
			const data = await apiFetch(appUrl('magic', '/api/decks'), {
				method: 'POST',
				body: JSON.stringify({
					action: 'import',
					name: importName || 'Custom Commander Deck',
					commanderName: importCommander,
					decklist: importDecklist
				})
			});
			if (data.ok) {
				userDecks = data.decks || [];
				showImportModal = false;
				inspectedDeck = data.deck;
				statusMsg = `Imported "${data.deck.name}" (${data.deck.cardCount} cards, ${data.deck.isLegal ? 'Commander Legal' : 'Rule 0 / Check Warnings'})`;
			} else {
				errorMsg = data.error || 'Deck import failed.';
			}
		} finally {
			importingDeck = false;
		}
	}

	async function clonePrecon(preconId: string, switchInspector = false) {
		const data = await apiFetch(appUrl('magic', '/api/decks'), {
			method: 'POST',
			body: JSON.stringify({ action: 'clone_precon', preconId })
		});
		if (data.ok) {
			userDecks = data.decks || [];
			statusMsg = `Copied "${data.deck.name}" to your saved decks.`;
			if (switchInspector && data.deck) {
				inspectedDeck = data.deck;
				inspectStatusMsg = `Copied "${data.deck.name}" to your saved decks — now in editable mode.`;
				inspectErrorMsg = '';
			}
		} else {
			errorMsg = data.error || 'Could not copy reference deck.';
			if (switchInspector) {
				inspectErrorMsg = data.error || 'Could not copy reference deck.';
			}
		}
	}

	async function deleteDeck(deckId: string) {
		const data = await apiFetch(appUrl('magic', '/api/decks'), {
			method: 'POST',
			body: JSON.stringify({ action: 'delete', deckId })
		});
		if (data.ok) {
			userDecks = data.decks || [];
			if (inspectedDeck?.id === deckId) inspectedDeck = null;
		}
	}

	function openDeckInspector(deck: MagicDeck) {
		inspectedDeck = deck;
		inspectSearchQuery = '';
		activeCardMenuKey = null;
		inspectStatusMsg = '';
		inspectErrorMsg = '';
		addCardSearchResults = [];
		showScryfallDropdown = false;
		dropdownHighlightIdx = -1;
	}

	function openCardMenu(key: string, currentQty: number, e: MouseEvent) {
		e.stopPropagation();
		if (activeCardMenuKey === key) {
			activeCardMenuKey = null;
		} else {
			activeCardMenuKey = key;
			customMenuQty = currentQty;
		}
	}

	async function updateInspectedCard(params: {
		cardName: string;
		operation: 'set_qty' | 'remove' | 'promote_commander' | 'demote_commander';
		quantity?: number;
		fromCommander?: boolean;
	}) {
		if (!inspectedDeck) return;
		inspectErrorMsg = '';
		inspectStatusMsg = '';
		const data = await apiFetch(appUrl('magic', '/api/decks'), {
			method: 'POST',
			body: JSON.stringify({
				action: 'update_card',
				deckId: inspectedDeck.id,
				cardName: params.cardName,
				operation: params.operation,
				quantity: params.quantity,
				fromCommander: params.fromCommander
			})
		});
		if (data.ok && data.deck) {
			inspectedDeck = data.deck;
			userDecks = data.decks || userDecks;
			if (params.operation === 'remove' || (params.operation === 'set_qty' && (params.quantity ?? 1) <= 0)) {
				activeCardMenuKey = null;
				inspectStatusMsg = `Removed ${params.cardName} from deck.`;
			} else if (params.operation === 'set_qty') {
				const newQty = Math.min(99, Math.max(1, Math.floor(params.quantity ?? 1)));
				customMenuQty = newQty;
				inspectStatusMsg = `Updated ${params.cardName} quantity to ${newQty}x.`;
			} else if (params.operation === 'promote_commander') {
				activeCardMenuKey = null;
				inspectStatusMsg = `Set ${params.cardName} as Commander.`;
			} else if (params.operation === 'demote_commander') {
				activeCardMenuKey = null;
				inspectStatusMsg = `Moved ${params.cardName} to mainboard.`;
			}
		} else {
			inspectErrorMsg = data.error || 'Could not update card.';
		}
	}

	async function fetchScryfallDropdownResults(rawQuery: string, explicitTrigger = false) {
		const q = rawQuery.trim();
		if (q.length < 2) {
			addCardSearchResults = [];
			showScryfallDropdown = false;
			dropdownHighlightIdx = -1;
			if (explicitTrigger && q.length > 0) {
				inspectErrorMsg = 'Type at least 2 characters to search Scryfall and select a card.';
			}
			return;
		}
		const reqId = ++searchRequestSeq;
		searchingScryfallBusy = true;
		showScryfallDropdown = true;
		if (explicitTrigger) inspectErrorMsg = '';
		try {
			const data = await apiFetch(appUrl('magic', '/api/decks'), {
				method: 'POST',
				body: JSON.stringify({
					action: 'search_scryfall',
					query: q
				})
			});
			if (reqId !== searchRequestSeq) return;
			if (data.ok) {
				addCardSearchResults = data.results || [];
				dropdownHighlightIdx = -1;
			} else if (explicitTrigger) {
				inspectErrorMsg = data.error || 'Scryfall search failed.';
			}
		} finally {
			if (reqId === searchRequestSeq) {
				searchingScryfallBusy = false;
			}
		}
	}

	function handleHybridSearchInput() {
		dropdownHighlightIdx = -1;
		addCardSearchResults = [];
		showScryfallDropdown = false;
		searchingScryfallBusy = false;
	}

	function handleHybridSearchKeydown(e: KeyboardEvent) {
		if (!showScryfallDropdown) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (addCardSearchResults.length > 0) {
				dropdownHighlightIdx = Math.min(
					addCardSearchResults.length - 1,
					dropdownHighlightIdx + 1
				);
				hoveredCard = addCardSearchResults[dropdownHighlightIdx] || null;
			}
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (addCardSearchResults.length > 0) {
				dropdownHighlightIdx = Math.max(-1, dropdownHighlightIdx - 1);
				hoveredCard =
					dropdownHighlightIdx >= 0 ? addCardSearchResults[dropdownHighlightIdx] : null;
			}
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			showScryfallDropdown = false;
			dropdownHighlightIdx = -1;
		} else if (e.key === 'Enter') {
			if (
				dropdownHighlightIdx >= 0 &&
				addCardSearchResults[dropdownHighlightIdx]
			) {
				e.preventDefault();
				selectCardFromDropdown(addCardSearchResults[dropdownHighlightIdx], false);
			}
		}
	}

	function getInspectedDeckCardQty(cardName: string): number {
		if (!inspectedDeck) return 0;
		const low = cardName.toLowerCase();
		let total = 0;
		for (const c of inspectedDeck.commanders) {
			if (c.name.toLowerCase() === low) total += 1;
		}
		for (const e of inspectedDeck.cards) {
			if (e.card.name.toLowerCase() === low) total += e.quantity;
		}
		return total;
	}

	async function selectCardFromDropdown(selectedCard: ScryfallCard, asCommander = false) {
		if (!inspectedDeck || addingCardBusy) return;
		addingCardBusy = true;
		inspectErrorMsg = '';
		inspectStatusMsg = '';
		try {
			const data = await apiFetch(appUrl('magic', '/api/decks'), {
				method: 'POST',
				body: JSON.stringify({
					action: 'add_card',
					deckId: inspectedDeck.id,
					card: selectedCard,
					cardName: selectedCard.name,
					quantity: addCardQtyInput,
					asCommander
				})
			});
			if (data.ok && data.deck) {
				inspectedDeck = data.deck;
				userDecks = data.decks || userDecks;
				const addedName = data.addedCard?.name || selectedCard.name;
				const addedQty = data.addedQuantity || (asCommander ? 1 : addCardQtyInput);
				inspectStatusMsg = `Added ${addedQty}x ${addedName}${asCommander ? ' (Commander)' : ''} to "${data.deck.name}".`;
				showScryfallDropdown = false;
				dropdownHighlightIdx = -1;
			} else {
				inspectErrorMsg = data.error || 'Could not add card to deck.';
			}
		} finally {
			addingCardBusy = false;
		}
	}

	async function createPrivateLobby() {
		errorMsg = '';
		const data = await apiFetch(appUrl('magic', '/api/lobby'), {
			method: 'POST',
			body: JSON.stringify({
				action: 'create',
				name: newLobbyName || `${user?.username}'s Commander Pod`,
				rules: DEFAULT_LOBBY_RULES
			})
		});
		if (data.ok && data.lobby) {
			activeLobby = data.lobby;
			lobbyChat = data.chat || [];
			await fetchMyLobbies();
		} else {
			errorMsg = data.error || 'Could not create lobby.';
		}
	}

	async function joinLobbyByCode(code: string) {
		if (!code.trim()) return;
		errorMsg = '';
		const data = await apiFetch(appUrl('magic', '/api/lobby'), {
			method: 'POST',
			body: JSON.stringify({
				action: 'join',
				code: code.trim().toUpperCase()
			})
		});
		if (data.ok && data.lobby) {
			const nextLobby: MagicLobby = data.lobby;
			activeLobby = nextLobby;
			lobbyChat = data.chat || [];
			if (nextLobby.status === 'active' && nextLobby.gameState) {
				inMatchView = true;
			}
			await fetchMyLobbies();
		} else {
			errorMsg = data.error || 'Could not join lobby.';
		}
	}

	async function updateHostRules(partial: Partial<LobbyRulesConfig>) {
		if (!activeLobby) return;
		const data = await apiFetch(appUrl('magic', '/api/lobby'), {
			method: 'POST',
			body: JSON.stringify({
				action: 'update_rules',
				code: activeLobby.code,
				rules: { ...activeLobby.rules, ...partial }
			})
		});
		if (data.ok && data.lobby) {
			activeLobby = data.lobby;
			lobbyChat = data.chat || [];
		} else if (data.error) {
			errorMsg = data.error;
		}
	}

	async function selectSeatDeck(deckId: string) {
		if (!activeLobby) return;
		errorMsg = '';
		const data = await apiFetch(appUrl('magic', '/api/lobby'), {
			method: 'POST',
			body: JSON.stringify({
				action: 'select_deck',
				code: activeLobby.code,
				deckId
			})
		});
		if (data.ok && data.lobby) {
			activeLobby = data.lobby;
		} else if (data.error) {
			errorMsg = data.error;
		}
	}

	async function addBotToSeat(seatIndex: number) {
		if (!activeLobby) return;
		const data = await apiFetch(appUrl('magic', '/api/lobby'), {
			method: 'POST',
			body: JSON.stringify({
				action: 'add_bot',
				code: activeLobby.code,
				seatIndex
			})
		});
		if (data.ok && data.lobby) {
			activeLobby = data.lobby;
			lobbyChat = data.chat || [];
		}
	}

	async function removeBotFromSeat(seatIndex: number) {
		if (!activeLobby) return;
		const data = await apiFetch(appUrl('magic', '/api/lobby'), {
			method: 'POST',
			body: JSON.stringify({
				action: 'remove_bot',
				code: activeLobby.code,
				seatIndex
			})
		});
		if (data.ok && data.lobby) {
			activeLobby = data.lobby;
			lobbyChat = data.chat || [];
		}
	}

	async function startLobbyMatch() {
		if (!activeLobby) return;
		errorMsg = '';
		const data = await apiFetch(appUrl('magic', '/api/lobby'), {
			method: 'POST',
			body: JSON.stringify({
				action: 'start_game',
				code: activeLobby.code
			})
		});
		if (data.ok && data.lobby) {
			activeLobby = data.lobby;
			lobbyChat = data.chat || [];
			inMatchView = true;
		} else if (data.error) {
			errorMsg = data.error;
		}
	}

	async function dispatchGameAction(gameAction: GameActionPayload) {
		if (!activeLobby) return;
		errorMsg = '';
		actionInFlight = true;
		try {
			const data = await apiFetch(appUrl('magic', '/api/lobby'), {
				method: 'POST',
				body: JSON.stringify({
					action: 'game_action',
					code: activeLobby.code,
					gameAction
				})
			});
			if (data.ok && data.lobby) {
				activeLobby = data.lobby;
				lobbyChat = data.chat || [];
			} else if (data.error) {
				errorMsg = data.error;
			}
		} finally {
			actionInFlight = false;
		}
	}

	async function sendPodChat(message: string, kind: 'chat' | 'emote' = 'chat') {
		if (!activeLobby || !message.trim()) return;
		const data = await apiFetch(appUrl('magic', '/api/lobby'), {
			method: 'POST',
			body: JSON.stringify({
				action: 'chat',
				code: activeLobby.code,
				message,
				kind
			})
		});
		if (data.ok && data.chat) {
			lobbyChat = data.chat;
		}
	}

	async function copyInviteLink() {
		if (!activeLobby) return;
		const link = new URL(
			appUrl('magic', `/?join=${activeLobby.code}`),
			window.location.origin
		).toString();
		try {
			await navigator.clipboard.writeText(link);
			statusMsg = `Copied invite link for ${activeLobby.code}`;
		} catch {
			statusMsg = `Invite code: ${activeLobby.code}`;
		}
	}
</script>

<svelte:head>
	<title>MTG Commander Arena — magic.peckhamr.com</title>
</svelte:head>

{#if !inMatchView && altHeld && hoveredCard}
	<div
		class="alt-hover-preview"
		class:side-details={altPreviewPos.sideMode}
		class:place-left={altPreviewPos.placeLeft}
		style="left: {altPreviewPos.x}px; top: {altPreviewPos.y}px;"
	>
		<img src={hoveredCard.imageUrl} alt={hoveredCard.name} />
		<div class="alt-preview-meta">
			<div class="alt-preview-head">
				<strong>{hoveredCard.name}</strong>
				<ManaText text={hoveredCard.manaCost} size={16} />
			</div>
			<div class="alt-preview-type">
				{pageHoverBreakdown ? pageHoverBreakdown.effectiveTypeLine : hoveredCard.typeLine}
			</div>
			{#if pageHoverBreakdown && pageHoverBreakdown.items.length > 0}
				<div class="alt-kw-section">
					<div class="alt-kw-title">KEYWORDS &amp; EFFECTS</div>
					<div class="alt-kw-list">
						{#each pageHoverBreakdown.items as item (item.id)}
							<div class="alt-kw-row" class:is-removed={item.removed}>
								<span class="kw-name" class:crossed-out={item.removed}>
									{item.name}
								</span>
								{#each item.sources as src}
									<span class="kw-source" class:innate={src === 'innate'} class:granted={src !== 'innate'}>
										({src})
									</span>
								{/each}
								{#if item.removed && item.removedBy.length > 0}
									<span class="kw-removed-by">
										(removed by {item.removedBy.join(', ')})
									</span>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/if}
			{#if hoveredCard.oracleText}
				<div class="alt-preview-oracle">
					<ManaText text={hoveredCard.oracleText} size={15} />
				</div>
			{/if}
		</div>
	</div>
{/if}

{#if inMatchView && activeLobby?.gameState && user}
	{#if errorMsg}
		<div class="floating-err">
			<span>Error: {errorMsg}</span>
			<button type="button" onclick={() => (errorMsg = '')}>Close</button>
		</div>
	{/if}
	<ArenaTable
		gameState={activeLobby.gameState}
		{user}
		lobbyCode={activeLobby.code}
		chatMessages={lobbyChat}
		{theme}
		onToggleTheme={toggleTheme}
		onGameAction={dispatchGameAction}
		onSendChat={sendPodChat}
		onLeaveMatch={() => (inMatchView = false)}
	/>
{:else}
	<div class="magic-shell">
		<!-- Top Navigation Bar -->
		<header class="topbar">
			<div class="brand-nav">
				<a href={appUrl('home', '/', page.url)} class="brand-link">peckhamr.com</a>
				<span class="sep">/</span>
				<span class="brand-current">magic commander</span>
			</div>

			<div class="user-nav">
				{#if user}
					<button
						type="button"
						class="tab-btn"
						class:active={activeTab === 'lobbies'}
						onclick={() => (activeTab = 'lobbies')}
					>
						Private Lobbies
					</button>
					<button
						type="button"
						class="tab-btn"
						class:active={activeTab === 'decks'}
						onclick={() => {
							activeTab = 'decks';
							activeLobby = null;
						}}
					>
						{user.provider === 'guest' ? 'Decks & Precons' : `My Decks (${userDecks.length})`}
					</button>
					<span class="user-chip">
						<span class="provider-dot {user.provider}"></span>
						{#if user.provider === 'guest'}
							<span class="guest-tag">[GUEST]</span>
						{/if}
						{user.username}
					</span>
					<button type="button" class="btn-outline" onclick={handleLogout}>
						{user.provider === 'guest' ? 'Leave Guest' : 'Sign Out'}
					</button>
				{/if}

				<button
					type="button"
					class="theme-btn"
					onclick={toggleTheme}
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

		{#if statusMsg}
			<div class="banner ok">
				<span>{statusMsg}</span>
				<button type="button" onclick={() => (statusMsg = '')}>Dismiss</button>
			</div>
		{/if}
		{#if errorMsg}
			<div class="banner err">
				<span>Error: {errorMsg}</span>
				<button type="button" onclick={() => (errorMsg = '')}>Dismiss</button>
			</div>
		{/if}

		{#if loading}
			<div class="loading-box">Loading MTG Commander Service...</div>
		{:else if !user}
			<!-- Authentication Gate: Guest Join + Google/GitHub OAuth + Multi-Tab Quick Switcher -->
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
							<span class="guest-join-sub">No account required — enter a display name &amp; invite code</span>
						</div>
						<form
							class="guest-join-form"
							onsubmit={(e) => {
								e.preventDefault();
								handleGuestJoinLobby();
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
						<a
							class="oauth-btn google"
							href={appUrl('magic', '/api/auth?action=login&provider=google', page.url)}
						>
							<span class="oauth-icon">G</span>
							<span>Continue with Google OAuth</span>
						</a>
						<a
							class="oauth-btn github"
							href={appUrl('magic', '/api/auth?action=login&provider=github', page.url)}
						>
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
							{#each TEST_PLANESWALKERS as pw, idx}
								<button
									type="button"
									class="preset-btn"
									onclick={() => handleDevLogin(pw)}
								>
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
									handleDevLogin({
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
		{:else if activeTab === 'lobbies'}
			{#if !activeLobby}
				<!-- Lobby Browser / Create / Join by Code -->
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
								joinLobbyByCode(joinCodeInput);
							}}
						>
							<input
								type="text"
								placeholder="e.g. EDH7X9"
								maxlength="8"
								bind:value={joinCodeInput}
							/>
							<button type="submit" class="btn-accent">
								Join Pod
							</button>
						</form>
					</section>

					<section class="card-panel">
						<h2>Create Private Commander Lobby</h2>
						{#if user.provider === 'guest'}
							<p class="panel-sub">
								You are currently browsing as a Guest (<strong>{user.username}</strong>). Sign in with a Google or GitHub account to create and host new private lobbies and save custom decks.
							</p>
							<div class="form-row">
								<button type="button" class="btn-outline" onclick={handleLogout}>
									Sign In with Account to Host
								</button>
							</div>
						{:else}
							<p class="panel-sub">
								Host a private pod with a 6-character invite code, customize Commander rules, and invite friends or guests.
							</p>
							<div class="form-row">
								<input
									type="text"
									placeholder="{user.username}'s Commander Pod"
									bind:value={newLobbyName}
								/>
								<button type="button" class="btn-accent" onclick={createPrivateLobby}>
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
											onclick={() => joinLobbyByCode(l.code)}
										>
											{l.status === 'active' ? 'Rejoin Match' : 'Open Lobby'}
										</button>
										<button
											type="button"
											class="btn-outline"
											onclick={() => leaveLobbyByCode(l.code)}
										>
											Leave
										</button>
									</div>
								</div>
							{/each}
						</div>
					</section>
				{/if}
			{:else}
				<!-- Inside Waiting / Active Private Lobby -->
				{@const isHost = activeLobby.hostUserId === user.id}
				<div
					class="active-lobby-layout"
					style="--lobby-chat-w: {lobbyChatWidth}px;"
				>
					<div class="lobby-left-col">
						<section class="card-panel">
							<div class="lobby-title-bar">
								<div class="lobby-title-left">
									<button
										type="button"
										class="btn-outline"
										onclick={() => (activeLobby = null)}
									>
										All Lobbies
									</button>
									<button
										type="button"
										class="btn-outline"
										onclick={() => activeLobby && leaveLobbyByCode(activeLobby.code)}
									>
										Leave Lobby
									</button>
									<h2>{activeLobby.name}</h2>
								</div>
								<div class="invite-box">
									<span class="invite-label">INVITE CODE:</span>
									<span class="code-badge large">{activeLobby.code}</span>
									<button type="button" class="btn-outline" onclick={copyInviteLink}>
										Copy Invite Link
									</button>
								</div>
							</div>

							<!-- 4-Seat Pod Grid -->
							<div class="seats-grid">
								{#each activeLobby.seats as seat (seat.seatIndex)}
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
												{#if seat.userId === activeLobby.hostUserId}
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
															{#each seat.colorIdentity as c}
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
																	selectSeatDeck(
																		(e.currentTarget as HTMLSelectElement).value
																	)}
															>
																<optgroup label="Starter Commander Precons (100 Cards)">
																	{#each preconDecks as p}
																		<option value={p.id}>
																			[Precon] {p.name} ({p.colorIdentity.join('')})
																		</option>
																	{/each}
																</optgroup>
																{#if userDecks.length > 0}
																	<optgroup label="My Imported Decks">
																		{#each userDecks as d}
																			<option value={d.id}>
																				{d.name} ({d.cardCount} cards · {d.isLegal ? 'Legal' : 'Rule 0'})
																			</option>
																		{/each}
																	</optgroup>
																{/if}
															</select>
														</label>
													</div>
												{/if}

												{#if isHost && seat.isBot && activeLobby.status === 'waiting'}
													<button
														type="button"
														class="btn-outline small"
														onclick={() => removeBotFromSeat(seat.seatIndex)}
													>
														Remove Bot
													</button>
												{:else if isHost && seat.userId && seat.userId !== user.id && !seat.isBot}
													<button
														type="button"
														class="btn-outline small"
														onclick={() => seat.userId && transferLobbyHost(seat.userId)}
													>
														Make Host
													</button>
												{/if}
											{:else}
												<div class="seat-empty">Waiting for player via code {activeLobby.code}...</div>
												{#if isHost && activeLobby.status === 'waiting'}
													<button
														type="button"
														class="btn-outline small"
														onclick={() => addBotToSeat(seat.seatIndex)}
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
								{#if activeLobby.status === 'active' && activeLobby.gameState}
									<button
										type="button"
										class="btn-launch"
										onclick={() => (inMatchView = true)}
									>
										Enter Live Commander Arena
									</button>
								{:else if isHost}
									<button
										type="button"
										class="btn-launch"
										onclick={startLobbyMatch}
									>
										Start Commander Match ({activeLobby.seats.filter((s) => s.userId || s.isBot).length} Players)
									</button>
								{:else}
									<span class="waiting-host">Waiting for the lobby host to launch the match...</span>
								{/if}
							</div>
						</section>

						<!-- Host Rule 0 & Strict Rules Configurator -->
						<section class="card-panel">
							<div class="rules-head">
								<h2>Lobby Rules &amp; Host Customizations</h2>
								<span class="rules-sub">
									{isHost ? 'You are the Host — changes sync live to all players' : 'Read-only (Host controls rules)'}
								</span>
							</div>

							<div class="rules-grid">
								<label>
									<span>Starting Life Total</span>
									<select
										disabled={!isHost}
										value={activeLobby.rules.startingLife}
										onchange={(e) =>
											updateHostRules({
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
										value={activeLobby.rules.commanderDamageLethal}
										onchange={(e) =>
											updateHostRules({
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
										value={activeLobby.rules.commanderTaxIncrement}
										onchange={(e) =>
											updateHostRules({
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
										value={activeLobby.rules.poisonLethal}
										onchange={(e) =>
											updateHostRules({
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
										value={activeLobby.rules.mulliganRule}
										onchange={(e) =>
											updateHostRules({
												mulliganRule: (e.currentTarget as HTMLSelectElement)
													.value as LobbyRulesConfig['mulliganRule']
											})}
									>
										<option value="london_1free">London Mulligan (1st Mulligan Free)</option>
										<option value="friendly_unlimited">Friendly Unlimited Free Mulligans</option>
										<option value="strict_london">Strict London (No Free Mulligan)</option>
									</select>
								</label>

								<label>
									<span>Deck Legality Enforcement</span>
									<select
										disabled={!isHost}
										value={activeLobby.rules.deckValidationMode}
										onchange={(e) =>
											updateHostRules({
												deckValidationMode: (e.currentTarget as HTMLSelectElement)
													.value as LobbyRulesConfig['deckValidationMode']
											})}
									>
										<option value="strict_commander">Strict Commander (100-card Singleton + Color Identity)</option>
										<option value="rule0_relaxed">Rule 0 Anything Goes (Allow Custom / Non-Standard Decks)</option>
									</select>
								</label>

								<label>
									<span>Cards With Unsupported Abilities</span>
									<select
										disabled={!isHost}
										value={activeLobby.rules.allowUnsupportedCards === false ? 'block' : 'allow'}
										onchange={(e) =>
											updateHostRules({
												allowUnsupportedCards:
													(e.currentTarget as HTMLSelectElement).value !== 'block'
											})}
									>
										<option value="allow">Allow (Players Resolve Them Manually)</option>
										<option value="block">Block (Refuse to Start if Any Deck Has One)</option>
									</select>
								</label>

								<label>
									<span>MTG Arena Turn / Priority Rope Timer</span>
									<select
										disabled={!isHost}
										value={activeLobby.rules.turnTimerSeconds}
										onchange={(e) =>
											updateHostRules({
												turnTimerSeconds: parseInt(
													(e.currentTarget as HTMLSelectElement).value,
													10
												)
											})}
									>
										<option value={90}>90 Seconds per Priority Window</option>
										<option value={60}>60 Seconds (Blitz)</option>
										<option value={120}>120 Seconds</option>
										<option value={0}>Untimed (Casual Pod)</option>
									</select>
								</label>

								<label>
									<span>Pod Size (Max Seats)</span>
									<select
										disabled={!isHost || activeLobby.status !== 'waiting'}
										value={activeLobby.rules.maxPlayers}
										onchange={(e) =>
											updateHostRules({
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
							{#each lobbyChat as m (m.id)}
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
								await sendPodChat(text, 'chat');
							}}
						>
							<input
								type="text"
								placeholder="Message the pod..."
								bind:value={lobbyChatInput}
							/>
							<button type="submit" class="btn-accent">Send</button>
						</form>
					</aside>
				</div>
			{/if}
		{:else if activeTab === 'decks'}
			<!-- Deck Manager & Scryfall Importer (User's Editable Saved Decks) -->
			<section class="card-panel">
				<div class="lobby-title-bar">
					<div>
						<div class="section-head-row">
							<h2>My Saved Decks ({userDecks.length})</h2>
							<span class="deck-mode-tag editable">Editable</span>
						</div>
						<p class="panel-sub">
							Your personal Commander decks. Add, remove, or swap cards anytime, or import a list from Moxfield, Archidekt, or MTG Arena.
						</p>
					</div>
					<button
						type="button"
						class="btn-accent"
						onclick={() => {
							showImportModal = true;
							if (!importDecklist) loadSampleDecklistIntoImporter();
						}}
					>
						+ Import Commander Deck
					</button>
				</div>

				{#if userDecks.length === 0}
					<div class="empty-decks">
						You haven't saved any custom decks yet. Click <strong>+ Import Commander Deck</strong> above or copy one of the <strong>Default Reference Decks</strong> below to start customizing.
					</div>
				{:else}
					<div class="deck-grid">
						{#each userDecks as d (d.id)}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="deck-card saved-deck-card"
								onmouseenter={() => (hoveredCard = d.commanders[0] || null)}
								onmouseleave={() => {
									if (hoveredCard?.name === d.commanders[0]?.name) hoveredCard = null;
								}}
							>
								<div
									class="deck-banner"
									style="background-image: linear-gradient(180deg, rgba(16,14,20,0.22), rgba(16,14,20,0.92)), url('{safeCssArtUrl(d.commanders[0]?.artCropUrl)}');"
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
												{#each d.colorIdentity as c}
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
											onclick={() => openDeckInspector(d)}
										>
											Edit / Inspect
										</button>
										<button
											type="button"
											class="btn-outline small danger"
											onclick={() => deleteDeck(d.id)}
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
					Built-in 100-card Commander archetypes provided to play as-is, refer to, or copy into <strong>My Saved Decks</strong> if you want to customize them.
				</p>
				<div class="precon-ref-list">
					{#each preconDecks as p (p.id)}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="precon-ref-row"
							onmouseenter={() => (hoveredCard = p.commanders[0] || null)}
							onmouseleave={() => {
								if (hoveredCard?.name === p.commanders[0]?.name) hoveredCard = null;
							}}
						>
							<div
								class="precon-ref-art"
								style="background-image: linear-gradient(135deg, rgba(16,14,20,0.12), rgba(16,14,20,0.72)), url('{safeCssArtUrl(p.commanders[0]?.artCropUrl)}');"
							>
								<span class="precon-ref-count">{p.cardCount} Cards</span>
							</div>

							<div class="precon-ref-main">
								<div class="precon-ref-top">
									<h3>{p.name}</h3>
									<span class="deck-mode-pill readonly">Reference Only</span>
									<span class="mana-row">
										{#each p.colorIdentity as c}
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
									onclick={() => openDeckInspector(p)}
								>
									Refer / View List
								</button>
								<button
									type="button"
									class="btn-accent small"
									onclick={() => clonePrecon(p.id)}
								>
									+ Copy to My Decks
								</button>
							</div>
						</div>
					{/each}
				</div>
			</section>
		{/if}
	</div>

	<!-- Import Deck Modal -->
	{#if showImportModal}
		<div class="modal-backdrop">
			<div class="modal-box import-modal">
				<div class="sleek-modal-head">
					<div>
						<h3>Import Commander Deck</h3>
						<p class="sleek-modal-sub">
							Paste any Moxfield, Archidekt, or MTG Arena decklist. Cards resolve via Scryfall.
						</p>
					</div>
					<button
						type="button"
						class="btn-outline small"
						onclick={loadSampleDecklistIntoImporter}
					>
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
							placeholder="e.g. Atraxa Proliferate"
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
							placeholder="e.g. Atraxa, Praetors' Voice"
						/>
					</label>
				</div>

				<label class="field-label">
					<span class="field-head">
						<span>Card List (1 per line, e.g. <code>1 Sol Ring</code>)</span>
						<span class="field-count-pill" class:ready={importEstimatedCount === 100 || importEstimatedCount === 99}>
							{importEstimatedCount} cards detected
						</span>
					</span>
					<textarea
						class="sleek-textarea"
						rows="12"
						bind:value={importDecklist}
						placeholder="Commander:&#10;1 Atraxa, Praetors' Voice&#10;&#10;Deck:&#10;1 Sol Ring&#10;1 Arcane Signet..."
					></textarea>
				</label>

				<div class="modal-footer sleek-footer">
					<span class="footer-note">Supports <code>Commander:</code> &amp; <code>Deck:</code> headers</span>
					<div class="footer-btns">
						<button
							type="button"
							class="btn-outline"
							onclick={() => (showImportModal = false)}
						>
							Cancel
						</button>
						<button
							type="button"
							class="btn-accent"
							disabled={importingDeck}
							onclick={submitDeckImport}
						>
							{importingDeck ? 'Resolving with Scryfall...' : 'Validate & Save Deck'}
						</button>
					</div>
				</div>
			</div>
		</div>
	{/if}

	<!-- Inspect Deck Modal -->
	{#if inspectedDeck}
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
							<h3>{inspectedDeck.name}</h3>
							{#if isInspectedReadOnly}
								<span class="deck-mode-pill readonly">Read-Only Reference</span>
							{:else}
								<span class="deck-mode-pill editable">Editable</span>
							{/if}
							<span class="legality-pill" class:legal={inspectedDeck.isLegal}>
								{inspectedDeck.isLegal ? 'Commander Legal' : 'Rule 0'}
							</span>
							{#if inspectedUnsupported.length > 0}
								<span class="unsupported-pill">{inspectedUnsupported.length} not automated</span>
							{/if}
							<span class="inspect-count-tag">{inspectedDeck.cardCount} Cards</span>
							<span class="mana-row">
								{#if inspectedDeck.colorIdentity.length > 0}
									{#each inspectedDeck.colorIdentity as c}
										<ManaSymbol symbol={c} size={16} />
									{/each}
								{:else}
									<ManaSymbol symbol="C" size={16} />
								{/if}
							</span>
						</div>
						<div class="cmdr-sub-row">
							{#each inspectedDeck.commanders as cmd}
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
								style="--range-pct: {Math.round(((inspectCardsPerRow - 2) / (8 - 2)) * 100)}%;"
								bind:value={inspectCardsPerRow}
							/>
							<span class="size-val">{inspectCardsPerRow}</span>
						</label>
						{#if isInspectedReadOnly}
							<button
								type="button"
								class="btn-accent small"
								onclick={() => inspectedDeck && clonePrecon(inspectedDeck.id, true)}
							>
								+ Copy to My Decks &amp; Edit
							</button>
						{/if}
						<button
							type="button"
							class="btn-outline small"
							onclick={() => {
								inspectedDeck = null;
								activeCardMenuKey = null;
								showScryfallDropdown = false;
							}}
						>
							Close
						</button>
					</div>
				</div>

				{#if isInspectedReadOnly}
					<div class="readonly-ref-banner">
						<span>
							<strong>Default Reference Deck (Read-Only):</strong> This starter deck is provided to refer to or copy. Click <strong>+ Copy to My Decks &amp; Edit</strong> to save your own editable copy.
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
										: 'Filter deck or search Scryfall to add cards using Scryfall syntax (e.g. t:creature, o:draw, c:ug, mv<=3, Sol Ring)'}
									placeholder={isInspectedReadOnly
										? 'Search reference deck (e.g. t:creature, o:draw, mv<=3)...'
										: 'Search deck or Scryfall to add cards (e.g. Sol Ring, t:creature o:draw mv<=3)...'}
								/>
								{#if inspectSearchQuery}
									<button
										type="button"
										class="search-clear-btn"
										title="Clear search"
										onclick={() => {
											inspectSearchQuery = '';
											addCardSearchResults = [];
											showScryfallDropdown = false;
											dropdownHighlightIdx = -1;
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
									disabled={inspectSearchQuery.trim().length < 2 && !showScryfallDropdown}
									title="Open Scryfall results dropdown to add a card"
									onclick={() => {
										if (showScryfallDropdown) {
											showScryfallDropdown = false;
										} else {
											fetchScryfallDropdownResults(inspectSearchQuery, true);
										}
									}}
								>
									{searchingScryfallBusy ? 'Searching...' : '+ Add from Scryfall ▾'}
								</button>
							{/if}
						</div>

						{#if !isInspectedReadOnly && showScryfallDropdown}
							<div class="scryfall-dropdown" role="listbox" aria-label="Scryfall card results">
								<div class="sdd-head">
									<span>
										{#if searchingScryfallBusy}
											Searching Scryfall for "{inspectSearchQuery.trim()}"...
										{:else if addCardSearchResults.length === 0}
											No Scryfall cards found for "{inspectSearchQuery.trim()}".
										{:else}
											Select a card to add — Use ↑/↓ + Enter or click:
										{/if}
									</span>
									<div class="sdd-head-right">
										<label class="sdd-qty-ctrl" title="Quantity to add when selecting a card">
											<span>Qty</span>
											<button
												type="button"
												class="sdd-qty-step"
												disabled={addCardQtyInput <= 1}
												onclick={() => (addCardQtyInput = Math.max(1, addCardQtyInput - 1))}
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
												onclick={() => (addCardQtyInput = Math.min(99, addCardQtyInput + 1))}
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

								{#if addCardSearchResults.length > 0}
									<div class="sdd-list">
										{#each addCardSearchResults as resCard, idx (resCard.name)}
											{@const inDeckQty = getInspectedDeckCardQty(resCard.name)}
											<!-- svelte-ignore a11y_click_events_have_key_events -->
											<!-- svelte-ignore a11y_interactive_supports_focus -->
											<div
												class="sdd-item"
												class:highlighted={dropdownHighlightIdx === idx}
												role="option"
												aria-selected={dropdownHighlightIdx === idx}
												onmouseenter={() => {
													dropdownHighlightIdx = idx;
													hoveredCard = resCard;
												}}
												onmouseleave={() => {
													if (hoveredCard?.name === resCard.name) hoveredCard = null;
												}}
												onclick={() => selectCardFromDropdown(resCard, false)}
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
															<span class="sdd-indeck-pill">In Deck: {inDeckQty}x</span>
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
															selectCardFromDropdown(resCard, false);
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
															selectCardFromDropdown(resCard, true);
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
						] as const) as [mode, label]}
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

				{#if inspectStatusMsg}
					<div class="inspect-inline-notice ok">
						<span>{inspectStatusMsg}</span>
						<button type="button" onclick={() => (inspectStatusMsg = '')}>×</button>
					</div>
				{/if}
				{#if inspectErrorMsg}
					<div class="inspect-inline-notice err">
						<span>{inspectErrorMsg}</span>
						<button type="button" onclick={() => (inspectErrorMsg = '')}>×</button>
					</div>
				{/if}

				{#if inspectedDeck.validationErrors.length > 0}
					<div class="validation-warn">
						<strong>Commander Legality Notices:</strong>
						<ul>
							{#each inspectedDeck.validationErrors as err}
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
								{inspectedUnsupported.length === 1 ? 'card has' : 'cards have'} abilities that won't be automated.
							</strong>
							You can still play them: in game those abilities are resolved manually. A lobby host can block such cards.
						</summary>
						<ul>
							{#each inspectedUnsupported as item (item.card.name)}
								<li>
									<strong>{item.card.name}</strong>
									{#if item.isCommander}<span class="ic-qty cmd-qty">CMD</span>{/if}
									<ul>
										{#each item.report.unsupported as u, i (i)}
											<li>
												<span class="unsupported-text">{displayAbilityText(u.text, u.face) || '(whole card)'}</span>
												<span class="unsupported-reason">({UNSUPPORTED_REASON_LABEL[u.reason]})</span>
												{#if u.unparsed.length > 0}
													<span class="unsupported-missed">
														Not understood:
														{#each u.unparsed as frag, j (j)}
															<mark>{displayAbilityText(frag, u.face)}</mark>
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
					style="grid-template-columns: repeat({inspectCardsPerRow}, minmax(0, 1fr));"
				>
					{#each filteredInspectedCommanders as cmd (cmd.name)}
						{@const menuKey = `cmd:${cmd.name}`}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="inspect-card-item cmd"
							onmouseenter={() => (hoveredCard = cmd)}
							onmouseleave={() => {
								if (hoveredCard?.name === cmd.name) hoveredCard = null;
							}}
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
										<span class="ic-mana"><ManaText text={cmd.manaCost} size={13} /></span>
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
									<span class="inspect-card-sub">{cmd.typeLine.split('—')[0].trim()}</span>
									{#if unsupportedCount(cmd) > 0}
										<span class="unsupported-badge" title={unsupportedTooltip(cmd)}>
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
											updateInspectedCard({
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
											updateInspectedCard({
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
							onmouseenter={() => (hoveredCard = entry.card)}
							onmouseleave={() => {
								if (hoveredCard?.name === entry.card.name) hoveredCard = null;
							}}
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
										<span class="ic-mana"><ManaText text={entry.card.manaCost} size={13} /></span>
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
									<span class="inspect-card-sub">{entry.card.typeLine.split('—')[0].trim()}</span>
									{#if unsupportedCount(entry.card) > 0}
										<span class="unsupported-badge" title={unsupportedTooltip(entry.card)}>
											{abilitiesNotAutomatedLabel(unsupportedCount(entry.card))}
										</span>
									{/if}
								</div>
							</div>

							{#if !isInspectedReadOnly && activeCardMenuKey === menuKey}
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<div class="card-dots-menu" onclick={(e) => e.stopPropagation()}>
									<div class="cdm-head">
										<span class="cdm-title" title={entry.card.name}>{entry.card.name}</span>
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
													updateInspectedCard({
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
													updateInspectedCard({
														cardName: entry.card.name,
														operation: 'set_qty',
														quantity: customMenuQty
													})}
												onkeydown={(e) => {
													if (e.key === 'Enter') {
														e.preventDefault();
														updateInspectedCard({
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
													updateInspectedCard({
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
											updateInspectedCard({
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
											updateInspectedCard({
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
{/if}

<style>
	.magic-shell {
		max-width: 82rem;
		margin: 0 auto;
		padding: 1.25rem 1.25rem 4rem 1.25rem;
		font-family: var(--mono-font, monospace);
		color: var(--mp-text);
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	/* Hold ALT Floating Card Preview */
	.alt-hover-preview {
		position: fixed;
		z-index: 400;
		width: 248px;
		max-height: calc(100vh - 24px);
		background: #14121a;
		border: 2px solid #ffd866;
		border-radius: 10px;
		box-shadow: 0 18px 42px rgba(0, 0, 0, 0.85);
		overflow: hidden;
		pointer-events: none;
		color: #fcfcfa;
		font-family: var(--mono-font, monospace);
		display: flex;
		flex-direction: column;
	}
	.alt-hover-preview.side-details {
		width: 472px;
		flex-direction: row;
		align-items: stretch;
	}
	.alt-hover-preview.side-details.place-left {
		flex-direction: row-reverse;
	}
	.alt-hover-preview img {
		width: 248px;
		height: auto;
		display: block;
		flex-shrink: 0;
	}
	.alt-preview-meta {
		padding: 0.55rem 0.65rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		background: rgba(16, 14, 22, 0.96);
		border-top: 1px solid rgba(255, 216, 102, 0.25);
		overflow: hidden;
	}
	.alt-hover-preview.side-details .alt-preview-meta {
		border-top: none;
		border-left: 1px solid rgba(255, 216, 102, 0.25);
		width: 224px;
		justify-content: center;
	}
	.alt-hover-preview.side-details.place-left .alt-preview-meta {
		border-left: none;
		border-right: 1px solid rgba(255, 216, 102, 0.25);
	}
	.alt-preview-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.78rem;
	}
	.alt-preview-type {
		font-size: 0.68rem;
		color: #78dce8;
	}
	.alt-kw-section {
		background: rgba(10, 9, 14, 0.78);
		border: 1px solid rgba(255, 216, 102, 0.25);
		border-radius: 6px;
		padding: 0.3rem 0.42rem;
		display: flex;
		flex-direction: column;
		gap: 0.18rem;
	}
	.alt-kw-title {
		font-size: 0.58rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: #ffd866;
	}
	.alt-kw-list {
		display: flex;
		flex-direction: column;
		gap: 0.14rem;
	}
	.alt-kw-row {
		font-size: 0.64rem;
		line-height: 1.28;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.24rem;
		color: #fcfcfa;
	}
	.alt-kw-row .kw-name {
		font-weight: 600;
	}
	.alt-kw-row .kw-name.crossed-out {
		text-decoration: line-through;
		text-decoration-thickness: 1.5px;
		text-decoration-color: #ff6188;
		color: #939293;
	}
	.alt-kw-row .kw-source.innate {
		color: #939293;
		opacity: 0.72;
		font-size: 0.6rem;
	}
	.alt-kw-row .kw-source.granted {
		color: #78dce8;
		font-weight: 600;
		font-size: 0.6rem;
	}
	.alt-kw-row .kw-removed-by {
		color: #ff6188;
		font-weight: 600;
		font-size: 0.6rem;
	}
	.alt-preview-oracle {
		font-size: 0.68rem;
		color: #e6e3ea;
		line-height: 1.35;
	}

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
		transition: color 0.15s ease, border-color 0.15s ease;
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

	.mana-row {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
	}

	.banner {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.55rem 0.85rem;
		border-radius: 6px;
		font-size: 0.82rem;
	}
	.banner.ok {
		background: rgba(33, 136, 89, 0.14);
		border: 1px solid var(--mp-green);
		color: var(--mp-green);
	}
	.banner.err,
	.floating-err {
		background: rgba(225, 71, 117, 0.16);
		border: 1px solid var(--mp-red);
		color: var(--mp-red);
	}
	.floating-err {
		position: fixed;
		top: 3.2rem;
		left: 50%;
		transform: translateX(-50%);
		z-index: 250;
		padding: 0.5rem 1rem;
		border-radius: 6px;
		background: #22141b;
		display: flex;
		gap: 0.75rem;
		align-items: center;
		font-family: var(--mono-font, monospace);
		font-size: 0.8rem;
	}
	.banner button,
	.floating-err button {
		background: none;
		border: 1px solid currentColor;
		border-radius: 4px;
		padding: 0.12rem 0.45rem;
		font-family: inherit;
		font-size: 0.72rem;
		color: inherit;
		cursor: pointer;
	}

	/* Auth Hero */
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
		transition: border-color 0.15s ease, transform 0.15s ease;
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
	.custom-login-row,
	.form-row {
		display: flex;
		gap: 0.5rem;
	}
	.custom-login-row input,
	.form-row input,
	select,
	textarea {
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
	.btn-outline.small,
	.btn-accent.small {
		padding: 0.28rem 0.55rem;
		font-size: 0.72rem;
	}
	.btn-outline.danger:hover {
		border-color: var(--mp-red);
		color: var(--mp-red);
	}

	/* Cards & Panels */
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

	.lobby-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.lobby-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
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
	.code-badge.large {
		font-size: 1.05rem;
		letter-spacing: 0.08em;
	}

	/* Active Lobby View with Resizable Chat Column */
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
	}
	.invite-box {
		display: flex;
		align-items: center;
		gap: 0.45rem;
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

	/* Deck Grid & Reference Catalog */
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
		transition: border-color 0.14s ease, background 0.14s ease;
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
	.precon-desc {
		margin: 0;
		font-size: 0.75rem;
		color: var(--mp-text-body);
		line-height: 1.4;
	}
	.deck-actions {
		display: flex;
		justify-content: space-between;
		gap: 0.45rem;
	}

	/* Modals (Import & Deck Inspector) */
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
	.sleek-modal-sub {
		margin: 0.2rem 0 0 0;
		font-size: 0.74rem;
		color: var(--mp-text-muted);
	}

	/* Import Modal Specifics */
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

	/* Inspect Deck Modal Specifics */
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
		transition: border-color 0.14s ease, transform 0.14s ease;
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
	/* Plan section 2.7: unsupported-ability warning (amber, distinct from legality errors). */
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
