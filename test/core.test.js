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
import { fetchCapped } from '../src/util/http.js';
import { entryHasCredential, hasCredential, scanJson } from '../src/util/secrets.js';
import { normalizeUrl, slugId } from '../src/util/ids.js';
import { readZipEntry } from '../src/util/zip.js';

test('csv: quoted fields, doubled quotes, CRLF', () => {
  const rows = parseCsv('a,b\r\n"x, y","say ""hi"""\r\n1,2\r\n');
  assert.deepEqual(rows, [
    { a: 'x, y', b: 'say "hi"' },
    { a: '1', b: '2' },
  ]);
});

test('credentials: parameter names, path keys, userinfo, fragments, token formats', () => {
  for (const u of [
    'https://a.example/vp.pb',
    'https://a.example/vp.pb?agency=x&dataFormat=gtfs-rt',
    'https://a.example/authority/keyboard/vp',
    'https://a.example/api/key',
  ])
    assert.equal(hasCredential(u), false, u);
  for (const p of ['apiKey', 'key', 'token', 'api_key', 'access_token', 'subscription-key', 'accesskey', 'AccessKey', 'x-api-key', 'sessionToken', 'client_secret', 'sig', 'appid', 'client_id', 'acl:consumerKey', 'sid', 'user', 'login', 'access', 'k', 'p', 'myappid', 'client_id_type', 'openweather_appid'])
    assert.equal(hasCredential(`https://a.example/vp?${p}=abc`), true, p);
  for (const u of [
    'https://api.transitime.org/api/v1/key/dca0/agency/x/command/gtfs-rt/vehiclePositions',
    'https://a.example/v1/token/abc/vp',
    'https://a.example/key//abc',
    'https://user:pass@a.example/vp',
    'https://a.example/vp#apikey=abc',
    'https://a.example/vp?x=1&amp;apikey=abc',
    'https://a.example/vp/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0',
    'not a url',
  ])
    assert.equal(hasCredential(u), true, u);
});

test('credentials: every published URL of an entry; JSON scan names paths, never values', () => {
  const entry = {
    access: { url: 'https://a.example/vp', related: { gbfs: 'https://a.example/gbfs.json' } },
    licence: { url: 'https://a.example/terms' },
    gbfs: { catalogue_licence: 'https://spdx.org/licenses/CC0-1.0' },
    provenance: ['x', 'via:https://a.example/api/key/SECRET123/vp'],
  };
  assert.equal(entryHasCredential(entry), true, 'via: provenance');
  assert.equal(entryHasCredential({ ...entry, provenance: ['x'] }), false);
  const withHeaders = (headers) => ({ ...entry, provenance: ['x'], access: { ...entry.access, headers } });
  assert.equal(entryHasCredential(withHeaders({ 'ET-Client-Name': 'gods-eye-view-transit' })), false, 'identification header');
  assert.equal(entryHasCredential(withHeaders({ Authorization: 'Basic abc' })), true, 'auth header');
  assert.equal(entryHasCredential(withHeaders({ 'User-Agent': 'sk-0123456789abcdefghijkl' })), true, 'token value');
  assert.equal(entryHasCredential(withHeaders({ Accept: '' })), true, 'empty value');
  assert.equal(entryHasCredential(withHeaders({ Accept: 'x'.repeat(101) })), true, 'over 100 characters');
  assert.equal(entryHasCredential(withHeaders({ Accept: 'café' })), true, 'non-ASCII');
  const findings = scanJson({ entries: [entry], state: { 'https://a.example/vp?token=SECRET123': { at: 1 } } });
  assert.deepEqual(findings.map((f) => f.path), ['$.entries[0].provenance[1]', '$.state[key #0]']);
  assert.ok(!JSON.stringify(findings).includes('SECRET123'));
  assert.deepEqual(scanJson([{ access: { url: 'https://a.example/vp', headers: { 'X-Api': 'v' } } }]).map((f) => f.path), ['$[0].access.headers']);
});

