import { button, el, formatTime } from "./dom";
import { jobLine } from "./ideas";
import { referencesOf, optionsOf } from "./references-stage";
import {
  DEFAULT_IMAGE_CREDITS,
  DEFAULT_WORLD_CREDITS,
  SHARPEN_BELOW_WIDTH,
  USD_PER_CREDIT,
  type ApprovedRoom,
  type Job,
  type MintInfo,
  type Project,
  type ProjectWorlds,
  type ReferenceImage,
  type ReferenceRoom,
  type RoomWorld,
  type WorldsApproval,
  type WorldStatus,
} from "./types";

export interface WorldsStageInput {
  project: Project;
  editable: boolean;
  mint: MintInfo;
  /** This project's "worlds" jobs, oldest first. */
  jobs: Job[];
  /** Sharpen choices you've made before approving, keyed by room key. */
  sharpen: Map<string, boolean>;
  onSharpen: (key: string, on: boolean) => void;
  /** Ask for the go-ahead and queue the build; the page shows the confirm dialog. */
  onBuild: (rooms: ApprovedRoom[], credits: number) => void;
  onContinue: () => void;
  onCancelJob: (id: string) => void;
}

const STATUS_LABELS: Record<WorldStatus, string> = {
  queued: "Waiting to start",
  sharpening: "Making a sharp anchor",
  generating: "Mint is building the world",
  importing: "Adding it to Nostalgic Engine",
  ready: "Ready",
  failed: "Failed",
};

export function worldCredits(mint: MintInfo) {
  return mint.worldCredits ?? DEFAULT_WORLD_CREDITS;
}

export function worldsOf(project: Project): ProjectWorlds {
  return (project.data.worlds as ProjectWorlds | undefined) ?? {};
}

export function approvalsOf(project: Project): WorldsApproval[] {
  return (project.data.worldsApproval as WorldsApproval[] | undefined) ?? [];
}

/** The rooms that will become worlds: every kept room with at least one pick. */
function buildableRooms(project: Project) {
  return referencesOf(project).rooms.filter((room) => !room.skipped && room.picked.length > 0);
}

/** Everything known about an image the room picked, whoever added it. */
function imageInfo(project: Project, room: ReferenceRoom, url: string): ReferenceImage {
  const found = [...(optionsOf(project)[room.key] ?? []), ...room.own].find((image) => image.url === url);
  return found ?? { url, addedBy: "you" };
}

function isLocal(url: string) {
  return !/^https?:\/\//i.test(url);
}

export function worldsDone(project: Project) {
  const worlds = worldsOf(project);
  const rooms = buildableRooms(project);
  return rooms.length > 0 && rooms.every((room) => worlds[room.key]?.status === "ready");
}

function credits(n: number) {
  return `${n.toLocaleString()} credits (about $${(n * USD_PER_CREDIT).toFixed(2)})`;
}

/**
 * Stage 4: the credit check, your go-ahead, then each room's world as Mint
 * builds it. Nothing is spent until you confirm.
 */
export function worldsStage(input: WorldsStageInput): HTMLElement[] {
  const { project, editable, mint } = input;
  const rooms = buildableRooms(project);
  const worlds = worldsOf(project);
  const perWorld = worldCredits(mint);
  const activeJob = input.jobs.find((job) => job.status === "requested" || job.status === "running");
  const nodes: HTMLElement[] = [];

  if (rooms.length === 0) {
    nodes.push(el("p", "stage-panel-plan", "No rooms have images yet. Go back to References and pick some."));
    return nodes;
  }

  const unbuilt = rooms.filter((room) => {
    const status = worlds[room.key]?.status;
    return !status || status === "failed";
  });

  nodes.push(
    el(
      "p",
      "stage-panel-plan",
      `Each room becomes one Mint world. All rooms build at the same time, each in its own Mint chat, so the whole set takes about as long as one world: usually four to six minutes. Mint can't cancel a world once it starts, so nothing is spent until you confirm.`,
    ),
  );

  const list = el("div", "world-list");
  rooms.forEach((room) => list.append(roomRow(room, worlds[room.key], input)));
  nodes.push(list);

  if (activeJob) nodes.push(jobLine(activeJob, activeJob.status === "requested" ? () => input.onCancelJob(activeJob.id) : undefined));

  if (editable && unbuilt.length > 0 && !activeJob) {
    const sharpened = unbuilt.filter((room) => sharpenFor(room, input)).length;
    const perImage = mint.imageCredits ?? DEFAULT_IMAGE_CREDITS;
    const cost = unbuilt.length * perWorld + sharpened * perImage;
    const summary = el("div", "cost-box");
    const worldsPart = `${unbuilt.length} ${unbuilt.length === 1 ? "world" : "worlds"} × ${perWorld.toLocaleString()}`;
    const imagesPart = sharpened ? ` + ${sharpened} sharp ${sharpened === 1 ? "anchor" : "anchors"} × ${perImage}` : "";
    const line = el("p", "cost-line", `${worldsPart}${imagesPart} = ${credits(cost)}`);
    summary.append(line);
    const balance = mint.available;
    if (balance !== undefined) {
      const after = balance - cost;
      summary.append(
        el(
          "p",
          `cost-balance${after < 0 ? " short" : ""}`,
          `Balance ${balance.toLocaleString()}${mint.updatedAt ? ` (checked ${formatTime(mint.updatedAt)})` : ""} → about ${after.toLocaleString()} after.`,
        ),
      );
    }
    summary.append(
      el("p", "cost-note", `Each world is a ${(mint.previewCredits ?? 150).toLocaleString()}-credit preview plus the final build; a sharp anchor is one Mint image.`),
    );
    if (unbuilt.some((room) => room.picked.some(isLocal))) {
      summary.append(
        el(
          "p",
          "cost-note",
          "Some picks are files you pasted or uploaded. They're only on this computer, so Claude will ask you before hosting them where Mint can see them.",
        ),
      );
    }
    const build = button(
      `Build ${unbuilt.length} ${unbuilt.length === 1 ? "world" : "worlds"}`,
      "btn primary",
      () => input.onBuild(unbuilt.map((room) => approvedRoom(room, input)), cost),
    );
    if (balance !== undefined && balance < cost) {
      build.disabled = true;
      summary.append(el("p", "cost-balance short", "Not enough credits. Top up in Mint first."));
    }
    const actions = el("div", "stage-panel-actions");
    actions.append(build);
    summary.append(actions);
    nodes.push(summary);
  }

  if (editable && worldsDone(project)) {
    const actions = el("div", "stage-panel-actions");
    actions.append(button("Continue to clips", "btn primary", input.onContinue));
    nodes.push(actions);
  }
  return nodes;
}

