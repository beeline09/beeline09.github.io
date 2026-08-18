/**
 * Darktec flasher — version picker, roles, offline UF2 + online Serial DFU,
 * plus MeshCore-style USB Console and official Repeater Setup GUI.
 */

import { SerialConsole } from "./lib/console.js";
import {
  canSerialFlash,
  flashNrfSerial,
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
  sanitizeAdvertName,
  slugifyName,
  validateAdvertName,
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
  downloadOtaBtn: document.getElementById("downloadOtaBtn"),
  otaHint: document.getElementById("otaHint"),
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
  buildBtnOnline: document.getElementById("buildBtnOnline"),
  buildHint: document.getElementById("buildHint"),
  buildHintOnline: document.getElementById("buildHintOnline"),
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
  syncOtaDownloadButton(enabled ? findAsset("zip") : null);
  syncOnlineActionButtons(enabled);
}

/**
 * Offline «OTA для телефона»: GitHub release URL works in <a href> (no CORS).
 * @param {{ name: string, url: string }|null} zipAsset
 */
function syncOtaDownloadButton(zipAsset) {
  const btn = els.downloadOtaBtn;
  if (!btn) return;
  if (zipAsset?.url) {
    btn.removeAttribute("aria-disabled");
    btn.href = zipAsset.url;
    btn.setAttribute("download", zipAsset.name);
    btn.title = `Скачать ${zipAsset.name} для OTA из приложения MeshCore`;
  } else {
    btn.setAttribute("aria-disabled", "true");
    btn.href = "#";
    btn.removeAttribute("download");
    btn.title = needsCustomBuild()
      ? "OTA zip ещё нет — дождитесь окончания сборки (CI публикует .uf2 и .zip)"
      : "OTA zip недоступен для этой сборки";
  }
}

/**
 * Online tab:
 * - firmware ready → Только DFU + bootloader + Прошить (active)
 * - firmware missing → Собрать + bootloader; Прошить hidden; Только DFU hidden
 */
function syncOnlineActionButtons(firmwareReady) {
  const serialOk = canSerialFlash();
  const uf2 = findAsset("uf2");
  const zipOk = Boolean(findAsset("zip"));
  const ready = Boolean(firmwareReady && uf2);
  const needBuild = needsCustomBuild() && !uf2;

  if (els.dfuBtn) {
    els.dfuBtn.hidden = !ready;
    els.dfuBtn.disabled = !ready;
  }
  if (els.flashBtn) {
    // Catalog: zip on same-origin mirror. Custom: zip on GitHub + mirrored to
    // darktec/firmware/ondemand/ after on-demand CI (CORS-safe Serial DFU).
    const canSerialFlashBtn = ready && zipOk && serialOk;
    els.flashBtn.hidden = !ready;
    els.flashBtn.disabled = !canSerialFlashBtn;
    els.flashBtn.title = canSerialFlashBtn
      ? "Прошивка через Serial (Web Serial)"
      : !zipOk
        ? "Нужен OTA zip (дождитесь публикации сборки)"
        : "Нужны Chrome/Edge и OTA zip";
  }
  if (els.bootloaderBtn) {
    els.bootloaderBtn.hidden = false;
    els.bootloaderBtn.disabled = !serialOk;
  }
  // Собрать visibility is owned by setBuildControls; ensure online build shows when needed.
  if (needBuild && !state.building) {
    if (els.buildBtnOnline) els.buildBtnOnline.hidden = false;
  }
}

