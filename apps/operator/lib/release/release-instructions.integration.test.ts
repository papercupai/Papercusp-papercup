import { describe, expect, it } from 'vitest';
import { get as getCommand } from '@papercusp/operator-core/lib/commands/registry';
import { reportProblemHref } from '@papercusp/operator-core/lib/commands/defs/help';
import { getShortcutDef } from '@papercusp/operator-core/lib/shortcut-registry';
import { renderInstructionsHtml } from './release-history-page';

// P-017's R-1 slice (D-045): the generated Releases guidance points to the
// existing shared-intake desktop door, not a parallel reporting channel.
describe('Releases guidance and desktop reporting entry agree', () => {
  const html = renderInstructionsHtml({ generatedAt: new Date('2026-10-07T00:00:00Z'), redact: [] });

  it('renders the actual registered palette entry as the problem-report destination', () => {
    const command = getCommand('report.problem');
    expect(command?.kind).toBe('command');
    if (!command || command.kind !== 'command') throw new Error('Missing desktop reporting command');
    expect(command.agents).toContain('palette');
    expect(command.paletteEntry?.title).toBe('Report a problem');
    expect(html).toContain(`<strong>${command.paletteEntry?.title}</strong>`);
    expect(html).toContain('open the command palette');
    expect(reportProblemHref('tauri://localhost/settings?tab=general')).toBe('/settings?tab=general&report=true');
  });

  it('documents both platform forms of the registered default shortcut', () => {
    expect(getShortcutDef('report.problem')?.defaultCombo).toBe('mod+shift+b');
    expect(html).toContain('<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>');
    expect(html).toContain('<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> on macOS');
  });

  it('publishes the preview and consent sequence without promising an automatic send', () => {
    expect(html).toContain('<strong>Review</strong> to see exactly what will be sent');
    expect(html).toContain('Recent log lines are optional and off by default');
    expect(html).toContain('nothing is sent until you choose <strong>Send</strong>');
  });
});
