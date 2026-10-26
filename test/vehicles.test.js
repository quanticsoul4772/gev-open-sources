import assert from 'node:assert/strict';
import test from 'node:test';
import { ADAPTERS } from '../src/adapters/index.js';
import { robustBbox } from '../src/harvest/catalogue.js';
import { formFactors, outputKey, resolveGbfsSystem, resolveGbfsSystems } from '../src/harvest/gbfs.js';
import { knownOutputsOf } from '../src/harvest/index.js';
import { gbfsDecision } from '../src/licence/index.js';
import { validateEntry } from '../src/schema.js';
import { slugId } from '../src/util/ids.js';
import { runPooled } from '../src/util/pool.js';
import { schemaValidator } from '../src/validate-dist.js';

const json = (v) => new TextEncoder().encode(JSON.stringify(v));
const routes = (map) => async (url) => {
  const r = map[url];
  if (r === undefined) return new Response('not found', { status: 404 });
  if (r instanceof Error) throw r;
  return new Response(typeof r === 'string' ? r : JSON.stringify(r), { status: 200 });
};
const discovery = (base, names) => ({
  version: '3.0',
  data: { feeds: names.map((name) => ({ name, url: `${base}/${name}.json` })) },
});
const vehicle = (id, lat, lon, extra = {}) => ({ vehicle_id: id, lat, lon, ...extra });
const system = (base) => ({
  id: 'gbfs-x',
  vehicleId: 'gbfs-x-vehicles',
  name: 'X — City',
  provider: 'X',
  country: 'FR',
  discoveryUrl: `${base}/gbfs.json`,
  systemId: 'x',
  provenance: ['test'],
});

test('decoder: free-floating vehicles only; v2 bikes and v3 vehicles; last_updated 0 is no time', () => {
  const decode = ADAPTERS['gbfs.vehicle-status'];
  const v3 = decode(json({ last_updated: '2026-10-14T10:00:00Z', data: { vehicles: [vehicle('a', 48.8, 2.3), vehicle('b', 48.9, 2.4, { station_id: 's1' })] } }), [48, 2, 49, 3]);
  assert.deepEqual(v3, { records: 1, docked: 1, newest: Math.floor(Date.parse('2026-10-14T10:00:00Z') / 1000), inCoverage: 1 });
  const v2 = decode(json({ last_updated: 1700000000, data: { bikes: [vehicle('a', 1, 1), vehicle('b', 0, 0)] } }), null);
  assert.equal(v2.records, 2);
  assert.equal(v2.newest, 1700000000);
  assert.equal(decode(json({ last_updated: 0, data: { bikes: [] } }), null).newest, null, 'empty Bird feed');
  assert.throws(() => decode(json({ data: {} }), null), /no data\.vehicles/);
});

test('form factors: v3 enum, scooter → scooter_standing, unknown → other, none → []', () => {
  const doc = { data: { vehicle_types: [{ form_factor: 'scooter' }, { form_factor: 'car' }, { form_factor: 'hoverboard' }, { form_factor: 'car' }] } };
  assert.deepEqual(formFactors(doc), ['car', 'other', 'scooter_standing']);
  assert.deepEqual(formFactors({ data: { vehicle_types: [] } }), []);
  assert.deepEqual(formFactors(undefined), []);
});

test('robust bbox: strays and (0,0) dropped; 1st–99th percentile from 20 points', () => {
  const city = Array.from({ length: 99 }, (_, i) => [48.8 + (i % 10) / 100, 2.3 + Math.floor(i / 10) / 100]);
  const box = robustBbox([...city, [55.0, 10.0], [0, 0], [NaN, 1]]);
  assert.ok(box[2] < 49 && box[3] < 3, `a far depot doesn't stretch the box: ${box}`);
  assert.equal(robustBbox([[0, 0]]), null);
  assert.deepEqual(robustBbox([[10, 20]]), [9.98, 19.98, 10.02, 20.02]);
});

