/**
 * Shared by the catalogue harvesters (Transitland Atlas, Transitous): the
 * licence a catalogue declares, and a one-off check that a GTFS-RT URL really
 * serves vehicle positions, which also gives the entry its coverage.
 */
import { decodeVehiclePositions } from '../adapters/gtfsRealtime.js';
import { knownLicence } from '../licence/known.js';
import { fetchCapped } from '../util/http.js';
import { hasCredential } from '../util/secrets.js';
import { normalizeUrl } from '../util/ids.js';
import { hostOfUrl, runPooled } from '../util/pool.js';

/** A rejected catalogue URL is checked again after this long. */
export const REJECT_RETRY_S = 7 * 86_400;

/**
 * Licence URL for an entry from a catalogue's SPDX id and/or licence URL. A
 * known SPDX id wins (as its spdx.org URL, which tier 1 recognises); otherwise
 * the catalogue's URL, which the licence job reads as terms.
 * @returns {string|null}
 */
export function catalogueLicenceUrl(spdx, url) {
  const spdxUrl = spdx ? `https://spdx.org/licenses/${spdx}` : null;
  if (spdxUrl && knownLicence(spdx)) return spdxUrl;
  if (/^https?:\/\/\S+$/i.test(url || '')) return url;
  return spdxUrl;
}

/** bbox [minLat, minLon, maxLat, maxLon] around points, padded by `pad` degrees. */
export function pointsBbox(points, pad = 0.02) {
  if (!points.length) return null;
  const r = (v) => Math.round(v * 1e4) / 1e4;
  let b = [90, 180, -90, -180];
  for (const [lat, lon] of points)
    b = [Math.min(b[0], lat), Math.min(b[1], lon), Math.max(b[2], lat), Math.max(b[3], lon)];
  return [
    r(Math.max(-90, b[0] - pad)),
    r(Math.max(-180, b[1] - pad)),
    r(Math.min(90, b[2] + pad)),
    r(Math.min(180, b[3] + pad)),
  ];
}

/**
 * Fetch a GTFS-RT URL once and decide whether it is a live vehicle-positions
 * feed. `retry` marks an answer that says nothing yet (an empty feed at
 * night); other rejections are remembered for REJECT_RETRY_S.
 * @returns {Promise<{ok: true, bbox: number[]} |
 *   {ok: false, reason: string, retry?: boolean}>}
 */
