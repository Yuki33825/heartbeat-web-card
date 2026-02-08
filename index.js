import { initializeApp } from "firebase/app";
import { getDatabase, ref, onValue } from "firebase/database";
import { firebaseConfig } from "./firebaseConfig.js";

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
const ctx2d = canvas.getContext("2d");
const ecgPath = document.getElementById("ecg-path");

// ============================================================
// Universal Haptics
// ============================================================
function triggerHaptic(duration) {
  if (duration === undefined) duration = 60;
  // Android / Chrome - より強力なパターン
  if (typeof navigator.vibrate === "function") {
    navigator.vibrate([100, 50, 100]); // 2回パルス
  }
  // iOS 18+ Switch Hack — checked をトグルして label.click()
  var sw = document.getElementById("haptic-switch");
  var label = document.getElementById("haptic-label-bridge");
  if (sw && label) {
    sw.checked = !sw.checked;
    label.click();
  }
}

// ============================================================
// WebAudio Vibration Engine
// ============================================================
var audioCtx = null;

function ensureAudioContext() {
  if (audioCtx) return audioCtx;
  var Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  audioCtx = new Ctx({ sampleRate: 44100 });
  return audioCtx;
}

function unlockAudio() {
  var ctx = ensureAudioContext();
  if (ctx && ctx.state === "suspended") ctx.resume();
}

function playHeartbeatHaptic() {
  var ctx = audioCtx;
  if (!ctx || ctx.state !== "running") return;
  var now = ctx.currentTime;

  // 第1拍 "lub" (強い方)
  playImpulse(now, 0.12, [30, 45, 55], 0.95);
  // 第2拍 "dub" (やや弱い、0.15秒後)
  playImpulse(now + 0.15, 0.08, [35, 50], 0.7);
}

function playImpulse(startTime, duration, frequencies, peakGain) {
  var ctx = audioCtx;

  var masterGain = ctx.createGain();
  masterGain.connect(ctx.destination);
  masterGain.gain.setValueAtTime(peakGain, startTime);
  masterGain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  // 複数の周波数をレイヤー
  frequencies.forEach(function (freq) {
    var osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;

    var oscGain = ctx.createGain();
    oscGain.gain.value = 1.0 / frequencies.length;
    osc.connect(oscGain);
    oscGain.connect(masterGain);

    osc.start(startTime);
    osc.stop(startTime + duration + 0.01);
  });

  // サブベース矩形波で振動感を増強
  var subOsc = ctx.createOscillator();
  subOsc.type = "square";
  subOsc.frequency.value = 20;
  var subGain = ctx.createGain();
  subGain.gain.setValueAtTime(peakGain * 0.3, startTime);
  subGain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  subOsc.connect(subGain);
  subGain.connect(masterGain);
  subOsc.start(startTime);
  subOsc.stop(startTime + duration + 0.01);
}

// ============================================================
// Particle System
// ============================================================
var particles = [];

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

function Particle(x, y, isBurst) {
  this.x = x;
  this.y = y;
  this.vx = (Math.random() - 0.5) * (isBurst ? 6 : 0.3);
  this.vy = (Math.random() - 0.5) * (isBurst ? 6 : 0.3);
  this.life = 1.0;
  this.decay = isBurst ? 0.02 : 0.002;
  this.radius = isBurst ? Math.random() * 3 + 1 : Math.random() * 1.5 + 0.5;
  this.color = isBurst ? "255, 45, 85" : "255, 255, 255";
}

Particle.prototype.update = function () {
  this.x += this.vx;
  this.y += this.vy;
  this.vx *= 0.98;
  this.vy *= 0.98;
  this.life -= this.decay;
};

Particle.prototype.draw = function (context) {
  context.beginPath();
  context.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
  context.fillStyle = "rgba(" + this.color + ", " + (this.life * 0.5) + ")";
  context.fill();
};

function emitParticleBurst() {
  var cx = canvas.width / 2;
  var cy = canvas.height / 2;
  for (var i = 0; i < 40; i++) {
    particles.push(new Particle(cx, cy, true));
  }
}

