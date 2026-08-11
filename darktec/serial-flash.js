/**
 * nRF52 serial DFU flasher (same approach as flasher.meshcore.io).
 * Requires OTA .zip (PlatformIO firmware.zip), Web Serial, Chrome/Edge.
 */
import { Dfu } from "./lib/dfu.js";

/** Adafruit / common nRF52 board USB VID (app + bootloader CDC). */
const USB_VID_ADAFRUIT = 0x239a;
/** Nordic Semiconductor — SoftDevice/serial DFU CDC (e.g. nRF52840 dongle 0x521f). */
const USB_VID_NORDIC = 0x1915;
/** SparkFun — some Pro Micro / nRF52 clones. */
const USB_VID_SPARKFUN = 0x1b4f;
/** Seeed — XIAO nRF52840 and similar. */
const USB_VID_SEEED = 0x2886;

/**
 * Adafruit UF2 bootloader minimum for large firmwares (>512KB).
 * Below 0.6.1 UF2 upgrades fail — see Adafruit_nRF52_Bootloader 0.6.1 release notes
 * and CircuitPython / FakeTec (ProMicro / nice!nano) guides. MeshCore ProMicro uses the
 * same VID/PID family (0x239A / 0x00B3); official flasher recommends OTAFIX 0.9.2.
 * Web Serial getInfo() exposes only VID/PID — version comes from INFO_UF2.TXT on the
 * UF2 mass-storage disk (File System Access API + user directory pick after force-DFU).
 *
 * @see https://github.com/adafruit/Adafruit_nRF52_Bootloader/releases/tag/0.6.1
 * @see https://blog.meshcore.io/2026/04/06/otafix-bootloader
 * @see https://flasher.meshcore.io/firmware/promicro_nrf52840_bootloader-0.9.2-OTAFIX2.1.uf2
 */
export const MIN_ADAFRUIT_BOOTLOADER = "0.6.1";

/** MeshCore-recommended OTAFIX bootloader for ProMicro / nice!nano-class. */
export const RECOMMENDED_ADAFRUIT_BOOTLOADER = "0.9.2";

/** MeshCore OTAFIX UF2 for ProMicro / nice!nano-class (Darktec family). */
const BOOTLOADER_UPDATE_UF2_URL =
  "https://flasher.meshcore.io/firmware/promicro_nrf52840_bootloader-0.9.2-OTAFIX2.1.uf2";
const BOOTLOADER_UPDATE_DOCS_URL =
  "https://blog.meshcore.io/2026/04/06/otafix-bootloader";

/**
 * USB PIDs used by nice!nano / ProMicro NRF52840 / MeshCore Darktec-class boards
 * (Adafruit bootloader family). From MeshCore boards/promicro_nrf52840.json hwids.
 */
const ADAFRUIT_NICE_NANO_FAMILY_PIDS = new Set([
  0x00b3, // nice!nano / ProMicro UF2+CDC (factory clones)
  0x0029,
  0x002a,
  0x8029,
  0x802a,
]);

/** Broad filters for the application COM (first picker). */
const APP_PORT_FILTERS = [
  { usbVendorId: USB_VID_ADAFRUIT },
  { usbVendorId: USB_VID_NORDIC },
  { usbVendorId: USB_VID_SPARKFUN },
  { usbVendorId: USB_VID_SEEED },
];

/**
 * DFU / bootloader-oriented filters (fallback picker + auto-detect preference).
 * Adafruit 1200-baud serial DFU uses 0x239A; Nordic serial DFU often 0x1915.
 */
const DFU_PORT_FILTERS = [
  { usbVendorId: USB_VID_ADAFRUIT },
  { usbVendorId: USB_VID_NORDIC },
];

/** How long to wait for DFU re-enumeration after 1200-baud reboot. */
const DFU_AUTO_DETECT_MS = 12_000;
const DFU_POLL_MS = 250;

