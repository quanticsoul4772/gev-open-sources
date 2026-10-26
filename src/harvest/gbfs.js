import { parseCsv } from '../util/csv.js';
import { fetchCapped, hostLimiter, notNow } from '../util/http.js';
import { FORM_FACTORS } from '../schema.js';
import { hasCredential } from '../util/secrets.js';
import { normalizeUrl, slugId } from '../util/ids.js';
import { hostOfUrl, runPooled, withinPhase } from '../util/pool.js';
import { coordinate } from '../adapters/cameras.js';
import { plausibleBbox, recentlyRejected, replacesBbox, robustBbox, splitStrays, withoutStrays } from './catalogue.js';

export const GBFS_SYSTEMS_URL =
  'https://raw.githubusercontent.com/MobilityData/gbfs/master/systems.csv';

/** CityBikes' network list; only each network's own GBFS feed (gbfs_href) is used. */
export const CITYBIKES_URL = 'https://api.citybik.es/v2/networks?fields=id,name,gbfs_href,location';

/** Entur's list of the Norwegian systems it republishes as GBFS. */
export const ENTUR_GBFS_URL = 'https://api.entur.io/mobility/v2/gbfs';

/** Hosts whose GBFS feeds need a key the URL doesn't show (Deutsche Bahn's API marketplace). */
const KEYED_HOSTS = new Set(['apis.deutschebahn.com']);

/** Whether a listed auto-discovery URL can be fetched without a key. */
const keylessDiscovery = (url) =>
  /^https:\/\//.test(url || '') && !hasCredential(url) && !KEYED_HOSTS.has(hostOfUrl(url));

const json = (bytes) => JSON.parse(new TextDecoder().decode(bytes));

/** GBFS version path segments: `v2`, `v2.3`, `v3.0`, `3.0`. */
const VERSION_SEGMENT = /^(v\d+(\.\d+)*|\d+\.\d+)$/i;
/** Feed language path segments (`/en/gbfs.json`, `/fr/station_information.json`). */
const LANGUAGE_SEGMENT = /^(en|fr|de|nl|es|it|nb|nn|no|sv|da|fi|pt|pl|ca|eu)([-_][a-z]{2})?$/i;

/**
 * One key for the copies of a GBFS URL that differ only in version or
 * language: host and path without version segments, a language segment
 * among the last two, or a trailing gbfs.json / manifest.json.
 */
export function gbfsUrlKey(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return String(url);
  }
  let path = u.pathname.split('/').filter((p) => p && !VERSION_SEGMENT.test(p));
  if (/^(gbfs|manifest)\.json$/i.test(path.at(-1) || '')) path = path.slice(0, -1);
  path = path.filter((p, i) => i < path.length - 2 || !LANGUAGE_SEGMENT.test(p));
  return `${u.host.toLowerCase()}/${path.join('/')}${u.search}`;
}

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

/**
 * GBFS systems from CityBikes' network list: networks with a keyless
 * gbfs_href, so licences come from each operator's own feed.
 * @param {{networks?: object[]}} doc
 */
export function citybikesSystems(doc) {
  return (Array.isArray(doc?.networks) ? doc.networks : [])
    .filter((n) => n?.id && keylessDiscovery(n.gbfs_href))
    .map((n) => ({
      id: slugId('citybikes', n.id),
      vehicleId: slugId('citybikes', `${n.id}-vehicles`),
      name: `${n.name || n.id}${n.location?.city ? ` — ${n.location.city}` : ''}`,
      provider: n.name || n.id,
      country: n.location?.country || null,
      discoveryUrl: n.gbfs_href,
      systemId: null,
      provenance: [`citybikes:${n.id}`],
    }));
}

/**
 * GBFS systems from Entur's list. Its ids are the System IDs systems.csv
 * uses for the same systems, so they share entry ids.
 * @param {{systems?: Array<{id: string, url: string}>}} doc
 */
