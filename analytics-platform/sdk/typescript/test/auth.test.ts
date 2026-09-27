import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "../src/index.js";
import { client, json, mockFetch, tokenPair } from "./helpers.js";

describe("auth header selection", () => {
  it("sends an API key as X-API-Key and never as Authorization", async () => {
    const { fetch, calls } = mockFetch([json([])]);
    await client(fetch, { apiKey: "ap_live_123", accessToken: "tok" }).datasets.list();
    expect(calls[0]!.headers["x-api-key"]).toBe("ap_live_123");
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.url).toBe("https://api.test/v1/datasets");
  });

  it("sends a user access token as a Bearer token", async () => {
    const { fetch, calls } = mockFetch([json([])]);
    await client(fetch, { accessToken: "tok" }).datasets.list();
    expect(calls[0]!.headers.authorization).toBe("Bearer tok");
    expect(calls[0]!.headers["x-api-key"]).toBeUndefined();
  });

  it("sends no credentials when none are configured", async () => {
    const { fetch, calls } = mockFetch([json([])]);
    await client(fetch).datasets.list();
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.headers["x-api-key"]).toBeUndefined();
  });

  it("login posts credentials without auth, stores the tokens and notifies onTokens", async () => {
    const onTokens = vi.fn();
    const { fetch, calls } = mockFetch([json(tokenPair(1)), json({ id: "u1" })]);
    const ap = client(fetch, { accessToken: "stale", onTokens });
    const pair = await ap.auth.login({ email: "a@b.co", password: "correct horse", totp: "123456" });

    expect(pair.access_token).toBe("access-1");
    expect(calls[0]!.url).toBe("https://api.test/v1/auth/login");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ email: "a@b.co", password: "correct horse", totp: "123456" });
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(onTokens).toHaveBeenCalledWith(tokenPair(1));
    expect(ap.getTokens()).toEqual({ accessToken: "access-1", refreshToken: "refresh-1" });

    await ap.auth.me();
    expect(calls[1]!.headers.authorization).toBe("Bearer access-1");
  });

  it("surfaces detail.code on login failures", async () => {
    const { fetch } = mockFetch([json({ detail: { code: "mfa_required", message: "TOTP code required" } }, 401)]);
    const err = await client(fetch).auth.login({ email: "a@b.co", password: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.code).toBe("mfa_required");
    expect(err.message).toContain("TOTP code required");
  });

  it("logout revokes the refresh token and clears the session", async () => {
    const { fetch, calls } = mockFetch([json(null, 204)]);
    const ap = client(fetch, { accessToken: "a", refreshToken: "r" });
    await ap.auth.logout();
    expect(calls[0]!.body).toEqual({ refresh_token: "r" });
    expect(ap.getTokens()).toEqual({ accessToken: undefined, refreshToken: undefined });
  });
});

describe("token refresh", () => {
  it("refreshes on 401 and replays the request with the new token", async () => {
    const onTokens = vi.fn();
    const { fetch, calls } = mockFetch([
      json({ detail: { code: "expired", message: "token expired" } }, 401),
      json(tokenPair(2)),
      json({ id: "u1" }),
    ]);
    const ap = client(fetch, { accessToken: "access-1", refreshToken: "refresh-1", onTokens });
    await expect(ap.auth.me()).resolves.toEqual({ id: "u1" });

    expect(calls.map((c) => c.url)).toEqual([
      "https://api.test/v1/auth/me",
      "https://api.test/v1/auth/refresh",
      "https://api.test/v1/auth/me",
    ]);
    expect(calls[1]!.body).toEqual({ refresh_token: "refresh-1" });
    expect(calls[1]!.headers.authorization).toBeUndefined();
    expect(calls[2]!.headers.authorization).toBe("Bearer access-2");
    expect(onTokens).toHaveBeenCalledWith(tokenPair(2));
  });

  it("runs a single refresh for concurrent 401s", async () => {
    let refreshes = 0;
    const { fetch, calls } = mockFetch(async (call) => {
      if (call.url.endsWith("/v1/auth/refresh")) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 5));
        return json(tokenPair(2));
      }
      return call.headers.authorization === "Bearer access-2" ? json({ ok: true }) : json({ detail: "expired" }, 401);
    });
    const ap = client(fetch, { accessToken: "access-1", refreshToken: "refresh-1" });
    const results = await Promise.all([ap.datasets.list(), ap.jobs.list(), ap.models.list(), ap.auth.me()]);
    expect(results).toHaveLength(4);
    expect(refreshes).toBe(1);
    expect(calls.filter((c) => c.url.endsWith("/refresh"))).toHaveLength(1);
  });

  it("uses the rotated refresh token for the next refresh", async () => {
    const { fetch, calls } = mockFetch([
      json({ detail: "expired" }, 401),
      json(tokenPair(2)),
      json({}),
      json({ detail: "expired" }, 401),
      json(tokenPair(3)),
      json({}),
    ]);
    const ap = client(fetch, { accessToken: "access-1", refreshToken: "refresh-1" });
    await ap.auth.me();
    await ap.auth.me();
    const refreshBodies = calls.filter((c) => c.url.endsWith("/refresh")).map((c) => c.body);
    expect(refreshBodies).toEqual([{ refresh_token: "refresh-1" }, { refresh_token: "refresh-2" }]);
    expect(ap.getTokens()).toEqual({ accessToken: "access-3", refreshToken: "refresh-3" });
  });

  it("refreshes up front when only a refresh token is known", async () => {
    const { fetch, calls } = mockFetch([json(tokenPair(5)), json([])]);
    await client(fetch, { refreshToken: "refresh-4" }).datasets.list();
    expect(calls[0]!.url).toBe("https://api.test/v1/auth/refresh");
    expect(calls[1]!.headers.authorization).toBe("Bearer access-5");
  });

  it("throws AuthenticationError and drops the session when the refresh token is rejected", async () => {
    const { fetch } = mockFetch([json({ detail: "expired" }, 401), json({ detail: { code: "invalid_refresh", message: "reused" } }, 401)]);
    const ap = client(fetch, { accessToken: "access-1", refreshToken: "refresh-1" });
    const err = await ap.auth.me().catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.code).toBe("invalid_refresh");
    expect(ap.getTokens()).toEqual({ accessToken: undefined, refreshToken: undefined });
  });

  it("does not loop: a second 401 after refreshing is thrown", async () => {
    const { fetch, calls } = mockFetch([json({ detail: "expired" }, 401), json(tokenPair(2)), json({ detail: "nope" }, 401)]);
    const err = await client(fetch, { accessToken: "access-1", refreshToken: "refresh-1" }).auth.me().catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(calls).toHaveLength(3);
  });

  it("does not refresh for API-key clients", async () => {
    const { fetch, calls } = mockFetch([json({ detail: { code: "invalid_key", message: "bad key" } }, 401)]);
    const err = await client(fetch, { apiKey: "ap_live_x", refreshToken: "r" }).datasets.list().catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(calls).toHaveLength(1);
  });
});
