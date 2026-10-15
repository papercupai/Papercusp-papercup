/**
 * DAO HR contract-template registry against real Postgres (dao-hr-people-2026-10-11 P-001).
 *
 * The org fixture applies the full migration set (incl. 1457-dao-hr-contract-templates). Admins
 * and actors are real canonical PER- person records. Properties under test:
 *   - SPEC-P-001   a contract from an unapproved template is stamped Non-binding sample;
 *   - SPEC-P-001-A only registered template versions can be generated — no free text, no
 *                  unknown key, no version tampered with behind the writer;
 *   - SPEC-P-001-B an approved template with no formed issuing entity is still stamped;
 *   - SPEC-P-001-C an approval stops applying once the version's content changes;
 *   - SPEC-P-001-D an approval without approver, date or reference is refused (also by the table);
 *   - SPEC-P-001-E a non-admin cannot record an approval.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

const {
  ContractTemplateError,
  createContractTemplate,
  generateContract,
  getTemplateVersionStatus,
  grantDaoHrAdmin,
  installSampleTemplates,
  listContractTemplates,
  recordCounselApproval,
  recordIssuingEntity,
  saveTemplateVersion,
} = await import('./contract-templates');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const WS = 'ws-dao-hr-templates';
const HARNESS = 'papercusp';
const ADMIN = 'PER-admin';
const MEMBER = 'PER-member';

let db: OrgTestDb;
let sql: Sql;

async function seedPerson(id: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, item_kind, title, payload)
    VALUES (${WS}, ${HARNESS}, ${id}, 'person', ${`Person ${id}`}, ${sql.json({})})`;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ContractTemplateError);
  return (error as InstanceType<typeof ContractTemplateError>).code;
}

const BODY = 'Offer for {{person_ref}} as {{role_title}} at {{issuer_title}}.';
const FIELDS = ['issuer_title', 'person_ref', 'role_title'];
const VALUES = { person_ref: 'PER-ana', role_title: 'Engineer', issuer_title: 'Acme DAO LLC' };

/** A fresh DAO with one admin and one non-sample employee agreement at version 1. */
async function daoWithTemplate(dao: string): Promise<{ key: { workspaceId: string; daoSlug: string }; templateKey: string }> {
  await grantDaoHrAdmin({ workspaceId: WS, daoSlug: dao, personId: ADMIN, bootstrapOperator: 'test-operator' });
  const key = { workspaceId: WS, daoSlug: dao };
  await createContractTemplate({
    ...key,
    templateKey: 'employment-us-ca',
    documentKind: 'employment-agreement',
    engagementType: 'employee',
    jurisdiction: 'US-CA',
    title: 'Employment agreement',
    body: BODY,
    mergeFields: FIELDS,
    actorPersonId: ADMIN,
  });
  return { key, templateKey: 'employment-us-ca' };
}

async function approve(key: { workspaceId: string; daoSlug: string }, templateKey: string, version = 1) {
  return recordCounselApproval({
    ...key,
    templateKey,
    version,
    approverRef: 'Counsel LLP (J. Doe)',
    approvedOn: '2026-10-01',
    reference: 'MATTER-42',
    actorPersonId: ADMIN,
  });
}