test('ids are schema-valid, prefixes not doubled, long ids hashed', () => {
  assert.equal(slugId('mdb', 'mdb-1420'), 'mdb-1420');
  assert.equal(slugId('gbfs', 'Careem_Bike'), 'gbfs-careem-bike');
  const long = slugId('mdb', 'x'.repeat(200));
  assert.ok(long.length <= 64 && /^[a-z0-9-]+$/.test(long));
  assert.equal(normalizeUrl('https://A.example/p/?t=1#f'), 'https://a.example/p/?t=1');
});

test('prober redirects: same origin or a listed host, like the app proxy', async () => {
  const hops = {
    'https://a.example.com/old': 'https://a.example.com/new',
    'https://a.example.com/sub': 'https://b.example.com/feed',
    'https://a.example.com/listed': 'https://cdn.other.net/feed',
  };
  const fetchImpl = async (url) =>
    hops[url]
      ? new Response(null, { status: 302, headers: { location: hops[url] } })
      : new Response('ok', { status: 200 });
  assert.equal((await fetchCapped('https://a.example.com/old', { fetchImpl })).url, 'https://a.example.com/new');
  await assert.rejects(fetchCapped('https://a.example.com/sub', { fetchImpl }), /unlisted host b\.example\.com/);
  assert.equal((await fetchCapped('https://a.example.com/listed', { fetchImpl, redirectHosts: ['cdn.other.net'] })).status, 200);
  assert.equal((await fetchCapped('https://a.example.com/sub', { fetchImpl, anyRedirect: true })).status, 200);
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
  // Overnight: no vehicles, the server stopped updating hours ago.
  assert.equal(classify({ status: 200, decoded: { records: 0, newest: now - 4 * 3600 }, now }).result, 'idle');
  assert.equal(classify({ status: 200, decoded: { records: 0, newest: now - 13 * 3600 }, now }).result, 'stale', 'frozen server');
  assert.equal(classify({ status: 200, decoded: { records: 1, newest: now - 4 * 3600 }, now }).result, 'stale', 'old positions still fail');
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

test('redirects: a cross-origin permalink resolves to its final URL', async () => {
  const { crossOriginTarget } = await import('../src/harvest/redirects.js');
  const hops = {
    'https://www.data.gouv.fr/fr/datasets/r/abc': 'https://zenbus.net/gtfs/rt/x.pb',
    'https://a.example.org/old': 'https://a.example.org/new',
    'https://x.example.org/feed': 'https://y.example.org/feed',
    'http://h.example.org/feed': 'https://h.example.org/feed',
  };
  const fetchImpl = async (url) =>
    hops[url]
      ? new Response(null, { status: 302, headers: { location: hops[url] } })
      : new Response('ok', { status: 200 });
  assert.equal(await crossOriginTarget('https://www.data.gouv.fr/fr/datasets/r/abc', fetchImpl), 'https://zenbus.net/gtfs/rt/x.pb');
  assert.equal(await crossOriginTarget('https://a.example.org/old', fetchImpl), null, 'same-origin redirect left to the prober');
  assert.equal(await crossOriginTarget('https://x.example.org/feed', fetchImpl), 'https://y.example.org/feed', 'another subdomain is another origin');
  assert.equal(await crossOriginTarget('http://h.example.org/feed', fetchImpl), 'https://h.example.org/feed', 'http → https');
  assert.equal(await crossOriginTarget('https://b.example/feed', fetchImpl), null);
});

test('redirects: a final URL carrying a key is never stored; the host is allowed instead', async () => {
  const { resolveRedirects } = await import('../src/harvest/redirects.js');
  const hops = { 'https://www.data.gouv.fr/r/k': 'https://app.mecatran.com/vehicles/x?apiKey=abc123' };
  const fetchImpl = async (url) =>
    hops[url]
      ? new Response(null, { status: 302, headers: { location: hops[url] } })
      : new Response('ok', { status: 200 });
  const entry = { id: 'k', access: { url: 'https://www.data.gouv.fr/r/k', redirectHosts: [] }, provenance: ['test'] };
  const [changed] = await resolveRedirects([entry], fetchImpl);
  assert.equal(changed.access.url, 'https://www.data.gouv.fr/r/k');
  assert.deepEqual(changed.access.redirectHosts, ['app.mecatran.com']);
  assert.deepEqual(changed.provenance, ['test']);
  assert.deepEqual(await resolveRedirects([changed], fetchImpl), [], 'already allowed: no change');
});

test('size guard: the total outside 85–180 % of a copy from the last 30 h refuses; a domain only warns', async () => {
  const { domainSizeWarnings, sizeProblem } = await import('../src/build.js');
  const now = 100 * 3600;
  const sizes = (entries, domains = {}) => ({ entries, domains });
  const published = [
    { at: now - 40 * 3600, entries: 100 }, // too old to count
    { at: now - 20 * 3600, entries: 1000 },
    { at: now - 6 * 3600, entries: 1100, domains: { 'transit.vehicles': 600, 'bikeshare.stations': 445, 'hazards.earthquakes': 5, cams: 50 } },
  ];
  const ok = { 'transit.vehicles': 650, 'bikeshare.stations': 490, 'hazards.earthquakes': 5, cams: 50 };
  assert.equal(sizeProblem(published, sizes(1200, ok), now), null);
  assert.deepEqual(domainSizeWarnings(published, sizes(1200, ok), now), []);
  assert.match(sizeProblem(published, sizes(900, ok), now), /0\.85/, 'total drop below 85 % of the newest');
  assert.match(sizeProblem(published, sizes(1900, ok), now), /1000 published/, 'over 1.8× the day-old copy');
  assert.equal(sizeProblem(published, sizes(1100, { ...ok, 'bikeshare.stations': 300 }), now), null, 'a domain drop never refuses');
  assert.match(domainSizeWarnings(published, sizes(1100, { ...ok, 'bikeshare.stations': 300 }), now)[0], /^bikeshare\.stations: 300/);
  assert.match(domainSizeWarnings(published, sizes(1100, { ...ok, cams: 40 }), now)[0], /^cams: 40/, 'a domain at the floor of 50 warns');
  assert.deepEqual(domainSizeWarnings(published, sizes(1100, { ...ok, 'hazards.earthquakes': 1 }), now), [], 'under the floor: silent');
  assert.equal(sizeProblem([], sizes(5000), now), null, 'first publish');
});

test('publish: v1 files per domain, and an index of counts and bytes', async () => {
  const { buildDirectory, indexOf, publishedFiles } = await import('../src/build.js');
  const entry = (id, domain) => ({ id, domain, licence: { display: true } });
  const directory = buildDirectory(
    new Map([['a', entry('a', 'transit.vehicles')], ['b', entry('b', 'bikeshare.stations')], ['c', entry('c', 'transit.vehicles')]]),
    { a: { ...emptyHealth(0), status: 'verified', history: [] } },
    100,
  );
  const files = publishedFiles(directory);
  assert.deepEqual([...files.keys()], ['directory.json', 'bikeshare.stations.json', 'transit.vehicles.json']);
  const transit = files.get('transit.vehicles.json');
  assert.equal(transit.domain, 'transit.vehicles');
  assert.equal(transit.version, 1);
  assert.deepEqual(transit.entries.map((e) => e.id), ['a', 'c']);
  assert.deepEqual(transit.counts, { entries: 2, verified: 1, display: 2, usable: 1 });
  const texts = new Map([...files].map(([f, d]) => [f, JSON.stringify(d)]));
  const index = indexOf(directory, texts);
  assert.deepEqual(index.files.map((f) => [f.path, f.domain, f.entries]), [
    ['directory.json', null, 3],
    ['bikeshare.stations.json', 'bikeshare.stations', 1],
    ['transit.vehicles.json', 'transit.vehicles', 2],
  ]);
  assert.equal(index.files[0].bytes, Buffer.byteLength(texts.get('directory.json')));
  assert.ok(!('sha256' in index.files[0]));
});

test('harvest: new entries capped at 8 % of the directory and of each domain per run', async () => {
  const { addLimit, withinAddLimits } = await import('../src/harvest/index.js');
  assert.equal(addLimit(1200), 96);
  assert.equal(addLimit(5), 1);
  assert.equal(addLimit(0), Infinity, 'first harvest (or a new domain) unlimited');
  assert.ok(1.08 ** 7 < 1.8, 'seven runs in 30 h stay inside the build guard');
  const existing = new Map();
  for (let i = 0; i < 100; i += 1) existing.set(`t${i}`, { domain: 'transit' });
  for (let i = 0; i < 20; i += 1) existing.set(`b${i}`, { domain: 'bikes' });
  const ready = [
    ...Array.from({ length: 5 }, (_, i) => ({ id: `nb${i}`, domain: 'bikes' })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `nt${i}`, domain: 'transit' })),
    { id: 'q1', domain: 'quakes' },
  ];
  const added = withinAddLimits(ready, existing);
  const by = (d) => added.filter((e) => e.domain === d).length;
  assert.equal(added.length, 9, '8 % of 120');
  assert.equal(by('bikes'), 1, '8 % of 20');
  assert.equal(by('transit'), 8, '8 % of 100');
  assert.equal(by('quakes'), 0, 'the total limit was reached first');
});

