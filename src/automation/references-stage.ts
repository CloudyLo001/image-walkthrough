import { button, el } from "./dom";
import { jobLine } from "./ideas";
import {
  MAX_REFERENCES_PER_ROOM,
  MAX_ROOMS,
  SHARP_REFERENCE_WIDTH,
  roomKey,
  type Job,
  type Project,
  type ProjectIdea,
  type ReferenceImage,
  type ReferenceOptions,
  type ReferenceRoom,
  type References,
} from "./types";

export interface ReferencesStageInput {
  project: Project;
  editable: boolean;
  /** This project's "references" jobs, oldest first. */
  jobs: Job[];
  /** The rooms as they are right now, including changes not yet redrawn. */
  current: () => References;
  onChange: (references: References) => void;
  onFind: (rooms: ReferenceRoom[]) => void;
  onUpload: (room: ReferenceRoom, file: File) => void;
  onContinue: () => void;
  onCancelJob: (id: string) => void;
}

/** Half-typed links, kept per project and room so a redraw never eats them. */
const linkDrafts = new Map<string, string>();

/** The rooms as saved, or fresh from the idea the first time the stage opens. */
export function referencesOf(project: Project): References {
  const saved = project.data.references as References | undefined;
  if (saved?.rooms) return saved;
  const idea = project.data.idea as ProjectIdea | undefined;
  const keys: string[] = [];
  const rooms = (idea?.rooms ?? []).map((room) => {
    const key = roomKey(room.name, keys);
    keys.push(key);
    return { key, name: room.name, visual: room.visual, picked: [], own: [] };
  });
  return { rooms };
}

export function optionsOf(project: Project): ReferenceOptions {
  return (project.data.referenceOptions as ReferenceOptions | undefined) ?? {};
}

/** Why stage 3 can't finish yet, or null when every room is ready. */
export function referencesProblem(references: References): string | null {
  const active = references.rooms.filter((room) => !room.skipped);
  if (active.length === 0) return "Keep at least one room.";
  const empty = active.find((room) => room.picked.length === 0);
  if (empty) return `Pick at least one image for ${empty.name}.`;
  return null;
}

/**
 * Stage 3: for each room, Claude's candidate images plus any you add. Tick one
 * or more; the first pick is the anchor Mint builds the world from.
 */
export function referencesStage(input: ReferencesStageInput): HTMLElement[] {
  const { project, editable } = input;
  const references = referencesOf(project);
  const options = optionsOf(project);
  const activeJob = input.jobs.find((job) => job.status === "requested" || job.status === "running");
  const lastJob = input.jobs.at(-1);
  const save = (next: References) => input.onChange(next);
  // Read the rooms fresh on every change: the panel may not have redrawn since
  // the last one (it waits while you type), and a stale copy would undo it.
  const withRoom = (key: string, change: (room: ReferenceRoom) => ReferenceRoom) =>
    save({ rooms: input.current().rooms.map((room) => (room.key === key ? change(room) : room)) });

  const nodes: HTMLElement[] = [];
  const worlds = references.rooms.filter((room) => !room.skipped).length;
  nodes.push(
    el(
      "p",
      "stage-panel-plan",
      `Pick 1–${MAX_REFERENCES_PER_ROOM} images for each room. The first pick (★) is the anchor Mint builds the world from; the rest show it more of the same place. Paste or drop your own images and links straight into a room. ${worlds} ${worlds === 1 ? "room makes 1 world" : `rooms make ${worlds} worlds`}.`,
    ),
  );

  if (activeJob) nodes.push(jobLine(activeJob, editable ? () => input.onCancelJob(activeJob.id) : undefined));
  else if (lastJob?.status === "failed") nodes.push(jobLine(lastJob));

  const nothingFound = references.rooms.every((room) => (options[room.key] ?? []).length === 0);
  if (editable && nothingFound && !activeJob) {
    const start = el("div", "stage-panel-actions");
    start.append(button("Find images for every room", "btn primary", () => input.onFind(references.rooms)));
    nodes.push(start);
  }

  references.rooms.forEach((room, index) => {
    nodes.push(roomSection(room, index, options[room.key] ?? [], { input, withRoom, activeJob }));
  });

  if (editable && references.rooms.length < MAX_ROOMS) {
    nodes.push(addRoomForm(save, input));
  }

  if (editable) {
    const problem = referencesProblem(references);
    const note = el("p", "stage-panel-note", problem ?? "");
    note.hidden = !problem;
    const actions = el("div", "stage-panel-actions");
    const go = button("Use these references", "btn primary", input.onContinue);
    go.disabled = Boolean(problem);
    actions.append(go);
    nodes.push(note, actions);
  }
  return nodes;
}

interface RoomContext {
  input: ReferencesStageInput;
  withRoom: (key: string, change: (room: ReferenceRoom) => ReferenceRoom) => void;
  activeJob: Job | undefined;
}

