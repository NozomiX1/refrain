import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { disableAutoMemory } from "../core/enable.ts";

test("auto memory is switched off in the project's local settings, keeping what is there", () => {
  const p = mkdtempSync(join(tmpdir(), "refrain-proj-"));
  mkdirSync(join(p, ".claude"));
  writeFileSync(join(p, ".claude/settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
  assert.equal(disableAutoMemory(p), join(p, ".claude/settings.local.json"));
  assert.deepEqual(JSON.parse(readFileSync(join(p, ".claude/settings.local.json"), "utf8")), { permissions: { allow: ["Bash(ls)"] }, autoMemoryEnabled: false });
  assert.equal(disableAutoMemory(p), null, "already off");
  writeFileSync(join(p, ".claude/settings.local.json"), "{ // a comment\n}");
  assert.equal(disableAutoMemory(p), null, "not plain JSON: left alone");
  const fresh = mkdtempSync(join(tmpdir(), "refrain-proj-"));
  assert.ok(disableAutoMemory(fresh));
});
