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

test('vehicle check: positions give a bbox; trip updates and empty feeds rejected; rate limits retried', async () => {
  const fetchImpl = fakeFetch({
    'https://a.example/vp': { body: feedBytes([[48.8, 2.3], [48.9, 2.4]]) },
    'https://a.example/tu': { body: feedBytes(['trip']) },
    'https://a.example/empty': { body: feedBytes([]) },
    'https://a.example/keyed': { body: 'no', status: 401 },
    'https://a.example/limited': { body: 'no', status: 429 },
    'https://a.example/busy': { body: 'no', status: 503, headers: { 'retry-after': '120' } },
    'https://a.example/down': { body: 'no', status: 503 },
  });
  const vp = await checkVehicleFeed('https://a.example/vp', { fetchImpl });
  assert.equal(vp.ok, true);
  assert.deepEqual(vp.bbox, pointsBbox([[48.8, 2.3], [48.9, 2.4]]));
  assert.deepEqual(await checkVehicleFeed('https://a.example/tu', { fetchImpl }), { ok: false, reason: 'no vehicle positions' });
  assert.deepEqual(await checkVehicleFeed('https://a.example/empty', { fetchImpl }), { ok: false, reason: 'empty feed' });
  assert.equal((await checkVehicleFeed('https://a.example/limited', { fetchImpl })).retry, true);
  assert.equal((await checkVehicleFeed('https://a.example/busy', { fetchImpl })).retry, true);
  assert.deepEqual(await checkVehicleFeed('https://a.example/down', { fetchImpl }), { ok: false, reason: 'HTTP 503' });
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

test('candidates: a rate-limited transit feed is not remembered; an empty one is, for 30 hours', async () => {
  const { recentlyRejected } = await import('../src/harvest/catalogue.js');
  const fetchImpl = fakeFetch({
    'https://a.example/limited': { body: 'no', status: 429 },
    'https://a.example/empty': { body: feedBytes([]) },
  });
  const base = { name: 'n', provider: 'p', licenceUrl: null, attribution: null, countries: [], provenance: ['test'] };
  const rejects = {};
  await resolveTransitCandidates(
    [{ ...base, id: 'c-l', url: 'https://a.example/limited' }, { ...base, id: 'c-e', url: 'https://a.example/empty' }],
    { knownUrls: new Set(), rejects, now: 1000, fetchImpl },
  );
  assert.equal(rejects['https://a.example/limited'], undefined);
  assert.equal(rejects['https://a.example/empty'].reason, 'empty feed');
  assert.equal(recentlyRejected(rejects, 'https://a.example/empty', 1000 + 29 * 3600), true);
  assert.equal(recentlyRejected(rejects, 'https://a.example/empty', 1000 + 30 * 3600), false);
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

test('coverage: stray points (a station abroad, swapped lat/lon) are dropped; a national spread is kept', async () => {
  const { plausibleBbox, withoutStrays } = await import('../src/harvest/catalogue.js');
  const { stationBbox } = await import('../src/harvest/gbfs.js');
  const santiago = Array.from({ length: 30 }, (_, i) => [-33.4 - (i % 6) / 100, -70.6 - Math.floor(i / 6) / 100]);
  const madrid = [40.4168, -3.7038];
  const swapped = [-70.62, -33.43];
  assert.equal(withoutStrays([...santiago, madrid, swapped]).length, 30);
  const box = stationBbox({ data: { stations: [...santiago, madrid].map(([lat, lon]) => ({ lat, lon })) } });
  assert.ok(plausibleBbox(box) && box[2] < -33, `Santiago only: ${box}`);
  // Amtrak-like: points spread across a continent stay.
  const national = [[47.6, -122.3], [34.0, -118.2], [41.9, -87.6], [40.7, -74.0], [29.9, -90.1], [42.4, -71.1]];
  assert.equal(withoutStrays(national).length, national.length);
  // Mostly one corridor plus a real west-coast group (> 5 %): the far group is service, not strays.
  const corridor = Array.from({ length: 40 }, (_, i) => [39 + i / 10, -77 + i / 10]);
  const west = [[34.05, -118.24], [37.8, -122.27], [47.6, -122.33], [45.52, -122.68]];
  assert.equal(withoutStrays([...corridor, ...west]).length, 44);
});

test('coverage: a far group on one fixed longitude or latitude is strays at any size; a depot is not', async () => {
  const { robustBbox, withoutStrays } = await import('../src/harvest/catalogue.js');
  const city = Array.from({ length: 32 }, (_, i) => [46.66 + (i % 8) / 200, -1.44 + Math.floor(i / 8) / 100]);
  // Impulsyon, 2026-10-24: three vehicles at lon 0.894805, 2° to 9° N (> 5 % of 35).
  const fixedLon = [[2.0978, 0.894805], [3.714466, 0.894805], [8.747816, 0.894805]];
  assert.equal(withoutStrays([...city, ...fixedLon]).length, 32);
  assert.ok(robustBbox([...city, ...fixedLon])[0] > 46, 'the box stays in La Roche-sur-Yon');
  const fixedLat = [[0.5, 10], [0.5, 14], [0.5, 20]];
  assert.equal(withoutStrays([...city, ...fixedLat]).length, 32);
  // Three vehicles parked at one far depot share both coordinates: a place, kept.
  const depot = [[48.85, 2.35], [48.85, 2.35], [48.85, 2.35]];
  assert.equal(withoutStrays([...city, ...depot]).length, 35);
});

test('coverage: a wide box from real data is kept when a snapshot covers only part of it', async () => {
  const { replacesBbox } = await import('../src/harvest/catalogue.js');
  const amtrak = [27.6, -122.9, 48.9, -70.5];
  const northeast = [38.9, -77.1, 42.4, -71.0];
  assert.equal(replacesBbox(amtrak, northeast, 0), false, 'no strays: the snapshot is partial, not the box wrong');
  assert.equal(replacesBbox(amtrak, northeast, 1), true, 'a stray stretched the old box');
  assert.equal(replacesBbox(null, northeast, 0), true);
  assert.equal(replacesBbox([2, 2, 1, 1], northeast, 0), true, 'malformed is always replaced');
});

test('coverage: a bbox must be well formed and one service area', async () => {
  const { plausibleBbox } = await import('../src/harvest/catalogue.js');
  assert.equal(plausibleBbox([48.8, 2.2, 48.9, 2.5]), true);
  assert.equal(plausibleBbox([4.8227, -52.3651, 4.9355, 52.2964]), false, 'flipped sign: 105° wide');
  assert.equal(plausibleBbox([47.26, 4.51, 78.25, 31.11]), false, 'a country out to Svalbard');
  assert.equal(plausibleBbox([2, 2, 1, 1]), false, 'min above max');
  assert.equal(plausibleBbox(null), false);
});

test('coverage: an oversized transit bbox is rebuilt from the vehicles; a national feed keeps its own', async () => {
  const { fillTransitCoverage } = await import('../src/harvest/catalogue.js');
  const fetchImpl = fakeFetch({
    // A bus reporting its longitude with the sign flipped stretched the old box.
    'https://a.example/city': { body: feedBytes([[4.93, -52.33], [4.92, -52.31], [4.94, -52.32], [4.9, 52.3]]) },
    // At night only the Northeast runs: a partial snapshot, not a wrong box.
    'https://a.example/national': { body: feedBytes([[40.7, -74.0], [42.4, -71.1], [38.9, -77.0]]) },
  });
  const entry = (id, url, bbox) => ({ id, domain: 'transit.vehicles', coverage: { bbox, countries: [] }, access: { url } });
  const filled = await fillTransitCoverage(
    [entry('city', 'https://a.example/city', [4.82, -52.37, 4.94, 52.3]), entry('national', 'https://a.example/national', [27, -123, 49, -70])],
    { fetchImpl },
  );
  assert.deepEqual([...filled.keys()], ['city']);
  assert.ok(filled.get('city').coverage.bbox[3] < -52);
});

test('coverage: an existing GBFS entry with a stray-stretched box is rebuilt from its stations', async () => {
  const { fillGbfsCoverage } = await import('../src/harvest/gbfs.js');
  const city = Array.from({ length: 12 }, (_, i) => ({ lat: 4.6 + i / 100, lon: -74.1 + i / 100 }));
  const fetchImpl = fakeFetch({
    'https://b.example/info': { body: JSON.stringify({ data: { stations: [...city, { lat: -23.4, lon: -46.4 }] } }) },
  });
  const entry = {
    id: 'bogota',
    domain: 'bikeshare.stations',
    coverage: { bbox: [-23.4, -74.1, 4.71, -46.4], countries: [] },
    access: { url: 'https://b.example/status', related: { station_information: 'https://b.example/info', gbfs: 'https://b.example/gbfs.json' } },
  };
  const filled = await fillGbfsCoverage([entry], { fetchImpl });
  assert.deepEqual(filled.get('bogota').coverage.bbox, [4.6, -74.1, 4.71, -73.99]);
});

test('coverage: a GBFS vehicles box stretched by vehicles on one fixed longitude is rebuilt', async () => {
  const { fillGbfsCoverage } = await import('../src/harvest/gbfs.js');
  const city = Array.from({ length: 32 }, (_, i) => ({ lat: 46.66 + (i % 8) / 200, lon: -1.44 + Math.floor(i / 8) / 100 }));
  const junk = [2.0978, 3.714466, 8.747816].map((lat) => ({ lat, lon: 0.894805 }));
  const fetchImpl = fakeFetch({
    'https://c.example/info': { body: JSON.stringify({ data: { stations: city.slice(0, 10) } }) },
    'https://c.example/vehicles': { body: JSON.stringify({ data: { vehicles: [...city, ...junk] } }) },
  });
  const entry = {
    id: 'impulsyon-vehicles',
    domain: 'sharedmobility.vehicles',
    coverage: { bbox: [3.6945, -1.4556, 46.723, 0.9148], countries: ['FR'] },
    access: { url: 'https://c.example/vehicles', related: { station_information: 'https://c.example/info', gbfs: 'https://c.example/gbfs.json' } },
  };
  const box = (await fillGbfsCoverage([entry], { fetchImpl })).get('impulsyon-vehicles')?.coverage.bbox;
  assert.ok(box && box[0] > 46 && box[3] < 0, `rebuilt in the city: ${box}`);
});

test('gdacs: entry valid; licence holds only while the feed still declares public domain', async () => {
  const { GDACS_ENTRIES, GDACS_LICENCE_URL } = await import('../src/harvest/gdacs.js');
  const { declarationPresent } = await import('../src/licence/index.js');
  for (const e of GDACS_ENTRIES) assert.deepEqual(validateEntry(e), [], e.id);
  const known = knownLicence(GDACS_LICENCE_URL);
  assert.equal(known.display, true);
  const rss = (copyright) => fakeFetch({ [GDACS_LICENCE_URL]: { body: `<rss><channel><copyright>${copyright}</copyright></channel></rss>` } });
  assert.equal(await declarationPresent(GDACS_LICENCE_URL, known.verify, rss('public domain')), true);
  assert.equal(await declarationPresent(GDACS_LICENCE_URL, known.verify, rss('© 2027 GDACS, all rights reserved')), false);
  assert.equal(await declarationPresent(GDACS_LICENCE_URL, known.verify, fakeFetch({ [GDACS_LICENCE_URL]: { body: 'busy', status: 503 } })), null, 'unreachable: unknown, not withdrawn');
  assert.equal(await declarationPresent(GDACS_LICENCE_URL, known.verify, fakeFetch({})), false, 'gone (404): withdrawn');
});

test('adapters: GDACS events counted, no freshness time, coverage share', () => {
  const doc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [157.4, 11.0] }, properties: { eventtype: 'TC', alertlevel: 'Orange' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-70.1, -33.5] }, properties: { eventtype: 'EQ', alertlevel: 'Red' } },
    ],
  };
  const body = new TextEncoder().encode(JSON.stringify(doc));
  assert.deepEqual(ADAPTERS['geojson.gdacs-events'](body, [-90, -180, 90, 180]), { records: 2, newest: null, inCoverage: 1 });
  assert.throws(() => ADAPTERS['geojson.gdacs-events'](new TextEncoder().encode('[]'), null), /FeatureCollection/);
});

