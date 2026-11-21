// ffprobe/ffmpeg işlemleri: çözümleme, altyazı ve font ayıklama, 1080p H.264 encode.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_HEIGHT = 1080;
/** Bu oturumda başarıyla çalışan ekran kartı yöntemi (otomatik seçimde önce o denenir). */
let workingMethod = "";
const FONT_EXT = /\.(ttf|otf|ttc|otc|woff2?)$/i;

/** Komutu çalıştırır; işlemciyi siteden/oyundan çalmasın diye düşük öncelik. */
function run(bin, args, { cwd, onStdout, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, windowsHide: true });
    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // bazı sistemlerde izin yok; önemli değil
    }
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      if (onStdout) onStdout(s);
      else stdout += s;
    });
    child.stderr.on("data", (d) => {
      stderr = (stderr + d.toString()).slice(-8000);
    });
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (err) => {
      signal?.removeEventListener("abort", abort);
      reject(err.code === "ENOENT" ? new Error(`${bin} bulunamadı. Ayarlardan ffmpeg yolunu kontrol et.`) : err);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(new Error("İptal edildi."));
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(lastLines(stderr)), { stderr }));
    });
  });
}

const lastLines = (text) =>
  String(text || "")
    .trim()
    .split(/\r?\n/)
    .slice(-3)
    .join(" | ")
    .slice(0, 400) || "ffmpeg hata verdi.";

async function probe(cfg, file) {
  const { stdout } = await run(cfg.ffprobe, [
    "-v", "error", "-print_format", "json", "-show_streams", "-show_format", file,
  ]);
  return JSON.parse(stdout);
}

const lang = (s) => String(s?.tags?.language || "").toLowerCase();
const title = (s) => String(s?.tags?.title || "");

/** Hangi görüntü, ses ve altyazı akışlarının kullanılacağı. */
function pickStreams(info) {
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  if (!video) throw new Error("Dosyada görüntü akışı yok.");

  const audios = streams.filter((s) => s.codec_type === "audio");
  const audio =
    audios.find((s) => ["jpn", "ja"].includes(lang(s))) ||
    audios.find((s) => s.disposition?.default) ||
    audios[0] ||
    null;

  // Metin altyazılar (ASS/SSA/SRT). Görüntü tabanlı (PGS/VobSub) dönüştürülemez.
  const subs = streams.filter(
    (s) => s.codec_type === "subtitle" && ["ass", "ssa", "subrip", "srt", "webvtt", "mov_text"].includes(s.codec_name),
  );
  const tr = (s) => ["tur", "tr"].includes(lang(s)) || /türk|turk/i.test(title(s));
  const subtitle =
    subs.find((s) => tr(s) && /ass|ssa/.test(s.codec_name)) ||
    subs.find(tr) ||
    subs.find((s) => s.disposition?.default) ||
    subs[0] ||
    null;

  const fonts = streams.filter(
    (s) =>
      s.codec_type === "attachment" &&
      (/font|truetype|opentype/i.test(String(s.tags?.mimetype || "")) || FONT_EXT.test(String(s.tags?.filename || ""))),
  );

  const imageSubtitle = streams.some(
    (s) => s.codec_type === "subtitle" && ["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle"].includes(s.codec_name),
  );
  const duration = Number(info.format?.duration) || Number(video.duration) || 0;
  return { video, audio, subtitle, fonts, duration, imageSubtitle };
}

/** Görüntü yeniden encode edilmeden kopyalanabilir mi? (H.264, 8 bit, en fazla hedef yükseklik) */
function canCopyVideo(v, maxHeight = MAX_HEIGHT) {
  return (
    v.codec_name === "h264" &&
    ["yuv420p", "yuvj420p"].includes(v.pix_fmt) &&
    Number(v.height) <= maxHeight &&
    !/10|high 4:4:4|high 4:2:2/i.test(String(v.profile || ""))
  );
}

/** Hedef boyut: yükseklik en fazla maxHeight, oran korunur, çift sayı. Büyütme yok. */
function targetSize(v, maxHeight = MAX_HEIGHT) {
  const w = Number(v.width) || 1920;
  const h = Number(v.height) || 1080;
  if (h <= maxHeight) return { width: w - (w % 2), height: h - (h % 2), scaled: false };
  const width = Math.round((w * maxHeight) / h / 2) * 2;
  return { width, height: maxHeight, scaled: true };
}

async function extractSubtitle(cfg, file, stream, outFile, signal) {
  await run(cfg.ffmpeg, ["-y", "-v", "error", "-i", file, "-map", `0:${stream.index}`, "-c:s", "ass", outFile], { signal });
  return outFile;
}

/** Yüklenen .srt/.ssa dosyasını .ass'a çevirir (zaten .ass ise dokunmaz). */
async function normalizeSubtitle(cfg, inFile, outFile, signal) {
  if (/\.ass$/i.test(inFile)) {
    fs.copyFileSync(inFile, outFile);
    return outFile;
  }
  await run(cfg.ffmpeg, ["-y", "-v", "error", "-i", inFile, "-c:s", "ass", outFile], { signal });
  return outFile;
}

