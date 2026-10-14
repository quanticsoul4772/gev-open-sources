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
import { harvestAtlas } from './atlas.js';
import { fillTransitCoverage } from './catalogue.js';
import { harvestGbfs } from './gbfs.js';
import { harvestMobilityDatabase } from './mobilitydatabase.js';
import { resolveRedirects } from './redirects.js';
import { harvestTransitous } from './transitous.js';
import { USGS_ENTRIES } from './usgs.js';

/**
 * New entries per run, as a share of the directory: four runs a day stay
 * well inside the app's daily refresh limit (at most twice the entries), and
 * the build's size guard is the backstop. The rest wait for later runs.
 */
export const MAX_ADDED_RATIO = 0.1;

/** How many new entries a directory of `size` may take in one run. */
export const addLimit = (size) => (size > 0 ? Math.max(1, Math.floor(size * MAX_ADDED_RATIO)) : Infinity);

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
  const tombstones = readState('tombstones.json', {});
  const rejects = readState('harvest-rejects.json', {});
  const knownIds = new Set(existing.keys());
  const mdb = await harvestMobilityDatabase();
  // Atlas and Transitous see the Mobility Database's feeds as known, so they
  // only check URLs that would be new.
  const knownUrls = knownUrlsOf(new Map([...existing, ...mdb.entries.map((e) => [e.id, e])]));
  const atlas = await harvestAtlas({ knownUrls, rejects, now });
  for (const e of atlas.entries) knownUrls.add(normalizeUrl(e.access.url));
  const transitous = await harvestTransitous({ knownIds, knownUrls, rejects, now });
  const gbfs = await harvestGbfs({ known: knownIds });
  const merged = mergeCandidates(
    existing,
    [...USGS_ENTRIES, ...mdb.entries, ...gbfs, ...atlas.entries, ...transitous.entries],
    tombstones,
  );
  // New entries, and existing ones whose last probe failed, may be permalinks
  // that redirect to another domain: point them at the final URL. Two
  // catalogues can reach one feed through different permalinks, so new
  // entries are deduplicated again on their final URLs.
  const health = readState('health.json', {});
  const failing = new Set(['network', 'http']);
  const toCheck = [
    ...merged,
    ...[...existing.values()].filter((e) => failing.has(health[e.id]?.history?.at(-1)?.result)),
  ];
  const redirected = new Map((await resolveRedirects(toCheck)).map((e) => [e.id, e]));
  const deduped = mergeCandidates(existing, merged.map((e) => redirected.get(e.id) || e), tombstones);
  // Transit entries need a bbox: fill missing ones from their vehicles. A new
  // entry still without one waits for a later run; an existing one keeps trying.
  const updated = [...existing.values()].map((e) => redirected.get(e.id) || e);
  const covered = await fillTransitCoverage([...deduped, ...updated]);
  const ready = deduped
    .map((e) => covered.get(e.id) || e)
    .filter((e) => e.domain !== 'transit.vehicles' || e.coverage.bbox);
  const added = ready.slice(0, addLimit(existing.size));
  for (const entry of added) if (!entryHasCredential(entry)) writeEntry(withAsciiUrls(entry));
  for (const entry of updated) if (redirected.has(entry.id) || covered.has(entry.id)) writeEntry(covered.get(entry.id) || entry);
  // A checked catalogue feed that duplicates an earlier source: don't check it again.
  const dedupedIds = new Set(deduped.map((e) => e.id));
  for (const e of [...atlas.entries, ...transitous.entries])
    if (!dedupedIds.has(e.id)) rejects[e.access.related?.gbfs || e.access.url] = { reason: 'duplicate', at: now };
  writeState('harvest-rejects.json', rejects);
  console.log(
    `harvest: mobility database ${mdb.entries.length} keyless vp (rejected ${mdb.rejected.keyed} keyed, ${mdb.rejected.inactive} inactive), ` +
      `atlas ${atlas.entries.length}/${atlas.candidates} checked ok, transitous ${transitous.entries.length}/${transitous.candidates}, ` +
      `gbfs ${gbfs.length} resolved, usgs ${USGS_ENTRIES.length}; ${added.length} new entries (${ready.length - added.length} staged for later runs), ${redirected.size} redirected to their final URL, ${covered.size} bboxes filled, ${Object.keys(rejects).length} catalogue URLs rejected`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await harvest();
