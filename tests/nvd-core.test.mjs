import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as nvd from '../pc-lab/nvd-core.js';

// Los mismos casos se ejecutan en vigia-suite-android (NvdEquivalenceTest): las dos apps deben interpretar igual.
const fixture = JSON.parse(await readFile(new URL('./fixtures/nvd-cases.json', import.meta.url), 'utf8'));

const summarize = (name, json) => {
  if (name.startsWith('cpe')) {
    const r = nvd.parseCpeResponse(json);
    return { page: r.page, skipped: r.skipped, products: r.items.map(({ cpeName, title, vendor, product, version, deprecated, deprecatedBy, lastModified }) => ({ cpeName, title, vendor, product, version, deprecated, deprecatedBy, lastModified })) };
  }
  const r = nvd.parseCveResponse(json);
  if (name.startsWith('keyword')) return { page: r.page, skipped: r.skipped, ids: r.items.map(item => item.id) };
  return { page: r.page, skipped: r.skipped, items: r.items.map(item => ({
    id: item.id, status: item.status, rejected: item.rejected, published: item.published, lastModified: item.lastModified, description: item.description,
    primaryMetric: item.primaryMetric, metricVersions: item.metrics.map(m => m.version), metricSources: item.metrics.map(m => m.source),
    v2Severity: item.metrics.find(m => m.version === '2.0')?.severity ?? null, weaknesses: item.weaknesses, tags: item.tags,
    references: item.references.map(ref => ref.url),
    configurations: item.configurations.map(c => ({ operator: c.operator, nodes: c.nodes.length, matches: c.nodes.reduce((n, node) => n + node.matches.length, 0) })),
    affected: item.affected.map(a => ({ vendor: a.vendor, product: a.product, versions: a.versions.map(v => `${v.version}${v.lessThan ? ` < ${v.lessThan}` : ''}${v.lessThanOrEqual ? ` <= ${v.lessThanOrEqual}` : ''} ${v.status}`) })),
    kev: item.kev?.added ?? null,
  })) };
};

for (const [name, expected] of Object.entries(fixture.expected)) {
  test(`respuesta NVD compartida: ${name}`, () => assert.deepEqual(summarize(name, fixture.responses[name]), expected));
}

for (const name of fixture.formatErrors) {
  test(`respuesta con formato inesperado: ${name}`, () => {
    assert.throws(() => nvd.parseCveResponse(fixture.responses[name]), error => error.kind === 'format');
    assert.throws(() => nvd.parseCpeResponse(fixture.responses[name]), error => error.kind === 'format');
  });
}

for (const item of fixture.applicability) {
  test(`aplicabilidad compartida: ${item.name}`, () => {
    const cve = nvd.parseCveResponse(fixture.responses[item.response]).items[0];
    assert.deepEqual(nvd.applicabilityFor(cve, item.cpeName), { status: item.expected, requirements: item.requirements });
  });
}

test('comparación de versiones compartida', () => {
  for (const { a, b, expected } of fixture.versions) assert.equal(nvd.compareVersions(a, b), expected, `${a} frente a ${b}`);
});

for (const item of fixture.urls) {
  test(`URL compartida: ${item.name}`, () => {
    const build = { cveById: input => nvd.cveByIdUrl(input), cveByKeyword: (input, o) => nvd.cveByKeywordUrl(input, o), cpeSearch: (input, o) => nvd.cpeSearchUrl(input, o), cveByCpe: (input, o) => nvd.cveByCpeUrl(input, o) }[item.kind];
    if (item.expected === null) assert.throws(() => build(item.input, item.options ?? {}), error => error.kind === 'invalid_input');
    else assert.equal(build(item.input, item.options ?? {}), item.expected);
  });
}

test('una CVE sin puntuación nunca se presenta como de riesgo bajo', () => {
  const unscored = nvd.parseCveResponse(fixture.responses['cve-no-metrics']).items[0];
  assert.equal(unscored.primaryMetric, null);
  assert.equal(nvd.severityLabel(unscored.primaryMetric?.severity), 'Sin puntuación CVSS');
  assert.equal(nvd.severityLabel(undefined), 'Sin puntuación CVSS');
  assert.equal(nvd.severityLabel('LOW'), 'Baja');
  assert.equal(nvd.severityLabel('NONE'), 'Ninguna (CVSS 0)');
  assert.equal(nvd.statusLabel('Awaiting Analysis'), 'Pendiente de análisis');
  assert.equal(nvd.statusLabel(null), 'Estado no informado');
});

test('las referencias sólo admiten enlaces http y https', () => {
  const urls = nvd.parseCveResponse(fixture.responses['cve-log4j']).items[0].references.map(ref => ref.url);
  assert.ok(urls.every(url => /^https?:\/\//.test(url)));
  assert.ok(!urls.some(url => url.startsWith('javascript:')));
});

test('el aviso de atribución es el texto de los Términos de uso de NVD', () => {
  assert.equal(nvd.NVD_NOTICE, 'This product uses the NVD API but is not endorsed or certified by the NVD.');
});