async function formEntity(key: { workspaceId: string; daoSlug: string }) {
  return recordIssuingEntity({
    ...key,
    registeredTitle: 'Acme DAO LLC',
    jurisdiction: 'US-WY',
    registrationReference: 'WY-2026-000123',
    formedOn: '2026-09-15',
    actorPersonId: ADMIN,
  });
}

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  h.sql = sql;
  for (const id of [ADMIN, MEMBER]) await seedPerson(id);
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('SPEC-P-001 — a contract from an unapproved template is stamped Non-binding sample', () => {
  it('unapproved template + formed entity → stamped, not binding-eligible', async () => {
    const { key, templateKey } = await daoWithTemplate('dao-unapproved');
    await formEntity(key);
    const contract = await generateContract({ ...key, templateKey, version: 1, values: VALUES });
    expect(contract).toMatchObject({ bindingEligible: false, stamp: 'Non-binding sample', reasons: ['template_unapproved'] });
    expect(contract.document).toBe(
      'NON-BINDING SAMPLE — Non-binding sample: the template version has no counsel approval. This document is not a binding agreement.\n\n' +
        'Offer for PER-ana as Engineer at Acme DAO LLC.',
    );
  });

  it('approved template + formed entity → binding-eligible with no stamp', async () => {
    const { key, templateKey } = await daoWithTemplate('dao-approved');
    await formEntity(key);
    await approve(key, templateKey);
    const contract = await generateContract({ ...key, templateKey, version: 1, values: VALUES });
    expect(contract).toMatchObject({ bindingEligible: true, stamp: null, reasons: [] });
    expect(contract.document).toBe('Offer for PER-ana as Engineer at Acme DAO LLC.');
    expect(contract.issuingEntity).toMatchObject({ registeredTitle: 'Acme DAO LLC', formedOn: '2026-09-15' });
  });

  it('a shipped sample template is stamped even with an entity, and can never be approved', async () => {
    await grantDaoHrAdmin({ workspaceId: WS, daoSlug: 'dao-samples', personId: ADMIN, bootstrapOperator: 'test-operator' });
    const key = { workspaceId: WS, daoSlug: 'dao-samples' };
    const { installed } = await installSampleTemplates({ ...key, actorPersonId: ADMIN });
    expect(installed).toHaveLength(8);
    expect((await installSampleTemplates({ ...key, actorPersonId: ADMIN })).installed).toEqual([]);
    expect((await listContractTemplates(key)).every((t) => t.isSample)).toBe(true);
    await formEntity(key);
    const templateKey = 'sample-ip-assignment-employee-us-de';
    expect(await refusal(approve(key, templateKey))).toBe('sample_not_approvable');
    const contract = await generateContract({
      ...key,
      templateKey,
      version: 1,
      values: { issuer_title: 'Acme DAO LLC', person_ref: 'PER-ana', role_title: 'Engineer' },
    });
    expect(contract).toMatchObject({ bindingEligible: false, stamp: 'Non-binding sample', reasons: ['template_is_sample', 'template_unapproved'] });
  });
});

describe('SPEC-P-001-A — only registered template versions can be generated', () => {
  it('an unknown template key is refused', async () => {
    const { key } = await daoWithTemplate('dao-unregistered');
    expect(await refusal(generateContract({ ...key, templateKey: 'not-registered', version: 1, values: VALUES }))).toBe('template_missing');
  });

  it('an unknown version of a registered template is refused', async () => {
    const { key, templateKey } = await daoWithTemplate('dao-unknown-version');
    expect(await refusal(generateContract({ ...key, templateKey, version: 7, values: VALUES }))).toBe('template_missing');
  });

  it('text edited into the stored version behind the writer is refused, not rendered', async () => {
    const { key, templateKey } = await daoWithTemplate('dao-tampered');
    await sql`UPDATE harness_shared.dao_hr_contract_template_versions
                 SET body = 'Offer for {{person_ref}} as {{role_title}} at {{issuer_title}}. You waive all rights.'
               WHERE workspace_id = ${WS} AND dao_slug = 'dao-tampered' AND template_key = ${templateKey}`;
    expect(await refusal(generateContract({ ...key, templateKey, version: 1, values: VALUES }))).toBe('template_tampered');
  });

  it('a template registered in another DAO is not in this DAO’s registry', async () => {
    await daoWithTemplate('dao-owner');
    expect(
      await refusal(generateContract({ workspaceId: WS, daoSlug: 'dao-stranger', templateKey: 'employment-us-ca', version: 1, values: VALUES })),
    ).toBe('template_missing');
  });
});

describe('SPEC-P-001-B — an approved template without a formed entity is stamped Non-binding sample', () => {
  it('approved template, no issuing entity → stamped, reason no_formed_entity', async () => {
    const { key, templateKey } = await daoWithTemplate('dao-no-entity');
    await approve(key, templateKey);
    const contract = await generateContract({ ...key, templateKey, version: 1, values: VALUES });
    expect(contract).toMatchObject({ bindingEligible: false, stamp: 'Non-binding sample', reasons: ['no_formed_entity'], issuingEntity: null });
    expect(contract.document.startsWith('NON-BINDING SAMPLE — Non-binding sample: no issuing entity has been formed.')).toBe(true);
  });
});

