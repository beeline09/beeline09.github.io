/**
 * On-demand Darktec builds: cache in Release `darktec-ondemand`,
 * miss → open prefilled GitHub issue (label darktec-ondemand) → poll assets.
 */

const FIRMWARE_REPO = "beeline09/MeshCore";
const ONDEMAND_TAG = "darktec-ondemand";
const ONDEMAND_LABEL = "darktec-ondemand";
const RELEASE_API = `https://api.github.com/repos/${FIRMWARE_REPO}/releases/tags/${ONDEMAND_TAG}`;
const COMMITS_API = `https://api.github.com/repos/${FIRMWARE_REPO}/commits/south_edition`;

/** Krasnodar / Adygea preset (matches variants/darktec/radio_defaults.h). */
export const RADIO_DEFAULTS = Object.freeze({
  freq: 869.075,
  bw: 62.5,
  sf: 8,
  cr: 8,
  tx: 22,
});

export function slugifyName(name) {
  const s = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return s || "default";
}

export function normalizeRadio(radio = {}) {
  const n = (v, digits) => {
    const x = Number(String(v ?? "").replace(",", "."));
    if (!Number.isFinite(x)) return NaN;
    return digits == null ? Math.trunc(x) : Number(x.toFixed(digits));
  };
  return {
    freq: n(radio.freq, 3),
    bw: n(radio.bw, 3),
    sf: n(radio.sf),
    cr: n(radio.cr),
    tx: n(radio.tx),
  };
}

export function isDefaultRadio(radio) {
  const n = normalizeRadio(radio);
  const d = RADIO_DEFAULTS;
  return (
    n.freq === d.freq &&
    n.bw === d.bw &&
    n.sf === d.sf &&
    n.cr === d.cr &&
    n.tx === d.tx
  );
}

export function radioSlug(radio) {
  const n = normalizeRadio(radio);
  const tok = (v) => String(v).replace(/\./g, "p");
  return `f${tok(n.freq)}-bw${tok(n.bw)}-sf${n.sf}-cr${n.cr}-tx${n.tx}`;
}

export function validateRadio(radio) {
  const n = normalizeRadio(radio);
  const checks = [
    ["freq", n.freq, 150, 960],
    ["bw", n.bw, 7, 500],
    ["sf", n.sf, 5, 12],
    ["cr", n.cr, 5, 8],
    ["tx", n.tx, 1, 22],
  ];
  for (const [key, val, lo, hi] of checks) {
    if (!Number.isFinite(val) || val < lo || val > hi) {
      return `Некорректное ${key}: нужно от ${lo} до ${hi}`;
    }
  }
  return null;
}

export async function fetchSouthEditionSha() {
  const res = await fetch(COMMITS_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`commits API ${res.status}`);
  const data = await res.json();
  return String(data.sha || "").slice(0, 8);
}

export function ondemandBaseName({ role, chem, cells, protect, nameSlug, radio, sha }) {
  return `Darktec_${role}_${chem}_${cells}s_${protect}__${nameSlug}__${radioSlug(radio)}__${sha}`;
}

export async function findOndemandAssets(baseName) {
  const res = await fetch(RELEASE_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (res.status === 404) {
    return { uf2: null, zip: null, releaseMissing: true };
  }
  if (!res.ok) throw new Error(`ondemand release API ${res.status}`);
  const release = await res.json();
  const assets = release.assets || [];
  const uf2 = assets.find((a) => a.name === `${baseName}.uf2`) || null;
  const zip = assets.find((a) => a.name === `${baseName}.zip`) || null;
  return {
    uf2: uf2
      ? { name: uf2.name, url: uf2.browser_download_url, size: uf2.size }
      : null,
    zip: zip
      ? { name: zip.name, url: zip.browser_download_url, size: zip.size }
      : null,
    releaseMissing: false,
  };
}

export function buildIssueUrl({
  role,
  chem,
  cells,
  protect,
  advertName,
  nameSlug,
  radio,
  sha,
}) {
  const r = normalizeRadio(radio);
  const title = `darktec-ondemand: ${role} ${chem} ${cells}s ${protect} ${nameSlug}`;
  const body = [
    "Запрос кастомной сборки Darktec из `/darktec_new/`.",
    "",
    "<!-- darktec-ondemand",
    `role_slug=${role}`,
    `chem_slug=${chem}`,
    `cells=${cells}`,
    `protect_slug=${protect}`,
    `advert_name=${advertName}`,
    `name_slug=${nameSlug}`,
    `lora_freq=${r.freq}`,
    `lora_bw=${r.bw}`,
    `lora_sf=${r.sf}`,
    `lora_cr=${r.cr}`,
    `lora_tx=${r.tx}`,
    `sha=${sha}`,
    "-->",
    "",
    "Не редактируйте блок `<!-- darktec-ondemand ... -->`.",
    "После создания issue сборка запустится сама (~2–5 мин), ссылки появятся в комментарии.",
  ].join("\n");

  const params = new URLSearchParams({
    title,
    body,
    labels: ONDEMAND_LABEL,
  });
  return `https://github.com/${FIRMWARE_REPO}/issues/new?${params.toString()}`;
}

/**
 * Poll until uf2 appears or timeout.
 * @returns {Promise<{uf2: object, zip: object|null}>}
 */
export async function pollOndemandAssets(baseName, {
  intervalMs = 10000,
  timeoutMs = 12 * 60 * 1000,
  onTick,
  signal,
} = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) throw new Error("aborted");
    const found = await findOndemandAssets(baseName);
    if (onTick) onTick(found);
    if (found.uf2) return found;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("timeout");
}
