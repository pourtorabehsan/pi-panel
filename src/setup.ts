/**
 * /panel-setup — interactive panel onboarding (TUI).
 * Tier 1 (required): pick 3 seats from the user's actually-available models.
 * Tier 2 (one confirm away): advanced knobs — autoCommit, loop/deliberation
 * caps, implementer/fixer models. artifactDir/maxDiffLines stay settings-only.
 * Confirms the final config, then merges it into settings.json (panel key).
 * Pure helpers (seat naming, settings merge) are exported for tests.
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

/** Tier 2: advanced knobs loop. Mutates and returns the overrides object (exported via runAdvancedSetupOnly). */
async function runAdvancedSetup(
	ctx: ExtensionCommandContext,
	registry: ModelRegistryLike,
	overrides: Partial<PanelConfig>,
	seatModels: ReadonlySet<string>,
): Promise<void> {
	for (;;) {
		const current = { ...DEFAULT_CONFIG, ...overrides };
		const choice = await ctx.ui.select("Advanced settings (Esc when done)", [
			`autoCommit: ${current.autoCommit ? "on" : "off"} — commit each fix round`,
			`maxLoopRounds: ${current.maxLoopRounds} — panel→fix cycles before stopping`,
			`maxDeliberationRounds: ${current.maxDeliberationRounds} — vote rounds per contested finding`,
			`implementer: ${current.implementer ?? "session model"}`,
			`fixer: ${current.fixer ?? "session model"}`,
			"Done",
		]);
		if (choice === undefined || choice === "Done") return;

		if (choice.startsWith("autoCommit")) {
			overrides.autoCommit = !current.autoCommit;
		} else if (choice.startsWith("maxLoopRounds")) {
			const n = await pickPositiveInt(ctx, "Max loop rounds", current.maxLoopRounds);
			if (n !== undefined) overrides.maxLoopRounds = n;
		} else if (choice.startsWith("maxDeliberationRounds")) {
			const n = await pickPositiveInt(ctx, "Max deliberation rounds", current.maxDeliberationRounds);
			if (n !== undefined) overrides.maxDeliberationRounds = n;
		} else {
			const role = choice.startsWith("implementer") ? "implementer" : "fixer";
			const model = await pickModel(ctx, registry, `${role} model`, seatModels, true);
			if (model !== undefined) overrides[role] = model; // null = session model
		}
	}
}

/**
 * Advanced-only path for an already-configured panel: edit the knobs without
 * re-picking seats. Seeds from the current config so displayed values are
 * real, and writes the merged result. Returns true if settings were written.
 */
export async function runAdvancedSetupOnly(
	ctx: ExtensionCommandContext,
	registry: ModelRegistryLike,
	current: PanelConfig,
	settingsPath?: string,
): Promise<boolean> {
	const overrides: Partial<PanelConfig> = {
		autoCommit: current.autoCommit,
		maxLoopRounds: current.maxLoopRounds,
		maxDeliberationRounds: current.maxDeliberationRounds,
		implementer: current.implementer,
		fixer: current.fixer,
	};
	await runAdvancedSetup(ctx, registry, overrides, new Set(current.seats.map((s) => s.model)));
	const summary = [
		`  seats: ${current.seats.map((s) => s.name).join(", ")} (unchanged)`,
		`  autoCommit: ${overrides.autoCommit} · maxLoopRounds: ${overrides.maxLoopRounds} · maxDeliberationRounds: ${overrides.maxDeliberationRounds}`,
		`  implementer: ${overrides.implementer ?? "session model"} · fixer: ${overrides.fixer ?? "session model"}`,
	].join("\n");
	const confirmed = await ctx.ui.confirm("Confirm panel settings", `New configuration:\n${summary}\n\nWritten to settings.json under panel.`);
	if (!confirmed) return false;
	writePanelConfig(overrides, settingsPath);
	ctx.ui.notify(`Panel settings saved:\n${summary}`, "info");
	return true;
}

/**
 * Interactive setup. Returns the chosen seats, or null if aborted.
 * Requires TUI (caller checks ctx.hasUI / ctx.mode).
 */
export async function runPanelSetup(
	ctx: ExtensionCommandContext,
	registry: ModelRegistryLike,
	settingsPath?: string,
): Promise<SeatConfig[] | null> {
	const models = registry.getAvailable();
	if (models.length === 0) {
		ctx.ui.notify("No models available — configure provider auth first (pi /login or models.json).", "error");
		return null;
	}

	// Tier 1: the three seats.
	const seats: SeatConfig[] = [];
	const takenNames = new Set<string>();
	const takenModels = new Set<string>();
	for (let seatIndex = 0; seatIndex < 3; seatIndex++) {
		const modelId = await pickModel(ctx, registry, `Panel seat ${seatIndex + 1} of 3`, takenModels);
		if (modelId === undefined || modelId === null) return null; // aborted
		takenModels.add(modelId);
		const name = deriveSeatName(modelId, takenNames);
		takenNames.add(name);
		seats.push({ name, model: modelId });
	}

	// Diversity guardrail: majority vote across one lab's models is fake diversity.
	const distinctProviders = new Set(seats.map((s) => s.model.split("/")[0])).size;
	if (distinctProviders === 1) {
		const proceed = await ctx.ui.confirm(
			"Single-provider panel",
			"All 3 seats use the same provider — correlated training data weakens the majority vote. Keep anyway?",
		);
		if (!proceed) return null;
	}

	// Tier 2: optional advanced knobs.
	const overrides: Partial<PanelConfig> = {};
	const advanced = await ctx.ui.confirm(
		"Advanced settings?",
		"Defaults are sensible (autoCommit on, 2 loop rounds, 2 deliberation rounds, session model implements/fixes). Customize?",
	);
	if (advanced) await runAdvancedSetup(ctx, registry, overrides, takenModels);

	const finalConfig = { ...DEFAULT_CONFIG, ...overrides, seats };
	const summary = [
		...seats.map((s, i) => `  seat ${i + 1}: ${s.name} → ${s.model}`),
		`  autoCommit: ${finalConfig.autoCommit} · maxLoopRounds: ${finalConfig.maxLoopRounds} · maxDeliberationRounds: ${finalConfig.maxDeliberationRounds}`,
		`  implementer: ${finalConfig.implementer ?? "session model"} · fixer: ${finalConfig.fixer ?? "session model"}`,
	].join("\n");
	const confirmed = await ctx.ui.confirm(
		"Confirm panel",
		`Panel configuration:\n${summary}\n\nWritten to settings.json under panel. Re-run /panel-setup anytime to change.`,
	);
	if (!confirmed) return null;

	writePanelConfig({ seats, ...overrides }, settingsPath);
	ctx.ui.notify(`Panel saved:\n${summary}`, "info");
	return seats;
}