test('resolver: vehicles-only, both feeds, stations-only, docked-only, keyed, over the cap', async () => {
  const want = { stations: true, vehicles: true };
  const base = 'https://a.example';
  const vehiclesOnly = routes({
    [`${base}/gbfs.json`]: discovery(base, ['vehicle_status', 'vehicle_types', 'system_information']),
    [`${base}/vehicle_status.json`]: { data: { vehicles: [vehicle('v1', 48.85, 2.35)] } },
    [`${base}/vehicle_types.json`]: { data: { vehicle_types: [{ form_factor: 'scooter_standing' }] } },
  });
  const r1 = await resolveGbfsSystem(system(base), { want, fetchImpl: vehiclesOnly });
  assert.equal(r1.stations, undefined);
  assert.equal(r1.reasons.stations, 'no keyless station feeds');
  assert.equal(r1.vehicles.domain, 'sharedmobility.vehicles');
  assert.equal(r1.vehicles.access.url, `${base}/vehicle_status.json`);
  assert.deepEqual(r1.vehicles.gbfs.form_factors, ['scooter_standing']);
  assert.equal(r1.vehicles.access.related.system_information, `${base}/system_information.json`);
  assert.deepEqual(validateEntry(r1.vehicles), []);

  const both = routes({
    [`${base}/gbfs.json`]: discovery(base, ['station_status', 'station_information', 'free_bike_status']),
    [`${base}/station_information.json`]: { data: { stations: [{ lat: 48.8, lon: 2.3 }] } },
    [`${base}/free_bike_status.json`]: { version: '2.2', data: { bikes: [vehicle('b', 48.9, 2.4), vehicle('c', 48.8, 2.3, { station_id: 's' })] } },
  });
  const r2 = await resolveGbfsSystem(system(base), { want, fetchImpl: both });
  assert.equal(r2.stations.id, 'gbfs-x');
  assert.equal(r2.vehicles.id, 'gbfs-x-vehicles');
  assert.deepEqual(r2.vehicles.gbfs.form_factors, [], 'no vehicle_types: unknown, never guessed');
  assert.equal(r2.vehicles.gbfs.version, '3.0');
  assert.ok(r2.vehicles.coverage.bbox[0] <= 48.8 && r2.vehicles.coverage.bbox[2] >= 48.9, 'union with the stations');

  const docked = routes({
    [`${base}/gbfs.json`]: discovery(base, ['free_bike_status']),
    [`${base}/free_bike_status.json`]: { data: { bikes: [vehicle('c', 48.8, 2.3, { station_id: 's' })] } },
  });
  assert.equal((await resolveGbfsSystem(system(base), { want, fetchImpl: docked })).reasons.vehicles, 'no free-floating vehicles');

  const stationsOnly = routes({ [`${base}/gbfs.json`]: discovery(base, ['station_status', 'station_information']) });
  assert.equal((await resolveGbfsSystem(system(base), { want: { stations: false, vehicles: true }, fetchImpl: stationsOnly })).reasons.vehicles, 'no vehicle feed');

  const keyed = routes({ [`${base}/gbfs.json`]: { data: { feeds: [{ name: 'vehicle_status', url: `${base}/v.json?token=abc` }] } } });
  assert.equal((await resolveGbfsSystem(system(base), { want, fetchImpl: keyed })).reasons.vehicles, 'keyed URL');

  const huge = routes({
    [`${base}/gbfs.json`]: discovery(base, ['vehicle_status']),
    [`${base}/vehicle_status.json`]: 'x'.repeat(9 * 2 ** 20),
  });
  assert.equal((await resolveGbfsSystem(system(base), { want, fetchImpl: huge })).reasons.vehicles, 'over the size cap');

  const down = routes({ [`${base}/gbfs.json`]: discovery(base, ['vehicle_status']), [`${base}/vehicle_status.json`]: new Error('ECONNRESET') });
  await assert.rejects(resolveGbfsSystem(system(base), { want, fetchImpl: down }), /ECONNRESET/, 'network errors throw');
});