export function canSerialFlash() {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

/** Chrome/Edge File System Access — needed to read INFO_UF2.TXT from the UF2 disk. */
export function canPickUf2Directory() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

/**
 * Map Web Serial / Nordic DFU failures to short Russian UI status text.
 * Preserves already clear Russian messages (e.g. mirror zip / browser required).
 * @param {unknown} err
 * @returns {string}
 */
export function formatSerialFlashError(err) {
  const name = err && typeof err === "object" && "name" in err ? String(err.name) : "";
  const raw = err && typeof err === "object" && "message" in err
    ? String(err.message || "")
    : String(err || "");
  const msg = raw.replace(/^Error:\s*/i, "").trim();
  const lower = msg.toLowerCase();
  const causeMsg =
    err && typeof err === "object" && "cause" in err && err.cause && typeof err.cause === "object" &&
    "message" in err.cause
      ? String(err.cause.message || "").toLowerCase()
      : "";

  // requestPort outside a user gesture — before Russian early-return / generic HTTPS SecurityError.
  if (/user gesture|must be handling a user gesture/i.test(`${lower}\n${causeMsg}`)) {
    return "Не удалось запросить порт: действие должно идти сразу от нажатия кнопки. Нажмите «Прошить» ещё раз.";
  }

  // Keep intentional Russian UX copy (mirror miss, Chrome required, etc.).
  if (/[а-яё]/i.test(msg)) {
    return msg;
  }

  // User dismissed the port chooser (Chromium: NotFoundError + this message).
  if (
    name === "AbortError" ||
    /no port selected by the user|user cancelled|user canceled|the user did not select a port/i.test(msg)
  ) {
    return "Выбор порта отменён";
  }

  // No port / device gone / NotFoundError (excluding cancel, handled above).
  if (
    name === "NotFoundError" ||
    /no port|port not found|device not found|the device was disconnected/i.test(lower)
  ) {
    return "Порт не выбран или устройство недоступно";
  }

  // Wrong COM / not DFU / Nordic protocol / open failures / timeouts.
  if (
    name === "NetworkError" ||
    name === "InvalidStateError" ||
    /read timeout|timeout|invalid ack|incomplete ack|invalid slip|serial port not open|stream closed|failed to open|could not open|parity|framing|break error|dfu update|nordic|hci packet|slip escape/i.test(lower)
  ) {
    return "Не удалось открыть DFU. Проверьте, что выбран порт именно платы в режиме DFU (не обычный COM), и что это Darktec/nRF";
  }

  if (name === "SecurityError" || /secure context|must be served over https/i.test(lower)) {
    return "Нужен Chrome или Edge с Web Serial API (HTTPS).";
  }

  return msg || "Ошибка Serial DFU";
}

/**
 * @param {SerialPort} port
 * @returns {{ usbVendorId?: number, usbProductId?: number } & Record<string, unknown>}
 */
function portUsbInfo(port) {
  try {
    return port.getInfo?.() || {};
  } catch {
    return {};
  }
}

/** @param {SerialPort} port */
function isPreferredDfuUsb(port) {
  const { usbVendorId } = portUsbInfo(port);
  return usbVendorId === USB_VID_ADAFRUIT || usbVendorId === USB_VID_NORDIC;
}

/**
 * Parse `x.y.z` from a bootloader version string (tolerates OTAFIX suffixes).
 * @param {string} version
 * @returns {[number, number, number] | null}
 */
export function parseBootloaderSemver(version) {
  const m = String(version || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * @param {string} version
 * @param {string} minimum
 * @returns {boolean | null} true if version < minimum; null if unparseable
 */
export function isBootloaderBelowMinimum(version, minimum = MIN_ADAFRUIT_BOOTLOADER) {
  const a = parseBootloaderSemver(version);
  const b = parseBootloaderSemver(minimum);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

/**
 * True for Adafruit nice!nano / ProMicro / Darktec-class DFU USB identities.
 * @param {SerialPort} port
 */
export function isAdafruitNiceNanoFamilyPort(port) {
  const { usbVendorId, usbProductId } = portUsbInfo(port);
  if (usbVendorId !== USB_VID_ADAFRUIT) return false;
  if (usbProductId == null) return true; // VID match only — treat as family
  return ADAFRUIT_NICE_NANO_FAMILY_PIDS.has(usbProductId);
}

/**
 * Best-effort bootloader version from Web Serial.
 * Chromium SerialPort.getInfo() currently returns only usbVendorId / usbProductId
 * (no bcdDevice / product string), so this almost always returns null.
 * Future browsers may expose version-like fields — we probe a few names.
 *
 * @param {SerialPort} port
 * @returns {string | null}
 */
export function probeBootloaderVersion(port) {
  const info = portUsbInfo(port);
  const candidates = [
    info.usbProductVersion,
    info.usbProductVersionString,
    info.productVersion,
    info.serialNumber,
    info.usbSerialNumber,
  ];
  for (const raw of candidates) {
    if (raw == null || raw === "") continue;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      // bcdDevice style 0x0601 → "6.1" is ambiguous; only accept if already semver-like string
      continue;
    }
    const text = String(raw);
    if (parseBootloaderSemver(text)) return text.trim();
  }
  return null;
}

/**
 * Parse Adafruit / Microsoft UF2 INFO_UF2.TXT contents.
 * Typical first line: `UF2 Bootloader 0.6.1 …` or `UF2 Bootloader v1.1.3 SFA`
 *
 * @param {string} text
 * @returns {{ version: string | null, model: string | null, boardId: string | null, raw: string }}
 */
export function parseInfoUf2Text(text) {
  const raw = String(text || "");
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let version = null;
  let model = null;
  let boardId = null;

  for (const line of lines) {
    const boot = line.match(/^UF2\s+Bootloader\s+v?(\d+\.\d+\.\d+\S*)/i);
    if (boot && !version) {
      version = boot[1];
      continue;
    }
    // Fallback: any semver on the UF2 Bootloader line
    if (!version && /^UF2\s+Bootloader/i.test(line)) {
      const m = line.match(/(\d+\.\d+\.\d+)/);
      if (m) version = m[1];
      continue;
    }
    const modelMatch = line.match(/^Model:\s*(.+)$/i);
    if (modelMatch) {
      model = modelMatch[1].trim();
      continue;
    }
    const boardMatch = line.match(/^Board-ID:\s*(.+)$/i);
    if (boardMatch) {
      boardId = boardMatch[1].trim();
    }
  }

  return { version, model, boardId, raw };
}

/**
 * Find INFO_UF2.TXT (case-insensitive) in a directory handle and parse it.
 * @param {FileSystemDirectoryHandle} dirHandle
 * @returns {Promise<ReturnType<typeof parseInfoUf2Text>>}
 */
export async function readInfoUf2FromDirHandle(dirHandle) {
  /** @type {FileSystemFileHandle | null} */
  let fileHandle = null;
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind !== "file") continue;
    if (String(name).toLowerCase() === "info_uf2.txt") {
      fileHandle = handle;
      break;
    }
  }
  if (!fileHandle) {
    throw new Error("В выбранной папке нет INFO_UF2.TXT — это не DFU-диск UF2.");
  }
  const file = await fileHandle.getFile();
  const text = await file.text();
  const parsed = parseInfoUf2Text(text);
  if (!parsed.version) {
    throw new Error("INFO_UF2.TXT найден, но версия бутлоадера не распознана.");
  }
  return parsed;
}

/**
 * In-page modal: user clicks «Выбрать диск DFU» (fresh gesture) → showDirectoryPicker
 * → read INFO_UF2.TXT. Skip/cancel resolves null (soft-warning path).
 *
 * @param {{ onStatus?: Function }} [opts]
 * @returns {Promise<ReturnType<typeof parseInfoUf2Text> | null>}
 */
export function promptPickUf2Disk(opts = {}) {
  if (!canPickUf2Directory()) return Promise.resolve(null);

  opts.onStatus?.(
    "Выберите USB-диск DFU (появился после перезагрузки), чтобы проверить версию бутлоадера",
  );

  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-labelledby", "uf2DiskModalTitle");

    const panel = document.createElement("div");
    panel.className = "modal-panel";

    const title = document.createElement("h3");
    title.id = "uf2DiskModalTitle";
    title.className = "modal-title";
    title.textContent = "Проверка бутлоадера";

    const body = document.createElement("p");
    body.className = "modal-body";
    body.textContent =
      "Дождитесь появления USB-диска DFU после перезагрузки, затем выберите его — прочитаем INFO_UF2.TXT с версией бутлоадера.";

    const errEl = document.createElement("p");
    errEl.className = "modal-error";
    errEl.hidden = true;

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.className = "btn btn-primary";
    pickBtn.textContent = "Выбрать диск DFU";

    const skipBtn = document.createElement("button");
    skipBtn.type = "button";
    skipBtn.className = "btn btn-ghost";
    skipBtn.textContent = "Пропустить";

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      backdrop.remove();
      resolve(value);
    };

    const setBusy = (busy) => {
      pickBtn.disabled = busy;
      skipBtn.disabled = busy;
    };

    pickBtn.addEventListener("click", async () => {
      errEl.hidden = true;
      setBusy(true);
      try {
        opts.onStatus?.(
          "Выберите USB-диск DFU (появился после перезагрузки), чтобы проверить версию бутлоадера",
        );
        const dirHandle = await window.showDirectoryPicker({
          id: "darktec-uf2-dfu",
          mode: "read",
        });
        const parsed = await readInfoUf2FromDirHandle(dirHandle);
        opts.onStatus?.(
          `Бутлоадер ${parsed.version}` +
            (parsed.model ? ` · ${parsed.model}` : "") +
            " (из INFO_UF2.TXT).",
        );
        finish(parsed);
      } catch (err) {
        const name = err && typeof err === "object" && "name" in err ? String(err.name) : "";
        if (name === "AbortError") {
          // User cancelled the OS directory picker — keep modal for retry/skip.
          errEl.textContent = "Выбор диска отменён. Можно выбрать снова или пропустить.";
          errEl.hidden = false;
          setBusy(false);
          return;
        }
        const msg =
          err && typeof err === "object" && "message" in err
            ? String(err.message || "")
            : String(err || "Ошибка чтения диска");
        errEl.textContent = msg;
        errEl.hidden = false;
        setBusy(false);
      }
    });

    skipBtn.addEventListener("click", () => finish(null));

    actions.append(skipBtn, pickBtn);
    panel.append(title, body, errEl, actions);
    backdrop.append(panel);
    document.body.append(backdrop);
    pickBtn.focus();
  });
}

