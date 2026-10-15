/**
 * The gateway's Claude `[1m]` alias resolution, as a PURE module.
 *
 * Lifted out of `gateway.ts` (WI-10008259, benchmark-coverage-frontierswe-v2-2026-10-10 P-010) so a
 * consumer that only needs to know which upstream id an alias resolves to — the benchmark model-registry
 * snapshot — does not have to load the gateway server (http, schedulers, the account pool). `gateway.ts`
 * re-exports both names, so its callers are unchanged and there is still exactly one alias table.
 */

/** Claude CLI's `[1m]` marker is a client-side window selector, not an Anthropic API model id. */
export const ONE_MILLION_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  fable: 'claude-fable-5',
});

export interface GatewayModelResolution {
  model: string;
  context1m: boolean;
}

/** Resolve a CLI model marker to the real upstream model id and its beta requirement. */
export function resolveGatewayModel(model: string): GatewayModelResolution {
  if (!/\[1m\]/i.test(model)) return { model, context1m: false };
  // The marker is inserted before an optional CLI effort suffix (e.g. opus[1m]:high).
  const unmarked = model.replace(/\[1m\]/gi, '').replace(/:(?:low|medium|high|xhigh|max)$/i, '');
  return {
    model: ONE_MILLION_MODEL_ALIASES[unmarked.toLowerCase()] ?? unmarked,
    context1m: true,
  };
}
