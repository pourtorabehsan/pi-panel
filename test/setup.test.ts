import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { deriveSeatName, runPanelEditor, runPanelSetup, writePanelConfig } from "../src/setup.ts";

const DEFAULT_CONFIG_SAFE = DEFAULT_CONFIG;

test("deriveSeatName: last path segment, charset-safe, deduped", () => {
	const taken = new Set<string>();
	assert.equal(deriveSeatName("fireworks/accounts/fireworks/models/kimi-k3", taken), "kimi-k3");
	taken.add("kimi-k3");
	assert.equal(deriveSeatName("other/kimi-k3", taken), "kimi-k3-2");
	assert.equal(deriveSeatName("openai/gpt-5.6-sol", new Set()), "gpt-5.6-sol");
	// leading non-alphanumerics stripped; weird chars replaced
	assert.match(deriveSeatName("p/--weird model!", new Set()), /^weird-model-$/);
});

test("writePanelConfig: preserves unrelated keys and other panel config", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-panel-setup-"));
	const path = join(dir, "settings.json");
	writeFileSync(path, JSON.stringify({
		theme: "dark",
		packages: ["npm:pi-subagents"],
		panel: { maxLoopRounds: 4 },
	}));
	writePanelConfig({ seats: [{ name: "a", model: "p1/m1" }, { name: "b", model: "p2/m2" }, { name: "c", model: "p3/m3" }] }, path);
	const written = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(written.theme, "dark");
	assert.deepEqual(written.packages, ["npm:pi-subagents"]);
	assert.equal(written.panel.maxLoopRounds, 4);
	assert.equal(written.panel.seats.length, 3);
	assert.equal(written.panel.seats[0].model, "p1/m1");
});

test("writePanelConfig: works on a missing file", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-panel-setup-"));
	const path = join(dir, "settings.json");
	writePanelConfig({ seats: [{ name: "a", model: "p1/m1" }, { name: "b", model: "p2/m2" }, { name: "c", model: "p3/m3" }] }, path);
	const written = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(written.panel.seats.length, 3);
});

test("writePanelConfig: merges advanced keys without touching seats", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-panel-setup-"));
	const path = join(dir, "settings.json");
	writeFileSync(path, JSON.stringify({ panel: { seats: [{ name: "x", model: "m" }] } }));
	writePanelConfig({ autoCommit: false, maxLoopRounds: 3, fixer: "openai/gpt-5.6-sol" }, path);
	const written = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(written.panel.seats[0].name, "x"); // preserved
	assert.equal(written.panel.autoCommit, false);
	assert.equal(written.panel.maxLoopRounds, 3);
	assert.equal(written.panel.fixer, "openai/gpt-5.6-sol");
	// null (session default) is a real value, undefined keys are skipped
	writePanelConfig({ fixer: null, implementer: undefined }, path);
	const again = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(again.panel.fixer, null);
	assert.equal("implementer" in again.panel, false);
});

test("runPanelSetup: prefix-colliding model ids resolve exactly (gpt-5.6-sol, not gpt-5)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-panel-setup-"));
	const path = join(dir, "settings.json");
	writeFileSync(path, "{}");
	const registry = {
		getAvailable: () => [
			{ provider: "openai", id: "gpt-5" }, // sorts before, is a prefix of the pick
			{ provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
			{ provider: "fireworks", id: "kimi-k3" },
			{ provider: "zai", id: "glm-5p2" },
		],
		getProviderDisplayName: (p: string) => p,
	};
	const selects = [
		"seat 1: (not set)", "fireworks", "kimi-k3",
		"seat 2: (not set)", "zai", "glm-5p2",
		"seat 3: (not set)", "openai", "gpt-5.6-sol — GPT-5.6 Sol",
		"Done — save",
	];
	const confirms = [true]; // final confirm (diversity not triggered: 3 providers)
	const ctx = {
		ui: {
			select: async () => selects.shift(),
			confirm: async () => confirms.shift() ?? true,
			input: async () => undefined,
			notify: () => {},
		},
	};
	const seats = await runPanelSetup(ctx as never, registry, path);
	assert.ok(seats);
	assert.equal(seats![2].model, "openai/gpt-5.6-sol"); // NOT openai/gpt-5
	const written = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(written.panel.seats[2].model, "openai/gpt-5.6-sol");
});

test("menuRows: flat list with live values and unset seats", async () => {
	const { menuRows } = await import("../src/setup.ts");
	const rows = menuRows({ ...DEFAULT_CONFIG_SAFE, seats: [{ name: "kimi-k3", model: "f/kimi-k3" }] });
	assert.equal(rows[0], "seat 1: kimi-k3 → f/kimi-k3");
	assert.equal(rows[1], "seat 2: (not set)");
	assert.equal(rows[rows.length - 1], "Done — save");
	assert.ok(rows.some((r) => r.startsWith("autoCommit:")));
});

test("runPanelEditor: editing only seat 3 keeps seats 1-2 and other settings", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-panel-setup-"));
	const path = join(dir, "settings.json");
	writeFileSync(path, JSON.stringify({ panel: { maxLoopRounds: 4 } }));
	const current = {
		...DEFAULT_CONFIG_SAFE,
		maxLoopRounds: 4, // as loadConfig would have merged from settings
		seats: [
			{ name: "kimi-k3", model: "fireworks/kimi-k3" },
			{ name: "glm-5p2", model: "zai/glm-5p2" },
			{ name: "gpt-5", model: "openai/gpt-5" },
		],
	};
	const registry = {
		getAvailable: () => [
			{ provider: "openai", id: "gpt-5" },
			{ provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
		],
		getProviderDisplayName: (p: string) => p,
	};
	const selects = ["seat 3: gpt-5 → openai/gpt-5", "openai", "gpt-5.6-sol — GPT-5.6 Sol", "Done — save"];
	const ctx = {
		ui: {
			select: async () => selects.shift(),
			confirm: async () => true,
			input: async () => undefined,
			notify: () => {},
		},
	};
	const seats = await runPanelEditor(ctx as never, registry, current as never, path);
	assert.ok(seats);
	assert.deepEqual(seats!.map((s) => s.model), ["fireworks/kimi-k3", "zai/glm-5p2", "openai/gpt-5.6-sol"]);
	assert.equal(seats![2].name, "gpt-5.6-sol"); // re-derived from new model
	const written = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(written.panel.maxLoopRounds, 4); // untouched setting preserved
	assert.equal(written.panel.seats[1].model, "zai/glm-5p2");
});
