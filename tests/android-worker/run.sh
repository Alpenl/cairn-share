#!/usr/bin/env bash
# Isolated D1 + actual Android Repository, DataStore and ViewModel. No model calls.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [ -z "$sdk" ]; then sdk="$(sed -n 's/^sdk.dir=//p' "$root/android/local.properties")"; fi
adb="$sdk/platform-tools/adb"
serial="${ANDROID_SERIAL:?Set ANDROID_SERIAL to an already booted isolated emulator}"
work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/cairn-android-worker.XXXXXX")"
worker_pid="" proxy_pid=""
cleanup() {
  if [ -n "$proxy_pid" ] && kill -0 "$proxy_pid" 2>/dev/null; then
    curl -fsS "http://127.0.0.1:$proxy_port/__test/control" > "$work/transport-history.json" || true
  fi
  "$adb" -s "$serial" reverse --remove tcp:18978 >/dev/null 2>&1 || true
  if [ -n "$proxy_pid" ]; then kill "$proxy_pid" 2>/dev/null || true; wait "$proxy_pid" 2>/dev/null || true; fi
  if [ -n "$worker_pid" ]; then kill -- "-$worker_pid" 2>/dev/null || true; wait "$worker_pid" 2>/dev/null || true; fi
  echo "Local service logs: $work"
}
trap cleanup EXIT
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
worker_port="$(free_port)" proxy_port="$(free_port)"
cp -r "$root/worker/migrations" "$work/migrations"
cat > "$work/wrangler.jsonc" <<EOF
{
 "name":"cairn-android-recovery", "main":"$root/worker/src/index.ts", "compatibility_date":"2026-08-26",
 "d1_databases":[{"binding":"DB","database_name":"android-recovery","database_id":"android-recovery"}],
 "r2_buckets":[{"binding":"ENRICHMENT_IMAGES","bucket_name":"android-recovery"}],
 "vars":{"CAIRN_API_TOKEN":"test-a-12345678","CAIRN_ENRICHER_TOKEN":"internal"}
}
EOF
(cd "$root/worker" && npx wrangler d1 migrations apply android-recovery --local --config "$work/wrangler.jsonc" > "$work/migrations.log" 2>&1)
(cd "$root/worker" && exec setsid ./node_modules/.bin/wrangler dev --local --ip 127.0.0.1 --port "$worker_port" --config "$work/wrangler.jsonc" > "$work/worker.log" 2>&1) &
worker_pid=$!
ready=""
for _ in $(seq 1 60); do
  if ! kill -0 "$worker_pid" 2>/dev/null; then cat "$work/worker.log"; exit 1; fi
  if curl -fsS "http://127.0.0.1:$worker_port/api/v2-taxonomy" -H 'Authorization: Bearer test-a-12345678' > /dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ -n "$ready" ] || { cat "$work/worker.log"; exit 1; }
