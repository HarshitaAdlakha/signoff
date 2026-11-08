// node say.mjs <username> <channel> "<text>" [INC-00x to reply in that incident's thread]
import { login, api, channels } from './mm.mjs';
export async function say(username, channel, text, inc) {
  const { token } = await login(username);
  const { mine } = await channels(token);
  const ch = mine.find((c) => c.display_name === channel || c.name === channel);
  let root_id = '';
  if (inc) {
    const posts = await api(token, 'GET', `/channels/${ch.id}/posts?per_page=200`);
    const root = Object.values(posts.posts).filter((p) => !p.root_id && p.message.includes(`${inc} ·`)).sort((a, b) => a.create_at - b.create_at)[0];
    root_id = root?.id || '';
  }
  return api(token, 'POST', '/posts', { channel_id: ch.id, message: text, root_id });
}
if (process.argv[1].endsWith('say.mjs')) {
  const [u, c, t, i] = process.argv.slice(2);
  const r = await say(u, c, t, i);
  console.log(r.id ? `posted ${r.id}${r.root_id ? ' in thread ' + r.root_id : ''}` : JSON.stringify(r).slice(0, 200));
}
