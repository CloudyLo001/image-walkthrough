# Automation jobs

The Automation page queues work in `automation/jobs.json`, and a Claude Code session carries it out. This is the same split as world generation in `GENERATION.md`: the page records the request, and the agent does the work. The judgement rules for every job are in the `mint-reels` skill (`.claude/skills/mint-reels/`). Read the reference named for each job before doing it.

Everything under `automation/` is local and gitignored.

## Watching for jobs

Arm a monitor when a session starts:

```text
Monitor, persistent, polling automation/jobs.json every 5s and emitting a
line for each job whose status is "requested".
```

Without a monitor, a job waits until someone asks, for example "check automation jobs". Then read the file and do every `requested` job, oldest first. The page shows a hint if a job sits unclaimed for more than 30 seconds.

## Job lifecycle

A job looks like this:

```json
{ "id": "job-…", "kind": "research", "status": "requested", "projectId": "…", "input": {}, "requestedAt": "…" }
```

1. Set `"status": "running"` and `"startedAt"` before starting. The page shows it immediately.
2. While working, update `"progress": { "label": "Reading TikTok Studio", "percent": 40 }`. `percent` is optional; without it the page shows a moving bar.
3. Finish with `"status": "done"` and `"finishedAt"`, or with `"status": "failed"` and an `"error"` sentence the user can act on.
4. If the user cancels, the page sets `"status": "cancelled"`. Check before each slow step, and stop if it's set.
5. Edit `jobs.json` in place and change only the job you are working on. The dev server may add new jobs at the same time.

Long jobs such as research run in a background agent, so the session stays free for other projects' jobs.

## `research`: the daily run

Input: none. Produces today's ideas file, `automation/ideas/<YYYY-MM-DD>.json` (local date).

1. **Rankings.** Follow "Daily research" in the skill's `SKILL.md`:
   - YouTube: `yt-dlp` metadata only.
   - TikTok: TikTok Studio sorted by Views, in the user's Chrome. Read-only.
   - Instagram: the reels grid, in the user's Chrome. Read-only.
2. **Own posts.** Check how the newest posts are doing, and what is trending this week in sounds, topics and room aesthetics.
3. **Update the skill.** Refresh `references/top-posts.md`, and adjust the other references only when the data supports it.
4. **Write up to 20 ideas.** Use the mix in `references/themes.md` (about 8 proven, 6 older, 6 new). Hooks follow `hooks.md` and captions follow `captions.md`: 3–9 words plus 4–5 hashtags.
   - Don't repeat an idea from the last 7 days of idea files, or a project that already exists.
   - Keep today's ideas whose `projectId` is set, and ideas tagged `yours`. Replace only the rest.
5. **Check the file.** Run `npm run ideas:check -- automation/ideas/<date>.json`. It fails on:
   - a caption that isn't 3–9 words plus 4–5 hashtags;
   - a missing hook or caption;
   - a hook or caption that repeats a past post word for word. Reusing a past line means tweaking it.

   Fix everything it reports, then run it again.
6. **Mark the job done.** Put a one-line summary of what changed in the file's `summary`.

The file format is `IdeaDay` in `src/automation/types.ts`:

```json
{
  "date": "2026-09-24",
  "generatedAt": "2026-09-24T14:00:00.000Z",
  "summary": "Celebrity houses still lead; Drake's old houses (Sep 18) hit 1.6M on YouTube in 6 days.",
  "ideas": [
    {
      "id": "drake-toronto-mansion",
      "title": "Drake's old Toronto mansion",
      "tag": "proven",
      "bucket": "Celebrity houses",
      "why": "Remix of “id rather have drake's old houses” (1.6M YouTube, 6 days old).",
      "rooms": [
        { "name": "Great room", "visual": "Double-height stone great room with a gold chandelier" },
        { "name": "Indoor pool", "visual": "Dark tiled pool hall with a basketball-court mural" }
      ],
      "hooks": [
        "so yall are telling me you'd rather have a starter home than THIS?!",
        "pov: you're drake's cousin and he let you stay the summer"
      ],
      "captions": [
        "id rather have drake's toronto house #roomdesign #rareaesthetic #drake #mansion",
        "i could never afford the pool alone #drake #mansion #roomdesign #rareaesthetic"
      ],
      "audioHints": ["a slowed early-2010s Drake instrumental", "a trending luxury house tour sound"]
    }
  ]
}
```

Rules:
- `id` is a unique kebab-case slug within the file.
- `tag` is `proven`, `older`, `new` or `yours`.
- An idea has 1–4 `rooms`; each room is one Mint world, so the room count is the credit count.
- An idea has exactly 2 `hooks` and 2 `captions`. The two options in each pair use different formulas.
- **Past days are a permanent record.** Never delete or rewrite an earlier day's file. The only change allowed is the dev server setting or clearing `projectId`. The page lists every day, with how many ideas it had and how many were picked.

