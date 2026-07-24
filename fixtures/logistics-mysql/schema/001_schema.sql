SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE tenant (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  UNIQUE KEY uq_tenant_name (name)
) ENGINE=InnoDB;

CREATE TABLE warehouse (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(128) NOT NULL,
  CONSTRAINT fk_warehouse_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenant(id),
  UNIQUE KEY uq_warehouse_scope_id (tenant_id, id),
  UNIQUE KEY uq_warehouse_tenant_code (tenant_id, code)
) ENGINE=InnoDB;

CREATE TABLE location (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  warehouse_id VARCHAR(64) NOT NULL,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(128) NOT NULL,
  CONSTRAINT fk_location_warehouse
    FOREIGN KEY (tenant_id, warehouse_id)
    REFERENCES warehouse(tenant_id, id),
  UNIQUE KEY uq_location_scope_id (tenant_id, warehouse_id, id),
  UNIQUE KEY uq_location_warehouse_code (tenant_id, warehouse_id, code)
) ENGINE=InnoDB;

CREATE TABLE product (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  sku VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  canonical_product_id VARCHAR(64) NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT fk_product_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenant(id),
  CONSTRAINT fk_product_canonical
    FOREIGN KEY (tenant_id, canonical_product_id)
    REFERENCES product(tenant_id, id),
  UNIQUE KEY uq_product_tenant_id (tenant_id, id),
  KEY idx_product_tenant_sku (tenant_id, sku)
) ENGINE=InnoDB;

CREATE TABLE lot (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  product_id VARCHAR(64) NOT NULL,
  lot_number VARCHAR(64) NOT NULL,
  expiration_date DATE NOT NULL,
  CONSTRAINT fk_lot_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenant(id),
  CONSTRAINT fk_lot_product
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES product(tenant_id, id),
  UNIQUE KEY uq_lot_tenant_id (tenant_id, id),
  UNIQUE KEY uq_lot_tenant_product_number (tenant_id, product_id, lot_number)
) ENGINE=InnoDB;

CREATE TABLE inventory_item (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  warehouse_id VARCHAR(64) NOT NULL,
  location_id VARCHAR(64) NOT NULL,
  product_id VARCHAR(64) NOT NULL,
  lot_id VARCHAR(64) NULL,
  quantity DECIMAL(14, 3) NOT NULL,
  CONSTRAINT chk_inventory_quantity_nonnegative CHECK (quantity >= 0),
  CONSTRAINT fk_inventory_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenant(id),
  CONSTRAINT fk_inventory_warehouse
    FOREIGN KEY (tenant_id, warehouse_id)
    REFERENCES warehouse(tenant_id, id),
  CONSTRAINT fk_inventory_location
    FOREIGN KEY (tenant_id, warehouse_id, location_id)
    REFERENCES location(tenant_id, warehouse_id, id),
  CONSTRAINT fk_inventory_product
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES product(tenant_id, id),
  CONSTRAINT fk_inventory_lot
    FOREIGN KEY (tenant_id, lot_id)
    REFERENCES lot(tenant_id, id),
  UNIQUE KEY uq_inventory_tenant_id (tenant_id, id),
  UNIQUE KEY uq_inventory_scope_id (tenant_id, warehouse_id, id),
  KEY idx_inventory_scope (tenant_id, warehouse_id, product_id)
) ENGINE=InnoDB;

CREATE TABLE serial_number (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  inventory_item_id VARCHAR(64) NOT NULL,
  serial_number VARCHAR(128) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT fk_serial_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenant(id),
  CONSTRAINT fk_serial_inventory
    FOREIGN KEY (tenant_id, inventory_item_id)
    REFERENCES inventory_item(tenant_id, id),
  UNIQUE KEY uq_serial_tenant_value (tenant_id, serial_number)
) ENGINE=InnoDB;

