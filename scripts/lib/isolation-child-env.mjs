const unitOnlyEnvironmentKeys = [
  'PAPERCUSP_FORBID_REAL_PG',
  'VITEST',
  'VITEST_WORKER_ID',
  'VITEST_POOL_ID',
  'PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE',
];

/** Copy the environment for a real child runtime without inheriting unit-runner controls. */
export function isolatedRuntimeEnv(env) {
  const child = { ...env };
  for (const key of unitOnlyEnvironmentKeys) delete child[key];
  return child;
}
