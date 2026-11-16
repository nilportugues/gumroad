#!/usr/bin/env bash
# Counts ticked boxes per phase in docs/nextjs-rewrite/playwright-plan.md.
set -euo pipefail
plan="$(dirname "$0")/../docs/nextjs-rewrite/playwright-plan.md"
awk '
  /^## Phase/ { phase = $0 }
  /^- \[x\]/ { done[phase]++; total[phase]++; d++; t++ }
  /^- \[ \]/ { total[phase]++; t++ }
  END {
    for (p in total) printf "%-48s %2d/%-2d %3d%%\n", substr(p, 4), done[p], total[p], 100 * done[p] / total[p] | "sort"
    close("sort")
    printf "\nOverall: %d/%d tasks, %d%%\n", d, t, 100 * d / t
  }' "$plan"