test('firms: entries valid and referral-only until the licence job; no Suomi NPP; the FAQ licence is known', async () => {
  const { FIRMS_ENTRIES, FIRMS_LICENCE_URL } = await import('../src/harvest/firms.js');
  assert.equal(FIRMS_ENTRIES.length, 3);
  for (const e of FIRMS_ENTRIES) {
    assert.deepEqual(validateEntry(e), [], e.id);
    assert.equal(e.licence.display, false, 'the known licence is applied by the licence job');
    assert.equal(e.access.min_interval_s, 300, 'longer spacing would stop every candidate after one probe round');
  }
  assert.ok(!FIRMS_ENTRIES.some((e) => /suomi|snpp/i.test(e.access.url)), 'Suomi NPP ends 2 Nov 2026');
  const known = knownLicence(FIRMS_LICENCE_URL);
  assert.equal(known.id, 'NASA-FIRMS-open');
  assert.equal(known.display, true);
});

test('firms: NASA open-data policy is a plain known licence, applied without fetching the FAQ', async () => {
  const { FIRMS_LICENCE_URL } = await import('../src/harvest/firms.js');
  // earthdata.nasa.gov answers 403 to the Actions runner, so a verify fetch
  // would leave the entries referral-only on every run.
  assert.equal(knownLicence(FIRMS_LICENCE_URL).verify, undefined);
});

