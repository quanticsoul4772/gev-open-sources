/**
 * Catalogue country codes checked against the entry's own coverage: a
 * catalogue row can carry the wrong country (the Mobility Database lists ZET
 * Zagreb as BY), so a code whose country boxes all miss the entry's bbox is
 * dropped. Boxes: country-boxes.json (Natural Earth, public domain), one per
 * polygon part, so overseas territories and countries split by the
 * antimeridian are covered. The whole bbox is tested, not its centre: the
 * centre of an island group falls in the sea, and that of a multi-city system
 * in another country.
 */
import fs from 'node:fs';

const BOXES = JSON.parse(fs.readFileSync(new URL('./country-boxes.json', import.meta.url), 'utf8')).boxes;

/** A [minLat, minLon, maxLat, maxLon] box as boxes that don't cross the antimeridian (minLon > maxLon crosses it). */
const unwrapped = ([s, w, n, e]) => (w <= e ? [[s, w, n, e]] : [[s, w, n, 180], [s, -180, n, e]]);

const overlap = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/** Whether two boxes share any point, either may cross the antimeridian. */
const meets = (a, b) => unwrapped(a).some((x) => unwrapped(b).some((y) => overlap(x, y)));

/**
 * The entry without catalogue country codes whose boxes all miss its bbox.
 * Codes missing from the table are kept; none are added, so an entry may end
 * with no country. An entry without a bbox is returned as is.
 * @param {object} entry
 */
export function withCoveredCountries(entry) {
  const { bbox, countries } = entry.coverage;
  if (!bbox || !countries.length) return entry;
  const kept = countries.filter((code) => !BOXES[code] || BOXES[code].some((box) => meets(box, bbox)));
  if (kept.length === countries.length) return entry;
  for (const code of countries)
    if (!kept.includes(code)) console.log(`harvest: ${entry.id}: dropped country ${code}: none of its boxes meet the coverage bbox`);
  return { ...entry, coverage: { ...entry.coverage, countries: kept } };
}
