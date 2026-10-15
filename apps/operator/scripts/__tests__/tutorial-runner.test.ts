import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// plain .mjs module (same pattern as the other script tests) — the directive must sit
// immediately above the `} from` line for a multi-line import; tsc reports TS7016 there,
// not at the `import` keyword (EI-19389216343173748).
import {
  OPTION_LINE,
  SHELL_TABS,
  chapterEmoji,
  defaultTab,
  firstIndexOfChapter,
  interpretReply,
  nextTab,
  parseArgs,
  renderProgressBar,
  renderTabBar,
  resolveShellKey,
  resumeIndex,
  searchSections,
  sectionChoices,
  setupChecklist,
  statusStepForItemKey,
  stepCursor,
  undecidedRequiredItems,
  // @ts-expect-error
} from '../tutorial-runner.mjs';

describe('packaged tutorial dependency closure', () => {
  it('declares each directly imported package in the operator manifest and lockfile', () => {
    const source = readFileSync(new URL('../tutorial-runner.mjs', import.meta.url), 'utf8');
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(readFileSync(new URL('../../../../package-lock.json', import.meta.url), 'utf8'));
    const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g)]
      .map((match) => match[1]!)
      .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:'))
      .map((specifier) => specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0]!);
    expect(imports).toContain('chalk');
    for (const dependency of new Set(imports)) {
      expect(manifest.dependencies[dependency], `${dependency} must not rely on a transitive install`).toBeTruthy();
      expect(lock.packages['apps/operator'].dependencies[dependency], `${dependency} lock declaration`)
        .toBe(manifest.dependencies[dependency]);
    }
  });
});

describe('parseArgs', () => {
  it('parses tutorial / operator-url / agent / tab', () => {
    expect(parseArgs(['--tutorial', '--agent=codex', '--operator-url=http://x:3070', '--tab=setup'])).toEqual({
      tutorial: true,
      agent: 'codex',
      operatorUrl: 'http://x:3070',
      tab: 'setup',
    });
  });
  it('defaults to first-run with no agent / no tab', () => {
    expect(parseArgs([])).toEqual({ tutorial: false, agent: null, operatorUrl: null, tab: null });
  });
});

describe('interpretReply — the deterministic navigation (NO LLM decides this)', () => {
  it('1 / empty / continue → continue', () => {
    for (const r of ['1', '', '  ', 'continue', 'CONTINUE', 'next', 'c']) {
      expect(interpretReply(r).kind, r).toBe('continue');
    }
  });
  it('2 / more / details → details', () => {
    for (const r of ['2', 'more', 'Details', 'd']) {
      expect(interpretReply(r).kind, r).toBe('details');
    }
  });
  it('m / menu → menu; f / finish / quit → finish', () => {
    expect(interpretReply('m').kind).toBe('menu');
    expect(interpretReply('menu').kind).toBe('menu');
    for (const r of ['f', 'finish', 'done', 'quit', 'exit']) {
      expect(interpretReply(r).kind, r).toBe('finish');
    }
  });
  it('anything else IS a question, carrying the raw text', () => {
    const q = interpretReply('what is a harness?');
    expect(q.kind).toBe('question');
    expect(q.text).toBe('what is a harness?');
    // A number that isn't 1/2 is still a question, not a mis-fired command.
    expect(interpretReply('3').kind).toBe('question');
  });
  it('the option line advertises exactly the handled commands', () => {
    expect(OPTION_LINE).toContain('[1] Continue');
    expect(OPTION_LINE).toContain('[2] More details');
    expect(OPTION_LINE).toContain('[m] Menu');
    expect(OPTION_LINE).toContain('[f] Finish');
    expect(OPTION_LINE).toContain('type your question');
  });
});

