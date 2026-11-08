// A minimal Switch agent-protocol client, written from the public spec:
//   https://docs.switchagents.ai/switch-rooms/internals/agent-connection
//   https://docs.switchagents.ai/switch-rooms/internals/agent-events
// One WebSocket for events (answer every ping with a pong + cursor), HTTP for operations.
// No dependencies: Node 22+ global WebSocket and fetch.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export class SwitchAgent extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.base      Switch server address, e.g. http://localhost:8000
   * @param {string} o.agentId
   * @param {string} o.apiKey
   * @param {string} o.name      registered agent name, for logs
   * @param {string[]} o.rooms   Switch room ids to claim at open
   * @param {string} [o.connectionId]  reuse across restarts
   */
  constructor({ base, agentId, apiKey, name, rooms, connectionId }) {
    super();
    Object.assign(this, { base, agentId, apiKey, name, rooms });
    this.connectionId = connectionId || randomUUID();
    this.cursor = 0;
    this.generation = null;
    this.stopped = false;
    this.activeRoom = null;
    this.seen = new Set();
  }

  log(...a) { console.log(new Date().toISOString().slice(11, 19), `[${this.name}]`, ...a); }

  headers(extra = {}) {
    return { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', ...extra };
  }

  /** Call an agent operation: POST /agents/{id}/ops/{op}. Returns `result`. */
  async op(operation, args = {}) {
    const r = await fetch(`${this.base}/agents/${this.agentId}/ops/${operation}`, {
      method: 'POST',
      headers: this.headers({ 'x-switch-connection-id': this.connectionId }),
      body: JSON.stringify(args),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${operation} ${r.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text).result;
  }

  /** Make `roomId` the room this connection acts in (connect_to_room takes over). */
  async useRoom(roomId) {
    if (this.activeRoom === roomId) return this.roomContext;
    for (let attempt = 1; ; attempt++) {
      try {
        this.roomContext = await this.op('connect_to_room', { room_id: roomId, include_general_instructions: false });
        this.activeRoom = roomId;
        return this.roomContext;
      } catch (e) {
        // The socket dropped and the server hasn't seen the reconnect yet: wait for it, then claim again.
        if (attempt >= 4 || !/is not open|409/.test(e.message)) throw e;
        await this.waitConnected(20_000).catch(() => {});
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  /** The room this agent lives in and the role it holds there; re-taken after every reconnect. */
  setHome(roomId, role) { this.home = { roomId, role }; }

  async takeHome() {
    if (!this.home) return;
    this.activeRoom = null;
    await this.useRoom(this.home.roomId);
    if (this.home.role) {
      try { await this.op('assume_role', { role: this.home.role }); this.log(`holds role @${this.home.role}`); }
      catch (e) { if (!/already/i.test(e.message)) this.log(`assume_role @${this.home.role}: ${e.message.slice(0, 120)}`); }
    }
  }

  /** Run a room-scoped operation; if the connection dropped meanwhile, wait for it, re-claim the room, retry once. */
  async inRoom(roomId, fn) {
    try { await this.useRoom(roomId); return await fn(); }
    catch (e) {
      if (!/Not connected to a room|is not open|connect_to_room 409/i.test(e.message)) throw e;
      await this.waitConnected();
      this.activeRoom = null;
      await this.useRoom(roomId);
      return fn();
    }
  }

  waitConnected(timeoutMs = 20_000) {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('not reconnected in time')), timeoutMs);
      this.once('ready', () => { clearTimeout(t); setTimeout(resolve, 300); });
    });
  }

  async post(roomId, body, threadId) {
    return this.inRoom(roomId, () => this.op('post_message', threadId ? { body, thread_id: threadId } : { body }));
  }

  async tell(roomId, { names = [], roles = [] }, body, threadId) {
    const a = { body };
    if (names.length) a.target_names = names;
    if (roles.length) a.target_roles = roles;
    if (threadId) a.thread_id = threadId;
    return this.inRoom(roomId, () => this.op('send_targeted_message', a));
  }

  /** Open the socket and keep it open; reconnect and resume from the cursor on a lapse. */
  start() {
    const qs = new URLSearchParams({
      connection_id: this.connectionId,
      scope: 'all',
      filter: 'all',
      start_from: this.cursor ? String(this.cursor) : 'head',
      client: 'signoff',
      client_version: '1.0.0',
    });
    if (this.generation != null) qs.set('expected_generation', String(this.generation));
    const url = `${this.base.replace(/^http/, 'ws')}/agents/${this.agentId}/connection/ws?${qs}`;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.apiKey}` } });
    this.ws = ws;
    ws.onmessage = (ev) => this.onFrame(JSON.parse(ev.data));
    ws.onclose = (ev) => {
      this.connected = false;
      if (this.stopped || this.finalClose) return;
      this.log(`socket closed ${ev.code} ${ev.reason || ''}; reconnecting from ${this.cursor}`);
      setTimeout(() => this.start(), 1500);
    };
    ws.onerror = () => {};
  }

  stop() { this.stopped = true; try { this.ws?.close(); } catch {} }

  onFrame(raw) {
    // Every frame is {event, data[, id]}. Control frames have no id; domain events carry the sequence.
    const DOMAIN = new Set(['message', 'command', 'room_join']);
    if (raw.event && !DOMAIN.has(raw.event)) raw = { type: raw.event, ...(raw.data || {}) };
    const f = raw;
    if (f.type === 'ping') { this.ws.send(JSON.stringify({ type: 'pong', cursor: this.cursor })); return; }
    if (f.type === 'connection_state') {
      this.generation = f.generation;
      if (typeof f.cursor === 'number' && f.cursor > this.cursor) this.cursor = f.cursor;
      this.log(`connected (generation ${f.generation}, rooms ${f.rooms?.length ?? 0}, protocol ${f.protocol ?? '?'})`);
      this.connected = true;
      this.activeRoom = null; // a new attach holds no room claim until we take one
      const again = this.attached;
      this.attached = true;
      this.emit('ready', f);
      if (again) this.takeHome().catch((e) => this.log('re-claim after reconnect failed:', e.message.slice(0, 120)));
      return;
    }
    if (f.type === 'gap') { this.cursor = f.resumed_at ?? this.cursor; this.emit('gap', f); return; }
    if (f.type === 'evicted') {
      this.log(`evicted: ${f.code} ${f.reason || ''}`);
      if (f.code === 'taken_over' || f.code === 'closed') this.finalClose = true;
      return;
    }
    if (f.type === 'refused') { this.log(`refused ${f.status}: ${f.detail}`); this.finalClose = true; return; }
    if (f.type === 'subscription_changed' || f.type === 'room_released') { this.emit(f.type, f); return; }
    if (f.event && f.data) {
      if (typeof f.id === 'number') this.cursor = Math.max(this.cursor, f.id);
      const d = f.data;
      const key = `${d.room_id}:${d.payload?.message_id ?? f.id}`;
      if (this.seen.has(key)) return; // replayed after a resume
      this.seen.add(key);
      if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2000));
      this.emit(f.event, { room_id: d.room_id, ...d.payload, sequence: f.id });
    }
  }
}

/** Strip leading @mentions so commands read the same whether tagged or followed up. */
export function stripMentions(body = '') {
  return body.replace(/^(\s*@[\w.\-]+[:,]?\s*)+/, '').trim();
}

/** Run an agent's startup until it succeeds: a connection can drop mid-startup on a loaded machine. */
export async function retry(agent, fn, { tries = 20, delayMs = 3000 } = {}) {
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); }
    catch (e) {
      agent.log(`startup attempt ${i} failed: ${e.message.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, delayMs));
      await agent.waitConnected(30_000).catch(() => {});
      agent.activeRoom = null;
    }
  }
  agent.log('startup gave up');
}
