// Exports the real recorded session from Mattermost into docs/app/replay.json for the public replay.
// Every message is exactly as it was posted, with its time, author, channel and thread.
//   node export-replay.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { login, api, channels } from './mm.mjs';

const NAMES = { user: 'Paras Adlakha', harshita: 'Harshita Adlakha', watcher: 'Watcher', fixer: 'Fixer', analyst: 'Analyst', scribe: 'Scribe' };
const { token } = await login('user');
const { mine } = await channels(token);
const users = {};
const out = [];
for (const name of ['data-incidents', 'rebalancing-desk']) {
  const ch = mine.find((c) => c.display_name === name);
  let page = 0;
  for (;;) {
    const r = await api(token, 'GET', `/channels/${ch.id}/posts?per_page=200&page=${page}`);
    const ids = r.order || [];
    for (const id of ids) {
      const p = r.posts[id];
      if (p.type && p.type !== '') continue; // joins and system notices
      users[p.user_id] ??= (await api(token, 'GET', `/users/${p.user_id}`)).username;
      const u = users[p.user_id];
      if (!NAMES[u]) continue;
      out.push({ id: p.id, root: p.root_id || null, channel: name, at: p.create_at, who: NAMES[u], kind: ['user', 'harshita'].includes(u) ? 'person' : 'agent', text: p.message });
    }
    if (ids.length < 200) break;
    page++;
  }
}
out.sort((a, b) => a.at - b.at);
// Drop the room-document notices: they are system posts in the channel, not something anyone said.
const msgs = out.filter((m) => !/(created|updated) room document “|assumed the .* role|^Hey there!|^Hello!|^Hi!/.test(m.text));
const t0 = msgs[0].at;
mkdirSync('../../docs/app', { recursive: true });
writeFileSync('../../docs/app/replay.json', JSON.stringify({
  recorded: new Date(t0).toISOString(),
  source: 'Mattermost export of the recorded Signoff session: local Switch 0.31.0, live Citi Bike GBFS feed, 7-8 Nov 2026',
  note: 'The frozen-feed incidents (INC-004, INC-005) were simulated with `npm run inject -- stale`; everything else is the live feed.',
  messages: msgs.map((m) => ({ ...m, t: Math.round((m.at - t0) / 1000) })),
}, null, 1));
console.log(`exported ${msgs.length} messages (${msgs.filter((m) => m.channel === 'data-incidents').length} in #data-incidents)`);
