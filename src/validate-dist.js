/**
 * Validate every entry against schema/entry.schema.json with a real JSON
 * Schema validator (ajv, draft 2020-12), and against the hand validator in
 * src/schema.js: entries/*.json, and the entries of every published directory
 * file under dist/. Exit 1 on any failure. Runs before the commit step.
 * Usage: node src/validate-dist.js <dir|file>...
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { validateEntry } from './schema.js';
import { ROOT } from './store.js';

/** The compiled entry schema. */
export function schemaValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'entry.schema.json'), 'utf8')));
}

/** Entries in a JSON document: an entry itself, or a directory's `entries`. */
const entriesOf = (doc) => (Array.isArray(doc?.entries) ? doc.entries : doc?.id && doc?.access ? [doc] : []);

function* jsonFiles(target) {
  if (!fs.existsSync(target)) return;
  if (fs.statSync(target).isFile()) {
    if (target.endsWith('.json') && !target.includes(`${path.sep}state${path.sep}`)) yield target;
    return;
  }
  for (const name of fs.readdirSync(target)) yield* jsonFiles(path.join(target, name));
}

/** @returns {Array<{file: string, id: string, errors: string[]}>} */
export function validatePaths(targets) {
  const validate = schemaValidator();
  const failures = [];
  for (const target of targets)
    for (const file of jsonFiles(target))
      for (const entry of entriesOf(JSON.parse(fs.readFileSync(file, 'utf8')))) {
        const errors = [
          ...(validate(entry) ? [] : validate.errors.map((e) => `schema ${e.instancePath || '/'} ${e.message}`)),
          ...validateEntry(entry).map((e) => `hand ${e}`),
        ];
        if (errors.length) failures.push({ file, id: entry.id, errors });
      }
  return failures;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targets = process.argv.slice(2);
  if (!targets.length) throw new Error('usage: node src/validate-dist.js <dir|file>...');
  const failures = validatePaths(targets);
  for (const f of failures.slice(0, 50)) console.error(`invalid: ${f.file} ${f.id}: ${f.errors.join('; ')}`);
  console.log(`validate-dist: ${failures.length} invalid entr${failures.length === 1 ? 'y' : 'ies'} in ${targets.join(', ')}`);
  if (failures.length) process.exit(1);
}
