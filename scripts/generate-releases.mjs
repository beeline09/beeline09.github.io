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
const southShaOutPath = join(root, "darktec", "south_edition_sha.txt");
const officialShaOutPath = join(root, "darktec", "dev_darktec_sha.txt");

const repo = process.env.FIRMWARE_REPO || "beeline09/MeshCore";
const apiBase = process.env.GITHUB_API_URL || "https://api.github.com";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

const isSouthAsset = (name) =>
  /^Darktec_.+\.(uf2|zip)$/i.test(name) &&
  !/^DarktecOff_/i.test(name) &&
  !/^Darktec_uf2_/i.test(name);

const isOfficialAsset = (name) => /^DarktecOff_.+\.(uf2|zip)$/i.test(name);

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

function expectedSouthBasenames() {
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

function expectedOfficialBasenames() {
  const names = [];
  for (const role of EXPECTED_ROLES) {
    for (const { chem, cells } of EXPECTED_CHEM_CELLS) {
      names.push(`DarktecOff_${role}_${chem}_${cells}s`);
    }
  }
  return names;
}

function isSouthComplete(release) {
  const names = new Set(
    (release.assets || []).map((a) => a.name).filter((n) => isSouthAsset(n)),
  );
  for (const base of expectedSouthBasenames()) {
    if (!names.has(`${base}.uf2`) || !names.has(`${base}.zip`)) return false;
  }
  return true;
}

function isOfficialComplete(release) {
  const names = new Set(
    (release.assets || []).map((a) => a.name).filter((n) => isOfficialAsset(n)),
  );
  for (const base of expectedOfficialBasenames()) {
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

function pickSouthReleases(releases) {
  const complete = releases.filter(
    (release) =>
      !release.draft &&
      !release.prerelease &&
      /^darktec-v\d+\.\d+\.\d+b\d+$/.test(release.tag_name || "") &&
      isSouthComplete(release),
  );
  if (complete.length) {
    return complete.map((release) => ({
      release,
      files: (release.assets || []).filter((a) => isSouthAsset(a.name)),
    }));
  }

  const latest = releases.find(
    (release) => !release.draft && !release.prerelease && release.tag_name === "darktec-latest",
  );
  if (latest && isSouthComplete(latest)) {
    return [
      {
        release: latest,
        files: (latest.assets || []).filter((a) => isSouthAsset(a.name)),
      },
    ];
  }

  for (const release of releases) {
    if (release.draft) continue;
    const files = (release.assets || []).filter((a) => isSouthAsset(a.name));
    if (files.length > 0) {
      return [{ release, files }];
    }
  }
  return [];
}

function pickOfficialReleases(releases) {
  const latest = releases.find(
    (release) => !release.draft && release.tag_name === "darktec-official-latest",
  );
  if (latest && isOfficialComplete(latest)) {
    return [
      {
        release: latest,
        files: (latest.assets || []).filter((a) => isOfficialAsset(a.name)),
      },
    ];
  }
  return [];
}

function mirrorFileUrl(tag, name, track) {
  if (track === "official") {
    if (!tag || tag === "darktec-official-latest") {
      return `./firmware/official/latest/${name}`;
    }
    return `./firmware/official/releases/${tag}/${name}`;
  }
  if (!tag || tag === "darktec-latest") {
    return `./firmware/latest/${name}`;
  }
  return `./firmware/releases/${tag}/${name}`;
}

function buildReleaseEntry(release, files, track) {
  if (!release) return null;
  const tag = release.tag_name;
  return {
    release: {
      tag,
      name: release.name || tag,
      url: release.html_url,
      publishedAt: release.published_at,
      notes: release.body || "",
    },
    files: files.map((asset) => ({
      name: asset.name,
      url: mirrorFileUrl(tag, asset.name, track),
      size: asset.size,
      contentType: asset.content_type || "application/octet-stream",
    })),
  };
}

async function fetchShortSha(ref) {
  try {
    const commit = await fetchJson(`${apiBase}/repos/${repo}/commits/${ref}`);
    const sha = String(commit.sha || "").slice(0, 8).toLowerCase();
    return sha || null;
  } catch (err) {
    console.warn(`${ref} sha skip:`, err.message || err);
    return null;
  }
}

async function main() {
  const url = `${apiBase}/repos/${repo}/releases?per_page=40`;
  console.log(`Fetching ${url}`);
  const releases = await fetchJson(url);

  const southPicked = pickSouthReleases(releases);
  const officialPicked = pickOfficialReleases(releases);

  const southReleases = southPicked
    .map(({ release: rel, files }) => buildReleaseEntry(rel, files, "south"))
    .filter(Boolean);
  const officialReleases = officialPicked
    .map(({ release: rel, files }) => buildReleaseEntry(rel, files, "official"))
    .filter(Boolean);

  const southSha = await fetchShortSha("south_edition");
  const officialSha = await fetchShortSha("dev-darktec");

  const firstSouth = southReleases[0] || {
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

  const manifest = {
    generatedAt: new Date().toISOString(),
    sourceRepo: repo,
    southSha,
    officialSha,
    release: firstSouth.release,
    files: firstSouth.files,
    releases: southReleases,
    tracks: {
      south: { sha: southSha, releases: southReleases },
      official: { sha: officialSha, releases: officialReleases },
    },
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(
    `Wrote ${outPath} · south=${southReleases.length} official=${officialReleases.length}`,
  );

  if (southSha) {
    writeFileSync(southShaOutPath, `${southSha}\n`, "utf8");
    console.log(`Wrote ${southShaOutPath} → ${southSha}`);
  }
  if (officialSha) {
    writeFileSync(officialShaOutPath, `${officialSha}\n`, "utf8");
    console.log(`Wrote ${officialShaOutPath} → ${officialSha}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
