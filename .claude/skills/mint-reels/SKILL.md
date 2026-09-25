---
name: mint-reels
description: Make 6-10 second @madeonmint reels from Mint worlds - daily research and ideas, hooks, captions, shot picking, first-cut editing rules and audio suggestions. Use for any job in the Automation page's queue (automation/jobs.json) or when asked to ideate, write hooks or captions, or edit a Mint reel.
---

# Mint reels

This skill turns Mint worlds, rendered in Nostalgic Engine, into short vertical reels for @madeonmint on TikTok, YouTube Shorts and Instagram. It covers the judgement steps. The page, the renderer and the export are code in this repo.

## Read first, by task

| Task | Read |
|---|---|
| Research, or making the daily ideas | `references/top-posts.md`, `references/themes.md` |
| Hooks | `references/hooks.md` |
| Captions and hashtags | `references/captions.md` |
| Finding reference images | `references/references.md` |
| Picking shots | `references/shots.md` |
| First cut | `references/edit-rules.md` |
| Suggesting audio | `references/audio.md` |

## Non-negotiables

- **Captions are 3–9 words plus 4–5 hashtags.** Hooks are a separate line, burned into the video.
- **Reuse means tweak.** A past hook, caption or topic can come back, but never word for word. `npm run ideas:check -- <ideas file>` catches exact repeats and caption-rule breaks; run it before finishing any ideas job.
- **Reels are 6–10 s** long, 1080×1920.
- **Never spend Mint credits without the user's go-ahead.** Show the number of worlds and the cost first.
- **Never post without an explicit yes in chat for that post.**
- Audio is always the last editing step. Always export a silent copy too.
- Each video is its own project. Never touch another project's files while working on one.

## Daily research

1. **Rankings:**
   - YouTube: run `yt-dlp --flat-playlist -J https://www.youtube.com/@madeonmint/shorts` and sort by `view_count`.
   - TikTok: TikTok Studio post list, sorted by Views, in the user's Chrome. Read-only.
   - Instagram: the reels grid or Insights, in the user's Chrome. Read-only.
2. **Own posts:** update the stats of our own recent posts (the metrics loop), and look at what changed: which new posts beat the median, and which formats dropped off.
3. **Trends:** note what is trending this week in sounds, topics and room aesthetics.
4. **Update the skill:** rewrite `references/top-posts.md` and adjust the rules in the other references when the data says so. Keep changes small and dated.
5. **Ideas:** write up to 20 ideas in the mix from `references/themes.md`.

## Known gaps (2026-09-24)

- Cut counts and per-clip lengths have not been measured yet. Measuring them needs the top videos downloaded for ffmpeg scene detection, which needs the user's permission.
- Most of the top TikToks are from February to June. The newest TikToks (Sep 22–23) had 300–6,600 views after 1–2 days, but on YouTube "id rather have drake's old houses" (Sep 18) reached 1.6M. Track the first 7 days of each new post before concluding that reach has dropped.
- ffmpeg `drawtext` crashes on this PC (no fontconfig). Burn text in by drawing a PNG in the browser, not with drawtext.
