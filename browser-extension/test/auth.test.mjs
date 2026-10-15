import test from "node:test";
import assert from "node:assert/strict";
import { createAuth } from "../src/auth.mjs";

const REDIRECT = "https://extension-id.chromiumapp.org/";
const BASE = "https://cairn.test/api/v1/auth";
const json = (data, status = 200) => new Response(JSON.stringify({ code: status === 200 ? "OK" : "INVALID_REQUEST", data }), { status });

async function s256(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// The library side of the flow: echo state, hand back a code, and check that
// the redeemed verifier matches the challenge sent at the start.
function library({ respond = (state) => `${REDIRECT}?code=grant-1&state=${state}`, providers = ["github", "unreleased"] } = {}) {
  const seen = { started: null, redeemed: null };
  const identity = {
    getRedirectURL: () => REDIRECT,
    async launchWebAuthFlow({ url, interactive }) {
      assert.equal(interactive, true);
      seen.started = new URL(url);
      return respond(seen.started.searchParams.get("state"));
    }
  };
  const fetchImpl = async (url, init = {}) => {
    if (url === `${BASE}/methods?client=extension`) return json({ password: false, providers });
    if (url === `${BASE}/extension/token`) {
      seen.redeemed = JSON.parse(init.body);
      assert.equal(await s256(seen.redeemed.code_verifier), seen.started.searchParams.get("code_challenge"));
      return json({ token: "cairn_c_" + "a".repeat(64), id: "t", label: seen.redeemed.label });
    }
    return new Response("{}", { status: 404 });
  };
  return { auth: createAuth({ identity, fetchImpl, base: BASE }), seen };
}

test("lists only providers the extension can present", async () => {
  assert.deepEqual(await library().auth.providers(), ["github"]);
  assert.deepEqual(await createAuth({ identity: undefined, fetchImpl: () => assert.fail("no request"), base: BASE }).providers(), []);
  const old = createAuth({ identity: { launchWebAuthFlow() {}, getRedirectURL: () => REDIRECT }, fetchImpl: async () => new Response("{}", { status: 401 }), base: BASE });
  assert.deepEqual(await old.providers(), []);
});

test("sign-in uses PKCE and the registered redirect, then redeems a collector token", async () => {
  const { auth, seen } = library();
  const token = await auth.signIn("github", "Cairn 插件 · Chrome");
  assert.match(token, /^cairn_c_/);
  const q = seen.started.searchParams;
  assert.equal(seen.started.pathname, "/api/v1/auth/github/start");
  assert.equal(q.get("client"), "extension");
  assert.equal(q.get("redirect_uri"), REDIRECT);
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.match(q.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(q.has("code_verifier"), false);
  assert.deepEqual({ code: seen.redeemed.code, label: seen.redeemed.label }, { code: "grant-1", label: "Cairn 插件 · Chrome" });
});

test("sign-in failures map to actionable kinds and never redeem", async () => {
  for (const [respond, kind] of [
    [(state) => `${REDIRECT}?error=forbidden&state=${state}`, "sign_in_forbidden"],
    [(state) => `${REDIRECT}?error=denied&state=${state}`, "sign_in_denied"],
    [(state) => `${REDIRECT}?error=something_new&state=${state}`, "sign_in_failed"],
    [() => `${REDIRECT}?code=grant-1&state=forged`, "sign_in_expired"],
    [() => "https://elsewhere.test/?code=grant-1", "sign_in_expired"],
    [() => { throw new Error("The user did not approve access."); }, "sign_in_cancelled"]
  ]) {
    const { auth, seen } = library({ respond });
    await assert.rejects(auth.signIn("github", "x"), { kind });
    assert.equal(seen.redeemed, null);
  }
  await assert.rejects(library().auth.signIn("unreleased", "x"), { kind: "unexpected" });
});
