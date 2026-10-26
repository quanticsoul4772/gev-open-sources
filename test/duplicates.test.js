import assert from 'node:assert/strict';
import test from 'node:test';
import { PbfWriter } from 'pbf';
import { ADAPTERS } from '../src/adapters/index.js';
import { mergeCandidates } from '../src/harvest/index.js';
import { PERIMETER_ENTRIES } from '../src/harvest/perimeters.js';
import { probeEntry, probeRounds, retireDuplicates, takeFingerprints } from '../src/probe.js';

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
const entry = (id, { display = true } = {}) => ({
  id,
  provenance: [`mobilitydatabase:${id}`],
  access: { url: `https://${id}.example/vp`, min_interval_s: 15 },
  licence: { display },
});

/** One probe run, as probeAll runs it: every entry passes with the given fingerprint. */
async function run(entries, health, tombstones, fingerprints, now) {
  const previous = takeFingerprints(health);
  await probeRounds([...entries.values()], health, {
    probe: async (e, at) => ({ at, result: 'ok', records: 9, ...(fingerprints[e.id] ? { fingerprint: fingerprints[e.id] } : {}) }),
    clock: () => now,
    sleep: async () => {},
  });
  return retireDuplicates(health, previous, entries, tombstones, now);
}

test('fingerprint: the same vehicle ids in any order match; another set does not', () => {
  const ids = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
  const a = decode(ids).fingerprint;
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(decode([...ids].reverse()).fingerprint, a);
  assert.notEqual(decode([...ids.slice(1), 'b7']).fingerprint, a);
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
  assert.deepEqual(await run(entries, health, tombstones, { old: 'f1', new: 'f1', other: 'f9' }, 1000), []);
  assert.deepEqual(tombstones, {});
  assert.equal(health.old.fingerprint, 'f1');
  assert.ok(health.old.history.every((p) => !('fingerprint' in p)), 'not stored in history');
  health.new.firstSeen = 500;
  health.old.firstSeen = 100;
  // Another set of vehicles out the next run: the ids still match each other.
  const retired = await run(entries, health, tombstones, { old: 'f2', new: 'f2', other: 'f2' }, 2000);
  assert.deepEqual(retired, ['new'], 'other matched only this run');
  assert.deepEqual(tombstones, { new: { url: 'https://new.example/vp', at: 2000, reason: 'duplicate', of: 'old' } });
  assert.equal(health.new, undefined);
  assert.ok(health.old && health.other);
});

test('duplicates: a gap run without a match starts the count again', async () => {
  const entries = new Map([['a', entry('a')], ['b', entry('b')]]);
  const health = {};
  const tombstones = {};
  await run(entries, health, tombstones, { a: 'f1', b: 'f1' }, 1000);
  assert.deepEqual(await run(entries, health, tombstones, { a: 'f2' }, 2000), [], 'b had no fingerprint');
  assert.deepEqual(await run(entries, health, tombstones, { a: 'f3', b: 'f3' }, 3000), []);
  assert.deepEqual(await run(entries, health, tombstones, { a: 'f4', b: 'f4' }, 4000), ['b']);
});

test('duplicates: the copy cleared for display is kept over an older referral-only one', async () => {
  const entries = new Map([['referral', entry('referral', { display: false })], ['shown', entry('shown')]]);
  const health = {};
  const tombstones = {};
  await run(entries, health, tombstones, { referral: 'f1', shown: 'f1' }, 1000);
  health.referral.firstSeen = 10;
  health.shown.firstSeen = 900;
  assert.deepEqual(await run(entries, health, tombstones, { referral: 'f2', shown: 'f2' }, 2000), ['referral']);
  assert.equal(tombstones.referral.of, 'shown');
});

test('duplicates: a hand-written entry is never retired; the harvested copy goes', async () => {
  const hand = PERIMETER_ENTRIES[0];
  const harvested = entry('harvested');
  const entries = new Map([[hand.id, hand], [harvested.id, harvested]]);
  const health = {};
  const tombstones = {};
  await run(entries, health, tombstones, { [hand.id]: 'f1', harvested: 'f1' }, 1000);
  health.harvested.firstSeen = 1;
  assert.deepEqual(await run(entries, health, tombstones, { [hand.id]: 'f2', harvested: 'f2' }, 2000), ['harvested']);
  assert.equal(tombstones.harvested.of, hand.id);
  assert.ok(health[hand.id]);
});

test('duplicates: a retired copy is not re-added by discovery', async () => {
  const entries = new Map([['kept', entry('kept')], ['copy', entry('copy')]]);
  const health = {};
  const tombstones = {};
  await run(entries, health, tombstones, { kept: 'f1', copy: 'f1' }, 1000);
  health.copy.firstSeen = 1500;
  assert.deepEqual(await run(entries, health, tombstones, { kept: 'f2', copy: 'f2' }, 2000), ['copy']);
  entries.delete('copy');
  assert.deepEqual(mergeCandidates(entries, [entry('copy'), entry('fresh')], tombstones).map((e) => e.id), ['fresh']);
});

test('duplicates: a retired copy\'s URL is not re-added under another catalogue\'s id', () => {
  const entries = new Map([['kept', entry('kept')]]);
  const tombstones = { copy: { url: entry('copy').access.url, at: 2000, reason: 'duplicate', of: 'kept' } };
  const relisted = { ...entry('copy'), id: 'transitous-copy' };
  assert.deepEqual(mergeCandidates(entries, [relisted, entry('fresh')], tombstones).map((e) => e.id), ['fresh']);
  // A dead feed's tombstone blocks only its id: the URL may come back working under another.
  const dead = { copy: { url: entry('copy').access.url, at: 2000 } };
  assert.deepEqual(mergeCandidates(entries, [relisted], dead).map((e) => e.id), ['transitous-copy']);
});
