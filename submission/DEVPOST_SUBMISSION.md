# Earnest — Ctrl+V Hackathon Devpost Submission Pack

Deadline: **Nov 11, 2026, 3:30 AM IST** (Devpost countdown — trust this one).
Judging: Impact 30% · Innovation 25% · Technical Implementation 25% · UX 10% · Presentation 10%.
Copy each field below into the Devpost project form exactly as written.

---

## Project name

Earnest

## Short description (tagline — Devpost "Write a short pitch" field)

Trust is earned. Mistakes must be fixed first. Earnest is an accessibility-first accountability layer for AI coding agents: it verifies every task against your instructions, scores the result in plain language, and makes the agent repair a mistake before it can start anything new.

## Project link (GitHub repository)

TODO — create public repo `Eren-dotcom/earnest` and paste the URL here.
Until then, the code ships as `earnest-v1.1.0.zip` (see "Try it out" in the description).

## Technologies used ("Built with")

Node.js 20+, JavaScript (ES modules), HTML5, CSS3, SHA-256 hash-chained ledger, node:test — zero external dependencies, no build step.

---

## Detailed description (paste into "Tell us about your project")

### Inspiration

AI coding agents are opening software creation to people who never wrote code: students, creators, small business owners, and people who rely on assistive technology. But that access has a catch. When an agent changes a file you didn't ask about, breaks a feature that was working, or confidently claims success it didn't achieve, the person least able to audit a code diff is the one left holding the broken project.

Existing tools offer pieces of the answer — permission prompts, sandboxes, diffs, rollback. None of them answer the questions a non-expert actually asks:

- Did the agent really do what I asked?
- Did it touch anything it shouldn't have?
- Did it break something?
- What happens now — and what must happen before it starts again?

Earnest exists to answer those questions in plain language, with evidence.

### The problem

Access to AI coding help is not real access if supervising the helper requires the very expertise the user doesn't have. A beginner cannot review a 400-line diff. A screen-reader user cannot skim a repository for stray edits. When an agent's mistake goes unnoticed, the user loses work, loses trust in the tool, and often abandons the project entirely. The barrier isn't the AI's capability — it's the missing accountability layer between the agent and the person who owns the project.

### What Earnest does

Earnest wraps an AI agent's work in a verified feedback loop:

1. **Task contract.** Before anything runs, the user confirms the goal, the files the agent may touch, the things that must not change, and how the result will be checked. The scoring weights are frozen at this moment, so the criteria can't be edited after seeing the result.
2. **Checkpoint.** Earnest snapshots the whole project before the agent acts, verified by content hash, so restore is always possible.
3. **Enforced boundaries.** Permissions are enforced in code at the filesystem boundary, not requested in a prompt. An out-of-scope write is *blocked* — the file stays byte-identical — and secret paths (`.env`, `.git/`) stay denied even if a contract tries to allow them.
4. **Independent verification.** Deterministic verifiers compare what is actually on disk against the contract: goal checks on the rendered markup, a real file-by-file scope diff, the project's own tests (with a pre-task baseline, so only *new* failures are blamed on the agent), machine-checked invariants, accessibility checks, and an honesty check that compares the agent's summary against the recorded evidence. Anything a machine can't judge is honestly labelled **Unclear** or left for human review — never silently passed.
5. **Two scores, never merged.** A 1–10 task score (goal 30%, tests 25%, scope 20%, quality/accessibility 15%, honesty/recovery 10%) with the evidence shown next to the number. And a separate 0–10 project trust level that controls what the agent is allowed to do next time: at trust 0 the agent is in **repair-only mode**; at 1–4 every edit needs individual approval; at 5–7 plans are previewed first; at 8–10 the agent earns wider scope.
6. **Repair before new work.** If a verified violation occurs, trust drops *at detection* — not after a review — and new tasks are refused (HTTP 409) until the agent repairs the damage or the user restores the checkpoint. A repair restores at most the level that was lost: a task that breaks scope and then fixes it ends exactly where it started, never rewarded. The incident stays on the record permanently as a safety flag, no matter how good later scores are.
7. **A ledger you can check.** Every event is appended to a SHA-256 hash-chained ledger. Edit or delete a past event and verification fails. Users can contest an event (the dispute is appended, never overwritten) and export the full history as CSV or JSON.

The dashboard itself is built to the standard Earnest asks agents to meet: semantic landmarks, full keyboard operation, focus that survives re-renders, status conveyed by text and glyph rather than colour alone, live regions for screen readers, reduced-motion and forced-colors support, and plain-language explanations of every technical term.

