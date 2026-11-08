// One ingest cycle: fetch → contract → standing rules → one transaction.
// Returns the defects no rule handles; those are what the watcher turns into incidents.
import { validateStations, validateStatus, defectsByKind, KINDS } from './contract.mjs';
import { fetchStationInformation, fetchStationStatus } from './gbfs.mjs';

export async function refreshStations(wh) {
  const raw = await fetchStationInformation();
  const { rows, rejects } = validateStations(raw);
  wh.upsertStations(rows);
  return { stations: rows.length, rejected: rejects.length };
}

/** Keep the newest report per station (the fixer's dedupe rule). */
export function dedupeLatest(stations) {
  const best = new Map();
  for (const s of stations) {
    const prev = best.get(s.station_id);
    if (!prev || Number(s.last_reported) > Number(prev.last_reported)) best.set(s.station_id, s);
  }
  return [...best.values()];
}

export async function ingestOnce(wh, { injectFile, expected } = {}) {
  if (wh.stationCount() === 0) await refreshStations(wh);
  const nowS = Math.floor(Date.now() / 1000);
  const rules = wh.rules();
  let feed;
  try {
    feed = await fetchStationStatus(injectFile);
  } catch (e) {
    const run = { rows_in: 0, accepted: 0, rejected: 0, handled: 0, feed: [{ reason: 'feed_unreachable' }], status: 'failed', note: e.message };
    wh.applyStatus({ rows: [], quarantined: [], run });
    return { run, defects: [{ kind: 'feed_unreachable', count: 1, stations: [], examples: [{ detail: e.message }], feed: true }], handled: [] };
  }
  let stations = feed.stations;
  if (rules.duplicate_station?.action === 'dedupe_latest') stations = dedupeLatest(stations);
  const exp = expected ?? Math.max(wh.stationCount() - 60, 0);
  const result = validateStatus(stations, wh.capacities(), nowS, { lastUpdated: feed.lastUpdated, expected: exp });

  const rows = [...result.rows];
  const quarantined = [];
  const handled = new Map();
  const unhandled = [];
  for (const r of result.rejects) {
    const rule = rules[r.reason];
    if (rule?.action === 'clamp' && r.reason === 'over_capacity') {
      const raw = stations.find((s) => s.station_id === r.station_id);
      const cap = wh.capacities()[r.station_id];
      const bikes = Math.min(raw.num_bikes_available, cap);
      rows.push({ station_id: r.station_id, bikes, ebikes: Math.min(raw.num_ebikes_available || 0, bikes),
        docks: Math.max(0, Math.min(raw.num_docks_available, cap - bikes)), bikes_disabled: 0, docks_disabled: 0,
        is_installed: 1, is_renting: raw.is_renting ? 1 : 0, is_returning: raw.is_returning ? 1 : 0,
        last_reported: Number(raw.last_reported), clamped: true });
      handled.set(r.reason, (handled.get(r.reason) || 0) + 1);
    } else if (rule?.action === 'trust_counts' && r.reason === 'bogus_timestamp') {
      const raw = stations.find((s) => s.station_id === r.station_id);
      rows.push({ station_id: r.station_id, bikes: raw.num_bikes_available, ebikes: Math.min(raw.num_ebikes_available || 0, raw.num_bikes_available),
        docks: raw.num_docks_available, bikes_disabled: raw.num_bikes_disabled || 0, docks_disabled: raw.num_docks_disabled || 0,
        is_installed: raw.is_installed ? 1 : 0, is_renting: raw.is_renting ? 1 : 0, is_returning: raw.is_returning ? 1 : 0,
        last_reported: nowS, clamped: true });
      handled.set(r.reason, (handled.get(r.reason) || 0) + 1);
    } else {
      quarantined.push({ ...r, rule: rule ? `${rule.action} (${rule.incident_id})` : null, incident_id: wh.openIncidentFor(r.reason)?.id });
      if (rule) handled.set(r.reason, (handled.get(r.reason) || 0) + 1);
    }
  }
  // A rejected feed (fixer's reject_feed rule) is not applied at all.
  const rejectFeed = rules.duplicate_station?.action === 'reject_feed' && result.feed.some((f) => f.reason === 'duplicate_station');
  const stale = result.feed.some((f) => f.reason === 'feed_stale');
  const applyRows = rejectFeed || stale ? [] : rows;

  for (const d of defectsByKind({ rejects: result.rejects, feed: result.feed })) {
    const rule = rules[d.kind];
    const ruleCovers = rule && !(d.feed && ['feed_stale', 'volume_drop', 'feed_unreachable'].includes(d.kind));
    if (ruleCovers) continue;
    if (d.kind === 'duplicate_station' && !d.feed) continue; // reported once, at feed level
    unhandled.push({ ...d, ...KINDS[d.kind] });
  }
  const accepted = applyRows.length;
  const run = {
    rows_in: feed.stations.length, accepted, rejected: result.rejects.length,
    handled: [...handled.values()].reduce((a, b) => a + b, 0), feed: result.feed,
    status: stale || rejectFeed ? 'partial' : result.rejects.length > feed.stations.length * 0.1 ? 'partial' : 'ok',
    note: result.feed.map((f) => f.detail).join('; ') || null, injected: feed.injected,
  };
  run.id = wh.applyStatus({ rows: applyRows, quarantined, run });
  return { run, defects: unhandled, handled: [...handled.entries()], feedLastUpdated: feed.lastUpdated };
}
