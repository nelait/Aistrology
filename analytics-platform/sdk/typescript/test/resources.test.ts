import { describe, expect, it } from "vitest";
import { client, json, mockFetch } from "./helpers.js";

describe("endpoints.predict", () => {
  it("posts instances and the explain flag with the API key", async () => {
    const { fetch, calls } = mockFetch([
      json({ predictions: ["yes"], probabilities: [[0.2, 0.8]], classes: ["no", "yes"], model_version: { model_id: "m1", version: 3 } }),
    ]);
    const ap = client(fetch, { apiKey: "ap_live_k" });
    const out = await ap.endpoints.predict<string>("churn model", [{ tenure: 3, plan: "pro" }], { explain: true });

    expect(out.predictions[0]).toBe("yes");
    expect(out.model_version.version).toBe(3);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.test/v1/endpoints/churn%20model/predict");
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers["x-api-key"]).toBe("ap_live_k");
    expect(call.body).toEqual({ instances: [{ tenure: 3, plan: "pro" }], explain: true });
  });

  it("defaults explain to false", async () => {
    const { fetch, calls } = mockFetch([json({ predictions: [1.5], model_version: { model_id: "m", version: 1 } })]);
    await client(fetch).endpoints.predict("price", [{ sqft: 900 }]);
    expect(calls[0]!.body).toEqual({ instances: [{ sqft: 900 }], explain: false });
  });
});

describe("datasets.upload", () => {
  it("sends multipart with the file name and optional checksum", async () => {
    const { fetch, calls } = mockFetch([json({ dataset: { id: "d1" }, inference: null }, 201)]);
    const out = await client(fetch).datasets.upload("a,b\n1,2\n", { filename: "sales.csv", sha256: "abc" });
    expect(out.dataset.id).toBe("d1");
    const call = calls[0]!;
    expect(call.url).toBe("https://api.test/v1/datasets");
    expect(call.method).toBe("POST");
    expect(call.headers["x-content-sha256"]).toBe("abc");
    expect(call.headers["content-type"]).toBeUndefined(); // fetch sets the multipart boundary
    const form = call.init.body as FormData;
    const file = form.get("file") as File;
    expect(file.name).toBe("sales.csv");
    expect(await file.text()).toBe("a,b\n1,2\n");
  });

  it("takes the name from a File and supports Uint8Array streaming uploads", async () => {
    const { fetch, calls } = mockFetch([json({ dataset: { id: "d1" } }, 201), json({ dataset: { id: "d2" } }, 201)]);
    const ap = client(fetch);
    await ap.datasets.upload(new File(["x\n1\n"], "people.csv", { type: "text/csv" }));
    expect(((calls[0]!.init.body as FormData).get("file") as File).name).toBe("people.csv");

    await ap.datasets.upload(new TextEncoder().encode("x\n1\n"), { filename: "raw.csv", method: "stream" });
    expect(calls[1]!.url).toBe("https://api.test/v1/datasets/upload?filename=raw.csv");
    expect(calls[1]!.method).toBe("PUT");
    expect(await (calls[1]!.init.body as Blob).text()).toBe("x\n1\n");
  });

  it("requires a filename", async () => {
    const { fetch } = mockFetch([]);
    await expect(client(fetch).datasets.upload("a,b")).rejects.toThrow(/filename/);
  });
});

describe("request shapes", () => {
  it("serializes query parameters and skips undefined", async () => {
    const { fetch, calls } = mockFetch([json({}), json({}), json({}), json({}), json({ text: "Plain words" })]);
    const ap = client(fetch);
    await ap.datasets.profile("d 1", { version: 2 });
    await ap.datasets.get("d1");
    await ap.experiments.compare(["r1", "r2"]);
    await ap.dashboards.archive("db1", false);
    await expect(ap.experiments.explanationText("r1")).resolves.toBe("Plain words");
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.test/v1/datasets/d%201/profile?version=2",
      "https://api.test/v1/datasets/d1",
      "https://api.test/v1/experiments/compare?run_ids=r1%2Cr2",
      "https://api.test/v1/dashboards/db1/archive?archived=false",
      "https://api.test/v1/runs/r1/explanation-text",
    ]);
  });

  it("wraps pipeline steps and model stages", async () => {
    const { fetch, calls } = mockFetch([json({}), json({}), json({}, 202)]);
    const ap = client(fetch);
    await ap.pipelines.addStep("p1", { op: "fill_missing", columns: ["age"], strategy: "median" });
    await ap.models.setStage("m1", 2, "production");
    await ap.pipelines.apply("p1");
    expect(calls[0]!.body).toEqual({ step: { op: "fill_missing", columns: ["age"], strategy: "median" } });
    expect(calls[1]).toMatchObject({ url: "https://api.test/v1/models/m1/versions/2/stage", body: { stage: "production" } });
    expect(calls[2]).toMatchObject({ url: "https://api.test/v1/pipelines/p1/apply", method: "POST" });
  });

  it("returns batch results as Blob, ArrayBuffer or text", async () => {
    const csv = () => new Response("id,prediction\n1,yes\n", { headers: { "content-type": "text/csv" } });
    const { fetch, calls } = mockFetch([csv(), csv(), csv()]);
    const ap = client(fetch);
    const blob = await ap.endpoints.batchResult("churn", "j1");
    expect(blob).toBeInstanceOf(Blob);
    expect(await blob.text()).toContain("1,yes");
    const buf = await ap.endpoints.batchResult("churn", "j1", { as: "arrayBuffer" });
    expect(buf.byteLength).toBe(20);
    expect(await ap.endpoints.batchResult("churn", "j1", { as: "text" })).toContain("prediction");
    expect(calls[0]!.url).toBe("https://api.test/v1/endpoints/churn/batch/j1");
  });

  it("starts batch jobs from a dataset or a CSV upload", async () => {
    const { fetch, calls } = mockFetch([json({ id: "j1" }, 202), json({ id: "j2" }, 202)]);
    const ap = client(fetch);
    await ap.endpoints.batch("churn", { datasetId: "d1" });
    await ap.endpoints.batch("churn", { file: "a\n1\n" });
    expect(calls[0]!.body).toEqual({ dataset_id: "d1" });
    expect(((calls[1]!.init.body as FormData).get("file") as File).name).toBe("input.csv");
  });

  it("distinguishes the three schemas.generate outcomes", async () => {
    const { fetch } = mockFetch([
      new Response("id\n1\n", { headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="users.csv"' } }),
      json({ id: "d1", name: "gen" }),
      json({ id: "j1", status: "queued" }, 202),
    ]);
    const ap = client(fetch);
    const req = { schema: { entities: [{ name: "users", fields: [{ name: "id", type: "integer" as const }] }] } };
    const file = await ap.schemas.generate(req);
    expect(file.kind).toBe("file");
    if (file.kind === "file") {
      expect(file.filename).toBe("users.csv");
      expect(await file.data.text()).toBe("id\n1\n");
    }
    expect((await ap.schemas.generate({ ...req, save_as: "gen" })).kind).toBe("dataset");
    expect((await ap.schemas.generate(req)).kind).toBe("job");
  });

  it("calls embed endpoints without credentials", async () => {
    const { fetch, calls } = mockFetch([json({ id: "db1" })]);
    await client(fetch, { accessToken: "t" }).dashboards.getEmbedded("tok");
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it("returns undefined for 204 responses", async () => {
    const { fetch } = mockFetch([json(null, 204)]);
    await expect(client(fetch).datasets.delete("d1")).resolves.toBeUndefined();
  });
});
