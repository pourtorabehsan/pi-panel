/**
 * Artifact writers and report rendering (SPEC.md §6).
 * The extension is the sole artifact writer: workflowScripts cannot touch the
 * filesystem, reviewers are read-only, the fixer never writes here.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Cluster, Finding, SeatFinding, SeatVerdict, SeatVote } from "./findings.ts";

export function makeRunId(now: Date = new Date(), random: () => number = Math.random): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const suffix = Math.floor(random() * 36 ** 4).toString(36).padStart(4, "0");
	return `${stamp}-${suffix}`;
}

export function createRunDir(artifactRoot: string, runId: string): string {
	const dir = join(artifactRoot, runId);
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function createRoundDir(runDir: string, n: number): string {
	const dir = join(runDir, `round-${n}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function writeJson(dir: string, name: string, value: unknown): string {
	const path = join(dir, name);
	writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
	return path;
}

export function writeText(dir: string, name: string, text: string): string {
	const path = join(dir, name);
	writeFileSync(path, text.endsWith("\n") ? text : text + "\n", "utf8");
	return path;
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

export type ClusterStatus = "accepted" | "contested" | "rejected" | "rejected-unresolved" | "resolved" | "open";

export interface ClusterReportEntry {
	cluster: Cluster;
	status: ClusterStatus;
	/** Latest deliberation round's votes (empty until the first deliberation). */
	votes: Record<string, SeatVote>;
	/** Prior deliberation rounds' votes — the deliberation trail is never overwritten. */
	voteHistory: Array<{ deliberationRound: number; votes: Record<string, SeatVote> }>;
	/** Round-2+ verdicts for previously accepted clusters. */
	verdicts: SeatVerdict[];
	source: "new" | "carried";
}

function findingBlock(f: Finding): string[] {
	return [
		`- **${f.title}** (${f.severity}, confidence: ${f.confidence})`,
		`  - Location: ${f.file}:${f.lineStart}-${f.lineEnd}${f.symbol ? ` (${f.symbol})` : ""}`,
		`  - Claim: ${f.claim}`,
		`  - Evidence: ${f.evidence}`,
		`  - Suggested fix: ${f.suggestedFix}`,
		...(f.whyMissedBefore ? [`  - Why missed before: ${f.whyMissedBefore}`] : []),
	];
}

function verdictLabel(entry: ClusterReportEntry): string {
	const parts = entry.verdicts.map((v) => `${v.seat}: ${v.verdict}`);
	return parts.length > 0 ? ` — verdicts: ${parts.join(", ")}` : "";
}

