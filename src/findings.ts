/**
 * Findings schema types, output parsing, clustering, and vote tally.
 * Pure functions only — no I/O, no pi imports. This module is where the
 * "models never do arithmetic" rule lives.
 */

export type Severity = "blocker" | "major" | "minor" | "style";
export type Confidence = "low" | "medium" | "high";

export interface Finding {
	id: string;
	file: string;
	lineStart: number;
	lineEnd: number;
	symbol: string;
	title: string;
	claim: string;
	evidence: string;
	suggestedFix: string;
	severity: Severity;
	confidence: Confidence;
	/** Round-2+ new findings only: why the previous round did not surface this. */
	whyMissedBefore?: string;
}

export interface SeatFinding {
	seat: string;
	finding: Finding;
}

export interface Cluster {
	id: string;
	representative: Finding;
	items: SeatFinding[];
	raisers: string[];
}

export type Verdict = "resolved" | "partial" | "not-resolved";

export interface SeatVerdict {
	seat: string;
	clusterId: string;
	verdict: Verdict;
	evidence: string;
}

export type Vote = "accept" | "reject" | "abstain";

export interface SeatVote {
	seat: string;
	clusterId: string;
	vote: Vote;
	verifiedEvidence: string;
	rationale: string;
}

// ---------------------------------------------------------------------------
// JSON Schemas (passed as outputSchema to workflow children) — spec §4
// ---------------------------------------------------------------------------

const FINDING_PROPERTIES = {
	id: { type: "string", description: "seat-local slug, e.g. f1, f2" },
	file: { type: "string", description: "repo-relative path" },
	lineStart: { type: "integer", minimum: 1 },
	lineEnd: { type: "integer", minimum: 1 },
	symbol: { type: "string", description: 'enclosing function/type/method, or "" if none' },
	title: { type: "string", maxLength: 120 },
	claim: { type: "string", description: "what is wrong and the realistic scenario where it breaks" },
	evidence: { type: "string", description: "file/line references or command output the seat verified" },
	suggestedFix: { type: "string" },
	severity: { enum: ["blocker", "major", "minor", "style"] },
	confidence: { enum: ["low", "medium", "high"] },
} as const;

const FINDING_REQUIRED = ["id", "file", "lineStart", "lineEnd", "symbol", "title", "claim", "evidence", "suggestedFix", "severity", "confidence"];

export const FINDINGS_SCHEMA = {
	type: "object",
	required: ["findings"],
	additionalProperties: false,
	properties: {
		findings: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: FINDING_REQUIRED,
				properties: FINDING_PROPERTIES,
			},
		},
	},
};

export const VERDICTS_SCHEMA = {
	type: "object",
	required: ["verdicts", "newFindings"],
	additionalProperties: false,
	properties: {
		verdicts: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["clusterId", "verdict", "evidence"],
				properties: {
					clusterId: { type: "string" },
					verdict: { enum: ["resolved", "partial", "not-resolved"] },
					evidence: { type: "string" },
				},
			},
		},
		newFindings: {
			type: "array",
			items: { $ref: "#/definitions/findingWithJustification" },
		},
	},
	definitions: {
		findingWithJustification: {
			type: "object",
			additionalProperties: false,
			required: [...FINDING_REQUIRED, "whyMissedBefore"],
			properties: {
				...FINDING_PROPERTIES,
				whyMissedBefore: { type: "string", description: "mandatory: why the previous round did not surface this" },
			},
		},
	},
};

export const VOTES_SCHEMA = {
	type: "object",
	required: ["votes"],
	additionalProperties: false,
	properties: {
		votes: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["clusterId", "vote", "verifiedEvidence", "rationale"],
				properties: {
					clusterId: { type: "string" },
					vote: { enum: ["accept", "reject", "abstain"] },
					verifiedEvidence: { type: "string", description: "evidence the seat verified with tools THIS round" },
					rationale: { type: "string", maxLength: 500 },
				},
			},
		},
	},
};

// ---------------------------------------------------------------------------
// Validation (manual; no schema dependency)
// ---------------------------------------------------------------------------

