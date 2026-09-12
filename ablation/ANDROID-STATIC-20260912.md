# Cairn Share repository ablation results

Generated: `2026-09-12T06:23:37.659408+00:00`

Revision: `1ea43e7`

Cases: `32`

## Method

Each case changes one behavior in a disposable copy of the tracked repository. The original source is never mutated. Worker cases run the Vitest/D1 suite, Android cases run JVM tests or build gates, and eligible Android survivors are escalated to one focused device test when `--device` is enabled. Device escalation occurs only when that exact test passes first on unmodified code.

A result of `SURVIVED` means the selected verification surface still passed; it does not prove the removed behavior is unnecessary. `KILLED_TEST` and `KILLED_DEVICE` mean assertions observed the regression. `KILLED_BUILD` means only the compiler, schema bootstrap, packaging, or test runtime stopped it.

## Baselines

| Verifier | Status | Tests | Passed | Failed | Seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| `android_unit` | PASS | 31 | 31 | 0 | 32.134 |
| `android_build` | PASS | 0 | 0 | 0 | 27.296 |

## Summary

| Result | Count |
| --- | ---: |
| `KILLED_TEST` | 13 |
| `KILLED_DEVICE` | 0 |
| `KILLED_BUILD` | 1 |
| `SURVIVED` | 18 |
| `TIMEOUT` | 0 |

Behavioral detection rate: **13/32 (40.6%)**. Compiler/schema kills are reported separately and are not counted as assertion detection.

## Case Results

| Case | Platform | Area | Result | Tests | Seconds | File |
| --- | --- | --- | --- | ---: | ---: | --- |
| `android-native-clip-text` | android | share-input | `KILLED_TEST` | 29/31 | 3.714 | `android/app/src/main/java/com/alpenl/cairn/share/NativeShareSources.kt` |
| `android-text-url-extraction` | android | share-input | `KILLED_TEST` | 25/31 | 2.176 | `android/app/src/main/java/com/alpenl/cairn/share/contract/UrlCandidateExtractor.kt` |
| `android-url-deduplication` | android | share-input | `KILLED_TEST` | 30/31 | 3.197 | `android/app/src/main/java/com/alpenl/cairn/share/contract/UrlCandidateExtractor.kt` |
| `android-display-path` | android | presentation | `KILLED_TEST` | 25/31 | 2.415 | `android/app/src/main/java/com/alpenl/cairn/share/contract/UrlDisplayLabel.kt` |
| `android-single-auto-selection` | android | share-ui-model | `KILLED_TEST` | 30/31 | 1.320 | `android/app/src/main/java/com/alpenl/cairn/share/ShareCandidatePresenter.kt` |
| `android-submit-lock` | android | share-ui-model | `KILLED_TEST` | 30/31 | 1.790 | `android/app/src/main/java/com/alpenl/cairn/share/ShareCandidatePresenter.kt` |
| `android-client-id-json` | android | contract | `KILLED_TEST` | 29/31 | 2.088 | `android/app/src/main/java/com/alpenl/cairn/share/network/LinkRequestJson.kt` |
| `android-pending-failure-metadata` | android | local-queue | `KILLED_TEST` | 30/31 | 1.448 | `android/app/src/main/java/com/alpenl/cairn/share/PendingUploadStore.kt` |
| `android-share-auth-header` | android | security | `KILLED_TEST` | 30/31 | 6.508 | `android/app/src/main/java/com/alpenl/cairn/share/network/ShareApiClient.kt` |
| `android-semver-comparison` | android | updates | `KILLED_TEST` | 27/31 | 1.547 | `android/app/src/main/java/com/alpenl/cairn/share/network/UpdateApiClient.kt` |
| `android-default-user-agent` | android | contract | `SURVIVED` | 31/31 | 1.366 | `android/app/src/main/java/com/alpenl/cairn/share/network/AppUserAgent.kt` |
| `android-query-fragment-removal` | android | url-policy | `SURVIVED` | 31/31 | 1.183 | `android/app/src/main/java/com/alpenl/cairn/share/LinkPresentation.kt` |
| `android-links-page-decoding` | android | contract | `SURVIVED` | 31/31 | 1.317 | `android/app/src/main/java/com/alpenl/cairn/share/network/LinksApiClient.kt` |
| `android-library-page-load` | android | view-model | `SURVIVED` | 31/31 | 1.800 | `android/app/src/main/java/com/alpenl/cairn/share/CairnLinksViewModel.kt` |
| `android-viewmodel-library-filter` | android | view-model | `SURVIVED` | 31/31 | 1.561 | `android/app/src/main/java/com/alpenl/cairn/share/CairnLinksViewModel.kt` |
| `android-share-recreation-note` | android | activity-lifecycle | `SURVIVED` | 31/31 | 1.929 | `android/app/src/main/java/com/alpenl/cairn/share/ShareActivity.kt` |
| `android-durable-before-network` | android | local-queue | `SURVIVED` | 31/31 | 1.414 | `android/app/src/main/java/com/alpenl/cairn/share/ShareActivity.kt` |
| `android-preference-write` | android | settings | `SURVIVED` | 31/31 | 1.426 | `android/app/src/main/java/com/alpenl/cairn/share/SharePreferencesStore.kt` |
| `android-pending-remove` | android | local-queue | `SURVIVED` | 31/31 | 1.464 | `android/app/src/main/java/com/alpenl/cairn/share/PendingUploadStore.kt` |
| `android-update-download-success` | android | updates | `SURVIVED` | 31/31 | 1.456 | `android/app/src/main/java/com/alpenl/cairn/share/UpdateApkDownloader.kt` |
| `android-debug-path-confinement` | android | security | `SURVIVED` | 31/31 | 1.356 | `android/app/src/main/java/com/alpenl/cairn/share/network/ApiDebugClient.kt` |
| `android-launcher-copy` | android | launcher | `SURVIVED` | 31/31 | 1.327 | `android/app/src/main/java/com/alpenl/cairn/share/LauncherActivity.kt` |
| `android-theme-wrapper` | android | ui-theme | `SURVIVED` | 31/31 | 1.316 | `android/app/src/main/java/com/alpenl/cairn/share/ui/theme/CairnShareTheme.kt` |
| `android-settings-navigation` | android | ui-navigation | `SURVIVED` | 31/31 | 2.107 | `android/app/src/main/java/com/alpenl/cairn/share/CairnLinksApp.kt` |
| `android-share-intent-filter` | android | packaging | `SURVIVED` | 0/0 | 14.798 | `android/app/src/main/AndroidManifest.xml` |
| `android-file-provider` | android | packaging | `KILLED_BUILD` | 0/0 | 7.273 | `android/app/src/main/AndroidManifest.xml` |
| `android-unsupported-share-message` | android | resources | `SURVIVED` | 31/31 | 2.823 | `android/app/src/main/res/values/strings.xml` |
| `android-enrichment-decoding` | android | app-sync | `KILLED_TEST` | 29/31 | 1.667 | `android/app/src/main/java/com/alpenl/cairn/share/network/LinksApiClient.kt` |
| `android-content-revision` | android | app-sync | `KILLED_TEST` | 30/31 | 1.496 | `android/app/src/main/java/com/alpenl/cairn/share/network/LinkEnrichment.kt` |
| `android-topic-filter` | android | curation | `KILLED_TEST` | 30/31 | 1.370 | `android/app/src/main/java/com/alpenl/cairn/share/network/BookmarkFilters.kt` |
| `android-progressive-library` | android | performance | `SURVIVED` | 31/31 | 1.604 | `android/app/src/main/java/com/alpenl/cairn/share/CairnLinksViewModel.kt` |
| `android-archived-image` | android | app-sync | `SURVIVED` | 31/31 | 2.587 | `android/app/src/main/java/com/alpenl/cairn/share/BookmarkContent.kt` |