describe('resume math', () => {
  const sections = [
    { id: 'ch1-01', chapter: 1 },
    { id: 'ch1-02', chapter: 1 },
    { id: 'ch2-01', chapter: 2 },
  ];
  it('resumeIndex returns the section AFTER the last delivered', () => {
    expect(resumeIndex(sections, { last_section_id: 'ch1-01' })).toBe(1);
    expect(resumeIndex(sections, { last_section_id: 'ch2-01' })).toBe(3); // clamped to end
    expect(resumeIndex(sections, null)).toBe(0);
    expect(resumeIndex(sections, { last_section_id: 'gone' })).toBe(0);
  });
  it('firstIndexOfChapter finds a chapter start', () => {
    expect(firstIndexOfChapter(sections, 2)).toBe(2);
    expect(firstIndexOfChapter(sections, 9)).toBe(-1);
  });
});

describe('interpretReply — search command (non-TTY fallback)', () => {
  it('s / search → search', () => {
    expect(interpretReply('s').kind).toBe('search');
    expect(interpretReply('SEARCH').kind).toBe('search');
  });
});

describe('sectionChoices — the arrow-key section menu (#1)', () => {
  it('always offers continue first, then search/question/menu/finish', () => {
    const values = sectionChoices({ title: 'X', brief: 'b', details: null }).map((c) => c.value);
    expect(values[0]).toBe('continue');
    expect(values).toEqual(['continue', 'search', 'question', 'menu', 'finish']);
  });
  it('includes "details" only when the section has details', () => {
    const withD = sectionChoices({ details: 'more' }).map((c) => c.value);
    expect(withD).toContain('details');
    const noD = sectionChoices({ details: null }).map((c) => c.value);
    expect(noD).not.toContain('details');
  });
});

describe('searchSections — tutorial search ranking (#4)', () => {
  const sections = [
    { title: 'Plans', brief: 'a durable list of work items', chapter: 2 },
    { title: 'Work items', brief: 'the unit of work an agent claims', chapter: 2 },
    { title: 'Loops', brief: 'keep an agent working on a plan', chapter: 2 },
  ];
  it('ranks a title hit above a brief-only hit', () => {
    const hits = searchSections(sections, 'plan');
    // "Plans" (title) must rank above "Loops" (brief mentions 'plan')
    expect(hits[0].section.title).toBe('Plans');
    expect(hits.map((h) => h.section.title)).toContain('Loops');
  });
  it('empty query returns every section (idx preserved)', () => {
    const hits = searchSections(sections, '');
    expect(hits).toHaveLength(3);
    expect(hits[0].idx).toBe(0);
  });
  it('no match returns empty', () => {
    expect(searchSections(sections, 'zzzznomatch')).toEqual([]);
  });
});

describe('renderProgressBar', () => {
  it('renders proportional fill + percent', () => {
    expect(renderProgressBar(0, 6, 6)).toBe('░░░░░░ 0%');
    expect(renderProgressBar(3, 6, 6)).toBe('▓▓▓░░░ 50%');
    expect(renderProgressBar(6, 6, 6)).toBe('▓▓▓▓▓▓ 100%');
  });
  it('clamps out-of-range + guards total=0', () => {
    expect(renderProgressBar(9, 6, 6)).toBe('▓▓▓▓▓▓ 100%');
    expect(renderProgressBar(1, 0, 6)).toBe('▓▓▓▓▓▓ 100%');
  });
});

describe('chapterEmoji', () => {
  it('maps known chapters and falls back for unknown', () => {
    expect(chapterEmoji(1)).toBe('🧭');
    expect(chapterEmoji(3)).toBe('☕');
    expect(chapterEmoji(99)).toBe('📘');
  });
});

