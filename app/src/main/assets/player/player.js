/* ============================================================
   Airmyplay Android Player — Native with Offline Media Cache
   Based on Web Player — adds Android bridge for local caching
   ============================================================ */

var API_BASE = "https://backend-production-2fbb.up.railway.app/api/v1";
var WS_BASE  = "https://backend-production-2fbb.up.railway.app";

// ---- Android Bridge Detection ----
var isAndroid = !!(window.AndroidBridge);

// ---- State ----
var token = null;
var monitorInfo = null;
var socket = null;
var playlist = [];
var schedules = [];
var currentIndex = 0;
var itemTimer = null;
var screensaverUrl = null;
var displaySchedule = null;
var displaySettings = null;
var audioVolume = 100;
var audioMuted = false;
var isScreensaver = false;
var isDisplayOff = false;
var playlistPollInterval = null;
var schedulePollInterval = null;
var clockInterval = null;
var hudTimeout = null;
var mediaCache = {}; // url -> localPath mapping
var devToolsOpen = false;
var devLogs = [];
var bandwidthConfig = null; // [{startTime, endTime, maxMBps}]
var recentlyPlayedIds = []; // for shuffle no-repeat tracking
var cinemaAlertConfig = null;
var cinemaAlertTimers = [];
var cacheAbortFlag = false; // yeni playlist gələndə köhnə cache-i dayandır

// Offline limit (3 days) — anti-fraud: customer can't disconnect to avoid subscription check
var OFFLINE_LIMIT_MS = 72 * 60 * 60 * 1000; // 3 days
var serverOnline = false;
var offlineCheckInterval = null;

// ---- DOM ----
var $ = function(id) { return document.getElementById(id); };
var loginScreen   = $("login-screen");
var playerScreen  = $("player-screen");
var loginForm     = $("login-form");
var inputCode     = $("input-code");
var loginError    = $("login-error");
var btnLogin      = $("btn-login");
var videoA        = $("video-a");
var videoB        = $("video-b");
var imageLayer    = $("image-layer");
var webLayer      = $("web-layer");
var screensaverEl = $("screensaver");
var ssVideo       = $("screensaver-video");
var ssImage       = $("screensaver-image");
var ssDefault     = $("screensaver-default");
var ssClock       = $("ss-clock");
var displayOff    = $("display-off");
var loadingOverlay= $("loading-overlay");
var loadingDetail = $("loading-detail");
var deactivatedOverlay = $("deactivated-overlay");
var deactivatedMsg     = $("deactivated-msg");

// Active video (double-buffer)
var activeVideo = videoA;
var nextVideo = videoB;

// ============================================================
// MEDIA CACHING (Android Bridge)
// ============================================================
function getCachedUrl(url) {
  if (!isAndroid || !url) return url;
  var cached = AndroidBridge.getCachedPath(url);
  if (cached && cached !== "") return cached;
  return url;
}

async function cacheMediaFile(url) {
  if (!isAndroid || !url) return url;

  var cached = AndroidBridge.getCachedPath(url);
  if (cached && cached !== "") return cached;

  try {
    var localPath = AndroidBridge.downloadMedia(url);
    if (localPath && localPath !== "") return localPath;
  } catch (e) {
    console.warn("[Cache] Download failed:", url, e);
  }

  return url;
}

async function cachePlaylistMedia(items) {
  if (!isAndroid || !items || items.length === 0) return;

  for (var i = 0; i < items.length; i++) {
    if (cacheAbortFlag) {
      devLog("INFO", "Cache dayandırıldı — yeni playlist gəldi");
      break;
    }
    var item = items[i];
    try {
      var localUrl = await cacheMediaFile(item.url);
      if (localUrl !== item.url) {
        item.cachedUrl = localUrl;
      }
    } catch (e) {
      console.warn("[Cache] Failed to cache:", item.name, e);
    }
  }

  cacheAbortFlag = false;
  loadingDetail.textContent = "";
}

