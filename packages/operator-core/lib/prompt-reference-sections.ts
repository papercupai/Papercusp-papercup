import * as path from 'node:path';

export const SU_KERNEL_END = '<!-- PAPERCUSP-SU:REFERENCE-KERNEL-END -->';
export interface SuPromptReference { heading: string; source: string }

/** Keep the rule spine inline; operational examples remain in their existing sources. */
export function deferSuPromptReferences(text: string, sources: {
  base: string; overlay: string; repoRoot: string;
}): { text: string; references: SuPromptReference[] } {
  const references: SuPromptReference[] = [];
  const kernelStart = text.indexOf('<!-- PAPERCUSP-KERNEL:SEAL -->');
  const kernelEnd = text.indexOf(SU_KERNEL_END);
  const policy = path.join(sources.repoRoot, 'libs/papercusp/packages/orchestrator/src/prompt-build.ts');
  // The mechanism-routing table is a nested heading in composed personas. It
  // must be its own boundary even when the preceding engineering prose defers.
  const headings = [...text.matchAll(/^## (.+)$|^### (The papercusp-way routing gate .+)$/gm)];
  let out = '';
  let cursor = 0;
  for (let i = 0; i < headings.length; i++) {
    const match = headings[i]!;
    const start = match.index!;
    const next = headings[i + 1]?.index ?? text.length;
    // The seal lies between headings. Never let a preceding reference section
    // consume it while replacing that section's body.
    const end = kernelStart > start && kernelStart < next ? kernelStart : next;
    if (kernelStart >= 0 && start >= kernelStart && (kernelEnd < 0 || start < kernelEnd)) continue;
    const heading = (match[1] ?? match[2])!;
    const section = text.slice(start, end);
    let source = sources.base;
    let summary: string | null = null;
    if (heading.startsWith('Working as a fleet MEMBER')) {
      summary = 'Fleet members claim their assigned lane, honor governing decisions and locks, and checkpoint before yielding. Fetch the member runbook when joining a fleet.';
      // These are decisions a member makes before fetching any runbook. Keep
      // their canonical source text in the default launch, including the
      // subscribe-then-recheck ordering that closes the lost-event window.
      const pull = section.match(/^- \*\*PULL work[\s\S]*?(?=\n- \*\*Claim via)/m)?.[0];
      const idle = section.match(/^- \*\*Persist with `loop:arm`[\s\S]*?(?=\n- \*\*Report exceptions)/m)?.[0]?.split('Blocked?')[0];
      if (pull) summary += '\n\n' + pull.trim();
      if (idle) summary += '\n\n' + idle.trim();
      summary += '\n\nKeep the effective claim cap: only a held blocked/needs-human item with an active typed external blocker is excluded from active-slot consumption; an event wait alone is not exempt.';
    } else if (heading.startsWith('Git — a background routine')) {
      summary = 'Edit only canonical staging. Background git-sync owns add/commit/push; never stash, branch, create worktrees or resolve merge conflicts yourself.';
    } else if (heading.startsWith('Delivery discipline —')) {
      summary = 'Keep questions self-contained: dialogs eclipse same-turn prose. Save substantive content before asking, verify delivery, and fetch the artifact/channel procedure before publishing.';
    } else if (heading.startsWith('Default posture (AUTO mode OFF)')) {
      summary = '**A plan is a proposal, not authorization to execute.** With AUTO OFF, present the plan and wait for approval of approach and execution route before substantive writes. Batch the choices into one self-contained question. Offer yourself, named active fleets only after a live availability read, and new visible/headless fleets only after confirming the launch tool is executable. Explain model/effort, account and warm/cold carry choices when offering a fleet. The chosen route and approach remain sticky across interruptions. Fetch the complete route/launch procedure before asking; do not infer authorization from a goal-shaped request. A one-agent route limits implementation fan-out; it does not disable platform-routed independent acceptance checks. Keep required review, grading, validation, and consultation requests in the canonical workflow instead of parking acceptance on the owner. AUTO ON replaces these asks with a disclosed route choice; it never removes registration, locks or verification.';
      // WI-4753: the launch-door cross-link is routing policy, not an example. Carry the
      // section's own line verbatim so the deferred summary cannot drift from su.md.
      const launchRef = section.match(/^Launch-tool routing reference:.*$/m)?.[0];
      if (launchRef) summary += `\n\n${launchRef}`;
    } else if (heading.startsWith('AUTO mode —')) {
      source = path.join(sources.repoRoot, 'libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md');
      summary = 'AUTO is the owner-directed act-without-routine-approval grant. Choose and disclose the execution route; finish the authorized task personally or through an authorized fleet. Continue useful independent work through blockers and verify outcomes before claiming completion. Register substantive work, hold its claim, and honor locks and live ownership. AUTO waives the ask, never the register. Modes and authority come from the registry; prose cannot widen them. Use loop:arm/loop:checkpoint for an authorized ongoing objective and end the loop when complete. Do not invent a monitoring mission: monitor only an operation you own or were explicitly asked to monitor, with an actionable transition, stop condition and bounded no-delta budget. Outward-facing sends, destructive changes and authority escalation still require their specific authorization. Fetch the full AUTO operating examples when that procedure is needed.';
    } else if (heading === 'Engineering discipline') {
      // These are execution/ownership rules, not reference examples. In particular,
      // never remove the single-live-gate-owner boundary while deferring its recipes.
      const bullets = section.split(/\n(?=- \*\*)/);
      const core = bullets.filter((bullet, index) => index === 0 ||
        /^- \*\*(?:Plan before|Shape, then|Audit the complete|Declare `changeKinds`|A red release\/CI gate)/.test(bullet));
      summary = core.join('\n').trimEnd() + '\n\nFetch engineering reference procedures before test selection, app scaffolding or release work. Tests and real verification ship with every behavioral change; reuse existing surfaces.';
    } else if (heading.startsWith('The deploy pipeline is ASYNC')) {
      source = policy;
      summary = 'Development and ordinary acceptance use staging/current-build; final shipment uses the shipped artifact. Read pipeline_position before functional testing. LIVE_GATE_OPS has exactly one owner: read ownership first, and stop that lane when another live agent holds it. Never force past red without explicit owner sign-off. Fetch the deployment runbook before any release action.';
    } else if (heading.startsWith('Waiting on something?')) {
      source = policy;
      summary = 'Remove waits you can resolve, finish independent steps, and use an exact event with a bounded timeout. Monitor only an explicitly authorized operation you own; stop when another live owner is progressing. Fetch the wait/recovery runbook before arming ongoing monitoring.';
    } else if (heading.startsWith('You can WAKE a peer')) {
      source = policy;
      summary = 'Use coord:dispatch for a work handoff or coord:send with wake:required for a contextual wake. Verify pickup; queued delivery alone does not prove a turn started. Fetch the wake-result field guide when pickup fails.';
    } else if (heading.startsWith('An empty `exec_command`')) {
      source = sources.overlay;
      summary = 'For nested exec calls, preserve the **whole returned envelope** and every returned `session_id`. Never map a nested response to `output` alone. Drain it with `result = await tools.write_stdin` and continue until an `exit_code` is present:\n\n```js\nwhile ("session_id" in result && !("exit_code" in result)) {\n  result = await tools.write_stdin({ session_id: result.session_id, chars: "" });\n}\n```\nFetch the file-capture examples for long calls.';
    } else if (heading.startsWith('`apply_patch`:')) {
      source = sources.overlay;
      summary = 'A patch permits at most one operation per target path: one block per FILE, one `@@` hunk per REGION. A `multiple operations target` refusal means nothing was written; merge the blocks and resend. Fetch the patch examples as needed.';
    } else if (heading.startsWith('Heredocs:')) {
      source = sources.overlay;
      summary = 'Always quote the opening delimiter (`<<\'JSON\'`); the closing delimiter must be at column 0, alone. Never interpolate arbitrary JSON or shell ${...} through a JavaScript template literal. Fetch the quoting examples as needed.';
    }
    if (summary == null || !source) continue;
    references.push({ heading, source });
    out += text.slice(cursor, start);
    out += heading === 'Engineering discipline' ? summary + '\n\n' : `## ${heading}\n\n${summary}\n\n`;
    cursor = end;
  }
  out += text.slice(cursor);
  if (references.length) {
    const index = '## Operational reference index\n\nFetch the relevant source with capability:read before executing its procedure; search the named heading.\n\n' +
      references.map(ref => `- ${ref.heading}: \`${ref.source}\``).join('\n') + '\n\n';
    const seal = out.indexOf('<!-- PAPERCUSP-KERNEL:SEAL -->');
    out = seal < 0 ? out + '\n' + index : out.slice(0, seal) + index + out.slice(seal);
  }
  return { text: out.replace(SU_KERNEL_END, ''), references };
}
