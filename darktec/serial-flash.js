/**
 * nRF52 serial DFU flasher (same approach as flasher.meshcore.io).
 * Requires OTA .zip (PlatformIO firmware.zip), Web Serial, Chrome/Edge.
 */
import { Dfu } from "./lib/dfu.js";

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
 * Force Adafruit/nRF bootloader into serial DFU via 1200 baud touch.
 */
export async function enterDfuMode(onStatus) {
  if (!canSerialFlash()) {
    throw new Error("Нужен Chrome или Edge с Web Serial API.");
  }
  onStatus?.("Выберите COM-порт платы (обычный режим)…");
  let port;
  try {
    port = await navigator.serial.requestPort({});
  } catch (err) {
    throw Object.assign(new Error(formatSerialFlashError(err)), { cause: err });
  }
  onStatus?.("Перевожу в DFU (1200 baud)…");
  try {
    await Dfu.forceDfuMode(port);
  } catch (err) {
    throw Object.assign(new Error(formatSerialFlashError(err)), { cause: err });
  }
  onStatus?.("DFU активен. Дальше нажмите «Прошить» и выберите DFU-порт.");
}

/**
 * Flash OTA zip over Web Serial DFU.
 * @param {Blob} zipBlob
 * @param {{ forceDfu?: boolean, onStatus?: Function, onProgress?: Function }} opts
 */
export async function flashNrfSerial(zipBlob, opts = {}) {
  const { forceDfu = true, onStatus, onProgress } = opts;
  if (!canSerialFlash()) {
    throw new Error("Нужен Chrome или Edge с Web Serial API.");
  }

  try {
    if (forceDfu) {
      onStatus?.("Шаг 1/2: выберите COM-порт платы (ещё не DFU)…");
      const appPort = await navigator.serial.requestPort({});
      onStatus?.("Перевод в DFU…");
      await Dfu.forceDfuMode(appPort);
      // Give the OS a moment to re-enumerate the DFU CDC interface.
      await new Promise((r) => setTimeout(r, 800));
    }

    onStatus?.("Шаг 2/2: выберите DFU-порт (часто «nRF52 DFU» / Adafruit)…");
    const dfuPort = await navigator.serial.requestPort({});
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
