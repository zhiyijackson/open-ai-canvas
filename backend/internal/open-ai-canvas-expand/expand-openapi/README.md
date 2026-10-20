# expand-openapi facade

This package is an additive facade over existing host HTTP handlers. It owns a
small local SQLite journal for extension operation idempotency and output-to-
asset bindings. Authentication, billing, generation, resources, and the asset
library remain host-owned.

The host entry point in `cmd/server/main.go` creates the manager, registers the
facade, starts background materialization, and closes the manager on shutdown.
If initialization fails it registers unavailable responses for the extension
and leaves the ordinary host running.

`api` is the host `/api` router group and `hostRouter` serves the original
`/api` routes. The facade rewrites only fixed, method-specific allowlisted paths
from `/api/expand-openapi/v1/...` to `/api/...`. It cannot select a network
target, expose admin routes, or retry writes.

Passing the same Gin root router as `hostRouter` is supported and keeps the
original handlers authoritative. A delegated request enters root middleware a
second time after its path is rewritten. Registration code must account for that
when middleware has side effects such as logging or request metrics; this package
does not bypass or copy host middleware.

The allowlist also reserves known static route segments before matching dynamic
resource or asset IDs. When upstream adds a static route beneath an allowlisted
dynamic prefix, compatibility tests and the reserved-segment list must be
reviewed before updating the host baseline.

`GET /api/expand-openapi/v1/openapi.json` describes stable client fields and
keeps provider-specific parameters open. `POST /workbench/tasks` and the
image/video subset of `POST /tasks` require `clientOperationId`. The journal is
stored under `<CANVAS_BACKEND_DATA_DIR>/open-ai-canvas-expand/expand.db` and is
migrated independently at startup; it never participates in host schema
migrations. This local journal assumes one host backend process for a data
directory.

An operation that was claimed but has no bound host task after process restart
is reported as unknown and is never submitted again automatically. This is an
intentional billing-safety tradeoff: the client must use a new operation ID only
after an operator has confirmed that the original host task was not created.
The private trace used during synchronous host dispatch is removed from the
response and is authorized only while that dispatch is active.

The background materializer reads only tasks recorded by this facade, reuses
their host-owned Resource rows, and calls the host UserAsset/UpsertUserAsset
contract. It does not copy media bytes or write core tables directly. A durable
output binding prevents a user-deleted generated asset from being recreated.
