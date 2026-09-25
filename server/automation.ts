import type { IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isStageId,
  MAX_PROJECT_NAME,
  MAX_ROOMS,
  MAX_TOPIC_LENGTH,
  STAGE_IDS,
  stageIndex,
  waitingLabel,
  type Idea,
  type IdeaDay,
  type Job,
  type JobKind,
  type Project,
  type ProjectActivity,
  type ProjectIdea,
  type ProjectPatch,
  type StageId,
} from "../src/automation/types";

/**
 * Local-only storage for reel projects. Each project is a folder holding
 * project.json (and later its clips and exports), so a project can be moved
 * whole between active, archive and trash with one rename.
 */
const ROOT = path.resolve(process.cwd(), "automation");
const DIRS = {
  projects: path.join(ROOT, "projects"),
  archive: path.join(ROOT, "archive"),
  trash: path.join(ROOT, "trash"),
} as const;
type Shelf = keyof typeof DIRS;
const JOBS_PATH = path.join(ROOT, "jobs.json");
const IDEAS_DIR = path.join(ROOT, "ideas");
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Jobs the page may queue; the rest arrive with their stages. */
const PAGE_JOB_KINDS: readonly JobKind[] = ["research", "ideate", "hooks", "references", "worlds"];
const MINT_PATH = path.join(ROOT, "mint.json");
const REF_DIR = "refs";
const MAX_REF_BYTES = 25 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const MAX_NOTE_LENGTH = 300;
/** Finished jobs kept in the file so the page can show what just happened. */
const KEEP_FINISHED_JOBS = 50;
const PROJECT_FILE = "project.json";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Every change goes through one queue, so an autosave that lands while a move
 * or another save is running reads the result of that one rather than racing it.
 */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_JSON_BYTES) {
        reject(new HttpError(413, "That change is too large to save."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        const parsed: unknown = text ? JSON.parse(text) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new HttpError(400, "Expected a JSON object."));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, "The request was not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function slugify(name: string) {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "reel";
}

function cleanName(raw: unknown) {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim().slice(0, MAX_PROJECT_NAME);
  return name || null;
}

function requireId(raw: string) {
  const id = decodeURIComponent(raw);
  if (!ID_PATTERN.test(id)) throw new HttpError(400, "That is not a project id.");
  return id;
}

async function exists(target: string) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** A folder name on `shelf` that is free: base, base-2, base-3 … */
async function freeId(shelf: Shelf, base: string) {
  await fs.mkdir(DIRS[shelf], { recursive: true });
  for (let n = 1; n < 1000; n++) {
    const id = n === 1 ? base : `${base.slice(0, 60)}-${n}`;
    if (!(await exists(path.join(DIRS[shelf], id)))) return id;
  }
  throw new HttpError(409, "Too many projects share that name.");
}

async function readProject(shelf: Shelf, id: string): Promise<Project> {
  try {
    const text = await fs.readFile(path.join(DIRS[shelf], id, PROJECT_FILE), "utf8");
    return JSON.parse(text) as Project;
  } catch {
    throw new HttpError(404, "That project no longer exists.");
  }
}

/** Write through a temp file so a crash mid-save never leaves half a file. */
async function writeJson(target: string, value: unknown) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temp, target);
}

async function writeProject(shelf: Shelf, project: Project) {
  await writeJson(path.join(DIRS[shelf], project.id, PROJECT_FILE), project);
}

async function listShelf(shelf: Shelf) {
  await fs.mkdir(DIRS[shelf], { recursive: true });
  const entries = await fs.readdir(DIRS[shelf], { withFileTypes: true });
  const projects = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
      .map((entry) => readProject(shelf, entry.name).catch(() => null)),
  );
  const found = projects.filter((project): project is Project => project !== null);
  const sortKey = (project: Project) =>
    shelf === "archive"
      ? project.archivedAt ?? project.updatedAt
      : shelf === "trash"
        ? project.trashedAt ?? project.updatedAt
        : project.createdAt;
  // Newest first on every shelf.
  return found.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
}

async function createProject(name: string) {
  const id = await freeId("projects", slugify(name));
  const now = new Date().toISOString();
  const project: Project = {
    id,
    name,
    stage: "idea",
    openStage: "idea",
    activity: { label: waitingLabel("idea"), tone: "waiting" },
    data: {},
    createdAt: now,
    updatedAt: now,
  };
  await writeProject("projects", project);
  return project;
}

