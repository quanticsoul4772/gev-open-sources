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

/**
 * GBFS `last_updated`: POSIX seconds up to v2.3, RFC 3339 string in v3. Zero
 * or negative means no time (some feeds send 0 when empty), not 1970.
 */
export function gbfsTime(value) {
  let t = null;
  if (typeof value === 'number') t = value;
  else if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    t = Number.isFinite(n) ? n : Math.floor(Date.parse(value) / 1000);
  }
  return Number.isFinite(t) && t > 0 ? t : null;
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
  /**
   * GBFS vehicle_status (v3) / free_bike_status (v1-v2): records are the
   * free-floating vehicles, those without a station_id (docked ones belong to
   * the system's stations entry). `docked` is reported for logs.
   */
  'gbfs.vehicle-status'(body, bbox) {
    const doc = JSON.parse(new TextDecoder().decode(body));
    const list = doc?.data?.vehicles ?? doc?.data?.bikes;
    if (!Array.isArray(list)) throw new Error('no data.vehicles or data.bikes');
    const free = list.filter((v) => v && !v.station_id);
    const points = free
      .map((v) => [Number(v.lat), Number(v.lon)])
      .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0));
    return {
      records: free.length,
      docked: list.length - free.length,
      newest: gbfsTime(doc.last_updated),
      inCoverage: share(points, bbox),
    };
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
