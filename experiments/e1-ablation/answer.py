# Answer the pre-registered questions under one memory condition, for the e1 pre-experiment.
# usage: python3 answer.py <condition: none|raw|refrain|full> <questions.json> <raw-transcript.txt> <scribe-out-dir> <out.json> [qa,tasks]
import json, os, pathlib, shutil, signal, subprocess, sys, tempfile

COND, QFILE, RAW, SCRIBE, OUT = sys.argv[1:6]
PARTS = sys.argv[6].split(",") if len(sys.argv) > 6 else ["qa", "tasks"]
q = json.loads(pathlib.Path(QFILE).read_text(encoding="utf-8"))

# Older question files (cut 1) predate these fields.
PROJECT, TODAY, AS_OF = q.get("project", "项目 A"), q.get("today", "2026-10-11 早上"), q.get("as_of", "2026-10-10")
base = (f"你是 Claude Code，在 {PROJECT} 项目里和这位用户长期协作。今天是 {TODAY}，用户刚开了一个新会话，"
        "上一个会话里的对话你已经看不到了。运行环境报告的日期可能不同，以这里说的为准。")
# Tasks run in their own session: asked after recall questions, the model is already primed to look things up.
ASK = {
    "qa": "用户想先确认你还记得多少，下面有一组问题。请逐题直接回答，每题用题号开头。不知道就说不知道，不要编造。\n\n",
    "tasks": "下面是用户交给你的几件事。请逐条说明你会怎么做、会注意什么（这次只说计划，不用真的执行），每条用编号开头。\n\n",
}

# Diagnostic only: the "check what you remember" framing may itself discourage looking things up.
NEUTRAL_QA = "用户问了下面几个问题。请逐题回答，每题用题号开头。不知道就说不知道，不要编造。\n\n"

def run(part):
    ask = (NEUTRAL_QA if part == "qa" and COND.endswith("-neutral") else ASK[part]) + "\n".join(f"{x['id']}. {x['q']}" for x in q[part])
    work = pathlib.Path(tempfile.mkdtemp(prefix=f"e1-{COND}-{part}-"))
    tools, system, prompt = "", base, ask
    if COND == "none":
        system += "你没有任何以前对话的记录。"
    elif COND == "raw":
        (work / "history").mkdir(); shutil.copy(RAW, work / "history/transcript.txt")
        tools = "Read,Grep"
        system += ("以前的原始对话保存在 history/transcript.txt（每条记录一行开头，形如 [S1/T12#E3 @user]；@user 是用户本人的话），"
                   "需要时用 Grep 搜、用 Read 读。")
    elif COND.startswith("refrain"):
        (work / "history").mkdir()
        shutil.copy(RAW, work / "history/transcript.txt")
        shutil.copy(pathlib.Path(SCRIBE) / "summaries.md", work / "history/summaries.md")
        tools = "Read,Grep"
        system += "\n\n" + HEADER + EXTRA.get(COND, "") + (pathlib.Path(SCRIBE) / "briefing.md").read_text(encoding="utf-8") + "\n</system-reminder>"
        if COND != "refrain":  # -search, -rule and their -neutral variants
            system += "\n\n" + SEARCH_GUIDE
    elif COND == "full":
        prompt = "以下是上一个会话的完整对话记录：\n\n" + pathlib.Path(RAW).read_text(encoding="utf-8") + "\n\n---\n\n" + ask
    # Same guard as scribe_run.py: a hung call is killed with its whole process group.
    p = subprocess.Popen(["claude", "-p", "--model", "haiku", "--system-prompt", system, "--tools", tools, "--setting-sources", "",
                          "--no-session-persistence", "--output-format", "json", "--max-turns", "40"],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=work, start_new_session=True)
    try:
        stdout, _ = p.communicate(prompt, timeout=900)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL); p.communicate()
        sys.exit(f"{COND} {part}: timed out")
    res = json.loads(stdout)
    print(COND, part, "turns", res.get("num_turns"), "cost", res.get("total_cost_usd"), flush=True)
    return {"result": res.get("result"), "num_turns": res.get("num_turns"), "cost": res.get("total_cost_usd"),
            "usage": res.get("usage"), "system_chars": len(system), "prompt_chars": len(prompt)}

HEADER = (f"<system-reminder>\n# 记忆\n\n以下是从这位用户以往和 Claude 的对话中，由后台整理出来的长期知识和当前状态，截至 {AS_OF}。"
          "每条都有出处。〔推断〕是从行为中归纳的，把握较低；〔观察〕是从工具输出里看到的事实；〔待定〕是暂缓的方向。"
          "以往会话里做过什么、怎么讨论的，记在 history/summaries.md 的摘要里（编号 M 开头）；原始对话在 history/transcript.txt。"
          "需要时用 Grep 搜、用 Read 读：先看摘要，需要原话和细节再去原始对话。\n\n")
# "When to search" from the real search tool description (docs/model-facing/tools.md), reworded for Grep/Read.
SEARCH_GUIDE = ("关于 history/ 里的摘要和原始对话，什么时候查：\n"
                "- 用户提到以前的工作、讨论或决定，而当前上下文里没有时。\n"
                "- 问用户之前，先查一下是不是已经记过、讨论过。\n"
                "- 需要当时的原话、数值、路径、命令、报错时：先找到对应的摘要或记录，再读原文。\n"
                "- 只在答案会改变你下一步怎么做时才查。\n"
                "- 没搜到不代表没发生过：换个说法再搜。同一件事可能有几种说法（中英文、改名前后的叫法），用 | 一次列出来。")
# The candidate briefing rule under test (e1 cuts A/B: the model answered "don't know" without searching).
RULE = ("这里只放结论。问到具体怎么做、数值、当时怎么讨论的，先查摘要再回答；这里没写，不代表没讨论过、没定过。\n\n")
EXTRA = {"refrain-rule": RULE, "refrain-rule-neutral": RULE}
out = {"condition": COND, **{part: run(part) for part in PARTS}}
pathlib.Path(OUT).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
