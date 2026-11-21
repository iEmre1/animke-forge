// Animke Forge — ekransız (sunucu/VDS) çalıştırma: `node headless.js`
// Ayarlar ortam değişkenlerinden ya da çalışma klasöründeki .env dosyasından okunur:
//   ANIMKE_WORKER_TOKEN=awk_...   (zorunlu; yönetim paneli → Yüklemeler → Animke Forge → Sunucu için anahtar)
//   ANIMKE_ENCODER=cpu            (ekran kartı olmayan sunucuda; ya da eski ad ANIMKE_CPU_ONLY=1)
// Günlük satırları standart çıktıya yazılır (systemd: `journalctl -u animke-isleyici -f`).
const { EnvSettings, runtimeConfig } = require("./settings");
const { Engine } = require("./engine");

const settings = new EnvSettings().get();
if (!settings.token) {
  console.error("ANIMKE_WORKER_TOKEN tanımlı değil. Yönetim paneli → Yüklemeler → Animke Forge → \"Sunucu için anahtar\" ile anahtar alıp .env dosyasına yaz.");
  process.exit(1);
}

// Sunucu olarak çalışır: işleri ancak başka uygun Forge yoksa (ya da 8 dk bekledikten sonra) alır.
const engine = new Engine({ ...runtimeConfig(settings), server: true });
engine.on("log", (line) => console.log(line));
engine.on("done", ({ title, ok, error }) => {
  if (!ok) console.error(`İş başarısız: ${title} — ${error}`);
});

let stopping = false;
const shutdown = async (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} alındı, Animke Forge kapatılıyor (süren iş sıraya geri bırakılır)…`);
  await Promise.race([engine.stop(), new Promise((r) => setTimeout(r, 10_000))]);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

const cfg = runtimeConfig(settings);
console.log(`Animke Forge (sunucu) başlıyor · site: ${cfg.siteUrl} · kodlayıcı: ${cfg.encoder} · ffmpeg: ${cfg.ffmpeg}`);
engine.start().catch((err) => {
  console.error(`Başlatılamadı: ${err.message}`);
  process.exit(1);
});