## `ideate`: the user's own topic

Input: `{ "topic": "…" }`, and optionally a `projectId` when the topic was typed inside a project.

1. Expand the topic into one idea, using the same skill rules as research. Set `"tag": "yours"` and `"topic"` to the original text. With a `projectId`, also set `"forProject"`, which puts the idea at the top of that project's picker.
2. Append it to today's ideas file, creating the file if needed with `generatedAt` set to now and an empty `ideas` list. Never remove existing ideas.
3. Run `npm run ideas:check -- automation/ideas/<date>.json`, and fix anything it reports.
4. Mark the job done.

Picking an idea is the user's step: they click it in the page. Never set a project's idea yourself.

## `hooks`: more hook and caption options for a project

Input: `{ "note": "…" }` (optional, e.g. "funnier" or "mention the pool"). The job always has a `projectId`.

1. Read the project with `GET /api/automation/projects/<projectId>`. You'll need:
   - its idea (`data.idea`), which holds the original 2 hooks and 2 captions;
   - any options already added (`data.hookOptions`);
   - what the user has picked or typed so far (`data.approved`).
2. Write **2 new hooks and 2 new captions**, following `hooks.md` and `captions.md`, and the note if there is one. Don't repeat any existing option.
3. Append them to the existing lists, never replacing them. Save with:

   ```bash
   curl -X PATCH http://127.0.0.1:<port>/api/automation/projects/<projectId> \
     -H "Content-Type: application/json" \
     -d '{"data":{"hookOptions":{"hooks":[…all hooks…],"captions":[…all captions…]}}}'
   ```

   Stage data merges one key at a time, so this never touches the user's `data.approved`.
4. Mark the job done.

The user still makes the choice. Never write `data.approved` or move the project to the next stage.

## `references`: find images for a project's rooms

Input: `{ "rooms": [{ "key", "name", "visual" }], "note"?: "…" }`. The job always has a `projectId`. The page queues it on its own when a project reaches stage 3, and again when you ask for more images for a room or add a room.

1. Read `references.md` in the skill: what a good reference looks like, where to look, and how to check one.
2. Read the project with `GET /api/automation/projects/<projectId>` for its idea, and for its current `data.referenceOptions` (the candidates Claude already found, keyed by room key).
3. For each room in the input, find **4–6 candidates**. Update `progress` as you go, e.g. `"Finding images: Arcade (2 of 3)"`.
   - **Search for the subject first.** Look for the real place the idea, topic and hook name, e.g. "Drake's old Toronto mansion" means photos of The Embassy itself. Follow "Search for the subject first" in `references.md`: for a named place, run a Bing Images search in the browser, then look at the candidates before saving them.
   - Only for generic rooms, start with `npm run refs:search -- "<query>" ["<another query>" …]`. It searches Openverse and Wikimedia Commons, keeps landscape images at least 1200 px wide, and prints each one's `url`, `thumb`, `source` and size. Try 2–4 phrasings per room.
   - Choose by fit with the room's `visual` line, not just by size.
   - When a room gets fewer than 3 good candidates, say so in the job's final `progress` label. The user can paste their own images into the room.
   - Include `thumb`, a small preview of about 960 px, whenever the full image is large, so the page loads quickly.
   - Wikimedia rate-limits fast bursts of requests; pause between checks.
4. Merge the new candidates into the existing lists, with no duplicate URLs, and save:

   ```bash
   curl -X PATCH http://127.0.0.1:<port>/api/automation/projects/<projectId> \
     -H "Content-Type: application/json" \
     -d '{"data":{"referenceOptions":{"<roomKey>":[{"url":"…","thumb":"…","source":"…","title":"…","width":2400,"height":1600,"addedBy":"claude"}], …every room…}}}'
   ```

   Send every room's full list, because `referenceOptions` is replaced as a whole. The user's picks live in `data.references`, which this never touches.
5. Mark the job done.

The user does the picking. Never write `data.references` or move the project to the next stage. Downloading, hosting and sending the images to Mint happens in stage 4, after the credit approval.

## `worlds`: build a project's worlds (spends credits)

Input: `{ "rooms": [{ "key", "name", "visual", "images": [anchor, …up to 6], "sharpen": bool }], "credits": n, "approvedAt": "…" }`. The job always has a `projectId`.

