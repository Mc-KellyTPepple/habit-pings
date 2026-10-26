const C = self.HP_CONFIG;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const isNative = !!(window.Capacitor && typeof Capacitor.isNativePlatform === "function" && Capacitor.isNativePlatform());

/* ---------------- Supabase client + auth ---------------- */
const sb = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: "hp_auth" },
});

async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args || {});
  if (error) throw new Error(error.message);
  return data;
}

// older versions of the app stored a secret device key; it is no longer used
try { localStorage.removeItem("hp_key"); } catch (_) {}

function deviceId() {
  let id = null;
  try { id = localStorage.getItem("hp_device"); } catch (_) {}
  if (!id) {
    id = crypto.randomUUID();
    try { localStorage.setItem("hp_device", id); } catch (_) {}
  }
  return id;
}
const DEVICE_ID = deviceId();

function deviceLabel() {
  if (isNative) return "Android app";
  const ua = navigator.userAgent;
  const b = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${b} on ${os}` : b;
}

/* ---------------- views ---------------- */
let appActive = false;

function showAuth() {
  appActive = false;
  $("appView").hidden = true;
  $("authView").hidden = false;
  $("emailForm").hidden = false;
  $("codeForm").hidden = true;
  $("authErr").hidden = true;
}

function authError(msg) { const e = $("authErr"); e.textContent = msg; e.hidden = !msg; }

async function showApp(session) {
  if (appActive) return;
  appActive = true;
  $("authView").hidden = true;
  $("appView").hidden = false;
  $("who").textContent = session.user.email || "";
  $("apkCard").hidden = isNative;
  $("apkLink").href = C.APK_URL;
  await initThisDevice();
  loadHabits();
}

sb.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_IN" && session) setTimeout(() => showApp(session), 0);
  if (event === "SIGNED_OUT") showAuth();
});

/* ---------------- email code sign-in ---------------- */
let pendingEmail = "";
let cooldown = 0, cooldownTimer = null;

function startCooldown(sec) {
  cooldown = sec;
  clearInterval(cooldownTimer);
  const tick = () => {
    $("resendBtn").disabled = cooldown > 0;
    $("resendBtn").textContent = cooldown > 0 ? `Resend (${cooldown}s)` : "Resend";
    if (cooldown <= 0) clearInterval(cooldownTimer);
    cooldown--;
  };
  tick();
  cooldownTimer = setInterval(tick, 1000);
}

async function sendCode(email) {
  authError("");
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) {
    authError(/rate|too many|seconds/i.test(error.message) ? "Too many attempts. Wait a minute and try again." : error.message);
    return false;
  }
  pendingEmail = email;
  $("codeMsg").textContent = `We sent a code to ${email}. It can take a minute to arrive; check spam too.`;
  $("emailForm").hidden = true;
  $("codeForm").hidden = false;
  $("code").value = "";
  $("code").focus();
  startCooldown(30);
  return true;
}

$("emailForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("sendBtn"); btn.disabled = true;
  await sendCode($("email").value.trim().toLowerCase());
  btn.disabled = false;
});

$("resendBtn").addEventListener("click", () => { if (pendingEmail && cooldown <= 0) sendCode(pendingEmail); });
$("changeEmail").addEventListener("click", () => { clearInterval(cooldownTimer); $("codeForm").hidden = true; $("emailForm").hidden = false; authError(""); });

$("codeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("verifyBtn"); btn.disabled = true; authError("");
  const token = $("code").value.replace(/\s+/g, "");
  const { error } = await sb.auth.verifyOtp({ email: pendingEmail, token, type: "email" });
  if (error) authError(/expired|invalid/i.test(error.message) ? "That code is wrong or has expired. Check it or tap Resend." : error.message);
  btn.disabled = false;
});

$("signOut").addEventListener("click", async () => {
  try { await rpc("remove_device", { p_id: DEVICE_ID }); } catch (_) {} // stop pings to this device
  await sb.auth.signOut();
});

$("delAcct").addEventListener("click", async () => {
  if (!confirm("Delete your account, all habits and devices? This cannot be undone.")) return;
  try { await rpc("delete_account"); } catch (e) { alert(e.message); return; }
  await sb.auth.signOut().catch(() => {});
  showAuth();
});

/* ---------------- push registration ---------------- */
const b64ToU8 = (s) => {
  const p = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + p).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const webSupported = !isNative && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function registerWeb() {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(C.VAPID_PUBLIC) });
  await rpc("register_device", {
    p_id: DEVICE_ID, p_channel: "web", p_label: deviceLabel(),
    p_endpoint: sub.endpoint, p_p256dh: toB64(sub.getKey("p256dh")), p_auth: toB64(sub.getKey("auth")),
  });
}

let nativeListening = false;
async function registerNative(askPermission) {
  const PN = window.Capacitor.Plugins.PushNotifications;
  let perm = await PN.checkPermissions();
  if (perm.receive !== "granted" && askPermission) perm = await PN.requestPermissions();
  if (perm.receive !== "granted") { await refreshDevices(); return; }
  if (!nativeListening) {
    nativeListening = true;
    try { await PN.createChannel({ id: "default", name: "Habit pings", importance: 5, visibility: 1 }); } catch (_) {}
    await PN.addListener("registration", async (t) => {
      try {
        await rpc("register_device", { p_id: DEVICE_ID, p_channel: "fcm", p_label: deviceLabel(), p_fcm_token: t.value });
      } catch (e) { $("thisMsg").textContent = "Couldn't register this phone: " + e.message; }
      await refreshDevices();
    });
    await PN.addListener("registrationError", (e) => { $("thisMsg").textContent = "Push registration failed: " + (e && e.error ? e.error : "unknown error"); });
    await PN.addListener("pushNotificationReceived", () => loadHabits());
    await PN.addListener("pushNotificationActionPerformed", (a) => {
      const tok = a && a.notification && a.notification.data && a.notification.data.token;
      if (tok) rpc("touch_by_token", { p_token: tok }).catch(() => {});
      loadHabits();
    });
  }
  await PN.register();
}

/* ---------------- this device + device list ---------------- */
let devices = [];

async function initThisDevice() {
  try {
    if (isNative) await registerNative(false);
    else if (webSupported) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
      navigator.serviceWorker.addEventListener("message", (e) => { if (e.data && e.data.type === "refresh") loadHabits(); });
      if (Notification.permission === "granted") await registerWeb();
    }
  } catch (_) {}
  await refreshDevices();
}

async function refreshDevices() {
  try { devices = (await rpc("list_devices")) || []; } catch (e) { $("devices").innerHTML = `<p class="meta">Couldn't load devices: ${esc(e.message)}</p>`; return; }
  const mine = devices.find((d) => d.id === DEVICE_ID);
  const btn = $("thisBtn"), msg = $("thisMsg");
  btn.hidden = true; btn.onclick = null;
  const where = isNative ? "this phone" : "this browser";

  if (mine && mine.ready && mine.enabled) {
    msg.textContent = `Pings arrive on ${where}.`;
  } else if (mine && mine.ready && !mine.enabled) {
    msg.textContent = `Pings are off for ${where}.`;
    btn.textContent = "Turn on"; btn.hidden = false;
    btn.onclick = async () => { btn.disabled = true; await rpc("set_device_enabled", { p_id: DEVICE_ID, p_enabled: true }).catch((e) => alert(e.message)); btn.disabled = false; refreshDevices(); };
  } else if (isNative) {
    msg.textContent = "Allow notifications to receive pings on this phone.";
    btn.textContent = "Enable notifications"; btn.hidden = false;
    btn.onclick = () => registerNative(true).catch((e) => alert(e.message));
  } else if (!webSupported) {
    msg.textContent = "This browser can't receive push notifications. On iPhone, add the app to your Home Screen and open it from there, or use the Android app.";
  } else if (Notification.permission === "denied") {
    msg.textContent = "Notifications are blocked for this site. Allow them in your browser or phone settings, then reload.";
  } else {
    msg.textContent = "Turn on notifications to get your pings in this browser.";
    btn.textContent = "Enable notifications"; btn.hidden = false;
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        if ((await Notification.requestPermission()) === "granted") await registerWeb();
      } catch (e) { alert(e.message); }
      btn.disabled = false;
      refreshDevices();
    };
  }

  $("devices").innerHTML = devices.length ? devices.map((d) => `
    <div class="dev row" data-id="${d.id}">
      <div><strong>${esc(d.label || (d.channel === "fcm" ? "Android app" : "Browser"))}</strong>${d.id === DEVICE_ID ? '<span class="tag">This device</span>' : ""}
        <p class="meta">${d.channel === "fcm" ? "Android app" : "Browser"} · ${d.ready ? (d.enabled ? "On" : "Off") : "Not ready"}</p></div>
      <div class="actions">
        <button class="ghost" data-dact="toggle">${d.enabled ? "Turn off" : "Turn on"}</button>
        ${d.id === DEVICE_ID ? "" : '<button class="ghost" data-dact="remove">Remove</button>'}
      </div></div>`).join("") : '<p class="meta">No devices yet.</p>';
}

