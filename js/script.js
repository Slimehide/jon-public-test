


$(function () {
   var runtime = window.__auroraRuntime = window.__auroraRuntime || {};
  runtime.qualityState = runtime.qualityState || {
    tier: 'full',
    rocketLimit: 3,
    rocketTrailMode: 'full',
    rocketLoadScale: 0.86
  };
  runtime.performance = runtime.performance || {};
  runtime.performance.rocket = runtime.performance.rocket || null;

  window.__rocketLaunchState = window.__rocketLaunchState || {
    active: 0,
    progress: 0,
    activeCount: 0,
    arcRotationDeg: 18.2,
    launches: [],
    shaderLaunches: []
  };

  (function initLaunchButtonRocketTrigger() {
    var $launchButtons = $('.btn');
    var launchDurationMs = 14040;
    var rafId = 0;
    var $launchRoot = $('.rocket-launch');
    var launchScene = document.getElementById('rocketLaunchScene');
    var launchPathTemplate = document.getElementById('rocketLaunchPath');
    var launchInstances = document.getElementById('rocketLaunchInstances');
    var activeLaunches = [];
    var queuedLaunches = [];
    var launchId = 0;
    var lastRocketFrame = 0;
    var lastLaunchStartedAt = 0;
    var lastLaunchIntentAt = 0;
    var templatePathPoints = [];
    var shaderRocketLimit = 1;
    var trailOpacityByType = {
      'rocket-launch__trail--wake': 0.16,
      'rocket-launch__trail--mist': 0.09,
      'rocket-launch__trail--smoke': 0.24,
      'rocket-launch__trail--core': 0.5,
      'rocket-launch__trail--sun': 0.16
    };

    if (!$launchButtons.length || !$launchRoot.length || !launchScene || !launchPathTemplate || !launchInstances) return;

    function easeOutCubic(t) {
      return 1 - Math.pow(1 - t, 3);
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    function lerp(start, end, amount) {
      return start + (end - start) * amount;
    }

    function ensureRocketSampler() {
      if (runtime.performance.rocket) return runtime.performance.rocket;

      runtime.performance.rocket = {
        label: 'rocket',
        frameTimes: [],
        sampleSize: 180,
        summary: null
      };

      return runtime.performance.rocket;
    }

    function samplePerf(perfState, deltaMs) {
      if (!runtime.perfEnabled || !perfState || !isFinite(deltaMs) || deltaMs <= 0 || deltaMs > 250) return;

      perfState.frameTimes.push(deltaMs);

      if (perfState.frameTimes.length > perfState.sampleSize) {
        perfState.frameTimes.shift();
      }

      if (perfState.frameTimes.length < 18) return;

      var sorted = perfState.frameTimes.slice().sort(function (a, b) { return a - b; });
      var median = sorted[Math.floor(sorted.length * 0.5)];
      var p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];

      perfState.summary = {
        medianMs: median,
        p95Ms: p95,
        fps: 1000 / Math.max(median, 0.001)
      };

      if (runtime.performance.updateHud) {
        runtime.performance.updateHud();
      }
    }

    function getQualityState() {
      return runtime.qualityState || {
        tier: 'full',
        rocketLimit: 3,
        rocketTrailMode: 'full',
        rocketLoadScale: 0.86
      };
    }

    function getLaunchSpacingMs() {
      var tier = getQualityState().tier;

      if (tier === 'minimal') return 2600;
      if (tier === 'reduced') return 1650;
      return 950;
    }

    function getQueueExpiryMs() {
      var tier = getQualityState().tier;

      if (tier === 'minimal') return 1400;
      if (tier === 'reduced') return 1200;
      return 1050;
    }

    function applyArcRotation(value) {
      var rotation = clamp(parseFloat(value) || 0, -25, 25);
      window.__rocketLaunchState.arcRotationDeg = rotation;
      launchScene.setAttribute('transform', 'rotate(' + rotation.toFixed(2) + ' 1188 944)');
    }

    function computeTemplatePoints(sampleCount) {
      var totalLength = launchPathTemplate.getTotalLength();
      var points = [];
      var index;

      for (index = 0; index < sampleCount; index += 1) {
        var distance = totalLength * (index / Math.max(sampleCount - 1, 1));
        var point = launchPathTemplate.getPointAtLength(distance);
        points.push({
          x: point.x,
          y: point.y
        });
      }

      return points.map(function (point, index) {
        var prev = points[Math.max(0, index - 1)];
        var next = points[Math.min(points.length - 1, index + 1)];
        var dx = next.x - prev.x;
        var dy = next.y - prev.y;
        var length = Math.hypot(dx, dy) || 1;

        return {
          x: point.x,
          y: point.y,
          normalX: -dy / length,
          normalY: dx / length,
          t: index / Math.max(points.length - 1, 1)
        };
      });
    }

    function buildPathData(startOffsetX, jitterPx, endDriftX, endDriftY) {
      return templatePathPoints.map(function (point, index) {
        var lift = Math.sin(point.t * Math.PI) * jitterPx * (0.4 + point.t * 0.6);
        var startShift = Math.pow(1 - point.t, 0.78) * startOffsetX;
        var driftX = Math.pow(point.t, 1.7) * endDriftX;
        var driftY = Math.pow(point.t, 1.42) * endDriftY;
        var x = point.x + startShift + point.normalX * lift + driftX;
        var y = point.y + point.normalY * lift + driftY;
        var prefix = index === 0 ? 'M ' : ' L ';
        return prefix + x.toFixed(2) + ' ' + y.toFixed(2);
      }).join('');
    }

    function applyTrailMode(launch) {
      var tier = getQualityState().rocketTrailMode || 'full';
      var isSecondary = launch.visualTier === 'secondary';

      launch.appliedTier = tier;

      launch.trailNodes.forEach(function (node) {
        var hideNode = false;

        if (tier === 'reduced' && (node.classList.contains('rocket-launch__trail--wake') || node.classList.contains('rocket-launch__trail--mist') || node.classList.contains('rocket-launch__trail--sun'))) {
          hideNode = true;
        }

        if (tier === 'minimal' && !node.classList.contains('rocket-launch__trail--core') && !node.classList.contains('rocket-launch__trail--smoke')) {
          hideNode = true;
        }

        if (isSecondary && (node.classList.contains('rocket-launch__trail--wake') || node.classList.contains('rocket-launch__trail--mist') || node.classList.contains('rocket-launch__trail--sun'))) {
          hideNode = true;
        }

        node.style.display = hideNode ? 'none' : '';

        if ((tier === 'minimal' || isSecondary) && node.classList.contains('rocket-launch__trail--smoke')) {
          node.style.filter = 'none';
        }
      });

      if (tier !== 'full' || isSecondary) {
        launch.padHazes.forEach(function (node, index) {
          node.style.display = (tier === 'minimal' || isSecondary) ? 'none' : (index > 0 ? '' : '');
          if (tier === 'minimal' || isSecondary) {
            node.style.filter = 'none';
          }
        });

        launch.padSmokes.forEach(function (node, index) {
          node.style.display = (tier === 'minimal' || isSecondary) ? 'none' : (index > 0 ? '' : '');
          if (tier === 'minimal' || isSecondary) {
            node.style.filter = 'none';
          }
        });

        if (tier === 'minimal' || isSecondary) {
          launch.glow.style.display = 'none';
        }
      }

      if (isSecondary) {
        launch.opacityScale = 0.64;
      }
    }

    function createLaunch(now, visualTier) {
      var quality = getQualityState();
      var launchNode = launchScene.cloneNode(true);
      var angleVarianceMultiplier = 1.1;
      var rotationJitter = (Math.random() * 5.6 - 2.8) * angleVarianceMultiplier;
      var pathJitterScale = quality.tier === 'minimal' ? 0.5 : quality.tier === 'reduced' ? 0.8 : 1;
      var startOffsetX = (Math.random() * 192 - 96) * pathJitterScale;
      var jitterPx = (Math.random() * 44.8 - 22.4) * pathJitterScale;
      var endDriftX = (Math.random() * 84 - 42) * pathJitterScale;
      var endDriftY = (Math.random() * 26.4 - 13.2) * pathJitterScale;
      var startXNorm = clamp((1188 + startOffsetX) / 1440, 0.12, 0.88);
      var swayNorm = clamp(0.12 + jitterPx / 260, -0.22, 0.22);
      var endXNorm = clamp(-0.98 + endDriftX / 580, -1.16, -0.78);
      var mainPath;

      launchNode.removeAttribute('id');
      launchNode.classList.remove('rocket-launch__template');
      launchNode.setAttribute('aria-hidden', 'true');
      launchNode.setAttribute('transform', 'rotate(' + (window.__rocketLaunchState.arcRotationDeg + rotationJitter).toFixed(2) + ' 1188 944)');

      mainPath = launchNode.querySelector('.rocket-launch__path-model');
      if (!mainPath) return null;

      mainPath.removeAttribute('id');

      var pathData = buildPathData(startOffsetX, jitterPx, endDriftX, endDriftY);
      var trailNodes = Array.prototype.slice.call(launchNode.querySelectorAll('.rocket-launch__trail'));
      var padHazes = Array.prototype.slice.call(launchNode.querySelectorAll('.rocket-launch__pad-haze'));
      var padSmokes = Array.prototype.slice.call(launchNode.querySelectorAll('.rocket-launch__pad-smoke'));
      var ember = launchNode.querySelector('.rocket-launch__ember');
      var glow = launchNode.querySelector('.rocket-launch__ember-glow');

      mainPath.setAttribute('d', pathData);
      trailNodes.forEach(function (node) {
        node.setAttribute('d', pathData);
      });

      launchInstances.appendChild(launchNode);

      var launch = {
        id: ++launchId,
        node: launchNode,
        path: mainPath,
        totalLength: mainPath.getTotalLength(),
        trailNodes: trailNodes,
        trailLengths: trailNodes.map(function (node) { return node.getTotalLength(); }),
        padHazes: padHazes,
        padSmokes: padSmokes,
        ember: ember,
        glow: glow,
        startTime: now,
        durationMs: launchDurationMs,
        rotationDeg: window.__rocketLaunchState.arcRotationDeg + rotationJitter,
        startXNorm: startXNorm,
        swayNorm: swayNorm,
        endXNorm: endXNorm,
        progress: 0,
        visualTier: visualTier || 'lead',
        opacityScale: visualTier === 'secondary' ? 0.64 : 1,
        blocksSlot: true,
        releasedAt: 0
      };

      applyTrailMode(launch);
      resetLaunchVisuals(launch);

      return launch;
    }

    function setTrailFrame(launch, progress, now) {
      var trailFade = progress < 0.015 ? progress / 0.015 : progress > 0.76 ? 1 - ((progress - 0.76) / 0.18) : 1;
      var releaseFade = 1;

      if (launch.releasedAt) {
        releaseFade = clamp(1 - ((now - launch.releasedAt) / 700), 0, 1);
      }

      launch.trailNodes.forEach(function (node, index) {
        var pathLength = launch.trailLengths[index];
        var visibleLength = clamp(progress, 0, 1) * pathLength;
        var opacity = 0;

        Object.keys(trailOpacityByType).some(function (className) {
          if (node.classList.contains(className)) {
            opacity = trailOpacityByType[className];
            return true;
          }
          return false;
        });

        if (node.style.display === 'none') return;

        node.style.strokeDasharray = visibleLength.toFixed(3) + ' ' + pathLength.toFixed(3);
        node.style.opacity = (opacity * launch.opacityScale * clamp(trailFade, 0, 1) * releaseFade).toFixed(3);
      });
    }

    function setRocketFrame(launch, progress) {
      var point = launch.path.getPointAtLength(launch.totalLength * progress);
      var emberOpacity = progress < 0.02 ? progress / 0.02 : progress > 0.74 ? 1 - ((progress - 0.74) / 0.16) : 1;
      var glowOpacity = progress < 0.02 ? progress / 0.02 : progress > 0.68 ? 1 - ((progress - 0.68) / 0.16) : 1;

      launch.ember.setAttribute('transform', 'translate(' + point.x + ' ' + point.y + ')');
      launch.glow.setAttribute('transform', 'translate(' + point.x + ' ' + point.y + ')');
      launch.ember.style.opacity = (0.92 * launch.opacityScale * clamp(emberOpacity, 0, 1)).toFixed(3);

      if (launch.glow.style.display !== 'none') {
        launch.glow.style.opacity = (0.32 * launch.opacityScale * clamp(glowOpacity, 0, 1)).toFixed(3);
      }

      return point;
    }

    function animatePadEffects(launch, rawProgress) {
      function padHazeFrame(phase) {
        if (phase <= 0.01 || phase >= 0.32) return { opacity: 0, scale: 2.4 };
        if (phase < 0.06) return { opacity: lerp(0, 0.18, (phase - 0.01) / 0.05), scale: lerp(0.72, 1, (phase - 0.01) / 0.05) };
        if (phase < 0.18) return { opacity: lerp(0.18, 0.1, (phase - 0.06) / 0.12), scale: lerp(1, 1.7, (phase - 0.06) / 0.12) };
        return { opacity: lerp(0.1, 0, (phase - 0.18) / 0.14), scale: lerp(1.7, 2.4, (phase - 0.18) / 0.14) };
      }

      function padSmokeFrame(phase) {
        if (phase <= 0.02 || phase >= 0.34) return { opacity: 0, scale: 2.3, translateY: -24 };
        if (phase < 0.08) return { opacity: lerp(0, 0.2, (phase - 0.02) / 0.06), scale: lerp(0.82, 1, (phase - 0.02) / 0.06), translateY: lerp(0, -2, (phase - 0.02) / 0.06) };
        if (phase < 0.2) return { opacity: lerp(0.2, 0.16, (phase - 0.08) / 0.12), scale: lerp(1, 1.42, (phase - 0.08) / 0.12), translateY: lerp(-2, -8, (phase - 0.08) / 0.12) };
        return { opacity: lerp(0.16, 0, (phase - 0.2) / 0.14), scale: lerp(1.42, 2.3, (phase - 0.2) / 0.14), translateY: lerp(-8, -24, (phase - 0.2) / 0.14) };
      }

      var hazeCore = padHazeFrame(rawProgress);
      var hazeWide = padHazeFrame(rawProgress - 0.009);
      var smokeCenter = padSmokeFrame(rawProgress - 0.006);
      var smokeLeft = padSmokeFrame(rawProgress - 0.013);
      var smokeRight = padSmokeFrame(rawProgress - 0.019);

      if (launch.padHazes[0]) {
        launch.padHazes[0].style.opacity = (hazeCore.opacity * launch.opacityScale).toFixed(3);
        launch.padHazes[0].style.transform = 'scale(' + hazeCore.scale.toFixed(3) + ')';
      }

      if (launch.padHazes[1] && launch.padHazes[1].style.display !== 'none') {
        launch.padHazes[1].style.opacity = (hazeWide.opacity * launch.opacityScale).toFixed(3);
        launch.padHazes[1].style.transform = 'scale(' + hazeWide.scale.toFixed(3) + ')';
      }

      if (launch.padSmokes[0]) {
        launch.padSmokes[0].style.opacity = (smokeLeft.opacity * launch.opacityScale).toFixed(3);
        launch.padSmokes[0].style.transform = 'scale(' + smokeLeft.scale.toFixed(3) + ') translateY(' + smokeLeft.translateY.toFixed(2) + 'px)';
      }

      if (launch.padSmokes[1] && launch.padSmokes[1].style.display !== 'none') {
        launch.padSmokes[1].style.opacity = (smokeRight.opacity * launch.opacityScale).toFixed(3);
        launch.padSmokes[1].style.transform = 'scale(' + smokeRight.scale.toFixed(3) + ') translateY(' + smokeRight.translateY.toFixed(2) + 'px)';
      }

      if (launch.padSmokes[2] && launch.padSmokes[2].style.display !== 'none') {
        launch.padSmokes[2].style.opacity = (smokeCenter.opacity * launch.opacityScale).toFixed(3);
        launch.padSmokes[2].style.transform = 'scale(' + smokeCenter.scale.toFixed(3) + ') translateY(' + smokeCenter.translateY.toFixed(2) + 'px)';
      }
    }

    function resetLaunchVisuals(launch) {
      launch.trailNodes.forEach(function (node, index) {
        var pathLength = launch.trailLengths[index];
        node.style.strokeDasharray = '0 ' + pathLength.toFixed(3);
        node.style.opacity = '0';
      });

      launch.padHazes.forEach(function (node) {
        node.style.opacity = '0';
        node.style.transform = 'scale(.72)';
      });

      launch.padSmokes.forEach(function (node) {
        node.style.opacity = '0';
        node.style.transform = 'scale(.82) translateY(0)';
      });

      launch.ember.style.opacity = '0';
      launch.glow.style.opacity = '0';
    }

    function syncRocketState() {
      var quality = getQualityState();
      var liveLaunches = activeLaunches.filter(function (launch) {
        return launch.blocksSlot;
      });
      var shaderLimit = Math.max(1, Math.min(shaderRocketLimit, quality.rocketLimit || 1));
      var shaderLaunches = liveLaunches.slice().sort(function (a, b) {
        return b.progress - a.progress;
      }).slice(0, shaderLimit).map(function (launch, index) {
        return {
          progress: launch.progress,
          active: 1,
          rotationDeg: launch.rotationDeg,
          startXNorm: launch.startXNorm,
          swayNorm: launch.swayNorm,
          endXNorm: launch.endXNorm,
          weight: Math.max(0.24, 0.84 - index * 0.24)
        };
      });

      window.__rocketLaunchState.activeCount = liveLaunches.length;
      window.__rocketLaunchState.active = liveLaunches.length > 0 ? 1 : 0;
      window.__rocketLaunchState.progress = shaderLaunches.length ? shaderLaunches[0].progress : 0;
      window.__rocketLaunchState.launches = activeLaunches.map(function (launch) {
        return {
          id: launch.id,
          progress: launch.progress,
          rotationDeg: launch.rotationDeg,
          startXNorm: launch.startXNorm,
          swayNorm: launch.swayNorm,
          endXNorm: launch.endXNorm,
          blocksSlot: launch.blocksSlot
        };
      });
      window.__rocketLaunchState.shaderLaunches = shaderLaunches;
      runtime.activeRocketCount = liveLaunches.length;
      runtime.rocketLoad = liveLaunches.length > 0 ? quality.rocketLoadScale : 1;

      if (runtime.performance.updateHud) {
        runtime.performance.updateHud();
      }
    }

    function maybeStartQueuedLaunch(now) {
      var quality = getQualityState();
      var spacingMs = getLaunchSpacingMs();
      var occupiedSlots = activeLaunches.filter(function (launch) {
        return launch.blocksSlot;
      }).length;

      while (queuedLaunches.length && queuedLaunches[0].expiresAt <= now) {
        queuedLaunches.shift();
      }

      while (queuedLaunches.length && occupiedSlots < (quality.rocketLimit || 1)) {
        if (lastLaunchStartedAt && now - lastLaunchStartedAt < spacingMs) {
          break;
        }

        var launch = createLaunch(now, activeLaunches.length === 0 ? 'lead' : 'secondary');

        if (!launch) {
          queuedLaunches.shift();
          continue;
        }

        queuedLaunches.shift();
        lastLaunchStartedAt = now;
        activeLaunches.push(launch);
        occupiedSlots += 1;
      }
    }

    function removeLaunch(launch) {
      if (launch.node && launch.node.parentNode) {
        launch.node.parentNode.removeChild(launch.node);
      }
    }

    function renderLaunch(now) {
      var perfState = ensureRocketSampler();
      var index;

      if (lastRocketFrame) {
        samplePerf(perfState, now - lastRocketFrame);
      }
      lastRocketFrame = now;

      maybeStartQueuedLaunch(now);

      for (index = activeLaunches.length - 1; index >= 0; index -= 1) {
        var launch = activeLaunches[index];
        var rawProgress = clamp((now - launch.startTime) / launch.durationMs, 0, 1);
        var progress = easeOutCubic(rawProgress);
        var point;

        launch.progress = progress;
        setTrailFrame(launch, progress, now);
        point = setRocketFrame(launch, progress);
        animatePadEffects(launch, rawProgress);

        if (launch.blocksSlot && point && (point.y < -24 || point.x < -64 || point.x > 1504 || rawProgress >= 0.82)) {
          launch.blocksSlot = false;
          launch.releasedAt = now;
          launch.ember.style.opacity = '0';
          launch.glow.style.opacity = '0';
        }

        if ((launch.releasedAt && now - launch.releasedAt > 750) || rawProgress >= 0.9) {
          activeLaunches.splice(index, 1);
          removeLaunch(launch);
        }
      }

      syncRocketState();

      if (activeLaunches.length || queuedLaunches.length) {
        rafId = requestAnimationFrame(renderLaunch);
        return;
      }

      rafId = 0;
      lastRocketFrame = 0;
    }

    function triggerLaunch() {
      var now = performance.now();

      if (now - lastLaunchIntentAt < 180) {
        return;
      }

      lastLaunchIntentAt = now;

      if (queuedLaunches.length > 5) {
        return;
      }

      queuedLaunches.push({
        queuedAt: now,
        expiresAt: now + getQueueExpiryMs()
      });

      maybeStartQueuedLaunch(now);
      syncRocketState();

      if (!rafId) {
        lastRocketFrame = 0;
        rafId = requestAnimationFrame(renderLaunch);
      }
    }

    templatePathPoints = computeTemplatePoints(24);
    applyArcRotation(window.__rocketLaunchState.arcRotationDeg);
    syncRocketState();
    $launchButtons.on('pointerenter', triggerLaunch);
  })();

  (function initFooterEmailCopy() {
    var $email = $('.footer-email');
    var $button = $email.find('.footer-email__button');
    var toastTimer = null;

    if (!$email.length || !$button.length) return;

    function fallbackCopy(text) {
      var textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'absolute';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }

    function showToast() {
      $email.addClass('copied');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        $email.removeClass('copied');
      }, 1200);
    }

    $button.on('click', function () {
      var email = $(this).data('copy-email');

      if (!email) return;

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(email).then(showToast).catch(function () {
          fallbackCopy(email);
          showToast();
        });
        return;
      }

      fallbackCopy(email);
      showToast();
    });
  })();






  var CURSOR_MODE = 'drag-cursor';

  var $pageScroll = $('.page-scroll');

  function capPageScroll() {
    $pageScroll.css('max-height', 'none');
    $pageScroll.css('max-height', $pageScroll[0].scrollHeight + 'px');
  }
  capPageScroll();
  $(window).on('resize', capPageScroll);

  (function fixMobileScroll() {
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    var isAndroid = /Android/.test(navigator.userAgent);
    if (!isIOS && !isAndroid) return;

    var buffer = 50;
    $('footer').css('padding-bottom', (40 + buffer) + 'px');

    function setScrollHeight() {
      $pageScroll.css('height', window.innerHeight + 'px');
      capPageScroll();
    }
    setScrollHeight();
    $(window).on('resize', setScrollHeight);
  })();

  (function initAddItemAnimation() {
    var $middle = $('.bottom__info .middle');
    var $ul = $middle.find('ul');
    var $cursor = $('.fake-cursor');
    var $countSpan = $('.bottom__info>.left>h2 .folder-count');
    var played = false;

    if (!$ul.length || !$cursor.length || !$countSpan.length) return;

    var $cursorArrow = $cursor.find('.cursor-arrow');
    var $cursorDrag = $cursor.find('.cursor-drag');

    function showDragIcon() {
      if (CURSOR_MODE === 'drag-cursor') {
        $cursorArrow.hide();
        $cursorDrag.show();
      }
    }
    function showArrowIcon() {
      $cursorDrag.hide();
      $cursorArrow.show();
    }

    function wait(ms) {
      return new Promise(function (r) { setTimeout(r, ms); });
    }

    function easeInOutCubic(t) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }
    function easeInCubic(t) {
      return t * t * t;
    }

    function quadBez(t, p0, p1, p2) {
      var mt = 1 - t;
      return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2;
    }

    function animatePath(items, pts, cp, dur, ease, onProgress) {
      return new Promise(function (resolve) {
        var t0 = null;
        function step(ts) {
          if (!t0) t0 = ts;
          var p = Math.min((ts - t0) / dur, 1);
          var e = ease(p);
          var x = quadBez(e, pts.sx, cp.x, pts.ex);
          var y = quadBez(e, pts.sy, cp.y, pts.ey);
          items.forEach(function (it) {
            it.$el.css('transform', 'translate(' + (x + it.offsetX) + 'px,' + (y + it.offsetY) + 'px)');
          });
          if (onProgress) onProgress(p, x, y);
          if (p < 1) requestAnimationFrame(step); else resolve();
        }
        requestAnimationFrame(step);
      });
    }

    function tickCounter(from, to) {
      var $s = $countSpan;
      var w = $s.outerWidth();
      var h = $s.outerHeight();
      $s.css({ width: w + 'px', height: h + 'px' });

      var $old = $('<span class="counter-digit old-digit">' + from + '</span>');
      var $new = $('<span class="counter-digit tick-in-ready">' + to + '</span>');
      $s.empty().append($old).append($new);
      void $s[0].offsetHeight;

      return new Promise(function (resolve) {
        $old.addClass('tick-out');
        $new.removeClass('tick-in-ready').addClass('tick-in');
        setTimeout(function () {
          $s.empty().text(to).css({ width: '', height: '' });
          resolve();
        }, 220);
      });
    }

    async function playAnimation() {
      if (played) return;
      played = true;

      var scrollEl = $pageScroll[0];
      var scrollX = scrollEl.scrollLeft || 0;
      var scrollY = scrollEl.scrollTop || 0;

      var ulRect = $ul[0].getBoundingClientRect();
      var wrapRect = scrollEl.getBoundingClientRect();
      var ulLeft = ulRect.left - wrapRect.left + scrollX;
      var ulBottom = ulRect.bottom - wrapRect.top + scrollY;
      var ulWidth = $ul.outerWidth();
      var margin = 8;
      var targetFloatX = ulLeft;
      var targetFloatY = ulBottom + margin;

      var cursorOffX = ulWidth / 2;
      var cursorOffY = 5;
      var targetCX = targetFloatX + cursorOffX;
      var targetCY = targetFloatY + cursorOffY;

      var vpW = scrollEl.clientWidth;
      var startCX = vpW + scrollX + ulWidth + 50;
      var startCY = targetCY + 300;

      var exitCX = scrollX - 60;
      var exitCY = targetCY - 100;

      var $bottom = $('.bottom__info');
      var sectionH = $bottom.outerHeight();
      $bottom.css({ height: sectionH + 'px', transition: 'height .35s cubic-bezier(.25,.1,.25,1)' });

      var currentUlH = $ul.outerHeight();
      $ul.css({ height: currentUlH + 'px', overflow: 'hidden' });

      var $float = $('<div class="floating-new-item">' +
        '<div class="left"><p>🗃️ Projects</p></div>' +
        '<div class="right"><p>My <span>6</span> projects</p></div>' +
        '</div>');
      $pageScroll.append($float);
      $float.css({
        top: 0, left: 0, opacity: 1,
        transition: 'none',
        transform: 'translate(' + (startCX - cursorOffX) + 'px,' + (startCY - cursorOffY) + 'px)',
        width: ulWidth + 'px'
      });

      showDragIcon();
      $cursor.css({ opacity: 1, transition: 'none' });
      $cursor.css('transform', 'translate(' + startCX + 'px,' + startCY + 'px)');

      await wait(50);

      var cpEntryX = targetCX + (startCX - targetCX) * 0.45;
      var cpEntryY = targetCY + (startCY - targetCY) * 0.15;

      var dockDone = false;
      var thresholdY = targetFloatY + 15;

      function triggerDock() {
        if (dockDone) return;
        dockDone = true;

        var $docked = $('<li class="new-item-docked">' +
          '<div class="left"><p>🗃️ Projects</p></div>' +
          '<div class="right"><p>My <span>6</span> projects</p></div>' +
          '</li>');
        $ul.append($docked);

        $ul.css({ height: 'auto' });
        var newUlH = $ul.outerHeight();
        $ul.css({ height: currentUlH + 'px' });
        void $ul[0].offsetHeight;
        $ul.addClass('animating-height');
        void $ul[0].offsetHeight;
        $ul.css({ height: newUlH + 'px' });

        var heightDiff = newUlH - currentUlH;
        $bottom.css({ height: (sectionH + heightDiff) + 'px' });

        var currentMax = parseFloat($pageScroll.css('max-height')) || 0;
        $pageScroll.css({ 'max-height': (currentMax + heightDiff) + 'px', transition: 'max-height .35s cubic-bezier(.25,.1,.25,1)' });

        tickCounter('4', '5');
      }

      await animatePath(
        [
          { $el: $cursor, offsetX: 0, offsetY: 0 },
          { $el: $float, offsetX: -cursorOffX, offsetY: -cursorOffY }
        ],
        { sx: startCX, sy: startCY, ex: targetCX, ey: targetCY },
        { x: cpEntryX, y: cpEntryY },
        2800,
        easeInOutCubic,
        function (p, x, y) {
          var floatY = y - cursorOffY;
          if (!dockDone && floatY <= thresholdY) {
            triggerDock();
          }
        }
      );

      showArrowIcon();
      $('.new-item-docked').addClass('visible');
      $float.remove();

      await wait(10);
      $ul.removeClass('animating-height').css({ height: '', overflow: '' });
      $bottom.css({ height: '', transition: '' });
      $pageScroll.css('transition', '');
      capPageScroll();

      await wait(375);

      var cpExitX = targetCX * 0.35 + exitCX * 0.65;
      var cpExitY = targetCY - 60;

      await animatePath(
        [{ $el: $cursor, offsetX: 0, offsetY: 0 }],
        { sx: targetCX, sy: targetCY, ex: exitCX, ey: exitCY },
        { x: cpExitX, y: cpExitY },
        2000,
        easeInCubic
      );

      $cursor.css({ opacity: 0 });
    }

    function checkScroll() {
      if (played) return;
      var rect = $middle[0].getBoundingClientRect();
      var vpH = window.innerHeight;
      console.log();
      if (($(".page-scroll").scrollTop() + $(window).height()) > ($('.bottom__controls').offset().top + $('.page-scroll').scrollTop()) + 50) {
        $pageScroll.off('scroll.addItemAnim');
        $(window).off('resize.addItemAnim');
        setTimeout(function () { playAnimation(); }, 600);
      }
    }
    $pageScroll.on('scroll.addItemAnim', checkScroll);
    $(window).on('resize.addItemAnim', checkScroll);
    checkScroll();
  })();

  const players = [];

  function resetToMuted(entry) {
    entry.player.setCurrentTime(0);
    entry.player.setVolume(0);
    entry.player.setLoop(true);
    entry.player.play();
    entry.isActive = false;
    $(entry.box).find('.icon-play').show();
    $(entry.box).find('.icon-pause').hide();
  }
  $('body').on("click" , '.video__box.playing' , function(e){
    e.preventDefault();
    $('.video__btn').click();
    $('.video__box').removeClass("playing");
  })
  $('.video__box').each(function () {
    const $box = $(this);
    const vimeoId = $box.data('vimeo-id');
    const hash = $box.data('vimeo-hash');
    const $iframe = $(`
      <iframe
        src="https://player.vimeo.com/video/${vimeoId}?h=${hash}&background=1&controls=0&autopause=0"
        frameborder="0"
        allow="autoplay; fullscreen"
      ></iframe>
    `);
    $box.append($iframe);

    var _origError = console.error;
    console.error = function () {};
    const player = new Vimeo.Player($iframe[0]);
    console.error = _origError;
    const entry = { box: this, player, isActive: false };
    players.push(entry);

    player.ready().then(function () {
      player.setVolume(0);
      player.setLoop(true);
      player.play();
    });

    player.on('ended', function () {
      if (entry.isActive) {
        resetToMuted(entry);
      }
    });

    $box.find('.video__btn').on('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (entry.isActive) {
        entry.player.getPaused().then(function (paused) {
          if (paused) {
            entry.player.play();
            $box.find('.icon-play').hide();
            $box.find('.icon-pause').show();
          } else {
            entry.player.pause();
            $box.find('.icon-play').show();
            $box.find('.icon-pause').hide();
          }
        });
      } else {
        players.forEach(function (other) {
          if (other !== entry && other.isActive) {
            resetToMuted(other);
          }
        });
        $('.video__box').addClass("playing");
        $box.find(".video__btn").addClass('playing');
        entry.player.setCurrentTime(0);
        entry.player.setVolume(1);
        entry.player.setLoop(false);
        entry.player.play();
        entry.isActive = true;
        $box.find('.icon-play').hide();
        $box.find('.icon-pause').show();
      }
    });
  });


  (function initProjectPopup() {

    var PROJECTS = [
      { emoji: '⚽', title: 'The Premier League', description: 'Write like a document, calculate like a spreadsheet. Turn messy information into structured pages.', videoSrc: 'videos/img_6197.mov', downloadUrl: '#' },
      { emoji: '🔴', title: 'The Pokedex', description: 'A living encyclopedia of every known Pokémon. Browse stats, evolutions, and types across all generations.', videoSrc: 'videos/img_6198.mov', downloadUrl: '#' },
      { emoji: '💸', title: 'S&P 500 Tracker', description: 'Real-time market overview of all S&P 500 companies. Track prices, sectors, and historical performance.', videoSrc: 'videos/img_6197.mov', downloadUrl: '#' },
      { emoji: '⛏️', title: 'Minecraft Database', description: 'Complete reference for blocks, items, mobs, and crafting recipes. Everything you need for your next build.', videoSrc: 'videos/img_6198.mov', downloadUrl: '#' },
      { emoji: '🍳', title: 'Recipe Collection', description: 'Organize your favorite recipes with ingredients, steps, and nutritional info. Plan meals for the week ahead.', videoSrc: 'videos/img_6197.mov', downloadUrl: '#' },
      { emoji: '🎬', title: 'Movie Watchlist', description: 'Track films you want to watch and ones you have seen. Rate, review, and discover new favorites.', videoSrc: 'videos/img_6198.mov', downloadUrl: '#' },
      { emoji: '🏋️', title: 'Workout Planner', description: 'Design custom workout routines. Log sets, reps, and progress over time with built-in analytics.', videoSrc: 'videos/img_6197.mov', downloadUrl: '#' },
      { emoji: '✈️', title: 'Travel Journal', description: 'Document your trips with photos, maps, and notes. Plan itineraries and track expenses on the go.', videoSrc: 'videos/img_6198.mov', downloadUrl: '#' },
      { emoji: '📚', title: 'Book Library', description: 'Catalog your reading list. Track progress, write notes, and get recommendations based on your taste.', videoSrc: 'videos/img_6197.mov', downloadUrl: '#' },
      { emoji: '✅', title: 'Habit Tracker', description: 'Build better habits with daily check-ins and streak tracking. Visualize your consistency over months.', videoSrc: 'videos/img_6198.mov', downloadUrl: '#' },
      { emoji: '🎵', title: 'Music Catalog', description: 'Organize albums, playlists, and artists. Rate tracks and discover connections across your library.', videoSrc: 'videos/img_6197.mov', downloadUrl: '#' },
      { emoji: '🌱', title: 'Plant Care Guide', description: 'Keep your plants alive with watering schedules, sunlight needs, and seasonal care reminders.', videoSrc: 'videos/img_6198.mov', downloadUrl: '#' }
    ];

    var $grid = $('.templates__grid');
    $grid.empty();

    PROJECTS.forEach(function(project, index) {
      var $elem = $(
        '<div class="elem" data-project-index="' + index + '">' +
          '<div class="media">' +
            '<div class="inn">' +
              '<div class="box"><span>' + project.emoji + '</span></div>' +
              '<p>' + project.title + '</p>' +
            '</div>' +
          '</div>' +
          '<div class="desc">' +
            '<p>' + project.description + '</p>' +
          '</div>' +
        '</div>'
      );
      $grid.append($elem);
    });


    var $popup = $('.project__popup');
    var $popupInn = $popup.find('.inner .box .inn');
    var $videoContainer = $popup.find('.video');
    var $descLink = $popup.find('.inn > .btn-popup > a');
    var $floatUl = $popup.find('.float__controls ul');


    var currentIndex = 0;
    var popupPlayer = null;
    var isOpen = false;
    var isSwitching = false;
    var lastWheelTime = 0;
    var wheelCooldown = 350;


    function buildFloatControls() {
      $floatUl.empty();
      PROJECTS.forEach(function(project, index) {
        var $li = $('<li><a href="#" data-project-index="' + index + '">' + project.emoji + '</a></li>');
        $floatUl.append($li);
      });
      highlightFloatItem(currentIndex, false);
    }

    function highlightFloatItem(index, animate) {
      var $items = $floatUl.find('li');
      var total = PROJECTS.length;

      var prevIdx = (index - 1 + total) % total;
      var nextIdx = (index + 1) % total;

      $items.each(function(i) {
        $(this).css({ display: '', opacity: (i === index || i === prevIdx || i === nextIdx) ? 1 : 0 });
      });

      $floatUl.find('a').removeClass('active');
      $floatUl.find('a[data-project-index="' + index + '"]').addClass('active');
      centerFloat(index, animate);
    }

    function centerFloat(index, animate) {
      var isMobile = window.innerWidth <= 991;
      var total = PROJECTS.length;

      if (isMobile) {
        var containerW = $popup.find('.float__controls').outerWidth();
        var offset = 0;

        for (var i = 0; i < index; i++) {
          offset += 67 + (i < total - 1 ? 15 : 0);
        }

        var translate = (containerW / 2) - offset - 42;

        $floatUl.css({
          transition: animate ? 'transform 0.3s cubic-bezier(.25,.1,.25,1)' : 'none',
          transform: 'translateX(' + translate + 'px)'
        });
        return;
      }

      var offset = 0;
      for (var i = 0; i < index; i++) {
        offset += 67 + (i < total - 1 ? 15 : 0);
      }

      var visibleH = 82 + 99 + 82;
      var translateY = (visibleH / 2) - offset - 49.5;

      $floatUl.css({
        transition: animate ? 'transform 0.3s cubic-bezier(.25,.1,.25,1)' : 'none',
        transform: 'translateY(' + translateY + 'px)'
      });
    }


    var videoPlaying = false;
    var popupVideoEl = null;
    var videoCache = {};

    // Preload all videos into blob cache
    PROJECTS.forEach(function (p) {
      if (videoCache[p.videoSrc]) return;
      videoCache[p.videoSrc] = 'loading';
      fetch(p.videoSrc)
        .then(function (r) { return r.blob(); })
        .then(function (blob) {
          videoCache[p.videoSrc] = URL.createObjectURL(blob);
        })
        .catch(function () {
          videoCache[p.videoSrc] = p.videoSrc;
        });
    });

    function getVideoSrc(project) {
      var cached = videoCache[project.videoSrc];
      return (cached && cached !== 'loading') ? cached : project.videoSrc;
    }

    function loadVideo(project, index) {
      $videoContainer.empty();

      var $video = $('<video autoplay playsinline></video>');
      $video.attr('src', getVideoSrc(project));
      var $overlay = $('<div class="video__overlay"></div>');
      $videoContainer.append($video).append($overlay);

      popupVideoEl = $video[0];
      videoPlaying = true;
      popupVideoEl.play().catch(function () {});

      $video.on('ended', function () {
        if (!isOpen) return;
        var nextIdx = (currentIndex + 1) % PROJECTS.length;
        switchProject(nextIdx);
      });
    }

    function toggleVideo() {
      if (!popupVideoEl) return;
      if (videoPlaying) {
        popupVideoEl.pause();
        videoPlaying = false;
      } else {
        popupVideoEl.play();
        videoPlaying = true;
      }
    }

    function destroyVideo() {
      if (popupVideoEl) {
        popupVideoEl.pause();
        popupVideoEl.removeAttribute('src');
        popupVideoEl.load();
        popupVideoEl = null;
      }
      $videoContainer.empty();
    }


    function updatePopupContent(index) {
      var project = PROJECTS[index];
      var $desc = $popup.find('.desc');

      $desc.find('.desc__header .media span').text(project.emoji);
      $desc.find('.desc__header .desc__title').text(project.title);
      $desc.find('.desc__body .desc__detail .media span').text(project.emoji);
      $desc.find('.desc__body .desc__detail > span').text(project.title);
      $desc.find('.desc__body .desc__detail > p').text(project.description);
      $descLink.attr('href', project.downloadUrl);
      $popupInn[0].scrollTop = 0;
      loadVideo(project, index);
    }


    function openPopup(index) {
      currentIndex = index;
      updatePopupContent(index);
      buildFloatControls();

      $popup.addClass('active');
      $('body').addClass('popup-open');
      isOpen = true;

      requestAnimationFrame(function () {
        sizePopup();
        centerFloat(currentIndex, false);
      });
    }

    function closePopup() {
      $popup.removeClass('active');
      $('body').removeClass('popup-open');
      isOpen = false;
      isSwitching = false;
      destroyVideo();
      $popup.find('.inner .box').css({ maxWidth: '', marginTop: '' });
      $popup.find('.video').css({ maxHeight: '', height: '' });
      $popup.find('.inner').css({ padding: '' });
    }

    function switchProject(newIndex) {
      if (newIndex === currentIndex || isSwitching) return;
      isSwitching = true;
      currentIndex = newIndex;

      $popup.find('.desc__body').slideUp(200);
      updatePopupContent(newIndex);
      highlightFloatItem(newIndex, true);

      setTimeout(function () { isSwitching = false; }, 300);
    }

    $grid.on('click', '.elem', function () {
      var index = parseInt($(this).data('project-index'), 10);
      openPopup(index);
    });

    $popup.find('.popup__close').on('click', function (e) {
      e.stopPropagation();
      closePopup();
    });

    $popup.on('click', function (e) {
      if ($(e.target).closest('.box').length === 0 &&
          $(e.target).closest('.float__controls').length === 0 &&
          $(e.target).closest('.popup__close').length === 0) {
        closePopup();
      }
    });

    $popup.on('click', '.video__overlay', function (e) {
      e.stopPropagation();
      toggleVideo();
    });

    $popup.on('click', '.desc', function (e) {
      if ($(e.target).closest('.btn-popup').length) return;
      var $body = $(this).find('.desc__body');
      $body.slideToggle(300, 'swing');
    });

    $popup.on('click', '.float__controls a', function (e) {
      e.preventDefault();
      var index = parseInt($(this).data('project-index'), 10);
      switchProject(index);
    });

    $(document).on('keydown', function (e) {
      if (!isOpen) return;

      if (e.key === 'Escape') {
        closePopup();
        return;
      }

      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        switchProject((currentIndex + 1) % PROJECTS.length);
      }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        switchProject((currentIndex - 1 + PROJECTS.length) % PROJECTS.length);
      }
    });

    $popup[0].addEventListener('wheel', function (e) {
      if (!isOpen) return;
      e.preventDefault();

      var now = Date.now();
      if (now - lastWheelTime < wheelCooldown) return;
      lastWheelTime = now;

      if (e.deltaY > 0) {
        switchProject((currentIndex + 1) % PROJECTS.length);
      } else {
        switchProject((currentIndex - 1 + PROJECTS.length) % PROJECTS.length);
      }
    }, { passive: false });

    function sizePopup() {
      if (window.innerWidth > 991) {
        $popup.find('.inner .box').css({ maxWidth: '' });
        $popup.find('.video').css({ height: '' });
        return;
      }
      var wh = window.innerHeight;
      $popup.find('.video').css({ height: wh + 'px' });
    }

    $(window).on('resize', function () {
      if (isOpen) {
        centerFloat(currentIndex, false);
        sizePopup();
      }
    });

    (function initSwipe() {
      var startX = 0, startY = 0, startTime = 0;
      var swiping = false;
      var threshold = 50;
      var el = $popup.find('.inner')[0];
      if (!el) return;

      el.addEventListener('touchstart', function (e) {
        if (!isOpen) return;
        var t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        startTime = Date.now();
        swiping = true;
      }, { passive: true });

      el.addEventListener('touchend', function (e) {
        if (!isOpen || !swiping) return;
        swiping = false;
        var t = e.changedTouches[0];
        var dx = t.clientX - startX;
        var dy = t.clientY - startY;
        var dt = Date.now() - startTime;
        if (dt > 600) return;

        var absDx = Math.abs(dx);
        var absDy = Math.abs(dy);

        if (absDx > threshold && absDx > absDy) {
          if (dx < 0) {
            switchProject((currentIndex + 1) % PROJECTS.length);
          } else {
            switchProject((currentIndex - 1 + PROJECTS.length) % PROJECTS.length);
          }
        } else if (absDy > threshold && absDy > absDx) {
          if (dy < 0) {
            switchProject((currentIndex + 1) % PROJECTS.length);
          } else {
            switchProject((currentIndex - 1 + PROJECTS.length) % PROJECTS.length);
          }
        }
      }, { passive: true });
    })();

  })();

  (function initEmailCopy() {
    var $link = $('.email-copy');
    if (!$link.length) return;

    var email = $link.data('email');
    $link.append('<span class="email-copy__copied">Copied!</span>');

    var timer = null;

    $link.on('click', function (e) {
      e.preventDefault();
      var $el = $(this);

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(email);
      } else {
        var ta = document.createElement('textarea');
        ta.value = email;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }

      $el.addClass('copied');
      clearTimeout(timer);
      timer = setTimeout(function () {
        $el.removeClass('copied');
      }, 1500);
    });
  })();
});
