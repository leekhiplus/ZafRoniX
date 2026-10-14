import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBytes,
  formatDuration,
  resolutionLabel,
  sanitizeBaseName,
  outputFileName,
  estimateRemainingSeconds,
} from '../src/lib/format.ts';

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5 MB');
  assert.equal(formatBytes(18.4 * 1024 * 1024), '18.4 MB');
  assert.equal(formatBytes(1.5 * 1024 ** 3), '1.5 GB');
  assert.equal(formatBytes(-1), '-');
  assert.equal(formatBytes(NaN), '-');
});

test('formatDuration', () => {
  assert.equal(formatDuration(5), '0:05');
  assert.equal(formatDuration(83), '1:23');
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(NaN), '-');
});

test('resolutionLabel uses real dimensions', () => {
  assert.equal(resolutionLabel(1920, 1080), '1080p');
  assert.equal(resolutionLabel(1080, 1920), '1080p');
  assert.equal(resolutionLabel(1280, 720), '720p');
  assert.equal(resolutionLabel(3840, 2160), '4K');
  assert.equal(resolutionLabel(7680, 4320), '8K');
  assert.equal(resolutionLabel(2160, 3840), '4K');
  assert.equal(resolutionLabel(320, 240), 'SD');
});

test('sanitizeBaseName keeps letters from any language and drops unsafe characters', () => {
  assert.equal(sanitizeBaseName('My Clip (final).MOV'), 'My-Clip-final');
  assert.equal(sanitizeBaseName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeBaseName('C:\\Users\\me\\clip.final.mp4'), 'clip.final');
  assert.equal(sanitizeBaseName('ویڈیو ۱.mp4'), 'ویڈیو-۱');
  assert.equal(sanitizeBaseName('***.mp4', 'video'), 'video');
  assert.equal(sanitizeBaseName('a'.repeat(300) + '.mp4').length, 80);
});

test('outputFileName', () => {
  assert.equal(outputFileName('My Clip.MOV', 'zafronix-1080p', 'mp4', 'video'), 'My-Clip-zafronix-1080p.mp4');
  assert.equal(outputFileName('???.png', 'zafronix-4K', '.png', 'image'), 'image-zafronix-4K.png');
});

test('ETA is withheld until enough real data exists', () => {
  assert.equal(estimateRemainingSeconds(0.01, 10_000), null);
  assert.equal(estimateRemainingSeconds(0.5, 1_000), null);
  assert.equal(estimateRemainingSeconds(1, 10_000), null);
  assert.equal(estimateRemainingSeconds(0.25, 10_000), 30);
});
