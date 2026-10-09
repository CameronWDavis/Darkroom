# Darkroom — In-Browser Video & Image Editor

Darkroom is an in-browser video and image editor for editing photos, retouching images, and cutting, grading, and titling video. It brings a Photoshop-inspired image workspace and a Premiere-inspired multi-track video editor together in one local creative studio.

Import files from your computer, make your edits, and export the result—all processing happens in your browser. Your images and videos are never uploaded to a server.

## What you can do

- **Edit images:** crop, rotate, flip, cut out subjects with a lasso, draw with brushes, and refine color and detail.
- **Edit video:** cut clips together on a multi-track timeline with transitions, color grading, titles, captions, motion, and a music track, then export MP4 or WebM.
- **Work locally:** keep original media on your machine and save image projects as portable `.darkroom` files.

## Getting started

1. Open Darkroom and choose **Image studio** or **Video studio**.
2. Import an image or video from your computer. Images can also be dropped onto the image workspace.
3. Use the tools and properties panel to make adjustments.
4. Export the finished image or video. Use **Save project** in Image studio to preserve your originals and editable instructions, or **Save…** in Video studio to keep the sequence.

Edits are kept in memory during your session. Save or export your work before closing or reloading the page.

## Image studio

- Neutral dark workspace with a left tool rail, right properties panel with collapsible sections, and document filmstrip.
- **Tools:** hand (pan), crop with aspect ratios, lasso cutouts, brush and paint eraser, gradient, shapes, and image color sampling.
- **Basic:** brightness, contrast, exposure (±2 stops), saturation, and temperature.
- **Levels:** input black/white points, midtone gamma, output range, and **Auto** levels.
- **Curves:** a master RGB curve plus separate red, green, and blue curves, drawn over the channel's histogram.
- **Color:** hue rotation, vibrance, shadows/highlights recovery, photo filters (warming, cooling, sepia, and custom colors), black & white, and inversion.
- **Effects and filters:** sharpen, blur, film grain (color or monochrome), vignette, pixelate, posterize, and threshold.
- **Gradient tool:** linear or radial, fading to a color or to transparent, with 11 blend modes (multiply, screen, overlay, soft light, and more) and opacity.
- **Shape tool:** rectangles, ellipses, and lines with fill and stroke. Hold **Shift** for squares, circles, and 45° lines.
- RGB and luminance histogram, a History panel you can click to jump to any step, zoom up to 800%, Ctrl+scroll zoom, Space-drag panning, and original comparison.
- Undo/redo, nondestructive project saving, and full-resolution PNG, JPEG, or lossless WebP export, resized from 25% to 200%.
- Shortcuts: **H** hand (or hold **Space**), **B** brush, **E** eraser, **G** gradient, **U** shapes, **C** crop, **L** lasso, **I** eyedropper, **[ ]** size, **\\** compare, **Escape** exit tool, **Ctrl/Cmd+Z** undo, **Ctrl/Cmd+Shift+Z** redo, **Ctrl/Cmd+= / − / 0** zoom, **Ctrl/Cmd+O / S** open/save project, **Ctrl/Cmd+Shift+E** export, **?** list all shortcuts.

Gradients, shapes, and brushwork are stored in source-image coordinates, so they stay attached to the subject through later crops, rotations, and flips. The filmstrip contains independent image documents; it is not a compositing layer stack. The eraser removes brush marks without removing the source photograph.

## Size limits

Everything is processed inside the browser tab, so Darkroom refuses files that would exhaust its memory or that look like decompression bombs. Limits are checked before a file is read whenever possible, and the engine checks them again:

| What | Limit |
| --- | --- |
| Image file | 100 MB |
| Image dimensions | 16,384 px on the longest edge, 64 megapixels in total |
| Open images | 32, holding up to 768 MB of original files |
| Project (`.darkroom`) file | 800 MB, with at most 72 entries |
| Project contents once decompressed | 768 MB total, 16 MB manifest |
| Compression ratio inside a project | 100:1 for any entry over 1 MB (zip-bomb protection) |
| Export | 16,384 px per edge and 64 megapixels after resizing |
| Video studio: video / audio / image file | 8 GB / 1 GB / 50 MB (images also 16,384 px and 64 MP) |
| Video studio: media bin and timeline | 64 files, 500 timeline items, 200 markers |
| Video project (`.json`) and captions (`.srt`) | 5 MB and 2 MB |
| Video export | 20 minutes of output |

Sizes declared inside a zip are never trusted on their own: each entry is read through a hard cap, and its real decompressed size and ratio are measured. Image headers are checked for dimensions before any pixels are decoded. Video project files are rebuilt field by field from known defaults, so unknown keys and out-of-range values never reach the editor. The limits live in [src/limits.rs](src/limits.rs) and [web/video/model.js](web/video/model.js).

## Video studio

A multi-track editor modelled on Premiere Pro's workflow, rendered on the GPU with WebGL 2.