$("devices").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-dact]");
  if (!b) return;
  const id = b.closest(".dev").dataset.id;
  const d = devices.find((x) => x.id === id);
  b.disabled = true;
  try {
    if (b.dataset.dact === "toggle") await rpc("set_device_enabled", { p_id: id, p_enabled: !d.enabled });
    else if (confirm("Remove this device?")) await rpc("remove_device", { p_id: id });
  } catch (err) { alert(err.message); }
  refreshDevices();
});

/* ---------------- habits ---------------- */
function fmtExpiry(iso) {
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return { t: "expiring now", soon: true };
  const h = Math.floor(ms / 36e5);
  if (h < 24) return { t: `expires in ${h}h`, soon: true };
  return { t: `expires in ${Math.floor(h / 24)}d ${h % 24}h`, soon: false };
}

async function loadHabits() {
  let habits;
  try { habits = await rpc("list_habits"); } catch (e) { $("list").innerHTML = `<p class="empty">Couldn't load: ${esc(e.message)}</p>`; return; }
  if (!habits.length) { $("list").innerHTML = `<p class="empty">No habits yet. Add one above.</p>`; return; }
  $("list").innerHTML = habits.map((h) => {
    const ex = fmtExpiry(h.expires_at);
    return `<section class="card habit" data-id="${h.id}">
      <div class="row"><h3>${esc(h.name)}</h3>
        <span class="badge ${h.done_today ? "done" : ""}">${h.done_today ? "Done today" : "Pending"}</span></div>
      <p class="meta">${h.times.join(" · ")} · <span class="badge ${ex.soon ? "soon" : ""}">${ex.t}</span></p>
      <div class="actions">
        <button data-act="done" ${h.done_today ? "disabled" : ""}>Mark done</button>
        <button class="ghost" data-act="del">Delete</button>
      </div></section>`;
  }).join("");
}

$("list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.closest(".habit").dataset.id;
  btn.disabled = true;
  try {
    if (btn.dataset.act === "done") await rpc("complete_habit", { p_id: id });
    else if (confirm("Delete this habit?")) await rpc("delete_habit", { p_id: id });
  } catch (err) { alert(err.message); }
  loadHabits();
});

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter; btn.disabled = true;
  try {
    await rpc("create_habit", {
      p_name: $("name").value,
      p_times: [$("t1").value, $("t2").value, $("t3").value],
      p_tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    });
    $("name").value = "";
  } catch (err) { alert(err.message); }
  btn.disabled = false;
  loadHabits();
});

/* ---------------- start up ---------------- */
(async () => {
  const { data } = await sb.auth.getSession();
  if (data.session) showApp(data.session); else showAuth();
})();

// refresh when returning to the app; no polling, so no needless Supabase traffic
document.addEventListener("visibilitychange", () => { if (!document.hidden && appActive) { loadHabits(); refreshDevices(); } });
