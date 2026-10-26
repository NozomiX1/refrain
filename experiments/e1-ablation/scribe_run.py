# Run the scribe prompt over a rendered transcript, batch by batch, for the e1 pre-experiment.
# Throwaway stand-in for core/: no submit tool, no search/read; the model returns the submit JSON as text.
# usage: python3 scribe_run.py <rendered.txt> <out-dir> <project-name> <project-path> [max-batch-chars] [index.json]
# Re-running on a longer cut of the same transcript continues from the turns already processed in <out-dir>.
import datetime as dt, json, re, signal, subprocess, sys, os, pathlib

SRC, OUT, PROJ, PROJ_PATH = sys.argv[1:5]
MAX_CHARS = int(sys.argv[5]) if len(sys.argv) > 5 else 45000
# Turn -> local date from the render index; without it, fall back to dates mentioned in the text (cut 1).
TURN_DATE, ADDR_TIME = {}, {}
if len(sys.argv) > 6:
    for e in json.loads(pathlib.Path(sys.argv[6]).read_text(encoding="utf-8")):
        if e.get("ts"):
            t = dt.datetime.fromisoformat(e["ts"].replace("Z", "+00:00")).astimezone()
            d = t.date().isoformat()
            TURN_DATE[e["turn"]] = max(TURN_DATE.get(e["turn"], d), d)
            ADDR_TIME[e["addr"]] = t.strftime("%m-%d %H:%M")
HERE = pathlib.Path(__file__).parent
SYSTEM = (HERE.parent.parent / "docs/model-facing/scribe-system.md").read_text(encoding="utf-8").split("\n---\n", 1)[1]
SYSTEM += "\n\n# 本次运行的特别说明\n\n这次没有 `submit` 工具，也没有 `search` 和 `read`。把你要提交的 JSON 直接作为回复输出：只输出这一个 JSON 对象，不要任何别的文字或代码块标记。运行环境报告的日期可能不同，以输入里写的“今天是”为准。\n"
N, K, TITLE_CAP = 8, 8, 160
os.makedirs(OUT, exist_ok=True)

entries = re.split(r"\n(?=\[S1/T\d+#E\d+ @)", pathlib.Path(SRC).read_text(encoding="utf-8").strip())
turns = {}
for e in entries:
    t = int(re.match(r"\[S1/T(\d+)#", e).group(1))
    turns.setdefault(t, []).append(e)

st = {"k": {}, "next_k": 1, "m": [], "next_m": 1, "project": [], "session": [], "runs": [], "last_turn": 0}
if pathlib.Path(OUT, "state.json").exists():  # resume after an interrupted run, or continue on a longer cut
    st = json.loads(pathlib.Path(OUT, "state.json").read_text(encoding="utf-8"))

# Whole turns per batch (design.md 4.3 step 2), starting after the last processed turn (the bookmark).
batches, cur, size = [], [], 0
for t in sorted(x for x in turns if x > st["last_turn"]):
    block = "\n".join(turns[t])
    if cur and size + len(block) > MAX_CHARS:
        batches.append(cur); cur, size = [], 0
    cur.append((t, block)); size += len(block)
if cur:
    batches.append(cur)
CAT = {"rule": "规则", "understanding": "背景和决定", "goal": "目标", "reference": "参考"}
TYPE = {"phase": "阶段", "progress": "进度", "todo": "待办", "verify": "待核实", "authorization": "授权", "instruction": "临时指令"}

def knowledge_block(dated=True):
    out = []
    for scope, title in (("global", "## 跨项目知识"), ("project", "## 本项目知识")):
        items = {c: [] for c in CAT}
        for code, k in sorted(st["k"].items(), key=lambda x: int(x[0][1:])):
            if k["scope"] == scope:
                tags = ("〔推断〕" if k["epistemic"] == "inference" else "") + ("〔观察〕" if k["epistemic"] == "observed" else "") + ("〔待定〕" if k.get("pending") else "")
                if dated and (k["epistemic"] == "observed" or k["category"] == "reference"):
                    tags += f"〔截至 {k['as_of'][5:]}〕"
                items[k["category"]].append(f"- {code} {k['body']}{tags}")
        sec = [f"### {CAT[c]}\n" + "\n".join(v) for c, v in items.items() if v]
        if sec:
            out.append(title + "\n\n" + "\n\n".join(sec))
    return "\n\n".join(out)

def state_block(items):
    if not items:
        return "（空）"
    lines = []
    for i, it in enumerate(items, 1):
        cond = f"（条件：「{it['condition']}」）" if it.get("condition") else ""
        lines.append(f"{i}. {TYPE.get(it['type'], it['type'])}：{it['content']}{cond}〔截至 {it['as_of'][5:]}〕")
    return "\n".join(lines)