/** Show/hide «Собрать» on Offline + Online tabs. */
function setBuildControls({ show = false, hint = "", building = false } = {}) {
  const visible = Boolean(show) && !building;
  for (const btn of [els.buildBtn, els.buildBtnOnline]) {
    if (btn) btn.hidden = !visible;
  }
  const text = hint || "";
  for (const el of [els.buildHint, els.buildHintOnline]) {
    if (!el) continue;
    if (text) {
      el.hidden = false;
      el.textContent = text;
    } else {
      el.hidden = true;
      el.textContent = "";
    }
  }
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
    setBuildControls({ show: false });
    return;
  }
  const radioErr = validateRadio(state.radio);
  if (radioErr) {
    state.ondemand = null;
    setBuildControls({ show: false, hint: radioErr });
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
  if (found.uf2) {
    setBuildControls({
      show: false,
      hint: found.zip
        ? `Готово: ${base} — UF2, OTA zip (телефон) и Serial «Прошить».`
        : `Готово: ${base}.uf2 — скачайте UF2. OTA zip ещё публикуется…`,
      building: state.building,
    });
  } else {
    setBuildControls({
      show: true,
      hint:
        "Готовой прошивки для этих параметров ещё нет. Нажмите «Собрать» — инструкция, что нажать на GitHub, затем ~5 мин ожидания.",
      building: state.building,
    });
  }
}

