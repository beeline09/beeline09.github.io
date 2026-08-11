/**
 * Darktec flasher — version picker, roles, offline UF2 + online Serial DFU,
 * plus MeshCore-style USB Console and official Repeater Setup GUI.
 */

import { SerialConsole } from "./lib/console.js";
import {
  canSerialFlash,
  enterDfuMode,
  flashNrfSerial,
  forceAppPortToDfu,
  formatSerialFlashError,
  openDfuSerialPort,
  runBootloaderUpdate,
} from "./serial-flash.js";
import {
  buildIssueUrl,
  findOndemandAssets,
  fetchSouthEditionSha,
  isDefaultRadio,
  normalizeRadio,
  ondemandBaseName,
  pollOndemandAssets,
  RADIO_DEFAULTS,
  slugifyName,
  validateRadio,
} from "./ondemand.js";

/** Official MeshCore USB config GUI (repeater / room). */
const REPEATER_SETUP_URL = "https://config.meshcore.io";
const REPEATER_SETUP_FEATURES =
  "directories=no,titlebar=no,toolbar=no,location=no,status=no,menubar=no,scrollbars=yes,resizable=yes,width=1000,height=800";
const FIRMWARE_REPO = "beeline09/MeshCore";
const RELEASES_API = `https://api.github.com/repos/${FIRMWARE_REPO}/releases?per_page=40`;
const TAG_PREFIX = "darktec-v";

const ROLES = [
  { id: "companion_radio_ble", title: "Companion BLE", blurb: "BLE + OLED UI", advertName: "Darktec Companion BLE" },
  { id: "companion_radio_usb", title: "Companion USB", blurb: "USB serial companion", advertName: "Darktec Companion USB" },
  { id: "repeater", title: "Repeater", blurb: "Сетевой ретранслятор", advertName: "Darktec Repeater" },
  { id: "repeater_bridge_rs232", title: "RS232 Bridge", blurb: "Repeater + Serial1", advertName: "RS232 Bridge" },
  { id: "room_server", title: "Room server", blurb: "Комнатный сервер", advertName: "Darktec Room" },
  { id: "terminal_chat", title: "Terminal chat", blurb: "Secure chat CLI", advertName: "Darktec Chat" },
  { id: "sensor", title: "Sensor", blurb: "Телеметрия / датчики", advertName: "Darktec Sensor" },
  { id: "kiss_modem", title: "KISS modem", blurb: "KISS over LoRa", advertName: "Darktec KISS" },
];

const CHEMS = [
  { id: "liion", title: "Li-ion", blurb: "Только 1S", cells: [1] },
  { id: "lifepo4", title: "LiFePO4", blurb: "Только 1S", cells: [1] },
  { id: "lto", title: "LTO", blurb: "1S или 2S (≤ 5 В)", cells: [1, 2] },
];

const PROTECTS = [
  {
    id: "adc",
    title: "Включена",
    blurb: "рекомендуется",
    hint:
      "Батарея почти села → плата сама засыпает (ADC sleep/wake). Проснётся, когда пакет подтянет штатный зарядник на плате (MCU питается от buck-boost с батареи).",
  },
  {
    id: "off",
    title: "Выключена",
    blurb: "без автоотключения",
    hint:
      "Без автоотключения по АЦП. Защита только от BMS на плате; если BMS нет или не сработает — батарею можно убить глубокой разрядкой.",
  },
];

/** Full matrix after protect modes: 8 roles × 4 chem/cells × 2 protect = 64 basenames. */
const EXPECTED_CHEM_CELLS = [
  { chem: "liion", cells: 1 },
  { chem: "lifepo4", cells: 1 },
  { chem: "lto", cells: 1 },
  { chem: "lto", cells: 2 },
];
const EXPECTED_PROTECTS = ["adc", "off"];

const DARKTEC_ASSET = /^Darktec_.+\.(uf2|zip)$/i;
const BUILDING_MSG = "Прошивка ещё собирается. Приходите сюда позже.";

function expectedBasenames() {
  const names = [];
  for (const role of ROLES) {
    for (const { chem, cells } of EXPECTED_CHEM_CELLS) {
      for (const protect of EXPECTED_PROTECTS) {
        names.push(`Darktec_${role.id}_${chem}_${cells}s_${protect}`);
      }
    }
  }
  return names;
}

