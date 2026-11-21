// Animke Forge — masaüstü kabuğu. Pencere kapatılınca sistem tepsisine iner;
// gerçekten kapatmak için tepsi menüsünden "Kapat". Güncellemeler GitHub'dan kendiliğinden gelir.
const path = require("node:path");
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, Notification, shell } = require("electron");
const os = require("node:os");
const { FileSettings, runtimeConfig } = require("./settings");
const { Api } = require("./api");
const { Engine } = require("./engine");
const { LocalQueue } = require("./local");

app.setAppUserModelId("com.animke.forge");
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const ICON = path.join(__dirname, "assets", "icon.png");
const startHidden = process.argv.includes("--hidden");
let win = null;
let tray = null;
let engine = null;
let settings = null;
let quitting = false;
let trayHintShown = false;
let update = { ready: false, version: "" };
let lastState = { state: "starting", message: "Başlatılıyor…", logs: [], queue: [], recent: [] };

const STATE_TEXT = {
  starting: "Başlatılıyor",
  idle: "Boşta — yeni iş bekleniyor",
  working: "Çalışıyor",
  paused: "Duraklatıldı",
  waiting: "Çalışma saatleri dışında",
  error: "Bağlantı hatası",
  auth: "Giriş gerekli",
};

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    title: "Animke Forge",
    icon: ICON,
    show: false,
    backgroundColor: "#090d16",
    autoHideMenuBar: true,
    // Windows'un düğmeleri (küçült/büyüt/kapat) kalır, başlık çubuğu uygulamanın renginde olur.
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#090d16", symbolColor: "#cbd5e1", height: 36 },
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, "ui", "index.html"));
  win.webContents.on("did-finish-load", () => {
    win?.webContents.send("state", lastState);
    win?.webContents.send("update", { ...update, busy: !!lastState.current });
  });
  // Uygulama içinden dış bağlantı açılmaz; sistemin tarayıcısına gider.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.once("ready-to-show", () => {
    if (!startHidden) win.show();
  });

  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({
        title: "Animke Forge arka planda",
        body: 'Çalışmaya devam ediyor. Kapatmak için saatin yanındaki simgeye sağ tıklayıp "Kapat"ı seç.',
        icon: ICON,
      }).show();
    }
  });
}

function showWindow() {
  if (!win) createWindow();
  win.show();
  win.focus();
}

function updateTray() {
  if (!tray) return;
  const s = lastState;
  const detail = s.current ? `${s.current.title} — %${s.current.progress}` : STATE_TEXT[s.state] || s.state;
  tray.setToolTip(`Animke Forge\n${detail}`.slice(0, 127));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Animke Forge", enabled: false },
      { label: detail.slice(0, 60), enabled: false },
      { type: "separator" },
      { label: "Aç", click: showWindow },
      { label: s.paused ? "Devam et" : "Duraklat", click: () => engine?.setPaused(!s.paused), enabled: !!engine },
      ...(update.ready ? [{ label: `Güncellemeyi kur (${update.version})`, click: () => installUpdate() }] : []),
      { type: "separator" },
      { label: "Kapat", click: requestQuit },
    ]),
  );
}

async function confirmBusy(action) {
  if (!lastState.current) return true;
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Vazgeç", `Yine de ${action}`],
    defaultId: 0,
    cancelId: 0,
    title: "Animke Forge",
    message: "Şu an bir iş işleniyor.",
    detail: `${lastState.current.title}\nDevam edersen bu iş sıraya geri döner; baştan işlenir.`,
  });
  return response === 1;
}

async function requestQuit() {
  if (!(await confirmBusy("kapat"))) return;
  quitting = true;
  await Promise.race([engine?.stop(), new Promise((r) => setTimeout(r, 8000))]).catch(() => {});
  tray?.destroy();
  app.quit();
}

