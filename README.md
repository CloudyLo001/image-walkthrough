# Photo Walkthrough World

Upload a photo of a room or place, turn it into a Mint world, and walk inside it
in first person.

## Run

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5190. Drop a jpg, png or webp into the drop zone. It is
saved into `./uploads/` and listed as "Waiting for generation".

## Generation loop

The lobby keeps three boxes, each hidden when empty:

- **Photos** — everything not built yet. Tick photos here to combine them, and
  press Generate to start one.
- **In progress** — worlds being built, plus stopped or failed ones you can
  remove.
- **Environments** — finished worlds, ready to walk into.

The Photos box also has a prompt field. Describe how you want the place to
look, in materials, mood, palette, era, weather or time of day, and it is
applied to the next world you generate and shown on that world's row. Claude
still writes the structural part that keeps a world large and walkable, so your
text steers the feel without costing you space to move.

Drop a photo into `./uploads/` and press **Generate** on its row.

Drop **several photos of the same place at once** and they group into one world,
with the first photo as the anchor. The row shows Ungroup and Generate, and
nothing is spent until you press Generate. Photos uploaded separately can be
ticked and combined with the bar at the bottom of the list. Six photos is the
maximum, because that is what Mint accepts, and more real photos is the best way
to get a world that is both larger and sharper.

Mint has no HTTP API, so the page cannot start a world itself. The button
queues the request in `worlds.config.json`; the agent (Claude Code with Mint
MCP) performs it, then registers the result so the row switches to Ready. With
a monitor armed on that file, a press is picked up within seconds and runs
without you typing anything.

Read [GENERATION.md](GENERATION.md) before generating. It covers the expansion
prompt every photo should get, the reason each rule in it matters, and the
console line that tells you how big the resulting world actually is. A photo
sent on its own produces roughly one room; the prompt is what buys you space to
walk.

### Worlds you already made in Mint

Not every world has to start here. The field under the drop zone takes a
`mint.gg` link or an asset id: paste one, press **Add**, and the world joins
your Environments alongside the ones built from photos, with the same controls.
Nothing is generated and no credits are spent — the world already exists, so
this only registers it. As with Generate, the page records the request and
Claude finishes it; the row says *Importing* until it does, then the page
reloads itself and the world is ready to walk into.

Nothing is refused for being a repeat. Paste a link for a world you already have
and you get a second row of it, which is what you want when two Mint worlds share
a name and only you can tell them apart.

A row that is still working shows a Stop button. Stop marks the world
`cancelled` so the agent abandons it and never registers it. Mint has no cancel
API, so the job finishes on their side regardless and the credits are already
spent.

## Sharing

The GitHub Pages copy is view-only: no uploads, no generation, and no way to
change the list. Other people open it and walk the worlds.

The list it shows comes from Convex, a hosted database that pushes changes to
every open page the moment they happen. Publish after each registration and the
new world appears for everyone within a second, with no redeploy:

```bash
npm run worlds:publish
```

It copies the local world list into Convex, uploads only the thumbnails that
changed, and removes rows for worlds no longer registered here. Safe to re-run.
Photos and look prompts are never published; a viewer needs neither.

The only public Convex function is a read query. Every write is an internal
function, callable from this command line as the owner and from nothing else,
so nobody can add, rename or delete a world from the browser.

**Direct links.** `?world=<key>` opens straight into a world, for example
`…/?world=red-sandstone-canyon`. The key is the folder name under
`public/assets/mint/`.

**One-time setup.**

```bash
npx convex dev          # signs in, creates the project, writes .env.local
npm run worlds:publish -- --dev   # try it against the dev deployment
```

Then in the Convex dashboard, Settings → Deploy Keys → generate a production
key, and add it to this repository as the `CONVEX_DEPLOY_KEY` secret. Every
push to `main` then deploys the Convex functions and builds the site with the
production URL baked in. Publish to production once after that first deploy:
`npm run worlds:publish`. Without the secret the site still builds and falls
back to the list bundled at build time.

## Controls

The chevron at the right of the bar collapses it to a small handle, so nothing
sits over the world. Press the handle to bring the controls back. The choice is
remembered between sessions.

Click the world to lock the pointer, then the mouse aims freely, up and down
included. Movement follows exactly where you are aiming: hold W while looking
up and you climb, look down and you descend. A and D strafe level, Shift moves
faster, the left and right arrows turn, the up and down arrows climb and
descend straight, Esc releases the pointer and Exit returns to the lobby.

If the browser refuses pointer lock, which it does inside embedded preview
panes and some iframes, the hint switches to drag-to-look and dragging on the
canvas aims instead.

This is free flight, not walking. There is no gravity and nothing blocks you,
so you can pass through a wall and find yourself outside the world looking at
empty space. Turning around gets you back, and a generous bound around the
world stops you drifting away entirely. The collider is still loaded, and is
used to start you standing at eye height on the floor and to face you toward
the most open direction. Every constant is at the top of
`src/first-person.ts`.

Frame rate is set by two things: how many splats Spark picks for the view, and
how many pixels it fills. `LOD_RENDER_SCALE` at the top of
`src/world-session.ts` skips splats smaller than that many pixels, and the
renderer is capped at one device pixel per CSS pixel. Both were measured on an
integrated laptop GPU; a discrete card could raise the pixel cap back to 1.5
without noticing.

## Sample world

`cinema-palace` is an existing finished Mint world registered as a sample so
the walkthrough can be tried before any photo is generated. Remove its entries
from `mint-assets.json` and `worlds.config.json` (and the folder under
`public/assets/mint/`) when you no longer want it listed.

## Requirements

Node 20.16 works with the pinned Vite 6. Vite 7 or newer needs Node 20.19 or
22.12 and a working native bundler binding.

## Layout

- `src/main.ts` owns the renderer, camera, frame loop and world lifecycle.
- `src/world-session.ts` loads the RAD splat and invisible collider under one
  calibrated root and builds the collision BVH.
- `src/first-person.ts` owns the camera pose: pointer-lock look, damped WASD
  movement, wall sliding and grounding against the collider.
- `src/registry.ts` reads `mint-assets.json` and `worlds.config.json`.
- `src/remote-worlds.ts` subscribes to the published list in Convex and merges
  it over the bundled one.
- `convex/` holds the schema and functions; `scripts/publish-worlds.mjs` fills
  it from the local files.
- `vite.config.ts` adds the local-only `/api/uploads` endpoints.
