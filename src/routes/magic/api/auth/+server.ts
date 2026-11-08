import type { RequestHandler } from '@sveltejs/kit';
import {
	CORS_HEADERS,
	deleteSession,
	extractSessionToken,
	getAuthenticatedUser,
	getEnvVar,
	jsonResponse,
	upsertUserAndCreateSession
} from '../../../../lib/magic/db';

export const trailingSlash = 'ignore';

export const OPTIONS: RequestHandler = async () => {
	return new Response(null, { status: 204, headers: CORS_HEADERS });
};

export const GET: RequestHandler = async ({ url, request, platform }) => {
	const action = url.searchParams.get('action') || 'me';
	const googleClientId = getEnvVar(platform, 'GOOGLE_CLIENT_ID');
	const githubClientId = getEnvVar(platform, 'GITHUB_CLIENT_ID');

	if (action === 'me') {
		const user = await getAuthenticatedUser(request, platform);
		return jsonResponse({
			ok: true,
			user,
			oauthConfigured: {
				google: Boolean(googleClientId),
				github: Boolean(githubClientId)
			}
		});
	}

	if (action === 'login') {
		const provider = url.searchParams.get('provider') === 'github' ? 'github' : 'google';
		const state = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
		const redirectUri = `${url.origin}/magic/api/auth?action=callback&provider=${provider}`;

		if (provider === 'google') {
			if (!googleClientId) {
				return new Response(null, {
					status: 302,
					headers: {
						Location: `/magic/?oauth_setup=google`
					}
				});
			}
			const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
			authUrl.searchParams.set('client_id', googleClientId);
			authUrl.searchParams.set('redirect_uri', redirectUri);
			authUrl.searchParams.set('response_type', 'code');
			authUrl.searchParams.set('scope', 'openid email profile');
			authUrl.searchParams.set('state', state);

			return new Response(null, {
				status: 302,
				headers: {
					Location: authUrl.toString(),
					'Set-Cookie': `magic_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`
				}
			});
		} else {
			if (!githubClientId) {
				return new Response(null, {
					status: 302,
					headers: {
						Location: `/magic/?oauth_setup=github`
					}
				});
			}
			const authUrl = new URL('https://github.com/login/oauth/authorize');
			authUrl.searchParams.set('client_id', githubClientId);
			authUrl.searchParams.set('redirect_uri', redirectUri);
			authUrl.searchParams.set('scope', 'read:user user:email');
			authUrl.searchParams.set('state', state);

			return new Response(null, {
				status: 302,
				headers: {
					Location: authUrl.toString(),
					'Set-Cookie': `magic_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`
				}
			});
		}
	}

	if (action === 'callback') {
		const provider = url.searchParams.get('provider') === 'github' ? 'github' : 'google';
		const code = url.searchParams.get('code') || '';
		if (!code) {
			return new Response(null, { status: 302, headers: { Location: '/magic/?error=missing_code' } });
		}

		const redirectUri = `${url.origin}/magic/api/auth?action=callback&provider=${provider}`;

		try {
			if (provider === 'google') {
				const googleSecret = getEnvVar(platform, 'GOOGLE_CLIENT_SECRET');
				const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({
						code,
						client_id: googleClientId,
						client_secret: googleSecret,
						redirect_uri: redirectUri,
						grant_type: 'authorization_code'
					})
				});
				const tokenData = (await tokenRes.json()) as { access_token?: string };
				if (!tokenData.access_token) {
					return new Response(null, {
						status: 302,
						headers: { Location: '/magic/?error=google_token_failed' }
					});
				}

				const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
					headers: { Authorization: `Bearer ${tokenData.access_token}` }
				});
				const profile = (await profileRes.json()) as {
					sub?: string;
					email?: string;
					name?: string;
					picture?: string;
				};

				const { token } = await upsertUserAndCreateSession(platform, {
					provider: 'google',
					providerId: profile.sub || profile.email || 'google_user',
					email: profile.email || '',
					username: profile.name || profile.email?.split('@')[0] || 'Planeswalker',
					avatarUrl: profile.picture || ''
				});

				return new Response(null, {
					status: 302,
					headers: {
						Location: `/magic/?session_token=${encodeURIComponent(token)}`,
						'Set-Cookie': `magic_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
					}
				});
			} else {
				const githubSecret = getEnvVar(platform, 'GITHUB_CLIENT_SECRET');
				const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Accept: 'application/json'
					},
					body: JSON.stringify({
						client_id: githubClientId,
						client_secret: githubSecret,
						code,
						redirect_uri: redirectUri
					})
				});
				const tokenData = (await tokenRes.json()) as { access_token?: string };
				if (!tokenData.access_token) {
					return new Response(null, {
						status: 302,
						headers: { Location: '/magic/?error=github_token_failed' }
					});
				}

				const userRes = await fetch('https://api.github.com/user', {
					headers: {
						Authorization: `Bearer ${tokenData.access_token}`,
						'User-Agent': 'PeckhamrMagicCommander/1.0'
					}
				});
				const ghUser = (await userRes.json()) as {
					id?: number | string;
					login?: string;
					name?: string;
					email?: string;
					avatar_url?: string;
				};

				const { token } = await upsertUserAndCreateSession(platform, {
					provider: 'github',
					providerId: String(ghUser.id || ghUser.login || 'gh_user'),
					email: ghUser.email || '',
					username: ghUser.name || ghUser.login || 'Planeswalker',
					avatarUrl: ghUser.avatar_url || ''
				});

				return new Response(null, {
					status: 302,
					headers: {
						Location: `/magic/?session_token=${encodeURIComponent(token)}`,
						'Set-Cookie': `magic_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
					}
				});
			}
		} catch {
			return new Response(null, {
				status: 302,
				headers: { Location: '/magic/?error=oauth_exception' }
			});
		}
	}

	return jsonResponse({ ok: false, error: `Unknown auth action: ${action}` }, 400);
};

