/* ============================================================
   Airmyplay Android Player — Native with Offline Media Cache
   Based on Web Player — adds Android bridge for local caching
   ============================================================ */

const API_BASE = "https://backend-production-2fbb.up.railway.app/api/v1";
const WS_BASE  = "https://backend-production-2fbb.up.railway.app";

// ---- Android Bridge Detection ----
const isAndroid = !!(window.AndroidBridge);

// ---- State ----
let token = null;
let monitorInfo = null;
let socket = null;
let playlist = [];
let schedules = [];
let currentIndex = 0;
let itemTimer = null;
let screensaverUrl = null;
let displaySchedule = null;
let audioVolume = 100;
let audioMuted = false;
let isScreensaver = false;
let isDisplayOff = false;
let playlistPollInterval = null;
let schedulePollInterval = null;
let clockInterval = null;
let hudTimeout = null;
let mediaCache = {}; // url -> localPath mapping
let devToolsOpen = false;
let devLogs = [];

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const loginScreen   = $("login-screen");
const playerScreen  = $("player-screen");
const loginForm     = $("login-form");
const inputBrand    = $("input-brand");
const inputBranch   = $("input-branch");
const inputCode     = $("input-code");
const loginError    = $("login-error");
const btnLogin      = $("btn-login");
const videoA        = $("video-a");
const videoB        = $("video-b");
const imageLayer    = $("image-layer");
const screensaverEl = $("screensaver");
const ssVideo       = $("screensaver-video");
const ssImage       = $("screensaver-image");
const ssDefault     = $("screensaver-default");
const ssClock       = $("ss-clock");
const displayOff    = $("display-off");
const loadingOverlay= $("loading-overlay");
const loadingDetail = $("loading-detail");
const deactivatedOverlay = $("deactivated-overlay");
const deactivatedMsg     = $("deactivated-msg");

// Active video (double-buffer)
let activeVideo = videoA;
let nextVideo = videoB;

// ============================================================
// MEDIA CACHING (Android Bridge)
// ============================================================
function getCachedUrl(url) {
  if (!isAndroid || !url) return url;
  const cached = AndroidBridge.getCachedPath(url);
  if (cached && cached !== "") return cached;
  return url;
}

async function cacheMediaFile(url) {
  if (!isAndroid || !url) return url;

  const cached = AndroidBridge.getCachedPath(url);
  if (cached && cached !== "") return cached;

  try {
    const localPath = AndroidBridge.downloadMedia(url);
    if (localPath && localPath !== "") return localPath;
  } catch (e) {
    console.warn("[Cache] Download failed:", url, e);
  }

  return url;
}

async function cachePlaylistMedia(items) {
  if (!isAndroid || !items || items.length === 0) return;

  loadingDetail.textContent = "Media faylları yüklənir...";

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    loadingDetail.textContent = `Media yüklənir (${i + 1}/${items.length}): ${item.name || ''}`;

    try {
      const localUrl = await cacheMediaFile(item.url);
      if (localUrl !== item.url) {
        item.cachedUrl = localUrl;
      }
    } catch (e) {
      console.warn("[Cache] Failed to cache:", item.name, e);
    }
  }

  loadingDetail.textContent = "";
}

function getMediaUrl(item) {
  if (item.cachedUrl) return item.cachedUrl;
  if (isAndroid) {
    const cached = getCachedUrl(item.url);
    if (cached !== item.url) {
      item.cachedUrl = cached;
      return cached;
    }
  }
  return item.url;
}

function getCacheStats() {
  if (!isAndroid) return null;
  try {
    return AndroidBridge.getCacheStats();
  } catch (e) {
    return null;
  }
}

// ============================================================
// STORAGE
// ============================================================
function saveCredentials(brand, branch, code) {
  localStorage.setItem("awp_cred", JSON.stringify({ brand, branch, code }));
}
function loadCredentials() {
  try { return JSON.parse(localStorage.getItem("awp_cred")); } catch { return null; }
}
function clearCredentials() {
  localStorage.removeItem("awp_cred");
  localStorage.removeItem("awp_state");
}
function saveState() {
  localStorage.setItem("awp_state", JSON.stringify({
    token, monitorInfo, schedules, screensaverUrl, displaySchedule, audioVolume, audioMuted
  }));
}
function loadState() {
  try { return JSON.parse(localStorage.getItem("awp_state")); } catch { return null; }
}

