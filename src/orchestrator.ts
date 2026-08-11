/**
 * The panel state machine (SPEC.md §3, §7).
 * Event-driven: each phase spawns an async workflow via RPC; completion
 * arrives on the subagent:async-complete event and advances the machine.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	createRoundDir,
	createRunDir,
	makeRunId,
	renderConsensus,
	renderFinalReport,
	resolveArtifactRoot,
	writeJson,
	writeText,
	type ClusterReportEntry,
	type RoundSummary,
} from "./artifacts.ts";
import {
	anchoredBrief,
	deliberationTask,
	fixerTask,
	freshDeliberationPrefix,
	implementerTask,
	round1Brief,
	type ContestedClusterPayload,
	type VerificationDisputePayload,
} from "./briefs.ts";
import type { PanelConfig } from "./config.ts";
import {
	FINDINGS_SCHEMA,
	VERDICTS_SCHEMA,
	VOTES_SCHEMA,
	aggregateVerdicts,
	clusterFindings,
	initialTally,
	parseFindingsOutput,
	parseVerdictsOutput,
	parseVotesOutput,
	resolveContested,
	type Cluster,
	type Finding,
	type SeatFinding,
	type SeatVerdict,
	type SeatVote,
} from "./findings.ts";
import { commitMessage, currentHead, git, GitError, isDirty, isPanelCommit, repoSlug, resolveTarget, tryResolveTarget, worktreeFingerprint, type ResolvedTarget } from "./git.ts";
import type { RpcClient } from "./rpc.ts";
import { deliberationScript, reviewRoundScript, workerScript } from "./workflows.ts";

export interface Ui {
	notify(message: string, kind?: "info" | "warning" | "error"): void;
	setStatus(key: string, text?: string): void;
	/** Present in TUI mode: oversized-diff confirmation. Absent → hard error. */
	confirmLargeDiff?(lines: number, max: number): Promise<boolean>;
}

export interface OrchestratorDeps {
	rpc: RpcClient;
	config: PanelConfig;
	configWarnings: string[];
	cwd: string;
	ui: Ui;
	onSettled: (run: PanelRun) => void;
}

type Phase = "init" | "implement" | "review" | "deliberate" | "fix" | "done" | "cancelled" | "failed";

interface SeatRoundResult {
	seat: string;
	ok: boolean;
	runId: string | null;
	structured: unknown;
	output: string;
	error: string | null;
	resumed?: boolean;
}

interface RoundState {
	n: number;
	dir: string;
	diffPath: string;
	targetDescription: string;
	fixSha: string | null;
	seatRunIds: Record<string, string | null>;
	failedSeats: string[];
	advisory: SeatFinding[];
	entries: ClusterReportEntry[];
	dropNotes: string[];
	deliberationRound: number;
	freshFallbackSeats: string[];
	/** Latest result per seat, merged across retry waves (retry overwrites failure). */
	collected: Record<string, SeatRoundResult>;
	/** Per-seat cursor into config seat fallbacks (next fallback index to try). */
	fallbackCursor: Record<string, number>;
	/** Brief of the in-flight review phase (reused verbatim for retry waves). */
	brief: string | null;
	/** Context of the in-flight deliberation phase (reused for retry waves). */
	delib: { d: number; task: string; fallbackPrefix: string } | null;
}

const STATUS_KEY = "panel";

export class PanelRun {
	readonly id = makeRunId();
	phase: Phase = "init";
	readonly runDir: string;
	activeAsyncId: string | null = null;
	activeAsyncDir: string | null = null;

	private round: RoundState | null = null;
	private roundHistory: RoundState[] = [];
	private targetDescription = "";
	private fixValidationByRound = new Map<number, string>();
	private implementationEvidence: string | null = null;
	private fixCommitByRound = new Map<number, string>();
	private stopReason = "";

	private readonly deps: OrchestratorDeps;
	readonly mode: "review" | "loop";

	constructor(deps: OrchestratorDeps, mode: "review" | "loop") {
		this.deps = deps;
		this.mode = mode;
		this.runDir = createRunDir(resolveArtifactRoot(deps.config.artifactDir, deps.cwd, repoSlug(deps.cwd)), this.id);
	}