test('adapters: FIRMS CSV, MODIS and VIIRS columns; newest detection; broken files throw', () => {
  const csv = (text) => new TextEncoder().encode(text);
  const decode = (text) => ADAPTERS['csv.firms-active-fire'](csv(text), [-90, -180, 90, 180]);
  const viirs = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight\n';
  const modis = 'latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version,bright_t31,frp,daynight\n';
  const at = (iso) => Date.parse(iso) / 1000;
  const v = decode(`${viirs}17.9,34.0,311.1,0.61,0.54,2026-10-15,0001,N20,nominal,2.0NRT,298.9,1.78,N\n45.8,-120.1,330.2,0.4,0.4,2026-10-16,0945,N20,high,2.0NRT,290.1,5.2,D\n`);
  assert.deepEqual(v, { records: 2, newest: at('2026-10-16T09:45:00Z'), inCoverage: 1, staleAfterS: 6 * 3600 });
  const m = decode(`${modis}37.39,138.58,308.31,2,1.38,2026-10-15,45,T,51,6.1NRT,290.3,20.46,D\n`);
  assert.equal(m.newest, at('2026-10-15T00:45:00Z'), 'unpadded acq_time "45" is 00:45');
  const bom = decode(`﻿${viirs.replace('\n', '\r\n')}1,2,3,4,5,2026-10-16,1200,N21,low,2.0NRT,6,7,D\r\n`);
  assert.equal(bom.records, 1, 'BOM and CRLF');
  assert.equal(decode(`${viirs}x,2,3\n,,\n95,10,1,1,1,2026-10-16,1200,N20,low,v,1,1,D\n1,2,3,4,5,2026-10-16,1200,N20,low,v,6,7,D\n`).records, 1, 'bad rows skipped');
  assert.throws(() => decode('<!doctype html><title>Earthdata Login</title>'), /not a FIRMS CSV/);
  assert.throws(() => decode(viirs), /no fire rows/, 'an empty worldwide file is broken, not idle');
});

