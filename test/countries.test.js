import assert from 'node:assert/strict';
import test from 'node:test';
import { countryAt, withCoveredCountries, withInferredCountries } from '../src/harvest/countries.js';

const entry = (bbox, countries) => ({ id: 'e', coverage: { bbox, countries } });

test('countries: a catalogue country whose boxes all miss the bbox is dropped (ZET Zagreb listed as BY), none is added', () => {
  assert.deepEqual(withCoveredCountries(entry([45.6976, 15.7986, 45.93, 16.1534], ['BY'])).coverage.countries, []);
  assert.deepEqual(withCoveredCountries(entry([45.6976, 15.7986, 45.93, 16.1534], ['BY', 'HR'])).coverage.countries, ['HR']);
});

test('countries: a country that the bbox lies in is kept', () => {
  const e = entry([45.6976, 15.7986, 45.93, 16.1534], ['HR']);
  assert.equal(withCoveredCountries(e), e);
});

test('countries: an overseas territory counts for its country (Martinique, FR)', () => {
  const e = entry([14.55, -61.1, 14.7, -60.95], ['FR']);
  assert.equal(withCoveredCountries(e), e);
});

test('countries: a country split at the antimeridian counts by its parts (Fiji east of 180°, the Aleutians)', () => {
  const fiji = entry([-16.9, -179.99, -16.75, -179.85], ['FJ']);
  assert.equal(withCoveredCountries(fiji), fiji);
  const adak = entry([51.8, -176.7, 51.9, -176.6], ['US']);
  assert.equal(withCoveredCountries(adak), adak);
});

test('countries: a code missing from the table is kept', () => {
  const e = entry([45.6976, 15.7986, 45.93, 16.1534], ['ZZ']);
  assert.equal(withCoveredCountries(e), e);
});

test('countries: an entry without a bbox is left alone', () => {
  const e = entry(null, ['BY']);
  assert.equal(withCoveredCountries(e), e);
});

test('countries: territory Natural Earth draws for another unit still counts for its recognised country (Crimea, Northern Cyprus)', () => {
  const sevastopol = entry([44.5, 33.4, 44.7, 33.7], ['UA']);
  assert.equal(withCoveredCountries(sevastopol), sevastopol);
  const kyrenia = entry([35.3, 33.2, 35.4, 33.4], ['CY']);
  assert.equal(withCoveredCountries(kyrenia), kyrenia);
  const gibraltar = entry([36.1, -5.37, 36.16, -5.33], ['GI']);
  assert.equal(withCoveredCountries(gibraltar), gibraltar);
});

test('countries: an entry with none takes the country holding most of its bbox (Pierre-De Saurel, from Atlas)', () => {
  assert.deepEqual(withInferredCountries(entry([45.5046, -73.5417, 46.0603, -73.0795], [])).coverage.countries, ['CA']);
  assert.deepEqual(withInferredCountries(entry([42.25, -83.3, 42.45, -82.95], [])).coverage.countries, ['US'], 'Detroit, reaching into Windsor');
});

test('countries: a country inside another counts as itself (Lesotho in South Africa)', () => {
  assert.equal(countryAt(-29.31, 27.48), 'LS');
  assert.equal(countryAt(-26.2, 28.04), 'ZA');
});

test('countries: points Natural Earth draws for another unit or leaves at sea count for the recognised country', () => {
  assert.equal(countryAt(44.6, 33.52), 'UA', 'Sevastopol');
  assert.equal(countryAt(55.75, 37.6), 'RU', 'Moscow');
  assert.equal(countryAt(36.14, -5.35), 'GI', 'Gibraltar');
  assert.equal(countryAt(36.17, -5.35), 'ES', 'La Línea, north of the border');
  assert.equal(countryAt(35.33, 33.32), 'CY', 'Kyrenia');
  assert.equal(countryAt(9.56, 44.06), 'SO', 'Hargeisa');
});

test('countries: no country is inferred over existing ones, without a bbox, for a bbox over its class limit (global, or stretched by a stray point), or at sea', () => {
  for (const e of [
    entry([45.5046, -73.5417, 46.0603, -73.0795], ['FR']),
    entry(null, []),
    entry([-90, -180, 90, 180], []),
    entry([40, -40, 41, -39], []),
    entry([0, 0, 48, 10], []),
    { id: 'sensors', coverage: { class: 'global', bbox: [-90, -180, 90, 180], countries: [] } },
  ])
    assert.equal(withInferredCountries(e), e);
});
