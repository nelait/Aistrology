import { useEffect, useRef, useState } from "react";
import { api, AppNotification } from "../api/client";

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const r = await api.getNotifications();
      setItems(r.notifications);
      setUnread(r.unread);
    } catch {
      /* not signed in / offline — leave as is */
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000); // light polling
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const toggle = () => {
    setOpen((o) => !o);
    if (!open) load();
  };

  const markRead = async (id: string) => {
    try {
      const r = await api.markNotificationRead(id);
      setUnread(r.unread);
      setItems((xs) => xs.map((n) => (n.id === id ? { ...n, read: true } : n)));
    } catch { /* ignore */ }
  };

  const markAll = async () => {
    try {
      await api.markAllNotificationsRead();
      setUnread(0);
      setItems((xs) => xs.map((n) => ({ ...n, read: true })));
    } catch { /* ignore */ }
  };

  return (
    <div className="notif" ref={ref}>
      <button className="notif-btn" onClick={toggle} title="Notifications" aria-label="Notifications">
        🔔
        {unread > 0 && <span className="notif-badge">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="notif-menu">
          <div className="notif-head">
            <strong>Notifications</strong>
            {unread > 0 && <button className="link small" onClick={markAll}>Mark all read</button>}
          </div>
          {items.length === 0 ? (
            <p className="notif-empty muted small">You're all caught up.</p>
          ) : (
            <ul className="notif-list">
              {items.map((n) => (
                <li
                  key={n.id}
                  className={`notif-item ${n.read ? "read" : "unread"} lvl-${n.level}`}
                  onClick={() => !n.read && markRead(n.id)}
                >
                  <div className="notif-item-title">
                    {!n.read && <span className="notif-dot" />}
                    <strong>{n.title}</strong>
                  </div>
                  <p>{n.body}</p>
                  <span className="muted small">{new Date(n.createdAt).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
