/**
 * The directory entry: what a source is, how to request it, which decoder
 * reads it, and what its licence allows. Health lives in health.json, not here.
 * `schema/entry.schema.json` is the published form of the same rules.
 */

export const DOMAINS = Object.freeze(['transit.vehicles', 'bikeshare.stations', 'hazards.earthquakes']);
export const FORMATS = Object.freeze([
  'gtfs-rt.vehicle-positions',
  'gbfs.station-status',
  'geojson.earthquakes',
]);
export const LICENCE_DECIDERS = Object.freeze([
  'known-licence',
  'gbfs-v3-default',
  'llm-terms',
  'none',
]);
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

const isUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};
const isBbox = (b) =>
  Array.isArray(b) &&
  b.length === 4 &&
  b.every(Number.isFinite) &&
  b[0] >= -90 &&
  b[2] <= 90 &&
  b[0] <= b[2] &&
  b[1] >= -180 &&
  b[3] <= 180 &&
  b[1] <= b[3];

/**
 * @param {any} entry
 * @returns {string[]} problems; empty when valid
 */
export function validateEntry(entry) {
  const errors = [];
  const need = (ok, message) => ok || errors.push(message);
  need(entry && typeof entry === 'object', 'entry is not an object');
  if (errors.length) return errors;
  need(ID_PATTERN.test(entry.id ?? ''), `id "${entry.id}" invalid`);
  need(DOMAINS.includes(entry.domain), `domain "${entry.domain}" unknown`);
  need(typeof entry.name === 'string' && entry.name, 'name missing');
  need(typeof entry.provider === 'string' && entry.provider, 'provider missing');
  const c = entry.coverage;
  need(c && (c.bbox === null || isBbox(c.bbox)), 'coverage.bbox invalid');
  need(Array.isArray(c?.countries), 'coverage.countries missing');
  const a = entry.access;
  need(a && isUrl(a.url), 'access.url invalid');
  need(Array.isArray(a?.redirectHosts), 'access.redirectHosts missing');
  need(a?.unzip === null || typeof a?.unzip === 'string', 'access.unzip invalid');
  need(
    a?.headers &&
      typeof a.headers === 'object' &&
      Object.values(a.headers).every((v) => typeof v === 'string'),
    'access.headers invalid',
  );
  need(Number.isFinite(a?.min_interval_s) && a.min_interval_s >= 0, 'access.min_interval_s invalid');
  if (a?.related)
    for (const [k, v] of Object.entries(a.related))
      need(isUrl(v), `access.related.${k} invalid`);
  need(FORMATS.includes(entry.format), `format "${entry.format}" unknown`);
  const l = entry.licence;
  need(l && typeof l.display === 'boolean', 'licence.display missing');
  need(l?.url === null || isUrl(l?.url), 'licence.url invalid');
  need(l?.commercial === null || typeof l?.commercial === 'boolean', 'licence.commercial invalid');
  const d = entry.licence_decision;
  need(d && LICENCE_DECIDERS.includes(d.by), 'licence_decision.by unknown');
  need(Array.isArray(d?.evidence), 'licence_decision.evidence missing');
  need(l?.display !== true || d?.by !== 'none', 'display without a licence decision');
  need(Array.isArray(entry.provenance) && entry.provenance.length > 0, 'provenance missing');
  return errors;
}
