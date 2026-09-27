"use client";
/**
 * Minimal, safe Markdown renderer (WDG-004). It builds React elements instead of HTML strings, so
 * user text can never inject markup; links are restricted to http(s)/mailto.
 */
import { Fragment } from "react";

function safeHref(href: string): string | null {
  try {
    const u = new URL(href, "https://placeholder.invalid");
    return ["http:", "https:", "mailto:"].includes(u.protocol) && !href.startsWith("//") ? href : null;
  } catch {
    return null;
  }
}

function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*|_[^_]+_)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (m[1]) out.push(<code key={k} className="rounded bg-[var(--surface-2)] px-1 font-mono text-[0.9em]">{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(tok.slice(2, -2), k)}</strong>);
    else if (m[3]) out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>);
    else if (m[4]) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok) ?? [];
      const safe = href ? safeHref(href) : null;
      out.push(
        safe ? (
          <a key={k} href={safe} target="_blank" rel="noopener noreferrer nofollow" className="text-brand-600 underline dark:text-brand-300">
            {label}
          </a>
        ) : (
          <Fragment key={k}>{label}</Fragment>
        ),
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key++} className="overflow-auto rounded bg-[var(--surface-2)] p-2 font-mono text-xs">
          {code.join("\n")}
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const cls = ["text-xl font-semibold", "text-lg font-semibold", "text-base font-semibold", "text-sm font-semibold"][level - 1];
      const Tag = (["h2", "h3", "h4", "h5"] as const)[level - 1];
      blocks.push(
        <Tag key={key++} className={cls}>
          {inline(h[2], `h${key}`)}
        </Tag>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={key++} className={ordered ? "list-decimal pl-5" : "list-disc pl-5"}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, `li${key}-${j}`)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      blocks.push(
        <blockquote key={key++} className="border-l-4 border-[var(--border)] pl-3 text-[var(--text-2)]">
          {inline(line.replace(/^>\s?/, ""), `q${key}`)}
        </blockquote>,
      );
      i++;
      continue;
    }
    if (/^(---|\*\*\*)\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="border-[var(--border)]" />);
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s|>)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={key++}>{inline(para.join(" "), `p${key}`)}</p>);
  }
  return <div className={`space-y-2 text-sm ${className ?? ""}`}>{blocks}</div>;
}
