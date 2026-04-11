(function () {
  "use strict";

  var motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  var settings = {
    intensity: 1,
    glowY: 0.88,
    curtainWidth: 1,
    sharpness: 1,
    speed: 1,
    pointer: 0.18,
    bottomDarkness: 1
  };
  var state = null;
  var query = new URLSearchParams(window.location.search);
  var runtime = window.__auroraRuntime = window.__auroraRuntime || {};

  if (typeof runtime.perfEnabled !== "boolean") {
    runtime.perfEnabled = query.get("perf") === "1";
  }

  runtime.performance = runtime.performance || {
    longTasks: 0,
    aurora: null,
    auroraCost: null,
    rocket: null,
    hudNode: null,
    hudLastPaint: 0
  };
  runtime.qualityState = runtime.qualityState || {
    tier: "full",
    scaleMultiplier: 1,
    dprMultiplier: 1,
    rocketLimit: 3,
    rocketTrailMode: "full",
    rocketLoadScale: 0.86,
    qualityLevel: 1
  };
  runtime.qualityControl = runtime.qualityControl || {
    pendingTier: runtime.qualityState.tier,
    streak: 0,
    freezeUntil: 0,
    lastTierChangeAt: 0
  };
  runtime.rocketLoad = runtime.rocketLoad || 1;
  runtime.activeRocketCount = runtime.activeRocketCount || 0;

  function createPerfSampler(label, sampleSize) {
    return {
      label: label,
      frameTimes: [],
      sampleSize: sampleSize || 180,
      summary: null
    };
  }

  function formatPerfLine(label, summary) {
    if (!summary) return label + ": warming";

    return label + ": " + summary.fps.toFixed(0) + " fps / " + summary.medianMs.toFixed(1) + "ms / p95 " + summary.p95Ms.toFixed(1) + "ms";
  }

  function ensurePerfHud() {
    if (!runtime.perfEnabled || !document.body) return null;
    if (runtime.performance.hudNode) return runtime.performance.hudNode;

    var hudNode = document.createElement("div");
    hudNode.className = "perf-hud";
    document.body.appendChild(hudNode);
    runtime.performance.hudNode = hudNode;

    return hudNode;
  }

  function updatePerfHud(force) {
    if (!runtime.perfEnabled || !document.body) return;

    var now = performance.now();
    if (!force && now - runtime.performance.hudLastPaint < 220) return;

    var hudNode = ensurePerfHud();
    if (!hudNode) return;

    runtime.performance.hudLastPaint = now;
    hudNode.textContent = [
      "tier: " + runtime.qualityState.tier,
      formatPerfLine("aurora", runtime.performance.aurora && runtime.performance.aurora.summary),
      formatPerfLine("aurora cost", runtime.performance.auroraCost && runtime.performance.auroraCost.summary),
      formatPerfLine("rocket", runtime.performance.rocket && runtime.performance.rocket.summary),
      "rockets: " + (runtime.activeRocketCount || 0),
      "long tasks: " + (runtime.performance.longTasks || 0)
    ].join("\n");
  }

  function recordPerfSample(perfState, deltaMs) {
    if (!perfState || !isFinite(deltaMs) || deltaMs <= 0) return;

    perfState.frameTimes.push(deltaMs);

    if (perfState.frameTimes.length > perfState.sampleSize) {
      perfState.frameTimes.shift();
    }

    if (perfState.frameTimes.length < 18) {
      updatePerfHud(false);
      return;
    }

    var sorted = perfState.frameTimes.slice().sort(function (a, b) {
      return a - b;
    });
    var median = sorted[Math.floor(sorted.length * 0.5)];
    var p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];

    perfState.summary = {
      medianMs: median,
      p95Ms: p95,
      fps: 1000 / Math.max(median, 0.001)
    };

    updatePerfHud(false);
  }

  function getTierRank(tier) {
    if (tier === "minimal") return 0;
    if (tier === "reduced") return 1;
    return 2;
  }

  function applyQualityTier(nextTier) {
    var nextState;

    if (nextTier === runtime.qualityState.tier) return;

    if (nextTier === "minimal") {
      nextState = {
        tier: "minimal",
        scaleMultiplier: 0.64,
        dprMultiplier: 0.72,
        rocketLimit: 1,
        rocketTrailMode: "minimal",
        rocketLoadScale: 0.74,
        qualityLevel: 0.42
      };
    } else if (nextTier === "reduced") {
      nextState = {
        tier: "reduced",
        scaleMultiplier: 0.76,
        dprMultiplier: 0.82,
        rocketLimit: 2,
        rocketTrailMode: "reduced",
        rocketLoadScale: 0.8,
        qualityLevel: 0.64
      };
    } else {
      nextState = {
        tier: "full",
        scaleMultiplier: 0.92,
        dprMultiplier: 0.92,
        rocketLimit: 3,
        rocketTrailMode: "full",
        rocketLoadScale: 0.86,
        qualityLevel: 0.94
      };
    }

    runtime.qualityState = nextState;
    runtime.qualityControl.pendingTier = nextState.tier;
    runtime.qualityControl.streak = 0;
    runtime.qualityControl.lastTierChangeAt = performance.now();

    if (document.body) {
      document.body.setAttribute("data-aurora-tier", nextState.tier);
    }

    if (state && state.handleResize) {
      state.handleResize();
    }

    updatePerfHud(true);
  }

  function evaluateQuality(summary) {
    if (!summary) return;
    if (runtime.activeRocketCount > 0) return;

    var nextTier = "full";
    var now = performance.now();
    var control = runtime.qualityControl;
    var currentTier = runtime.qualityState.tier;
    var requiredStreak = 0;

    if (summary.p95Ms > 25 || summary.medianMs > 21) {
      nextTier = "minimal";
    } else if (summary.p95Ms > 20 || summary.medianMs > 17) {
      nextTier = "reduced";
    }

    if (now < control.freezeUntil) return;

    if (nextTier === currentTier) {
      control.pendingTier = currentTier;
      control.streak = 0;
      return;
    }

    if (control.pendingTier !== nextTier) {
      control.pendingTier = nextTier;
      control.streak = 1;
    } else {
      control.streak += 1;
    }

    requiredStreak = getTierRank(nextTier) < getTierRank(currentTier) ? 2 : 6;

    if (control.streak < requiredStreak) return;

    applyQualityTier(nextTier);
    control.freezeUntil = now + (getTierRank(nextTier) < getTierRank(currentTier) ? 6000 : 14000);
  }

  runtime.performance.updateHud = updatePerfHud;

  if (typeof PerformanceObserver === "function" && !runtime.performance.longTaskObserver) {
    try {
      runtime.performance.longTaskObserver = new PerformanceObserver(function (list) {
        runtime.performance.longTasks += list.getEntries().length;
        updatePerfHud(true);
      });
      runtime.performance.longTaskObserver.observe({ entryTypes: ["longtask"] });
    } catch (error) {
      runtime.performance.longTaskObserver = null;
    }
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function lerp(start, end, amount) {
    return start + (end - start) * amount;
  }

  function updateFallbackPreview() {
    if (!document.body) return;

    document.body.style.setProperty("--aurora-glow-y", (settings.glowY * 100).toFixed(1) + "%");
    document.body.style.setProperty("--aurora-glow-alpha", (0.12 + settings.intensity * 0.26).toFixed(3));
    document.body.style.setProperty("--aurora-bottom-darkness", (0.18 + settings.bottomDarkness * 0.14).toFixed(3));
  }

  function createShader(gl, type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      var info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(info || "Shader compilation failed.");
    }

    return shader;
  }

  function createProgram(gl, vertexSource, fragmentSource) {
    var program = gl.createProgram();
    var vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
    var fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      var info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(info || "Program linking failed.");
    }

    return program;
  }

  function setFallbackMode() {
    if (!document.body) return;
    document.body.classList.remove("aurora-active");
    document.body.classList.add("aurora-fallback");
  }

  function stopRenderer() {
    if (!state) return;

    state.stopped = true;

    if (state.frameId) {
      cancelAnimationFrame(state.frameId);
      state.frameId = 0;
    }

    window.removeEventListener("resize", state.handleResize);
    window.removeEventListener("pointermove", state.handlePointerMove);
    document.removeEventListener("visibilitychange", state.handleVisibilityChange);

    if (state.canvas) {
      state.canvas.removeEventListener("webglcontextlost", state.handleContextLost);
    }

    if (state.gl) {
      if (state.vao) {
        state.gl.deleteVertexArray(state.vao);
      }
      if (state.program) {
        state.gl.deleteProgram(state.program);
      }
    }

    state = null;
  }

  function startAurora() {
    stopRenderer();

    var body = document.body;
    var canvas = document.querySelector(".aurora-canvas");

    if (!body || !canvas) return;

    body.classList.toggle("aurora-reduced-motion", motionQuery.matches);

    if (motionQuery.matches) {
      setFallbackMode();
      return;
    }

    var gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      desynchronized: true,
      failIfMajorPerformanceCaveat: true,
      powerPreference: "high-performance",
      premultipliedAlpha: true
    });

    if (!gl) {
      setFallbackMode();
      return;
    }

    try {
      if ("drawingBufferColorSpace" in gl) {
        gl.drawingBufferColorSpace = "display-p3";
      }
    } catch (error) {
      // Wide gamut is a progressive enhancement.
    }

    var vertexSource = [
      "#version 300 es",
      "precision highp float;",
      "const vec2 POSITIONS[3] = vec2[3](",
      "  vec2(-1.0, -1.0),",
      "  vec2(3.0, -1.0),",
      "  vec2(-1.0, 3.0)",
      ");",
      "out vec2 vUv;",
      "void main() {",
      "  vec2 position = POSITIONS[gl_VertexID];",
      "  vUv = position * 0.5 + 0.5;",
      "  gl_Position = vec4(position, 0.0, 1.0);",
      "}"
    ].join("\n");

    var fragmentSource = [
      "#version 300 es",
      "precision highp float;",
      "in vec2 vUv;",
      "out vec4 outColor;",
      "uniform vec2 uResolution;",
      "uniform float uTime;",
      "uniform vec2 uPointer;",
      "uniform vec2 uPointerVelocity;",
      "uniform float uPointerInfluence;",
      "uniform float uIntensity;",
      "uniform float uGlowY;",
      "uniform float uCurtainWidth;",
      "uniform float uSharpness;",
      "uniform float uSpeed;",
      "uniform float uBottomDarkness;",
      "uniform float uQualityLevel;",
      "uniform vec4 uRocketDataA[3];",
      "uniform vec4 uRocketDataB[3];",
      "",
      "float hash21(vec2 p) {",
      "  p = fract(p * vec2(234.34, 435.345));",
      "  p += dot(p, p + 34.23);",
      "  return fract(p.x * p.y);",
      "}",
      "",
      "float noise(vec2 p) {",
      "  vec2 i = floor(p);",
      "  vec2 f = fract(p);",
      "  vec2 u = f * f * (3.0 - 2.0 * f);",
      "  float a = hash21(i);",
      "  float b = hash21(i + vec2(1.0, 0.0));",
      "  float c = hash21(i + vec2(0.0, 1.0));",
      "  float d = hash21(i + vec2(1.0, 1.0));",
      "  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);",
      "}",
      "",
      "float fbm(vec2 p) {",
      "  float value = 0.0;",
      "  float amplitude = 0.5;",
      "  for (int i = 0; i < 4; i++) {",
      "    value += amplitude * noise(p);",
      "    p = mat2(1.6, -1.2, 1.2, 1.6) * p + vec2(0.31, 0.17);",
      "    amplitude *= 0.52;",
      "  }",
      "  return value;",
      "}",
      "",
      "vec3 warmPalette(float v) {",
      "  vec3 ember = vec3(0.24, 0.07, 0.03);",
      "  vec3 copper = vec3(0.86, 0.34, 0.12);",
      "  vec3 peach = vec3(1.00, 0.67, 0.40);",
      "  vec3 rose = vec3(0.86, 0.36, 0.48);",
      "  vec3 greenHint = vec3(0.56, 0.62, 0.18);",
      "  vec3 color = mix(ember, copper, smoothstep(0.0, 0.58, v));",
      "  color = mix(color, peach, smoothstep(0.42, 0.95, v));",
      "  color += rose * pow(max(v - 0.68, 0.0), 2.0) * 0.12;",
      "  color += greenHint * pow(max(v - 0.82, 0.0), 2.0) * 0.18;",
      "  return color;",
      "}",
      "",
      "void main() {",
      "  float t = uTime * uSpeed;",
      "  vec2 uv = vUv;",
      "  float aspect = uResolution.x / max(uResolution.y, 1.0);",
      "  vec2 scene = uv * 2.0 - 1.0;",
      "  scene.x *= aspect;",
      "",
      "  vec2 pointer = vec2(uPointer.x * 2.0 - 1.0, uPointer.y * 2.0 - 1.0);",
      "  pointer.x *= aspect;",
      "  vec2 pointerDelta = scene - pointer;",
      "  float pointerFalloff = exp(-dot(pointerDelta, pointerDelta) * 3.6);",
      "  vec2 pointerBend = vec2(-pointerDelta.y, pointerDelta.x);",
      "  pointerBend *= pointerFalloff * (0.026 + 0.036 * uPointerInfluence) * mix(0.72, 1.0, uQualityLevel);",
      "  pointerBend += uPointerVelocity * vec2(0.045, 0.02) * pointerFalloff;",
      "",
      "  float rocketHead = 0.0;",
      "  float rocketWake = 0.0;",
      "  vec2 rocketBendDir = vec2(0.0);",
      "  for (int i = 0; i < 3; i++) {",
      "    vec4 rocketA = uRocketDataA[i];",
      "    vec4 rocketB = uRocketDataB[i];",
      "    float rocketActive = rocketA.y;",
      "    if (rocketActive < 0.001) {",
      "      continue;",
      "    }",
      "    float rocketArc = rocketA.x;",
      "    float rocketRotation = radians(rocketA.z);",
      "    float rocketSway = rocketA.w;",
      "    float rocketEndX = rocketB.x;",
      "    float rocketWeight = rocketB.y;",
      "    float rocketStartX = rocketB.z;",
      "    float rocketCos = cos(rocketRotation);",
      "    float rocketSin = sin(rocketRotation);",
      "    mat2 rocketRot = mat2(rocketCos, -rocketSin, rocketSin, rocketCos);",
      "    mat2 rocketRotInv = mat2(rocketCos, rocketSin, -rocketSin, rocketCos);",
      "    vec2 rocketOrigin = vec2(rocketStartX * aspect, -1.06);",
      "    vec2 rocketScene = rocketOrigin + rocketRotInv * (scene - rocketOrigin);",
      "    float rocketY = mix(-1.06, 1.2, rocketArc);",
      "    float rocketX = mix(rocketStartX * aspect, rocketEndX * aspect, rocketArc) + sin(rocketArc * 3.14159) * rocketSway;",
      "    vec2 rocketPos = vec2(rocketX, rocketY);",
      "    float launchHead = exp(-dot(rocketScene - rocketPos, rocketScene - rocketPos) * 15.0) * rocketActive * rocketWeight;",
      "    float rocketWakePhase = clamp((rocketScene.y + 1.06) / 2.26, 0.0, 1.0);",
      "    float rocketWakeCurve = mix(rocketStartX * aspect, rocketEndX * aspect, rocketWakePhase) + sin(rocketWakePhase * 3.14159) * rocketSway;",
      "    float rocketWakeWidth = mix(0.28, 0.08, clamp((rocketScene.y + 1.0) / 2.1, 0.0, 1.0));",
      "    float launchWake = exp(-pow((rocketScene.x - rocketWakeCurve) / rocketWakeWidth, 2.0));",
      "    launchWake *= smoothstep(-0.95, rocketY - 0.14, rocketScene.y) * rocketActive * rocketWeight;",
      "    rocketHead = max(rocketHead, launchHead);",
      "    rocketWake = max(rocketWake, launchWake);",
      "    rocketBendDir += normalize(rocketRot * vec2(-0.34, 1.0)) * launchWake;",
      "  }",
      "  rocketBendDir = length(rocketBendDir) > 0.0001 ? normalize(rocketBendDir) : normalize(vec2(-0.34, 1.0));",
      "",
      "  vec3 color = vec3(0.138, 0.138, 0.138);",
      "",
      "  float glowY = mix(0.74, 0.94, uGlowY);",
      "  float emberCenter = exp(-pow(scene.y + glowY, 2.0) * 5.4) * exp(-pow(scene.x * 0.42, 2.0));",
      "  float emberLeft = exp(-pow(scene.y + 0.36, 2.0) * 6.2) * exp(-pow(scene.x + 1.35, 2.0) * 1.7);",
      "  float emberRight = exp(-pow(scene.y + 0.34, 2.0) * 6.4) * exp(-pow(scene.x - 1.32, 2.0) * 1.8);",
      "  float hazeNoise = fbm(vec2(scene.x * 0.9 + 1.7, scene.y * 1.45 - t * 0.015));",
      "  float ember = (emberCenter * 1.15 + (emberLeft + emberRight) * 0.62) * (0.58 + 0.42 * hazeNoise);",
      "  color += vec3(0.13, 0.045, 0.022) * ember * (0.66 + 0.24 * uIntensity);",
      "  color += vec3(0.28, 0.1, 0.045) * pow(ember, 1.6) * 0.42 * (0.68 + 0.22 * uIntensity);",
      "",
      "  float auroraField = 0.0;",
      "  float highlightField = 0.0;",
      "  float localGlow = 0.0;",
      "  float prismField = 0.0;",
      "",
      "  for (int i = 0; i < 3; i++) {",
      "    float fi = float(i);",
      "    float seed = fi * 9.17;",
      "    vec2 p = scene;",
      "    p.y += 0.22;",
      "    p += pointerBend * (0.55 + fi * 0.12);",
      "    p += rocketBendDir * rocketWake * (0.04 + fi * 0.008);",
      "",
      "    float center = mix(-1.35, 1.35, (fi + 0.5) / 3.0);",
      "    center += sin(t * 0.09 + fi * 1.7) * 0.08;",
      "",
      "    float warpA = fbm(vec2(p.x * 0.55 + seed, p.y * 1.35 - t * 0.028));",
      "    float warpB = fbm(vec2(p.x * 1.7 - t * 0.04, p.y * 0.85 + seed * 0.21));",
      "    float drift = (warpA - 0.5) * 0.72 + (warpB - 0.5) * 0.18;",
      "    float width = mix(0.16, 0.27, noise(vec2(seed, 4.0 + fi))) * uCurtainWidth;",
      "",
      "    float sheet = exp(-pow((p.x - center + drift) / width, 2.0));",
      "    float heightMask = smoothstep(-0.98, -0.08, p.y) * (1.0 - smoothstep(0.64, 1.15, p.y));",
      "    float strand = fbm(vec2((p.x - center) * 7.0 - drift * 2.2 + fi * 6.3, p.y * 8.8 - t * 0.18));",
      "    strand = pow(smoothstep(0.32, 0.92, strand), 1.85 * uSharpness);",
      "    float ripple = 0.82 + 0.18 * sin(t * 0.75 + fi * 2.6 + warpB * 5.0);",
      "    float fold = smoothstep(0.18, 0.9, warpA);",
      "    float taper = 1.0 - smoothstep(0.68, 1.08, p.y);",
      "",
      "    float band = sheet * heightMask * strand * ripple * taper * (0.72 + fold * 0.45);",
      "    auroraField += band;",
      "    highlightField += sheet * heightMask * smoothstep(0.64, 1.0, strand) * taper * (0.4 + fold * 0.4);",
      "    localGlow += sheet * heightMask * taper * smoothstep(0.0, 1.0, warpA);",
      "    prismField += sheet * heightMask * taper * smoothstep(0.58, 0.96, warpB);",
      "  }",
      "",
      "  auroraField *= 0.82;",
      "  highlightField *= 0.34;",
      "  localGlow *= 0.14;",
      "  prismField *= 0.06 * mix(0.55, 1.0, uQualityLevel);",
      "  auroraField *= (1.0 - rocketWake * 0.18);",
      "  highlightField *= (1.0 - rocketWake * 0.24);",
      "  localGlow *= (1.0 - rocketWake * 0.14);",
      "",
      "  float horizonMask = smoothstep(1.25, -0.35, scene.y);",
      "  float upperFade = 1.0 - smoothstep(0.7, 1.15, scene.y);",
      "  auroraField *= horizonMask * upperFade;",
      "  highlightField *= horizonMask * upperFade;",
      "  prismField *= horizonMask * upperFade;",
      "",
      "  float intensity = clamp(auroraField * 0.78 + highlightField * 0.55, 0.0, 1.0);",
      "  vec3 auroraColor = warmPalette(intensity);",
      "  float pointerLift = pointerFalloff * uPointerInfluence;",
      "  vec3 roseVeil = vec3(0.72, 0.34, 0.52) * prismField * smoothstep(-0.15, 0.55, scene.y) * 0.55;",
      "  vec3 oliveVeil = vec3(0.42, 0.52, 0.20) * prismField * smoothstep(0.05, 0.7, scene.y) * 0.38;",
      "  vec3 goldVeil = vec3(0.95, 0.62, 0.28) * prismField * 0.34;",
      "",
      "  color += auroraColor * (auroraField * 0.72 + localGlow * 0.24) * uIntensity;",
      "  color += warmPalette(clamp(intensity + 0.18, 0.0, 1.0)) * highlightField * (0.4 + pointerLift * 0.12) * uIntensity;",
      "  color += roseVeil + oliveVeil + goldVeil;",
      "  color += vec3(0.95, 0.48, 0.2) * pointerLift * 0.012;",
      "  color -= vec3(0.018, 0.014, 0.01) * rocketWake;",
      "  color += vec3(0.055, 0.05, 0.045) * rocketHead;",
      "",
      "  float vignette = smoothstep(1.95, 0.35, length(scene * vec2(0.82, 1.1)));",
      "  color *= mix(0.8, 1.02, vignette);",
      "  color *= mix(1.0, clamp(0.8 - 0.14 * uBottomDarkness, 0.5, 0.88), smoothstep(-0.2, -1.0, scene.y));",
      "",
      "  float grain = hash21(gl_FragCoord.xy + vec2(fract(t * 0.12) * 431.0, fract(t * 0.09) * 197.0)) - 0.5;",
      "  color += grain * mix(0.008, 0.018, uQualityLevel);",
      "",
      "  color = 1.0 - exp(-color * 1.18);",
      "  color = pow(max(color, 0.0), vec3(0.94));",
      "",
      "  outColor = vec4(color, 1.0);",
      "}"
    ].join("\n");

    var program;

    try {
      program = createProgram(gl, vertexSource, fragmentSource);
    } catch (error) {
      console.warn("Aurora renderer disabled:", error);
      setFallbackMode();
      return;
    }

    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.useProgram(program);

    var uniforms = {
      resolution: gl.getUniformLocation(program, "uResolution"),
      time: gl.getUniformLocation(program, "uTime"),
      pointer: gl.getUniformLocation(program, "uPointer"),
      pointerVelocity: gl.getUniformLocation(program, "uPointerVelocity"),
      pointerInfluence: gl.getUniformLocation(program, "uPointerInfluence"),
      intensity: gl.getUniformLocation(program, "uIntensity"),
      glowY: gl.getUniformLocation(program, "uGlowY"),
      curtainWidth: gl.getUniformLocation(program, "uCurtainWidth"),
      sharpness: gl.getUniformLocation(program, "uSharpness"),
      speed: gl.getUniformLocation(program, "uSpeed"),
      bottomDarkness: gl.getUniformLocation(program, "uBottomDarkness"),
      qualityLevel: gl.getUniformLocation(program, "uQualityLevel"),
      rocketDataA: gl.getUniformLocation(program, "uRocketDataA[0]"),
      rocketDataB: gl.getUniformLocation(program, "uRocketDataB[0]")
    };

    var pointer = {
      targetX: 0.5,
      targetY: 0.38,
      currentX: 0.5,
      currentY: 0.38,
      vx: 0,
      vy: 0,
      targetVX: 0,
      targetVY: 0,
      lastMove: 0
    };

    function getResolutionScale() {
      var width = window.innerWidth;
      var quality = runtime.qualityState || {};
      var rocketLoad = runtime.rocketLoad || 1;
      var baseScale;

      if (width <= 480) {
        baseScale = 0.55;
      } else if (width <= 768) {
        baseScale = 0.68;
      } else if (width <= 1100) {
        baseScale = 0.82;
      } else {
        baseScale = 0.92;
      }

      return baseScale * (quality.scaleMultiplier || 1) * rocketLoad;
    }

    function handleResize() {
      var width = window.innerWidth;
      var height = window.innerHeight;
      var quality = runtime.qualityState || {};
      var dprLimit = (width <= 768 ? 1.0 : 1.2) * (quality.dprMultiplier || 1) * Math.min(runtime.rocketLoad || 1, 1);
      var dpr = Math.min(window.devicePixelRatio || 1, dprLimit);
      var scale = getResolutionScale();

      canvas.width = Math.max(1, Math.round(width * dpr * scale));
      canvas.height = Math.max(1, Math.round(height * dpr * scale));
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    function handlePointerMove(event) {
      var nextX = clamp(event.clientX / Math.max(window.innerWidth, 1), 0, 1);
      var nextY = clamp(1 - event.clientY / Math.max(window.innerHeight, 1), 0, 1);
      var deltaX = nextX - pointer.targetX;
      var deltaY = nextY - pointer.targetY;

      pointer.targetVX = clamp(deltaX * 5, -1, 1);
      pointer.targetVY = clamp(deltaY * 5, -1, 1);
      pointer.targetX = nextX;
      pointer.targetY = nextY;
      pointer.lastMove = performance.now();
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        if (state && state.frameId) {
          cancelAnimationFrame(state.frameId);
          state.frameId = 0;
        }
        return;
      }

      if (state && !state.frameId && !state.stopped) {
        state.startTime = performance.now() - state.elapsed;
        state.frameId = requestAnimationFrame(render);
      }
    }

    function handleContextLost(event) {
      event.preventDefault();
      stopRenderer();
      setFallbackMode();
    }

    state = {
      gl: gl,
      program: program,
      vao: vao,
      canvas: canvas,
      frameId: 0,
      startTime: performance.now(),
      elapsed: 0,
      lastFrameTime: 0,
      lastDrawTime: 0,
      frameCounter: 0,
      lastLoadSignature: "",
      stopped: false,
      handleResize: handleResize,
      handlePointerMove: handlePointerMove,
      handleVisibilityChange: handleVisibilityChange,
      handleContextLost: handleContextLost
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    document.addEventListener("visibilitychange", handleVisibilityChange);
    canvas.addEventListener("webglcontextlost", handleContextLost, false);

    document.body.classList.remove("aurora-fallback");
    document.body.classList.add("aurora-active");
    document.body.setAttribute("data-aurora-tier", runtime.qualityState.tier);

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    runtime.performance.aurora = runtime.performance.aurora || createPerfSampler("aurora", 180);
    runtime.performance.auroraCost = runtime.performance.auroraCost || createPerfSampler("aurora cost", 180);
    if (runtime.perfEnabled) {
      performance.mark("aurora-gl-ready");
    }

    function render(now) {
      if (!state || state.stopped) return;

      var rocketLaunchState = window.__rocketLaunchState || { active: 0, progress: 0, activeCount: 0, arcRotationDeg: 0, shaderLaunches: [] };
      var idle = clamp(1 - (now - pointer.lastMove) / 1600, 0, 1);
      var targetInterval = 1000 / 30;

      if (rocketLaunchState.activeCount > 0) {
        targetInterval = runtime.qualityState.tier === "full" ? 1000 / 42 : 1000 / 34;
      } else if (idle > 0.12) {
        targetInterval = runtime.qualityState.tier === "full" ? 1000 / 50 : 1000 / 40;
      }

      if (state.lastDrawTime && now - state.lastDrawTime < targetInterval) {
        state.frameId = requestAnimationFrame(render);
        return;
      }

      if (state.lastDrawTime) {
        recordPerfSample(runtime.performance.aurora, now - state.lastDrawTime);
      }
      state.lastFrameTime = now;
      state.lastDrawTime = now;
      state.elapsed = now - state.startTime;
      var time = state.elapsed * 0.001;
      var smoothing = window.innerWidth <= 768 ? 0.05 : 0.07;
      var shaderLaunches = rocketLaunchState.shaderLaunches || [];
      var qualityLevel = (runtime.qualityState && runtime.qualityState.qualityLevel) || 1;
      var rocketDataA = new Float32Array(12);
      var rocketDataB = new Float32Array(12);
      var loadSignature = (runtime.qualityState.tier || "full") + ":" + (rocketLaunchState.activeCount || 0) + ":" + (runtime.rocketLoad || 1).toFixed(2);
      var index;

      if (loadSignature !== state.lastLoadSignature) {
        state.lastLoadSignature = loadSignature;
        handleResize();
      }

      pointer.currentX = lerp(pointer.currentX, pointer.targetX, smoothing);
      pointer.currentY = lerp(pointer.currentY, pointer.targetY, smoothing);
      pointer.vx = lerp(pointer.vx, pointer.targetVX, 0.12);
      pointer.vy = lerp(pointer.vy, pointer.targetVY, 0.12);
      pointer.targetVX *= 0.9;
      pointer.targetVY *= 0.9;

      var influence = idle * clamp(0.04 + Math.hypot(pointer.vx, pointer.vy) * 0.2, 0, 0.18) * settings.pointer;

      var drawStart = performance.now();

      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
      gl.uniform1f(uniforms.time, time);
      gl.uniform2f(uniforms.pointer, pointer.currentX, pointer.currentY);
      gl.uniform2f(uniforms.pointerVelocity, pointer.vx, pointer.vy);
      gl.uniform1f(uniforms.pointerInfluence, influence);
      gl.uniform1f(uniforms.intensity, settings.intensity);
      gl.uniform1f(uniforms.glowY, settings.glowY);
      gl.uniform1f(uniforms.curtainWidth, settings.curtainWidth);
      gl.uniform1f(uniforms.sharpness, settings.sharpness);
      gl.uniform1f(uniforms.speed, settings.speed);
      gl.uniform1f(uniforms.bottomDarkness, settings.bottomDarkness);
      gl.uniform1f(uniforms.qualityLevel, qualityLevel);

      for (index = 0; index < 3; index += 1) {
        var launch = shaderLaunches[index];
        if (!launch) continue;
        rocketDataA[index * 4] = launch.progress || 0;
        rocketDataA[index * 4 + 1] = launch.active || 0;
        rocketDataA[index * 4 + 2] = launch.rotationDeg || 0;
        rocketDataA[index * 4 + 3] = typeof launch.swayNorm === "number" ? launch.swayNorm : 0.12;
        rocketDataB[index * 4] = launch.endXNorm || -0.98;
        rocketDataB[index * 4 + 1] = launch.weight || 1;
        rocketDataB[index * 4 + 2] = typeof launch.startXNorm === "number" ? launch.startXNorm : 0.72;
      }

      gl.uniform4fv(uniforms.rocketDataA, rocketDataA);
      gl.uniform4fv(uniforms.rocketDataB, rocketDataB);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      recordPerfSample(runtime.performance.auroraCost, performance.now() - drawStart);

      state.frameCounter += 1;
      if (runtime.performance.auroraCost.summary && state.frameCounter % 45 === 0) {
        evaluateQuality(runtime.performance.auroraCost.summary);
      }

      if (runtime.perfEnabled && state.frameCounter === 2) {
        performance.mark("aurora-first-frame");
      }

      state.frameId = requestAnimationFrame(render);
    }

    state.frameId = requestAnimationFrame(render);
  }

  function bootAurora() {
    updateFallbackPreview();
    startAurora();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootAurora, { once: true });
  } else {
    bootAurora();
  }

  function handleGlobalMotionChange(event) {
    if (document.body) {
      document.body.classList.toggle("aurora-reduced-motion", event.matches);
    }

    if (event.matches) {
      stopRenderer();
      setFallbackMode();
      return;
    }

    startAurora();
  }

  if (typeof motionQuery.addEventListener === "function") {
    motionQuery.addEventListener("change", handleGlobalMotionChange);
  } else if (typeof motionQuery.addListener === "function") {
    motionQuery.addListener(handleGlobalMotionChange);
  }
})();
