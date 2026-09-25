import { button, el, formatDay, formatTime } from "./dom";
import { ideaCaptions, type Idea, type IdeaDay, type IdeaDaySummary, type IdeaTag, type Job } from "./types";

export const TAG_LABELS: Record<IdeaTag, string> = {
  proven: "Proven",
  older: "Older",
  new: "New",
  yours: "Yours",
};

export type IdeaFilter = "all" | IdeaTag;

/** A job still waiting after this long probably has no Claude session watching. */
const UNCLAIMED_AFTER_MS = 30_000;

interface CardOptions {
  /** A checkbox (many) or radio (one) for picking the idea. */
  pick?: { type: "checkbox" | "radio"; name: string; checked: boolean; onChange: () => void };
  /** The project already made from this idea. */
  usedBy?: { name: string; onOpen: () => void } | null;
}

export function ideaCard(idea: Idea, options: CardOptions = {}) {
  const card = el("article", "idea-card");
  if (options.usedBy) card.classList.add("used");
  if (options.pick?.checked) card.classList.add("picked");

  const top = el("div", "idea-top");
  if (options.pick && !options.usedBy) {
    const pick = el("input", "idea-pick");
    pick.type = options.pick.type;
    pick.name = options.pick.name;
    pick.checked = options.pick.checked;
    pick.id = `${options.pick.name}-${idea.id}`;
    pick.setAttribute("aria-label", `Pick “${idea.title}”`);
    pick.addEventListener("change", options.pick.onChange);
    top.append(pick);
  }
  const tag = el("span", `chip idea-tag ${idea.tag}`, TAG_LABELS[idea.tag] ?? idea.tag);
  top.append(tag, el("span", "idea-bucket", idea.bucket));
  card.append(top);

  const title = el("h3", "idea-title", idea.title);
  card.append(title);
  if (idea.why) card.append(el("p", "idea-why", idea.why));

  if (idea.rooms.length) {
    const rooms = el("ul", "idea-rooms");
    idea.rooms.forEach((room) => {
      const item = el("li");
      item.append(el("strong", undefined, room.name), document.createTextNode(` · ${room.visual}`));
      rooms.append(item);
    });
    card.append(section(`${idea.rooms.length} ${idea.rooms.length === 1 ? "world" : "worlds"}`, rooms));
  }
  if (idea.hooks.length) {
    const hooks = el("div", "idea-hooks");
    idea.hooks.forEach((hook) => hooks.append(el("p", "idea-hook", hook)));
    card.append(section("Hooks", hooks));
  }
  const captions = ideaCaptions(idea);
  if (captions.length) {
    const list = el("div", "idea-hooks");
    captions.forEach((caption) => list.append(el("p", "idea-caption", caption)));
    card.append(section(captions.length === 1 ? "Caption" : "Captions", list));
  }
  if (idea.audioHints.length) {
    card.append(section("Sound ideas", el("p", "idea-audio", idea.audioHints.join(" · "))));
  }

  if (options.usedBy) {
    const used = el("div", "idea-used");
    used.append(
      el("span", undefined, `In project: ${options.usedBy.name}`),
      button("Open", "btn", options.usedBy.onOpen),
    );
    card.append(used);
  }

  // The whole card toggles the pick, not just the small box.
  if (options.pick && !options.usedBy) {
    card.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      if (target.closest("input, button, a")) return;
      options.pick?.onChange();
    });
  }
  return card;
}

function section(label: string, body: HTMLElement) {
  const wrap = el("div", "idea-section");
  wrap.append(el("div", "idea-label", label), body);
  return wrap;
}

/** One line saying where a job is: queued, running, failed. */
export function jobLine(job: Job, onCancel?: () => void) {
  const line = el("div", "activity job-line");
  const waitedMs = Date.now() - Date.parse(job.requestedAt);
  let label: string;
  if (job.status === "running") {
    line.dataset.tone = "busy";
    label = job.progress?.label ?? `${jobTitle(job)}…`;
  } else if (job.status === "failed") {
    line.dataset.tone = "error";
    label = `${jobTitle(job)} failed${job.error ? `: ${job.error}` : "."}`;
  } else {
    line.dataset.tone = "busy";
    label = `${jobTitle(job)}: queued`;
  }
  const row = el("div", "job-row");
  row.append(el("span", "activity-label", label));
  if (onCancel && (job.status === "requested" || job.status === "running")) {
    row.append(button("Cancel", "btn ghost small", onCancel));
  }
  line.append(row);
  if (job.status === "requested" || job.status === "running") {
    const track = el("div", "activity-track");
    const fill = el("div", "activity-fill");
    if (job.progress?.percent === undefined) track.classList.add("indeterminate");
    else fill.style.width = `${job.progress.percent}%`;
    track.append(fill);
    line.append(track);
  }
  if (job.status === "requested" && waitedMs > UNCLAIMED_AFTER_MS) {
    line.append(
      el(
        "p",
        "job-hint",
        "No Claude session has picked this up yet. Tell Claude “check automation jobs”, or keep a session open with the jobs monitor running.",
      ),
    );
  }
  return line;
}

