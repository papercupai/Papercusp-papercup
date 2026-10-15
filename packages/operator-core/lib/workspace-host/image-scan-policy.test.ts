import { describe, expect, it } from 'vitest';

import { SEVERITY_RANK } from './artifact-trust';
import {
  AWS_IMAGE_SCAN_POLICY,
  AZURE_IMAGE_SCAN_POLICY,
  GCP_IMAGE_SCAN_POLICY,
  WORKSPACE_HOST_IMAGE_SCAN_POLICY,
  evaluateImageScanPolicy,
  type ImageScanPolicy,
  type ImageScanPolicyInput,
} from './image-scan-policy';

/**
 * A breakdown whose counts always reconcile against the total, so a test that means
 * to exercise ONE rule cannot accidentally trip `severity-breakdown-mismatch` and
 * pass for the wrong reason.
 */
function scan(bySeverity: Record<string, unknown>, secretFindings = 0): ImageScanPolicyInput {
  const total = Object.values(bySeverity).reduce<number>(
    (sum, value) => sum + (typeof value === 'number' ? value : 0),
    0,
  );
  return { vulnerabilityFindings: total, vulnerabilityBySeverity: bySeverity, secretFindings };
}

const codes = (input: ImageScanPolicyInput, policy?: ImageScanPolicy): string[] =>
  evaluateImageScanPolicy(input, policy).failures.map((failure) => failure.code);

