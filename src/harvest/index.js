/**
 * Discovery: add catalogued keyless feeds as entries. Feeds already present
 * (by id, exact URL or a permalink that led to it) and tombstoned dead feeds
 * are skipped; cross-domain permalinks are pointed at their final URL; catalogue URLs
 * that failed a check are remembered in harvest-rejects.json for a week.
 */
import { pathToFileURL } from 'node:url';
import { readEntries, readState, removeEntry, writeEntry, writeState } from '../store.js';
import { entryHasCredential } from '../util/secrets.js';
import { normalizeUrl } from '../util/ids.js';
import { harvestAtlas, withAtlasLicences } from './atlas.js';
import { harvestCameras } from './cameras.js';
import { REJECT_RETRY_S, fillTransitCoverage } from './catalogue.js';
import { GBFS_PHASE_MS, fillGbfsCoverage, harvestGbfs, isPeerToPeer, outputKey } from './gbfs.js';
import { upgradeToHttps } from './https.js';
import { harvestMobilityDatabase } from './mobilitydatabase.js';
import { resolveRedirects } from './redirects.js';
import { harvestTransitous } from './transitous.js';
import { USGS_ENTRIES } from './usgs.js';
import { FIRMS_ENTRIES } from './firms.js';
import { GDACS_ENTRIES } from './gdacs.js';
import { PERIMETER_ENTRIES } from './perimeters.js';
import { AIRQUALITY_ENTRIES } from './airquality.js';
import { isStaticEntry } from './static.js';

/**
 * New entries per run, as a share of the directory and of each domain: four
 * runs a day stay well inside the app's daily refresh limit (at most twice the
 * entries), and seven runs in 30 hours (1.08^7 ≈ 1.71) stay inside the build's
 * 1.8× size guard, so extra manual runs can't trip it. The rest wait.
 */
export const MAX_ADDED_RATIO = 0.08;

const VEHICLES = 'sharedmobility.vehicles';

/** `<normalized GBFS discovery URL>#stations|vehicles` for every GBFS output the directory already serves. */
export function knownOutputsOf(entries) {
  const out = new Set();
  for (const e of entries.values())
    if (e.access.related?.gbfs)
      out.add(outputKey(normalizeUrl(e.access.related.gbfs), e.domain === VEHICLES ? 'vehicles' : 'stations'));
  return out;
}

/** How many new entries a directory (or domain) of `size` may take in one run. */
export const addLimit = (size) => (size > 0 ? Math.max(1, Math.floor(size * MAX_ADDED_RATIO)) : Infinity);

/**
 * New entries this run may add, in priority order: at most addLimit of the
 * directory overall and of each domain (the app guards both).
 * @param {object[]} ready candidates in priority order
 * @param {Map<string, object>} existing
 */
export function withinAddLimits(ready, existing) {
  const domainSize = {};
  for (const e of existing.values()) domainSize[e.domain] = (domainSize[e.domain] || 0) + 1;
  const taken = {};
  const total = addLimit(existing.size);
  const out = [];
  for (const e of ready) {
    if (out.length >= total) break;
    if ((taken[e.domain] || 0) >= addLimit(domainSize[e.domain] || 0)) continue;
    taken[e.domain] = (taken[e.domain] || 0) + 1;
    out.push(e);
  }
  return out;
}

/**
 * A GTFS-Realtime entry without a `debug` query switch. Catalogues list some
 * feeds with one (`?debug`, `&Debug=True`), which returns a readable dump
 * instead of protobuf, so the feed never decodes. The old URL is kept as
 * provenance (`via:`), so catalogues listing it don't re-add the feed. The
 * rest of the URL is left byte for byte.
 */
