# Generation recipe

How a photo in `./uploads/` becomes a walkable world. The agent (Claude Code
with the Mint MCP connected) runs these steps; the browser never calls Mint.

## Always ask for a bigger space

A photo sent on its own produces a small world. Mint builds confident detail
only around what the camera saw, so an image-only generation gives you roughly
one room and a few metres of walking before you reach the edge. The first world
built from a living-room photo measured about 16 by 28 metres, and a straight
line from the spawn ran into furniture within 2 to 4 metres in every direction.

**Every generation gets an expansion prompt.** It costs no extra credits and
takes about the same time. Without it you get a room; with it you get somewhere
to walk.

Write the prompt fresh for each photo rather than pasting a template. Look at
the image, decide what kind of place it is, and name the neighbouring areas a
real example of that place would have. The shape to follow:

```text
Expand this photographed <PLACE> into a large, fully explorable <PLACE TYPE>
that a person can walk through for a long time. Keep the space in the
photograph exactly as the anchor, then extend it into generously sized
connected areas that continue naturally from it: <FOUR TO SIX NAMED AREAS>.
Every area must share one continuous, unobstructed floor with wide openings
and clear sightlines between them, so there are no dead ends or blocked
passages. Keep generous circulation space around all furniture. Maintain the
same <MATERIALS, LIGHT AND TIME OF DAY> throughout.
```

Use your judgement on the named areas. A few worked examples:

| Photo | Areas worth naming |
| --- | --- |
| Living room | open kitchen and dining area, wide hallway, second lounge, bedroom off the hall, planted courtyard with a path around it |
| Office desk | open desk floor, meeting rooms along a corridor, kitchenette, breakout lounge, roof terrace |
| Cafe interior | counter and seating area, mezzanine, back courtyard, kitchen pass, street entrance with pavement seating |
| Street corner | pavement continuing both ways, a side street, a small square, shopfronts you can walk up to, an alley |
| Hotel lobby | reception hall, lounge and bar, lift lobby, corridor of rooms, garden terrace |
| Museum gallery | connected galleries in sequence, central atrium, staircase to a second floor, cafe, courtyard |
| Game screenshot | whatever the setting implies, plus an explicit instruction to build only the physical environment with no interface, score, buttons, pickups or characters |

Three rules carry most of the effect:

- **Name specific areas.** Asking for "a bigger space" changes nothing; a list
  of rooms gets built.
- **Demand one continuous floor.** The walkthrough grounds the player on the
  collider mesh. Areas the generator leaves at a different level or behind a
  closed door are visible but unreachable.
- **Ask for circulation space.** Tight furniture layouts read as walls to the
  collider and leave nowhere to walk.

Do not promise a size. The generator decides the footprint; the prompt improves
the odds, and results vary between runs.

## Several photos of one place

A world can use up to six photos: one anchor plus five more references. More
real photos of the same place is the single biggest quality lever available,
because the generator stops inventing the areas it cannot see. Judge it by the
sharpness of the rooms beyond the anchor view, not just by the collider size.

The photo list lives in `sourceImages`, anchor first. Older entries carry only
`sourceImage`; read them as `sourceImages ?? [sourceImage]` and never branch on
which field is present. When you rewrite an entry, preserve **both** fields.

Upload every photo, then pass the anchor's CDN URL as `image_url` and the full
list (up to six, anchor included) as `source_images`. The anchor decides the
spawn viewpoint and the title.

For a multi-photo run, add one sentence to the expansion prompt saying the
photographs are different viewpoints of a single place that must be reconciled
into one continuous space, and that the named neighbouring areas extend beyond
what any of them show.

## The look prompt

The Photos box has a text field where the user describes how the world should
look. Whatever they typed is stored on the entry as `lookPrompt`.

**Their text guides the look; yours keeps the world walkable.** Do not send
`lookPrompt` to Mint on its own and do not drop your structural prompt because
they wrote one. Keep writing the part that makes a world big and traversable,
the named connected areas, the one continuous unobstructed floor, the room to
move around furniture, and the instruction to build no interface or characters.
Then let `lookPrompt` govern the material, mood, palette, era, weather and time
of day, replacing whatever you would have written for those.

Where the two disagree, theirs wins on appearance and yours wins on layout. If
they ask for something that would break walkability, such as a flooded ruin or
a room with no floor, honour the look but keep a continuous walkable route
through it, and say so when you report back.

Quote their words in the prompt rather than paraphrasing, so the wording they
chose actually reaches the generator.

## The Generate button

A row for an unclaimed upload has a **Generate** button. Pressing it adds the
world to `worlds.config.json` with `"status": "requested"` and a key derived
from the anchor filename.

