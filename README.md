# Darkroom — In-Browser Video & Image Editor

Darkroom is an in-browser video and image editor for editing photos, retouching images, and trimming and grading video clips. It brings a Photoshop-inspired image workspace and a single-clip video editor together in one local creative studio.

Import files from your computer, make your edits, and export the result—all processing happens in your browser. Your images and videos are never uploaded to a server.

## What you can do

- **Edit images:** crop, rotate, flip, cut out subjects with a lasso, draw with brushes, and refine color and detail.
- **Edit video:** select a clip's in and out points, adjust playback speed and audio, apply color adjustments, and export your edit.
- **Work locally:** keep original media on your machine and save image projects as portable `.darkroom` files.

## Getting started

1. Open Darkroom and choose **Image studio** or **Video studio**.
2. Import an image or video from your computer. Images can also be dropped onto the image workspace.
3. Use the tools and properties panel to make adjustments.
4. Export the finished image or video. Use **Save project** in Image studio to preserve your originals and editable instructions.

Edits are kept in memory during your session. Save or export your work before closing or reloading the page. Video project saving is not currently supported.

## Image studio

- Neutral dark workspace with a left tool rail, right properties panel, and document filmstrip.
- Crop and aspect ratios, lasso cutouts, brush and paint eraser, and image color sampling.
- Brightness, contrast, saturation, exposure (±2 stops), temperature, sharpening, blur, grayscale, and inversion.
- Luminance histogram, zoom relative to the fitted view, and original comparison.
- Undo/redo, nondestructive project saving, and full-resolution PNG/JPEG export.
- Shortcuts: **B** brush, **E** paint eraser, **C** crop, **L** lasso, **I** eyedropper, **Escape** exit tool, **Ctrl/Cmd+Z** undo, **Ctrl/Cmd+Shift+Z** redo.

The filmstrip contains independent image documents; it is not a compositing layer stack. The eraser removes brush marks without removing the source photograph.

## Video studio

Import a browser-supported clip, set in/out points numerically or at the playhead, scrub the timeline, adjust playback speed, volume/mute, brightness, contrast, and saturation, then export the selected range. Reset restores the complete source range and neutral settings.

Export uses Canvas, Web Audio, and MediaRecorder. It records in real time at up to 1920×1080 and 30 fps, with WebM or MP4 chosen according to browser encoder support. Keep the tab visible; switching away cancels recording to avoid frozen frames. Export can also be canceled manually. Source audio follows the playback rate and volume controls. This is a single-clip editor; multi-clip timelines, transitions, and saved video projects are not yet supported.

## Privacy and storage

All media processing runs locally in the browser. Darkroom does not upload your files or automatically save media or edits to browser storage. The storage readout in the header shows storage counts for the page's origin.

Web fonts are loaded from Google Fonts, so the page can make network requests for typography. Your media remains on your machine.

## Build and run locally

The image engine is written in Rust and compiled to WebAssembly. The interface uses HTML, CSS, and JavaScript; video editing uses browser media APIs.

Prerequisites: Rust, `wasm-pack`, and Python 3 for the local web server.

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

Keep `index.html`, `styles.css`, `app.js`, `video.js`, `.nojekyll`, and the entire `pkg/` folder together. Relative asset paths allow the editor to run in a subfolder. Serve it over HTTPS with `.wasm` files served as `application/wasm`; GitHub Pages handles this for you.

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
node --input-type=module --check < web/app.js
node --input-type=module --check < web/video.js
```
