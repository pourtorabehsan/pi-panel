/**
 * pi-panel — multi-model panel code review for pi.
 * Registers /panel-review, /panel-loop, /panel-cancel, /panel-ping (diagnostics).
 * All orchestration runs through the pi-subagents in-process RPC.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ConfigError, loadConfig, type PanelConfig } from "./config.ts";
import { GitError } from "./git.ts";
import { PanelRun } from "./orchestrator.ts";
import { ASYNC_COMPLETE_EVENT, asyncCompleteId, createRpcClient, RpcError } from "./rpc.ts";
import { runPanelEditor, runPanelSetup } from "./setup.ts";
import { probeScript } from "./workflows.ts";

const MISSING_SUBAGENTS_MESSAGE =
	"pi-panel requires the pi-subagents package. Install it (`pi install npm:pi-subagents`) and retry.";

interface RunContext {
	config: PanelConfig;
	configWarnings: string[];
}

function loadRunContext(): RunContext {
	const { config, warnings } = loadConfig();
	return { config, configWarnings: warnings };
}

export default function (pi: ExtensionAPI) {
	const rpc = createRpcClient(pi.events);
	let activeRun: PanelRun | null = null;

	pi.events.on(ASYNC_COMPLETE_EVENT, (payload: unknown) => {
		const run = activeRun;
		if (!run || !run.activeAsyncId) return;
		const id = asyncCompleteId(payload);
		// Exact match required: id-less or foreign events must never advance the run.
		if (!id || id !== run.activeAsyncId) return;
		run.handleAsyncComplete().catch(() => {
			// handleAsyncComplete routes failures into run.fail(); this is a last-resort guard
		});
	});

	pi.on("session_shutdown", () => {
		// State machine is in-memory (spec N4); artifacts remain on disk.
		activeRun = null;
	});

	function guardMode(ctx: ExtensionCommandContext): boolean {
		if (ctx.mode === "print" || ctx.mode === "json") {
			ctx.ui.notify("Panel runs are long-lived; /panel-* commands require interactive (tui) or rpc mode.", "error");
			return false;
		}
		return true;
	}

	function guardNoActiveRun(): boolean {
		if (activeRun && activeRun.phase !== "done" && activeRun.phase !== "cancelled" && activeRun.phase !== "failed") {
			return false;
		}
		return true;
	}

	/**
	 * Seats guard: unconfigured panel routes to interactive setup (first-use
	 * onboarding). Returns true when seats exist (possibly just configured).
	 */
	async function guardSeats(ctx: ExtensionCommandContext): Promise<boolean> {
		const { config } = loadRunContext();
		if (config.seats.length === 3) return true;
		if (!ctx.hasUI || ctx.mode !== "tui") {
			ctx.ui.notify("pi-panel is not configured: run /panel-setup (interactive) or set panel.seats in settings.json.", "error");
			return false;
		}
		const yes = await ctx.ui.confirm(
			"pi-panel setup",
			"No panel configured yet. Pick 3 reviewer models now? (recommended: 3 different labs)",
		);
		if (!yes) {
			ctx.ui.notify("Aborted. Run /panel-setup when ready, or set panel.seats in settings.json.", "info");
			return false;
		}
		const seats = await runPanelSetup(ctx, ctx.modelRegistry);
		return seats !== null;
	}

	async function guardRpc(ctx: ExtensionCommandContext): Promise<boolean> {
		try {
			await rpc.ping(5000);
			return true;
		} catch {
			ctx.ui.notify(MISSING_SUBAGENTS_MESSAGE, "error");
			return false;
		}
	}

	function startRun(mode: "review" | "loop"): PanelRun {
		const { config, configWarnings } = loadRunContext();
		const run = new PanelRun(
			{
				rpc,
				config,
				configWarnings,
				cwd: currentCwd,
				ui: currentUi,
				onSettled: () => {
					// keep activeRun pointing at the settled run so users can cancel-inspect;
					// a new run clears it via guardNoActiveRun
				},
			},
			mode,
		);
		activeRun = run;
		return run;
	}

	// ctx captured at command time; ui/cwd are session-scoped and stay valid for the run.
	let currentCwd = "";
	let currentUi = { notify: (_msg: string, _kind?: "info" | "warning" | "error") => {}, setStatus: (_key: string, _text?: string) => {} };

	function captureCtx(ctx: ExtensionCommandContext): void {
		currentCwd = ctx.cwd;
		currentUi = {
			notify: (msg, kind) => ctx.ui.notify(msg, kind),
			setStatus: (key, text) => ctx.ui.setStatus(key, text),
			// TUI-only: lets the orchestrator confirm oversized diffs in-loop.
			...(ctx.hasUI && ctx.mode === "tui"
				? {
						confirmLargeDiff: (lines: number, max: number) =>
							ctx.ui.confirm("Large diff", `The diff is ${lines} lines (maxDiffLines=${max}). Panel review cost scales with diff size. Proceed?`),
					}
				: {}),
		};
	}

	function reportStartError(ctx: ExtensionCommandContext, error: unknown, run?: PanelRun): void {
		if (error instanceof ConfigError || error instanceof GitError || error instanceof RpcError || error instanceof Error) {
			ctx.ui.notify(error.message.split("\n")[0], "error");
		} else {
			ctx.ui.notify(String(error), "error");
		}
		run?.discard(); // remove the run dir created before the failure (undefined if config load failed first)
		activeRun = null;
	}

	pi.registerCommand("panel-review", {
		description: "Multi-model panel review of a diff (working tree, commit, branch, or PR). Report only; never modifies files.",
		handler: async (args, ctx) => {
			if (!guardMode(ctx)) return;
			if (!guardNoActiveRun()) {
				ctx.ui.notify(`A panel run is already active. Artifacts: ${activeRun!.runDir}. Use /panel-cancel to stop it.`, "error");
				return;
			}
			captureCtx(ctx);
			if (!(await guardSeats(ctx))) return;
			if (!(await guardRpc(ctx))) return;

			let run: PanelRun | undefined;
			try {
				run = startRun("review");
				// Resolve the target exactly once (PR targets cost gh network calls);
				// the oversized-diff guard (with TUI confirm) lives in startReview.
				const { target } = run.planReview(args);
				await run.startReview(target);
			} catch (error) {
				reportStartError(ctx, error, run);
				return;
			}
			ctx.ui.notify(`Panel review started. Artifacts: ${run!.runDir}`, "info");
		},
	});

	pi.registerCommand("panel-loop", {
		description: "Panel review + fix loop: optional implementation, then panel → fix → re-panel until clean (one commit per round).",
		handler: async (args, ctx) => {
			if (!guardMode(ctx)) return;
			if (!guardNoActiveRun()) {
				ctx.ui.notify(`A panel run is already active. Artifacts: ${activeRun!.runDir}. Use /panel-cancel to stop it.`, "error");
				return;
			}
			captureCtx(ctx);
			if (!(await guardSeats(ctx))) return;
			if (!(await guardRpc(ctx))) return;

			let run: PanelRun | undefined;
			try {
				run = startRun("loop");
				await run.startLoop(args);
			} catch (error) {
				reportStartError(ctx, error, run);
				return;
			}
			ctx.ui.notify(`Panel loop started. Artifacts: ${run!.runDir}`, "info");
		},
	});

	pi.registerCommand("panel-setup", {
		description: "Configure the panel: pick 3 reviewer models from your available (authenticated) models. Re-runnable.",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("/panel-setup needs interactive mode. Alternatively set panel.seats in ~/.pi/agent/settings.json manually.", "error");
				return;
			}
			const { config } = loadRunContext();
			await runPanelEditor(ctx, ctx.modelRegistry, config);
		},
	});

	pi.registerCommand("panel-cancel", {
		description: "Stop the active panel run.",
		handler: async (_args, ctx) => {
			if (!activeRun || activeRun.phase === "done" || activeRun.phase === "cancelled" || activeRun.phase === "failed") {
				ctx.ui.notify("No active panel run.", "info");
				return;
			}
			const run = activeRun;
			run.cancel();
			ctx.ui.notify(`Panel run cancelled. Artifacts: ${run.runDir}`, "info");
		},
	});

	pi.registerCommand("panel-ping", {
		description: "Diagnostics: ping pi-subagents RPC and run a probe workflow (verifies spawn/completion plumbing).",
		handler: async (_args, ctx) => {
			if (!guardMode(ctx)) return;
			try {
				const ping = await rpc.ping(5000);
				ctx.ui.notify(`pi-subagents RPC reachable: protocol v${ping.version ?? "?"}, methods: ${(ping.methods ?? []).join(", ")}`, "info");
			} catch {
				ctx.ui.notify(MISSING_SUBAGENTS_MESSAGE, "error");
				return;
			}
			try {
				const spawned = await rpc.spawn(probeScript(), "panel probe");
				ctx.ui.notify(`Probe workflow launched (id ${spawned.asyncId}). Watch for the async completion notification; status.json will appear in ${spawned.asyncDir ?? "the async dir"}.`, "info");
			} catch (error) {
				ctx.ui.notify(`Probe spawn failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