describe('workspace-host image scan policy', () => {
  it('ratifies deny-at-or-above-high with zero tolerated secrets', () => {
    expect(WORKSPACE_HOST_IMAGE_SCAN_POLICY).toEqual({
      denyVulnerabilitiesAtOrAbove: 'high',
      maxSecretFindings: 0,
      // FALSE on the SHARED compatibility baseline. This is an exact-equality
      // assertion on purpose: provider release paths use their own scoped policies,
      // while generic callers may not have coverage evidence available.
      requireCoverageProof: false,
      // 'all' for the same reason: a caller with no attributing scanner must not
      // inherit a narrower SUBJECT by silence.
      evaluatedScope: 'all',
    });
  });

  it('scopes the coverage requirement to every provider release policy', () => {
    for (const policy of [GCP_IMAGE_SCAN_POLICY, AWS_IMAGE_SCAN_POLICY, AZURE_IMAGE_SCAN_POLICY]) {
      expect(policy.requireCoverageProof).toBe(true);
      // The thresholds must not drift apart: each provider is held to the SAME bar
      // plus a proof obligation, not to a different bar. This is the assertion that
      // stops "scoping" from ever becoming a threshold relaxation in disguise
      // (D-172/174/175): a provider may narrow WHICH findings it judges, never HOW
      // HARSHLY it judges them.
      expect(policy.denyVulnerabilitiesAtOrAbove).toBe(
        WORKSPACE_HOST_IMAGE_SCAN_POLICY.denyVulnerabilitiesAtOrAbove,
      );
      expect(policy.maxSecretFindings).toBe(WORKSPACE_HOST_IMAGE_SCAN_POLICY.maxSecretFindings);
    }
  });

  it('scopes ONLY the providers whose scanners attribute findings', () => {
    // GCP's guest scanner (D-204) and the AWS offline AMI scanner (WI-10006421) emit the
    // attribution maps; Azure's does not. A scoped policy against a non-attributing scanner
    // denies, so these values are a statement of where each provider actually is — not a
    // concession, and not a default anyone inherits by accident.
    expect(GCP_IMAGE_SCAN_POLICY.evaluatedScope).toBe('papercusp-bundled');
    expect(AWS_IMAGE_SCAN_POLICY.evaluatedScope).toBe('papercusp-bundled');
    expect(AZURE_IMAGE_SCAN_POLICY.evaluatedScope).toBe('all');
  });

  it('ranks severities from artifact-trust, so the two gates cannot disagree', () => {
    // Calibration: if artifact-trust ever re-ranks a severity, this fails here rather
    // than silently changing what the image gate admits.
    expect(SEVERITY_RANK).toMatchObject({ unknown: -1, low: 0, medium: 1, high: 2, critical: 3 });
  });

  describe('the defect this module exists to fix', () => {
    it('admits a real distribution image whose findings are all below the threshold', () => {
      // The measured shape from EI-21770579023793724: thousands of matches across a
      // stock Ubuntu userland, none of them at or above HIGH. The old gate demanded
      // zero at ANY severity and so could never pass this.
      const verdict = evaluateImageScanPolicy(
        scan({ Negligible: 1804, Low: 1500, Medium: 618 }),
      );
      expect(verdict.accepted).toBe(true);
      expect(verdict.totalVulnerabilities).toBe(3922);
      expect(verdict.policyViolatingVulnerabilities).toBe(0);
      expect(verdict.toleratedVulnerabilities).toBe(3922);
    });

    it('still denies a single finding at the threshold', () => {
      // Positive control for the test above: the policy is not vacuous — the SAME
      // image shape plus one High is rejected.
      const verdict = evaluateImageScanPolicy(
        scan({ Negligible: 1804, Low: 1500, Medium: 618, High: 1 }),
      );
      expect(verdict.accepted).toBe(false);
      expect(verdict.policyViolatingVulnerabilities).toBe(1);
      expect(verdict.failures.map((f) => f.code)).toContain('vulnerability-threshold');
    });

    it('denies critical, which outranks the threshold', () => {
      expect(codes(scan({ Critical: 1 }))).toContain('vulnerability-threshold');
    });

    it('reads grype’s capitalised labels', () => {
      // grype emits 'Critical'/'High'/...; the ratified rank table is lower-case.
      // A case-sensitive lookup would treat every real label as unrecognised.
      expect(evaluateImageScanPolicy(scan({ MEDIUM: 5, ' low ': 2 })).accepted).toBe(true);
      expect(codes(scan({ CRITICAL: 1 }))).toEqual(['vulnerability-threshold']);
    });
  });

  describe('fails closed — a measurement it cannot account for is never a pass', () => {
    it('rejects an empty breakdown that claims findings exist', () => {
      // THE control that matters most. This is the exact shape of the original
      // defect: a counter that reads as clean because the instrument produced
      // nothing. Zero violations must never be inferred from an absent measurement.
      const verdict = evaluateImageScanPolicy({
        vulnerabilityFindings: 3922,
        vulnerabilityBySeverity: {},
        secretFindings: 0,
      });
      expect(verdict.accepted).toBe(false);
      expect(verdict.failures.map((f) => f.code)).toContain('severity-breakdown-mismatch');
    });

    it('rejects a breakdown that accounts for only some findings', () => {
      expect(
        codes({ vulnerabilityFindings: 100, vulnerabilityBySeverity: { Low: 40 }, secretFindings: 0 }),
      ).toContain('severity-breakdown-mismatch');
    });

    it('counts an unrecognised severity as violating rather than safe', () => {
      // A label this build has never seen is not evidence of safety. It turns the
      // gate red and gets a human's attention instead of quietly widening what passes.
      const verdict = evaluateImageScanPolicy(scan({ Moderate: 3 }));
      expect(verdict.accepted).toBe(false);
      expect(verdict.policyViolatingVulnerabilities).toBe(3);
      expect(verdict.failures.map((f) => f.code)).toContain('unrecognized-severity');
    });

    it.each([
      ['a non-integer count', { vulnerabilityFindings: 1, vulnerabilityBySeverity: { Low: 1.5 }, secretFindings: 0 }],
      ['a negative count', { vulnerabilityFindings: 1, vulnerabilityBySeverity: { Low: -1 }, secretFindings: 0 }],
      ['a string count', { vulnerabilityFindings: 1, vulnerabilityBySeverity: { Low: '1' }, secretFindings: 0 }],
      ['a null breakdown', { vulnerabilityFindings: 0, vulnerabilityBySeverity: null, secretFindings: 0 }],
      ['an array breakdown', { vulnerabilityFindings: 0, vulnerabilityBySeverity: [], secretFindings: 0 }],
      ['a negative total', { vulnerabilityFindings: -1, vulnerabilityBySeverity: {}, secretFindings: 0 }],
      ['a non-integer secret count', { vulnerabilityFindings: 0, vulnerabilityBySeverity: {}, secretFindings: 0.5 }],
    ])('rejects %s', (_label, input) => {
      const verdict = evaluateImageScanPolicy(input as unknown as ImageScanPolicyInput);
      expect(verdict.accepted).toBe(false);
      expect(verdict.failures.length).toBeGreaterThan(0);
    });

    it('rejects an unusable policy instead of admitting on it', () => {
      expect(
        codes(scan({}), {
          denyVulnerabilitiesAtOrAbove: 'nonsense',
          maxSecretFindings: 0,
          requireCoverageProof: false,
        } as unknown as ImageScanPolicy),
      ).toEqual(['invalid-policy']);
      expect(
        codes(scan({}), {
          denyVulnerabilitiesAtOrAbove: 'high',
          maxSecretFindings: -1,
          requireCoverageProof: false,
          evaluatedScope: 'all',
        }),
      ).toEqual(['invalid-policy']);
      // A non-boolean requireCoverageProof is itself an unusable policy: a truthy
      // string would otherwise silently arm the requirement, and a nullish one
      // silently disarm it. Neither may be guessed at.
      expect(
        codes(scan({}), {
          denyVulnerabilitiesAtOrAbove: 'high',
          maxSecretFindings: 0,
          requireCoverageProof: 'yes',
        } as unknown as ImageScanPolicy),
      ).toEqual(['invalid-policy']);
    });
  });

  describe('scan coverage must be PROVEN, not assumed (WI-1092039 / D-196)', () => {
    const covered = { mountedFilesystems: 3, candidateRootProof: '/mnt/candidate/sda1/etc/os-release' };

    /**
     * GCP is a SCOPED policy, so its scan must now prove two separate things: that it
     * covered the image (this block) and that it attributed what it found (the scoped
     * block below). Attribution is supplied here so these tests keep exercising the
     * coverage rule alone rather than tripping the newer one.
     */
    const attributed = (findings: number, atOrAboveHigh: number, secrets = 0) => ({
      vulnerabilityByScope: { 'inherited-base-image': findings },
      vulnerabilityCriticalHighByScope: { 'inherited-base-image': atOrAboveHigh },
      secretsByScope: { 'inherited-base-image': secrets },
      bundleCatalogedArtifacts: 3711,
    });

    it('accepts a GCP scan that proves it mounted an OS root', () => {
      const verdict = evaluateImageScanPolicy(
        { ...scan({ low: 4 }), ...covered, ...attributed(4, 0) },
        GCP_IMAGE_SCAN_POLICY,
      );
      expect(verdict.accepted).toBe(true);
      expect(verdict.failures).toEqual([]);
    });

    it('DENIES a covered GCP scan that never says WHERE its findings came from', () => {
      // Coverage and attribution are independent obligations: proving you scanned the
      // whole image says nothing about which half a finding belongs to, and a scoped
      // verdict is meaningless without that. Absence denies rather than falling back
      // to the totals.
      const verdict = evaluateImageScanPolicy({ ...scan({ low: 4 }), ...covered }, GCP_IMAGE_SCAN_POLICY);
      expect(verdict.accepted).toBe(false);
      expect(verdict.failures.map((failure) => failure.code)).toEqual(['scope-attribution-missing']);
    });

    it('DENIES a GCP scan that reports zero findings but never proves it scanned anything', () => {
      // The defect in one assertion. An empty scan and a clean scan are the same
      // bytes; without the proof this verdict was `accepted: true`.
      expect(codes(scan({}), GCP_IMAGE_SCAN_POLICY)).toEqual(['coverage-proof-missing']);
    });

    it('names WHICH half of the proof is absent, so the failure is actionable', () => {
      const onlyMounts = evaluateImageScanPolicy(
        { ...scan({}), mountedFilesystems: 3 },
        GCP_IMAGE_SCAN_POLICY,
      );
      expect(onlyMounts.accepted).toBe(false);
      expect(onlyMounts.failures[0]?.message).toContain('candidateRootProof');
      expect(onlyMounts.failures[0]?.message).not.toContain('mountedFilesystems and');

      const onlyProof = evaluateImageScanPolicy(
        { ...scan({}), candidateRootProof: '/mnt/candidate/sda1/etc/os-release' },
        GCP_IMAGE_SCAN_POLICY,
      );
      expect(onlyProof.failures[0]?.message).toContain('mountedFilesystems');
    });

    it('treats a zero-mount scan as unmeasured, not as an empty image', () => {
      expect(codes({ ...scan({}), ...covered, mountedFilesystems: 0 }, GCP_IMAGE_SCAN_POLICY)).toEqual([
        'coverage-proof-invalid',
      ]);
    });

    it('rejects a malformed proof rather than coercing it', () => {
      for (const bad of [3.5, -1, '3', true, {}, []]) {
        expect(
          codes({ ...scan({}), ...covered, mountedFilesystems: bad }, GCP_IMAGE_SCAN_POLICY),
        ).toEqual(['coverage-proof-invalid']);
      }
      for (const bad of ['', '   ', 7, false, {}]) {
        expect(
          codes({ ...scan({}), ...covered, candidateRootProof: bad }, GCP_IMAGE_SCAN_POLICY),
        ).toEqual(['coverage-proof-invalid']);
      }
    });

    it('keeps the shared baseline generic while every provider policy denies absent coverage', () => {
      // The shared policy remains a compatibility baseline for callers without
      // provider-specific evidence. Concrete release paths must not use it: all three
      // provider-scoped policies require the scanner to prove its coverage.
      const uncovered = scan({ low: 4 });
      const verdict = evaluateImageScanPolicy(uncovered, WORKSPACE_HOST_IMAGE_SCAN_POLICY);
      expect(verdict.accepted).toBe(true);
      for (const policy of [GCP_IMAGE_SCAN_POLICY, AWS_IMAGE_SCAN_POLICY, AZURE_IMAGE_SCAN_POLICY]) {
        expect(codes(uncovered, policy)).toEqual(['coverage-proof-missing']);
      }
    });

    it('still validates a proof that IS present, even when the policy does not require it', () => {
      // Defence in depth for provider scanners: a malformed coverage value is caught
      // immediately even if a caller accidentally uses the generic baseline policy.
      expect(codes({ ...scan({}), mountedFilesystems: 0 }, WORKSPACE_HOST_IMAGE_SCAN_POLICY)).toEqual([
        'coverage-proof-invalid',
      ]);
      expect(codes({ ...scan({}), candidateRootProof: '' }, WORKSPACE_HOST_IMAGE_SCAN_POLICY)).toEqual([
        'coverage-proof-invalid',
      ]);
    });

    it('checks coverage BEFORE findings, so an unproven scan cannot be argued about on its counts', () => {
      // An unproven scan carrying a policy-violating count must fail on the COVERAGE
      // question. Reporting the threshold breach first would invite the reading that
      // fixing the vulnerabilities makes this image releasable — it does not, because
      // nothing here establishes the scan looked at the right disk.
      expect(codes(scan({ critical: 9 }, 4), GCP_IMAGE_SCAN_POLICY)).toEqual(['coverage-proof-missing']);
    });
  });

  describe('the secret bar is NOT loosened', () => {
    it('denies any secret finding under the ratified policy', () => {
      const verdict = evaluateImageScanPolicy(scan({ Low: 1 }, 280));
      expect(verdict.accepted).toBe(false);
      expect(verdict.failures.map((f) => f.code)).toContain('secret-threshold');
      expect(verdict.secretFindings).toBe(280);
    });

    it('denies even a single secret finding', () => {
      expect(codes(scan({}, 1))).toContain('secret-threshold');
    });

    it('reports vulnerability and secret failures independently', () => {
      // A red must name every reason it is red; triaging one should not hide another.
      expect(codes(scan({ Critical: 2 }, 5)).sort()).toEqual(['secret-threshold', 'vulnerability-threshold']);
    });
  });

  it('treats unknown severity as below the threshold, matching the ratified ordering', () => {
    // Deliberate: artifact-trust ranks `unknown` at -1, below `low`. This module
    // reuses that rather than inventing a stricter reading — but the count is still
    // reported so a reviewer can see it.
    const verdict = evaluateImageScanPolicy(scan({ Unknown: 7 }));
    expect(verdict.accepted).toBe(true);
    expect(verdict.toleratedVulnerabilities).toBe(7);
  });

  it('accepts a genuinely clean image', () => {
    const verdict = evaluateImageScanPolicy(scan({}, 0));
    expect(verdict.accepted).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  /**
   * Permanent falsifiability controls.
   *
   * A guard that has never failed is a guard nobody has tested. These run the two
   * load-bearing cases against deliberately-wrong implementations kept here for
   * exactly this purpose, and assert those implementations get the answer WRONG —
   * so if `evaluateImageScanPolicy` ever degenerates into either one, the suite
   * above stops being able to pass by accident.
   *
   * They live in the test file rather than being produced by mutating the source,
   * because this is a shared working tree: an in-tree mutation can be swept into a
   * commit by the background git-sync while the probe is still running.
   */
  describe('falsifiability controls', () => {
    const REAL_IMAGE = scan({ Negligible: 1804, Low: 1500, Medium: 618 });
    const DEAD_INSTRUMENT = {
      vulnerabilityFindings: 3922,
      vulnerabilityBySeverity: {},
      secretFindings: 0,
    } satisfies ImageScanPolicyInput;

    /** The gate as it was: zero grype matches at ANY severity. */
    const zeroToleranceGate = (input: ImageScanPolicyInput): boolean =>
      input.vulnerabilityFindings === 0 && input.secretFindings === 0;

    /** The tempting shortcut: trust the breakdown, never reconcile it. */
    const unreconciledGate = (input: ImageScanPolicyInput): boolean => {
      const bySeverity = (input.vulnerabilityBySeverity ?? {}) as Record<string, number>;
      const violating = ['high', 'critical'].reduce(
        (sum, key) =>
          sum +
          Object.entries(bySeverity)
            .filter(([label]) => label.toLowerCase() === key)
            .reduce((inner, [, count]) => inner + count, 0),
        0,
      );
      return violating === 0 && input.secretFindings === 0;
    };

    it('the old zero-tolerance gate rejects the image this policy admits', () => {
      expect(evaluateImageScanPolicy(REAL_IMAGE).accepted).toBe(true);
      expect(zeroToleranceGate(REAL_IMAGE)).toBe(false);
    });

    it('an unreconciled gate admits the dead instrument this policy rejects', () => {
      expect(unreconciledGate(DEAD_INSTRUMENT)).toBe(true);
      expect(evaluateImageScanPolicy(DEAD_INSTRUMENT).accepted).toBe(false);
    });
  });

  describe('scoped evaluation (D-204 attribution made operative)', () => {
    /**
     * The MEASURED 0.0.18 candidate, from D-201's cross-tab and D-202's split. Using
     * the real numbers rather than toy ones matters here: the whole question is
     * whether the arithmetic over this specific population behaves, and a fixture of
     * 1s and 2s can satisfy every reconciliation while hiding a sign error.
     *
     *   3982 findings total; 1839 at/above high (248 Critical + 1591 High)
     *   of those 1839: 26 papercusp-bundled (all npm), 1813 inherited
     *   275 secrets, every one of them inherited
     */
    const MEASURED_CANDIDATE: ImageScanPolicyInput = {
      vulnerabilityFindings: 3982,
      vulnerabilityBySeverity: { Critical: 248, High: 1591, Medium: 1000, Low: 1143 },
      secretFindings: 275,
      mountedFilesystems: 3,
      candidateRootProof: '/mnt/candidate/etc/os-release',
      vulnerabilityByScope: { 'papercusp-bundled': 44, 'inherited-base-image': 3938 },
      vulnerabilityCriticalHighByScope: { 'papercusp-bundled': 26, 'inherited-base-image': 1813 },
      secretsByScope: { 'papercusp-bundled': 0, 'inherited-base-image': 275 },
      bundleCatalogedArtifacts: 3711,
    };

    const scopedFrom = (patch: Partial<ImageScanPolicyInput>): ImageScanPolicyInput => ({
      ...MEASURED_CANDIDATE,
      ...patch,
    });

    it('judges the bundled population and STILL denies it — scoping is not a pass', () => {
      // D-202's central ruling, as an executable assertion. The reading D-201 alone
      // invites is "the gate is unreachable, so scope it and move on"; that is wrong,
      // and this test is what stops the code from drifting into it. A scoped verdict
      // on the measured candidate is RED, on exactly the 26 findings we own.
      const verdict = evaluateImageScanPolicy(MEASURED_CANDIDATE, GCP_IMAGE_SCAN_POLICY);
      expect(verdict.accepted).toBe(false);
      expect(verdict.policyViolatingVulnerabilities).toBe(26);
      expect(verdict.failures.map((failure) => failure.code)).toContain('vulnerability-threshold');
      // The inherited measurement is not discarded — it is still reported.
      expect(verdict.totalVulnerabilities).toBe(3982);
      expect(verdict.evaluatedScope).toBe('papercusp-bundled');
    });

    it('accepts once the bundled findings are actually fixed, while the image is unchanged', () => {
      // The same image, the same 1813 inherited findings, the same unchanged bar —
      // only the 44 npm findings (26 of them at/above high) resolved. This is the
      // state WI-1203796 delivers.
      //
      // Note every number below moves together: remediating the bundle removes those
      // findings from the SEVERITY breakdown too, not just from the scope map. An
      // earlier draft of this fixture zeroed only the bundled bucket and was rejected
      // by the cross-instrument reconciliation — which is the check earning its place,
      // so the corrected fixture is written out in full rather than patched.
      const verdict = evaluateImageScanPolicy(
        scopedFrom({
          vulnerabilityFindings: 3938,
          vulnerabilityBySeverity: { Critical: 247, High: 1566, Medium: 1000, Low: 1125 },
          vulnerabilityByScope: { 'papercusp-bundled': 0, 'inherited-base-image': 3938 },
          vulnerabilityCriticalHighByScope: { 'papercusp-bundled': 0, 'inherited-base-image': 1813 },
          // Still cataloged: a remediated bundle has zero FINDINGS but never zero
          // PACKAGES. That is exactly why the proof counts artifacts, not findings.
          bundleCatalogedArtifacts: 3711,
        }),
        GCP_IMAGE_SCAN_POLICY,
      );
      expect(verdict.accepted).toBe(true);
      expect(verdict.policyViolatingVulnerabilities).toBe(0);
      // Unscoped, that very same measurement is still denied — which is the proof
      // that the accept above came from remediation and not from a lowered bar.
      expect(
        evaluateImageScanPolicy(MEASURED_CANDIDATE, WORKSPACE_HOST_IMAGE_SCAN_POLICY).accepted,
      ).toBe(false);
    });

    it('DENIES when the bundle was never cataloged, even though every bundled bucket reads zero', () => {
      // THE test. This is the false-GREEN that scoping introduces and everything else
      // in the scoped path exists to prevent: get the bundle path wrong and all
      // findings attribute to 'inherited-base-image', the bundled buckets read 0, and
      // an unsatisfiable gate becomes a vacuously satisfied one. Same shape as the
      // gitleaks installer that never installed. Note the input below would otherwise
      // PASS — every bundled count is 0 and every partition reconciles.
      const verdict = evaluateImageScanPolicy(
        scopedFrom({
          vulnerabilityByScope: { 'inherited-base-image': 3982 },
          vulnerabilityCriticalHighByScope: { 'inherited-base-image': 1839 },
          secretsByScope: { 'inherited-base-image': 275 },
          bundleCatalogedArtifacts: 0,
        }),
        GCP_IMAGE_SCAN_POLICY,
      );
      expect(verdict.accepted).toBe(false);
      expect(verdict.failures.map((failure) => failure.code)).toContain('scope-attribution-invalid');
    });

    it('denies when the scanner did not attribute at all', () => {
      // A non-attributing scanner (AWS/Azure today) handed to a scoped policy must
      // deny, never fall back to judging the totals and never pass on absent buckets.
      for (const field of [
        'vulnerabilityByScope',
        'vulnerabilityCriticalHighByScope',
        'secretsByScope',
        'bundleCatalogedArtifacts',
      ] as const) {
        const verdict = evaluateImageScanPolicy(
          scopedFrom({ [field]: undefined }),
          GCP_IMAGE_SCAN_POLICY,
        );
        expect(verdict.accepted, `${field} absent must deny`).toBe(false);
        expect(verdict.failures.map((failure) => failure.code)).toContain('scope-attribution-missing');
      }
    });

    it('denies an attribution that does not account for every finding', () => {
      // A partition that loses findings loses precisely the ones nobody then judges.
      const cases: readonly Partial<ImageScanPolicyInput>[] = [
        { vulnerabilityByScope: { 'papercusp-bundled': 44, 'inherited-base-image': 1 } },
        { vulnerabilityCriticalHighByScope: { 'papercusp-bundled': 26, 'inherited-base-image': 1 } },
        { secretsByScope: { 'papercusp-bundled': 0, 'inherited-base-image': 1 } },
      ];
      for (const patch of cases) {
        const verdict = evaluateImageScanPolicy(scopedFrom(patch), GCP_IMAGE_SCAN_POLICY);
        expect(verdict.accepted).toBe(false);
        expect(verdict.failures.map((failure) => failure.code)).toContain('scope-attribution-mismatch');
      }
    });

    it('denies a scope label this build does not know', () => {
      // Unlike an unknown SEVERITY (over-approximated as violating), an unknown SCOPE
      // has no safe side to fall on: it means the scanner re-partitioned the image, so
      // the arithmetic the verdict rests on no longer describes anything.
      const verdict = evaluateImageScanPolicy(
        scopedFrom({
          vulnerabilityByScope: { 'papercusp-bundled': 44, 'vendor-layer': 3938 },
        }),
        GCP_IMAGE_SCAN_POLICY,
      );
      expect(verdict.accepted).toBe(false);
      expect(verdict.failures.map((failure) => failure.code)).toContain('scope-attribution-invalid');
    });

    it('refuses to read the critical/high bucket for a policy that denies at another threshold', () => {
      // The attributed bucket is computed guest-side over 'critical' or 'high' only.
      // At any other threshold it does not measure what is being denied, so the honest
      // answer is to refuse rather than approximate.
      const mediumScoped: ImageScanPolicy = {
        ...GCP_IMAGE_SCAN_POLICY,
        denyVulnerabilitiesAtOrAbove: 'medium',
      };
      const verdict = evaluateImageScanPolicy(MEASURED_CANDIDATE, mediumScoped);
      expect(verdict.accepted).toBe(false);
      expect(verdict.failures.map((failure) => failure.code)).toContain('scope-attribution-mismatch');
    });

    it('holds the secret bar at zero inside the scope', () => {
      // The 275 inherited secrets (libmagic magic.mgc, botocore service JSON, rsync-ssl)
      // no longer deny — but one secret in content we ship still does. maxSecretFindings
      // never moved; only the population it judges did.
      expect(evaluateImageScanPolicy(MEASURED_CANDIDATE, GCP_IMAGE_SCAN_POLICY).policyViolatingSecrets).toBe(0);
      const withOurs = evaluateImageScanPolicy(
        scopedFrom({
          secretsByScope: { 'papercusp-bundled': 1, 'inherited-base-image': 274 },
        }),
        GCP_IMAGE_SCAN_POLICY,
      );
      expect(withOurs.accepted).toBe(false);
      expect(withOurs.policyViolatingSecrets).toBe(1);
      expect(withOurs.failures.map((failure) => failure.code)).toContain('secret-threshold');
      // The whole-image count stays reported either way; only the judged count moves.
      expect(withOurs.secretFindings).toBe(275);
    });

    it('denies a bucket holding more at/above-high findings than findings', () => {
      const verdict = evaluateImageScanPolicy(
        scopedFrom({
          vulnerabilityByScope: { 'papercusp-bundled': 10, 'inherited-base-image': 3972 },
        }),
        GCP_IMAGE_SCAN_POLICY,
      );
      expect(verdict.accepted).toBe(false);
      expect(verdict.failures.map((failure) => failure.code)).toContain('scope-attribution-mismatch');
    });

    it('leaves the unscoped path exactly as it was', () => {
      // Attribution present but the policy judges 'all': the totals still decide, so
      // an existing caller cannot silently acquire a narrower verdict.
      const verdict = evaluateImageScanPolicy(MEASURED_CANDIDATE, WORKSPACE_HOST_IMAGE_SCAN_POLICY);
      expect(verdict.evaluatedScope).toBe('all');
      expect(verdict.policyViolatingVulnerabilities).toBe(1839);
      expect(verdict.policyViolatingSecrets).toBe(275);
      expect(verdict.accepted).toBe(false);
    });

    it('denies a policy naming a scope this build cannot evaluate', () => {
      const verdict = evaluateImageScanPolicy(MEASURED_CANDIDATE, {
        ...GCP_IMAGE_SCAN_POLICY,
        evaluatedScope: 'inherited-base-image' as unknown as ImageScanPolicy['evaluatedScope'],
      });
      expect(verdict.accepted).toBe(false);
      expect(verdict.failures.map((failure) => failure.code)).toContain('invalid-policy');
      // An uninterpretable label never reaches a stored verdict.
      expect(verdict.evaluatedScope).toBe('all');
    });
  });
});
