import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFile, detectKind } from '../src/lib/validation.ts';

const rules = {
  extensions: ['.mp4', '.mov', '.webm', '.mkv'],
  mimeTypes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'],
  maxBytes: 100 * 1024 * 1024,
};

test('accepts a normal mp4', () => {
  assert.deepEqual(validateFile({ name: 'clip.mp4', type: 'video/mp4', size: 5_000_000 }, rules), { ok: true });
});

test('accepts an empty MIME type when the extension is allowed (common for .mkv)', () => {
  assert.deepEqual(validateFile({ name: 'clip.MKV', type: '', size: 5_000_000 }, rules), { ok: true });
});

test('rejects wrong extension', () => {
  const r = validateFile({ name: 'clip.avi', type: 'video/x-msvideo', size: 1000 }, rules);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'extension');
});

test('rejects a file with no extension', () => {
  const r = validateFile({ name: 'clip', type: 'video/mp4', size: 1000 }, rules);
  assert.equal(r.ok, false);
});

test('rejects a mismatching MIME type', () => {
  const r = validateFile({ name: 'clip.mp4', type: 'text/html', size: 1000 }, rules);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'mime');
});

test('rejects empty and oversized files', () => {
  const empty = validateFile({ name: 'a.mp4', type: 'video/mp4', size: 0 }, rules);
  const big = validateFile({ name: 'a.mp4', type: 'video/mp4', size: rules.maxBytes + 1 }, rules);
  assert.equal(empty.ok, false);
  assert.equal(big.ok, false);
  if (!big.ok) assert.equal(big.code, 'too-large');
});

test('detectKind redirects files dropped on the wrong tab', () => {
  const v = ['.mp4', '.mov'];
  const i = ['.png', '.jpg'];
  assert.equal(detectKind({ name: 'a.png', type: 'image/png' }, v, i), 'image');
  assert.equal(detectKind({ name: 'a.mp4', type: '' }, v, i), 'video');
  assert.equal(detectKind({ name: 'a.txt', type: 'text/plain' }, v, i), null);
});
