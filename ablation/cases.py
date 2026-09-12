"""Curated, behavior-level ablations for the Cairn Share repository.

Each case changes one capability in an isolated copy of the repository.  Exact
replacements intentionally fail validation when production code drifts, so an
old experiment can never silently mutate the wrong code.
"""

from __future__ import annotations


def replace(old: str, new: str, count: int = 1) -> dict[str, object]:
    return {"kind": "replace", "old": old, "new": new, "count": count}


def empty_file() -> dict[str, object]:
    return {"kind": "empty_file"}


CASES: list[dict[str, object]] = [
    {
        "id": "worker-server-timing",
        "platform": "worker",
        "area": "observability",
        "description": "Remove the Server-Timing response instrumentation.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            "    return withServerTiming(response, timing);",
            "    return response;",
        ),
    },
    {
        "id": "worker-public-auth",
        "platform": "worker",
        "area": "security",
        "description": "Bypass bearer authentication for the public links API.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            """function requireApiToken(request: Request, env: Env): Response | null {
  return requireBearerToken(request, env.CAIRN_API_TOKEN);
}""",
            """function requireApiToken(_request: Request, _env: Env): Response | null {
  return null;
}""",
        ),
    },
    {
        "id": "worker-enricher-auth",
        "platform": "worker",
        "area": "security",
        "description": "Bypass the separate bearer token for enrichment endpoints.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            """function requireEnricherToken(request: Request, env: Env): Response | null {
  return requireBearerToken(request, env.CAIRN_ENRICHER_TOKEN);
}""",
            """function requireEnricherToken(_request: Request, _env: Env): Response | null {
  return null;
}""",
        ),
    },
    {
        "id": "worker-method-guard",
        "platform": "worker",
        "area": "routing",
        "description": "Allow every HTTP method through routeMethod.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            "  if (allowed.includes(request.method as \"GET\" | \"POST\" | \"PATCH\" | \"DELETE\")) {",
            "  if (true || allowed.includes(request.method as \"GET\" | \"POST\" | \"PATCH\" | \"DELETE\")) {",
        ),
    },
    {
        "id": "worker-create-content-type",
        "platform": "worker",
        "area": "validation",
        "description": "Accept non-JSON content types on all JSON write endpoints.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            """  if (contentType.toLowerCase().split(\";\")[0].trim() !== \"application/json\") {
    return error(\"invalid_content_type\");
  }""",
            """  if (false && contentType.toLowerCase().split(\";\")[0].trim() !== \"application/json\") {
    return error(\"invalid_content_type\");
  }""",
            count=3,
        ),
    },
    {
        "id": "worker-url-userinfo-validation",
        "platform": "worker",
        "area": "validation",
        "description": "Allow HTTP URLs containing username/password userinfo.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            "    if (parsed.username !== \"\" || parsed.password !== \"\") return false;",
            "    if (false && (parsed.username !== \"\" || parsed.password !== \"\")) return false;",
        ),
    },
    {
        "id": "worker-input-length-limits",
        "platform": "worker",
        "area": "validation",
        "description": "Remove URL and note length limits from link creation.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            "  if (url.length > MAX_URL_LENGTH || note.length > MAX_NOTE_LENGTH) {",
            "  if (false && (url.length > MAX_URL_LENGTH || note.length > MAX_NOTE_LENGTH)) {",
        ),
    },
    {
        "id": "worker-idempotent-create",
        "platform": "worker",
        "area": "persistence",
        "description": "Remove client_id conflict handling from link creation.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            "        ON CONFLICT(client_id) DO UPDATE SET client_id = excluded.client_id\n",
            "",
        ),
    },
    {
        "id": "worker-learned-filter",
        "platform": "worker",
        "area": "query",
        "description": "Ignore the learned-state filter on public list requests.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            """    if (learned !== undefined) {
      clauses.push(\"learned = ?\");
      bindings.push(learned ? 1 : 0);
    }""",
            "",
        ),
    },
    {
        "id": "worker-before-id-pagination",
        "platform": "worker",
        "area": "query",
        "description": "Ignore before_id when listing public links.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            """    if (beforeId !== undefined) {
      clauses.push(\"id < ?\");
      bindings.push(beforeId);
    }""",
            "",
        ),
    },
    {
        "id": "worker-like-escaping",
        "platform": "worker",
        "area": "query",
        "description": "Stop escaping SQL LIKE wildcard characters in searches.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            "  return value.replace(/[\\\\%_]/g, (match) => `\\\\${match}`);",
            "  return value;",
        ),
    },
    {
        "id": "worker-cache-hit",
        "platform": "worker",
        "area": "cache",
        "description": "Ignore shared-cache hits and always query D1.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            "  if (cached !== undefined) {",
            "  if (false && cached !== undefined) {",
        ),
    },
    {
        "id": "worker-cache-cookie-bypass",
        "platform": "worker",
        "area": "cache",
        "description": "Cache requests carrying Cookie headers.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            "  if (request.headers.has(\"cookie\")) {",
            "  if (false && request.headers.has(\"cookie\")) {",
        ),
    },
    {
        "id": "worker-cache-invalidation",
        "platform": "worker",
        "area": "cache",
        "description": "Keep the cache generation unchanged after writes.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            "          value = cache_metadata.value + 1,",
            "          value = cache_metadata.value,",
        ),
    },
    {
        "id": "worker-enrichment-reset-on-edit",
        "platform": "worker",
        "area": "enrichment",
        "description": "Keep stale enrichment data after URL or note edits.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            "  if (enrichmentInputChanged) {",
            "  if (false && enrichmentInputChanged) {",
        ),
    },
    {
        "id": "worker-learned-timestamp",
        "platform": "worker",
        "area": "persistence",
        "description": "Never record learned_at when a link becomes learned.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            "    bindings.push(body.learned ? 1 : 0, body.learned ? new Date().toISOString() : null);",
            "    bindings.push(body.learned ? 1 : 0, null);",
        ),
    },
    {
        "id": "worker-delete-persistence",
        "platform": "worker",
        "area": "persistence",
        "description": "Return success from DELETE without removing the row.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            "env.DB.prepare(\"DELETE FROM links WHERE id = ? RETURNING id\")",
            "env.DB.prepare(\"SELECT id FROM links WHERE id = ?\")",
        ),
    },
    {
        "id": "worker-x-only-claim",
        "platform": "worker",
        "area": "enrichment",
        "description": "Allow non-X links into the enrichment queue.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            """          FROM links
          WHERE ${X_LINK_SQL}
            AND curation_status <> 'drop'
            AND enrichment_attempts < ?""",
            """          FROM links
          WHERE 1 = 1
            AND curation_status <> 'drop'
            AND enrichment_attempts < ?""",
        ),
    },
    {
        "id": "worker-enrichment-fifo",
        "platform": "worker",
        "area": "enrichment",
        "description": "Claim newest enrichment jobs first instead of FIFO.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace("          ORDER BY id ASC", "          ORDER BY id DESC"),
    },
    {
        "id": "worker-completion-lease",
        "platform": "worker",
        "area": "concurrency",
        "description": "Accept any non-empty lease token when completing a job.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            """          AND enrichment_status = 'processing'
          AND enrichment_lease_token = ?
        RETURNING id`""",
            """          AND enrichment_status = 'processing'
          AND ? IS NOT NULL
        RETURNING id`""",
        ),
    },
    {
        "id": "worker-retry-backoff",
        "platform": "worker",
        "area": "resilience",
        "description": "Retry failed enrichment work immediately instead of backing off.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            ": new Date(now.getTime() + ENRICHMENT_RETRY_DELAYS_MILLISECONDS[delayIndex]).toISOString();",
            ": now.toISOString();",
        ),
    },
    {
        "id": "worker-image-source-allowlist",
        "platform": "worker",
        "area": "security",
        "description": "Silently accept and drop image URLs outside the allow-list.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            "    if (!isAllowedImageUrl(imageUrl)) return null;",
            "    if (!isAllowedImageUrl(imageUrl)) continue;",
        ),
    },
    {
        "id": "worker-image-content-type",
        "platform": "worker",
        "area": "security",
        "description": "Stop rejecting unsupported image response content types.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            "  if (contentType === null) throw new Error(\"unsupported image content type\");",
            "  if (contentType === null) return { key: 'unsupported', content_type: 'image/png' };",
        ),
    },
    {
        "id": "worker-image-stream-limit",
        "platform": "worker",
        "area": "security",
        "description": "Remove the streaming image-size cutoff.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace("      if (total > limit) {", "      if (false && total > limit) {"),
    },
    {
        "id": "worker-public-learned-mapping",
        "platform": "worker",
        "area": "contract",
        "description": "Map every public link to learned=false.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace("    learned: row.learned === 1,", "    learned: false,"),
    },
    {
        "id": "worker-trailing-slash-routing",
        "platform": "worker",
        "area": "routing",
        "description": "Stop normalizing trailing slashes in request paths.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace(
            "  return path.length > 1 && path.endsWith(\"/\") ? path.slice(0, -1) : path;",
            "  return path;",
        ),
    },
    {
        "id": "worker-debug-console",
        "platform": "worker",
        "area": "debug-ui",
        "description": "Remove the visible API operations from the debug console.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace("function apiDebugHtml(): string {\n  return `<!doctype html>", "function apiDebugHtml(): string {\n  return `<!doctype html><title>ablated</title><!--"),
    },
    {
        "id": "worker-cors-origin",
        "platform": "worker",
        "area": "contract",
        "description": "Remove Access-Control-Allow-Origin from all responses.",
        "file": "worker/src/index.ts",
        "verifier": "worker_test",
        "mutation": replace("  \"Access-Control-Allow-Origin\": \"*\",\n", ""),
    },
    {
        "id": "worker-env-r2-contract",
        "platform": "worker",
        "area": "types",
        "description": "Remove the typed R2 bucket contract from Env.",
        "file": "worker/src/index.ts",
        "verifier": "worker_typecheck",
        "mutation": replace("  ENRICHMENT_IMAGES: R2Bucket;", "  ENRICHMENT_IMAGES: unknown;"),
    },
    *[
        {
            "id": f"migration-{number}",
            "platform": "worker",
            "area": "schema",
            "description": f"Remove schema migration {number} from a fresh database.",
            "file": f"worker/migrations/{filename}",
            "verifier": "worker_test",
            "mutation": empty_file(),
        }
        for number, filename in [
            ("0001", "0001_create_links.sql"),
            ("0002", "0002_add_learned_state.sql"),
            ("0003", "0003_add_cache_metadata.sql"),
            ("0004", "0004_add_client_id.sql"),
            ("0005", "0005_add_x_enrichment.sql"),
            ("0006", "0006_add_rich_x_enrichment.sql"),
            ("0007", "0007_add_bookmark_curation.sql"),
        ]
    ],
    {
        "id": "android-native-clip-text",
        "platform": "android",
        "area": "share-input",
        "description": "Ignore text carried by ClipData items.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/NativeShareSources.kt",
        "verifier": "android_unit",
        "mutation": replace(
            """        texts = buildList {
            extraText?.let(::add)
            for (index in 0 until clipItemCount) {
                clipTextAt(index)?.takeIf(String::isNotBlank)?.let(::add)
            }
        },""",
            """        texts = buildList {
            extraText?.let(::add)
        },""",
        ),
    },
    {
        "id": "android-text-url-extraction",
        "platform": "android",
        "area": "share-input",
        "description": "Extract URLs only from structured URI fields, not shared text.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/contract/UrlCandidateExtractor.kt",
        "verifier": "android_unit",
        "mutation": replace(
            """            payload.texts.forEach { text ->
                urlRegex.findAll(text).forEach { add(it.value) }
            }""",
            "",
        ),
        "covers": ["android/app/src/main/java/com/alpenl/cairn/share/contract/SharePayload.kt"],
    },
    {
        "id": "android-url-deduplication",
        "platform": "android",
        "area": "share-input",
        "description": "Keep duplicate URL candidates from multiple share sources.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/contract/UrlCandidateExtractor.kt",
        "verifier": "android_unit",
        "mutation": replace(
            "            if (seen.add(deduplicationKey(candidate.submissionValue))) {",
            "            if (true || seen.add(deduplicationKey(candidate.submissionValue))) {",
        ),
        "covers": ["android/app/src/main/java/com/alpenl/cairn/share/contract/UrlCandidate.kt"],
    },
    {
        "id": "android-display-path",
        "platform": "android",
        "area": "presentation",
        "description": "Remove URL paths from compact display labels.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/contract/UrlDisplayLabel.kt",
        "verifier": "android_unit",
        "mutation": replace(
            "        append(if (rawPath.isNullOrEmpty()) \"/\" else rawPath)",
            "        Unit",
        ),
    },
    {
        "id": "android-single-auto-selection",
        "platform": "android",
        "area": "share-ui-model",
        "description": "Do not preselect a single shared URL.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/ShareCandidatePresenter.kt",
        "verifier": "android_unit",
        "mutation": replace("        if (candidates.size == 1) 0 else -1", "        -1"),
    },
    {
        "id": "android-submit-lock",
        "platform": "android",
        "area": "share-ui-model",
        "description": "Leave Save enabled while a submission is in progress.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/ShareCandidatePresenter.kt",
        "verifier": "android_unit",
        "mutation": replace(
            "            saveEnabled = selected != null && !submitting,",
            "            saveEnabled = selected != null,",
        ),
    },
    {
        "id": "android-client-id-json",
        "platform": "android",
        "area": "contract",
        "description": "Omit client_id from upload request JSON.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/network/LinkRequestJson.kt",
        "verifier": "android_unit",
        "mutation": replace(
            "            .apply { clientId?.let { put(\"client_id\", it) } }",
            "            .apply { Unit }",
        ),
    },
    {
        "id": "android-pending-failure-metadata",
        "platform": "android",
        "area": "local-queue",
        "description": "Discard pending-upload attempt counts during JSON encoding.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/PendingUploadStore.kt",
        "verifier": "android_unit",
        "mutation": replace(
            "                        .put(\"attempt_count\", upload.attemptCount)",
            "                        .put(\"attempt_count\", 0)",
        ),
    },
    {
        "id": "android-share-auth-header",
        "platform": "android",
        "area": "security",
        "description": "Do not attach the bearer token to share uploads.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/network/ShareApiClient.kt",
        "verifier": "android_unit",
        "mutation": replace(
            "            if (apiToken.isNotBlank()) {",
            "            if (false && apiToken.isNotBlank()) {",
        ),
    },
    {
        "id": "android-semver-comparison",
        "platform": "android",
        "area": "updates",
        "description": "Treat every release version as equal to the installed version.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/network/UpdateApiClient.kt",
        "verifier": "android_unit",
        "mutation": replace(
            """    fun compare(left: String, right: String): Int {
        val leftParts = parts(left)""",
            """    fun compare(left: String, right: String): Int {
        if (left.isNotEmpty() && right.isNotEmpty()) return 0
        val leftParts = parts(left)""",
        ),
    },
    {
        "id": "android-default-user-agent",
        "platform": "android",
        "area": "contract",
        "description": "Replace the versioned Android User-Agent with an empty value.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/network/AppUserAgent.kt",
        "verifier": "android_unit",
        "mutation": replace(
            "        \"CairnShareAndroid/$versionName (Android)\"",
            "        \"\"",
        ),
    },
    {
        "id": "android-query-fragment-removal",
        "platform": "android",
        "area": "url-policy",
        "description": "Keep query and fragment even when the preference disables them.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/LinkPresentation.kt",
        "verifier": "android_unit",
        "mutation": replace(
            """internal fun removeQueryAndFragment(value: String): String =
    runCatching {
        val uri = URI(value.trim())
        buildString {
            append(uri.scheme.lowercase(Locale.ROOT)).append(\"://\").append(uri.rawAuthority)
            append(uri.rawPath?.takeIf { it.isNotEmpty() } ?: \"/\")
        }
    }.getOrDefault(value.trim())""",
            "internal fun removeQueryAndFragment(value: String): String = value.trim()",
        ),
    },
    {
        "id": "android-links-page-decoding",
        "platform": "android",
        "area": "contract",
        "description": "Decode every server list response as an empty page.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/network/LinksApiClient.kt",
        "verifier": "android_unit",
        "device_test": "launcherEntryShowsLibraryAndCanEditToggleAndDeleteLinks",
        "mutation": replace(
            "        val items = page.optJSONArray(\"items\") ?: JSONArray()",
            "        val items = JSONArray()",
        ),
    },
    {
        "id": "android-library-page-load",
        "platform": "android",
        "area": "view-model",
        "description": "Return an empty library without contacting the API.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/CairnLinksViewModel.kt",
        "verifier": "android_unit",
        "device_test": "launcherEntryShowsLibraryAndCanEditToggleAndDeleteLinks",
        "mutation": replace(
            "val result = withContext(Dispatchers.IO) { repository.listPage(LinkFilter.All, \"\", apiToken, beforeId) }",
            "val result: LinkPageResult = LinkPageResult.Loaded(com.alpenl.cairn.share.network.LinkPage(emptyList(), null))",
        ),
    },
    {
        "id": "android-viewmodel-library-filter",
        "platform": "android",
        "area": "view-model",
        "description": "Hide every link from the library view model projection.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/CairnLinksViewModel.kt",
        "verifier": "android_unit",
        "device_test": "launcherEntryShowsLibraryAndCanEditToggleAndDeleteLinks",
        "mutation": replace(
            "internal fun CairnLinksUiState.visibleLibraryLinks(): List<SavedLink> {",
            "internal fun CairnLinksUiState.visibleLibraryLinks(): List<SavedLink> { return emptyList();",
        ),
    },
    {
        "id": "android-share-recreation-note",
        "platform": "android",
        "area": "activity-lifecycle",
        "description": "Do not preserve the share note across Activity recreation.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/ShareActivity.kt",
        "verifier": "android_unit",
        "device_test": "recreationPreservesSelectionAndNoteWithoutSubmitting",
        "mutation": replace(
            "        outState.putString(STATE_NOTE, note)",
            "        outState.putString(STATE_NOTE, \"\")",
        ),
    },
    {
        "id": "android-durable-before-network",
        "platform": "android",
        "area": "local-queue",
        "description": "Construct an upload in memory instead of persisting it before POST.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/ShareActivity.kt",
        "verifier": "android_unit",
        "device_test": "failedPostIsKeptLocallyWithoutASecondSubmission",
        "mutation": replace(
            "            val pending = runCatching { pendingUploadStore.enqueue(preparedUrl, note) }.getOrNull()",
            """            val pending = PendingUpload(
                id = \"00000000-0000-4000-8000-000000000000\",
                url = preparedUrl,
                note = note,
                createdAtEpochMillis = System.currentTimeMillis(),
            )""",
        ),
    },
    {
        "id": "android-preference-write",
        "platform": "android",
        "area": "settings",
        "description": "Drop API-token preference writes.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/SharePreferencesStore.kt",
        "verifier": "android_unit",
        "device_test": "singleLinkIsNotSubmittedUntilUserAddsNoteAndSaves",
        "mutation": replace(
            "        dataStore.edit { it[ApiTokenKey] = value.trim() }",
            "        Unit",
        ),
    },
    {
        "id": "android-pending-remove",
        "platform": "android",
        "area": "local-queue",
        "description": "Keep successfully uploaded entries in the pending queue.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/PendingUploadStore.kt",
        "verifier": "android_unit",
        "device_test": "launcherAutomaticallyRetriesLocalQueueAndAllowsManualRetry",
        "mutation": replace(
            """    suspend fun remove(id: String) {
        dataStore.edit { values ->
            val current = PendingUploadJson.decode(values[UploadsKey].orEmpty())
            values[UploadsKey] = PendingUploadJson.encode(current.filterNot { it.id == id })
        }
    }""",
            """    suspend fun remove(id: String) {
        id.length
    }""",
        ),
    },
    {
        "id": "android-update-download-success",
        "platform": "android",
        "area": "updates",
        "description": "Report a completed APK download as failed.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/UpdateApkDownloader.kt",
        "verifier": "android_unit",
        "covers": ["android/app/src/main/java/com/alpenl/cairn/share/AppUpdateState.kt"],
        "mutation": replace(
            "            UpdateDownloadResult.Downloaded(apkFile)",
            "            UpdateDownloadResult.Failed",
        ),
    },
    {
        "id": "android-debug-path-confinement",
        "platform": "android",
        "area": "security",
        "description": "Allow absolute URLs in the in-app API debug client.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/network/ApiDebugClient.kt",
        "verifier": "android_unit",
        "mutation": replace(
            "        if (trimmed.isBlank() || trimmed.startsWith(\"http://\") || trimmed.startsWith(\"https://\")) return null",
            "        if (trimmed.isBlank()) return null",
        ),
    },
    {
        "id": "android-launcher-copy",
        "platform": "android",
        "area": "launcher",
        "description": "Do not put links on the clipboard.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/LauncherActivity.kt",
        "verifier": "android_unit",
        "mutation": replace(
            "        clipboard.setPrimaryClip(ClipData.newPlainText(getString(R.string.app_name), url))",
            "        Unit",
        ),
    },
    {
        "id": "android-theme-wrapper",
        "platform": "android",
        "area": "ui-theme",
        "description": "Render content without the application Material theme.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/ui/theme/CairnShareTheme.kt",
        "verifier": "android_unit",
        "mutation": replace(
            """    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        shapes = AppShapes,
        content = content,
    )""",
            "    content()",
        ),
    },
    {
        "id": "android-settings-navigation",
        "platform": "android",
        "area": "ui-navigation",
        "description": "Remove the settings destination from bottom navigation.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/CairnLinksApp.kt",
        "verifier": "android_unit",
        "device_test": "launcherEntryShowsLibraryAndCanEditToggleAndDeleteLinks",
        "mutation": replace(
            "    TopDestination(Routes.Settings, \"设置\", Icons.Default.Settings),",
            "",
        ),
    },
    {
        "id": "android-share-intent-filter",
        "platform": "android",
        "area": "packaging",
        "description": "Remove ACTION_SEND discovery from the Android manifest.",
        "file": "android/app/src/main/AndroidManifest.xml",
        "verifier": "android_build",
        "mutation": replace(
            """                <action android:name=\"android.intent.action.SEND\" />
                <category android:name=\"android.intent.category.DEFAULT\" />
                <data android:mimeType=\"text/plain\" />""",
            """                <category android:name=\"android.intent.category.DEFAULT\" />""",
        ),
    },
    {
        "id": "android-file-provider",
        "platform": "android",
        "area": "packaging",
        "description": "Remove the FileProvider required by in-app APK installation.",
        "file": "android/app/src/main/AndroidManifest.xml",
        "verifier": "android_build",
        "mutation": replace(
            """        <provider
            android:name=\"androidx.core.content.FileProvider\"
            android:authorities=\"${applicationId}.fileprovider\"
            android:exported=\"false\"
            android:grantUriPermissions=\"true\">
            <meta-data
                android:name=\"android.support.FILE_PROVIDER_PATHS\"
                android:resource=\"@xml/update_file_paths\" />
        </provider>
""",
            "",
        ),
    },
    {
        "id": "android-unsupported-share-message",
        "platform": "android",
        "area": "resources",
        "description": "Replace the unsupported-share error with an empty message.",
        "file": "android/app/src/main/res/values/strings.xml",
        "verifier": "android_unit",
        "device_test": "unsupportedShareShowsNoSaveableLink",
        "mutation": replace(
            "<string name=\"share_no_supported_content\">没有发现 HTTP 或 HTTPS 链接。</string>",
            "<string name=\"share_no_supported_content\"> </string>",
        ),
    },
]


CASES.extend([
    {
        "id": "worker-app-enrichment-projection", "platform": "worker", "area": "app-sync",
        "description": "Remove the opt-in enrichment projection from public App reads.",
        "file": "worker/src/index.ts", "verifier": "worker_test",
        "mutation": replace('  return url.searchParams.get("include") === "enrichment";', '  return false;'),
    },
    {
        "id": "worker-enriched-cache-migration", "platform": "worker", "area": "persistence",
        "description": "Remove transactional cache invalidation for enrichment and curation updates.",
        "file": "worker/migrations/0008_invalidate_enriched_link_cache.sql", "verifier": "worker_test",
        "mutation": replace('SET value = value + 1,', 'SET value = value,'),
    },
    {
        "id": "worker-compact-content", "platform": "worker", "area": "performance",
        "description": "Transfer full bodies in compact list responses.",
        "file": "worker/src/index.ts", "verifier": "worker_test",
        "mutation": replace('  return summary\n    ? "NULL AS original_text', '  return false\n    ? "NULL AS original_text'),
    },
    {
        "id": "android-enrichment-decoding", "platform": "android", "area": "app-sync",
        "description": "Discard enhancement fields when decoding a bookmark.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/network/LinksApiClient.kt", "verifier": "android_unit",
        "mutation": replace('            enrichment = json.optJSONObject("enrichment")?.let(::decodeEnrichment),', '            enrichment = null,'),
    },
    {
        "id": "android-content-revision", "platform": "android", "area": "app-sync",
        "description": "Retain stale full text after the server changes the content revision.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/network/LinkEnrichment.kt", "verifier": "android_unit",
        "mutation": replace('fresh.updatedAt != loaded.updatedAt || ', ''),
    },
    {
        "id": "android-topic-filter", "platform": "android", "area": "curation",
        "description": "Ignore the selected topic in the library.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/network/BookmarkFilters.kt", "verifier": "android_unit",
        "mutation": replace('(topic.isBlank() || topic in labels?.topics.orEmpty())', 'true'),
    },
    {
        "id": "android-progressive-library", "platform": "android", "area": "performance",
        "description": "Wait for all pages before making any links visible.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/CairnLinksViewModel.kt", "verifier": "android_unit",
        "device_test": "firstPageIsVisibleBeforeLaterPagesComplete", "device_class": "com.alpenl.cairn.share.EnrichmentInstrumentedTest",
        "mutation": replace('                            links = items,', '                            links = if (next == null) items else uiState.links,'),
    },
    {
        "id": "android-archived-image", "platform": "android", "area": "app-sync",
        "description": "Use an invalid archive key so App images cannot load.",
        "file": "android/app/src/main/java/com/alpenl/cairn/share/BookmarkContent.kt", "verifier": "android_unit",
        "device_test": "readsBilingualContentImagesAndSavesCuration", "device_class": "com.alpenl.cairn.share.EnrichmentInstrumentedTest",
        "mutation": replace('LinksApiClient(baseUrl).image(imageKey, apiToken)', 'LinksApiClient(baseUrl).image("invalid", apiToken)'),
    },
])


# Files with no independently executable behavior are covered through the case
# that exercises or breaks their consumers. They remain explicit in the report.
STRUCTURAL_COVERAGE: dict[str, list[str]] = {
    "worker/src/env.d.ts": ["worker-env-r2-contract"],
    "android/app/src/main/java/com/alpenl/cairn/share/AppUpdateState.kt": ["android-update-download-success"],
    "android/app/src/main/java/com/alpenl/cairn/share/contract/SharePayload.kt": ["android-text-url-extraction"],
    "android/app/src/main/java/com/alpenl/cairn/share/contract/UrlCandidate.kt": ["android-url-deduplication"],
}


EXCLUDED_TRACKED_CODE: dict[str, str] = {
    "design/cairn-links-app.html": "Design reference only; README states that it is not runtime code.",
    "android/app/src/androidTest/java/com/alpenl/cairn/share/ShareActivityInstrumentedTest.kt": "Outcome metric, not treatment code.",
    "worker/test/index.test.ts": "Outcome metric, not treatment code.",
}
