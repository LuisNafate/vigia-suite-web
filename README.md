# Vigía Suite 0.7

Suite defensiva Web + Android conectada a un sensor NodeMCU ESP-32S mediante USB. Ambos clientes ofrecen las mismas funciones y hablan el mismo protocolo serial con el firmware.

El informe combina inventario Wi-Fi y Bluetooth LE, puntuación contextual, hallazgos explicados y recomendaciones. La web conserva hasta 20 resúmenes en el navegador y exporta el informe completo como JSON o CSV. Android conserva hasta 20 sesiones en el dispositivo y permite guardar o compartir un informe desde el selector del sistema.

## Hardware objetivo

- NodeMCU ESP-32S / NodeMCU-32S.
- Convertidor USB-UART CP2102 o CH340 integrado en la placa.
- Para PC: cable USB de datos.
- Para Android: adaptador USB-OTG y cable USB de datos.

El ESP-32S no tiene USB nativo. La comunicación pasa por el convertidor USB-UART de la placa a 115200 8N1.

## Funciones disponibles

- Validación del enlace con `PING`.
- Identidad de placa, chip y MAC con `INFO`.
- Memoria libre y tiempo activo con `STATUS`.
- Inventario Wi-Fi 2.4 GHz con `SCAN_WIFI`.
- Diagnóstico del radio Bluetooth con `BLE_STATUS`.
- Inventario Bluetooth Low Energy con `SCAN_BLE`: nombre, dirección y tipo de dirección, RSSI, cercanía estimada, conectividad, fabricante y servicios anunciados.
- Deduplicación por dirección BLE y análisis de exposición de identificadores estables.
- Reinicio controlado con `REBOOT`.
- Límite de 32 resultados por análisis para proteger la memoria del sensor.
- Uso local: los resultados no se envían a Internet.
- Navegación por apartados: Inicio, Resumen, Redes Wi-Fi, Bluetooth y Sistema.
- Interfaz 0.7 monocromática con navegación lateral en escritorio, navegación compacta en móvil y acciones ordenadas por tarea.
- Análisis guiado que ejecuta los módulos de forma secuencial y evita escaneos solapados.
- Puntuación de exposición, hallazgos priorizados y recomendaciones defensivas.
- Identificación explícita de análisis parciales cuando un módulo no responde.

## Probar la versión web

1. Conecta el NodeMCU ESP-32S por USB y cierra el Monitor Serie de Arduino.
2. Haz doble clic en `INICIAR-VIGIA.bat`.
3. La ruta `/` muestra la presentación cinematográfica del proyecto; desplázate para recorrer el despiece del ESP32.
4. Pulsa **Abrir laboratorio** para entrar en `dashboard.html`.
5. En Edge pulsa **Preparar ESP32**. El asistente detecta CP210x/CH340, compila e instala el firmware.
6. Pulsa **Conectar ESP32**, autoriza el puerto y ejecuta los módulos de enlace, identidad, diagnóstico, Wi-Fi y Bluetooth.

La portada usa 192 cuadros WebP del MP4 original: 1280×720 para escritorio y 768×432 para móvil. El desplazamiento controla el cuadro mostrado y funciona en ambos sentidos. Para regenerar las secuencias usa `scripts/extract-product-frames.ps1`.

El firmware queda guardado en la memoria flash del ESP32 y arranca automáticamente cada vez que recibe energía. La web también puede instalarse desde **Instalar Web App** en Edge.

Inicio manual:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\start-pc-lab.ps1
```

## Compilar la versión Android sin Android Studio

Haz doble clic en `COMPILAR-ANDROID.bat`, o ejecuta:

```powershell
.\scripts\build-android.ps1
```

El APK se genera en:

```text
app/build/outputs/apk/debug/app-debug.apk
```

Para instalarlo automáticamente:

1. Activa **Opciones de desarrollador > Depuración USB** en el celular.
2. Conecta el celular a la PC y acepta la autorización RSA.
3. Ejecuta `INSTALAR-ANDROID.bat`.

La depuración USB solo se necesita para instalar desde la PC. Para conectar el ESP32 a la aplicación se utiliza USB-OTG; Android solicitará permiso para el CP210x/CH340.

## Firmware manual

El código también puede abrirse en Arduino IDE:

```text
firmware/arduino/VigiaSensor/VigiaSensor.ino
```

Selecciona **ESP32 Dev Module**, **Partition Scheme: Huge APP (3MB No OTA/1MB SPIFFS)**, el puerto correspondiente y pulsa **Subir**. El asistente web selecciona esta partición automáticamente.

## Arquitectura

- Web/PWA: HTML, CSS y JavaScript; Web Serial para usar el sensor.
- Asistente local: PowerShell + Arduino CLI para detectar y preparar el ESP32.
- Android: Kotlin, Jetpack Compose y usb-serial-for-android.
- Firmware: Arduino-ESP32 con Wi-Fi y BLE.
- Protocolo VIGIA/2: comandos ASCII y eventos JSON Lines versionados.

## Uso responsable

Las funciones de descubrimiento deben utilizarse exclusivamente en redes, espacios y dispositivos propios o con autorización explícita. El proyecto realiza inventario y diagnóstico defensivo; no intenta autenticarse, interferir ni capturar contenido de terceros.
