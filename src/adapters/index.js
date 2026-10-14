/**
 * Decoders the prober (and the app) can read. Each turns a response body into
 * `{records, newest, inCoverage}`: record count, newest timestamp in epoch
 * seconds (null if none), and the share of located records inside `bbox`.
 * A decoder may add `sample`: one URL the prober must also be able to fetch
 * (a camera image), checked for an image type and a minimum size.
 * Called as (body, bbox, entry); `entry` carries per-entry settings
 * (a camera list's `mapping`).
 */
import { cameraRecords } from './cameras.js';
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
  /** Camera list read through the entry's mapping; no timestamps, so a sample image proves it live. */
  'cameras.list'(body, bbox, entry) {
    const cameras = cameraRecords(JSON.parse(new TextDecoder().decode(body)), entry.mapping);
    return {
      records: cameras.length,
      newest: null,
      inCoverage: share(cameras.map((c) => [c.lat, c.lon]), bbox),
      sample: cameras[0]?.image ?? null,
    };
  },
  /** USGS summary GeoJSON: freshness is when the file was generated, not the newest event. */
  'geojson.earthquakes'(body, bbox) {
    const doc = JSON.parse(new TextDecoder().decode(body));
    if (doc?.type !== 'FeatureCollection' || !Array.isArray(doc.features)) throw new Error('not a FeatureCollection');
    const generated = Number(doc.metadata?.generated);
    const points = doc.features
      .map((f) => f?.geometry?.coordinates)
      .filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]))
      .map(([lon, lat]) => [lat, lon]);
    return {
      records: doc.features.length,
      newest: Number.isFinite(generated) ? Math.floor(generated / 1000) : null,
      inCoverage: share(points, bbox),
    };
  },
});
