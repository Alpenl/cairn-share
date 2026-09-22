#!/usr/bin/env bash
# Isolated D1 + actual Android Repository, DataStore and ViewModel. No model calls.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
sdk="${ANDROID_SDK_ROOT:-/home/alpen/Android/Sdk}"
adb="$sdk/platform-tools/adb"
serial="${ANDROID_SERIAL:?Set ANDROID_SERIAL to an already booted isolated emulator}"
work="$(mktemp -d /tmp/cairn-android-worker.XXXXXX)"
worker_pid="" proxy_pid=""
cleanup() {
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
 "vars":{"CAIRN_API_TOKEN":"app","CAIRN_ENRICHER_TOKEN":"internal"}
}
EOF
(cd "$root/worker" && npx wrangler d1 migrations apply android-recovery --local --config "$work/wrangler.jsonc" > "$work/migrations.log" 2>&1)
(cd "$root/worker" && exec setsid ./node_modules/.bin/wrangler dev --local --ip 127.0.0.1 --port "$worker_port" --config "$work/wrangler.jsonc" > "$work/worker.log" 2>&1) &
worker_pid=$!
ready=""
for _ in $(seq 1 60); do
  if ! kill -0 "$worker_pid" 2>/dev/null; then cat "$work/worker.log"; exit 1; fi
  if curl -fsS "http://127.0.0.1:$worker_port/api/v2-taxonomy" -H 'Authorization: Bearer app' > /dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ -n "$ready" ] || { cat "$work/worker.log"; exit 1; }
python3 "$root/tests/android-worker/fault_proxy.py" "http://127.0.0.1:$worker_port" "$proxy_port" > "$work/proxy.log" 2>&1 &
proxy_pid=$!
"$adb" -s "$serial" reverse tcp:18978 "tcp:$proxy_port"
(cd "$root/android" && ./gradlew --no-daemon --dependency-verification strict installDebug installDebugAndroidTest)
for phase in persistBeforeSendAndLoseFirstResponse recoverThenHandleTwoRealConflictsAndMidChainFailure discardAndAccountSwitchPreserveUnrelatedActions; do
  "$adb" -s "$serial" shell am force-stop com.alpenl.cairn.share
  "$adb" -s "$serial" shell am instrument -w -r \
    -e class "com.alpenl.cairn.share.CurationWorkerRecoveryTest#$phase" \
    -e cairnWorkerUrl http://127.0.0.1:18978 \
    com.alpenl.cairn.share.test/androidx.test.runner.AndroidJUnitRunner | tee "$work/$phase.log"
  # am instrument can exit zero on a failed test; require the actual JUnit result.
  rg -q '^OK \(1 test\)' "$work/$phase.log"
done
curl -fsS "http://127.0.0.1:$proxy_port/__test/control" > "$work/transport-history.json"
echo "PASS: three phases ran in separate Android processes against actual authenticated Worker/D1"
