// Answer e1's pre-registered questions from one replay's memory, the way a new main session would see it (E7):
// the briefing as of the cut, plus the real search / read tools over that replay's database.
// usage: node answer.ts <replay out dir> <questions.json> <qa|tasks> <out.json>
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDb } from "../../core/db.ts";
import { briefing } from "../../core/render.ts";

const [dirArg, qfile, part, outFile] = process.argv.slice(2);
const dir = resolve(dirArg);
const q = JSON.parse(readFileSync(qfile, "utf8"));
const db = openDb(join(dir, "home", "memory.db"));
// A replay records one project: the one its session ran in.
const p = db.prepare("SELECT id, path FROM projects").get() as { id: number; path: string };
const cwd = p.path;
const brief = briefing(db, { projectId: p.id, projectPath: p.path }, q.as_of);

// Same opening as e1's answer.py; the questions use its neutral wording (e1 diagnosis).
const system = `你是 Claude Code，在 ${q.project} 项目里和这位用户长期协作。今天是 ${q.today}，用户刚开了一个新会话，上一个会话里的对话你已经看不到了。运行环境报告的日期可能不同，以这里说的为准。\n\n<system-reminder>\nSessionStart hook additional context: ${brief}</system-reminder>`;
const ask = {
  qa: "用户问了下面几个问题。请逐题回答，每题用题号开头。不知道就说不知道，不要编造。\n\n",
  tasks: "下面是用户交给你的几件事。请逐条说明你会怎么做、会注意什么（这次只说计划，不用真的执行），每条用编号开头。\n\n",
}[part as "qa" | "tasks"] + q[part].map((x: { id: string; q: string }) => `${x.id}. ${x.q}`).join("\n");

const cfg = join(dir, `mcp-answer-${part}.json`);
writeFileSync(cfg, JSON.stringify({ mcpServers: { refrain: { command: "node", args: [new URL("mcp.ts", import.meta.url).pathname],
  env: { REFRAIN_HOME: join(dir, "home"), E7_SESSION: "e7-new-session", E7_CWD: cwd } } } }));
const r = spawnSync("claude", ["-p", "--model", "haiku", "--effort", "medium", "--system-prompt", system, "--tools", "", "--mcp-config", cfg,
  "--strict-mcp-config", "--allowedTools", "mcp__refrain__search,mcp__refrain__read", "--setting-sources", "project",
  "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--max-turns", "40"],
  { cwd: join(dir, "cwd"), input: ask, encoding: "utf8", maxBuffer: 256 << 20, timeout: 15 * 60000, killSignal: "SIGKILL" });
const msgs = (r.stdout ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const res = msgs.find((m) => m.type === "result");
const calls: Record<string, number> = {};
for (const m of msgs) for (const b of m.message?.content ?? []) if (b.type === "tool_use") calls[b.name] = (calls[b.name] ?? 0) + 1;
writeFileSync(outFile, JSON.stringify({ part, result: res?.result ?? null, turns: res?.num_turns, cost: res?.total_cost_usd, calls, briefChars: brief.length }, null, 1));
console.log(outFile, res?.num_turns, res?.total_cost_usd, JSON.stringify(calls));
