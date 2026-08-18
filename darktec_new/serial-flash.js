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
 * Version checks and OTAFIX writes are only via «Обновить bootloader» (File System Access);
 * normal «Прошить» does Serial DFU with no bootloader dialogs.
 *
 * @see https://github.com/adafruit/Adafruit_nRF52_Bootloader/releases/tag/0.6.1
 * @see https://blog.meshcore.io/2026/04/06/otafix-bootloader
 * @see https://flasher.meshcore.io/firmware/promicro_nrf52840_bootloader-0.9.2-OTAFIX2.1.uf2
 */
export const MIN_ADAFRUIT_BOOTLOADER = "0.6.1";

/** MeshCore-recommended OTAFIX bootloader for ProMicro / nice!nano-class. */
export const RECOMMENDED_ADAFRUIT_BOOTLOADER = "0.9.2";

/** Official MeshCore OTAFIX UF2 (manual download fallback; CORS blocks fetch from this origin). */
export const BOOTLOADER_UPDATE_UF2_URL =
  "https://flasher.meshcore.io/firmware/promicro_nrf52840_bootloader-0.9.2-OTAFIX2.1.uf2";
export const BOOTLOADER_UPDATE_DOCS_URL =
  "https://blog.meshcore.io/2026/04/06/otafix-bootloader";

const OTAFIX_UF2_FILENAME = "promicro_nrf52840_bootloader-0.9.2-OTAFIX2.1.uf2";

/**
 * Same-origin mirror — shared with stable `/darktec/` (не дублируем UF2 в darktec_new).
 * Relative to this page: /darktec_new/ → /darktec/firmware/bootloader/
 */
const BOOTLOADER_UPDATE_UF2_LOCAL =
  `../darktec/firmware/bootloader/${OTAFIX_UF2_FILENAME}`;

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
 * True when the DFU volume vanished mid/after UF2 apply (board reboot).
 * Chromium then throws InvalidStateError / NotFoundError / AbortError with
 * messages like «state had changed since it was read from disk».
 * @param {unknown} err
 */
export function isLikelyDfuDiskGoneError(err) {
  if (err == null) return false;
  const name =
    typeof err === "object" && err && "name" in err ? String(err.name) : "";
  const message =
    typeof err === "object" && err && "message" in err
      ? String(err.message)
      : String(err);
  if (
    name === "InvalidStateError" ||
    name === "NotFoundError" ||
    name === "AbortError"
  ) {
    return true;
  }
  return /state had changed|cached in an interface object|not found|aborted/i.test(
    message,
  );
}

/**
 * Write a UF2 blob onto a picked DFU volume (device usually reboots / unmounts after).
 * Pattern: create writable → write full buffer → close. Do not re-read INFO_UF2
 * after write — the disk is gone. If close/write fails because the volume
 * disappeared after a started write, treat as success (reboot-after-apply).
 *
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {Blob | ArrayBuffer | Uint8Array} blob
 * @param {string} [fileName]
 * @returns {Promise<{ diskGone: boolean }>}
 */
export async function writeUf2ToDirHandle(dirHandle, blob, fileName = OTAFIX_UF2_FILENAME) {
  /** @type {ArrayBuffer} */
  let buffer;
  if (blob instanceof ArrayBuffer) {
    buffer = blob;
  } else if (ArrayBuffer.isView(blob)) {
    buffer = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  } else {
    buffer = await blob.arrayBuffer();
  }

  let writable = null;
  let writeStarted = false;
  let writeCompleted = false;

  try {
    const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
    writable = await fileHandle.createWritable();
    writeStarted = true;
    await writable.write(buffer);
    writeCompleted = true;
    await writable.close();
    writable = null;
    return { diskGone: false };
  } catch (err) {
    if (writable) {
      try {
        await writable.close();
      } catch {
        /* disk often disappears mid-close after UF2 apply — ignore */
      }
      writable = null;
    }
    // Reboot-after-write: handles invalidate once the board applies UF2.
    // Success if write finished, or write had started and the volume vanished.
    if (writeCompleted || (writeStarted && isLikelyDfuDiskGoneError(err))) {
      return { diskGone: true };
    }
    throw err;
  }
}

