"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import gsap from "gsap";

/* -------------------------------------------------------------------------- */
/*  Content + theme tokens                                                     */
/* -------------------------------------------------------------------------- */

const PARAGRAPH = `Earth is the third planet from the Sun and the only world we know of where liquid water covers the surface. It races around the Sun at thirty kilometres a second, spinning once on its tilted axis each day. Beneath our feet a molten iron core generates the magnetic field that shields the atmosphere. A thin veil of gases, barely a hundred kilometres of breathable sky, is all that separates every living thing from the vacuum of space. Oceans hold ninety seven percent of its water and drive the weather that carves its restless surface.`;

/* The band always holds exactly this many full lines. Words flow from
   PARAGRAPH until every line is packed edge to edge (cycling back to the start
   if the copy runs short), so keep it long enough to fill the band — anything
   left over is simply not drawn. */
const MAX_LINES = 4;

const THEME = {
  light: {
    base: "#e8e6e2",
    sphere: "#ffffff",
    land: "#d5d0c6",
    text: "#0b0b0b",
    // Two washes plus a warm floor: flat fills are what made this read as raw.
    backdrop:
      "radial-gradient(120% 90% at 50% 8%, #f6f5f3 0%, #e8e6e2 46%, #d6d3cd 100%)",
  },
  dark: {
    base: "#0d0d0f",
    sphere: "#050505",
    land: "#26262b",
    text: "#f4f4f4",
    backdrop:
      "radial-gradient(120% 90% at 50% 8%, #232327 0%, #131315 46%, #0a0a0b 100%)",
  },
};

/* Editorial furniture. Kept as data so the layout stays declarative. */
const STATS = [
  { label: "Diameter", value: "12,742", unit: "km" },
  { label: "Orbital period", value: "365.25", unit: "days" },
  { label: "Axial tilt", value: "23.44", unit: "deg" },
  { label: "Age", value: "4.54", unit: "Gyr" },
];

/* Film grain, inline so the page stays self-contained — a flat gradient reads
   as plastic at this scale, and a little noise is what kills the banding. */
const GRAIN =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E";

/* Texture / geometry proportions.

   The type is painted onto a full sphere shell a hair larger than the solid
   one, so every glyph is bedded into the surface curvature. Which latitudes it
   occupies is controlled purely by the texture's V offset — dragging slides the
   band up toward the north pole or down toward the south, and the sphere itself
   never moves. Because the shell's circumference shrinks as sin(theta), the
   text naturally compresses and curves as it climbs toward a pole.

   BAND_V_SPAN is the slice of the sphere's 0..1 V range the band covers, derived
   from the canvas aspect so the text is undistorted when it sits at the equator. */
/* Both dimensions MUST stay powers of two. The shell repeats this texture
   around the equator and mipmaps it; a non-power-of-two size combined with
   RepeatWrapping samples as fully transparent on strict drivers, which silently
   erases the entire band. 4096x1024 also keeps the 4:1 aspect the wrap expects. */
const CANVAS_W = 4096;
const CANVAS_H = 512;
const SPHERE_RADIUS = 1.62;
const SHELL_GAP = 0.04; // lifts the type clear of the surface so it hovers
const SHELL_RADIUS = SPHERE_RADIUS + SHELL_GAP;
const BAND_V_SPAN = (2 * CANVAS_H) / CANVAS_W;

/* How far the band may climb. 1.0 would park its edge exactly on a pole, but a
   four-line band that high sits over the horizon and reads as no text at all,
   so stop short: the type reaches the top of the visible face and stays there. */
const MAX_LAT = 0.7;

/* Earth's real axial tilt — the same figure the stat row quotes — and how fast
   the globe turns, in radians per second. Deliberately slower than the type's
   drift so the band visibly overtakes the surface instead of riding along. */
const AXIAL_TILT = (23.44 * Math.PI) / 180;
const GLOBE_SPIN = 0.33;

/* Map a latitude in -1 (south pole) .. 1 (north pole) to the texture V offset
   that puts the band there. The ends are where the band's edge kisses a pole,
   so the text always stays on the sphere instead of collapsing through it. */
