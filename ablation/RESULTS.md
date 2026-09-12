# Cairn Share repository ablation results

Generated: `2026-09-05T02:45:49.218947+00:00`

Revision: `8d3f891`

Cases: `62`

## Method

Each case changes one behavior in a disposable copy of the tracked repository. The original source is never mutated. Worker cases run the Vitest/D1 suite, Android cases run JVM tests or build gates, and eligible Android survivors are escalated to one focused device test when `--device` is enabled. Device escalation occurs only when that exact test passes first on unmodified code.

A result of `SURVIVED` means the selected verification surface still passed; it does not prove the removed behavior is unnecessary. `KILLED_TEST` and `KILLED_DEVICE` mean assertions observed the regression. `KILLED_BUILD` means only the compiler, schema bootstrap, packaging, or test runtime stopped it.

## Baselines

| Verifier | Status | Tests | Passed | Failed | Seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| `worker_test` | PASS | 30 | 30 | 0 | 4.918 |
| `worker_typecheck` | PASS | 0 | 0 | 0 | 0.942 |
| `android_unit` | PASS | 24 | 24 | 0 | 5.191 |
| `android_build` | PASS | 0 | 0 | 0 | 36.766 |
| `android_device:launcherEntryShowsLibraryAndCanEditToggleAndDeleteLinks` | FAIL | 1 | 0 | 1 | 52.732 |
| `android_device:recreationPreservesSelectionAndNoteWithoutSubmitting` | PASS | 1 | 1 | 0 | 45.733 |
| `android_device:failedPostIsKeptLocallyWithoutASecondSubmission` | PASS | 1 | 1 | 0 | 47.633 |
| `android_device:singleLinkIsNotSubmittedUntilUserAddsNoteAndSaves` | PASS | 1 | 1 | 0 | 46.199 |
| `android_device:launcherAutomaticallyRetriesLocalQueueAndAllowsManualRetry` | PASS | 1 | 1 | 0 | 46.826 |
| `android_device:unsupportedShareShowsNoSaveableLink` | PASS | 1 | 1 | 0 | 50.747 |

## Summary

| Result | Count |
| --- | ---: |
| `KILLED_TEST` | 33 |
| `KILLED_DEVICE` | 4 |
| `KILLED_BUILD` | 9 |
| `SURVIVED` | 16 |
| `TIMEOUT` | 0 |

Behavioral detection rate: **37/62 (59.7%)**. Compiler/schema kills are reported separately and are not counted as assertion detection.

## Case Results

