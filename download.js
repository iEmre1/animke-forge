// Kaynak dosyayı bağlantıdan indirir. Desteklenen: Google Drive, Pixeldrain, Mediafire,
// Dropbox ve doğrudan video bağlantıları. Oynatıcı sayfaları (Mixdrop, Streamtape...)
// gerçek dosya değil, indirilemez.
const fs = require("node:fs");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const NOT_A_FILE =
  "Bu bağlantı doğrudan bir video dosyası değil (oynatıcı ya da indirme sayfası). Google Drive, Pixeldrain, Mediafire, Dropbox ya da doğrudan .mkv/.mp4 bağlantısı kullan.";

const driveId = (url) => {
  const host = url.hostname.replace(/^www\./, "");
  if (!["drive.google.com", "docs.google.com", "drive.usercontent.google.com"].includes(host)) return null;
  const id = url.pathname.match(/\/file\/d\/([\w-]{10,})/)?.[1] || url.searchParams.get("id") || "";
  return /^[\w-]{10,}$/.test(id) ? id : null;
};

const isHtml = (res) => /text\/html/i.test(res.headers.get("content-type") || "");

// --- Yerel ağ koruması ---------------------------------------------------------------
// Bağlantıyı fansub verir; işleyici ise senin bilgisayarında çalışır. Kötü niyetli bir
// bağlantı (ör. http://192.168.1.1/...) evdeki modem/cihazlara istek attırmasın diye her
// adres (yönlendirmeler dahil) çözülüp özel/yerel ağ adresleri engellenir.
const dns = require("node:dns/promises");
const net = require("node:net");

const BLOCKED_V4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const v4ToInt = (ip) => ip.split(".").reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return BLOCKED_V4.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
  }
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIp(mapped[1]);
  const first = parseInt(lower.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // fc00::/7, fe80::/10
}

async function assertPublic(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Bağlantı http(s) olmalı.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error(`Adres çözülemedi: ${url.hostname}`);
  if (addrs.some((a) => isBlockedIp(a.address))) throw new Error("Bu bağlantı yerel ağa işaret ediyor; indirilmedi.");
  return url;
}

/** Yönlendirmeleri tek tek doğrulayarak indirir (en fazla 8 yönlendirme). */
async function get(url, signal) {
  let current = url;
  for (let hop = 0; hop <= 8; hop++) {
    await assertPublic(current);
    const res = await fetch(current, { headers: { "User-Agent": UA }, redirect: "manual", signal });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel().catch(() => {});
      current = new URL(res.headers.get("location"), current).toString();
      continue;
    }
    return res;
  }
  throw new Error("Çok fazla yönlendirme.");
}

/** Google Drive'ın "virüs taraması yapılamadı" sayfasındaki formdan gerçek indirme adresini çıkarır. */
function driveConfirmUrl(html) {
  const action = html.match(/<form[^>]+id="download-form"[^>]+action="([^"]+)"/i)?.[1];
  if (!action) return null;
  const url = new URL(action.replace(/&amp;/g, "&"));
  for (const m of html.matchAll(/<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]+value="([^"]*)"/gi)) {
    url.searchParams.set(m[1], m[2]);
  }
  return url.toString();
}

/** Bağlantıyı açar; gövdesi gerçek dosya olan yanıtı döndürür. */
async function openSource(raw, signal) {
  const url = new URL(raw.trim());
  const host = url.hostname.replace(/^www\./, "");

  const id = driveId(url);
  if (id) {
    let res = await get(`https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`, signal);
    if (isHtml(res)) {
      const html = await res.text();
      const next = driveConfirmUrl(html);
      if (next) res = await get(next, signal);
      if (!next || isHtml(res)) {
        throw new Error(
          "Google Drive dosyası indirilemedi. Paylaşımın \"Bağlantıya sahip herkes\" olduğundan emin ol; dosya çok indirildiyse Drive günlük kotası dolmuş olabilir (birkaç saat sonra tekrar dene).",
        );
      }
    }
    return res;
  }

  if (host === "pixeldrain.com" || host === "pixeldrain.net") {
    const pid = url.pathname.match(/\/(?:u|api\/file)\/([\w-]+)/)?.[1];
    if (pid) return get(`https://pixeldrain.com/api/file/${pid}?download`, signal);
  }

  if (host === "dropbox.com" || host.endsWith(".dropbox.com")) {
    url.searchParams.set("dl", "1");
    return get(url.toString(), signal);
  }

  if (host === "mediafire.com" || host.endsWith(".mediafire.com")) {
    const page = await get(url.toString(), signal);
    if (!isHtml(page)) return page;
    const html = await page.text();
    const direct = html.match(/href="(https:\/\/download[^"]+mediafire\.com\/[^"]+)"/i)?.[1];
    if (!direct) throw new Error("Mediafire indirme bağlantısı bulunamadı (dosya silinmiş ya da gizli olabilir).");
    return get(direct, signal);
  }

  return get(url.toString(), signal);
}

function fileNameFrom(res, fallbackUrl) {
  const cd = res.headers.get("content-disposition") || "";
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = cd.match(/filename="?([^";]+)"?/i)?.[1];
  let name = star ? decodeURIComponent(star) : plain;
  if (!name) {
    try {
      name = decodeURIComponent(new URL(fallbackUrl).pathname.split("/").pop() || "");
    } catch {
      name = "";
    }
  }
  return name || "kaynak.mkv";
}

/**
 * İndirir; onProgress(indirilen, toplam|0). Dönüş: { path, name, size }.
 * minFreeBytes: diskte en az bu kadar yer kalmalı (yoksa başlamadan hata).
 */
async function downloadSource(rawUrl, dir, onProgress, signal, maxBytes = Infinity) {
  const res = await openSource(rawUrl, signal);
  if (!res.ok) throw new Error(`Kaynak indirilemedi (HTTP ${res.status}).`);
  if (isHtml(res)) {
    await res.body?.cancel().catch(() => {});
    throw new Error(NOT_A_FILE);
  }

  const name = fileNameFrom(res, rawUrl);
  const ext = (path.extname(name) || ".mkv").toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 6) || ".mkv";
  const target = path.join(dir, `kaynak${ext}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const tooBig = () =>
    new Error(
      `Dosya çok büyük: en fazla ${
        maxBytes >= 1024 ** 3 ? `${Math.round(maxBytes / 1024 ** 3)} GB` : `${Math.round(maxBytes / 1024 ** 2)} MB`
      } yüklenebilir.`,
    );
  if (total && total > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig();
  }

  if (total && fs.statfsSync) {
    const st = fs.statfsSync(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    // Kaynak + encode çıktısı + pay
    if (free < total * 2.5) {
      throw new Error(`Diskte yer yok: ${(total / 1e9).toFixed(1)} GB'lık dosya için en az ${((total * 2.5) / 1e9).toFixed(1)} GB boş alan gerekli.`);
    }
  }

  let done = 0;
  let last = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      done += chunk.length;
      // Boyutu bildirmeyen sunucularda sınır indirme sırasında denetlenir.
      if (done > maxBytes) return cb(tooBig());
      const now = Date.now();
      if (onProgress && now - last > 500) {
        last = now;
        onProgress(done, total);
      }
      cb(null, chunk);
    },
  });

  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(target), { signal });
  onProgress?.(done, total || done);

  if (done < 1024 * 100) throw new Error("İndirilen dosya çok küçük; bağlantı bir video dosyasına gitmiyor olabilir.");
  return { path: target, name, size: done };
}

module.exports = { downloadSource };
