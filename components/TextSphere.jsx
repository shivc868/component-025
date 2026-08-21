"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { FontLoader } from "three/examples/jsm/loaders/FontLoader.js";
import { TextGeometry } from "three/examples/jsm/geometries/TextGeometry.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import gsap from "gsap";
import tubeFont from "./fonts/helvetiker_bold.typeface.json";

/* ---- content + theme ---- */

const PARAGRAPH = `Earth is the third planet from the Sun and the only world we know of where liquid water covers the surface. It races around the Sun at thirty kilometres a second, spinning once on its tilted axis each day. Beneath our feet a molten iron core generates the magnetic field that shields the atmosphere. A thin veil of gases, barely a hundred kilometres of breathable sky, is all that separates every living thing from the vacuum of space. Oceans hold ninety seven percent of its water and drive the weather that carves its restless surface.`;

// The band always shows exactly this many packed lines; leftover copy is dropped.
const MAX_LINES = 4;

const THEME = {
  base: "#0d0d0f",
  // slightly blue so the globe matches the glass wordmark
  sphere: "#c9d8ee",
  land: "#a7b4c8",
  text: "#0b0b0b",
  backdrop:
    "radial-gradient(120% 90% at 50% 8%, #232327 0%, #131315 46%, #0a0a0b 100%)",
};

const MENU_ITEMS = [
  { label: "Atlas", desc: "Surface maps, coastlines & terrain" },
  { label: "Orbit", desc: "Trajectory, axial tilt & seasons" },
  { label: "Data", desc: "Physical & orbital statistics" },
  { label: "Oceans", desc: "Currents, tides & sea temperature" },
  { label: "Atmosphere", desc: "Weather systems & the thin blue veil" },
  { label: "Missions", desc: "Satellites & observation programmes" },
];

const STATS = [
  { label: "Diameter", value: "12,742", unit: "km" },
  { label: "Orbital period", value: "365.25", unit: "days" },
  { label: "Axial tilt", value: "23.44", unit: "deg" },
  { label: "Age", value: "4.54", unit: "Gyr" },
];

// Inline film grain — kills gradient banding.
const GRAIN =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E";

// The text lives on a shell slightly larger than the globe; dragging only
// slides the texture's V offset, so the band curves as it nears a pole.
// Keep both dimensions powers of two — NPOT + wrapping samples as transparent
// on strict drivers.
const CANVAS_W = 4096;
const CANVAS_H = 512;
const SPHERE_RADIUS = 1.62;
const SHELL_GAP = 0.04; // lifts the type clear of the surface so it hovers
const SHELL_RADIUS = SPHERE_RADIUS + SHELL_GAP;
const BAND_V_SPAN = (2 * CANVAS_H) / CANVAS_W;

// How far the band may climb — 1.0 would push it over the visible horizon.
const MAX_LAT = 0.7;

// Real axial tilt; spin kept slower than the text drift on purpose.
const AXIAL_TILT = (23.44 * Math.PI) / 180;
const GLOBE_SPIN = 0.33;

// Maps latitude (-1..1) to the texture V offset that puts the band there.
function bandOffset(lat) {
  // a NaN reaching texture.offset silently kills the whole band
  const safe = Number.isFinite(lat) ? Math.max(-1, Math.min(1, lat)) : 0;
  const centre = 0.5 + safe * (0.5 - BAND_V_SPAN / 2);
  return 1 - (centre + BAND_V_SPAN / 2) / BAND_V_SPAN;
}

/* ---- band texture (Canvas 2D -> CanvasTexture) ---- */

function createTextTexture(text, color, scale = 1) {
  // guard against the server render pass
  if (typeof document === "undefined") return null;

  // scale < 1 halves the texture on low-power devices; aspect stays the same
  const W = CANVAS_W * scale;
  const H = CANVAS_H * scale;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, W, H);

  const maxHeight = H * 0.88;
  const font = (size) =>
    `500 ${size}px "Space Grotesk", "Helvetica Neue", Helvetica, Arial, sans-serif`;

  const fontSize = Math.floor(maxHeight / (MAX_LINES * 1.12));
  const lineHeight = fontSize * 1.12;

  // letterSpacing changes what measureText reports — set it before measuring
  ctx.font = font(fontSize);
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  if ("letterSpacing" in ctx) ctx.letterSpacing = "-0.08em";

  // Pack each line edge to edge, cycling the copy, so the wrap seam ends up
  // smaller than a word and reads as an ordinary gap.
  const sourceWords = text.split(/\s+/);
  const spaceW = ctx.measureText(" ").width;
  const lines = [];
  let w = 0;

  // reserve one word-space at the seam so two words never fuse
  const lineBudget = W - spaceW;

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
  const blockTop = H / 2 - (lines.length * lineHeight) / 2 + lineHeight / 2;
  lines.forEach((l, i) => ctx.fillText(l, W / 2, blockTop + i * lineHeight));

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = scale < 1 ? 8 : 16;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;

  // Clamp both axes — keeps us off the repeat path some drivers resolve to
  // a fully transparent sample.
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.repeat.set(1, 1 / BAND_V_SPAN);
  texture.offset.y = bandOffset(0);

  texture.needsUpdate = true;
  return texture;
}