export function renderConsensus(opts: {
	round: number;
	entries: ClusterReportEntry[];
	advisory: SeatFinding[];
	failedSeats: string[];
	notes: string[];
}): string {
	const lines: string[] = [];
	lines.push(`# Panel consensus — round ${opts.round}`);
	lines.push("");

	const accepted = opts.entries.filter((e) => e.status === "accepted" || e.status === "open");
	const rejected = opts.entries.filter((e) => e.status === "rejected" || e.status === "rejected-unresolved");
	const resolved = opts.entries.filter((e) => e.status === "resolved");

	lines.push(`## Accepted / still open (${accepted.length})`);
	lines.push("");
	for (const entry of accepted) {
		const c = entry.cluster;
		lines.push(`### ${c.id} — ${c.representative.title}${verdictLabel(entry)}`);
		lines.push(`- Raised by: ${c.raisers.join(", ")}`);
		if (Object.keys(entry.votes).length > 0) {
			lines.push(`- Votes: ${Object.values(entry.votes).map((v) => `${v.seat}: ${v.vote}`).join(", ")}`);
		}
		lines.push(...findingBlock(c.representative));
		for (const item of c.items.slice(1)) {
			lines.push(`- Corroborating report (${item.seat}): ${item.finding.claim}`);
		}
		lines.push("");
	}

	if (resolved.length > 0) {
		lines.push(`## Verified resolved (${resolved.length})`);
		lines.push("");
		for (const entry of resolved) {
			lines.push(`- ${entry.cluster.id} — ${entry.cluster.representative.title}${verdictLabel(entry)}`);
		}
		lines.push("");
	}

	lines.push(`## Rejected / dissent (${rejected.length})`);
	lines.push("");
	if (rejected.length === 0) {
		lines.push("None.");
		lines.push("");
	}
	for (const entry of rejected) {
		const c = entry.cluster;
		const statusLabel = entry.status === "rejected-unresolved" ? "rejected (no majority after deliberation)" : "rejected";
		lines.push(`### ${c.id} — ${c.representative.title} — ${statusLabel}`);
		lines.push(`- Raised by: ${c.raisers.join(", ")}`);
		if (Object.keys(entry.votes).length > 0) {
			lines.push(`- Votes: ${Object.values(entry.votes).map((v) => `${v.seat}: ${v.vote}`).join(", ")}`);
			for (const vote of Object.values(entry.votes)) {
				lines.push(`  - ${vote.seat}: ${vote.rationale}${vote.verifiedEvidence ? ` (verified: ${vote.verifiedEvidence})` : ""}`);
			}
		}
		lines.push(...findingBlock(c.representative));
		lines.push("");
	}

	lines.push(`## Advisory (style, not voted) (${opts.advisory.length})`);
	lines.push("");
	if (opts.advisory.length === 0) {
		lines.push("None.");
		lines.push("");
	}
	for (const item of opts.advisory) {
		lines.push(`- [${item.seat}] ${item.finding.title} — ${item.finding.file}:${item.finding.lineStart} — ${item.finding.claim}`);
	}
	lines.push("");

	const notes = [...opts.notes];
	if (opts.failedSeats.length > 0) {
		notes.unshift(`Seat(s) failed this round and were excluded from voting: ${opts.failedSeats.join(", ")}.`);
	}
	if (notes.length > 0) {
		lines.push("## Notes");
		lines.push("");
		for (const note of notes) lines.push(`- ${note}`);
		lines.push("");
	}

	lines.push("---");
	lines.push("Clustering is mechanical (same file + symbol, lines within 15). Semantic duplicates with different symbols may survive as separate clusters; both are voted on independently.");
	return lines.join("\n");
}

export interface RoundSummary {
	round: number;
	accepted: number;
	rejected: number;
	advisory: number;
	resolved: number;
	fixCommit?: string | null;
	fixValidation?: string | null;
}

export function renderFinalReport(opts: {
	runId: string;
	mode: "review" | "loop";
	targetDescription: string;
	rounds: RoundSummary[];
	leftovers: ClusterReportEntry[];
	stopReason: string;
	configNotes: string[];
	implementationEvidence?: string | null;
}): string {
	const lines: string[] = [];
	lines.push(`# pi-panel final report`);
	lines.push("");
	lines.push(`- Run: ${opts.runId}`);
	lines.push(`- Mode: ${opts.mode === "review" ? "/panel-review" : "/panel-loop"}`);
	lines.push(`- Target: ${opts.targetDescription}`);
	lines.push(`- Stop reason: ${opts.stopReason}`);
	lines.push("");
	lines.push(`## Rounds`);
	lines.push("");
	lines.push(`| Round | Accepted | Rejected | Verified resolved | Advisory | Fix commit |`);
	lines.push(`|---|---|---|---|---|---|`);
	for (const r of opts.rounds) {
		lines.push(`| ${r.round} | ${r.accepted} | ${r.rejected} | ${r.resolved} | ${r.advisory} | ${r.fixCommit ?? "—"} |`);
	}
	lines.push("");
	if (opts.implementationEvidence) {
		lines.push(`### Round 0 implementation output`);
		lines.push("");
		lines.push(opts.implementationEvidence);
		lines.push("");
	}
	for (const r of opts.rounds) {
		if (r.fixValidation) {
			lines.push(`### Round ${r.round} fix validation`);
			lines.push("");
			lines.push(r.fixValidation);
			lines.push("");
		}
	}
	if (opts.leftovers.length > 0) {
		lines.push(`## Leftover open findings (loop cap reached)`);
		lines.push("");
		for (const entry of opts.leftovers) {
			lines.push(...findingBlock(entry.cluster.representative));
			lines.push("");
		}
		lines.push("Re-run /panel-loop to continue working through these.");
		lines.push("");
	}
	if (opts.configNotes.length > 0) {
		lines.push("## Config warnings");
		lines.push("");
		for (const note of opts.configNotes) lines.push(`- ${note}`);
		lines.push("");
	}
	return lines.join("\n");
}
