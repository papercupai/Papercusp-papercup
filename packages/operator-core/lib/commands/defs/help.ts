/**
 * help.* — the Help section of the command palette.
 *
 * report.problem opens the desktop "Report a problem" dialog
 * (unified-bug-pipeline-and-honest-queue-2026-10-05 P-014, D-048 pt 1). The
 * dialog's open state is the nuqs URL param `report`, so this command only
 * sets `?report=true` on the current page. The same param is what an agent
 * sets through ui:dispatch, and the mod+shift+b shortcut fires the same id.
 */
import { z } from 'zod';
import { register } from '../registry';
import type { CommandDef } from '../types';
import { navigateClient } from '../../client-navigation';

/** The current page with the report dialog open; every other param is kept. */
export function reportProblemHref(href: string): string {
  const url = new URL(href);
  url.searchParams.set('report', 'true');
  return `${url.pathname}${url.search}${url.hash}`;
}

const Empty = z.object({}).strict();

const reportProblem: CommandDef<{}, { path: string }> = {
  id: 'report.problem',
  kind: 'command',
  description: 'Open the Report a problem dialog on the current page.',
  promptDescription:
    'Opens the Report a problem dialog. The user writes one sentence, reviews exactly ' +
    'what will be sent, and chooses to send it. Use when the user wants to report a bug ' +
    'or something that went wrong in the app.',
  schema: Empty,
  agents: ['operator', 'palette', 'shortcut'],
  browser: 'required',
  concurrent: 'allow',
  tier: 'reflexive',
  paletteEntry: {
    section: 'Help',
    title: 'Report a problem',
    icon: '⚑',
    keywords: 'report problem bug feedback issue broken error',
  },
  handler: async () => {
    if (typeof window === 'undefined') throw new Error('report.problem must run in browser');
    const path = reportProblemHref(window.location.href);
    navigateClient(path);
    return { path };
  },
};

register(reportProblem);