def summaries_block():
    ms = st["m"]
    if not ms:
        return "（空）"
    boundary = max(0, (len(ms) - N) // K * K)
    folded = ms[:boundary][-TITLE_CAP:]
    lines = [f"M{m['no']} {m['title']}" for m in folded]
    lines += [f"## M{m['no']} {m['title']}\n\n{m['body']}" for m in ms[boundary:]]
    return "\n\n".join(lines)

def scribe_input(batch, today):
    return "\n\n".join([
        "# 已有的长期知识\n\n" + (knowledge_block() or "（空）"),
        "# 本会话之前的摘要\n\n" + summaries_block(),
        "# 项目现状\n\n" + state_block(st["project"]),
        "# 本会话现状\n\n" + state_block(st["session"]),
        f"# 这次要处理的对话\n\n今天是 {today}。项目：{PROJ}（{PROJ_PATH}）。会话：S1。\n\n" + "\n".join(batch),
    ])

def call(prompt, limit=300):
    # A call once hung for 44 minutes; kill the whole process group on timeout and retry.
    for attempt in range(3):
        p = subprocess.Popen(["claude", "-p", "--model", "haiku", "--system-prompt", SYSTEM, "--tools", "", "--setting-sources", "",
                              "--no-session-persistence", "--output-format", "json"],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd="/tmp", start_new_session=True)
        try:
            out, _ = p.communicate(prompt, timeout=limit)
            return json.loads(out)
        except (subprocess.TimeoutExpired, json.JSONDecodeError) as err:
            try: os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            p.communicate()
            print(f"  call failed ({type(err).__name__}), retry {attempt + 1}", flush=True)
    raise RuntimeError("claude -p kept failing")

def parse(text):
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t)
    return json.loads(t[t.index("{"): t.rindex("}") + 1])

def apply_state(old, new, today):
    if new is None:
        return old
    out = []
    for it in new.get("items", []):
        if "from" in it and set(it) <= {"from"}:
            out.append(old[it["from"] - 1])
        else:
            prev = old[it["from"] - 1] if it.get("from") else None
            same = prev and prev["content"] == it.get("content")
            out.append({"type": it.get("type", prev["type"] if prev else "todo"), "content": it.get("content", prev["content"] if prev else ""),
                        "condition": it.get("condition"), "as_of": prev["as_of"] if same else today})
    return out

def apply(sub, today):
    temp = {}
    for s in sub.get("summaries", []):
        st["m"].append({"no": st["next_m"], "title": s["title"], "body": s["body"], "refs": s.get("refs", [])}); st["next_m"] += 1
    for op in sub.get("knowledge", []):
        if op["op"] == "create":
            code = f"K{st['next_k']}"; st["next_k"] += 1
            if op.get("id"):
                temp[op["id"]] = code
            st["k"][code] = {"scope": op.get("scope", "project"), "category": op.get("category", "understanding"), "epistemic": op.get("epistemic", "quote"),
                             "pending": op.get("pending", False), "body": op["body"], "as_of": today}
        elif op["op"] == "update" and op.get("code") in st["k"]:
            k = st["k"][op["code"]]
            k.update({f: op[f] for f in ("scope", "category", "epistemic", "pending", "body") if f in op}); k["as_of"] = today
        elif op["op"] == "archive":
            st["k"].pop(op.get("code"), None)
    st["project"] = apply_state(st["project"], sub.get("project_state"), today)
    st["session"] = apply_state(st["session"], sub.get("session_state"), today)

for i, tb in enumerate(batches, 1):
    batch = [b for _, b in tb]
    if TURN_DATE:
        today = max(TURN_DATE[t] for t, _ in tb)
    else:
        m = re.findall(r"\d{4}-\d{2}-\d{2}", "\n".join(batch))
        today = "2026-10-10" if not m else max(m)
    prompt = scribe_input(batch, today)
    for attempt in range(2):
        res = call(prompt)
        try:
            sub = parse(res["result"]); break
        except Exception as err:
            prompt += f"\n\n（上一次的回复不是合法的 JSON：{err}。请只输出 JSON。）"
    else:
        print(f"batch {i}: unparsable, skipped"); continue
    apply(sub, today)
    st["last_turn"] = tb[-1][0]
    st["runs"].append({"batch": len(st["runs"]) + 1, "turns": [tb[0][0], tb[-1][0]], "chars": sum(len(b) for b in batch),
                       "cost": res.get("total_cost_usd"), "usage": res.get("usage")})
    pathlib.Path(OUT, f"batch{len(st['runs']):02d}.json").write_text(json.dumps({"input_chars": len(prompt), "submit": sub}, ensure_ascii=False, indent=1), encoding="utf-8")
    pathlib.Path(OUT, "state.json").write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"batch {i}/{len(batches)} (T{tb[0][0]}-T{tb[-1][0]}): {len(sub.get('summaries', []))} summaries, {len(sub.get('knowledge', []))} ops, cost {res.get('total_cost_usd'):.4f}", flush=True)

briefing = "\n\n".join(x for x in [knowledge_block(), "## 项目现状\n\n" + state_block(st["project"]), "## 本会话现状\n\n" + state_block(st["session"])] if x)
pathlib.Path(OUT, "briefing.md").write_text(briefing + "\n", encoding="utf-8")
# Summary time = its last cited entry, as search shows it (design.md 4.7).
when = lambda m: max((ADDR_TIME[r] for r in m["refs"] if r in ADDR_TIME), default="")
pathlib.Path(OUT, "summaries.md").write_text("\n\n".join(f"M{m['no']}  {when(m)}  {m['title']}\n出处：{', '.join(m['refs'])}\n{m['body']}" for m in st["m"]) + "\n", encoding="utf-8")
print("batches", len(batches), "total cost", sum(r["cost"] or 0 for r in st["runs"]))
