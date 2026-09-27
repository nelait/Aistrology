import type { DatasetRecord, Job, StreamAppendResult, StreamCreate, StreamRecord, StreamStatus } from "../types.js";
import { Resource, seg, type CallOptions } from "./base.js";

/** Append-only streaming datasets (ING-008). */
export class StreamsResource extends Resource {
  create(body: StreamCreate, options?: CallOptions): Promise<DatasetRecord> {
    return this.http.request({ method: "POST", path: "/v1/streams", body, ...options });
  }

  /** Buffer and storage status. */
  get(datasetId: string, options?: CallOptions): Promise<StreamStatus> {
    return this.http.request({ method: "GET", path: `/v1/streams/${seg(datasetId)}`, ...options });
  }

  /**
   * Append a micro-batch (up to 10,000 flat records and 10 MB). A 5xx is not retried, because the batch
   * may already have been buffered and a retry would duplicate it.
   */
  send(datasetId: string, records: StreamRecord[], options?: CallOptions): Promise<StreamAppendResult> {
    return this.http.request({ method: "POST", path: `/v1/streams/${seg(datasetId)}/records`, body: { records }, ...options });
  }

  /** Fold the buffer into the next version now; returns the compaction job (or the one in flight). */
  compact(datasetId: string, options?: CallOptions): Promise<Job> {
    return this.http.request({ method: "POST", path: `/v1/streams/${seg(datasetId)}/compact`, ...options });
  }
}
