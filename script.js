const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let currentSources = {};
let allTrackSources = [];
let waveSurfers = {};
let trackCounter = 0;
let mediaStream = null;
let mediaRecorder = null;
let chunks = [];
let trackData = {};            // { trackId: { url, blob } }
let playAudioDuringRecording = false;

// Global objects for mute state and volume control.
let trackGainNodes = {};       // The GainNode for each track (updated in applyEffects)
let trackMuteStates = {};      // Mute state for each track (true/false)

// --------------------- AUDIO EFFECTS AND PROCESSING ---------------------

function makeDistortionCurve(amount) {
  const k = typeof amount === 'number' ? amount : 50;
  const n_samples = 44100;
  const curve = new Float32Array(n_samples);
  const deg = Math.PI / 180;
  for (let i = 0; i < n_samples; ++i) {
    let x = (i * 2) / n_samples - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

function applyEffects(trackId, source, destination) {
  // Get the volume slider's value and check if the track is muted.
  const sliderVolume = parseInt(document.querySelector(`#${trackId} .fx-volume`).value, 10) / 100;
  const isMuted = trackMuteStates[trackId] || false;
  // If muted, effective volume is 0; otherwise, use the slider value.
  const volume = isMuted ? 0 : sliderVolume;

  const gainNode = audioCtx.createGain();
  gainNode.gain.value = volume;
  // Store the gain node so that volume can be updated later.
  trackGainNodes[trackId] = gainNode;

  const distortionValue = parseInt(document.querySelector(`#${trackId} .fx-distortion`).value, 10);
  const reverbValue = parseInt(document.querySelector(`#${trackId} .fx-reverb`).value, 10) / 100;
  const chorusValue = parseInt(document.querySelector(`#${trackId} .fx-chorus`).value, 10) / 100;

  const distortion = audioCtx.createWaveShaper();
  distortion.curve = makeDistortionCurve(distortionValue);
  distortion.oversample = 'none';

  const reverbDelay = audioCtx.createDelay();
  reverbDelay.delayTime.value = 0.2 * reverbValue;
  const reverbGain = audioCtx.createGain();
  reverbGain.gain.value = 0.5 * reverbValue;
  reverbDelay.connect(reverbGain);
  reverbGain.connect(reverbDelay);

  const chorusDelay = audioCtx.createDelay();
  chorusDelay.delayTime.value = 0.03 * chorusValue;
  const lfo = audioCtx.createOscillator();
  const lfoGain = audioCtx.createGain();
  lfo.frequency.value = 0.25;
  lfoGain.gain.value = 0.01 * chorusValue;
  lfo.connect(lfoGain);
  lfoGain.connect(chorusDelay.delayTime);
  lfo.start();

  source.connect(gainNode);
  gainNode.connect(distortion);
  distortion.connect(chorusDelay);
  chorusDelay.connect(reverbDelay);
  reverbDelay.connect(destination);
  chorusDelay.connect(destination);
}

// --------------------- RECORDING & PLAYBACK FUNCTIONS ---------------------

async function toggleRecord(btn, trackId) {
  await audioCtx.resume();
  if (!mediaStream) await setupMediaStream();
  if (!mediaStream) return;

  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    chunks = [];
    mediaRecorder = new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = e => chunks.push(e.data);
    mediaRecorder.onstop = () => {
      // Create a blob and URL for the recorded audio.
      const blob = new Blob(chunks, { type: "audio/webm" });
      const url = URL.createObjectURL(blob);
      trackData[trackId] = { url, blob };

      const audioWrapper = document.getElementById(`audio-${trackId}`);
      audioWrapper.innerHTML = `
        <button class="button" onclick="togglePlayWithFX(this, '${url}', '${trackId}')">▶ Play with FX</button>
      `;

      const container = document.getElementById(`waveform-${trackId}`);
      container.innerHTML = '';
      const wavesurfer = WaveSurfer.create({
        container,
        waveColor: '#ff0',
        progressColor: '#f0f',
        barWidth: 2,
        height: 80,
      });
      wavesurfer.load(url);
      waveSurfers[trackId] = wavesurfer;
    };

    mediaRecorder.start();
    btn.textContent = "■ Stop";
    Object.entries(waveSurfers).forEach(([id, ws]) => {
      if (id !== trackId) {
        ws.setVolume(playAudioDuringRecording ? 1 : 0);
        ws.play();
      }
    });
  } else {
    mediaRecorder.stop();
    btn.textContent = "● Record";
    Object.values(waveSurfers).forEach(ws => {
      ws.pause();
      ws.seekTo(0);
      ws.setVolume(1);
    });
  }
}

function togglePlayWithFX(btn, audioUrl, trackId) {
  if (btn.textContent.includes("Stop")) {
    stopPlayback(trackId);
    btn.textContent = "▶ Play with FX";
    return;
  }

  fetch(audioUrl)
    .then(res => res.arrayBuffer())
    .then(arrayBuffer => audioCtx.decodeAudioData(arrayBuffer))
    .then(audioBuffer => {
      if (currentSources[trackId]) {
        currentSources[trackId].stop();
      }

      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      applyEffects(trackId, source, audioCtx.destination);
      source.start();
      currentSources[trackId] = source;

      const wavesurfer = waveSurfers[trackId];
      if (wavesurfer) {
        wavesurfer.seekTo(0);
        // Retrieve current volume from slider each time playback starts.
        const volumeSlider = document.querySelector(`#${trackId} .fx-volume`);
        const volumeValue = volumeSlider ? parseInt(volumeSlider.value, 10) / 100 : 1;
        const isMuted = trackMuteStates[trackId] || false;
        wavesurfer.setVolume(isMuted ? 0 : volumeValue);
        wavesurfer.play();
      }

      btn.textContent = "⏹ Stop";
      source.onended = () => {
        btn.textContent = "▶ Play with FX";
        currentSources[trackId] = null;
        if (waveSurfers[trackId]) {
          waveSurfers[trackId].pause();
          waveSurfers[trackId].seekTo(0);
        }
      };
    });
}

function stopPlayback(trackId) {
  if (currentSources[trackId]) {
    currentSources[trackId].stop();
    currentSources[trackId] = null;
  }
  if (waveSurfers[trackId]) {
    waveSurfers[trackId].pause();
    waveSurfers[trackId].seekTo(0);
  }
}

function togglePlayAllTracks() {
  const btn = document.getElementById("playAllBtn");
  if (btn.textContent.includes("Stop")) {
    stopAllTracks();
    btn.textContent = "▶ Play All Tracks";
  } else {
    playAllTracks();
    btn.textContent = "⏹ Stop All Tracks";
  }
}

function playAllTracks() {
  stopAllTracks();
  allTrackSources = [];
  let finishedCount = 0;
  const trackIds = Object.keys(trackData);
  trackIds.forEach(trackId => {
    const { blob } = trackData[trackId];
    blob.arrayBuffer().then(arrayBuffer => {
      audioCtx.decodeAudioData(arrayBuffer).then(audioBuffer => {
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        applyEffects(trackId, source, audioCtx.destination);
        source.start();
        allTrackSources.push(source);

        const wavesurfer = waveSurfers[trackId];
        if (wavesurfer) {
          wavesurfer.seekTo(0);
          const volumeSlider = document.querySelector(`#${trackId} .fx-volume`);
          const volumeValue = volumeSlider ? parseInt(volumeSlider.value, 10) / 100 : 1;
          const isMuted = trackMuteStates[trackId] || false;
          wavesurfer.setVolume(isMuted ? 0 : volumeValue);
          wavesurfer.play();
        }

        source.onended = () => {
          finishedCount++;
          if (finishedCount === trackIds.length) {
            document.getElementById("playAllBtn").textContent = "▶ Play All Tracks";
          }
        };
      });
    });
  });
}

function stopAllTracks() {
  allTrackSources.forEach(src => src.stop());
  allTrackSources = [];
  Object.values(waveSurfers).forEach(w => {
    w.pause();
    w.seekTo(0);
  });
}

// --------------------- UI CONTROLS ---------------------

function toggleExpand(id) {
  const el = document.getElementById(id);
  el.classList.toggle("expanded");
}

function deleteTrack(trackId) {
  const track = document.getElementById(trackId);
  if (track) track.remove();
  delete waveSurfers[trackId];
  delete trackData[trackId];
  delete trackMuteStates[trackId];
  delete trackGainNodes[trackId];
}

function toggleRecordingAudio() {
  playAudioDuringRecording = !playAudioDuringRecording;
  const btn = document.getElementById("toggleAudioBtn");
  btn.textContent = playAudioDuringRecording ? "🔊 Monitor: On" : "🔇 Monitor: Off";
}

async function setupMediaStream() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    alert("Microphone access denied or not supported.");
    console.error(err);
  }
}

