// Analyst: answers dispatch questions in the rebalancing desk. Before it answers, it reads the room's
// `data-status` document (kept by the watcher) and gates the answer: untrusted → refuse with reasons,
// caveated → answer and say why the numbers may be off, trusted → answer. Stations are cited as [n].
import { stripMentions, retry } from './lib/switch.mjs';
import { findPlace, distanceM, titleCase } from './lib/places.mjs';

const STATUS_MAX_AGE_S = 180;
const lower = (t) => t.charAt(0).toLowerCase() + t.slice(1); // a watcher that has gone quiet makes the data untrusted

export function parseIntent(text) {
  const t = text.toLowerCase();
  if (/\b(status|trust|health|can i trust|is the data)\b/.test(t)) return 'status';
  if (/\b(dock|docks|full|pick ?up|collect|remove bikes|too many)\b/.test(t)) return 'docks';
  if (/\b(bike|bikes|empty|drop|need|short|refill|restock|e-?bike)\b/.test(t)) return 'bikes';
  return 'other';
}

/** The gate. Pure: the status document's JSON in, a verdict out. */
export function gate(status, lastRunAt, nowS = Math.floor(Date.now() / 1000)) {
  if (!status) return { verdict: 'untrusted', reasons: ['the data-status document is missing, so I cannot check the data'] };
  const reasons = [];
  let verdict = 'trusted';
  const worse = (v) => { if (v === 'untrusted' || (v === 'caveated' && verdict === 'trusted')) verdict = v; };
  if (!lastRunAt || nowS - lastRunAt > STATUS_MAX_AGE_S) { worse('untrusted'); reasons.push(lastRunAt ? `the watcher has not checked the data for ${Math.round((nowS - lastRunAt) / 60)} min` : 'the watcher has not checked the data yet'); }
  for (const i of status.open || []) {
    const rule = i.rule || (status.rules || {})[i.kind];
    if (i.severity === 'untrusted') {
      if (rule?.action === 'serve_last_good' && i.status === 'applied') {
        const age = Math.round((nowS - (status.last_good_at || 0)) / 60);
        const max = rule.params?.max_age_min ?? 30;
        if (age <= max) { worse('caveated'); reasons.push(`${i.id}: ${lower(i.title)}; answering from data ${age} min old (signed off up to ${max} min)`); }
        else { worse('untrusted'); reasons.push(`${i.id}: last good data is ${age} min old, past the signed-off ${max} min`); }
      } else if (rule?.action === 'accept_partial' && i.status === 'applied') {
        worse('caveated'); reasons.push(`${i.id}: ${lower(i.title)}; missing stations are left out`);
      } else if (rule?.action === 'dedupe_latest' && i.status === 'applied') {
        worse('caveated'); reasons.push(`${i.id}: repeated reports are being de-duplicated`);
      } else { worse('untrusted'); reasons.push(`${i.id}: ${lower(i.title)} (${i.status})`); }
    } else {
      worse('caveated');
      reasons.push(`${i.id}: ${i.count} stations held (${lower(i.title)})${i.status === 'applied' ? ', fix signed off, verifying' : ', awaiting sign-off'}`);
    }
  }
  return { verdict, reasons };
}

export function pickStations(rows, ll, intent, { radiusM = 1200, n = 5 } = {}) {
  const near = rows.map((r) => ({ ...r, dist: distanceM(ll, [r.lat, r.lon]) })).filter((r) => r.dist <= radiusM && r.capacity >= 8 && r.bikes + r.docks >= r.capacity * 0.5); // a dock reporting neither bikes nor docks is broken, not empty
  const need = intent === 'docks'
    ? near.filter((r) => r.is_returning && r.docks <= Math.max(2, Math.floor(r.capacity * 0.1))).sort((a, b) => a.docks - b.docks || a.dist - b.dist)
    : near.filter((r) => r.is_renting && r.bikes <= Math.max(2, Math.floor(r.capacity * 0.1))).sort((a, b) => a.bikes - b.bikes || a.dist - b.dist);
  return need.slice(0, n);
}