/** True when release has every expected basename as both .uf2 and .zip (128 assets). */
function isReleaseComplete(release) {
  const names = new Set(
    (release.assets || [])
      .map((a) => a.name)
      .filter((n) => DARKTEC_ASSET.test(n) && !/^Darktec_uf2_/i.test(n)),
  );
  for (const base of expectedBasenames()) {
    if (!names.has(`${base}.uf2`) || !names.has(`${base}.zip`)) return false;
  }
  return true;
}

const state = {
  role: "companion_radio_ble",
  chem: "liion",
  cells: 1,
  protect: "adc",
  advertName: "Darktec Companion BLE",
  /** User edited name manually; role change won't overwrite until false. */
  advertNameTouched: false,
  radio: { ...RADIO_DEFAULTS },
  tab: "offline",
  releases: [],
  selectedTag: null,
  manifest: null,
  /** @type {string|null} */
  southSha: null,
  /** @type {{ uf2: object|null, zip: object|null }|null} */
  ondemand: null,
  building: false,
  pollAbort: null,
};

const els = {
  roleChoices: document.getElementById("roleChoices"),
  chemChoices: document.getElementById("chemChoices"),
  cellsChoices: document.getElementById("cellsChoices"),
  cellsStep: document.getElementById("cellsStep"),
  chemHint: document.getElementById("chemHint"),
  protectChoices: document.getElementById("protectChoices"),
  protectHint: document.getElementById("protectHint"),
  protectStepLabel: document.getElementById("protectStepLabel"),
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
  dfuBtn: document.getElementById("dfuBtn"),
  bootloaderBtn: document.getElementById("bootloaderBtn"),
  flashStatus: document.getElementById("flashStatus"),
  flashFileName: document.getElementById("flashFileName"),
  flashProgressTrack: document.getElementById("flashProgressTrack"),
  flashProgressBar: document.getElementById("flashProgressBar"),
  photoCarousel: document.getElementById("photoCarousel"),
  setupBtn: document.getElementById("setupBtn"),
  consoleBtn: document.getElementById("consoleBtn"),
  toolsStatus: document.getElementById("toolsStatus"),
  consoleModal: document.getElementById("consoleModal"),
  consoleLog: document.getElementById("consoleLog"),
  consoleForm: document.getElementById("consoleForm"),
  consoleInput: document.getElementById("consoleInput"),
  consoleSendBtn: document.getElementById("consoleSendBtn"),
  consoleConnectBtn: document.getElementById("consoleConnectBtn"),
  consoleDisconnectBtn: document.getElementById("consoleDisconnectBtn"),
  consoleCloseBtn: document.getElementById("consoleCloseBtn"),
  consoleStatus: document.getElementById("consoleStatus"),
  advertNameInput: document.getElementById("advertNameInput"),
  nameStepLabel: document.getElementById("nameStepLabel"),
  nameHint: document.getElementById("nameHint"),
  buildBtn: document.getElementById("buildBtn"),
  buildHint: document.getElementById("buildHint"),
  buildHelpModal: document.getElementById("buildHelpModal"),
  buildHelpOkBtn: document.getElementById("buildHelpOkBtn"),
  buildHelpCancelBtn: document.getElementById("buildHelpCancelBtn"),
  radioStepLabel: document.getElementById("radioStepLabel"),
  radioFreq: document.getElementById("radioFreq"),
  radioBw: document.getElementById("radioBw"),
  radioSf: document.getElementById("radioSf"),
  radioCr: document.getElementById("radioCr"),
  radioTx: document.getElementById("radioTx"),
};

/** @type {{ instance: SerialConsole | null, port: SerialPort | null }} */
const serialCon = {
  instance: null,
  port: null,
};

function expectedBaseName() {
  return `Darktec_${state.role}_${state.chem}_${state.cells}s_${state.protect}`;
}

function expectedFileName() {
  return `${expectedBaseName()}.uf2`;
}

function expectedZipName() {
  return `${expectedBaseName()}.zip`;
}

function defaultAdvertNameForRole(roleId = state.role) {
  return ROLES.find((r) => r.id === roleId)?.advertName || "Darktec";
}

function syncAdvertNameFromRole({ force = false } = {}) {
  if (!force && state.advertNameTouched) return;
  const name = defaultAdvertNameForRole(state.role);
  state.advertName = name;
  if (els.advertNameInput) els.advertNameInput.value = name;
}

function isCustomName() {
  return state.advertName.trim() !== defaultAdvertNameForRole(state.role);
}

function needsCustomBuild() {
  return isCustomName() || !isDefaultRadio(state.radio);
}

