-- D-055 / WI-10004291: retain the positive payer-signed reservation quantity
-- while a seller records partial or zero actual usage. Extend the existing
-- ledger without rebuilding its table, rewriting history, or losing guards.
-- NULL keeps legacy rows readable; their original priced quantity is derived
-- from reserved_micros / unit_price_micros by the receipt reader.
ALTER TABLE usage_receipts ADD COLUMN settled_meter_quantity INTEGER CHECK (
  settled_meter_quantity IS NULL OR (
    state = 'settled' AND settled_meter_quantity >= 0
    AND settled_meter_quantity <= meter_quantity
    AND (identity_ceiling_micros IS NOT NULL
      OR amount_micros = settled_meter_quantity * unit_price_micros)
  )
);
