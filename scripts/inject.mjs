// Simulate a real-world feed failure on top of the live data, for a demo:
//   npm run inject -- stale   the feed freezes (same payload, old last_updated)
//   npm run inject -- dupes   a double load repeats 12% of stations with older counts
//   npm run inject -- drop    40% of stations go missing
//   npm run inject -- clear   back to the plain live feed
// Every run made while an injection is active is labelled in ingest_runs and in the incident.
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { writeInjection } from '../agents/lib/gbfs.mjs';

const mode = process.argv[2];
const minutes = Number(process.argv[3] || 30);
if (!['stale', 'dupes', 'drop', 'clear'].includes(mode)) { console.error('usage: npm run inject -- stale|dupes|drop|clear [minutes]'); process.exit(1); }
const root = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(`${root}var`, { recursive: true });
writeInjection(`${root}var/inject.json`, mode, minutes);
console.log(mode === 'clear' ? 'Injection cleared: the watcher reads the plain live feed on its next run.' : `Injected "${mode}" for ${minutes} min. The watcher picks it up on its next run (within a minute).`);
