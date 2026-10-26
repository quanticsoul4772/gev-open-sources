/**
 * Run tasks with a global concurrency limit and a lower per-host limit, so a
 * host serving many feeds (nextbike, publicbikesystem.net, data.gouv) is never
 * hit by many requests at once.
 * @template T, R
 * @param {T[]} items
 * @param {(item: T) => string} hostOf
 * @param {(item: T) => Promise<R>} run
 * @param {{global?: number, perHost?: number, deadlineMs?: number, breakAfter?: number}} [limits]
 *   deadlineMs: tasks not started by this time (epoch ms) are skipped;
 *   breakAfter: after this many consecutive failures (thrown errors) on a
 *   host, its remaining tasks are skipped. Skipped tasks resolve to
 *   `{skipped: 'deadline' | 'host'}`.
 * @returns {Promise<R[]>} results in input order
 */
export async function runPooled(items, hostOf, run, { global = 16, perHost = 2, deadlineMs = Infinity, breakAfter = Infinity } = {}) {
  const results = new Array(items.length);
  const active = new Map();
  const failures = new Map();
  let running = 0;
  let next = 0;
  const waiting = [];
  await new Promise((resolve) => {
    const pump = () => {
      if (next >= items.length && running === 0 && !waiting.length) return resolve();
      for (let i = 0; i < waiting.length || next < items.length; ) {
        if (running >= global) return;
        let index;
        if (i < waiting.length) index = waiting[i];
        else index = next++;
        const host = hostOf(items[index]);
        if ((active.get(host) || 0) >= perHost) {
          if (i >= waiting.length) waiting.push(index);
          i += 1;
          continue;
        }
        if (i < waiting.length) waiting.splice(i, 1);
        if (Date.now() > deadlineMs || (failures.get(host) || 0) >= breakAfter) {
          results[index] = { skipped: Date.now() > deadlineMs ? 'deadline' : 'host' };
          continue;
        }
        active.set(host, (active.get(host) || 0) + 1);
        running += 1;
        Promise.resolve()
          .then(() => run(items[index]))
          .then(
            (value) => {
              failures.set(host, 0);
              results[index] = value;
            },
            (error) => {
              failures.set(host, (failures.get(host) || 0) + 1);
              results[index] = { error };
            },
          )
          .finally(() => {
            active.set(host, active.get(host) - 1);
            running -= 1;
            pump();
          });
      }
      // Every remaining task was skipped and nothing is running: no task will call pump again.
      if (next >= items.length && running === 0 && !waiting.length) resolve();
    };
    pump();
  });
  return results;
}

/**
 * Run pooled work within a time budget shared by several runs (`{leftMs}`),
 * spent only while they run, so work between them doesn't use it up.
 * @template R
 * @param {{leftMs: number}} phase updated in place
 * @param {(deadlineMs: number) => Promise<R>} run
 * @returns {Promise<R>}
 */
export async function withinPhase(phase, run) {
  const start = Date.now();
  try {
    return await run(start + phase.leftMs);
  } finally {
    phase.leftMs -= Date.now() - start;
  }
}

/** Host of an entry's access URL (or any URL string). */
export const hostOfUrl = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};
