#!/usr/bin/env node
/**
 * Build darktec/releases.json from GitHub Releases of beeline09/MeshCore.
 *
 * Usage:
 *   node scripts/generate-releases.mjs
 *   FIRMWARE_REPO=beeline09/MeshCore node scripts/generate-releases.mjs
 *
 * Optional: GITHUB_TOKEN for higher rate limits / private repos.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const outPath = join(root, "darktec", "releases.json");
const shaOutPath = join(root, "darktec", "south_edition_sha.txt");

const repo = process.env.FIRMWARE_REPO || "beeline09/MeshCore";
const apiBase = process.env.GITHUB_API_URL || "https://api.github.com";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

const DARKTEC_ASSET = /^Darktec_.+\.(uf2|zip)$/i;
const isDarktecAsset = (name) =>
  DARKTEC_ASSET.test(name) && !/^Darktec_uf2_/i.test(name);

const EXPECTED_ROLES = [
  "companion_radio_ble",
  "companion_radio_usb",
  "repeater",
  "repeater_bridge_rs232",
  "room_server",
  "terminal_chat",
  "sensor",
  "kiss_modem",
];
const EXPECTED_CHEM_CELLS = [
  { chem: "liion", cells: 1 },
  { chem: "lifepo4", cells: 1 },
  { chem: "lto", cells: 1 },
  { chem: "lto", cells: 2 },
];
const EXPECTED_PROTECTS = ["adc", "off"];

function expectedBasenames() {
  const names = [];
  for (const role of EXPECTED_ROLES) {
    for (const { chem, cells } of EXPECTED_CHEM_CELLS) {
      for (const protect of EXPECTED_PROTECTS) {
        names.push(`Darktec_${role}_${chem}_${cells}s_${protect}`);
      }
    }
  }
  return names;
}

function isReleaseComplete(release) {
  const names = new Set(
    (release.assets || []).map((a) => a.name).filter((n) => isDarktecAsset(n)),
  );
  for (const base of expectedBasenames()) {
    if (!names.has(`${base}.uf2`) || !names.has(`${base}.zip`)) return false;
  }
  return true;
}

async function fetchJson(url) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "beeline09-github-io-releases-sync",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${url} → ${res.status}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

function pickRelease(releases) {
  // Prefer a fully published matrix (128 Darktec_* uf2+zip); skip partial uploads.
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    if (!isReleaseComplete(release)) continue;
    const files = (release.assets || []).filter((a) => isDarktecAsset(a.name));
    return { release, files };
  }
  for (const release of releases) {
    if (release.draft) continue;
    const files = (release.assets || []).filter((a) => isDarktecAsset(a.name));
    if (files.length > 0) {
      return { release, files };
    }
  }
  return { release: releases.find((r) => !r.draft) || null, files: [] };
}

function buildManifest(release, files) {
  if (!release) {
    return {
      generatedAt: new Date().toISOString(),
      sourceRepo: repo,
      release: {
        tag: null,
        name: null,
        url: `https://github.com/${repo}/releases`,
        publishedAt: null,
        notes:
          "Релизов не найдено. Создайте GitHub Release с ассетами Darktec_*.uf2.",
      },
      files: [],
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    sourceRepo: repo,
    release: {
      tag: release.tag_name,
      name: release.name || release.tag_name,
      url: release.html_url,
      publishedAt: release.published_at,
      notes: release.body || "",
    },
    files: files.map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      contentType: asset.content_type || "application/octet-stream",
    })),
  };
}

async function main() {
  const url = `${apiBase}/repos/${repo}/releases?per_page=30`;
  console.log(`Fetching ${url}`);
  const releases = await fetchJson(url);
  const { release, files } = pickRelease(releases);
  const manifest = buildManifest(release, files);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(
    `Wrote ${outPath} · tag=${manifest.release.tag ?? "none"} · files=${manifest.files.length}`,
  );

  try {
    const commit = await fetchJson(`${apiBase}/repos/${repo}/commits/south_edition`);
    const sha = String(commit.sha || "").slice(0, 8).toLowerCase();
    if (sha) {
      writeFileSync(shaOutPath, `${sha}\n`, "utf8");
      console.log(`Wrote ${shaOutPath} → ${sha}`);
    }
  } catch (err) {
    console.warn("south_edition sha skip:", err.message || err);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
