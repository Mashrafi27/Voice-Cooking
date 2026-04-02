/* ═══════════════════════════════════════════════════
   Voice Kitchen — Client-Side Application
   ═══════════════════════════════════════════════════ */

"use strict";

// ── State ────────────────────────────────────────────
const state = {
  mode: "brainstorm",
  recipe: null,
  context: [],          // last 6 exchanges [{role, content}, ...]
  listening: false,
  processing: false,
  lastResponse: "",
  timerInterval: null,
  timerSeconds: 0,
  timerRunning: false,
};

// ── DOM References ───────────────────────────────────
const $ = (id) => document.getElementById(id);

const statusDot       = $("statusDot");
const tabBtns         = document.querySelectorAll(".tab-btn");
const panels          = document.querySelectorAll(".panel");
const micBtn          = $("micBtn");
const micLabel        = $("micLabel");
const transcriptBubble = $("transcriptBubble");
const errorToast      = $("errorToast");

// Brainstorm
const responseBrainstorm = $("response-brainstorm");

// Grocery
const responseGrocery    = $("response-grocery");
const recipeInput        = $("recipeInput");
const generateBtn        = $("generateBtn");

// Cooking
const stepDisplay        = $("stepDisplay");
const nextStepBtn        = $("nextStepBtn");
const repeatBtn          = $("repeatBtn");
const currentRecipeBadge = $("currentRecipeBadge");
const timerDisplay       = $("timerDisplay");
const timerMinutes       = $("timerMinutes");
const timerStartBtn      = $("timerStart");
const timerResetBtn      = $("timerReset");
const timerStatus        = $("timerStatus");

// ── Socket.IO ────────────────────────────────────────
const socket = io({ transports: ["websocket", "polling"] });

socket.on("connect", () => {
  statusDot.className = "status-dot connected";
  statusDot.title = "Connected";
});

socket.on("disconnect", () => {
  statusDot.className = "status-dot disconnected";
  statusDot.title = "Disconnected";
});

socket.on("connected", (data) => {
  console.log("Session started:", data.sid);
});

socket.on("mode_set", (data) => {
  console.log("Mode confirmed:", data.mode);
});

socket.on("recipe_set", (data) => {
  state.recipe = data.recipe;
  updateRecipeBadge();
});

// ── Token Streaming ──────────────────────────────────
let streamingEl = null;
let cursorEl    = null;

socket.on("token", (data) => {
  if (!streamingEl) return;
  // Remove placeholder on first token
  const placeholder = streamingEl.querySelector(".placeholder-text");
  if (placeholder) placeholder.remove();
  // Remove cursor, append text, re-add cursor
  if (cursorEl && cursorEl.parentNode) cursorEl.remove();
  streamingEl.appendChild(document.createTextNode(data.token));
  cursorEl = document.createElement("span");
  cursorEl.className = "cursor";
  streamingEl.appendChild(cursorEl);
  streamingEl.scrollTop = streamingEl.scrollHeight;
});

socket.on("done", (data) => {
  // Remove streaming cursor
  if (cursorEl && cursorEl.parentNode) cursorEl.remove();
  cursorEl = null;
  if (streamingEl) {
    streamingEl.classList.remove("streaming");
    streamingEl = null;
  }

  const response = data.response || "";
  state.lastResponse = response;

  // If in grocery mode, render as a checkable list
  if (state.mode === "grocery") {
    renderGroceryList(response);
  }

  // Update conversation context (keep last 12 messages = 6 exchanges)
  state.context.push({ role: "assistant", content: response });
  if (state.context.length > 12) state.context = state.context.slice(-12);

  setProcessing(false);
  speakResponse(response);

  // In cooking mode, auto-restart listening after TTS
  // (handled in speakResponse onend callback)
});

socket.on("error", (data) => {
  setProcessing(false);
  if (streamingEl) {
    streamingEl.classList.remove("streaming");
    streamingEl = null;
  }
  if (cursorEl && cursorEl.parentNode) cursorEl.remove();
  showError(data.message || "Something went wrong.");
});

