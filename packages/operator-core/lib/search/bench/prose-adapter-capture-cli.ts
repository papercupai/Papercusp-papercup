/** Retained P001 corpus capture through actual tool handlers. This is a direct
 * handler measurement, excluding transport/auth middleware and paid judging.
 * Run only via run-retained-baseline.py inside the immutable source verifier.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isCliEntry } from '../../util/cli-entry';
import { z } from 'zod';

const requestSchema = z.object({
  id: z.string().min(1),
  adapter: z.enum(['search:fulltext', 'search:semantic']),
  args: z.object({
    query: z.string().min(1).max(500),
    scope: z.array(z.enum(['work_item', 'session_turn'])).min(1).max(2),
    harness_slug: z.string().min(1),
    limit: z.number().int().min(1).max(50),
    mode: z.enum(['hybrid', 'embeddings']).optional(),
  }).strict(),
}).strict();

export function parseProseCaptureRequests(value: unknown) {
  const requests = z.array(requestSchema).min(1).parse(value);
  const ids = new Set<string>();
  for (const request of requests) {
    if (ids.has(request.id)) throw new Error('duplicate attempt identity');
    ids.add(request.id);
    if (new Set(request.args.scope).size !== request.args.scope.length)
      throw new Error('duplicate source scope');
    if (request.adapter === 'search:fulltext' && request.args.mode !== undefined)
      throw new Error('fulltext does not accept mode');
  }
  return requests;
}

export function requireCaptureDatabase(env: NodeJS.ProcessEnv) {
  const dsn = env.PAPERCUSP_TEST_PG_ADMIN_URL;
  if (!dsn || env.HARNESS_ADMIN_DATABASE_URL !== dsn || env.HARNESS_DATABASE_URL !== dsn)
    throw new Error('requires matching isolated database bindings');
  const url = new URL(dsn);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.port === '5432'
    || !/^\/search_baseline_[a-f0-9]{16}$/.test(url.pathname))
    throw new Error('requires retained disposable corpus database');
  if (!env.PAPERCUSP_WORKSPACE_ID?.trim()) throw new Error('requires explicit corpus workspace');
  if (env.PAPERCUSP_MEMORY_EMBEDDER !== 'gemma' || env.PAPERCUSP_EMBED_DEVICE !== 'cpu'
    || env.PAPERCUSP_TRANSFORMERS_LOCAL_ONLY !== '1' || env.PAPERCUSP_SKIP_PG_DISCOVERY !== '1')
    throw new Error('requires pinned local CPU embedder policy');
  return dsn;
}

/** Observational evidence only: never populate the alarm's sample table or
 * change the query gate. These are the runner's retained data tables; complete
 * primary DDL also contains empty, unretained tables that must not look healthy. */
