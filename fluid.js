/*
 * WebGL Fluid Simulation — ES Module
 * Based on Pavel Dobryakov's WebGL-Fluid-Simulation (MIT License)
 * https://github.com/PavelDoGreat/WebGL-Fluid-Simulation
 *
 * Adapted for "触診する名刺" project:
 *  - ES module exports: initFluid, splatAtPoint, triggerHeartbeatSplat
 *  - Removed: dat.GUI, promo, screenshot, Google Analytics
 *  - Tuned for mobile (lower resolution, no sunrays)
 *  - Touch/mouse events handled externally by index.js
 */

"use strict";

// --- Module state ---
var gl, ext;
var config = {
  SIM_RESOLUTION: 128,
  DYE_RESOLUTION: 512,
  DENSITY_DISSIPATION: 0.97,
  VELOCITY_DISSIPATION: 0.98,
  PRESSURE: 0.8,
  PRESSURE_ITERATIONS: 20,
  CURL: 30,
  SPLAT_RADIUS: 0.25,
  SPLAT_FORCE: 6000,
  SHADING: true,
  COLORFUL: false,
  PAUSED: false,
  BACK_COLOR: { r: 0, g: 0, b: 0 },
  TRANSPARENT: false,
  BLOOM: true,
  BLOOM_ITERATIONS: 8,
  BLOOM_RESOLUTION: 256,
  BLOOM_INTENSITY: 0.8,
  BLOOM_THRESHOLD: 0.6,
  BLOOM_SOFT_KNEE: 0.7,
};

var fluidCanvas;
var pointers = [];
var splatStack = [];

var dye, velocity, divergenceFBO, curlFBO, pressure;
var bloom, bloomFramebuffers = [];

var blurProgram, copyProgram, clearProgram, colorProgram;
var bloomPrefilterProgram, bloomBlurProgram, bloomFinalProgram;
var splatProgram, advectionProgram, divergenceProgram, curlProgram;
var vorticityProgram, pressureProgram, gradienSubtractProgram;
var displayMaterial;

var blit;
var ditheringTexture;
var lastUpdateTime;
var animFrameId = null;

// ============================================================
// Pointer
// ============================================================
function pointerPrototype() {
  this.id = -1;
  this.texcoordX = 0;
  this.texcoordY = 0;
  this.prevTexcoordX = 0;
  this.prevTexcoordY = 0;
  this.deltaX = 0;
  this.deltaY = 0;
  this.down = false;
  this.moved = false;
  this.color = [30, 0, 300];
}

// ============================================================
// WebGL Context
// ============================================================
function getWebGLContext(canvas) {
  var params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };
  var glCtx = canvas.getContext("webgl2", params);
  var isWebGL2 = !!glCtx;
  if (!isWebGL2) glCtx = canvas.getContext("webgl", params) || canvas.getContext("experimental-webgl", params);

  var halfFloat;
  var supportLinearFiltering;
  if (isWebGL2) {
    glCtx.getExtension("EXT_color_buffer_float");
    supportLinearFiltering = glCtx.getExtension("OES_texture_float_linear");
  } else {
    halfFloat = glCtx.getExtension("OES_texture_half_float");
    supportLinearFiltering = glCtx.getExtension("OES_texture_half_float_linear");
  }

  glCtx.clearColor(0.0, 0.0, 0.0, 1.0);

  var halfFloatTexType = isWebGL2 ? glCtx.HALF_FLOAT : halfFloat.HALF_FLOAT_OES;
  var formatRGBA, formatRG, formatR;

  if (isWebGL2) {
    formatRGBA = getSupportedFormat(glCtx, glCtx.RGBA16F, glCtx.RGBA, halfFloatTexType);
    formatRG = getSupportedFormat(glCtx, glCtx.RG16F, glCtx.RG, halfFloatTexType);
    formatR = getSupportedFormat(glCtx, glCtx.R16F, glCtx.RED, halfFloatTexType);
  } else {
    formatRGBA = getSupportedFormat(glCtx, glCtx.RGBA, glCtx.RGBA, halfFloatTexType);
    formatRG = getSupportedFormat(glCtx, glCtx.RGBA, glCtx.RGBA, halfFloatTexType);
    formatR = getSupportedFormat(glCtx, glCtx.RGBA, glCtx.RGBA, halfFloatTexType);
  }

  return {
    gl: glCtx,
    ext: { formatRGBA: formatRGBA, formatRG: formatRG, formatR: formatR, halfFloatTexType: halfFloatTexType, supportLinearFiltering: supportLinearFiltering }
  };
}

function getSupportedFormat(glCtx, internalFormat, format, type) {
  if (!supportRenderTextureFormat(glCtx, internalFormat, format, type)) {
    switch (internalFormat) {
      case glCtx.R16F: return getSupportedFormat(glCtx, glCtx.RG16F, glCtx.RG, type);
      case glCtx.RG16F: return getSupportedFormat(glCtx, glCtx.RGBA16F, glCtx.RGBA, type);
      default: return null;
    }
  }
  return { internalFormat: internalFormat, format: format };
}