function cleanActivity(raw: unknown): ProjectActivity | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { label, tone, percent } = raw as Record<string, unknown>;
  if (typeof label !== "string" || !label.trim()) return undefined;
  if (tone !== "waiting" && tone !== "busy" && tone !== "error") return undefined;
  const activity: ProjectActivity = { label: label.trim().slice(0, 140), tone };
  if (typeof percent === "number" && Number.isFinite(percent)) {
    activity.percent = Math.min(100, Math.max(0, percent));
  }
  return activity;
}

/** Merge an autosave into the stored project, taking only fields the page may set. */
async function patchProject(id: string, body: Record<string, unknown>) {
  const project = await readProject("projects", id);
  const patch: ProjectPatch = {};
  if ("name" in body) {
    const name = cleanName(body.name);
    if (!name) throw new HttpError(400, "A project needs a name.");
    patch.name = name;
  }
  if ("stage" in body) {
    if (!isStageId(body.stage)) throw new HttpError(400, "Unknown stage.");
    patch.stage = body.stage;
  }
  if ("openStage" in body) {
    if (!isStageId(body.openStage)) throw new HttpError(400, "Unknown stage.");
    patch.openStage = body.openStage;
  }
  if ("activity" in body) {
    patch.activity = body.activity === null ? undefined : cleanActivity(body.activity);
  }
  if ("checks" in body) {
    if (!Array.isArray(body.checks) || !body.checks.every(isStageId)) {
      throw new HttpError(400, "Checks must be a list of stages.");
    }
    patch.checks = [...new Set(body.checks as StageId[])];
  }
  if ("data" in body) {
    if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
      throw new HttpError(400, "Stage data must be an object.");
    }
    // Stages are saved independently, so one stage's save never drops another's.
    patch.data = { ...project.data, ...(body.data as Record<string, unknown>) };
  }
  const next: Project = { ...project, ...patch, updatedAt: new Date().toISOString() };
  if ("activity" in patch && !patch.activity) delete next.activity;
  await writeProject("projects", next);
  return next;
}

// -------------------------------------------------------------------- jobs

async function readJobs(): Promise<Job[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(JOBS_PATH, "utf8")) as { jobs?: Job[] };
    return Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch {
    return [];
  }
}

function isActive(job: Job) {
  return job.status === "requested" || job.status === "running";
}

/** Keeps every active job and only the most recent finished ones. */
async function writeJobs(jobs: Job[]) {
  const finished = jobs.filter((job) => !isActive(job)).slice(-KEEP_FINISHED_JOBS);
  const keep = new Set([...jobs.filter(isActive), ...finished]);
  await writeJson(JOBS_PATH, { jobs: jobs.filter((job) => keep.has(job)) });
}