// --- otomatik güncelleme ---------------------------------------------------------------
let autoUpdater = null;
function setupUpdates() {
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch {
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", (info) => {
    update = { ready: true, version: info.version };
    win?.webContents.send("update", { ...update, busy: !!lastState.current });
    updateTray();
    // Boştaysa hemen kur (Forge genelde arka planda kendi başına çalışır).
    if (!lastState.current) setTimeout(() => !lastState.current && installUpdate(true), 60_000);
  });
  autoUpdater.on("error", () => {});
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
}

async function installUpdate(silent = false) {
  if (!autoUpdater || !update.ready) return;
  if (!silent && !(await confirmBusy("güncelle"))) return;
  if (silent && lastState.current) return;
  quitting = true;
  await Promise.race([engine?.stop(), new Promise((r) => setTimeout(r, 8000))]).catch(() => {});
  autoUpdater.quitAndInstall(true, true);
}

// --- ayarlar ---------------------------------------------------------------------------
function publicSettings() {
  const s = settings.get();
  const { token, ...rest } = s;
  return { ...rest, tokenHint: token ? `${token.slice(0, 8)}…${token.slice(-4)}` : "" };
}

function applyLoginItem(enabled) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: enabled, args: ["--hidden"] });
}

// --- Animke hesabıyla giriş ("tarayıcıda onayla") ------------------------------------------
let login = null; // { code, url, cancel: () => void }
function sendLogin(data) {
  win?.webContents.send("login", data);
}

async function startLogin() {
  login?.cancel();
  const s = settings.get();
  const api = new Api({ siteUrl: s.siteUrl, token: "" });
  let canceled = false;
  try {
    const link = await api.linkStart(os.hostname());
    login = { code: link.code, url: link.url, cancel: () => (canceled = true) };
    sendLogin({ state: "waiting", code: link.code, url: link.url });
    shell.openExternal(link.url);
    const until = Date.now() + (link.expiresIn || 600) * 1000;
    while (!canceled && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2500));
      if (canceled) break;
      const res = await api.linkPoll(link.code, link.secret).catch(() => null);
      if (res?.status === "approved" && res.token) {
        const next = settings.update({ token: res.token });
        engine?.updateConfig(runtimeConfig(next));
        sendLogin({ state: "done", by: res.approvedBy });
        login = null;
        showWindow();
        return;
      }
      if (res?.status === "expired") break;
    }
    if (!canceled) sendLogin({ state: "error", message: "Süre doldu. Yeniden \"Giriş yap\"a bas." });
  } catch (err) {
    sendLogin({ state: "error", message: err.message });
  }
  login = null;
}

async function logout() {
  await engine?.releaseCurrent();
  const s = settings.get();
  if (s.token) await new Api({ siteUrl: s.siteUrl, token: s.token }).logout().catch(() => {});
  const next = settings.update({ token: "" });
  engine?.updateConfig(runtimeConfig(next));
}

