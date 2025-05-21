// --------------------- GLOBAL VARIABLES ---------------------
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let currentSources = {};
let waveSurfers     = {};
let trackCounter    = 0;
let mediaStream     = null;
let mediaRecorder   = null;
let chunks          = [];
let trackData       = {};  // { trackId: { url, blob } }
let playAudioDuringRecording = false;

let trackGainNodes = {};
let trackMuteStates = {};
let impulseBuffer   = null;
let playheads       = {};   // { trackId: playheadElement }
let playheadAnimFrames = {}; // { trackId: animationFrameID }

// --------------------- PLAY‑ON‑RECORD TOGGLE ---------------------
function togglePlayOnRecord(checked) {
  playAudioDuringRecording = checked;
  document.querySelector('.toggle-switch')
          .classList.toggle('on', checked);
}

// --------------------- LOAD REVERB IMPULSE RESPONSE ---------------------
fetch('impulse.wav')
  .then(r => {
    if (!r.ok) throw new Error('Impulse load failed: ' + r.status);
    return r.arrayBuffer();
  })
  .then(data => audioCtx.decodeAudioData(data))
  .then(buf => {
    impulseBuffer = buf;
    console.log('✅ Reverb impulse loaded');
  })
  .catch(err => console.warn('❌ Reverb impulse error:', err));

// --------------------- AUDIO EFFECTS ---------------------
function applyEffects(trackId, source, destination) {
  const vol       = parseFloat(document.querySelector(`#${trackId} .fx-volume`).value) / 100;
  const dist      = parseFloat(document.querySelector(`#${trackId} .fx-distortion`).value);
  const reverbVal = parseFloat(document.querySelector(`#${trackId} .fx-reverb`).value) / 100;

  console.log(`FX[${trackId}] reverb=${reverbVal} impulseLoaded=${!!impulseBuffer}`);

  // Master gain
  const gainNode = audioCtx.createGain();
  gainNode.gain.value = trackMuteStates[trackId] ? 0 : vol;

  // Distortion
  const distortion = audioCtx.createWaveShaper();
  distortion.curve = makeDistortionCurve(dist);
  distortion.oversample = '4x';

  // Dry & wet gains
  const dryGain = audioCtx.createGain();
  const wetGain = audioCtx.createGain();
  dryGain.gain.value = 1 - reverbVal;
  wetGain.gain.value = reverbVal;

  // Reverb convolver
  const convolver = audioCtx.createConvolver();
  if (impulseBuffer) {
    convolver.buffer = impulseBuffer;
  }

  // Delay for longer tails
  const delayNode = audioCtx.createDelay();
  delayNode.delayTime.value = reverbVal * 0.5; // up to 0.5s delay

  // Build graph
  source.connect(distortion);
  distortion.connect(dryGain);
  dryGain.connect(gainNode);

  // Wet paths
  if (impulseBuffer) {
    source.connect(convolver);
    convolver.connect(wetGain);
  }
  source.connect(delayNode);
  delayNode.connect(wetGain);
  wetGain.connect(gainNode);

  // Final out
  gainNode.connect(destination);
  trackGainNodes[trackId] = gainNode;
}

