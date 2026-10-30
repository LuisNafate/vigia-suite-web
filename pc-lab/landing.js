(() => {
  "use strict";
  const config = window.VIGIA_SEQUENCE;
  const canvas = document.querySelector("#sequenceCanvas");
  const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
  const sequence = document.querySelector("#historia");
  const beats = [...document.querySelectorAll(".story-beat")];
  const loading = document.querySelector("#loadingState");
  const loadingProgress = document.querySelector("#loadingProgress");
  const progressBar = document.querySelector("#sequenceProgress");
  const frameIndex = document.querySelector("#frameIndex");
  const nav = document.querySelector("#globalNav");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const mobile = matchMedia("(max-width: 720px)").matches;
  const frames = new Array(config.frameCount);
  const pending = new Map();
  let loadedCount = 0, currentFrame = 0, targetFrame = 0, lastDrawn = -1, raf = 0;
  const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

  function loadFrame(index) {
    index = Math.max(0, Math.min(config.frameCount - 1, index));
    if (frames[index]) return Promise.resolve(frames[index]);
    if (pending.has(index)) return pending.get(index);
    const promise = new Promise((resolve, reject) => {
      const image = new Image(); image.decoding = "async"; image.src = config.getFramePath(index, mobile);
      image.onload = async () => {
        if (index === 0) loading.classList.add("ready");
        try { if (image.decode) await image.decode(); } catch (_) {}
        frames[index] = image; pending.delete(index); loadedCount += 1;
        loadingProgress.textContent = `${Math.round((loadedCount / config.frameCount) * 100)}% preparado`;
        if (index === 0) { resizeCanvas(); drawFrame(0, true); }
        resolve(image);
      };
      image.onerror = () => { pending.delete(index); reject(new Error(`No se pudo cargar ${image.src}`)); };
    });
    pending.set(index, promise); return promise;
  }

  async function preloadSequence() {
    const priority = [0, 1, 2, 3, 4, 5, 6, config.frameCount - 1];
    await Promise.allSettled(priority.map(loadFrame));
    const remaining = Array.from({ length: config.frameCount }, (_, index) => index).filter(index => !priority.includes(index));
    for (let cursor = 0; cursor < remaining.length; cursor += 8) await Promise.allSettled(remaining.slice(cursor, cursor + 8).map(loadFrame));
  }

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * dpr)), height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; lastDrawn = -1; }
  }

  function drawFrame(index, force = false) {
    index = Math.max(0, Math.min(config.frameCount - 1, Math.round(index)));
    if (!force && index === lastDrawn) return;
    const image = frames[index];
    if (!image) { loadFrame(index).then(() => drawFrame(index, true)).catch(() => {}); return; }
    const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    context.fillStyle = "#090d0e"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    lastDrawn = index; frameIndex.textContent = String(index + 1).padStart(3, "0");
  }

  function beatOpacity(value, start, end) {
    const fade = Math.min(0.07, (end - start) * 0.28);
    if (value < start || value > end) return 0;
    if (start === 0 && value <= start + fade) return 1;
    if (end === 1 && value >= end - fade) return 1;
    if (value < start + fade) return clamp((value - start) / fade);
    if (value > end - fade) return clamp((end - value) / fade);
    return 1;
  }

  function updateFromScroll() {
    const rect = sequence.getBoundingClientRect(), distance = Math.max(1, sequence.offsetHeight - innerHeight);
    const progress = clamp(-rect.top / distance);
    targetFrame = reducedMotion.matches ? (progress > 0.72 ? config.frameCount - 1 : 0) : progress * (config.frameCount - 1);
    progressBar.style.transform = `scaleX(${progress})`; nav.classList.toggle("scrolled", scrollY > 36);
    beats.forEach(beat => {
      const opacity = beatOpacity(progress, Number(beat.dataset.start), Number(beat.dataset.end));
      beat.style.setProperty("--beat-opacity", opacity.toFixed(3)); beat.style.setProperty("--beat-shift", `${(1 - opacity) * 18}px`);
      beat.toggleAttribute("aria-hidden", opacity < 0.02);
    });
  }

  function render() {
    const delta = targetFrame - currentFrame;
    currentFrame = reducedMotion.matches ? targetFrame : currentFrame + delta * 0.22;
    if (Math.abs(delta) < 0.08) currentFrame = targetFrame;
    drawFrame(currentFrame); raf = requestAnimationFrame(render);
  }

  function seekTo(value) {
    const distance = sequence.offsetHeight - innerHeight, top = sequence.getBoundingClientRect().top + scrollY;
    scrollTo({ top: top + distance * value, behavior: reducedMotion.matches ? "auto" : "smooth" });
  }
  document.querySelectorAll("[data-seek]").forEach(link => link.addEventListener("click", event => { event.preventDefault(); seekTo(Number(link.dataset.seek)); }));
  let ticking = false;
  addEventListener("scroll", () => { if (!ticking) requestAnimationFrame(() => { updateFromScroll(); ticking = false; }); ticking = true; }, { passive: true });
  addEventListener("resize", () => { resizeCanvas(); updateFromScroll(); drawFrame(currentFrame, true); }, { passive: true });
  reducedMotion.addEventListener?.("change", updateFromScroll);
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancelAnimationFrame(raf); else render(); });
  resizeCanvas(); updateFromScroll(); preloadSequence(); render();
  if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("service-worker.js").catch(() => {}));
})();