| Case | Platform | Area | Result | Tests | Seconds | File |
| --- | --- | --- | --- | ---: | ---: | --- |
| `worker-server-timing` | worker | observability | `KILLED_TEST` | 26/30 | 4.911 | `worker/src/index.ts` |
| `worker-public-auth` | worker | security | `KILLED_TEST` | 29/30 | 5.040 | `worker/src/index.ts` |
| `worker-enricher-auth` | worker | security | `KILLED_TEST` | 28/30 | 4.971 | `worker/src/index.ts` |
| `worker-method-guard` | worker | routing | `KILLED_TEST` | 28/30 | 5.020 | `worker/src/index.ts` |
| `worker-create-content-type` | worker | validation | `KILLED_TEST` | 27/30 | 5.027 | `worker/src/index.ts` |
| `worker-url-userinfo-validation` | worker | validation | `KILLED_TEST` | 29/30 | 5.015 | `worker/src/index.ts` |
| `worker-input-length-limits` | worker | validation | `KILLED_TEST` | 29/30 | 5.017 | `worker/src/index.ts` |
| `worker-idempotent-create` | worker | persistence | `KILLED_TEST` | 29/30 | 5.032 | `worker/src/index.ts` |
| `worker-learned-filter` | worker | query | `KILLED_TEST` | 28/30 | 4.988 | `worker/src/index.ts` |
| `worker-before-id-pagination` | worker | query | `KILLED_TEST` | 29/30 | 5.105 | `worker/src/index.ts` |
| `worker-like-escaping` | worker | query | `SURVIVED` | 30/30 | 6.057 | `worker/src/index.ts` |
| `worker-cache-hit` | worker | cache | `KILLED_TEST` | 28/30 | 5.023 | `worker/src/index.ts` |
| `worker-cache-cookie-bypass` | worker | cache | `KILLED_TEST` | 29/30 | 5.065 | `worker/src/index.ts` |
| `worker-cache-invalidation` | worker | cache | `KILLED_TEST` | 28/30 | 5.034 | `worker/src/index.ts` |
| `worker-enrichment-reset-on-edit` | worker | enrichment | `KILLED_TEST` | 29/30 | 5.040 | `worker/src/index.ts` |
| `worker-learned-timestamp` | worker | persistence | `KILLED_TEST` | 28/30 | 4.855 | `worker/src/index.ts` |
| `worker-delete-persistence` | worker | persistence | `KILLED_TEST` | 28/30 | 4.760 | `worker/src/index.ts` |
| `worker-x-only-claim` | worker | enrichment | `KILLED_TEST` | 28/30 | 4.877 | `worker/src/index.ts` |
| `worker-enrichment-fifo` | worker | enrichment | `KILLED_TEST` | 29/30 | 4.848 | `worker/src/index.ts` |
| `worker-completion-lease` | worker | concurrency | `KILLED_TEST` | 28/30 | 4.823 | `worker/src/index.ts` |
| `worker-retry-backoff` | worker | resilience | `KILLED_TEST` | 29/30 | 4.924 | `worker/src/index.ts` |
| `worker-image-source-allowlist` | worker | security | `KILLED_TEST` | 29/30 | 4.896 | `worker/src/index.ts` |
| `worker-image-content-type` | worker | security | `KILLED_BUILD` | 30/30 | 5.794 | `worker/src/index.ts` |
| `worker-image-stream-limit` | worker | security | `SURVIVED` | 30/30 | 5.812 | `worker/src/index.ts` |
| `worker-public-learned-mapping` | worker | contract | `KILLED_TEST` | 28/30 | 4.839 | `worker/src/index.ts` |
| `worker-trailing-slash-routing` | worker | routing | `SURVIVED` | 30/30 | 5.865 | `worker/src/index.ts` |
| `worker-debug-console` | worker | debug-ui | `SURVIVED` | 30/30 | 5.884 | `worker/src/index.ts` |
| `worker-cors-origin` | worker | contract | `KILLED_TEST` | 28/30 | 5.021 | `worker/src/index.ts` |
| `worker-env-r2-contract` | worker | types | `KILLED_BUILD` | 0/0 | 0.971 | `worker/src/index.ts` |
| `migration-0001` | worker | schema | `KILLED_BUILD` | 0/30 | 2.817 | `worker/migrations/0001_create_links.sql` |
| `migration-0002` | worker | schema | `KILLED_BUILD` | 0/30 | 2.906 | `worker/migrations/0002_add_learned_state.sql` |
| `migration-0003` | worker | schema | `KILLED_BUILD` | 0/30 | 3.106 | `worker/migrations/0003_add_cache_metadata.sql` |
| `migration-0004` | worker | schema | `KILLED_BUILD` | 0/30 | 3.276 | `worker/migrations/0004_add_client_id.sql` |
| `migration-0005` | worker | schema | `KILLED_BUILD` | 0/30 | 3.416 | `worker/migrations/0005_add_x_enrichment.sql` |
| `migration-0006` | worker | schema | `KILLED_BUILD` | 0/30 | 3.550 | `worker/migrations/0006_add_rich_x_enrichment.sql` |
| `android-native-clip-text` | android | share-input | `KILLED_TEST` | 22/24 | 1.145 | `android/app/src/main/java/com/alpenl/cairn/share/NativeShareSources.kt` |
| `android-text-url-extraction` | android | share-input | `KILLED_TEST` | 18/24 | 1.097 | `android/app/src/main/java/com/alpenl/cairn/share/contract/UrlCandidateExtractor.kt` |
| `android-url-deduplication` | android | share-input | `KILLED_TEST` | 23/24 | 1.053 | `android/app/src/main/java/com/alpenl/cairn/share/contract/UrlCandidateExtractor.kt` |
| `android-display-path` | android | presentation | `KILLED_TEST` | 20/24 | 0.948 | `android/app/src/main/java/com/alpenl/cairn/share/contract/UrlDisplayLabel.kt` |
| `android-single-auto-selection` | android | share-ui-model | `KILLED_TEST` | 23/24 | 0.933 | `android/app/src/main/java/com/alpenl/cairn/share/ShareCandidatePresenter.kt` |
| `android-submit-lock` | android | share-ui-model | `KILLED_TEST` | 23/24 | 0.881 | `android/app/src/main/java/com/alpenl/cairn/share/ShareCandidatePresenter.kt` |
| `android-client-id-json` | android | contract | `KILLED_TEST` | 22/24 | 0.889 | `android/app/src/main/java/com/alpenl/cairn/share/network/LinkRequestJson.kt` |
| `android-pending-failure-metadata` | android | local-queue | `KILLED_TEST` | 23/24 | 0.934 | `android/app/src/main/java/com/alpenl/cairn/share/PendingUploadStore.kt` |
| `android-share-auth-header` | android | security | `KILLED_TEST` | 23/24 | 5.957 | `android/app/src/main/java/com/alpenl/cairn/share/network/ShareApiClient.kt` |
| `android-semver-comparison` | android | updates | `KILLED_TEST` | 20/24 | 1.089 | `android/app/src/main/java/com/alpenl/cairn/share/network/UpdateApiClient.kt` |
| `android-default-user-agent` | android | contract | `SURVIVED` | 24/24 | 0.999 | `android/app/src/main/java/com/alpenl/cairn/share/network/AppUserAgent.kt` |
| `android-query-fragment-removal` | android | url-policy | `SURVIVED` | 24/24 | 0.879 | `android/app/src/main/java/com/alpenl/cairn/share/LinkPresentation.kt` |
| `android-links-page-decoding` | android | contract | `SURVIVED` | 24/24 | 0.950 | `android/app/src/main/java/com/alpenl/cairn/share/network/LinksApiClient.kt` |
| `android-repository-load` | android | repository | `SURVIVED` | 24/24 | 0.949 | `android/app/src/main/java/com/alpenl/cairn/share/LinkRepository.kt` |
| `android-viewmodel-library-filter` | android | view-model | `SURVIVED` | 24/24 | 1.247 | `android/app/src/main/java/com/alpenl/cairn/share/CairnLinksViewModel.kt` |
| `android-share-recreation-note` | android | activity-lifecycle | `KILLED_DEVICE` | 0/1 | 47.248 | `android/app/src/main/java/com/alpenl/cairn/share/ShareActivity.kt` |
| `android-durable-before-network` | android | local-queue | `KILLED_DEVICE` | 0/1 | 47.682 | `android/app/src/main/java/com/alpenl/cairn/share/ShareActivity.kt` |
| `android-preference-write` | android | settings | `KILLED_DEVICE` | 0/1 | 49.798 | `android/app/src/main/java/com/alpenl/cairn/share/SharePreferencesStore.kt` |
| `android-pending-remove` | android | local-queue | `SURVIVED` | 1/1 | 54.843 | `android/app/src/main/java/com/alpenl/cairn/share/PendingUploadStore.kt` |
| `android-update-download-success` | android | updates | `SURVIVED` | 24/24 | 1.123 | `android/app/src/main/java/com/alpenl/cairn/share/UpdateApkDownloader.kt` |
| `android-debug-path-confinement` | android | security | `SURVIVED` | 24/24 | 1.525 | `android/app/src/main/java/com/alpenl/cairn/share/network/ApiDebugClient.kt` |
| `android-launcher-copy` | android | launcher | `SURVIVED` | 24/24 | 1.046 | `android/app/src/main/java/com/alpenl/cairn/share/LauncherActivity.kt` |
| `android-theme-wrapper` | android | ui-theme | `SURVIVED` | 24/24 | 1.093 | `android/app/src/main/java/com/alpenl/cairn/share/ui/theme/CairnShareTheme.kt` |
| `android-settings-navigation` | android | ui-navigation | `SURVIVED` | 24/24 | 1.501 | `android/app/src/main/java/com/alpenl/cairn/share/CairnLinksApp.kt` |
| `android-share-intent-filter` | android | packaging | `SURVIVED` | 0/0 | 40.321 | `android/app/src/main/AndroidManifest.xml` |
| `android-file-provider` | android | packaging | `KILLED_BUILD` | 0/0 | 36.256 | `android/app/src/main/AndroidManifest.xml` |
| `android-unsupported-share-message` | android | resources | `KILLED_DEVICE` | 0/1 | 60.122 | `android/app/src/main/res/values/strings.xml` |

