// One scribe run, split across the three moments the mod sees it (design.md 4.3):
// prepare at the main turn's end, submit from the subagent's tool call, finish at the subagent's turn end.
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { bookmark, ensureProject, ensureSession, failRun, finishRun, now, pending, startRun, tx, type Numbered } from "./db.ts";
import { contextAt, TOKENS_PER_CHAR } from "./handoff.ts";
import { consecutiveFailures, PAUSE_AFTER, writeStatus, type TurnInfo } from "./ops.ts";
import { projectRoot } from "./project.ts";
import { briefing, localDate, scribeInput, summariesBlock } from "./render.ts";
import { apply, LIMITS as SUBMIT, rejection, validate, type Ctx, type Submission } from "./submit.ts";
import { effectivePath, parseTranscript, toEntries, type Row } from "./transcript.ts";

// Sizes from E7. maxChars keeps a Haiku request under its 100K-token price tier at the worst measured 0.94 tokens per
// char, with the 14k-token instructions and knowledge at its cap beside the batch; bigger batches also drew more blank submits.
// REFRAIN_MIN_CHARS lets scripted tests trigger the scribe on a short session.
// A session untouched for leftoverIdleMs (the main session's cache lifetime) counts as closed (4.6).
export const RUN = { minChars: Number(process.env.REFRAIN_MIN_CHARS ?? 20000), maxChars: 50000, staleMinutes: 20, leftoverIdleMs: 3600000 };

type Request = { prompt: string; batch: Numbered[]; projectId: number | null; today: string };

// Whole turns from the start, at least one, until the next would pass maxChars (4.3 step 2).
export function cutBatch(entries: Numbered[], maxChars = RUN.maxChars): Numbered[] {
  const out: Numbered[] = [];
  let size = 0;
  for (let i = 0; i < entries.length; ) {
    let j = i;
    let turnSize = 0;
    while (j < entries.length && entries[j].turnNo === entries[i].turnNo) turnSize += entries[j++].text.length;
    if (out.length && size + turnSize > maxChars) break;
    out.push(...entries.slice(i, j));
    size += turnSize;
    i = j;
  }
  return out;
}

export type PrepareArgs = { ccSessionId: string; transcriptPath?: string; cwd: string; force?: boolean; today?: string; minChars?: number; idle?: TurnInfo["idle"] };

