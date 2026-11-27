# Controles de seguridad de Vigía Suite Web

**Última revisión:** 27 de noviembre de 2026

**Alcance:** aplicación web/PWA, integración Web Serial con ESP32, historial local y consumo de NVD API 2.0.

Este documento relaciona los cinco controles solicitados en la revisión académica con la arquitectura real del proyecto. Un control marcado como **No aplica** no se considera omitido: incluye la justificación y la condición que obligaría a implementarlo en el futuro.

## Resumen

| # | Control evaluado | Aplicabilidad | Estado | Evidencia principal |
|---:|---|---|---|---|
| 1 | Validación de entradas | Aplica | Implementado | Rangos estrictos para eventos del sensor, normalización del historial y codificación antes de mostrar texto externo. |
| 2 | Autenticación y sesiones | No aplica actualmente | Justificado | No existen cuentas, sesiones remotas ni recursos privados en un servidor. El acceso al ESP32 requiere autorización explícita del navegador. |
| 3 | Hashing de contraseñas | No aplica actualmente | Justificado | La aplicación no solicita, transmite ni almacena contraseñas. |
| 4 | Rate limiting | Aplica a NVD | Implementado | Una petición cada 6 s, cola única, deduplicación, timeout y espera adicional ante HTTP 429/503. |
| 5 | Encabezados de seguridad | Aplica | Implementado | CSP sin `unsafe-inline`/`unsafe-eval`, HSTS, `nosniff`, protección contra iframes, política de permisos y de referencia. |

## 1. Validación de entradas

Las entradas se separan según su frontera de confianza:

- **ESP32 por puerto serial:** `app.js` acepta RSSI, canal y autenticación únicamente como enteros dentro de rangos válidos. Los datos textuales como SSID, BSSID, nombre BLE y servicios se codifican antes de incorporarse a una plantilla HTML.
- **Historial:** `history-core.js` normaliza puntuaciones, niveles, fechas, MAC/BSSID, cantidades y observaciones antes de guardarlas en IndexedDB. El respaldo heredado de `localStorage` se vuelve a validar y se renderiza mediante `textContent`, no mediante HTML dinámico.
- **NVD:** `nvd-core.js` comprueba el formato de CVE, CPE y URL. `nvd.js` codifica las descripciones, referencias y metadatos recibidos de la API.
- **Firmware:** los binarios publicados se verifican mediante SHA-256 y el instalador cancela si el chip no coincide con el manifiesto.

Las pruebas de regresión incluyen cargas con etiquetas HTML y manejadores de eventos para comprobar que no se crean elementos ejecutables.

## 2. Autenticación y sesiones

Vigía Suite Web es una herramienta local sin registro de usuarios, inicio de sesión, cookies de autenticación o recursos privados alojados en un backend. Añadir JWT u OAuth2 sin una identidad remota no protegería ningún activo y aumentaría la superficie de ataque.

Se aplican controles equivalentes sobre las capacidades locales:

- El navegador exige una acción del usuario para autorizar el puerto serial o USB.
- La aplicación no selecciona automáticamente un dispositivo entre varios puertos autorizados.
- La instalación de firmware exige selección de puerto y confirmación explícita.
- Los resultados permanecen en IndexedDB o `localStorage` del navegador.

**Condición de cambio:** si se incorporan cuentas, sincronización en la nube o un panel remoto, deberá añadirse autenticación estándar, sesiones con expiración y autorización por recurso antes de publicar esa función.

## 3. Hashing de contraseñas

No aplica porque el proyecto no solicita ni almacena contraseñas. Tampoco contiene una base de datos de credenciales.

**Condición de cambio:** si en el futuro se implementan credenciales propias, el backend deberá almacenar únicamente hashes con sal y un algoritmo resistente como Argon2id. Nunca se guardarán contraseñas reversibles ni hashes rápidos como MD5 o SHA-1.

## 4. Control de frecuencia

La única API pública consumida es NVD. `nvd-client.js` implementa:

- Cola de una sola petición a la vez.
- Intervalo mínimo de 6 segundos entre solicitudes.
- Deduplicación de consultas simultáneas idénticas.
- Timeout de 30 segundos.
- Un reintento con espera de 30 segundos ante HTTP 429.
- Un reintento con espera de 10 segundos ante HTTP 503.
- Caché local durante 24 horas para evitar solicitudes repetidas.

La aplicación estática no expone una API pública propia. El helper de desarrollo funciona solamente en el equipo local y no forma parte del despliegue de Vercel.

## 5. Encabezados y aislamiento del navegador

`pc-lab/vercel.json` aplica los encabezados a todas las rutas:

| Encabezado | Propósito |
|---|---|
| `Content-Security-Policy` | Limita scripts, estilos, imágenes, conexiones, workers y manifiestos. Sólo permite conexión externa a `services.nvd.nist.gov`. |
| `Strict-Transport-Security` | Fuerza HTTPS durante dos años e incluye subdominios. |
| `X-Content-Type-Options: nosniff` | Evita interpretar archivos con un tipo diferente al declarado. |
| `X-Frame-Options: DENY` y `frame-ancestors 'none'` | Evitan que la aplicación se incruste en un iframe y reducen clickjacking. |
| `Referrer-Policy: no-referrer` | No envía la URL de origen al abrir recursos externos. |
| `Permissions-Policy` | Deniega cámara, micrófono, ubicación y pagos; conserva Serial, USB y Bluetooth sólo para el propio origen. |
| `Cross-Origin-Opener-Policy` | Aísla el contexto principal frente a otras ventanas. |
| `Cross-Origin-Resource-Policy` | Restringe el uso de los recursos del sitio a su propio origen. |

La CSP no permite `unsafe-inline`, `unsafe-eval`, objetos, formularios ni iframes.

## Verificación

Desde la raíz del repositorio:

```powershell
npm run check
npm test
```

Después de desplegar, los encabezados pueden comprobarse con:

```powershell
curl.exe -I https://vigia-suite-web-pc-lab.vercel.app/dashboard.html
```

El despliegue debe mostrar CSP, HSTS, `nosniff`, política de referencia y política de permisos. Una revisión estática que busque exclusivamente middleware de backend puede marcar autenticación, hashing o rate limiting como ausentes; debe evaluarse esta matriz junto con la arquitectura real.
