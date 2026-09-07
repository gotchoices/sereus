description: A public GitHub issue describes a problem in this project that no longer exists, and someone with access to the issue tracker needs to update or close it.
files: docs/architecture.md
----

# Human action: GitHub issue `gotchoices/sereus#2` describes code that no longer exists

## What the issue says

Issue `gotchoices/sereus#2` on the public tracker claims that the code which
builds the group's control network:

- hard-codes the number of machines it replicates data to as `3`, and
- never states how many machines it assumes are in the group.

## Why it needs a human

Neither statement has been true for some time. The replication number is a named
constant (16) with the reasoning written down in
[`docs/architecture.md`](../../docs/architecture.md) under "Replication cluster
size", and the assumed-group-size figure is declared explicitly. The last real
gap the issue was pointing at — the control network not sizing its block-repair
check from the number of machines actually enrolled — was closed by the work
tracked as `feat-repair-yardstick-control-node`, landed 2026-09-07.

So there is nothing left to build. What remains is a public issue that misleads
anyone who reads it, and only someone with write access to the tracker can edit
or close it. That is outside this repository, which is why this sits here rather
than in a working stage.

## What to do

Close the issue, or edit it to say what (if anything) is still open, and link it
to the landed work. No code change is expected; if reading the issue turns up a
genuine remaining gap, file that as its own ticket rather than reopening this
one.