function customNameSlug() {
  return slugifyName(state.advertName);
}

function readRadioFromInputs() {
  return normalizeRadio({
    freq: els.radioFreq?.value,
    bw: els.radioBw?.value,
    sf: els.radioSf?.value,
    cr: els.radioCr?.value,
    tx: els.radioTx?.value,
  });
}

function findAsset(ext = "uf2") {
  if (needsCustomBuild()) {
    const asset = ext === "zip" ? state.ondemand?.zip : state.ondemand?.uf2;
    return asset ?? null;
  }
  const name = (ext === "zip" ? expectedZipName() : expectedFileName()).toLowerCase();
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
  syncNameStepLabels();
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
        void refreshOndemandFromCache().then(updateDownload);
        renderAll();
      },
    );
  }
}

function syncProtectHint() {
  const protect = PROTECTS.find((p) => p.id === state.protect);
  els.protectHint.textContent = protect?.hint ?? "";
}

function setDownloadEnabled(enabled) {
  if (enabled) {
    els.downloadBtn.removeAttribute("aria-disabled");
  } else {
    els.downloadBtn.setAttribute("aria-disabled", "true");
    els.downloadBtn.href = "#";
    els.downloadBtn.removeAttribute("download");
  }
  const serialOk = canSerialFlash();
  const zipOk = Boolean(findAsset("zip"));
  // Custom ondemand zips live on GitHub Releases without CORS — Serial DFU
  // needs a same-origin mirror (later). Until then: UF2 download only.
  const serialAllowed = enabled && serialOk && zipOk && !needsCustomBuild();
  els.flashBtn.disabled = !serialAllowed;
  els.dfuBtn.disabled = !enabled || !serialOk;
  if (els.bootloaderBtn) els.bootloaderBtn.disabled = !serialOk;
}

function showBuildingEmptyState() {
  state.manifest = {
    release: { tag: null, notes: "" },
    files: [],
  };
  state.selectedTag = null;
  els.status.className = "status pending";
  els.status.textContent = BUILDING_MSG;
  els.flashStatus.className = "status pending";
  els.flashStatus.textContent = BUILDING_MSG;
  els.changelogBody.innerHTML = `<p class="empty-build">${BUILDING_MSG}</p>`;
  populateVersionSelect();
  setDownloadEnabled(false);
}

function syncNameStepLabels() {
  const chem = CHEMS.find((c) => c.id === state.chem);
  const multi = chem.cells.length > 1;
  // role=1, chem=2, cells?=3, protect, name, radio
  const protectN = multi ? 4 : 3;
  const nameN = protectN + 1;
  const radioN = nameN + 1;
  els.protectStepLabel.textContent = `${protectN} · Защита батареи`;
  if (els.nameStepLabel) els.nameStepLabel.textContent = `${nameN} · Имя ноды`;
  if (els.radioStepLabel) els.radioStepLabel.textContent = `${radioN} · Параметры радио`;
}

async function refreshOndemandFromCache() {
  if (!needsCustomBuild()) {
    state.ondemand = null;
    if (els.buildBtn) els.buildBtn.hidden = true;
    if (els.buildHint) els.buildHint.hidden = true;
    return;
  }
  const radioErr = validateRadio(state.radio);
  if (radioErr) {
    state.ondemand = null;
    if (els.buildBtn) els.buildBtn.hidden = true;
    if (els.buildHint) {
      els.buildHint.hidden = false;
      els.buildHint.textContent = radioErr;
    }
    return;
  }
  if (!state.southSha) {
    state.southSha = await fetchSouthEditionSha();
  }
  const base = ondemandBaseName({
    role: state.role,
    chem: state.chem,
    cells: state.cells,
    protect: state.protect,
    nameSlug: customNameSlug(),
    radio: state.radio,
    sha: state.southSha,
  });
  const found = await findOndemandAssets(base);
  state.ondemand = { uf2: found.uf2, zip: found.zip };
  if (els.buildBtn) {
    els.buildBtn.hidden = Boolean(found.uf2) || state.building;
  }
  if (els.buildHint) {
    els.buildHint.hidden = false;
    els.buildHint.textContent = found.uf2
      ? `Готово: ${base}.uf2 — можно скачать и прошить.`
      : "Готовой прошивки для этих параметров ещё нет. Нажмите «Собрать» — появится простая инструкция (что нажать на GitHub и сколько ждать).";
  }
}