/**
 * After DFU port is available: warn on old / unknown Adafruit-family bootloaders.
 * Prefer reading INFO_UF2.TXT from the UF2 mass-storage disk (modal + directory picker
 * for a fresh user gesture after force-DFU awaits). Falls back to soft warning when
 * the picker is cancelled, unsupported, or version is unknown.
 *
 * Dialog 1 proposes updating first; if refused, dialog 2 asks to force-flash.
 *
 * @param {SerialPort} port
 * @param {{
 *   onStatus?: Function,
 *   confirmFn?: (msg: string) => boolean,
 *   openUrl?: (url: string) => void,
 *   readInfoUf2?: boolean,
 *   pickUf2Disk?: () => Promise<ReturnType<typeof parseInfoUf2Text> | null>,
 * }} [opts]
 * @returns {Promise<"ok" | "forced" | "skipped">}
 */
export async function ensureAdafruitBootloaderOk(port, opts = {}) {
  const confirmFn = opts.confirmFn || ((msg) => window.confirm(msg));
  const openUrl =
    opts.openUrl ||
    ((url) => {
      try {
        window.open(url, "_blank", "noopener,noreferrer");
      } catch {
        /* ignore */
      }
    });
  const readInfoUf2 = opts.readInfoUf2 !== false;

  if (!isAdafruitNiceNanoFamilyPort(port)) {
    return "skipped";
  }

  /** @type {string | null} */
  let version = probeBootloaderVersion(port);
  /** @type {string | null} */
  let versionSource = version ? "serial" : null;

  if (!version && readInfoUf2 && canPickUf2Directory()) {
    opts.onStatus?.("Ждите появления USB-диска DFU…");
    const pick = opts.pickUf2Disk || (() => promptPickUf2Disk({ onStatus: opts.onStatus }));
    const info = await pick();
    if (info?.version) {
      version = info.version;
      versionSource = "info_uf2";
    }
  }

  const belowMin =
    version != null ? isBootloaderBelowMinimum(version, MIN_ADAFRUIT_BOOTLOADER) : null;
  const belowRecommended =
    version != null
      ? isBootloaderBelowMinimum(version, RECOMMENDED_ADAFRUIT_BOOTLOADER)
      : null;

  // At/above MeshCore OTAFIX recommendation — proceed.
  if (version && belowRecommended === false) {
    opts.onStatus?.(
      `Бутлоадер ${version} (≥ ${RECOMMENDED_ADAFRUIT_BOOTLOADER}) — OK` +
        (versionSource === "info_uf2" ? " (INFO_UF2.TXT)." : "."),
    );
    return "ok";
  }

  const knownBelowMin = belowMin === true;
  const knownBelowRecommended = belowRecommended === true;
  let updateMsg;
  if (knownBelowMin) {
    updateMsg =
      `Обнаружен старый Adafruit/nice!nano бутлоадер ${version} (нужен ≥ ${MIN_ADAFRUIT_BOOTLOADER}).\n\n` +
      `Крупные прошивки MeshCore/Darktec могут не записаться. Рекомендуется OTAFIX ${RECOMMENDED_ADAFRUIT_BOOTLOADER} для ProMicro.\n\n` +
      `Обновить бутлоадер сначала? (откроется UF2 / инструкция MeshCore)`;
  } else if (knownBelowRecommended) {
    updateMsg =
      `Бутлоадер ${version} ≥ ${MIN_ADAFRUIT_BOOTLOADER}, но ниже рекомендуемого OTAFIX ${RECOMMENDED_ADAFRUIT_BOOTLOADER}.\n\n` +
      `MeshCore рекомендует обновить бутлоадер перед прошивкой крупных сборок Darktec/ProMicro.\n\n` +
      `Обновить бутлоадер сначала? (откроется UF2 / инструкция MeshCore)`;
  } else {
    updateMsg =
      `Не удалось прочитать версию бутлоадера` +
      (canPickUf2Directory()
        ? " (диск DFU не выбран или INFO_UF2.TXT недоступен)"
        : " (Web Serial не отдаёт версию; File System Access недоступен)") +
      `.\n\n` +
      `У Darktec/ProMicro/nice!nano часто стоит Adafruit UF2 < ${MIN_ADAFRUIT_BOOTLOADER} — тогда прошивка может сломаться. MeshCore рекомендует OTAFIX ${RECOMMENDED_ADAFRUIT_BOOTLOADER}.\n\n` +
      `Обновить бутлоадер сначала? (откроется UF2 / инструкция MeshCore)`;
  }

  opts.onStatus?.("Проверка бутлоадера…");
  const wantsUpdate = confirmFn(updateMsg);
  if (wantsUpdate) {
    // One window from the confirm gesture (second open is often popup-blocked).
    openUrl(BOOTLOADER_UPDATE_UF2_URL);
    throw new Error(
      `Прошивка отменена: обновите бутлоадер (≥ ${MIN_ADAFRUIT_BOOTLOADER} / OTAFIX ${RECOMMENDED_ADAFRUIT_BOOTLOADER}), затем повторите. Инструкция: ${BOOTLOADER_UPDATE_DOCS_URL}`,
    );
  }

  const forceMsg = "Продолжить прошивку на старом бутлоадере?";
  const force = confirmFn(forceMsg);
  if (!force) {
    throw new Error("Прошивка отменена пользователем.");
  }

  opts.onStatus?.("Продолжаем на текущем бутлоадере…");
  return "forced";
}

