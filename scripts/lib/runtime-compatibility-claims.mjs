/** P-001: actual routine claim code against a private PostgreSQL fixture.
 * This measures claim/dispatch fences, not DBOS delivery or global bg ownership.
 * The caller provisions the database; this module never provisions live state.
 */
import postgres from 'postgres';

export async function perform() {
  const url = new URL(process.env.PAPERCUSP_PROBE_PG_URL ?? '');
  const nonce = process.env.PAPERCUSP_PROBE_NONCE;
  const id = process.env.PAPERCUSP_PROBE_ROUTINE_ID;
  const attempt = process.env.PAPERCUSP_PROBE_ATTEMPT;
  const action = process.env.PAPERCUSP_PROBE_ACTION ?? 'claim';
  if (!/^runtime_claim_[a-f0-9]{12}$/.test(url.pathname.slice(1))
      || !nonce || !id || !attempt || !['claim', 'dispatch'].includes(action)) {
    throw new Error('An isolated runtime_claim database and explicit fixture identity are required');
  }
  const sql = postgres(url.href, { prepare: false, max: 1, connect_timeout: 5,
    connection: { statement_timeout: 15_000 }, onnotice: () => {} });
  try {
    const [guard] = await sql`SELECT nonce FROM runtime_probe.guard WHERE nonce = ${nonce}`;
    if (!guard) throw new Error('Runtime claim fixture identity mismatch');
    // Use the maintained source module without replacing its SQL, clock, or
    // schedule computation. Node loads TS through the existing tsx API; Bun
    // loads it natively. No service credentials are inherited by the runner.
    const source = new URL('../../packages/operator-core/lib/harness/routines/claim.ts', import.meta.url);
    const { claimDueRoutine, claimedRoutineDispatchAllowed } = process.versions.bun
      ? await import(source.href)
      : await (await import('tsx/esm/api')).tsImport(source.href, import.meta.url);
    const [routine] = await sql`
      SELECT id, workspace_id AS "workspaceId", install_slug AS "installSlug", name,
             target_role AS "targetRole", trigger_config AS "triggerConfig",
             reschedule_interval_sec AS "rescheduleIntervalSec", next_fire_at AS "nextFireAt"
        FROM harness_shared.routines WHERE id = ${id}`;
    if (!routine) throw new Error('Missing routine fixture');
    // A parent-held row lock lets both interpreters capture the same snapshot
    // before either UPDATE completes. This receipt marks capture, not victory.
    await sql`INSERT INTO runtime_probe.attempts (attempt) VALUES (${attempt})`;
    const claimed = action === 'claim' ? await claimDueRoutine(sql, routine) : null;
    const allowed = action === 'dispatch' || claimed
      ? await claimedRoutineDispatchAllowed(sql, routine) : false;
    if (allowed) await sql`INSERT INTO runtime_probe.effects (attempt) VALUES (${attempt})`;
    return { claimed, allowed };
  } finally { await sql.end({ timeout: 2 }); }
}
