/**
 * Embedded content widgets (WDG-009 iframe, WDG-010 custom HTML/JS).
 *
 * Custom HTML is NEVER inserted into the app DOM: it is rendered only as the `srcdoc` of an iframe with
 * `sandbox="allow-scripts"` (no `allow-same-origin`), so it runs in an opaque origin without access to the
 * app's cookies, storage, tokens or DOM. Its data arrives via postMessage.
 */

/** Sandbox for third-party iframes: scripts run in the embedded site's own origin, no top navigation. */
export const IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-forms";
/** Sandbox for custom HTML: scripts only, opaque origin. Never add allow-same-origin here. */
export const CUSTOM_HTML_SANDBOX = "allow-scripts";
export const WIDGET_MESSAGE_TYPE = "ap-widget-data";

export type UrlCheck = { ok: true; url: string; host: string; warning?: string } | { ok: false; error: string };

/** Hosts (exact or `*.suffix`) from NEXT_PUBLIC_IFRAME_ALLOWLIST, comma separated. Empty = not configured. */
export function configuredAllowlist(raw = process.env.NEXT_PUBLIC_IFRAME_ALLOWLIST ?? ""): string[] {
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function hostAllowed(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase();
  return allowlist.some((entry) => (entry.startsWith("*.") ? h.endsWith(entry.slice(1)) && h.length > entry.length - 1 : h === entry));
}

/**
 * Validate an iframe widget URL: https only, no credentials, and not one of the app's own origins (a
 * same-origin page with allow-scripts + allow-same-origin could escape the sandbox).
 */
export function validateIframeUrl(raw: string, opts: { blockedOrigins?: string[]; allowlist?: string[] } = {}): UrlCheck {
  const value = raw.trim();
  if (!value) return { ok: false, error: "Enter a URL" };
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return { ok: false, error: "Not a valid URL" };
  }
  if (u.protocol !== "https:") return { ok: false, error: "Only https:// URLs can be embedded" };
  if (u.username || u.password) return { ok: false, error: "URLs with embedded credentials are not allowed" };
  if (!u.hostname) return { ok: false, error: "The URL has no host" };
  const blocked = (opts.blockedOrigins ?? []).map((o) => {
    try {
      return new URL(o).origin;
    } catch {
      return o;
    }
  });
  if (blocked.includes(u.origin)) return { ok: false, error: "The app's own origin cannot be embedded" };
  const allowlist = opts.allowlist ?? [];
  const warning =
    allowlist.length && !hostAllowed(u.hostname, allowlist)
      ? `${u.hostname} is not on the organization's allowlisted domains (${allowlist.join(", ")}); the browser may refuse to load it.`
      : undefined;
  return { ok: true, url: u.toString(), host: u.hostname, warning };
}

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

/**
 * Build the srcdoc for a custom HTML widget. A strict CSP blocks all network access (no exfiltration of
 * the widget data), and a small bootstrap receives the data:
 *   window.addEventListener("ap:data", (e) => render(e.detail))   // e.detail = {columns, rows, title}
 *   or define window.onWidgetData = (data) => …
 */
export function customHtmlSrcdoc(html: string): string {
  const bootstrap = `<script>(function(){var last=null;window.apData=function(){return last};window.addEventListener("message",function(e){if(e.source!==parent)return;var d=e.data;if(!d||d.type!=="${WIDGET_MESSAGE_TYPE}")return;last=d.payload;try{if(typeof window.onWidgetData==="function")window.onWidgetData(last)}catch(err){console.error(err)}window.dispatchEvent(new CustomEvent("ap:data",{detail:last}))});parent.postMessage({type:"ap-widget-ready"},"*")})();</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;font:13px system-ui,sans-serif;color:#1a1a19;background:transparent}</style>${bootstrap}</head><body>${html}</body></html>`;
}

export const CUSTOM_HTML_EXAMPLE = `<div id="out">Waiting for data…</div>
<script>
  window.onWidgetData = function (data) {
    var total = data.rows.length;
    document.getElementById("out").textContent = total + " rows · columns: " + data.columns.join(", ");
  };
</script>`;
