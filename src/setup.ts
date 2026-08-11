/**
 * /panel-setup — flat interactive settings editor (TUI).
 * One menu lists every configurable row (3 seats + knobs); Enter edits just
 * that row; Esc aborts; Done validates, confirms, and merges into settings.json.
 * Pure helpers (seat naming, settings merge, menu labels) are exported for tests.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_CONFIG, type PanelConfig, type SeatConfig } from "./config.ts";

const SEAT_NAME_CHARSET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Derive a workflow-key-safe seat name from a model id, deduped against taken names. */
export function deriveSeatName(modelId: string, taken: ReadonlySet<string>): string {
	const last = modelId.split("/").pop() ?? modelId;
	let base = last.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "seat";
	let name = base;
	for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
	return name.slice(0, 128).match(SEAT_NAME_CHARSET) ? name.slice(0, 128) : "seat";
}

/** Merge partial panel config into settings.json, preserving every other key (panel and top-level). */
export function writePanelConfig(
	partial: Partial<PanelConfig>,
	settingsPath: string = join(homedir(), ".pi", "agent", "settings.json"),
): void {
	let settings: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
	} catch {
		// missing or invalid file — start fresh
	}
	const panel = (settings.panel && typeof settings.panel === "object" && !Array.isArray(settings.panel)
		? { ...(settings.panel as Record<string, unknown>) }
		: {});
	for (const [key, value] of Object.entries(partial)) {
		if (value !== undefined) panel[key] = value;
	}
	settings.panel = panel;
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

interface ModelLike {
	provider: string;
	id: string;
	name?: string;
}

interface ModelRegistryLike {
	getAvailable(): ModelLike[];
	getProviderDisplayName(provider: string): string;
}

const SESSION_MODEL = "Session model (default)";
const DONE = "Done — save";

/** Menu row labels for the flat editor (pure, tested). */
export function menuRows(config: PanelConfig): string[] {
	const seatRows = [0, 1, 2].map((i) => {
		const seat = config.seats[i];
		return seat ? `seat ${i + 1}: ${seat.name} → ${seat.model}` : `seat ${i + 1}: (not set)`;
	});
	return [
		...seatRows,
		`autoCommit: ${config.autoCommit ? "on" : "off"} — commit each fix round`,
		`maxLoopRounds: ${config.maxLoopRounds} — panel→fix cycles before stopping`,
		`maxDeliberationRounds: ${config.maxDeliberationRounds} — vote rounds per contested finding`,
		`implementer: ${config.implementer ?? "session model"}`,
		`fixer: ${config.fixer ?? "session model"}`,
		DONE,
	];
}

/** Provider → model picker over auth-configured models. Returns "provider/id", null for session default, or undefined on abort. */
async function pickModel(
	ctx: ExtensionCommandContext,
	registry: ModelRegistryLike,
	title: string,
	exclude: ReadonlySet<string>,
	allowSessionDefault = false,
): Promise<string | null | undefined> {
	const models = registry.getAvailable().filter((m) => !exclude.has(`${m.provider}/${m.id}`));
	const providers = [...new Set(models.map((m) => m.provider))];
	const providerLabel = await ctx.ui.select(
		`${title} — pick a provider`,
		providers.map((p) => registry.getProviderDisplayName(p)),
	);
	if (providerLabel === undefined) return undefined;
	const provider = providers[providers.findIndex((p) => registry.getProviderDisplayName(p) === providerLabel)];

	const providerModels = models.filter((m) => m.provider === provider);
	const options = providerModels.map((m) => `${m.id}${m.name && m.name !== m.id ? ` — ${m.name}` : ""}`);
	const shown = allowSessionDefault ? [SESSION_MODEL, ...options] : options;
	const modelLabel = await ctx.ui.select(`${title} — pick a model (${providerLabel})`, shown);
	if (modelLabel === undefined) return undefined;
	if (modelLabel === SESSION_MODEL) return null;
	// Exact match on the option string — a prefix match would resolve
	// "gpt-5.6-sol — …" to "gpt-5" when gpt-5 sorts earlier in the list.
	const index = options.indexOf(modelLabel);
	const model = index >= 0 ? providerModels[index] : undefined;
	return model ? `${model.provider}/${model.id}` : undefined;
}

async function pickPositiveInt(ctx: ExtensionCommandContext, title: string, current: number): Promise<number | undefined> {
	const raw = await ctx.ui.input(title, String(current));
	if (raw === undefined) return undefined;
	const n = Number(raw.trim());
	if (!Number.isInteger(n) || n < 1) {
		ctx.ui.notify(`"${raw}" is not a positive integer — keeping ${current}.`, "warning");
		return undefined;
	}
	return n;
}

