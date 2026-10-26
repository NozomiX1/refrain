// Transcripts recorded from a real CC 2.1.310 session (experiments/s2-fixtures, scrubbed by tools/scrub-transcript.py).
// The reader's output is compared with a stored copy; REFRAIN_UPDATE_SNAPSHOTS=1 rewrites it after a reviewed change.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readSession } from "../core/transcript.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function render(name: string): string {
  const { entries, warnings } = readSession(join(dir, `${name}.jsonl`));
  assert.deepEqual(warnings, []);
  let turn = 0, entry = 0;
  return entries.map((e) => {
    if (e.newTurn) [turn, entry] = [turn + 1, 0];
    return `T${turn}#E${++entry} ${e.role}${e.kind === "text" ? "" : " " + e.kind} ${e.text}`;
  }).join("\n") + "\n";
}

for (const name of ["recorded-a", "recorded-b"]) {
  test(`${name}: the reader's output matches the stored copy`, () => {
    const got = render(name);
    const path = join(dir, `${name}.entries.txt`);
    if (process.env.REFRAIN_UPDATE_SNAPSHOTS || !existsSync(path)) writeFileSync(path, got);
    assert.equal(got, readFileSync(path, "utf8"));
  });
}

test("recorded-a: paste, rejection, interrupts, the Explore turn and the compaction come out right", () => {
  const out = render("recorded-a");
  assert.match(out, /^T1#E1 user 看看这个方案，\s+〔粘贴〕Proposal from another assistant:[\s\S]*?〔粘贴结束〕\s+我只同意第 1 点/m, "pasted text marked, the user's words kept");
  assert.match(out, /^T3#E3 user tool_result 〔拒绝了上面的工具调用〕$/m, "the user's own rejection");
  assert.match(out, /^T3#E4 user 〔打断〕$/m, "interrupted for tool use");
  assert.match(out, /^T4#E3 user 〔打断〕$/m, "interrupted while answering");
  assert.doesNotMatch(out, /task-notification|<command-name>/, "notifications and local commands are not the user's words");
  // The compaction rewrote its kept tail after the boundary; the copies must not appear a second time.
  assert.equal(out.match(/用 Agent 工具起一个 Explore/g)?.length, 1);
  assert.match(out, /^T7#E1 user 刚才我拒绝了什么命令？一句话。$/m);
});
