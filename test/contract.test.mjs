import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateStatus, validateStations, defectsByKind, trustVerdict, EARLIEST_VALID } from '../agents/lib/contract.mjs';

const NOW = 1_794_000_000; // Nov 2026
const ok = (id, o = {}) => ({ station_id: id, num_bikes_available: 5, num_ebikes_available: 1, num_docks_available: 10,
  num_bikes_disabled: 0, num_docks_disabled: 0, is_installed: 1, is_renting: 1, is_returning: 1, last_reported: NOW - 30, ...o });
const caps = { a: 15, b: 15, c: 6, d: 15 };

test('a clean record passes', () => {
  const r = validateStatus([ok('a')], caps, NOW, { lastUpdated: NOW - 20, expected: 1 });
  assert.equal(r.rows.length, 1); assert.equal(r.rejects.length, 0); assert.equal(r.feed.length, 0);
});

test('the 1970 placeholder from the live feed is quarantined as bogus_timestamp', () => {
  const r = validateStatus([ok('a', { last_reported: 86400 })], caps, NOW);
  assert.equal(r.rejects[0].reason, 'bogus_timestamp');
  assert.match(r.rejects[0].detail, /1970-01-02/);
  assert.ok(86400 < EARLIEST_VALID);
});

test('more bikes + docks than capacity is over_capacity (with a 2-dock valet tolerance)', () => {
  assert.equal(validateStatus([ok('c', { num_bikes_available: 4, num_docks_available: 4 })], caps, NOW).rejects.length, 0); // 8 ≤ 6+2
  const r = validateStatus([ok('c', { num_bikes_available: 9, num_docks_available: 4 })], caps, NOW);
  assert.equal(r.rejects[0].reason, 'over_capacity');
});

test('an installed station silent for over a day is silent_station', () => {
  const r = validateStatus([ok('a', { last_reported: NOW - 30 * 3600 })], caps, NOW);
  assert.equal(r.rejects[0].reason, 'silent_station');
});

test('e-bikes above bikes, bad flags, negative counts and unknown stations each get their own reason', () => {
  const r = validateStatus([
    ok('a', { num_ebikes_available: 9 }), ok('b', { is_renting: 2 }), ok('d', { num_docks_available: -1 }), ok('zz'),
  ], caps, NOW);
  assert.deepEqual(r.rejects.map((x) => x.reason), ['ebikes_exceed_bikes', 'invalid_flag', 'invalid_count', 'unknown_station']);
});

test('feed-level defects: duplicates, a frozen feed and a volume drop', () => {
  const r = validateStatus([ok('a'), ok('a'), ok('b')], caps, NOW, { lastUpdated: NOW - 900, expected: 10 });
  const kinds = r.feed.map((f) => f.reason).sort();
  assert.deepEqual(kinds, ['duplicate_station', 'feed_stale', 'volume_drop']);
  const d = defectsByKind(r);
  assert.equal(d.filter((x) => x.kind === 'duplicate_station').length, 1, 'duplicates become one feed-level defect');
});

test('station list: outside the service area and bad capacity are rejected', () => {
  const r = validateStations([
    { station_id: 'x', name: 'Ok', lat: 40.75, lon: -73.98, capacity: 10 },
    { station_id: 'y', name: 'Far', lat: 51.5, lon: -0.1, capacity: 10 },
    { station_id: 'z', name: 'Bad', lat: 40.75, lon: -73.98, capacity: -2 },
  ]);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.rejects.map((x) => x.reason), ['outside_service_area', 'invalid_capacity']);
});

test('trust verdict is the worst open incident', () => {
  assert.equal(trustVerdict([]).verdict, 'trusted');
  assert.equal(trustVerdict([{ id: 'INC-001', severity: 'degraded', title: 't' }]).verdict, 'caveated');
  assert.equal(trustVerdict([{ id: 'INC-001', severity: 'degraded', title: 't' }, { id: 'INC-002', severity: 'untrusted', title: 'u' }]).verdict, 'untrusted');
});
