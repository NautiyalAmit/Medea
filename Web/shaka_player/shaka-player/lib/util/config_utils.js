/** @license
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.util.ConfigUtils');

goog.require('goog.asserts');
goog.require('shaka.log');


/** @export */
shaka.util.ConfigUtils = class {
  /**
   * @param {!Object} destination
   * @param {!Object} source
   * @param {!Object} template supplies default values
   * @param {!Object} overrides
   *   Supplies override type checking.  When the current path matches
   *   the key in this object, each sub-value must match the type in this
   *   object. If this contains an Object, it is used as the template.
   * @param {string} path to this part of the config
   * @return {boolean}
   * @export
   */
  static mergeConfigObjects(destination, source, template, overrides, path) {
    goog.asserts.assert(destination, 'Destination config must not be null!');

    /**
     * @type {boolean}
     * If true, don't validate the keys in the next level.
     */
    const ignoreKeys = path in overrides;

    let isValid = true;

    for (const k in source) {
      const subPath = path + '.' + k;
      const subTemplate = ignoreKeys ? overrides[path] : template[k];

      // The order of these checks is important.
      if (!ignoreKeys && !(k in template)) {
        shaka.log.error('Invalid config, unrecognized key ' + subPath);
        isValid = false;
      } else if (source[k] === undefined) {
        // An explicit 'undefined' value causes the key to be deleted from the
        // destination config and replaced with a default from the template if
        // possible.
        if (subTemplate === undefined || ignoreKeys) {
          // There is nothing in the template, so delete.
          delete destination[k];
        } else {
          // There is something in the template, so go back to that.
          destination[k] = shaka.util.ObjectUtils.cloneObject(subTemplate);
        }
      } else if (subTemplate.constructor == Object &&
             source[k] &&
             source[k].constructor == Object) {
        // These are plain Objects with no other constructor.

        if (!destination[k]) {
          // Initialize the destination with the template so that normal
          // merging and type-checking can happen.
          destination[k] = shaka.util.ObjectUtils.cloneObject(subTemplate);
        }

        const subMergeValid = shaka.util.ConfigUtils.mergeConfigObjects(
            destination[k], source[k], subTemplate, overrides, subPath);
        isValid = isValid && subMergeValid;
      } else if (typeof source[k] != typeof subTemplate ||
             source[k] == null ||
             source[k].constructor != subTemplate.constructor) {
        // The source is the wrong type.  This check allows objects to be
        // nulled, but does not allow null for any non-object fields.
        shaka.log.error('Invalid config, wrong type for ' + subPath);
        isValid = false;
      } else if (typeof template[k] == 'function' &&
             template[k].length != source[k].length) {
        shaka.log.warning(
            'Invalid config, wrong number of arguments for ' + subPath);
        destination[k] = source[k];
      } else {
        destination[k] = source[k];
      }
    }

    return isValid;
  }


  /**
   * Convert config from ('fieldName', value) format to a partial config object.
   *
   * E. g. from ('manifest.retryParameters.maxAttempts', 1) to
   * { manifest: { retryParameters: { maxAttempts: 1 }}}.
   *
   * @param {string} fieldName
   * @param {*} value
   * @return {!Object}
   * @export
   */
  static convertToConfigObject(fieldName, value) {
    const configObject = {};
    let last = configObject;
    let searchIndex = 0;
    let nameStart = 0;
    while (true) {  // eslint-disable-line no-constant-condition
      const idx = fieldName.indexOf('.', searchIndex);
      if (idx < 0) {
        break;
      }
      if (idx == 0 || fieldName[idx - 1] != '\\') {
        const part = fieldName.substring(nameStart, idx).replace(/\\\./g, '.');
        last[part] = {};
        last = last[part];
        nameStart = idx + 1;
      }
      searchIndex = idx + 1;
    }

    last[fieldName.substring(nameStart).replace(/\\\./g, '.')] = value;
    return configObject;
  }
};
