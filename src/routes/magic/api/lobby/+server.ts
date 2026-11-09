import type { RequestHandler } from '@sveltejs/kit';
import { runAutomatedPriorityAndBots, SERVER_MAX_BOT_STEPS } from '../../../../lib/magic/ai';

/** Bot automation budget per request (every triggered ability uses the stack). */
const BOT_LOOP_OPTS = { maxSteps: SERVER_MAX_BOT_STEPS, logOnCap: true };
import {
	addChatMessage,
	CORS_HEADERS,
	deleteLobby,
	getAuthenticatedUser,
	getDeckById,
	getLobbyByCode,
	getLobbyChatMessages,
	jsonResponse,
	listUserActiveLobbies,
	saveLobby,
	upsertUserAndCreateSession
} from '../../../../lib/magic/db';
import {
	applyGameAction,
	createInitialGameState,
	sanitizeGameStateForViewer
} from '../../../../lib/magic/engine';
import { PRECON_DECKS } from '../../../../lib/magic/precons';
import {
	DEFAULT_LOBBY_RULES,
	type GameActionPayload,
	type LobbyRulesConfig,
	type LobbySeat,
	type MagicDeck,
	type MagicLobby
} from '../../../../lib/magic/types';

export const trailingSlash = 'ignore';

const BOT_NAMES = [
	'Teferi (AI Bot)',
	'Liliana (AI Bot)',
	'Chandra (AI Bot)',
	'Garruk (AI Bot)'
];

function generateInviteCode(): string {
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let out = '';
	for (let i = 0; i < 6; i++) {
		out += chars[Math.floor(Math.random() * chars.length)];
	}
	return out;
}

function makeEmptySeat(seatIndex: number): LobbySeat {
	return {
		seatIndex,
		userId: null,
		username: 'Open Seat',
		avatarUrl: '',
		isBot: false,
		isGuest: false,
		deckId: null,
		deckName: '',
		commanderNames: [],
		commanderArtUrl: '',
		colorIdentity: [],
		isDeckLegal: true,
		ready: false,
		lastHeartbeat: 0
	};
}

function assignDeckToSeat(seat: LobbySeat, deck: MagicDeck): void {
	seat.deckId = deck.id;
	seat.deckName = deck.name;
	seat.commanderNames = deck.commanders.map((c) => c.name);
	seat.commanderArtUrl = deck.commanders[0]?.artCropUrl || deck.commanders[0]?.imageUrl || '';
	seat.colorIdentity = deck.colorIdentity;
	seat.isDeckLegal = deck.isLegal;
}

async function resolveDeckForSeat(
	platform: App.Platform | undefined,
	deckId: string | null,
	fallbackIdx = 0
): Promise<MagicDeck> {
	if (deckId) {
		const precon = PRECON_DECKS.find((p) => p.id === deckId);
		if (precon) return precon;
		const custom = await getDeckById(platform, deckId);
		if (custom) return custom;
	}
	return PRECON_DECKS[fallbackIdx % PRECON_DECKS.length];
}

function sanitizeLobbyForUser(lobby: MagicLobby, userId: string | null): MagicLobby {
	return {
		...lobby,
		gameState: lobby.gameState ? sanitizeGameStateForViewer(lobby.gameState, userId) : null
	};
}

export const OPTIONS: RequestHandler = async () => {
	return new Response(null, { status: 204, headers: CORS_HEADERS });
};

