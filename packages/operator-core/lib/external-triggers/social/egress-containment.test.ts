/**
 * Containment gate: no social module names a host its registry row does not
 * declare (P-024, the enforcement half of the egress allowlist).
 *
 * WHY A STATIC GATE AND NOT ONLY THE RUNTIME GUARD. Every adapter here takes its
 * HTTP client as an injected dependency, so there is no runtime moment at which
 * this suite could observe a call and judge it. What there IS, in every module,
 * is the host LITERAL the client will be pointed at — an origin constant, a
 * permalink prefix, an endpoint in a template string. That literal is the
 * earliest observable form of an egress decision, and it is observable now,
 * which is the whole reason this check can exist before a single client is
 * written.
 *
 * ATTRIBUTION IS DERIVED, NOT CONVENTIONAL. A filename-prefix rule
 * (`facebook-*.ts` belongs to facebook) would be a second, hand-maintained copy
 * of a fact the source already states, and D-042 already rejected exactly that
 * shape for the wave-B gate. So a module's platforms come from the markers the
 * code itself carries — `readonly platformId` on a read adapter, `platform:` /
 * `readonly platform` on a write adapter — and a shared module inherits the
 * platforms of the modules that IMPORT it. `instagram-common.ts` is therefore
 * Instagram's because its adapters import it, not because of its name.
 *
 * IT MUST NOT PASS VACUOUSLY. A guard whose job is to notice an absence reports
 * a fully-compliant tree and a broken scanner identically. So it asserts a
 * non-trivial population first, pins the origin constants it must be seeing, and
 * runs the same checker over synthetic sources as a negative control.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from './comment-stripper.fixture';
import { listSocialPlatforms, type SocialPlatformId } from './platform-registry';
import { normalizeEgressHost, socialEgressHostBudget } from './social-egress';

const SUBJECT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The one file exempt from the literal scan, and why.
 *
 * `platform-registry.ts` IS the declaration. Its `sources` are the vendor doc
 * URLs each row was verified from — `developers.facebook.com`,
 * `raw.githubusercontent.com` — which are documentation, not call targets, and
 * which must NOT become reachable by being cited. Nothing in that file performs
 * or configures a request, so exempting it removes no coverage. The list is
 * asserted below so it cannot quietly grow into a place to hide a host.
 */
const EXEMPT = new Set(['platform-registry.ts']);

const isSubject = (f: string) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !EXEMPT.has(f);

/** Both marker forms the adapters actually use. Read adapters and write adapters differ. */
const MARKERS = [
  /readonly\s+platformId\s*=\s*'([a-z0-9-]+)'/g,
  /readonly\s+platform\s*=\s*'([a-z0-9-]+)'/g,
  /\bplatform:\s*'([a-z0-9-]+)'/g,
];

/** Local sibling imports, e.g. `from './instagram-common'`. */
const LOCAL_IMPORT = /from\s+'\.\/([a-zA-Z0-9._-]+)'/g;

/** Every `scheme://host` literal left after comments are removed. */
export function hostLiterals(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/\b(?:https?|wss?):\/\/([A-Za-z0-9._-]+)/g)) {
    out.add(normalizeEgressHost(m[1]!));
  }
  return [...out];
}

const KNOWN_IDS = new Set(listSocialPlatforms().map((r) => r.id));

/** platform ids a module declares in its own executable code. */
function declaredPlatforms(code: string): Set<string> {
  const ids = new Set<string>();
  for (const re of MARKERS) {
    for (const m of code.matchAll(re)) {
      const id = m[1]!;
      if (KNOWN_IDS.has(id as SocialPlatformId)) ids.add(id);
    }
  }
  return ids;
}

interface Module {
  file: string;
  /** Source with comments removed — prose naming a host is documentation, not egress. */
  code: string;
  imports: string[];
  platforms: Set<string>;
}