function updateDownload() {
  const asset = findAsset("uf2");
  const zipAsset = findAsset("zip");

  if (needsCustomBuild()) {
    if (state.building) {
      els.status.className = "status pending";
      els.status.textContent =
        "Сборка идёт… около 5 минут. Не закрывайте эту вкладку. Прошивать можно только когда появится «Скачать UF2».";
      els.flashStatus.textContent = els.status.textContent;
      setDownloadEnabled(false);
      if (els.buildBtn) els.buildBtn.hidden = true;
      return;
    }
    if (!asset) {
      els.status.className = "status";
      els.status.textContent =
        "Готовой прошивки для этих параметров ещё нет — сначала соберите, потом прошьёте.";
      els.flashStatus.textContent = els.status.textContent;
      setDownloadEnabled(false);
      if (els.fileName) {
        els.fileName.hidden = true;
      }
      return;
    }
    const size = asset.size ? ` · ${(asset.size / 1024).toFixed(0)} KiB` : "";
    els.status.className = "status";
    els.status.textContent = `Прошивка готова${size} — можно скачать UF2 и прошить.`;
    els.flashStatus.className = "status";
    if (!canSerialFlash()) {
      els.flashStatus.textContent = "Онлайн-флешер: нужен Chrome / Edge (Web Serial).";
    } else if (!zipAsset) {
      els.flashStatus.textContent = "UF2 есть; OTA zip ещё нет в кэше.";
    } else {
      els.flashStatus.textContent =
        "UF2 готов (вкладка Offline). Онлайн Serial DFU для кастомных сборок — позже.";
    }
    els.downloadBtn.href = asset.url;
    els.downloadBtn.setAttribute("download", asset.name);
    if (els.fileName) {
      els.fileName.hidden = false;
      els.fileName.textContent = asset.name;
    }
    setDownloadEnabled(true);
    return;
  }

  if (!state.releases.length) {
    els.status.className = "status pending";
    els.status.textContent = BUILDING_MSG;
    els.flashStatus.className = "status pending";
    els.flashStatus.textContent = BUILDING_MSG;
    setDownloadEnabled(false);
    return;
  }

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
      ? `В ${tag} нет файла для выбранной сборки.`
      : BUILDING_MSG;
    els.flashStatus.textContent = els.status.textContent;
    setDownloadEnabled(false);
    return;
  }

  const size = asset.size ? ` · ${(asset.size / 1024).toFixed(0)} KiB` : "";
  els.status.className = "status";
  els.status.textContent = `Готово${size}`;
  els.flashStatus.className = "status";
  if (!canSerialFlash()) {
    els.flashStatus.textContent = "Онлайн-флешер: нужен Chrome / Edge (Web Serial).";
  } else if (!zipAsset) {
    els.flashStatus.textContent =
      "OTA .zip ещё нет в зеркале/релизе. Offline UF2 доступен; дождитесь сборки с serial DFU пакетами.";
  } else {
    els.flashStatus.textContent = "Готово к Serial DFU";
  }
  els.downloadBtn.href = asset.url;
  els.downloadBtn.setAttribute("download", asset.name);
  if (els.fileName) {
    els.fileName.hidden = false;
    els.fileName.textContent = asset.name;
  }
  setDownloadEnabled(true);
}

