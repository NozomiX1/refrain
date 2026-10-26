import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openDb } from "../core/db.ts";
import { handoff } from "../core/handoff.ts";
import { read, search } from "../core/retrieve.ts";
import { prepare, submit } from "../core/scribe.ts";
import { transcript } from "./fixture.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const empty = { knowledge: [], project_state: null, session_state: null };

// Two scribe runs over a short session: one summary and knowledge item each, the second item later archived.
function world() {
  const home = mkdtempSync(join(tmpdir(), "refrain-home-"));
  const db = openDb(join(home, "memory.db"));
  const t = transcript();
  const path = join(home, "t.jsonl");
  const run = (s: object) => {
    t.write(path);
    const p = prepare(db, home, { ccSessionId: "cc-1", transcriptPath: path, cwd: repo, force: true, today: "2026-10-25" }) as any;
    const r = submit(db, home, p.runId, s);
    assert.ok(r.ok, r.text);
  };
  t.human("书记员的输出协议怎么定？");
  t.say("我建议用一个 submit 工具整份提交，校验不过就重交。要我写进 design.md 吗？");
  t.human("可以，写吧");
  t.call("c1", "Bash", { command: "npm test" });
  t.result("c1", "Error: submit schema rejected");
  run({ ...empty,
    summaries: [{ title: "讨论书记员的输出协议", tags: ["H6"], body: "Claude 提议用一个 submit 工具整份提交；用户同意。", refs: ["S1/T1#E2", "S1/T2#E1"] }],
    knowledge: [{ op: "create", scope: "project", category: "understanding", about_me: false, epistemic: "quote", pending: false,
      body: "书记员用一个 submit 工具整份提交。", refs: ["S1/T2#E1"], reason: "用户同意" }] });
  t.human("合并知识时保留较早的条目");
  t.say("好");
  t.human("算了，合并时新建一条");
  run({ ...empty,
    summaries: [{ title: "讨论合并怎么做", body: "用户先说保留较早的，后来改成新建一条。", refs: ["S1/T3#E1", "S1/T4#E1"] }],
    knowledge: [
      { op: "create", id: "new1", scope: "project", category: "understanding", about_me: false, epistemic: "quote", pending: false,
        body: "合并知识时新建一条、归档旧的。", refs: ["S1/T4#E1"], reason: "用户改了主意" },
      { op: "update", code: "K1", body: "书记员用一个 submit 工具整份提交，最多重交 3 次。", refs: ["S1/T2#E1"], reason: "补充次数" },
    ] });
  return { db, t, path, s: { sessionId: 1, projectId: 1 } };
}

