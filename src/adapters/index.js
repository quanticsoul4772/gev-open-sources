/**
 * Decoders the prober (and the app) can read. Each turns a response body into
 * `{records, newest, inCoverage}`: record count, newest timestamp in epoch
 * seconds (null if none), and the share of located records inside `bbox`.
 * A decoder may add `sample`: one URL the prober must also be able to fetch
 * (a camera image), checked for an image type and a minimum size.
 * Called as (body, bbox, entry); `entry` carries per-entry settings
 * (a camera list's `mapping`). A vehicle-position decoder adds `fingerprint`
 * (see vehicleFingerprint), so the prober can find two entries serving one feed.
 */
import { createHash } from 'node:crypto';
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

/** Fewest distinct vehicle ids a feed needs before its fingerprint means anything. */
export const MIN_FINGERPRINT_VEHICLES = 5;

/**
 * A hash of a feed's set of vehicle ids, the same whatever their order, or
 * null under MIN_FINGERPRINT_VEHICLES ids: a handful of buses at night can
 * match by chance. Two URLs for one feed give the same set; positions and
 * timestamps move between two probes, the ids don't.
 * @param {string[]} ids
 * @returns {string|null}
 */
export function vehicleFingerprint(ids) {
  const set = [...new Set(ids)].sort();
  if (set.length < MIN_FINGERPRINT_VEHICLES) return null;
  return createHash('sha256').update(set.join('\n')).digest('hex').slice(0, 16);
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
      fingerprint: vehicleFingerprint(vehicles.map((v) => v.id)),
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
  /**
   * GDACS event list: one Point feature per event. No freshness time: events
   * are edited at irregular intervals (hours apart), so the newest edit says
   * nothing about whether the feed is live.
   */
  'geojson.gdacs-events'(body, bbox) {
    const doc = JSON.parse(new TextDecoder().decode(body));
    if (doc?.type !== 'FeatureCollection' || !Array.isArray(doc.features)) throw new Error('not a FeatureCollection');
    const points = doc.features
      .map((f) => f?.geometry?.coordinates)
      .filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]))
      .map(([lon, lat]) => [lat, lon]);
    return { records: doc.features.length, newest: null, inCoverage: share(points, bbox) };
  },
  /**
   * NASA FIRMS active-fire CSV (MODIS or VIIRS columns, found by header name).
   * Freshness is the newest detection; data arrive up to 3 h after the
   * satellite pass and passes are hours apart, so it is stale only after 6 h.
   * A worldwide file with no rows (or HTML, e.g. a login page) is broken.
   */
  'csv.firms-active-fire'(body, bbox) {
    const lines = new TextDecoder().decode(body).split(/\r?\n/);
    const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const col = Object.fromEntries(['latitude', 'longitude', 'acq_date', 'acq_time'].map((h) => [h, header.indexOf(h)]));
    if (Object.values(col).includes(-1)) throw new Error('not a FIRMS CSV');
    const points = [];
    let newestMs = null;
    for (let i = 1; i < lines.length; i += 1) {
      if (!lines[i]) continue;
      const cells = lines[i].split(',');
      const lat = Number(cells[col.latitude]);
      const lon = Number(cells[col.longitude]);
      if (!cells[col.latitude] || !cells[col.longitude] || !(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) continue;
      points.push([lat, lon]);
      const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cells[col.acq_date]);
      const time = /^\d{1,4}$/.test(cells[col.acq_time]) ? cells[col.acq_time].padStart(4, '0') : null;
      if (!date || !time) continue;
      const ms = Date.UTC(+date[1], +date[2] - 1, +date[3], +time.slice(0, 2), +time.slice(2));
      if (newestMs === null || ms > newestMs) newestMs = ms;
    }
    if (!points.length) throw new Error('no fire rows');
    return {
      records: points.length,
      newest: newestMs === null ? null : Math.floor(newestMs / 1000),
      inCoverage: share(points, bbox),
      staleAfterS: 6 * 3600,
    };
  },
  /**
   * Sensor.Community `data.1h.json`: one record per sensor, its mean over the
   * last hour. Counts outdoor sensors with a plausible PM2.5 (P2) or PM10 (P1)
   * value; other sensor types share the file. `timestamp` is the sensor's
   * last sample, "YYYY-MM-DD HH:MM:SS" in UTC with no zone, so it is parsed
   * as UTC explicitly. An hourly file can be an hour behind: stale after 3 h.
   */
  'json.sensor-community'(body, bbox) {
    const doc = JSON.parse(new TextDecoder().decode(body));
    if (!Array.isArray(doc)) throw new Error('not a Sensor.Community array');
    const pm = (values, type) => {
      const v = Number(values.find((x) => x?.value_type === type)?.value);
      return Number.isFinite(v) && v >= 0 && v < 999;
    };
    const points = [];
    let newestMs = null;
    for (const record of doc) {
      if (Number(record?.location?.indoor) !== 0) continue;
      const lat = Number(record.location.latitude);
      const lon = Number(record.location.longitude);
      if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) continue;
      const values = Array.isArray(record.sensordatavalues) ? record.sensordatavalues : [];
      if (!pm(values, 'P1') && !pm(values, 'P2')) continue;
      points.push([lat, lon]);
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(record.timestamp)) continue;
      const ms = Date.parse(`${record.timestamp.replace(' ', 'T')}Z`);
      if (Number.isFinite(ms) && (newestMs === null || ms > newestMs)) newestMs = ms;
    }
    if (!points.length) throw new Error('no PM readings');
    return {
      records: points.length,
      newest: newestMs === null ? null : Math.floor(newestMs / 1000),
      inCoverage: share(points, bbox),
      staleAfterS: 3 * 3600,
    };
  },
  /**
   * Fire perimeters (GeoJSON from an ArcGIS query), read through the entry's
   * `mapping`. No freshness time: perimeters are mapped irregularly and can be
   * months old out of season, so an empty feed is idle, not stale. A cut-off
   * response, coordinates that aren't lon/lat, or a renamed id field all throw.
   */
  'geojson.fire-perimeters'(body, bbox, entry) {
    const doc = JSON.parse(new TextDecoder().decode(body));
    if (doc?.error) throw new Error('service error');
    if (doc?.type !== 'FeatureCollection' || !Array.isArray(doc.features)) throw new Error('not a FeatureCollection');
    if (doc.exceededTransferLimit === true || doc.properties?.exceededTransferLimit === true) throw new Error('response cut off');
    if (Number.isFinite(doc.numberMatched) && Number.isFinite(doc.numberReturned) && doc.numberReturned < doc.numberMatched)
      throw new Error('response cut off');
    const lonLat = ([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90;
    const firstRing = (g) => (g?.type === 'Polygon' ? g.coordinates?.[0] : g?.type === 'MultiPolygon' ? g.coordinates?.[0]?.[0] : null);
    const points = [];
    for (const f of doc.features) {
      const ring = firstRing(f?.geometry);
      if (Array.isArray(ring) && ring.length >= 4 && ring.every(lonLat)) points.push([ring[0][1], ring[0][0]]);
    }
    if (doc.features.length && !points.length) throw new Error('no lon/lat polygons');
    const idField = entry.mapping.id;
    if (doc.features.length && !doc.features.some((f) => f?.properties?.[idField] != null)) throw new Error(`no ${idField} values`);
    return { records: points.length, newest: null, inCoverage: share(points, bbox) };
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
