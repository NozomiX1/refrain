import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { address, openDb } from "../core/db.ts";
import { briefing, FOLD, summariesBlock } from "../core/render.ts";
import { cutBatch, finish, prepare, submit } from "../core/scribe.ts";
import { transcript } from "./fixture.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), ".."); // a git repo, so it is a project
const TODAY = "2026-10-25";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "refrain-home-"));
  const db = openDb(join(home, "memory.db"));
  const t = transcript();
  const path = join(home, "t.jsonl");
  const prep = (extra: object = {}) => {
    t.write(path);
    return prepare(db, home, { ccSessionId: "cc-1", transcriptPath: path, cwd: repo, force: true, today: TODAY, ...extra });
  };
  const ready = () => {
    const p = prep();
    assert.equal(p.status, "ready");
    return (p as { runId: number }).runId;
  };
  // Every run must leave a summary (6.5); tests about something else get a one-line one on the batch's first entry.
  const note = (runId: number) => {
    const r = db.prepare("SELECT session_id, request FROM runs WHERE id = ?").get(runId) as { session_id: number; request: string };
    return { title: "测试", body: "测试用的摘要。", refs: [address(r.session_id, JSON.parse(r.request).batch[0])] };
  };
  return { home, db, t, path, prep, ready, sub: (runId: number, s: object) => submit(db, home, runId, { summaries: [note(runId)], ...s }) };
}

const empty = { knowledge: [], project_state: null, session_state: null };
const rule = (refs = ["S1/T1#E1"]) => ({ op: "create", scope: "global", category: "rule", about_me: true, epistemic: "quote", pending: false,
  body: "先讨论再动手：给出推荐，等用户确认后再改文件。", refs, reason: "用户明确说过" });

test("the briefing header is the one in model-facing/briefing.md", () => {
  const doc = readFileSync(join(repo, "docs/model-facing/briefing.md"), "utf8");
  const expected = doc.slice(doc.indexOf("# 记忆\n\n"), doc.indexOf("\n\n## 跨项目知识")).replace("refrain（/home/user/refrain）", "refrain（/x/refrain）");
  const { db, t, ready, sub } = setup();
  t.human("以后先讨论再动手");
  assert.ok(sub(ready(), { ...empty, knowledge: [rule()] }).ok);
  const got = briefing(db, { projectId: 1, projectPath: "/x/refrain" }, "2026-10-25");
  assert.equal(got.slice(0, got.indexOf("\n\n## 跨项目知识")), expected);
});

