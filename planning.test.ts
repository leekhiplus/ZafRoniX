import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planVideoOutput,
  planImageOutput,
  imageScaleOptions,
  imageLoadLevel,
  videoBitrate,
  keyframeInterval,
  estimateVideoOutputBytes,
} from '../src/lib/planning.ts';

test('video: 540p source doubles natively to 1080p', () => {
  const r = planVideoOutput(960, 540);
  assert.ok(r.ok);
  assert.deepEqual([r.plan.outW, r.plan.outH, r.plan.mode], [1920, 1080, 'native-2x']);
});

test('video: 480p source doubles natively (no resize)', () => {
  const r = planVideoOutput(854, 480);
  assert.ok(r.ok);
  assert.deepEqual([r.plan.outW, r.plan.outH, r.plan.mode], [1708, 960, 'native-2x']);
});

test('video: 720p source is enhanced 2x then fitted to 1080p', () => {
  const r = planVideoOutput(1280, 720);
  assert.ok(r.ok);
  assert.equal(r.plan.mode, 'fit');
  assert.deepEqual([r.plan.aiW, r.plan.aiH], [2560, 1440]);
  assert.deepEqual([r.plan.outW, r.plan.outH], [1920, 1080]);
});

test('video: portrait 720x1280 fits 1080x1920', () => {
  const r = planVideoOutput(720, 1280);
  assert.ok(r.ok);
  assert.deepEqual([r.plan.outW, r.plan.outH], [1080, 1920]);
});

test('video: output size is always even and never above the cap', () => {
  for (const [w, h] of [[853, 479], [1000, 750], [1279, 719], [640, 360], [1366, 768], [900, 1000]]) {
    const r = planVideoOutput(w, h);
    if (!r.ok) continue;
    assert.equal(r.plan.outW % 2, 0, `${w}x${h} width even`);
    assert.equal(r.plan.outH % 2, 0, `${w}x${h} height even`);
    assert.ok(Math.max(r.plan.outW, r.plan.outH) <= 1920);
    assert.ok(Math.min(r.plan.outW, r.plan.outH) <= 1080);
    assert.ok(r.plan.outW > w || r.plan.outH > h, `${w}x${h} actually gets bigger`);
  }
});

test('video: 1080p and 4K sources are rejected honestly', () => {
  for (const [w, h] of [[1920, 1080], [3840, 2160], [1080, 1920], [1920, 800]]) {
    const r = planVideoOutput(w, h);
    assert.equal(r.ok, false, `${w}x${h}`);
  }
});

test('video: tiny and invalid sizes are rejected', () => {
  assert.equal(planVideoOutput(32, 32).ok, false);
  assert.equal(planVideoOutput(0, 100).ok, false);
  assert.equal(planVideoOutput(NaN, 100).ok, false);
});

test('image: 1080p -> 4x is exactly 8K', () => {
  const r = planImageOutput(1920, 1080, 4);
  assert.ok(r.ok);
  assert.deepEqual([r.plan.outW, r.plan.outH, r.plan.passes], [7680, 4320, 2]);
});

test('image: 4K -> 2x is exactly 8K, single pass', () => {
  const r = planImageOutput(3840, 2160, 2);
  assert.ok(r.ok);
  assert.deepEqual([r.plan.outW, r.plan.outH, r.plan.passes], [7680, 4320, 1]);
});

test('image: 4K -> 4x is refused', () => {
  const r = planImageOutput(3840, 2160, 4);
  assert.equal(r.ok, false);
});

test('image: a 24 MP photo cannot be doubled within the 8K limit', () => {
  const r = planImageOutput(6000, 4000, 2);
  assert.equal(r.ok, false);
});

test('image: portrait 8K is allowed, over-limit area is not', () => {
  assert.ok(planImageOutput(2160, 3840, 2).ok);
  // within the long-edge limit but over the pixel limit
  assert.equal(planImageOutput(4096, 4096, 2).ok, false);
});

test('image: scale options explain why a scale is unavailable', () => {
  const opts = imageScaleOptions(3840, 2160);
  assert.equal(opts[0].available, true);
  assert.equal(opts[1].available, false);
  assert.match(opts[1].reason ?? '', /8K|limit/);
});

test('image: load levels', () => {
  assert.equal(imageLoadLevel(1920, 1080), 'normal');
  assert.equal(imageLoadLevel(3840, 2160), 'normal');
  assert.equal(imageLoadLevel(5120, 2880), 'heavy');
  assert.equal(imageLoadLevel(7680, 4320), 'very-heavy');
});

test('bitrate, keyframes and size estimate', () => {
  const std = videoBitrate(1920, 1080, 30, 'standard');
  const high = videoBitrate(1920, 1080, 30, 'high');
  assert.ok(std > 3_000_000 && std < 8_000_000);
  assert.ok(high > std);
  assert.equal(keyframeInterval(30), 60);
  assert.equal(keyframeInterval(23.976), 48);
  const bytes = estimateVideoOutputBytes(1920, 1080, 30, 60, 'standard', true);
  assert.equal(bytes, Math.round(((std + 128_000) / 8) * 60));
});
