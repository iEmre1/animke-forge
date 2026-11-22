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

/**
 * TTF/OTF/TTC dosyasının aile ve tam adları ("name" tablosu: 1, 4, 16). Dosyanın tamamı değil,
 * yalnızca tablo dizini ve "name" tablosu okunur (sistemdeki yüzlerce font hızlı taranabilsin).
 */
function fontNames(file) {
  const names = new Set();
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const read = (pos, len) => {
      const b = Buffer.alloc(len);
      const n = fs.readSync(fd, b, 0, len, pos);
      return n === len ? b : null;
    };
    const head = read(0, 16);
    if (!head) return names;
    const base = head.toString("ascii", 0, 4) === "ttcf" ? head.readUInt32BE(12) : 0;
    const dirHead = read(base, 12);
    if (!dirHead) return names;
    const numTables = dirHead.readUInt16BE(4);
    if (numTables > 200) return names;
    const dir = read(base + 12, 16 * numTables);
    if (!dir) return names;
    let table = -1;
    let tableLen = 0;
    for (let i = 0; i < numTables; i++) {
      if (dir.toString("ascii", 16 * i, 16 * i + 4) === "name") {
        table = dir.readUInt32BE(16 * i + 8);
        tableLen = dir.readUInt32BE(16 * i + 12);
      }
    }
    if (table < 0 || tableLen > 4 * 1024 * 1024) return names;
    const buf = read(table, tableLen);
    if (!buf) return names;
    const count = buf.readUInt16BE(2);
    const strings = buf.readUInt16BE(4);
    for (let i = 0; i < count; i++) {
      const r = 6 + 12 * i;
      if (r + 12 > buf.length) break;
      const platform = buf.readUInt16BE(r);
      const nameId = buf.readUInt16BE(r + 6);
      if (![1, 4, 16].includes(nameId)) continue;
      const length = buf.readUInt16BE(r + 8);
      const start = strings + buf.readUInt16BE(r + 10);
      const raw = buf.subarray(start, start + length);
      let text;
      if (platform === 0 || platform === 3) {
        const swapped = Buffer.from(raw);
        if (swapped.length % 2) continue;
        swapped.swap16();
        text = swapped.toString("utf16le");
      } else {
        text = raw.toString("latin1");
      }
      if (text) names.add(clean(text));
    }
  } catch {
    // bozuk ya da desteklenmeyen biçim (woff): adı okunamaz
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return names;
}

// --- Bilgisayarda yüklü fontlar --------------------------------------------------------------
// Altyazının kullandığı font dosyada yoksa ama bu bilgisayarda yüklüyse (ör. Windows'la gelen
// Comic Sans MS), Forge onu bölüme kendisi ekler; böylece izleyicilerde de doğru görünür.
const path = require("node:path");
const os = require("node:os");
let systemIndex = null; // ad → dosya

function fontDirs() {
  if (process.platform === "win32") {
    return [
      path.join(process.env.WINDIR || "C:\\Windows", "Fonts"),
      path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Microsoft", "Windows", "Fonts"),
    ];
  }
  if (process.platform === "darwin") return ["/System/Library/Fonts", "/Library/Fonts", path.join(os.homedir(), "Library", "Fonts")];
  return ["/usr/share/fonts", "/usr/local/share/fonts", path.join(os.homedir(), ".fonts"), path.join(os.homedir(), ".local", "share", "fonts")];
}

function buildSystemIndex() {
  const index = new Map();
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (/\.(ttf|otf|ttc)$/i.test(e.name)) {
        for (const n of fontNames(full)) if (!index.has(n)) index.set(n, full);
      }
    }
  };
  for (const d of fontDirs()) walk(d, 0);
  return index;
}

/** Eksik font adları için bilgisayardaki dosyalar: { bulunan: [{ name, file }], bulunamayan: [ad] } */
function findSystemFonts(missing) {
  if (!missing.length) return { found: [], notFound: [] };
  systemIndex ??= buildSystemIndex();
  const found = [];
  const notFound = [];
  for (const name of missing) {
    const file = systemIndex.get(clean(name));
    if (file) found.push({ name, file });
    else notFound.push(name);
  }
  return { found, notFound };
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

module.exports = { usedFonts, fontNames, missingFonts, findSystemFonts };