async function addJob(body: Record<string, unknown>) {
  const kind = body.kind as JobKind;
  if (!PAGE_JOB_KINDS.includes(kind)) {
    throw new HttpError(400, "That job can't be started from the page yet.");
  }
  const jobs = await readJobs();
  const input: Record<string, unknown> = {};
  let projectId: string | undefined;
  if (typeof body.projectId === "string") {
    projectId = requireId(body.projectId);
    await readProject("projects", projectId);
  }
  if (kind === "research") {
    // One research run at a time; asking again just shows the running one.
    const running = jobs.find((job) => job.kind === "research" && isActive(job));
    if (running) return running;
  }
  if (kind === "ideate") {
    const raw = (body.input as Record<string, unknown> | undefined)?.topic;
    const topic = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
    if (!topic) throw new HttpError(400, "Type a topic first.");
    input.topic = topic.slice(0, MAX_TOPIC_LENGTH);
  }
  if (kind === "hooks") {
    if (!projectId) throw new HttpError(400, "New hooks are written for a project.");
    // One rewrite at a time per project; asking again shows the queued one.
    const queued = jobs.find((job) => job.kind === "hooks" && job.projectId === projectId && isActive(job));
    if (queued) return queued;
    const raw = (body.input as Record<string, unknown> | undefined)?.note;
    const note = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
    if (note) input.note = note.slice(0, MAX_NOTE_LENGTH);
  }
  if (kind === "worlds") {
    if (!projectId) throw new HttpError(400, "Worlds are built for a project.");
    // Credits are spent the moment a world starts, so never queue two at once.
    const running = jobs.find((job) => job.kind === "worlds" && job.projectId === projectId && isActive(job));
    if (running) throw new HttpError(409, "Worlds are already being built for this project.");
    const raw = (body.input as Record<string, unknown> | undefined) ?? {};
    const rooms = Array.isArray(raw.rooms)
      ? raw.rooms
          .filter((room): room is Record<string, unknown> => !!room && typeof room === "object")
          .map((room) => ({
            key: String(room.key ?? "").slice(0, 60),
            name: String(room.name ?? "").trim().slice(0, 80),
            visual: String(room.visual ?? "").trim().slice(0, 300),
            images: (Array.isArray(room.images) ? room.images : [])
              .filter((url): url is string => typeof url === "string")
              .filter((url) => /^https?:\/\//i.test(url) || url.startsWith("/api/automation/projects/"))
              .slice(0, 6),
            sharpen: room.sharpen === true,
          }))
          .filter((room) => room.key && room.name && room.images.length > 0)
      : [];
    if (rooms.length === 0 || rooms.length > MAX_ROOMS) {
      throw new HttpError(400, `Pick 1–${MAX_ROOMS} rooms, each with at least one image.`);
    }
    const credits = Number(raw.credits);
    if (!Number.isFinite(credits) || credits <= 0) {
      throw new HttpError(400, "The approved credit amount is missing.");
    }
    input.rooms = rooms;
    input.credits = Math.round(credits);
    input.approvedAt = new Date().toISOString();
  }
  if (kind === "references") {
    if (!projectId) throw new HttpError(400, "Images are found for a project.");
    const queued = jobs.find(
      (job) => job.kind === "references" && job.projectId === projectId && isActive(job),
    );
    if (queued) return queued;
    const raw = (body.input as Record<string, unknown> | undefined) ?? {};
    const rooms = Array.isArray(raw.rooms)
      ? raw.rooms
          .filter((room): room is Record<string, unknown> => !!room && typeof room === "object")
          .map((room) => ({
            key: String(room.key ?? "").slice(0, 60),
            name: String(room.name ?? "").trim().slice(0, 80),
            visual: String(room.visual ?? "").trim().slice(0, 300),
          }))
          .filter((room) => room.key && room.name)
          .slice(0, 8)
      : [];
    if (rooms.length === 0) throw new HttpError(400, "Say which rooms need images.");
    input.rooms = rooms;
    const note = typeof raw.note === "string" ? raw.note.replace(/\s+/g, " ").trim() : "";
    if (note) input.note = note.slice(0, MAX_NOTE_LENGTH);
  }
  const job: Job = {
    id: `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind,
    status: "requested",
    ...(projectId ? { projectId } : {}),
    input,
    requestedAt: new Date().toISOString(),
  };
  await writeJobs([...jobs, job]);
  return job;
}

async function cancelJob(id: string) {
  const jobs = await readJobs();
  const job = jobs.find((entry) => entry.id === id);
  if (!job) throw new HttpError(404, "That job is gone.");
  if (isActive(job)) {
    const wasWaiting = job.status === "requested";
    job.status = "cancelled";
    job.cancelledAt = new Date().toISOString();
    await writeJobs(jobs);
    if (job.kind === "worlds" && job.projectId && wasWaiting) await unqueueWorlds(job);
  }
  return job;
}

/**
 * A worlds job cancelled before Claude picked it up spent nothing, so its rooms
 * go back to unbuilt and the project back to waiting on you. Once Claude has
 * started, rooms keep their state: Mint can't cancel a world in flight.
 */
async function unqueueWorlds(job: Job) {
  let project: Project;
  try {
    project = await readProject("projects", job.projectId as string);
  } catch {
    return;
  }
  const worlds = { ...((project.data.worlds as Record<string, { status?: string }> | undefined) ?? {}) };
  for (const room of (job.input.rooms as Array<{ key: string }> | undefined) ?? []) {
    if (worlds[room.key]?.status === "queued") delete worlds[room.key];
  }
  await writeProject("projects", {
    ...project,
    activity: { label: waitingLabel(project.stage), tone: "waiting" },
    data: { ...project.data, worlds },
    updatedAt: new Date().toISOString(),
  });
}

/** Stop anything the agent had queued for a project that is going away. */
async function cancelJobs(projectId: string) {
  const jobs = await readJobs();
  let cancelled = 0;
  const now = new Date().toISOString();
  for (const job of jobs) {
    if (job.projectId === projectId && isActive(job)) {
      job.status = "cancelled";
      job.cancelledAt = now;
      cancelled++;
    }
  }
  if (cancelled > 0) await writeJobs(jobs);
  return cancelled;
}

// ------------------------------------------------------------------- ideas

function requireDate(raw: string) {
  const date = decodeURIComponent(raw);
  if (!DATE_PATTERN.test(date)) throw new HttpError(400, "That is not a date.");
  return date;
}

async function listIdeaDates() {
  await fs.mkdir(IDEAS_DIR, { recursive: true });
  const names = await fs.readdir(IDEAS_DIR);
  return names
    .filter((name) => name.endsWith(".json") && DATE_PATTERN.test(name.slice(0, -5)))
    .map((name) => name.slice(0, -5))
    .sort()
    .reverse();
}

async function readIdeaDay(date: string): Promise<IdeaDay | null> {
  try {
    const day = JSON.parse(await fs.readFile(path.join(IDEAS_DIR, `${date}.json`), "utf8")) as IdeaDay;
    return { ...day, date, ideas: Array.isArray(day.ideas) ? day.ideas : [] };
  } catch {
    return null;
  }
}

/** A project that drops an idea frees it to be picked again. */
async function releaseIdea(previous: ProjectIdea, projectId: string) {
  const day = await readIdeaDay(previous.date);
  const idea = day?.ideas.find((entry) => entry.id === previous.id);
  if (!day || !idea || idea.projectId !== projectId) return;
  delete idea.projectId;
  await writeJson(path.join(IDEAS_DIR, `${previous.date}.json`), day);
}

/**
 * Start a project from each chosen idea, or give one idea to an existing
 * project. Choosing the idea finishes stage 1, so the project moves on to
 * picking its hook and caption.
 */
async function useIdeas(date: string, body: Record<string, unknown>) {
  const day = await readIdeaDay(date);
  if (!day) throw new HttpError(404, "Those ideas are gone.");
  const ids = Array.isArray(body.ideaIds)
    ? body.ideaIds.filter((id): id is string => typeof id === "string")
    : [];
  const chosen = ids
    .map((id) => day.ideas.find((idea) => idea.id === id))
    .filter((idea): idea is Idea => idea !== undefined);
  if (chosen.length === 0) throw new HttpError(400, "Pick at least one idea.");
  const target = typeof body.projectId === "string" ? requireId(body.projectId) : null;
  if (target && chosen.length !== 1) throw new HttpError(400, "A project takes one idea.");
  const taken = chosen.find((idea) => idea.projectId && idea.projectId !== target);
  if (taken) throw new HttpError(409, `“${taken.title}” is already a project.`);

  const now = () => new Date().toISOString();
  const projects: Project[] = [];
  for (const idea of chosen) {
    const saved: ProjectIdea = { ...idea, date };
    delete saved.projectId;
    let project: Project;
    if (target) {
      const existing = await readProject("projects", target);
      const previous = existing.data.idea as ProjectIdea | undefined;
      if (previous && (previous.date !== date || previous.id !== idea.id)) {
        await releaseIdea(previous, target);
      }
      const reached = stageIndex(existing.stage);
      // Stages already reached keep their work but were made for the old idea.
      const flagged = previous
        ? STAGE_IDS.filter((_, index) => index >= stageIndex("approved") && index <= reached)
        : [];
      const checks = [...new Set([...(existing.checks ?? []), ...flagged])];
      const advancing = existing.stage === "idea";
      project = {
        ...existing,
        name: /^untitled reel/i.test(existing.name)
          ? idea.title.slice(0, MAX_PROJECT_NAME)
          : existing.name,
        stage: advancing ? "approved" : existing.stage,
        openStage: advancing ? "approved" : existing.openStage,
        activity: advancing
          ? { label: waitingLabel("approved"), tone: "waiting" }
          : existing.activity,
        data: { ...existing.data, idea: saved },
        updatedAt: now(),
      };
      if (checks.length) project.checks = checks;
    } else {
      const created = await createProject(idea.title.slice(0, MAX_PROJECT_NAME) || "Untitled reel");
      project = {
        ...created,
        stage: "approved",
        openStage: "approved",
        activity: { label: waitingLabel("approved"), tone: "waiting" },
        data: { idea: saved },
        updatedAt: now(),
      };
    }
    await writeProject("projects", project);
    idea.projectId = project.id;
    projects.push(project);
  }
  await writeJson(path.join(IDEAS_DIR, `${date}.json`), day);
  return projects;
}

/** Move a project folder between shelves, renaming it if the target name is taken. */
async function move(from: Shelf, id: string, to: Shelf, targetBase: string, edit: (p: Project) => Project) {
  const project = await readProject(from, id);
  const targetId = await freeId(to, targetBase);
  await fs.rename(path.join(DIRS[from], id), path.join(DIRS[to], targetId));
  const moved = edit({ ...project, id: targetId, updatedAt: new Date().toISOString() });
  await writeProject(to, moved);
  return moved;
}

async function trashProject(id: string) {
  const cancelledJobs = await cancelJobs(id);
  // Its idea goes back on the list so it can be picked again.
  const idea = (await readProject("projects", id)).data.idea as ProjectIdea | undefined;
  if (idea) await releaseIdea(idea, id);
  // Its jobs were just cancelled, so whatever it was doing is no longer happening.
  const project = await move("projects", id, "trash", id, (p) => {
    const { activity: _activity, ...rest } = p;
    return { ...rest, trashedAt: new Date().toISOString() };
  });
  return { project, cancelledJobs };
}

async function restoreProject(id: string) {
  // Cancelled jobs do not come back, so a restored project waits on the user.
  return move("trash", id, "projects", id, (p) => {
    const { trashedAt: _trashed, ...rest } = p;
    return { ...rest, activity: { label: waitingLabel(p.stage), tone: "waiting" } };
  });
}

/** Posted projects live on in the archive, in a folder named after the project. */
async function archiveProject(id: string) {
  const current = await readProject("projects", id);
  return move("projects", id, "archive", slugify(current.name), (p) => ({
    ...p,
    stage: "measured",
    openStage: "measured",
    archivedAt: new Date().toISOString(),
    activity: { label: waitingLabel("measured"), tone: "busy" },
  }));
}

async function route(method: string, parts: string[], req: IncomingMessage) {
  const [shelf, rawId, action] = parts;
  if (shelf === "mint" && method === "GET" && parts.length === 1) {
    // Written by the agent whenever it checks the balance; the page only reads it.
    try {
      return { mint: JSON.parse(await fs.readFile(MINT_PATH, "utf8")) };
    } catch {
      return { mint: {} };
    }
  }
  if (shelf === "jobs") {
    if (method === "GET" && parts.length === 1) return { jobs: await readJobs() };
    if (method === "POST" && parts.length === 1) {
      const body = await readJson(req);
      return { job: await serial(() => addJob(body)) };
    }
    if (method === "POST" && rawId && action === "cancel") {
      const id = decodeURIComponent(rawId);
      return { job: await serial(() => cancelJob(id)) };
    }
    return null;
  }
  if (shelf === "ideas") {
    if (method === "GET" && parts.length === 1) {
      const dates = await listIdeaDates();
      // Every past day stays on file; the summaries let the page list them.
      const days = await Promise.all(
        dates.map(async (date) => {
          const day = await readIdeaDay(date);
          const ideas = day?.ideas ?? [];
          return { date, count: ideas.length, picked: ideas.filter((idea) => idea.projectId).length };
        }),
      );
      return { dates, days, day: dates[0] ? await readIdeaDay(dates[0]) : null };
    }
    if (!rawId) return null;
    const date = requireDate(rawId);
    if (method === "GET" && !action) return { day: await readIdeaDay(date) };
    if (method === "POST" && action === "use") {
      const body = await readJson(req);
      return { projects: await serial(() => useIdeas(date, body)) };
    }
    return null;
  }
  if (method === "GET" && parts.length === 1 && (shelf === "projects" || shelf === "archive" || shelf === "trash")) {
    return { projects: await listShelf(shelf) };
  }
  if (shelf === "projects") {
    if (method === "POST" && parts.length === 1) {
      const body = await readJson(req);
      const name = cleanName(body.name) ?? "Untitled reel";
      return { project: await serial(() => createProject(name)) };
    }
    if (!rawId) return null;
    const id = requireId(rawId);
    if (method === "GET" && !action) return { project: await readProject("projects", id) };
    if (method === "PATCH" && !action) {
      const body = await readJson(req);
      return { project: await serial(() => patchProject(id, body)) };
    }
    if (method === "POST" && action === "trash") return serial(() => trashProject(id));
    if (method === "POST" && action === "archive") return { project: await serial(() => archiveProject(id)) };
  }
  if (shelf === "trash" && rawId && method === "POST" && action === "restore") {
    const id = requireId(rawId);
    return { project: await serial(() => restoreProject(id)) };
  }
  if (shelf === "archive" && rawId && method === "GET" && !action) {
    return { project: await readProject("archive", requireId(rawId)) };
  }
  return null;
}

/** Mounts /api/automation on the dev and preview servers. */
// ------------------------------------------------- your own reference images

function refFileName(raw: string) {
  const base = path.basename(raw).replace(/[^a-zA-Z0-9._-]/g, "-");
  const ext = path.extname(base).toLowerCase();
  if (!IMAGE_TYPES[ext]) return null;
  return `${base.slice(0, -ext.length).slice(0, 60) || "image"}${ext}`;
}

function readBytes(req: IncomingMessage, limit: number) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new HttpError(413, "Images must be 25 MB or smaller."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Save an image you added to a project; it lives in the project's own folder. */
async function saveRef(id: string, req: IncomingMessage) {
  await readProject("projects", id);
  const name = refFileName(decodeURIComponent(String(req.headers["x-file-name"] ?? "")));
  if (!name) throw new HttpError(400, "Only jpg, png or webp images can be added.");
  const body = await readBytes(req, MAX_REF_BYTES);
  if (body.length === 0) throw new HttpError(400, "That image was empty.");
  const dir = path.join(DIRS.projects, id, REF_DIR);
  await fs.mkdir(dir, { recursive: true });
  const ext = path.extname(name);
  let finalName = name;
  for (let n = 2; await exists(path.join(dir, finalName)); n++) {
    finalName = `${name.slice(0, -ext.length)}-${n}${ext}`;
  }
  await fs.writeFile(path.join(dir, finalName), body);
  return { name: finalName, url: `/api/automation/projects/${id}/refs/${encodeURIComponent(finalName)}` };
}

/** Serve a project's own image from whichever shelf the project is on now. */
async function sendRef(id: string, rawName: string, res: ServerResponse) {
  const name = refFileName(decodeURIComponent(rawName));
  if (!name) throw new HttpError(404, "No such image.");
  for (const shelf of ["projects", "archive", "trash"] as const) {
    const file = path.join(DIRS[shelf], id, REF_DIR, name);
    if (await exists(file)) {
      res.statusCode = 200;
      res.setHeader("Content-Type", IMAGE_TYPES[path.extname(name).toLowerCase()]);
      res.setHeader("Cache-Control", "no-cache");
      res.end(await fs.readFile(file));
      return;
    }
  }
  throw new HttpError(404, "No such image.");
}

export function attachAutomationApi(middlewares: { use: (route: string, handler: Middleware) => void }) {
  middlewares.use("/api/automation", async (req, res, next) => {
    try {
      const parts = (req.url ?? "/").split("?")[0].split("/").filter(Boolean);
      // Images travel as raw bytes, not JSON, so they skip the JSON router.
      if (parts[0] === "projects" && parts[2] === REF_DIR && parts[1]) {
        const id = requireId(parts[1]);
        if (req.method === "POST" && parts.length === 3) {
          sendJson(res, 200, await saveRef(id, req));
          return;
        }
        if (req.method === "GET" && parts.length === 4) {
          await sendRef(id, parts[3], res);
          return;
        }
      }
      const result = await route(req.method ?? "GET", parts, req);
      if (result === null) {
        next();
        return;
      }
      sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      sendJson(res, 500, { error: error instanceof Error ? error.message : "Automation request failed." });
    }
  });
}
