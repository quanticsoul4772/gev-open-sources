import { FIRMS_ENTRIES } from './firms.js';
import { GDACS_ENTRIES } from './gdacs.js';
import { PERIMETER_ENTRIES } from './perimeters.js';
import { USGS_ENTRIES } from './usgs.js';

/**
 * Entries written by hand rather than found in a catalogue. Their URLs are
 * fixed recipes: a redirect is never written into them, and a long outage
 * leaves them dead (unpublished) instead of removing them for good, so they
 * come back by themselves when the source answers again.
 */
export const STATIC_ENTRIES = [...USGS_ENTRIES, ...GDACS_ENTRIES, ...FIRMS_ENTRIES, ...PERIMETER_ENTRIES];

const STATIC_PROVENANCES = new Set(STATIC_ENTRIES.flatMap((e) => e.provenance));

/** Whether an entry is one of the hand-written ones (by provenance). */
export const isStaticEntry = (entry) => entry.provenance.some((p) => STATIC_PROVENANCES.has(p));
