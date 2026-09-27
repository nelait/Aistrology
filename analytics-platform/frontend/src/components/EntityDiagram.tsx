"use client";
/** Simple entity-relationship diagram (INF-005): one box per entity, a line per foreign key. */
import { useMemo } from "react";
import type { Relationship, Schema } from "@/lib/types";

const BOX_W = 200;
const ROW_H = 18;
const HEAD_H = 26;
const GAP_X = 70;
const GAP_Y = 40;
const MAX_FIELDS = 12;

interface Edge {
  child: string;
  childField: string;
  parent: string;
  parentField: string;
  label?: string;
}

export function relationshipEdges(schema: Schema, relationships: Relationship[] = []): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const add = (e: Edge) => {
    const k = `${e.child}.${e.childField}->${e.parent}.${e.parentField}`;
    if (!seen.has(k)) {
      seen.add(k);
      edges.push(e);
    }
  };
  for (const r of relationships)
    add({ child: r.child_entity, childField: r.child_field, parent: r.parent_entity, parentField: r.parent_field, label: `${Math.round(r.containment * 100)}% match` });
  for (const e of schema.entities) for (const f of e.fields) if (f.references) add({ child: e.name, childField: f.name, parent: f.references.entity, parentField: f.references.field });
  return edges;
}

export function EntityDiagram({ schema, relationships, title = "Entity diagram" }: { schema: Schema; relationships?: Relationship[]; title?: string }) {
  const layout = useMemo(() => {
    const cols = Math.min(3, Math.max(1, schema.entities.length));
    const boxes = schema.entities.map((e, i) => {
      const fields = e.fields.slice(0, MAX_FIELDS);
      return { entity: e, fields, more: e.fields.length - fields.length, col: i % cols, row: Math.floor(i / cols), h: HEAD_H + (fields.length + (e.fields.length > MAX_FIELDS ? 1 : 0)) * ROW_H + 8 };
    });
    const rowHeights: number[] = [];
    boxes.forEach((b) => (rowHeights[b.row] = Math.max(rowHeights[b.row] ?? 0, b.h)));
    const rowY = rowHeights.map((_, r) => rowHeights.slice(0, r).reduce((a, h) => a + h + GAP_Y, 0));
    const placed = boxes.map((b) => ({ ...b, x: 10 + b.col * (BOX_W + GAP_X), y: 10 + rowY[b.row] }));
    const width = 20 + cols * BOX_W + (cols - 1) * GAP_X;
    const height = 20 + rowHeights.reduce((a, h) => a + h, 0) + GAP_Y * Math.max(0, rowHeights.length - 1);
    return { placed, width, height };
  }, [schema]);
  const edges = relationshipEdges(schema, relationships);
  const box = (name: string) => layout.placed.find((b) => b.entity.name === name);
  const fieldY = (b: (typeof layout.placed)[number], field: string) => {
    const i = b.fields.findIndex((f) => f.name === field);
    return b.y + HEAD_H + (i < 0 ? 0 : i) * ROW_H + ROW_H / 2 + 4;
  };

  if (!schema.entities.length) return <p className="text-sm text-[var(--text-2)]">No entities.</p>;
  return (
    <figure className="space-y-2">
      <div className="overflow-x-auto">
        <svg role="img" aria-labelledby="erd-title erd-desc" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} className="text-[var(--text)]">
          <title id="erd-title">{title}</title>
          <desc id="erd-desc">
            {schema.entities.length} entities; {edges.length ? edges.map((e) => `${e.child}.${e.childField} references ${e.parent}.${e.parentField}`).join("; ") : "no relationships"}.
          </desc>
          <defs>
            <marker id="erd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const c = box(e.child);
            const p = box(e.parent);
            if (!c || !p) return null;
            const leftToRight = c.x <= p.x;
            const x1 = leftToRight ? c.x + BOX_W : c.x;
            const x2 = c === p ? c.x + BOX_W + 30 : leftToRight ? p.x : p.x + BOX_W;
            const y1 = fieldY(c, e.childField);
            const y2 = fieldY(p, e.parentField);
            const mx = (x1 + x2) / 2;
            return (
              <g key={i} className="text-brand-600 dark:text-brand-300">
                <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke="currentColor" strokeWidth={1.5} markerEnd="url(#erd-arrow)" />
                {e.label && (
                  <text x={mx} y={(y1 + y2) / 2 - 4} textAnchor="middle" fontSize={10} fill="currentColor">
                    {e.label}
                  </text>
                )}
              </g>
            );
          })}
          {layout.placed.map((b) => (
            <g key={b.entity.name}>
              <rect x={b.x} y={b.y} width={BOX_W} height={b.h} rx={6} fill="var(--surface)" stroke="var(--border)" />
              <rect x={b.x} y={b.y} width={BOX_W} height={HEAD_H} rx={6} className="fill-brand-50 dark:fill-brand-900" />
              <text x={b.x + 10} y={b.y + 17} fontSize={12} fontWeight={600} fill="currentColor">
                {b.entity.name}
              </text>
              {b.fields.map((f, i) => (
                <text key={f.name} x={b.x + 10} y={b.y + HEAD_H + i * ROW_H + 14} fontSize={11} fill="currentColor" fontFamily="ui-monospace, monospace">
                  {f.primary_key ? "PK " : f.references ? "FK " : ""}
                  {f.name}
                  <tspan fill="var(--text-2)"> {f.type}</tspan>
                </text>
              ))}
              {b.more > 0 && (
                <text x={b.x + 10} y={b.y + HEAD_H + b.fields.length * ROW_H + 14} fontSize={11} fill="var(--text-2)">
                  … {b.more} more
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>
      {edges.length > 0 && (
        <figcaption>
          <ul className="space-y-0.5 text-xs text-[var(--text-2)]">
            {edges.map((e, i) => (
              <li key={i}>
                <span className="font-mono">
                  {e.child}.{e.childField}
                </span>{" "}
                →{" "}
                <span className="font-mono">
                  {e.parent}.{e.parentField}
                </span>
                {e.label ? ` (${e.label})` : ""}
              </li>
            ))}
          </ul>
        </figcaption>
      )}
    </figure>
  );
}
