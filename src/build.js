/**
 * Publish: dist/directory.json (every live entry with its health summary),
 * dist/entry.schema.json, and dist/state/*.json (the job state the next run
 * restores). Dead entries are left out of the directory.
 *
 * Versioned layout (contract v1; see README "Contract and versions"):
 *   v1/directory.json        every entry
 *   v1/<domain>.json         one domain's entries (e.g. v1/transit.vehicles.json)
 *   v1/index.json            generated_at, and each file's entry counts and bytes
 *   v1/entry.schema.json     the entry schema ($id names the version)
 *   directory.json, entry.schema.json   aliases of the v1 files
 *   state/*.json             job state (not part of the contract)
 *
 * Size guard: God's Eye View refreshes the directory once a day and refuses a
 * copy that has under 80 % or over twice the entries of the one it holds, in
 * total and per domain. A directory whose total is outside 85 %–180 % of any
 * copy published in the last 30 hours is not published (the run fails and the
 * previous copy stays live). A domain of at least DOMAIN_FLOOR (50) entries
 * that moves out of that range only logs a warning.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { summary } from './health.js';
import { DIST_DIR, ROOT, STATE_DIR, readEntries, readState, removeEntry, writeState } from './store.js';
import { entryHasCredential, hasCredential } from './util/secrets.js';

export const STATE_FILES = ['health.json', 'licence-cache.json', 'tombstones.json', 'harvest-rejects.json', 'published.json'];

/** Major contract version: the published path is v<CONTRACT_VERSION>/. */
export const CONTRACT_VERSION = 1;
export const SIZE_WINDOW_S = 30 * 3600;
/**
 * Domains smaller than this in an earlier copy are not size-guarded: one
 * dead feed in a 5-entry domain is a 20 % drop, and failing the whole build
 * for it would stop every domain from publishing for up to 30 hours. Matches
 * the app, which guards a domain from 50 entries.
 */
export const DOMAIN_FLOOR = 50;
export const MIN_SIZE_RATIO = 0.85;
export const MAX_SIZE_RATIO = 1.8;

const outOfRange = (next, before) => next < before * MIN_SIZE_RATIO || next > before * MAX_SIZE_RATIO;

/**
 * Why a directory of these sizes may not be published (the total moved out of
 * range), or null when it may.
 * @param {Array<{at: number, entries: number, domains?: Record<string, number>}>} published recent copies
 * @param {{entries: number, domains: Record<string, number>}} sizes
 */
export function sizeProblem(published, sizes, now) {
  for (const p of published) {
    if (now - p.at > SIZE_WINDOW_S || !p.entries) continue;
    if (outOfRange(sizes.entries, p.entries))
      return `${sizes.entries} entries vs ${p.entries} published ${new Date(p.at * 1000).toISOString()} (allowed ${MIN_SIZE_RATIO}–${MAX_SIZE_RATIO}×)`;
  }
  return null;
}

/**
 * Domains (of at least DOMAIN_FLOOR entries) whose size moved out of range: a
 * warning, not a refusal. One operator going dark (a large one such as Lime or
 * Dott) must not stop every domain publishing; the app keeps its
 * own copy of a domain that moves too much.
 * @returns {string[]}
 */
export function domainSizeWarnings(published, sizes, now) {
  const warnings = new Set();
  for (const p of published) {
    if (now - p.at > SIZE_WINDOW_S) continue;
    for (const [domain, before] of Object.entries(p.domains || {}))
      if (before >= DOMAIN_FLOOR && outOfRange(sizes.domains[domain] ?? 0, before))
        warnings.add(`${domain}: ${sizes.domains[domain] ?? 0} entries vs ${before} published ${new Date(p.at * 1000).toISOString()}`);
  }
  return [...warnings];
}

const countsOf = (entries) => ({
  entries: entries.length,
  verified: entries.filter((e) => e.health.status === 'verified').length,
  display: entries.filter((e) => e.licence.display).length,
  usable: entries.filter((e) => e.health.status === 'verified' && e.licence.display).length,
});

/**
 * The published files of a directory: path (under v<N>/) → document.
 * @returns {Map<string, object>}
 */
export function publishedFiles(directory) {
  const files = new Map([['directory.json', directory]]);
  const domains = [...new Set(directory.entries.map((e) => e.domain))].sort();
  for (const domain of domains) {
    const entries = directory.entries.filter((e) => e.domain === domain);
    files.set(`${domain}.json`, { ...directory, domain, counts: countsOf(entries), entries });
  }
  return files;
}