/**
 * Modal for «Обновить bootloader»: instruct double-RESET → showDirectoryPicker
 * (readwrite) → read INFO_UF2.TXT. No Web Serial / 1200-baud step (that is
 * serial-only DFU without MSC). Cancel rejects.
 *
 * @param {{ onStatus?: Function }} [opts]
 * @returns {Promise<{ dirHandle: FileSystemDirectoryHandle, info: ReturnType<typeof parseInfoUf2Text> }>}
 */
export function promptPickUf2DiskForUpdate(opts = {}) {
  if (!canPickUf2Directory()) {
    return Promise.reject(
      new Error("Нужен Chrome или Edge с File System Access API, чтобы выбрать диск DFU."),
    );
  }

  opts.onStatus?.(
    "Подключите плату по USB → дважды быстро RESET → появится USB-диск DFU → «Выбрать диск»",
  );

  return new Promise((resolve, reject) => {
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
    title.textContent = "Обновление бутлоадера (диск UF2)";

    const body = document.createElement("div");
    body.className = "modal-body";
    body.innerHTML =
      "<p>OTAFIX пишется на <strong>USB-диск DFU</strong>, не через COM-порт. " +
      "Выбор serial-порта диск <strong>не создаёт</strong>.</p>" +
      "<ol class=\"modal-steps\">" +
      "<li>Подключите плату по USB</li>" +
      "<li><strong>Дважды быстро нажмите RESET</strong> — должен появиться USB-диск DFU " +
      "(часто имя вроде <code>NICE_NANO</code> / <code>MADMIXIN</code> / <code>FTHRS…</code> / Darktec)</li>" +
      "<li>Когда диск виден в системе — нажмите «Выбрать диск UF2» и укажите этот том " +
      "(на нём есть <code>INFO_UF2.TXT</code>)</li>" +
      "</ol>";

    const errEl = document.createElement("p");
    errEl.className = "modal-error";
    errEl.hidden = true;

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.className = "btn btn-primary";
    pickBtn.textContent = "Выбрать диск UF2";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn btn-ghost";
    cancelBtn.textContent = "Отмена";

    let settled = false;
    const dismiss = () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && backdrop.contains(active)) {
        active.blur();
      }
      backdrop.remove();
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dismiss();
      resolve(value);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      dismiss();
      reject(err);
    };

    const setBusy = (busy) => {
      pickBtn.disabled = busy;
      cancelBtn.disabled = busy;
    };

    pickBtn.addEventListener("click", async () => {
      errEl.hidden = true;
      setBusy(true);
      try {
        opts.onStatus?.(
          "Выберите том USB-диска DFU (после двойного RESET) — не COM-порт",
        );
        const dirHandle = await window.showDirectoryPicker({
          id: "darktec-uf2-dfu",
          mode: "readwrite",
        });
        const info = await readInfoUf2FromDirHandle(dirHandle);
        opts.onStatus?.(
          `Бутлоадер ${info.version}` +
            (info.model ? ` · ${info.model}` : "") +
            " (INFO_UF2.TXT).",
        );
        finish({ dirHandle, info });
      } catch (err) {
        const name = err && typeof err === "object" && "name" in err ? String(err.name) : "";
        if (name === "AbortError") {
          errEl.textContent =
            "Выбор диска отменён. Дважды нажмите RESET, дождитесь USB-диска DFU и выберите снова — или отмените.";
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

    cancelBtn.addEventListener("click", () =>
      fail(new Error("Обновление бутлоадера отменено.")),
    );

    actions.append(cancelBtn, pickBtn);
    panel.append(title, body, errEl, actions);
    backdrop.append(panel);
    document.body.append(backdrop);
    pickBtn.focus();
  });
}

/**
 * Dedicated bootloader update: double-RESET → pick UF2 MSC disk → read INFO_UF2
 * → if below OTAFIX (or forced), download/write official UF2.
 * No Web Serial / 1200-baud step — that enters serial-only DFU without a disk.
 * («Только DFU» / «Прошить» keep 1200-baud Serial DFU separately, with no bootloader dialogs.)
 *
 * @param {{ onStatus?: Function, confirmFn?: (msg: string) => boolean, openUrl?: (url: string) => void }} [opts]
 * @returns {Promise<"ok" | "updated" | "download">}
 */
export async function runBootloaderUpdate(opts = {}) {
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

  if (!canPickUf2Directory()) {
    openUrl(BOOTLOADER_UPDATE_UF2_URL);
    throw new Error(
      `File System Access недоступен. Скачайте OTAFIX UF2 вручную и скопируйте на диск DFU. Инструкция: ${BOOTLOADER_UPDATE_DOCS_URL}`,
    );
  }

  const picked = await promptPickUf2DiskForUpdate({
    onStatus: opts.onStatus,
  });

  const { dirHandle, info } = picked;
  const version = info.version;
  const belowRec = isBootloaderBelowMinimum(version, RECOMMENDED_ADAFRUIT_BOOTLOADER);

  if (belowRec === false) {
    opts.onStatus?.("Ваш бутлоадер не нуждается в обновлении.");
    const force = confirmFn(
      `Ваш бутлоадер не нуждается в обновлении.\n\n` +
        `Текущая версия: ${version} (≥ ${RECOMMENDED_ADAFRUIT_BOOTLOADER})` +
        (info.model ? ` — ${info.model}` : "") +
        `.\n\nХотите обновить принудительно?`,
    );
    if (!force) {
      opts.onStatus?.(
        `Обновление не требуется — бутлоадер уже ${version} (≥ ${RECOMMENDED_ADAFRUIT_BOOTLOADER}).`,
      );
      return "ok";
    }
  } else {
    const belowMin = isBootloaderBelowMinimum(version, MIN_ADAFRUIT_BOOTLOADER) === true;
    const offer =
      `Текущий бутлоадер: ${version}` +
      (info.model ? ` (${info.model})` : "") +
      `.\n\n` +
      (belowMin
        ? `Ниже минимума ${MIN_ADAFRUIT_BOOTLOADER}. `
        : "") +
      `Рекомендуется OTAFIX ${RECOMMENDED_ADAFRUIT_BOOTLOADER}.\n\n` +
      `Записать официальный OTAFIX UF2 на выбранный диск DFU?`;

    if (!confirmFn(offer)) {
      openUrl(BOOTLOADER_UPDATE_UF2_URL);
      opts.onStatus?.(
        `Скачайте UF2 вручную и скопируйте на диск DFU. Инструкция: ${BOOTLOADER_UPDATE_DOCS_URL}`,
      );
      return "download";
    }
  }

  opts.onStatus?.("Загрузка OTAFIX UF2…");
  let blob;
  try {
    // Same-origin first — flasher.meshcore.io blocks cross-origin fetch (CORS).
    const res = await fetch(BOOTLOADER_UPDATE_UF2_LOCAL, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
    if (!blob || blob.size < 1024) {
      throw new Error(`некорректный размер файла (${blob ? blob.size : 0} байт)`);
    }
  } catch (err) {
    openUrl(BOOTLOADER_UPDATE_UF2_URL);
    throw new Error(
      `Не удалось скачать OTAFIX UF2 (${err && typeof err === "object" && "message" in err ? err.message : err}). Открыта ссылка для ручной загрузки.`,
    );
  }

  opts.onStatus?.("Запись OTAFIX UF2 на диск DFU…");
  try {
    // No INFO_UF2 re-read after write — DFU disk unmounts on successful apply.
    await writeUf2ToDirHandle(dirHandle, blob, OTAFIX_UF2_FILENAME);
  } catch (err) {
    // writeUf2ToDirHandle already maps reboot-after-write to success; anything
    // still thrown here means write never started or failed early.
    openUrl(BOOTLOADER_UPDATE_UF2_URL);
    throw new Error(
      `Не удалось записать UF2 на диск (скопируйте вручную). ${err && typeof err === "object" && "message" in err ? err.message : err}`,
    );
  }

  opts.onStatus?.(
    "Бутлоадер обновлён. Плата перезагрузилась — это нормально.",
  );
  return "updated";
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
 * Modal: pick DFU serial port with a fresh user gesture.
 * After 1200-baud reboot the original click gesture is gone — Chromium rejects
 * a silent `requestPort()` with SecurityError. This dialog’s button supplies
 * a new activation (same pattern as {@link promptPickUf2DiskForUpdate}).
 *
 * @param {{ onStatus?: Function }} [opts]
 * @returns {Promise<SerialPort>}
 */
export function promptPickDfuSerialPort(opts = {}) {
  if (!canSerialFlash()) {
    return Promise.reject(new Error("Нужен Chrome или Edge с Web Serial API."));
  }

  opts.onStatus?.(
    "DFU-порт не найден автоматически. Нажмите «Выбрать порт DFU» в диалоге.",
  );

  return new Promise((resolve, reject) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-labelledby", "dfuPortModalTitle");

    const panel = document.createElement("div");
    panel.className = "modal-panel";

    const title = document.createElement("h3");
    title.id = "dfuPortModalTitle";
    title.className = "modal-title";
    title.textContent = "Выбор порта DFU";

    const body = document.createElement("div");
    body.className = "modal-body";
    body.innerHTML =
      "<p>DFU-порт не найден автоматически после перевода платы в Serial&nbsp;DFU.</p>" +
      "<ol class=\"modal-steps\">" +
      "<li>Убедитесь, что плата подключена по USB и уже в режиме DFU</li>" +
      "<li>Нажмите «Выбрать порт DFU» и укажите COM платы в DFU " +
      "(не обычный application COM)</li>" +
      "</ol>";

    const errEl = document.createElement("p");
    errEl.className = "modal-error";
    errEl.hidden = true;

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.className = "btn btn-primary";
    pickBtn.textContent = "Выбрать порт DFU";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn btn-ghost";
    cancelBtn.textContent = "Отмена";

    let settled = false;
    const dismiss = () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && backdrop.contains(active)) {
        active.blur();
      }
      backdrop.remove();
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dismiss();
      resolve(value);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      dismiss();
      reject(err);
    };

    const setBusy = (busy) => {
      pickBtn.disabled = busy;
      cancelBtn.disabled = busy;
    };

    pickBtn.addEventListener("click", async () => {
      errEl.hidden = true;
      setBusy(true);
      try {
        opts.onStatus?.("Выберите порт DFU (плата после перезагрузки)…");
        const port = await navigator.serial.requestPort({
          filters: DFU_PORT_FILTERS,
        });
        opts.onStatus?.("DFU-порт выбран.");
        finish(port);
      } catch (err) {
        const name =
          err && typeof err === "object" && "name" in err ? String(err.name) : "";
        if (
          name === "AbortError" ||
          name === "NotFoundError" ||
          /no port selected by the user|user cancelled|user canceled/i.test(
            String(err && typeof err === "object" && "message" in err ? err.message : err),
          )
        ) {
          errEl.textContent =
            "Выбор порта отменён. Выберите порт DFU снова — или нажмите «Отмена».";
          errEl.hidden = false;
          setBusy(false);
          return;
        }
        errEl.textContent = formatSerialFlashError(err);
        errEl.hidden = false;
        setBusy(false);
      }
    });

    cancelBtn.addEventListener("click", () =>
      fail(new Error("Прошивка отменена: DFU-порт не выбран.")),
    );

    actions.append(cancelBtn, pickBtn);
    panel.append(title, body, errEl, actions);
    backdrop.append(panel);
    document.body.append(backdrop);
    pickBtn.focus();
  });
}

/**
 * Force Adafruit/nRF into serial DFU via 1200 baud touch (CDC-only mode).
 * Closes and forgets the app port so the DFU CDC can re-enumerate.
 * Does not open the DFU serial port (caller / «Прошить» does that).
 *
 * 1200-baud DFU touch on an already-granted app port (e.g. stolen from Console).
 * @param {SerialPort} port
 * @param {Function} [onStatus]
 */
export async function forceAppPortToDfu(port, onStatus) {
  onStatus?.("Перевожу в Serial DFU (1200 baud)…");
  // Brief settle so an aborted SerialConsole pipe releases locks.
  await new Promise((r) => setTimeout(r, 60));
  try {
    await Dfu.forceDfuMode(port);
  } catch (err) {
    throw Object.assign(new Error(formatSerialFlashError(err)), { cause: err });
  }
  onStatus?.(
    "Serial DFU активен (USB-диск при 1200 baud обычно не появляется). Дальше «Прошить» — порт DFU подхватится сам.",
  );
}

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
  await forceAppPortToDfu(port, onStatus);
}

