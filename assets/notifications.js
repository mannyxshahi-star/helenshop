(function (root) {
  "use strict";

  var SEEN_KEY = "helenshop_notification_seen_v1";
  var registrationPromise = null;
  var audioCtx = null;

  function unlockBell() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === "suspended") audioCtx.resume();
      return audioCtx.state === "running";
    } catch (e) { return false; }
  }
  function playBell() {
    try {
      if (!unlockBell() || !audioCtx) return false;
      var t0 = audioCtx.currentTime + 0.02;
      [0, 0.16].forEach(function (offset, idx) {
        var start = t0 + offset;
        var gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(idx === 0 ? 0.22 : 0.16, start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.42);
        gain.connect(audioCtx.destination);
        [1568, 2093, 2637, 3520].forEach(function (freq, i) {
          var osc = audioCtx.createOscillator();
          var og = audioCtx.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(freq * (idx === 0 ? 1 : 0.94), start);
          og.gain.setValueAtTime([1, 0.55, 0.32, 0.16][i] || 0.1, start);
          osc.connect(og);
          og.connect(gain);
          osc.start(start);
          osc.stop(start + 0.45);
        });
      });
      return true;
    } catch (e) { return false; }
  }

  function supported() {
    return typeof window !== "undefined" && "Notification" in window;
  }
  function permission() {
    return supported() ? Notification.permission : "unsupported";
  }
  function seen() {
    try {
      var v = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]");
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }
  function remember(key) {
    if (!key) return;
    try {
      var list = seen().filter(function (k) { return k !== key; });
      list.push(key);
      localStorage.setItem(SEEN_KEY, JSON.stringify(list.slice(-300)));
    } catch (e) {}
  }
  function alreadySeen(key) {
    return Boolean(key && seen().indexOf(key) !== -1);
  }
  function serviceWorkerUrl() {
    try { return new URL("sw.js", location.href).toString(); } catch (e) { return "sw.js"; }
  }
  function register() {
    if (!("serviceWorker" in navigator)) return Promise.resolve(null);
    if (!registrationPromise) {
      registrationPromise = navigator.serviceWorker.register(serviceWorkerUrl()).catch(function () { return null; });
    }
    return registrationPromise;
  }
  function fallbackToast(title, body) {
    try {
      var box = document.getElementById("helenshop-notify-toast");
      if (!box) {
        box = document.createElement("div");
        box.id = "helenshop-notify-toast";
        box.setAttribute("role", "status");
        box.setAttribute("aria-live", "polite");
        box.style.cssText = "position:fixed;right:16px;left:16px;bottom:92px;z-index:9999;margin:auto;max-width:420px;border-radius:22px;padding:12px 16px;background:var(--surface,var(--card-solid,#1a2742));color:var(--text,#fff);border:1px solid var(--border,var(--line,rgba(255,255,255,.14)));box-shadow:0 18px 44px rgba(0,0,0,.35);font:700 14px/1.7 inherit;text-align:right;display:none";
        document.body.appendChild(box);
      }
      box.innerHTML = "";
      var strong = document.createElement("strong");
      strong.textContent = title || "HelenShop";
      var span = document.createElement("span");
      span.style.cssText = "display:block;font-weight:400;opacity:.85";
      span.textContent = body || "";
      box.appendChild(strong);
      box.appendChild(span);
      box.style.display = "block";
      clearTimeout(box._hideTimer);
      box._hideTimer = setTimeout(function () { box.style.display = "none"; }, 6500);
    } catch (e) {}
  }
  function show(title, body, options) {
    var opts = options || {};
    var key = opts.key || opts.tag || "";
    if (key && alreadySeen(key)) return Promise.resolve(false);
    if (key) remember(key);
    var payload = {
      title: title || "HelenShop",
      body: body || "",
      tag: opts.tag || key || "helenshop",
      url: opts.url || location.href
    };
    playBell();
    if (permission() !== "granted") {
      fallbackToast(payload.title, payload.body);
      return Promise.resolve(false);
    }
    return register().then(function (reg) {
      var note = {
        body: payload.body,
        tag: payload.tag,
        dir: "rtl",
        lang: "fa",
        silent: false,
        vibrate: [90, 40, 90],
        data: { url: payload.url }
      };
      if (reg && reg.showNotification) return reg.showNotification(payload.title, note).then(function () { return true; });
      try {
        var n = new Notification(payload.title, note);
        n.onclick = function () { window.focus(); n.close(); };
        return true;
      } catch (e) {
        fallbackToast(payload.title, payload.body);
        return false;
      }
    }).catch(function () {
      fallbackToast(payload.title, payload.body);
      return false;
    });
  }
  function urlBase64ToUint8Array(base64String) {
    var padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    var raw = atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function sameKey(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function subscribePush(dataLayer, input) {
    var config = root.HELENSHOP_CONFIG || {};
    var vapid = config.VAPID_PUBLIC_KEY || "";
    if (!vapid || !dataLayer || !dataLayer.savePushSubscription) return Promise.resolve({ ok: false, reason: "vapid-not-configured" });
    if (permission() !== "granted") return Promise.resolve({ ok: false, reason: "permission-not-granted" });
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return Promise.resolve({ ok: false, reason: "push-unsupported" });
    var wantedKey = urlBase64ToUint8Array(vapid);
    return register().then(function (reg) {
      if (!reg || !reg.pushManager) return { ok: false, reason: "push-unsupported" };
      return reg.pushManager.getSubscription().then(function (existing) {
        if (existing && existing.options && existing.options.applicationServerKey) {
          var currentKey = new Uint8Array(existing.options.applicationServerKey);
          if (!sameKey(currentKey, wantedKey)) {
            return existing.unsubscribe().then(function () {
              return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wantedKey });
            });
          }
        }
        return existing || reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: wantedKey
        });
      }).then(function (sub) {
        return dataLayer.savePushSubscription(Object.assign({}, input || {}, { subscription: sub.toJSON() }));
      }).then(function () { return { ok: true }; });
    }).catch(function () { return { ok: false, reason: "subscribe-failed" }; });
  }
  function refreshSubscription(dataLayer, input) {
    if (permission() !== "granted") return Promise.resolve({ ok: false, reason: "permission-not-granted" });
    return subscribePush(dataLayer, input);
  }
  function requestPermission(dataLayer, input) {
    unlockBell();
    if (!supported()) return Promise.resolve({ permission: "unsupported", push: { ok: false, reason: "unsupported" } });
    return register().then(function () {
      if (Notification.permission === "granted") return "granted";
      if (Notification.permission === "denied") return "denied";
      return Notification.requestPermission();
    }).then(function (perm) {
      if (perm !== "granted") return { permission: perm, push: { ok: false, reason: "permission-not-granted" } };
      return subscribePush(dataLayer, input).then(function (push) { return { permission: perm, push: push }; });
    }).catch(function () { return { permission: permission(), push: { ok: false, reason: "permission-failed" } }; });
  }

  root.HelenNotify = {
    supported: supported,
    permission: permission,
    register: register,
    requestPermission: requestPermission,
    subscribePush: subscribePush,
    refreshSubscription: refreshSubscription,
    show: show,
    playBell: playBell,
    unlockBell: unlockBell,
    alreadySeen: alreadySeen,
    remember: remember
  };

  if (typeof document !== "undefined") {
    document.addEventListener("pointerdown", unlockBell, { once: true });
    document.addEventListener("keydown", unlockBell, { once: true });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { register(); });
    else register();
  }
})(typeof window !== "undefined" ? window : globalThis);
