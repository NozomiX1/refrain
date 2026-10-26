// Storage (design.md chapter 5): append-only rows; undoing a run only marks its rows void.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Entry } from "./transcript.ts";

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE projects (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY, cc_session_id TEXT NOT NULL UNIQUE, project_id INTEGER REFERENCES projects(id),
  transcript_path TEXT NOT NULL, parent_session_id INTEGER REFERENCES sessions(id),
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
CREATE TABLE runs (
  id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id),
  started_at TEXT NOT NULL, finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'undone')),
  bookmark_before TEXT, bookmark_after TEXT, model TEXT, usage TEXT, request TEXT, response TEXT, error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE entries (
  id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id),
  turn_no INTEGER NOT NULL, entry_no INTEGER NOT NULL, cc_uuid TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'observation')),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'tool_use', 'tool_result')),
  tool_name TEXT, is_error INTEGER NOT NULL DEFAULT 0, raw_chars INTEGER NOT NULL, text TEXT NOT NULL, ts TEXT NOT NULL,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'abandoned', 'void')),
  UNIQUE (session_id, turn_no, entry_no));
-- After a rewind the same transcript rows are processed again; only one live copy may exist.
CREATE UNIQUE INDEX entries_live_uuid ON entries (cc_uuid) WHERE status = 'active';
CREATE TABLE knowledge (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, origin_project_id INTEGER REFERENCES projects(id),
  created_run_id INTEGER NOT NULL REFERENCES runs(id));
CREATE TABLE knowledge_versions (
  id INTEGER PRIMARY KEY, knowledge_id INTEGER NOT NULL REFERENCES knowledge(id), version_no INTEGER NOT NULL,
  parent_version_id INTEGER REFERENCES knowledge_versions(id),
  op TEXT NOT NULL CHECK (op IN ('create', 'update', 'archive')),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project')), project_id INTEGER REFERENCES projects(id),
  body TEXT NOT NULL, epistemic TEXT NOT NULL CHECK (epistemic IN ('quote', 'inference', 'observed')),
  pending INTEGER NOT NULL DEFAULT 0, about_me INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL CHECK (category IN ('rule', 'understanding', 'goal', 'reference')),
  as_of TEXT NOT NULL, reason TEXT, refs TEXT NOT NULL, tokens INTEGER NOT NULL,
  run_id INTEGER NOT NULL REFERENCES runs(id), void INTEGER NOT NULL DEFAULT 0,
  UNIQUE (knowledge_id, version_no),
  CHECK (scope = 'global' OR project_id IS NOT NULL));
CREATE TABLE summaries (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, session_id INTEGER NOT NULL REFERENCES sessions(id),
  project_id INTEGER REFERENCES projects(id), title TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', body TEXT NOT NULL,
  refs TEXT NOT NULL, first_entry_id INTEGER REFERENCES entries(id), last_entry_id INTEGER REFERENCES entries(id),
  tokens INTEGER NOT NULL, run_id INTEGER NOT NULL REFERENCES runs(id), void INTEGER NOT NULL DEFAULT 0);
CREATE TABLE states (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('project', 'session')),
  project_id INTEGER REFERENCES projects(id), session_id INTEGER REFERENCES sessions(id),
  items TEXT NOT NULL, closed TEXT NOT NULL DEFAULT '[]',
  run_id INTEGER NOT NULL REFERENCES runs(id), void INTEGER NOT NULL DEFAULT 0,
  CHECK ((kind = 'project' AND project_id IS NOT NULL) OR (kind = 'session' AND session_id IS NOT NULL)));
CREATE VIRTUAL TABLE entries_fts USING fts5(text, content = 'entries', content_rowid = 'id', tokenize = 'trigram');
CREATE TRIGGER entries_fts_insert AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE VIRTUAL TABLE summaries_fts USING fts5(title, tags, body, content = 'summaries', content_rowid = 'id', tokenize = 'trigram');
CREATE TRIGGER summaries_fts_insert AFTER INSERT ON summaries BEGIN
  INSERT INTO summaries_fts (rowid, title, tags, body) VALUES (new.id, new.title, new.tags, new.body);
