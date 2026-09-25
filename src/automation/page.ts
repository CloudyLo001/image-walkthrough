import * as api from "./api";
import type { Shelf } from "./api";
import { button, el, formatDate, formatTime, isTypingIn } from "./dom";
import { choiceProblem, currentChoice, hookStage } from "./hook-stage";
import { referencesOf, referencesProblem, referencesStage } from "./references-stage";
import { approvalsOf, worldsDone, worldsOf, worldsStage } from "./worlds-stage";
import { ideaCard, ideaPanel, ideasTab, type IdeaFilter } from "./ideas";
import {
  STAGES,
  stageIndex,
  stageLabel,
  waitingLabel,
  MAX_PROJECT_NAME,
  MAX_TOPIC_LENGTH,
  MAX_REFERENCES_PER_ROOM,
  USD_PER_CREDIT,
  type ApprovedRoom,
  type MintInfo,
  type ProjectWorlds,
  type WorldsApproval,
  type IdeaDay,
  type IdeaDaySummary,
  type Job,
  type Project,
  type ProjectIdea,
  type ReferenceRoom,
  type References,
  type StageId,
} from "./types";

const POLL_MS = 2000;
const SAVE_DEBOUNCE_MS = 600;
const RETRY_MS = 3000;
const TAB_KEY = "automation-tab";

/** What each stage will do once it is built; shown in its panel until then. */
const STAGE_PLANS: Record<StageId, string> = {
  idea: "Pick an idea from today's research, or add your own topic.",
  approved: "Choose one of two hooks and two captions, or edit them.",
  references: "The agent finds a few images per room, and you pick one or more.",
  worlds: "Approve the credits, then Mint builds a world for each room.",
  clips: "Record camera paths in 16:9 or 9:16, then render them at full detail.",
  edit: "Cut, reorder, crop, speed up to 4× and place the hook.",
  audio: "Pick one of the suggested sounds and line it up with the cuts.",
  review: "Watch the whole reel and check the caption.",
  exported: "Export the mp4, a silent copy and a cover image.",
  posted: "Post to TikTok, YouTube Shorts and Instagram.",
  measured: "Views are collected every 24 hours for 7 days.",
};

type Tab = "ideas" | Shelf;

const TAB_LABELS: Record<Tab, string> = {
  ideas: "Ideas",
  projects: "Projects",
  archive: "Archive",
  trash: "Trash",
};

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "error"; message: string };

function isTab(value: unknown): value is Tab {
  return value === "ideas" || value === "projects" || value === "archive" || value === "trash";
}

function topicField(id: string, placeholder: string) {
  const input = el("input", "look-input");
  input.id = id;
  input.type = "text";
  input.maxLength = MAX_TOPIC_LENGTH;
  input.autocomplete = "off";
  input.placeholder = placeholder;
  return input;
}

/**
 * Collects edits to one project and writes them after a short pause, so typing
 * a name is one save rather than one per key. A failed save keeps its changes
 * and tries again.
 */
class Saver {
  private pending: Record<string, unknown> = {};
  private timer: number | undefined;
  private inFlight: Promise<void> | null = null;

  constructor(
    readonly id: string,
    private readonly onSaved: (project: Project) => void,
    private readonly onState: (state: SaveState) => void,
  ) {}

  get busy() {
    return this.inFlight !== null || this.hasPending;
  }

  /** Edits made since the last save left, which the page must not overwrite. */
  get hasPending() {
    return Object.keys(this.pending).length > 0;
  }

  queue(patch: Record<string, unknown>, delay = SAVE_DEBOUNCE_MS) {
    Object.assign(this.pending, patch);
    this.onState({ kind: "saving" });
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), delay);
  }

  async flush() {
    window.clearTimeout(this.timer);
    if (this.inFlight) await this.inFlight;
    if (Object.keys(this.pending).length === 0) return;
    const patch = this.pending;
    this.pending = {};
    this.inFlight = (async () => {
      try {
        const saved = await api.patchProject(this.id, patch);
        if (Object.keys(this.pending).length === 0) this.onState({ kind: "idle" });
        this.onSaved(saved);
      } catch (error) {
        // Newer edits win over the ones being retried.
        this.pending = { ...patch, ...this.pending };
        this.onState({
          kind: "error",
          message: error instanceof Error ? error.message : "Could not save.",
        });
        this.timer = window.setTimeout(() => void this.flush(), RETRY_MS);
      }
    })();
    await this.inFlight;
    this.inFlight = null;
  }
}

interface OpenProject {
  shelf: Shelf;
  project: Project;
  saver: Saver | null;
  saveState: SaveState;
  /** Stage 1: whether the idea picker is showing, and the idea ticked in it. */
  pickerOpen: boolean;
  picked: string | null;
  /** Stage 4: sharpen choices made before approving, keyed by room. */
  sharpen: Map<string, boolean>;
  /** Parts of the project view that change without rebuilding it. */
  parts: {
    status: HTMLElement;
    stepper: HTMLElement;
    activity: HTMLElement;
    panel: HTMLElement;
    name: HTMLInputElement | null;
  };
}

/**
 * The Automation page: today's ideas, and every reel as its own project with
 * its stage and what it is waiting on. Everything saves as it changes.
 */
