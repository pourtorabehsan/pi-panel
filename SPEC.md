# pi-panel — Specification

Multi-model panel code review for pi: a committee of three reviewer subagents on
**different model families** that independently review a diff with an identical
brief, deliberate over contested findings with evidence, and accept or reject
findings by deterministic majority vote.

## 1. Overview & goals

Single-model code review inherits that model's training-data biases and blind
spots. pi-panel's premise: **disagreement is the feature**. Three reviewers from
different model families (Moonshot Kimi, OpenAI GPT, Zhipu GLM) receive the
*same* prompt — the prompt is the constant, the model is the variable. Findings
raised independently by 2+ of 3 families are strong signal. Findings raised by
only one seat go through evidence-based deliberation; majority vote decides.

Crucially, **models never do arithmetic**. Models do exactly two things: review,
and vote with evidence. Clustering, vote counting, and termination decisions are
pure JavaScript in the extension.

Two commands share one engine:

- `/panel-review [target]` — the atom. Produces a consensus report. **Never
  writes to the worktree.**
- `/panel-loop [request]` — the composition. Optional implementation, then
  repeated panel → fix → re-panel cycles, one git commit per round, until the
  panel has nothing left to accept (or the loop cap is hit).

### Goals

- G1: Majority-consensus findings across 3 model families, with dissent
  preserved in the report — never silently dropped.
- G2: Fully deterministic tally: no LLM judgment in clustering, voting, or
  loop termination.
- G3: Artifact trail simulating a PR review thread: every round's diff,
  findings, rebuttals, and consensus persisted to disk.
- G4: `/panel-loop` ends in a clean per-round commit history.

### Non-goals (v1)

- N1: No TUI panel/vote visualization widget. Progress is `ctx.ui.setStatus` +
  notifications; the report is a file.
- N2: No peer-to-peer agent messaging. Deliberation is mediated: the extension
  hands each seat the others' findings via resume tasks.
- N3: No `/panel-loop` against a branch/PR target. `/panel-loop` operates on the
  current checkout only (uncommitted changes or a new implementation request).
  To loop on a branch, check it out first.
- N4: No cross-restart resume of an in-flight panel run. The orchestrator state
  machine is in-memory; on-disk artifacts allow manual inspection/recovery only.
- N5: No worktree isolation. One writer at a time in the active checkout.

## 2. Commands & UX

### `/panel-review [target]`

Report-only. Target resolution (deterministic, in order):

