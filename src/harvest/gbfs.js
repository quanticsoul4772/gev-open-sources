import { parseCsv } from '../util/csv.js';
import { fetchCapped } from '../util/http.js';
import { FORM_FACTORS } from '../schema.js';
import { hasCredential } from '../util/secrets.js';
import { normalizeUrl, slugId } from '../util/ids.js';
import { hostOfUrl, runPooled } from '../util/pool.js';
import { coordinate } from '../adapters/cameras.js';
import { plausibleBbox, recentlyRejected, replacesBbox, robustBbox, splitStrays, withoutStrays } from './catalogue.js';

export const GBFS_SYSTEMS_URL =
  'https://raw.githubusercontent.com/MobilityData/gbfs/master/systems.csv';

const json = (bytes) => JSON.parse(new TextDecoder().decode(bytes));

/**
 * Feed list from a gbfs.json document: v3 `data.feeds`, v1/v2
 * `data.<lang>.feeds` (English preferred).
 * @returns {{version: string|null, feeds: Record<string,string>}}
 */
export function gbfsFeeds(doc) {
  const data = doc?.data || {};
  let list = Array.isArray(data.feeds) ? data.feeds : null;
  if (!list) {
    const lang = data.en ? 'en' : Object.keys(data).find((k) => Array.isArray(data[k]?.feeds));
    list = lang ? data[lang].feeds : [];
  }
  const feeds = {};
  for (const f of list || []) if (f?.name && f?.url) feeds[f.name] = f.url;
  return { version: doc?.version ? String(doc.version) : null, feeds };
}

/** [lat, lon] of every station in a station_information document. */
const stationPoints = (doc) =>
  (Array.isArray(doc?.data?.stations) ? doc.data.stations : []).map((s) => [coordinate(s?.lat), coordinate(s?.lon)]);

/**
 * bbox [minLat, minLon, maxLat, maxLon] of a station_information document,
 * without stray stations (a test station abroad, swapped lat/lon).
 */
export function stationBbox(doc) {
  let b = null;
  for (const [lat, lon] of withoutStrays(stationPoints(doc))) {
    b = b
      ? [Math.min(b[0], lat), Math.min(b[1], lon), Math.max(b[2], lat), Math.max(b[3], lon)]
      : [lat, lon, lat, lon];
  }
  if (!b) return null;
  const r = (v) => Math.round(v * 1e4) / 1e4;
  return b.map(r);
}

/** Keyless systems from systems.csv rows. */
export function keylessSystems(rows) {
  return rows.filter(
    (r) =>
      !r['Authentication Type'] &&
      /^https:\/\//.test(r['Auto-Discovery URL']) &&
      !hasCredential(r['Auto-Discovery URL']),
  );
}

export { FORM_FACTORS };

/** Sorted unique v3 form factors of a vehicle_types document; empty means unknown. */
export function formFactors(doc) {
  const types = doc?.data?.vehicle_types;
  if (!Array.isArray(types)) return [];
  const out = new Set();
  for (const t of types) {
    const f = String(t?.form_factor || '').toLowerCase();
    if (!f) continue;
    out.add(f === 'scooter' ? 'scooter_standing' : FORM_FACTORS.includes(f) ? f : 'other');
  }
  return [...out].sort();
}

/** Union of two bboxes (either may be null). */
const bboxUnion = (a, b) =>
  a && b ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : a || b;

/**
 * Fetch errors that are answers about the feed (too big, or redirected to
 * another host), not network failures: remembered as a reason, and not
 * counted by the host breaker.
 */
const ANSWER = /^(response over \d+ bytes|redirect to unlisted host .*)$/;
const answerReason = (message) => (message.startsWith('redirect') ? 'cross-host redirect' : 'over the size cap');

