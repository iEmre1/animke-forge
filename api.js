// Siteyle konuşma: /api/worker/*. Tüm istekler cihaz anahtarıyla (Authorization: Bearer awk_...).
// Dosya yükleme: site, yalnızca o işin dosyalarına yazma izni veren kısa süreli imzalı adresler
// verir; dosya doğrudan depoya (R2) gider, sitenin sunucusundan geçmez.
const fs = require("node:fs");
const { Readable, Transform } = require("node:stream");

const VERSION = require("./package.json").version;

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

class Api {
  constructor(cfg) {
    this.cfg = cfg;
  }

  async request(method, path, body, { timeout = 30_000, raw = false, signal } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let res;
    try {
      res = await fetch(`${this.cfg.siteUrl}${path}`, {
        method,
        headers: {
          ...(this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : {}),
          "User-Agent": `AnimkeForge/${VERSION}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (err) {
      if (signal?.aborted) throw new Error("İptal edildi.");
      throw new ApiError(`Siteye bağlanılamadı (${err?.cause?.code || err?.name || "ağ hatası"}).`, 0);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (raw && res.ok) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data?.error || `Site hata verdi (HTTP ${res.status}).`, res.status);
    return data;
  }

  hello() {
    return this.request("GET", "/api/worker/hello");
  }
  heartbeat(state, currentJob) {
    // server: ekransız (VDS) Forge — site işleri en son ona verir.
    return this.request("POST", "/api/worker/heartbeat", { state, currentJob: currentJob || "", version: VERSION, server: !!this.cfg.server });
  }
  claim(opts) {
    return this.request("POST", "/api/worker/claim", opts, { timeout: 45_000 });
  }
  job(id, action, body) {
    return this.request("POST", `/api/worker/jobs/${id}/${action}`, body || {}, { timeout: 60_000 });
  }
  subtitle(id, signal) {
    return this.request("GET", `/api/worker/jobs/${id}/subtitle`, null, { raw: true, timeout: 60_000, signal });
  }
  reel(id, action, body) {
    return this.request("POST", `/api/worker/reels/${id}/${action}`, body || {}, { timeout: 60_000 });
  }
  /** Bu bilgisayardaki dosyadan bölüm işi aç (dosya yüklenmez, burada hazırlanır). */
  createJob(form) {
    return this.request("POST", "/api/worker/jobs", form);
  }
  /** Dosya adındaki anime adını AniList'te ara. */
  searchAnime(q) {
    return this.request("GET", `/api/worker/anime?q=${encodeURIComponent(q)}`);
  }
  /** Hesapla giriş: kod al (anahtar gerekmez). */
  linkStart(name) {
    return this.request("POST", "/api/worker/link", { action: "start", name, version: VERSION });
  }
  linkPoll(code, secret) {
    return this.request("POST", "/api/worker/link", { action: "poll", code, secret });
  }
  /** Çıkış: bu bilgisayarın anahtarı sitede iptal edilir. */
  logout() {
    return this.request("POST", "/api/worker/logout", {});
  }
}

/** Bu kadar süre hiç ilerleme olmazsa (ya da depo cevap vermezse) yükleme kesilip yeniden denenir. */
const STALL_MS = 60_000;

/**
 * Dosyayı imzalı adrese PUT eder. İlerleme bildirir, isteğe bağlı hız sınırı uygular,
 * takılırsa ya da geçici hata olursa 3 kez yeniden dener.
 */
async function putFile(url, headers, file, { onProgress, signal, limitBps = 0 } = {}) {
  const size = fs.statSync(file).size;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (signal?.aborted) throw new Error("İptal edildi.");
    let sent = 0;
    let last = 0;
    const started = Date.now();
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        sent += chunk.length;
        const now = Date.now();
        if (onProgress && now - last > 400) {
          last = now;
          onProgress(sent, size);
        }
        if (limitBps > 0) {
          const wait = (sent / limitBps) * 1000 - (now - started);
          if (wait > 5) return setTimeout(() => cb(null, chunk), wait);
        }
        cb(null, chunk);
      },
    });
    const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 }).pipe(meter);
    // Kendi iptal sinyali: dışarıdan iptal ya da takılma (uzun süre ilerleme/cevap yok).
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let lastSent = -1;
    let lastMove = Date.now();
    let stalled = false;
    const watchdog = setInterval(() => {
      if (sent !== lastSent) {
        lastSent = sent;
        lastMove = Date.now();
      } else if (Date.now() - lastMove > STALL_MS) {
        stalled = true;
        ctrl.abort();
      }
    }, 5_000);
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { ...headers, "Content-Length": String(size) },
        body: Readable.toWeb(stream),
        duplex: "half",
        signal: ctrl.signal,
      });
      if (res.ok) {
        onProgress?.(size, size);
        return size;
      }
      const text = await res.text().catch(() => "");
      lastError = new Error(`Yükleme reddedildi (HTTP ${res.status})${/expired/i.test(text) ? ": adresin süresi doldu" : ""}.`);
      if (res.status === 403 || res.status === 400) break; // imza/izin sorunu: tekrar denemek işe yaramaz
    } catch (err) {
      if (signal?.aborted) throw new Error("İptal edildi.");
      lastError = new Error(stalled ? "Yükleme takıldı: 1 dakika boyunca ilerleme olmadı (internet bağlantını kontrol et)." : `Yükleme kesildi: ${err?.cause?.code || err?.message || err}`);
    } finally {
      clearInterval(watchdog);
      signal?.removeEventListener("abort", onAbort);
      stream.destroy();
    }
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
  throw lastError || new Error("Yükleme başarısız.");
}

module.exports = { Api, ApiError, putFile, VERSION };
