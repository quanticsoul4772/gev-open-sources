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
  return overridden(found?.code ?? null, lat, lon);
}

/** The override's country where one covers the point and replaces `code`, else `code`. */
function overridden(code, lat, lon) {
  const override = OUTLINES.overrides.find((o) => o.replaces.includes(code) && meetsPoint(o.bbox, lat, lon));
  return override ? override.country : code;
}

/** How far the coast may be from a bbox centre with no land, in km. */
const NEAR_KM = 25;
const KM_PER_DEG_LAT = 110.57;

/**
 * The country whose outline is nearest a point, within NEAR_KM, else null:
 * for a small coastal bbox the 1:50m outlines put wholly at sea (a harbour
 * bus network, a short ferry). Distances are on a plane local to the point.
 */
export function countryNear(lat, lon) {
  const kmPerDegLon = KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  const dLat = NEAR_KM / KM_PER_DEG_LAT;
  const dLon = NEAR_KM / Math.max(kmPerDegLon, 1e-6);
  let best = null;
  let bestKm = NEAR_KM;
  let coast = null;
  for (const p of POLYGONS) {
    if (lat < p.box[0] - dLat || lat > p.box[2] + dLat || lon < p.box[1] - dLon || lon > p.box[3] + dLon) continue;
    for (const ring of p.rings)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const ax = (ring[j][0] - lon) * kmPerDegLon;
        const ay = (ring[j][1] - lat) * KM_PER_DEG_LAT;
        const bx = (ring[i][0] - lon) * kmPerDegLon;
        const by = (ring[i][1] - lat) * KM_PER_DEG_LAT;
        const len = (bx - ax) ** 2 + (by - ay) ** 2;
        const t = len ? Math.max(0, Math.min(1, -(ax * (bx - ax) + ay * (by - ay)) / len)) : 0;
        const [x, y] = [ax + t * (bx - ax), ay + t * (by - ay)];
        const km = Math.hypot(x, y);
        if (km < bestKm) [best, bestKm, coast] = [p.code, km, [lat + y / KM_PER_DEG_LAT, lon + x / Math.max(kmPerDegLon, 1e-6)]];
      }
  }
  // Overrides are checked at the coast found, not at the point at sea: their
  // boxes tell coasts apart (Crimea from the Taman shore), not the sea.
  return best && overridden(best, coast[0], coast[1]);
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
 * rest two are catalogue errors (French networks listed as BE). A bbox with
 * no grid point on land takes the country whose coast is nearest its centre
 * (countryNear), so a small coastal box the 1:50m outlines put at sea still
 * gets one; the four catalogue entries like that all agree (2026-10-28).
 * An entry with
 * countries, without a bbox, of class `global`, whose bbox is over its class's limit
 * (plausibleBbox: a global feed, or a box stretched by a stray vehicle that
 * a later run repairs, since an inferred code is never redone), or whose bbox
 * has no point on land and no coast within 25 km of its centre (countryNear)
 * is returned as is.
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
  const code = tally.size ? [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0] : countryNear((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2);
  if (!code) return entry;
  return { ...entry, coverage: { ...entry.coverage, countries: [code] } };
}
