/** @license
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.dash.DashParser');

goog.require('goog.asserts');
goog.require('shaka.abr.Ewma');
goog.require('shaka.dash.ContentProtection');
goog.require('shaka.dash.MpdUtils');
goog.require('shaka.dash.SegmentBase');
goog.require('shaka.dash.SegmentList');
goog.require('shaka.dash.SegmentTemplate');
goog.require('shaka.log');
goog.require('shaka.media.DrmEngine');
goog.require('shaka.media.ManifestParser');
goog.require('shaka.media.PresentationTimeline');
goog.require('shaka.media.SegmentIndex');
goog.require('shaka.net.NetworkingEngine');
goog.require('shaka.text.TextEngine');
goog.require('shaka.util.Error');
goog.require('shaka.util.Functional');
goog.require('shaka.util.Iterables');
goog.require('shaka.util.LanguageUtils');
goog.require('shaka.util.ManifestParserUtils');
goog.require('shaka.util.MimeUtils');
goog.require('shaka.util.Networking');
goog.require('shaka.util.OperationManager');
goog.require('shaka.util.StringUtils');
goog.require('shaka.util.XmlUtils');


/**
 * Creates a new DASH parser.
 *
 * @implements {shaka.extern.ManifestParser}
 * @export
 */
shaka.dash.DashParser = class {
  /** Creates a new DASH parser. */
  constructor() {
    /** @private {?shaka.extern.ManifestConfiguration} */
    this.config_ = null;

    /** @private {?shaka.extern.ManifestParser.PlayerInterface} */
    this.playerInterface_ = null;

    /** @private {!Array.<string>} */
    this.manifestUris_ = [];

    /** @private {?shaka.extern.Manifest} */
    this.manifest_ = null;

    /** @private {!Array.<string>} */
    this.periodIds_ = [];

    /** @private {number} */
    this.globalId_ = 1;

    /**
     * A map of IDs to SegmentIndex objects.
     * ID: Period@id,AdaptationSet@id,@Representation@id
     * e.g.: '1,5,23'
     * @private {!Object.<string, !shaka.media.SegmentIndex>}
     */
    this.segmentIndexMap_ = {};

    /**
     * The update period in seconds, or 0 for no updates.
     * @private {number}
     */
    this.updatePeriod_ = 0;

    /**
     * An ewma that tracks how long updates take.
     * This is to mitigate issues caused by slow parsing on embedded devices.
     * @private {!shaka.abr.Ewma}
     */
    this.averageUpdateDuration_ = new shaka.abr.Ewma(5);

    /** @private {shaka.util.Timer} */
    this.updateTimer_ = new shaka.util.Timer(() => {
      this.onUpdate_();
    });

    /** @private {!shaka.util.OperationManager} */
    this.operationManager_ = new shaka.util.OperationManager();
  }

  /**
   * @override
   * @exportInterface
   */
  configure(config) {
    goog.asserts.assert(config.dash != null,
        'DashManifestConfiguration should not be null!');

    this.config_ = config;
  }

  /**
   * @override
   * @exportInterface
   */
  async start(uri, playerInterface) {
    goog.asserts.assert(this.config_, 'Must call configure() before start()!');
    this.manifestUris_ = [uri];
    this.playerInterface_ = playerInterface;

    const updateDelay = await this.requestManifest_();

    if (this.playerInterface_) {
      this.setUpdateTimer_(updateDelay);
    }

    // Make sure that the parser has not been destroyed.
    if (!this.playerInterface_) {
      throw new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.PLAYER,
          shaka.util.Error.Code.OPERATION_ABORTED);
    }

    goog.asserts.assert(this.manifest_, 'Manifest should be non-null!');
    return this.manifest_;
  }

  /**
   * @override
   * @exportInterface
   */
  stop() {
    this.playerInterface_ = null;
    this.config_ = null;
    this.manifestUris_ = [];
    this.manifest_ = null;
    this.periodIds_ = [];
    this.segmentIndexMap_ = {};

    if (this.updateTimer_ != null) {
      this.updateTimer_.stop();
      this.updateTimer_ = null;
    }

    return this.operationManager_.destroy();
  }

  /**
   * @override
   * @exportInterface
   */
  async update() {
    try {
      await this.requestManifest_();
    } catch (error) {
      if (!this.playerInterface_ || !error) {
        return;
      }
      goog.asserts.assert(error instanceof shaka.util.Error, 'Bad error type');
      this.playerInterface_.onError(error);
    }
  }

  /**
   * @override
   * @exportInterface
   */
  onExpirationUpdated(sessionId, expiration) {
    // No-op
  }

  /**
   * Makes a network request for the manifest and parses the resulting data.
   *
   * @return {!Promise.<number>} Resolves with the time it took, in seconds, to
   *   fulfill the request and parse the data.
   * @private
   */
  async requestManifest_() {
    const requestType = shaka.net.NetworkingEngine.RequestType.MANIFEST;
    const request = shaka.net.NetworkingEngine.makeRequest(
        this.manifestUris_, this.config_.retryParameters);
    const networkingEngine = this.playerInterface_.networkingEngine;

    const startTime = Date.now();
    const operation = networkingEngine.request(requestType, request);
    this.operationManager_.manage(operation);

    const response = await operation.promise;

    // Detect calls to stop().
    if (!this.playerInterface_) {
      return 0;
    }

    // For redirections add the response uri to the first entry in the
    // Manifest Uris array.
    if (response.uri && !this.manifestUris_.includes(response.uri)) {
      this.manifestUris_.unshift(response.uri);
    }

    // This may throw, but it will result in a failed promise.
    await this.parseManifest_(response.data, response.uri);
    // Keep track of how long the longest manifest update took.
    const endTime = Date.now();
    const updateDuration = (endTime - startTime) / 1000.0;
    this.averageUpdateDuration_.sample(1, updateDuration);

    // Let the caller know how long this update took.
    return updateDuration;
  }

  /**
   * Parses the manifest XML.  This also handles updates and will update the
   * stored manifest.
   *
   * @param {BufferSource} data
   * @param {string} finalManifestUri The final manifest URI, which may
   *   differ from this.manifestUri_ if there has been a redirect.
   * @return {!Promise}
   * @private
   */
  async parseManifest_(data, finalManifestUri) {
    const Error = shaka.util.Error;
    const MpdUtils = shaka.dash.MpdUtils;

    const mpd = shaka.util.XmlUtils.parseXml(data, 'MPD');
    if (!mpd) {
      throw new Error(
          Error.Severity.CRITICAL, Error.Category.MANIFEST,
          Error.Code.DASH_INVALID_XML, finalManifestUri);
    }

    // Process the mpd to account for xlink connections.
    const failGracefully = this.config_.dash.xlinkFailGracefully;
    const xlinkOperation = MpdUtils.processXlinks(
        mpd, this.config_.retryParameters, failGracefully, finalManifestUri,
        this.playerInterface_.networkingEngine);
    this.operationManager_.manage(xlinkOperation);
    const finalMpd = await xlinkOperation.promise;
    return this.processManifest_(finalMpd, finalManifestUri);
  }


  /**
   * Takes a formatted MPD and converts it into a manifest.
   *
   * @param {!Element} mpd
   * @param {string} finalManifestUri The final manifest URI, which may
   *   differ from this.manifestUri_ if there has been a redirect.
   * @return {!Promise}
   * @private
   */
  async processManifest_(mpd, finalManifestUri) {
    const Functional = shaka.util.Functional;
    const XmlUtils = shaka.util.XmlUtils;

    // Get any Location elements.  This will update the manifest location and
    // the base URI.
    /** @type {!Array.<string>} */
    let manifestBaseUris = [finalManifestUri];
    /** @type {!Array.<string>} */
    const locations = XmlUtils.findChildren(mpd, 'Location')
        .map(XmlUtils.getContents)
        .filter(Functional.isNotNull);
    if (locations.length > 0) {
      const absoluteLocations = shaka.util.ManifestParserUtils.resolveUris(
          manifestBaseUris, locations);
      this.manifestUris_ = absoluteLocations;
      manifestBaseUris = absoluteLocations;
    }

    const uris =
        XmlUtils.findChildren(mpd, 'BaseURL').map(XmlUtils.getContents);
    const baseUris = shaka.util.ManifestParserUtils.resolveUris(
        manifestBaseUris, uris);

    const ignoreMinBufferTime = this.config_.dash.ignoreMinBufferTime;
    let minBufferTime = 0;
    if (!ignoreMinBufferTime) {
      minBufferTime =
          XmlUtils.parseAttr(mpd, 'minBufferTime', XmlUtils.parseDuration);
    }

    this.updatePeriod_ = /** @type {number} */ (XmlUtils.parseAttr(
        mpd, 'minimumUpdatePeriod', XmlUtils.parseDuration, -1));

    const presentationStartTime = XmlUtils.parseAttr(
        mpd, 'availabilityStartTime', XmlUtils.parseDate);
    let segmentAvailabilityDuration = XmlUtils.parseAttr(
        mpd, 'timeShiftBufferDepth', XmlUtils.parseDuration);

    const ignoreSuggestedPresentationDelay =
      this.config_.dash.ignoreSuggestedPresentationDelay;
    let suggestedPresentationDelay = null;
    if (!ignoreSuggestedPresentationDelay) {
      suggestedPresentationDelay = XmlUtils.parseAttr(
          mpd, 'suggestedPresentationDelay', XmlUtils.parseDuration);
    }

    const maxSegmentDuration = XmlUtils.parseAttr(
        mpd, 'maxSegmentDuration', XmlUtils.parseDuration);
    const mpdType = mpd.getAttribute('type') || 'static';

    /** @type {!shaka.media.PresentationTimeline} */
    let presentationTimeline;
    if (this.manifest_) {
      presentationTimeline = this.manifest_.presentationTimeline;
    } else {
      // DASH IOP v3.0 suggests using a default delay between minBufferTime
      // and timeShiftBufferDepth.  This is literally the range of all
      // feasible choices for the value.  Nothing older than
      // timeShiftBufferDepth is still available, and anything less than
      // minBufferTime will cause buffering issues.
      //
      // We have decided that our default will be 1.5 * minBufferTime,
      // or 10s (configurable) whichever is larger.  This is fairly
      // conservative. Content providers should provide a
      // suggestedPresentationDelay whenever possible to optimize the live
      // streaming experience.
      const defaultPresentationDelay = Math.max(
          this.config_.dash.defaultPresentationDelay,
          minBufferTime * 1.5);
      const presentationDelay = suggestedPresentationDelay != null ?
          suggestedPresentationDelay : defaultPresentationDelay;
      presentationTimeline = new shaka.media.PresentationTimeline(
          presentationStartTime, presentationDelay,
          this.config_.dash.autoCorrectDrift);
    }

    /** @type {shaka.dash.DashParser.Context} */
    const context = {
      // Don't base on updatePeriod_ since emsg boxes can cause manifest
      // updates.
      dynamic: mpdType != 'static',
      presentationTimeline: presentationTimeline,
      period: null,
      periodInfo: null,
      adaptationSet: null,
      representation: null,
      bandwidth: 0,
      indexRangeWarningGiven: false,
    };

    const periodsAndDuration = this.parsePeriods_(context, baseUris, mpd);
    const duration = periodsAndDuration.duration;
    const periods = periodsAndDuration.periods;

    presentationTimeline.setStatic(mpdType == 'static');
    if (mpdType == 'static' ||
        !periodsAndDuration.durationDerivedFromPeriods) {
      // Ignore duration calculated from Period lengths if this is dynamic.
      presentationTimeline.setDuration(duration || Infinity);
    }

    const isLive = presentationTimeline.isLive();

    // If it's live, we check for an override.
    if (isLive && !isNaN(this.config_.availabilityWindowOverride)) {
      segmentAvailabilityDuration = this.config_.availabilityWindowOverride;
    }

    // If it's null, that means segments are always available.  This is always
    // the case for VOD, and sometimes the case for live.
    if (segmentAvailabilityDuration == null) {
      segmentAvailabilityDuration = Infinity;
    }

    presentationTimeline.setSegmentAvailabilityDuration(
        segmentAvailabilityDuration);

    // Use @maxSegmentDuration to override smaller, derived values.
    presentationTimeline.notifyMaxSegmentDuration(maxSegmentDuration || 1);
    if (goog.DEBUG) {
      presentationTimeline.assertIsValid();
    }

    // These steps are not done on manifest update.
    if (!this.manifest_) {
      this.manifest_ = {
        presentationTimeline: presentationTimeline,
        periods: periods,
        offlineSessionIds: [],
        minBufferTime: minBufferTime || 0,
      };

      // We only need to do clock sync when we're using presentation start
      // time. This condition also excludes VOD streams.
      if (presentationTimeline.usingPresentationStartTime()) {
        const timingElements = XmlUtils.findChildren(mpd, 'UTCTiming');
        const offset = await this.parseUtcTiming_(baseUris, timingElements);
        // Detect calls to stop().
        if (!this.playerInterface_) {
          return;
        }
        presentationTimeline.setClockOffset(offset);
      }
    }
  }

  /**
   * Reads and parses the periods from the manifest.  This first does some
   * partial parsing so the start and duration is available when parsing
   * children.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @param {!Array.<string>} baseUris
   * @param {!Element} mpd
   * @return {{
   *   periods: !Array.<shaka.extern.Period>,
   *   duration: ?number,
   *   durationDerivedFromPeriods: boolean
   * }}
   * @private
   */
  parsePeriods_(context, baseUris, mpd) {
    const XmlUtils = shaka.util.XmlUtils;
    const presentationDuration = XmlUtils.parseAttr(
        mpd, 'mediaPresentationDuration', XmlUtils.parseDuration);

    const periods = [];
    let prevEnd = 0;
    const periodNodes = XmlUtils.findChildren(mpd, 'Period');
    // This uses a for-loop rather than a for-of loop because this needs to look
    // ahead to the next element.
    const enumerate = (it) => shaka.util.Iterables.enumerate(it);
    for (const {i, item: elem, next} of enumerate(periodNodes)) {
      const start = /** @type {number} */ (
        XmlUtils.parseAttr(elem, 'start', XmlUtils.parseDuration, prevEnd));
      const givenDuration =
          XmlUtils.parseAttr(elem, 'duration', XmlUtils.parseDuration);

      let periodDuration = null;
      if (next) {
        // "The difference between the start time of a Period and the start time
        // of the following Period is the duration of the media content
        // represented by this Period."
        const nextStart =
            XmlUtils.parseAttr(next, 'start', XmlUtils.parseDuration);
        if (nextStart != null) {
          periodDuration = nextStart - start;
        }
      } else if (presentationDuration != null) {
        // "The Period extends until the Period.start of the next Period, or
        // until the end of the Media Presentation in the case of the last
        // Period."
        periodDuration = presentationDuration - start;
      }

      const threshold =
          shaka.util.ManifestParserUtils.GAP_OVERLAP_TOLERANCE_SECONDS;
      if (periodDuration && givenDuration &&
          Math.abs(periodDuration - givenDuration) > threshold) {
        shaka.log.warning('There is a gap/overlap between Periods', elem);
      }
      // Only use the @duration in the MPD if we can't calculate it.  We should
      // favor the @start of the following Period.  This ensures that there
      // aren't gaps between Periods.
      if (periodDuration == null) {
        periodDuration = givenDuration;
      }

      // Parse child nodes.
      const info = {
        start: start,
        duration: periodDuration,
        node: elem,
        isLastPeriod: periodDuration == null || !next,
      };
      const period = this.parsePeriod_(context, baseUris, info);
      periods.push(period);

      // If the period ID is new, add it to the list.  This must be done for
      // both the initial manifest parse and for updates.
      // See https://github.com/google/shaka-player/issues/963
      const periodId = context.period.id;
      goog.asserts.assert(periodId, 'Period IDs should not be null!');
      if (!this.periodIds_.includes(periodId)) {
        this.periodIds_.push(periodId);

        // If this is an update, call filterNewPeriod and add it to the
        // manifest.
        // If this is the first parse of the manifest (this.manifest_ == null),
        // filterAllPeriods will be called later.
        if (this.manifest_) {
          this.playerInterface_.filterNewPeriod(period);
          this.manifest_.periods.push(period);
        }
      }

      if (periodDuration == null) {
        if (next) {
          // If the duration is still null and we aren't at the end, then we
          // will skip any remaining periods.
          shaka.log.warning(
              'Skipping Period', i + 1, 'and any subsequent Periods:', 'Period',
              i + 1, 'does not have a valid start time.', next);
        }

        // The duration is unknown, so the end is unknown.
        prevEnd = null;
        break;
      }

      prevEnd = start + periodDuration;
    } // end of period parsing loop

    // Call filterAllPeriods if this is the initial parse.
    if (this.manifest_ == null) {
      this.playerInterface_.filterAllPeriods(periods);
    }

    if (presentationDuration != null) {
      if (prevEnd != presentationDuration) {
        shaka.log.warning(
            '@mediaPresentationDuration does not match the total duration of ',
            'all Periods.');
        // Assume @mediaPresentationDuration is correct.
      }
      return {
        periods: periods,
        duration: presentationDuration,
        durationDerivedFromPeriods: false,
      };
    } else {
      return {
        periods: periods,
        duration: prevEnd,
        durationDerivedFromPeriods: true,
      };
    }
  }

  /**
   * Parses a Period XML element.  Unlike the other parse methods, this is not
   * given the Node; it is given a PeriodInfo structure.  Also, partial parsing
   * was done before this was called so start and duration are valid.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @param {!Array.<string>} baseUris
   * @param {shaka.dash.DashParser.PeriodInfo} periodInfo
   * @return {shaka.extern.Period}
   * @private
   */
  parsePeriod_(context, baseUris, periodInfo) {
    const Functional = shaka.util.Functional;
    const XmlUtils = shaka.util.XmlUtils;
    const ContentType = shaka.util.ManifestParserUtils.ContentType;

    context.period = this.createFrame_(periodInfo.node, null, baseUris);
    context.periodInfo = periodInfo;

    // If the period doesn't have an ID, give it one based on its start time.
    if (!context.period.id) {
      shaka.log.info(
          'No Period ID given for Period with start time ' + periodInfo.start +
          ',  Assigning a default');
      context.period.id = '__shaka_period_' + periodInfo.start;
    }

    const eventStreamNodes =
        XmlUtils.findChildren(periodInfo.node, 'EventStream');
    for (const node of eventStreamNodes) {
      this.parseEventStream_(periodInfo.start, periodInfo.duration, node);
    }

    const adaptationSetNodes =
        XmlUtils.findChildren(periodInfo.node, 'AdaptationSet');
    const adaptationSets = adaptationSetNodes
        .map((node) => this.parseAdaptationSet_(context, node))
        .filter(Functional.isNotNull);

    // For dynamic manifests, we use rep IDs internally, and they must be
    // unique.
    if (context.dynamic) {
      const ids = [];
      for (const set of adaptationSets) {
        for (const id of set.representationIds) {
          ids.push(id);
        }
      }

      const uniqueIds = new Set(ids);

      if (ids.length != uniqueIds.size) {
        throw new shaka.util.Error(
            shaka.util.Error.Severity.CRITICAL,
            shaka.util.Error.Category.MANIFEST,
            shaka.util.Error.Code.DASH_DUPLICATE_REPRESENTATION_ID);
      }
    }

    const normalAdaptationSets = adaptationSets
        .filter((as) => { return !as.trickModeFor; });

    const trickModeAdaptationSets = adaptationSets
        .filter((as) => { return as.trickModeFor; });

    // Attach trick mode tracks to normal tracks.
    for (const trickModeSet of trickModeAdaptationSets) {
      // There may be multiple trick mode streams, but we do not currently
      // support that.  Just choose one.
      const trickModeVideo = trickModeSet.streams[0];
      const targetId = trickModeSet.trickModeFor;
      for (const normalSet of normalAdaptationSets) {
        if (normalSet.id == targetId) {
          for (const stream of normalSet.streams) {
            stream.trickModeVideo = trickModeVideo;
          }
        }
      }
    }

    let videoSets =
        this.getSetsOfType_(normalAdaptationSets, ContentType.VIDEO);
    let audioSets =
        this.getSetsOfType_(normalAdaptationSets, ContentType.AUDIO);

    if (!videoSets.length && !audioSets.length) {
      throw new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.MANIFEST,
          shaka.util.Error.Code.DASH_EMPTY_PERIOD);
    }

    // In case of audio-only or video-only content or the audio/video is
    // disabled by the config, we create an array of one item containing
    // a null. This way, the double-loop works for all kinds of content.
    const disableAudio = this.config_.disableAudio;
    if (!audioSets.length || disableAudio) {
      audioSets = [null];
    }
    const disableVideo = this.config_.disableVideo;
    if (!videoSets.length || disableVideo) {
      videoSets = [null];
    }

    // TODO: Limit number of combinations.  Come up with a heuristic
    // to decide which audio tracks to combine with which video tracks.
    const variants = [];
    for (const audioSet of audioSets) {
      for (const videoSet of videoSets) {
        this.createVariants_(audioSet, videoSet, variants);
      }
    }

    const textSets = this.config_.disableText ? [] :
        this.getSetsOfType_(normalAdaptationSets, ContentType.TEXT);
    const textStreams = [];
    for (const textSet of textSets) {
      textStreams.push(...textSet.streams);
    }

    return {
      startTime: periodInfo.start,
      textStreams: textStreams,
      variants: variants,
    };
  }

  /**
   * @param {!Array.<!shaka.dash.DashParser.AdaptationInfo>} adaptationSets
   * @param {string} type
   * @return {!Array.<!shaka.dash.DashParser.AdaptationInfo>}
   * @private
   */
  getSetsOfType_(adaptationSets, type) {
    return adaptationSets.filter((as) => {
      return as.contentType == type;
    });
  }

  /**
   * Combines Streams into Variants
   *
   * @param {?shaka.dash.DashParser.AdaptationInfo} audio
   * @param {?shaka.dash.DashParser.AdaptationInfo} video
   * @param {!Array.<shaka.extern.Variant>} variants New variants are pushed
   *   onto this array.
   * @private
   */
  createVariants_(audio, video, variants) {
    const ContentType = shaka.util.ManifestParserUtils.ContentType;

    // Since both audio and video are of the same type, this assertion will
    // catch certain mistakes at runtime that the compiler would miss.
    goog.asserts.assert(!audio || audio.contentType == ContentType.AUDIO,
        'Audio parameter mismatch!');
    goog.asserts.assert(!video || video.contentType == ContentType.VIDEO,
        'Video parameter mismatch!');

    /** @type {number} */
    let bandwidth;
    /** @type {shaka.extern.Variant} */
    let variant;

    if (!audio && !video) {
      return;
    }

    if (audio && video) {
      // Audio+video variants.
      const DrmEngine = shaka.media.DrmEngine;
      if (DrmEngine.areDrmCompatible(audio.drmInfos, video.drmInfos)) {
        const drmInfos = DrmEngine.getCommonDrmInfos(audio.drmInfos,
            video.drmInfos);

        for (const audioStream of audio.streams) {
          for (const videoStream of video.streams) {
            bandwidth =
            (videoStream.bandwidth || 0) +
            (audioStream.bandwidth || 0);
            variant = {
              id: this.globalId_++,
              language: audio.language,
              primary: audio.main || video.main,
              audio: audioStream,
              video: videoStream,
              bandwidth: bandwidth,
              drmInfos: drmInfos,
              allowedByApplication: true,
              allowedByKeySystem: true,
            };

            variants.push(variant);
          }
        }
      }
    } else {
      // Audio or video only variants.
      const set = audio || video;
      for (const stream of set.streams) {
        bandwidth = stream.bandwidth || 0;
        variant = {
          id: this.globalId_++,
          language: set.language || 'und',
          primary: set.main,
          audio: audio ? stream : null,
          video: video ? stream : null,
          bandwidth: bandwidth,
          drmInfos: set.drmInfos,
          allowedByApplication: true,
          allowedByKeySystem: true,
        };

        variants.push(variant);
      }
    }
  }

  /**
   * Parses an AdaptationSet XML element.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @param {!Element} elem The AdaptationSet element.
   * @return {?shaka.dash.DashParser.AdaptationInfo}
   * @private
   */
  parseAdaptationSet_(context, elem) {
    const XmlUtils = shaka.util.XmlUtils;
    const Functional = shaka.util.Functional;
    const ManifestParserUtils = shaka.util.ManifestParserUtils;
    const ContentType = ManifestParserUtils.ContentType;
    const ContentProtection = shaka.dash.ContentProtection;

    context.adaptationSet = this.createFrame_(elem, context.period, null);

    // Filter image adaptation sets, until we add thumbnail track support.
    // See: https://github.com/google/shaka-player/issues/559
    const isImage = context.adaptationSet.contentType == ContentType.IMAGE;
    if (isImage) {
      shaka.log.warning('Skipping Image AdaptationSet', context.adaptationSet);
      return null;
    }

    let main = false;
    const roleElements = XmlUtils.findChildren(elem, 'Role');
    const roleValues = roleElements.map((role) => {
      return role.getAttribute('value');
    }).filter(Functional.isNotNull);

    // Default kind for text streams is 'subtitle' if unspecified in the
    // manifest.
    let kind = undefined;
    const isText = context.adaptationSet.contentType == ContentType.TEXT;
    if (isText) {
      kind = ManifestParserUtils.TextStreamKind.SUBTITLE;
    }

    for (const roleElement of roleElements) {
      const scheme = roleElement.getAttribute('schemeIdUri');
      if (scheme == null || scheme == 'urn:mpeg:dash:role:2011') {
        // These only apply for the given scheme, but allow them to be specified
        // if there is no scheme specified.
        // See: DASH section 5.8.5.5
        const value = roleElement.getAttribute('value');
        switch (value) {
          case 'main':
            main = true;
            break;
          case 'caption':
          case 'subtitle':
            kind = value;
            break;
        }
      }
    }

    const essentialProperties =
        XmlUtils.findChildren(elem, 'EssentialProperty');
    // ID of real AdaptationSet if this is a trick mode set:
    let trickModeFor = null;
    let unrecognizedEssentialProperty = false;
    for (const prop of essentialProperties) {
      const schemeId = prop.getAttribute('schemeIdUri');
      if (schemeId == 'http://dashif.org/guidelines/trickmode') {
        trickModeFor = prop.getAttribute('value');
      } else {
        unrecognizedEssentialProperty = true;
      }
    }

    const accessibilities = XmlUtils.findChildren(elem, 'Accessibility');
    const LanguageUtils = shaka.util.LanguageUtils;
    const closedCaptions = new Map();
    for (const prop of accessibilities) {
      const schemeId = prop.getAttribute('schemeIdUri');
      const value = prop.getAttribute('value');
      if (schemeId == 'urn:scte:dash:cc:cea-608:2015' ||
          schemeId == 'urn:scte:dash:cc:cea-708:2015') {
        let channelId = 1;
        if (value != null) {
          for (const captionStr of value.split(';')) {
            let channel;
            let language;
            // Some closed caption descriptions have channel number and
            // language, like "CC1=eng" or "1=lang:eng", others may only have
            // the language, like "eng".
            if (!captionStr.includes('=')) {
              // Since only odd numbers are used as channel numbers, like CC1,
              // CC3, CC5, etc, when the channel number is not provided, use an
              // odd number as the key. https://en.wikipedia.org/wiki/EIA-608
              channel = 'CC' + channelId;
              channelId += 2;
              language = captionStr;
            } else {
              const channelAndLanguage = captionStr.split('=');
              // The channel info can be '1' or 'CC1'.
              // If the channel info only has channel number(like '1'), add 'CC'
              // as prefix so that it can be a full channel id (like 'CC1').
              channel = channelAndLanguage[0].startsWith('CC') ?
                  channelAndLanguage[0] : 'CC' + channelAndLanguage[0];
              // The language info can be different formats, like 'eng',
              // 'lang:eng', or 'lang:eng,war:1,er:1'. Extract the language info
              // and convert it to 2-letter language code format.
              language = channelAndLanguage[1].split(',')[0].split(':').pop();
            }
            closedCaptions.set(channel, LanguageUtils.normalize(language));
          }
        } else {
          // If channel and language information has not been provided, assign
          // 'CC1' as channel id and 'und' as language info.
          closedCaptions.set('CC1', 'und');
        }
      } else if (schemeId == 'urn:mpeg:dash:role:2011') {
        // See DASH IOP 3.9.2 Table 4.
        if (value != null) {
          roleValues.push(value);
          if (value == 'captions') {
            kind = ManifestParserUtils.TextStreamKind.CLOSED_CAPTION;
          }
        }
      }
    }

    // According to DASH spec (2014) section 5.8.4.8, "the successful processing
    // of the descriptor is essential to properly use the information in the
    // parent element".  According to DASH IOP v3.3, section 3.3.4, "if the
    // scheme or the value" for EssentialProperty is not recognized, "the DASH
    // client shall ignore the parent element."
    if (unrecognizedEssentialProperty) {
      // Stop parsing this AdaptationSet and let the caller filter out the
      // nulls.
      return null;
    }

    const contentProtectionElems =
        XmlUtils.findChildren(elem, 'ContentProtection');
    const contentProtection = ContentProtection.parseFromAdaptationSet(
        contentProtectionElems, this.config_.dash.customScheme,
        this.config_.dash.ignoreDrmInfo);

    const language =
        shaka.util.LanguageUtils.normalize(elem.getAttribute('lang') || 'und');

    // This attribute is currently non-standard, but it is supported by Kaltura.
    let label = elem.getAttribute('label');

    // See DASH IOP 4.3 here https://dashif.org/docs/DASH-IF-IOP-v4.3.pdf (page 35)
    const labelElements = XmlUtils.findChildren(elem, 'Label');
    if (labelElements && labelElements.length) {
      // NOTE: Right now only one label field is supported.
      const firstLabelElement = labelElements[0];
      if (firstLabelElement.textContent) {
        label = firstLabelElement.textContent;
      }
    }

    // Parse Representations into Streams.
    const representations = XmlUtils.findChildren(elem, 'Representation');
    const streams = representations.map((representation) => {
      return this.parseRepresentation_(context, contentProtection, kind,
          language, label, main, roleValues, closedCaptions, representation);
    }).filter((s) => !!s);

    if (streams.length == 0) {
      // Ignore empty AdaptationSets if they are for text content.
      if (isText) {
        return null;
      }
      throw new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.MANIFEST,
          shaka.util.Error.Code.DASH_EMPTY_ADAPTATION_SET);
    }

    // If AdaptationSet's type is unknown or is ambiguously "application",
    // guess based on the information in the first stream.  If the attributes
    // mimeType and codecs are split across levels, they will both be inherited
    // down to the stream level by this point, so the stream will have all the
    // necessary information.
    if (!context.adaptationSet.contentType ||
        context.adaptationSet.contentType == ContentType.APPLICATION) {
      const mimeType = streams[0].mimeType;
      const codecs = streams[0].codecs;
      context.adaptationSet.contentType =
          shaka.dash.DashParser.guessContentType_(mimeType, codecs);

      for (const stream of streams) {
        stream.type = context.adaptationSet.contentType;
      }
    }

    for (const stream of streams) {
      // Some DRM license providers require that we have a default
      // key ID from the manifest in the wrapped license request.
      // Thus, it should be put in drmInfo to be accessible to request filters.
      for (const drmInfo of contentProtection.drmInfos) {
        if (stream.keyId) {
          drmInfo.keyIds.push(stream.keyId);
        }
      }
    }

    const repIds = representations
        .map((node) => { return node.getAttribute('id'); })
        .filter(shaka.util.Functional.isNotNull);

    return {
      id: context.adaptationSet.id || ('__fake__' + this.globalId_++),
      contentType: context.adaptationSet.contentType,
      language: language,
      main: main,
      streams: streams,
      drmInfos: contentProtection.drmInfos,
      trickModeFor: trickModeFor,
      representationIds: repIds,
    };
  }

  /**
   * Parses a Representation XML element.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @param {shaka.dash.ContentProtection.Context} contentProtection
   * @param {(string|undefined)} kind
   * @param {string} language
   * @param {string} label
   * @param {boolean} isPrimary
   * @param {!Array.<string>} roles
   * @param {Map.<string, string>} closedCaptions
   * @param {!Element} node
   * @return {?shaka.extern.Stream} The Stream, or null when there is a
   *   non-critical parsing error.
   * @private
   */
  parseRepresentation_(context, contentProtection, kind, language, label,
      isPrimary, roles, closedCaptions, node) {
    const XmlUtils = shaka.util.XmlUtils;
    const ContentType = shaka.util.ManifestParserUtils.ContentType;

    context.representation =
        this.createFrame_(node, context.adaptationSet, null);
    if (!this.verifyRepresentation_(context.representation)) {
      shaka.log.warning('Skipping Representation', context.representation);
      return null;
    }

    // NOTE: bandwidth is a mandatory attribute according to the spec, and zero
    // does not make sense in the DASH spec's bandwidth formulas.
    // In some content, however, the attribute is missing or zero.
    // To avoid NaN at the variant level on broken content, fall back to zero.
    // https://github.com/google/shaka-player/issues/938#issuecomment-317278180
    context.bandwidth =
        XmlUtils.parseAttr(node, 'bandwidth', XmlUtils.parsePositiveInt) || 0;

    /** @type {?shaka.dash.DashParser.StreamInfo} */
    let streamInfo;

    const contentType = context.representation.contentType;
    const isText = contentType == ContentType.TEXT ||
                   contentType == ContentType.APPLICATION;

    try {
      const requestInitSegment = (uris, startByte, endByte) => {
        return this.requestInitSegment_(uris, startByte, endByte);
      };
      if (context.representation.segmentBase) {
        streamInfo = shaka.dash.SegmentBase.createStreamInfo(
            context, requestInitSegment);
      } else if (context.representation.segmentList) {
        streamInfo = shaka.dash.SegmentList.createStreamInfo(
            context, this.segmentIndexMap_);
      } else if (context.representation.segmentTemplate) {
        const hasManifest = !!this.manifest_;
        streamInfo = shaka.dash.SegmentTemplate.createStreamInfo(
            context, requestInitSegment, this.segmentIndexMap_, hasManifest,
            this.config_.dash.initialSegmentLimit);
      } else {
        goog.asserts.assert(isText,
            'Must have Segment* with non-text streams.');

        const baseUris = context.representation.baseUris;
        const duration = context.periodInfo.duration || 0;
        streamInfo = {
          generateSegmentIndex: () => {
            return Promise.resolve(shaka.media.SegmentIndex.forSingleSegment(
                duration, baseUris));
          },
        };
      }
    } catch (error) {
      if (isText && error.code == shaka.util.Error.Code.DASH_NO_SEGMENT_INFO) {
        // We will ignore any DASH_NO_SEGMENT_INFO errors for text streams.
        return null;
      }

      // For anything else, re-throw.
      throw error;
    }

    const contentProtectionElems =
        XmlUtils.findChildren(node, 'ContentProtection');
    const keyId = shaka.dash.ContentProtection.parseFromRepresentation(
        contentProtectionElems, this.config_.dash.customScheme,
        contentProtection, this.config_.dash.ignoreDrmInfo);

    /** @type {shaka.extern.Stream} */
    const stream = {
      id: this.globalId_++,
      originalId: context.representation.id,
      createSegmentIndex: async () => {
        if (!stream.segmentIndex) {
          stream.segmentIndex = await streamInfo.generateSegmentIndex();
        }
      },
      segmentIndex: null,
      mimeType: context.representation.mimeType,
      codecs: context.representation.codecs,
      frameRate: context.representation.frameRate,
      bandwidth: context.bandwidth,
      width: context.representation.width,
      height: context.representation.height,
      kind: kind,
      encrypted: contentProtection.drmInfos.length > 0,
      keyId: keyId,
      language: language,
      label: label,
      type: context.adaptationSet.contentType,
      primary: isPrimary,
      trickModeVideo: null,
      emsgSchemeIdUris:
          context.representation.emsgSchemeIdUris,
      roles: roles,
      channelsCount: context.representation.numChannels,
      audioSamplingRate: context.representation.audioSamplingRate,
      closedCaptions: closedCaptions,
    };
    return stream;
  }

  /**
   * Called when the update timer ticks.
   *
   * @return {!Promise}
   * @private
   */
  async onUpdate_() {
    goog.asserts.assert(this.updatePeriod_ >= 0,
        'There should be an update period');

    shaka.log.info('Updating manifest...');

    // Default the update delay to 0 seconds so that if there is an error we can
    // try again right away.
    let updateDelay = 0;

    try {
      updateDelay = await this.requestManifest_();
    } catch (error) {
      goog.asserts.assert(error instanceof shaka.util.Error,
          'Should only receive a Shaka error');

      // Try updating again, but ensure we haven't been destroyed.
      if (this.playerInterface_) {
        // We will retry updating, so override the severity of the error.
        error.severity = shaka.util.Error.Severity.RECOVERABLE;
        this.playerInterface_.onError(error);
      }
    }

    // Detect a call to stop()
    if (!this.playerInterface_) {
      return;
    }

    this.setUpdateTimer_(updateDelay);
  }

  /**
   * Sets the update timer.  Does nothing if the manifest does not specify an
   * update period.
   *
   * @param {number} offset An offset, in seconds, to apply to the manifest's
   *   update period.
   * @private
   */
  setUpdateTimer_(offset) {
    // NOTE: An updatePeriod_ of -1 means the attribute was missing.
    // An attribute which is present and set to 0 should still result in
    // periodic updates.  For more, see:
    // https://github.com/google/shaka-player/issues/331
    if (this.updatePeriod_ < 0) {
      return;
    }

    const finalDelay = Math.max(
        shaka.dash.DashParser.MIN_UPDATE_PERIOD_,
        this.updatePeriod_ - offset,
        this.averageUpdateDuration_.getEstimate());

    // We do not run the timer as repeating because part of update is async and
    // we need schedule the update after it finished.
    this.updateTimer_.tickAfter(/* seconds= */ finalDelay);
  }

  /**
   * Creates a new inheritance frame for the given element.
   *
   * @param {!Element} elem
   * @param {?shaka.dash.DashParser.InheritanceFrame} parent
   * @param {Array.<string>} baseUris
   * @return {shaka.dash.DashParser.InheritanceFrame}
   * @private
   */
  createFrame_(elem, parent, baseUris) {
    goog.asserts.assert(parent || baseUris,
        'Must provide either parent or baseUris');
    const ManifestParserUtils = shaka.util.ManifestParserUtils;
    const XmlUtils = shaka.util.XmlUtils;
    parent = parent || /** @type {shaka.dash.DashParser.InheritanceFrame} */ ({
      contentType: '',
      mimeType: '',
      codecs: '',
      emsgSchemeIdUris: [],
      frameRate: undefined,
      numChannels: null,
      audioSamplingRate: null,
    });
    baseUris = baseUris || parent.baseUris;

    const parseNumber = XmlUtils.parseNonNegativeInt;
    const evalDivision = XmlUtils.evalDivision;
    const uris =
        XmlUtils.findChildren(elem, 'BaseURL').map(XmlUtils.getContents);

    let contentType = elem.getAttribute('contentType') || parent.contentType;
    const mimeType = elem.getAttribute('mimeType') || parent.mimeType;
    const codecs = elem.getAttribute('codecs') || parent.codecs;
    const frameRate =
        XmlUtils.parseAttr(elem, 'frameRate', evalDivision) || parent.frameRate;
    const emsgSchemeIdUris = this.emsgSchemeIdUris_(
        XmlUtils.findChildren(elem, 'InbandEventStream'),
        parent.emsgSchemeIdUris);
    const audioChannelConfigs =
        XmlUtils.findChildren(elem, 'AudioChannelConfiguration');
    const numChannels =
        this.parseAudioChannels_(audioChannelConfigs) || parent.numChannels;
    const audioSamplingRate =
        XmlUtils.parseAttr(elem, 'audioSamplingRate', parseNumber) ||
        parent.audioSamplingRate;

    if (!contentType) {
      contentType = shaka.dash.DashParser.guessContentType_(mimeType, codecs);
    }

    return {
      baseUris: ManifestParserUtils.resolveUris(baseUris, uris),
      segmentBase:
          XmlUtils.findChild(elem, 'SegmentBase') || parent.segmentBase,
      segmentList:
          XmlUtils.findChild(elem, 'SegmentList') || parent.segmentList,
      segmentTemplate:
          XmlUtils.findChild(elem, 'SegmentTemplate') || parent.segmentTemplate,
      width: XmlUtils.parseAttr(elem, 'width', parseNumber) || parent.width,
      height: XmlUtils.parseAttr(elem, 'height', parseNumber) || parent.height,
      contentType: contentType,
      mimeType: mimeType,
      codecs: codecs,
      frameRate: frameRate,
      emsgSchemeIdUris: emsgSchemeIdUris,
      id: elem.getAttribute('id'),
      numChannels: numChannels,
      audioSamplingRate: audioSamplingRate,
    };
  }

  /**
   * Returns a new array of InbandEventStream schemeIdUri containing the union
   * of the ones parsed from inBandEventStreams and the ones provided in
   * emsgSchemeIdUris.
   *
   * @param {!Array.<!Element>} inBandEventStreams Array of InbandEventStream
   *     elements to parse and add to the returned array.
   * @param {!Array.<string>} emsgSchemeIdUris Array of parsed
   *     InbandEventStream schemeIdUri attributes to add to the returned array.
   * @return {!Array.<string>} schemeIdUris Array of parsed
   *     InbandEventStream schemeIdUri attributes.
   * @private
   */
  emsgSchemeIdUris_(inBandEventStreams, emsgSchemeIdUris) {
    const schemeIdUris = emsgSchemeIdUris.slice();
    for (const event of inBandEventStreams) {
      const schemeIdUri = event.getAttribute('schemeIdUri');
      if (!schemeIdUris.includes(schemeIdUri)) {
        schemeIdUris.push(schemeIdUri);
      }
    }
    return schemeIdUris;
  }

  /**
   * @param {!Array.<!Element>} audioChannelConfigs An array of
   *   AudioChannelConfiguration elements.
   * @return {?number} The number of audio channels, or null if unknown.
   * @private
   */
  parseAudioChannels_(audioChannelConfigs) {
    for (const elem of audioChannelConfigs) {
      const scheme = elem.getAttribute('schemeIdUri');
      if (!scheme) {
        continue;
      }

      const value = elem.getAttribute('value');
      if (!value) {
        continue;
      }

      switch (scheme) {
        case 'urn:mpeg:dash:outputChannelPositionList:2012':
          // A space-separated list of speaker positions, so the number of
          // channels is the length of this list.
          return value.trim().split(/ +/).length;

        case 'urn:mpeg:dash:23003:3:audio_channel_configuration:2011':
        case 'urn:dts:dash:audio_channel_configuration:2012': {
          // As far as we can tell, this is a number of channels.
          const intValue = parseInt(value, 10);
          if (!intValue) {  // 0 or NaN
            shaka.log.warning('Channel parsing failure! ' +
                          'Ignoring scheme and value', scheme, value);
            continue;
          }
          return intValue;
        }

        case 'tag:dolby.com,2014:dash:audio_channel_configuration:2011':
        case 'urn:dolby:dash:audio_channel_configuration:2011': {
          // A hex-encoded 16-bit integer, in which each bit represents a
          // channel.
          let hexValue = parseInt(value, 16);
          if (!hexValue) {  // 0 or NaN
            shaka.log.warning('Channel parsing failure! ' +
                          'Ignoring scheme and value', scheme, value);
            continue;
          }
          // Count the 1-bits in hexValue.
          let numBits = 0;
          while (hexValue) {
            if (hexValue & 1) {
              ++numBits;
            }
            hexValue >>= 1;
          }
          return numBits;
        }

        default:
          shaka.log.warning(
              'Unrecognized audio channel scheme:', scheme, value);
          continue;
      }
    }

    return null;
  }

  /**
   * Verifies that a Representation has exactly one Segment* element.  Prints
   * warnings if there is a problem.
   *
   * @param {shaka.dash.DashParser.InheritanceFrame} frame
   * @return {boolean} True if the Representation is usable; otherwise return
   *   false.
   * @private
   */
  verifyRepresentation_(frame) {
    const ContentType = shaka.util.ManifestParserUtils.ContentType;

    let n = 0;
    n += frame.segmentBase ? 1 : 0;
    n += frame.segmentList ? 1 : 0;
    n += frame.segmentTemplate ? 1 : 0;

    if (n == 0) {
      // TODO: Extend with the list of MIME types registered to TextEngine.
      if (frame.contentType == ContentType.TEXT ||
          frame.contentType == ContentType.APPLICATION) {
        return true;
      } else {
        shaka.log.warning(
            'Representation does not contain a segment information source:',
            'the Representation must contain one of SegmentBase, SegmentList,',
            'SegmentTemplate, or explicitly indicate that it is "text".',
            frame);
        return false;
      }
    }

    if (n != 1) {
      shaka.log.warning(
          'Representation contains multiple segment information sources:',
          'the Representation should only contain one of SegmentBase,',
          'SegmentList, or SegmentTemplate.',
          frame);
      if (frame.segmentBase) {
        shaka.log.info('Using SegmentBase by default.');
        frame.segmentList = null;
        frame.segmentTemplate = null;
      } else {
        goog.asserts.assert(frame.segmentList, 'There should be a SegmentList');
        shaka.log.info('Using SegmentList by default.');
        frame.segmentTemplate = null;
      }
    }

    return true;
  }

  /**
   * Makes a request to the given URI and calculates the clock offset.
   *
   * @param {!Array.<string>} baseUris
   * @param {string} uri
   * @param {string} method
   * @return {!Promise.<number>}
   * @private
   */
  async requestForTiming_(baseUris, uri, method) {
    const requestUris =
        shaka.util.ManifestParserUtils.resolveUris(baseUris, [uri]);
    const request = shaka.net.NetworkingEngine.makeRequest(
        requestUris, this.config_.retryParameters);
    request.method = method;
    const type = shaka.net.NetworkingEngine.RequestType.TIMING;

    const operation =
    this.playerInterface_.networkingEngine.request(type, request);
    this.operationManager_.manage(operation);

    const response = await operation.promise;
    let text;
    if (method == 'HEAD') {
      if (!response.headers || !response.headers['date']) {
        shaka.log.warning('UTC timing response is missing',
            'expected date header');
        return 0;
      }
      text = response.headers['date'];
    } else {
      text = shaka.util.StringUtils.fromUTF8(response.data);
    }
    const date = Date.parse(text);
    if (isNaN(date)) {
      shaka.log.warning('Unable to parse date from UTC timing response');
      return 0;
    }
    return (date - Date.now());
  }

  /**
   * Parses an array of UTCTiming elements.
   *
   * @param {!Array.<string>} baseUris
   * @param {!Array.<!Element>} elems
   * @return {!Promise.<number>}
   * @private
   */
  async parseUtcTiming_(baseUris, elems) {
    const schemesAndValues = elems.map((elem) => {
      return {
        scheme: elem.getAttribute('schemeIdUri'),
        value: elem.getAttribute('value'),
      };
    });

    // If there's nothing specified in the manifest, but we have a default from
    // the config, use that.
    const clockSyncUri = this.config_.dash.clockSyncUri;
    if (!schemesAndValues.length && clockSyncUri) {
      schemesAndValues.push({
        scheme: 'urn:mpeg:dash:utc:http-head:2014',
        value: clockSyncUri,
      });
    }

    for (const sv of schemesAndValues) {
      try {
        const scheme = sv.scheme;
        const value = sv.value;
        switch (scheme) {
          // See DASH IOP Guidelines Section 4.7
          // https://bit.ly/DashIop3-2
          // Some old ISO23009-1 drafts used 2012.
          case 'urn:mpeg:dash:utc:http-head:2014':
          case 'urn:mpeg:dash:utc:http-head:2012':
            // eslint-disable-next-line no-await-in-loop
            return await this.requestForTiming_(baseUris, value, 'HEAD');
          case 'urn:mpeg:dash:utc:http-xsdate:2014':
          case 'urn:mpeg:dash:utc:http-iso:2014':
          case 'urn:mpeg:dash:utc:http-xsdate:2012':
          case 'urn:mpeg:dash:utc:http-iso:2012':
            // eslint-disable-next-line no-await-in-loop
            return await this.requestForTiming_(baseUris, value, 'GET');
          case 'urn:mpeg:dash:utc:direct:2014':
          case 'urn:mpeg:dash:utc:direct:2012': {
            const date = Date.parse(value);
            return isNaN(date) ? 0 : (date - Date.now());
          }

          case 'urn:mpeg:dash:utc:http-ntp:2014':
          case 'urn:mpeg:dash:utc:ntp:2014':
          case 'urn:mpeg:dash:utc:sntp:2014':
            shaka.log.alwaysWarn('NTP UTCTiming scheme is not supported');
            break;
          default:
            shaka.log.alwaysWarn(
                'Unrecognized scheme in UTCTiming element', scheme);
            break;
        }
      } catch (e) {
        shaka.log.warning('Error fetching time from UTCTiming elem', e.message);
      }
    }

    shaka.log.alwaysWarn(
        'A UTCTiming element should always be given in live manifests! ' +
        'This content may not play on clients with bad clocks!');
    return 0;
  }

  /**
   * Parses an EventStream element.
   *
   * @param {number} periodStart
   * @param {?number} periodDuration
   * @param {!Element} elem
   * @private
   */
  parseEventStream_(periodStart, periodDuration, elem) {
    const XmlUtils = shaka.util.XmlUtils;
    const parseNumber = XmlUtils.parseNonNegativeInt;

    const schemeIdUri = elem.getAttribute('schemeIdUri') || '';
    const value = elem.getAttribute('value') || '';
    const timescale = XmlUtils.parseAttr(elem, 'timescale', parseNumber) || 1;

    for (const eventNode of XmlUtils.findChildren(elem, 'Event')) {
      const presentationTime =
          XmlUtils.parseAttr(eventNode, 'presentationTime', parseNumber) || 0;
      const duration =
          XmlUtils.parseAttr(eventNode, 'duration', parseNumber) || 0;

      let startTime = presentationTime / timescale + periodStart;
      let endTime = startTime + (duration / timescale);
      if (periodDuration != null) {
        // An event should not go past the Period, even if the manifest says so.
        // See: Dash sec. 5.10.2.1
        startTime = Math.min(startTime, periodStart + periodDuration);
        endTime = Math.min(endTime, periodStart + periodDuration);
      }

      /** @type {shaka.extern.TimelineRegionInfo} */
      const region = {
        schemeIdUri: schemeIdUri,
        value: value,
        startTime: startTime,
        endTime: endTime,
        id: eventNode.getAttribute('id') || '',
        eventElement: eventNode,
      };

      this.playerInterface_.onTimelineRegionAdded(region);
    }
  }

  /**
   * Makes a network request on behalf of SegmentBase.createStreamInfo.
   *
   * @param {!Array.<string>} uris
   * @param {?number} startByte
   * @param {?number} endByte
   * @return {!Promise.<BufferSource>}
   * @private
   */
  async requestInitSegment_(uris, startByte, endByte) {
    const requestType = shaka.net.NetworkingEngine.RequestType.SEGMENT;

    const request = shaka.util.Networking.createSegmentRequest(
        uris,
        startByte,
        endByte,
        this.config_.retryParameters);

    const networkingEngine = this.playerInterface_.networkingEngine;
    const operation = networkingEngine.request(requestType, request);
    this.operationManager_.manage(operation);
    const response = await operation.promise;
    return response.data;
  }

  /**
   * Guess the content type based on MIME type and codecs.
   *
   * @param {string} mimeType
   * @param {string} codecs
   * @return {string}
   * @private
   */
  static guessContentType_(mimeType, codecs) {
    const fullMimeType = shaka.util.MimeUtils.getFullType(mimeType, codecs);

    if (shaka.text.TextEngine.isTypeSupported(fullMimeType)) {
      // If it's supported by TextEngine, it's definitely text.
      // We don't check MediaSourceEngine, because that would report support
      // for platform-supported video and audio types as well.
      return shaka.util.ManifestParserUtils.ContentType.TEXT;
    }

    // Otherwise, just split the MIME type.  This handles video and audio
    // types well.
    return mimeType.split('/')[0];
  }
};


