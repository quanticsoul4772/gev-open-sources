import assert from 'node:assert/strict';
import test from 'node:test';
import { cameraRecords, readPath } from '../src/adapters/cameras.js';
import { ADAPTERS } from '../src/adapters/index.js';
import { CAMERA_SOURCES } from '../src/harvest/cameras.js';
import { knownLicence } from '../src/licence/known.js';
import { MIN_SAMPLE_BYTES, probeEntry } from '../src/probe.js';
import { validateEntry } from '../src/schema.js';
import { schemaValidator } from '../src/validate-dist.js';

const json = (v) => new TextEncoder().encode(JSON.stringify(v));

test('camera paths: dot segments, array index, [key=value] pick', () => {
  const doc = { a: { list: [{ k: 'x', v: 1 }, { k: 'y', v: 2 }] }, c: [10, 20] };
  assert.equal(readPath(doc, 'a.list[k=y].v'), 2);
  assert.equal(readPath(doc, 'c.1'), 20);
  assert.equal(readPath(doc, ''), doc);
  assert.equal(readPath(doc, 'a.missing.deep'), undefined);
});

test('camera records: GeoJSON with a template, key/value lists with an active flag, string coordinates', () => {
  const digitraffic = CAMERA_SOURCES.find((e) => e.id === 'cameras-digitraffic-weathercam').mapping;
  const geo = { features: [{ geometry: { coordinates: [24.9, 60.2, 0] }, properties: { id: 'C1', name: 'Helsinki', presets: [{ id: 'C0101' }] } }] };
  assert.deepEqual(cameraRecords(geo, digitraffic), [{ id: 'C1', name: 'Helsinki', lat: 60.2, lon: 24.9, image: 'https://weathercam.digitraffic.fi/C0101.jpg' }]);

  const tfl = CAMERA_SOURCES.find((e) => e.id === 'cameras-tfl-jamcams').mapping;
  const cam = (id, available) => ({
    id,
    commonName: id,
    lat: 51.5,
    lon: -0.1,
    additionalProperties: [{ key: 'available', value: available }, { key: 'imageUrl', value: `https://s3.example/${id}.jpg` }],
  });
  assert.deepEqual(cameraRecords([cam('on', 'true'), cam('off', 'false')], tfl).map((c) => c.id), ['on']);

  const caltrans = CAMERA_SOURCES.find((e) => e.id === 'cameras-caltrans-d07').mapping;
  const ct = (index, lat, url, inService = 'true') => ({
    cctv: { index, inService, location: { locationName: 'I-110', latitude: lat, longitude: '-118.2' }, imageData: { static: { currentImageURL: url } } },
  });
  const records = cameraRecords({ data: [ct('1', '34.08', 'https://cwwp2.example/1.jpg'), ct('2', 'n/a', 'https://cwwp2.example/2.jpg'), ct('3', '34.1', 'http://cwwp2.example/3.jpg'), ct('4', '34.1', 'https://cwwp2.example/4.jpg', 'false')] }, caltrans);
  assert.deepEqual(records.map((c) => c.id), ['1'], 'bad coordinates, http images and out-of-service cameras skipped');
  assert.equal(records[0].lat, 34.08);
  assert.throws(() => cameraRecords({}, caltrans), /no camera list/);
});

test('camera probe: the list decodes and a sample image must be a real image', async () => {
  const source = CAMERA_SOURCES.find((e) => e.id === 'cameras-tfl-jamcams');
  const list = [{ id: 'a', commonName: 'A', lat: 51.5, lon: -0.1, additionalProperties: [{ key: 'imageUrl', value: 'https://img.example/a.jpg' }] }];
  const probe = (image) =>
    probeEntry(source, {
      now: 1,
      fetchImpl: async (url) =>
        url === source.access.url
          ? new Response(json(list), { status: 200 })
          : new Response(image.body, { status: image.status ?? 200, headers: { 'content-type': image.type } }),
    });
  assert.equal((await probe({ body: new Uint8Array(MIN_SAMPLE_BYTES), type: 'image/jpeg' })).result, 'ok');
  assert.equal((await probe({ body: new Uint8Array(100), type: 'image/jpeg' })).result, 'decode', 'placeholder-sized');
  assert.equal((await probe({ body: '<html>', type: 'text/html' })).result, 'decode', 'not an image');
  assert.equal((await probe({ body: '', type: 'image/jpeg', status: 404 })).result, 'http');
  const decoded = ADAPTERS['cameras.list'](json(list), source.coverage.bbox, source);
  assert.equal(decoded.records, 1);
  assert.equal(decoded.sample, 'https://img.example/a.jpg');
});

test('camera entries: valid under both validators; mapping required; Digitraffic is a known licence', () => {
  const validate = schemaValidator();
  for (const e of CAMERA_SOURCES) {
    assert.deepEqual(validateEntry(e), [], e.id);
    assert.ok(validate(e), `${e.id}: ${JSON.stringify(validate.errors)}`);
  }
  const { mapping, ...noMapping } = CAMERA_SOURCES[0];
  assert.ok(mapping);
  assert.equal(validate(noMapping), false);
  assert.ok(validateEntry(noMapping).length > 0);
  const badTemplate = { ...CAMERA_SOURCES[0], mapping: { ...CAMERA_SOURCES[0].mapping, image_template: 'http://x.example/{value}' } };
  assert.ok(validateEntry(badTemplate).length > 0);
  assert.equal(validate(badTemplate), false);
  assert.equal(new Set(CAMERA_SOURCES.map((e) => e.id)).size, CAMERA_SOURCES.length);
  assert.equal(knownLicence(CAMERA_SOURCES[0].licence.url).display, true);
});
