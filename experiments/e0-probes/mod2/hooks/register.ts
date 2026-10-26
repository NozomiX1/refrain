// Companion for C6c: a different plugin fires the compaction, so probe's own session.compact hook is not re-entry.
import type { Register } from "claude-code";

// Set to where this repository is checked out before loading the probe.
const BASE = "/path/to/refrain/experiments/e0-probes";

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const r = await next(e);
    $.clock.every(3000, async () => {
      let c: any = {};
      try { c = JSON.parse(await $.fs.read(BASE + "/work/companion.json")); } catch { return; }
      if (!c.compact) return;
      await $.fs.write(BASE + "/work/companion.json", "{}");
      const res: any = await $.session.compact();
      const old = await $.fs.read(BASE + "/raw/probe.log").catch(() => "");
      await $.fs.write(BASE + "/raw/probe.log", old + JSON.stringify({ t: new Date().toISOString(), tag: "companion.compact", data: { ok: !res.skip } }) + "\n");
    });
    return r;
  });
};
