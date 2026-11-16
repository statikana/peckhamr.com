<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { appUrl } from '../../lib/apps';
	import ArenaTable from '../../lib/magic/ArenaTable.svelte';
	import { inspectCardContinuousBreakdown } from '../../lib/magic/engine';
	import AltHoverPreview from '../../lib/magic/ui/AltHoverPreview.svelte';
	import ActivePodPanel from '../../lib/magic/ui/lobby/ActivePodPanel.svelte';
	import AuthGatePanel from '../../lib/magic/ui/lobby/AuthGatePanel.svelte';
	import DeckImportModal from '../../lib/magic/ui/lobby/DeckImportModal.svelte';
	import DeckInspectorModal, {
		type DeckCardUpdateParams
	} from '../../lib/magic/ui/lobby/DeckInspectorModal.svelte';
	import DeckManagerPanel from '../../lib/magic/ui/lobby/DeckManagerPanel.svelte';
	import LobbyHubPanel, {
		type LobbySummaryItem
	} from '../../lib/magic/ui/lobby/LobbyHubPanel.svelte';
	import MagicTopBar from '../../lib/magic/ui/lobby/MagicTopBar.svelte';
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

	function handleCardHover(card: ScryfallCard | null, entering: boolean) {
		if (entering) {
			hoveredCard = card;
		} else if (!card || hoveredCard === card) {
			hoveredCard = null;
		}
	}

	// Adjustable UI dimensions in Lobby & Deck Inspector
	let lobbyChatWidth = $state(330);
	let lobbyChatHeight = $state(360);
	let inspectCardsPerRow = $state(5);

	// Navigation tabs
	let activeTab = $state<'lobbies' | 'decks'>('lobbies');

	// Decks state
	let userDecks = $state<MagicDeck[]>([]);
	let preconDecks = $state<MagicDeck[]>([]);
	let inspectedDeck = $state<MagicDeck | null>(null);
	let addingCardBusy = $state(false);
	let searchingScryfallBusy = $state(false);
	let addCardSearchResults = $state<ScryfallCard[]>([]);
	let searchRequestSeq = 0;
	let inspectStatusMsg = $state('');
	let inspectErrorMsg = $state('');
	let showImportModal = $state(false);
	let importingDeck = $state(false);
	let importName = $state('');
	let importCommander = $state('');
	let importDecklist = $state('');

	// Lobbies state
	let myLobbies = $state<LobbySummaryItem[]>([]);
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
	let advanceInFlight = $state(false);
	let serverClockOffsetMs = 0;
	let advanceMinDelayMs = 0;

	let newLobbyName = $state('');
	let joinCodeInput = $state('');
	let guestNameInput = $state('');
	let guestJoinCodeInput = $state('');

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
			const parsed = JSON.parse(text);
			if (parsed && typeof parsed.serverNow === 'number') {
				serverClockOffsetMs = parsed.serverNow - Date.now();
			}
			return parsed;
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

			const oauthError = params.get('error');
			if (oauthError) {
				const provider = oauthError.startsWith('github')
					? 'GitHub'
					: oauthError.startsWith('google')
						? 'Google'
						: 'OAuth';
				const reason = params.get('reason');
				authNotice = `${provider} sign-in failed${reason ? `: ${reason.replace(/_/g, ' ')}` : ''}. Try again, or play as a guest.`;
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

	async function advancePausedBots(code: string, version: number) {
		if (advanceInFlight || actionInFlight) return;
		if (
			!activeLobby ||
			!user ||
			activeLobby.code !== code ||
			activeLobby.version !== version ||
			activeLobby.status !== 'active' ||
			activeLobby.gameState?.status !== 'active' ||
			activeLobby.botResumeAt == null
		) {
			return;
		}
		advanceInFlight = true;
		try {
			const data = await apiFetch(appUrl('magic', '/api/lobby'), {
				method: 'POST',
				body: JSON.stringify({
					action: 'advance_bots',
					code,
					version
				})
			});
			if (!activeLobby || activeLobby.code !== code) return;
			if (data.ok && data.lobby) {
				const nextLobby: MagicLobby = data.lobby;
				if (nextLobby.version > (activeLobby.version || 0)) {
					activeLobby = nextLobby;
					lobbyChat = data.chat || lobbyChat;
				} else if (typeof data.retryAt === 'number' && nextLobby.version === version) {
					const estNow = Date.now() + serverClockOffsetMs;
					advanceMinDelayMs = Math.max(50, data.retryAt - estNow + 50);
				} else if (nextLobby.botResumeAt == null && activeLobby.botResumeAt != null) {
					activeLobby = nextLobby;
				} else if (nextLobby.version === version && nextLobby.botResumeAt != null) {
					advanceMinDelayMs = 250;
				}
			} else {
				advanceMinDelayMs = 600;
			}
		} catch {
			advanceMinDelayMs = 600;
		} finally {
			advanceInFlight = false;
		}
	}

	$effect(() => {
		const lobby = activeLobby;
		const currentUser = user;
		const busy = advanceInFlight || actionInFlight;
		if (
			!lobby ||
			!currentUser ||
			busy ||
			lobby.status !== 'active' ||
			lobby.gameState?.status !== 'active' ||
			lobby.botResumeAt == null
		) {
			return;
		}
		const code = lobby.code;
		const version = lobby.version;
		const estServerNow = Date.now() + serverClockOffsetMs;
		const rawWaitMs = Math.max(0, lobby.botResumeAt - estServerNow) + 50;
		const waitMs = Math.max(rawWaitMs, advanceMinDelayMs);
		advanceMinDelayMs = 0;

		const timerId = setTimeout(() => {
			void advancePausedBots(code, version);
		}, waitMs);

		return () => {
			clearTimeout(timerId);
		};
	});

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
		};
		const onMouseMove = (e: MouseEvent) => {
			mouseX = e.clientX;
			mouseY = e.clientY;
			if (e.altKey !== altHeld) altHeld = e.altKey;
		};

		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('keyup', onKeyUp);
		window.addEventListener('blur', onBlur);
		window.addEventListener('mousemove', onMouseMove);

		return () => {
			clearInterval(timer);
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('keyup', onKeyUp);
			window.removeEventListener('blur', onBlur);
			window.removeEventListener('mousemove', onMouseMove);
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
		inspectStatusMsg = '';
		inspectErrorMsg = '';
		addCardSearchResults = [];
	}

	async function updateInspectedCard(params: DeckCardUpdateParams): Promise<boolean> {
		if (!inspectedDeck) return false;
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
			if (
				params.operation === 'remove' ||
				(params.operation === 'set_qty' && (params.quantity ?? 1) <= 0)
			) {
				inspectStatusMsg = `Removed ${params.cardName} from deck.`;
			} else if (params.operation === 'set_qty') {
				const newQty = Math.min(99, Math.max(1, Math.floor(params.quantity ?? 1)));
				inspectStatusMsg = `Updated ${params.cardName} quantity to ${newQty}x.`;
			} else if (params.operation === 'promote_commander') {
				inspectStatusMsg = `Set ${params.cardName} as Commander.`;
			} else if (params.operation === 'demote_commander') {
				inspectStatusMsg = `Moved ${params.cardName} to mainboard.`;
			}
			return true;
		}
		inspectErrorMsg = data.error || 'Could not update card.';
		return false;
	}

	async function fetchScryfallDropdownResults(rawQuery: string, explicitTrigger = false) {
		const q = rawQuery.trim();
		if (q.length < 2) {
			addCardSearchResults = [];
			if (explicitTrigger && q.length > 0) {
				inspectErrorMsg = 'Type at least 2 characters to search Scryfall and select a card.';
			}
			return;
		}
		const reqId = ++searchRequestSeq;
		searchingScryfallBusy = true;
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
			} else if (explicitTrigger) {
				inspectErrorMsg = data.error || 'Scryfall search failed.';
			}
		} finally {
			if (reqId === searchRequestSeq) {
				searchingScryfallBusy = false;
			}
		}
	}

	function clearScryfallDropdownResults() {
		addCardSearchResults = [];
		searchingScryfallBusy = false;
	}

	async function selectCardFromDropdown(
		selectedCard: ScryfallCard,
		quantity: number,
		asCommander = false
	): Promise<boolean> {
		if (!inspectedDeck || addingCardBusy) return false;
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
					quantity,
					asCommander
				})
			});
			if (data.ok && data.deck) {
				inspectedDeck = data.deck;
				userDecks = data.decks || userDecks;
				const addedName = data.addedCard?.name || selectedCard.name;
				const addedQty = data.addedQuantity || (asCommander ? 1 : quantity);
				inspectStatusMsg = `Added ${addedQty}x ${addedName}${asCommander ? ' (Commander)' : ''} to "${data.deck.name}".`;
				return true;
			}
			inspectErrorMsg = data.error || 'Could not add card to deck.';
			return false;
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

