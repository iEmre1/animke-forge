const $ = (id) => document.getElementById(id);
const I = window.ICONS;
const BADGE = {
  starting: "Başlatılıyor",
  idle: "Boşta",
  working: "Çalışıyor",
  paused: "Duraklatıldı",
  waiting: "Saat dışında",
  error: "Hata",
  auth: "Giriş gerekli",
};
const PAGES = {
  dashboard: "Pano",
  upload: "Yükle",
  preview: "Önizleme",
  queue: "Sıra",
  history: "Geçmiş",
  logs: "Kayıt",
  settings: "Ayarlar",
  guide: "Rehber",
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const size = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);
const timeAgo = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return "az önce";
  if (s < 3600) return `${Math.floor(s / 60)} dk önce`;
  return `${Math.floor(s / 3600)} sa önce`;
};

// --- simgeler -------------------------------------------------------------------------
for (const btn of document.querySelectorAll(".rail-btn[data-view]")) btn.insertAdjacentHTML("afterbegin", I[btn.dataset.view]);
$("rail-site").innerHTML = I.site;
$("rail-quit").innerHTML = I.power;
$("rail-update").innerHTML = I.update;

// --- görünümler -------------------------------------------------------------------------
let view = "dashboard";
let lastState = null;
function show(next) {
  view = next;
  for (const btn of document.querySelectorAll(".rail [data-view]")) btn.classList.toggle("active", btn.dataset.view === next && btn.classList.contains("rail-btn"));
  if (next === "settings") void loadSettings();
  render();
}
for (const el of document.querySelectorAll("[data-view]")) el.addEventListener("click", () => show(el.dataset.view));
for (const el of document.querySelectorAll("[data-goto]")) el.addEventListener("click", () => show(el.dataset.goto));

function render() {
  const needsLogin = lastState?.state === "auth" && !lastState?.device;
  document.body.classList.toggle("logged-out", !!needsLogin);
  $("welcome").classList.toggle("hidden", !needsLogin);
  for (const name of Object.keys(PAGES)) $(`view-${name}`).classList.toggle("hidden", needsLogin || view !== name);
  $("tb-page").textContent = needsLogin ? "Giriş" : PAGES[view];
}

let autoScroll = true;
$("logs").addEventListener("scroll", () => {
  const el = $("logs");
  autoScroll = el.scrollTop + el.clientHeight >= el.scrollHeight - 10;
});
$("copy-logs").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("logs").textContent).catch(() => {});
  toast("Kayıt kopyalandı");
});

let toastTimer = 0;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2500);
}

const STEP_ORDER = ["downloading", "encoding", "uploading", "done"];
const ENC = { auto: "Otomatik", nvenc: "NVIDIA", qsv: "Intel", amf: "AMD", cpu: "İşlemci" };

