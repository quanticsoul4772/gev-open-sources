import assert from 'node:assert/strict';
import test from 'node:test';
import { PbfWriter } from 'pbf';
import * as adapters from '../src/adapters/index.js';
import { mergeCandidates } from '../src/harvest/index.js';
import { PERIMETER_ENTRIES } from '../src/harvest/perimeters.js';
import { probeEntry, probeRounds, retireDuplicates, takeFingerprints } from '../src/probe.js';

const { ADAPTERS, vehicleFingerprint } = adapters;

/** GTFS-RT FeedMessage bytes with one vehicle position per id. */
function feedBytes(ids) {
  const pbf = new PbfWriter();
  pbf.writeMessage(1, (_, w) => w.writeStringField(1, '2.0'));
  ids.forEach((id, i) =>
    pbf.writeMessage(2, (_, w) => {
      w.writeStringField(1, `e${i}`);
      w.writeMessage(4, (__, v) => {
        v.writeMessage(2, (___, p) => {
          p.writeFloatField(1, 49.6 + i / 100);
          p.writeFloatField(2, -1.6 + i / 100);
        });
        v.writeMessage(8, (___, d) => d.writeStringField(1, id));
      });
    }),
  );
  return pbf.finish();
}

const decode = (ids) => ADAPTERS['gtfs-rt.vehicle-positions'](feedBytes(ids), null);
const gtfs = { id: 'g', format: 'gtfs-rt.vehicle-positions', coverage: { bbox: null }, access: { url: 'https://g.example/vp', headers: {}, redirectHosts: [], unzip: null } };
const COTENTIN = [49.4, -1.9, 49.7, -1.2];
const VILNIUS = [54.6, 25.1, 54.8, 25.4];
const entry = (id, { display = true, bbox = COTENTIN } = {}) => ({
  id,
  provenance: [`mobilitydatabase:${id}`],
  coverage: { bbox },
  access: { url: `https://${id}.example/vp`, min_interval_s: 15 },
  licence: { display },
});
/** `n` vehicle ids from `from`: `bus-<from>` … */
const fleet = (n, from = 0) => Array.from({ length: n }, (_, i) => `bus-${from + i}`);

/**
 * One probe run, as probeAll runs it: an entry listed in `vehicles` passes
 * with the fingerprint of those ids; any other entry's probe fails.
 */
async function run(entries, health, tombstones, vehicles, now) {
  const previous = takeFingerprints(health);
  await probeRounds([...entries.values()], health, {
    probe: async (e, at) =>
      vehicles[e.id] ? { at, result: 'ok', records: vehicles[e.id].length, fingerprint: vehicleFingerprint(vehicles[e.id]) } : { at, result: 'http', code: 500 },
    clock: () => now,
    sleep: async () => {},
  });
  return retireDuplicates(health, previous, entries, tombstones, now);
}

test('fingerprint: the same vehicle ids in any order match; another set does not', () => {
  const ids = fleet(40);
  const a = decode(ids).fingerprint;
  assert.equal(decode([...ids].reverse()).fingerprint, a);
  assert.equal(adapters.fingerprintSimilarity(a, a), 1);
  assert.ok(adapters.fingerprintSimilarity(a, decode(fleet(40, 100)).fingerprint) < 0.2, 'no ids in common');
});

test('fingerprint: none under 5 distinct vehicles; the probe passes one on from 5', async () => {
  assert.equal(decode(['a', 'b', 'c', 'd', 'd']).fingerprint, null, 'a repeated id counts once');
  const now = 1_700_000_000;
  const answer = (ids) => async () => new Response(feedBytes(ids));
  const four = await probeEntry(gtfs, { now, fetchImpl: answer(['a', 'b', 'c', 'd']) });
  assert.equal(four.result, 'ok');
  assert.equal('fingerprint' in four, false);
  const five = await probeEntry(gtfs, { now, fetchImpl: answer(['a', 'b', 'c', 'd', 'e']) });
  assert.equal(five.fingerprint, decode(['e', 'd', 'c', 'b', 'a']).fingerprint);
});

