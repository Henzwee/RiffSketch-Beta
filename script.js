// --------------------- GLOBAL VARIABLES ---------------------
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let currentSources = {};
let waveSurfers     = {};
let trackCounter    = 0;
let mediaStream     = null;
let mediaRecorder   = null;
let chunks          = [];
let trackData       = {};       // { trackId: { url, blob } }
let playAudioDuringRecording = false;

let trackGainNodes = {};
let trackMuteStates = {};
let impulseBuffer   = null;

// --------------------- LOAD REVERB IMPULSE RESPONSE ---------------------
fetch('impulse.wav')
  .then(r => r.arrayBuffer())
  .then(data => audioCtx.decodeAudioData(data))
  .then(buffer => { impulseBuffer = buffer; })
  .catch(() => { console.warn('Reverb impulse not loaded.'); });

// --------------------- AUDIO EFFECTS ---------------------
function applyEffects(trackId, source, destination) {
  const vol       = parseInt(document.querySelector(`#${trackId} .fx-volume`).value) / 100;
  const dist      = parseInt(document.querySelector(`#${trackId} .fx-distortion`).value);
  const chorusVal = parseInt(document.querySelector(`#${trackId} .fx-chorus`).value);
  const reverbVal = parseInt(document.querySelector(`#${trackId} .fx-reverb`).value);
  const muted     = trackMuteStates[trackId] || false;

  const gainNode = audioCtx.createGain();
  gainNode.gain.value = muted ? 0 : vol;

  // Distortion
  const distortion = audioCtx.createWaveShaper();
  distortion.curve = makeDistortionCurve(dist);
  distortion.oversample = '4x';

  // Chorus filter
  const chorus = audioCtx.createBiquadFilter();
  chorus.type = 'bandpass';
  chorus.frequency.value = 500 + chorusVal * 50;
  chorus.Q = 15;

  // Reverb (wet/dry)
  const convolver = audioCtx.createConvolver();
  if (impulseBuffer) convolver.buffer = impulseBuffer;
  const reverbGain = audioCtx.createGain();
  reverbGain.gain.value = reverbVal / 50;
  const dryGain = audioCtx.createGain();
  dryGain.gain.value = 1 - (reverbVal / 100);

  // Chain
  source.connect(distortion);
  distortion.connect(chorus);
  chorus.connect(dryGain);
  dryGain.connect(gainNode);

  if (impulseBuffer) {
    chorus.connect(convolver);
    convolver.connect(reverbGain);
    reverbGain.connect(gainNode);
  }

  gainNode.connect(destination);
  trackGainNodes[trackId] = gainNode;
}

