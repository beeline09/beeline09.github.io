#!/usr/bin/env python3
"""Mirror Darktec on-demand OTA .zip assets into darktec/firmware/ondemand (CORS-safe).

Stock catalog zips live in darktec/firmware/latest (mirror-firmware.py).
Custom builds from Release tag `darktec-ondemand` use this folder so
`/darktec_new/` can Serial-DFU without hitting GitHub release CORS.
"""

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
OUT = ROOT / "darktec" / "firmware" / "ondemand"
REPO = os.environ.get("FIRMWARE_REPO", "beeline09/MeshCore")
API = os.environ.get("GITHUB_API_URL", "https://api.github.com")
TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
TAG = os.environ.get("ONDEMAND_TAG", "darktec-ondemand")
KEEP_MAX = int(os.environ.get("ONDEMAND_KEEP_MAX", "40"))


def api_get(url: str) -> tuple[int, dict | list | None]:
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "beeline09-mirror-ondemand",
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
        "User-Agent: beeline09-mirror-ondemand",
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


def is_ondemand_zip(name: str) -> bool:
    # Custom cache names: Darktec_{role}_{chem}_{cells}s_{protect}__{slug}__{radio}__{sha}.zip
    return name.startswith("Darktec_") and "__" in name and name.endswith(".zip")


def wanted_names() -> set[str] | None:
    raw = (os.environ.get("CLIENT_ASSETS") or "").strip()
    if not raw:
        return None
    names = {n.strip() for n in raw.replace(";", ",").split(",") if n.strip()}
    return names or None


def prune(out: Path, keep: int) -> None:
    zips = sorted(out.glob("Darktec_*__*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in zips[keep:]:
        print(f"Prune {old.name}")
        old.unlink(missing_ok=True)


def mirror() -> int:
    code, rel = api_get(f"{API}/repos/{REPO}/releases/tags/{TAG}")
    if code == 404:
        print(f"Release {TAG} missing — nothing to mirror")
        return 0
    if code != 200 or not isinstance(rel, dict):
        print(f"Skip {TAG} (HTTP {code})", file=sys.stderr)
        return 0

    assets = [a for a in (rel.get("assets") or []) if is_ondemand_zip(str(a.get("name", "")))]
    filter_names = wanted_names()
    if filter_names is not None:
        assets = [a for a in assets if a.get("name") in filter_names]
        missing = filter_names - {a.get("name") for a in assets}
        if missing:
            print(f"Warning: not on release yet: {', '.join(sorted(missing))}", file=sys.stderr)

    if not assets:
        print("No on-demand zip assets to mirror")
        return 0

    OUT.mkdir(parents=True, exist_ok=True)
    mirrored = 0
    with tempfile.TemporaryDirectory(prefix="darktec-od-") as tmp:
        tmp_dir = Path(tmp)
        for a in assets:
            name = a["name"]
            dest_final = OUT / name
            if dest_final.is_file() and a.get("size") and dest_final.stat().st_size == a["size"]:
                print(f"Skip (fresh) {name}")
                mirrored += 1
                continue
            print(f"Downloading {name} ({a.get('size')} bytes)")
            tmp_path = tmp_dir / name
            download_asset(a["url"], tmp_path, expected_size=a.get("size"))
            shutil.move(str(tmp_path), str(dest_final))
            mirrored += 1

    prune(OUT, KEEP_MAX)
    (OUT / "SOURCE_TAG.txt").write_text(f"{rel.get('tag_name', TAG)}\n", encoding="utf-8")
    print(f"Mirrored {mirrored} on-demand zip(s) → {OUT}")
    return mirrored


def main() -> None:
    print(f"Mirroring on-demand zips from {REPO}@{TAG}")
    n = mirror()
    # Specific asset request that failed to download should fail the job.
    wanted = wanted_names()
    if wanted is not None and n <= 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