| Invocation | Resolution |
|---|---|
| *(no args)* | `git diff HEAD` (staged + unstaged). Empty → error "nothing to review". |
| 40-char or short SHA | `git show <sha>` |
| branch name (resolves via `git rev-parse --verify <arg>^{commit}` and is not HEAD's own branch) | `git diff <arg>...HEAD` |
| PR number or URL containing `github.com` or `pull` | `gh pr view <arg>` (context) + `gh pr diff <arg>` |

The resolved target description (e.g. `PR #123: Title` or `diff of working
tree`) is embedded in the reviewer brief.

Errors: not a git repo; empty diff; `gh` missing/failing for PR targets; diff
longer than `maxDiffLines` → `ctx.ui.confirm` prompt to proceed (non-TUI modes:
hard error).

### `/panel-loop [target-or-request]`

Entry modes (deterministic, never ask):

| Invocation | Tree state | Behavior |
|---|---|---|
| args resolve to a git target (branch / SHA / PR) | any | Loop on already-committed work: panel round 1 on the target diff, then fix rounds commit on top of the current branch. |
| args not a git target (implement request) | clean | Round 0: implementer worker implements the request, validates, commits. Then panel loop. |
| args not a git target (implement request) | dirty | Error: "commit or stash your changes first" (the implementer must never commit pre-existing user changes). |
| empty args | dirty (diff vs HEAD non-empty) | Start with panel round 1 on the current diff. |
| empty args | clean | Error: "nothing to review", suggesting a branch/SHA argument. |

### `/panel-cancel`

Stops the active panel run: RPC `stop` for any live async run, marks the state
machine cancelled, writes a `cancelled` note into the run's `final-report.md`.

### Mode handling

- `ctx.mode === "tui"` is the primary target: status via
  `ctx.ui.setStatus("panel", ...)`, milestones via `ctx.ui.notify`.
- `ctx.mode === "rpc"`: same notifications (they are fire-and-forget safe).
- `ctx.mode === "print"` / `"json"`: commands refuse with a clear error
  ("panel runs are long-lived; use interactive mode"). v1 simplification.
- A second `/panel-*` invocation while a run is active is rejected with an
  error pointing at the active run's artifact directory.

## 3. The panel protocol

### Seats

Three fixed seats (configurable, see §7). Defaults:

| Seat | Model |
|---|---|
| `kimi` | `fireworks/accounts/fireworks/models/kimi-k3` |
| `sol` | `openai/gpt-5.6-sol` |
| `glm` | `fireworks/accounts/fireworks/models/glm-5p2` |

All seats receive the **identical** brief (§6). Fresh context
(`context: "fresh"`). Read-only on the repo: reviewers never edit, stage, or
commit. The fixer/implementer is **never a panel seat** — the panel only ever
judges diffs; it never defends code it wrote.

### State machine (per panel run)

```
RESOLVE_TARGET
  → ROUND_N_REVIEW        (3 seats in parallel, blind in round 1 / anchored in round 2+)
  → CLUSTER_AND_TALLY     (pure JS)
  → contested clusters?
      yes → DELIBERATE (resume seats, structured votes, ≤ maxDeliberationRounds)
      no  → CONSENSUS
  → CONSENSUS → write consensus.md
  → /panel-review: → FINAL_REPORT → DONE
  → /panel-loop:
      accepted findings? → FIX (fixer worker, commit) → next ROUND (anchored)
      none / cap hit     → FINAL_REPORT → DONE
```

### Voting rules

- A **cluster** is a group of mechanically-similar findings (§5).
- Raised independently by ≥2 seats → **accepted** (no deliberation needed).
- Raised by exactly 1 seat → **contested** → deliberation.
- In deliberation each seat casts `accept | reject | abstain` per contested
  cluster. Accept requires **≥2 accept votes**. Reject requires ≥2 reject
  votes. Anything else after `maxDeliberationRounds` (default 2) → **rejected
  as unresolved**, listed in dissent.
- The raising seat's round-1 finding counts as its initial `accept` vote going
  into deliberation; its deliberation vote may confirm or retract it.
- `severity: "style"` findings are **advisory-only**: never voted, never block,
  always land in the "advisory" report section.
- **Dissent is preserved**: every rejected finding appears in the report with
  its votes and the deliberation trail.

### Deliberation rules (enforced via the resume task text, §6.3)

- Seats are **resumed** (pi-subagents `resume`), keeping their round-1 session
  context so they can defend with their own prior investigation.
- Each seat receives the contested clusters with the raising seat's evidence.
- Rule of evidence: *"Change your position only on evidence you verified
  yourself with tools this round."*
- Max 2 deliberation rounds; round 2 shows each seat the others' round-1
  deliberation votes and rationales.

### Termination (`/panel-loop`)

Loop ends when:

1. a panel round verifies **all** previously accepted findings `resolved` AND
   yields **zero** accepted new findings; or
2. `maxLoopRounds` (default 2) is hit → remaining open findings are listed in
   `final-report.md`.

`not-resolved` / `partial` verdicts on previously accepted findings re-enter
the fix queue and count against the loop cap.

## 4. Findings schema

Each reviewer's round output is validated against this JSON Schema (passed as
`outputSchema` on the workflow child):