function renderAll() {
  renderChoices(els.roleChoices, ROLES, state.role, (id) => {
    state.role = id;
    // Switching role resets to that firmware's default advert name.
    state.advertNameTouched = false;
    syncAdvertNameFromRole({ force: true });
    void refreshOndemandFromCache().then(updateDownload);
    renderAll();
  });
  renderChoices(els.chemChoices, CHEMS, state.chem, (id) => {
    state.chem = id;
    syncCellsForChem();
    void refreshOndemandFromCache().then(updateDownload);
    renderAll();
  });
  renderChoices(els.protectChoices, PROTECTS, state.protect, (id) => {
    state.protect = id;
    syncProtectHint();
    void refreshOndemandFromCache().then(updateDownload);
    renderAll();
  });
  syncCellsForChem();
  syncProtectHint();
  syncNameStepLabels();
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
    .filter((a) => DARKTEC_ASSET.test(a.name) && !/^Darktec_uf2_/i.test(a.name))
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
  if (!state.releases.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "собирается…";
    select.appendChild(opt);
    select.disabled = true;
    return;
  }
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
  select.disabled = false;
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
  // Only fully published matrices (128 Darktec_* uf2+zip). Skip partial / old naming.
  const complete = versioned.filter(isReleaseComplete);
  const latest = all.find((r) => !r.draft && r.tag_name === "darktec-latest");

  state.releases = complete.length
    ? complete
    : latest && isReleaseComplete(latest)
      ? [latest]
      : [];

  if (!state.releases.length) {
    showBuildingEmptyState();
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

function setToolsStatus(text, kind = "") {
  if (!els.toolsStatus) return;
  els.toolsStatus.className = kind ? `status ${kind}` : "status";
  els.toolsStatus.textContent = text || "";
}

function setConsoleStatus(text, kind = "") {
  if (!els.consoleStatus) return;
  els.consoleStatus.className = kind ? `status ${kind}` : "status";
  els.consoleStatus.textContent = text || "";
}

function appendConsoleLog(text) {
  if (!els.consoleLog) return;
  els.consoleLog.textContent += text;
  els.consoleLog.scrollTop = els.consoleLog.scrollHeight;
}

function syncConsoleUi() {
  const connected = Boolean(serialCon.instance?.connected);
  if (els.consoleInput) els.consoleInput.disabled = !connected;
  if (els.consoleSendBtn) els.consoleSendBtn.disabled = !connected;
  if (els.consoleDisconnectBtn) els.consoleDisconnectBtn.disabled = !connected;
  if (els.consoleConnectBtn) {
    els.consoleConnectBtn.disabled = !canSerialFlash() || connected;
    els.consoleConnectBtn.textContent = connected ? "Подключено" : "Подключить";
  }
}

function openConsoleModal() {
  if (!els.consoleModal) return;
  els.consoleModal.hidden = false;
  els.consoleModal.removeAttribute("hidden");
  els.consoleModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function hideConsoleModal() {
  if (!els.consoleModal) return;
  els.consoleModal.hidden = true;
  els.consoleModal.setAttribute("hidden", "");
  els.consoleModal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

/** Always close the Console UI; disconnect serial even after connect/error failures. */
async function closeConsoleModal() {
  try {
    await disconnectConsole({ quiet: true });
  } catch (err) {
    console.warn("console close disconnect", err);
  }
  hideConsoleModal();
  setToolsStatus("");
}

/**
 * Release the app-mode serial port so DFU flash can use Web Serial.
 * Clears status lines that mention an active console session.
 */
async function disconnectConsole(opts = {}) {
  const { quiet = false } = opts;
  const inst = serialCon.instance;
  serialCon.instance = null;
  serialCon.port = null;
  if (inst) {
    try {
      await inst.disconnect();
    } catch (err) {
      console.warn("console disconnect", err);
    }
  }
  syncConsoleUi();
  if (!quiet) {
    setConsoleStatus("Отключено.");
    setToolsStatus("");
  }
}

/**
 * Synchronously detach Console and return its SerialPort for DFU reuse.
 * Must run before any await in a flash click handler so requestPort (if needed)
 * still sees the user gesture when Console was not holding a port.
 * @returns {SerialPort | null}
 */
function stealConsolePortForFlash() {
  const inst = serialCon.instance;
  const port = serialCon.port;
  if (!inst && !port) return null;
  serialCon.instance = null;
  serialCon.port = null;
  if (inst) {
    try {
      inst.controller.abort();
    } catch {
      /* ignore */
    }
  }
  syncConsoleUi();
  setConsoleStatus("Console отключён: порт для DFU.");
  setToolsStatus("Console отключён перед прошивкой.");
  hideConsoleModal();
  return port;
}

function openRepeaterSetup() {
  const win = window.open(
    REPEATER_SETUP_URL,
    "meshcore_config",
    REPEATER_SETUP_FEATURES,
  );
  if (!win) {
    setToolsStatus(
      "Не удалось открыть окно. Разрешите всплывающие окна для этого сайта.",
      "error",
    );
    return;
  }
  setToolsStatus(
    "Открыт официальный MeshCore USB config (repeater / room). Плата — в режиме приложения, не DFU.",
  );
}

async function connectConsoleFromGesture() {
  if (!canSerialFlash()) {
    setConsoleStatus("Нужен Chrome или Edge с Web Serial API (HTTPS).", "error");
    setToolsStatus("Нужен Chrome / Edge (Web Serial).", "error");
    return;
  }

  openConsoleModal();
  setConsoleStatus("Выберите COM платы в режиме приложения…");

  let port;
  try {
    // Bare requestPort (как upstream) — пользователь сам выбирает app COM.
    port = await navigator.serial.requestPort();
  } catch (err) {
    const name = err && typeof err === "object" && "name" in err ? String(err.name) : "";
    if (
      name === "AbortError" ||
      name === "NotFoundError" ||
      /no port selected by the user|user cancelled|user canceled/i.test(
        String(err && typeof err === "object" && "message" in err ? err.message : err),
      )
    ) {
      setConsoleStatus("Выбор порта отменён.", "error");
      return;
    }
    setConsoleStatus(formatSerialFlashError(err), "error");
    return;
  }

  await disconnectConsole({ quiet: true });

  const welcome =
    "-------------------------------------------------------------------------\n" +
    "Darktec / MeshCore serial console\n" +
    "Плата в режиме приложения · 115200\n" +
    "Введите команду и нажмите Enter (пустой Enter — список команд на многих ролях)\n" +
    "-------------------------------------------------------------------------\n\n";
  if (els.consoleLog) els.consoleLog.textContent = welcome;

  const instance = new SerialConsole(port);
  serialCon.instance = instance;
  serialCon.port = port;
  instance.onOutput = (text) => {
    appendConsoleLog(text);
    // SerialConsole sets connected=false when the pipe ends.
    if (!instance.connected) syncConsoleUi();
  };

  syncConsoleUi();
  setConsoleStatus("Подключено @ 115200.");
  setToolsStatus("Console подключён (режим приложения).");
  els.consoleInput?.focus();

  // connect() blocks until disconnect/abort — run without awaiting.
  instance.connect().finally(() => {
    if (serialCon.instance === instance) {
      serialCon.instance = null;
      serialCon.port = null;
    }
    syncConsoleUi();
  });
}

async function openConsoleFlow() {
  openConsoleModal();
  if (serialCon.instance?.connected) {
    syncConsoleUi();
    els.consoleInput?.focus();
    return;
  }
  await connectConsoleFromGesture();
}

function wireUsbTools() {
  // Closed by default — never auto-open on refresh/boot.
  hideConsoleModal();

  els.setupBtn?.addEventListener("click", () => openRepeaterSetup());

  els.consoleBtn?.addEventListener("click", () => {
    void openConsoleFlow();
  });

  els.consoleConnectBtn?.addEventListener("click", () => {
    void connectConsoleFromGesture();
  });

  els.consoleDisconnectBtn?.addEventListener("click", async () => {
    await disconnectConsole();
  });

  els.consoleCloseBtn?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void closeConsoleModal();
  });

  els.consoleModal?.addEventListener("click", (ev) => {
    if (ev.target === els.consoleModal) {
      void closeConsoleModal();
    }
  });

  els.consoleForm?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const text = els.consoleInput?.value ?? "";
    if (!serialCon.instance?.connected) return;
    if (els.consoleInput) els.consoleInput.value = "";
    try {
      await serialCon.instance.sendCommand(text);
      setTimeout(() => {
        if (els.consoleLog) els.consoleLog.scrollTop = els.consoleLog.scrollHeight;
      }, 80);
    } catch (err) {
      setConsoleStatus(formatSerialFlashError(err), "error");
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && els.consoleModal && !els.consoleModal.hidden) {
      void closeConsoleModal();
    }
  });

  const serialOk = canSerialFlash();
  if (!serialOk && els.consoleBtn) {
    els.consoleBtn.disabled = true;
    els.consoleBtn.title = "Нужен Chrome / Edge с Web Serial";
  }
  if (!serialOk) {
    setToolsStatus("USB-инструменты: нужен Chrome / Edge (Web Serial).", "pending");
  }
  syncConsoleUi();
}

