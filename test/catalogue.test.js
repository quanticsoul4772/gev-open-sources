import assert from 'node:assert/strict';
import test from 'node:test';
import { PbfWriter } from 'pbf';
import { ADAPTERS } from '../src/adapters/index.js';
import { atlasCandidates } from '../src/harvest/atlas.js';
import {
  catalogueLicenceUrl,
  checkVehicleFeed,
  pointsBbox,
  resolveTransitCandidates,
} from '../src/harvest/catalogue.js';
import { knownUrlsOf } from '../src/harvest/index.js';
import { regionCountry, transitousSources } from '../src/harvest/transitous.js';
import { USGS_ENTRIES } from '../src/harvest/usgs.js';
import { knownLicence } from '../src/licence/known.js';
import { validateEntry } from '../src/schema.js';

/** GTFS-RT FeedMessage bytes: one entity per item, a vehicle position or a trip update. */
function feedBytes(items) {
  const pbf = new PbfWriter();
  pbf.writeMessage(1, (_, w) => {
    w.writeStringField(1, '2.0');
    w.writeVarintField(3, 1_700_000_000);
  });
  items.forEach((item, i) =>
    pbf.writeMessage(2, (_, w) => {
      w.writeStringField(1, `e${i}`);
      if (item === 'trip') w.writeMessage(3, (__, t) => t.writeMessage(1, (___, d) => d.writeStringField(1, 'trip')));
      else
        w.writeMessage(4, (__, v) => {
          v.writeMessage(2, (___, p) => {
            p.writeFloatField(1, item[0]);
            p.writeFloatField(2, item[1]);
          });
          v.writeMessage(8, (___, d) => d.writeStringField(1, `v${i}`));
        });
    }),
  );
  return pbf.finish();
}

const fakeFetch = (routes) => async (url) => {
  const route = routes[url];
  if (!route) return new Response('not found', { status: 404 });
  return new Response(route.body, { status: route.status ?? 200, headers: route.headers });
};

test('catalogue licence: known SPDX id wins, else the catalogue URL', () => {
  assert.equal(catalogueLicenceUrl('ODbL-1.0', 'https://x.example/dataset'), 'https://spdx.org/licenses/ODbL-1.0');
  assert.ok(knownLicence(catalogueLicenceUrl('etalab-2.0', null)));
  assert.equal(catalogueLicenceUrl('MIT', 'https://x.example/terms'), 'https://x.example/terms');
  assert.equal(catalogueLicenceUrl('MIT', null), 'https://spdx.org/licenses/MIT');
  assert.equal(catalogueLicenceUrl(null, null), null);
});

test('atlas: keyless vehicle-position feeds with operator names; keyed feeds skipped', () => {
  const doc = {
    feeds: [
      { id: 'f-a~rt', spec: 'gtfs-rt', urls: { realtime_vehicle_positions: 'https://a.example/vp.pb' }, license: { spdx_identifier: 'CC-BY-4.0', attribution_text: 'Agency A' } },
      { id: 'f-b~rt', spec: 'gtfs-rt', urls: { realtime_vehicle_positions: 'https://b.example/vp' }, authorization: { type: 'header' } },
      { id: 'f-c~rt', spec: 'gtfs-rt', urls: { realtime_trip_updates: 'https://c.example/tu' } },
      { id: 'f-d', spec: 'gtfs', urls: { static_current: 'https://d.example/gtfs.zip' } },
    ],
    operators: [{ name: 'Operator A', associated_feeds: [{ feed_onestop_id: 'f-a~rt' }] }],
  };
  const c = atlasCandidates([{ file: 'a.example.dmfr.json', doc }]);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0], {
    id: 'atlas-f-a-rt',
    name: 'Operator A',
    provider: 'Operator A',
    url: 'https://a.example/vp.pb',
    licenceUrl: 'https://spdx.org/licenses/CC-BY-4.0',
    attribution: 'Agency A',
    countries: [],
    provenance: ['transitland-atlas:f-a~rt'],
  });
});