	/** Tooling dirs excluded from dirty checks / fingerprints (only repo-relative ones can be excluded via pathspec). */
	private toolingExclusions(): string[] {
		const expanded = this.deps.config.artifactDir.replace(/^~\//, "");
		const isRelative = !this.deps.config.artifactDir.startsWith("/") && !this.deps.config.artifactDir.startsWith("~/");
		return [".pi-subagents", ...(isRelative ? [expanded] : [])];
	}

	get config(): PanelConfig {
		return this.deps.config;
	}

	// ------------------------------------------------------------------ entry

	/** Resolve the review target once (callers use this for the oversized-diff guard). */
	planReview(args: string): { target: ResolvedTarget; diffLines: number } {
		const target = resolveTarget(args, this.deps.cwd);
		return { target, diffLines: target.diffText.split("\n").length };
	}

	async startReview(target: ResolvedTarget): Promise<void> {
		await this.checkDiffSize(target.diffText);
		this.targetDescription = target.description;
		writeText(this.runDir, "target.md", `# Review target\n\n${target.description}\n\nCommands:\n${target.commands.map((c) => `- \`${c}\``).join("\n")}${target.notes.length ? `\n\nNotes:\n${target.notes.map((n) => `- ${n}`).join("\n")}` : ""}`);
		for (const note of target.notes) this.deps.ui.notify(note, "warning");
		this.startRound(1, target.diffText, target.description, null);
		await this.spawnReview();
	}

	async startLoop(request: string): Promise<void> {
		const dirty = isDirty(this.deps.cwd, this.toolingExclusions());
		const arg = request.trim();
		if (arg) {
			// A resolvable git target (branch / sha / PR) means "loop on already-
			// committed work"; anything else is an implementation request.
			const target = tryResolveTarget(arg, this.deps.cwd);
			if (target) {
				this.targetDescription = target.description;
				await this.checkDiffSize(target.diffText);
				writeText(this.runDir, "target.md", `# Review target\n\n${target.description}\n\nCommands:\n${target.commands.map((c) => `- \`${c}\``).join("\n")}${target.notes.length ? `\n\nNotes:\n${target.notes.map((n) => `- ${n}`).join("\n")}` : ""}`);
		for (const note of target.notes) this.deps.ui.notify(note, "warning");
				this.startRound(1, target.diffText, target.description, null);
				await this.spawnReview();
				return;
			}
			if (dirty) throw new GitError("Working tree has uncommitted changes; commit or stash them first — the implementer must never commit pre-existing user changes.");
			this.targetDescription = `implementation of: ${arg}`;
			writeText(this.runDir, "target.md", `# Implementation request\n\n${arg}`);
			await this.spawnImplementer(arg);
			return;
		}
		if (!dirty) {
			throw new GitError("Nothing to review: clean tree and no argument. Pass a branch, commit, or PR to loop on committed work (e.g. /panel-loop main), or a request to implement first.");
		}
		const diff = git(["diff", "HEAD"], this.deps.cwd);
		if (!diff.trim()) throw new GitError("Nothing to review: working tree has no tracked modifications.");
		await this.checkDiffSize(diff);
		this.targetDescription = "uncommitted changes in the working tree (git diff HEAD)";
		writeText(this.runDir, "target.md", `# Review target\n\n${this.targetDescription}`);
		this.startRound(1, diff, this.targetDescription, null);
		await this.spawnReview();
	}

	// ------------------------------------------------------------ spawn phases

	private startRound(n: number, diffText: string, description: string, fixSha: string | null): void {
		const dir = createRoundDir(this.runDir, n);
		const diffPath = writeText(dir, "diff.patch", diffText);
		this.round = {
			n,
			dir,
			diffPath,
			targetDescription: description,
			fixSha,
			seatRunIds: {},
			failedSeats: [],
			advisory: [],
			entries: [],
			dropNotes: [],
			deliberationRound: 0,
			freshFallbackSeats: [],
			collected: {},
			fallbackCursor: {},
			brief: null,
			delib: null,
		};
	}

	private async spawnPhase(script: string, description: string, phase: Phase): Promise<void> {
		this.phase = phase;
		// Review and deliberation seats are prompt-instructed read-only, but the
		// bundled reviewer agent technically has edit/write tools. Enforce the
		// promise deterministically: fingerprint the worktree now, verify on
		// completion (handleAsyncComplete) that nothing changed.
		if (phase === "review" || phase === "deliberate") {
			this.fingerprintBeforeReadOnlyPhase = this.safeFingerprint();
		}
		const spawned = await this.deps.rpc.spawn(script, description);
		// /panel-cancel may have landed while the spawn RPC was in flight;
		// stop the just-launched workflow instead of orphaning it.
		if (this.phase === "cancelled") {
			this.deps.rpc.stop(spawned.asyncId).catch(() => {});
			return;
		}
		this.activeAsyncId = spawned.asyncId;
		this.activeAsyncDir = spawned.asyncDir;
		this.status(`${description} — running`);
	}

	private fingerprintBeforeReadOnlyPhase: string | null = null;

	private safeFingerprint(): string | null {
		try {
			return worktreeFingerprint(this.deps.cwd, this.toolingExclusions());
		} catch {
			return null;
		}
	}

	private async spawnReview(): Promise<void> {
		const round = this.requireRound();
		const { seats } = this.deps.config;
		const isFirst = round.n === 1;
		const brief = isFirst
			? round1Brief(round.targetDescription, round.diffPath)
			: anchoredBrief(round.n, this.prevRoundDir(), round.fixSha ?? "the current uncommitted working-tree changes", round.diffPath);
		round.brief = brief;
		const script = reviewRoundScript(seats, brief, isFirst ? FINDINGS_SCHEMA : VERDICTS_SCHEMA, `r${round.n}-`);
		await this.spawnPhase(script, `round ${round.n}: reviewing (${seats.map((s) => s.name).join(", ")})`, "review");
	}

	/**
	 * Merge the latest wave's seat results into round.collected, then — if any
	 * seat still fails and has configured fallbacks left — spawn a retry wave
	 * for just those seats on their next fallback model. Returns true when a
	 * retry wave was spawned (the caller must return and wait for it).
	 */
	private async mergeAndRetry(seats: SeatRoundResult[]): Promise<SeatRoundResult[] | null> {
		const round = this.requireRound();
		for (const s of seats) {
			if (s.runId) round.seatRunIds[s.seat] = s.runId;
			round.collected[s.seat] = s;
		}
		const merged = this.deps.config.seats.map((cfg) =>
			round.collected[cfg.name] ?? { seat: cfg.name, ok: false, runId: null, structured: null, output: "", error: "no result" },
		);
		const retriable = merged.filter((s) => {
			if (s.ok) return false;
			const cfg = this.deps.config.seats.find((c) => c.name === s.seat);
			const cursor = round.fallbackCursor[s.seat] ?? 0;
			return (cfg?.fallbacks?.length ?? 0) > cursor;
		});
		if (retriable.length === 0) return merged;

		const retrySeats = retriable.map((s) => {
			const cfg = this.deps.config.seats.find((c) => c.name === s.seat)!;
			const idx = round.fallbackCursor[s.seat] ?? 0;
			round.fallbackCursor[s.seat] = idx + 1;
			return { name: s.seat, model: cfg.fallbacks![idx] };
		});
		this.deps.ui.notify(
			`Seat(s) ${retriable.map((s) => s.seat).join(", ")} failed; retrying on fallback: ${retrySeats.map((s) => `${s.name}→${s.model}`).join(", ")}`,
			"warning",
		);
		if (this.phase === "review") {
			const schema = round.n === 1 ? FINDINGS_SCHEMA : VERDICTS_SCHEMA;
			const script = reviewRoundScript(retrySeats, round.brief!, schema, `r${round.n}-retry-`);
			await this.spawnPhase(script, `round ${round.n}: retrying ${retriable.map((s) => s.seat).join(", ")} on fallback models`, "review");
		} else {
			const dctx = round.delib!;
			// Retry seats run fresh on the fallback model (no retained session to resume).
			const script = deliberationScript(retrySeats.map((s) => ({ ...s, runId: null })), dctx.d, dctx.task, dctx.fallbackPrefix, VOTES_SCHEMA);
			await this.spawnPhase(script, `round ${round.n}: deliberation ${dctx.d} retry on fallback models`, "deliberate");
		}
		return null;
	}

	private async spawnDeliberation(contested: ClusterReportEntry[], disputes: VerificationDisputePayload[]): Promise<void> {
		const round = this.requireRound();
		round.deliberationRound += 1;
		const d = round.deliberationRound;
		const contestedPayload: ContestedClusterPayload[] = contested.map((entry) => ({
			clusterId: entry.cluster.id,
			raisedBy: entry.cluster.raisers,
			finding: pickFindingPayload(entry.cluster.representative),
		}));
		// Archive the previous deliberation round's votes before they are shown
		// (and before the new round overwrites entry.votes) — the deliberation
		// trail must survive every round (spec §3, dissent preservation).
		const previousVotes = d > 1 ? JSON.stringify(collectVotes(contested), null, 2) : null;
		if (d > 1) {
			for (const entry of contested) {
				if (Object.keys(entry.votes).length > 0) {
					entry.voteHistory.push({ deliberationRound: d - 1, votes: entry.votes });
					entry.votes = {};
				}
			}
		}
		const task = deliberationTask(d, contestedPayload, disputes, previousVotes);
		const fallbackPrefix = freshDeliberationPrefix(round.dir);
		round.delib = { d, task, fallbackPrefix };
		const seats = this.deps.config.seats.map((s) => ({ name: s.name, model: s.model, runId: round.seatRunIds[s.name] ?? null }));
		const script = deliberationScript(seats, d, task, fallbackPrefix, VOTES_SCHEMA);
		await this.spawnPhase(script, `round ${round.n}: deliberation ${d} (${contested.length + disputes.length} item(s))`, "deliberate");
	}

	private async spawnFix(fixQueue: ClusterReportEntry[]): Promise<void> {
		const round = this.requireRound();
		const findingsJson = JSON.stringify(
			fixQueue.map((entry) => ({
				clusterId: entry.cluster.id,
				...pickFindingPayload(entry.cluster.representative),
				...(entry.verdicts.length > 0 ? { previousVerdicts: entry.verdicts.map((v) => ({ seat: v.seat, verdict: v.verdict, evidence: v.evidence })) } : {}),
			})),
			null,
			2,
		);
		this.captureHeadBeforeWorker();
		const task = fixerTask(findingsJson, round.n, fixQueue.length, this.deps.config.autoCommit);
		const script = workerScript(`fix-${round.n}`, this.deps.config.fixer, task);
		await this.spawnPhase(script, `round ${round.n}: fixing ${fixQueue.length} accepted finding(s)`, "fix");
	}

	private async spawnImplementer(request: string): Promise<void> {
		this.captureHeadBeforeWorker();
		const task = implementerTask(request, this.deps.config.autoCommit);
		const script = workerScript("implement-0", this.deps.config.implementer, task);
		await this.spawnPhase(script, "round 0: implementing request", "implement");
	}

	// ------------------------------------------------------------ completion

	/** Called by index.ts when a subagent:async-complete event matches this run. */
	async handleAsyncComplete(): Promise<void> {
		if (this.phase === "done" || this.phase === "cancelled" || this.phase === "failed") return;
		const asyncDir = this.activeAsyncDir;
		const phase = this.phase;
		this.activeAsyncId = null;
		try {
			if ((phase === "review" || phase === "deliberate") && this.fingerprintBeforeReadOnlyPhase) {
				const after = this.safeFingerprint();
				if (after && after !== this.fingerprintBeforeReadOnlyPhase) {
					throw new Error(
						`A panel seat modified the worktree during a read-only ${phase} phase. ` +
						`This violates the read-only guarantee — inspect \`git status\` before continuing.`,
					);
				}
			}
			const value = this.readWorkflowValue(asyncDir);
			if (phase === "review") await this.advanceReview(value);
			else if (phase === "deliberate") await this.advanceDeliberation(value);
			else if (phase === "fix") await this.advanceFix(value);
			else if (phase === "implement") await this.advanceImplement(value);
		} catch (error) {
			this.fail(error);
		}
	}

	private readWorkflowValue(asyncDir: string | null): unknown {
		if (!asyncDir) throw new Error("Internal error: workflow completed but no async dir was recorded.");
		let status: { state?: string; error?: string; workflow?: { value?: unknown } };
		try {
			status = JSON.parse(readFileSync(join(asyncDir, "status.json"), "utf8"));
		} catch (error) {
			throw new Error(`Could not read workflow status at ${join(asyncDir, "status.json")}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (status.state === "failed" || status.state === "stopped") {
			throw new Error(`Workflow ${status.state}: ${status.error ?? "no error recorded"}`);
		}
		if (!status.workflow || status.workflow.value === undefined) {
			throw new Error("Workflow completed without a return value (status.json has no workflow.value).");
		}
		return status.workflow.value;
	}

	// ------------------------------------------------------------- advancing

	private async advanceReview(value: unknown): Promise<void> {
		const round = this.requireRound();
		const merged = await this.mergeAndRetry(this.parseSeatResults(value));
		if (!merged) return; // retry wave spawned — wait for its completion
		const seats = merged;
		round.failedSeats = []; // recomputed from the final merged results below

		if (round.n === 1) {
			const bySeat: Array<{ seat: string; findings: Finding[] }> = [];
			for (const s of seats) {
				if (!s.ok) {
					round.failedSeats.push(s.seat);
					round.dropNotes.push(`Seat ${s.seat} run failed: ${s.error ?? "unknown error"}`);
					continue;
				}
				const parsed = parseFindingsOutput(s.structured, s.output, false);
				if (!parsed.value) {
					round.failedSeats.push(s.seat);
					round.dropNotes.push(`Seat ${s.seat} returned unparseable findings output.`);
					continue;
				}
				if (parsed.dropped > 0) round.dropNotes.push(`Seat ${s.seat}: dropped ${parsed.dropped} schema-invalid finding(s).`);
				writeJson(round.dir, `findings-${s.seat}.json`, { findings: parsed.value });
				bySeat.push({ seat: s.seat, findings: parsed.value });
			}
			this.guardSeatFailures(round);
			const { clusters, advisory } = clusterFindings(bySeat);
			round.advisory = advisory;
			round.entries = clusters.map((cluster) => ({
				cluster,
				status: initialTally(cluster),
				votes: {},
				voteHistory: [],
				verdicts: [],
				source: "new" as const,
			}));
			writeJson(round.dir, "clusters.json", clustersForJson(round.entries));
			const contested = round.entries.filter((e) => e.status === "contested");
			if (contested.length > 0) {
				await this.spawnDeliberation(contested, []);
				return;
			}
			await this.finalizeConsensus();
			return;
		}

		// Round 2+: verdicts + new findings.
		const prevEntries = this.prevRound().entries.filter((e) => e.status === "accepted" || e.status === "open");
		const verdictsByCluster = new Map<string, SeatVerdict[]>();
		const newBySeat: Array<{ seat: string; findings: Finding[] }> = [];
		for (const s of seats) {
			if (!s.ok) {
				round.failedSeats.push(s.seat);
				round.dropNotes.push(`Seat ${s.seat} run failed: ${s.error ?? "unknown error"}`);
				continue;
			}
			const parsed = parseVerdictsOutput(s.structured, s.output);
			if (!parsed.value) {
				round.failedSeats.push(s.seat);
				round.dropNotes.push(`Seat ${s.seat} returned unparseable verdicts output.`);
				continue;
			}
			if (parsed.dropped > 0) round.dropNotes.push(`Seat ${s.seat}: dropped ${parsed.dropped} schema-invalid verdict/finding item(s).`);
			writeJson(round.dir, `findings-${s.seat}.json`, { verdicts: parsed.value.verdicts, newFindings: parsed.value.newFindings });
			for (const v of parsed.value.verdicts) {
				const list = verdictsByCluster.get(v.clusterId) ?? [];
				list.push({ seat: s.seat, clusterId: v.clusterId, verdict: v.verdict, evidence: v.evidence });
				verdictsByCluster.set(v.clusterId, list);
			}
			newBySeat.push({ seat: s.seat, findings: parsed.value.newFindings });
		}
		this.guardSeatFailures(round);

		// Carry forward previously accepted clusters with verdict aggregation.
		const carried: ClusterReportEntry[] = prevEntries.map((entry) => {
			const verdicts = verdictsByCluster.get(entry.cluster.id) ?? [];
			const aggregation = aggregateVerdicts(verdicts);
			const status = aggregation === "resolved" ? "resolved" : aggregation === "open" ? "open" : "contested"; // "contested" here = dispute → deliberation
			return { ...entry, verdicts, status, source: "carried" as const };
		});

		// New findings cluster and tally exactly like round 1.
		const { clusters, advisory } = clusterFindings(newBySeat);
		round.advisory = advisory;
		// Renumber new cluster ids to continue after carried ids (clusterFindings
		// restarts at c1 per call; ids must stay unique across the whole run).
		let nextId = 1;
		for (const entry of prevEntries) {
			const n = Number(/^c(\d+)$/.exec(entry.cluster.id)?.[1] ?? 0);
			if (n >= nextId) nextId = n + 1;
		}
		const newEntries: ClusterReportEntry[] = clusters.map((cluster) => ({
			cluster: { ...cluster, id: `c${nextId++}` },
			status: initialTally(cluster),
			votes: {},
			voteHistory: [],
			verdicts: [],
			source: "new" as const,
		}));

		round.entries = [...carried, ...newEntries];
		writeJson(round.dir, "clusters.json", clustersForJson(round.entries));

		const disputes: VerificationDisputePayload[] = carried
			.filter((e) => e.status === "contested")
			.map((e) => {
				const partial = e.verdicts.find((v) => v.verdict === "partial");
				return {
					clusterId: e.cluster.id,
					finding: pickFindingPayload(e.cluster.representative),
					partialSeat: partial?.seat ?? "",
					partialEvidence: partial?.evidence ?? "",
				};
			});
		const contestedNew = newEntries.filter((e) => e.status === "contested");

		if (contestedNew.length > 0 || disputes.length > 0) {
			await this.spawnDeliberation(contestedNew, disputes);
			return;
		}
		await this.finalizeConsensus();
	}

	private async advanceDeliberation(value: unknown): Promise<void> {
		const round = this.requireRound();
		const merged = await this.mergeAndRetry(this.parseSeatResults(value));
		if (!merged) return; // retry wave spawned
		const seats = merged;
		for (const s of seats) {
			if (s.runId) round.seatRunIds[s.seat] = s.runId;
			if (s.resumed === false) round.freshFallbackSeats.push(s.seat);
			if (!s.ok) {
				round.dropNotes.push(`Seat ${s.seat} deliberation failed: ${s.error ?? "unknown error"} (seat abstains on unresolved items).`);
				continue;
			}
			const parsed = parseVotesOutput(s.structured, s.output);
			if (!parsed.value) {
				round.dropNotes.push(`Seat ${s.seat} returned unparseable deliberation votes (seat abstains).`);
				continue;
			}
			const votes: SeatVote[] = parsed.value.map((v) => ({ ...v, seat: s.seat }));
			writeText(
				round.dir,
				`rebuttal-${s.seat}-d${round.deliberationRound}.md`,
				`# Deliberation round ${round.deliberationRound} — seat ${s.seat}${s.resumed === false ? " (fresh fallback, no prior context)" : ""}\n\n` +
					votes.map((v) => `## ${v.clusterId}: ${v.vote}\n\n- Verified evidence: ${v.verifiedEvidence}\n- Rationale: ${v.rationale}`).join("\n\n"),
			);
			for (const vote of votes) {
				const entry = round.entries.find((e) => e.cluster.id === vote.clusterId);
				if (entry) entry.votes[s.seat] = vote;
			}
		}

		// Resolve contested clusters and disputes.
		const stillContested: ClusterReportEntry[] = [];
		const stillDisputed: VerificationDisputePayload[] = [];
		for (const entry of round.entries) {
			if (entry.status !== "contested") continue;
			const votesBySeat: Record<string, "accept" | "reject" | "abstain"> = {};
			for (const [seat, v] of Object.entries(entry.votes)) votesBySeat[seat] = v.vote;
			const outcome = resolveContested(entry.cluster, votesBySeat);
			if (outcome === "accepted") {
				entry.status = entry.source === "carried" ? "open" : "accepted"; // dispute upheld → still open
			} else if (outcome === "rejected") {
				entry.status = entry.source === "carried" ? "resolved" : "rejected"; // dispute overruled → resolved
			} else if (round.deliberationRound < this.deps.config.maxDeliberationRounds) {
				stillContested.push(entry);
			} else {
				// No majority after max deliberation rounds.
				if (entry.source === "carried") {
					entry.status = "open"; // dispute unresolved: keep the finding open (safer)
					round.dropNotes.push(`Cluster ${entry.cluster.id}: verification dispute unresolved after deliberation; kept open.`);
				} else {
					entry.status = "rejected-unresolved";
				}
			}
		}
		for (const entry of stillContested) {
			if (entry.source === "carried") {
				const partial = entry.verdicts.find((v) => v.verdict === "partial");
				stillDisputed.push({
					clusterId: entry.cluster.id,
					finding: pickFindingPayload(entry.cluster.representative),
					partialSeat: partial?.seat ?? "",
					partialEvidence: partial?.evidence ?? "",
				});
			}
		}
		writeJson(round.dir, "clusters.json", clustersForJson(round.entries));

		const newContested = stillContested.filter((e) => e.source === "new");
		if (newContested.length > 0 || stillDisputed.length > 0) {
			await this.spawnDeliberation(newContested, stillDisputed);
			return;
		}
		await this.finalizeConsensus();
	}

	private async finalizeConsensus(): Promise<void> {
		const round = this.requireRound();
		const notes = [...round.dropNotes];
		if (round.freshFallbackSeats.length > 0) {
			notes.push(`Deliberation used fresh-seat fallback for: ${[...new Set(round.freshFallbackSeats)].join(", ")} (retained resume unavailable; weaker defense context).`);
		}
		writeText(round.dir, "consensus.md", renderConsensus({
			round: round.n,
			entries: round.entries,
			advisory: round.advisory,
			failedSeats: round.failedSeats,
			notes,
		}));
		this.roundHistory.push(round);

		if (this.mode === "review") {
			this.stopReason = "review complete";
			this.finish("done");
			return;
		}

		// /panel-loop: fix queue = newly accepted + carried-still-open.
		const fixQueue = round.entries.filter((e) => e.status === "accepted" || e.status === "open");
		if (fixQueue.length === 0) {
			this.stopReason = round.n === 1 ? "panel accepted no findings — nothing to fix" : "all accepted findings verified resolved and no new findings accepted";
			this.finish("done");
			return;
		}
		if (round.n >= this.deps.config.maxLoopRounds) {
			this.stopReason = `loop cap reached (maxLoopRounds=${this.deps.config.maxLoopRounds}) with ${fixQueue.length} open finding(s)`;
			this.finish("done");
			return;
		}
		await this.spawnFix(fixQueue);
	}

	private async advanceFix(value: unknown): Promise<void> {
		const round = this.requireRound();
		const result = this.parseWorkerResult(value);
		if (!result.ok) {
			throw new Error(`Fixer failed in round ${round.n}: ${result.error ?? "unknown error"}\n${result.output.slice(0, 1000)}`);
		}
		this.fixValidationByRound.set(round.n, result.output.slice(-2000));

		let fixSha: string | null = null;
		let diffText: string;
		if (this.deps.config.autoCommit) {
			const head = currentHead(this.deps.cwd);
			if (head === this.headBeforeWorker) {
				throw new Error(`Fixer in round ${round.n} produced no commit (HEAD unchanged).\nFixer output:\n${result.output.slice(0, 1000)}`);
			}
			if (!isPanelCommit(this.deps.cwd, head)) {
				throw new Error(`Fixer in round ${round.n} committed without the panel trailer: "${commitMessage(this.deps.cwd, head)}". Refusing to continue (panel commits must carry a "Panel-Loop: round N" trailer).`);
			}
			fixSha = head;
			this.fixCommitByRound.set(round.n, head);
			diffText = git(["show", head], this.deps.cwd);
		} else {
			diffText = git(["diff", "HEAD"], this.deps.cwd);
			if (!diffText.trim()) throw new Error(`Fixer in round ${round.n} produced no working-tree changes (autoCommit disabled).`);
		}

		const nextN = round.n + 1;
		const nextDir = createRoundDir(this.runDir, nextN);
		const diffPath = writeText(nextDir, "diff.patch", diffText);
		if (fixSha) writeText(nextDir, "fix-commit.txt", `${fixSha}\n${commitMessage(this.deps.cwd, fixSha)}`);
		this.round = {
			n: nextN,
			dir: nextDir,
			diffPath,
			targetDescription: round.targetDescription,
			fixSha,
			seatRunIds: {},
			failedSeats: [],
			advisory: [],
			entries: [],
			dropNotes: [],
			deliberationRound: 0,
			freshFallbackSeats: [],
			collected: {},
			fallbackCursor: {},
			brief: null,
			delib: null,
		};
		await this.spawnReview();
	}

	private headBeforeWorker: string | null = null;

	private async advanceImplement(value: unknown): Promise<void> {
		const result = this.parseWorkerResult(value);
		if (!result.ok) {
			throw new Error(`Implementer failed: ${result.error ?? "unknown error"}\n${result.output.slice(0, 1000)}`);
		}
		this.implementationEvidence = result.output.slice(-2000);
		let diffText: string;
		let description: string;
		if (this.deps.config.autoCommit) {
			const head = currentHead(this.deps.cwd);
			if (head === this.headBeforeWorker) {
				throw new Error(`Implementer produced no commit (HEAD unchanged). If the request was already implemented and committed, run /panel-review <sha> or /panel-review <base-branch> instead of /panel-loop with a request.\nImplementer output:\n${result.output.slice(0, 1000)}`);
			}
			if (!isPanelCommit(this.deps.cwd, head)) {
				throw new Error(`Implementer committed without the panel trailer: "${commitMessage(this.deps.cwd, head)}". Refusing to continue (panel commits must carry a "Panel-Loop: round N" trailer).`);
			}
			diffText = git(["show", head], this.deps.cwd);
			description = `${this.targetDescription} — commit ${head.slice(0, 8)}`;
		} else {
			diffText = git(["diff", "HEAD"], this.deps.cwd);
			if (!diffText.trim()) throw new Error("Implementer produced no working-tree changes (autoCommit disabled).");
			description = `${this.targetDescription} — uncommitted working tree`;
		}
		this.startRound(1, diffText, description, null);
		await this.spawnReview();
	}

	/** Records HEAD before spawning a commit-producing worker. */
	captureHeadBeforeWorker(): void {
		try {
			this.headBeforeWorker = currentHead(this.deps.cwd);
		} catch {
			this.headBeforeWorker = null;
		}
	}

	// ---------------------------------------------------------------- helpers

	private parseSeatResults(value: unknown): SeatRoundResult[] {
		if (!Array.isArray(value)) {
			throw new Error(`Workflow returned an unexpected shape (expected array of seat results): ${JSON.stringify(value)?.slice(0, 300)}`);
		}
		return value.map((item) => {
			const r = (item ?? {}) as Record<string, unknown>;
			return {
				seat: typeof r.seat === "string" ? r.seat : "unknown",
				ok: Boolean(r.ok),
				runId: typeof r.runId === "string" ? r.runId : null,
				structured: r.structured ?? null,
				output: typeof r.output === "string" ? r.output : "",
				error: typeof r.error === "string" ? r.error : null,
				resumed: typeof r.resumed === "boolean" ? r.resumed : undefined,
			};
		});
	}

	private parseWorkerResult(value: unknown): { ok: boolean; output: string; error: string | null } {
		const r = (value ?? {}) as Record<string, unknown>;
		return {
			ok: Boolean(r.ok),
			output: typeof r.output === "string" ? r.output : "",
			error: typeof r.error === "string" ? r.error : null,
		};
	}

	private guardSeatFailures(round: RoundState): void {
		const working = this.deps.config.seats.length - round.failedSeats.length;
		if (working < 2) {
			throw new Error(`Panel degraded: ${round.failedSeats.length} of ${this.deps.config.seats.length} seats failed in round ${round.n} (${round.failedSeats.join(", ")}). A panel needs at least 2 working seats.`);
		}
		if (round.failedSeats.length > 0) {
			this.deps.ui.notify(`Panel degraded: seat(s) ${round.failedSeats.join(", ")} failed this round; continuing with ${working} seats.`, "warning");
		}
	}

	private requireRound(): RoundState {
		if (!this.round) throw new Error("Internal error: no active round.");
		return this.round;
	}

	private prevRound(): RoundState {
		const prev = this.roundHistory[this.roundHistory.length - 1];
		if (!prev) throw new Error("Internal error: no previous round for anchored review.");
		return prev;
	}

	private prevRoundDir(): string {
		return this.prevRound().dir;
	}

	private async checkDiffSize(diffText: string): Promise<void> {
		const lines = diffText.split("\n").length;
		if (lines <= this.deps.config.maxDiffLines) return;
		if (this.deps.ui.confirmLargeDiff) {
			const ok = await this.deps.ui.confirmLargeDiff(lines, this.deps.config.maxDiffLines);
			if (ok) return;
			throw new GitError(`Diff is ${lines} lines, above maxDiffLines=${this.deps.config.maxDiffLines}. Declined.`);
		}
		throw new GitError(`Diff is ${lines} lines, above maxDiffLines=${this.deps.config.maxDiffLines}. Raise panel.maxDiffLines in settings.json to allow it (non-interactive mode cannot confirm).`);
	}

	private status(text: string): void {
		this.deps.ui.setStatus(STATUS_KEY, `panel: ${text}`);
	}

	private finish(phase: "done" | "cancelled" | "failed"): void {
		this.phase = phase;
		this.writeFinalReport();
		this.deps.ui.setStatus(STATUS_KEY, undefined);
		if (phase === "done") {
			this.deps.ui.notify(`Panel run complete (${this.stopReason}). Report: ${join(this.runDir, "final-report.md")}`, "info");
		}
		this.deps.onSettled(this);
	}

	private fail(error: unknown): void {
		this.phase = "failed";
		const message = error instanceof Error ? error.message : String(error);
		this.stopReason = `failed: ${message.split("\n")[0]}`;
		try {
			this.writeFinalReport();
			writeText(this.runDir, "error.txt", error instanceof Error ? (error.stack ?? message) : message);
		} catch {
			// best effort
		}
		this.deps.ui.setStatus(STATUS_KEY, undefined);
		this.deps.ui.notify(`Panel run failed: ${message.split("\n")[0]}\nArtifacts: ${this.runDir}`, "error");
		this.deps.onSettled(this);
	}

	/** Remove the run directory (used when startup fails before any phase ran). */
	discard(): void {
		this.phase = "failed";
		try {
			rmSync(this.runDir, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}

	cancel(): void {
		const asyncId = this.activeAsyncId;
		this.stopReason = "cancelled by /panel-cancel";
		if (asyncId) {
			this.deps.rpc.stop(asyncId).catch(() => {
				// stop is best-effort; the run may already have completed
			});
		}
		this.activeAsyncId = null;
		this.finish("cancelled");
	}

	private writeFinalReport(): void {
		const rounds: RoundSummary[] = this.roundHistory.map((r) => ({
			round: r.n,
			accepted: r.entries.filter((e) => e.status === "accepted" || e.status === "open").length,
			rejected: r.entries.filter((e) => e.status === "rejected" || e.status === "rejected-unresolved").length,
			advisory: r.advisory.length,
			resolved: r.entries.filter((e) => e.status === "resolved").length,
			fixCommit: this.fixCommitByRound.get(r.n) ?? null,
			fixValidation: this.fixValidationByRound.get(r.n) ?? null,
		}));
		const lastRound = this.roundHistory[this.roundHistory.length - 1];
		const leftovers = this.stopReason.startsWith("loop cap") && lastRound
			? lastRound.entries.filter((e) => e.status === "accepted" || e.status === "open")
			: [];
		writeText(this.runDir, "final-report.md", renderFinalReport({
			runId: this.id,
			mode: this.mode,
			targetDescription: this.targetDescription,
			rounds,
			leftovers,
			stopReason: this.stopReason,
			configNotes: this.deps.configWarnings,
			implementationEvidence: this.implementationEvidence,
		}));
	}
}

function pickFindingPayload(f: Finding) {
	return {
		file: f.file,
		lineStart: f.lineStart,
		lineEnd: f.lineEnd,
		symbol: f.symbol,
		title: f.title,
		claim: f.claim,
		evidence: f.evidence,
		suggestedFix: f.suggestedFix,
		severity: f.severity,
	};
}

function collectVotes(entries: ClusterReportEntry[]): unknown {
	return entries.map((entry) => ({
		clusterId: entry.cluster.id,
		votes: Object.values(entry.votes).map((v) => ({ seat: v.seat, vote: v.vote, rationale: v.rationale })),
	}));
}

function clustersForJson(entries: ClusterReportEntry[]): unknown {
	return entries.map((entry) => ({
		id: entry.cluster.id,
		status: entry.status,
		raisers: entry.cluster.raisers,
		representative: entry.cluster.representative,
		items: entry.cluster.items.map((item) => ({ seat: item.seat, finding: item.finding })),
		votes: Object.fromEntries(Object.entries(entry.votes).map(([seat, v]) => [seat, { vote: v.vote, verifiedEvidence: v.verifiedEvidence, rationale: v.rationale }])),
		voteHistory: entry.voteHistory.map((h) => ({
			deliberationRound: h.deliberationRound,
			votes: Object.fromEntries(Object.entries(h.votes).map(([seat, v]) => [seat, { vote: v.vote, verifiedEvidence: v.verifiedEvidence, rationale: v.rationale }])),
		})),
		verdicts: entry.verdicts,
	}));
}

