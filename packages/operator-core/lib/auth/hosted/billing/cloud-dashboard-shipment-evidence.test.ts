/**
 * Detector for the committed shipment evidence of plan
 * cloud-dashboard-stripe-test-rollout-2026-10-03 (acceptance rubric r-3 / BAR R-3,
 * "Shipped means deployed and verified").
 *
 * The opted-in live Stripe suite (`stripe-billing.live.integration.test.ts`) only
 * runs when TEST credentials are injected, so on an ordinary run it SKIPS — and a
 * skipped file reads green. It also exercises a single plan key and makes no
 * serving-identity assertion. This suite is the non-skippable half of R-3: it reads
 * the committed evidence of record and fails when
 *   - either offer's live journey is missing or incomplete (checkout, webhook-active,
 *     customer-portal cancellation),
 *   - the served artifact identity is missing, not the deployed release, or was
 *     published after the journey began (a late/mutable pointer),
 *   - the live browser run or the live Stripe integration suite was skipped,
 *   - real charging is possible (non-test mode or a different Stripe account),
 *   - a cited screenshot no longer matches its recorded sha256.
 *
 * Falsifiability: the deliberately-wrong evidence variants below are permanent
 * controls; each must produce its own problem code, and the committed evidence
 * must produce none (the calibration case).
 *
 * `CLOUD_DASHBOARD_EVIDENCE_FILE` overrides the evidence path so a mutation probe
 * can point this suite at a copy outside the shared tree.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const EVIDENCE_FILE =
  process.env.CLOUD_DASHBOARD_EVIDENCE_FILE ??
  resolve(REPO_ROOT, 'docs/evidence/cloud-dashboard-stripe-test-rollout-2026-10-03.json');

/** Plan D-002: both offers must belong to the Papercusp LLC Stripe account, TEST mode only. */
const EXPECTED_ACCOUNT_ID = 'acct_1UChLcF3Zj0ZNLH5';
/** The two cloud offers the plan ships (Papercusp cloud and BYOC). */
const EXPECTED_OFFERS = ['papercusp-cloud', 'byoc-cloud'] as const;
/** Executed-test floor of the opted-in live Stripe suite (rubric r-3 method). */
const LIVE_STRIPE_SUITE_EXECUTED = 7;

interface ServedArtifact {
  release?: string;
  buildId?: string;
  publishedAt?: string;
}

interface Receipt {
  planKey?: string;
  accountId?: string;
  mode?: string;
  checkoutOpened?: boolean;
  checkoutResponseStatus?: number;
  checkoutReturned?: string;
  webhookActive?: boolean;
  customerPortalOpened?: boolean;
  webhookCanceled?: boolean;
  servedArtifact?: ServedArtifact;
}

interface ShipmentEvidence {
  kind?: string;
  framework?: string;
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
  sourceCommit?: string;
  portalCommit?: string;
  rawReport?: { sha256?: string; stats?: { expected?: number; skipped?: number; unexpected?: number; flaky?: number } };
  deployedArtifacts?: ServedArtifact[];
  receipts?: Receipt[];
  assertions?: Array<{ id?: string; passed?: boolean }>;
  testLedgerRefs?: {
    liveStripeIntegrationPass?: number;
    liveStripeIntegrationCounts?: { executed?: number; skipped?: number };
  };
  screenshots?: Array<{ path?: string; sha256?: string }>;
}

export interface EvidenceProblem {
  code: string;
  detail: string;
}

function timeOf(value: string | undefined): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Every R-3 drift marker this evidence can expose, as stable problem codes.
 * An empty list means the evidence supports the R-3 bar.
 */
