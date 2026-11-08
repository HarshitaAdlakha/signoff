// One-time setup of Signoff on a Switch server, all through Switch's own APIs:
//   1. sign in to the Gateway as the admin, create a registration key
//   2. register the four agents (watcher, fixer, analyst, scribe)
//   3. set who may address each agent (the fixer stays owner-only: that is the sign-off gate)
//   4. create the two rooms in Mattermost, with instructions, roles and a link between them
//   5. add a second person (the dispatcher) to Mattermost
// Writes var/state.json (agent ids + keys + room ids). Safe to re-run with --fresh to start over.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../agents/lib/env.mjs';
import { AGENTS, ROOMS, PEOPLE } from '../agents/lib/config.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = { ...loadEnv(`${root}switch/.env`), ...process.env };
const BASE = env.SWITCH_URL || `http://localhost:${env.API_HOST_PORT || 8000}`;
const MM = env.MATTERMOST_URL || `http://localhost:${env.MATTERMOST_HOST_PORT || 8065}`;
const STATE = `${root}var/state.json`;
mkdirSync(`${root}var`, { recursive: true });
const fresh = process.argv.includes('--fresh');
const state = !fresh && existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { agents: {}, rooms: {} };
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const step = (s) => console.log(`\n▸ ${s}`);

// ── Gateway (cookie session) ────────────────────────────────────────────────
let cookie = '';
async function gw(method, path, body) {
  const r = await fetch(`${BASE}/gateway${path}`, {
    method, headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body),
  });
  const sc = r.headers.getSetCookie?.() || [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const t = await r.text();
  if (!r.ok) throw new Error(`gateway ${method} ${path} ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}

// ── Mattermost REST (admin token) ───────────────────────────────────────────
let mmToken = '';
async function mm(method, path, body) {
  const r = await fetch(`${MM}/api/v4${path}`, {
    method, headers: { 'content-type': 'application/json', ...(mmToken && { authorization: `Bearer ${mmToken}` }) },
    body: body && JSON.stringify(body),
  });
  if (path === '/users/login') mmToken = r.headers.get('token') || '';
  const t = await r.text();
  return { ok: r.ok, status: r.status, json: t ? JSON.parse(t) : null };
}

async function agentOp(name, operation, args = {}) {
  const a = state.agents[name];
  const r = await fetch(`${BASE}/agents/${a.id}/ops/${operation}`, {
    method: 'POST', headers: { authorization: `Bearer ${a.api_key}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${name}.${operation} ${r.status}: ${t.slice(0, 400)}`);
  return JSON.parse(t).result;
}

step(`Switch at ${BASE}`);
const health = await fetch(`${BASE}/health`).then((r) => r.json());
console.log('  health:', health.status);

step('Sign in to the Gateway and create a registration key');
await gw('POST', '/auth/login', { email: env.GATEWAY_ADMIN_EMAIL, password: env.GATEWAY_ADMIN_PASSWORD });
let regKey = state.registration_key;
if (!regKey) {
  const k = await gw('POST', '/api-keys', { label: 'signoff agents', expires_in_days: 'never' });
  regKey = state.registration_key = k.key;
  save();
  console.log('  created key', k.id);
} else console.log('  reusing saved key');

step('Register the agents');
for (const a of AGENTS) {
  if (state.agents[a.name]?.api_key) { console.log(`  ${a.name}: already registered`); continue; }
  const r = await fetch(`${BASE}/agents`, {
    method: 'POST', headers: { authorization: `Bearer ${regKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: a.name, display_name: a.display_name, description: a.description, connector_type: 'signoff-node',
      integration_profile: {
        connection_model: 'always_on', message_exchange: true,
        pre_invocation_mediation: [], post_invocation_mediation: [], event_reporting: [],
      },
      metadata: { project: 'signoff' }, overwrite: true,
    }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`register ${a.name} ${r.status}: ${t}`);
  const j = JSON.parse(t);
  state.agents[a.name] = { id: j.id ?? j.agent_id, api_key: j.api_key };
  save();
  console.log(`  ${a.name}: ${state.agents[a.name].id}`);
}

