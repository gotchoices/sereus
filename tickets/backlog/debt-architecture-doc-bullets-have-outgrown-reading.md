---
description: The main architecture document has grown a handful of single bullet points that each run well over a thousand words, mixing how the system works today with the history of problems that were fixed long ago. Someone trying to learn how a subsystem behaves has to read an essay and then work out which half of it is still true.
files: docs/architecture.md
difficulty: medium
tradeoffs: The content is accurate and hard-won, so a maintainer may reasonably prefer a long correct bullet to the risk of losing detail while splitting it — and no reader has yet complained in writing.
---

# Architecture bullets have outgrown being read

`docs/architecture.md` is the entry point every new contributor and every agent is pointed at (`AGENTS.md`). Eight of its bullet points are now over 500 words each, and two are over 1600. Measured on 2026-09-17:

```bash
awk '{n=split($0,a,/ /); if (n>500) printf "%d\t%d words\n", NR, n}' docs/architecture.md
```

which reports, by line: 98 (1682 words), 224 (959), 225 (1830), 227 (927), 375 (619), 376 (789), 755 (512), 757 (515).

The repo's convention is one paragraph per line with editor soft-wrap, so "one line" is not itself the problem. The problem is that each of these is a single *bullet point* — an item in a list, with no headings, no sub-structure, and no way to skim. Line 98 alone covers: the approval-threshold arithmetic, the retry policy's attempt counts and budget, four separate classifier rules, two limits that were found and closed in August and September, the decision not to widen the classifier, the new abandoned-write reporting, the operator escalation, and the separate schema-initialization policy.

## Why it keeps growing

Each ticket that touches the control-write funnel appends its own story to the same bullet. Nothing is ever removed, because everything in it was true when it was written. The abandoned-write ticket (`an-abandoned-control-write-is-silent`, 2026-09-17) took line 98 from 1412 words to 1682 without adding a single structural boundary — and it was right to record what it recorded.

So the growth is structural, not anyone's carelessness, and a ticket that only splits the current bullets will see them re-merge within a few months.

## What the fix has to include

Two parts, and the second is the one that retires the class:

**Restructure the oversized bullets.** Give each a small set of sub-headings or nested bullets so a reader can find the part they came for. The natural split for line 98 is: what the retry does today, what it deliberately does not do and why, what happens when it gives up, and the schema-initialization exception.

**State where closed history goes.** A large fraction of these bullets is archaeology: limits that were measured, traced, fixed upstream, and confirmed closed. That record matters, but its home is the ticket archive (`tickets/complete/`, `tickets/.pruned-tickets.jsonl`) and `tickets/.pre-existing-known.md`, which already carry it in more detail. The architecture document should describe the system as it is now, and reference the closed history rather than restate it. Write that rule down where a future author will meet it — the top of the document, or `AGENTS.md` beside the existing "update existing docs" instruction — or this ticket gets refiled next year.

## Out of scope

Not a rewrite for tone, and not a word cap. The content is correct and expensively earned; nothing should be deleted on the grounds of length alone. A mechanical lint rule on paragraph length was considered and is a poor fit — some design reasoning genuinely needs a long paragraph, and a cap would push authors into splitting mid-thought rather than structuring.
