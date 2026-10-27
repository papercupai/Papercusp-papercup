/**
 * Native, runtime-witnessed re-verification of a committed get-feedback consult
 * receipt matrix (get-feedback-reliability-usefulness-adoption-2026-10-03 R-6).
 *
 * An evidence-file import (testing:record-run { evidenceFile }) carries no
 * execution-time runtime witness, so a live-plane binding on it can never read
 * environment-current. This check re-reads every claimed receipt from the operator
 * database inside executeOperationalRun, which witnesses the database unit before
 * and after execution (EI-26224370130119919).
 *
 * It lives OUTSIDE record-run.ts on purpose: live spec bindings pin that file, so a
 * new native check there would make other plans' evidence non-current
 * (EI-26555275260059787). executeOperationalRun is imported, never edited.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { getOrgPg } from '@papercusp/db-org';
import { executeOperationalRun, resolveOperationalSourceRoot, type OperationalEvidenceArtifact } from './record-run';

type NativeCheckContext = Parameters<typeof executeOperationalRun>[1];
type NativeCheckExecution = Parameters<typeof executeOperationalRun>[2];
type Assertion = OperationalEvidenceArtifact['assertions'][number];

/** The committed check definition: this module (cells + oracle). */
export const CONSULT_RECEIPT_CHECK_PATH = 'packages/operator-core/lib/agent-tools/testing/native-check-consult-receipts.ts';
/** The generator's substantive-answer floor; a shorter post is an acknowledgement, not feedback. */
export const CONSULT_RECEIPT_MIN_ANSWER_CHARS = 400;

type CellDefinition =
  | { mode: 'fork'; targetBackend: string }
  | { mode: 'port'; sourceBackend: string; targetBackend: string };

/**
 * The defined matrix per plan. The definition — not the artifact — fixes which
 * cells must be present, so an artifact that omits a path fails rather than
 * shrinking the matrix (R-6 falsifier: "an unavailable path is omitted").
 */
export const CONSULT_RECEIPT_MATRICES: Readonly<Record<string, Readonly<Record<string, CellDefinition>>>> = {
  'get-feedback-reliability-usefulness-adoption-2026-10-03': {
    'claude-ended-to-claude-fork': { mode: 'fork', targetBackend: 'claude' },
    'claude-ended-to-codex-conversion': { mode: 'port', sourceBackend: 'claude', targetBackend: 'codex' },
    'codex-live-to-codex-session-port': { mode: 'port', sourceBackend: 'codex', targetBackend: 'codex' },
  },
};

const cellSchema = z.object({
  cell: z.string().min(1).max(200),
  mode: z.enum(['fork', 'port']),
  requestKey: z.string().min(1).max(200),
  conversationId: z.string().regex(/^conv-[a-z0-9-]{1,200}$/),
  portId: z.string().min(1).max(200).nullable().optional(),
  sourceOwnerId: z.string().min(1).max(200),
  answeringOwnerId: z.string().min(1).max(200),
}).passthrough();

const matrixArtifactSchema = z.object({
  plan: z.string().min(1).max(200),
  requesterId: z.string().min(1).max(200),
  matrix: z.object({ cells: z.array(cellSchema).min(1).max(32) }).passthrough(),
}).passthrough();
export type ConsultReceiptMatrixArtifact = z.infer<typeof matrixArtifactSchema>;

export interface ConsultReceiptRows {
  database: string;
  port: number;
  consults: Array<{ conversation_id: string; requester_id: string | null; state: string | null; dispatch_attempts: unknown }>;
  posts: Array<{ id: number | string; thread_id: string; author_id: string | null; len: number | string }>;
  ports: Array<{ id: string; source_backend: string | null; target_backend: string | null; status: string | null;
    delivered_at: unknown; error: unknown; source_adv_session_id: string | null; target_adv_session_id: string | null }>;
}

