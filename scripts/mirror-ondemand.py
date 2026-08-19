#!/usr/bin/env python3
"""Mirror Darktec on-demand UF2/OTA zip assets into darktec/firmware/ondemand (CORS-safe).

Stock catalog lives in darktec/firmware/latest (mirror-firmware.py).
Custom builds from Release tag `darktec-ondemand` use this folder so
`/darktec/` can Serial-DFU without hitting GitHub release CORS.

Also writes ondemand-manifest.json for the browser (never poll api.github.com).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "darktec" / "firmware" / "ondemand"
SHA_OUT = ROOT / "darktec" / "south_edition_sha.txt"
REPO = os.environ.get("FIRMWARE_REPO", "beeline09/MeshCore")
API = os.environ.get("GITHUB_API_URL", "https://api.github.com")
TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
TAG = os.environ.get("ONDEMAND_TAG", "darktec-ondemand")
KEEP_MAX = int(os.environ.get("ONDEMAND_KEEP_MAX", "40"))
SHA_RE = re.compile(r"__([0-9a-f]{7,12})\.(?:uf2|zip)$", re.I)


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


def is_ondemand_asset(name: str) -> bool:
    # Custom cache names: Darktec_{role}_{chem}_{cells}s_{protect}__{slug}__{radio}__{sha}.{uf2|zip}
    return (
        name.startswith("Darktec_")
        and "__" in name
        and (name.endswith(".zip") or name.endswith(".uf2"))
    )


def wanted_names() -> set[str] | None:
    raw = (os.environ.get("CLIENT_ASSETS") or "").strip()
    if not raw:
        return None
    names = {n.strip() for n in raw.replace(";", ",").split(",") if n.strip()}
    return names or None


def prune(out: Path, keep: int) -> None:
    # Keep newest pairs; count by basename without extension.
    assets = sorted(
        [p for p in out.glob("Darktec_*__*.*") if p.suffix.lower() in (".zip", ".uf2")],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    seen_bases: list[str] = []
    keep_files: set[Path] = set()
    for p in assets:
        base = p.name.rsplit(".", 1)[0]
        if base not in seen_bases:
            if len(seen_bases) >= keep:
                continue
            seen_bases.append(base)
        if base in seen_bases:
            keep_files.add(p)
    for old in assets:
        if old not in keep_files:
            print(f"Prune {old.name}")
            old.unlink(missing_ok=True)


def fetch_south_sha() -> str | None:
    code, data = api_get(f"{API}/repos/{REPO}/commits/south_edition")
    if code == 200 and isinstance(data, dict) and data.get("sha"):
        return str(data["sha"])[:8].lower()
    return None


def infer_sha_from_files(out: Path) -> str | None:
    counts: dict[str, int] = {}
    newest: dict[str, float] = {}
    for p in out.glob("Darktec_*__*.*"):
        m = SHA_RE.search(p.name)
        if not m:
            continue
        sha = m.group(1).lower()[:8]
        counts[sha] = counts.get(sha, 0) + 1
        newest[sha] = max(newest.get(sha, 0.0), p.stat().st_mtime)
    if not counts:
        return None
    return max(counts.keys(), key=lambda s: (counts[s], newest[s]))


def write_manifest(out: Path, south_sha: str | None) -> None:
    files = []
    for p in sorted(out.glob("Darktec_*__*.*")):
        if p.suffix.lower() not in (".zip", ".uf2"):
            continue
        files.append(
            {
                "name": p.name,
                "size": p.stat().st_size,
                # Path relative to /darktec/.
                "url": f"./firmware/ondemand/{p.name}",
            }
        )
    payload = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        "sourceTag": TAG,
        "southSha": south_sha,
        "files": files,
    }
    path = out / "ondemand-manifest.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {path} · files={len(files)} · sha={south_sha!r}")


def write_south_sha(sha: str | None) -> None:
    if not sha:
        return
    SHA_OUT.parent.mkdir(parents=True, exist_ok=True)
    SHA_OUT.write_text(f"{sha}\n", encoding="utf-8")
    print(f"Wrote {SHA_OUT} → {sha}")


def mirror() -> int:
    code, rel = api_get(f"{API}/repos/{REPO}/releases/tags/{TAG}")
    if code == 404:
        print(f"Release {TAG} missing — nothing to mirror")
        write_manifest(OUT, fetch_south_sha() or infer_sha_from_files(OUT))
        return 0
    if code != 200 or not isinstance(rel, dict):
        print(f"Skip {TAG} (HTTP {code})", file=sys.stderr)
        write_manifest(OUT, fetch_south_sha() or infer_sha_from_files(OUT))
        return 0

    assets = [a for a in (rel.get("assets") or []) if is_ondemand_asset(str(a.get("name", "")))]
    filter_names = wanted_names()
    if filter_names is not None:
        assets = [a for a in assets if a.get("name") in filter_names]
        missing = filter_names - {a.get("name") for a in assets}
        if missing:
            print(f"Warning: not on release yet: {', '.join(sorted(missing))}", file=sys.stderr)

    OUT.mkdir(parents=True, exist_ok=True)
    mirrored = 0
    if assets:
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
    else:
        print("No on-demand assets to mirror")

    (OUT / "SOURCE_TAG.txt").write_text(f"{rel.get('tag_name', TAG)}\n", encoding="utf-8")
    south_sha = fetch_south_sha() or infer_sha_from_files(OUT)
    write_south_sha(south_sha)
    write_manifest(OUT, south_sha)
    print(f"Mirrored {mirrored} on-demand asset(s) → {OUT}")
    return mirrored


def main() -> None:
    print(f"Mirroring on-demand assets from {REPO}@{TAG}")
    n = mirror()
    # Specific asset request that failed to download should fail the job.
    wanted = wanted_names()
    if wanted is not None and n <= 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
