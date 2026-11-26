import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, normalizeColor, normalizeLength } from '../../src/kernel/assert.ts';

test('text and url', () => {
  assert.equal(compare('text', 'eq', 'Added', 'Added').match, true);
  assert.equal(compare('text', 'contains', 'Saved at 10:00', 'Saved').match, true);
  assert.equal(compare('url', 'ne', 'http://localhost/a', 'http://localhost/a').match, false);
});

test('text comparisons are exact: case, whitespace and empty values', () => {
  assert.equal(compare('text', 'eq', 'Added', 'added').match, false);
  assert.equal(compare('text', 'eq', 'Added ', 'Added').match, false);
  assert.equal(compare('text', 'eq', '', '').match, true);
  assert.equal(compare('text', 'contains', 'abc', '').match, true);
  assert.equal(compare('text', 'contains', '', 'x').match, false);
  assert.equal(compare('text', 'ne', 'a', 'b').match, true);
  // Ordering is not defined for text: never a lexical comparison.
  assert.equal(compare('text', 'gt', 'b', 'a').match, false);
  assert.equal(compare('url', 'lte', 'a', 'b').match, false);
});

test('count', () => {
  assert.equal(compare('count', 'gte', 3, 3).match, true);
  assert.deepEqual(compare('count', 'eq', 2, 3), { match: false, actual: 2, expected: 3 });
  assert.equal(compare('count', 'gt', 4, 3).match, true);
  assert.equal(compare('count', 'lt', 2, 3).match, true);
  assert.equal(compare('count', 'lte', 4, 3).match, false);
  assert.equal(compare('count', 'ne', 2, 3).match, true);
  assert.equal(compare('count', 'eq', 0, 0).match, true);
});

test('count with values of the wrong type or not finite never matches', () => {
  assert.equal(compare('count', 'eq', '3', 3).match, false);
  assert.equal(compare('count', 'ne', '3', 4).match, false);
  assert.equal(compare('count', 'ne', Number.NaN, 3).match, false);
  assert.equal(compare('count', 'ne', 3, Number.NaN).match, false);
  assert.equal(compare('count', 'gt', Number.POSITIVE_INFINITY, 3).match, false);
});

test('css colors compare after normalization', () => {
  assert.equal(compare('css', 'eq', 'rgb(0, 128, 0)', '#008000', 'color').match, true);
  assert.equal(compare('css', 'eq', 'rgba(0, 128, 0, 0.5)', '#008000', 'background-color').match, false);
  assert.equal(normalizeColor('#0a0'), 'rgba(0,170,0,1)');
  assert.equal(normalizeColor('blue'), null);
});

test('css colors: ne, original values are returned, property name is matched case-insensitively', () => {
  assert.deepEqual(compare('css', 'eq', 'rgb(0, 128, 0)', '#008000', 'color'), {
    match: true,
    actual: 'rgb(0, 128, 0)',
    expected: '#008000',
  });
  assert.equal(compare('css', 'ne', 'rgb(0, 128, 0)', '#008000', 'border-top-color').match, false);
  assert.equal(compare('css', 'ne', 'rgb(0, 128, 0)', '#008001', 'Color').match, true);
  assert.equal(compare('css', 'eq', 'rgba(0, 128, 0, 0.50)', 'rgba(0,128,0,.5)', 'color').match, true);
  assert.equal(compare('css', 'eq', 'rgba(0, 128, 0, 1)', 'rgb(0,128,0)', 'color').match, true);
});

test('css colors that cannot be normalised compare as strings, never as ordered values', () => {
  assert.equal(compare('css', 'eq', 'transparent', 'transparent', 'color').match, true);
  assert.equal(compare('css', 'eq', 'transparent', 'rgba(0, 0, 0, 0)', 'color').match, false);
  assert.equal(compare('css', 'ne', 'transparent', '#000', 'color').match, true);
  assert.equal(compare('css', 'gt', 'rgb(2, 0, 0)', 'rgb(1, 0, 0)', 'color').match, false);
  assert.equal(compare('css', 'lt', 'blue', 'red', 'color').match, false);
});

