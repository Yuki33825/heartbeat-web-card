import { initializeApp } from "firebase/app";
import { getDatabase, ref, set } from "firebase/database";
import { firebaseConfig } from "./firebaseConfig.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const heartbeatRef = ref(db, "live/heartbeat");

var heartIcon = document.getElementById("heart-icon");
var beatCountEl = document.getElementById("beat-count");
var pulseContainer = document.getElementById("pulse-container");
var beatCount = 0;

function spawnPulseRing(x, y) {
  var ring = document.createElement("div");
  ring.className = "pulse-ring";
  ring.style.left = x + "px";
  ring.style.top = y + "px";
  ring.style.width = "300px";
  ring.style.height = "300px";
  pulseContainer.appendChild(ring);
  ring.addEventListener("animationend", function () {
    ring.remove();
  });
}

document.body.addEventListener("click", function (e) {
  set(heartbeatRef, { timestamp: Date.now() })
    .then(function () {
      // Heart beat animation
      heartIcon.classList.add("beat");
      setTimeout(function () {
        heartIcon.classList.remove("beat");
      }, 150);

      // Pulse ring
      spawnPulseRing(e.clientX, e.clientY);

      // Counter
      beatCount++;
      beatCountEl.textContent = beatCount;

      // Vibrate on Android
      if (navigator.vibrate) {
        navigator.vibrate(50);
      }
    })
    .catch(function (err) {
      console.error("Firebase write error:", err);
    });
});