test('probe rounds: a passing candidate is verified in one run; history keeps only the final result', async () => {
  const { probeRounds, ROUND_SPACING_S } = await import('../src/probe.js');
  let t = 1_000_000;
  const clock = () => t;
  const sleep = async (ms) => {
    t += ms / 1000;
  };
  const entry = (id, minInterval = 15) => ({ id, access: { url: `https://${id}.example/vp`, min_interval_s: minInterval } });
  const seen = [];
  const results = { fresh: 'ok', slow: 'ok', down: 'http', blocked: 'blocked', old: 'ok' };
  const probe = async (e, at) => {
    seen.push([e.id, at]);
    return { at, result: results[e.id], records: 5 };
  };
  const health = { old: { ...emptyHealth(0), status: 'verified', history: [] } };
  const { counts, rounds } = await probeRounds(
    [entry('fresh'), entry('slow', 600), entry('down'), entry('blocked'), entry('old')],
    health,
    { probe, clock, sleep },
  );
  assert.equal(rounds, 3);
  assert.equal(health.fresh.status, 'verified');
  assert.equal(health.fresh.history.length, 1, 'only the final result is recorded');
  const times = (id) => seen.filter(([x]) => x === id).map(([, at]) => at);
  assert.equal(times('fresh').length, 3);
  assert.ok(times('slow')[1] - times('slow')[0] >= 600, 'spacing honours min_interval_s');
  assert.ok(times('fresh')[1] - times('fresh')[0] >= ROUND_SPACING_S);
  for (const id of ['down', 'blocked', 'old']) assert.equal(times(id).length, 1, `${id} probed once`);
  assert.equal(counts.ok, 3);
});

