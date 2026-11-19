/**
 * Adds Cubism 4.2/5.0 MultiplyColor and ScreenColor shader uniforms to
 * pixi-live2d-display's Cubism 4 WebGL renderer (`cubism4.min.js`), fixing
 * black/untinted drawables on models that rely on per-drawable tinting.
 */
(function () {
  var ns = window.PIXI && window.PIXI.live2d;
  if (!ns || !ns.CubismShader_WebGL || !ns.CubismModel) return;
  if (ns.__dhvwColorFixApplied) return;
  ns.__dhvwColorFixApplied = true;

  var ShaderCls = ns.CubismShader_WebGL;
  var ModelCls = ns.CubismModel;
  var origGenerateShaders = ShaderCls.prototype.generateShaders;
  var origSetupShaderProgram = ShaderCls.prototype.setupShaderProgram;
  var origGetInvertedMask = ModelCls.prototype.getDrawableInvertedMaskBit;

  var patchingShaders = false;
  var PATCH_HELPER =
    "uniform vec4 u_multiplyColor;\n" +
    "uniform vec4 u_screenColor;\n" +
    "vec4 dhvw_applyColor(vec4 tc) {\n" +
    "  tc.rgb = tc.rgb * u_multiplyColor.rgb;\n" +
    "  tc.rgb = (tc.rgb + u_screenColor.rgb * tc.a) - (tc.rgb * u_screenColor.rgb);\n" +
    "  return tc;\n" +
    "}\n";

  function patchFragmentShader(src) {
    if (
      typeof src !== "string" ||
      src.indexOf("u_baseColor") === -1 ||
      src.indexOf("s_texture0") === -1 ||
      src.indexOf("u_channelFlag * texture2D") !== -1 ||
      src.indexOf("u_multiplyColor") !== -1
    ) {
      return src;
    }
    var mainIdx = src.indexOf("void main()");
    if (mainIdx === -1) return src;
    var out = src.slice(0, mainIdx) + PATCH_HELPER + src.slice(mainIdx);
    return out.replace(
      /texture2D\s*\(\s*s_texture0\s*,\s*v_texCoord\s*\)/g,
      "dhvw_applyColor(texture2D(s_texture0, v_texCoord))"
    );
  }

  function wrapShaderSource(Proto) {
    if (!Proto || !Proto.shaderSource || Proto.__dhvwWrapped) return;
    Proto.__dhvwWrapped = true;
    var orig = Proto.shaderSource;
    Proto.shaderSource = function (shader, source) {
      if (patchingShaders) {
        source = patchFragmentShader(source);
      }
      return orig.call(this, shader, source);
    };
  }

  wrapShaderSource(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
  wrapShaderSource(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);

  ShaderCls.prototype.generateShaders = function () {
    patchingShaders = true;
    try {
      origGenerateShaders.apply(this, arguments);
    } finally {
      patchingShaders = false;
    }
    if (this._shaderSets && this.gl) {
      for (var i = 1; i < this._shaderSets.length; i++) {
        var set = this._shaderSets[i];
        if (!set || !set.shaderProgram) continue;
        set.uniformMultiplyColorLocation = this.gl.getUniformLocation(
          set.shaderProgram,
          "u_multiplyColor"
        );
        set.uniformScreenColorLocation = this.gl.getUniformLocation(
          set.shaderProgram,
          "u_screenColor"
        );
      }
    }
  };

  ModelCls.prototype.getDrawableInvertedMaskBit = function (drawableIdx) {
    this._dhvwCurrentDrawable = drawableIdx;
    return origGetInvertedMask.apply(this, arguments);
  };

  ShaderCls.prototype.setupShaderProgram = function (renderer) {
    origSetupShaderProgram.apply(this, arguments);
    if (!renderer || renderer.getClippingContextBufferForMask() != null) return;
    var hasMask = renderer.getClippingContextBufferForDraw() != null;
    var isInverted = Boolean(arguments[12]);
    var setIdx = 1 + (hasMask ? (isInverted ? 2 : 1) : 0);
    var set = this._shaderSets && this._shaderSets[setIdx];
    if (!set) return;

    var mr = 1, mg = 1, mb = 1, ma = 1;
    var sr = 0, sg = 0, sb = 0, sa = 1;
    var model = renderer.getModel && renderer.getModel();
    var idx = model ? model._dhvwCurrentDrawable : -1;
    var rawDrawables = model && model._model && model._model.drawables;
    if (rawDrawables && idx >= 0) {
      var mc = rawDrawables.multiplyColors;
      var sc = rawDrawables.screenColors;
      var base = idx * 4;
      if (mc && base + 3 < mc.length) {
        mr = mc[base];
        mg = mc[base + 1];
        mb = mc[base + 2];
        ma = mc[base + 3];
      }
      if (sc && base + 3 < sc.length) {
        sr = sc[base];
        sg = sc[base + 1];
        sb = sc[base + 2];
        sa = sc[base + 3];
      }
    }
    if (set.uniformMultiplyColorLocation != null) {
      this.gl.uniform4f(set.uniformMultiplyColorLocation, mr, mg, mb, ma);
    }
    if (set.uniformScreenColorLocation != null) {
      this.gl.uniform4f(set.uniformScreenColorLocation, sr, sg, sb, sa);
    }
  };
})();
