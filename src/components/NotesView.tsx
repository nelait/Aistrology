import { useEffect, useState } from "react";
import { api, Note } from "../api/client";
import type { Chart } from "../astro/types";

interface Props {
  chart: Chart | null;
  /** The active saved profile id; notes attach to it. Null = unsaved profile. */
  chartId: string | null;
}

export default function NotesView({ chart, chartId }: Props) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Draft for the "new note" composer.
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  // Inline edit state.
  const [editId, setEditId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");

  useEffect(() => {
    if (!chartId) { setLoading(false); return; }
    setLoading(true); setErr(null);
    api.listNotes(chartId)
      .then(setNotes)
      .catch((e) => setErr(e instanceof Error ? e.message : "Couldn't load notes"))
      .finally(() => setLoading(false));
  }, [chartId]);

  if (!chartId) {
    return (
      <div className="notes">
        <header className="notes-head">
          <h2>📝 Notes</h2>
        </header>
        <div className="notes-empty-state">
          <p className="muted">
            Notes attach to a <strong>saved profile</strong>. Save this chart first — open the
            <strong> profile switcher</strong> (top-right) → <strong>Save current</strong> — then come back to add notes.
          </p>
        </div>
      </div>
    );
  }

  const add = async () => {
    if (!title.trim() && !body.trim()) return;
    setBusy(true); setErr(null);
    try {
      const note = await api.createNote(chartId, title.trim(), body.trim());
      setNotes((n) => [note, ...n]);
      setTitle(""); setBody("");
    } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't save note"); }
    finally { setBusy(false); }
  };

  const startEdit = (n: Note) => { setEditId(n.id); setEditTitle(n.title); setEditBody(n.body); };
  const cancelEdit = () => { setEditId(null); setEditTitle(""); setEditBody(""); };

  const saveEdit = async (id: string) => {
    if (!editTitle.trim() && !editBody.trim()) return;
    setBusy(true); setErr(null);
    try {
      const updated = await api.updateNote(id, editTitle.trim(), editBody.trim());
      setNotes((n) => n.map((x) => (x.id === id ? updated : x)).sort((a, b) => b.updatedAt - a.updatedAt));
      cancelEdit();
    } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't update note"); }
    finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this note?")) return;
    setBusy(true); setErr(null);
    try {
      await api.deleteNote(id);
      setNotes((n) => n.filter((x) => x.id !== id));
      if (editId === id) cancelEdit();
    } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't delete note"); }
    finally { setBusy(false); }
  };

  return (
    <div className="notes">
      <header className="notes-head">
        <h2>📝 Notes</h2>
        <p className="muted">
          Private notes for <strong>{chart?.birth.name ?? "this profile"}</strong> — observations,
          reminders, consultation prep. Only you can see them.
        </p>
      </header>

      <div className="note-composer">
        <input
          className="note-title-input" value={title} maxLength={200}
          onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)"
        />
        <textarea
          className="note-body-input" value={body} rows={3} maxLength={20000}
          onChange={(e) => setBody(e.target.value)} placeholder="Write a note about this profile…"
        />
        <div className="request-btns">
          <button className="primary" onClick={add} disabled={busy || (!title.trim() && !body.trim())}>
            {busy ? "Saving…" : "Add note"}
          </button>
        </div>
      </div>

      {err && <p className="error small">{err}</p>}

      {loading ? (
        <p className="muted small">Loading notes…</p>
      ) : notes.length === 0 ? (
        <p className="muted small">No notes yet for this profile.</p>
      ) : (
        <div className="note-list">
          {notes.map((n) => (
            <div key={n.id} className="note-card">
              {editId === n.id ? (
                <>
                  <input className="note-title-input" value={editTitle} maxLength={200}
                    onChange={(e) => setEditTitle(e.target.value)} placeholder="Title (optional)" />
                  <textarea className="note-body-input" value={editBody} rows={4} maxLength={20000}
                    onChange={(e) => setEditBody(e.target.value)} />
                  <div className="request-btns">
                    <button className="primary" onClick={() => saveEdit(n.id)} disabled={busy}>Save</button>
                    <button className="mini-btn" onClick={cancelEdit} disabled={busy}>Cancel</button>
                  </div>
                </>
              ) : (
                <>
                  {n.title && <h4 className="note-title">{n.title}</h4>}
                  {n.body && <p className="note-body">{n.body}</p>}
                  <div className="note-foot">
                    <span className="muted small">Updated {new Date(n.updatedAt).toLocaleString()}</span>
                    <div className="request-btns">
                      <button className="mini-btn" onClick={() => startEdit(n)}>Edit</button>
                      <button className="mini-btn danger" onClick={() => remove(n.id)}>Delete</button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
