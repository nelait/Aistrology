"use client";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, API_URL } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { RequirePermission } from "@/components/RequirePermission";
import { Badge, Button, Card, CodeBlock, PageHeader, SelectField, TextArea } from "@/components/ui";

const EXAMPLES: { id: string; label: string; query: string; variables: string }[] = [
  {
    id: "overview",
    label: "Datasets, endpoints and dashboards",
    query: `query Overview($limit: Int) {
  datasets(limit: $limit) {
    id
    name
    version
    rowCount
    columns
  }
  endpoints {
    name
    status
    routes
  }
  dashboards(archived: false) {
    id
    name
    yourRole
  }
}`,
    variables: '{\n  "limit": 5\n}',
  },
  {
    id: "experiments",
    label: "Experiments with their runs",
    query: `query Experiments($datasetId: String) {
  experiments(datasetId: $datasetId, limit: 10) {
    id
    name
    config
    runs {
      id
      algorithm
      status
      metrics
      isBest
    }
  }
}`,
    variables: "{}",
  },
  {
    id: "models",
    label: "Models and versions",
    query: `{
  models {
    id
    name
    versions {
      version
      stage
      algorithm
      metrics
    }
  }
}`,
    variables: "{}",
  },
  {
    id: "predict",
    label: "Predict (mutation)",
    query: `mutation Predict($endpoint: String!, $instances: [JSON!]) {
  predict(endpoint: $endpoint, instances: $instances)
}`,
    variables: '{\n  "endpoint": "my-endpoint",\n  "instances": [{"feature": 1}]\n}',
  },
];

export default function ApiExplorerPage() {
  return (
    <RequirePermission perm="view">
      <ApiExplorer />
    </RequirePermission>
  );
}

function ApiExplorer() {
  const { can } = useAuth();
  const [example, setExample] = useState(EXAMPLES[0].id);
  const [query, setQuery] = useState(EXAMPLES[0].query);
  const [variables, setVariables] = useState(EXAMPLES[0].variables);
  const [varError, setVarError] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => {
      let vars: Record<string, unknown> | undefined;
      if (variables.trim()) {
        const parsed = JSON.parse(variables) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Variables must be a JSON object");
        vars = parsed as Record<string, unknown>;
      }
      return api.graphql(query, vars);
    },
    meta: { errorPrefix: "GraphQL request failed" },
  });
  const submit = () => {
    try {
      if (variables.trim()) JSON.parse(variables);
      setVarError(null);
      run.mutate();
    } catch (e) {
      setVarError(e instanceof Error ? e.message : "Invalid JSON");
    }
  };
  const errors = run.data?.errors ?? [];
  const curl = `curl -X POST '${API_URL}/graphql' \\\n  -H 'X-API-Key: ap_live_…' \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify({ query: query.replace(/\s+/g, " ").trim() }).replace(/'/g, "'\\''")}'`;

  return (
    <div className="space-y-5">
      <PageHeader
        title="API explorer"
        description="Run GraphQL queries against POST /graphql with your session. Each field checks the same permission as the REST API, and results are limited to what you can see."
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card
          title="Request"
          actions={
            <SelectField
              label="Example"
              srOnlyLabel
              value={example}
              onChange={(e) => {
                const ex = EXAMPLES.find((x) => x.id === e.target.value)!;
                setExample(ex.id);
                setQuery(ex.query);
                setVariables(ex.variables);
              }}
              options={EXAMPLES.map((x) => ({ value: x.id, label: x.label }))}
            />
          }
        >
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <TextArea
              label="Query"
              mono
              rows={16}
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
              hint="Ctrl/⌘ + Enter runs the query. Field names are camelCase; JSON-valued fields (metrics, params, config, routes, signature, spec) use the JSON scalar."
            />
            <TextArea label="Variables (JSON)" mono rows={5} spellCheck={false} value={variables} onChange={(e) => setVariables(e.target.value)} error={varError} />
            {example === "predict" && !can("endpoints.predict") && <p className="text-xs text-amber-800 dark:text-amber-300">Your role lacks endpoints.predict; the mutation will return an error.</p>}
            <Button type="submit" variant="primary" loading={run.isPending} disabled={!query.trim()}>
              Run query
            </Button>
          </form>
        </Card>
        <Card title={<span className="flex items-center gap-2">Response {run.data && (errors.length ? <Badge tone="critical">{errors.length} error(s)</Badge> : <Badge tone="good">ok</Badge>)}</span>}>
          <div aria-live="polite">
            {run.data ? (
              <div className="space-y-3">
                {errors.length > 0 && (
                  <ul role="alert" className="space-y-1 rounded-md bg-red-50 p-3 text-sm text-red-900 dark:bg-red-950 dark:text-red-100">
                    {errors.map((e, i) => (
                      <li key={i}>
                        {e.message}
                        {e.path?.length ? <span className="text-xs"> (at {e.path.join(".")})</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
                <CodeBlock code={JSON.stringify(run.data.data ?? null, null, 2)} label="GraphQL response data" />
              </div>
            ) : run.isError ? (
              <p role="alert" className="text-sm text-red-700 dark:text-red-400">
                {run.error instanceof Error ? run.error.message : String(run.error)}
              </p>
            ) : (
              <p className="text-sm text-[var(--text-2)]">Run a query to see the response.</p>
            )}
          </div>
        </Card>
      </div>
      <Card title="From your code">
        <CodeBlock code={curl} label="curl example" />
        <p className="mt-2 text-xs text-[var(--text-2)]">Authentication, rate limits and IP policy are the same as the REST API. GraphiQL is served on GET /graphql in development mode only.</p>
      </Card>
    </div>
  );
}
