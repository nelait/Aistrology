"use client";
/** Dashboard / widget comment threads (SHR-005): side panel with @mentions, replies, resolve, edit / delete. */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CommentThread, type DashboardComment, type Widget } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { mentionUsers, segmentBody } from "@/lib/mentions";
import { useTenantUsers } from "../useDirectory";
import { Badge, Button, Checkbox, EmptyState, ErrorState, Modal, SelectField, Spinner } from "../ui";
import { MentionTextarea } from "./MentionTextarea";

/** "" = every thread, "dashboard" = general threads, otherwise a widget id */
export type CommentScope = string;

export function useDashboardComments(dashboardId: string, enabled = true) {
  return useQuery({
    queryKey: ["comments", dashboardId],
    queryFn: () => api.dashboards.comments(dashboardId, { include_resolved: true }),
    enabled,
    refetchInterval: 60_000,
    meta: { silent: true },
  });
}

/** Unresolved thread count per widget id ("" key = dashboard-level threads). */
export function openThreadCounts(threads: CommentThread[] | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of threads ?? []) if (!t.resolved) m.set(t.widget_id ?? "", (m.get(t.widget_id ?? "") ?? 0) + 1);
  return m;
}

export function CommentsPanel({
  dashboardId,
  widgets,
  scope,
  onScope,
  canModerate,
  onClose,
}: {
  dashboardId: string;
  widgets: Widget[];
  scope: CommentScope;
  onScope: (s: CommentScope) => void;
  /** dashboard owner / editor or admin: may resolve anyone's thread */
  canModerate: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { users, names, complete } = useTenantUsers();
  const people = useMemo(() => mentionUsers(users), [users]);
  const q = useDashboardComments(dashboardId);
  const [showResolved, setShowResolved] = useState(false);
  const [draft, setDraft] = useState("");
  const widgetTitle = useMemo(() => new Map(widgets.map((w) => [w.id, w.title])), [widgets]);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["comments", dashboardId] });

  const post = useMutation({
    mutationFn: (body: { body: string; widget_id?: string | null; parent_id?: string | null }) => api.dashboards.addComment(dashboardId, body),
    meta: { errorPrefix: "Comment not posted" },
    onSuccess: () => invalidate(),
  });

  const threads = (q.data ?? []).filter((t) => (scope === "" ? true : scope === "dashboard" ? !t.widget_id : t.widget_id === scope)).filter((t) => showResolved || !t.resolved);
  const resolvedHidden = (q.data ?? []).filter((t) => t.resolved && (scope === "" || (scope === "dashboard" ? !t.widget_id : t.widget_id === scope))).length;

  return (
    <Modal open onClose={onClose} side title="Comments">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <SelectField
            label="Show"
            className="min-w-0 flex-1"
            value={scope}
            onChange={(e) => onScope(e.target.value)}
            options={[{ value: "", label: "All comments" }, { value: "dashboard", label: "Dashboard (general)" }, ...widgets.map((w) => ({ value: w.id, label: `Widget: ${w.title}` }))]}
          />
          <Checkbox label={`Resolved (${resolvedHidden})`} checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
        </div>

        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            post.mutate({ body: draft.trim(), widget_id: scope && scope !== "dashboard" ? scope : null }, { onSuccess: () => setDraft("") });
          }}
        >
          <MentionTextarea
            label={scope && scope !== "dashboard" ? `New comment on “${widgetTitle.get(scope) ?? scope}”` : "New comment on this dashboard"}
            value={draft}
            onChange={setDraft}
            users={people}
            placeholder="Share a finding, ask a question…"
            onSubmit={() => draft.trim() && post.mutate({ body: draft.trim(), widget_id: scope && scope !== "dashboard" ? scope : null }, { onSuccess: () => setDraft("") })}
            hint={complete ? undefined : "Type @ to mention yourself, or @ followed by a user id. Ctrl/⌘ + Enter to post."}
          />
          <Button type="submit" variant="primary" size="sm" loading={post.isPending} disabled={!draft.trim()}>
            Comment
          </Button>
        </form>

        {q.isLoading ? (
          <Spinner label="Loading comments…" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : threads.length === 0 ? (
          <EmptyState title="No comments here yet">Mentioned people get a notification (in-app, and by email or chat if they opted in).</EmptyState>
        ) : (
          <ol className="space-y-3" aria-label="Comment threads">
            {threads.map((t) => (
              <Thread
                key={t.id}
                thread={t}
                dashboardId={dashboardId}
                names={names}
                people={people}
                widgetTitle={t.widget_id ? widgetTitle.get(t.widget_id) ?? "deleted widget" : null}
                showWidget={scope === ""}
                canModerate={canModerate}
                onChanged={invalidate}
              />
            ))}
          </ol>
        )}
      </div>
    </Modal>
  );
}