/* ---- continents: simplified coastlines as [lon, lat] rings ---- */

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

function createLandTexture(scale = 1) {
  if (typeof document === "undefined") return null;

  const W = LAND_W * scale;
  const H = LAND_H * scale;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff";

  // equirectangular: longitude across, latitude down
  const px = (lon) => ((lon + 180) / 360) * W;
  const py = (lat) => ((90 - lat) / 180) * H;

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

  // Antarctica is a cap, not a ring — fill the bottom band outright
  ctx.fillRect(0, py(-68), W, H - py(-68));

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = scale < 1 ? 8 : 16;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/* ---- "earth" wordmark: bevelled 3D type with a liquid-fill shader ---- */

// Shared GLSL: the liquid surface is two travelling sines around a CPU-fed
// level, in object space so parallax never sloshes it.
const LIQUID_SURFACE = `
  float lvl = uLevel
    + sin(vTubePos.x * 1.6 + uTime * uWaveSpeed) * uWaveAmp
    + sin(vTubePos.x * 3.7 - uTime * uWaveSpeed * 1.6) * uRippleAmp;
  float inLiquid = smoothstep(lvl + 0.04, lvl - 0.04, vTubePos.y);
`;

// Final wordmark look. Liquid fields are 0..1 relative to glyph height.
const WORDMARK_CONFIG = {
  size: 6,
  depth: 0.3,
  roundness: 0.1,
  puff: 0.13,
  smoothness: 16,
  widthFit: 0.47,
  posY: 3.8,
  posZ: -7.5,
  parallaxAmt: 0.45,
  glassColor: "#89b4f2",
  glassOpacity: 0.8,
  glassRoughness: 1,
  clearcoat: 0.81,
  clearcoatRough: 0,
  transmission: 0.89,
  ior: 1.7,
  thickness: 5,
  envIntensity: 2.5,
  fill: 0.69,
  liquidColor: "#227bff",
  liquidOpacity: 0.86,
  waveHeight: 0.114,
  rippleHeight: 0.02,
  waveSpeed: 0.5,
  bobHeight: 0.02,
  bobSpeed: 0.4,
  rimStrength: 1.5,
  glowColor: "#0058ef",
  glowStrength: 2,
};

function LiquidWordmark({ parallax, lowPower = false }) {
  const group = useRef(null);
  const shaderRef = useRef(null);
  const viewportProbe = useRef(new THREE.Vector3());

  // Mobile drops the transmission pass and halves the bevel segments for a
  // steady frame rate; the word also spans more of the narrow viewport.
  const c = useMemo(
    () =>
      lowPower
        ? {
            ...WORDMARK_CONFIG,
            transmission: 0,
            glassOpacity: 0.9,
            smoothness: 8,
            widthFit: 0.78,
          }
        : WORDMARK_CONFIG,
    [lowPower],
  );

  const geometry = useMemo(() => {
    const font = new FontLoader().parse(tubeFont);
    const g = new TextGeometry("earth", {
      font,
      size: c.size,
      depth: c.depth,
      curveSegments: lowPower ? 6 : 10,
      // the deep bevel is what puffs the strokes into rounded tubing
      bevelEnabled: true,
      bevelThickness: c.puff * c.size * 0.31,
      bevelSize: c.roundness * c.size * 0.31,
      bevelSegments: c.smoothness,
    });
    g.center();
    g.computeBoundingBox();
    return g;
  }, [c, lowPower]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Reflections for the wordmark only — scene.environment would light the
  // matte globe too.
  const gl = useThree((s) => s.gl);
  const envMap = useMemo(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const tex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    return tex;
  }, [gl]);
  useEffect(() => () => envMap.dispose(), [envMap]);

  const material = useMemo(() => {
    const m = new THREE.MeshPhysicalMaterial({
      color: c.glassColor,
      roughness: c.glassRoughness,
      metalness: 0,
      clearcoat: c.clearcoat,
      clearcoatRoughness: c.clearcoatRough,
      transmission: c.transmission,
      ior: c.ior,
      thickness: c.thickness,
      envMap,
      envMapIntensity: c.envIntensity,
      transparent: true,
      // no depth write: the inner bevels show through the near wall
      side: THREE.FrontSide,
      depthWrite: false,
    });
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        uTime: { value: 0 },
        uLevel: { value: (c.fill - 0.5) * c.size * 0.96 },
        uWaveAmp: { value: c.waveHeight * c.size },
        uRippleAmp: { value: c.rippleHeight * c.size },
        uWaveSpeed: { value: c.waveSpeed },
        uGlassAlpha: { value: c.glassOpacity },
        uLiquidAlpha: { value: c.liquidOpacity },
        uRim: { value: c.rimStrength },
        uGlowStrength: { value: c.glowStrength },
        uLiquidColor: { value: new THREE.Color(c.liquidColor) },
        uGlowColor: { value: new THREE.Color(c.glowColor) },
      });
      shaderRef.current = shader;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vTubePos;",
        )
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvTubePos = position;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
uniform float uTime, uLevel, uWaveAmp, uRippleAmp, uWaveSpeed;
uniform float uGlassAlpha, uLiquidAlpha, uRim, uGlowStrength;
uniform vec3 uLiquidColor, uGlowColor;
varying vec3 vTubePos;`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
{
  ${LIQUID_SURFACE}
  diffuseColor.rgb = mix(diffuseColor.rgb, uLiquidColor, inLiquid);
  // Glass above the surface is nearly clear; liquid below is dense.
  diffuseColor.a = mix(uGlassAlpha, uLiquidAlpha, inLiquid);
  // Bright meniscus where the surface meets the tube wall.
  float rim = smoothstep(0.07, 0.0, abs(vTubePos.y - lvl));
  diffuseColor.rgb += vec3(0.45, 0.7, 1.0) * rim * uRim;
}`,
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>
{
  ${LIQUID_SURFACE}
  // The liquid glows so it stays saturated past the terminator.
  totalEmissiveRadiance += uGlowColor * uGlowStrength * inLiquid;
}`,
        );
    };
    return m;
  }, [envMap, c]);
  useEffect(() => () => material.dispose(), [material]);

  useFrame(({ clock, camera, viewport }) => {
    const t = clock.elapsedTime;

    // only the clock and the bobbing liquid level move per frame
    const shader = shaderRef.current;
    if (shader) {
      shader.uniforms.uTime.value = t;
      shader.uniforms.uLevel.value =
        (c.fill - 0.5) * c.size * 0.96 +
        Math.sin(t * c.bobSpeed) * c.bobHeight * c.size;
    }

    if (!group.current) return;

    // scale the word to span widthFit of the visible width at its depth
    const v = viewport.getCurrentViewport(
      camera,
      viewportProbe.current.set(0, c.posY, c.posZ),
    );
    const bbox = geometry.boundingBox;
    const nativeW = bbox ? bbox.max.x - bbox.min.x : 1;
    group.current.scale.setScalar((v.width * c.widthFit) / nativeW);
    group.current.position.z = c.posZ;

    // far-plane parallax: drift against the cursor
    const p = parallax.current;
    group.current.position.x = THREE.MathUtils.lerp(
      group.current.position.x,
      p.x * -c.parallaxAmt,
      0.05,
    );
    group.current.position.y = THREE.MathUtils.lerp(
      group.current.position.y,
      c.posY + p.y * c.parallaxAmt * 0.6,
      0.05,
    );
  });

  return (
    <group ref={group} position={[0, c.posY, c.posZ]}>
      <mesh geometry={geometry} material={material} />
    </group>
  );
}

/* ---- the globe + orbiting text band ---- */

function TypographyGlobe({ drag, lowPower = false }) {
  const textGroup = useRef(null);
  const globeGroup = useRef(null);
  const texScale = lowPower ? 0.5 : 1;

  // Canvas 2D silently falls back to Helvetica if the webfont isn't loaded
  // yet, so track readiness and rebuild the texture when it arrives.
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

  const landTexture = useMemo(() => createLandTexture(texScale), [texScale]);
  useEffect(() => () => landTexture?.dispose(), [landTexture]);

  const textTexture = useMemo(
    () => createTextTexture(PARAGRAPH, THEME.text, texScale),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fontReady, texScale],
  );

  useEffect(() => {
    if (!textTexture) return;
    // a fresh texture starts at the equator — snap it to the current latitude
    textTexture.offset.y = bandOffset(drag.current.lat);
    return () => textTexture.dispose();
  }, [textTexture, drag]);

  useFrame((_, delta) => {
    // clamp delta — refocusing a backgrounded tab would snap a full revolution
    if (globeGroup.current) {
      globeGroup.current.rotation.y += Math.min(delta, 0.1) * GLOBE_SPIN;
    }

    if (!textGroup.current) return;

    // idle drift nudges the target, never the mesh — same easing as drag
    if (!drag.current.active) drag.current.spin += 0.0022;

    if (!Number.isFinite(drag.current.spin)) drag.current.spin = 0;
    if (!Number.isFinite(drag.current.lat)) drag.current.lat = 0;

    gsap.to(textGroup.current.rotation, {
      y: drag.current.spin,
      duration: 1.8,
      ease: "power3.out",
      overwrite: true,
    });

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
    <group rotation={[0, 0, -0.1]} position={[0, -0.3, 0]}>
      {/* the globe spins on its own tilted axis; drag only moves the band */}
      <group rotation={[0, 0, -AXIAL_TILT]}>
        <group ref={globeGroup}>
          <mesh>
            <sphereGeometry
              args={lowPower ? [SPHERE_RADIUS, 48, 48] : [SPHERE_RADIUS, 96, 96]}
            />
            <meshStandardMaterial
              color={THEME.sphere}
              roughness={0.55}
              metalness={0}
            />
          </mesh>

          {/* landmasses ride just above the ocean sphere */}
          {landTexture && (
            <mesh>
              <sphereGeometry
                args={
                  lowPower
                    ? [SPHERE_RADIUS + 0.004, 64, 48]
                    : [SPHERE_RADIUS + 0.004, 128, 96]
                }
              />
              <meshStandardMaterial
                map={landTexture}
                color={THEME.land}
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
            {/* a full shell — the band is just a texture window that can
                slide pole to pole */}
            <sphereGeometry
              args={lowPower ? [SHELL_RADIUS, 96, 64] : [SHELL_RADIUS, 160, 96]}
            />
            {/* emissive keeps the letters legible past the terminator */}
            <meshStandardMaterial
              map={textTexture}
              emissive={THEME.text}
              emissiveMap={textTexture}
              emissiveIntensity={0.4}
              transparent
              // FrontSide, or the far side's mirrored text bleeds through
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

/* ---- background star dust ---- */

function Stars({ count = 380 }) {
  const cloud = useRef(null);

  const geometry = useMemo(() => {
    const COUNT = count;
    const positions = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      // kept strictly behind the globe — dust near the camera blows up into blobs
      const radius = 6 + Math.random() * 20;
      const theta = Math.random() * Math.PI * 2;
      positions[i * 3] = Math.cos(theta) * radius;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 20;
      positions[i * 3 + 2] = -6 - Math.abs(Math.sin(theta)) * radius;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return g;
  }, [count]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame(({ clock }) => {
    // slow sway, not a spin — nothing can swing around into the camera
    if (cloud.current) {
      cloud.current.rotation.y = Math.sin(clock.elapsedTime * 0.05) * 0.06;
    }
  });

  return (
    <group ref={cloud}>
      <points geometry={geometry}>
        <pointsMaterial
          size={0.06}
          sizeAttenuation
          color="#ffffff"
          transparent
          opacity={0.75}
          depthWrite={false}
        />
      </points>
    </group>
  );
}

/* ---- cursor trail: a comet of pixel dots chasing the pointer ---- */

function CursorTrail() {
  const canvasRef = useRef(null);

  useEffect(() => {
    // touch devices have no hovering cursor — skip the whole loop
    if (window.matchMedia?.("(pointer: coarse)").matches) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf;
    let w = 0;
    let h = 0;

    const resize = () => {
      w = canvas.width = canvas.offsetWidth;
      h = canvas.height = canvas.offsetHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    // start far off-canvas so nothing renders until the pointer moves
    const mouse = { x: -200, y: -200 };
    const head = { x: -200, y: -200 };
    const points = [];
    const MAX_POINTS = 144;
    const GAP = 4; // px travelled between samples
    const DECAY = 0.024; // ~0.7s until a sample ages out
    const onMove = (e) => {
      const r = canvas.getBoundingClientRect();
      mouse.x = e.clientX - r.left;
      mouse.y = e.clientY - r.top;
    };
    window.addEventListener("pointermove", onMove);

    const rgb = "200,200,204";

    const draw = () => {
      raf = requestAnimationFrame(draw);
      ctx.clearRect(0, 0, w, h);

      // eased follow — the head glides after the pointer with momentum
      head.x += (mouse.x - head.x) * 0.11;
      head.y += (mouse.y - head.y) * 0.11;

      // lay samples every GAP px along the path so fast flicks stay a
      // continuous trail instead of scattered clumps
      const makeSample = (x, y) => ({ x, y, life: 1 });

      const prev = points[0];
      if (!prev) {
        points.unshift(makeSample(head.x, head.y));
      } else {
        let dist = Math.hypot(head.x - prev.x, head.y - prev.y);
        if (dist >= GAP) {
          const dx = (head.x - prev.x) / dist;
          const dy = (head.y - prev.y) / dist;
          let px = prev.x;
          let py = prev.y;
          let steps = 0;
          while (dist >= GAP && steps < MAX_POINTS) {
            px += dx * GAP;
            py += dy * GAP;
            points.unshift(makeSample(px, py));
            dist -= GAP;
            steps++;
          }
        }
      }
      while (points.length > MAX_POINTS) points.pop();

      for (const p of points) p.life -= DECAY;
      while (points.length && points[points.length - 1].life <= 0) points.pop();

      // Dots live on a fixed checkerboard grid; each sample lights the cells
      // in its radius and a stable per-cell hash crumbles the rim, so dots
      // only appear and fade in place — they never shift.
      const CELL = 3;
      const DOT = 2.4;
      const lit = new Map();
      for (let i = points.length - 1; i >= 0; i--) {
        const p = points[i];
        if (p.life <= 0) continue;
        const shape = 1 - i / MAX_POINTS; // 1 = head, 0 = tail end
        const radius = 5 + 16 * shape;
        const alpha = (0.3 + 0.45 * shape) * p.life;
        const x0 = Math.round((p.x - radius) / CELL);
        const x1 = Math.round((p.x + radius) / CELL);
        const y0 = Math.round((p.y - radius) / CELL);
        const y1 = Math.round((p.y + radius) / CELL);
        for (let iy = y0; iy <= y1; iy++) {
          for (let ix = x0; ix <= x1; ix++) {
            if ((ix + iy) & 1) continue; // checkerboard
            const cx = ix * CELL;
            const cy = iy * CELL;
            const dist = Math.hypot(cx - p.x, cy - p.y);
            if (dist > radius) continue;
            // stable hash — the same cell always makes the same keep/skip call
            const s = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453;
            const hsh = s - Math.floor(s);
            if (hsh > 0.25 + 0.9 * (1 - dist / radius)) continue;
            const key = `${ix},${iy}`;
            const prevCell = lit.get(key);
            if (!prevCell || alpha > prevCell.a)
              lit.set(key, { cx, cy, a: alpha });
          }
        }
      }
      for (const { cx, cy, a } of lit.values()) {
        ctx.fillStyle = `rgba(${rgb},${a})`;
        ctx.fillRect(cx - DOT / 2, cy - DOT / 2, DOT, DOT);
      }

      // head core snaps to the same grid and fades with the freshest sample
      if (points.length) {
        const hx = Math.round(head.x / CELL) * CELL;
        const hy = Math.round(head.y / CELL) * CELL;
        ctx.fillStyle = `rgba(${rgb},${Math.max(points[0].life, 0) * 0.9})`;
        ctx.fillRect(hx - DOT, hy - DOT, DOT * 2, DOT * 2);
      }
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-50 h-full w-full"
    />
  );
}

/* ---- chrome ---- */

// "+" registration mark used on the hero frame corners.
function Cross({ className }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute block h-[9px] w-[9px] ${className}`}
    >
      <span className="absolute top-1/2 left-0 h-px w-full bg-white" />
      <span className="absolute left-1/2 top-0 h-full w-px bg-white" />
    </span>
  );
}