// ── Unified Tutorial|Setup shell (#4 + B2-#1) ──
// chalk may emit color codes in CI; strip them and assert on plain substrings.
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('nextTab / defaultTab / SHELL_TABS — the tab model (#4)', () => {
  it('SHELL_TABS lists both tabs, Setup first (owner 2026-07-06)', () => {
    expect(SHELL_TABS).toEqual(['setup', 'tutorial']);
  });
  it('nextTab toggles (order-driven off SHELL_TABS)', () => {
    expect(nextTab('tutorial')).toBe('setup');
    expect(nextTab('setup')).toBe('tutorial');
  });
  it('defaultTab: setup is the FIRST thing until setup is complete (owner 2026-07-06)', () => {
    // Incomplete (the default): ALWAYS open Setup — whatever command launched the shell.
    // A new user can never be dropped into the tour with required setup unfinished.
    expect(defaultTab({ tab: 'setup' })).toBe('setup');
    expect(defaultTab({ tab: 'tutorial' })).toBe('setup'); // even an explicit tutorial tab yields
    expect(defaultTab({ tutorial: true })).toBe('setup'); // `papercusp tutorial`, setup unfinished
    expect(defaultTab({})).toBe('setup'); // first-run handoff, setup unfinished
    expect(defaultTab({ tab: 'bogus' })).toBe('setup');
  });
  it('defaultTab: even when setup is COMPLETE, `papercusp tutorial` still opens Setup first (owner 2026-07-06)', () => {
    expect(defaultTab({ tab: 'setup' }, { setupComplete: true })).toBe('setup'); // `papercusp setup`
    expect(defaultTab({ tutorial: true }, { setupComplete: true })).toBe('setup'); // `papercusp tutorial` → Setup first
    expect(defaultTab({ tab: 'tutorial' }, { setupComplete: true })).toBe('tutorial'); // explicit tutorial tab still honored
    expect(defaultTab({}, { setupComplete: true })).toBe('tutorial'); // ONLY the first-run handoff lands on the tour
  });
});

describe('renderTabBar — the always-visible tab bar + shortcut hints (#4 + B2-#1)', () => {
  it('brackets the ACTIVE tab (owner-chosen mockup) so it reads without color', () => {
    const t = strip(renderTabBar('tutorial'));
    expect(t).toContain('[ Tutorial ]');
    expect(t).not.toContain('[ Setup ]');
    const s = strip(renderTabBar('setup'));
    expect(s).toContain('[ Setup ]');
    expect(s).not.toContain('[ Tutorial ]');
  });
  it('renders Setup before Tutorial in the tab bar (Setup is now the first tab, owner 2026-07-06)', () => {
    const firstLine = strip(renderTabBar('setup')).split('\n')[0];
    expect(firstLine.indexOf('Setup')).toBeLessThan(firstLine.indexOf('Tutorial'));
  });
  it('names the DESTINATION tab in a loud switch CTA so it is impossible to miss (owner 2026-07-06)', () => {
    expect(strip(renderTabBar('tutorial'))).toContain('Press Tab ⇄ switch to Setup');
    expect(strip(renderTabBar('setup'))).toContain('Press Tab ⇄ switch to Tutorial');
  });
  it('shows a ✓ on Setup once setup is complete', () => {
    expect(strip(renderTabBar('tutorial', { setupComplete: true }))).toContain('Setup ✓');
    expect(strip(renderTabBar('tutorial', { setupComplete: false }))).not.toContain('Setup ✓');
  });
  it('advertises every global shortcut with an icon hint (B2-#1)', () => {
    const bar = strip(renderTabBar('tutorial'));
    expect(bar).toContain('Tab'); // switch
    expect(bar).toContain('search');
    expect(bar).toContain('chapters');
    expect(bar).toContain('ask');
    expect(bar).toContain('🔍'); // the requested "ctrl+s with a search icon"
  });
});