test('transitous: url sources by spec; skipped, keyed and catalogue-referencing sources left out', () => {
  const doc = {
    sources: [
      { name: 'lyon', type: 'url', spec: 'gtfs-rt', url: 'https://rt.example/lyon', license: { 'spdx-identifier': 'ODbL-1.0' } },
      { name: 'lyon', type: 'url', spec: 'gtfs-rt', url: 'https://rt.example/lyon-tu' },
      { name: 'velib', type: 'url', spec: 'gbfs', url: 'https://bikes.example/gbfs.json', license: { 'spdx-identifier': 'ODbL-1.0' } },
      { name: 'keyed', type: 'url', spec: 'gtfs-rt', url: 'https://k.example/rt', headers: { Authorization: 'x' } },
      { name: 'skipped', type: 'url', spec: 'gtfs-rt', url: 'https://s.example/rt', skip: true },
      { name: 'mdb', type: 'mobility-database', spec: 'gtfs-rt', 'mdb-id': 'mdb-1' },
      { name: 'static', type: 'url', url: 'https://s.example/gtfs.zip' },
    ],
  };
  const { rt, gbfs } = transitousSources([{ region: 'fr', doc }]);
  assert.deepEqual(rt.map((c) => c.url), ['https://rt.example/lyon', 'https://rt.example/lyon-tu']);
  assert.notEqual(rt[0].id, rt[1].id);
  assert.equal(rt[0].licenceUrl, 'https://spdx.org/licenses/ODbL-1.0');
  assert.deepEqual(rt[0].countries, ['FR']);
  assert.equal(gbfs.length, 1);
  assert.equal(gbfs[0].catalogueLicence, 'https://spdx.org/licenses/ODbL-1.0');
  assert.equal(regionCountry('us-ca'), 'US');
  assert.equal(regionCountry('eu'), null);
});

test('vehicle check: positions give a bbox; trip updates rejected; empty feed retried', async () => {
  const fetchImpl = fakeFetch({
    'https://a.example/vp': { body: feedBytes([[48.8, 2.3], [48.9, 2.4]]) },
    'https://a.example/tu': { body: feedBytes(['trip']) },
    'https://a.example/empty': { body: feedBytes([]) },
    'https://a.example/keyed': { body: 'no', status: 401 },
  });
  const vp = await checkVehicleFeed('https://a.example/vp', { fetchImpl });
  assert.equal(vp.ok, true);
  assert.deepEqual(vp.bbox, pointsBbox([[48.8, 2.3], [48.9, 2.4]]));
  assert.deepEqual(await checkVehicleFeed('https://a.example/tu', { fetchImpl }), { ok: false, reason: 'no vehicle positions' });
  assert.equal((await checkVehicleFeed('https://a.example/empty', { fetchImpl })).retry, true);
  assert.deepEqual(await checkVehicleFeed('https://a.example/keyed', { fetchImpl }), { ok: false, reason: 'HTTP 401' });
});

test('candidates: known, credential and recently rejected URLs skipped; rejections remembered', async () => {
  const fetchImpl = fakeFetch({
    'https://a.example/vp': { body: feedBytes([[59.9, 10.7]]) },
    'https://a.example/tu': { body: feedBytes(['trip']) },
  });
  const base = { name: 'n', provider: 'p', licenceUrl: null, attribution: null, countries: [], provenance: ['test'] };
  const candidates = [
    { ...base, id: 'c-vp', url: 'https://a.example/vp' },
    { ...base, id: 'c-tu', url: 'https://a.example/tu' },
    { ...base, id: 'c-known', url: 'https://a.example/known' },
    { ...base, id: 'c-key', url: 'https://a.example/vp?apikey=x' },
    { ...base, id: 'c-old', url: 'https://a.example/old' },
  ];
  const rejects = { 'https://a.example/old': { reason: 'HTTP 404', at: 900 } };
  const entries = await resolveTransitCandidates(candidates, {
    knownUrls: new Set(['https://a.example/known']),
    rejects,
    now: 1000,
    fetchImpl,
  });
  assert.deepEqual(entries.map((e) => e.id), ['c-vp']);
  assert.deepEqual(validateEntry(entries[0]), []);
  assert.equal(rejects['https://a.example/tu'].reason, 'no vehicle positions');
});

test('known URLs include GBFS discovery and via: permalinks', () => {
  const urls = knownUrlsOf(
    new Map([['a', { access: { url: 'https://op.example/vp', related: { gbfs: 'https://op.example/gbfs.json' } }, provenance: ['x', 'via:https://data.example/r/1'] }]]),
  );
  assert.ok(urls.has('https://op.example/vp') && urls.has('https://op.example/gbfs.json') && urls.has('https://data.example/r/1'));
});