// The mod knows the session id, not the file: CC keeps it at <config>/projects/<encoded cwd>/<id>.jsonl.
export function findTranscript(ccSessionId: string): string {
  const dir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  for (const d of readdirSync(dir)) {
    const p = join(dir, d, `${ccSessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  throw new Error(`no transcript for session ${ccSessionId} under ${dir}`);
}

// What a closed session of this project left unprocessed: the next session's scribe finishes it (4.6), whatever its
// size. A wrong guess costs nothing: bookmarks are per session, so a session that goes on carries on from there.
// A session found caught up is remembered with its file size, so it is not read again until it grows.
function leftover(db: DatabaseSync, projectId: number, currentId: number): { sessionId: number; entries: Numbered[] } | undefined {
  const sessions = db.prepare("SELECT id, transcript_path AS path FROM sessions WHERE project_id = ? AND id != ? ORDER BY id").all(projectId, currentId) as { id: number; path: string }[];
  for (const s of sessions) {
    if (!existsSync(s.path)) continue;
    const { mtimeMs, size } = statSync(s.path);
    const key = `caught-up:${s.id}`;
    if (Date.now() - mtimeMs < RUN.leftoverIdleMs || consecutiveFailures(db, s.id) >= PAUSE_AFTER) continue;
    if ((db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value === String(size)) continue;
    const p = pending(db, s.id, toEntries(effectivePath(parseTranscript(s.path))).entries);
    if (p.entries.length) return { sessionId: s.id, entries: p.entries };
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, String(size));
  }
}

export function prepare(db: DatabaseSync, home: string, a: PrepareArgs): { status: "skip"; reason: string; warnings?: string[] } | { status: "ready"; runId: number; prompt: string; warnings: string[]; leftoverOf?: number } {
  const root = projectRoot(a.cwd);
  const projectId = root ? ensureProject(db, root) : null;
  const transcriptPath = a.transcriptPath ?? findTranscript(a.ccSessionId);
  const sessionId = ensureSession(db, a.ccSessionId, projectId, transcriptPath);
  const rows = parseTranscript(transcriptPath);
  const { entries, warnings } = toEntries(effectivePath(rows));
  const today = a.today ?? localDate(new Date());
  // The single-writer lock is a running row, taken under an immediate transaction (ADR-0018).
  if (consecutiveFailures(db, sessionId) >= PAUSE_AFTER) {
    writeStatus(db, home, sessionId, "paused", turnInfo(db, rows, sessionId, projectId, root, a.idle));
    return { status: "skip", reason: "paused" };
  }
  const out = tx(db, () => {
    const stale = new Date(Date.now() - RUN.staleMinutes * 60000).toISOString();
    db.prepare("UPDATE runs SET status = 'failed', finished_at = ?, error = '运行超时，没有收尾' WHERE status = 'running' AND started_at < ?").run(now(), stale);
    if (db.prepare("SELECT 1 FROM runs WHERE status = 'running'").get()) return { status: "skip" as const, reason: "another scribe run is in progress" };
    const start = (sid: number, pend: Numbered[]) => {
      const batch = cutBatch(pend);
      const prompt = scribeInput(db, { projectId, projectPath: root, sessionId: sid }, batch, today);
      const runId = startRun(db, sid, bookmark(db, sid));
      const req: Request = { prompt, batch, projectId, today };
      db.prepare("UPDATE runs SET request = ? WHERE id = ?").run(JSON.stringify(req), runId);
      return { status: "ready" as const, runId, prompt, warnings, ...(sid !== sessionId && { leftoverOf: sid }) };
    };
    const p = pending(db, sessionId, entries);
    const size = p.entries.reduce((n, e) => n + e.text.length, 0);
    // REFRAIN_MIN_CHARS (scripted tests) wins over the setting.
    if (p.entries.length && (a.force || size >= (process.env.REFRAIN_MIN_CHARS ? RUN.minChars : a.minChars ?? RUN.minChars))) return start(sessionId, p.entries);
    const left = projectId == null ? undefined : leftover(db, projectId, sessionId);
    if (left) return start(left.sessionId, left.entries);
    return { status: "skip" as const, reason: p.entries.length ? `only ${size} new chars` : "nothing new", warnings };
  }, "IMMEDIATE");
  // A leftover run belongs to the other session; this session's status line keeps showing its own scribe.
  writeStatus(db, home, sessionId, out.status === "ready" && !("leftoverOf" in out) ? "running" : undefined, turnInfo(db, rows, sessionId, projectId, root, a.idle));
  return out;
}

const usageOf = (r: Row) => (r as { message?: { usage?: Record<string, any> } }).message?.usage;

// Context size and cache lifetime from the latest request's usage; the handoff's size is estimated as
// summaries plus briefing plus the tail, the tail being how much the context grew since the bookmark.
function turnInfo(db: DatabaseSync, rows: Row[], sessionId: number, projectId: number | null, root: string | null, idle = { enabled: true, minTokens: 60000 }): TurnInfo {
  const mark = bookmark(db, sessionId);
  const markLine = mark ? rows.find((r) => r.uuid === mark)?.line ?? -1 : -1;
  const atMark = markLine < 0 ? 0 : contextAt(rows, markLine);
  const words = summariesBlock(db, sessionId).length + briefing(db, { projectId, projectPath: root, sessionId }).length;
  // A request that only read the cache says nothing about its lifetime; look back to the last one that wrote it.
  const wrote = rows.findLast((r) => { const c = usageOf(r)?.cache_creation; return r.type === "assistant" && c && (c.ephemeral_1h_input_tokens || c.ephemeral_5m_input_tokens); });
  const oneHour = (usageOf(wrote ?? ({} as Row))?.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0;
  // REFRAIN_IDLE_TTL_MS and REFRAIN_IDLE_MIN_TOKENS let scripted tests reach an idle compaction in minutes.
  const env = process.env;
  const context = contextAt(rows);
  return {
    turnEndedAt: new Date().toISOString(),
    contextTokens: context,
    cacheTtlMs: env.REFRAIN_IDLE_TTL_MS ? Number(env.REFRAIN_IDLE_TTL_MS) : oneHour ? 3600000 : 300000,
    handoffTokens: Math.ceil(words * TOKENS_PER_CHAR) + Math.max(0, context - atMark),
    idle: env.REFRAIN_IDLE_MIN_TOKENS ? { ...idle, minTokens: Number(env.REFRAIN_IDLE_MIN_TOKENS) } : idle,
  };
}

export function submit(db: DatabaseSync, home: string, runId: number, s: Submission): { ok: boolean; text: string } {
  const run = db.prepare("SELECT session_id, status, attempts, request FROM runs WHERE id = ?").get(runId) as
    | { session_id: number; status: string; attempts: number; request: string }
    | undefined;
  if (!run || run.status !== "running") return { ok: false, text: "这次整理已经结束了，不用再提交。" };
  const req = JSON.parse(run.request) as Request;
  const ctx: Ctx = { db, sessionId: run.session_id, projectId: req.projectId, batch: req.batch, today: req.today };
  const attempts = run.attempts + 1;
  db.prepare("UPDATE runs SET attempts = ? WHERE id = ?").run(attempts, runId);
  const errs = validate(ctx, s);
  if (errs.length) {
    if (attempts >= SUBMIT.attempts) {
      failRun(db, runId, `submit rejected ${attempts} times`);
      settle(db, home, run.session_id);
    }
    return { ok: false, text: rejection(errs, SUBMIT.attempts - attempts) };
  }
  let text = "";
  finishRun(db, runId, run.session_id, req.batch, { response: JSON.stringify(s) }, (ids) => (text = apply(ctx, s, runId, ids)));
  settle(db, home, run.session_id);
  return { ok: true, text };
}

// After a run ends: idle again, or paused once it is the third failure in a row.
function settle(db: DatabaseSync, home: string, sessionId: number) {
  writeStatus(db, home, sessionId, consecutiveFailures(db, sessionId) >= PAUSE_AFTER ? "paused" : "idle");
}

// Called when the scribe subagent's turn ends: a run that never got a valid submit has failed (4.3).
export function finish(db: DatabaseSync, home: string, runId: number, usage?: unknown, error = "没有调用 submit 就结束了"): { status: string; paused: boolean } {
  if (usage != null) db.prepare("UPDATE runs SET usage = ? WHERE id = ?").run(JSON.stringify(usage), runId);
  const r = db.prepare("SELECT status, session_id FROM runs WHERE id = ?").get(runId) as { status: string; session_id: number } | undefined;
  if (!r) return { status: "missing", paused: false };
  if (r.status === "running") failRun(db, runId, error);
  settle(db, home, r.session_id);
  return { status: r.status === "running" ? "failed" : r.status, paused: consecutiveFailures(db, r.session_id) >= PAUSE_AFTER };
}