test('resolving systems: per-output skip logic, reject markers, vehicle budget', async () => {
  const sys = (n) => ({ ...system(`https://s${n}.example`), id: `gbfs-s${n}`, vehicleId: `gbfs-s${n}-vehicles` });
  const fetchImpl = async (url) => {
    const base = url.slice(0, url.indexOf('/', 8));
    if (url.endsWith('/gbfs.json')) return new Response(JSON.stringify(discovery(base, ['vehicle_status'])));
    return new Response(JSON.stringify({ data: { vehicles: [vehicle('v', 45, 7)] } }));
  };
  const rejects = { [outputKey('https://s3.example/gbfs.json', 'vehicles')]: { reason: 'no vehicle feed', at: 990 } };
  const knownOutputs = new Set([outputKey('https://s2.example/gbfs.json', 'vehicles'), outputKey('https://s2.example/gbfs.json', 'stations')]);
  const entries = await resolveGbfsSystems([sys(1), sys(2), sys(3), sys(4), sys(5)], {
    knownIds: new Set(['gbfs-s1', 'gbfs-s3', 'gbfs-s4', 'gbfs-s5']),
    knownOutputs,
    rejects,
    now: 1000,
    fetchImpl,
    vehicleBudget: 2,
  });
  // s1: vehicles wanted; s2: both served; s3: stations known, vehicles rejected recently;
  // s4, s5: vehicles wanted, but the budget of 2 is spent by s1 and s4.
  assert.deepEqual(entries.map((e) => e.id), ['gbfs-s1-vehicles', 'gbfs-s4-vehicles']);
  assert.ok(!rejects[outputKey('https://s1.example/gbfs.json', 'stations')], 'stations already known: not marked');
  const outputs = knownOutputsOf(new Map(entries.map((e) => [e.id, e])));
  assert.ok(outputs.has(outputKey('https://s1.example/gbfs.json', 'vehicles')));
});

test('ids: a vehicles id never collides with a stations id, even when hashed', () => {
  for (const sid of ['Bird_Paris', 'x'.repeat(80), 'lime_' + 'y'.repeat(70)]) {
    const s = slugId('gbfs', sid);
    const v = slugId('gbfs', `${sid}-vehicles`);
    assert.notEqual(s, v);
    assert.ok(v.length <= 64);
  }
});

test('pool: tasks after the deadline are skipped; a host is skipped after 3 failures', async () => {
  const late = await runPooled([1, 2, 3], () => 'h', async (x) => x, { deadlineMs: Date.now() - 1 });
  assert.deepEqual(late, [{ skipped: 'deadline' }, { skipped: 'deadline' }, { skipped: 'deadline' }]);
  let calls = 0;
  const broken = await runPooled(
    Array.from({ length: 6 }, (_, i) => i),
    () => 'down.example',
    async () => {
      calls += 1;
      throw new Error('timeout');
    },
    { perHost: 1, breakAfter: 3 },
  );
  assert.equal(calls, 3);
  assert.deepEqual(broken.slice(3), [{ skipped: 'host' }, { skipped: 'host' }, { skipped: 'host' }]);
});

test('licence: a vehicles entry without system_information stays undecided; one fetch per URL', async () => {
  const base = { licence: { id: null, url: null, display: false, commercial: null, attribution: 'X' }, provider: 'X' };
  const v3 = { ...base, format: 'gbfs.vehicle-status', gbfs: { version: '3.0', form_factors: [] }, access: { url: 'https://a.example/vehicle_status.json', related: {} } };
  const d = await gbfsDecision(v3, async () => new Response(JSON.stringify({ data: { vehicles: [] } })));
  assert.equal(d.decided.licence.display, false, 'never the CC0 default without system_information');
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    return new Response(JSON.stringify({ data: { name: 'X' } }));
  };
  const memo = new Map();
  const related = { system_information: 'https://a.example/system_information.json' };
  const r1 = await gbfsDecision({ ...v3, access: { ...v3.access, related } }, fetchImpl, memo);
  const r2 = await gbfsDecision({ ...v3, format: 'gbfs.station-status', access: { url: 'https://a.example/station_status.json', related } }, fetchImpl, memo);
  assert.equal(fetches, 1);
  assert.equal(r1.decided.licence_decision.by, 'gbfs-v3-default');
  assert.equal(r2.decided.licence.id, 'CC0-1.0');
});