function makeDistortionCurve(amount) {
  const k = typeof amount === 'number' ? amount : 50;
  const n = 44100, curve = new Float32Array(n), deg = Math.PI / 180;
  for (let i = 0; i < n; i++) {
    let x = (i * 2) / n - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

// --------------------- RECORDING ---------------------
async function toggleRecord(btn, trackId) {
  await audioCtx.resume();
  if (!mediaStream) await setupMediaStream();
  if (!mediaStream) return;

  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    // START RECORD
    chunks = [];
    mediaRecorder = new MediaRecorder(mediaStream);

    // onstart: if play-on-record is enabled, playback existing tracks
    mediaRecorder.onstart = () => {
      if (playAudioDuringRecording) {
        Object.entries(trackData).forEach(([id, data]) => {
          if (!trackMuteStates[id]) {
            fetch(data.url)
              .then(r => r.arrayBuffer())
              .then(ab => audioCtx.decodeAudioData(ab))
              .then(decoded => {
                const src = audioCtx.createBufferSource();
                src.buffer = decoded;
                applyEffects(id, src, audioCtx.destination);
                src.start();
                currentSources[id] = src;
                waveSurfers[id]?.seekTo(0) && waveSurfers[id].play();
                src.onended = () => delete currentSources[id];
              });
          }
        });
      }
    };

    mediaRecorder.ondataavailable = e => chunks.push(e.data);
    mediaRecorder.onstop = () => {
      // stop any play-on-record sources
      Object.values(currentSources).forEach(s => s.stop());
      currentSources = {};

      const blob = new Blob(chunks, { type: 'audio/webm' });
      const url  = URL.createObjectURL(blob);
      trackData[trackId] = { url, blob };

      // insert Play‑with‑FX button
      const container = document.getElementById(`audio-${trackId}`);
      container.innerHTML = `
        <button class="button"
          onclick="togglePlayWithFX(this,'${url}','${trackId}')">
          <img src="play-icon.png" width="20" height="20"
               style="margin-right:6px;vertical-align:middle;" alt="Play">
          Play with FX
        </button>

      `;

      // draw waveform
      const wf = document.getElementById(`waveform-${trackId}`);
      wf.innerHTML = '';
      const ws = WaveSurfer.create({
        container: wf,
        waveColor: '#ff0',
        progressColor: '#f0f',
        barWidth: 2,
        height: 80,
        backend: 'WebAudio', // <-- this is key
      });
      
      ws.on('error', e => {
        console.error('WaveSurfer error:', e);
      });
      
      ws.load(url);
      
    };

    mediaRecorder.start();
    btn.innerHTML = `
      <img src="stop_square_icon_206305.png" width="20" height="20"
           style="margin-right:6px;vertical-align:middle;" alt="Stop">
      Stop
    `;
  } else {
    // STOP RECORD
    mediaRecorder.stop();
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="red"
           viewBox="0 0 16 16" style="margin-right:6px;">
        <circle cx="8" cy="8" r="5"/>
      </svg>
      Record
    `;
  }
}

// --------------------- PLAY WITH FX ---------------------
async function togglePlayWithFX(btn, audioUrl, trackId) {
  await audioCtx.resume();
  if (trackMuteStates[trackId]) return; // do nothing if muted

  if (btn.textContent.includes('Stop')) {
    currentSources[trackId]?.stop();
    delete currentSources[trackId];
    waveSurfers[trackId]?.pause();
    waveSurfers[trackId]?.seekTo(0);
    btn.innerHTML = `
      <img src="play-icon.png" width="20" height="20"
           style="margin-right:6px;vertical-align:middle;" alt="Play">
      Play with FX
    `;
    return;
  }

  const ab = await fetch(audioUrl).then(r => r.arrayBuffer());
  const buffer = await audioCtx.decodeAudioData(ab);
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  applyEffects(trackId, src, audioCtx.destination);
  src.start();
  currentSources[trackId] = src;

  waveSurfers[trackId]?.seekTo(0) && waveSurfers[trackId].play();
  btn.innerHTML = `
    <img src="stop_square_icon_206305.png" width="20" height="20"
         style="margin-right:6px;vertical-align:middle;" alt="Stop">
    Stop
  `;
  src.onended = () => {
    delete currentSources[trackId];
    waveSurfers[trackId]?.pause();
    waveSurfers[trackId]?.seekTo(0);
    btn.innerHTML = `
      <img src="play-icon.png" width="20" height="20"
           style="margin-right:6px;vertical-align:middle;" alt="Play">
      Play with FX
    `;
  };
}

// --------------------- UI & TRACK MANAGEMENT ---------------------
function addNewTrack() {
  const list    = document.getElementById('trackList');
  const trackId = `track-${trackCounter++}`;
  trackMuteStates[trackId] = false;

  const labelNum = list.children.length + 1;
  const div = document.createElement('div');
  div.id        = trackId;
  div.className = 'track';
  div.innerHTML = `
    <div class="track-header" onclick="toggleExpand('${trackId}')">
      <span>Track ${labelNum}</span>
      <span class="expand-icon">▶</span>
    </div>
    <div class="waveform" id="waveform-${trackId}" style="position:relative;"></div>
    <div class="track-body">
      <div class="track-controls">
        <div class="button-row">
          <button class="button" onclick="toggleRecord(this,'${trackId}')">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="red"
                 viewBox="0 0 16 16" style="margin-right:6px;">
              <circle cx="8" cy="8" r="5"/>
            </svg>
            Record
          </button>
          <button class="button" onclick="toggleMute(this,'${trackId}')" data-muted="false">
            <img src="Speaker_Icon.svg.png" width="20" height="20"
                 style="margin-right:6px;vertical-align:middle;" alt="Mute">
            Mute
          </button>
          <button class="button" onclick="deleteTrack('${trackId}')">
            <img src="trash-icon.png" width="20" height="20"
                 style="margin-right:6px;vertical-align:middle;" alt="Delete">
            Delete
          </button>
        </div>
        <div class="fx-group"><label class="fx-label">Volume</label>
          <input type="range" class="fx-volume" min="0" max="100" value="50"/>
        </div>
        <div class="fx-group"><label class="fx-label">Distortion</label>
          <input type="range" class="fx-distortion" min="0" max="100" value="0"/>
        </div>
        <div class="fx-group"><label class="fx-label">Reverb</label>
          <input type="range" class="fx-reverb" min="0" max="100" value="0"/>
        </div>
        <div class="fx-group"><label class="fx-label">Chorus</label>
          <input type="range" class="fx-chorus" min="0" max="100" value="0"/>
        </div>
        <div class="audio-controls audio-wrapper" id="audio-${trackId}"></div>
      </div>
    </div>
  `;
  list.appendChild(div);

   // **force it open by default** ↓
   div.classList.add('expanded');
   const bodyEl = div.querySelector('.track-body');
   bodyEl.style.maxHeight = 'none';                   // let it grow to full height
   div.querySelector('.expand-icon').style.transform = 'rotate(90deg)';

  // wire volume slider
  div.querySelector('.fx-volume').addEventListener('input', e => {
    const v = parseInt(e.target.value, 10) / 100;
    if (trackGainNodes[trackId]) trackGainNodes[trackId].gain.value = v;
    waveSurfers[trackId]?.setVolume(trackMuteStates[trackId] ? 0 : v);
  });
}

function deleteTrack(id) {
  document.getElementById(id)?.remove();
}

function toggleExpand(id) {
  const trackEl = document.getElementById(id);
  const bodyEl  = trackEl.querySelector('.track-body');
  const icon    = trackEl.querySelector('.expand-icon');

  if (trackEl.classList.contains('expanded')) {
    bodyEl.style.maxHeight = bodyEl.scrollHeight + 'px';
    bodyEl.offsetHeight;               // force reflow
    bodyEl.style.maxHeight = '0';
    icon.style.transform   = 'rotate(0deg)';
    bodyEl.addEventListener('transitionend', function onEnd(e) {
      if (e.propertyName === 'max-height') {
        trackEl.classList.remove('expanded');
        bodyEl.removeEventListener('transitionend', onEnd);
      }
    });
  } else {
    trackEl.classList.add('expanded');
    bodyEl.style.maxHeight = bodyEl.scrollHeight + 'px';
    icon.style.transform   = 'rotate(90deg)';
    bodyEl.addEventListener('transitionend', function onEnd(e) {
      if (e.propertyName === 'max-height') {
        bodyEl.style.maxHeight = 'none';
        bodyEl.removeEventListener('transitionend', onEnd);
      }
    });
  }
}

async function setupMediaStream() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    alert('Mic access denied.');
  }
}

// --------------------- MUTE TOGGLE ---------------------
function toggleMute(btn, trackId) {
  const wasMuted = btn.getAttribute('data-muted') === 'true';
  const isMuted  = !wasMuted;
  trackMuteStates[trackId] = isMuted;
  btn.setAttribute('data-muted', isMuted);

  // swap icon + text
  btn.innerHTML = `
    <img src="${isMuted ? 'Mute_Icon.svg.png' : 'Speaker_Icon.svg.png'}"
         width="20" height="20" style="margin-right:6px;vertical-align:middle;"
         alt="${isMuted ? 'Unmute' : 'Mute'}">
    ${isMuted ? 'Unmute' : 'Mute'}
  `;

  // mute/unmute node & waveform
  const vol = parseInt(document.querySelector(`#${trackId} .fx-volume`).value, 10)/100;
  if (trackGainNodes[trackId]) trackGainNodes[trackId].gain.value = isMuted ? 0 : vol;
  waveSurfers[trackId]?.setVolume(isMuted ? 0 : vol);

  // overlay red PNG icon
  const wf = document.getElementById(`waveform-${trackId}`);
  // remove any existing overlay
  wf.querySelector('.mute-icon-container')?.remove();

  if (isMuted) {
    const overlay = document.createElement('img');
    overlay.className = 'mute-icon-container';
    overlay.src       = 'Mute_Icon_red.png';
    overlay.width     = 20;
    overlay.height    = 20;
    wf.appendChild(overlay);
  }
}

// --------------------- PLAY‑ON‑RECORD TOGGLE ---------------------
function togglePlayOnRecord() {
  playAudioDuringRecording = !playAudioDuringRecording;
  updatePlayOnRecordButton();
}

function updatePlayOnRecordButton() {
  const btn   = document.getElementById('toggleAudioBtn');
  const icon  = playAudioDuringRecording ? 'Speaker_Icon.svg.png' : 'Mute_Icon.svg.png';
  const label = playAudioDuringRecording ? 'Play on Record'    : 'Mute on Record';
  btn.innerHTML = `
    <img src="${icon}" width="20" height="20"
         style="margin-right:6px;vertical-align:middle;" alt="${label}">
    ${label}
  `;
}

// --------------------- PLAY ALL TOGGLE ---------------------
function togglePlayAllTracks() {
  const playBtn = document.getElementById('playAllBtn');
  const isPlaying = playBtn.textContent.includes('Stop');
  const trackIds  = Object.keys(trackData);
  if (!trackIds.length) return;

  if (isPlaying) {
    // STOP ALL
    trackIds.forEach(id => {
      currentSources[id]?.stop();
      delete currentSources[id];
      waveSurfers[id]?.pause();
      waveSurfers[id]?.seekTo(0);
    });
    playBtn.innerHTML = `
      <img src="play-icon.png" width="20" height="20"
           style="margin-right:6px;vertical-align:middle;" alt="Play All">
      Play All Tracks
    `;
  } else {
    // PLAY ALL (skip muted)
    let longest = 0, buffers = {};
    Promise.all(trackIds.map(id =>
      fetch(trackData[id].url)
        .then(r => r.arrayBuffer())
        .then(ab => audioCtx.decodeAudioData(ab))
        .then(buf => {
          buffers[id] = buf;
          if (buf.duration > longest) longest = buf.duration;
        })
    )).then(() => {
      trackIds.forEach(id => {
        if (trackMuteStates[id]) return;
        const src = audioCtx.createBufferSource();
        src.buffer = buffers[id];
        applyEffects(id, src, audioCtx.destination);
        src.start();
        currentSources[id] = src;
        waveSurfers[id]?.seekTo(0) && waveSurfers[id].play();
        src.onended = () => delete currentSources[id];
      });

      playBtn.innerHTML = `
        <img src="stop_square_icon_206305.png" width="20" height="20"
             style="margin-right:6px;vertical-align:middle;" alt="Stop All">
        Stop All
      `;

      setTimeout(() => {
        trackIds.forEach(id => {
          waveSurfers[id]?.pause();
          waveSurfers[id]?.seekTo(0);
        });
        playBtn.innerHTML = `
          <img src="play-icon.png" width="20" height="20"
               style="margin-right:6px;vertical-align:middle;" alt="Play All">
          Play All Tracks
        `;
      }, longest * 1000);
    });
  }
}

// --------------------- INIT ---------------------
window.onload = () => {
   // 🛠️ Safari fix: resume audio context on first click
   document.addEventListener('click', () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }, { once: true });
  addNewTrack();                // always start with Track 1 expanded
  updatePlayOnRecordButton();   // set correct label
};

// --------------------- GLOBAL BINDINGS ---------------------
window.addNewTrack         = addNewTrack;
window.toggleExpand        = toggleExpand;
window.toggleRecord        = toggleRecord;
window.togglePlayWithFX    = togglePlayWithFX;
window.toggleMute          = toggleMute;
window.deleteTrack         = deleteTrack;
window.togglePlayOnRecord  = togglePlayOnRecord;
window.togglePlayAllTracks = togglePlayAllTracks;
