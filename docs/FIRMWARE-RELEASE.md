# Publicar una versión del firmware para el instalador web

El instalador de **Preparar ESP32** (`pc-lab/installer.js`) sólo instala binarios que cumplen tres condiciones:

- Viven en `pc-lab/firmware/`, del mismo origen que la web.
- Están descritos en `pc-lab/firmware/manifest.json`.
- Su tamaño y SHA-256 coinciden con el manifiesto.

Este documento explica cómo producir esos archivos.

## Toolchain fijada

Las versiones están en [`firmware/build-config.json`](../firmware/build-config.json). No uses "la última" sin revisarla.

| Componente | Versión | Fuente oficial | Verificación |
|---|---|---|---|
| arduino-cli | 1.5.1 | `github.com/arduino/arduino-cli/releases` | SHA-256 contra `1.5.1-checksums.txt` de la misma release |
| Núcleo `esp32:esp32` | 3.3.12 (mínimo compatible: 3.3.7) | `https://espressif.github.io/arduino-esp32/package_esp32_index.json` | arduino-cli comprueba el SHA-256 de cada paquete del índice (`enable_unsafe_install: false`) |
| FQBN | `esp32:esp32:esp32:PartitionScheme=huge_app` | — | Wi-Fi + BLE no caben en la partición por defecto |
| esptool-js (en la web) | 0.7.0 | npm `esptool-js` (Espressif) | `sha512` de npm; `pc-lab/vendor/esptool-js-0.7.0/VENDOR.json` guarda el SHA-256 del bundle |

**Política para cambiar de versión:**

- La versión nueva debe tener al menos 14 días publicada.
- Nunca se usan preversiones (`-rc`, `-alpha`, índice *dev*).
- Hay que compilar y probar en hardware antes de fijarla.

**Por qué el mínimo es 3.3.7.** El sketch usa `if (!BLEDevice::init(""))` y `BLEScan::isScanning()`. La primera llamada exige que `init` devuelva `bool` (desde 3.3.6). La segunda debe estar disponible sin la guarda de NimBLE (desde 3.3.7). Antes de esas versiones, el sketch no compila.

## Opción A: compilación local (Windows)

La toolchain se instala aislada en `.tooling/`, que está ignorada por git, y no toca un Arduino IDE que ya tengas.

```bash
# 1. arduino-cli verificado
mkdir -p .tooling/downloads && cd .tooling/downloads
V=1.5.1; B=https://github.com/arduino/arduino-cli/releases/download/v$V
curl -fsSLO $B/$V-checksums.txt
curl -fsSLO $B/arduino-cli_${V}_Windows_64bit.zip
grep " arduino-cli_${V}_Windows_64bit.zip$" $V-checksums.txt | sha256sum --check
mkdir -p ../arduino-cli/$V && unzip -q arduino-cli_${V}_Windows_64bit.zip -d ../arduino-cli/$V
cd ..

# 2. Configuración aislada (.tooling/arduino-cli.yaml) con:
#    board_manager.additional_urls = [índice estable de Espressif]
#    board_manager.enable_unsafe_install = false
#    directories.data/downloads/user dentro de .tooling/
./arduino-cli/1.5.1/arduino-cli.exe --config-file arduino-cli.yaml core update-index
./arduino-cli/1.5.1/arduino-cli.exe --config-file arduino-cli.yaml core install esp32:esp32@3.3.12
cd ..

# 3. Compilar y generar binarios + manifiesto
python scripts/build_firmware.py
node scripts/verify-firmware.mjs
npm test
```

**Rutas con espacios.** El núcleo esp32 3.3.x pasa sus archivos de opciones (`@…/flags/…`) sin comillas. Si `directories.data` contiene espacios (por ejemplo `C:\Users\Nombre Apellido\…`), la compilación falla con `bits/c++config.h: No such file or directory`. Usar la ruta corta 8.3 tampoco sirve, porque arduino-cli la normaliza a la forma larga. La solución es poner la carpeta de datos en una ruta sin espacios, por ejemplo `C:/ProgramData/VigiaSuite/arduino15`, y dejar `directories.downloads` en `.tooling/arduino15/staging`. `build_firmware.py` detecta este caso y lo explica.