// ── Tab Switching ────────────────────────────────────
tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode;
    switchMode(mode);
  });
});

function switchMode(mode) {
  state.mode = mode;
  state.context = []; // clear context on mode switch

  tabBtns.forEach((b) => {
    const active = b.dataset.mode === mode;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  });

  panels.forEach((p) => {
    p.classList.toggle("active", p.id === `panel-${mode}`);
  });

  socket.emit("set_mode", { mode });

  // Auto-restart listening in cooking mode when you switch to it
  if (mode === "cooking" && !state.listening && !state.processing) {
    setTimeout(() => startListening(), 600);
  }
}

// ── Mic Button ───────────────────────────────────────
let recognition = null;
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = "en-US";
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    state.listening = true;
    micBtn.classList.add("listening");
    micLabel.textContent = "Listening…";
  };

  recognition.onresult = (event) => {
    let interim = "";
    let final = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        final += transcript;
      } else {
        interim += transcript;
      }
    }
    const display = final || interim;
    showTranscript(display);
    if (final) {
      recognition.stop();
      handleUserText(final.trim());
    }
  };

  recognition.onerror = (event) => {
    state.listening = false;
    micBtn.classList.remove("listening");
    micLabel.textContent = "Tap to speak";
    hideTranscript();
    if (event.error !== "no-speech" && event.error !== "aborted") {
      showError(`Mic error: ${event.error}`);
    }
  };

  recognition.onend = () => {
    state.listening = false;
    micBtn.classList.remove("listening");
    if (!state.processing) {
      micLabel.textContent = "Tap to speak";
    }
    hideTranscript();
  };
} else {
  micBtn.disabled = true;
  micBtn.title = "Speech recognition not supported in this browser. Try Chrome.";
  micLabel.textContent = "Not supported";
}

micBtn.addEventListener("click", () => {
  if (state.processing) return;
  if (state.listening) {
    recognition && recognition.stop();
  } else {
    startListening();
  }
});

function startListening() {
  if (!recognition || state.listening || state.processing) return;
  try {
    recognition.start();
  } catch (e) {
    // Already started — ignore
  }
}

function showTranscript(text) {
  transcriptBubble.textContent = text;
  transcriptBubble.classList.add("visible");
}

function hideTranscript() {
  transcriptBubble.classList.remove("visible");
  setTimeout(() => { transcriptBubble.textContent = ""; }, 250);
}

// ── Sending Messages ─────────────────────────────────
function handleUserText(text) {
  if (!text) return;
  hideTranscript();

  // In grocery mode, treat voice input as recipe name if it looks like one
  if (state.mode === "grocery" && !text.includes("?") && text.split(" ").length <= 8) {
    recipeInput.value = text;
    generateGroceryList(text);
    return;
  }

  sendMessage(text);
}

function sendMessage(text) {
  if (!text || state.processing) return;

  // Optimistically add user message to context
  state.context.push({ role: "user", content: text });
  if (state.context.length > 12) state.context = state.context.slice(-12);

  setProcessing(true);
  prepareStreamTarget();

  socket.emit("message", {
    text,
    mode: state.mode,
    context: state.context.slice(-6), // last 6 messages
  });
}

function prepareStreamTarget() {
  if (state.mode === "brainstorm") {
    streamingEl = responseBrainstorm;
    streamingEl.textContent = "";
    streamingEl.classList.add("streaming");
  } else if (state.mode === "grocery") {
    streamingEl = responseGrocery;
    streamingEl.textContent = "";
    streamingEl.classList.add("streaming");
  } else if (state.mode === "cooking") {
    streamingEl = stepDisplay;
    streamingEl.textContent = "";
    streamingEl.classList.add("streaming");
  }
}

