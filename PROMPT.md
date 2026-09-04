Use mint-threejs-skills (threejs-app-director route) and Mint MCP to build a
"Photo to Walkable World" app in this folder (greenfield: TypeScript + Vite +
vanilla Three.js). The goal: I upload one photo of a room or place, it becomes a
3D environment, and I walk around inside it in first person exactly like this
reference video: https://www.tiktok.com/@madeonmint/video/7635067616247205150
(a photoreal luxury interior generated from one image, camera gliding forward
at walking pace, looking around, never clipping through walls or floor).

App type and user goal:
Single-page 3D walkthrough. Primary journey: drop/upload an image ->
generate a Mint world from it -> enter and walk inside it.

Primary 3D subject:
A Mint-generated world (remote Gaussian-splat RAD environment) built from the
uploaded photo. This is an explicit request for Mint world generation, so read
references/mint-world-splats.md and references/mint-project-workspaces.md
before the first MCP write. Resolve one Mint Project for this codebase and
persist it in mint-assets.json.

Generation pipeline (agent tooling, never browser runtime):
- Mint MCP calls stay out of browser code. Runtime only ever reads the
  registry (mint-assets.json) that you maintain.
- When I give you an image (a local file in ./uploads or a public URL), run:
  upload_reference_image (local bytes) or pass image_url directly ->
  start_world_generation with an image-only or image + short prompt input,
  mode "auto" -> wait_for_status until final success (RAD post-processing
  done) -> get_asset_artifact_manifest with asset_type "world" ->
  require integrationMode "remote_stream", a RAD runtimeUrl and
  runtime.collider.runtimeUrl -> register the world under a stable logical
  key in mint-assets.json via scripts/sync-mint-assets.mjs.
- If the collider is missing, stop and report the blocker. Never derive
  collision from the splat.
- Keep both URLs remote (Mint CDN). Load CDN directly; only add the Vite
  /mint-cdn range-preserving proxy if live CORS/Range validation fails.
- Give me a documented repeatable loop: "put image in ./uploads, tell you to
  generate, world appears in the app's world list." If Mint later exposes an
  HTTP API usable from a Node backend, propose it as a phase 2 for fully
  self-serve in-browser generation, but do not block on it now.

Runtime stack:
- @sparkjsdev/spark@^2 and three >= 0.180. One SparkRenderer per renderer,
  enableLod true. SplatMesh with fileType SplatFileType.RAD, paged true,
  raycastable false. Do not set lod: true on the SplatMesh.
- Load splat and collider GLB under one shared root: rotation [PI, PI, 0],
  uniform scale 2.5, Y 1.5. Never transform one without the other. Collider
  stays invisible; register its meshes explicitly for physics/raycasts.
- Use a Draco-capable shared GLTF loader per
  references/gltf-runtime-compatibility.md.

Essential interactions and camera/control model:
- Strict first-person walkthrough (this is the video's feel): pointer-lock
  mouse look, WASD move, Shift to run, walking speed ~3.2 units/s, run ~8.
  Movement projected onto XZ. Optional Q/E fly toggle for debugging only.
- Grounded on the collider: downward raycast or capsule vs collider trimesh
  keeps eye height ~1.6 above the floor, simple gravity, no falling through
  the floor, no walking through walls (slide along surfaces).
- Smooth, cinematic motion like the video: acceleration/deceleration damping
  on movement and look, no jitter, no snap-back on control update.
- Spawn at the transformed world origin (do not auto-recenter the world),
  camera FOV 55. Validate the transformed collider for plausible room scale,
  floor height, eye height and traversal speed; if off, adjust the shared root
  once and recompute physics + clipping planes.
- Ignore keyboard input when a form element has focus; clear keys on blur.
- Esc releases pointer lock and shows the control hint again.

State or data sources:
- mint-assets.json registry -> list of generated worlds (key, name, source
  image thumbnail, runtimeUrl, colliderUrl). App shows this list, I pick one
  and enter it. Switching worlds removes the old shared root and disposes
  correctly; dispose the Spark renderer only when the Three.js renderer dies.
- Upload drop zone accepts jpg/png/webp, previews the image, saves it to
  ./uploads (dev) so the generation loop can pick it up, and shows a clear
  status: "Uploaded - waiting for generation", "Generating", "Ready - Enter".

UI (user-owned, minimal):
- Canvas dominant, no header, no branding, no provider names, badges, asset
  IDs or generation links in the runtime UI.
- Before entering: centered upload drop zone + world list.
- Inside: compact bottom-centered control group with the hint
  "Click to look - WASD move - Shift run - Esc release"; loading/ready/error
  status directly above it in the same compact style; retry on error.
- Keep a visible loading state until both splat.initialized and the collider
  GLB resolve.

Target devices:
Desktop first (pointer lock + keyboard). Mobile is a separate secondary pass:
left virtual joystick to move, drag-to-look, only after desktop is approved.

Visual direction:
Match the video: photoreal, well-lit interiors, pixel ratio capped at 1.5,
antialias off (splats do not need it), subtle exposure/tone mapping if it
helps the splat read as photographic. No fog, no post-processing that
smears the splat.

Performance/deployment constraints:
Static Vite build deployable to any static host; the world streams from Mint
CDN (paged RAD), so no large assets in the repo. 60 fps target on a laptop.

Required outcome:
- Complete primary journey with loading and error behavior: upload -> generate
  (via you + Mint MCP) -> registered in mint-assets.json -> select -> walk.
- Test it end to end with a real interior photo I provide (or, if I have not
  provided one yet, ask me for one before spending credits; do not generate a
  world from a made-up image without asking, each world costs credits).
- Clear interaction feedback, responsive UI, correct disposal on world switch.
- Follow references/verification-policy.md: run the automatic minimum (build,
  type check, lint), then ask before the desktop browser QA pass (canvas
  screenshot inside the world, WASD movement evidence, collision evidence,
  loading and error paths), and ask separately before mobile QA.
- Report: controls, state ownership, changed files, the generation loop
  instructions, Mint chat/handoff link, verification evidence, and remaining
  risks (scale calibration, CDN CORS, collider quality).