/* Scramble hover: on pointer enter the label churns through random glyphs
   and resolves left-to-right back into the real text. The scramble pool is
   the same uppercase set the chrome uses, so mid-animation frames still look
   like instrument readouts rather than noise. */
const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#/\\<>";

function useScramble(text) {
  const [display, setDisplay] = useState(text);
  const timer = useRef(null);
  useEffect(() => setDisplay(text), [text]);
  useEffect(() => () => clearInterval(timer.current), []);

  const scramble = useCallback(() => {
    const frames = Math.max(text.length * 2, 10);
    let frame = 0;
    clearInterval(timer.current);
    timer.current = setInterval(() => {
      frame++;
      const reveal = Math.floor((frame / frames) * text.length);
      let out = "";
      for (let i = 0; i < text.length; i++) {
        out +=
          i < reveal || text[i] === " "
            ? text[i]
            : SCRAMBLE_CHARS[(Math.random() * SCRAMBLE_CHARS.length) | 0];
      }
      if (frame >= frames) {
        clearInterval(timer.current);
        out = text;
      }
      setDisplay(out);
    }, 28);
  }, [text]);

  return [display, scramble];
}

/* Panel button in the instrument-panel frame. Hover is the scramble alone —
   no fill wipe, no rolling label. */
function PanelButton({
  active = false,
  onClick,
  ariaLabel,
  className = "",
  padClass = "px-5 py-2",
  endSlot = null,
  children,
}) {
  const [display, scramble] = useScramble(String(children));

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerEnter={scramble}
      className={`relative flex cursor-pointer items-stretch overflow-hidden border border-[#9fc0f0]/40 text-[11px] font-medium uppercase tracking-[0.24em] backdrop-blur-sm transition-colors duration-300 ${
        active ? "bg-[#cfe0fa] text-black" : "text-[#dce8fb]"
      } ${className}`}
    >
      {/* whitespace-pre keeps the width steady while glyphs churn */}
      <span className={`relative block whitespace-pre ${padClass}`}>
        {display}
      </span>
      {endSlot && (
        <span className="relative flex items-stretch">{endSlot}</span>
      )}
    </button>
  );
}

