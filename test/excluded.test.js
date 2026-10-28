import assert from 'node:assert/strict';
import test from 'node:test';
import { EXCLUDED_FILE, excludedReason, parseExcluded, readExcluded } from '../src/harvest/excluded.js';
import { dropExcluded, duplicateUrlsOf, knownUrlsOf, mergeCandidates, releaseDuplicates, releaseUnlisted } from '../src/harvest/index.js';
import { emptyHealth } from '../src/health.js';

const entry = (id, url, { gbfs, via } = {}) => ({
  id,
  provenance: via ? [`atlas:${id}`, `via:${via}`] : [`atlas:${id}`],
  access: { url, ...(gbfs ? { related: { gbfs } } : {}) },
});

test('never-list: the committed file parses', () => {
  assert.doesNotThrow(() => readExcluded(EXCLUDED_FILE));
});

test('never-list: a malformed item stops the run', () => {
  assert.throws(() => parseExcluded({}), /expected an array/);
  assert.throws(() => parseExcluded([{ url: 'https://a.example/vp' }]), /reason is required/);
  assert.throws(() => parseExcluded([{ id: 'a', reason: 'operator request' }]), /url must be/);
  assert.throws(() => parseExcluded([{ id: '', url: 'https://a.example/vp', reason: 'x' }]), /id must be/);
  assert.throws(() => parseExcluded([{ url: 'ftp://x.example/vp', reason: 'x' }]), /url must be/);
});

test('never-list: matches by id, by URL over either scheme, by GBFS system and by permalink', () => {
  const excluded = parseExcluded([
    { id: 'atlas-gone', url: 'https://gone.example/vp', reason: 'operator request' },
    { url: 'http://feed.example:80/vp/', reason: 'operator request' },
    { url: 'https://bikes.example/gbfs.json', reason: 'operator request' },
    { url: 'https://permalink.example/vp', reason: 'operator request' },
  ]);
  assert.equal(excludedReason(entry('atlas-gone', 'https://other.example/vp'), excluded), 'operator request');
  assert.equal(excludedReason(entry('x', 'https://feed.example/vp'), excluded), 'operator request');
  assert.equal(excludedReason(entry('y', 'https://bikes.example/en/station_status.json', { gbfs: 'https://bikes.example/gbfs.json' }), excluded), 'operator request');
  assert.equal(excludedReason(entry('z', 'https://final.example/vp', { via: 'https://permalink.example/vp' }), excluded), 'operator request');
  assert.equal(excludedReason(entry('ok', 'https://feed.example/other'), excluded), null);
});

test('never-list: entries already in the directory are removed and tombstoned', () => {
  const excluded = parseExcluded([{ url: 'https://gone.example/vp', reason: 'operator request' }]);
  const existing = new Map([
    ['gone', entry('gone', 'https://gone.example/vp')],
    ['kept', entry('kept', 'https://kept.example/vp')],
  ]);
  const tombstones = {};
  const removed = [];
  assert.deepEqual(dropExcluded(existing, excluded, tombstones, 5, (id) => removed.push(id)), [['gone', 'operator request']]);
  assert.deepEqual(removed, ['gone']);
  assert.deepEqual([...existing.keys()], ['kept']);
  assert.deepEqual(tombstones, { gone: { url: 'https://gone.example/vp', gbfs: null, via: [], at: 5, reason: 'excluded' } });
  // The id stays out under any URL.
  assert.deepEqual(mergeCandidates(existing, [entry('gone', 'https://elsewhere.example/vp')], tombstones), []);
});

test('never-list: an entry the list no longer names is released, and its copies with it', () => {
  const listed = parseExcluded([
    { url: 'https://bikes.example/gbfs.json', reason: 'operator request' },
    { url: 'https://permalink.example/vp', reason: 'operator request' },
  ]);
  const existing = new Map([
    ['station', entry('station', 'https://bikes.example/en/station_status.json', { gbfs: 'https://bikes.example/gbfs.json' })],
    ['moved', entry('moved', 'https://final.example/vp', { via: 'https://permalink.example/vp' })],
    ['other', entry('other', 'https://other.example/vp')],
  ]);
  const tombstones = { copy: { reason: 'duplicate', of: 'moved', url: 'https://copy.example/vp', at: 1 } };
  dropExcluded(existing, listed, tombstones, 5, () => {});
  // Still listed (by GBFS discovery URL and by permalink): nothing is released.
  assert.deepEqual(releaseUnlisted(tombstones, listed), []);
  // The items are deleted from the list: both entries and then the copy come back.
  const empty = parseExcluded([]);
  assert.deepEqual(releaseUnlisted(tombstones, empty).sort(), ['moved', 'station']);
  assert.deepEqual(releaseDuplicates({}, existing, tombstones, empty), ['copy']);
  assert.deepEqual(tombstones, {});
});

test('never-list: copies of an entry removed by URL alone stay out with it', () => {
  const excluded = parseExcluded([{ url: 'https://listed.example/vp', reason: 'operator request' }]);
  const existing = new Map([['listed', entry('listed', 'https://listed.example/vp')]]);
  const tombstones = { copy: { reason: 'duplicate', of: 'listed', url: 'https://copy.example/vp', at: 1 } };
  dropExcluded(existing, excluded, tombstones, 5, () => {});
  // The probe drops the removed entry's health; its copy must not be released.
  assert.deepEqual(releaseDuplicates({}, existing, tombstones, excluded), []);
  assert.deepEqual(releaseDuplicates({}, existing, tombstones), [], 'also where the never-list is not passed');
  assert.ok(duplicateUrlsOf(existing, tombstones).has('https://copy.example/vp'));
});

test('never-list: discovery skips listed feeds and catalogue checks treat their URLs as known', () => {
  const excluded = parseExcluded([{ url: 'https://feed.example/vp', reason: 'operator request' }]);
  const added = mergeCandidates(new Map(), [entry('listed', 'http://feed.example/vp'), entry('fresh', 'https://fresh.example/vp')], {}, excluded);
  assert.deepEqual(added.map((e) => e.id), ['fresh']);
  const known = knownUrlsOf(new Map(), {}, excluded);
  assert.ok(known.has('https://feed.example/vp'));
  assert.ok(known.has('http://feed.example/vp'));
});

test('never-list: copies retired as duplicates of a listed entry stay out with it', () => {
  const excluded = parseExcluded([{ id: 'listed', url: 'https://listed.example/vp', reason: 'operator request' }]);
  const tombstones = { copy: { reason: 'duplicate', of: 'listed', url: 'https://copy.example/vp', at: 1 } };
  // The listed entry is gone from the directory and from the probe's health.
  assert.deepEqual(releaseDuplicates({}, new Map(), { ...tombstones }, excluded), []);
  assert.ok(duplicateUrlsOf(new Map(), tombstones, excluded).has('https://copy.example/vp'));
  assert.deepEqual(mergeCandidates(new Map(), [entry('atlas-copy', 'https://copy.example/vp')], tombstones, excluded), []);
  // Without the never-list the copy is released, as before.
  assert.deepEqual(releaseDuplicates({ other: emptyHealth(1) }, new Map(), { ...tombstones }), ['copy']);
});