Dropping several photos at once instead creates one entry with
`"status": "draft"`. **A draft is only a grouping. Never generate a draft.**
It becomes a real request when the user presses Generate on that row, which
flips it to `"requested"`. Ticking photos and using the batch bar goes straight
to `"requested"`.

**Mint has no HTTP API**, so the page cannot start a world itself. The button
records the request; the agent performs it. Two ways it gets picked up:

- While a Claude session is running with a monitor armed on this file, the
  request is noticed within about five seconds and generation starts on its
  own. This is the automatic path.
- Otherwise the request waits. Any message to Claude prompts it to check for
  `"status": "requested"` entries and start them.

The lobby separates photos not built yet, worlds in progress, and finished
environments into three boxes, so a queued world never sits among the photos
you are still choosing. A requested row shows Stop, so a queued request can be
withdrawn before any credits are spent. Arm the monitor with:

```text
Monitor, persistent, polling worlds.config.json every 5s and emitting a line
for each new entry whose status is "requested" or "importing".
```

When starting a requested world, replace the filename-derived title with a real
one, set `"status": "generating"`, and keep `sourceImage`, `sourceImages` and
`lookPrompt` untouched.

The Ungroup button on a draft, and Remove on a stopped or failed row, delete the
entry through the dev server and free its photos.

## Steps

1. Host every photo on a public URL. Mint accepts URLs or base64, and base64 of
   even a small JPEG is too large to pass through a tool result. Upload each
   local file, then use the returned CDN URLs, keeping the anchor first.
2. Call `start_world_generation` with `project_id` from `mint-assets.json`, the
   anchor as `image_url`, every photo in `source_images`, your expansion prompt,
   and `mode: "auto"`.
3. Add the world to `worlds.config.json`, or update the requested entry the
   Generate button already created, so the app shows a row with a Stop button:

   ```json
   {
     "worlds": {
       "living-room": {
         "title": "Living Room",
         "sourceImage": "uploads/living-room.jpg",
         "sourceImages": [
           "uploads/living-room.jpg",
           "uploads/living-room-window.jpg",
           "uploads/kitchen.jpg"
         ],
         "status": "generating"
       }
     }
   }
   ```

4. Poll `wait_for_status` with `until_stage: "final"`. Stages run preview, then
   final generation, then post-processing. Expect roughly ten minutes, longer
   for a larger requested space.
5. **Check for a stop between polls.** If `worlds.config.json` shows
   `"status": "cancelled"` for that key, the user pressed Stop: abandon the
   generation, do not register it, and leave the row as it is.
6. Fetch `get_asset_artifact_manifest` with `asset_type: "world"`, save it to a
   temporary JSON file, and register it:

   ```bash
   npm run mint:sync -- --manifest C:/path/to/manifest.json --key living-room
   ```

7. Remove the `status` line from `worlds.config.json`. The row switches to
   Ready with an Enter button. The lobby polls every five seconds while a world
   is working, so this appears without a manual refresh.

## Stopping a generation

The Stop button on a working row marks it `cancelled` in `worlds.config.json`
through the dev server.

**Mint has no cancel API.** Stop tells this project to give up on the world: the
agent stops polling and never registers it. The job keeps running on Mint's
side and the credits are already spent. Stop is for "I do not want this in my
app", not for "refund me". A stopped world can be found later in the Mint chat
if you change your mind.

## Importing a world made elsewhere

Not every world starts as a photo here. Worlds built in the Mint chat, or in
another Mint project, already exist on the account and only need registering.

The lobby has a paste field under the drop zone: a `mint.gg` link or a bare
asset id, then **Add**. That writes a provisional entry to `worlds.config.json`
with `"status": "importing"`, plus `mintAssetId` or `mintChatId` and the raw
`mintSource`. Nothing is spent and nothing runs on Mint. The browser cannot call
Mint, so the agent finishes it, exactly like a generation request.

1. **Resolve it to an asset id.**
   - `mintAssetId`: call `get_asset` with `asset_type: "world"` to confirm the
     user owns it, that the final output is ready, and to read its name.
   - `mintChatId`, or a bare id `get_asset` cannot find: call `list_my_assets`
     with **no `project_id`**, so the search covers the whole account including
     other projects, paging with `cursor` at `limit: 50`. Match the asset whose
     `chatUrl` ends with the chat id. If a chat holds several worlds, take the
     newest finished one and say which you chose.
   - Not found, not owned, or not final: set `"status": "failed"` on the
     provisional entry with a plain note such as `"Could not find that world in
     your Mint account."` and stop. The row then offers Remove.