test('duplicates: a match in one run retires nothing; two runs in a row retire the newer copy', async () => {
  const entries = new Map([['old', entry('old')], ['new', entry('new')], ['other', entry('other')]]);
  const health = {};
  const tombstones = {};
  assert.deepEqual(await run(entries, health, tombstones, { old: fleet(40), new: fleet(40), other: fleet(40, 100) }, 1000), []);
  assert.deepEqual(tombstones, {});
  assert.equal(health.old.fingerprint, vehicleFingerprint(fleet(40)));
  assert.ok(health.old.history.every((p) => !('fingerprint' in p)), 'not stored in history');
  health.new.firstSeen = 500;
  health.old.firstSeen = 100;
  // Another set of vehicles out the next run: the ids still match each other.
  const retired = await run(entries, health, tombstones, { old: fleet(40, 50), new: fleet(40, 50), other: fleet(40, 50) }, 2000);
  assert.deepEqual(retired, ['new'], 'other matched only this run');
  assert.deepEqual(tombstones, { new: { url: 'https://new.example/vp', at: 2000, reason: 'duplicate', of: 'old' } });
  assert.equal(health.new, undefined);
  assert.ok(health.old && health.other);
});

test('duplicates: copies probed seconds apart match although a few vehicles joined or left', async () => {
  const entries = new Map([['a', entry('a')], ['b', entry('b')]]);
  const health = {};
  const tombstones = {};
  // 38 of 42 ids shared (Jaccard 0.90) in each run.
  assert.deepEqual(await run(entries, health, tombstones, { a: fleet(40), b: fleet(40, 2) }, 1000), []);
  assert.deepEqual(await run(entries, health, tombstones, { a: fleet(40, 10), b: [...fleet(38, 10), 'late-1', 'late-2'] }, 2000), ['b']);
  assert.equal(tombstones.b.of, 'a');
});

test('duplicates: a feed carrying most of another\'s fleet plus more vehicles is not a copy', async () => {
  const entries = new Map([['region', entry('region')], ['city', entry('city')], ['copy', entry('copy')]]);
  const health = {};
  const tombstones = {};
  // Region and city share 40 of 46 ids (Jaccard 0.87), but 40 vehicles against 46;
  // city and its copy, probed a little later, 38 of 42.
  const runOf = (from) => ({
    region: [...fleet(40, from), ...fleet(6, 1000 + from)],
    city: fleet(40, from),
    copy: [...fleet(38, from), 'late-1', 'late-2'],
  });
  await run(entries, health, tombstones, runOf(0), 1000);
  health.copy.firstSeen = 1500;
  assert.deepEqual(await run(entries, health, tombstones, runOf(10), 2000), ['copy']);
  assert.equal(tombstones.copy.of, 'city');
});

test('duplicates: identical ids 1..N in areas that don\'t overlap are different feeds', async () => {
  const numbers = Array.from({ length: 30 }, (_, i) => String(i + 1));
  const entries = new Map([['cotentin', entry('cotentin')], ['copy', entry('copy')], ['vilnius', entry('vilnius', { bbox: VILNIUS })]]);
  const health = {};
  const tombstones = {};
  const all = { cotentin: numbers, copy: numbers, vilnius: numbers };
  await run(entries, health, tombstones, all, 1000);
  health.copy.firstSeen = 1500;
  assert.deepEqual(await run(entries, health, tombstones, all, 2000), ['copy']);
  assert.equal(tombstones.copy.of, 'cotentin');
  assert.ok(health.vilnius);
});

test('duplicates: a gap run without a match starts the count again', async () => {
  const entries = new Map([['a', entry('a')], ['b', entry('b')]]);
  const health = {};
  const tombstones = {};
  await run(entries, health, tombstones, { a: fleet(40), b: fleet(40) }, 1000);
  assert.deepEqual(await run(entries, health, tombstones, { a: fleet(40), b: fleet(4) }, 2000), [], 'b under 5 vehicles');
  assert.deepEqual(await run(entries, health, tombstones, { a: fleet(40), b: fleet(40) }, 3000), []);
  assert.deepEqual(await run(entries, health, tombstones, { a: fleet(40), b: fleet(40) }, 4000), ['b']);
});

