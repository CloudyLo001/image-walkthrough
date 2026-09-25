/**
 * A reel project: one video, from idea to post. Shared by the page and the dev
 * server, so it must stay free of DOM and Node imports.
 */

export const STAGES = [
  { id: "idea", label: "Idea" },
  { id: "approved", label: "Hook & caption" },
  { id: "references", label: "References" },
  { id: "worlds", label: "Worlds" },
  { id: "clips", label: "Clips" },
  { id: "edit", label: "Edit" },
  { id: "audio", label: "Audio" },
  { id: "review", label: "Review" },
  { id: "exported", label: "Export" },
  { id: "posted", label: "Post" },
  { id: "measured", label: "Views" },
] as const;

export type StageId = (typeof STAGES)[number]["id"];

export const STAGE_IDS: readonly StageId[] = STAGES.map((stage) => stage.id);

export function isStageId(value: unknown): value is StageId {
  return typeof value === "string" && (STAGE_IDS as readonly string[]).includes(value);
}

export function stageIndex(stage: StageId) {
  return STAGE_IDS.indexOf(stage);
}

export function stageLabel(stage: StageId) {
  return STAGES[stageIndex(stage)].label;
}

/**
 * What is happening to the project right now. `waiting` means the next move is
 * the user's; `busy` means an agent job or a render is running.
 */
export interface ProjectActivity {
  label: string;
  tone: "waiting" | "busy" | "error";
  /** 0 to 100 when the job reports it; absent for an indeterminate bar. */
  percent?: number;
}

export interface Project {
  /** Folder name under automation/projects; never changes after creation. */
  id: string;
  name: string;
  /** The furthest stage reached. Earlier stages stay editable. */
  stage: StageId;
  /** The stage panel that was open last, so the project reopens where it was left. */
  openStage: StageId;
  activity?: ProjectActivity;
  /**
   * Stages reached before an earlier stage changed. Their work is kept, but
   * it was made for the old version, so they are flagged for a look.
   */
  checks?: StageId[];
  /** Per-stage content, filled in as each stage is built. */
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  trashedAt?: string;
}

/** The fields the page may change through an autosave. */
export type ProjectPatch = Partial<
  Pick<Project, "name" | "stage" | "openStage" | "activity" | "checks" | "data">
>;

/** The idea a project was started from, with the day file it came from. */
export type ProjectIdea = Idea & { date: string };

export const MAX_PROJECT_NAME = 80;

/** What a stage needs from the user once it becomes the current one. */
export function waitingLabel(stage: StageId): string {
  switch (stage) {
    case "idea":
      return "Waiting for you: choose the idea";
    case "approved":
      return "Waiting for you: pick a hook and caption";
    case "references":
      return "Waiting for you: pick reference images";
    case "worlds":
      return "Waiting for you: approve the credits";
    case "clips":
      return "Waiting for you: record or pick clips";
    case "edit":
      return "Waiting for you: finish the edit";
    case "audio":
      return "Waiting for you: pick the audio";
    case "review":
      return "Waiting for you: final review";
    case "exported":
      return "Waiting for you: export the video";
    case "posted":
      return "Waiting for you: post it";
    case "measured":
      return "Collecting views for 7 days";
  }
}

// ------------------------------------------------------------------- ideas

/** Where an idea sits in the mix: remixing a winner, revisiting, or new ground. */
export type IdeaTag = "proven" | "older" | "new" | "yours";

export interface IdeaRoom {
  name: string;
  /** One line on what the room should look like. */
  visual: string;
}

export interface Idea {
  /** Unique within its day's file. */
  id: string;
  title: string;
  tag: IdeaTag;
  /** The theme bucket from the mint-reels skill, e.g. "Celebrity houses". */
  bucket: string;
  /** Why it should work, e.g. the past post it remixes and how that did. */
  why: string;
  rooms: IdeaRoom[];
  /** Two draft on-screen hooks. */
  hooks: string[];
  /** Two draft captions, each 3–9 words plus 4–5 hashtags. */
  captions: string[];
  /** Ideas written before captions came in pairs have only this one. */
  caption?: string;
  audioHints: string[];
  /** The topic you typed, when the idea came from "Add my topic". */
  topic?: string;
  /** Set when the topic was typed inside a project, so it shows there first. */
  forProject?: string;
  /** Set once the idea has been turned into a project. */
  projectId?: string;
}