{#if !inMatchView}
	<AltHoverPreview
		card={hoveredCard}
		{altHeld}
		{mouseX}
		{mouseY}
		breakdown={pageHoverBreakdown}
	/>
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
		botPaused={activeLobby.botResumeAt != null}
		onToggleTheme={toggleTheme}
		onGameAction={dispatchGameAction}
		onSendChat={sendPodChat}
		onLeaveMatch={() => (inMatchView = false)}
	/>
{:else}
	<div class="magic-shell">
		<MagicTopBar
			homeHref={appUrl('home', '/', page.url)}
			{user}
			{activeTab}
			userDeckCount={userDecks.length}
			{theme}
			testPresets={TEST_PLANESWALKERS}
			onSelectTab={(tab) => {
				activeTab = tab;
				if (tab === 'decks') activeLobby = null;
			}}
			onLogout={handleLogout}
			onToggleTheme={toggleTheme}
			onDevLogin={handleDevLogin}
		/>

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
			<AuthGatePanel
				bind:guestNameInput
				bind:guestJoinCodeInput
				bind:customTestName
				{authNotice}
				googleAuthHref={appUrl('magic', '/api/auth?action=login&provider=google', page.url)}
				githubAuthHref={appUrl('magic', '/api/auth?action=login&provider=github', page.url)}
				testPresets={TEST_PLANESWALKERS}
				onGuestJoin={handleGuestJoinLobby}
				onDevLogin={handleDevLogin}
			/>
		{:else if activeTab === 'lobbies'}
			{#if !activeLobby}
				<LobbyHubPanel
					{user}
					bind:joinCodeInput
					bind:newLobbyName
					{myLobbies}
					onJoinLobby={joinLobbyByCode}
					onCreateLobby={createPrivateLobby}
					onLeaveLobby={leaveLobbyByCode}
					onLogout={handleLogout}
				/>
			{:else}
				<ActivePodPanel
					lobby={activeLobby}
					{user}
					{userDecks}
					{preconDecks}
					chatMessages={lobbyChat}
					bind:lobbyChatWidth
					bind:lobbyChatHeight
					onBackToAllLobbies={() => (activeLobby = null)}
					onLeaveLobby={leaveLobbyByCode}
					onCopyInviteLink={copyInviteLink}
					onSelectDeck={selectSeatDeck}
					onAddBot={addBotToSeat}
					onRemoveBot={removeBotFromSeat}
					onTransferHost={transferLobbyHost}
					onStartMatch={startLobbyMatch}
					onEnterMatch={() => (inMatchView = true)}
					onUpdateRules={updateHostRules}
					onSendChat={sendPodChat}
				/>
			{/if}
		{:else if activeTab === 'decks'}
			<DeckManagerPanel
				{userDecks}
				{preconDecks}
				onOpenImportModal={() => {
					showImportModal = true;
					if (!importDecklist) loadSampleDecklistIntoImporter();
				}}
				onInspectDeck={openDeckInspector}
				onDeleteDeck={deleteDeck}
				onClonePrecon={(preconId) => clonePrecon(preconId, false)}
				onHoverCard={handleCardHover}
			/>
		{/if}
	</div>

	<DeckImportModal
		open={showImportModal}
		bind:importName
		bind:importCommander
		bind:importDecklist
		{importingDeck}
		onLoadSample={loadSampleDecklistIntoImporter}
		onClose={() => (showImportModal = false)}
		onSubmit={submitDeckImport}
	/>

	<DeckInspectorModal
		deck={inspectedDeck}
		bind:cardsPerRow={inspectCardsPerRow}
		bind:statusMsg={inspectStatusMsg}
		bind:errorMsg={inspectErrorMsg}
		{addingCardBusy}
		{searchingScryfallBusy}
		searchResults={addCardSearchResults}
		onClose={() => {
			inspectedDeck = null;
			addCardSearchResults = [];
		}}
		onClonePrecon={(preconId) => clonePrecon(preconId, true)}
		onSearchScryfall={fetchScryfallDropdownResults}
		onClearSearchResults={clearScryfallDropdownResults}
		onAddCard={selectCardFromDropdown}
		onUpdateCard={updateInspectedCard}
		onHoverCard={handleCardHover}
	/>
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

	.loading-box {
		padding: 2rem;
		text-align: center;
		border-radius: 8px;
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border);
		color: var(--mp-text-muted);
		font-size: 0.88rem;
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
</style>
