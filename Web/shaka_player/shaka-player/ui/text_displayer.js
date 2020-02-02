/** @license
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */


goog.provide('shaka.ui.TextDisplayer');

goog.require('shaka.util.Dom');


/**
 * @implements {shaka.extern.TextDisplayer}
 * @final
 * @export
 */
shaka.ui.TextDisplayer = class {
  /**
   * Constructor.
   * @param {HTMLMediaElement} video
   * @param {HTMLElement} videoContainer
   */
  constructor(video, videoContainer) {
    /** @private {boolean} */
    this.isTextVisible_ = false;

    /** @private {!Array.<!shaka.extern.Cue>} */
    this.cues_ = [];

    /** @private {HTMLMediaElement} */
    this.video_ = video;

    /** @private {HTMLElement} */
    this.videoContainer_ = videoContainer;

    /** @type {HTMLElement} */
    this.textContainer_ = shaka.util.Dom.createHTMLElement('div');
    this.textContainer_.classList.add('shaka-text-container');
    this.videoContainer_.appendChild(this.textContainer_);

    /**
     * The captions' update period in seconds.
     * @private {number}
     */
    const updatePeriod = 0.25;

    /** @private {shaka.util.Timer} */
    this.captionsTimer_ = new shaka.util.Timer(() => {
      this.updateCaptions_();
    }).tickEvery(updatePeriod);

    /** private {Map.<!shaka.extern.Cue, !HTMLElement>} */
    this.currentCuesMap_ = new Map();
  }


  /**
   * @override
   * @export
   */
  append(cues) {
    // Add the cues.
    this.cues_ = this.cues_.concat(cues);
  }


  /**
   * @override
   * @export
   */
  destroy() {
    // Remove the text container element from the UI.
    this.videoContainer_.removeChild(this.textContainer_);
    this.textContainer_ = null;

    this.isTextVisible_ = false;
    this.cues_ = [];
    if (this.captionsTimer_) {
      this.captionsTimer_.stop();
    }

    this.currentCuesMap_.clear();
  }


  /**
   * @override
   * @export
   */
  remove(start, end) {
    // Return false if destroy() has been called.
    if (!this.textContainer_) {
      return false;
    }

    // Remove the cues out of the time range.
    this.cues_ = this.cues_.filter(
        (cue) => cue.startTime < start || cue.endTime >= end);
    this.updateCaptions_();

    return true;
  }


  /**
   * @override
   * @export
   */
  isTextVisible() {
    return this.isTextVisible_;
  }

  /**
   * @override
   * @export
   */
  setTextVisibility(on) {
    this.isTextVisible_ = on;
  }

  /**
   * Display the current captions.
   * @private
   */
  updateCaptions_() {
    const currentTime = this.video_.currentTime;

    // Return true if the cue should be displayed at the current time point.
    const shouldCueBeDisplayed = (cue) => {
      return this.cues_.includes(cue) && this.isTextVisible_ &&
             cue.startTime <= currentTime && cue.endTime >= currentTime;
    };

    // For each cue in the current cues map, if the cue's end time has passed,
    // remove the entry from the map, and remove the captions from the page.
    for (const cue of this.currentCuesMap_.keys()) {
      if (!shouldCueBeDisplayed(cue)) {
        const captions = this.currentCuesMap_.get(cue);
        this.textContainer_.removeChild(captions);
        this.currentCuesMap_.delete(cue);
      }
    }

    // Sometimes we don't remove a cue element correctly.  So check all the
    // child nodes and remove any that don't have an associated cue.
    const expectedChildren = new Set(this.currentCuesMap_.values());
    for (const child of Array.from(this.textContainer_.childNodes)) {
      if (!expectedChildren.has(child)) {
        this.textContainer_.removeChild(child);
      }
    }

    // Get the current cues that should be added to display. If the cue is not
    // being displayed already, add it to the map, and add the captions onto the
    // page.
    const currentCues = this.cues_.filter((cue) => {
      return shouldCueBeDisplayed(cue) && !this.currentCuesMap_.has(cue);
    }).sort((a, b) => {
      if (a.startTime != b.startTime) {
        return a.startTime - b.startTime;
      } else {
        return a.endTime - b.endTime;
      }
    });

    for (const cue of currentCues) {
      this.displayCue_(this.textContainer_, cue);
    }
  }

  /**
   * Displays a nested cue
   *
   * @param {Element} container
   * @param {!shaka.extern.Cue} cue
   * @return {Element} the created captions container
   * @private
   */
  displayNestedCue_(container, cue) {
    const captions = shaka.util.Dom.createHTMLElement('span');

    if (cue.spacer) {
      captions.style.display = 'block';
    } else {
      this.setCaptionStyles_(captions, cue, /* isNested= */ true);
    }

    container.appendChild(captions);

    return captions;
  }

  /**
   * Displays a cue
   *
   * @param {Element} container
   * @param {!shaka.extern.Cue} cue
   * @private
   */
  displayCue_(container, cue) {
    if (cue.nestedCues.length) {
      const nestedCuesContainer = shaka.util.Dom.createHTMLElement('p');
      nestedCuesContainer.style.width = '100%';
      this.setCaptionStyles_(nestedCuesContainer, cue, /* isNested= */ false);

      for (let i = 0; i < cue.nestedCues.length; i++) {
        this.displayNestedCue_(nestedCuesContainer, cue.nestedCues[i]);
      }

      container.appendChild(nestedCuesContainer);
      this.currentCuesMap_.set(cue, nestedCuesContainer);
    } else {
      this.currentCuesMap_.set(cue, this.displayNestedCue_(container, cue));
    }
  }

  /**
   * @param {!HTMLElement} captions
   * @param {!shaka.extern.Cue} cue
   * @param {boolean} isNested
   * @private
   */
  setCaptionStyles_(captions, cue, isNested) {
    const Cue = shaka.text.Cue;
    const captionsStyle = captions.style;
    const panelStyle = this.textContainer_.style;

    // Set white-space to 'pre-line' to enable showing line breaks in the text.
    captionsStyle.whiteSpace = 'pre-line';
    captions.textContent = cue.payload;
    captionsStyle.backgroundColor = cue.backgroundColor;
    captionsStyle.color = cue.color;
    captionsStyle.direction = cue.direction;

    if (cue.backgroundImage) {
      captionsStyle.backgroundImage = 'url(\'' + cue.backgroundImage + '\')';
      captionsStyle.backgroundRepeat = 'no-repeat';
      captionsStyle.backgroundSize = 'contain';
      captionsStyle.backgroundPosition = 'center';
      if (cue.backgroundColor == '') {
        captionsStyle.backgroundColor = 'transparent';
      }
    }
    if (cue.backgroundImage && cue.region) {
      const percentageUnit = shaka.text.CueRegion.units.PERCENTAGE;
      const heightUnit = cue.region.heightUnits == percentageUnit ? '%' : 'px';
      const widthUnit = cue.region.widthUnits == percentageUnit ? '%' : 'px';
      captionsStyle.height = cue.region.height + heightUnit;
      captionsStyle.width = cue.region.width + widthUnit;
    }

    // The displayAlign attribute specifys the vertical alignment of the
    // captions inside the text container. Before means at the top of the
    // text container, and after means at the bottom.
    if (cue.displayAlign == Cue.displayAlign.BEFORE) {
      captionsStyle.justifyContent = 'flex-start';
    } else if (cue.displayAlign == Cue.displayAlign.CENTER) {
      captionsStyle.justifyContent = 'center';
    } else {
      captionsStyle.justifyContent = 'flex-end';
    }
    if (cue.nestedCues.length) {
      captionsStyle.display = 'flex';
      captionsStyle.flexDirection = 'column';
      captionsStyle.margin = '0';
    }

    captionsStyle.fontFamily = cue.fontFamily;
    captionsStyle.fontWeight = cue.fontWeight.toString();
    captionsStyle.fontSize = cue.fontSize;
    captionsStyle.fontStyle = cue.fontStyle;

    // The line attribute defines the positioning of the text container inside
    // the video container.
    // - The line offsets the text container from the top, the right or left of
    //   the video viewport as defined by the writing direction.
    // - The value of the line is either as a number of lines, or a percentage
    //   of the video viewport height or width.
    // The lineAlign is an alignment for the text container's line.
    // - The Start alignment means the text container’s top side (for horizontal
    //   cues), left side (for vertical growing right), or right side (for
    //   vertical growing left) is aligned at the line.
    // - The Center alignment means the text container is centered at the line
    //   (to be implemented).
    // - The End Alignment means The text container’s bottom side (for
    //   horizontal cues), right side (for vertical growing right), or left side
    //   (for vertical growing left) is aligned at the line.
    // TODO: Implement line alignment with line number.
    // TODO: Implement lineAlignment of 'CENTER'.
    if (cue.line) {
      if (cue.lineInterpretation == Cue.lineInterpretation.PERCENTAGE) {
        if (cue.writingMode == Cue.writingMode.HORIZONTAL_TOP_TO_BOTTOM) {
          if (cue.lineAlign == Cue.lineAlign.START) {
            panelStyle.top = cue.line + '%';
          } else if (cue.lineAlign == Cue.lineAlign.END) {
            panelStyle.bottom = cue.line + '%';
          }
        } else if (cue.writingMode == Cue.writingMode.VERTICAL_LEFT_TO_RIGHT) {
          if (cue.lineAlign == Cue.lineAlign.START) {
            panelStyle.left = cue.line + '%';
          } else if (cue.lineAlign == Cue.lineAlign.END) {
            panelStyle.right = cue.line + '%';
          }
        } else {
          if (cue.lineAlign == Cue.lineAlign.START) {
            panelStyle.right = cue.line + '%';
          } else if (cue.lineAlign == Cue.lineAlign.END) {
            panelStyle.left = cue.line + '%';
          }
        }
      }
    } else if (cue.region && cue.region.id && !isNested) {
      const percentageUnit = shaka.text.CueRegion.units.PERCENTAGE;
      const heightUnit = cue.region.heightUnits == percentageUnit ? '%' : 'px';
      const widthUnit = cue.region.widthUnits == percentageUnit ? '%' : 'px';
      const viewportAnchorUnit =
          cue.region.viewportAnchorUnits == percentageUnit ? '%' : 'px';
      captionsStyle.height = cue.region.height + heightUnit;
      captionsStyle.width = cue.region.width + widthUnit;
      captionsStyle.top = cue.region.viewportAnchorY + viewportAnchorUnit;
      captionsStyle.left = cue.region.viewportAnchorX + viewportAnchorUnit;
      captionsStyle.position = 'absolute';
    }

    captionsStyle.lineHeight = cue.lineHeight;

    // The position defines the indent of the text container in the
    // direction defined by the writing direction.
    if (cue.position) {
      if (cue.writingMode == Cue.writingMode.HORIZONTAL_TOP_TO_BOTTOM) {
        panelStyle.paddingLeft = cue.position;
      } else {
        panelStyle.paddingTop = cue.position;
      }
    }

    // The positionAlign attribute is an alignment for the text container in
    // the dimension of the writing direction.
    if (cue.positionAlign == Cue.positionAlign.LEFT) {
      panelStyle.cssFloat = 'left';
    } else if (cue.positionAlign == Cue.positionAlign.RIGHT) {
      panelStyle.cssFloat = 'right';
    } else {
      panelStyle.margin = 'auto';
    }

    captionsStyle.textAlign = cue.textAlign;
    captionsStyle.textDecoration = cue.textDecoration.join(' ');
    captionsStyle.writingMode = cue.writingMode;

    // The size is a number giving the size of the text container, to be
    // interpreted as a percentage of the video, as defined by the writing
    // direction.
    if (cue.writingMode == Cue.writingMode.HORIZONTAL_TOP_TO_BOTTOM) {
      panelStyle.width = cue.size + '%';
    } else {
      panelStyle.height = cue.size + '%';
    }
  }
};
