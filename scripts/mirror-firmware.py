#!/usr/bin/env python3
"""Mirror Darktec UF2 release assets into darktec/firmware/latest (CORS-safe)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "darktec" / "firmware" / "latest"
REPO = os.environ.get("FIRMWARE_REPO", "beeline09/MeshCore")
API = os.environ.get("GITHUB_API_URL", "https://api.github.com")
TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""


def api_get(url: str) -> tuple[int, dict | list | None]:
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "beeline09-mirror-firmware",
            "X-GitHub-Api-Version": "2022-11-28",
            **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}),
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as e:
        return e.code, None


def download_asset(api_url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "curl",
        "-fsSL",
        "-L",
        "-H",
        "Accept: application/octet-stream",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
        "-o",
        str(dest),
        api_url,
    ]
    if TOKEN:
        cmd[4:4] = ["-H", f"Authorization: Bearer {TOKEN}"]
    subprocess.check_call(cmd)


def pick_tag() -> str:
    tag = (os.environ.get("CLIENT_TAG") or "").strip()
    if tag:
        return tag
    manifest = ROOT / "darktec" / "releases.json"
    if manifest.exists():
        data = json.loads(manifest.read_text(encoding="utf-8"))
        t = (data.get("release") or {}).get("tag")
        if t:
            return t
    return "darktec-latest"


def mirror(tag: str) -> int:
    for ref in (tag, "darktec-latest"):
        code, rel = api_get(f"{API}/repos/{REPO}/releases/tags/{ref}")
        if code != 200 or not isinstance(rel, dict):
            print(f"Skip {ref} (HTTP {code})")
            continue

        assets = [
            a
            for a in rel.get("assets") or []
            if str(a.get("name", "")).startswith("Darktec_")
            and str(a.get("name", "")).endswith(".uf2")
        ]
        OUT.mkdir(parents=True, exist_ok=True)
        for old in OUT.glob("*.uf2"):
            old.unlink()

        for a in assets:
            name = a["name"]
            print(f"Downloading {name} ({a.get('size')} bytes)")
            download_asset(a["url"], OUT / name)

        (OUT / "SOURCE_TAG.txt").write_text(f"{rel.get('tag_name', ref)}\n", encoding="utf-8")
        print(f"Mirrored {len(assets)} UF2s → {OUT}")
        return len(assets)

    print("No release assets found to mirror", file=sys.stderr)
    return 0


def main() -> None:
    tag = pick_tag()
    print(f"Mirroring from tag/release: {tag}")
    mirror(tag)


if __name__ == "__main__":
    main()