test('schema: vehicles entries need valid form_factors under both validators', () => {
  const validate = schemaValidator();
  const entry = {
    id: 'gbfs-x-vehicles',
    domain: 'sharedmobility.vehicles',
    name: 'X',
    provider: 'X',
    coverage: { bbox: [48, 2, 49, 3], countries: ['FR'] },
    access: { url: 'https://a.example/vehicle_status.json', redirectHosts: [], unzip: null, headers: {}, min_interval_s: 60 },
    format: 'gbfs.vehicle-status',
    gbfs: { system_id: 'x', version: '3.0', form_factors: ['car', 'scooter_standing'] },
    licence: { id: null, url: null, display: false, commercial: null, attribution: 'X' },
    licence_decision: { by: 'none', evidence: [], terms_sha256: null, at: null },
    provenance: ['test'],
  };
  assert.ok(validate(entry), JSON.stringify(validate.errors));
  assert.deepEqual(validateEntry(entry), []);
  for (const bad of [{ ...entry.gbfs, form_factors: ['scooter'] }, { ...entry.gbfs, form_factors: ['car', 'car'] }, { system_id: 'x', version: '3.0' }]) {
    const e = { ...entry, gbfs: bad };
    assert.equal(validate(e), false, JSON.stringify(bad));
    assert.ok(validateEntry(e).length > 0, JSON.stringify(bad));
  }
});

test('peer-to-peer car sharing is left out; fleet car sharing stays', async () => {
  const { isPeerToPeer } = await import('../src/harvest/gbfs.js');
  const sys = (provider, discoveryUrl) => ({ provider, name: provider, discoveryUrl });
  assert.equal(isPeerToPeer(sys('Getaround', 'https://getaround.com/gbfs/v3/paris/gbfs.json')), true);
  assert.equal(isPeerToPeer(sys('City cars', 'https://gbfs.getaround.com/x/gbfs.json')), true, 'by host');
  assert.equal(isPeerToPeer(sys('Drivy', 'https://a.example/gbfs.json')), true);
  assert.equal(isPeerToPeer(sys('Turo', 'https://a.example/gbfs.json')), true);
  assert.equal(isPeerToPeer(sys('LocoMotion Montreal', 'https://locomotion.app/api/gbfs/3.0/montreal/gbfs')), true, 'neighbour-to-neighbour');
  assert.equal(isPeerToPeer(sys('Saturo Bikes', 'https://a.example/gbfs.json')), false, 'word boundary');
  for (const fleet of ['Flinkster', 'Stadtmobil Karlsruhe', 'Ford Carsharing', 'zeo Carsharing', 'Lime', 'Bird'])
    assert.equal(isPeerToPeer(sys(fleet, 'https://a.example/gbfs.json')), false, fleet);
  let fetched = 0;
  const entries = await resolveGbfsSystems([{ ...system('https://getaround.com/x'), provider: 'Getaround' }], {
    knownIds: new Set(), knownOutputs: new Set(), rejects: {}, now: 1,
    fetchImpl: async () => { fetched += 1; return new Response('{}'); },
  });
  assert.deepEqual(entries, []);
  assert.equal(fetched, 0, 'skipped before any fetch');
});

test('resolver: an oversized station_information means no stations bbox, not a network failure', async () => {
  const base = 'https://big.example';
  const fetchImpl = routes({
    [`${base}/gbfs.json`]: discovery(base, ['station_status', 'station_information', 'vehicle_status']),
    [`${base}/station_information.json`]: 'x'.repeat(9 * 2 ** 20),
    [`${base}/vehicle_status.json`]: { data: { vehicles: [vehicle('v', 45.1, 7.6)] } },
  });
  const r = await resolveGbfsSystem(system(base), { want: { stations: true, vehicles: true }, fetchImpl });
  assert.equal(r.reasons.stations, 'no located stations');
  assert.equal(r.vehicles.id, 'gbfs-x-vehicles', 'the vehicles entry still resolves');
});

