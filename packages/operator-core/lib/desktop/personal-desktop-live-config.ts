/** A scorecard binding explicitly requests this real-host suite; ordinary CI does not. */
export function personalDesktopLiveMode(env: NodeJS.ProcessEnv): 'manual' | 'scorecard' | 'off' {
  if (env.PAPERCUSP_PERSONAL_DESKTOP_LIVE === '1') return 'manual';
  if (env.PAPERCUSP_PERSONAL_DESKTOP_LIVE === '0') return 'off';
  return /^scorecard-check-[a-f0-9]{40}(?:-|$)/.test(env.PAPERCUSP_TEST_RUN_GROUP ?? '') ? 'scorecard' : 'off';
}

/** Reuse the maintained real-host evidence's connection coordinates, never its verdict. */
export function personalDesktopScorecardEnvironment(profile: unknown, output: string, run: string): Record<string, string> {
  const p = profile as { plan?: string; item?: string; host?: Record<string, unknown>; relay?: Record<string, unknown> };
  if (p?.plan !== 'personal-cloud-desktop-2026-10-06' || p.item !== 'P-006') throw new Error('Wrong personal desktop live host profile');
  const mapping = { ORG: 'organizationId', CWS: 'customerWorkspaceId', HOST: 'hostId', INST: 'instance', PROJECT: 'project', ZONE: 'zone', RUNTIME: 'runtime' };
  const result: Record<string, string> = { OUT: output, RUN_ID: run };
  for (const [key, field] of Object.entries(mapping)) {
    const value = p.host?.[field];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing live host profile: ${field}`);
    result[key] = value;
  }
  const broker = p.relay?.broker;
  if (typeof broker !== 'string' || !/^wss?:\/\//.test(broker)) throw new Error('Missing live broker profile');
  result.BROKER = broker;
  return result;
}
