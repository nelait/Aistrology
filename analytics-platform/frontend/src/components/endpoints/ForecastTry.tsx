"use client";
/** "Try it" for forecasting endpoints: horizon plus optional recent history (the model is refit with it). */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { EChart } from "../charts/EChart";
import { forecastOption } from "../experiments/ProblemCharts";
import { Badge, Button, Card, CodeBlock, TextArea, TextField } from "../ui";

export function ForecastTry({ name, signature }: { name: string; signature: Record<string, unknown> | null }) {
  const { dark } = useTheme();
  const trained = typeof signature?.horizon === "number" ? signature.horizon : 12;
  const timeCol = typeof signature?.time_column === "string" ? signature.time_column : "timestamp";
  const target = typeof signature?.target === "string" ? signature.target : "value";
  const [horizon, setHorizon] = useState(String(trained));
  const [history, setHistory] = useState("");
  const [historyError, setHistoryError] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => {
      let parsed: Record<string, unknown>[] | undefined;
      if (history.trim()) {
        const v = JSON.parse(history) as unknown;
        if (!Array.isArray(v)) throw new Error("History must be a JSON array of observations");
        parsed = v as Record<string, unknown>[];
      }
      return api.endpoints.forecast(name, { horizon: horizon ? Number(horizon) : undefined, history: parsed });
    },
    meta: { errorPrefix: "Forecast failed" },
  });
  const r = run.data;
  const h = Number(horizon);
  const hError = horizon && (!Number.isInteger(h) || h < 1 || h > 1000) ? "Horizon must be a whole number between 1 and 1000" : null;
  return (
    <Card title="Try a forecast">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (history.trim()) {
            try {
              JSON.parse(history);
              setHistoryError(null);
            } catch {
              setHistoryError("Not valid JSON");
              return;
            }
          }
          run.mutate();
        }}
      >
        <TextField className="max-w-xs" label="Horizon (periods)" type="number" min={1} max={1000} value={horizon} onChange={(e) => setHorizon(e.target.value)} hint={`Default: the trained horizon (${trained})`} error={hError} />
        <TextArea
          label="Recent history (optional JSON)"
          mono
          rows={5}
          value={history}
          onChange={(e) => setHistory(e.target.value)}
          error={historyError}
          placeholder={JSON.stringify([{ [timeCol]: "2025-01-01", [target]: 120 }, { [timeCol]: "2025-01-02", [target]: 131 }])}
          hint={`Observations as [{"${timeCol}": …, "${target}": …}]. When given, the model is refit with them before forecasting.`}
        />
        <Button type="submit" variant="primary" loading={run.isPending} disabled={!!hError}>
          Forecast
        </Button>
      </form>
      {r && (
        <div className="mt-4 space-y-2" aria-live="polite">
          <p className="text-sm">
            {r.horizon} periods <Badge>model v{typeof r.model_version === "object" ? r.model_version.version : String(r.model_version)}</Badge>
            {r.interval_level ? <span className="ml-2 text-xs text-[var(--text-2)]">{Math.round(r.interval_level * 100)}% prediction interval</span> : null}
          </p>
          <EChart
            height={320}
            ariaLabel="Forecast with prediction interval"
            option={forecastOption({ dark, forecast: { timestamps: r.timestamps, forecast: r.predictions, lower: r.lower, upper: r.upper }, intervalLabel: r.interval_level ? `${Math.round(r.interval_level * 100)}% interval` : "interval" })}
          />
          <details>
            <summary className="cursor-pointer text-sm">Raw response</summary>
            <CodeBlock code={JSON.stringify(r, null, 2)} />
          </details>
        </div>
      )}
    </Card>
  );
}
