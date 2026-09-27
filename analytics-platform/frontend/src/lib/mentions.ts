/** `@<user_id>` mentions in dashboard comments (SHR-005): autocomplete helpers and rendering. */
import type { TenantUser } from "./types";

/** Same shape as the server's MENTION_RE: `@` not preceded by a word character or `@`. */
export const MENTION_RE = /(?<![\w@])@([A-Za-z0-9_-]{1,64})/g;

export interface ActiveMention {
  /** index of the `@` */
  start: number;
  /** text typed after `@` so far */
  query: string;
}

/** The mention being typed at the caret, if any. */
export function activeMention(text: string, caret: number): ActiveMention | null {
  const before = text.slice(0, caret);
  const m = /(?:^|[^\w@])@([A-Za-z0-9_-]{0,64})$/.exec(before);
  if (!m) return null;
  return { start: caret - m[1].length - 1, query: m[1] };
}

/** Replace the active mention with `@userId ` and return the new text and caret. */
export function insertMention(text: string, mention: ActiveMention, caret: number, userId: string): { text: string; caret: number } {
  const insert = `@${userId} `;
  const next = text.slice(0, mention.start) + insert + text.slice(caret).replace(/^\s/, "");
  return { text: next, caret: mention.start + insert.length };
}

export interface MentionUser {
  id: string;
  label: string;
  sub?: string;
}

export function mentionUsers(users: Pick<TenantUser, "id" | "email" | "name" | "disabled">[]): MentionUser[] {
  return users.filter((u) => !u.disabled).map((u) => ({ id: u.id, label: u.name || u.email, sub: u.name ? u.email : undefined }));
}

export function matchUsers(users: MentionUser[], query: string, limit = 8): MentionUser[] {
  const q = query.toLowerCase();
  const hits = users.filter((u) => !q || u.id.toLowerCase().includes(q) || u.label.toLowerCase().includes(q) || (u.sub ?? "").toLowerCase().includes(q));
  return hits.slice(0, limit);
}

export type BodySegment = { kind: "text"; text: string } | { kind: "mention"; id: string; label: string };

/** Split a comment body into text and mention segments (mentions show the user's name when known). */
export function segmentBody(body: string, names: Map<string, string>): BodySegment[] {
  const out: BodySegment[] = [];
  let last = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ kind: "text", text: body.slice(last, i) });
    out.push({ kind: "mention", id: m[1], label: names.get(m[1]) ?? m[1] });
    last = i + m[0].length;
  }
  if (last < body.length) out.push({ kind: "text", text: body.slice(last) });
  return out;
}
