-- Zara Catalogue Foundation v1
-- IMPORTANT: catalogue data is runtime data, not hard-coded product data.
-- This schema is intentionally isolated from the existing Zara conversation/memory tables.
-- No customer-facing product codes are required. product_id is an internal permanent identity.

BEGIN;

CREATE TABLE IF NOT EXISTS catalog_products (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  collection TEXT,
  fabric TEXT,
  color TEXT,
  price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  currency TEXT NOT NULL DEFAULT 'PKR' CHECK (char_length(currency) BETWEEN 3 AND 3),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'out_of_stock', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS catalog_inventory (
  product_id BIGINT PRIMARY KEY REFERENCES catalog_products(id) ON DELETE RESTRICT,
  stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS catalog_images (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES catalog_products(id) ON DELETE RESTRICT,
  image_url TEXT NOT NULL,
  alt_text TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS catalog_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES catalog_products(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  old_value JSONB,
  new_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_catalog_products_status
  ON catalog_products(status);

CREATE INDEX IF NOT EXISTS idx_catalog_products_fabric_color
  ON catalog_products(fabric, color);

CREATE INDEX IF NOT EXISTS idx_catalog_products_collection
  ON catalog_products(collection);

CREATE INDEX IF NOT EXISTS idx_catalog_inventory_stock
  ON catalog_inventory(stock_quantity);

CREATE INDEX IF NOT EXISTS idx_catalog_images_product_order
  ON catalog_images(product_id, sort_order, id);

CREATE INDEX IF NOT EXISTS idx_catalog_events_product_time
  ON catalog_events(product_id, created_at DESC);

-- Only one primary image per product.
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_one_primary_image
  ON catalog_images(product_id)
  WHERE is_primary = TRUE;

-- Keep updated_at maintainable without application-side race-prone timestamp logic.
CREATE OR REPLACE FUNCTION catalog_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_catalog_products_updated_at ON catalog_products;
CREATE TRIGGER trg_catalog_products_updated_at
BEFORE UPDATE ON catalog_products
FOR EACH ROW
EXECUTE FUNCTION catalog_set_updated_at();

DROP TRIGGER IF EXISTS trg_catalog_inventory_updated_at ON catalog_inventory;
CREATE TRIGGER trg_catalog_inventory_updated_at
BEFORE UPDATE ON catalog_inventory
FOR EACH ROW
EXECUTE FUNCTION catalog_set_updated_at();

COMMIT;
