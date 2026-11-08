// Signoff, live in the browser. Runs the agents' own contract, remediation options and trust gate
// (synced from agents/lib) against the live Citi Bike feed. The two rooms are rendered here; in the
// full system the same messages travel through Switch rooms in Mattermost.
import { validateStations, validateStatus, defectsByKind, KINDS } from './lib/contract.mjs';
import { OPTIONS, optionFor } from './lib/remediation.mjs';
import { gate, parseIntent, pickStations } from './lib/dispatch.mjs';
import { findPlace, distanceM, titleCase, PLACES } from './lib/places.mjs';

const FEED = 'https://gbfs.citibikenyc.com/gbfs/en';
const RUN_EVERY_MS = 60_000;
const $ = (id) => document.getElementById(id);
const now = () => Math.floor(Date.now() / 1000);
const fmt = (n) => Number(n).toLocaleString('en-US');
const lower = (t) => t.charAt(0).toLowerCase() + t.slice(1);

const S = {
  stations: new Map(), caps: {}, status: new Map(), rules: {}, incidents: [], excluded: new Set(),
  lastRunAt: 0, lastGoodAt: 0, run: 0, frozen: null, lastFeed: null, role: 'paras', busy: false,
};

// ── rendering ─────────────────────────────────────────────────────────────────
const PEOPLE = {
  Watcher: ['W', '#ff9ec7', 'agent · @monitor'], Fixer: ['F', '#8fb0ff', 'agent · @remediator'],
  Analyst: ['A', '#7ee0c3', 'agent · @dispatch-analyst'], Scribe: ['S', '#c7a8ff', 'agent · @recorder'],
  Switch: ['⇄', '#e3ff5c', 'switch · addressing policy'],
  'Paras Adlakha': ['PA', '#e3ff5c', 'data owner'], 'Harshita Adlakha': ['HA', '#ffb37a', 'dispatch lead'],
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function md(s) {
  let html = '', list = false;
  for (let l of esc(s).split('\n')) {
    l = l.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    if (/^- /.test(l)) { if (!list) { html += '<ul>'; list = true; } html += `<li>${l.slice(2)}</li>`; continue; }
    if (list) { html += '</ul>'; list = false; }
    html += /^&gt; /.test(l) ? `<div class="q">${l.slice(5)}</div>` : `${l}<br>`;
  }
  return (list ? html + '</ul>' : html).replace(/(<br>)+$/, '');
}
let seq = 0;
function post(room, who, text, { thread = null, actions = null } = {}) {
  const f = $(room === 'incidents' ? 'f-incidents' : 'f-desk');
  f.querySelector('.empty')?.remove();
  document.querySelectorAll('.msg.new').forEach((e) => e.classList.remove('new'));
  const id = `m${++seq}`;
  const [ini, col, tag] = PEOPLE[who];
  const d = document.createElement('div');
  d.className = `msg new${thread ? ' reply' : ''}`;
  d.id = id;
  d.innerHTML = `<div class="av" style="background:${col}">${ini}</div><div><span class="who">${esc(who)}</span><span class="tag">${tag}</span><span class="time">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><div class="txt">${md(text)}</div></div>`;
  if (actions) {
    const bar = document.createElement('div');
    bar.className = 'acts';
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = `pill ${a.primary ? 'lime' : 'ghost'}`;
      b.textContent = a.label;
      b.onclick = () => a.run(b);
      bar.append(b);
    }
    d.querySelector('.txt').after(bar);
  }
  if (thread) {
    const root = $(thread);
    let last = root;
    while (last.nextElementSibling?.dataset.parent === thread) last = last.nextElementSibling;
    d.dataset.parent = thread;
    last.after(d);
  } else f.append(d);
  d.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return id;
}