export function shipmentEvidenceProblems(
  evidence: ShipmentEvidence,
  readFile: (repoRelativePath: string) => Buffer | null = (p) => {
    const abs = resolve(REPO_ROOT, p);
    return existsSync(abs) ? readFileSync(abs) : null;
  },
): EvidenceProblem[] {
  const problems: EvidenceProblem[] = [];
  const add = (code: string, detail: string) => problems.push({ code, detail });

  if (evidence.kind !== 'operational-test-evidence') add('evidence-kind', `kind=${String(evidence.kind)}`);
  if (evidence.framework !== 'playwright') add('evidence-framework', `framework=${String(evidence.framework)}`);
  if (evidence.exitCode !== 0) add('live-run-exit', `exitCode=${String(evidence.exitCode)}`);
  if (!SHA40.test(evidence.sourceCommit ?? '')) add('source-commit', 'sourceCommit is not a full commit sha');
  if (!SHA40.test(evidence.portalCommit ?? '')) add('portal-commit', 'portalCommit is not a full commit sha');
  if (!SHA256.test(evidence.rawReport?.sha256 ?? '')) add('raw-report-sha', 'rawReport.sha256 missing');

  const startedAt = timeOf(evidence.startedAt);
  const finishedAt = timeOf(evidence.finishedAt);
  if (startedAt === null || finishedAt === null || finishedAt <= startedAt) {
    add('run-window', `startedAt=${String(evidence.startedAt)} finishedAt=${String(evidence.finishedAt)}`);
  }

  // A skipped or partially-failed live browser run is not proof.
  const stats = evidence.rawReport?.stats;
  const receipts = evidence.receipts ?? [];
  if (!stats) {
    add('live-run-stats', 'rawReport.stats missing');
  } else {
    if (stats.skipped !== 0) add('live-run-skipped', `skipped=${String(stats.skipped)}`);
    if (stats.unexpected !== 0) add('live-run-failed', `unexpected=${String(stats.unexpected)}`);
    if (stats.flaky !== 0) add('live-run-flaky', `flaky=${String(stats.flaky)}`);
    if (typeof stats.expected !== 'number' || stats.expected < EXPECTED_OFFERS.length) {
      add('live-run-count', `expected=${String(stats.expected)} < ${EXPECTED_OFFERS.length} offers`);
    }
  }

  // Both offers, each with its complete journey, on the TEST account only.
  const byOffer = new Map<string, Receipt[]>();
  for (const receipt of receipts) {
    const key = receipt.planKey ?? '';
    byOffer.set(key, [...(byOffer.get(key) ?? []), receipt]);
  }
  for (const offer of EXPECTED_OFFERS) {
    const found = byOffer.get(offer) ?? [];
    if (found.length === 0) add('offer-missing', offer);
    if (found.length > 1) add('offer-duplicated', offer);
  }
  for (const key of byOffer.keys()) {
    if (!(EXPECTED_OFFERS as readonly string[]).includes(key)) add('offer-unexpected', key || '(no planKey)');
  }

  const deployed = evidence.deployedArtifacts ?? [];
  if (deployed.length === 0) add('deployed-artifact-missing', 'deployedArtifacts is empty');
  for (const artifact of deployed) {
    const published = timeOf(artifact.publishedAt);
    if (published === null || startedAt === null || published >= startedAt) {
      add('deployed-artifact-late', `${String(artifact.release)} publishedAt=${String(artifact.publishedAt)}`);
    }
  }

  for (const receipt of receipts) {
    const who = receipt.planKey ?? '(no planKey)';
    if (receipt.accountId !== EXPECTED_ACCOUNT_ID) add('wrong-stripe-account', `${who}: ${String(receipt.accountId)}`);
    if (receipt.mode !== 'test') add('not-test-mode', `${who}: mode=${String(receipt.mode)}`);
    if (receipt.checkoutOpened !== true || receipt.checkoutResponseStatus !== 200) {
      add('checkout-not-opened', `${who}: status=${String(receipt.checkoutResponseStatus)}`);
    }
    if (receipt.checkoutReturned !== 'success') add('checkout-not-completed', `${who}: ${String(receipt.checkoutReturned)}`);
    if (receipt.webhookActive !== true) add('webhook-active-missing', who);
    if (receipt.customerPortalOpened !== true) add('portal-not-opened', who);
    if (receipt.webhookCanceled !== true) add('webhook-canceled-missing', who);

    // Serving identity: captured in-journey, immutable, deployed, published before the journey.
    const sa = receipt.servedArtifact;
    if (!sa?.release || !sa.buildId || !sa.publishedAt) {
      add('served-identity-missing', who);
      continue;
    }
    if (!sa.release.startsWith(`${sa.buildId}-`)) add('served-identity-mismatch', `${who}: ${sa.release} vs build ${sa.buildId}`);
    const published = timeOf(sa.publishedAt);
    if (published === null || startedAt === null || published >= startedAt) {
      add('served-identity-late', `${who}: published ${sa.publishedAt} not before run start ${String(evidence.startedAt)}`);
    }
    const match = deployed.find((d) => d.release === sa.release);
    if (!match) add('served-identity-not-deployed', `${who}: ${sa.release}`);
    else if (match.publishedAt !== sa.publishedAt || match.buildId !== sa.buildId) {
      add('served-identity-mismatch', `${who}: receipt disagrees with deployedArtifacts for ${sa.release}`);
    }
  }

  // The live journey's own named assertions must all have passed.
  const assertions = evidence.assertions ?? [];
  for (const a of assertions) if (a.passed !== true) add('assertion-failed', String(a.id));
  const ids = new Set(assertions.map((a) => a.id));
  const required = [
    'in-journey-immutable-serving-identity',
    ...EXPECTED_OFFERS.flatMap((o) => [`${o}-checkout-webhook-active`, `${o}-portal-webhook-cancellation`]),
  ];
  for (const id of required) if (!ids.has(id)) add('assertion-missing', id);

  // The opted-in live Stripe integration suite must have EXECUTED, not skipped.
  const ledger = evidence.testLedgerRefs;
  if (!Number.isInteger(ledger?.liveStripeIntegrationPass) || (ledger?.liveStripeIntegrationPass ?? 0) <= 0) {
    add('live-suite-ledger-missing', 'testLedgerRefs.liveStripeIntegrationPass');
  }
  const counts = ledger?.liveStripeIntegrationCounts;
  if (counts?.executed !== LIVE_STRIPE_SUITE_EXECUTED || counts?.skipped !== 0) {
    add('live-suite-skipped', `executed=${String(counts?.executed)} skipped=${String(counts?.skipped)}`);
  }

  // Cited screenshots: one checkout/active/cancellation per offer, bytes unchanged.
  const shots = evidence.screenshots ?? [];
  for (const offer of EXPECTED_OFFERS) {
    for (const stage of ['checkout', 'active', 'cancellation']) {
      if (!shots.some((s) => (s.path ?? '').endsWith(`/${offer}-${stage}.png`))) add('screenshot-missing', `${offer}-${stage}`);
    }
  }
  for (const shot of shots) {
    const bytes = shot.path ? readFile(shot.path) : null;
    if (!bytes) {
      add('screenshot-unreadable', String(shot.path));
      continue;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== shot.sha256) add('screenshot-hash', String(shot.path));
  }

  return problems;
}