- **Media bin:** import video, audio, and still images; thumbnails, durations, and usage counts. Drag media onto a track or double-click to add it.
- **Timeline:** V2 for titles, captions, and graphics, V1 for the main picture, and A2 for music and sound. V1 is magnetic: clips butt together, and deleting one closes the gap (ripple delete).
- **Editing:** selection and razor tools, split at playhead, drag to reorder, edge trimming that respects source media length, snapping to clip edges, the playhead, and markers, duplicate, 100-step undo, and timeline zoom.
- **Transitions:** cross dissolve, dip to black or white, wipes in four directions, push, slide, iris, cross zoom, clock wipe, and film dissolve, with adjustable duration and *Apply to all cuts*.
- **Color (Lumetri-style):** exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, saturation, and vibrance; creative looks (teal & orange, faded film, black & white, noir, warm vintage, cool, bleach bypass, vivid) with intensity; faded film, sharpen, vignette; and shadow/midtone/highlight color wheels. Copy and paste grades, or paste to every clip.
- **Motion:** fit or fill the frame, scale, position, rotation, and opacity, with optional animation to end values and easing — including a one-click Ken Burns move.
- **Titles and captions:** fonts, size, color, bold/italic, alignment, background box, outline, and shadow; entrance and exit animations (fade, slide, pop, typewriter); presets for centered titles, lower thirds, and captions. Import and export SubRip (`.srt`) captions.
- **Audio:** per-clip volume, mute, and fade in/out; constant-power crossfades through transitions; a music track with its own fades; master volume; waveforms for audio files up to 40 MB; and a level meter.
- **Sequence settings:** 16:9, 9:16, 1:1, 4:5, 4:3, or 21:9 at 480p, 720p, or 1080p and 24–60 fps.
- **Monitor and scopes:** frame-accurate timecode, frame stepping, loop playback, a luma waveform, and *Export frame* to PNG.
- **Projects:** save the sequence as a small JSON file. Media is referenced by name and size rather than embedded, because video is far too large to bundle; on open, use *Relink* to point at the files, as with Premiere's offline media.
- **Export:** MP4 (H.264 + AAC) or WebM (VP9/VP8 + Opus), whichever the browser can encode, at four quality levels, or audio only.

Shortcuts: **Space** play/pause, **J / K / L** back, stop, play, **← / →** one frame (**Shift** for one second), **↑ / ↓** previous/next edit point, **Home / End**, **V** selection, **C** razor, **S** snapping, **Ctrl/Cmd+K** split at playhead, **Delete** delete (ripple on V1), **M** marker, **T** title, **= / −** zoom, **\\** fit timeline, **Ctrl/Cmd+Z / Shift+Z** undo/redo, **Ctrl/Cmd+D** duplicate, **Ctrl/Cmd+O / S** open/save project, **Ctrl/Cmd+M** export.

Export plays the sequence in real time through the same GPU compositor as the preview, and records it with MediaRecorder, so a two-minute edit takes two minutes. Keep the tab visible; switching away cancels recording to avoid frozen frames. Clips play from the source files through `<video>` elements, so supported formats are whatever your browser can decode, usually MP4 (H.264) and WebM.

## Privacy and storage

All media processing runs locally in the browser. Darkroom does not upload your files or automatically save media or edits to browser storage. The storage readout in the header shows storage counts for the page's origin.

Web fonts are loaded from Google Fonts, so the page can make network requests for typography. Your media remains on your machine.

## Build and run locally

The image engine is written in Rust and compiled to WebAssembly. The interface uses HTML, CSS, and JavaScript; video editing uses browser media APIs.

Prerequisites: Rust 1.88 or newer (required by the locked `image` crate), `wasm-pack`, and Python 3 for the local web server.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
wasm-pack build --target web --out-dir web/pkg
python3 -m http.server 8080 --directory web
```

Open [Darkroom at localhost:8080](http://localhost:8080). The video workspace also works without the WebAssembly build. The image studio displays an error if its engine is missing.

Video import and export support depends on the codecs and media APIs available in your browser. The export controls report when the browser cannot encode a video or apply its color adjustments.

## Publish the website

The included [GitHub Actions workflow](.github/workflows/pages.yml) tests the app, compiles the image engine, and packages the complete `web` directory. Pushes and pull requests to `main` build the website; publishing is a separate, manual choice.

Commit and push the source files, `Cargo.lock`, and `.github/workflows/pages.yml` to GitHub first. The generated `web/pkg` directory is intentionally ignored by Git: the workflow rebuilds it with a binding generator that matches `Cargo.lock`.

### Download the website for your own page

1. Open the repository's **Actions** tab and select **Build website and publish Pages**.
2. Open a successful run, or choose **Run workflow** on `main` with **Publish this build to GitHub Pages** unchecked.
3. Download the **darkroom-web** artifact from the completed run's **Artifacts** section and unzip it.
4. Copy the extracted contents to your website's published directory, or a subfolder such as `darkroom/`.

Keep `index.html`, `styles.css`, `app.js`, `video.js`, `.nojekyll`, and the entire `video/` and `pkg/` folders together. Relative asset paths allow the editor to run in a subfolder. Serve it over HTTPS with `.wasm` files served as `application/wasm`; GitHub Pages handles this for you.

If your existing GitHub Pages site publishes from a branch, put these built files in its selected root or `docs` directory (or a subfolder within it). The GitHub Pages branch selector cannot publish directly from a folder named `web`; use the workflow below for this repository instead. Do not upload only the source `web` folder without the compiled `pkg` files—the image editor needs them.

### Publish this repository with GitHub Pages

1. In **Settings → Pages → Build and deployment**, set **Source** to **GitHub Actions**.
2. In **Actions → Build website and publish Pages → Run workflow**, select `main` and check **Publish this build to GitHub Pages**.
3. Wait for the `build` and `deploy` jobs to finish. The deployment provides the live website URL.

For `CameronWDavis/Darkroom`, the default project URL will be `https://cameronwdavis.github.io/Darkroom/` unless a custom domain is configured. Repeat the manual publish step when you want to release updated code. Publishing from branches other than `main` is disabled.

See GitHub's [custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) for publishing settings and permissions. Visitors need only a supported browser; Rust and the build tools are required only to build the site.

## Validation

```sh
cargo test
for f in web/app.js web/video.js web/video/*.js; do node --input-type=module --check < "$f"; done
node --test tests/
```
