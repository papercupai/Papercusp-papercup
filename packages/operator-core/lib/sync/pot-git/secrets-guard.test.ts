/**
 * secrets-guard.test.ts — G-10 secret-pattern guard (pure, no git/PG). Proves
 * the high-signal rules catch real credential shapes, the generic
 * secret-assignment rule is entropy-gated (placeholders pass), clean code is
 * clean, and the secret is masked in the finding.
 *
 * Run: cd packages/operator-core && npx vitest run lib/sync/pot-git/secrets-guard.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  scanTextForSecrets,
  scanForSecrets,
  hasSecrets,
  isFixtureFile,
  isGeneratedNativeFixturePath,
  shannonEntropy,
  describeSecretFindings,
} from './secrets-guard';

// Assembled at runtime so this very test file does not contain a literal AKIA…
// token that the guard (or another scanner) would flag when it scans the repo.
const AKIA = 'AKIA' + 'ABCDEFGHIJ123456';
const GH = 'ghp_' + 'a'.repeat(36);

describe('secrets-guard rules', () => {
  it('flags an AWS access key id', () => {
    const f = scanTextForSecrets('config.ts', `const k = "${AKIA}";`);
    expect(f).toHaveLength(1);
    expect(f[0].rule).toBe('aws-access-key-id');
    expect(f[0].line).toBe(1);
    expect(f[0].excerpt).not.toContain(AKIA); // masked
  });

  it('does NOT flag AWS documented EXAMPLE keys (shape-rule example exemption)', () => {
    // AWS reserves the literal EXAMPLE suffix for its non-functional docs keys.
    // A runbook that merely CITES AKIAIOSFODNN7EXAMPLE must not wedge the publish
    // plane — this false positive was the P-402 canonical-stall root cause.
    const example = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE'; // = AKIAIOSFODNN7EXAMPLE
    const doc = scanTextForSecrets(
      'agent-insights/desktop-release-upload-runbook.mdx',
      `Real example: \`${example}\` is AWS's own non-functional example key.`,
    );
    expect(doc).toEqual([]);
    // But a genuinely-shaped key that does NOT end in EXAMPLE still flags.
    expect(scanTextForSecrets('c.ts', `k="${AKIA}"`).some((x) => x.rule === 'aws-access-key-id')).toBe(true);
  });

  it('flags a GitHub token and a PEM private-key block', () => {
    const gh = scanTextForSecrets('a.env', `GITHUB_TOKEN=${GH}`);
    expect(gh.some((x) => x.rule === 'github-token')).toBe(true);
    // Header assembled at runtime so THIS test file's bytes never contain a
    // PEM-shaped block — the guard scans the publish range, us included.
    const pemHeader = ['-----BEGIN OPENSSH ', 'PRIVATE KEY-----'].join('');
    const pem = scanTextForSecrets('id_rsa', `${pemHeader}\nabc\n-----END-----`);
    expect(pem.some((x) => x.rule === 'private-key-pem')).toBe(true);
  });

  it('secret-assignment rule is entropy-gated: real value flagged, placeholder ignored', () => {
    // Value assembled from <20-char fragments so this file's bytes can't match
    // the {20,} capture — the runtime string is still a realistic secret.
    const value = ['Zx9Kq2mNp7Rw4T', 'v8Lb3Yh6Fd1Gs5Jc0'].join('');
    const real = scanTextForSecrets('c.ts', `const client_secret = "${value}"`);
    expect(real.some((x) => x.rule === 'secret-assignment')).toBe(true);
    const destructuringRename = scanTextForSecrets(
      'byoc-readiness.test.ts',
      'const { privateKey: PUBLICATION_PRIVATE_KEY, publicKey: PUBLICATION_PUBLIC_KEY } = generateKeyPairSync("ed25519");',
    );
    expect(destructuringRename).toEqual([]);
    const unquotedEnvironmentSecret = scanTextForSecrets('.env', `PRIVATE_KEY=${value}`);
    expect(unquotedEnvironmentSecret.some((x) => x.rule === 'secret-assignment')).toBe(true);
    // Low-entropy placeholder (repetitive / wordy) must NOT trip the build.
    const placeholder = scanTextForSecrets('c.ts', `const api_key = "your-api-key-goes-right-here"`);
    expect(placeholder.some((x) => x.rule === 'secret-assignment')).toBe(false);
  });

  it('authorization-header rule flags a literal bearer in a launcher-written .mcp.json (WI-6554700010019088)', () => {
    // Assembled from <20-char fragments so this file's bytes cannot match the {20,} capture.
    const token = ['Q7wZk2PmX9vRb4Ts', 'N8yHc3Lf6Dg1Jq5A'].join('');
    // The exact shape console-spawn.ts writes into a pot checkout, which the generic
    // secret-assignment rule cannot see (key `Authorization`, value `Bearer <token>`).
    const mcpJson = JSON.stringify(
      {
        mcpServers: {
          papercusp: {
            url: 'http://127.0.0.1:9071/api/mcp?superuser=1&workspace=papercusp-workspace',
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      },
      null,
      2,
    );
    const found = scanTextForSecrets('.mcp.json', mcpJson);
    expect(found.map((x) => x.rule)).toEqual(['authorization-header']);
    expect(found[0].line).toBe(6);
    expect(found[0].excerpt).not.toContain(token);
    // A header line and a curl -H argument carry the same credential.
    expect(scanTextForSecrets('notes.md', `Authorization: Bearer ${token}`).map((x) => x.rule)).toEqual([
      'authorization-header',
    ]);
    expect(
      scanTextForSecrets('probe.sh', `curl -H 'Authorization: token ${token}' https://api.github.com/user`).map(
        (x) => x.rule,
      ),
    ).toEqual(['authorization-header']);
  });

  it('authorization-header rule ignores templates, concatenation, placeholders and low-entropy stand-ins', () => {
    const negatives: Array<[string, string]> = [
      ['client.ts', 'headers: { Authorization: `Bearer ${token}` },'],
      ['client.ts', "headers['Authorization'] = 'Bearer ' + session.accessToken;"],
      ['README.md', 'Authorization: Bearer <your-token>'],
      ['README.md', 'Authorization: Bearer $PAPERCUSP_TOKEN'],
      ['fixture.test.ts', `"Authorization": "Bearer ${'a'.repeat(40)}"`],
      ['fixture.test.ts', `"Authorization": "Bearer ${['example-bearer-', 'token-value-xyz'].join('')}"`],
      ['client.ts', 'const scheme = "Bearer"; // Authorization scheme'],
      // A constant name stands in for a key in docs and diffs; it is not an issued token.
      ['audit.jsonl.md', "headers: { authorization: 'Bearer PRIVATE_PROVIDER_KEY' }"],
    ];
    for (const [path, line] of negatives) {
      expect(scanTextForSecrets(path, line), `${path}: ${line}`).toEqual([]);
    }
  });

  it('authorization-header rule is scoped to data/config files: a realistic stand-in in a source file is not flagged', () => {
    const token = ['Q7wZk2PmX9vRb4Ts', 'N8yHc3Lf6Dg1Jq5A'].join('');
    const line = `"Authorization": "Bearer ${token}"`;
    for (const sourceFile of ['route.test.ts', 'client.tsx', 'hook.mjs', 'chat_copy.rs', 'probe.py']) {
      expect(scanTextForSecrets(sourceFile, line), sourceFile).toEqual([]);
    }
    for (const dataFile of ['.mcp.json', '.mcp.json.su-parked', 'original-config.txt.md', 'values.yaml', '.env']) {
      expect(scanTextForSecrets(dataFile, line).map((x) => x.rule), dataFile).toEqual(['authorization-header']);
    }
  });

  it('clean source has no findings', () => {
    const clean = `export function add(a: number, b: number) { return a + b; }\nconst url = "https://example.com/api";`;
    expect(scanTextForSecrets('math.ts', clean)).toEqual([]);
    expect(hasSecrets([{ path: 'math.ts', content: clean }])).toBe(false);
  });

  it('keeps quarantine-prone test fixtures clean under the commit scanner', () => {
    const files = [
      {
        path: 'packages/operator-core/lib/inference-gateway/gateway-stage-telemetry.test.ts',
        relative: '../../inference-gateway/gateway-stage-telemetry.test.ts',
      },
      {
        path: 'packages/operator-core/lib/launch-cost/scan-launch-transcripts.test.ts',
        relative: '../../launch-cost/scan-launch-transcripts.test.ts',
      },
      {
        path: 'packages/operator-core/lib/dao-hr/onboarding.integration.test.ts',
        relative: '../../dao-hr/onboarding.integration.test.ts',
      },
      {
        path: 'packages/operator-core/lib/dao-hr/contracts-esign.integration.test.ts',
        relative: '../../dao-hr/contracts-esign.integration.test.ts',
      },
      {
        path: 'packages/operator-core/lib/dao-hr/contracts-esign.test.ts',
        relative: '../../dao-hr/contracts-esign.test.ts',
      },
      {
        path: 'apps/operator/bin/hosted-check-refs.test.ts',
        relative: '../../../../../apps/operator/bin/hosted-check-refs.test.ts',
      },
      {
        path: 'packages/operator-core/lib/auth/hosted/secret-ref.test.ts',
        relative: '../../auth/hosted/secret-ref.test.ts',
      },
      {
        path: 'packages/operator-core/lib/isolated-integration-proof.test.ts',
        relative: '../../isolated-integration-proof.test.ts',
      },
      {
        path: 'packages/operator-core/lib/auth/hosted/database-access.integration.test.ts',
        relative: '../../auth/hosted/database-access.integration.test.ts',
      },
      {
        path: 'packages/operator-core/lib/endpoint-route/hosted-billing-runtime.test.ts',
        relative: '../../endpoint-route/hosted-billing-runtime.test.ts',
      },
      {
        path: 'packages/operator-core/lib/workspace-host/hosted-gcp-auth.test.ts',
        relative: '../../workspace-host/hosted-gcp-auth.test.ts',
      },
    ];
    for (const file of files) {
      const content = readFileSync(join(__dirname, file.relative), 'utf8');
      expect(scanForSecrets([{ path: file.path, content }])).toEqual([]);
    }
  });

  it('skips absurdly long (minified) lines', () => {
    const minified = `x=${'a'.repeat(5000)}${AKIA}`;
    // The AKIA is embedded in a >4096-char line → skipped (no per-line secrets there).
    expect(scanTextForSecrets('bundle.min.js', minified)).toEqual([]);
  });

  it('scanForSecrets aggregates across files; describe masks + counts', () => {
    const findings = scanForSecrets([
      { path: 'a.ts', content: `k="${AKIA}"` },
      { path: 'b.ts', content: `t=${GH}` },
      { path: 'ok.ts', content: 'const x = 1;' },
    ]);
    expect(findings.length).toBeGreaterThanOrEqual(2);
    const msg = describeSecretFindings(findings);
    expect(msg).toContain('refusing to publish');
    expect(msg).not.toContain(AKIA);
  });

  it('shannonEntropy: random > english word', () => {
    expect(shannonEntropy('Zx9Kq2mNp7Rw4Tv8Lb3Yh6Fd1Gs5Jc0')).toBeGreaterThan(shannonEntropy('passwordpassword'));
  });

  it('exempts this fixture file by path (scanner must not scan its own fixtures)', () => {
    // This file's historical blobs carry literal credential shapes; without a
    // path exemption, editing it wedges the whole publish plane forever (the
    // literal blob can never leave the publish range). scanForSecrets/hasSecrets
    // therefore skip the designated fixture path — but the pure per-line
    // scanTextForSecrets stays path-agnostic so the rule tests above still fire.
    const fixturePath = 'packages/operator-core/lib/sync/pot-git/secrets-guard.test.ts';
    expect(isFixtureFile(fixturePath)).toBe(true);
    // Sibling secrets-detector hook: its bare PEM private-key header self-test
    // literal wedged the papercusp own-head publish plane 2026-07-20 — same
    // class, exempted by exact path.
    expect(isFixtureFile('apps/operator/scripts/hooks/cc/pretooluse-secrets-guard.mjs')).toBe(true);
    // The scanner's own source is exempt too: it is the one product file
    // guaranteed to carry credential-shape-adjacent text (the RULES regexes +
    // any documenting comment), and a bare literal there wedges publish forever.
    expect(isFixtureFile('packages/operator-core/lib/sync/pot-git/secrets-guard.ts')).toBe(true);
    expect(isFixtureFile('packages/operator-core/lib/sync/pot-git/own-head-publish.ts')).toBe(false);
    const loaded = `k="${AKIA}"\n${GH}`; // real shapes that WOULD flag anywhere else
    expect(scanForSecrets([{ path: fixturePath, content: loaded }])).toEqual([]);
    expect(hasSecrets([{ path: fixturePath, content: loaded }])).toBe(false);
    // Same content at a non-fixture path still flags — the exemption is path-scoped.
    expect(scanForSecrets([{ path: 'src/config.ts', content: loaded }]).length).toBeGreaterThanOrEqual(2);
  });

  it('voice-credentials integration test is exempt by path, not by content (EI-20216447367071456)', () => {
    // WI/EI-20216447367071456: the tested scanner and the live publish guard
    // went behaviorally divergent because voice-credentials.integration.test.ts
    // had ONLY a content-dependent self-check (`scanForSecrets([this file's
    // CURRENT content]) === []`), not a path exemption. A historical blob of
    // that same file (commit b3279dba9f, before the fixture literal was
    // reworded to include a PLACEHOLDER_RE marker) contained an un-suppressed
    // 'sk_plaintext_...' literal, which the shape rules DO flag — and per the
    // header comment above, that blob is permanently inside the own-head
    // publish range no matter how the current file reads (froze publication
    // EI-20191187592939864, 2026-08-11; cleared by a runtime path exemption
    // that is retired now that the static entry below supersedes it).
    const path = 'packages/operator-core/lib/voice-credentials.integration.test.ts';
    expect(isFixtureFile(path)).toBe(true);
    // Reproduce the ACTUAL historical trigger directly: the pre-reword literal,
    // at the real path, must be treated as exempt regardless of content —
    // proving the fix is path-scoped, not a lucky content coincidence.
    // Assembled at runtime (like AKIA/GH above) so this test file's own SOURCE
    // never contains the bare 20+-char literal the write-time guard would flag.
    const historicalSecret = 'sk_plaintext_' + 'supersecret_9999';
    const historicalContent = `const SECRET = '${historicalSecret}';`;
    expect(scanForSecrets([{ path, content: historicalContent }])).toEqual([]);
    // Sanity: the SAME literal at a non-fixture path still flags — confirms the
    // exemption is path-scoped, not a rule change that weakened detection.
    expect(scanForSecrets([{ path: 'src/config.ts', content: historicalContent }]).length).toBeGreaterThanOrEqual(1);
  });

  it('skips generated native fixture bundles while scanning similarly named source', () => {
    const text = `const key = '${AKIA}';\n${GH}\n`;
    const generatedPaths = [
      'apps/operator/dist-host-native-fixture-debug-2001983/hono-host.mjs',
      'apps/operator/apps/operator/dist-host-native-fixture-debug-2047298/hono-host.mjs',
    ];
    for (const path of generatedPaths) {
      expect(isGeneratedNativeFixturePath(path)).toBe(true);
      expect(scanForSecrets([{ path, content: text }])).toEqual([]);
      expect(hasSecrets([{ path, content: text }])).toBe(false);
    }
    const maintainedPath = 'packages/operator-core/lib/dist-host-native-fixture-debugger.ts';
    expect(isGeneratedNativeFixturePath(maintainedPath)).toBe(false);
    expect(scanForSecrets([{ path: maintainedPath, content: text }]).map((f) => f.rule)).toEqual([
      'aws-access-key-id',
      'github-token',
    ]);
    expect(hasSecrets([{ path: maintainedPath, content: text }])).toBe(true);
  });

  it('BLOCKING publish paths use the exemption-aware entrypoint, never the raw primitive', () => {
    // The trap this guards (P-402 / EI-13924, 2026-07-19): github-egress called
    // the per-line `scanTextForSecrets` directly, so it never applied
    // isFixtureFile. The scanner's own fixture blobs flagged, egress refused
    // every tick, and origin/staging froze for hours — unrecoverable by any
    // re-commit, because the offending blob is permanently inside the pushed
    // range. Only a scanner-code change can clear it, so the fix must be
    // structural: a path that BLOCKS a publish must scan via `scanForSecrets`.
    // (content-op-egress-guard is deliberately excluded — it REDACTS lines
    // rather than blocking, so it cannot deadlock a publish plane.)
    //
    // WI-6278: the check follows LOCAL (`./sibling`) delegation TRANSITIVELY
    // rather than grepping only the named file. A blocking path may legitimately
    // move the scan one hop into a helper — WI-6254 did exactly that, routing
    // publish-guard.ts and foreign-mirror-quarantine.ts through
    // chunked-blob-scan.ts for a bounded-memory scan — and the old single-file
    // grep read that refactor as a violation (green-checkpoint red, candidate
    // 0482a285) while the invariant was in fact intact. It also left the real
    // hole open in the other direction: a helper calling the raw primitive was
    // invisible, because only the three named files were ever read. Walking the
    // closure closes both, so this is strictly stronger than the grep it replaces.
    const readLocalClosure = (entry: string): Map<string, string> => {
      const seen = new Map<string, string>();
      const queue = [entry];
      while (queue.length > 0) {
        const rel = queue.shift() as string;
        if (seen.has(rel)) continue;
        let src: string;
        try {
          src = readFileSync(join(__dirname, rel), 'utf8');
        } catch {
          continue; // not a sibling .ts module (node builtin / package / dir index)
        }
        seen.set(rel, src);
        // `import ... from './x'`, `export ... from './x'`, `await import('./x')`.
        for (const m of src.matchAll(/(?:from|import)\s*\(?\s*'(\.\/[\w./-]+)'/g)) {
          const spec = m[1].slice(2); // drop the leading './'
          if (spec.includes('..') || /\.(test|integration\.test)$/.test(spec)) continue;
          queue.push(spec.endsWith('.ts') ? spec : `${spec}.ts`);
        }
      }
      return seen;
    };

    const blockingPublishPaths = ['github-egress.ts', 'publish-guard.ts', 'foreign-mirror-quarantine.ts'];
    for (const file of blockingPublishPaths) {
      const closure = readLocalClosure(file);
      expect(closure.has(file), `${file} must be readable`).toBe(true);
      let reachesScanForSecrets = false;
      for (const [name, src] of closure) {
        // secrets-guard.ts DEFINES both entrypoints (scanForSecrets is implemented
        // in terms of the per-line primitive), so it is the one legitimate caller.
        if (name === 'secrets-guard.ts') continue;
        const calls = src.match(/\bscanTextForSecrets\s*\(/g) ?? [];
        expect(
          calls,
          `${file} → ${name} must not call scanTextForSecrets directly — use scanForSecrets`,
        ).toEqual([]);
        if (/\bscanForSecrets\s*\(/.test(src)) reachesScanForSecrets = true;
      }
      expect(
        reachesScanForSecrets,
        `${file} must scan via scanForSecrets (directly, or through a local helper it imports)`,
      ).toBe(true);
    }
  });
});
