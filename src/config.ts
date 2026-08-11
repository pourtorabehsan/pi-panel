import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SeatConfig {
	name: string;
	model: string;
	/** Ordered fallback models: a failed seat is retried fresh on each in turn. */
	fallbacks?: string[];
}

export interface PanelConfig {
	/** Empty when unconfigured — commands route to /panel-setup instead of running. */
	seats: SeatConfig[];
	implementer: string | null;
	fixer: string | null;
	maxDeliberationRounds: number;
	maxLoopRounds: number;
	autoCommit: boolean;
	artifactDir: string;
	maxDiffLines: number;
}

export interface LoadedConfig {
	config: PanelConfig;
	warnings: string[];
}

export class ConfigError extends Error {
	readonly problems: string[];

	constructor(problems: string[]) {
		super(`Invalid pi-panel config:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
		this.name = "ConfigError";
		this.problems = problems;
	}
}

export const DEFAULT_CONFIG: PanelConfig = {
	// No default seats by design: model auth is per-user, and a hardcoded panel
	// would fail or, worse, silently run on the wrong models. /panel-setup.
	seats: [],
	implementer: null,
	fixer: null,
	maxDeliberationRounds: 2,
	maxLoopRounds: 2,
	autoCommit: true,
	// Default: OUTSIDE the repo (~/.panel/<repo-slug>/<run-id>) so panel runs
	// never dirty the worktree. A relative value is treated as repo-relative
	// (legacy escape hatch); absolute or ~/ paths are used as the root.
	artifactDir: "~/.panel",
	maxDiffLines: 4000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readSettings(settingsPath: string): Record<string, unknown> {
	let raw: string;
	try {
		raw = readFileSync(settingsPath, "utf8");
	} catch {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function asPositiveInt(value: unknown, fallback: number, warnings: string[], name: string): number {
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
	warnings.push(`panel.${name} must be a positive integer; using default ${fallback}.`);
	return fallback;
}

function asBoolean(value: unknown, fallback: boolean, warnings: string[], name: string): boolean {
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	warnings.push(`panel.${name} must be a boolean; using default ${String(fallback)}.`);
	return fallback;
}

function asNonEmptyString(value: unknown, fallback: string, warnings: string[], name: string): string {
	if (value === undefined) return fallback;
	if (typeof value === "string" && value.trim()) return value.trim();
	warnings.push(`panel.${name} must be a non-empty string; using default "${fallback}".`);
	return fallback;
}

/** Expand a leading ~/; result may still be relative (repo-relative by design). */
export function expandHome(p: string): string {
	return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function asOptionalModel(value: unknown, warnings: string[], name: string): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "string" && value.trim()) return value.trim();
	warnings.push(`panel.${name} must be a model string or null; ignoring it.`);
	return null;
}

export function loadConfig(settingsPath: string = join(homedir(), ".pi", "agent", "settings.json")): LoadedConfig {
	const warnings: string[] = [];
	const settings = readSettings(settingsPath);
	const raw = settings.panel;

	const config: PanelConfig = {
		seats: [],
		implementer: DEFAULT_CONFIG.implementer,
		fixer: DEFAULT_CONFIG.fixer,
		maxDeliberationRounds: DEFAULT_CONFIG.maxDeliberationRounds,
		maxLoopRounds: DEFAULT_CONFIG.maxLoopRounds,
		autoCommit: DEFAULT_CONFIG.autoCommit,
		artifactDir: DEFAULT_CONFIG.artifactDir,
		maxDiffLines: DEFAULT_CONFIG.maxDiffLines,
	};

	if (raw !== undefined) {
		if (!isRecord(raw)) {
			warnings.push(`panel settings must be an object; ignoring all panel settings.`);
		} else {
			if (raw.seats !== undefined) {
				if (Array.isArray(raw.seats)) {
					const seats: SeatConfig[] = [];
					let seatsValid = true;
					for (const [index, entry] of raw.seats.entries()) {
						if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name.trim()
							|| typeof entry.model !== "string" || !entry.model.trim()) {
							warnings.push(`panel.seats[${index}] must be { name, model } strings; ignoring the whole seats array.`);
							seatsValid = false;
							break;
						}
						let fallbacks: string[] | undefined;
						if (entry.fallbacks !== undefined) {
							if (Array.isArray(entry.fallbacks) && entry.fallbacks.every((f) => typeof f === "string" && f.trim())) {
								fallbacks = (entry.fallbacks as string[]).map((f) => f.trim());
							} else {
								warnings.push(`panel.seats[${index}].fallbacks must be an array of model strings; ignoring it.`);
							}
						}
						seats.push({ name: entry.name.trim(), model: entry.model.trim(), ...(fallbacks ? { fallbacks } : {}) });
					}
					if (seatsValid) config.seats = seats;
				} else {
					warnings.push(`panel.seats must be an array; ignoring it.`);
				}
			}
			config.implementer = asOptionalModel(raw.implementer, warnings, "implementer");
			config.fixer = asOptionalModel(raw.fixer, warnings, "fixer");
			config.maxDeliberationRounds = asPositiveInt(raw.maxDeliberationRounds, DEFAULT_CONFIG.maxDeliberationRounds, warnings, "maxDeliberationRounds");
			config.maxLoopRounds = asPositiveInt(raw.maxLoopRounds, DEFAULT_CONFIG.maxLoopRounds, warnings, "maxLoopRounds");
			config.autoCommit = asBoolean(raw.autoCommit, DEFAULT_CONFIG.autoCommit, warnings, "autoCommit");
			config.artifactDir = asNonEmptyString(raw.artifactDir, DEFAULT_CONFIG.artifactDir, warnings, "artifactDir");
			config.maxDiffLines = asPositiveInt(raw.maxDiffLines, DEFAULT_CONFIG.maxDiffLines, warnings, "maxDiffLines");
		}
	}

	// Empty seats = unconfigured, not invalid: commands route to /panel-setup.
	if (config.seats.length > 0) {
		const problems = validateConfig(config);
		if (problems.length > 0) throw new ConfigError(problems);

		// The fixer/implementer must never be a panel seat (spec §7): warn + ignore.
		for (const role of ["implementer", "fixer"] as const) {
			const model = config[role];
			if (model && config.seats.some((s) => s.model === model)) {
				warnings.push(`panel.${role} ("${model}") matches a panel seat model; ignoring it (the ${role} must never be a panel seat).`);
				config[role] = null;
			}
		}
	}

	return { config, warnings };
}

export function validateConfig(config: PanelConfig): string[] {
	const problems: string[] = [];
	if (config.seats.length !== 3) {
		problems.push(`expected exactly 3 seats, got ${config.seats.length}.`);
	}
	const names = new Set<string>();
	const models = new Set<string>();
	// Seat names become workflow keys (r1-<name>, d1-<name>); pi-subagents
	// enforces this charset at workflow runtime — fail at config time instead.
	const KEY_CHARSET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
	for (const seat of config.seats) {
		if (!KEY_CHARSET.test(seat.name)) problems.push(`seat name "${seat.name}" must match ${KEY_CHARSET.source} (it becomes a workflow key).`);
		if (names.has(seat.name)) problems.push(`duplicate seat name "${seat.name}".`);
		if (models.has(seat.model)) problems.push(`duplicate seat model "${seat.model}" (panel diversity requires distinct models).`);
		names.add(seat.name);
		models.add(seat.model);
		for (const fb of seat.fallbacks ?? []) {
			if (fb === seat.model) problems.push(`seat "${seat.name}" lists its own model as a fallback.`);
		}
	}
	return problems;
}