export function enturSystems(doc) {
  return (Array.isArray(doc?.systems) ? doc.systems : [])
    .filter((s) => s?.id && keylessDiscovery(s.url))
    .map((s) => ({
      id: slugId('gbfs', s.id),
      vehicleId: slugId('gbfs', `${s.id}-vehicles`),
      name: s.id,
      provider: 'Entur',
      country: 'NO',
      discoveryUrl: s.url,
      systemId: s.id,
      provenance: [`entur:${s.id}`],
    }));
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
 * A rate-limited response (notNow) is thrown, like a network failure: the
 * host breaker counts it and nothing is remembered, so the system is tried
 * again next run.
 */
const RATE_LIMITED = /^rate limited/;
const unlessLimited = (res) => {
  if (notNow(res)) throw new Error(`rate limited: HTTP ${res.status} from ${hostOfUrl(res.url)}`);
  return res;
};

/**
 * Resolve one system's auto-discovery URL into the entries it wants: a
 * bike-share stations entry (station_status) and/or a free-floating vehicles
 * entry (vehicle_status, or free_bike_status before v3). A vehicles entry
 * needs vehicles without a station_id (docked vehicles belong to the stations
 * entry). An output it can't produce gets a reason, which the caller
 * remembers; network errors and rate limits throw, so the caller's host
 * breaker counts them and nothing is remembered. Requests go through
 * `limiter` (hostLimiter) when given.
 * @param {{id: string, vehicleId: string, name: string, provider: string, country: string|null,
 *   discoveryUrl: string, systemId: string|null, catalogueLicence?: string|null,
 *   provenance: string[]}} system
 * @param {{want: {stations: boolean, vehicles: boolean}, fetchImpl?: typeof fetch, anyRedirect?: boolean,
 *   limiter?: ReturnType<typeof hostLimiter>}} options
 * @returns {Promise<{stations?: object, vehicles?: object, reasons: {stations?: string, vehicles?: string}}>}
 */
export async function resolveGbfsSystem(system, { want, fetchImpl, anyRedirect = false, limiter }) {
  const get = async (url, options) => unlessLimited(await fetchCapped(url, { fetchImpl, limiter, ...options }));
  const out = { reasons: {} };
  const fail = (reason) => {
    for (const kind of ['stations', 'vehicles']) if (want[kind]) out.reasons[kind] = reason;
    return out;
  };
  let discovery;
  try {
    discovery = await get(system.discoveryUrl, { anyRedirect, timeoutMs: 15_000 });
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
      stations = await get(info, { timeoutMs: 15_000 });
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
        res = await get(url, { timeoutMs: 20_000 });
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
              const types = await get(typesUrl, { timeoutMs: 15_000, maxBytes: 2 * 2 ** 20 });
              if (types.status === 200) factors = formFactors(json(types.body));
            } catch (error) {
              if (RATE_LIMITED.test(error.message)) throw error;
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
  // system_id and name, to tell a copy of a system served from another host.
  if ((out.stations || out.vehicles) && sysInfo)
    try {
      const res = await fetchCapped(sysInfo, { fetchImpl, timeoutMs: 15_000, maxBytes: 2 ** 20 });
      const data = res.status === 200 ? json(res.body)?.data : null;
      const name = Array.isArray(data?.name) ? data.name[0]?.text : data?.name;
      if (data?.system_id && name) out.system = { id: String(data.system_id), name: String(name) };
    } catch {
      out.system = null;
    }
  return out;
}

const VEHICLES = 'sharedmobility.vehicles';

/** Lower-case letters and digits only, accents dropped: `Vélo'v` → `velov`. */
const plain = (text) =>
  String(text)
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();

/**
 * Keys that identify one GBFS output whichever host, version or language
 * serves it: its feed URLs (gbfsUrlKey), a stations entry's bbox, and the
 * system's id and name together.
 * @param {object} entry
 * @param {{id?: string|null, name?: string|null}} [system]
 */
export function systemKeys(entry, system) {
  const kind = entry.domain === VEHICLES ? 'vehicles' : 'stations';
  const keys = [`${kind} url ${gbfsUrlKey(entry.access.url)}`];
  const info = entry.access.related?.station_information;
  if (info) keys.push(`${kind} url ${gbfsUrlKey(info)}`);
  if (kind === 'stations' && entry.coverage?.bbox) keys.push(`stations bbox ${entry.coverage.bbox.join(',')}`);
  if (system?.id && system?.name) keys.push(`${kind} system ${plain(system.id)} ${plain(system.name)}`);
  return keys;
}

/** systemKeys of the directory's GBFS entries (their name is the provider's). */
export function knownSystemKeysOf(entries) {
  const keys = new Set();
  for (const e of entries.values())
    if (e.access.related?.gbfs) for (const k of systemKeys(e, { id: e.gbfs?.system_id, name: e.provider })) keys.add(k);
  return keys;
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
  const todo = entries.filter((e) => e.access.related?.gbfs && !plausibleBbox(e.coverage.bbox, e.coverage.class));
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
    if (r?.bbox && replacesBbox(e.coverage.bbox, r.bbox, r.strays, e.coverage.class))
      filled.set(e.id, { ...e, coverage: { ...e.coverage, bbox: r.bbox } });
  });
  return filled;
}

