// Watcher: runs the contract on the live feed every minute, opens one Switch thread per incident,
// hands it to whoever holds the remediator role, verifies fixes, closes incidents, and keeps the
// rebalancing desk's `data-status` room document current (that document is what the analyst gates on).
import { ingestOnce, refreshStations } from './lib/pipeline.mjs';
import { trustVerdict, KINDS } from './lib/contract.mjs';
import { stripMentions, retry } from './lib/switch.mjs';

const fmt = (n) => Number(n).toLocaleString('en-US');
const ago = (t) => { const s = Math.round(Date.now() / 1000 - t); return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`; };

export function startWatcher(agent, ctx) {
  const { wh, rooms, injectFile } = ctx;
  let statusDocId = null;
  let busy = false;
  let lastStationsRefresh = 0;
  let lastSignature = '';

  async function ensureStatusDoc() {
    const room = await agent.useRoom(rooms.desk);
    const doc = (room.documents || []).find((d) => d.name === 'data-status');
    if (doc) { statusDocId = doc.id; return; }
    const r = await agent.op('create_room_document', {
      name: 'data-status', description: 'Live trust state of the dispatch data, kept by the watcher every minute',
      instructions: 'Read this before answering any dispatch question. The JSON block is authoritative: verdict, open incidents, held stations, and standing rules.',
      content: 'warming up',
    });
    statusDocId = r.document_id;
  }

  function stationNames(ids, n = 3) {
    if (!ids.length) return [];
    const rows = wh.db.prepare(`select station_id, name from stations where station_id in (${ids.slice(0, 50).map(() => '?').join(',')})`).all(...ids.slice(0, 50));
    const m = new Map(rows.map((r) => [r.station_id, r.name]));
    return ids.slice(0, n).map((id) => m.get(id) || id);
  }

  async function writeStatus(run) {
    const open = wh.openIncidents();
    const rules = wh.rules();
    const v = trustVerdict(open);
    const state = {
      verdict: v.verdict, updated_at: Math.floor(Date.now() / 1000),
      last_run: { id: run.id, rows_in: run.rows_in, accepted: run.accepted, rejected: run.rejected, status: run.status, injected: run.injected },
      last_good_at: wh.lastGoodAt(),
      open: open.map((i) => ({ id: i.id, kind: i.kind, title: i.title, severity: i.severity, status: i.status, count: i.count,
        rule: rules[i.kind] ? { action: rules[i.kind].action, params: rules[i.kind].params } : null, stations: (i.evidence.stations || []).slice(0, 400) })),
      rules: Object.fromEntries(Object.entries(rules).map(([k, r]) => [k, { action: r.action, incident: r.incident_id, approved_by: r.approved_by }])),
      held_stations: wh.activeQuarantine().length,
    };
    // Only write when the trust state changes: every write shows up in the room as a notice.
    const signature = JSON.stringify([v.verdict, state.open.map((i) => [i.id, i.status]), state.rules]); // counts drift by one or two every run; not worth a notice
    if (signature === lastSignature) return;
    lastSignature = signature;
    const human = [
      `Dispatch data: **${v.verdict}** · run #${run.id} at ${new Date().toISOString().slice(11, 19)} UTC · ${fmt(run.accepted)} stations accepted, ${state.held_stations} held`,
      ...(open.length ? open.map((i) => `- ${i.id} (${i.status}): ${i.title} — ${i.count}`) : ['- no open incidents']),
    ].join('\n');
    const content = `${human}\n\n\`\`\`json\n${JSON.stringify(state)}\n\`\`\``;
    try { await agent.inRoom(rooms.desk, () => agent.op('update_room_document', { document_id: statusDocId, content })); }
    catch (e) { lastSignature = ''; throw e; }
  }

  async function openIncident(d, run) {
    const inc = wh.createIncident({
      kind: d.kind, title: d.title, severity: d.severity, count: d.count,
      evidence: { run: run.id, stations: d.stations, examples: d.examples, rows_in: run.rows_in, accepted: run.accepted,
        injected: run.injected, expected: d.examples[0]?.expected, count: d.examples[0]?.count },
    });
    await announce(inc, d, run);
  }

  // Post the incident thread and the desk heads-up. Retried on the next run if Switch was unreachable.
  async function announce(inc, d, run) {
    const names = stationNames(d.stations);
    const ex = d.feed ? d.examples[0]?.detail : d.examples.map((e, k) => `${names[k] || e.station_id}: ${e.detail}`).join('\n> ');
    const body = [
      `**${d.severity === 'untrusted' ? '🔴' : '🟠'} ${inc.id} · ${d.title}**`,
      `${d.feed ? 'Whole feed' : `${fmt(d.count)} stations`} · severity **${d.severity}** · ${d.feed ? 'the analyst refuses dispatch answers until this is handled' : 'held out of dispatch until a fix is signed off'}`,
      `> ${ex}`,
      `Evidence: run #${run.id}, ${fmt(run.rows_in)} records from the live Citi Bike feed, ${fmt(run.accepted)} accepted${run.injected ? ` · ⚗️ simulated fault: \`${run.injected}\`` : ''}`,
      'Please propose a remediation in this thread.',
    ].join('\n');
    const sent = await sendToRole(rooms.incidents, 'remediator', 'fixer', body);
    wh.updateIncident(inc.id, { thread_id: sent.event_id });
    await agent.post(rooms.desk, `⚠️ **${inc.id} opened** in ~data-incidents: ${d.title.charAt(0).toLowerCase() + d.title.slice(1)} (${d.feed ? 'whole feed' : `${fmt(d.count)} stations`}). ${d.severity === 'untrusted' ? 'Dispatch answers are paused until it is handled.' : 'Answers near those stations carry a caveat until the data owner signs off a fix.'}`);
    agent.log(`opened ${inc.id} ${d.kind} ×${d.count}`);
  }

  async function sendToRole(room, role, fallbackName, body, threadId) {
    try { return await agent.tell(room, { roles: [role] }, body, threadId); }
    catch (e) { agent.log(`role @${role} unavailable (${e.message.slice(0, 80)}), addressing @${fallbackName}`); return agent.tell(room, { names: [fallbackName] }, body, threadId); }
  }

  async function closeIncident(inc, run, how) {
    // Announce first, then commit: if Switch is unreachable, the next run tries the whole close again.
    const mins = Math.max(1, Math.round((Date.now() / 1000 - inc.opened_at) / 60));
    if (!inc.evidence?.close_announced) {
      await agent.post(rooms.desk, `✅ **${inc.id} closed**: ${inc.title.charAt(0).toLowerCase() + inc.title.slice(1)}. ${how}`);
      wh.updateIncident(inc.id, { evidence: { ...inc.evidence, close_announced: true } });
    }
    wh.updateIncident(inc.id, { status: 'closed', closed_at: Math.floor(Date.now() / 1000), resolution: how });
    wh.audit('watcher', 'verified_and_closed', inc.id, how);
    await sendToRole(rooms.incidents, 'recorder', 'scribe', `✅ **${inc.id} closed** after ${mins} min. ${how} Please write the postmortem.`, inc.thread_id)
      .catch((e) => agent.log(`postmortem hand-off for ${inc.id} failed: ${e.message.slice(0, 100)}`));
    agent.log(`closed ${inc.id}: ${how}`);
  }

  async function cycle() {
    if (busy) return; busy = true;
    try {
      if (Date.now() - lastStationsRefresh > 3600_000) { await refreshStations(wh); lastStationsRefresh = Date.now(); }
      const { run, defects, handled } = await ingestOnce(wh, { injectFile });
      const kinds = new Set(defects.map((d) => d.kind));
      for (const d of defects) {
        const open = wh.openIncidentFor(d.kind);
        if (!open) await openIncident(d, run);
        else if (!open.thread_id) await announce(open, d, run);
        else wh.updateIncident(open.id, { count: d.count, evidence: { ...open.evidence, stations: d.stations, last_run: run.id } });
      }
      const handledMap = Object.fromEntries(handled);
      for (const inc of wh.openIncidents()) {
        if (kinds.has(inc.kind)) continue;
        const rule = wh.rules()[inc.kind];
        if (KINDS[inc.kind]?.scope === 'feed') {
          await closeIncident(inc, run, `The feed recovered on run #${run.id}: ${fmt(run.accepted)} stations accepted, contract passing${rule ? `; standing rule \`${rule.action}\` stays in place` : ''}.`);
        } else if (inc.status === 'applied' && rule) {
          await closeIncident(inc, run, `Verified on run #${run.id}: ${fmt(handledMap[inc.kind] || 0)} stations handled by the signed-off rule \`${rule.action}\`, 0 unhandled.`);
        } else if (!rule) {
          await closeIncident(inc, run, `The stations stopped failing on their own by run #${run.id}.`);
        }
      }
      await writeStatus(run);
      agent.log(`run #${run.id}: ${run.rows_in} in, ${run.accepted} accepted, ${run.rejected} rejected, ${run.handled} by rule${run.injected ? `, injected ${run.injected}` : ''}`);
    } catch (e) { agent.log('cycle failed:', e.message); }
    finally { busy = false; }
  }

  agent.on('message', async (m) => {
    if (!m.addressed) return;
    const text = stripMentions(m.body).toLowerCase();
    const runs = wh.lastRuns(15);
    const last = runs[0];
    const open = wh.openIncidents();
    const reply = [
      `**Data status: ${trustVerdict(open).verdict}** · last run #${last?.id} ${last ? ago(last.at) : '?'} ago · ${fmt(last?.accepted || 0)} stations accepted, ${wh.activeQuarantine().length} held`,
      `Last 15 runs: ${runs.filter((r) => r.status === 'ok').length} ok, ${runs.filter((r) => r.status !== 'ok').length} partial/failed`,
      ...(open.length ? open.map((i) => `- ${i.id} · ${i.status} · ${i.title} (${i.count})`) : ['- no open incidents']),
    ].join('\n');
    if (/status|health|trust|incident|what|how/.test(text) || !text) await agent.post(m.room_id, reply, m.thread_id || m.message_id);
  });

  agent.once('ready', () => retry(agent, async () => {
      agent.setHome(rooms.incidents, 'monitor');
      await agent.takeHome();
      await ensureStatusDoc();
      await cycle();
      setInterval(cycle, ctx.intervalMs || 60_000);
  }));
}
