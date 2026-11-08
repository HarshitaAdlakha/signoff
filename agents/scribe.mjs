// Scribe: keeps the `incident-log` room document current and writes one `postmortem-INC-00x`
// room document when the watcher reports an incident closed. Documents live in the Switch room,
// so the next agent or person to join gets the history without anyone re-telling it.
import { stripMentions, retry } from './lib/switch.mjs';

const ID = /\bINC-\d{3}\b/i;
const ts = (t) => (t ? new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—');

export function startScribe(agent, ctx) {
  const { wh, rooms } = ctx;
  let logDocId = null;
  const written = new Set();
  let lastLog = '';

  function logContent() {
    const rows = wh.recentIncidents(50);
    return [
      '# Incident log: dispatch warehouse',
      `Kept by the scribe. Updated ${ts(Math.floor(Date.now() / 1000))}.`, '',
      '| Incident | Kind | Count | Status | Opened | Signed off by | Closed |', '|---|---|---|---|---|---|---|',
      ...rows.map((i) => `| ${i.id} | ${i.kind} | ${i.count} | ${i.status} | ${ts(i.opened_at)} | ${i.decided_by || '—'} | ${ts(i.closed_at)} |`),
      '', '## Standing rules',
      ...Object.values(wh.rules()).map((r) => `- \`${r.kind} → ${r.action}\` from ${r.incident_id}, signed off by ${r.approved_by} at ${ts(r.approved_at)}`),
    ].join('\n');
  }

  async function refreshLog() {
    await agent.useRoom(rooms.incidents);
    const content = logContent();
    const sig = content.replace(/Updated .*UTC\./, '');
    if (sig === lastLog && logDocId) return;
    lastLog = sig;
    if (!logDocId) {
      const doc = (agent.roomContext.documents || []).find((d) => d.name === 'incident-log');
      if (doc) logDocId = doc.id;
      else logDocId = (await agent.op('create_room_document', { name: 'incident-log', description: 'Every data incident, its sign-off and its outcome', instructions: 'Check here for past incidents and standing rules before proposing a new remediation.', content })).document_id;
    }
    try { await agent.inRoom(rooms.incidents, () => agent.op('update_room_document', { document_id: logDocId, content })); }
    catch (e) { lastLog = ''; throw e; }
  }

  async function postmortem(inc) {
    if (written.has(inc.id)) return;
    const audit = wh.auditFor(inc.id);
    const mins = inc.closed_at ? Math.max(1, Math.round((inc.closed_at - inc.opened_at) / 60)) : null;
    const ev = inc.evidence || {};
    const content = [
      `# Postmortem ${inc.id}: ${inc.title}`, '',
      `**Kind:** \`${inc.kind}\` · **Severity:** ${inc.severity} · **Count:** ${inc.count} · **Open for:** ${mins ?? '?'} min`,
      `**Signed off by:** ${inc.decided_by || '—'} · **Remediation:** ${inc.proposal ? `option ${inc.proposal.option}, \`${inc.proposal.action}\`` : '—'}`,
      ev.injected ? `**Note:** this incident was a simulated fault (\`${ev.injected}\`) on top of the live feed, for a demo.` : '**Source:** the live Citi Bike GBFS feed; nothing was simulated.', '',
      '## What happened', `${inc.title}. The watcher caught it on run #${ev.run} (${ev.rows_in} records, ${ev.accepted} accepted).`,
      ...(ev.examples || []).slice(0, 3).map((e) => `- ${e.station_id ? `\`${e.station_id}\`: ` : ''}${e.detail}`), '',
      '## Timeline', ...audit.map((a) => `- ${ts(a.at)} · **${a.actor}** · ${a.action.replace(/_/g, ' ')} · ${a.detail}`), '',
      '## Resolution', inc.resolution || '—', '',
      '## Follow-ups',
      inc.kind === 'bogus_timestamp' || inc.kind === 'over_capacity' || inc.kind === 'silent_station'
        ? '- Report the affected stations to the feed operator (Lyft / Citi Bike) with the list in the evidence.'
        : '- Ask the feed operator for the cause and an ETA; review whether the standing rule should stay.',
      '- Review the standing rule at the next weekly data review.',
    ].join('\n');
    await agent.useRoom(rooms.incidents);
    const name = `postmortem-${inc.id}`;
    const existing = (agent.roomContext.documents || []).find((d) => d.name === name);
    if (!existing) await agent.inRoom(rooms.incidents, () => agent.op('create_room_document', { name, description: `What happened in ${inc.id} and how it was fixed`, instructions: 'Read before proposing a remediation for the same kind of incident.', content }));
    written.add(inc.id);
    agent.activeRoom = null; // refresh the room's document list next time
    await agent.post(rooms.incidents, `📝 Postmortem written: room document \`${name}\` (timeline of ${audit.length} events, signed off by ${inc.decided_by || 'nobody, it recovered on its own'}).`, inc.thread_id);
    agent.log(`postmortem ${inc.id}`);
  }

  agent.on('message', async (m) => {
    if (!m.addressed) return;
    try {
      const id = (m.body.match(ID) || [])[0];
      const inc = id ? wh.incident(id) : null;
      if (inc && inc.status === 'closed') { await postmortem(inc); await refreshLog(); return; }
      const text = stripMentions(m.body).toLowerCase();
      if (/log|summary|history|incidents/.test(text) || !inc) {
        const rows = wh.recentIncidents(8);
        await agent.post(m.room_id, rows.length ? ['**Recent incidents**', ...rows.map((i) => `- ${i.id} · ${i.status} · ${i.title} (${i.count})${i.decided_by ? ` · signed off by ${i.decided_by}` : ''}`), 'Full log: room document `incident-log`.'].join('\n') : 'No incidents yet.', m.thread_id || m.message_id);
      }
    } catch (e) { agent.log('message failed:', e.message); }
  });

  agent.once('ready', () => retry(agent, async () => {
      agent.setHome(rooms.incidents, 'recorder');
      await agent.takeHome();
      await refreshLog();
      setInterval(() => refreshLog().catch((e) => agent.log('log refresh failed:', e.message)), 120_000);
  }));
}