/**
 * Contains the minimum amount of time, in seconds, between manifest update
 * requests.
 *
 * @private
 * @const {number}
 */
shaka.dash.DashParser.MIN_UPDATE_PERIOD_ = 3;


/**
 * @typedef {
 *   function(!Array.<string>, ?number, ?number):!Promise.<BufferSource>
 * }
 */
shaka.dash.DashParser.RequestInitSegmentCallback;


/**
 * @typedef {{
 *   segmentBase: Element,
 *   segmentList: Element,
 *   segmentTemplate: Element,
 *   baseUris: !Array.<string>,
 *   width: (number|undefined),
 *   height: (number|undefined),
 *   contentType: string,
 *   mimeType: string,
 *   codecs: string,
 *   frameRate: (number|undefined),
 *   emsgSchemeIdUris: !Array.<string>,
 *   id: ?string,
 *   numChannels: ?number,
 *   audioSamplingRate: ?number
 * }}
 *
 * @description
 * A collection of elements and properties which are inherited across levels
 * of a DASH manifest.
 *
 * @property {Element} segmentBase
 *   The XML node for SegmentBase.
 * @property {Element} segmentList
 *   The XML node for SegmentList.
 * @property {Element} segmentTemplate
 *   The XML node for SegmentTemplate.
 * @property {!Array.<string>} baseUris
 *   An array of absolute base URIs for the frame.
 * @property {(number|undefined)} width
 *   The inherited width value.
 * @property {(number|undefined)} height
 *   The inherited height value.
 * @property {string} contentType
 *   The inherited media type.
 * @property {string} mimeType
 *   The inherited MIME type value.
 * @property {string} codecs
 *   The inherited codecs value.
 * @property {(number|undefined)} frameRate
 *   The inherited framerate value.
 * @property {!Array.<string>} emsgSchemeIdUris
 *   emsg registered schemeIdUris.
 * @property {?string} id
 *   The ID of the element.
 * @property {?number} numChannels
 *   The number of audio channels, or null if unknown.
 * @property {?number} audioSamplingRate
 *   Specifies the maximum sampling rate of the content, or null if unknown.
 */
