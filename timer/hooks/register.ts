// refrain-timer: starts refrain's idle compaction (design.md 4.5). A separate plugin because a mod's own
// timer-started compaction skips its own session.compact hook (e0 C6); started from here, refrain's hook runs.
import type { Register } from "claude-code";

const CHECK_MS = 60000;

type Turn = { turnEndedAt: string; contextTokens: number; cacheTtlMs: number; handoffTokens: number; idle: { enabled: boolean; minTokens: number } };

let busy = false; // a main turn is running: never compact under it
let compactedAfter = ""; // the turn end we already compacted after

// The cache has expired, so the next request re-reads the whole context at full price anyway; swap it for the
// handoff when the context is big enough to be worth it and the handoff is at most half of it (4.5).
export function due(t: Turn, now: number): boolean {
  return t.idle.enabled && now - Date.parse(t.turnEndedAt) > t.cacheTtlMs && t.contextTokens >= t.idle.minTokens && t.handoffTokens * 2 <= t.contextTokens;
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const r = await next(e);
    // refrain's data dir, as its core resolves it.
    const home = (await $.process.run(["sh", "-c", 'printf %s "${REFRAIN_HOME:-$HOME/.refrain}"'])).stdout;
    $.clock.every(CHECK_MS, async () => {
      if (busy) return;
      let turn: Turn | undefined;
      try {
        turn = JSON.parse(await $.fs.read(`${home}/status/${await $.session.id()}.json`)).turn;
      } catch {
        return; // refrain has not seen a turn of this session yet
      }
      if (!turn || turn.turnEndedAt === compactedAfter || !due(turn, Date.now())) return;
      compactedAfter = turn.turnEndedAt;
      await $.session.compact();
    });
    return r;
  });

  // Only the person's own prompt starts a turn here: a task notification may be dropped (refrain drops the
  // scribe's) and then no turn.complete would ever clear the flag.
  // shortcut: prompts arriving another way (Remote Control) are not counted; add their origin kinds if that is used.
  on("prompt.submit", async ($, e: any, next) => {
    if (e.origin?.kind === "composer") busy = true;
    return next(e);
  });

  on("turn.complete", async ($, e: any, next) => {
    if (!e.agentId) busy = false;
    return next(e);
  });
};