test('normalizeColor accepts only #rgb, #rrggbb, rgb() and rgba()', () => {
  assert.equal(normalizeColor('#008000'), 'rgba(0,128,0,1)');
  assert.equal(normalizeColor('#ABC'), 'rgba(170,187,204,1)');
  assert.equal(normalizeColor('rgb(0, 128, 0)'), 'rgba(0,128,0,1)');
  assert.equal(normalizeColor('RGB(0,128,0)'), 'rgba(0,128,0,1)');
  assert.equal(normalizeColor('rgba(0, 128, 0, 0.5)'), 'rgba(0,128,0,0.5)');
  assert.equal(normalizeColor('rgba(0,128,0,0)'), 'rgba(0,128,0,0)');
  assert.equal(normalizeColor('  rgb(1, 2, 3)  '), 'rgba(1,2,3,1)');
  assert.equal(normalizeColor('rgb(255,255,255)'), 'rgba(255,255,255,1)');
});

test('normalizeColor fails closed on adjacent punctuation, nested delimiters and empty values', () => {
  const bad = [
    '', ' ', '#', '#0', '#00', '#0000', '#00000', '#0000000', '#00000000', '#ggg', '#00800!',
    '**#008000**', '#008000!', '#008000)', '(#008000)', '"#008000"', '#008000;', '#008000 #008000', '##008000',
    'rgb()', 'rgb(,,)', 'rgb(0,128)', 'rgb(0,128,)', 'rgb(0,,0)', 'rgba(0,128,0,)', 'rgba(0,128,0,0.5,1)',
    'rgb(0,128,0))', '(rgb(0,128,0))', 'rgb(0,128,0', 'rgb 0,128,0)', 'rgb(0,128,0)!', '**rgb(0,128,0)**',
    'rgb(0,128,0)x', 'xrgb(0,128,0)', 'url(rgb(0,128,0))', 'rgb(rgb(0,1,2),1,2)', 'rgb(0,128,0) rgb(1,1,1)',
    'rgb(0, 128, 0), rgb(1, 1, 1)', 'rgb(256,0,0)', 'rgb(-1,0,0)', 'rgb(1.5,0,0)', 'rgb(1e2,0,0)', 'rgb(0%,0%,0%)',
    'rgb(0 128 0)', 'rgb(0 128 0 / 50%)', 'rgba(0,0,0,1.5)', 'rgba(0,0,0,-0.5)', 'rgba(0,0,0,.)', 'rgba(0,0,0,5%)',
    'hsl(120,100%,25%)', 'green', 'currentcolor',
  ];
  for (const s of bad) assert.equal(normalizeColor(s), null, JSON.stringify(s));
});

test('css lengths compare as numbers', () => {
  assert.equal(compare('css', 'eq', '18px', 18, 'font-size').match, true);
  assert.equal(compare('css', 'lt', '12px', '16px', 'margin-top').match, true);
  assert.equal(compare('css', 'gt', 'auto', '16px', 'margin-top').match, false);
  assert.equal(compare('css', 'eq', 'flex', 'flex', 'display').match, true);
});

test('css lengths: every ordering and ne, original values are returned', () => {
  assert.deepEqual(compare('css', 'eq', '18px', 18, 'font-size'), { match: true, actual: '18px', expected: 18 });
  assert.equal(compare('css', 'eq', '18.0px', '18px', 'font-size').match, true);
  assert.equal(compare('css', 'ne', '18px', '18.5px', 'font-size').match, true);
  assert.equal(compare('css', 'gte', '16px', '16px', 'margin-top').match, true);
  assert.equal(compare('css', 'lte', '16px', '16px', 'margin-top').match, true);
  assert.equal(compare('css', 'gt', '16px', 16, 'margin-top').match, false);
  assert.equal(compare('css', 'lt', '-4px', '0px', 'margin-left').match, true);
  // A numeric comparison, not a lexical one: '9px' < '10px'.
  assert.equal(compare('css', 'lt', '9px', '10px', 'margin-top').match, true);
  assert.equal(compare('css', 'gt', '9px', '10px', 'margin-top').match, false);
  assert.equal(compare('css', 'eq', '0px', '-0px', 'margin-top').match, true);
});

test('css ordering with a side that is not a number is a non-match, not an error and not a lexical comparison', () => {
  for (const cmp of ['gt', 'gte', 'lt', 'lte'] as const) {
    assert.equal(compare('css', cmp, 'auto', '16px', 'margin-top').match, false, `actual non-numeric ${cmp}`);
    assert.equal(compare('css', cmp, '16px', 'auto', 'margin-top').match, false, `expected non-numeric ${cmp}`);
    assert.equal(compare('css', cmp, 'auto', 'normal', 'margin-top').match, false, `both non-numeric ${cmp}`);
    assert.equal(compare('css', cmp, 'b', 'a', 'display').match, false, `lexically greater ${cmp}`);
    assert.equal(compare('css', cmp, '', '', 'margin-top').match, false, `empty ${cmp}`);
    assert.equal(compare('css', cmp, '16px', '', 'margin-top').match, false, `empty expected ${cmp}`);
    assert.equal(compare('css', cmp, '10px 20px', '5px', 'margin').match, false, `shorthand ${cmp}`);
    assert.equal(compare('css', cmp, '1em', '16px', 'margin-top').match, false, `other unit ${cmp}`);
  }
  assert.deepEqual(compare('css', 'gt', 'auto', '16px', 'margin-top'), { match: false, actual: 'auto', expected: '16px' });
});