/**
 * Time GBFS resolving may take per run, summed over its sources (Transitous,
 * transport.data.gouv.fr, systems.csv); the job has 60 min.
 */
export const GBFS_PHASE_MS = 15 * 60_000;

/**
 * Least time between two request starts to one host, with one request in
 * flight per host (hostLimiter): at most 240 requests a minute to one host
 * (Entur limits per minute; its number is not published). nextbike's ~208 systems × 2–4 requests at
 * ~0.5 s each take about 3.5–7 min, inside GBFS_PHASE_MS.
 */
export const GBFS_REQUEST_GAP_MS = 250;

/**
 * Resolve the outputs systems still lack. An output is wanted unless its id is
 * known or tombstoned, a directory entry already serves it (`knownOutputs` holds
 * `<normalized discovery URL>#<kind>`), an earlier list resolved it this run,
 * or it was rejected recently. Systems wanting only vehicles are capped at
 * `vehicleBudget`, counted across the run's lists in `vehiclesOnly`; no system starts after
 * the run's `gbfsPhase` budget is spent; each host gets one request at a time,
 * `requestGapMs` apart; a host is skipped after 3 consecutive network failures
 * or rate limits. Peer-to-peer car sharing is skipped entirely (isPeerToPeer).
 * A resolved output whose systemKeys match a directory entry (`knownSystems`)
 * or an output resolved earlier in the run is a copy: rejected as a duplicate.
 * Keys of resolved outputs are added to `knownSystems`.
 * @param {object[]} systems as for resolveGbfsSystem
 * @param {{knownIds: Set<string>, knownOutputs: Set<string>, knownSystems?: Set<string>, rejects: object,
 *   now: number, fetchImpl?: typeof fetch, anyRedirect?: boolean, vehicleBudget?: number,
 *   vehiclesOnly?: {count: number}, tombstones?: Record<string, unknown>, gbfsPhase?: {leftMs: number},
 *   requestGapMs?: number}} options
 * @returns {Promise<object[]>} new entries; `rejects` is updated in place
 */