## Surviving Ablations

These are concrete gaps in the verification surface, not recommendations to delete the feature:

- `worker-like-escaping`: Stop escaping SQL LIKE wildcard characters in searches. (`worker/src/index.ts`)
- `worker-image-stream-limit`: Remove the streaming image-size cutoff. (`worker/src/index.ts`)
- `worker-trailing-slash-routing`: Stop normalizing trailing slashes in request paths. (`worker/src/index.ts`)
- `worker-debug-console`: Remove the visible API operations from the debug console. (`worker/src/index.ts`)
- `android-default-user-agent`: Replace the versioned Android User-Agent with an empty value. (`android/app/src/main/java/com/alpenl/cairn/share/network/AppUserAgent.kt`)
- `android-query-fragment-removal`: Keep query and fragment even when the preference disables them. (`android/app/src/main/java/com/alpenl/cairn/share/LinkPresentation.kt`)
- `android-links-page-decoding`: Decode every server list response as an empty page. (`android/app/src/main/java/com/alpenl/cairn/share/network/LinksApiClient.kt`)
- `android-repository-load`: Return an empty library without contacting the API. (`android/app/src/main/java/com/alpenl/cairn/share/LinkRepository.kt`)
- `android-viewmodel-library-filter`: Hide every link from the library view model projection. (`android/app/src/main/java/com/alpenl/cairn/share/CairnLinksViewModel.kt`)
- `android-pending-remove`: Keep successfully uploaded entries in the pending queue. (`android/app/src/main/java/com/alpenl/cairn/share/PendingUploadStore.kt`)
- `android-update-download-success`: Report a completed APK download as failed. (`android/app/src/main/java/com/alpenl/cairn/share/UpdateApkDownloader.kt`)
- `android-debug-path-confinement`: Allow absolute URLs in the in-app API debug client. (`android/app/src/main/java/com/alpenl/cairn/share/network/ApiDebugClient.kt`)
- `android-launcher-copy`: Do not put links on the clipboard. (`android/app/src/main/java/com/alpenl/cairn/share/LauncherActivity.kt`)
- `android-theme-wrapper`: Render content without the application Material theme. (`android/app/src/main/java/com/alpenl/cairn/share/ui/theme/CairnShareTheme.kt`)
- `android-settings-navigation`: Remove the settings destination from bottom navigation. (`android/app/src/main/java/com/alpenl/cairn/share/CairnLinksApp.kt`)
- `android-share-intent-filter`: Remove ACTION_SEND discovery from the Android manifest. (`android/app/src/main/AndroidManifest.xml`)

