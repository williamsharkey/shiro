/**
 * Liquid glass (iconsets.ts): the mockup's three.js transmission study. Thick
 * rounded glass blocks refract a soft backdrop, with clearcoat, a little
 * iridescence and the glyph floating inside; they lean toward the pointer.
 * One renderer draws the dock's tiles side by side (one cell each) and the
 * cells are copied into the tiles (TileCanvases, iconset-gl.ts). This module
 * and three.js are their own chunks, loaded only while Liquid glass is chosen.
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { LiveIconEngine } from './iconsets';
import { glyphFor, monogram } from './iconsets';
import { Driver, Pointer, TileCanvases, cellSize } from './iconset-gl';

function glyphTexture(appId: string, name: string, color: string): THREE.CanvasTexture {
  const s = 256, c = document.createElement('canvas');
  c.width = c.height = s;
  const x = c.getContext('2d')!;
  const d = glyphFor(appId);
  x.translate(s * .14, s * .14);
  x.scale(s * .72 / 24, s * .72 / 24);
  x.lineCap = 'round'; x.lineJoin = 'round'; x.lineWidth = 2.2; x.strokeStyle = color; x.fillStyle = color;
  if (d) x.stroke(new Path2D(d));
  else { x.font = '700 11px sans-serif'; x.textAlign = 'center'; x.fillText(monogram(name), 12, 16); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function backdropTexture(dark: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const x = c.getContext('2d')!;
  const blobs: [string, number, number][] = dark
    ? [['#2a1f6a', 0, 0], ['#7a3fd0', 180, 120], ['#139a8a', 420, 60], ['#3156d8', 650, 170], ['#c0457e', 880, 70]]
    : [['#e7e2ff', 0, 0], ['#ffb3d6', 170, 140], ['#94e6d6', 430, 60], ['#b9a6ff', 650, 170], ['#ffd2a6', 880, 70]];
  x.fillStyle = blobs[0][0];
  x.fillRect(0, 0, 1024, 256);
  for (const [col, bx, by] of blobs.slice(1)) {
    const g = x.createRadialGradient(bx, by, 0, bx, by, 240);
    g.addColorStop(0, col); g.addColorStop(1, col + '00');
    x.fillStyle = g; x.fillRect(0, 0, 1024, 256);
  }
  // fine stripes so the refraction reads
  x.globalAlpha = dark ? .10 : .14; x.fillStyle = dark ? '#ffffff' : '#5b4fd6';
  for (let i = 0; i < 1024; i += 22) x.fillRect(i, 0, 2, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export async function createGlassEngine(dock: HTMLElement, theme: 'light' | 'dark'): Promise<LiveIconEngine | null> {
  let renderer: THREE.WebGLRenderer;
  try {
    // No MSAA: the atlas is drawn at device pixels, and a multisampled buffer makes each copy-out slow
    renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: true });
  } catch { return null; }
  renderer.setPixelRatio(1); // the atlas is sized in device pixels already
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const atlas = renderer.domElement;

  let dark = theme === 'dark';
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment(renderer);
  let envTex: THREE.Texture | null = null;
  // One unit per tile: an orthographic row, a cell per tile
  const camera = new THREE.OrthographicCamera(-.5, .5, .5, -.5, .1, 20);
  camera.position.z = 5;
  const geo = new RoundedBoxGeometry(.9, .9, .34, 8, .2);
  const glyphGeo = new THREE.PlaneGeometry(.62, .62);
  const backMat = new THREE.MeshBasicMaterial();
  const back = new THREE.Mesh(new THREE.PlaneGeometry(1, 1.2), backMat);
  back.position.z = -1.4;
  scene.add(back);
  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  key.position.set(-2, 3, 4);
  scene.add(key);

  let blocks: { box: THREE.Mesh; glyph: THREE.Mesh; tex: THREE.Texture; mat: THREE.MeshPhysicalMaterial; gmat: THREE.MeshBasicMaterial; x: number }[] = [];
  const tiles = new TileCanvases();
  const pointer = new Pointer(dock);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const clock = new THREE.Clock();
  let cell = cellSize(dock);

  const look = () => {
    envTex?.dispose();
    envTex = pmrem.fromScene(room, dark ? .02 : .04).texture;
    scene.environment = envTex;
    renderer.toneMappingExposure = dark ? 1.05 : 1;
    key.intensity = dark ? 1.4 : 1.8;
    backMat.map?.dispose();
    backMat.map = backdropTexture(dark);
    backMat.needsUpdate = true;
  };
  const clearBlocks = () => {
    for (const b of blocks) {
      scene.remove(b.box, b.glyph);
      b.tex.dispose(); b.mat.dispose(); b.gmat.dispose();
    }
    blocks = [];
  };
  /** The apps the blocks were built for ("" = none) */
  let built = '';
  const appsOf = (els: HTMLElement[]) => els.map(el => {
    const id = el.dataset.glyph ?? '';
    return { id, name: el.closest('[aria-label]')?.getAttribute('aria-label') ?? id };
  });
  const keyOf = (apps: { id: string; name: string }[]) => `${dark}|${apps.map(a => `${a.id}:${a.name}`).join(',')}`;
  const build = (apps: { id: string; name: string }[]) => {
    clearBlocks();
    built = keyOf(apps);
    const n = Math.max(1, apps.length);
    const tints = dark ? ['#b9a6ff', '#9ef0ff', '#ffb3e6'] : ['#ffffff', '#f3efff', '#eefbff'];
    apps.forEach(({ id, name }, i) => {
      const mat = new THREE.MeshPhysicalMaterial({
        color: 0xffffff, metalness: 0, roughness: dark ? .08 : .06,
        transmission: 1, thickness: .55, ior: 1.48,
        attenuationColor: new THREE.Color(tints[i % 3]), attenuationDistance: dark ? 1.2 : 3.5,
        clearcoat: 1, clearcoatRoughness: .04, specularIntensity: 1,
        iridescence: .35, iridescenceIOR: 1.25, iridescenceThicknessRange: [120, 420],
        envMapIntensity: dark ? 1.15 : 1,
      });
      const x = -n / 2 + .5 + i;
      const box = new THREE.Mesh(geo, mat);
      box.position.set(x, 0, 0);
      const tex = glyphTexture(id, name, dark ? '#f6f3ff' : '#3b3554');
      // alpha-tested, not transparent: the transmission pass draws only opaque objects
      const gmat = new THREE.MeshBasicMaterial({ map: tex, alphaTest: .35 });
      const glyph = new THREE.Mesh(glyphGeo, gmat);
      glyph.position.set(x, 0, -.06);
      scene.add(box, glyph);
      blocks.push({ box, glyph, tex, mat, gmat, x });
    });
    camera.left = -n / 2; camera.right = n / 2; camera.top = .5; camera.bottom = -.5;
    camera.updateProjectionMatrix();
    back.scale.set(n * 1.1, 1, 1);
  };

  const frame = (blit = true) => {
    const n = Math.max(1, blocks.length);
    if (atlas.width !== n * cell || atlas.height !== cell) renderer.setSize(n * cell, cell, false);
    const t = clock.getElapsedTime();
    pointer.step();
    const mx = (pointer.pos[0] - .5) * 2, my = (pointer.pos[1] - .5) * 2;
    blocks.forEach((o, i) => {
      const lean = o.x / (n / 2);
      const idle = reduce.matches ? 0 : Math.sin(t * .6 + i * .55) * .06;
      o.box.rotation.y = (mx - lean * .35) * .35 + idle;
      o.box.rotation.x = my * .28 + idle * .5;
      o.glyph.rotation.copy(o.box.rotation);
    });
    renderer.render(scene, camera);
    if (blit) tiles.blit(atlas, cell);
  };
  const driver = new Driver(dock, () => frame());
  let prepared = false;
  look();
  // Compile the glass and glyph programs now (in parallel where the driver can), so
  // the first frame drawn during the crossfade costs a frame, not a shader compile
  {
    const mat = new THREE.MeshPhysicalMaterial({ transmission: 1, thickness: .55, ior: 1.48, clearcoat: 1, iridescence: .35, iridescenceThicknessRange: [120, 420], attenuationColor: new THREE.Color('#fff'), attenuationDistance: 2 });
    const gmat = new THREE.MeshBasicMaterial({ alphaTest: .35, map: backMat.map });
    const probe = [new THREE.Mesh(geo, mat), new THREE.Mesh(glyphGeo, gmat)];
    scene.add(...probe);
    renderer.setSize(cell, cell, false);
    try { await renderer.compileAsync(scene, camera); } catch {}
    renderer.render(scene, camera); // also sizes the transmission target
    scene.remove(...probe);
    mat.dispose(); gmat.dispose();
  }

  return {
    prepare(apps) {
      build(apps);
      frame(false);
      tiles.stageFrom(atlas);
      prepared = true;
    },
    attach(els) {
      tiles.attach(els);
      const c = cellSize(dock);
      const apps = appsOf(els);
      // The prepared frame is shown as is (copying it is cheap); otherwise build and draw now
      if (prepared && keyOf(apps) === built && c === cell) tiles.slice(cell);
      else {
        cell = c;
        if (keyOf(apps) !== built) build(apps);
        frame();
      }
      prepared = false;
      driver.kick();
    },
    hold(on) { driver.hold(on); },
    freeze() { driver.dispose(); pointer.dispose(); },
    setTheme(th) {
      dark = th === 'dark';
      look();
      build(appsOf(tiles.tiles.map(t => t.el)));
      frame();
    },
    dispose() {
      driver.dispose();
      pointer.dispose();
      tiles.clear();
      clearBlocks();
      geo.dispose(); glyphGeo.dispose(); backMat.map?.dispose(); backMat.dispose(); back.geometry.dispose();
      envTex?.dispose(); pmrem.dispose(); room.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
