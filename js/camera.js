// The phone camera: live preview for the checks, full-size stills from ImageCapture.takePhoto().
// Preview frames are only about 1080p; the still is the camera's own photo (the most Chrome is offered - often
// about 12 MP even on a 50 MP phone; the phone's own camera app can do more, see the camera-app mode in main.js).

function waitForSize(video) {
  if (video.videoWidth) return Promise.resolve();
  return new Promise((res) => {
    const done = () => { if (video.videoWidth) { video.removeEventListener('resize', done); video.removeEventListener('loadedmetadata', done); res(); } };
    video.addEventListener('resize', done);
    video.addEventListener('loadedmetadata', done);
  });
}

export async function listCameras() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    // Before the camera is first allowed, Chrome hides ids and names: list nothing rather than blanks.
    return all.filter((d) => d.kind === 'videoinput' && d.deviceId).map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  } catch { return []; }
}

export class Camera {
  constructor() { this.stream = null; this.track = null; this.ic = null; this.photoCaps = null; this.video = null; this.lastPhotoError = ''; }

  async start(video, deviceId) {
    this.stop();
    const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    const video_c = deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: { ideal: 'environment' }, ...size };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: video_c });
    this.track = this.stream.getVideoTracks()[0];
    try {
      const caps = (this.track.getCapabilities && this.track.getCapabilities()) || {};
      const adv = {};
      for (const k of ['focusMode', 'exposureMode', 'whiteBalanceMode']) if ((caps[k] || []).includes('continuous')) adv[k] = 'continuous';
      if (Object.keys(adv).length) await this.track.applyConstraints({ advanced: [adv] });
    } catch { /* not every camera takes these */ }
    this.ic = null; this.photoCaps = null;
    if ('ImageCapture' in self) {
      try { this.ic = new ImageCapture(this.track); this.photoCaps = await this.ic.getPhotoCapabilities(); } catch { this.photoCaps = null; }
    }
    video.muted = true; video.playsInline = true; video.srcObject = this.stream;
    await video.play().catch(() => {});
    await waitForSize(video);
    this.video = video;
    return this.info();
  }

  // Reuse the running camera for the next photo screen (saves a restart between steps).
  async attach(video) {
    video.muted = true; video.playsInline = true; video.srcObject = this.stream;
    await video.play().catch(() => {});
    await waitForSize(video);
    this.video = video;
  }

  info() {
    const s = (this.track && this.track.getSettings && this.track.getSettings()) || {};
    const pc = this.photoCaps;
    return {
      label: (this.track && this.track.label) || '',
      preview: `${this.video ? this.video.videoWidth : s.width}x${this.video ? this.video.videoHeight : s.height}`,
      still: pc && pc.imageWidth ? `up to ${pc.imageWidth.max}x${pc.imageHeight.max}` : (this.ic ? 'ImageCapture' : 'video frame only'),
    };
  }

  stop() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    if (this.video) this.video.srcObject = null;
    this.stream = null; this.track = null; this.ic = null; this.video = null;
  }

  get live() { return !!(this.track && this.track.readyState === 'live'); }

  // { blob, via } - via 'imagecapture' for a real still, 'video frame' when the browser cannot take one.
  // full: the largest still the camera offers to Chrome (reading photos); otherwise about 4,000 px (proof photos).
  async takePhoto({ full = false } = {}) {
    if (this.ic) {
      try {
        const pc = this.photoCaps || {}, settings = {};
        if ((pc.fillLightMode || []).includes('off')) settings.fillLightMode = 'off';   // SOP: no flash
        if (pc.imageWidth && pc.imageWidth.max) {
          // 4:3 (the sensor's own shape); never more than the camera offers.
          const w = full ? pc.imageWidth.max : Math.min(pc.imageWidth.max, 4080);
          settings.imageWidth = w;
          settings.imageHeight = full ? pc.imageHeight.max : Math.min(pc.imageHeight.max, Math.round((w * 3) / 4));
        }
        const blob = await this.ic.takePhoto(settings);
        if (blob && blob.size > 0) return { blob, via: 'imagecapture' };
      } catch (e) { this.lastPhotoError = String((e && e.message) || e); }
    }
    const v = this.video, c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
    return { blob, via: 'video frame' };
  }
}
