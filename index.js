import { initializeApp } from "firebase/app";
import { getDatabase, ref, onValue } from "firebase/database";
import { firebaseConfig } from "./firebaseConfig.js";
import { initFluid, triggerHeartbeatSplat } from "./fluid.js";
import { HapticPulseSynth } from "./hapticPulseSynth.ts";

// --- Firebase ---
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const beatRef = ref(db, "live/beat_timestamp");

let isFirstBeatLoad = true;

// --- DOM ---
const overlay = document.getElementById("start-overlay");
const nameEl = document.getElementById("name");
const statusText = document.getElementById("status-text");
const beatNumberEl = document.getElementById("beat-number");
const canvas = document.getElementById("viz-canvas");

// ============================================================
// Universal Haptics
// ============================================================
function triggerHaptic(duration) {
  if (duration === undefined) duration = 60;
  if (typeof navigator.vibrate === "function") {
    navigator.vibrate([100, 50, 100]);
  }
  var sw = document.getElementById("haptic-switch");
  var label = document.getElementById("haptic-label-bridge");
  if (sw && label) {
    sw.checked = !sw.checked;
    label.click();
  }
}

// ============================================================
// HapticPulseSynth (Tone.js) + Breath Noise (raw Web Audio)
// ============================================================
var synth = new HapticPulseSynth();
var audioCtx = null;
var breathFilter = null;
var breathGain = null;

// --- Breath Noise (white noise + lowpass filter) ---
function initBreathNoise() {
  var ctx = audioCtx;
  if (!ctx) return;

  var bufferSize = ctx.sampleRate * 2;
  var buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  var data = buffer.getChannelData(0);
  for (var i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  var noise = ctx.createBufferSource();
  noise.buffer = buffer;
  noise.loop = true;

  breathFilter = ctx.createBiquadFilter();
  breathFilter.type = "lowpass";
  breathFilter.frequency.value = 150;
  breathFilter.Q.value = 1.0;

  breathGain = ctx.createGain();
  breathGain.gain.value = 0.0;

  noise.connect(breathFilter);
  breathFilter.connect(breathGain);
  breathGain.connect(ctx.destination);
  noise.start();
}

function setBreathIntensity(intensity) {
  if (!audioCtx || !breathFilter || !breathGain) return;
  var now = audioCtx.currentTime;
  breathFilter.frequency.linearRampToValueAtTime(150 + intensity * 800, now + 0.1);
  breathGain.gain.linearRampToValueAtTime(Math.min(intensity * 0.15, 0.12), now + 0.1);
}

// ============================================================
// Touch → Breath intensity tracking + Touch Boost
// ============================================================
var touchActive = false;
var touchStartTime = 0;

canvas.addEventListener("touchstart", function () {
  touchActive = true;
  touchStartTime = Date.now();
  synth.setTouchBoost(true);
}, { passive: true });

canvas.addEventListener("touchend", function () {
  touchActive = false;
  setBreathIntensity(0);
  synth.setTouchBoost(false);
}, { passive: true });

canvas.addEventListener("touchcancel", function () {
  touchActive = false;
  setBreathIntensity(0);
  synth.setTouchBoost(false);
}, { passive: true });

// Update breath intensity based on touch duration
function updateBreath() {
  if (touchActive) {
    var elapsed = (Date.now() - touchStartTime) / 1000;
    var intensity = Math.min(elapsed / 3.0, 1.0); // ramp over 3 seconds
    setBreathIntensity(intensity);
  }
  requestAnimationFrame(updateBreath);
}
requestAnimationFrame(updateBreath);

// ============================================================
// Visual Effects
// ============================================================
function pulseNameText() {
  nameEl.classList.remove("pulse");
  void nameEl.offsetWidth;
  nameEl.classList.add("pulse");
}

// ============================================================
// Heartbeat Handler
// ============================================================
function onHeartbeat(beatCount) {
  if (beatNumberEl) {
    beatNumberEl.textContent = beatCount != null ? "Heart Beat! #" + beatCount : "";
  }
  // 1. Universal haptics (vibrate API + iOS switch hack)
  triggerHaptic(60);
  // 2. Tone.js Haptic Pulse — Sawtooth + SubBass 二重パルス
  synth.trigger();
  // 3. Fluid simulation heartbeat splat
  triggerHeartbeatSplat();
  // 4. Name glow
  pulseNameText();
}

// ============================================================
// Start Overlay — AudioContext unlock
// ============================================================
overlay.addEventListener("click", async function () {
  // Tone.jsのAudioContextをアンロック + シンセチェーン構築
  await synth.init();
  // Tone.jsのrawContextをbreathノイズと共有
  audioCtx = synth.getAudioContext();
  initBreathNoise();
  // テストパルス: AudioContextの動作確認
  synth.trigger();
  overlay.classList.add("hidden");
  initFluid(canvas);
  statusText.textContent = "接続完了 — 心拍を待機中";
  statusText.classList.add("connected");
}, { once: true });

// ============================================================
// ローカル中継 (WebSocket) — 同一WiFiでラグ削減
// ============================================================
var relayWs = null;
var relayConnected = false;
var RELAY_PORT = 8765;

function connectRelay() {
  var scheme = location.protocol === "https:" ? "wss:" : "ws:";
  var url = scheme + "//" + location.hostname + ":" + RELAY_PORT;
  try {
    relayWs = new WebSocket(url);
    relayWs.onopen = function () {
      relayConnected = true;
      console.log("[relay] WebSocket 接続済み — 低遅延モード");
    };
    relayWs.onclose = function () {
      relayConnected = false;
      relayWs = null;
      console.log("[relay] WebSocket 切断");
      setTimeout(connectRelay, 3000);
    };
    relayWs.onerror = function () {
      relayConnected = false;
    };
    relayWs.onmessage = function (e) {
      try {
        var data = JSON.parse(e.data);
        if (data.ts != null) {
          if (isFirstBeatLoad) {
            isFirstBeatLoad = false;
            return;
          }
          onHeartbeat(data.count != null ? data.count : null);
        }
      } catch (err) {}
    };
  } catch (e) {
    setTimeout(connectRelay, 3000);
  }
}
connectRelay();

// ============================================================
// Firebase Listeners（中継未接続時のみ使用）
// ============================================================
onValue(beatRef, function (snapshot) {
  if (relayConnected) return;
  var v = snapshot.val();
  console.log("Firebase beat received:", v);
  if (isFirstBeatLoad) {
    isFirstBeatLoad = false;
    return;
  }
  var count = v && typeof v === "object" && v.count != null ? v.count : null;
  onHeartbeat(count);
});
