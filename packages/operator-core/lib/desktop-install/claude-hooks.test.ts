import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mergeClaudeHookSettings } from './papercusp-files';

// mergeClaudeHookSettings is the TS port of install-standalone-mcp.sh's merge_* helpers
// (EI-8191 — make the Claude statusline + CC hooks install on the packaged Mac/Windows apps).
// It merges non-destructively + idempotently into a Claude settings.json object.

const DEST = '/home/u/.papercusp/hooks/cc';
const cmd = (entry: any) => entry.hooks[0].command as string;
const commandsFor = (cfg: any, event: string): string[] =>
  (cfg.hooks?.[event] ?? []).map((e: any) => cmd(e));
// Resolve a hook BY COMMAND NAME, never by array index — the PostToolUse block below is the
// worked example of why (a green assertion left pointing at the wrong hook after an insertion).
// It THROWS on an unregistered hook deliberately: a bare `find(...)?.matcher` answers
// `undefined` both for "registered with no matcher" and for "not registered at all", which
// would let every `toBeUndefined()` assertion here pass vacuously against a DELETED hook —
// weaker than the index form it replaces, which at least threw on a short list.
const hookEntryFor = (cfg: any, event: string, name: string) => {
  const entry = (cfg.hooks?.[event] ?? []).find((e: any) => cmd(e) === `${DEST}/${name}`);
  if (!entry) throw new Error(`hook ${name} is not registered on ${event}`);
  return entry;
};
const hookMatcherOf = (cfg: any, event: string, name: string): string | undefined =>
  hookEntryFor(cfg, event, name).matcher;
const FILE_WRITE_MATCHER = 'Edit|Write|MultiEdit|mcp__.*__capability_(edit|write|multi_?edit)';
const BASH_SHELL_MATCHER = 'Bash|mcp__.*__capability_bash';
const FILE_EDIT_MATCHER = 'Edit|MultiEdit|mcp__.*__capability_(edit|multi_?edit)';
const FILE_OVERWRITE_MATCHER = 'Write|mcp__.*__capability_write';
const MDX_NUDGE_MATCHER = 'Edit|Write|MultiEdit|docs:author|mcp__.*__docs[_:-]author';

