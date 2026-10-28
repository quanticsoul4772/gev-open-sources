/**
 * Catalogue country codes checked against the entry's own coverage: a
 * catalogue row can carry the wrong country (the Mobility Database lists ZET
 * Zagreb as BY), so a code whose country boxes all miss the entry's bbox is
 * dropped. Boxes: country-boxes.json (Natural Earth, public domain), one per
 * polygon part, so overseas territories are covered and countries crossing the
 * antimeridian come as parts that don't (entry bboxes never cross it either). The whole bbox is tested, not its centre: the
 * centre of an island group falls in the sea, and that of a multi-city system
 * in another country.
 */
import fs from 'node:fs';
import { plausibleBbox } from './catalogue.js';

const BOXES = JSON.parse(fs.readFileSync(new URL('./country-boxes.json', import.meta.url), 'utf8')).boxes;

/** Whether two [minLat, minLon, maxLat, maxLon] boxes share any point. */
const meets = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

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

const OUTLINES = JSON.parse(fs.readFileSync(new URL('./country-outlines.json', import.meta.url), 'utf8'));
/** Every polygon with its country and outer ring's box, for point lookups. */
const POLYGONS = Object.entries(OUTLINES.countries).flatMap(([code, polygons]) =>
  polygons.map((rings) => {
    const lons = rings[0].map((p) => p[0]);
    const lats = rings[0].map((p) => p[1]);
    return { code, rings, box: [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)] };
  }),
);

/** Even-odd test of a [lon, lat] point against a ring of [lon, lat]. */
function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const meetsPoint = (box, lat, lon) => lat >= box[0] && lat <= box[2] && lon >= box[1] && lon <= box[3];

/** The country at a point, or null at sea (or on land the outlines simplified away). */
export function countryAt(lat, lon) {
  const found = POLYGONS.find((p) => meetsPoint(p.box, lat, lon) && inRing(lon, lat, p.rings[0]) && !p.rings.slice(1).some((hole) => inRing(lon, lat, hole)));
  const override = OUTLINES.overrides.find((o) => o.replaces.includes(found?.code ?? null) && meetsPoint(o.bbox, lat, lon));
  return override ? override.country : (found?.code ?? null);
}

/** Grid side of the points sampled across a bbox. */
const GRID = 9;

/**
 * The entry with the country holding most of its bbox, for an entry the
 * catalogue gave none (Transitland Atlas never does): a 9 × 9 grid of points
 * across the bbox, each looked up in country-outlines.json, and the country
 * with the most points on land. One country only: a second one is nearly
 * always a neighbour the bbox reaches into (Konstanz into Switzerland), and
 * a wrong code is worse than none. Checked on the published directory
 * (2026-10-27): it agrees with 1,960 of 1,969 catalogue countries, and of the
 * rest two are catalogue errors (French networks listed as BE). An entry with
 * countries, without a bbox, of class `global`, whose bbox is over its class's limit
 * (plausibleBbox: a global feed, or a box stretched by a stray vehicle that
 * a later run repairs, since an inferred code is never redone), or whose bbox
 * has no point on land (a ferry) is returned as is.
 * @param {object} entry
 */
export function withInferredCountries(entry) {
  const { bbox, countries } = entry.coverage;
  const cls = entry.coverage.class;
  if (!bbox || countries?.length || cls === 'global' || !plausibleBbox(bbox, cls)) return entry;
  const tally = new Map();
  for (let i = 0; i < GRID; i += 1)
    for (let j = 0; j < GRID; j += 1) {
      const code = countryAt(bbox[0] + ((i + 0.5) / GRID) * (bbox[2] - bbox[0]), bbox[1] + ((j + 0.5) / GRID) * (bbox[3] - bbox[1]));
      if (code) tally.set(code, (tally.get(code) || 0) + 1);
    }
  if (!tally.size) return entry;
  const [code] = [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return { ...entry, coverage: { ...entry.coverage, countries: [code] } };
}