/** One day's research output, automation/ideas/<YYYY-MM-DD>.json. */
export interface IdeaDay {
  date: string;
  generatedAt: string;
  /** A sentence or two on what the research found that day. */
  summary?: string;
  ideas: Idea[];
}

/** One line of the research history: a day and what came of its ideas. */
export interface IdeaDaySummary {
  date: string;
  count: number;
  picked: number;
}

export const MAX_IDEAS_PER_DAY = 20;
export const MAX_TOPIC_LENGTH = 300;

// -------------------------------------------------------------------- jobs

/** Work for the Claude Code session watching automation/jobs.json. */
export type JobKind =
  | "research"
  | "ideate"
  | "hooks"
  | "suggest-audio"
  | "references"
  | "worlds"
  | "anchors"
  | "pick-shots"
  | "first-cut"
  | "post"
  | "metrics";

export type JobStatus = "requested" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  projectId?: string;
  input: Record<string, unknown>;
  /** Written by the agent while it works. */
  progress?: { label: string; percent?: number };
  error?: string;
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelledAt?: string;
}

export function isActiveJob(job: Job) {
  return job.status === "requested" || job.status === "running";
}

/** An idea's caption drafts, whichever format it was written in. */
export function ideaCaptions(idea: Pick<Idea, "captions" | "caption">): string[] {
  if (Array.isArray(idea.captions) && idea.captions.length) return idea.captions;
  return idea.caption ? [idea.caption] : [];
}

/** What a caption is made of, for checking it against the 3–9 words, 4–5 hashtags rule. */
export function captionCounts(caption: string) {
  const parts = caption.trim().split(/\s+/).filter(Boolean);
  const hashtags = parts.filter((part) => part.startsWith("#")).length;
  return { words: parts.length - hashtags, hashtags };
}

export function captionFits(caption: string) {
  const { words, hashtags } = captionCounts(caption);
  return words >= 3 && words <= 9 && hashtags >= 4 && hashtags <= 5;
}

// ------------------------------------------------------ stage 2: hook & caption

/**
 * More options Claude wrote when asked, on top of the idea's own two hooks and
 * two captions. Stored under project.data.hookOptions, which only the agent writes.
 */
export interface HookOptions {
  hooks: string[];
  captions: string[];
}

/**
 * What the user settled on, stored under project.data.approved, which only
 * the page writes. A pick is the index into the combined option list; null
 * once the text has been edited by hand.
 */
export interface HookAndCaption {
  hook: string;
  caption: string;
  hookPick: number | null;
  captionPick: number | null;
}

export const MAX_HOOK_LENGTH = 160;

/**
 * The hook's look: TikTok's default text, TikTok Sans in white with a black
 * outline. Sizes are fractions of the video width so the page preview and
 * the exported 1080-wide video match. Mirrored by .reel-hook in styles.css.
 */
export const REEL_HOOK_STYLE = {
  fontFamily: "TikTok Sans",
  fontWeight: 600,
  fill: "#ffffff",
  outline: "#000000",
  /** Font size as a share of the video width (56px on a 1080px video). */
  fontSize: 0.052,
  /** Stroke width as a share of the video width; half of it shows outside the letters. */
  outlineWidth: 0.009,
  lineHeight: 1.22,
} as const;
export const MAX_CAPTION_LENGTH = 220;

// --------------------------------------------------------- stage 3: references

/** Mint builds one world from up to this many photos; the first is the anchor. */
export const MAX_REFERENCES_PER_ROOM = 6;
/** Narrower than this and Mint's world tends to come out soft. */
export const SHARP_REFERENCE_WIDTH = 1200;
export const MAX_ROOMS = 4;

