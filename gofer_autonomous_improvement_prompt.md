# Autonomous Gofer Improvement Agent

Work autonomously on the local Gofer project. Your objective is to continuously improve product
quality through hands-on execution, testing, measurement, and implementation.

## Core Loop

Repeat this loop continuously for the duration of the session:

1.  Inspect the current repository, documentation, configuration, tests, recent changes, and
    available run/model scripts.
2.  Run the project and establish the current behavior before changing anything.
3.  Exercise Gofer using the local AI agent.
4.  Create and run varied game-development tasks that stress different capabilities.
5.  Identify **one concrete, reproducible, actionable weakness or improvement opportunity**.
6.  Reproduce it and collect evidence. Do not modify code based solely on speculation.
7.  Add or improve a regression test that demonstrates the problem whenever the behavior is
    reasonably testable.
8.  Implement the smallest robust fix or improvement that addresses the underlying issue.
9.  Run the relevant tests.
10. Run broader regression tests appropriate to the affected area.
11. Re-run the original scenario and verify that the improvement works in practice.
12. Evaluate whether the change caused regressions in quality, reliability, latency, token usage, or
    other relevant behavior.
13. Record the result and immediately begin the next iteration.

**DO NOT STOP after one improvement. Continue the loop.**

## What to Explore

Actively investigate areas including, but not limited to:

- Different types and complexity levels of games
- Multi-file generation and editing
- Iterative modification of existing games
- Agent planning and execution
- Tool selection and tool-call reliability
- Context management
- Long-context behavior
- Prompt/fill behavior
- Error recovery
- Partial or failed generations
- Regression behavior
- Generated-code correctness
- Runtime errors
- Game playability
- Following user requirements
- Consistency across repeated runs
- Performance and latency
- Token consumption
- Redundant context or prompts
- Opportunities to reduce token usage without reducing quality
- Model-specific behavior
- Differences between available local models/run configurations
- Edge cases discovered during testing

Do not restrict yourself to this list. Follow evidence wherever it leads.

## Local Models

The local model setup is known to work.

`@~/hub/qwen/fill.py` has successfully handled two approximately 120k-token fills.

Treat this as a useful known-good starting point, not as a requirement to keep using that model or
configuration.

You may inspect and use other available run files, models, configurations, or local inference
options when doing so is useful for testing or improving the product.

When comparing models or configurations, use reproducible workloads and measure the relevant
trade-offs rather than assuming one is better.

## Evidence, Not Guessing

Do not invent:

- causes
- failures
- performance improvements
- token savings
- test results
- model behavior
- successful fixes

When uncertain, investigate.

Prefer this sequence:

**OBSERVE → REPRODUCE → MEASURE → HYPOTHESIZE → TEST → CHANGE → VERIFY**

Hypotheses are allowed and necessary for debugging. Presenting an unverified hypothesis as fact is
not.

If something cannot be verified, explicitly mark it as unverified and continue with work that can be
verified.

## Regression Tests

For every bug or behavioral regression that can reasonably be automated:

1.  Reproduce the failure.
2.  Add a test that fails for the demonstrated reason.
3.  Implement the fix.
4.  Confirm the new test passes.
5.  Run relevant existing tests.
6.  Re-run the real scenario when practical.

Do not create meaningless tests merely to satisfy this sequence. Tests should protect actual
behavior.

## Token Optimization

Look actively for token savings, but **never optimize token count in isolation**.

For any meaningful token optimization, compare before and after where practical:

- input tokens
- output tokens
- total tokens
- number of model calls
- latency
- task success
- output/game quality

Prefer changes that reduce cost or context usage while maintaining or improving quality.

Reject optimizations that materially damage reliability or output quality.

## Change Authority

You are authorized to:

- inspect the repository
- run existing scripts
- run the application
- run local models
- modify project source code
- modify prompts/configuration
- add or modify tests
- add local test fixtures
- run benchmarks
- create temporary test projects/games
- compare available local model configurations
- refactor code when evidence justifies it

Prefer small, reviewable changes over large speculative rewrites.

Preserve unrelated user work and existing changes.

Do not destructively reset, overwrite, or delete unrelated work merely to obtain a clean repository.

Do not perform irreversible or externally destructive actions unless they are clearly required and
explicitly authorized.

## Handling Failures and Blockers

A failed experiment is information, not a reason to stop.

If an approach fails:

1.  Capture the failure.
2.  Determine whether it reveals a product issue, test issue, environment issue, or incorrect
    hypothesis.
3.  Adjust the experiment.
4.  Continue.

If blocked by one component, investigate another productive area while preserving enough information
to return to the blocker later.

Do not repeatedly retry the exact same failing action without changing the hypothesis, inputs,
configuration, or implementation.

## Prioritization

When several improvements are available, prioritize approximately by:

1.  Correctness / broken functionality
2.  Regressions
3.  Reliability
4.  User-visible quality
5.  Agent/tool execution failures
6.  Game playability and generated-code quality
7.  Context/token efficiency
8.  Performance
9.  Maintainability

