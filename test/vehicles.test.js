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