export const GET: RequestHandler = async ({ url, request, platform }) => {
	const user = await getAuthenticatedUser(request, platform);
	const code = (url.searchParams.get('code') || '').trim().toUpperCase();

	if (!code) {
		const myLobbies = user ? await listUserActiveLobbies(platform, user.id) : [];
		return jsonResponse({
			ok: true,
			myLobbies: myLobbies.map((l) => ({
				code: l.code,
				name: l.name,
				status: l.status,
				hostUserId: l.hostUserId,
				playerCount: l.seats.filter((s) => s.userId || s.isBot).length,
				maxPlayers: l.rules.maxPlayers,
				updatedAt: l.updatedAt
			}))
		});
	}

	const lobby = await getLobbyByCode(platform, code);
	if (!lobby) {
		return jsonResponse({ ok: false, error: `Lobby "${code}" not found.` }, 404);
	}

	const now = Date.now();
	let shouldSave = false;

	// Enforce server-side Rope Timer (turnTimerSeconds) if active and expired
	if (
		lobby.gameState &&
		lobby.gameState.status === 'active' &&
		lobby.gameState.rules.turnTimerSeconds > 0 &&
		lobby.gameState.pendingPrompts.length === 0 &&
		now - lobby.gameState.priorityUpdatedAt >= lobby.gameState.rules.turnTimerSeconds * 1000
	) {
		const prioPlayer = lobby.gameState.players[lobby.gameState.priorityPlayerIndex];
		if (prioPlayer && !prioPlayer.lost) {
			const res = applyGameAction(lobby.gameState, prioPlayer.playerId, {
				type: 'pass_priority'
			});
			if (res.ok) {
				runAutomatedPriorityAndBots(lobby.gameState, BOT_LOOP_OPTS);
				if ((lobby.gameState.status as string) === 'finished') {
					lobby.status = 'finished';
				}
				lobby.version += 1;
				lobby.updatedAt = now;
				shouldSave = true;
			}
		}
	}

	if (shouldSave) {
		await saveLobby(platform, lobby);
	}

	const chat = await getLobbyChatMessages(platform, code, 80);
	return jsonResponse({
		ok: true,
		lobby: sanitizeLobbyForUser(lobby, user?.id || null),
		chat
	});
};

