// scene-decoration.js
// Generic browser-canvas scene-decoration system: per-scene sprite list with
// density/scale/motion/anchor, drag-drop placement, per-decoration trigger
// (ballNear / ballOver), seeded random layout. Intended for any 2D HTML5
// canvas game/editor (not golf-specific).
//
// Exposes window.SceneDecoration with:
//   - defaultDecorationSchema(spritePath, suggest?) -> object
//   - defaultColliderFor(shape) -> collider | null
//   - defaultTriggerFor(type)  -> trigger | null
//   - defaultMotionFor(type)   -> motion | null
//   - renderStage({ ctx, w, h, theme, decorations, selectedIdx?, cursor?,
//                  imgFor, time? }) -> void
//   - createImageCache(opts?) -> { get(src) -> entry, clear() }
//   - hitTestStage({ canvas, decorations, ... }) -> idx (TBD; not required v1)
(function (root) {
  'use strict';

  const SHAPE_LABELS = { circle: 'Circle', rect: 'Rect', ellipse: 'Ellipse' };

  function defaultDecorationSchema(spritePath, suggest) {
    const base = {
      sprite: spritePath || '',
      layer: 'ground',           // 'ground' | 'sky'
      density: 0.4,
      offsetY: 0,
      scaleMin: 0.85,
      scaleMax: 1.15,
      w: 32,
      h: 36,
      pivot: { x: 0, y: 0 },
      collider: null,
      trigger: null,
      // Sky-only fields (vertical placement window as fraction of [0, ground])
      skyMin: 0.10,
      skyMax: 0.45,
      motion: null               // { type: 'drift' | 'flap', speed, wobbleAmp? }
    };
    return suggest ? Object.assign({}, base, suggest) : base;
  }

  function defaultColliderFor(shape) {
    if (shape === 'circle')  return { shape: shape, ox: 0, oy: -10, r: 14 };
    if (shape === 'ellipse') return { shape: shape, ox: 0, oy: -10, rx: 18, ry: 10, angle: 0 };
    if (shape === 'rect')    return { shape: shape, ox: 0, oy: -12, w: 24, h: 18, angle: 0 };
    return null;
  }

  function defaultTriggerFor(type) {
    if (type === 'ballNear') return { type: type, radius: 60, anim: 'bend',   strength: 0.5 };
    if (type === 'ballOver') return { type: type,             anim: 'wobble', strength: 0.7 };
    return null;
  }

  function defaultMotionFor(type) {
    if (type === 'drift') return { type: type, speed: 8,  wobbleAmp: 4 };
    if (type === 'flap')  return { type: type, speed: 28, wobbleAmp: 14 };
    return null;
  }

  // Strip residual magenta/pink chroma-key fringe pixels.
  function killMagenta(img) {
    try {
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) return null;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const cx = c.getContext('2d');
      cx.drawImage(img, 0, 0);
      const dat = cx.getImageData(0, 0, w, h);
      const px = dat.data;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3];
        if (a === 0) continue;
        if (r > 180 && b > 150 && g < 140 && (r - g) > 40 && (b - g) > 20) {
          px[i + 3] = 0;
        }
      }
      cx.putImageData(dat, 0, 0);
      return c;
    } catch (_) {
      return null;
    }
  }

  // Simple image cache. `resolveSrc(src)` is an optional hook so callers can
  // map e.g. "custom:ID" sprite paths to real data URLs without modifying the
  // cache.  `onLoad()` lets callers re-render once a deferred image arrives.
  function createImageCache(opts) {
    const resolveSrc = (opts && opts.resolveSrc) || null;
    const onLoad     = (opts && opts.onLoad)     || null;
    const stripMagenta = !(opts && opts.stripMagenta === false);
    const cache = new Map();
    function get(src) {
      if (!src) return null;
      let entry = cache.get(src);
      if (entry) return entry;
      const im = new Image();
      const custom = resolveSrc ? resolveSrc(src) : null;
      if (custom) im.src = custom;
      else im.src = src.startsWith('./') || src.startsWith('http') || src.startsWith('data:') ? src : './' + src;
      entry = {
        _img: im,
        draw: im,
        get complete() { return im.complete; },
        get naturalWidth() { return im.naturalWidth; },
        get naturalHeight() { return im.naturalHeight; }
      };
      im.addEventListener('load', () => {
        if (stripMagenta) {
          const cleaned = killMagenta(im);
          if (cleaned) entry.draw = cleaned;
        }
        if (onLoad) onLoad(src, entry);
      });
      cache.set(src, entry);
      return entry;
    }
    return { get: get, clear: () => cache.clear() };
  }

  // Stable PRNG so decoration positions don't shimmer between frames.
  function makeSeeded(n, layoutSeed) {
    let h = (n + (layoutSeed || 0) * 1e9) | 0;
    return function () {
      h = (Math.imul(h ^ (h >>> 15), 0x85ebca6b)) | 0;
      h = (Math.imul(h ^ (h >>> 13), 0xc2b2ae35)) | 0;
      h = (h ^ (h >>> 16)) >>> 0;
      return (h % 1000) / 1000;
    };
  }

  // Honor natural aspect ratio when image is loaded.
  function dstSize(img, baseW, baseH, scale) {
    const nw = img && img.naturalWidth;
    const nh = img && img.naturalHeight;
    if (nw && nh) {
      const aspect = nh / nw;
      return { dw: baseW * scale, dh: baseW * scale * aspect };
    }
    return { dw: baseW * scale, dh: baseH * scale };
  }

  // Render a stage of decorations to a 2D context.
  // opts:
  //   ctx, w, h                — canvas + size in CSS pixels
  //   theme: { sky1, sky2, ground, dirt }   — background gradient + ground bands
  //   decorations: array       — schema list (see defaultDecorationSchema)
  //   selectedIdx (optional)   — highlight + collider preview
  //   cursor (optional)        — { x, y, inside } in CSS px (in screen/viewport space)
  //   imgFor(src) -> entry     — image cache lookup
  //   time (optional)          — seconds (defaults to performance.now()/1000)
  //   layoutSeed (optional)    — number, default 0.42
  //   drawBackground (optional, default true) — set false to render decorations
  //                              over a caller-provided scene
  //   drawBall (optional, default true) — show the cursor "ball" indicator
  //   groundFrac (optional, default 0.66) — vertical ground line as fraction
  //   groundTiles (optional)   — [{sprite, weight}] tile chain; replaces flat ground colors
  //   camera (optional)        — { x: panOffsetPx, scale: zoomFactor }
  //                              canvas view = world translated by (-cam.x, 0) then scaled
  //   backdropExtras (optional) — { mountains, jaggedUnderground, pebbles, roots }
  //                              object flags to draw game-parity backdrop layers
  //   editorTriggerPreview (optional, default false) — when true cursor proximity
  //                              triggers bend/wobble/pop animations; false = static
  // returns { decoCount, groundY, bboxes }
  //   bboxes: [{kind:'deco', idx, sprite, x, y, w, h}] world-space hit rects for last frame
  function renderStage(opts) {
    const ctx        = opts.ctx;
    const w          = opts.w;
    const h          = opts.h;
    const theme      = opts.theme || {};
    const decos      = opts.decorations || [];
    const selectedIdx = (typeof opts.selectedIdx === 'number') ? opts.selectedIdx : -1;
    const imgFor     = opts.imgFor || function () { return null; };
    const t          = (typeof opts.time === 'number') ? opts.time : (performance.now() / 1000);
    const layoutSeed = (typeof opts.layoutSeed === 'number') ? opts.layoutSeed : 0.42;
    const groundFrac  = (typeof opts.groundFrac === 'number') ? opts.groundFrac : 0.66;
    const drawBg      = opts.drawBackground !== false;
    const drawBall    = opts.drawBall === true;
    const groundTiles = Array.isArray(opts.groundTiles) ? opts.groundTiles : null;
    // groundTileInstances: [{sprite, x, offsetY?, scale?}] — when provided, each tile
    // is drawn at its explicit world-pixel X instead of tiling the full canvas width.
    // Used by the course editor stage so only placed instances appear, not an infinite
    // repeat. When null/undefined the existing full-width tiling behaviour is used.
    const groundTileInstances = Array.isArray(opts.groundTileInstances) ? opts.groundTileInstances : null;
    const camera      = (opts.camera && typeof opts.camera === 'object') ? opts.camera : null;
    const camX        = camera ? (Number(camera.x) || 0) : 0;
    const camScale    = camera ? Math.max(0.1, Number(camera.scale) || 1) : 1;
    const bdExtras    = (opts.backdropExtras && typeof opts.backdropExtras === 'object') ? opts.backdropExtras : null;
    const triggerPreview = opts.editorTriggerPreview === true;
    // World size remains the unscaled stage size. Zoom comes from canvas transform.
    const worldW      = w;

    // bbox list — populated during decoration draw, returned to caller
    const bboxes = [];

    // Convert screen cursor to world space for trigger/ball calculations
    const rawCursor = opts.cursor || { x: -9999, y: -9999, inside: false };
    const cursor = {
      x: (rawCursor.x / camScale) + camX,
      y: rawCursor.y / camScale,
      inside: rawCursor.inside
    };

    const groundY = Math.floor(h * groundFrac);

    // --- Out-of-world background (screen-space, before camera transform) ---
    // Fills entire canvas with a subtle dashed grid so zoomed-out areas aren't black.
    if (drawBg) {
      ctx.save();
      ctx.fillStyle = '#1a1a2a';
      ctx.fillRect(0, 0, w, h);
      // Dashed grid overlay
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      const gStep = 32;
      for (let gx = 0; gx <= w; gx += gStep) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); }
      for (let gy = 0; gy <= h; gy += gStep) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); }
      ctx.restore();
    }

    // Apply camera transform for all world-space drawing
    ctx.save();
    ctx.scale(camScale, camScale);
    ctx.translate(-camX, 0);

    const wW = worldW;   // world width (unscaled stage width)
    const wH = h;        // world height (unscaled stage height)

    if (drawBg) {
      // Sky gradient — use world-space coords (inside scaled ctx)
      const grad = ctx.createLinearGradient(0, 0, 0, wH);
      grad.addColorStop(0, theme.sky1 || '#c9e3ef');
      grad.addColorStop(1, theme.sky2 || '#eaf4da');
      ctx.fillStyle = grad;
      // Fill a wide strip covering camX offset to ensure full coverage during pan
      ctx.fillRect(camX - 10, 0, wW + 20, wH);

      // --- Mountain layers drawn right after sky, before ground tiles ---
      // Uses game.js-parity rendering: fixed peaks array + forest silhouette + close ridge.
      if (bdExtras && bdExtras.mountains) {
        // Scale factor: game renders at fixed W (660px); editor uses wW.
        var _mScale = wW / 660;
        var _GY = groundY; // HORIZON equivalent

        // Colours derived from theme (matches game.js lerpC outputs for daytime)
        var _mountainColor = theme.mountainFill || '#8FA3B8';
        var _forestColor   = theme.forestFill   || '#4A6428';
        var _ridgeColor    = theme.ridgeFill     || '#5A7830';

        // LAYER 1: Distant jagged mountain range with fixed peaks (game.js parity)
        var _peaks = [
          { x: -10,  y: _GY + 2  },
          { x: 50,   y: _GY - 28 },
          { x: 95,   y: _GY - 12 },
          { x: 155,  y: _GY - 42 },
          { x: 210,  y: _GY - 20 },
          { x: 270,  y: _GY - 38 },
          { x: 340,  y: _GY - 18 },
          { x: 400,  y: _GY - 48 },
          { x: 465,  y: _GY - 24 },
          { x: 530,  y: _GY - 35 },
          { x: 595,  y: _GY - 16 },
          { x: 660,  y: _GY - 30 },
          { x: 720,  y: _GY - 10 }
        ].map(function(p) { return { x: p.x * _mScale, y: _GY + (p.y - _GY) }; });

        ctx.save();
        ctx.fillStyle = _mountainColor;
        ctx.beginPath();
        ctx.moveTo(-20, _GY + 8);
        for (var _pi2 = 0; _pi2 < _peaks.length; _pi2++) {
          ctx.lineTo(_peaks[_pi2].x, _peaks[_pi2].y);
        }
        ctx.lineTo(wW + 20, _GY + 8);
        ctx.closePath();
        ctx.fill();
        // Snow caps on tallest peaks
        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        for (var _si = 1; _si < _peaks.length - 1; _si++) {
          var _sp = _peaks[_si];
          if (_sp.y < _GY - 24) {
            ctx.beginPath();
            ctx.moveTo(_sp.x - 6, _sp.y + 6);
            ctx.lineTo(_sp.x, _sp.y + 0.5);
            ctx.lineTo(_sp.x + 6, _sp.y + 7);
            ctx.lineTo(_sp.x + 3, _sp.y + 4);
            ctx.lineTo(_sp.x,     _sp.y + 6);
            ctx.lineTo(_sp.x - 3, _sp.y + 4);
            ctx.closePath();
            ctx.fill();
          }
        }
        ctx.restore();

        // LAYER 2: Forest silhouette (game.js parity)
        ctx.save();
        ctx.fillStyle = _forestColor;
        // Base hill
        ctx.beginPath();
        ctx.moveTo(-20, _GY + 8);
        ctx.lineTo(-20, _GY + 2);
        ctx.quadraticCurveTo(80  * _mScale, _GY - 10, 200 * _mScale, _GY - 4);
        ctx.quadraticCurveTo(320 * _mScale, _GY + 2,  440 * _mScale, _GY - 8);
        ctx.quadraticCurveTo(560 * _mScale, _GY - 16, wW + 20, _GY - 6);
        ctx.lineTo(wW + 20, _GY + 8);
        ctx.closePath();
        ctx.fill();
        // Individual tree silhouettes
        for (var _ti2 = 0; _ti2 < 28; _ti2++) {
          var _tx2 = (5 + _ti2 * 25 + ((_ti2 * 1301 + 23) % 14)) * _mScale;
          var _isPine = (_ti2 * 7 + 23) % 3 !== 0;
          var _tBaseY = _GY + (Math.sin(_tx2 * 0.012 / _mScale) * -8) + (Math.sin(_tx2 * 0.008 / _mScale + 1) * -4);
          if (_isPine) {
            var _tH = (10 + ((_ti2 * 19) % 8)) * _mScale;
            ctx.beginPath();
            ctx.moveTo(_tx2 - 3 * _mScale, _tBaseY);
            ctx.lineTo(_tx2, _tBaseY - _tH);
            ctx.lineTo(_tx2 + 3 * _mScale, _tBaseY - _tH * 0.55);
            ctx.lineTo(_tx2 + 2 * _mScale, _tBaseY - _tH * 0.55);
            ctx.lineTo(_tx2 + 4 * _mScale, _tBaseY - _tH * 0.25);
            ctx.lineTo(_tx2 + 3 * _mScale, _tBaseY);
            ctx.closePath();
            ctx.fill();
          } else {
            var _tR = (4 + ((_ti2 * 13) % 4)) * _mScale;
            ctx.beginPath();
            ctx.arc(_tx2, _tBaseY - _tR, _tR, 0, Math.PI * 2);
            ctx.arc(_tx2 - _tR * 0.6, _tBaseY - _tR * 0.8, _tR * 0.75, 0, Math.PI * 2);
            ctx.arc(_tx2 + _tR * 0.6, _tBaseY - _tR * 0.8, _tR * 0.75, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.restore();

        // LAYER 3: Close ridge (game.js parity)
        ctx.save();
        ctx.fillStyle = _ridgeColor;
        ctx.beginPath();
        ctx.moveTo(-20, _GY + 8);
        ctx.lineTo(-20, _GY + 6);
        ctx.quadraticCurveTo(110 * _mScale, _GY - 2, 240 * _mScale, _GY + 4);
        ctx.quadraticCurveTo(370 * _mScale, _GY + 10, 500 * _mScale, _GY + 2);
        ctx.quadraticCurveTo(620 * _mScale, _GY - 4, wW + 20, _GY + 4);
        ctx.lineTo(wW + 20, _GY + 8);
        ctx.closePath();
        ctx.fill();
        // Soft outline on close ridge
        ctx.strokeStyle = 'rgba(30,18,8,0.30)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-20, _GY + 6);
        ctx.quadraticCurveTo(110 * _mScale, _GY - 2, 240 * _mScale, _GY + 4);
        ctx.quadraticCurveTo(370 * _mScale, _GY + 10, 500 * _mScale, _GY + 2);
        ctx.quadraticCurveTo(620 * _mScale, _GY - 4, wW + 20, _GY + 4);
        ctx.stroke();
        ctx.restore();
      }

      if (groundTileInstances && groundTileInstances.length > 0) {
        // --- Instance-mode: draw each placed tile at its explicit world-pixel X ---
        // Used by the course editor stage so only the tiles the user placed are shown;
        // no infinite tiling. Each entry: {sprite, x, offsetY?, scale?}
        for (var _ii = 0; _ii < groundTileInstances.length; _ii++) {
          var _inst = groundTileInstances[_ii];
          if (!_inst || !_inst.sprite) continue;
          var _iEntry = imgFor(_inst.sprite);
          if (!_iEntry || !_iEntry.complete || !_iEntry.naturalWidth) continue;
          var _iImg = _iEntry.draw || _iEntry._img || _iEntry;
          var _iNW = _iImg.naturalWidth || _iImg.width || 64;
          var _iNH = _iImg.naturalHeight || _iImg.height || (wH - groundY);
          var _iScale = Number(_inst.scale) || 1;
          var _iOY = Number(_inst.offsetY) || 0;
          var _iW = Math.round(_iNW * _iScale);
          var _iH = Math.round(_iNH * _iScale);
          var _iX = Number(_inst.x) || 0;
          var _iY = groundY + _iOY;
          // Fill dirt background behind this tile
          ctx.fillStyle = theme.dirt || '#7a5a38';
          ctx.fillRect(_iX, _iY, _iW, wH - _iY);
          // Draw the tile sprite
          ctx.drawImage(_iImg, _iX, _iY, _iW, Math.max(_iH, wH - _iY));
          // Register bbox for hit-testing
          bboxes.push({ kind: 'ground-default', idx: _ii, sprite: _inst.sprite, x: _iX, y: _iY, w: _iW, h: Math.max(_iH, wH - _iY) });
        }
      } else if (groundTiles && groundTiles.length > 0) {
        // --- Full-width tiling mode (used when no explicit instances are provided) ---
        // Collect loaded HTMLImageElement entries from imgFor cache
        var _gtImgs = [];
        var _gtAllLoaded = true;
        for (var _gti = 0; _gti < groundTiles.length; _gti++) {
          var _gtSrc = groundTiles[_gti] && groundTiles[_gti].sprite;
          if (!_gtSrc) continue;
          var _gtEntry = imgFor(_gtSrc);
          var _gtImg = _gtEntry && (_gtEntry.draw || _gtEntry._img || _gtEntry);
          // _gtEntry exposes .complete / .naturalWidth from the underlying image.
          // _gtImg may be an HTMLImageElement or an OffscreenCanvas (killMagenta result);
          // both have .width/.naturalWidth we can test.
          var _loaded = _gtEntry && _gtEntry.complete && _gtEntry.naturalWidth;
          if (_loaded) {
            _gtImgs.push(_gtImg);
          } else {
            _gtAllLoaded = false;
          }
        }
        if (_gtImgs.length > 0) {
          // Fill dirt background color first (visible below tile strip)
          ctx.fillStyle = theme.dirt || '#7a5a38';
          ctx.fillRect(camX - 10, groundY, wW + 20, wH - groundY);
          // Draw tiled sprite strip from groundY down to wH
          var _gtMaxH = 0;
          for (var _m = 0; _m < _gtImgs.length; _m++) {
            var _mh = _gtImgs[_m].naturalHeight || _gtImgs[_m].height || 0;
            if (_mh > _gtMaxH) _gtMaxH = _mh;
          }
          var _tileH = Math.max(_gtMaxH, wH - groundY);
          var _tileW = Math.ceil(wW + 20);
          var _tx = 0;
          var _tidx = 0;
          var _loop = 0;
          ctx.save();
          // Draw tile chain onto an offscreen canvas then blit.
          // Use floored integer positions + 1px overlap to eliminate sub-pixel gaps.
          var _edOff = null;
          try { _edOff = new OffscreenCanvas(_tileW, _tileH); } catch (_) {
            _edOff = document.createElement('canvas');
            _edOff.width = _tileW; _edOff.height = _tileH;
          }
          var _edCtx = _edOff.getContext('2d');
          _edCtx.clearRect(0, 0, _tileW, _tileH);
          while (_tx < _tileW && _loop < 800) {
            var _timg = _gtImgs[_tidx % _gtImgs.length];
            // HTMLImageElement: naturalWidth; OffscreenCanvas/Canvas: width
            var _tw = Math.floor(_timg.naturalWidth || _timg.width || 64);
            var _th = _timg.naturalHeight || _timg.height || _tileH;
            var _dx = Math.floor(_tx);
            // Draw with 1px width-extension to seal sub-pixel seams between tiles
            _edCtx.drawImage(_timg, _dx, 0, _tw + 2, _tileH);
            _tx += _tw;
            _tidx++;
            _loop++;
          }
          ctx.drawImage(_edOff, camX - 10, groundY);
          // Push ground strip bbox so the editor can hit-test clicks on the ground
          bboxes.push({ kind: 'ground-default', idx: 0, sprite: (groundTiles[0] && groundTiles[0].sprite) || '', x: camX - 10, y: groundY, w: wW + 20, h: Math.min(_tileH, wH - groundY) });
          ctx.restore();
        } else {
          // Tiles not yet loaded — fall back to flat colors, will re-render next frame
          ctx.fillStyle = theme.ground || '#9cc26d';
          ctx.fillRect(camX - 10, groundY, wW + 20, wH - groundY);
          ctx.fillStyle = theme.dirt || '#7a5a38';
          ctx.fillRect(camX - 10, groundY + 30, wW + 20, Math.max(0, wH - groundY - 30));
        }
      }
    }

    // --- Backdrop extras: ground-level layers (jagged underground, pebbles, roots) ---
    // Mountains are drawn earlier (after sky gradient) via the separate inline block.
    // Ground-level extras (underground/pebbles/roots) are ONLY drawn when there is at
    // least one ground tile instance placed. Zero instances = sky-only scene.
    if (drawBg && bdExtras && groundTileInstances && groundTileInstances.length > 0) {
      ctx.save();
      ctx.beginPath();
      for (var _ci = 0; _ci < groundTileInstances.length; _ci++) {
        var _cInst = groundTileInstances[_ci];
        if (!_cInst) continue;
        var _ciEntry = imgFor(_cInst.sprite);
        var _ciNW = (_ciEntry && _ciEntry.naturalWidth) || 64;
        var _ciScale = Number(_cInst.scale) || 1;
        var _ciW = Math.round(_ciNW * _ciScale);
        var _ciX = Number(_cInst.x) || 0;
        ctx.rect(_ciX, groundY, _ciW, wH - groundY);
      }
      ctx.clip();
    }
    if (drawBg && bdExtras && groundTileInstances && groundTileInstances.length > 0) {
      // Jagged underground (rock strata + roots)
      if (bdExtras.jaggedUnderground) {
        var _ugRng = makeSeeded(9991, layoutSeed);
        // Strata line 1
        ctx.save();
        ctx.strokeStyle = theme.dirtStrata || 'rgba(100,70,30,0.35)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        var _ux = camX - 10;
        ctx.moveTo(_ux, groundY + 18);
        while (_ux < camX + wW + 10) {
          _ux += 12 + _ugRng() * 16;
          ctx.lineTo(_ux, groundY + 14 + _ugRng() * 12);
        }
        ctx.stroke();
        // Strata line 2
        ctx.beginPath();
        _ux = camX - 10;
        ctx.moveTo(_ux, groundY + 36);
        while (_ux < camX + wW + 10) {
          _ux += 14 + _ugRng() * 20;
          ctx.lineTo(_ux, groundY + 30 + _ugRng() * 14);
        }
        ctx.stroke();
        ctx.restore();
      }
      // Pebbles scattered on ground surface
      if (bdExtras.pebbles) {
        var _prng = makeSeeded(4242, layoutSeed);
        ctx.save();
        ctx.fillStyle = theme.pebble || 'rgba(120,100,80,0.50)';
        var _pCount = Math.floor(wW / 40);
        for (var _pi = 0; _pi < _pCount; _pi++) {
          var _px2 = camX + _prng() * wW;
          var _py2 = groundY - 3 - _prng() * 6;
          var _pr = 2 + _prng() * 4;
          ctx.beginPath();
          ctx.ellipse(_px2, _py2, _pr, _pr * 0.6, _prng() * Math.PI, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      // Roots (short curving lines hanging from groundY)
      if (bdExtras.roots) {
        var _rrng = makeSeeded(7777, layoutSeed);
        ctx.save();
        ctx.strokeStyle = theme.roots || 'rgba(80,50,20,0.30)';
        ctx.lineWidth = 1.5;
        var _rCount = Math.floor(wW / 55);
        for (var _ri = 0; _ri < _rCount; _ri++) {
          var _rx = camX + _rrng() * wW;
          var _rDepth = 12 + _rrng() * 20;
          ctx.beginPath();
          ctx.moveTo(_rx, groundY + 4);
          ctx.bezierCurveTo(_rx + 6, groundY + 8, _rx - 6, groundY + 12, _rx + (_rrng() - 0.5) * 10, groundY + _rDepth);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
    // Close the instance-bounds clip if we opened one
    if (drawBg && bdExtras && groundTileInstances && groundTileInstances.length > 0) {
      ctx.restore();
    }

    // World boundary markers: dashed red lines at x=0 and x=wW
    ctx.save();
    ctx.strokeStyle = 'rgba(255,80,80,0.55)';
    ctx.lineWidth = 2 / camScale;
    ctx.setLineDash([6 / camScale, 4 / camScale]);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, wH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wW, 0); ctx.lineTo(wW, wH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    const ballX = cursor.inside ? cursor.x : Math.floor((camX + wW * 0.4));
    const ballY = cursor.inside ? cursor.y : groundY - 18;

    for (let di = 0; di < decos.length; di++) {
      const d = decos[di];
      const isSelected = di === selectedIdx;
      const img = d.sprite ? imgFor(d.sprite) : null;
      const baseW = Number(d.w) || 32;
      const baseH = Number(d.h) || 36;
      const rawDensity = Number(d.density);
      const useRandomLayout = !(rawDensity === 0 && Array.isArray(d.instances));
      const density = Math.max(0.02, rawDensity || 0.4);
      const offsetY = Number(d.offsetY) || 0;
      const scaleMin = Number(d.scaleMin) || 0.85;
      const scaleMax = Number(d.scaleMax) || 1.15;
      const pivot = d.pivot || { x: 0, y: 0 };
      const layer = d.layer || 'ground';
      const step = Math.max(8, Math.round(100 / density));
      const rng = makeSeeded(di * 911, layoutSeed);

      const drawOne = (px, baseY, scale, trackBbox) => {
        const dw = baseW * scale;
        const dh = baseH * scale;
        const dx = px - dw / 2 + (Number(pivot.x) || 0);
        const dy = (layer === 'sky' ? baseY : baseY - dh) + (Number(pivot.y) || 0);
        if (trackBbox) bboxes.push({ kind: 'deco', idx: di, sprite: d.sprite || '', x: dx, y: dy, w: dw, h: dh });
        ctx.save();
        if (img && img.complete && img.naturalWidth) {
          ctx.drawImage(img.draw || img, dx, dy, dw, dh);
        } else {
          ctx.fillStyle = 'rgba(255,86,184,0.32)';
          ctx.fillRect(dx, dy, dw, dh);
          ctx.strokeStyle = '#ff56b8';
          ctx.lineWidth = 1.25;
          ctx.setLineDash([4, 3]);
          ctx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);
          ctx.setLineDash([]);
        }
        if (isSelected) {
          const lw = 2.5 / camScale;
          ctx.strokeStyle = 'rgba(0,220,255,0.95)';
          ctx.setLineDash([5 / camScale, 3 / camScale]);
          ctx.lineWidth = lw;
          ctx.strokeRect(dx - lw, dy - lw, dw + lw * 2, dh + lw * 2);
          ctx.setLineDash([]);
          const hs = 5 / camScale;
          ctx.fillStyle = 'rgba(0,220,255,0.95)';
          [[dx - lw, dy - lw],[dx + dw + lw - hs, dy - lw],[dx - lw, dy + dh + lw - hs],[dx + dw + lw - hs, dy + dh + lw - hs]].forEach(([hx, hy]) => ctx.fillRect(hx, hy, hs, hs));
        }
        ctx.restore();
      };

      // Explicit Place-mode instances first.
      if (Array.isArray(d.instances)) {
        for (const inst of d.instances) {
          const px = (Number(inst.xFrac) || 0) * wW;
          const baseY = (layer === 'sky') ? (groundY * 0.3) : (groundY + (Number(inst.yOff) || 0));
          drawOne(px, baseY, Number(inst.scale) || 1, true);
        }
      }
      if (!useRandomLayout) continue;

      for (let x = 8; x < wW - 8; x += step) {
        const jitter = (rng() - 0.5) * step * 0.6;
        let px = x + jitter;
        const scale = scaleMin + rng() * Math.max(0, scaleMax - scaleMin);
        const sz0 = dstSize(img, baseW, baseH, scale);
        const dw = sz0.dw;
        const dh = sz0.dh;

        let baseY;
        if (layer === 'sky') {
          const fracMin = Math.max(0, Math.min(0.95, Number(d.skyMin) || 0.1));
          const fracMax = Math.max(fracMin + 0.01, Math.min(0.98, Number(d.skyMax) || 0.5));
          const yFrac = fracMin + rng() * (fracMax - fracMin);
          baseY = groundY * yFrac;
        } else {
          baseY = groundY + offsetY;
        }

        const phase = rng() * Math.PI * 2;
        if (layer === 'sky' && d.motion && d.motion.type) {
          const speed = Number(d.motion.speed) || 0;
          const wobble = Number(d.motion.wobbleAmp) || 0;
          if (d.motion.type === 'drift') {
            px = ((px + t * speed) % (wW + dw + 80)) - 40;
            baseY += Math.sin(t * 0.6 + phase) * wobble;
          } else if (d.motion.type === 'flap') {
            px += Math.sin(t * speed * 0.05 + phase) * 30;
            baseY += Math.cos(t * speed * 0.07 + phase * 0.7) * wobble;
          }
        }

        const dx = px - dw / 2 + (Number(pivot.x) || 0);
        const dy = (layer === 'sky' ? baseY : baseY - dh) + (Number(pivot.y) || 0);

        bboxes.push({ kind: 'deco', idx: di, sprite: d.sprite || '', x: dx, y: dy, w: dw, h: dh });
        ctx.save();
        const pivotPX = dx + dw / 2;
        const pivotPY = layer === 'sky' ? (baseY + dh * 0.5) : (groundY + offsetY);

        if (img && img.complete && img.naturalWidth) {
          ctx.drawImage(img.draw || img, dx, dy, dw, dh);
        } else {
          ctx.fillStyle = 'rgba(255,86,184,0.32)';
          ctx.fillRect(dx, dy, dw, dh);
          ctx.strokeStyle = '#ff56b8';
          ctx.lineWidth = 1.25;
          ctx.setLineDash([4, 3]);
          ctx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);
          ctx.setLineDash([]);
          if (!d.sprite) {
            ctx.fillStyle = '#fff';
            ctx.font = '600 9px Fredoka, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('no sprite', dx + dw / 2, dy + dh / 2 + 3);
          }
        }

        if (isSelected) {
          const lw = 2.5 / camScale;
          ctx.strokeStyle = 'rgba(0,220,255,0.95)';
          ctx.setLineDash([5 / camScale, 3 / camScale]);
          ctx.lineWidth = lw;
          ctx.strokeRect(dx - lw, dy - lw, dw + lw * 2, dh + lw * 2);
          ctx.setLineDash([]);
          const hs = 5 / camScale;
          ctx.fillStyle = 'rgba(0,220,255,0.95)';
          [[dx - lw, dy - lw],[dx + dw + lw - hs, dy - lw],[dx - lw, dy + dh + lw - hs],[dx + dw + lw - hs, dy + dh + lw - hs]].forEach(([hx, hy]) => ctx.fillRect(hx, hy, hs, hs));
        }

        if (isSelected && d.collider && d.collider.shape) {
          ctx.fillStyle = 'rgba(255,179,71,0.18)';
          ctx.strokeStyle = '#ffb347';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          const cox = pivotPX + (Number(d.collider.ox) || 0);
          const coy = pivotPY + (Number(d.collider.oy) || 0);
          const ang = ((Number(d.collider.angle) || 0) * Math.PI) / 180;
          if (d.collider.shape === 'circle') {
            ctx.arc(cox, coy, Math.max(2, Number(d.collider.r) || 14), 0, Math.PI * 2);
          } else if (d.collider.shape === 'ellipse') {
            ctx.ellipse(cox, coy, Math.max(2, Number(d.collider.rx) || 18), Math.max(2, Number(d.collider.ry) || 10), ang, 0, Math.PI * 2);
          } else {
            const cw = Math.max(4, Number(d.collider.w) || 24);
            const ch = Math.max(4, Number(d.collider.h) || 18);
            ctx.save();
            ctx.translate(cox, coy);
            if (ang) ctx.rotate(ang);
            ctx.rect(-cw / 2, -ch / 2, cw, ch);
            ctx.restore();
          }
          ctx.fill(); ctx.stroke();
        }
        ctx.restore();
      }
    }

    if (drawBall && cursor.inside) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(ballX, ballY, 12, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath();
      ctx.arc(ballX, ballY, 60, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Close camera transform
    ctx.restore();

    // Expose bboxes globally for hit-testing by the editor
    if (typeof window !== 'undefined') {
      window.__editorBBoxes = bboxes;
    }

    return { decoCount: decos.length, groundY: groundY, bboxes: bboxes };
  }

  // Returns true if ANY decoration in the list is animated (sky + motion).
  function hasMotion(decorations) {
    return (decorations || []).some(function (d) {
      return d.layer === 'sky' && d.motion && d.motion.type;
    });
  }

  root.SceneDecoration = {
    SHAPE_LABELS: SHAPE_LABELS,
    defaultDecorationSchema: defaultDecorationSchema,
    defaultColliderFor: defaultColliderFor,
    defaultTriggerFor: defaultTriggerFor,
    defaultMotionFor: defaultMotionFor,
    createImageCache: createImageCache,
    renderStage: renderStage,
    hasMotion: hasMotion,
    killMagenta: killMagenta,
    dstSize: dstSize
  };
})(typeof window !== 'undefined' ? window : globalThis);