// ============================================================
// LOGIN
// ============================================================
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await doLogin(
    inputBrand.value.trim().toLowerCase().replace(/\s/g, ""),
    inputBranch.value.trim().toLowerCase().replace(/\s/g, ""),
    inputCode.value.trim().toUpperCase(),
    false
  );
});

// Auto-format inputs: brand & branch → lowercase, no spaces
inputBrand.addEventListener("input", () => {
  inputBrand.value = inputBrand.value.toLowerCase().replace(/\s/g, "");
});
inputBranch.addEventListener("input", () => {
  inputBranch.value = inputBranch.value.toLowerCase().replace(/\s/g, "");
});
// Auto-uppercase monitor code
inputCode.addEventListener("input", () => {
  inputCode.value = inputCode.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});

async function doLogin(brand, branch, code, reconnect = false) {
  loginError.classList.add("hidden");
  btnLogin.disabled = true;
  btnLogin.querySelector(".btn-text").textContent = "Giriş edilir...";
  btnLogin.querySelector(".btn-loader").classList.remove("hidden");

  try {
    const res = await fetch(`${API_BASE}/device/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brandName: brand, branchId: branch, monitorCode: code, reconnect }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || "Giriş uğursuz oldu");
    }

    const data = await res.json();
    token = data.accessToken;
    monitorInfo = data.monitor;
    saveCredentials(brand, branch, code);
    saveState();
    enterPlayer();
  } catch (err) {
    // If reconnecting offline, enter player silently (screensaver if no schedules)
    if (reconnect) {
      devLog("Reconnect failed, entering offline mode");
      enterPlayer();
      return;
    }
    loginError.textContent = err.message || "Giriş uğursuz oldu";
    loginError.classList.remove("hidden");
  } finally {
    btnLogin.disabled = false;
    btnLogin.querySelector(".btn-text").textContent = "Giriş";
    btnLogin.querySelector(".btn-loader").classList.add("hidden");
  }
}

// ============================================================
// PLAYER ENTRY
// ============================================================
function enterPlayer() {
  loginScreen.classList.remove("active");
  playerScreen.classList.add("active");
  loadingOverlay.classList.remove("hidden");
  loadingDetail.textContent = "Playlist yüklənir...";

  connectSocket();
  loadPlaylist();
  startPolling();
  startClockUpdate();
}

// ============================================================
// WEBSOCKET
// ============================================================
function connectSocket() {
  if (socket) socket.disconnect();

  socket = io(WS_BASE, {
    path: "/socket.io",
    transports: ["websocket", "polling"],
    auth: { token },
    query: { namespace: "device" },
  });

  // Try /device namespace
  if (socket.nsp !== "/device") {
    socket.disconnect();
    socket = io(`${WS_BASE}/device`, {
      transports: ["websocket", "polling"],
      auth: { token },
    });
  }

  socket.on("connect", () => {
    devLog("[WS] Connected");
    socket.emit("register", { monitorId: monitorInfo.id, token });
  });

  socket.on("disconnect", () => {
    devLog("[WS] Disconnected");
  });

  socket.on("playlist_update", () => {
    console.log("[WS] playlist_update");
    loadPlaylist();
  });

  socket.on("audio_update", (data) => {
    console.log("[WS] audio_update", data);
    if (data.volume !== undefined) audioVolume = data.volume;
    if (data.muted !== undefined) audioMuted = data.muted;
    applyAudio();
    saveState();
  });

  socket.on("force_logout", () => {
    console.log("[WS] force_logout");
    doLogout();
  });

  socket.on("screensaver_update", (data) => {
    screensaverUrl = data.url || null;
    // Cache screensaver if on Android
    if (isAndroid && screensaverUrl) {
      cacheMediaFile(screensaverUrl).then(() => {});
    }
    saveState();
    if (isScreensaver) showScreensaver();
  });

  socket.on("display_schedule_update", (data) => {
    displaySchedule = data;
    saveState();
    checkDisplaySchedule();
  });

  socket.on("force_deactivate", (data) => {
    deactivatedMsg.textContent = data.message || "";
    deactivatedOverlay.classList.remove("hidden");
  });

  socket.on("venue_activated", () => {
    deactivatedOverlay.classList.add("hidden");
    loadPlaylist();
  });
}

// ============================================================
// PLAYLIST LOADING
// ============================================================
async function loadPlaylist() {
  if (!token || !monitorInfo) return;

  try {
    const res = await fetch(`${API_BASE}/device/${monitorInfo.id}/playlist`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401) { doLogout(); return; }
    if (!res.ok) return;

    const data = await res.json();

    // Audio
    if (data.audio) {
      audioVolume = data.audio.volume ?? 100;
      audioMuted = data.audio.muted ?? false;
      applyAudio();
    }

    // Screensaver
    if (data.screensaverUrl !== undefined) {
      screensaverUrl = data.screensaverUrl;
      // Cache screensaver
      if (isAndroid && screensaverUrl) {
        cacheMediaFile(screensaverUrl).then(() => {});
      }
    }

    // Display schedule
    if (data.displaySchedule) displaySchedule = data.displaySchedule;

    // Schedules (new format) or items (legacy)
    if (data.schedules && data.schedules.length > 0) {
      schedules = data.schedules;
      devLog(`Loaded ${schedules.length} schedule(s): ${schedules.map(s => s.name || s.id).join(", ")}`);
      schedules.forEach(s => {
        devLog(`  Schedule "${s.name}": ${s.items?.length || 0} items, days=${JSON.stringify(s.daysOfWeek)}, time=${s.startTime}-${s.endTime}`);
      });
    } else if (data.items && data.items.length > 0) {
      schedules = [{ id: "legacy", name: "Default", items: data.items }];
      devLog(`Loaded legacy playlist: ${data.items.length} items`);
    } else {
      schedules = [];
      devLog("No schedules or items received");
    }

    // Cache all media files on Android
    if (isAndroid) {
      for (const sched of schedules) {
        if (sched.items && sched.items.length > 0) {
          await cachePlaylistMedia(sched.items);
        }
      }
    }

    saveState();
    checkScheduleAndPlay();
    checkDisplaySchedule();

    // Hide loading overlay
    loadingOverlay.classList.add("hidden");

  } catch (err) {
    console.error("[Playlist] Error:", err);
    // On Android, try to play from cache if offline
    if (isAndroid && schedules.length > 0) {
      loadingOverlay.classList.add("hidden");
      checkScheduleAndPlay();
    }
  }
}

// ============================================================
// SCHEDULE LOGIC
// ============================================================
function getActiveSchedule() {
  const now = new Date();
  const currentDay = now.getDay() === 0 ? 7 : now.getDay(); // ISO: 1=Mon, 7=Sun
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const todayStr = now.toISOString().split("T")[0];

  for (const sched of schedules) {
    // Check date range
    if (sched.startDate && todayStr < sched.startDate.split("T")[0]) continue;
    if (sched.endDate && todayStr > sched.endDate.split("T")[0]) continue;

    // Check days of week
    if (sched.daysOfWeek && sched.daysOfWeek.length > 0 && !sched.daysOfWeek.includes(currentDay)) continue;

    // Check time range
    if (sched.startTime && sched.endTime) {
      const [sh, sm] = sched.startTime.split(":").map(Number);
      const [eh, em] = sched.endTime.split(":").map(Number);
      const start = sh * 60 + sm;
      const end = eh * 60 + em;

      if (start <= end) {
        if (currentMinutes < start || currentMinutes >= end) continue;
      } else {
        // Overnight: e.g., 22:00 - 06:00
        if (currentMinutes < start && currentMinutes >= end) continue;
      }
    }

    // This schedule is active
    if (sched.items && sched.items.length > 0) return sched;
  }

  return null;
}

function checkScheduleAndPlay() {
  const active = getActiveSchedule();

  if (!active) {
    if (!isScreensaver) {
      devLog("No active schedule → screensaver");
      stopPlayback();
      showScreensaver();
    }
    return;
  }
  devLog(`Active schedule: "${active.name}" with ${active.items.length} items`);

  // Active schedule found
  const newItems = active.items;
  const oldIds = playlist.map((i) => i.id).join(",");
  const newIds = newItems.map((i) => i.id).join(",");

  if (oldIds !== newIds) {
    // Playlist changed
    playlist = newItems;
    currentIndex = 0;
    hideScreensaver();
    preloadAndPlay();
  } else if (isScreensaver) {
    // Same playlist but was showing screensaver
    playlist = newItems;
    hideScreensaver();
    preloadAndPlay();
  }
}

// ============================================================
// MEDIA PLAYBACK — Double Buffer
// ============================================================
function preloadAndPlay() {
  if (playlist.length === 0) { showScreensaver(); return; }
  if (isDisplayOff) return;

  const item = playlist[currentIndex];
  devLog(`Playing: ${item.name || "?"} (${item.type})`);

  if (item.type === "VIDEO") {
    playVideo(item);
  } else {
    playImage(item);
  }
}

function playVideo(item) {
  // Hide image
  imageLayer.classList.add("hidden");

  const url = getMediaUrl(item);

  // Setup active video
  activeVideo.src = url;
  activeVideo.currentTime = 0;
  activeVideo.muted = audioMuted;
  activeVideo.volume = audioVolume / 100;
  activeVideo.classList.remove("hidden");
  activeVideo.style.zIndex = 10;

  // Preload next
  preloadNext();

  const playPromise = activeVideo.play();
  if (playPromise) playPromise.catch(() => {
    // Autoplay blocked — try muted
    activeVideo.muted = true;
    activeVideo.play().catch(() => {});
  });

  // Use item duration or video end
  const duration = (item.duration || 30) * 1000;

  activeVideo.onended = () => { advanceToNext(); };
  activeVideo.onerror = () => {
    console.warn("[Video] Error playing:", item.name);
    clearTimeout(itemTimer);
    itemTimer = setTimeout(advanceToNext, 3000);
  };

  // Fallback timer (in case onended doesn't fire)
  clearTimeout(itemTimer);
  itemTimer = setTimeout(() => {
    activeVideo.pause();
    advanceToNext();
  }, duration + 2000);
}

function playImage(item) {
  // Hide videos
  activeVideo.classList.add("hidden");
  nextVideo.classList.add("hidden");
  activeVideo.pause();
  nextVideo.pause();

  const url = getMediaUrl(item);

  imageLayer.src = url;
  imageLayer.classList.remove("hidden");
  imageLayer.style.zIndex = 10;

  // Preload next
  preloadNext();

  const duration = (item.duration || 10) * 1000;
  clearTimeout(itemTimer);
  itemTimer = setTimeout(advanceToNext, duration);
}

function preloadNext() {
  const nextIndex = (currentIndex + 1) % playlist.length;
  const nextItem = playlist[nextIndex];
  const url = getMediaUrl(nextItem);

  if (nextItem.type === "VIDEO") {
    nextVideo.src = url;
    nextVideo.preload = "auto";
    nextVideo.load();
  } else {
    // Preload image
    const img = new Image();
    img.src = url;
  }
}

function advanceToNext() {
  clearTimeout(itemTimer);

  // Swap video buffers
  const tmp = activeVideo;
  activeVideo = nextVideo;
  nextVideo = tmp;
  nextVideo.classList.add("hidden");
  nextVideo.style.zIndex = 1;
  nextVideo.pause();

  currentIndex = (currentIndex + 1) % playlist.length;
  preloadAndPlay();
}

function stopPlayback() {
  clearTimeout(itemTimer);
  activeVideo.pause();
  nextVideo.pause();
  activeVideo.classList.add("hidden");
  nextVideo.classList.add("hidden");
  imageLayer.classList.add("hidden");
}

// ============================================================
// SCREENSAVER
// ============================================================
function showScreensaver() {
  isScreensaver = true;
  stopPlayback();
  screensaverEl.classList.remove("hidden");
  screensaverEl.style.zIndex = 20;

  ssVideo.classList.add("hidden");
  ssImage.classList.add("hidden");
  ssDefault.classList.add("hidden");

  if (screensaverUrl) {
    const ssUrl = isAndroid ? getCachedUrl(screensaverUrl) : screensaverUrl;
    const isVideo = /\.(mp4|webm|ogg|mov)(\?|$)/i.test(screensaverUrl);
    if (isVideo) {
      ssVideo.src = ssUrl;
      ssVideo.classList.remove("hidden");
      ssVideo.play().catch(() => { ssVideo.muted = true; ssVideo.play().catch(() => {}); });
    } else {
      ssImage.src = ssUrl;
      ssImage.classList.remove("hidden");
    }
  } else {
    ssDefault.classList.remove("hidden");
  }
}

function hideScreensaver() {
  isScreensaver = false;
  screensaverEl.classList.add("hidden");
  ssVideo.pause();
}

// ============================================================
// DISPLAY ON/OFF SCHEDULE
// ============================================================
function checkDisplaySchedule() {
  if (!displaySchedule || !displaySchedule.onTime || !displaySchedule.offTime) {
    if (isDisplayOff) {
      isDisplayOff = false;
      displayOff.classList.add("hidden");
      checkScheduleAndPlay();
    }
    return;
  }

  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const [oh, om] = displaySchedule.onTime.split(":").map(Number);
  const [fh, fm] = displaySchedule.offTime.split(":").map(Number);
  const onMins = oh * 60 + om;
  const offMins = fh * 60 + fm;

  let shouldBeOn;
  if (onMins <= offMins) {
    shouldBeOn = mins >= onMins && mins < offMins;
  } else {
    shouldBeOn = mins >= onMins || mins < offMins;
  }

  if (!shouldBeOn && !isDisplayOff) {
    isDisplayOff = true;
    stopPlayback();
    hideScreensaver();
    displayOff.classList.remove("hidden");
  } else if (shouldBeOn && isDisplayOff) {
    isDisplayOff = false;
    displayOff.classList.add("hidden");
    checkScheduleAndPlay();
  }
}

// ============================================================
// AUDIO
// ============================================================
function applyAudio() {
  [videoA, videoB, ssVideo].forEach((v) => {
    v.volume = audioVolume / 100;
    v.muted = audioMuted;
  });
}

// ============================================================
// HEARTBEAT
// ============================================================
async function sendHeartbeat() {
  if (!token || !monitorInfo) return;
  try {
    const ver = isAndroid ? AndroidBridge.getAppVersion() : "1.0.0";
    const platform = isAndroid ? "android" : "web";
    const body = {
      appVersion: `${platform}-${ver}`,
      nowPlaying: playlist[currentIndex]?.name || null,
    };

    await fetch(`${API_BASE}/device/${monitorInfo.id}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {}
}

// ============================================================
// DEV LOG
// ============================================================
function devLog(msg) {
  const ts = new Date().toLocaleTimeString("az-AZ", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const entry = `[${ts}] ${msg}`;
  console.log(entry);
  devLogs.push(entry);
  if (devLogs.length > 200) devLogs.shift();
  // Update dev panel if open
  const logEl = document.getElementById("dev-logs");
  if (logEl) {
    logEl.textContent = devLogs.slice(-50).join("\n");
    logEl.scrollTop = logEl.scrollHeight;
  }
}

// ============================================================
// DEV TOOLS PANEL (long press 5s to open)
// ============================================================
function createDevTools() {
  if (document.getElementById("dev-panel")) return;

  const panel = document.createElement("div");
  panel.id = "dev-panel";
  panel.style.cssText = `
    position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.95);
    color:#fff;font-family:monospace;font-size:12px;overflow-y:auto;padding:16px;
    display:flex;flex-direction:column;gap:12px;
  `;

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2 style="margin:0;font-size:16px;color:#10b981">Dev Tools — Airmyplay Android</h2>
      <button id="dev-close" style="background:#ef4444;border:none;color:#fff;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:13px">Bağla</button>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div style="background:#1a1a2e;padding:10px;border-radius:8px">
        <div style="color:#6b7280;font-size:10px">Status</div>
        <div id="dev-status" style="color:#10b981;font-size:14px">--</div>
      </div>
      <div style="background:#1a1a2e;padding:10px;border-radius:8px">
        <div style="color:#6b7280;font-size:10px">WebSocket</div>
        <div id="dev-ws" style="font-size:14px">--</div>
      </div>
      <div style="background:#1a1a2e;padding:10px;border-radius:8px">
        <div style="color:#6b7280;font-size:10px">Monitor</div>
        <div id="dev-monitor" style="font-size:14px">--</div>
      </div>
      <div style="background:#1a1a2e;padding:10px;border-radius:8px">
        <div style="color:#6b7280;font-size:10px">Version</div>
        <div id="dev-version" style="font-size:14px">--</div>
      </div>
      <div style="background:#1a1a2e;padding:10px;border-radius:8px">
        <div style="color:#6b7280;font-size:10px">Schedules</div>
        <div id="dev-schedules" style="font-size:14px">--</div>
      </div>
      <div style="background:#1a1a2e;padding:10px;border-radius:8px">
        <div style="color:#6b7280;font-size:10px">Playlist</div>
        <div id="dev-playlist" style="font-size:14px">--</div>
      </div>
      <div style="background:#1a1a2e;padding:10px;border-radius:8px;grid-column:span 2">
        <div style="color:#6b7280;font-size:10px">Media Cache</div>
        <div id="dev-cache" style="font-size:14px">--</div>
      </div>
    </div>

    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button id="dev-clear-cache" style="background:#6E55FF;border:none;color:#fff;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px">Keşi Təmizlə</button>
      <button id="dev-reload-playlist" style="background:#6E55FF;border:none;color:#fff;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px">Playlist Yenilə</button>
      <button id="dev-show-files" style="background:#6E55FF;border:none;color:#fff;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px">Keş Faylları</button>
      <button id="dev-logout" style="background:#ef4444;border:none;color:#fff;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px">Çıxış</button>
    </div>

    <div id="dev-files-section" style="display:none">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <div style="color:#6b7280;font-size:10px">Keş Qovluğu</div>
        <div id="dev-cache-path" style="color:#6b7280;font-size:9px;font-family:monospace"></div>
      </div>
      <div id="dev-file-list" style="background:#0a0a14;padding:10px;border-radius:8px;overflow-y:auto;max-height:200px;font-size:11px"></div>
    </div>

    <div style="flex:1;min-height:0">
      <div style="color:#6b7280;font-size:10px;margin-bottom:4px">Loglar</div>
      <pre id="dev-logs" style="background:#0a0a14;padding:10px;border-radius:8px;overflow-y:auto;max-height:300px;white-space:pre-wrap;word-break:break-all;font-size:11px;color:#d1d5db;margin:0"></pre>
    </div>
  `;

  document.body.appendChild(panel);

  // Buttons
  document.getElementById("dev-close").onclick = () => { panel.remove(); devToolsOpen = false; };
  document.getElementById("dev-clear-cache").onclick = () => {
    if (isAndroid) { AndroidBridge.clearCache(); devLog("Cache cleared"); }
    updateDevStats();
  };
  document.getElementById("dev-reload-playlist").onclick = () => { loadPlaylist(); devLog("Playlist reload triggered"); };
  document.getElementById("dev-show-files").onclick = () => {
    const section = document.getElementById("dev-files-section");
    if (section.style.display === "none") {
      section.style.display = "block";
      showCacheFiles();
    } else {
      section.style.display = "none";
    }
  };
  document.getElementById("dev-logout").onclick = () => { panel.remove(); devToolsOpen = false; doLogout(); };

  devToolsOpen = true;
  updateDevStats();

  // Show logs
  document.getElementById("dev-logs").textContent = devLogs.slice(-50).join("\n");
}

function updateDevStats() {
  const el = (id) => document.getElementById(id);
  if (!el("dev-panel")) return;

  el("dev-status").textContent = token ? "Online" : "Offline";
  el("dev-status").style.color = token ? "#10b981" : "#ef4444";

  const wsConnected = socket && socket.connected;
  el("dev-ws").textContent = wsConnected ? "Bağlı" : "Kəsilib";
  el("dev-ws").style.color = wsConnected ? "#10b981" : "#ef4444";

  el("dev-monitor").textContent = monitorInfo ? `${monitorInfo.name || ""} (${monitorInfo.deviceKey || ""})` : "N/A";

  const ver = isAndroid ? AndroidBridge.getAppVersion() : "web";
  el("dev-version").textContent = `${isAndroid ? "Android" : "Web"} v${ver}`;

  el("dev-schedules").textContent = `${schedules.length} cədvəl`;
  el("dev-playlist").textContent = `${playlist.length} media, index: ${currentIndex}`;

  if (isAndroid) {
    try {
      const stats = JSON.parse(AndroidBridge.getCacheStats());
      el("dev-cache").textContent = `${stats.files || 0} fayl, ${stats.totalSizeMB || 0} MB`;
    } catch { el("dev-cache").textContent = "N/A"; }
  } else {
    el("dev-cache").textContent = "Yalnız Android";
  }
}

function showCacheFiles() {
  const listEl = document.getElementById("dev-file-list");
  const pathEl = document.getElementById("dev-cache-path");
  if (!isAndroid) {
    listEl.innerHTML = '<div style="color:#6b7280">Yalnız Android-də mövcuddur</div>';
    return;
  }
  try {
    pathEl.textContent = AndroidBridge.getCachePath();
    const files = JSON.parse(AndroidBridge.listCacheFiles());
    if (files.length === 0) {
      listEl.innerHTML = '<div style="color:#6b7280">Keşdə fayl yoxdur</div>';
      return;
    }
    listEl.innerHTML = files.map((f, i) => {
      const extColor = f.ext.match(/mp4|webm|mov|ogg/) ? "#3b82f6" : "#10b981";
      return `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1a1a2e">
        <span style="color:#d1d5db;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%">${i+1}. ${f.name}</span>
        <span style="display:flex;gap:8px;flex-shrink:0">
          <span style="color:${extColor};text-transform:uppercase;font-size:10px">${f.ext}</span>
          <span style="color:#6b7280">${f.size}</span>
        </span>
      </div>`;
    }).join("");
  } catch (e) {
    listEl.innerHTML = `<div style="color:#ef4444">Xəta: ${e.message}</div>`;
  }
}

// Triple-tap to open dev tools (3 taps within 1.5s)
let tapCount = 0;
let tapTimer = null;

function handleDevTap() {
  if (devToolsOpen) return;
  tapCount++;
  if (tapCount === 1) {
    tapTimer = setTimeout(() => { tapCount = 0; }, 1500);
  }
  if (tapCount >= 3) {
    clearTimeout(tapTimer);
    tapCount = 0;
    createDevTools();
  }
}

document.addEventListener("touchend", (e) => { handleDevTap(); }, { passive: true });
// Also support mouse (for testing on desktop)
document.addEventListener("dblclick", () => { createDevTools(); });

// Update dev stats every 5s if open
setInterval(() => { if (devToolsOpen) updateDevStats(); }, 5000);

// ============================================================
// CLOCK (Screensaver)
// ============================================================
function startClockUpdate() {
  if (clockInterval) clearInterval(clockInterval);
  const update = () => {
    ssClock.textContent = new Date().toLocaleTimeString("az-AZ", { hour: "2-digit", minute: "2-digit", hour12: false });
  };
  update();
  clockInterval = setInterval(update, 1000);
}

// ============================================================
// POLLING
// ============================================================
function startPolling() {
  if (playlistPollInterval) clearInterval(playlistPollInterval);
  if (schedulePollInterval) clearInterval(schedulePollInterval);

  // Reload playlist every 30s
  playlistPollInterval = setInterval(loadPlaylist, 30000);

  // Check schedule every 15s
  schedulePollInterval = setInterval(() => {
    checkScheduleAndPlay();
    checkDisplaySchedule();
  }, 15000);

  // Heartbeat every 30s
  setInterval(sendHeartbeat, 30000);
}

// ============================================================
// LOGOUT
// ============================================================
function doLogout() {
  // Notify server
  if (token && monitorInfo) {
    fetch(`${API_BASE}/device/${monitorInfo.id}/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }

  // Cleanup
  if (socket) socket.disconnect();
  clearInterval(playlistPollInterval);
  clearInterval(schedulePollInterval);
  clearTimeout(itemTimer);
  stopPlayback();
  hideScreensaver();

  token = null;
  monitorInfo = null;
  playlist = [];
  schedules = [];
  currentIndex = 0;
  clearCredentials();

  // Show login
  playerScreen.classList.remove("active");
  loginScreen.classList.add("active");
  loginError.classList.add("hidden");
  loadingOverlay.classList.remove("hidden");
  deactivatedOverlay.classList.add("hidden");
}

// ============================================================
// INIT — Auto-login if credentials saved
// ============================================================
(function init() {
  const cred = loadCredentials();
  const state = loadState();

  if (cred && state && state.token && state.monitorInfo) {
    // Restore state
    token = state.token;
    monitorInfo = state.monitorInfo;
    schedules = state.schedules || [];
    screensaverUrl = state.screensaverUrl || null;
    displaySchedule = state.displaySchedule || null;
    audioVolume = state.audioVolume ?? 100;
    audioMuted = state.audioMuted ?? false;

    // Try reconnect login — if fails (offline), use cached data
    doLogin(cred.brand, cred.branch, cred.code, true).catch(() => {
      devLog("Login failed (offline?) — using cached data");
      // Enter player even without schedules — will show screensaver
      enterPlayer();
    });
  }
})();
