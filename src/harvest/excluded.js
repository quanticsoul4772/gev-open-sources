/**
 * The never-list (`excluded.json` at the repository root): feeds the
 * directory must not list, such as one whose operator asked to be removed.
 * Each item has a feed `url` (for a GBFS system, its discovery URL), a
 * `reason` and, optionally, an entry `id`. A URL matches an entry's access
 * URL, its GBFS discovery URL (the whole system) or a permalink that led to
 * it, over http or https.
 * Discovery skips matching feeds, the GBFS resolvers don't fetch them, and
 * the harvest removes matching entries already in `entries/`, including one a
 * redirect moves onto a listed URL, and tombstones them (`reason:
 * 'excluded'`) so copies retired as their duplicates stay out too. Unlike
 * tombstones, the list is committed, so it survives a state reset; a listed
 * `id` keeps those copies out across one as well.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../store.js';
import { normalizeUrl } from '../util/ids.js';

export const EXCLUDED_FILE = path.join(ROOT, 'excluded.json');

/** Both schemes of a URL, normalized (a default port goes before the scheme changes). */
function schemeVariants(url) {
  return ['http:', 'https:'].map((scheme) => normalizeUrl(normalizeUrl(url).replace(/^https?:/i, scheme)));
}

/**
 * Parse the never-list. Throws on a malformed item, so a typo stops the run
 * instead of quietly listing a feed that was meant to stay out.
 * @param {unknown} items parsed excluded.json
 * @returns {{ids: Map<string, string>, urls: Map<string, string>}} reason by id and by URL
 */
export function parseExcluded(items) {
  if (!Array.isArray(items)) throw new Error('excluded.json: expected an array');
  const ids = new Map();
  const urls = new Map();
  items.forEach((item, i) => {
    const { id, url, reason } = item ?? {};
    if (typeof reason !== 'string' || !reason.trim()) throw new Error(`excluded.json[${i}]: reason is required`);
    // An id alone would let the same feed back in under another catalogue's id.
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error(`excluded.json[${i}]: url must be an http(s) URL`);
    if (id !== undefined && (typeof id !== 'string' || !id)) throw new Error(`excluded.json[${i}]: id must be a non-empty string`);
    if (id) ids.set(id, reason);
    for (const u of schemeVariants(url)) urls.set(u, reason);
  });
  return { ids, urls };
}

/** Read and parse `excluded.json`. */
export function readExcluded(file = EXCLUDED_FILE) {
  return parseExcluded(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/**
 * The reason an entry is on the never-list, or null.
 * @param {object} entry
 * @param {{ids: Map<string, string>, urls: Map<string, string>}} excluded
 */
export function excludedReason(entry, excluded) {
  if (!excluded.ids.size && !excluded.urls.size) return null;
  if (excluded.ids.has(entry.id)) return excluded.ids.get(entry.id);
  const urls = [
    entry.access.url,
    entry.access.related?.gbfs,
    ...entry.provenance.filter((p) => p.startsWith('via:')).map((p) => p.slice(4)),
  ];
  for (const url of urls) if (url && excluded.urls.has(normalizeUrl(url))) return excluded.urls.get(normalizeUrl(url));
  return null;
}
