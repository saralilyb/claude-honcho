#!/usr/bin/env python3
"""Count tool calls in Claude Code transcripts: Honcho vs. everything else,
split by main thread vs. sidechain (subagent) calls."""

import json
from collections import Counter
from glob import glob
from pathlib import Path

PREFIX = "mcp__plugin_honcho_honcho__"
HONCHO = {"chat", "search", "get_context", "get_representation", "get_config",
          "set_config", "create_conclusion", "list_conclusions", "delete_conclusion"}

main, side = Counter(), Counter()
for f in glob(str(Path.home() / ".claude/projects/**/*.jsonl"), recursive=True):
    for line in open(f, errors="replace"):
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if rec.get("type") != "assistant":
            continue
        bucket = side if rec.get("isSidechain") else main
        for b in rec.get("message", {}).get("content") or []:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                bucket[b.get("name", "?").removeprefix(PREFIX)] += 1


def report(name, counts):
    total = sum(counts.values())
    if not total:
        return
    honcho = sum(c for n, c in counts.items() if n in HONCHO)
    print(f"\n=== {name}: {total} tool calls, Honcho {honcho} ({100*honcho/total:.1f}%) ===")
    print(f"{'TOOL':<24}{'CALLS':>8}{'%':>8}")
    for tool, c in counts.most_common():
        mark = " *" if tool in HONCHO else ""
        print(f"{tool:<24}{c:>8}{100*c/total:>7.1f}%{mark}")


report("MAIN THREAD", main)
report("SIDECHAIN (subagents)", side)

combined = main + side
mt, ct = sum(main.values()), sum(combined.values())
mh = sum(c for n, c in main.items() if n in HONCHO)
print(f"\nHoncho: {mh}/{mt} main-thread ({100*mh/mt:.1f}%)  |  "
      f"{mh}/{ct} of all ({100*mh/ct:.1f}%)   [* = Honcho]")
