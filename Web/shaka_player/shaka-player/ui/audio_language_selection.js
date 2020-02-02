/** @license
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */


goog.provide('shaka.ui.AudioLanguageSelection');

goog.require('shaka.ui.Enums');
goog.require('shaka.ui.LanguageUtils');
goog.require('shaka.ui.Locales');
goog.require('shaka.ui.Localization');
goog.require('shaka.ui.OverflowMenu');
goog.require('shaka.ui.SettingsMenu');

/**
 * @extends {shaka.ui.SettingsMenu}
 * @final
 * @export
 */
shaka.ui.AudioLanguageSelection = class extends shaka.ui.SettingsMenu {
  /**
   * @param {!HTMLElement} parent
   * @param {!shaka.ui.Controls} controls
   */
  constructor(parent, controls) {
    super(parent, controls, shaka.ui.Enums.MaterialDesignIcons.LANGUAGE);

    this.button.classList.add('shaka-language-button');
    this.menu.classList.add('shaka-audio-languages');

    this.eventManager.listen(
        this.localization, shaka.ui.Localization.LOCALE_UPDATED, () => {
          this.updateLocalizedStrings_();
        });

    this.eventManager.listen(
        this.localization, shaka.ui.Localization.LOCALE_CHANGED, () => {
          this.updateLocalizedStrings_();
        });


    this.eventManager.listen(this.player, 'trackschanged', () => {
      this.onTracksChanged_();
    });

    this.eventManager.listen(this.player, 'variantchanged', () => {
      this.updateAudioLanguages_();
    });

    // Set up all the strings in the user's preferred language.
    this.updateLocalizedStrings_();

    this.updateAudioLanguages_();
  }


  /** @private */
  updateAudioLanguages_() {
    const tracks = this.player.getVariantTracks();
    const languages = this.player.getAudioLanguages();

    shaka.ui.LanguageUtils.updateLanguages(tracks, this.menu,
        languages,
        (lang) => this.onAudioLanguageSelected_(lang), /* updateChosen */ true,
        this.currentSelection,
        this.localization);
    shaka.ui.Utils.focusOnTheChosenItem(this.menu);

    this.controls.dispatchEvent(
        new shaka.util.FakeEvent('languageselectionupdated'));
  }

  /** @private */
  onTracksChanged_() {
    const hasVariants = this.player.getVariantTracks().length > 0;
    shaka.ui.Utils.setDisplay(this.button, hasVariants);
    this.updateAudioLanguages_();
  }

  /**
   * @param {string} language
   * @private
   */
  onAudioLanguageSelected_(language) {
    this.player.selectAudioLanguage(language);
  }


  /**
   * @private
   */
  updateLocalizedStrings_() {
    const LocIds = shaka.ui.Locales.Ids;

    this.backButton.setAttribute(shaka.ui.Constants.ARIA_LABEL,
        this.localization.resolve(LocIds.BACK));
    this.button.setAttribute(shaka.ui.Constants.ARIA_LABEL,
        this.localization.resolve(LocIds.LANGUAGE));
    this.nameSpan.textContent =
        this.localization.resolve(LocIds.LANGUAGE);
    this.backSpan.textContent =
        this.localization.resolve(LocIds.LANGUAGE);
  }
};


/**
 * @implements {shaka.extern.IUIElement.Factory}
 * @final
 */
shaka.ui.AudioLanguageSelection.Factory = class {
  /** @override */
  create(rootElement, controls) {
    return new shaka.ui.AudioLanguageSelection(rootElement, controls);
  }
};

shaka.ui.OverflowMenu.registerElement(
    'language', new shaka.ui.AudioLanguageSelection.Factory());
