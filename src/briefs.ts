/**
 * Brief and task templates — literal texts from SPEC.md §6.
 * Pure string builders with placeholder substitution.
 */

/**
 * Critical: panel children run inside RPC-spawned workflows with no human
 * supervisor on the other end. A child calling intercom/contact_supervisor
 * DETACHES the run and fails the whole workflow (observed live). Every child
 * brief must carry this rule.
 */
const NO_INTERCOM = `- Work fully autonomously: NEVER use intercom, contact_supervisor, or ask
  questions. There is no human supervisor for this run, and contacting one
  detaches the workflow and fails it. Make your best evidence-based decision
  and proceed.`;

export function round1Brief(targetDescription: string, diffPath: string): string {
	return `You are one seat on a three-model review panel. You are reviewing: ${targetDescription}.
The full diff under review is at ${diffPath} — read it first.

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
${NO_INTERCOM}
- Return only structured output per the output schema. No prose summary.`;
}

export function anchoredBrief(n: number, prevRoundDir: string, fixSha: string, diffPath: string): string {
	return `You are one seat on a three-model review panel, round ${n}.
A previous panel round already reviewed this work. Its full record is in
${prevRoundDir}: findings-*.json, clusters.json, rebuttal-*.md (if present),
and consensus.md. Read that directory first — this is the review thread you
are continuing.

The fix commit under review is ${fixSha}; its diff is at ${diffPath}.
The accepted findings the fixer was asked to address are in
${prevRoundDir}/consensus.md.

Your tasks, in order:
1. For EACH accepted finding from the previous round: verify whether the fix
   commit resolves it. Verdict: resolved | partial | not-resolved, with
   evidence you verified yourself with tools (file/line refs or command output).
2. Review the fix diff itself for regressions or new issues INTRODUCED by this
   fix.
3. You may raise new findings outside the fix diff, but each requires an
   explicit whyMissedBefore justification. "It was visible in round ${n - 1} but
   not flagged" is acceptable only with an explanation; prefer precision over
   volume.

Constraints:
- READ-ONLY. Never edit, stage, or commit.
${NO_INTERCOM}
- Return only structured output per the output schema (verdicts + newFindings).`;
}

export interface ContestedClusterPayload {
	clusterId: string;
	raisedBy: string[];
	finding: {
		file: string;
		lineStart: number;
		lineEnd: number;
		symbol: string;
		title: string;
		claim: string;
		evidence: string;
		suggestedFix: string;
		severity: string;
	};
}

export interface VerificationDisputePayload {
	clusterId: string;
	finding: ContestedClusterPayload["finding"];
	partialSeat: string;
	partialEvidence: string;
}

export function deliberationTask(
	d: number,
	contested: ContestedClusterPayload[],
	disputes: VerificationDisputePayload[],
	previousVotesJson: string | null,
): string {
	const parts: string[] = [];
	parts.push(`Deliberation round ${d} on contested findings from your panel review.`);

	if (contested.length > 0) {
		parts.push(`The following finding clusters were raised by exactly one seat. For each
cluster, the raising seat's claim and evidence are included. The other seats
did not raise it.

${JSON.stringify(contested, null, 2)}

For each cluster, cast a vote: accept | reject | abstain.`);
	}

	if (disputes.length > 0) {
		parts.push(`Verification disputes: the following previously-accepted findings received a
"partial" verdict from exactly one seat while the others considered them
resolved.

${JSON.stringify(disputes, null, 2)}

For each dispute, cast a vote on the question "is this finding fully resolved?":
- vote "reject" if you verify the fix fully resolves the finding,
- vote "accept" if you verify the finding is still open (the partial verdict stands),
- abstain only if you cannot verify either way.`);
	}

	parts.push(`Rules:
${NO_INTERCOM}
- Change (or hold) your position ONLY on evidence you verified yourself with
  tools this round. Re-open the files. Run the commands. Check the claim.
- If you raised the finding: defend it with stronger verified evidence, or
  retract it honestly with vote "reject" if verification fails.
- If you did not raise it: accept only if you verified the bug is real;
  reject only if you verified it is not; otherwise abstain.
- verifiedEvidence must reference what YOU checked this round (file/line,
  command + output). "Trusting the other seat" is not evidence.`);

	if (previousVotesJson) {
		parts.push(`Deliberation round ${d - 1} votes and rationales from all seats (you may hold
your position; change only on new verified evidence):

${previousVotesJson}`);
	}

	// pi-subagents drops outputSchema on resume items (documented limitation),
	// so the exact shape is embedded in the task text itself — resumed seats
	// see it even though no schema is enforced on their turn.
	parts.push(`Return ONLY this JSON shape, no prose:
{"votes": [{"clusterId": "<id>", "vote": "accept" | "reject" | "abstain", "verifiedEvidence": "<what you checked this round>", "rationale": "<max 500 chars>"}]}`);
	return parts.join("\n\n");
}

