#!/usr/bin/env node
// Copy the local world list into Convex so the shared site can read it.
//
//   npm run worlds:publish              -> production deployment
//   npm run worlds:publish -- --dev     -> the dev deployment in .env.local
//   npm run worlds:publish -- --dry-run -> print the plan, write nothing
//
// Writes go through `convex run` on internal functions, so this works only as
// the project owner (local login or CONVEX_DEPLOY_KEY). The browser has no
// write path at all.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const projectDir = process.cwd();
const flags = new Set(process.argv.slice(2));
const prod = !flags.has("--dev");
const dryRun = flags.has("--dry-run");

// Spawn node on the CLI entry directly rather than npx.cmd, so JSON arguments
// reach the CLI untouched on Windows.
const require = createRequire(import.meta.url);
const convexPackage = require.resolve("convex/package.json");
const convexCli = path.join(path.dirname(convexPackage), require(convexPackage).bin.convex);

function run(fn, args = {}) {
  const argv = [convexCli, "run", ...(prod ? ["--prod"] : []), fn, JSON.stringify(args)];
  const result = spawnSync(process.execPath, argv, {
    cwd: projectDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) throw new Error(`convex run ${fn} failed (exit ${result.status})`);
  return parseResult(result.stdout);
}

/** The CLI prints the return value as JSON; anything else on stdout is noise. */
function parseResult(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/[[{"]/);
    if (start === -1) return null;
    return JSON.parse(text.slice(start));
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(path.join(projectDir, file), "utf8"));
}

function humanize(key) {
  return key
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * The same rules as listReadyWorlds() in src/registry.ts, repeated here
 * because that module reads import.meta.env and cannot run under Node.
 */
function localWorlds() {
  const assets = readJson("mint-assets.json").assets ?? {};
  const config = readJson("worlds.config.json").worlds ?? {};
  const worlds = [];
  for (const [key, asset] of Object.entries(assets)) {
    if (asset.mode !== "remote_stream") continue;
    const runtimeUrl = asset.runtime?.runtimeUrl?.trim();
    const colliderUrl = asset.runtime?.collider?.runtimeUrl?.trim();
    const mintAssetId = asset.source?.assetId;
    if (!runtimeUrl || !colliderUrl || !mintAssetId) continue;
    const extra = config[key] ?? {};
    const row = {
      key,
      title: extra.title ?? asset.displayName ?? asset.name ?? humanize(key),
      runtimeUrl,
      colliderUrl,
      mintAssetId,
      order: worlds.length,
    };
    if (typeof extra.spawnFacing === "number") row.spawnFacing = extra.spawnFacing;
    if (typeof extra.mintChatId === "string") row.mintChatId = extra.mintChatId;
    const thumbnail = asset.thumbnailUrl
      ? path.join(projectDir, ...asset.thumbnailUrl.replace(/\\/g, "/").split("/"))
      : null;
    worlds.push({ row, thumbnail: thumbnail && existsSync(thumbnail) ? thumbnail : null });
  }
  return worlds;
}

const COMPARED = [
  "key",
  "title",
  "runtimeUrl",
  "colliderUrl",
  "spawnFacing",
  "thumbnailStorageId",
  "thumbnailHash",
  "mintAssetId",
  "mintChatId",
  "order",
];

function sameRow(a, b) {
  return COMPARED.every((field) => a?.[field] === b?.[field]);
}

async function uploadThumbnail(file) {
  const bytes = readFileSync(file);
  const uploadUrl = run("worlds:generateUploadUrl");
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "image/webp" },
    body: bytes,
  });
  if (!response.ok) throw new Error(`thumbnail upload failed: HTTP ${response.status}`);
  const { storageId } = await response.json();
  if (!storageId) throw new Error("thumbnail upload returned no storageId");
  return storageId;
}

async function main() {
  const worlds = localWorlds();
  const target = prod ? "production" : "dev";
  console.log(`${worlds.length} local worlds -> ${target}${dryRun ? " (dry run)" : ""}`);

  const existing = new Map();
  if (!dryRun) {
    for (const row of run("worlds:snapshot") ?? []) existing.set(row.key, row);
  }

  let published = 0;
  let unchanged = 0;
  for (const { row, thumbnail } of worlds) {
    const before = existing.get(row.key);
    if (thumbnail) {
      row.thumbnailHash = createHash("sha256").update(readFileSync(thumbnail)).digest("hex");
      if (before?.thumbnailHash === row.thumbnailHash && before.thumbnailStorageId) {
        row.thumbnailStorageId = before.thumbnailStorageId;
      } else if (!dryRun) {
        row.thumbnailStorageId = await uploadThumbnail(thumbnail);
      }
    }
    if (before && sameRow(before, row)) {
      unchanged += 1;
      continue;
    }
    console.log(`${before ? "update" : "add"}  ${row.key}`);
    if (!dryRun) run("worlds:upsert", row);
    published += 1;
  }

  let removed = [];
  const keep = worlds.map(({ row }) => row.key);
  if (dryRun) {
    removed = [...existing.keys()].filter((key) => !keep.includes(key));
  } else {
    removed = run("worlds:prune", { keep }) ?? [];
  }
  removed.forEach((key) => console.log(`remove  ${key}`));

  console.log(`published ${published}, unchanged ${unchanged}, removed ${removed.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
