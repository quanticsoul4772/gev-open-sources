import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import { ADAPTERS, gbfsTime } from '../src/adapters/index.js';
import { buildDirectory } from '../src/build.js';
import { gbfsFeeds, keylessSystems, stationBbox } from '../src/harvest/gbfs.js';
import { mergeCandidates } from '../src/harvest/index.js';
import { mobilityDatabaseEntries } from '../src/harvest/mobilitydatabase.js';
import { DAY_S, applyProbe, classify, emptyHealth, summary } from '../src/health.js';
import { validateEntry } from '../src/schema.js';
import { BODS_ENTRY } from '../src/seed.js';
import { parseCsv } from '../src/util/csv.js';
import { hasCredentialParam, registrableDomain } from '../src/util/http.js';
import { normalizeUrl, slugId } from '../src/util/ids.js';
import { readZipEntry } from '../src/util/zip.js';

test('csv: quoted fields, doubled quotes, CRLF', () => {
  const rows = parseCsv('a,b\r\n"x, y","say ""hi"""\r\n1,2\r\n');
  assert.deepEqual(rows, [
    { a: 'x, y', b: 'say "hi"' },
    { a: '1', b: '2' },
  ]);
});

test('credential parameters make a URL keyed', () => {
  assert.equal(hasCredentialParam('https://a.example/vp.pb'), false);
  assert.equal(hasCredentialParam('https://a.example/vp.pb?agency=x'), false);
  for (const p of ['apiKey', 'key', 'token', 'api_key', 'access_token', 'subscription-key'])
    assert.equal(hasCredentialParam(`https://a.example/vp?${p}=abc`), true, p);
});

test('ids are schema-valid, prefixes not doubled, long ids hashed', () => {
  assert.equal(slugId('mdb', 'mdb-1420'), 'mdb-1420');
  assert.equal(slugId('gbfs', 'Careem_Bike'), 'gbfs-careem-bike');
  const long = slugId('mdb', 'x'.repeat(200));
  assert.ok(long.length <= 64 && /^[a-z0-9-]+$/.test(long));
  assert.equal(normalizeUrl('https://A.example/p/?t=1#f'), 'https://a.example/p/?t=1');
});

test('registrable domain handles public second levels', () => {
  assert.equal(registrableDomain('data.bus-data.dft.gov.uk'), 'dft.gov.uk');
  assert.equal(registrableDomain('download.bus-data.dft.gov.uk'), 'dft.gov.uk');
  assert.equal(registrableDomain('cdn.mbta.com'), 'mbta.com');
});

test('zip: reads a deflated entry by name', () => {
  const name = 'gtfsrt.bin';
  const data = Buffer.from('hello gtfs-rt '.repeat(50));
  const packed = deflateRawSync(data);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const dirStart = 30 + nameBytes.length + packed.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBytes.length, 12);
  eocd.writeUInt32LE(dirStart, 16);
  const zip = new Uint8Array(Buffer.concat([local, nameBytes, packed, central, nameBytes, eocd]));
  assert.deepEqual(Buffer.from(readZipEntry(zip, name)), data);
  assert.throws(() => readZipEntry(zip, 'missing.bin'), /not found/);
  assert.throws(() => readZipEntry(zip, name, 10), /over 10 bytes/);
});

test('schema: seed entry valid; display without a decision rejected', () => {
  assert.deepEqual(validateEntry(BODS_ENTRY), []);
  const bad = { ...BODS_ENTRY, licence: { ...BODS_ENTRY.licence, display: true } };
  assert.ok(validateEntry(bad).some((e) => /display without/.test(e)));
});

test('mobility database: keyless vp rows only, keyed URLs rejected, licence borrowed', () => {
  const base = {
    data_type: 'gtfs_rt',
    entity_type: 'vp',
    'urls.authentication_type': '0',
    status: 'active',
    provider: 'Op',
    name: 'Op RT',
    'location.country_code': 'FR',
    'location.bounding_box.minimum_latitude': '1',
    'location.bounding_box.maximum_latitude': '2',
    'location.bounding_box.minimum_longitude': '3',
    'location.bounding_box.maximum_longitude': '4',
  };
  const rows = [
    { ...base, id: 'mdb-1', 'urls.direct_download': 'https://a.example/vp.pb', static_reference: 'mdb-0', 'urls.license': '' },
    { ...base, id: 'mdb-2', 'urls.direct_download': 'https://a.example/vp.pb?token=x' },
    { ...base, id: 'mdb-3', 'urls.direct_download': 'https://b.example/vp.pb', 'urls.authentication_type': '1' },
    { ...base, id: 'mdb-4', 'urls.direct_download': 'https://c.example/tu.pb', entity_type: 'tu' },
    { ...base, id: 'mdb-0', data_type: 'gtfs', 'urls.license': 'https://creativecommons.org/licenses/by/4.0/' },
  ];
  const { entries, rejected } = mobilityDatabaseEntries(rows);
  assert.equal(entries.length, 1);
  assert.equal(rejected.keyed, 2);
  assert.equal(entries[0].id, 'mdb-1');
  assert.deepEqual(entries[0].coverage.bbox, [1, 3, 2, 4]);
  assert.equal(entries[0].licence.url, 'https://creativecommons.org/licenses/by/4.0/');
  assert.ok(entries[0].provenance.includes('licence-borrowed:mdb-0'));
  assert.deepEqual(validateEntry(entries[0]), []);
});

