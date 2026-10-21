#!/usr/bin/env node
// Validates ctx contract v1 documents against contract/schemas (JSON Schema 2020-12, ajv).
// Node >= 22, ESM, no dependency beyond ajv. Used by `npm run contract:validate`, WP-0.I
// (vendored Go fixtures via --manifest), WP-2.I and WP-3.1. Spec: contract/ctx-json-v1.md
// section "Fixtures and the validator" (errata E31-E33).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const SCHEMA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schemas');

/** Schema id (the document's "schema" field) -> schema file under contract/schemas. */
const SCHEMA_FILES = {
  'ctx.version.v1': 'version.schema.json',
  'ctx.status.v1': 'status.schema.json',
  'ctx.push.v1': 'push.schema.json',
  'ctx.pull.v1': 'pull.schema.json',
  'ctx.resolve.v1': 'resolve.schema.json',
  'ctx.error.v1': 'error.schema.json',
};

const USAGE = `Usage: node contract/validate.mjs [--manifest <manifest.json>]... [<file>...]

Validates ctx contract v1 documents against contract/schemas/*.schema.json.

  <file>                 A whole-file JSON document, or (when the whole file is not
                         JSON) a stderr capture whose last non-empty line is the
                         envelope. The schema is picked from the document's "schema"
                         field and must be one of:
                         ${Object.keys(SCHEMA_FILES).join(', ')}.
  --manifest <file>      A fixtures manifest.json ({fixtures: [{file, schema, command,
                         stream, exit_code, sha256}]}, E32). Entries are chosen by
                         stream and schema, never by file extension: stdout entries
                         are whole-file documents, stderr entries use their last
                         non-empty line (and the envelope exit_code must equal the
                         entry's exit_code). raw/data streams and schemas outside the
                         six (null, ctx.repair.v1, ...) print a SKIP line. Paths are
                         relative to the manifest's directory.
  -h, --help             Show this text.

Prints "OK <file> <schema>" per valid document, "SKIP <file> <reason>" per skipped
manifest entry and "FAIL <file> ..." per failure. Exit 0 only when every validated
file passes; 1 on any failure or missing file; 2 on a usage error.`;

function usageError(message) {
  process.stderr.write(`${message ? `validate.mjs: ${message}\n\n` : ''}${USAGE}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const manifests = [];
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (a === '--manifest') {
      const m = argv[++i];
      if (m === undefined) { usageError('--manifest needs a file'); }
      manifests.push(m);
    } else if (a.startsWith('--manifest=')) {
      manifests.push(a.slice('--manifest='.length));
    } else if (a === '--') {
      files.push(...argv.slice(i + 1));
      break;
    } else if (a.startsWith('-') && a !== '-') {
      usageError(`unknown option ${a}`);
    } else {
      files.push(a);
    }
  }
  if (manifests.length === 0 && files.length === 0) { usageError(''); }
  return { manifests, files };
}

/** One ajv instance; strictRequired is off only because it misreports `not: {required}`. */
function loadValidators() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  const validators = new Map();
  for (const [id, file] of Object.entries(SCHEMA_FILES)) {
    const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8'));
    if (schema?.properties?.schema?.const !== id) {
      throw new Error(`${file} does not pin schema ${id}`);
    }
    validators.set(id, ajv.compile(schema));
  }
  return validators;
}

function lastNonEmptyLine(text) {
  return text.split(/\r?\n/).filter((l) => l.trim() !== '').pop() ?? '';
}

function errorsText(errors) {
  return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim()).join('; ');
}

function main() {
  const { manifests, files } = parseArgs(process.argv.slice(2));
  const validators = loadValidators();
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  const pass = (label, schema) => { ok++; console.log(`OK ${label} ${schema}`); };
  const skip = (label, reason) => { skipped++; console.log(`SKIP ${label} ${reason}`); };
  const fail = (label, reason) => { failed++; console.log(`FAIL ${label} ${reason}`); };

  /** Validates doc against schema id; extra(doc) may return a further failure reason. */
  const check = (label, id, doc, extra) => {
    const validate = validators.get(id);
    if (!validate) { fail(label, `unknown schema ${JSON.stringify(id)}`); return; }
    if (!validate(doc)) { fail(label, `${id}: ${errorsText(validate.errors)}`); return; }
    const more = extra?.(doc);
    if (more) { fail(label, `${id}: ${more}`); return; }
    pass(label, id);
  };

  const read = (label, file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (e) {
      fail(label, e.code === 'ENOENT' ? 'missing file' : `unreadable: ${e.message}`);
      return undefined;
    }
  };

  for (const file of files) {
    const text = read(file, file);
    if (text === undefined) { continue; }
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      try {
        doc = JSON.parse(lastNonEmptyLine(text));
      } catch {
        fail(file, 'neither the whole file nor its last non-empty line is JSON');
        continue;
      }
    }
    check(file, doc?.schema, doc);
  }

  for (const manifestFile of manifests) {
    const text = read(manifestFile, manifestFile);
    if (text === undefined) { continue; }
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch (e) {
      fail(manifestFile, `manifest is not JSON: ${e.message}`);
      continue;
    }
    if (!Array.isArray(manifest?.fixtures)) {
      fail(manifestFile, 'manifest has no fixtures array');
      continue;
    }
    const dir = path.dirname(manifestFile);
    for (const entry of manifest.fixtures) {
      const label = String(entry?.file);
      if (typeof entry?.file !== 'string') { fail(manifestFile, `entry without a file: ${JSON.stringify(entry)}`); continue; }
      if (entry.stream !== 'stdout' && entry.stream !== 'stderr') { skip(label, `stream ${entry.stream}`); continue; }
      if (!Object.hasOwn(SCHEMA_FILES, entry.schema)) { skip(label, `schema ${entry.schema}`); continue; }
      const body = read(label, path.resolve(dir, entry.file));
      if (body === undefined) { continue; }
      let doc;
      try {
        doc = JSON.parse(entry.stream === 'stdout' ? body : lastNonEmptyLine(body));
      } catch {
        fail(label, entry.stream === 'stdout' ? 'stdout is not one JSON document' : 'last non-empty stderr line is not JSON');
        continue;
      }
      const exitCheck = entry.stream === 'stderr' && typeof entry.exit_code === 'number'
        ? (d) => (d.exit_code === entry.exit_code ? undefined : `exit_code ${d.exit_code} != manifest exit_code ${entry.exit_code}`)
        : undefined;
      check(label, entry.schema, doc, exitCheck);
    }
  }

  console.log(`validated ${ok}, skipped ${skipped}, failed ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