function updateDownload() {
  const asset = findAsset("uf2");
  const zipAsset = findAsset("zip");

  if (needsCustomBuild()) {
    if (state.building) {
      els.status.className = "status pending";
      els.status.textContent =
        "Сборка идёт… около 5 минут. Не закрывайте эту вкладку.";
      els.flashStatus.className = "status pending";
      els.flashStatus.textContent = els.status.textContent;
      setDownloadEnabled(false);
      setBuildControls({
        show: true,
        hint: "Ждём сборку (~5 мин). На GitHub нажали Create/Submit? Можно закрыть вкладку GitHub.",
        building: true,
      });
      return;
    }
    if (!asset) {
      els.status.className = "status";
      els.status.textContent =
        "Готовой прошивки нет — нажмите «Собрать», затем подождите ~5 мин.";
      els.flashStatus.className = "status";
      els.flashStatus.textContent =
        "Прошивка недоступна. Нажмите «Собрать». «Обновить bootloader» доступен всегда.";
      setDownloadEnabled(false);
      if (els.fileName) els.fileName.hidden = true;
      if (els.flashFileName) els.flashFileName.hidden = true;
      setBuildControls({
        show: true,
        hint:
          "Готовой прошивки для этих параметров ещё нет. Нажмите «Собрать» — инструкция на GitHub, затем ~5 мин.",
      });
      return;
    }
    const size = asset.size ? ` · ${(asset.size / 1024).toFixed(0)} KiB` : "";
    els.status.className = "status";
    els.status.textContent = `Прошивка готова${size}`;
    els.flashStatus.className = "status";
    if (!canSerialFlash()) {
      els.flashStatus.textContent =
        "Готово к прошивке через режим DFU (кнопка «Только DFU»). Для «Прошить» нужен Chrome / Edge.";
    } else if (!zipAsset) {
      els.flashStatus.textContent =
        "UF2 готов. OTA zip ещё публикуется — «Прошить» и «OTA для телефона» появятся через минуту.";
    } else {
      els.flashStatus.textContent =
        "Готово: Serial «Прошить», DFU или OTA zip для телефона.";
    }
    els.downloadBtn.href = asset.url;
    els.downloadBtn.setAttribute("download", asset.name);
    if (els.fileName) {
      els.fileName.hidden = false;
      els.fileName.textContent = asset.name;
    }
    if (els.flashFileName) {
      els.flashFileName.hidden = false;
      els.flashFileName.textContent = asset.name;
    }
    setDownloadEnabled(true);
    setBuildControls({ show: false, hint: `Готово: ${asset.name}` });
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
    els.flashStatus.textContent =
      "Готово к прошивке через режим DFU. Для «Прошить» нужен Chrome / Edge.";
  } else if (!zipAsset) {
    els.flashStatus.textContent =
      "OTA .zip ещё нет. Доступен режим DFU («Только DFU»); «Прошить» / OTA для телефона пока недоступны.";
  } else {
    els.flashStatus.textContent =
      "Готово: Serial «Прошить», DFU или OTA zip для телефона.";
  }
  els.downloadBtn.href = asset.url;
  els.downloadBtn.setAttribute("download", asset.name);
  if (els.fileName) {
    els.fileName.hidden = false;
    els.fileName.textContent = asset.name;
  }
  setBuildControls({ show: false });
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
els.downloadOtaBtn?.addEventListener("click", (ev) => {
  if (els.downloadOtaBtn.getAttribute("aria-disabled") === "true") ev.preventDefault();
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

/**
 * Move focus out of a modal before it becomes aria-hidden / inert.
 * Avoids: "Blocked aria-hidden on an element because its descendant retained focus".
 * @param {HTMLElement | null} modal
 * @param {HTMLElement | null} [restoreTo]
 */
function defocusModal(modal, restoreTo) {
  const active = document.activeElement;
  if (active instanceof HTMLElement && modal?.contains(active)) {
    active.blur();
  }
  const target =
    restoreTo instanceof HTMLElement &&
    restoreTo.isConnected &&
    typeof restoreTo.focus === "function"
      ? restoreTo
      : null;
  if (target) {
    try {
      target.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {HTMLElement | null} modal
 * @param {{ focusEl?: HTMLElement | null }} [opts]
 */
function revealModal(modal, opts = {}) {
  if (!modal) return;
  modal.hidden = false;
  modal.removeAttribute("hidden");
  modal.setAttribute("aria-hidden", "false");
  if ("inert" in modal) modal.inert = false;
  const focusEl =
    opts.focusEl ||
    modal.querySelector(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
  if (focusEl instanceof HTMLElement) {
    try {
      focusEl.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {HTMLElement | null} modal
 * @param {HTMLElement | null} [restoreTo]
 */
function concealModal(modal, restoreTo) {
  if (!modal) return;
  defocusModal(modal, restoreTo);
  modal.hidden = true;
  modal.setAttribute("hidden", "");
  modal.setAttribute("aria-hidden", "true");
  if ("inert" in modal) modal.inert = true;
}

/** @type {HTMLElement | null} */
let consoleFocusReturn = null;

function openConsoleModal() {
  if (!els.consoleModal) return;
  if (els.consoleModal.hidden) {
    const active = document.activeElement;
    consoleFocusReturn =
      active instanceof HTMLElement && !els.consoleModal.contains(active)
        ? active
        : els.consoleBtn;
  }
  revealModal(els.consoleModal);
  document.body.style.overflow = "hidden";
}

function hideConsoleModal() {
  if (!els.consoleModal) return;
  const restore = consoleFocusReturn || els.consoleBtn;
  consoleFocusReturn = null;
  concealModal(els.consoleModal, restore);
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
  // Shared stock mirror under /darktec/ (not duplicated into darktec_new/).
  return new URL(`../darktec/firmware/latest/${fileName}`, import.meta.url).href;
}

function ondemandFirmwareUrl(fileName) {
  return new URL(`../darktec/firmware/ondemand/${fileName}`, import.meta.url).href;
}

/**
 * @param {string} url
 * @returns {Promise<Blob|null>}
 */
async function tryFetchZipBlob(url) {
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob || blob.size < 256) return null;
    return blob;
  } catch (err) {
    console.warn("OTA zip fetch miss", url, err);
    return null;
  }
}

async function loadOtaZipBlob(zipName) {
  // 1) Stock catalog mirror
  const localBlob = await tryFetchZipBlob(localFirmwareUrl(zipName));
  if (localBlob) return localBlob;

  // 2) On-demand mirror (custom builds) — may lag ~1–2 min after CI
  const odUrl = ondemandFirmwareUrl(zipName);
  for (let attempt = 0; attempt < 6; attempt++) {
    const odBlob = await tryFetchZipBlob(odUrl);
    if (odBlob) return odBlob;
    if (attempt < 5) {
      await new Promise((r) => setTimeout(r, 2500));
    }
  }

  // GitHub release assets redirect without CORS — browser fetch cannot read them.
  const zipAsset = findAsset("zip");
  const releaseHint = zipAsset?.url
    ? ` Файл на GitHub есть (${zipAsset.url}), скачайте «OTA для телефона» или подождите зеркало сайта (~1–2 мин после сборки).`
    : "";
  throw new Error(
    `Нет OTA-пакета ${zipName} на зеркале сайта.` +
      `${releaseHint} Для кастомных сборок workflow «Sync Darktec releases» зеркалит zip в darktec/firmware/ondemand/.`,
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
  const uf2 = findAsset("uf2");
  if (!uf2?.url) {
    els.flashStatus.className = "status error";
    els.flashStatus.textContent = "UF2 недоступен для этой сборки.";
    return;
  }
  els.dfuBtn.disabled = true;
  els.flashStatus.className = "status";
  els.flashStatus.textContent =
    "Скачивание UF2… Дважды нажмите RESET, затем скопируйте файл на появившийся DFU-диск.";
  try {
    const a = document.createElement("a");
    a.href = uf2.url;
    a.setAttribute("download", uf2.name);
    a.rel = "noopener";
    a.target = "_blank";
    document.body.appendChild(a);
    a.click();
    a.remove();
    els.flashStatus.className = "status";
    els.flashStatus.textContent =
      `Скачан ${uf2.name}. Двойной RESET → скопируйте UF2 на DFU-диск → плата перезагрузится.`;
  } catch (err) {
    console.error(err);
    els.flashStatus.className = "status error";
    els.flashStatus.textContent = err?.message || String(err);
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

    const active = document.activeElement;
    const returnFocus =
      active instanceof HTMLElement && !modal.contains(active)
        ? active
        : els.buildBtnOnline || els.buildBtn;

    const finish = (ok) => {
      concealModal(modal, returnFocus);
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
    revealModal(modal, { focusEl: els.buildHelpOkBtn });
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
    const cleaned = sanitizeAdvertName(els.advertNameInput.value);
    if (cleaned !== els.advertNameInput.value) {
      const pos = els.advertNameInput.selectionStart;
      els.advertNameInput.value = cleaned;
      // Keep caret roughly in place after stripping chars.
      try {
        els.advertNameInput.setSelectionRange(pos - 1, pos - 1);
      } catch {
        /* ignore */
      }
    }
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

  const onBuildClick = async () => {
    if (!needsCustomBuild()) return;
    const nameErr = validateAdvertName(state.advertName);
    if (nameErr) {
      els.status.className = "status error";
      els.status.textContent = nameErr;
      els.flashStatus.className = "status error";
      els.flashStatus.textContent = nameErr;
      return;
    }
    const radioErr = validateRadio(state.radio);
    if (radioErr) {
      els.status.className = "status error";
      els.status.textContent = radioErr;
      els.flashStatus.className = "status error";
      els.flashStatus.textContent = radioErr;
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
      if (state.pollAbort) state.pollAbort.abort();
      state.pollAbort = new AbortController();
      const found = await pollOndemandAssets(base, {
        signal: state.pollAbort.signal,
        onTick: () => {
          const msg = "Ждём готовую прошивку (~5 мин). Не закрывайте эту вкладку…";
          els.status.className = "status pending";
          els.status.textContent = msg;
          els.flashStatus.className = "status pending";
          els.flashStatus.textContent = msg;
        },
      });
      state.ondemand = { uf2: found.uf2, zip: found.zip };
      state.building = false;
      updateDownload();
    } catch (err) {
      console.error(err);
      state.building = false;
      const msg =
        err.message === "timeout"
          ? "За 12 минут файл не появился. Проверьте, что на GitHub нажали Create/Submit, и обновите страницу."
          : `Сборка: ${err.message}`;
      els.status.className = "status error";
      els.status.textContent = msg;
      els.flashStatus.className = "status error";
      els.flashStatus.textContent = msg;
      updateDownload();
    }
  };

  els.buildBtn?.addEventListener("click", () => void onBuildClick());
  els.buildBtnOnline?.addEventListener("click", () => void onBuildClick());
}

boot();