/** Every read runs in ONE read-only repeatable-read snapshot, so all cells are judged against the same data. */
async function readConsultReceiptRows(workspaceId: string, conversations: string[], portIds: string[]): Promise<ConsultReceiptRows> {
  const { sql } = getOrgPg();
  return sql.begin('isolation level repeatable read, read only', async (tx) => {
    await tx`SET LOCAL statement_timeout = '15s'`;
    const [identity] = await tx`SELECT current_database() AS database, inet_server_port() AS port`;
    const threads = conversations.map(id => `thr-${id}`);
    const consults = conversations.length === 0 ? [] : await tx`
      SELECT conversation_id, requester_id, state, dispatch_attempts FROM harness_shared.consult_state
       WHERE workspace_id = ${workspaceId} AND conversation_id = ANY(${conversations}::text[])`;
    const posts = threads.length === 0 ? [] : await tx`
      SELECT id, thread_id, author_id, length(body) AS len FROM harness_shared.coord_thread_posts
       WHERE workspace_id = ${workspaceId} AND thread_id = ANY(${threads}::text[]) ORDER BY id`;
    const ports = portIds.length === 0 ? [] : await tx`
      SELECT id::text AS id, source_backend, target_backend, status, delivered_at, error,
             source_adv_session_id, target_adv_session_id
        FROM harness_shared.session_ports WHERE workspace_id = ${workspaceId} AND id::text = ANY(${portIds}::text[])`;
    return { database: String(identity?.database ?? ''), port: Number(identity?.port),
      consults: [...consults], posts: [...posts], ports: [...ports] } as ConsultReceiptRows;
  }) as Promise<ConsultReceiptRows>;
}

type Attempt = { agent?: unknown; operation?: unknown; answeringOwnerId?: unknown; sourceOwnerId?: unknown };

/**
 * The oracle. Judges one snapshot of durable rows against the committed claims and
 * the defined matrix; pure, so its every branch is unit-testable.
 */
export function judgeConsultReceiptMatrix(input: {
  artifact: ConsultReceiptMatrixArtifact;
  definition: Readonly<Record<string, CellDefinition>>;
  rows: Pick<ConsultReceiptRows, 'consults' | 'posts' | 'ports'>;
}): Assertion[] {
  const { artifact, definition, rows } = input;
  const assertions: Assertion[] = [];
  const add = (id: string, passed: boolean, evidence: string) =>
    assertions.push({ id, passed, evidence: evidence.slice(0, 2000) });
  for (const [name, def] of Object.entries(definition)) {
    const claimed = artifact.matrix.cells.filter(cell => cell.cell === name);
    const cell = claimed.length === 1 ? claimed[0]! : undefined;
    if (!cell) {
      add(`cell:${name}`, false, `artifact carries ${claimed.length} entries for defined cell ${name}; exactly one is required`);
      continue;
    }
    const consult = rows.consults.find(row => row.conversation_id === cell.conversationId);
    const attempts = (Array.isArray(consult?.dispatch_attempts) ? consult!.dispatch_attempts : []) as Attempt[];
    const dispatched = attempts.filter(a => typeof a?.answeringOwnerId === 'string' && a.answeringOwnerId);
    const attempt = dispatched[dispatched.length - 1];
    const answering = typeof attempt?.answeringOwnerId === 'string' ? attempt.answeringOwnerId : null;
    const source = typeof attempt?.sourceOwnerId === 'string' ? attempt.sourceOwnerId : null;
    const requester = artifact.requesterId;
    const answer = rows.posts.find(post => post.thread_id === `thr-${cell.conversationId}` &&
      post.author_id !== null && post.author_id !== requester && post.author_id !== source &&
      Number(post.len) >= CONSULT_RECEIPT_MIN_ANSWER_CHARS);
    const checks: Record<string, boolean> = {
      consult_row_present: consult !== undefined,
      mode_matches_definition: cell.mode === def.mode,
      requester_matches_claim: consult?.requester_id === requester,
      dispatched_session_matches_claim: answering !== null && answering === cell.answeringOwnerId,
      source_matches_claim: source !== null && source === cell.sourceOwnerId,
      distinct_answering_session: answering !== null && answering !== source && answering !== requester,
      substantive_answer_posted: answer !== undefined,
      answer_author_is_dispatched_session: answer !== undefined && answer.author_id === answering,
    };
    let mechanism: string;
    if (def.mode === 'fork') {
      checks.native_fork_dispatched = attempt?.operation === 'fork';
      checks.fork_backend_matches_definition = attempt?.agent === def.targetBackend;
      mechanism = `fork ${source ?? '-'} -> ${String(attempt?.agent ?? '-')} as ${answering ?? '-'}`;
    } else {
      const port = cell.portId ? rows.ports.find(row => row.id === cell.portId) : undefined;
      checks.port_row_present = port !== undefined;
      checks.port_delivered = port?.status === 'delivered' && port.delivered_at != null && !port.error;
      checks.backends_match_definition = port?.source_backend === def.sourceBackend && port?.target_backend === def.targetBackend;
      checks.distinct_target_session = !!port?.target_adv_session_id && port.target_adv_session_id !== port.source_adv_session_id;
      mechanism = `port ${cell.portId ?? 'none'} ${port?.source_backend ?? '-'}->${port?.target_backend ?? '-'} ` +
        `status ${port?.status ?? '-'}; ${String(attempt?.operation ?? '-')} as ${answering ?? '-'}`;
    }
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key);
    add(`cell:${name}`, failed.length === 0,
      `${cell.conversationId} (request key ${cell.requestKey}): ${mechanism}; consult ${consult?.state ?? 'missing'}; ` +
      `answer post ${answer ? `${answer.id} by ${answer.author_id} (${answer.len} chars)` : 'NONE'}; ` +
      `failed=${failed.join(',') || 'none'}`);
  }
  const defined = Object.keys(definition);
  const checked = assertions.filter(a => a.passed).map(a => a.id.slice('cell:'.length));
  const extra = artifact.matrix.cells.map(cell => cell.cell).filter(name => !(name in definition));
  add('matrix:all-defined-cells-checked', checked.length === defined.length && extra.length === 0,
    `defined=${defined.join(',')}; checked=${checked.join(',') || 'none'}; undefined-in-artifact=${extra.join(',') || 'none'}`);
  return assertions;
}

