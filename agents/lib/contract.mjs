// The data contract for the Citi Bike GBFS feed. Pure functions, no I/O, unit-tested.
// Record rules are ported from our Spoke project (Supabase + Sodabase hackathon, Nov 2026);
// feed rules (freshness, volume, duplicates) are new for Signoff.

export const EARLIEST_VALID = Date.UTC(2013, 4, 1) / 1000; // Citi Bike launched 27 May 2013
export const BBOX = { minLat: 40.4, maxLat: 41.1, minLon: -74.4, maxLon: -73.6 };
export const FUTURE_SKEW_S = 300;
export const CAPACITY_TOLERANCE = 2;
export const FEED_STALE_S = 300;      // the feed's own last_updated older than 5 min
export const VOLUME_DROP = 0.8;       // fewer than 80% of the stations we expect
export const SILENT_S = 24 * 3600;    // an installed station that hasn't reported for a day

/** Human-readable name and severity of every defect kind the contract can raise. */
export const KINDS = {
  bogus_timestamp: { title: 'Stations report a last update before Citi Bike existed', scope: 'station', severity: 'degraded' },
  future_timestamp: { title: 'Stations report a last update in the future', scope: 'station', severity: 'degraded' },
  over_capacity: { title: 'Stations report more bikes and docks than they physically have', scope: 'station', severity: 'degraded' },
  silent_station: { title: 'Installed stations have not reported for over a day', scope: 'station', severity: 'degraded' },
  unknown_station: { title: 'Status for stations missing from the station list', scope: 'station', severity: 'degraded' },
  invalid_count: { title: 'Counts that are not non-negative integers', scope: 'station', severity: 'degraded' },
  ebikes_exceed_bikes: { title: 'More e-bikes than bikes at a station', scope: 'station', severity: 'degraded' },
  invalid_flag: { title: 'Station flags that are not 0 or 1', scope: 'station', severity: 'degraded' },
  duplicate_station: { title: 'The same station appears more than once in one feed', scope: 'feed', severity: 'untrusted' },
  feed_stale: { title: 'The feed has stopped updating', scope: 'feed', severity: 'untrusted' },
  volume_drop: { title: 'The feed is missing a large share of stations', scope: 'feed', severity: 'untrusted' },
  feed_unreachable: { title: 'The feed could not be fetched', scope: 'feed', severity: 'untrusted' },
};

const isCount = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const flag = (v) => (v === 1 || v === true ? true : v === 0 || v === false ? false : null);

export function validateStations(stations) {
  const rows = [], rejects = [], seen = new Set();
  for (const raw of stations || []) {
    const s = raw ?? {};
    const id = typeof s.station_id === 'string' ? s.station_id.trim() : '';
    const bad = (reason, detail) => rejects.push({ station_id: id || '(missing)', reason, detail });
    if (!id) { bad('missing_station_id', 'station_id is empty'); continue; }
    if (seen.has(id)) { bad('duplicate_station', 'station_id appears twice'); continue; }
    seen.add(id);
    const name = typeof s.name === 'string' ? s.name.trim() : '';
    const lat = Number(s.lat), lon = Number(s.lon);
    if (!name) { bad('missing_name', 'name is empty'); continue; }
    if (!(lat >= BBOX.minLat && lat <= BBOX.maxLat && lon >= BBOX.minLon && lon <= BBOX.maxLon)) {
      bad('outside_service_area', `lat ${s.lat}, lon ${s.lon} is outside the service area`); continue;
    }
    if (!isCount(s.capacity)) { bad('invalid_capacity', `capacity ${s.capacity} is not a count`); continue; }
    rows.push({ station_id: id, name, lat, lon, capacity: s.capacity, region_id: s.region_id == null ? null : String(s.region_id) });
  }
  return { rows, rejects };
}

/**
 * Check one station_status feed.
 * @returns {{rows: object[], rejects: object[], feed: object[]}} accepted rows, per-station
 *   rejects, and feed-level defects (freshness, volume, duplicates).
 */
