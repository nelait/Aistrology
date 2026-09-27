# Analytics Platform — web frontend

Next.js (App Router) + TypeScript (strict) + Tailwind CSS client for the Analytics Platform API
(`../backend`, contract in `../docs/API_CONTRACT.md`). All pages are client-rendered behind sign-in.

| Area | What's there |
|------|--------------|
| Auth | Sign-up (creates the organization), sign-in with a TOTP step (`mfa_required`), OIDC SSO buttons + `/auth/callback`, MFA enrollment with a QR code (`/settings/mfa`), sign-out |
| Shell | Role-aware sidebar (RBAC mirrors `backend/app/auth/rbac.py`), notification bell (polls `/v1/notifications`), light/dark toggle, responsive layout, skip link |
| Datasets | Project filter, drag-and-drop multi-file upload with per-file progress/ETA and a 1 GB pre-check, detail tabs: schema review/edit → confirm, profile (quality gauge, column stats, histograms, top values, outliers, correlations), SQL (Monaco with column autocomplete, results grid, CSV/JSON export), AI suggestions (accept/modify/reject, refinement, SQL), versions & lineage |
| Sample data | JSON Schema / XSD / natural-language input, schema review + NL refinement, options, 50-row preview per entity, download or save as dataset (202 → job progress) |
| Pipelines | Step builder with a form for every `op`, preview (before/after stats, column deltas, sample rows), undo/redo (Ctrl+Z / Ctrl+Shift+Z), apply → new version (job), templates |
| Analytics | Visual query builder → SQL, raw SQL mode, 13 chart types, `:parameters`, run & save, saved analytic view with parameter inputs |
| Experiments | Create form (auto-detect problem type, features, split/CV, algorithms with hyperparameter tooltips, AutoML, preprocessing, class imbalance, leakage warning), leaderboard, run charts (confusion matrix, ROC, PR, calibration, residuals, learning curve, importances, SHAP, PDP), LLM explanation, compare, what-if, register model |
| Models & endpoints | Registry + stage transitions (rollback), deploy with A/B routes, metrics (p50/p95/p99, by version), pause/resume, "try it" form from the model signature, batch prediction, curl/Python/JS snippets, OpenAPI |
| Dashboards | List (create from blank/template, clone, archive/restore, delete), react-grid-layout builder, widget palette (chart, KPI, table, text, image, filter, prediction, alert), config drawer, pages, global filters + date range, cross-filtering (click a chart value), auto-refresh, presentation mode, share (user or whole org) + signed embed link, export PNG / PDF (print) / HTML (API) / JSON; off-screen widgets render lazily |
| Jobs | Status/progress table with auto-refresh, details and cancel |
| Admin | Organization (require MFA), users, projects, SSO domains, API keys (shown once, rotate, revoke), LLM provider chain + per-task models + data-minimization L0–L3 + write-only BYOK secrets, usage, audit log (filter, export, verify chain), webhooks, data export and organization deletion |

### Phase 2 features

| Area | What's there |
|------|--------------|
| Sample data | SQL DDL input tab; XML export; per-field distributions (normal / lognormal / custom weights) and anomaly rate; saved schema history (save versions, load one, visual diff of any two versions with added / removed / changed fields and a “breaking” badge) |
| Datasets | Uploads of `.xls`, Avro, ORC, XML and archives (`.zip`, `.tar`, `.tar.gz`, `.gz`) with per-table ingest notes and detected encoding; multi-table datasets (table picker with preview, entity diagram of detected relationships); “add a version” upload (append / replace) with the column diff; Advanced profile (Isolation Forest outliers, near-duplicate pairs, missing-value co-missingness heatmap with the heuristic MCAR/MAR label); column annotations editor; `fuzzy_deduplicate` pipeline step |
| Connectors | `/connectors`: S3 / GCS / PostgreSQL / MySQL connectors with write-only credentials, import by object key / prefix or a single SELECT with a row limit (job progress → dataset), admin allowlist for private hosts |
| Experiments | Clustering (k range; cluster sizes, 2-D PCA scatter, cluster profiles, k-search curve) and forecasting (time column, horizon, frequency, backtest; history + backtest windows + forecast with interval band); ensembles; auto features, PCA, CatBoost; ALE plots; force plot and LIME in the what-if panel; ONNX download (409 reason shown); training templates (save, list, load, apply) |
| Endpoints | Drift tab (per-feature PSI bars with warn/alert thresholds, prediction PSI, “Run drift check” job); forecasting “try it” with horizon and optional history |
| Dashboards | Public links (expiry, copy once, revoke; anonymous viewer at `/public/{token}`); iframe widget (https only, sandboxed, allowlist warning) and custom HTML/JS widget rendered only in a `sandbox="allow-scripts"` `srcdoc` iframe fed by `postMessage` (stored by the API as a `table` widget with `config.custom_html`) |
| Admin | LLM health + circuit breaker, prompt templates (defaults, tenant overrides with provider variants, activate / deactivate), Slack / Teams destinations, OAuth clients (secret shown once, revoke), network policy (CIDR validation, lock-out warning), SCIM token, teams (members, project grants), consent (records, LLM consent requirement), costs (date range, breakdown + chart), public-link switch, incoming webhooks (secret once, curl / Python signing examples, in-browser signature tester) |
| Settings | `/settings`: email notification preferences per event kind, your consents (record / withdraw) |

