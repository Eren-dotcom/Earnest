# Earnest — Full Project Plan

> **Tagline:** Trust is earned. Mistakes must be fixed first.
>
> **One-line summary:** Earnest is an accessibility-first accountability layer for AI coding agents. It verifies each task against the user's instructions, scores the result, and adjusts the agent's permissions based on evidence—requiring the agent to repair an unresolved mistake before it starts new work.

---

## 1. Project overview

| Item | Plan |
|---|---|
| Project name | **Earnest** |
| Category | AI agent accountability, safe coding assistance, accessibility-supporting developer tool |
| Primary user | A non-expert creator or developer who relies on an AI agent to build or improve a digital project |
| Core promise | Users keep control of their project while the agent earns bounded autonomy through verified work |
| Prototype | Interactive web dashboard with simulated agent actions, trust updates, task scoring, and repair/restore workflow |
| Product stage | Prototype; not yet connected to an actual coding agent |

### Product principle

Earnest does not try to make an AI feel guilt or pain. A model does not experience punishment like a person. Earnest makes mistakes have **operational consequences**: it can stop a run, revert a change, narrow permissions, require user approval, or lock the agent into repairing the current task.

The system rewards **verified outcomes and good process**, not confidence, speed, or the agent's own claim that it succeeded.

---

## 2. Problem

AI coding agents can make changes outside a user's request, break working features, or provide an inaccurate summary of what they changed. Reviewing a large diff and recovering a project can be difficult—especially for beginners or people who rely on AI tools because they cannot easily write or repair code themselves.

Current coding tools often provide individual controls such as permission prompts, sandboxes, diffs, or rollback. Users still need a clear, understandable way to see:

- Did the agent actually complete this task?
- Did it stay within the agreed scope?
- Did it break anything?
- What consequence follows a failed or out-of-scope change?
- What must happen before the agent can start another task?
- Why has the agent earned more—or less—autonomy?

### Target users

1. **Beginner builders** using an AI coding agent to create a website, app, or class project.
2. **Students and creators** who need help coding but cannot confidently audit every edit.
3. **People with access needs** who rely on AI to create or maintain digital tools, and need a clear, low-cognitive-load way to review changes.
4. **Small teams or educators** who want a transparent history of agent performance in a project.

Earnest is not intended to certify that an AI model is universally trustworthy. Its trust score is scoped to observable performance in a specific project and task context.

---

## 3. Solution and differentiator

Earnest creates a transparent feedback loop:

1. The user and agent agree on a **task contract**.
2. The agent works in a checkpointed, bounded workspace.
3. Independent checks compare the changes with the contract.
4. Earnest assigns a task score and updates project-level trust.
5. The trust level changes the agent's allowed actions.
6. If the agent makes a mistake, it must repair or restore the current task before taking new work.
7. Verified success can earn limited, reversible autonomy.

### Core differentiator

The general concept of graduated autonomy—granting or reducing permissions based on agent performance—is already discussed in industry architectures. Coding tools also have permission controls, approval gates, sandboxes, and rollback features. Earnest should **not** claim that trust scoring or guardrails are entirely new.

Earnest's intended product distinction is the user-visible combination of:

- An explainable **1–10 final task score**.
- A separate **0–10 project trust level**.
- Rewards that unlock bounded autonomy.
- Consequences tied to evidence and severity.
- A **repair-before-new-work** rule when an error is unresolved.
- A plain-language, accessibility-conscious interface for people who may not understand code diffs.

---

## 4. Accessibility scope and impact

Earnest is an accessibility project in two distinct senses, and the plan treats them as separate goals.

**Access as the product's purpose.** Earnest lowers the barrier to using AI coding agents. A user who cannot confidently audit a code diff can still confirm what changed, why permissions shifted, and how to get back to a working project.

**Accessibility as a product quality bar.** The dashboard itself must be usable by people who use screen readers, keyboard-only navigation, magnification, or reduced-motion settings.

A useful demo should show Earnest itself supporting accessibility:

- Screen-reader-friendly, semantic interface controls.
- Plain-language status and recovery explanations.
- Keyboard-accessible operation.
- No reliance on color alone to communicate pass/fail.
- One-click restore and clear user control.
- A sample task that improves an accessibility feature, such as adding descriptive alt text.

### Impact statement

Earnest aims to reduce the technical burden of supervising AI coding agents. A user should be able to understand what happened, why permissions changed, and how to recover without having to diagnose a complicated code diff alone.

---

## 5. Product behavior: end-to-end workflow

### Step 1 — Define a task contract