function makeDistortionCurve(amount) {
  const k = typeof amount === 'number' ? amount : 50;
  const n = 44100;
  const curve = new Float32Array(n);
  const deg = Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

// --------------------- RECORDING ---------------------
async function toggleRecord(btn, trackId) {
  await audioCtx.resume();
  if (!mediaStream) await setupMediaStream();
  if (!mediaStream) return;

  const recordingId = trackId;
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    chunks = [];
    mediaRecorder = new MediaRecorder(mediaStream);

    mediaRecorder.onstart = () => {
      // Play visual & audible playback of other tracks
      Object.keys(waveSurfers).forEach(id => {
        if (id === recordingId) return;
        const ws = waveSurfers[id];
        if (ws && ws.isReady) {
          const shouldHear = playAudioDuringRecording && !trackMuteStates[id];
          ws.setVolume(shouldHear ? parseFloat(
            document.querySelector(`#${id} .fx-volume`).value
          )/100 : 0);
          ws.seekTo(0);
          ws.play();
          animatePlayhead(id, ws);
        }
      });
    };

    mediaRecorder.ondataavailable = e => chunks.push(e.data);
    mediaRecorder.onstop = () => {
      Object.values(currentSources).forEach(s => s.stop());
      currentSources = {};

      const blob = new Blob(chunks, { type: 'audio/webm' });
      const url  = URL.createObjectURL(blob);
      trackData[trackId] = { url, blob };

      const audioWrap = document.getElementById(`audio-${trackId}`);
      audioWrap.innerHTML = `
        <button class="button play-with-fx"
                onclick="togglePlayWithFX(this,'${url}','${trackId}')">
          <img src="play-icon.png" width="20" height="20"
               style="margin-left:4px;vertical-align:middle;" alt="Play">
          Play with FX
        </button>
      `;

      const wf = document.getElementById(`waveform-${trackId}`);
      wf.innerHTML = '';
      const playhead = document.createElement('div');
      playhead.className = 'playhead';
      playhead.style.left = '0px';
      wf.appendChild(playhead);
      playheads[trackId] = playhead;

      if (waveSurfers[trackId]) waveSurfers[trackId].destroy();
      const ws = WaveSurfer.create({
        container: wf,
        waveColor:    '#5a8fb8',
        progressColor:'#a3d2f0',
        barWidth: 2,
        height:   80,
        backend:  'WebAudio'
      });
      waveSurfers[trackId] = ws;
      ws.load(url);
      ws.on('ready', () => {
        ws.on('play',  () => animatePlayhead(trackId, ws));
        ws.on('pause', () => cancelAnimationFrame(playheadAnimFrames[trackId]));
        ws.on('finish',() => {
          cancelAnimationFrame(playheadAnimFrames[trackId]);
          playheads[trackId].style.left = '0px';
        });
      });

      btn.classList.remove('recording');
    };

    mediaRecorder.start();
    btn.classList.add('recording');
    btn.innerHTML = `
      <img src="stop_square_icon_206305.png" width="20" height="20"
           style="margin-left:0;vertical-align:middle;" alt="Stop">
      Stop
    `;
  } else {
    mediaRecorder.stop();
    btn.classList.remove('recording');
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="red"
           viewBox="0 0 16 16" style="margin-right:6px;vertical-align:middle;" alt="Record">
        <circle cx="8" cy="8" r="5"/>
      </svg>
      Record
    `;
  }
}

// --------------------- PLAYHEAD ANIMATION ---------------------
function animatePlayhead(trackId, wavesurfer) {
  const playhead = playheads[trackId];
  const container = document.getElementById(`waveform-${trackId}`);
  if (!playhead || !container) return;
  cancelAnimationFrame(playheadAnimFrames[trackId]);
  const width = container.clientWidth;
  function step() {
    const t = wavesurfer.getCurrentTime();
    const d = wavesurfer.getDuration();
    if (!d) return;
    playhead.style.left = `${(t/d) * width}px`;
    playheadAnimFrames[trackId] = requestAnimationFrame(step);
  }
  step();
}

// --------------------- PLAY WITH FX ---------------------
async function togglePlayWithFX(btn, audioUrl, trackId) {
  await audioCtx.resume();
  if (btn.textContent.includes('Stop')) {
    currentSources[trackId]?.stop();
    delete currentSources[trackId];
    waveSurfers[trackId]?.pause();
    waveSurfers[trackId]?.seekTo(0);
    btn.innerHTML = `
      <img src="play-icon.png" width="20" height="20"
           style="margin-left:4px;vertical-align:middle;" alt="Play">
      Play with FX
    `;
    return;
  }
  const ab     = await fetch(audioUrl).then(r => r.arrayBuffer());
  const buffer = await audioCtx.decodeAudioData(ab);
  const src    = audioCtx.createBufferSource();
  src.buffer   = buffer;
  applyEffects(trackId, src, audioCtx.destination);
  src.start();
  currentSources[trackId] = src;
  const ws = waveSurfers[trackId];
  if (ws) {
    if (ws.isReady) {
      ws.seekTo(0);
      ws.play();
      animatePlayhead(trackId, ws);
    } else {
      ws.on('ready', () => {
        ws.seekTo(0);
        ws.play();
        animatePlayhead(trackId, ws);
      });
    }
  }
  btn.innerHTML = `
    <img src="stop_square_icon_206305.png" width="20" height="20"
         style="margin-left:0;vertical-align:middle;" alt="Stop">
    Stop
  `;
  src.onended = () => {
    cancelAnimationFrame(playheadAnimFrames[trackId]);
    playheads[trackId].style.left = '0px';
    delete currentSources[trackId];
    waveSurfers[trackId]?.pause();
    waveSurfers[trackId]?.seekTo(0);
    btn.innerHTML = `
      <img src="play-icon.png" width="20" height="20"
           style="margin-left:4px;vertical-align:middle;" alt="Play">
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
      <img class="expand-icon" src="triangle.png" width="14" height="14"
           alt="Expand">
    </div>
    <div class="waveform" id="waveform-${trackId}"></div>
    <div class="track-body">
      <div class="track-controls">
        <div class="button-row">
          <button class="button" onclick="toggleRecord(this,'${trackId}')">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="red" viewBox="0 0 16 16">
              <circle cx="8" cy="8" r="5"/>
            </svg>
            Record
          </button>
          <button class="button" onclick="toggleMute(this,'${trackId}')" data-muted="false">
            <img src="Speaker_Icon.svg.png" width="20" height="20" alt="Mute">
            Mute
          </button>
          <button class="button" onclick="deleteTrack('${trackId}')">
            <img src="trash-icon.png" width="20" height="20" alt="Delete">
            Delete
          </button>
        </div>
        <div class="fx-group"><label class="fx-label">Volume</label>
          <input type="range" class="fx-volume" min="0" max="200" value="100"/>
        </div>
        <div class="fx-group"><label class="fx-label">Distortion</label>
          <input type="range" class="fx-distortion" min="0" max="100" value="0"/>
        </div>
        <div class="fx-group"><label class="fx-label">Reverb</label>
          <input type="range" class="fx-reverb" min="0" max="100" value="0"/>
        </div>
        <div class="audio-controls" id="audio-${trackId}"></div>
      </div>
    </div>
  `;
  list.appendChild(div);

  // open by default
  div.classList.add('expanded');
  const bodyEl = div.querySelector('.track-body');
  bodyEl.style.maxHeight = 'none';
  div.querySelector('.expand-icon').style.transform = 'rotate(180deg)';

  // wire volume slider
  div.querySelector('.fx-volume').addEventListener('input', e => {
    const v = parseFloat(e.target.value) / 100;
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
    bodyEl.offsetHeight; // force reflow
    bodyEl.style.maxHeight = '0';
    icon.style.transform   = 'rotate(270deg)';
    bodyEl.addEventListener('transitionend', function onEnd(e) {
      if (e.propertyName === 'max-height') {
        trackEl.classList.remove('expanded');
        bodyEl.removeEventListener('transitionend', onEnd);
      }
    });
  } else {
    trackEl.classList.add('expanded');
    bodyEl.style.maxHeight = bodyEl.scrollHeight + 'px';
    icon.style.transform   = 'rotate(180deg)';
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

  btn.innerHTML = `
    <img src="${isMuted ? 'Mute_Icon.svg.png' : 'Speaker_Icon.svg.png'}" width="20" height="20" alt="Mute">
    ${isMuted ? 'Unmute' : 'Mute'}
  `;

  const vol = parseFloat(document.querySelector(`#${trackId} .fx-volume`).value) / 100;
  if (trackGainNodes[trackId]) trackGainNodes[trackId].gain.value = isMuted ? 0 : vol;
  waveSurfers[trackId]?.setVolume(isMuted ? 0 : vol);

  const wf = document.getElementById(`waveform-${trackId}`);
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

// --------------------- PLAY ALL TOGGLE ---------------------
function togglePlayAllTracks() {
  const playBtn   = document.getElementById('playAllBtn');
  const isPlaying = playBtn.textContent.includes('Stop');
  const trackIds  = Object.keys(trackData);
  if (!trackIds.length) return;

  if (isPlaying) {
    trackIds.forEach(id => {
      currentSources[id]?.stop();
      delete currentSources[id];
      waveSurfers[id]?.pause();
      waveSurfers[id]?.seekTo(0);
    });
    playBtn.innerHTML = `
      <img src="play-icon.png" width="20" height="20" style="margin-left:4px;vertical-align:middle;" alt="Play All">
    `;
  } else {
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
        const src = audioCtx.createBufferSource();
        src.buffer = buffers[id];
        applyEffects(id, src, audioCtx.destination);
        src.start();
        currentSources[id] = src;
        const ws = waveSurfers[id];
        if (ws.isReady) {
          ws.seekTo(0);
          ws.play();
          animatePlayhead(id, ws);
        } else {
          ws.on('ready', () => {
            ws.seekTo(0);
            ws.play();
            animatePlayhead(id, ws);
          });
        }
        src.onended = () => delete currentSources[id];
      });

      playBtn.innerHTML = `
        <img src="stop_square_icon_206305.png" width="20" height="20" style="margin-left:0;vertical-align:middle;" alt="Stop All">
      `;
      setTimeout(() => {
        trackIds.forEach(id => {
          waveSurfers[id]?.pause();
          waveSurfers[id]?.seekTo(0);
        });
        playBtn.innerHTML = `
          <img src="play-icon.png" width="20" height="20" style="margin-left:4px;vertical-align:middle;" alt="Play All">
        `;
      }, longest * 1000);
    });
  }
}



