#!/usr/bin/env python3
"""Build darktec/releases.json from GitHub Releases of beeline09/MeshCore."""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "darktec" / "releases.json"
SHA_OUT = ROOT / "darktec" / "south_edition_sha.txt"
REPO = os.environ.get("FIRMWARE_REPO", "beeline09/MeshCore")
API = os.environ.get("GITHUB_API_URL", "https://api.github.com")
TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
DARKTEC_ASSET = re.compile(r"^Darktec_.+\.(uf2|zip)$", re.I)

EXPECTED_ROLES = [
    "companion_radio_ble",
    "companion_radio_usb",
    "repeater",
    "repeater_bridge_rs232",
    "room_server",
    "terminal_chat",
    "sensor",
    "kiss_modem",
]
EXPECTED_CHEM_CELLS = [
    ("liion", 1),
    ("lifepo4", 1),
    ("lto", 1),
    ("lto", 2),
]
EXPECTED_PROTECTS = ("adc", "off")


def is_darktec_asset(name: str) -> bool:
    return bool(DARKTEC_ASSET.match(name or "")) and not name.startswith("Darktec_uf2_")


def expected_basenames() -> list[str]:
    names: list[str] = []
    for role in EXPECTED_ROLES:
        for chem, cells in EXPECTED_CHEM_CELLS:
            for protect in EXPECTED_PROTECTS:
                names.append(f"Darktec_{role}_{chem}_{cells}s_{protect}")
    return names


def is_release_complete(release: dict) -> bool:
    names = {
        a.get("name", "")
        for a in release.get("assets") or []
        if is_darktec_asset(a.get("name", ""))
    }
    for base in expected_basenames():
        if f"{base}.uf2" not in names or f"{base}.zip" not in names:
            return False
    return True


def fetch_json(url: str):
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "beeline09-github-io-releases-sync",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def pick_release(releases: list):
    # Prefer a fully published matrix (128 Darktec_* uf2+zip); skip partial uploads.
    for release in releases:
        if release.get("draft") or release.get("prerelease"):
            continue
        if not is_release_complete(release):
            continue
        files = [a for a in release.get("assets") or [] if is_darktec_asset(a.get("name", ""))]
        return release, files
    for release in releases:
        if release.get("draft"):
            continue
        files = [a for a in release.get("assets") or [] if is_darktec_asset(a.get("name", ""))]
        if files:
            return release, files
    for release in releases:
        if not release.get("draft"):
            return release, []
    return None, []


def build_manifest(release, files):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    if not release:
        return {
            "generatedAt": now,
            "sourceRepo": REPO,
            "release": {
                "tag": None,
                "name": None,
                "url": f"https://github.com/{REPO}/releases",
                "publishedAt": None,
                "notes": "Релизов не найдено. Создайте GitHub Release с ассетами Darktec_*.uf2.",
            },
            "files": [],
        }

    return {
        "generatedAt": now,
        "sourceRepo": REPO,
        "release": {
            "tag": release.get("tag_name"),
            "name": release.get("name") or release.get("tag_name"),
            "url": release.get("html_url"),
            "publishedAt": release.get("published_at"),
            "notes": release.get("body") or "",
        },
        "files": [
            {
                "name": asset["name"],
                "url": asset["browser_download_url"],
                "size": asset.get("size"),
                "contentType": asset.get("content_type") or "application/octet-stream",
            }
            for asset in files
        ],
    }


def main() -> None:
    url = f"{API}/repos/{REPO}/releases?per_page=30"
    print(f"Fetching {url}")
    releases = fetch_json(url)
    release, files = pick_release(releases)
    manifest = build_manifest(release, files)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"Wrote {OUT} · tag={manifest['release']['tag']!r} · files={len(manifest['files'])}"
    )
    try:
        commit = fetch_json(f"{API}/repos/{REPO}/commits/south_edition")
        sha = str(commit.get("sha") or "")[:8].lower()
        if sha:
            SHA_OUT.write_text(f"{sha}\n", encoding="utf-8")
            print(f"Wrote {SHA_OUT} → {sha}")
    except Exception as err:  # noqa: BLE001
        print(f"south_edition sha skip: {err}", file=sys.stderr)


if __name__ == "__main__":
    main()
