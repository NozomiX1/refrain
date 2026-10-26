#!/bin/sh
# Answer (twice: the answering model varies a lot between tries), grade and fact-check one finished replay (E7).
# usage: score.sh <replay out dir> <questions.json>
set -e
cd "$(dirname "$0")"
d=$1 q=$2
for i in 1 2; do
  for p in qa tasks; do
    [ -f "$d/grade-$p-$i.json" ] && continue
    node answer.ts "$d" "$q" $p "$d/answers-$p-$i.json"
    node grade.ts "$q" "$d/answers-$p-$i.json" "$d/grade-$p-$i.json"
  done
done
[ -f "$d/facts.json" ] || node facts.ts "$d" "$d/facts.json"
