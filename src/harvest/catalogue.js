/**
 * Shared by the catalogue harvesters (Transitland Atlas, Transitous): the
 * licence a catalogue declares, and a one-off check that a GTFS-RT URL really
 * serves vehicle positions, which also gives the entry its coverage.
 */
import { decodeVehiclePositions } from '../adapters/gtfsRealtime.js';
import { knownLicence } from '../licence/known.js';
import { fetchCapped, hasCredentialParam } from '../util/http.js';
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
  if (feed.vehicles.length)
    return { ok: true, bbox: pointsBbox(feed.vehicles.map((v) => [v.lat, v.lon])) };
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
    if (seen.has(key) || knownUrls.has(key) || hasCredentialParam(c.url)) return false;
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
