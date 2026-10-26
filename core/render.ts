// One renderer for the briefing, the scribe's input and the panel (design.md 6.6, 4.3 step 3).
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { address, type Numbered } from "./db.ts";

export const FOLD = { n: 8, k: 8, titleCap: 160 }; // design.md 4.3; tuned by E6

const CATEGORY: Record<string, string> = { rule: "规则", understanding: "背景和决定", goal: "目标", reference: "参考" };
const STATE_TYPE: Record<string, string> = { phase: "阶段", progress: "进度", todo: "待办", verify: "待核实", authorization: "授权", instruction: "临时指令" };

export type Knowledge = {
  code: string; knowledge_id: number; version_id: number; version_no: number; status: string; scope: string; project_id: number | null;
  body: string; epistemic: string; pending: number; about_me: number; category: string; as_of: string; refs: string;
};
export type StateItem = { type: string; content: string; condition?: string | null; refs?: string[]; as_of: string };

const pad = (n: number) => String(n).padStart(2, "0");
export const localDate = (iso: string | Date) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const localTime = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// The latest non-void version of every item, archived ones included; callers filter by status.
export function currentKnowledge(db: DatabaseSync): Knowledge[] {
  return db.prepare(`SELECT k.code, k.id AS knowledge_id, v.id AS version_id, v.version_no, v.status, v.scope, v.project_id, v.body, v.epistemic,
      v.pending, v.about_me, v.category, v.as_of, v.refs
    FROM knowledge k JOIN knowledge_versions v ON v.knowledge_id = k.id
    WHERE v.void = 0 AND v.version_no = (SELECT MAX(version_no) FROM knowledge_versions WHERE knowledge_id = k.id AND void = 0)
    ORDER BY k.id`).all() as Knowledge[];
}

function knowledgeLine(k: Knowledge): string {
  let tags = (k.epistemic === "inference" ? "〔推断〕" : "") + (k.epistemic === "observed" ? "〔观察〕" : "") + (k.pending ? "〔待定〕" : "");
  if (k.epistemic === "observed" || k.category === "reference") tags += `〔截至 ${k.as_of.slice(5)}〕`;
  return `- ${k.code} ${k.body}${tags}`;
}

function knowledgeSection(items: Knowledge[], level: string): string {
  return Object.keys(CATEGORY)
    .map((c) => [c, items.filter((k) => k.category === c)] as const)
    .filter(([, ks]) => ks.length)
    .map(([c, ks]) => `${level} ${CATEGORY[c]}\n${ks.map(knowledgeLine).join("\n")}`)
    .join("\n\n");
}

export function stateItems(db: DatabaseSync, kind: "project" | "session", id: number | null): StateItem[] {
  if (id == null) return [];
  const col = kind === "project" ? "project_id" : "session_id";
  const r = db.prepare(`SELECT items FROM states WHERE kind = ? AND ${col} = ? AND void = 0 ORDER BY id DESC LIMIT 1`).get(kind, id) as { items: string } | undefined;
  return r ? JSON.parse(r.items) : [];
}

export function stateBlock(items: StateItem[]): string {
  return items
    .map((it, i) => `${i + 1}. ${STATE_TYPE[it.type] ?? it.type}：${it.content}${it.condition ? `（条件：「${it.condition}」）` : ""}〔截至 ${it.as_of.slice(5)}〕`)
    .join("\n");
}

// Newest N in full; older ones folded to "code title" in batches of K, so the prefix only moves every K runs.
export function summariesBlock(db: DatabaseSync, sessionId: number): string {
  const ms = db.prepare("SELECT code, title, body FROM summaries WHERE session_id = ? AND void = 0 ORDER BY id").all(sessionId) as { code: string; title: string; body: string }[];
  const boundary = Math.max(0, Math.floor((ms.length - FOLD.n) / FOLD.k) * FOLD.k);
  const drop = boundary > FOLD.titleCap ? Math.ceil((boundary - FOLD.titleCap) / FOLD.k) * FOLD.k : 0;
  const titles = ms.slice(drop, boundary).map((m) => `${m.code} ${m.title}`);
  const full = ms.slice(boundary).map((m) => `## ${m.code} ${m.title}\n\n${m.body}`);
  return [titles.join("\n"), ...full].filter(Boolean).join("\n\n");
}

type Where = { projectId: number | null; projectPath: string | null };

function visible(db: DatabaseSync, projectId: number | null) {
  const live = currentKnowledge(db).filter((k) => k.status === "active");
  return { global: live.filter((k) => k.scope === "global"), project: projectId == null ? [] : live.filter((k) => k.scope === "project" && k.project_id === projectId) };
}

