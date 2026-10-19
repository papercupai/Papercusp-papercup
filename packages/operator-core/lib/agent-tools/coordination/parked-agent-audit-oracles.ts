export interface PickupDisposition {
  ownerId: string;
  request: string;
  outcome: string;
  reply: { id: string; at: string } | null;
}

export interface FollowupState {
  id: string;
  state: string;
  assignee: string | null;
  hasCompletionEvidence: boolean;
}

/** Pair the authenticated request destination with the verifier's runtime witness. */
export function parkedAuditOperatorRoute(env: NodeJS.ProcessEnv = process.env) {
  const nativeKeys = ['VERIFY_TAURI_PID', 'VERIFY_TAURI_PORT', 'VERIFY_TAURI_DEV_URL',
    'VERIFY_TAURI_SOURCE_REF', 'VERIFY_TAURI_SOURCE_RECEIPT', 'OPERATOR_SOURCE_ROOT'] as const;
  if (!nativeKeys.some(key => env[key])) return { port: '3170', origin: 'http://127.0.0.1:3170' };
  if (nativeKeys.some(key => !env[key]?.trim())
    || !/^[1-9]\d*$/.test(env.VERIFY_TAURI_PID!)
    || !/^[a-f0-9]{40,64}$/.test(env.VERIFY_TAURI_SOURCE_REF!)
    || !/^[1-9]\d*$/.test(env.VERIFY_TAURI_PORT!)
    || Number(env.VERIFY_TAURI_PORT) > 65535) throw new Error('parked-audit-native-route-invalid');
  const port = env.VERIFY_TAURI_PORT!;
  // mcp-call's --port route is loopback HTTP. Reject a disagreeing origin so
  // the request cannot exercise staging while its receipt names a verifier.
  const origin = `http://127.0.0.1:${port}`;
  if (env.VERIFY_TAURI_DEV_URL !== origin && env.VERIFY_TAURI_DEV_URL !== origin + '/') {
    throw new Error('parked-audit-native-route-invalid');
  }
  return { port, origin };
}

export function originalUnconfirmedPairs(rows: Array<{ ownerId: string; request: string; verification: string }>) {
  return rows.filter(row => row.verification === 'pickup-not-confirmed')
    .map(({ ownerId, request }) => ({ ownerId, request }));
}

export function pickupDispositionViolations(
  expected: Array<{ ownerId: string; request: string }>,
  cases: PickupDisposition[],
  items: FollowupState[],
  authenticatedOwner: string,
): string[] {
  const errors: string[] = [];
  const key = (row: { ownerId: string; request: string }) => row.ownerId + ':' + row.request;
  const wanted = expected.map(key);
  const actual = cases.map(key);
  if (expected.length !== 10 || new Set(wanted).size !== 10) errors.push('invalid-frozen-ten');
  if (actual.length !== 10 || new Set(actual).size !== 10
    || wanted.some(id => !actual.includes(id)) || actual.some(id => !wanted.includes(id))) {
    errors.push('disposition-population');
  }
  for (const row of cases) {
    if (row.outcome === 'recipient-replied') {
      if (!row.reply?.id || !Number.isFinite(Date.parse(row.reply.at))) errors.push('unsupported-pickup:' + key(row));
    } else if (row.outcome !== 'pickup-unconfirmed' || row.reply !== null) {
      errors.push('unsupported-disposition:' + key(row));
    }
  }
  for (const id of ['WI-6554700010017003', 'WI-6554700010017004']) {
    const item = items.find(row => row.id === id);
    if (!item || (item.state === 'done' ? !item.hasCompletionEvidence : item.assignee !== authenticatedOwner)) {
      errors.push('unowned-or-unverified:' + id);
    }
  }
  return errors;
}