2. **Choose the final key from the world's Mint name**, not from the id:
   lowercase, non-alphanumerics to `-`, at most 48 characters, such as
   `hidden-ninja-village`. If that key already exists in `mint-assets.json` or
   `worlds.config.json`, add `-2`, `-3` and so on rather than refusing. Nothing
   stops the same world being imported twice, and two different Mint worlds can
   share a name, so a taken key is a normal outcome and not a mistake. Give both
   rows the same title: the key keeps them apart, the user does not need to.

3. **Register it.** Fetch `get_asset_artifact_manifest` with
   `asset_type: "world"`, save it to a temporary JSON file, then:

   ```bash
   npm run mint:sync -- --manifest C:/path/to/manifest.json --key hidden-ninja-village
   ```

   The sync keeps `mintProject` from the existing registry, so importing from
   another Mint project does not repoint the project new generations use.

4. **Rewrite the entry.** Delete the provisional `import-…` key and add the
   final one:

   ```json
   {
     "worlds": {
       "hidden-ninja-village": {
         "title": "Hidden Ninja Village",
         "mintChatId": "ph7fewdv11zz2w8g3smnw3p6hn8dv4an"
       }
     }
   }
   ```

   No `status`, no `sourceImage`, no `sourceImages`: an imported world has no
   photos of its own, exactly like `cinema-palace`. `mintChatId` records where
   the world came from. **Deleting the provisional key is not optional.** Leave
   it and the lobby shows an "Importing" row that never clears and re-polls
   every five seconds.

5. **Check for a withdrawal between steps**, the same as the Stop check. An
   import row offers Remove, so if the provisional key has disappeared from
   `worlds.config.json` when you come back, the user withdrew it: do not
   register it and do not recreate the entry.

Writing `mint-assets.json` reloads the page, so a second or two after the sync
the world appears in Environments on its own. Say so when reporting back, and
mention that the reload drops anyone currently inside a world back to the lobby.

## Framing the opening view

The app opens facing whichever direction has the longest clear line of sight.
In a room that lands well. In open country it is arbitrary, and the subject can
end up behind the player.

Set `spawnFacing` in `worlds.config.json` to a compass bearing in degrees to
override it. The automatic sweep is skipped when it is present, and the load
line reports `fixed <n>deg` instead of an open-view distance.

```json
"farmland": { "title": "Farmland", "spawnFacing": 180 }
```

Find the right bearing by entering the world, turning until the subject is
centred, and reading the yaw the app reports.

## Distance is set by the anchor image, not the prompt

Mint composes a world to match its anchor. If the subject should look far away,
the anchor must already show it far away: wording alone loses to the picture.
When two framings of one scene are available, anchor on the one where the
subject is smallest, and do not send a closer framing as a second reference,
because the two disagree on the very thing being controlled.

Measure it rather than eyeballing: the farmland anchor went from the subject
occupying 8.4% of frame width to 5.0%, and that single change moved the house
from mid-field to the horizon. Also forbid paths, tracks and fence lines
leading to a distant subject, since one of those makes it read as a
destination however small it is.

## When the photos are too small, or must contain readable text

Source resolution caps world quality. Photos around 700 pixels wide produce a
soft world however good the prompt. Two things help, in order:

1. **Generate a clean anchor with Mint's own image tool.** Describe the anchor
   scene in a text prompt and run `start_image_generation`. It returns a sharp
   1408 by 768 image on Mint's CDN that can be passed straight to
   `start_world_generation` as `image_url`. This is also the only reliable way
   to get legible lettering: text spelled in the anchor image survives into
   the world far better than text asked for in the world prompt alone. Ask for
   the scene empty of people, since crowds resolve badly in a splat.
2. **Use review mode and look at the preview** before approving. The preview
   costs about a minute; the final costs seven or more. Download the preview
   image and check it, then `approve_final_generation` or `revise_preview`.

Keep the original photos as secondary references so the generated anchor does
not drift from the real place. Drop any reference whose lighting or viewpoint
contradicts the rest, such as a dusk aerial among daylight ground shots.

Mint's image editor only works on images Mint generated, not on uploads, and
third party upscalers need their own credits, so generating an anchor is the
dependable route.

To rebuild an existing world at higher quality, start the new generation with
the previous world's `chat_id` so Mint keeps the context, then sync under the
same registry key to replace it in place.

## Check the result

Entering a world logs its collider size to the browser console:

```text
[world] collider bounds 15.67×6.13×27.77, floor at -0.12, eye at 1.48, open view 17.8m
```

The first three numbers are width, height and depth in metres, and `open view`
is the longest clear line of sight from the spawn. Compare them across runs to
see whether a prompt actually produced a bigger space. Under about 10 metres
wide is a single room.

If a world comes back cramped, regenerate with more named areas rather than
adjusting the app. Size is fixed at generation time and cannot be changed
afterwards.