export interface ReferenceImage {
  /** The full-size image, which is what Mint gets. */
  url: string;
  /** A small copy for the page to show, so a room of originals loads quickly. */
  thumb?: string;
  /** The page the image came from, for credit and for checking it. */
  source?: string;
  title?: string;
  width?: number;
  height?: number;
  addedBy: "claude" | "you";
}

/** One room of the reel, which becomes one Mint world. */
export interface ReferenceRoom {
  /** Stable id, so renaming a room keeps its images. */
  key: string;
  name: string;
  visual: string;
  /** A skipped room keeps its picks but makes no world. */
  skipped?: boolean;
  /** Picked image URLs in order; the first is the anchor Mint builds from. */
  picked: string[];
  /** Images you added yourself, by link or upload. */
  own: ReferenceImage[];
}

/** Stage 3's result, stored under project.data.references, which only the page writes. */
export interface References {
  rooms: ReferenceRoom[];
}

/**
 * Candidates Claude found, keyed by room key. Stored under
 * project.data.referenceOptions, which only the agent writes.
 */
export type ReferenceOptions = Record<string, ReferenceImage[]>;

export function roomKey(name: string, taken: Iterable<string> = []) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "room";
  const used = new Set(taken);
  let key = base;
  for (let n = 2; used.has(key); n++) key = `${base}-${n}`;
  return key;
}

// ------------------------------------------------------------- stage 4: worlds

/**
 * What one world really costs: Mint charges a 150-credit preview and then the
 * 1,500-credit final (seen on the first build, 2026-09-25). Used until mint.json
 * says otherwise.
 */
export const DEFAULT_WORLD_CREDITS = 1650;
/** A sharpened anchor is one Mint image generation. */
export const DEFAULT_IMAGE_CREDITS = 100;
/** Mint charges credits at about this many US dollars each (1,500 credits = $1.20). */
export const USD_PER_CREDIT = 0.0008;
/** Anchors narrower than this get a sharp Mint-generated anchor by default. */
export const SHARPEN_BELOW_WIDTH = 1600;

export type WorldStatus = "queued" | "sharpening" | "generating" | "importing" | "ready" | "failed";

/**
 * How one room's world is getting on. Stored under project.data.worlds, keyed
 * by room key, which only the agent writes.
 */
export interface RoomWorld {
  status: WorldStatus;
  /** What is happening right now, in words. */
  label?: string;
  percent?: number;
  /** The key in worlds.config.json once registered; opens with ?world=<key>. */
  worldKey?: string;
  /** The Mint chat the world was made in. */
  chatUrl?: string;
  error?: string;
  /** Credits this room actually cost, once known. */
  credits?: number;
  /** When Mint started and finished, so the page shows the real time taken. */
  startedAt?: string;
  finishedAt?: string;
}

export type ProjectWorlds = Record<string, RoomWorld>;

/** One room as it was when you approved building it. */
export interface ApprovedRoom {
  key: string;
  name: string;
  visual: string;
  /** The anchor first, then up to five more; URLs as picked in stage 3. */
  images: string[];
  /** Generate a sharp anchor with Mint's image tool before the world. */
  sharpen: boolean;
}

/**
 * Your go-ahead to spend credits. Stored under project.data.worldsApproval,
 * which only the page writes; each Build or Try again adds one.
 */
export interface WorldsApproval {
  approvedAt: string;
  rooms: ApprovedRoom[];
  /** The credits shown in the confirm dialog. */
  credits: number;
}

/** The Mint balance and prices as last seen by the agent, from automation/mint.json. */
export interface MintInfo {
  available?: number;
  worldCredits?: number;
  previewCredits?: number;
  /** One Mint image generation, which is what sharpening an anchor costs. */
  imageCredits?: number;
  updatedAt?: string;
}

/** A local calendar date, since "today's ideas" means the user's day. */
export function localDate(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