# A legacy AI-only fixture, not a human curation row or a model prediction used as gold.
baseline_id="$(curl -fsS "http://127.0.0.1:$worker_port/api/links" -H 'Authorization: Bearer test-a-12345678' -H 'Content-Type: application/json' -d '{"url":"https://example.com/android-baseline"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
term_reset_id="$(curl -fsS "http://127.0.0.1:$worker_port/api/links" -H 'Authorization: Bearer test-a-12345678' -H 'Content-Type: application/json' -d '{"url":"https://example.com/android-term-reset"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
cat > "$work/baseline.sql" <<'SQL'
UPDATE links SET classification='{"topics":["llm"],"form":"method","use":"try","uncertainty":false}' WHERE url='https://example.com/android-baseline';
UPDATE links SET classification='{"topics":["llm","eval"],"form":"method","use":"try","uncertainty":false}' WHERE url='https://example.com/android-term-reset';
SQL
(cd "$root/worker" && npx wrangler d1 execute android-recovery --local --config "$work/wrangler.jsonc" --file "$work/baseline.sql" > "$work/baseline.log" 2>&1)
python3 "$root/tests/android-worker/entity_fixture.py" > "$work/entity.sql"
(cd "$root/worker" && npx wrangler d1 execute android-recovery --local --config "$work/wrangler.jsonc" --file "$work/entity.sql" > "$work/entity-seed.log" 2>&1)
python3 "$root/tests/android-worker/fault_proxy.py" "http://127.0.0.1:$worker_port" "$proxy_port" > "$work/proxy.log" 2>&1 &
proxy_pid=$!
"$adb" -s "$serial" reverse tcp:18978 "tcp:$proxy_port"
(cd "$root/android" && ./gradlew --no-daemon --dependency-verification strict installDebug installDebugAndroidTest)
# Each harness invocation has a fresh D1 at the same loopback account URL.
# Reset only before the first phase so durable bodies from a previous run do
# not masquerade as this database's list projection. Phases keep all app data.
"$adb" -s "$serial" shell pm clear com.alpenl.cairn.share > /dev/null
for phase in persistBeforeSendAndLoseFirstResponse recoverThenHandleTwoRealConflictsAndMidChainFailure discardAndAccountSwitchPreserveUnrelatedActions preserveAmbiguousLegacyAndSeparateSameSuffixAccounts explicitlyRecoverLegacyAfterRestart persistResetWithIndependentAutomaticBaseline restoreAutomaticDraftAfterProcessDeath persistTermResetAfterExplicitEmpty restoreTermResetAfterProcessDeath confirmedCurationRefreshesRealFilteredSearch blankKeywordLibraryUsesFullEffectiveFiltersAndConfirmedWrites persistDeletionAfterRealCommitResponseLoss recoverDeletionAfterProcessDeathWithoutReplayingCuration readEntityProvenanceAndHumanOverridesFromRealWorker persistEntityNameIntentsAndLoseCommittedResponse recoverEntityNameIntentsWithoutReclassifyingOrChangingIdentity; do
  "$adb" -s "$serial" shell am force-stop com.alpenl.cairn.share
  "$adb" -s "$serial" shell am instrument -w -r \
    -e class "com.alpenl.cairn.share.CurationWorkerRecoveryTest#$phase" \
    -e cairnWorkerUrl http://127.0.0.1:18978 -e cairnBaselineID "$baseline_id" -e cairnTermResetID "$term_reset_id" \
    com.alpenl.cairn.share.test/androidx.test.runner.AndroidJUnitRunner | tee "$work/$phase.log"
  # am instrument can exit zero on a failed test; require the actual JUnit result.
  grep -Eq '^OK \(1 test\)' "$work/$phase.log"
done
for phase in persistBaselineWithRealWorker resumeRealCursorApplyUpdatesAndDeletesAfterProcessDeath; do
  "$adb" -s "$serial" shell am force-stop com.alpenl.cairn.share
  "$adb" -s "$serial" shell am instrument -w -r \
    -e class "com.alpenl.cairn.share.LibrarySyncWorkerIntegrationTest#$phase" \
    -e cairnWorkerUrl http://127.0.0.1:18978 \
    com.alpenl.cairn.share.test/androidx.test.runner.AndroidJUnitRunner | tee "$work/$phase.log"
  grep -Eq '^OK \(1 test\)' "$work/$phase.log"
done
for phase in persistOfflineCollectionAndLoseCommittedCreateResponse recoverAfterProcessDeathAndExplicitlyResolveRemoteConflict; do
  "$adb" -s "$serial" shell am force-stop com.alpenl.cairn.share
  "$adb" -s "$serial" shell am instrument -w -r \
    -e class "com.alpenl.cairn.share.CollectionsWorkerIntegrationTest#$phase" \
    -e cairnWorkerUrl http://127.0.0.1:18978 \
    com.alpenl.cairn.share.test/androidx.test.runner.AndroidJUnitRunner | tee "$work/$phase.log"
  grep -Eq '^OK \(1 test\)' "$work/$phase.log"