test('review fixes: own feed is never system_information; blank coordinates are missing; cross-host redirect is an answer', async () => {
  const calls = [];
  const v3 = {
    format: 'gbfs.station-status',
    provider: 'X',
    gbfs: { version: '3.0' },
    licence: { id: null, url: null, display: false, commercial: null, attribution: 'X' },
    access: { url: 'https://a.example/gbfs/station_status?lang=en', related: {} },
  };
  const d = await gbfsDecision(v3, async (url) => (calls.push(url), new Response('{"data":{"stations":[]}}')));
  assert.equal(calls.length, 0, 'no guess when the sibling URL equals the entry URL');
  assert.equal(d.decided.licence.display, false);

  const { coordinate } = await import('../src/adapters/cameras.js');
  assert.ok(Number.isNaN(coordinate('')) && Number.isNaN(coordinate(null)) && Number.isNaN(coordinate(' ')));
  assert.equal(coordinate('0'), 0);
  assert.equal(coordinate('48.85'), 48.85);

  const base = 'https://hop.example';
  const fetchImpl = async (url) =>
    url.endsWith('/gbfs.json')
      ? new Response(JSON.stringify(discovery(base, ['vehicle_status'])))
      : new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/v.json' } });
  const r = await resolveGbfsSystem(system(base), { want: { stations: false, vehicles: true }, fetchImpl });
  assert.equal(r.reasons.vehicles, 'cross-host redirect');
});

test('review fixes: a second redirect keeps the earlier via: provenance', async () => {
  const { resolveRedirects } = await import('../src/harvest/redirects.js');
  const hops = { 'https://b.example/feed': 'https://c.example/feed' };
  const fetchImpl = async (url) =>
    hops[url] ? new Response(null, { status: 302, headers: { location: hops[url] } }) : new Response('ok');
  const entry = { id: 'e', access: { url: 'https://b.example/feed', redirectHosts: [] }, provenance: ['cat', 'via:https://a.example/permalink'] };
  const [moved] = await resolveRedirects([entry], fetchImpl);
  assert.deepEqual(moved.provenance, ['cat', 'via:https://a.example/permalink', 'via:https://b.example/feed']);
});

test('rejects: an empty vehicle feed is remembered for 30 hours, then checked again; other reasons for a week', async () => {
  const { recentlyRejected } = await import('../src/harvest/catalogue.js');
  const sys = (host) => ({ ...system(`https://${host}`), id: `gbfs-${host}`, vehicleId: `gbfs-${host}-vehicles` });
  const vehicles = { 'empty.example': [], 'docked.example': [vehicle('d', 45, 7, { station_id: 's' })] };
  const fetchImpl = async (url) => {
    const { host } = new URL(url);
    if (url.endsWith('/gbfs.json')) return new Response(JSON.stringify(discovery(`https://${host}`, ['vehicle_status'])));
    return new Response(JSON.stringify({ data: { vehicles: vehicles[host] } }));
  };
  const rejects = {};
  const now = 1_000_000;
  await resolveGbfsSystems([sys('empty.example'), sys('docked.example')], { knownIds: new Set(), knownOutputs: new Set(), rejects, now, fetchImpl });
  const empty = outputKey('https://empty.example/gbfs.json', 'vehicles');
  const docked = outputKey('https://docked.example/gbfs.json', 'vehicles');
  assert.equal(rejects[empty].reason, 'empty feed');
  assert.equal(rejects[docked].reason, 'no free-floating vehicles');
  assert.equal(recentlyRejected(rejects, empty, now + 6 * 3600), true, 'not retried next run');
  assert.equal(recentlyRejected(rejects, empty, now + 30 * 3600), false, 'checked again after 30 hours');
  assert.equal(recentlyRejected(rejects, docked, now + 30 * 3600), true);
  assert.equal(recentlyRejected(rejects, docked, now + 8 * 86_400), false);
});

