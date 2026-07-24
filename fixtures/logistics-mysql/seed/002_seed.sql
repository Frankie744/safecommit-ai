SET NAMES utf8mb4;
SET time_zone = '+00:00';

INSERT INTO tenant (id, name) VALUES
  ('tenant-demo', 'SafeCommit Demo Logistics'),
  ('tenant-other', 'Unrelated Tenant');

INSERT INTO warehouse (id, tenant_id, code, name) VALUES
  ('warehouse-la', 'tenant-demo', 'LAX', 'Los Angeles Warehouse'),
  ('warehouse-ny', 'tenant-demo', 'NYC', 'New York Warehouse'),
  ('warehouse-other-la', 'tenant-other', 'LAX', 'Other Tenant Los Angeles');

INSERT INTO location (id, warehouse_id, code, name) VALUES
  ('location-la-a1', 'warehouse-la', 'A1', 'Los Angeles A1'),
  ('location-ny-b1', 'warehouse-ny', 'B1', 'New York B1'),
  ('location-other-a1', 'warehouse-other-la', 'A1', 'Other Tenant A1');

INSERT INTO product (
  id,
  tenant_id,
  sku,
  name,
  canonical_product_id,
  active
) VALUES
  ('product-canonical', 'tenant-demo', 'DEMO-SKU-42', 'Sterile Kit', NULL, TRUE),
  ('product-duplicate', 'tenant-demo', 'DEMO-SKU-42', 'Sterile Kit duplicate', NULL, TRUE),
  ('product-ny-lookalike', 'tenant-demo', 'DEMO-SKU-42-NY', 'Sterile Kit', NULL, TRUE),
  ('product-other-tenant', 'tenant-other', 'DEMO-SKU-42', 'Sterile Kit', NULL, TRUE);

INSERT INTO lot (
  id,
  tenant_id,
  product_id,
  lot_number,
  expiration_date
) VALUES
  ('lot-canonical-la', 'tenant-demo', 'product-canonical', 'LOT-LA-001', '2028-06-30'),
  ('lot-duplicate-la', 'tenant-demo', 'product-duplicate', 'LOT-LA-002', '2028-12-31'),
  ('lot-ny', 'tenant-demo', 'product-ny-lookalike', 'LOT-NY-001', '2029-03-31'),
  ('lot-other', 'tenant-other', 'product-other-tenant', 'LOT-OTHER-001', '2029-09-30');

INSERT INTO inventory_item (
  id,
  tenant_id,
  warehouse_id,
  location_id,
  product_id,
  lot_id,
  quantity
) VALUES
  ('inventory-canonical-la', 'tenant-demo', 'warehouse-la', 'location-la-a1', 'product-canonical', 'lot-canonical-la', 7),
  ('inventory-duplicate-la', 'tenant-demo', 'warehouse-la', 'location-la-a1', 'product-duplicate', 'lot-duplicate-la', 3),
  ('inventory-ny', 'tenant-demo', 'warehouse-ny', 'location-ny-b1', 'product-ny-lookalike', 'lot-ny', 11),
  ('inventory-other', 'tenant-other', 'warehouse-other-la', 'location-other-a1', 'product-other-tenant', 'lot-other', 13);

INSERT INTO serial_number (
  id,
  tenant_id,
  inventory_item_id,
  serial_number,
  active
) VALUES
  ('serial-canonical-la', 'tenant-demo', 'inventory-canonical-la', 'SER-LA-001', TRUE),
  ('serial-duplicate-la', 'tenant-demo', 'inventory-duplicate-la', 'SER-LA-002', TRUE),
  ('serial-ny', 'tenant-demo', 'inventory-ny', 'SER-NY-001', TRUE),
  ('serial-other', 'tenant-other', 'inventory-other', 'SER-OTHER-001', TRUE);

INSERT INTO order_header (
  id,
  tenant_id,
  warehouse_id,
  status,
  external_reference
) VALUES
  ('order-cancelled-la', 'tenant-demo', 'warehouse-la', 'CANCELLED', 'ORDER-CANCELLED-LA'),
  ('order-shipped-la', 'tenant-demo', 'warehouse-la', 'SHIPPED', 'ORDER-SHIPPED-LA'),
  ('order-cancelled-ny', 'tenant-demo', 'warehouse-ny', 'CANCELLED', 'ORDER-CANCELLED-NY'),
  ('order-cancelled-other', 'tenant-other', 'warehouse-other-la', 'CANCELLED', 'ORDER-CANCELLED-OTHER');

INSERT INTO order_line (id, order_id, product_id, quantity) VALUES
  ('line-cancelled-la', 'order-cancelled-la', 'product-duplicate', 3),
  ('line-shipped-la', 'order-shipped-la', 'product-canonical', 2),
  ('line-cancelled-ny', 'order-cancelled-ny', 'product-ny-lookalike', 4),
  ('line-cancelled-other', 'order-cancelled-other', 'product-other-tenant', 5);

INSERT INTO allocation (
  id,
  tenant_id,
  warehouse_id,
  order_line_id,
  inventory_item_id,
  quantity,
  released_at
) VALUES
  ('allocation-cancelled-la', 'tenant-demo', 'warehouse-la', 'line-cancelled-la', 'inventory-duplicate-la', 3, NULL),
  ('allocation-shipped-la', 'tenant-demo', 'warehouse-la', 'line-shipped-la', 'inventory-canonical-la', 2, NULL),
  ('allocation-cancelled-ny', 'tenant-demo', 'warehouse-ny', 'line-cancelled-ny', 'inventory-ny', 4, NULL),
  ('allocation-cancelled-other', 'tenant-other', 'warehouse-other-la', 'line-cancelled-other', 'inventory-other', 5, NULL);

INSERT INTO inventory_transaction (
  id,
  tenant_id,
  warehouse_id,
  inventory_item_id,
  transaction_kind,
  quantity_delta,
  correlation_key,
  occurred_at
) VALUES
  ('transaction-opening-canonical-la', 'tenant-demo', 'warehouse-la', 'inventory-canonical-la', 'OPENING', 7, 'seed-opening-canonical-la', '2026-07-23 00:00:00.000'),
  ('transaction-opening-duplicate-la', 'tenant-demo', 'warehouse-la', 'inventory-duplicate-la', 'OPENING', 3, 'seed-opening-duplicate-la', '2026-07-23 00:00:00.000'),
  ('transaction-opening-ny', 'tenant-demo', 'warehouse-ny', 'inventory-ny', 'OPENING', 11, 'seed-opening-ny', '2026-07-23 00:00:00.000'),
  ('transaction-opening-other', 'tenant-other', 'warehouse-other-la', 'inventory-other', 'OPENING', 13, 'seed-opening-other', '2026-07-23 00:00:00.000');

INSERT INTO stock_movement (
  id,
  tenant_id,
  source_warehouse_id,
  destination_warehouse_id,
  status
) VALUES
  ('movement-la-to-ny', 'tenant-demo', 'warehouse-la', 'warehouse-ny', 'PENDING');
