/**
 * Application controller: owns the UI state for the Video and Image tabs, talks to the
 * processing worker, and renders results. Heavy work never runs here.
 */
import { CONFIG, STORAGE_KEY } from '../config';
import { WorkerClient } from '../engine/client';
import type { ImageJobRequest, ModelChoice, ModelContent, ModelSize, VideoJobRequest, WorkerToMain } from '../engine/protocol';
import { detectCapabilities, type Capabilities } from './capabilities';
import { $, clear, el, fillDl, fillNotes, readRadio, setRadio, setRadioDisabled } from '../ui/dom';
import { createCompare, type CompareHandle } from '../ui/compare';
import { probeImage, probeVideo } from '../lib/metadata';
import { detectKind, validateFile, type MediaKind } from '../lib/validation';
import {
  estimateVideoOutputBytes,
  imageLoadLevel,
  imageScaleOptions,
  planImageOutput,
  planVideoOutput,
  type ImageScale,
  type VideoQuality,
} from '../lib/planning';
import {
  estimateRemainingSeconds,
  formatBytes,
  formatDuration,
  formatResolution,
  outputFileName,
  resolutionLabel,
} from '../lib/format';

type Tab = MediaKind;
type Phase = 'empty' | 'selected' | 'processing' | 'done' | 'error';
type ImageFormat = 'png' | 'jpeg' | 'webp';

interface ErrorView {
  title: string;
  message: string;
  hint?: string;
  retryable: boolean;
}

interface Session {
  phase: Phase;
  file: File | null;
  sourceUrl: string | null;
  width: number;
  height: number;
  duration: number;
  resultUrl: string | null;
  compare: CompareHandle | null;
  error: ErrorView | null;
}

const newSession = (): Session => ({
  phase: 'empty',
  file: null,
  sourceUrl: null,
  width: 0,
  height: 0,
  duration: 0,
  resultUrl: null,
  compare: null,
  error: null,
});

interface Settings {
  model: ModelChoice;
  vquality: VideoQuality;
  keepAudio: boolean;
  scale: ImageScale;
  format: ImageFormat;
  imgQuality: number;
}

interface Analysis {
  rows: Array<[string, string]>;
  notes: Array<{ text: string; tone: 'info' | 'warn' | 'block' }>;
  canStart: boolean;
  hint: string;
}

const ERROR_TITLES: Record<string, string> = {
  'webgpu-unavailable': 'WebGPU is not available',
  'gpu-lost': 'The graphics device stopped',
  'model-load-failed': 'The AI model did not load',
  'codec-unsupported': 'This video cannot be decoded here',
  'encoder-unsupported': 'This browser cannot encode the result',
  'rotation-unsupported': 'Rotated video is not supported yet',
  'size-mismatch': 'The video changes size',
  'no-video-track': 'No video found in this file',
  'decode-failed': 'The file could not be read',
  'encode-failed': 'The result could not be encoded',
  'out-of-memory': 'Out of memory',
  'invalid-input': 'This file cannot be processed',
  unknown: 'Processing stopped',
};

class App {
  private readonly client = new WorkerClient();
  private readonly sessions: Record<Tab, Session> = { video: newSession(), image: newSession() };
  private tab: Tab = 'video';
  private caps: Capabilities | null = null;
  private wakeLock: { release(): Promise<void> } | null = null;
  private toastTimer = 0;
  private processingTab: Tab | null = null;

  // ---------------------------------------------------------------- boot
  init(): void {
    this.restoreSettings();
    this.bindChrome();
    this.bindFiles();
    this.bindInspector();
    this.bindActions();
    this.render();

    window.addEventListener('beforeunload', (e) => {
      if (this.client.busy) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.client.busy) void this.lockScreen();
    });