describe('mergeClaudeHookSettings — full install into empty settings', () => {
  it('retires old standalone strand delivery entries during upgrade and preserves foreign hooks', () => {
    const foreign = { matcher: 'Edit', hooks: [{ type: 'command', command: '/custom/check.sh' }] };
    const cfg: any = { hooks: { PostToolUse: [foreign, ...[
      'posttooluse-required-field-strand-nudge.mjs', 'posttooluse-behavioural-strand-nudge.mjs',
    ].map(name => ({ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: `${DEST}/${name}` }] }))] } };
    const opts = { present: new Set<string>(), isClaudeSettings: true };
    mergeClaudeHookSettings(cfg, DEST, opts);
    expect(cfg.hooks.PostToolUse).toEqual([foreign]);
    mergeClaudeHookSettings(cfg, DEST, opts);
    expect(cfg.hooks.PostToolUse).toEqual([foreign]);
  });

  it('registers every CC hook on its correct event(s) + the statusline', () => {
    const cfg = mergeClaudeHookSettings({}, DEST, { isClaudeSettings: true });

    // PreToolUse: lock-acquire (Edit|Write|MultiEdit) + activity-pre (*) + bash-gate (Bash)
    // + plans-read-guard (Read|Grep, P-003(b)) + artifact-url-delivery-guard
    // (durable-write verbs, EI-21890940999877469 — denies a checkpoint/plan/fact
    // carrying an artifact id no Artifact call returned) + ask-gate-mirror
    // (AskUserQuestion|ExitPlanMode, owner-inbox-single-pane P-001) + guard-operator-desktop
    // (browser-navigation MCP tools + Skill, EI-16981) + content-lint (Edit|Write|MultiEdit,
    // P-013, wired WI-5543) + secrets-guard (Edit|Write|MultiEdit, wired WI-5542) +
    // nul-byte-edit-guard (Edit|MultiEdit, EI-18896033546676518) +
    // control-bytes-content-guard (Edit|Write|MultiEdit, EI-20782070131658758) +
    // tool-prompt-weight-guard (Edit|Write|MultiEdit, EI-20204186116417704) +
    // schedule-wakeup-provenance (ScheduleWakeup, EI-18680056073436345) +
    // write-overwrite-guard (Write, EI-19966323166806405) + generated-file-edit-guard
    // (Edit|Write|MultiEdit, claude-md-projection-from-pg-2026-08-10 P-006) +
    // unreserved-migration-guard (Edit|Write|MultiEdit, WI-38352) + identity-guard
    // (every tool, portable-identity-packages P-011), in install order.
    expect(
      commandsFor(cfg, 'PreToolUse').filter(
        (command) => command !== DEST + '/posttooluse-resource-governor-nudge.mjs',
      ),
    ).toEqual([
      `${DEST}/pretooluse-locks-acquire.sh`,
      `${DEST}/pretooluse-activity-report.sh`,
      `${DEST}/pretooluse-bash-resource-gate.sh`,
      `${DEST}/pretooluse-plans-read-guard.sh`,
      `${DEST}/pretooluse-identity-guard.sh`,
      `${DEST}/artifact-url-delivery-guard.mjs`,
      `${DEST}/ask-gate-mirror.sh`,
      `${DEST}/guard-operator-desktop.mjs`,
      `${DEST}/pretooluse-content-lint.mjs`,
      `${DEST}/pretooluse-secrets-guard.mjs`,
      `${DEST}/pretooluse-restricted-egress-guard.mjs`,
      `${DEST}/pretooluse-nul-byte-edit-guard.mjs`,
      `${DEST}/pretooluse-control-bytes-content-guard.mjs`,
      `${DEST}/pretooluse-tool-prompt-weight-guard.mjs`,
      `${DEST}/pretooluse-schedule-wakeup-provenance.mjs`,
      `${DEST}/pretooluse-write-overwrite-guard.mjs`,
      `${DEST}/pretooluse-generated-file-edit-guard.mjs`,
      `${DEST}/pretooluse-unreserved-migration-guard.mjs`,
    ]);
    // Matchers are asserted BY COMMAND NAME, not by array index. The index form silently
    // re-pointed every assertion below the insertion point whenever a hook was added — the
    // reviewer sees a green suite and an unrelated-looking renumber diff, so a genuinely
    // wrong matcher rides in unnoticed. (The `toEqual` above still pins install ORDER, which
    // is the part that carries meaning: hooks fire in registration order.)
    const matcherOf = (name: string): string | undefined => hookMatcherOf(cfg, 'PreToolUse', name);
    // P-007 / BAR R-11: the client-native egress tools — capability:bash is gated server-side.
    // WI-10005589 / D-012: plus edits of agent runtime files and every non-Papercusp MCP tool.
    expect(matcherOf('pretooluse-restricted-egress-guard.mjs')).toBe(
      'Bash|WebFetch|Edit|Write|MultiEdit|NotebookEdit|mcp__(?!papercusp).*',
    );

    expect(matcherOf('pretooluse-locks-acquire.sh')).toBe(FILE_WRITE_MATCHER);
    expect(matcherOf('pretooluse-activity-report.sh')).toBe('*');
    // EI-21971958067151594 — must cover the MCP shell too, not just native Bash.
    // WI-38363 widened the FILE writers to `mcp__.*__capability_*` and left this
    // one native-only, so every deny in the 5.8k-line gate (tauri target guard,
    // pkill, destructive-git, the scheduler lockout) was bypassable by spelling
    // the command through `capability:bash`. Measured 2026-08-31: the same
    // `tauri-agent-tools dom` was DENIED as Bash and RAN as capability:bash.
    expect(matcherOf('pretooluse-bash-resource-gate.sh')).toBe(BASH_SHELL_MATCHER);
    expect(BASH_SHELL_MATCHER).toMatch(/capability_bash/);
    expect(matcherOf('pretooluse-plans-read-guard.sh')).toBe('Read|Grep');
    // P-011 (D-023 §2): matcher-less, because which tools a worn guard names is
    // the operator's business. Safe only because it renders a deny or nothing.
    expect(matcherOf('pretooluse-identity-guard.sh')).toBeUndefined();

    // EI-21890940999877469 — the durable-write allow-list mirror. The assertions
    // that carry the weight are the NEGATIVE ones: this matcher must never grow to
    // cover the Artifact tool or WebFetch. The guard's own block message tells the
    // agent to verify the URL with exactly those calls, so denying them would turn
    // the guard into a trap with no exit rather than a guard.
    const artifactGuard = new RegExp(matcherOf('artifact-url-delivery-guard.mjs')!);
    expect(artifactGuard.test('mcp__papercusp-su__work_items_checkpoint')).toBe(true);
    expect(artifactGuard.test('mcp__papercusp-su__loop_checkpoint')).toBe(true);
    expect(artifactGuard.test('mcp__papercusp-su__plans_add-decision')).toBe(true);
    expect(artifactGuard.test('Artifact')).toBe(false);
    expect(artifactGuard.test('mcp__papercusp-su__artifact')).toBe(false);
    expect(artifactGuard.test('WebFetch')).toBe(false);
    expect(matcherOf('ask-gate-mirror.sh')).toBe('AskUserQuestion|ExitPlanMode');
    expect(matcherOf('guard-operator-desktop.mjs')).toBe(
      'mcp__playwright__browser_navigate|mcp__claude-in-chrome__navigate|mcp__claude-in-chrome__tabs_create_mcp|Skill',
    );
    expect(matcherOf('pretooluse-content-lint.mjs')).toBe(FILE_WRITE_MATCHER);
    expect(matcherOf('pretooluse-secrets-guard.mjs')).toBe(FILE_WRITE_MATCHER);
    expect(matcherOf('pretooluse-nul-byte-edit-guard.mjs')).toBe(FILE_EDIT_MATCHER);
    // EI-20782070131658758: Write MUST be in this matcher. Its sibling directly above is
    // Edit-only by design, so registering this one on FILE_EDIT_MATCHER would reopen the
    // exact reported hole (a `Write` of NUL-bearing content) while still looking wired.
    expect(matcherOf('pretooluse-control-bytes-content-guard.mjs')).toBe(FILE_WRITE_MATCHER);
    expect(matcherOf('pretooluse-control-bytes-content-guard.mjs')).toContain('Write');
    expect(matcherOf('pretooluse-tool-prompt-weight-guard.mjs')).toBe(FILE_WRITE_MATCHER);
    expect(matcherOf('pretooluse-schedule-wakeup-provenance.mjs')).toBe('ScheduleWakeup');
    expect(matcherOf('pretooluse-write-overwrite-guard.mjs')).toBe(FILE_OVERWRITE_MATCHER);
    expect(matcherOf('pretooluse-generated-file-edit-guard.mjs')).toBe(FILE_WRITE_MATCHER);
    expect(matcherOf('pretooluse-unreserved-migration-guard.mjs')).toBe(FILE_WRITE_MATCHER);
    expect(matcherOf('posttooluse-resource-governor-nudge.mjs')).toBe('Edit|Write|MultiEdit');
    expect(commandsFor(cfg, 'PreToolUse')[2]).toBe(DEST + '/posttooluse-resource-governor-nudge.mjs');

    // PostToolBatch: complete native edit-batch lock release first, then the
    // mid-turn context push (context-injection-audit-2026-07-28 P-015).
    // ⚠ It lives HERE and not on PreToolUse deliberately (D-027) — PreToolUse only
    // injects additionalContext alongside a permissionDecision, and a context hook
    // emitting 'allow' would blanket auto-approve everything it matched. If a future
    // change moves this back to PreToolUse, it will silently inject nothing.
    expect(commandsFor(cfg, 'PostToolBatch')).toEqual([
      `${DEST}/posttoolbatch-locks-release.sh`,
      `${DEST}/posttoolbatch-midturn-context.sh`,
    ]);
    expect(cfg.hooks.PostToolBatch.every((entry: any) => entry.matcher === undefined)).toBe(true);

    // PostToolUse: lock-release + activity (coord-folding, EI-11405) + byte-integrity guard +
    // workitem-nudge +
    // required-field-strand nudge (EI-19374535041074908) +
    // behavioural-strand nudge (EI-20022235111425919) + ts-parse nudge
    // (EI-19457231269012320) + MDX nudge (EI-19450114644493388) +
    // no-proc-path-fixture nudge (EI-19968483416347685) +
    // migration-fixture-drift nudge (EI-19359711978838614) +
    // migration-forward-compat nudge (EI-19462877357083817) + tool-prompt-weight nudge
    // (EI-19459260956682226) + mock-cast-escape nudge (WI-37497) + css-design-primitives
    // nudge (EI-20023819609804890) + frozen-candidate-edit nudge (WI-40081) +
    // registry-census-drift nudge (EI-19401978567233485) +
    // cli-entry nudge (EI-22085994981415983) +
    // tsc-verdict-stale nudge (WI-2141194) +
    // ask-gate-mirror (in install order). The separate
    // coord-inbox entry is retired — merged into activity.
    expect(commandsFor(cfg, 'PostToolUse')).toEqual([
      `${DEST}/posttooluse-locks-release.sh`,
      `${DEST}/posttooluse-activity-report.sh`,
      `${DEST}/posttooluse-write-byte-integrity-guard.mjs`,
      `${DEST}/posttooluse-su-instance-override-reseed.mjs`,
      `${DEST}/workitem-verify-nudge.sh`,
      `${DEST}/posttooluse-ts-parse-nudge.mjs`,
      `${DEST}/posttooluse-mdx-nudge.mjs`,
      `${DEST}/posttooluse-launch-prose-budget-nudge.mjs`,
      `${DEST}/posttooluse-no-proc-path-fixture-nudge.mjs`,
      `${DEST}/posttooluse-migration-fixture-drift-nudge.mjs`,
      `${DEST}/posttooluse-migration-forward-compat-nudge.mjs`,
      `${DEST}/posttooluse-tool-prompt-weight-nudge.mjs`,
      `${DEST}/posttooluse-mock-cast-escape-nudge.mjs`,
      `${DEST}/posttooluse-css-design-primitives-nudge.mjs`,
      `${DEST}/posttooluse-frozen-candidate-edit-nudge.mjs`,
      `${DEST}/posttooluse-registry-census-drift-nudge.mjs`,
      `${DEST}/posttooluse-cli-entry-nudge.mjs`,
      `${DEST}/posttooluse-resource-governor-nudge.mjs`,
      `${DEST}/posttooluse-tsc-verdict-stale-nudge.mjs`,
      `${DEST}/posttooluse-proof-stale-nudge.mjs`,
      `${DEST}/artifact-url-delivery-guard.mjs`,
      `${DEST}/ask-gate-mirror.sh`,
    ]);
    // Asserted BY COMMAND NAME, not by array index — same reasoning as PreToolUse above, and
    // this block is why that reasoning is not hypothetical. Registering the registry-census-drift
    // nudge (EI-19401978567233485) between css-design-primitives and the artifact guard
    // re-pointed every index below the insertion: the new `[12]` assertion PASSED while naming a
    // hook it was no longer looking at, and only the Artifact matcher two rows down failed. A
    // green assertion pointing at the wrong subject is the exact failure the index form keeps
    // producing, so the fix is the by-name form rather than another renumber.
    const postMatcherOf = (name: string): string | undefined =>
      hookMatcherOf(cfg, 'PostToolUse', name);

    expect(postMatcherOf('posttooluse-activity-report.sh')).toBe('*'); // activity (+ coord fold)
    expect(postMatcherOf('posttooluse-locks-release.sh')).toBe(FILE_WRITE_MATCHER); // mirrors acquire
    expect(postMatcherOf('posttooluse-write-byte-integrity-guard.mjs')).toBe(FILE_OVERWRITE_MATCHER);
    expect(postMatcherOf('posttooluse-su-instance-override-reseed.mjs')).toBe(FILE_WRITE_MATCHER);
    // Previously unasserted: under the index form `[3] // strand nudge` was in fact reading THIS
    // hook, so the strand nudge itself had no assertion at all. Both happen to carry the same
    // matcher, which is why the mislabel stayed green — the by-name form makes the gap visible.
    expect(postMatcherOf('workitem-verify-nudge.sh')).toBe('Edit|Write|MultiEdit');
    // P-037 delivers both analyses through the shared injector. Assert absence
    // directly; the matcher helper deliberately throws for an absent hook.
    expect(commandsFor(cfg, 'PostToolUse')).not.toContain(`${DEST}/posttooluse-required-field-strand-nudge.mjs`);
    expect(commandsFor(cfg, 'PostToolUse')).not.toContain(`${DEST}/posttooluse-behavioural-strand-nudge.mjs`);
    expect(postMatcherOf('posttooluse-ts-parse-nudge.mjs')).toBe('Edit|Write|MultiEdit');
    expect(postMatcherOf('posttooluse-mdx-nudge.mjs')).toBe(MDX_NUDGE_MATCHER);
    const launchProseMatcher = new RegExp(postMatcherOf('posttooluse-launch-prose-budget-nudge.mjs')!);
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'apply_patch', 'Bash', 'exec_command', 'shell_command', 'capability:edit', 'capability:patch', 'capability:bash', 'tools:invoke', 'mcp__papercusp_su__capability_bash', 'mcp__papercusp_su__capability_patch', 'mcp__papercusp_su__tools_invoke']) {
      expect(launchProseMatcher.test(tool), tool).toBe(true);
    }
    expect(launchProseMatcher.test('Read')).toBe(false);
    const mdxMatcher = new RegExp(MDX_NUDGE_MATCHER);
    expect(mdxMatcher.test('docs:author')).toBe(true);
    expect(mdxMatcher.test('mcp__papercusp-su__docs_author')).toBe(true);
    expect(mdxMatcher.test('mcp__papercusp-su__docs-author')).toBe(true);
    expect(mdxMatcher.test('mcp__papercusp-su__docs_get')).toBe(false);
    expect(postMatcherOf('posttooluse-no-proc-path-fixture-nudge.mjs')).toBe('Edit|Write|MultiEdit');
    expect(postMatcherOf('posttooluse-migration-fixture-drift-nudge.mjs')).toBe('Edit|Write|MultiEdit');
    expect(postMatcherOf('posttooluse-migration-forward-compat-nudge.mjs')).toBe('Edit|Write|MultiEdit');
    expect(postMatcherOf('posttooluse-tool-prompt-weight-nudge.mjs')).toBe('Edit|Write|MultiEdit');
    expect(postMatcherOf('posttooluse-mock-cast-escape-nudge.mjs')).toBe('Edit|Write|MultiEdit');
    expect(postMatcherOf('posttooluse-css-design-primitives-nudge.mjs')).toBe('Edit|Write|MultiEdit');
    const frozenEditMatcher = postMatcherOf('posttooluse-frozen-candidate-edit-nudge.mjs')!;
    expect(frozenEditMatcher).toBe(
      FILE_WRITE_MATCHER + '|mcp__.*__capability_patch|mcp__.*__tools_invoke',
    );
    expect(new RegExp(frozenEditMatcher).test('mcp__papercusp-su__capability_patch')).toBe(true);
    expect(new RegExp(frozenEditMatcher).test('mcp__papercusp-su__tools_invoke')).toBe(true);
    expect(postMatcherOf('posttooluse-registry-census-drift-nudge.mjs')).toBe('Edit|Write|MultiEdit');
    expect(postMatcherOf('posttooluse-cli-entry-nudge.mjs')).toBe('Edit|Write|MultiEdit');
    expect(postMatcherOf('posttooluse-resource-governor-nudge.mjs')).toBe('Edit|Write|MultiEdit');
    // EI-21844056581395228: the ledger half of the artifact-URL delivery guard. It is
    // scoped to the Artifact tool because it only harvests ids from that tool's own
    // responses; the blocking half is matcher-less on Stop (assistant prose is not a
    // tool call, so no matcher can reach it).
    expect(postMatcherOf('artifact-url-delivery-guard.mjs')).toBe('Artifact|mcp__.*__[Aa]rtifact');
    expect(postMatcherOf('ask-gate-mirror.sh')).toBe('AskUserQuestion|ExitPlanMode');

    // Session events + Stop.
    expect(commandsFor(cfg, 'SessionStart')).toEqual([
      `${DEST}/lifecycle-report.sh`,
      `${DEST}/sessionstart-identity-context.sh`,
    ]);
    // A resume replays a transcript that already holds what the compaction rules said.
    expect(hookMatcherOf(cfg, 'SessionStart', 'sessionstart-identity-context.sh')).toBe('startup|clear|compact');
    expect(commandsFor(cfg, 'SessionEnd')).toEqual([
      `${DEST}/lifecycle-report.sh`,
      `${DEST}/workitem-verify-nudge.sh`,
    ]);
    // Stop: work-item nudge + per-turn journal ping (deterministic-context-carry P-012)
    // + the ask-gate-mirror bounce/mirror (owner-inbox-single-pane P-001)
    // + the owner-directive turn-end check (owner-directive-delivery-redesign P-007)
    // + the worn identity's stop rules (portable-identity-packages P-011).
    expect(commandsFor(cfg, 'Stop')).toEqual([
      `${DEST}/workitem-verify-nudge.sh`,
      `${DEST}/stop-identity-context.sh`,
      `${DEST}/stop-turn-journal.sh`,
      `${DEST}/artifact-url-delivery-guard.mjs`,
      `${DEST}/stop-owner-directive-check.mjs`,
      `${DEST}/ask-gate-mirror.sh`,
    ]);
    // Matcher-less: the check is about the turn ending, not about any tool.
    expect(hookMatcherOf(cfg, 'Stop', 'stop-owner-directive-check.mjs')).toBeUndefined();
    // StopFailure (client-native-features-adoption-2026-10-21 P-002, R-2): a turn that
    // dies on an API error fires StopFailure INSTEAD of Stop, so it needs its own entry.
    // Matcher-less: Claude matches StopFailure on the error kind, and every kind counts.
    expect(commandsFor(cfg, 'StopFailure')).toEqual([`${DEST}/stop-failure-record.mjs`]);
    expect(hookMatcherOf(cfg, 'StopFailure', 'stop-failure-record.mjs')).toBeUndefined();
    // PostToolUseFailure (client-native-features-adoption-2026-10-21 P-003, R-3): a failed
    // native tool call fires PostToolUseFailure INSTEAD of PostToolUse. Matcher-less:
    // every tool's failure is recorded.
    expect(commandsFor(cfg, 'PostToolUseFailure')).toEqual([`${DEST}/posttooluse-failure-record.mjs`]);
    expect(hookMatcherOf(cfg, 'PostToolUseFailure', 'posttooluse-failure-record.mjs')).toBeUndefined();
    expect(hookMatcherOf(cfg, 'Stop', 'stop-identity-context.sh')).toBeUndefined();
    expect(hookMatcherOf(cfg, 'Stop', 'ask-gate-mirror.sh')).toBeUndefined(); // every turn end
    // EI-21844056581395228: MUST be matcher-less. The failure it guards lands in the
    // assistant's final PROSE, so a tool matcher here would leave it permanently inert
    // while still looking wired — the exact dead-code shape guard-operator-desktop had.
    expect(hookMatcherOf(cfg, 'Stop', 'artifact-url-delivery-guard.mjs')).toBeUndefined();

    // Notification: ask-gate-mirror only (permission-wait capture, P-001).
    expect(commandsFor(cfg, 'Notification')).toEqual([`${DEST}/ask-gate-mirror.sh`]);
    expect(hookMatcherOf(cfg, 'Notification', 'ask-gate-mirror.sh')).toBeUndefined(); // every one

    // UserPromptSubmit: turn-provenance classification (turn-provenance-owner-vs-agent P-003)
    // + turn-start memory delta (memory-delivery-unification-2026-07-12 P-003a).
    expect(commandsFor(cfg, 'UserPromptSubmit')).toEqual([
      `${DEST}/userpromptsubmit-provenance.sh`,
      `${DEST}/userpromptsubmit-memory.sh`,
    ]);
    expect(hookMatcherOf(cfg, 'UserPromptSubmit', 'userpromptsubmit-provenance.sh')).toBeUndefined();
    expect(hookMatcherOf(cfg, 'UserPromptSubmit', 'userpromptsubmit-memory.sh')).toBeUndefined();

    // statusLine + the Claude-only project-MCP auto-approve flag.
    expect(cfg.statusLine).toEqual({ type: 'command', command: `${DEST}/statusline-fleet.sh` });
    expect(cfg.enableAllProjectMcpServers).toBe(true);

    // objective-title is copied to disk but intentionally NOT registered (parity with the bash installer).
    const allCmds = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'Stop', 'UserPromptSubmit'].flatMap(
      (e) => commandsFor(cfg, e),
    );
    expect(allCmds.some((c) => c.includes('objective-title'))).toBe(false);
  });
});