test('freshness: a decoder may set its own stale limit (FIRMS 6 h); others keep 15 min', () => {
  const now = 1_000_000;
  const firms = (ageH) => classify({ status: 200, decoded: { records: 5, newest: now - ageH * 3600, staleAfterS: 6 * 3600 }, now }).result;
  assert.equal(firms(3), 'ok');
  assert.equal(firms(7), 'stale');
  assert.equal(classify({ status: 200, decoded: { records: 5, newest: now - 3 * 3600 }, now }).result, 'stale');
  const hourly = (ageH) => classify({ status: 200, decoded: { records: 5, newest: now - ageH * 3600, staleAfterS: 3 * 3600 }, now }).result;
  assert.equal(hourly(1.5), 'ok', 'an hourly file can be an hour behind');
  assert.equal(hourly(4), 'stale');
});

test('probe limits: FIRMS files may exceed 8 MiB; other formats may not', async () => {
  const { probeEntry } = await import('../src/probe.js');
  const { FIRMS_ENTRIES } = await import('../src/harvest/firms.js');
  const row = '45.8,-120.1,330.2,0.4,0.4,2026-10-16,0945,N20,high,2.0NRT,290.1,5.2,D\n';
  const big = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight\n' + row.repeat(Math.ceil((9 * 2 ** 20) / row.length));
  const now = Date.parse('2026-10-16T11:00:00Z') / 1000;
  const fetchImpl = async () => new Response(big);
  assert.equal((await probeEntry(FIRMS_ENTRIES[1], { now, fetchImpl })).result, 'ok');
  const gtfs = { id: 'g', format: 'gtfs-rt.vehicle-positions', coverage: { bbox: null }, access: { url: 'https://g.example/vp', headers: {}, redirectHosts: [], unzip: null } };
  assert.equal((await probeEntry(gtfs, { now, fetchImpl })).result, 'network', 'over the 8 MiB cap');
});