function localFirmwareUrl(fileName) {
  return new URL(`./firmware/latest/${fileName}`, import.meta.url).href;
}

async function loadOtaZipBlob(zipName) {
  const localUrl = localFirmwareUrl(zipName);
  let localStatus = 0;
  try {
    const res = await fetch(localUrl, { cache: "no-cache" });
    localStatus = res.status;
    if (res.ok) return await res.blob();
  } catch (err) {
    console.warn("local OTA zip miss", err);
  }

  // GitHub release assets redirect to release-assets.githubusercontent.com without CORS
  // ACAO headers, so browser fetch from the release URL fails. Same-origin Pages mirror
  // (scripts/mirror-firmware.py / Sync Darktec releases) is required for Serial DFU.
  const zipAsset = findAsset("zip");
  const releaseHint = zipAsset?.url
    ? ` Релизный файл есть (${zipAsset.url}), но браузер не может скачать его из‑за CORS — нужен сайт‑зеркало.`
    : "";
  throw new Error(
    `Нет OTA-пакета ${zipName} на зеркале сайта` +
      (localStatus ? ` (HTTP ${localStatus})` : "") +
      `.${releaseHint} Запустите workflow «Sync Darktec releases» в beeline09.github.io после публикации Darktec.`,
  );
}

/** Re-enable download/flash controls without clobbering a flash error status. */
function finishFlashUi() {
  const keepError = els.flashStatus.classList.contains("error");
  const errText = keepError ? els.flashStatus.textContent : null;
  updateDownload();
  if (keepError && errText) {
    els.flashStatus.className = "status error";
    els.flashStatus.textContent = errText;
  }
}