// --------------------- INIT ---------------------
window.onload = () => {
  document.addEventListener('click', () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }, { once: true });

  addNewTrack();
};

// --------------------- EXPORT MIXDOWN ---------------------
async function exportMixdown() {
  // no tracks? bail early
  const ids = Object.keys(trackData);
  if (!ids.length) {
    alert('Nothing recorded yet!');
    return;
  }

  // decode each track’s blob into an AudioBuffer
  const buffers = await Promise.all(
    ids.map(id => trackData[id].blob.arrayBuffer().then(ab => audioCtx.decodeAudioData(ab)))
  );

  // determine length of the longest buffer
  const sampleRate   = audioCtx.sampleRate;
  const maxDuration  = Math.max(...buffers.map(b => b.duration));
  const frameCount   = Math.ceil(maxDuration * sampleRate);

  // create an OfflineAudioContext for mixing
  const offline = new OfflineAudioContext(1, frameCount, sampleRate);

  // play each buffer into the offline context
  buffers.forEach(buffer => {
    const src = offline.createBufferSource();
    src.buffer = buffer;
    src.connect(offline.destination);
    src.start(0);
  });

  // render the mix
  const rendered = await offline.startRendering();

  // convert to WAV
  const wavBlob = bufferToWave(rendered, rendered.length);
  const url     = URL.createObjectURL(wavBlob);

  // trigger download named “RiffSketch.wav”
  const a = document.createElement('a');
  a.href        = url;
  a.download    = 'RiffSketch.wav';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// helper: turn an AudioBuffer into a WAV-format Blob
function bufferToWave(abuffer, len) {
  const numChan = abuffer.numberOfChannels;
  const length  = 44 + len * numChan * 2;
  const buffer  = new ArrayBuffer(length);
  const view    = new DataView(buffer);
  let offset = 0;

  function writeString(str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset++, str.charCodeAt(i));
    }
  }

  // RIFF header
  writeString('RIFF');
  view.setUint32(offset, length - 8, true); offset += 4;
  writeString('WAVEfmt ');
  view.setUint32(offset, 16, true); offset += 4;           // PCM header size
  view.setUint16(offset, 1, true); offset += 2;            // PCM format
  view.setUint16(offset, numChan, true); offset += 2;      // channels
  view.setUint32(offset, abuffer.sampleRate, true); offset += 4;
  view.setUint32(offset, abuffer.sampleRate * numChan * 2, true); offset += 4;
  view.setUint16(offset, numChan * 2, true); offset += 2;   // block align
  view.setUint16(offset, 16, true); offset += 2;            // bits per sample
  writeString('data');
  view.setUint32(offset, length - offset - 4, true); offset += 4;

  // write interleaved PCM samples
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < numChan; ch++) {
      let sample = abuffer.getChannelData(ch)[i];
      // clamp & scale to 16‑bit int
      sample = Math.max(-1, Math.min(1, sample));
      sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, sample, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

// --------------------- BINDINGS ---------------------
window.addNewTrack         = addNewTrack;
window.toggleExpand        = toggleExpand;
window.toggleRecord        = toggleRecord;
window.togglePlayWithFX    = togglePlayWithFX;
window.toggleMute          = toggleMute;
window.deleteTrack         = deleteTrack;
window.togglePlayOnRecord  = togglePlayOnRecord;
window.togglePlayAllTracks = togglePlayAllTracks;
