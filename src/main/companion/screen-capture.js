const screenshot = require('screenshot-desktop');
const sharp = require('sharp');
const { stagingBuffer } = require('./staging-buffer');
const { earconSynth } = require('../audio/earcon-synth');

const MIN_CROP_DIMENSION_PX = 30;

class ScreenCaptureEngine {
  constructor() {
    this.regionStartPoint = null; // { x, y }
    this.isRegionSelecting = false;
  }

  /**
   * Captures the full screen frame and appends it to the staging buffer.
   * Plays 1x Short Tut (880 Hz).
   * @returns {Promise<Buffer|null>}
   */
  async captureFullScreen() {
    try {
      const rawBuffer = await screenshot({ format: 'png' });
      const jpegBuffer = await sharp(rawBuffer)
        .jpeg({ quality: 85, progressive: true })
        .toBuffer();

      stagingBuffer.addImage(jpegBuffer);
      earconSynth.playShortTut();
      return jpegBuffer;
    } catch (_err) {
      earconSynth.playDoubleLowTut();
      return null;
    }
  }

  /**
   * Marks the start point (X1, Y1) of a dynamic blind region capture.
   * Called when L-CTRL + L-SHIFT hold timer reaches 1000ms.
   * Plays 1x Short Tut (880 Hz).
   * @param {{ x: number, y: number }} cursorCoords
   */
  startRegionSelection(cursorCoords) {
    this.regionStartPoint = { x: Math.round(cursorCoords.x), y: Math.round(cursorCoords.y) };
    this.isRegionSelecting = true;
    earconSynth.playShortTut();
  }

  /**
   * Completes the dynamic region capture upon releasing L-CTRL + L-SHIFT.
   * Validates dimensions (>= 30px), crops region via sharp, and appends to staging buffer.
   * @param {{ x: number, y: number }} cursorCoords
   * @returns {Promise<Buffer|null>}
   */
  async finishRegionSelection(cursorCoords) {
    if (!this.isRegionSelecting || !this.regionStartPoint) {
      this.cancelRegionSelection();
      return null;
    }

    const x1 = this.regionStartPoint.x;
    const y1 = this.regionStartPoint.y;
    const x2 = Math.round(cursorCoords.x);
    const y2 = Math.round(cursorCoords.y);

    this.regionStartPoint = null;
    this.isRegionSelecting = false;

    const deltaX = Math.abs(x2 - x1);
    const deltaY = Math.abs(y2 - y1);

    // Validation constraint: width and height must be >= 30px
    if (deltaX < MIN_CROP_DIMENSION_PX || deltaY < MIN_CROP_DIMENSION_PX) {
      // Discarded micro-crop: play 2x Low Tut
      earconSynth.playDoubleLowTut();
      return null;
    }

    try {
      const rawBuffer = await screenshot({ format: 'png' });
      const metadata = await sharp(rawBuffer).metadata();
      const imgWidth = metadata.width || 1920;
      const imgHeight = metadata.height || 1080;

      // Calculate extraction rectangle
      let left = Math.min(x1, x2);
      let top = Math.min(y1, y2);
      let width = deltaX;
      let height = deltaY;

      // Clamp within image bounds
      left = Math.max(0, Math.min(left, imgWidth - 1));
      top = Math.max(0, Math.min(top, imgHeight - 1));
      width = Math.min(width, imgWidth - left);
      height = Math.min(height, imgHeight - top);

      if (width < MIN_CROP_DIMENSION_PX || height < MIN_CROP_DIMENSION_PX) {
        earconSynth.playDoubleLowTut();
        return null;
      }

      const croppedBuffer = await sharp(rawBuffer)
        .extract({ left, top, width, height })
        .jpeg({ quality: 85, progressive: true })
        .toBuffer();

      stagingBuffer.addImage(croppedBuffer);
      earconSynth.playShortTut();
      return croppedBuffer;
    } catch (_err) {
      earconSynth.playDoubleLowTut();
      return null;
    }
  }

  /**
   * Cancels active region selection.
   */
  cancelRegionSelection() {
    this.regionStartPoint = null;
    this.isRegionSelecting = false;
  }
}

const screenCapture = new ScreenCaptureEngine();

module.exports = {
  screenCapture,
  MIN_CROP_DIMENSION_PX,
};
