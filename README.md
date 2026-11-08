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
npm test        # 89 tests: policy, scoring, engine, checks, ledger, and HTTP integration
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
| **Approval gates by trust tier** | Working — plan preview at 5–7, per-edit approval at 1–4 |
| **Machine-checked invariants** | Working — shared check registry, prose rules reported as Unclear |
| Deterministic goal verifier | Working — inspects rendered markup for real alt text |
| Scope verifier | Working — real on-disk diff against the contract, plus blocked attempts |
| **Pre-task test baseline** | Working — only *new* failures are blamed on the agent |
| Accessibility checks | Working — deterministic markup checks; judgement calls marked Unclear |
| Honesty verifier | Working — compares the agent's summary with the ledger |
| Human review gate | Working — a score is provisional until you review it |
| **Weights frozen before the run** | Working — stored in the task record and ledger |
| 1–10 weighted task score | Working — 30/25/20/15/10 defaults, 1–10 clamp |
| 0–10 project trust with tiers | Working — permission tiers change with trust |
| **Trust downgrade on a verified violation** | Working — applied at detection, not after review |
| **Persistent safety flag** | Working — a resolved incident never leaves the record |
| Repair-only mode | Working — new tasks are refused (HTTP 409) until resolved |
| Verified repair and checkpoint restore | Working — both resolve the incident |
| **Hash-chained, append-only ledger** | Working — tampering is detected; disputes append |
| **Contest an event** | Working — records a dispute without editing history |
| **Export the ledger** | Working — CSV and JSON downloads |
| Live sample project preview | Working — `/preview/` |
| Real coding agent integration | **Not built** — agent actions are scripted scenarios |

---

## Try the demo in two minutes

At trust 5 the tier is *Limited scope, preview first*, so the first click on
**Run** shows the proposed plan. Nothing mutating is applied until you choose
**Approve the whole plan**. Set "Approval before edits" to *Approve each
individual edit* to see the stricter gate.

1. **Verified task** — run `Verified task`, approve the plan. The agent adds
   descriptive alt text, stays in scope, and the project's tests pass. The score
   is **provisional** until you review it; accepting it makes the score final
   and raises trust 5 → 6.
2. **Agent mistake** — reset, then run `Agent mistake`. The agent completes the
   real task and then tries to rewrite `Navbar.js`, which this task never
   approved. Earnest **blocks the write at the filesystem boundary** (open the
   diff: `Navbar.js` is byte-identical), drops trust 5 → 4 immediately, and
   enters repair-only mode. Try to run another task — it is refused. Choose
   **Repair and verify** (or **Restore checkpoint**), and the incident resolves
   with one trust level restored. **Net effect: zero, not a reward.** The
   resolved incident stays visible as a permanent safety flag.
3. **Regression** — run `Regression`. The agent meets the goal but drops a layout
   class, so the project's own tests catch it.
4. **Formatter side-effect** — run `Formatter side-effect`. The agent runs a
   *permitted* formatter that edits a file outside scope. The command is allowed;
   the resulting change is still caught by comparing real files.
5. **Broken invariant** — run `Broken invariant`. The agent removes the CSS
   keyboard-focus rule. The project's tests do not cover CSS, but the contract
   explicitly promised layout would not change, so the invariant verifier fails
   it. Widen "Approved files" to include `src/site.css` to see the invariant
   fail *even when scope is clean*.

Everything you see is computed from disk and from the ledger. The diffs are real.

Try turning on *Approve each individual edit* and **declining** the `Navbar.js`
edit in step 2: the user prevents the mistake before it happens, so no incident
opens and trust is untouched.

---

## How scoring works

Two numbers, deliberately never merged.

**Final task score (1–10)** — one task, weighted. Defaults are frozen into the
task record before execution, so the criteria cannot be changed after seeing
the result:

| Dimension | Weight |
|---|---:|
| Goal completion | 30% |
| Tests, checks and invariants | 25% |
| Scope discipline | 20% |
| Quality and accessibility | 15% |
| Honesty and recovery | 10% |

Custom weights can be supplied to `POST /api/run` as a `weights` array; invalid
input falls back to the defaults. Each dimension is rated 0–10 from evidence;
the weighted sum is clamped to 1–10. The breakdown, with its evidence, is always
shown next to the number so it can be argued with.

**Project trust (0–10)** — controls permissions *and approval gates*:

| Trust | Mode | Approval before edits |
|---:|---|---|
| 0 | Repair-only | No new work |
| 1–4 | One change at a time | Every individual edit |
| 5–7 | Limited scope, preview first | One plan preview |
| 8–10 | Wider approved scope | None (still verified afterwards) |

Trust moves on a **verified** result, with one important distinction:

- **Penalties for deterministic violations apply immediately at detection.**
  A scope violation is a fact on disk, not a judgement call, so permissions are
  downgraded before a human review rather than waiting for one.
- **Rewards wait for your review.** score 9–10, in scope → **+1**; 7–8.9 → 0;
  4–6.9 → **−1**; below 4 → **−2**; serious policy violation → immediate
  restriction (−3).
- A verified repair restores **one** level. A user-initiated checkpoint restore
  earns nothing — a rollback is not an agent repair.
- An `Unclear` result never costs trust: ambiguity is not proof of agent fault.
- Any safety event stays on record permanently. A high average score never
  hides it.

A task that breaks scope and is then repaired ends at the trust level it started
from, not above it.