function trustState() {
  const open = S.incidents.filter((i) => i.status !== 'closed');
  return {
    updated_at: now(), last_good_at: S.lastGoodAt,
    open: open.map((i) => ({ id: i.id, kind: i.kind, title: i.title, severity: i.severity, status: i.status, count: i.count, rule: S.rules[i.kind] || null })),
    rules: S.rules,
  };
}
function renderTrust() {
  const g = gate(trustState(), S.lastRunAt);
  const c = { trusted: 'var(--trusted)', caveated: 'var(--caveated)', untrusted: 'var(--untrusted)' }[g.verdict];
  const open = S.incidents.filter((i) => i.status !== 'closed').map((i) => i.id);
  $('trust').innerHTML = `<span class="d" style="background:${c}"></span><span>${g.verdict}${open.length ? ' · ' + open.join(', ') : ''}</span>`;
  $('runinfo').textContent = S.run ? `run #${S.run} · ${fmt(S.status.size)} stations live · ${S.excluded.size} held · next run in ${Math.max(0, Math.round((S.lastRunAt * 1000 + RUN_EVERY_MS - Date.now()) / 1000))} s` : 'first run…';
}

// ── the watcher: one run of the contract on the live feed ─────────────────────
async function getJson(path) {
  const r = await fetch(`${FEED}/${path}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

async function runWatcher() {
  if (S.busy) return; S.busy = true;
  try {
    if (!S.stations.size) {
      const { rows } = validateStations((await getJson('station_information.json')).data.stations);
      for (const r of rows) { S.stations.set(r.station_id, r); S.caps[r.station_id] = r.capacity; }
    }
    let stations, lastUpdated, injected = null;
    if (S.frozen && S.lastFeed) { stations = S.lastFeed.stations; lastUpdated = S.frozen; injected = 'stale'; }
    else {
      const j = await getJson('station_status.json');
      stations = j.data.stations; lastUpdated = j.last_updated;
      S.lastFeed = { stations, lastUpdated };
    }
    const nowS = now();
    const res = validateStatus(stations, S.caps, nowS, { lastUpdated, expected: Math.max(S.stations.size - 60, 0) });
    S.run++; S.lastRunAt = nowS;
    const stale = res.feed.some((f) => f.reason === 'feed_stale');
    // standing rules
    const excluded = new Set();
    const handled = {};
    for (const r of res.rejects) {
      const rule = S.rules[r.reason];
      const raw = stations.find((s) => s.station_id === r.station_id);
      if (rule?.action === 'clamp' && r.reason === 'over_capacity') {
        const cap = S.caps[r.station_id], bikes = Math.min(raw.num_bikes_available, cap);
        res.rows.push({ station_id: r.station_id, bikes, ebikes: Math.min(raw.num_ebikes_available || 0, bikes), docks: Math.max(0, Math.min(raw.num_docks_available, cap - bikes)),
          is_installed: 1, is_renting: raw.is_renting ? 1 : 0, is_returning: raw.is_returning ? 1 : 0, last_reported: Number(raw.last_reported), clamped: true });
      } else if (rule?.action === 'trust_counts' && r.reason === 'bogus_timestamp') {
        res.rows.push({ station_id: r.station_id, bikes: raw.num_bikes_available, ebikes: Math.min(raw.num_ebikes_available || 0, raw.num_bikes_available), docks: raw.num_docks_available,
          is_installed: raw.is_installed ? 1 : 0, is_renting: raw.is_renting ? 1 : 0, is_returning: raw.is_returning ? 1 : 0, last_reported: nowS, clamped: true });
      } else excluded.add(r.station_id);
      if (rule) handled[r.reason] = (handled[r.reason] || 0) + 1;
    }
    if (!stale) { for (const r of res.rows) S.status.set(r.station_id, r); S.lastGoodAt = nowS; }
    S.excluded = excluded;

    const defects = defectsByKind(res).filter((d) => !(S.rules[d.kind] && !['feed_stale', 'volume_drop', 'feed_unreachable'].includes(d.kind)));
    const kinds = new Set(defects.map((d) => d.kind));
    for (const d of defects) {
      const open = S.incidents.find((i) => i.kind === d.kind && i.status !== 'closed');
      if (open) { open.count = d.count; open.stations = d.stations; continue; }
      openIncident({ ...d, ...KINDS[d.kind] }, { rows_in: stations.length, accepted: res.rows.length, injected });
    }
    for (const inc of S.incidents.filter((i) => i.status !== 'closed')) {
      if (kinds.has(inc.kind)) continue;
      const rule = S.rules[inc.kind];
      if (KINDS[inc.kind]?.scope === 'feed') closeIncident(inc, `The feed recovered on run #${S.run}: ${fmt(res.rows.length)} stations accepted, contract passing.`);
      else if (inc.status === 'applied' && rule) closeIncident(inc, `Verified on run #${S.run}: ${fmt(handled[inc.kind] || 0)} stations handled by the signed-off rule \`${rule.action}\`, 0 unhandled.`);
      else if (!rule) closeIncident(inc, `The stations stopped failing on their own by run #${S.run}.`);
    }
    $('err').textContent = '';
  } catch (e) {
    $('err').textContent = `Couldn't reach the Citi Bike feed (${e.message}). Retrying on the next run.`;
  } finally { S.busy = false; renderTrust(); }
}

