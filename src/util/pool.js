/**
 * Run tasks with a global concurrency limit and a lower per-host limit, so a
 * host serving many feeds (nextbike, publicbikesystem.net, data.gouv) is never
 * hit by many requests at once.
 * @template T, R
 * @param {T[]} items
 * @param {(item: T) => string} hostOf
 * @param {(item: T) => Promise<R>} run
 * @param {{global?: number, perHost?: number}} [limits]
 * @returns {Promise<R[]>} results in input order
 */
export async function runPooled(items, hostOf, run, { global = 16, perHost = 2 } = {}) {
  const results = new Array(items.length);
  const active = new Map();
  let running = 0;
  let next = 0;
  const waiting = [];
  await new Promise((resolve) => {
    const pump = () => {
      if (next >= items.length && running === 0) return resolve();
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
        active.set(host, (active.get(host) || 0) + 1);
        running += 1;
        Promise.resolve()
          .then(() => run(items[index]))
          .then(
            (value) => (results[index] = value),
            (error) => (results[index] = { error }),
          )
          .finally(() => {
            active.set(host, active.get(host) - 1);
            running -= 1;
            pump();
          });
      }
    };
    pump();
  });
  return results;
}

/** Host of an entry's access URL (or any URL string). */
export const hostOfUrl = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};