test('css non-length values compare as strings for eq and ne only', () => {
  assert.equal(compare('css', 'ne', 'flex', 'block', 'display').match, true);
  assert.equal(compare('css', 'ne', 'flex', 'flex', 'display').match, false);
  assert.equal(compare('css', 'eq', 'auto', 18, 'margin-top').match, false);
  assert.equal(compare('css', 'ne', 'auto', 18, 'margin-top').match, true);
  assert.equal(compare('css', 'eq', '10px 20px', '10px 20px', 'margin').match, true);
  assert.equal(compare('css', 'eq', '', '', 'content').match, true);
  // Without a property name the value is not a colour.
  assert.equal(compare('css', 'eq', '18px', 18).match, true);
});

test('normalizeLength accepts numbers and <number>px only', () => {
  assert.equal(normalizeLength(18), 18);
  assert.equal(normalizeLength(-2.5), -2.5);
  assert.equal(normalizeLength('18px'), 18);
  assert.equal(normalizeLength('18'), 18);
  assert.equal(normalizeLength('-0.5px'), -0.5);
  assert.equal(normalizeLength('.5px'), 0.5);
  assert.equal(normalizeLength('+3px'), 3);
  assert.equal(normalizeLength('18PX'), 18);
  assert.equal(normalizeLength(' 18px '), 18);
  assert.equal(Object.is(normalizeLength('-0px'), 0), true);
});

test('normalizeLength fails closed on adjacent punctuation, nested delimiters and empty values', () => {
  const bad = [
    '', ' ', 'px', '-', '.', '.px', '-px', '1.px', '18pxx', '18p', '18 px', '18px!', '!18px', '(18px)', '**18px**',
    '18px)', '"18px"', '18px;', '18px px', '18px 20px', '18px,20px', '--1px', '+-1px', '1e3px', '1e3', '0x10',
    '1,000px', '18em', '18%', '18rem', 'calc(18px)', 'calc(1px + 2px)', 'auto', 'NaN', 'Infinity', '-Infinity', '18px\n18px',
  ];
  for (const s of bad) assert.equal(normalizeLength(s), null, JSON.stringify(s));
  assert.equal(normalizeLength(Number.NaN), null);
  assert.equal(normalizeLength(Number.POSITIVE_INFINITY), null);
  assert.equal(normalizeLength(Number.NEGATIVE_INFINITY), null);
});

test('visible and missing elements', () => {
  assert.equal(compare('visible', 'eq', false, true).match, false);
  assert.deepEqual(compare('text', 'eq', null, 'x'), { match: false, actual: null, expected: 'x' });
  assert.equal(compare('text', 'ne', null, 'x').match, false);
});

test('visible compares booleans; other types and orderings never match', () => {
  assert.equal(compare('visible', 'eq', true, true).match, true);
  assert.equal(compare('visible', 'ne', true, false).match, true);
  assert.equal(compare('visible', 'ne', true, true).match, false);
  assert.equal(compare('visible', 'eq', 'true', true).match, false);
  assert.equal(compare('visible', 'ne', 'true', false).match, false);
  assert.equal(compare('visible', 'gt', true, false).match, false);
  assert.equal(compare('visible', 'contains', true, true).match, false);
});

test('a missing element (actual null) is a non-match for every kind and comparator', () => {
  const kinds = ['text', 'url', 'count', 'css', 'visible'] as const;
  const cmps = ['eq', 'ne', 'contains', 'gt', 'gte', 'lt', 'lte'] as const;
  for (const kind of kinds) {
    for (const cmp of cmps) {
      const expected = kind === 'count' ? 0 : kind === 'visible' ? false : '';
      const r = compare(kind, cmp, null, expected, kind === 'css' ? 'color' : undefined);
      assert.deepEqual(r, { match: false, actual: null, expected }, `${kind} ${cmp}`);
    }
  }
});

test('contains is only defined for text and url', () => {
  assert.equal(compare('css', 'contains', 'flex', 'fl', 'display').match, false);
  assert.equal(compare('count', 'contains', 3, 3).match, false);
});