export class AutomationPage {
  private readonly body = el("div", "auto-body");
  private readonly dialog = el("dialog", "auto-dialog");
  /** Kept across redraws so a half-typed topic survives the poll. */
  private readonly topicInput = topicField("idea-topic", "Toys R Us at night, a 2006 mall food court…");
  private readonly projectTopicInput = topicField("project-topic", "Describe the place you want to film");
  private readonly hookNoteInput = topicField("hook-note", "funnier, shorter, mention the pool…");
  private tab: Tab = "projects";
  private waitingOnly = false;
  private lists: Record<Shelf, Project[]> = { projects: [], archive: [], trash: [] };
  private ideaDays: IdeaDaySummary[] = [];
  private latestDay: IdeaDay | null = null;
  /** The day shown on the Ideas tab; null means the newest. */
  private viewDate: string | null = null;
  private viewDay: IdeaDay | null = null;
  private jobs: Job[] = [];
  private mint: MintInfo = {};
  private selection = new Set<string>();
  private ideaFilter: IdeaFilter = "all";
  private loaded = false;
  private error: string | null = null;
  private open: OpenProject | null = null;
  private lastRendered = "";
  private lastPanelData = "";
  /** The project and stage the stepper last scrolled to, so it scrolls only on a change. */
  private stepperShownFor = "";
  /** A redraw skipped because the user was typing; done once they stop. */
  private redrawPending = false;
  private pollTimer: number | undefined;
  private polling = false;
  /** A ?project=<id> link opens that project once the list has loaded. */
  private pendingDeepLink: string | null = new URLSearchParams(location.search).get("project");