/** MKV'ye gömülü fontları klasöre çıkarır; dosya yollarını döndürür. */
async function dumpFonts(cfg, file, dir, signal) {
  fs.mkdirSync(dir, { recursive: true });
  // -dump_attachment çıktı dosyası istemez ama ffmpeg yine de "çıktı yok" diye hata verir; yok sayılır.
  await run(cfg.ffmpeg, ["-y", "-v", "error", "-dump_attachment:t", "", "-i", file], { cwd: dir, signal }).catch(() => {});
  return fs
    .readdirSync(dir)
    .filter((f) => FONT_EXT.test(f))
    .map((f) => path.join(dir, f));
}

/**
 * Görüntü 1080p H.264 (yuv420p), ses AAC stereo, MP4 (+faststart).
 * Sırayla denenir: tam ekran kartı → işlemci çözme + ekran kartı encode → tamamen işlemci.
 */
async function encode(cfg, file, picks, outFile, onProgress, signal, log, opts = {}) {
  const { video, audio, duration } = picks;
  const maxHeight = opts.maxHeight || MAX_HEIGHT;
  const size = targetSize(video, maxHeight);
  // forceEncode: ikinci kalite (720p) gibi, kopyalamanın anlamsız olduğu durumlar.
  const copyVideo = !opts.forceEncode && canCopyVideo(video, maxHeight);

  const audioArgs = audio
    ? audio.codec_name === "aac" && Number(audio.channels) <= 2
      ? ["-map", `0:${audio.index}`, "-c:a", "copy"]
      : ["-map", `0:${audio.index}`, "-c:a", "aac", "-b:a", "192k", "-ac", "2"]
    : ["-an"];
  const common = ["-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn", "-movflags", "+faststart", "-f", "mp4"];
  // Bit hızı tavanı: anime için 1080p'de 8, 720p'de 2 Mbit/sn yeterli; tavan olmazsa
  // karmaşık sahnelerde dosya gereksiz büyür (720p'nin 1080p'den büyük çıkması gibi).
  const low = size.height <= 720;
  // 720p: 2 Mbit/sn — tipik bir 480p kadar veri; 3 Mbps internette takılmadan oynar.
  const maxrate = low ? "2000k" : "8M";
  const bufsize = low ? "4000k" : "16M";
  const nvenc = [
    "-c:v", "h264_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", low ? "23" : "21", "-b:v", "0",
    "-maxrate", maxrate, "-bufsize", bufsize, "-profile:v", "high", "-spatial-aq", "1", "-aq-strength", "8",
    "-rc-lookahead", "32", "-bf", "3", "-g", "240",
  ];
  const cpuScale = size.scaled
    ? `scale=${size.width}:${size.height}:flags=lanczos,format=yuv420p`
    : "format=yuv420p";

  const nv12Scale = size.scaled ? `scale=${size.width}:${size.height}:flags=lanczos,format=nv12` : "format=nv12";
  const gpu = {
    nvenc: [
      {
        name: "ekran kartı (NVIDIA NVENC + CUDA)",
        pre: ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"],
        v: ["-map", `0:${video.index}`, "-vf", `scale_cuda=${size.width}:${size.height}:format=yuv420p`, ...nvenc],
      },
      { name: "ekran kartı (NVIDIA NVENC)", pre: [], v: ["-map", `0:${video.index}`, "-vf", cpuScale, ...nvenc] },
    ],
    qsv: [
      {
        name: "ekran kartı (Intel QSV)",
        pre: [],
        v: [
          "-map", `0:${video.index}`, "-vf", nv12Scale, "-c:v", "h264_qsv", "-preset", "slower",
          "-global_quality", low ? "23" : "21", "-look_ahead", "1", "-maxrate", maxrate, "-bufsize", bufsize,
          "-profile:v", "high", "-g", "240",
        ],
      },
    ],
    amf: [
      {
        name: "ekran kartı (AMD AMF)",
        pre: [],
        v: [
          "-map", `0:${video.index}`, "-vf", nv12Scale, "-c:v", "h264_amf", "-quality", "quality", "-rc", "qvbr",
          "-qvbr_quality_level", low ? "23" : "25", "-maxrate", maxrate, "-bufsize", bufsize, "-profile:v", "high", "-g", "240",
        ],
      },
    ],
  };
  const cpu = {
    name: "işlemci (x264)",
    pre: [],
    v: [
      "-map", `0:${video.index}`, "-vf", cpuScale, "-c:v", "libx264", "-preset", "veryfast",
      "-crf", low ? "22" : "20", "-maxrate", maxrate, "-bufsize", bufsize, "-tune", "animation", "-profile:v", "high", "-g", "240",
    ],
  };
  // Ayardaki kodlayıcı: "auto" sırayla NVIDIA → Intel → AMD dener; hiçbiri olmazsa işlemciye düşülür.
  // Bir kez çalışan ekran kartı yöntemi hatırlanır (sonraki işlerde boşuna denenmez).
  const encoder = cfg.cpuOnly ? "cpu" : cfg.encoder || "auto";
  let chosen = encoder === "auto" ? [...gpu.nvenc, ...gpu.qsv, ...gpu.amf] : encoder === "cpu" ? [] : gpu[encoder] || [];
  if (encoder === "auto" && workingMethod) chosen = [chosen.find((a) => a.name === workingMethod), ...chosen].filter(Boolean);
  const attempts = copyVideo
    ? [{ name: "kopyalama (encode gerekmedi)", pre: [], v: ["-map", `0:${video.index}`, "-c:v", "copy"] }]
    : [...new Set([...chosen, cpu])];

  let lastError;
  const tries = attempts;
  for (const attempt of tries) {
    if (signal?.aborted) throw new Error("İptal edildi.");
    log(`Encode: ${attempt.name} · hedef ${size.width}x${size.height}`);
    let buffer = "";
    try {
      await run(
        cfg.ffmpeg,
        ["-y", "-v", "error", "-nostats", "-progress", "pipe:1", ...attempt.pre, "-i", file, ...attempt.v, ...audioArgs, ...common, outFile],
        {
          signal,
          onStdout: (chunk) => {
            buffer += chunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";
            for (const line of lines) {
              const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
              if (m && duration > 0) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
            }
          },
        },
      );
      if (attempt.name.startsWith("ekran kartı")) workingMethod = attempt.name;
      return { method: attempt.name, width: size.width, height: size.height, copied: copyVideo };
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
      log(`${attempt.name} başarısız: ${err.message}`);
    }
  }
  throw new Error(`Encode başarısız: ${lastError?.message || "bilinmeyen hata"}`);
}