test('rejects: a rate-limited system is not remembered, and a host answering only 429 trips the breaker', async () => {
  const sys = (host, n = 0) => ({
    ...system(`https://${host}`),
    discoveryUrl: `https://${host}/${n}/gbfs.json`,
    id: `gbfs-${host}-${n}`,
    vehicleId: `gbfs-${host}-${n}-vehicles`,
  });
  const limitedFeed = { 'feed429.example': 'vehicle_status', 'info429.example': 'station_information', 'types429.example': 'vehicle_types' };
  const calls = {};
  const fetchImpl = async (url) => {
    const { host } = new URL(url);
    calls[host] = (calls[host] || 0) + 1;
    const base = url.slice(0, url.lastIndexOf('/'));
    if (host === 'limited.example') return new Response('slow down', { status: 429 });
    if (host === 'busy.example') return new Response('busy', { status: 503, headers: { 'retry-after': '60' } });
    if (host === 'down.example') return new Response('down', { status: 503 });
    if (url.endsWith(`/${limitedFeed[host]}.json`)) return new Response('', { status: 429 });
    if (url.endsWith('/gbfs.json'))
      return new Response(JSON.stringify(discovery(base, ['station_status', 'station_information', 'vehicle_status', 'vehicle_types'])));
    if (url.endsWith('/station_information.json')) return new Response(JSON.stringify({ data: { stations: [{ lat: 45, lon: 7 }] } }));
    return new Response(JSON.stringify({ data: { vehicles: [vehicle('v', 45.1, 7.1)] } }));
  };
  const systems = [
    ...Array.from({ length: 10 }, (_, n) => sys('limited.example', n)),
    ...['busy.example', 'down.example', ...Object.keys(limitedFeed)].map((h) => sys(h)),
  ];
  const rejects = {};
  const entries = await resolveGbfsSystems(systems, {
    knownIds: new Set(),
    knownOutputs: new Set(),
    rejects,
    now: 1000,
    fetchImpl,
    requestGapMs: 0,
  });
  assert.equal(calls['limited.example'], 5, 'skipped after 3 rate-limited systems (2 more had started: perHost 3)');
  const down = (kind) => outputKey('https://down.example/0/gbfs.json', kind);
  assert.deepEqual(Object.keys(rejects).sort(), [down('stations'), down('vehicles')], 'only the plain 503 is remembered');
  assert.equal(rejects[down('vehicles')].reason, 'discovery HTTP 503');
  assert.deepEqual(entries, [], 'a rate-limited sub-feed defers the whole system to the next run');
});

test('http: Entur requests name the client in ET-Client-Name, on no other host and not after a redirect away', async () => {
  const { ENTUR_CLIENT_NAME, USER_AGENT, fetchCapped } = await import('../src/util/http.js');
  const seen = {};
  const fetchImpl = async (url, init) => {
    seen[new URL(url).hostname] = init.headers;
    if (url === 'https://api.entur.io/moved') return new Response(null, { status: 302, headers: { location: 'https://cdn.example/feed' } });
    return new Response('{}');
  };
  for (const url of ['https://api.entur.io/mobility/v2/gbfs/v3/manifest.json', 'https://entur.io/x', 'https://a.example/x', 'https://notentur.io/x'])
    await fetchCapped(url, { fetchImpl });
  assert.match(ENTUR_CLIENT_NAME, /^[a-z0-9_]+-[a-z0-9_-]+$/, '<company>-<application>');
  assert.equal(seen['api.entur.io']['ET-Client-Name'], ENTUR_CLIENT_NAME);
  assert.equal(seen['api.entur.io']['User-Agent'], USER_AGENT);
  assert.equal(seen['entur.io']['ET-Client-Name'], ENTUR_CLIENT_NAME);
  assert.equal(seen['a.example']['ET-Client-Name'], undefined);
  assert.equal(seen['notentur.io']['ET-Client-Name'], undefined);
  await fetchCapped('https://api.entur.io/moved', { fetchImpl, anyRedirect: true });
  assert.equal(seen['api.entur.io']['ET-Client-Name'], ENTUR_CLIENT_NAME);
  assert.equal(seen['cdn.example']['ET-Client-Name'], undefined, 'dropped on the hop to another host');
  assert.equal(seen['cdn.example']['User-Agent'], USER_AGENT);
});