test('probe: 204 No Content is an empty feed (idle), other non-200 answers fail', async () => {
  const { probeEntry } = await import('../src/probe.js');
  const now = Date.parse('2026-10-24T01:00:00Z') / 1000;
  const gtfs = { id: 'g', format: 'gtfs-rt.vehicle-positions', coverage: { bbox: null }, access: { url: 'https://g.example/vp', headers: {}, redirectHosts: [], unzip: null } };
  const answer = (status) => async () => new Response(null, { status });
  const empty = await probeEntry(gtfs, { now, fetchImpl: answer(204) });
  assert.equal(empty.result, 'idle');
  assert.equal(empty.records, 0);
  assert.deepEqual(await probeEntry(gtfs, { now, fetchImpl: answer(404) }), { at: now, result: 'http', code: 404 });
});

test('probe limits: the Sensor.Community 1-hour file (8.7 MB) fits its own cap', async () => {
  const { probeEntry } = await import('../src/probe.js');
  const { AIRQUALITY_ENTRIES } = await import('../src/harvest/airquality.js');
  const record = JSON.stringify({
    timestamp: '2026-10-16 10:59:00',
    location: { latitude: '52.5', longitude: '13.4', indoor: 0 },
    sensordatavalues: [{ value_type: 'P1', value: '12.0' }, { value_type: 'P2', value: '7.0' }],
  });
  const big = `[${Array(Math.ceil((9 * 2 ** 20) / record.length)).fill(record).join(',')}]`;
  const now = Date.parse('2026-10-16T11:00:00Z') / 1000;
  assert.equal((await probeEntry(AIRQUALITY_ENTRIES[0], { now, fetchImpl: async () => new Response(big) })).result, 'ok');
});

test('probe rounds: FIRMS entries get all three rounds inside the budget', async () => {
  const { probeRounds } = await import('../src/probe.js');
  const { FIRMS_ENTRIES } = await import('../src/harvest/firms.js');
  let t = 0;
  const health = {};
  const { AIRQUALITY_ENTRIES } = await import('../src/harvest/airquality.js');
  const { rounds } = await probeRounds([...FIRMS_ENTRIES, ...AIRQUALITY_ENTRIES], health, {
    probe: async (e, at) => ({ at, result: 'ok', records: 100 }),
    clock: () => t,
    sleep: async (ms) => {
      t += ms / 1000;
    },
  });
  assert.equal(rounds, 3);
  for (const e of [...FIRMS_ENTRIES, ...AIRQUALITY_ENTRIES]) assert.equal(health[e.id].status, 'verified', e.id);
});

test('redirect re-check: failing entries are re-checked, FIRMS entries never', async () => {
  const { redirectChecks } = await import('../src/harvest/index.js');
  const { FIRMS_ENTRIES } = await import('../src/harvest/firms.js');
  const other = { id: 'x', provenance: ['mdb:1'], access: { url: 'https://x.example/vp' } };
  const existing = new Map([[other.id, other], ...FIRMS_ENTRIES.map((e) => [e.id, e])]);
  const failed = { history: [{ result: 'network' }] };
  const health = Object.fromEntries([...existing.keys()].map((id) => [id, failed]));
  assert.deepEqual(redirectChecks([], existing, health).map((e) => e.id), ['x']);
  assert.deepEqual(redirectChecks(FIRMS_ENTRIES, new Map(), {}), [], 'new FIRMS candidates too');
});

