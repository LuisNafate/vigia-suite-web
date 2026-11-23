// Puerto Web Serial simulado que responde con las mismas líneas JSON que el firmware 0.5.0 (VIGIA/2).
export const FAKE_SERIAL = (bleFails) => `(() => {
  const enc = new TextEncoder();
  const NL = String.fromCharCode(10);
  const responses = {
    PING: ['{"type":"pong","protocol":2}'],
    INFO: ['{"type":"identity","protocol":2,"board":"nodemcu-esp32s","chip":"ESP32","mac":"04:B2:47:82:60:1C","wifi":true,"ble":true}'],
    STATUS: ['{"type":"status","protocol":2,"heap_free":201234,"uptime_ms":5000,"ble_ready":true,"ble_scanning":false}'],
    SCAN_WIFI: ['{"type":"wifi_scan_started"}',
      '{"type":"wifi_ap","ssid":"Cafe","rssi":-50,"channel":1,"auth":0,"bssid":"AA:AA:AA:AA:AA:01"}',
      '{"type":"wifi_ap","ssid":"Casa","rssi":-60,"channel":6,"auth":3,"bssid":"AA:AA:AA:AA:AA:02"}',
      '{"type":"wifi_ap","ssid":"","rssi":-80,"channel":11,"auth":1,"bssid":"AA:AA:AA:AA:AA:03"}',
      'línea de arranque que no es JSON',
      '{"type":"wifi_scan_finished","count":3,"truncated":true}'],
    SCAN_BLE: ${bleFails
      ? `['{"type":"ble_scan_started","duration_s":5}', '{"type":"error","module":"ble","code":"ble_scan_failed"}', '{"type":"ble_scan_finished","count":0,"failed":true}']`
      : `['{"type":"ble_scan_started","duration_s":5}',
      '{"type":"ble_device","name":"Reloj","address":"11:22:33:44:55:66","address_type":"public","rssi":-50,"connectable":true,"scannable":true,"manufacturer_id":76,"manufacturer_data":"4C00","services":"180d","tx_power":127}',
      '{"type":"ble_scan_finished","count":1,"observed":1,"truncated":false}']`},
  };
  let controller;
  const port = {
    readable: new ReadableStream({ start(c) { controller = c; } }),
    writable: new WritableStream({ write(chunk) {
      const command = new TextDecoder().decode(chunk).trim();
      window.__commands = [...(window.__commands || []), command];
      setTimeout(() => (responses[command] || ['{"type":"error","code":"unknown_command"}']).forEach(line => controller.enqueue(enc.encode(line + NL))), 30);
    } }),
    async open() { setTimeout(() => controller.enqueue(enc.encode('{"type":"ready","protocol":2,"firmware":"0.5.0-arduino","ble_ready":true}' + NL)), 10); },
    async close() {}, getInfo() { return { usbVendorId: 0x10c4 }; },
  };
  Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => port, getPorts: async () => [], addEventListener() {} } });
})();`;