END;
`;

export const now = () => new Date().toISOString();

// Joins an enclosing transaction instead of nesting one (SQLite has no nested BEGIN).
export function tx<T>(db: DatabaseSync, fn: () => T, mode = ""): T {
  if (db.isTransaction) return fn();
  db.exec(`BEGIN ${mode}`);
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'meta'").get();
  if (!hasMeta)
    tx(db, () => {
      db.exec(SCHEMA);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    });
  const v = Number((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
  if (v !== SCHEMA_VERSION) throw new Error(`memory.db schema ${v}, this refrain expects ${SCHEMA_VERSION}`);
  return db;
}

export function ensureProject(db: DatabaseSync, path: string): number {
  db.prepare("INSERT INTO projects (path, created_at) VALUES (?, ?) ON CONFLICT (path) DO NOTHING").run(path, now());
  return (db.prepare("SELECT id FROM projects WHERE path = ?").get(path) as { id: number }).id;
}

export function ensureSession(db: DatabaseSync, ccSessionId: string, projectId: number | null, transcriptPath: string): number {
  const t = now();
  db.prepare(`INSERT INTO sessions (cc_session_id, project_id, transcript_path, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (cc_session_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, transcript_path = excluded.transcript_path`)
    .run(ccSessionId, projectId, transcriptPath, t, t);
  return (db.prepare("SELECT id FROM sessions WHERE cc_session_id = ?").get(ccSessionId) as { id: number }).id;
}

// The bookmark is derived, not stored: the end of the session's latest succeeded run (design.md 5.1).
export function bookmark(db: DatabaseSync, sessionId: number): string | null {
  const r = db.prepare("SELECT bookmark_after FROM runs WHERE session_id = ? AND status = 'succeeded' ORDER BY id DESC LIMIT 1").get(sessionId) as
    | { bookmark_after: string | null }
    | undefined;
  return r?.bookmark_after ?? null;
}

export function undoRun(db: DatabaseSync, runId: number): void {
  tx(db, () => {
    db.prepare("UPDATE runs SET status = 'undone' WHERE id = ?").run(runId);
    db.prepare("UPDATE entries SET status = 'void' WHERE run_id = ?").run(runId);
    for (const t of ["knowledge_versions", "summaries", "states"]) db.prepare(`UPDATE ${t} SET void = 1 WHERE run_id = ?`).run(runId);
  });
}

export type Numbered = Entry & { turnNo: number; entryNo: number };

// What the next scribe run must process: entries after the bookmark, numbered as they will be stored.
// If the user rewound past the bookmark, undo runs until it is back on the live path (design.md 6.4).
export function pending(db: DatabaseSync, sessionId: number, entries: Entry[]): { undone: number[]; entries: Numbered[] } {
  const undone: number[] = [];
  const index = new Map(entries.map((e, i) => [e.uuid, i]));
  let mark = bookmark(db, sessionId);
  while (mark && !index.has(mark)) {
    const run = db.prepare("SELECT id FROM runs WHERE session_id = ? AND status = 'succeeded' ORDER BY id DESC LIMIT 1").get(sessionId) as { id: number };
    undoRun(db, run.id);
    undone.push(run.id);
    mark = bookmark(db, sessionId);
  }
  const rest = entries.slice(mark ? index.get(mark)! + 1 : 0);
  // Numbers are never reused, void rows included (design.md 6.3).
  const maxTurn = (db.prepare("SELECT MAX(turn_no) AS t FROM entries WHERE session_id = ?").get(sessionId) as { t: number | null }).t;
  const markRow = mark ? (db.prepare("SELECT turn_no FROM entries WHERE cc_uuid = ? AND status = 'active'").get(mark) as { turn_no: number }) : undefined;
  let turn = markRow?.turn_no ?? 0;
  let next = maxTurn ?? 0;
  const maxEntry = (t: number) =>
    (db.prepare("SELECT MAX(entry_no) AS e FROM entries WHERE session_id = ? AND turn_no = ?").get(sessionId, t) as { e: number | null }).e ?? 0;
  let entryNo = maxEntry(turn);
  const out: Numbered[] = [];
  for (const e of rest) {
    if (e.newTurn) {
      turn = ++next;
      entryNo = 0;
    }
    out.push({ ...e, turnNo: turn, entryNo: ++entryNo });
  }
  return { undone, entries: out };
}

export function startRun(db: DatabaseSync, sessionId: number, bookmarkBefore: string | null, model?: string): number {
  const r = db.prepare("INSERT INTO runs (session_id, started_at, status, bookmark_before, model) VALUES (?, ?, 'running', ?, ?)")
    .run(sessionId, now(), bookmarkBefore, model ?? null);
  return Number(r.lastInsertRowid);
}

// Entries enter the table only when a run that processed them succeeds (design.md 6.3), in the same
// transaction as everything the run writes (4.3 step 7).
export function finishRun(db: DatabaseSync, runId: number, sessionId: number, entries: Numbered[],
  extra: { usage?: unknown; request?: string; response?: string } = {}, write?: (entryIds: Map<string, number>) => void): void {
  tx(db, () => {
    const ins = db.prepare(`INSERT INTO entries (session_id, turn_no, entry_no, cc_uuid, role, kind, tool_name, is_error, raw_chars, text, ts, run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const ids = new Map<string, number>();
    for (const e of entries)
      ids.set(address(sessionId, e), Number(ins.run(sessionId, e.turnNo, e.entryNo, e.uuid, e.role, e.kind, e.toolName ?? null, e.isError ? 1 : 0, e.rawChars, e.text, e.ts, runId).lastInsertRowid));
    write?.(ids);
    const last = entries.at(-1)?.uuid ?? (db.prepare("SELECT bookmark_before AS b FROM runs WHERE id = ?").get(runId) as { b: string | null }).b;
    // What prepare stored stays: the request is kept for debugging and replays (5.2).
    db.prepare("UPDATE runs SET status = 'succeeded', finished_at = ?, bookmark_after = ?, usage = COALESCE(?, usage), request = COALESCE(?, request), response = COALESCE(?, response) WHERE id = ?")
      .run(now(), last, extra.usage === undefined ? null : JSON.stringify(extra.usage), extra.request ?? null, extra.response ?? null, runId);
  });
}

export function failRun(db: DatabaseSync, runId: number, error: string): void {
  db.prepare("UPDATE runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?").run(now(), error, runId);
}

export const address = (sessionId: number, e: { turnNo: number; entryNo: number }) => `S${sessionId}/T${e.turnNo}#E${e.entryNo}`;
