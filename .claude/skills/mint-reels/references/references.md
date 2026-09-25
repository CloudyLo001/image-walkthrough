# Reference images

Reference images are what Mint builds a room's world from. They are never shown in the reel itself. One room is one world: Mint takes an anchor image plus up to 5 more views of the same place (6 at most).

## What makes a good reference

- **Sharp and large: at least 1200 px wide, 2000+ px is better.** Low-resolution photos make soft, smeary worlds; this is the most common cause of a bad world.
- **An interior at eye level**, showing the whole room: walls, floor and ceiling in frame. Avoid close-ups of objects.
- **The look matches the room's `visual` line and the reel's era.** A 2006 kitchen should look like 2006, not a new renovation.
- **Clean frames.** No people in focus, no watermarks, no text overlays, no collages, no heavy filters, no fisheye.
- **Consistent views.** Extra images in one room should show the same place from other angles, not a different room in the same style.
- For generic rooms, renders and AI images are fine when they look real and sharp. For a real named place, use real photos of that place.

## Search for the subject first

The images must be of **the actual place the reel is about**. The idea's title, topic and chosen hook name it. "Drake's old Toronto mansion" means photos of Drake's Toronto mansion (The Embassy, on the Bridle Path), not generic mansions or castle halls. Generic look-alikes from free photo sites were the first attempt, and the user rejected them.

1. **Work out the subject.** Read the project's `data.idea` (its title, why and rooms) and `data.approved.hook`. Write down the real place and its well-known names, e.g. "Drake Embassy Toronto", "Drake Bridle Path mansion".
2. **Named or real place: image-search it in the browser.** Open Bing Images with the large-size filter:
   `https://www.bing.com/images/search?q=<subject>+<room>&qft=+filterui:imagesize-large`
   Each result's `a.iusc` element has an `m` attribute holding JSON with `murl` (the original image), `purl` (the page it's on) and `t` (the title). Read those with the page's JavaScript.
   - **Look at the candidates before using them.** Put them in a grid in a scratch tab with their real sizes (`naturalWidth`). Drop these:
     - images of the wrong place;
     - collages, magazine covers, maps and aerial shots;
     - photos with people or text over them;
     - anything AI-generated (e.g. filenames starting "gemini_").
   - Prefer the original photo shoot, e.g. a magazine tour, the architect's portfolio or a listing, republished on a site that serves it large. Publisher CDNs often take a width parameter; try raising it. Signed CDN links (people.com `thmb`) must stay exactly as found.
   - Skip sites that block automated access (e.g. architecturaldigest.com).
3. **Generic places only** ("a fever-dream hotel", "a 2006 kitchen"): use `npm run refs:search -- "<query>"`. It covers Openverse and Wikimedia Commons, returns direct high-resolution links with small previews, and drops rawpixel results, whose "large" links are really 1024 px previews. Use the room's `visual` line plus era words from the hook. Then a normal image search for anything they miss.
4. **Say what's missing.** Famous places often have only a few large photos online. When a room gets fewer than 3 good candidates, say so in the job's last `progress` label, so the user knows to paste their own.

Photos of real places, from magazines, news and listings, are used only as input for Mint and are never posted.

## Checking an image before adding it

- The URL must load the image itself (the response's `content-type` is `image/*`), not an HTML page. `curl -sI <url>` shows the type.
- Record `width` and `height` when you can see them. The page flags anything under 1200 px wide.
- Give each room 4–6 candidates, and put the strongest anchor candidate first.