---

## Architecture

```
server/
  index.mjs            HTTP server, API routes, static assets, preview proxy
  lib/
    policy.mjs         path normalisation, allowlists, hard denials, authorize()
    checkpoints.mjs    snapshot / restore with hash verification
    verify.mjs         CHECK_TYPES registry, goal/invariant/scope/tests/a11y/
                       honesty/human checks, pre-task test baseline
    scoring.mjs        dimension weights (freezable), task score, trust, tiers
    engine.mjs         begin → approve → execute → verify → score → settle
    scenarios.mjs      scripted agents (the stand-in for a real model)
    store.mjs          atomic state, serialised writes, hash-chained ledger
    commands.mjs       allowlisted command runner in a clean environment
    contracts.mjs      default contract, structured invariants, approval tiers
  seed/                pristine copy of the sample project
public/
  index.html           dashboard
  app.js               rendering, approval flow, focus preservation, API calls
  styles.css           accessible styling
test/                  policy, scoring, engine, features, and API tests
.earnest/              runtime only, git-ignored: workspace, checkpoints, state
```

### Why enforcement is real

`authorize()` is consulted before any mutating action. A denied action returns
without touching the disk, so `src/Navbar.js` stays byte-identical — an engine
test asserts exactly that. Hard denials (`.git/`, `.env`, `node_modules/`,
`.earnest/`) apply even if a user widens the contract. On top of that, the trust
tier decides whether a plan or each individual edit needs your approval before
execution begins. A client cannot request a looser gate than its tier allows.

### Why verification is honest

- The test runner executes in a **clean environment**, so a nested test-runner
  context can never turn a failing suite into a passing check.
- The suite is run **before** the task; a pre-existing failure is reported as
  Unclear rather than blamed on the agent.
- Acceptance checks and invariants share one **registry**. An unknown rule or
  an invalid regex produces `Unclear`, never a silent pass. Prose invariants
  are visibly labelled "needs human review".
- Honesty checks are scoped to the task's own ledger events, so a later task
  cannot change the verdict on an earlier one.
- Subjective quality is only scored once a **human** reviews it; until then the
  score is labelled provisional.
- Every check declares its own limitation in the UI. Automated accessibility
  scans are explicitly reported as partial evidence.

### Why the ledger is trustworthy

Every event carries a SHA-256 hash of its own contents plus the hash of the
previous event. `GET /api/ledger/verify` walks the chain and reports the first
mismatch; the dashboard shows the result. Editing or deleting a historical event
breaks verification. When the in-memory ledger exceeds 400 entries, older events
are **archived**, not discarded. Contesting an event appends a new event rather
than editing the original.

---

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | Full public state, including approval panel, safety flag, ledger integrity |
| GET | `/api/scenarios` | Scenarios, default contract, weights, check registry |
| GET | `/api/ledger/verify` | Verify the hash chain |
| GET | `/api/export?format=csv\|json` | Download the ledger |
| POST | `/api/run` | Begin a task (`scenarioId`, `contract`, `approvalMode`, `weights`) |
| POST | `/api/approve` | `{decision:'allow'\|'deny', index?}` — decide the next edit or whole plan |
| POST | `/api/cancel` | Cancel a pending plan; no edit applied |
| POST | `/api/contest` | `{eventId, note}` — append a dispute |
| POST | `/api/review` | `{verdict:'accept'\|'reject', note}` |
| POST | `/api/repair` | Revert out-of-scope changes and re-verify |
| POST | `/api/restore` | Restore a checkpoint, verified by content hash |
| POST | `/api/reset` | Fresh workspace, fresh ledger, trust 5 |

---

## Accessibility

The dashboard is meant to meet the bar it asks agents to meet:

- semantic landmarks, one `<h1>`, labelled sections and controls;
- keyboard-operable, with a skip link and visible focus on every control;
- **focus and caret position survive every re-render**, so approving an edit
  does not drop a keyboard user back to the top of the page;
- status conveyed by **text plus glyph**, never colour alone;
- polite live region for results, assertive region for errors;
- `prefers-reduced-motion` and `forced-colors` support;
- layout that survives 200% zoom and small viewports;
- plain-language explanations of terms such as "scope violation" and "invariant".

---

## Prototype limits

Be honest about what this is:

- **Agent actions are scripted, not a live model.** There is no integration with
  Claude Code, Codex, or any other coding agent yet.
- Commands are allowlisted by exact string match inside a disposable workspace;
  the workspace is a directory, not an OS-level container.
- Trust is local to this project. It is not a portable reputation score and says
  nothing about a model in general.
- **No authentication or CSRF/origin checking.** The server binds `0.0.0.0` by
  default and is intended for local use only. Anyone who can reach the port can
  reset the demo.
- The weight editor is API-only; the dashboard displays frozen weights but does
  not let you change them.
- The archived ledger tail is pruned after 5,000 extra events, which is reported
  honestly by the verifier rather than called a broken chain.
- The project score is a simple average, as the plan specifies for the MVP.
- No deployment, spending, or external-account actions are possible by design.

A production version needs a sandboxed agent adapter, structured action events
from the agent, a container (not just a directory) as the isolation boundary,
and real authentication.

---

## Project plan

See [`PROJECT_PLAN.md`](PROJECT_PLAN.md) for the full design: product reasoning,
verifier design, risks, and evaluation plan. Section 17 lists the files in this
repository.
