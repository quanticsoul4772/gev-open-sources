/**
 * Restore the previous run's job state from the published site. A 404 means
 * there is no previous run (first deploy). Any other failure stops the run, so
 * an outage can never reset every feed's health to "candidate".
 * Usage: node src/restore-state.js <published-base-url>
 */
import { pathToFileURL } from 'node:url';
import { STATE_FILES } from './build.js';
import { writeState } from './store.js';
import { USER_AGENT } from './util/http.js';

export async function restoreState(base, fetchImpl = fetch) {
  for (const name of STATE_FILES) {
    const res = await fetchImpl(`${base.replace(/\/$/, '')}/state/${name}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 404) {
      console.log(`restore: ${name} not published yet`);
      continue;
    }
    if (!res.ok) throw new Error(`restore ${name}: HTTP ${res.status}`);
    writeState(name, await res.json());
    console.log(`restore: ${name}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('usage: node src/restore-state.js <published-base-url>');
  await restoreState(process.argv[2]);
}
