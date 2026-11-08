// The dispatch warehouse: a local SQLite database (Node's built-in node:sqlite, no dependency).
// Nothing is ever deleted: rejected rows go to quarantine, remediations are rules, every change is audited.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
create table if not exists stations (
  station_id text primary key, name text not null, lat real not null, lon real not null,
  capacity integer not null check (capacity >= 0), region_id text, updated_at integer not null);
create table if not exists station_status (
  station_id text primary key references stations(station_id),
  bikes integer not null check (bikes >= 0), ebikes integer not null check (ebikes >= 0 and ebikes <= bikes),
  docks integer not null check (docks >= 0), bikes_disabled integer not null default 0, docks_disabled integer not null default 0,
  is_installed integer not null, is_renting integer not null, is_returning integer not null,
  last_reported integer not null check (last_reported >= 1367366400), clamped integer not null default 0,
  updated_at integer not null);
create table if not exists quarantine (
  station_id text not null, reason text not null, detail text not null,
  first_seen integer not null, last_seen integer not null, times_seen integer not null default 1,
  incident_id text, handled_by_rule text,
  primary key (station_id, reason));
create table if not exists ingest_runs (
  id integer primary key autoincrement, at integer not null, rows_in integer not null, accepted integer not null,
  rejected integer not null, handled integer not null default 0, feed_defects text not null default '[]',
  status text not null check (status in ('ok','partial','failed')), note text, injected text);
create table if not exists incidents (
  id text primary key, kind text not null, title text not null, severity text not null check (severity in ('degraded','untrusted')),
  status text not null check (status in ('open','proposed','approved','applied','closed','rejected')),
  opened_at integer not null, updated_at integer not null, closed_at integer,
  count integer not null, evidence text not null, thread_id text, desk_thread_id text,
  proposal text, decided_by text, decided_at integer, resolution text);
create table if not exists rules (
  kind text primary key, action text not null, params text not null default '{}',
  incident_id text not null, approved_by text not null, approved_at integer not null);
create table if not exists audit (
  id integer primary key autoincrement, at integer not null, actor text not null, action text not null,
  incident_id text, detail text not null);
create table if not exists answers (
  id integer primary key autoincrement, at integer not null, asker text, question text not null,
  verdict text not null, stations text not null default '[]', latency_ms integer);