function Thread({
  thread,
  dashboardId,
  names,
  people,
  widgetTitle,
  showWidget,
  canModerate,
  onChanged,
}: {
  thread: CommentThread;
  dashboardId: string;
  names: Map<string, string>;
  people: ReturnType<typeof mentionUsers>;
  widgetTitle: string | null;
  showWidget: boolean;
  canModerate: boolean;
  onChanged: () => void;
}) {
  const { me } = useAuth();
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const resolve = useMutation({
    mutationFn: (resolved: boolean) => api.dashboards.updateComment(dashboardId, thread.id, { resolved }),
    meta: { errorPrefix: "Could not update the thread" },
    onSuccess: onChanged,
  });
  const post = useMutation({
    mutationFn: () => api.dashboards.addComment(dashboardId, { body: reply.trim(), parent_id: thread.id }),
    meta: { errorPrefix: "Reply not posted" },
    onSuccess: () => {
      setReply("");
      setReplying(false);
      onChanged();
    },
  });
  const mayResolve = canModerate || thread.author_id === me?.id;
  return (
    <li className={`rounded-lg border p-3 ${thread.resolved ? "border-dashed border-[var(--border)] opacity-80" : "border-[var(--border)]"}`}>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
        {showWidget && <Badge tone="info">{widgetTitle ? `▦ ${widgetTitle}` : "Dashboard"}</Badge>}
        {thread.resolved && <Badge tone="good">✓ resolved</Badge>}
        <span className="flex-1" />
        {mayResolve && (
          <Button size="sm" variant="ghost" onClick={() => resolve.mutate(!thread.resolved)} loading={resolve.isPending}>
            {thread.resolved ? "Reopen" : "Resolve"}
          </Button>
        )}
      </div>
      <CommentItem comment={thread} dashboardId={dashboardId} names={names} people={people} onChanged={onChanged} />
      {thread.replies.length > 0 && (
        <ol className="mt-2 space-y-2 border-l-2 border-[var(--border)] pl-3" aria-label="Replies">
          {thread.replies.map((r) => (
            <li key={r.id}>
              <CommentItem comment={r} dashboardId={dashboardId} names={names} people={people} onChanged={onChanged} />
            </li>
          ))}
        </ol>
      )}
      {replying ? (
        <form
          className="mt-2 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (reply.trim()) post.mutate();
          }}
        >
          <MentionTextarea label="Reply" value={reply} onChange={setReply} users={people} rows={2} autoFocus onSubmit={() => reply.trim() && post.mutate()} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" loading={post.isPending} disabled={!reply.trim()}>
              Reply
            </Button>
            <Button size="sm" onClick={() => setReplying(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button size="sm" variant="ghost" className="mt-1" onClick={() => setReplying(true)}>
          ↩ Reply
        </Button>
      )}
    </li>
  );
}

function CommentItem({ comment, dashboardId, names, people, onChanged }: { comment: DashboardComment; dashboardId: string; names: Map<string, string>; people: ReturnType<typeof mentionUsers>; onChanged: () => void }) {
  const { me, can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.body);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const own = comment.author_id === me?.id;
  const save = useMutation({
    mutationFn: () => api.dashboards.updateComment(dashboardId, comment.id, { body: text.trim() }),
    meta: { errorPrefix: "Comment not saved" },
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.dashboards.deleteComment(dashboardId, comment.id),
    meta: { errorPrefix: "Comment not deleted" },
    onSuccess: onChanged,
  });
  const author = own ? "You" : names.get(comment.author_id) ?? comment.author_id;
  return (
    <article aria-label={`Comment by ${author}`}>
      <header className="flex flex-wrap items-baseline gap-x-2 text-xs text-[var(--text-2)]">
        <span className="font-semibold text-[var(--text)]">{author}</span>
        <time dateTime={comment.created_at}>{formatDate(comment.created_at)}</time>
        {comment.edited_at && <span>(edited)</span>}
      </header>
      {editing ? (
        <form
          className="mt-1 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) save.mutate();
          }}
        >
          <MentionTextarea label="Edit comment" value={text} onChange={setText} users={people} rows={2} autoFocus onSubmit={() => text.trim() && save.mutate()} hint="People mentioned for the first time are notified." />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" loading={save.isPending} disabled={!text.trim() || text.trim() === comment.body}>
              Save
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setEditing(false);
                setText(comment.body);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">
          {segmentBody(comment.body, names).map((s, i) =>
            s.kind === "text" ? (
              <span key={i}>{s.text}</span>
            ) : (
              <span key={i} className="rounded bg-brand-50 px-1 font-medium text-brand-800 dark:bg-brand-900/40 dark:text-brand-100" title={s.id}>
                @{s.id === me?.id ? "you" : s.label}
              </span>
            ),
          )}
        </p>
      )}
      {!editing && (own || can("tenant.manage")) && (
        <div className="mt-1 flex gap-1">
          {own && (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label="Edit comment">
              Edit
            </Button>
          )}
          {confirmDelete ? (
            <>
              <Button size="sm" variant="danger" onClick={() => remove.mutate()} loading={remove.isPending}>
                Confirm delete{comment.parent_id ? "" : " (and replies)"}
              </Button>
              <Button size="sm" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} aria-label="Delete comment">
              Delete
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