test('gbfs: feed lists for v2 and v3, station bbox, keyless filter', () => {
  const v2 = gbfsFeeds({ version: '2.3', data: { en: { feeds: [{ name: 'station_status', url: 'https://g/ss' }] } } });
  assert.equal(v2.feeds.station_status, 'https://g/ss');
  const v3 = gbfsFeeds({ version: '3.0', data: { feeds: [{ name: 'station_information', url: 'https://g/si' }] } });
  assert.equal(v3.version, '3.0');
  assert.equal(v3.feeds.station_information, 'https://g/si');
  assert.deepEqual(stationBbox({ data: { stations: [{ lat: 1, lon: 2 }, { lat: 3, lon: -1 }, { lat: 0, lon: 0 }] } }), [1, -1, 3, 2]);
  const rows = [
    { 'Auto-Discovery URL': 'https://g/gbfs.json', 'Authentication Type': '' },
    { 'Auto-Discovery URL': 'https://g/gbfs.json', 'Authentication Type': 'oauth' },
  ];
  assert.equal(keylessSystems(rows).length, 1);
  assert.equal(gbfsTime(1700000000), 1700000000);
  assert.equal(gbfsTime('2023-11-14T22:13:20Z'), 1700000000);
});

test('merge: existing ids, duplicate URLs and tombstones are skipped', () => {
  const existing = new Map([['a', { id: 'a', access: { url: 'https://x/a' } }]]);
  const added = mergeCandidates(
    existing,
    [
      { id: 'a', access: { url: 'https://x/other' } },
      { id: 'b', access: { url: 'https://x/a/' } },
      { id: 'c', access: { url: 'https://x/c' } },
      { id: 'd', access: { url: 'https://x/d' } },
      { id: 'e', access: { url: 'https://x/c' } },
    ],
    { d: { at: 1 } },
  );
  assert.deepEqual(added.map((e) => e.id), ['c']);
});

test('classify: fresh, idle, stale, blocked, failures', () => {
  const now = 10_000;
  assert.equal(classify({ status: 200, decoded: { records: 5, newest: now - 30 }, now }).result, 'ok');
  assert.equal(classify({ status: 200, decoded: { records: 0, newest: now - 30 }, now }).result, 'idle');
  assert.equal(classify({ status: 200, decoded: { records: 5, newest: null }, now }).result, 'ok');
  assert.equal(classify({ status: 200, decoded: { records: 5, newest: now - 3600 }, now }).result, 'stale');
  assert.equal(classify({ status: 429 }).result, 'blocked');
  assert.equal(classify({ status: 500 }).result, 'http');
  assert.equal(classify({ error: 'network' }).result, 'network');
});

test('health: verified after 3 passes with records; degraded after 2 failures; dead after 7 days', () => {
  let h = emptyHealth(0);
  const at = (i) => i * 6 * 3600;
  h = applyProbe(h, { at: at(1), result: 'ok', records: 3 });
  h = applyProbe(h, { at: at(2), result: 'idle', records: 0 });
  assert.equal(h.status, 'candidate');
  h = applyProbe(h, { at: at(3), result: 'ok', records: 4 });
  assert.equal(h.status, 'verified');
  h = applyProbe(h, { at: at(4), result: 'blocked' });
  assert.equal(h.status, 'verified', 'blocked says nothing about the feed');
  h = applyProbe(h, { at: at(5), result: 'network' });
  assert.equal(h.status, 'verified');
  h = applyProbe(h, { at: at(6), result: 'http', code: 500 });
  assert.equal(h.status, 'degraded');
  for (let i = 7; i < 7 + 28; i += 1) h = applyProbe(h, { at: at(i), result: 'network' });
  assert.equal(h.status, 'dead');
  for (let i = 40; i < 43; i += 1) h = applyProbe(h, { at: at(i), result: 'ok', records: 2 });
  assert.equal(h.status, 'verified', 'a dead feed that comes back is verified again');
  assert.ok(h.history.length <= 28);
  assert.equal(summary(h, at(42)).status, 'verified');
});

test('health: idle-only feeds are not verified (no records in 7 days)', () => {
  let h = emptyHealth(0);
  for (let i = 1; i <= 5; i += 1) h = applyProbe(h, { at: i * DAY_S, result: 'idle', records: 0 });
  assert.equal(h.status, 'candidate');
});

test('adapters: gbfs station status counts stations and reads last_updated', () => {
  const body = new TextEncoder().encode(JSON.stringify({ last_updated: 1700000000, ttl: 60, data: { stations: [{}, {}] } }));
  assert.deepEqual(ADAPTERS['gbfs.station-status'](body), { records: 2, newest: 1700000000, inCoverage: null });
});

test('directory: dead entries left out, counts', () => {
  const entries = new Map([
    ['a', { id: 'a', licence: { display: true } }],
    ['b', { id: 'b', licence: { display: false } }],
  ]);
  const health = {
    a: { ...emptyHealth(0), status: 'verified', history: [] },
    b: { ...emptyHealth(0), status: 'dead', history: [] },
  };
  const d = buildDirectory(entries, health, 100);
  assert.equal(d.entries.length, 1);
  assert.deepEqual(d.counts, { entries: 1, verified: 1, display: 1, usable: 1 });
});
