/**
 * Darktec flasher — version picker, roles, offline UF2 + online File System flash.
 */

import { canOnlineFlash, flashUf2ToDirectory } from "./uf2-flash.js";

const FIRMWARE_REPO = "beeline09/MeshCore";
const RELEASES_API = `https://api.github.com/repos/${FIRMWARE_REPO}/releases?per_page=40`;
const TAG_PREFIX = "darktec-v";

const ROLES = [
  { id: "companion_radio_ble", title: "Companion BLE", blurb: "BLE + OLED UI" },
  { id: "companion_radio_usb", title: "Companion USB", blurb: "USB serial companion" },
  { id: "repeater", title: "Repeater", blurb: "Сетевой ретранслятор" },
  { id: "repeater_bridge_rs232", title: "RS232 Bridge", blurb: "Repeater + Serial1" },
  { id: "room_server", title: "Room server", blurb: "Комнатный сервер" },
  { id: "terminal_chat", title: "Terminal chat", blurb: "Secure chat CLI" },
  { id: "sensor", title: "Sensor", blurb: "Телеметрия / датчики" },
  { id: "kiss_modem", title: "KISS modem", blurb: "KISS over LoRa" },
];

const CHEMS = [
  { id: "liion", title: "Li-ion", blurb: "1S только", cells: [1] },
  { id: "lifepo4", title: "LiFePO4", blurb: "1S только", cells: [1] },
  { id: "lto", title: "LTO", blurb: "1S или 2S (≤ 5 В)", cells: [1, 2] },
];

const DARKTEC_UF2 = /^Darktec_.+\.uf2$/i;

const state = {
  role: "companion_radio_ble",
  chem: "liion",
  cells: 1,
  tab: "offline",
  releases: [],
  selectedTag: null,
  manifest: null,
};

const els = {
  roleChoices: document.getElementById("roleChoices"),
  chemChoices: document.getElementById("chemChoices"),
  cellsChoices: document.getElementById("cellsChoices"),
  cellsStep: document.getElementById("cellsStep"),
  chemHint: document.getElementById("chemHint"),
  downloadStepLabel: document.getElementById("downloadStepLabel"),
  status: document.getElementById("status"),
  downloadBtn: document.getElementById("downloadBtn"),
  fileName: document.getElementById("fileName"),
  versionSelect: document.getElementById("versionSelect"),
  changelogBody: document.getElementById("changelogBody"),
  tabOffline: document.getElementById("tabOffline"),
  tabOnline: document.getElementById("tabOnline"),
  paneOffline: document.getElementById("paneOffline"),
  paneOnline: document.getElementById("paneOnline"),
  flashBtn: document.getElementById("flashBtn"),
  flashStatus: document.getElementById("flashStatus"),
  flashFileName: document.getElementById("flashFileName"),
  flashProgressTrack: document.getElementById("flashProgressTrack"),
  flashProgressBar: document.getElementById("flashProgressBar"),
  photoCarousel: document.getElementById("photoCarousel"),
};

function expectedFileName() {
  return `Darktec_${state.role}_${state.chem}_${state.cells}s.uf2`;
}

function findAsset() {
  const name = expectedFileName().toLowerCase();
  return (state.manifest?.files ?? []).find((f) => f.name.toLowerCase() === name) ?? null;
}

function renderChoices(container, items, selectedId, onSelect) {
  container.replaceChildren(
    ...items.map((item) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "choice";
      btn.setAttribute("aria-pressed", String(item.id === selectedId));
      btn.innerHTML = `<strong>${item.title}</strong><span>${item.blurb}</span>`;
      btn.addEventListener("click", () => onSelect(item.id));
      return btn;
    }),
  );
}

function syncCellsForChem() {
  const chem = CHEMS.find((c) => c.id === state.chem);
  if (!chem.cells.includes(state.cells)) state.cells = chem.cells[0];
  const multi = chem.cells.length > 1;
  els.cellsStep.hidden = !multi;
  els.chemHint.textContent = chem.blurb;
  if (multi) {
    renderChoices(
      els.cellsChoices,
      chem.cells.map((n) => ({
        id: String(n),
        title: `${n}S`,
        blurb: n === 1 ? "одна ячейка" : "две ячейки",
      })),
      String(state.cells),
      (id) => {
        state.cells = Number(id);
        updateDownload();
        renderAll();
      },
    );
  }
}

function setDownloadEnabled(enabled) {
  if (enabled) {
    els.downloadBtn.removeAttribute("aria-disabled");
  } else {
    els.downloadBtn.setAttribute("aria-disabled", "true");
    els.downloadBtn.href = "#";
    els.downloadBtn.removeAttribute("download");
  }
  els.flashBtn.disabled = !enabled || !canOnlineFlash();
}

