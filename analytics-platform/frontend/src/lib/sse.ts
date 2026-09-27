/**
 * Minimal Server-Sent Events parser for `fetch` streams (EventSource can't POST or send headers).
 * Follows the WHATWG rules that matter here: `event:` / `data:` / `id:` fields, multi-line data joined with
 * "\n", comments (`:`), CRLF / CR / LF line endings, and dispatch on a blank line.
 */

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export interface SseParser {
  /** Feed a decoded text chunk; complete events are passed to the callback. */
  push(chunk: string): void;
  /** Dispatch a trailing event that wasn't followed by a blank line (end of stream). */
  flush(): void;
}

export function createSseParser(onEvent: (e: SseEvent) => void): SseParser {
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let id: string | undefined;
  let pendingCR = false;

  const dispatch = () => {
    if (data.length) onEvent({ event: event || "message", data: data.join("\n"), ...(id !== undefined ? { id } : {}) });
    event = "";
    data = [];
  };

  const line = (l: string) => {
    if (l === "") return dispatch();
    if (l.startsWith(":")) return;
    const i = l.indexOf(":");
    const name = i === -1 ? l : l.slice(0, i);
    let value = i === -1 ? "" : l.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (name === "event") event = value;
    else if (name === "data") data.push(value);
    else if (name === "id") id = value;
    // "retry" and unknown fields are ignored
  };

  return {
    push(chunk: string) {
      let text = chunk;
      // a CR at the end of the previous chunk may be the first half of a CRLF
      if (pendingCR && text.startsWith("\n")) text = text.slice(1);
      pendingCR = false;
      buffer += text;
      for (;;) {
        const m = /\r\n|\r|\n/.exec(buffer);
        if (!m) break;
        if (m[0] === "\r" && m.index === buffer.length - 1) {
          pendingCR = true;
        }
        line(buffer.slice(0, m.index));
        buffer = buffer.slice(m.index + m[0].length);
      }
    },
    flush() {
      if (buffer) {
        line(buffer);
        buffer = "";
      }
      dispatch();
    },
  };
}

/** Parse a whole SSE document (tests, small bodies). */
export function parseSse(text: string): SseEvent[] {
  const out: SseEvent[] = [];
  const p = createSseParser((e) => out.push(e));
  p.push(text);
  p.flush();
  return out;
}

/** JSON payload of an event, or the raw string when it isn't JSON. */
export function eventJson(e: SseEvent): unknown {
  try {
    return JSON.parse(e.data);
  } catch {
    return e.data;
  }
}

/** Read an SSE response body to the end, calling `onEvent` as events arrive. */
export async function readSse(res: Response, onEvent: (e: SseEvent) => void, signal?: AbortSignal): Promise<void> {
  if (!res.body) {
    parseSse(await res.text()).forEach(onEvent);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser(onEvent);
  const onAbort = () => reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.flush();
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