/**
 * Resolve one system's auto-discovery URL into the entries it wants: a
 * bike-share stations entry (station_status) and/or a free-floating vehicles
 * entry (vehicle_status, or free_bike_status before v3). A vehicles entry
 * needs vehicles without a station_id (docked vehicles belong to the stations
 * entry). An output it can't produce gets a reason, which the caller
 * remembers; network errors throw, so the caller's host breaker counts them
 * and nothing is remembered.
 * @param {{id: string, vehicleId: string, name: string, provider: string, country: string|null,
 *   discoveryUrl: string, systemId: string|null, catalogueLicence?: string|null,
 *   provenance: string[]}} system
 * @param {{want: {stations: boolean, vehicles: boolean}, fetchImpl?: typeof fetch, anyRedirect?: boolean}} options
 * @returns {Promise<{stations?: object, vehicles?: object, reasons: {stations?: string, vehicles?: string}}>}
 */
export async function resolveGbfsSystem(system, { want, fetchImpl, anyRedirect = false }) {
  const out = { reasons: {} };
  const fail = (reason) => {
    for (const kind of ['stations', 'vehicles']) if (want[kind]) out.reasons[kind] = reason;
    return out;
  };
  let discovery;
  try {
    discovery = await fetchCapped(system.discoveryUrl, { fetchImpl, anyRedirect, timeoutMs: 15_000 });
  } catch (error) {
    if (!ANSWER.test(error.message)) throw error;
    return fail(answerReason(error.message));
  }
  if (discovery.status !== 200) return fail(`discovery HTTP ${discovery.status}`);
  let parsed;
  try {
    parsed = gbfsFeeds(json(discovery.body));
  } catch {
    return fail('discovery is not JSON');
  }
  const { feeds } = parsed;
  const info = feeds.station_information;
  const sysInfo = feeds.system_information;
  if ([system.discoveryUrl, sysInfo].filter(Boolean).some(hasCredential)) return fail('keyed URL');
  const countries = system.country ? [system.country] : [];
  const common = {
    name: system.name,
    provider: system.provider,
    licence: { id: null, url: null, display: false, commercial: null, attribution: system.provider },
    licence_decision: { by: 'none', evidence: [], terms_sha256: null, at: null },
    provenance: system.provenance,
  };
  const gbfsMeta = (version, extra = {}) => ({
    system_id: system.systemId,
    version,
    ...extra,
    ...(system.catalogueLicence ? { catalogue_licence: system.catalogueLicence } : {}),
  });
  const access = (url, related) => ({ url, related, redirectHosts: [], unzip: null, headers: {}, min_interval_s: 60 });

  // Stations: for the stations entry, and for the vehicles entry's coverage.
  const status = feeds.station_status;
  const stationsKeyless = Boolean(status && info) && !hasCredential(status) && !hasCredential(info);
  let stationsBbox = null;
  if (stationsKeyless) {
    let stations = null;
    try {
      stations = await fetchCapped(info, { fetchImpl, timeoutMs: 15_000 });
    } catch (error) {
      // Too big or redirected away is an answer (no bbox), not a network failure for the host breaker.
      if (!ANSWER.test(error.message)) throw error;
    }
    if (stations?.status === 200)
      try {
        stationsBbox = stationBbox(json(stations.body));
      } catch {
        stationsBbox = null;
      }
  }
  if (want.stations) {
    if (!stationsKeyless) out.reasons.stations = 'no keyless station feeds';
    else if (!stationsBbox) out.reasons.stations = 'no located stations';
    else
      out.stations = {
        id: system.id,
        domain: 'bikeshare.stations',
        ...common,
        coverage: { bbox: stationsBbox, countries },
        access: access(status, {
          station_information: info,
          ...(sysInfo ? { system_information: sysInfo } : {}),
          gbfs: system.discoveryUrl,
        }),
        format: 'gbfs.station-status',
        gbfs: gbfsMeta(parsed.version),
      };
  }

  if (want.vehicles) {
    const url = feeds.vehicle_status || feeds.free_bike_status;
    const typesUrl = feeds.vehicle_types;
    if (!url) out.reasons.vehicles = 'no vehicle feed';
    else if ([url, typesUrl].filter(Boolean).some(hasCredential)) out.reasons.vehicles = 'keyed URL';
    else {
      let res = null;
      try {
        res = await fetchCapped(url, { fetchImpl, timeoutMs: 20_000 });
      } catch (error) {
        if (!ANSWER.test(error.message)) throw error;
        out.reasons.vehicles = answerReason(error.message);
      }
      if (res && res.status !== 200) out.reasons.vehicles = `vehicle feed HTTP ${res.status}`;
      else if (res) {
        let doc = null;
        try {
          doc = json(res.body);
        } catch {
          doc = null;
        }
        const list = doc?.data?.vehicles ?? doc?.data?.bikes;
        const free = Array.isArray(list) ? list.filter((v) => v && !v.station_id) : [];
        const bbox = bboxUnion(robustBbox(free.map((v) => [coordinate(v.lat), coordinate(v.lon)])), stationsBbox);
        if (!Array.isArray(list)) out.reasons.vehicles = 'no vehicle list';
        else if (!list.length) out.reasons.vehicles = 'empty feed';
        else if (!free.length) out.reasons.vehicles = 'no free-floating vehicles';
        else if (!bbox) out.reasons.vehicles = 'no located vehicles';
        else {
          let factors = [];
          if (typesUrl)
            try {
              const types = await fetchCapped(typesUrl, { fetchImpl, timeoutMs: 15_000, maxBytes: 2 * 2 ** 20 });
              if (types.status === 200) factors = formFactors(json(types.body));
            } catch {
              factors = [];
            }
          out.vehicles = {
            id: system.vehicleId,
            domain: 'sharedmobility.vehicles',
            ...common,
            coverage: { bbox, countries },
            access: access(url, {
              ...(typesUrl ? { vehicle_types: typesUrl } : {}),
              ...(sysInfo ? { system_information: sysInfo } : {}),
              gbfs: system.discoveryUrl,
            }),
            format: 'gbfs.vehicle-status',
            gbfs: gbfsMeta(parsed.version || (doc?.version ? String(doc.version) : null), { form_factors: factors }),
          };
        }
      }
    }
  }
  return out;
}

