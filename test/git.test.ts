import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitError, currentHead, isDirty, isPanelCommit, repoSlug, resolveTarget, tryResolveTarget } from "../src/git.ts";

function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-panel-git-"));
	const g = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
	g(["init", "-b", "main"]);
	g(["config", "user.email", "panel@test"]);
	g(["config", "user.name", "panel"]);
	writeFileSync(join(dir, "a.txt"), "one\n");
	g(["add", "a.txt"]);
	g(["commit", "-m", "initial"]);
	return dir;
}

test("resolveTarget: working tree diff", () => {
	const dir = initRepo();
	assert.equal(isDirty(dir), false);
	writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
	assert.equal(isDirty(dir), true);
	const target = resolveTarget("", dir);
	assert.match(target.description, /uncommitted changes/);
	assert.match(target.diffText, /\+two/);
});

test("resolveTarget: empty diff errors", () => {
	const dir = initRepo();
	assert.throws(() => resolveTarget("", dir), /Nothing to review/);
});

test("resolveTarget: commit sha", () => {
	const dir = initRepo();
	const sha = currentHead(dir);
	const target = resolveTarget(sha, dir);
	assert.match(target.description, new RegExp(`commit ${sha}`));
	assert.match(target.diffText, /\+one/);
});

test("resolveTarget: branch diff", () => {
	const dir = initRepo();
	const g = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
	g(["checkout", "-b", "feature"]);
	writeFileSync(join(dir, "b.txt"), "new\n");
	g(["add", "b.txt"]);
	g(["commit", "-m", "feature work"]);
	const target = resolveTarget("main", dir);
	assert.match(target.description, /vs main/);
	assert.match(target.diffText, /\+new/);
});

test("resolveTarget: current branch and unknown targets error", () => {
	const dir = initRepo();
	assert.throws(() => resolveTarget("main", dir), GitError); // main IS the current branch
	assert.throws(() => resolveTarget("does-not-exist", dir), /Unknown review target/);
});

test("resolveTarget: not a git repo", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-panel-nogit-"));
	assert.throws(() => resolveTarget("", dir), /Not a git repository/);
});

test("tryResolveTarget: null for unknown args, target for branches", () => {
	const dir = initRepo();
	assert.equal(tryResolveTarget("definitely-not-a-branch-xyz", dir), null);
	const g = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
	g(["checkout", "-b", "feature"]);
	writeFileSync(join(dir, "b.txt"), "new\n");
	g(["add", "b.txt"]);
	g(["commit", "-m", "feature work"]);
	const target = tryResolveTarget("main", dir);
	assert.ok(target);
	assert.match(target!.description, /vs main/);
});

test("repoSlug: readable basename + hash, stable per path", () => {
	const dir = initRepo();
	const slug = repoSlug(dir);
	assert.match(slug, /^pi-panel-git-[A-Za-z0-9]+-[a-z0-9]+$/);
	assert.equal(slug, repoSlug(dir)); // stable
});

test("isPanelCommit: trailer style, legacy prefix, and plain commits", () => {
	const dir = initRepo();
	const g = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
	writeFileSync(join(dir, "c.txt"), "1\n");
	g(["add", "c.txt"]);
	g(["commit", "-m", "feat: human subject", "-m", "Panel-Loop: round 1"]);
	assert.equal(isPanelCommit(dir, "HEAD"), true);
	writeFileSync(join(dir, "c.txt"), "2\n");
	g(["add", "c.txt"]);
	g(["commit", "-m", "panel-loop: round 2 fixes (legacy)"]);
	assert.equal(isPanelCommit(dir, "HEAD"), true);
	writeFileSync(join(dir, "c.txt"), "3\n");
	g(["add", "c.txt"]);
	g(["commit", "-m", "unrelated human commit"]);
	assert.equal(isPanelCommit(dir, "HEAD"), false);
});
