import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { anchoredBrief, deliberationTask, fixerTask, implementerTask, round1Brief } from "../src/briefs.ts";
import { FINDINGS_SCHEMA } from "../src/findings.ts";
import { deliberationScript, probeScript, reviewRoundScript, workerScript } from "../src/workflows.ts";

/** Compile a workflowScript exactly the way pi-subagents does (vm.Script wrapper). */
function assertCompiles(script: string): void {
	new vm.Script(`(async () => {\n${script}\n})()`, { filename: "workflow-script.js" });
}

const seats = [
	{ name: "kimi", model: "m1" },
	{ name: "sol", model: "m2" },
	{ name: "glm", model: "m3" },
];

test("reviewRoundScript compiles and embeds seats, brief, schema", () => {
	const script = reviewRoundScript(seats, "BRIEF TEXT", FINDINGS_SCHEMA, "r1-");
	assertCompiles(script);
	assert.match(script, /"kimi"/);
	assert.match(script, /BRIEF TEXT/);
	assert.match(script, /runs\.all/);
	assert.match(script, /agent: "reviewer"/);
	assert.match(script, /structuredOutput/);
});

test("deliberationScript uses resume when runId exists, fresh otherwise, with retry", () => {
	const script = deliberationScript(
		[
			{ name: "kimi", model: "m1", runId: "subagent_1" },
			{ name: "sol", model: "m2", runId: null },
			{ name: "glm", model: "m3", runId: "subagent_3" },
		],
		2,
		"TASK",
		"FRESH PREFIX",
		FINDINGS_SCHEMA,
	);
	assertCompiles(script);
	assert.match(script, /resume: s\.runId/);
	assert.match(script, /-fresh/);
	assert.match(script, /FRESH PREFIX/);
});

test("workerScript omits model when null", () => {
	const withModel = workerScript("fix-1", "openai/gpt-5.6-sol", "TASK");
	const without = workerScript("fix-1", null, "TASK");
	assertCompiles(withModel);
	assertCompiles(without);
	assert.match(withModel, /"openai\/gpt-5\.6-sol"/);
	assert.match(without, /MODEL = null/);
	assert.match(without, /if \(MODEL\) PARAMS\.model = MODEL/);
});

test("probeScript compiles", () => {
	assertCompiles(probeScript());
});

test("briefs substitute all placeholders", () => {
	const r1 = round1Brief("commit abc (thing)", "/tmp/round-1/diff.patch");
	assert.match(r1, /reviewing: commit abc \(thing\)/);
	assert.match(r1, /\/tmp\/round-1\/diff\.patch/);
	assert.doesNotMatch(r1, /\{[A-Z_]+\}/);

	const r2 = anchoredBrief(2, "/tmp/round-1", "abc123", "/tmp/round-2/diff.patch");
	assert.match(r2, /round 2/);
	assert.match(r2, /abc123/);
	assert.match(r2, /visible in round 1/);
	assert.doesNotMatch(r2, /\{[A-Z_]+\}/);
});

test("deliberationTask includes contested clusters, disputes, and prior votes", () => {
	const task = deliberationTask(
		1,
		[{ clusterId: "c2", raisedBy: ["kimi"], finding: { file: "a.ts", lineStart: 1, lineEnd: 2, symbol: "f", title: "t", claim: "c", evidence: "e", suggestedFix: "s", severity: "major" } }],
		[{ clusterId: "c1", finding: { file: "b.ts", lineStart: 3, lineEnd: 4, symbol: "g", title: "u", claim: "d", evidence: "e2", suggestedFix: "s2", severity: "blocker" }, partialSeat: "sol", partialEvidence: "still broken" }],
		null,
	);
	assert.match(task, /Deliberation round 1/);
	assert.match(task, /"clusterId": "c2"/);
	assert.match(task, /Verification disputes/);
	assert.match(task, /still broken/);

	const round2 = deliberationTask(2, [], [], '[{"clusterId":"c1"}]');
	assert.match(round2, /Deliberation round 2/);
	assert.match(round2, /"clusterId":"c1"/);
});

test("fixer/implementer tasks respect autoCommit", () => {
	const fix = fixerTask("[]", 1, 2, true);
	assert.match(fix, /Panel-Loop: round 1/); // trailer, not subject prefix
	assert.match(fix, /Do NOT mention/); // human-style subject rule
	assert.match(fix, /Never `git add -A`/);
	const noCommit = fixerTask("[]", 1, 2, false);
	assert.match(noCommit, /Do NOT commit/);
	assert.doesNotMatch(noCommit, /git commit -m/);

	const impl = implementerTask("add retry logic", true);
	assert.match(impl, /add retry logic/);
	assert.match(impl, /Panel-Loop: round 0/);
});
