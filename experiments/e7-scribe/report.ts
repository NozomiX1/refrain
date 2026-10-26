// One table over finished replays (E7): replays named <cut>-<model>-<effort>[-<variant>]-<n> are grouped by the
// name without -<n>, and each cell shows the mean with the min–max of the repeats.
// usage: node report.ts <dir with replay out dirs>
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../core/db.ts";

const root = process.argv[2];
const json = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
type Row = Record<string, number | null>;
// What a subscription's limit counts, roughly: uncached input, cache writes and output at API prices; cache reads
// are close to free (wokey.ai's measurements, checked against this account's own week in 2026-10).
const PRICE: Record<string, [number, number]> = { haiku: [0.1, 0.5], sonnet: [2, 10], opus: [4, 20] };
function quota(dir: string): number {
  let q = 0;
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    const line = readFileSync(join(dir, f), "utf8").split("\n").find((l) => l.includes('"type":"result"'));
    for (const [model, u] of Object.entries<any>(line ? JSON.parse(line).modelUsage : {})) {
      const [i, o] = PRICE[Object.keys(PRICE).find((k) => model.includes(k)) ?? "haiku"];
      q += ((u.inputTokens + u.cacheCreationInputTokens) * i + u.outputTokens * o) / 1e6;
    }
  }
  return q;
}
const groups = new Map<string, Row[]>();
for (const name of readdirSync(root).sort()) {
  const d = join(root, name);
  const runs = json(join(d, "runs.json"));
  // Older replays were answered once (grade-qa.json), newer ones twice (grade-qa-1.json, grade-qa-2.json): mean of what is there.
  const grades = (part: string) => readdirSync(d).filter((f) => new RegExp(`^grade-${part}(-\\d)?\\.json$`).test(f)).map((f) => json(join(d, f)).total as number);
  const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
  if (!runs || !/-\d+$/.test(name) || !grades("tasks").length) continue;
  const db = openDb(join(d, "home", "memory.db"));
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const facts = json(join(d, "facts.json"));
  const sum = (k: string) => runs.reduce((a: number, r: any) => a + (typeof r[k] === "number" ? r[k] : 0), 0);
  const row: Row = {
    "问答": mean(grades("qa")),
    "任务": mean(grades("tasks")),
    "知识": n("SELECT COUNT(*) n FROM knowledge k WHERE EXISTS (SELECT 1 FROM knowledge_versions v WHERE v.knowledge_id = k.id AND v.void = 0 AND v.status = 'active' AND v.version_no = (SELECT MAX(version_no) FROM knowledge_versions WHERE knowledge_id = k.id AND void = 0))"),
    "不实": facts ? facts.unsupported : null,
    "部分": facts ? facts.partial : null,
    "标注错": facts ? facts.badLabel : null,
    "摘要": n("SELECT COUNT(*) n FROM summaries WHERE void = 0"),
    "整理次数": runs.length,
    "失败": runs.filter((r: any) => r.status !== "succeeded").length,
    "退回": sum("rejected"),
    "search": runs.reduce((a: number, r: any) => a + (r.calls.search ?? 0), 0),
    "read": runs.reduce((a: number, r: any) => a + (r.calls.read ?? 0), 0),
    "输出k": Math.round(sum("output") / 1000),
    "花费$": Math.round(sum("cost") * 1000) / 1000,
    "额度$": Math.round(quota(join(d, "runs")) * 1000) / 1000,
    "分钟": Math.round(sum("ms") / 60000),
  };
  const key = name.replace(/-\d+$/, "");
  groups.set(key, [...(groups.get(key) ?? []), row]);
}
const cols = [...(groups.values().next().value ? Object.keys(groups.values().next().value![0]) : [])];
console.log(`| 设置 | 次数 | ${cols.join(" | ")} |\n|${"---|".repeat(cols.length + 2)}`);
for (const [key, rows] of groups) {
  const cell = (c: string) => {
    const v = rows.map((r) => r[c]).filter((x): x is number => x !== null);
    if (!v.length) return "—";
    const mean = Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100;
    return v.length > 1 && Math.min(...v) !== Math.max(...v) ? `${mean}（${Math.min(...v)}–${Math.max(...v)}）` : String(mean);
  };
  console.log(`| ${key} | ${rows.length} | ${cols.map(cell).join(" | ")} |`);
}
