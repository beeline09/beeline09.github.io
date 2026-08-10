/**
 * Darktec UF2 download portal.
 * Prefer live GitHub Releases API; fall back to ./releases.json.
 */

const FIRMWARE_REPO = "beeline09/MeshCore";
const RELEASES_API = `https://api.github.com/repos/${FIRMWARE_REPO}/releases?per_page=20`;

const ROLES = [
  {
    id: "companion",
    title: "Companion",
    blurb: "BLE companion radio",
  },
  {
    id: "repeater",
    title: "Repeater",
    blurb: "Сетевой ретранслятор",
  },
];

const CHEMS = [
  {
    id: "liion",
    title: "Li-ion",
    blurb: "1S только",
    cells: [1],
  },
  {
    id: "lifepo4",
    title: "LiFePO4",
    blurb: "1S только",
    cells: [1],
  },
  {
    id: "lto",
    title: "LTO",
    blurb: "1S или 2S (пакет ≤ 5 В)",
    cells: [1, 2],
  },
];

const DARKTEC_UF2 = /^Darktec_.+\.uf2$/i;

const state = {
  role: "companion",
  chem: "liion",
  cells: 1,
  manifest: null,
};

const els = {
  roleChoices: document.getElementById("roleChoices"),
  chemChoices: document.getElementById("chemChoices"),
  cellsChoices: document.getElementById("cellsChoices"),
  cellsStep: document.getElementById("cellsStep"),
  chemHint: document.getElementById("chemHint"),
  downloadStepLabel: document.getElementById("downloadStepLabel"),
  status: document.getElementById("status"),
  downloadBtn: document.getElementById("downloadBtn"),
  fileName: document.getElementById("fileName"),
  releaseLabel: document.getElementById("releaseLabel"),
};

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

function expectedFileName() {
  const chem = state.chem;
  const cells = state.cells;
  if (state.role === "companion") {
    return `Darktec_companion_radio_ble_${chem}_${cells}s.uf2`;
  }
  return `Darktec_repeater_${chem}_${cells}s.uf2`;
}

function findAsset() {
  const name = expectedFileName().toLowerCase();
  const files = state.manifest?.files ?? [];
  return files.find((f) => f.name.toLowerCase() === name) ?? null;
}

function syncCellsForChem() {
  const chem = CHEMS.find((c) => c.id === state.chem);
  if (!chem.cells.includes(state.cells)) {
    state.cells = chem.cells[0];
  }
  const multi = chem.cells.length > 1;
  els.cellsStep.hidden = !multi;
  els.downloadStepLabel.textContent = multi ? "4 · Скачать" : "3 · Скачать";
  els.chemHint.textContent = chem.blurb;
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
        updateDownload();
        renderAll();
      },
    );
  }
}

function updateDownload() {
  const asset = findAsset();
  const name = expectedFileName();
  els.fileName.textContent = name;

  if (!state.manifest) {
    els.status.textContent = "Не удалось загрузить список прошивок.";
    els.status.className = "status error";
    setDownloadEnabled(false);
    return;
  }

  if (!asset) {
    const tag = state.manifest.release?.tag;
    els.status.className = "status";
    els.status.textContent = tag
      ? `В релизе ${tag} нет файла ${name}. Дождитесь окончания CI или проверьте ассеты.`
      : `Пока нет релиза Darktec. После пуша в south_edition появится тег darktec-latest.`;
    setDownloadEnabled(false);
    return;
  }

  els.status.className = "status";
  els.status.textContent = asset.size
    ? `Готово · ${(asset.size / 1024).toFixed(0)} KiB`
    : "Готово к скачиванию";
  els.downloadBtn.href = asset.url;
  els.downloadBtn.setAttribute("download", asset.name);
  setDownloadEnabled(true);
}

function setDownloadEnabled(enabled) {
  if (enabled) {
    els.downloadBtn.removeAttribute("aria-disabled");
  } else {
    els.downloadBtn.setAttribute("aria-disabled", "true");
    els.downloadBtn.href = "#";
    els.downloadBtn.removeAttribute("download");
  }
}

els.downloadBtn.addEventListener("click", (ev) => {
  if (els.downloadBtn.getAttribute("aria-disabled") === "true") {
    ev.preventDefault();
  }
});

function renderAll() {
  renderChoices(els.roleChoices, ROLES, state.role, (id) => {
    state.role = id;
    updateDownload();
    renderAll();
  });
  renderChoices(els.chemChoices, CHEMS, state.chem, (id) => {
    state.chem = id;
    syncCellsForChem();
    updateDownload();
    renderAll();
  });
  syncCellsForChem();
  updateDownload();
}

function applyReleaseLabel() {
  const rel = state.manifest?.release;
  if (!rel) {
    els.releaseLabel.textContent = "нет данных";
    return;
  }
  const source = state.manifest.source === "api" ? "live" : "cache";
  els.releaseLabel.textContent = rel.tag ? `${rel.tag} · ${source}` : "нет релиза";
  if (rel.url) {
    els.releaseLabel.title = rel.url;
  }
}

function manifestFromGithubRelease(release) {
  const files = (release.assets || [])
    .filter((a) => DARKTEC_UF2.test(a.name))
    .map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      contentType: asset.content_type || "application/octet-stream",
    }));

  return {
    generatedAt: new Date().toISOString(),
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

async function loadFromGithubApi() {
  const res = await fetch(RELEASES_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  const releases = await res.json();

  const preferred =
    releases.find(
      (r) => !r.draft && r.tag_name === "darktec-latest" && (r.assets || []).some((a) => DARKTEC_UF2.test(a.name)),
    ) ||
    releases.find(
      (r) => !r.draft && (r.assets || []).some((a) => DARKTEC_UF2.test(a.name)),
    );

  if (!preferred) {
    return {
      generatedAt: new Date().toISOString(),
      source: "api",
      sourceRepo: FIRMWARE_REPO,
      release: {
        tag: null,
        name: null,
        url: `https://github.com/${FIRMWARE_REPO}/releases`,
        publishedAt: null,
        notes: "Релизов Darktec пока нет.",
      },
      files: [],
    };
  }

  return manifestFromGithubRelease(preferred);
}

async function loadFromStaticJson() {
  const res = await fetch(new URL("./releases.json", import.meta.url), {
    cache: "no-cache",
  });
  if (!res.ok) throw new Error(`releases.json HTTP ${res.status}`);
  const data = await res.json();
  data.source = data.source || "cache";
  return data;
}

async function boot() {
  try {
    state.manifest = await loadFromGithubApi();
  } catch (apiErr) {
    console.warn("GitHub API failed, falling back to releases.json", apiErr);
    try {
      state.manifest = await loadFromStaticJson();
    } catch (err) {
      console.error(err);
      state.manifest = null;
      els.releaseLabel.textContent = "ошибка";
      els.status.className = "status error";
      els.status.textContent = `Не удалось загрузить манифест: ${err.message}`;
      renderAll();
      return;
    }
  }

  applyReleaseLabel();
  renderAll();
}

boot();
