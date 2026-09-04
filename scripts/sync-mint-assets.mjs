// Thin wrapper: forwards to the installed mint-threejs-skills sync script so
// `npm run mint:sync -- --manifest <file> --key <key>` works from this project.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const candidates = [
  process.env.MINT_THREEJS_SKILLS_ROOT,
  path.join(os.homedir(), ".claude", "skills", "mint-threejs-skills"),
].filter(Boolean);

const root = candidates.find((dir) =>
  existsSync(path.join(dir, "scripts", "sync-mint-assets.mjs")),
);
if (!root) {
  console.error(
    "mint-threejs-skills not found. Set MINT_THREEJS_SKILLS_ROOT to its install directory.",
  );
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [path.join(root, "scripts", "sync-mint-assets.mjs"), ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
