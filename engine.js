// İş döngüsü: siteden sıradaki işi alır (/api/worker/claim), işler, yükler, bitirir.
// İşleyici veritabanına ya da depoya doğrudan erişmez; site yalnızca üstlenilen işe izin verir.
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { Api, putFile, VERSION } = require("./api");
const { downloadSource } = require("./download");
const media = require("./media");
const { missingFonts } = require("./fontcheck");
const { ReelCompressor } = require("./reels");
const preview = require("./preview");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class CanceledError extends Error {}

// Genel ilerleme: indirme %0-30, encode %30-85, yükleme %85-100
const WEIGHTS = { downloading: [0, 30], encoding: [30, 85], uploading: [85, 100] };
const overall = (status, fraction) => {
  const [a, b] = WEIGHTS[status] || [0, 100];
  return Math.round(a + (b - a) * Math.max(0, Math.min(1, fraction)));
};
const mb = (n) => `${Math.round(n / 1024 / 1024)} MB`;
const safeName = (s) => String(s).replace(/[^\w.\- ]+/g, "_").slice(0, 100);

/** Şu an çalışma saatleri içinde miyiz? (ör. 01:00-09:00, gece yarısını geçebilir) */
function inSchedule(schedule, now = new Date()) {
  if (!schedule?.enabled) return true;
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const cur = now.getHours() * 60 + now.getMinutes();
  const from = toMin(schedule.from);
  const to = toMin(schedule.to);
  if (from === to) return true;
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

class Engine extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.api = new Api(cfg);
    this.paused = false;
    this.stopped = false;
    this.state = "starting"; // starting | idle | working | paused | waiting | error | auth
    this.message = "Başlatılıyor…";
    this.device = null; // { name, team, approved }
    this.current = null; // { id, title, status, stage, progress }
    this.queue = [];
    this.recent = [];
    this.logs = [];
    this.stats = { done: 0, failed: 0, bytes: 0, seconds: 0 };
    this.abort = null;
    this.reels = new ReelCompressor(this);
    this.local = null; // masaüstünde: sürüklenen / izlenen klasördeki dosyalar (local.js)
    this.pendingPreview = null; // { data, resolve }
  }

  /** Masaüstü sürümü yerel dosya sırasını bağlar (sunucuda yok). */
  attachLocal(local) {
    this.local = local;
  }
  settings() {
    return this.cfg;
  }

  // --- durum yayını ----------------------------------------------------------------
  snapshot() {
    return {
      state: this.paused && !this.current ? "paused" : this.state,
      message: this.message,
      paused: this.paused,
      current: this.current,
      queue: this.queue,
      recent: this.recent,
      logs: this.logs.slice(-120),
      device: this.device,
      stats: this.stats,
      version: VERSION,
      encoder: this.cfg.encoder,
      local: this.local ? this.local.view() : [],
      canLocal: !!this.device && Number(this.device.translatorId) > 0,
      preview: this.pendingPreview ? this.pendingPreview.data : null,
    };
  }
  emitState() {
    this.emit("state", this.snapshot());
  }
  log(text) {
    const line = `${new Date().toLocaleTimeString("tr-TR")}  ${text}`;
    this.logs.push(line);
    if (this.logs.length > 400) this.logs.splice(0, this.logs.length - 400);
    this.emit("log", line);
    this.emitState();
  }
  setState(state, message) {
    this.state = state;
    this.message = message;
    this.emitState();
  }
  idleState() {
    if (this.paused) return ["paused", "Duraklatıldı"];
    if (!inSchedule(this.cfg.schedule)) return ["waiting", `Çalışma saatleri dışında (${this.cfg.schedule.from}–${this.cfg.schedule.to})`];
    return ["idle", "Yeni iş bekleniyor"];
  }

  /** Ayarlar değişince (yeniden başlatmadan). */
  updateConfig(cfg) {
    const tokenChanged = cfg.token !== this.cfg.token || cfg.siteUrl !== this.cfg.siteUrl;
    this.cfg = { ...cfg, limits: this.cfg.limits };
    this.api = new Api(this.cfg);
    if (tokenChanged) {
      this.device = null;
      this.hello().catch(() => {});
    }
    if (!this.current) this.setState(...this.idleState());
  }

  // --- yaşam döngüsü --------------------------------------------------------------
  async start() {
    fs.mkdirSync(this.cfg.workDir, { recursive: true });
    // Bilgisayar iş ortasında kapandıysa önceki işlerden kalan klasörleri temizle.
    for (const name of fs.readdirSync(this.cfg.workDir)) {
      if (!/^[a-z0-9]{15}$/.test(name)) continue;
      fs.rmSync(path.join(this.cfg.workDir, name), { recursive: true, force: true });
    }
    await this.hello().catch(() => {});
    this.hbTimer = setInterval(() => this.heartbeat(), 25_000);
    this.loop();
  }

  /** Anahtar geçerli mi, hangi ekip, onaylı mı. */
  async hello() {
    if (!this.cfg.token) {
      this.device = null;
      this.setState("auth", "Giriş yapılmamış. Animke hesabınla giriş yap.");
      return false;
    }
    try {
      const data = await this.api.hello();
      const first = !this.device;
      this.device = data.device;
      const l = data.limits || {};
      this.cfg.limits = {
        maxGb: l.maxGb || 4,
        maxBytes: (l.maxGb || 4) * 1024 ** 3,
        minSeconds: l.minSeconds || 30,
        maxMinutes: l.maxMinutes || 180,
      };
      if (first) {
        this.log(
          `Bağlandı: ${data.device.name} · ${data.device.team}${data.device.approved ? " · onaylı (tüm ekipler)" : " · yalnızca kendi ekibinin bölümleri"}`,
        );
      }
      if (this.state === "auth" || this.state === "starting" || this.state === "error") this.setState(...this.idleState());
      this.heartbeat();
      return true;
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        this.device = null;
        this.setState("auth", err.message || "Bu bilgisayarın bağlantısı kaldırılmış. Yeniden giriş yap.");
      } else {
        this.setState("error", err.message);
      }
      throw err;
    }
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.hbTimer);
    const cur = this.current;
    this.abort?.abort();
    // Süren iş başkası alabilsin diye sıraya geri bırakılır.
    if (cur?.kind === "job") await this.api.job(cur.id, "fail", { release: true }).catch(() => {});
    if (cur?.kind === "reel") await this.api.reel(cur.id, "fail", { release: true }).catch(() => {});
    await this.api.heartbeat("offline").catch(() => {});
  }

  /** Süren işi bırak (çıkış yapılırken): iş sıraya geri döner, başkası alır. */
  async releaseCurrent() {
    const cur = this.current;
    if (!cur) return;
    this.releasing = true;
    this.abort?.abort();
    if (cur.kind === "job") await this.api.job(cur.id, "fail", { release: true }).catch(() => {});
    if (cur.kind === "reel") await this.api.reel(cur.id, "fail", { release: true }).catch(() => {});
  }

  setPaused(value) {
    this.paused = value;
    if (!this.current) this.setState(...this.idleState());
    this.heartbeat();
    this.log(value ? "Duraklatıldı (şu anki iş bitince yenisi alınmaz)." : "Devam ediliyor.");
  }

  heartbeat() {
    if (!this.device) return;
    const state = this.current ? "working" : this.idleState()[0];
    this.api
      .heartbeat(state, this.current?.kind === "job" ? this.current.id : "")
      .then((r) => {
        if (this.device && typeof r?.approved === "boolean" && r.approved !== this.device.approved) {
          this.device.approved = r.approved;
          this.log(r.approved ? "Yönetici onayladı: artık tüm ekiplerin bölümleri işlenebilir." : "Onay kaldırıldı: yalnızca kendi ekibinin bölümleri.");
        }
      })
      .catch((err) => {
        if (err.status === 401 || err.status === 403) {
          this.device = null;
          this.setState("auth", err.message || "Bu bilgisayarın bağlantısı kaldırılmış. Yeniden giriş yap.");
        }
      });
  }

  async loop() {
    while (!this.stopped) {
      let wait = 15_000;
      try {
        if (!this.device) {
          await this.hello().catch(() => {});
          await sleep(this.state === "auth" ? 10_000 : 30_000);
          continue;
        }
        const [idle, message] = this.idleState();
        if (idle !== "idle") {
          if (this.state !== idle) this.setState(idle, message);
          await sleep(5_000);
          continue;
        }
        // Önce bu bilgisayardaki dosyalar (sürüklenen / izlenen klasör), sonra sitedeki sıra.
        const localItem = this.local?.next();
        if (localItem) {
          await this.processLocal(localItem);
          continue;
        }
        const res = await this.api.claim({ help: this.cfg.help, reels: this.cfg.reels });
        if (res.job) {
          await this.process(res.job);
          continue;
        }
        if (res.reel) {
          await this.reels.process(res.reel);
          continue;
        }
        this.queue = res.queue || [];
        if (this.state !== "idle" || this.message !== message) this.setState("idle", message);
        else this.emitState();
      } catch (err) {
        if (err.status === 401 || err.status === 403) {
          this.device = null;
          this.setState("auth", err.message);
        } else if (err.status === 409) {
          // Sunucu ayarı eksik (ör. PocketBase alanı): uzun bekle.
          this.setState("error", err.message);
          wait = 60_000;
        } else {
          this.setState("error", `Bağlantı hatası: ${err.message}`);
          wait = 30_000;
        }
        this.log(`Hata: ${err.message}`);
      }
      await sleep(wait);
    }
  }

  // --- ilerleme bildirimi (iptal kontrolü dahil) -------------------------------------
  async report(job, status, fraction, stage, force = false) {
    const progress = overall(status, fraction);
    this.current = { ...this.current, status, stage, progress };
    if (job.item) {
      job.item.progress = progress;
      job.item.stage = stage;
    }
    this.emitState();
    const now = Date.now();
    if (!force && this.lastReport && now - this.lastReport < 4000 && this.lastStatus === status) return;
    this.lastReport = now;
    this.lastStatus = status;
    const res = await this.api.job(job.id, "progress", { status, stage, progress }).catch((err) => {
      // İş başka işleyiciye geçti / silindi: bırak.
      if (err.status === 409 || err.status === 404) return { canceled: true };
      return null;
    });
    if (res?.canceled) {
      this.abort?.abort();
      throw new CanceledError("Fansub işi iptal etti.");
    }
  }

  // --- tek bir bölüm işi ---------------------------------------------------------------
  async process(job) {
    const title = `${job.animeName} · S${job.season} B${job.episode}`;
    const dir = path.join(this.cfg.workDir, job.id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const started = Date.now();
    this.current = { kind: "job", id: job.id, title, team: job.team, status: "downloading", stage: "İndiriliyor", progress: 0, started };
    this.setState("working", `İşleniyor: ${title}`);
    this.lastReport = 0;
    this.log(`▶ ${title} (${job.team})`);
    this.heartbeat();
    const bg = (p) =>
      p.catch((e) => {
        if (e instanceof CanceledError) this.abort?.abort();
      });

    try {
      // 1) İndir: panelden yüklenen dosya (imzalı adres) ya da fansubun verdiği bağlantı.
      const src = job.source.kind === "local"
        ? { path: job.source.path, name: path.basename(job.source.path), size: fs.statSync(job.source.path).size }
        : await downloadSource(
        job.source.url,
        dir,
        (done, total) => bg(this.report(job, "downloading", total ? done / total : 0, total ? `İndiriliyor ${mb(done)} / ${mb(total)}` : `İndiriliyor ${mb(done)}`)),
        signal,
        this.cfg.limits.maxBytes,
      );
      if (signal.aborted) throw new CanceledError("İptal edildi.");
      this.log(job.source.kind === "local" ? `Yerel dosya: ${src.name} (${mb(src.size)})` : `İndirildi: ${src.name} (${mb(src.size)})`);

      // 2) Çözümle
      await this.report(job, "encoding", 0, "Dosya inceleniyor", true);
      const info = await media.probe(this.cfg, src.path);
      const picks = media.pickStreams(info);
      const { minSeconds, maxMinutes } = this.cfg.limits;
      if (!picks.duration) throw new Error("Videonun süresi okunamadı; dosya bozuk olabilir.");
      if (picks.duration < minSeconds) throw new Error(`Video çok kısa (${Math.round(picks.duration)} sn). En az ${minSeconds} saniye olmalı.`);
      if (picks.duration > maxMinutes * 60) throw new Error(`Video çok uzun (${Math.round(picks.duration / 60)} dk). En fazla ${maxMinutes} dakika olabilir.`);
      this.log(
        `Görüntü: ${picks.video.codec_name} ${picks.video.width}x${picks.video.height} ${picks.video.pix_fmt} · ses: ${picks.audio?.codec_name || "yok"} · altyazı: ${picks.subtitle?.codec_name || "yok"} · font: ${picks.fonts.length}`,
      );

      // 3) Altyazı: fansubun yüklediği dosya öncelikli, yoksa MKV içinden
      let subFile = null;
      if (job.localSubtitle) {
        const raw = path.join(dir, `yuklenen${path.extname(job.localSubtitle).toLowerCase()}`);
        fs.copyFileSync(job.localSubtitle, raw);
        subFile = await media.normalizeSubtitle(this.cfg, raw, path.join(dir, "altyazi.ass"), signal);
        this.log(`Altyazı: dosyanın yanındaki ${path.basename(job.localSubtitle)} kullanıldı.`);
      } else if (job.hasSubtitle) {
        const res = await this.api.subtitle(job.id, signal);
        const name = decodeURIComponent(res.headers.get("x-file-name") || "altyazi.ass");
        const raw = path.join(dir, `yuklenen${(path.extname(name) || ".ass").toLowerCase().replace(/[^.a-z]/g, "")}`);
        fs.writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
        subFile = await media.normalizeSubtitle(this.cfg, raw, path.join(dir, "altyazi.ass"), signal);
        this.log("Altyazı: fansubun yüklediği dosya kullanıldı.");
      } else if (picks.subtitle) {
        subFile = await media.extractSubtitle(this.cfg, src.path, picks.subtitle, path.join(dir, "altyazi.ass"), signal);
        this.log(`Altyazı dosyadan çıkarıldı (${picks.subtitle.codec_name}${picks.subtitle.tags?.language ? `, ${picks.subtitle.tags.language}` : ""}).`);
      } else if (job.dubbing) {
        this.log("Altyazı yok (Türkçe dublaj; altyazı gerekmiyor).");
      } else {
        throw new Error(
          picks.imageSubtitle
            ? "Altyazı görüntü biçiminde (PGS/VobSub); metne çevrilemiyor. ASS altyazılı (softsub) MKV ya da ayrıca .ass/.srt dosyası yükleyin."
            : "Altyazı bulunamadı: videoda ayrı altyazı parçası yok (altyazı görüntüye basılmış/hardsub ya da hiç yok). ASS altyazılı (softsub) MKV ya da altyazısız video + ayrıca .ass/.srt dosyası yükleyin.",
        );
      }
      const fontFiles = picks.fonts.length ? await media.dumpFonts(this.cfg, src.path, path.join(dir, "fonts"), signal) : [];

      // 3b) Font denetimi: altyazıda kullanılıp dosyada olmayan fontlar
      const warnings = [];
      if (subFile) {
        const missing = missingFonts(subFile, fontFiles);
        if (missing.length) {
          const list = missing.slice(0, 6).join(", ") + (missing.length > 6 ? ` +${missing.length - 6}` : "");
          warnings.push(`Eksik font: ${list}`);
          this.log(`⚠ Altyazıda kullanılan ama dosyada olmayan font: ${list}. Bu yazılar sitede varsayılan yazı tipiyle görünür.`);
        }
      }

      // 4) Encode
      const out = path.join(dir, "video.mp4");
      const enc = await media.encode(
        this.cfg,
        src.path,
        picks,
        out,
        (f) => bg(this.report(job, "encoding", this.cfg.quality === "1080" ? f : f * 0.65, `Encode ${Math.min(picks.video.height, 1080)}p %${Math.round(f * 100)}`)),
        signal,
        (t) => this.log(t),
      );
      if (signal.aborted) throw new CanceledError("İptal edildi.");
      const outSize = fs.statSync(out).size;
      this.log(`Encode bitti (${enc.method}): ${enc.width}x${enc.height}, ${mb(outSize)}`);

      // 4b) İkinci kalite: 720p (yavaş internet / telefon). Ayarda kapalıysa ya da kaynak zaten 720p ise yok.
      let low = null;
      if (this.cfg.quality !== "1080" && enc.height > 720) {
        const out720 = path.join(dir, "video_720.mp4");
        const picks720 = media.pickStreams(await media.probe(this.cfg, out));
        const enc720 = await media.encode(
          this.cfg,
          out,
          picks720,
          out720,
          (f) => bg(this.report(job, "encoding", 0.65 + f * 0.35, `Encode 720p %${Math.round(f * 100)}`)),
          signal,
          (t) => this.log(t),
          { maxHeight: 720, forceEncode: true },
        );
        if (signal.aborted) throw new CanceledError("İptal edildi.");
        const size720 = fs.statSync(out720).size;
        if (size720 >= outSize * 0.85) {
          this.log(`720p atlandı: ${mb(size720)}, ana sürümden (${mb(outSize)}) küçük değil.`);
        } else {
          low = { path: out720, width: enc720.width, height: enc720.height, size: size720 };
          this.log(`720p hazır: ${low.width}x${low.height}, ${mb(low.size)}`);
        }
      }

      // 4c) Önizleme ve opening/ending işaretleme (Forge'a sürüklenen dosyalarda, ayar açıksa).
      let skips = [];
      if (job.item && this.cfg.preview) {
        const decision = await this.runPreview(job, { dir, out, subFile, hasFonts: fontFiles.length > 0, duration: picks.duration });
        if (!decision.approve) throw new CanceledError("Önizlemede vazgeçildi.");
        skips = decision.skips || [];
      }

      // 5) Yükle: site her dosya için imzalı adres verir, dosya doğrudan depoya gider.
      await this.report(job, "uploading", 0, "Yükleniyor", true);
      const files = [{ path: "video.mp4", file: out }];
      if (low) files.push({ path: "video_720.mp4", file: low.path });
      if (subFile) files.push({ path: "altyazi.ass", file: subFile });
      const fontNames = [];
      for (const f of fontFiles) {
        const name = safeName(path.basename(f));
        if (!/\.(ttf|otf|ttc|otc|woff2?)$/i.test(name) || fontNames.includes(name)) continue;
        fontNames.push(name);
        files.push({ path: `fonts/${name}`, file: f });
      }
      for (const f of files) f.size = fs.statSync(f.file).size;
      const total = files.reduce((s, f) => s + f.size, 0);
      const { uploads } = await this.api.job(job.id, "upload", { files: files.map((f) => ({ path: f.path, size: f.size })) });
      let doneBytes = 0;
      for (const f of files) {
        if (signal.aborted) throw new CanceledError("İptal edildi.");
        const u = uploads.find((x) => x.path === f.path);
        if (!u) throw new Error(`Yükleme adresi alınamadı: ${f.path}`);
        await putFile(u.url, u.headers, f.file, {
          signal,
          limitBps: this.cfg.uploadLimitBps,
          onProgress: (sent) => bg(this.report(job, "uploading", (doneBytes + sent) / total, `Yükleniyor ${mb(doneBytes + sent)} / ${mb(total)}`)),
        });
        doneBytes += f.size;
      }
      if (signal.aborted) throw new CanceledError("İptal edildi.");

      // 6) Bitir: site dosyaları kontrol edip bölümü yayına alır.
      const result = await this.api.job(job.id, "complete", {
        video: { width: enc.width, height: enc.height, duration: Math.round(picks.duration) },
        ...(low ? { low: { width: low.width, height: low.height } } : {}),
        subtitle: !!subFile,
        fonts: fontNames,
        warnings,
        skips,
      });
      const secs = Math.round((Date.now() - started) / 1000);
      this.stats.done++;
      this.stats.bytes += total;
      this.stats.seconds += secs;
      this.log(`✓ Yayında: ${title} (${Math.floor(secs / 60)} dk ${secs % 60} sn)${result.existed ? " — mevcut bölüm kaydına eklendi" : " — yeni bölüm"}`);
      this.pushRecent({
        id: job.id,
        title,
        ok: true,
        note: `${enc.height}p${low ? " + 720p" : ""} · ${mb(total)} · ${Math.floor(secs / 60)} dk${warnings.length ? ` · ⚠ ${warnings[0]}` : ""}`,
      });
      this.emit("done", { title, ok: true, warning: warnings[0] || "" });
      return { ok: true, skips };
    } catch (err) {
      const canceled = err instanceof CanceledError || signal.aborted;
      if (this.stopped || this.releasing) return { ok: false, canceled: true }; // kapanıyor/çıkış: iş sıraya geri bırakıldı
      const message = canceled ? "İptal edildi." : String(err?.message || err).slice(0, 900);
      this.log(`${canceled ? "■ İptal" : "✗ Hata"}: ${title} — ${message}`);
      await this.api.job(job.id, "fail", canceled ? { canceled: true } : { error: message }).catch(() => {});
      if (!canceled) this.stats.failed++;
      this.pushRecent({ id: job.id, title, ok: false, note: message });
      if (!canceled) this.emit("done", { title, ok: false, error: message });
      return { ok: false, canceled, error: message };
    } finally {
      this.closePreview();
      fs.rmSync(dir, { recursive: true, force: true });
      this.current = null;
      this.abort = null;
      this.releasing = false;
      if (!this.stopped) this.setState(...this.idleState());
      this.heartbeat();
    }
  }

  /** Bu bilgisayardaki dosya: sitede iş açılır (dosya hiçbir yere yüklenmez), burada hazırlanır. */
  async processLocal(item) {
    item.status = "processing";
    item.error = "";
    item.progress = 0;
    item.stage = "Başlıyor";
    this.emitState();
    let job;
    try {
      const f = item.form;
      const res = await this.api.createJob({
        anilistId: f.anilistId,
        season: f.season,
        episode: f.episode,
        dubbing: f.dubbing,
        credits: f.credits,
      });
      job = res.job;
    } catch (err) {
      this.log(`✗ ${item.name}: ${err.message}`);
      this.local.finished(item, false, { error: err.message });
      return;
    }
    const result = await this.process({
      id: job.id,
      animeName: job.animeName,
      season: item.form.season,
      episode: item.form.episode,
      team: job.team,
      dubbing: item.form.dubbing,
      hasSubtitle: false,
      localSubtitle: item.subtitle,
      source: { kind: "local", path: item.path },
      item,
    });
    if (result) this.local.finished(item, result.ok, result);
  }

  /** Önizleme hazırlar ve fansubun kararını bekler (yayına al / vazgeç + opening/ending). */
  async runPreview(job, { dir, out, subFile, hasFonts, duration }) {
    await this.report(job, "encoding", 1, "Önizleme hazırlanıyor", true);
    const frames = await preview.frames(this.cfg, dir, out, subFile, hasFonts, duration).catch(() => []);
    const server = await preview.serveVideo(out);
    this.previewServer = server;
    const title = `${job.animeName} · S${job.season} B${job.episode}`;
    const data = {
      jobId: job.id,
      itemId: job.item?.id || "",
      title,
      frames,
      videoUrl: server.url,
      duration,
      suggest: job.item ? this.local.lastSkips(job.item) : null,
    };
    this.log("Önizleme hazır: yayına almadan önce kontrol et.");
    this.emit("preview", data);
    // Beklerken site işi "takılı" saymasın diye arada bir haber verilir.
    const keepAlive = setInterval(() => this.report(job, "encoding", 1, "Önizleme bekleniyor", true).catch(() => {}), 120_000);
    try {
      await this.report(job, "encoding", 1, "Önizleme bekleniyor", true);
      if (job.item) job.item.status = "preview";
      return await new Promise((resolve) => {
        this.pendingPreview = { data, resolve };
        this.emitState();
      });
    } finally {
      clearInterval(keepAlive);
      if (job.item) job.item.status = "processing";
    }
  }

  /** Önizleme ekranından gelen karar. */
  decidePreview(decision) {
    const p = this.pendingPreview;
    if (!p) return;
    this.pendingPreview = null;
    this.emitState();
    p.resolve({ approve: !!decision?.approve, skips: Array.isArray(decision?.skips) ? decision.skips : [] });
  }

  closePreview() {
    if (this.pendingPreview) {
      const p = this.pendingPreview;
      this.pendingPreview = null;
      p.resolve({ approve: false });
    }
    this.previewServer?.close();
    this.previewServer = null;
  }

  pushRecent(item) {
    this.recent.unshift({ ...item, at: new Date().toISOString() });
    this.recent = this.recent.slice(0, 20);
    this.emitState();
  }
}

module.exports = { Engine, inSchedule };
