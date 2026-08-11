import assert from "node:assert/strict";
import test from "node:test";
import {
	aggregateVerdicts,
	clusterFindings,
	clusterKey,
	extractJson,
	initialTally,
	lineDistance,
	normalizePath,
	normalizeSymbol,
	parseFindingsOutput,
	parseVerdictsOutput,
	parseVotesOutput,
	resolveContested,
	validateFinding,
	type Finding,
} from "../src/findings.ts";

function finding(overrides: Partial<Finding> = {}): Finding {
	return {
		id: "f1",
		file: "src/foo.ts",
		lineStart: 10,
		lineEnd: 12,
		symbol: "parse",
		title: "off-by-one in parse",
		claim: "loop bound is wrong",
		evidence: "src/foo.ts:11",
		suggestedFix: "use < instead of <=",
		severity: "major",
		confidence: "high",
		...overrides,
	};
}

test("normalizePath strips ./ prefix", () => {
	assert.equal(normalizePath("./src/foo.ts"), "src/foo.ts");
	assert.equal(normalizePath("src/foo.ts"), "src/foo.ts");
});

test("normalizeSymbol strips receivers and call parens", () => {
	assert.equal(normalizeSymbol("parse()"), "parse");
	assert.equal(normalizeSymbol("this.parse"), "parse");
	assert.equal(normalizeSymbol("(s *Store) Put"), "put");
	assert.equal(normalizeSymbol("  ParseConfig "), "parseconfig");
});

test("lineDistance: 0 for overlap, gap otherwise", () => {
	assert.equal(lineDistance({ lineStart: 10, lineEnd: 12 }, { lineStart: 12, lineEnd: 20 }), 0);
	assert.equal(lineDistance({ lineStart: 10, lineEnd: 12 }, { lineStart: 20, lineEnd: 25 }), 8);
});

test("clusterKey groups same file+symbol", () => {
	assert.equal(clusterKey(finding()), clusterKey(finding({ lineStart: 50 })));
	assert.notEqual(clusterKey(finding()), clusterKey(finding({ symbol: "other" })));
});

test("clustering merges findings within line distance across seats", () => {
	const { clusters, advisory } = clusterFindings([
		{ seat: "kimi", findings: [finding({ lineStart: 10, lineEnd: 12 })] },
		{ seat: "sol", findings: [finding({ id: "g1", lineStart: 20, lineEnd: 22 })] },
		{ seat: "glm", findings: [finding({ id: "z1", lineStart: 100, lineEnd: 100, symbol: "elsewhere" })] },
	]);
	assert.equal(clusters.length, 2);
	assert.equal(advisory.length, 0);
	assert.equal(clusters[0].id, "c1");
	assert.deepEqual(clusters[0].raisers.sort(), ["kimi", "sol"]);
	assert.equal(clusters[1].raisers.length, 1);
});

test("style findings route to advisory and never cluster", () => {
	const { clusters, advisory } = clusterFindings([
		{ seat: "kimi", findings: [finding({ severity: "style" })] },
		{ seat: "sol", findings: [finding({ severity: "style" })] },
	]);
	assert.equal(clusters.length, 0);
	assert.equal(advisory.length, 2);
});

test("initialTally: >=2 raisers accepted, 1 contested", () => {
	const { clusters } = clusterFindings([
		{ seat: "kimi", findings: [finding()] },
		{ seat: "sol", findings: [finding({ lineStart: 11, lineEnd: 11 })] },
		{ seat: "glm", findings: [finding({ symbol: "unique", lineStart: 99, lineEnd: 99 })] },
	]);
	assert.equal(initialTally(clusters[0]), "accepted");
	assert.equal(initialTally(clusters[1]), "contested");
});

test("resolveContested: raiser counts as initial accept", () => {
	const { clusters } = clusterFindings([{ seat: "kimi", findings: [finding()] }]);
	const c = clusters[0];
	// raiser accept + one more accept = accepted
	assert.equal(resolveContested(c, { sol: "accept" }), "accepted");
	// two rejects = rejected
	assert.equal(resolveContested(c, { sol: "reject", glm: "reject" }), "rejected");
	// raiser retracts (reject) + one reject = rejected
	assert.equal(resolveContested(c, { kimi: "reject", sol: "reject" }), "rejected");
	// no majority
	assert.equal(resolveContested(c, { sol: "abstain", glm: "reject" }), null);
	assert.equal(resolveContested(c, {}), null);
});

