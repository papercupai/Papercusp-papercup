/**
 * Owner release authority against real Postgres (plan
 * personal-data-reader-set-labels-2026-10-01 P-005, D-005; WI-10004902).
 *
 * declassify.test.ts runs the rule with the directive store mocked. What only
 * the real owner_directives table can show is that the lookup the rule rests on
 * finds the right row — an owner-typed turn in THIS session carrying the code,
 * never an agent-recorded row, another session's turn or a declined one — and
 * that citing any of those by id is refused for its own reason.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { dispositionOwnerDirective, recordOwnerDirective } from '../owner-directives';
import { releaseCode, verifyReleaseAuthority } from './release-authority';

const WS = 'release-authority-test';
const ELSEWHERE = 'release-authority-test-elsewhere';
const AGENT = 'su-release-agent-a';
const OTHER_AGENT = 'su-release-agent-b';
const REQUEST = 'declassify:all';
const CODE = releaseCode(AGENT, REQUEST);

let org: OrgTestDb;
let turn = 0;

beforeAll(async () => {
  org = await createOrgTestDb();
}, 120_000);

afterAll(async () => {
  if (org) {
    await org.adminSql`DELETE FROM harness_shared.owner_directives WHERE workspace_id IN (${WS}, ${ELSEWHERE})`.catch(() => {});
  }
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.owner_directives WHERE workspace_id IN (${WS}, ${ELSEWHERE})`;
});

function ownerTurn(text: string, overrides: { recordedBy?: string; capturedByHook?: boolean; workspaceId?: string } = {}) {
  turn += 1;
  const recordedBy = overrides.recordedBy ?? AGENT;
  return recordOwnerDirective({
    workspaceId: overrides.workspaceId ?? WS,
    sessionRef: `session-${recordedBy}`,
    sourceTurnRef: `release-authority-turn-${Date.now()}-${turn}`,
    verbatimText: text,
    recordedBy,
    capturedByHook: overrides.capturedByHook ?? true,
  }, org.adminSql);
}

function decline(id: number) {
  return dispositionOwnerDirective({ id, status: 'declined', note: 'owner withdrew it', dispositionedBy: AGENT }, org.adminSql);
}

function verify(overrides: { directiveId?: number; notBefore?: Date | null } = {}) {
  return verifyReleaseAuthority({
    workspaceId: WS,
    agentOwnerId: AGENT,
    request: REQUEST,
    describe: 'lift every reader-set restriction this agent carries',
    directiveId: overrides.directiveId,
    notBefore: overrides.notBefore ?? null,
  }, org.adminSql);
}

async function refusalFor(directiveId: number) {
  const result = await verify({ directiveId });
  return result.ok ? 'ok' : result.code;
}

describe('verifyReleaseAuthority against owner_directives', () => {
  it('finds the owner-typed turn in this session that carries the code, whatever its case', async () => {
    await ownerTurn('continue with the plan');
    const typed = await ownerTurn(`ok, release ${CODE.toLowerCase()} please`);

    expect(await verify()).toEqual({
      ok: true,
      directiveId: typed.id,
      releaseRef: `owner_directive:${typed.id}`,
      capturedAt: new Date(typed.createdAtMs),
    });
  });

  it("does not find the code in an agent-recorded row, another session's turn or a declined turn", async () => {
    await ownerTurn(`release ${CODE}`, { capturedByHook: false });
    await ownerTurn(`release ${CODE}`, { recordedBy: OTHER_AGENT });
    await decline((await ownerTurn(`release ${CODE}`)).id);

    expect(await verify()).toMatchObject({ ok: false, code: 'release_authority_required', releaseCode: CODE });
  });

  it('refuses each disqualified turn for its own reason when it is cited by id', async () => {
    const agentRecorded = await ownerTurn(`release ${CODE}`, { capturedByHook: false });
    const foreign = await ownerTurn(`release ${CODE}`, { recordedBy: OTHER_AGENT });
    const declined = await ownerTurn(`release ${CODE}`);
    await decline(declined.id);
    const otherRequest = await ownerTurn(`release ${releaseCode(AGENT, 'declassify:some-other-document')}`);
    const elsewhere = await ownerTurn(`release ${CODE}`, { workspaceId: ELSEWHERE });

    expect(await refusalFor(agentRecorded.id)).toBe('release_authority_not_owner_typed');
    expect(await refusalFor(foreign.id)).toBe('release_authority_foreign');
    expect(await refusalFor(declined.id)).toBe('release_authority_declined');
    expect(await refusalFor(otherRequest.id)).toBe('release_authority_code_missing');
    expect(await refusalFor(elsewhere.id)).toBe('release_authority_not_found');
    expect(await refusalFor(2_000_000_000)).toBe('release_authority_not_found');
  });

  it('does not accept the code as part of a longer word', async () => {
    await ownerTurn(`release X${CODE}9`);
    expect(await verify()).toMatchObject({ ok: false, code: 'release_authority_code_missing' });
  });

  it('refuses a turn typed before what it would release was delivered', async () => {
    const typed = await ownerTurn(`release ${CODE}`);

    expect(await verify({ notBefore: new Date(typed.createdAtMs - 1_000) })).toMatchObject({ ok: true, directiveId: typed.id });
    expect(await verify({ notBefore: new Date(typed.createdAtMs + 1_000) })).toMatchObject({ ok: false, code: 'release_authority_stale' });
  });
});
