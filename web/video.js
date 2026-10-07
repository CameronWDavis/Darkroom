// Session-only video editing. Media never leaves this browser.
const $ = id => document.getElementById(id);
const video = $('video');
let sourceURL, sourceName, exporting = false, cancelExport;
let audioContext, audioSource, audioGain, audioDestination;
const status = message => { $('video-status').textContent = message; };
const time = seconds => `${Math.floor(seconds / 60).toString().padStart(2,'0')}:${(seconds % 60).toFixed(2).padStart(5,'0')}`;
const grade = () => `brightness(${$('video-brightness').value}%) contrast(${$('video-contrast').value}%) saturate(${$('video-saturation').value}%)`;
const bounds = () => [Number($('video-in').value), Number($('video-out').value)];
function switchWorkspace(mode) {
  if (exporting) return status('Finish or cancel the export before changing workspace.');
  const isVideo = mode === 'video';
  $('image-workspace').hidden = isVideo;
  $('sleeve').hidden = isVideo;
  document.querySelector('.bar-actions').hidden = isVideo;
  $('video-workspace').hidden = !isVideo;
  for (const name of ['image','video']) {
    $('mode-'+name).classList.toggle('selected', name === mode);
    $('mode-'+name).setAttribute('aria-pressed', String(name === mode));
  }
  $('workspace-hint').textContent = isVideo ? 'Cut, color, and create motion' : 'Develop, retouch, and refine';
  if (!isVideo) video.pause();
  document.dispatchEvent(new Event('workspacechange'));
  window.dispatchEvent(new Event('resize'));
}
$('mode-image').onclick = () => switchWorkspace('image');
$('mode-video').onclick = () => switchWorkspace('video');
$('video-import').onclick = () => $('file-video').click();
$('file-video').onchange = async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file || exporting) return;
  video.pause();
  $('video-controls').disabled = true;
  $('video-play').disabled = $('video-seek').disabled = true;
  if (sourceURL) URL.revokeObjectURL(sourceURL);
  sourceURL = URL.createObjectURL(file); sourceName = file.name;
  video.src = sourceURL;
  status('Loading video…');
};
video.onloadedmetadata = async () => {
  // Browser-recorded WebM files often omit their duration metadata. Seeking
  // beyond the end asks the decoder to discover the final timestamp.
  if (video.duration === Infinity) {
    const loadingURL = video.currentSrc;
    await new Promise(resolve => {
      const finish = () => {
        if (!Number.isFinite(video.duration)) return;
        cleanup(); resolve();
      };
      const timeout = setTimeout(() => { cleanup(); resolve(); }, 8000);
      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener('durationchange',finish);
        video.removeEventListener('timeupdate',finish);
      };
      video.addEventListener('durationchange',finish);
      video.addEventListener('timeupdate',finish);
      video.currentTime = 1e10;
    });
    if (loadingURL !== video.currentSrc) return;
  }
  if (!Number.isFinite(video.duration) || video.duration <= 0) return status('This video has no readable duration. Try another file.');
  $('video-controls').disabled = false;
  $('video-play').disabled = $('video-seek').disabled = false;
  video.hidden = false; $('video-empty').hidden = true;
  $('video-name').textContent = `${sourceName} · ${video.videoWidth} × ${video.videoHeight}`;
  $('video-seek').max = video.duration;
  $('video-in').max = $('video-out').max = video.duration;
  reset();
  status('Ready. Set in and out points to select your edit.');
};
video.onerror = () => {
  status('This video could not be decoded. Try a browser-supported MP4 or WebM file.');
  $('video-controls').disabled = true;
  $('video-play').disabled = $('video-seek').disabled = true;
};
function reset() {
  video.pause();
  $('video-in').value = 0; $('video-out').value = video.duration;
  $('video-speed').value = 1; $('video-volume').value = 100; $('video-mute').checked = false;
  for (const name of ['brightness','contrast','saturation']) $('video-'+name).value = 100;
  sync(); video.currentTime = 0;
}
$('video-reset').onclick = reset;
function sync() {
  video.playbackRate = Number($('video-speed').value);
  video.style.filter = grade();
  const volume = $('video-mute').checked ? 0 : Number($('video-volume').value)/100;
  // Once connected, Web Audio handles the gain for both preview and export.
  if (audioGain) { video.volume = 1; audioGain.gain.value = volume; }
  else video.volume = volume;
  $('video-volume-value').textContent = `${$('video-volume').value}%`;
  const [start,end] = bounds();
  $('video-duration').textContent = `${time((end-start)/video.playbackRate)} output`;
  $('video-range').style.marginLeft = `${start/video.duration*100}%`;
  $('video-range').style.width = `${(end-start)/video.duration*100}%`;
}
function trim(changed) {
  let [start,end] = bounds();
  if (!Number.isFinite(start)) start = 0;
  if (!Number.isFinite(end)) end = video.duration;
  const gap = Math.min(0.05,video.duration);
  start = Math.max(0,Math.min(start,video.duration-gap));
  end = Math.max(gap,Math.min(end,video.duration));
  if (start >= end) { if (changed === 'in') start = end-gap; else end = start+gap; }
  $('video-in').value = start; $('video-out').value = end;
  video.pause(); video.currentTime = Math.max(start,Math.min(video.currentTime,end)); sync();
}
for (const name of ['in','out']) $('video-'+name).onchange = () => trim(name);
$('video-mark-in').onclick = () => { $('video-in').value = video.currentTime; trim('in'); };
$('video-mark-out').onclick = () => { $('video-out').value = video.currentTime; trim('out'); };
for (const name of ['speed','volume','mute','brightness','contrast','saturation']) $('video-'+name).oninput = sync;
$('video-seek').oninput = () => { video.currentTime = Number($('video-seek').value); };
$('video-play').onclick = async () => {
  if (!video.paused) return video.pause();
  const [start,end] = bounds();
  if (video.currentTime < start || video.currentTime >= end) video.currentTime = start;
  try { await audioContext?.resume(); await video.play(); } catch(e) { status(e.message); }
};
video.onplay = () => { $('video-play').textContent = 'Pause'; };
video.onpause = () => { $('video-play').textContent = 'Play'; };
video.ontimeupdate = () => {
  $('video-seek').value = video.currentTime;
  $('video-time').textContent = `${time(video.currentTime)} / ${time(video.duration || 0)}`;
  if (!exporting && !video.paused && video.currentTime >= bounds()[1]) video.pause();
};
function seek(seconds) {
  if (Math.abs(video.currentTime-seconds) < .001 && video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve,reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Seeking timed out.')); },10000);
    const cleanup = () => { clearTimeout(timeout); video.removeEventListener('seeked',done); video.removeEventListener('error',error); };
    const done = () => { cleanup(); resolve(); };
    const error = () => { cleanup(); reject(new Error('Unable to seek this video.')); };
    video.addEventListener('seeked',done); video.addEventListener('error',error);
    video.currentTime = seconds;
  });
}
$('video-export').onclick = async () => {
  if (exporting) return;
  const canvas = document.createElement('canvas');
  const mimeType = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/mp4','video/webm'].find(type => window.MediaRecorder?.isTypeSupported(type));
  if (!mimeType || !canvas.captureStream) return status('Video export is unavailable in this browser. Use a current Chrome, Edge, or Safari browser.');
  const ctx = canvas.getContext('2d');
  if (!('filter' in ctx) && grade() !== 'brightness(100%) contrast(100%) saturate(100%)') return status('This browser cannot export color adjustments. Reset color controls or use Chrome/Edge.');
  const [start,end] = bounds();
  const scale = Math.min(1,1920/video.videoWidth,1080/video.videoHeight);
  canvas.width = Math.max(2, Math.round(video.videoWidth*scale/2)*2);
  canvas.height = Math.max(2, Math.round(video.videoHeight*scale/2)*2);
  exporting = true;
  $('video-controls').disabled = true; $('video-import').disabled = true;
  $('video-play').disabled = $('video-seek').disabled = true;
  $('video-cancel').hidden = false;
  let stream, recorder, animation, timer, canceled = false, rejectRecording;
  cancelExport = () => { canceled = true; rejectRecording?.(new Error('Export canceled.')); };
  try {
    video.pause();
    if (!audioContext) {
      audioContext = new AudioContext();
      audioSource = audioContext.createMediaElementSource(video);
      audioGain = audioContext.createGain();
      audioDestination = audioContext.createMediaStreamDestination();
      audioSource.connect(audioGain); audioGain.connect(audioDestination); audioGain.connect(audioContext.destination);
    }
    sync(); await audioContext.resume(); await seek(start);
    if (canceled) throw new Error('Export canceled.');
    ctx.filter = grade(); ctx.drawImage(video,0,0,canvas.width,canvas.height);
    stream = canvas.captureStream(30);
    // Clone the audio track so export cleanup does not break subsequent exports.
    for (const track of audioDestination.stream.getAudioTracks()) stream.addTrack(track.clone());
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8000000 });
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    await new Promise((resolve,reject) => {
      rejectRecording = reject;
      recorder.onerror = () => reject(new Error('The browser could not encode this video.'));
      recorder.onstop = resolve;
      const render = () => {
        if (canceled) return;
        ctx.drawImage(video,0,0,canvas.width,canvas.height);
        status(`Exporting ${Math.min(100,Math.round((video.currentTime-start)/(end-start)*100))}% · Keep this tab visible`);
        if (video.currentTime >= end || video.ended) { video.pause(); recorder.stop(); return; }
        animation = requestAnimationFrame(render);
      };
      timer = setTimeout(() => reject(new Error('Export timed out. Keep the tab visible and try again.')), ((end-start)/video.playbackRate+30)*1000);
      recorder.start(1000);
      video.play().then(render,reject);
    });
    if (canceled) throw new Error('Export canceled.');
    const blob = new Blob(chunks,{type:recorder.mimeType});
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `${sourceName.replace(/\.[^.]+$/,'')}-edited.${mimeType.includes('mp4') ? 'mp4' : 'webm'}`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url),60000);
    status(`Export complete · ${canvas.width} × ${canvas.height} · ${time((end-start)/video.playbackRate)}`);
  } catch(e) { status(e.message || 'Export failed.'); }
  finally {
    clearTimeout(timer); cancelAnimationFrame(animation); video.pause();
    if (recorder?.state === 'recording') recorder.stop();
    stream?.getTracks().forEach(track => track.stop());
    exporting = false; cancelExport = null;
    $('video-controls').disabled = false; $('video-import').disabled = false;
    $('video-play').disabled = $('video-seek').disabled = false; $('video-cancel').hidden = true;
  }
};
$('video-cancel').onclick = () => cancelExport?.();
// Background tabs cannot reliably paint recorded frames; fail explicitly.
document.addEventListener('visibilitychange', () => { if (document.hidden && exporting) cancelExport?.(); });
window.addEventListener('pagehide', () => { cancelExport?.(); if(sourceURL) URL.revokeObjectURL(sourceURL); audioContext?.close(); });