function updateDownload() {
  const asset = findAsset();
  const name = expectedFileName();
  els.fileName.textContent = name;
  els.flashFileName.textContent = name;

  if (!state.manifest) {
    els.status.textContent = "Не удалось загрузить список прошивок.";
    els.status.className = "status error";
    els.flashStatus.textContent = els.status.textContent;
    setDownloadEnabled(false);
    return;
  }

  if (!asset) {
    const tag = state.manifest.release?.tag;
    els.status.className = "status";
    els.status.textContent = tag
      ? `В ${tag} нет файла ${name}.`
      : `Нет релиза Darktec. После пуша в south_edition появится версия.`;
    els.flashStatus.textContent = els.status.textContent;
    setDownloadEnabled(false);
    return;
  }

  const size = asset.size ? ` · ${(asset.size / 1024).toFixed(0)} KiB` : "";
  els.status.className = "status";
  els.status.textContent = `Готово${size}`;
  els.flashStatus.className = "status";
  els.flashStatus.textContent = canOnlineFlash()
    ? `Готово к записи${size}`
    : "Онлайн-флешер доступен в Chrome / Edge.";
  els.downloadBtn.href = asset.url;
  els.downloadBtn.setAttribute("download", asset.name);
  setDownloadEnabled(true);
}

function renderAll() {
  renderChoices(els.roleChoices, ROLES, state.role, (id) => {
    state.role = id;
    updateDownload();
    renderAll();
  });
  renderChoices(els.chemChoices, CHEMS, state.chem, (id) => {
    state.chem = id;
    syncCellsForChem();
    updateDownload();
    renderAll();
  });
  syncCellsForChem();
  updateDownload();
}

function setTab(tab) {
  state.tab = tab;
  const offline = tab === "offline";
  els.tabOffline.setAttribute("aria-selected", String(offline));
  els.tabOnline.setAttribute("aria-selected", String(!offline));
  els.paneOffline.hidden = !offline;
  els.paneOnline.hidden = offline;
}

function renderMarkdownLite(md) {
  const escape = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = (md || "").split(/\r?\n/);
  const html = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      continue;
    }
    if (line.startsWith("### ")) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      html.push(`<h4>${escape(line.slice(4))}</h4>`);
      continue;
    }
    if (line.startsWith("## ")) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      html.push(`<h3>${escape(line.slice(3))}</h3>`);
      continue;
    }
    if (line.startsWith("- ")) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      let item = escape(line.slice(2));
      item = item.replace(/`([^`]+)`/g, "<code>$1</code>");
      item = item.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      html.push(`<li>${item}</li>`);
      continue;
    }
    if (line.startsWith("---")) continue;
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
    let p = escape(line);
    p = p.replace(/`([^`]+)`/g, "<code>$1</code>");
    p = p.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html.push(`<p>${p}</p>`);
  }
  if (inList) html.push("</ul>");
  return html.join("\n");
}

function manifestFromRelease(release) {
  const files = (release.assets || [])
    .filter((a) => DARKTEC_UF2.test(a.name))
    .map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
    }));

  return {
    source: "api",
    sourceRepo: FIRMWARE_REPO,
    release: {
      tag: release.tag_name,
      name: release.name || release.tag_name,
      url: release.html_url,
      publishedAt: release.published_at,
      notes: release.body || "",
    },
    files,
  };
}

function displayVersion(tag) {
  if (!tag) return "—";
  if (tag === "darktec-latest") return "latest";
  if (tag.startsWith(TAG_PREFIX)) return tag.slice("darktec-".length);
  return tag;
}

function populateVersionSelect() {
  const select = els.versionSelect;
  select.replaceChildren();
  for (const rel of state.releases) {
    const opt = document.createElement("option");
    opt.value = rel.tag_name;
    const label = displayVersion(rel.tag_name);
    const when = rel.published_at
      ? new Date(rel.published_at).toLocaleDateString("ru-RU")
      : "";
    opt.textContent = when ? `${label} · ${when}` : label;
    select.appendChild(opt);
  }
  select.disabled = state.releases.length === 0;
  if (state.selectedTag) select.value = state.selectedTag;
}

function selectRelease(tag) {
  const rel = state.releases.find((r) => r.tag_name === tag);
  if (!rel) return;
  state.selectedTag = tag;
  state.manifest = manifestFromRelease(rel);
  els.changelogBody.innerHTML = renderMarkdownLite(rel.body || "_Нет описания._");
  updateDownload();
}