/** v<N>/index.json for the published files (path → JSON text). */
export function indexOf(directory, texts) {
  return {
    version: directory.version,
    generated_at: directory.generated_at,
    schema: 'entry.schema.json',
    files: [...texts].map(([file, text]) => {
      const doc = JSON.parse(text);
      return { path: file, domain: doc.domain ?? null, ...doc.counts, bytes: Buffer.byteLength(text) };
    }),
  };
}

export function buildDirectory(entries, health, now) {
  const out = [];
  for (const entry of entries.values()) {
    const h = health[entry.id];
    if (h?.status === 'dead') continue;
    // Hazard feeds cover the world on purpose.
    const coverage = entry.domain?.startsWith('hazards.') ? { ...entry.coverage, class: 'global' } : entry.coverage;
    out.push({ ...entry, coverage, health: h ? summary(h, now) : { status: 'candidate' } });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return {
    version: CONTRACT_VERSION,
    generated_at: new Date(now * 1000).toISOString(),
    schema: 'entry.schema.json',
    counts: countsOf(out),
    entries: out,
  };
}

/**
 * State files keyed or valued by URL, with every credential-bearing URL
 * removed: they are published next to the directory.
 * @returns {number} URLs removed
 */
export function scrubState() {
  let removed = 0;
  for (const name of ['harvest-rejects.json', 'licence-cache.json']) {
    const state = readState(name, {});
    // Keys that aren't URLs (an https-upgrade reject keyed by entry id) carry no URL.
    for (const url of Object.keys(state))
      if (/^https?:\/\//i.test(url) && hasCredential(url)) {
        delete state[url];
        removed += 1;
      }
    writeState(name, state);
  }
  const tombstones = readState('tombstones.json', {});
  for (const t of Object.values(tombstones))
    if (t.url && hasCredential(t.url)) {
      t.url = null;
      removed += 1;
    }
  writeState('tombstones.json', tombstones);
  return removed;
}

export function build(now = Math.floor(Date.now() / 1000)) {
  // Publishing gate: an entry with a credential-bearing URL is removed, not
  // published (src/scan-secrets.js re-checks every output file afterwards).
  const entries = readEntries();
  for (const [id, entry] of entries)
    if (entryHasCredential(entry)) {
      removeEntry(id);
      entries.delete(id);
      console.log(`build: removed ${id}: a URL carries a credential`);
    }
  const scrubbed = scrubState();
  if (scrubbed) console.log(`build: ${scrubbed} credential-bearing URLs removed from state`);
  const directory = buildDirectory(entries, readState('health.json', {}), now);
  const files = publishedFiles(directory);
  const sizes = {
    entries: directory.counts.entries,
    domains: Object.fromEntries([...files.values()].filter((d) => d.domain).map((d) => [d.domain, d.counts.entries])),
  };
  const published = readState('published.json', []);
  const problem = sizeProblem(published, sizes, now);
  if (problem) throw new Error(`build: directory size change refused: ${problem}`);
  for (const w of domainSizeWarnings(published, sizes, now)) console.warn(`build: warning: domain size moved out of range: ${w}`);
  writeState('published.json', [...published.filter((p) => now - p.at <= SIZE_WINDOW_S), { at: now, ...sizes }]);
  const versionDir = path.join(DIST_DIR, `v${CONTRACT_VERSION}`);
  fs.mkdirSync(path.join(DIST_DIR, 'state'), { recursive: true });
  fs.mkdirSync(versionDir, { recursive: true });
  const texts = new Map([...files].map(([file, doc]) => [file, JSON.stringify(doc)]));
  for (const [file, text] of texts) fs.writeFileSync(path.join(versionDir, file), text);
  fs.writeFileSync(path.join(versionDir, 'index.json'), JSON.stringify(indexOf(directory, texts)));
  const schema = path.join(ROOT, 'schema', 'entry.schema.json');
  fs.copyFileSync(schema, path.join(versionDir, 'entry.schema.json'));
  // Unversioned aliases of v1, kept for existing consumers.
  fs.writeFileSync(path.join(DIST_DIR, 'directory.json'), texts.get('directory.json'));
  fs.copyFileSync(schema, path.join(DIST_DIR, 'entry.schema.json'));
  for (const name of STATE_FILES) {
    const file = path.join(STATE_DIR, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(DIST_DIR, 'state', name));
  }
  console.log(`build: ${JSON.stringify(directory.counts)}`);
  return directory;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) build();
