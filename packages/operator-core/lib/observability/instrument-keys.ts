/** Dependency-free keys shared by the registry and its lazy operational reader. */
export const OBSERVABILITY_INSTRUMENT_KEYS = {
  project: 'observability:configured-project-delivery',
  staging: 'observability:staging-runtime-journey',
  release: 'observability:release-artifact-delivery',
} as const;