/** Prefix for fresh-seat deliberation fallback (when a retained resume id is unavailable). */
export function freshDeliberationPrefix(roundDir: string): string {
	// NOTE: consensus.md does not exist yet at deliberation time (it is written
	// after deliberation completes) — reference only the files that exist.
	return `You are joining a panel deliberation WITHOUT your round context (resume
was unavailable). The record of the round you are deliberating on is in
${roundDir} — read findings-*.json and clusters.json there first, then
verify claims directly against the repository.

`;
}

const COMMIT_RULES = (round: string) => `- When done, commit ONLY the files you modified:
  \`git add <specific paths>\` then commit with a message that follows repo
  conventions:
  - Subject: a normal, descriptive summary of the change. Do NOT mention
    panel, panel-loop, review rounds, findings counts, or AI tooling — the
    commit should read like any human-written commit in this repo.
  - Body: include exactly this trailer line (last paragraph):
    \`Panel-Loop: ${round}\`
  Example: \`git commit -m "vtbackups: scope storage layout" -m "Panel-Loop: ${round}"\`
  Never \`git add -A\` / \`git add .\`. Never stage panel/subagent artifact files or
  any file you did not modify.
  NEVER use \`git commit --amend\` or any commit rewriting (rebase, squash).
  Always create a new commit — preserving history is required.`;

const NO_COMMIT_RULES = `- Do NOT commit. Leave the changes in the working tree (autoCommit is disabled).
  Never stage panel/subagent artifact files or any file you did not modify.`;

export function fixerTask(acceptedFindingsJson: string, n: number, k: number, autoCommit: boolean): string {
	return `Apply the following panel-accepted review findings to the working tree.

${acceptedFindingsJson}

Rules:
${NO_INTERCOM}
- Apply ONLY these findings. No drive-by changes, no reformatting, no scope
  growth. If a suggested fix is wrong or incomplete, implement the minimal
  correct fix for the finding's claim instead.
- Follow existing code conventions.
- Run the focused validation for the area you changed (build/test/lint — the
  narrowest meaningful commands). Report exact commands and exit codes.
${autoCommit ? COMMIT_RULES(`round ${n}`) : NO_COMMIT_RULES}
- Return: changed files, validation commands + exit codes${autoCommit ? ", commit sha" : ""},
  anything you could not fix and why.`;
}

export function implementerTask(request: string, autoCommit: boolean): string {
	return `Implement the following request in the current repository:

${request}

Rules:
${NO_INTERCOM}
- First check \`git log\` and \`git status\`: if the request already appears fully
  implemented and committed, do NOT create an empty or meaningless commit —
  report that (with the commit sha) as your output and stop.
- If the request is too vague to implement, do your best interpretation of the
  most reasonable concrete change; never stop to ask.
- Keep the change scoped to the request. Follow existing conventions.
- Run the narrowest meaningful validation (build/test/lint). Report exact
  commands and exit codes.
${autoCommit ? `${COMMIT_RULES("round 0")}\n  The tree was clean when you started; keep it that way except for your commit.` : NO_COMMIT_RULES}
- Return: changed files, validation commands + exit codes${autoCommit ? ", commit sha" : ""}.`;
}