```json
{
  "type": "object",
  "required": ["findings"],
  "additionalProperties": false,
  "properties": {
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "file", "lineStart", "lineEnd", "symbol", "title", "claim", "evidence", "suggestedFix", "severity", "confidence"],
        "properties": {
          "id":           { "type": "string", "description": "seat-local slug, e.g. f1, f2" },
          "file":         { "type": "string", "description": "repo-relative path" },
          "lineStart":    { "type": "integer", "minimum": 1 },
          "lineEnd":      { "type": "integer", "minimum": 1 },
          "symbol":       { "type": "string", "description": "enclosing function/type/method, or \"\" if none" },
          "title":        { "type": "string", "maxLength": 120 },
          "claim":        { "type": "string", "description": "what is wrong and the realistic scenario where it breaks" },
          "evidence":     { "type": "string", "description": "file/line references or command output the seat verified" },
          "suggestedFix": { "type": "string" },
          "severity":     { "enum": ["blocker", "major", "minor", "style"] },
          "confidence":   { "enum": ["low", "medium", "high"] }
        }
      }
    }
  }
}
```

Round-2+ verdict output schema (separate `outputSchema`):

```json
{
  "type": "object",
  "required": ["verdicts", "newFindings"],
  "additionalProperties": false,
  "properties": {
    "verdicts": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["clusterId", "verdict", "evidence"],
        "properties": {
          "clusterId": { "type": "string" },
          "verdict":   { "enum": ["resolved", "partial", "not-resolved"] },
          "evidence":  { "type": "string" }
        }
      }
    },
    "newFindings": {
      "type": "array",
      "items": { "$ref": "#/definitions/findingWithJustification" }
    }
  },
  "definitions": {
    "findingWithJustification": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "file", "lineStart", "lineEnd", "symbol", "title", "claim", "evidence", "suggestedFix", "severity", "confidence", "whyMissedBefore"],
      "properties": {
        "id":           { "type": "string" },
        "file":         { "type": "string" },
        "lineStart":    { "type": "integer", "minimum": 1 },
        "lineEnd":      { "type": "integer", "minimum": 1 },
        "symbol":       { "type": "string" },
        "title":        { "type": "string", "maxLength": 120 },
        "claim":        { "type": "string" },
        "evidence":     { "type": "string" },
        "suggestedFix": { "type": "string" },
        "severity":     { "enum": ["blocker", "major", "minor", "style"] },
        "confidence":   { "enum": ["low", "medium", "high"] },
        "whyMissedBefore": { "type": "string", "description": "mandatory: why the previous round did not surface this" }
      }
    }
  }
}
```

Deliberation vote output schema:

```json
{
  "type": "object",
  "required": ["votes"],
  "additionalProperties": false,
  "properties": {
    "votes": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["clusterId", "vote", "verifiedEvidence", "rationale"],
        "properties": {
          "clusterId":         { "type": "string" },
          "vote":              { "enum": ["accept", "reject", "abstain"] },
          "verifiedEvidence":  { "type": "string", "description": "evidence the seat verified with tools THIS round" },
          "rationale":         { "type": "string", "maxLength": 500 }
        }
      }
    }
  }
}
```

## 5. Clustering & tally algorithm (pure JS)

### Clustering

```
function clusterKey(f):
    file   = normalizePath(f.file)              // strip ./, lowercase on case-insensitive FS? No: keep case, compare exact after ./ strip
    symbol = normalizeSymbol(f.symbol)          // trim, lowercase, strip "()" and receiver prefixes like "(s *Store)." / "this."
    return file + "|" + symbol

function cluster(findingsBySeat):
    clusters = []
    for seat, findings of findingsBySeat:
        for f of findings:
            if f.severity == "style": route to advisory; continue
            c = clusters.find(c =>
                    clusterKey(c.representative) == clusterKey(f)
                    AND lineDistance(c.representative, f) <= 15)
                    // lineDistance = 0 if [lineStart,lineEnd] ranges overlap,
                    // else gap between ranges
            if c: c.add(f, seat)
            else: clusters.push(new Cluster(f, seat))
    return clusters
```

Cluster id: `c1`, `c2`, … assigned in first-seen order (deterministic: seats
iterated in config order, findings in array order).