test('perimeters: BC, Ontario and Alberta entries valid, regional, referral-only until the licence job; all licences known', async () => {
  const { PERIMETER_ENTRIES } = await import('../src/harvest/perimeters.js');
  const { plausibleBbox } = await import('../src/harvest/catalogue.js');
  assert.deepEqual(PERIMETER_ENTRIES.map((e) => e.id), ['bc-wildfire-perimeters-current', 'ontario-fire-perimeters-in-year', 'alberta-wildfire-perimeters-active']);
  for (const e of PERIMETER_ENTRIES) {
    assert.deepEqual(validateEntry(e), [], e.id);
    assert.equal(e.coverage.class, 'regional');
    assert.equal(plausibleBbox(e.coverage.bbox, 'regional'), true, `${e.id} box within the regional limit`);
    assert.equal(e.licence.display, false);
    const known = knownLicence(e.licence.url);
    assert.ok(known, `${e.id} licence ${e.licence.url} is known`);
    assert.equal(known.display, true);
    assert.equal(known.verify, undefined, 'no page fetch');
  }
  assert.equal(knownLicence('https://www2.gov.bc.ca/gov/content/data/open-data/open-government-licence-bc').id, 'OGL-BC-2.0', 'the older BC URL too');
  assert.equal(knownLicence('https://www2.gov.bc.ca/gov/content?id=A519A56BC2BF44E4A008B33FCF527F61'), null, 'never every gov.bc.ca page');
  assert.equal(PERIMETER_ENTRIES[1].mapping.status, undefined, "Ontario's STATUS is the perimeter's, not the fire's");
  assert.equal(knownLicence(PERIMETER_ENTRIES[2].licence.url).id, 'OGL-AB-2.2');
  assert.equal(PERIMETER_ENTRIES[2].mapping.url, undefined, 'Alberta has no incident page');
});