/**
 * Peer-to-peer car sharing: private owners' cars, often parked at home, with
 * ids that look stable per car. Left out of the directory (user decision,
 * 2026-10-14); fleet car sharing (company cars) stays. GBFS has no
 * peer-to-peer flag, so known operators are matched by name and host.
 */
const PEER_TO_PEER = /getaround|drivy|snappcar|\bturo\b|gomore|hiyacar|ouicar|locomotion/i;

/** Whether a system is peer-to-peer car sharing (by provider, name or discovery host). */
export const isPeerToPeer = (system) =>
  PEER_TO_PEER.test(`${system.provider} ${system.name} ${hostOfUrl(system.discoveryUrl)}`);

/** Reject-cache key for one output (`stations` | `vehicles`) of a system. */
export const outputKey = (discoveryUrl, kind) => `${discoveryUrl}#${kind}`;

/**
 * Repair coverage.bbox on existing GBFS entries whose box is malformed or
 * wider than one service area (built before stray stations were dropped):
 * rebuilt from station_information and, for vehicles entries, the
 * free-floating vehicles too. A national system keeps its box (replacesBbox).
 * @param {object[]} entries
 * @returns {Promise<Map<string, object>>} id → entry with the repaired bbox
 */
export async function fillGbfsCoverage(entries, { fetchImpl } = {}) {
  const todo = entries.filter((e) => e.access.related?.gbfs && !plausibleBbox(e.coverage.bbox));
  const doc = async (url) => {
    if (!url) return null;
    const res = await fetchCapped(url, { fetchImpl, timeoutMs: 20_000 });
    return res.status === 200 ? json(res.body) : null;
  };
  const rebuild = async (e) => {
    const info = e.access.related.station_information ?? gbfsFeeds(await doc(e.access.related.gbfs)).feeds.station_information;
    const infoDoc = await doc(info);
    const stations = stationBbox(infoDoc);
    let strays = splitStrays(stationPoints(infoDoc)).strays;
    if (e.domain !== 'sharedmobility.vehicles') return { bbox: stations, strays };
    const data = (await doc(e.access.url))?.data;
    const list = data?.vehicles ?? data?.bikes;
    const free = Array.isArray(list) ? list.filter((v) => v && !v.station_id) : [];
    const points = free.map((v) => [coordinate(v.lat), coordinate(v.lon)]);
    strays += splitStrays(points).strays;
    return { bbox: bboxUnion(robustBbox(points), stations), strays };
  };
  const rebuilt = await runPooled(todo, (e) => hostOfUrl(e.access.url), rebuild, { global: 16, perHost: 2 });
  const filled = new Map();
  todo.forEach((e, i) => {
    const r = rebuilt[i];
    if (r?.bbox && replacesBbox(e.coverage.bbox, r.bbox, r.strays))
      filled.set(e.id, { ...e, coverage: { ...e.coverage, bbox: r.bbox } });
  });
  return filled;
}

