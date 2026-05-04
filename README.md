# gpc-scene-decoration

Generic, project-agnostic scene-decoration system for HTML5 canvas games and
their editors. Lets a host application define a per-scene list of decoration
sprites (grass tufts, clouds, butterflies, crystals, …) with:

- **density** + **scale range** + **layer** (`ground` / `sky`) for procedural
  scatter, with a stable seeded RNG so positions don't shimmer between frames
- **explicit `instances:[{xFrac, yOff, scale}]`** drag-drop placements that
  override the random layout (set `density: 0` to use only explicit instances)
- **motion**: `drift` (horizontal scroll + sine wobble) or `flap`
  (sinusoidal flutter), sky-layer only
- **trigger animations**: `ballNear` (bend / wobble / pop within radius) or
  `ballOver` (overhead reaction), driven by an arbitrary cursor position
- **collider preview** for the selected decoration (circle / ellipse / rect)
- a built-in chroma-key (magenta) stripper for AI-generated PNGs whose
  pipeline left fringe pixels behind

Extracted from the
[Golf: Paper Craft](https://github.com/SkyWalker2506/golf-paper-craft) Course
Editor — the golf-specific course catalogue, sprite preset table, starter
decorations and `localStorage` schema all stay in the host project; this
submodule deals only with the generic decoration runtime + canvas renderer.

## Quick start

```html
<script src="./src/scene-decoration.js"></script>
<script>
  const ctx = canvas.getContext('2d');
  const cache = SceneDecoration.createImageCache({ onLoad: () => render() });
  const decorations = [
    { sprite: 'tuft.png', layer: 'ground', density: 0.06, w: 28, h: 36,
      trigger: { type: 'ballNear', radius: 50, anim: 'bend', strength: 0.6 } },
    { sprite: 'cloud.png', layer: 'sky', density: 0.07, w: 110, h: 60,
      skyMin: 0.05, skyMax: 0.25,
      motion: { type: 'drift', speed: 8, wobbleAmp: 3 } }
  ];
  function render() {
    SceneDecoration.renderStage({
      ctx, w: 800, h: 480,
      theme: { sky1: '#c9e3ef', sky2: '#eaf4da', ground: '#9cc26d', dirt: '#7a5a38' },
      decorations,
      imgFor: (s) => cache.get(s),
      cursor: { x: 400, y: 200, inside: true } // optional, drives ballNear / ballOver
    });
  }
  render();
</script>
```

See [`examples/standalone.html`](examples/standalone.html) for a working two-scene demo.

## API

| Function | Purpose |
| --- | --- |
| `SceneDecoration.defaultDecorationSchema(spritePath, suggest?)` | Construct a fully-populated decoration object. |
| `SceneDecoration.defaultColliderFor(shape)` | `circle` / `ellipse` / `rect` defaults. |
| `SceneDecoration.defaultTriggerFor(type)`   | `ballNear` / `ballOver` defaults. |
| `SceneDecoration.defaultMotionFor(type)`    | `drift` / `flap` defaults. |
| `SceneDecoration.createImageCache({ resolveSrc?, onLoad?, stripMagenta? })` | Image cache with optional custom-src resolver and a load callback. Magenta chroma-key is stripped by default. |
| `SceneDecoration.renderStage({ ctx, w, h, theme, decorations, ... })` | Draw a full stage: gradient sky + ground bands + every decoration with motion / triggers / collider preview. Set `drawBackground: false` to skip the gradient + ground (lets the host render its own scene first). |
| `SceneDecoration.hasMotion(decorations)` | `true` if any decoration in the list animates (used by host to decide whether to keep RAF-running). |

## Schema

```js
{
  sprite:   'path/to/sprite.png', // also accepts 'custom:ID' if you wire resolveSrc
  layer:    'ground' | 'sky',
  density:  0.06,                  // 0 = use explicit `instances` only
  offsetY:  0,                     // ground-layer Y offset from the ground line
  scaleMin: 0.85, scaleMax: 1.2,
  w: 32, h: 36,                    // base draw size; height auto-fits to image aspect
  pivot: { x: 0, y: 0 },
  collider: { shape: 'circle', ox: 0, oy: -10, r: 14 } | null,
  trigger:  { type: 'ballNear', radius: 50, anim: 'bend', strength: 0.6 } | null,
  motion:   { type: 'drift', speed: 8, wobbleAmp: 3 } | null,  // sky only
  skyMin: 0.10, skyMax: 0.45,      // sky-layer vertical placement window
  instances: [ { xFrac: 0.5, yOff: -20, scale: 1 } ]   // optional drag-drop placements
}
```

## License

MIT
