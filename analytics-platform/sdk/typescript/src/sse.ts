/**
 * A small `text/event-stream` parser over a fetch `ReadableStream` (browsers and Node 18+).
 */

export interface ServerSentEvent<TData = unknown> {
  /** Event name (`message` when the server sent none). */
  event: string;
  /** The `data:` payload, JSON-decoded when it is valid JSON. */
  data: TData;
  id?: string;
}

/**
 * Parse Server-Sent Events: `event:`, `id:` and (multi-line) `data:` fields; a blank line dispatches the
 * event; `:` lines are comments. Aborting `signal` cancels the underlying stream.
 */
export async function* parseSSE(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<ServerSentEvent, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => void reader.cancel(signal?.reason).catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  let buffer = "";
  let event = "message";
  let id: string | undefined;
  let data: string[] = [];
  let finished = false;

  const dispatch = (): ServerSentEvent | undefined => {
    if (!data.length) return undefined;
    const raw = data.join("\n");
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* keep the raw string */
    }
    const out: ServerSentEvent = { event, data: parsed };
    if (id !== undefined) out.id = id;
    return out;
  };

  const handleLine = (line: string): ServerSentEvent | undefined => {
    if (line === "") {
      const out = dispatch();
      event = "message";
      data = [];
      return out;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
    return undefined;
  };

  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const { value, done } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
        // A trailing CR may be the first half of a CRLF split across chunks.
        if (buffer[newline] === "\r" && newline === buffer.length - 1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer[newline] === "\r" && buffer[newline + 1] === "\n" ? 2 : 1));
        const out = handleLine(line);
        if (out) yield out;
      }
    }
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    buffer += decoder.decode();
    if (buffer) {
      const out = handleLine(buffer);
      if (out) yield out;
    }
    finished = true;
    const last = dispatch();
    if (last) yield last;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // The consumer stopped early (break / return / throw): close the connection.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
