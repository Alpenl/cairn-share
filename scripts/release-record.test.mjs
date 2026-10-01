import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordRelease } from "./release-record.mjs";

const source = "a".repeat(40), id = "11111111-1111-4111-8111-111111111111";
async function fixture(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "cairn-release-")), migrationsDirectory = path.join(directory, "migrations");
  await mkdir(migrationsDirectory); await writeFile(path.join(migrationsDirectory, "0050_fixture.sql"), "SELECT 1;");
  const deployment = { id: "deployment-fixture", versions: [{ version_id: id, percentage: options.percentage ?? 100 }] };
  const command = args => {
    if (args[0] === "deployments") return args[1] === "status" ? deployment : [deployment];
    if (args[0] === "versions") {
      if (options.versionOutage) throw new Error("never-retain-sensitive-provider-output");
      return { id, annotations: { "workers/tag": options.tag ?? source }, metadata: { created_on: "2026-10-01" },
        resources: { bindings: [{ name: "secret-binding", text: "never-retain-this-value" }] } };
    }
    if (args[1] === "time-travel") return { bookmark: "recovery-fixture" };
    return [{ success: true, results: [{ name: options.partial ? "0049_fixture.sql" : "0050_fixture.sql" }] },
      ...Array.from({ length: 3 }, () => ({ success: true, results: [] }))];
  };
  return { phase: "after", directory, migrationsDirectory, source, command };
}

test("exact source and 100 percent deployed version produce a private credential-free recovery manifest", async () => {
  const f = await fixture();
  try {
    const record = await recordRelease(f);
    assert.deepEqual(record.errors, []); assert.equal(record.active_versions[0].tag, source);
    const data = await readFile(path.join(f.directory, "after.json"), "utf8");
    assert.equal(data.includes("secret-binding"), false); assert.equal(data.includes("never-retain-this-value"), false);
    assert.equal((await stat(path.join(f.directory, "after.json"))).mode & 0o777, 0o600);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test("wrong source or partial traffic fails after saving resulting version metadata", async () => {
  for (const options of [{ tag: "b".repeat(40) }, { percentage: 50 }]) {
    const f = await fixture(options);
    try {
      await assert.rejects(recordRelease(f), /deployed_source_mismatch/);
      const record = JSON.parse(await readFile(path.join(f.directory, "after.json"), "utf8"));
      assert.ok(record.errors.includes("deployed_source_mismatch")); assert.equal(record.restore_point.bookmark, "recovery-fixture");
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  }
});
test("partial migrations without a deployment still save a failing after-state recovery record", async () => {
  const f = await fixture({ partial: true });
  try {
    await assert.rejects(recordRelease({ ...f, deployed: false }), /migration_not_fully_applied/);
    const record = JSON.parse(await readFile(path.join(f.directory, "after.json"), "utf8"));
    assert.equal(record.deployed, false); assert.equal(record.last_applied_migration, "0049_fixture.sql");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test("version API outage records a safe error and does not silently pass publication", async () => {
  const f = await fixture({ versionOutage: true });
  try {
    await assert.rejects(recordRelease(f), /release_record_failed:versions_view/);
    const data = await readFile(path.join(f.directory, "after.json"), "utf8");
    assert.equal(data.includes("never-retain-sensitive-provider-output"), false);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
