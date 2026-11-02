/**
 * Shared scorecards:emit handler and bare-Node ptool deadlines.
 * Keep this plain ESM so operator-core and ptool use the same handler budget.
 */
export const SCORECARD_EMIT_TIMEOUT_SEC = 27 * 60;

/** Handler deadline plus MCP settlement and caller-side response margin. */
export const SCORECARD_EMIT_CLIENT_TIMEOUT_MS = SCORECARD_EMIT_TIMEOUT_SEC * 1_000 + 15_000;
