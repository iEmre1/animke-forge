// Dosya adından anime adı, sezon ve bölüm numarası çıkarır.
// Örnekler:
//   [AkiVerse] Frieren - 05 [1080p][ABCD1234].mkv        → Frieren, sezon ?, bölüm 5
//   Sousou no Frieren S2 - 05 (1080p).mkv                → Sousou no Frieren, sezon 2, bölüm 5
//   Dandadan.S02E08.1080p.WEB-DL.mkv                      → Dandadan, sezon 2, bölüm 8
//   Kaiju No. 8 2nd Season - 03v2.mkv                     → Kaiju No. 8, sezon 2, bölüm 3
//   Sakamoto Days 12. Bölüm [TR Dublaj].mp4               → Sakamoto Days, bölüm 12, dublaj
const path = require("node:path");

const VIDEO_EXT = /\.(mkv|mp4|m4v|mov|webm|avi|ts)$/i;
const SUB_EXT = [".ass", ".ssa", ".srt"];

// Kalite/kaynak etiketleri: başlıktan atılır.
const NOISE =
  /\b(2160p|1440p|1080p|720p|540p|480p|4k|uhd|fhd|hd|x26[45]|h\.?26[45]|hevc|avc|av1|10-?bit|8-?bit|hi10p?|aac(2\.0)?|flac|opus|ac3|eac3|ddp?\d?(\.\d)?|web-?dl|web-?rip|webrip|bd-?rip|bluray|blu-ray|bdrip|dvdrip|hdtv|tv-?rip|amzn|cr|nf|dsnp|multi-?sub|dual[ -]?audio|batch|raw|uncensored|v\d)\b/gi;

function parseName(file) {
  const base = path.basename(file).replace(VIDEO_EXT, "");
  const dubbing = /dublaj|tr[ ._-]?dub|türkçe[ ._-]?dub/i.test(base);
  let s = base
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, " ") // [Grup] (1080p) {CRC}
    .replace(/[_]+/g, " ")
    .replace(/\.(?!\s*\d+\s*(\.|$))/g, " ") // nokta ayırıcıları (sayı içi değil)
    .replace(/\s+/g, " ")
    .trim();

  let season = null;
  let episode = null;
  let cut = s.length; // başlığın bittiği yer

  const take = (re, fn) => {
    const m = re.exec(s);
    if (!m) return false;
    fn(m);
    cut = Math.min(cut, m.index);
    return true;
  };

  // S02E08 / S2 E8
  take(/\bS(\d{1,2})\s*E(\d{1,4})\b/i, (m) => {
    season = Number(m[1]);
    episode = Number(m[2]);
  });
  if (season === null) {
    take(/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i, (m) => (season = Number(m[1]))) ||
      take(/\bseason\s*(\d{1,2})\b/i, (m) => (season = Number(m[1]))) ||
      take(/\b(\d{1,2})\.?\s*sezon\b/i, (m) => (season = Number(m[1]))) ||
      take(/\bS(\d{1,2})\b/, (m) => (season = Number(m[1])));
  }
  if (episode === null) {
    take(/\s-\s*(\d{1,4})(?:v\d)?\b/, (m) => (episode = Number(m[1]))) ||
      take(/\b(?:ep|episode|eps|bölüm|bolum)\.?\s*(\d{1,4})\b/i, (m) => (episode = Number(m[1]))) ||
      take(/\b(\d{1,4})\.?\s*(?:bölüm|bolum)\b/i, (m) => (episode = Number(m[1]))) ||
      take(/\bE(\d{1,4})\b/, (m) => (episode = Number(m[1]))) ||
      take(/\s(\d{1,4})(?:v\d)?\s*$/, (m) => (episode = Number(m[1])));
  }

  const title = s
    .slice(0, cut)
    .replace(NOISE, " ")
    .replace(/\s[-–:|]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return { title, season, episode, dubbing };
}

/** Eşleştirme anahtarı: aynı serinin dosyaları aynı anahtarı üretir. */
function seriesKey(parsed) {
  const t = String(parsed.title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return `${t}|${parsed.season || ""}`;
}

/** Videonun yanındaki aynı adlı altyazı dosyası (ör. Frieren - 05.ass). */
function sidecarSubtitle(file, exists) {
  const stem = file.replace(VIDEO_EXT, "");
  for (const ext of SUB_EXT) {
    for (const candidate of [`${stem}${ext}`, `${stem}.tr${ext}`, `${stem}.tur${ext}`]) {
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

module.exports = { parseName, seriesKey, sidecarSubtitle, VIDEO_EXT };