// Toggle mute state for a given track.
function toggleMute(btn, trackId) {
  const wavesurfer = waveSurfers[trackId];
  if (!wavesurfer) return;
  
  const waveformContainer = document.getElementById(`waveform-${trackId}`);
  const isMuted = trackMuteStates[trackId] || false;
  const newMutedState = !isMuted;
  trackMuteStates[trackId] = newMutedState;
  
  if (newMutedState) {
    btn.textContent = "🔇 Unmute";
    btn.setAttribute('data-muted', 'true');
    if (trackGainNodes[trackId]) {
      trackGainNodes[trackId].gain.value = 0;
    }
    wavesurfer.setVolume(0);
    if (!waveformContainer.querySelector('.mute-icon-container')) {
      const iconDiv = document.createElement('div');
      iconDiv.className = 'mute-icon-container';
      iconDiv.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="mute-icon bi bi-volume-mute" viewBox="0 0 16 16">
  <path d="M6.717 3.55A.5.5 0 0 1 7 4v8a.5.5 0 0 1-.812.39L3.825 10.5H1.5A.5.5 0 0 1 1 10V6a.5.5 0 0 1 .5-.5h2.325l2.363-1.89a.5.5 0 0 1 .529-.06M6 5.04 4.312 6.39A.5.5 0 0 1 4 6.5H2v3h2a.5.5 0 0 1 .312.11L6 10.96zm7.854.606a.5.5 0 0 1 0 .708L12.207 8l1.647 1.646a.5.5 0 0 1-.708.708L11.5 8.707l-1.646 1.647a.5.5 0 0 1-.708-.708L10.793 8 9.146 6.354a.5.5 0 1 1 .708-.708L11.5 7.293l1.646-1.647a.5.5 0 0 1 .708 0"/>
</svg>`;
      waveformContainer.appendChild(iconDiv);
    }
  } else {
    btn.textContent = "🔈 Mute";
    btn.setAttribute('data-muted', 'false');
    const volumeSlider = document.querySelector(`#${trackId} .fx-volume`);
    const volume = volumeSlider ? parseInt(volumeSlider.value, 10) / 100 : 1;
    if (trackGainNodes[trackId]) {
      trackGainNodes[trackId].gain.value = volume;
    }
    wavesurfer.setVolume(volume);
    const muteIcon = waveformContainer.querySelector('.mute-icon-container');
    if (muteIcon) {
      muteIcon.remove();
    }
  }
}

// --------------------- TRACK CREATION ---------------------

function addNewTrack() {
  const trackList = document.getElementById("trackList");
  const trackId = `track-${trackCounter++}`;
  // Initialize mute state for the new track.
  trackMuteStates[trackId] = false;

  const track = document.createElement("div");
  track.className = "track";
  track.id = trackId;

  track.innerHTML = `
    <div class="track-header" onclick="toggleExpand('${trackId}')">
      <span>Track ${trackCounter}</span>
      <span>▶</span>
    </div>
    <div class="waveform" id="waveform-${trackId}"></div>
    <div class="track-controls">
      <div class="button-row">
        <button class="button" onclick="toggleRecord(this, '${trackId}')">● Record</button>
        <button class="button" onclick="toggleMute(this, '${trackId}')" data-muted="false">🔈 Mute</button>
        <button class="button" onclick="deleteTrack('${trackId}')">🗑 Delete</button>
      </div>
      <div class="fx-group">
        <label class="fx-label">Volume</label>
        <input type="range" class="fx-volume" min="0" max="100" value="50" />
      </div>
      <div class="fx-group">
        <label class="fx-label">Distortion</label>
        <input type="range" class="fx-distortion" min="0" max="100" value="0" />
      </div>
      <div class="fx-group">
        <label class="fx-label">Reverb</label>
        <input type="range" class="fx-reverb" min="0" max="100" value="0" />
      </div>
      <div class="fx-group">
        <label class="fx-label">Chorus</label>
        <input type="range" class="fx-chorus" min="0" max="100" value="0" />
      </div>
      <div class="audio-wrapper audio-controls" id="audio-${trackId}"></div>
    </div>
  `;

  trackList.appendChild(track);
  toggleExpand(trackId);

  // Update volume in real time using the slider.
  const volumeSlider = track.querySelector('.fx-volume');
  if (volumeSlider) {
    volumeSlider.addEventListener('input', function() {
      const newVolume = parseInt(this.value, 10) / 100;
      if (!trackMuteStates[trackId]) {
        if (trackGainNodes[trackId]) {
          trackGainNodes[trackId].gain.value = newVolume;
        }
        if (waveSurfers[trackId]) {
          waveSurfers[trackId].setVolume(newVolume);
        }
      }
    });
  }
}

// Initialize a new track if none exists on load.
window.onload = () => {
  if (document.getElementById("trackList").children.length === 0) {
    addNewTrack();
  }
};

// --------------------- EXPORT MIXDOWN FUNCTION ---------------------

// Helper: Writes a string into a DataView at a given offset.
function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

// Helper: Converts an AudioBuffer to a WAV-formatted ArrayBuffer.
function bufferToWav(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const bitsPerSample = 16;
  const blockAlign = numChannels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  const wavDataByteLength = audioBuffer.length * blockAlign;
  const headerByteLength = 44;
  const totalLength = headerByteLength + wavDataByteLength;

  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);

  // Write WAV header.
  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalLength - 8, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, 'data');
  view.setUint32(40, wavDataByteLength, true);

  let offset = headerByteLength;
  for (let i = 0; i < audioBuffer.length; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      let sample = audioBuffer.getChannelData(channel)[i];
      sample = Math.max(-1, Math.min(1, sample));
      sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, sample, true);
      offset += 2;
    }
  }
  return buffer;
}