test('usgs: entries valid; licence page is a known public-domain licence', () => {
  for (const e of USGS_ENTRIES) assert.deepEqual(validateEntry(e), [], e.id);
  assert.equal(new Set(USGS_ENTRIES.map((e) => e.id)).size, USGS_ENTRIES.length);
  const known = knownLicence(USGS_ENTRIES[0].licence.url);
  assert.equal(known.display, true);
  assert.equal(known.commercial, true);
});

test('adapters: earthquake GeoJSON counts events, freshness from metadata.generated', () => {
  const doc = {
    type: 'FeatureCollection',
    metadata: { generated: 1_700_000_123_456 },
    features: [
      { geometry: { type: 'Point', coordinates: [-122.8, 38.8, 2] } },
      { geometry: { type: 'Point', coordinates: [142.1, 38.3, 10] } },
    ],
  };
  const body = new TextEncoder().encode(JSON.stringify(doc));
  assert.deepEqual(ADAPTERS['geojson.earthquakes'](body, [30, -130, 45, -110]), { records: 2, newest: 1_700_000_123, inCoverage: 0.5 });
  assert.throws(() => ADAPTERS['geojson.earthquakes'](new TextEncoder().encode('{}'), null), /FeatureCollection/);
});

test('coverage: a missing transit bbox is filled from the vehicles; others untouched', async () => {
  const { fillTransitCoverage } = await import('../src/harvest/catalogue.js');
  const fetchImpl = fakeFetch({ 'https://a.example/vp': { body: feedBytes([[45.5, -73.6]]) } });
  const entry = (id, url, bbox) => ({ id, domain: 'transit.vehicles', coverage: { bbox, countries: [] }, access: { url } });
  const filled = await fillTransitCoverage(
    [entry('none', 'https://a.example/vp', null), entry('down', 'https://a.example/404', null), entry('has', 'https://a.example/vp', [1, 1, 2, 2])],
    { fetchImpl },
  );
  assert.deepEqual([...filled.keys()], ['none']);
  assert.deepEqual(filled.get('none').coverage.bbox, pointsBbox([[45.5, -73.6]]));
});

test('https upgrade: switch only on 200, same content type and decodable data; http kept as via:', async () => {
  const { upgradeToHttps } = await import('../src/harvest/https.js');
  const pb = { 'content-type': 'application/octet-stream' };
  const fetchImpl = fakeFetch({
    'http://ok.example/vp': { body: feedBytes([[45, 7]]), headers: pb },
    'https://ok.example/vp': { body: feedBytes([[45, 7]]), headers: pb },
    'http://html.example/vp': { body: feedBytes([[45, 7]]), headers: pb },
    'https://html.example/vp': { body: '<html>hi</html>', headers: { 'content-type': 'text/html' } },
    'http://junk.example/vp': { body: 'x', headers: pb },
    'https://junk.example/vp': { body: '{"not":"protobuf"', headers: pb },
    'http://plain.example/vp': { body: feedBytes([[45, 7]]), headers: pb },
  });
  const entry = (id, url) => ({
    id,
    domain: 'transit.vehicles',
    format: 'gtfs-rt.vehicle-positions',
    coverage: { bbox: null, countries: [] },
    access: { url, redirectHosts: [], unzip: null, headers: {}, min_interval_s: 15 },
    provenance: ['test'],
  });
  const rejects = {};
  const upgraded = await upgradeToHttps(
    [entry('ok', 'http://ok.example/vp'), entry('html', 'http://html.example/vp'), entry('junk', 'http://junk.example/vp'), entry('plain', 'http://plain.example/vp'), entry('secure', 'https://ok.example/vp')],
    { rejects, now: 1000, fetchImpl },
  );
  assert.deepEqual([...upgraded.keys()], ['ok']);
  assert.equal(upgraded.get('ok').access.url, 'https://ok.example/vp');
  assert.deepEqual(upgraded.get('ok').provenance, ['test', 'via:http://ok.example/vp']);
  assert.match(rejects['https://html.example/vp'].reason, /content type/);
  assert.match(rejects['https://junk.example/vp'].reason, /does not decode/);
  assert.match(rejects['https://plain.example/vp'].reason, /HTTP 404/);
  const again = await upgradeToHttps([entry('plain', 'http://plain.example/vp')], { rejects, now: 2000, fetchImpl });
  assert.equal(again.size, 0, 'a recent failure is not retried');
});