function openIncident(d, run) {
  const id = `INC-${String(S.incidents.length + 1).padStart(3, '0')}`;
  const inc = { id, kind: d.kind, title: d.title, severity: d.severity, count: d.count, stations: d.stations, examples: d.examples, feed: !!d.feed, status: 'open', opened: Date.now(), events: [] };
  S.incidents.push(inc);
  const names = d.examples.map((e) => S.stations.get(e.station_id)?.name || e.station_id);
  const ex = d.feed ? d.examples[0]?.detail : d.examples.map((e, k) => `${names[k]}: ${e.detail}`).join('\n> ');
  inc.thread = post('incidents', 'Watcher', [
    `@remediator **${d.severity === 'untrusted' ? '🔴' : '🟠'} ${id} · ${d.title}**`,
    `${d.feed ? 'Whole feed' : `${fmt(d.count)} stations`} · severity **${d.severity}** · ${d.feed ? 'the analyst refuses dispatch answers until this is handled' : 'held out of dispatch until a fix is signed off'}`,
    `> ${ex}`,
    `Evidence: run #${S.run}, ${fmt(run.rows_in)} records from the live Citi Bike feed, ${fmt(run.accepted)} accepted${run.injected ? ' · ⚗️ simulated fault: `stale`' : ''}`,
  ].join('\n'));
  inc.events.push(`watcher opened it: ${d.count} × ${d.kind}`);
  post('desk', 'Watcher', `⚠️ **${id} opened** in #data-incidents: ${lower(d.title)} (${d.feed ? 'whole feed' : `${fmt(d.count)} stations`}).`);
  propose(inc, 'A');
}

function preview(inc, opt) {
  const st = inc.stations.map((id) => S.stations.get(id)).filter(Boolean);
  const mh = st.filter((s) => s.lat > 40.70 && s.lat < 40.80 && s.lon > -74.02 && s.lon < -73.93).length;
  switch (opt.action) {
    case 'exclude': return [`${inc.stations.length} stations stay out of the dispatch view (${mh} of them in Manhattan below 96 St).`, 'Re-admitted automatically the first minute they pass the contract again. Nothing is deleted.'];
    case 'trust_counts': return [`${inc.stations.length} stations are admitted with counts of unknown age.`];
    case 'clamp': return [`${inc.stations.length} stations are admitted with bikes and docks clamped to capacity, flagged in every answer.`];
    case 'serve_last_good': return [`The analyst answers from data last updated ${Math.round((now() - S.lastGoodAt) / 60)} min ago, says so in every answer, and refuses after ${opt.params.max_age_min} min.`];
    case 'pause': return ['The analyst refuses every dispatch question until the incident closes.'];
    case 'dedupe_latest': return ['Repeated station reports are dropped; the newest report per station is kept.'];
    case 'reject_feed': return ['Every feed that repeats a station is rejected.'];
    case 'accept_partial': return ['Stations missing from the feed are left out of answers.'];
    default: return [];
  }
}

