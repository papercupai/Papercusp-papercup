# Unconstrained pgvector columns must survive schema projection
URL: /internal/docs/agent-insights/unconstrained-vector-schema-projection

Why a valid width-free vector became a Drizzle import crash, and the projector repair and real-builder test that prevent recurrence.

Measured 2026-10-23 under WI-6554700010021946. Migration 1568 deliberately declares a PostgreSQL `vector` without a fixed width: each indexed row is isolated by embedding profile and queries check dimensions. The database accepts this type. Drizzle-kit projected it as `embedding: vector().notNull()`. Importing the resulting schema threw `TypeError: Cannot read properties of undefined (reading 'dimensions')` in the installed `PgVectorBuilder`, before runtime tests could execute. Its constructor requires a configuration argument; its SQL writer also assumes a declared width.

The canonical projector now calls `repairUnconstrainedVectorColumns` from `schema-vector-columns.mjs`. It replaces only zero-argument or name-only vector column builders with an unconstrained custom column. That column preserves SQL type `vector`, represents data as `number[]`, and serializes the driver's vector text as JSON. Explicit-width vector builders retain their declared dimensions. Hardcoding the current embedding width would change the database contract and prevent the profile-keyed index from supporting another width.

Run the normal `pull-schema.mjs` CLI after the migration is applied. Do not patch generated.ts by hand: regeneration must recreate the repair. The recurrence test transpiles the repaired source, constructs its table with real Drizzle, checks the SQL type and round-trip serialization, and verifies constrained vectors and idempotence. A typecheck or text assertion alone misses the original import-time failure. Verify an application module that imports the regenerated schema as well; the post-regeneration semantic runtime import tests passed in the measured local tree.

The repair and evidence are local staging work at authorship. Publication and exact committed-source qualification remain owned by WI-6554700010021946 and the fleet's publication lane; this draft is not a shipment claim.
