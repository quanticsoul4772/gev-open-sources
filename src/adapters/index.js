/**
 * Decoders the prober (and the app) can read. Each turns a response body into
 * `{records, newest, inCoverage}`: record count, newest timestamp in epoch
 * seconds (null if none), and the share of located records inside `bbox`.
 */
import { decodeVehiclePositions } from './gtfsRealtime.js';

const inside = (bbox, lat, lon) =>
  !bbox || (lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]);

function share(points, bbox) {
  if (!points.length) return null;
  let n = 0;
  for (const [lat, lon] of points) if (inside(bbox, lat, lon)) n += 1;
  return Math.round((n / points.length) * 1000) / 1000;
}

/** GBFS `last_updated`: POSIX seconds up to v2.3, RFC 3339 string in v3. */
export function gbfsTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export const ADAPTERS = Object.freeze({
  'gtfs-rt.vehicle-positions'(body, bbox) {
    const feed = decodeVehiclePositions(body);
    const vehicles = feed.vehicles || [];
    let newest = Number.isFinite(feed.timestamp) ? feed.timestamp : null;
    for (const v of vehicles)
      if (Number.isFinite(v.timestamp) && (newest === null || v.timestamp > newest))
        newest = v.timestamp;
    return {
      records: vehicles.length,
      newest,
      inCoverage: share(vehicles.map((v) => [v.lat, v.lon]), bbox),
    };
  },
  'gbfs.station-status'(body) {
    const doc = JSON.parse(new TextDecoder().decode(body));
    const stations = doc?.data?.stations;
    if (!Array.isArray(stations)) throw new Error('no data.stations');
    return { records: stations.length, newest: gbfsTime(doc.last_updated), inCoverage: null };
  },
});
