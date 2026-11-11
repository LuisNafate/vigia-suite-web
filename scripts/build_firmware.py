#!/usr/bin/env python3
"""Compila el firmware Vigía Sensor y publica binarios verificables para el instalador web.

Uso:
  python scripts/build_firmware.py [--builder local|github-actions] [--force] [--no-latest]

Requisitos: arduino-cli y el núcleo esp32 en las versiones fijadas en firmware/build-config.json.
Por defecto usa la instalación aislada de .tooling/ (ver docs/FIRMWARE-RELEASE.md).
Variables opcionales: ARDUINO_CLI (ruta al ejecutable) y ARDUINO_CLI_CONFIG (archivo de configuración).

El script no inventa direcciones de flash: las lee del patrón de carga del propio núcleo
(tools.esptool_py.upload.pattern_args) y copia exactamente los archivos que usaría arduino-cli upload.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "firmware" / "build-config.json"
MANIFEST_SCHEMA = "vigia-firmware-manifest/1"
VERSION_RE = re.compile(r'FIRMWARE_VERSION\s*=\s*"([^"]+)"')


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sketch_digest(sketch_dir: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(p for p in sketch_dir.rglob("*") if p.is_file()):
        digest.update(path.relative_to(sketch_dir).as_posix().encode())
        digest.update(b"\0")
        # Normaliza finales de línea para que Windows y Linux produzcan el mismo hash.
        digest.update(path.read_bytes().replace(b"\r\n", b"\n"))
    return digest.hexdigest()


def locate_cli(config: dict) -> tuple[list[str], str | None]:
    exe = "arduino-cli.exe" if os.name == "nt" else "arduino-cli"
    cli = os.environ.get("ARDUINO_CLI") or str(ROOT / ".tooling" / "arduino-cli" / config["toolchain"]["arduinoCli"] / exe)
    if not Path(cli).exists() and shutil.which(cli) is None:
        fail(f"No se encontró arduino-cli en {cli}. Consulta docs/FIRMWARE-RELEASE.md.")
    cfg = os.environ.get("ARDUINO_CLI_CONFIG") or str(ROOT / ".tooling" / "arduino-cli.yaml")
    command = [cli]
    if Path(cfg).exists():
        command += ["--config-file", cfg]
    return command, cfg if Path(cfg).exists() else None


def run(command: list[str], **kwargs) -> subprocess.CompletedProcess:
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", **kwargs)
    if result.returncode != 0:
        print(result.stdout[-4000:], file=sys.stderr)
        print(result.stderr[-4000:], file=sys.stderr)
        fail(f"Falló: {' '.join(command[:3])} …")
    return result


def check_toolchain(cli: list[str], config: dict) -> dict:
    settings = json.loads(run(cli + ["config", "dump", "--json"]).stdout)
    data_dir = (settings.get("config", settings).get("directories") or {}).get("data", "")
    if " " in data_dir:
        fail(
            f"La carpeta de datos de arduino-cli contiene espacios ({data_dir}). El núcleo esp32 3.3.x "
            "pasa archivos @response sin comillas y la compilación falla (bits/c++config.h). "
            "Configura directories.data en una ruta sin espacios (ver docs/FIRMWARE-RELEASE.md)."
        )
    version = json.loads(run(cli + ["version", "--json"]).stdout)
    wanted_cli = config["toolchain"]["arduinoCli"]
    if version.get("VersionString") != wanted_cli:
        fail(f"arduino-cli {version.get('VersionString')} instalado; se requiere {wanted_cli}.")
    cores = json.loads(run(cli + ["core", "list", "--json"]).stdout)
    platforms = cores.get("platforms", cores) if isinstance(cores, dict) else cores
    wanted_core = config["toolchain"]["core"]
    installed = None
    for item in platforms or []:
        identifier = item.get("id") or item.get("ID")
        if identifier == wanted_core:
            installed = item.get("installed_version") or item.get("installed") or item.get("Installed")
    if installed != config["toolchain"]["coreVersion"]:
        fail(f"{wanted_core} {installed} instalado; se requiere {config['toolchain']['coreVersion']}.")
    return {"arduinoCli": wanted_cli, "core": f"{wanted_core}@{installed}"}


def parse_properties(text: str) -> dict:
    properties = {}
    for line in text.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            properties[key.strip()] = value.strip()
    return properties


def flash_layout(properties: dict, build_dir: Path, project: str) -> list[tuple[int, Path]]:
    pattern = properties.get("tools.esptool_py.upload.pattern_args")
    if not pattern:
        fail("El núcleo no expone tools.esptool_py.upload.pattern_args; no se puede deducir el mapa de flash.")
    pattern = pattern.replace("{build.path}", str(build_dir)).replace("{build.project_name}", project)
    # Pares "0xDIRECCIÓN ruta.bin" (con o sin comillas). No se usa shlex para no romper rutas de Windows.
    pair_re = re.compile(r'(0x[0-9a-fA-F]+)\s+(?:"([^"]+\.bin)"|(\S+\.bin))')
    layout = [(int(m.group(1), 16), Path(m.group(2) or m.group(3))) for m in pair_re.finditer(pattern)]
    if not layout:
        fail(f"No se encontraron pares dirección/archivo en el patrón de carga: {pattern}")
    return layout


def classify(offset: int, path: Path, project: str) -> tuple[str, str]:
    name = path.name
    if name == f"{project}.bootloader.bin":
        return "bootloader", "bootloader.bin"
    if name == f"{project}.partitions.bin":
        return "partition-table", "partitions.bin"
    if name == "boot_app0.bin":
        return "otadata", "boot_app0.bin"
    if name == f"{project}.bin":
        return "app", "vigia-sensor.bin"
    fail(f"Archivo inesperado en el mapa de flash: {name} @ 0x{offset:x}")
    return "", ""


def git_info(sketch: str) -> dict:
    try:
        commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
        dirty = bool(subprocess.run(["git", "status", "--porcelain", "--", sketch], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip())
        return {"commit": commit, "firmwareSourceDirty": dirty}
    except (OSError, subprocess.CalledProcessError):
        return {"commit": None, "firmwareSourceDirty": None}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--builder", default="local", choices=["local", "github-actions"])
    parser.add_argument("--force", action="store_true", help="Reemplaza una versión ya publicada en el manifiesto.")
    parser.add_argument("--no-latest", action="store_true", help="No marcar esta versión como latest.")
    args = parser.parse_args()

    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    sketch_dir = ROOT / config["sketch"]
    project = f"{sketch_dir.name}.ino"
    source = (sketch_dir / f"{sketch_dir.name}.ino").read_text(encoding="utf-8")
    match = VERSION_RE.search(source)
    if not match:
        fail("No se encontró FIRMWARE_VERSION en el sketch.")
    version = match.group(1)
    if f'\\"protocol\\":{config["protocol"]}' not in source:
        fail(f"El sketch no anuncia protocol {config['protocol']}.")

    cli, cfg = locate_cli(config)
    toolchain = check_toolchain(cli, config)
    output_root = ROOT / config["output"]
    release_dir = output_root / version
    manifest_path = output_root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {"schema": MANIFEST_SCHEMA, "latest": None, "releases": []}
    if any(r["version"] == version for r in manifest["releases"]) and not args.force:
        fail(f"La versión {version} ya existe en el manifiesto. Incrementa FIRMWARE_VERSION o usa --force.")

    with tempfile.TemporaryDirectory(prefix="vigia-fw-") as temp:
        build_dir = Path(temp) / "build"
        out_dir = Path(temp) / "out"
        print(f"Compilando {config['sketch']} ({version}) con {toolchain['core']} …")
        compile_result = run(cli + ["compile", "--fqbn", config["fqbn"], "--build-path", str(build_dir), "--output-dir", str(out_dir), "--warnings", "default", str(sketch_dir)])
        size_lines = [line for line in compile_result.stdout.splitlines() if "bytes" in line.lower()]
        properties = parse_properties(run(cli + ["compile", "--fqbn", config["fqbn"], "--build-path", str(build_dir), "--show-properties=expanded", str(sketch_dir)]).stdout)
        layout = flash_layout(properties, build_dir, project)

        if release_dir.exists():
            shutil.rmtree(release_dir)
        release_dir.mkdir(parents=True)
        files = []
        for offset, path in sorted(layout):
            if not path.exists():
                fail(f"No existe {path} declarado en el patrón de carga.")
            file_type, published = classify(offset, path, project)
            target = release_dir / published
            shutil.copyfile(path, target)
            files.append({
                "type": file_type,
                "path": f"{version}/{published}",
                "offset": offset,
                "offsetHex": f"0x{offset:x}",
                "size": target.stat().st_size,
                "sha256": sha256_file(target),
            })

    release = {
        "version": version,
        "channel": "stable",
        "protocol": config["protocol"],
        "chip": config["chip"],
        "boards": config["boards"],
        "minFlashSize": config["minFlashSize"],
        "releasedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "flash": {
            "mode": "keep",
            "freq": "keep",
            "size": "keep",
            "buildMode": properties.get("build.flash_mode"),
            "buildFreq": properties.get("build.flash_freq"),
            "buildSize": properties.get("build.flash_size"),
            "eraseAll": False,
        },
        "build": {
            **toolchain,
            "fqbn": config["fqbn"],
            "partitions": properties.get("build.partitions"),
            "sketchSha256": sketch_digest(sketch_dir),
            "builder": args.builder,
            "host": f"{platform.system()} {platform.machine()}",
            **git_info(config["sketch"]),
        },
        "files": files,
    }
    manifest["releases"] = [r for r in manifest["releases"] if r["version"] != version] + [release]
    manifest["releases"].sort(key=lambda r: [int(x) if x.isdigit() else 0 for x in r["version"].split("-")[0].split(".")], reverse=True)
    if not args.no_latest:
        manifest["latest"] = version
    manifest["schema"] = MANIFEST_SCHEMA
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print("\n".join(size_lines))
    print(f"\nPublicado en {release_dir.relative_to(ROOT)}:")
    for item in files:
        print(f"  {item['offsetHex']:>8}  {item['size']:>8} B  {item['sha256']}  {item['path']}")
    print(f"Manifiesto actualizado: {manifest_path.relative_to(ROOT)} (latest = {manifest['latest']})")
    if release["build"].get("firmwareSourceDirty"):
        print("AVISO: el código de firmware tiene cambios sin commit; publica sólo después de confirmarlos.")


if __name__ == "__main__":
    main()
