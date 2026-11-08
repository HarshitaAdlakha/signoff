// Citi Bike's public GBFS feed (no key). For demos, var/inject.json can simulate the incidents
// a real feed has: a frozen feed, a duplicate load, or a partial drop. Injected runs are labelled.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

export const FEED = process.env.GBFS_BASE || 'https://gbfs.citibikenyc.com/gbfs/en';

let lastGood = null;

export function readInjection(file) {
  if (!existsSync(file)) return null;
  try {
    const x = JSON.parse(readFileSync(file, 'utf8'));
    if (!x?.mode || x.mode === 'clear') return null;
    if (x.until && Date.now() > x.until) return null;
    return x;
  } catch { return null; }
}
export function writeInjection(file, mode, minutes = 30) {
  writeFileSync(file, JSON.stringify({ mode, since: Date.now(), until: mode === 'clear' ? null : Date.now() + minutes * 60_000 }, null, 2));
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'signoff-hackathon/1.0' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

export async function fetchStationInformation() {
  const j = await getJson(`${FEED}/station_information.json`);
  return j.data.stations;
}

/** @returns {{stations: object[], lastUpdated: number, injected: string|null}} */
export async function fetchStationStatus(injectFile) {
  const inj = injectFile ? readInjection(injectFile) : null;
  if (inj?.mode === 'stale' && lastGood) {
    // The feed "freezes": same payload, same last_updated, as when a vendor's publisher hangs.
    const frozenAt = Math.floor((inj.since || Date.now()) / 1000) - 360;
    return { stations: lastGood.stations, lastUpdated: Math.min(lastGood.lastUpdated, frozenAt), injected: 'stale' };
  }
  const j = await getJson(`${FEED}/station_status.json`);
  let stations = j.data.stations;
  const out = { stations, lastUpdated: j.last_updated, injected: null };
  if (!inj) { lastGood = out; return out; }
  if (inj.mode === 'dupes') {
    // A double load: 12% of the stations appear twice, the copy with older counts.
    const extra = stations.filter((_, i) => i % 8 === 0).map((s) => ({ ...s, num_bikes_available: Math.max(0, s.num_bikes_available - 3), last_reported: s.last_reported - 600 }));
    stations = [...stations, ...extra];
  } else if (inj.mode === 'drop') {
    stations = stations.filter((_, i) => i % 5 >= 2); // 40% of stations go missing
  }
  return { stations, lastUpdated: j.last_updated, injected: inj.mode };
}