// --- Reels: kısa dikey videoları küçültme ---------------------------------------------------
// Kısa kenar en fazla 720 px (dikey videoda 720x1280), H.264 + AAC, hızlı başlasın diye faststart.
const REEL_SHORT_SIDE = 720;
const REEL_MAX_BITRATE = 3_000_000;

/** Reels videosu zaten küçük ve uygunsa yeniden işlenmez. */
function reelNeedsEncode(info, fileSize) {
  const v = (info.streams || []).find((s) => s.codec_type === "video");
  if (!v) return { encode: false, reason: "görüntü yok" };
  const short = Math.min(Number(v.width) || 0, Number(v.height) || 0);
  const duration = Number(info.format?.duration) || 0;
  const bitrate = Number(info.format?.bit_rate) || (duration ? (fileSize * 8) / duration : 0);
  const okCodec = v.codec_name === "h264" && v.pix_fmt === "yuv420p" && /mp4|mov/.test(String(info.format?.format_name || ""));
  if (okCodec && short <= REEL_SHORT_SIDE && bitrate && bitrate <= REEL_MAX_BITRATE) {
    return { encode: false, reason: `zaten küçük (${short}p, ${Math.round(bitrate / 1000)} kbit/sn)` };
  }
  return { encode: true, duration };
}

async function encodeReel(cfg, file, info, outFile, onProgress, signal) {
  const v = (info.streams || []).find((s) => s.codec_type === "video");
  const a = (info.streams || []).find((s) => s.codec_type === "audio");
  const duration = Number(info.format?.duration) || 0;
  const w = Number(v.width) || 0;
  const h = Number(v.height) || 0;
  // Kısa kenarı 720'ye indir (büyütme yok); diğer kenar orantılı ve çift sayı.
  const landscape = w > h;
  const scale =
    Math.min(w, h) > REEL_SHORT_SIDE
      ? landscape
        ? `scale=-2:${REEL_SHORT_SIDE}:flags=lanczos`
        : `scale=${REEL_SHORT_SIDE}:-2:flags=lanczos`
      : "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  const args = [
    "-y", "-v", "error", "-nostats", "-progress", "pipe:1", "-i", file,
    "-map", `0:${v.index}`,
    ...(a ? ["-map", `0:${a.index}`, "-c:a", "aac", "-b:a", "128k", "-ac", "2"] : ["-an"]),
    "-vf", `${scale},format=yuv420p`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "24", "-maxrate", "2500k", "-bufsize", "5000k",
    "-tune", "animation", "-profile:v", "high", "-g", "120",
    "-map_metadata", "-1", "-sn", "-dn", "-movflags", "+faststart", "-f", "mp4", outFile,
  ];
  let buffer = "";
  await run(cfg.ffmpeg, args, {
    signal,
    onStdout: (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
        if (m && duration > 0) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
      }
    },
  });
}

module.exports = {
  probe,
  pickStreams,
  extractSubtitle,
  normalizeSubtitle,
  dumpFonts,
  encode,
  targetSize,
  reelNeedsEncode,
  encodeReel,
};
