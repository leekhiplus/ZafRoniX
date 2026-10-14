/**
 * Before / after comparison.
 *
 * Both layers are drawn at the same size inside one box. The "before" layer is clipped to the
 * left of the divider, so you always compare the same moment of the same clip. A transparent
 * range input covers the box, which gives mouse, touch and keyboard control for free.
 *
 * For video, the enhanced clip is the clock and the original follows it (re-synced whenever
 * it drifts), so both always show the same frame.
 */
import { el } from './dom';

export interface CompareOptions {
  kind: 'video' | 'image';
  beforeUrl: string;
  afterUrl: string;
  /** Display aspect ratio of the output. */
  width: number;
  height: number;
  beforeLabel: string;
  afterLabel: string;
  beforeAlt?: string;
  afterAlt?: string;
}

export interface VideoCompareControls {
  toggle(): void;
  seekRatio(ratio: number): void;
  toggleMute(): boolean;
  onState(cb: (s: { playing: boolean; current: number; duration: number }) => void): void;
}

export interface CompareHandle {
  root: HTMLElement;
  video: VideoCompareControls | null;
  /** The enhanced <video> or <img> element. */
  after: HTMLVideoElement | HTMLImageElement;
  destroy(): void;
}

export function createCompare(opts: CompareOptions): CompareHandle {
  const root = el('div', { className: 'compare' });
  root.style.setProperty('--pos', '50%');
  root.style.setProperty('--ar', String(opts.width / opts.height));
  root.style.aspectRatio = `${opts.width} / ${opts.height}`;

  let beforeEl: HTMLVideoElement | HTMLImageElement;
  let afterEl: HTMLVideoElement | HTMLImageElement;

  if (opts.kind === 'video') {
    const b = el('video', { attrs: { playsinline: '', preload: 'auto', 'aria-hidden': 'true' } });
    b.muted = true;
    b.src = opts.beforeUrl;
    const a = el('video', { attrs: { playsinline: '', preload: 'auto', 'aria-label': 'Enhanced video' } });
    a.src = opts.afterUrl;
    beforeEl = b;
    afterEl = a;
  } else {
    beforeEl = el('img', { attrs: { alt: opts.beforeAlt ?? 'Original image', decoding: 'async' } });
    (beforeEl as HTMLImageElement).src = opts.beforeUrl;
    afterEl = el('img', { attrs: { alt: opts.afterAlt ?? 'Enhanced image', decoding: 'async' } });
    (afterEl as HTMLImageElement).src = opts.afterUrl;
  }

  const afterLayer = el('div', { className: 'cmp-layer cmp-after' }, [afterEl]);
  const beforeLayer = el('div', { className: 'cmp-layer cmp-before' }, [beforeEl]);
  const handle = el('div', { className: 'cmp-handle', attrs: { 'aria-hidden': 'true' } }, [el('span', { className: 'cmp-grip' })]);
  const tagBefore = el('span', { className: 'cmp-tag cmp-tag-before', text: opts.beforeLabel });
  const tagAfter = el('span', { className: 'cmp-tag cmp-tag-after', text: opts.afterLabel });
  const range = el('input', {
    className: 'cmp-range',
    attrs: {
      type: 'range',
      min: '0',
      max: '100',
      value: '50',
      'aria-label': 'Comparison divider. Left shows the original, right shows the enhanced result.',
    },
  });
  range.addEventListener('input', () => root.style.setProperty('--pos', `${range.value}%`));

  root.append(afterLayer, beforeLayer, handle, tagBefore, tagAfter, range);

  // ------------------------------------------------------------ video sync
  let videoControls: VideoCompareControls | null = null;
  let raf = 0;
  const destroyers: Array<() => void> = [];

  if (opts.kind === 'video') {
    const before = beforeEl as HTMLVideoElement;
    const after = afterEl as HTMLVideoElement;
    let listener: ((s: { playing: boolean; current: number; duration: number }) => void) | null = null;

    const emit = () =>
      listener?.({
        playing: !after.paused && !after.ended,
        current: after.currentTime || 0,
        duration: Number.isFinite(after.duration) ? after.duration : 0,
      });

    const tick = () => {
      if (!after.paused && Math.abs(before.currentTime - after.currentTime) > 0.1) {
        before.currentTime = after.currentTime;
      }
      emit();
      if (!after.paused) raf = requestAnimationFrame(tick);
    };

    const on = <K extends keyof HTMLMediaElementEventMap>(t: HTMLMediaElement, ev: K, fn: () => void) => {
      t.addEventListener(ev, fn);
      destroyers.push(() => t.removeEventListener(ev, fn));
    };

    on(after, 'play', () => {
      void before.play().catch(() => undefined);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
      emit();
    });
    on(after, 'pause', () => {
      before.pause();
      before.currentTime = after.currentTime;
      cancelAnimationFrame(raf);
      emit();
    });
    on(after, 'ended', () => {
      before.pause();
      emit();
    });
    on(after, 'seeked', () => {
      before.currentTime = after.currentTime;
      emit();
    });
    on(after, 'loadedmetadata', emit);
    on(after, 'timeupdate', emit);

    videoControls = {
      toggle() {
        if (after.paused || after.ended) {
          if (after.ended) after.currentTime = 0;
          void after.play().catch(() => undefined);
        } else {
          after.pause();
        }
      },
      seekRatio(ratio) {
        const d = Number.isFinite(after.duration) ? after.duration : 0;
        if (!d) return;
        const t = Math.min(Math.max(ratio, 0), 1) * d;
        after.currentTime = t;
        before.currentTime = t;
      },
      toggleMute() {
        after.muted = !after.muted;
        return after.muted;
      },
      onState(cb) {
        listener = cb;
        emit();
      },
    };
  }

  return {
    root,
    video: videoControls,
    after: afterEl,
    destroy() {
      cancelAnimationFrame(raf);
      destroyers.forEach((d) => d());
      for (const node of [beforeEl, afterEl]) {
        if (node instanceof HTMLVideoElement) {
          node.pause();
          node.removeAttribute('src');
          node.load();
        } else {
          node.removeAttribute('src');
        }
      }
      root.remove();
    },
  };
}
