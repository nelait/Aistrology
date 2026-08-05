# Notes

Private, per-profile notes for **Pro and Premium** users — handy for Premium
users juggling many profiles (consultation prep, observations, follow-ups).

## Who can use it

- **Pro & Premium only.** Free users don't see the **Notes** tab, and the API
  returns `403` for a free plan (defense in depth).
- Gated by the `notes` [feature flag](feature-flags.md) (default on) — an admin
  can turn the whole feature off under **Admin → Features**.

## How it works

- Notes **attach to a saved profile** (a saved chart). Open a profile (or save the
  current chart from the **profile switcher**), then the **Notes** tab lists that
  profile's notes. Switching profiles switches the notes.
- If the loaded chart isn't saved yet, the tab prompts you to save it first —
  notes need a profile to attach to.
- Each note has an optional **title** and a **body**. Add, edit inline, and delete;
  the list is ordered by most-recently-updated.
- Notes are **private to the owner** — scoped by user id in SQL, so no one else
  (not even another Pro user) can read or change them.

## Limits

- Up to **200 notes per profile**; title ≤ 200 chars, body ≤ 20 000 chars.
- Deleting a profile deletes its notes (cascade).

## API

All routes require auth, the `notes` feature flag, and a Pro/Premium plan.

| Method & path | Purpose |
| ------------- | ------- |
| `GET /api/notes?chartId=…` | List notes for an owned profile. |
| `POST /api/notes` `{ chartId, title, body }` | Create a note. |
| `PUT /api/notes/:id` `{ title, body }` | Update an owned note. |
| `DELETE /api/notes/:id` | Delete an owned note. |

Ownership is enforced in SQL (`WHERE user_id = $me`); another user's id returns
`404`.

## Files

- [`server/notes.ts`](../server/notes.ts) — router, plan gate, validation.
- [`server/db.ts`](../server/db.ts) — `notes` table + `listNotes` / `createNote` /
  `updateNote` / `deleteNote`.
- [`server/features.ts`](../server/features.ts) — the `notes` flag.
- [`src/components/NotesView.tsx`](../src/components/NotesView.tsx) — the tab UI.
- [`src/api/client.ts`](../src/api/client.ts) — `Note` + note methods.
- [`src/App.tsx`](../src/App.tsx) — the **Notes** tab (Pro/Premium + flag gated).