CREATE TABLE order_header (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  warehouse_id VARCHAR(64) NOT NULL,
  status ENUM(
    'DRAFT',
    'PLACED',
    'ALLOCATED',
    'CANCELLED',
    'SHIPPED',
    'DELIVERED'
  ) NOT NULL,
  external_reference VARCHAR(128) NOT NULL,
  CONSTRAINT fk_order_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenant(id),
  CONSTRAINT fk_order_warehouse
    FOREIGN KEY (tenant_id, warehouse_id)
    REFERENCES warehouse(tenant_id, id),
  UNIQUE KEY uq_order_scope_id (tenant_id, warehouse_id, id),
  UNIQUE KEY uq_order_tenant_reference (tenant_id, external_reference)
) ENGINE=InnoDB;

CREATE TABLE order_line (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  warehouse_id VARCHAR(64) NOT NULL,
  order_id VARCHAR(64) NOT NULL,
  product_id VARCHAR(64) NOT NULL,
  quantity DECIMAL(14, 3) NOT NULL,
  CONSTRAINT chk_order_line_quantity_positive CHECK (quantity > 0),
  CONSTRAINT fk_order_line_order
    FOREIGN KEY (tenant_id, warehouse_id, order_id)
    REFERENCES order_header(tenant_id, warehouse_id, id),
  CONSTRAINT fk_order_line_product
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES product(tenant_id, id),
  UNIQUE KEY uq_order_line_scope_id (tenant_id, warehouse_id, id)
) ENGINE=InnoDB;

CREATE TABLE allocation (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  warehouse_id VARCHAR(64) NOT NULL,
  order_line_id VARCHAR(64) NOT NULL,
  inventory_item_id VARCHAR(64) NOT NULL,
  quantity DECIMAL(14, 3) NOT NULL,
  released_at DATETIME(3) NULL,
  CONSTRAINT chk_allocation_quantity_nonnegative CHECK (quantity >= 0),
  CONSTRAINT fk_allocation_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenant(id),
  CONSTRAINT fk_allocation_warehouse
    FOREIGN KEY (tenant_id, warehouse_id)
    REFERENCES warehouse(tenant_id, id),
  CONSTRAINT fk_allocation_order_line
    FOREIGN KEY (tenant_id, warehouse_id, order_line_id)
    REFERENCES order_line(tenant_id, warehouse_id, id),
  CONSTRAINT fk_allocation_inventory
    FOREIGN KEY (tenant_id, warehouse_id, inventory_item_id)
    REFERENCES inventory_item(tenant_id, warehouse_id, id),
  KEY idx_allocation_scope (tenant_id, warehouse_id, order_line_id)
) ENGINE=InnoDB;

CREATE TABLE inventory_transaction (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  warehouse_id VARCHAR(64) NOT NULL,
  inventory_item_id VARCHAR(64) NOT NULL,
  transaction_kind ENUM(
    'OPENING',
    'ADJUSTMENT',
    'ALLOCATION_RELEASE',
    'TRANSFER'
  ) NOT NULL,
  quantity_delta DECIMAL(14, 3) NOT NULL,
  correlation_key VARCHAR(128) NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_transaction_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenant(id),
  CONSTRAINT fk_transaction_warehouse
    FOREIGN KEY (tenant_id, warehouse_id)
    REFERENCES warehouse(tenant_id, id),
  CONSTRAINT fk_transaction_inventory
    FOREIGN KEY (tenant_id, warehouse_id, inventory_item_id)
    REFERENCES inventory_item(tenant_id, warehouse_id, id),
  UNIQUE KEY uq_transaction_correlation (tenant_id, correlation_key)
) ENGINE=InnoDB;

CREATE TABLE stock_movement (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  source_warehouse_id VARCHAR(64) NOT NULL,
  destination_warehouse_id VARCHAR(64) NOT NULL,
  status ENUM('PENDING', 'SHIPPED', 'RECEIVED', 'CANCELLED') NOT NULL,
  CONSTRAINT fk_movement_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenant(id),
  CONSTRAINT fk_movement_source
    FOREIGN KEY (tenant_id, source_warehouse_id)
    REFERENCES warehouse(tenant_id, id),
  CONSTRAINT fk_movement_destination
    FOREIGN KEY (tenant_id, destination_warehouse_id)
    REFERENCES warehouse(tenant_id, id)
) ENGINE=InnoDB;