const SEVERITIES: readonly string[] = ["blocker", "major", "minor", "style"];
const CONFIDENCES: readonly string[] = ["low", "medium", "high"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateFinding(value: unknown, requireJustification: boolean): { ok: boolean; errors: string[] } {
	const errors: string[] = [];
	if (!isRecord(value)) return { ok: false, errors: ["finding is not an object"] };
	for (const field of ["id", "file", "symbol", "title", "claim", "evidence", "suggestedFix"]) {
		if (typeof value[field] !== "string") errors.push(`${field} must be a string`);
	}
	for (const field of ["lineStart", "lineEnd"]) {
		const v = value[field];
		if (typeof v !== "number" || !Number.isInteger(v) || v < 1) errors.push(`${field} must be an integer >= 1`);
	}
	if (typeof value.title === "string" && value.title.length > 120) errors.push("title exceeds 120 chars");
	if (typeof value.severity !== "string" || !SEVERITIES.includes(value.severity)) errors.push("severity must be blocker|major|minor|style");
	if (typeof value.confidence !== "string" || !CONFIDENCES.includes(value.confidence)) errors.push("confidence must be low|medium|high");
	if (requireJustification && typeof value.whyMissedBefore !== "string") errors.push("whyMissedBefore must be a string");
	return { ok: errors.length === 0, errors };
}

export function validateVerdict(value: unknown): value is { clusterId: string; verdict: Verdict; evidence: string } {
	if (!isRecord(value)) return false;
	if (typeof value.clusterId !== "string" || !value.clusterId) return false;
	if (typeof value.verdict !== "string" || !["resolved", "partial", "not-resolved"].includes(value.verdict)) return false;
	if (typeof value.evidence !== "string") return false;
	return true;
}

export function validateVote(value: unknown): value is { clusterId: string; vote: Vote; verifiedEvidence: string; rationale: string } {
	if (!isRecord(value)) return false;
	if (typeof value.clusterId !== "string" || !value.clusterId) return false;
	if (typeof value.vote !== "string" || !["accept", "reject", "abstain"].includes(value.vote)) return false;
	if (typeof value.verifiedEvidence !== "string") return false;
	if (typeof value.rationale !== "string") return false;
	return true;
}

// ---------------------------------------------------------------------------
// Output parsing with fallback chain (spec §7 R3)
// ---------------------------------------------------------------------------

export interface ParsedOutput<T> {
	value: T | null;
	source: "structured" | "parsed-output" | "parsed-fence" | "parsed-braces" | "failed";
	dropped: number;
}

function tryParseJson(text: string): unknown | undefined {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Extract a JSON value from free-form model output: whole text, fenced blocks (last first), then outermost braces. */
export function extractJson(output: string): { value: unknown; source: ParsedOutput<unknown>["source"] } | null {
	const whole = tryParseJson(output.trim());
	if (whole !== undefined) return { value: whole, source: "parsed-output" };

	const fences = [...output.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)];
	for (let i = fences.length - 1; i >= 0; i--) {
		const parsed = tryParseJson(fences[i][1].trim());
		if (parsed !== undefined) return { value: parsed, source: "parsed-fence" };
	}

	const firstBrace = output.indexOf("{");
	const lastBrace = output.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		const parsed = tryParseJson(output.slice(firstBrace, lastBrace + 1));
		if (parsed !== undefined) return { value: parsed, source: "parsed-braces" };
	}
	return null;
}

export function parseFindingsOutput(
	structured: unknown,
	output: string,
	requireJustification: boolean,
): ParsedOutput<Finding[]> {
	const candidates: Array<{ value: unknown; source: ParsedOutput<Finding[]>["source"] }> = [];
	if (structured !== null && structured !== undefined) candidates.push({ value: structured, source: "structured" });
	const extracted = extractJson(output);
	if (extracted) candidates.push({ value: extracted.value, source: extracted.source });

	for (const candidate of candidates) {
		if (!isRecord(candidate.value) || !Array.isArray(candidate.value.findings)) continue;
		const findings: Finding[] = [];
		let dropped = 0;
		for (const item of candidate.value.findings) {
			const check = validateFinding(item, requireJustification);
			if (check.ok) findings.push(item as unknown as Finding);
			else dropped += 1;
		}
		return { value: findings, source: candidate.source, dropped };
	}
	return { value: null, source: "failed", dropped: 0 };
}

export interface ParsedVerdicts {
	verdicts: Array<{ clusterId: string; verdict: Verdict; evidence: string }>;
	newFindings: Finding[];
}

export function parseVerdictsOutput(structured: unknown, output: string): ParsedOutput<ParsedVerdicts> {
	const candidates: Array<{ value: unknown; source: ParsedOutput<ParsedVerdicts>["source"] }> = [];
	if (structured !== null && structured !== undefined) candidates.push({ value: structured, source: "structured" });
	const extracted = extractJson(output);
	if (extracted) candidates.push({ value: extracted.value, source: extracted.source });

	for (const candidate of candidates) {
		if (!isRecord(candidate.value)) continue;
		if (!Array.isArray(candidate.value.verdicts) || !Array.isArray(candidate.value.newFindings)) continue;
		let dropped = 0;
		const verdicts: ParsedVerdicts["verdicts"] = [];
		for (const item of candidate.value.verdicts) {
			if (validateVerdict(item)) verdicts.push(item);
			else dropped += 1;
		}
		const newFindings: Finding[] = [];
		for (const item of candidate.value.newFindings) {
			if (validateFinding(item, true).ok) newFindings.push(item as unknown as Finding);
			else dropped += 1;
		}
		return { value: { verdicts, newFindings }, source: candidate.source, dropped };
	}
	return { value: null, source: "failed", dropped: 0 };
}