test("search: knowledge with every version labelled, summaries with time and body, raw hits grouped under their summary", () => {
  const { db, s } = world();
  const out = search(db, s, { query: "submit|整份提交" });
  assert.match(out, /^找到 2 条知识、1 份摘要、2 条原始记录。/);
  assert.match(out, /K1  背景和决定 · 当前  书记员用一个 submit 工具整份提交，最多重交 3 次。\nK1@1  背景和决定 · 旧版本  书记员用一个 submit 工具整份提交。/);
  assert.match(out, /M1  \d\d-\d\d \d\d:\d\d  讨论书记员的输出协议\n     Claude 提议/);
  assert.match(out, /▸ 出自 M1 讨论书记员的输出协议（1 条）\n    S1\/T1#E2 Claude/);
  assert.match(out, /▸ 没被任何摘要讲到的原始记录 1 条；整理这些记录时一起写的摘要有：M1 讨论书记员的输出协议\n    S1\/T2#E3 工具结果/);
});

test("search: space means all, | means any; two-character words still match; no hit says so", () => {
  const { db, s } = world();
  assert.match(search(db, s, { query: "合并 新建", in: "summaries" }), /找到 1 份摘要/);
  assert.match(search(db, s, { query: "合并 schema", in: "summaries" }), /没有找到包含"合并 schema"的摘要（范围：当前项目）。\n可以换个说法/);
  assert.match(search(db, s, { query: "保留|重交", in: "raw" }), /找到 2 条原始记录/);
});

test("search without a query lists the latest summaries, newest first", () => {
  const { db, s } = world();
  assert.match(search(db, s, {}), /^本项目最新的 2 份摘要（从新到旧）：\n\nM2 .*\n     用户先说.*\nM1 /);
});

test("read: knowledge history, a summary with its neighbours, a user entry with the reply it answers", () => {
  const { db, s } = world();
  const k = read(db, s, "K1");
  assert.match(k, /^K1  背景和决定 · 本项目 · 当前（第 2 版）\n书记员用一个 submit 工具整份提交，最多重交 3 次。\n依据：用户原话\n出处：S1\/T2#E1\n/);
  assert.match(k, /第 2 版  .*  更新  补充次数\n  第 1 版  .*  新建  用户同意/);
  assert.match(read(db, s, "K1@1"), /^K1@1  背景和决定 · 本项目 · 旧版本（第 1 版）/);
  assert.match(read(db, s, "M1"), /^M1  讨论书记员的输出协议\n会话 S1 · .* · 标签：H6\n出处：S1\/T1#E2、S1\/T2#E1\n\nClaude 提议.*\n\n同一会话里时间上相邻的摘要（不一定是同一个话题）：\n  后：M2 讨论合并怎么做$/);
  const e = read(db, s, "S1/T2#E1 @user");
  assert.match(e, /^〔上文：Claude 上一条回复的末尾〕\n…我建议用一个 submit 工具整份提交，校验不过就重交。要我写进 design\.md 吗？\n\nS1\/T2#E1  用户  .*\n可以，写吧\n\n这条记录出自 M1 讨论书记员的输出协议。$/);
  assert.match(read(db, s, "S1/T2#E3"), /同一时段的摘要：M1 讨论书记员的输出协议。$/);
});

test("read: a range of turns, the unclipped original, and addresses it cannot read", () => {
  const { db, s, t, path } = world();
  assert.match(read(db, s, "S1/T1-T2"), /^S1\/T1#E1  用户  .*\n书记员的输出协议怎么定？\n\nS1\/T1#E2/);
  t.write(path);
  assert.match(read(db, s, "S1/T2#E3", true), /Error: submit schema rejected/);
  assert.match(read(db, s, "S1/T99#E1"), /^没有找到 S1\/T99#E1。还没整理进记忆的记录读不到/);
  assert.match(read(db, s, "foo"), /^看不懂地址 foo。/);
});

test("handoff: summaries plus the user's note; the tail starts at the bookmark, and the last turn is kept even when processed", () => {
  const { db, t, path } = world();
  t.human("接下来写简报");
  t.say("好的");
  t.write(path);
  const h = handoff(db, 1, path, "重点保留合并的讨论") as any;
  assert.equal(h.status, "ok");
  assert.match(h.text, /^为了腾出上下文空间/);
  assert.match(h.text, /# 本会话到目前为止的摘要\n\n## M1 讨论书记员的输出协议/);
  assert.match(h.text, /「重点保留合并的讨论」$/);
  assert.deepEqual(h.tail, { turns: 1, firstText: "接下来写简报" });
  const all = handoff(db, 1, join(dirname(path), "t.jsonl")) as any;
  assert.ok(all.tail.turns >= 1);
  assert.deepEqual(handoff(db, null, null), { status: "native", reason: "this session has nothing in memory yet" });
});

test("handoff: a backlog that would leave more than half the context goes to CC's own compaction", () => {
  const { db, t, path } = world();
  const before = t.rows.findLast((r) => r.type === "assistant") as any;
  before.message.usage = { input_tokens: 10, cache_read_input_tokens: 90000 };
  t.human("接下来写简报");
  t.say("好的", { input_tokens: 5, cache_read_input_tokens: 100000, output_tokens: 200 });
  t.write(path);
  assert.equal(handoff(db, 1, path).status, "ok", "a 10k tail out of 100k");
  before.message.usage = { input_tokens: 10, cache_read_input_tokens: 20000 };
  t.write(path);
  assert.match((handoff(db, 1, path) as any).reason, /more than half the context \(100205\)/, "an 80k tail");
});
