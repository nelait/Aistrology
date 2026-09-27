/**
 * Examples and helpers for signed inbound webhooks (WHK-002). The scheme matches outgoing webhooks:
 * `X-AP-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`, rejected after 5 minutes.
 */

export const SIGNATURE_HEADER = "X-AP-Signature";

/** Quote a string for POSIX shells: 'it'\''s'. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The signed payload: `${timestamp}.${body}`. */
export function signedPayload(timestamp: number | string, body: string): string {
  return `${timestamp}.${body}`;
}

export function signatureHeaderValue(timestamp: number | string, hexDigest: string): string {
  return `t=${timestamp},v1=${hexDigest}`;
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** HMAC-SHA256 hex digest of `t.body` (Web Crypto; used for the in-page "sign a test body" helper). */
export async function computeSignature(secret: string, timestamp: number | string, body: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is not available in this browser");
  const enc = new TextEncoder();
  const key = await subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await subtle.sign("HMAC", key, enc.encode(signedPayload(timestamp, body))));
}

export interface ExampleInput {
  /** Absolute URL of the hook, e.g. https://api.example.com/hooks/in/acme/abc123 */
  url: string;
  /** Request body to send */
  body: string;
  contentType?: "application/json" | "text/csv";
  /** Name of the environment variable holding the secret (never inline the real secret) */
  secretEnv?: string;
}

/** A copy-paste curl example that signs the body with openssl. */
export function curlExample({ url, body, contentType = "application/json", secretEnv = "AP_HOOK_SECRET" }: ExampleInput): string {
  return [
    `# ${secretEnv} holds the signing secret shown once when the hook was created`,
    `BODY=${shellQuote(body)}`,
    `TS=$(date +%s)`,
    `SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$${secretEnv}" -hex | sed 's/^.* //')`,
    `curl -X POST ${shellQuote(url)} \\`,
    `  -H ${shellQuote(`Content-Type: ${contentType}`)} \\`,
    `  -H "${SIGNATURE_HEADER}: t=$TS,v1=$SIG" \\`,
    `  --data-binary "$BODY"`,
  ].join("\n");
}

/** The same request in Python (requests + hmac). */
export function pythonExample({ url, body, contentType = "application/json", secretEnv = "AP_HOOK_SECRET" }: ExampleInput): string {
  return [
    "import hashlib, hmac, os, time",
    "import requests",
    "",
    `secret = os.environ[${JSON.stringify(secretEnv)}].encode()`,
    `body = ${JSON.stringify(body)}.encode()`,
    "ts = str(int(time.time()))",
    'sig = hmac.new(secret, ts.encode() + b"." + body, hashlib.sha256).hexdigest()',
    "resp = requests.post(",
    `    ${JSON.stringify(url)},`,
    "    data=body,",
    `    headers={"Content-Type": ${JSON.stringify(contentType)}, ${JSON.stringify(SIGNATURE_HEADER)}: f"t={ts},v1={sig}"},`,
    ")",
    "print(resp.status_code, resp.json())  # 202 with the job",
  ].join("\n");
}
