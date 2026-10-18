/**
 * artifact-url-delivery-guard — falsifiability suite (EI-21844056581395228).
 *
 * The guard exists because a URL was twice reported to the owner as delivered
 * when no artifact existed. A guard that has never been shown to FAIL is a guard
 * nobody has tested, so this suite pins both directions:
 *   • it CATCHES the real incident string, and
 *   • it stays SILENT on a verified id, a quoted id, and a loop continuation.
 *
 * Per the repo's mutation-probe rule, falsifiability is proven with permanent
 * deliberately-wrong CONTROLS kept in this file — never by mutating the shared
 * tree, which git-sync can commit mid-probe.
 */
import { describe, it, expect } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  collectStrings,
  durableWriteStrings,
  evaluatePreToolUse,
  evaluateStop,
  extractArtifactIds,
  harvestLedgerIds,
  isArtifactTool,
  isDurableWriteTool,
  ledgerPathFor,
  lastAssistantText,
  normalizeToolName,
  stripQuotedForScanning,
} from '../artifact-url-delivery-guard.mjs';

const HOOK_SOURCE = fileURLToPath(new URL('../artifact-url-delivery-guard.mjs', import.meta.url));

/** The id from the real incident; it does not exist and never did. */
const PHANTOM = '04e509ec-1703-42fc-adeb-bb243f8794e7';
/** The real artifact published for the platform-to-app-data-producer plan. */
const REAL = 'c500b6d2-d039-49f1-8b3e-3e7819dd72d7';

const incidentText = `Design is ready for your review: **https://claude.ai/code/artifact/${PHANTOM}**`;

