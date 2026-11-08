import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The live app (docs/live) must run exactly the code the agents run. `npm run sync-web` copies it.
test('the live app runs the same contract, remediation, gate and places code as the agents', () => {
  for (const f of ['contract.mjs', 'remediation.mjs', 'dispatch.mjs', 'places.mjs']) {
    const original = readFileSync(new URL(`../agents/lib/${f}`, import.meta.url), 'utf8');
    const copy = readFileSync(new URL(`../docs/live/lib/${f}`, import.meta.url), 'utf8');
    assert.equal(copy.slice(copy.indexOf('\n') + 1), original, `${f} is out of date: run npm run sync-web`);
  }
});
