/**
 * Seed the `orphaned-mcp-reaper` routine — EI-18691186726153223; design in
 * `orphaned-mcp-reaper.ts`, handler in `orphaned-mcp-reaper-action.ts`.
 *
 *   - `orphaned-mcp-reaper` (every 30 min): SIGTERM/SIGKILL leaked
 *     `playwright-mcp` server processes that are agent-spawned (carry
 *     PAPERCUSP_ADV_SESSION_ID), match the playwright-mcp package/binary
 *     signature specifically, and have been alive past the age floor.
 *     Host-local /proc scan + `process.kill` only; spawns no agent, calls no
 *     external API.
 *
 * Double-gated with FLAGS.ORPHANED_MCP_REAPER (default ON) — a destructive
 * reaper killing real agent-session child processes on a shared host is the
 * "owner-authority" flags exception (repo CLAUDE.md), so the SINGLE activation
 * gate is this routine's own `active` column, seeded FALSE. Idempotent
 * (upsert). Recommended bring-up order: `--active --dry-run` first to review
 * the candidate set, then drop dry_run.
 *
 *   tsx seed-orphaned-mcp-reaper-routine.ts                    # seed INACTIVE
 *   tsx seed-orphaned-mcp-reaper-routine.ts --active           # seed + enable
 *   tsx seed-orphaned-mcp-reaper-routine.ts --active --dry-run # enable, preview only
 *
 * trigger_config knobs (optional, editable via the routines admin):
 *   - dry_run (default false) — classify + log, kill nothing.
 *   - min_age_minutes (default 30) — grace window before a group is reap-eligible.
 */

import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.ORPHANED_MCP_REAPER_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Every 30 minutes — cheap (one /proc scan + a handful of signals); a leaked
 *  MCP server wastes memory for its whole idle lifetime, so a half-hour
 *  cadence bounds the leak tightly without being a noisy sweep. */
const CRON = '0 */30 * * * *';

void runRoutineSeed({
  scriptTag: 'seed-orphaned-mcp-reaper-routine',
  prepare: () => {
    const active = process.argv.includes('--active');
    const dryRun = process.argv.includes('--dry-run');
    const name = 'orphaned-mcp-reaper';
    const triggerConfig = { cron: CRON, dry_run: dryRun };
    return {
      installSlug: SLUG,
      name: name,
      active,
      triggerConfig: JSON.stringify(triggerConfig),
      targetRole: 'system:orphaned-mcp-reaper',
      dryRun,
    };
  },
  afterSeed: async ({ active, id, workspaceId: ws, sql, dryRun, name, triggerConfig }) => {
    console.log(
        `[seed-orphaned-mcp-reaper-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}, dry_run=${dryRun}) — ` +
          `half-hourly reap of leaked agent-spawned playwright-mcp server processes. ` +
          (active
            ? 'Cadence LIVE.'
            : 'Inactive — enable with --active (recommend --active --dry-run first) or the routines admin.'),
      );
  },
});