**Known limits (documented in report footer):** semantic duplicates with
different symbols or distant lines survive as separate clusters. This is
tolerated: both get voted on independently, and a wrong duplicate is caught in
deliberation or shows up as near-identical fixes. Precision of the vote matters
more than perfect dedup.

### Tally

```
for cluster:
    raisers = distinct seats in cluster
    if raisers.size >= 2: cluster.status = "accepted"
    else: cluster.status = "contested"

// after deliberation rounds (≤ maxDeliberationRounds):
for contested cluster:
    votes = latest vote per seat (seat's round-1 raise = initial "accept")
    accepts = count(vote == "accept"); rejects = count(vote == "reject")
    if accepts >= 2: "accepted"
    else if rejects >= 2: "rejected"
    else if rounds remain: another deliberation round
    else: "rejected-unresolved"   // listed in dissent
```

Round-2+ (anchored) tally: a previously-accepted cluster stays open if any
seat votes `not-resolved` or ≥2 seats vote `partial`; a `partial` verdict from
exactly 1 seat goes to one deliberation round. New findings from round 2+
cluster and vote exactly like round-1 findings.

## 6. Artifacts & briefs

### Artifact layout

The extension writes **all** artifacts. workflowScripts cannot touch the
filesystem; reviewers are read-only; the fixer never writes under the artifact
dir.

```
<artifactDir>/<repo-slug>/<run-id>/  # artifactDir default: ~/.panel (outside the repo)
                                   # relative artifactDir → repo-relative (legacy escape hatch)
  target.md                        # resolved target description + command(s) used
  round-1/
    diff.patch                     # exactly what was reviewed
    findings-kimi.json             # validated structured output, per seat
    findings-sol.json
    findings-glm.json
    clusters.json                  # extension-computed clusters + raisers
    rebuttal-kimi-d1.md            # deliberation vote payloads, per deliberation round
    rebuttal-sol-d1.md             # (trail preserved: -d1, -d2, ...)
    rebuttal-glm-d1.md
    consensus.md                   # human-readable verdicts, votes, dissent
  round-2/                         # /panel-loop only
    fix-commit.txt                 # sha + commit message of the fix round
    diff.patch                     # git show <fix-sha>
    ... same shape ...
  final-report.md                  # full history, verdicts, dissent, leftovers, stop reason
```

`run-id`: `YYYYMMDD-HHMMSS-<4 random base36 chars>`. `final-report.md` ends
with: rounds run, findings accepted/rejected per round, validation evidence
from the fixer, why the loop stopped.

Artifacts live outside the repo by default (`~/.panel/<repo-slug>/`), so runs
never dirty the worktree and no `.gitignore` entry is needed. The fixer is
instructed to never stage panel/subagent artifact files regardless.

### 6.1 Round-1 brief (literal text; `{TARGET_DESCRIPTION}` and `{DIFF_PATH}` substituted)

```
You are one seat on a three-model review panel. You are reviewing: {TARGET_DESCRIPTION}.
The full diff under review is at {DIFF_PATH} — read it first.

Independently review the entire diff for correctness, regressions, security,
tests, and maintainability. Work blind: do not look for other reviewers'
output; none exists yet.

How to review:
- Diffs alone are not enough. Read the full files being modified to understand
  surrounding context, control flow, and error handling.
- When changes touch inputs, auth, storage, networking, or secrets, trace the
  trust boundary instead of reviewing code in isolation.
- Check for project conventions (AGENTS.md, CONTRIBUTING.md, existing patterns)
  before claiming something does not fit.
- Only review the changes. Do not review pre-existing code the diff did not touch.

What to look for:
- Bugs: logic errors, incorrect conditionals, missing guards, edge cases
  (null/empty/undefined, error conditions, races), error handling that swallows
  or misroutes failures.
- Security: assume changed code may be reachable by untrusted input unless you
  can verify otherwise. Flag concrete exploit paths (attacker-controlled input,
  missing control, impact), not vague risk language.
- Structure: does the change follow existing patterns and abstractions?
- Performance: only if obviously problematic (O(n²) on unbounded data, N+1).

Before you flag something:
- Be certain. If you are not sure it is a bug, investigate with tools until you
  are, or do not flag it. Do not invent hypothetical problems; describe the
  realistic scenario where it breaks.
- Do not flag style preferences unless they clearly violate established project
  conventions (use severity "style" for those; they are advisory).

Constraints:
- You are READ-ONLY. Never edit, stage, or commit any file.
- Return only structured output per the output schema. No prose summary.
```

