// Cuts the Signoff videos from one real recording (record.mjs).
//   node video.mjs <2min|3min|captioned> <recording dir> <slides png dir> <out.mp4>
// Each segment runs between two recorded marks and shows that person's screen (Paras or Harshita).
// A segment plays in real time, or sped up (labelled "sped up N×") so it lasts as long as its narration.
// Captions and a "whose screen" tag are PNG overlays; the voice is edge-tts.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import sharp from 'sharp';
import { resolve, sep } from 'node:path';

const [cut, rec, slides, out, rec2] = process.argv.slice(2);
const R = JSON.parse(readFileSync(`${rec}/recording.json`, 'utf-8'));
const M = Object.fromEntries(R.marks.map((m) => [m.name, m]));
// The main recording ends at the refusal; the last act (sign-off of a bounded fallback, recovery)
// was recorded as a second session against the same server. Its marks are suffixed @2.
if (M.refuse) M.refuse_end = { name: 'refuse_end', who: M.refuse.who, t: Math.min(M.refuse.t + 5500, R.frames[M.refuse.who].at(-1).ts) };
if (rec2) {
  const R2 = JSON.parse(readFileSync(`${rec2}/recording.json`, 'utf-8'));
  for (const m of R2.marks) M[`${m.name}@2`] = { ...m, who: `${m.who}@2` };
  for (const [k, v] of Object.entries(R2.frames)) R.frames[`${k}@2`] = v;
}
const work = resolve(`${rec}/edit-${cut}`).split(sep).join('/');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const voiced = cut !== 'captioned';
const WHO = { paras: 'Paras · data owner', harshita: 'Harshita · dispatch lead' };