export const POST: RequestHandler = async ({ request, platform }) => {
	const body = (await request.json()) as Record<string, any>;
	const action = String(body.action || '');
	const now = Date.now();

	let user = await getAuthenticatedUser(request, platform);
	let newSessionToken: string | undefined;

	if (!user && action === 'join' && body.guestName) {
		const guestName = String(body.guestName || '').trim().slice(0, 32);
		if (!guestName) {
			return jsonResponse(
				{ ok: false, error: 'Please enter a guest display name to join.' },
				400
			);
		}
		const created = await upsertUserAndCreateSession(platform, {
			provider: 'guest',
			providerId: `${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
			email: '',
			username: guestName,
			avatarUrl: ''
		});
		user = created.user;
		newSessionToken = created.token;
	}

	if (!user) {
		return jsonResponse(
			{ ok: false, error: 'Please sign in or enter a guest name to join.' },
			401
		);
	}

	if (action === 'create') {
		if (user.provider === 'guest' || user.isGuest) {
			return jsonResponse(
				{
					ok: false,
					error: 'Sign in with a Google or GitHub account to create and host private lobbies. Guests can join private lobbies using an invite code.'
				},
				403
			);
		}
		const code = generateInviteCode();
		const lobbyName = String(body.name || `${user.username}'s Commander Pod`).trim().slice(0, 48);
		const rules: LobbyRulesConfig = {
			...DEFAULT_LOBBY_RULES,
			...(body.rules || {})
		};

		const seats: LobbySeat[] = [
			makeEmptySeat(0),
			makeEmptySeat(1),
			makeEmptySeat(2),
			makeEmptySeat(3)
		].slice(0, rules.maxPlayers);

		// Seat host in Seat 0 with default precon
		seats[0].userId = user.id;
		seats[0].username = user.username;
		seats[0].avatarUrl = user.avatarUrl;
		seats[0].isGuest = false;
		seats[0].ready = true;
		seats[0].lastHeartbeat = now;
		assignDeckToSeat(seats[0], PRECON_DECKS[0]);

		const lobby: MagicLobby = {
			code,
			name: lobbyName,
			hostUserId: user.id,
			status: 'waiting',
			isPrivate: true,
			rules,
			seats,
			gameState: null,
			version: 1,
			createdAt: now,
			updatedAt: now
		};

		await saveLobby(platform, lobby);
		await addChatMessage(platform, {
			id: `msg_${now}_sys`,
			lobbyCode: code,
			userId: 'system',
			username: 'Pod System',
			avatarUrl: '',
			seatIdx: -1,
			kind: 'system',
			message: `${user.username} created private Commander pod ${code}. Share invite code "${code}" with friends or add AI Bots to start!`,
			createdAt: now
		});

		const chat = await getLobbyChatMessages(platform, code, 80);
		return jsonResponse({
			ok: true,
			lobby: sanitizeLobbyForUser(lobby, user.id),
			chat
		});
	}

	const code = String(body.code || '').trim().toUpperCase();
	if (!code) {
		return jsonResponse({ ok: false, error: 'Missing lobby invite code.' }, 400);
	}

	const lobby = await getLobbyByCode(platform, code);
	if (!lobby) {
		return jsonResponse(
			{
				ok: false,
				error: `No lobby found with invite code "${code}".`,
				user,
				token: newSessionToken
			},
			404,
			newSessionToken
				? {
						'Set-Cookie': `magic_session=${encodeURIComponent(newSessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
				  }
				: undefined
		);
	}

	if (action === 'join') {
		const isGuestUser = user.provider === 'guest' || Boolean(user.isGuest);
		const existingSeat = lobby.seats.find((s) => s.userId === user.id);
		if (!existingSeat && lobby.status === 'waiting') {
			let openSeat = lobby.seats.find((s) => s.userId === null && !s.isBot);
			if (!openSeat) {
				// Replace a bot seat if all remaining seats are bots
				openSeat = lobby.seats.find((s) => s.isBot);
			}
			if (!openSeat) {
				return jsonResponse(
					{
						ok: false,
						error: 'This Commander lobby is already full.',
						user,
						token: newSessionToken
					},
					400,
					newSessionToken
						? {
								'Set-Cookie': `magic_session=${encodeURIComponent(newSessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
						  }
						: undefined
				);
			}
			openSeat.userId = user.id;
			openSeat.username = user.username;
			openSeat.avatarUrl = user.avatarUrl;
			openSeat.isBot = false;
			openSeat.isGuest = isGuestUser;
			openSeat.ready = true;
			openSeat.lastHeartbeat = now;
			assignDeckToSeat(openSeat, PRECON_DECKS[openSeat.seatIndex % PRECON_DECKS.length]);

			lobby.version += 1;
			lobby.updatedAt = now;
			await saveLobby(platform, lobby);

			await addChatMessage(platform, {
				id: `msg_${now}_${Math.random().toString(36).slice(2, 6)}`,
				lobbyCode: code,
				userId: 'system',
				username: 'Pod System',
				avatarUrl: '',
				seatIdx: openSeat.seatIndex,
				kind: 'system',
				message: `${user.username}${isGuestUser ? ' (Guest)' : ''} joined Seat #${openSeat.seatIndex + 1}!`,
				createdAt: now
			});
		} else if (existingSeat) {
			existingSeat.lastHeartbeat = now;
			await saveLobby(platform, lobby);
		}

		const chat = await getLobbyChatMessages(platform, code, 80);
		return jsonResponse(
			{
				ok: true,
				user,
				token: newSessionToken,
				lobby: sanitizeLobbyForUser(lobby, user.id),
				chat
			},
			200,
			newSessionToken
				? {
						'Set-Cookie': `magic_session=${encodeURIComponent(newSessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
				  }
				: undefined
		);
	}

	if (action === 'leave') {
		const seatIdx = lobby.seats.findIndex((s) => s.userId === user.id);
		if (seatIdx >= 0) {
			if (lobby.gameState) {
				const gp = lobby.gameState.players.find((p) => p.playerId === user.id);
				if (gp && !gp.lost) {
					applyGameAction(lobby.gameState, user.id, { type: 'concede' });
					runAutomatedPriorityAndBots(lobby.gameState, BOT_LOOP_OPTS);
					if (lobby.gameState.status === 'finished') {
						lobby.status = 'finished';
					}
				}
			}
			lobby.seats[seatIdx] = makeEmptySeat(seatIdx);
		}

		const remainingHumans = lobby.seats.filter((s) => s.userId !== null && !s.isBot);
		if (remainingHumans.length === 0) {
			await deleteLobby(platform, code);
			return jsonResponse({
				ok: true,
				deleted: true,
				lobby: null
			});
		}

		let hostTransferredMsg = '';
		if (lobby.hostUserId === user.id) {
			const nextHostSeat =
				remainingHumans.find((s) => !s.isGuest) || remainingHumans[0];
			lobby.hostUserId = nextHostSeat.userId!;
			hostTransferredMsg = ` ${nextHostSeat.username} is now the lobby Host.`;
		}

		lobby.version += 1;
		lobby.updatedAt = now;
		await saveLobby(platform, lobby);

		await addChatMessage(platform, {
			id: `msg_${now}_leave`,
			lobbyCode: code,
			userId: 'system',
			username: 'Pod System',
			avatarUrl: '',
			seatIdx,
			kind: 'system',
			message: `${user.username} left the pod.${hostTransferredMsg}`,
			createdAt: now
		});

		const chat = await getLobbyChatMessages(platform, code, 80);
		return jsonResponse({
			ok: true,
			deleted: false,
			lobby: sanitizeLobbyForUser(lobby, user.id),
			chat
		});
	}

	if (action === 'delete_lobby') {
		if (lobby.hostUserId !== user.id) {
			return jsonResponse(
				{ ok: false, error: 'Only the lobby host can delete the lobby.' },
				403
			);
		}
		await deleteLobby(platform, code);
		return jsonResponse({
			ok: true,
			deleted: true,
			lobby: null
		});
	}

	if (action === 'transfer_host') {
		if (lobby.hostUserId !== user.id) {
			return jsonResponse(
				{ ok: false, error: 'Only the current lobby host can transfer ownership.' },
				403
			);
		}
		const targetUserId = String(body.targetUserId || '');
		const targetSeat = lobby.seats.find(
			(s) => s.userId === targetUserId && !s.isBot
		);
		if (!targetSeat || !targetSeat.userId) {
			return jsonResponse(
				{ ok: false, error: 'Target player is not a human seated in this lobby.' },
				400
			);
		}
		lobby.hostUserId = targetSeat.userId;
		lobby.version += 1;
		lobby.updatedAt = now;
		await saveLobby(platform, lobby);

		await addChatMessage(platform, {
			id: `msg_${now}_host`,
			lobbyCode: code,
			userId: 'system',
			username: 'Pod System',
			avatarUrl: '',
			seatIdx: targetSeat.seatIndex,
			kind: 'system',
			message: `${user.username} transferred lobby Host ownership to ${targetSeat.username}.`,
			createdAt: now
		});

		const chat = await getLobbyChatMessages(platform, code, 80);
		return jsonResponse({
			ok: true,
			lobby: sanitizeLobbyForUser(lobby, user.id),
			chat
		});
	}

	if (action === 'select_deck') {
		const seat = lobby.seats.find((s) => s.userId === user.id);
		if (!seat) {
			return jsonResponse({ ok: false, error: 'You are not seated in this lobby.' }, 400);
		}
		const deckId = String(body.deckId || '');
		const deck = await resolveDeckForSeat(platform, deckId, seat.seatIndex);

		if (lobby.rules.deckValidationMode === 'strict_commander' && !deck.isLegal) {
			return jsonResponse(
				{
					ok: false,
					error: `Deck "${deck.name}" has Commander legality issues (${deck.validationErrors[0] || 'invalid'}). Either fix the deck or ask the host to enable Rule 0 Relaxed mode.`
				},
				400
			);
		}

		assignDeckToSeat(seat, deck);
		seat.ready = true;
		lobby.version += 1;
		lobby.updatedAt = now;
		await saveLobby(platform, lobby);

		const chat = await getLobbyChatMessages(platform, code, 80);
		return jsonResponse({
			ok: true,
			lobby: sanitizeLobbyForUser(lobby, user.id),
			chat
		});
	}

	if (action === 'add_bot') {
		if (lobby.hostUserId !== user.id) {
			return jsonResponse({ ok: false, error: 'Only the lobby host can add AI Bots.' }, 403);
		}
		const targetSeatIdx =
			typeof body.seatIndex === 'number'
				? body.seatIndex
				: lobby.seats.findIndex((s) => s.userId === null && !s.isBot);
		const seat = lobby.seats[targetSeatIdx];
		if (!seat || seat.userId !== null) {
			return jsonResponse({ ok: false, error: 'No open seat available for an AI Bot.' }, 400);
		}

		const precon = PRECON_DECKS[targetSeatIdx % PRECON_DECKS.length];
		seat.userId = null;
		seat.isBot = true;
		seat.username = BOT_NAMES[targetSeatIdx % BOT_NAMES.length];
		seat.avatarUrl = '';
		seat.ready = true;
		seat.lastHeartbeat = now;
		assignDeckToSeat(seat, precon);

		lobby.version += 1;
		lobby.updatedAt = now;
		await saveLobby(platform, lobby);

		await addChatMessage(platform, {
			id: `msg_${now}_bot`,
			lobbyCode: code,
			userId: 'system',
			username: 'Pod System',
			avatarUrl: '',
			seatIdx: targetSeatIdx,
			kind: 'system',
			message: `Added ${seat.username} piloting ${precon.name} to Seat #${targetSeatIdx + 1}.`,
			createdAt: now
		});

		const chat = await getLobbyChatMessages(platform, code, 80);
		return jsonResponse({
			ok: true,
			lobby: sanitizeLobbyForUser(lobby, user.id),
			chat
		});
	}

	if (action === 'remove_bot') {
		if (lobby.hostUserId !== user.id) {
			return jsonResponse({ ok: false, error: 'Only the lobby host can remove AI Bots.' }, 403);
		}
		const seatIdx = Number(body.seatIndex ?? -1);
		if (lobby.seats[seatIdx] && lobby.seats[seatIdx].isBot) {
			lobby.seats[seatIdx] = makeEmptySeat(seatIdx);
			lobby.version += 1;
			lobby.updatedAt = now;
			await saveLobby(platform, lobby);
		}
		const chat = await getLobbyChatMessages(platform, code, 80);
		return jsonResponse({
			ok: true,
			lobby: sanitizeLobbyForUser(lobby, user.id),
			chat
		});
	}

	if (action === 'update_rules') {
		if (lobby.hostUserId !== user.id) {
			return jsonResponse({ ok: false, error: 'Only the lobby host can change lobby rules.' }, 403);
		}
		const nextRules: LobbyRulesConfig = {
			...lobby.rules,
			...(body.rules || {})
		};
		lobby.rules = nextRules;

		// Adjust seat count if maxPlayers changed while waiting
		if (lobby.status === 'waiting') {
			while (lobby.seats.length < nextRules.maxPlayers) {
				lobby.seats.push(makeEmptySeat(lobby.seats.length));
			}
			if (lobby.seats.length > nextRules.maxPlayers) {
				lobby.seats = lobby.seats.slice(0, nextRules.maxPlayers);
			}
		}

		lobby.version += 1;
		lobby.updatedAt = now;
		await saveLobby(platform, lobby);

		await addChatMessage(platform, {
			id: `msg_${now}_rules`,
			lobbyCode: code,
			userId: 'system',
			username: 'Pod System',
			avatarUrl: '',
			seatIdx: -1,
			kind: 'system',
			message: `Host updated rules: ${nextRules.startingLife} Life, ${nextRules.commanderDamageLethal || 'Off'} Cmdr Damage, +${nextRules.commanderTaxIncrement} Cmdr Tax, ${nextRules.mulliganRule === 'friendly_unlimited' ? 'Friendly Mulligans' : 'London Mulligan'}.`,
			createdAt: now
		});

		const chat = await getLobbyChatMessages(platform, code, 80);
		return jsonResponse({
			ok: true,
			lobby: sanitizeLobbyForUser(lobby, user.id),
			chat
		});
	}

	if (action === 'start_game') {
		if (lobby.hostUserId !== user.id) {
			return jsonResponse({ ok: false, error: 'Only the lobby host can start the match.' }, 403);
		}

		const occupiedSeats = lobby.seats.filter((s) => s.userId !== null || s.isBot);
		if (occupiedSeats.length < 2) {
			return jsonResponse(
				{
					ok: false,
					error: 'At least 2 players (or 1 human + 1 AI Bot) are required to start a Commander match.'
				},
				400
			);
		}

		const decksBySeat = new Map<number, MagicDeck>();
		for (const s of occupiedSeats) {
			const deck = await resolveDeckForSeat(platform, s.deckId, s.seatIndex);
			if (lobby.rules.deckValidationMode === 'strict_commander' && !deck.isLegal) {
				return jsonResponse(
					{
						ok: false,
						error: `${s.username}'s deck "${deck.name}" is not Commander-legal. Switch decks or enable Rule 0 mode.`
					},
					400
				);
			}
			decksBySeat.set(s.seatIndex, deck);
		}

		const gameState = createInitialGameState(lobby.code, occupiedSeats, decksBySeat, lobby.rules);
		runAutomatedPriorityAndBots(gameState, BOT_LOOP_OPTS);

		lobby.gameState = gameState;
		lobby.status = 'active';
		lobby.version += 1;
		lobby.updatedAt = now;
		await saveLobby(platform, lobby);

		await addChatMessage(platform, {
			id: `msg_${now}_start`,
			lobbyCode: code,
			userId: 'system',
			username: 'Pod System',
			avatarUrl: '',
			seatIdx: -1,
			kind: 'system',
			message: `Match started! Check your opening 7-card hand for London Mulligans.`,
			createdAt: now
		});

		const chat = await getLobbyChatMessages(platform, code, 80);
		return jsonResponse({
			ok: true,
			lobby: sanitizeLobbyForUser(lobby, user.id),
			chat
		});
	}

	if (action === 'game_action') {
		if (!lobby.gameState) {
			return jsonResponse({ ok: false, error: 'Game has not started yet.' }, 400);
		}
		const payload = body.gameAction as GameActionPayload;
		if (!payload || !payload.type) {
			return jsonResponse({ ok: false, error: 'Missing gameAction payload.' }, 400);
		}

		const result = applyGameAction(lobby.gameState, user.id, payload);
		if (!result.ok) {
			return jsonResponse({ ok: false, error: result.error || 'Illegal game action.' }, 400);
		}

		// Run any automated priority passes or AI Bot turns
		runAutomatedPriorityAndBots(lobby.gameState, BOT_LOOP_OPTS);

		if (lobby.gameState.status === 'finished') {
			lobby.status = 'finished';
		}

		lobby.version += 1;
		lobby.updatedAt = now;
		await saveLobby(platform, lobby);

		const chat = await getLobbyChatMessages(platform, code, 80);
		return jsonResponse({
			ok: true,
			lobby: sanitizeLobbyForUser(lobby, user.id),
			chat
		});
	}

	if (action === 'chat') {
		const text = String(body.message || '').trim().slice(0, 400);
		if (!text) {
			return jsonResponse({ ok: false, error: 'Empty message.' }, 400);
		}
		const kind = body.kind === 'emote' ? 'emote' : 'chat';
		const seatIdx = lobby.seats.findIndex((s) => s.userId === user.id);

		await addChatMessage(platform, {
			id: `msg_${now}_${Math.random().toString(36).slice(2, 8)}`,
			lobbyCode: code,
			userId: user.id,
			username: user.username,
			avatarUrl: user.avatarUrl,
			seatIdx,
			kind,
			message: text,
			createdAt: now
		});

		const chat = await getLobbyChatMessages(platform, code, 80);
		return jsonResponse({ ok: true, chat });
	}

	return jsonResponse({ ok: false, error: `Unknown lobby action: ${action}` }, 400);
};
