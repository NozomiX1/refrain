import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectRoot } from "../core/project.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...args], { cwd, stdio: "ignore" });

function repo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

// Tests live under the temp dir, which the real rule excludes; exclude nothing here instead.
const none = { home: "/nonexistent-home", temps: [] };

test("git repos map to the main worktree root; submodules are their own project", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "refrain-proj-")));
  const main = repo(join(base, "main"));
  mkdirSync(join(main, "sub", "deep"), { recursive: true });
  assert.equal(projectRoot(main, none), main);
  assert.equal(projectRoot(join(main, "sub", "deep"), none), main, "a subdirectory is the same project");

  git(main, "worktree", "add", "-q", join(base, "wt"));
  assert.equal(projectRoot(join(base, "wt"), none), main, "a linked worktree is the main project");

  const lib = repo(join(base, "lib"));
  git(main, "submodule", "add", "-q", lib, "vendor/lib");
  assert.equal(projectRoot(join(main, "vendor", "lib"), none), join(main, "vendor", "lib"));

  const plain = join(base, "plain");
  mkdirSync(plain);
  assert.equal(projectRoot(plain, none), plain, "outside git, the start directory itself");
});

test("home and temp directories belong to no project", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "refrain-proj-")));
  assert.equal(projectRoot(base, { home: base, temps: [] }), null);
  mkdirSync(join(base, "x"));
  assert.equal(projectRoot(join(base, "x"), { home: "/nonexistent-home", temps: [base] }), null);
  assert.equal(projectRoot(join(base, "x"), { home: base, temps: [] }), join(base, "x"), "below home is fine");
});