### 6.2 Round-2+ anchored brief (literal; placeholders substituted)

```
You are one seat on a three-model review panel, round {N}.
A previous panel round already reviewed this work. Its full record is in
{PREV_ROUND_DIR}: findings-*.json, clusters.json, rebuttal-*.md (if present),
and consensus.md. Read that directory first — this is the review thread you
are continuing.

The fix commit under review is {FIX_SHA}; its diff is at {DIFF_PATH}.
The accepted findings the fixer was asked to address are in
{PREV_ROUND_DIR}/consensus.md.

Your tasks, in order:
1. For EACH accepted finding from the previous round: verify whether the fix
   commit resolves it. Verdict: resolved | partial | not-resolved, with
   evidence you verified yourself with tools (file/line refs or command output).
2. Review the fix diff itself for regressions or new issues INTRODUCED by this
   fix.
3. You may raise new findings outside the fix diff, but each requires an
   explicit whyMissedBefore justification. "It was visible in round {N-1} but
   not flagged" is acceptable only with an explanation; prefer precision over
   volume.

Constraints:
- READ-ONLY. Never edit, stage, or commit.
- Return only structured output per the output schema (verdicts + newFindings).
```

### 6.3 Deliberation resume task template (literal)

```
Deliberation round {D} on contested findings from your panel review.

The following finding clusters were raised by exactly one seat. For each
cluster, the raising seat's claim and evidence are included. The other seats
did not raise it.

{CONTESTED_CLUSTERS_JSON}

For each cluster, cast a vote: accept | reject | abstain.

Rules:
- Change (or hold) your position ONLY on evidence you verified yourself with
  tools this round. Re-open the files. Run the commands. Check the claim.
- If you raised the finding: defend it with stronger verified evidence, or
  retract it honestly with vote "reject" if verification fails.
- If you did not raise it: accept only if you verified the bug is real;
  reject only if you verified it is not; otherwise abstain.
- verifiedEvidence must reference what YOU checked this round (file/line,
  command + output). "Trusting the other seat" is not evidence.

Return only structured output per the vote schema.
```

### 6.4 Fixer task template (literal)

```
Apply the following panel-accepted review findings to the working tree.

{ACCEPTED_FINDINGS_JSON}

Rules:
- Apply ONLY these findings. No drive-by changes, no reformatting, no scope
  growth. If a suggested fix is wrong or incomplete, implement the minimal
  correct fix for the finding's claim instead.
- Follow existing code conventions.
- Run the focused validation for the area you changed (build/test/lint — the
  narrowest meaningful commands). Report exact commands and exit codes.
- When done, commit ONLY the files you modified:
  `git add <specific paths>` then
  `git commit -m "panel-loop: round {N} fixes ({K} accepted findings)"`.
  Never `git add -A` / `git add .`. Never stage `.panel/` or any file you did
  not modify.
- Return: changed files, validation commands + exit codes, commit sha,
  anything you could not fix and why.
```

### 6.5 Implementer (round 0) task template (literal)

```
Implement the following request in the current repository:

{REQUEST}

Rules:
- Keep the change scoped to the request. Follow existing conventions.
- Run the narrowest meaningful validation (build/test/lint). Report exact
  commands and exit codes.
- Commit ONLY the files you created or modified:
  `git add <specific paths>` then
  `git commit -m "panel-loop: round 0 implementation"`.
  Never `git add -A`. The tree was clean when you started; keep it that way
  except for your commit.
- Return: changed files, validation commands + exit codes, commit sha.
```

