# Source-bound manual material, capability 1

This increment implements the manual-first, observable-gap path from B07-T07
and B09-T05. It is not the completion of either whole issue. It adds no schema
migration and does not enable a provider or change the active production target.

## Exact boundary

The App uses `GET` and `POST /api/bookmarks/{id}/manual-material` with its existing
App credential and `X-Cairn-App-Manual-Material: 1`. The paired Go client uses the
same capability at `/api/v2/links/{id}/manual-material` with the internal credential.
All responses are `no-store`. No arbitrary management route, URL fetch, model
selection, OCR provider, or original-source replacement is exposed.

GET runs only when the user opens or refreshes this section. It returns the current
source revision, snapshot ID, hash, target generation, a refusal reason, and at most
134 known gap references. Available kinds are a listed external link not completely
acquired, a stored image without a confirmed transcription, or an observed truncated
source. Semantic uncertainty and a legitimate classification `none` are not gaps.

The source must have exactly one captured primary block matching the saved original.
A registered v2 target is required. Missing primary sources, dropped bookmarks,
active or ambiguous leases, and unconfirmed paid results block the operation.
An unpaired classification reservation or an error response with missing usage is
conservatively unconfirmed; a historical success is not retried just for missing usage.

## Submit and receipt

POST accepts exactly `version=1`, `operation_key`, `expected_content_revision`,
`evidence_snapshot_id`, `source_hash`, `target_generation`, `kind`, `source_ref`, and
`text`. Text is bounded to 100,000 UTF-8 bytes and the request to 128 KiB. Its gap
must still belong to this bookmark and source. Arbitrary links and foreign image
references are refused. The source, target, material references, paid-result status
and leases are checked again at the actual transaction boundary.

One D1 transaction records a terminal `evidence_requests` protocol-2 receipt,
appends a new immutable evidence snapshot, advances the source once, and queues
classification once. Protocol-1 fetch consumers cannot execute these terminal
manual rows. A repeated nonce/body returns its original receipt before checking
newer input or leases. A changed body under the nonce is refused. Repeated exact
kind/reference/text under a fresh nonce does not create another version or queue.

The old primary, all old blocks, images, reading title/summary/translation, and
human curation are retained. Image text has `legacy_unknown` authorship rather
than invented attribution. A primary continuation is `author_continuation`, never
a second primary. New blocks record `acquired=manual`, reason, source reference,
scope and `partial=true`; existing truncation is not cleared. A fragment does not
claim the entire image, external article or source has been captured.

The source archive keeps the original text bytes. Existing bounded model-input
preparation may trim surrounding whitespace or truncate with an explicit flag.
It now also retains the archived context's `relation` and `acquired` fields, so
manual/partial provenance reaches the actual provider state.

`model_calls=0` is the immediate save operation only. A changed source schedules
the existing classification consumer, which can incur its normal model cost.
The confirmation button explains this. `classification_queued` in a replay is a
historical receipt, not a claim about the queue's present state. GET, response
recovery and unchanged content never independently start a new classification.

## Android durability and isolation

Before the first network byte, the exact intent is atomically persisted alongside
the existing curation/deletion journal. Only a full credential/server fingerprint
and bookmark ID select it; credentials are not stored. Opening a page never drains
these intents. A timeout, redirect, missing acknowledgement or malformed success
remains unknown and keeps the same nonce/body for an explicit confirmation retry.
A marked refusal preserves the text and allows a new bound request only after the
user deliberately prepares it against current source capabilities.

Journal updates use compare-and-set. A late acknowledgement cannot delete a
replacement intent or another account's entry. Confirmed deletion clears this
bookmark's material intent in the same journal transaction and prevents a new one.
Whole-journal clearing also clears material intents. The journal is excluded from
Android cloud backup and device transfer. It bounds pending material intents to 20,
refuses overflow, and never silently evicts an unknown result.

Composition and pending callbacks belong to account fingerprint, session generation
and bookmark. Closing a session cancels its network work. Go and Android refuse
redirects and validate bounded, source/nonce-bound receipts; there is no old-route
fallback or automatic write retry.

## Remaining original scope

Source creation when there is no primary text, complete separate reading and
classification lifecycle capabilities/retry, controlled policy replay, the full
legacy/new capability matrix, and independent final review remain open. This path
does not substitute for the existing scoped external-fetch/OCR provider gates or
their complete acceptance. Operation/source retention also remains governed by the
original B03 audit requirements; this increment does not claim a new expiry policy.

All normal tests use isolated synthetic data and contract-model fixtures. No paid
provider calls, production migrations, merge, release or deployment are authorized
by a successful local test. Open-source release still requires the user's approval.
