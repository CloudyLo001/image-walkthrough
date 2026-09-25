import { button, el } from "./dom";
import { jobLine } from "./ideas";
import {
  captionCounts,
  captionFits,
  ideaCaptions,
  MAX_CAPTION_LENGTH,
  MAX_HOOK_LENGTH,
  type HookAndCaption,
  type HookOptions,
  type Job,
  type Project,
  type ProjectIdea,
} from "./types";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export interface HookStageInput {
  project: Project;
  editable: boolean;
  /** Only this stage's own jobs (kind "hooks") for this project. */
  jobs: Job[];
  /** Kept across redraws so a half-typed note survives. */
  noteInput: HTMLInputElement;
  onChange: (approved: HookAndCaption) => void;
  onApprove: () => void;
  onMoreOptions: () => void;
  onCancelJob: (id: string) => void;
}

/** Every hook and caption on offer: the idea's own drafts, then any Claude added. */
export function hookChoices(project: Project) {
  const idea = project.data.idea as ProjectIdea | undefined;
  const extra = (project.data.hookOptions as HookOptions | undefined) ?? { hooks: [], captions: [] };
  return {
    hooks: [...(idea?.hooks ?? []), ...(extra.hooks ?? [])],
    captions: [...(idea ? ideaCaptions(idea) : []), ...(extra.captions ?? [])],
  };
}

export function currentChoice(project: Project): HookAndCaption {
  const saved = project.data.approved as HookAndCaption | undefined;
  return saved ?? { hook: "", caption: "", hookPick: null, captionPick: null };
}

/** Whether stage 2 is complete enough to move on. */
export function choiceProblem(choice: HookAndCaption): string | null {
  if (!choice.hook.trim()) return "Pick or write a hook.";
  if (!choice.caption.trim()) return "Pick or write a caption.";
  if (!captionFits(choice.caption)) return "The caption needs 3–9 words and 4–5 hashtags.";
  return null;
}

/**
 * Stage 2: pick one of the hooks and captions, or write your own, with a
 * phone-sized preview of how the hook sits on the video.
 */
export function hookStage(input: HookStageInput): HTMLElement[] {
  const { project, editable } = input;
  const choices = hookChoices(project);
  let choice = currentChoice(project);

  const preview = phonePreview(choice);
  const counter = el("div", "caption-counter");
  const approveNote = el("p", "stage-panel-note");
  const approve = button("Use this hook and caption", "btn primary", input.onApprove);

  // Typing updates the preview and checks in place; nothing redraws under the cursor.
  const refresh = () => {
    preview.setHook(choice.hook);
    preview.setCaption(choice.caption);
    const { words, hashtags } = captionCounts(choice.caption);
    counter.textContent = choice.caption.trim()
      ? `${words} ${words === 1 ? "word" : "words"} · ${hashtags} ${hashtags === 1 ? "hashtag" : "hashtags"}`
      : "3–9 words · 4–5 hashtags";
    counter.classList.toggle("bad", Boolean(choice.caption.trim()) && !captionFits(choice.caption));
    const problem = choiceProblem(choice);
    approve.disabled = Boolean(problem);
    approveNote.textContent = problem ?? "";
    approveNote.hidden = !problem;
  };

  const change = (next: HookAndCaption) => {
    choice = next;
    refresh();
    input.onChange(next);
  };

  const hookEditor = el("textarea", "hook-editor");
  hookEditor.rows = 3;
  hookEditor.maxLength = MAX_HOOK_LENGTH;
  hookEditor.value = choice.hook;
  hookEditor.placeholder = "Pick a hook above, or write your own. A second line in (brackets) works well.";
  hookEditor.setAttribute("aria-label", "Hook text");
  hookEditor.disabled = !editable;
  hookEditor.addEventListener("input", () => {
    const hook = hookEditor.value;
    change({ ...choice, hook, hookPick: choices.hooks.indexOf(hook) >= 0 ? choices.hooks.indexOf(hook) : null });
  });

  const captionEditor = el("textarea", "hook-editor");
  captionEditor.rows = 2;
  captionEditor.maxLength = MAX_CAPTION_LENGTH;
  captionEditor.value = choice.caption;
  captionEditor.placeholder = "Pick a caption above, or write your own.";
  captionEditor.setAttribute("aria-label", "Caption text");
  captionEditor.disabled = !editable;
  captionEditor.addEventListener("input", () => {
    const caption = captionEditor.value;
    const pick = choices.captions.indexOf(caption);
    change({ ...choice, caption, captionPick: pick >= 0 ? pick : null });
  });

  const hookList = optionList(`hook-${project.id}`, choices.hooks, choice.hookPick, editable, (index) => {
    hookEditor.value = choices.hooks[index];
    change({ ...choice, hook: choices.hooks[index], hookPick: index });
    markPicked(hookList, index);
  });
  const captionList = optionList(`caption-${project.id}`, choices.captions, choice.captionPick, editable, (index) => {
    captionEditor.value = choices.captions[index];
    change({ ...choice, caption: choices.captions[index], captionPick: index });
    markPicked(captionList, index);
  });

  const hookBlock = el("div", "choice-block");
  hookBlock.append(
    el("h4", "choice-title", "Hook"),
    el("p", "choice-hint", "Burned into the video, centred on the footage."),
    hookList,
    labelled("Your version", hookEditor),
  );
  const captionBlock = el("div", "choice-block");
  captionBlock.append(
    el("h4", "choice-title", "Caption"),
    el("p", "choice-hint", "Posted under the video. 3–9 words, then 4–5 hashtags."),
    captionList,
    labelled("Your version", captionEditor),
    counter,
  );

  const columns = el("div", "hook-stage");
  const left = el("div", "hook-choices");
  left.append(hookBlock, captionBlock);
  columns.append(left, preview.node);

  const nodes: HTMLElement[] = [columns];

  if (editable) {
    // Asking Claude for more options adds to the lists; it never replaces a choice.
    const more = el("div", "topic-box");
    const label = el("label", "look-label", "Want different options? Say what to change, or leave it blank.");
    label.htmlFor = input.noteInput.id;
    const row = el("div", "look-row");
    const active = input.jobs.find((job) => job.status === "requested" || job.status === "running");
    const ask = button(active ? "Writing…" : "Write 2 more of each", "btn", input.onMoreOptions);
    ask.disabled = Boolean(active);
    row.append(input.noteInput, ask);
    more.append(label, row);
    const shown = active ?? input.jobs.filter((job) => job.status === "failed").at(-1);
    if (shown) more.append(jobLine(shown, active ? () => input.onCancelJob(active.id) : undefined));
    nodes.push(more);

    const actions = el("div", "stage-panel-actions");
    actions.append(approve);
    nodes.push(approveNote, actions);
  }

  refresh();
  return nodes;
}

