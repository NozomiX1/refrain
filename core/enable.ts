// Turning refrain on for a project (design.md 4.11): CC's own auto memory off in that project's local settings.
// Auto and idle compaction need no setting: the mod refuses them (4.4).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Returns the file it changed, or null when nothing needed changing (or the file is not plain JSON, which we leave alone).
export function disableAutoMemory(projectRoot: string): string | null {
  const path = join(projectRoot, ".claude", "settings.local.json");
  let s: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      s = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  }
  if (s.autoMemoryEnabled === false) return null;
  mkdirSync(join(projectRoot, ".claude"), { recursive: true });
  writeFileSync(path + ".tmp", JSON.stringify({ ...s, autoMemoryEnabled: false }, null, 2) + "\n");
  renameSync(path + ".tmp", path);
  return path;
}