step('Who may address each agent');
// An agent can't change its own settings, so each agent's neighbour (same owner) sets them.
for (const [i, a] of AGENTS.entries()) {
  const by = AGENTS[(i + 1) % AGENTS.length].name;
  await agentOp(by, 'update_agent_detail', { agent_id: state.agents[a.name].id, addressing: a.addressing });
  console.log(`  ${a.name}: ${a.addressing}`);
}

step('People in Mattermost');
const login = await mm('POST', '/users/login', { login_id: env.MATTERMOST_ADMIN_USER, password: env.MATTERMOST_ADMIN_PASSWORD });
if (!login.ok) throw new Error(`mattermost login ${login.status}`);
const team = (await mm('GET', `/teams/name/${env.MATTERMOST_TEAM_NAME}`)).json;
// The seeded account `user` is linked to the Switch admin, so it is the agents' owner: the data owner.
const owner = (await mm('GET', `/users/username/${env.MATTERMOST_USER}`)).json;
await mm('PUT', `/users/${owner.id}/patch`, { first_name: PEOPLE.owner.first, last_name: PEOPLE.owner.last, nickname: PEOPLE.owner.role });
console.log(`  data owner: @${owner.username} (${PEOPLE.owner.first} ${PEOPLE.owner.last})`);
const found = await mm('GET', `/users/username/${PEOPLE.dispatcher.username}`);
let disp = found.ok ? found.json : null;
if (!disp?.username) {
  state.dispatcher_password = state.dispatcher_password || `Sg-${crypto.randomUUID()}`;
  save();
  disp = (await mm('POST', '/users', {
    username: PEOPLE.dispatcher.username, email: `${PEOPLE.dispatcher.username}@signoff.test`,
    password: state.dispatcher_password, first_name: PEOPLE.dispatcher.first, last_name: PEOPLE.dispatcher.last,
    nickname: PEOPLE.dispatcher.role,
  })).json;
  if (!disp?.username) throw new Error(`could not create the dispatcher in Mattermost: ${JSON.stringify(disp).slice(0, 300)}`);
}
await mm('POST', `/teams/${team.id}/members`, { team_id: team.id, user_id: disp.id });
console.log(`  dispatcher: @${disp.username} (${PEOPLE.dispatcher.first} ${PEOPLE.dispatcher.last})`);
state.people = { owner: owner.username, dispatcher: disp.username };
save();

step('Create the rooms');
for (const room of ROOMS) {
  if (state.rooms[room.key]) { console.log(`  ${room.name}: already created`); continue; }
  const users = room.people.map((p) => state.people[p]);
  const linked = (room.links || []).filter((l) => state.rooms[l.to]).map((l) => ({ target_room_id: state.rooms[l.to].id, label: l.label }));
  const r = await agentOp(room.creator, 'create_room', {
    name: room.name, description: room.description, agent_names: room.agents, user_names: users,
    channel_type: 'channel_public', instructions: room.instructions, roles: room.roles,
    linked_rooms: linked.length ? linked : undefined, write_visibility: 'private',
  });
  state.rooms[room.key] = { id: r.room_id ?? r.id, name: room.name, raw: Object.keys(r) };
  save();
  console.log(`  ${room.name}: ${state.rooms[room.key].id}`);
}
// Link back from the incidents room to the desk now both exist.
for (const room of ROOMS) {
  for (const l of room.backlinks || []) {
    try {
      await agentOp(room.creator, 'link_rooms', { source_room_id: state.rooms[room.key].id, target_room_id: state.rooms[l.to].id, label: l.label });
      console.log(`  linked ${room.name} → ${l.to} (${l.label})`);
    } catch (e) { console.log(`  link ${room.name} → ${l.to}: ${e.message.slice(0, 120)}`); }
  }
}

step('Done');
console.log(`  Mattermost: ${MM}  (sign in as ${env.MATTERMOST_USER}; password in switch/.env)`);
console.log('  Start the agents: npm start');
