#!/bin/sh
# refrain's part of a Claude Code status line (design.md 7.11): give it the JSON CC passes a status line on stdin,
# it prints e.g. "refrain ≈$0.42 3% 空闲", or nothing before refrain has run in this session. Needs jq.
# The cost is the scribe's, priced as API tokens; the share is scribe / main session (whose total includes the scribe).
in=$(cat)
sid=$(printf '%s' "$in" | jq -r '.session_id // empty')
total=$(printf '%s' "$in" | jq -r '.cost.total_cost_usd // 0')
f="${REFRAIN_HOME:-$HOME/.refrain}/status/$sid.json"
[ -n "$sid" ] && [ -f "$f" ] || exit 0
set -- $(jq -r '"\(.state // "idle") \(.costUsd // 0) \(.failures // 0)"' "$f")
case "$1" in
  running) state="整理中" ;;
  paused) state="已暂停（连续失败 $3 次，/refrain resume）" ;;
  *) state="空闲" ;;
esac
share=$(awk -v r="$2" -v t="$total" 'BEGIN { m = t - r; if (m > 0) printf "%d%% ", r / m * 100 + 0.5 }')
printf 'refrain ≈$%.2f %s%s\n' "$2" "$share" "$state"