els.dfuBtn.addEventListener("click", async () => {
  // Sync before awaits: reuse Console port or keep gesture for requestPort.
  const consolePort = stealConsolePortForFlash();
  els.dfuBtn.disabled = true;
  if (els.bootloaderBtn) els.bootloaderBtn.disabled = true;
  els.flashStatus.className = "status";
  const onStatus = (msg) => {
    els.flashStatus.className = "status";
    els.flashStatus.textContent = msg;
  };
  try {
    if (consolePort) {
      await forceAppPortToDfu(consolePort, onStatus);
    } else {
      await enterDfuMode(onStatus);
    }
  } catch (err) {
    console.error(err);
    els.flashStatus.className = "status error";
    els.flashStatus.textContent = formatSerialFlashError(err);
  } finally {
    finishFlashUi();
  }
});

els.bootloaderBtn?.addEventListener("click", async () => {
  // UF2 disk path — still drop Console so the serial port is not held open.
  const consolePort = stealConsolePortForFlash();
  if (consolePort) {
    try {
      if (consolePort.readable || consolePort.writable) await consolePort.close();
    } catch {
      /* ignore */
    }
  }
  els.bootloaderBtn.disabled = true;
  els.dfuBtn.disabled = true;
  els.flashBtn.disabled = true;
  els.flashStatus.className = "status";
  const onStatus = (msg) => {
    els.flashStatus.className = "status";
    els.flashStatus.textContent = msg;
  };
  try {
    await runBootloaderUpdate({ onStatus });
    els.flashStatus.className = "status";
  } catch (err) {
    console.error(err);
    els.flashStatus.className = "status error";
    els.flashStatus.textContent = formatSerialFlashError(err);
  } finally {
    finishFlashUi();
  }
});

els.flashBtn.addEventListener("click", async () => {
  const zipAsset = findAsset("zip");
  if (!zipAsset) {
    els.flashStatus.className = "status error";
    els.flashStatus.textContent = "OTA .zip недоступен для этой сборки.";
    return;
  }
  // Sync before awaits: reuse Console port or keep gesture for requestPort.
  const consolePort = stealConsolePortForFlash();
  els.flashProgressTrack.hidden = false;
  els.flashProgressBar.style.width = "0%";
  els.flashBtn.disabled = true;
  els.dfuBtn.disabled = true;
  if (els.bootloaderBtn) els.bootloaderBtn.disabled = true;
  const onStatus = (msg) => {
    els.flashStatus.className = "status";
    els.flashStatus.textContent = msg;
  };
  try {
    // Order (Web Serial gesture):
    // 1) openDfuSerialPort → requestPort(app) OR reuse Console port, force DFU, auto DFU;
    //    on miss → site modal → requestPort(DFU) from a fresh button click
    // 2) fetch zip  3) flash with the already-chosen port
    // No bootloader dialogs here — UF2 / OTAFIX is only «Обновить bootloader».
    const dfuPort = await openDfuSerialPort({
      forceDfu: true,
      onStatus,
      appPort: consolePort || undefined,
    });
    onStatus("Загрузка OTA zip…");
    const blob = await loadOtaZipBlob(zipAsset.name);
    await flashNrfSerial(blob, {
      port: dfuPort,
      onStatus,
      onProgress: (pct) => {
        els.flashProgressBar.style.width = `${pct}%`;
      },
    });
    els.flashStatus.className = "status";
    els.flashStatus.textContent =
      "Прошивка записана по Serial DFU. Для Console / «Настройка repeater» переподключите плату в режиме приложения.";
    els.flashProgressBar.style.width = "100%";
  } catch (err) {
    console.error(err);
    els.flashStatus.className = "status error";
    els.flashStatus.textContent = formatSerialFlashError(err);
  } finally {
    finishFlashUi();
  }
});

