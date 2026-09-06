import { defineConfig, type Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MAX_WORLD_PHOTOS, worldPhotos } from "./src/world-photos";

const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");
const WORLD_CONFIG_PATH = path.resolve(process.cwd(), "worlds.config.json");
const MINT_REGISTRY_PATH = path.resolve(process.cwd(), "mint-assets.json");
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void;

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function safeFileName(raw: string) {
  const base = path.basename(raw).replace(/[^a-zA-Z0-9._-]/g, "-");
  const ext = path.extname(base).toLowerCase();
  if (!IMAGE_TYPES[ext]) return null;
  return base.slice(0, -ext.length).slice(0, 60) + ext;
}

async function listUploads() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const names = await fs.readdir(UPLOAD_DIR);
  const entries = await Promise.all(
    names
      .filter((name) => IMAGE_TYPES[path.extname(name).toLowerCase()])
      .map(async (name) => {
        const stat = await fs.stat(path.join(UPLOAD_DIR, name));
        return { name, size: stat.size, modifiedAt: stat.mtimeMs };
      }),
  );
  return entries.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

function readBody(req: IncomingMessage) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) {
        reject(new Error("File exceeds the 25 MB upload limit."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readWorldConfig(): Promise<Record<string, Record<string, unknown>>> {
  try {
    const raw = await fs.readFile(WORLD_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as { worlds?: Record<string, Record<string, unknown>> };
    return parsed.worlds ?? {};
  } catch {
    return {};
  }
}

/**
 * Record that the user pressed Stop. Mint has no cancel API, so this only marks
 * the row and tells the agent to stop polling and to discard the result.
 */
async function cancelWorld(key: string) {
  const raw = await fs.readFile(WORLD_CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as { worlds?: Record<string, Record<string, unknown>> };
  const worlds = parsed.worlds ?? {};
  const world = worlds[key];
  if (!world) return null;
  worlds[key] = {
    ...world,
    status: "cancelled",
    note: "Stopped. Mint may still finish this one in the background.",
    cancelledAt: new Date().toISOString(),
  };
  parsed.worlds = worlds;
  await fs.writeFile(WORLD_CONFIG_PATH, `${JSON.stringify(parsed, null, 2)}\n`);
  return worlds;
}

function worldKeyFor(fileName: string, taken: Set<string>) {
  const base = fileName
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const stem = base || "world";
  if (!taken.has(stem)) return stem;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${stem}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function titleFor(fileName: string) {
  const words = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => !/^\d{8,}$/.test(word));
  if (words.length === 0) return "New World";
  return words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

type WorldRecord = Record<string, unknown>;

async function loadWorlds() {
  const raw = await fs.readFile(WORLD_CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as { worlds?: Record<string, WorldRecord> };
  return { parsed, worlds: parsed.worlds ?? {} };
}

async function saveWorlds(parsed: { worlds?: Record<string, WorldRecord> }, worlds: Record<string, WorldRecord>) {
  parsed.worlds = worlds;
  await fs.writeFile(WORLD_CONFIG_PATH, `${JSON.stringify(parsed, null, 2)}\n`);
}

/** Every photo path already spoken for, mapped to the world that owns it. */
function claimMap(worlds: Record<string, WorldRecord>) {
  const claimed = new Map<string, { key: string; title: string }>();
  Object.entries(worlds).forEach(([key, world]) => {
    const title = typeof world.title === "string" ? world.title : key;
    worldPhotos(world).forEach((photo) => {
      if (!claimed.has(photo)) claimed.set(photo, { key, title });
    });
  });
  return claimed;
}

/**
 * Record that the user grouped or asked for a world. Mint has no HTTP API, so
 * the page cannot start one itself; a "requested" entry queues it for the
 * agent, while a "draft" is only a grouping and is never generated.
 */
async function requestWorld(
  fileNames: string[],
  status: "draft" | "requested",
  lookPrompt?: string,
) {
  const { parsed, worlds } = await loadWorlds();
  const sourceImages = fileNames.map((name) => `uploads/${name}`);
  const claimed = claimMap(worlds);

  // Re-pressing Generate on a world that already exists must not duplicate it.
  const owners = new Set(sourceImages.map((photo) => claimed.get(photo)?.key));
  if (owners.size === 1 && !owners.has(undefined)) {
    const key = [...owners][0] as string;
    if (worldPhotos(worlds[key]).length === sourceImages.length) {
      if (status === "requested" && worlds[key].status === "draft") {
        worlds[key] = {
          ...worlds[key],
          ...(lookPrompt ? { lookPrompt } : {}),
          status: "requested",
          note:
            sourceImages.length > 1
              ? `Requested from ${sourceImages.length} photos. Claude starts this on your next message.`
              : "Requested. Claude starts this on your next message.",
          requestedAt: new Date().toISOString(),
        };
        await saveWorlds(parsed, worlds);
        return { worlds, key, alreadyQueued: false };
      }
      return { worlds, key, alreadyQueued: true };
    }
  }

  const conflicts = sourceImages
    .map((photo, index) => ({ photo, name: fileNames[index], owner: claimed.get(photo) }))
    .filter((entry) => entry.owner)
    .map((entry) => ({
      name: entry.name,
      key: entry.owner?.key ?? "",
      title: entry.owner?.title ?? "",
    }));
  if (conflicts.length > 0) return { conflicts };

  const key = worldKeyFor(fileNames[0], new Set(Object.keys(worlds)));
  worlds[key] = {
    title: titleFor(fileNames[0]),
    sourceImage: sourceImages[0],
    sourceImages,
    ...(lookPrompt ? { lookPrompt } : {}),
    status,
    note:
      status === "draft"
        ? `${sourceImages.length} photo${sourceImages.length === 1 ? "" : "s"} grouped. Press Generate to build the world.`
        : sourceImages.length > 1
          ? `Requested from ${sourceImages.length} photos. Claude starts this on your next message.`
          : "Requested. Claude starts this on your next message.",
    ...(status === "requested" ? { requestedAt: new Date().toISOString() } : {}),
  };
  await saveWorlds(parsed, worlds);
  return { worlds, key, alreadyQueued: false };
}

/** Mint asset ids already registered, mapped to their logical key. */
async function registeredAssetIds() {
  const byAssetId = new Map<string, string>();
  try {
    const raw = await fs.readFile(MINT_REGISTRY_PATH, "utf8");
    const parsed = JSON.parse(raw) as {
      assets?: Record<string, { source?: { assetId?: string } }>;
    };
    Object.entries(parsed.assets ?? {}).forEach(([key, asset]) => {
      const id = asset.source?.assetId;
      if (typeof id === "string" && id) byAssetId.set(id, key);
    });
  } catch {
    // No registry yet means nothing is registered, which is the same answer.
  }
  return byAssetId;
}

const MINT_ID = /^[a-z0-9]{20,64}$/;

interface MintRef {
  assetId?: string;
  chatId?: string;
}

/** Turn a pasted link or id into a Mint reference, or explain why it is not one. */
function parseMintReference(raw: string): MintRef | { error: string } {
  const input = raw.trim().replace(/^[<"'`]+|[>"'`]+$/g, "").toLowerCase();
  if (!input) return { error: "Paste a Mint link or asset id." };
  if (!/^https?:\/\//.test(input)) {
    if (!MINT_ID.test(input)) {
      return {
        error:
          "That does not look like a Mint id. Paste the mint.gg link from the address bar, or the asset id on its own.",
      };
    }
    // A bare id is usually an asset id; the agent falls back to a chat lookup.
    return { assetId: input };
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { error: "That link could not be read. Copy it again from the address bar." };
  }
  if (url.hostname !== "mint.gg" && !url.hostname.endsWith(".mint.gg")) {
    return { error: "That is not a mint.gg address. Paste a link from mint.gg." };
  }
  const explicit = url.searchParams.get("asset") ?? url.searchParams.get("assetid");
  if (explicit && MINT_ID.test(explicit)) return { assetId: explicit };
  const segments = url.pathname.split("/").filter(Boolean);
  const chatAt = segments.indexOf("chat");
  if (chatAt !== -1 && MINT_ID.test(segments[chatAt + 1] ?? "")) {
    return { chatId: segments[chatAt + 1] };
  }
  const last = [...segments].reverse().find((segment) => MINT_ID.test(segment));
  if (last) return { assetId: last };
  return {
    error:
      "There is no Mint id in that link. Open the world in Mint and copy the link from the address bar.",
  };
}

/**
 * Record a world the user already made in Mint. Mint has no HTTP API, so the
 * page cannot fetch it: this entry tells the agent which world to register.
 *
 * The same world may be added more than once. Two Mint worlds can share a name,
 * and a second row of one world costs nothing but a key, so nothing is refused
 * here: every add becomes its own entry and its own row.
 */
async function importWorld(ref: MintRef, source: string) {
  const { parsed, worlds } = await loadWorlds();
  const registered = await registeredAssetIds();

  // A key that shadows a registered asset would make the row vanish from the lobby.
  const taken = new Set([...Object.keys(worlds), ...registered.values()]);
  const key = worldKeyFor(`import-${(ref.assetId ?? ref.chatId ?? "world").slice(0, 8)}`, taken);
  worlds[key] = {
    title: "Imported world",
    status: "importing",
    note: "Pasted from Mint. Claude finishes this on your next message.",
    ...(ref.assetId ? { mintAssetId: ref.assetId } : {}),
    ...(ref.chatId ? { mintChatId: ref.chatId } : {}),
    mintSource: source.slice(0, 200),
    importedAt: new Date().toISOString(),
  };
  await saveWorlds(parsed, worlds);
  return { worlds, key };
}

/** Delete an entry, freeing its photos. Backs Ungroup on drafts and Remove on dead rows. */
async function forgetWorld(key: string) {
  const { parsed, worlds } = await loadWorlds();
  if (!worlds[key]) return null;
  delete worlds[key];
  await saveWorlds(parsed, worlds);
  return worlds;
}

// Local-only endpoints backing the drop zone and the generation status rows.
// The Mint world generation itself runs through Mint MCP in agent tooling.
function uploadsApi(): Plugin {
  const attach = (middlewares: { use: (route: string, handler: Middleware) => void }) => {
    middlewares.use("/api/generation", async (req, res, next) => {
      try {
        const route = (req.url ?? "/").split("?")[0];
        if (req.method === "GET" && (route === "/" || route === "")) {
          sendJson(res, 200, { worlds: await readWorldConfig() });
          return;
        }
        if (req.method === "POST" && route === "/request") {
          const body = await readBody(req);
          const payload = JSON.parse(body.toString("utf8") || "{}") as {
            name?: string;
            names?: string[];
            status?: string;
            lookPrompt?: string;
          };
          const requested = Array.isArray(payload.names)
            ? payload.names
            : payload.name
              ? [payload.name]
              : [];
          const fileNames = [
            ...new Set(
              requested
                .map((name) => (typeof name === "string" ? safeFileName(name) : null))
                .filter((name): name is string => Boolean(name)),
            ),
          ];
          if (fileNames.length === 0) {
            sendJson(res, 400, { error: "An uploaded image name is required." });
            return;
          }
          if (fileNames.length > MAX_WORLD_PHOTOS) {
            sendJson(res, 400, {
              error: `A world can use at most ${MAX_WORLD_PHOTOS} photos. Untick a few and try again.`,
              limit: MAX_WORLD_PHOTOS,
            });
            return;
          }
          const missing: string[] = [];
          for (const fileName of fileNames) {
            try {
              await fs.access(path.join(UPLOAD_DIR, fileName));
            } catch {
              missing.push(fileName);
            }
          }
          if (missing.length > 0) {
            sendJson(res, 404, {
              error: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not in the uploads folder.`,
              missing,
            });
            return;
          }
          const status = payload.status === "draft" ? "draft" : "requested";
          const lookPrompt =
            typeof payload.lookPrompt === "string" && payload.lookPrompt.trim()
              ? payload.lookPrompt.trim().slice(0, 1200)
              : undefined;
          const result = await requestWorld(fileNames, status, lookPrompt);
          if ("conflicts" in result) {
            const first = result.conflicts[0];
            sendJson(res, 409, {
              error: `${first.name} is already part of ${first.title}.`,
              conflicts: result.conflicts,
            });
            return;
          }
          sendJson(res, 200, result);
          return;
        }
        if (req.method === "POST" && route === "/import") {
          const body = await readBody(req);
          const { link } = JSON.parse(body.toString("utf8") || "{}") as { link?: string };
          if (typeof link !== "string" || !link.trim()) {
            sendJson(res, 400, { error: "Paste a Mint link or asset id." });
            return;
          }
          const ref = parseMintReference(link);
          if ("error" in ref) {
            sendJson(res, 400, { error: ref.error });
            return;
          }
          sendJson(res, 200, await importWorld(ref, link.trim()));
          return;
        }
        if (req.method === "POST" && route === "/forget") {
          const body = await readBody(req);
          const { key } = JSON.parse(body.toString("utf8") || "{}") as { key?: string };
          if (!key) {
            sendJson(res, 400, { error: "A world key is required." });
            return;
          }
          const worlds = await forgetWorld(key);
          if (!worlds) {
            sendJson(res, 404, { error: `No world named ${key}.` });
            return;
          }
          sendJson(res, 200, { worlds });
          return;
        }
        if (req.method === "POST" && route === "/cancel") {
          const body = await readBody(req);
          const { key } = JSON.parse(body.toString("utf8") || "{}") as { key?: string };
          if (!key) {
            sendJson(res, 400, { error: "A world key is required." });
            return;
          }
          const worlds = await cancelWorld(key);
          if (!worlds) {
            sendJson(res, 404, { error: `No world named ${key}.` });
            return;
          }
          sendJson(res, 200, { worlds });
          return;
        }
        next();
      } catch (error) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : "Generation request failed.",
        });
      }
    });

    middlewares.use("/api/uploads", async (req, res, next) => {
      try {
        if (req.method === "GET") {
          sendJson(res, 200, { uploads: await listUploads() });
          return;
        }
        if (req.method === "POST") {
          const requested = decodeURIComponent(
            String(req.headers["x-file-name"] ?? "photo.jpg"),
          );
          const name = safeFileName(requested);
          if (!name) {
            sendJson(res, 400, { error: "Only jpg, png or webp images are accepted." });
            return;
          }
          const body = await readBody(req);
          if (body.length === 0) {
            sendJson(res, 400, { error: "The uploaded file was empty." });
            return;
          }
          await fs.mkdir(UPLOAD_DIR, { recursive: true });
          let finalName = name;
          try {
            await fs.access(path.join(UPLOAD_DIR, finalName));
            const ext = path.extname(name);
            finalName = `${name.slice(0, -ext.length)}-${Date.now()}${ext}`;
          } catch {
            // The requested name is free.
          }
          await fs.writeFile(path.join(UPLOAD_DIR, finalName), body);
          sendJson(res, 201, { name: finalName, size: body.length });
          return;
        }
        next();
      } catch (error) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : "Upload failed.",
        });
      }
    });

    middlewares.use("/uploads", async (req, res, next) => {
      const requested = decodeURIComponent((req.url ?? "/").split("?")[0].slice(1));
      const name = safeFileName(requested);
      if (!name || req.method !== "GET") {
        next();
        return;
      }
      try {
        const data = await fs.readFile(path.join(UPLOAD_DIR, name));
        res.statusCode = 200;
        res.setHeader("Content-Type", IMAGE_TYPES[path.extname(name).toLowerCase()]);
        res.setHeader("Cache-Control", "no-cache");
        res.end(data);
      } catch {
        next();
      }
    });
  };

  return {
    name: "photo-walkthrough-uploads-api",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}

export default defineConfig({
  // Relative so the same build works at a domain root or under a repo path
  // such as https://user.github.io/image-walkthrough/.
  base: "./",
  plugins: [uploadsApi()],
  server: {
    host: "127.0.0.1",
    port: 5190,
    strictPort: true,
    // worlds.config.json is a static import, so every write would otherwise
    // force a full reload and wipe an in-progress selection. The lobby polls
    // /api/generation for live config, so nothing is lost by ignoring it.
    watch: { ignored: ["**/worlds.config.json", "**/uploads/**"] },
  },
  preview: { host: "127.0.0.1", port: 4190, strictPort: true },
  build: { sourcemap: true, chunkSizeWarningLimit: 6000 },
});