export async function captureRetainedCoverage(
  sql: { unsafe(query: string, params?: unknown[]): PromiseLike<unknown> },
) {
  const { coverageTargets, surfaceKey, buildCoverageQuery, toSurfaceCoverage } = await import('../embed-coverage');
  const { SEARCH_SOURCE_SURFACES } = await import('../coverage-gate');
  const retained = new Set(['harness_shared.work_items', 'harness_shared.text_chunks',
    'harness_shared.session_turns', 'harness_shared.session_turn_chunks']);
  const requested = new Set(['work_item', 'session_turn', 'plan'].flatMap(source => SEARCH_SOURCE_SURFACES[source]));
  const readings = [];
  for (const target of coverageTargets().filter(target => requested.has(surfaceKey(target)))) {
    const surface = surfaceKey(target);
    if (!retained.has(target.table)) {
      readings.push({ surface, status: 'unknown', reason: 'table data not retained' });
      continue;
    }
    const started = performance.now();
    try {
      const columns = await sql.unsafe(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = split_part($1, '.', 1) AND table_name = split_part($1, '.', 2)`,
      [target.table]) as Array<{ column_name: string }>;
      const names = new Set(columns.map(row => row.column_name));
      const { modeColOf, recipeColOf } = await import('../embed-backfill');
      if (!names.has(target.embedCol)) throw new Error('embedding column missing');
      const query = buildCoverageQuery(target, names.has(modeColOf(target)), 'gemma', 24,
        names.has(recipeColOf(target)));
      const rows = await sql.unsafe(query.sql, query.params) as Array<Record<string, unknown>>;
      const row = rows[0];
      if (!row) throw new Error('coverage query returned no count row');
      const count = (key: string) => {
        const value = Number(row[key]);
        if (row[key] == null || !Number.isSafeInteger(value) || value < 0)
          throw new Error('invalid coverage count: ' + key);
        return value;
      };
      const counts = { totalRows: count('total_rows'), eligibleRows: count('eligible_rows'),
        embeddedRows: count('embedded_rows'),
        recentEligible: query.hasRecent ? count('recent_eligible') : null,
        recentEmbedded: query.hasRecent ? count('recent_embedded') : null };
      if (counts.embeddedRows > counts.eligibleRows || counts.eligibleRows > counts.totalRows
        || (counts.recentEligible !== null && (counts.recentEligible > counts.eligibleRows
          || counts.recentEmbedded! > counts.recentEligible))) throw new Error('inconsistent coverage counts');
      readings.push({ surface, status: 'measured', observedAt: new Date().toISOString(),
        durationMs: performance.now() - started, reading: toSurfaceCoverage(target, counts) });
    } catch {
      // Preserve a missing measurement without serializing SQL errors/private data.
      readings.push({ surface, status: 'unknown', reason: 'coverage measurement failed',
        durationMs: performance.now() - started });
    }
  }
  const measured = new Set(readings.map(row => row.surface));
  for (const surface of requested) if (!measured.has(surface))
    readings.push({ surface, status: 'unknown', reason: 'no registered coverage target' });
  return { schemaVersion: 1, plane: 'isolated-retained-corpus', mode: 'gemma',
    population: 'retained tables, table-wide production eligibility; not harness-filtered',
    queryGateChanged: false, baselineAccepted: false, readings };
}

export async function runProseAdapterCapture(argv = process.argv.slice(2)) {
  process.umask(0o077);
  const argument = (name: string) => {
    const index = argv.indexOf(name);
    if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('missing ' + name);
    return path.resolve(argv[index + 1]);
  };
  const requestsFile = argument('--requests'), output = argument('--out');
  if (fs.existsSync(output)) throw new Error('capture output already exists');
  const input = fs.readFileSync(requestsFile);
  const requests = parseProseCaptureRequests(JSON.parse(input.toString()));
  const dsn = requireCaptureDatabase(process.env);
  if (!fs.existsSync(path.resolve('.verifier-source.json'))) throw new Error('requires immutable source verifier');
  // Bind all resolver variants before importing handlers or singleton DB clients.
  process.env.DATABASE_URL = dsn;
  const [{ getOrgPg }, { default: fulltext }, { default: semantic }, { shutdownLocalEmbedder }] = await Promise.all([
    import('@papercusp/db-org'), import('../../agent-tools/search/fulltext'),
    import('../../agent-tools/search/semantic'), import('../../../../../libs/generic/memory/src/local-embedder-worker'),
  ]);
  const { sql } = getOrgPg();
  const rows: unknown[] = [];
  try {
    const [database] = await sql`SELECT current_database() AS name, current_setting('data_directory') AS directory`;
    if (database.name !== new URL(dsn).pathname.slice(1)
      || !path.basename(database.directory).startsWith('papercusp-test-pg-'))
      throw new Error('resolved database is not maintained disposable cluster');
    const coverage = await captureRetainedCoverage(sql);
    fs.writeFileSync(output + '.coverage.json', JSON.stringify({ database: database.name, ...coverage }, null, 2)
      + '\n', { flag: 'wx', mode: 0o600 });
    for (const request of requests) {
      const logs: unknown[] = [], metadata: unknown[] = [];
      const ctx: Parameters<typeof fulltext.handler>[1] & { metadata: (value: Record<string, unknown>) => void } = {
        tx: sql, workspaceId: process.env.PAPERCUSP_WORKSPACE_ID!,
        role: 'operator',
        signal: new AbortController().signal,
        progress: value => { metadata.push({ progress: value }); },
        emit: (event, value) => { metadata.push({ event, value }); },
        principal: { kind: 'system', slug: 'system:operator', workspaceId: process.env.PAPERCUSP_WORKSPACE_ID!,
          authMethod: 'process-internal', trust: 'trusted', capabilities: new Set(['search:read']) },
        log: message => { logs.push(message); },
        metadata: value => { metadata.push(value); },
      };
      const start = performance.now();
      // Schema and handler are the production defineTool exports. No engine,
      // provider, source registry or result-shaping stand-in is installed.
      const result = request.adapter === 'search:fulltext'
        ? await fulltext.handler(fulltext.args.parse(request.args), ctx)
        : await semantic.handler(semantic.args.parse(request.args), ctx);
      const deliveryWallMs = performance.now() - start;
      rows.push({ schemaVersion: 1, attemptId: request.id, adapter: request.adapter,
        request: request.args, exitCode: 0, stdout: JSON.stringify(result), deliveryWallMs,
        observation: { plane: 'direct-tool-handler', database: database.name, logs, metadata,
          transportExercised: false, baselineAccepted: false } });
    }
    if (!fs.readFileSync(requestsFile).equals(input)) throw new Error('requests changed during capture');
    fs.writeFileSync(output, JSON.stringify(rows, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } finally {
    await shutdownLocalEmbedder();
    await sql.end({ timeout: 5 });
  }
}

if (isCliEntry(import.meta.url)) {
  runProseAdapterCapture().catch(error => { console.error(error); process.exitCode = 1; });
}
