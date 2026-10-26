#!/bin/zsh
# Type a message into a tmux-driven Claude Code session, wait for the turn to end, print the screen tail.
# usage: cc-say.sh <tmux-session> <text> [lines] [timeout-seconds]
name=$1 text=$2 lines=${3:-20} limit=${4:-300}
# Each finished turn prints a "· done <time>" line; wait until one more appears.
count() { tmux capture-pane -t "$name" -p -S -5000 | grep -c '· done ' }
before=$(count)
tmux send-keys -t "$name" -l -- "$text"
perl -e 'select(undef,undef,undef,0.5)'
tmux send-keys -t "$name" Enter
for i in {1..$limit}; do
  perl -e 'select(undef,undef,undef,1)'
  (( $(count) > before )) && break
done
perl -e 'select(undef,undef,undef,1)'
tmux capture-pane -t "$name" -p | grep -v '^\s*$' | tail -$lines