## Surviving Ablations

These are concrete gaps in the verification surface, not recommendations to delete the feature:

- `android-default-user-agent`: Replace the versioned Android User-Agent with an empty value. (`android/app/src/main/java/com/alpenl/cairn/share/network/AppUserAgent.kt`)
- `android-query-fragment-removal`: Keep query and fragment even when the preference disables them. (`android/app/src/main/java/com/alpenl/cairn/share/LinkPresentation.kt`)
- `android-links-page-decoding`: Decode every server list response as an empty page. (`android/app/src/main/java/com/alpenl/cairn/share/network/LinksApiClient.kt`)
- `android-library-page-load`: Return an empty library without contacting the API. (`android/app/src/main/java/com/alpenl/cairn/share/CairnLinksViewModel.kt`)
- `android-viewmodel-library-filter`: Hide every link from the library view model projection. (`android/app/src/main/java/com/alpenl/cairn/share/CairnLinksViewModel.kt`)
- `android-share-recreation-note`: Do not preserve the share note across Activity recreation. (`android/app/src/main/java/com/alpenl/cairn/share/ShareActivity.kt`)
- `android-durable-before-network`: Construct an upload in memory instead of persisting it before POST. (`android/app/src/main/java/com/alpenl/cairn/share/ShareActivity.kt`)
- `android-preference-write`: Drop API-token preference writes. (`android/app/src/main/java/com/alpenl/cairn/share/SharePreferencesStore.kt`)
- `android-pending-remove`: Keep successfully uploaded entries in the pending queue. (`android/app/src/main/java/com/alpenl/cairn/share/PendingUploadStore.kt`)
- `android-update-download-success`: Report a completed APK download as failed. (`android/app/src/main/java/com/alpenl/cairn/share/UpdateApkDownloader.kt`)
- `android-debug-path-confinement`: Allow absolute URLs in the in-app API debug client. (`android/app/src/main/java/com/alpenl/cairn/share/network/ApiDebugClient.kt`)
- `android-launcher-copy`: Do not put links on the clipboard. (`android/app/src/main/java/com/alpenl/cairn/share/LauncherActivity.kt`)
- `android-theme-wrapper`: Render content without the application Material theme. (`android/app/src/main/java/com/alpenl/cairn/share/ui/theme/CairnShareTheme.kt`)
- `android-settings-navigation`: Remove the settings destination from bottom navigation. (`android/app/src/main/java/com/alpenl/cairn/share/CairnLinksApp.kt`)
- `android-share-intent-filter`: Remove ACTION_SEND discovery from the Android manifest. (`android/app/src/main/AndroidManifest.xml`)
- `android-unsupported-share-message`: Replace the unsupported-share error with an empty message. (`android/app/src/main/res/values/strings.xml`)
- `android-progressive-library`: Wait for all pages before making any links visible. (`android/app/src/main/java/com/alpenl/cairn/share/CairnLinksViewModel.kt`)
- `android-archived-image`: Use an invalid archive key so App images cannot load. (`android/app/src/main/java/com/alpenl/cairn/share/BookmarkContent.kt`)