test('http: the host limiter sends one request at a time per host, gapMs apart, and holds up no other host', async () => {
  const { fetchCapped, hostLimiter } = await import('../src/util/http.js');
  const t0 = Date.now();
  const log = [];
  const fetchImpl = async (url) => {
    const entry = { host: new URL(url).hostname, start: Date.now() - t0 };
    log.push(entry);
    await new Promise((r) => setTimeout(r, 20));
    entry.end = Date.now() - t0;
    return new Response('{}');
  };
  const limiter = hostLimiter(60);
  const urls = ['https://h.example/1', 'https://h.example/2', 'https://h.example/3', 'https://o.example/1'];
  const results = await Promise.all(urls.map((u) => fetchCapped(u, { fetchImpl, limiter })));
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200]);
  const h = log.filter((e) => e.host === 'h.example');
  for (let i = 1; i < h.length; i += 1) {
    assert.ok(h[i].start >= h[i - 1].end, `one in flight: ${JSON.stringify(h)}`);
    assert.ok(h[i].start - h[i - 1].start >= 55, `gap: ${JSON.stringify(h)}`);
  }
  assert.ok(log.find((e) => e.host === 'o.example').start < 15, 'another host starts at once');
  const broken = async () => {
    throw new Error('ECONNRESET');
  };
  await assert.rejects(fetchCapped('https://h.example/x', { fetchImpl: broken, limiter }), /ECONNRESET/);
  assert.equal((await fetchCapped('https://h.example/4', { fetchImpl, limiter })).status, 200, 'a failed request releases the host');
});

test('gbfs: every request of a resolution (discovery, stations, vehicles, types) goes through the host limiter', async () => {
  const sys = (n) => ({ ...system('https://one.example'), discoveryUrl: `https://one.example/${n}/gbfs.json`, id: `gbfs-${n}`, vehicleId: `gbfs-${n}-v` });
  const starts = [];
  let inFlight = 0;
  let most = 0;
  const fetchImpl = async (url) => {
    starts.push(Date.now());
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    const base = url.slice(0, url.lastIndexOf('/'));
    if (url.endsWith('/gbfs.json'))
      return new Response(JSON.stringify(discovery(base, ['station_status', 'station_information', 'vehicle_status', 'vehicle_types'])));
    if (url.endsWith('/station_information.json')) return new Response(JSON.stringify({ data: { stations: [{ lat: 45, lon: 7 }] } }));
    if (url.endsWith('/vehicle_types.json')) return new Response(JSON.stringify({ data: { vehicle_types: [] } }));
    return new Response(JSON.stringify({ data: { vehicles: [vehicle('v', 45.1, 7.1)] } }));
  };
  const entries = await resolveGbfsSystems([sys(1), sys(2)], {
    knownIds: new Set(),
    knownOutputs: new Set(),
    rejects: {},
    now: 1000,
    fetchImpl,
    requestGapMs: 40,
  });
  assert.equal(entries.length, 4);
  assert.equal(starts.length, 8);
  assert.equal(most, 1, 'one request in flight');
  starts.slice(1).forEach((t, i) => assert.ok(t - starts[i] >= 35, `gap ${t - starts[i]} ms`));
});

test('rejects: expiry is spread over a day per URL, the same for a URL every time', async () => {
  const { REJECT_RETRY_S, recentlyRejected, rejectRetryS, spreadS } = await import('../src/harvest/catalogue.js');
  const keys = Array.from({ length: 200 }, (_, i) => `https://f${i}.example/vp`);
  const rejects = Object.fromEntries(keys.map((k) => [k, { reason: 'HTTP 404', at: 0 }]));
  assert.ok(keys.every((k) => rejectRetryS(k, rejects[k]) >= REJECT_RETRY_S && rejectRetryS(k, rejects[k]) < REJECT_RETRY_S + 86_400));
  assert.equal(spreadS(keys[0]), spreadS(keys[0]));
  const due = (hours) => keys.filter((k) => !recentlyRejected(rejects, k, REJECT_RETRY_S + hours * 3600)).length;
  assert.ok(due(6) > 0 && due(6) < 100, `about a quarter due after one run: ${due(6)}`);
  assert.ok(due(12) > due(6) && due(18) > due(12) && due(24) === 200, `${due(6)} ${due(12)} ${due(18)} ${due(24)}`);
});