app.whenReady().then(async () => {
  settings = new FileSettings(path.join(app.getPath("userData"), "settings.json"));
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.on("click", showWindow);
  tray.on("double-click", showWindow);
  updateTray();
  createWindow();

  ipcMain.on("toggle-pause", () => engine?.setPaused(!engine.paused));
  ipcMain.on("quit", requestQuit);
  ipcMain.on("install-update", () => installUpdate());
  ipcMain.on("open-site", () => shell.openExternal(`${settings.get().siteUrl}/fansub`));
  ipcMain.handle("get-settings", () => publicSettings());
  ipcMain.on("login-start", () => void startLogin());
  ipcMain.on("login-cancel", () => {
    login?.cancel();
    login = null;
    sendLogin({ state: "idle" });
  });
  ipcMain.on("login-open", () => login && shell.openExternal(login.url));
  ipcMain.handle("logout", async () => {
    if (!(await confirmBusy("çıkış yap"))) return { canceled: true };
    await logout();
    return { ok: true };
  });
  ipcMain.handle("save-settings", async (_e, patch) => {
    try {
      const allowed = [
        "token", "quality", "encoder", "help", "reels", "uploadLimitMbps", "schedule",
        "workDir", "ffmpegPath", "notifyDone", "notifyFail", "startAtLogin",
        "watchEnabled", "watchDir", "afterUpload", "preview",
      ];
      const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.includes(k)));
      const next = settings.update(clean);
      applyLoginItem(next.startAtLogin);
      engine?.updateConfig(runtimeConfig(next));
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  engine = new Engine(runtimeConfig(settings.get()));
  engine.attachLocal(new LocalQueue(engine, path.join(app.getPath("userData"), "yerel.json")));

  // --- yerel dosyalar, önizleme, klasör seçimi ---------------------------------------------
  ipcMain.handle("local-add", (_e, paths) => {
    const results = (Array.isArray(paths) ? paths : []).slice(0, 200).map((p) => engine.local.add(String(p), "drop"));
    return { errors: results.filter((r) => r.error).map((r) => r.error) };
  });
  ipcMain.handle("local-pick-files", async () => {
    const r = await dialog.showOpenDialog(win, {
      title: "Bölüm dosyalarını seç",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Video", extensions: ["mkv", "mp4", "m4v", "mov", "webm", "avi", "ts"] }],
    });
    if (r.canceled) return { errors: [] };
    const results = r.filePaths.map((p) => engine.local.add(p, "drop"));
    return { errors: results.filter((x) => x.error).map((x) => x.error) };
  });
  ipcMain.handle("local-confirm", (_e, id, form) => engine.local.confirm(String(id), form || {}));
  ipcMain.handle("local-search", (_e, id, q) => engine.local.searchFor(String(id), String(q || "")));
  ipcMain.on("local-remove", (_e, id) => engine.local.remove(String(id)));
  ipcMain.on("local-clear", () => engine.local.clearFinished());
  ipcMain.handle("local-mappings", () => engine.local.mappingsView());
  ipcMain.on("local-forget", (_e, key) => engine.local.forget(String(key)));
  ipcMain.on("preview-decision", (_e, decision) => engine.decidePreview(decision));
  ipcMain.handle("pick-folder", async (_e, title) => {
    const r = await dialog.showOpenDialog(win, { title: String(title || "Klasör seç"), properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? "" : r.filePaths[0];
  });
  ipcMain.on("open-folder", (_e, p) => p && shell.openPath(String(p)));
  engine.on("state", (s) => {
    lastState = s;
    win?.webContents.send("state", s);
    updateTray();
  });
  engine.on("preview", (p) => {
    showWindow();
    if (Notification.isSupported()) {
      new Notification({ title: "Önizleme hazır", body: `${p.title}\nYayına almadan önce kontrol et.`, icon: ICON }).show();
    }
  });
  engine.on("needs-confirm", (name) => {
    if (Notification.isSupported()) {
      new Notification({ title: "Onay bekleyen dosya", body: `${name}\nHangi anime olduğunu bir kez seçmen gerekiyor.`, icon: ICON }).show();
    }
  });
  engine.on("done", ({ title, ok, error, warning }) => {
    const s = settings.get();
    if (!Notification.isSupported() || (ok && !s.notifyDone) || (!ok && !s.notifyFail)) return;
    new Notification({
      title: ok ? "Bölüm yayında" : "Bölüm işlenemedi",
      body: ok ? `${title}${warning ? `\n⚠ ${warning}` : ""}` : `${title}\n${error || ""}`.slice(0, 200),
      icon: ICON,
    }).show();
  });
  setupUpdates();
  try {
    await engine.start();
  } catch (err) {
    lastState = { ...engine.snapshot(), state: "error", message: `Başlatılamadı: ${err.message}` };
    win?.webContents.send("state", lastState);
    updateTray();
  }
});

app.on("second-instance", showWindow);
// Pencere gizliyken de çalışmaya devam (tepsi). Sadece "Kapat" ile çıkılır.
app.on("window-all-closed", () => {});