/**
 * Watch for a DFU serial port after 1200-baud reboot.
 * Listens for `connect` and polls `getPorts()` for a newly appeared port
 * that is not the application port. Prefers Adafruit/Nordic DFU VIDs.
 *
 * Call {@link start} before `forceDfuMode` so a fast re-enumerate is not missed;
 * call {@link wait} after reboot (timeout starts then).
 *
 * @param {SerialPort} appPort
 */
function createDfuPortWatcher(appPort) {
  /** @type {Set<SerialPort>} */
  const beforePorts = new Set();
  /** @type {SerialPort | null} */
  let found = null;
  /** @type {Array<() => void>} */
  const waiters = [];
  let listening = false;

  const maybeFound = (port) => {
    if (!port || port === appPort || found) return;
    found = port;
    const pending = waiters.splice(0, waiters.length);
    for (const resolve of pending) resolve(port);
  };

  const consider = (port) => {
    if (!port || port === appPort || found) return;
    // Prefer known DFU VIDs; still accept a sole new non-app port (any VID).
    if (isPreferredDfuUsb(port)) {
      maybeFound(port);
      return;
    }
    // Defer non-preferred until wait() can compare against the full port list.
  };

  const onConnect = (ev) => {
    const port = ev && typeof ev === "object" && "port" in ev ? ev.port : null;
    if (port) consider(port);
  };

  const scanGrantedPorts = async () => {
    if (found) return;
    let ports;
    try {
      ports = await navigator.serial.getPorts();
    } catch {
      return;
    }

    // New SerialPort objects (reconnect / DFU re-enumerate) are not in beforePorts.
    const newcomers = ports.filter((p) => p !== appPort && !beforePorts.has(p));
    const preferredNew = newcomers.filter(isPreferredDfuUsb);
    if (preferredNew.length >= 1) {
      maybeFound(preferredNew[0]);
      return;
    }
    if (newcomers.length === 1) {
      maybeFound(newcomers[0]);
      return;
    }

    // App COM gone + exactly one preferred DFU among remaining granted ports
    // (covers cases where the DFU port was already authorized earlier).
    const appStillListed = ports.includes(appPort);
    if (!appStillListed) {
      const preferred = ports.filter((p) => p !== appPort && isPreferredDfuUsb(p));
      if (preferred.length === 1) maybeFound(preferred[0]);
    }
  };

  return {
    async start() {
      if (listening) return;
      listening = true;
      try {
        const ports = await navigator.serial.getPorts();
        for (const p of ports) beforePorts.add(p);
      } catch {
        /* ignore */
      }
      // App port may not yet be in getPorts() until after grant settles.
      beforePorts.add(appPort);

      navigator.serial.addEventListener("connect", onConnect);
    },

    stop() {
      if (!listening) return;
      listening = false;
      navigator.serial.removeEventListener("connect", onConnect);
    },

    /**
     * @param {number} timeoutMs
     * @returns {Promise<SerialPort | null>}
     */
    wait(timeoutMs) {
      if (found) return Promise.resolve(found);

      return new Promise((resolve) => {
        let settled = false;
        /** @type {ReturnType<typeof setInterval> | null} */
        let pollTimer = null;
        /** @type {ReturnType<typeof setTimeout> | null} */
        let timeoutTimer = null;

        const finish = (port) => {
          if (settled) return;
          settled = true;
          if (pollTimer) clearInterval(pollTimer);
          if (timeoutTimer) clearTimeout(timeoutTimer);
          const idx = waiters.indexOf(onFound);
          if (idx >= 0) waiters.splice(idx, 1);
          resolve(port);
        };

        const onFound = () => finish(found);

        waiters.push(onFound);
        pollTimer = setInterval(() => {
          void scanGrantedPorts();
        }, DFU_POLL_MS);
        void scanGrantedPorts();

        timeoutTimer = setTimeout(() => finish(null), timeoutMs);
      });
    },
  };
}

