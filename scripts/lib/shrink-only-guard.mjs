import { createHash } from 'node:crypto';

export const fingerprint = (text) => createHash('sha256').update(text).digest('hex');

/** The immutable seed is pinned by the maintained suite; active entries may only shrink. */
export function validatePolicy(policy, seedHash) {
  const errors = [];
  if (fingerprint(JSON.stringify(policy.initial)) !== seedHash) errors.push('measured initial list changed');
  const initial = new Set(policy.initial);
  for (const key of policy.baseline) if (!initial.has(key)) errors.push(`baseline growth: ${key}`);
  for (const [key, reason] of Object.entries(policy.allowlist)) {
    if (typeof reason !== 'string' || reason.trim().length < 24) errors.push(`exception requires a reason: ${key}`);
  }
  return errors;
}

export function judgeSites(sites, policy, seedHash) {
  const errors = validatePolicy(policy, seedHash);
  const baseline = new Set(policy.baseline);
  const offenders = sites.filter((site) => !baseline.has(site.key) && !policy.allowlist[site.key]);
  return { errors, offenders };
}
