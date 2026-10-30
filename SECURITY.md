# Seguridad del repositorio

Vigía Suite está diseñada para observación defensiva en redes y dispositivos propios o con autorización explícita.

## Datos que no deben publicarse

- Credenciales, tokens, archivos `.env` o configuraciones Wi-Fi privadas.
- Certificados, llaves privadas, almacenes de claves o firmas de Android.
- Direcciones, inventarios o informes obtenidos en entornos reales.
- Archivos `local.properties`, SDK locales, cachés y resultados de compilación.

La configuración de Git excluye estas categorías. Antes de cada publicación debe revisarse el contenido rastreado y el historial.

## Reportar un problema

No publiques una vulnerabilidad con datos sensibles en un issue. Repórtala de forma privada al propietario del repositorio.