export function validateStatus(statuses, capacities, nowS, { lastUpdated, expected } = {}) {
  const rows = [], rejects = [], feed = [], seen = new Set();
  let dupes = 0;
  for (const raw of statuses || []) {
    const s = raw ?? {};
    const id = typeof s.station_id === 'string' ? s.station_id.trim() : '';
    const bad = (reason, detail) => rejects.push({ station_id: id || '(missing)', reason, detail });
    if (!id) { bad('missing_station_id', 'station_id is empty'); continue; }
    if (seen.has(id)) { dupes++; bad('duplicate_station', 'station_id appears twice in one feed'); continue; }
    seen.add(id);
    if (!(id in capacities)) { bad('unknown_station', 'status for a station not in station_information'); continue; }
    const missing = ['num_bikes_available', 'num_docks_available'].filter((k) => !isCount(s[k]));
    if (missing.length) { bad('invalid_count', `${missing.join(', ')} not a non-negative integer`); continue; }
    const bikes = s.num_bikes_available, docks = s.num_docks_available;
    const ebikes = isCount(s.num_ebikes_available) ? s.num_ebikes_available : 0;
    const bd = isCount(s.num_bikes_disabled) ? s.num_bikes_disabled : 0;
    const dd = isCount(s.num_docks_disabled) ? s.num_docks_disabled : 0;
    if (ebikes > bikes) { bad('ebikes_exceed_bikes', `${ebikes} e-bikes but only ${bikes} bikes`); continue; }
    const installed = flag(s.is_installed), renting = flag(s.is_renting), returning = flag(s.is_returning);
    if (installed === null || renting === null || returning === null) { bad('invalid_flag', 'flags must be 0 or 1'); continue; }
    const reported = Number(s.last_reported);
    if (!Number.isFinite(reported) || reported < EARLIEST_VALID) {
      bad('bogus_timestamp', `last_reported ${s.last_reported} = ${fmtEpoch(reported)}, before Citi Bike existed`); continue;
    }
    if (reported > nowS + FUTURE_SKEW_S) { bad('future_timestamp', `last_reported is ${Math.round(reported - nowS)} s in the future`); continue; }
    const cap = capacities[id];
    const total = bikes + docks + bd + dd;
    if (installed && cap > 0 && total > cap + CAPACITY_TOLERANCE) { bad('over_capacity', `${total} bikes + docks at a ${cap}-dock station`); continue; }
    if (installed && nowS - reported > SILENT_S) { bad('silent_station', `installed but silent for ${Math.round((nowS - reported) / 3600)} h`); continue; }
    rows.push({
      station_id: id, bikes, ebikes, docks, bikes_disabled: bd, docks_disabled: dd,
      is_installed: installed ? 1 : 0, is_renting: renting ? 1 : 0, is_returning: returning ? 1 : 0,
      last_reported: reported,
    });
  }
  if (dupes) feed.push({ reason: 'duplicate_station', detail: `${dupes} station ids appear more than once in one feed`, count: dupes });
  if (lastUpdated && nowS - lastUpdated > FEED_STALE_S) {
    feed.push({ reason: 'feed_stale', detail: `feed last_updated ${Math.round((nowS - lastUpdated) / 60)} min ago`, age_s: Math.round(nowS - lastUpdated) });
  }
  const n = (statuses || []).length;
  if (expected && n < expected * VOLUME_DROP) {
    feed.push({ reason: 'volume_drop', detail: `${n} stations in the feed, expected about ${expected}`, count: n, expected });
  }
  return { rows, rejects, feed };
}

/** Group defects into incident candidates: one per kind. */
export function defectsByKind({ rejects, feed }) {
  const out = new Map();
  for (const r of rejects) {
    const k = out.get(r.reason) || { kind: r.reason, count: 0, stations: [], examples: [] };
    k.count++;
    k.stations.push(r.station_id);
    if (k.examples.length < 3) k.examples.push(r);
    out.set(r.reason, k);
  }
  for (const f of feed) out.set(f.reason, { kind: f.reason, count: f.count ?? 1, stations: [], examples: [f], feed: true });
  // A duplicate-heavy feed is a feed-level problem; keep one entry for it.
  return [...out.values()];
}

/** Worst severity across open incidents → the trust verdict the analyst gates on. */
export function trustVerdict(openIncidents) {
  if (!openIncidents.length) return { verdict: 'trusted', reasons: [] };
  const untrusted = openIncidents.filter((i) => i.severity === 'untrusted');
  return {
    verdict: untrusted.length ? 'untrusted' : 'caveated',
    reasons: openIncidents.map((i) => `${i.id}: ${i.title}`),
  };
}

export function fmtEpoch(s) {
  if (!Number.isFinite(s)) return String(s);
  return new Date(s * 1000).toISOString().slice(0, 10);
}