function supportRenderTextureFormat(glCtx, internalFormat, format, type) {
  var texture = glCtx.createTexture();
  glCtx.bindTexture(glCtx.TEXTURE_2D, texture);
  glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_MIN_FILTER, glCtx.NEAREST);
  glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_MAG_FILTER, glCtx.NEAREST);
  glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_WRAP_S, glCtx.CLAMP_TO_EDGE);
  glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_WRAP_T, glCtx.CLAMP_TO_EDGE);
  glCtx.texImage2D(glCtx.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
  var fbo = glCtx.createFramebuffer();
  glCtx.bindFramebuffer(glCtx.FRAMEBUFFER, fbo);
  glCtx.framebufferTexture2D(glCtx.FRAMEBUFFER, glCtx.COLOR_ATTACHMENT0, glCtx.TEXTURE_2D, texture, 0);
  var status = glCtx.checkFramebufferStatus(glCtx.FRAMEBUFFER);
  glCtx.deleteTexture(texture);
  glCtx.deleteFramebuffer(fbo);
  glCtx.bindFramebuffer(glCtx.FRAMEBUFFER, null);
  return status == glCtx.FRAMEBUFFER_COMPLETE;
}

// ============================================================
// Shader Compilation
// ============================================================
function compileShader(type, source, keywords) {
  source = addKeywords(source, keywords);
  var shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.trace(gl.getShaderInfoLog(shader));
  return shader;
}

function addKeywords(source, keywords) {
  if (keywords == null) return source;
  var s = "";
  keywords.forEach(function (k) { s += "#define " + k + "\n"; });
  return s + source;
}

// ============================================================
// Program / Material
// ============================================================
function createProgram(vertexShader, fragmentShader) {
  var program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) console.trace(gl.getProgramInfoLog(program));
  return program;
}