async function boot() {
  initCarousel();
  setTab("offline");
  wireUsbTools();
  syncAdvertNameFromRole({ force: true });
  wireOndemandUi();
  try {
    state.southSha = await fetchSouthEditionSha();
  } catch (err) {
    console.warn("south_edition sha", err);
  }
  try {
    await loadReleases();
  } catch (err) {
    console.error(err);
    els.status.className = "status error";
    els.status.textContent = `Ошибка загрузки релизов: ${err.message}`;
    els.changelogBody.textContent = els.status.textContent;
  }
  await refreshOndemandFromCache();
  renderAll();
}

function showBuildHelpModal() {
  return new Promise((resolve) => {
    const modal = els.buildHelpModal;
    if (!modal || !els.buildHelpOkBtn || !els.buildHelpCancelBtn) {
      resolve(true);
      return;
    }

    const finish = (ok) => {
      modal.hidden = true;
      modal.setAttribute("aria-hidden", "true");
      els.buildHelpOkBtn.removeEventListener("click", onOk);
      els.buildHelpCancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(ok);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdrop = (ev) => {
      if (ev.target === modal) finish(false);
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") finish(false);
    };

    els.buildHelpOkBtn.addEventListener("click", onOk);
    els.buildHelpCancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    els.buildHelpOkBtn.focus();
  });
}

function wireOndemandUi() {
  if (!els.advertNameInput && !els.radioFreq) return;

  let debounce = null;
  const scheduleRefresh = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      void refreshOndemandFromCache().then(updateDownload);
    }, 300);
  };

  els.advertNameInput?.addEventListener("input", () => {
    state.advertName = els.advertNameInput.value;
    state.advertNameTouched = true;
    scheduleRefresh();
  });

  const onRadioInput = () => {
    state.radio = readRadioFromInputs();
    scheduleRefresh();
  };
  for (const el of [
    els.radioFreq,
    els.radioBw,
    els.radioSf,
    els.radioCr,
    els.radioTx,
  ]) {
    el?.addEventListener("input", onRadioInput);
    el?.addEventListener("change", onRadioInput);
  }

  els.buildBtn?.addEventListener("click", async () => {
    if (!needsCustomBuild()) return;
    const radioErr = validateRadio(state.radio);
    if (radioErr) {
      els.status.className = "status error";
      els.status.textContent = radioErr;
      return;
    }
    const proceed = await showBuildHelpModal();
    if (!proceed) return;
    try {
      if (!state.southSha) state.southSha = await fetchSouthEditionSha();
      const nameSlug = customNameSlug();
      const base = ondemandBaseName({
        role: state.role,
        chem: state.chem,
        cells: state.cells,
        protect: state.protect,
        nameSlug,
        radio: state.radio,
        sha: state.southSha,
      });
      const url = buildIssueUrl({
        role: state.role,
        chem: state.chem,
        cells: state.cells,
        protect: state.protect,
        advertName: state.advertName.trim(),
        nameSlug,
        radio: state.radio,
        sha: state.southSha,
      });
      window.open(url, "_blank", "noopener");
      state.building = true;
      updateDownload();
      if (els.buildHint) {
        els.buildHint.hidden = false;
        els.buildHint.textContent =
          "Ждём сборку (~5 мин). На GitHub уже нажали Create/Submit? Вкладку можно закрыть — оставайтесь на этой странице.";
      }
      if (state.pollAbort) state.pollAbort.abort();
      state.pollAbort = new AbortController();
      const found = await pollOndemandAssets(base, {
        signal: state.pollAbort.signal,
        onTick: () => {
          els.status.className = "status pending";
          els.status.textContent =
            "Ждём готовую прошивку (~5 мин). Не закрывайте эту вкладку…";
        },
      });
      state.ondemand = { uf2: found.uf2, zip: found.zip };
      state.building = false;
      if (els.buildBtn) els.buildBtn.hidden = true;
      updateDownload();
    } catch (err) {
      console.error(err);
      state.building = false;
      els.status.className = "status error";
      els.status.textContent =
        err.message === "timeout"
          ? "За 12 минут файл не появился. Проверьте, что на GitHub нажали Create/Submit, и обновите страницу."
          : `Сборка: ${err.message}`;
      updateDownload();
    }
  });
}

boot();
