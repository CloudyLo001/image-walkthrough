#!/usr/bin/env node
// Searches openly licensed image sources for reference candidates and prints
// them as JSON, largest first. Claude still chooses which ones fit a room;
// this only does the searching and the size filtering.
//
// Usage: npm run refs:search -- "indoor pool mansion" ["second query" …]
//   --min <px>   smallest width to keep (default 1200)
//   --limit <n>  how many to print (default 12)

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  if (at === -1) return fallback;
  const value = Number(args[at + 1]);
  args.splice(at, 2);
  return Number.isFinite(value) ? value : fallback;
};
const minWidth = option("--min", 1200);
const limit = option("--limit", 12);
const queries = args;
if (queries.length === 0) {
  console.error('Give at least one search, e.g. npm run refs:search -- "indoor pool mansion"');
  process.exit(2);
}

/** A 960px Wikimedia copy for the page to show; full-size originals are megabytes each. */
function wikimediaThumb(url) {
  const prefix = "https://upload.wikimedia.org/wikipedia/commons/";
  if (!url?.startsWith(prefix)) return undefined;
  // "a/ab/Name.jpg", or "thumb/a/ab/Name.jpg/2560px-Name.jpg" for a scaled copy.
  const parts = url.slice(prefix.length).split("?")[0].split("/");
  if (parts[0] === "thumb") parts.shift();
  const [hash1, hash2, name] = parts;
  if (!hash1 || !hash2 || !name) return undefined;
  return `${prefix}thumb/${hash1}/${hash2}/${name}/960px-${name}`;
}

const HEADERS = { "User-Agent": "NostalgicEngine/0.1 (local reel research)" };

async function openverse(query) {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=20&size=large`;
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) return [];
  const body = await response.json();
  return (body.results ?? []).map((r) => ({
    url: r.url,
    thumb: wikimediaThumb(r.url) ?? r.thumbnail,
    source: r.foreign_landing_url,
    title: r.title,
    width: r.width,
    height: r.height,
    license: r.license,
  }));
}

async function commons(query) {
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrlimit=20" +
    `&gsrsearch=${encodeURIComponent(`${query} filetype:bitmap`)}` +
    "&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=2560&format=json";
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) return [];
  const body = await response.json();
  return Object.values(body.query?.pages ?? {}).map((page) => {
    const info = page.imageinfo?.[0] ?? {};
    // A 2560px rendition when the original is bigger; the original otherwise.
    const scaled = info.thumburl && info.thumbwidth < info.width;
    return {
      url: (scaled ? info.thumburl : info.url)?.split("?")[0],
      thumb: wikimediaThumb(info.url),
      source: info.descriptionurl,
      title: page.title?.replace(/^File:/, "").replace(/\.[a-z]+$/i, ""),
      width: scaled ? info.thumbwidth : info.width,
      height: scaled ? info.thumbheight : info.height,
      mime: info.mime,
    };
  });
}

const seen = new Set();
const found = [];
for (const query of queries) {
  const batches = await Promise.all([openverse(query).catch(() => []), commons(query).catch(() => [])]);
  for (const image of batches.flat()) {
    if (!image.url || seen.has(image.url)) continue;
    if (image.mime && !image.mime.startsWith("image/")) continue;
    // rawpixel reports the original's size but links a 1024px preview.
    if (/\/editor_\d+\//.test(image.url)) continue;
    if (!image.width || image.width < minWidth) continue;
    // Rooms read best from landscape shots; tall ones are usually a single object.
    if (image.height > image.width * 1.1) continue;
    seen.add(image.url);
    found.push({ ...image, query });
  }
}
found.sort((a, b) => b.width - a.width);
console.log(JSON.stringify(found.slice(0, limit), null, 2));
