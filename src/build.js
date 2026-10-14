/**
 * Publish: dist/directory.json (every live entry with its health summary),
 * dist/entry.schema.json, and dist/state/*.json (the job state the next run
 * restores). Dead entries are left out of the directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { summary } from './health.js';
import { DIST_DIR, ROOT, STATE_DIR, readEntries, readState } from './store.js';

export const STATE_FILES = ['health.json', 'licence-cache.json', 'tombstones.json'];

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

export function build(now = Math.floor(Date.now() / 1000)) {
  const directory = buildDirectory(readEntries(), readState('health.json', {}), now);
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
