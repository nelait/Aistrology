"use client";
/** API-006 streaming inference: Server-Sent Events "try it" and a WebSocket console. */
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type SignatureField } from "@/lib/api";
import { formatNumber, formatPercent } from "@/lib/format";
import { formatPrediction } from "@/lib/predictions";
import { eventJson, readSse, type SseEvent } from "@/lib/sse";
import { Badge, Button, Card, ProgressBar, TextArea, TextField, cx } from "../ui";

function exampleInstance(fields: SignatureField[]): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((f) => [f.name, f.categories?.length ? f.categories[0] : /(int|float|number|double)/i.test(f.type) ? (typeof f.min === "number" ? f.min : 0) : /bool/i.test(f.type) ? false : "value"]),
  );
}

interface Received {
  at: number;
  event: string;
  data: unknown;
}

export function SseTry({ name, fields, forecasting }: { name: string; fields: SignatureField[]; forecasting: boolean }) {
  const [instances, setInstances] = useState(() => JSON.stringify(Array.from({ length: 5 }, () => exampleInstance(fields)), null, 2));
  const [chunk, setChunk] = useState("1");
  const [horizon, setHorizon] = useState("12");
  const [events, setEvents] = useState<Received[]>([]);
  const [status, setStatus] = useState<"idle" | "streaming" | "done" | "error" | "cancelled">("idle");
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const start = async () => {
    let body: Parameters<typeof api.endpoints.predictStream>[1];
    try {
      if (forecasting) body = { horizon: Math.max(1, Number(horizon) || 12) };
      else {
        const parsed = JSON.parse(instances) as unknown;
        const list = Array.isArray(parsed) ? parsed : [parsed];
        if (!list.length) throw new Error("Add at least one instance");
        body = { instances: list as Record<string, unknown>[], chunk_size: Math.min(1000, Math.max(1, Number(chunk) || 1)) };
      }
    } catch (e) {
      setError(e instanceof Error ? `Invalid instances: ${e.message}` : "Invalid JSON");
      setStatus("error");
      return;
    }
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setEvents([]);
    setError(null);
    setStatus("streaming");
    const t0 = performance.now();
    try {
      const res = await api.endpoints.predictStream(name, body, ctrl.signal);
      let failed = false;
      await readSse(
        res,
        (e: SseEvent) => {
          const data = eventJson(e);
          if (e.event === "error") {
            failed = true;
            const d = data as { status?: number; detail?: string };
            setError(`${d.status ?? ""} ${d.detail ?? JSON.stringify(data)}`.trim());
          }
          setEvents((xs) => [...xs, { at: performance.now() - t0, event: e.event, data }]);
        },
        ctrl.signal,
      );
      setStatus(ctrl.signal.aborted ? "cancelled" : failed ? "error" : "done");
    } catch (e) {
      if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) setStatus("cancelled");
      else {
        setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    }
  };

  const startEvt = events.find((e) => e.event === "start")?.data as { total?: number; horizon?: number } | undefined;
  const total = startEvt?.total ?? startEvt?.horizon ?? 0;
  const received = events.reduce((n, e) => n + (e.event === "prediction" ? ((e.data as { count?: number }).count ?? 0) : e.event === "forecast" ? 1 : 0), 0);

  return (
    <Card title="Streaming predictions (Server-Sent Events)">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        {forecasting ? (
          <TextField label="Horizon (steps)" type="number" min={1} max={1000} value={horizon} onChange={(e) => setHorizon(e.target.value)} className="max-w-xs" />
        ) : (
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_12rem]">
            <TextArea label="Instances (JSON array, up to 10,000)" mono rows={8} value={instances} onChange={(e) => setInstances(e.target.value)} spellCheck={false} />
            <TextField label="Chunk size" type="number" min={1} max={1000} value={chunk} onChange={(e) => setChunk(e.target.value)} hint="Instances per event; each chunk after the first counts against your rate limit" />
          </div>
        )}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={status === "streaming"}>
            Stream
          </Button>
          {status === "streaming" && <Button onClick={() => abort.current?.abort()}>Stop</Button>}
        </div>
      </form>
      {status !== "idle" && (
        <div className="mt-4 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
            <Badge tone={status === "done" ? "good" : status === "error" ? "critical" : status === "cancelled" ? "warning" : "info"}>{status}</Badge>
            {total > 0 && (
              <span>
                {received} / {total} {forecasting ? "steps" : "predictions"}
              </span>
            )}
          </div>
          {total > 0 && <ProgressBar value={received / total} label="Streaming progress" />}
          {error && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              {error}
            </p>
          )}
          <ol className="max-h-96 space-y-1 overflow-auto rounded-md border border-[var(--border)] p-2 font-mono text-xs" aria-label="Received events">
            {events.map((e, i) => (
              <li key={i} className="flex gap-2">
                <span className="w-16 shrink-0 text-right text-[var(--text-2)]">{formatNumber(e.at / 1000, 3)} s</span>
                <span className={cx("w-20 shrink-0 font-semibold", e.event === "error" && "text-red-700 dark:text-red-400")}>{e.event}</span>
                <span className="min-w-0 break-all">{describeEvent(e)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Card>
  );
}

function describeEvent(e: Received): string {
  const d = e.data as Record<string, unknown>;
  if (e.event === "prediction" && Array.isArray(d.predictions)) {
    const probs = Array.isArray(d.probabilities) ? (d.probabilities as number[][]) : null;
    return (d.predictions as unknown[])
      .map((p, i) => {
        const row = probs?.[i];
        const top = row ? Math.max(...row) : null;
        return `#${Number(d.offset ?? 0) + i}: ${formatPrediction(p)}${top !== null ? ` (${formatPercent(top, 0)})` : ""}`;
      })
      .join(" · ");
  }
  if (e.event === "forecast") return `step ${String(d.step)} ${String(d.timestamp ?? "")}: ${formatNumber(d.prediction)} [${formatNumber(d.lower)} – ${formatNumber(d.upper)}]`;
  return typeof e.data === "string" ? e.data : JSON.stringify(e.data);
}

const CLOSE_REASONS: Record<number, string> = {
  1000: "closed normally",
  1006: "connection lost",
  1009: "message larger than 1 MB",
  4401: "authentication failed",
  4403: "missing permission or blocked by IP policy",
  4404: "endpoint not found",
  4429: "too many concurrent streams",
};

interface LogLine {
  dir: "in" | "out" | "sys";
  text: string;
  at: Date;
}

export function WsConsole({ name, fields, forecasting }: { name: string; fields: SignatureField[]; forecasting: boolean }) {
  const ws = useRef<WebSocket | null>(null);
  const nextId = useRef(1);
  const [state, setState] = useState<"closed" | "connecting" | "open">("closed");
  const [log, setLog] = useState<LogLine[]>([]);
  const [message, setMessage] = useState(() => JSON.stringify(forecasting ? { horizon: 6 } : { instances: [exampleInstance(fields)] }, null, 2));
  const [msgError, setMsgError] = useState<string | null>(null);
  const push = (l: Omit<LogLine, "at">) => setLog((xs) => [...xs.slice(-199), { ...l, at: new Date() }]);
  useEffect(() => () => ws.current?.close(1000), []);

  const connect = async () => {
    setState("connecting");
    try {
      const tok = await api.endpoints.streamToken(name);
      push({ dir: "sys", text: `single-use token issued (valid ${tok.expires_in} s); connecting…` });
      const sock = new WebSocket(api.endpoints.wsUrl(tok.url));
      ws.current = sock;
      sock.onmessage = (ev) => {
        let text = String(ev.data);
        try {
          const d = JSON.parse(text) as { type?: string; predictions?: unknown[] };
          if (d.type === "ready") setState("open");
          if (Array.isArray(d.predictions)) text += `\n→ ${d.predictions.map(formatPrediction).join(", ")}`;
        } catch {
          /* not JSON */
        }
        push({ dir: "in", text });
      };
      sock.onclose = (ev) => {
        setState("closed");
        push({ dir: "sys", text: `closed (${ev.code}${CLOSE_REASONS[ev.code] ? `: ${CLOSE_REASONS[ev.code]}` : ""}${ev.reason ? ` — ${ev.reason}` : ""})` });
        ws.current = null;
      };
      sock.onerror = () => push({ dir: "sys", text: "connection error" });
    } catch (e) {
      setState("closed");
      push({ dir: "sys", text: `could not connect: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const send = () => {
    try {
      const parsed = JSON.parse(message) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Send a JSON object");
      const body = { id: parsed.id ?? nextId.current++, ...parsed };
      setMsgError(null);
      const text = JSON.stringify(body);
      ws.current?.send(text);
      push({ dir: "out", text });
    } catch (e) {
      setMsgError(e instanceof Error ? e.message : "Invalid JSON");
    }
  };

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          WebSocket console <Badge tone={state === "open" ? "good" : state === "connecting" ? "info" : "neutral"}>{state === "open" ? "ready" : state}</Badge>
        </span>
      }
      actions={
        state === "closed" ? (
          <Button size="sm" variant="primary" onClick={() => void connect()}>
            Connect
          </Button>
        ) : (
          <Button size="sm" onClick={() => ws.current?.close(1000)}>
            Disconnect
          </Button>
        )
      }
    >
      <p className="mb-3 text-xs text-[var(--text-2)]">
        Connects to <code>/v1/endpoints/{name}/ws</code> with a single-use token from <code>POST /stream-token</code>. From a server, authenticate with a first message{" "}
        <code>{'{"type": "auth", "api_key": "…"}'}</code>. Every message counts against your rate limit.
      </p>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <TextArea label="Message (an id is added when missing)" mono rows={5} value={message} onChange={(e) => setMessage(e.target.value)} error={msgError} spellCheck={false} />
        <Button type="submit" disabled={state !== "open"}>
          Send
        </Button>
      </form>
      <ol className="mt-3 max-h-80 space-y-1 overflow-auto rounded-md border border-[var(--border)] p-2 font-mono text-xs" aria-label="WebSocket messages" aria-live="polite">
        {log.length === 0 && <li className="text-[var(--text-2)]">No messages yet.</li>}
        {log.map((l, i) => (
          <li key={i} className={cx("whitespace-pre-wrap break-all", l.dir === "sys" && "text-[var(--text-2)]", l.dir === "out" && "text-brand-700 dark:text-brand-300")}>
            <span aria-hidden="true">{l.dir === "in" ? "← " : l.dir === "out" ? "→ " : "· "}</span>
            <span className="sr-only">{l.dir === "in" ? "received" : l.dir === "out" ? "sent" : "status"}: </span>
            {l.text}
          </li>
        ))}
      </ol>
    </Card>
  );
}