done
# Run the original twenty stages under their existing legacy target first.
# Only these final material stages opt into a registered v2 target.
spec_hash="$(curl -fsS "http://127.0.0.1:$worker_port/api/v2/question-specs" -H 'Authorization: Bearer internal' -H 'Content-Type: application/json' -d '{"spec_id":"android-material","spec_version":1,"questions":{}}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["spec_hash"])')"
target_body="$(python3 - "$spec_hash" <<'PY'
import json,sys
print(json.dumps(dict(spec_id="android-material",spec_hash=sys.argv[1],taxonomy_version="2026-09-20.1",policy_version="android-material",requested_model="fixture",protocol="v2")))
PY
)"
curl -fsS "http://127.0.0.1:$worker_port/api/enrichment/classifications/target" -H 'Authorization: Bearer internal' -H 'Content-Type: application/json' -d "$target_body" > "$work/material-target.json"
python3 "$root/tests/android-worker/material_fixture.py" > "$work/material.sql"
(cd "$root/worker" && npx wrangler d1 execute android-recovery --local --config "$work/wrangler.jsonc" --file "$work/material.sql" > "$work/material-seed.log" 2>&1)
material_sql="SELECT l.content_revision,j.revision,j.input_revision,j.status,l.original_text,l.ai_title,l.summary,l.translated_text,(SELECT COUNT(*) FROM evidence_snapshots WHERE link_id=l.id) AS snapshots,(SELECT COUNT(*) FROM evidence_requests WHERE link_id=l.id AND protocol=2) AS requests,(SELECT COUNT(*) FROM classification_provider_attempts WHERE link_id=l.id) AS classification_calls,(SELECT COUNT(*) FROM enrichment_provider_attempts WHERE link_id=l.id) AS reading_calls FROM links l JOIN classification_jobs j ON j.link_id=l.id WHERE l.url='https://example.com/android-manual-material'"
(cd "$root/worker" && npx wrangler d1 execute android-recovery --local --config "$work/wrangler.jsonc" --command "$material_sql" --json > "$work/material-initial.json")
for phase in persistManualMaterialBeforeSendAndLoseActualCommitResponse recoverManualMaterialAfterProcessDeathWithoutAnotherVersionOrQueue; do
  "$adb" -s "$serial" shell am force-stop com.alpenl.cairn.share
  "$adb" -s "$serial" shell am instrument -w -r \
    -e class "com.alpenl.cairn.share.ManualMaterialWorkerIntegrationTest#$phase" \
    -e cairnWorkerUrl http://127.0.0.1:18978 \
    com.alpenl.cairn.share.test/androidx.test.runner.AndroidJUnitRunner | tee "$work/$phase.log"
  grep -Eq '^OK \(1 test\)' "$work/$phase.log"
done
(cd "$root/worker" && npx wrangler d1 execute android-recovery --local --config "$work/wrangler.jsonc" --command "$material_sql" --json > "$work/material-final.json")
python3 - "$work/material-initial.json" "$work/material-final.json" <<'PY'
import json,sys
def one(path):
    rows=json.load(open(path))[0]["results"]
    assert len(rows)==1, rows
    return rows[0]
before,row=map(one,sys.argv[1:])
for name in ("content_revision","revision","input_revision","snapshots"):
    assert row[name]==before[name]+1, (name,before[name],row[name])