/**
 * Open a Serial port for DFU flashing.
 *
 * With `forceDfu: true` (default):
 * 1. Immediate `requestPort` for the app COM (must stay first in the click stack)
 * 2. 1200-baud reboot + auto-detect DFU port
 * 3. If miss → modal button → fresh-gesture `requestPort` with DFU filters
 *    (never call `requestPort` in the async continuation after awaits)
 *
 * With `forceDfu: false`: single DFU-oriented picker (already in bootloader;
 * call only from a click handler, before long awaits).
 *
 * Pass `appPort` to reuse an already-granted application COM (e.g. after
 * detaching Serial Console) and skip `requestPort` for the app stage.
 *
 * @param {{ forceDfu?: boolean, onStatus?: Function, appPort?: SerialPort | null }} opts
 * @returns {Promise<SerialPort>}
 */
export async function openDfuSerialPort(opts = {}) {
  const { forceDfu = true, onStatus, appPort: existingAppPort = null } = opts;
  if (!canSerialFlash()) {
    throw new Error("Нужен Chrome или Edge с Web Serial API.");
  }

  try {
    if (!forceDfu) {
      onStatus?.("Выберите порт DFU (плата уже в DFU)…");
      return await navigator.serial.requestPort({ filters: DFU_PORT_FILTERS });
    }

    // Reuse an already-open app COM (e.g. Console) to avoid a second picker and
    // to keep requestPort off the critical path after Console teardown awaits.
    let appPort = existingAppPort;
    if (appPort) {
      onStatus?.("Использую порт Console для перевода в DFU…");
      // Let SerialConsole's aborted pipe release readable/writable locks.
      await new Promise((r) => setTimeout(r, 60));
    } else {
      onStatus?.("Выберите COM-порт платы (обычный режим)…");
      appPort = await navigator.serial.requestPort({ filters: APP_PORT_FILTERS });
    }

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

      // Gesture from «Прошить» is gone after forceDfu + wait — use a modal click.
      return await promptPickDfuSerialPort({ onStatus });
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
 * No bootloader version dialogs — use {@link runBootloaderUpdate} separately.
 *
 * @param {Blob} zipBlob
 * @param {{
 *   forceDfu?: boolean,
 *   port?: SerialPort | null,
 *   onStatus?: Function,
 *   onProgress?: Function,
 * }} opts
 */
export async function flashNrfSerial(zipBlob, opts = {}) {
  const {
    forceDfu = true,
    port: existingPort = null,
    onStatus,
    onProgress,
  } = opts;
  if (!canSerialFlash()) {
    throw new Error("Нужен Chrome или Edge с Web Serial API.");
  }

  try {
    const dfuPort =
      existingPort || (await openDfuSerialPort({ forceDfu, onStatus }));
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
