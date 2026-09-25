import type { PendingStatus, PendingWorld, WorldEntry } from "./registry";
import { isDraft, isRemovable, isStoppable, uploadName, worldPhotoNames } from "./registry";

export interface UploadRecord {
  name: string;
  size: number;
  modifiedAt: number;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id} in index.html`);
  return element as T;
}

export const ui = {
  canvas: requireElement<HTMLCanvasElement>("scene"),
  lobby: requireElement<HTMLDivElement>("lobby"),
  navWorlds: requireElement<HTMLButtonElement>("nav-worlds"),
  navAutomation: requireElement<HTMLButtonElement>("nav-automation"),
  worldsPage: requireElement<HTMLDivElement>("worlds-page"),
  automationPage: requireElement<HTMLDivElement>("automation-page"),
  drop: requireElement<HTMLLabelElement>("drop"),
  fileInput: requireElement<HTMLInputElement>("file-input"),
  uploadNote: requireElement<HTMLParagraphElement>("upload-note"),
  uploads: requireElement<HTMLUListElement>("uploads"),
  progress: requireElement<HTMLUListElement>("progress"),
  worlds: requireElement<HTMLUListElement>("worlds"),
  photosBox: requireElement<HTMLElement>("photos-box"),
  progressBox: requireElement<HTMLElement>("progress-box"),
  worldsBox: requireElement<HTMLElement>("worlds-box"),
  photosCount: requireElement<HTMLSpanElement>("photos-count"),
  progressCount: requireElement<HTMLSpanElement>("progress-count"),
  worldsCount: requireElement<HTMLSpanElement>("worlds-count"),
  hud: requireElement<HTMLDivElement>("hud"),
  status: requireElement<HTMLDivElement>("status"),
  hint: requireElement<HTMLSpanElement>("hint"),
  retry: requireElement<HTMLButtonElement>("retry"),
  record: requireElement<HTMLButtonElement>("record"),
  exit: requireElement<HTMLButtonElement>("exit"),
  exportBox: requireElement<HTMLDivElement>("export"),
  exportTitle: requireElement<HTMLDivElement>("export-title"),
  exportDetail: requireElement<HTMLDivElement>("export-detail"),
  exportFill: requireElement<HTMLDivElement>("export-fill"),
  exportCancel: requireElement<HTMLButtonElement>("export-cancel"),
  exportSave: requireElement<HTMLButtonElement>("export-save"),
  exportClose: requireElement<HTMLButtonElement>("export-close"),
  hudToggle: requireElement<HTMLButtonElement>("hud-toggle"),
  lookPrompt: requireElement<HTMLTextAreaElement>("look-prompt"),
  importBox: requireElement<HTMLDivElement>("import"),
  importInput: requireElement<HTMLInputElement>("import-link"),
  importAdd: requireElement<HTMLButtonElement>("import-add"),
  batchBar: requireElement<HTMLDivElement>("batch-bar"),
  batchSummary: requireElement<HTMLSpanElement>("batch-summary"),
  batchClear: requireElement<HTMLButtonElement>("batch-clear"),
  batchGenerate: requireElement<HTMLButtonElement>("batch-generate"),
};

export type StatusTone = "info" | "ok" | "error";

let statusTimer: number | undefined;

export function setStatus(message: string | null, tone: StatusTone = "info", hideAfterMs?: number) {
  window.clearTimeout(statusTimer);
  if (!message) {
    ui.status.hidden = true;
    return;
  }
  ui.status.textContent = message;
  ui.status.className = `status${tone === "info" ? "" : ` ${tone}`}`;
  ui.status.hidden = false;
  if (hideAfterMs) {
    statusTimer = window.setTimeout(() => {
      ui.status.hidden = true;
    }, hideAfterMs);
  }
}

export function setUploadNote(message: string | null, isError = false) {
  ui.uploadNote.textContent = message ?? "";
  ui.uploadNote.className = `note${isError ? " error" : ""}`;
  ui.uploadNote.hidden = !message;
}

/**
 * Without the dev server there is nothing to upload to and nothing to queue,
 * so hide the authoring controls rather than leave dead buttons on the page.
 */
export function setAuthoringAvailable(available: boolean) {
  ui.drop.hidden = !available;
  ui.lookPrompt.closest("label")?.toggleAttribute("hidden", !available);
  ui.importBox.hidden = !available;
}

export function showLobby(visible: boolean) {
  ui.lobby.hidden = !visible;
  ui.hud.hidden = visible;
}

export type Section = "worlds" | "automation";

/** The lobby holds two pages under one header; the nav picks which one shows. */
export function showSection(section: Section) {
  ui.worldsPage.hidden = section !== "worlds";
  ui.automationPage.hidden = section !== "automation";
  for (const [button, own] of [
    [ui.navWorlds, "worlds"],
    [ui.navAutomation, "automation"],
  ] as const) {
    if (own === section) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}

/** Automation writes to local files, so the read-only build has no use for it. */
export function setAutomationAvailable(available: boolean) {
  ui.navWorlds.closest("nav")?.toggleAttribute("hidden", !available);
}

export type LookMode = "idle" | "locked" | "drag";

let currentLookMode: LookMode = "idle";

function renderHint() {
  const locked = currentLookMode === "locked";
  ui.hud.classList.toggle("locked", locked);
  ui.canvas.classList.toggle("locked", locked);
  const parts = [
    locked ? null : currentLookMode === "drag" ? "Drag to look" : "Click to look",
    "WASD fly",
    "Shift faster",
    "←→ turn",
    "↑↓ up/down",
    locked ? "Esc release" : null,
  ];
  ui.hint.textContent = parts.filter(Boolean).join(" · ");
}

export function setLookMode(mode: LookMode) {
  currentLookMode = mode;
  renderHint();
}

/** Fade the bottom bar out of the way while the player is moving. */
export function setMoving(moving: boolean) {
  ui.hud.classList.toggle("moving", moving);
}

/** The Record button becomes Done while a flight is being captured. */
export function setRecording(recording: boolean) {
  ui.record.classList.toggle("recording", recording);
  ui.record.textContent = recording ? "Done" : "Record";
  ui.record.title = recording
    ? "Stop recording and render the video (R)"
    : "Record a flight, then render it as a video (R)";
}

export function formatClock(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export interface ExportView {
  state: "rendering" | "done" | "error";
  title: string;
  detail: string;
  /** 0 to 1. */
  progress: number;
}

/** The dialog that follows a render from first frame to saved file. */
export function showExport(view: ExportView) {
  ui.exportBox.hidden = false;
  ui.exportBox.className = `export${view.state === "rendering" ? "" : ` ${view.state}`}`;
  ui.exportTitle.textContent = view.title;
  ui.exportDetail.textContent = view.detail;
  ui.exportFill.style.width = `${Math.round(Math.min(1, Math.max(0, view.progress)) * 100)}%`;
  ui.exportCancel.hidden = view.state !== "rendering";
  ui.exportSave.hidden = view.state !== "done";
  ui.exportClose.hidden = view.state === "rendering";
}

export function hideExport() {
  ui.exportBox.hidden = true;
}

/** Collapse the bottom bar to its handle, or bring the controls back. */
export function setHudCollapsed(collapsed: boolean) {
  ui.hud.classList.toggle("collapsed", collapsed);
  ui.hudToggle.textContent = collapsed ? "▴" : "▾";
  ui.hudToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  const label = collapsed ? "Show the bar" : "Hide the bar";
  ui.hudToggle.title = label;
  ui.hudToggle.setAttribute("aria-label", label);
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface ItemAction {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

function item(input: {
  thumbnail?: string;
  title: string;
  subtitle?: string;
  chip?: { label: string; tone?: "ok" | "busy" | "error" };
  /** A second, quieter line under the subtitle. */
  detail?: string;
  actions?: ItemAction[];
  select?: { name: string; checked: boolean; disabled: boolean; onToggle: () => void };
}) {
  const li = document.createElement("li");
  li.className = input.select ? "item selectable" : "item";

  if (input.select) {
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "item-check";
    check.id = `sel-${input.select.name}`;
    check.checked = input.select.checked;
    check.disabled = input.select.disabled;
    check.addEventListener("change", input.select.onToggle);
    li.append(check);
  }

  if (input.thumbnail) {
    const img = document.createElement("img");
    img.src = input.thumbnail;
    img.alt = "";
    img.loading = "lazy";
    li.append(img);
  } else {
    const empty = document.createElement("div");
    empty.className = "thumb-empty";
    li.append(empty);
  }

  const text = document.createElement("div");
  text.className = "item-text";
  const title = document.createElement("div");
  title.className = "item-title";
  title.textContent = input.title;
  text.append(title);
  if (input.subtitle) {
    const sub = document.createElement("div");
    sub.className = "item-sub";
    sub.textContent = input.subtitle;
    text.append(sub);
  }
  if (input.detail) {
    const detail = document.createElement("div");
    detail.className = "item-detail";
    detail.textContent = input.detail;
    detail.title = input.detail;
    text.append(detail);
  }
  li.append(text);

  const actions = document.createElement("div");
  actions.className = "item-actions";
  if (input.chip) {
    const chip = document.createElement("span");
    chip.className = `chip${input.chip.tone ? ` ${input.chip.tone}` : ""}`;
    chip.textContent = input.chip.label;
    actions.append(chip);
  }
  (input.actions ?? []).forEach((action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn${action.primary ? " primary" : ""}`;
    button.textContent = action.label;
    button.addEventListener("click", action.onClick);
    actions.append(button);
  });
  li.append(actions);
  return li;
}