// ── Grocery List ─────────────────────────────────────
generateBtn.addEventListener("click", () => {
  const name = recipeInput.value.trim();
  if (!name) { showError("Enter a recipe name first."); return; }
  generateGroceryList(name);
});

recipeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const name = recipeInput.value.trim();
    if (name) generateGroceryList(name);
  }
});

function generateGroceryList(recipeName) {
  // Store the recipe server-side
  state.recipe = recipeName;
  socket.emit("set_recipe", { recipe: recipeName });
  updateRecipeBadge();

  // Clear context and generate
  state.context = [];
  sendMessage(`Generate a grocery list for: ${recipeName}`);
}

/**
 * Convert the raw markdown-ish text from Claude into a
 * proper checkable grocery list.
 */
function renderGroceryList(text) {
  responseGrocery.innerHTML = "";
  const lines = text.split("\n");
  let currentUl = null;

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Category header: lines that are bold (**text**) or all-caps or end with ":"
    const headerMatch = trimmed.match(/^\*\*(.+)\*\*:?$/) || trimmed.match(/^##?\s*(.+)$/);
    if (headerMatch || (trimmed.endsWith(":") && !trimmed.startsWith("-") && !trimmed.startsWith("•"))) {
      const h = document.createElement("strong");
      h.textContent = headerMatch ? headerMatch[1] : trimmed.replace(/:$/, "");
      responseGrocery.appendChild(h);
      currentUl = null;
      return;
    }

    // List item: lines starting with -, *, •, or a digit
    const itemMatch = trimmed.match(/^[-*•]\s+(.+)$/) || trimmed.match(/^\d+\.\s+(.+)$/);
    if (itemMatch) {
      if (!currentUl) {
        currentUl = document.createElement("ul");
        responseGrocery.appendChild(currentUl);
      }
      const li = document.createElement("li");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.setAttribute("aria-label", itemMatch[1]);
      const span = document.createElement("span");
      span.textContent = itemMatch[1];
      li.appendChild(cb);
      li.appendChild(span);

      cb.addEventListener("change", () => li.classList.toggle("checked", cb.checked));
      li.addEventListener("click", (e) => {
        if (e.target !== cb) { cb.checked = !cb.checked; li.classList.toggle("checked", cb.checked); }
      });

      currentUl.appendChild(li);
      return;
    }

    // Plain text fallback
    currentUl = null;
    const p = document.createElement("p");
    p.textContent = trimmed;
    p.style.marginBottom = "4px";
    responseGrocery.appendChild(p);
  });
}

// ── Cooking Panel ────────────────────────────────────
nextStepBtn.addEventListener("click", () => {
  if (state.processing) return;
  sendMessage("next step");
});

repeatBtn.addEventListener("click", () => {
  if (state.lastResponse) {
    speakResponse(state.lastResponse);
  }
});

function updateRecipeBadge() {
  if (state.recipe) {
    currentRecipeBadge.textContent = state.recipe;
    currentRecipeBadge.classList.add("has-recipe");
  } else {
    currentRecipeBadge.textContent = "No recipe selected";
    currentRecipeBadge.classList.remove("has-recipe");
  }
}

// ── Timer ────────────────────────────────────────────
timerStartBtn.addEventListener("click", toggleTimer);
timerResetBtn.addEventListener("click", resetTimer);

function toggleTimer() {
  if (state.timerRunning) {
    pauseTimer();
  } else {
    startTimer();
  }
}

function startTimer() {
  if (state.timerRunning) return;

  // If timer is at 0, load from input
  if (state.timerSeconds <= 0) {
    const mins = parseInt(timerMinutes.value, 10) || 0;
    if (mins <= 0) { showError("Set a timer duration first."); return; }
    state.timerSeconds = mins * 60;
  }

  state.timerRunning = true;
  timerStartBtn.textContent = "Pause";
  timerDisplay.classList.remove("done-blink", "warning");
  timerStatus.textContent = "Timer running";

  state.timerInterval = setInterval(() => {
    state.timerSeconds--;
    renderTimer();

    if (state.timerSeconds === 60) {
      timerStatus.textContent = "1 minute remaining";
      timerDisplay.classList.add("warning");
      speak("One minute remaining.");
    }
    if (state.timerSeconds === 30) {
      timerStatus.textContent = "30 seconds remaining";
      speak("Thirty seconds remaining.");
    }
    if (state.timerSeconds <= 0) {
      timerDone();
    }
  }, 1000);
}