## 7. Extension architecture

### Repo layout & packaging

```
pi-panel/
  package.json          # name "pi-panel", keywords ["pi-package"], pi.extensions entry
  README.md
  SPEC.md
  src/
    index.ts            # default export(pi): register commands, wire events, own run state
    config.ts           # load + validate config
    rpc.ts              # pi-subagents RPC client (request/reply correlation, async-complete)
    git.ts              # target resolution, diff capture, commit helpers
    findings.ts         # schema types, parse/validate, clustering, tally
    briefs.ts           # brief/task template constants (§6), substitution
    workflows.ts        # workflowScript template builders per phase
    artifacts.ts        # run dir creation, artifact writers, report rendering
    orchestrator.ts     # the event-driven panel state machine
```

`package.json`:

```json
{
  "name": "pi-panel",
  "version": "0.1.0",
  "keywords": ["pi-package"],
  "private": true,
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  },
  "pi": { "extensions": ["./src/index.ts"] }
}
```

No runtime npm dependencies (Node built-ins + pi-provided modules only). TypeScript
via pi's jiti loader; no build step.

### pi-subagents RPC client (`rpc.ts`)

In-process event bus (`pi.events`), protocol version 1:

- Request: `pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method, params, source: { extension: "pi-panel" } })`
- Reply: `pi.events.on("subagents:rpc:v1:reply:" + requestId, handler)` with
  `{ version, requestId, method?, success, data | error: { code, message } }`.
- Methods used: `ping`, `spawn`, `status`, `stop`, `resume` (deliberation uses
  `resume` on retained workflow children — see workflows).
- `ping` reply shape (verified against pi-subagents source): `{ version,
  methods, capabilities, events: { ready, request, replyPrefix,
  asyncComplete: "subagent:async-complete", processTerminal }, session }`.
- Completion: subscribe once to `pi.events.on("subagent:async-complete", …)`.
  Payload includes `id` (async run id), `success`, `state`, `sessionId`. Match
  against the active run's async id and the current session id; ignore others.
- After completion, fetch results with `status` (`{ id }`) and read the
  workflow result from the returned `details`/output artifact paths.

Client responsibilities: unique `requestId` (`panel-<counter>-<random>`),
one-shot reply listener with timeout (default 30s for ping/status; spawn
returns after launch), typed errors.

**Degradation:** on command start, `ping`. If no reply within 5s (or error),
fail with: "pi-panel requires the pi-subagents package. Install it
(`pi install npm:pi-subagents`) and retry." Also `pi.events.on("subagents:rpc:v1:ready")`
may be used to detect late availability, but v1 only pings at command time.

### workflowScript templates (`workflows.ts`)

Scripts run in a sandbox: only `runs.run`, `runs.all`, `runs.status`,
`runs.ref/refs`, `emit`, `console`, standard JS. **No filesystem.** Scripts
return structured data; the extension writes artifacts.

Spawn params: `{ workflowScript, async: true, context: "fresh", mission: false,
description: "panel round N" }`.

Round-1 panel (per seat `s` of config.seats):

```js
// built by workflows.roundReviewScript(seats, brief, diffPath)
const results = await runs.all(SEATS.map(s => ({
  key: s.name,
  agent: "reviewer",
  model: s.model,
  context: "fresh",
  task: BRIEF,                       // identical for all seats (§6.1)
  outputSchema: FINDINGS_SCHEMA      // §4
})));
return results.map((r, i) => ({
  seat: SEATS[i].name,
  ref: runs.ref(SEATS[i].name),      // child run reference for later resume
  structured: r.structured ?? null,  // schema-validated output when available
  output: r.output ?? ""             // fallback text
}));
```

Deliberation (new workflow, resumes retained children from round 1):