Si la descarga de alguna herramienta grande se corta (por ejemplo `esp-rv32`, de unos 700 MB), puedes bajar ese archivo con `curl -C -` a `.tooling/arduino15/staging/packages/`. Usa la URL exacta del índice. Si `release-assets.githubusercontent.com` no responde desde tu red, Espressif publica la misma ruta en su espejo oficial: `https://dl.espressif.com/github_assets/<ruta después de github.com/>`. arduino-cli comprueba el SHA-256 del índice antes de usar cualquier archivo, así que el origen de la descarga no cambia la garantía de integridad.

## Opción B: GitHub Actions

El workflow [`.github/workflows/firmware.yml`](../.github/workflows/firmware.yml) se ejecuta a mano (`workflow_dispatch`) o en pull requests que tocan el firmware. Hace lo siguiente:

1. Descarga arduino-cli 1.5.1 y verifica su SHA-256.
2. Instala `esp32:esp32@3.3.12` desde el índice estable.
3. Ejecuta `scripts/build_firmware.py --builder github-actions`.
4. Corre las pruebas y `verify-firmware.mjs`.
5. Sube `pc-lab/firmware/` como artefacto `vigia-firmware`.

**No hace push ni crea releases.** Un mantenedor descarga el artefacto, lo revisa y lo incorpora con un commit.

## Pasos para publicar una versión nueva

1. Cambia `FIRMWARE_VERSION` en `firmware/arduino/VigiaSensor/VigiaSensor.ino`. El script se niega a sobrescribir una versión ya publicada salvo con `--force`.
2. Haz commit del código del firmware. El manifiesto registra el commit y avisa si el firmware tenía cambios sin confirmar.
3. Compila con la opción A o B.
4. Revisa el resultado:
   - `pc-lab/firmware/<versión>/` contiene `bootloader.bin` (0x1000), `partitions.bin` (0x8000), `boot_app0.bin` (0xe000) y `vigia-sensor.bin` (0x10000). Las direcciones se leen del patrón de carga del núcleo, no se escriben a mano.
   - `pc-lab/firmware/manifest.json` describe versión, chip, protocolo, archivos, direcciones, tamaños, SHA-256 y toolchain.
5. **Prueba en hardware**: instala desde **Preparar ESP32** en una placa real y confirma que la verificación muestra `Firmware <versión> verificado (VIGIA/2)`.
6. Haz commit de `pc-lab/firmware/` (manifiesto y binarios juntos) y despliega la web.

## Qué protege el instalador

- **Origen de los archivos:** sólo acepta rutas del manifiesto que resuelvan en el mismo origen y dentro de `firmware/`.
- **Integridad:** comprueba tamaño y SHA-256 de cada archivo, la cabecera `0xE9` y el chip ID de las imágenes, y que la aplicación quepa en su partición.
- **Chip correcto:** identifica el chip con el cargador ROM y cancela si no coincide con el del manifiesto. También cancela si la flash es menor que la requerida.
- **Escritura limitada:** escribe solo las cuatro regiones del firmware (`eraseAll: false`) y conserva los parámetros de flash de los binarios (`keep`). El ESP32 verifica cada región con MD5.
- **Consentimiento:** exige casilla de confirmación y botón explícito. No elige puertos automáticamente.
- **Éxito real:** sólo declara éxito si el sensor arranca y emite `ready` con la versión esperada y protocolo 2.

## Herramientas de desarrollo

`INICIAR-VIGIA.bat` y `scripts/start-pc-lab.ps1` (helper local con Arduino CLI) siguen disponibles para desarrollo. Los usuarios finales no los necesitan.
