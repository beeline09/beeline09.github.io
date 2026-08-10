/**
 * nRF52 serial DFU flasher (same approach as flasher.meshcore.io).
 * Requires OTA .zip (PlatformIO firmware.zip), Web Serial, Chrome/Edge.
 */
import { Dfu } from "./lib/dfu.js";

export function canSerialFlash() {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

/**
 * Force Adafruit/nRF bootloader into serial DFU via 1200 baud touch.
 */
export async function enterDfuMode(onStatus) {
  if (!canSerialFlash()) {
    throw new Error("Нужен Chrome или Edge с Web Serial API.");
  }
  onStatus?.("Выберите COM-порт платы (обычный режим)…");
  const port = await navigator.serial.requestPort({});
  onStatus?.("Перевожу в DFU (1200 baud)…");
  await Dfu.forceDfuMode(port);
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
}
