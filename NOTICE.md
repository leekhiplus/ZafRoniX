# Third-party notices

Zafronix AI Videos Upscaler is built on the work of other people. This file keeps the notices
that their licenses require. The same text is shown to visitors at `/notices.html`.

## free-ai-video-upscaler (MIT)

The video pipeline (demux, decode, upscale, encode, mux) and the in-memory output writer in
`src/engine/` are adapted from the free-ai-video-upscaler project by Sam Bhattacharyya.
The nine model weight files in `public/weights/` were copied unchanged from the same project.

```
MIT License

Copyright (c) 2026 Sam Bhattacharyya

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Libraries installed from npm

Each library keeps its own license inside its package (`node_modules/<name>/LICENSE`).
Check them yourself after your first `npm install`; this file does not guess their terms.

| Package | Version | Used for |
| --- | --- | --- |
| `@websr/websr` | 0.0.14 | WebGPU runtime that runs the upscaling network |
| `mediabunny` | 1.27.0 | Writing the MP4 file |
| `web-demuxer` | 4.0.0 | Reading video and audio packets (FFmpeg compiled to WebAssembly) |

Build tools (`webpack`, `typescript`, `ts-loader` and others) are development dependencies.
They are not shipped to visitors.

## Model weights: open question

The files in `public/weights/` are neural network weights based on the Anime4K CNN networks.
The reference project is MIT licensed, but that does not by itself tell us the terms under which
the original Anime4K weights may be redistributed. **Confirm those terms with the original authors
before you charge money for this site or put ads on it.** Until then, treat the site as
non-commercial.
