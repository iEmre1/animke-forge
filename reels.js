// Reels videolarını küçültme (yalnızca onaylı işleyiciler, bölüm işi yokken).
// Site videoyu kısa süreli imzalı adresle verir; işleyici 720p H.264'e çevirip imzalı adrese
// yükler, site de videoyu yeni dosyaya geçirip büyük orijinali siler.
const fs = require("node:fs");
const path = require("node:path");
const media = require("./media");
const { putFile } = require("./api");
const { downloadSource } = require("./download");

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

class ReelCompressor {
  constructor(engine) {
    this.engine = engine;
  }

  async process(reel) {
    const engine = this.engine;
    const api = engine.api;
    const title = `Reels: ${reel.title}`;
    const dir = path.join(engine.cfg.workDir, reel.id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    engine.abort = new AbortController();
    const signal = engine.abort.signal;
    engine.current = { kind: "reel", id: reel.id, title, team: "Reels", status: "downloading", stage: "İndiriliyor", progress: 0, started: Date.now() };
    engine.setState("working", `İşleniyor: ${title}`);
    engine.log(`▶ ${title} (küçültme)`);
    engine.heartbeat();
    const set = (status, progress, stage) => {
      engine.current = { ...engine.current, status, progress: Math.round(progress), stage };
      engine.emitState();
    };
    // Site uzun süre haber alamazsa işi başkasına verir: dakikada bir "hâlâ çalışıyorum".
    const ping = setInterval(() => api.reel(reel.id, "progress").catch(() => {}), 60_000);

    try {
      const src = await downloadSource(reel.url, dir, (done) => set("downloading", 0, `İndiriliyor ${mb(done)}`), signal, 400 * 1024 * 1024);
      const info = await media.probe(engine.cfg, src.path);
      const decision = media.reelNeedsEncode(info, src.size);
      if (!decision.encode) {
        await api.reel(reel.id, "complete", { skipped: true, originalSize: src.size });
        engine.log(`Reels küçültülmedi: ${decision.reason}.`);
        engine.pushRecent({ id: reel.id, title, ok: true, note: `küçültme gerekmedi · ${mb(src.size)}` });
        return;
      }

      const out = path.join(dir, "video-720.mp4");
      await media.encodeReel(engine.cfg, src.path, info, out, (f) => set("encoding", 20 + f * 70, `Küçültülüyor %${Math.round(f * 100)}`), signal);
      const outSize = fs.statSync(out).size;
      if (outSize >= src.size * 0.95) {
        await api.reel(reel.id, "complete", { skipped: true, originalSize: src.size });
        engine.log(`Reels küçültülmedi: yeni dosya daha küçük değil (${mb(outSize)} ≥ ${mb(src.size)}).`);
        engine.pushRecent({ id: reel.id, title, ok: true, note: "orijinal daha küçük, korundu" });
        return;
      }

      set("uploading", 90, "Yükleniyor");
      const signed = await api.reel(reel.id, "upload", { size: outSize });
      await putFile(signed.url, signed.headers, out, {
        signal,
        limitBps: engine.cfg.uploadLimitBps,
        onProgress: (done, total) => set("uploading", 90 + (done / total) * 10, "Yükleniyor"),
      });
      await api.reel(reel.id, "complete", { size: outSize });
      const saved = Math.round((1 - outSize / src.size) * 100);
      engine.log(`✓ ${title}: ${mb(src.size)} → ${mb(outSize)} (%${saved} küçüldü)`);
      engine.pushRecent({ id: reel.id, title, ok: true, note: `${mb(src.size)} → ${mb(outSize)}` });
    } catch (err) {
      if (engine.stopped || engine.releasing) return; // kapanıyor/çıkış: video sıraya geri bırakıldı
      const message = signal.aborted ? "İptal edildi." : String(err?.message || err).slice(0, 500);
      engine.log(`✗ ${title} — ${message}`);
      // Gerçek hatada orijinal video yayında kalır.
      await api.reel(reel.id, "fail", signal.aborted ? { release: true } : { error: message }).catch(() => {});
      engine.pushRecent({ id: reel.id, title, ok: false, note: message });
    } finally {
      clearInterval(ping);
      fs.rmSync(dir, { recursive: true, force: true });
      engine.current = null;
      engine.abort = null;
      engine.releasing = false;
      if (!engine.stopped) engine.setState(...engine.idleState());
      engine.heartbeat();
    }
  }
}

module.exports = { ReelCompressor };
