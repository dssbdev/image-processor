# image-processor

A local photo pipeline. Pick photos → give them a **look** (colour & tone) and a **crop** (ratio + position, never resizes) → see the real result → **export** with a preset (size, format, quality, metadata, destination). Plus an Import step that gets a memory card into a dated archive without hand-renaming.

Everything runs on your machine: a Node server (Fastify + sharp) and a React UI in a browser tab. No cloud, no accounts, no subscriptions.

It reads JPEG, PNG, WebP, TIFF, AVIF, HEIC and DNG, and carries videos along on import.

## Requirements

- Windows 10/11, macOS or Linux
- Node.js **22 or newer** (`node --version`), from <https://nodejs.org> (LTS)
- ~500 MB of disk for `node_modules` (sharp brings its own libvips; exiftool-vendored brings exiftool; libraw-wasm brings a RAW developer; nothing else to install)
- Optional: [darktable](https://www.darktable.org/install/) — when installed, DNGs are developed by `darktable-cli` (better rendering, uses the GPU) instead of the built-in LibRaw

## Quick start

```bash
git clone <this repository>
cd image-processor
npm install
npm run dev
```

`npm run dev` starts the API on <http://127.0.0.1:5177> and the UI (with hot reload) on <http://localhost:5173>. Open the UI URL in a browser. The server prints its startup phases (`[server] loading settings…` … `listening`). If the terminal shows proxy errors like `ECONNREFUSED 127.0.0.1:5177`, the server side did not come up; run

```bash
npm run doctor
```

which checks the Node version, every native/wasm dependency, exiftool, darktable-cli, the port and your `settings.json`, and says what to fix. `npm run serve` starts the API alone (no Vite) if you want to see its output on its own.

For everyday use without hot reload (one process, one port):

```bash
npm start
```

builds the UI once and serves everything on <http://127.0.0.1:5177>.

## Your files: `config/` and `data/`

Nothing personal lives in the code. The first start creates two folders next to it, and git ignores both:

| Folder | What is in it | Keep it? |
|---|---|---|
| `config/` | `settings.json` (your folders, RAW engine, performance), `looks/` (one JSON per look) and `exports/` (one JSON per export preset) | Yes: this is what makes the app yours. Back it up, copy it to another machine. |
| `data/` | The thumbnail / preview / developed-RAW cache, the job history, and the default `archive/` and `export/` folders | The cache is safe to delete. |

A fresh `config/` is seeded with 20 looks and three export presets; edit or delete them freely (**Restore defaults** brings a deleted one back). Point the archive and export roots anywhere you like in **Settings**.

`settings.json` has one key the Settings page does not show: `hideCameraMakes`, a list of EXIF makes to leave out when a camera is named (for cameras whose EXIF make is a company name nobody knows them by).

To keep these folders somewhere else:

| Variable | Effect |
|---|---|
| `IMAGE_PROCESSOR_CONFIG=<abs path>` | moves `config/` |
| `IMAGE_PROCESSOR_DATA=<abs path>` | moves `data/` (and, unless the variable above is set, keeps the config inside it as `config/`) |
| `IP_PORT` / `IP_HOST` | change the API address (Vite's proxy follows `IP_PORT`) |
| `IP_LOG_LEVEL=info` | request logs |

## Using it

Three things are independent, and it helps to keep them apart:

| Axis | What it changes | Where it lives |
|---|---|---|
| **Look** | Colour and tone only (16 sliders: exposure, contrast, highlights, shadows, fade · saturation, vibrance, warmth, tint, split toning · clarity, vignette, sharpen). Saved presets in the Looks library; every photo remembers which look it uses plus its own slider adjustments. | per photo (sidecar) |
| **Crop** | Which part of the picture: a ratio (4:5, 1:1, 9:16, 4:3, 3:2, 16:9, …) and where the window sits — automatic (subject/attention, detail/entropy, centre, …) or dragged by hand. Cropping only removes pixels; it never resizes and never costs quality. | per photo (sidecar) |
| **Export** | How the files are written: long edge (0 = original size), format, quality, metadata policy, destination folder, file-name template. Saved presets (Instagram · Full quality · Web) chosen when you export. | export dialog |

**Gallery** (home) — browse any folder (click the path to type one). Click photos to select them (Shift = range, Alt = only this, double-click = edit that one photo). The zoom slider sets thumbnail size. Filters: All / ★ / Edited / RAW. With a selection, the right panel offers:

- **Start…** — the pipeline: pick a look and a crop ratio for all selected photos, tick what you want to do by hand: *Frame each photo* (drag the crop onto the subject) and/or *Adjust the look on each photo* (sliders on top of the look). Manual steps open the step-through editor: one photo at a time, `Done` / `Skip` / `Back` (also `Enter` / `←` `→`), `F` frame view, `R` result view, `S` star, `Esc` back to the gallery. Every change is saved immediately; the last photo opens the export dialog. No manual steps = look and crop are applied to all (crops positioned automatically) and the export dialog opens right away.
- **Look** and **Crop** dropdowns — apply to the selection immediately (photos keep their own slider adjustments and framing).
- **Export…** — choose an export preset (edit or add presets right there, one-off destination override) and go. Each photo goes out with its own look + crop.
- **Star / Move / Delete** — star toggles a flag, Move puts files (with their edits) in another folder, Delete goes to the recycle bin / trash.

The preview on the right always shows the focused photo through its look + crop (before/after slider). When an export finishes, a toast offers **Open folder** / **Show in gallery**; the Jobs tab has the same buttons per job.

**Per-photo edits** live in a sidecar `.image-processor.json` in the photo's folder: look preset, slider adjustments, crop ratio, crop position, star. They move with the files and are read by every export.

**Looks** — the library: 10 *scenario* looks (beach, ocean, nature, urban, night, action, portrait) and 10 *style* looks (clean & neutral, bright & airy, teal & orange, matte film, moody, golden hour, vintage, vivid, two black & whites), plus yours. Preview any look on any photo of the current gallery folder (thumbnail strip), optionally through a crop ratio. They are approximations of popular grades built with this app's own sliders.

**Import** — type the card path (or pick it from places), **Analyze** to see exactly what would happen (dry run: destination names, dates, what is already archived, what is unsupported), then **Run import**. Files are copied, never moved; each copy is size-checked and (for photos) hash-checked. Layout: `<archive>/YYYY/YYYY-MM-DD/YYYYMMDD-HHMMSS.ext`, with JPG + DNG pairs sharing a name and videos coming along.

**Jobs** — every export and import, with per-file results and errors. History survives restarts.

**Settings** — archive/export/cache folders, default crop position, RAW engine, concurrency, preview and thumbnail sizes, import verification.

## What it does with colour and metadata

- JPEG/PNG/WebP/TIFF/AVIF: decoded by sharp; embedded ICC profiles are converted to sRGB; EXIF orientation is applied.
- HEIC: decoded by libheif in a worker thread. The container rotation is already applied by libheif, so EXIF orientation is deliberately not applied twice. If the file is Display P3, a P3→sRGB matrix is applied in linear light. HDR gain maps are ignored (SDR result). The first decode of a 12 MP HEIC takes a couple of seconds; thumbnails and preview proxies are cached after that.
- DNG: developed once to a cached full-resolution JPEG (q96), then edited like any photo. Engine, in order: **darktable-cli** when darktable is installed (auto-detected, or set the path in Settings; better rendering, GPU) → the built-in **LibRaw** (wasm, no install; camera white balance, AHD demosaic; roughly 5–10 s for a 50 MP DNG the first time, CPU only) → the DNG's embedded JPEG preview, clearly labelled. Settings → RAW lets you force one.
- Output metadata: `keep-no-gps` (default) copies EXIF from the source and deletes every GPS tag; orientation is reset to 1 because pixels are already upright; the source ICC and stale thumbnails are dropped. `keep` keeps GPS. `strip` writes nothing.
- Exports never overwrite: a name that already exists in the destination gets `-2`, `-3`, …

## Development

```bash
npm test          # vitest: look and crop math, naming, pairing, the render pipeline, import, jobs, sidecars, presets, DNG development
npm run typecheck # tsc on server and web
```

Layout:

```
shared/   types + pure math used by both sides: look / crop / export schemas, tone curves, crop geometry, naming, pairing
server/   Fastify API: decoders (sharp, HEIC worker, darktable-cli / LibRaw worker), render pipeline, thumbnail + proxy cache, jobs, import, exiftool
web/      React 19 + Vite 8 + Tailwind 4 UI; every colour, size and radius is a token in web/src/styles.css
scripts/  doctor.mjs, the environment check
config/   yours, git-ignored: settings, looks, export presets
data/     runtime, git-ignored: cache, job history, default archive and export folders
```

Where things are shared rather than repeated:

- Preview and export run the same `renderImage` with the same per-photo spec (`server/src/pipeline`), so what you see is what is written.
- Looks and export presets are one generic file-backed store and one set of REST routes (`server/src/store/presets.ts`, `server/src/routes/presets.ts`).
- The UI kit (`web/src/components/ui.tsx`) holds the controls and the page layout classes; `web/src/lib` holds the words, numbers and paths the pages print.

## Known limitations

- No AI upscaling yet (Settings has a slot for a `realesrgan-ncnn-vulkan` binary; it does nothing until it is wired).
- RAW: darktable's output is its default rendering; LibRaw's is a plain camera-WB/sRGB development with auto-brightness. Both are starting points for the look sliders, not hand-tuned developments.
- The crop can be moved, not resized (the window is always the largest one of the chosen ratio).
- HEIC decoding is 8-bit SDR via wasm, not an HDR workflow.
- Strong shadow lifts on 8-bit JPGs will band; that is what the DNG route is for.
