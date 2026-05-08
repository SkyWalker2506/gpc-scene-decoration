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
  //   cursor (optional)        — { x, y, inside } in CSS px
  //   imgFor(src) -> entry     — image cache lookup
  //   time (optional)          — seconds (defaults to performance.now()/1000)
  //   layoutSeed (optional)    — number, default 0.42
  //   drawBackground (optional, default true) — set false to render decorations
  //                              over a caller-provided scene
  //   drawBall (optional, default true) — show the cursor "ball" indicator
  //   groundFrac (optional, default 0.66) — vertical ground line as fraction
  //   groundTiles (optional)   — [{sprite, weight}] tile chain; replaces flat ground colors
  // returns { decoCount }
  function renderStage(opts) {
    const ctx        = opts.ctx;
    const w          = opts.w;
    const h          = opts.h;
    const theme      = opts.theme || {};
    const decos      = opts.decorations || [];
    const selectedIdx = (typeof opts.selectedIdx === 'number') ? opts.selectedIdx : -1;
    const cursor     = opts.cursor || { x: -9999, y: -9999, inside: false };
    const imgFor     = opts.imgFor || function () { return null; };
    const t          = (typeof opts.time === 'number') ? opts.time : (performance.now() / 1000);
    const layoutSeed = (typeof opts.layoutSeed === 'number') ? opts.layoutSeed : 0.42;
    const groundFrac  = (typeof opts.groundFrac === 'number') ? opts.groundFrac : 0.66;
    const drawBg      = opts.drawBackground !== false;
    const drawBall    = opts.drawBall !== false;
    const groundTiles = Array.isArray(opts.groundTiles) ? opts.groundTiles : null;

    const groundY = Math.floor(h * groundFrac);

    if (drawBg) {
      // Sky gradient
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, theme.sky1 || '#c9e3ef');
      grad.addColorStop(1, theme.sky2 || '#eaf4da');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      if (groundTiles && groundTiles.length > 0) {
        // --- Sprite-based ground + underground ---
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
          ctx.fillRect(0, groundY, w, h - groundY);
          // Draw tiled sprite strip from groundY down to h
          var _gtMaxH = 0;
          for (var _m = 0; _m < _gtImgs.length; _m++) {
            var _mh = _gtImgs[_m].naturalHeight || _gtImgs[_m].height || 0;
            if (_mh > _gtMaxH) _gtMaxH = _mh;
          }
          var _tileH = Math.max(_gtMaxH, h - groundY);
          var _tx = 0;
          var _tidx = 0;
          var _loop = 0;
          ctx.save();
          while (_tx < w + 4 && _loop < 800) {
            var _timg = _gtImgs[_tidx % _gtImgs.length];
            // HTMLImageElement: naturalWidth; OffscreenCanvas/Canvas: width
            var _tw = _timg.naturalWidth || _timg.width || 64;
            ctx.drawImage(_timg, _tx, groundY, _tw, _tileH);
            _tx += _tw;
            _tidx++;
            _loop++;
          }
          ctx.restore();
        } else {
          // Tiles not yet loaded — fall back to flat colors, will re-render next frame
          ctx.fillStyle = theme.ground || '#9cc26d';
          ctx.fillRect(0, groundY, w, h - groundY);
          ctx.fillStyle = theme.dirt || '#7a5a38';
          ctx.fillRect(0, groundY + 30, w, Math.max(0, h - groundY - 30));
        }
      } else {
        // --- Flat color ground (legacy / no tiles) ---
        ctx.fillStyle = theme.ground || '#9cc26d';
        ctx.fillRect(0, groundY, w, h - groundY);
        ctx.fillStyle = theme.dirt || '#7a5a38';
        ctx.fillRect(0, groundY + 30, w, Math.max(0, h - groundY - 30));
      }
    }

    const ballX = cursor.inside ? cursor.x : Math.floor(w * 0.4);
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

      const drawOne = (px, baseY, scale) => {
        const dw = baseW * scale;
        const dh = baseH * scale;
        const dx = px - dw / 2 + (Number(pivot.x) || 0);
        const dy = (layer === 'sky' ? baseY : baseY - dh) + (Number(pivot.y) || 0);
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
          ctx.strokeStyle = 'rgba(109,210,138,0.95)';
          ctx.setLineDash([4, 3]);
          ctx.lineWidth = 1.5;
          ctx.strokeRect(dx, dy, dw, dh);
          ctx.setLineDash([]);
        }
        ctx.restore();
      };

      // Explicit Place-mode instances first.
      if (Array.isArray(d.instances)) {
        for (const inst of d.instances) {
          const px = (Number(inst.xFrac) || 0) * w;
          const baseY = (layer === 'sky') ? (groundY * 0.3) : (groundY + (Number(inst.yOff) || 0));
          drawOne(px, baseY, Number(inst.scale) || 1);
        }
      }
      if (!useRandomLayout) continue;

      for (let x = 8; x < w - 8; x += step) {
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
            px = ((px + t * speed) % (w + dw + 80)) - 40;
            baseY += Math.sin(t * 0.6 + phase) * wobble;
          } else if (d.motion.type === 'flap') {
            px += Math.sin(t * speed * 0.05 + phase) * 30;
            baseY += Math.cos(t * speed * 0.07 + phase * 0.7) * wobble;
          }
        }

        const dx = px - dw / 2 + (Number(pivot.x) || 0);
        const dy = (layer === 'sky' ? baseY : baseY - dh) + (Number(pivot.y) || 0);

        let rot = 0, scaleK = 1;
        if (d.trigger && d.trigger.type === 'ballNear' && cursor.inside) {
          const radius = Math.max(8, Number(d.trigger.radius) || 60);
          const dist = Math.hypot(px - ballX, (groundY - 10) - ballY);
          if (dist < radius) {
            const tt = 1 - dist / radius;
            const dir = ballX < px ? 1 : -1;
            const strength = Number(d.trigger.strength) || 0.5;
            if (d.trigger.anim === 'bend') rot = tt * strength * 0.9 * dir;
            else if (d.trigger.anim === 'wobble') rot = Math.sin(performance.now() * 0.012) * tt * strength * 0.5 * dir;
            else if (d.trigger.anim === 'pop') scaleK = 1 + tt * strength * 0.5;
          }
        } else if (d.trigger && d.trigger.type === 'ballOver' && cursor.inside) {
          const dx2 = Math.abs(px - ballX);
          if (dx2 < dw * 0.6 && Math.abs(ballY - (groundY - 10)) < 30) {
            const strength = Number(d.trigger.strength) || 0.7;
            if (d.trigger.anim === 'bend') rot = 0.6 * strength * (ballX < px ? 1 : -1);
            else if (d.trigger.anim === 'wobble') rot = Math.sin(performance.now() * 0.02) * strength * 0.4;
            else if (d.trigger.anim === 'pop') scaleK = 1 + strength * 0.45;
          }
        }

        ctx.save();
        const pivotPX = dx + dw / 2;
        const pivotPY = layer === 'sky' ? (baseY + dh * 0.5) : (groundY + offsetY);
        ctx.translate(pivotPX, pivotPY);
        if (rot) ctx.rotate(rot);
        if (scaleK !== 1) ctx.scale(scaleK, scaleK);
        ctx.translate(-pivotPX, -pivotPY);

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
          ctx.strokeStyle = 'rgba(109,210,138,0.95)';
          ctx.setLineDash([4, 3]);
          ctx.lineWidth = 1.5;
          ctx.strokeRect(dx, dy, dw, dh);
          ctx.setLineDash([]);
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

    return { decoCount: decos.length, groundY: groundY };
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
