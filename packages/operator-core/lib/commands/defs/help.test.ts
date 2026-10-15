/**
 * help.* defs — report.problem opens the Report a problem dialog by setting the
 * nuqs `report` param on the current page (unified-bug-pipeline P-014, D-048 pt 1).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { get as getCommand } from '../registry';
import { reportProblemHref } from './help';

describe('reportProblemHref', () => {
  it('adds report=true and keeps the path, other params and hash', () => {
    expect(reportProblemHref('http://127.0.0.1:3055/harness?ws=papercusp-workspace&tab=plans#top')).toBe(
      '/harness?ws=papercusp-workspace&tab=plans&report=true#top',
    );
  });

  it('works on a page with no params', () => {
    expect(reportProblemHref('tauri://localhost/settings')).toBe('/settings?report=true');
  });

  it('does not duplicate an existing report param', () => {
    expect(reportProblemHref('http://x/notes?report=false')).toBe('/notes?report=true');
  });
});

describe('report.problem registration', () => {
  it('keeps the operator voice catalog aligned with registered browser commands', () => {
    const checker = fileURLToPath(new URL('../../../../../apps/operator/scripts/el-tools-check.mjs', import.meta.url));
    const output = execFileSync(process.execPath, [checker, '--strict'], {
      encoding: 'utf8', timeout: 10_000,
    });
    expect(output).toContain('aligned');
  });

  it('is a palette command in the Help section, reachable from the shortcut', () => {
    const def = getCommand('report.problem');
    if (!def || def.kind !== 'command') throw new Error(`report.problem is not a registered command (got ${def?.kind})`);
    expect(def.agents).toEqual(expect.arrayContaining(['palette', 'shortcut', 'operator']));
    expect(def.paletteEntry).toMatchObject({ section: 'Help', title: 'Report a problem' });
    expect(def.schema.safeParse({}).success).toBe(true);
    expect(def.schema.safeParse({ extra: 1 }).success).toBe(false);
  });
});
