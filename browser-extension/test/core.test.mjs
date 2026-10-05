import assert from "node:assert/strict";
import test from "node:test";
import { CaptureError, MAX_QUEUE, tokenIdentity, submissionUrl, validateCapture } from "../src/config.mjs";
import { createClient } from "../src/api.mjs";
import { createController } from "../src/controller.mjs";

const URL_VALUE = "https://example.com/a%2fb?q=%20&x=2#fragment";
const record = (body) => ({ id: 1, ...body, created_at: "2026-10-03T00:00:00Z", learned: false, learned_at: null });
const capture = (patch = {}) => ({ url: URL_VALUE, note: "稍后再读", title: "Example", client_id: crypto.randomUUID(), ...patch });

function harness(overrides = {}) {
  let stored;
  let clock = 1000;
  const requests = [];
  const store = {
    read: async () => structuredClone(stored),
    write: async (state) => { stored = structuredClone(state); }
  };
  const client = {
    test: async () => {},
    upload: async (token, job) => { requests.push({ token, job: structuredClone(job) }); return record(job); },
    ...overrides
  };
  const options = { store, client, now: () => clock };
  return { controller: createController(options), requests, client, store,
    recreate: () => createController(options), tick: (ms) => { clock += ms; }, raw: () => structuredClone(stored) };
}

const connect = (controller, token = "test-token", patch = {}) => controller.saveSettings({ token, keepFullUrl: true, ...patch });

test("matches Worker URL and note limits, retaining exact query/fragment/escapes", () => {
  assert.deepEqual(validateCapture(` ${URL_VALUE} `, "a\n备注"), { url: URL_VALUE, note: "a\n备注" });
  assert.equal(submissionUrl(URL_VALUE, true), URL_VALUE);
  assert.equal(submissionUrl(URL_VALUE, false), "https://example.com/a%2fb");
  for (const url of ["chrome://settings", "about:blank", "file:///a", "javascript:alert(1)", "https:example.com", "https://user:pass@example.com", "https:///example.com", "https://example.com/" + "a".repeat(8192)]) {
    assert.throws(() => validateCapture(url), { kind: "invalid_url" });
  }
  assert.throws(() => validateCapture(URL_VALUE, "😀".repeat(1001)), { kind: "invalid_note" });
});

test("client follows Worker contract and never sends local title/binding", async () => {
  const seen = [];
  const client = createClient({ fetchImpl: async (url, options) => {
    seen.push({ url, options });
    return Response.json(options.body ? record(JSON.parse(options.body)) : { items: [], next_before_id: null });
  } });
  await client.test("secret");
  const job = capture({ binding: "local-hash", attempts: 2 });
  await client.upload("secret", job);
  assert.equal(seen[0].url, "https://share.alpenl.com/api/links?limit=1");
  assert.equal(seen[1].options.headers.Authorization, "Bearer secret");
  assert.equal(seen[1].options.credentials, "omit");
  assert.equal(seen[1].options.redirect, "error");
  assert.deepEqual(JSON.parse(seen[1].options.body), { url: job.url, note: job.note, client_id: job.client_id });
});

test("client detects authentication, malformed success, network and timeout errors", async () => {
  for (const [response, kind] of [[new Response("", { status: 401 }), "invalid_token"],
    [new Response("", { status: 503 }), "server"], [new Response("", { status: 429 }), "server"],
    [Response.json({ error: "invalid_url" }, { status: 400 }), "invalid_url"],
    [Response.json({ id: 1, url: "https://wrong.example", note: "" }), "response"]]) {
    const client = createClient({ fetchImpl: async () => response });
    await assert.rejects(client.upload("secret", capture()), { kind });
  }
  await assert.rejects(createClient({ fetchImpl: async () => { throw new TypeError("offline"); } }).test("secret"), { kind: "network" });
  const timeoutClient = createClient({ timeoutMs: 5, fetchImpl: async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  }) });
  await assert.rejects(timeoutClient.test("secret"), { kind: "timeout" });
});

test("failed connection test leaves active settings untouched and snapshots omit token", async () => {
  const h = harness();
  await connect(h.controller);
  h.client.test = async () => { throw new CaptureError("invalid_token"); };
  await assert.rejects(connect(h.controller, "wrong-token"), { kind: "invalid_token" });
  assert.equal(h.raw().settings.token, "test-token");
  assert.equal(JSON.stringify(await h.controller.snapshot()).includes("test-token"), false);
});

test("capture is durable before network and survives controller restart", async () => {
  const h = harness();
  await assert.rejects(h.controller.enqueue(capture()), { kind: "not_configured" });
  await connect(h.controller);
  const item = capture();
  await h.controller.enqueue(item);
  assert.equal(h.requests.length, 0);
  assert.equal((await h.recreate().snapshot()).queue[0].client_id, item.client_id);
  await h.recreate().flush();
  assert.equal((await h.controller.snapshot()).queue.length, 0);
  assert.equal(h.requests[0].job.url, URL_VALUE);
});

test("concurrent captures and double clicks never overwrite or duplicate queue items", async () => {
  const h = harness();
  await connect(h.controller);
  const items = Array.from({ length: 15 }, () => capture());
  await Promise.all([...items, items[0], items[0]].map(h.controller.enqueue));
  assert.equal((await h.controller.snapshot()).queue.length, 15);
  await Promise.all([h.controller.flush(), h.controller.flush()]);
  assert.equal(h.requests.length, 15);
  assert.equal((await h.controller.snapshot()).queue.length, 0);
});