/**
 * Force Adafruit/nRF bootloader into serial DFU via 1200 baud touch.
 */
export async function enterDfuMode(onStatus) {
  if (!canSerialFlash()) {
    throw new Error("Нужен Chrome или Edge с Web Serial API.");
  }
  onStatus?.("Выберите COM-порт платы (обычный режим)…");
  let port;
  try {
    port = await navigator.serial.requestPort({ filters: APP_PORT_FILTERS });
  } catch (err) {
    throw Object.assign(new Error(formatSerialFlashError(err)), { cause: err });
  }
  onStatus?.("Перевожу в DFU (1200 baud)…");
  try {
    await Dfu.forceDfuMode(port);
  } catch (err) {
    throw Object.assign(new Error(formatSerialFlashError(err)), { cause: err });
  }
  onStatus?.("DFU активен. Дальше нажмите «Прошить» (порт DFU обычно подхватится сам).");
}

/**
 * Request Serial ports for DFU while still in the click gesture stack.
 * Must run before any network await from the button handler.
 *
 * With `forceDfu: true` (default): one app-port picker → 1200 reboot → auto DFU
 * port when possible; fallback `requestPort` only if автоопределение не сработало.
 * With `forceDfu: false`: single DFU-oriented picker (already in bootloader).
 *
 * @param {{ forceDfu?: boolean, onStatus?: Function }} opts
 * @returns {Promise<SerialPort>}
 */
