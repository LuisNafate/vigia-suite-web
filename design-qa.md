# Verificación de diseño — Vigía Suite 0.7

## Resultado final

**Aprobado para la portada web.** Se realizaron capturas reales en navegadores Chromium a 1440×900 y 390×844, y se corrigieron el estado inicial, la salida del cargador y la cabecera móvil.

## Verificaciones completadas

- La página principal responde en `http://127.0.0.1:4173/`.
- El fondo `assets/monochrome-folds.png` responde correctamente.
- `app.js` pasa la validación de sintaxis.
- La hoja de estilos tiene llaves balanceadas.
- La aplicación Android 0.7 compila correctamente.
- Se revisó el contraste de botones, puntaje, consola y tarjetas oscuras.
- Se conservaron las funciones de conexión, análisis, Wi-Fi, Bluetooth, historial y exportación.
- El MP4 fue medido automáticamente: 1280×720, 24 FPS, 8 segundos y 192 cuadros.
- Las secuencias de escritorio y móvil contienen 192 cuadros consecutivos, sin archivos faltantes.
- La portada usa Canvas con escala proporcional, DPR limitado a 2 y fondo emparejado con los cuadros.
- El desplazamiento determina el cuadro objetivo; al subir se recorre la misma secuencia en reversa.
- Los textos son HTML semántico y existe una alternativa para `prefers-reduced-motion`.
- Los CTA conducen a `dashboard.html`, donde se mantienen las funciones del laboratorio.

## Inspección visual

- Escritorio: hero legible sobre espacio negativo, placa completa y navegación sin solapamientos.
- Móvil: placa contenida en la mitad superior, narrativa debajo y cabecera compacta.
- El cargador desaparece en cuanto el primer cuadro está disponible, sin bloquear toda la precarga.

## Referencia aplicada

Dashboard monocromático con superficie translúcida, navegación lateral, tarjetas blancas y negras, bordes redondeados amplios y fondo abstracto de pliegues. No se copiaron marca, contenido ni gráficos de la referencia.

La nueva portada adopta una dirección editorial oscura basada en el MP4 del NodeMCU ESP‑32S: tipografía de sistema, un único acento cálido, movimiento ligado al scroll y contenido posterior con amplio espacio en blanco.
