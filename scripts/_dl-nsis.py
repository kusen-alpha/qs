import hashlib
import math
import os
import re
import subprocess
import sys
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed

NSIS_URL = (
    "https://github.com/tauri-apps/binary-releases/releases/download/"
    "nsis-3.13/nsis-3.13.zip"
)
DLL_URL = (
    "https://github.com/tauri-apps/nsis-tauri-utils/releases/download/"
    "nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll"
)

TAURI_DIR = os.path.join(os.environ["LOCALAPPDATA"], "tauri")
ZIP_OUT = os.path.join(TAURI_DIR, "nsis-3.13.zip")
DLL_OUT = os.path.join(TAURI_DIR, "nsis_tauri_utils.dll")
NSIS_DIR = os.path.join(TAURI_DIR, "NSIS")
DLL_TARGET = os.path.join(
    NSIS_DIR, "Plugins", "x86-unicode", "additional", "nsis_tauri_utils.dll"
)

EXPECT_ZIP_SHA1 = "DB14F8AF2EA346B786C6AE19343F61AAF5E09B8E"
EXPECT_DLL_SHA1 = "75197FEE3C6A814FE035788D1C34EAD39349B860"

THREADS = 96


def sha1(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest().upper()


def get_size(url):
    m = re.match(
        r"https://github\.com/(?P<repo>[^/]+/[^/]+)/releases/download/"
        r"(?P<tag>[^/]+)/(?P<file>.*)",
        url,
    )
    if m:
        api = "https://api.github.com/repos/{}/releases/tags/{}".format(
            m.group("repo"), m.group("tag")
        )
        out = subprocess.run(
            ["curl.exe", "-s", "--max-time", "120", api],
            capture_output=True,
            text=True,
        ).stdout
        import json

        data = json.loads(out)
        for a in data.get("assets", []):
            if a.get("name") == m.group("file"):
                return int(a["size"])
    raise SystemExit("cannot determine size from release API for " + url)


def fetch_part(url, out, start, end):
    for _ in range(3):
        p = subprocess.run(
            [
                "curl.exe",
                "-sS",
                "-L",
                "--max-time",
                "300",
                "-r",
                "{}-{}".format(start, end),
                "-o",
                out,
                url,
            ],
            capture_output=True,
            text=True,
        )
        if p.returncode == 0 and os.path.exists(out) and os.path.getsize(out) > 0:
            return True
        time.sleep(1)
    return False


def curl_download(url, out, threads):
    size = get_size(url)
    print("total size:", size, flush=True)
    chunk = int(math.ceil(size / threads))
    parts_dir = out + ".parts"
    if os.path.exists(parts_dir):
        for f in os.listdir(parts_dir):
            os.remove(os.path.join(parts_dir, f))
    else:
        os.makedirs(parts_dir)

    tasks = []
    for i in range(threads):
        s = i * chunk
        e = min(size - 1, s + chunk - 1)
        if s > e:
            break
        part = os.path.join(parts_dir, "part_{:03d}.bin".format(i))
        tasks.append((i, part, s, e))

    t0 = time.time()
    failed = []
    with ThreadPoolExecutor(max_workers=min(threads, 24)) as ex:
        futs = {
            ex.submit(fetch_part, url, part, s, e): i for i, part, s, e in tasks
        }
        for fut in as_completed(futs):
            i = futs[fut]
            if not fut.result():
                failed.append(i)
    if failed:
        print("failed parts:", failed[:20], flush=True)
        return False

    with open(out, "wb") as dst:
        for i, _, _, _ in tasks:
            with open(os.path.join(parts_dir, "part_{:03d}.bin".format(i)), "rb") as src:
                dst.write(src.read())
    print(
        "downloaded {} parts={} in {:.0f}s".format(
            out, len(tasks), time.time() - t0
        ),
        flush=True,
    )
    return True


def seed_nsis():
    os.makedirs(TAURI_DIR, exist_ok=True)

    if os.path.exists(ZIP_OUT):
        print("zip exists, verifying sha1...", flush=True)
        if sha1(ZIP_OUT) != EXPECT_ZIP_SHA1:
            os.remove(ZIP_OUT)
    if not os.path.exists(ZIP_OUT):
        print("downloading nsis-3.13.zip ...", flush=True)
        if not curl_download(NSIS_URL, ZIP_OUT, THREADS):
            raise SystemExit("zip download failed")

    got = sha1(ZIP_OUT)
    print("zip sha1:", got, flush=True)
    if got != EXPECT_ZIP_SHA1:
        raise SystemExit("zip sha1 mismatch, got " + got)
    print("zip ok:", zipfile.is_zipfile(ZIP_OUT), flush=True)

    if not os.path.exists(DLL_OUT):
        print("downloading nsis_tauri_utils.dll ...", flush=True)
        if not curl_download(DLL_URL, DLL_OUT, 24):
            raise SystemExit("dll download failed")
    got_dll = sha1(DLL_OUT)
    print("dll sha1:", got_dll, flush=True)
    if got_dll != EXPECT_DLL_SHA1:
        raise SystemExit("dll sha1 mismatch")

    if not os.path.exists(NSIS_DIR):
        print("extracting NSIS ...", flush=True)
        with zipfile.ZipFile(ZIP_OUT) as z:
            z.extractall(TAURI_DIR)
        extracted = os.path.join(TAURI_DIR, "nsis-3.13")
        if os.path.exists(extracted):
            os.rename(extracted, NSIS_DIR)
        else:
            raise SystemExit("zip did not contain nsis-3.13 folder")

    os.makedirs(os.path.dirname(DLL_TARGET), exist_ok=True)
    with open(DLL_OUT, "rb") as src, open(DLL_TARGET, "wb") as dst:
        dst.write(src.read())

    print(
        "nsis.exe sha1:",
        sha1(os.path.join(NSIS_DIR, "NSIS.exe")),
        flush=True,
    )
    required = [
        "makensis.exe",
        "Bin/makensis.exe",
        "Stubs/lzma-x86-unicode",
        "Stubs/lzma_solid-x86-unicode",
        "Plugins/x86-unicode/additional/nsis_tauri_utils.dll",
        "Include/MUI2.nsh",
        "Include/FileFunc.nsh",
        "Include/x64.nsh",
        "Include/nsDialogs.nsh",
        "Include/WinMessages.nsh",
        "Include/Win/COM.nsh",
        "Include/Win/Propkey.nsh",
        "Include/Win/RestartManager.nsh",
    ]
    for rel in required:
        p = os.path.join(NSIS_DIR, *rel.split("/"))
        print(("OK  " if os.path.exists(p) else "MISS"), rel, flush=True)


if __name__ == "__main__":
    seed_nsis()
