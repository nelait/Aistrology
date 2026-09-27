/**
 * Webhook signature verification.
 *
 * Deliveries carry `X-AP-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`.
 * Verify against the raw request body bytes, before any JSON parsing or re-serialization.
 */

export const WEBHOOK_SIGNATURE_HEADER = "X-AP-Signature";
export const WEBHOOK_DELIVERY_HEADER = "X-AP-Delivery";

export type WebhookBody = string | Uint8Array | ArrayBuffer;

export interface VerifyOptions {
  /** Current time in unix seconds (for tests). */
  now?: number;
}

const encoder = new TextEncoder();

async function subtleCrypto(): Promise<SubtleCrypto> {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.subtle) return c.subtle;
  // Node 18 has WebCrypto but does not expose it as a global.
  const specifier = "node:crypto";
  const mod = (await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier)) as { webcrypto?: Crypto };
  if (mod.webcrypto?.subtle) return mod.webcrypto.subtle;
  throw new Error("WebCrypto is not available in this environment");
}

function toBytes(body: WebhookBody): Uint8Array {
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(body);
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Hex HMAC-SHA256 of `${timestamp}.${body}`. */
export async function computeWebhookSignature(secret: string, rawBody: WebhookBody, timestamp: number): Promise<string> {
  const subtle = await subtleCrypto();
  const key = await subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const body = toBytes(rawBody);
  const prefix = encoder.encode(`${timestamp}.`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix, 0);
  message.set(body, prefix.length);
  return toHex(await subtle.sign("HMAC", key, message));
}

/** Parse `t=<unix>,v1=<hex>[,v1=<hex>...]`. */
export function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } | null {
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) return null;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t") {
      if (!/^\d+$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === "v1") {
      signatures.push(value.toLowerCase());
    }
  }
  if (timestamp === undefined || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/**
 * Verify an `X-AP-Signature` header. Resolves `false` for a missing/malformed header, a bad
 * signature, or a timestamp more than `toleranceSeconds` away from now (replay protection).
 */
export async function verifyWebhookSignature(
  secret: string,
  rawBody: WebhookBody,
  header: string | null | undefined,
  toleranceSeconds = 300,
  options: VerifyOptions = {},
): Promise<boolean> {
  if (!secret || !header) return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > toleranceSeconds) return false;
  const expected = await computeWebhookSignature(secret, rawBody, parsed.timestamp);
  return parsed.signatures.some((sig) => timingSafeEqual(sig, expected));
}
