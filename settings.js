// Ayarlar. Masaüstünde kullanıcı klasöründe (settings.json), sunucuda (headless) ortam
// değişkenlerinden okunur. Forge hiçbir ana anahtar tutmaz: yalnızca bu bilgisayarın anahtarı
// (Animke hesabıyla giriş yapılınca site verir; sunucuda yönetim panelinden alınır).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULTS = {
  siteUrl: "https://animke.com",
  token: "",
  /** "both": 1080p + 720p (yavaş internet/telefon için), "1080": yalnızca ana kalite */
  quality: "both",
  /** "auto" | "nvenc" (NVIDIA) | "qsv" (Intel) | "amf" (AMD) | "cpu" */
  encoder: "auto",
  /** Onaylı işleyicide: diğer ekiplerin bölümlerine de yardım et */
  help: true,
  /** Onaylı işleyicide: boştayken Reels videolarını küçült */
  reels: true,
  /** Yükleme hız sınırı (Mbit/sn, 0 = sınırsız) */
  uploadLimitMbps: 0,
  /** Yalnızca belirli saatlerde çalış */
  schedule: { enabled: false, from: "01:00", to: "09:00" },
  /** Geçici dosyalar (boş: sistemin geçici klasörü) */
  workDir: "",
  /** Kendi ffmpeg'in (boş: uygulamayla gelen) */
  ffmpegPath: "",
  notifyDone: true,
  notifyFail: true,
  startAtLogin: false,
  /** İzlenen klasör: içine düşen bölümler kendiliğinden yüklenir */
  watchEnabled: false,
  watchDir: "",
  /** Yüklenen dosya: "move" → klasördeki "Yüklendi" alt klasörüne taşı, "keep" → yerinde bırak */
  afterUpload: "move",
  /** Forge'a sürüklenen dosyalarda yayına almadan önce önizleme + opening/ending işaretleme */
  preview: true,
};

const clone = (o) => JSON.parse(JSON.stringify(o));

function sanitize(raw) {
  const s = { ...clone(DEFAULTS), ...(raw || {}) };
  s.siteUrl = String(s.siteUrl || DEFAULTS.siteUrl).trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+$/i.test(s.siteUrl)) s.siteUrl = DEFAULTS.siteUrl;
  s.token = String(s.token || "").trim();
  if (!["both", "1080"].includes(s.quality)) s.quality = "both";
  if (!["auto", "nvenc", "qsv", "amf", "cpu"].includes(s.encoder)) s.encoder = "auto";
  s.help = s.help !== false;
  s.reels = s.reels !== false;
  s.uploadLimitMbps = Math.max(0, Math.min(10_000, Number(s.uploadLimitMbps) || 0));
  const time = (t, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(t)) ? String(t) : d);
  s.schedule = {
    enabled: !!s.schedule?.enabled,
    from: time(s.schedule?.from, DEFAULTS.schedule.from),
    to: time(s.schedule?.to, DEFAULTS.schedule.to),
  };
  s.workDir = String(s.workDir || "");
  s.ffmpegPath = String(s.ffmpegPath || "");
  s.notifyDone = s.notifyDone !== false;
  s.notifyFail = s.notifyFail !== false;
  s.startAtLogin = !!s.startAtLogin;
  s.watchEnabled = !!s.watchEnabled;
  s.watchDir = String(s.watchDir || "");
  if (!["move", "keep"].includes(s.afterUpload)) s.afterUpload = "move";
  s.preview = s.preview !== false;
  return s;
}

/** Masaüstü: JSON dosyası. */
class FileSettings {
  constructor(file) {
    this.file = file;
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // ilk açılış
    }
    this.value = sanitize(raw);
  }
  get() {
    return clone(this.value);
  }
  update(patch) {
    this.value = sanitize({ ...this.value, ...patch, schedule: { ...this.value.schedule, ...(patch.schedule || {}) } });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.value, null, 2));
    return this.get();
  }
}

function parseEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {
    // dosya yok
  }
  return out;
}