function getUniforms(program) {
  var uniforms = [];
  var count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (var i = 0; i < count; i++) {
    var name = gl.getActiveUniform(program, i).name;
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return uniforms;
}

function Program(vertexShader, fragmentShader) {
  this.uniforms = {};
  this.program = createProgram(vertexShader, fragmentShader);
  this.uniforms = getUniforms(this.program);
}
Program.prototype.bind = function () { gl.useProgram(this.program); };

function Material(vertexShader, fragmentShaderSource) {
  this.vertexShader = vertexShader;
  this.fragmentShaderSource = fragmentShaderSource;
  this.programs = [];
  this.activeProgram = null;
  this.uniforms = [];
}
Material.prototype.setKeywords = function (keywords) {
  var hash = 0;
  for (var i = 0; i < keywords.length; i++) hash += hashCode(keywords[i]);
  var program = this.programs[hash];
  if (program == null) {
    var fragmentShader = compileShader(gl.FRAGMENT_SHADER, this.fragmentShaderSource, keywords);
    program = createProgram(this.vertexShader, fragmentShader);
    this.programs[hash] = program;
  }
  if (program == this.activeProgram) return;
  this.uniforms = getUniforms(program);
  this.activeProgram = program;
};
Material.prototype.bind = function () { gl.useProgram(this.activeProgram); };

function hashCode(s) {
  if (s.length == 0) return 0;
  var hash = 0;
  for (var i = 0; i < s.length; i++) { hash = (hash << 5) - hash + s.charCodeAt(i); hash |= 0; }
  return hash;
}

// ============================================================
// Shaders (inline GLSL)
// ============================================================
var baseVertexShaderSrc = "\n    precision highp float;\n    attribute vec2 aPosition;\n    varying vec2 vUv;\n    varying vec2 vL;\n    varying vec2 vR;\n    varying vec2 vT;\n    varying vec2 vB;\n    uniform vec2 texelSize;\n    void main () {\n        vUv = aPosition * 0.5 + 0.5;\n        vL = vUv - vec2(texelSize.x, 0.0);\n        vR = vUv + vec2(texelSize.x, 0.0);\n        vT = vUv + vec2(0.0, texelSize.y);\n        vB = vUv - vec2(0.0, texelSize.y);\n        gl_Position = vec4(aPosition, 0.0, 1.0);\n    }\n";

var blurVertexShaderSrc = "\n    precision highp float;\n    attribute vec2 aPosition;\n    varying vec2 vUv;\n    varying vec2 vL;\n    varying vec2 vR;\n    uniform vec2 texelSize;\n    void main () {\n        vUv = aPosition * 0.5 + 0.5;\n        float offset = 1.33333333;\n        vL = vUv - texelSize * offset;\n        vR = vUv + texelSize * offset;\n        gl_Position = vec4(aPosition, 0.0, 1.0);\n    }\n";

var blurShaderSrc = "\n    precision mediump float;\n    precision mediump sampler2D;\n    varying vec2 vUv;\n    varying vec2 vL;\n    varying vec2 vR;\n    uniform sampler2D uTexture;\n    void main () {\n        vec4 sum = texture2D(uTexture, vUv) * 0.29411764;\n        sum += texture2D(uTexture, vL) * 0.35294117;\n        sum += texture2D(uTexture, vR) * 0.35294117;\n        gl_FragColor = sum;\n    }\n";

var copyShaderSrc = "\n    precision mediump float;\n    precision mediump sampler2D;\n    varying highp vec2 vUv;\n    uniform sampler2D uTexture;\n    void main () {\n        gl_FragColor = texture2D(uTexture, vUv);\n    }\n";

var clearShaderSrc = "\n    precision mediump float;\n    precision mediump sampler2D;\n    varying highp vec2 vUv;\n    uniform sampler2D uTexture;\n    uniform float value;\n    void main () {\n        gl_FragColor = value * texture2D(uTexture, vUv);\n    }\n";

var colorShaderSrc = "\n    precision mediump float;\n    uniform vec4 color;\n    void main () {\n        gl_FragColor = color;\n    }\n";

var displayShaderSource = "\n    precision highp float;\n    precision highp sampler2D;\n    varying vec2 vUv;\n    varying vec2 vL;\n    varying vec2 vR;\n    varying vec2 vT;\n    varying vec2 vB;\n    uniform sampler2D uTexture;\n    uniform sampler2D uBloom;\n    uniform sampler2D uDithering;\n    uniform vec2 ditherScale;\n    uniform vec2 texelSize;\n    vec3 linearToGamma (vec3 color) {\n        color = max(color, vec3(0));\n        return max(1.055 * pow(color, vec3(0.416666667)) - 0.055, vec3(0));\n    }\n    void main () {\n        vec3 c = texture2D(uTexture, vUv).rgb;\n    #ifdef SHADING\n        vec3 lc = texture2D(uTexture, vL).rgb;\n        vec3 rc = texture2D(uTexture, vR).rgb;\n        vec3 tc = texture2D(uTexture, vT).rgb;\n        vec3 bc = texture2D(uTexture, vB).rgb;\n        float dx = length(rc) - length(lc);\n        float dy = length(tc) - length(bc);\n        vec3 n = normalize(vec3(dx, dy, length(texelSize)));\n        vec3 l = vec3(0.0, 0.0, 1.0);\n        float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);\n        c *= diffuse;\n    #endif\n    #ifdef BLOOM\n        vec3 bloom = texture2D(uBloom, vUv).rgb;\n        float noise = texture2D(uDithering, vUv * ditherScale).r;\n        noise = noise * 2.0 - 1.0;\n        bloom += noise / 255.0;\n        bloom = linearToGamma(bloom);\n        c += bloom;\n    #endif\n        float a = max(c.r, max(c.g, c.b));\n        gl_FragColor = vec4(c, a);\n    }\n";

var bloomPrefilterShaderSrc = "\n    precision mediump float;\n    precision mediump sampler2D;\n    varying vec2 vUv;\n    uniform sampler2D uTexture;\n    uniform vec3 curve;\n    uniform float threshold;\n    void main () {\n        vec3 c = texture2D(uTexture, vUv).rgb;\n        float br = max(c.r, max(c.g, c.b));\n        float rq = clamp(br - curve.x, 0.0, curve.y);\n        rq = curve.z * rq * rq;\n        c *= max(rq, br - threshold) / max(br, 0.0001);\n        gl_FragColor = vec4(c, 0.0);\n    }\n";

var bloomBlurShaderSrc = "\n    precision mediump float;\n    precision mediump sampler2D;\n    varying vec2 vL;\n    varying vec2 vR;\n    varying vec2 vT;\n    varying vec2 vB;\n    uniform sampler2D uTexture;\n    void main () {\n        vec4 sum = vec4(0.0);\n        sum += texture2D(uTexture, vL);\n        sum += texture2D(uTexture, vR);\n        sum += texture2D(uTexture, vT);\n        sum += texture2D(uTexture, vB);\n        sum *= 0.25;\n        gl_FragColor = sum;\n    }\n";

var bloomFinalShaderSrc = "\n    precision mediump float;\n    precision mediump sampler2D;\n    varying vec2 vL;\n    varying vec2 vR;\n    varying vec2 vT;\n    varying vec2 vB;\n    uniform sampler2D uTexture;\n    uniform float intensity;\n    void main () {\n        vec4 sum = vec4(0.0);\n        sum += texture2D(uTexture, vL);\n        sum += texture2D(uTexture, vR);\n        sum += texture2D(uTexture, vT);\n        sum += texture2D(uTexture, vB);\n        sum *= 0.25;\n        gl_FragColor = sum * intensity;\n    }\n";

var splatShaderSrc = "\n    precision highp float;\n    precision highp sampler2D;\n    varying vec2 vUv;\n    uniform sampler2D uTarget;\n    uniform float aspectRatio;\n    uniform vec3 color;\n    uniform vec2 point;\n    uniform float radius;\n    void main () {\n        vec2 p = vUv - point.xy;\n        p.x *= aspectRatio;\n        vec3 splat = exp(-dot(p, p) / radius) * color;\n        vec3 base = texture2D(uTarget, vUv).xyz;\n        gl_FragColor = vec4(base + splat, 1.0);\n    }\n";

var advectionShaderSrc = "\n    precision highp float;\n    precision highp sampler2D;\n    varying vec2 vUv;\n    uniform sampler2D uVelocity;\n    uniform sampler2D uSource;\n    uniform vec2 texelSize;\n    uniform vec2 dyeTexelSize;\n    uniform float dt;\n    uniform float dissipation;\n    vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {\n        vec2 st = uv / tsize - 0.5;\n        vec2 iuv = floor(st);\n        vec2 fuv = fract(st);\n        vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);\n        vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);\n        vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);\n        vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);\n        return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);\n    }\n    void main () {\n    #ifdef MANUAL_FILTERING\n        vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;\n        vec4 result = bilerp(uSource, coord, dyeTexelSize);\n    #else\n        vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;\n        vec4 result = texture2D(uSource, coord);\n    #endif\n        float decay = 1.0 + dissipation * dt;\n        gl_FragColor = result / decay;\n    }\n";

var divergenceShaderSrc = "\n    precision mediump float;\n    precision mediump sampler2D;\n    varying highp vec2 vUv;\n    varying highp vec2 vL;\n    varying highp vec2 vR;\n    varying highp vec2 vT;\n    varying highp vec2 vB;\n    uniform sampler2D uVelocity;\n    void main () {\n        float L = texture2D(uVelocity, vL).x;\n        float R = texture2D(uVelocity, vR).x;\n        float T = texture2D(uVelocity, vT).y;\n        float B = texture2D(uVelocity, vB).y;\n        vec2 C = texture2D(uVelocity, vUv).xy;\n        if (vL.x < 0.0) { L = -C.x; }\n        if (vR.x > 1.0) { R = -C.x; }\n        if (vT.y > 1.0) { T = -C.y; }\n        if (vB.y < 0.0) { B = -C.y; }\n        float div = 0.5 * (R - L + T - B);\n        gl_FragColor = vec4(div, 0.0, 0.0, 1.0);\n    }\n";

var curlShaderSrc = "\n    precision mediump float;\n    precision mediump sampler2D;\n    varying highp vec2 vUv;\n    varying highp vec2 vL;\n    varying highp vec2 vR;\n    varying highp vec2 vT;\n    varying highp vec2 vB;\n    uniform sampler2D uVelocity;\n    void main () {\n        float L = texture2D(uVelocity, vL).y;\n        float R = texture2D(uVelocity, vR).y;\n        float T = texture2D(uVelocity, vT).x;\n        float B = texture2D(uVelocity, vB).x;\n        float vorticity = R - L - T + B;\n        gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);\n    }\n";

var vorticityShaderSrc = "\n    precision highp float;\n    precision highp sampler2D;\n    varying vec2 vUv;\n    varying vec2 vL;\n    varying vec2 vR;\n    varying vec2 vT;\n    varying vec2 vB;\n    uniform sampler2D uVelocity;\n    uniform sampler2D uCurl;\n    uniform float curl;\n    uniform float dt;\n    void main () {\n        float L = texture2D(uCurl, vL).x;\n        float R = texture2D(uCurl, vR).x;\n        float T = texture2D(uCurl, vT).x;\n        float B = texture2D(uCurl, vB).x;\n        float C = texture2D(uCurl, vUv).x;\n        vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));\n        force /= length(force) + 0.0001;\n        force *= curl * C;\n        force.y *= -1.0;\n        vec2 velocity = texture2D(uVelocity, vUv).xy;\n        velocity += force * dt;\n        velocity = min(max(velocity, -1000.0), 1000.0);\n        gl_FragColor = vec4(velocity, 0.0, 1.0);\n    }\n";

var pressureShaderSrc = "\n    precision mediump float;\n    precision mediump sampler2D;\n    varying highp vec2 vUv;\n    varying highp vec2 vL;\n    varying highp vec2 vR;\n    varying highp vec2 vT;\n    varying highp vec2 vB;\n    uniform sampler2D uPressure;\n    uniform sampler2D uDivergence;\n    void main () {\n        float L = texture2D(uPressure, vL).x;\n        float R = texture2D(uPressure, vR).x;\n        float T = texture2D(uPressure, vT).x;\n        float B = texture2D(uPressure, vB).x;\n        float C = texture2D(uPressure, vUv).x;\n        float divergence = texture2D(uDivergence, vUv).x;\n        float pressure = (L + R + B + T - divergence) * 0.25;\n        gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);\n    }\n";

var gradientSubtractShaderSrc = "\n    precision mediump float;\n    precision mediump sampler2D;\n    varying highp vec2 vUv;\n    varying highp vec2 vL;\n    varying highp vec2 vR;\n    varying highp vec2 vT;\n    varying highp vec2 vB;\n    uniform sampler2D uPressure;\n    uniform sampler2D uVelocity;\n    void main () {\n        float L = texture2D(uPressure, vL).x;\n        float R = texture2D(uPressure, vR).x;\n        float T = texture2D(uPressure, vT).x;\n        float B = texture2D(uPressure, vB).x;\n        vec2 velocity = texture2D(uVelocity, vUv).xy;\n        velocity.xy -= vec2(R - L, T - B);\n        gl_FragColor = vec4(velocity, 0.0, 1.0);\n    }\n";

// ============================================================
// FBO helpers
// ============================================================
function createFBO(w, h, internalFormat, format, type, param) {
  gl.activeTexture(gl.TEXTURE0);
  var texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

  var fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.viewport(0, 0, w, h);
  gl.clear(gl.COLOR_BUFFER_BIT);

  var texelSizeX = 1.0 / w;
  var texelSizeY = 1.0 / h;

  return {
    texture: texture, fbo: fbo, width: w, height: h, texelSizeX: texelSizeX, texelSizeY: texelSizeY,
    attach: function (id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; }
  };
}

function createDoubleFBO(w, h, internalFormat, format, type, param) {
  var fbo1 = createFBO(w, h, internalFormat, format, type, param);
  var fbo2 = createFBO(w, h, internalFormat, format, type, param);
  return {
    width: w, height: h, texelSizeX: fbo1.texelSizeX, texelSizeY: fbo1.texelSizeY,
    get read() { return fbo1; }, set read(v) { fbo1 = v; },
    get write() { return fbo2; }, set write(v) { fbo2 = v; },
    swap: function () { var t = fbo1; fbo1 = fbo2; fbo2 = t; }
  };
}

function resizeFBO(target, w, h, internalFormat, format, type, param) {
  var newFBO = createFBO(w, h, internalFormat, format, type, param);
  copyProgram.bind();
  gl.uniform1i(copyProgram.uniforms.uTexture, target.attach(0));
  blit(newFBO);
  return newFBO;
}

function resizeDoubleFBO(target, w, h, internalFormat, format, type, param) {
  if (target.width == w && target.height == h) return target;
  target.read = resizeFBO(target.read, w, h, internalFormat, format, type, param);
  target.write = createFBO(w, h, internalFormat, format, type, param);
  target.width = w; target.height = h;
  target.texelSizeX = 1.0 / w; target.texelSizeY = 1.0 / h;
  return target;
}

// ============================================================
// Dithering Texture (procedural — no external image needed)
// ============================================================
function createDitheringTexture() {
  var texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  var size = 128;
  var data = new Uint8Array(size * size * 3);
  for (var i = 0; i < size * size * 3; i++) data[i] = Math.random() * 255;
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, size, size, 0, gl.RGB, gl.UNSIGNED_BYTE, data);
  return { texture: texture, width: size, height: size, attach: function (id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; } };
}

