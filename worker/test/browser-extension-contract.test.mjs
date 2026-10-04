import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { createClient } from "../../browser-extension/src/api.mjs";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

it("the browser client authenticates and retries the same capture against the real Worker/D1 contract", async () => {
  const token = "browser_contract_test_token";
  const bindings = { ...env, CAIRN_API_TOKEN: token };
  const client = createClient({ fetchImpl: (url, { method, headers, body }) =>
    worker.fetch(new Request(url, { method, headers, body }), bindings) });
  await client.test(token);
  await expect(client.test("incorrect")).rejects.toMatchObject({ kind: "invalid_token" });
  const capture = {
    url: "HTTPS://Example.com/Keep%2FCase?source=browser#Section",
    note: "line one\n稍后阅读",
    client_id: "3f55e9e8-4d52-4f45-a33d-89be8ef7ab45",
    title: "This remains local"
  };
  const first = await client.upload(token, capture);
  const retry = await client.upload(token, capture);
  expect(retry).toEqual(first);
  expect(first).toMatchObject({ url: capture.url, note: capture.note, learned: false });
  const listed = await worker.fetch(new Request("https://share.alpenl.com/api/links", {
    headers: { Authorization: `Bearer ${token}` }
  }), bindings);
  expect((await listed.json()).items).toHaveLength(1);
});