### How we built it

Earnest is a dependency-free Node.js 20+ server and dashboard — no build step, nothing to install. A policy module authorises every mutating action before it touches disk. A verifier registry runs goal, scope, test, invariant, accessibility and honesty checks against real files. A scoring engine computes the weighted task score and the trust transitions. State is kept in an append-only, hash-chained ledger with atomic, serialised writes. Five scripted scenarios stand in for a live agent so every behaviour — a clean task, a blocked scope violation, a test regression, a formatter side-effect, a broken CSS invariant — can be demonstrated and tested end to end. The suite is 90 automated tests, all passing, including three concurrent full runs to prove the test infrastructure itself is sound.

### Challenges we ran into

The hardest decision was honesty. It is easy to build a verifier that always produces a number; it is harder to build one that says "Unclear" when the evidence is thin — for example, an invariant written in prose, or a test that was already failing before the agent started. We chose the honest answer every time, because a trust system that invents precision is worse than none. The second challenge was making penalties fair: deterministic violations (a blocked out-of-scope write is a fact on disk) apply immediately, while rewards wait for human review — and ambiguity never costs the agent anything.

### Accomplishments we're proud of

- Enforcement that is real, not theatrical: the out-of-scope file is byte-identical after a blocked attempt, and an automated test asserts it.
- A repair flow with net-zero trust: fixing your own mistake never becomes a way to farm trust.
- A tamper-evident ledger whose verification is one click in the dashboard.
- An interface a non-expert can actually use to answer "what did the agent do, and is my project okay?"

### What we learned

Trust is not a feeling you prompt into a model — it is an operational property of a system: checkpoints, boundaries, evidence, consequences. And accessibility is not a feature bolted onto a developer tool; for the people who need AI coding help most, the accessible explanation *is* the product.

### What's next

Connect Earnest to a real coding agent through a sandboxed adapter, move the isolation boundary from a directory to a container, and add authentication so teams and classrooms can keep a shared, auditable history of agent work.

### Try it out

**Live demo: https://earnest-zeta.vercel.app/** — click Reset for a clean run.
Note: the hosted demo keeps its state per server instance, so it may reset between visits; the full experience (including a persistent ledger) is the local run:

```bash
node server/index.mjs   # or: npm start
```

Open http://localhost:5173 — no dependencies to install. Run the "Verified task" scenario to see trust rise 5 → 6 after review; run "Agent mistake" to watch an out-of-scope write get blocked, trust drop 5 → 4, new tasks refused, and a verified repair restore trust to exactly 5 — with the safety flag staying on record. `npm test` runs the 90-test suite.

### Honest notes

- Agent actions in this prototype are scripted scenarios, not a live model — the accountability layer (contracts, enforcement, verification, scoring, trust, ledger) is fully real; the agent adapter is the next step.
- The prototype was built on November 8, 2026, during this hackathon's submission window, and hardened since (v1.1.0: a follow-up review caught that the trust-0 repair-only lock was not enforced by the API — it now returns HTTP 409, with a logged one-level user override as the escape hatch; localhost-by-default binding; collision-proof test ports).

---

## Devpost form checklist

- [ ] Project name: Earnest
- [ ] Short pitch: tagline above
- [ ] Detailed description: section above
- [ ] Demo video: upload to YouTube, keep under 3 minutes (script in DEMO_VIDEO_SCRIPT.md), paste link
- [x] GitHub / project link: https://github.com/Eren-dotcom/Earnest · Live demo: https://earnest-zeta.vercel.app/
- [ ] Built with: Node.js, JavaScript, HTML, CSS
- [ ] Screenshots: see shot list below (4–5 images)
- [ ] Submit before 3:30 AM IST, Nov 11

## Screenshots — shot list (capture at 1400×1000, full dashboard)

1. `1-dashboard.png` — fresh state after Reset: trust 5, scenario list, contract panel.
2. `2-verified-score.png` — after running **Verified task** and approving the plan: score 9.7, marked provisional, evidence list visible.
3. `3-violation-blocked.png` — after Reset + **Agent mistake**: scope violation notice, Navbar.js diff showing no change, trust 4, repair-only banner.
4. `4-repair-resolved.png` — after **Repair and verify**: trust back to 5, safety flag still visible on the record.
5. Optional `5-ledger.png` — ledger verification result: chain OK.

Note (2026-11-10): screenshots could not be captured from this workspace — the local browser binary is policy-blocked here and the cloud browser cannot reach this machine's localhost. Capture them from a live deployment (best for judges too) or by running the zip locally, following the states above.