assert row["requests"]==before["requests"]+2 and row["status"]=="pending", row
assert row["classification_calls"]==0 and row["reading_calls"]==0, row
assert (row["original_text"],row["ai_title"],row["summary"],row["translated_text"])==("Manual fixture original source","Keep title","Keep summary","Keep translation"), row
print("Actual D1: one new snapshot/queue revision, duplicate content is a no-op; original reading kept and zero providers")
PY
# Keep the original twenty-two phases unchanged. These three new phases use
# the actual ViewModel/Repository/DataStore, a real R2 image and distinct PIDs.
python3 "$root/tests/android-worker/processing_fixture.py" > "$work/processing.sql"
(cd "$root/worker" && npx wrangler d1 execute android-recovery --local --config "$work/wrangler.jsonc" --file "$work/processing.sql" > "$work/processing-seed.log" 2>&1)
python3 - "$work/processing.png" <<'PY'
import base64,sys
open(sys.argv[1],"wb").write(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM7sAAAAASUVORK5CYII="))
PY
(cd "$root/worker" && npx wrangler r2 object put "android-recovery/enrichment/9004/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png" --local --config "$work/wrangler.jsonc" --file "$work/processing.png" --content-type image/png > "$work/processing-r2-seed.log" 2>&1)
processing_sql="SELECT l.content_revision,j.revision,j.input_revision,j.status,l.enrichment_status,l.original_text,l.ai_title,l.summary,l.translated_text,l.images,l.personal_revision,(SELECT COUNT(*) FROM evidence_snapshots WHERE link_id=l.id) AS snapshots,(SELECT COUNT(*) FROM classification_operations WHERE link_id=l.id AND status='app_processing') AS operations,(SELECT COUNT(*) FROM classification_provider_attempts WHERE link_id=l.id) AS classification_calls,(SELECT COUNT(*) FROM enrichment_provider_attempts WHERE link_id=l.id) AS reading_calls,(SELECT COUNT(*) FROM curation_events WHERE link_id=l.id) AS events,(SELECT COUNT(*) FROM curation_overrides WHERE link_id=l.id) AS overrides FROM links l JOIN classification_jobs j ON j.link_id=l.id WHERE l.id=9004"
(cd "$root/worker" && npx wrangler d1 execute android-recovery --local --config "$work/wrangler.jsonc" --command "$processing_sql" --json > "$work/processing-initial.json")
for phase in persistPrimaryWithActualViewModelAndLoseCommittedWorkerResponse recoverPrimaryAfterProcessDeathAndRetryOnlyClassificationFromFreshState; do
  "$adb" -s "$serial" shell am force-stop com.alpenl.cairn.share
  "$adb" -s "$serial" shell am instrument -w -r \
    -e class "com.alpenl.cairn.share.ProcessingWorkerIntegrationTest#$phase" \
    -e cairnWorkerUrl http://127.0.0.1:18978 \
    com.alpenl.cairn.share.test/androidx.test.runner.AndroidJUnitRunner | tee "$work/$phase.log"
  grep -Eq '^OK \(1 test\)' "$work/$phase.log"
  if [ "$phase" = "persistPrimaryWithActualViewModelAndLoseCommittedWorkerResponse" ]; then
    (cd "$root/worker" && npx wrangler d1 execute android-recovery --local --config "$work/wrangler.jsonc" --command "$processing_sql" --json > "$work/processing-after-primary.json")
    # A controlled fixture advances queue status, never source/history/human
    # or model ledgers, to make an explicit new classification-only retry eligible.
    (cd "$root/worker" && npx wrangler d1 execute android-recovery --local --config "$work/wrangler.jsonc" --command "UPDATE links SET enrichment_status='completed' WHERE id=9004; UPDATE classification_jobs SET status='completed' WHERE link_id=9004;" > "$work/processing-stage-ready.log" 2>&1)
  fi
done
(cd "$root/worker" && npx wrangler d1 execute android-recovery --local --config "$work/wrangler.jsonc" --command "$processing_sql" --json > "$work/processing-final.json")
python3 - "$work/processing-initial.json" "$work/processing-after-primary.json" "$work/processing-final.json" <<'PY'
import json,sys
def one(path):
    rows=json.load(open(path))[0]["results"]
    assert len(rows)==1,rows
    return rows[0]
before,primary,final=map(one,sys.argv[1:])
for row in (primary,final):
    for name in ("content_revision","input_revision","snapshots"):
        assert row[name]==before[name]+1,(name,before,row)
    for name in ("ai_title","summary","translated_text","images","personal_revision","events","overrides"):
        assert row[name]==before[name],(name,before,row)
    assert row["classification_calls"]==row["reading_calls"]==0,row
assert primary["revision"]==before["revision"]+1 and primary["operations"]==before["operations"]+1,primary
assert primary["enrichment_status"]=="pending" and primary["status"]=="pending",primary
assert final["revision"]==before["revision"]+2 and final["operations"]==before["operations"]+2,final
assert final["enrichment_status"]=="completed" and final["status"]=="pending",final
assert final["original_text"]=="Human supplied complete primary 🙂\n"+"保留来源"*2000,final
print("Actual processing D1: source/input/snapshot +1, source plus explicit class-only queue +2, media/reading/human retained, zero providers")
PY
phase=confirmedRealDeletionErasesJournalAndRejectsDelayedKnownRequestWithoutResurrection
"$adb" -s "$serial" shell am force-stop com.alpenl.cairn.share
"$adb" -s "$serial" shell am instrument -w -r \
  -e class "com.alpenl.cairn.share.ProcessingWorkerIntegrationTest#$phase" \
  -e cairnWorkerUrl http://127.0.0.1:18978 \
  com.alpenl.cairn.share.test/androidx.test.runner.AndroidJUnitRunner | tee "$work/$phase.log"
grep -Eq '^OK \(1 test\)' "$work/$phase.log"
(cd "$root/worker" && npx wrangler d1 execute android-recovery --local --config "$work/wrangler.jsonc" --command "SELECT (SELECT COUNT(*) FROM links WHERE id=9004) AS links,(SELECT COUNT(*) FROM evidence_snapshots WHERE link_id=9004) AS snapshots,(SELECT COUNT(*) FROM classification_operations WHERE link_id=9004) AS operations" --json > "$work/processing-deleted.json")
python3 - "$work/processing-deleted.json" <<'PY'
import json,sys
row=json.load(open(sys.argv[1]))[0]["results"][0]
assert row==dict(links=0,snapshots=0,operations=0),row
print("Actual D1 deletion: no source, operation or bookmark resurrection")
PY
curl -fsS "http://127.0.0.1:$proxy_port/__test/control" > "$work/transport-history.json"
echo "PASS: twenty-five phases ran in separate Android processes against actual authenticated Worker/D1/R2"