function getMediaUrl(item) {
  if (item.cachedUrl) return item.cachedUrl;
  if (isAndroid) {
    var cached = getCachedUrl(item.url);
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
// SHUFFLE
// ============================================================
function shuffleArray(arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function applyShuffleToSchedule(sched) {
  if (!sched.shuffle || !sched.items || sched.items.length <= 1) return sched;
  var shuffled = shuffleArray(sched.items);
  var noRepeat = sched.noRepeatCount || 0;
  if (noRepeat > 0 && recentlyPlayedIds.length > 0) {
    // Move recently played items away from the start
    var recent = new Set(recentlyPlayedIds.slice(-noRepeat));
    var front = shuffled.filter(function(i) { return !recent.has(i.mediaId || i.id); });
    var back = shuffled.filter(function(i) { return recent.has(i.mediaId || i.id); });
    shuffled = front.concat(back);
  }
  var result = Object.assign({}, sched);
  result.items = shuffled;
  return result;
}

function trackPlayed(item) {
  if (!item) return;
  var id = item.mediaId || item.id;
  if (!id) return;
  recentlyPlayedIds.push(id);
  if (recentlyPlayedIds.length > 50) recentlyPlayedIds.shift();
}

// ============================================================
// INVENTORY REPORTING
// ============================================================
function reportInventory() {
  if (!isAndroid || !socket || !monitorInfo) return;
  try {
    var filesJson = AndroidBridge.listCacheFiles();
    var files = typeof filesJson === "string" ? JSON.parse(filesJson) : filesJson;
    if (Array.isArray(files) && files.length > 0) {
      socket.emit("inventory_update", {
        monitorId: monitorInfo.id,
        files: files.map(function(f) { return {
          fileName: f.name || f.fileName,
          fileSize: parseFloat((f.size || f.fileSize || "0").toString()) || 0,
          mediaId: f.mediaId || null
        }; }),
      });
    }
  } catch (e) {
    console.warn("[Inventory] Failed to report:", e);
  }
}

// ============================================================
// BANDWIDTH CHECK
// ============================================================
function isBandwidthThrottled() {
  if (!bandwidthConfig || !Array.isArray(bandwidthConfig) || bandwidthConfig.length === 0) return false;
  var now = new Date();
  var curMin = now.getHours() * 60 + now.getMinutes();
  for (var rule of bandwidthConfig) {
    var [sh, sm] = (rule.startTime || "00:00").split(":").map(Number);
    var [eh, em] = (rule.endTime || "23:59").split(":").map(Number);
    var start = sh * 60 + sm;
    var end = eh * 60 + em;
    if (curMin >= start && curMin < end) return true;
  }
  return false;
}

// ============================================================
// STORAGE
// ============================================================
function saveDeviceToken(deviceToken) {
  localStorage.setItem("awp_device_token", deviceToken);
}
function loadDeviceToken() {
  return localStorage.getItem("awp_device_token") || null;
}
function clearDeviceToken() {
  localStorage.removeItem("awp_device_token");
  localStorage.removeItem("awp_state");
}
function saveState() {
  localStorage.setItem("awp_state", JSON.stringify({
    token, monitorInfo, schedules, screensaverUrl, displaySchedule, audioVolume, audioMuted, displaySettings
  }));
}
function loadState() {
  try { return JSON.parse(localStorage.getItem("awp_state")); } catch { return null; }
}

// ============================================================
// OFFLINE LIMIT (3 days) — anti-fraud
// ============================================================
function saveLastOnlineTime() {
  localStorage.setItem("awp_last_online", Date.now().toString());
}

function getLastOnlineTime() {
  var t = localStorage.getItem("awp_last_online");
  return t ? parseInt(t) : Date.now();
}

function setServerOnline(online) {
  serverOnline = online;
  if (online) {
    saveLastOnlineTime();
    hideOfflineLimitOverlay();
  }
}

function checkOfflineLimit() {
  if (serverOnline) return;
  var elapsed = Date.now() - getLastOnlineTime();
  if (elapsed >= OFFLINE_LIMIT_MS) {
    showOfflineLimitOverlay();
    devLog("Offline limit keçildi (" + Math.round(elapsed / 3600000) + " saat)");
  }
}

function showOfflineLimitOverlay() {
  var overlay = document.getElementById("offline-limit-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "offline-limit-overlay";
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:#0a0f1a;z-index:999999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;font-family:Verdana,'Segoe UI',Tahoma,Arial,sans-serif;";
    overlay.innerHTML =
      '<div style="width:64px;height:64px;border-radius:16px;background:rgba(239,68,68,0.15);display:flex;align-items:center;justify-content:center;">' +
        '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round"><path d="M1 1l22 22"/><path d="M16.72 11.06A10.94 10.94 0 0119 12.55"/><path d="M5 12.55a10.94 10.94 0 015.17-2.39"/><path d="M10.71 5.05A16 16 0 0122.56 9"/><path d="M1.42 9a15.91 15.91 0 014.7-2.88"/><path d="M8.53 16.11a6 6 0 016.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>' +
      '</div>' +
      '<div style="color:#f1f5f9;font-size:20px;font-weight:700;">İnternetə qoşulun</div>' +
      '<div style="color:#94a3b8;font-size:14px;text-align:center;max-width:400px;padding:0 20px;">Cihaz 3 gündən çoxdur oflayn rejimdədir. Davam etmək üçün internet bağlantısını yoxlayın.</div>' +
      '<div style="margin-top:16px;padding:8px 20px;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.2);border-radius:10px;color:#10B981;font-size:13px;">İnternet bərpa olunduqda avtomatik açılacaq</div>';
    document.body.appendChild(overlay);
  }
  overlay.style.display = "flex";
  // Stop playback
  stopExoIfPlaying();
  if (typeof itemTimer !== "undefined" && itemTimer) clearTimeout(itemTimer);
}

function hideOfflineLimitOverlay() {
  var overlay = document.getElementById("offline-limit-overlay");
  if (overlay) overlay.style.display = "none";
}

// ============================================================
// LOGIN
// ============================================================
loginForm.addEventListener("submit", async function(e) {
  e.preventDefault();
  await doPair(inputCode.value.trim().toUpperCase());
});

// Auto-uppercase pairing code
inputCode.addEventListener("input", function() {
  inputCode.value = inputCode.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});

async function doPair(pairingCode) {
  loginError.classList.add("hidden");
  btnLogin.disabled = true;
  btnLogin.querySelector(".btn-text").textContent = "Qoşulur...";
  btnLogin.querySelector(".btn-loader").classList.remove("hidden");

  try {
    var res = await fetch(API_BASE + "/device/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode }),
    });

    if (!res.ok) {
      var data = await res.json().catch(function() { return {}; });
      throw new Error(data.message || "Kod yanlışdır və ya vaxtı keçib");
    }

    var data = await res.json();
    token = data.accessToken;
    monitorInfo = data.monitor;
    saveDeviceToken(data.deviceToken);
    saveState();
    enterPlayer();
  } catch (err) {
    loginError.textContent = err.message || "Giriş uğursuz oldu";
    loginError.classList.remove("hidden");
  } finally {
    btnLogin.disabled = false;
    btnLogin.querySelector(".btn-text").textContent = "Qoşul";
    btnLogin.querySelector(".btn-loader").classList.add("hidden");
  }
}

async function doReconnect(deviceToken) {
  try {
    var res = await fetch(API_BASE + "/device/reconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceToken }),
    });

    if (!res.ok) {
      // If reconnect fails with network error, try offline mode with cached state
      var state = loadState();
      if (state && state.monitorInfo) {
        devLog("Reconnect failed — entering offline mode with cached data");
        enterPlayer();
      } else {
        clearDeviceToken();
      }
      return false;
    }

    var data = await res.json();
    token = data.accessToken;
    monitorInfo = data.monitor;
    saveState();
    enterPlayer();
    return true;
  } catch {
    // Network error → offline mode
    var state = loadState();
    if (state && state.monitorInfo) {
      devLog("Network error — entering offline mode with cached data");
      enterPlayer();
    } else {
      clearDeviceToken();
    }
    return false;
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
  fetchCinemaAlertConfig();
}

// ============================================================
// WEBSOCKET
// ============================================================
function connectSocket() {
  if (socket) socket.disconnect();

  socket = io(WS_BASE + "/device", {
    transports: ["websocket", "polling"],
    auth: { token },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 30000,
  });

  socket.on("connect", function() {
    devLog("[WS] Connected");
    socket.emit("register", { monitorId: monitorInfo.id, token });
  });

  socket.on("disconnect", function(reason) {
    devLog("[WS] Disconnected: " + reason);
  });

  socket.on("connect_error", function(err) {
    devLog("[WS] Connection error: " + err.message);
  });

  socket.on("reconnect", function() {
    devLog("[WS] Reconnected — reloading playlist");
    socket.emit("register", { monitorId: monitorInfo.id, token });
    loadPlaylist();
  });

  socket.on("playlist_update", function() {
    devLog("[WS] playlist_update received");
    cacheAbortFlag = true; // köhnə cache-i dayandır
    loadPlaylist();
  });

  socket.on("sync_playback", function(data) {
    devLog("[WS] sync_playback received");
    currentIndex = (data && data.startIndex) || 0;
    if (playlist.length > 0) {
      preloadAndPlay();
    }
  });

  socket.on("audio_update", function(data) {
    console.log("[WS] audio_update", data);
    if (data.volume !== undefined) audioVolume = data.volume;
    if (data.muted !== undefined) audioMuted = data.muted;
    applyAudio();
    saveState();
  });

  socket.on("force_logout", function() {
    console.log("[WS] force_logout");
    doLogout();
  });

  socket.on("force_screensaver", function(data) {
    console.log("[WS] force_screensaver:", (data && data.reason));
    stopPlayback();
    showScreensaver();
  });

  socket.on("emergency_alert", function(data) {
    console.log("[WS] TƏCILI MESAJ:", data.message);
    stopExoIfPlaying();
    showEmergencyAlert(data);
  });

  socket.on("emergency_alert_dismiss", function() {
    console.log("[WS] Təcili mesaj ləğv edildi");
    hideEmergencyAlert();
  });

  socket.on("restart", function() {
    console.log("[WS] restart");
    location.reload();
  });

  socket.on("take_screenshot", function() {
    console.log("[WS] take_screenshot");
    if (window.AndroidBridge && typeof AndroidBridge.captureScreenshot === 'function') {
      var base64 = AndroidBridge.captureScreenshot();
      if (base64 && socket) {
        socket.emit("screenshot_result", { image: base64 });
        console.log("[Screenshot] Göndərildi:", base64.length, "bytes");
      }
    }
  });

  socket.on("screensaver_update", function(data) {
    screensaverUrl = data.url || null;
    // Cache screensaver if on Android
    if (isAndroid && screensaverUrl) {
      cacheMediaFile(screensaverUrl).then(function() {});
    }
    saveState();
    if (isScreensaver) showScreensaver();
  });

  socket.on("display_schedule_update", function(data) {
    displaySchedule = data;
    saveState();
    checkDisplaySchedule();
  });

  socket.on("display_settings_update", function(data) {
    devLog("[WS] display_settings_update");
    applyDisplaySettings(data);
  });

  socket.on("monitor_update", function(data) {
    if (data.name && monitorInfo) {
      monitorInfo.name = data.name;
      saveState();
      devLog("[WS] Monitor adı yeniləndi: " + data.name);
    }
  });

  socket.on("force_deactivate", function(data) {
    deactivatedMsg.textContent = data.message || "";
    deactivatedOverlay.classList.remove("hidden");
  });

  socket.on("venue_activated", function() {
    deactivatedOverlay.classList.add("hidden");
    loadPlaylist();
  });

  socket.on("clear_cache", function() {
    devLog("[WS] clear_cache received");
    if (isAndroid) {
      try {
        AndroidBridge.clearCache();
        devLog("[Cache] Cache cleared by admin");
      } catch (e) {
        devLog("[Cache] Error clearing cache: " + e);
      }
    }
  });

  socket.on("bandwidth_config", function(config) {
    devLog("[WS] bandwidth_config received: " + JSON.stringify(config));
    bandwidthConfig = config;
    if (isAndroid) {
      try { AndroidBridge.setBandwidthConfig(JSON.stringify(config || [])); } catch (e) {}
    }
  });

  socket.on("cinema_alert_config", function(config) {
    devLog("[WS] cinema_alert_config: " + (config ? config.cinemaName : "silindi"));
    cinemaAlertConfig = config || null;
    scheduleCinemaAlerts();
  });
}

// ============================================================
// CINEMA ALERT
// ============================================================
async function fetchCinemaAlertConfig() {
  if (!monitorInfo) return;
  try {
    var res = await fetch(API_BASE + "/cinema-alerts/monitor/" + monitorInfo.id);
    if (!res.ok) return;
    var data = await res.json();
    cinemaAlertConfig = data || null;
    scheduleCinemaAlerts();
    devLog("Cinema alert config: " + (data ? data.cinemaName : "yox"));
  } catch (e) {
    devLog("Cinema alert config alınmadı: " + e.message);
  }
}

async function scheduleCinemaAlerts() {
  cinemaAlertTimers.forEach(function(t) { clearTimeout(t); });
  cinemaAlertTimers = [];
  hideCinemaAlertOverlay();
  if (!cinemaAlertConfig) return;

  try {
    var res = await fetch(cinemaAlertConfig.apiUrl);
    var text = await res.text();
    var parser = new DOMParser();
    var xml = parser.parseFromString(text, "text/xml");
    var movies = xml.querySelectorAll("movie");
    var now = new Date();
    var today = now.getFullYear() + "-" + String(now.getMonth()+1).padStart(2,'0') + "-" + String(now.getDate()).padStart(2,'0');
    var sessions = [];

    movies.forEach(function(movie) {
      var title = (movie.querySelector("title") ? movie.querySelector("title").textContent.trim() : "") || "";
      movie.querySelectorAll("hall").forEach(function(hall) {
        var hallName = hall.getAttribute("name") || "";
        hall.querySelectorAll("session").forEach(function(s) {
          var timeRaw = (s.textContent ? s.textContent.trim() : "") || "";
          var isDatetime = timeRaw.length >= 16;
          var sessionDate = isDatetime ? timeRaw.substring(0, 10) : today;
          if (sessionDate !== today) return;
          var timeStr = isDatetime ? timeRaw.substring(11, 16) : timeRaw;
          var parts = timeStr.split(":");
          if (parts.length < 2) return;
          var h = parseInt(parts[0], 10);
          var m = parseInt(parts[1], 10);
          if (isNaN(h) || isNaN(m)) return;
          var sessionTime = new Date(now);
          sessionTime.setHours(h, m, 0, 0);
          var alertTime = new Date(sessionTime.getTime() - cinemaAlertConfig.minutesBefore * 60000);
          var delay = alertTime.getTime() - Date.now();
          if (delay > -10000) {
            sessions.push({ time: timeStr, title, hall: hallName, type: s.getAttribute("type") || "2D", lang: s.getAttribute("language") || "", alertTime });
          }
        });
      });
    });

    devLog("Cinema alert: " + sessions.length + " seans planlandı");
    sessions.forEach(function(sess) {
      var delay = Math.max(0, sess.alertTime.getTime() - Date.now());
      var t = setTimeout(function() { showCinemaAlertOverlay(sess); }, delay);
      cinemaAlertTimers.push(t);
    });
  } catch (e) {
    devLog("Cinema alert XML alınmadı: " + e.message);
  }
}

function showEmergencyAlert(data) {
  hideEmergencyAlert();
  var overlay = document.createElement("div");
  overlay.id = "emergency-alert-overlay";
  overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;z-index:999999;background:" + data.color || '#dc2626' + ";display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;font-family:Arial,sans-serif;text-align:center;padding:40px;";
  overlay.innerHTML = "\n    <div style=\"font-size:80px;margin-bottom:30px;\">⚠️</div>\n    <div style=\"font-size:48px;font-weight:bold;line-height:1.3;max-width:80%;text-shadow:0 2px 10px rgba(0,0,0,0.3);\">" + data.message + "</div>\n  ";
  document.body.appendChild(overlay);
  if (data.duration && data.duration > 0) {
    setTimeout(function() { hideEmergencyAlert(); }, data.duration * 1000);
  }
}

function hideEmergencyAlert() {
  var el = document.getElementById("emergency-alert-overlay");
  if (el) el.remove();
}

function showCinemaAlertOverlay(session) {
  hideCinemaAlertOverlay();
  var cfg = cinemaAlertConfig;
  if (!cfg) return;

  var fields = cfg.showFields || {};
  var color = cfg.color || "#e50914";
  var bg = cfg.bg || "#0a0a0a";
  var accent = cfg.accent || color;
  var lang = cfg.lang || "az";

  // Lokalizasiya olunmuş mesaj
  var mins = cfg.minutesBefore || 5;
  var title = session.title || "";
  var hall = session.hall || "";
  var MESSAGES = {
    az: mins + " dəqiqə sonra \"" + title + "\" filmi " + hall + " zalında başlayacaqdır",
    ru: "Через " + mins + " минут в зале " + hall + " начнётся фильм «" + title + "»",
    en: "\"" + title + "\" will start in " + hall + " in " + mins + " minutes",
  };
  var messageText = MESSAGES[lang] || MESSAGES.az;

  if (!document.getElementById("cinema-alert-styles")) {
    var style = document.createElement("style");
    style.id = "cinema-alert-styles";
    style.textContent = "\n      @keyframes caIn  { from { opacity:0; transform:scale(0.96); } to { opacity:1; transform:scale(1); } }\n      @keyframes caOut { from { opacity:1; transform:scale(1); }  to { opacity:0; transform:scale(1.04); } }\n    ";
    document.head.appendChild(style);
  }

  var overlay = document.createElement("div");
  overlay.id = "cinema-alert-overlay";
  overlay.style.cssText =
    "position:fixed;top:0;left:0;width:100%;height:100%;z-index:199999;" +
    "background:" + bg + ";" +
    "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
    'color:#fff;font-family:Verdana,"Segoe UI",Tahoma,Arial,sans-serif;' +
    "text-align:center;padding:40px;-webkit-font-smoothing:antialiased;" +
    "animation:caIn 0.5s ease;";

  var accentTop = document.createElement("div");
  accentTop.style.cssText = "position:absolute;top:0;left:0;right:0;height:5px;background:" + accent + ";";
  overlay.appendChild(accentTop);

  if (cfg.cinemaName) {
    var nameEl = document.createElement("div");
    nameEl.style.cssText =
      "position:absolute;top:28px;left:0;right:0;text-align:center;" +
      "font-size:14px;font-weight:700;letter-spacing:4px;text-transform:uppercase;color:rgba(255,255,255,0.4);";
    nameEl.textContent = cfg.cinemaName;
    overlay.appendChild(nameEl);
  }

  var wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:8px;max-width:90vw;";

  // Lokalizasiya olunmuş mesaj (üstdə)
  var msgEl = document.createElement("div");
  msgEl.style.cssText =
    "font-size:clamp(16px,2vw,28px);font-weight:500;color:rgba(255,255,255,0.85);" +
    "margin-bottom:16px;line-height:1.5;max-width:85vw;padding:0 10px 4px;";
  msgEl.textContent = messageText;
  wrap.appendChild(msgEl);

  if (fields.movie && session.title) {
    var t = document.createElement("div");
    t.style.cssText =
      "font-size:clamp(22px,3.5vw,52px);font-weight:900;letter-spacing:2px;" +
      "line-height:1.3;padding-bottom:8px;margin-bottom:4px;max-width:90vw;";
    t.textContent = session.title;
    wrap.appendChild(t);
  }

  if (fields.time && session.time) {
    var t = document.createElement("div");
    t.style.cssText =
      "font-size:clamp(48px,10vw,140px);font-weight:900;letter-spacing:8px;color:" + accent + ";" +
      "font-variant-numeric:tabular-nums;line-height:1.1;padding-bottom:6px;margin:8px 0;";
    t.textContent = session.time;
    wrap.appendChild(t);
  }

  var badges = document.createElement("div");
  badges.style.cssText = "display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap;margin-top:12px;";

  if (fields.format && session.type) {
    var fmtColor = session.type.toUpperCase().includes("IMAX") ? "#ffb300"
      : session.type.toUpperCase().includes("3D") ? "#ff5c5c" : "#00d4ff";
    var b = document.createElement("span");
    b.style.cssText =
      "padding:8px 20px;border-radius:8px;background:rgba(255,255,255,0.08);" +
      "border:1px solid rgba(255,255,255,0.15);font-size:clamp(14px,1.8vw,22px);font-weight:800;color:" + fmtColor + ";";
    b.textContent = session.type;
    badges.appendChild(b);
  }

  if (fields.hall && session.hall) {
    var b = document.createElement("span");
    b.style.cssText =
      "padding:8px 20px;border-radius:8px;background:rgba(255,255,255,0.08);" +
      "border:1px solid rgba(255,255,255,0.15);font-size:clamp(14px,1.8vw,22px);font-weight:700;";
    b.textContent = session.hall;
    badges.appendChild(b);
  }

  if (fields.lang && session.lang) {
    var b = document.createElement("span");
    b.style.cssText =
      "padding:8px 20px;border-radius:8px;background:rgba(255,255,255,0.08);" +
      "border:1px solid rgba(255,255,255,0.15);font-size:clamp(14px,1.8vw,22px);font-weight:700;color:rgba(255,255,255,0.75);";
    b.textContent = session.lang;
    badges.appendChild(b);
  }

  if (badges.children.length > 0) wrap.appendChild(badges);
  overlay.appendChild(wrap);

  var barWrap = document.createElement("div");
  barWrap.style.cssText = "position:absolute;bottom:0;left:0;right:0;height:4px;background:rgba(255,255,255,0.1);";
  var bar = document.createElement("div");
  bar.style.cssText = "height:100%;background:" + accent + ";width:100%;";
  barWrap.appendChild(bar);
  overlay.appendChild(barWrap);

  document.body.appendChild(overlay);

  requestAnimationFrame(function() {
    bar.style.transition = "width " + cfg.displaySeconds + "s linear";
    bar.style.width = "0%";
  });

  var hideTimer = setTimeout(function() {
    overlay.style.animation = "caOut 0.5s ease forwards";
    setTimeout(function() { hideCinemaAlertOverlay(); }, 500);
  }, cfg.displaySeconds * 1000);
  cinemaAlertTimers.push(hideTimer);

  devLog("Cinema alert göstərildi: " + session.title + " — " + session.time);
}

function hideCinemaAlertOverlay() {
  var el = document.getElementById("cinema-alert-overlay");
  if (el) el.remove();
}

// ============================================================
// PLAYLIST LOADING
// ============================================================
async function loadPlaylist() {
  if (!token || !monitorInfo) return;

  try {
    var res = await fetch(API_BASE + "/device/" + monitorInfo.id + "/playlist", {
      headers: { Authorization: "Bearer " + token },
    });

    if (res.status === 401) { doLogout(); return; }
    if (!res.ok) return;

    setServerOnline(true);
    var data = await res.json();

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
        cacheMediaFile(screensaverUrl).then(function() {});
      }
    }

    // Display schedule
    if (data.displaySchedule) displaySchedule = data.displaySchedule;

    // Display settings (objectFit, orientation)
    if (data.displaySettings) applyDisplaySettings(data.displaySettings);

    // Schedules (new format) or items (legacy)
    if (data.schedules && data.schedules.length > 0) {
      schedules = data.schedules;
      devLog("Loaded " + schedules.length + " schedule(s): " + schedules.map(function(s) { return s.name || s.id; }).join(", "));
      schedules.forEach(function(s) {
        devLog("  Schedule \"" + s.name + "\": " + (s.items ? s.items.length : 0) || 0 + " items, days=" + JSON.stringify(s.daysOfWeek) + ", time=" + s.startTime + "-" + s.endTime);
      });
    } else if (data.items && data.items.length > 0) {
      schedules = [{ id: "legacy", name: "Default", items: data.items }];
      devLog("Loaded legacy playlist: " + data.items.length + " items");
    } else {
      schedules = [];
      devLog("No schedules or items received");
    }

    // Apply shuffle to each schedule that has it enabled
    schedules = schedules.map(function(sched) { return applyShuffleToSchedule(sched); });

    saveState();
    checkScheduleAndPlay();   // dərhal oyna — download-u gözləmə
    checkDisplaySchedule();

    // Cache media in background (no await) — abort flag stops old downloads
    if (isAndroid) {
      cacheAbortFlag = true; // köhnə cache-i dayandır
      setTimeout(async function() {
        cacheAbortFlag = false;
        for (var sched of schedules) {
          if (sched.items && sched.items.length > 0) {
            await cachePlaylistMedia(sched.items);
          }
        }
        setTimeout(reportInventory, 1000);
      }, 0);
    }

    // Hide loading overlay
    loadingOverlay.classList.add("hidden");

  } catch (err) {
    console.error("[Playlist] Error:", err);
    setServerOnline(false);
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
  var now = new Date();
  var currentDay = now.getDay() === 0 ? 7 : now.getDay(); // ISO: 1=Mon, 7=Sun
  var currentMinutes = now.getHours() * 60 + now.getMinutes();
  var todayStr = now.toISOString().split("T")[0];

  for (var sched of schedules) {
    // Check date range
    if (sched.startDate && todayStr < sched.startDate.split("T")[0]) continue;
    if (sched.endDate && todayStr > sched.endDate.split("T")[0]) continue;

    // Check days of week
    if (sched.daysOfWeek && sched.daysOfWeek.length > 0 && !sched.daysOfWeek.includes(currentDay)) continue;

    // Check time range
    if (sched.startTime && sched.endTime) {
      var [sh, sm] = sched.startTime.split(":").map(Number);
      var [eh, em] = sched.endTime.split(":").map(Number);
      var start = sh * 60 + sm;
      var end = eh * 60 + em;

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
  var active = getActiveSchedule();

  if (!active) {
    if (!isScreensaver) {
      devLog("No active schedule → screensaver");
      stopPlayback();
      showScreensaver();
    }
    return;
  }
  devLog("Active schedule: \"" + active.name + "\" with " + active.items.length + " items");

  // Active schedule found
  var newItems = active.items;
  var oldIds = playlist.map(function(i) { return i.id; }).join(",");
  var newIds = newItems.map(function(i) { return i.id; }).join(",");

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

  var item = playlist[currentIndex];
  trackPlayed(item);
  devLog("Playing: " + item.name || "?" + " (" + item.type + ")");

  if (item.type === "VIDEO") {
    playVideo(item);
  } else if (item.type === "URL" || item.type === "HTML") {
    playWebPage(item);
  } else {
    playImage(item);
  }
}

function stopExoIfPlaying() {
  if (window.AndroidBridge && typeof AndroidBridge.stopNativeVideo === 'function') {
    try { AndroidBridge.stopNativeVideo(); } catch(e) {}
  }
}

// Native video callbacks
window.onNativeVideoEnded = function() {
  clearTimeout(itemTimer);
  advanceToNext();
};
window.onNativeVideoError = function() {
  clearTimeout(itemTimer);
  if (playlist.length > 1) { advanceToNext(); } else { showScreensaver(); }
};

function playVideo(item) {
  // Use native ExoPlayer if available (Android) — faster, no play button flash
  if (window.AndroidBridge && typeof AndroidBridge.playNativeVideo === 'function') {
    var nativeUrl = item.url;
    if (typeof AndroidBridge.getCachedFilePath === 'function') {
      var cached = AndroidBridge.getCachedFilePath(item.url);
      if (cached) nativeUrl = cached;
    }
    AndroidBridge.playNativeVideo(nativeUrl, audioVolume, audioMuted);
    clearTimeout(itemTimer);
    var dur = (item.duration || 30) * 1000;
    itemTimer = setTimeout(function() {
      stopExoIfPlaying();
      advanceToNext();
    }, dur + 2000);
    return;
  }

  // WebView fallback
  // Clear any leftover oncanplay from previous video load
  activeVideo.oncanplay = null;
  nextVideo.oncanplay = null;

  var url = getMediaUrl(item);

  // Setup active video — keep hidden until first frame ready (avoids play-button flash)
  activeVideo.src = url;
  activeVideo.currentTime = 0;
  activeVideo.muted = audioMuted;
  activeVideo.volume = audioVolume / 100;
  activeVideo.classList.add("hidden");
  activeVideo.style.zIndex = 10;

  var videoShown = false;
  var showVideo = function() {
    if (videoShown) return;
    videoShown = true;
    clearTimeout(skipTimer);
    // Hide previous layer only when new video is ready — no black flash
    imageLayer.classList.add("hidden");
    nextVideo.classList.add("hidden");
    activeVideo.classList.remove("hidden");
    activeVideo.style.opacity = '1';
    activeVideo.oncanplay = null;
    activeVideo.onplaying = null;
  };
  activeVideo.oncanplay = showVideo;
  activeVideo.onplaying = showVideo;
  // If already buffered (preloaded), canplay won't fire again — check readyState
  if (activeVideo.readyState >= 3) showVideo();

  // Preload next
  preloadNext();

  var playPromise = activeVideo.play();
  if (playPromise) playPromise.catch(function() {
    // Autoplay blocked — try muted
    activeVideo.muted = true;
    activeVideo.play().catch(function() {});
  });

  var duration = (item.duration || 30) * 1000;

  // If video doesn't start in 5s (file missing / network issue) → skip
  var skipTimer = setTimeout(function() {
    if (!videoShown) {
      activeVideo.oncanplay = null;
      activeVideo.onplaying = null;
      activeVideo.onended = null;
      activeVideo.onerror = null;
      activeVideo.classList.add("hidden");
      clearTimeout(itemTimer);
      advanceToNext();
    }
  }, 5000);

  activeVideo.onended = function() {
    clearTimeout(skipTimer);
    clearTimeout(itemTimer);
    advanceToNext();
  };
  activeVideo.onerror = function() {
    console.warn("[Video] Error playing:", item.name);
    clearTimeout(skipTimer);
    activeVideo.classList.add("hidden");
    clearTimeout(itemTimer);
    itemTimer = setTimeout(advanceToNext, 1000);
  };

  clearTimeout(itemTimer);
  itemTimer = setTimeout(function() {
    clearTimeout(skipTimer);
    activeVideo.pause();
    advanceToNext();
  }, duration + 2000);
}

function playImage(item) {
  stopExoIfPlaying();
  // Clear any leftover oncanplay callbacks — prevent ghost video appearing over image
  activeVideo.oncanplay = null;
  nextVideo.oncanplay = null;
  // Hide videos
  activeVideo.classList.add("hidden");
  nextVideo.classList.add("hidden");
  activeVideo.pause();
  nextVideo.pause();

  var url = getMediaUrl(item);

  imageLayer.src = url;
  imageLayer.classList.remove("hidden");
  imageLayer.style.zIndex = 10;

  // Preload next
  preloadNext();

  clearTimeout(itemTimer);
  if (playlist.length > 1) {
    var duration = (item.duration || 10) * 1000;
    itemTimer = setTimeout(advanceToNext, duration);
  }
  // Single image: stay on screen indefinitely (no timer)
}

function playWebPage(item) {
  stopExoIfPlaying();
  activeVideo.classList.add("hidden");
  nextVideo.classList.add("hidden");
  activeVideo.pause();
  nextVideo.pause();
  imageLayer.classList.add("hidden");

  webLayer.src = item.url;
  webLayer.classList.remove("hidden");
  webLayer.style.zIndex = 10;

  clearTimeout(itemTimer);
  // Tək template isə reload etmə, template öz daxili refresh-i işləsin
  if (playlist.length > 1) {
    var duration = (item.duration || 30) * 1000;
    itemTimer = setTimeout(advanceToNext, duration);
  } else {
    devLog("Tək template — reload edilmir, daxili refresh işləyir");
  }
}

function preloadNext() {
  var nextIndex = (currentIndex + 1) % playlist.length;
  var nextItem = playlist[nextIndex];
  var url = getMediaUrl(nextItem);

  if (nextItem.type === "VIDEO") {
    nextVideo.src = url;
    nextVideo.preload = "auto";
    nextVideo.load();
  } else {
    // Preload image
    var img = new Image();
    img.src = url;
  }
}

function advanceToNext() {
  clearTimeout(itemTimer);

  // Log play to analytics
  var finishedItem = (currentIndex >= 0 && playlist.length > 0) ? playlist[currentIndex] : null;
  if (finishedItem && monitorInfo) {
    fetch(API_BASE + '/analytics/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': "Bearer " + token },
      body: JSON.stringify({
        monitorId: monitorInfo.id,
        mediaId: finishedItem.mediaId || finishedItem.id,
        mediaName: finishedItem.name || finishedItem.title || 'Unknown',
        mediaType: finishedItem.type || 'IMAGE',
        durationMs: finishedItem.duration ? finishedItem.duration * 1000 : 10000,
      }),
    }).catch(function() {});
  }

  webLayer.classList.add("hidden");
  webLayer.src = "about:blank";

  // Swap video buffers
  var tmp = activeVideo;
  activeVideo = nextVideo;
  nextVideo = tmp;
  nextVideo.classList.add("hidden");
  nextVideo.style.zIndex = 1;
  nextVideo.pause();

  var next = (currentIndex + 1) % playlist.length;
  if (next === 0) {
    var active = getActiveSchedule();
    if (active && active.shuffle) {
      var reshuffled = applyShuffleToSchedule(active);
      var idx = schedules.findIndex(function(s) { return s.id === active.id; });
      if (idx !== -1) schedules[idx] = reshuffled;
      playlist = reshuffled.items;
    }
  }
  currentIndex = next;
  preloadAndPlay();
}

function stopPlayback() {
  clearTimeout(itemTimer);
  activeVideo.pause();
  nextVideo.pause();
  activeVideo.classList.add("hidden");
  nextVideo.classList.add("hidden");
  imageLayer.classList.add("hidden");
  webLayer.classList.add("hidden");
  webLayer.src = "about:blank";
}

// ============================================================
// SCREENSAVER
// ============================================================
function showScreensaver() {
  stopExoIfPlaying();
  isScreensaver = true;
  stopPlayback();
  screensaverEl.classList.remove("hidden");
  screensaverEl.style.zIndex = 20;

  ssVideo.classList.add("hidden");
  ssImage.classList.add("hidden");
  ssDefault.classList.add("hidden");

  if (screensaverUrl) {
    var ssUrl = isAndroid ? getCachedUrl(screensaverUrl) : screensaverUrl;
    var isVideo = /\.(mp4|webm|ogg|mov)(\?|$)/i.test(screensaverUrl);
    if (isVideo) {
      ssVideo.src = ssUrl;
      ssVideo.classList.remove("hidden");
      ssVideo.play().catch(function() { ssVideo.muted = true; ssVideo.play().catch(function() {}); });
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

  var now = new Date();
  var mins = now.getHours() * 60 + now.getMinutes();
  var [oh, om] = displaySchedule.onTime.split(":").map(Number);
  var [fh, fm] = displaySchedule.offTime.split(":").map(Number);
  var onMins = oh * 60 + om;
  var offMins = fh * 60 + fm;

  var shouldBeOn;
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
// DISPLAY SETTINGS
// ============================================================
function applyDisplaySettings(settings) {
  displaySettings = settings;
  var fit = settings.objectFit || "cover";
  [videoA, videoB, imageLayer, ssImage, ssVideo].forEach(function(el) {
    if (el) el.style.objectFit = fit;
  });
  // Orientation — Android native rotation
  if (isAndroid && settings.orientation) {
    try { AndroidBridge.setOrientation(settings.orientation); } catch (e) {}
  }
}

// ============================================================
// AUDIO
// ============================================================
function applyAudio() {
  [videoA, videoB, ssVideo].forEach(function(v) {
    v.volume = audioVolume / 100;
    v.muted = audioMuted;
  });
  // Sync with ExoPlayer
  if (window.AndroidBridge && typeof AndroidBridge.setNativeVideoVolume === 'function') {
    try { AndroidBridge.setNativeVideoVolume(audioVolume, audioMuted); } catch(e) {}
  }
}

// ============================================================
// HEARTBEAT
// ============================================================
async function sendHeartbeat() {
  if (!token || !monitorInfo) return;
  try {
    var ver = isAndroid ? AndroidBridge.getAppVersion() : "1.0.0";
    var platform = isAndroid ? "android" : "web";
    var body = {
      appVersion: platform + "-" + ver,
      nowPlaying: (playlist[currentIndex] ? playlist[currentIndex].name : null) || null,
    };

    var res = await fetch(API_BASE + "/device/" + monitorInfo.id + "/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify(body),
    });
    if (res.ok) setServerOnline(true);
  } catch {
    setServerOnline(false);
  }
}

// ============================================================
// DEV LOG
// ============================================================
function devLog(msg) {
  var ts = new Date().toLocaleTimeString("az-AZ", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  var entry = "[" + ts + "] " + msg;
  console.log(entry);
  devLogs.push(entry);
  if (devLogs.length > 200) devLogs.shift();
  // Update dev panel if open
  var logEl = document.getElementById("dev-logs");
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

  var panel = document.createElement("div");
  panel.id = "dev-panel";
  panel.style.cssText = "\n    position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.95);\n    color:#fff;font-family:monospace;font-size:12px;overflow-y:auto;padding:16px;\n    display:flex;flex-direction:column;gap:12px;\n  ";

  panel.innerHTML = "\n    <div style=\"display:flex;justify-content:space-between;align-items:center\">\n      <h2 style=\"margin:0;font-size:16px;color:#10b981\">Dev Tools — Airmyplay Android</h2>\n      <button id=\"dev-close\" style=\"background:#ef4444;border:none;color:#fff;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:13px\">Bağla</button>\n    </div>\n\n    <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:8px\">\n      <div style=\"background:#1a1a2e;padding:10px;border-radius:8px\">\n        <div style=\"color:#6b7280;font-size:10px\">Status</div>\n        <div id=\"dev-status\" style=\"color:#10b981;font-size:14px\">--</div>\n      </div>\n      <div style=\"background:#1a1a2e;padding:10px;border-radius:8px\">\n        <div style=\"color:#6b7280;font-size:10px\">WebSocket</div>\n        <div id=\"dev-ws\" style=\"font-size:14px\">--</div>\n      </div>\n      <div style=\"background:#1a1a2e;padding:10px;border-radius:8px\">\n        <div style=\"color:#6b7280;font-size:10px\">Monitor</div>\n        <div id=\"dev-monitor\" style=\"font-size:14px\">--</div>\n      </div>\n      <div style=\"background:#1a1a2e;padding:10px;border-radius:8px\">\n        <div style=\"color:#6b7280;font-size:10px\">Version</div>\n        <div id=\"dev-version\" style=\"font-size:14px\">--</div>\n      </div>\n      <div style=\"background:#1a1a2e;padding:10px;border-radius:8px\">\n        <div style=\"color:#6b7280;font-size:10px\">Schedules</div>\n        <div id=\"dev-schedules\" style=\"font-size:14px\">--</div>\n      </div>\n      <div style=\"background:#1a1a2e;padding:10px;border-radius:8px\">\n        <div style=\"color:#6b7280;font-size:10px\">Playlist</div>\n        <div id=\"dev-playlist\" style=\"font-size:14px\">--</div>\n      </div>\n      <div style=\"background:#1a1a2e;padding:10px;border-radius:8px;grid-column:span 2\">\n        <div style=\"color:#6b7280;font-size:10px\">Media Cache</div>\n        <div id=\"dev-cache\" style=\"font-size:14px\">--</div>\n      </div>\n    </div>\n\n    <div style=\"display:flex;gap:8px;flex-wrap:wrap\">\n      <button id=\"dev-clear-cache\" style=\"background:#6E55FF;border:none;color:#fff;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px\">Keşi Təmizlə</button>\n      <button id=\"dev-reload-playlist\" style=\"background:#6E55FF;border:none;color:#fff;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px\">Playlist Yenilə</button>\n      <button id=\"dev-show-files\" style=\"background:#6E55FF;border:none;color:#fff;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px\">Keş Faylları</button>\n      <button id=\"dev-logout\" style=\"background:#ef4444;border:none;color:#fff;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px\">Çıxış</button>\n    </div>\n\n    <div id=\"dev-files-section\" style=\"display:none\">\n      <div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:4px\">\n        <div style=\"color:#6b7280;font-size:10px\">Keş Qovluğu</div>\n        <div id=\"dev-cache-path\" style=\"color:#6b7280;font-size:9px;font-family:monospace\"></div>\n      </div>\n      <div id=\"dev-file-list\" style=\"background:#0a0a14;padding:10px;border-radius:8px;overflow-y:auto;max-height:200px;font-size:11px\"></div>\n    </div>\n\n    <div style=\"flex:1;min-height:0\">\n      <div style=\"color:#6b7280;font-size:10px;margin-bottom:4px\">Loglar</div>\n      <pre id=\"dev-logs\" style=\"background:#0a0a14;padding:10px;border-radius:8px;overflow-y:auto;max-height:300px;white-space:pre-wrap;word-break:break-all;font-size:11px;color:#d1d5db;margin:0\"></pre>\n    </div>\n  ";

  document.body.appendChild(panel);

  // Buttons
  document.getElementById("dev-close").onclick = function() { panel.remove(); devToolsOpen = false; };
  document.getElementById("dev-clear-cache").onclick = function() {
    if (isAndroid) { AndroidBridge.clearCache(); devLog("Cache cleared"); }
    updateDevStats();
  };
  document.getElementById("dev-reload-playlist").onclick = function() { loadPlaylist(); devLog("Playlist reload triggered"); };
  document.getElementById("dev-show-files").onclick = function() {
    var section = document.getElementById("dev-files-section");
    if (section.style.display === "none") {
      section.style.display = "block";
      showCacheFiles();
    } else {
      section.style.display = "none";
    }
  };
  document.getElementById("dev-logout").onclick = function() { panel.remove(); devToolsOpen = false; doLogout(); };

  devToolsOpen = true;
  updateDevStats();

  // Show logs
  document.getElementById("dev-logs").textContent = devLogs.slice(-50).join("\n");
}

function updateDevStats() {
  var el = function(id) { return document.getElementById(id); };
  if (!el("dev-panel")) return;

  el("dev-status").textContent = token ? "Online" : "Offline";
  el("dev-status").style.color = token ? "#10b981" : "#ef4444";

  var wsConnected = socket && socket.connected;
  el("dev-ws").textContent = wsConnected ? "Bağlı" : "Kəsilib";
  el("dev-ws").style.color = wsConnected ? "#10b981" : "#ef4444";

  el("dev-monitor").textContent = monitorInfo ? monitorInfo.name || "" + " (" + monitorInfo.deviceKey || "" + ")" : "N/A";

  var ver = isAndroid ? AndroidBridge.getAppVersion() : "web";
  el("dev-version").textContent = isAndroid ? "Android" : "Web" + " v" + ver;

  el("dev-schedules").textContent = schedules.length + " cədvəl";
  el("dev-playlist").textContent = playlist.length + " media, index: " + currentIndex;

  if (isAndroid) {
    try {
      var stats = JSON.parse(AndroidBridge.getCacheStats());
      el("dev-cache").textContent = stats.files || 0 + " fayl, " + stats.totalSizeMB || 0 + " MB";
    } catch { el("dev-cache").textContent = "N/A"; }
  } else {
    el("dev-cache").textContent = "Yalnız Android";
  }
}

function showCacheFiles() {
  var listEl = document.getElementById("dev-file-list");
  var pathEl = document.getElementById("dev-cache-path");
  if (!isAndroid) {
    listEl.innerHTML = '<div style="color:#6b7280">Yalnız Android-də mövcuddur</div>';
    return;
  }
  try {
    pathEl.textContent = AndroidBridge.getCachePath();
    var files = JSON.parse(AndroidBridge.listCacheFiles());
    if (files.length === 0) {
      listEl.innerHTML = '<div style="color:#6b7280">Keşdə fayl yoxdur</div>';
      return;
    }
    listEl.innerHTML = files.map(function(f, i) {
      var extColor = f.ext.match(/mp4|webm|mov|ogg/) ? "#3b82f6" : "#10b981";
      return "<div style=\"display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1a1a2e\">\n        <span style=\"color:#d1d5db;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%\">" + i+1 + ". " + f.name + "</span>\n        <span style=\"display:flex;gap:8px;flex-shrink:0\">\n          <span style=\"color:" + extColor + ";text-transform:uppercase;font-size:10px\">" + f.ext + "</span>\n          <span style=\"color:#6b7280\">" + f.size + "</span>\n        </span>\n      </div>";
    }).join("");
  } catch (e) {
    listEl.innerHTML = "<div style=\"color:#ef4444\">Xəta: " + e.message + "</div>";
  }
}

// 10-tap to open dev tools (10 taps within 3s)
var tapCount = 0;
var tapTimer = null;

function handleDevTap() {
  if (devToolsOpen) return;
  tapCount++;
  if (tapCount === 1) {
    tapTimer = setTimeout(function() { tapCount = 0; }, 3000);
  }
  if (tapCount >= 10) {
    clearTimeout(tapTimer);
    tapCount = 0;
    createDevTools();
  }
}

document.addEventListener("touchend", function(e) { handleDevTap(); }, { passive: true });

// Update dev stats every 5s if open
setInterval(function() { if (devToolsOpen) updateDevStats(); }, 5000);

// ============================================================
// CLOCK (Screensaver)
// ============================================================
function startClockUpdate() {
  if (clockInterval) clearInterval(clockInterval);
  var update = function() {
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
  if (offlineCheckInterval) clearInterval(offlineCheckInterval);

  // Reload playlist every 30s
  playlistPollInterval = setInterval(loadPlaylist, 30000);

  // Check schedule every 15s
  schedulePollInterval = setInterval(function() {
    checkScheduleAndPlay();
    checkDisplaySchedule();
  }, 15000);

  // Heartbeat every 30s
  setInterval(sendHeartbeat, 30000);

  // Re-fetch cinema alert config + re-schedule sessions every 10 minutes
  // (long setTimeout-lar Android WebView-də throttle olunur, periodik refresh lazımdır)
  setInterval(function() {
    devLog("Cinema alert periodic refresh...");
    fetchCinemaAlertConfig();
  }, 10 * 60 * 1000);

  // Offline limit check — every 5 minutes
  offlineCheckInterval = setInterval(checkOfflineLimit, 5 * 60 * 1000);
  setTimeout(checkOfflineLimit, 15000); // first check 15s after start
}

// ============================================================
// LOGOUT
// ============================================================
function doLogout() {
  stopExoIfPlaying();
  // Notify server
  if (token && monitorInfo) {
    fetch(API_BASE + "/device/" + monitorInfo.id + "/logout", {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
    }).catch(function() {});
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
  clearDeviceToken();

  // Show login
  playerScreen.classList.remove("active");
  loginScreen.classList.add("active");
  loginError.classList.add("hidden");
  loadingOverlay.classList.remove("hidden");
  deactivatedOverlay.classList.add("hidden");
}

// ============================================================
// INIT — Auto-reconnect if deviceToken saved
// ============================================================
(async function init() {
  var deviceToken = loadDeviceToken();
  var state = loadState();

  if (deviceToken) {
    // Restore cached state while reconnecting
    if (state && state.monitorInfo) {
      token = state.token;
      monitorInfo = state.monitorInfo;
      schedules = state.schedules || [];
      screensaverUrl = state.screensaverUrl || null;
      displaySchedule = state.displaySchedule || null;
      audioVolume = state.audioVolume ?? 100;
      audioMuted = state.audioMuted ?? false;
      if (state.displaySettings) applyDisplaySettings(state.displaySettings);
    }

    await doReconnect(deviceToken);
  }
})();
