/**
 * Photo carousel for Darktec: slide animation, keyboard, swipe.
 * Critical layout is applied inline so cached site.css cannot kill motion.
 */

const SLIDE_MS = 380;

function srcOf(base, i) {
  return `${base}${String(i + 1).padStart(2, "0")}.png`;
}

function makeSlide() {
  const img = document.createElement("img");
  img.className = "carousel-slide";
  img.alt = "";
  img.decoding = "async";
  img.draggable = false;
  img.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;user-select:none;";
  return img;
}

export function initPhotoCarousel(root, { total = 13 } = {}) {
  if (!root) return;
  root.replaceChildren();

  const base = root.dataset.photosDir || "./photos/";
  const spoiler = root.closest("details");
  let index = 0;
  let busy = false;

  const stage = document.createElement("div");
  stage.className = "carousel-stage";
  stage.tabIndex = 0;
  stage.setAttribute("role", "region");
  stage.setAttribute("aria-label", "Фото платы. Листайте стрелками или свайпом.");
  stage.style.cssText += "position:relative;overflow:hidden;touch-action:pan-y;user-select:none;";

  let current = makeSlide();
  let incoming = makeSlide();
  current.alt = "Darktec";
  current.src = srcOf(base, 0);
  incoming.style.transform = "translateX(100%)";
  stage.append(current, incoming);

  const controls = document.createElement("div");
  controls.className = "carousel-controls";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "btn btn-ghost";
  prev.setAttribute("aria-label", "Предыдущее фото");
  prev.textContent = "←";
  const next = document.createElement("button");
  next.type = "button";
  next.className = "btn btn-ghost";
  next.setAttribute("aria-label", "Следующее фото");
  next.textContent = "→";
  const counter = document.createElement("span");
  counter.className = "carousel-counter";
  controls.append(prev, counter, next);

  const thumbs = document.createElement("div");
  thumbs.className = "carousel-thumbs";

  const updateChrome = () => {
    counter.textContent = `${index + 1} / ${total}`;
    current.alt = `Darktec, фото ${index + 1} из ${total}`;
    thumbs.querySelectorAll("button").forEach((b, idx) => {
      b.setAttribute("aria-current", String(idx === index));
    });
  };

  const preload = (i) => {
    const im = new Image();
    im.src = srcOf(base, ((i % total) + total) % total);
  };

  const directionFor = (from, to) => {
    if (from === total - 1 && to === 0) return 1;
    if (from === 0 && to === total - 1) return -1;
    return to > from ? 1 : -1;
  };

  const show = (to, dir = 0) => {
    const nextIdx = ((to % total) + total) % total;
    if (nextIdx === index) return;
    if (busy) return;
    const slideDir = dir || directionFor(index, nextIdx);

    busy = true;
    incoming.src = srcOf(base, nextIdx);
    incoming.style.transition = "none";
    current.style.transition = "none";
    incoming.style.transform = `translate3d(${slideDir * 100}%,0,0)`;
    current.style.transform = "translate3d(0,0,0)";

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const ease = `transform ${SLIDE_MS}ms ease`;
        incoming.style.transition = ease;
        current.style.transition = ease;
        incoming.style.transform = "translate3d(0,0,0)";
        current.style.transform = `translate3d(${-slideDir * 100}%,0,0)`;
      });
    });

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      incoming.removeEventListener("transitionend", onEnd);
      window.clearTimeout(timer);
      const outgoing = current;
      current = incoming;
      incoming = outgoing;
      incoming.style.transition = "none";
      incoming.style.transform = "translate3d(100%,0,0)";
      current.style.transition = "none";
      current.style.transform = "translate3d(0,0,0)";
      index = nextIdx;
      busy = false;
      updateChrome();
      preload(index + 1);
      preload(index - 1);
    };
    const onEnd = (ev) => {
      if (ev.propertyName && ev.propertyName !== "transform") return;
      finish();
    };
    incoming.addEventListener("transitionend", onEnd);
    const timer = window.setTimeout(finish, SLIDE_MS + 120);
  };

  for (let i = 0; i < total; i++) {
    const t = document.createElement("button");
    t.type = "button";
    t.className = "carousel-thumb";
    t.setAttribute("aria-label", `Фото ${i + 1}`);
    const ti = document.createElement("img");
    ti.src = srcOf(base, i);
    ti.alt = "";
    ti.loading = "lazy";
    ti.draggable = false;
    t.appendChild(ti);
    t.addEventListener("click", () => show(i, directionFor(index, i)));
    thumbs.appendChild(t);
  }

  prev.addEventListener("click", (ev) => {
    ev.preventDefault();
    show(index - 1, -1);
  });
  next.addEventListener("click", (ev) => {
    ev.preventDefault();
    show(index + 1, 1);
  });

  const isTypingTarget = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return el.isContentEditable;
  };

  const onKey = (ev) => {
    if (spoiler && !spoiler.open) return;
    if (isTypingTarget(ev.target)) return;
    if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      show(index - 1, -1);
    } else if (ev.key === "ArrowRight") {
      ev.preventDefault();
      show(index + 1, 1);
    }
  };
  window.addEventListener("keydown", onKey, true);

  if (spoiler) {
    spoiler.addEventListener("toggle", () => {
      if (spoiler.open) {
        try {
          stage.focus({ preventScroll: true });
        } catch {
          /* ignore */
        }
      }
    });
  }

  let startX = 0;
  let startY = 0;
  let tracking = false;

  const onPointerDown = (ev) => {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    tracking = true;
    startX = ev.clientX;
    startY = ev.clientY;
    try {
      stage.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
  };
  const onPointerUp = (ev) => {
    if (!tracking) return;
    tracking = false;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.abs(dx) < 36) return;
    if (Math.abs(dx) < Math.abs(dy)) return;
    if (dx < 0) show(index + 1, 1);
    else show(index - 1, -1);
  };

  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointercancel", () => {
    tracking = false;
  });

  // iOS Safari fallback
  stage.addEventListener(
    "touchstart",
    (ev) => {
      if (!ev.changedTouches[0]) return;
      tracking = true;
      startX = ev.changedTouches[0].clientX;
      startY = ev.changedTouches[0].clientY;
    },
    { passive: true },
  );
  stage.addEventListener(
    "touchend",
    (ev) => {
      if (!tracking || !ev.changedTouches[0]) return;
      tracking = false;
      const dx = ev.changedTouches[0].clientX - startX;
      const dy = ev.changedTouches[0].clientY - startY;
      if (Math.abs(dx) < 36) return;
      if (Math.abs(dx) < Math.abs(dy)) return;
      if (dx < 0) show(index + 1, 1);
      else show(index - 1, -1);
    },
    { passive: true },
  );

  root.append(stage, controls, thumbs);
  updateChrome();
  preload(1);
  preload(total - 1);
}