/* One entry of the dropdown: index, scrambling label, brief, and an arrow.
   Hover is the label scramble only — the row itself stays still. */
function MenuRow({ index, label, desc, active = false, onClick }) {
  const [display, scramble] = useScramble(label);

  return (
    <button
      type="button"
      data-menu-row
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerEnter={scramble}
      className={`flex w-full cursor-pointer items-baseline gap-4 px-5 py-4 text-left ${
        active ? "bg-[#cfe0fa] text-black" : "text-[#dce8fb]"
      }`}
    >
      <span
        className={`text-[10px] tracking-[0.28em] tabular-nums ${
          active ? "text-black/45" : "text-[#9fc0f0]/60"
        }`}
      >
        {String(index + 1).padStart(2, "0")}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="whitespace-pre text-[13px] font-medium uppercase tracking-[0.24em]">
          {display}
        </span>
        <span
          className={`text-[10px] uppercase tracking-[0.18em] ${
            active ? "text-black/50" : "text-[#9fc0f0]/55"
          }`}
        >
          {desc}
        </span>
      </span>
      <span aria-hidden className="text-[11px]">
        →
      </span>
    </button>
  );
}

export default function TextSphere() {
  const [isDragging, setIsDragging] = useState(false);
  const [isOverGlobe, setIsOverGlobe] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  // One-shot capability probe: phones and tablets get the same scene at a
  // lower simulation cost — fewer segments, smaller textures, capped DPR and
  // no transmission pass — so the animation stays fluid on mobile GPUs.
  const [lowPower] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 820px), (pointer: coarse)").matches,
  );
  const shellRef = useRef(null);

  // Drag targets live in a ref: they are written at pointer rate and read at
  // frame rate, so they must never trigger a React re-render. `spin` is the
  // band's rotation around the globe, `lat` its climb from pole to pole.
  const drag = useRef({ spin: 0, lat: 0, active: false, px: 0, py: 0 });

  // Normalised cursor offset (-0.5..0.5) for the wordmark's far-plane drift;
  // read per-frame inside the Canvas, so it must never re-render React.
  const parallax = useRef({ x: 0, y: 0 });

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

  /* Menu open/close: the panel drops in and its rows cascade; closing lifts
     it away quickly. The nav stays mounted so the tween can run both ways —
     autoAlpha handles visibility, pointer events follow the state. */
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rows = el.querySelectorAll("[data-menu-row]");
    if (menuOpen) {
      el.style.pointerEvents = "auto";
      gsap
        .timeline()
        .to(
          el,
          {
            autoAlpha: 1,
            y: 0,
            duration: 0.45,
            ease: "power3.out",
            overwrite: "auto",
          },
          0,
        )
        .fromTo(
          rows,
          { y: 16, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 0.4,
            ease: "power3.out",
            stagger: 0.05,
            overwrite: "auto",
          },
          0.05,
        );
    } else {
      el.style.pointerEvents = "none";
      gsap.to(el, {
        autoAlpha: 0,
        y: -12,
        duration: 0.28,
        ease: "power2.in",
        overwrite: "auto",
      });
    }
  }, [menuOpen]);

  /* Cursor parallax: the 3D wordmark drifts against the cursor, separating
     the far plane from the globe the moment the pointer moves. Only the
     target is written here — LiquidWordmark eases toward it per frame. */
  const onParallax = useCallback((e) => {
    parallax.current.x = e.clientX / window.innerWidth - 0.5;
    parallax.current.y = e.clientY / window.innerHeight - 0.5;
  }, []);

  /* Screen-space hit test for the globe, derived from the camera setup
     (z=8.6, fov 42): the visible half-height is 8.6*tan(21°) ≈ 3.30 world
     units, the globe centre sits 0.3 down, and the shell radius is ~1.7 — so
     the globe occupies a circle of ~26% of the viewport height, ~4.5% below
     centre. Dragging the band only works inside it. */
  const overGlobe = useCallback((e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2 + 0.045 * r.height;
    const radius = 0.27 * r.height;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    return dx * dx + dy * dy <= radius * radius;
  }, []);

  const onPointerDown = useCallback(
    (e) => {
      if (!overGlobe(e)) return;
      drag.current.active = true;
      drag.current.px = e.clientX;
      drag.current.py = e.clientY;
      setIsDragging(true);
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    [overGlobe],
  );

  const onPointerMove = useCallback(
    (e) => {
      // The grab cursor only appears over the globe itself.
      setIsOverGlobe(overGlobe(e));
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
    },
    [overGlobe],
  );

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
      style={{ backgroundColor: THEME.base }}
      onPointerMove={onParallax}
    >
      {/* ---------------------------------------------------------------- */}
      {/*  Backdrop                                                         */}
      {/* ---------------------------------------------------------------- */}
      <div className="absolute inset-0" style={{ background: THEME.backdrop }} />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.15] mix-blend-overlay"
        style={{ backgroundImage: `url("${GRAIN}")` }}
      />

      {/* Oversized wordmark sitting behind the globe — the sphere eclipses it,
          which is what gives the composition depth instead of a floating ball.
          The ref is the parallax handle: GSAP translates this wrapper, so the
          span inside stays free for the entrance reveal. */}
      {/* The EARTH wordmark now lives inside the Canvas as real extruded
          geometry (LiquidWordmark) so the sphere eclipses it in true depth. */}

      {/* Depth vignette: gently darkened corners curve the backdrop away from
          the viewer, so the flat washes read as a space instead of a wall. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(125% 105% at 50% 42%, transparent 55%, rgba(8,8,10,0.38) 100%)",
          opacity: 0.9,
        }}
      />

      {/* Contact shadow: grounds the sphere so it reads as lit, not pasted. */}
      <div
        className="pointer-events-none absolute left-1/2 top-[65%] h-[26vmin] w-[50vmin] -translate-x-1/2 blur-3xl"
        style={{
          background:
            "radial-gradient(50% 50% at 50% 50%, rgba(0,0,0,0.55), transparent 70%)",
        }}
      />

      {/* ---------------------------------------------------------------- */}
      {/*  Stage — the only layer that takes pointer input                  */}
      {/* ---------------------------------------------------------------- */}
      <div
        data-stage
        className={`absolute inset-0 touch-none ${
          isDragging ? "cursor-grabbing" : isOverGlobe ? "cursor-grab" : ""
        }`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={(e) => {
          endDrag(e);
          setIsOverGlobe(false);
        }}
        onPointerCancel={endDrag}
      >
        <Canvas
          dpr={lowPower ? [1, 1.5] : [1, 2]}
          camera={{ position: [0, 0, 8.6], fov: 42 }}
          gl={{ antialias: true, alpha: true }}
        >
          <ambientLight intensity={0.6} />
          <directionalLight position={[3, 5, 6]} intensity={1.1} />
          <directionalLight position={[-6, -2, 2]} intensity={0.7} />
          <Stars count={lowPower ? 200 : 380} />
          <LiquidWordmark parallax={parallax} lowPower={lowPower} />
          <TypographyGlobe drag={drag} lowPower={lowPower} />
        </Canvas>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/*  Chrome — inert by default so it never steals the drag            */}
      {/* ---------------------------------------------------------------- */}
      <div
        className="pointer-events-none absolute inset-0 flex flex-col justify-between p-6 text-white sm:p-8"
      >
        <header className="relative flex items-start justify-between gap-6">
          {/* Logo in the same instrument-panel frame as the toggle: solid
              glyph block, label, and the corner registration mark. */}
          <div
            data-reveal
            className="relative flex items-stretch border border-[#9fc0f0]/40 text-[11px] font-medium uppercase tracking-[0.24em] text-[#dce8fb] backdrop-blur-sm"
          >
            <span className="flex w-9 items-center justify-center bg-[#cfe0fa]">
              {/* Planet-and-orbit glyph — the moon ring from the scene, in miniature. */}
              <svg
                viewBox="0 0 14 14"
                fill="none"
                aria-hidden
                className="h-3.5 w-3.5 text-black"
              >
                <circle cx="7" cy="7" r="3" fill="currentColor" />
                <ellipse
                  cx="7"
                  cy="7"
                  rx="6.2"
                  ry="2.1"
                  stroke="currentColor"
                  strokeWidth="0.9"
                  transform="rotate(-18 7 7)"
                />
              </svg>
            </span>
            <span className="px-4 py-2">Terra Atlas</span>
          </div>

          {/* Right-side balance for the logo: the menu control in the same
              instrument-panel frame; the section nav lives in its dropdown. */}
          <div data-reveal className="relative flex flex-col items-end gap-2.5">
            <PanelButton
              active={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
              ariaLabel={menuOpen ? "Close menu" : "Open menu"}
              className="pointer-events-auto"
              padClass="px-4 py-2"
              /* Hamburger that folds into a cross: both lines sit on the
                 block's centre and only rotate/offset, so the morph is a
                 pure transform tween. */
              endSlot={
                <span
                  className={`relative block w-9 transition-colors duration-300 ${
                    menuOpen ? "bg-black" : "bg-[#cfe0fa]"
                  }`}
                >
                  <span
                    className={`absolute left-1/2 top-1/2 h-[2px] w-3.5 -translate-x-1/2 transition-all duration-300 ease-out ${
                      menuOpen
                        ? "-translate-y-1/2 rotate-45 bg-[#dce8fb]"
                        : "-translate-y-[3.5px] bg-black"
                    }`}
                  />
                  <span
                    className={`absolute left-1/2 top-1/2 h-[2px] w-3.5 -translate-x-1/2 transition-all duration-300 ease-out ${
                      menuOpen
                        ? "-translate-y-1/2 -rotate-45 bg-[#dce8fb]"
                        : "translate-y-[1.5px] bg-black"
                    }`}
                  />
                </span>
              }
            >
              Menu
            </PanelButton>

            {/* Dropdown index — one framed panel under the control, right-
                bound to it: every section with its number and one-line brief,
                separated by hairlines. Always mounted; GSAP slides it in and
                cascades the rows. Picking one closes the menu. */}
            <nav
              ref={menuRef}
              aria-label="Sections"
              aria-hidden={!menuOpen}
              style={{ opacity: 0, visibility: "hidden" }}
              className="pointer-events-none absolute right-0 top-full mt-2.5 w-[21rem] max-w-[calc(100vw-3rem)] divide-y divide-[#9fc0f0]/15 border border-[#9fc0f0]/40 bg-[#0a0f18]/70 backdrop-blur-md"
            >
              {MENU_ITEMS.map((item, i) => (
                <MenuRow
                  key={item.label}
                  index={i}
                  label={item.label}
                  desc={item.desc}
                  active={i === 0}
                  onClick={() => setMenuOpen(false)}
                />
              ))}
            </nav>
          </div>
        </header>

        <footer className="flex flex-col gap-7">
          <div
            data-reveal
            className="flex items-center justify-center gap-2 text-[11px] uppercase tracking-[0.28em] text-white/45"
          >
            <span aria-hidden>↕</span>
            Drag to move the text
          </div>

          <div className="relative border-t border-white/12 pt-6">
            {/* Justified, not a 4-col grid: equal gaps between neighbours, with
                the first and last columns bound to the frame edges. */}
            <dl className="grid grid-cols-2 gap-y-6 sm:flex sm:justify-between">
              {STATS.map((s, i) => (
                <div
                  data-reveal
                  key={s.label}
                  className={`flex flex-col gap-1.5 ${
                    // The row closes flush at both frame edges: first column
                    // left-bound, last column right-bound, like the rule above.
                    i === STATS.length - 1 ? "items-end text-right" : ""
                  }`}
                >
                  <dt
                    className="text-[10px] uppercase tracking-[0.28em] text-white/45"
                  >
                    {s.label}
                  </dt>
                  <dd className="flex items-baseline gap-1.5">
                    <span className="text-lg font-medium tracking-tight tabular-nums sm:text-xl">
                      {s.value}
                    </span>
                    <span className="text-[11px] tracking-wide text-white/45">
                      {s.unit}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </footer>
      </div>

      {/* Hero frame — one hard-cornered hairline around the whole section,
          pinned with the same registration marks as the buttons. */}
      <div className="pointer-events-none absolute inset-1.5 border border-white/20 sm:inset-3">
        <Cross className="-top-[5px] -left-[5px]" />
        <Cross className="-top-[5px] -right-[5px]" />
        <Cross className="-bottom-[5px] -left-[5px]" />
        <Cross className="-bottom-[5px] -right-[5px]" />
      </div>

      {/* Comet cursor — topmost layer, never intercepts input. */}
      <CursorTrail />
    </section>
  );
}