  constructor(
    root: HTMLElement,
    /** True while this page is the one on screen; polling pauses otherwise. */
    private readonly isShown: () => boolean,
  ) {
    const intro = el("div", "automation-intro");
    intro.append(
      el("h2", "automation-title", "Automation"),
      el("p", "automation-sub", "Turn worlds into 6–10 second reels, from idea to post."),
    );
    root.replaceChildren(intro, this.body, this.dialog);
    try {
      const saved = localStorage.getItem(TAB_KEY);
      if (isTab(saved)) this.tab = saved;
    } catch {
      // Storage can be unavailable; the page simply opens on Projects.
    }
    this.topicInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void this.addTopic();
    });
    this.projectTopicInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void this.addProjectTopic();
    });
    this.hookNoteInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && this.open) void this.askForHooks(this.open);
    });
    // Catch up on anything that changed while the user was typing.
    this.body.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (!this.redrawPending || isTypingIn(this.body)) return;
        this.redrawPending = false;
        if (this.open) this.renderPanel();
        else this.render(true);
      }, 0);
    });
    this.schedulePoll(0);
  }

  /** Called when the page comes on screen, so it never shows stale cards. */
  refresh() {
    this.schedulePoll(0);
  }

  private schedulePoll(delay = POLL_MS) {
    window.clearTimeout(this.pollTimer);
    this.pollTimer = window.setTimeout(() => void this.poll(), delay);
  }

  private async poll() {
    if (this.polling) return;
    if (!this.isShown()) {
      this.schedulePoll();
      return;
    }
    this.polling = true;
    try {
      const [projects, archive, trash, ideas, jobs, mint] = await Promise.all([
        api.listProjects("projects"),
        api.listProjects("archive"),
        api.listProjects("trash"),
        api.latestIdeas(),
        api.listJobs(),
        api.mintInfo().catch(() => ({})),
      ]);
      this.lists = { projects, archive, trash };
      this.ideaDays = ideas.days;
      this.latestDay = ideas.day;
      this.jobs = jobs;
      this.mint = mint;
      if (this.viewDate && this.viewDate !== ideas.day?.date) {
        this.viewDay = await api.ideaDay(this.viewDate);
      } else {
        this.viewDate = null;
        this.viewDay = ideas.day;
      }
      // Ideas that became projects can no longer be picked.
      const free = new Set(this.viewDay?.ideas.filter((idea) => !idea.projectId).map((idea) => idea.id));
      this.selection = new Set([...this.selection].filter((id) => free.has(id)));
      this.loaded = true;
      this.error = null;
      this.followDeepLink();
      this.syncOpenProject();
    } catch (error) {
      this.error = error instanceof Error ? error.message : "The dev server did not answer.";
    } finally {
      this.polling = false;
      this.render();
      this.schedulePoll();
    }
  }

  private followDeepLink() {
    if (!this.pendingDeepLink) return;
    const project = this.lists.projects.find((entry) => entry.id === this.pendingDeepLink);
    this.pendingDeepLink = null;
    if (project) this.openProject("projects", project);
    else this.setProjectParam(null);
  }

  /** Pick up changes an agent made to the open project, unless an edit is still saving. */
  private syncOpenProject() {
    const open = this.open;
    if (!open) return;
    if (!open.saver?.busy) {
      const fresh = this.lists[open.shelf].find((entry) => entry.id === open.project.id);
      if (!fresh) {
        // Moved or deleted elsewhere; there is nothing left to show.
        this.closeProject();
        return;
      }
      // Only a newer copy wins: a poll that started before a save can land after it.
      if (fresh.updatedAt > open.project.updatedAt) {
        open.project = fresh;
        this.updateProjectView();
        return;
      }
    }
    // New ideas or job progress change the panel even when the project didn't.
    if (this.panelDataKey() !== this.lastPanelData) {
      this.renderPanel();
    }
  }

  // ---------------------------------------------------------------- home view

  private render(force = false) {
    // The open project redraws itself when it changes (see syncOpenProject);
    // redrawing it on every poll would steal focus from its buttons.
    if (this.open) return;
    const key = JSON.stringify([
      this.tab,
      this.waitingOnly,
      this.loaded,
      this.error,
      this.lists,
      this.ideaFilter,
      [...this.selection],
      this.viewDay,
      this.ideaDays,
      this.jobs,
    ]);
    if (key === this.lastRendered && !force) return;
    if (isTypingIn(this.body)) {
      this.redrawPending = true;
      return;
    }
    this.lastRendered = key;
    this.renderHome();
  }

  private setTab(tab: Tab) {
    this.tab = tab;
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      // Not remembering the tab is harmless.
    }
    this.render(true);
  }

  private renderHome() {
    const head = el("div", "auto-head");
    const tabs = el("div", "auto-tabs");
    tabs.setAttribute("role", "tablist");
    (["ideas", "projects", "archive", "trash"] as const).forEach((tab) => {
      const count = tab === "ideas" ? this.freeIdeaCount() : this.lists[tab].length;
      const node = button(count ? `${TAB_LABELS[tab]} ${count}` : TAB_LABELS[tab], "auto-tab", () =>
        this.setTab(tab),
      );
      node.setAttribute("role", "tab");
      node.setAttribute("aria-selected", String(this.tab === tab));
      tabs.append(node);
    });
    head.append(tabs);

    if (this.tab === "projects") {
      const actions = el("div", "auto-actions");
      const filter = el("label", "auto-filter");
      const box = el("input");
      box.type = "checkbox";
      box.checked = this.waitingOnly;
      box.addEventListener("change", () => {
        this.waitingOnly = box.checked;
        this.render();
      });
      filter.append(box, document.createTextNode("Waiting on you"));
      actions.append(filter, button("New project", "btn primary", () => void this.newProject()));
      head.append(actions);
    }

    const nodes: HTMLElement[] = [head];
    if (this.error) nodes.push(el("p", "note error", this.error));
    if (!this.loaded) {
      nodes.push(el("p", "empty", "Loading…"));
    } else if (this.tab === "ideas") {
      nodes.push(...this.ideasView());
    } else {
      let shown = this.lists[this.tab];
      if (this.tab === "projects" && this.waitingOnly) {
        shown = shown.filter((project) => project.activity?.tone === "waiting");
      }
      if (shown.length === 0) {
        nodes.push(el("p", "empty", this.emptyText()));
      } else {
        const grid = el("div", "auto-grid");
        const shelf = this.tab;
        shown.forEach((project) => grid.append(this.card(shelf, project)));
        nodes.push(grid);
      }
    }
    this.body.replaceChildren(...nodes);
  }

  private freeIdeaCount() {
    return this.latestDay?.ideas.filter((idea) => !idea.projectId).length ?? 0;
  }

  private ideasView() {
    const projectNames = new Map(this.lists.projects.map((project) => [project.id, project.name]));
    return ideasTab({
      days: this.ideaDays,
      day: this.viewDay,
      jobs: this.jobs,
      projectNames,
      selection: this.selection,
      filter: this.ideaFilter,
      topicInput: this.topicInput,
      onResearch: () => void this.startJob("research"),
      onDate: (date) => void this.showDay(date),
      onToggle: (id) => {
        if (this.selection.has(id)) this.selection.delete(id);
        else this.selection.add(id);
        this.render(true);
      },
      onFilter: (filter) => {
        this.ideaFilter = filter;
        this.render(true);
      },
      onStart: () => void this.startProjects(),
      onClear: () => {
        this.selection.clear();
        this.render(true);
      },
      onAddTopic: () => void this.addTopic(),
      onCancelJob: (id) => void this.cancelJob(id),
      onOpenProject: (id) => {
        const project = this.lists.projects.find((entry) => entry.id === id);
        if (project) this.openProject("projects", project);
      },
    });
  }

  private emptyText() {
    if (this.tab === "archive") return "Posted reels move here, under their project name.";
    if (this.tab === "trash") return "Deleted projects wait here until you restore them.";
    if (this.waitingOnly) return "Nothing is waiting on you right now.";
    return "No reel projects yet. Pick ideas on the Ideas tab, or start one with New project.";
  }

  private card(shelf: Shelf, project: Project) {
    const card = el("article", `auto-card${shelf === "projects" ? "" : " muted"}`);
    card.append(
      el("h3", "auto-card-title", project.name),
      el("div", "auto-card-meta", this.metaText(shelf, project)),
      this.stageBar(project, shelf === "projects" ? (stage) => this.openProject(shelf, project, stage) : null),
      this.activityLine(project),
    );
    const actions = el("div", "auto-card-actions");
    if (shelf === "projects") {
      actions.append(
        button("Delete", "btn ghost", () => void this.confirmTrash(project)),
        button("Open", "btn primary", () => this.openProject(shelf, project)),
      );
    } else if (shelf === "archive") {
      actions.append(button("Open", "btn", () => this.openProject(shelf, project)));
    } else {
      actions.append(button("Restore", "btn", () => void this.restore(project)));
    }
    card.append(actions);
    return card;
  }

  private metaText(shelf: Shelf, project: Project) {
    if (shelf === "archive" && project.archivedAt) return `Archived ${formatDate(project.archivedAt)}`;
    if (shelf === "trash" && project.trashedAt) return `Deleted ${formatDate(project.trashedAt)}`;
    return `Started ${formatDate(project.createdAt)} · Saved ${formatTime(project.updatedAt)}`;
  }

  /** Eleven segments: done, current, and not reached. Clickable up to the current one. */
  private stageBar(project: Project, onPick: ((stage: StageId) => void) | null) {
    const bar = el("div", "stage-bar");
    const current = stageIndex(project.stage);
    STAGES.forEach((stage, index) => {
      const segment = el("button", "stage-seg");
      segment.type = "button";
      segment.dataset.state = index < current ? "done" : index === current ? "current" : "todo";
      if (project.checks?.includes(stage.id)) segment.dataset.check = "true";
      segment.title = `${index + 1}. ${stage.label}`;
      segment.setAttribute("aria-label", `Stage ${index + 1}, ${stage.label}`);
      segment.disabled = !onPick || index > current;
      if (onPick && index <= current) segment.addEventListener("click", () => onPick(stage.id));
      bar.append(segment);
    });
    const wrap = el("div", "stage-wrap");
    const checks = project.checks?.length ?? 0;
    wrap.append(
      bar,
      el(
        "div",
        "stage-caption",
        `Stage ${current + 1} of ${STAGES.length} · ${stageLabel(project.stage)}${checks ? ` · ${checks} to check` : ""}`,
      ),
    );
    return wrap;
  }

  private activityLine(project: Project) {
    const line = el("div", "activity");
    const activity = project.activity;
    if (!activity) {
      line.hidden = true;
      return line;
    }
    line.dataset.tone = activity.tone;
    line.append(el("span", "activity-label", activity.label));
    if (activity.tone === "busy") {
      const track = el("div", "activity-track");
      const fill = el("div", "activity-fill");
      if (activity.percent === undefined) track.classList.add("indeterminate");
      else fill.style.width = `${activity.percent}%`;
      track.append(fill);
      line.append(track);
    }
    return line;
  }

  // ------------------------------------------------------------ project view

  private openProject(shelf: Shelf, project: Project, stage?: StageId) {
    const saver =
      shelf === "projects"
        ? new Saver(
            project.id,
            (saved) => {
              if (this.open?.saver !== saver) return;
              // Newer edits are still waiting to save; keep them on screen.
              this.open.project = saver?.hasPending
                ? { ...this.open.project, updatedAt: saved.updatedAt }
                : saved;
              this.updateProjectView();
            },
            (state) => {
              if (this.open?.saver !== saver) return;
              this.open.saveState = state;
              this.updateStatus();
            },
          )
        : null;
    this.projectTopicInput.value = "";
    this.open = {
      shelf,
      project,
      saver,
      saveState: { kind: "idle" },
      pickerOpen: false,
      picked: null,
      sharpen: new Map(),
      parts: {
        status: el("span", "auto-save"),
        stepper: el("ol", "stepper"),
        activity: el("div"),
        panel: el("section", "stage-panel"),
        name: null,
      },
    };
    if (shelf === "projects") this.setProjectParam(project.id);
    this.buildProjectView();
    if (stage && stage !== project.openStage) this.viewStage(stage);
  }

  private closeProject() {
    const saver = this.open?.saver;
    if (saver) void saver.flush();
    this.open = null;
    this.lastRendered = "";
    this.setProjectParam(null);
    this.render(true);
    this.schedulePoll(0);
  }

  private setProjectParam(id: string | null) {
    const url = new URL(location.href);
    if (id) url.searchParams.set("project", id);
    else url.searchParams.delete("project");
    history.replaceState(null, "", url);
  }

  private buildProjectView() {
    const open = this.open;
    if (!open) return;
    const { project, shelf, parts } = open;
    const editable = shelf === "projects";

    const top = el("div", "project-top");
    top.append(button("← All projects", "btn ghost", () => this.closeProject()));
    if (editable) {
      const name = el("input", "project-name");
      name.type = "text";
      name.value = project.name;
      name.maxLength = MAX_PROJECT_NAME;
      name.setAttribute("aria-label", "Project name");
      name.addEventListener("input", () => {
        const value = name.value.trim();
        if (value) open.saver?.queue({ name: value });
      });
      name.addEventListener("blur", () => {
        if (!name.value.trim()) name.value = open.project.name;
        void open.saver?.flush();
      });
      name.addEventListener("keydown", (event) => {
        if (event.key === "Enter") name.blur();
      });
      parts.name = name;
      top.append(name, parts.status, button("Delete", "btn ghost danger", () => void this.confirmTrash(open.project)));
    } else {
      top.append(el("h3", "project-name static", project.name), parts.status);
    }

    this.body.replaceChildren(top, parts.stepper, parts.activity, parts.panel);
    this.updateProjectView();
  }

  private updateProjectView() {
    const open = this.open;
    if (!open) return;
    const { project, parts } = open;
    // Never overwrite a name the user is in the middle of typing.
    if (parts.name && document.activeElement !== parts.name && !open.saver?.busy) {
      parts.name.value = project.name;
    }
    this.updateStatus();
    this.renderStepper();
    parts.activity.replaceChildren(this.activityLine(project));
    this.renderPanel();
  }

  private updateStatus() {
    const open = this.open;
    if (!open) return;
    const { status } = open.parts;
    status.classList.toggle("error", open.saveState.kind === "error");
    if (open.shelf === "archive") {
      status.textContent = open.project.archivedAt ? `Archived ${formatDate(open.project.archivedAt)}` : "Archived";
    } else if (open.saveState.kind === "saving") {
      status.textContent = "Saving…";
    } else if (open.saveState.kind === "error") {
      status.textContent = `Not saved: ${open.saveState.message} Retrying.`;
    } else {
      status.textContent = `Saved · ${formatTime(open.project.updatedAt)}`;
    }
  }

  private renderStepper() {
    const open = this.open;
    if (!open) return;
    const { project, shelf } = open;
    const current = stageIndex(project.stage);
    const viewing = project.openStage;
    const steps = STAGES.map((stage, index) => {
      const item = el("li");
      const step = el("button", "step");
      step.type = "button";
      step.dataset.state = index < current ? "done" : index === current ? "current" : "todo";
      if (project.checks?.includes(stage.id)) {
        step.dataset.check = "true";
        step.title = "Made before an earlier stage changed. Check it.";
      }
      if (stage.id === viewing) step.setAttribute("aria-current", "step");
      step.append(el("span", "step-num", String(index + 1)), el("span", "step-label", stage.label));
      step.disabled = index > current || shelf === "trash";
      step.addEventListener("click", () => this.viewStage(stage.id));
      item.append(step);
      return item;
    });
    const stepper = open.parts.stepper;
    const scrollLeft = stepper.scrollLeft;
    stepper.replaceChildren(...steps);
    stepper.scrollLeft = scrollLeft;
    // Bring the open stage into view sideways, only when it changes. Never use
    // scrollIntoView here: it also scrolls the page, so every autosave would
    // jump you back up to the top.
    const shownFor = `${project.id}:${viewing}`;
    if (this.stepperShownFor === shownFor) return;
    this.stepperShownFor = shownFor;
    const step = stepper.querySelector<HTMLElement>('[aria-current="step"]');
    if (!step) return;
    const left = step.offsetLeft - stepper.offsetLeft;
    if (left < stepper.scrollLeft || left + step.offsetWidth > stepper.scrollLeft + stepper.clientWidth) {
      stepper.scrollLeft = Math.max(0, left - (stepper.clientWidth - step.offsetWidth) / 2);
    }
  }

  /** Open a stage's panel. Going back never undoes later stages. */
  private viewStage(stage: StageId) {
    const open = this.open;
    if (!open || stageIndex(stage) > stageIndex(open.project.stage)) return;
    open.project = { ...open.project, openStage: stage };
    open.pickerOpen = false;
    open.saver?.queue({ openStage: stage }, 0);
    this.updateProjectView();
  }

  /** Outside data the open stage shows, so the panel redraws only when that changes. */
  private panelDataKey() {
    const open = this.open;
    if (!open) return "";
    return JSON.stringify([
      open.project.openStage === "idea" ? this.latestDay : null,
      open.project.openStage === "worlds" ? this.mint : null,
      this.jobs.filter((job) => job.projectId === open.project.id),
    ]);
  }

  private renderPanel() {
    const open = this.open;
    if (!open) return;
    const panel = open.parts.panel;
    if (isTypingIn(panel)) {
      this.redrawPending = true;
      return;
    }
    this.lastPanelData = this.panelDataKey();
    const { project, shelf } = open;
    const viewing = project.openStage;
    const isCurrent = viewing === project.stage;
    const nodes: HTMLElement[] = [el("h3", "stage-panel-title", `${stageIndex(viewing) + 1}. ${stageLabel(viewing)}`)];

    if (project.checks?.includes(viewing) && shelf === "projects") {
      const check = el("div", "check-note");
      check.append(
        el("span", undefined, "This was made before an earlier stage changed. Check it still fits."),
        button("Looks fine", "btn", () => this.clearCheck(viewing)),
      );
      nodes.push(check);
    }

    if (viewing === "idea") {
      nodes.push(...this.ideaStage(open));
    } else if (viewing === "approved") {
      nodes.push(...this.hookStage(open));
    } else if (viewing === "references") {
      nodes.push(...this.referencesStage(open));
    } else if (viewing === "worlds") {
      nodes.push(...this.worldsStage(open));
    } else {
      nodes.push(
        el("p", "stage-panel-plan", STAGE_PLANS[viewing]),
        el("p", "stage-panel-soon", "This stage's tools are built in a later step."),
      );
      const actions = el("div", "stage-panel-actions");
      if (shelf === "projects") {
        if (!isCurrent) {
          nodes.push(
            el(
              "p",
              "stage-panel-note",
              `You're looking back at an earlier stage. The project is at ${stageLabel(project.stage)}, and nothing after this is lost.`,
            ),
          );
          actions.append(button(`Go to ${stageLabel(project.stage)}`, "btn", () => this.viewStage(project.stage)));
        } else if (project.stage === "posted") {
          actions.append(button("Mark as posted and archive", "btn primary", () => void this.archive(project)));
        } else {
          actions.append(button("Mark this stage done", "btn primary", () => this.advance()));
        }
      }
      if (actions.childElementCount) nodes.push(actions);
    }
    panel.replaceChildren(...nodes);
  }

  private ideaStage(open: OpenProject) {
    const current = open.project.data.idea as ProjectIdea | undefined;
    // Archived and deleted projects only show what they were made from.
    if (open.shelf !== "projects") return current ? [ideaCard(current)] : [];
    return ideaPanel({ ...this.ideaPanelBase(open), current, pickerOpen: open.pickerOpen || !current });
  }

  private ideaPanelBase(open: OpenProject) {
    return {
      projectId: open.project.id,
      laterStagesReached: stageIndex(open.project.stage) > stageIndex("approved"),
      day: this.latestDay,
      jobs: this.jobs,
      picked: open.picked,
      topicInput: this.projectTopicInput,
      onPick: (id: string) => {
        open.picked = id;
        this.renderPanel();
      },
      onUse: () => void this.useIdeaForProject(),
      onOpenPicker: () => {
        open.pickerOpen = true;
        this.renderPanel();
      },
      onClosePicker: () => {
        open.pickerOpen = false;
        open.picked = null;
        this.renderPanel();
      },
      onAddTopic: () => void this.addProjectTopic(),
      onCancelJob: (id: string) => void this.cancelJob(id),
    };
  }

  private hookStage(open: OpenProject) {
    const editable = open.shelf === "projects";
    const past = stageIndex(open.project.stage) > stageIndex("approved");
    const nodes = hookStage({
      project: open.project,
      editable,
      jobs: this.jobs.filter((job) => job.kind === "hooks" && job.projectId === open.project.id),
      noteInput: this.hookNoteInput,
      onChange: (approved) => {
        open.project = { ...open.project, data: { ...open.project.data, approved } };
        open.saver?.queue({ data: { approved } });
      },
      onApprove: () => void this.approveHook(open),
      onMoreOptions: () => void this.askForHooks(open),
      onCancelJob: (id) => void this.cancelJob(id),
    });
    if (editable && past) {
      // Going back to reword things never moves the project backwards.
      const approve = nodes.at(-1)?.querySelector("button");
      if (approve) approve.textContent = `Save and go to ${stageLabel(open.project.stage)}`;
    }
    return nodes;
  }

  /** Stage 2 is done once a hook and a caption are settled on. */
  private async approveHook(open: OpenProject) {
    if (!open.saver || choiceProblem(currentChoice(open.project))) return;
    if (stageIndex(open.project.stage) > stageIndex("approved")) {
      await open.saver.flush();
      this.viewStage(open.project.stage);
      return;
    }
    const next: StageId = "references";
    const activity = { label: waitingLabel(next), tone: "waiting" as const };
    // Fix the rooms now so their keys stay put while Claude fills them in.
    const references = referencesOf(open.project);
    open.project = {
      ...open.project,
      stage: next,
      openStage: next,
      activity,
      data: { ...open.project.data, references },
    };
    open.saver.queue({ stage: next, openStage: next, activity, data: { references } }, 0);
    this.updateProjectView();
    // Claude starts looking straight away, so images are waiting by the time you look.
    void this.findReferences(open, references.rooms);
  }

  private referencesStage(open: OpenProject) {
    const editable = open.shelf === "projects";
    const nodes = referencesStage({
      project: open.project,
      editable,
      jobs: this.jobs.filter((job) => job.kind === "references" && job.projectId === open.project.id),
      current: () => referencesOf(open.project),
      onChange: (references) => this.saveReferences(open, references),
      onFind: (rooms) => void this.findReferences(open, rooms),
      onUpload: (room, file) => void this.uploadReference(open, room, file),
      onContinue: () => void this.finishReferences(open),
      onCancelJob: (id) => void this.cancelJob(id),
    });
    if (editable && stageIndex(open.project.stage) > stageIndex("references")) {
      const go = nodes.at(-1)?.querySelector("button");
      if (go) go.textContent = `Save and go to ${stageLabel(open.project.stage)}`;
    }
    return nodes;
  }

  private worldsStage(open: OpenProject) {
    const editable = open.shelf === "projects";
    const nodes = worldsStage({
      project: open.project,
      editable,
      mint: this.mint,
      jobs: this.jobs.filter((job) => job.kind === "worlds" && job.projectId === open.project.id),
      sharpen: open.sharpen,
      onSharpen: (key, on) => {
        open.sharpen.set(key, on);
        this.renderPanel();
      },
      onBuild: (rooms, credits) => void this.buildWorlds(open, rooms, credits),
      onContinue: () => void this.finishWorlds(open),
      onCancelJob: (id) => void this.cancelJob(id),
    });
    if (editable && stageIndex(open.project.stage) > stageIndex("worlds")) {
      const go = [...nodes].reverse().find((node) => node.classList.contains("stage-panel-actions"))?.querySelector("button");
      if (go && go.textContent === "Continue to clips") go.textContent = `Go to ${stageLabel(open.project.stage)}`;
    }
    return nodes;
  }

  /**
   * The one place credits get spent: you confirm the amount, then the job is
   * queued for Claude. Nothing is queued if you cancel the dialog.
   */
  private async buildWorlds(open: OpenProject, rooms: ApprovedRoom[], credits: number) {
    const n = rooms.length;
    const usd = (credits * USD_PER_CREDIT).toFixed(2);
    const sharpened = rooms.filter((room) => room.sharpen).length;
    const confirmed = await this.ask(
      `Build ${n} ${n === 1 ? "world" : "worlds"}?`,
      `This spends about ${credits.toLocaleString()} credits (about ${usd}), including ${sharpened ? `${sharpened} sharpened ${sharpened === 1 ? "anchor" : "anchors"} and ` : ""}each world's preview. Mint can't cancel a world once it starts. Rooms: ${rooms.map((room) => room.name).join(", ")}.`,
      "Build and spend credits",
    );
    if (!confirmed || this.open !== open) return;
    try {
      await open.saver?.flush();
      const approval: WorldsApproval = { approvedAt: new Date().toISOString(), rooms, credits };
      const worlds: ProjectWorlds = { ...worldsOf(open.project) };
      rooms.forEach((room) => {
        worlds[room.key] = { status: "queued" };
      });
      const approvals = [...approvalsOf(open.project), approval];
      const activity = { label: `Building ${n} ${n === 1 ? "world" : "worlds"}`, tone: "busy" as const };
      open.project = {
        ...open.project,
        activity,
        data: { ...open.project.data, worlds, worldsApproval: approvals },
      };
      await api.patchProject(open.project.id, { activity, data: { worlds, worldsApproval: approvals } });
      const job = await api.addJob("worlds", { rooms, credits }, open.project.id);
      this.jobs = [...this.jobs.filter((entry) => entry.id !== job.id), job];
      this.updateProjectView();
    } catch (error) {
      this.showError(error);
    }
  }

  private async finishWorlds(open: OpenProject) {
    if (!open.saver || !worldsDone(open.project)) return;
    if (stageIndex(open.project.stage) > stageIndex("worlds")) {
      this.viewStage(open.project.stage);
      return;
    }
    const next: StageId = "clips";
    const activity = { label: waitingLabel(next), tone: "waiting" as const };
    open.project = { ...open.project, stage: next, openStage: next, activity };
    open.saver.queue({ stage: next, openStage: next, activity }, 0);
    this.updateProjectView();
  }

  private saveReferences(open: OpenProject, references: References) {
    open.project = { ...open.project, data: { ...open.project.data, references } };
    open.saver?.queue({ data: { references } }, 0);
    this.renderPanel();
  }

  private async findReferences(open: OpenProject, rooms: ReferenceRoom[]) {
    try {
      await open.saver?.flush();
      const job = await api.addJob(
        "references",
        { rooms: rooms.map(({ key, name, visual }) => ({ key, name, visual })) },
        open.project.id,
      );
      this.jobs = [...this.jobs.filter((entry) => entry.id !== job.id), job];
      if (this.open === open) this.renderPanel();
    } catch (error) {
      this.showError(error);
    }
  }

  private async uploadReference(open: OpenProject, room: ReferenceRoom, file: File) {
    try {
      const url = await api.uploadRef(open.project.id, file);
      if (this.open !== open) return;
      const references = referencesOf(open.project);
      this.saveReferences(open, {
        rooms: references.rooms.map((entry) =>
          entry.key !== room.key
            ? entry
            : {
                ...entry,
                own: [...entry.own, { url, title: file.name, addedBy: "you" }],
                picked:
                  entry.picked.length < MAX_REFERENCES_PER_ROOM ? [...entry.picked, url] : entry.picked,
              },
        ),
      });
    } catch (error) {
      this.showError(error);
    }
  }

  /** Stage 3 is done once every kept room has at least one image. */
  private async finishReferences(open: OpenProject) {
    if (!open.saver || referencesProblem(referencesOf(open.project))) return;
    if (stageIndex(open.project.stage) > stageIndex("references")) {
      await open.saver.flush();
      this.viewStage(open.project.stage);
      return;
    }
    const next: StageId = "worlds";
    const activity = { label: waitingLabel(next), tone: "waiting" as const };
    open.project = { ...open.project, stage: next, openStage: next, activity };
    open.saver.queue({ stage: next, openStage: next, activity }, 0);
    this.updateProjectView();
  }

  private async askForHooks(open: OpenProject) {
    const note = this.hookNoteInput.value.trim();
    try {
      await open.saver?.flush();
      const job = await api.addJob("hooks", note ? { note } : {}, open.project.id);
      this.hookNoteInput.value = "";
      this.hookNoteInput.blur();
      this.jobs = [...this.jobs.filter((entry) => entry.id !== job.id), job];
      this.renderPanel();
    } catch (error) {
      this.showError(error);
    }
  }

  private clearCheck(stage: StageId) {
    const open = this.open;
    if (!open?.saver) return;
    const checks = (open.project.checks ?? []).filter((entry) => entry !== stage);
    open.project = { ...open.project, checks };
    open.saver.queue({ checks }, 0);
    this.updateProjectView();
  }

  /** Stand-in for each stage's own finish action until the stage is built. */
  private advance() {
    const open = this.open;
    if (!open?.saver) return;
    const next = STAGES[stageIndex(open.project.stage) + 1]?.id;
    if (!next) return;
    const activity = { label: waitingLabel(next), tone: "waiting" as const };
    open.project = { ...open.project, stage: next, openStage: next, activity };
    open.saver.queue({ stage: next, openStage: next, activity }, 0);
    this.updateProjectView();
  }

  // ---------------------------------------------------------------- actions

  private async newProject() {
    try {
      const project = await api.createProject("Untitled reel");
      this.lists.projects = [project, ...this.lists.projects];
      this.openProject("projects", project);
      this.open?.parts.name?.focus();
      this.open?.parts.name?.select();
    } catch (error) {
      this.showError(error);
    }
  }

  private async showDay(date: string) {
    try {
      this.viewDate = date === this.latestDay?.date ? null : date;
      this.viewDay = this.viewDate ? await api.ideaDay(date) : this.latestDay;
      this.selection.clear();
      this.render(true);
    } catch (error) {
      this.showError(error);
    }
  }

  private async startJob(kind: "research") {
    try {
      const job = await api.addJob(kind);
      this.jobs = [...this.jobs.filter((entry) => entry.id !== job.id), job];
      this.render(true);
    } catch (error) {
      this.showError(error);
    }
  }

  private async addTopic() {
    const topic = this.topicInput.value.trim();
    if (!topic) {
      this.topicInput.focus();
      return;
    }
    try {
      const job = await api.addJob("ideate", { topic });
      this.topicInput.value = "";
      this.jobs = [...this.jobs, job];
      this.render(true);
    } catch (error) {
      this.showError(error);
    }
  }

  private async addProjectTopic() {
    const open = this.open;
    const topic = this.projectTopicInput.value.trim();
    if (!open || !topic) {
      this.projectTopicInput.focus();
      return;
    }
    try {
      const job = await api.addJob("ideate", { topic }, open.project.id);
      this.projectTopicInput.value = "";
      this.projectTopicInput.blur();
      this.jobs = [...this.jobs, job];
      this.renderPanel();
    } catch (error) {
      this.showError(error);
    }
  }

  private async cancelJob(id: string) {
    try {
      const job = await api.cancelJob(id);
      this.jobs = this.jobs.map((entry) => (entry.id === id ? job : entry));
      if (this.open) this.renderPanel();
      else this.render(true);
    } catch (error) {
      this.showError(error);
    }
  }

  /** Turn every ticked idea into its own project. */
  private async startProjects() {
    const day = this.viewDay;
    if (!day || this.selection.size === 0) return;
    try {
      await api.useIdeas(day.date, [...this.selection]);
      this.selection.clear();
      this.setTab("projects");
      this.schedulePoll(0);
    } catch (error) {
      this.showError(error);
    }
  }

  private async useIdeaForProject() {
    const open = this.open;
    const day = this.latestDay;
    if (!open?.picked || !day) return;
    try {
      await open.saver?.flush();
      const [project] = await api.useIdeas(day.date, [open.picked], open.project.id);
      if (this.open !== open) return;
      open.project = project;
      open.pickerOpen = false;
      open.picked = null;
      this.updateProjectView();
      this.schedulePoll(0);
    } catch (error) {
      this.showError(error);
    }
  }

  private async confirmTrash(project: Project) {
    const confirmed = await this.ask(
      `Delete “${project.name}”?`,
      "It moves to Trash, where you can restore it. Anything queued for it stops, and its idea goes back on the list. Worlds it already made stay in your library.",
      "Delete",
    );
    if (!confirmed) return;
    try {
      if (this.open?.project.id === project.id) await this.open.saver?.flush();
      await api.trashProject(project.id);
      if (this.open?.project.id === project.id) this.closeProject();
      this.lastRendered = "";
      this.schedulePoll(0);
    } catch (error) {
      this.showError(error);
    }
  }

  private async restore(project: Project) {
    try {
      await api.restoreProject(project.id);
      this.setTab("projects");
      this.schedulePoll(0);
    } catch (error) {
      this.showError(error);
    }
  }

  private async archive(project: Project) {
    try {
      await this.open?.saver?.flush();
      await api.archiveProject(project.id);
      this.closeProject();
      this.setTab("archive");
      this.schedulePoll(0);
    } catch (error) {
      this.showError(error);
    }
  }

  private showError(error: unknown) {
    this.error = error instanceof Error ? error.message : "Something went wrong.";
    if (this.open) {
      this.open.parts.status.textContent = this.error;
      this.open.parts.status.classList.add("error");
      return;
    }
    this.render(true);
  }

  /** A small confirm dialog; resolves true only for the confirm button. */
  private ask(title: string, text: string, confirmLabel: string) {
    return new Promise<boolean>((resolve) => {
      const dialog = this.dialog;
      let settled = false;
      // The buttons answer directly. The dialog's close event isn't reliable
      // (it never arrives in a backgrounded tab) and only covers Escape here.
      const settle = (confirmed: boolean) => {
        if (settled) return;
        settled = true;
        if (dialog.open) dialog.close();
        resolve(confirmed);
      };
      const cancel = button("Cancel", "btn", () => settle(false));
      const confirm = button(confirmLabel, "btn primary danger", () => settle(true));
      const actions = el("div", "auto-dialog-actions");
      actions.append(cancel, confirm);
      dialog.replaceChildren(el("h3", "auto-dialog-title", title), el("p", "auto-dialog-text", text), actions);
      dialog.addEventListener("close", () => settle(false), { once: true });
      dialog.showModal();
      cancel.focus();
    });
  }
}
