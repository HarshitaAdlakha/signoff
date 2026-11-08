// Records one real session in Mattermost against the local Switch server and live Citi Bike data.
// Two people, each in their own headless browser: Paras (data owner) and Harshita (dispatch lead).
// Everything they type is typed into Mattermost; everything the agents say is live.
// Every frame is timestamped; marks say which person's screen is "on camera" when.
//   node record.mjs <work dir> <img dir>
// Start the agents yourself first: SIGNOFF_INTERVAL_S=20 npm start (the recording runs the watcher every 20 s).
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { signIn, channels, api, MM, TEAM } from './mm.mjs';

const [work = 'rec', img = '../../docs/img', from = 'start'] = process.argv.slice(2);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
rmSync(work, { recursive: true, force: true });
mkdirSync(img, { recursive: true });
const t0 = Date.now();
const marks = [];
const mark = (name, who) => { marks.push({ name, who, t: Date.now() }); console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s  ${who.padEnd(8)} ${name}`); };
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const root = path.resolve('../..');

async function person(username, who) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars', '--force-device-scale-factor=1'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  const { token } = await signIn(page, username);
  const { mine } = await channels(token);
  const dir = `${work}/${who}`;
  mkdirSync(dir, { recursive: true });
  const frames = [];
  const cdp = await page.createCDPSession();
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const f = `${dir}/${String(frames.length).padStart(6, '0')}.jpg`;
    writeFileSync(f, Buffer.from(data, 'base64'));
    frames.push({ f: path.resolve(f).split(path.sep).join('/'), ts: metadata.timestamp * 1000 });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  const p = {
    who, page, token, frames, browser,
    ch: (name) => mine.find((c) => c.display_name === name),
    async open(name) {
      await page.goto(`${MM}/${TEAM}/channels/${p.ch(name).name}`, { waitUntil: 'networkidle2' });
      await page.evaluate(() => {
        document.querySelector('.announcement-bar')?.remove();
        const st = document.createElement('style');
        st.textContent = '.announcement-bar{display:none!important} @keyframes __t{from{opacity:.02}to{opacity:.05}} #__tick{position:fixed;right:0;bottom:0;width:2px;height:2px;background:#888;z-index:99999;animation:__t .2s infinite alternate}';
        const d = document.createElement('div'); d.id = '__tick'; document.head.append(st); document.body.append(d);
      });
      await wait(1200);
    },
    async type(text, box = '#post_textbox') {
      await page.click(box);
      await page.type(box, text, { delay: 45 });
      await wait(400);
      if (box === '#post_textbox') { await page.keyboard.press('Escape').catch(() => {}); await page.click(box); }
      else { await page.keyboard.type(' '); await wait(300); } // a trailing space closes the @-mention list in the thread box
      await page.keyboard.press('Enter');
    },
    async rootPost(channel, needle) {
      const posts = await api(token, 'GET', `/channels/${p.ch(channel).id}/posts?per_page=200`);
      return Object.values(posts.posts).filter((x) => !x.root_id && x.message.includes(needle)).sort((a, b) => a.create_at - b.create_at)[0];
    },
    async openThread(channel, needle) {
      const post = await p.rootPost(channel, needle);
      for (let i = 0; i < 12 && !(await page.$(`#post_${post.id}`)); i++) {
        await page.evaluate(() => { const l = document.querySelector('.post-list__dynamic, #postListContent, .post-list-holder-by-time'); if (l) l.scrollTop = l.scrollHeight; });
        await wait(1000);
      }
      if (!(await page.$(`#post_${post.id}`))) { await page.goto(`${MM}/${TEAM}/pl/${post.id}`, { waitUntil: 'networkidle2' }); await wait(2500); }
      await page.evaluate((id) => document.getElementById(`post_${id}`)?.scrollIntoView({ block: 'center' }), post.id);
      await page.hover(`#post_${post.id}`);
      await wait(300);
      const btn = await page.$(`#CENTER_commentIcon_${post.id}`) || await page.$(`#post_${post.id} .ReplyButton`);
      await btn.click();
      await page.waitForSelector('#reply_textbox', { timeout: 10_000 });
      await wait(1200);
      return post;
    },
    async waitFor(channel, re, { timeout = 150_000, since = Date.now() - 5000 } = {}) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const posts = await api(token, 'GET', `/channels/${p.ch(channel).id}/posts?since=${since}`);
        const hit = Object.values(posts.posts || {}).find((x) => re.test(x.message));
        if (hit) return hit;
        await wait(1500);
      }
      throw new Error(`timed out waiting for ${re} in ${channel}`);
    },
    shot: (name) => page.screenshot({ path: `${img}/${name}.png` }),
    async start() { await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 2 }); },
    async stop() { await cdp.send('Page.stopScreencast').catch(() => {}); },
  };
  return p;
}

