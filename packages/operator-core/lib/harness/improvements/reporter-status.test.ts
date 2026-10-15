import { describe, expect, it } from 'vitest';
import { createImplementationReadiness, sealImplementationAcceptance } from './agent-review-policy';
import { deriveReporterStatus, readReporterFollowUp, readReporterStatus, type ReporterReleaseReceipt } from './reporter-status';

const source = { kind: 'bug', title: 'Parser loses the trailing token', summary: 'The last token disappears on every bounded line.' };
const accepted = sealImplementationAcceptance({
  proposal: { problem: source.summary, evidence: ['parser.test.ts fails'], outcome: 'All tokens survive', scope: 'Parser only', completionCheck: 'Trailing-token fixture passes' },
  authority: { kind: 'agent-review', reviewer: 'su-reviewer', submittedBy: 'su-filer', round: 1 },
  reason: 'independent reproduction', source, acceptedAt: '2026-10-07T00:00:00Z',
  reproduction: { kind: 'failing-test', ref: 'parser.test.ts', buildSha: 'abcdef1' },
});
if (!accepted.ok) throw new Error(JSON.stringify(accepted));
const payload = { implementationReadiness: createImplementationReadiness({
  status: 'ready', source: 'agent-review', reason: 'reviewed', updatedAt: '2026-10-07T00:00:00Z', evidence: { acceptance: accepted.contract },
}) };
const base = { ...source, status: 'open', payload };
const published: ReporterReleaseReceipt = {
  schemaVersion: 'reporter-release-v1', version: '0.0.25', channel: 'alpha', publishedAt: '2026-10-07T04:00:00Z',
  artifactCommit: 'a'.repeat(40), completionRef: 'close-1', contentIdentity: [{ path: 'src/parser.ts', blobSha: 'b'.repeat(40) }],
};

describe('the shared source reader admits human chat reporters', () => {
  function reader(kind: string) {
    const calls: unknown[][] = [];
    const sql = async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      if (calls.length === 1) return [{ payload: { reporter: { kind } } }];
      if (calls.length === 2) return [{ feature_id: 'WI-SOURCE', item_kind: 'bug', status: 'open', payload: {}, title: source.title, summary: source.summary, taken_by: null, authority: null, terminal_completion_ref: null, admission: null }];
      return [{ active: false }];
    };
    return { sql, calls };
  }
  it.each(['chat', 'end-user'])('reads %s source status with workspace and harness constraints on every query', async (kind) => {
    const { sql, calls } = reader(kind);
    expect(await readReporterStatus({ id: 'WI-SOURCE', harness: 'report-harness', workspaceId: 'report-workspace' }, sql as never))
      .toMatchObject({ sourceId: 'WI-SOURCE', canonicalId: 'WI-SOURCE', status: 'received' });
    expect(calls).toHaveLength(3);
    for (const values of calls) expect(values.slice(0, 2)).toEqual(['report-workspace', 'report-harness']);
  });
  it.each(['agent', 'watchdog', 'unknown'])('rejects %s before canonical status is read', async (kind) => {
    const { sql, calls } = reader(kind);
    expect(await readReporterStatus({ id: 'WI-SOURCE', harness: 'report-harness', workspaceId: 'report-workspace' }, sql as never)).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe('P016 reporter status is backed by verified work and a published fix', () => {
  it('distinguishes receipt, active verification, queued fixing and active fixing', () => {
    expect(deriveReporterStatus({ ...base, payload: {} }).status).toBe('received');
    expect(deriveReporterStatus({ ...base, payload: {}, verificationActive: true }).status).toBe('being-verified');
    expect(deriveReporterStatus(base).status).toBe('awaiting-fix');
    expect(deriveReporterStatus({ ...base, assignee: 'su-fixer' }).status).toBe('being-fixed');
  });

  it('a successful close or deployed operator alone does not claim a released fix', () => {
    expect(deriveReporterStatus({ ...base, status: 'done', completionAuthority: 'committed', terminalCompletionRef: 'close-1' })).toMatchObject({ status: 'awaiting-release', release: null });
    expect(deriveReporterStatus({ ...base, status: 'done', payload: {}, completionAuthority: 'committed' }).status).toBe('closed');
  });

  it('reports fixed in vX only for the published artifact bound to the current verified completion', () => {
    const completed = { ...base, status: 'done', completionAuthority: 'committed', terminalCompletionRef: 'close-1', payload: { ...payload, reporterRelease: published } };
    expect(deriveReporterStatus(completed)).toMatchObject({ status: 'fixed', label: 'Fixed in v0.0.25', release: published });
    expect(deriveReporterStatus({ ...completed, status: 'open' }).status).not.toBe('fixed');
    expect(deriveReporterStatus({ ...completed, terminalCompletionRef: 'close-2' }).status).toBe('awaiting-release');
    expect(deriveReporterStatus({ ...completed, payload: { ...payload, reporterRelease: { ...published, contentIdentity: [] } } }).status).toBe('awaiting-release');
    expect(deriveReporterStatus({ ...completed, payload: { ...payload, reporterRelease: { ...published, publishedAt: null } } }).status).toBe('awaiting-release');
  });
});

describe('the follow-up belongs to one question across separate canonical/source payloads', () => {
  const question = { id: 'q1', text: 'Which input triggers it?', askedBy: 'su-fixer', askedAt: '2026-10-07T00:00:00Z' };
  it('joins the matching install answer without moving authorship', () => {
    const canonical = { reporterQuestion: question };
    const sourcePayload = { reporterAnswer: { questionId: 'q1', text: 'The attached example', answeredAt: '2026-10-07T01:00:00Z' } };
    expect(readReporterFollowUp(canonical, sourcePayload)).toMatchObject({ question, answer: { text: 'The attached example' } });
    expect(canonical).toEqual({ reporterQuestion: question });
  });
  it('never attaches an answer to a different question', () => {
    expect(readReporterFollowUp({ reporterQuestion: question }, { reporterAnswer: { questionId: 'old', text: 'Old reply', answeredAt: '2026-10-07T01:00:00Z' } })).toEqual({ question });
  });
});
