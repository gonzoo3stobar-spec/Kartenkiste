// Live hint "Karte erkannt" on the camera preview: searchCard (detect.js) on a small copy of the current frame,
// a few times per second, with the outline drawn over the video. Against failed scans on busy backgrounds: the user sees
// before the shot whether the card border is found. Never runs while a scan is being recognised (one WASM thread).

import { searchCard, findInGuide, guideRect } from './detect.js';

const SIDE = 960;            // long side of the analysed frame (detect.js works at <= 1000 px anyway)
const MIN_GAP = 250;         // ms between two searches at least
const STABLE = 2;            // frames in a row with a card before "erkannt"

export class LiveHint {
  /** video: <video>, overlay: <canvas> over it, onState(state) with state = 'found' | 'searching' | 'idle' */
  constructor(video, overlay, onState) {
    this.video = video; this.overlay = overlay; this.onState = onState;
    this.cv = null; this.running = false; this.paused = false; this.timer = 0;
    this.canvas = document.createElement('canvas');
    this.hits = 0; this.state = 'idle'; this.lastMs = 0; this.quad = null;
    this.ticks = 0; this.found = 0; this.errors = 0; this.lastError = null; this.frame = null;   // for the test logs
  }
  start(cv) { this.cv = cv; if (this.running || new URLSearchParams(location.search).get('nolive')) return; this.running = true; this.loop(); }
  stop() { this.running = false; clearTimeout(this.timer); this.draw(null); this.set('idle'); }
  pause(p) { this.paused = p; if (p) this.draw(null); }
  stats() { return { state: this.state, running: this.running, paused: this.paused, ticks: this.ticks, found: this.found, errors: this.errors, lastError: this.lastError, lastMs: Math.round(this.lastMs), frame: this.frame }; }
  set(s) { if (s !== this.state) { this.state = s; this.onState(s); } }

  loop() {
    if (!this.running) return;
    const t0 = performance.now();
    if (!this.paused && this.cv && this.video.videoWidth && !document.hidden) {
      try { this.tick(); this.ticks++; } catch (e) { this.errors++; this.lastError = String(e?.message || e); console.warn('live hint', e); }
    }
    this.lastMs = performance.now() - t0;
    // leave the phone most of the time for the camera and the UI
    this.timer = setTimeout(() => this.loop(), Math.max(MIN_GAP, 3 * this.lastMs));
  }

  tick() {
    const { cv, video: v } = this;
    const fw = v.videoWidth, fh = v.videoHeight, sc = Math.min(1, SIDE / Math.max(fw, fh));
    const w = Math.round(fw * sc), h = Math.round(fh * sc);
    const c = this.canvas;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(v, 0, 0, w, h);
    const src = cv.matFromImageData(g.getImageData(0, 0, w, h));
    let quad = null;
    // the same two contour attempts as the scan (detectCard): whole frame, then the guide area alone
    try { const guide = guideRect(w, h); quad = searchCard(cv, src, { guide }).quad || findInGuide(cv, src, guide); } finally { src.delete(); }
    this.frame = `${w}x${h}`;
    if (quad) {
      this.found++;
      this.hits++;
      this.quad = quad.map(([x, y]) => [x / w, y / h]);   // frame fractions
    } else { this.hits = 0; this.quad = null; }
    const found = this.hits >= STABLE;
    this.draw(this.quad, found);
    this.set(found ? 'found' : 'searching');
  }

  /** outline over the cover-fitted video */
  draw(quad, found = false) {
    const o = this.overlay, v = this.video;
    const box = v.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const W = Math.round(box.width * dpr), H = Math.round(box.height * dpr);
    if (o.width !== W || o.height !== H) { o.width = W; o.height = H; }
    const g = o.getContext('2d');
    g.clearRect(0, 0, W, H);
    if (!quad || !v.videoWidth) return;
    const fw = v.videoWidth, fh = v.videoHeight, sc = Math.max(W / fw, H / fh);
    const ox = (W - fw * sc) / 2, oy = (H - fh * sc) / 2;
    g.beginPath();
    quad.forEach(([x, y], i) => { const px = ox + x * fw * sc, py = oy + y * fh * sc; i ? g.lineTo(px, py) : g.moveTo(px, py); });
    g.closePath();
    g.lineWidth = 4 * dpr;
    g.strokeStyle = found ? '#4caf50' : 'rgba(255,255,255,0.55)';
    g.stroke();
  }
}
