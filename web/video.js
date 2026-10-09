// Workspace switching, and the entry point for the video studio. The editor
// itself lives in ./video/: model.js (the sequence and its rules), renderer.js
// (WebGL compositing and grading), engine.js (playback, audio, export) and
// ui.js (bin, timeline and inspector). Media never leaves this browser.
import { startVideo, pauseVideo, isExporting } from "./video/ui.js";

const $ = (id) => document.getElementById(id);

function switchWorkspace(mode) {
  if (isExporting()) { $("v-status").textContent = "Finish or cancel the export before changing workspace."; return; }
  const isVideo = mode === "video";
  $("image-workspace").hidden = isVideo;
  $("sleeve").hidden = isVideo;
  document.querySelector(".bar-actions").hidden = isVideo;
  $("video-workspace").hidden = !isVideo;
  for (const name of ["image", "video"]) {
    $("mode-" + name).classList.toggle("selected", name === mode);
    $("mode-" + name).setAttribute("aria-pressed", String(name === mode));
  }
  $("workspace-hint").textContent = isVideo ? "Cut, grade, title, and mix" : "Develop, retouch, and refine";
  if (isVideo) startVideo(); else pauseVideo();
  document.dispatchEvent(new Event("workspacechange"));
  window.dispatchEvent(new Event("resize"));
}

$("mode-image").onclick = () => switchWorkspace("image");
$("mode-video").onclick = () => switchWorkspace("video");
