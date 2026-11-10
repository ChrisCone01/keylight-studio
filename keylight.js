/* ==========================================================================
 * keylight.js —— Keylight 1.2 判别式的浏览器实现
 *
 * 数学与 Python 版完全一致：
 *   s(C) = gain · (r · C) / (r · S)         matte = 1 - s
 *   r = 主通道 +1，另两通道 -b / -(1-b)      b = Screen Balance
 *
 * 处理链：matte → Clip Black/White → Shrink/Grow → Softness → Despill → 合成
 *
 *   GLKeyer  —— WebGL，分离式形态学 + 可分离高斯，多趟 FBO，支持导出真 alpha
 *   CPUKeyer —— Canvas2D TypedArray 回退（无 WebGL 时）
 * ========================================================================== */

(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.Keylight = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ====================================================================== */
  /* 判别向量（与 Python 实现逐行对应）                                      */
  /* ====================================================================== */
  function buildFunctional(screen, balance) {
    const d = (screen[0] >= screen[1] && screen[0] >= screen[2]) ? 0
            : (screen[1] >= screen[2]) ? 1 : 2;
    const others = [0, 1, 2].filter(i => i !== d);
    const b = Math.min(1, Math.max(0, balance));

    const r = [0, 0, 0];
    r[d] = 1;
    r[others[0]] = -b;
    r[others[1]] = -(1 - b);

    const denom = r[0] * screen[0] + r[1] * screen[1] + r[2] * screen[2];
    return { d, others, r, denom: Math.abs(denom) < 1e-6 ? 1e-6 : denom };
  }

  /* 内部一律用归一化值运算；UI 用 AE 刻度，在 index.html 里换算。
     AE: Screen Gain 0–200（默认 100）, Screen Balance 0–100（默认 50） */
  const DEFAULTS = {
    screen: [0.10, 0.62, 0.12],
    balance: 0.5,
    gain: 1.0,
    clipBlack: 0.0,
    clipWhite: 1.0,
    shrinkGrow: 0.0,
    softness: 0.0,
    choker: 1.0,          // Simple Choker：正=内收（px），默认 1
    despill: 0.0,
    despillMode: 'project',
    despotWhite: 0.0,
    despotBlack: 0.0,
    unpremultiply: true,
    view: 'result',       // result | matte | source | comp | split
    bgColor: [0.0, 0.0, 0.0],
    split: 0.5,
    layerCount: 1        // 叠加层数：影响预览里半透明区域的实度
  };

  const VIEW_MAP = { result: 0, matte: 1, source: 2, screen: 3, comp: 4, split: 5 };

  function mergeParams(p) { return Object.assign({}, DEFAULTS, p || {}); }

  // 这些 uniform 在 GLSL 中声明为 int，必须用 uniform1i 写入
  const INT_UNIFORMS = new Set(['uOp', 'uView', 'uChan', 'uDespillMode', 'uLayerCount']);

  /* ====================================================================== */
  /* 着色器                                                                 */
  /* ====================================================================== */
  const VERT_SRC = `
    attribute vec2 aPos;
    varying vec2 vUV;
    void main() {
      vUV = vec2(aPos.x * 0.5 + 0.5, 1.0 - (aPos.y * 0.5 + 0.5));
      gl_Position = vec4(aPos, 0.0, 1.0);
    }`;

  /* matte 处理链渲染到 FBO，必须与源纹理同向。
     framebuffer 第 0 行对应 NDC 底部，而 texImage2D 的第 0 行是图像顶部，
     所以中间趟不能做 Y 翻转，否则 matte 相对源图上下颠倒。 */
  const VERT_SRC_NOFLIP = `
    attribute vec2 aPos;
    varying vec2 vUV;
    void main() {
      vUV = aPos * 0.5 + 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }`;

  /* uOp: 0 matte | 1 morphH | 2 morphV | 3 blurH | 4 blurV */
  const MATTE_FRAG = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif

    varying vec2 vUV;
    uniform sampler2D uTex;
    uniform vec2  uTexel;
    uniform vec3  uScreen;
    uniform vec3  uR;
    uniform float uDenom;
    uniform float uGain;
    uniform float uClipBlack;
    uniform float uClipWhite;
    uniform int   uOp;
    uniform float uRad;     // 有符号：正=膨胀 负=腐蚀
    uniform float uSigma;

    float rawMatte(vec2 uv) {
      vec3 c = texture2D(uTex, uv).rgb;
      float s = uGain * dot(c, uR) / uDenom;
      float m = clamp(1.0 - s, 0.0, 1.0);
      float span = uClipWhite - uClipBlack;
      if (span > 1e-5) m = clamp((m - uClipBlack) / span, 0.0, 1.0);
      return m;
    }

    void main() {
      if (uOp == 0) {
        float m = rawMatte(vUV);
        gl_FragColor = vec4(vec3(m), 1.0);
        return;
      }

      if (uOp == 1 || uOp == 2) {
        vec2 stepDir = (uOp == 1) ? vec2(uTexel.x, 0.0) : vec2(0.0, uTexel.y);
        float span = max(abs(uRad), 1.0);
        float acc = texture2D(uTex, vUV).r;
        for (int i = 1; i <= 24; i++) {
          if (float(i) > span + 0.001) break;
          vec2 o = stepDir * float(i);
          float a = texture2D(uTex, vUV + o).r;
          float b = texture2D(uTex, vUV - o).r;
          if (uRad > 0.0) acc = max(acc, max(a, b));
          else            acc = min(acc, min(a, b));
        }
        gl_FragColor = vec4(vec3(acc), 1.0);
        return;
      }

      // 3 / 4：可分离高斯，9 抽头，间距随 sigma 缩放
      vec2 dir = (uOp == 3) ? vec2(uTexel.x, 0.0) : vec2(0.0, uTexel.y);
      float acc = 0.0, wsum = 0.0;
      for (int i = -4; i <= 4; i++) {
        float f = float(i) * 0.5;
        float w = exp(-0.5 * f * f);
        acc += texture2D(uTex, vUV + dir * (f * uSigma * 2.0)).r * w;
        wsum += w;
      }
      float g = acc / wsum;
      gl_FragColor = vec4(vec3(g), 1.0);
    }`;

  /* Simple Choker：AE 里是独立效果，顺滑内收/外扩。
     用「固定抽头数 + 按半径缩放步距」的方式，任意小数半径都能平滑过渡，
     小半径时依赖双线性插值得到亚像素级效果。 */
  const CHOKER_FRAG = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif

    varying vec2 vUV;
    uniform sampler2D uTex;
    uniform vec2  uTexel;
    uniform int   uOp;       // 0 = 水平, 1 = 垂直
    uniform float uChoke;    // 正 = 内收, 负 = 外扩（单位像素）

    void main() {
      vec2 dir = (uOp == 0) ? vec2(uTexel.x, 0.0) : vec2(0.0, uTexel.y);
      float r = abs(uChoke);
      int taps = int(ceil(r));
      if (taps < 1) taps = 1;
      float stepPx = r / float(taps);

      float acc = texture2D(uTex, vUV).r;
      for (int i = 1; i <= 24; i++) {
        if (i > taps) break;
        vec2 o = dir * (float(i) * stepPx);
        float a = texture2D(uTex, vUV + o).r;
        float b = texture2D(uTex, vUV - o).r;
        if (uChoke > 0.0) acc = min(acc, min(a, b));
        else              acc = max(acc, max(a, b));
      }
      gl_FragColor = vec4(vec3(acc), 1.0);
    }`;

  const FINAL_FRAG = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif

    varying vec2 vUV;
    uniform sampler2D uTex;
    uniform sampler2D uMatte;
    uniform vec3  uScreen;
    uniform float uDespill;
    uniform float uDespotW;
    uniform float uDespotB;
    uniform int   uDespillMode;
    uniform int   uChan;
    uniform int   uView;
    uniform vec3  uBg;
    uniform float uSplit;
    uniform float uUnpremult;
    uniform int   uLayerCount;

    void main() {
      vec3 c = texture2D(uTex, vUV).rgb;
      float m = texture2D(uMatte, vUV).r;
      // 叠加层：同一结果叠 N 层，alpha 合成后为 1-(1-m)^N。
      // 这是严格的 alpha 合成结果，不改变任何抠像数值。
      float mL = m;
      if (uLayerCount > 1) {
        float keep = max(1.0 - m, 0.0);
        mL = 1.0 - pow(keep, float(uLayerCount));
        mL = clamp(mL, 0.0, 1.0);
      }
      vec3 outC = c;

      if (uDespill > 0.0) {
        vec3 hS = uScreen - vec3((uScreen.r + uScreen.g + uScreen.b) / 3.0);
        float nrm = length(hS);
        if (nrm > 1e-5) {
          hS /= nrm;
          if (uDespillMode == 0) {
            float mean = (c.r + c.g + c.b) / 3.0;
            vec3 h = c - vec3(mean);
            float sp = dot(h, hS);
            if (sp > 0.0) outC = h - hS * sp * uDespill + vec3(mean);
          } else {
            float c0 = uChan == 0 ? c.r : (uChan == 1 ? c.g : c.b);
            float oA = uChan == 0 ? c.g : c.r;
            float oB = uChan == 2 ? c.g : c.b;
            float ref = (uDespillMode == 1) ? max(oA, oB) : (oA + oB) * 0.5;
            float t = c0 + uDespill * (min(c0, ref) - c0);
            if (uChan == 0) outC.r = t; else if (uChan == 1) outC.g = t; else outC.b = t;
          }
        }
      }
      if (uDespotW > 0.0) {
        float w = clamp((m - 0.5) * 2.0, 0.0, 1.0);
        outC -= w * uDespotW * max(uScreen - outC, vec3(0.0)) * 0.5;
      }
      if (uDespotB > 0.0) {
        float w = clamp((0.5 - m) * 2.0, 0.0, 1.0);
        outC += w * uDespotB * max(uScreen - outC, vec3(0.0)) * 0.5;
      }
      outC = clamp(outC, 0.0, 1.0);

      if (uView == 1) {
        gl_FragColor = vec4(vec3(m), 1.0);
      } else if (uView == 2) {
        gl_FragColor = vec4(c, 1.0);
      } else if (uView == 3) {
        gl_FragColor = vec4(uScreen, 1.0);
      } else if (uView == 5) {
        gl_FragColor = vec4(vUV.x < uSplit ? c : outC * m + vec3(0.13) * (1.0 - m), 1.0);
      } else if (uView == 4) {
        gl_FragColor = vec4(outC * mL + uBg * (1.0 - mL), 1.0);
      } else if (uView == 6) {
        // 导出：straight alpha（putImageData / PNG 期望未预乘）
        gl_FragColor = vec4(uUnpremult > 0.5 ? outC : outC * m, m);
      } else if (uView == 7) {
        gl_FragColor = vec4(outC * mL, 1.0);
      } else if (uView == 8) {
        gl_FragColor = vec4(vec3(mL), 1.0);
      } else if (uView == 9) {
        gl_FragColor = vec4(outC, mL);
      } else {
        vec2 g = floor(vUV * 900.0 / 16.0);
        float chk = mod(g.x + g.y, 2.0) * 0.10 + 0.16;
        gl_FragColor = vec4(outC * mL + vec3(chk) * (1.0 - mL), 1.0);
      }
    }`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('shader compile error: ' + log);
    }
    return sh;
  }

  function makeProgram(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    return p;
  }

  /* ====================================================================== */
  /* WebGL 实现                                                             */
  /* ====================================================================== */
  class GLKeyer {
    constructor(canvas) {
      this.canvas = canvas;
      const opts = { premultipliedAlpha: false, alpha: false, preserveDrawingBuffer: true, antialias: false };
      this.gl = canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts);
      if (!this.gl) throw new Error('WebGL 不可用');
      const gl = this.gl;

      this.progMatte = makeProgram(gl, VERT_SRC_NOFLIP, MATTE_FRAG);
      this.progChoker = makeProgram(gl, VERT_SRC_NOFLIP, CHOKER_FRAG);
      this.progFinal = makeProgram(gl, VERT_SRC, FINAL_FRAG);

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

      // 两个 program 共用同一个 quad 属性
      for (const p of [this.progMatte, this.progChoker, this.progFinal]) {
        gl.useProgram(p);
        const a = gl.getAttribLocation(p, 'aPos');
        gl.enableVertexAttribArray(a);
        gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
      }

      this.texSrc = this._tex();
      this.mt = [this._tex(), this._tex(), this._tex(), this._tex()];
      this.fbo = gl.createFramebuffer();
      this.expTex = this._tex();
      this.ready = false;
      this.w = 0; this.h = 0;
    }

    _tex() {
      const gl = this.gl, t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    upload(source) {
      const gl = this.gl;
      const w = source.videoWidth || source.naturalWidth || source.width;
      const h = source.videoHeight || source.naturalHeight || source.height;
      if (!w || !h) return false;
      if (this.w !== w || this.h !== h) {
        this.w = w; this.h = h;
        this.canvas.width = w; this.canvas.height = h;
        const alloc = t => {
          gl.bindTexture(gl.TEXTURE_2D, t);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        };
        alloc(this.texSrc);
        this.mt.forEach(alloc);
        alloc(this.expTex);
      }
      gl.bindTexture(gl.TEXTURE_2D, this.texSrc);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      this.ready = true;
      return true;
    }

    _uniform(prog, name, v) {
      const gl = this.gl;
      const loc = gl.getUniformLocation(prog, name);
      if (loc === null) return;
      if (Array.isArray(v)) {
        if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
        else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
        else gl.uniform1f(loc, v[0]);
      } else if (typeof v === 'number') {
        // GLSL 里声明为 int 的 uniform 必须用 uniform1i，否则写入无效
        if (INT_UNIFORMS.has(name)) gl.uniform1i(loc, v | 0);
        else gl.uniform1f(loc, v);
      } else {
        gl.uniform1i(loc, v ? 1 : 0);
      }
    }

    _draw(prog, srcTex, dstTex, uniforms) {
      const gl = this.gl;
      gl.useProgram(prog);
      if (dstTex === null) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dstTex, 0);
      }
      gl.viewport(0, 0, this.w, this.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
      for (const k in uniforms) this._uniform(prog, k, uniforms[k]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    _common(p) {
      const { r, denom, d } = buildFunctional(p.screen, p.balance);
      return {
        uScreen: p.screen, uR: r, uDenom: denom, uGain: p.gain,
        uClipBlack: p.clipBlack, uClipWhite: p.clipWhite,
        uTexel: [1 / this.w, 1 / this.h], _chan: d
      };
    }

    /** 计算 matte，返回承载结果的纹理 */
    _buildMatte(p) {
      const c = this._common(p);
      let cur = this.mt[0];

      this._draw(this.progMatte, this.texSrc, cur, Object.assign({ uOp: 0 }, c));

      const rad = p.shrinkGrow;
      if (Math.abs(rad) >= 0.5) {
        this._draw(this.progMatte, cur, this.mt[1], Object.assign({ uOp: 1, uRad: rad }, c));
        this._draw(this.progMatte, this.mt[1], this.mt[2], Object.assign({ uOp: 2, uRad: rad }, c));
        cur = this.mt[2];
      }
      if (p.softness > 0.05) {
        this._draw(this.progMatte, cur, this.mt[3], Object.assign({ uOp: 3, uSigma: p.softness }, c));
        this._draw(this.progMatte, this.mt[3], this.mt[1], Object.assign({ uOp: 4, uSigma: p.softness }, c));
        cur = this.mt[1];
      }
      // Simple Choker：独立一步，排在 Keylight 之后、合成之前（与 AE 顺序一致）
      if (Math.abs(p.choker || 0) >= 0.05) {
        const texel = [1 / this.w, 1 / this.h];
        // A texture must never be sampled while attached as this pass's output.
        const intermediate = cur === this.mt[2] ? this.mt[0] : this.mt[2];
        this._draw(this.progChoker, cur, intermediate,
          { uOp: 0, uChoke: p.choker, uTexel: texel });
        this._draw(this.progChoker, intermediate, this.mt[3],
          { uOp: 1, uChoke: p.choker, uTexel: texel });
        cur = this.mt[3];
      }
      return cur;
    }

    render(p) {
      if (!this.ready) return;
      const gl = this.gl;
      const matteTex = this._buildMatte(p);
      const { d } = buildFunctional(p.screen, p.balance);

      gl.useProgram(this.progFinal);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.w, this.h);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texSrc);
      gl.uniform1i(gl.getUniformLocation(this.progFinal, 'uTex'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, matteTex);
      gl.uniform1i(gl.getUniformLocation(this.progFinal, 'uMatte'), 1);

      this._uniform(this.progFinal, 'uScreen', p.screen);
      this._uniform(this.progFinal, 'uDespill', p.despill);
      this._uniform(this.progFinal, 'uDespotW', p.despotWhite);
      this._uniform(this.progFinal, 'uDespotB', p.despotBlack);
      this._uniform(this.progFinal, 'uDespillMode', p.despillMode === 'max' ? 1 : p.despillMode === 'average' ? 2 : 0);
      this._uniform(this.progFinal, 'uChan', d);
      this._uniform(this.progFinal, 'uView', VIEW_MAP[p.view] ?? 0);
      this._uniform(this.progFinal, 'uBg', p.bgColor);
      this._uniform(this.progFinal, 'uSplit', p.split);
      this._uniform(this.progFinal, 'uUnpremult', p.unpremultiply === false ? 0 : 1);
      this._uniform(this.progFinal, 'uLayerCount', Math.max(1, Math.round(p.layerCount || 1)));

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    /** Read a small analysis matte; final export stays GPU-only. Coordinates are source-top-left. */
    measureBounds(p) {
      if (!this.ready) return null;
      const gl = this.gl, matte = this._buildMatte(p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, matte, 0);
      const bytes = new Uint8Array(this.w * this.h * 4);
      gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      let left = this.w, top = this.h, right = 0, bottom = 0;
      for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
        if (bytes[(y * this.w + x) * 4] > 1) {
          left = Math.min(left, x); top = Math.min(top, y);
          right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
        }
      }
      return right > left ? { left, top, right, bottom, width: this.w, height: this.h } : null;
    }

    /** One matte, two opaque outputs: color-on-black | white-matte-on-black. */
    renderPacked(p, layout) {
      if (!this.ready) return;
      const gl = this.gl;
      const { panelWidth, panelHeight, rect, placement } = layout;
      if (this.canvas.width !== panelWidth * 2 || this.canvas.height !== panelHeight) {
        this.canvas.width = panelWidth * 2; this.canvas.height = panelHeight;
      }
      gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND);
      const matteTex = this._buildMatte(p);
      gl.useProgram(this.progFinal);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texSrc);
      gl.uniform1i(gl.getUniformLocation(this.progFinal, 'uTex'), 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, matteTex);
      gl.uniform1i(gl.getUniformLocation(this.progFinal, 'uMatte'), 1);
      const { d } = buildFunctional(p.screen, p.balance);
      for (const [name, value] of Object.entries({
        uScreen: p.screen, uDespill: p.despill, uDespotW: p.despotWhite, uDespotB: p.despotBlack,
        uDespillMode: p.despillMode === 'max' ? 1 : p.despillMode === 'average' ? 2 : 0,
        uChan: d, uLayerCount: Math.max(1, Math.round(p.layerCount || 1))
      })) this._uniform(this.progFinal, name, value);
      gl.enable(gl.SCISSOR_TEST);
      for (let side = 0; side < 2; side++) {
        gl.scissor(side * panelWidth + rect.x, panelHeight - rect.y - rect.height, rect.width, rect.height);
        gl.viewport(side * panelWidth + placement.x, panelHeight - placement.y - placement.height, placement.width, placement.height);
        this._uniform(this.progFinal, 'uView', side === 0 ? 7 : 8);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      gl.disable(gl.SCISSOR_TEST);
    }

    dispose() { this.gl.getExtension('WEBGL_lose_context')?.loseContext(); }

    /** 导出预览画布（透明底），用于 PNG 序列与单帧导出 */
    renderToOffscreen(p, targetCanvas, matchPacked = false) {
      if (!this.ready) return;
      const gl = this.gl;
      const matteTex = this._buildMatte(p);
      const { d } = buildFunctional(p.screen, p.balance);

      gl.useProgram(this.progFinal);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.expTex, 0);
      gl.viewport(0, 0, this.w, this.h);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texSrc);
      gl.uniform1i(gl.getUniformLocation(this.progFinal, 'uTex'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, matteTex);
      gl.uniform1i(gl.getUniformLocation(this.progFinal, 'uMatte'), 1);

      this._uniform(this.progFinal, 'uScreen', p.screen);
      this._uniform(this.progFinal, 'uDespill', p.despill);
      this._uniform(this.progFinal, 'uDespotW', p.despotWhite);
      this._uniform(this.progFinal, 'uDespotB', p.despotBlack);
      this._uniform(this.progFinal, 'uDespillMode', p.despillMode === 'max' ? 1 : p.despillMode === 'average' ? 2 : 0);
      this._uniform(this.progFinal, 'uChan', d);
      this._uniform(this.progFinal, 'uView', matchPacked ? 9 : 6);
      this._uniform(this.progFinal, 'uLayerCount', Math.max(1, Math.round(p.layerCount || 1)));
      this._uniform(this.progFinal, 'uBg', p.bgColor);
      this._uniform(this.progFinal, 'uUnpremult', p.unpremultiply === false ? 0 : 1);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // 取像素并翻转
      const buf = new Uint8Array(this.w * this.h * 4);
      gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      targetCanvas.width = this.w;
      targetCanvas.height = this.h;
      const ctx = targetCanvas.getContext('2d');
      const img = ctx.createImageData(this.w, this.h);
      const row = this.w * 4;
      for (let y = 0; y < this.h; y++) {
        img.data.set(buf.subarray((this.h - 1 - y) * row, (this.h - y) * row), y * row);
      }
      ctx.putImageData(img, 0, 0);
    }
  }

  /* ====================================================================== */
  /* Canvas2D 回退                                                          */
  /* ====================================================================== */
  class CPUKeyer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { willReadFrequently: true });
      this.ready = false;
    }

    upload(source) {
      const w = source.videoWidth || source.naturalWidth || source.width;
      const h = source.videoHeight || source.naturalHeight || source.height;
      if (!w || !h) return false;
      if (this.w !== w || this.h !== h) {
        this.w = w; this.h = h;
        this.canvas.width = w; this.canvas.height = h;
      }
      this.ctx.drawImage(source, 0, 0, w, h);
      this.src = this.ctx.getImageData(0, 0, w, h).data;
      this.ready = true;
      return true;
    }

    _matte(p) {
      const { w, h } = this, src = this.src;
      const { r, denom } = buildFunctional(p.screen, p.balance);
      const cb = p.clipBlack, span = (p.clipWhite - p.clipBlack) || 1;
      const m = new Float32Array(w * h);
      for (let i = 0, j = 0; i < src.length; i += 4, j++) {
        const cr = src[i] / 255, cg = src[i + 1] / 255, cbb = src[i + 2] / 255;
        let v = 1 - p.gain * (cr * r[0] + cg * r[1] + cbb * r[2]) / denom;
        v = Math.min(1, Math.max(0, v));
        m[j] = Math.min(1, Math.max(0, (v - cb) / span));
      }
      return m;
    }

    _morph(m, px) {
      const { w, h } = this, r = Math.round(Math.abs(px));
      if (r < 1) return m;
      const dil = px > 0, out = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let a = m[y * w + x];
          for (let dy = -r; dy <= r; dy++) {
            const yy = Math.min(h - 1, Math.max(0, y + dy));
            for (let dx = -r; dx <= r; dx++) {
              if (dx * dx + dy * dy > r * r) continue;
              const xx = Math.min(w - 1, Math.max(0, x + dx));
              const v = m[yy * w + xx];
              a = dil ? Math.max(a, v) : Math.min(a, v);
            }
          }
          out[y * w + x] = a;
        }
      }
      return out;
    }

    _blur(m, sigma) {
      if (sigma <= 0.05) return m;
      const { w, h } = this;
      const kr = Math.max(1, Math.ceil(sigma * 1.5));
      const k = [];
      let sum = 0;
      for (let i = -kr; i <= kr; i++) { const v = Math.exp(-0.5 * i * i / (sigma * sigma)); k.push(v); sum += v; }
      for (let i = 0; i < k.length; i++) k[i] /= sum;

      const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let s = 0;
          for (let i = -kr; i <= kr; i++) {
            s += m[y * w + Math.min(w - 1, Math.max(0, x + i))] * k[i + kr];
          }
          tmp[y * w + x] = s;
        }
      }
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let s = 0;
          for (let i = -kr; i <= kr; i++) {
            s += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + kr];
          }
          out[y * w + x] = s;
        }
      }
      return out;
    }

    _despillCol(r, g, b, p) {
      if (p.despill <= 0) return [r, g, b];
      const S = p.screen, hm = (S[0] + S[1] + S[2]) / 3;
      let hx = S[0] - hm, hy = S[1] - hm, hz = S[2] - hm;
      const nrm = Math.hypot(hx, hy, hz) || 1;
      hx /= nrm; hy /= nrm; hz /= nrm;
      const mean = (r + g + b) / 3;
      const px = r - mean, py = g - mean, pz = b - mean;
      const sp = px * hx + py * hy + pz * hz;
      if (sp <= 0) return [r, g, b];
      return [px - hx * sp * p.despill + mean,
              py - hy * sp * p.despill + mean,
              pz - hz * sp * p.despill + mean];
    }

    _pipeline(p) {
      let m = this._matte(p);
      m = this._morph(m, p.shrinkGrow);
      m = this._blur(m, p.softness);
      if (Math.abs(p.choker || 0) >= 0.05) m = this._morph(m, -p.choker);
      return m;
    }

    render(p) {
      if (!this.ready) return;
      const { w, h, src } = this;
      const m = this._pipeline(p);
      const img = this.ctx.createImageData(w, h);
      const o = img.data;

      for (let i = 0, j = 0; i < src.length; i += 4, j++) {
        const cr = src[i] / 255, cg = src[i + 1] / 255, cbb = src[i + 2] / 255;
        const a = m[j];

        if (p.view === 'matte') {
          o[i] = o[i + 1] = o[i + 2] = a * 255;
        } else if (p.view === 'source') {
          o[i] = cr * 255; o[i + 1] = cg * 255; o[i + 2] = cbb * 255;
        } else if (p.view === 'split' && (j % w) / w < p.split) {
          o[i] = cr * 255; o[i + 1] = cg * 255; o[i + 2] = cbb * 255;
        } else {
          const [dr, dg, db] = this._despillCol(cr, cg, cbb, p);
          let br, bg, bb;
          if (p.view === 'comp') { br = p.bgColor[0]; bg = p.bgColor[1]; bb = p.bgColor[2]; }
          else {
            const chk = ((((j % w) >> 4) + (Math.floor(j / w) >> 4)) % 2) * 0.10 + 0.16;
            br = bg = bb = chk;
          }
          o[i] = (dr * a + br * (1 - a)) * 255;
          o[i + 1] = (dg * a + bg * (1 - a)) * 255;
          o[i + 2] = (db * a + bb * (1 - a)) * 255;
        }
        o[i + 3] = 255;
      }
      this.ctx.putImageData(img, 0, 0);
    }

    renderToOffscreen(p, target) {
      if (!this.ready) return;
      const { w, h, src } = this;
      const m = this._pipeline(p);
      target.width = w; target.height = h;
      const ctx = target.getContext('2d');
      const img = ctx.createImageData(w, h), o = img.data;
      for (let i = 0, j = 0; i < src.length; i += 4, j++) {
        const [dr, dg, db] = this._despillCol(src[i] / 255, src[i + 1] / 255, src[i + 2] / 255, p);
        o[i] = dr * 255; o[i + 1] = dg * 255; o[i + 2] = db * 255;
        o[i + 3] = m[j] * 255;
      }
      ctx.putImageData(img, 0, 0);
    }
  }

  /* ====================================================================== */
  /* 自动取屏幕色                                                           */
  /*                                                                        */
  /* 不能把四条边的像素混在一起逐通道取中位数 —— 上边是肤色、下边是灰、       */
  /* 两侧是绿时，中位数会得到三种颜色之间的假色。正确做法是按色相聚类投票：   */
  /* 取 8 个边缘区块各自的代表色，丢掉不饱和的，再选出现最多的那个色相簇。    */
  /* ====================================================================== */
  function _patchMedian(data, w, h, x0, y0, x1, y1) {
    const px = [], py = [];
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const i = (y * w + x) * 4;
        px.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
    if (!px.length) return null;
    const med = k => {
      const v = px.map(p => p[k]).sort((a, b) => a - b);
      return v[v.length >> 1];
    };
    return [med(0), med(1), med(2)];
  }

  function autoSample(data, w, h) {
    // 8 个区块：四角 + 四边中点，各占画面宽高的 12%
    const bw = Math.max(4, Math.floor(w * 0.12));
    const bh = Math.max(4, Math.floor(h * 0.12));
    const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
    const patches = [
      [0, 0, bw, bh], [w - bw, 0, w, bh],
      [0, h - bh, bw, h], [w - bw, h - bh, w, h],
      [cx - bw / 2, 0, cx + bw / 2, bh],
      [cx - bw / 2, h - bh, cx + bw / 2, h],
      [0, cy - bh / 2, bw, cy + bh / 2],
      [w - bw, cy - bh / 2, w, cy + bh / 2]
    ].map(([x0, y0, x1, y1]) =>
      _patchMedian(data, w, h,
        Math.max(0, Math.floor(x0)), Math.max(0, Math.floor(y0)),
        Math.min(w, Math.ceil(x1)), Math.min(h, Math.ceil(y1)))
    ).filter(Boolean);

    // 只保留饱和的颜色（色键底色一定很饱和），不饱和的灰/白/黑块直接丢弃
    const sat = patches.filter(p => {
      const mx = Math.max(p[0], p[1], p[2]), mn = Math.min(p[0], p[1], p[2]);
      return mx - mn > 30;      // 0..255 空间
    });
    if (!sat.length) {
      // 全都不饱和：退回整圈中位数（可能是低饱和的蓝幕）
      const all = patches.length ? patches : [[128, 128, 128]];
      const med = k => {
        const v = all.map(p => p[k]).sort((a, b) => a - b);
        return v[v.length >> 1] / 255;
      };
      return [med(0), med(1), med(2)];
    }

    // 色相分箱（每 20° 一箱）投票
    const hueOf = p => {
      const r = p[0] / 255, g = p[1] / 255, b = p[2] / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (d < 1e-6) return 0;
      let hh;
      if (mx === r) hh = ((g - b) / d) % 6;
      else if (mx === g) hh = (b - r) / d + 2;
      else hh = (r - g) / d + 4;
      hh *= 60;
      return hh < 0 ? hh + 360 : hh;
    };

    const bins = new Map();
    for (const p of sat) {
      const key = Math.round(hueOf(p) / 20) % 18;
      if (!bins.has(key)) bins.set(key, []);
      bins.get(key).push(p);
    }

    let best = null;
    for (const [, arr] of bins) {
      if (!best || arr.length > best.length) best = arr;
    }
    // 同一簇取均值
    const n = best.length;
    const avg = [0, 1, 2].map(k => best.reduce((s, p) => s + p[k], 0) / n / 255);
    return avg;
  }

  return {
    DEFAULTS, mergeParams, buildFunctional,
    GLKeyer, CPUKeyer, autoSample,
    create(canvas) {
      try { return new GLKeyer(canvas); }
      catch (e) {
        console.warn('[keylight] WebGL 不可用，回退 CPU：', e.message);
        return new CPUKeyer(canvas);
      }
    }
  };
});