// ============================================================
// ECG Waveform
// ============================================================
var ECG_WIDTH = 400;
var ECG_HEIGHT = 80;
var ecgData = [];
var ecgCursor = 0;

function initEcg() {
  ecgData = [];
  for (var i = 0; i < ECG_WIDTH; i++) {
    ecgData.push(ECG_HEIGHT / 2);
  }
  ecgCursor = 0;
}

function updateEcgLine() {
  ecgCursor = (ecgCursor + 1) % ECG_WIDTH;
  ecgData[ecgCursor] = ECG_HEIGHT / 2;

  var points = "";
  for (var i = 0; i < ECG_WIDTH; i++) {
    var idx = (ecgCursor + 1 + i) % ECG_WIDTH;
    points += i + "," + ecgData[idx] + " ";
  }
  ecgPath.setAttribute("points", points.trim());
}

function addEcgSpike() {
  var baseY = ECG_HEIGHT / 2;
  var spike = [
    baseY - 5,   // P波
    baseY - 3,
    baseY,
    baseY + 10,  // Q波
    baseY - 35,  // R波 (大スパイク)
    baseY + 15,  // S波
    baseY,
    baseY - 3,   // T波
    baseY - 6,
    baseY - 4,
    baseY
  ];
  for (var i = 0; i < spike.length; i++) {
    var idx = (ecgCursor + i + 1) % ECG_WIDTH;
    ecgData[idx] = spike[i];
  }
  ecgCursor = (ecgCursor + spike.length) % ECG_WIDTH;
}

// ============================================================
// Visual Effects
// ============================================================
function flashBackground() {
  document.body.style.transition = "none";
  document.body.style.backgroundColor = "#1a0508";
  setTimeout(function () {
    document.body.style.transition = "background-color 0.5s ease";
    document.body.style.backgroundColor = "#0a0a0f";
  }, 60);
}

function pulseNameText() {
  nameEl.classList.remove("pulse");
  void nameEl.offsetWidth; // reflow
  nameEl.classList.add("pulse");
}

// ============================================================
// Animation Loop
// ============================================================
var animationRunning = false;

function startVisualLoop() {
  if (animationRunning) return;
  animationRunning = true;
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
  initEcg();
  requestAnimationFrame(animationLoop);
}

function animationLoop() {
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);

  // ambient particles
  if (particles.length < 30 && Math.random() < 0.08) {
    var cx = canvas.width / 2 + (Math.random() - 0.5) * 120;
    var cy = canvas.height / 2 + (Math.random() - 0.5) * 120;
    particles.push(new Particle(cx, cy, false));
  }

  for (var i = particles.length - 1; i >= 0; i--) {
    particles[i].update();
    particles[i].draw(ctx2d);
    if (particles[i].life <= 0) {
      particles.splice(i, 1);
    }
  }

  updateEcgLine();
  requestAnimationFrame(animationLoop);
}

// ============================================================
// Heartbeat Handler
// ============================================================
function onHeartbeat(beatCount) {
  // どの心拍でビジュアルが動いたか表示（シリアル #88 と対応）
  if (beatNumberEl) {
    beatNumberEl.textContent = beatCount != null ? "Heart Beat! #" + beatCount : "";
  }
  // 1. Universal haptics (Android vibrate + iOS 18 switch hack)
  triggerHaptic(60);
  // 2. WebAudio heartbeat sound
  playHeartbeatHaptic();
  // 3. ECG spike
  addEcgSpike();
  // 4. Particle burst
  emitParticleBurst();
  // 5. Name glow
  pulseNameText();
  // 6. Background flash
  flashBackground();
}

// ============================================================
// Start Overlay
// ============================================================
overlay.addEventListener("click", function () {
  unlockAudio();
  overlay.classList.add("hidden");
  startVisualLoop();
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

// /live/beat_timestamp — 心拍検知（M5Stack は { ts, count }、sender は数値のみ）
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

