# Workspace read API

The independent UI uses `GET /api/enrichment/workspace` with the internal Enricher credential. The legacy list, reading, tag and collection contracts remain unchanged. No migration, background task, model call or data rewrite is required.

The response contains one summary page (40 items by default, at most 100), global tag/collection counts and dashboard aggregates. SQL uses the existing effective membership and search gram indexes. `q`, `quick`, `range`, `today`, stable `tags`, `mode`, `collection`, `kind` and the keyset `cursor` are validated. Counts do not change when paging; date range affects the dashboard, while search/tag/collection filters affect the list. Date grouping follows the stored bookmark date, with the client's local calendar day supplied explicitly.

`GET /api/enrichment/workspace/:id` loads the body and current editable tag state together. Supplying a validated `body_revision` omits unchanged body columns from the D1 read and response. The client must retain its matching body; every open still checks current server state, so deletion, source updates and manual tag changes are not hidden by a time-based browser cache. The browser retains at most 8 entries / 8 MiB of text for 5 minutes in memory only.

`GET /api/enrichment/workspace/collections/:id` pages members in collection order with 40 rows and one lookahead ID for ordering controls. It does not preload all collection members on the home page.

Reads return `private, no-store`; there is no shared cache of private user data. The proxy propagates compression and Server-Timing. The main response performs a fixed batch of bounded page and aggregate queries; no per-bookmark HTTP request, historical provenance fold, source body transfer, or model work occurs on the first screen.

Validation covers page/global count separation, body search, date and attention filters, internal authentication, invalid requests, custom tags, collection pagination, body revision revalidation and deletion. The existing full Worker suite also covers old clients and privacy behavior.