test('adapters: fire perimeters through the mapping; empty is idle; cut-off, projected or renamed data throws', async () => {
  const { PERIMETER_ENTRIES } = await import('../src/harvest/perimeters.js');
  const [bc, on, ab] = PERIMETER_ENTRIES;
  const decode = (doc, entry = bc) => ADAPTERS['geojson.fire-perimeters'](new TextEncoder().encode(JSON.stringify(doc)), entry.coverage.bbox, entry);
  const ring = (lon, lat) => [[lon, lat], [lon + 0.01, lat], [lon + 0.01, lat + 0.01], [lon, lat]];
  const fc = (features, extra = {}) => ({ type: 'FeatureCollection', features, ...extra });
  const bcFire = (n, status = 'Out') => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring(-120.5, 50.1)] },
    properties: { FIRE_NUMBER: n, FIRE_SIZE_HECTARES: 4.6, FIRE_STATUS: status, TRACK_DATE: 1777014000000, FIRE_URL: null },
  });
  const onFire = { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [[ring(-87.8, 55.8)], [ring(-87.7, 55.9)]] }, properties: { FIRENUMB: 'NIP009', CUR_SIZE: 8.45, STATUS: 'F', DATE_MAPPED: 1790812800000 } };
  assert.deepEqual(decode(fc([bcFire('C40127'), bcFire('C22352', null)])), { records: 2, newest: null, inCoverage: 1 });
  assert.deepEqual(decode(fc([onFire]), on), { records: 1, newest: null, inCoverage: 1 });
  assert.deepEqual(decode(fc([])), { records: 0, newest: null, inCoverage: null }, 'out of season: idle, not stale');
  assert.throws(() => decode(fc([bcFire('a')], { exceededTransferLimit: true })), /cut off/);
  assert.throws(() => decode(fc([bcFire('a')], { properties: { exceededTransferLimit: true } })), /cut off/);
  assert.throws(() => decode(fc([bcFire('a')], { numberMatched: 313, numberReturned: 5 })), /cut off/);
  const projected = { ...bcFire('a'), geometry: { type: 'Polygon', coordinates: [ring(1200000, 500000)] } };
  assert.throws(() => decode(fc([projected])), /lon\/lat/, 'BC Albers metres, not degrees');
  assert.throws(() => decode(fc([onFire])), /no FIRE_NUMBER/, 'a renamed id field');
  assert.throws(() => decode({ error: { code: 400, message: 'Invalid query' } }), /service error/);
  assert.throws(() => decode([]), /FeatureCollection/);
  const abFire = {
    type: 'Feature',
    geometry: { type: 'MultiPolygon', coordinates: [[ring(-115.4, 54.1)], [ring(-115.3, 54.2)]] },
    properties: { FireNumber: 'HWF-094-2026', AREA_ESTIMATE: 12599.94, FIRE_STATUS: 'Assistance Started', CaptreDate: 1784566800000 },
  };
  assert.deepEqual(decode(fc([abFire]), ab), { records: 1, newest: null, inCoverage: 1 });
  assert.throws(() => decode(fc([abFire]), bc), /no FIRE_NUMBER/, 'id field names are case-sensitive');
});