test("a valid submission is written in one go and the briefing follows", () => {
  const { home, db, t, ready, sub } = setup();
  t.human("以后先讨论再动手，给我推荐");
  t.say("好的，我会先给推荐。");
  const runId = ready();
  const r = sub(runId, {
    summaries: [{ title: "约定做事方式", tags: ["流程"], body: "用户要求以后先讨论再动手。", refs: ["S1/T1#E1", "S1/T1#E2 @assistant"] }],
    knowledge: [rule()],
    project_state: { items: [{ type: "phase", content: "实现阶段" }], closed: [] },
    session_state: null,
  });
  assert.equal(r.text, "已保存：1 份摘要，知识新建 1 条，项目现状已更新，本会话现状没有变化。这次整理完成，不用再回复。");
  const k = db.prepare("SELECT k.code, v.as_of, v.refs FROM knowledge k JOIN knowledge_versions v ON v.knowledge_id = k.id").get() as any;
  assert.deepEqual([k.code, JSON.parse(k.refs)], ["K1", ["S1/T1#E1"]]);
  assert.equal(db.prepare("SELECT code FROM summaries").get()!.code, "M1");
  const file = briefing(db, { projectId: 1, projectPath: repo });
  assert.match(file, /### 规则\n- K1 先讨论再动手/);
  assert.match(file, /## 项目现状\n\n1\. 阶段：实现阶段〔截至 10-25〕/);
  const run = db.prepare("SELECT status, request, response FROM runs WHERE id = ?").get(runId) as any;
  assert.equal(run.status, "succeeded");
  assert.match(JSON.parse(run.request).prompt, /以后先讨论再动手/, "the scribe's input is kept");
  assert.ok(run.response);
});

test("problems come back as a numbered receipt and nothing is saved", () => {
  const { db, t, ready, sub } = setup();
  t.human("你看着办");
  t.say("我决定用 SQLite。");
  const runId = ready();
  const r = sub(runId, {
    summaries: [{ title: "选存储", body: "Claude 选了 SQLite。", refs: ["S1/T9#E1"] }],
    knowledge: [{ ...rule(["S1/T1#E2"]), epistemic: "quote" }, { ...rule(["S1/T1#E2"]), epistemic: "observed" }],
    project_state: { items: [{ type: "authorization", content: "可以直接改 docs/", refs: ["S1/T1#E1"] }], closed: [] },
    session_state: null,
  });
  assert.equal(r.ok, false);
  assert.match(r.text, /^有 4 处问题，这次提交没有保存。请改好后整份重新提交（还可以再交 2 次）：/);
  assert.match(r.text, /summaries\[0\]：refs 里的 S1\/T9#E1 不是一条存在的记录/);
  assert.match(r.text, /knowledge\[0\]（create）：epistemic 是 quote，但 refs 里没有一条是用户本人的话/);
  assert.match(r.text, /knowledge\[1\]（create）：观察（observed）不能是规则/);
  assert.match(r.text, /授权和临时指令只能放在本会话现状里/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM knowledge").get()!.n, 0);
});

test("three rejected submissions fail the run; the bookmark stays and the next run retries", () => {
  const { db, t, ready, sub, prep } = setup();
  t.human("一");
  const runId = ready();
  for (let i = 0; i < 3; i++) sub(runId, { summaries: "x" });
  assert.equal((db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as any).status, "failed");
  assert.match(sub(runId, empty).text, /已经结束/);
  const again = prep();
  assert.equal(again.status, "ready");
  assert.match((again as any).prompt, /\[S1\/T1#E1 @user\] 一/);
});

test("a submit without a summary goes back: the scribe skipped its input", () => {
  const { t, ready, sub } = setup();
  t.human("接下来写简报");
  const r = sub(ready(), { ...empty, summaries: [] });
  assert.equal(r.ok, false);
  assert.match(r.text, /summaries 是空的。每次至少写一份摘要/);
});

test("a closed session's leftover is finished by the next session of the project, whatever its size", () => {
  const { home, db, t, path, prep, sub } = setup();
  t.human("第一个会话最后定的事");
  t.say("好的，记下了");
  assert.equal(prep({ force: false }).status, "skip", "below the threshold, as a session's last few turns usually are");
  const t2 = transcript();
  t2.human("第二个会话");
  const path2 = join(home, "t2.jsonl");
  t2.write(path2);
  const second = () => prepare(db, home, { ccSessionId: "cc-2", transcriptPath: path2, cwd: repo, today: TODAY }) as any;
  assert.equal(second().status, "skip", "the first session was written just now: it may still be open");
  const hoursAgo = (Date.now() - 2 * 3600000) / 1000;
  utimesSync(path, hoursAgo, hoursAgo);
  const r = second();
  assert.equal(r.status, "ready");
  assert.equal(r.leftoverOf, 1);
  assert.match(r.prompt, /第一个会话最后定的事/);
  assert.ok(sub(r.runId, empty).ok);
  assert.equal(second().status, "skip", "caught up");
  assert.ok(db.prepare("SELECT 1 FROM meta WHERE key = 'caught-up:1'").get(), "remembered, so the file is not read again");
});

test("finishing without a submit fails the run", () => {
  const { db, t, ready } = setup();
  t.human("一");
  const runId = ready();
  assert.equal(finish(db, mkdtempSync(join(tmpdir(), "refrain-home-")), runId).status, "failed");
  assert.equal((db.prepare("SELECT error FROM runs WHERE id = ?").get(runId) as any).error, "没有调用 submit 就结束了");
});

test("only one run at a time", () => {
  const { t, ready, prep } = setup();
  t.human("一");
  ready();
  assert.deepEqual(prep(), { status: "skip", reason: "another scribe run is in progress" });
});

test("update merges old refs; merge via temp label archives the old items; archived items leave the briefing", () => {
  const { db, t, ready, sub } = setup();
  t.human("以后先讨论再动手");
  assert.ok(sub(ready(), { ...empty, knowledge: [rule(), { ...rule(), body: "改之前先给推荐。" }] }).ok);
  t.human("还有，确认后再改文件");
  assert.ok(sub(ready(), { ...empty, knowledge: [{ op: "update", code: "K1", body: "先讨论再动手，确认后再改文件。", refs: ["S1/T2#E1"], reason: "用户补充了确认后再改" }] }).ok);
  t.human("这两条其实是一件事");
  const twice = sub(ready(), { ...empty, knowledge: [
    { op: "update", code: "K1", body: "x", refs: ["S1/T3#E1"], reason: "y" },
    { op: "archive", code: "K1", refs: ["S1/T3#E1"], reason: "z" }] });
  assert.match(twice.text, /K1 在这次提交里出现了不止一次/);
  const r = sub((db.prepare("SELECT MAX(id) AS id FROM runs").get() as any).id, {
    ...empty,
    knowledge: [
      { op: "create", id: "new1", scope: "global", category: "rule", about_me: true, epistemic: "quote", pending: false,
        body: "先讨论、给推荐，确认后再改文件。", refs: ["K1", "K2"], reason: "由 K1、K2 合并" },
      { op: "archive", code: "K1", refs: ["new1"], reason: "并入 new1" },
      { op: "archive", code: "K2", refs: ["new1"], reason: "并入 new1" },
    ],
  });
  assert.ok(r.ok, r.text);
  const v = db.prepare("SELECT k.code, v.op, v.reason, v.refs FROM knowledge_versions v JOIN knowledge k ON k.id = v.knowledge_id ORDER BY v.id").all() as any[];
  assert.deepEqual(v.map((x) => `${x.code} ${x.op}`), ["K1 create", "K2 create", "K1 update", "K3 create", "K1 archive", "K2 archive"]);
  assert.equal(v[4].reason, "并入 K3");
  assert.deepEqual(JSON.parse(v[2].refs), ["S1/T1#E1", "S1/T2#E1"], "update keeps the earlier evidence");
  assert.deepEqual(JSON.parse(v[3].refs), ["S1/T1#E1", "S1/T2#E1"], "K codes expand to their current refs");
  const b = briefing(db, { projectId: 1, projectPath: repo });
  assert.ok(b.includes("- K3 ") && !b.includes("- K1 ") && !b.includes("- K2 "));
});

test("state items: kept ones are copied, every old item must be accounted for, promotion points at a new item", () => {
  const { db, t, ready, sub } = setup();
  t.human("先别提交");
  assert.ok(sub(ready(), { ...empty, session_state: { items: [{ type: "instruction", content: "先别提交", refs: ["S1/T1#E1"] }, { type: "todo", content: "写测试" }], closed: [] } }).ok);
  t.human("以后都先别提交，等我看 diff");
  const id = ready();
  const bad = sub(id, { ...empty, session_state: { items: [{ from: 2 }], closed: [] } });
  assert.match(bad.text, /上一版第 1 项（"先别提交"）既没有被 from 引用，也不在 closed 里/);
  const ok = sub(id, {
    ...empty,
    knowledge: [{ ...rule(["S1/T2#E1"]), id: "new1", body: "提交前先等用户看 diff。" }],
    session_state: { items: [{ from: 2 }], closed: [{ no: 1, outcome: "promoted", to: "new1" }] },
  });
  assert.ok(ok.ok, ok.text);
  const st = db.prepare("SELECT items, closed FROM states ORDER BY id DESC LIMIT 1").get() as any;
  assert.deepEqual(JSON.parse(st.items), [{ type: "todo", content: "写测试", condition: null, as_of: TODAY }]);
  assert.deepEqual(JSON.parse(st.closed), [{ no: 1, outcome: "promoted", to: "K1" }]);
});

test("a rewind undoes the run and its knowledge disappears from the briefing", () => {
  const { db, t, ready, sub, prep } = setup();
  const first = t.human("以后先讨论再动手");
  const reply = t.say("好");
  assert.ok(sub(ready(), { ...empty, knowledge: [rule()] }).ok);
  assert.match(briefing(db, { projectId: 1, projectPath: repo }), /K1/);
  t.human("当我没说", first);
  void reply;
  const p = prep();
  assert.equal(p.status, "ready");
  assert.equal(briefing(db, { projectId: 1, projectPath: repo }), "", "nothing left to inject");
});

test("summaries fold in batches of K behind the newest N", () => {
  const { db, t, ready, sub } = setup();
  t.human("x");
  const n = FOLD.n + FOLD.k + 3;
  const ms = Array.from({ length: n }, (_, i) => ({ title: `话题${i + 1}`, body: `正文${i + 1}`, refs: ["S1/T1#E1"] }));
  assert.ok(sub(ready(), { ...empty, summaries: ms }).ok);
  const block = summariesBlock(db, 1);
  assert.match(block, /^M1 话题1\nM2 话题2/);
  assert.ok(block.includes(`M${FOLD.k} 话题${FOLD.k}\n\n## M${FOLD.k + 1} 话题${FOLD.k + 1}`), "boundary on a multiple of K");
});

test("a batch is whole turns, at least one", () => {
  const e = (turnNo: number, len: number) => ({ turnNo, entryNo: 1, text: "x".repeat(len) }) as any;
  assert.deepEqual(cutBatch([e(1, 60), e(1, 60), e(2, 10)], 100).map((x) => x.turnNo), [1, 1]);
  assert.deepEqual(cutBatch([e(1, 30), e(2, 30), e(3, 50)], 100).map((x) => x.turnNo), [1, 2]);
});
