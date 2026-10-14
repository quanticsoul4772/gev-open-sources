/**
 * Publish: dist/directory.json (every live entry with its health summary),
 * dist/entry.schema.json, and dist/state/*.json (the job state the next run
 * restores). Dead entries are left out of the directory.
 *
 * Size guard: God's Eye View refreshes the directory once a day and refuses a
 * copy that has under 80 % or over twice the entries of the one it holds. A
 * directory outside 85 %–180 % of any copy published in the last 30 hours is
 * not published (the run fails and the previous copy stays live).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { summary } from './health.js';
import { DIST_DIR, ROOT, STATE_DIR, readEntries, readState, removeEntry, writeState } from './store.js';
import { entryHasCredential, hasCredential } from './util/secrets.js';

export const STATE_FILES = ['health.json', 'licence-cache.json', 'tombstones.json', 'harvest-rejects.json', 'published.json'];

export const SIZE_WINDOW_S = 30 * 3600;
export const MIN_SIZE_RATIO = 0.85;
export const MAX_SIZE_RATIO = 1.8;

/**
 * Why a directory of `entries` may not be published, or null when it may.
 * @param {Array<{at: number, entries: number}>} published recent copies
 */
export function sizeProblem(published, entries, now) {
  for (const p of published) {
    if (now - p.at > SIZE_WINDOW_S || !p.entries) continue;
    if (entries < p.entries * MIN_SIZE_RATIO || entries > p.entries * MAX_SIZE_RATIO)
      return `${entries} entries vs ${p.entries} published ${new Date(p.at * 1000).toISOString()} (allowed ${MIN_SIZE_RATIO}–${MAX_SIZE_RATIO}×)`;
  }
  return null;
}

export function buildDirectory(entries, health, now) {
  const out = [];
  for (const entry of entries.values()) {
    const h = health[entry.id];
    if (h?.status === 'dead') continue;
    out.push({ ...entry, health: h ? summary(h, now) : { status: 'candidate' } });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  const count = (pred) => out.filter(pred).length;
  return {
    version: 1,
    generated_at: new Date(now * 1000).toISOString(),
    schema: 'entry.schema.json',
    counts: {
      entries: out.length,
      verified: count((e) => e.health.status === 'verified'),
      display: count((e) => e.licence.display),
      usable: count((e) => e.health.status === 'verified' && e.licence.display),
    },
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
    for (const url of Object.keys(state))
      if (hasCredential(url)) {
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
  const published = readState('published.json', []);
  const problem = sizeProblem(published, directory.counts.entries, now);
  if (problem) throw new Error(`build: directory size change refused: ${problem}`);
  writeState('published.json', [
    ...published.filter((p) => now - p.at <= SIZE_WINDOW_S),
    { at: now, entries: directory.counts.entries },
  ]);
  fs.mkdirSync(path.join(DIST_DIR, 'state'), { recursive: true });
  fs.writeFileSync(path.join(DIST_DIR, 'directory.json'), JSON.stringify(directory));
  fs.copyFileSync(path.join(ROOT, 'schema', 'entry.schema.json'), path.join(DIST_DIR, 'entry.schema.json'));
  for (const name of STATE_FILES) {
    const file = path.join(STATE_DIR, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(DIST_DIR, 'state', name));
  }
  console.log(`build: ${JSON.stringify(directory.counts)}`);
  return directory;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) build();
