# Animke Forge

Animke'ye yüklenen bölümleri hazırlayan program: videoyu indirir, 1080p (ve 720p) H.264'e çevirir,
altyazıyı ve fontları ayırır, Animke'nin video deposuna yükler. Bölüm yayına girer.

## Fansublar için kurulum

1. [Animke-Forge-Setup.exe](https://github.com/iEmre1/animke-forge/releases/latest/download/Animke-Forge-Setup.exe)'yi indir ve kur.
2. Animke Forge'u aç, **Animke hesabınla giriş yap**'a bas.
3. Tarayıcıda açılan sayfada kodun aynı olduğuna bak ve **Bu bilgisayarı bağla**'ya bas.

Yalnızca onaylı fansub ekiplerinin üyeleri bağlanabilir; şifre programa yazılmaz. Ekipten ayrılan üyenin
bilgisayarı kendiliğinden durur. Bağlı bilgisayarlar Fansub Paneli'nde listelenir, oradan kaldırılabilir.

Forge kendi ekibinin bölümlerini işler. Yönetici onaylarsa diğer ekiplerin bölümlerine ve Reels
küçültmeye de yardım eder. Pencereyi kapatınca saatin yanındaki simgede çalışmaya devam eder.
Güncellemeler kendiliğinden gelir.

### Bölüm yükleme

- **Sürükle-bırak:** Dosyayı Forge'un "Yükle" sekmesine sürükle; anime/sezon/bölüm dosya adından tahmin edilir, onaylarsın.
  Ham dosya hiçbir yere yüklenmez, Forge kendi bilgisayarında hazırlar.
- **İzlenen klasör:** Ayarlar → Klasörler. İçine düşen bölümler (kopyalanması bitince) kendiliğinden yüklenir;
  tanınan seriler sorulmaz, yüklenen dosya "Yüklendi" alt klasörüne taşınır.
- **Önizleme:** Yayına almadan önce altyazı basılmış kareler ve video.
- **Opening/ending işaretleme:** Önizlemede başı/sonu işaretlenir; sitede "İntro'yu Atla" bu zamanları kullanır.
- Ayrıntılar programdaki **Rehber** sekmesinde ve https://animke.com/forge sayfasında.

### Ayarlar

- **Kodlayıcı:** Otomatik (NVIDIA → Intel → AMD ekran kartı, yoksa işlemci) ya da elle seçim.
- **Kalite:** 1080p + 720p (önerilen) ya da yalnızca 1080p (daha hızlı).
- **Yükleme hız sınırı:** Yüklerken internetin yavaşlamasın diye.
- **Çalışma saatleri:** Ör. yalnızca gece 01:00–09:00.
- **Bildirimler, bilgisayar açılınca başlatma, geçici klasör, kendi ffmpeg'in.**

### Güvenlik

Forge hiçbir Animke şifresi ya da depo anahtarı taşımaz. Giriş yapınca site bu bilgisayara özel bir
anahtar verir; üstlenilen iş için yalnızca o işin dosyalarına birkaç saatliğine yazma izni olur.
Bağlantı panelden ya da Forge'daki "Çıkış yap" ile tek tıkla iptal edilir.

## Sunucuda (VDS) çalıştırma

Pencere açmadan: `node headless.js`. Ayarlar ortam değişkenlerinden ya da çalışma klasöründeki `.env`'den:

```
ANIMKE_WORKER_TOKEN=awk_...      # yönetim paneli → Yüklemeler → Animke Forge → Sunucu için anahtar
ANIMKE_ENCODER=cpu               # ekran kartı yoksa (auto | nvenc | qsv | amf | cpu)
ANIMKE_WORK_DIR=/var/tmp/animke-forge
# İsteğe bağlı: ANIMKE_QUALITY=1080, ANIMKE_HELP=0, ANIMKE_REELS=0, ANIMKE_UPLOAD_LIMIT_MBPS=50, FFMPEG_PATH=/usr/bin/ffmpeg
```

Kurulum (Ubuntu): `npm ci --omit=dev`, sonra `animke-forge.service` dosyasını
`/etc/systemd/system/`'e kopyala → `systemctl enable --now animke-forge`.
Kayıtlar: `journalctl -u animke-forge -f`.

## Yeni sürüm yayınlama

`package.json`'daki `version`'ı artır, sonra `git commit -am "2.0.1" && git tag v2.0.1 && git push origin main v2.0.1`.
GitHub Actions kurulum dosyasını derleyip yayınlar; kurulu Forge'lar kendiliğinden güncellenir.
