import type { IdeaDay, IdeaDaySummary, Job, JobKind, MintInfo, Project, ProjectPatch } from "./types";

export type Shelf = "projects" | "archive" | "trash";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/automation${path}`, {
    cache: "no-store",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // An empty or non-JSON reply falls through to the status check.
  }
  if (!response.ok) {
    const message = (body as { error?: string } | null)?.error;
    throw new Error(message ?? `The dev server answered ${response.status}.`);
  }
  return body as T;
}

export async function listProjects(shelf: Shelf) {
  return (await call<{ projects: Project[] }>(`/${shelf}`)).projects;
}

export async function createProject(name: string) {
  return (await call<{ project: Project }>("/projects", {
    method: "POST",
    body: JSON.stringify({ name }),
  })).project;
}

export async function patchProject(id: string, patch: ProjectPatch | Record<string, unknown>) {
  return (await call<{ project: Project }>(`/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  })).project;
}

export async function trashProject(id: string) {
  return call<{ project: Project; cancelledJobs: number }>(
    `/projects/${encodeURIComponent(id)}/trash`,
    { method: "POST" },
  );
}

export async function restoreProject(id: string) {
  return (await call<{ project: Project }>(`/trash/${encodeURIComponent(id)}/restore`, {
    method: "POST",
  })).project;
}

export async function archiveProject(id: string) {
  return (await call<{ project: Project }>(`/projects/${encodeURIComponent(id)}/archive`, {
    method: "POST",
  })).project;
}

export async function listJobs() {
  return (await call<{ jobs: Job[] }>("/jobs")).jobs;
}

export async function addJob(kind: JobKind, input: Record<string, unknown> = {}, projectId?: string) {
  return (await call<{ job: Job }>("/jobs", {
    method: "POST",
    body: JSON.stringify({ kind, input, ...(projectId ? { projectId } : {}) }),
  })).job;
}

export async function cancelJob(id: string) {
  return (await call<{ job: Job }>(`/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" })).job;
}

/** Add one of your own images to a project; returns the URL it is served at. */
export async function uploadRef(projectId: string, file: File) {
  const response = await fetch(`/api/automation/projects/${encodeURIComponent(projectId)}/refs`, {
    method: "POST",
    headers: { "X-File-Name": encodeURIComponent(file.name) },
    body: file,
  });
  const body = (await response.json().catch(() => null)) as { url?: string; error?: string } | null;
  if (!response.ok || !body?.url) throw new Error(body?.error ?? "Could not add that image.");
  return body.url;
}

/** The Mint balance and prices as the agent last saw them. */
export async function mintInfo() {
  return (await call<{ mint: MintInfo }>("/mint")).mint;
}

/** The newest day of ideas, plus every day that has some. */
export async function latestIdeas() {
  return call<{ dates: string[]; days: IdeaDaySummary[]; day: IdeaDay | null }>("/ideas");
}

export async function ideaDay(date: string) {
  return (await call<{ day: IdeaDay | null }>(`/ideas/${encodeURIComponent(date)}`)).day;
}

/** Start a project per idea, or, with `projectId`, give that project the one idea. */
export async function useIdeas(date: string, ideaIds: string[], projectId?: string) {
  return (await call<{ projects: Project[] }>(`/ideas/${encodeURIComponent(date)}/use`, {
    method: "POST",
    body: JSON.stringify({ ideaIds, ...(projectId ? { projectId } : {}) }),
  })).projects;
}