function propose(inc, key) {
  const opt = optionFor(inc.kind, key);
  if (!opt) return;
  inc.status = 'proposed'; inc.option = opt.key;
  inc.events.push(`fixer proposed option ${opt.key}: ${opt.action}`);
  const others = (OPTIONS[inc.kind] || []).filter((o) => o.key !== opt.key);
  const actions = [{ label: `Approve ${opt.key}`, primary: true, run: (b) => approve(inc, opt.key, b) }];
  for (const o of others) actions.push({ label: `Approve ${o.key}`, run: (b) => approve(inc, o.key, b) });
  actions.push({ label: 'Reject', run: (b) => reject(inc, b) });
  post('incidents', 'Fixer', [
    `@Paras Adlakha **Proposed fix for ${inc.id}** · option ${opt.key}: ${opt.summary}`,
    `Why: ${opt.why}`, 'What changes if approved:', ...preview(inc, opt).map((l) => `- ${l}`),
    ...others.map((o) => `Alternative ${o.key}: ${o.summary}.`),
    `Sign-off needed: \`@fixer approve ${inc.id}\`${others.length ? ` or \`@fixer approve ${inc.id} ${others[0].key}\`` : ''}, or \`@fixer reject ${inc.id}\`.`,
  ].join('\n'), { thread: inc.thread, actions });
  renderTrust();
}

function who() { return S.role === 'paras' ? 'Paras Adlakha' : 'Harshita Adlakha'; }

function refuseIfNotOwner(inc, said) {
  if (S.role === 'paras') return false;
  post('incidents', 'Harshita Adlakha', said, { thread: inc.thread });
  post('incidents', 'Switch', "@harshita I only take instructions from my owner, so I can't act on that. (In the real rooms, Switch's addressing policy on the fixer refuses this before the agent ever sees it.)", { thread: inc.thread });
  return true;
}

async function approve(inc, key, btn) {
  if (inc.status === 'applied' || inc.status === 'closed') return;
  if (refuseIfNotOwner(inc, `@fixer approve ${inc.id}${key !== 'A' ? ' ' + key : ''}`)) return;
  const opt = optionFor(inc.kind, key);
  post('incidents', 'Paras Adlakha', `@fixer approve ${inc.id}${key !== 'A' ? ' ' + key : ''}`, { thread: inc.thread });
  S.rules[inc.kind] = { action: opt.action, params: opt.params || {}, incident: inc.id, approved_by: 'Paras Adlakha' };
  inc.status = 'applied'; inc.option = opt.key; inc.decided = 'Paras Adlakha';
  inc.events.push(`Paras Adlakha approved option ${opt.key}; standing rule ${inc.kind} → ${opt.action}`);
  btn?.closest('.acts')?.querySelectorAll('button').forEach((b) => (b.disabled = true));
  post('incidents', 'Fixer', `@monitor 🟢 **Applied option ${opt.key} for ${inc.id}**, signed off by Paras Adlakha: ${lower(opt.summary)}. Standing rule \`${inc.kind} → ${opt.action}\` is live from the next run. Please verify.`, { thread: inc.thread });
  renderTrust();
  setTimeout(runWatcher, 1500); // the next run verifies
}

function reject(inc, btn) {
  if (inc.status === 'applied' || inc.status === 'closed') return;
  if (refuseIfNotOwner(inc, `@fixer reject ${inc.id}`)) return;
  post('incidents', 'Paras Adlakha', `@fixer reject ${inc.id}`, { thread: inc.thread });
  btn?.closest('.acts')?.querySelectorAll('button').forEach((b) => (b.disabled = true));
  inc.events.push(`Paras Adlakha rejected option ${inc.option}`);
  const next = (OPTIONS[inc.kind] || []).find((o) => o.key !== inc.option);
  if (next) { post('incidents', 'Fixer', `Noted. The stations stay held. Here is the alternative:`, { thread: inc.thread }); propose(inc, next.key); }
  else { inc.status = 'rejected'; post('incidents', 'Fixer', `Noted. ${inc.id} stays open and the stations stay held until a person decides.`, { thread: inc.thread }); }
}

function closeIncident(inc, how) {
  inc.status = 'closed';
  const mins = Math.max(1, Math.round((Date.now() - inc.opened) / 60000));
  inc.events.push(`watcher verified and closed it: ${how}`);
  post('incidents', 'Watcher', `@recorder ✅ **${inc.id} closed** after ${mins} min. ${how} Please write the postmortem.`, { thread: inc.thread });
  post('desk', 'Watcher', `✅ **${inc.id} closed**: ${lower(inc.title)}. ${how}`);
  post('incidents', 'Scribe', `📝 Postmortem written: room document \`postmortem-${inc.id}\`\n${inc.events.map((e) => `- ${e}`).join('\n')}`, { thread: inc.thread });
  if (inc.kind === 'feed_stale') { S.frozen = null; $('freeze').textContent = '⚗️ Simulate a frozen feed'; }
}

