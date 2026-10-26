// Fabrication check for one replay (E7, design.md 8.1): every active knowledge item next to the entries it cites,
// judged by Sonnet as supported / partial / unsupported, and whether its evidence label (quote, inference, observed) fits.
// usage: node facts.ts <replay out dir> <out.json>
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDb } from "../../core/db.ts";
import { currentKnowledge } from "../../core/render.ts";
import { read } from "../../core/retrieve.ts";

const [dirArg, outFile] = process.argv.slice(2);
const dir = resolve(dirArg);
const db = openDb(join(dir, "home", "memory.db"));
const s = db.prepare("SELECT id, transcript_path FROM sessions").get() as { id: number; transcript_path: string };
const p = db.prepare("SELECT id, path FROM projects").get() as { id: number; path: string };
const scope = { projectPath: p.path, projectId: p.id, sessionId: s.id, transcriptPath: s.transcript_path };
const LABEL: Record<string, string> = { quote: "用户原话", inference: "推断", observed: "观察" };

const items = currentKnowledge(db).filter((k) => k.status === "active");
const blocks = items.map((k) => {
  const refs: string[] = JSON.parse(k.refs);
  const src = refs.map((a) => `〔${a}〕\n${read(db, scope, a)}`).join("\n\n");
  return `## ${k.code}\n知识：${k.body}\n标注的依据：${LABEL[k.epistemic]}${k.pending ? "（待定）" : ""}\n\n引用的出处：\n\n${src}`;
});
const prompt = `下面是一个记忆系统从对话里整理出的若干条长期知识，每条后面附上它引用的对话原文（@user 是用户本人的话，@assistant 是 AI 助手，@observation 是工具输出）。逐条核对：

- verdict：supported（出处支持这条知识的全部说法）、partial（主体对，但有细节出处里没有、说过头或不准确）、unsupported（主要说法出处里没有，或者和出处矛盾）。只按附上的出处判断，不要用常识补。
- label_ok：标注的依据对不对。"用户原话"要求出处里有用户本人说的话支撑；"推断"是从用户行为归纳的；"观察"是工具输出或操作里看到的事实。把助手的提议或粘贴的别人的话当成用户原话，算不对。
- why：一句话说明。

${blocks.join("\n\n---\n\n")}`;
const r = spawnSync("claude", ["-p", "--model", "sonnet", "--effort", "medium", "--tools", "", "--setting-sources", "project", "--output-format", "json", "--no-session-persistence",
  "--json-schema", JSON.stringify({ type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "object", required: ["code", "verdict", "label_ok", "why"],
    properties: { code: { type: "string" }, verdict: { enum: ["supported", "partial", "unsupported"] }, label_ok: { type: "boolean" }, why: { type: "string" } } } } } })],
  { cwd: "/tmp", input: prompt, encoding: "utf8", maxBuffer: 64 << 20, timeout: 15 * 60000 });
const res = JSON.parse(r.stdout);
const judged: { verdict: string; label_ok: boolean }[] = res.structured_output.items;
const count = (v: string) => judged.filter((j) => j.verdict === v).length;
const sum = { items: items.length, judged: judged.length, supported: count("supported"), partial: count("partial"), unsupported: count("unsupported"),
  badLabel: judged.filter((j) => !j.label_ok).length, promptChars: prompt.length, cost: res.total_cost_usd };
writeFileSync(outFile, JSON.stringify({ ...sum, verdicts: judged }, null, 1));
console.log(outFile, JSON.stringify(sum));
