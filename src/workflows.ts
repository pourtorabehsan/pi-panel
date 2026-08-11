/**
 * workflowScript template builders (SPEC.md §7).
 * Scripts run in a sandbox: runs.run / runs.all / runs.status / runs.ref(s),
 * emit, console, standard JS. No filesystem. Scripts return structured data;
 * the extension writes all artifacts.
 *
 * Verified against pi-subagents src/workflows/scripted-workflow.ts:
 * - child result shape: { key, ok, runId?, output, error?, structuredOutput?, artifactPaths }
 * - runs.all collects failures as { ok: false } items instead of rejecting
 * - runs.ref(result) is a display-string formatter, NOT an id accessor —
 *   we return r.runId from the workflow for later resume.
 */

export interface WorkflowSeat {
	name: string;
	model: string;
	/** Retained child run id from this round's review workflow; null forces fresh fallback. */
	runId?: string | null;
}

/** Fields extracted from a workflow child result, tolerating shape variance (spec §7 M1). */
const CHILD_RESULT_MAP = `function mapResult(r, seat) {
	return {
		seat: seat,
		ok: Boolean(r && r.ok),
		runId: r && r.runId ? String(r.runId) : null,
		structured: r ? (r.structuredOutput !== undefined && r.structuredOutput !== null ? r.structuredOutput : (r.structured !== undefined ? r.structured : null)) : null,
		output: r && typeof r.output === "string" ? r.output : "",
		error: r && r.error ? String(r.error) : (r && !r.ok && r.output ? String(r.output).slice(0, 500) : null),
	};
}`;

/** Round review workflow: all seats in parallel, identical brief, fresh context. */
export function reviewRoundScript(seats: Array<{ name: string; model: string }>, brief: string, schema: object, keyPrefix: string): string {
	return `
const SEATS = ${JSON.stringify(seats)};
const BRIEF = ${JSON.stringify(brief)};
const SCHEMA = ${JSON.stringify(schema)};
${CHILD_RESULT_MAP}
const results = await runs.all(SEATS.map((s) => ({
	key: ${JSON.stringify(keyPrefix)} + s.name,
	agent: "reviewer",
	model: s.model,
	context: "fresh",
	task: BRIEF,
	outputSchema: SCHEMA,
})));
return results.map((r, i) => mapResult(r, SEATS[i].name));
`;
}

/**
 * Deliberation workflow: resume retained round children when possible;
 * seats whose resume fails (or lack a run id) are retried as fresh reviewers
 * reading the round artifacts (spec §7 fallback).
 */
export function deliberationScript(
	seats: WorkflowSeat[],
	d: number,
	task: string,
	fallbackPrefix: string,
	schema: object,
): string {
	return `
const SEATS = ${JSON.stringify(seats)};
const D = ${JSON.stringify(d)};
const TASK = ${JSON.stringify(task)};
const FALLBACK_PREFIX = ${JSON.stringify(fallbackPrefix)};
const SCHEMA = ${JSON.stringify(schema)};
${CHILD_RESULT_MAP}
const items = SEATS.map((s) => {
	const base = { key: "d" + D + "-" + s.name, outputSchema: SCHEMA };
	if (s.runId) {
		return { ...base, resume: s.runId, task: TASK };
	}
	return { ...base, agent: "reviewer", model: s.model, context: "fresh", task: FALLBACK_PREFIX + TASK };
});
const resumedFlags = SEATS.map((s) => Boolean(s.runId));
const results = await runs.all(items);
const retryIndexes = [];
results.forEach((r, i) => { if (!r || !r.ok) retryIndexes.push(i); });
if (retryIndexes.length > 0) {
	const retryItems = retryIndexes.map((i) => ({
		key: "d" + D + "-" + SEATS[i].name + "-fresh",
		agent: "reviewer",
		model: SEATS[i].model,
		context: "fresh",
		task: FALLBACK_PREFIX + TASK,
		outputSchema: SCHEMA,
	}));
	const retried = await runs.all(retryItems);
	retryIndexes.forEach((i, j) => { results[i] = retried[j]; resumedFlags[i] = false; });
}
return results.map((r, i) => ({ ...mapResult(r, SEATS[i].name), resumed: resumedFlags[i] }));
`;
}

/** Single-worker workflow (fixer or implementer). Model omitted when null (session model).
 *  runs.run REJECTS on child failure (unlike runs.all, which collects) — wrap it
 *  so a crashed worker returns a clean { ok: false } instead of failing the
 *  whole workflow and losing the error context. */
export function workerScript(key: string, model: string | null, task: string): string {
	return `
const PARAMS = { agent: "worker", context: "fresh", task: ${JSON.stringify(task)} };
const MODEL = ${JSON.stringify(model)};
if (MODEL) PARAMS.model = MODEL;
let r;
try {
	r = await runs.run(${JSON.stringify(key)}, PARAMS);
} catch (e) {
	return { ok: false, runId: null, output: "", error: "worker run threw: " + String(e && e.message ? e.message : e) };
}
return {
	ok: Boolean(r && r.ok),
	runId: r && r.runId ? String(r.runId) : null,
	output: r && typeof r.output === "string" ? r.output : "",
	error: r && r.error ? String(r.error) : (r && !r.ok && r.output ? String(r.output).slice(0, 500) : null),
};
`;
}

/** M1 probe: verifies spawn + completion plumbing and child result shape. */
export function probeScript(): string {
	return `
const r = await runs.run("probe", { agent: "scout", task: "Reply with exactly: ok" });
return {
	ok: Boolean(r && r.ok),
	runId: r && r.runId ? String(r.runId) : null,
	output: r && typeof r.output === "string" ? r.output : "",
	keys: r && typeof r === "object" ? Object.keys(r) : [],
};
`;
}