```js
const votes = await runs.all(SEATS.map(s => ({
  key: s.name + "-d" + D,
  resume: REFS[s.name].runId,        // from round-1 workflow return
  task: deliberationTask(s, contestedClusters)   // §6.3
  outputSchema: VOTES_SCHEMA
})));
return votes.map((r, i) => ({ seat: SEATS[i].name, structured: r.structured ?? null, output: r.output ?? "" }));
```

Fix round:

```js
return runs.run("fix-" + N, { agent: "worker", model: FIXER_MODEL_OR_OMIT,
  context: "fresh", task: fixerTask(acceptedFindings, N) });
```

Implementer round 0: same shape, `agent: "worker"`, model =
implementer-or-omit, task §6.5.

Round-2+ anchored review: same as round-1 but with the §6.2 brief and the
VERDICTS_SCHEMA.

**Implementation verification points (M1):** exact field names of
`runs.ref(...)` results and of per-child results (`structured` vs JSON-in-`output`)
must be confirmed with a probe workflow against the installed pi-subagents
version; `workflows.ts` must tolerate both shapes (try `structured`, else
JSON.parse the last fenced/ bare JSON block of `output`, else mark the seat
failed). If `runs.ref` does not expose a resumable run id, fall back to
`subagent({action:"children.list"})` *from the main agent* is NOT available to
the extension — instead the round-1 workflow must return per-seat run ids via
whatever reference field exists; if none exists, v1 falls back to deliberation
via **fresh** seats that read the round-1 artifact directory (weaker: loses the
raising seat's own context; log a warning in the report).

### Orchestrator (`orchestrator.ts`)

Event-driven state machine (spawn is async; completion arrives via
`subagent:async-complete`):

```
class PanelRun {
  id, cwd, mode: "review" | "loop", round: 1..maxLoopRounds,
  phase: "review" | "deliberate" | "fix" | "done" | "cancelled" | "failed",
  seats, refs, clusters, votes, accepted, dissent, fixShas,
  activeAsyncId: string | null
}
```

- One active `PanelRun` per pi session (second invocation rejected).
- `advance()` is called after each phase's async completion: parse seat
  outputs → validate (invalid/missing output from a seat: mark seat failed for
  that round; proceed with 2 seats, noting degradation in the report; if 2+
  seats fail, fail the run) → cluster → tally → next phase.
- All artifacts written synchronously after each phase (crash-safe trail).
- `/panel-cancel`: RPC `stop` on `activeAsyncId`, mark cancelled.
- Progress: `ctx.ui.setStatus("panel", "round 1: reviewing (kimi, sol, glm)")`;
  `notify` on phase transitions and completion with the report path.

### Config (`config.ts`)

Read `~/.pi/agent/settings.json` key `panel`, merged over defaults:

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
    "artifactDir": ".panel",
    "maxDiffLines": 4000
  }
}
```

- `implementer` / `fixer`: `null` = omit `model` (session model). If set, must
  not equal any seat model (warn + ignore if it does; fixer must never be a
  panel seat).
- `autoCommit: false` → fixer/implementer tasks drop the commit instructions;
  round boundaries become "current diff" instead of `git show <sha>` and the
  report notes this. (Commits are strongly recommended: they define rounds.)
- Validation: exactly 3 seats, distinct models, distinct names; invalid →
  error at command time listing the problem.

### Git helpers (`git.ts`)

- `resolveTarget(args)` → `{ description, diffText, commands }` per §2.
- `isDirty()`, `assertClean()` via `git status --porcelain`.
- `currentHead()`, `commitOf(sha)` validation.
- All via `node:child_process` `execFileSync("git", …)` with `cwd: ctx.cwd`.

### Error handling summary

| Condition | Behavior |
|---|---|
| pi-subagents RPC absent | ping timeout → install instructions, abort |
| not a git repo | error, abort |
| empty diff / clean tree | error per §2 |
| dirty tree + implementation request | error per §2 |
| seat output invalid | seat marked failed for the round; report notes it; ≥2 seats failed → run fails |
| fixer fails / no commit produced | run fails with the fixer's report; artifacts preserved |
| `gh` failure for PR target | error with `gh` stderr |
| oversized diff | confirm (TUI) / error (non-TUI) |

## 8. Test plan

No unit-test framework in v1 (logic is thin orchestration over pi-subagents);
verification is milestone-based smoke tests.

1. **M1 — scaffold + RPC probe.** `pi -e /Users/ehsan/src/github.com/pourtorabehsan/pi-panel`.
   `/panel-review` on a clean tree → expect "nothing to review" error (proves
   command + git wiring). A hidden debug path (or temporary command
   `/panel-ping`) pings RPC and runs a probe workflow
   `return runs.run("probe", { agent: "scout", task: "Reply with exactly: ok" })`
   — proves spawn + async-complete + status + **verifies the exact shape of
   `runs.ref` and child result fields** (§7 verification points). Pass:
   probe result visible, shapes logged.
2. **M2 — `/panel-review` happy path.** Create a fixture: temp git repo, one
   commit, then a working-tree change with an obvious bug (e.g. off-by-one in
   a loop) and a style nit. Run `/panel-review`. Pass: all three
   `findings-*.json` validate; `clusters.json` non-empty; `consensus.md` shows
   the obvious bug accepted (likely 3/3) and sane handling of the nit.
3. **M3 — deliberation.** Fixture with a *subtle, arguable* finding (e.g. a
   theoretical race). Pass: contested cluster triggers resume-based
   deliberation; votes recorded in `rebuttal-*.md`; final verdict obeys §3
   rules; dissent preserved if rejected.
4. **M4 — `/panel-loop`.** Two sub-tests: (a) dirty tree, no args → review →
   fix → commit → anchored round 2 → termination with clean verdicts;
   `git log` shows `panel-loop: round N fixes` commits containing only fix
   files; `.panel/` never staged. (b) clean tree + implementation request →
   round 0 commit → panel → termination. Pass: termination per §3, final-report
   complete.
5. **M5 — hardening.** Seat failure injection (one seat model set to an invalid
   id) → degraded-round path; `/panel-cancel` mid-run; double-invocation guard;
   missing pi-subagents message.

Evidence for each milestone: artifact tree listing + consensus/final-report
contents + `git log --oneline` output.

## 9. Milestones

- **M1**: repo scaffold, config, RPC client, ping/probe, command stubs.
- **M2**: `/panel-review` end-to-end (resolve → review → cluster/tally →
  consensus.md + final-report.md).
- **M3**: deliberation (resume votes, caps, dissent).
- **M4**: `/panel-loop` (entry modes, implementer, fixer commits, anchored
  rounds, termination).
- **M5**: hardening + README (install, config reference, artifact tour,
  `.gitignore` note, troubleshooting).

## 10. Design risks (flagged for reviewers)

- R1: **RPC coupling.** pi-subagents' `subagents:rpc:v1` is an internal-ish
  surface. Upgrades may break us; ping's `version` field gives a compat check
  point, but v1 has no negotiation beyond hard-fail with a clear message.
- R2: **Unverified resume plumbing.** Whether `runs.ref()` exposes what
  retained-resume needs is confirmed only in M1. Worst case: fresh-seat
  deliberation fallback (§7), which weakens the "defend with your own context"
  property.
- R3: **Structured-output compliance variance.** GLM/Kimi/GPT handle
  `outputSchema` differently; the parse-fallback chain (§7) must be robust or
  seats get marked failed spuriously, degrading the panel to 2 votes.
- R4: **Event-driven state loss.** In-memory state machine + long async runs:
  `/reload` or session restart mid-run orphans the run (artifacts remain).
  Accepted as N4; users re-run.
- R5: **Cost/latency.** 3 frontier-ish models × up to 2 deliberation rounds ×
  2 loop rounds is expensive on large diffs; `maxDiffLines` guard is the only
  v1 mitigation.