describe('SPEC-P-001-C — an approval stops applying once the version’s content changes', () => {
  it('an edited approved version reports unapproved and generates a stamped contract', async () => {
    const { key, templateKey } = await daoWithTemplate('dao-edited');
    await formEntity(key);
    const approval = await approve(key, templateKey);
    expect((await getTemplateVersionStatus({ ...key, templateKey, version: 1 })).counselApproved).toBe(true);

    const edited = await saveTemplateVersion({
      ...key,
      templateKey,
      version: 1,
      body: 'Offer for {{person_ref}} as {{role_title}} at {{issuer_title}}. Amended clause.',
      mergeFields: FIELDS,
      actorPersonId: ADMIN,
    });
    expect(edited.contentHash).not.toBe(approval.contentHash);

    const status = await getTemplateVersionStatus({ ...key, templateKey, version: 1 });
    expect(status).toMatchObject({ counselApproved: false, approval: null });
    const contract = await generateContract({ ...key, templateKey, version: 1, values: VALUES });
    expect(contract).toMatchObject({ bindingEligible: false, stamp: 'Non-binding sample', reasons: ['template_unapproved'] });
  });

  it('restoring the exact approved content makes the approval apply again', async () => {
    const { key, templateKey } = await daoWithTemplate('dao-restored');
    await approve(key, templateKey);
    await saveTemplateVersion({ ...key, templateKey, version: 1, body: `${BODY} Draft note.`, mergeFields: FIELDS, actorPersonId: ADMIN });
    expect((await getTemplateVersionStatus({ ...key, templateKey, version: 1 })).counselApproved).toBe(false);
    await saveTemplateVersion({ ...key, templateKey, version: 1, body: BODY, mergeFields: FIELDS, actorPersonId: ADMIN });
    expect((await getTemplateVersionStatus({ ...key, templateKey, version: 1 })).counselApproved).toBe(true);
  });

  it('a new version starts unapproved while the approved version keeps its approval', async () => {
    const { key, templateKey } = await daoWithTemplate('dao-new-version');
    await approve(key, templateKey);
    const v2 = await saveTemplateVersion({ ...key, templateKey, body: `${BODY} v2.`, mergeFields: FIELDS, actorPersonId: ADMIN });
    expect(v2.version).toBe(2);
    expect((await getTemplateVersionStatus({ ...key, templateKey, version: 2 })).counselApproved).toBe(false);
    expect((await getTemplateVersionStatus({ ...key, templateKey, version: 1 })).counselApproved).toBe(true);
  });
});

