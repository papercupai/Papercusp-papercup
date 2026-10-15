-- Nullable legacy rows remain readable. Unbound reservations cannot settle;
-- assigning a key today cannot authenticate a historical receipt.
ALTER TABLE commerce_offers ADD COLUMN seller_pubkey_base64 TEXT;
ALTER TABLE commerce_offers ADD COLUMN seller_key_proof TEXT;
ALTER TABLE usage_receipts ADD COLUMN seller_pubkey_base64 TEXT;

CREATE TRIGGER commerce_offer_seller_key_immutable
BEFORE UPDATE OF seller_pubkey_base64, seller_key_proof, product_id ON commerce_offers
WHEN OLD.seller_pubkey_base64 IS NOT NULL AND
  (NEW.seller_pubkey_base64 IS NOT OLD.seller_pubkey_base64 OR
   NEW.seller_key_proof IS NOT OLD.seller_key_proof OR NEW.product_id IS NOT OLD.product_id)
BEGIN
  SELECT RAISE(ABORT, 'offer seller authority is immutable');
END;

CREATE TRIGGER usage_receipt_seller_key_immutable
BEFORE UPDATE OF seller_pubkey_base64 ON usage_receipts
WHEN NEW.seller_pubkey_base64 IS NOT OLD.seller_pubkey_base64
BEGIN
  SELECT RAISE(ABORT, 'reservation seller authority is immutable');
END;
