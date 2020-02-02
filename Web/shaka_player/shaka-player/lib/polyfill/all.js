/** @license
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.polyfill');

goog.require('shaka.log');
goog.require('shaka.util.Iterables');


/**
 * @summary A one-stop installer for all polyfills.
 * @see http://enwp.org/polyfill
 * @exportInterface
 */
shaka.polyfill = class {
  /**
   * Install all polyfills.
   * @export
   */
  static installAll() {
    for (const polyfill of shaka.polyfill.polyfills_) {
      try {
        polyfill.callback();
      } catch (error) {
        shaka.log.alwaysWarn('Error installing polyfill!', error);
      }
    }
  }

  /**
   * Registers a new polyfill to be installed.
   *
   * @param {function()} polyfill
   * @param {number=} priority An optional number priority.  Higher priorities
   *   will be executed before lower priority ones.  Default is 0.
   * @export
   */
  static register(polyfill, priority) {
    const newItem = {priority: priority || 0, callback: polyfill};
    const enumerate = (it) => shaka.util.Iterables.enumerate(it);
    for (const {i, item} of enumerate(shaka.polyfill.polyfills_)) {
      if (item.priority < newItem.priority) {
        shaka.polyfill.polyfills_.splice(i, 0, newItem);
        return;
      }
    }
    shaka.polyfill.polyfills_.push(newItem);
  }
};


/**
 * Contains the polyfills that will be installed.
 * @private {!Array.<{priority: number, callback: function()}>}
 */
shaka.polyfill.polyfills_ = [];
