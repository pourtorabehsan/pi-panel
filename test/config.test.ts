import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigError, DEFAULT_CONFIG, loadConfig, validateConfig } from "../src/config.ts";

test("defaults when settings file is missing", () => {
	const { config, warnings } = loadConfig(join(tmpdir(), "pi-panel-test-nonexistent", "settings.json"));
	assert.deepEqual(config, DEFAULT_CONFIG);
	assert.equal(config.seats.length, 3);
	assert.deepEqual(warnings, []);
});

function withSettings(value: unknown, fn: (path: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "pi-panel-config-"));
	const path = join(dir, "settings.json");
	writeFileSync(path, JSON.stringify(value));
	fn(path);
}

test("user settings merge over defaults", () => {
	withSettings({ panel: { maxLoopRounds: 4, autoCommit: false, artifactDir: ".panel-runs" } }, (path) => {
		const { config } = loadConfig(path);
		assert.equal(config.maxLoopRounds, 4);
		assert.equal(config.autoCommit, false);
		assert.equal(config.artifactDir, ".panel-runs");
		// seats untouched
		assert.equal(config.seats[0].name, "kimi");
	});
});

test("custom seats replace defaults", () => {
	withSettings(
		{ panel: { seats: [
			{ name: "a", model: "p1/m1" },
			{ name: "b", model: "p2/m2" },
			{ name: "c", model: "p3/m3" },
		] } },
		(path) => {
			const { config } = loadConfig(path);
			assert.deepEqual(config.seats.map((s) => s.name), ["a", "b", "c"]);
		},
	);
});

test("invalid seat counts and duplicate models are config errors", () => {
	assert.ok(validateConfig({ ...DEFAULT_CONFIG, seats: DEFAULT_CONFIG.seats.slice(0, 2) }).some((p) => p.includes("exactly 3")));
	const dup = validateConfig({
		...DEFAULT_CONFIG,
		seats: [
			{ name: "a", model: "m" },
			{ name: "b", model: "m" },
			{ name: "c", model: "x" },
		],
	});
	assert.ok(dup.some((p) => p.includes("duplicate seat model")));

	const badName = validateConfig({
		...DEFAULT_CONFIG,
		seats: [
			{ name: "my seat", model: "m1" },
			{ name: "b", model: "m2" },
			{ name: "c", model: "m3" },
		],
	});
	assert.ok(badName.some((p) => p.includes("workflow key")));

	withSettings({ panel: { seats: [{ name: "a", model: "m" }] } }, (path) => {
		assert.throws(() => loadConfig(path), ConfigError);
	});
});

test("fixer/implementer matching a seat model is warned and ignored", () => {
	const seatModel = DEFAULT_CONFIG.seats[1].model;
	withSettings({ panel: { fixer: seatModel, implementer: "other/model" } }, (path) => {
		const { config, warnings } = loadConfig(path);
		assert.equal(config.fixer, null);
		assert.equal(config.implementer, "other/model");
		assert.ok(warnings.some((w) => w.includes("fixer")));
	});
});

test("invalid scalar values fall back with warnings", () => {
	withSettings({ panel: { maxDiffLines: -5, autoCommit: "yes", maxDeliberationRounds: 1.5 } }, (path) => {
		const { config, warnings } = loadConfig(path);
		assert.equal(config.maxDiffLines, DEFAULT_CONFIG.maxDiffLines);
		assert.equal(config.autoCommit, true);
		assert.equal(config.maxDeliberationRounds, DEFAULT_CONFIG.maxDeliberationRounds);
		assert.equal(warnings.length, 3);
	});
});

test("malformed settings JSON falls back to defaults", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-panel-config-"));
	const path = join(dir, "settings.json");
	writeFileSync(path, "{ not json");
	const { config, warnings } = loadConfig(path);
	assert.deepEqual(config, DEFAULT_CONFIG);
	assert.deepEqual(warnings, []);
});
