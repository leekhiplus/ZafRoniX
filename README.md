# Zafronix AI Videos Upscaler

Upscale low-resolution video to **1080p** and images up to **8K**, with a neural network that runs
on the visitor's own GPU, in their browser. Nothing is uploaded.

This is **Phase 1 (basic level)**: the smallest complete version that can go live through
GitHub and Netlify. Later phases are listed at the bottom.

---

## Read this first: what is and is not verified

Be clear about this before you deploy.

| Part | Status |
| --- | --- |
| Interface (layout, tabs, validation, planning, progress, compare slider, errors, mobile) | Tested in headless Chromium at desktop and phone sizes, **against a fake worker**. No console errors. |
| Planning rules (1080p cap, 2x/4x image passes, 8K limits, bitrate, file names) | 28 unit tests pass (`npm test`). |
| Type safety | `tsc` passes against hand-written type stubs for the three libraries. |
| **Real upscaling** (WebSR on WebGPU, WebCodecs decode/encode, MP4 muxing) | **Not run.** The build environment could not reach the npm registry, so the real libraries were never installed or executed. This code is written from the reference project and the libraries' documented APIs. |

The honest consequence: **the first Netlify build and the first real run on a GPU machine are the
real test.** Expect to fix something. If the build fails or a video fails to process, send the
Netlify build log or the browser console text and it gets fixed in the next step.

No `package-lock.json` is included for the same reason. Versions are pinned exactly in
`package.json`. Run `npm install` once on any machine with internet and commit the generated
lock file.

---

## What it does

- **Video**: MP4, M4V, MOV, WebM, MKV in. H.264 MP4 out. Videos smaller than 1080p are upscaled
  with a 2x AI pass, then fitted to at most 1920x1080. Videos already near 1080p are refused
  instead of pretending to improve them. Audio is copied without re-encoding when its codec
  (AAC, MP3 or Opus) fits an MP4. Otherwise the result has no sound, and the page says so.
- **Image**: PNG, JPG, WebP in. 2x (one pass) or 4x (two passes). The longest side is capped at
  8192 px and the area at 7680x4320. PNG, JPEG or WebP out.
- **Honest checks**: WebGPU and H.264 encoding are tested for real in the visitor's browser. If a
  check fails, the page says so instead of failing halfway through.
- **No fake progress**: the percentage is the real frame count. Time remaining shows "Measuring"
  until there is enough data to estimate.
- **Verified output**: after processing, the browser reopens the result and the page reports the
  size it actually has.
- **Private**: the file never leaves the device.

## Limits you should know about (blunt version)

- The model is a small Anime4K CNN. It sharpens edges and removes blockiness. It does **not**
  invent new real-world detail the way large diffusion or ESRGAN-class models do. Photos upscaled
  to 8K will be bigger, not magically sharper. Do not advertise it as more than it is.
- 4x on an image is two 2x passes. It is slower and uses much more GPU memory.
- An 8K image needs a strong desktop GPU. Phones often fail on large outputs. The page warns.
- Videos are processed frame by frame in the browser. A 1080p result takes real time (minutes
  for a short clip on a good GPU, much longer on a weak one). A tab that sleeps may stop. The page
  asks for a screen wake lock where the browser allows it.
- The result is held in memory before download (capped at 1.5 GiB, 400 MiB on low-memory
  devices). Long videos can hit this.
- Videos recorded rotated (many phone videos) are **refused** for now rather than output
  sideways. Rotation support is a later phase.
- Browser support: Chrome or Edge 113+ on desktop, and recent Chrome on Android with WebGPU.
  Safari and Firefox support depends on their current WebGPU/WebCodecs status; the capability
  check tells the visitor.
- No account, no payments, no server code, no analytics.

---

## Put it live (works from a phone browser)

### 1. Put the code on GitHub

1. Sign in at github.com and create a **new repository** (for example `zafronix-ai`). Private or
   public both work.