window.isleyici.onState((s) => {
  lastState = s;
  const badge = $("badge");
  badge.textContent = BADGE[s.state] || s.state;
  badge.className = `badge ${s.state}`;
  $("pause-text").textContent = s.paused ? "Devam et" : "Duraklat";
  $("pause-icon").innerHTML = s.paused ? I.play : I.pause;
  $("pause").classList.toggle("on", !!s.paused);
  $("version").textContent = s.version ? `Animke Forge v${s.version}` : "";

  // Hesap simgesi: bilgisayar adının baş harfi
  const d = s.device;
  $("rail-account").textContent = d ? d.name.trim().charAt(0).toUpperCase() : "?";
  $("rail-account").dataset.tip = d ? `${d.name} · ${d.team}` : "Giriş yapılmamış";
  $("rail").dataset.state = s.state;

  // Pano: şu anki iş
  const c = s.current;
  const pct = c ? Number(c.progress) || 0 : 0;
  $("hero").classList.toggle("active", !!c);
  $("hero-eyebrow").textContent = c ? (c.team === "Reels" ? "Reels küçültülüyor" : `Şu anki iş · ${c.team || ""}`) : "Şu anki iş";
  $("hero-title").textContent = c
    ? c.title
    : s.paused
      ? "Duraklatıldı"
      : s.state === "waiting"
        ? "Çalışma saatleri dışında"
        : s.state === "error"
          ? "Bağlantı sorunu"
          : "Yeni iş bekleniyor";
  $("hero-sub").textContent = c ? c.stage || "" : s.message || "";
  $("hero-pct").textContent = c ? `%${pct}` : "";
  $("bar-fill").style.width = `${c ? pct : 0}%`;
  const step = c ? STEP_ORDER.indexOf(c.status) : -1;
  for (const el of document.querySelectorAll("#steps [data-step]")) {
    const i = STEP_ORDER.indexOf(el.dataset.step);
    el.className = step < 0 ? "" : i < step ? "done" : i === step ? "now" : "";
  }

  // Kutucuklar
  const st = s.stats || {};
  $("t-done").textContent = String(st.done || 0);
  $("t-bytes").textContent = size(st.bytes || 0);
  $("t-avg").textContent = st.done ? `${Math.max(1, Math.round((st.seconds || 0) / st.done / 60))} dk` : "—";
  const queue = s.queue || [];
  $("t-queue").textContent = String(queue.length);
  $("queue-dot").textContent = queue.length > 9 ? "9+" : String(queue.length);
  $("queue-dot").classList.toggle("hidden", !queue.length);

  // Bu bilgisayar
  $("device").innerHTML = d
    ? `<div class="dev-name">${esc(d.name)}</div>
       <div class="dev-row"><span>Ekip</span><b>${esc(d.team)}</b></div>
       <div class="dev-row"><span>Yetki</span><b class="${d.approved ? "ok" : ""}">${d.approved ? "Tüm ekipler + Reels" : "Yalnızca kendi ekibi"}</b></div>
       <div class="dev-row"><span>Kodlayıcı</span><b>${ENC[s.encoder] || "Otomatik"}</b></div>
       ${st.failed ? `<div class="dev-row"><span>Hata</span><b class="bad">${st.failed}</b></div>` : ""}`
    : `<span class="muted">${s.state === "auth" ? "Giriş bekleniyor" : "Bağlanılıyor…"}</span>`;

  // Listeler
  const recent = s.recent || [];
  const recentItem = (r) =>
    `<li class="${r.ok ? "ok" : "fail"}"><span class="li-icon">${r.ok ? I.check : I.x}</span><div class="min0"><div class="li-title">${esc(r.title)}</div><div class="note">${esc(r.note || "")}${r.at ? ` · ${timeAgo(r.at)}` : ""}</div></div></li>`;
  $("recent-mini").innerHTML = recent.length ? recent.slice(0, 4).map(recentItem).join("") : `<li class="empty">Henüz yok</li>`;
  $("recent").innerHTML = recent.length ? recent.map(recentItem).join("") : `<li class="empty">Bu oturumda henüz bölüm işlenmedi.</li>`;
  $("queue-count").textContent = queue.length ? `${queue.length} bölüm` : "";
  $("queue").innerHTML = queue.length
    ? queue
        .map(
          (q, i) =>
            `<li><span class="li-num">${i + 1}</span><div class="min0"><div class="li-title">${esc(q.title)}</div><div class="note">${esc(q.team || "")}</div></div></li>`,
        )
        .join("")
    : `<li class="empty">Sırada bölüm yok. Yeni yüklemeler buraya düşer.</li>`;

  const logs = $("logs");
  logs.textContent = (s.logs || []).join("\n");
  if (autoScroll) logs.scrollTop = logs.scrollHeight;
  render();
});

// --- giriş ------------------------------------------------------------------------------
$("login-start").addEventListener("click", () => {
  $("welcome-error").textContent = "";
  $("login-start").disabled = true;
  window.isleyici.loginStart();
});
$("login-open").addEventListener("click", () => window.isleyici.loginOpen());
$("login-cancel").addEventListener("click", () => window.isleyici.loginCancel());
window.isleyici.onLogin((l) => {
  const waiting = l?.state === "waiting";
  $("login-idle").classList.toggle("hidden", waiting);
  $("login-waiting").classList.toggle("hidden", !waiting);
  $("login-start").disabled = false;
  if (waiting) $("login-code").textContent = l.code;
  $("welcome-error").textContent = l?.state === "error" ? l.message : "";
  if (l?.state === "done") {
    show("dashboard");
    toast(l.by ? `@${l.by} olarak bağlandı` : "Bağlandı");
  }
});

