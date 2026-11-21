// Önizleme: yayına almadan önce altyazılı örnek kareler + opening/ending işaretlemek için
// videoyu oynatma. Kareler ffmpeg ile altyazı (ve bölümün fontları) basılarak çıkarılır; video,
// yalnızca bu bilgisayardan erişilebilen geçici bir adresle (127.0.0.1) oynatılır.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

function run(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, windowsHide: true });
    let err = "";
    child.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split("\n").pop() || "ffmpeg hata verdi"))));
  });
}

const assTime = (t) => {
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(t.trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
};

/** Konuşma olan anlardan, bölüme yayılmış en fazla 6 an. Altyazı yoksa eşit aralıklarla. */
function pickTimes(subFile, duration) {
  const times = [];
  if (subFile) {
    try {
      for (const line of fs.readFileSync(subFile, "utf8").split(/\r?\n/)) {
        if (!/^dialogue\s*:/i.test(line)) continue;
        const parts = line.slice(line.indexOf(":") + 1).split(",");
        const start = assTime(parts[1] || "");
        const end = assTime(parts[2] || "");
        if (Number.isFinite(start) && end > start && start < duration) times.push(start + Math.min(1, (end - start) / 2));
      }
    } catch {
      // okunamadı
    }
  }
  times.sort((a, b) => a - b);
  if (times.length >= 6) return [0.1, 0.25, 0.4, 0.55, 0.7, 0.85].map((f) => times[Math.floor(f * (times.length - 1))]);
  if (times.length) return times.slice(0, 6);
  return [0.1, 0.25, 0.4, 0.55, 0.7, 0.85].map((f) => f * duration);
}

/** Altyazı basılmış kareler (data: adresi olarak). */
async function frames(cfg, dir, video, subFile, hasFonts, duration) {
  const out = [];
  const times = pickTimes(subFile, duration);
  for (let i = 0; i < times.length; i++) {
    const name = `onizleme-${i}.jpg`;
    // Altyazı filtresi yolu kaçış istediği için çalışma klasöründen göreli adlarla verilir.
    const vf = [subFile ? `subtitles=${path.basename(subFile)}${hasFonts ? ":fontsdir=fonts" : ""}` : "", "scale=960:-2"]
      .filter(Boolean)
      .join(",");
    try {
      await run(cfg.ffmpeg, ["-y", "-v", "error", "-ss", times[i].toFixed(2), "-copyts", "-i", video, "-frames:v", "1", "-vf", vf, "-q:v", "4", name], dir);
      out.push({ time: times[i], src: `data:image/jpeg;base64,${fs.readFileSync(path.join(dir, name)).toString("base64")}` });
    } catch {
      // bu kare alınamadı; diğerleri yeterli
    }
  }
  return out;
}

/** Videoyu yalnızca bu bilgisayardan erişilebilen geçici bir adresle sunar (ileri-geri sarma destekli). */
function serveVideo(file) {
  const token = crypto.randomBytes(16).toString("hex");
  const server = http.createServer((req, res) => {
    if (req.url !== `/${token}/video.mp4`) {
      res.writeHead(404).end();
      return;
    }
    const size = fs.statSync(file).size;
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    if (range) {
      const start = range[1] ? Number(range[1]) : size - Number(range[2]);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start < 0) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": size, "Accept-Ranges": "bytes" });
      fs.createReadStream(file).pipe(res);
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/${token}/video.mp4`, close: () => server.close() });
    });
  });
}

module.exports = { frames, serveVideo, pickTimes };
