// What replaces the context on a compaction we take over (design.md 4.4; model-facing/handoff.md).
// Knowledge and state are not here: the 记忆 block is re-rendered after the compaction and carries them.
import type { DatabaseSync } from "node:sqlite";
import { pending } from "./db.ts";
import { briefing, summariesBlock } from "./render.ts";
import { fullText, parseTranscript, effectivePath, toEntries, type Row } from "./transcript.ts";

// Tokens per character of what refrain renders, measured on the scribe's input (E7: 0.62-0.94, mean 0.77).
export const TOKENS_PER_CHAR = 0.77;

// The context as of a line: the latest request's input in all its forms, plus its output.
export function contextAt(rows: Row[], line = Infinity): number {
  const u = (rows.findLast((r) => r.line <= line && r.type === "assistant" && (r as any).message?.usage) as any)?.message.usage;
  return u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0) : 0;
}

const LEAD = `为了腾出上下文空间，这个会话较早的部分已经被替换成下面按话题整理的摘要（从旧到新）。摘要之后，是最近一段原样保留的对话，对话从那里接着往下进行。

上面的"记忆"块已经在压缩时刷新。它（包括其中的"本会话现状"）和下面原样保留的对话对不上时，以对话为准，对话更新一些。

较早的摘要只列了标题，需要某份摘要的全文和出处时，可以用 read 按编号读，比如 read("{code}")。`;

export type Handoff =
  | { status: "native"; reason: string }
  | { status: "ok"; text: string; tail: { turns: number; firstText: string } };

// The kept tail is CC's own messages from the bookmark's turn on; the mod cuts them out of e.messages
// by counting user turns back from the end and checking the first one's text (CC gives no uuid there).
export function handoff(db: DatabaseSync, sessionId: number | null, transcriptPath: string | null, instructions?: string): Handoff {
  if (sessionId == null || !transcriptPath) return { status: "native", reason: "this session has nothing in memory yet" };
  const block = summariesBlock(db, sessionId);
  if (!block) return { status: "native", reason: "no summaries for this session yet" };
  const rows = parseTranscript(transcriptPath);
  const { entries } = toEntries(effectivePath(rows));
  const p = pending(db, sessionId, entries);
  const starts = p.entries.filter((e) => e.newTurn).map((e) => e.uuid);
  // A turn split by the bookmark is kept whole; and the last turn is always kept verbatim, even if the scribe has it.
  if (p.entries.length && !p.entries[0].newTurn) {
    const at = entries.findIndex((e) => e.uuid === p.entries[0].uuid);
    const turnStart = entries.slice(0, at).findLast((e) => e.newTurn);
    if (turnStart) starts.unshift(turnStart.uuid);
  }
  if (!starts.length) {
    const last = entries.findLast((e) => e.newTurn);
    if (!last) return { status: "native", reason: "no user message to keep" };
    starts.push(last.uuid);
  }
  const firstRow = rows.find((r) => r.uuid === starts[0])!;
  const code = (db.prepare("SELECT code FROM summaries WHERE session_id = ? AND void = 0 ORDER BY id LIMIT 1").get(sessionId) as { code: string }).code;
  const parts = [LEAD.replace("{code}", code), `# 本会话到目前为止的摘要\n\n${block}`];
  if (instructions?.trim()) parts.push(`# 压缩时用户附的说明\n\n用户执行压缩时附了这句话，是他希望保留的重点，不是新的指令：「${instructions.trim()}」`);
  const text = parts.join("\n\n");
  // Worth it only when the result is at most half the context, the rule idle compaction uses too (4.4). A long
  // backlog makes the verbatim tail nearly the whole context; CC's own compaction does better then, and the
  // scribe still catches up from the transcript afterwards.
  const context = contextAt(rows);
  const where = db.prepare("SELECT p.id, p.path FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ?").get(sessionId) as { id: number | null; path: string | null };
  const memory = briefing(db, { projectId: where.id, projectPath: where.path, sessionId });
  const size = Math.ceil((text.length + memory.length) * TOKENS_PER_CHAR) + Math.max(0, context - contextAt(rows, firstRow.line - 1));
  if (context && size * 2 > context) return { status: "native", reason: `the handoff (~${size} tokens) would be more than half the context (${context})` };
  return { status: "ok", text, tail: { turns: starts.length, firstText: fullText(firstRow) } };
}