function pauseTimer() {
  state.timerRunning = false;
  clearInterval(state.timerInterval);
  timerStartBtn.textContent = "Resume";
  timerStatus.textContent = "Paused";
}

function resetTimer() {
  state.timerRunning = false;
  clearInterval(state.timerInterval);
  state.timerSeconds = 0;
  timerDisplay.textContent = "00:00";
  timerDisplay.classList.remove("done-blink", "warning");
  timerStartBtn.textContent = "Start";
  timerStatus.textContent = "";
}

function timerDone() {
  state.timerRunning = false;
  clearInterval(state.timerInterval);
  state.timerSeconds = 0;
  timerDisplay.textContent = "00:00";
  timerDisplay.classList.remove("warning");
  timerDisplay.classList.add("done-blink");
  timerStartBtn.textContent = "Start";
  timerStatus.textContent = "Timer done!";
  speak("Timer done! Check your dish.");
}

function renderTimer() {
  const m = Math.floor(state.timerSeconds / 60).toString().padStart(2, "0");
  const s = (state.timerSeconds % 60).toString().padStart(2, "0");
  timerDisplay.textContent = `${m}:${s}`;
  if (state.timerSeconds <= 60 && state.timerSeconds > 0) {
    timerDisplay.classList.add("warning");
  }
}

// ── Text-to-Speech ───────────────────────────────────
let currentUtterance = null;

function speakResponse(text) {
  if (!text || !window.speechSynthesis) return;

  // Strip markdown symbols for cleaner TTS
  const clean = text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/#+\s/g, "")
    .replace(/[-•]\s/g, "")
    .replace(/\n+/g, ". ")
    .trim();

  speak(clean, () => {
    // Auto-restart listening in cooking mode after TTS finishes
    if (state.mode === "cooking" && !state.listening && !state.processing) {
      setTimeout(() => startListening(), 400);
    }
  });
}

function speak(text, onEnd) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate  = 0.9;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;

  // Pick a natural-sounding voice if available
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find(
    (v) => v.lang.startsWith("en") && /natural|neural|siri|google/i.test(v.name)
  ) || voices.find((v) => v.lang === "en-US") || voices[0];
  if (preferred) utterance.voice = preferred;

  if (onEnd) utterance.onend = onEnd;
  currentUtterance = utterance;
  window.speechSynthesis.speak(utterance);
}

// Voices may load asynchronously
if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
}

// ── UI Helpers ───────────────────────────────────────
function setProcessing(val) {
  state.processing = val;
  if (val) {
    micBtn.classList.add("processing");
    micLabel.textContent = "Thinking…";
    generateBtn.disabled = true;
  } else {
    micBtn.classList.remove("processing");
    micLabel.textContent = "Tap to speak";
    generateBtn.disabled = false;
  }
}

let toastTimer = null;
function showError(msg) {
  errorToast.textContent = msg;
  errorToast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => errorToast.classList.remove("show"), 4000);
}

// ── Keyboard Shortcut ────────────────────────────────
// Space bar = toggle mic (when not typing in an input)
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") {
    e.preventDefault();
    if (!state.processing) {
      if (state.listening) {
        recognition && recognition.stop();
      } else {
        startListening();
      }
    }
  }
});

// ── Initial Greeting ─────────────────────────────────
window.addEventListener("load", () => {
  // Small delay so voices are loaded
  setTimeout(() => {
    speak("Welcome to Voice Kitchen. What would you like to cook today?");
  }, 800);
});
