"use client";
/** Monaco SQL editor with schema-aware autocomplete of the `data` table's columns (USR-003). */
import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import type { Monaco, OnMount } from "@monaco-editor/react";
import { useTheme } from "@/lib/theme";

const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
  loading: () => <div className="h-full min-h-32 animate-pulse rounded bg-[var(--surface-2)]" aria-hidden="true" />,
});

const KEYWORDS = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "AS", "AND", "OR", "NOT", "IN", "IS NULL", "IS NOT NULL",
  "BETWEEN", "LIKE", "ILIKE", "CASE", "WHEN", "THEN", "ELSE", "END", "DISTINCT", "WITH", "JOIN", "LEFT JOIN", "ON", "UNION ALL",
  "COUNT", "SUM", "AVG", "MIN", "MAX", "MEDIAN", "STDDEV", "QUANTILE_CONT", "DATE_TRUNC", "EXTRACT", "CAST", "COALESCE", "ROUND",
  "STRFTIME", "APPROX_COUNT_DISTINCT", "OVER", "PARTITION BY", "ROW_NUMBER", "DESC", "ASC",
];

interface Position {
  lineNumber: number;
  column: number;
}
interface TextModel {
  getWordUntilPosition(p: Position): { startColumn: number; endColumn: number };
}

export interface SqlColumn {
  name: string;
  type: string;
}

export function SqlEditor({
  value,
  onChange,
  columns,
  tables = ["data"],
  height = 220,
  onRun,
  label = "SQL query",
}: {
  value: string;
  onChange: (v: string) => void;
  columns: SqlColumn[];
  tables?: string[];
  height?: number | string;
  onRun?: () => void;
  label?: string;
}) {
  const { dark } = useTheme();
  const colsRef = useRef(columns);
  const runRef = useRef(onRun);
  const disposeRef = useRef<{ dispose: () => void } | null>(null);
  colsRef.current = columns;
  runRef.current = onRun;

  useEffect(() => () => disposeRef.current?.dispose(), []);

  const register = (monaco: Monaco) => {
    disposeRef.current?.dispose();
    disposeRef.current = monaco.languages.registerCompletionItemProvider("sql", {
      triggerCharacters: [" ", ".", '"', ","],
      provideCompletionItems: (model: TextModel, position: Position) => {
        const word = model.getWordUntilPosition(position);
        const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
        const K = monaco.languages.CompletionItemKind;
        const needsQuote = (n: string) => !/^[a-z_][a-z0-9_]*$/.test(n);
        return {
          suggestions: [
            ...colsRef.current.map((c) => ({
              label: c.name,
              kind: K.Field,
              detail: `column · ${c.type}`,
              insertText: needsQuote(c.name) ? `"${c.name.replace(/"/g, '""')}"` : c.name,
              range,
              sortText: `0${c.name}`,
            })),
            ...tables.map((t) => ({ label: t, kind: K.Struct, detail: "table", insertText: t, range, sortText: `1${t}` })),
            ...KEYWORDS.map((k) => ({ label: k, kind: K.Keyword, insertText: k, range, sortText: `2${k}` })),
          ],
        };
      },
    });
  };

  const onMount: OnMount = (editor, monaco) => {
    register(monaco);
    editor.addAction({
      id: "run-query",
      label: "Run query",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => runRef.current?.(),
    });
    const el = editor.getDomNode()?.querySelector("textarea");
    el?.setAttribute("aria-label", `${label} (Ctrl+Enter to run)`);
  };

  return (
    <div className="overflow-hidden rounded-md border border-[var(--border)]" style={{ height }}>
      <MonacoEditor
        language="sql"
        value={value}
        onChange={(v) => onChange(v ?? "")}
        onMount={onMount}
        theme={dark ? "vs-dark" : "light"}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          scrollBeyondLastLine: false,
          wordWrap: "on",
          automaticLayout: true,
          tabSize: 2,
          accessibilitySupport: "auto",
          ariaLabel: label,
        }}
      />
    </div>
  );
}
