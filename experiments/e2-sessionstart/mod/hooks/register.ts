// Probe mod for e2: which conversations get SessionStart's additionalContext, after which events, and whether
// large items reach the model whole (design.md 4.1; the question raised after s1 run 3).
// Everything it sees goes to raw/probe.log; work/control.json asks it to spawn a background agent or pick a compaction.
import type { Register } from "claude-code";

// Set to where this repository is checked out before loading the probe.
const BASE = "/path/to/refrain/experiments/e2-sessionstart";
const LOG = BASE + "/raw/probe.log";
const CONTROL = BASE + "/work/control.json";
const SIZES = [10000, 30000, 100000]; // characters per additionalContext item
const AGENT = "probe2:worker";

let version = 0;

async function log($: any, line: string) {
  let old = "";
  try {
    old = await $.fs.read(LOG);
  } catch {}
  await $.fs.write(LOG, old + new Date().toISOString().slice(11, 19) + " " + line + "\n");
}

async function control($: any): Promise<any> {
  try {
    return JSON.parse(await $.fs.read(CONTROL));
  } catch {
    return {};
  }
}

// An item of exactly `size` characters: BEGIN, MID and END marks around plain filler.
function item(size: number, tag: string): string {
  const head = `[[${tag} BEGIN]]`, mid = `[[${tag} MID]]`, end = `[[${tag} END]]`;
  const n = size - head.length - mid.length - end.length;
  const body = "abcdefghij0123456789 ".repeat(Math.ceil(n / 21)).slice(0, n);
  return head + body.slice(0, n >> 1) + mid + body.slice(n >> 1) + end;
}

// What a request actually carries: for each tag seen, whether BEGIN, MID and END are all there, and its length.
function scan(msgs: any[]): string[] {
  const out: string[] = [];
  msgs.forEach((msg: any, i: number) => {
    for (const b of msg.content ?? []) {
      const t = typeof b.text === "string" ? b.text : typeof b.content === "string" ? b.content : "";
      for (const m of t.matchAll(/\[\[(S\d+k-v\d+-\w+) BEGIN\]\]/g)) {
        const tag = m[1];
        const start = t.indexOf(m[0]);
        const endMark = `[[${tag} END]]`;
        const stop = t.indexOf(endMark, start);
        const whole = stop >= 0 ? stop + endMark.length - start : -1;
        out.push(`${tag}@msg${i}:${t.includes(`[[${tag} MID]]`) ? "mid" : "NO-MID"}:${whole >= 0 ? whole : "NO-END"}`);
      }
      if (t.includes("[[PROBE HANDOFF")) out.push(`handoff@msg${i}`);
    }
  });
  return out;
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const r = await next(e);
    await $.agent.register({
      name: "worker",
      description: "e2 probe worker, spawned only by the probe.",
      prompt: "You are a probe worker. Reply with one short line: OK.",
      tools: [],
      model: "haiku",
      omitClaudeMd: true,
      background: true,
    });
    return r;
  });

  on("agent.offer", { agent: AGENT }, () => ({ isOffered: false }));

  on("classic.SessionStart", async ($, e: any, next) => {
    const r: any = await next(e);
    version += 1;
    await log($, `SessionStart source=${e.source} agent_type=${e.agent_type ?? "-"} -> v${version} expired=${e.prompt_cache_likely_expired ?? "-"} ctx=${e.context_tokens ?? "-"} since=${e.seconds_since_last_response ?? "-"}`);
    const items = SIZES.map((s) => item(s, `S${s / 1000}k-v${version}-${e.source}`));
    return { ...r, additionalContext: [...(r?.additionalContext ?? []), ...items] };
  });

  on("classic.SubagentStart", async ($, e: any, next) => {
    await log($, `SubagentStart agent_type=${e.agent_type ?? "-"} agent_id=${e.agent_id ?? "-"}`);
    return next(e);
  });

  on("prompt.context", async ($, e: any, next) => {
    const r: any = await next(e);
    await log($, `prompt.context blocks=[${r.blocks.map((b: any) => b.name).join(",")}]`);
    return r;
  });

  on("turn.step", async function* ($: any, e: any, next: any) {
    const msgs = await $.session.messages(e.agentId ? { as: "api", agentId: e.agentId } : { as: "api" });
    const seen = Array.isArray(msgs) ? scan(msgs) : ["(deny)"];
    await log($, `turn.step ${e.agentId ? "agent " + e.agentId : "main"} #${e.index}: ${Array.isArray(msgs) ? msgs.length : "?"} msgs, sees [${seen.join(", ")}]`);
    return yield* next(e);
  });

  on("session.compact", async ($, e: any, next) => {
    const c = await control($);
    await log($, `session.compact trigger=${e.trigger} agent=${e.agentId ?? "-"} msgs=${e.messages.length} mode=${c.compact ?? "ours"}`);
    if (e.agentId || e.trigger === "precompute" || c.compact === "native") return next(e);
    // Keep the last user turn, as refrain's handoff does.
    const isTurn = (m: any) => m.role === "user" && !m.toolResults?.length && Boolean(m.text);
    const from = e.messages.findLastIndex(isTurn);
    return { messages: [{ role: "user", text: `[[PROBE HANDOFF trigger=${e.trigger}]]`, toolUses: [] }, ...e.messages.slice(Math.max(0, from))] };
  });

  on("turn.complete", async ($, e: any, next) => {
    const r = await next(e);
    if (e.agentId) {
      await log($, `turn.complete agent ${e.agentId}`);
      return r;
    }
    const c = await control($);
    if (c.spawn) {
      await $.fs.write(CONTROL, JSON.stringify({ ...c, spawn: false }));
      const s: any = await $.agent.spawn({ subagentType: AGENT, prompt: "Reply OK.", description: "e2 probe worker" });
      await log($, `spawned ${s.agentId ?? JSON.stringify(s)}`);
    }
    return r;
  });
};
