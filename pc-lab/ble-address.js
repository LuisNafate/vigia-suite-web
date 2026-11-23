// Clasificación de direcciones BLE (fórmula de puntuación versión 3). Se carga como script clásico antes de app.js y
// history-core.js la importa como módulo: en los dos casos publica globalThis.VigiaBleAddress. Debe coincidir con
// BleAddress.kt de vigia-suite-android (tests/fixtures/ble-address-cases.json).
//
// Origen de los datos (firmware 0.5.0, núcleo 3.3.12 con Bluedroid): address_type es esp_ble_addr_type_t sin traducir
// (0 public, 1 random, 2 public_identity, 3 random_identity) y address es BLEAddress::toString(), que imprime
// scan_rst.bda desde el byte 0, el más significativo. Por eso los dos bits altos del primer par hexadecimal indican el
// subtipo de una dirección aleatoria (Bluetooth Core, Vol 6, Parte B, 1.3.2): 11 estática, 01 privada resoluble,
// 00 privada no resoluble y 10 reservado.
//
// Los tipos 2 y 3 sólo aparecen cuando el controlador resolvió una dirección privada resoluble con la IRK de un
// dispositivo emparejado; la dirección recibida es entonces la identidad resuelta, no la que se ve en el aire. El
// sensor no se empareja, así que no se tratan como rastreables por terceros.
(function (root) {
  const MAC = /^[0-9A-F]{2}([:-][0-9A-F]{2}){5}$/i;
  const STABLE = Object.freeze(['public', 'static']);
  const PRIVATE = Object.freeze(['resolvable', 'non_resolvable', 'resolved_identity']);
  const LABELS = Object.freeze({
    public: 'Pública',
    static: 'Aleatoria estática',
    resolvable: 'Privada resoluble',
    non_resolvable: 'Privada no resoluble',
    resolved_identity: 'Identidad resuelta',
    unknown: 'No determinada',
  });
  const RANDOM_SUBTYPES = Object.freeze(['non_resolvable', 'resolvable', 'unknown', 'static']);

  /** public, static, resolvable, non_resolvable, resolved_identity o unknown. */
  function classify(addressType, address) {
    if (addressType === 'public_identity' || addressType === 'random_identity') return 'resolved_identity';
    if (addressType !== 'public' && addressType !== 'random') return 'unknown';
    if (typeof address !== 'string' || !MAC.test(address.trim())) return 'unknown';
    if (addressType === 'public') return 'public';
    return RANDOM_SUBTYPES[parseInt(address.trim().slice(0, 2), 16) >> 6];
  }

  /** Identificador que puede repetirse entre sesiones: pública o aleatoria estática (ésta cambia si el dispositivo la regenera). */
  const isStable = kind => STABLE.includes(kind);
  const isPrivate = kind => PRIVATE.includes(kind);
  const label = kind => LABELS[kind] ?? LABELS.unknown;

  const near = rssi => Number.isInteger(rssi) && rssi >= -65;
  const points = count => Math.min(10, count * 2);
  /**
   * Puntos BLE de una lista { addressType, address, rssi, connectable } con la regla de la versión 3 y con la regla
   * anterior (todo tipo que no contenga «random» era estable). Sólo se usa para advertir al comparar evaluaciones.
   */
  function blePoints(items) {
    const candidates = items.filter(item => near(item.rssi) && item.connectable === true);
    return {
      current: points(candidates.filter(item => isStable(classify(item.addressType, item.address))).length),
      previous: points(candidates.filter(item => !String(item.addressType).includes('random')).length),
    };
  }

  root.VigiaBleAddress = Object.freeze({ classify, isStable, isPrivate, label, blePoints, LABELS });
})(globalThis);
