// Start the Signoff agents. Each is its own Switch agent with its own key and WebSocket connection;
// they share nothing in-process except the warehouse file. Everything they say to each other goes
// through the Switch rooms.
//   node agents/run.mjs                 all four
//   node agents/run.mjs watcher fixer   just those
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SwitchAgent } from './lib/switch.mjs';
import { openWarehouse } from './lib/warehouse.mjs';
import { loadEnv } from './lib/env.mjs';
import { startWatcher } from './watcher.mjs';
import { startFixer } from './fixer.mjs';
import { startAnalyst } from './analyst.mjs';
import { startScribe } from './scribe.mjs';
import { PEOPLE } from './lib/config.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = { ...loadEnv(`${root}switch/.env`), ...process.env };
const BASE = env.SWITCH_URL || `http://localhost:${env.API_HOST_PORT || 8000}`;
if (!existsSync(`${root}var/state.json`)) { console.error('Run `npm run bootstrap` first.'); process.exit(1); }
const state = JSON.parse(readFileSync(`${root}var/state.json`, 'utf8'));
const wh = openWarehouse(env.SIGNOFF_DB || `${root}var/warehouse.db`);
const rooms = { incidents: state.rooms.incidents.id, desk: state.rooms.desk.id };

const START = { watcher: startWatcher, fixer: startFixer, analyst: startAnalyst, scribe: startScribe };
const which = process.argv.slice(2).filter((a) => START[a]);
const names = which.length ? which : Object.keys(START);

const agents = {};
for (const name of names) {
  const a = state.agents[name];
  agents[name] = new SwitchAgent({ base: BASE, agentId: a.id, apiKey: a.api_key, name, rooms: [], connectionId: a.connection_id });
}

// The data owner, as Switch names them in the room (the fixer addresses its sign-off requests to them).
async function ownerName() {
  const any = agents.fixer || Object.values(agents)[0];
  try {
    await any.useRoom(rooms.incidents);
    const parts = await any.op('list_participants', {});
    const list = Array.isArray(parts) ? parts : parts.participants || [];
    const owner = list.find((p) => p.kind === 'user' || p.type === 'user' || /user/.test(p.id || ''))
      && list.find((p) => [p.name, p.username, p.display_name].includes(state.people.owner));
    return owner?.name || state.people.owner;
  } catch { return state.people.owner; }
}

const ctx = { wh, rooms, injectFile: `${root}var/inject.json`, intervalMs: Number(env.SIGNOFF_INTERVAL_S || 60) * 1000, ownerName: state.people.owner };
ctx.ownerName = await ownerName();
// Mattermost usernames → the names people go by, for sign-off records.
const NAMES = { [state.people.owner]: `${PEOPLE.owner.first} ${PEOPLE.owner.last}`, [state.people.dispatcher]: `${PEOPLE.dispatcher.first} ${PEOPLE.dispatcher.last}` };
ctx.displayName = (u) => NAMES[u] || u;
console.log(`Signoff on ${BASE} · rooms: data-incidents, rebalancing-desk · data owner: @${ctx.ownerName}`);
for (const name of names) { START[name](agents[name], ctx); agents[name].start(); }

process.on('SIGINT', () => { for (const a of Object.values(agents)) a.stop(); process.exit(0); });
