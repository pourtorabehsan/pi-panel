import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createRoundDir,
	createRunDir,
	makeRunId,
	renderConsensus,
	renderFinalReport,
	writeJson,
	writeText,
	type ClusterReportEntry,
} from "../src/artifacts.ts";
import type { Finding } from "../src/findings.ts";

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

function entry(status: ClusterReportEntry["status"], raisers: string[] = ["kimi"]): ClusterReportEntry {
	return {
		cluster: { id: "c1", representative: finding(), items: raisers.map((seat) => ({ seat, finding: finding() })), raisers },
		status,
		votes: {},
		voteHistory: [],
		verdicts: [],
		source: "new",
	};
}

test("run ids are sortable, unique, and match the spec format", () => {
	const id = makeRunId(new Date(2026, 7, 11, 9, 5, 3), () => 0);
	assert.match(id, /^20260811-090503-[0-9a-z]{4}$/);
	assert.notEqual(makeRunId(), makeRunId());
});

test("run dir and artifact writers produce the spec layout", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-panel-artifacts-"));
	const runDir = createRunDir(root, "run-1");
	const roundDir = createRoundDir(runDir, 1);
	writeText(roundDir, "diff.patch", "diff content");
	writeJson(roundDir, "findings-kimi.json", { findings: [] });
	assert.equal(readFileSync(join(roundDir, "diff.patch"), "utf8"), "diff content\n");
	assert.ok(existsSync(join(roundDir, "findings-kimi.json")));
});

test("consensus report preserves dissent with votes", () => {
	const rejected = entry("rejected-unresolved");
	rejected.votes = {
		kimi: { seat: "kimi", clusterId: "c1", vote: "accept", verifiedEvidence: "reproduced", rationale: "real" },
		sol: { seat: "sol", clusterId: "c1", vote: "abstain", verifiedEvidence: "", rationale: "unsure" },
	};
	const md = renderConsensus({
		round: 1,
		entries: [entry("accepted", ["kimi", "sol"]), rejected],
		advisory: [{ seat: "glm", finding: finding({ severity: "style", title: "naming" }) }],
		failedSeats: [],
		notes: [],
	});
	assert.match(md, /Accepted \/ still open \(1\)/);
	assert.match(md, /Rejected \/ dissent \(1\)/);
	assert.match(md, /rejected \(no majority after deliberation\)/);
	assert.match(md, /kimi: accept/);
	assert.match(md, /Advisory \(style, not voted\) \(1\)/);
});

test("final report lists rounds, leftovers, and stop reason", () => {
	const md = renderFinalReport({
		runId: "run-1",
		mode: "loop",
		targetDescription: "uncommitted changes",
		rounds: [
			{ round: 1, accepted: 2, rejected: 1, advisory: 0, resolved: 0, fixCommit: "abc123", fixValidation: "npm test: exit 0" },
			{ round: 2, accepted: 1, rejected: 0, advisory: 0, resolved: 2, fixCommit: null, fixValidation: null },
		],
		leftovers: [entry("open")],
		stopReason: "loop cap reached (maxLoopRounds=2) with 1 open finding(s)",
		configNotes: [],
	});
	assert.match(md, /loop cap reached/);
	assert.match(md, /Leftover open findings/);
	assert.match(md, /npm test: exit 0/);
	assert.match(md, /\| 1 \| 2 \| 1 \|/);
});