export async function openDfuSerialPort(opts = {}) {
  const { forceDfu = true, onStatus } = opts;
  if (!canSerialFlash()) {
    throw new Error("Нужен Chrome или Edge с Web Serial API.");
  }

  try {
    if (!forceDfu) {
      onStatus?.("Выберите порт DFU (плата уже в DFU)…");
      return await navigator.serial.requestPort({ filters: DFU_PORT_FILTERS });
    }

    onStatus?.("Выберите COM-порт платы (обычный режим)…");
    const appPort = await navigator.serial.requestPort({ filters: APP_PORT_FILTERS });

    const watcher = createDfuPortWatcher(appPort);
    await watcher.start();

    try {
      onStatus?.("Перевод в DFU (1200 baud)…");
      await Dfu.forceDfuMode(appPort);

      onStatus?.("Ищу DFU-порт после перезагрузки…");
      const autoPort = await watcher.wait(DFU_AUTO_DETECT_MS);
      if (autoPort) {
        onStatus?.("DFU-порт найден автоматически.");
        return autoPort;
      }

      onStatus?.("Выберите порт DFU (плата после перезагрузки)…");
      return await navigator.serial.requestPort({ filters: DFU_PORT_FILTERS });
    } finally {
      watcher.stop();
    }
  } catch (err) {
    throw Object.assign(new Error(formatSerialFlashError(err)), { cause: err });
  }
}

