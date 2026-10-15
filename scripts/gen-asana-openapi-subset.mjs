#!/usr/bin/env node
/**
 * Generate the slice of Asana's OpenAPI spec the Asana provider's tests are typed and validated
 * against (plan linear-asana-task-sync-2026-10-05, P-005: "recorded-fake tests typed against
 * Asana's OpenAPI types").
 *
 * Asana publishes no typed SDK (the `asana` npm package is swagger-codegen JavaScript with no model
 * types), so the types come from the spec itself, pinned to one commit of Asana/openapi:
 *
 *   libs/papercusp/plugins/asana/openapi/asana-openapi.subset.json
 *     The ROOT component schemas below, every schema they reference (transitively, verbatim), and
 *     the inline request/response bodies of the endpoints the provider calls, lifted to named
 *     schemas. The recorded fake checks every `opt_fields` path the provider requests against it.
 *   libs/papercusp/plugins/asana/openapi/asana-openapi.d.ts
 *     openapi-typescript over that subset; the fixtures are typed with its `components['schemas']`.
 *
 * Both outputs live beside the asana package they describe, not in app code (plan
 * cupboard-distributable-integrations-2026-10-10, P-022 / D-024).
 *
 * Never hand-edit either output. To move the pin, change ASANA_OAS_COMMIT and re-run:
 *   node scripts/gen-asana-openapi-subset.mjs
 * (needs network: it downloads the spec and runs openapi-typescript through npx).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ASANA_OAS_COMMIT = '1b1c15108d490fc5b780bb83e070293b5815d522';
const OPENAPI_TYPESCRIPT = 'openapi-typescript@7.13.0';
const SOURCE_URL = `https://raw.githubusercontent.com/Asana/openapi/${ASANA_OAS_COMMIT}/defs/asana_oas.yaml`;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(REPO_ROOT, 'libs/papercusp/plugins/asana/openapi');
const OUT_JSON = join(OUT_DIR, 'asana-openapi.subset.json');
const OUT_DTS = join(OUT_DIR, 'asana-openapi.d.ts');

/** Component schemas the provider reads or writes. */
const ROOT_SCHEMAS = [
  'TaskResponse', 'TaskCompact', 'StoryResponse', 'StoryCompact', 'EventResponse',
  'SectionCompact', 'ProjectCompact', 'UserCompact', 'UserResponse', 'TagCompact', 'ErrorResponse',
  'WorkspaceCompact',
];

/** Inline bodies of the endpoints the provider calls, lifted to named schemas. */
const ENDPOINT_BODIES = [
  { name: 'GetEventsOk', path: '/events', method: 'get', response: '200' },
  { name: 'GetEventsSyncExpired', path: '/events', method: 'get', response: '412' },
  { name: 'GetTasksForProjectOk', path: '/projects/{project_gid}/tasks', method: 'get', response: '200' },
  { name: 'GetTaskOk', path: '/tasks/{task_gid}', method: 'get', response: '200' },
  { name: 'GetStoriesForTaskOk', path: '/tasks/{task_gid}/stories', method: 'get', response: '200' },
  { name: 'CreateStoryForTaskBody', path: '/tasks/{task_gid}/stories', method: 'post', request: true },
  { name: 'CreateStoryForTaskCreated', path: '/tasks/{task_gid}/stories', method: 'post', response: '201' },
  { name: 'UpdateTaskBody', path: '/tasks/{task_gid}', method: 'put', request: true },
  { name: 'UpdateTaskOk', path: '/tasks/{task_gid}', method: 'put', response: '200' },
  { name: 'AddTaskForSectionBody', path: '/sections/{section_gid}/addTask', method: 'post', request: true },
  { name: 'GetSectionsForProjectOk', path: '/projects/{project_gid}/sections', method: 'get', response: '200' },
  { name: 'GetUserOk', path: '/users/{user_gid}', method: 'get', response: '200' },
  // ticket.containers (the Integrations page's pickers, plan decision D-014).
  { name: 'GetWorkspacesOk', path: '/workspaces', method: 'get', response: '200' },
  { name: 'GetProjectsOk', path: '/projects', method: 'get', response: '200' },
];

const SCHEMA_REF = /^#\/components\/schemas\/(.+)$/;

function deref(spec, node) {
  let current = node;
  for (let i = 0; i < 10 && current && typeof current.$ref === 'string' && !SCHEMA_REF.test(current.$ref); i++) {
    const parts = current.$ref.replace(/^#\//, '').split('/');
    current = parts.reduce((acc, key) => (acc ? acc[key] : undefined), spec);
  }
  return current;
}

function jsonSchemaOf(spec, holder, where) {
  const resolved = deref(spec, holder);
  const schema = resolved?.content?.['application/json']?.schema;
  if (!schema) throw new Error(`gen-asana-openapi-subset: no application/json schema at ${where}`);
  return schema;
}

function collectRefs(node, into) {
  if (Array.isArray(node)) {
    for (const child of node) collectRefs(child, into);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        const match = SCHEMA_REF.exec(value);
        if (match) into.add(match[1]);
      } else {
        collectRefs(value, into);
      }
    }
  }
}

