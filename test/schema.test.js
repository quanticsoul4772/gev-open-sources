import assert from 'node:assert/strict';
import test from 'node:test';
import { gbfsText } from '../src/licence/index.js';
import { validateEntry } from '../src/schema.js';
import { BODS_ENTRY } from '../src/seed.js';
import { schemaValidator, validatePaths } from '../src/validate-dist.js';

const validate = schemaValidator();
const schemaOk = (e) => validate(e);
const handOk = (e) => validateEntry(e).length === 0;

const GBFS = {
  ...BODS_ENTRY,
  id: 'gbfs-example',
  domain: 'bikeshare.stations',
  format: 'gbfs.station-status',
  access: {
    url: 'https://bikes.example/station_status.json',
    related: { station_information: 'https://bikes.example/station_information.json' },
    redirectHosts: [],
    unzip: null,
    headers: {},
    min_interval_s: 60,
  },
  licence: { id: null, url: null, display: false, commercial: null, attribution: 'Bikes' },
  licence_decision: { by: 'none', evidence: [], terms_sha256: null, at: null },
  health: { status: 'verified', success_7d: 1, median_age_s: 20, records: 10, last_ok: 1, last_probe: 1 },
};

const set = (entry, path, value) => {
  const copy = structuredClone(entry);
  const keys = path.split('.');
  let o = copy;
  for (const k of keys.slice(0, -1)) o = o[k];
  if (value === undefined) delete o[keys.at(-1)];
  else o[keys.at(-1)] = value;
  return copy;
};

test('schema and hand validator agree: valid fixtures', () => {
  for (const e of [BODS_ENTRY, GBFS]) {
    assert.ok(schemaOk(e), JSON.stringify(validate.errors));
    assert.ok(handOk(e), validateEntry(e).join('; '));
  }
});

test('schema and hand validator agree: invalid fixtures', () => {
  const cases = {
    'bad id': set(GBFS, 'id', 'Bad ID'),
    'unknown domain': set(GBFS, 'domain', 'weather.radar'),
    'empty name': set(GBFS, 'name', ''),
    'latitude out of range': set(GBFS, 'coverage.bbox', [-95, 0, 10, 10]),
    'longitude out of range': set(GBFS, 'coverage.bbox', [0, -190, 10, 10]),
    'bbox of 3': set(GBFS, 'coverage.bbox', [0, 0, 10]),
    'countries missing': set(GBFS, 'coverage.countries', undefined),
    'ftp url': set(GBFS, 'access.url', 'ftp://bikes.example/s.json'),
    'non-ASCII url': set(GBFS, 'access.url', 'https://bikes.example/stjørdal/s.json'),
    'related not http': set(GBFS, 'access.related', { x: 'mailto:a@b.example' }),
    'unzip not a string': set(GBFS, 'access.unzip', 3),
    'header not a string': set(GBFS, 'access.headers', { Accept: 1 }),
    'negative interval': set(GBFS, 'access.min_interval_s', -1),
    'unknown format': set(GBFS, 'format', 'csv'),
    'display without a decision': set(GBFS, 'licence.display', true),
    'licence url javascript:': set(GBFS, 'licence.url', 'javascript:alert(1)'),
    'attribution not a string': set(GBFS, 'licence.attribution', [{ language: 'en', text: 'x' }]),
    'commercial not boolean': set(GBFS, 'licence.commercial', 'yes'),
    'unknown decider': set(GBFS, 'licence_decision.by', 'human'),
    'empty provenance': set(GBFS, 'provenance', []),
  };
  for (const [name, e] of Object.entries(cases)) {
    assert.equal(schemaOk(e), false, `schema accepts: ${name}`);
    assert.equal(handOk(e), false, `hand validator accepts: ${name}`);
  }
});

test('known gap: only the hand validator checks bbox min ≤ max (JSON Schema cannot)', () => {
  const inverted = set(GBFS, 'coverage.bbox', [10, 0, 0, 10]);
  assert.equal(handOk(inverted), false);
  assert.equal(schemaOk(inverted), true);
});

test('every committed entry passes both validators', () => {
  assert.deepEqual(validatePaths(['entries']), []);
});

test('GBFS localized text: English first, else the first non-empty', () => {
  assert.equal(gbfsText('Operator'), 'Operator');
  assert.equal(gbfsText([{ language: 'de', text: 'Betreiber' }, { language: 'en', text: 'Operator' }]), 'Operator');
  assert.equal(gbfsText([{ language: 'en', text: '' }, { language: 'fr', text: 'Opérateur' }]), 'Opérateur');
  assert.equal(gbfsText([{ language: 'en', text: '' }]), null);
  assert.equal(gbfsText(undefined), null);
});
