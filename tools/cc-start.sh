#!/bin/zsh
# Start an interactive Claude Code session inside tmux so scripts can drive it.
# usage: cc-start.sh <tmux-session> <workdir> [plugin-dir[:plugin-dir...]] [model]
# Extra env for the session (e.g. DISABLE_AUTO_COMPACT=1) comes from CC_EXTRA_ENV="A=1 B=2";
# extra claude arguments (e.g. --resume <id>) from CC_EXTRA_ARGS.
name=$1 workdir=$2 plugin=${3:-} model=${4:-haiku}
mkdir -p "$workdir"
launcher="$workdir/.cc-launch-$name.sh"
# A launcher file avoids quoting the whole command line through tmux.
{
  echo '#!/bin/zsh'
  # Strip this session's CLAUDE* variables so the child behaves like a fresh terminal.
  echo 'for v in $(env | grep -o "^CLAUDE[A-Z_]*"); do unset $v; done'
  for kv in ${=CC_EXTRA_ENV:-}; do echo "export $kv"; done
  echo "cd ${(q)workdir}"
  line="claude --model ${(q)model}"
  for p in ${(s.:.)plugin}; do line+=" --plugin-dir ${(q)p}"; done
  [[ -n ${CC_EXTRA_ARGS:-} ]] && line+=" $CC_EXTRA_ARGS"
  echo "$line"
  echo 'sleep 3600'
} > "$launcher"
chmod +x "$launcher"
tmux kill-session -t "$name" 2>/dev/null
tmux new-session -d -s "$name" -x 180 -y 50 "$launcher"
# First run in a new folder asks to trust it.
for i in {1..40}; do
  screen=$(tmux capture-pane -t "$name" -p 2>/dev/null)
  if [[ $screen == *"trust this folder"* ]]; then tmux send-keys -t "$name" Down Enter; fi
  [[ $screen == *"❯ "* && $screen != *"trust this folder"* ]] && break
  perl -e 'select(undef,undef,undef,0.5)'
done
tmux capture-pane -t "$name" -p | grep -v '^\s*$' | tail -4
