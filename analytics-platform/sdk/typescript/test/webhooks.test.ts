import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeWebhookSignature, verifyWebhookSignature } from "../src/index.js";

const secret = "whsec_test_secret";
const body = JSON.stringify({ event: "job.succeeded", data: { job_id: "j1", type: "training.run" } });

/** Same scheme as the backend: `t=<ts>,v1=<hex hmac-sha256(secret, f"{ts}." + body)>`. */
function sign(ts: number, payload: string | Buffer = body, key = secret): string {
  const mac = createHmac("sha256", key).update(`${ts}.`).update(payload).digest("hex");
  return `t=${ts},v1=${mac}`;
}

describe("verifyWebhookSignature", () => {
  const now = 1_780_000_000;

  it("accepts a valid signature", async () => {
    await expect(verifyWebhookSignature(secret, body, sign(now), 300, { now })).resolves.toBe(true);
  });

  it("accepts the current time by default", async () => {
    const ts = Math.floor(Date.now() / 1000);
    await expect(verifyWebhookSignature(secret, body, sign(ts))).resolves.toBe(true);
  });

  it("accepts Uint8Array and ArrayBuffer bodies", async () => {
    const bytes = new TextEncoder().encode(body);
    await expect(verifyWebhookSignature(secret, bytes, sign(now), 300, { now })).resolves.toBe(true);
    await expect(verifyWebhookSignature(secret, bytes.buffer, sign(now), 300, { now })).resolves.toBe(true);
  });

  it("handles non-ASCII bodies byte-for-byte", async () => {
    const utf8 = '{"name":"Zoë — 東京"}';
    await expect(verifyWebhookSignature(secret, utf8, sign(now, Buffer.from(utf8, "utf8")), 300, { now })).resolves.toBe(true);
  });

  it("rejects a tampered body, wrong secret or bad header", async () => {
    await expect(verifyWebhookSignature(secret, body + " ", sign(now), 300, { now })).resolves.toBe(false);
    await expect(verifyWebhookSignature("other", body, sign(now), 300, { now })).resolves.toBe(false);
    await expect(verifyWebhookSignature(secret, body, "garbage", 300, { now })).resolves.toBe(false);
    await expect(verifyWebhookSignature(secret, body, `t=${now}`, 300, { now })).resolves.toBe(false);
    await expect(verifyWebhookSignature(secret, body, null, 300, { now })).resolves.toBe(false);
    await expect(verifyWebhookSignature(secret, body, `t=${now},v1=${"0".repeat(64)}`, 300, { now })).resolves.toBe(false);
  });

  it("rejects timestamps outside the tolerance", async () => {
    await expect(verifyWebhookSignature(secret, body, sign(now - 301), 300, { now })).resolves.toBe(false);
    await expect(verifyWebhookSignature(secret, body, sign(now + 301), 300, { now })).resolves.toBe(false);
    await expect(verifyWebhookSignature(secret, body, sign(now - 299), 300, { now })).resolves.toBe(true);
    await expect(verifyWebhookSignature(secret, body, sign(now - 1000), 3600, { now })).resolves.toBe(true);
  });

  it("computes the same hex digest as node:crypto", async () => {
    const expected = createHmac("sha256", secret).update(`${now}.${body}`).digest("hex");
    await expect(computeWebhookSignature(secret, body, now)).resolves.toBe(expected);
  });
});
