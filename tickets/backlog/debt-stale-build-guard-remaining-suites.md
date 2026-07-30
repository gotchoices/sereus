description: Four test suites can still pass while running an out-of-date copy of code they depend on, because nothing checks that those dependencies were rebuilt after their last edit — two other suites already have that check.
prereq:
files: test-harness/build-freshness.ts, test-harness/build-targets.ts, packages/cadre-core/test/global-setup.ts, packages/cadre-core/test/build-targets.spec.ts, packages/quereus-plugin-sereus/vitest.config.ts, packages/cadre-cli/vitest.config.ts, packages/cadre-host/vitest.config.ts, packages/cadre-provider/vitest.config.ts
difficulty: easy
----

# Problem

Several packages here depend on other packages — some inside this repository, some
in the sibling checkouts `../quereus` and `../optimystic`. Those dependencies are
consumed as *compiled* output, not source. So if someone edits one of them and does
not rebuild it, a test suite runs the previous build and reports green about code it
never executed. That has already happened twice and cost real investigation time
both occasions.

A guard exists for this and is wired into two suites: `cadre-core` and
`integration-tests`. Each declares the list of packages it runs compiled code from,
and the run aborts up front — naming the package and the exact build command — when
one of them is out of date.

Four suites still have no such guard and are exposed to the same failure:

- `quereus-plugin-sereus` — notably includes the schema-drift tests, which compare
  this repo's schema files against what Quereus actually does. Those are precisely
  the tests a stale `@quereus/quereus` build would quietly invalidate.
- `cadre-cli`
- `cadre-host`
- `cadre-provider`

# What's wanted

Each of those four suites should fail fast when a dependency it runs compiled code
from has been edited since its last build, the same way the two wired suites do.

Whether a given suite genuinely runs compiled dependency output is worth confirming
per package before wiring it — a suite that only exercises its own source, with its
dependencies mocked, does not need the guard and should not pay its start-up cost.
`quereus-plugin-sereus` is the one where the exposure is already known to be real.

The mechanics are already built and used twice, so this is wiring rather than
design: a `globalSetup` file declaring the package's own target list, plus the
existing companion check that holds that list against the package's declared
dependencies so it cannot silently rot.
