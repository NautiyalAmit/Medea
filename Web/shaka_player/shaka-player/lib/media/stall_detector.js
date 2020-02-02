/** @license
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.media.StallDetector');
goog.provide('shaka.media.StallDetector.Implementation');
goog.provide('shaka.media.StallDetector.MediaElementImplementation');

goog.require('shaka.media.TimeRangesUtils');

/**
 * Some platforms/browsers can get stuck in the middle of a buffered range (e.g.
 * when seeking in a background tab). Detect when we get stuck so that the
 * player can respond.
 *
 * @implements {shaka.util.IReleasable}
 * @final
 */
shaka.media.StallDetector = class {
  /**
   * @param {shaka.media.StallDetector.Implementation} implementation
   * @param {number} stallThresholdSeconds
   */
  constructor(implementation, stallThresholdSeconds) {
    /** @private {shaka.media.StallDetector.Implementation} */
    this.implementation_ = implementation;

    /** @private {boolean} */
    this.wasMakingProgress_ = implementation.shouldBeMakingProgress();
    /** @private {number} */
    this.value_ = implementation.getPresentationSeconds();
    /** @private {number} */
    this.lastUpdateSeconds_ = implementation.getWallSeconds();
    /** @private {boolean} */
    this.didJump_ = false;

    /**
     * The amount of time in seconds that we must have the same value of
     * |value_| before we declare it as a stall.
     *
     * @private {number}
     */
    this.stallThresholdSeconds_ = stallThresholdSeconds;

    /** @private {function(number, number)} */
    this.onStall_ = () => {};
  }

  /** @override */
  release() {
    // Drop external references to make things easier on the GC.
    this.implementation_ = null;
    this.onStall_ = () => {};
  }

  /**
   * Set the callback that should be called when a stall is detected. Calling
   * this will override any previous calls to |onStall|.
   *
   * @param {function(number, number)} doThis
   */
  onStall(doThis) {
    this.onStall_ = doThis;
  }

  /**
   * Have the detector update itself and fire the "on stall" callback if a stall
   * was detected.
   */
  poll() {
    const impl = this.implementation_;

    const shouldBeMakingProgress = impl.shouldBeMakingProgress();
    const value = impl.getPresentationSeconds();
    const wallTimeSeconds = impl.getWallSeconds();

    const acceptUpdate = this.value_ != value ||
                         this.wasMakingProgress_ != shouldBeMakingProgress;

    if (acceptUpdate) {
      this.lastUpdateSeconds_ = wallTimeSeconds;
      this.value_ = value;
      this.wasMakingProgress_ = shouldBeMakingProgress;
      this.didJump_ = false;
    }

    const stallSeconds = wallTimeSeconds - this.lastUpdateSeconds_;

    const triggerCallback = stallSeconds >= this.stallThresholdSeconds_ &&
                            shouldBeMakingProgress && !this.didJump_;

    if (triggerCallback) {
      this.onStall_(this.value_, stallSeconds);
      this.didJump_ = true;
      // If the onStall_ method updated the current time, update our stored
      // value so we don't think that was an update.
      this.value_ = impl.getPresentationSeconds();
    }
  }
};

/**
 * @interface
 */
shaka.media.StallDetector.Implementation = class {
  /**
   * Check if the presentation time should be changing. This will return |true|
   * when we expect the presentation time to change.
   *
   * @return {boolean}
   */
  shouldBeMakingProgress() {}

  /**
   * Get the presentation time in seconds.
   *
   * @return {number}
   */
  getPresentationSeconds() {}

  /**
   * Get the time wall time in seconds.
   *
   * @return {number}
   */
  getWallSeconds() {}
};


/**
 * Some platforms/browsers can get stuck in the middle of a buffered range (e.g.
 * when seeking in a background tab). Force a seek to help get it going again.
 *
 * @implements {shaka.media.StallDetector.Implementation}
 * @final
 */
shaka.media.StallDetector.MediaElementImplementation = class {
  /**
   * @param {!HTMLMediaElement} mediaElement
   */
  constructor(mediaElement) {
    /** @private {!HTMLMediaElement} */
    this.mediaElement_ = mediaElement;
  }

  /** @override */
  shouldBeMakingProgress() {
    // If we are not trying to play, the lack of change could be misidentified
    // as a stall.
    if (this.mediaElement_.paused) {
      return false;
    }
    if (this.mediaElement_.playbackRate == 0) {
      return false;
    }

    // If we have don't have enough content, we are not stalled, we are
    // buffering.
    if (this.mediaElement_.buffered == null) {
      return false;
    }

    return shaka.media.StallDetector.MediaElementImplementation.hasContentFor_(
        this.mediaElement_.buffered,
        /* timeInSeconds= */ this.mediaElement_.currentTime);
  }

  /** @override */
  getPresentationSeconds() {
    return this.mediaElement_.currentTime;
  }

  /** @override */
  getWallSeconds() {
    return Date.now() / 1000;
  }

  /**
   * Check if we have buffered enough content to play at |timeInSeconds|. Ignore
   * the end of the buffered range since it may not play any more on all
   * platforms.
   *
   * @param {!TimeRanges} buffered
   * @param {number} timeInSeconds
   * @return {boolean}
   * @private
   */
  static hasContentFor_(buffered, timeInSeconds) {
    const TimeRangesUtils = shaka.media.TimeRangesUtils;
    for (const {start, end} of TimeRangesUtils.getBufferedInfo(buffered)) {
      if (timeInSeconds < start) {
        continue;
      }
      if (timeInSeconds > end - 0.5) {
        continue;
      }

      return true;
    }

    return false;
  }
};