// ============================================================
// Resolution helpers
// ============================================================
function getResolution(resolution) {
  var aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
  if (aspectRatio < 1) aspectRatio = 1.0 / aspectRatio;
  var min = Math.round(resolution);
  var max = Math.round(resolution * aspectRatio);
  if (gl.drawingBufferWidth > gl.drawingBufferHeight)
    return { width: max, height: min };
  else
    return { width: min, height: max };
}

function scaleByPixelRatio(input) {
  var pixelRatio = window.devicePixelRatio || 1;
  return Math.floor(input * pixelRatio);
}

function getTextureScale(texture, width, height) {
  return { x: width / texture.width, y: height / texture.height };
}

// ============================================================
// Init Framebuffers
// ============================================================
function initFramebuffers() {
  var simRes = getResolution(config.SIM_RESOLUTION);
  var dyeRes = getResolution(config.DYE_RESOLUTION);
  var texType = ext.halfFloatTexType;
  var rgba = ext.formatRGBA;
  var rg = ext.formatRG;
  var r = ext.formatR;
  var filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

  gl.disable(gl.BLEND);

  if (dye == null)
    dye = createDoubleFBO(dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);
  else
    dye = resizeDoubleFBO(dye, dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);

  if (velocity == null)
    velocity = createDoubleFBO(simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);
  else
    velocity = resizeDoubleFBO(velocity, simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);

  divergenceFBO = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
  curlFBO = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
  pressure = createDoubleFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);

  initBloomFramebuffers();
}

