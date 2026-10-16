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

test('coverage class: optional, one of the shared classes; hazards default to global', async () => {
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

test('consumer report: boxes over their class limit, and wide entries without a class', async () => {
  const { consumerReport, reportMarkdown } = await import('../src/consumer-report.js');
  const e = (id, bbox, cls) => ({ id, domain: 'transit.vehicles', coverage: { bbox, countries: [], ...(cls ? { class: cls } : {}) } });
  const published = [
    e('city', [48.8, 2.2, 48.9, 2.5]),
    e('amtrak', [27.6, -122.9, 48.9, -70.5], 'national'),
    e('wide', [47.26, 4.51, 78.25, 31.11]),
    e('too-wide-national', [-36.1, -122.9, 66.5, 152.6], 'national'),
    e('none', null),
  ];
  const entries = new Map(published.map((p) => [p.id, p]));
  const r = consumerReport(published, entries);
  assert.deepEqual(r.overLimit.map((x) => x.id), ['wide', 'too-wide-national']);
  assert.deepEqual(r.wideUnclassed.map((x) => x.id), ['wide']);
  const md = reportMarkdown(r);
  assert.match(md, /Boxes over their class limit:\*\* 2/);
  assert.match(md, /\| wide \| transit\.vehicles \| 31\.0° × 26\.6° \|/);
});