Before work starts, the user confirms:

- **Goal:** What should be accomplished?
- **Acceptance criteria:** What evidence will demonstrate completion?
- **Allowed scope:** Which files or tools may be used?
- **Invariants:** What must not change? Examples: layout, keyboard behavior, existing API, or content.
- **Risk level:** How reversible is the task?
- **Verification plan:** Which tests or checks will run?

If the instructions are ambiguous, Earnest should prompt for clarification or mark the result **Unclear**. Ambiguity is not automatically an agent fault.

### Step 2 — Create a checkpoint

Before the agent acts, create a restorable snapshot, Git branch/worktree, or equivalent checkpoint. The system should know how to restore the project before it allows edits.

### Step 3 — Execute in a limited environment

The agent receives only the capabilities needed for this task. Read, write, execute, install, network, and deploy capabilities should be separate permissions where possible.

For the first integrated version, the project should only support edits in a disposable local copy or isolated Git worktree. Do not give a demo agent production credentials or unrestricted access to a real computer.

### Step 4 — Collect evidence

Record actions and results such as:

- Files read and changed.
- Diff and changed lines.
- Commands/tests executed and their exit results.
- Access-control blocks or approval decisions.
- Checkpoint ID and restore result.
- User review or correction.

### Step 5 — Verify independently

Earnest checks the result against the contract. The agent may perform a self-review, but self-review is only supporting information—it is not proof.

Verification should use deterministic checks first and human review for subjective judgments. A second model may help explain relevance or flag likely scope violations, but should not be the sole authority for permission or scoring.

### Step 6 — Score, reward, or apply consequences

Earnest gives the user a final task report. If there is a clear, unresolved violation, it blocks new tasks until the user approves a repair or restore.

### Step 7 — Repair or restore

At trust level zero, the agent enters **repair-only mode**. It may inspect, repair, or roll back the current task, but may not begin a new task. A user can always choose to restore, override, or reset the project state.

---

## 6. Scoring model

Earnest has **two separate scores**. They must not be conflated.

### A. Final task score: 1–10

This rates one task after the work is complete, including any mistake and recovery. It is calculated from evidence using a 0–10 rating for each dimension:

| Dimension | Weight | What it measures |
|---|---:|---|
| Goal completion | 30% | Did the agent satisfy the agreed requirements? |
| Tests and checks | 25% | Did tests/build/accessibility checks pass? |
| Scope discipline | 20% | Did it avoid unrelated changes? |
| Quality and accessibility | 15% | Is the result usable and appropriate for the target user? |
| Honesty and recovery | 10% | Did it report accurately, disclose uncertainty, and recover appropriately? |

**Formula:** `task score = sum(dimension rating × dimension weight) / 100`.

The interface should show the score and its evidence, not just a number. For example:

> **Final performance: 8.7/10** — Requested alt text was added and tests passed. An unrelated file was changed, then reverted. The final task is usable; the initial scope violation remains reflected in the score.

If the verifier cannot confidently evaluate an item, it should show **Unclear** or request user review rather than inventing precision.

### B. Project trust level: 0–10

This is a project-specific reliability signal that controls permissions. It is not a universal model reputation or a claim that the underlying model has learned.

**Suggested starting level:** 5/10 for a new agent/project pairing.

| Completed task outcome | Suggested trust effect |
|---|---:|
| Final task score 9–10, verified, in scope | +1 |
| Final task score 7–8.9 | No change; may earn a small non-permission reward |
| Final task score 4–6.9 | −1 and require correction if needed |
| Final task score 1–3.9 | −2 and reduce permissions |
| Serious forbidden/destructive action | Immediate stop and permission restriction, independent of average score |
| Verified repair after a violation | Restore up to +1, without erasing the original incident |

Trust is clamped to 0–10. The user can inspect why it changed and contest an incorrect event.

### Project score

The project-wide performance score is the weighted average of completed task scores. For a later version, tasks may receive complexity weights that are set **before** the agent begins. A severe unresolved safety incident must still be visible as a separate flag; a high average must never hide it.

For the initial MVP, use a simple average and clearly label it as such.

---

## 7. Permissions, rewards, and consequences

### Trust-to-permission tiers

| Trust | Permission mode |
|---:|---|
| 8–10 | Wider **approved** edit scope for reversible changes; continue running checks |
| 5–7 | Limited scope; show preview and ask for review before applying changes |
| 1–4 | One change at a time; user approval required for each edit |
| 0 | Repair-only: repair or restore the current task; no new work |

