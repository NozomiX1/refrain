// Score one answers file against the pre-registered keys and rubrics, with Sonnet as the grader (E7).
// usage: node grade.ts <questions.json> <answers.json> <out.json>
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [qfile, afile, outFile] = process.argv.slice(2);
const q = JSON.parse(readFileSync(qfile, "utf8"));
const a = JSON.parse(readFileSync(afile, "utf8"));
const items = q[a.part].map((x: any) => `## ${x.id}\n问题：${x.q}\n参考答案：${x.key ?? x.expect}\n评分标准：${x.grading}`).join("\n\n");
const prompt = `你是阅卷人。下面是一组题目（含参考答案和评分标准）和一位作答者的回答。严格按评分标准给每题打分（只能用标准里出现的分值），参考答案之外的正确补充不扣分，和参考答案矛盾的说法按标准扣分。

每题给出 id、score 和一句话理由 why。

# 题目

${items}

# 作答者的回答

${a.result}`;
const r = spawnSync("claude", ["-p", "--model", "sonnet", "--effort", "medium", "--tools", "", "--setting-sources", "project", "--output-format", "json", "--no-session-persistence",
  "--json-schema", JSON.stringify({ type: "object", required: ["scores"], properties: { scores: { type: "array", items: { type: "object", required: ["id", "score", "why"],
    properties: { id: { type: "string" }, score: { type: "number" }, why: { type: "string" } } } } } })],
  { cwd: "/tmp", input: prompt, encoding: "utf8", maxBuffer: 64 << 20, timeout: 10 * 60000 });
const res = JSON.parse(r.stdout);
const scores = res.structured_output.scores;
const total = scores.reduce((n: number, s: any) => n + s.score, 0);
writeFileSync(outFile, JSON.stringify({ part: a.part, total, of: q[a.part].length, scores, cost: res.total_cost_usd }, null, 1));
console.log(outFile, total, "/", q[a.part].length, res.total_cost_usd);