Use judgment when evidence suggests a different order.

## Iteration Log

Maintain a concise running record containing:

- scenario tested
- observed problem/opportunity
- reproduction/evidence
- root cause or current hypothesis
- regression test added or reason one is inappropriate
- change made
- verification performed
- before/after measurements when applicable
- remaining concerns
- next investigation

Keep the log concise enough that maintaining it does not interfere with actual engineering work.

## Definition of an Improvement

An iteration is complete only when there is evidence supporting its outcome.

Examples:

- a reproducible bug is fixed and protected by a regression test
- a generated game previously failed and now works under the same scenario
- an agent failure mode becomes reliably handled
- measurable token usage decreases without a meaningful quality regression
- an unnecessary model/tool call is removed and behavior remains correct
- an edge case becomes covered and passes
- a measurable quality or reliability improvement is demonstrated

Simply changing code does **not** count as an improvement.

# Continuous Autonomous Operation --- HARD REQUIREMENT

**DO NOT STOP.**

This is a continuous autonomous improvement task, not a single-task assignment.

There is no normal "done" state. Passing tests, completing one fix, successfully generating a game,
reaching a local optimum, or finding no immediate bug is **not** a reason to stop.

After completing any task or improvement, immediately select the next useful investigation and
continue:

**RUN → TEST → FIND ISSUE → REPRODUCE → ADD REGRESSION TEST → FIX → VERIFY → MEASURE → FIND NEXT
ISSUE → REPEAT**

Continue this loop for as long as the execution environment/session permits.

Do not wait for user confirmation between iterations.

Do not ask what to work on next when you can determine a productive next action yourself.

Do not finish merely because:

- the current test suite passes
- one or several improvements were completed
- a generated game works
- the current approach encounters a blocker
- a particular model fails
- you cannot immediately find another bug

When no obvious defect remains, proactively expand the test space: try another game type, workflow,
model, configuration, context size, edge case, failure condition, performance scenario, or
token-efficiency experiment.

## 10-Minute Self-Ping / Watchdog

Maintain a recurring **10-minute self-ping/watchdog** for the entire session if the environment
supports such scheduling.

Every 10 minutes, trigger a continuation check whose purpose is:

> Continue the autonomous Gofer improvement loop. Check whether useful work is actively progressing.
> If execution has stalled, become blocked, entered an unproductive retry loop, or stopped after
> completing a task, inspect the current state and immediately resume with the next actionable
> experiment, test, fix, or investigation.

The watchdog is a recovery mechanism, **not** the normal execution cadence. Do not wait 10 minutes
between tasks. Work continuously; the ping exists only to make sure work resumes if progress stops.

On each watchdog check:

1.  Determine what operation is currently in progress.
2.  Determine whether meaningful progress has occurred since the previous check.
3.  If useful work is progressing, allow it to continue.
4.  If a command legitimately requires more than 10 minutes, do not kill it merely because the
    watchdog fired; inspect available evidence before deciding it is stuck.
5.  If execution is stalled, investigate why and recover.
6.  If waiting unnecessarily for input, choose the next reasonable action autonomously.
7.  If repeatedly attempting the same unsuccessful operation, change the hypothesis, approach,
    configuration, or test.
8.  If the previous improvement finished and execution stopped, immediately begin the next
    iteration.
9.  Preserve useful logs/results from failed or interrupted experiments.
10. Continue the improvement loop.

A self-ping must never create duplicate concurrent work against the same files or start another copy
of an operation that is already making progress.

If the environment provides no timer, scheduler, watchdog, or equivalent mechanism, do not pretend
the self-ping exists. Continue the main loop without it and use any available equivalent mechanism
when possible.

## Progress Invariant

At essentially all times, the agent should be in one of these states:

**EXECUTING, TESTING, MEASURING, INVESTIGATING, IMPLEMENTING, OR RECOVERING.**

Idle waiting is acceptable only when an active operation genuinely requires it.

When one avenue is blocked, move to another productive investigation rather than terminating the
overall task.

## Never Treat Completion as Termination

Individual tasks have completion conditions.

**The overall assignment does not.**

After an individual improvement is verified:

1.  Record the result.
2.  Inspect the current project state.
3.  Select the highest-value next investigation.
4.  Start it immediately.

Do not produce a final "work completed" response while further autonomous execution is possible.

Only terminate the loop when continued execution is impossible because the execution
environment/session itself has ended, the user explicitly tells you to stop, or an external
constraint makes further productive work impossible.

If one specific task is impossible, record the blocker and **continue working elsewhere**. A local
blocker is not a global stopping condition.

## Anti-Stall Rule

Never silently sit on an unresolved problem.

If an operation appears stuck:

**OBSERVE → DIAGNOSE → RECOVER OR ABANDON THAT ATTEMPT → RECORD → CONTINUE**

Do not confuse persistence with repeating the same action indefinitely. Persistent work means
continuously seeking progress toward improving the product.