export async function checkVehicleFeed(url, { fetchImpl } = {}) {
  let res;
  try {
    res = await fetchCapped(url, { anyRedirect: true, fetchImpl });
  } catch (error) {
    return { ok: false, reason: `fetch: ${error.message}`.slice(0, 120) };
  }
  if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status}` };
  let feed;
  try {
    feed = decodeVehiclePositions(res.body);
  } catch {
    return { ok: false, reason: 'not GTFS-RT' };
  }
  const points = feed.vehicles.map((v) => [v.lat, v.lon]);
  const bbox = robustBbox(points);
  if (bbox) return { ok: true, bbox, strays: splitStrays(points).strays };
  if (feed.entityCount === 0) return { ok: false, reason: 'empty feed', retry: true };
  return { ok: false, reason: 'no vehicle positions' };
}

/** Whether a catalogue URL was rejected recently enough to skip. */
export const recentlyRejected = (rejects, url, now) =>
  Boolean(rejects[url]) && now - rejects[url].at < REJECT_RETRY_S;

/**
 * Turn catalogue GTFS-RT candidates into entries: skip URLs already in the
 * directory, carrying a credential, or rejected recently; check the rest.
 * @param {Array<{id: string, name: string, provider: string, url: string,
 *   licenceUrl: string|null, attribution: string|null, countries: string[],
 *   provenance: string[]}>} candidates
 * @param {{knownUrls: Set<string>, rejects: Record<string, {reason: string, at: number}>,
 *   now: number, fetchImpl?: typeof fetch}} options `rejects` is updated in place
 * @returns {Promise<object[]>} entries (licence undecided)
 */
export async function resolveTransitCandidates(candidates, { knownUrls, rejects, now, fetchImpl }) {
  const seen = new Set();
  const todo = candidates.filter((c) => {
    const key = normalizeUrl(c.url);
    if (seen.has(key) || knownUrls.has(key) || hasCredential(c.url)) return false;
    seen.add(key);
    return !recentlyRejected(rejects, c.url, now);
  });
  const checks = await runPooled(todo, (c) => hostOfUrl(c.url), (c) => checkVehicleFeed(c.url, { fetchImpl }), {
    global: 24,
    perHost: 2,
  });
  const entries = [];
  todo.forEach((c, i) => {
    const check = checks[i]?.error ? { ok: false, reason: 'check error' } : checks[i];
    if (!check.ok) {
      if (!check.retry) rejects[c.url] = { reason: check.reason, at: now };
      return;
    }
    delete rejects[c.url];
    entries.push({
      id: c.id,
      domain: 'transit.vehicles',
      name: c.name,
      provider: c.provider,
      coverage: { bbox: check.bbox, countries: c.countries },
      access: { url: c.url, redirectHosts: [], unzip: null, headers: {}, min_interval_s: 15 },
      format: 'gtfs-rt.vehicle-positions',
      licence: { id: null, url: c.licenceUrl, display: false, commercial: null, attribution: c.attribution || c.provider },
      licence_decision: { by: 'none', evidence: [], terms_sha256: null, at: null },
      provenance: c.provenance,
    });
  });
  return entries;
}

/**
 * Whether a bbox rebuilt for an entry replaces its current one: always when
 * the current one is missing or malformed. A merely wide one is replaced only
 * when the rebuild found strays and came out as one service area. A wide box
 * from real data (a national operator) stays, even when one snapshot covers
 * only part of it (Amtrak at night): replacing it would freeze the smaller
 * box, since plausible boxes are not checked again.
 * @param {number[]|null} current
 * @param {number[]|null} rebuilt
 * @param {number} strays points the rebuild dropped as strays
 */
export const replacesBbox = (current, rebuilt, strays) =>
  wellFormedBbox(rebuilt) && (!wellFormedBbox(current) || (strays > 0 && plausibleBbox(rebuilt)));

/**
 * Fill or repair coverage.bbox on transit entries from one fetch of their
 * vehicles (the app places a feed by its bbox and skips entries without one):
 * entries with no bbox, a malformed one, or one wider than one service area.
 * @param {object[]} entries
 * @returns {Promise<Map<string, object>>} id → entry with a bbox, for those filled
 */
export async function fillTransitCoverage(entries, { fetchImpl } = {}) {
  const todo = entries.filter((e) => e.domain === 'transit.vehicles' && !plausibleBbox(e.coverage.bbox));
  const checks = await runPooled(todo, (e) => hostOfUrl(e.access.url), (e) => checkVehicleFeed(e.access.url, { fetchImpl }), {
    global: 24,
    perHost: 2,
  });
  const filled = new Map();
  todo.forEach((e, i) => {
    if (checks[i]?.ok && replacesBbox(e.coverage.bbox, checks[i].bbox, checks[i].strays))
      filled.set(e.id, { ...e, coverage: { ...e.coverage, bbox: checks[i].bbox } });
  });
  return filled;
}

/** Most one service area spans: wider boxes are a national or global feed, or a data error. The app's limit. */
export const MAX_SPAN = { lat: 20, lon: 30 };

/** Whether a bbox is four in-range numbers with min ≤ max. */
export const wellFormedBbox = (b) =>
  Array.isArray(b) &&
  b.length === 4 &&
  b.every(Number.isFinite) &&
  b[0] >= -90 && b[2] <= 90 && b[1] >= -180 && b[3] <= 180 &&
  b[0] <= b[2] && b[1] <= b[3];

/** Whether a bbox is well formed and no bigger than one service area. */
export const plausibleBbox = (b) =>
  wellFormedBbox(b) && b[2] - b[0] <= MAX_SPAN.lat && b[3] - b[1] <= MAX_SPAN.lon;

const median = (sorted) => sorted[Math.floor((sorted.length - 1) / 2)];

/** Most points that may be dropped as strays: a larger far group is a real second area, not an error. */
const MAX_STRAY_SHARE = 0.05;

/**
 * Split points into a feed's main area and its strays. Strays are points out
 * of range, at (0,0), or beyond max(1°, 6 × the median distance) from the
 * median point: a test station on another continent, a point with latitude
 * and longitude swapped. Far points are only strays while they are few; a
 * larger far group is real service (a
 * national operator's other coast) and is kept. "Few" is at most 2, or 5 %
 * of the points.
 * @param {Array<[number, number]>} points [lat, lon]
 * @returns {{kept: Array<[number, number]>, strays: number}}
 */
export function splitStrays(points) {
  const ok = points.filter(
    ([lat, lon]) =>
      Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0),
  );
  const invalid = points.length - ok.length;
  if (ok.length < 3) return { kept: ok, strays: invalid };
  const mLat = median(ok.map((p) => p[0]).sort((a, b) => a - b));
  const mLon = median(ok.map((p) => p[1]).sort((a, b) => a - b));
  const cos = Math.cos((mLat * Math.PI) / 180);
  const dist = ok.map(([lat, lon]) => Math.hypot(lat - mLat, (lon - mLon) * cos));
  const limit = Math.max(1, 6 * median([...dist].sort((a, b) => a - b)));
  const kept = ok.filter((_, i) => dist[i] <= limit);
  const far = ok.length - kept.length;
  if (far > Math.max(2, Math.floor(MAX_STRAY_SHARE * ok.length))) return { kept: ok, strays: invalid };
  return { kept, strays: invalid + far };
}

/** The points of a feed's main area (splitStrays). */
export const withoutStrays = (points) => splitStrays(points).kept;

/**
 * bbox of points, robust to strays: points outside the main area are
 * dropped (withoutStrays), and with 20 or more points the 1st–99th percentile
 * is kept on each axis, so one vehicle parked in a far depot doesn't stretch
 * the box.
 * @param {Array<[number, number]>} points [lat, lon]
 */
export function robustBbox(points, pad = 0.02) {
  const ok = withoutStrays(points);
  if (!ok.length) return null;
  if (ok.length < 20) return pointsBbox(ok, pad);
  const lats = ok.map((p) => p[0]).sort((a, b) => a - b);
  const lons = ok.map((p) => p[1]).sort((a, b) => a - b);
  // Inward rounding: from 20 points on, at least the single most extreme point
  // on each side is trimmed.
  const lo = Math.ceil(0.01 * (ok.length - 1));
  const hi = Math.floor(0.99 * (ok.length - 1));
  return pointsBbox([[lats[lo], lons[lo]], [lats[hi], lons[hi]]], pad);
}