// ── the analyst ────────────────────────────────────────────────────────────────
function ask(q) {
  q = q.trim(); if (!q) return;
  const asker = who();
  const root = post('desk', asker, `@analyst ${q}`);
  const intent = parseIntent(q), place = findPlace(q);
  const g = gate(trustState(), S.lastRunAt);
  let text;
  if (intent === 'status' || intent === 'other') {
    text = [`**Dispatch data: ${g.verdict}**`, ...(g.reasons.length ? g.reasons.map((r) => `- ${r}`) : ['- no open incidents; the contract passed on the last run'])];
    if (intent === 'other') text.push('Ask me where to **drop bikes** or **pick up bikes** near a place, e.g. "which stations near Union Square need bikes?"');
    text = text.join('\n');
  } else if (g.verdict === 'untrusted') {
    text = ['🛑 **I won\'t send a truck on this data.** It can\'t be trusted right now:', ...g.reasons.map((r) => `- ${r}`), 'Follow it in #data-incidents.'].join('\n');
  } else if (!place) {
    text = 'Which area? For example: Union Square, Bryant Park, Williamsburg, Hoboken.';
  } else {
    const rows = [];
    for (const [id, st] of S.status) {
      if (!st.is_installed || S.excluded.has(id)) continue;
      const info = S.stations.get(id); if (!info) continue;
      rows.push({ ...info, ...st });
    }
    const picks = pickStations(rows, place.ll, intent);
    const held = [...S.excluded].map((id) => S.stations.get(id)).filter((s) => s && distanceM(place.ll, [s.lat, s.lon]) <= 1200).length;
    const age = now() - S.lastGoodAt;
    text = [
      `${g.verdict === 'caveated' ? '🟠' : '🟢'} **${intent === 'docks' ? 'Pick up bikes' : 'Drop bikes'} near ${titleCase(place.name)}** · ${g.verdict} · data ${age < 90 ? `${age} s` : `${Math.round(age / 60)} min`} old`,
      ...(g.verdict === 'caveated' ? g.reasons.map((r) => `- caveat: ${r}`) : []),
      ...(picks.length ? picks.map((p, i) => `[${i + 1}] **${p.name}** · ${p.bikes}/${p.capacity} bikes${p.ebikes ? ` (${p.ebikes} e)` : ''}, ${p.docks} docks free · ${Math.round(p.dist)} m${p.clamped ? ' · counts clamped' : ''}`)
        : [`No station within 1.2 km is ${intent === 'docks' ? 'full' : 'short of bikes'} right now.`]),
      held ? `${held} station${held > 1 ? 's' : ''} near here ${held > 1 ? 'are' : 'is'} held out of this answer by the data contract.` : null,
    ].filter(Boolean).join('\n');
  }
  setTimeout(() => post('desk', 'Analyst', text, { thread: root }), 350);
}

// ── controls ──────────────────────────────────────────────────────────────────
function setRole(r) {
  S.role = r;
  for (const b of document.querySelectorAll('[data-role]')) b.classList.toggle('on', b.dataset.role === r);
}
document.querySelectorAll('[data-role]').forEach((b) => (b.onclick = () => setRole(b.dataset.role)));
$('askform').onsubmit = (e) => { e.preventDefault(); ask($('q').value); $('q').value = ''; };
document.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => ask(b.dataset.q)));
$('run').onclick = () => runWatcher();
$('freeze').onclick = () => {
  if (S.frozen) { S.frozen = null; $('freeze').textContent = '⚗️ Simulate a frozen feed'; }
  else { S.frozen = (S.lastFeed?.lastUpdated || now()) - 420; $('freeze').textContent = '↺ Unfreeze the feed'; }
  runWatcher();
};
$('places').innerHTML = Object.keys(PLACES).slice(0, 12).map((p) => `<option value="${titleCase(p)}">`).join('');

setRole('paras');
runWatcher();
setInterval(runWatcher, RUN_EVERY_MS);
setInterval(renderTrust, 1000);