describe('mergeClaudeHookSettings — non-destructive + idempotent', () => {
  it('keeps the standalone installer wired for direct and tools:invoke-wrapped capability:patch calls', () => {
    const installer = readFileSync(
      new URL('../../../../apps/operator/scripts/install-standalone-mcp.sh', import.meta.url),
      'utf8',
    );
    expect(installer).toContain(
      "'matcher': 'Edit|Write|MultiEdit|mcp__.*__capability_(edit|write|multi_?edit|patch)|mcp__.*__tools_invoke'",
    );
  });

  it('never clobbers a user-defined foreign statusLine', () => {
    const cfg = mergeClaudeHookSettings(
      { statusLine: { type: 'command', command: '/usr/local/bin/my-statusline' } },
      DEST,
      { isClaudeSettings: true },
    );
    expect(cfg.statusLine).toEqual({ type: 'command', command: '/usr/local/bin/my-statusline' });
  });

  it('refreshes OUR statusline in place (matches by path)', () => {
    const cfg = mergeClaudeHookSettings(
      { statusLine: { type: 'command', command: `${DEST}/statusline-fleet.sh` } },
      DEST,
    );
    expect(cfg.statusLine).toEqual({ type: 'command', command: `${DEST}/statusline-fleet.sh` });
  });

  it('preserves a user hook while adding ours (foreign entries survive)', () => {
    const foreign = { matcher: 'Edit', hooks: [{ type: 'command', command: '/opt/user/lint.sh' }] };
    const cfg = mergeClaudeHookSettings({ hooks: { PreToolUse: [foreign] } }, DEST);
    expect(cfg.hooks.PreToolUse[0]).toEqual(foreign); // untouched, still first
    expect(commandsFor(cfg, 'PreToolUse')).toContain(`${DEST}/pretooluse-locks-acquire.sh`);
    expect(commandsFor(cfg, 'PreToolUse')).toContain(`${DEST}/pretooluse-bash-resource-gate.sh`);
  });

  it('is idempotent — re-merging the same object adds no duplicate entries', () => {
    const once = mergeClaudeHookSettings({}, DEST, { isClaudeSettings: true });
    const snapshot = JSON.stringify(once);
    const twice = mergeClaudeHookSettings(once, DEST, { isClaudeSettings: true });
    expect(JSON.stringify(twice)).toBe(snapshot);
  });
});

