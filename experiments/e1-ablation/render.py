# Render a CC transcript the way refrain's reader will (design.md 6.2, 6.4, ADR-0012, ADR-0014),
# for the e1 pre-experiment only. Throwaway: the real reader is core/ in TypeScript.
# usage: python3 render.py <transcript.jsonl> <out-prefix> [session-label]
import json, sys

SRC, OUT = sys.argv[1], sys.argv[2]
LABEL = sys.argv[3] if len(sys.argv) > 3 else "S1"
ASSIST_CAP = 4000  # ~2000 tokens of Chinese/English mix
HEAD, TAIL = 200, 200

rows = [json.loads(l) for l in open(SRC, encoding="utf-8", errors="ignore") if l.strip()]
by_uuid = {r["uuid"]: r for r in rows if r.get("uuid")}

def effective_path():
    # Walk back from the newest row; cross compaction boundaries via logicalParentUuid (design.md 6.4).
    last = next(r for r in reversed(rows) if r.get("uuid") and not r.get("isSidechain"))
    path, cur = [], last
    while cur:
        path.append(cur)
        if cur.get("subtype") == "compact_boundary":
            nxt = cur.get("logicalParentUuid")
        else:
            nxt = cur.get("parentUuid")
        cur = by_uuid.get(nxt) if nxt else None
    path.reverse()
    # Copies of a kept tail carry their original timestamps, earlier than the boundary (e0 C5).
    out, boundary_ts = [], None
    for r in path:
        if r.get("subtype") == "compact_boundary":
            boundary_ts = r.get("timestamp")
            continue
        if boundary_ts and r.get("timestamp", "") < boundary_ts:
            continue
        out.append(r)
    return out

def clip(s, head=HEAD, tail=TAIL):
    s = s.strip()
    if len(s) <= head + tail + 20:
        return s
    return f"{s[:head]} ……（中间省略 {len(s) - head - tail} 字符）…… {s[-tail:]}"

def text_of(content):
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")

def render_paste(t):
    # Pasted spans are context, not the user's own words (ADR-0014).
    while "<pasted_content" in t and "</pasted_content>" in t:
        a = t.index("<pasted_content"); a2 = t.index(">", a) + 1; b = t.index("</pasted_content>", a2)
        t = t[:a] + "〔粘贴〕" + clip(t[a2:b], 300, 200) + "〔粘贴结束〕" + t[b + len("</pasted_content>"):]
    return t

def tool_input_brief(inp):
    for k in ("command", "file_path", "pattern", "url", "query", "description", "prompt"):
        if k in inp:
            return clip(str(inp[k]), 250, 50)
    return clip(json.dumps(inp, ensure_ascii=False), 250, 50)

def result_text(block):
    c = block.get("content")
    if isinstance(c, list):
        c = "\n".join(x.get("text", "") for x in c if isinstance(x, dict))
    return c if isinstance(c, str) else json.dumps(c, ensure_ascii=False)

tool_names, lines, index = {}, [], []
turn, entry = 0, 0

def emit(role, body, r):
    global entry
    entry += 1
    addr = f"{LABEL}/T{turn}#E{entry}"
    lines.append(f"[{addr} @{role}] {body}")
    index.append({"addr": addr, "uuid": r.get("uuid"), "ts": r.get("timestamp"), "role": role, "turn": turn, "chars": len(lines[-1])})

for r in effective_path():
    t, m = r.get("type"), r.get("message") or {}
    if r.get("isMeta") or r.get("isCompactSummary") or t not in ("user", "assistant"):
        continue
    c = m.get("content")
    if t == "user":
        if (r.get("origin") or {}).get("kind") == "human":
            turn += 1; entry = 0
            emit("user", render_paste(text_of(c)).strip(), r)
            continue
        txt = text_of(c) if not isinstance(c, list) else ""
        if isinstance(c, str) and c.startswith("[Request interrupted by user"):
            emit("user", "〔打断〕", r); continue
        if isinstance(c, list):
            for b in c:
                if b.get("type") == "text" and b.get("text", "").startswith("[Request interrupted by user"):
                    emit("user", "〔打断〕", r)
                elif b.get("type") == "tool_result":
                    if r.get("toolDenialKind") == "user-rejected" or (r.get("toolUseResult") or {}) == "user-rejected":
                        emit("user", "〔拒绝了上面的工具调用〕", r); continue
                    body = result_text(b)
                    name = tool_names.get(b.get("tool_use_id"), "工具")
                    ok = "失败" if b.get("is_error") else "成功"
                    emit("observation", f"{name} {ok}，原始 {len(body.encode()) / 1024:.1f}KB：{clip(body)}", r)
        continue
    if not isinstance(c, list):
        continue
    for b in c:
        if b.get("type") == "text" and b.get("text", "").strip():
            emit("assistant", clip(b["text"], ASSIST_CAP // 2, ASSIST_CAP // 2), r)
        elif b.get("type") == "tool_use":
            tool_names[b.get("id")] = b.get("name")
            emit("assistant", f"调用 {b.get('name')}：{tool_input_brief(b.get('input') or {})}", r)

open(OUT + ".txt", "w", encoding="utf-8").write("\n".join(lines) + "\n")
open(OUT + ".index.json", "w", encoding="utf-8").write(json.dumps(index, ensure_ascii=False))
print(f"turns {turn}, entries {len(index)}, chars {sum(len(l) for l in lines)}")
