// Yerel dosyalar: Forge'a sürüklenen ya da izlenen klasöre düşen bölümler.
// Ham dosya hiçbir yere yüklenmez; Forge kendi bilgisayarında hazırlar, yalnızca sonucu yükler.
//
// Eşleştirme: dosya adından anime adı/sezon/bölüm çıkarılır (parse.js). Bir seri ilk kez
// görüldüğünde fansub hangi anime olduğunu onaylar; Forge bunu hatırlar ve o serinin sonraki
// dosyalarını (izlenen klasörde) sormadan yükler.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { parseName, seriesKey, sidecarSubtitle, VIDEO_EXT } = require("./parse");

const WATCH_MS = 8_000;
const MIN_BYTES = 5 * 1024 * 1024;

class LocalQueue {
  constructor(engine, stateFile) {
    this.engine = engine;
    this.stateFile = stateFile;
    this.items = [];
    this.state = { mappings: {}, processed: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      this.state.mappings = raw.mappings || {};
      this.state.processed = Array.isArray(raw.processed) ? raw.processed : [];
    } catch {
      // ilk açılış
    }
    this.seen = new Map(); // izlenen klasör: path -> { size, mtime, stable }
    this.timer = setInterval(() => this.scan(), WATCH_MS);
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      this.state.processed = this.state.processed.slice(-3000);
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 1));
    } catch {
      // yazılamadı; bir sonraki seferde
    }
  }

  view() {
    return this.items.map((i) => ({
      id: i.id,
      name: i.name,
      size: i.size,
      source: i.source,
      status: i.status,
      error: i.error || "",
      subtitle: i.subtitle ? path.basename(i.subtitle) : "",
      parsed: i.parsed,
      form: i.form,
      candidates: i.candidates || [],
      remembered: !!this.state.mappings[i.key],
      progress: i.progress || 0,
      stage: i.stage || "",
    }));
  }

  changed() {
    this.engine.emitState();
  }

  fileKey(file, st) {
    return `${path.resolve(file).toLowerCase()}|${st.size}|${Math.round(st.mtimeMs)}`;
  }

  /** Dosya ekle (sürükle-bırak ya da izlenen klasör). */
  add(file, source = "drop") {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return { error: "Dosya bulunamadı." };
    }
    if (!st.isFile() || !VIDEO_EXT.test(file)) return { error: `${path.basename(file)}: video dosyası değil (.mkv, .mp4…).` };
    if (this.items.some((i) => i.path === file && !["done", "failed", "canceled"].includes(i.status))) {
      return { error: `${path.basename(file)} zaten listede.` };
    }
    const parsed = parseName(file);
    const key = seriesKey(parsed);
    const map = this.state.mappings[key];
    const item = {
      id: crypto.randomBytes(6).toString("hex"),
      path: file,
      name: path.basename(file),
      size: st.size,
      fileKey: this.fileKey(file, st),
      source,
      subtitle: sidecarSubtitle(file, (p) => fs.existsSync(p)),
      parsed,
      key,
      form: {
        anilistId: map?.anilistId || null,
        animeTitle: map?.title || "",
        cover: map?.cover || "",
        season: map?.season || parsed.season || 1,
        episode: parsed.episode ?? null,
        dubbing: parsed.dubbing || !!map?.dubbing,
        credits: map?.credits || "",
      },
      candidates: [],
      status: "confirm",
    };
    // İzlenen klasörde, seri daha önce onaylandıysa ve bölüm numarası okunduysa sormadan sıraya girer.
    if (source === "watch" && map && parsed.episode !== null) item.status = "ready";
    this.items.push(item);
    if (!map && parsed.title) void this.search(item, parsed.title);
    this.changed();
    if (item.status === "confirm" && source === "watch") this.engine.emit("needs-confirm", item.name);
    return { ok: true, id: item.id };
  }

  async search(item, q) {
    try {
      const res = await this.engine.api.searchAnime(q);
      item.candidates = (res.items || []).slice(0, 6);
      // Eşleşme yoksa ilk sonucu öner (fansub yine de onaylar).
      if (!item.form.anilistId && item.candidates[0]) {
        const c = item.candidates[0];
        item.form = { ...item.form, anilistId: c.id, animeTitle: c.title, cover: c.cover };
      }
    } catch (err) {
      item.error = `Anime aranamadı: ${err.message}`;
    }
    this.changed();
  }

  /** Onay kartındaki arama kutusu. */
  async searchFor(id, q) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return [];
    const res = await this.engine.api.searchAnime(q).catch(() => ({ items: [] }));
    item.candidates = (res.items || []).slice(0, 8);
    this.changed();
    return item.candidates;
  }

  /** Fansub onayladı: sıraya girer, seri eşleşmesi hatırlanır. */
  confirm(id, form) {
    const item = this.items.find((i) => i.id === id);
    if (!item || !["confirm", "failed", "canceled"].includes(item.status)) return { error: "Dosya bulunamadı." };
    const anilistId = Number(form.anilistId);
    const season = Number(form.season);
    const episode = Number(form.episode);
    if (!anilistId) return { error: "Anime seç." };
    if (!Number.isInteger(season) || season < 1 || season > 100) return { error: "Sezon 1-100 arası olmalı." };
    if (!Number.isInteger(episode) || episode < 0 || episode > 5000) return { error: "Bölüm numarasını yaz." };
    item.form = {
      anilistId,
      animeTitle: String(form.animeTitle || ""),
      cover: String(form.cover || ""),
      season,
      episode,
      dubbing: !!form.dubbing,
      credits: String(form.credits || "").slice(0, 200),
    };
    item.status = "ready";
    item.error = "";
    const prev = this.state.mappings[item.key] || {};
    this.state.mappings[item.key] = {
      ...prev,
      anilistId,
      title: item.form.animeTitle,
      cover: item.form.cover,
      season,
      dubbing: item.form.dubbing,
      credits: item.form.credits,
    };
    this.save();
    this.changed();
    return { ok: true };
  }

  remove(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status === "processing" || item.status === "preview") return;
    this.items = this.items.filter((i) => i !== item);
    // İzlenen klasördeki dosya listeden çıkarılınca bir daha alınmasın.
    if (item.source === "watch") {
      this.state.processed.push(item.fileKey);
      this.save();
    }
    this.changed();
  }

  clearFinished() {
    this.items = this.items.filter((i) => !["done", "canceled"].includes(i.status));
    this.changed();
  }

  forget(key) {
    delete this.state.mappings[key];
    this.save();
    this.changed();
  }

  mappingsView() {
    return Object.entries(this.state.mappings).map(([key, m]) => ({ key, ...m }));
  }

  next() {
    return this.items.find((i) => i.status === "ready") || null;
  }

  lastSkips(item) {
    return this.state.mappings[item.key]?.lastSkips || null;
  }

  /** İş bitti: işaretlenen opening/ending sonraki bölüm için hatırlanır, dosya taşınır. */
  finished(item, ok, info = {}) {
    item.status = ok ? "done" : info.canceled ? "canceled" : "failed";
    item.error = ok ? "" : info.error || "";
    if (ok && info.skips?.length && this.state.mappings[item.key]) {
      this.state.mappings[item.key].lastSkips = info.skips;
    }
    if (ok && item.source === "watch") {
      this.state.processed.push(item.fileKey);
      const s = this.engine.settings();
      if (s.afterUpload === "move") this.moveDone(item);
    }
    this.save();
    this.changed();
  }

  moveDone(item) {
    const dir = path.join(path.dirname(item.path), "Yüklendi");
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const f of [item.path, item.subtitle].filter(Boolean)) {
        fs.renameSync(f, path.join(dir, path.basename(f)));
      }
    } catch (err) {
      this.engine.log(`Dosya "Yüklendi" klasörüne taşınamadı: ${err.message}`);
    }
  }

  // --- izlenen klasör ---------------------------------------------------------------
  scan() {
    const s = this.engine.settings();
    if (!s.watchEnabled || !s.watchDir || !this.engine.device) return;
    let names;
    try {
      names = fs.readdirSync(s.watchDir);
    } catch {
      return;
    }
    const processed = new Set(this.state.processed);
    const present = new Set();
    for (const name of names) {
      if (!VIDEO_EXT.test(name)) continue;
      const file = path.join(s.watchDir, name);
      present.add(file);
      if (this.items.some((i) => i.path === file)) continue;
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size < MIN_BYTES || processed.has(this.fileKey(file, st))) continue;
      // Dosya hâlâ kopyalanıyor/encode ediliyorsa boyutu değişir: iki taramada aynı kalınca alınır.
      const prev = this.seen.get(file);
      if (!prev || prev.size !== st.size || prev.mtime !== st.mtimeMs) {
        this.seen.set(file, { size: st.size, mtime: st.mtimeMs });
        continue;
      }
      // Başka bir program dosyayı hâlâ yazıyorsa açılamaz (Windows).
      try {
        fs.closeSync(fs.openSync(file, "r+"));
      } catch {
        continue;
      }
      this.seen.delete(file);
      const res = this.add(file, "watch");
      if (res.ok) this.engine.log(`İzlenen klasörde yeni dosya: ${name}`);
    }
    for (const file of this.seen.keys()) if (!present.has(file)) this.seen.delete(file);
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = { LocalQueue };
