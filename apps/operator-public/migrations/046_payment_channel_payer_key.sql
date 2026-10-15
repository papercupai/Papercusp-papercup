-- Legacy channels remain closable but cannot authorize new vouchers without a
-- payer key pinned by an authenticated opening and exact-terms possession proof.
ALTER TABLE payment_channels ADD COLUMN payer_pubkey_base64 TEXT;
ALTER TABLE payment_channels ADD COLUMN payer_key_proof TEXT;

CREATE TRIGGER payment_channel_payer_key_immutable
BEFORE UPDATE OF principal_id, payer_pubkey_base64, payer_key_proof ON payment_channels
WHEN NEW.principal_id IS NOT OLD.principal_id
  OR NEW.payer_pubkey_base64 IS NOT OLD.payer_pubkey_base64
  OR NEW.payer_key_proof IS NOT OLD.payer_key_proof
BEGIN
  SELECT RAISE(ABORT, 'payment channel payer authority is immutable');
END;