function bandOffset(lat) {
  // Coerce hard: a single NaN reaching texture.offset poisons the UV matrix and
  // the whole band silently stops sampling. Fast Refresh can hand us a ref from
  // an older shape where `lat` did not exist yet, so this is not theoretical.
  const safe = Number.isFinite(lat) ? Math.max(-1, Math.min(1, lat)) : 0;
  const centre = 0.5 + safe * (0.5 - BAND_V_SPAN / 2);
  return 1 - (centre + BAND_V_SPAN / 2) / BAND_V_SPAN;
}

/* -------------------------------------------------------------------------- */
/*  Canvas 2D -> THREE.CanvasTexture                                           */
/*  No 3D text geometry: one draw call, one texture, zero glyph tessellation.   */
/* -------------------------------------------------------------------------- */

function createTextTexture(text, color) {
  // Client-only: guard against the Next.js server render pass.
  if (typeof document === "undefined") return null;

  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  const maxHeight = CANVAS_H * 0.88;
  const font = (size) =>
    `500 ${size}px "Space Grotesk", "Helvetica Neue", Helvetica, Arial, sans-serif`;

  // The band always holds MAX_LINES full lines, so the size is fixed by the
  // canvas height — no shrink-to-fit. The copy adapts to the space, not the
  // other way round.
  const fontSize = Math.floor(maxHeight / (MAX_LINES * 1.12));
  const lineHeight = fontSize * 1.12;

  // Set the font AND the tracking before measuring — letterSpacing changes
  // what measureText reports, so it must match what fillText will draw.
  ctx.font = font(fontSize);
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  if ("letterSpacing" in ctx) ctx.letterSpacing = "-0.08em";

  /* Pack every line edge to edge with words at their natural spacing. The
     canvas wraps exactly once around the sphere, so a part-filled line leaves
     a blank seam where its end meets its start; instead of stretching the
     spaces to close it, words keep flowing (cycling back through the copy if
     it runs short) until no more fit. The leftover — always less than one
     word — is what remains at the seam, and it reads as an ordinary gap. */
  const sourceWords = text.split(/\s+/);
  const spaceW = ctx.measureText(" ").width;
  const lines = [];
  let w = 0;

  // Reserve one word-space at the seam: a line packed flush to the very edge
  // meets its own first word with zero gap and two words fuse into one.
  const lineBudget = CANVAS_W - spaceW;

  for (let i = 0; i < MAX_LINES; i++) {
    let line = "";
    let width = 0;
    for (;;) {
      const word = sourceWords[w % sourceWords.length];
      const wordW = ctx.measureText(word).width;
      const next = line ? width + spaceW + wordW : wordW;
      if (next > lineBudget && line) break;
      line = line ? `${line} ${word}` : word;
      width = next;
      w++;
    }
    lines.push(line);
  }

  ctx.textAlign = "center";
  const blockTop =
    CANVAS_H / 2 - (lines.length * lineHeight) / 2 + lineHeight / 2;
  lines.forEach((l, i) =>
    ctx.fillText(l, CANVAS_W / 2, blockTop + i * lineHeight),
  );

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 16;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;

  // Clamp on both axes. U already spans 0..1 exactly once around the shell so
  // repeating buys nothing, and clamping keeps this off the NPOT/repeat path
  // that some drivers resolve to a fully transparent sample. Outside the band
  // the shell reads the canvas's transparent edge row, so the sphere stays bare.
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.repeat.set(1, 1 / BAND_V_SPAN);
  texture.offset.y = bandOffset(0);

  texture.needsUpdate = true;
  return texture;
}

/* -------------------------------------------------------------------------- */
/*  Continents                                                                 */
/*                                                                             */
/*  Simplified coastlines as [lon, lat] rings, painted into an equirectangular  */
/*  canvas — the same trick as the type, so the whole component still ships     */
/*  with zero external assets. Drawn white on transparent: the material's       */
/*  colour tints them, which means one texture serves both themes and the       */
/*  land can cross-fade with GSAP instead of being rebuilt on every toggle.     */
/* -------------------------------------------------------------------------- */

const LAND_W = 2048;
const LAND_H = 1024;