test("response loss retries exactly the same UUID and upload payload", async () => {
  const h = harness();
  await connect(h.controller);
  const item = capture();
  await h.controller.enqueue(item);
  const originalUpload = h.client.upload;
  h.client.upload = async (token, job) => { await originalUpload(token, job); throw new CaptureError("network"); };
  await h.controller.flush();
  assert.equal((await h.controller.snapshot()).queue[0].errorKind, "network");
  await h.controller.flush();
  assert.equal(h.requests.length, 1, "backoff should suppress an immediate automatic retry");
  h.client.upload = originalUpload;
  await h.recreate().flush({ force: true });
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1].job.client_id, h.requests[0].job.client_id);
  assert.equal(h.requests[1].job.note, item.note);
});

test("token errors pause automatic retry and explicit reconnect unblocks queue", async () => {
  const h = harness({ upload: async () => { throw new CaptureError("invalid_token"); } });
  await connect(h.controller);
  await h.controller.enqueue(capture());
  await h.controller.flush();
  h.tick(3600000);
  let uploads = 0;
  h.client.upload = async (_token, job) => { uploads++; return record(job); };
  await h.controller.flush();
  assert.equal(uploads, 0);
  await h.controller.flush({ force: true });
  assert.equal(uploads, 1);
});

test("changing token with pending tasks requires explicit transfer and preserves IDs", async () => {
  const h = harness();
  await connect(h.controller);
  const item = capture();
  await h.controller.enqueue(item);
  await assert.rejects(connect(h.controller, "new-token"), { kind: "queue_connection" });
  assert.equal(h.raw().settings.token, "test-token");
  await connect(h.controller, "new-token", { movePending: true });
  await h.controller.flush();
  assert.equal(h.requests[0].token, "new-token");
  assert.equal(h.requests[0].job.client_id, item.client_id);
});

test("capturing while upload is in progress preserves both operations", async () => {
  const h = harness();
  await connect(h.controller);
  let complete;
  let started;
  const start = new Promise((resolve) => { started = resolve; });
  h.client.upload = async (_token, job) => {
    started();
    if (!complete) await new Promise((resolve) => { complete = resolve; });
    return record(job);
  };
  await h.controller.enqueue(capture());
  const uploading = h.controller.flush();
  await start;
  const second = capture();
  await h.controller.enqueue(second);
  assert.equal((await h.controller.snapshot()).queue.length, 2);
  complete();
  await uploading;
  assert.equal((await h.controller.snapshot()).queue.length, 0);
});

test("storage write failure never reports a saved capture", async () => {
  const h = harness();
  await connect(h.controller);
  h.store.write = async () => { throw new Error("disk full"); };
  await assert.rejects(h.controller.enqueue(capture()), { kind: "storage" });
  assert.equal((await h.controller.snapshot()).queue.length, 0);
  assert.equal(h.requests.length, 0);
});

test("URL stripping preference changes submission only, and queue is bounded", async () => {
  const h = harness();
  await connect(h.controller, "test-token", { keepFullUrl: false });
  await Promise.all(Array.from({ length: MAX_QUEUE }, () => h.controller.enqueue(capture())));
  assert.equal((await h.controller.snapshot()).queue[0].url, "https://example.com/a%2fb");
  await assert.rejects(h.controller.enqueue(capture()), { kind: "queue_full" });
});


test("collection selections survive restart and lost membership response without another capture",async()=>{
 const cid=crypto.randomUUID(),seen=[];let uploads=0,lose=true;
 const h=harness({upload:async(_token,job)=>{if(job.savedLink)return job.savedLink;uploads++;return record(job);},collections:async()=>[{id:cid,name:"设计",revision:1,deleted:0,archived:0}],addCollection:async(_token,id,body)=>{seen.push(structuredClone(body));if(lose){lose=false;throw new CaptureError("network");}return {revision:2};}});
 await connect(h.controller);await h.controller.enqueue(capture({collection_ids:[cid],binding:await tokenIdentity("test-token")}));await h.controller.flush();assert.equal(h.raw().queue[0].savedLink.id,1);
 await h.recreate().flush({force:true});assert.equal(uploads,1);assert.equal(seen.length,2);assert.deepEqual(seen[0],seen[1]);assert.equal(h.raw().queue.length,0);
});
test("collection version conflicts require human retry, and moving accounts clears stale selections",async()=>{
 const cid=crypto.randomUUID();let conflicts=true,revision=1,calls=0;const seen=[];
 const h=harness({collections:async()=>[{id:cid,revision,deleted:0,archived:0}],addCollection:async(_token,_id,body)=>{calls++;seen.push(body);if(conflicts)throw new CaptureError("revision_conflict");return {revision:revision+1};}});
 await connect(h.controller);await h.controller.enqueue(capture({collection_ids:[cid],binding:await tokenIdentity("test-token")}));await h.controller.flush();h.tick(3600000);await h.controller.flush();assert.equal(calls,1);conflicts=false;revision=2;await h.controller.flush({force:true});assert.equal(seen[1].expected_revision,2);assert.notEqual(seen[1].operation_key,seen[0].operation_key);
 await h.controller.enqueue(capture({collection_ids:[cid],binding:await tokenIdentity("test-token")}));await connect(h.controller,"second-token",{movePending:true});assert.deepEqual(h.raw().queue[0].collection_ids,[]);
 await assert.rejects(h.controller.enqueue(capture({collection_ids:[cid],binding:await tokenIdentity("test-token")})),{kind:"queue_connection"});
});