test('static entries: never tombstoned, never redirect-rewritten; catalogue entries still are', async () => {
  const { retireDead } = await import('../src/probe.js');
  const { redirectChecks } = await import('../src/harvest/index.js');
  const { STATIC_ENTRIES } = await import('../src/harvest/static.js');
  const { PERIMETER_ENTRIES } = await import('../src/harvest/perimeters.js');
  const bc = PERIMETER_ENTRIES[0];
  const feed = { id: 'feed', provenance: ['mdb:1'], access: { url: 'https://f.example/vp' } };
  const entries = new Map([[bc.id, bc], [feed.id, feed]]);
  const now = 100 * DAY_S;
  const dead = () => ({ status: 'dead', deadSince: now - 31 * DAY_S, history: [{ result: 'http' }] });
  const health = { [bc.id]: dead(), [feed.id]: dead(), gone: dead() };
  const tombstones = {};
  assert.deepEqual(retireDead(health, entries, tombstones, now), ['feed']);
  assert.deepEqual(Object.keys(tombstones), ['feed']);
  assert.equal(health[bc.id].status, 'dead', 'stays, dead and unpublished, and can recover');
  assert.equal(health.gone, undefined, 'health of a removed entry is dropped');
  assert.deepEqual(redirectChecks(STATIC_ENTRIES, new Map([[bc.id, bc], [feed.id, feed]]), { [bc.id]: dead(), [feed.id]: dead() }).map((e) => e.id), ['feed']);
  assert.ok(STATIC_ENTRIES.some((e) => e.id === 'sensor-community-pm-1h'), 'Sensor.Community is hand-written too');
});

test('a new perimeter entry idle from its first probe stays a candidate, never failing, until its first fire', () => {
  let h = emptyHealth(0);
  for (let day = 1; day <= 5; day += 1) h = applyProbe(h, { at: day * DAY_S, result: 'idle', records: 0 });
  assert.equal(h.status, 'candidate');
  assert.equal(h.failingSince, null);
  h = applyProbe(h, { at: 6 * DAY_S, result: 'ok', records: 4 });
  assert.equal(h.status, 'verified');
});

test('perimeters out of season: idle for months is degraded, never dead; the first fire makes it verified again', () => {
  let h = { ...emptyHealth(0), status: 'verified', passes: 3, lastWithRecords: 0 };
  for (let day = 1; day <= 60; day += 1) h = applyProbe(h, { at: day * DAY_S, result: 'idle', records: 0 });
  assert.equal(h.status, 'degraded');
  assert.equal(h.failingSince, null);
  h = applyProbe(h, { at: 61 * DAY_S, result: 'ok', records: 3 });
  assert.equal(h.status, 'verified');
});

test('build: a hazard entry keeps its own class; one without a class is global', async () => {
  const { PERIMETER_ENTRIES } = await import('../src/harvest/perimeters.js');
  const { USGS_ENTRIES } = await import('../src/harvest/usgs.js');
  const { AIRQUALITY_ENTRIES } = await import('../src/harvest/airquality.js');
  const d = buildDirectory(new Map([PERIMETER_ENTRIES[0], USGS_ENTRIES[0], AIRQUALITY_ENTRIES[0]].map((e) => [e.id, e])), {}, 100);
  const cls = Object.fromEntries(d.entries.map((e) => [e.id, e.coverage.class]));
  assert.equal(cls[PERIMETER_ENTRIES[0].id], 'regional');
  assert.equal(cls[USGS_ENTRIES[0].id], 'global');
  assert.equal(cls[AIRQUALITY_ENTRIES[0].id], 'global', 'a non-hazard entry states its class');
});

test('every format has a decoder, and the domain and format lists match the published schema', async () => {
  const fs = await import('node:fs');
  const { DOMAINS, FORMATS } = await import('../src/schema.js');
  const schema = JSON.parse(fs.readFileSync(new URL('../schema/entry.schema.json', import.meta.url), 'utf8'));
  for (const f of FORMATS) assert.equal(typeof ADAPTERS[f], 'function', f);
  assert.deepEqual([...schema.properties.domain.enum].sort(), [...DOMAINS].sort());
  assert.deepEqual([...schema.properties.format.enum].sort(), [...FORMATS].sort());
});