const COASTLINES = [
  // Africa
  [
    [-17, 21],
    [-16, 16],
    [-17, 15],
    [-15, 12],
    [-13, 9],
    [-8, 5],
    [-3, 5],
    [3, 6],
    [9, 4],
    [9, 2],
    [12, -2],
    [13, -6],
    [12, -11],
    [14, -17],
    [15, -22],
    [18, -27],
    [20, -33],
    [24, -34],
    [28, -32],
    [32, -29],
    [33, -25],
    [35, -21],
    [39, -16],
    [40, -11],
    [41, -5],
    [42, 0],
    [45, 4],
    [51, 11],
    [48, 13],
    [44, 12],
    [43, 14],
    [39, 15],
    [38, 18],
    [36, 22],
    [34, 28],
    [32, 31],
    [26, 32],
    [20, 31],
    [15, 32],
    [11, 34],
    [3, 37],
    [-1, 36],
    [-6, 36],
    [-10, 32],
    [-13, 28],
    [-16, 25],
  ],
  // Eurasia
  [
    [-10, 36],
    [-9, 39],
    [-9, 43],
    [-2, 44],
    [-1, 46],
    [-4, 48],
    [-1, 49],
    [2, 51],
    [4, 52],
    [7, 53],
    [9, 54],
    [8, 57],
    [11, 58],
    [13, 55],
    [19, 54],
    [21, 56],
    [24, 57],
    [28, 59],
    [30, 60],
    [27, 65],
    [22, 66],
    [24, 70],
    [31, 70],
    [40, 68],
    [50, 69],
    [60, 71],
    [70, 73],
    [80, 74],
    [95, 78],
    [105, 77],
    [113, 74],
    [125, 74],
    [135, 72],
    [150, 71],
    [160, 70],
    [170, 69],
    [179, 66],
    [172, 62],
    [163, 58],
    [160, 53],
    [155, 52],
    [143, 50],
    [140, 46],
    [135, 44],
    [131, 43],
    [128, 39],
    [126, 34],
    [122, 31],
    [121, 26],
    [117, 22],
    [112, 20],
    [108, 15],
    [105, 10],
    [103, 6],
    [100, 7],
    [98, 10],
    [95, 16],
    [92, 21],
    [88, 22],
    [84, 18],
    [80, 15],
    [77, 8],
    [75, 15],
    [72, 20],
    [68, 23],
    [66, 25],
    [62, 25],
    [58, 23],
    [54, 25],
    [50, 28],
    [48, 30],
    [45, 35],
    [40, 36],
    [35, 36],
    [30, 37],
    [26, 37],
    [22, 39],
    [18, 40],
    [14, 41],
    [12, 45],
    [9, 44],
    [4, 43],
    [0, 39],
    [-6, 37],
  ],
  // North America
  [
    [-168, 66],
    [-165, 60],
    [-162, 58],
    [-158, 57],
    [-152, 59],
    [-146, 60],
    [-140, 60],
    [-135, 57],
    [-130, 53],
    [-125, 49],
    [-124, 44],
    [-122, 38],
    [-118, 34],
    [-114, 31],
    [-110, 24],
    [-106, 22],
    [-98, 19],
    [-94, 18],
    [-91, 16],
    [-88, 16],
    [-87, 21],
    [-90, 22],
    [-94, 26],
    [-97, 28],
    [-94, 30],
    [-89, 29],
    [-84, 30],
    [-81, 25],
    [-80, 32],
    [-76, 35],
    [-74, 40],
    [-70, 43],
    [-67, 45],
    [-64, 46],
    [-60, 47],
    [-56, 51],
    [-64, 54],
    [-70, 56],
    [-78, 57],
    [-79, 62],
    [-73, 63],
    [-77, 68],
    [-83, 70],
    [-90, 70],
    [-100, 69],
    [-110, 69],
    [-120, 70],
    [-130, 70],
    [-140, 70],
    [-150, 71],
    [-158, 70],
    [-165, 68],
  ],
  // South America
  [
    [-81, 7],
    [-77, 8],
    [-72, 11],
    [-64, 11],
    [-60, 8],
    [-52, 5],
    [-50, 0],
    [-44, -2],
    [-38, -5],
    [-35, -8],
    [-38, -13],
    [-39, -18],
    [-42, -23],
    [-48, -26],
    [-53, -34],
    [-57, -38],
    [-62, -40],
    [-63, -45],
    [-66, -50],
    [-69, -54],
    [-73, -53],
    [-74, -46],
    [-73, -40],
    [-72, -33],
    [-71, -25],
    [-70, -18],
    [-76, -14],
    [-79, -7],
    [-81, -4],
    [-80, 0],
    [-78, 2],
  ],
  // Australia
  [
    [113, -22],
    [114, -26],
    [116, -32],
    [120, -34],
    [126, -32],
    [131, -32],
    [136, -35],
    [140, -38],
    [146, -39],
    [150, -37],
    [153, -30],
    [153, -25],
    [149, -21],
    [146, -18],
    [142, -11],
    [136, -12],
    [131, -11],
    [126, -14],
    [122, -17],
    [117, -20],
  ],
  // Greenland
  [
    [-45, 60],
    [-52, 64],
    [-54, 68],
    [-58, 72],
    [-60, 76],
    [-55, 80],
    [-45, 83],
    [-32, 83],
    [-22, 80],
    [-20, 75],
    [-25, 70],
    [-32, 66],
    [-40, 62],
  ],
  // Indonesia, Madagascar, Japan, British Isles, New Zealand
  [
    [95, 5],
    [105, -6],
    [115, -8],
    [120, -9],
    [127, -8],
    [131, -2],
    [128, 2],
    [120, 0],
    [112, -2],
    [104, -3],
    [98, 2],
  ],
  [
    [43, -12],
    [49, -13],
    [50, -18],
    [47, -25],
    [45, -22],
    [43, -17],
  ],
  [
    [130, 31],
    [132, 34],
    [136, 35],
    [140, 38],
    [142, 41],
    [145, 44],
    [142, 45],
    [139, 40],
    [135, 34],
    [131, 32],
  ],
  [
    [-5, 50],
    [-1, 51],
    [1, 52],
    [-1, 55],
    [-3, 58],
    [-5, 58],
    [-6, 55],
  ],
  [
    [173, -35],
    [176, -38],
    [178, -38],
    [175, -41],
    [171, -44],
    [168, -47],
    [166, -45],
    [170, -42],
    [172, -38],
  ],
];