// from/to: recording marks; the screen is the `from` mark's person. say: narration. cap: [tag, caption].
const demo = [
  { from: 'incidents', to: 'proposal', cap: ['01 · DETECT', 'The watcher ran the contract on the live Citi Bike feed: three real incidents'],
    say: 'This is Signoff, live in Mattermost on a local Switch server. The watcher agent pulls the public Citi Bike feed and runs our data contract. On its first run it opened three real incidents: forty seven stations reporting a last update in 1970, stations with more bikes than docks, and stations silent for a day. Each is one thread, handed to whoever holds the remediator role.' },
  { from: 'proposal', to: 'desk', cap: ['02 · PROPOSE', 'The fixer proposes a remediation, previews it, and asks the data owner to sign off'],
    say: 'The fixer replies in the thread with a proposal, why, exactly what changes if it is approved, and an alternative. Then it asks Paras, the data owner, to sign off. It never applies anything on its own.' },
  { from: 'ask1', to: 'answer1', cap: ['03 · ASK', 'Harshita, at the rebalancing desk, asks where to send a truck'],
    say: 'Meanwhile, at the rebalancing desk, Harshita asks the analyst which stations near Union Square need bikes.' },
  { from: 'answer1', to: 'try-approve', cap: ['04 · TRUST GATE', 'The analyst checks the incident state first: a caveated answer, every station cited'],
    say: 'Before it answers, the analyst reads the room\'s data status document, which the watcher keeps current. Three incidents are open, so it answers with a caveat for each, cites five stations, and says how many nearby stations it left out.' },
  { from: 'try-approve', to: 'refused', cap: ['05 · GATE', 'Harshita tries to approve the fix herself. Switch refuses: only the owner can'],
    say: 'Can Harshita just approve the fix herself? No. The fixer only takes instructions from its owner, and Switch enforces that, not our code.' },
  { from: 'refused', to: 'approve', cap: ['05 · GATE', 'Switch answers on the fixer\'s behalf: owner only'], say: null, min: 3 },
  { from: 'approve', to: 'applied', cap: ['06 · SIGN-OFF', 'Paras signs off in the incident thread'],
    say: 'Paras signs off in the thread.' },
  { from: 'applied', to: 'closed', cap: ['07 · VERIFY', 'Fixer applies a standing rule; the watcher verifies on its next run, closes; the scribe writes the postmortem'],
    say: 'The fixer applies a standing rule, with Paras\'s name on it, and hands back to the monitor role. On its next run the watcher verifies that every failing station is handled, and closes the incident. The scribe writes the postmortem as a room document.' },
  { from: 'approve-rest', to: 'all-closed', cap: ['08 · DECIDE', 'The other two: one as proposed, one with the alternative (clamp to capacity)'],
    say: 'Paras signs off the other two, choosing the alternative for one of them, and both are verified and closed.' },
  { from: 'ask2', to: 'answer2', cap: ['09 · TRUSTED', 'Every incident closed: the same question now gets a trusted answer'],
    say: 'Now the desk gets a trusted answer.' },
  { from: 'answer2', to: 'stale', cap: ['09 · TRUSTED', 'Trusted: no caveats, five stations cited'], say: null, min: 3 },
  { from: 'stale', to: 'ask3', cap: ['10 · SIMULATED FAULT', 'We freeze the feed (labelled simulation). The watcher opens a feed-level incident'],
    say: 'Then we simulate the vendor\'s feed freezing. The watcher opens a feed level incident within one run.' },
  { from: 'ask3', to: 'refuse', cap: ['11 · REFUSE', '"I won\'t send a truck on this data"'],
    say: 'And the analyst refuses. It will not send a truck and a crew on data that stopped updating, and it says why.' },
  { from: 'refuse', to: 'refuse_end', cap: ['11 · REFUSE', 'Untrusted: no answer, with the reasons and where to follow it'], say: null, min: 3 },
  { from: 'approve4@2', to: 'ask4@2', cap: ['12 · DECIDE', 'Paras signs off: answer from the last good data, stating its age, for up to 30 minutes'],
    say: 'Paras signs off a bounded fallback: answer from the last good data, state its age, for thirty minutes at most.' },
  { from: 'ask4@2', to: 'answer4@2', cap: ['13 · CAVEATED', 'A caveated answer, with the age of the data'],
    say: 'So the desk gets an answer again, with the age of the data on it.' },
  { from: 'answer4@2', to: 'recover@2', cap: ['13 · CAVEATED', 'Caveated: the signed-off rule, its limit, and the data\'s age'], say: null, min: 3 },
  { from: 'recover@2', to: 'end@2', cap: ['14 · RECOVER', 'The feed recovers; the watcher closes the incident on its own'],
    say: 'When the feed recovers, the watcher closes the incident by itself.' },
];
const S = (n) => `${slides}/s${n}.png`;
const steps = cut === '3min'
  ? [
      { slide: S(1), say: 'Hi, we are Paras and Harshita. This is Signoff: AI agents catch bad data in the team chat, a person signs off on the fix, and nothing downstream acts on data nobody trusts. Built on Switch.' },
      { slide: S(2), say: 'A dispatcher sends a truck and a crew wherever the station data says. Bad data is expensive and invisible: in surveys it touches about a third of revenue and takes hours to even notice. And agentic AI makes it worse, because agents act on whatever they are given. The decision to trust or change data needs a named person, in the room where the work happens.' },
      { slide: S(3), say: 'So Signoff is two Switch rooms and four agents. A watcher, a fixer and a scribe in data incidents. An analyst at the rebalancing desk. Hand-offs go to roles, the trust state is a room document, and the fixer only listens to the data owner.' },
      ...demo,
      { slide: S(5), say: 'Switch is not a wrapper here. Rooms, roles, threads, room documents, linked rooms and the addressing policy are the whole workflow. Take Switch away and there is no hand-off, no sign-off and no gate.' },
      { slide: S(7), say: 'Signoff. AI agents catch bad data. A person signs off on the fix. Thank you to WeMakeDevs, DevTools Academy, the Switch team, and everyone who helped along the way.', min: 6 },
    ]
  : cut === '2min'
    ? [{ slide: S(1), say: 'Signoff: AI agents catch bad data in the team chat, and a person signs off on the fix. Built on Switch.', min: 3 }, ...demo,
       { slide: S(7), say: 'Signoff. AI agents catch bad data. A person signs off on the fix.', min: 4 }]
    : demo.map((d) => ({ ...d, say: undefined, min: Math.max(4, d.cap[1].length / 15) })).concat([{ slide: S(1), min: 4 }]);

// --- voice -----------------------------------------------------------------------
steps.forEach((s, i) => {
  if (!voiced || !s.say) return;
  s.mp3 = `${work}/line-${String(i).padStart(2, '0')}.mp3`;
  execFileSync('python', ['-m', 'edge_tts', '--voice', 'en-US-AvaNeural', '--rate=+8%', '--text', s.say, '--write-media', s.mp3]);
  s.len = dur(s.mp3);
});