test('atlas licences: the realtime feed\'s own, else its operator\'s (borrowed); filled only where missing', async () => {
  const { atlasLicences, withAtlasLicences } = await import('../src/harvest/atlas.js');
  const docs = [
    {
      doc: {
        feeds: [
          { id: 'f-own~rt', spec: 'gtfs-rt', urls: { realtime_vehicle_positions: 'https://own.example/vp' }, license: { spdx_identifier: 'CC-BY-4.0', attribution_text: 'Own Transit' } },
          { id: 'f-sib~rt', spec: 'gtfs-rt', urls: { realtime_vehicle_positions: 'https://sib.example/vp' } },
          { id: 'f-sib', spec: 'gtfs', urls: { static_current: 'https://sib.example/gtfs.zip' }, license: { url: 'https://sib.example/terms' } },
          // Tied only through an aggregator's operator list: never borrows the aggregator's licence.
          { id: 'f-none~rt', spec: 'gtfs-rt', urls: { realtime_vehicle_positions: 'https://none.example/vp' } },
          {
            id: 'f-country~all',
            spec: 'gtfs',
            license: { spdx_identifier: 'CC-BY-4.0' },
            operators: [{ associated_feeds: [{ feed_onestop_id: 'f-none~rt' }, { feed_onestop_id: 'f-own~rt' }] }],
          },
          { id: 'f-key~rt', spec: 'gtfs-rt', urls: { realtime_vehicle_positions: 'https://key.example/vp' }, license: { url: 'https://key.example/terms?apikey=abc' } },
        ],
      },
    },
  ];
  const licences = atlasLicences(docs);
  assert.deepEqual(licences.get('https://own.example/vp'), { licenceUrl: 'https://spdx.org/licenses/CC-BY-4.0', attribution: 'Own Transit', feedId: 'f-own~rt', borrowed: false });
  assert.deepEqual(licences.get('https://sib.example/vp'), { licenceUrl: 'https://sib.example/terms', attribution: null, feedId: 'f-sib', borrowed: true });
  assert.equal(licences.has('https://none.example/vp'), false);
  assert.equal(licences.has('https://key.example/vp'), false, 'a licence URL with a credential is never used');

  const entry = (id, url, licenceUrl, provenance = ['mobilitydatabase:x']) => ({
    id, domain: 'transit.vehicles', provider: 'Op', access: { url }, provenance,
    licence: { id: null, url: licenceUrl, display: false, commercial: null, attribution: 'Op' },
  });
  const out = withAtlasLicences(
    [
      entry('missing', 'https://own.example/vp', null),
      entry('borrowed', 'https://sib.example/vp', null),
      entry('has', 'https://own.example/vp', 'https://op.example/terms'),
      entry('was-borrowed', 'https://own.example/vp', 'https://op.example/static-terms', ['mdb:x', 'licence-borrowed:mdb-1']),
      entry('via', 'https://final.example/vp', null, ['mdb:x', 'via:https://own.example/vp']),
    ],
    licences,
  );
  assert.deepEqual([...out.keys()], ['missing', 'borrowed', 'was-borrowed', 'via']);
  assert.equal(out.get('missing').licence.url, 'https://spdx.org/licenses/CC-BY-4.0');
  assert.equal(out.get('missing').licence.attribution, 'Own Transit');
  assert.ok(out.get('missing').provenance.includes('licence-atlas:f-own~rt'));
  assert.ok(out.get('borrowed').provenance.includes('licence-borrowed:atlas:f-sib'), 'tier 1 only');
  assert.deepEqual(out.get('was-borrowed').provenance, ['mdb:x', 'licence-atlas:f-own~rt'], 'the feed\'s own licence replaces a borrowed one');
  // An Atlas licence Atlas no longer gives (here: once borrowed from an aggregator) is taken back.
  const stale = withAtlasLicences(
    [entry('stale', 'https://none.example/vp', 'https://spdx.org/licenses/CC-BY-4.0', ['mdb:x', 'licence-borrowed:atlas:f-country~all'])],
    licences,
  );
  assert.equal(stale.get('stale').licence.url, null);
  assert.deepEqual(stale.get('stale').provenance, ['mdb:x']);
  // Unchanged: nothing to write.
  assert.equal(withAtlasLicences([out.get('missing')], licences).size, 0);
});

