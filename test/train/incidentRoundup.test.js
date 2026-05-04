const test = require('node:test');
const assert = require('node:assert');
const {
  scoreSignals,
  buildRoundupText,
  describeSignal,
} = require('../../bin/train/incident-roundup');

test('scoreSignals dedupes by source, takes max severity', () => {
  const signals = [
    { source: 'gap', severity: 0.5, detail: null },
    { source: 'gap', severity: 0.8, detail: null },
    { source: 'pulse-cold', severity: 0.5, detail: null },
  ];
  const { total, bySource } = scoreSignals(signals);
  assert.equal(bySource.get('gap'), 0.8);
  assert.equal(bySource.get('pulse-cold'), 0.5);
  assert.equal(Math.round(total * 10) / 10, 1.3);
});

test('roundup text includes line name and signals', () => {
  const text = buildRoundupText('red', [
    { source: 'gap', severity: 0.7, detail: JSON.stringify({ ratio: 2.6, suppressed: 'cap' }) },
    { source: 'ghost', severity: 0.9, detail: JSON.stringify({ missing: 2.5, expected: 8.5 }) },
  ]);
  assert.ok(text.includes('Red'));
  assert.ok(text.includes('multiple service signals'));
  assert.ok(text.includes('2.6x'));
});

test('describeSignal handles unknown source gracefully', () => {
  const text = describeSignal({ source: 'unknown', severity: 0.5, detail: null });
  assert.ok(text.includes('unknown'));
});
