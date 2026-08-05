import { useEffect, useRef, useState } from "react";
import { api, SavedChart } from "../api/client";
import { BirthData } from "../astro/types";

interface Props {
  currentBirth: BirthData | null;
  /** The active saved profile id (null when the loaded chart isn't saved). */
  activeChartId: string | null;
  onLoadChart: (birth: BirthData, chartId: string) => void;
  onNewChart: () => void;
  /** Called after deleting a profile so the app can clear a now-stale active id. */
  onProfileDeleted: (id: string) => void;
}

type SortMode = "recent" | "alpha";

// A dedicated profile switcher, separate from the account menu. Shows the profile
// you're viewing, and lets you search, sort, rename, switch, save and create —
// with keyboard navigation (↑/↓ to move, Enter to open, Esc to close).
export default function ProfileSwitcher({
  currentBirth, activeChartId, onLoadChart, onNewChart, onProfileDeleted,
}: Props) {
  const [charts, setCharts] = useState<SavedChart[]>([]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("recent");
  const [saveLabel, setSaveLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [editId, setEditId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = () => api.listCharts().then(setCharts).catch(() => {});
  useEffect(() => { load(); }, []);
  useEffect(() => { if (open) load(); }, [open]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // On open, reset transient state and move focus into the menu.
  useEffect(() => {
    if (!open) return;
    setHighlight(0); setSearch(""); setEditId(null); setError(null);
    const t = setTimeout(() => (searchRef.current ?? menuRef.current)?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const active = charts.find((c) => c.id === activeChartId) ?? null;
  const isUnsaved = !!currentBirth && !activeChartId;
  const pillName = active?.label
    ?? (currentBirth?.name && currentBirth.name !== "Native" ? currentBirth.name : null)
    ?? "Choose profile";

  const q = search.trim().toLowerCase();
  const filtered = q
    ? charts.filter((c) => c.label.toLowerCase().includes(q) || c.birth.placeLabel.toLowerCase().includes(q))
    : charts;
  const visible = sort === "alpha"
    ? [...filtered].sort((a, b) => a.label.localeCompare(b.label))
    : filtered; // "recent" — API already returns updated_at DESC

  // Keep the highlight in range as the list changes.
  useEffect(() => { setHighlight((h) => Math.min(Math.max(0, h), Math.max(0, visible.length - 1))); }, [visible.length]);

  function close() { setOpen(false); setEditId(null); }

  function selectChart(c: SavedChart) { onLoadChart(c.birth, c.id); close(); }

  function onMenuKeyDown(e: React.KeyboardEvent) {
    if (editId) return; // let the rename input handle its own keys
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(visible.length - 1, h + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(0, h - 1)); }
    else if (e.key === "Enter") {
      const c = visible[highlight];
      if (c) { e.preventDefault(); selectChart(c); }
    } else if (e.key === "Escape") { e.preventDefault(); close(); ref.current?.querySelector<HTMLButtonElement>(".profile-pill")?.focus(); }
  }

  // Scroll the highlighted row into view.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>(".profile-list li.highlight")?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  async function save() {
    if (!currentBirth) return;
    setBusy(true); setError(null);
    try {
      const label = saveLabel.trim() || currentBirth.name || currentBirth.placeLabel || "My chart";
      const chart = await api.createChart(label, currentBirth);
      setCharts((cs) => [chart, ...cs.filter((c) => c.id !== chart.id)]);
      setSaveLabel("");
      onLoadChart(chart.birth, chart.id);
      close();
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed"); }
    finally { setBusy(false); }
  }

  async function commitRename(id: string) {
    const label = editLabel.trim();
    if (!label) { setEditId(null); return; }
    setBusy(true); setError(null);
    try {
      const updated = await api.renameChart(id, label);
      setCharts((cs) => cs.map((c) => (c.id === id ? updated : c)));
      setEditId(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Rename failed"); }
    finally { setBusy(false); }
  }

  async function del(id: string, label: string) {
    if (!confirm(`Delete profile "${label}"? This can't be undone.`)) return;
    setError(null);
    try {
      await api.deleteChart(id);
      setCharts((cs) => cs.filter((c) => c.id !== id));
      onProfileDeleted(id);
    } catch (e) { setError(e instanceof Error ? e.message : "Delete failed"); }
  }

  return (
    <div className="profile-switcher" ref={ref}>
      <button className="profile-pill" onClick={() => setOpen((o) => !o)} title="Switch profile"
        aria-haspopup="menu" aria-expanded={open}>
        <span className="profile-pill-icon">👤</span>
        <span className="profile-pill-name">{pillName}</span>
        {isUnsaved && <span className="profile-pill-badge" title="Not saved">unsaved</span>}
        <span className="chevron">▾</span>
      </button>

      {open && (
        <div className="profile-menu" ref={menuRef} tabIndex={-1} onKeyDown={onMenuKeyDown}>
          <div className="profile-menu-actions">
            <button className="profile-new" onClick={() => { onNewChart(); close(); }}>＋ New chart</button>
          </div>

          {isUnsaved && (
            <div className="profile-save-row">
              <input value={saveLabel} onChange={(e) => setSaveLabel(e.target.value)}
                placeholder={currentBirth?.name || "Label this profile"} />
              <button className="primary" onClick={save} disabled={busy}>Save current</button>
            </div>
          )}

          {charts.length > 4 && (
            <input className="profile-search" ref={searchRef} value={search}
              onChange={(e) => setSearch(e.target.value)} placeholder="Search profiles…" />
          )}

          <div className="profile-list-head">
            <span className="menu-title">My profiles {charts.length > 0 && <span className="muted">({charts.length})</span>}</span>
            {charts.length > 1 && (
              <div className="profile-sort" role="group" aria-label="Sort profiles">
                <button className={sort === "recent" ? "on" : ""} onClick={() => setSort("recent")}>Recent</button>
                <button className={sort === "alpha" ? "on" : ""} onClick={() => setSort("alpha")}>A–Z</button>
              </div>
            )}
          </div>

          {charts.length === 0 ? (
            <p className="muted small">No saved profiles yet. Cast a chart and save it here.</p>
          ) : visible.length === 0 ? (
            <p className="muted small">No profiles match “{search}”.</p>
          ) : (
            <ul className="profile-list">
              {visible.map((c, i) => {
                const isActive = c.id === activeChartId;
                const isHi = i === highlight;
                return (
                  <li key={c.id} className={`${isActive ? "active" : ""} ${isHi ? "highlight" : ""}`.trim()}>
                    {editId === c.id ? (
                      <input
                        className="profile-rename" autoFocus value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); commitRename(c.id); }
                          else if (e.key === "Escape") { e.preventDefault(); setEditId(null); }
                        }}
                        onBlur={() => commitRename(c.id)}
                      />
                    ) : (
                      <button className="profile-load" onMouseEnter={() => setHighlight(i)}
                        onClick={() => selectChart(c)}>
                        <span className="profile-check">{isActive ? "✓" : ""}</span>
                        <span className="profile-load-text">
                          <strong>{c.label}</strong>
                          <span className="muted small">
                            {String(c.birth.day).padStart(2, "0")}/{String(c.birth.month).padStart(2, "0")}/
                            {c.birth.year} · {c.birth.placeLabel}
                          </span>
                        </span>
                      </button>
                    )}
                    {editId !== c.id && (
                      <div className="profile-row-actions">
                        <button className="row-act" title="Rename"
                          onClick={() => { setEditId(c.id); setEditLabel(c.label); }}>✎</button>
                        <button className="row-act del" title="Delete profile" onClick={() => del(c.id, c.label)}>✕</button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {error && <p className="error small">{error}</p>}
        </div>
      )}
    </div>
  );
}
