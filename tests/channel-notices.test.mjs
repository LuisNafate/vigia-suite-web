import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadChannelNotices, loadFieldFilter, loadScoring } from './app-source.mjs';

const { CONGESTION_SCORE_NETWORKS, CHANNEL_ADVICE_NETWORKS, busiestChannel, channelNotices } = await loadChannelNotices();
const { WIFI_FIELDS, withValidFields } = await loadFieldFilter();
const compute = await loadScoring();

// Como handleLine: cada red pasa por withValidFields. auth 3 y RSSI lejano para que sólo cuente la regla de canal.
const nets = (count, channel, offset = 0) => Array.from({ length: count }, (_, index) =>
  withValidFields({ type: 'wifi_ap', ssid: `Red${offset + index}`, rssi: -80, channel, auth: 3, bssid: `AA:AA:AA:AA:${String(offset).padStart(2, '0')}:${String(index).padStart(2, '0')}` }, WIFI_FIELDS));
const notices = list => channelNotices(busiestChannel(list));

test('los umbrales siguen siendo 12 redes para la puntuación y 4 para el consejo', () => {
  assert.equal(CONGESTION_SCORE_NETWORKS, 12);
  assert.equal(CHANNEL_ADVICE_NETWORKS, 4);
});

test('sin redes o con una sola red por canal no se nombra ningún canal', () => {
  for (const list of [[], nets(1, 6), [...nets(1, 1), ...nets(1, 6, 1), ...nets(1, 11, 2)], nets(3, 6)]) {
    const result = notices(list);
    assert.equal(result.finding, null);
    assert.equal(result.advice, null);
    assert.doesNotMatch(result.recommendation.detail, /el canal \d/);
    assert.equal(result.recommendation.severity, 'info');
  }
});

test('las redes sin canal válido nunca generan avisos de congestión', () => {
  const invalid = [null, undefined, 0, -1, 197, '6', 6.5, true].flatMap((channel, index) => nets(3, channel, index + 10));
  assert.equal(invalid.length, 24);
  assert.ok(invalid.every(network => network.channel === undefined || network.channel === null), 'withValidFields descarta el canal');
  assert.equal(busiestChannel(invalid), null);
  const result = notices(invalid);
  assert.equal(result.finding, null);
  assert.equal(result.advice, null);
  assert.equal(compute(invalid, []).score, 0);
  // Con redes válidas, las desconocidas no se suman a ningún canal.
  assert.deepEqual(busiestChannel([...invalid, ...nets(4, 6)]), { channel: 6, count: 4 });
});

for (const [count, kind] of [[2, null], [3, null], [4, 'advice'], [8, 'advice'], [11, 'advice'], [12, 'risk'], [20, 'risk']]) {
  test(`${count} redes en el canal 6: ${kind ?? 'sin aviso'}`, () => {
    const list = [...nets(count, 6), ...nets(12, null, 50)];
    const result = notices(list);
    const { score } = compute(list, []);
    assert.equal(score, kind === 'risk' ? 5 : 0, 'la puntuación sólo suma con 12 o más redes en un canal válido');
    assert.equal(Boolean(result.finding), kind === 'risk', 'el hallazgo de riesgo coincide exactamente con la regla de puntuación');
    assert.equal(Boolean(result.advice), kind !== null);
    if (result.finding) {
      assert.equal(result.finding.severity, 'medium');
      assert.equal(result.finding.title, `Canal 6 concentra ${count} redes`);
      assert.match(result.finding.detail, /suma 5 puntos/);
    }
    if (result.advice) {
      assert.equal(result.advice.severity, 'info', 'un consejo de optimización nunca se presenta como riesgo');
      assert.match(result.advice.title, /^Optimización: canal 6 /);
      assert.match(result.advice.detail, /no un riesgo de seguridad/);
      assert.match(result.recommendation.detail, /el canal 6/);
    }
  });
}

test('el canal con más redes se elige sólo entre canales válidos', () => {
  assert.deepEqual(busiestChannel([...nets(5, 1), ...nets(7, 11, 1), ...nets(9, null, 2)]), { channel: 11, count: 7 });
});
