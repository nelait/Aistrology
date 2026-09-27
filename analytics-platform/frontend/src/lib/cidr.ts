/** IP / CIDR input validation for the network policy editor (MGT-007). The server re-validates. */

function ipv4Parts(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    if (p.length > 1 && p.startsWith("0")) return null; // ambiguous octal
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

export function isIPv4(s: string): boolean {
  return ipv4Parts(s) !== null;
}

export function isIPv6(s: string): boolean {
  if (!s || s.includes(":::")) return false;
  let addr = s;
  let extra = 0;
  // embedded IPv4 tail (::ffff:1.2.3.4)
  const lastColon = addr.lastIndexOf(":");
  const tail = addr.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!isIPv4(tail)) return false;
    addr = `${addr.slice(0, lastColon + 1)}0`;
    extra = 1;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return false;
  const groups = (h: string) => (h === "" ? [] : h.split(":"));
  const all = halves.flatMap(groups);
  if (!all.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return false;
  const count = all.length + extra;
  return halves.length === 2 ? count <= 7 : count === 8;
}

/** Validate one IP address or CIDR range. Returns an error message, or null when valid. */
export function validateCidr(value: string): string | null {
  const v = value.trim();
  if (!v) return "Empty entry";
  const [ip, prefix, ...rest] = v.split("/");
  if (rest.length) return `“${v}” has more than one “/”`;
  const v4 = isIPv4(ip);
  const v6 = !v4 && isIPv6(ip);
  if (!v4 && !v6) return `“${v}” is not an IP address or CIDR range`;
  if (prefix !== undefined) {
    if (!/^\d{1,3}$/.test(prefix)) return `“${v}” has an invalid prefix length`;
    const max = v4 ? 32 : 128;
    if (Number(prefix) > max) return `“${v}”: prefix length must be 0–${max}`;
  }
  return null;
}

export interface CidrListResult {
  entries: string[];
  errors: { value: string; error: string }[];
}

/** Parse a textarea (one entry per line, or comma separated; # comments allowed). */
export function parseCidrList(text: string): CidrListResult {
  const entries: string[] = [];
  const errors: CidrListResult["errors"] = [];
  for (const raw of text.split(/[\n,]/)) {
    const value = raw.replace(/#.*$/, "").trim();
    if (!value) continue;
    const error = validateCidr(value);
    if (error) errors.push({ value, error });
    else if (!entries.includes(value)) entries.push(value);
  }
  return { entries, errors };
}

function isCatchAll(cidr: string): boolean {
  const [ip, prefix] = cidr.split("/");
  return prefix === "0" && (isIPv4(ip) || isIPv6(ip));
}

/** Warnings shown next to the policy before saving (lock-out risk, catch-all rules). */
export function policyWarnings(policy: { allow: string[]; deny: string[] }): string[] {
  const out: string[] = [];
  if (policy.allow.length)
    out.push(
      "A non-empty allowlist blocks every address that is not listed — for users, API keys, OAuth clients and SCIM. Make sure your current IP (and your team's egress ranges) are included; the server refuses a policy that would lock you out.",
    );
  if (policy.deny.some(isCatchAll)) out.push("The denylist contains a catch-all range (/0). Deny wins over allow, so this blocks everyone in that address family.");
  return out;
}
