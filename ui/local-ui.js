// Yükle (sürükle-bırak, izlenen klasör), Önizleme (opening/ending işaretleme) ve klasör ayarları.
// app.js'ten sonra yüklenir; $, esc, size, show, toast, lastState, I oradan gelir.
(() => {
  const api = window.isleyici;
  $("dz-icon").innerHTML = I.upload;

  const fmt = (t) => {
    if (!Number.isFinite(t)) return "—";
    const s = Math.max(0, Math.round(t));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const STATUS = {
    confirm: ["Onay bekliyor", "warn"],
    ready: ["Sırada", ""],
    processing: ["Hazırlanıyor", "info"],
    preview: ["Önizleme bekliyor", "warn"],
    done: ["Yayında", "ok"],
    failed: ["Hata", "bad"],
    canceled: ["Vazgeçildi", ""],
  };

  // --- sürükle-bırak ----------------------------------------------------------------
  const addPaths = async (paths) => {
    if (!paths.length) return;
    const res = await api.localAdd(paths);
    if (res?.errors?.length) toast(res.errors[0]);
    show("upload");
  };
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types?.includes("Files") || document.body.classList.contains("logged-out")) return;
    e.preventDefault();
    dragDepth++;
    $("drop-overlay").classList.remove("hidden");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $("drop-overlay").classList.add("hidden");
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    $("drop-overlay").classList.add("hidden");
    if (document.body.classList.contains("logged-out")) return;
    const paths = [...(e.dataTransfer?.files || [])].map((f) => api.pathOf(f)).filter(Boolean);
    const subs = paths.filter((p) => /\.(ass|ssa|srt)$/i.test(p));
    const videos = paths.filter((p) => !/\.(ass|ssa|srt)$/i.test(p));
    if (subs.length) {
      // Altyazı: üzerine bırakılan karta; değilse onay bekleyen tek dosya varsa ona.
      const card = e.target.closest?.(".lcard.confirm");
      const waiting = (lastState?.local || []).filter((i) => i.status === "confirm");
      const target = card?.dataset.id || (waiting.length === 1 ? waiting[0].id : "");
      if (target) void api.localSubtitle(target, subs[0]).then((r) => r?.error && toast(r.error));
      else toast("Altyazıyı hangi bölüme eklemek istiyorsan onun kartının üzerine bırak.");
    }
    void addPaths(videos);
  });
  $("pick-files").addEventListener("click", async () => {
    const res = await api.localPickFiles();
    if (res?.errors?.length) toast(res.errors[0]);
  });
  $("local-clear").addEventListener("click", () => api.localClear());

  // --- dosya kartları ---------------------------------------------------------------
  const cards = new Map(); // id -> { el, status, sig }
  const drafts = new Map(); // id -> { anilistId, animeTitle, cover }

  function confirmCard(item) {
    const d = drafts.get(item.id) || { anilistId: item.form.anilistId, animeTitle: item.form.animeTitle, cover: item.form.cover };
    drafts.set(item.id, d);
    const p = item.parsed || {};
    return `
      <div class="lc-head">
        <div class="min0"><div class="li-title">${esc(item.name)}</div>
        <div class="note">${esc(size(item.size))}${p.episode !== null && p.episode !== undefined ? ` · dosya adından: "${esc(p.title || "?")}"${p.season ? ` S${p.season}` : ""} B${p.episode}` : ""}</div></div>
        <span class="st warn">Onay bekliyor</span>
      </div>
      <div class="lc-grid">
        <div class="lc-anime">
          <div class="picked" data-picked>${pickedHtml(d)}</div>
          <input type="text" data-q placeholder="Anime adını yaz… (orijinal ya da İngilizce adı)" value="" />
          <div class="cands" data-cands>${candsHtml(item.candidates, d.anilistId)}</div>
          <div class="subbox" data-sub>${subHtml(item)}</div>
        </div>
        <div class="lc-fields">
          <label class="field"><span>Sezon</span><input type="number" min="1" max="100" data-f="season" value="${esc(item.form.season || 1)}" /></label>
          <label class="field"><span>Bölüm</span><input type="number" min="0" max="5000" data-f="episode" value="${item.form.episode ?? ""}" placeholder="ör. 5" /></label>
          <label class="switch"><input type="checkbox" data-f="dubbing" ${item.form.dubbing ? "checked" : ""} /><i></i><span>Türkçe dublaj</span></label>
          <label class="field"><span>Emeği geçenler <small class="muted">(isteğe bağlı)</small></span><input type="text" data-f="credits" maxlength="200" value="${esc(item.form.credits || "")}" placeholder="Çeviri: … · Encode: …" /></label>
        </div>
      </div>
      <p class="error" data-err>${esc(item.error || "")}</p>
      <div class="row end">
        <button class="btn" data-act="remove" type="button">Kaldır</button>
        <button class="btn primary" data-act="confirm" type="button">Yükle</button>
      </div>`;
  }
  const subHtml = (item) =>
    item.subtitle
      ? `<div class="sub-on">${I.check}<div class="min0"><div class="li-title">${esc(item.subtitle)}</div><div class="note">${item.subtitleManual ? "Seçtiğin altyazı kullanılacak" : "Videonun yanında bulundu, bu kullanılacak"}</div></div><button class="link" data-act="sub-clear" type="button">Kaldır</button></div>`
      : `<button class="subdrop" data-act="sub-pick" type="button"><b>+ Altyazı ekle (.ass / .srt)</b><span>Tıkla ya da altyazı dosyasını buraya sürükle. Eklemezsen MKV'nin içindeki altyazı kullanılır.</span></button>`;
  const pickedHtml = (d) =>
    d.anilistId
      ? `${d.cover ? `<img src="${esc(d.cover)}" alt="" />` : ""}<div class="min0"><div class="li-title">${esc(d.animeTitle || `#${d.anilistId}`)}</div><div class="note">AniList #${d.anilistId}</div></div>`
      : `<span class="muted">Anime seçilmedi — aşağıdan ara ve seç</span>`;
  const candsHtml = (list, selected) =>
    (list || [])
      .map(
        (c) =>
          `<button type="button" class="cand ${c.id === selected ? "on" : ""}" data-cand='${esc(JSON.stringify({ id: c.id, title: c.title, cover: c.cover }))}'>${c.cover ? `<img src="${esc(c.cover)}" alt="" />` : ""}<span><b>${esc(c.title)}</b><small>${[c.year, c.format, c.episodes ? `${c.episodes} bölüm` : ""].filter(Boolean).join(" · ")}</small></span></button>`,
      )
      .join("");

  function statusCard(item) {
    const [label, tone] = STATUS[item.status] || [item.status, ""];
    const f = item.form || {};
    const what = f.anilistId ? `${esc(f.animeTitle || "")} · S${f.season} B${f.episode}${f.dubbing ? " · Dublaj" : ""}` : "";
    return `
      <div class="lc-head">
        ${f.cover ? `<img class="lc-cover" src="${esc(f.cover)}" alt="" />` : `<span class="lc-cover ph">${I.film}</span>`}
        <div class="min0"><div class="li-title">${what || esc(item.name)}</div><div class="note">${esc(item.name)}${item.source === "watch" ? " · izlenen klasör" : ""}</div></div>
        <span class="st ${tone}">${label}</span>
      </div>
      ${item.status === "processing" ? `<div class="bar"><div data-w="${item.progress}"></div></div><div class="note">${esc(item.stage)} · %${item.progress}</div>` : ""}
      ${item.status === "preview" ? `<div class="row end"><button class="btn primary" data-act="open-preview" type="button">Önizlemeyi aç</button></div>` : ""}
      ${item.status === "failed" ? `<p class="error">${esc(item.error)}</p>` : ""}
      ${["failed", "canceled", "ready", "done"].includes(item.status) ? `<div class="row end">${item.status === "failed" || item.status === "canceled" ? `<button class="btn" data-act="retry" type="button">Tekrar dene</button>` : ""}${item.status !== "done" ? `<button class="btn" data-act="remove" type="button">Kaldır</button>` : ""}</div>` : ""}`;
  }

  function renderLocal(s) {
    const items = s.local || [];
    const list = $("local-list");
    $("local-blocked").classList.toggle("hidden", !s.device || s.canLocal);
    const waiting = items.filter((i) => i.status === "confirm" || i.status === "preview").length;
    $("upload-dot").textContent = String(waiting);
    $("upload-dot").classList.toggle("hidden", !waiting);
    const seen = new Set();
    for (const item of items) {
      seen.add(item.id);
      let c = cards.get(item.id);
      if (!c) {
        const el = document.createElement("li");
        el.className = "lcard";
        el.dataset.id = item.id;
        list.prepend(el);
        c = { el, status: "", sig: "" };
        cards.set(item.id, c);
      }
      if (item.status === "confirm") {
        // Kullanıcı yazarken kart yeniden çizilmez; yalnızca adaylar ve hata güncellenir.
        if (c.status !== "confirm") {
          c.el.innerHTML = confirmCard(item);
          c.subSig = `${item.subtitle}|${item.subtitleManual}`;
        } else {
          const sig = JSON.stringify(item.candidates.map((x) => x.id)) + item.form.anilistId;
          if (sig !== c.sig) {
            const d = drafts.get(item.id);
            if (d && !d.touched && item.form.anilistId && !d.anilistId) Object.assign(d, { anilistId: item.form.anilistId, animeTitle: item.form.animeTitle, cover: item.form.cover });
            c.el.querySelector("[data-cands]").innerHTML = candsHtml(item.candidates, d?.anilistId);
            c.el.querySelector("[data-picked]").innerHTML = pickedHtml(d || {});
          }
          const subSig = `${item.subtitle}|${item.subtitleManual}`;
          if (c.subSig !== subSig) c.el.querySelector("[data-sub]").innerHTML = subHtml(item);
          c.subSig = subSig;
          c.el.querySelector("[data-err]").textContent = item.error || "";
        }
        c.sig = JSON.stringify(item.candidates.map((x) => x.id)) + item.form.anilistId;
      } else {
        const sig = `${item.status}|${item.progress}|${item.stage}|${item.error}`;
        if (sig !== c.sig) {
          c.el.innerHTML = statusCard(item);
          // CSP satır içi stile izin vermez: genişlik JS ile.
          const bar = c.el.querySelector("[data-w]");
          if (bar) bar.style.width = `${bar.dataset.w}%`;
        }
        c.sig = sig;
      }
      c.el.className = `lcard ${item.status}`;
      c.status = item.status;
    }
    for (const [id, c] of cards) {
      if (!seen.has(id)) {
        c.el.remove();
        cards.delete(id);
        drafts.delete(id);
      }
    }
    if (!items.length && !list.querySelector(".empty")) list.innerHTML = `<li class="empty">Henüz dosya yok. Yukarıya sürükle ya da "Dosya seç".</li>`;
    if (items.length) list.querySelector(".empty")?.remove();

    // İzlenen klasör satırı
    const st = window.__settings || {};
    $("watch-line").innerHTML = st.watchEnabled && st.watchDir
      ? `${I.folder}<span>İzlenen klasör: <b>${esc(st.watchDir)}</b> — içine atılan bölümler kendiliğinden yüklenir.</span><button class="link" data-open="${esc(st.watchDir)}" type="button">Klasörü aç</button>`
      : `${I.folder}<span>İzlenen klasör kapalı. Bölümleri bir klasöre atınca kendiliğinden yüklensin istersen Ayarlar → Klasörler.</span><button class="link" data-goto2="settings" type="button">Ayarla</button>`;
  }

  // Kart içi tıklamalar (olay delegasyonu)
  let searchTimer = 0;
  $("local-list").addEventListener("input", (e) => {
    const card = e.target.closest(".lcard");
    if (!card || !e.target.matches("[data-q]")) return;
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    if (q.length < 2) return;
    searchTimer = setTimeout(async () => {
      const list = await api.localSearch(card.dataset.id, q);
      const d = drafts.get(card.dataset.id) || {};
      card.querySelector("[data-cands]").innerHTML = candsHtml(list, d.anilistId);
    }, 400);
  });
  $("local-list").addEventListener("click", async (e) => {
    const card = e.target.closest(".lcard");
    if (!card) return;
    const id = card.dataset.id;
    const cand = e.target.closest("[data-cand]");
    if (cand) {
      const c = JSON.parse(cand.dataset.cand);
      const d = { anilistId: c.id, animeTitle: c.title, cover: c.cover, touched: true };
      drafts.set(id, d);
      card.querySelector("[data-picked]").innerHTML = pickedHtml(d);
      for (const b of card.querySelectorAll("[data-cand]")) b.classList.toggle("on", b === cand);
      return;
    }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "sub-pick") {
      const r = await api.localSubtitle(id);
      if (r?.error) toast(r.error);
      return;
    }
    if (act === "sub-clear") api.localSubtitleClear(id);
    if (act === "remove") api.localRemove(id);
    if (act === "open-preview") show("preview");
    if (act === "retry") {
      const item = (lastState?.local || []).find((i) => i.id === id);
      if (item) await api.localConfirm(id, item.form).then((r) => r?.error && toast(r.error));
    }
    if (act === "confirm") {
      const d = drafts.get(id) || {};
      const val = (f) => card.querySelector(`[data-f="${f}"]`);
      const res = await api.localConfirm(id, {
        anilistId: d.anilistId,
        animeTitle: d.animeTitle,
        cover: d.cover,
        season: Number(val("season").value),
        episode: val("episode").value === "" ? NaN : Number(val("episode").value),
        dubbing: val("dubbing").checked,
        credits: val("credits").value.trim(),
      });
      if (res?.error) card.querySelector("[data-err]").textContent = res.error;
    }
  });
  $("watch-line").addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    if (open) api.openFolder(open.dataset.open);
    if (e.target.closest("[data-goto2]")) show("settings");
  });

  // --- önizleme ---------------------------------------------------------------------
  let pv = null; // { jobId, marks: { op: {start,end}, ed: {start,end} } }
  const video = $("pv-video");
  function renderMarks() {
    for (const t of ["op", "ed"]) {
      const m = pv?.marks[t] || {};
      const el = document.querySelector(`[data-show="${t}"]`);
      el.textContent = m.start !== undefined || m.end !== undefined ? `${fmt(m.start)} – ${fmt(m.end)}${m.start !== undefined && m.end !== undefined ? ` (${Math.round(m.end - m.start)} sn)` : ""}` : "—";
      el.classList.toggle("ok", m.start !== undefined && m.end > m.start + 5);
    }
  }
  function renderPreview(s) {
    const p = s.preview;
    $("preview-empty").classList.toggle("hidden", !!p);
    $("preview-body").classList.toggle("hidden", !p);
    if (!p) {
      if (pv) {
        pv = null;
        video.removeAttribute("src");
        video.load();
      }
      return;
    }
    if (pv?.jobId === p.jobId) return;
    pv = { jobId: p.jobId, marks: { op: {}, ed: {} }, suggest: p.suggest };
    $("pv-title").textContent = p.title;
    $("pv-frames").innerHTML = p.frames.length
      ? p.frames.map((f) => `<figure><img src="${f.src}" alt="" data-t="${f.time}" /><figcaption>${fmt(f.time)}</figcaption></figure>`).join("")
      : `<p class="muted">Kare çıkarılamadı; videodan kontrol edebilirsin.</p>`;
    video.src = p.videoUrl;
    $("pv-suggest").classList.toggle("hidden", !p.suggest?.length);
    $("pv-note").textContent = "";
    renderMarks();
    show("preview");
  }
  $("pv-frames").addEventListener("click", (e) => {
    const t = Number(e.target.closest("img")?.dataset.t);
    if (Number.isFinite(t)) {
      video.currentTime = t;
      void video.play().catch(() => {});
    }
  });
  document.querySelector(".marks").addEventListener("click", (e) => {
    if (!pv) return;
    const set = e.target.closest("[data-set]")?.dataset.set;
    const clear = e.target.closest("[data-clear]")?.dataset.clear;
    if (set) {
      const [t, which] = set.split("-");
      pv.marks[t][which] = Math.round(video.currentTime * 10) / 10;
      // Başı işaretlenince, önceki bölümdeki uzunluk biliniyorsa sonu önerilir.
      if (which === "start" && pv.marks[t].end === undefined) {
        const prev = (pv.suggest || []).find((x) => x.type === t);
        if (prev) pv.marks[t].end = Math.round((pv.marks[t].start + (prev.end - prev.start)) * 10) / 10;
      }
    }
    if (clear) pv.marks[clear] = {};
    renderMarks();
  });
  $("pv-suggest").addEventListener("click", () => {
    if (!pv?.suggest) return;
    for (const s of pv.suggest) pv.marks[s.type] = { start: s.start, end: s.end };
    renderMarks();
    toast("Önceki bölümün zamanları dolduruldu; videodan kontrol et.");
  });
  $("pv-approve").addEventListener("click", () => {
    if (!pv) return;
    const skips = [];
    for (const t of ["op", "ed"]) {
      const m = pv.marks[t];
      if (m.start === undefined && m.end === undefined) continue;
      if (!(m.end > m.start + 5)) {
        $("pv-note").textContent = `${t === "op" ? "Opening" : "Ending"} için başı ve sonunu işaretle (en az 5 sn) ya da temizle.`;
        return;
      }
      skips.push({ type: t, start: m.start, end: m.end });
    }
    video.pause();
    api.previewDecision({ approve: true, skips });
    toast("Yayına alınıyor…");
    show("upload");
  });
  $("pv-cancel").addEventListener("click", () => {
    video.pause();
    api.previewDecision({ approve: false });
    show("upload");
  });

  // --- ayarlar: klasör seçme, hatırlanan seriler --------------------------------------
  for (const btn of document.querySelectorAll("[data-pick]")) {
    btn.addEventListener("click", async () => {
      const p = await api.pickFolder(btn.dataset.pick === "s-watchdir" ? "İzlenecek klasörü seç" : "Çalışma klasörünü seç");
      if (p) $(btn.dataset.pick).value = p;
    });
  }
  window.renderMappings = async () => {
    const list = await api.localMappings();
    $("s-mappings").innerHTML = list.length
      ? list
          .map(
            (m) =>
              `<li><div class="min0"><div class="li-title">${esc(m.title || `#${m.anilistId}`)} · S${m.season}${m.dubbing ? " · Dublaj" : ""}</div><div class="note">dosya adı: ${esc(m.key.split("|")[0])}${m.lastSkips?.length ? " · opening/ending hatırlanıyor" : ""}</div></div><button class="link" data-forget="${esc(m.key)}" type="button">Unut</button></li>`,
          )
          .join("")
      : `<li class="empty">Henüz hatırlanan seri yok. Bir dosyayı onaylayınca burada görünür.</li>`;
  };
  $("s-mappings").addEventListener("click", (e) => {
    const key = e.target.closest("[data-forget]")?.dataset.forget;
    if (key) {
      api.localForget(key);
      setTimeout(() => window.renderMappings(), 100);
    }
  });

  // Ayarları izlenen klasör satırı için önbellekte tut.
  const refreshSettings = async () => (window.__settings = await api.getSettings());
  void refreshSettings();
  $("view-settings").addEventListener("submit", () => setTimeout(refreshSettings, 300));

  api.onState((s) => {
    renderLocal(s);
    renderPreview(s);
  });
})();
