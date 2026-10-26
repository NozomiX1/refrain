import assert from "node:assert/strict";
import { test } from "node:test";
import { due } from "../timer/hooks/register.ts";

const turn = { turnEndedAt: "2026-10-25T10:00:00Z", contextTokens: 150000, cacheTtlMs: 3600000, handoffTokens: 30000, idle: { enabled: true, minTokens: 60000 } };
const at = (min: number) => Date.parse(turn.turnEndedAt) + min * 60000;

test("idle compaction: only after the cache expired, on a big enough context, with a handoff at most half of it", () => {
  assert.equal(due(turn, at(59)), false, "cache still warm");
  assert.equal(due(turn, at(61)), true);
  assert.equal(due({ ...turn, contextTokens: 50000 }, at(61)), false, "too small to be worth it");
  assert.equal(due({ ...turn, handoffTokens: 80000 }, at(61)), false, "handoff more than half the context");
  assert.equal(due({ ...turn, idle: { ...turn.idle, enabled: false } }, at(61)), false, "switched off");
  assert.equal(due({ ...turn, cacheTtlMs: 300000 }, at(6)), true, "5-minute cache");
});
