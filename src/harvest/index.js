/**
 * Discovery: add catalogued keyless feeds as entries. Feeds already present
 * (by id or exact URL) and tombstoned dead feeds are skipped.
 */
import { pathToFileURL } from 'node:url';
import { readEntries, readState, writeEntry } from '../store.js';
import { normalizeUrl } from '../util/ids.js';
import { harvestGbfs } from './gbfs.js';
import { harvestMobilityDatabase } from './mobilitydatabase.js';

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

export async function harvest() {
  const existing = readEntries();
  const tombstones = readState('tombstones.json', {});
  const mdb = await harvestMobilityDatabase();
  const gbfs = await harvestGbfs({ known: new Set(existing.keys()) });
  const added = mergeCandidates(existing, [...mdb.entries, ...gbfs], tombstones);
  for (const entry of added) writeEntry(entry);
  console.log(
    `harvest: mobility database ${mdb.entries.length} keyless vp (rejected ${mdb.rejected.keyed} keyed, ${mdb.rejected.inactive} inactive), gbfs ${gbfs.length} resolved; ${added.length} new entries`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await harvest();