/**
 * exportMixdown()
 * 
 * This function exports all recorded tracks as a single mixed-down WAV file.
 * It decodes each recorded blob, mixes them together (padding shorter tracks with silence),
 * converts the mixdown to a WAV file, and triggers a download.
 */
function exportMixdown() {
  const trackIds = Object.keys(trackData);
  if (!trackIds.length) {
    alert("No recorded audio available for export.");
    return;
  }
  
  // Decode every recorded track.
  const decodePromises = trackIds.map(trackId => {
    const blob = trackData[trackId].blob;
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = evt => {
        audioCtx.decodeAudioData(evt.target.result, decodedBuffer => {
          resolve(decodedBuffer);
        }, error => reject(error));
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(blob);
    });
  });
  
  Promise.all(decodePromises).then(buffers => {
    // Assume all buffers have the same sample rate and number of channels.
    const sampleRate = buffers[0].sampleRate;
    const numChannels = buffers[0].numberOfChannels;
    let maxLength = Math.max(...buffers.map(buf => buf.length));
    
    // Create arrays to accumulate mix data per channel.
    let mixedData = [];
    for (let ch = 0; ch < numChannels; ch++) {
      mixedData[ch] = new Float32Array(maxLength);
    }
    
    // Sum the sample values; shorter buffers contribute 0 for missing samples.
    buffers.forEach(buffer => {
      for (let ch = 0; ch < numChannels; ch++) {
        const channelData = buffer.getChannelData(ch);
        for (let i = 0; i < channelData.length; i++) {
          mixedData[ch][i] += channelData[i];
        }
      }
    });
    
    // Average the sums to avoid clipping.
    for (let ch = 0; ch < numChannels; ch++) {
      for (let i = 0; i < maxLength; i++) {
        mixedData[ch][i] /= buffers.length;
      }
    }
    
    // Create a new AudioBuffer for the mixdown.
    const mixedBuffer = audioCtx.createBuffer(numChannels, maxLength, sampleRate);
    for (let ch = 0; ch < numChannels; ch++) {
      mixedBuffer.copyToChannel(mixedData[ch], ch);
    }
    
    // Convert the mixdown AudioBuffer into a WAV file.
    const wavBuffer = bufferToWav(mixedBuffer);
    const wavBlob = new Blob([new Uint8Array(wavBuffer)], { type: "audio/wav" });
    
    // Trigger the download.
    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mixdown.wav";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }).catch(error => {
    console.error("Error during mixdown export:", error);
    alert("An error occurred while exporting the mixdown.");
  });
}