export function startAnalyst(agent, ctx) {
  const { wh, rooms } = ctx;

  async function readStatus() {
    const room = await agent.useRoom(rooms.desk);
    let doc = (room.documents || []).find((d) => d.name === 'data-status');
    if (!doc) { agent.activeRoom = null; doc = ((await agent.useRoom(rooms.desk)).documents || []).find((d) => d.name === 'data-status'); }
    if (!doc) return null;
    const [loaded] = await agent.inRoom(rooms.desk, () => agent.op('load_internal_documents', { ids: [doc.id] }));
    const m = String(loaded?.content || '').match(/```json\n([\s\S]*?)\n```/);
    return m ? JSON.parse(m[1]) : null;
  }

  async function answer(m) {
    const t0 = Date.now();
    const q = stripMentions(m.body);
    const intent = parseIntent(q), place = findPlace(q);
    const status = await readStatus();
    const g = gate(status, wh.lastRuns(1)[0]?.at);
    const thread = m.thread_id || m.message_id;
    const log = (stations) => wh.logAnswer({ asker: m.sender_name, question: q, verdict: g.verdict, stations, latency_ms: Date.now() - t0 });

    if (intent === 'status' || intent === 'other') {
      const lines = [`**Dispatch data: ${g.verdict}**`, ...(g.reasons.length ? g.reasons.map((r) => `- ${r}`) : ['- no open incidents; the contract passed on the last run'])];
      if (intent === 'other') lines.push('Ask me where to **drop bikes** or **pick up bikes** near a place, e.g. "which stations near Union Square need bikes?"');
      await agent.post(m.room_id, lines.join('\n'), thread); log([]); return;
    }
    if (g.verdict === 'untrusted') {
      await agent.post(m.room_id, [`🛑 **I won't send a truck on this data.** It can't be trusted right now:`, ...g.reasons.map((r) => `- ${r}`), 'Follow it in ~data-incidents. I will answer again once the data owner signs off a fix or the feed recovers.'].join('\n'), thread);
      log([]); return;
    }
    if (!place) { await agent.post(m.room_id, 'Which area? For example: Union Square, Bryant Park, Williamsburg, Hoboken.', thread); return; }

    const { rows, excluded } = wh.dispatchView();
    const picks = pickStations(rows, place.ll, intent);
    const heldNear = wh.db.prepare('select station_id, lat, lon from stations').all()
      .filter((s) => excluded.has(s.station_id) && distanceM(place.ll, [s.lat, s.lon]) <= 1200).length;
    const ageS = Math.round(Date.now() / 1000 - (status?.last_good_at || 0));
    const facts = {
      area: titleCase(place.name), need: intent === 'docks' ? 'stations that are full: pick up bikes' : 'stations short of bikes: drop bikes',
      verdict: g.verdict, caveats: g.reasons, data_age_s: ageS, held_nearby: heldNear,
      stations: picks.map((p, i) => ({ n: i + 1, name: p.name, bikes: p.bikes, ebikes: p.ebikes, docks: p.docks, capacity: p.capacity, distance_m: Math.round(p.dist), clamped: !!p.clamped })),
    };
    const list = facts.stations.map((s) => `[${s.n}] **${s.name}** · ${s.bikes}/${s.capacity} bikes${s.ebikes ? ` (${s.ebikes} e)` : ''}, ${s.docks} docks free · ${s.distance_m} m${s.clamped ? ' · counts clamped' : ''}`);
    const text = [
      `${g.verdict === 'caveated' ? '🟠' : '🟢'} **${intent === 'docks' ? 'Pick up bikes' : 'Drop bikes'} near ${facts.area}** · ${g.verdict} · data ${ageS < 90 ? `${ageS} s` : `${Math.round(ageS / 60)} min`} old`,
      ...(g.verdict === 'caveated' ? g.reasons.map((r) => `- caveat: ${r}`) : []),
      ...(list.length ? list : [`No station within 1.2 km is ${intent === 'docks' ? 'full' : 'short of bikes'} right now.`]),
      heldNear ? `${heldNear} station${heldNear > 1 ? 's' : ''} near here ${heldNear > 1 ? 'are' : 'is'} held out of this answer by the data contract.` : null,
    ].filter(Boolean).join('\n');
    await agent.post(m.room_id, text, thread);
    log(facts.stations.map((s) => s.name));
    agent.log(`answered "${q.slice(0, 50)}" → ${g.verdict}, ${picks.length} stations, ${Date.now() - t0} ms`);
  }

  agent.on('message', async (m) => {
    if (!m.addressed || m.room_id !== rooms.desk) return;
    try { await answer(m); } catch (e) { agent.log('answer failed:', e.message); }
  });

  agent.once('ready', () => retry(agent, async () => {
      agent.setHome(rooms.desk, 'dispatch-analyst');
      await agent.takeHome();
  }));
}