describe('detached installation', () => {
  it('loads without repository package resolution', () => {
    const dir = mkdtempSync(join(tmpdir(), 'artifact-url-guard-'));
    const detached = join(dir, 'artifact-url-delivery-guard.mjs');
    try {
      cpSync(HOOK_SOURCE, detached);
      cpSync(fileURLToPath(new URL('../pc_home.mjs', import.meta.url)), join(dir, 'pc_home.mjs'));
      const output = execFileSync(process.execPath, [
        '--input-type=module',
        '-e',
        `import(${JSON.stringify(pathToFileURL(detached).href)}).then((m) => console.log(typeof m.ledgerPathFor))`,
      ], { cwd: dir, env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8' }).trim();
      expect(output).toBe('function');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors PAPERCUSP_HOME when choosing the default ledger directory', () => {
    expect(ledgerPathFor('session-1', { PAPERCUSP_HOME: '/tmp/papercusp-test-home' })).toBe(
      '/tmp/papercusp-test-home/artifact-url-ledger/session-1.ids',
    );
  });

  it('denies an unverified plan URL, then allows it after the installed hook records verification', () => {
    const dir = mkdtempSync(join(tmpdir(), 'artifact-url-guard-cli-'));
    const detached = join(dir, 'artifact-url-delivery-guard.mjs');
    try {
      cpSync(HOOK_SOURCE, detached);
      cpSync(fileURLToPath(new URL('../pc_home.mjs', import.meta.url)), join(dir, 'pc_home.mjs'));
      const session = 'detached-regression';
      const env = { ...process.env, NODE_OPTIONS: '', PAPERCUSP_HOME: join(dir, 'home'), PAPERCUSP_ARTIFACT_LEDGER_DIR: '' };
      const run = (payload: object) => spawnSync(process.execPath, [detached], {
        cwd: dir, env, encoding: 'utf8', timeout: 5000,
        input: JSON.stringify({ session_id: session, ...payload }),
      });
      const plan = {
        hook_event_name: 'PreToolUse', tool_name: 'mcp__papercusp-su__plans_new',
        tool_input: { content: `Published: https://claude.ai/code/artifact/${REAL}` },
      };
      const denied = run(plan);
      expect(denied.status).toBe(0);
      expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
      expect(denied.stderr).toContain(REAL);

      const recorded = run({
        hook_event_name: 'PostToolUse', tool_name: 'Artifact',
        tool_response: { url: `https://claude.ai/code/artifact/${REAL}` },
      });
      expect(recorded.status).toBe(0);
      expect(recorded.stderr).toBe('');
      expect(readFileSync(join(env.PAPERCUSP_HOME, 'artifact-url-ledger', `${session}.ids`), 'utf8')).toContain(REAL);

      const allowed = run(plan);
      expect(allowed.status).toBe(0);
      expect(allowed.stderr).toBe('');
      expect(allowed.stdout).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the incident is caught', () => {
  it('blocks the exact message that was sent to the owner', () => {
    const verdict = evaluateStop({ text: incidentText, ledger: new Set(), stopHookActive: false });
    expect(verdict).not.toBeNull();
    expect(verdict!.unverified).toEqual([PHANTOM]);
    expect(verdict!.reason).toContain(PHANTOM);
    expect(verdict!.reason).toContain('EI-21844056581395228');
  });

  it('CONTROL: a guard that ignored the ledger would not catch it — proving the assertion has teeth', () => {
    // A no-op guard is what "the rail is in the prompt" amounted to. If this
    // control ever starts passing the real assertion above, the test is broken.
    const noOpGuard = () => null;
    expect(noOpGuard()).toBeNull();
    expect(evaluateStop({ text: incidentText, ledger: new Set(), stopHookActive: false })).not.toBeNull();
  });
});

describe('no false positives', () => {
  it('allows an id a real Artifact call returned this session', () => {
    expect(evaluateStop({ text: `Published: https://claude.ai/code/artifact/${REAL}`, ledger: new Set([REAL]), stopHookActive: false })).toBeNull();
  });

  it('allows a turn that cites no artifact URL at all', () => {
    expect(evaluateStop({ text: 'Closed the item; evidence is on the work-item.', ledger: new Set(), stopHookActive: false })).toBeNull();
  });

  it.each([
    ['inline code', `Never cite \`https://claude.ai/code/artifact/${PHANTOM}\` — it does not exist.`],
    ['a fenced block', `\`\`\`\nhttps://claude.ai/code/artifact/${PHANTOM}\n\`\`\``],
    ['a blockquote', `> https://claude.ai/code/artifact/${PHANTOM}`],
  ])('allows a known-bad URL quoted as %s', (_label, text) => {
    expect(evaluateStop({ text, ledger: new Set(), stopHookActive: false })).toBeNull();
  });

  it('CONTROL: without quote-stripping those same strings WOULD trip — the stripper is load-bearing', () => {
    const quoted = `Never cite \`https://claude.ai/code/artifact/${PHANTOM}\``;
    expect(extractArtifactIds(quoted)).toEqual([PHANTOM]); // present in the raw text
    expect(extractArtifactIds(stripQuotedForScanning(quoted))).toEqual([]); // removed before scanning
  });
});

describe('the loop guard cannot wedge a session', () => {
  it('stays silent on the continuation that follows its own block', () => {
    expect(evaluateStop({ text: incidentText, ledger: new Set(), stopHookActive: true })).toBeNull();
  });
});

describe('the ledger oracle', () => {
  it('harvests ids a successful call returned', () => {
    const ids = harvestLedgerIds({
      tool_name: 'Artifact',
      tool_response: { artifacts: [{ url: `https://claude.ai/code/artifact/${REAL}` }] },
    });
    expect(ids).toEqual([REAL]);
  });

  it('refuses to harvest from an ERROR response — a bad URL cannot verify itself', () => {
    // The dangerous case: reading a nonexistent artifact echoes the requested
    // URL back inside the failure. Harvesting that would let a phantom URL
    // launder itself into the ledger and defeat the whole guard.
    for (const response of [
      { is_error: true, content: `not found: https://claude.ai/code/artifact/${PHANTOM}` },
      { error: 'no such artifact', url: `https://claude.ai/code/artifact/${PHANTOM}` },
      { ok: false, url: `https://claude.ai/code/artifact/${PHANTOM}` },
    ]) {
      expect(harvestLedgerIds({ tool_name: 'Artifact', tool_response: response })).toEqual([]);
    }
  });

  it('ignores an id that appears only in the REQUEST', () => {
    // An id the agent asserted is exactly the unverified thing being guarded.
    const ids = harvestLedgerIds({
      tool_name: 'Artifact',
      tool_input: { url: `https://claude.ai/code/artifact/${PHANTOM}` },
      tool_response: { ok: true, artifacts: [] },
    });
    expect(ids).toEqual([]);
  });

  it('ignores non-Artifact tools', () => {
    expect(harvestLedgerIds({ tool_name: 'Write', tool_response: { url: `https://claude.ai/code/artifact/${REAL}` } })).toEqual([]);
    expect(isArtifactTool('Artifact')).toBe(true);
    expect(isArtifactTool('mcp__papercusp-su__artifact')).toBe(true);
    expect(isArtifactTool('Write')).toBe(false);
  });
});

describe('transcript extraction', () => {
  const line = (obj: unknown) => JSON.stringify(obj);

  it('returns the most recent assistant TEXT, skipping tool-only turns', () => {
    const transcript = [
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'older turn' }] } }),
      line({ type: 'user', message: { content: 'a prompt' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: incidentText }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
    ].join('\n');
    const read = () => transcript;
    expect(lastAssistantText('/fake', read as never)).toBe(incidentText);
  });

  it('fails open to an empty string when the transcript is unreadable', () => {
    const read = () => {
      throw new Error('ENOENT');
    };
    expect(lastAssistantText('/missing', read as never)).toBe('');
    expect(lastAssistantText('', read as never)).toBe('');
  });
});

/**
 * The DURABLE-SURFACE arm (EI-21890940999877469). The first occurrence
 * (EI-19944806095285549) never reached prose at all — the dead URL went into a
 * work-item checkpoint and was inherited as fact — so the Stop branch above could
 * not have caught it. These pin the arm that can.
 */
describe('durable surfaces are guarded', () => {
  it('blocks the FIRST occurrence shape: a work-item checkpoint carrying a phantom URL', () => {
    const verdict = evaluatePreToolUse({
      toolName: 'mcp__papercusp-su__work_items_checkpoint',
      toolInput: {
        id: 'WI-37110',
        checkpoint: `Report delivered.\nArtifact: https://claude.ai/code/artifact/${PHANTOM}\nSource: /home/x/report.html`,
      },
      ledger: new Set(),
    });
    expect(verdict).not.toBeNull();
    expect(verdict!.unverified).toEqual([PHANTOM]);
    expect(verdict!.reason).toContain('EI-19944806095285549');
  });

  it('blocks the other durable surfaces, not just checkpoints', () => {
    for (const toolName of [
      'mcp__papercusp-su__loop_checkpoint',
      'mcp__papercusp-su__facts_assert',
      'mcp__papercusp-su__coord_send',
      'mcp__papercusp-su__plans_add-decision',
      'mcp__papercusp-su__work_items_complete',
    ]) {
      const verdict = evaluatePreToolUse({
        toolName,
        toolInput: { body: `see https://claude.ai/code/artifact/${PHANTOM}` },
        ledger: new Set(),
      });
      expect(verdict, `${toolName} should be guarded`).not.toBeNull();
    }
  });

  it('finds a URL NESTED deep inside a structured completion payload', () => {
    // work_items:complete nests evidence several levels down; a scanner that only
    // looked at top-level strings would sail straight past the real vector.
    const verdict = evaluatePreToolUse({
      toolName: 'mcp__papercusp-su__work_items_complete',
      toolInput: {
        id: 'WI-1',
        completion: {
          summary: 'done',
          verification: { coverage: { residue: [`published at https://claude.ai/code/artifact/${PHANTOM}`] } },
        },
      },
      ledger: new Set(),
    });
    expect(verdict).not.toBeNull();
    expect(verdict!.unverified).toEqual([PHANTOM]);
  });

  it('plans:edit scans only new_string, so removing or quoting an old URL is allowed', () => {
    const oldUrl = `https://claude.ai/code/artifact/${PHANTOM}`;

    expect(
      evaluatePreToolUse({
        toolName: 'mcp__papercusp-su__plans_edit',
        toolInput: { slug: 'plan', old_string: `Dead URL: ${oldUrl}`, new_string: 'Durable source: /repo/report.md' },
        ledger: new Set(),
      }),
    ).toBeNull();

    expect(
      evaluatePreToolUse({
        toolName: 'mcp__papercusp-su__plans_edit',
        toolInput: { slug: 'plan', old_string: 'old text', new_string: `Post-mortem: \`${oldUrl}\`` },
        ledger: new Set(),
      }),
    ).toBeNull();

    const introduced = evaluatePreToolUse({
      toolName: 'mcp__papercusp-su__plans_edit',
      toolInput: { slug: 'plan', old_string: 'old text', new_string: `Delivered: ${oldUrl}` },
      ledger: new Set(),
    });
    expect(introduced).not.toBeNull();
    expect(introduced!.unverified).toEqual([PHANTOM]);
    expect(durableWriteStrings('mcp__papercusp-su__plans_edit', { old_string: oldUrl, new_string: 'replacement' })).toEqual([
      'replacement',
    ]);
  });

  it('CONTROL: a top-level-only scanner misses that nested case — the assertion above has teeth', () => {
    const topLevelOnlyScanner = (input: Record<string, unknown>) =>
      extractArtifactIds(Object.values(input).filter((v): v is string => typeof v === 'string').join('\n'));
    const nested = {
      id: 'WI-1',
      completion: { verification: { coverage: { residue: [`https://claude.ai/code/artifact/${PHANTOM}`] } } },
    };
    expect(topLevelOnlyScanner(nested)).toEqual([]); // the wrong implementation
    expect(collectStrings(nested).join('\n')).toContain(PHANTOM); // ours
  });
});

describe('the durable arm never denies its own remedy', () => {
  // The block message tells the agent to VERIFY the URL. If the guard also denied
  // the verifying call, a blocked agent would have no way out — a trap, not a guard.
  it('never blocks the Artifact tool, even reading the phantom URL itself', () => {
    for (const toolName of ['Artifact', 'mcp__papercusp-su__artifact']) {
      expect(isDurableWriteTool(toolName)).toBe(false);
      expect(
        evaluatePreToolUse({
          toolName,
          toolInput: { action: 'read', url: `https://claude.ai/code/artifact/${PHANTOM}` },
          ledger: new Set(),
        }),
      ).toBeNull();
    }
  });

  it('never blocks WebFetch or an ordinary read tool', () => {
    for (const toolName of ['WebFetch', 'mcp__papercusp-su__work_items_get', 'Read', 'Bash']) {
      expect(
        evaluatePreToolUse({
          toolName,
          toolInput: { url: `https://claude.ai/code/artifact/${PHANTOM}` },
          ledger: new Set(),
        }),
      ).toBeNull();
    }
  });
});

describe('durable arm: no false positives', () => {
  it('allows a verified id', () => {
    expect(
      evaluatePreToolUse({
        toolName: 'mcp__papercusp-su__work_items_checkpoint',
        toolInput: { checkpoint: `https://claude.ai/code/artifact/${REAL}` },
        ledger: new Set([REAL]),
      }),
    ).toBeNull();
  });

  it('allows a QUOTED known-bad URL, so a post-mortem can be written', () => {
    // This very suite, and the work-items describing the incident, must remain writable.
    expect(
      evaluatePreToolUse({
        toolName: 'mcp__papercusp-su__improvements_capture',
        toolInput: { body: `The dead URL was \`https://claude.ai/code/artifact/${PHANTOM}\` — never existed.` },
        ledger: new Set(),
      }),
    ).toBeNull();
  });

  it('allows a durable write that cites no artifact URL at all', () => {
    expect(
      evaluatePreToolUse({
        toolName: 'mcp__papercusp-su__facts_assert',
        toolInput: { key: 'k', body: 'An ordinary conclusion with no links.' },
        ledger: new Set(),
      }),
    ).toBeNull();
  });
});

describe('tool-name normalization', () => {
  it('treats the colon form and the client-mangled form as the same tool', () => {
    expect(normalizeToolName('work_items:checkpoint')).toBe('work_items_checkpoint');
    expect(normalizeToolName('mcp__papercusp-su__work_items_checkpoint')).toBe('work_items_checkpoint');
    expect(isDurableWriteTool('work_items:checkpoint')).toBe(true);
    expect(isDurableWriteTool('mcp__papercusp-su__work_items_checkpoint')).toBe(true);
  });

  it('preserves hyphenated verbs, which the client does not mangle', () => {
    expect(normalizeToolName('mcp__papercusp-su__plans_add-decision')).toBe('plans_add-decision');
    expect(isDurableWriteTool('plans:add-decision')).toBe(true);
  });
});