## Production File Coverage

| File | Ablation cases |
| --- | --- |
| `android/app/src/main/AndroidManifest.xml` | `android-share-intent-filter`, `android-file-provider` |
| `android/app/src/main/java/com/alpenl/cairn/share/AppUpdateState.kt` | `android-update-download-success` |
| `android/app/src/main/java/com/alpenl/cairn/share/CairnLinksApp.kt` | `android-settings-navigation` |
| `android/app/src/main/java/com/alpenl/cairn/share/CairnLinksViewModel.kt` | `android-viewmodel-library-filter` |
| `android/app/src/main/java/com/alpenl/cairn/share/LauncherActivity.kt` | `android-launcher-copy` |
| `android/app/src/main/java/com/alpenl/cairn/share/LinkPresentation.kt` | `android-query-fragment-removal` |
| `android/app/src/main/java/com/alpenl/cairn/share/LinkRepository.kt` | `android-repository-load` |
| `android/app/src/main/java/com/alpenl/cairn/share/NativeShareSources.kt` | `android-native-clip-text` |
| `android/app/src/main/java/com/alpenl/cairn/share/PendingUploadStore.kt` | `android-pending-failure-metadata`, `android-pending-remove` |
| `android/app/src/main/java/com/alpenl/cairn/share/ShareActivity.kt` | `android-share-recreation-note`, `android-durable-before-network` |
| `android/app/src/main/java/com/alpenl/cairn/share/ShareCandidatePresenter.kt` | `android-single-auto-selection`, `android-submit-lock` |
| `android/app/src/main/java/com/alpenl/cairn/share/SharePreferencesStore.kt` | `android-preference-write` |
| `android/app/src/main/java/com/alpenl/cairn/share/UpdateApkDownloader.kt` | `android-update-download-success` |
| `android/app/src/main/java/com/alpenl/cairn/share/contract/SharePayload.kt` | `android-text-url-extraction` |
| `android/app/src/main/java/com/alpenl/cairn/share/contract/UrlCandidate.kt` | `android-url-deduplication` |
| `android/app/src/main/java/com/alpenl/cairn/share/contract/UrlCandidateExtractor.kt` | `android-text-url-extraction`, `android-url-deduplication` |
| `android/app/src/main/java/com/alpenl/cairn/share/contract/UrlDisplayLabel.kt` | `android-display-path` |
| `android/app/src/main/java/com/alpenl/cairn/share/network/ApiDebugClient.kt` | `android-debug-path-confinement` |
| `android/app/src/main/java/com/alpenl/cairn/share/network/AppUserAgent.kt` | `android-default-user-agent` |
| `android/app/src/main/java/com/alpenl/cairn/share/network/LinkRequestJson.kt` | `android-client-id-json` |
| `android/app/src/main/java/com/alpenl/cairn/share/network/LinksApiClient.kt` | `android-links-page-decoding` |
| `android/app/src/main/java/com/alpenl/cairn/share/network/ShareApiClient.kt` | `android-share-auth-header` |
| `android/app/src/main/java/com/alpenl/cairn/share/network/UpdateApiClient.kt` | `android-semver-comparison` |
| `android/app/src/main/java/com/alpenl/cairn/share/ui/theme/CairnShareTheme.kt` | `android-theme-wrapper` |
| `android/app/src/main/res/values/strings.xml` | `android-unsupported-share-message` |
| `worker/migrations/0001_create_links.sql` | `migration-0001` |
| `worker/migrations/0002_add_learned_state.sql` | `migration-0002` |
| `worker/migrations/0003_add_cache_metadata.sql` | `migration-0003` |
| `worker/migrations/0004_add_client_id.sql` | `migration-0004` |
| `worker/migrations/0005_add_x_enrichment.sql` | `migration-0005` |
| `worker/migrations/0006_add_rich_x_enrichment.sql` | `migration-0006` |
| `worker/src/env.d.ts` | `worker-env-r2-contract` |
| `worker/src/index.ts` | `worker-server-timing`, `worker-public-auth`, `worker-enricher-auth`, `worker-method-guard`, `worker-create-content-type`, `worker-url-userinfo-validation`, `worker-input-length-limits`, `worker-idempotent-create`, `worker-learned-filter`, `worker-before-id-pagination`, `worker-like-escaping`, `worker-cache-hit`, `worker-cache-cookie-bypass`, `worker-cache-invalidation`, `worker-enrichment-reset-on-edit`, `worker-learned-timestamp`, `worker-delete-persistence`, `worker-x-only-claim`, `worker-enrichment-fifo`, `worker-completion-lease`, `worker-retry-backoff`, `worker-image-source-allowlist`, `worker-image-content-type`, `worker-image-stream-limit`, `worker-public-learned-mapping`, `worker-trailing-slash-routing`, `worker-debug-console`, `worker-cors-origin`, `worker-env-r2-contract` |

## Scope Exclusions

- `design/cairn-links-app.html`: Design reference only; README states that it is not runtime code.
- `android/app/src/androidTest/java/com/alpenl/cairn/share/ShareActivityInstrumentedTest.kt`: Outcome metric, not treatment code.
- `worker/test/index.test.ts`: Outcome metric, not treatment code.

Generated assets, dependency metadata, Gradle/Wrangler configuration, CI workflows, tests, and documentation are controls or delivery infrastructure rather than production behaviors; they are validated by the final repository gates, not treated as ablation variables.