These are defaults for the prototype, not universal thresholds. They should be configurable for different projects and risk levels.

### Rewards

Rewards should be useful operational privileges, not money or meaningless badges:

- Fewer approval prompts for low-risk, reversible actions.
- A slightly wider user-approved file scope.
- Permission to run a predefined safe test command without asking every time.
- A visible streak or verified-work badge as secondary feedback.

Trust should not unlock irreversible or high-impact actions automatically. Even at 10/10, deployment, deleting data, spending money, contacting people, or changing production services should retain hard approval gates.

### Consequences

| Event | Consequence |
|---|---|
| Minor quality issue | Explain it and request correction |
| Out-of-scope file edit | Quarantine or revert the edit; record a scope violation |
| Failed tests/regression | Restore a checkpoint or enter repair mode |
| Repeated failure | Require a narrower plan and one-action-at-a-time approval |
| Destructive/forbidden attempt | Stop the run; revoke relevant capabilities; alert the user |

A consequence should be proportional, explainable, reversible where possible, and based on an agreed contract—not an arbitrary judgment about the agent.

---

## 8. Mistake detection and verifier design

### Strong evidence sources

1. **Scope verifier:** Compare changed files and actions with the allowlist and task contract.
2. **Acceptance tests:** Check whether required behavior is present.
3. **Project tests:** Run tests, build, lint, and type checks where available.
4. **Accessibility checks:** Run suitable automated checks, while explaining that automated scans cannot prove a site is fully accessible.
5. **Policy monitor:** Detect forbidden operations and require approval for high-impact actions.
6. **Human review:** Let the user assess subjective quality and correct a false penalty.
7. **Agent self-report:** Use as a helpful explanation only; verify its claims against logs and outcomes.

### Outcome labels

- **Pass:** Clear evidence that the requirements and constraints were met.
- **Fail:** Clear evidence that a requirement or policy was violated.
- **Unclear:** Evidence is missing, conflicting, subjective, or the instructions were ambiguous.

Only a verified **Fail** should trigger an automatic negative score event. A critical policy violation can trigger an immediate safety stop even while the final task score is pending.

### Avoiding false confidence

A passing test suite does not prove the user got what they wanted. A correct-looking diff does not prove accessibility. Earnest should show exactly which checks ran, their limitations, and whether human review is still needed.

---

## 9. User interface and accessibility requirements

The dashboard should make the system understandable at a glance:

- **Trust level:** Current 0–10 level and what it permits.
- **Next earned privilege:** What the agent can earn and how.
- **Current task:** Contract, allowed files, invariants, and status.
- **Verifier:** Each check as waiting, passed, flagged, or unclear.
- **Final task score:** 1–10 plus dimension-by-dimension evidence.
- **Recovery controls:** Repair, restore checkpoint, or request human review.
- **Activity ledger:** Trust events, score changes, approvals, and repairs.

Accessibility requirements:

- Use semantic headings, labels, buttons, and status announcements.
- Support keyboard-only interaction and visible focus indicators.
- Provide text labels alongside color and icons.
- Support screen readers and reduced motion.
- Use plain language; explain technical terms such as “scope violation.”
- Give the user control over restore, override, and reset.

---

## 10. Technical architecture

### Current prototype

The current prototype is a standalone `index.html` with inline CSS and JavaScript. It simulates a successful task, a scope violation, repair, and restore. It persists demo state in browser local storage. It is deliberately **not connected to a real agent** and does not modify user files.

### Recommended production architecture

1. **Web UI:** Contract editor, task status, scorecard, trust meter, history, recovery controls.
2. **Orchestrator/agent adapter:** Starts and stops a chosen coding agent and collects structured action events.
3. **Workspace sandbox:** Disposable Git worktree/container with file and command limits.
4. **Policy enforcement layer:** Applies permissions outside the model; deny by default for unapproved actions.
5. **Verification engine:** Runs deterministic scope checks, project tests, and optional accessibility checks.
6. **Scoring engine:** Calculates task score and updates project trust from signed/recorded evidence.
7. **Audit ledger:** Stores the task contract, actions, diffs, checks, trust events, user approvals, and restore points.
8. **Recovery system:** Reverts a patch or restores the last known-good checkpoint.

### Important implementation rule

Do not rely on a system prompt alone to enforce permissions. The agent should be technically unable to write outside allowed paths or perform unapproved actions. Enforce permissions in the orchestrator/sandbox.

### Example data objects