const PENDING_LABELS: Record<PendingStatus, { label: string; tone?: "busy" | "error" }> = {
  draft: { label: "Not started" },
  requested: { label: "Requested", tone: "busy" },
  queued: { label: "Queued", tone: "busy" },
  generating: { label: "Generating", tone: "busy" },
  importing: { label: "Importing", tone: "busy" },
  failed: { label: "Generation failed", tone: "error" },
  cancelled: { label: "Stopped", tone: "error" },
};

function photoCountLabel(count: number) {
  return count === 1 ? "1 photo" : `${count} photos`;
}

export interface RenderListsInput {
  uploads: UploadRecord[];
  readyWorlds: WorldEntry[];
  pendingWorlds: PendingWorld[];
  /** Upload names in tick order; the first is the anchor. */
  selection: string[];
  selectionFull: boolean;
  onEnter: (world: WorldEntry) => void;
  onStop: (world: PendingWorld) => void;
  onRemove: (world: PendingWorld) => void;
  onGenerateWorld: (world: PendingWorld) => void;
  onGenerate: (upload: UploadRecord) => void;
  onToggleSelect: (name: string) => void;
}

export function renderLists(input: RenderListsInput) {
  // Keyboard focus must survive the five-second poll re-render.
  const activeId = document.activeElement?.id;

  const anchorOf = new Map<string, { ready?: WorldEntry; pending?: PendingWorld }>();
  const claimedBy = new Map<string, string>();
  const indexWorld = (key: string, names: string[], slot: "ready" | "pending", world: unknown) => {
    names.forEach((name, index) => {
      if (!claimedBy.has(name)) claimedBy.set(name, key);
      if (index === 0 && !anchorOf.has(name)) {
        anchorOf.set(name, slot === "ready"
          ? { ready: world as WorldEntry }
          : { pending: world as PendingWorld });
      }
    });
  };
  input.readyWorlds.forEach((world) =>
    indexWorld(world.key, worldPhotoNames(world), "ready", world),
  );
  input.pendingWorlds.forEach((world) =>
    indexWorld(world.key, worldPhotoNames(world), "pending", world),
  );

  const readyItem = (world: WorldEntry, thumbnail?: string) =>
    item({
      thumbnail: thumbnail ?? world.thumbnailUrl,
      title: world.title,
      subtitle:
        world.sourceImages.length > 1
          ? photoCountLabel(world.sourceImages.length)
          : uploadName(world.sourceImage),
      detail: world.lookPrompt,
      chip: { label: "Ready", tone: "ok" },
      actions: [{ label: "Enter", primary: true, onClick: () => input.onEnter(world) }],
    });

  const pendingItem = (world: PendingWorld, thumbnail?: string) => {
    const { label, tone } = PENDING_LABELS[world.status];
    const actions: ItemAction[] = [];
    if (isDraft(world.status)) {
      actions.push({ label: "Ungroup", onClick: () => input.onRemove(world) });
      actions.push({
        label: "Generate",
        primary: true,
        onClick: () => input.onGenerateWorld(world),
      });
    } else if (isStoppable(world.status)) {
      actions.push({ label: "Stop", onClick: () => input.onStop(world) });
    } else if (isRemovable(world.status)) {
      actions.push({ label: "Remove", onClick: () => input.onRemove(world) });
    }
    return item({
      thumbnail,
      title: world.title,
      subtitle: world.note ?? photoCountLabel(world.sourceImages.length),
      detail: world.lookPrompt,
      chip: { label, tone },
      actions,
    });
  };

  // Each row lands in exactly one box: photos you can still act on, worlds
  // being built, and finished environments.
  const photoRows: HTMLLIElement[] = [];
  const progressRows: HTMLLIElement[] = [];
  const worldRows: HTMLLIElement[] = [];
  const rendered = new Set<string>();
  /** A ready world's own photo makes a better thumbnail than the Mint preview. */
  const readyThumbnails = new Map<string, string>();

  const placePending = (world: PendingWorld, thumbnail?: string) => {
    rendered.add(world.key);
    const row = pendingItem(world, thumbnail);
    // A draft is a grouping you still have to start, so it stays with photos.
    (isDraft(world.status) ? photoRows : progressRows).push(row);
  };

  input.uploads.forEach((upload) => {
    const thumbnail = `/uploads/${encodeURIComponent(upload.name)}`;
    const anchored = anchorOf.get(upload.name);
    if (anchored?.ready) {
      readyThumbnails.set(anchored.ready.key, thumbnail);
      return;
    }
    if (anchored?.pending) {
      placePending(anchored.pending, thumbnail);
      return;
    }
    // A non-anchor member is already shown inside its world's row.
    if (claimedBy.has(upload.name)) return;

    const selectedAt = input.selection.indexOf(upload.name);
    const selected = selectedAt !== -1;
    photoRows.push(
      item({
        thumbnail,
        title: upload.name,
        subtitle: formatBytes(upload.size),
        chip: selectedAt === 0 ? { label: "Anchor" } : undefined,
        select: {
          name: upload.name,
          checked: selected,
          disabled: !selected && input.selectionFull,
          onToggle: () => input.onToggleSelect(upload.name),
        },
        actions: selected
          ? []
          : [{ label: "Generate", primary: true, onClick: () => input.onGenerate(upload) }],
      }),
    );
  });

  // Pending worlds with no upload row of their own, including any whose photo
  // was deleted.
  input.pendingWorlds
    .filter((world) => !rendered.has(world.key))
    .forEach((world) => placePending(world));
  // Ready worlds keep the order they came in, newest first, whatever their source.
  input.readyWorlds.forEach((world) =>
    worldRows.push(readyItem(world, readyThumbnails.get(world.key))),
  );

  ui.uploads.replaceChildren(...photoRows);
  ui.progress.replaceChildren(...progressRows);
  ui.worlds.replaceChildren(...worldRows);

  const fill = (
    box: HTMLElement,
    count: HTMLSpanElement,
    rows: HTMLLIElement[],
    alwaysShow = false,
  ) => {
    box.hidden = rows.length === 0 && !alwaysShow;
    count.textContent = rows.length > 0 ? String(rows.length) : "";
  };
  // The photos box stays visible while a selection is live so the bar has a home.
  fill(ui.photosBox, ui.photosCount, photoRows, input.selection.length > 0);
  fill(ui.progressBox, ui.progressCount, progressRows);
  fill(ui.worldsBox, ui.worldsCount, worldRows);

  if (activeId?.startsWith("sel-")) document.getElementById(activeId)?.focus();
}

/** The bar that turns a tick-selection into one world. */
export function renderBatchBar(state: { count: number; max: number; anchor?: string }) {
  ui.batchBar.hidden = state.count === 0;
  if (state.count === 0) return;
  const parts = [state.anchor ? `Anchor: ${state.anchor}` : null];
  if (state.count >= state.max) {
    parts.push(`${state.max} of ${state.max}, the most one world can use.`);
  }
  ui.batchSummary.textContent = parts.filter(Boolean).join(" · ");
  ui.batchGenerate.textContent = `Generate 1 world from ${photoCountLabel(state.count)}`;
}
