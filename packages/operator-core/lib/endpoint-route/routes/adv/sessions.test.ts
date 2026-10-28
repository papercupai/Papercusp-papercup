import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WIRING GUARD for the `hasArchive` enrichment key (WI-38236).
 *
 * The bug this pins was not a wrong ALGORITHM — it was one extra, plausible-looking
 * ARGUMENT at a single call site. `/adv/sessions/resumable` read archive stamps with
 * `readStamp(s.agent, s.sessionId, s.workspaceId)`, passing 'papercusp-workspace',
 * while archive-at-death writes every row under WS_DEFAULT ('default' — measured
 * 2026-08-12: 17,147 rows, 100% 'default'). The lookup therefore matched nothing and
 * `hasArchive` came back false for EVERY archived session (live :3070: 29 claude/codex
 * rows, 0 flagged), so the psu picker hid every off-disk session as an unresumable
 * "ghost" — the exact 2026-07-13 owner bug the enrichment exists to prevent.
 *
 * That is the dangerous shape: an enrichment that is 100% inert still returns a
 * well-formed response, so nothing fails and no one notices for a month. The
 * behavioural key symmetry is pinned in session-archive.test.ts
 * ("archive workspace key — the WRITER and every READER must agree"); this guard
 * pins the CALL SITE, because a correct store is worthless if the caller re-adds
 * the argument.
 */
describe('adv/sessions resumable — hasArchive must read the stamp with the writer\'s key', () => {
  const src = readFileSync(join(__dirname, 'sessions.ts'), 'utf8');

  it('reads the stamp WITHOUT a workspace argument (defaults to WS_DEFAULT, as the writer writes)', () => {
    expect(src).toContain('await store.readStamp(archiveAgent, archiveSessionId)');
  });

  it('uses OMP thread identity when session_id is null', () => {
    expect(src).toContain("const archiveSessionId = s.agent === 'omp' ? s.ompThreadId : s.sessionId");
    expect(src).toContain("if (!archiveSessionId || (archiveAgent !== 'claude' && archiveAgent !== 'codex' && archiveAgent !== 'omp')) return");
    expect(src).toContain("hasArchive: Boolean(archiveKey && archivedKeys.has(archiveKey))");
  });

  it('never passes a workspace slug to readStamp — that matches nothing and silently voids hasArchive', () => {
    expect(src).not.toMatch(/readStamp\([^)]*workspaceId/);
  });

  it('forwards an exact numeric id so an old tracked row can escape the bounded recent window', () => {
    expect(src).toContain("const requestedId = Number(searchParams.get('id') ?? NaN)");
    expect(src).toContain('{ exactId }');
  });
});

describe('adv/sessions ensure-codex-home — legacy rows remain repairable', () => {
  const src = readFileSync(join(__dirname, 'sessions.ts'), 'utf8');

  it('falls back to the exact ADV session row when launch_spec is absent', () => {
    // The route now measures this read for repair-attempt diagnostics; keep the
    // guard focused on the exact row lookup rather than the instrumentation
    // wrapper around it.
    expect(src).toContain('getAdvSession(advSessionId)');
    expect(src).toContain('fallbackCodexLaunchSpecFromAdvSession(sessionRow, owner)');
  });

  it('surfaces that the repair used the bounded legacy-row fallback', () => {
    expect(src).toContain("recoveredFrom: 'adv-session-row'");
  });

  it('supplies a resolved model to the canonical writer for model-less legacy rows', () => {
    expect(src).toContain('const repairModel = requestedModel ? resolveCodexModel(requestedModel) : record.model ?? CODEX_DEFAULT_MODEL');
    expect(src).toContain('model: repairModel,');
    // Scope the negative to the legacy-repair region. The preserved-artifact
    // branch earlier in the handler legitimately passes `record.model` — it
    // refuses ('preserved-route-unavailable') before that point when the model
    // is missing, so it can never hand the writer a model-less row.
    const repairStart = src.indexOf('const repairModel =');
    expect(repairStart).toBeGreaterThan(-1);
    const nextExport = src.indexOf('\nexport ', repairStart);
    const repairRegion = src.slice(repairStart, nextExport === -1 ? undefined : nextExport);
    expect(repairRegion).not.toContain('model: record.model,');
  });
});
