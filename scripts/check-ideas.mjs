#!/usr/bin/env node
// Checks a day of reel ideas against the mint-reels rules before the agent
// finishes a research or ideate job:
//   - 2 hooks and 2 captions per idea, 1–4 rooms, unique ids
//   - every caption is 3–9 words plus 4–5 hashtags
//   - no hook or caption repeats a past post word for word (reuse means tweak)
//
// Usage: npm run ideas:check -- automation/ideas/2026-09-24.json
import { readFileSync } from "node:fs";

const SKILL = ".claude/skills/mint-reels/references";
const file = process.argv[2];
if (!file) {
  console.error("Pass the ideas file to check, e.g. automation/ideas/2026-09-24.json");
  process.exit(2);
}

const norm = (text) =>
  text
    .toLowerCase()
    .replace(/#\S+/g, "")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const dropBrackets = (text) => text.replace(/\([^)]*\)\s*$/, "");
const longEnough = (text) => text.split(" ").length >= 3;

// What has been posted before: captions from top-posts.md, hooks from hooks.md.
const past = new Set();
for (const line of readFileSync(`${SKILL}/top-posts.md`, "utf8").split("\n")) {
  if (!line.startsWith("|")) continue;
  for (const cell of line.split("|")) if (longEnough(norm(cell))) past.add(norm(cell));
}
for (const line of readFileSync(`${SKILL}/hooks.md`, "utf8").split("\n")) {
  const cells = line.split("|");
  if (cells.length <= 3) continue;
  for (const form of [cells[2], dropBrackets(cells[2])]) if (longEnough(norm(form))) past.add(norm(form));
}
const isRepeat = (text) => past.has(norm(text)) || past.has(norm(dropBrackets(text)));

const captionProblem = (caption) => {
  const parts = caption.trim().split(/\s+/).filter(Boolean);
  const hashtags = parts.filter((part) => part.startsWith("#")).length;
  const words = parts.length - hashtags;
  if (words < 3 || words > 9) return `${words} words (needs 3–9)`;
  if (hashtags < 4 || hashtags > 5) return `${hashtags} hashtags (needs 4–5)`;
  return null;
};

const day = JSON.parse(readFileSync(file, "utf8"));
const problems = [];
const ids = new Set();
for (const idea of day.ideas ?? []) {
  const where = idea.id ?? "(no id)";
  if (ids.has(idea.id)) problems.push(`${where}: duplicate id`);
  ids.add(idea.id);
  if (!Array.isArray(idea.hooks) || idea.hooks.length !== 2) problems.push(`${where}: needs exactly 2 hooks`);
  if (!Array.isArray(idea.captions) || idea.captions.length !== 2) problems.push(`${where}: needs exactly 2 captions`);
  if (!Array.isArray(idea.rooms) || idea.rooms.length < 1 || idea.rooms.length > 4) {
    problems.push(`${where}: needs 1–4 rooms`);
  }
  for (const caption of idea.captions ?? []) {
    const problem = captionProblem(caption);
    if (problem) problems.push(`${where}: caption "${caption}" has ${problem}`);
    if (isRepeat(caption)) problems.push(`${where}: caption "${caption}" repeats a past post; tweak it`);
  }
  for (const hook of idea.hooks ?? []) {
    if (isRepeat(hook)) problems.push(`${where}: hook "${hook}" repeats a past post; tweak it`);
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} problem(s) in ${file}`);
  process.exit(1);
}
console.log(`${file}: ${day.ideas.length} ideas pass`);