/**
 * Flash OTA zip over Web Serial DFU.
 * Prefer calling {@link openDfuSerialPort} first from the click handler (before zip fetch),
 * then pass the port as `opts.port` so requestPort stays inside the user gesture.
 * Call {@link ensureAdafruitBootloaderOk} after the DFU port is open (and ideally before
 * zip fetch) so the user can abort without downloading.
 *
 * @param {Blob} zipBlob
 * @param {{
 *   forceDfu?: boolean,
 *   port?: SerialPort | null,
 *   onStatus?: Function,
 *   onProgress?: Function,
 *   skipBootloaderCheck?: boolean,
 * }} opts
 */
export async function flashNrfSerial(zipBlob, opts = {}) {
  const {
    forceDfu = true,
    port: existingPort = null,
    onStatus,
    onProgress,
    skipBootloaderCheck = false,
  } = opts;
  if (!canSerialFlash()) {
    throw new Error("Нужен Chrome или Edge с Web Serial API.");
  }

  try {
    const dfuPort =
      existingPort || (await openDfuSerialPort({ forceDfu, onStatus }));
    if (!skipBootloaderCheck) {
      await ensureAdafruitBootloaderOk(dfuPort, { onStatus });
    }
    const dfu = new Dfu(dfuPort);

    onStatus?.("Прошивка по Serial DFU…");
    await dfu.dfuUpdate(zipBlob, (pct) => {
      onProgress?.(pct);
      onStatus?.(`Прошивка… ${pct}%`);
    });
    onStatus?.("Готово. Плата перезагрузится.");
  } catch (err) {
    throw Object.assign(new Error(formatSerialFlashError(err)), { cause: err });
  }
}