const TOKEN_RE = /^awk_[\w-]{20,}$/;
$("welcome-save").addEventListener("click", async () => {
  const token = $("welcome-token").value.trim();
  $("welcome-error").textContent = "";
  if (!TOKEN_RE.test(token)) {
    $("welcome-error").textContent = 'Anahtar "awk_" ile başlamalı.';
    return;
  }
  const res = await window.isleyici.saveSettings({ token });
  if (res?.error) $("welcome-error").textContent = res.error;
  $("welcome-token").value = "";
});

// --- ayarlar ------------------------------------------------------------------------------
async function loadSettings() {
  const s = await window.isleyici.getSettings();
  $("s-token").value = "";
  $("s-token-hint").textContent = s.tokenHint ? `Kayıtlı anahtar: ${s.tokenHint}` : "Anahtar girilmemiş.";
  const d = lastState?.device;
  $("s-account").innerHTML = d
    ? `<b>${esc(d.name)}</b> · ${esc(d.team)}<br /><span class="small">${d.approved ? "Onaylı: tüm ekipler" : "Kendi ekibinin bölümleri"}</span>`
    : s.tokenHint
      ? "Bağlanılıyor…"
      : "Giriş yapılmamış.";
  $("s-logout").classList.toggle("hidden", !s.tokenHint);
  $("s-encoder").value = s.encoder;
  $("s-quality").value = s.quality;
  $("s-help").checked = s.help;
  $("s-reels").checked = s.reels;
  $("s-upload").value = String(s.uploadLimitMbps || 0);
  $("s-sched").checked = s.schedule.enabled;
  $("s-from").value = s.schedule.from;
  $("s-to").value = s.schedule.to;
  $("s-notify-done").checked = s.notifyDone;
  $("s-notify-fail").checked = s.notifyFail;
  $("s-login").checked = s.startAtLogin;
  $("s-workdir").value = s.workDir;
  $("s-ffmpeg").value = s.ffmpegPath;
  $("s-watch").checked = s.watchEnabled;
  $("s-watchdir").value = s.watchDir;
  $("s-after").value = s.afterUpload;
  $("s-preview").checked = s.previewBeforeUpload;
  $("s-saved").textContent = "";
  window.renderMappings?.();
}

$("view-settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = $("s-token").value.trim();
  if (token && !TOKEN_RE.test(token)) {
    $("s-saved").textContent = 'Anahtar "awk_" ile başlamalı.';
    return;
  }
  const res = await window.isleyici.saveSettings({
    ...(token ? { token } : {}),
    encoder: $("s-encoder").value,
    quality: $("s-quality").value,
    help: $("s-help").checked,
    reels: $("s-reels").checked,
    uploadLimitMbps: Number($("s-upload").value) || 0,
    schedule: { enabled: $("s-sched").checked, from: $("s-from").value || "01:00", to: $("s-to").value || "09:00" },
    notifyDone: $("s-notify-done").checked,
    notifyFail: $("s-notify-fail").checked,
    startAtLogin: $("s-login").checked,
    workDir: $("s-workdir").value.trim(),
    ffmpegPath: $("s-ffmpeg").value.trim(),
    watchEnabled: $("s-watch").checked,
    watchDir: $("s-watchdir").value.trim(),
    afterUpload: $("s-after").value,
    previewBeforeUpload: $("s-preview").checked,
  });
  if (res?.error) {
    $("s-saved").textContent = res.error;
    return;
  }
  await loadSettings();
  toast("Ayarlar kaydedildi");
});

$("s-logout").addEventListener("click", async () => {
  const res = await window.isleyici.logout();
  if (!res?.canceled) {
    await loadSettings();
    show("dashboard");
  }
});

// --- güncelleme ve diğer -------------------------------------------------------------------
window.isleyici.onUpdate((u) => {
  $("rail-update").classList.toggle("hidden", !u?.ready);
  if (u?.ready) $("rail-update").dataset.tip = `Güncellemeyi kur (${u.version})${u.busy ? " · iş bitince" : ""}`;
});
$("rail-update").addEventListener("click", () => window.isleyici.installUpdate());
$("pause").addEventListener("click", () => window.isleyici.togglePause());
$("rail-quit").addEventListener("click", () => window.isleyici.quit());
$("rail-site").addEventListener("click", () => window.isleyici.openSite());
show("dashboard");
