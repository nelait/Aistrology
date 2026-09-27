"""SQL DDL → canonical schema (SCH-004).

A hand-written tokenizer and recursive-descent parser for the ``CREATE TABLE``
subset that schema dumps actually use, across PostgreSQL, MySQL/MariaDB, SQLite,
SQL Server, BigQuery and Snowflake:

* column types (dialect types are mapped to :class:`FieldType`; ``VARCHAR(n)`` → ``max_length``;
  ``DECIMAL``/``NUMERIC`` → number; ``ENUM('a','b')`` → enum; ``INT[]`` / ``ARRAY<T>`` → array),
* ``NOT NULL`` / ``NULL``, ``PRIMARY KEY`` and ``UNIQUE`` (inline and table-level),
* ``FOREIGN KEY`` (inline ``REFERENCES`` and table-level, plus ``ALTER TABLE … ADD FOREIGN KEY``),
* ``CHECK`` constraints with simple comparisons, ``BETWEEN``, ``IN (…)``, ``= ANY (ARRAY[…])``,
  ``OR``-ed equalities and ``length(col)`` bounds → minimum/maximum/enum/min_length/max_length.

``DEFAULT`` values, identity/auto-increment, collations, comments and table options
are ignored. Everything else that can't be mapped is reported as a located warning
(``line:col``), and syntax errors raise :class:`SchemaValidationError` with the
location of the offending token (SCH-009). No SQL is ever executed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .model import IDENTIFIER_RE, Entity, Field, FieldType, ForeignKey, Issue, Schema, SchemaValidationError, Semantic, ensure_valid
from .semantics import guess_semantic

MAX_DDL_CHARS = 2_000_000

# ---------------------------------------------------------------------------
# Tokenizer
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Token:
    kind: str  # word | qword (quoted identifier) | string | number | op | eof
    value: str
    line: int
    col: int

    @property
    def upper(self) -> str:
        return self.value.upper() if self.kind == "word" else ""

    @property
    def loc(self) -> str:
        return f"{self.line}:{self.col}"


_OPS = ("::", "<=", ">=", "<>", "!=", "==", "(", ")", ",", ";", ".", "=", "<", ">", "[", "]", "+", "-", "*", "/", "%", "|", "&", "~", "@")
_WORD_RE = re.compile(r"[A-Za-z_\u0080-￿][A-Za-z0-9_$#\u0080-￿]*")
_NUMBER_RE = re.compile(r"(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?")


def _error(line: int, col: int, message: str) -> SchemaValidationError:
    return SchemaValidationError([Issue(path=f"{line}:{col}", message=message)])


def tokenize(source: str) -> list[Token]:
    tokens: list[Token] = []
    i, line, line_start = 0, 1, 0
    n = len(source)

    def pos(at: int) -> tuple[int, int]:
        return line, at - line_start + 1

    while i < n:
        c = source[i]
        if c == "\n":
            line, line_start = line + 1, i + 1
            i += 1
            continue
        if c.isspace():
            i += 1
            continue
        if source.startswith("--", i) or c == "#" and (i == 0 or source[i - 1] in "\n\r\t "):
            end = source.find("\n", i)
            i = n if end == -1 else end
            continue
        if source.startswith("/*", i):
            end = source.find("*/", i + 2)
            if end == -1:
                raise _error(*pos(i), "unterminated /* comment")
            for j in range(i, end):
                if source[j] == "\n":
                    line, line_start = line + 1, j + 1
            i = end + 2
            continue
        ln, col = pos(i)
        if c in "'\"`[":
            close = {"'": "'", '"': '"', "`": "`", "[": "]"}[c]
            j, buf = i + 1, []
            while True:
                if j >= n:
                    raise _error(ln, col, f"unterminated {'string' if c == chr(39) else 'quoted identifier'}")
                ch = source[j]
                if ch == close:
                    if j + 1 < n and source[j + 1] == close and close != "]":  # doubled quote escape
                        buf.append(close)
                        j += 2
                        continue
                    break
                if ch == "\\" and c == "'" and j + 1 < n:  # MySQL / BigQuery backslash escapes
                    buf.append(source[j + 1])
                    j += 2
                    continue
                if ch == "\n":
                    line, line_start = line + 1, j + 1
                buf.append(ch)
                j += 1
            inner = "".join(buf).strip()
            prev = tokens[-1] if tokens else None
            if c == "[" and (not inner or inner.isdigit() or (prev is not None and prev.kind == "word" and prev.value.upper() == "ARRAY")):
                # ``INT[]`` / ``ARRAY[...]`` (Postgres) rather than a SQL Server [identifier].
                tokens.append(Token("op", "[", ln, col))
                i += 1
                continue
            tokens.append(Token("string" if c == "'" else "qword", "".join(buf), ln, col))
            i = j + 1
            continue
        m = _NUMBER_RE.match(source, i)
        if m and (c.isdigit() or c == "."):
            tokens.append(Token("number", m.group(0), ln, col))
            i = m.end()
            continue
        m = _WORD_RE.match(source, i)
        if m:
            tokens.append(Token("word", m.group(0), ln, col))
            i = m.end()
            continue
        for op in _OPS:
            if source.startswith(op, i):
                tokens.append(Token("op", op, ln, col))
                i += len(op)
                break
        else:
            raise _error(ln, col, f"unexpected character {c!r}")
    tokens.append(Token("eof", "", line, n - line_start + 1))
    return tokens


# ---------------------------------------------------------------------------
# Type mapping
# ---------------------------------------------------------------------------

_INTEGER = set(
    "INT INTEGER BIGINT SMALLINT TINYINT MEDIUMINT INT2 INT4 INT8 INT64 SERIAL BIGSERIAL SMALLSERIAL SERIAL4 SERIAL8 BYTEINT UNSIGNED".split()
)
_NUMBER = set("DECIMAL NUMERIC DEC FIXED FLOAT FLOAT4 FLOAT8 FLOAT64 REAL DOUBLE MONEY SMALLMONEY BIGNUMERIC BIGDECIMAL".split())
_BOOLEAN = {"BOOLEAN", "BOOL", "BIT"}
_DATE = {"DATE"}
_DATETIME = set("TIMESTAMP TIMESTAMPTZ DATETIME DATETIME2 SMALLDATETIME DATETIMEOFFSET TIMESTAMP_NTZ TIMESTAMP_LTZ TIMESTAMP_TZ".split())
_STRING = set(
    "CHAR CHARACTER VARCHAR VARCHAR2 NVARCHAR NVARCHAR2 NCHAR TEXT TINYTEXT MEDIUMTEXT LONGTEXT NTEXT CLOB NCLOB STRING CITEXT "
    "UUID UNIQUEIDENTIFIER JSON JSONB XML INET CIDR MACADDR TIME TIMETZ INTERVAL YEAR SET VARIANT OBJECT GEOGRAPHY GEOMETRY "
    "BYTEA BLOB TINYBLOB MEDIUMBLOB LONGBLOB BINARY VARBINARY BYTES IMAGE ENUM NATIONAL SYSNAME HSTORE TSVECTOR STRUCT RECORD "
    "ROWVERSION LONG SQL_VARIANT HIERARCHYID POINT LINE POLYGON VARBIT".split()
)
_BINARY = set("BYTEA BLOB TINYBLOB MEDIUMBLOB LONGBLOB BINARY VARBINARY BYTES IMAGE ROWVERSION".split())
_OPAQUE = set("JSON JSONB XML VARIANT OBJECT STRUCT RECORD GEOGRAPHY GEOMETRY HSTORE SQL_VARIANT".split())
_TYPE_CONTINUATION = set("PRECISION VARYING UNSIGNED SIGNED ZEROFILL LARGE OBJECT VARCHAR CHARACTER CHAR".split())
_KNOWN_TYPES = _INTEGER | _NUMBER | _BOOLEAN | _DATE | _DATETIME | _STRING | {"NUMBER", "ARRAY"}

# Words that start a column constraint (so they end the type).
_CONSTRAINT_START = set(
    "NOT NULL PRIMARY UNIQUE CHECK DEFAULT REFERENCES CONSTRAINT COLLATE AUTO_INCREMENT AUTOINCREMENT IDENTITY GENERATED COMMENT "
    "ON OPTIONS ENCODE MASKING KEY CLUSTERED NONCLUSTERED ROWGUIDCOL SPARSE FILESTREAM PERSISTED VISIBLE INVISIBLE STORAGE "
    "COMPRESSION COLUMN_FORMAT SRID AS WITH TAG PROJECTION DISTKEY SORTKEY".split()
)
_SILENT_WORDS = set(
    "ASC DESC START INCREMENT BY ORDER NOORDER ALWAYS STORED VIRTUAL DEFERRABLE INITIALLY DEFERRED IMMEDIATE CLUSTERED "
    "NONCLUSTERED ROWGUIDCOL SPARSE PERSISTED VISIBLE INVISIBLE ENFORCED NOVALIDATE RELY NORELY VALIDATE DISABLE ENABLE "
    "DISTKEY SORTKEY FILESTREAM".split()
)
_TABLE_CONSTRAINT_START = {
    "CONSTRAINT",
    "PRIMARY",
    "UNIQUE",
    "FOREIGN",
    "CHECK",
    "KEY",
    "INDEX",
    "FULLTEXT",
    "SPATIAL",
    "EXCLUDE",
    "PERIOD",
    "LIKE",
}


@dataclass
class _Column:
    field: Field
    token: Token
    ref: tuple[str, str | None, Token] | None = None  # (table, column or None → PK, location)


@dataclass
class _Table:
    name: str
    token: Token
    columns: list[_Column] = field(default_factory=list)
    composite_pk: list[str] | None = None

    def column(self, name: str) -> _Column | None:
        low = name.lower()
        return next((c for c in self.columns if c.field.name.lower() == low or (c.field.source_name or "").lower() == low), None)


def _identifier(raw: str) -> str:
    """A canonical identifier for a SQL name; invalid characters become underscores."""
    if IDENTIFIER_RE.match(raw):
        return raw
    name = re.sub(r"[^A-Za-z0-9_]+", "_", raw).strip("_") or "column"
    if name[0].isdigit():
        name = f"c_{name}"
    return name[:120]


class _Parser:
    def __init__(self, tokens: list[Token]):
        self.tokens = tokens
        self.i = 0
        self.tables: dict[str, _Table] = {}
        self.order: list[str] = []
        self.warnings: list[Issue] = []
        self.enum_types: dict[str, list[str]] = {}  # Postgres CREATE TYPE … AS ENUM

    # -- token helpers -------------------------------------------------------
    @property
    def tok(self) -> Token:
        return self.tokens[self.i]

    def peek(self, k: int = 1) -> Token:
        return self.tokens[min(self.i + k, len(self.tokens) - 1)]

    def advance(self) -> Token:
        t = self.tokens[self.i]
        if t.kind != "eof":
            self.i += 1
        return t

    def is_word(self, *words: str) -> bool:
        return self.tok.kind == "word" and self.tok.upper in words

    def is_op(self, op: str) -> bool:
        return self.tok.kind == "op" and self.tok.value == op

    def accept_word(self, *words: str) -> bool:
        if self.is_word(*words):
            self.advance()
            return True
        return False

    def accept_op(self, op: str) -> bool:
        if self.is_op(op):
            self.advance()
            return True
        return False

    def expect_op(self, op: str) -> Token:
        if not self.is_op(op):
            raise self.error(f"expected {op!r} but found {self.describe(self.tok)}")
        return self.advance()

    def expect_word(self, *words: str) -> Token:
        if not self.is_word(*words):
            raise self.error(f"expected {' or '.join(words)} but found {self.describe(self.tok)}")
        return self.advance()

    @staticmethod
    def describe(t: Token) -> str:
        return "end of input" if t.kind == "eof" else repr(t.value)

    def error(self, message: str, t: Token | None = None) -> SchemaValidationError:
        t = t or self.tok
        return _error(t.line, t.col, message)

    def warn(self, t: Token, message: str) -> None:
        self.warnings.append(Issue(path=t.loc, message=message, severity="warning"))

    def name_token(self) -> Token:
        if self.tok.kind in ("word", "qword"):
            return self.advance()
        raise self.error(f"expected a name but found {self.describe(self.tok)}")

    def qualified_name(self) -> tuple[str, Token]:
        """``a.b.c`` → the last part (schema/project prefixes are dropped)."""
        t = self.name_token()
        parts = [t.value]
        while self.is_op("."):
            self.advance()
            parts.append(self.name_token().value)
        last = parts[-1]
        if t.kind == "qword" and "." in last and len(parts) == 1:  # BigQuery `project.dataset.table`
            last = last.split(".")[-1]
        return last, t

    def skip_group(self) -> None:
        """Skip a balanced parenthesized group starting at '('."""
        start = self.expect_op("(")
        depth = 1
        while depth:
            t = self.advance()
            if t.kind == "eof":
                raise self.error("unbalanced parentheses: missing ')'", start)
            if t.kind == "op" and t.value == "(":
                depth += 1
            elif t.kind == "op" and t.value == ")":
                depth -= 1

    def skip_statement(self) -> None:
        depth = 0
        while self.tok.kind != "eof":
            if self.is_op("("):
                depth += 1
            elif self.is_op(")"):
                depth -= 1
            elif self.is_op(";") and depth <= 0:
                self.advance()
                return
            self.advance()

    def name_list(self) -> list[str]:
        self.expect_op("(")
        names = []
        while True:
            names.append(self.name_token().value)
            if self.is_op("("):  # MySQL prefix length: KEY (name(10))
                self.skip_group()
            self.accept_word("ASC", "DESC")
            if not self.accept_op(","):
                break
        self.expect_op(")")
        return names

    # -- statements -----------------------------------------------------------
    def parse(self) -> None:
        while self.tok.kind != "eof":
            if self.accept_op(";") or self.accept_word("GO"):
                continue
            start = self.tok
            if self.is_word("CREATE"):
                save = self.i
                self.advance()
                self.accept_word("OR")
                self.accept_word("REPLACE", "ALTER")
                while self.accept_word(
                    "GLOBAL", "LOCAL", "TEMP", "TEMPORARY", "TRANSIENT", "VOLATILE", "UNLOGGED", "EXTERNAL", "MULTISET", "SET"
                ):
                    pass
                if self.accept_word("TABLE"):
                    self.create_table(start)
                    continue
                if self.accept_word("TYPE"):
                    self.create_type()
                    continue
                if self.is_word("INDEX", "UNIQUE", "SEQUENCE", "SCHEMA", "EXTENSION", "DATABASE", "FUNCTION", "TRIGGER", "PROCEDURE"):
                    self.skip_statement()
                    continue
                self.i = save
            elif self.is_word("ALTER") and self.peek().upper == "TABLE":
                self.alter_table()
                continue
            if self.tok.kind == "word" and self.tok.upper not in ("SET", "USE", "BEGIN", "COMMIT", "DROP", "INSERT", "COMMENT", "GRANT"):
                self.warn(start, f"statement starting with {start.value!r} ignored (only CREATE TABLE is read)")
            self.skip_statement()

    def create_type(self) -> None:
        name, _ = self.qualified_name()
        if self.accept_word("AS") and self.accept_word("ENUM"):
            self.expect_op("(")
            values = []
            while self.tok.kind == "string":
                values.append(self.advance().value)
                if not self.accept_op(","):
                    break
            self.expect_op(")")
            if values:
                self.enum_types[name.lower()] = values
        self.skip_statement()

    def create_table(self, start: Token) -> None:
        if self.accept_word("IF"):
            self.expect_word("NOT")
            self.expect_word("EXISTS")
        raw_name, name_tok = self.qualified_name()
        if self.is_word("AS") or self.is_word("LIKE", "CLONE", "COPY"):
            self.warn(start, f"CREATE TABLE {raw_name} {self.tok.value.upper()} … is not supported and was ignored")
            self.skip_statement()
            return
        name = _identifier(raw_name)
        if name.lower() in self.tables:
            raise self.error(f"table {raw_name!r} is defined twice", name_tok)
        table = _Table(name=name, token=name_tok)
        self.expect_op("(")
        while True:
            if self.is_op(")"):
                raise self.error("expected a column definition")
            if self.tok.kind == "word" and self.tok.upper in _TABLE_CONSTRAINT_START and not self.looks_like_column():
                self.table_constraint(table)
            else:
                self.column_definition(table)
            if self.accept_op(","):
                continue
            self.expect_op(")")
            break
        # Table options (ENGINE=…, WITH (…), PARTITION BY …, OPTIONS(…), ON [PRIMARY]) are ignored.
        self.skip_statement()
        if not table.columns:
            raise self.error(f"table {raw_name!r} has no columns", name_tok)
        self.tables[name.lower()] = table
        self.order.append(name.lower())

    def looks_like_column(self) -> bool:
        """``key VARCHAR(10)`` is a column named key, ``KEY idx (a)`` is a MySQL index."""
        nxt = self.peek()
        if self.tok.upper in ("KEY", "INDEX"):
            return nxt.kind == "word" and nxt.upper in _KNOWN_TYPES
        return False

    def alter_table(self) -> None:
        start = self.advance()  # ALTER
        self.advance()  # TABLE
        self.accept_word("ONLY")
        if self.accept_word("IF"):
            self.expect_word("EXISTS")
        raw_name, name_tok = self.qualified_name()
        table = self.tables.get(_identifier(raw_name).lower())
        if table is None or not self.is_word("ADD"):
            if table is None:
                self.warn(start, f"ALTER TABLE on unknown table {raw_name!r} ignored")
            self.skip_statement()
            return
        self.advance()
        if self.tok.kind == "word" and self.tok.upper in ("CONSTRAINT", "PRIMARY", "UNIQUE", "FOREIGN", "CHECK"):
            self.table_constraint(table)
        else:
            self.warn(start, "only ALTER TABLE … ADD [CONSTRAINT] PRIMARY KEY / UNIQUE / FOREIGN KEY / CHECK is read")
        self.skip_statement()

    # -- columns ---------------------------------------------------------------
    def column_definition(self, table: _Table) -> None:
        name_tok = self.name_token()
        raw = name_tok.value
        name = _identifier(raw)
        if table.column(name) is not None:
            raise self.error(f"duplicate column {raw!r} in table {table.name!r}", name_tok)
        f = Field(name=name, source_name=raw if raw != name else None)
        col = _Column(field=f, token=name_tok)
        self.column_type(f, name_tok)
        self.column_constraints(table, col)
        if f.semantic is None:
            f.semantic = guess_semantic(f.name, f.type)
        col.field = Field.model_validate(f.model_dump())  # re-run normalizers (PK → unique, PII tag)
        table.columns.append(col)

    def type_args(self) -> list[Token]:
        args: list[Token] = []
        self.expect_op("(")
        while not self.is_op(")"):
            if self.tok.kind == "eof":
                raise self.error("unbalanced parentheses in type")
            if self.is_op("("):
                self.skip_group()
                continue
            t = self.advance()
            if t.kind != "op":
                args.append(t)
        self.advance()
        return args

    def column_type(self, f: Field, name_tok: Token) -> None:
        if self.tok.kind == "word" and self.tok.upper in _CONSTRAINT_START - {"KEY", "SET"}:
            # SQLite allows untyped columns.
            self.warn(name_tok, f"column {name_tok.value!r} has no type; using string")
            return
        if self.tok.kind == "op" or self.tok.kind == "eof":
            if self.is_op(",") or self.is_op(")"):
                self.warn(name_tok, f"column {name_tok.value!r} has no type; using string")
                return
            raise self.error(f"expected a column type but found {self.describe(self.tok)}")
        type_tok = self.advance()
        while self.is_op(".") and self.peek().kind in ("word", "qword"):  # schema-qualified type: public.mood
            self.advance()
            type_tok = self.advance()
        words = [type_tok.value.upper()]
        args: list[Token] = []
        generic: list[str] = []
        while True:
            if self.is_op("("):
                args = self.type_args()
                continue
            if self.is_op("<"):
                generic = self.generic_args()
                continue
            if (
                self.tok.kind == "word"
                and self.tok.upper in _TYPE_CONTINUATION
                and not (self.tok.upper == "CHARACTER" and self.peek().upper == "SET")
            ):
                words.append(self.advance().upper)
                continue
            if self.tok.kind == "word" and self.tok.upper in ("WITH", "WITHOUT") and self.peek().upper in ("TIME", "LOCAL"):
                self.advance()
                while self.accept_word("TIME", "LOCAL", "ZONE"):
                    pass
                continue
            break
        is_array = False
        while self.is_op("["):
            self.advance()
            if self.tok.kind == "number":
                self.advance()
            self.expect_op("]")
            is_array = True
        if self.accept_word("ARRAY"):  # SQL-standard ``INTEGER ARRAY``
            is_array = True
        base = words[0]
        if base == "ARRAY":
            is_array = True
            base = generic[0] if generic else "STRING"
            words = [base]
            args = []
        ftype = self.map_type(base, words, args, f, type_tok)
        if is_array:
            if ftype == FieldType.ARRAY:
                ftype = FieldType.STRING
            f.type, f.items_type = FieldType.ARRAY, ftype
            f.max_length = f.min_length = None
            f.enum = None
        else:
            f.type = ftype

    def generic_args(self) -> list[str]:
        """BigQuery ``ARRAY<INT64>`` / ``STRUCT<a INT64>``: returns the top-level type words."""
        self.expect_op("<")
        depth, words = 1, []
        while depth:
            t = self.advance()
            if t.kind == "eof":
                raise self.error("unbalanced '<' in type")
            if t.kind == "op" and t.value == "<":
                depth += 1
            elif t.kind == "op" and t.value == ">":
                depth -= 1
            elif t.kind == "word" and depth == 1:
                words.append(t.value.upper())
        return words

    def map_type(self, base: str, words: list[str], args: list[Token], f: Field, t: Token) -> FieldType:
        nums = [int(a.value) for a in args if a.kind == "number" and a.value.isdigit()]
        if base == "NATIONAL":
            base = "NCHAR"
        if base in ("TINYINT",) and nums == [1]:
            return FieldType.BOOLEAN  # MySQL's conventional boolean
        if base in ("BIT",) and nums and nums[0] > 1:
            self.warn(t, f"BIT({nums[0]}) mapped to string")
            return FieldType.STRING
        if base == "NUMBER":  # Oracle / Snowflake: NUMBER(p, 0) is an integer
            return FieldType.INTEGER if len(nums) == 2 and nums[1] == 0 or len(nums) == 1 else FieldType.NUMBER
        if base in _NUMBER:
            return FieldType.NUMBER
        if base in _INTEGER:
            if "UNSIGNED" in words and f.minimum is None:
                f.minimum = 0
            if base in ("SERIAL", "BIGSERIAL", "SMALLSERIAL", "SERIAL4", "SERIAL8") and f.minimum is None:
                f.minimum = 1
            return FieldType.INTEGER
        if base in _BOOLEAN:
            return FieldType.BOOLEAN
        if base in _DATE:
            return FieldType.DATE
        if base in _DATETIME:
            return FieldType.DATETIME
        if base in ("ENUM", "SET"):
            values = [a.value for a in args if a.kind == "string"]
            if base == "ENUM" and values:
                f.enum = values
            elif base == "SET":
                self.warn(t, "SET type mapped to string")
            return FieldType.STRING
        if base in _STRING:
            if base in ("UUID", "UNIQUEIDENTIFIER"):
                f.semantic = Semantic.UUID
            elif base in ("INET",):
                f.semantic = Semantic.IP_ADDRESS
            if base in _BINARY:
                self.warn(t, f"binary type {base} mapped to string")
            elif base in _OPAQUE:
                self.warn(t, f"{base} values are kept as JSON/text strings")
            elif base in ("TIME", "TIMETZ"):
                f.pattern = f.pattern or r"^\d{2}:\d{2}:\d{2}$"
            if nums and base in (
                "CHAR",
                "CHARACTER",
                "VARCHAR",
                "VARCHAR2",
                "NVARCHAR",
                "NVARCHAR2",
                "NCHAR",
                "STRING",
                "BINARY",
                "VARBINARY",
            ):
                f.max_length = nums[0]
                if base in ("CHAR", "CHARACTER", "NCHAR") and "VARYING" not in words and nums[0] <= 10:
                    f.min_length = nums[0]
            return FieldType.STRING
        if base.lower() in self.enum_types:  # CREATE TYPE … AS ENUM
            f.enum = list(self.enum_types[base.lower()])
            return FieldType.STRING
        self.warn(t, f"unknown type {base!r}; using string")
        return FieldType.STRING

    def column_constraints(self, table: _Table, col: _Column) -> None:
        f = col.field
        while not (self.is_op(",") or self.is_op(")") or self.tok.kind == "eof"):
            t = self.tok
            if self.accept_word("CONSTRAINT"):
                self.name_token()
            elif self.accept_word("NOT"):
                if self.accept_word("NULL"):
                    f.nullable = False
                elif self.accept_word("DEFERRABLE", "ENFORCED"):
                    pass
                else:
                    raise self.error("expected NULL after NOT")
            elif self.accept_word("NULL"):
                f.nullable = True
            elif self.accept_word("PRIMARY"):
                self.expect_word("KEY")
                f.primary_key, f.nullable, f.unique = True, False, True
            elif self.accept_word("UNIQUE"):
                self.accept_word("KEY")
                f.unique = True
            elif self.accept_word("KEY"):  # MySQL: ``id INT KEY``
                f.primary_key, f.nullable, f.unique = True, False, True
            elif self.accept_word("CHECK"):
                self.check_constraint(table, default_column=col, start=t)
            elif self.accept_word("DEFAULT"):
                self.skip_expression()
            elif self.accept_word("REFERENCES"):
                ref_name, _ = self.qualified_name()
                ref_col = None
                if self.is_op("("):
                    cols = self.name_list()
                    ref_col = cols[0]
                    if len(cols) > 1:
                        self.warn(t, "multi-column REFERENCES ignored")
                        ref_name = ""
                self.referential_actions()
                if ref_name:
                    col.ref = (ref_name, ref_col, t)
            elif self.accept_word("COLLATE", "ENCODE", "SRID", "COLUMN_FORMAT", "STORAGE", "COMPRESSION"):
                self.advance()
            elif self.accept_word("COMMENT"):
                if self.tok.kind == "string":
                    f.description = self.advance().value
            elif self.accept_word("OPTIONS"):
                self.bigquery_options(f)
            elif self.accept_word("AUTO_INCREMENT", "AUTOINCREMENT", "IDENTITY"):
                if self.is_op("("):
                    self.skip_group()
            elif self.accept_word("GENERATED"):
                while self.accept_word("ALWAYS", "BY", "DEFAULT", "ON", "NULL"):
                    pass
                self.expect_word("AS")
                if self.accept_word("IDENTITY"):
                    if self.is_op("("):
                        self.skip_group()
                elif self.is_op("("):
                    self.skip_group()
                    self.warn(t, f"generated column {f.name!r}: expression ignored")
            elif self.accept_word("AS"):  # SQL Server / MySQL computed columns
                if self.is_op("("):
                    self.skip_group()
                self.warn(t, f"computed column {f.name!r}: expression ignored")
            elif self.accept_word("ON"):  # MySQL ON UPDATE CURRENT_TIMESTAMP
                self.accept_word("UPDATE", "DELETE")
                self.skip_expression()
            elif self.is_word("CHARACTER") and self.peek().upper == "SET" or self.is_word("CHARSET"):
                if self.accept_word("CHARACTER"):
                    self.advance()
                else:
                    self.advance()
                self.advance()
            elif self.accept_word("MASKING", "WITH", "TAG", "PROJECTION"):
                while self.tok.kind == "word" and self.tok.upper in ("POLICY", "TAG", "MASKING", "PROJECTION"):
                    self.advance()
                if self.is_op("("):
                    self.skip_group()
                elif self.tok.kind in ("word", "qword"):
                    self.qualified_name()
                    if self.is_op("("):
                        self.skip_group()
            elif self.tok.kind == "word" and self.tok.upper in _SILENT_WORDS:
                self.advance()
                if self.is_op("("):
                    self.skip_group()
            elif self.tok.kind == "number" and self.tokens[self.i - 1].upper in ("START", "INCREMENT", "BY", "WITH"):
                self.advance()
            else:
                self.warn(t, f"column option {t.value!r} ignored")
                self.advance()
                if self.is_op("("):
                    self.skip_group()

    def bigquery_options(self, f: Field) -> None:
        self.expect_op("(")
        while not self.is_op(")"):
            if self.tok.kind == "eof":
                raise self.error("unbalanced parentheses in OPTIONS")
            key = self.advance()
            if key.upper == "DESCRIPTION" and self.accept_op("=") and self.tok.kind in ("string", "qword"):
                f.description = self.advance().value
            elif self.is_op("("):
                self.skip_group()
        self.advance()

    def referential_actions(self) -> None:
        while True:
            if self.accept_word("ON"):
                self.expect_word("DELETE", "UPDATE")
                if self.accept_word("SET"):
                    self.expect_word("NULL", "DEFAULT")
                elif self.accept_word("NO"):
                    self.expect_word("ACTION")
                else:
                    self.expect_word("CASCADE", "RESTRICT")
            elif self.accept_word("MATCH"):
                self.advance()
            elif self.accept_word("DEFERRABLE", "INITIALLY", "DEFERRED", "IMMEDIATE", "ENFORCED", "RELY", "NORELY"):
                pass
            elif self.is_word("NOT") and self.peek().upper in ("DEFERRABLE", "ENFORCED", "FOR"):
                self.advance()
                self.advance()
            else:
                return

    def skip_expression(self) -> None:
        """Skip a DEFAULT / ON UPDATE value: one term plus casts, calls and operators."""
        first = True
        while not (self.is_op(",") or self.is_op(")") or self.tok.kind == "eof"):
            if self.is_op("("):
                self.skip_group()
            elif not first and self.tok.kind == "word" and self.tok.upper in _CONSTRAINT_START and self.tok.upper not in ("WITH",):
                return
            else:
                self.advance()
            first = False

    # -- table constraints ---------------------------------------------------------
    def table_constraint(self, table: _Table) -> None:
        start = self.tok
        if self.accept_word("CONSTRAINT"):
            self.name_token()
        if self.accept_word("PRIMARY"):
            self.expect_word("KEY")
            self.accept_word("CLUSTERED", "NONCLUSTERED")
            cols = self.name_list()
            self.index_options()
            self.primary_key(table, cols, start)
        elif self.accept_word("UNIQUE"):
            self.accept_word("KEY", "INDEX")
            self.accept_word("CLUSTERED", "NONCLUSTERED")
            if self.tok.kind in ("word", "qword") and not self.is_op("("):
                self.advance()  # MySQL index name
            cols = self.name_list()
            self.index_options()
            if len(cols) == 1:
                c = self.require_column(table, cols[0], start)
                c.field = c.field.model_copy(update={"unique": True})
            else:
                self.warn(start, f"multi-column UNIQUE ({', '.join(cols)}) is not represented in the canonical schema")
        elif self.accept_word("FOREIGN"):
            self.expect_word("KEY")
            if self.tok.kind in ("word", "qword"):
                self.advance()  # MySQL index name
            cols = self.name_list()
            self.expect_word("REFERENCES")
            ref_name, _ = self.qualified_name()
            ref_cols = self.name_list() if self.is_op("(") else [None]
            self.referential_actions()
            if len(cols) != 1 or len(ref_cols) != 1:
                self.warn(start, "multi-column FOREIGN KEY is not supported and was ignored")
                return
            c = self.require_column(table, cols[0], start)
            c.ref = (ref_name, ref_cols[0], start)
        elif self.accept_word("CHECK"):
            self.check_constraint(table, default_column=None, start=start)
        elif self.accept_word("KEY", "INDEX", "FULLTEXT", "SPATIAL"):
            self.accept_word("KEY", "INDEX")
            while not (self.is_op(",") or self.is_op(")") or self.tok.kind == "eof"):
                if self.is_op("("):
                    self.skip_group()
                else:
                    self.advance()
        else:
            self.warn(start, f"table constraint {start.value!r} ignored")
            while not (self.is_op(",") or self.is_op(")") or self.tok.kind == "eof"):
                if self.is_op("("):
                    self.skip_group()
                else:
                    self.advance()

    def index_options(self) -> None:
        while self.tok.kind == "word" and self.tok.upper in ("USING", "WITH", "COMMENT", "NOT", "ENFORCED", "RELY", "NORELY", "ON"):
            self.advance()
            if self.is_op("("):
                self.skip_group()
            elif self.tok.kind in ("word", "string", "qword") and self.tok.upper not in _TABLE_CONSTRAINT_START:
                self.advance()

    def require_column(self, table: _Table, name: str, at: Token) -> _Column:
        c = table.column(name)
        if c is None:
            raise self.error(f"unknown column {name!r} in table {table.name!r}", at)
        return c

    def primary_key(self, table: _Table, cols: list[str], at: Token) -> None:
        if len(cols) == 1:
            c = self.require_column(table, cols[0], at)
            c.field = c.field.model_copy(update={"primary_key": True, "unique": True, "nullable": False})
            return
        table.composite_pk = cols
        for name in cols:
            c = self.require_column(table, name, at)
            c.field = c.field.model_copy(update={"nullable": False})
        self.warn(at, f"composite primary key ({', '.join(cols)}) is not supported; columns kept as NOT NULL without a key")

    # -- CHECK constraints ------------------------------------------------------
    def check_constraint(self, table: _Table, default_column: _Column | None, start: Token) -> None:
        self.expect_op("(")
        begin = self.i
        try:
            expr = self.check_or()
            self.expect_op(")")
        except SchemaValidationError:
            # Not in the supported expression subset: skip it, but keep parsing the DDL.
            self.i = begin - 1
            self.skip_group()
            self.warn(start, "CHECK constraint is not in the supported subset and was ignored")
            return
        while self.accept_word("NOT", "ENFORCED", "NO", "INHERIT", "VALID"):
            pass
        conjuncts = expr[1] if expr[0] == "and" else [expr]
        for node in conjuncts:
            if not self.apply_check(table, default_column, node):
                self.warn(start, "part of a CHECK constraint could not be mapped to min/max/enum/length and was ignored")

    def apply_check(self, table: _Table, default_column: _Column | None, node: tuple) -> bool:
        kind = node[0]

        def column_of(operand: tuple) -> _Column | None:
            if operand[0] != "col":
                return None
            c = table.column(operand[1])
            if c is None and default_column is not None and operand[1].lower() == default_column.field.name.lower():
                c = default_column
            return c

        def update(c: _Column, **kw: Any) -> None:
            if c is default_column:  # inline CHECK: the column isn't in the table yet, edit it in place
                for k, v in kw.items():
                    setattr(c.field, k, v)
            else:
                c.field = c.field.model_copy(update=kw)

        if kind == "cmp":
            _, left, op, right = node
            length_col = None
            if left[0] == "func" and left[1] in ("LENGTH", "CHAR_LENGTH", "CHARACTER_LENGTH", "LEN") and len(left[2]) == 1:
                length_col = column_of(left[2][0])
            if length_col is not None and right[0] == "lit" and isinstance(right[1], int | float):
                n = int(right[1])
                bounds = {">=": ("min_length", n), ">": ("min_length", n + 1), "<=": ("max_length", n), "<": ("max_length", n - 1)}
                if op in ("=", "=="):
                    update(length_col, min_length=n, max_length=n)
                    return True
                if op in bounds:
                    update(length_col, **{bounds[op][0]: bounds[op][1]})
                    return True
                return False
            flipped = {">": "<", ">=": "<=", "<": ">", "<=": ">="}
            if left[0] == "lit" and right[0] == "col":
                left, right, op = right, left, flipped.get(op, op)
            c = column_of(left)
            if c is None or right[0] != "lit":
                return False
            value = right[1]
            if op in ("=", "==") and value is not None:
                update(c, enum=[value])
                return True
            if op in ("<>", "!=") or not isinstance(value, int | float) or isinstance(value, bool):
                return op in ("<>", "!=")  # "<> x" can't be expressed but isn't worth a warning
            step = 1 if c.field.type == FieldType.INTEGER else 0
            if op == ">=":
                update(c, minimum=_max(c.field.minimum, value))
            elif op == ">":
                update(c, minimum=_max(c.field.minimum, value + step))
            elif op == "<=":
                update(c, maximum=_min(c.field.maximum, value))
            elif op == "<":
                update(c, maximum=_min(c.field.maximum, value - step))
            else:
                return False
            return True
        if kind == "between":
            _, operand, lo, hi, negated = node
            c = column_of(operand)
            if c is None or negated or lo[0] != "lit" or hi[0] != "lit":
                return False
            update(c, minimum=_max(c.field.minimum, lo[1]), maximum=_min(c.field.maximum, hi[1]))
            return True
        if kind == "in":
            _, operand, values, negated = node
            c = column_of(operand)
            if c is None or negated or not all(v[0] == "lit" for v in values):
                return False
            update(c, enum=[v[1] for v in values])
            return True
        if kind == "isnull":
            _, operand, negated = node
            c = column_of(operand)
            if c is None or not negated:
                return False
            update(c, nullable=False)
            return True
        if kind == "or":
            # ``a = 'x' OR a = 'y'`` → enum
            values, target = [], None
            for part in node[1]:
                if part[0] == "cmp" and part[2] in ("=", "==") and part[1][0] == "col" and part[3][0] == "lit":
                    name, value = part[1][1], part[3][1]
                elif part[0] == "in" and part[1][0] == "col" and not part[3] and all(v[0] == "lit" for v in part[2]):
                    name, value = part[1][1], None
                    values.extend(v[1] for v in part[2])
                else:
                    return False
                if target not in (None, name.lower()):
                    return False
                target = name.lower()
                if value is not None:
                    values.append(value)
            c = column_of(("col", target or ""))
            if c is None:
                return False
            update(c, enum=values)
            return True
        return False

    # Expression parser for the CHECK subset. Nodes are tuples:
    #   ("and"|"or", [nodes]) · ("not", node) · ("cmp", l, op, r) · ("between", x, lo, hi, negated)
    #   ("in", x, [operands], negated) · ("isnull", x, negated) · ("col", name) · ("lit", value) · ("func", NAME, [args])
    def check_or(self) -> tuple:
        parts = [self.check_and()]
        while self.accept_word("OR"):
            parts.append(self.check_and())
        return parts[0] if len(parts) == 1 else ("or", parts)

    def check_and(self) -> tuple:
        parts = [self.check_predicate()]
        while self.accept_word("AND"):
            parts.append(self.check_predicate())
        flat: list[tuple] = []
        for p in parts:
            flat.extend(p[1] if p[0] == "and" else [p])
        return flat[0] if len(flat) == 1 else ("and", flat)

    def check_predicate(self) -> tuple:
        if self.accept_word("NOT"):
            return ("not", self.check_predicate())
        left = self.check_operand()
        if left[0] in ("and", "or", "not", "cmp", "between", "in", "isnull"):
            return left
        negated = self.accept_word("NOT")
        if self.accept_word("BETWEEN"):
            lo = self.check_operand()
            self.expect_word("AND")
            hi = self.check_operand()
            return ("between", left, lo, hi, negated)
        if self.accept_word("IN"):
            self.expect_op("(")
            values = [self.check_operand()]
            while self.accept_op(","):
                values.append(self.check_operand())
            self.expect_op(")")
            return ("in", left, values, negated)
        if self.accept_word("IS"):
            neg = self.accept_word("NOT")
            self.expect_word("NULL")
            return ("isnull", left, neg)
        if self.accept_word("LIKE", "ILIKE", "GLOB", "REGEXP", "RLIKE", "SIMILAR"):
            self.accept_word("TO")
            self.check_operand()
            return ("other",)
        if negated:
            raise self.error("unsupported NOT expression in CHECK")
        if self.tok.kind == "op" and self.tok.value in ("=", "==", "<>", "!=", "<", "<=", ">", ">=", "~"):
            op = self.advance().value
            if op == "~":
                self.check_operand()
                return ("other",)
            if self.accept_word("ANY", "SOME"):
                # Postgres dumps: col = ANY (ARRAY['a', 'b'])
                self.expect_op("(")
                values = self.array_literal()
                self.expect_op(")")
                self.skip_casts()
                return ("in", left, values, False) if op in ("=", "==") else ("other",)
            return ("cmp", left, op, self.check_operand())
        return left

    def array_literal(self) -> list[tuple]:
        if self.accept_op("("):
            values = self.array_literal()
            self.expect_op(")")
            self.skip_casts()
            return values
        self.expect_word("ARRAY")
        self.expect_op("[")
        values = [self.check_operand()]
        while self.accept_op(","):
            values.append(self.check_operand())
        self.expect_op("]")
        self.skip_casts()
        return values

    def skip_casts(self) -> None:
        while self.accept_op("::"):
            self.advance()
            while self.tok.kind == "word" and self.tok.upper in _TYPE_CONTINUATION | {"VARYING", "PRECISION"}:
                self.advance()
            if self.is_op("("):
                self.skip_group()
            while self.is_op("["):
                self.advance()
                self.expect_op("]")

    def check_operand(self) -> tuple:
        t = self.tok
        sign = 1
        if self.is_op("-") or self.is_op("+"):
            sign = -1 if self.advance().value == "-" else 1
        if self.tok.kind == "number":
            raw = self.advance().value
            value: Any = float(raw) if any(ch in raw for ch in ".eE") else int(raw)
            node: tuple = ("lit", sign * value)
        elif sign == -1:
            raise self.error("unsupported unary minus in CHECK", t)
        elif self.tok.kind == "string":
            node = ("lit", self.advance().value)
        elif self.accept_op("("):
            inner = self.check_or()
            self.expect_op(")")
            node = inner
        elif self.tok.kind in ("word", "qword"):
            word = self.advance()
            if word.kind == "word" and word.upper in ("TRUE", "FALSE"):
                node = ("lit", word.upper == "TRUE")
            elif word.kind == "word" and word.upper == "NULL":
                node = ("lit", None)
            elif self.is_op("("):
                self.advance()
                args = []
                if not self.is_op(")"):
                    args.append(self.check_operand())
                    while self.accept_op(","):
                        args.append(self.check_operand())
                self.expect_op(")")
                node = ("func", word.value.upper(), args)
            else:
                name = word.value
                while self.accept_op("."):  # table.column
                    name = self.name_token().value
                node = ("col", name)
        else:
            raise self.error(f"unexpected {self.describe(self.tok)} in CHECK")
        self.skip_casts()
        if self.tok.kind == "op" and self.tok.value in ("+", "-", "*", "/", "%", "||"):
            raise self.error("arithmetic in CHECK is not supported")
        return node


def _max(a: float | None, b: float) -> float:
    return b if a is None else max(a, b)


def _min(a: float | None, b: float) -> float:
    return b if a is None else min(a, b)


def parse_sql_ddl(source: str) -> tuple[Schema, list[Issue]]:
    """Parse ``CREATE TABLE`` statements. Returns (schema, warnings); raises SchemaValidationError on errors."""
    if len(source) > MAX_DDL_CHARS:
        raise SchemaValidationError([Issue(path="1:1", message="DDL is too large")])
    parser = _Parser(tokenize(source))
    parser.parse()
    if not parser.tables:
        raise SchemaValidationError([Issue(path="1:1", message="no CREATE TABLE statement found")])
    tables = [parser.tables[k] for k in parser.order]

    # Resolve foreign keys once every table is known.
    for table in tables:
        for col in table.columns:
            if col.ref is None:
                continue
            ref_table_name, ref_col_name, at = col.ref
            target = parser.tables.get(_identifier(ref_table_name).lower())
            if target is None:
                parser.warn(at, f"{table.name}.{col.field.name} references unknown table {ref_table_name!r}; relationship ignored")
                continue
            if ref_col_name is None:
                pk = next((c for c in target.columns if c.field.primary_key), None)
                if pk is None:
                    parser.warn(at, f"{table.name}.{col.field.name}: {target.name} has no single-column primary key; relationship ignored")
                    continue
                ref = pk
            else:
                ref = target.column(ref_col_name)
                if ref is None:
                    raise _error(at.line, at.col, f"{table.name}.{col.field.name} references unknown column {target.name}.{ref_col_name}")
            if not (ref.field.primary_key or ref.field.unique):
                parser.warn(at, f"{target.name}.{ref.field.name} is not a primary key or unique column; relationship ignored")
                continue
            col.field = col.field.model_copy(update={"references": ForeignKey(entity=target.name, field=ref.field.name)})

    entities = [Entity(name=t.name, fields=[c.field for c in t.columns]) for t in tables]
    schema = Schema(name="sql_schema", entities=entities)
    try:
        schema.topological_order()
    except SchemaValidationError:
        # Mutual references (a ↔ b) can't be generated in order; keep the schema but drop the back-edges.
        _break_cycles(schema, parser)
    return schema, parser.warnings + ensure_valid(schema)


def _break_cycles(schema: Schema, parser: _Parser) -> None:
    seen: set[str] = set()
    for entity in schema.entities:
        for i, f in enumerate(entity.fields):
            if f.references and f.references.entity != entity.name and f.references.entity not in seen:
                trial = f.references
                entity.fields[i] = f.model_copy(update={"references": None})
                try:
                    schema.topological_order()
                    parser.warnings.append(
                        Issue(
                            path=f"/entities/{entity.name}/{f.name}",
                            message=f"circular reference {entity.name}.{f.name} → {trial.entity} dropped",
                            severity="warning",
                        )
                    )
                    return
                except SchemaValidationError:
                    entity.fields[i] = f
        seen.add(entity.name)