// EI-19991080208681012. The assertions above are only as good as the resolver they call, so
// prove its two load-bearing properties directly. These fixtures are hand-built ON PURPOSE:
// a control that read the LIVE hook list would go red the moment someone registers a hook,
// i.e. it would fail at the exact moment the thing it guards is working.
describe('hookMatcherOf — the by-name resolver (synthetic fixtures, never the live hook list)', () => {
  const entry = (name: string, matcher?: string) => ({
    ...(matcher === undefined ? {} : { matcher }),
    hooks: [{ type: 'command', command: `${DEST}/${name}` }],
  });

  it('stays bound to its subject through an insertion that re-points every index below it', () => {
    const before = { hooks: { Stop: [entry('a.sh', 'A'), entry('b.sh', 'B')] } };
    const after = {
      hooks: { Stop: [entry('a.sh', 'A'), entry('inserted.sh', 'X'), entry('b.sh', 'B')] },
    };
    // The index form silently follows the insertion: `[1]` was b.sh and is now a different hook.
    expect(before.hooks.Stop[1].matcher).toBe('B');
    expect(after.hooks.Stop[1].matcher).toBe('X');
    // The by-name form answers about b.sh in both trees — that difference IS the fix.
    expect(hookMatcherOf(before, 'Stop', 'b.sh')).toBe('B');
    expect(hookMatcherOf(after, 'Stop', 'b.sh')).toBe('B');
  });

  it('throws on an unregistered hook rather than answering undefined', () => {
    const cfg = { hooks: { Stop: [entry('a.sh')] } };
    // Registered + matcher-less is the shape every toBeUndefined() above asserts.
    expect(hookMatcherOf(cfg, 'Stop', 'a.sh')).toBeUndefined();
    // Not registered at all must NOT be answerable as `undefined`, or each of those
    // assertions would keep passing against a hook that had been deleted outright.
    expect(() => hookMatcherOf(cfg, 'Stop', 'gone.sh')).toThrow(/not registered/);
  });
});

