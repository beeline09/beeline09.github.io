#!/usr/bin/env python3
"""Mirror Darktec UF2/OTA zip release assets into darktec/firmware/latest (CORS-safe)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
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


def download_asset(api_url: str, dest: Path, expected_size: int | None = None) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    headers = [
        "Accept: application/octet-stream",
        "X-GitHub-Api-Version: 2022-11-28",
        "User-Agent: beeline09-mirror-firmware",
    ]
    if TOKEN:
        headers.insert(0, f"Authorization: Bearer {TOKEN}")

    cmd = ["curl", "-fsSL", "-L"]
    for header in headers:
        cmd.extend(["-H", header])
    cmd.extend(["-o", str(dest), api_url])
    subprocess.check_call(cmd)

    size = dest.stat().st_size
    if size < 256:
        raise RuntimeError(f"Downloaded {dest.name} looks empty/too small ({size} bytes)")
    if expected_size is not None and size != expected_size:
        raise RuntimeError(
            f"Downloaded {dest.name} size mismatch: got {size}, expected {expected_size}"
        )


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


def is_mirror_asset(name: str) -> bool:
    if not name.startswith("Darktec_"):
        return False
    if name.endswith(".uf2"):
        return True
    if name.endswith(".zip") and not name.startswith("Darktec_uf2_"):
        return True
    return False


def mirror(tag: str) -> int:
    for ref in (tag, "darktec-latest"):
        code, rel = api_get(f"{API}/repos/{REPO}/releases/tags/{ref}")
        if code != 200 or not isinstance(rel, dict):
            print(f"Skip {ref} (HTTP {code})")
            continue

        assets = [a for a in rel.get("assets") or [] if is_mirror_asset(str(a.get("name", "")))]
        if not assets:
            print(f"No Darktec UF2/zip assets on {ref}")
            continue

        with tempfile.TemporaryDirectory(prefix="darktec-fw-") as tmp:
            tmp_dir = Path(tmp)
            for a in assets:
                name = a["name"]
                print(f"Downloading {name} ({a.get('size')} bytes)")
                download_asset(a["url"], tmp_dir / name, expected_size=a.get("size"))

            OUT.mkdir(parents=True, exist_ok=True)
            for old in list(OUT.glob("*.uf2")) + list(OUT.glob("*.zip")):
                if old.name.startswith("Darktec_"):
                    old.unlink()

            for a in assets:
                name = a["name"]
                shutil.move(str(tmp_dir / name), str(OUT / name))

            (OUT / "SOURCE_TAG.txt").write_text(f"{rel.get('tag_name', ref)}\n", encoding="utf-8")

        print(f"Mirrored {len(assets)} assets → {OUT}")
        return len(assets)

    print("No release assets found to mirror", file=sys.stderr)
    return 0


def main() -> None:
    tag = pick_tag()
    print(f"Mirroring from tag/release: {tag}")
    n = mirror(tag)
    if n <= 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
