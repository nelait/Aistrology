import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, errorMessage, memoryTokenStorage } from "./api";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setup(handler: Handler, refresh: string | null = "r1") {
  const storage = memoryTokenStorage(refresh);
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(String(input), init ?? {})));
  const client = new ApiClient({ baseUrl: "http://api.test", fetch: fetchMock as unknown as typeof fetch, storage });
  return { client, storage, fetchMock };
}

const auth = (init: RequestInit) => (init.headers as Record<string, string> | undefined)?.Authorization;

describe("ApiClient token refresh", () => {
  it("refreshes once for concurrent 401s and retries every request with the new token", async () => {
    let refreshCalls = 0;
    const { client, storage } = setup(async (url, init) => {
      if (url.endsWith("/v1/auth/refresh")) {
        refreshCalls++;
        const body = JSON.parse(String(init.body)) as { refresh_token: string };
        expect(body.refresh_token).toBe("r1"); // single-use token is only sent once
        await new Promise((r) => setTimeout(r, 10));
        return json(200, { access_token: "a2", refresh_token: "r2", expires_in: 900, token_type: "bearer" });
      }
      return auth(init) === "Bearer a2" ? json(200, { ok: url }) : json(401, { detail: "expired" });
    });
    client.setTokens({ access_token: "a1", refresh_token: "r1", expires_in: 900, token_type: "bearer" });

    const results = await Promise.all([client.get("/v1/a"), client.get("/v1/b"), client.get("/v1/c")]);
    expect(results).toEqual([{ ok: "http://api.test/v1/a" }, { ok: "http://api.test/v1/b" }, { ok: "http://api.test/v1/c" }]);
    expect(refreshCalls).toBe(1);
    expect(storage.get()).toBe("r2");
    expect(client.getAccessToken()).toBe("a2");
  });

  it("does not refresh again when another request already rotated the token", async () => {
    let refreshCalls = 0;
    let releaseSlow: () => void = () => {};
    const slowGate = new Promise<void>((r) => (releaseSlow = r));
    const { client } = setup(async (url, init) => {
      if (url.endsWith("/v1/auth/refresh")) {
        refreshCalls++;
        return json(200, { access_token: `a${refreshCalls + 1}`, refresh_token: `r${refreshCalls + 1}`, expires_in: 900, token_type: "bearer" });
      }
      if (url.endsWith("/slow") && auth(init) === "Bearer a1") {
        await slowGate; // resolves after the fast request refreshed
        return json(401, { detail: "expired" });
      }
      return auth(init) === "Bearer a2" ? json(200, { ok: true }) : json(401, { detail: "expired" });
    });
    client.setTokens({ access_token: "a1", refresh_token: "r1", expires_in: 900, token_type: "bearer" });
    const slow = client.get("/v1/slow");
    await client.get("/v1/fast");
    releaseSlow();
    await expect(slow).resolves.toEqual({ ok: true });
    expect(refreshCalls).toBe(1);
  });

  it("bootstraps the access token from the stored refresh token", async () => {
    const { client, fetchMock } = setup((url, init) => {
      if (url.endsWith("/v1/auth/refresh")) return json(200, { access_token: "a9", refresh_token: "r9", expires_in: 900, token_type: "bearer" });
      return auth(init) === "Bearer a9" ? json(200, { id: "u1" }) : json(401, {});
    });
    await expect(client.get("/v1/auth/me")).resolves.toEqual({ id: "u1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clears the session and notifies listeners when the refresh token is rejected", async () => {
    const { client, storage } = setup((url) => (url.endsWith("/v1/auth/refresh") ? json(401, { detail: { code: "invalid_credentials", message: "bad token" } }) : json(401, { detail: "expired" })));
    client.setTokens({ access_token: "a1", refresh_token: "r1", expires_in: 900, token_type: "bearer" });
    const lost = vi.fn();
    client.onAuthChange(lost);
    await expect(client.get("/v1/x")).rejects.toMatchObject({ status: 401 });
    expect(storage.get()).toBeNull();
    expect(client.isAuthenticated).toBe(false);
    expect(lost).toHaveBeenCalledWith(false);
  });

  it("retries the refresh with a newer token rotated by another tab", async () => {
    const storage = memoryTokenStorage("r1");
    const seen: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/refresh")) {
        const token = (JSON.parse(String(init?.body)) as { refresh_token: string }).refresh_token;
        seen.push(token);
        if (token === "r1") {
          storage.set("r1-from-other-tab"); // the other tab won the race
          return json(401, { detail: { code: "invalid_credentials" } });
        }
        return json(200, { access_token: "a3", refresh_token: "r3", expires_in: 900, token_type: "bearer" });
      }
      return json(200, {});
    });
    const client = new ApiClient({ baseUrl: "http://api.test", fetch: fetchMock as unknown as typeof fetch, storage });
    await expect(client.refresh()).resolves.toBe(true);
    expect(seen).toEqual(["r1", "r1-from-other-tab"]);
    expect(storage.get()).toBe("r3");
  });

  it("does not attach tokens or refresh for unauthenticated calls", async () => {
    const { client, fetchMock } = setup((_url, init) => {
      expect(auth(init)).toBeUndefined();
      return json(401, { detail: { code: "mfa_required", message: "MFA code required" } });
    });
    const err = await client.request("/v1/auth/login", { method: "POST", json: {}, auth: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("mfa_required");
    expect((err as ApiError).message).toBe("MFA code required");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("errorMessage", () => {
  it("formats FastAPI validation errors", () => {
    expect(errorMessage([{ loc: ["body", "email"], msg: "value is not a valid email" }])).toBe("email: value is not a valid email");
  });
  it("formats schema issue payloads", () => {
    expect(errorMessage({ message: "schema is invalid", issues: [{ path: "customers.id", message: "duplicate field" }] })).toBe("schema is invalid: customers.id: duplicate field");
  });
});
