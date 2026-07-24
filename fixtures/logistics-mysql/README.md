# SafeCommit OpenBoxes-derived executable fixture

This directory contains a deterministic **OpenBoxes-derived executable
fixture** for the SafeCommit logistics demo. It is not an official OpenBoxes
distribution, a full OpenBoxes deployment, or a copy of a customer database.
It uses synthetic data only.

## Source and license

- Domain source: [OpenBoxes](https://github.com/openboxes/openboxes), pinned for
  this fixture review at commit
  `99fb3e61d2ba220dc1d83847e4852e2846ee17f0`.
- Database guidance: OpenBoxes documents MySQL 8 as its primary database.
- Upstream license: Eclipse Public License 1.0. See the upstream
  [`LICENSE.md`](https://github.com/openboxes/openboxes/blob/develop/LICENSE.md).

The SQL in this fixture is a small, independently authored schema that models
the public OpenBoxes warehouse, inventory, stock-movement, order, allocation,
lot, and serial-number concepts. Table and column names are intentionally
simplified for a three-minute executable safety demonstration. Do not describe
it as the complete or official OpenBoxes schema.

## Deterministic MySQL 8 startup

The pinned runtime is `mysql:8.0.36`. With Docker available:

```powershell
docker compose -f fixtures/logistics-mysql/docker-or-snapshot/compose.yaml up -d
```

The service binds only to `127.0.0.1:33067`, initializes `schema/001_schema.sql`
and `seed/002_seed.sql`, and exposes the synthetic `safecommit` database. Stop
and delete its volume to recreate the exact seed:

```powershell
docker compose -f fixtures/logistics-mysql/docker-or-snapshot/compose.yaml down -v
```

Credentials in the Compose file are fixture-only local credentials. Provider
keys and production database credentials must never be placed here.

## Main task traps

The seed deliberately contains:

- two demo-tenant warehouses plus a same-code warehouse in another tenant;
- duplicate `DEMO-SKU-42` products with different business relationships;
- cancelled and shipped orders;
- allocations in both allowed and forbidden warehouses;
- preserved lot, expiration, and serial-number relationships;
- same-name/SKU rows in a different tenant.

The expected baseline summary is in `expected/baseline-state.json`. The
orchestrator computes a canonical SHA-256 digest from live query results and
requires it to match before executing a candidate.