test('probe rounds: no round starts past the budget', async () => {
  const { probeRounds } = await import('../src/probe.js');
  let t = 0;
  const seen = [];
  await probeRounds([{ id: 'a', access: { url: 'https://a.example/vp', min_interval_s: 15 } }], {}, {
    probe: async (e, at) => (seen.push(at), { at, result: 'ok', records: 1 }),
    clock: () => t,
    sleep: async (ms) => {
      t += ms / 1000;
    },
    budgetS: 400,
  });
  assert.equal(seen.length, 2, 'the third round would start at 600 s > 400 s');
});

test('credentials: token prefixes inside a slug are not tokens', () => {
  const slug = 'transitous-sk-zsr-https-jbb-ghsq-de-gtfs-zsr-vehiclepositions';
  assert.deepEqual(scanJson({ id: slug, [slug]: { status: 'candidate' } }), []);
  for (const text of ['sk-ant-api03-abcdefghijklmnopqrst', 'Bearer sk-abcdefghijklmnopqrstuv', 'k=ghp_abcdefghijklmnopqrstuvwxyz0123456', 'AKIAABCDEFGHIJKLMNOP'])
    assert.equal(scanJson({ v: text }).length, 1, text);
});

test('credentials: text that only starts like a URL (a schema pattern) is not a URL', () => {
  assert.deepEqual(scanJson({ pattern: '^https://[!-~]+$', doc: 'see https://a.example/terms' }), []);
  assert.equal(scanJson({ note: 'feed at https://a.example/vp?apikey=abc' }).length, 1, 'a real URL in text is still checked');
  assert.equal(hasCredential('not a url'), true, 'entry URLs stay strict');
});

test('pool: tasks waiting on a busy host all run, with perHost 1', async () => {
  const { runPooled } = await import('../src/util/pool.js');
  const order = [];
  const results = await runPooled([1, 2, 3, 4], () => 'same.example', async (x) => {
    order.push(x);
    await new Promise((r) => setTimeout(r, 1));
    return x * 10;
  }, { perHost: 1 });
  assert.deepEqual(results, [10, 20, 30, 40], 'none dropped when the last running task finishes');
  assert.deepEqual(order, [1, 2, 3, 4]);
});

test('credentials: same rule as the app — key-like segment variants, path parameters, AIza and Bearer', () => {
  for (const u of [
    'https://a.example/v1/api-key/abc/vp',
    'https://a.example/v1/access_token/abc/vp',
    'https://a.example/v1/auth-token/abc/vp',
    'https://a.example/feed;apikey=abc/vp',
    'https://a.example/feed;x=sk-abc/vp',
    'https://a.example/key;v=1/abc',
    'https://a.example/vp?k2=AIzaSyA',
    'https://a.example/vp?h=Bearer%20abc',
    'https://a.example/AIzaSyExample/vp',
  ])
    assert.equal(hasCredential(u), true, u);
  for (const u of ['https://a.example/feed;version=2/vp', 'https://a.example/v1/keyboard/vp', 'https://a.example/vp?skin=sk'])
    assert.equal(hasCredential(u), false, u);
});