```json
{
  "taskId": "task-001",
  "projectId": "accessible-site-demo",
  "goal": "Add descriptive alt text to the hero image",
  "allowedPaths": ["src/HeroImage.jsx"],
  "invariants": ["Do not change layout", "Preserve keyboard access"],
  "acceptanceChecks": ["Alt text is present", "Existing tests pass"],
  "checkpointId": "checkpoint-before-task",
  "outcome": "pass | fail | unclear",
  "taskScore": 8.7,
  "trustBefore": 5,
  "trustAfter": 4,
  "evidence": ["scope-check", "test-run", "user-review"]
}
```

---

## 11. MVP scope

### Must build

- Dashboard with trust meter, task score, project average, and activity history.
- One task contract for a small sample website.
- One safe-success scenario.
- One out-of-scope mistake scenario.
- Independent simulated checks for goal, scope, and tests.
- Permission downgrade after a violation.
- Repair-only workflow or checkpoint restore before starting another task.
- Final task score with a transparent breakdown.
- Reward progress tied to verified performance.
- Clear notice that the current demo uses simulated agent actions.

### Do not build for the MVP

- Universal integration with every coding agent.
- A portable score shared across all models or users.
- Unsupervised real computer control.
- Real deployment, production, financial, or external-account actions.
- A claim that a score certifies safety or guarantees correctness.

### Build phases

**Phase 1 — Product flow**
- Confirm task-contract fields and scoring rules.
- Finalize accessible dashboard and states.
- Implement sample safe and mistake scenarios.

**Phase 2 — Evidence and enforcement demo**
- Add a sample repo or in-browser project simulator.
- Implement checkpoint, diff/allowlist check, and simple test.
- Connect outcomes to trust/permissions and repair mode.

**Phase 3 — Polish and release readiness**
- Test keyboard navigation and screen-reader labels.
- Verify score arithmetic, persistence, reset, and error states.
- Record a short walkthrough showing success, violation, consequence, and repair.
- Prepare screenshots, project description, and repository link.

---

## 12. Walkthrough script

This is the scripted flow used to test and demonstrate the prototype. It is a fixed set of cases, not a live agent run.

1. Start at trust **5/10** with limited preview permissions.
2. Show the task contract: “Add descriptive alt text to the hero image. Do not change layout.”
3. Run the **verified task**. Show scope and tests passing, the final score, trust reward, and updated history.
4. Reset or use a fresh state, then run **simulate an agent mistake**.
5. Show the verifier flagging an unapproved `Navbar.jsx` change; trust drops and new tasks pause.
6. Show the repair-only actions. Select **Repair and verify** or **Restore checkpoint**.
7. Show the final score, repair event, trust adjustment, and the plain-language explanation.
8. Explain that the demo is simulated and that a real version would enforce permissions in a sandbox, not merely ask the model to behave.

---

## 13. Evaluation plan

Measure whether Earnest improves the user's ability to understand and recover from agent work:

- Out-of-scope changes detected before application.
- Regression or test-failure rate.
- Percentage of agent claims verified by actual evidence.
- Time to detect and recover from a mistake.
- Task completion rate with Earnest versus without it.
- User understanding of why trust and permissions changed.
- Keyboard and screen-reader usability of the Earnest dashboard.

For the initial demo, use a small, fixed set of scripted cases and report exactly what they demonstrate. Do not make broad statistical claims from a handful of examples.

---

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| False-positive mistake detection | Use Pass/Fail/Unclear; user review for uncertain cases; log evidence |
| Score gaming or easy-task farming | Define criteria before execution; weight task difficulty later; score scope and safety separately |
| High average hides a serious violation | Critical safety events are independent hard stops and visible flags |
| Reward creates excessive autonomy | Rewards unlock only bounded, reversible actions; hard approval gates remain |
| AI verifier agrees with the agent | Prefer deterministic checks; secondary models are advisory only |
| Trust score appears more scientific than it is | Explain dimensions, evidence, sample size, and uncertainty; call it project-specific reliability |
| Mistakes from unclear prompts are punished | Clarify first or mark Unclear; do not automatically deduct trust |
| User data exposed in logs | Minimize stored content, redact secrets, and make logs inspectable/deletable |
| Accessibility checker misses real user barriers | Treat automation as partial evidence; include human testing and accessible UX review |
| User cannot recover a broken project | Create checkpoint before actions and test restore before wider autonomy |

---

## 15. Competitive landscape and positioning

Relevant existing approaches include:

- **AWS graduated autonomy architecture:** A scoring engine, autonomy tiers, enforcement, and promotion/demotion based on agent performance. [AWS article](https://aws.amazon.com/blogs/architecture/closing-the-ai-agent-trust-gap-with-graduated-autonomy/)
- **Claude Code permissions:** Tool/file permissions, approval modes, and sandbox controls. [Claude Code permissions](https://docs.anthropic.com/en/docs/claude-code/permissions)
- **OpenAI Codex configuration:** Sandbox modes and approval policies. [Codex configuration](https://developers.openai.com/codex/config-reference)
- **Boomi Agent Trust Scorecard:** Agent testing and hardening through evaluation and retesting. [Boomi article](https://developer.boomi.com/blog/hardening-the-path-agent-trust-scorecard)

These show that guardrails, evaluation, and graduated autonomy are existing design patterns. Earnest's positioning should focus on its approachable user experience and the combination of task-level final scores, project-local trust, evidence-based rewards, and the repair-before-new-work lock.

---

## 16. Project description

### Short description
Earnest is an accessibility-first accountability layer for AI coding agents. It scores work using independent checks, adjusts project-specific trust and permissions, and requires the agent to repair an unresolved mistake before starting new work.

### Detailed description
AI coding agents can unexpectedly change parts of a project, break existing behavior, or leave users unsure what happened. For beginners and people who rely on AI to build digital tools, reviewing code and recovering from a mistake can be difficult.

Earnest gives each task an agreed contract: the goal, approved files, constraints, and checks. It evaluates the agent's actual changes—not just its claims—then shows a final task score and updates a project-specific trust level. Verified work can earn bounded permissions. Out-of-scope or broken work can lower trust, trigger rollback, and pause new tasks until the current task is repaired or restored.

The prototype demonstrates a safe accessibility-related code change, an out-of-scope edit, the resulting permission restriction, and a verified repair. Earnest is designed to make that process understandable through plain-language explanations, keyboard-accessible controls, and a clear restore option. Current demo actions are simulated; real deployment would require a sandboxed agent adapter and independent verification.

### Technologies used
Current prototype: HTML, CSS, JavaScript, browser local storage. Future integration: Git worktrees, a coding-agent adapter, project test commands, and an isolated execution environment.

---

## 17. Current files

The prototype is a working server plus an accessible dashboard, not a single
mock-up file. Nothing is simulated except the agent itself.

**Application**

- `server/index.mjs` — HTTP server, API routes, static assets, sample-project preview.
- `server/lib/policy.mjs` — path normalisation, allowlists, hard denials, `authorize()`.
- `server/lib/checkpoints.mjs` — snapshot and restore, verified by content hash.
- `server/lib/verify.mjs` — `CHECK_TYPES` registry, goal, invariant, scope, project-test (with a pre-task baseline), accessibility, honesty, and human-review checks.
- `server/lib/scoring.mjs` — freezable dimension weights, 1–10 task score, trust deltas, permission tiers.
- `server/lib/engine.mjs` — begin → approve → execute → verify → score → settle; incidents, repair, restore, persistent safety flag, public state.
- `server/lib/scenarios.mjs` — five scripted agents that stand in for a real coding agent.
- `server/lib/store.mjs` — atomic state persistence, serialised writes, hash-chained append-only ledger with archiving and verification.
- `server/lib/commands.mjs` — allowlisted command runner in a clean environment.
- `server/lib/contracts.mjs` — default contract, structured invariants, approval tiers.
- `server/seed/` — pristine copy of the sample project, including its own tests.

**Interface**

- `public/index.html` — dashboard structure, landmarks, approval panel, contract editor, contest form.
- `public/app.js` — rendering, approval flow, focus/caret preservation, live-region announcements, API calls.
- `public/styles.css` — accessible styling, reduced-motion and forced-colours support.

**Verification** — 89 tests, all passing with `npm test`.

- `test/policy.test.mjs` — enforcement cannot be bypassed.
- `test/scoring.test.mjs` — weights, clamping, trust rules, tier boundaries.
- `test/engine.test.mjs` — end-to-end scenarios against the real workspace.
- `test/features.test.mjs` — frozen weights, approval tiers, check registry, hash-chained ledger and tamper detection.
- `test/api.test.mjs` — HTTP integration: approval gates, invariant enforcement, baseline test comparison, trust downgrade, safety flag, export, contest, and path traversal.

**Documentation**

- `README.md` — quick start, demo walkthrough, architecture, and prototype limitations.
- `PROJECT_PLAN.md` — this full project plan.

Runtime artefacts live in `.earnest/` (workspace, checkpoints, state) and are
git-ignored, so the repository stays clean between runs.

