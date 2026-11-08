// Fixer: proposes a remediation for each incident with a preview of exactly what changes, then waits.
// It acts only on "approve <id>" / "reject <id>" — and Switch only lets the data owner address it
// (addressing: owner_and_owner_agents), so the sign-off gate is enforced by Switch, not by this code.
import { OPTIONS, optionFor, preview } from './lib/remediation.mjs';
import { stripMentions, retry } from './lib/switch.mjs';

const ID = /\bINC-\d{3}\b/i;

export function startFixer(agent, ctx) {
  const { wh, rooms } = ctx;

  function proposalText(inc, opt) {
    const others = (OPTIONS[inc.kind] || []).filter((o) => o.key !== opt.key);
    return [
      `**Proposed fix for ${inc.id}** · option ${opt.key}: ${opt.summary}`,
      `Why: ${opt.why}`,
      `What changes if approved:`,
      ...preview(wh, inc, opt).map((l) => `- ${l}`),
      ...others.map((o) => `Alternative ${o.key}: ${o.summary}.`),
      `Sign-off needed. Reply \`@fixer approve ${inc.id}\`${others.length ? ` (or \`@fixer approve ${inc.id} ${others[0].key}\`)` : ''}, or \`@fixer reject ${inc.id}\`.`,
    ].join('\n');
  }

  async function propose(inc, key = 'A') {
    const opt = optionFor(inc.kind, key);
    if (!opt) { await agent.post(rooms.incidents, `I have no standing remediation for \`${inc.kind}\`. A person needs to look at ${inc.id}.`, inc.thread_id); return; }
    wh.updateIncident(inc.id, { status: 'proposed', proposal: { option: opt.key, action: opt.action, params: opt.params || {} } });
    wh.audit('fixer', 'proposed', inc.id, `option ${opt.key}: ${opt.action}`);
    await agent.tell(rooms.incidents, { names: [ctx.ownerName] }, proposalText(inc, opt), inc.thread_id);
    agent.log(`proposed ${opt.action} for ${inc.id}`);
  }

  async function approve(inc, key, who, threadId) {
    if (!['open', 'proposed', 'rejected'].includes(inc.status)) {
      await agent.post(rooms.incidents, `${inc.id} is already ${inc.status}; nothing to approve.`, threadId); return;
    }
    const opt = optionFor(inc.kind, key || inc.proposal?.option || 'A');
    if (!opt) { await agent.post(rooms.incidents, `${inc.id} has no option ${key}.`, threadId); return; }
    wh.tx(() => {
      wh.setRule({ kind: inc.kind, action: opt.action, params: opt.params, incident_id: inc.id, approved_by: who });
      wh.db.prepare("update incidents set status='applied', decided_by=?, decided_at=?, proposal=?, updated_at=? where id=?")
        .run(who, Math.floor(Date.now() / 1000), JSON.stringify({ option: opt.key, action: opt.action, params: opt.params || {} }), Math.floor(Date.now() / 1000), inc.id);
      wh.audit(who, 'approved', inc.id, `option ${opt.key}: ${opt.action}`);
      wh.audit('fixer', 'applied', inc.id, `standing rule ${inc.kind} → ${opt.action}`);
    });
    const body = `🟢 **Applied option ${opt.key} for ${inc.id}**, signed off by ${who}: ${opt.summary.toLowerCase()}. Standing rule \`${inc.kind} → ${opt.action}\` is live from the next run. Please verify.`;
    try { await agent.tell(rooms.incidents, { roles: ['monitor'] }, body, inc.thread_id); }
    catch { await agent.tell(rooms.incidents, { names: ['watcher'] }, body, inc.thread_id); }
    agent.log(`applied ${opt.action} for ${inc.id}, approved by ${who}`);
  }

  async function reject(inc, who, threadId) {
    wh.updateIncident(inc.id, { status: 'rejected', decided_by: who, decided_at: Math.floor(Date.now() / 1000) });
    wh.audit(who, 'rejected', inc.id, `option ${inc.proposal?.option || 'A'}`);
    const next = (OPTIONS[inc.kind] || []).find((o) => o.key !== (inc.proposal?.option || 'A'));
    if (next) { await agent.post(rooms.incidents, `Noted, ${who} rejected option ${inc.proposal?.option || 'A'}. The stations stay held. Here is the alternative:`, threadId); await propose(wh.incident(inc.id), next.key); }
    else await agent.post(rooms.incidents, `Noted, ${who} rejected it. ${inc.id} stays open and the stations stay held until a person decides.`, threadId);
  }

  agent.on('message', async (m) => {
    if (!m.addressed) return;
    try {
      const text = stripMentions(m.body);
      const id = (text.match(ID) || m.body.match(ID) || [])[0];
      const inc = id ? wh.incident(id) : null;
      const verb = text.match(/^(approve|approved|lgtm|ship it|reject|rejected|propose|retry)\b/i)?.[1]?.toLowerCase();
      // A hand-off from the watcher: "INC-00x … please propose a remediation".
      if (inc && /propose a remediation/i.test(m.body) && !verb) { await propose(inc); return; }
      if (!inc) {
        const pending = wh.openIncidents().filter((i) => i.status === 'proposed');
        await agent.post(m.room_id, pending.length ? `Waiting for sign-off on: ${pending.map((i) => i.id).join(', ')}. Reply \`@fixer approve <id>\` or \`@fixer reject <id>\`.` : 'No remediation is waiting for sign-off.', m.thread_id || m.message_id);
        return;
      }
      const who = ctx.displayName ? ctx.displayName(m.sender_name || m.sender) : (m.sender_name || m.sender);
      if (verb === 'reject' || verb === 'rejected') await reject(inc, who, m.thread_id || inc.thread_id);
      else if (verb === 'propose' || verb === 'retry') await propose(inc, text.match(/\b([AB])\b/)?.[1] || 'A');
      else if (verb) await approve(inc, text.match(new RegExp(`${inc.id}\\s+([AB])\\b`, 'i'))?.[1], who, m.thread_id || inc.thread_id);
      else await agent.post(m.room_id, `${inc.id} is ${inc.status}. Reply \`@fixer approve ${inc.id}\` or \`@fixer reject ${inc.id}\`.`, m.thread_id || inc.thread_id);
    } catch (e) { agent.log('message failed:', e.message); }
  });

  agent.once('ready', () => retry(agent, async () => {
      agent.setHome(rooms.incidents, 'remediator');
      await agent.takeHome();
  }));
}
