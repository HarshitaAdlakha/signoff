// Mattermost helpers for the demo recorder: sign people in (token → cookie) and find channels.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../../agents/lib/env.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const env = loadEnv(`${root}switch/.env`);
export const state = JSON.parse(readFileSync(`${root}var/state.json`, 'utf8'));
export const MM = `http://localhost:${env.MATTERMOST_HOST_PORT || 8065}`;
export const TEAM = env.MATTERMOST_TEAM_NAME;

export async function login(username) {
  const password = username === env.MATTERMOST_USER ? env.MATTERMOST_USER_PASSWORD : state.dispatcher_password;
  const r = await fetch(`${MM}/api/v4/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login_id: username, password }) });
  if (!r.ok) throw new Error(`login ${username} ${r.status}`);
  const user = await r.json();
  return { token: r.headers.get('token'), user };
}

export async function api(token, method, path, body) {
  const r = await fetch(`${MM}/api/v4${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

export async function channels(token) {
  const team = await api(token, 'GET', `/teams/name/${TEAM}`);
  const mine = await api(token, 'GET', `/users/me/teams/${team.id}/channels`);
  return { team, mine };
}

/** Sign a puppeteer page in as `username` by setting Mattermost's auth cookies. */
export async function signIn(page, username) {
  const { token, user } = await login(username);
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('__landingPageSeen__', 'true'); } catch {} });
  await page.setCookie(
    { name: 'MMAUTHTOKEN', value: token, domain: 'localhost', path: '/', httpOnly: true },
    { name: 'MMUSERID', value: user.id, domain: 'localhost', path: '/' },
  );
  return { token, user };
}
