import { AUTH_API_BASE, CaptureError } from "./config.mjs";

// How each sign-in provider is presented. The library decides which providers
// it offers; one without an entry here is not shown. Adding a provider to the
// extension is one entry: its name and a 24×24 mark path.
export const AUTH_PROVIDERS = {
  github: {
    name: "GitHub",
    mark: "M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-1.96c-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z"
  }
};

const SIGN_IN_FAILURES = new Set(["denied", "forbidden", "expired"]);
const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomToken = (size) => base64url(crypto.getRandomValues(new Uint8Array(size)));

// Signs in through the library, which brokers every provider: the provider
// redirects back to the library, the library redirects to this extension with
// a one-time code, and the code plus the PKCE verifier buys a collector token.
// Nothing here is provider-specific beyond its ID.
export function createAuth({ identity, fetchImpl = fetch, base = AUTH_API_BASE, timeoutMs = 10000 }) {
  async function call(path, init = {}) {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base}${path}`, { ...init, credentials: "omit", cache: "no-store", redirect: "error", signal: abort.signal });
      if (response.status === 401 || response.status === 404) return null;
      if (response.status === 400) throw new CaptureError("sign_in_expired");
      if (response.status >= 500 || response.status === 429) throw new CaptureError("server");
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.code !== "OK") throw new CaptureError("response");
      return data.data;
    } catch (error) {
      throw error instanceof CaptureError ? error : new CaptureError(abort.signal.aborted ? "timeout" : "network");
    } finally { clearTimeout(timeout); }
  }

  // Older libraries (no /auth) and browsers without the identity API offer none.
  async function providers() {
    if (typeof identity?.launchWebAuthFlow !== "function") return [];
    const methods = await call("/methods?client=extension");
    return (methods?.providers ?? []).filter((id) => Object.hasOwn(AUTH_PROVIDERS, id));
  }

  async function signIn(provider, label) {
    if (!Object.hasOwn(AUTH_PROVIDERS, provider)) throw new CaptureError("unexpected");
    const redirectUri = identity.getRedirectURL();
    const state = randomToken(24);
    const verifier = randomToken(48);
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const query = new URLSearchParams({ client: "extension", redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: "S256" });
    let returned;
    try { returned = await identity.launchWebAuthFlow({ url: `${base}/${provider}/start?${query}`, interactive: true }); }
    catch { throw new CaptureError("sign_in_cancelled"); }
    const result = new URL(returned);
    if (!returned.startsWith(redirectUri) || result.searchParams.get("state") !== state) throw new CaptureError("sign_in_expired");
    const error = result.searchParams.get("error");
    if (error) throw new CaptureError(`sign_in_${SIGN_IN_FAILURES.has(error) ? error : "failed"}`);
    const credential = await call("/extension/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: result.searchParams.get("code") ?? "", code_verifier: verifier, label })
    });
    if (typeof credential?.token !== "string" || !credential.token.startsWith("cairn_c_")) throw new CaptureError("response");
    return credential.token;
  }

  return { providers, signIn, redirectURL: () => identity?.getRedirectURL?.() ?? "" };
}
