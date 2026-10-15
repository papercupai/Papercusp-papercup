-- P-017: extend the existing signed usage ledger; no second account ledger.
ALTER TABLE usage_receipts ADD COLUMN identity_ceiling_micros INTEGER
  CHECK (identity_ceiling_micros IS NULL OR (identity_ceiling_micros > 0 AND identity_ceiling_micros <= 9007199254740991));
ALTER TABLE usage_receipts ADD COLUMN billed_inference_micros INTEGER
  CHECK (billed_inference_micros IS NULL OR (billed_inference_micros >= 0 AND billed_inference_micros <= identity_ceiling_micros));
ALTER TABLE usage_receipts ADD COLUMN prior_markup_remainder INTEGER
  CHECK (prior_markup_remainder IS NULL OR prior_markup_remainder BETWEEN 0 AND 9999);
ALTER TABLE usage_receipts ADD COLUMN markup_remainder INTEGER
  CHECK (markup_remainder IS NULL OR markup_remainder BETWEEN 0 AND 9999);

CREATE UNIQUE INDEX usage_receipts_identity_pending_idx ON usage_receipts (payer, offer_id)
  WHERE identity_ceiling_micros IS NOT NULL AND state = 'reserved';
CREATE INDEX usage_receipts_identity_history_idx ON usage_receipts (payer, offer_id)
  WHERE identity_ceiling_micros IS NOT NULL;

-- Serialize admission against the actual current channel, including refunds
-- and outstanding reservations. Pure preflight alone races concurrent buyers.
CREATE TRIGGER usage_receipts_reserve_guard BEFORE INSERT ON usage_receipts
WHEN NEW.state = 'reserved'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM payment_channels WHERE channel_id = NEW.channel_id AND state = 'open'
  ) THEN RAISE(ABORT, 'channel_not_open') END;
  SELECT CASE WHEN NEW.cumulative_claim_micros <= COALESCE((
    SELECT MAX(cumulative_claim_micros) FROM usage_receipts WHERE channel_id = NEW.channel_id
  ), 0) OR NEW.reserved_micros != NEW.cumulative_claim_micros - COALESCE((
    SELECT MAX(cumulative_claim_micros) FROM usage_receipts WHERE channel_id = NEW.channel_id
  ), 0) THEN RAISE(ABORT, 'cumulative-regression') END;
  SELECT CASE WHEN NEW.reserved_micros > (
    SELECT escrow_micros - committed_micros - refunded_micros FROM payment_channels WHERE channel_id = NEW.channel_id
  ) - COALESCE((SELECT SUM(reserved_micros) FROM usage_receipts
    WHERE channel_id = NEW.channel_id AND state = 'reserved'), 0)
    THEN RAISE(ABORT, 'cap-exhausted') END;
  SELECT CASE WHEN NEW.identity_ceiling_micros IS NOT NULL AND EXISTS (
    SELECT 1 FROM usage_receipts WHERE payer = NEW.payer AND offer_id = NEW.offer_id
      AND (identity_ceiling_micros IS NULL OR seller != NEW.seller OR release_ref != NEW.release_ref
        OR meter_unit != NEW.meter_unit OR unit_price_micros != NEW.unit_price_micros
        OR price_version != NEW.price_version OR split_manifest_hash != NEW.split_manifest_hash)
  ) THEN RAISE(ABORT, 'identity-account-mismatch') END;
  SELECT CASE WHEN NEW.identity_ceiling_micros IS NOT NULL AND EXISTS (
    SELECT 1 FROM usage_receipts WHERE payer = NEW.payer AND offer_id = NEW.offer_id AND state = 'reserved'
  ) THEN RAISE(ABORT, 'identity-account-pending') END;
END;

CREATE TRIGGER usage_receipts_identity_settle_guard BEFORE UPDATE OF state ON usage_receipts
WHEN OLD.state = 'reserved' AND NEW.state = 'settled' AND OLD.identity_ceiling_micros IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.billed_inference_micros IS NULL OR NEW.prior_markup_remainder IS NULL
    OR NEW.markup_remainder IS NULL OR NEW.settled_at_ms < OLD.reserved_at_ms
    THEN RAISE(ABORT, 'identity-settlement-mismatch') END;
  SELECT CASE WHEN NEW.prior_markup_remainder != COALESCE((
    SELECT markup_remainder FROM usage_receipts WHERE payer = OLD.payer AND offer_id = OLD.offer_id
      AND state = 'settled' AND identity_ceiling_micros IS NOT NULL ORDER BY rowid DESC LIMIT 1
  ), 0) THEN RAISE(ABORT, 'identity-remainder-mismatch') END;
END;
