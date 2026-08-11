/**
 * End-to-end state-machine tests with a stubbed RPC client: each spawn records
 * its description and immediately "completes" with scripted values via a fake
 * asyncDir/status.json. Runs against a real temp git repo.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { PanelRun } from "../src/orchestrator.ts";

function makeRepo(): { repo: string; g: (args: string[]) => string } {
	const repo = mkdtempSync(join(tmpdir(), "pi-panel-e2e-"));
	const g = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
	g(["init", "-b", "main"]);
	g(["config", "user.email", "t@t"]);
	g(["config", "user.name", "t"]);
	writeFileSync(join(repo, "a.ts"), "export const x = 1;\n");
	g(["add", "a.ts"]);
	g(["commit", "-m", "init"]);
	writeFileSync(join(repo, "a.ts"), "export const x = 1;\nexport const y = x + 1;\n");
	return { repo, g };
}

const finding = (id: string, title: string, symbol = "y") => ({
	id, file: "a.ts", lineStart: 2, lineEnd: 2, symbol, title,
	claim: "claim " + title, evidence: "a.ts:2", suggestedFix: "fix it",
	severity: "major", confidence: "high",
});

const vote = (clusterId: string, v: string) => ({ clusterId, vote: v, verifiedEvidence: "checked", rationale: "r" });

interface ScriptedRpc {
	descriptions: string[];
	reviewValue?: unknown[];
	deliberation1?: unknown[];
	deliberation2?: unknown[];
	onFix?: () => void;
	mutateDuringReview?: boolean;
}

function makeFakeRpc(repo: string, g: (a: string[]) => string, scripted: ScriptedRpc) {
	let counter = 0;
	// async dirs live OUTSIDE the repo (pi-subagents' real .pi-subagents dir is
	// excluded from the fingerprint; keeping the fake elsewhere tests that a
	// real seat mutation — not tooling noise — is what trips the guard).
	const asyncRoot = mkdtempSync(join(tmpdir(), "pi-panel-e2e-async-"));
	return {
		descriptions: scripted.descriptions,
		async spawn(_script: string, description: string) {
			scripted.descriptions.push(description);
			const asyncId = `subagent_fake${++counter}`;
			const asyncDir = join(asyncRoot, asyncId);
			mkdirSync(asyncDir, { recursive: true });
			let value: unknown;
			if (description.includes("reviewing")) {
				if (scripted.mutateDuringReview) writeFileSync(join(repo, "evil.ts"), "// seat wrote this\n");
				value = scripted.reviewValue;
			} else if (description.includes("deliberation 1")) value = scripted.deliberation1;
			else if (description.includes("deliberation 2")) value = scripted.deliberation2;
			else if (description.includes("fixing")) {
				scripted.onFix?.();
				value = { ok: true, runId: "subagent_fix", output: "committed", error: null };
			} else throw new Error("unexpected phase: " + description);
			writeFileSync(join(asyncDir, "status.json"), JSON.stringify({ state: "complete", workflow: { value } }));
			return { text: "launched", asyncId, asyncDir };
		},
		async stop() { return {}; },
	};
}

function makeRun(repo: string, rpc: unknown, mode: "review" | "loop") {
	return new PanelRun({
		rpc: rpc as never,
		config: { ...DEFAULT_CONFIG },
		configWarnings: [],
		cwd: repo,
		ui: { notify: () => {}, setStatus: () => {} },
		onSettled: () => {},
	}, mode);
}

async function pump(run: PanelRun) {
	for (let i = 0; i < 12 && !["done", "failed", "cancelled"].includes(run.phase); i++) {
		await run.handleAsyncComplete();
	}
}

test("happy path: accept 2-seat finding, reject lone finding in deliberation, fix, verify resolved", async () => {
	const { repo, g } = makeRepo();
	const scripted: ScriptedRpc = {
		descriptions: [],
		reviewValue: [
			{ seat: "kimi", ok: true, runId: "k1", structured: { findings: [finding("f1", "shared bug"), finding("f2", "lone bug", "other")] }, output: "", error: null },
			{ seat: "sol", ok: true, runId: "s1", structured: { findings: [finding("g1", "shared bug")] }, output: "", error: null },
			{ seat: "glm", ok: true, runId: "g1", structured: { findings: [finding("z1", "shared bug")] }, output: "", error: null },
		],
		deliberation1: [
			{ seat: "kimi", ok: true, runId: "k2", structured: { votes: [vote("c2", "reject")] }, output: "", error: null, resumed: true },
			{ seat: "sol", ok: true, runId: "s2", structured: { votes: [vote("c2", "reject")] }, output: "", error: null, resumed: true },
			{ seat: "glm", ok: true, runId: "g2", structured: { votes: [vote("c2", "abstain")] }, output: "", error: null, resumed: true },
		],
		onFix: () => {
			writeFileSync(join(repo, "a.ts"), "export const x = 1;\nexport const y = x + 1; // fixed\n");
			g(["add", "a.ts"]);
			g(["commit", "-m", "panel-loop: round 1 fixes (1 accepted findings)"]);
			// round-2 review: everything resolved
			scripted.reviewValue = [
				{ seat: "kimi", ok: true, runId: "k3", structured: { verdicts: [{ clusterId: "c1", verdict: "resolved", evidence: "checked" }], newFindings: [] }, output: "", error: null },
				{ seat: "sol", ok: true, runId: "s3", structured: { verdicts: [{ clusterId: "c1", verdict: "resolved", evidence: "checked" }], newFindings: [] }, output: "", error: null },
				{ seat: "glm", ok: true, runId: "g3", structured: { verdicts: [{ clusterId: "c1", verdict: "resolved", evidence: "checked" }], newFindings: [] }, output: "", error: null },
			];
		},
	};
	const run = makeRun(repo, makeFakeRpc(repo, g, scripted), "loop");
	await run.startLoop("");
	await pump(run);

	assert.equal(run.phase, "done");
	const consensus1 = readFileSync(join(run.runDir, "round-1", "consensus.md"), "utf8");
	assert.match(consensus1, /Accepted \/ still open \(1\)/);
	assert.match(consensus1, /c2 — lone bug — rejected/);
	// deliberation round files carry the deliberation-round suffix
	assert.ok(existsSync(join(run.runDir, "round-1", "rebuttal-sol-d1.md")));
	const fixCommit = readFileSync(join(run.runDir, "round-2", "fix-commit.txt"), "utf8");
	assert.match(fixCommit, /panel-loop: round 1 fixes/);
	assert.match(readFileSync(join(run.runDir, "round-2", "consensus.md"), "utf8"), /Verified resolved \(1\)/);
	const report = readFileSync(join(run.runDir, "final-report.md"), "utf8");
	assert.match(report, /all accepted findings verified resolved/);
});

test("deliberation round 2: no majority in d1 preserves the vote trail", async () => {
	const { repo, g } = makeRepo();
	const scripted: ScriptedRpc = {
		descriptions: [],
		reviewValue: [
			{ seat: "kimi", ok: true, runId: "k1", structured: { findings: [finding("f1", "lone bug")] }, output: "", error: null },
			{ seat: "sol", ok: true, runId: "s1", structured: { findings: [] }, output: "", error: null },
			{ seat: "glm", ok: true, runId: "g1", structured: { findings: [] }, output: "", error: null },
		],
		// d1: accept / reject / abstain → no majority → another round
		deliberation1: [
			{ seat: "kimi", ok: true, runId: "k2", structured: { votes: [vote("c1", "accept")] }, output: "", error: null, resumed: true },
			{ seat: "sol", ok: true, runId: "s2", structured: { votes: [vote("c1", "reject")] }, output: "", error: null, resumed: true },
			{ seat: "glm", ok: true, runId: "g2", structured: { votes: [vote("c1", "abstain")] }, output: "", error: null, resumed: true },
		],
		// d2: two rejects → rejected
		deliberation2: [
			{ seat: "kimi", ok: true, runId: "k3", structured: { votes: [vote("c1", "accept")] }, output: "", error: null, resumed: true },
			{ seat: "sol", ok: true, runId: "s3", structured: { votes: [vote("c1", "reject")] }, output: "", error: null, resumed: true },
			{ seat: "glm", ok: true, runId: "g3", structured: { votes: [vote("c1", "reject")] }, output: "", error: null, resumed: true },
		],
	};
	const run = makeRun(repo, makeFakeRpc(repo, g, scripted), "loop");
	await run.startLoop("");
	await pump(run);

	assert.equal(run.phase, "done");
	// both deliberation rounds' rebuttals survive
	assert.ok(existsSync(join(run.runDir, "round-1", "rebuttal-kimi-d1.md")));
	assert.ok(existsSync(join(run.runDir, "round-1", "rebuttal-kimi-d2.md")));
	// clusters.json preserves d1 votes in voteHistory
	const clusters = JSON.parse(readFileSync(join(run.runDir, "round-1", "clusters.json"), "utf8"));
	const c1 = clusters.find((c: { id: string }) => c.id === "c1");
	assert.equal(c1.status, "rejected");
	assert.equal(c1.voteHistory.length, 1);
	assert.equal(c1.voteHistory[0].deliberationRound, 1);
	assert.equal(c1.voteHistory[0].votes.glm.vote, "abstain");
	assert.equal(c1.votes.sol.vote, "reject"); // latest round
	// d2 description proves the second deliberation round ran
	assert.ok(scripted.descriptions.some((d) => d.includes("deliberation 2")));
});

test("read-only guard: a seat mutating the worktree during review fails the run", async () => {
	const { repo, g } = makeRepo();
	const scripted: ScriptedRpc = {
		descriptions: [],
		mutateDuringReview: true,
		reviewValue: [
			{ seat: "kimi", ok: true, runId: "k1", structured: { findings: [] }, output: "", error: null },
			{ seat: "sol", ok: true, runId: "s1", structured: { findings: [] }, output: "", error: null },
			{ seat: "glm", ok: true, runId: "g1", structured: { findings: [] }, output: "", error: null },
		],
	};
	const run = makeRun(repo, makeFakeRpc(repo, g, scripted), "review");
	const { target } = run.planReview("");
	await run.startReview(target);
	await pump(run);

	assert.equal(run.phase, "failed");
	assert.match(readFileSync(join(run.runDir, "error.txt"), "utf8"), /read-only review phase/);
});