function summarize(config: PanelConfig): string {
	return [
		...config.seats.map((s, i) => `  seat ${i + 1}: ${s.name} → ${s.model}`),
		`  autoCommit: ${config.autoCommit} · maxLoopRounds: ${config.maxLoopRounds} · maxDeliberationRounds: ${config.maxDeliberationRounds}`,
		`  implementer: ${config.implementer ?? "session model"} · fixer: ${config.fixer ?? "session model"}`,
	].join("\n");
}

/**
 * The flat settings editor. Edits `current` in place across menu iterations;
 * on Done: validates, runs the diversity guardrail, confirms, writes.
 * Returns the saved seats, or null if aborted.
 */
export async function runPanelEditor(
	ctx: ExtensionCommandContext,
	registry: ModelRegistryLike,
	current: PanelConfig,
	settingsPath?: string,
): Promise<SeatConfig[] | null> {
	const models = registry.getAvailable();
	if (models.length === 0) {
		ctx.ui.notify("No models available — configure provider auth first (pi /login or models.json).", "error");
		return null;
	}

	const config: PanelConfig = { ...current, seats: current.seats.map((s) => ({ ...s })) };

	for (;;) {
		const choice = await ctx.ui.select("pi-panel settings (Enter to edit, Esc to cancel)", menuRows(config));
		if (choice === undefined) return null; // Esc
		if (choice === DONE) break;

		if (choice.startsWith("seat ")) {
			const seatIndex = Number(choice.slice(5, 6)) - 1;
			const otherModels = new Set(config.seats.filter((_, i) => i !== seatIndex).map((s) => s.model));
			const modelId = await pickModel(ctx, registry, `Panel seat ${seatIndex + 1}`, otherModels);
			if (modelId === undefined || modelId === null) continue; // aborted picker — back to menu
			const otherNames = new Set(config.seats.filter((_, i) => i !== seatIndex).map((s) => s.name));
			config.seats[seatIndex] = { name: deriveSeatName(modelId, otherNames), model: modelId };
		} else if (choice.startsWith("autoCommit")) {
			config.autoCommit = !config.autoCommit;
		} else if (choice.startsWith("maxLoopRounds")) {
			const n = await pickPositiveInt(ctx, "Max loop rounds", config.maxLoopRounds);
			if (n !== undefined) config.maxLoopRounds = n;
		} else if (choice.startsWith("maxDeliberationRounds")) {
			const n = await pickPositiveInt(ctx, "Max deliberation rounds", config.maxDeliberationRounds);
			if (n !== undefined) config.maxDeliberationRounds = n;
		} else if (choice.startsWith("implementer") || choice.startsWith("fixer")) {
			const role = choice.startsWith("implementer") ? "implementer" : "fixer";
			const seatModels = new Set(config.seats.map((s) => s.model));
			const model = await pickModel(ctx, registry, `${role} model`, seatModels, true);
			if (model !== undefined) config[role] = model; // null = session model
		}
	}

	if (config.seats.length !== 3) {
		ctx.ui.notify(`Panel needs exactly 3 seats (currently ${config.seats.length}). Set all three seat rows before saving.`, "warning");
		return null;
	}

	// Diversity guardrail: majority vote across one lab's models is fake diversity.
	const distinctProviders = new Set(config.seats.map((s) => s.model.split("/")[0])).size;
	if (distinctProviders === 1) {
		const proceed = await ctx.ui.confirm(
			"Single-provider panel",
			"All 3 seats use the same provider — correlated training data weakens the majority vote. Keep anyway?",
		);
		if (!proceed) return null;
	}

	// "Done — save" is the confirmation; no redundant dialog after it.
	writePanelConfig(config, settingsPath);
	ctx.ui.notify(`Panel saved:\n${summarize(config)}`, "info");
	return config.seats;
}

/**
 * First-use entry point (unconfigured panel): the same flat editor, seeded
 * with defaults and no seats. Returns the saved seats, or null if aborted.
 */
export async function runPanelSetup(
	ctx: ExtensionCommandContext,
	registry: ModelRegistryLike,
	settingsPath?: string,
): Promise<SeatConfig[] | null> {
	return runPanelEditor(ctx, registry, { ...DEFAULT_CONFIG, seats: [] }, settingsPath);
}