2. Unzip this project on a computer, or use a file manager app on your phone that can unzip.
3. In the repository page choose **Add file → Upload files**, and upload the *contents* of the
   project folder (not the zip itself). `package.json` must be at the top level of the repo.
   GitHub's phone upload can be unreliable with many files. If it struggles, use a computer
   or the GitHub web editor (press `.` on the repo page).
4. Make sure the `public/weights` folder (nine `.json` files) uploaded. The site will not
   upscale without them.
5. Commit.

### 2. Connect it to Netlify

A Netlify project named **zafronix-ai** already exists on the owner's Netlify team
(`https://zafronix-ai.netlify.app`). It has no deploy yet.

1. Open the project in Netlify: **Project configuration → Build & deploy → Continuous
   deployment → Link repository**, choose GitHub and pick the repository.
2. The settings come from `netlify.toml`: build command `npm run build`, publish folder `dist`,
   Node 20. Leave them as they are.
3. Click **Deploy**. The first build takes a few minutes.
4. If the build fails, open the deploy log, copy the red error text, and send it.

(Starting from nothing instead? **Add new site → Import an existing project → GitHub** works
the same way.)

### 3. Public access and your domain

- New Netlify projects on this team currently require a team login to view. Visitors will see a
  login wall until that is switched off: **Project configuration → Access & security → Visitor
  access**. Do this only when you are ready to go public.
- The canonical and social-preview tags in `src/index.html` already point at
  `https://zafronix-ai.netlify.app/`. If you attach your own domain, replace those four
  occurrences and commit.

### 4. Test it for real

On a laptop with a recent Chrome:

1. Open the site. Both status lights (WebGPU, Video codecs) should be green.
2. Upload a **short** 480p or 720p clip (10 to 20 seconds) and run it. Download the MP4 and
   play it.
3. Upload a 1080p image, choose 2x, run it, download it.
4. Open the browser console (F12). Note any red text.

Send the results, including failures. That is the verification that matters.

---

## Develop locally

```bash
npm install
npm test            # unit tests (Node 22+)
npm run type-check  # tsc --noEmit
npm run serve       # dev server on http://localhost:8080
npm run build       # production build into dist/
```

WebGPU needs a secure context. `localhost` counts. Netlify is HTTPS.

## How it is built

```
src/
  index.html, index.ts, config.ts   page, boot, limits
  app/        app.ts (UI controller), capabilities.ts (real capability checks)
  ui/         dom.ts helpers, compare.ts (before/after slider)
  lib/        pure logic with unit tests: planning, validation, format, errors, metadata
  engine/     worker.ts + client.ts (job protocol), video-job.ts, image-job.ts,
              models.ts (weights loader), gpu.ts, in-memory-storage.ts
public/       styles.css, favicon, og image, 404, notices page, weights/*.json
tests/        planning, validation, format
```

Heavy work runs in a Web Worker, one job at a time. Cancelling terminates the worker, which is
the only way to stop a running GPU pipeline cleanly, and a fresh worker is created for the next
job. Each image pass creates and destroys its own GPU device so memory is released between
passes.

The video pipeline is: demux (web-demuxer) → decode (WebCodecs) → upscale (WebSR) → optional
resize to fit 1080p → encode H.264 (WebCodecs) → mux MP4 (mediabunny). Audio packets are
copied alongside.

## Licensing

- This project's own code: all rights reserved (`UNLICENSED` in `package.json`). Change it if
  you decide to open-source it.
- Parts are adapted from an MIT project, and the model weights come from it. The MIT notice
  **must stay** in the repository and on the site. See [NOTICE.md](NOTICE.md).
- The weights' original licensing needs confirming before commercial use. See NOTICE.md.

## Roadmap

- **Phase 2**: fix whatever the first real run shows. Strict Content-Security-Policy.
  Self-hosted font files. Rotated-video support. WebM/VP9 fallback where H.264 encoding is
  missing.
- **Phase 3**: write output to disk as it is produced, so long videos do not fill memory.
  Tiled processing for images above 4K.
- **Phase 4**: installable app (PWA), batch queue, saved presets.
- **Phase 5**: stronger models (an ESRGAN-class network) as an optional, larger download.
  This is the step that gives real extra detail on photos.
