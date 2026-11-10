# Earnest — Demo Video Script (target 2:30, hard limit 3:00)

Format: screen recording of the real dashboard at http://localhost:5173, 1080p, browser zoom 110–125% so text stays readable. Voiceover recorded over the capture (or Kokoro narration — English `af_heart`). Every number below was verified live on 2026-11-08; do not change them.

Recording rules: cursor moves slowly; pause 1 second on every score/trust change; never describe an event while the screen shows something else.

| # | Time | Screen (what to click / show) | Narration (verbatim) |
|---|------|-------------------------------|----------------------|
| 1 | 0:00–0:15 | Dashboard, fresh state. Trust meter at 5, scenario list visible. | "AI coding agents give people who can't code a way to build software. But when the agent makes a mistake, those same people can't check its work. Earnest fixes that. It verifies every task, scores it in plain language, and makes the agent earn trust — or lose it." |
| 2 | 0:15–0:35 | Select **Verified task**. Show the contract: approved files, scoring weights. Click Run, plan preview appears, click **Approve the whole plan**. | "Every task starts with a contract: what to do, which files it may touch, and how it will be judged. The scoring weights are frozen before the agent starts — they can't be changed after the result is known." |
| 3 | 0:35–0:55 | Task completes. Zoom on the score **9.7**, marked **provisional**, and the evidence list. Click **Accept** in review. Trust moves **5 → 6**. | "The agent added the alt text, stayed in scope, and the project's tests pass. The score — 9.7 — stays provisional until I review it. I accept, and trust rises from 5 to 6. Rewards wait for a human. Penalties don't." |
| 4 | 0:55–1:25 | Click **Reset**. Select **Agent mistake**. Run, approve the plan. The run completes with a scope violation; open the diff: **Navbar.js is byte-identical**. Trust shows **4**, repair-only banner visible. | "Now the agent does the real task — and then tries to rewrite a file it was never allowed to touch. Earnest blocks the write at the filesystem itself. The file is byte-identical. Trust drops from 5 to 4 the moment the violation is detected." |
| 5 | 1:25–1:45 | Click Run on any scenario → **refused (repair-only)**. Then click **Repair and verify**. Incident resolves, trust back to **5**, safety flag still visible. | "While a mistake is unresolved, new tasks are refused. The agent must repair first. The repair is verified — and trust returns to exactly 5. Fixing your own mistake is never a reward. And the safety flag stays on the record. Permanently." |
| 6 | 1:45–2:05 | Click **Verify ledger** — chain OK. Then run **Regression** quickly (or show its row): score **6.9**. | "Every event is written to a hash-chained ledger — edit history and verification fails. And when an agent's change breaks the project's own tests, Earnest catches that too, scoring the task 6.9." |
| 7 | 2:05–2:30 | Return to dashboard overview. Show trust meter, scenario list, plain-language explanations. End on the tagline card. | "Earnest is accessibility-first: keyboard-friendly, screen-reader-friendly, and every verdict explained in plain language. Because access to AI shouldn't require the expertise AI was supposed to provide. Earnest — trust is earned. Mistakes must be fixed first." |

## Shot notes

- Beats 3, 4 and 5 are the video. If time runs short in editing, cut beat 6's Regression half, never beats 4–5.
- Show, don't claim: the byte-identical diff (beat 4) and the refused task (beat 5) must be visible on screen while the narration says them.
- Keep the browser chrome out of frame where possible; keep the URL bar in one early shot so judges see it is a real local app.
- Captions: burn in or upload a caption track — the video should meet the same accessibility bar as the product.
- Upload: YouTube, public or unlisted (Devpost accepts both; public is safer), title: "Earnest — Trust is earned. Mistakes must be fixed first. (Ctrl+V Hackathon)".
