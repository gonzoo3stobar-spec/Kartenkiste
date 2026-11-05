// Platform-neutral capture sizing. Device memory is only a coarse initial hint;
// measured buffer-copy cost and allocation failures adapt it in both directions.
const MIN_PIXELS = 1280 * 720;
export class CaptureQuality {
  constructor(memoryGB = null) {
    this.limit = Number.isFinite(memoryGB) && memoryGB > 0 ? Math.max(MIN_PIXELS, memoryGB * 1024 * 1024) : Infinity;
    this.fast = 0; this.slow = 0; this.cooldown = 0;
  }
  size(width, height) {
    const scale = Math.min(1, Math.sqrt(this.limit / (width * height)));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }
  lower(pixels) {
    if (pixels <= MIN_PIXELS * 1.05) return false;
    this.limit = Math.max(MIN_PIXELS, pixels / 2);
    this.fast = this.slow = 0; this.cooldown = 5;
    return true;
  }
  record(pixels, nativePixels, copyMs, confidence) {
    if (this.cooldown) this.cooldown--;
    if (copyMs > 300) {
      this.fast = 0;
      if (++this.slow >= 2 && pixels > MIN_PIXELS) {
        this.limit = Math.max(MIN_PIXELS, pixels * 0.75);
        this.slow = 0; this.cooldown = 5;
      }
    } else {
      this.slow = 0;
      this.fast = copyMs < 120 ? this.fast + 1 : 0;
      if (!this.cooldown && pixels < nativePixels && (this.fast >= 5 || (confidence !== 'high' && copyMs < 120))) {
        this.limit = Math.min(nativePixels, pixels * 1.25);
        this.fast = 0;
      }
    }
  }
}
