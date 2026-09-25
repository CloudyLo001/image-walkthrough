# Edit rules

Measured from the top 40 YouTube Shorts and the top TikToks (see `top-posts.md`).

## Length

- **Target 8–10 s**, allowed range 6–10 s. The top 40 run 6–12 s with a median of 10 s. The two biggest posts (10.7M and 4.3M on YouTube) are 8 s.
- Shorter is better than padded. Cut the dead start and the drift at the end.

## Frame

- Output is 1080×1920, 30 fps.
- **Most top posts use 16:9 or 4:3 footage centred on black.** Scale 16:9 clips so they fill 50–70% of the frame height (default 60%), crop the sides to 1080 wide, and leave the rest black.
- Full 9:16 footage is also fine. Mixing the two in one reel is not; pick one per reel.
- Hide any UI. Several top posts show Mint's editor gizmos, but Nostalgic Engine renders clean frames, which is an upgrade.

## Clips and pacing

- Each clip is one room or one view of it. The best reels walk through **several rooms of one place** (pantry, bedroom, kitchen), cutting on movement.
- Clips are 1–3 s after speed-up. Speed up slow camera moves by 2–4× (up to 4×). A slow push-in at 3.5× reads as a smooth glide.
- Keep the camera always moving. Never hold still for more than about half a second.
- The first frame must already show the most striking view. There is no intro.

## Hook

- The text follows `hooks.md`: white fill, black outline, centred on the footage, shown for the whole reel.
- The font is always TikTok Sans (TikTok's default), white with a black outline. The sizes are in `REEL_HOOK_STYLE` in `src/automation/types.ts`.

## Audio (last step)

- Choose audio only after the picture is locked (see `audio.md`).
- Export two versions: one with the sound, and one silent so the sound can be added natively on TikTok and Instagram.
