/**
 * Code-search tool entries for the hermetic scenarios that measure how an agent
 * answers "is X still used?", "what breaks if I change Y?" and "where is Z
 * defined?" (gitnexus-deterministic-integration-2026-10-05 P-015).
 *
 * Kept OUT of `SU_CATALOG` on purpose: appending five tools to the shared su
 * catalog would change the tool set offered to every existing su scenario and
 * silently invalidate their recorded baselines. Instead two targets opt in:
 *   - `su-code` — the canonical su playbook with these tools appended;
 *   - `worker`  — the coding-role prompt (`worker.base.md` + `worker.md`) with
 *                 these tools plus `capability:read`.
 *
 * This is the frozen GitNexus-era catalogue for the original S37/W01 baseline,
 * not a mirror of the current registry. In that fixture graph:query means the
 * indexed GitNexus route; the current native tool uses first-party producers.
 * Keep these descriptions and schemas stable so historical baseline comparisons
 * retain the same instrument. A current native-route measurement needs an explicit
 * scenario-version change and its own qualified world/assertions; updating this
 * catalogue alone would leave the scenario identity unchanged.
 *
 * Every call is answered by the scenario's world
 * (`scenarios/su/S37-code-search-discipline.ts`); nothing here reaches a real
 * index, compiler or shell. Do not count fixture calls as live engine use or
 * compare this baseline directly with current native-route outcomes.
 */
import type { SuCatalogEntry } from './su-catalog';

const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});

export const CODE_SEARCH_TOOL_NAMES = [
  'capability:bash',
  'graph:query',
  'lsp:query',
  'gitnexus.context',
  'gitnexus.query',
] as const;

export const CODE_SEARCH_CATALOG: ReadonlyArray<SuCatalogEntry> = [
  {
    name: 'capability:bash',
    description:
      'Run `bash -c` in the project dir (the repository root); large output is streamed and spilled to a file. ' +
      'Use run_in_background for anything past a minute or two.',
    input: obj({
      cmd: { type: 'string', description: 'The shell command to run.' },
      cwd: { type: 'string' },
      run_in_background: { type: 'boolean' },
    }, ['cmd']),
  },
  {
    name: 'graph:query',
    description:
      'Curated GitNexus topology: symbol | callers | callees | impact | health; refused intents return redirects. ' +
      'Returns `{sites, truncation, freshness, coverage, latencyMs, error}`; `line1` is one-indexed. ' +
      'Fresh or untruncated results do not prove source completeness.',
    input: obj({
      op: {
        type: 'string',
        enum: ['symbol', 'callers', 'callees', 'impact', 'health', 'references', 'symbol-search'],
      },
      name: { type: 'string', description: 'Symbol name. Required for every op except `health`.' },
      kind: { type: 'string' },
      direction: { type: 'string', enum: ['upstream', 'downstream', 'both'] },
      limit: { type: 'integer' },
    }, ['op']),
  },
  {
    name: 'lsp:query',
    description:
      'READ-ONLY TypeScript/Rust compiler intelligence from pinned servers. `op`: symbol | references | ' +
      'implementations | diagnostics | workspace_symbols | health. Returns `{sites, truncation, freshness, ' +
      'coverage, latencyMs, error}`; `line1` is one-indexed.',
    input: obj({
      op: {
        type: 'string',
        enum: ['symbol', 'references', 'implementations', 'diagnostics', 'workspace_symbols', 'health'],
      },
      file: { type: 'string', description: 'File the cursor is in (or, for workspace_symbols, the project anchor).' },
      line1: { type: 'integer', description: 'ONE-indexed line.' },
      character: { type: 'integer', description: 'ZERO-indexed column.' },
      query: { type: 'string', description: 'workspace_symbols only: the symbol name to look up.' },
    }, ['op']),
  },
  {
    name: 'gitnexus.context',
    description:
      'A 360-degree view of one symbol from the GitNexus code graph: where it is defined, its callers, its callees ' +
      'and the processes it takes part in.',
    input: obj({ name: { type: 'string' }, kind: { type: 'string' } }, ['name']),
  },
  {
    name: 'gitnexus.query',
    description: 'Search the GitNexus code graph for execution flows related to a concept or keyword.',
    input: obj({ query: { type: 'string' } }, ['query']),
  },
];
