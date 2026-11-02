/**
 * hive-policy-schema — pure unit tests (shared-hive-owner-enforcement EN-1).
 *
 * Covers the SIGNING CONTRACT the whole layer rests on: a canonical form that is
 * order-independent + stable, signed bytes that bind workspace/slug/version, the
 * sign→verify Ed25519 roundtrip (the S0 crypto core), forward-compat preservation of
 * unknown keys, and the input validator.
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalizeHivePolicy,
  hivePolicySignedBytes,
  parseHivePolicyJson,
  coerceHivePolicyInput,
  matchRefPattern,
  resolveCanonicalRule,
  HIVE_POLICY_SIG_DOMAIN,
  type HivePolicy,
} from './hive-policy-schema';
import { generateEd25519KeypairDer, signWithPrivateKeyDer, verifyEd25519 } from './identity/ed25519';

describe('owner-signed plugin invocation approvals', () => {
  const approval = { pluginName: 'fixture', pluginVersion: '1.0.0', installationPath: '/installed/fixture',
    installationSource: 'global', principalSlug: 'caller', principalKind: 'system', authMethod: 'bearer-token',
    toolName: 'fixture:write', inputSha256: 'a'.repeat(64), capabilities: ['tasks:write'], expiresAt: 2_000_000_000_000 };
  it('preserves exact approvals in the signed policy and rejects broad or incomplete authoring', () => {
    const policy = { pluginInvocations: { approvals: [approval] }, future: { retained: true } };
    expect(coerceHivePolicyInput(policy)).toEqual({ ok: true, policy });
    expect(parseHivePolicyJson(canonicalizeHivePolicy(policy))).toEqual(policy);
    for (const change of [{ toolName: '*' }, { capabilities: ['tasks:*'] }, { principalSlug: '' },
      { inputSha256: 'bad' }, { expiresAt: Infinity }, { installationPath: '' }, { capabilities: [] }]) {
      expect(coerceHivePolicyInput({ pluginInvocations: { approvals: [{ ...approval, ...change }] } }).ok).toBe(false);
    }
    expect(coerceHivePolicyInput({ pluginInvocations: { approvals: 'anything' } }).ok).toBe(false);
  });
});

describe('owner-signed finance references', () => {
  it('rejects unsafe chains and zero addresses, preserving unknown owner policy fields', () => {
    const address = '0x' + '1'.repeat(40);
    const policy = { finance: { treasury: { chainId: 1, address }, commerce: { buyerOrgId: 'real-commerce-org' } }, future: { retained: true } };
    expect(coerceHivePolicyInput(policy)).toEqual({ ok: true, policy });
    expect(coerceHivePolicyInput({ finance: { treasury: { chainId: Number.MAX_SAFE_INTEGER + 1, address } } }).ok).toBe(false);
    expect(coerceHivePolicyInput({ finance: { treasury: { chainId: 1, address: '0x' + '0'.repeat(40) } } }).ok).toBe(false);
    expect(coerceHivePolicyInput({ finance: { equity: { chainId: 1, equity: address } } }).ok).toBe(false);
    expect(coerceHivePolicyInput({ finance: { commerce: { buyerOrgId: '' } } }).ok).toBe(false);
  });
});

describe('canonicalizeHivePolicy', () => {
  it('is INDEPENDENT of key insertion order (deterministic)', () => {
    const a: HivePolicy = { membership: 'approval', rate: { opsPerMin: 10, prsPerDay: 3 }, allowlist: ['b', 'a'] };
    const b: HivePolicy = { allowlist: ['b', 'a'], rate: { prsPerDay: 3, opsPerMin: 10 }, membership: 'approval' };
    expect(canonicalizeHivePolicy(a)).toBe(canonicalizeHivePolicy(b));
  });

  it('PRESERVES array order (it is signed content)', () => {
    expect(canonicalizeHivePolicy({ allowlist: ['a', 'b'] })).not.toBe(
      canonicalizeHivePolicy({ allowlist: ['b', 'a'] }),
    );
  });

  it('is single-line (no literal newline) so the signed envelope stays unambiguous', () => {
    const c = canonicalizeHivePolicy({ moderation: { takedownList: ['x\ny'] } });
    expect(c.includes('\n')).toBe(false); // the embedded newline is escaped as \n
  });

  it('forward-compat: PRESERVES unknown keys through a parse→canonicalize round trip', () => {
    const withUnknown = { membership: 'open', futureKnob: { deep: [1, 2] }, x: 'y' } as HivePolicy;
    const canon = canonicalizeHivePolicy(withUnknown);
    const round = canonicalizeHivePolicy(parseHivePolicyJson(canon));
    expect(round).toBe(canon);
    expect(canon).toContain('futureKnob');
  });

  it('empty / null policy canonicalizes to {}', () => {
    expect(canonicalizeHivePolicy({})).toBe('{}');
    expect(canonicalizeHivePolicy(null)).toBe('{}');
    expect(canonicalizeHivePolicy(undefined)).toBe('{}');
  });
});

describe('hivePolicySignedBytes', () => {
  const base = { workspaceId: 'ws', potHomeSlug: 'home', policyVersion: 1, canonicalPolicyJson: '{}' };

  it('carries the domain tag (anti-cross-protocol replay)', () => {
    expect(hivePolicySignedBytes(base).toString('utf8').startsWith(HIVE_POLICY_SIG_DOMAIN)).toBe(true);
  });

  it('changes when ANY binding field changes (anti cross-hive/version replay)', () => {
    const b0 = hivePolicySignedBytes(base).toString('hex');
    expect(hivePolicySignedBytes({ ...base, workspaceId: 'ws2' }).toString('hex')).not.toBe(b0);
    expect(hivePolicySignedBytes({ ...base, potHomeSlug: 'home2' }).toString('hex')).not.toBe(b0);
    expect(hivePolicySignedBytes({ ...base, policyVersion: 2 }).toString('hex')).not.toBe(b0);
    expect(hivePolicySignedBytes({ ...base, canonicalPolicyJson: '{"a":1}' }).toString('hex')).not.toBe(b0);
  });
});

describe('sign → verify roundtrip (the S0 crypto core)', () => {
  it('a signature over the canonical bytes verifies; a tampered policy / wrong key does NOT', () => {
    const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
    const policy: HivePolicy = { rate: { opsPerMin: 5 }, membership: 'allowlist', allowlist: ['octocat'] };
    const canonical = canonicalizeHivePolicy(policy);
    const bytes = hivePolicySignedBytes({ workspaceId: 'ws', potHomeSlug: 'home', policyVersion: 7, canonicalPolicyJson: canonical });
    const sig = signWithPrivateKeyDer(privateKeyDer, bytes);

    // Valid.
    expect(verifyEd25519(bytes, pubkeyBase64, sig)).toBe(true);

    // Tampered policy → the recomputed bytes differ → verify fails.
    const tampered = hivePolicySignedBytes({
      workspaceId: 'ws', potHomeSlug: 'home', policyVersion: 7,
      canonicalPolicyJson: canonicalizeHivePolicy({ ...policy, allowlist: ['attacker'] }),
    });
    expect(verifyEd25519(tampered, pubkeyBase64, sig)).toBe(false);

    // Wrong (attacker) key → verify fails even over the SAME bytes.
    const attacker = generateEd25519KeypairDer();
    expect(verifyEd25519(bytes, attacker.pubkeyBase64, sig)).toBe(false);

    // Version replay → bytes differ → verify fails.
    const replayed = hivePolicySignedBytes({ workspaceId: 'ws', potHomeSlug: 'home', policyVersion: 8, canonicalPolicyJson: canonical });
    expect(verifyEd25519(replayed, pubkeyBase64, sig)).toBe(false);
  });
});

describe('coerceHivePolicyInput', () => {
  it('accepts a valid policy + an empty policy', () => {
    expect(coerceHivePolicyInput({}).ok).toBe(true);
    expect(coerceHivePolicyInput({ rate: { opsPerMin: 10 }, membership: 'open', allowlist: ['a'], moderation: { reportable: true } }).ok).toBe(true);
  });

  it('accepts unknown keys (forward-compat)', () => {
    const r = coerceHivePolicyInput({ futureKnob: 42, membership: 'approval' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.policy.futureKnob).toBe(42);
  });

  it('rejects non-objects + structurally-wrong known fields', () => {
    expect(coerceHivePolicyInput(null).ok).toBe(false);
    expect(coerceHivePolicyInput([]).ok).toBe(false);
    expect(coerceHivePolicyInput('x').ok).toBe(false);
    expect(coerceHivePolicyInput({ membership: 'tyrant' }).ok).toBe(false);
    expect(coerceHivePolicyInput({ allowlist: [1, 2] }).ok).toBe(false);
    expect(coerceHivePolicyInput({ rate: { opsPerMin: -1 } }).ok).toBe(false);
    expect(coerceHivePolicyInput({ rate: { opsPerMin: 'lots' } }).ok).toBe(false);
    expect(coerceHivePolicyInput({ moderation: { bannedGithubIds: [1] } }).ok).toBe(false);
    expect(coerceHivePolicyInput({ moderation: { reportable: 'yes' } }).ok).toBe(false);
  });
});

describe('parseHivePolicyJson', () => {
  it('round-trips a policy; tolerates junk (→ {})', () => {
    expect(parseHivePolicyJson('{"membership":"open"}')).toEqual({ membership: 'open' });
    expect(parseHivePolicyJson('not json')).toEqual({});
    expect(parseHivePolicyJson('[1,2]')).toEqual({}); // arrays aren't policies
    expect(parseHivePolicyJson(null)).toEqual({});
    expect(parseHivePolicyJson('')).toEqual({});
  });
});

describe('policy.comms (P-012 — cross-machine-coord-parity-and-trust-2026-07-01)', () => {
  it('accepts a valid comms.defaultTier and preserves unknown comms subkeys (signed round-trip)', () => {
    const res = coerceHivePolicyInput({ comms: { defaultTier: 'wake', futureKnob: 42 } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.policy.comms).toEqual({ defaultTier: 'wake', futureKnob: 42 });
      // canonicalization covers the whole object — comms is signed like everything else
      const canon = canonicalizeHivePolicy(res.policy);
      expect(canon).toContain('"defaultTier":"wake"');
      expect(canon).toContain('"futureKnob":42');
    }
  });

  it('accepts every lattice tier and an empty comms object', () => {
    for (const tier of ['observe', 'message', 'wake', 'steer']) {
      expect(coerceHivePolicyInput({ comms: { defaultTier: tier } }).ok).toBe(true);
    }
    expect(coerceHivePolicyInput({ comms: {} }).ok).toBe(true);
  });

  it('rejects a garbage defaultTier and a non-object comms', () => {
    expect(coerceHivePolicyInput({ comms: { defaultTier: 'root' } }).ok).toBe(false);
    expect(coerceHivePolicyInput({ comms: 'wake' }).ok).toBe(false);
    expect(coerceHivePolicyInput({ comms: ['wake'] }).ok).toBe(false);
  });
});

describe('policy.crefs (G-6 P-030 — canonical-ref rules)', () => {
  const GREEN_BOT = 'greenBotPubkeyBase64';
  const OWNER = 'ownerPubkeyBase64';
  const releasePolicy: HivePolicy = {
    crefs: { rules: { 'refs/tags/releases/*': { allow: [GREEN_BOT, OWNER], threshold: 2 } } },
  };

  it('accepts a valid crefs rule set (the release-class shape) + empty crefs', () => {
    expect(coerceHivePolicyInput(releasePolicy).ok).toBe(true);
    expect(coerceHivePolicyInput({ crefs: {} }).ok).toBe(true);
    expect(coerceHivePolicyInput({ crefs: { rules: {} } }).ok).toBe(true);
    expect(coerceHivePolicyInput({ crefs: { rules: { 'refs/heads/main': { allow: [OWNER], threshold: 1 } } } }).ok).toBe(true);
  });

  it('preserves unknown crefs/rule subkeys (forward-compat, signed)', () => {
    const res = coerceHivePolicyInput({
      crefs: { futureKnob: 1, rules: { 'refs/tags/releases/*': { allow: [OWNER], threshold: 1, futureRuleKnob: 'x' } } },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const canon = canonicalizeHivePolicy(res.policy);
      expect(canon).toContain('"futureKnob":1');
      expect(canon).toContain('"futureRuleKnob":"x"');
    }
  });

  it('rejects garbage crefs rules (each structural failure mode)', () => {
    expect(coerceHivePolicyInput({ crefs: 'yes' }).ok).toBe(false);
    expect(coerceHivePolicyInput({ crefs: ['x'] }).ok).toBe(false);
    expect(coerceHivePolicyInput({ crefs: { rules: 'x' } }).ok).toBe(false);
    expect(coerceHivePolicyInput({ crefs: { rules: ['x'] } }).ok).toBe(false);
    // empty pattern key
    expect(coerceHivePolicyInput({ crefs: { rules: { '': { allow: [OWNER], threshold: 1 } } } }).ok).toBe(false);
    // rule not an object
    expect(coerceHivePolicyInput({ crefs: { rules: { 'refs/x': 'canonical' } } }).ok).toBe(false);
    // allow missing / empty / non-strings / blank key
    expect(coerceHivePolicyInput({ crefs: { rules: { 'refs/x': { threshold: 1 } } } }).ok).toBe(false);
    expect(coerceHivePolicyInput({ crefs: { rules: { 'refs/x': { allow: [], threshold: 1 } } } }).ok).toBe(false);
    expect(coerceHivePolicyInput({ crefs: { rules: { 'refs/x': { allow: [1], threshold: 1 } } } }).ok).toBe(false);
    expect(coerceHivePolicyInput({ crefs: { rules: { 'refs/x': { allow: [' '], threshold: 1 } } } }).ok).toBe(false);
    // threshold missing / zero / negative / non-integer / non-number
    expect(coerceHivePolicyInput({ crefs: { rules: { 'refs/x': { allow: [OWNER] } } } }).ok).toBe(false);
    expect(coerceHivePolicyInput({ crefs: { rules: { 'refs/x': { allow: [OWNER], threshold: 0 } } } }).ok).toBe(false);
    expect(coerceHivePolicyInput({ crefs: { rules: { 'refs/x': { allow: [OWNER], threshold: -2 } } } }).ok).toBe(false);
    expect(coerceHivePolicyInput({ crefs: { rules: { 'refs/x': { allow: [OWNER], threshold: 1.5 } } } }).ok).toBe(false);
    expect(coerceHivePolicyInput({ crefs: { rules: { 'refs/x': { allow: [OWNER], threshold: '2' } } } }).ok).toBe(false);
    // unsatisfiable: threshold > distinct allow keys (incl. duplicate-key inflation)
    expect(coerceHivePolicyInput({ crefs: { rules: { 'refs/x': { allow: [OWNER], threshold: 2 } } } }).ok).toBe(false);
    expect(coerceHivePolicyInput({ crefs: { rules: { 'refs/x': { allow: [OWNER, OWNER], threshold: 2 } } } }).ok).toBe(false);
  });

  it('matchRefPattern: exact match, * crosses /, regex specials stay literal', () => {
    expect(matchRefPattern('refs/heads/main', 'refs/heads/main')).toBe(true);
    expect(matchRefPattern('refs/heads/main', 'refs/heads/main2')).toBe(false);
    expect(matchRefPattern('refs/tags/releases/*', 'refs/tags/releases/v1.2.3')).toBe(true);
    expect(matchRefPattern('refs/tags/releases/*', 'refs/tags/releases/2026/v1')).toBe(true); // * crosses /
    expect(matchRefPattern('refs/tags/releases/*', 'refs/tags/release')).toBe(false);
    expect(matchRefPattern('refs/tags/v1.*', 'refs/tags/v1.9')).toBe(true);
    expect(matchRefPattern('refs/tags/v1.*', 'refs/tags/v1x9')).toBe(false); // `.` is literal
    expect(matchRefPattern('*', 'refs/anything/at/all')).toBe(true);
  });

  it('resolveCanonicalRule returns the rule for a matching ref, null otherwise', () => {
    const hit = resolveCanonicalRule(releasePolicy, 'refs/tags/releases/v2.0.0');
    expect(hit).toEqual({ pattern: 'refs/tags/releases/*', allow: [GREEN_BOT, OWNER], threshold: 2 });
    expect(resolveCanonicalRule(releasePolicy, 'refs/tags/nightly/v2.0.0')).toBeNull();
    expect(resolveCanonicalRule(releasePolicy, 'refs/heads/staging')).toBeNull();
    // permissive defaults: no policy / no crefs / no rules
    expect(resolveCanonicalRule(null, 'refs/tags/releases/v1')).toBeNull();
    expect(resolveCanonicalRule({}, 'refs/tags/releases/v1')).toBeNull();
    expect(resolveCanonicalRule({ crefs: {} }, 'refs/tags/releases/v1')).toBeNull();
  });

  it('resolveCanonicalRule: the MOST SPECIFIC matching pattern wins, deterministically', () => {
    const policy: HivePolicy = {
      crefs: {
        rules: {
          '*': { allow: [OWNER], threshold: 1 },
          'refs/tags/*': { allow: [OWNER], threshold: 1 },
          'refs/tags/releases/*': { allow: [GREEN_BOT, OWNER], threshold: 2 },
          'refs/tags/releases/v9.9.9': { allow: [GREEN_BOT], threshold: 1 },
        },
      },
    };
    expect(resolveCanonicalRule(policy, 'refs/tags/releases/v1.0.0')?.pattern).toBe('refs/tags/releases/*');
    expect(resolveCanonicalRule(policy, 'refs/tags/releases/v9.9.9')?.pattern).toBe('refs/tags/releases/v9.9.9');
    expect(resolveCanonicalRule(policy, 'refs/tags/nightly/n1')?.pattern).toBe('refs/tags/*');
    expect(resolveCanonicalRule(policy, 'refs/heads/main')?.pattern).toBe('*');
  });

  it('resolveCanonicalRule never THROWS on malformed rule entries (junk-safe read path), but no longer silently no-ops either', () => {
    const junk = {
      crefs: {
        rules: {
          'refs/tags/releases/*': 'not-an-object',
          'refs/tags/*': { allow: [], threshold: 1 },
          'refs/*': { allow: [OWNER], threshold: 0 },
          refs: null,
        },
      },
    } as unknown as HivePolicy;
    // The most-specific matching pattern ('refs/tags/releases/*') is itself malformed
    // (not even an object) — WI-1553 fail-closed: a poisoned, unsatisfiable rule comes
    // back for THAT pattern, not a silent null (which would read as "nothing governs
    // this ref, fully permissive" and is a strictly weaker/wrong signal here).
    expect(resolveCanonicalRule(junk, 'refs/tags/releases/v1')).toEqual({
      pattern: 'refs/tags/releases/*',
      allow: [],
      threshold: 1,
    });
    // A ref that matches ONLY 'refs' (no wildcard, malformed value `null`) still fails
    // closed rather than silently permissive-nulling.
    expect(resolveCanonicalRule(junk, 'refs')).toEqual({ pattern: 'refs', allow: [], threshold: 1 });
    // A ref matching NO pattern at all stays the genuine permissive default.
    expect(resolveCanonicalRule(junk, 'unrelated/ref')).toBeNull();
  });

  it('WI-1553 repro: does NOT fall through to a broader, weaker, VALID rule when the most-specific match is malformed', () => {
    const policy = {
      crefs: {
        rules: {
          'refs/heads/release': { allow: [] }, // malformed: empty allow, no threshold
          'refs/*': { allow: ['k'], threshold: 1 }, // valid, but broader + weaker
        },
      },
    } as unknown as HivePolicy;
    // Before the fix this returned the broad `refs/*` rule (a silent downgrade on a
    // trust surface). Now it must fail closed on the specific, malformed rule instead.
    const resolved = resolveCanonicalRule(policy, 'refs/heads/release');
    expect(resolved).toEqual({ pattern: 'refs/heads/release', allow: [], threshold: 1 });
    expect(resolved?.pattern).not.toBe('refs/*');
    // A DIFFERENT ref not matched by the malformed specific rule still resolves to the
    // valid broad rule normally.
    expect(resolveCanonicalRule(policy, 'refs/heads/other')).toEqual({
      pattern: 'refs/*',
      allow: ['k'],
      threshold: 1,
    });
  });

  it('round-trips through the SIGNED policy (canonicalize → sign → verify → parse → resolve)', () => {
    const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
    const res = coerceHivePolicyInput(releasePolicy);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const canonical = canonicalizeHivePolicy(res.policy);
    const bytes = hivePolicySignedBytes({ workspaceId: 'ws', potHomeSlug: 'home', policyVersion: 3, canonicalPolicyJson: canonical });
    const sig = signWithPrivateKeyDer(privateKeyDer, bytes);
    expect(verifyEd25519(bytes, pubkeyBase64, sig)).toBe(true);

    // A member re-parses the stored canonical JSON and resolves the SAME rule.
    const parsed = parseHivePolicyJson(canonical);
    expect(canonicalizeHivePolicy(parsed)).toBe(canonical); // stable round trip
    const rule = resolveCanonicalRule(parsed, 'refs/tags/releases/v1.0.0');
    expect(rule).toEqual({ pattern: 'refs/tags/releases/*', allow: [GREEN_BOT, OWNER], threshold: 2 });

    // Tampering with the crefs rules breaks the signature (crefs IS signed content).
    const tampered = canonicalizeHivePolicy({
      crefs: { rules: { 'refs/tags/releases/*': { allow: ['attackerKey'], threshold: 1 } } },
    });
    const tamperedBytes = hivePolicySignedBytes({ workspaceId: 'ws', potHomeSlug: 'home', policyVersion: 3, canonicalPolicyJson: tampered });
    expect(verifyEd25519(tamperedBytes, pubkeyBase64, sig)).toBe(false);
  });
});
