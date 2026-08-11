# pi-panel

Multi-model panel code review for [pi](https://github.com/earendil-works/pi). A committee of three reviewer subagents on **different model families** independently reviews a diff with an identical brief, deliberates over contested findings with verified evidence, and accepts or rejects findings by **deterministic majority vote** — the vote tally is JavaScript, not LLM judgment.

Single-model review inherits that model's training-data biases. pi-panel's premise: **disagreement is the feature**. The prompt is the constant; the model is the variable.

## Commands

| Command | What it does |
|---|---|
| `/panel-review [target]` | Panel review of a diff. **Report only — never touches the worktree.** Target: nothing (uncommitted changes), a commit SHA, a branch name, or a PR number/URL. |
| `/panel-loop [request]` | The full loop: optional implementation, then repeated panel → fix → re-panel cycles, **one git commit per round**, until the panel accepts nothing or the loop cap is hit. |
| `/panel-setup` | Configure the panel: pick 3 reviewer models from your available (authenticated) models. Re-runnable. Also auto-offered the first time you run `/panel-review` or `/panel-loop` unconfigured. |
| `/panel-cancel` | Stop the active run. |
| `/panel-ping` | Diagnostics: ping the pi-subagents RPC and run a probe workflow. |

`/panel-loop [target-or-request]` entry modes (never asks):

- **args resolve to a git target** (branch, commit SHA, or PR) → loop on already-committed work: panel reviews that diff, then fix rounds commit on top. Example: `/panel-loop main`.
- **args don't resolve to a git target + clean tree** → treated as an implementation request: an implementer worker implements it, commits (`panel-loop: round 0 implementation`), then the panel reviews it.
- **implementation request + dirty tree** → error: commit or stash first (the implementer never commits your pre-existing changes).
- **no args + dirty tree** → panel reviews the current diff, then fix rounds.
- **no args + clean tree** → error: nothing to review (the message suggests passing a branch/sha).

## How a panel run works

```
ROUND 1   3 seats (kimi / sol / glm), identical brief, blind to each other
          ↓ findings as structured JSON (outputSchema)
CLUSTER   pure JS: same file+symbol within 15 lines → one cluster
TALLY     ≥2 seats raised it → accepted · 1 seat → contested
DELIBERATE contested clusters go back to all seats via resume (each seat keeps
          its round-1 context): vote accept/reject/abstain, but a position may
          only change on evidence verified with tools THIS round
CONSENSUS accept ≥2 · reject ≥2 · no majority after 2 rounds → rejected-unresolved
          dissent is always preserved in the report, never silently dropped
```

`/panel-loop` then sends only **accepted** findings to a fixer (never a panel seat — the panel only judges diffs, it never defends code it wrote), commits them as `panel-loop: round N fixes`, and re-panels. Round 2+ reviewers are **anchored**: they read the previous round's full record first, verify each accepted finding (resolved / partial / not-resolved), and may raise new findings only with an explicit `whyMissedBefore` justification — so the loop converges instead of freelancing forever.

Style findings are advisory-only: never voted, never block.

## Install

Requires the [pi-subagents](https://www.npmjs.com/package/pi-subagents) package (orchestration runtime) and three model providers configured in pi.

```bash
pi install npm:pi-subagents        # if not already installed
pi install git:github.com/pourtorabehsan/pi-panel
```

Or for local development, add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/Users/ehsan/src/github.com/pourtorabehsan/pi-panel"]
}
```

## Configuration

`~/.pi/agent/settings.json`, key `panel`. **There are no default seats** — model auth is per-user, so the panel is configured via `/panel-setup` (interactive picker over your available models) or by setting `panel.seats` manually:

```json
{
  "panel": {
    "seats": [
      { "name": "kimi", "model": "fireworks/accounts/fireworks/models/kimi-k3" },
      { "name": "sol",  "model": "openai/gpt-5.6-sol" },
      { "name": "glm",  "model": "fireworks/accounts/fireworks/models/glm-5p2" }
    ],
    "implementer": null,
    "fixer": null,
    "maxDeliberationRounds": 2,
    "maxLoopRounds": 2,
    "autoCommit": true,
    "artifactDir": "~/.panel",
    "maxDiffLines": 4000
  }
}
```

(seats shown are an example, not a default.) Non-seat keys have the defaults above. Exactly 3 seats, distinct names and models — panel diversity is the point. Pick models from **different labs** (`/panel-setup` warns if all three share one provider).
- `implementer` / `fixer`: `null` = session model. A value matching a seat model is ignored with a warning (the fixer must never be a panel seat).
- `autoCommit: false` → fixer/implementer leave changes uncommitted; round boundaries become "current diff" instead of `git show <sha>`. Commits are strongly recommended — they define the rounds.
- Diffs larger than `maxDiffLines` require confirmation (TUI) or are rejected (non-TUI).

## Artifacts

Every run writes a PR-style review thread under `<artifactDir>/<repo-slug>/<run-id>/`. The default `~/.panel` keeps repos clean — **nothing is written into the worktree**. A relative `artifactDir` (e.g. `.panel`) is treated as repo-relative if you prefer per-repo artifacts:

```
~/.panel/daily-a1b2c3/20260811-121500-x3k9/
  target.md              # what was reviewed + the commands used
  round-1/
    diff.patch           # exactly what the panel saw
    findings-kimi.json   # per-seat structured findings
    findings-sol.json
    findings-glm.json
    clusters.json        # extension-computed clusters + votes
    rebuttal-sol-d1.md   # deliberation votes + verified evidence, per deliberation round
    consensus.md         # accepted / rejected-with-dissent / advisory
  round-2/               # /panel-loop only
    fix-commit.txt       # sha + message of the fix round
    diff.patch           # git show <fix-sha>
    ...
  final-report.md        # rounds table, fixer validation evidence, leftovers, stop reason
```

**pi-subagents' own artifacts:** pi-subagents writes to `.pi-subagents/` in the repo by default. To keep repos clean, set its artifact preference to the pi session dir in `~/.pi/agent/extensions/subagent/config.json`:

```json
{ "artifactDir": "session" }
```

pi-panel runs pass `mission: false`, so no mission records are written either way.

## First run / smoke test (M1)

1. `pi` in any git repo.
2. `/panel-ping` — verifies the pi-subagents RPC bridge and spawn plumbing. Expect: "RPC reachable: protocol v1, methods: ping, status, spawn, steer, interrupt, stop, resume", then a probe workflow launch notification.
3. `/panel-review` on a clean tree → expect the "nothing to review" error (proves command + git wiring).
4. Make a small change with an obvious bug, then `/panel-review`. Inspect `~/.panel/<repo-slug>/<run-id>/round-1/` — three `findings-*.json`, `clusters.json`, `consensus.md`.

## Known limitations (pi-subagents coupling)

These are enforced by pi-subagents' current runtime behavior, verified against its source:

- **`outputSchema` is dropped on resumed deliberation seats.** pi-subagents'
  resume path does not carry `outputSchema`, so resumed seats return free text.
  Mitigation: the exact vote JSON shape is embedded in the deliberation task
  text, and the extension-side parse-fallback chain (structured → whole-output
  JSON → fenced block → outermost braces) recovers votes. A seat whose votes
  still can't be parsed is recorded as abstaining with a note in consensus.md.
- **Workflow results are read from the async run's `status.json`** rather than
  the RPC `status` method (verified: pi-subagents persists `workflow.value`
  there before emitting the completion event, so there is no race). A
  pi-subagents upgrade that changes the on-disk layout will fail loudly at
  result-read time.
- **Reviewer seats are prompt-instructed read-only, and this is also enforced
  deterministically**: the extension fingerprints the worktree (HEAD +
  `git status --porcelain`, excluding tooling dirs) before every review and
  deliberation phase and fails the run if a seat modified anything.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "pi-panel requires the pi-subagents package" | `pi install npm:pi-subagents`, then restart pi. |
| Seat failed / "panel degraded" warnings | A model id is wrong or a provider is unauthenticated. Check `panel.seats` against `pi --list-models`. The panel runs fine with 2 seats; 2 failures abort the run. |
| "deliberation used fresh-seat fallback" in consensus notes | The retained-resume path wasn't available for a seat; deliberation fell back to a fresh reviewer reading the round artifacts (weaker context, still correct votes). |
| Orphaned run after `/reload` or restart | In-memory state is lost by design (v1). Artifacts are on disk; just re-run the command. |
| "Detached for intercom coordination" | A child tried to ask its supervisor a question, which kills RPC-spawned workflows. All panel briefs forbid intercom; if you still see this, the child ignored its instructions — report it and re-run. |
| "commit or stash them first" but you have no real changes | Was a bug: tooling dirs (`.panel/`, `.pi-subagents/`) counted as dirty. Fixed — they're excluded from the check. Update if you see this. |
| Expensive runs | Large diffs × 3 models × deliberation rounds cost real tokens. Keep diffs small or lower `maxDiffLines`. |

## Development

TypeScript loaded via pi's jiti — no build step. Pure logic (clustering, tally, config, artifacts, briefs, workflow-script builders) is unit-tested with the Node test runner:

```bash
node --test test/*.test.ts
```

Typecheck (adjust the absolute `paths` entry in `tsconfig.json` to your pi install; no emit, not a build step):

```bash
npx -p typescript tsc --noEmit -p tsconfig.json
```

See [SPEC.md](./SPEC.md) for the full protocol, schemas, and design risks.