test("aggregateVerdicts per spec §5", () => {
	const v = (seat: string, verdict: "resolved" | "partial" | "not-resolved") => ({ seat, clusterId: "c1", verdict, evidence: "x" });
	assert.equal(aggregateVerdicts([v("kimi", "resolved"), v("sol", "resolved"), v("glm", "resolved")]), "resolved");
	assert.equal(aggregateVerdicts([v("kimi", "not-resolved"), v("sol", "resolved")]), "open");
	assert.equal(aggregateVerdicts([v("kimi", "partial"), v("sol", "partial")]), "open");
	assert.equal(aggregateVerdicts([v("kimi", "partial"), v("sol", "resolved"), v("glm", "resolved")]), "dispute");
	assert.equal(aggregateVerdicts([]), "resolved");
});

test("validateFinding enforces the schema", () => {
	assert.equal(validateFinding(finding(), false).ok, true);
	assert.equal(validateFinding(finding({ severity: "nope" as never }), false).ok, false);
	assert.equal(validateFinding(finding({ lineStart: 0 }), false).ok, false);
	assert.equal(validateFinding(finding({ title: "x".repeat(121) }), false).ok, false);
	assert.equal(validateFinding(finding(), true).ok, false); // whyMissedBefore required
	assert.equal(validateFinding(finding({ whyMissedBefore: "missed it" }), true).ok, true);
	assert.equal(validateFinding(null, false).ok, false);
});

test("parseFindingsOutput: structured preferred, drops invalid entries", () => {
	const parsed = parseFindingsOutput({ findings: [finding(), { bad: true }] }, "", false);
	assert.equal(parsed.source, "structured");
	assert.equal(parsed.value?.length, 1);
	assert.equal(parsed.dropped, 1);
});

test("parseFindingsOutput: falls back through output parsing", () => {
	const payload = JSON.stringify({ findings: [finding()] });
	assert.equal(parseFindingsOutput(null, payload, false).source, "parsed-output");
	assert.equal(parseFindingsOutput(null, `here you go:\n\`\`\`json\n${payload}\n\`\`\``, false).source, "parsed-fence");
	assert.equal(parseFindingsOutput(null, `prefix ${payload} suffix`, false).source, "parsed-braces");
	assert.equal(parseFindingsOutput(null, "no json here", false).source, "failed");
	assert.equal(parseFindingsOutput({ unexpected: true }, "", false).source, "failed");
});

test("parseVerdictsOutput parses verdicts and new findings", () => {
	const structured = {
		verdicts: [{ clusterId: "c1", verdict: "resolved", evidence: "checked" }],
		newFindings: [finding({ whyMissedBefore: "was hidden" })],
	};
	const parsed = parseVerdictsOutput(structured, "");
	assert.equal(parsed.source, "structured");
	assert.equal(parsed.value?.verdicts.length, 1);
	assert.equal(parsed.value?.newFindings.length, 1);
	// new findings without justification are dropped
	const bad = parseVerdictsOutput({ verdicts: [], newFindings: [finding()] }, "");
	assert.equal(bad.value?.newFindings.length, 0);
	assert.equal(bad.dropped, 1);
});

test("parseVotesOutput validates votes", () => {
	const structured = { votes: [{ clusterId: "c1", vote: "accept", verifiedEvidence: "ran tests", rationale: "real bug" }] };
	const parsed = parseVotesOutput(structured, "");
	assert.equal(parsed.value?.length, 1);
	assert.equal(parseVotesOutput({ votes: [{ clusterId: "c1", vote: "maybe" }] }, "").dropped, 1);
});

test("extractJson handles bare and fenced payloads", () => {
	assert.deepEqual(extractJson('{"a":1}'), { value: { a: 1 }, source: "parsed-output" });
	assert.equal(extractJson("garbage"), null);
});