describe('resolveShellKey — global hotkeys live on every screen (B2-#1)', () => {
  it('Tab → switch tab', () => {
    expect(resolveShellKey({ name: 'tab' })).toBe('tab');
  });
  it('Ctrl+S OR "/" → search (some terminals swallow ^S as XOFF)', () => {
    expect(resolveShellKey({ ctrl: true, name: 's' })).toBe('search');
    expect(resolveShellKey({ sequence: '/' })).toBe('search');
  });
  it('"#" → jump to chapter, "?" → ask a question', () => {
    expect(resolveShellKey({ sequence: '#' })).toBe('jump');
    expect(resolveShellKey({ sequence: '?' })).toBe('ask');
  });
  it('non-shortcut keys (arrows, enter, plain letters) are NOT globals', () => {
    expect(resolveShellKey({ name: 'up' })).toBeNull();
    expect(resolveShellKey({ name: 'down' })).toBeNull();
    expect(resolveShellKey({ name: 'return' })).toBeNull();
    expect(resolveShellKey({ sequence: 'x', name: 'x' })).toBeNull();
    expect(resolveShellKey({ name: 's' })).toBeNull(); // plain 's' (no ctrl) is not search
    expect(resolveShellKey(null)).toBeNull();
  });
});

describe('setupChecklist — the Setup-tab status model (#4)', () => {
  it('a signed-in framework marks framework + signin done; embeddings is REQUIRED + TODO until saved', () => {
    const steps = setupChecklist(
      { claudeInstalled: true, claudeSignedIn: true, embeddingsKeyPresent: false },
      { claude: 'Claude Code' },
    );
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s.status]));
    expect(byKey).toEqual({ framework: 'done', signin: 'done', embeddings: 'todo' });
    // all three are REQUIRED (mem0 embeddings key is now a required step)
    expect(steps.every((s) => s.required === true)).toBe(true);
    expect(steps.find((s) => s.key === 'framework')!.detail).toContain('Claude Code');
  });
  it('omp counts as an installed framework (label honored)', () => {
    const steps = setupChecklist(
      { ompInstalled: true, ompSignedIn: true },
      { omp: 'oh-my-pi (omp)' },
    );
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s.status]));
    expect(byKey.framework).toBe('done');
    expect(byKey.signin).toBe('done');
    expect(steps.find((s) => s.key === 'framework')!.detail).toContain('oh-my-pi (omp)');
  });
  it('installed-but-not-signed-in → signin is a TODO', () => {
    const steps = setupChecklist({ codexInstalled: true, codexSignedIn: false }, { codex: 'Codex' });
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s.status]));
    expect(byKey.framework).toBe('done');
    expect(byKey.signin).toBe('todo');
  });
  it('a fresh machine → all three required steps TODO; embeddings saved → done', () => {
    expect(setupChecklist({}, {}).map((s) => s.status)).toEqual(['todo', 'todo', 'todo']);
    const withKey = setupChecklist(
      { claudeInstalled: true, claudeSignedIn: true, embeddingsKeyPresent: true },
      {},
    );
    expect(withKey.find((s) => s.key === 'embeddings')!.status).toBe('done');
  });
  it('appends optional items (required:false, status optional) after the required steps', () => {
    const steps = setupChecklist({}, {}, [
      { key: 'git-identity', label: 'Git identity', why: 'stamped on commits' },
      { key: 'github', label: 'GitHub sign-in', why: 'clone/push private repos' },
    ]);
    expect(steps.map((s) => s.key)).toEqual([
      'framework',
      'signin',
      'embeddings',
      'opt-git-identity',
      'opt-github',
    ]);
    const opts = steps.filter((s) => s.required === false);
    expect(opts.every((s) => s.status === 'optional')).toBe(true);
    expect(opts.map((s) => s.label)).toEqual(['Git identity', 'GitHub sign-in']);
  });
  it('degrades gracefully with no snapshot', () => {
    expect(setupChecklist(undefined).map((s) => s.key)).toEqual(['framework', 'signin', 'embeddings']);
  });
  it('a required optional item (telemetry) renders under Required with done/todo from decidedKeys', () => {
    const items = [
      { key: 'git-identity', label: 'Git identity', why: 'commits' }, // no required field → optional
      { key: 'telemetry', label: 'Telemetry consent', why: 'diagnostics', required: true },
    ];
    // Undecided (empty decidedKeys) → telemetry is a REQUIRED todo; git-identity stays optional.
    const undecided = setupChecklist({}, {}, items, []);
    const tel = undecided.find((s) => s.key === 'opt-telemetry')!;
    expect(tel.required).toBe(true);
    expect(tel.status).toBe('todo');
    const git = undecided.find((s) => s.key === 'opt-git-identity')!;
    expect(git.required).toBe(false);
    expect(git.status).toBe('optional');
    // Decided → telemetry flips to done (a "no" is still decided).
    const decided = setupChecklist({}, {}, items, ['telemetry']);
    expect(decided.find((s) => s.key === 'opt-telemetry')!.status).toBe('done');
  });
});