const HEADER = `以下是从这位用户以往和 Claude 的对话中，由后台整理出来的长期知识和当前状态，截至 {date}。每条都有出处，可以用 read 查看。{where}

- 每条前面的编号（K 开头）可以用 \`read\` 查看它的出处、原话和修改历史。
- 以往会话里做过什么、怎么讨论的，记在摘要里，没有放进这里；用户提到以前的事时，可以用 \`search\` 查。
- 〔推断〕：从用户的行为中归纳的，他没有直接说过，把握较低；用户表现出相反的意愿时，以他为准。〔观察〕：不是用户说的，而是从工具输出或以往的操作里看到的事实，环境变了可能就不成立。〔待定〕：暂缓或还没定的方向，不是已定的方案。现状里的"条件"是这一项要等的前提，条件满足之前不做。〔截至某日〕：现状里是这一项最近一次更新的日期；容易过时的知识（观察到的事实、路径和配置这类参考）也带这个日期，是它依据的最新证据的日期。
- 说法不一致时，用户在当前对话里刚说的话优先，其次是"本会话现状"（这个会话里还在生效的授权、临时指令和进行中的事项；压缩之前这些都在对话里，所以只在压缩之后才会列出），最后是长期知识。用户在本会话里纠正了某条记忆，下面显示的仍是旧内容，要过一段时间才会更新，在此之前以他刚说的为准。
- 用户说"记住……"时，后台会从对话里整理进来，不需要写任何文件（包括 Claude Code 自带的记忆文件）。`;

// The briefing (model-facing/briefing.md), headed 记忆 by itself: SessionStart adds no title of its own and runs
// together with other plugins' SessionStart text. Empty when there is nothing to inject.
export function briefing(db: DatabaseSync, w: Where & { sessionId?: number | null }, today = localDate(new Date())): string {
  const { global, project } = visible(db, w.projectId);
  const projectState = stateItems(db, "project", w.projectId);
  const sessionState = stateItems(db, "session", w.sessionId ?? null);
  if (!global.length && !project.length && !projectState.length && !sessionState.length) return "";
  const name = w.projectPath ? basename(w.projectPath) : "";
  const where = w.projectPath ? `当前项目：${name}（${w.projectPath}）。` : "当前不在任何项目里。";
  return [
    "# 记忆",
    HEADER.replace("{date}", today).replace("{where}", where),
    global.length ? `## 跨项目知识\n\n${knowledgeSection(global, "###")}` : "",
    project.length ? `## 本项目（${name}）知识\n\n${knowledgeSection(project, "###")}` : "",
    projectState.length ? `## 项目现状\n\n${stateBlock(projectState)}` : "",
    sessionState.length ? `## 本会话现状\n\n${stateBlock(sessionState)}` : "",
  ].filter(Boolean).join("\n\n") + "\n";
}

const ROLE = { user: "@user", assistant: "@assistant", observation: "@observation" };
export const entryLine = (sessionId: number, e: Numbered) => `[${address(sessionId, e)} ${ROLE[e.role]}] ${e.text}`;

// The scribe's prompt, ordered from most to least stable for its cache (design.md 4.3 step 3).
// Empty sections say （空） so the scribe can tell "empty" from "not shown" (6.6).
export function scribeInput(db: DatabaseSync, w: Where & { sessionId: number }, batch: Numbered[], today: string): string {
  const { global, project } = visible(db, w.projectId);
  const or = (s: string) => s || "（空）";
  const knowledge = [`## 跨项目知识\n\n${or(knowledgeSection(global, "###"))}`];
  if (w.projectId != null) knowledge.push(`## 本项目知识\n\n${or(knowledgeSection(project, "###"))}`);
  const parts = [
    `# 已有的长期知识\n\n${knowledge.join("\n\n")}`,
    `# 本会话之前的摘要\n\n${or(summariesBlock(db, w.sessionId))}`,
  ];
  if (w.projectId != null) parts.push(`# 项目现状\n\n${or(stateBlock(stateItems(db, "project", w.projectId)))}`);
  parts.push(`# 本会话现状\n\n${or(stateBlock(stateItems(db, "session", w.sessionId)))}`);
  const proj = w.projectPath ? `${basename(w.projectPath)}（${w.projectPath}）` : "（无）";
  parts.push(`# 这次要处理的对话\n\n今天是 ${today}。项目：${proj}。会话：S${w.sessionId}。\n\n${batch.map((e) => entryLine(w.sessionId, e)).join("\n")}`);
  return parts.join("\n\n") + "\n";
}