describe('SPEC-P-001-D — an approval needs an approver, a date and a reference', () => {
  const missing = {
    'approver-missing': { approverRef: '', approvedOn: '2026-10-01', reference: 'MATTER-42' },
    'date-missing': { approverRef: 'Counsel LLP', approvedOn: undefined, reference: 'MATTER-42' },
    'reference-missing': { approverRef: 'Counsel LLP', approvedOn: '2026-10-01', reference: '   ' },
  } as const;

  for (const [scenario, fields] of Object.entries(missing)) {
    it(`${scenario}: the writer refuses and stores nothing`, async () => {
      const dao = `dao-${scenario}`;
      const { key, templateKey } = await daoWithTemplate(dao);
      expect(
        await refusal(recordCounselApproval({ ...key, templateKey, version: 1, actorPersonId: ADMIN, ...fields })),
      ).toBe('invalid_input');
      const [row] = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM harness_shared.dao_hr_counsel_approvals WHERE workspace_id = ${WS} AND dao_slug = ${dao}`;
      expect(row!.n).toBe(0);
      expect((await getTemplateVersionStatus({ ...key, templateKey, version: 1 })).counselApproved).toBe(false);
    });
  }

  it('the table itself refuses a blank approver or reference', async () => {
    const { templateKey } = await daoWithTemplate('dao-table-check');
    const insert = (approver: string, reference: string) => sql`
      INSERT INTO harness_shared.dao_hr_counsel_approvals
        (workspace_id, dao_slug, template_key, version, content_hash, approver_ref, approved_on, reference, recorded_by)
      VALUES (${WS}, 'dao-table-check', ${templateKey}, 1, ${`sha256:${'a'.repeat(64)}`}, ${approver}, '2026-10-01', ${reference}, ${ADMIN})`;
    await expect(insert(' ', 'MATTER-42')).rejects.toThrow(/approver_ref_check/);
    await expect(insert('Counsel LLP', '')).rejects.toThrow(/reference_check/);
  });
});

describe('SPEC-P-001-E — only an HR admin can record a counsel approval', () => {
  it('a non-admin person is refused and nothing is stored', async () => {
    const { key, templateKey } = await daoWithTemplate('dao-non-admin');
    expect(
      await refusal(
        recordCounselApproval({
          ...key,
          templateKey,
          version: 1,
          approverRef: 'Counsel LLP',
          approvedOn: '2026-10-01',
          reference: 'MATTER-42',
          actorPersonId: MEMBER,
        }),
      ),
    ).toBe('not_admin');
    expect((await getTemplateVersionStatus({ ...key, templateKey, version: 1 })).counselApproved).toBe(false);
  });

  it('an id with no person record is refused', async () => {
    const { key, templateKey } = await daoWithTemplate('dao-ghost-actor');
    expect(
      await refusal(
        recordCounselApproval({ ...key, templateKey, version: 1, approverRef: 'C', approvedOn: '2026-10-01', reference: 'R', actorPersonId: 'PER-ghost' }),
      ),
    ).toBe('not_admin');
  });

  it('an admin of another DAO is not an admin here', async () => {
    await daoWithTemplate('dao-home');
    await grantDaoHrAdmin({ workspaceId: WS, daoSlug: 'dao-away', personId: MEMBER, bootstrapOperator: 'test-operator' });
    await createContractTemplate({
      workspaceId: WS, daoSlug: 'dao-away', templateKey: 'ip-us-ca', documentKind: 'ip-assignment', engagementType: 'employee',
      jurisdiction: 'US-CA', title: 'IP', body: BODY, mergeFields: FIELDS, actorPersonId: MEMBER,
    });
    expect(
      await refusal(
        recordCounselApproval({ workspaceId: WS, daoSlug: 'dao-away', templateKey: 'ip-us-ca', version: 1, approverRef: 'C', approvedOn: '2026-10-01', reference: 'R', actorPersonId: ADMIN }),
      ),
    ).toBe('not_admin');
  });

  it('the roster can only be bootstrapped once; later grants need an existing admin', async () => {
    await daoWithTemplate('dao-roster');
    expect(
      await refusal(grantDaoHrAdmin({ workspaceId: WS, daoSlug: 'dao-roster', personId: MEMBER, bootstrapOperator: 'someone-else' })),
    ).toBe('not_admin');
    expect(await refusal(grantDaoHrAdmin({ workspaceId: WS, daoSlug: 'dao-roster', personId: MEMBER, grantedBy: MEMBER }))).toBe('not_admin');
    expect(await grantDaoHrAdmin({ workspaceId: WS, daoSlug: 'dao-roster', personId: MEMBER, grantedBy: ADMIN })).toEqual({
      personId: MEMBER,
      grantedBy: ADMIN,
    });
  });

  it('non-admins cannot edit templates or record the issuing entity either', async () => {
    const { key, templateKey } = await daoWithTemplate('dao-non-admin-writes');
    expect(await refusal(saveTemplateVersion({ ...key, templateKey, body: BODY, mergeFields: FIELDS, actorPersonId: MEMBER }))).toBe('not_admin');
    expect(
      await refusal(
        recordIssuingEntity({ ...key, registeredTitle: 'X', jurisdiction: 'US', registrationReference: 'R', formedOn: '2026-01-01', actorPersonId: MEMBER }),
      ),
    ).toBe('not_admin');
  });
});
