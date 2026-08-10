/**
 * Flash UF2 by writing into the DFU mass-storage volume via File System Access API.
 * Chrome/Edge only. Future: Web Serial DFU for ESP32 / nRF OTA zip.
 */
export function canOnlineFlash() {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export async function flashUf2ToDirectory(uf2Blob, fileName, onProgress) {
  if (!canOnlineFlash()) {
    throw new Error("Онлайн-прошивка требует Chrome или Edge (File System Access API).");
  }

  onProgress?.(5, "Выберите диск DFU (BOOT / NRF52BOOT / DARKTEC)…");
  const dir = await window.showDirectoryPicker({ mode: "readwrite" });

  // Sanity: UF2 drives usually expose INFO_UF2.TXT
  let hasInfo = false;
  try {
    await dir.getFileHandle("INFO_UF2.TXT");
    hasInfo = true;
  } catch {
    hasInfo = false;
  }
  if (!hasInfo) {
    const ok = window.confirm(
      "В выбранной папке нет INFO_UF2.TXT.\nЭто точно диск DFU? Продолжить запись?",
    );
    if (!ok) throw new Error("Отменено пользователем.");
  }

  onProgress?.(30, "Запись UF2…");
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(uf2Blob);
  await writable.close();
  onProgress?.(100, "Готово — плата перезагрузится.");
}