test('known licences: JCDecaux\'s Licence Ouverte (Etalab 1.0) allows display', () => {
  const k = knownLicence('https://developer.jcdecaux.com/files/Open-Licence-fr.pdf');
  assert.equal(k.id, 'etalab-1.0');
  assert.equal(k.display, true);
});

test('sensor community: entry valid, global, referral-only until the licence job; DbCL is a plain known licence', async () => {
  const { AIRQUALITY_ENTRIES, SENSOR_COMMUNITY_LICENCE_URL } = await import('../src/harvest/airquality.js');
  const { plausibleBbox } = await import('../src/harvest/catalogue.js');
  assert.equal(AIRQUALITY_ENTRIES.length, 1);
  const [e] = AIRQUALITY_ENTRIES;
  assert.deepEqual(validateEntry(e), []);
  assert.equal(e.domain, 'airquality.sensors');
  assert.equal(e.coverage.class, 'global', 'only hazard domains default to global');
  assert.equal(plausibleBbox(e.coverage.bbox, 'global'), true);
  assert.equal(e.licence.display, false, 'the known licence is applied by the licence job');
  assert.equal(e.access.min_interval_s, 300);
  assert.deepEqual(e.access.headers, {}, "the prober's User-Agent names this project; the app sends its own");
  const known = knownLicence(SENSOR_COMMUNITY_LICENCE_URL);
  assert.deepEqual({ ...known, key: undefined }, { key: undefined, id: 'DbCL-1.0', display: true, commercial: true, attribution: true });
  assert.equal(known.verify, undefined, 'the URL is the licence text, not a page to re-read');
  assert.equal(knownLicence('https://opendatacommons.org/licenses/dbcl/1.0/').id, 'DbCL-1.0');
});

test('adapters: Sensor.Community 1-hour file; outdoor PM sensors only; UTC timestamps; broken files throw', () => {
  const sensor = ({ indoor = 0, lat = '52.52', lon = '13.40', ts = '2026-10-16 22:59:16', values }) => ({
    timestamp: ts,
    location: { latitude: lat, longitude: lon, indoor, country: 'DE' },
    sensor: { sensor_type: { name: 'SDS011' } },
    sensordatavalues: values,
  });
  const pm = (p1, p2) => [
    { value_type: 'P1', value: String(p1) },
    { value_type: 'P2', value: String(p2) },
  ];
  const decode = (doc) => ADAPTERS['json.sensor-community'](new TextEncoder().encode(JSON.stringify(doc)), [-90, -180, 90, 180]);
  const result = decode([
    sensor({ values: pm(12.3, 7.1) }),
    sensor({ values: pm(4, 2), ts: '2026-10-16 23:00:41' }),
    sensor({ indoor: 1, values: pm(9, 5) }),
    sensor({ indoor: '1', values: pm(9, 5) }),
    sensor({ values: pm(-1, 'x') }),
    sensor({ values: pm(999.9, 999.9) }),
    sensor({ values: [{ value_type: 'temperature', value: '11.2' }] }),
    sensor({ lat: '', lon: 'x', values: pm(5, 3) }),
  ]);
  assert.deepEqual(result, {
    records: 2,
    newest: Date.UTC(2026, 9, 16, 23, 0, 41) / 1000,
    inCoverage: 1,
    staleAfterS: 3 * 3600,
  });
  assert.equal(decode([sensor({ values: pm(5, 'n/a') })]).records, 1, 'PM10 alone is a reading');
  assert.throws(() => decode({ error: 'x' }), /not a Sensor.Community array/);
  assert.throws(() => decode([sensor({ indoor: 1, values: pm(5, 3) })]), /no PM readings/);
});
