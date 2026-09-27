import type { CallOptions, HttpClient } from "../http.js";

export abstract class Resource {
  constructor(protected readonly http: HttpClient) {}
}

/** Encode one path segment. */
export const seg = (value: string | number): string => encodeURIComponent(String(value));

/** Per-call options without the request-shaping fields. */
export type { CallOptions };

/** Accepted upload inputs. */
export type UploadInput = Blob | ArrayBuffer | ArrayBufferView | string;

/** Turn any supported upload input into a Blob (re-sendable, so uploads can be retried). */
export function toBlob(data: UploadInput, contentType?: string): Blob {
  const type = contentType ?? (data instanceof Blob ? data.type : "application/octet-stream");
  if (data instanceof Blob) return contentType && data.type !== contentType ? new Blob([data], { type }) : data;
  if (typeof data === "string") return new Blob([data], { type: contentType ?? "text/plain;charset=utf-8" });
  if (data instanceof ArrayBuffer) return new Blob([data], { type });
  // Copy views into a fresh ArrayBuffer-backed Uint8Array (also handles SharedArrayBuffer views).
  const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Blob([new Uint8Array(view)], { type });
}

/** File name from a `File`-like input, if it has one. */
export function nameOf(data: UploadInput): string | undefined {
  const name = (data as { name?: unknown }).name;
  return typeof name === "string" && name ? name : undefined;
}

/** Parse the filename from a Content-Disposition header. */
export function filenameFrom(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain?.[1];
}
