/**
 * On-demand Darktec builds: same-origin mirror under darktec/firmware/ondemand/,
 * miss → open prefilled GitHub issue (label darktec-ondemand) → poll mirror.
 *
 * Never call api.github.com in a loop from the browser (CORS / rate-limit).
 */

const FIRMWARE_REPO = "beeline09/MeshCore";
const ONDEMAND_TAG = "darktec-ondemand";
const ONDEMAND_LABEL = "darktec-ondemand";

/** Same-origin paths shared with /darktec/ (not duplicated into darktec_new/). */
const ONDEMAND_MANIFEST_URL = new URL(
  "../darktec/firmware/ondemand/ondemand-manifest.json",
  import.meta.url,
).href;
const SOUTH_SHA_URL = new URL("../darktec/south_edition_sha.txt", import.meta.url).href;
/** Optional one-shot fallbacks — never used in a poll loop. */
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

/** Latin letters, digits, space, hyphen, underscore, apostrophe, period. */
const ADVERT_NAME_ALLOWED = /^[A-Za-z0-9 _.'-]*$/;

/** Strip non-Latin / disallowed characters from node name. */
export function sanitizeAdvertName(name) {
  return String(name || "")
    .replace(/[^\x20-\x7E]/g, "") // drop non-ASCII (Cyrillic etc.)
    .replace(/[^A-Za-z0-9 _.'-]/g, "")
    .slice(0, 31);
}

/** @returns {string|null} error message or null if ok */
export function validateAdvertName(name) {
  const s = String(name || "").trim();
  if (!s) return "Укажите имя ноды (латиницей)";
  if (!ADVERT_NAME_ALLOWED.test(s)) {
    return "В имени ноды разрешена только латиница (A–Z), цифры, пробел и - _ . '";
  }
  if (!/[A-Za-z]/.test(s)) {
    return "В имени должна быть хотя бы одна латинская буква";
  }
  return null;
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

/** Allowed LORA_BW values for the lab picker (kHz). */
export const RADIO_BW_OPTIONS = Object.freeze([
  7.8, 10.4, 15.5, 20.8, 31.25, 41.7, 62.5, 125, 250, 500, 203.125, 406.25, 812.5, 1625,
]);

export function validateRadio(radio) {
  const n = normalizeRadio(radio);
  if (!Number.isFinite(n.freq) || n.freq < 150 || n.freq > 960) {
    return "Некорректная частота: нужно от 150 до 960 МГц";
  }
  if (!RADIO_BW_OPTIONS.some((bw) => bw === n.bw)) {
    return "Выберите полосу пропускания из списка";
  }
  if (!Number.isFinite(n.sf) || n.sf < 5 || n.sf > 12) {
    return "Некорректный SF: нужно от 5 до 12";
  }
  if (!Number.isFinite(n.cr) || n.cr < 5 || n.cr > 8) {
    return "Некорректный CR: нужно от 5 до 8";
  }
  if (!Number.isFinite(n.tx) || n.tx < 1 || n.tx > 22 || n.tx !== Math.trunc(n.tx)) {
    return "Мощность передатчика: целое число от 1 до 22 dBm";
  }
  return null;
}

function ondemandAssetUrl(fileName) {
  return new URL(`../darktec/firmware/ondemand/${fileName}`, import.meta.url).href;
}

/** @type {{ files: Array<{name:string,size?:number,url?:string}>, southSha?: string|null }|null} */
let manifestCache = null;
let manifestFetchedAt = 0;

async function loadOndemandManifest({ force = false } = {}) {
  const now = Date.now();
  if (!force && manifestCache && now - manifestFetchedAt < 4000) {
    return manifestCache;
  }
  try {
    const res = await fetch(ONDEMAND_MANIFEST_URL, { cache: "no-cache" });
    if (res.ok) {
      const data = await res.json();
      manifestCache = {
        files: Array.isArray(data.files) ? data.files : [],
        southSha: data.southSha || null,
      };
      manifestFetchedAt = now;
      return manifestCache;
    }
  } catch (err) {
    console.warn("ondemand-manifest miss", err);
  }
  manifestCache = { files: [], southSha: null };
  manifestFetchedAt = now;
  return manifestCache;
}

/**
 * Resolve south_edition short SHA from same-origin files first.
 * Optional single GitHub API attempt — never throws.
 * @returns {Promise<string|null>}
 */
export async function fetchSouthEditionSha() {
  try {
    const res = await fetch(SOUTH_SHA_URL, { cache: "no-cache" });
    if (res.ok) {
      const text = (await res.text()).trim().split(/\s+/)[0] || "";
      if (/^[0-9a-f]{7,40}$/i.test(text)) return text.slice(0, 8).toLowerCase();
    }
  } catch (err) {
    console.warn("south_edition_sha.txt", err);
  }

  try {
    const m = await loadOndemandManifest();
    if (m.southSha && /^[0-9a-f]{7,40}$/i.test(String(m.southSha))) {
      return String(m.southSha).slice(0, 8).toLowerCase();
    }
  } catch {
    /* ignore */
  }

  try {
    const res = await fetch(COMMITS_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (res.ok) {
      const data = await res.json();
      const sha = String(data.sha || "").slice(0, 8).toLowerCase();
      if (sha) return sha;
    }
  } catch (err) {
    console.warn("south_edition sha API fallback", err);
  }
  return null;
}

export function ondemandBaseName({ role, chem, cells, protect, nameSlug, radio, sha }) {
  return `Darktec_${role}_${chem}_${cells}s_${protect}__${nameSlug}__${radioSlug(radio)}__${sha}`;
}

/**
 * Probe same-origin ondemand mirror for uf2/zip (manifest + optional HEAD).
 * Never hits GitHub Releases API.
 * @returns {Promise<{uf2: object|null, zip: object|null, releaseMissing: boolean}>}
 */
export async function findOndemandAssets(baseName) {
  try {
    const manifest = await loadOndemandManifest({ force: true });
    const byName = new Map((manifest.files || []).map((f) => [f.name, f]));

    const fromManifest = (ext) => {
      const name = `${baseName}.${ext}`;
      const f = byName.get(name);
      if (!f) return null;
      return {
        name: f.name,
        url: f.url?.startsWith("http") ? f.url : ondemandAssetUrl(f.name),
        size: f.size,
      };
    };

    let uf2 = fromManifest("uf2");
    let zip = fromManifest("zip");

    const probe = async (ext) => {
      const name = `${baseName}.${ext}`;
      const url = ondemandAssetUrl(name);
      try {
        const head = await fetch(url, { method: "HEAD", cache: "no-cache" });
        if (head.ok) {
          const len = head.headers.get("content-length");
          return {
            name,
            url,
            size: len ? Number(len) : undefined,
          };
        }
      } catch {
        /* some hosts reject HEAD — try a tiny ranged GET */
      }
      try {
        const res = await fetch(url, {
          cache: "no-cache",
          headers: { Range: "bytes=0-0" },
        });
        if (res.ok || res.status === 206) {
          return { name, url, size: undefined };
        }
      } catch {
        /* miss */
      }
      return null;
    };

    if (!zip) zip = await probe("zip");
    if (!uf2) uf2 = await probe("uf2");

    // Zip-only mirror is enough for Serial DFU + OTA; UF2 download can wait for mirror.
    return { uf2, zip, releaseMissing: false };
  } catch (err) {
    console.warn("findOndemandAssets", err);
    return { uf2: null, zip: null, releaseMissing: false };
  }
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
 * Poll same-origin ondemand mirror until uf2 (+ zip) appears or timeout.
 * Exponential backoff — never GitHub API.
 * @returns {Promise<{uf2: object, zip: object|null}>}
 */
export async function pollOndemandAssets(
  baseName,
  {
    intervalMs = 8000,
    timeoutMs = 12 * 60 * 1000,
    onTick,
    signal,
  } = {},
) {
  const started = Date.now();
  /** @type {object|null} */
  let seenUf2 = null;
  let delay = Math.max(3000, intervalMs);

  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) throw new Error("aborted");
    let found;
    try {
      found = await findOndemandAssets(baseName);
    } catch (err) {
      console.warn("pollOndemandAssets tick", err);
      found = { uf2: null, zip: null };
    }
    if (onTick) {
      try {
        onTick(found);
      } catch {
        /* ignore UI tick errors */
      }
    }
    if (found.uf2 && found.zip) return found;
    if (found.zip && !found.uf2) {
      // Mirror may publish zip first; accept zip-only after ~90s for Serial/OTA.
      if (Date.now() - started > 90_000) {
        return { uf2: found.uf2, zip: found.zip };
      }
    }
    if (found.uf2) {
      seenUf2 = found;
      if (Date.now() - started > 90_000) return found;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(Math.round(delay * 1.4), 30_000);
  }
  if (seenUf2) return { ...seenUf2, zip: seenUf2.zip || null };
  throw new Error("timeout");
}
