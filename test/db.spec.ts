import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { address, bookmark, ensureProject, ensureSession, finishRun, openDb, pending, startRun } from "../core/db.ts";
import { readSession } from "../core/transcript.ts";
import { transcript } from "./fixture.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "refrain-"));
  const db = openDb(join(dir, "memory.db"));
  const sid = ensureSession(db, "cc-1", ensureProject(db, "/p"), join(dir, "t.jsonl"));
  const t = transcript();
  const read = () => {
    t.write(join(dir, "t.jsonl"));
    return readSession(join(dir, "t.jsonl")).entries;
  };
  // One scribe run over whatever is pending, without the model.
  const run = () => {
    const p = pending(db, sid, read());
    const id = startRun(db, sid, bookmark(db, sid));
    finishRun(db, id, sid, p.entries);
    return { ...p, runId: id, addrs: p.entries.map((e) => address(sid, e)) };
  };
  return { db, sid, t, read, run };
}

test("addresses continue across runs, including a turn split by the bookmark", () => {
  const { t, run } = setup();
  t.human("一");
  t.say("回一");
  assert.deepEqual(run().addrs, ["S1/T1#E1", "S1/T1#E2"]);
  t.call("c1", "Bash", { command: "ls" });
  t.result("c1", "a b");
  t.human("二");
  assert.deepEqual(run().addrs, ["S1/T1#E3", "S1/T1#E4", "S1/T2#E1"]);
  assert.deepEqual(run().addrs, [], "nothing new");
});

test("a rewind past the bookmark undoes runs and never reuses numbers", () => {
  const { db, t, run } = setup();
  t.human("方案 A");
  const replyA = t.say("A");
  run();
  t.human("细化 A");
  t.say("A2");
  const second = run();
  assert.deepEqual(second.addrs, ["S1/T2#E1", "S1/T2#E2"]);
  // Rewind to just after the reply "A": the first run's end is still on the live path.
  t.human("换成 B", replyA);
  t.say("B");
  const after = run();
  assert.deepEqual(after.undone, [second.runId]);
  assert.deepEqual(after.addrs, ["S1/T3#E1", "S1/T3#E2"], "T2 is not reused");
  const live = db.prepare("SELECT turn_no, entry_no FROM entries WHERE status = 'active' ORDER BY id").all();
  assert.deepEqual(live.map((r: any) => `T${r.turn_no}#E${r.entry_no}`), ["T1#E1", "T1#E2", "T3#E1", "T3#E2"]);
});

test("a rewind to before the first run's end undoes everything and reprocesses the shared start", () => {
  const { db, t, run } = setup();
  const first = t.human("开头");
  t.say("回复");
  run();
  t.human("另一条路", first);
  const after = run();
  assert.equal(after.undone.length, 1);
  assert.deepEqual(after.addrs, ["S1/T2#E1", "S1/T3#E1"]);
  const n = db.prepare("SELECT COUNT(*) AS n FROM entries WHERE cc_uuid = ? AND status = 'active'").get(first) as { n: number };
  assert.equal(n.n, 1, "one live copy of the shared message");
});

test("compaction does not move the bookmark or reprocess the kept tail", () => {
  const { t, run } = setup();
  const k1 = t.human("要保留的一轮");
  const k2 = t.say("好");
  run();
  t.compact([k1, k2]);
  t.human("压缩之后");
  const r = run();
  assert.deepEqual(r.undone, []);
  assert.deepEqual(r.entries.map((e) => e.text), ["压缩之后"]);
});

test("full-text search finds Chinese text by trigram, and skips void rows", () => {
  const { db, t, run } = setup();
  const first = t.human("书记员的输出协议怎么定");
  run();
  const q = (s: string) => db.prepare("SELECT e.text FROM entries_fts f JOIN entries e ON e.id = f.rowid WHERE entries_fts MATCH ? AND e.status = 'active'").all(s);
  assert.equal(q('"输出协"').length, 1);
  t.human("算了", first);
  run();
  assert.equal(q('"输出协"').length, 1, "the reprocessed copy is found once, the void one is filtered");
});

test("opening an existing database keeps it; a different schema version is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "refrain-"));
  const p = join(dir, "memory.db");
  const db = openDb(p);
  ensureProject(db, "/p");
  db.close();
  const again = openDb(p);
  assert.equal((again.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n, 1);
  again.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
  again.close();
  assert.throws(() => openDb(p), /schema 99/);
});