function createLandTexture() {
  if (typeof document === "undefined") return null;

  const canvas = document.createElement("canvas");
  canvas.width = LAND_W;
  canvas.height = LAND_H;

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, LAND_W, LAND_H);
  ctx.fillStyle = "#ffffff";

  // Equirectangular: longitude spans the width, latitude the height.
  const px = (lon) => ((lon + 180) / 360) * LAND_W;
  const py = (lat) => ((90 - lat) / 180) * LAND_H;

  for (const ring of COASTLINES) {
    ctx.beginPath();
    ring.forEach(([lon, lat], i) => {
      const x = px(lon);
      const y = py(lat);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
  }

  // Antarctica is a cap, not a ring — fill the bottom band outright.
  ctx.fillRect(0, py(-68), LAND_W, LAND_H - py(-68));

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 16;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/* -------------------------------------------------------------------------- */
/*  The sphere + orbiting text band                                            */
/* -------------------------------------------------------------------------- */

function TypographyGlobe({ drag, isDark }) {
  const textGroup = useRef(null);
  const globeGroup = useRef(null);
  const sphereMat = useRef(null);
  const landMat = useRef(null);
  const palette = isDark ? THEME.dark : THEME.light;

  // Canvas 2D ignores webfonts that have not finished loading, so the first
  // paint would silently fall back to Helvetica. Track readiness and rebuild
  // the texture once Space Grotesk is actually available.
  const [fontReady, setFontReady] = useState(
    () =>
      typeof document !== "undefined" &&
      document.fonts?.check?.('500 104px "Space Grotesk"'),
  );
  useEffect(() => {
    if (fontReady || typeof document === "undefined" || !document.fonts?.load)
      return;
    let cancelled = false;
    document.fonts
      .load('500 104px "Space Grotesk"')
      .then(() => !cancelled && setFontReady(true))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fontReady]);

  // Theme-independent: the material tints it, so it is built exactly once.
  const landTexture = useMemo(() => createLandTexture(), []);
  useEffect(() => () => landTexture?.dispose(), [landTexture]);

  // Heavy work happens here only, and only when the theme flips or the
  // webfont arrives.
  const textTexture = useMemo(
    () => createTextTexture(PARAGRAPH, palette.text),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [palette.text, fontReady],
  );

  useEffect(() => {
    if (!textTexture) return;
    // A fresh texture starts at the equator; snap it to wherever the band was
    // left so flipping the theme never slides the type back down the sphere.
    textTexture.offset.y = bandOffset(drag.current.lat);
    // Dispose the previous one so repeated toggles do not leak GPU memory.
    return () => textTexture.dispose();
  }, [textTexture, drag]);

  useEffect(() => {
    if (!sphereMat.current) return;
    gsap.to(sphereMat.current.color, {
      ...new THREE.Color(palette.sphere),
      duration: 0.9,
      ease: "power2.inOut",
    });
  }, [palette.sphere]);

  useEffect(() => {
    if (!landMat.current) return;
    gsap.to(landMat.current.color, {
      ...new THREE.Color(palette.land),
      duration: 0.9,
      ease: "power2.inOut",
    });
  }, [palette.land]);

  useFrame((_, delta) => {
    // Clamp: delta spikes to seconds when a backgrounded tab is refocused,
    // which would otherwise snap the globe through a full revolution.
    if (globeGroup.current) {
      globeGroup.current.rotation.y += Math.min(delta, 0.1) * GLOBE_SPIN;
    }

    if (!textGroup.current) return;

    // Idle drift: nudge the *target*, never the mesh, so drag and auto-spin
    // feed the exact same easing pipeline.
    if (!drag.current.active) drag.current.spin += 0.0022;

    if (!Number.isFinite(drag.current.spin)) drag.current.spin = 0;
    if (!Number.isFinite(drag.current.lat)) drag.current.lat = 0;

    gsap.to(textGroup.current.rotation, {
      y: drag.current.spin,
      duration: 1.8,
      ease: "power3.out",
      overwrite: true,
    });

    // Same treatment for the climb: the band eases toward its target latitude
    // instead of tracking the pointer, so it carries the same weight as a spin.
    if (textTexture) {
      gsap.to(textTexture.offset, {
        y: bandOffset(drag.current.lat),
        duration: 1.8,
        ease: "power3.out",
        overwrite: true,
      });
    }
  });

  return (
    <group rotation={[0, 0, -0.1]} position={[0, 0.42, 0]}>
      {/* The globe turns on its own tilted axis, independently of the type.
          Drag still never touches it — only the band responds to the pointer. */}
      <group rotation={[0, 0, -AXIAL_TILT]}>
        <group ref={globeGroup}>
          <mesh>
            <sphereGeometry args={[SPHERE_RADIUS, 96, 96]} />
            <meshStandardMaterial
              ref={sphereMat}
              color={palette.sphere}
              roughness={0.55}
              metalness={0}
            />
          </mesh>

          {/* Landmasses ride just above the ocean sphere so they can carry
              their own tweened colour without disturbing the sphere's own. */}
          {landTexture && (
            <mesh>
              <sphereGeometry args={[SPHERE_RADIUS + 0.004, 128, 96]} />
              <meshStandardMaterial
                ref={landMat}
                map={landTexture}
                color={palette.land}
                transparent
                depthWrite={false}
                roughness={0.62}
                metalness={0}
              />
            </mesh>
          )}
        </group>
      </group>

      {textTexture && (
        <group ref={textGroup}>
          <mesh>
            {/* A full shell, not a slice: the band's extent is a texture
                window, which is what lets it slide pole to pole for free. */}
            <sphereGeometry args={[SHELL_RADIUS, 160, 96]} />
            {/* Standard, not basic: the type shares the sphere's normals, so it
                catches the same light and reads as printed into the surface.
                The emissive pass keeps letters legible past the terminator. */}
            <meshStandardMaterial
              map={textTexture}
              emissive={palette.text}
              emissiveMap={textTexture}
              emissiveIntensity={0.4}
              transparent
              // FrontSide, not DoubleSide: now that the shell stands off the
              // sphere, rays through the gap would hit it twice and draw the
              // far side's mirrored text back over the near side.
              side={THREE.FrontSide}
              depthWrite={false}
              roughness={0.55}
              metalness={0}
            />
          </mesh>
        </group>
      )}
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                  */
/* -------------------------------------------------------------------------- */

export default function TextSphere() {
  const [isDark, setIsDark] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const shellRef = useRef(null);
  const lightRef = useRef(null);
  const darkRef = useRef(null);

  // Drag targets live in a ref: they are written at pointer rate and read at
  // frame rate, so they must never trigger a React re-render. `spin` is the
  // band's rotation around the globe, `lat` its climb from pole to pole.
  const drag = useRef({ spin: 0, lat: 0, active: false, px: 0, py: 0 });

  const palette = isDark ? THEME.dark : THEME.light;
  const ink = isDark ? "text-white" : "text-black";
  const rule = isDark ? "border-white/12" : "border-black/12";
  const muted = isDark ? "text-white/45" : "text-black/45";

  /* Two stacked backdrops cross-faded rather than one colour tweened: a
     gradient has no single value to interpolate, and opacity is GPU-cheap. */
  useEffect(() => {
    if (!lightRef.current || !darkRef.current) return;
    gsap.to(lightRef.current, {
      opacity: isDark ? 0 : 1,
      duration: 0.9,
      ease: "power2.inOut",
    });
    gsap.to(darkRef.current, {
      opacity: isDark ? 1 : 0,
      duration: 0.9,
      ease: "power2.inOut",
    });
  }, [isDark]);

  /* Entrance. Scoped to the section so the selector can never escape it, and
     reverted on unmount so Fast Refresh cannot stack duplicate timelines. */
  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap
        .timeline({ defaults: { ease: "power3.out" } })
        .from("[data-stage]", { opacity: 0, scale: 1.08, duration: 1.6 }, 0)
        .from(
          "[data-reveal]",
          { y: 22, opacity: 0, duration: 1.1, stagger: 0.07 },
          0.15,
        );
    }, shellRef);
    return () => ctx.revert();
  }, []);

  const onPointerDown = useCallback((e) => {
    drag.current.active = true;
    drag.current.px = e.clientX;
    drag.current.py = e.clientY;
    setIsDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e) => {
    if (!drag.current.active) return;
    const dx = e.clientX - drag.current.px;
    const dy = e.clientY - drag.current.py;
    drag.current.px = e.clientX;
    drag.current.py = e.clientY;

    // Sideways carries the band around the globe. Vertical walks it up toward
    // the north pole and down toward the south, clamped at the point where the
    // band's edge meets a pole so the type never collapses through it.
    drag.current.spin += dx * 0.006;
    drag.current.lat = THREE.MathUtils.clamp(
      drag.current.lat - dy * 0.004,
      -MAX_LAT,
      MAX_LAT,
    );
  }, []);

  const endDrag = useCallback((e) => {
    if (!drag.current.active) return;
    drag.current.active = false;
    setIsDragging(false);
    e?.currentTarget?.releasePointerCapture?.(e.pointerId);
  }, []);

  return (
    <section
      ref={shellRef}
      className="relative h-screen w-full overflow-hidden select-none"
      style={{ backgroundColor: palette.base }}
    >
      {/* ---------------------------------------------------------------- */}
      {/*  Backdrop stack                                                   */}
      {/* ---------------------------------------------------------------- */}
      <div
        ref={lightRef}
        className="absolute inset-0"
        style={{ background: THEME.light.backdrop, opacity: isDark ? 0 : 1 }}
      />
      <div
        ref={darkRef}
        className="absolute inset-0"
        style={{ background: THEME.dark.backdrop, opacity: isDark ? 1 : 0 }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.15] mix-blend-overlay"
        style={{ backgroundImage: `url("${GRAIN}")` }}
      />

      {/* Oversized wordmark sitting behind the globe — the sphere eclipses it,
          which is what gives the composition depth instead of a floating ball. */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span
          data-reveal
          className={`-translate-y-[7vh] whitespace-nowrap text-[26vw] leading-none font-semibold tracking-[-0.05em] ${
            isDark ? "text-white/[0.07]" : "text-black/[0.06]"
          }`}
        >
          EARTH
        </span>
      </div>

      {/* Contact shadow: grounds the sphere so it reads as lit, not pasted. */}
      <div
        className="pointer-events-none absolute left-1/2 top-[54%] h-[26vmin] w-[50vmin] -translate-x-1/2 blur-3xl"
        style={{
          background: isDark
            ? "radial-gradient(50% 50% at 50% 50%, rgba(0,0,0,0.55), transparent 70%)"
            : "radial-gradient(50% 50% at 50% 50%, rgba(90,84,74,0.22), transparent 70%)",
        }}
      />

      {/* ---------------------------------------------------------------- */}
      {/*  Stage — the only layer that takes pointer input                  */}
      {/* ---------------------------------------------------------------- */}
      <div
        data-stage
        className={`absolute inset-0 touch-none ${
          isDragging ? "cursor-grabbing" : "cursor-grab"
        }`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onPointerCancel={endDrag}
      >
        <Canvas
          dpr={[1, 2]}
          camera={{ position: [0, 0, 8.6], fov: 42 }}
          gl={{ antialias: true, alpha: true }}
        >
          <ambientLight intensity={isDark ? 0.6 : 1.2} />
          <directionalLight
            position={[3, 5, 6]}
            intensity={isDark ? 1.1 : 1.8}
          />
          <directionalLight
            position={[-6, -2, 2]}
            intensity={isDark ? 0.7 : 0.5}
          />
          <TypographyGlobe drag={drag} isDark={isDark} />
        </Canvas>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/*  Chrome — inert by default so it never steals the drag            */}
      {/* ---------------------------------------------------------------- */}
      <div
        className={`pointer-events-none absolute inset-0 flex flex-col justify-between p-6 transition-colors duration-700 sm:p-10 ${ink}`}
      >
        <header className="flex items-start justify-between gap-6">
          <div data-reveal className="flex items-center gap-3">
            <span
              className={`inline-block h-[7px] w-[7px] rounded-full ${
                isDark ? "bg-white" : "bg-black"
              }`}
            />
            <span className="text-[11px] font-medium uppercase tracking-[0.32em]">
              Terra Atlas
            </span>
          </div>

          <div data-reveal className="flex items-center gap-5">
            <span
              className={`hidden text-[11px] uppercase tracking-[0.32em] sm:inline ${muted}`}
            >
              01 / Inner system
            </span>
            <button
              type="button"
              onClick={() => setIsDark((v) => !v)}
              onPointerDown={(e) => e.stopPropagation()}
              aria-label={
                isDark ? "Switch to light mode" : "Switch to dark mode"
              }
              className={`pointer-events-auto cursor-pointer rounded-full border px-4 py-1.5 text-[11px] font-medium uppercase tracking-[0.24em] backdrop-blur-sm transition-colors duration-300 ${
                isDark
                  ? "border-white/20 text-white hover:bg-white/10"
                  : "border-black/15 text-black hover:bg-black/[0.06]"
              }`}
            >
              {isDark ? "Light" : "Dark"}
            </button>
          </div>
        </header>

        <footer className="flex flex-col gap-7">
          <div
            data-reveal
            className={`flex items-center justify-center gap-2 text-[11px] uppercase tracking-[0.28em] ${muted}`}
          >
            <span aria-hidden>↕</span>
            Drag to move the text
          </div>

          <dl
            className={`grid grid-cols-2 gap-y-6 border-t pt-6 sm:grid-cols-4 ${rule}`}
          >
            {STATS.map((s) => (
              <div data-reveal key={s.label} className="flex flex-col gap-1.5">
                <dt
                  className={`text-[10px] uppercase tracking-[0.28em] ${muted}`}
                >
                  {s.label}
                </dt>
                <dd className="flex items-baseline gap-1.5">
                  <span className="text-2xl font-medium tracking-tight tabular-nums sm:text-[28px]">
                    {s.value}
                  </span>
                  <span className={`text-[11px] tracking-wide ${muted}`}>
                    {s.unit}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </footer>
      </div>

      {/* Hairline frame — the detail that makes it read as a composed section. */}
      <div
        className={`pointer-events-none absolute inset-3 rounded-[3px] border sm:inset-5 ${
          isDark ? "border-white/[0.07]" : "border-black/[0.07]"
        }`}
      />
    </section>
  );
}
