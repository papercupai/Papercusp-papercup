/**
 * capability:bash search guidance regression for EI-21133502363929449.
 *
 * A repository-root `rg --hidden` search traverses generated public docs and
 * per-checkout `.papercusp/` artifacts; the rendered snapshots can overwhelm
 * the caller before the source matches are useful. Keep the actionable
 * source-root/exclusion rule in the tool guidance, backed by the shared
 * code-intelligence contract.
 */
import { describe, expect, it } from 'vitest';
import bashTool, { detectUnboundedGitHistorySearch, formatUnboundedGitHistorySearchAdvice } from './bash';
import { RIPGREP_SCOPE_GUIDANCE } from '../../code-intelligence/contracts.ts';
import { BUDGET, promptWeight } from '../tool-guidance-budget';

type GuidanceTool = {
  description?: string;
  guidance?: {
    when?: string;
    notWhen?: string;
    seeAlso?: string[];
  };
  handler?: (args: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  args?: { shape?: Record<string, { description?: string }> };
};

describe('capability:bash — repository search scope guidance', () => {
  it('warns against generated snapshots and names bounded source roots', () => {
    const guidance = (bashTool as unknown as GuidanceTool).guidance?.when ?? '';

    expect(guidance).toContain(RIPGREP_SCOPE_GUIDANCE);
    expect(guidance).toContain('Probe `rg` in the target shell');
    expect(guidance).toContain('`command -v rg >/dev/null 2>&1`');
    expect(guidance).toContain('client-private binaries may not be inherited');
    expect(guidance).toContain('prefer ripgrep (`rg`)');
    expect(guidance).toContain('`grep`/`grep -E`');
    // EI-21721580537629688: ripgrep's uppercase -E is --encoding, not the
    // regexp flag. Keep the distinction in the agent-facing shared guidance.
    expect(guidance).toContain('In `rg`, use lowercase `-e`/`--regexp`');
    expect(guidance).toContain('uppercase `-E` means `--encoding`');
    expect(guidance).toContain('or `grep -F`');
    expect(guidance).toContain('Apostrophes break single-quoted regexes');
    expect(guidance).toContain('`-e`');
    expect(guidance).toContain('quoted input');
    expect(guidance).toContain('apps/operator/lib');
    expect(guidance).toContain('packages/operator-core/lib');
    expect(guidance).toContain('.papercusp');
    expect(guidance).toContain('apps/operator/public/internal/docs');
    expect(guidance).toContain('Do not run an unbounded search from the repository root');
    // EI-22554535465849178: `head` can close a pipe while rg is still writing;
    // under pipefail that turns useful bounded output into exit 141. Keep the
    // bound on rg itself and make the unsafe form fail this regression test.
    expect(guidance).toContain('--max-columns 256 --max-columns-preview');
    expect(guidance).toContain('`rg --max-count 60 --max-columns 256 --max-columns-preview ...`');
    expect(guidance).toContain('avoid piping to early-exit consumers such as `head` under `pipefail`');
    expect(guidance).toContain('SIGPIPE `rg` (exit 141)');
    expect(guidance).not.toContain('| head');
    expect(guidance).toContain('Bound git history scans');
    expect(guidance).toContain('unbounded refused');

    // EI-21603394979563992: the optional jq tip is intentionally kept out of the
    // prompt (see bash.ts) so this guidance stays within the shared soft budget.
    expect(promptWeight(bashTool as Parameters<typeof promptWeight>[0])).toBeLessThanOrEqual(BUDGET);
  });

  it('routes service-log searches through server-side filtering', () => {
    const tool = bashTool as unknown as GuidanceTool;
    const related = tool.guidance?.seeAlso?.join(' ') ?? '';

    expect(related).toContain('logs:read { unit, since, grep, limit }');
    expect(related).toContain('filters inside journalctl');
  });

  it('documents when bash jobs need explicit work-item attribution', () => {
    const description = (bashTool as unknown as GuidanceTool).args?.shape?.work_item_id?.description ?? '';

    expect(description).toContain('Required when you hold multiple work-items');
    expect(description).toContain('held-item attribution cannot be measured');
    expect(description).toContain('name one you currently hold');
  });

  it('detects the reported unbounded all-ref pickaxe search but permits bounded or focused forms', () => {
    const reported = detectUnboundedGitHistorySearch('git log --all --oneline -Sexplicit-full-request-overflow -- .');
    expect(reported).toMatchObject({
      selectors: expect.arrayContaining(['--all', '-Sexplicit-full-request-overflow']),
    });
    expect(formatUnboundedGitHistorySearchAdvice(reported!)).toContain('Add -n/--max-count');

    expect(
      detectUnboundedGitHistorySearch('git log --all --oneline -n 100 -Sexplicit-full-request-overflow -- .'),
    ).toBeNull();
    expect(
      detectUnboundedGitHistorySearch(
        'git log -Sexplicit-full-request-overflow -- packages/operator-core/lib/agent-tools/capability/bash.ts',
      ),
    ).toBeNull();
  });

  it.each([false, true])('refuses the unbounded history search before %s launch', async (run_in_background) => {
    const tool = bashTool as unknown as GuidanceTool;
    const result = await tool.handler?.(
      {
        command: 'git log --all --oneline -Sexplicit-full-request-overflow -- .',
        cwd: process.cwd(),
        ...(run_in_background ? { run_in_background: true } : {}),
      },
      {
        projectDir: process.cwd(),
        stateDir: process.cwd(),
        signal: new AbortController().signal,
        emit: () => {},
        role: 'cup',
      },
    );
    expect(result?.isError).toBe(true);
    expect(JSON.parse(result!.content[0]!.text)).toMatchObject({ ok: false, reason: 'unbounded_git_history' });
  });
});
