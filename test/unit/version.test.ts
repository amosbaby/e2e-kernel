import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kernelVersion } from '../../src/shared/version.ts';

test('kernelVersion reads package.json', () => {
  assert.equal(kernelVersion(), '0.1.0');
});
