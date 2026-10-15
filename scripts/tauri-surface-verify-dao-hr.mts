/** Maintained ledger-recorded DAO HR native acceptance leg. */
// VERIFY_TAURI_ASSERTION_REQUIRED_ENV=PAPERCUSP_TEST_RUNS_DB_URL,PAPERCUSP_TEST_RUN_WORKSPACE,DAO_HR_NATIVE_CONFIG,DAO_WORKBENCH_IDENTITY_FIXTURE,DOCUMENSO_URL,DOCUMENSO_TEST_MAIL_URL,DOCUMENSO_TEST_RUNTIME,DOCUMENSO_API_KEY,DOCUMENSO_WEBHOOK_SECRET,PAPERCUSP_RECONCILIATION_CHAIN_RPC_URL,PAPERCUSP_CUPBOARD_URL
import { defaultEvidenceRoot, parseSelectionArgs, runHarness } from '@papercusp/verification-harness';
import { runNativeE2e } from './tauri-surface-verify-reports.mts';

const selection = parseSelectionArgs(process.argv.slice(2));
const result = await runHarness({
  contract: { name: 'dao-hr-tauri', phases: [{ id: 'native', description: 'Ledger-recorded DAO HR native acceptance' }] },
  evidenceRoot: defaultEvidenceRoot('dao-hr-tauri'), selection, reuseFrom: selection.reuse,
  async runPhase(ctx) {
    ctx.markStep('isolated-native-DAO-HR');
    await runNativeE2e(['packages/operator-core/lib/dao-hr/native.e2e.test.ts'], { runtimeUnit: 'dao-hr-native-desktop' });
    return { ok: true };
  },
});
process.exitCode = result.verdict === 'pass' ? 0 : 1;
