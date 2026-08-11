import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveSeatName, writeSeatsToSettings } from "../src/setup.ts";

test("deriveSeatName: last path segment, charset-safe, deduped", () => {
	const taken = new Set<string>();
	assert.equal(deriveSeatName("fireworks/accounts/fireworks/models/kimi-k3", taken), "kimi-k3");
	taken.add("kimi-k3");
	assert.equal(deriveSeatName("other/kimi-k3", taken), "kimi-k3-2");
	assert.equal(deriveSeatName("openai/gpt-5.6-sol", new Set()), "gpt-5.6-sol");
	// leading non-alphanumerics stripped; weird chars replaced
	assert.match(deriveSeatName("p/--weird model!", new Set()), /^weird-model-$/);
});

test("writeSeatsToSettings: preserves unrelated keys and other panel config", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-panel-setup-"));
	const path = join(dir, "settings.json");
	writeFileSync(path, JSON.stringify({
		theme: "dark",
		packages: ["npm:pi-subagents"],
		panel: { maxLoopRounds: 4 },
	}));
	writeSeatsToSettings([{ name: "a", model: "p1/m1" }, { name: "b", model: "p2/m2" }, { name: "c", model: "p3/m3" }], path);
	const written = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(written.theme, "dark");
	assert.deepEqual(written.packages, ["npm:pi-subagents"]);
	assert.equal(written.panel.maxLoopRounds, 4);
	assert.equal(written.panel.seats.length, 3);
	assert.equal(written.panel.seats[0].model, "p1/m1");
});

test("writeSeatsToSettings: works on a missing file", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-panel-setup-"));
	const path = join(dir, "settings.json");
	writeSeatsToSettings([{ name: "a", model: "p1/m1" }, { name: "b", model: "p2/m2" }, { name: "c", model: "p3/m3" }], path);
	const written = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(written.panel.seats.length, 3);
});
