# Feature Flags

Admin-controlled switches that turn whole features on or off across the app —
hidden in the UI **and** blocked at the API (defense in depth).

## The flags

| Key | Controls |
| --- | -------- |
| `consultation` | The [Consultations](consultations.md) page and its API. |
| `temples` | The Temple Portal + the Pooja Services directory. |
| `vastu` | The [Vastu](vastu.md) tab and its analysis endpoints. |
| `reminders` | The [Reminders](reminders.md) page and its API. |
| `chat` | The [Astro Chat](astro-chat.md) launcher and `/api/llm/chat/stream` + `/api/chat/*`. |

All default to **enabled**. Managed under **Admin console → Features** (toggle
switches). `server/features.ts`, `src/components/AdminView.tsx`.

## How it works

- **Storage:** a single row in `global_settings` under key `features` (a
  `{ key: boolean }` map). A missing key is treated as enabled.
- **Read by the app:** the flags ride along in `GET /auth/me` as `features`, and
  are exposed through the auth context (`useAuth().features`).
- **UI enforcement:** `src/App.tsx` hides the relevant header buttons, tabs, home
  sections, and pages when a flag is off; if the active tab gets disabled it
  falls back to the chart tab.
- **API enforcement:** `requireFeature("<key>")` middleware guards the feature's
  routers/routes and returns **403** `{ error, featureDisabled }` when off.
- **Live update:** toggling in admin calls the auth `refresh()`, so the change is
  reflected in the running app without a reload.

## Endpoints

- `GET /api/admin/features` → `{ features, meta }` (meta = label + description per key).
- `PUT /api/admin/features` → set a partial `{ key: boolean }` patch.

## Adding a new flag

1. Add the key to `FEATURE_KEYS` and `FEATURE_META` in `server/features.ts`.
2. Guard its routes with `requireFeature("<key>")`.
3. In `src/App.tsx`, gate the corresponding header button / tab / page on
   `features.<key>`.