function jobTitle(job: Job) {
  if (job.kind === "research") return "Research";
  if (job.kind === "ideate") return `Your topic “${String(job.input.topic ?? "")}”`;
  if (job.kind === "hooks") {
    return job.input.note ? `New options (“${String(job.input.note)}”)` : "New options";
  }
  if (job.kind === "worlds") {
    const rooms = (job.input.rooms as Array<{ name: string }> | undefined) ?? [];
    return rooms.length === 1 ? `Building the ${rooms[0].name} world` : `Building ${rooms.length} worlds`;
  }
  if (job.kind === "references") {
    const rooms = (job.input.rooms as Array<{ name: string }> | undefined) ?? [];
    return rooms.length === 1 ? `Finding images for ${rooms[0].name}` : "Finding images";
  }
  return job.kind;
}

export interface IdeasTabInput {
  days: IdeaDaySummary[];
  day: IdeaDay | null;
  jobs: Job[];
  projectNames: Map<string, string>;
  selection: Set<string>;
  filter: IdeaFilter;
  topicInput: HTMLInputElement;
  onResearch: () => void;
  onDate: (date: string) => void;
  onToggle: (id: string) => void;
  onFilter: (filter: IdeaFilter) => void;
  onStart: () => void;
  onClear: () => void;
  onAddTopic: () => void;
  onCancelJob: (id: string) => void;
  onOpenProject: (id: string) => void;
}

/** Today's ideas, picking several at once, and adding your own topics. */
export function ideasTab(input: IdeasTabInput): HTMLElement[] {
  const { day, jobs } = input;
  const nodes: HTMLElement[] = [];

  const head = el("div", "ideas-head");
  const heading = el("div", "ideas-heading");
  heading.append(el("h3", "ideas-title", day ? `Ideas for ${formatDay(day.date)}` : "No ideas yet"));
  if (day) {
    heading.append(el("p", "ideas-meta", `Researched ${formatTime(day.generatedAt)} · ${day.ideas.length} ideas`));
    if (day.summary) heading.append(el("p", "ideas-summary", day.summary));
  } else {
    heading.append(
      el("p", "ideas-meta", "Research reads what's working on the three accounts and writes up to 20 ideas."),
    );
  }
  const controls = el("div", "ideas-controls");
  // Every day's ideas stay on file; this is the record of past research.
  if (input.days.length > 1 && day) {
    const select = el("select", "ideas-date");
    select.setAttribute("aria-label", "Day of ideas");
    input.days.forEach((summary, index) => {
      const picked = summary.picked ? ` · ${summary.picked} picked` : "";
      const option = el(
        "option",
        undefined,
        `${index === 0 ? "Latest: " : ""}${formatDay(summary.date)} · ${summary.count} ideas${picked}`,
      );
      option.value = summary.date;
      option.selected = summary.date === day.date;
      select.append(option);
    });
    select.addEventListener("change", () => input.onDate(select.value));
    controls.append(select);
  }
  const research = jobs.find((job) => job.kind === "research" && (job.status === "requested" || job.status === "running"));
  const researchButton = button(research ? "Researching…" : "Research now", "btn primary", input.onResearch);
  researchButton.disabled = Boolean(research);
  controls.append(researchButton);
  head.append(heading, controls);
  nodes.push(head);

  const lastResearch = [...jobs].reverse().find((job) => job.kind === "research");
  if (research) nodes.push(jobLine(research, () => input.onCancelJob(research.id)));
  else if (lastResearch?.status === "failed") nodes.push(jobLine(lastResearch));

  // Your own topics, expanded by Claude into idea cards like the rest.
  const topic = el("div", "topic-box");
  const label = el("label", "look-label", "Add my topic");
  label.htmlFor = input.topicInput.id;
  const row = el("div", "look-row");
  row.append(input.topicInput, button("Add", "btn primary", input.onAddTopic));
  topic.append(label, row);
  jobs
    .filter((job) => job.kind === "ideate" && !job.projectId && (job.status === "requested" || job.status === "running" || job.status === "failed"))
    .slice(-5)
    .forEach((job) => topic.append(jobLine(job, () => input.onCancelJob(job.id))));
  nodes.push(topic);

  if (!day || day.ideas.length === 0) return nodes;

  const counts = new Map<IdeaFilter, number>([["all", day.ideas.length]]);
  day.ideas.forEach((idea) => counts.set(idea.tag, (counts.get(idea.tag) ?? 0) + 1));
  const filters = el("div", "idea-filters");
  (["all", "proven", "older", "new", "yours"] as const).forEach((filter) => {
    const count = counts.get(filter) ?? 0;
    if (filter !== "all" && count === 0) return;
    const chip = button(
      `${filter === "all" ? "All" : TAG_LABELS[filter]} ${count}`,
      "filter-chip",
      () => input.onFilter(filter),
    );
    chip.setAttribute("aria-pressed", String(input.filter === filter));
    filters.append(chip);
  });
  nodes.push(filters);

  const grid = el("div", "idea-grid");
  day.ideas
    .filter((idea) => input.filter === "all" || idea.tag === input.filter)
    .forEach((idea) => {
      const usedName = idea.projectId ? input.projectNames.get(idea.projectId) : undefined;
      grid.append(
        ideaCard(idea, {
          pick: {
            type: "checkbox",
            name: "idea",
            checked: input.selection.has(idea.id),
            onChange: () => input.onToggle(idea.id),
          },
          usedBy:
            idea.projectId && usedName
              ? { name: usedName, onOpen: () => input.onOpenProject(idea.projectId as string) }
              : null,
        }),
      );
    });
  nodes.push(grid);

  if (input.selection.size > 0) {
    const bar = el("div", "idea-bar");
    const n = input.selection.size;
    bar.append(
      el("span", "idea-bar-text", `${n} ${n === 1 ? "idea" : "ideas"} picked`),
      button("Clear", "btn", input.onClear),
      button(`Start ${n} ${n === 1 ? "project" : "projects"}`, "btn primary", input.onStart),
    );
    nodes.push(bar);
  }
  return nodes;
}