function roomSection(room: ReferenceRoom, index: number, found: ReferenceImage[], context: RoomContext) {
  const { input, withRoom, activeJob } = context;
  const { editable } = input;
  const section = el("section", `ref-room${room.skipped ? " skipped" : ""}`);

  const head = el("div", "ref-room-head");
  const title = el("div", "ref-room-title");
  title.append(
    el("h4", "choice-title", `${index + 1}. ${room.name}`),
    el("p", "choice-hint", room.visual),
  );
  head.append(title);
  if (editable) {
    const tools = el("div", "ref-room-tools");
    const searching = activeJob && (activeJob.input.rooms as Array<{ key: string }> | undefined)?.some((r) => r.key === room.key);
    const more = button(searching ? "Finding…" : found.length ? "Find more" : "Find images", "btn small", () => input.onFind([room]));
    more.disabled = Boolean(activeJob) || Boolean(room.skipped);
    tools.append(
      more,
      button(room.skipped ? "Include room" : "Skip room", "btn ghost small", () =>
        withRoom(room.key, (r) => ({ ...r, skipped: !r.skipped })),
      ),
    );
    head.append(tools);
  }
  section.append(head);
  if (room.skipped) {
    section.append(el("p", "stage-panel-soon", "Skipped: this room won't become a world. Its picks are kept."));
    return section;
  }

  const images = [...found, ...room.own];
  if (images.length === 0) {
    section.append(
      el(
        "p",
        "stage-panel-soon",
        activeJob ? "Claude is looking for images…" : "No images yet. Find some, or add your own below.",
      ),
    );
  } else {
    const grid = el("div", "ref-grid");
    images.forEach((image) => grid.append(tile(room, image, context)));
    section.append(grid);
  }
  if (editable) {
    section.append(ownImageRow(room, input, withRoom));
    acceptDrops(section, room, context);
  }
  return section;
}

function tile(room: ReferenceRoom, image: ReferenceImage, context: RoomContext) {
  const { input, withRoom } = context;
  const { editable } = input;
  const order = room.picked.indexOf(image.url);
  const picked = order >= 0;
  const card = el("div", `ref-tile${picked ? " picked" : ""}`);

  const pick = el("button", "ref-pick");
  pick.type = "button";
  pick.disabled = !editable;
  pick.setAttribute("aria-pressed", String(picked));
  pick.setAttribute("aria-label", `${picked ? "Unpick" : "Pick"} ${image.title ?? "image"} for ${room.name}`);
  const img = el("img");
  img.src = image.thumb ?? image.url;
  img.alt = image.title ?? "";
  img.loading = "lazy";
  // Many sites refuse hotlinked images that carry a referrer.
  img.referrerPolicy = "no-referrer";
  pick.append(img);
  if (picked) pick.append(el("span", "ref-badge", order === 0 ? "★ Anchor" : String(order + 1)));

  const size = el("span", "ref-size");
  const showSize = (width?: number, height?: number) => {
    if (!width || !height) {
      size.textContent = "";
      return;
    }
    const low = width < SHARP_REFERENCE_WIDTH;
    size.textContent = low ? `${width}×${height} · low-res, may look soft` : `${width}×${height}`;
    size.classList.toggle("low", low);
  };
  showSize(image.width, image.height);
  img.addEventListener("load", () => {
    // A thumbnail's own size says nothing about the full image.
    if (!image.width && !image.thumb) showSize(img.naturalWidth, img.naturalHeight);
  });
  img.addEventListener("error", () => {
    card.classList.add("broken");
    size.textContent = "Couldn't load this image";
    if (!picked) pick.disabled = true;
  });
  pick.addEventListener("click", () => {
    if (picked) {
      withRoom(room.key, (r) => ({ ...r, picked: r.picked.filter((url) => url !== image.url) }));
    } else if (room.picked.length < MAX_REFERENCES_PER_ROOM) {
      withRoom(room.key, (r) => ({ ...r, picked: [...r.picked, image.url] }));
    }
  });
  if (!picked && room.picked.length >= MAX_REFERENCES_PER_ROOM) {
    pick.disabled = true;
    pick.title = `A world uses at most ${MAX_REFERENCES_PER_ROOM} images. Unpick one first.`;
  }
  card.append(pick);

  const meta = el("div", "ref-meta");
  meta.append(size);
  if (image.source) {
    const link = el("a", "ref-source");
    link.href = image.source;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    try {
      link.textContent = new URL(image.source).hostname.replace(/^www\./, "");
    } catch {
      link.textContent = "source";
    }
    meta.append(link);
  } else if (image.addedBy === "you") {
    meta.append(el("span", "ref-source", "yours"));
  }
  card.append(meta);

  if (editable) {
    const actions = el("div", "ref-actions");
    if (picked && order > 0) {
      actions.append(
        button("Make anchor", "btn ghost small", () =>
          withRoom(room.key, (r) => ({ ...r, picked: [image.url, ...r.picked.filter((url) => url !== image.url)] })),
        ),
      );
    }
    if (image.addedBy === "you") {
      actions.append(
        button("Remove", "btn ghost small", () =>
          withRoom(room.key, (r) => ({
            ...r,
            own: r.own.filter((own) => own.url !== image.url),
            picked: r.picked.filter((url) => url !== image.url),
          })),
        ),
      );
    }
    if (actions.childElementCount) card.append(actions);
  }
  return card;
}