shaka.dash.DashParser.InheritanceFrame;


/**
 * @typedef {{
 *   dynamic: boolean,
 *   presentationTimeline: !shaka.media.PresentationTimeline,
 *   period: ?shaka.dash.DashParser.InheritanceFrame,
 *   periodInfo: ?shaka.dash.DashParser.PeriodInfo,
 *   adaptationSet: ?shaka.dash.DashParser.InheritanceFrame,
 *   representation: ?shaka.dash.DashParser.InheritanceFrame,
 *   bandwidth: number,
 *   indexRangeWarningGiven: boolean
 * }}
 *
 * @description
 * Contains context data for the streams.  This is designed to be
 * shallow-copyable, so the parser must overwrite (not modify) each key as the
 * parser moves through the manifest and the parsing context changes.
 *
 * @property {boolean} dynamic
 *   True if the MPD is dynamic (not all segments available at once)
 * @property {!shaka.media.PresentationTimeline} presentationTimeline
 *   The PresentationTimeline.
 * @property {?shaka.dash.DashParser.InheritanceFrame} period
 *   The inheritance from the Period element.
 * @property {?shaka.dash.DashParser.PeriodInfo} periodInfo
 *   The Period info for the current Period.
 * @property {?shaka.dash.DashParser.InheritanceFrame} adaptationSet
 *   The inheritance from the AdaptationSet element.
 * @property {?shaka.dash.DashParser.InheritanceFrame} representation
 *   The inheritance from the Representation element.
 * @property {number} bandwidth
 *   The bandwidth of the Representation, or zero if missing.
 * @property {boolean} indexRangeWarningGiven
 *   True if the warning about SegmentURL@indexRange has been printed.
 */
