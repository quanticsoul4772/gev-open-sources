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