    void detectCapabilities().then((caps) => {
      this.caps = caps;
      this.renderChecks();
      this.render();
    });
  }

  private get s(): Session {
    return this.sessions[this.tab];
  }

  // ---------------------------------------------------------------- bindings
  private bindChrome(): void {
    const toggle = $('nav-toggle');
    const nav = $('nav');
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    nav.querySelectorAll('a').forEach((a) =>
      a.addEventListener('click', () => {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }),
    );

    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'));
    tabs.forEach((btn, i) => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab as Tab));
      btn.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        next.focus();
        this.switchTab(next.dataset.tab as Tab);
      });
    });
  }

  private bindFiles(): void {
    const input = $<HTMLInputElement>('file-input');
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.value = '';
      if (file) void this.handleFile(file);
    });
    const openPicker = () => {
      if (this.client.busy) return;
      input.click();
    };
    $('pick-btn').addEventListener('click', openPicker);
    $('replace-btn').addEventListener('click', openPicker);

    const viewport = $('viewport');
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files'));

    // Stop the browser from navigating to a file that is dropped outside the drop area.
    window.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });

    let depth = 0;
    viewport.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      depth++;
      viewport.classList.add('dragging');
    });
    viewport.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) viewport.classList.remove('dragging');
    });
    viewport.addEventListener('drop', (e) => {
      depth = 0;
      viewport.classList.remove('dragging');
      const file = e.dataTransfer?.files?.[0];
      if (file && !this.client.busy) void this.handleFile(file);
    });
  }

  private bindInspector(): void {
    const inspector = document.querySelector('.inspector') as HTMLElement;
    const onChange = () => {
      const q = $<HTMLInputElement>('img-quality');
      $('img-quality-out').textContent = q.value;
      $('img-quality-row').hidden = readRadio('format') === 'png';
      this.saveSettings();
      this.render();
    };
    inspector.addEventListener('change', onChange);
    inspector.addEventListener('input', (e) => {
      if ((e.target as HTMLElement).id === 'img-quality') onChange();
    });
  }

  private bindActions(): void {
    $('start-btn').addEventListener('click', () => this.start());
    $('cancel-btn').addEventListener('click', () => this.cancel());
    $('remove-btn').addEventListener('click', () => this.resetSession(this.tab));
    $('again-btn').addEventListener('click', () => this.resetSession(this.tab));
    $('err-new').addEventListener('click', () => {
      this.resetSession(this.tab);
      $<HTMLInputElement>('file-input').click();
    });
    $('err-retry').addEventListener('click', () => {
      const s = this.s;
      if (s.file) {
        s.phase = 'selected';
        s.error = null;
        this.start();
      }
    });
  }

  // ---------------------------------------------------------------- settings
  private readSettings(): Settings {
    return {
      model: { size: (readRadio('size') || 'medium') as ModelSize, content: (readRadio('content') || 'rl') as ModelContent },
      vquality: (readRadio('vquality') || 'standard') as VideoQuality,
      keepAudio: $<HTMLInputElement>('keep-audio').checked,
      scale: (Number(readRadio('scale')) === 4 ? 4 : 2) as ImageScale,
      format: (readRadio('format') || 'png') as ImageFormat,
      imgQuality: Number($<HTMLInputElement>('img-quality').value) / 100,
    };
  }

  private saveSettings(): void {
    try {
      const s = this.readSettings();
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ content: s.model.content, size: s.model.size, vquality: s.vquality, keepAudio: s.keepAudio, format: s.format, imgQuality: Math.round(s.imgQuality * 100) }),
      );
    } catch {
      /* storage can be unavailable (private mode); settings simply do not persist */
    }
  }

  private restoreSettings(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const v = JSON.parse(raw) as Record<string, unknown>;
      if (typeof v.content === 'string') setRadio('content', v.content);
      if (typeof v.size === 'string') setRadio('size', v.size);
      if (typeof v.vquality === 'string') setRadio('vquality', v.vquality);
      if (typeof v.format === 'string') setRadio('format', v.format);
      if (typeof v.keepAudio === 'boolean') $<HTMLInputElement>('keep-audio').checked = v.keepAudio;
      if (typeof v.imgQuality === 'number') $<HTMLInputElement>('img-quality').value = String(v.imgQuality);
    } catch {
      /* ignore corrupted storage */
    }
    $('img-quality-out').textContent = $<HTMLInputElement>('img-quality').value;
    $('img-quality-row').hidden = readRadio('format') === 'png';
  }

  // ---------------------------------------------------------------- tabs
  private switchTab(tab: Tab): void {
    if (tab === this.tab) return;
    if (this.client.busy) {
      this.toast('Wait for the current job to finish, or cancel it, before switching.');
      return;
    }
    this.tab = tab;
    this.render();
  }

  // ---------------------------------------------------------------- files
  private async handleFile(file: File): Promise<void> {
    if (this.client.busy) return;

    const kind = detectKind(file, CONFIG.video.extensions, CONFIG.image.extensions);
    if (kind && kind !== this.tab) this.tab = kind;
    const tab = this.tab;
    const rules = tab === 'video' ? CONFIG.video : CONFIG.image;

    this.resetSession(tab, false);
    const session = this.sessions[tab];

    const check = validateFile(file, { extensions: rules.extensions, mimeTypes: rules.mimeTypes, maxBytes: rules.maxFileBytes });
    if (!check.ok) {
      return this.fail(tab, { title: 'This file is not supported', message: check.message, retryable: false });
    }

    try {
      if (tab === 'video') {
        const meta = await probeVideo(file);
        session.sourceUrl = meta.url;
        session.width = meta.width;
        session.height = meta.height;
        session.duration = meta.duration;
      } else {
        const meta = await probeImage(file);
        session.sourceUrl = meta.url;
        session.width = meta.width;
        session.height = meta.height;
      }
    } catch {
      return this.fail(tab, {
        title: tab === 'video' ? 'This video could not be read' : 'This image could not be read',
        message:
          tab === 'video'
            ? 'Your browser could not open this video to read its size and length.'
            : 'Your browser could not decode this image.',
        hint:
          tab === 'video'
            ? 'The file may be damaged, or use a codec this browser cannot play (HEVC/H.265 is a common cause). Try an H.264 MP4.'
            : 'The file may be damaged. Try saving it again as PNG or JPEG.',
        retryable: false,
      });
    }

    session.file = file;
    session.phase = 'selected';
    this.mountSelected(tab);
    this.render();
  }

  private mountSelected(tab: Tab): void {
    const s = this.sessions[tab];
    if (!s.file || !s.sourceUrl) return;
    $('sel-name').textContent = s.file.name;
    const chips = $('sel-chips');
    clear(chips);
    const add = (t: string) => chips.append(el('li', { text: t }));
    add(`${formatResolution(s.width, s.height)} (${resolutionLabel(s.width, s.height)})`);
    if (tab === 'video') add(s.duration > 0 ? formatDuration(s.duration) : 'Length unknown');
    add(formatBytes(s.file.size));
    const stage = $('sel-stage');
    // render() runs on every settings change; only rebuild the preview when the file changed,
    // otherwise changing a radio button would restart the preview video.
    if (stage.dataset.url === s.sourceUrl && stage.dataset.tab === tab) return;
    stage.dataset.url = s.sourceUrl;
    stage.dataset.tab = tab;
    clear(stage);
    if (tab === 'video') {
      const v = el('video', { attrs: { controls: '', playsinline: '', preload: 'metadata', 'aria-label': 'Preview of the selected video' } });
      v.src = s.sourceUrl;
      stage.append(v);
    } else {
      stage.append(el('img', { attrs: { alt: 'Preview of the selected image', src: s.sourceUrl } }));
    }
  }

  private resetSession(tab: Tab, rerender = true): void {
    const s = this.sessions[tab];
    s.compare?.destroy();
    if (s.sourceUrl) URL.revokeObjectURL(s.sourceUrl);
    if (s.resultUrl) URL.revokeObjectURL(s.resultUrl);
    this.sessions[tab] = newSession();
    if (tab === this.tab) {
      clear($('sel-stage'));
      delete $('sel-stage').dataset.url;
      clear($('done-stage'));
    }
    if (rerender) this.render();
  }

  private fail(tab: Tab, error: ErrorView): void {
    const s = this.sessions[tab];
    s.phase = 'error';
    s.error = error;
    this.render();
  }

  // ---------------------------------------------------------------- analysis
  private analyze(): Analysis {
    const s = this.s;
    const caps = this.caps;
    const set = this.readSettings();
    const notes: Analysis['notes'] = [];
    const none: Analysis = { rows: [], notes, canStart: false, hint: 'Choose a file to begin.' };
    if (!s.file || (s.phase !== 'selected' && s.phase !== 'processing')) return none;

    const rows: Array<[string, string]> = [['Source', `${formatResolution(s.width, s.height)} (${resolutionLabel(s.width, s.height)})`]];
    let blocked: string | null = null;
    const block = (text: string) => {
      notes.push({ text, tone: 'block' });
      blocked ??= text;
    };

    if (caps && ((this.tab === 'video' && !caps.canUpscaleVideo) || (this.tab === 'image' && !caps.canUpscaleImages))) {
      const why = !caps.webgpu.ok
        ? 'This browser does not support WebGPU, which the AI model needs. Use the latest desktop Chrome or Edge.'
        : this.tab === 'video' && !caps.video.ok
          ? `Video processing needs WebCodecs with H.264 encoding (${caps.video.detail.toLowerCase()}). Use the latest desktop Chrome or Edge.`
          : 'This browser is missing a feature the upscaler needs (workers or OffscreenCanvas).';
      block(why);
    }
    if (caps?.softwareGpu) notes.push({ text: 'Your browser reports a software (CPU) graphics adapter. Processing will be very slow.', tone: 'warn' });

    if (this.tab === 'video') {
      const plan = planVideoOutput(s.width, s.height);
      if (!plan.ok) {
        block(plan.reason);
        return { rows, notes, canStart: false, hint: blocked ?? plan.reason };
      }
      const p = plan.plan;
      rows.push(['Output', `${formatResolution(p.outW, p.outH)} (${resolutionLabel(p.outW, p.outH)})`]);
      rows.push(['Method', p.mode === 'native-2x' ? 'AI 2x' : 'AI 2x, then resized to fit 1080p']);

      const limit = caps?.lowMemory ? CONFIG.video.maxOutputBytesLowMemory : CONFIG.video.maxOutputBytes;
      if (s.duration > 0) {
        const est = estimateVideoOutputBytes(p.outW, p.outH, CONFIG.video.assumedFps, s.duration, set.vquality, set.keepAudio);
        rows.push(['Estimated file', `about ${formatBytes(est)}`]);
        if (est > limit) block(`The result would be about ${formatBytes(est)}, above the ${formatBytes(limit)} this device can hold in memory. Use a shorter clip.`);
        if (s.duration > CONFIG.video.maxDurationSec) block(`This video is ${formatDuration(s.duration)} long. The limit is ${formatDuration(CONFIG.video.maxDurationSec)}.`);
      } else {
        notes.push({ text: 'This file does not declare its length, so the time estimate will be approximate.', tone: 'info' });
      }
      if (caps?.phone) notes.push({ text: 'Phones have far less GPU power and memory than a desktop. Short clips work best.', tone: 'warn' });
      if (p.mode === 'fit') notes.push({ text: 'The AI output (2x) is larger than 1080p, so each frame is resized down to 1080p before encoding.', tone: 'info' });
    } else {
      const options = imageScaleOptions(s.width, s.height);
      for (const o of options) setRadioDisabled('scale', String(o.scale), !o.available, o.reason ?? '');
      let scale = set.scale;
      if (!options.find((o) => o.scale === scale)?.available) {
        const alt = options.find((o) => o.available);
        if (alt) {
          scale = alt.scale;
          setRadio('scale', String(alt.scale));
        }
      }
      $('scale-help').textContent = options.every((o) => o.available)
        ? '4x runs the 2x network twice.'
        : (options.find((o) => !o.available)?.reason ?? '');

      const plan = planImageOutput(s.width, s.height, scale);
      if (!plan.ok) {
        block(plan.reason);
        return { rows, notes, canStart: false, hint: blocked ?? plan.reason };
      }
      const p = plan.plan;
      rows.push(['Output', `${formatResolution(p.outW, p.outH)} (${resolutionLabel(p.outW, p.outH)})`]);
      rows.push(['Method', p.passes === 1 ? 'AI 2x, one pass' : 'AI 2x applied twice (4x)']);
      rows.push(['Format', set.format === 'png' ? 'PNG (lossless)' : `${set.format.toUpperCase()} at ${Math.round(set.imgQuality * 100)}`]);

      if (caps?.maxTextureDimension && Math.max(p.outW, p.outH) > caps.maxTextureDimension) {
        block(`This output is ${Math.max(p.outW, p.outH)}px on its longest side, above your GPU's limit of ${caps.maxTextureDimension}px.`);
      }
      const load = imageLoadLevel(p.outW, p.outH);
      if (load !== 'normal') {
        notes.push({
          text:
            load === 'very-heavy'
              ? 'This is a very large output. It needs a lot of GPU memory and may take a while. A desktop GPU is recommended.'
              : 'This is a large output and will use a lot of GPU memory.',
          tone: 'warn',
        });
      }
      if (caps?.phone && load !== 'normal') notes.push({ text: 'Large outputs often fail on phones. Try 2x or a smaller image if the tab reloads.', tone: 'warn' });
      if (set.format === 'png' && p.outW * p.outH >= 24_000_000) notes.push({ text: 'An 8K PNG can be larger than 50 MB. JPEG or WebP gives a much smaller file.', tone: 'info' });
      notes.push({ text: 'Transparent areas are not preserved.', tone: 'info' });
    }

    if (this.client.busy) return { rows, notes, canStart: false, hint: 'A job is already running.' };
    return { rows, notes, canStart: !blocked, hint: blocked ?? 'Ready. Processing happens on this device.' };
  }

  // ---------------------------------------------------------------- render
  private render(): void {
    const s = this.s;
    const tab = this.tab;

    // tabs
    document.querySelectorAll<HTMLButtonElement>('.tab').forEach((btn) => {
      const active = btn.dataset.tab === tab;
      btn.setAttribute('aria-selected', String(active));
      btn.tabIndex = active ? 0 : -1;
    });
    const studio = $('studio');
    studio.dataset.tab = tab;
    studio.setAttribute('aria-labelledby', `tab-${tab}`);

    // empty-state copy per tab
    const rules = tab === 'video' ? CONFIG.video : CONFIG.image;
    $('drop-title').textContent = tab === 'video' ? 'Drop a video here' : 'Drop an image here';
    $('drop-sub').textContent =
      tab === 'video'
        ? `MP4, MOV, WebM or MKV, up to ${formatBytes(CONFIG.video.maxFileBytes)}. Works on videos smaller than 1080p.`
        : `PNG, JPEG or WebP, up to ${formatBytes(CONFIG.image.maxFileBytes)}. Output up to 8K.`;
    $('pick-btn').textContent = tab === 'video' ? 'Choose video' : 'Choose image';
    $<HTMLInputElement>('file-input').accept = [...rules.extensions, ...rules.mimeTypes].join(',');

    // viewport state
    const states: Record<Phase, string> = {
      empty: 'st-empty',
      selected: 'st-selected',
      processing: 'st-processing',
      done: 'st-done',
      error: 'st-error',
    };
    for (const [phase, id] of Object.entries(states)) $(id).hidden = phase !== s.phase;
    $('viewport').dataset.state = s.phase;

    // keep the selected preview in step with the active tab
    if (s.phase === 'selected') this.mountSelected(tab);
    if (s.phase === 'done' && s.compare) {
      const host = $('done-stage');
      if (!host.contains(s.compare.root)) {
        clear(host);
        host.append(s.compare.root);
      }
    }
    if (s.phase === 'error' && s.error) {
      $('err-title').textContent = s.error.title;
      $('err-msg').textContent = s.error.message;
      $('err-hint').textContent = s.error.hint ?? '';
      $('err-hint').hidden = !s.error.hint;
      $('err-retry').hidden = !s.error.retryable;
    }

    // inspector
    const busy = this.client.busy;
    document.querySelectorAll<HTMLInputElement>('.inspector input').forEach((i) => {
      if (i.name === 'scale') return; // availability is handled per image below
      i.disabled = busy;
    });
    const a = this.analyze();
    fillDl($('summary'), a.rows);
    $('summary').hidden = a.rows.length === 0;
    fillNotes($('notes'), a.notes);
    const start = $<HTMLButtonElement>('start-btn');
    start.disabled = !a.canStart || s.phase !== 'selected';
    start.textContent = tab === 'video' ? 'Start upscaling' : 'Enhance image';
    $('start-hint').textContent = s.phase === 'selected' ? a.hint : s.phase === 'processing' ? 'Processing on this device.' : s.phase === 'done' ? 'Done. Process another file to continue.' : 'Choose a file to begin.';
    if (busy) document.querySelectorAll<HTMLInputElement>('.inspector input[name="scale"]').forEach((i) => (i.disabled = true));

    // tabs are locked while a job runs
    document.querySelectorAll<HTMLButtonElement>('.tab').forEach((btn) => btn.setAttribute('aria-disabled', String(busy && btn.dataset.tab !== tab)));
  }

  private renderChecks(): void {
    const caps = this.caps;
    if (!caps) return;
    const list = $('checks');
    clear(list);
    const item = (name: string, check: { ok: boolean; detail: string }, warn = false) =>
      list.append(
        el('li', { className: 'check', attrs: { 'data-state': check.ok ? (warn ? 'warn' : 'ok') : 'bad' } }, [
          el('span', { className: 'dot', attrs: { 'aria-hidden': 'true' } }),
          el('span', { className: 'check-name', text: name }),
          el('span', { className: 'check-detail', text: check.detail }),
        ]),
      );
    item('WebGPU', caps.webgpu, caps.softwareGpu);
    item('Video codecs', caps.video);
  }

  // ---------------------------------------------------------------- processing
  private start(): void {
    const tab = this.tab;
    const s = this.s;
    if (!s.file || s.phase !== 'selected' || this.client.busy) return;
    const a = this.analyze();
    if (!a.canStart) return;

    const set = this.readSettings();
    const jobId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const baseUrl = new URL('.', document.baseURI).href;

    let request: VideoJobRequest | ImageJobRequest;
    let aspect = `${s.width} / ${s.height}`;
    if (tab === 'video') {
      const plan = planVideoOutput(s.width, s.height);
      if (!plan.ok) return;
      request = {
        type: 'video',
        jobId,
        file: s.file,
        baseUrl,
        model: set.model,
        srcW: s.width,
        srcH: s.height,
        outW: plan.plan.outW,
        outH: plan.plan.outH,
        quality: set.vquality,
        keepAudio: set.keepAudio,
        durationHint: s.duration,
      };
      aspect = `${plan.plan.outW} / ${plan.plan.outH}`;
    } else {
      request = { type: 'image', jobId, file: s.file, baseUrl, model: set.model, scale: set.scale, format: set.format, quality: set.imgQuality };
    }

    this.resetProgressUi(tab, aspect);
    s.phase = 'processing';
    this.processingTab = tab;
    const started = this.client.start(request, (msg) => this.onWorker(tab, msg));
    if (!started) {
      s.phase = 'selected';
      return;
    }
    void this.lockScreen();
    this.render();
    this.announce('Processing started');
  }

  private cancel(): void {
    if (!this.client.busy) return;
    this.client.cancel();
    this.unlockScreen();
    const tab = this.processingTab ?? this.tab;
    this.processingTab = null;
    this.sessions[tab].phase = 'selected';
    this.render();
    this.toast('Cancelled. Nothing was saved.');
  }

  private resetProgressUi(tab: Tab, aspect: string): void {
    const stage = $('live-stage');
    stage.style.aspectRatio = aspect;
    const [aw, ah] = aspect.split('/').map((n) => Number(n.trim()));
    stage.style.setProperty('--ar', String(aw / ah));
    const canvas = $<HTMLCanvasElement>('live');
    const img = $<HTMLImageElement>('live-img');
    canvas.hidden = tab !== 'video';
    img.hidden = tab !== 'image';
    if (tab === 'image') img.src = this.sessions.image.sourceUrl ?? '';
    else {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
    $('live-caption').textContent = tab === 'video' ? 'Waiting for the first enhanced frame' : 'Your original, enhancing now';
    $('stage-label').textContent = 'Starting';
    $('pct').textContent = '0%';
    this.setRatio(0, '');
    $('stat-frames-label').textContent = tab === 'video' ? 'Frames' : 'Step';
    $('stat-speed-label').textContent = tab === 'video' ? 'Speed' : 'Passes';
    $('stat-frames').textContent = '0';
    $('stat-elapsed').textContent = '0:00';
    $('stat-speed').textContent = '-';
    $('stat-eta').textContent = 'Measuring';
  }

  private setRatio(ratio: number, valueText: string): void {
    const r = Math.min(Math.max(ratio, 0), 1);
    const pct = Math.round(r * 100);
    $('rail-fill').style.transform = `scaleX(${r})`;
    const rail = $('rail');
    rail.setAttribute('aria-valuenow', String(pct));
    rail.setAttribute('aria-valuetext', valueText || `${pct} percent`);
    $('pct').textContent = `${pct}%`;
  }

  private onWorker(tab: Tab, msg: WorkerToMain): void {
    switch (msg.type) {
      case 'stage': {
        const labels: Record<string, string> = {
          'loading-model': 'Loading the AI model',
          analyzing: 'Reading your file',
          enhancing: tab === 'video' ? 'Enhancing and encoding frames' : 'Enhancing the image',
          finalizing: 'Finalizing the file',
        };
        const text = `${labels[msg.stage] ?? msg.stage}${msg.detail ? `, ${msg.detail.toLowerCase()}` : ''}`;
        $('stage-label').textContent = text;
        this.announce(text);
        break;
      }
      case 'progress': {
        const elapsed = msg.elapsedMs;
        if (tab === 'video') {
          const total = msg.framesTotal ?? null;
          const done = msg.framesDone ?? 0;
          $('stat-frames').textContent = total ? `${done} of ${msg.framesTotalExact ? '' : 'about '}${total}` : String(done);
          $('stat-speed').textContent = msg.fps ? `${msg.fps.toFixed(1)} fps` : '-';
          this.setRatio(msg.ratio, total ? `${Math.round(msg.ratio * 100)} percent, ${done} frames processed` : '');
        } else {
          $('stat-frames').textContent = `${msg.step ?? 0} of ${msg.steps ?? 0}`;
          $('stat-speed').textContent = String(Math.max(1, (msg.steps ?? 3) - 2));
          this.setRatio(msg.ratio, `Step ${msg.step ?? 0} of ${msg.steps ?? 0}`);
        }
        $('stat-elapsed').textContent = formatDuration(elapsed / 1000);
        const remaining = estimateRemainingSeconds(msg.ratio, elapsed);
        $('stat-eta').textContent = remaining === null ? 'Measuring' : `about ${formatDuration(remaining)}`;
        break;
      }
      case 'preview': {
        const canvas = $<HTMLCanvasElement>('live');
        canvas.width = msg.bitmap.width;
        canvas.height = msg.bitmap.height;
        canvas.getContext('2d')?.drawImage(msg.bitmap, 0, 0);
        msg.bitmap.close();
        $('live-caption').textContent = 'Live preview of an enhanced frame';
        break;
      }
      case 'video-done':
      case 'image-done':
        void this.finish(tab, msg);
        break;
      case 'error': {
        this.unlockScreen();
        this.processingTab = null;
        console.error('[zafronix]', msg.code, msg.message);
        this.fail(tab, {
          title: ERROR_TITLES[msg.code] ?? ERROR_TITLES.unknown,
          message: msg.message,
          hint: msg.hint,
          retryable: msg.code !== 'invalid-input' && msg.code !== 'webgpu-unavailable' && msg.code !== 'rotation-unsupported' && msg.code !== 'codec-unsupported',
        });
        break;
      }
      default:
        break;
    }
  }

  private async finish(tab: Tab, msg: Extract<WorkerToMain, { type: 'video-done' | 'image-done' }>): Promise<void> {
    this.unlockScreen();
    this.processingTab = null;
    const s = this.sessions[tab];
    if (!s.file || !s.sourceUrl) return;

    const info = msg.info;
    const url = URL.createObjectURL(msg.blob);
    s.resultUrl = url;

    // Verify the result with the browser's own decoder: real dimensions, not assumed ones.
    const verified = await (msg.type === 'video-done' ? this.verifyVideo(url) : this.verifyImage(url));
    const expected = formatResolution(info.width, info.height);
    const notes: Analysis['notes'] = [];
    if (verified === null) {
      notes.push({ text: 'Your browser could not open the result for preview. The file may still play in other apps, but it is not verified.', tone: 'warn' });
    } else if (verified.width !== info.width || verified.height !== info.height) {
      notes.push({ text: `Expected ${expected} but the browser reports ${formatResolution(verified.width, verified.height)}.`, tone: 'warn' });
    } else {
      notes.push({ text: `Verified: your browser opened the result at ${expected}.`, tone: 'info' });
    }

    const label = resolutionLabel(info.width, info.height);
    const isVideo = msg.type === 'video-done';
    const ext = isVideo ? 'mp4' : (this.readSettings().format === 'jpeg' ? 'jpg' : this.readSettings().format);
    const name = outputFileName(s.file.name, `zafronix-${label}`, ext, isVideo ? 'video' : 'image');

    s.compare?.destroy();
    s.compare = createCompare({
      kind: isVideo ? 'video' : 'image',
      beforeUrl: s.sourceUrl,
      afterUrl: url,
      width: info.width,
      height: info.height,
      beforeLabel: `Original ${formatResolution(s.width, s.height)}`,
      afterLabel: `Enhanced ${expected}`,
    });

    // stats
    const rows: Array<[string, string]> = [
      ['Output size', `${expected} (${label})`],
      ['File size', formatBytes(info.bytes)],
    ];
    if (msg.type === 'video-done') {
      const v = msg.info;
      rows.push(['Duration', v.durationSec > 0 ? formatDuration(v.durationSec) : '-']);
      rows.push(['Frames', String(v.framesDone)]);
      rows.push(['Audio', v.hasAudio ? 'Kept, copied unchanged' : 'None']);
      if (v.audioNote) notes.push({ text: v.audioNote, tone: 'warn' });
    } else {
      rows.push(['Method', msg.info.passes === 1 ? 'AI 2x, one pass' : 'AI 2x applied twice']);
    }
    rows.push(['Time taken', formatDuration(info.elapsedMs / 1000)]);
    fillDl($('done-stats'), rows);
    fillNotes($('done-notes'), notes);

    const dl = $<HTMLAnchorElement>('download-btn');
    dl.href = url;
    dl.download = name;
    $('download-label').textContent = `Download ${isVideo ? 'MP4' : ext.toUpperCase()} (${formatBytes(info.bytes)})`;
    const full = $<HTMLAnchorElement>('open-full');
    full.hidden = isVideo;
    full.href = url;

    this.wireVideoControls(s.compare, isVideo, isVideo ? (msg as Extract<WorkerToMain, { type: 'video-done' }>).info.hasAudio : false);

    s.phase = 'done';
    this.render();
    this.announce('Done. Your enhanced file is ready to download.');
  }

  private wireVideoControls(compare: CompareHandle, isVideo: boolean, hasAudio: boolean): void {
    const bar = $('done-controls');
    bar.hidden = !isVideo;
    if (!isVideo || !compare.video) return;
    const ctl = compare.video;
    const play = $<HTMLButtonElement>('play-btn');
    const scrub = $<HTMLInputElement>('scrub');
    const time = $('time-text');
    const mute = $<HTMLButtonElement>('mute-btn');
    let scrubbing = false;

    play.onclick = () => ctl.toggle();
    scrub.oninput = () => {
      scrubbing = true;
      ctl.seekRatio(Number(scrub.value) / 1000);
    };
    scrub.onchange = () => (scrubbing = false);
    mute.hidden = !hasAudio;
    mute.setAttribute('aria-pressed', 'false');
    mute.onclick = () => mute.setAttribute('aria-pressed', String(ctl.toggleMute()));

    ctl.onState(({ playing, current, duration }) => {
      play.dataset.playing = String(playing);
      play.setAttribute('aria-label', playing ? 'Pause both videos' : 'Play both videos');
      time.textContent = `${formatDuration(current)} / ${formatDuration(duration)}`;
      if (!scrubbing && duration > 0) scrub.value = String(Math.round((current / duration) * 1000));
    });
  }

  private verifyVideo(url: string): Promise<{ width: number; height: number } | null> {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      const done = (r: { width: number; height: number } | null) => {
        window.clearTimeout(timer);
        v.removeAttribute('src');
        v.load();
        resolve(r);
      };
      const timer = window.setTimeout(() => done(null), 15000);
      v.onloadedmetadata = () => done(v.videoWidth ? { width: v.videoWidth, height: v.videoHeight } : null);
      v.onerror = () => done(null);
      v.src = url;
    });
  }

  private async verifyImage(url: string): Promise<{ width: number; height: number } | null> {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
      return { width: img.naturalWidth, height: img.naturalHeight };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- helpers
  private async lockScreen(): Promise<void> {
    try {
      this.wakeLock = await (navigator as any).wakeLock?.request('screen');
    } catch {
      this.wakeLock = null;
    }
  }

  private unlockScreen(): void {
    try {
      void this.wakeLock?.release();
    } catch {
      /* ignore */
    }
    this.wakeLock = null;
  }

  private announce(text: string): void {
    const live = document.getElementById('live-status');
    if (live) live.textContent = text;
  }

  private toast(text: string): void {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (t.hidden = true), 5000);
  }
}

export function boot(): void {
  new App().init();
}
