import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { COVERAGE_LIMITS, plausibleBbox } from '../src/harvest/catalogue.js';
import { hasCredential, headersHaveCredential } from '../src/util/secrets.js';

/** Cases shared with the app (gods-eye-view vendors this file): both repos must agree on every one. */
const cases = JSON.parse(fs.readFileSync(new URL('../conformance/cases.json', import.meta.url), 'utf8'));

test('conformance: credential URLs', () => {
  for (const u of cases.credentials.flag) assert.equal(hasCredential(u), true, u);
  for (const u of cases.credentials.pass) assert.equal(hasCredential(u), false, u);
});

test('conformance: request headers', () => {
  for (const h of cases.headers.flag) assert.equal(headersHaveCredential(h), true, JSON.stringify(h));
  for (const h of cases.headers.pass) assert.equal(headersHaveCredential(h), false, JSON.stringify(h));
});

test('conformance: coverage limits and boxes', () => {
  assert.deepEqual(cases.coverage.limits, COVERAGE_LIMITS);
  for (const c of cases.coverage.pass) assert.equal(plausibleBbox(c.bbox, c.class), true, JSON.stringify(c));
  for (const c of cases.coverage.fail) assert.equal(plausibleBbox(c.bbox, c.class), false, JSON.stringify(c));
});

test('coverage class: optional, one of the shared classes; hazards publish as global', async () => {
  const { COVERAGE_CLASSES, validateEntry } = await import('../src/schema.js');
  const { buildDirectory } = await import('../src/build.js');
  const { USGS_ENTRIES } = await import('../src/harvest/usgs.js');
  assert.deepEqual([...COVERAGE_CLASSES].sort(), Object.keys(cases.coverage.limits).sort());
  const eq = USGS_ENTRIES[0];
  assert.deepEqual(validateEntry({ ...eq, coverage: { ...eq.coverage, class: 'national' } }), []);
  assert.equal(validateEntry({ ...eq, coverage: { ...eq.coverage, class: 'continental' } }).length, 1);
  const d = buildDirectory(new Map([[eq.id, eq]]), {}, 100);
  assert.equal(d.entries[0].coverage.class, 'global');
});

test('coverage class: a national box within its limit is not rebuilt', async () => {
  const { fillTransitCoverage } = await import('../src/harvest/catalogue.js');
  let fetched = 0;
  const fetchImpl = async () => {
    fetched += 1;
    return new Response('x', { status: 500 });
  };
  const amtrak = { id: 'amtrak', domain: 'transit.vehicles', access: { url: 'https://a.example/vp' }, coverage: { bbox: [27.6, -122.9, 48.9, -70.5], countries: ['US'], class: 'national' } };
  await fillTransitCoverage([amtrak], { fetchImpl });
  assert.equal(fetched, 0, 'within the national limit: nothing to repair');
  await fillTransitCoverage([{ ...amtrak, coverage: { ...amtrak.coverage, class: undefined } }], { fetchImpl });
  assert.equal(fetched, 1, 'unclassed is regional: too wide, checked');
});
