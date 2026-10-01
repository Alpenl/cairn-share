import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function wranglerCommand(args) {
  try { return JSON.parse(execFileSync(path.resolve("node_modules/.bin/wrangler"), args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 })); }
  catch { throw new Error(`release_record_failed:${args[0]}_${args[1]}`); }
}

export async function recordRelease({ phase, directory, command = wranglerCommand, migrationsDirectory = "migrations",
  source = process.env.GITHUB_SHA || process.env.RELEASE_COMMIT || "unknown", enricherRevision = process.env.ENRICHER_REVISION || null,
  deployed = phase === "after" }) {
  if (!["before", "after"].includes(phase) || !directory) throw new Error("invalid_release_record_arguments");
  const files = (await readdir(migrationsDirectory)).filter(file => /^\d{4}_.+\.sql$/.test(file)).sort();
  const migrations = await Promise.all(files.map(async file => ({ file,
    sha256: createHash("sha256").update(await readFile(path.join(migrationsDirectory, file))).digest("hex") })));
  const record = { version: 1, phase, at: new Date().toISOString(), source, enricher_revision: enricherRevision,
    migrations, model_calls: 0, errors: [], deployed };
  const read = (key, args) => {
    try { record[key] = command(args); } catch { record.errors.push(`release_record_failed:${args[0]}_${args[1]}`); }
  };
  read("deployments", ["deployments", "list", "--json"]);
  read("active_deployment", ["deployments", "status", "--json"]);
  read("restore_point", ["d1", "time-travel", "info", "cairn-share", "--json"]);
  read("database", ["d1", "execute", "cairn-share", "--remote", "--json", "--command",
    "SELECT name FROM d1_migrations ORDER BY id; SELECT generation,spec_id,spec_hash,policy_version,requested_model FROM classification_targets WHERE generation=(SELECT generation FROM classification_target_state WHERE id=1); SELECT day,total,canary,fetch_first,fetch_fallback,reading FROM enrichment_provider_daily_usage ORDER BY day DESC LIMIT 7; SELECT scope,COUNT(*) AS reservations FROM budget_ledger WHERE created_at>=date('now') GROUP BY scope;"]);
  record.active_versions = [];
  const trafficVersions = Array.isArray(record.active_deployment?.versions) ? record.active_deployment.versions : [];
  if (!trafficVersions.length) record.errors.push("invalid_active_deployment");
  for (const traffic of trafficVersions) {
    if (!/^[a-f0-9-]{36}$/.test(traffic.version_id || "")) { record.errors.push("invalid_active_version"); continue; }
    try {
      const version = command(["versions", "view", traffic.version_id, "--json"]);
      // Version resources can contain bindings/configuration. Persist only
      // the immutable public identity needed to prove the deployed source.
      record.active_versions.push({ id: version.id, tag: version.annotations?.["workers/tag"] || null,
        created_on: version.metadata?.created_on || null, percentage: traffic.percentage });
      if (version.id !== traffic.version_id) record.errors.push("active_version_identity_mismatch");
    } catch { record.errors.push("release_record_failed:versions_view"); }
  }
  if (typeof record.restore_point?.bookmark !== "string" || !record.restore_point.bookmark ||
    !Array.isArray(record.deployments) || !record.deployments.length || !Array.isArray(record.database) ||
    record.database.length !== 4 || record.database.some(query => query.success !== true || !Array.isArray(query.results)))
    record.errors.push("incomplete_release_record");
  record.last_applied_migration = Array.isArray(record.database?.[0]?.results) ? record.database[0].results.at(-1)?.name || null : null;
  if (phase === "after" && record.last_applied_migration !== files.at(-1)) record.errors.push("migration_not_fully_applied");
  if (phase === "after" && deployed && (!/^[a-f0-9]{40}$/.test(source) || record.active_versions.length !== 1 ||
    record.active_versions[0]?.percentage !== 100 || record.active_versions[0]?.tag !== source)) record.errors.push("deployed_source_mismatch");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, `${phase}.json`), JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  // The recovery manifest survives every validation failure. Failure still
  // stops publication; recovery remains an explicit operator action.
  if (record.errors.length) throw new Error(record.errors.join(","));
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [phase, directory] = process.argv.slice(2);
  try {
    await recordRelease({ phase, directory, deployed: process.env.RELEASE_DEPLOYED !== "false" });
    console.log(`Saved ${phase} versions, recovery point, migration digests and aggregate budget usage.`);
  } catch (error) {
    console.error(`Release record failed: ${String(error.message).replace(/[^a-zA-Z0-9_, :.-]/g, "").slice(0, 160)}`);
    process.exitCode = 1;
  }
}