function loadEvidence(): ShipmentEvidence {
  return JSON.parse(readFileSync(EVIDENCE_FILE, 'utf8')) as ShipmentEvidence;
}

function codes(problems: EvidenceProblem[]): string[] {
  return problems.map((p) => p.code);
}

function variant(mutate: (e: ShipmentEvidence) => void): ShipmentEvidence {
  const copy = structuredClone(loadEvidence());
  mutate(copy);
  return copy;
}

describe('cloud-dashboard shipment evidence (R-3 detector)', () => {
  it('calibration: the committed evidence supports the R-3 bar with no problems', () => {
    expect(shipmentEvidenceProblems(loadEvidence())).toEqual([]);
  });

  it('records a live journey for BOTH offers on the same deployed, pre-published release', () => {
    const evidence = loadEvidence();
    expect(new Set(evidence.receipts?.map((r) => r.planKey))).toEqual(new Set(EXPECTED_OFFERS));
    const releases = new Set(evidence.receipts?.map((r) => r.servedArtifact?.release));
    expect(releases.size).toBe(1);
    expect(evidence.deployedArtifacts?.map((d) => d.release)).toEqual([...releases]);
  });
});

describe('cloud-dashboard shipment evidence — permanent controls (each must be detected)', () => {
  const cases: Array<[string, string, (e: ShipmentEvidence) => void]> = [
    ['one offer journey missing', 'offer-missing', (e) => { e.receipts = e.receipts?.filter((r) => r.planKey !== 'byoc-cloud'); }],
    ['live browser run skipped', 'live-run-skipped', (e) => { e.rawReport!.stats!.skipped = 1; }],
    ['live Stripe suite skipped (gate-closed)', 'live-suite-skipped', (e) => { e.testLedgerRefs!.liveStripeIntegrationCounts = { executed: 0, skipped: 7 }; }],
    ['served identity missing', 'served-identity-missing', (e) => { delete e.receipts![0].servedArtifact; }],
    ['served artifact published after the journey began', 'served-identity-late', (e) => {
      e.receipts![1].servedArtifact!.publishedAt = new Date(Date.parse(e.finishedAt!) + 1_000).toISOString();
    }],
    ['served artifact is not the deployed release', 'served-identity-not-deployed', (e) => {
      e.receipts![0].servedArtifact!.release = `${e.receipts![0].servedArtifact!.buildId}-99999999999999999-0-deadbeef`;
    }],
    ['real charging possible (live mode)', 'not-test-mode', (e) => { e.receipts![0].mode = 'live'; }],
    ['wrong Stripe account', 'wrong-stripe-account', (e) => { e.receipts![1].accountId = 'acct_0000000000000000'; }],
    ['cancellation never persisted', 'webhook-canceled-missing', (e) => { e.receipts![1].webhookCanceled = false; }],
    ['subscription never became active', 'webhook-active-missing', (e) => { e.receipts![0].webhookActive = false; }],
    ['cited screenshot bytes changed', 'screenshot-hash', (e) => { e.screenshots![0].sha256 = '0'.repeat(64); }],
  ];

  it.each(cases)('%s', (_label, code, mutate) => {
    expect(codes(shipmentEvidenceProblems(variant(mutate)))).toContain(code);
  });

  it('an unreadable screenshot is a problem, not a silent pass', () => {
    expect(codes(shipmentEvidenceProblems(loadEvidence(), () => null))).toContain('screenshot-unreadable');
  });
});
