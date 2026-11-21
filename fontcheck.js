// Font denetimi: altyazının (ASS) kullandığı fontlardan dosyaya eklenmemiş olanları bulur.
// Sitede altyazı tarayıcıda çizilir ve yalnızca bölümle gelen fontlar kullanılabilir; eksik font
// varsayılan yazı tipiyle görünür (tabelalar, şarkı sözleri bozulur). Yükleme yine yapılır, uyarı
// fansub paneline ve işleyicinin kaydına yazılır.
const fs = require("node:fs");

/** Sitede her zaman bulunan (yedek) fontlar: bunlar eksik sayılmaz. */
const ALWAYS = new Set(["arial", "liberation sans", "helvetica", "sans-serif", "default"]);

const clean = (s) => String(s || "").trim().replace(/^@/, "").toLowerCase();

/** ASS dosyasında kullanılan font adları (stiller + satır içi \fn). */
function usedFonts(assText) {
  const used = new Set();
  let format = null;
  let inStyles = false;
  for (const line of assText.split(/\r?\n/)) {
    const t = line.trim();
    if (/^\[.*\]$/.test(t)) {
      inStyles = /styles/i.test(t);
      format = null;
      continue;
    }
    if (inStyles && /^format\s*:/i.test(t)) {
      format = t.slice(t.indexOf(":") + 1).split(",").map((s) => s.trim().toLowerCase());
      continue;
    }
    if (inStyles && /^style\s*:/i.test(t) && format) {
      const idx = format.indexOf("fontname");
      const parts = t.slice(t.indexOf(":") + 1).split(",");
      if (idx >= 0 && parts[idx]) used.add(clean(parts[idx]));
      continue;
    }
    if (/^dialogue\s*:/i.test(t)) {
      for (const m of t.matchAll(/\\fn([^\\}]+)/g)) used.add(clean(m[1]));
    }
  }
  used.delete("");
  return used;
}

/** TTF/OTF/TTC dosyasının aile ve tam adları ("name" tablosu: 1, 4, 16). */
function fontNames(file) {
  const names = new Set();
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return names;
  }
  try {
    let base = 0;
    if (buf.toString("ascii", 0, 4) === "ttcf") base = buf.readUInt32BE(12);
    const numTables = buf.readUInt16BE(base + 4);
    let table = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + 16 * i;
      if (buf.toString("ascii", rec, rec + 4) === "name") table = buf.readUInt32BE(rec + 8);
    }
    if (table < 0) return names;
    const count = buf.readUInt16BE(table + 2);
    const strings = table + buf.readUInt16BE(table + 4);
    for (let i = 0; i < count; i++) {
      const r = table + 6 + 12 * i;
      const platform = buf.readUInt16BE(r);
      const nameId = buf.readUInt16BE(r + 6);
      if (![1, 4, 16].includes(nameId)) continue;
      const length = buf.readUInt16BE(r + 8);
      const start = strings + buf.readUInt16BE(r + 10);
      const raw = buf.subarray(start, start + length);
      let text;
      if (platform === 0 || platform === 3) {
        const swapped = Buffer.from(raw);
        swapped.swap16();
        text = swapped.toString("utf16le");
      } else {
        text = raw.toString("latin1");
      }
      if (text) names.add(clean(text));
    }
  } catch {
    // bozuk ya da desteklenmeyen biçim (woff): adı okunamaz
  }
  return names;
}

/** Eksik fontların listesi (görünen adlarıyla). */
function missingFonts(assFile, fontFiles) {
  let text = "";
  try {
    text = fs.readFileSync(assFile, "utf8");
  } catch {
    return [];
  }
  const used = usedFonts(text);
  const have = new Set();
  for (const f of fontFiles) for (const n of fontNames(f)) have.add(n);
  // Dosya adı da bir ipucu (ör. "Gandhi Sans.ttf"), adı okunamayan fontlar için.
  for (const f of fontFiles) have.add(clean(require("node:path").basename(f).replace(/\.[^.]+$/, "")));
  return [...used].filter((u) => !ALWAYS.has(u) && !have.has(u));
}

module.exports = { usedFonts, fontNames, missingFonts };