test('duplicates: a failed probe drops the fingerprint, so the next run starts the count again', async () => {
  const entries = new Map([['a', entry('a')], ['b', entry('b')]]);
  const health = {};
  const tombstones = {};
  const similar = (from) => ({ a: fleet(40, from), b: fleet(40, from + 1) });
  await run(entries, health, tombstones, similar(0), 1000);
  assert.deepEqual(await run(entries, health, tombstones, { a: fleet(40, 10) }, 2000), [], 'b failed');
  assert.equal(health.b.fingerprint, undefined);
  assert.deepEqual(await run(entries, health, tombstones, similar(20), 3000), []);
  assert.deepEqual(await run(entries, health, tombstones, similar(30), 4000), ['b']);
});

test('duplicates: different last run, similar this run → not yet; similar again → retired', async () => {
  const entries = new Map([['a', entry('a')], ['b', entry('b')]]);
  const health = {};
  const tombstones = {};
  await run(entries, health, tombstones, { a: fleet(40), b: fleet(40, 100) }, 1000);
  assert.deepEqual(await run(entries, health, tombstones, { a: fleet(40, 10), b: fleet(40, 11) }, 2000), []);
  assert.deepEqual(await run(entries, health, tombstones, { a: fleet(40, 20), b: fleet(40, 21) }, 3000), ['b']);
});

test('duplicates: the copy cleared for display is kept over an older referral-only one', async () => {
  const entries = new Map([['referral', entry('referral', { display: false })], ['shown', entry('shown')]]);
  const health = {};
  const tombstones = {};
  await run(entries, health, tombstones, { referral: fleet(40), shown: fleet(40) }, 1000);
  health.referral.firstSeen = 10;
  health.shown.firstSeen = 900;
  assert.deepEqual(await run(entries, health, tombstones, { referral: fleet(40), shown: fleet(40) }, 2000), ['referral']);
  assert.equal(tombstones.referral.of, 'shown');
});

test('duplicates: a hand-written entry is never retired; the harvested copy goes', async () => {
  const hand = PERIMETER_ENTRIES[0];
  const harvested = entry('harvested', { bbox: hand.coverage.bbox });
  const entries = new Map([[hand.id, hand], [harvested.id, harvested]]);
  const health = {};
  const tombstones = {};
  await run(entries, health, tombstones, { [hand.id]: fleet(40), harvested: fleet(40) }, 1000);
  health.harvested.firstSeen = 1;
  assert.deepEqual(await run(entries, health, tombstones, { [hand.id]: fleet(40), harvested: fleet(40) }, 2000), ['harvested']);
  assert.equal(tombstones.harvested.of, hand.id);
  assert.ok(health[hand.id]);
});

test('duplicates: a retired copy is not re-added by discovery, under its own id or another catalogue\'s', async () => {
  const entries = new Map([['kept', entry('kept')], ['copy', entry('copy')]]);
  const health = {};
  const tombstones = {};
  await run(entries, health, tombstones, { kept: fleet(40), copy: fleet(40) }, 1000);
  health.copy.firstSeen = 1500;
  assert.deepEqual(await run(entries, health, tombstones, { kept: fleet(40), copy: fleet(40) }, 2000), ['copy']);
  entries.delete('copy');
  const relisted = { ...entry('copy'), id: 'transitous-copy' };
  assert.deepEqual(mergeCandidates(entries, [entry('copy'), relisted, entry('fresh')], tombstones).map((e) => e.id), ['fresh']);
  // A dead feed's tombstone blocks only its id: the URL may come back working under another.
  const dead = { copy: { url: entry('copy').access.url, at: 2000 } };
  assert.deepEqual(mergeCandidates(entries, [relisted], dead).map((e) => e.id), ['transitous-copy']);
});

test('duplicates: a retired copy\'s URL is free again once the entry it duplicated is gone', () => {
  const tombstones = { copy: { url: entry('copy').access.url, at: 2000, reason: 'duplicate', of: 'kept' } };
  const relisted = { ...entry('copy'), id: 'transitous-copy' };
  assert.deepEqual(mergeCandidates(new Map([['kept', entry('kept')]]), [relisted], tombstones), []);
  assert.deepEqual(mergeCandidates(new Map(), [relisted], tombstones).map((e) => e.id), ['transitous-copy']);
});