test('restore: all or nothing — first deploy starts empty; a published site must return every state file', async () => {
  const { restoreState } = await import('../src/restore-state.js');
  const site = (files) => async (url) => {
    const path = new URL(url).pathname.replace(/^\/[^/]*\//, '');
    return path in files ? new Response(JSON.stringify(files[path])) : new Response('not found', { status: 404 });
  };
  await restoreState('https://x.example/site', site({}), '1'); // nothing published: no throw, nothing written
  const index = { generated_at: '2026-10-14T00:00:00.000Z' };
  await assert.rejects(restoreState('https://x.example/site', site({ 'v1/index.json': index }), '1'), /missing from a published site/);
  const state = {
    'state/health.json': {},
    'state/licence-cache.json': {},
    'state/tombstones.json': {},
    'state/harvest-rejects.json': [],
    'state/published.json': [],
  };
  await assert.rejects(restoreState('https://x.example/site', site({ 'v1/index.json': index, ...state }), '1'), /harvest-rejects.json: expected object, got array/);
  const stale = { ...state, 'state/harvest-rejects.json': {}, 'state/published.json': [{ at: Date.parse('2026-10-13T00:00:00Z') / 1000 }] };
  await assert.rejects(restoreState('https://x.example/site', site({ 'v1/index.json': index, ...stale }), '1'), /stale copy/);
  let seen = '';
  await restoreState('https://x.example/site', async (url) => ((seen = url), new Response('nf', { status: 404 })), 'abc');
  assert.match(seen, /\?r=abc$/, 'cache-busting query');
});

test('a public name that resolves to an internal address is refused', async () => {
  const { resolvesInternal } = await import('../src/util/http.js');
  const answers = { 'evil.example': ['93.184.216.34', '169.254.169.254'], 'ok.example': ['93.184.216.34', '2606:2800::1'], 'v6.example': ['fd00::1'] };
  const lookup = async (host) => {
    if (!answers[host]) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return answers[host].map((address) => ({ address }));
  };
  assert.equal(await resolvesInternal('https://evil.example/vp', lookup), true, 'any internal answer counts');
  assert.equal(await resolvesInternal('https://v6.example/vp', lookup), true);
  assert.equal(await resolvesInternal('https://ok.example/vp', lookup), false);
  assert.equal(await resolvesInternal('https://gone.example/vp', lookup), false, 'unresolvable names are left to the fetch');
  let looked = false;
  await resolvesInternal('http://20.19.98.194:8328/x', async () => ((looked = true), []));
  assert.equal(looked, false, 'IP literals need no lookup');

  const fetchImpl = async () => new Response('{}');
  await assert.rejects(fetchCapped('https://evil.example/vp', { fetchImpl, lookup }), /refusing internal address evil\.example/);
  assert.equal((await fetchCapped('https://ok.example/vp', { fetchImpl, lookup })).status, 200);
  const hop = async (u) =>
    u.includes('ok.example') ? new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }) : new Response('{}');
  await assert.rejects(fetchCapped('https://ok.example/vp', { fetchImpl: hop, lookup, anyRedirect: true }), /evil\.example/, 'checked on every hop');
  const { crossOriginTarget } = await import('../src/harvest/redirects.js');
  assert.equal(await crossOriginTarget('https://ok.example/vp', hop, lookup), null, 'never published as a final URL');
});

test('internal addresses are refused on every hop; public IP literals are allowed', async () => {
  const { isInternalUrl } = await import('../src/util/http.js');
  for (const u of ['http://169.254.169.254/latest/meta-data', 'http://127.0.0.1:8080/x', 'http://10.0.0.5/x', 'http://192.168.1.1/x', 'http://172.20.0.1/x', 'http://[::1]/x', 'http://localhost/x', 'http://db.internal/x', 'http://[fd00::1]/x', 'not a url'])
    assert.equal(isInternalUrl(u), true, u);
  for (const u of ['http://20.19.98.194:8328/api/gtfs-realtime/6', 'https://a.example/vp', 'http://172.32.0.1/x'])
    assert.equal(isInternalUrl(u), false, u);
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } });
  await assert.rejects(fetchCapped('https://a.example/vp', { fetchImpl, anyRedirect: true }), /refusing internal address 169\.254\.169\.254/);
  const { crossOriginTarget } = await import('../src/harvest/redirects.js');
  assert.equal(await crossOriginTarget('https://a.example/vp', fetchImpl), null, 'never published as a final URL');
});

test('credentials: authorization/clientid/pw names and bare 32+ hex path segments', () => {
  for (const u of ['https://a.example/vp?Authorization=x', 'https://a.example/vp?clientid=x', 'https://a.example/vp?pw=x', `https://a.example/gtfs/realtime/${'c21a'.repeat(8)}`])
    assert.equal(hasCredential(u), true, u);
  assert.equal(hasCredential('https://a.example/r/372463bd-d7b4-4668-a9b5-bd71a28f389d'), false, 'a UUID is not a key');
});
