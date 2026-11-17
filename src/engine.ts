/**
 * The page's SQL grammar, borrowed from sqlriver.
 *
 * Layout is policy and belongs to sqlriver: it parses the buffer into an AST
 * and re-emits it under the SQL Style Guide — keywords upper-cased, clauses
 * right-aligned into a river, four-space indentation. The page keeps only what
 * a clip viewer needs around that: a recovery-mode scan that reports the
 * problems it found while leaving unparseable statements verbatim, and the
 * mapping from the picker's seven dialects to sqlriver's four grammar
 * profiles.
 *
 * The picker keeps its own vocabulary (dialect.ts) for painting. sqlriver's
 * tokenizer knows keywords and identifiers, not types, literals and functions,
 * and it has no profile for SQLite, Oracle or BigQuery; those three are laid
 * out with the ANSI or PostgreSQL profile, which the reference parser already
 * covers for their common constructs.
 *
 * Nothing here executes SQL or leaves the frame.
 */

import {
  formatStatements,
  parse,
  ParseError,
  TokenizeError,
  type Node,
} from "sqlriver";

import type { Dialect } from "./dialect";

/** The four grammar shapes sqlriver models. */
export type GrammarProfile = "ansi" | "postgres" | "mysql" | "tsql";

/** The picker's dialect, mapped to the grammar that lays it out. */
const GRAMMAR: Readonly<Record<Dialect, GrammarProfile>> = {
  ansi: "ansi",
  postgresql: "postgres",
  mysql: "mysql",
  sqlite: "ansi",
  tsql: "tsql",
  plsql: "ansi",
  bigquery: "ansi",
};

export function grammarFor(dialect: Dialect): GrammarProfile {
  return GRAMMAR[dialect] ?? "ansi";
}

/** One finding, positioned the way the gutter and the problems rail read it. */
export interface SqlProblem {
  /** One-based line of the offending token. */
  readonly line: number;
  /** One-based column, counted in characters. */
  readonly column: number;
  /** Characters to underline; at least one. */
  readonly length: number;
  readonly message: string;
}

export interface SqlScan {
  readonly problems: readonly SqlProblem[];
  /**
   * Statements the grammar does not model (client commands, unmodelled DDL
   * families). They are not errors — they stay exactly as written — so this is
   * a count, not a finding.
   */
  readonly unsupported: number;
  /** The parsed statements, or null when the buffer could not be tokenized. */
  readonly nodes: readonly Node[] | null;
}

export interface SqlFormat extends SqlScan {
  /** The laid-out SQL, or the input unchanged when nothing could be parsed. */
  readonly text: string;
}

/** A findings rail longer than this stops being useful. */
const MAX_PROBLEMS = 50;

/**
 * sqlriver speaks English; the page speaks Chinese. The few messages worth
 * translating are the ones a reader can act on, and everything else is passed
 * through so a parser detail is never hidden behind a bad guess.
 */
function describe(message: string): string {
  const expected = /^Expected (.+), got (.+)$/u.exec(message);
  if (expected !== null) return `此处应为 ${expected[1]}，实际是 ${expected[2]}`;
  if (message.startsWith("Unterminated string literal")) return "字符串字面量没有结束";
  if (message.startsWith("Unterminated block comment")) return "块注释没有结束";
  if (message.startsWith("Unterminated quoted identifier")) return "带引号的名称没有结束";
  if (message.startsWith("Maximum nesting depth")) return "嵌套层数超过解析上限";
  return message;
}

function problemFromThrown(error: unknown): SqlProblem {
  if (error instanceof ParseError) {
    return {
      line: error.line,
      column: error.column,
      length: Math.max(1, error.token.value.length),
      message: describe(error.message),
    };
  }
  if (error instanceof TokenizeError) {
    return {
      line: error.line,
      column: error.column,
      length: 1,
      message: describe(error.message),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { line: 1, column: 1, length: 1, message: describe(message) };
}

/**
 * Parse the buffer in recovery mode.
 *
 * Recovery is what makes the page usable while the user is halfway through a
 * statement: a statement that fails is returned as its own raw text instead of
 * aborting the scan, and the callback reports why. A buffer that cannot even be
 * tokenized (an unterminated string, say) yields one finding and no nodes.
 */
export function scanSql(text: string, dialect: Dialect): SqlScan {
  if (text.trim() === "") return { problems: [], unsupported: 0, nodes: [] };
  const problems: SqlProblem[] = [];
  let nodes: Node[];
  try {
    nodes = parse(text, {
      dialect: grammarFor(dialect),
      recover: true,
      onRecover: (error) => {
        if (problems.length < MAX_PROBLEMS) problems.push(problemFromThrown(error));
      },
    });
  } catch (error) {
    return { problems: [problemFromThrown(error)], unsupported: 0, nodes: null };
  }
  let unsupported = 0;
  for (const node of nodes) {
    if (node.type === "raw" && (node.reason === "unsupported" || node.reason === "verbatim")) {
      unsupported += 1;
    }
  }
  problems.sort((left, right) => left.line - right.line || left.column - right.column);
  return { problems, unsupported, nodes };
}

/**
 * Lay the buffer out under the style guide.
 *
 * Formatting never throws: a buffer the tokenizer rejects, or one the
 * formatter itself cannot finish, comes back unchanged together with its
 * findings so the page can say what happened instead of replacing text with a
 * half-formatted guess.
 */
export function formatSql(text: string, dialect: Dialect, maxLineLength: number): SqlFormat {
  if (text.trim() === "") return { text, problems: [], unsupported: 0, nodes: [] };
  const scan = scanSql(text, dialect);
  if (scan.nodes === null) return { ...scan, text };
  try {
    const formatted = formatStatements([...scan.nodes], {
      dialect: grammarFor(dialect),
      maxLineLength,
    });
    return { ...scan, text: formatted };
  } catch (error) {
    return {
      ...scan,
      text,
      problems: [...scan.problems, problemFromThrown(error)],
    };
  }
}
