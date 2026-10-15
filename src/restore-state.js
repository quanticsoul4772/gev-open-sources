/**
 * Restore the previous run's job state from the published site, all or
 * nothing, so an outage or a broken publish can never quietly reset every
 * feed's health to "candidate", bring tombstoned feeds back, re-bill the
 * licence cache or switch the size guard off:
 *  - nothing published yet (v1/index.json and directory.json both 404) is a
 *    first deploy: start empty;
 *  - otherwise every state file must be there, of the right shape, and
 *    published.json's newest copy must be the published index's
 *    generated_at (a stale CDN copy fails the run; the next run retries).
 * Requests carry a cache-busting query: Pages caches for 10 minutes.
 * Usage: node src/restore-state.js <published-base-url>
 */
import { pathToFileURL } from 'node:url';
import { STATE_FILES } from './build.js';
import { writeState } from './store.js';
import { USER_AGENT } from './util/http.js';

/** Expected shape of each state file. */
const SHAPES = {
  'health.json': 'object',
  'licence-cache.json': 'object',
  'tombstones.json': 'object',
  'harvest-rejects.json': 'object',
  'published.json': 'array',
};

const shapeOf = (v) => (Array.isArray(v) ? 'array' : v && typeof v === 'object' ? 'object' : typeof v);

export async function restoreState(base, fetchImpl = fetch, bust = String(Date.now())) {
  const root = base.replace(/\/$/, '');
  const get = (path) =>
    fetchImpl(`${root}/${path}?r=${bust}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
  const ok = (res, what) => {
    if (res.status !== 200 && res.status !== 404) throw new Error(`restore ${what}: HTTP ${res.status}`);
    return res.status === 200;
  };

  const indexRes = await get('v1/index.json');
  const index = ok(indexRes, 'v1/index.json') ? await indexRes.json() : null;
  const published = Boolean(index) || ok(await get('directory.json'), 'directory.json');
  if (!published) {
    console.log('restore: nothing published yet (first deploy)');
    return;
  }

  const restored = {};
  for (const name of STATE_FILES) {
    const res = await get(`state/${name}`);
    if (!ok(res, name)) throw new Error(`restore ${name}: missing from a published site; refusing to start from empty state`);
    const value = await res.json();
    if (shapeOf(value) !== SHAPES[name]) throw new Error(`restore ${name}: expected ${SHAPES[name]}, got ${shapeOf(value)}`);
    restored[name] = value;
  }
  const newest = restored['published.json'].reduce((m, p) => Math.max(m, p.at || 0), 0);
  if (index && newest && new Date(newest * 1000).toISOString() !== index.generated_at)
    throw new Error(
      `restore: state is from ${new Date(newest * 1000).toISOString()} but the directory from ${index.generated_at} (stale copy)`,
    );
  for (const [name, value] of Object.entries(restored)) {
    writeState(name, value);
    console.log(`restore: ${name}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('usage: node src/restore-state.js <published-base-url>');
  await restoreState(process.argv[2]);
}