/** "Took 9 min" once done, or "Running 4 min" while Mint works; from Claude's timestamps. */
function timing(world: RoomWorld) {
  if (!world.startedAt) return null;
  const start = Date.parse(world.startedAt);
  const end = world.finishedAt ? Date.parse(world.finishedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const minutes = Math.max(1, Math.round((end - start) / 60_000));
  if (world.finishedAt) return world.status === "failed" ? `Stopped after ${minutes} min` : `Took ${minutes} min`;
  return `Running ${minutes} min`;
}

function sharpenFor(room: ReferenceRoom, input: WorldsStageInput) {
  const chosen = input.sharpen.get(room.key);
  if (chosen !== undefined) return chosen;
  const anchor = imageInfo(input.project, room, room.picked[0]);
  // Unknown size counts as small: a soft world costs more to redo than a sharp anchor.
  return !anchor.width || anchor.width < SHARPEN_BELOW_WIDTH;
}

function approvedRoom(room: ReferenceRoom, input: WorldsStageInput): ApprovedRoom {
  return {
    key: room.key,
    name: room.name,
    visual: room.visual,
    images: room.picked.slice(0, 6),
    sharpen: sharpenFor(room, input),
  };
}

function roomRow(room: ReferenceRoom, world: RoomWorld | undefined, input: WorldsStageInput) {
  const { project, editable } = input;
  const row = el("div", `world-row${world ? ` ${world.status}` : ""}`);

  const thumbs = el("div", "world-thumbs");
  room.picked.slice(0, 6).forEach((url, index) => {
    const image = imageInfo(project, room, url);
    const img = el("img", index === 0 ? "anchor" : undefined);
    img.src = image.thumb ?? image.url;
    img.alt = index === 0 ? `${room.name} anchor` : "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    thumbs.append(img);
  });

  const text = el("div", "world-text");
  const anchor = imageInfo(project, room, room.picked[0]);
  const photos = room.picked.length;
  text.append(
    el("h4", "choice-title", room.name),
    el(
      "p",
      "choice-hint",
      `${photos} ${photos === 1 ? "photo" : "photos"} · anchor ${anchor.width ? `${anchor.width}×${anchor.height}` : "size unknown"}`,
    ),
  );

  if (world) {
    const status = el("div", "activity");
    status.dataset.tone = world.status === "failed" ? "error" : world.status === "ready" ? "waiting" : "busy";
    status.append(el("span", "activity-label", world.label ?? STATUS_LABELS[world.status]));
    const took = timing(world);
    if (took) status.append(el("span", "world-timing", took));
    if (world.status !== "ready" && world.status !== "failed") {
      const track = el("div", "activity-track");
      const fill = el("div", "activity-fill");
      if (world.percent === undefined) track.classList.add("indeterminate");
      else fill.style.width = `${world.percent}%`;
      track.append(fill);
      status.append(track);
    }
    if (world.error) status.append(el("p", "job-hint", world.error));
    text.append(status);
    const links = el("div", "world-links");
    if (world.status === "ready" && world.worldKey) {
      const open = el("a", "btn small", "Open world");
      open.href = `./?world=${encodeURIComponent(world.worldKey)}`;
      open.target = "_blank";
      open.rel = "noopener";
      links.append(open);
    }
    if (world.chatUrl) {
      const chat = el("a", "btn ghost small", "Open in Mint");
      chat.href = world.chatUrl;
      chat.target = "_blank";
      chat.rel = "noopener noreferrer";
      links.append(chat);
    }
    if (links.childElementCount) text.append(links);
  } else if (editable) {
    const toggle = el("label", "auto-filter");
    const box = el("input");
    box.type = "checkbox";
    box.checked = sharpenFor(room, input);
    box.addEventListener("change", () => input.onSharpen(room.key, box.checked));
    toggle.append(
      box,
      document.createTextNode(
        anchor.width && anchor.width >= SHARPEN_BELOW_WIDTH
          ? "Sharpen the anchor first"
          : "Sharpen the anchor first (recommended: it's small, so the world may come out soft)",
      ),
    );
    text.append(toggle);
  }

  row.append(thumbs, text);
  return row;
}