const STRUCTURAL_KEYS = ['$ref', 'properties', 'items', 'allOf', 'oneOf', 'anyOf', 'additionalProperties', 'enum'];

/**
 * Asana annotates a referenced property with a second, property-less `allOf` member
 * (`parent: { allOf: [{ $ref: TaskCompact }, { type: 'object', nullable: true, description }] }`).
 * openapi-typescript renders that member as `Record<string, never>`, and the intersection
 * `TaskCompact & (Record<string, never> | null)` admits no real value. Fold such members into
 * their holder: drop the member, carry its `nullable`, keep its description.
 */
function foldAnnotationOnlyAllOf(node) {
  if (Array.isArray(node)) return node.map(foldAnnotationOnlyAllOf);
  if (!node || typeof node !== 'object') return node;
  const out = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, foldAnnotationOnlyAllOf(value)]));
  if (Array.isArray(out.allOf)) {
    const annotationOnly = (member) => member && typeof member === 'object' && !STRUCTURAL_KEYS.some((key) => key in member);
    const kept = out.allOf.filter((member) => !annotationOnly(member));
    if (kept.length > 0 && kept.length < out.allOf.length) {
      for (const member of out.allOf.filter(annotationOnly)) {
        if (member.nullable === true) out.nullable = true;
        if (member.description && !out.description) out.description = member.description;
      }
      out.allOf = kept;
    }
  }
  return out;
}

function main() {
  const work = mkdtempSync(join(tmpdir(), 'asana-oas-'));
  try {
    const sourceText = execFileSync('curl', ['-fsSL', SOURCE_URL], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const sourceSha256 = createHash('sha256').update(sourceText).digest('hex');
    const spec = yaml.load(sourceText);
    const all = spec.components.schemas;

    const schemas = {};
    for (const body of ENDPOINT_BODIES) {
      const op = spec.paths[body.path]?.[body.method];
      if (!op) throw new Error(`gen-asana-openapi-subset: ${body.method.toUpperCase()} ${body.path} is not in the spec`);
      schemas[body.name] = body.request
        ? jsonSchemaOf(spec, op.requestBody, `${body.path} ${body.method} requestBody`)
        : jsonSchemaOf(spec, op.responses?.[body.response], `${body.path} ${body.method} ${body.response}`);
    }
    // Every root, plus whatever the lifted endpoint bodies reference, plus their references.
    const seen = new Set();
    const queue = [...ROOT_SCHEMAS];
    const bodyRefs = new Set();
    collectRefs(schemas, bodyRefs);
    queue.push(...bodyRefs);
    while (queue.length > 0) {
      const name = queue.shift();
      if (seen.has(name)) continue;
      if (!all[name]) throw new Error(`gen-asana-openapi-subset: schema ${name} is not in the spec`);
      seen.add(name);
      schemas[name] = all[name];
      const refs = new Set();
      collectRefs(all[name], refs);
      queue.push(...refs);
    }

    mkdirSync(OUT_DIR, { recursive: true });
    const ordered = Object.fromEntries(Object.keys(schemas).sort().map((k) => [k, schemas[k]]));
    const subset = {
      openapi: spec.openapi,
      info: {
        title: 'Asana API (subset for the Papercusp Asana provider)',
        version: String(spec.info?.version ?? '1.0'),
        description: `GENERATED by scripts/gen-asana-openapi-subset.mjs from ${SOURCE_URL} (sha256 ${sourceSha256}). Do not edit.`,
      },
      paths: {},
      components: { schemas: ordered },
    };
    writeFileSync(OUT_JSON, `${JSON.stringify(subset, null, 2)}\n`);

    // Types are generated from a normalised COPY; the JSON above stays a faithful cut of Asana's document.
    const typegenInput = join(work, 'asana-openapi.typegen.json');
    writeFileSync(typegenInput, JSON.stringify(foldAnnotationOnlyAllOf(structuredClone(subset))));
    const tmpDts = join(work, 'asana-openapi.d.ts');
    execFileSync('npx', ['-y', OPENAPI_TYPESCRIPT, typegenInput, '-o', tmpDts], { stdio: 'inherit' });
    const header = [
      '/**',
      ` * GENERATED by scripts/gen-asana-openapi-subset.mjs (${OPENAPI_TYPESCRIPT}) from asana-openapi.subset.json,`,
      ` * itself cut from Asana/openapi@${ASANA_OAS_COMMIT} defs/asana_oas.yaml (sha256 ${sourceSha256}).`,
      ' * Do not edit; re-run the generator to move the pin.',
      ' */',
      '',
    ].join('\n');
    writeFileSync(OUT_DTS, header + readFileSync(tmpDts, 'utf8'));
    console.log(`GEN_ASANA_OPENAPI_SUBSET schemas=${Object.keys(ordered).length} json=${OUT_JSON} dts=${OUT_DTS} sourceSha256=${sourceSha256}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
