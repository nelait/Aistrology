"use client";
/**
 * WDG-009 iframe and WDG-010 custom HTML widgets.
 * Custom HTML is only ever rendered as the srcdoc of a sandboxed iframe (sandbox="allow-scripts", no
 * allow-same-origin): it cannot read the app's DOM, cookies, storage or tokens, and its data arrives by
 * postMessage. Nothing from the widget config is injected into the app's own DOM.
 */
import { useEffect, useMemo, useRef } from "react";
import type { Row } from "@/lib/types";
import { API_URL } from "@/lib/api";
import { CUSTOM_HTML_SANDBOX, IFRAME_SANDBOX, WIDGET_MESSAGE_TYPE, configuredAllowlist, customHtmlSrcdoc, validateIframeUrl } from "@/lib/embed";

export function appOrigins(): string[] {
  const out = [API_URL];
  if (typeof window !== "undefined") out.push(window.location.origin);
  return out;
}

export function IframeWidget({ url, title }: { url?: string; title: string }) {
  const check = validateIframeUrl(url ?? "", { blockedOrigins: appOrigins(), allowlist: configuredAllowlist() });
  if (!check.ok) return <p className="text-sm text-[var(--text-2)]">{url ? `Can't embed: ${check.error}` : "Set an https:// URL in the widget settings."}</p>;
  return (
    <iframe
      src={check.url}
      title={title || `Embedded page from ${check.host}`}
      sandbox={IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      loading="lazy"
      allow=""
      className="h-full w-full rounded border-0 bg-white"
    />
  );
}

export function CustomHtmlWidget({ html, title, columns, rows }: { html: string; title: string; columns: string[]; rows: Row[] }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const srcdoc = useMemo(() => customHtmlSrcdoc(html), [html]);
  const payload = useMemo(() => ({ title, columns, rows: rows.slice(0, 5000) }), [title, columns, rows]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    // The sandboxed document has an opaque origin, so "*" is the only possible target origin. Only the
    // widget's own query result is sent.
    const send = () => frame.contentWindow?.postMessage({ type: WIDGET_MESSAGE_TYPE, payload }, "*");
    send();
    const onMessage = (e: MessageEvent) => {
      if (e.source === frame.contentWindow && e.data && (e.data as { type?: string }).type === "ap-widget-ready") send();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [payload, srcdoc]);

  return <iframe ref={ref} srcDoc={srcdoc} sandbox={CUSTOM_HTML_SANDBOX} title={title || "Custom HTML widget"} referrerPolicy="no-referrer" className="h-full w-full rounded border-0" />;
}