## Setup

Requirements: Node.js 20+ (22 recommended) and the API running (see `../backend`).

```bash
cd analytics-platform/frontend
cp .env.example .env.local   # optional; defaults to http://localhost:8000
npm install
npm run dev                  # http://localhost:3000
```

The API allows `http://localhost:3000` by default (`AP_CORS_ORIGINS` on the backend). If the API cannot
send CORS headers for your frontend origin, use the built-in proxy instead:

```bash
NEXT_PUBLIC_API_URL=/api API_PROXY_TARGET=http://localhost:8000 npm run dev
```

For SSO, the backend's `AP_OIDC_REDIRECT_URIS` must include `<frontend origin>/auth/callback`.

### Environment

| Variable | Default | When |
|----------|---------|------|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | Build time (inlined into the bundle) |
| `API_PROXY_TARGET` | unset | Build time; enables the `/api/*` → API rewrite |
| `NEXT_PUBLIC_IFRAME_ALLOWLIST` | unset | Comma-separated hosts (`*.example.com` allowed) the iframe widget expects; other hosts get a warning |

## Scripts

```bash
npm run lint        # ESLint (next/core-web-vitals + typescript)
npx tsc --noEmit    # type-check (strict)
npm test            # Vitest + Testing Library
npm run build       # production build (standalone output)
npm start           # serve the production build
```

Tests cover the API client's token refresh (single in-flight refresh for concurrent 401s, rotation by
another tab, session loss), the query-builder SQL generation (quoting, operators, parameters) and the
pipeline step form serialization (every `op`, validation, round-trips, a rendered form), and the Phase 2 helpers: schema diff
rendering, PSI status mapping, CIDR validation, inbound-hook signature examples (checked against Node's HMAC), iframe URL
validation, the sandboxed custom HTML widget, distribution settings, connector forms and cost breakdowns.

## Docker

```bash
docker build -t analytics-frontend --build-arg NEXT_PUBLIC_API_URL=https://api.example.com .
docker run -p 3000:3000 analytics-frontend
```

Multi-stage build (`npm ci` → `next build` → standalone runtime) running as the unprivileged `node` user.

## Implementation notes

- **API client** (`src/lib/api.ts`, types in `src/lib/types.ts`): the access token is kept in memory and the
  refresh token in `localStorage`. On a 401 the client refreshes and retries once. Refresh tokens are single
  use, so concurrent requests share one in-flight refresh; a request that failed with an already-replaced
  token is retried without refreshing again, and if another tab rotated the token first the newer one is used.
  Uploads use `XMLHttpRequest` for progress events.
- **Errors**: every failed query/mutation shows a toast with the backend `detail` (strings, `{code, message}`,
  `{message, issues}` and FastAPI validation lists are all formatted).
- **Charts**: Apache ECharts (tree-shaken build in `src/components/charts/echarts.ts`) for every chart type,
  including treemap, funnel, gauge, Sankey and waterfall. Colors use a CVD-validated categorical palette with a
  separate dark-mode set; every chart has a table view and PNG/SVG/CSV/JSON export.
- **Monaco** is loaded by `@monaco-editor/react` from its default CDN (jsDelivr). For an offline or strict-CSP
  deployment, configure its `loader` to serve `monaco-editor` locally.
- **Dashboard widgets** read data from `POST /v1/dashboards/{id}/widgets/{wid}/data`. Widgets changed since
  the last save are previewed by running the equivalent query on the dataset (filters apply after saving).
- **Accessibility**: labelled controls, visible focus, WAI-ARIA tabs, native `<dialog>` modals (focus trap,
  Esc), live regions for toasts/progress, a table view for charts, and icon + text for statuses.
