/**
 * The SWE-bench Pro population our M1 adapter grades against, pinned (WI-6554700010008394).
 *
 * Upstream v2.0.0 (scaleapi/SWE-bench_Pro-os@66f92766bba6, 2026-09-22) made the Hugging Face
 * `ScaleAI/SWE-bench_Pro` `default` config the 642-task v2 set and moved the original 731 tasks to
 * config `v1` (apps/operator/docs/benchmark-suite-portfolio-2026-10-11.md §1, measured against the HF
 * datasets-server). Our adapter still drives the v1 path (`swe_bench_pro_eval.py` reading
 * `swe_bench_pro_full.csv`), so a CSV re-exported from the HF default would swap the population with
 * no error. The grader preflight therefore refuses any raw-sample CSV whose bytes differ from this pin,
 * and the task-set catalog and launch estimate read the task count from here instead of repeating it.
 *
 * Moving to the v2 population is the modernization plan's build (benchmark-coverage-frontierswe-v2-
 * 2026-10-10#D-004): it changes this pin deliberately, together with the adapter.
 *
 * Leaf module on purpose: no imports, so task-sets / estimate / the grader can all depend on it.
 */
export const SWE_BENCH_PRO_V1_PIN = {
  /** Population id: the original release, HF `ScaleAI/SWE-bench_Pro` config `v1`. */
  population: 'v1',
  hfDataset: 'ScaleAI/SWE-bench_Pro',
  hfConfig: 'v1',
  /** Task count of the v1 population (CSV data rows). */
  taskCount: 731,
  /** File name the eval script reads (`--raw_sample_path`). */
  csvFile: 'swe_bench_pro_full.csv',
  /**
   * sha256 of the raw-sample CSV the June 16-19 trials graded against, measured 2026-10-11 on this
   * host at ~/.papercusp/bench-harnesses/SWE-bench_Pro-os/swe_bench_pro_full.csv (731 data rows,
   * 23,941,964 bytes; the file is not tracked by the upstream checkout).
   */
  csvSha256: '8081290f41763ade21849caf8cebcfc12a6601c9107d756a75c1463c0f0c92a1',
  measuredAt: '2026-10-11',
} as const;

export type SweBenchProPopulationPin = typeof SWE_BENCH_PRO_V1_PIN;