export function parseVotesOutput(structured: unknown, output: string): ParsedOutput<SeatVote[]> {
	const candidates: Array<{ value: unknown; source: ParsedOutput<SeatVote[]>["source"] }> = [];
	if (structured !== null && structured !== undefined) candidates.push({ value: structured, source: "structured" });
	const extracted = extractJson(output);
	if (extracted) candidates.push({ value: extracted.value, source: extracted.source });

	for (const candidate of candidates) {
		if (!isRecord(candidate.value) || !Array.isArray(candidate.value.votes)) continue;
		let dropped = 0;
		const votes: SeatVote[] = [];
		for (const item of candidate.value.votes) {
			if (validateVote(item)) votes.push({ seat: "", ...item });
			else dropped += 1;
		}
		return { value: votes, source: candidate.source, dropped };
	}
	return { value: null, source: "failed", dropped: 0 };
}

// ---------------------------------------------------------------------------
// Clustering (spec §5)
// ---------------------------------------------------------------------------

export function normalizePath(file: string): string {
	return file.trim().replace(/^\.\/+/, "");
}

export function normalizeSymbol(symbol: string): string {
	let v = (symbol ?? "").trim().toLowerCase();
	v = v.replace(/\(\s*\)/g, ""); // drop call parens: "parse()" -> "parse"
	v = v.replace(/^\([^)]*\)\s*\*?\s*/, ""); // Go receiver: "(s *Store) Put" -> "put"
	v = v.replace(/^\./, ""); // leftover dot from "(s *Store).Put"
	v = v.replace(/^(this|self)\./, ""); // JS/Python receiver
	return v.trim();
}

export function clusterKey(f: Pick<Finding, "file" | "symbol">): string {
	return `${normalizePath(f.file)}|${normalizeSymbol(f.symbol)}`;
}

export function lineDistance(a: Pick<Finding, "lineStart" | "lineEnd">, b: Pick<Finding, "lineStart" | "lineEnd">): number {
	if (a.lineEnd >= b.lineStart && b.lineEnd >= a.lineStart) return 0;
	return a.lineEnd < b.lineStart ? b.lineStart - a.lineEnd : a.lineStart - b.lineEnd;
}

export const CLUSTER_LINE_DISTANCE = 15;

export interface ClusterResult {
	clusters: Cluster[];
	advisory: SeatFinding[];
}

/**
 * Deterministic clustering. Seats iterate in config order, findings in array
 * order; cluster ids c1, c2, ... assigned in first-seen order.
 * severity "style" findings never cluster — they are advisory-only (spec §3).
 */
export function clusterFindings(findingsBySeat: Array<{ seat: string; findings: Finding[] }>): ClusterResult {
	const clusters: Cluster[] = [];
	const advisory: SeatFinding[] = [];

	for (const { seat, findings } of findingsBySeat) {
		for (const finding of findings) {
			if (finding.severity === "style") {
				advisory.push({ seat, finding });
				continue;
			}
			const key = clusterKey(finding);
			const existing = clusters.find(
				(c) => clusterKey(c.representative) === key && lineDistance(c.representative, finding) <= CLUSTER_LINE_DISTANCE,
			);
			if (existing) {
				existing.items.push({ seat, finding });
				if (!existing.raisers.includes(seat)) existing.raisers.push(seat);
			} else {
				clusters.push({
					id: `c${clusters.length + 1}`,
					representative: finding,
					items: [{ seat, finding }],
					raisers: [seat],
				});
			}
		}
	}
	return { clusters, advisory };
}

// ---------------------------------------------------------------------------
// Tally (spec §3, §5)
// ---------------------------------------------------------------------------

export type ClusterOutcome = "accepted" | "contested" | "rejected" | "rejected-unresolved";

export function initialTally(cluster: Cluster): "accepted" | "contested" {
	return cluster.raisers.length >= 2 ? "accepted" : "contested";
}

/**
 * Resolve a contested cluster from deliberation votes.
 * The raising seat's round-1 finding counts as an initial "accept".
 * Returns null when no majority exists yet (another round or unresolved).
 */
export function resolveContested(cluster: Cluster, votesBySeat: Record<string, Vote>): "accepted" | "rejected" | null {
	const effective: Record<string, Vote> = { ...votesBySeat };
	for (const raiser of cluster.raisers) {
		if (!(raiser in effective)) effective[raiser] = "accept";
	}
	let accepts = 0;
	let rejects = 0;
	for (const vote of Object.values(effective)) {
		if (vote === "accept") accepts += 1;
		else if (vote === "reject") rejects += 1;
	}
	if (accepts >= 2) return "accepted";
	if (rejects >= 2) return "rejected";
	return null;
}

export type VerdictAggregation = "resolved" | "open" | "dispute";

/**
 * Round-2+ verdict aggregation for a previously accepted cluster (spec §5):
 * open if ANY seat votes not-resolved or >=2 seats vote partial;
 * dispute if exactly 1 seat votes partial (goes to one deliberation round);
 * otherwise resolved. Seats that gave no verdict are ignored.
 */
export function aggregateVerdicts(verdicts: SeatVerdict[]): VerdictAggregation {
	if (verdicts.some((v) => v.verdict === "not-resolved")) return "open";
	const partials = verdicts.filter((v) => v.verdict === "partial").length;
	if (partials >= 2) return "open";
	if (partials === 1) return "dispute";
	return "resolved";
}