`;

export function openWarehouse(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('pragma journal_mode = wal; pragma busy_timeout = 5000; pragma foreign_keys = on;');
  db.exec(SCHEMA);
  return new Warehouse(db);
}

const now = () => Math.floor(Date.now() / 1000);
const j = (v) => JSON.stringify(v ?? null);
const pj = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

export class Warehouse {
  constructor(db) { this.db = db; }

  tx(fn) {
    this.db.exec('begin immediate');
    try { const r = fn(); this.db.exec('commit'); return r; } catch (e) { this.db.exec('rollback'); throw e; }
  }

  capacities() {
    const out = {};
    for (const r of this.db.prepare('select station_id, capacity from stations').all()) out[r.station_id] = r.capacity;
    return out;
  }
  stationCount() { return this.db.prepare('select count(*) n from stations').get().n; }

  upsertStations(rows) {
    const st = this.db.prepare(`insert into stations values (?,?,?,?,?,?,?)
      on conflict(station_id) do update set name=excluded.name, lat=excluded.lat, lon=excluded.lon,
      capacity=excluded.capacity, region_id=excluded.region_id, updated_at=excluded.updated_at`);
    const t = now();
    this.tx(() => { for (const r of rows) st.run(r.station_id, r.name, r.lat, r.lon, r.capacity, r.region_id, t); });
  }

  /** Apply one validated batch in a single transaction. */
  applyStatus({ rows, quarantined, run }) {
    const t = now();
    const up = this.db.prepare(`insert into station_status values (?,?,?,?,?,?,?,?,?,?,?,?)
      on conflict(station_id) do update set bikes=excluded.bikes, ebikes=excluded.ebikes, docks=excluded.docks,
      bikes_disabled=excluded.bikes_disabled, docks_disabled=excluded.docks_disabled, is_installed=excluded.is_installed,
      is_renting=excluded.is_renting, is_returning=excluded.is_returning, last_reported=excluded.last_reported,
      clamped=excluded.clamped,
      updated_at=case when station_status.last_reported <> excluded.last_reported or station_status.bikes <> excluded.bikes
        or station_status.docks <> excluded.docks then excluded.updated_at else station_status.updated_at end`);
    const q = this.db.prepare(`insert into quarantine (station_id, reason, detail, first_seen, last_seen, times_seen, incident_id, handled_by_rule)
      values (?,?,?,?,?,1,?,?) on conflict(station_id, reason) do update set detail=excluded.detail, last_seen=excluded.last_seen,
      times_seen=quarantine.times_seen+1, incident_id=coalesce(excluded.incident_id, quarantine.incident_id),
      handled_by_rule=excluded.handled_by_rule`);
    const ins = this.db.prepare(`insert into ingest_runs (at, rows_in, accepted, rejected, handled, feed_defects, status, note, injected)
      values (?,?,?,?,?,?,?,?,?)`);
    return this.tx(() => {
      for (const r of rows) up.run(r.station_id, r.bikes, r.ebikes, r.docks, r.bikes_disabled, r.docks_disabled,
        r.is_installed, r.is_renting, r.is_returning, r.last_reported, r.clamped ? 1 : 0, t);
      for (const x of quarantined) q.run(x.station_id, x.reason, x.detail, t, t, x.incident_id ?? null, x.rule ?? null);
      return Number(ins.run(t, run.rows_in, run.accepted, run.rejected, run.handled, j(run.feed), run.status, run.note, run.injected ?? null).lastInsertRowid);
    });
  }

  /** Stations that came back clean are released from quarantine (kept as history: last_seen stops moving). */
  activeQuarantine(sinceS = 180) {
    return this.db.prepare('select * from quarantine where last_seen >= ?').all(now() - sinceS);
  }
  excludedStationIds() {
    return new Set(this.activeQuarantine().map((r) => r.station_id));
  }

  // ── incidents ──────────────────────────────────────────────────────────────
  nextIncidentId() {
    const n = this.db.prepare("select count(*) n from incidents").get().n + 1;
    return `INC-${String(n).padStart(3, '0')}`;
  }
  openIncidentFor(kind) {
    return this.inc(this.db.prepare("select * from incidents where kind = ? and status not in ('closed') order by opened_at desc limit 1").get(kind));
  }
  incident(id) { return this.inc(this.db.prepare('select * from incidents where id = ?').get(String(id).toUpperCase())); }
  openIncidents() { return this.db.prepare("select * from incidents where status not in ('closed') order by opened_at").all().map((r) => this.inc(r)); }
  recentIncidents(n = 10) { return this.db.prepare('select * from incidents order by opened_at desc limit ?').all(n).map((r) => this.inc(r)); }
  inc(r) { return r ? { ...r, evidence: pj(r.evidence, {}), proposal: pj(r.proposal) } : null; }

  createIncident({ kind, title, severity, count, evidence }) {
    const id = this.nextIncidentId(), t = now();
    this.db.prepare(`insert into incidents (id, kind, title, severity, status, opened_at, updated_at, count, evidence)
      values (?,?,?,?, 'open', ?, ?, ?, ?)`).run(id, kind, title, severity, t, t, count, j(evidence));
    this.audit('watcher', 'incident_opened', id, `${count} × ${kind}`);
    return this.incident(id);
  }
  updateIncident(id, fields) {
    const cols = Object.keys(fields);
    const vals = cols.map((c) => (typeof fields[c] === 'object' && fields[c] !== null ? j(fields[c]) : fields[c]));
    this.db.prepare(`update incidents set ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? where id = ?`).run(...vals, now(), id);
    return this.incident(id);
  }

  // ── rules (standing remediations) ──────────────────────────────────────────
  rules() {
    const out = {};
    for (const r of this.db.prepare('select * from rules').all()) out[r.kind] = { ...r, params: pj(r.params, {}) };
    return out;
  }
  setRule({ kind, action, params, incident_id, approved_by }) {
    this.db.prepare(`insert into rules values (?,?,?,?,?,?) on conflict(kind) do update set action=excluded.action,
      params=excluded.params, incident_id=excluded.incident_id, approved_by=excluded.approved_by, approved_at=excluded.approved_at`)
      .run(kind, action, j(params || {}), incident_id, approved_by, now());
  }

  audit(actor, action, incident_id, detail) {
    this.db.prepare('insert into audit (at, actor, action, incident_id, detail) values (?,?,?,?,?)').run(now(), actor, action, incident_id ?? null, detail);
  }
  auditFor(id) { return this.db.prepare('select * from audit where incident_id = ? order by id').all(id); }

  lastRuns(n = 15) { return this.db.prepare('select * from ingest_runs order by id desc limit ?').all(n); }
  lastGoodAt() { return this.db.prepare("select max(updated_at) t from station_status").get().t; }
  feedAge() { return this.db.prepare("select max(last_reported) t from station_status").get().t; }

  /** Live stations for dispatch, excluding anything quarantined right now. */
  dispatchView() {
    const rows = this.db.prepare(`select s.station_id, s.name, s.lat, s.lon, s.capacity, st.bikes, st.ebikes, st.docks,
      st.is_renting, st.is_returning, st.last_reported, st.clamped, st.updated_at
      from station_status st join stations s using (station_id) where st.is_installed = 1`).all();
    const ex = this.excludedStationIds();
    return { rows: rows.filter((r) => !ex.has(r.station_id)), excluded: ex };
  }

  logAnswer({ asker, question, verdict, stations, latency_ms }) {
    this.db.prepare('insert into answers (at, asker, question, verdict, stations, latency_ms) values (?,?,?,?,?,?)')
      .run(now(), asker ?? null, question, verdict, j(stations), latency_ms ?? null);
  }
}