function loadModules(): Module[] {
  const files = readdirSync(SUBJECT_DIR).filter(isSubject);
  const modules: Module[] = files.map((file) => {
    const code = stripComments(readFileSync(join(SUBJECT_DIR, file), 'utf8'));
    const imports = [...code.matchAll(LOCAL_IMPORT)]
      .map((m) => `${m[1]!.replace(/\.js$/, '')}.ts`)
      .filter((f) => files.includes(f));
    return { file, code, imports, platforms: declaredPlatforms(code) };
  });

  // Propagate importer -> imported to a fixpoint: a shared module inherits the
  // platforms of everything that pulls it in. Bounded by the module count, so a
  // cycle terminates instead of spinning.
  const byFile = new Map(modules.map((m) => [m.file, m]));
  for (let pass = 0; pass < modules.length; pass += 1) {
    let changed = false;
    for (const mod of modules) {
      for (const target of mod.imports) {
        const dep = byFile.get(target);
        if (!dep) continue;
        for (const id of mod.platforms) {
          if (!dep.platforms.has(id)) {
            dep.platforms.add(id);
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }
  return modules;
}

export interface HostFinding {
  file: string;
  host: string;
  /** 'undeclared' — no attributed row declares it; 'unattributable' — no row owns the file. */
  kind: 'undeclared' | 'unattributable';
  platforms: string[];
}

/**
 * The check itself, over any set of modules — so the negative control below
 * exercises this exact code path rather than a re-implementation of it.
 */
export function undeclaredHostFindings(modules: Module[]): HostFinding[] {
  const budgets = new Map(
    listSocialPlatforms().map((row) => [row.id as string, socialEgressHostBudget(row.egress)]),
  );
  const findings: HostFinding[] = [];
  for (const mod of modules) {
    const hosts = hostLiterals(mod.code);
    if (hosts.length === 0) continue;
    const platforms = [...mod.platforms].sort();
    if (platforms.length === 0) {
      for (const host of hosts) findings.push({ file: mod.file, host, kind: 'unattributable', platforms });
      continue;
    }
    for (const host of hosts) {
      const declared = platforms.some((id) => {
        const budget = budgets.get(id);
        return Boolean(budget && (budget.apiHosts.has(host) || budget.permalinkHosts.has(host)));
      });
      if (!declared) findings.push({ file: mod.file, host, kind: 'undeclared', platforms });
    }
  }
  return findings;
}

const MODULES = loadModules();

describe('the scan is measuring something', () => {
  it('sees the whole adapter directory', () => {
    expect(MODULES.length).toBeGreaterThanOrEqual(20);
  });

  it('finds host literals to judge', () => {
    const total = MODULES.reduce((n, m) => n + hostLiterals(m.code).length, 0);
    expect(total).toBeGreaterThanOrEqual(8);
  });

  it('exempts exactly one file, the registry itself', () => {
    expect([...EXEMPT]).toEqual(['platform-registry.ts']);
  });

  it('attributes the shared modules through imports rather than filenames', () => {
    // These shared modules carry API-origin constants and declare no
    // platform marker of their own. If import propagation broke, they would go
    // unattributed and the gate would report that rather than silently pass.
    const platformsOf = (file: string) =>
      [...(MODULES.find((m) => m.file === file)?.platforms ?? [])].sort();
    expect(platformsOf('instagram-common.ts')).toEqual(['instagram']);
    expect(platformsOf('threads-common.ts')).toEqual(['threads']);
  });

  it('is looking at the origin constants it exists to police', () => {
    const hostsIn = (file: string) => hostLiterals(MODULES.find((m) => m.file === file)?.code ?? '');
    expect(hostsIn('instagram-common.ts')).toContain('graph.facebook.com');
    expect(hostsIn('threads-common.ts')).toContain('graph.threads.net');
  });
});

describe('every host literal is declared by the module’s own platform', () => {
  it('has no undeclared or unattributable hosts', () => {
    const findings = undeclaredHostFindings(MODULES);
    expect(
      findings,
      findings
        .map((f) => `${f.file}: '${f.host}' (${f.kind}; attributed to ${f.platforms.join(', ') || 'nothing'})`)
        .join('\n'),
    ).toEqual([]);
  });
});

describe('negative controls — the checker can fail', () => {
  const synthetic = (file: string, code: string, platforms: string[]): Module => ({
    file,
    code,
    imports: [],
    platforms: new Set(platforms),
  });

  it('catches a host no row declares', () => {
    const findings = undeclaredHostFindings([
      synthetic('fake-adapter.ts', `const ORIGIN = 'https://exfil.example';`, ['reddit']),
    ]);
    expect(findings).toEqual([
      { file: 'fake-adapter.ts', host: 'exfil.example', kind: 'undeclared', platforms: ['reddit'] },
    ]);
  });

  it('catches ANOTHER platform’s declared host — this is the cross-platform case', () => {
    // graph.threads.net is declared, just not by reddit. A checker that pooled
    // all rows' hosts into one set would pass this, which is the specific
    // weakness this control measures.
    const findings = undeclaredHostFindings([
      synthetic('fake-adapter.ts', `fetch('https://graph.threads.net/v1.0/me');`, ['reddit']),
    ]);
    expect(findings.map((f) => f.host)).toEqual(['graph.threads.net']);
  });

  it('catches a host in a module no row owns', () => {
    const findings = undeclaredHostFindings([
      synthetic('orphan.ts', `const ORIGIN = 'https://graph.facebook.com';`, []),
    ]);
    expect(findings[0]).toMatchObject({ kind: 'unattributable', host: 'graph.facebook.com' });
  });

  it('does NOT flag a host named only in prose', () => {
    // The exemption that makes the gate usable: documenting a vendor host is not
    // reaching it. If the stripper ever stopped stripping, this control goes red
    // rather than the gate quietly widening.
    const stripped = stripComments(`/** See https://exfil.example for background. */\nexport const x = 1;`);
    expect(undeclaredHostFindings([synthetic('doc.ts', stripped, ['reddit'])])).toEqual([]);
  });

  it('DOES flag a host in a string literal that merely looks like a comment', () => {
    const stripped = stripComments(`const u = 'https://exfil.example/a//b';`);
    expect(undeclaredHostFindings([synthetic('s.ts', stripped, ['reddit'])]).map((f) => f.host)).toEqual([
      'exfil.example',
    ]);
  });
});
