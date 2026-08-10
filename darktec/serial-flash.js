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
 * @returns {{ usbVendorId?: number, usbProductId?: number }}
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
 * @param {Blob} zipBlob
 * @param {{ forceDfu?: boolean, port?: SerialPort | null, onStatus?: Function, onProgress?: Function }} opts
 */
export async function flashNrfSerial(zipBlob, opts = {}) {
  const { forceDfu = true, port: existingPort = null, onStatus, onProgress } = opts;
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