/** Add an image of your own to a room: paste a link or upload a file. */
function ownImageRow(
  room: ReferenceRoom,
  input: ReferencesStageInput,
  withRoom: RoomContext["withRoom"],
) {
  const draftKey = `${input.project.id}:${room.key}`;
  const row = el("div", "look-row ref-own");
  const link = el("input", "look-input");
  link.type = "text";
  link.placeholder = "Paste an image or a link";
  link.value = linkDrafts.get(draftKey) ?? "";
  link.setAttribute("aria-label", `Paste an image or link for ${room.name}`);
  link.addEventListener("input", () => linkDrafts.set(draftKey, link.value));

  const add = () => {
    if (!addLink(room, link.value, withRoom)) {
      link.focus();
      return;
    }
    linkDrafts.delete(draftKey);
    link.value = "";
    link.blur();
  };
  link.addEventListener("keydown", (event) => {
    if (event.key === "Enter") add();
  });
  // Ctrl+V of a copied image uploads it; a pasted link goes in straight away.
  link.addEventListener("paste", (event) => {
    const data = event.clipboardData;
    if (!data) return;
    const images = [...data.files].filter((file) => file.type.startsWith("image/"));
    if (images.length) {
      event.preventDefault();
      images.forEach((file) => input.onUpload(room, file));
      // Let go of the box so the room redraws and shows the new image.
      link.blur();
      return;
    }
    if (addLink(room, data.getData("text"), withRoom)) {
      event.preventDefault();
      linkDrafts.delete(draftKey);
      link.value = "";
      link.blur();
    }
  });

  const file = el("input");
  file.type = "file";
  file.accept = "image/jpeg,image/png,image/webp";
  file.hidden = true;
  file.addEventListener("change", () => {
    const chosen = file.files?.[0];
    if (chosen) input.onUpload(room, chosen);
    file.value = "";
  });

  row.append(link, button("Add", "btn", add), button("Upload", "btn", () => file.click()), file);
  return row;
}

/** Add an image link to a room and pick it. False when the text isn't a web link. */
function addLink(room: ReferenceRoom, text: string, withRoom: RoomContext["withRoom"]) {
  const url = text.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return false;
  withRoom(room.key, (r) =>
    r.own.some((own) => own.url === url)
      ? r
      : {
          ...r,
          own: [...r.own, { url, addedBy: "you" }],
          picked: r.picked.length < MAX_REFERENCES_PER_ROOM ? [...r.picked, url] : r.picked,
        },
  );
  return true;
}

/** Dropping image files or links (e.g. dragged from another tab) onto a room adds them. */
function acceptDrops(section: HTMLElement, room: ReferenceRoom, context: RoomContext) {
  const { input, withRoom } = context;
  section.addEventListener("dragover", (event) => {
    event.preventDefault();
    section.classList.add("drop-over");
  });
  section.addEventListener("dragleave", (event) => {
    if (!section.contains(event.relatedTarget as Node | null)) section.classList.remove("drop-over");
  });
  section.addEventListener("drop", (event) => {
    event.preventDefault();
    section.classList.remove("drop-over");
    const data = event.dataTransfer;
    if (!data) return;
    const images = [...data.files].filter((file) => file.type.startsWith("image/"));
    if (images.length) {
      images.forEach((file) => input.onUpload(room, file));
      return;
    }
    const uri = data.getData("text/uri-list").split("\n").find((line) => line && !line.startsWith("#"));
    addLink(room, uri ?? data.getData("text"), withRoom);
  });
}

function addRoomForm(save: (next: References) => void, input: ReferencesStageInput) {
  const box = el("div", "topic-box");
  box.append(el("span", "look-label", "Add a room (each room is one more world)"));
  const row = el("div", "look-row");
  const name = el("input", "look-input ref-room-name");
  name.placeholder = "Room name, e.g. Arcade";
  name.maxLength = 80;
  const visual = el("input", "look-input");
  visual.placeholder = "What it looks like";
  visual.maxLength = 300;
  const add = () => {
    const roomName = name.value.trim();
    if (!roomName) {
      name.focus();
      return;
    }
    const rooms = input.current().rooms;
    const room: ReferenceRoom = {
      key: roomKey(roomName, rooms.map((r) => r.key)),
      name: roomName,
      visual: visual.value.trim() || roomName,
      picked: [],
      own: [],
    };
    name.blur();
    visual.blur();
    save({ rooms: [...rooms, room] });
    input.onFind([room]);
  };
  row.append(name, visual, button("Add room", "btn", add));
  box.append(row);
  return box;
}
