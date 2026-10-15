import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

/**
 * WI-10006711 recurrence guard — the portal typechecks what these modules reach.
 *
 * The cloud portal (`portal/apps/host`) imports three operator-core modules:
 * `lib/auth/hosted-principal`, `lib/auth/hosted-principal-resolver` and
 * (dynamically) `lib/endpoint-route/hosted-auth-runtime`. Its Next build runs
 * `tsc` over everything those modules reach, including `import type` edges,
 * under Next's readonly `NODE_ENV` ProcessEnv.
 *
 * On 2026-10-06 one type-only import in `auth/hosted/billing/usage-store.ts`
 * (`OpenRouterRequestCapture` from `agent-loop/provider-router`) pulled the
 * router's credential/gateway graph, ~5.8k operator-core files, into the
 * portal's typecheck. 135 errors followed, and the live portal could not publish
 * until the types moved to the no-import leaf `agent-loop/model-port`. After the
 * fix the closure is ~53 files.
 *
 * The check is a STATIC walk on purpose. A papercusp suite cannot run the
 * portal's Next typecheck, but it can see the closure that typecheck inherits.
 * `ts.preProcessFile` is the compiler's own import scanner, so comments never
 * create edges and type-only, re-export and dynamic imports all count, as they
 * do for tsc.
 */

const PKG_ROOT = resolve(__dirname, '../..');
const PKG_SPECIFIER = '@papercusp/operator-core/';

const PORTAL_ENTRYPOINTS = [
  'lib/auth/hosted-principal.ts',
  'lib/auth/hosted-principal-resolver.ts',
  'lib/endpoint-route/hosted-auth-runtime.ts',
];

/** Hubs whose graphs are not portal-compatible. Reaching any one drags its
 * whole credential/gateway/chat subtree into the portal build. */
const FORBIDDEN_HUBS = [
  'lib/agent-loop/provider-router.ts',
  'lib/agent-chat-stream.ts',
  'lib/credentials.ts',
];

/** ~2x the measured closure (53 on 2026-10-06). Crossing it means a new edge
 * pulled a large subgraph into the portal build. Raise it only after the portal
 * typecheck (`node scripts/typecheck.mjs` in the portal checkout) is clean with
 * the larger closure. */
const CLOSURE_CEILING = 110;

type ReadSource = (absPath: string) => string;

const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else if (spec.startsWith(PKG_SPECIFIER)) base = join(PKG_ROOT, spec.slice(PKG_SPECIFIER.length));
  else return null; // external package: outside this closure
  const stem = base.replace(/\.m?js$/, '');
  const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, join(base, 'index.ts'), join(base, 'index.tsx')];
  return candidates.find((c) => /\.m?tsx?$/.test(c) && isFile(c)) ?? null;
}

/** Breadth-first closure with a parent map, so a failure can print the chain. */
function walkClosure(read: ReadSource) {
  const parent = new Map<string, string | null>();
  const queue = PORTAL_ENTRYPOINTS.map((e) => join(PKG_ROOT, e));
  for (const entry of queue) parent.set(entry, null);
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const ref of ts.preProcessFile(read(file), true, true).importedFiles) {
      const target = resolveSpecifier(file, ref.fileName);
      if (target && !parent.has(target)) {
        parent.set(target, file);
        queue.push(target);
      }
    }
  }
  const chainTo = (relPath: string): string[] | null => {
    let cur: string | null | undefined = join(PKG_ROOT, relPath);
    if (!parent.has(cur)) return null;
    const chain: string[] = [];
    while (cur) {
      chain.unshift(relative(PKG_ROOT, cur));
      cur = parent.get(cur);
    }
    return chain;
  };
  return { size: parent.size, chainTo };
}

const readDisk: ReadSource = (p) => readFileSync(p, 'utf8');

describe('portal-reached operator-core closure (WI-10006711)', () => {
  const closure = walkClosure(readDisk);

  it('walks real type-only edges into hosted billing (positive control)', () => {
    // If the walker silently stopped following edges, every negative assertion
    // below would pass vacuously. usage-store -> model-port is `import type`.
    expect(closure.chainTo('lib/auth/hosted/billing/usage-store.ts')).not.toBeNull();
    expect(closure.chainTo('lib/agent-loop/model-port.ts')).not.toBeNull();
  });

  it.each(FORBIDDEN_HUBS)('does not reach %s', (hub) => {
    const chain = closure.chainTo(hub);
    expect(
      chain,
      `${hub} is reachable from the portal entrypoints via\n  ${chain?.join('\n  -> ')}\n` +
        'The portal typechecks this whole graph under Next and cannot build. Move the ' +
        'shared declaration to a leaf module (types: agent-loop/model-port.ts) instead.',
    ).toBeNull();
  });

  it(`stays under ${CLOSURE_CEILING} files`, () => {
    expect(closure.size).toBeLessThanOrEqual(CLOSURE_CEILING);
  });

  it('catches the original regression (permanent negative control)', () => {
    // Replay the 2026-10-06 import on an in-memory copy; nothing on disk changes.
    const usageStore = join(PKG_ROOT, 'lib/auth/hosted/billing/usage-store.ts');
    const regressed = walkClosure((p) =>
      p === usageStore
        ? `${readDisk(p)}\nimport type { OpenRouterRequestCapture } from '../../../agent-loop/provider-router';\n`
        : readDisk(p),
    );
    expect(regressed.chainTo('lib/agent-loop/provider-router.ts')).not.toBeNull();
    expect(regressed.size).toBeGreaterThan(CLOSURE_CEILING);
  });
});