## Production File Coverage

| File | Ablation cases |
| --- | --- |
| `android/app/src/main/AndroidManifest.xml` | `android-share-intent-filter`, `android-file-provider` |
| `android/app/src/main/java/com/alpenl/cairn/share/AppUpdateState.kt` | `android-update-download-success` |
| `android/app/src/main/java/com/alpenl/cairn/share/BookmarkContent.kt` | `android-archived-image` |
| `android/app/src/main/java/com/alpenl/cairn/share/CairnLinksApp.kt` | `android-settings-navigation` |
| `android/app/src/main/java/com/alpenl/cairn/share/CairnLinksViewModel.kt` | `android-library-page-load`, `android-viewmodel-library-filter`, `android-progressive-library` |
| `android/app/src/main/java/com/alpenl/cairn/share/LauncherActivity.kt` | `android-launcher-copy` |
| `android/app/src/main/java/com/alpenl/cairn/share/LinkPresentation.kt` | `android-query-fragment-removal` |
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
| `android/app/src/main/java/com/alpenl/cairn/share/network/BookmarkFilters.kt` | `android-topic-filter` |
| `android/app/src/main/java/com/alpenl/cairn/share/network/LinkEnrichment.kt` | `android-content-revision` |
| `android/app/src/main/java/com/alpenl/cairn/share/network/LinkRequestJson.kt` | `android-client-id-json` |
| `android/app/src/main/java/com/alpenl/cairn/share/network/LinksApiClient.kt` | `android-links-page-decoding`, `android-enrichment-decoding` |
| `android/app/src/main/java/com/alpenl/cairn/share/network/ShareApiClient.kt` | `android-share-auth-header` |
| `android/app/src/main/java/com/alpenl/cairn/share/network/UpdateApiClient.kt` | `android-semver-comparison` |
| `android/app/src/main/java/com/alpenl/cairn/share/ui/theme/CairnShareTheme.kt` | `android-theme-wrapper` |
| `android/app/src/main/res/values/strings.xml` | `android-unsupported-share-message` |
| `worker/migrations/0001_create_links.sql` | **UNMAPPED** |
| `worker/migrations/0002_add_learned_state.sql` | **UNMAPPED** |
| `worker/migrations/0003_add_cache_metadata.sql` | **UNMAPPED** |
| `worker/migrations/0004_add_client_id.sql` | **UNMAPPED** |
| `worker/migrations/0005_add_x_enrichment.sql` | **UNMAPPED** |
| `worker/migrations/0006_add_rich_x_enrichment.sql` | **UNMAPPED** |
| `worker/migrations/0007_add_bookmark_curation.sql` | **UNMAPPED** |
| `worker/migrations/0008_invalidate_enriched_link_cache.sql` | **UNMAPPED** |
| `worker/src/curation.ts` | **UNMAPPED** |
| `worker/src/env.d.ts` | `worker-env-r2-contract` |
| `worker/src/index.ts` | **UNMAPPED** |
| `worker/src/taxonomy.json` | **UNMAPPED** |

## Scope Exclusions

- `design/cairn-links-app.html`: Design reference only; README states that it is not runtime code.
- `android/app/src/androidTest/java/com/alpenl/cairn/share/ShareActivityInstrumentedTest.kt`: Outcome metric, not treatment code.
- `worker/test/index.test.ts`: Outcome metric, not treatment code.

Generated assets, dependency metadata, Gradle/Wrangler configuration, CI workflows, tests, and documentation are controls or delivery infrastructure rather than production behaviors; they are validated by the final repository gates, not treated as ablation variables.