**This is the only job that spends Mint credits.** The page creates it only after the user confirms the amount in a dialog. That confirmation is the go-ahead for exactly these rooms and no more:
- Never create, widen or re-run a `worlds` job yourself.
- A world costs its preview plus its final build (150 + 1,500 = 1,650 credits), and each sharpened anchor adds one image (100). If `credits` is clearly less than that total, stop. Set the job to `failed` with an `error` asking the user to press Build again.
- Mint can't cancel a started world. Check the job's `status` before starting each room, and skip the room if the user cancelled.

**All rooms build at the same time.** Each `start_world_generation` call opens its own Mint chat and returns straight away, like starting several chats on mint.gg. So start every room first and wait on them together. Three rooms then take about as long as one, usually four to six minutes. Never build rooms one after another.

**As fast as possible, without cutting quality.**
- Don't budget or wait for a fixed time.
- Start everything the moment the job is picked up, poll in short steps, and move each room on the instant Mint reports it final.
- Speed only ever comes from removing waiting: parallel starts, short polls, and registering straight away. It never comes from skipping the sharp anchor, dropping reference photos, trimming the expansion prompt, or using lower-quality settings.

1. **Report progress.** Set `data.worlds[<roomKey>]` with a `PATCH` that sends the whole `worlds` object, because it's replaced as a whole.
   - Walk through the statuses `sharpening`, `generating`, `importing`, then `ready` or `failed`, each with a short `label`.
   - Set `startedAt` when a room's generation starts and `finishedAt` when it's ready or failed. The page shows the real time taken, which keeps the time estimate honest.
2. **Get the images to Mint.**
   - Web links (`http…`) go straight to `start_world_generation` as `image_url` / `source_images`; Mint fetches them itself.
   - Pasted or uploaded files (`/api/automation/projects/<id>/refs/…`) are only on this computer. **Ask the user in chat** before hosting them anywhere public (see the `mint-local-image-hosting` memory). If they can't be hosted, build without them and say so in the room's `label`.
   - If Mint rejects a link (hotlink blocked, a page instead of an image), drop that one and carry on with the rest. Only fail the room if the anchor itself can't be used.
3. **Sharpen anchors, all at once.** For every room with `sharpen: true`:
   - Look at the anchor, then describe that exact scene in a `start_image_generation` prompt: the place's name, the room, materials, light, a wide eye-level view, empty of people.
   - Start all of these image generations back to back, then wait on them together with `wait_for_many` (`asset_type: "image"`).
   - Each sharp image becomes that room's `image_url`. Keep the picked photos as `source_images` so the result doesn't drift from the real place. Follow "When the photos are too small" in `GENERATION.md`.
4. **Start every world**, back to back, with `start_world_generation` and `mode: "auto"`, using `project_id` from `mint-assets.json`.
   - The prompt follows `GENERATION.md`: name the real place, and write an expansion prompt that names 4–6 adjacent areas that fit this room of this place.
   - Ask for one continuous floor and room to walk around the furniture.
   - Add the multi-photo sentence when there are several images.
   - Save each `chatUrl` and `startedAt` into its room's status as soon as that call returns.
5. **Wait on all of them together** with `wait_for_many` (`asset_type: "world"`, `until_stage: "final"`). Use short waits, about 30 seconds each with `poll_interval_ms` around 5000, and repeat until every world has finished or failed.
   - Between waits, update each room's `label` (e.g. "Mint is building the world (3 min so far)").
   - Check the job hasn't been cancelled.
   - Register each world as soon as it finishes; don't wait for the slowest one.
6. **Register it**, like "Importing a world made elsewhere" in `GENERATION.md`:
   - Save the `get_asset_artifact_manifest` result to a temporary file.
   - Run `npm run mint:sync -- --manifest <file> --key <worldKey>`. The world key is `<projectId>-<roomKey>`, cut to 48 characters, with `-2`, `-3` and so on if it's taken.
   - Add `{ "title": "<Project name>: <Room name>", "mintAssetId": …, "mintChatId": … }` at the end of `worlds.config.json`. Several worlds finishing close together means several edits to this file, so make them one at a time.
   - Run `npm run worlds:publish`. Once for the whole batch at the end is fine.
7. **Mark it ready.** Set the room to `ready` with `worldKey` and `finishedAt`, plus `credits` if you know them.

When every room is done:
- Check the balance with `get_credits_balance` and rewrite `automation/mint.json` (`available`, `worldCredits` = preview + final, currently 1,650; `previewCredits`; `imageCredits`, currently 100; `updatedAt`) so the page shows it.
- Set the project's `activity` to `{ "label": "Waiting for you: record or pick clips", "tone": "waiting" }`, or to an `error` tone naming any failed room.
- Mark the job done.

Never move the project to the next stage; the user does that.

## What the page does without Claude

These actions go straight to the dev server and need no job:
- Picking ideas starts projects: `POST /api/automation/ideas/<date>/use`.
- Autosave, delete to trash, restore and archive.
