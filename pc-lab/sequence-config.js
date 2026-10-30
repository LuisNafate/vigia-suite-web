window.VIGIA_SEQUENCE = Object.freeze({
  frameCount: 192, width: 1280, height: 720, fps: 24, duration: 8,
  desktopDirectory: "product-sequence/desktop", mobileDirectory: "product-sequence/mobile",
  prefix: "frame-", extension: "webp", padding: 4,
  getFramePath(index, mobile = false) {
    const safe = Math.max(0, Math.min(this.frameCount - 1, index));
    return `${mobile ? this.mobileDirectory : this.desktopDirectory}/${this.prefix}${String(safe + 1).padStart(this.padding, "0")}.${this.extension}`;
  }
});
