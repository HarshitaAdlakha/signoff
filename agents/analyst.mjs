// Analyst: answers dispatch questions in the rebalancing desk. Before it answers, it reads the room's
// `data-status` document (kept by the watcher) and gates the answer: untrusted → refuse with reasons,
// caveated → answer and say why the numbers may be off, trusted → answer. Stations are cited as [n].
import { stripMentions, retry } from './lib/switch.mjs';
import { findPlace, distanceM, titleCase } from './lib/places.mjs';

export { parseIntent, gate, pickStations } from './lib/dispatch.mjs';
import { gate, parseIntent, pickStations } from './lib/dispatch.mjs';

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