export interface IdeaPanelInput {
  projectId: string;
  current: (Idea & { date: string }) | undefined;
  /** Later stages already reached, which a new idea would flag for checking. */
  laterStagesReached: boolean;
  day: IdeaDay | null;
  jobs: Job[];
  pickerOpen: boolean;
  picked: string | null;
  topicInput: HTMLInputElement;
  onPick: (id: string) => void;
  onUse: () => void;
  onOpenPicker: () => void;
  onClosePicker: () => void;
  onAddTopic: () => void;
  onCancelJob: (id: string) => void;
}

/** Stage 1 inside a project: the chosen idea, or a picker to choose one. */
export function ideaPanel(input: IdeaPanelInput): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  if (input.current && !input.pickerOpen) {
    nodes.push(ideaCard(input.current));
    const actions = el("div", "stage-panel-actions");
    actions.append(button("Change idea", "btn", input.onOpenPicker));
    nodes.push(actions);
    return nodes;
  }

  const ideas = (input.day?.ideas ?? [])
    // Ideas typed inside this project come first, then everything still free.
    .filter((idea) => !idea.projectId || idea.projectId === input.projectId)
    .sort((a, b) => Number(b.forProject === input.projectId) - Number(a.forProject === input.projectId));

  nodes.push(
    el(
      "p",
      "stage-panel-plan",
      ideas.length
        ? `Pick one of the ideas from ${formatDay(input.day?.date ?? "")}, or type your own topic.`
        : "No free ideas right now. Run research on the Ideas tab, or type your own topic.",
    ),
  );
  if (input.current && input.laterStagesReached) {
    nodes.push(
      el(
        "p",
        "stage-panel-note",
        "This project is past this stage. A new idea keeps the later work, and marks those stages for you to check.",
      ),
    );
  }

  const topic = el("div", "topic-box");
  const label = el("label", "look-label", "Your own topic");
  label.htmlFor = input.topicInput.id;
  const row = el("div", "look-row");
  row.append(input.topicInput, button("Expand it", "btn", input.onAddTopic));
  topic.append(label, row);
  input.jobs
    .filter((job) => job.kind === "ideate" && job.projectId === input.projectId && job.status !== "done" && job.status !== "cancelled")
    .forEach((job) => topic.append(jobLine(job, () => input.onCancelJob(job.id))));
  nodes.push(topic);

  if (ideas.length) {
    const list = el("div", "idea-grid");
    ideas.forEach((idea) =>
      list.append(
        ideaCard(idea, {
          pick: {
            type: "radio",
            name: `idea-for-${input.projectId}`,
            checked: input.picked === idea.id,
            onChange: () => input.onPick(idea.id),
          },
        }),
      ),
    );
    nodes.push(list);
  }

  const actions = el("div", "stage-panel-actions");
  if (input.current) actions.append(button("Keep current idea", "btn", input.onClosePicker));
  const use = button("Use this idea", "btn primary", input.onUse);
  use.disabled = !input.picked;
  actions.append(use);
  nodes.push(actions);
  return nodes;
}
