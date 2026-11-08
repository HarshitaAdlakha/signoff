import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate, parseIntent, pickStations } from '../agents/analyst.mjs';
import { dedupeLatest } from '../agents/lib/pipeline.mjs';
import { optionFor, preview, OPTIONS } from '../agents/lib/remediation.mjs';
import { openWarehouse } from '../agents/lib/warehouse.mjs';
import { stripMentions } from '../agents/lib/switch.mjs';
import { tmpdir } from 'node:os';

const NOW = 1_794_000_000;
const status = (open = [], rules = {}, lastGood = NOW - 30) => ({ updated_at: NOW - 10, last_good_at: lastGood, open, rules });

test('gate: no incidents and a fresh run → trusted', () => {
  assert.equal(gate(status(), NOW - 20, NOW).verdict, 'trusted');
});

test('gate: a silent watcher makes the data untrusted, whatever the document says', () => {
  const g = gate(status(), NOW - 600, NOW);
  assert.equal(g.verdict, 'untrusted');
  assert.match(g.reasons[0], /has not checked the data for 10 min/);
});

test('gate: station-level incidents caveat, feed-level incidents refuse', () => {
  assert.equal(gate(status([{ id: 'INC-001', severity: 'degraded', status: 'proposed', count: 47, title: 'Bogus' }]), NOW - 20, NOW).verdict, 'caveated');
  assert.equal(gate(status([{ id: 'INC-004', severity: 'untrusted', status: 'proposed', count: 1, title: 'The feed has stopped updating' }]), NOW - 20, NOW).verdict, 'untrusted');
});

test('gate: a signed-off "serve last good" rule caveats only within its age limit', () => {
  const inc = { id: 'INC-004', kind: 'feed_stale', severity: 'untrusted', status: 'applied', title: 'The feed has stopped updating',
    rule: { action: 'serve_last_good', params: { max_age_min: 30 } } };
  assert.equal(gate(status([inc], {}, NOW - 10 * 60), NOW - 20, NOW).verdict, 'caveated');
  assert.equal(gate(status([inc], {}, NOW - 45 * 60), NOW - 20, NOW).verdict, 'untrusted');
});

test('gate: missing status document → untrusted', () => {
  assert.equal(gate(null, NOW, NOW).verdict, 'untrusted');
});

test('intent parsing', () => {
  assert.equal(parseIntent('which stations near Union Square need bikes?'), 'bikes');
  assert.equal(parseIntent('where are docks full in Midtown'), 'docks');
  assert.equal(parseIntent('can I trust the data right now'), 'status');
  assert.equal(stripMentions('@analyst  @fixer: approve INC-001'), 'approve INC-001');
});

test('pickStations: nearest stations short of bikes, broken docks left out', () => {
  const ll = [40.7359, -73.9911];
  const rows = [
    { name: 'empty near', lat: 40.736, lon: -73.991, capacity: 30, bikes: 0, docks: 29, is_renting: 1, is_returning: 1 },
    { name: 'broken', lat: 40.736, lon: -73.9912, capacity: 30, bikes: 0, docks: 0, is_renting: 1, is_returning: 1 },
    { name: 'full of bikes', lat: 40.736, lon: -73.991, capacity: 30, bikes: 25, docks: 5, is_renting: 1, is_returning: 1 },
    { name: 'empty far', lat: 40.80, lon: -73.95, capacity: 30, bikes: 0, docks: 30, is_renting: 1, is_returning: 1 },
  ];
  assert.deepEqual(pickStations(rows, ll, 'bikes').map((r) => r.name), ['empty near']);
});

test('dedupe keeps the newest report per station', () => {
  const out = dedupeLatest([{ station_id: 'a', last_reported: 10, v: 'old' }, { station_id: 'a', last_reported: 20, v: 'new' }, { station_id: 'b', last_reported: 5 }]);
  assert.equal(out.length, 2);
  assert.equal(out.find((s) => s.station_id === 'a').v, 'new');
});

test('every incident kind has a recommended option A, and previews never write', () => {
  for (const kind of Object.keys(OPTIONS)) assert.ok(optionFor(kind, 'A'), kind);
  const wh = openWarehouse(`${tmpdir()}/signoff-test-${process.pid}.db`);
  wh.upsertStations([{ station_id: 's1', name: 'One', lat: 40.75, lon: -73.98, capacity: 10, region_id: null }]);
  const inc = wh.createIncident({ kind: 'bogus_timestamp', title: 'Bogus', severity: 'degraded', count: 1, evidence: { stations: ['s1'] } });
  const lines = preview(wh, inc, optionFor('bogus_timestamp', 'A'));
  assert.match(lines[0], /1 stations stay out of the dispatch view \(1 of them in Manhattan/);
  assert.deepEqual(wh.rules(), {}, 'a preview must not create a rule');
});

test('warehouse: approving writes a rule and an audit trail; nothing is deleted', () => {
  const wh = openWarehouse(`${tmpdir()}/signoff-test2-${process.pid}.db`);
  const inc = wh.createIncident({ kind: 'over_capacity', title: 'Over', severity: 'degraded', count: 3, evidence: { stations: [] } });
  wh.setRule({ kind: 'over_capacity', action: 'clamp', incident_id: inc.id, approved_by: 'Paras Adlakha' });
  wh.audit('Paras Adlakha', 'approved', inc.id, 'option B: clamp');
  assert.equal(wh.rules().over_capacity.action, 'clamp');
  assert.deepEqual(wh.auditFor(inc.id).map((a) => a.action), ['incident_opened', 'approved']);
  assert.throws(() => wh.db.prepare("insert into station_status values ('x',-1,0,0,0,0,1,1,1,1700000000,0,0)").run(), /CHECK|FOREIGN/i);
});