/** Stops starting new GBFS systems this long into a run (the job has 60 min). */
export const GBFS_PHASE_MS = 15 * 60_000;

/**
 * Resolve the outputs systems still lack. An output is wanted unless its id is
 * known, a directory entry already serves it (`knownOutputs` holds
 * `<normalized discovery URL>#<kind>`), or it was rejected recently. Systems
 * wanting only vehicles are capped at `vehicleBudget`; no system starts after
 * `deadlineMs`; a host is skipped after 3 consecutive network failures.
 * Peer-to-peer car sharing is skipped entirely (isPeerToPeer).
 * @param {object[]} systems as for resolveGbfsSystem
 * @param {{knownIds: Set<string>, knownOutputs: Set<string>, rejects: object, now: number,
 *   fetchImpl?: typeof fetch, anyRedirect?: boolean, vehicleBudget?: number, deadlineMs?: number}} options
 * @returns {Promise<object[]>} new entries; `rejects` is updated in place
 */
export async function resolveGbfsSystems(systems, options) {
  const { knownIds, knownOutputs, rejects, now, fetchImpl, anyRedirect = false } = options;
  const { vehicleBudget = Infinity, deadlineMs = Infinity } = options;
  const wanted = (s, kind) =>
    !knownIds.has(kind === 'stations' ? s.id : s.vehicleId) &&
    !knownOutputs.has(outputKey(normalizeUrl(s.discoveryUrl), kind)) &&
    !recentlyRejected(rejects, outputKey(s.discoveryUrl, kind), now);
  let vehiclesOnly = 0;
  const todo = [];
  for (const s of systems) {
    if (isPeerToPeer(s)) continue;
    const want = { stations: wanted(s, 'stations'), vehicles: wanted(s, 'vehicles') };
    if (!want.stations && !want.vehicles) continue;
    if (!want.stations) {
      if (vehiclesOnly >= vehicleBudget) continue;
      vehiclesOnly += 1;
    }
    todo.push({ s, want });
  }
  const results = await runPooled(
    todo,
    ({ s }) => hostOfUrl(s.discoveryUrl),
    ({ s, want }) => resolveGbfsSystem(s, { want, fetchImpl, anyRedirect }),
    { global: 24, perHost: 3, deadlineMs, breakAfter: 3 },
  );
  const entries = [];
  todo.forEach(({ s }, i) => {
    const r = results[i];
    if (!r || r.error || r.skipped) return;
    for (const kind of ['stations', 'vehicles']) {
      if (r[kind]) entries.push(r[kind]);
      else if (r.reasons[kind]) rejects[outputKey(s.discoveryUrl, kind)] = { reason: r.reasons[kind], at: now };
    }
  });
  return entries;
}

/**
 * systems.csv: the stations and vehicles entries keyless systems still lack.
 * @param {Parameters<typeof resolveGbfsSystems>[1]} options
 */
export async function harvestGbfs(options) {
  const res = await fetchCapped(GBFS_SYSTEMS_URL, { fetchImpl: options.fetchImpl });
  if (res.status !== 200) throw new Error(`GBFS systems.csv: HTTP ${res.status}`);
  const systems = keylessSystems(parseCsv(new TextDecoder().decode(res.body))).map((r) => ({
    id: slugId('gbfs', r['System ID']),
    vehicleId: slugId('gbfs', `${r['System ID']}-vehicles`),
    name: `${r.Name}${r.Location ? ` — ${r.Location}` : ''}`,
    provider: r.Name,
    country: r['Country Code'] || null,
    discoveryUrl: r['Auto-Discovery URL'],
    systemId: r['System ID'],
    provenance: [`gbfs-systems:${r['System ID']}`],
  }));
  return resolveGbfsSystems(systems, options);
}