function initBloomFramebuffers() {
  var res = getResolution(config.BLOOM_RESOLUTION);
  var texType = ext.halfFloatTexType;
  var rgba = ext.formatRGBA;
  var filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

  bloom = createFBO(res.width, res.height, rgba.internalFormat, rgba.format, texType, filtering);
  bloomFramebuffers.length = 0;
  for (var i = 0; i < config.BLOOM_ITERATIONS; i++) {
    var width = res.width >> (i + 1);
    var height = res.height >> (i + 1);
    if (width < 2 || height < 2) break;
    bloomFramebuffers.push(createFBO(width, height, rgba.internalFormat, rgba.format, texType, filtering));
  }
}

// ============================================================
// Simulation step
// ============================================================
function step(dt) {
  gl.disable(gl.BLEND);

  curlProgram.bind();
  gl.uniform2f(curlProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
  blit(curlFBO);

  vorticityProgram.bind();
  gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
  gl.uniform1i(vorticityProgram.uniforms.uCurl, curlFBO.attach(1));
  gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
  gl.uniform1f(vorticityProgram.uniforms.dt, dt);
  blit(velocity.write);
  velocity.swap();

  divergenceProgram.bind();
  gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
  blit(divergenceFBO);

  clearProgram.bind();
  gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
  gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);
  blit(pressure.write);
  pressure.swap();

  pressureProgram.bind();
  gl.uniform2f(pressureProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(pressureProgram.uniforms.uDivergence, divergenceFBO.attach(0));
  for (var i = 0; i < config.PRESSURE_ITERATIONS; i++) {
    gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
    blit(pressure.write);
    pressure.swap();
  }

  gradienSubtractProgram.bind();
  gl.uniform2f(gradienSubtractProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(gradienSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
  gl.uniform1i(gradienSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
  blit(velocity.write);
  velocity.swap();

  advectionProgram.bind();
  gl.uniform2f(advectionProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  if (!ext.supportLinearFiltering)
    gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
  var velocityId = velocity.read.attach(0);
  gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityId);
  gl.uniform1i(advectionProgram.uniforms.uSource, velocityId);
  gl.uniform1f(advectionProgram.uniforms.dt, dt);
  gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
  blit(velocity.write);
  velocity.swap();

  if (!ext.supportLinearFiltering)
    gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
  gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
  gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
  gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
  blit(dye.write);
  dye.swap();
}

// ============================================================
// Render
// ============================================================
function render(target) {
  if (config.BLOOM) applyBloom(dye.read, bloom);

  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.enable(gl.BLEND);

  drawColor(target, normalizeColor(config.BACK_COLOR));
  drawDisplay(target);
}

function drawColor(target, color) {
  colorProgram.bind();
  gl.uniform4f(colorProgram.uniforms.color, color.r, color.g, color.b, 1);
  blit(target);
}

function drawDisplay(target) {
  var width = target == null ? gl.drawingBufferWidth : target.width;
  var height = target == null ? gl.drawingBufferHeight : target.height;
  displayMaterial.bind();
  if (config.SHADING)
    gl.uniform2f(displayMaterial.uniforms.texelSize, 1.0 / width, 1.0 / height);
  gl.uniform1i(displayMaterial.uniforms.uTexture, dye.read.attach(0));
  if (config.BLOOM) {
    gl.uniform1i(displayMaterial.uniforms.uBloom, bloom.attach(1));
    gl.uniform1i(displayMaterial.uniforms.uDithering, ditheringTexture.attach(2));
    var scale = getTextureScale(ditheringTexture, width, height);
    gl.uniform2f(displayMaterial.uniforms.ditherScale, scale.x, scale.y);
  }
  blit(target);
}

function applyBloom(source, destination) {
  if (bloomFramebuffers.length < 2) return;
  var last = destination;

  gl.disable(gl.BLEND);
  bloomPrefilterProgram.bind();
  var knee = config.BLOOM_THRESHOLD * config.BLOOM_SOFT_KNEE + 0.0001;
  var curve0 = config.BLOOM_THRESHOLD - knee;
  var curve1 = knee * 2;
  var curve2 = 0.25 / knee;
  gl.uniform3f(bloomPrefilterProgram.uniforms.curve, curve0, curve1, curve2);
  gl.uniform1f(bloomPrefilterProgram.uniforms.threshold, config.BLOOM_THRESHOLD);
  gl.uniform1i(bloomPrefilterProgram.uniforms.uTexture, source.attach(0));
  blit(last);

  bloomBlurProgram.bind();
  for (var i = 0; i < bloomFramebuffers.length; i++) {
    var dest = bloomFramebuffers[i];
    gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
    gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
    blit(dest);
    last = dest;
  }

  gl.blendFunc(gl.ONE, gl.ONE);
  gl.enable(gl.BLEND);
  for (var i = bloomFramebuffers.length - 2; i >= 0; i--) {
    var baseTex = bloomFramebuffers[i];
    gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
    gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
    gl.viewport(0, 0, baseTex.width, baseTex.height);
    blit(baseTex);
    last = baseTex;
  }

  gl.disable(gl.BLEND);
  bloomFinalProgram.bind();
  gl.uniform2f(bloomFinalProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
  gl.uniform1i(bloomFinalProgram.uniforms.uTexture, last.attach(0));
  gl.uniform1f(bloomFinalProgram.uniforms.intensity, config.BLOOM_INTENSITY);
  blit(destination);
}

function normalizeColor(input) {
  return { r: input.r / 255, g: input.g / 255, b: input.b / 255 };
}

function correctRadius(radius) {
  var aspectRatio = fluidCanvas.width / fluidCanvas.height;
  if (aspectRatio > 1) radius *= aspectRatio;
  return radius;
}

function HSVtoRGB(h, s, v) {
  var r, g, b, i, f, p, q, t;
  i = Math.floor(h * 6);
  f = h * 6 - i;
  p = v * (1 - s);
  q = v * (1 - f * s);
  t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return { r: r, g: g, b: b };
}

function generateColor() {
  var c = HSVtoRGB(Math.random(), 1.0, 1.0);
  c.r *= 0.15; c.g *= 0.15; c.b *= 0.15;
  return c;
}

// ============================================================
// Splat (internal)
// ============================================================
function splatInternal(x, y, dx, dy, color) {
  splatProgram.bind();
  gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
  gl.uniform1f(splatProgram.uniforms.aspectRatio, fluidCanvas.width / fluidCanvas.height);
  gl.uniform2f(splatProgram.uniforms.point, x, y);
  gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0.0);
  gl.uniform1f(splatProgram.uniforms.radius, correctRadius(config.SPLAT_RADIUS / 100.0));
  blit(velocity.write);
  velocity.swap();

  gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
  gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b);
  blit(dye.write);
  dye.swap();
}

function multipleSplats(amount) {
  for (var i = 0; i < amount; i++) {
    var color = generateColor();
    color.r *= 10.0; color.g *= 10.0; color.b *= 10.0;
    var x = Math.random();
    var y = Math.random();
    var dx = 1000 * (Math.random() - 0.5);
    var dy = 1000 * (Math.random() - 0.5);
    splatInternal(x, y, dx, dy, color);
  }
}

// ============================================================
// Canvas resize
// ============================================================
function resizeCanvas() {
  var width = scaleByPixelRatio(fluidCanvas.clientWidth);
  var height = scaleByPixelRatio(fluidCanvas.clientHeight);
  if (fluidCanvas.width != width || fluidCanvas.height != height) {
    fluidCanvas.width = width;
    fluidCanvas.height = height;
    return true;
  }
  return false;
}

// ============================================================
// Update keywords
// ============================================================
function updateKeywords() {
  var displayKeywords = [];
  if (config.SHADING) displayKeywords.push("SHADING");
  if (config.BLOOM) displayKeywords.push("BLOOM");
  displayMaterial.setKeywords(displayKeywords);
}

// ============================================================
// Animation loop
// ============================================================
function calcDeltaTime() {
  var now = Date.now();
  var dt = (now - lastUpdateTime) / 1000;
  dt = Math.min(dt, 0.016666);
  lastUpdateTime = now;
  return dt;
}

function update() {
  var dt = calcDeltaTime();
  if (resizeCanvas()) initFramebuffers();
  applyInputs();
  if (!config.PAUSED) step(dt);
  render(null);
  animFrameId = requestAnimationFrame(update);
}

function applyInputs() {
  if (splatStack.length > 0) multipleSplats(splatStack.pop());
  pointers.forEach(function (p) {
    if (p.moved) {
      p.moved = false;
      var dx = p.deltaX * config.SPLAT_FORCE;
      var dy = p.deltaY * config.SPLAT_FORCE;
      splatInternal(p.texcoordX, p.texcoordY, dx, dy, p.color);
    }
  });
}

// ============================================================
// Input handlers (touch & mouse on canvas)
// ============================================================
function correctDeltaX(delta) {
  var aspectRatio = fluidCanvas.width / fluidCanvas.height;
  if (aspectRatio < 1) delta *= aspectRatio;
  return delta;
}
function correctDeltaY(delta) {
  var aspectRatio = fluidCanvas.width / fluidCanvas.height;
  if (aspectRatio > 1) delta /= aspectRatio;
  return delta;
}

function updatePointerDownData(pointer, id, posX, posY) {
  pointer.id = id;
  pointer.down = true;
  pointer.moved = false;
  pointer.texcoordX = posX / fluidCanvas.width;
  pointer.texcoordY = 1.0 - posY / fluidCanvas.height;
  pointer.prevTexcoordX = pointer.texcoordX;
  pointer.prevTexcoordY = pointer.texcoordY;
  pointer.deltaX = 0;
  pointer.deltaY = 0;
  pointer.color = { r: 0.5, g: 0.0, b: 0.0 }; // warm red for "body heat"
}

function updatePointerMoveData(pointer, posX, posY) {
  pointer.prevTexcoordX = pointer.texcoordX;
  pointer.prevTexcoordY = pointer.texcoordY;
  pointer.texcoordX = posX / fluidCanvas.width;
  pointer.texcoordY = 1.0 - posY / fluidCanvas.height;
  pointer.deltaX = correctDeltaX(pointer.texcoordX - pointer.prevTexcoordX);
  pointer.deltaY = correctDeltaY(pointer.texcoordY - pointer.prevTexcoordY);
  pointer.moved = Math.abs(pointer.deltaX) > 0 || Math.abs(pointer.deltaY) > 0;
}

function updatePointerUpData(pointer) {
  pointer.down = false;
}

function setupInputHandlers() {
  fluidCanvas.addEventListener("mousedown", function (e) {
    var posX = scaleByPixelRatio(e.offsetX);
    var posY = scaleByPixelRatio(e.offsetY);
    var pointer = pointers.find(function (p) { return p.id == -1; });
    if (pointer == null) pointer = new pointerPrototype();
    updatePointerDownData(pointer, -1, posX, posY);
  });

  fluidCanvas.addEventListener("mousemove", function (e) {
    var pointer = pointers[0];
    if (!pointer.down) return;
    var posX = scaleByPixelRatio(e.offsetX);
    var posY = scaleByPixelRatio(e.offsetY);
    updatePointerMoveData(pointer, posX, posY);
  });

  window.addEventListener("mouseup", function () {
    updatePointerUpData(pointers[0]);
  });

  fluidCanvas.addEventListener("touchstart", function (e) {
    e.preventDefault();
    var touches = e.targetTouches;
    while (touches.length >= pointers.length) pointers.push(new pointerPrototype());
    for (var i = 0; i < touches.length; i++) {
      var posX = scaleByPixelRatio(touches[i].pageX);
      var posY = scaleByPixelRatio(touches[i].pageY);
      updatePointerDownData(pointers[i + 1], touches[i].identifier, posX, posY);
    }
  });

  fluidCanvas.addEventListener("touchmove", function (e) {
    e.preventDefault();
    var touches = e.targetTouches;
    for (var i = 0; i < touches.length; i++) {
      var pointer = pointers[i + 1];
      if (!pointer.down) continue;
      var posX = scaleByPixelRatio(touches[i].pageX);
      var posY = scaleByPixelRatio(touches[i].pageY);
      updatePointerMoveData(pointer, posX, posY);
    }
  }, false);

  window.addEventListener("touchend", function (e) {
    var touches = e.changedTouches;
    for (var i = 0; i < touches.length; i++) {
      var pointer = pointers.find(function (p) { return p.id == touches[i].identifier; });
      if (pointer == null) continue;
      updatePointerUpData(pointer);
    }
  });
}

// ============================================================
// EXPORTED API
// ============================================================

/**
 * Initialize the fluid simulation on the given canvas element.
 * Call this once after user gesture (to allow audio context etc.)
 */
export function initFluid(canvas) {
  fluidCanvas = canvas;

  var ctx = getWebGLContext(canvas);
  gl = ctx.gl;
  ext = ctx.ext;

  if (!ext.supportLinearFiltering) {
    config.DYE_RESOLUTION = 512;
    config.SHADING = false;
    config.BLOOM = false;
  }

  // Compile all shaders
  var baseVS = compileShader(gl.VERTEX_SHADER, baseVertexShaderSrc);
  var blurVS = compileShader(gl.VERTEX_SHADER, blurVertexShaderSrc);

  blurProgram = new Program(blurVS, compileShader(gl.FRAGMENT_SHADER, blurShaderSrc));
  copyProgram = new Program(baseVS, compileShader(gl.FRAGMENT_SHADER, copyShaderSrc));
  clearProgram = new Program(baseVS, compileShader(gl.FRAGMENT_SHADER, clearShaderSrc));
  colorProgram = new Program(baseVS, compileShader(gl.FRAGMENT_SHADER, colorShaderSrc));
  bloomPrefilterProgram = new Program(baseVS, compileShader(gl.FRAGMENT_SHADER, bloomPrefilterShaderSrc));
  bloomBlurProgram = new Program(baseVS, compileShader(gl.FRAGMENT_SHADER, bloomBlurShaderSrc));
  bloomFinalProgram = new Program(baseVS, compileShader(gl.FRAGMENT_SHADER, bloomFinalShaderSrc));
  splatProgram = new Program(baseVS, compileShader(gl.FRAGMENT_SHADER, splatShaderSrc));
  advectionProgram = new Program(baseVS, compileShader(gl.FRAGMENT_SHADER, advectionShaderSrc, ext.supportLinearFiltering ? null : ["MANUAL_FILTERING"]));
  divergenceProgram = new Program(baseVS, compileShader(gl.FRAGMENT_SHADER, divergenceShaderSrc));
  curlProgram = new Program(baseVS, compileShader(gl.FRAGMENT_SHADER, curlShaderSrc));
  vorticityProgram = new Program(baseVS, compileShader(gl.FRAGMENT_SHADER, vorticityShaderSrc));
  pressureProgram = new Program(baseVS, compileShader(gl.FRAGMENT_SHADER, pressureShaderSrc));
  gradienSubtractProgram = new Program(baseVS, compileShader(gl.FRAGMENT_SHADER, gradientSubtractShaderSrc));
  displayMaterial = new Material(baseVS, displayShaderSource);

  // Setup blit quad
  blit = (function () {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);
    return function (target, clear) {
      if (target == null) {
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } else {
        gl.viewport(0, 0, target.width, target.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      }
      if (clear) { gl.clearColor(0.0, 0.0, 0.0, 1.0); gl.clear(gl.COLOR_BUFFER_BIT); }
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    };
  })();

  // Dithering texture (procedural)
  ditheringTexture = createDitheringTexture();

  // Init pointers
  pointers = [];
  pointers.push(new pointerPrototype());

  // Update keywords & init framebuffers
  updateKeywords();
  initFramebuffers();

  // Initial splash
  multipleSplats(Math.floor(Math.random() * 5) + 2);

  // Setup touch/mouse
  setupInputHandlers();

  // Start loop
  lastUpdateTime = Date.now();
  if (animFrameId != null) cancelAnimationFrame(animFrameId);
  animFrameId = requestAnimationFrame(update);
}

/**
 * Add a splat at normalized coordinates (0-1).
 * @param {number} x - normalized x (0 = left, 1 = right)
 * @param {number} y - normalized y (0 = bottom, 1 = top)
 * @param {number} dx - velocity x
 * @param {number} dy - velocity y
 * @param {{r:number, g:number, b:number}} color - RGB (0-1 range, pre-multiplied)
 */
export function splatAtPoint(x, y, dx, dy, color) {
  if (!gl) return;
  splatInternal(x, y, dx, dy, color);
}

/**
 * Trigger a heartbeat-style splat from the center of the screen.
 * Red pulsating burst radiating outward.
 */
export function triggerHeartbeatSplat() {
  if (!gl) return;
  // Multiple directional splats from center for a pulsating effect
  var cx = 0.5;
  var cy = 0.5;
  var force = 800;
  var color = { r: 0.8, g: 0.05, b: 0.1 }; // deep red

  // 8 directional bursts
  for (var i = 0; i < 8; i++) {
    var angle = (i / 8) * Math.PI * 2;
    var dx = Math.cos(angle) * force;
    var dy = Math.sin(angle) * force;
    splatInternal(cx, cy, dx, dy, color);
  }
}