describe('mergeClaudeHookSettings — graceful degradation via `present`', () => {
  it('with only the statusline present, sets statusLine and NOTHING else', () => {
    const cfg = mergeClaudeHookSettings({}, DEST, {
      present: new Set(['statusline-fleet.sh']),
      isClaudeSettings: true,
    });
    expect(cfg.statusLine).toEqual({ type: 'command', command: `${DEST}/statusline-fleet.sh` });
    expect(cfg.hooks).toEqual({}); // no lock/coord/etc entries
    expect(cfg.enableAllProjectMcpServers).toBeUndefined(); // gated on the lock hooks
  });

  it('control: a hook absent from `present` does NOT register (calibrates the matcher assertions)', () => {
    // Falsifiability control for the EI-20782070131658758 assertions in the first describe.
    // Those assert control-bytes-content-guard registers on the WRITE matcher; this proves
    // that assertion can FAIL — when the hook is not installed, it registers nowhere. Without
    // this, a registration silently deleted from mergeClaudeHookSettings would leave the
    // positive assertion green-by-vacuity if `hookMatcherOf` ever degraded to a loose match.
    const withoutIt = mergeClaudeHookSettings({}, DEST, {
      present: new Set(['pretooluse-locks-acquire.sh', 'posttooluse-locks-release.sh']),
      isClaudeSettings: true,
    });
    expect(commandsFor(withoutIt, 'PreToolUse')).not.toContain(
      `${DEST}/pretooluse-control-bytes-content-guard.mjs`,
    );

    // Calibration: the REAL subject must still register, or the control above passes for the
    // trivial reason that nothing ever registers.
    const full = mergeClaudeHookSettings({}, DEST, { isClaudeSettings: true });
    expect(commandsFor(full, 'PreToolUse')).toContain(
      `${DEST}/pretooluse-control-bytes-content-guard.mjs`,
    );
  });

  it('does NOT set the Claude-only project-MCP flag when isClaudeSettings is false (codex home)', () => {
    const cfg = mergeClaudeHookSettings({}, DEST, {});
    expect(cfg.enableAllProjectMcpServers).toBeUndefined();
    // but the hooks + statusline still register.
    expect(commandsFor(cfg, 'PreToolUse')).toContain(`${DEST}/pretooluse-locks-acquire.sh`);
  });

  it('EI-8997 follow-up: a co-located FOREIGN command survives a re-merge (command-level filter, not whole-entry)', () => {
    // Reproduces a real live-settings.json shape: ONE PreToolUse entry mixing our
    // stale bash-gate command with a third-party command under the SAME matcher.
    // A whole-entry drop (the pre-fix behavior) silently destroyed the foreign one.
    const mixed = {
      matcher: 'Bash',
      hooks: [
        { type: 'command', command: `${DEST}/pretooluse-bash-resource-gate.sh` },
        { type: 'command', command: '/usr/local/bin/rtk hook claude' },
      ],
    };
    const cfg = mergeClaudeHookSettings({ hooks: { PreToolUse: [mixed] } }, DEST);
    const entries = cfg.hooks.PreToolUse as any[];
    const cmdsUnder = (matcher: string) =>
      entries.filter((e) => e.matcher === matcher).flatMap((e) => e.hooks.map((h: any) => h.command));

    // The foreign command survives, still under ITS original narrow matcher.
    expect(cmdsUnder('Bash')).toContain('/usr/local/bin/rtk hook claude');
    // Ours is refreshed under the widened shell matcher (EI-21971958067151594).
    expect(cmdsUnder(BASH_SHELL_MATCHER)).toContain(`${DEST}/pretooluse-bash-resource-gate.sh`);
    // ...and exactly once overall — the command-level filter must not leave a stale copy behind.
    const ourGate = entries
      .flatMap((e) => e.hooks.map((h: any) => h.command))
      .filter((c: string) => c.includes('pretooluse-bash-resource-gate.sh'));
    expect(ourGate).toHaveLength(1);
    // The SPLIT is the point, not an accident: widening the shared entry in place
    // would have handed rtk — a third-party command that REWRITES the payload it
    // is given — coverage of `capability:bash` too. A safety gate may widen alone.
    expect(cmdsUnder(BASH_SHELL_MATCHER)).not.toContain('/usr/local/bin/rtk hook claude');
  });
});
