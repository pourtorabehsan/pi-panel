/**
 * /panel-setup — interactive panel onboarding (TUI).
 * Picks 3 seats from the user's actually-available models (auth-configured),
 * confirms the final config, and writes panel.seats into settings.json.
 * Pure helpers (seat naming, settings merge) are exported for tests.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SeatConfig } from "./config.ts";

const SEAT_NAME_CHARSET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Derive a workflow-key-safe seat name from a model id, deduped against taken names. */
export function deriveSeatName(modelId: string, taken: ReadonlySet<string>): string {
	const last = modelId.split("/").pop() ?? modelId;
	let base = last.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "seat";
	let name = base;
	for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
	return name.slice(0, 128).match(SEAT_NAME_CHARSET) ? name.slice(0, 128) : "seat";
}

/** Merge seats into settings.json under panel.seats, preserving every other key. */
export function writeSeatsToSettings(seats: SeatConfig[], settingsPath: string = join(homedir(), ".pi", "agent", "settings.json")): void {
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
	panel.seats = seats;
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

/**
 * Interactive seat picker. Returns the chosen seats, or null if aborted.
 * Throws on non-interactive contexts (caller checks ctx.hasUI / ctx.mode).
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

	const providers = [...new Set(models.map((m) => m.provider))];
	const seats: SeatConfig[] = [];
	const takenNames = new Set<string>();
	const takenModels = new Set<string>();

	for (let seatIndex = 0; seatIndex < 3; seatIndex++) {
		const providerLabel = await ctx.ui.select(
			`Panel seat ${seatIndex + 1} of 3 — pick a provider`,
			providers.map((p) => registry.getProviderDisplayName(p)),
		);
		if (providerLabel === undefined) return null; // aborted
		const provider = providers[providers.findIndex((p) => registry.getProviderDisplayName(p) === providerLabel)];

		const providerModels = models.filter((m) => m.provider === provider && !takenModels.has(`${m.provider}/${m.id}`));
		const modelLabel = await ctx.ui.select(
			`Panel seat ${seatIndex + 1} of 3 — pick a model (${providerLabel})`,
			providerModels.map((m) => `${m.id}${m.name && m.name !== m.id ? ` — ${m.name}` : ""}`),
		);
		if (modelLabel === undefined) return null;
		const model = providerModels.find((m) => modelLabel.startsWith(m.id));
		if (!model) return null;

		const modelId = `${model.provider}/${model.id}`;
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

	const summary = seats.map((s, i) => `  seat ${i + 1}: ${s.name} → ${s.model}`).join("\n");
	const confirmed = await ctx.ui.confirm(
		"Confirm panel",
		`Panel configuration:\n${summary}\n\nWritten to settings.json under panel.seats. Re-run /panel-setup anytime to change.`,
	);
	if (!confirmed) return null;

	writeSeatsToSettings(seats, settingsPath);
	ctx.ui.notify(`Panel saved:\n${summary}`, "info");
	return seats;
}
