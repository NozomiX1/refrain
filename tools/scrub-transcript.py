#!/usr/bin/env python3
# Turn a recorded CC transcript into a test fixture that can be published (design.md 7.13).
# Keeps every row on the uuid chain (attachments emptied but kept, or the chain breaks); drops rows the reader
# never reads that copy whole requests (system prompt, email, environment); replaces the home path, user name
# and email. Prints any leftover hit of the given words so a person checks before committing.
# usage: scrub-transcript.py <in.jsonl> <out.jsonl> <home> <user> <email> [more words to check...]
import json, sys

src, out, home, user, email, *extra = sys.argv[1:]
DROP = {"api-request", "api-request-blob", "api-request-shape", "cost-state", "queue-operation", "last-prompt", "ai-title", "mode", "permission-mode", "atis-latch", "file-history-snapshot"}

rows = []
for line in open(src, encoding="utf-8"):
    r = json.loads(line)
    if r.get("type") in DROP and not r.get("uuid"):
        continue
    if r.get("type") == "attachment" and isinstance(r.get("attachment"), dict):
        r["attachment"] = {"type": r["attachment"].get("type")}
    text = json.dumps(r, ensure_ascii=False)
    text = text.replace(email, "user@example.com").replace(home, "/home/user").replace(user, "user")
    rows.append(text)

open(out, "w", encoding="utf-8").write("\n".join(rows) + "\n")
body = "\n".join(rows)
left = [w for w in [home, user, email, *extra] if w and w in body]
print(f"{len(rows)} rows -> {out}; leftover: {left or 'none'}")
