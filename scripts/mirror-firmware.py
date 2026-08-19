#!/usr/bin/env python3
"""Mirror Darktec UF2/OTA zip release assets into same-origin firmware dirs (CORS-safe)."""

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
LATEST_OUT = ROOT / "darktec" / "firmware" / "latest"
RELEASES_ROOT = ROOT / "darktec" / "firmware" / "releases"
MANIFEST = ROOT / "darktec" / "releases.json"
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

    last_err: Exception | None = None
    for attempt in range(1, 4):
        cmd = ["curl", "-fsSL", "-L", "--http1.1", "--retry", "3", "--retry-delay", "2"]
        for header in headers:
            cmd.extend(["-H", header])
        cmd.extend(["-o", str(dest), api_url])
        try:
            subprocess.check_call(cmd)
            last_err = None
            break
        except subprocess.CalledProcessError as err:
            last_err = err
            if dest.exists():
                dest.unlink(missing_ok=True)
            print(f"Download attempt {attempt}/3 failed for {dest.name}: {err}", file=sys.stderr)
    if last_err:
        raise last_err

    size = dest.stat().st_size
    if size < 256:
        raise RuntimeError(f"Downloaded {dest.name} looks empty/too small ({size} bytes)")
    if expected_size is not None and size != expected_size:
        raise RuntimeError(
            f"Downloaded {dest.name} size mismatch: got {size}, expected {expected_size}"
        )


def is_mirror_asset(name: str) -> bool:
    if not name.startswith("Darktec_"):
        return False
    if name.endswith(".uf2"):
        return True
    if name.endswith(".zip") and not name.startswith("Darktec_uf2_"):
        return True
    return False


def manifest_tags() -> list[str]:
    if not MANIFEST.exists():
        return []
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    entries = data.get("releases") or []
    if not entries and data.get("release", {}).get("tag"):
        entries = [data]
    tags: list[str] = []
    for entry in entries:
        tag = (entry.get("release") or {}).get("tag")
        if tag and tag not in tags:
            tags.append(tag)
    top = (data.get("release") or {}).get("tag")
    if top and top not in tags:
        tags.insert(0, top)
    return tags


def pick_fallback_tag() -> str:
    tag = (os.environ.get("CLIENT_TAG") or "").strip()
    if tag:
        return tag
    tags = manifest_tags()
    if tags:
        return tags[0]
    if MANIFEST.exists():
        data = json.loads(MANIFEST.read_text(encoding="utf-8"))
        t = (data.get("release") or {}).get("tag")
        if t:
            return t
    return "darktec-latest"


def fetch_release_assets(tag: str) -> tuple[dict | None, list[dict]]:
    for ref in (tag, "darktec-latest"):
        code, rel = api_get(f"{API}/repos/{REPO}/releases/tags/{ref}")
        if code != 200 or not isinstance(rel, dict):
            print(f"Skip {ref} (HTTP {code})")
            continue
        assets = [
            a for a in rel.get("assets") or [] if is_mirror_asset(str(a.get("name", "")))
        ]
        if assets:
            return rel, assets
    return None, []


def mirror_assets_to_dir(assets: list[dict], dest: Path, tag_label: str) -> int:
    dest.mkdir(parents=True, exist_ok=True)
    keep = {a["name"] for a in assets}
    for old in list(dest.glob("Darktec_*.uf2")) + list(dest.glob("Darktec_*.zip")):
        if old.name not in keep:
            old.unlink()

    downloaded = 0
    with tempfile.TemporaryDirectory(prefix="darktec-fw-") as tmp:
        tmp_dir = Path(tmp)
        for a in assets:
            name = a["name"]
            expected = a.get("size")
            final = dest / name
            if final.exists() and expected is not None and final.stat().st_size == expected:
                continue
            print(f"Downloading {tag_label}/{name} ({expected} bytes)")
            download_asset(a["url"], tmp_dir / name, expected_size=expected)
            shutil.move(str(tmp_dir / name), str(final))
            downloaded += 1

    (dest / "SOURCE_TAG.txt").write_text(f"{tag_label}\n", encoding="utf-8")
    return downloaded


def mirror_tag(tag: str) -> int:
    rel, assets = fetch_release_assets(tag)
    if not rel or not assets:
        print(f"No Darktec UF2/zip assets for {tag}", file=sys.stderr)
        return 0
    resolved = str(rel.get("tag_name") or tag)
    dest = RELEASES_ROOT / resolved
    n = mirror_assets_to_dir(assets, dest, resolved)
    print(f"Mirrored {len(assets)} assets ({n} downloaded) → {dest}")
    return len(assets)


def sync_latest_from_release_dir(tag: str) -> None:
    src = RELEASES_ROOT / tag
    if not src.is_dir():
        print(f"Cannot sync latest: missing {src}", file=sys.stderr)
        return
    LATEST_OUT.mkdir(parents=True, exist_ok=True)
    for old in list(LATEST_OUT.glob("Darktec_*.uf2")) + list(LATEST_OUT.glob("Darktec_*.zip")):
        old.unlink()
    copied = 0
    for path in sorted(src.glob("Darktec_*")):
        if path.suffix not in {".uf2", ".zip"}:
            continue
        shutil.copy2(path, LATEST_OUT / path.name)
        copied += 1
    (LATEST_OUT / "SOURCE_TAG.txt").write_text(f"{tag}\n", encoding="utf-8")
    print(f"Synced latest/ from releases/{tag} ({copied} files)")


def main() -> None:
    client_tag = (os.environ.get("CLIENT_TAG") or "").strip()
    tags = manifest_tags()

    if client_tag:
        print(f"Mirroring client tag: {client_tag}")
        n = mirror_tag(client_tag)
        if n <= 0:
            sys.exit(1)
        newest = tags[0] if tags else client_tag
        resolved = client_tag
        if (RELEASES_ROOT / client_tag).is_dir():
            resolved = client_tag
        elif tags and (RELEASES_ROOT / tags[0]).is_dir():
            resolved = tags[0]
        if client_tag == newest or client_tag == "darktec-latest":
            sync_latest_from_release_dir(resolved)
        return

    if tags:
        print(f"Mirroring {len(tags)} release(s) from manifest")
        total = 0
        for tag in tags:
            total += mirror_tag(tag)
        if total <= 0:
            sys.exit(1)
        sync_latest_from_release_dir(tags[0])
        return

    tag = pick_fallback_tag()
    print(f"Mirroring fallback tag: {tag}")
    n = mirror_tag(tag)
    if n <= 0:
        sys.exit(1)
    resolved = tag if (RELEASES_ROOT / tag).is_dir() else tag
    sync_latest_from_release_dir(resolved)


if __name__ == "__main__":
    main()