function labelled(text: string, field: HTMLElement) {
  const wrap = el("label", "choice-edit");
  wrap.append(el("span", "choice-edit-label", text), field);
  return wrap;
}

function optionList(
  name: string,
  options: string[],
  picked: number | null,
  editable: boolean,
  onPick: (index: number) => void,
) {
  const list = el("div", "option-list");
  list.setAttribute("role", "radiogroup");
  options.forEach((text, index) => {
    const option = el("label", "option");
    const radio = el("input");
    radio.type = "radio";
    radio.name = name;
    radio.checked = picked === index;
    radio.disabled = !editable;
    radio.addEventListener("change", () => onPick(index));
    option.append(radio, el("span", "option-letter", LETTERS[index] ?? String(index + 1)), el("span", "option-text", text));
    if (picked === index) option.classList.add("picked");
    list.append(option);
  });
  return list;
}

function markPicked(list: HTMLElement, index: number) {
  list.querySelectorAll(".option").forEach((option, i) => option.classList.toggle("picked", i === index));
}

/**
 * A 9:16 phone frame: letterboxed footage on black, the hook centred on the
 * footage in the reel's font, and the caption where TikTok puts it.
 */
function phonePreview(choice: HookAndCaption) {
  const node = el("figure", "phone");
  const screen = el("div", "phone-screen");
  const footage = el("div", "phone-footage");
  const hook = el("div", "reel-hook");
  footage.append(hook);
  const caption = el("div", "phone-caption");
  screen.append(footage, caption);
  node.append(screen, el("figcaption", "phone-note", "Preview. The footage comes from your clips later."));

  const setHook = (text: string) => {
    hook.textContent = text.trim() || "your hook shows here";
    hook.classList.toggle("placeholder", !text.trim());
  };
  const setCaption = (text: string) => {
    caption.replaceChildren();
    const handle = el("strong", undefined, "@madeonmint");
    caption.append(handle, el("span", undefined, text.trim() || "caption"));
  };
  setHook(choice.hook);
  setCaption(choice.caption);
  return { node, setHook, setCaption };
}
