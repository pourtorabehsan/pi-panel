/**
 * Git helpers: target resolution, diff capture, commit inspection.
 * All via execFileSync — deterministic, no shell interpolation.
 */
import { execFileSync } from "node:child_process";

export class GitError extends Error {
	readonly detail?: string;

	constructor(message: string, detail?: string) {
		super(detail ? `${message}\n${detail}` : message);
		this.name = "GitError";
		this.detail = detail;
	}
}

export function git(args: string[], cwd: string): string {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch (error) {
		const err = error as { stderr?: Buffer | string; message?: string };
		const detail = err.stderr ? String(err.stderr).trim() : err.message;
		throw new GitError(`git ${args.join(" ")} failed`, detail);
	}
}

export function assertGitRepo(cwd: string): void {
	try {
		git(["rev-parse", "--git-dir"], cwd);
	} catch (error) {
		if (error instanceof GitError) throw new GitError("Not a git repository.", error.detail);
		throw error;
	}
}

/**
 * Dirty check excluding tooling-owned dirs (the panel's artifactDir gets
 * created before this check runs, and .pi-subagents fills up as soon as any
 * subagent runs). Without exclusions, leftover artifacts falsely read as
 * "uncommitted user changes".
 */
export function isDirty(cwd: string, excludePaths: string[] = []): boolean {
	if (excludePaths.length === 0) return git(["status", "--porcelain"], cwd).length > 0;
	const pathspec = ["--", ".", ...excludePaths.map((p) => `:(exclude)${p}`)];
	return git(["status", "--porcelain", ...pathspec], cwd).length > 0;
}

/**
 * HEAD + porcelain status: any worktree/index/HEAD change alters the fingerprint.
 * excludePaths are git pathspecs for tooling-owned dirs that change during a run
 * (the panel's own artifactDir, pi-subagents' .pi-subagents async dirs).
 */
export function worktreeFingerprint(cwd: string, excludePaths: string[] = []): string {
	const pathspec = ["--", ".", ...excludePaths.map((p) => `:(exclude)${p}`)];
	return `${currentHead(cwd)}\n${git(["status", "--porcelain", ...pathspec], cwd)}`;
}

export function currentHead(cwd: string): string {
	return git(["rev-parse", "HEAD"], cwd);
}

export function currentBranch(cwd: string): string | null {
	try {
		return git(["symbolic-ref", "--short", "HEAD"], cwd) || null;
	} catch {
		return null; // detached HEAD
	}
}

export function commitMessage(cwd: string, sha: string): string {
	return git(["log", "-1", "--format=%s", sha], cwd);
}

export interface ResolvedTarget {
	description: string;
	diffText: string;
	commands: string[];
}

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

function requireNonEmpty(diff: string, what: string): string {
	if (!diff.trim()) throw new GitError(`Nothing to review: ${what} produced an empty diff.`);
	return diff;
}

function isPrTarget(arg: string): boolean {
	return /^\d+$/.test(arg) || arg.includes("github.com") || arg.includes("pull");
}

function gh(args: string[], cwd: string): string {
	try {
		return execFileSync("gh", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch (error) {
		const err = error as { stderr?: Buffer | string; message?: string };
		const detail = err.stderr ? String(err.stderr).trim() : err.message;
		throw new GitError(`gh ${args.join(" ")} failed (is the GitHub CLI installed and authenticated?)`, detail);
	}
}

/** Resolve a /panel-review target per spec §2. Throws GitError on failure. */
export function resolveTarget(args: string, cwd: string): ResolvedTarget {
	const arg = args.trim();
	assertGitRepo(cwd);

	if (!arg) {
		const diff = git(["diff", "HEAD"], cwd);
		return { description: "uncommitted changes in the working tree (git diff HEAD)", diffText: requireNonEmpty(diff, "git diff HEAD"), commands: ["git diff HEAD"] };
	}

	if (SHA_PATTERN.test(arg)) {
		const diff = git(["show", arg], cwd);
		const subject = commitMessage(cwd, arg);
		return { description: `commit ${arg} (${subject})`, diffText: requireNonEmpty(diff, `git show ${arg}`), commands: [`git show ${arg}`] };
	}

	// branch name (spec §2 order: branch before PR): must resolve and not be HEAD's own branch
	let resolves = true;
	try {
		git(["rev-parse", "--verify", `${arg}^{commit}`], cwd);
	} catch {
		resolves = false;
	}
	if (resolves) {
		const branch = currentBranch(cwd);
		if (branch && branch === arg) {
			throw new GitError(`Review target "${arg}" is the current branch; use no arguments to review uncommitted changes, or a base branch to compare against.`);
		}
		const diff = git(["diff", `${arg}...HEAD`], cwd);
		return { description: `changes on current branch vs ${arg} (git diff ${arg}...HEAD)`, diffText: requireNonEmpty(diff, `git diff ${arg}...HEAD`), commands: [`git diff ${arg}...HEAD`] };
	}

	if (isPrTarget(arg)) {
		const view = gh(["pr", "view", arg, "--json", "number,title,url"], cwd);
		let label = `PR ${arg}`;
		try {
			const parsed = JSON.parse(view) as { number?: number; title?: string; url?: string };
			label = `PR #${parsed.number ?? arg}: ${parsed.title ?? ""} (${parsed.url ?? ""})`.trim();
		} catch {
			// keep raw label
		}
		const diff = gh(["pr", "diff", arg], cwd);
		return { description: label, diffText: requireNonEmpty(diff, `gh pr diff ${arg}`), commands: [`gh pr view ${arg}`, `gh pr diff ${arg}`] };
	}

	throw new GitError(`Unknown review target "${arg}": not a commit SHA, branch, or PR reference.`);
}