export async function resolveGbfsSystems(systems, options) {
  const { knownIds, knownOutputs, rejects, now, fetchImpl, anyRedirect = false } = options;
  const {
    vehicleBudget = Infinity,
    gbfsPhase = { leftMs: Infinity },
    requestGapMs = GBFS_REQUEST_GAP_MS,
    knownSystems = new Set(),
    vehiclesOnly = { count: 0 },
    tombstones = {},
  } = options;
  const limiter = hostLimiter(requestGapMs);
  // Shared across the run's calls, so a system two lists name is added once.
  const seen = knownSystems;
  // An output resolved this run, by discovery URL: later lists leave it alone.
  const resolvedKey = (s, kind) => `resolved:${outputKey(normalizeUrl(s.discoveryUrl), kind)}`;
  const wanted = (s, kind) =>
    !knownIds.has(kind === 'stations' ? s.id : s.vehicleId) &&
    !tombstones[kind === 'stations' ? s.id : s.vehicleId] &&
    !seen.has(resolvedKey(s, kind)) &&
    !knownOutputs.has(outputKey(normalizeUrl(s.discoveryUrl), kind)) &&
    !recentlyRejected(rejects, outputKey(s.discoveryUrl, kind), now);
  const todo = [];
  // Outputs queued in this call, so a URL listed twice is fetched once.
  const queued = new Set();
  const listed = systems.filter((s) => !isPeerToPeer(s));
  // Systems wanting stations first: a vehicles-only copy of the same URL then
  // finds its vehicles queued and takes no cap slot.
  const ordered = [...listed.filter((s) => wanted(s, 'stations')), ...listed.filter((s) => !wanted(s, 'stations'))];
  for (const s of ordered) {
    const want = {};
    for (const kind of ['stations', 'vehicles']) want[kind] = wanted(s, kind) && !queued.has(resolvedKey(s, kind));
    if (!want.stations && !want.vehicles) continue;
    if (!want.stations) {
      if (vehiclesOnly.count >= vehicleBudget) continue;
      vehiclesOnly.count += 1;
    }
    for (const kind of ['stations', 'vehicles']) if (want[kind]) queued.add(resolvedKey(s, kind));
    todo.push({ s, want });
  }
  const results = await withinPhase(gbfsPhase, (deadlineMs) =>
    runPooled(
      todo,
      ({ s }) => hostOfUrl(s.discoveryUrl),
      ({ s, want }) => resolveGbfsSystem(s, { want, fetchImpl, anyRedirect, limiter }),
      { global: 24, perHost: 3, deadlineMs, breakAfter: 3 },
    ),
  );
  const entries = [];
  todo.forEach(({ s, want }, i) => {
    const r = results[i];
    if (!r || r.error || r.skipped) {
      // Nothing was learned, so the next run queues it again: give its cap slot back for later lists.
      if (!want.stations) vehiclesOnly.count -= 1;
      return;
    }
    for (const kind of ['stations', 'vehicles']) {
      if (r[kind]) {
        const keys = systemKeys(r[kind], r.system);
        if (keys.some((k) => seen.has(k))) rejects[outputKey(s.discoveryUrl, kind)] = { reason: 'duplicate', at: now };
        else {
          for (const k of [...keys, resolvedKey(s, kind)]) seen.add(k);
          entries.push(r[kind]);
        }
      } else if (r.reasons[kind]) rejects[outputKey(s.discoveryUrl, kind)] = { reason: r.reasons[kind], at: now };
    }
  });
  return entries;
}

/**
 * Systems from one extra list, or none if the list is unreachable or
 * malformed: the other lists still run.
 */
async function listedSystems(label, url, toSystems, { fetchImpl }) {
  try {
    // Entur's ET-Client-Name is added by fetchCapped.
    const res = await fetchCapped(url, { fetchImpl });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    return toSystems(json(res.body));
  } catch (error) {
    console.log(`harvest: ${label} list skipped: ${error.message}`);
    return [];
  }
}

/**
 * systems.csv, then CityBikes' and Entur's lists: the stations and vehicles
 * entries keyless systems still lack. A listed system whose id or discovery
 * URL (gbfsUrlKey) systems.csv, the directory or an earlier list item
 * already has is left out.
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
  const { fetchImpl, knownOutputs } = options;
  const citybikes = await listedSystems('citybikes', CITYBIKES_URL, citybikesSystems, { fetchImpl });
  const entur = await listedSystems('entur', ENTUR_GBFS_URL, enturSystems, { fetchImpl });
  const ids = new Set(systems.map((s) => s.id));
  const known = [...systems.map((s) => s.discoveryUrl), ...[...knownOutputs].map((k) => k.replace(/#[^#]*$/, ''))];
  const urls = new Set(known.map(gbfsUrlKey));
  const listed = [...citybikes, ...entur].filter((s) => {
    const url = gbfsUrlKey(s.discoveryUrl);
    if (ids.has(s.id) || urls.has(url)) return false;
    ids.add(s.id);
    urls.add(url);
    return true;
  });
  return resolveGbfsSystems([...systems, ...listed], options);
}
