import { describe, expect, it } from "vitest";
import {
  ApiError,
  AuthenticationError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ServerError,
  ValidationError,
} from "../src/index.js";
import { parseRetryAfter } from "../src/errors.js";
import { client, json, mockFetch } from "./helpers.js";

describe("error mapping", () => {
  it.each([
    [400, ApiError],
    [401, AuthenticationError],
    [403, ForbiddenError],
    [404, NotFoundError],
    [409, ConflictError],
    [413, ApiError],
    [422, ValidationError],
    [429, RateLimitError],
    [500, ServerError],
    [507, ServerError],
  ])("maps %i to %s", async (status, cls) => {
    const { fetch } = mockFetch([json({ detail: `status ${status}` }, status)]);
    const err = await client(fetch, { maxRetries: 0 }).datasets.get("d1").catch((e) => e);
    expect(err).toBeInstanceOf(cls);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(status);
    expect(err.detail).toBe(`status ${status}`);
    expect(err.message).toContain(`status ${status}`);
    expect(err.code).toBeUndefined();
    expect(err.method).toBe("GET");
    expect(err.url).toBe("https://api.test/v1/datasets/d1");
  });

  it("names the error classes", async () => {
    const { fetch } = mockFetch([json({ detail: "missing permission models.train" }, 403)]);
    const err = await client(fetch).experiments.list().catch((e) => e);
    expect(err.name).toBe("ForbiddenError");
  });

  it("reads detail.code and detail.message from structured details", async () => {
    const { fetch } = mockFetch([json({ detail: { code: "locked", message: "account locked" } }, 401)]);
    const err = await client(fetch).auth.me().catch((e) => e);
    expect(err.code).toBe("locked");
    expect(err.detail).toEqual({ code: "locked", message: "account locked" });
    expect(err.message).toBe("401: account locked");
  });

  it("exposes validation issues from pydantic and schema errors", async () => {
    const { fetch } = mockFetch([
      json({ detail: [{ loc: ["body", "name"], msg: "String should have at least 1 character", type: "string_too_short" }] }, 422),
      json({ detail: { message: "schema is invalid", issues: [{ path: "entities[0]", message: "no fields", severity: "error" }] } }, 422),
    ]);
    const ap = client(fetch);
    const e1 = await ap.dashboards.create({ name: "" }).catch((e) => e);
    expect(e1).toBeInstanceOf(ValidationError);
    expect(e1.issues).toHaveLength(1);
    expect(e1.message).toContain("body.name: String should have at least 1 character");
    const e2 = await ap.schemas.validate({ entities: [] }).catch((e) => e);
    expect(e2.issues).toEqual([{ path: "entities[0]", message: "no fields", severity: "error" }]);
  });

  it("handles non-JSON error bodies", async () => {
    const { fetch } = mockFetch([new Response("upstream exploded", { status: 502, headers: { "content-type": "text/plain" } })]);
    const err = await client(fetch, { maxRetries: 0 }).datasets.list().catch((e) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect(err.detail).toBe("upstream exploded");
  });

  it("parses Retry-After as seconds or an HTTP date", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