export function withoutDebugSwitch(entry) {
  if (!entry.format?.startsWith('gtfs-rt.')) return entry;
  const url = entry.access.url
    .replace(/([?&])debug(?:=[^&#]*)?(&|(?=#)|$)/gi, (_, before, after) => (after === '&' ? before : ''))
    .replace(/\?(?=#|$)/, '');
  if (url === entry.access.url) return entry;
  return { ...entry, access: { ...entry.access, url }, provenance: [...entry.provenance, `via:${entry.access.url}`] };
}

/** An entry with its access URLs in plain ASCII form (`new URL().href`, e.g. ø → %C3%B8). */
export function withAsciiUrls(entry) {
  const ascii = (u) => new URL(u).href;
  return {
    ...entry,
    access: {
      ...entry.access,
      url: ascii(entry.access.url),
      ...(entry.access.related
        ? { related: Object.fromEntries(Object.entries(entry.access.related).map(([k, u]) => [k, ascii(u)])) }
        : {}),
    },
  };
}

/**
 * Entries whose URL may now redirect elsewhere: new candidates, and existing
 * entries whose last probe failed. Hand-written entries (FIRMS, perimeters,
 * USGS, GDACS, Sensor.Community) have fixed URLs: a redirect away (a login, a maintenance page)
 * must fail the probe, not be written into the entry.
 * @param {object[]} merged new candidates
 * @param {Map<string, object>} existing
 * @param {Record<string, object>} health
 */
export function redirectChecks(merged, existing, health) {
  const failing = new Set(['network', 'http']);
  return [
    ...merged,
    ...[...existing.values()].filter((e) => failing.has(health[e.id]?.history?.at(-1)?.result)),
  ].filter((e) => !isStaticEntry(e));
}

export function mergeCandidates(existing, candidates, tombstones) {
  const urls = new Set([...existing.values()].map((e) => normalizeUrl(e.access.url)));
  const added = [];
  for (const entry of candidates) {
    const url = normalizeUrl(entry.access.url);
    if (existing.has(entry.id) || urls.has(url) || tombstones[entry.id]) continue;
    urls.add(url);
    added.push(entry);
  }
  return added;
}

/** Normalized access, GBFS discovery and permalink (`via:`) URLs of the directory's entries. */
export function knownUrlsOf(entries) {
  const urls = new Set();
  for (const e of entries.values()) {
    urls.add(normalizeUrl(e.access.url));
    if (e.access.related?.gbfs) urls.add(normalizeUrl(e.access.related.gbfs));
    for (const p of e.provenance) if (p.startsWith('via:')) urls.add(normalizeUrl(p.slice(4)));
  }
  return urls;
}

export async function harvest(now = Math.floor(Date.now() / 1000)) {
  const existing = readEntries();
  // An entry with a URL that carries a credential is not keyless: drop it (it
  // may predate a stricter credential check).
  for (const [id, e] of existing)
    if (entryHasCredential(e)) {
      removeEntry(id);
      existing.delete(id);
      console.log(`harvest: removed ${id}: URL carries a credential`);
    }
  // Peer-to-peer car sharing is left out (user decision); an entry added before
  // its operator was recognised as peer-to-peer goes too.
  for (const [id, e] of existing)
    if (e.access.related?.gbfs && isPeerToPeer({ provider: e.provider, name: e.name, discoveryUrl: e.access.related.gbfs })) {
      removeEntry(id);
      existing.delete(id);
      console.log(`harvest: removed ${id}: peer-to-peer car sharing`);
    }
  // Debug switches came in with catalogue URLs: drop them from existing entries.
  for (const [id, e] of existing) {
    const clean = withoutDebugSwitch(e);
    if (clean === e) continue;
    existing.set(id, clean);
    writeEntry(clean);
    console.log(`harvest: ${id}: debug switch dropped from its URL`);
  }
  const tombstones = readState('tombstones.json', {});
  const rejects = readState('harvest-rejects.json', {});
  // Expired rejects are retried anyway; drop them so the file doesn't grow forever.
  for (const [key, r] of Object.entries(rejects)) if (now - r.at >= REJECT_RETRY_S) delete rejects[key];
  const knownIds = new Set(existing.keys());
  const knownOutputs = knownOutputsOf(existing);
  // Vehicle systems resolved beyond what the add limit can take are thrown away, so cap them.
  const vehicleSize = [...existing.values()].filter((e) => e.domain === VEHICLES).length;
  const vehicleBudget = 2 * addLimit(vehicleSize || existing.size);
  const gbfsOptions = { knownIds, knownOutputs, rejects, now, vehicleBudget, deadlineMs: Date.now() + GBFS_PHASE_MS };
  const mdb = await harvestMobilityDatabase();
  // Atlas and Transitous see the Mobility Database's feeds as known, so they
  // only check URLs that would be new.
  const knownUrls = knownUrlsOf(new Map([...existing, ...mdb.entries.map((e) => [e.id, e])]));
  const atlas = await harvestAtlas({ knownUrls, rejects, now });
  for (const e of atlas.entries) knownUrls.add(normalizeUrl(e.access.url));
  const transitous = await harvestTransitous({ ...gbfsOptions, knownUrls });
  const gbfs = await harvestGbfs(gbfsOptions);
  const cameras = await harvestCameras({ knownIds });
  const merged = mergeCandidates(
    existing,
    // Vehicles last, so a large first batch doesn't take the transit additions' slots.
    [
      ...USGS_ENTRIES,
      ...GDACS_ENTRIES,
      ...FIRMS_ENTRIES,
      ...PERIMETER_ENTRIES,
      ...AIRQUALITY_ENTRIES,
      ...cameras,
      ...mdb.entries,
      ...gbfs.filter((e) => e.domain !== VEHICLES),
      ...atlas.entries,
      ...transitous.entries.filter((e) => e.domain !== VEHICLES),
      ...gbfs.filter((e) => e.domain === VEHICLES),
      ...transitous.entries.filter((e) => e.domain === VEHICLES),
    ].map(withoutDebugSwitch),
    tombstones,
  );
  // New entries, and existing ones whose last probe failed, may be permalinks
  // that redirect to another domain: point them at the final URL. Two
  // catalogues can reach one feed through different permalinks, so new
  // entries are deduplicated again on their final URLs.
  const health = readState('health.json', {});
  const toCheck = redirectChecks(merged, existing, health);
  const redirected = new Map((await resolveRedirects(toCheck)).map((e) => [e.id, e]));
  const deduped = mergeCandidates(existing, merged.map((e) => redirected.get(e.id) || e), tombstones);
  // Transit entries need a bbox: fill missing ones from their vehicles. A new
  // entry still without one waits for a later run; an existing one keeps trying.
  // Existing GBFS entries with a broken box are rebuilt from their stations.
  // Plain-http feeds move to https when it serves the same data.
  const upgraded = await upgradeToHttps(
    [...deduped, ...[...existing.values()].map((e) => redirected.get(e.id) || e)],
    { rejects, now },
  );
  const fresh = deduped.map((e) => upgraded.get(e.id) || e);
  const updated = [...existing.values()].map((e) => upgraded.get(e.id) || redirected.get(e.id) || e);
  const covered = new Map([...(await fillTransitCoverage([...fresh, ...updated])), ...(await fillGbfsCoverage(updated))]);
  // Transit entries with no licence (or only a borrowed one) take Atlas's.
  const licensed = withAtlasLicences([...fresh, ...updated].map((e) => covered.get(e.id) || e), atlas.licences);
  const ready = fresh
    .map((e) => licensed.get(e.id) || covered.get(e.id) || e)
    .filter((e) => e.domain !== 'transit.vehicles' || e.coverage.bbox);
  const added = withinAddLimits(ready, existing);
  for (const entry of added) if (!entryHasCredential(entry)) writeEntry(withAsciiUrls(entry));
  for (const entry of updated)
    if (redirected.has(entry.id) || upgraded.has(entry.id) || covered.has(entry.id) || licensed.has(entry.id))
      writeEntry(licensed.get(entry.id) || covered.get(entry.id) || entry);
  // A checked catalogue feed that duplicates an earlier source: don't check it again.
  const dedupedIds = new Set(deduped.map((e) => e.id));
  for (const e of [...atlas.entries, ...transitous.entries])
    if (!dedupedIds.has(e.id)) {
      const gbfsUrl = e.access.related?.gbfs;
      const key = gbfsUrl ? outputKey(gbfsUrl, e.domain === VEHICLES ? 'vehicles' : 'stations') : e.access.url;
      rejects[key] = { reason: 'duplicate', at: now };
    }
  writeState('harvest-rejects.json', rejects);
  console.log(
    `harvest: mobility database ${mdb.entries.length} keyless vp (rejected ${mdb.rejected.keyed} keyed, ${mdb.rejected.inactive} inactive), ` +
      `atlas ${atlas.entries.length}/${atlas.candidates} checked ok, transitous ${transitous.entries.length}/${transitous.candidates}, ` +
      `gbfs ${gbfs.length} resolved (${gbfs.filter((e) => e.domain === VEHICLES).length} vehicles), usgs ${USGS_ENTRIES.length}, gdacs ${GDACS_ENTRIES.length}, firms ${FIRMS_ENTRIES.length}, perimeters ${PERIMETER_ENTRIES.length}, air quality ${AIRQUALITY_ENTRIES.length}, cameras ${cameras.length}; ${added.length} new entries (${ready.length - added.length} staged for later runs), ${redirected.size} redirected to their final URL, ${upgraded.size} moved to https, ${covered.size} bboxes filled, ${[...licensed.keys()].filter((id) => existing.has(id)).length} licences from Atlas,${Object.keys(rejects).length} catalogue URLs rejected`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await harvest();
