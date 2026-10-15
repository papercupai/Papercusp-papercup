-- Preserve legacy treasury identities; component authors each have one payout.
ALTER TABLE treasury_transfers ADD COLUMN payee_id TEXT NOT NULL DEFAULT '';
-- Reserve before submission. An uncertain chain outcome remains pending and
-- cannot be automatically retried or reported as money received.
ALTER TABLE treasury_transfers ADD COLUMN submission_state TEXT NOT NULL DEFAULT 'submitted'
  CHECK (submission_state IN ('pending', 'submitted'));
DROP INDEX treasury_transfers_receipt_share_idx;
CREATE UNIQUE INDEX treasury_transfers_receipt_share_payee_idx
  ON treasury_transfers (receipt_hash, share, payee_id);