/**
 * Sunucu (headless): ortam değişkenleri ya da çalışma klasöründeki .env
 *   ANIMKE_WORKER_TOKEN (zorunlu), ANIMKE_SITE_URL, ANIMKE_ENCODER (auto|nvenc|qsv|amf|cpu),
 *   ANIMKE_CPU_ONLY=1 (eski ad, = cpu), ANIMKE_QUALITY (both|1080), ANIMKE_HELP=0, ANIMKE_REELS=0,
 *   ANIMKE_UPLOAD_LIMIT_MBPS, ANIMKE_WORK_DIR, FFMPEG_PATH
 */
class EnvSettings {
  constructor() {
    const env = { ...parseEnvFile(process.env.ANIMKE_ENV_FILE || path.join(process.cwd(), ".env")), ...process.env };
    const off = (v) => /^(0|false|hayir|hayır)$/i.test(String(v || ""));
    this.value = sanitize({
      siteUrl: env.ANIMKE_SITE_URL,
      token: env.ANIMKE_WORKER_TOKEN,
      encoder: /^(1|true|evet)$/i.test(String(env.ANIMKE_CPU_ONLY || "")) ? "cpu" : env.ANIMKE_ENCODER,
      quality: env.ANIMKE_QUALITY,
      help: !off(env.ANIMKE_HELP),
      reels: !off(env.ANIMKE_REELS),
      uploadLimitMbps: env.ANIMKE_UPLOAD_LIMIT_MBPS,
      workDir: env.ANIMKE_WORK_DIR,
      ffmpegPath: env.FFMPEG_PATH,
    });
  }
  get() {
    return clone(this.value);
  }
  update(patch) {
    this.value = sanitize({ ...this.value, ...patch });
    return this.get();
  }
}

/** ffmpeg/ffprobe: ayardaki yol → uygulamayla gelen → PATH. */
function binaries(settings) {
  const unpacked = (p) => (p ? p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`) : p);
  let ffmpeg = settings.ffmpegPath || "";
  let ffprobe = settings.ffmpegPath ? path.join(path.dirname(settings.ffmpegPath), path.basename(settings.ffmpegPath).replace(/ffmpeg/i, "ffprobe")) : "";
  if (!ffmpeg) {
    try {
      ffmpeg = unpacked(require("ffmpeg-static"));
    } catch {
      ffmpeg = "ffmpeg";
    }
  }
  if (!ffprobe) {
    try {
      ffprobe = unpacked(require("ffprobe-static").path);
    } catch {
      ffprobe = "ffprobe";
    }
  }
  if (ffmpeg !== "ffmpeg" && !fs.existsSync(ffmpeg)) ffmpeg = "ffmpeg";
  if (ffprobe !== "ffprobe" && !fs.existsSync(ffprobe)) ffprobe = "ffprobe";
  return { ffmpeg, ffprobe };
}

/** Motorun kullandığı çalışma ayarları. */
function runtimeConfig(settings) {
  const { ffmpeg, ffprobe } = binaries(settings);
  return {
    siteUrl: settings.siteUrl,
    token: settings.token,
    ffmpeg,
    ffprobe,
    workDir: settings.workDir || path.join(os.tmpdir(), "animke-forge"),
    encoder: settings.encoder,
    cpuOnly: settings.encoder === "cpu",
    quality: settings.quality,
    help: settings.help,
    reels: settings.reels,
    uploadLimitBps: settings.uploadLimitMbps ? (settings.uploadLimitMbps * 1_000_000) / 8 : 0,
    schedule: settings.schedule,
    watchEnabled: settings.watchEnabled,
    watchDir: settings.watchDir,
    afterUpload: settings.afterUpload,
    preview: settings.preview,
    // Site "hello" yanıtıyla güncellenir.
    limits: { maxGb: 4, maxBytes: 4 * 1024 ** 3, minSeconds: 30, maxMinutes: 180 },
  };
}

module.exports = { DEFAULTS, FileSettings, EnvSettings, runtimeConfig, sanitize };
