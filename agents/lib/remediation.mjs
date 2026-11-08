// What the fixer can propose for each kind of incident. Every option is a standing rule:
// the watcher applies it on every later run, and nothing is ever deleted.
// Option A is the recommendation; the data owner can pick B instead ("approve INC-004 B").

export const OPTIONS = {
  bogus_timestamp: [
    { key: 'A', action: 'exclude', summary: 'Keep these stations out of dispatch until they report a real timestamp',
      why: 'A 1970 timestamp means we cannot tell how old the counts are. Excluding is reversible: a station is re-admitted the first minute it reports a valid time.' },
    { key: 'B', action: 'trust_counts', summary: 'Admit the counts and treat them as reported now',
      why: 'Keeps every station on the map, but a truck may be sent on counts of unknown age.' },
  ],
  over_capacity: [
    { key: 'A', action: 'exclude', summary: 'Keep these stations out of dispatch until their counts fit their capacity',
      why: 'Counts larger than the dock are physically impossible, so neither the bikes nor the docks figure can be trusted.' },
    { key: 'B', action: 'clamp', summary: 'Admit them with bikes and docks clamped to capacity',
      why: 'Keeps the stations visible, but the clamped numbers are a guess.' },
  ],
  silent_station: [
    { key: 'A', action: 'exclude', summary: 'Keep stations that have been silent for a day out of dispatch',
      why: 'An installed station that has not reported for 24 h is usually offline; its counts are a day old.' },
  ],
  unknown_station: [
    { key: 'A', action: 'exclude', summary: 'Hold status for stations missing from the station list until the list refreshes', why: 'We cannot place them on the map.' },
  ],
  invalid_count: [{ key: 'A', action: 'exclude', summary: 'Hold stations with invalid counts', why: 'The counts are not numbers we can use.' }],
  ebikes_exceed_bikes: [{ key: 'A', action: 'exclude', summary: 'Hold stations reporting more e-bikes than bikes', why: 'The two counts contradict each other.' }],
  invalid_flag: [{ key: 'A', action: 'exclude', summary: 'Hold stations with invalid flags', why: 'We cannot tell whether they are renting.' }],
  duplicate_station: [
    { key: 'A', action: 'dedupe_latest', summary: 'Keep the most recent report for each station and drop the older copies',
      why: 'A double load repeats stations with older counts; the newest report is the real one.' },
    { key: 'B', action: 'reject_feed', summary: 'Reject any feed that repeats a station until the vendor fixes it',
      why: 'Safest, but dispatch is blind until then.' },
  ],
  feed_stale: [
    { key: 'A', action: 'serve_last_good', params: { max_age_min: 30 }, summary: 'Answer from the last good data, stating its age, for up to 30 minutes',
      why: 'Station counts drift slowly; for half an hour, last-known counts with their age stated are better than nothing. After 30 minutes the analyst refuses.' },
    { key: 'B', action: 'pause', summary: 'Pause dispatch answers until the feed recovers', why: 'No risk of acting on old data, but the desk is blind.' },
  ],
  volume_drop: [
    { key: 'A', action: 'accept_partial', summary: 'Use the stations that did report, and mark the missing ones unknown',
      why: 'The reported stations are still valid; the missing ones are left out rather than shown with old counts.' },
    { key: 'B', action: 'pause', summary: 'Pause dispatch answers until the feed is complete', why: 'Avoids sending trucks based on half a map.' },
  ],
  feed_unreachable: [
    { key: 'A', action: 'serve_last_good', params: { max_age_min: 30 }, summary: 'Answer from the last good data, stating its age, for up to 30 minutes', why: 'Same as a frozen feed.' },
  ],
};

export const optionFor = (kind, key = 'A') => (OPTIONS[kind] || []).find((o) => o.key === String(key).toUpperCase()) || null;

/** What approving an option would change, computed against the warehouse without writing anything. */
export function preview(wh, incident, option) {
  const ids = incident.evidence?.stations || [];
  const st = ids.length ? wh.db.prepare(`select station_id, name, lat, lon, capacity from stations where station_id in (${ids.map(() => '?').join(',')})`).all(...ids) : [];
  const manhattanCore = st.filter((s) => s.lat > 40.70 && s.lat < 40.80 && s.lon > -74.02 && s.lon < -73.93).length;
  const lines = [];
  switch (option.action) {
    case 'exclude':
      lines.push(`${ids.length} stations stay out of the dispatch view (${manhattanCore} of them in Manhattan below 96 St).`);
      lines.push('Re-admitted automatically the first minute they pass the contract again. Nothing is deleted.');
      break;
    case 'trust_counts':
      lines.push(`${ids.length} stations are admitted with counts of unknown age.`);
      break;
    case 'clamp':
      lines.push(`${ids.length} stations are admitted with bikes and docks clamped to their capacity, flagged as clamped in every answer.`);
      break;
    case 'dedupe_latest':
      lines.push(`${incident.count} repeated station reports are dropped; the newest report per station is kept.`);
      break;
    case 'reject_feed':
      lines.push('Every feed that repeats a station is rejected; dispatch keeps the last good data and its age.');
      break;
    case 'serve_last_good': {
      const age = Math.round((Date.now() / 1000 - (wh.lastGoodAt() || 0)) / 60);
      lines.push(`The analyst answers from data last updated ${age} min ago, says so in every answer, and refuses after ${option.params.max_age_min} min.`);
      break;
    }
    case 'pause':
      lines.push('The analyst refuses every dispatch question until the incident closes.');
      break;
    case 'accept_partial':
      lines.push(`Stations missing from the feed are marked unknown and left out of answers (about ${incident.evidence?.expected - incident.evidence?.count || '?'} stations).`);
      break;
  }
  return lines;
}

export const FEED_LEVEL = new Set(['duplicate_station', 'feed_stale', 'volume_drop', 'feed_unreachable']);
