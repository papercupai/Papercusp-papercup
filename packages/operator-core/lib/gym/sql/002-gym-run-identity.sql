-- Independent optimization loops reuse the baseline variant and start at cycle 0.
-- The loop token in run_id distinguishes those evaluations; the old tuple key
-- rejects the second loop even though it carries a different run identity.
-- Keep run_id as the primary key so retries remain idempotent and each run's
-- scores, parameters, and signals retain their original foreign-key identity.
ALTER TABLE harness_gym.gym_runs
  DROP CONSTRAINT IF EXISTS gym_runs_variant_id_task_id_cycle_repeat_key;
