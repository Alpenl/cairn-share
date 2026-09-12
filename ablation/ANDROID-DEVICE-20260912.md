# Cairn Share repository ablation results

Generated: `2026-09-12T06:36:09.072743+00:00`

Revision: `1ea43e7`

Cases: `2`

## Method

Each case changes one behavior in a disposable copy of the tracked repository. The original source is never mutated. Worker cases run the Vitest/D1 suite, Android cases run JVM tests or build gates, and eligible Android survivors are escalated to one focused device test when `--device` is enabled. Device escalation occurs only when that exact test passes first on unmodified code.

A result of `SURVIVED` means the selected verification surface still passed; it does not prove the removed behavior is unnecessary. `KILLED_TEST` and `KILLED_DEVICE` mean assertions observed the regression. `KILLED_BUILD` means only the compiler, schema bootstrap, packaging, or test runtime stopped it.

## Baselines

| Verifier | Status | Tests | Passed | Failed | Seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| `android_unit` | PASS | 31 | 31 | 0 | 24.238 |
| `android_build` | PASS | 0 | 0 | 0 | 21.288 |
| `android_device:firstPageIsVisibleBeforeLaterPagesComplete` | FAIL | 1 | 0 | 1 | 82.728 |
| `android_device:readsBilingualContentImagesAndSavesCuration` | PASS | 1 | 1 | 0 | 86.263 |

## Summary

| Result | Count |
| --- | ---: |
| `KILLED_TEST` | 0 |
| `KILLED_DEVICE` | 1 |
| `KILLED_BUILD` | 0 |
| `SURVIVED` | 1 |
| `TIMEOUT` | 0 |

Behavioral detection rate: **1/2 (50.0%)**. Compiler/schema kills are reported separately and are not counted as assertion detection.

## Case Results

| Case | Platform | Area | Result | Tests | Seconds | File |
| --- | --- | --- | --- | ---: | ---: | --- |
| `android-progressive-library` | android | performance | `SURVIVED` | 31/31 | 1.700 | `android/app/src/main/java/com/alpenl/cairn/share/CairnLinksViewModel.kt` |
| `android-archived-image` | android | app-sync | `KILLED_DEVICE` | 0/1 | 92.128 | `android/app/src/main/java/com/alpenl/cairn/share/BookmarkContent.kt` |

## Surviving Ablations

These are concrete gaps in the verification surface, not recommendations to delete the feature:

- `android-progressive-library`: Wait for all pages before making any links visible. (`android/app/src/main/java/com/alpenl/cairn/share/CairnLinksViewModel.kt`)

## Production File Coverage

| File | Ablation cases |
| --- | --- |
| `android/app/src/main/AndroidManifest.xml` | **UNMAPPED** |
| `android/app/src/main/java/com/alpenl/cairn/share/AppUpdateState.kt` | `android-update-download-success` |
| `android/app/src/main/java/com/alpenl/cairn/share/BookmarkContent.kt` | `android-archived-image` |
| `android/app/src/main/java/com/alpenl/cairn/share/CairnLinksApp.kt` | **UNMAPPED** |
| `android/app/src/main/java/com/alpenl/cairn/share/CairnLinksViewModel.kt` | `android-progressive-library` |
| `android/app/src/main/java/com/alpenl/cairn/share/LauncherActivity.kt` | **UNMAPPED** |
| `android/app/src/main/java/com/alpenl/cairn/share/LinkPresentation.kt` | **UNMAPPED** |
| `android/app/src/main/java/com/alpenl/cairn/share/NativeShareSources.kt` | **UNMAPPED** |
| `android/app/src/main/java/com/alpenl/cairn/share/PendingUploadStore.kt` | **UNMAPPED** |
| `android/app/src/main/java/com/alpenl/cairn/share/ShareActivity.kt` | **UNMAPPED** |
| `android/app/src/main/java/com/alpenl/cairn/share/ShareCandidatePresenter.kt` | **UNMAPPED** |
| `android/app/src/main/java/com/alpenl/cairn/share/SharePreferencesStore.kt` | **UNMAPPED** |
| `android/app/src/main/java/com/alpenl/cairn/share/UpdateApkDownloader.kt` | **UNMAPPED** |
| `android/app/src/main/java/com/alpenl/cairn/share/contract/SharePayload.kt` | `android-text-url-extraction` |
| `android/app/src/main/java/com/alpenl/cairn/share/contract/UrlCandidate.kt` | `android-url-deduplication` |
| `android/app/src/main/java/com/alpenl/cairn/share/contract/UrlCandidateExtractor.kt` | **UNMAPPED** |
| `android/app/src/main/java/com/alpenl/cairn/share/contract/UrlDisplayLabel.kt` | **UNMAPPED** |
| `android/app/src/main/java/com/alpenl/cairn/share/network/ApiDebugClient.kt` | **UNMAPPED** |
| `android/app/src/main/java/com/alpenl/cairn/share/network/AppUserAgent.kt` | **UNMAPPED** |
| `android/app/src/main/java/com/alpenl/cairn/share/network/BookmarkFilters.kt` | **UNMAPPED** |
| `android/app/src/main/java/com/alpenl/cairn/share/network/LinkEnrichment.kt` | **UNMAPPED** |
| `android/app/src/main/java/com/alpenl/cairn/share/network/LinkRequestJson.kt` | **UNMAPPED** |
| `android/app/src/main/java/com/alpenl/cairn/share/network/LinksApiClient.kt` | **UNMAPPED** |
| `android/app/src/main/java/com/alpenl/cairn/share/network/ShareApiClient.kt` | **UNMAPPED** |
| `android/app/src/main/java/com/alpenl/cairn/share/network/UpdateApiClient.kt` | **UNMAPPED** |
| `android/app/src/main/java/com/alpenl/cairn/share/ui/theme/CairnShareTheme.kt` | **UNMAPPED** |
| `android/app/src/main/res/values/strings.xml` | **UNMAPPED** |
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
