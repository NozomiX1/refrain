// Which project a session belongs to (design.md 6.1).
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, sep } from "node:path";

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

export function defaultExcluded(): { home: string; temps: string[] } {
  const temps = ["/tmp", "/private/tmp", tmpdir(), process.env.TMPDIR].filter((p): p is string => !!p).map((p) => real(p).replace(/\/$/, ""));
  return { home: real(homedir()), temps };
}

// Returns the project's canonical path, or null when the session belongs to no project.
export function projectRoot(cwd: string, excluded = defaultExcluded()): string | null {
  const dir = real(cwd);
  if (dir === excluded.home || excluded.temps.some((t) => dir === t || dir.startsWith(t + sep))) return null;
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let top: string;
  try {
    top = git("rev-parse", "--show-toplevel");
  } catch {
    return dir;
  }
  // A linked worktree shares <main>/.git, so its parent is the main worktree. A submodule's common dir is
  // <super>/.git/modules/<name>; it does not end in /.git, so the submodule keeps its own top level.
  // shortcut: a linked worktree of a submodule maps to that worktree, not the submodule; fix if it ever shows up.
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  return real(common.endsWith(sep + ".git") ? dirname(common) : top);
}