const paras = await person('user', 'paras');
const harshita = await person('harshita', 'harshita');
await paras.open('data-incidents');
await harshita.open('rebalancing-desk');
await paras.start(); await harshita.start();

try {
  let inc4 = 'INC-004';
  let since = Date.now();
  if (from !== 'stale') {
  // 1. The watcher's first runs against the live feed open incidents, one thread each.
  mark('start', 'paras');
  await paras.waitFor('data-incidents', /INC-003 ·/, { since: t0 - 3600_000 });
  await paras.waitFor('data-incidents', /Proposed fix for INC-003/, { since: t0 - 3600_000 });
  await wait(2500); await paras.shot('incidents');
  mark('incidents', 'paras');

  // 2. Paras opens INC-001: evidence, the fixer's proposal, its preview, the sign-off request.
  await paras.openThread('data-incidents', 'INC-001 ·');
  mark('proposal', 'paras');
  await wait(5000); await paras.shot('proposal');

  // 3. Harshita, at the desk: heads-ups from the watcher, then a dispatch question → caveated answer.
  await harshita.open('rebalancing-desk');
  mark('desk', 'harshita');
  await wait(3500);
  since = Date.now();
  mark('ask1', 'harshita');
  await harshita.type('@analyst which stations near Union Square need bikes?');
  await harshita.waitFor('rebalancing-desk', /\*\*(Drop|Pick up) bikes near Union Square/, { since });
  await wait(1500);
  await harshita.openThread('rebalancing-desk', 'which stations near Union Square');
  mark('answer1', 'harshita');
  await wait(6000); await harshita.shot('answer-caveated');

  // 4. Harshita tries to approve the fix herself. Switch refuses: the fixer answers its owner only.
  await harshita.open('data-incidents');
  since = Date.now();
  mark('try-approve', 'harshita');
  await harshita.type('@fixer approve INC-001');
  await harshita.waitFor('data-incidents', /only take instructions from my owner/, { since });
  await wait(1200);
  await harshita.openThread('data-incidents', '@fixer approve INC-001');
  mark('refused', 'harshita');
  await wait(5500); await harshita.shot('refused');

  // 5. Paras signs off in the INC-001 thread. Fixer applies, watcher verifies on the next run and closes, scribe writes the postmortem.
  await paras.open('data-incidents');
  await paras.openThread('data-incidents', 'INC-001 ·');
  since = Date.now();
  mark('approve', 'paras');
  await paras.type('@fixer approve INC-001', '#reply_textbox');
  await paras.waitFor('data-incidents', /Applied option A for INC-001/, { since });
  mark('applied', 'paras');
  await paras.waitFor('data-incidents', /INC-001 closed/, { since });
  await paras.waitFor('data-incidents', /Postmortem written: room document `postmortem-INC-001`/, { since });
  await wait(2500); await paras.shot('closed');
  mark('closed', 'paras');

  // 6. The other two: the over-capacity one with the alternative (clamp to capacity), the other as proposed.
  const kinds = JSON.parse(execFileSync('node', ['-e', "const {DatabaseSync}=require('node:sqlite');console.log(JSON.stringify(new DatabaseSync('var/warehouse.db').prepare('select id, kind from incidents').all()))"], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  const over = kinds.find((k) => k.kind === 'over_capacity')?.id;
  const other = kinds.find((k) => !['bogus_timestamp', 'over_capacity'].includes(k.kind))?.id;
  since = Date.now();
  await paras.open('data-incidents');
  if (over) { await paras.type(`@fixer approve ${over} B`); await wait(2500); }
  if (other) await paras.type(`@fixer approve ${other}`);
  mark('approve-rest', 'paras');
  await paras.waitFor('data-incidents', /INC-003 closed/, { since });
  await paras.waitFor('data-incidents', /INC-002 closed/, { since });
  await wait(3000);
  mark('all-closed', 'paras');

  // 7. Harshita asks again: trusted.
  await harshita.open('rebalancing-desk');
  since = Date.now();
  mark('ask2', 'harshita');
  await harshita.type('@analyst where do I drop bikes near Bryant Park?');
  await harshita.waitFor('rebalancing-desk', /\*\*(Drop|Pick up) bikes near Bryant Park/, { since });
  await wait(1500);
  await harshita.openThread('rebalancing-desk', 'where do I drop bikes near Bryant Park');
  mark('answer2', 'harshita');
  await wait(6000); await harshita.shot('answer-trusted');

  }
  // 8. The feed freezes (simulated, labelled). The watcher opens a feed-level incident; the analyst refuses.
  execFileSync('node', ['scripts/inject.mjs', 'stale', '20'], { cwd: root });
  since = Date.now();
  await harshita.open('rebalancing-desk');
  mark('stale', 'harshita');
  const opened = await harshita.waitFor('rebalancing-desk', /INC-\d+ opened/, { since });
  inc4 = opened.message.match(/INC-\d+/)[0];
  console.log('stale incident is', inc4);
  await wait(2500);
  since = Date.now();
  mark('ask3', 'harshita');
  await harshita.type('@analyst which stations near Union Square need bikes?');
  await harshita.waitFor('rebalancing-desk', /won't send a truck/, { since });
  await wait(1500);
  const ask3 = await harshita.rootPost('rebalancing-desk', '@analyst which stations near Union Square need bikes?');
  await harshita.page.evaluate(() => document.querySelector('#rhsCloseButton, [aria-label="Close"]')?.click());
  await wait(800);
  mark('refuse', 'harshita');
  await wait(6000); await harshita.shot('refuse-untrusted');

  // 9. Paras signs off "answer from the last good data for up to 30 minutes". Harshita gets a caveated answer, with the data's age.
  await paras.open('data-incidents');
  await paras.openThread('data-incidents', `${inc4} ·`);
  since = Date.now();
  mark('approve4', 'paras');
  await paras.type(`@fixer approve ${inc4}`, '#reply_textbox');
  await paras.waitFor('data-incidents', new RegExp(`Applied option A for ${inc4}`), { since });
  await wait(3500); await paras.shot('approve-stale');
  await harshita.open('rebalancing-desk');
  await wait(1500);
  since = Date.now();
  mark('ask4', 'harshita');
  await harshita.type('@analyst any stations near Grand Central that need bikes?');
  await harshita.waitFor('rebalancing-desk', /\*\*(Drop|Pick up) bikes near Grand Central/, { since });
  await wait(1500);
  await harshita.openThread('rebalancing-desk', 'any stations near Grand Central');
  mark('answer4', 'harshita');
  await wait(6000); await harshita.shot('answer-last-good');

  // 10. The feed recovers; the watcher closes INC-004 by itself.
  execFileSync('node', ['scripts/inject.mjs', 'clear'], { cwd: root });
  since = Date.now();
  await harshita.open('rebalancing-desk');
  mark('recover', 'harshita');
  await harshita.waitFor('rebalancing-desk', new RegExp(`${inc4} closed`), { since });
  await wait(4000); await harshita.shot('recovered');
  mark('end', 'harshita');
  await wait(1000);
} finally {
  await paras.stop(); await harshita.stop();
  writeFileSync(`${work}/recording.json`, JSON.stringify({ t0, marks, frames: { paras: paras.frames, harshita: harshita.frames } }, null, 1));
  await paras.browser.close(); await harshita.browser.close();
  execFileSync('node', ['scripts/inject.mjs', 'clear'], { cwd: root });
  console.log(`saved ${paras.frames.length + harshita.frames.length} frames, ${marks.length} marks`);
}