async function loadReleases() {
  const res = await fetch(RELEASES_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  const all = await res.json();

  const versioned = all.filter(
    (r) => !r.draft && !r.prerelease && /^darktec-v\d+\.\d+\.\d+b\d+$/.test(r.tag_name),
  );
  const latest = all.find((r) => !r.draft && r.tag_name === "darktec-latest");

  // Newest versioned first; keep latest as alias entry pointing to same assets if alone
  state.releases = versioned.length
    ? versioned
    : latest
      ? [latest]
      : [];

  if (!state.releases.length) {
    state.manifest = {
      release: { tag: null, notes: "" },
      files: [],
    };
    els.changelogBody.textContent = "Релизов пока нет.";
    populateVersionSelect();
    return;
  }

  state.selectedTag = state.releases[0].tag_name;
  populateVersionSelect();
  selectRelease(state.selectedTag);
}

function initCarousel() {
  const root = els.photoCarousel;
  if (!root) return;
  const base = root.dataset.photosDir || "./photos/";
  const total = 13;
  let index = 0;

  const stage = document.createElement("div");
  stage.className = "carousel-stage";
  const img = document.createElement("img");
  img.alt = "Darktec";
  img.loading = "lazy";
  stage.appendChild(img);

  const controls = document.createElement("div");
  controls.className = "carousel-controls";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "btn btn-ghost";
  prev.textContent = "←";
  const next = document.createElement("button");
  next.type = "button";
  next.className = "btn btn-ghost";
  next.textContent = "→";
  const counter = document.createElement("span");
  counter.className = "carousel-counter";
  controls.append(prev, counter, next);

  const thumbs = document.createElement("div");
  thumbs.className = "carousel-thumbs";

  const show = (i) => {
    index = (i + total) % total;
    const src = `${base}${String(index + 1).padStart(2, "0")}.png`;
    img.src = src;
    counter.textContent = `${index + 1} / ${total}`;
    thumbs.querySelectorAll("button").forEach((b, idx) => {
      b.setAttribute("aria-current", String(idx === index));
    });
  };

  for (let i = 0; i < total; i++) {
    const t = document.createElement("button");
    t.type = "button";
    t.className = "carousel-thumb";
    const ti = document.createElement("img");
    ti.src = `${base}${String(i + 1).padStart(2, "0")}.png`;
    ti.alt = "";
    ti.loading = "lazy";
    t.appendChild(ti);
    t.addEventListener("click", () => show(i));
    thumbs.appendChild(t);
  }

  prev.addEventListener("click", () => show(index - 1));
  next.addEventListener("click", () => show(index + 1));
  root.append(stage, controls, thumbs);
  show(0);
}

els.downloadBtn.addEventListener("click", (ev) => {
  if (els.downloadBtn.getAttribute("aria-disabled") === "true") ev.preventDefault();
});

els.versionSelect.addEventListener("change", () => {
  selectRelease(els.versionSelect.value);
});

els.tabOffline.addEventListener("click", () => setTab("offline"));
els.tabOnline.addEventListener("click", () => setTab("online"));

function localFirmwareUrl(fileName) {
  return new URL(`./firmware/latest/${fileName}`, import.meta.url).href;
}

async function loadFirmwareBlob(asset) {
  // GitHub release download URLs are CORS-blocked from github.io.
  // Prefer same-origin mirror populated by Sync Darktec releases workflow.
  const localUrl = localFirmwareUrl(asset.name);
  try {
    const res = await fetch(localUrl, { cache: "no-cache" });
    if (res.ok) return await res.blob();
  } catch (err) {
    console.warn("local mirror miss", err);
  }

  els.flashStatus.textContent =
    "Зеркало ещё не готово. Выберите уже скачанный UF2…";
  if ("showOpenFilePicker" in window) {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [
        {
          description: "UF2 firmware",
          accept: { "application/octet-stream": [".uf2"] },
        },
      ],
    });
    return await handle.getFile();
  }

  throw new Error(
    "Не удалось загрузить UF2 (CORS GitHub). Скачайте файл во вкладке Offline и повторите в Chrome/Edge.",
  );
}

els.flashBtn.addEventListener("click", async () => {
  const asset = findAsset();
  if (!asset) return;
  els.flashProgressTrack.hidden = false;
  els.flashProgressBar.style.width = "0%";
  els.flashBtn.disabled = true;
  try {
    els.flashStatus.className = "status";
    els.flashStatus.textContent = "Загрузка UF2…";
    const blob = await loadFirmwareBlob(asset);
    await flashUf2ToDirectory(blob, asset.name, (pct, msg) => {
      els.flashProgressBar.style.width = `${pct}%`;
      if (msg) els.flashStatus.textContent = msg;
    });
    els.flashStatus.className = "status";
    els.flashStatus.textContent = "Прошивка записана. Дождитесь перезагрузки платы.";
  } catch (err) {
    console.error(err);
    els.flashStatus.className = "status error";
    els.flashStatus.textContent = err.message || String(err);
  } finally {
    els.flashBtn.disabled = false;
    updateDownload();
  }
});

async function boot() {
  initCarousel();
  setTab("offline");
  try {
    await loadReleases();
  } catch (err) {
    console.error(err);
    els.status.className = "status error";
    els.status.textContent = `Ошибка загрузки релизов: ${err.message}`;
    els.changelogBody.textContent = els.status.textContent;
  }
  renderAll();
}

boot();
