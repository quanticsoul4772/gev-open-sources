import assert from 'node:assert/strict';
import test from 'node:test';
import { withCoveredCountries } from '../src/harvest/countries.js';

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

test('countries: land past the antimeridian counts (Fiji east of 180°, the Aleutians)', () => {
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