/** Execute the receipt-matrix re-verification against the operator database and record it. */
export async function executeConsultReceiptMatrix(
  evidenceFile: string,
  ctx: NativeCheckContext,
  deps?: {
    readSource?: (path: string) => Promise<string>;
    query?: (workspaceId: string, conversations: string[], portIds: string[]) => Promise<ConsultReceiptRows>;
    execution?: NativeCheckExecution;
  },
) {
  if (!/^docs\/evidence\/[A-Za-z0-9._/-]+\.json$/.test(evidenceFile) || evidenceFile.includes('..')) {
    return { ok: false, error: 'invalid_evidence_file' as const };
  }
  const workspaceId = ctx.workspaceId?.trim();
  if (!workspaceId || workspaceId === '*') return { ok: false, error: 'workspace_required' as const };
  const readSource = deps?.readSource ?? (async (path: string) => {
    const root = await (deps?.execution?.sourceRoot ?? resolveOperationalSourceRoot)();
    if (!root) throw new Error('operational source root unavailable');
    return readFile(join(root, path), 'utf8');
  });
  const query = deps?.query ?? readConsultReceiptRows;
  // The database unit is witnessed before execution, so identify the server first.
  let server: ConsultReceiptRows;
  try { server = await query(workspaceId, [], []); }
  catch { return { ok: false, error: 'operational_database_unavailable' as const }; }
  if (!server.database || !Number.isInteger(server.port) || server.port <= 0) {
    return { ok: false, error: 'operational_database_unavailable' as const };
  }
  return executeOperationalRun({ filePath: CONSULT_RECEIPT_CHECK_PATH,
    name: 'get-feedback native consult receipt matrix (re-verified against the operator database)',
    framework: 'operational',
    command: ['testing:record-native-check', 'consultReceiptMatrix', evidenceFile],
    runtimeUnits: [`postgres:${server.port}`],
    run: async () => {
      const text = await readSource(evidenceFile);
      const digest = createHash('sha256').update(text).digest('hex');
      const assertions: Assertion[] = [];
      const parsed = (() => { try { return matrixArtifactSchema.safeParse(JSON.parse(text)); } catch { return null; } })();
      if (!parsed?.success) {
        return { exitCode: 1, summary: 'Receipt-matrix artifact is not a parseable matrix.', assertions: [{
          id: 'definition:artifact-parsed', passed: false, evidence: `${evidenceFile} sha256:${digest}` }] };
      }
      const artifact = parsed.data;
      const definition = CONSULT_RECEIPT_MATRICES[artifact.plan];
      assertions.push({ id: 'definition:matrix-defined', passed: definition !== undefined,
        evidence: `plan=${artifact.plan}; artifact ${evidenceFile} sha256:${digest}` });
      if (definition) {
        const conversations = [...new Set(artifact.matrix.cells.map(cell => cell.conversationId))];
        const portIds = [...new Set(artifact.matrix.cells.flatMap(cell => cell.portId ? [cell.portId] : []))];
        const rows = await query(workspaceId, conversations, portIds);
        assertions.push({ id: 'scope:database-unchanged', passed: rows.database === server.database && rows.port === server.port,
          evidence: `witnessed ${server.database}@${server.port}; executed ${rows.database}@${rows.port}` });
        assertions.push(...judgeConsultReceiptMatrix({ artifact, definition, rows }));
      }
      const failed = assertions.some(assertion => !assertion.passed);
      return { exitCode: failed ? 1 : 0, assertions,
        summary: failed ? 'Receipt matrix re-verification failed; inspect the recorded assertions.'
          : `Every defined cell's native receipt and substantive answer re-verified in one read-only snapshot of ${server.database}@${server.port}.` };
    },
  }, ctx, deps?.execution);
}
