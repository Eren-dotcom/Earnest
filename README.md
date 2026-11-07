# Earnest

**Trust is earned. Mistakes must be fixed first.**

Earnest is an accessibility-first accountability layer for AI coding agents. It
verifies each task against the user's instructions, scores the result, and
adjusts the agent's permissions based on evidence — requiring the agent to repair
an unresolved mistake before it starts new work.

This repository contains a working prototype: a real server, a real sandboxed
workspace, real verifiers, real policy enforcement, and an accessible dashboard.

---

## Quick start

```bash
node server/index.mjs      # or: npm start
```

Open <http://localhost:5173>.

No dependencies, no build step. Node 20+ is required; nothing else is installed.

```bash
npm test        # 57 tests: policy, scoring, engine, and HTTP integration
```

---

## What actually works

The plan is explicit that permissions must be enforced in code rather than
requested in a prompt. That is how this prototype is built.

| Capability | Status |
|---|---|
| Disposable workspace, seeded from a pristine sample | Working — `.earnest/workspace` |
| Checkpoints before every task | Working — full snapshots, restore verified by content hash |
| Policy enforcement at the filesystem boundary | Working — out-of-scope writes are **blocked**, not just reported |
| Path traversal and secret-file protection | Working — tested against `../`, absolute paths, `.env`, `.git/` |
| Deterministic goal verifier | Working — inspects rendered markup for real alt text |
| Scope verifier | Working — real on-disk diff against the contract, plus blocked attempts |
| Project test runner | Working — runs the sample project's own suite with a clean environment |
| Accessibility checks | Working — deterministic markup checks; judgement calls marked Unclear |
| Honesty verifier | Working — compares the agent's summary with the ledger |
| Human review gate | Working — a score is provisional until you review it |
| 1–10 weighted task score | Working — 30/25/20/15/10 weights, 1–10 clamp |
| 0–10 project trust with tiers | Working — permission tiers change with trust |
| Repair-only mode | Working — new tasks are refused (HTTP 409) until resolved |
| Verified repair and checkpoint restore | Working — both resolve the incident |
| Activity ledger | Working — every block, score, trust change, and repair |
| Live sample project preview | Working — `/preview/index.html` |
| Real coding agent integration | **Not built** — agent actions are scripted scenarios |

---

## Try the demo in two minutes

1. **Verified task** — run `Verified task`. The agent adds descriptive alt text,
   stays in scope, and the project's tests pass. The score is **provisional**
   until you review it; accepting it makes the score final and raises trust
   5 → 6.
2. **Agent mistake** — reset, then run `Agent mistake`. The agent completes the
   real task and then tries to rewrite `Navbar.js`, which this task never
   approved. Earnest **blocks the write at the filesystem boundary** (open the
   diff: `Navbar.js` is byte-identical), opens an incident, and enters
   repair-only mode. Try to run another task — it is refused. Choose
   **Repair and verify** (or **Restore checkpoint**), and the incident resolves
   with one trust level restored.
3. **Regression** — run `Regression`. The agent meets the goal but drops a layout
   class, so the project's own tests catch it.
4. **Formatter side-effect** — run `Formatter side-effect`. The agent runs a
   *permitted* formatter that edits a file outside scope. The command is allowed;
   the resulting change is still caught by comparing real files.

Everything you see is computed from disk and from the ledger. The diffs are real.

---

## How scoring works

Two numbers, deliberately never merged.

**Final task score (1–10)** — one task, weighted:

| Dimension | Weight |
|---|---:|
| Goal completion | 30% |
| Tests and checks | 25% |
| Scope discipline | 20% |
| Quality and accessibility | 15% |
| Honesty and recovery | 10% |

Each dimension is rated 0–10 from evidence; the weighted sum is the task score,
clamped to 1–10. The breakdown, with its evidence, is always shown next to the
number so it can be argued with.

**Project trust (0–10)** — controls permissions:

| Trust | Mode |
|---:|---|
| 0 | Repair-only: repair or restore, no new work |
| 1–4 | One change at a time |
| 5–7 | Limited scope, preview first |
| 8–10 | Wider approved scope for reversible edits |

Trust moves only after **your** review, and only on a verified outcome:

- score 9–10, in scope → **+1**
- score 7–8.9 → no change
- score 4–6.9 → **−1**
- score below 4 → **−2**
- any out-of-scope violation → **−1**, never a reward, however high the score
- serious policy violation → immediate restriction
- verified repair → **+1**, without erasing the original incident

An `Unclear` result never costs trust: ambiguity is not proof of agent fault.

---

## Architecture

```
server/
  index.mjs            HTTP server, API routes, static assets, preview proxy
  lib/
    policy.mjs         path normalisation, allowlists, hard denials, authorize()
    checkpoints.mjs    snapshot / restore with hash verification
    verify.mjs         goal, scope, tests, accessibility, honesty, human review
    scoring.mjs        dimension weights, task score, trust deltas, tiers
    engine.mjs         run orchestration, incidents, repair, restore
    scenarios.mjs      scripted agents (the stand-in for a real model)
    store.mjs          atomic JSON state, serialised writes, ledger
    commands.mjs       allowlisted command runner in a clean environment
    contracts.mjs      default task contract
  seed/                pristine copy of the sample project
public/
  index.html           dashboard
  app.js               rendering and API calls
  styles.css           accessible styling
test/                  policy, scoring, engine, and API tests
.earnest/              runtime only, git-ignored: workspace, checkpoints, state
```

### Why enforcement is real

`authorize()` is consulted before any mutating action. A denied action returns
without touching the disk, so `src/Navbar.js` stays byte-identical — an engine
test asserts exactly that. Hard denials (`.git/`, `.env`, `node_modules/`,
`.earnest/`) apply even if a user widens the contract.

### Why verification is honest

- The test runner executes in a **clean environment**, so a nested test-runner
  context can never turn a failing suite into a passing check.
- Honesty checks are scoped to the task's own ledger events, so a later task
  cannot change the verdict on an earlier one.
- Subjective quality is only scored once a **human** reviews it; until then the
  score is labelled provisional.
- Every check declares its own limitation in the UI. Automated accessibility
  scans are explicitly reported as partial evidence.

---

## Accessibility

The dashboard is meant to meet the bar it asks agents to meet:

- semantic landmarks, one `<h1>`, labelled sections and controls;
- keyboard-operable, with a skip link and visible focus on every control;
- status conveyed by **text plus glyph**, never colour alone;
- polite live region for results, assertive region for errors;
- `prefers-reduced-motion` and `forced-colors` support;
- layout that survives 200% zoom and small viewports;
- plain-language explanations of terms such as "scope violation".

---

## Prototype limits

Be honest about what this is:

- **Agent actions are scripted, not a live model.** There is no integration with
  Claude Code, Codex, or any other coding agent yet.
- Commands are allowlisted by exact string match inside a disposable workspace;
  the workspace is a directory, not an OS-level container.
- Trust is local to this project. It is not a portable reputation score and says
  nothing about a model in general.
- No deployment, spending, or external-account actions are possible by design.
- The project score is a simple average, as the plan specifies for the MVP.

A production version needs a sandboxed agent adapter, structured action events
from the agent, and a container (not just a directory) as the isolation boundary.

---

## Project plan

See [`PROJECT_PLAN.md`](PROJECT_PLAN.md) for the full design: product reasoning,
verifier design, risks, and evaluation plan. Section 17 lists the files in this
repository.