// --- overlays ------------------------------------------------------------------------
async function overlay(file, cap, speed, who) {
  const parts = [];
  if (cap) {
    const w = Math.min(1840, 150 + (cap[0].length + cap[1].length) * 14.6);
    const x = (1920 - w) / 2;
    parts.push(`<rect x="${x}" y="962" width="${w}" height="72" rx="18" fill="#14161c" fill-opacity="0.94"/>`,
      `<text x="${x + 28}" y="1006" font-family="Consolas, monospace" font-weight="700" font-size="20" fill="#e3ff5c" letter-spacing="1.5">${esc(cap[0])}</text>`,
      `<text x="${x + 44 + cap[0].length * 12.2}" y="1008" font-family="Segoe UI, Arial, sans-serif" font-weight="600" font-size="27" fill="#f6f5f1">${esc(cap[1])}</text>`);
  }
  if (who) {
    const label = WHO[who.replace('@2', '')];
    const w = 40 + label.length * 13;
    parts.push(`<rect x="24" y="24" width="${w}" height="46" rx="23" fill="${who.startsWith('paras') ? '#0b0b0c' : '#e3ff5c'}" fill-opacity="0.96"/>`,
      `<text x="${24 + w / 2}" y="54" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="21" fill="${who.startsWith('paras') ? '#fff' : '#0b0b0c'}">${esc(label)}</text>`);
  }
  if (speed > 1.2) {
    const label = `▶▶  sped up ${Math.round(speed)}× · real run`;
    parts.push(`<rect x="1572" y="24" width="324" height="46" rx="23" fill="#0f766e" fill-opacity="0.95"/>`,
      `<text x="1734" y="54" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="21" fill="#fff">${esc(label)}</text>`);
  }
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">${parts.join('')}</svg>`)).png().toFile(file);
}

// --- clips -------------------------------------------------------------------------
const clips = [];
let t = 0;
for (const [i, s] of steps.entries()) {
  const want = Math.max(s.min ?? 0, (s.len ?? 0) + 0.7);
  const clip = `${work}/clip-${String(i).padStart(2, '0')}.mp4`;
  const ov = `${work}/ov-${i}.png`;
  if (s.slide) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', s.slide, '-t', want.toFixed(2), '-vf', 'fps=30,scale=1920:1080,format=yuv420p', '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', clip]);
  } else {
    const A = M[s.from], B = M[s.to];
    if (!A || !B) throw new Error(`missing mark ${s.from} or ${s.to}`);
    const a = A.t, b = B.t, frames = R.frames[A.who];
    const raw = (b - a) / 1000;
    const speed = Math.max(1, raw / want);
    await overlay(ov, s.cap, speed, A.who);
    let shown = frames.filter((fr, k) => (frames[k + 1]?.ts ?? Infinity) > a && fr.ts < b);
    if (!shown.length) shown = [frames.filter((fr) => fr.ts <= b).at(-1) || frames[0]];
    const lines = shown.map((fr, k) => {
      const from = Math.max(fr.ts, a), to = Math.min(shown[k + 1]?.ts ?? b, b);
      return `file '${fr.f}'\nduration ${Math.max(0.001, (to - from) / 1000 / speed).toFixed(4)}`;
    });
    const extra = want - raw / speed;
    lines.push(`file '${shown.at(-1).f}'\nduration ${Math.max(0.04, extra).toFixed(4)}`, `file '${shown.at(-1).f}'`);
    writeFileSync(`${work}/list-${i}.txt`, lines.join('\n'));
    // 1600×900 screen, scaled to fill 1920×1080.
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${work}/list-${i}.txt`, '-loop', '1', '-i', ov,
      '-filter_complex', '[0:v]fps=30,scale=1920:1080:flags=lanczos,format=yuv420p[v];[v][1:v]overlay=0:0,format=yuv420p', '-t', want.toFixed(2), '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', clip]);
    console.log(`${s.from}→${s.to} (${A.who}): ${raw.toFixed(0)}s real → ${want.toFixed(1)}s (${speed.toFixed(1)}×)`);
  }
  s.at = t;
  t += dur(clip);
  clips.push(clip);
}
writeFileSync(`${work}/clips.txt`, clips.map((c) => `file '${c}'`).join('\n'));
const silent = `${work}/silent.mp4`;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${work}/clips.txt`, '-c', 'copy', silent]);

if (!voiced) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', silent, '-c', 'copy', '-movflags', '+faststart', out]);
} else {
  const v = steps.filter((s) => s.mp3);
  const inputs = ['-i', silent, ...v.flatMap((s) => ['-i', s.mp3])];
  const delays = v.map((s, k) => `[${k + 1}:a]adelay=${Math.round(s.at * 1000 + 250)}|${Math.round(s.at * 1000 + 250)}[a${k}]`).join(';');
  const mix = `${delays};${v.map((_, k) => `[a${k}]`).join('')}amix=inputs=${v.length}:normalize=0[aout]`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', mix, '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-t', t.toFixed(2), out]);
}
console.log('wrote', out, Math.round(dur(out)), 's');