export const POST: RequestHandler = async ({ request, platform }) => {
	const body = (await request.json()) as Record<string, any>;
	const action = String(body.action || '');

	if (action === 'guest_login') {
		const username = String(body.username || '').trim().slice(0, 32);
		if (!username) {
			return jsonResponse(
				{ ok: false, error: 'Please enter a display name to continue as a guest.' },
				400
			);
		}
		const providerId = String(
			body.guestId ||
				`${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
		);
		const { user, token } = await upsertUserAndCreateSession(platform, {
			provider: 'guest',
			providerId,
			email: '',
			username,
			avatarUrl: ''
		});

		return jsonResponse(
			{ ok: true, user, token },
			200,
			{
				'Set-Cookie': `magic_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
			}
		);
	}

	if (action === 'dev_login') {
		const provider =
			body.provider === 'google' || body.provider === 'github' ? body.provider : 'dev';
		const username = String(body.username || 'Jace Beleren').trim().slice(0, 32);
		const email = String(
			body.email || `${username.toLowerCase().replace(/[^a-z0-9]/g, '.')}@planeswalker.mtg`
		);
		const providerId = String(
			body.providerId || username.toLowerCase().replace(/[^a-z0-9]/g, '_')
		);
		const avatarUrl = String(body.avatarUrl || '');

		const { user, token } = await upsertUserAndCreateSession(platform, {
			provider,
			providerId,
			email,
			username,
			avatarUrl
		});

		return jsonResponse(
			{ ok: true, user, token },
			200,
			{
				'Set-Cookie': `magic_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
			}
		);
	}

	if (action === 'logout') {
		const token = extractSessionToken(request);
		if (token) {
			await deleteSession(platform, token);
		}
		return jsonResponse(
			{ ok: true },
			200,
			{
				'Set-Cookie': 'magic_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
			}
		);
	}

	return jsonResponse({ ok: false, error: `Unknown auth POST action: ${action}` }, 400);
};