shaka.dash.DashParser.Context;


/**
 * @typedef {{
 *   start: number,
 *   duration: ?number,
 *   node: !Element,
 *   isLastPeriod: boolean
 * }}
 *
 * @description
 * Contains information about a Period element.
 *
 * @property {number} start
 *   The start time of the period.
 * @property {?number} duration
 *   The duration of the period; or null if the duration is not given.  This
 *   will be non-null for all periods except the last.
 * @property {!Element} node
 *   The XML Node for the Period.
 * @property {boolean} isLastPeriod
 *   Whether this Period is the last one in the manifest.
 */
shaka.dash.DashParser.PeriodInfo;


/**
 * @typedef {{
 *   id: string,
 *   contentType: ?string,
 *   language: string,
 *   main: boolean,
 *   streams: !Array.<shaka.extern.Stream>,
 *   drmInfos: !Array.<shaka.extern.DrmInfo>,
 *   trickModeFor: ?string,
 *   representationIds: !Array.<string>
 * }}
 *
 * @description
 * Contains information about an AdaptationSet element.
 *
 * @property {string} id
 *   The unique ID of the adaptation set.
 * @property {?string} contentType
 *   The content type of the AdaptationSet.
 * @property {string} language
 *   The language of the AdaptationSet.
 * @property {boolean} main
 *   Whether the AdaptationSet has the 'main' type.
 * @property {!Array.<shaka.extern.Stream>} streams
 *   The streams this AdaptationSet contains.
 * @property {!Array.<shaka.extern.DrmInfo>} drmInfos
 *   The DRM info for the AdaptationSet.
 * @property {?string} trickModeFor
 *   If non-null, this AdaptationInfo represents trick mode tracks.  This
 *   property is the ID of the normal AdaptationSet these tracks should be
 *   associated with.
 * @property {!Array.<string>} representationIds
 *   An array of the IDs of the Representations this AdaptationSet contains.
 */
shaka.dash.DashParser.AdaptationInfo;


/**
 * @typedef {function():!Promise.<shaka.media.SegmentIndex>}
 * @description
 * An async function which generates and returns a SegmentIndex.
 */
shaka.dash.DashParser.GenerateSegmentIndexFunction;


/**
 * @typedef {{
 *   generateSegmentIndex: shaka.dash.DashParser.GenerateSegmentIndexFunction
 * }}
 *
 * @description
 * Contains information about a Stream. This is passed from the createStreamInfo
 * methods.
 *
 * @property {shaka.dash.DashParser.GenerateSegmentIndexFunction}
 *     generateSegmentIndex
 *   An async function to create the SegmentIndex for the stream.
 */
shaka.dash.DashParser.StreamInfo;


shaka.media.ManifestParser.registerParserByExtension(
    'mpd', shaka.dash.DashParser);
shaka.media.ManifestParser.registerParserByMime(
    'application/dash+xml', shaka.dash.DashParser);
shaka.media.ManifestParser.registerParserByMime(
    'video/vnd.mpeg.dash.mpd', shaka.dash.DashParser);
