// Probe mod for e0: checks the Claude Code behaviours refrain's design depends on (design.md 7.8).
// Driven from outside through control.json; everything it sees goes to raw/probe.log.
import type { Register } from "claude-code";

// Set to where this repository is checked out before loading the probe.
const BASE = "/path/to/refrain/experiments/e0-probes";
const LOG = BASE + "/raw/probe.log";
const CONTROL = BASE + "/work/control.json";
const AGENT = "probe:worker";

type Control = {
  spawn?: string; // task for the hidden worker agent
  timerCompact?: number; // ms after turn end, then $.session.compact()
  keepTurns?: number; // on compaction: keep the last N user turns verbatim
};

const workers = new Set<string>();

async function log($: any, tag: string, data: unknown) {
  let old = "";
  try { old = await $.fs.read(LOG); } catch {}
  const line = JSON.stringify({ t: new Date().toISOString(), tag, data });
  await $.fs.write(LOG, old + line + "\n");
}

async function control($: any): Promise<Control> {
  try { return JSON.parse(await $.fs.read(CONTROL)); } catch { return {}; }
}

// One-shot flags: consume them so a later turn does not repeat the action.
async function consume($: any, key: keyof Control) {
  const c = await control($);
  delete c[key];
  await $.fs.write(CONTROL, JSON.stringify(c));
}

function brief(m: any) {
  return {
    role: m.role,
    chars: m.text?.length ?? 0,
    head: (m.text ?? "").slice(0, 40),
    toolUses: m.toolUses?.length ?? 0,
    toolResults: m.toolResults?.length ?? 0,
    handle: Boolean(m.handle),
  };
}

// A user turn starts at a user message that carries text and no tool results.
function isUserTurn(m: any) {
  return m.role === "user" && !(m.toolResults?.length) && Boolean(m.text);
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const r = await next(e);
    await $.tool.register({
      name: "ping",
      description: "Probe tool. Call it when your task tells you to; pass a short note.",
      inputSchema: { type: "object", properties: { note: { type: "string" } } },
      isDeferred: false,
    });
    await $.agent.register({
      name: "worker",
      description: "Probe worker, spawned only by the probe mod.",
      prompt: "You are a probe worker. Do exactly what the task says, then reply with one short line.",
      tools: ["mcp__probe__ping", "Read"],
      model: "haiku",
      omitClaudeMd: true,
      background: true,
    });
    await log($, "session.start", { version: await $.session.version() });
    return r;
  });

  on("agent.offer", { agent: AGENT }, () => ({ isOffered: false }));

  on("tool.describe", { tool: "mcp__probe__ping" }, async ($, e, next) => {
    const r = await next(e);
    await log($, "tool.describe", { isDeferred: e.isDeferred ?? false });
    return r;
  });

  on("tool.call", { tool: "mcp__probe__ping" }, async ($, e: any) => {
    await log($, "ping", { agentId: e.agentId ?? null, worker: e.agentId ? workers.has(e.agentId) : false, note: e.note });
    return { result: `pong (${e.agentId ? "agent" : "main"})` };
  });

  // A background agent's end reaches the main model as a task notification; refrain's scribe must not.
  on("prompt.submit", async ($, e: any, next) => {
    const ours = [...workers].some((id) => e.text?.includes(id));
    await log($, "prompt.submit", { origin: e.origin, isMeta: e.isMeta ?? false, ours, head: (e.text ?? "").slice(0, 160) });
    if (ours) return { drop: "probe worker finished" };
    // C6b: compact at the moment the user comes back, before the prompt is sent.
    const c = await control($);
    if (c.compactOnSubmit && !e.isMeta) {
      await consume($, "compactOnSubmit" as keyof Control);
      try {
        const res: any = await $.session.compact();
        await log($, "submit.compact", { ok: !res.skip, skip: res.skip ?? null });
      } catch (err) {
        await log($, "submit.compact.error", String(err));
      }
    }
    return next(e);
  });

  on("turn.complete", async ($, e: any, next) => {
    const r = await next(e);
    const usage = await $.session.usage();
    await log($, "turn.complete", { agentId: e.agentId ?? null, answer: (e.answer ?? "").slice(0, 80), turnUsage: e.usage, sessionCostUsd: usage.cost?.usd });
    if (e.agentId) return r;
    const c = await control($);
    if (c.spawn) {
      await consume($, "spawn");
      const s: any = await $.agent.spawn({ subagentType: AGENT, prompt: c.spawn, description: "probe worker" });
      if (s.agentId) workers.add(s.agentId);
      await log($, "spawn", s);
    }
    if (c.timerCompact) {
      const ms = c.timerCompact;
      await consume($, "timerCompact");
      $.clock.after(ms, async () => {
        try {
          const res: any = await $.session.compact();
          await log($, "timer.compact", { ok: !res.skip, skip: res.skip ?? null });
        } catch (err) {
          await log($, "timer.compact.error", String(err));
        }
      });
      await log($, "timer.set", { ms });
    }
    return r;
  });

  on("session.compact", async ($, e: any, next) => {
    const msgs = e.messages as any[];
    await log($, "session.compact", { trigger: e.trigger, agentId: e.agentId ?? null, count: msgs.length, messages: msgs.map(brief) });
    const c = await control($);
    if (e.agentId || !c.keepTurns) return next(e);
    // Keep the tail from the N-th last user turn, as refrain's handoff will (design.md 4.4).
    const starts = msgs.map((m, i) => (isUserTurn(m) ? i : -1)).filter((i) => i >= 0);
    const from = starts[Math.max(0, starts.length - c.keepTurns)] ?? msgs.length;
    await log($, "handoff", { userTurnStarts: starts, keepFrom: from });
    const lead = { role: "user", text: `[[PROBE HANDOFF]] earlier part replaced; ${from} messages dropped. Code word: HERON.`, toolUses: [] };
    return { messages: [lead, ...msgs.slice(from)] };
  });
};