describe('required optional-setup helpers (graduation gate — pure)', () => {
  it('statusStepForItemKey maps to the setup-status step, else the key itself', () => {
    expect(statusStepForItemKey('telemetry')).toBe('telemetry');
    expect(statusStepForItemKey('update-channel')).toBe('auto-update');
    expect(statusStepForItemKey('anything-else')).toBe('anything-else');
  });
  it('undecidedRequiredItems returns only required items whose status step is not ok', () => {
    const items = [
      { key: 'git-identity', label: 'Git', why: 'w' }, // not required
      { key: 'telemetry', label: 'Telemetry', why: 'w', required: true },
    ];
    // telemetry undecided (needs-attention) → surfaced
    expect(undecidedRequiredItems(items, { telemetry: 'needs-attention' }).map((i) => i.key)).toEqual([
      'telemetry',
    ]);
    // telemetry decided (ok — a yes OR a no both flip it to ok) → nothing undecided
    expect(undecidedRequiredItems(items, { telemetry: 'ok' })).toEqual([]);
    // status step absent from the map → treated as undecided (fail toward asking)
    expect(undecidedRequiredItems(items, {}).map((i) => i.key)).toEqual(['telemetry']);
    // a non-required item is never surfaced, whatever its status
    expect(undecidedRequiredItems([{ key: 'git-identity', label: 'Git', why: 'w' }], {})).toEqual([]);
  });
});

// ── stepCursor (the 2026-07-05 frozen-menu fix) ────────────────────────────────
// stepCursor is imported in the top-level import block above.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('stepCursor — ↑/↓ menu navigation (wrap-around, pure)', () => {
  it('down advances and wraps; up retreats and wraps', () => {
    expect(stepCursor(0, 'down', 6)).toBe(1);
    expect(stepCursor(5, 'down', 6)).toBe(0);
    expect(stepCursor(0, 'up', 6)).toBe(5);
    expect(stepCursor(3, 'up', 6)).toBe(2);
  });
  it('other keys and empty menus are no-ops', () => {
    expect(stepCursor(2, 'a', 6)).toBe(2);
    expect(stepCursor(2, 'left', 6)).toBe(2);
    expect(stepCursor(2, 'down', 0)).toBe(2);
  });
});

describe('@inquirer/core setState misuse guard (2026-07-05 frozen tutorial menu)', () => {
  it("no script passes a functional updater to an @inquirer/core useState setter — setState(fn) stores the FUNCTION as the value", () => {
    const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const offenders: string[] = [];
    for (const f of readdirSync(scriptsDir)) {
      if (!f.endsWith('.mjs')) continue;
      const src = readFileSync(join(scriptsDir, f), 'utf8');
      if (!src.includes("'@inquirer/core'") && !src.includes('"@inquirer/core"')) continue;
      // A setter call whose first arg opens an arrow function: set<X>((c) => …
      // (setTimeout/setInterval/setImmediate legitimately take callbacks — skip them.)
      const m = (src.match(/set[A-Z]\w*\(\s*\(?\s*\w*\s*\)?\s*=>/g) ?? []).filter(
        (s) => !/^set(Timeout|Interval|Immediate)\b/.test(s),
      );
      if (m.length > 0) offenders.push(`${f}: ${m.join(' | ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
