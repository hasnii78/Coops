import assert from 'node:assert/strict';
import {
  keepAnchoredComponents, keepLargestComponent, fillEnclosedHoles, decontaminate,
  classCoverage, COVERAGE_THRESHOLD, trustsBaseline, isUncoveredBase, rgbToLab,
  guidedFilterAlpha, GUIDE_RADIUS, GUIDE_EPSILON,
} from '../src/lib/mask.js';

const W = 120, H = 200;

// A body roughly like the screenshot: shoulders at y=40, hips at y=110,
// knees 187, ankles at the bottom. Torso height 70.
const landmarks = {
  height: H,
  points: {
    leftShoulder: [45, 40], rightShoulder: [75, 40],
    leftHip: [50, 110], rightHip: [70, 110],
    leftKnee: [50, 187], rightKnee: [70, 187],
    leftAnkle: [50, 199], rightAnkle: [70, 199],
  },
};

// What resolveBand() produces for the body above (torso = hip - shoulder = 70).
const TORSO = 70;
const band = (fromY, fromOff, toY, toOff) => ({
  top: Math.max(0, fromY + fromOff * TORSO),
  bottom: Math.min(H, toY + toOff * TORSO),
});
const ANCHOR = {
  tops:   band(40, -0.25, 110, -0.05),
  shoes:  band(199, -0.25, 199, 2.0),
};

function blank() { return new Uint8Array(W * H); }
function rect(mask, x0, y0, x1, y1) {
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) mask[y * W + x] = 1;
  return mask;
}
function area(mask) { return mask.reduce((n, v) => n + v, 0); }

// ---- 1. the crop-top case -------------------------------------------------
{
  const mask = blank();
  rect(mask, 40, 55, 80, 90);    // crop top: chest, above the hip
  rect(mask, 52, 118, 68, 138);  // hallucinated underwear: below the hip
  const before = area(mask);

  const out = keepAnchoredComponents(mask, W, H, ANCHOR.tops);

  const topKept = out[70 * W + 60] === 1;
  const pantyGone = out[128 * W + 60] === 0;
  assert.ok(topKept, 'crop top survives');
  assert.ok(pantyGone, 'invented underwear is dropped');
  assert.equal(area(out), 40 * 35, 'exactly the crop top remains');
  assert.ok(area(out) < before);
  console.log('1 crop top kept, underwear dropped');
}

// ---- 2. a top that legitimately reaches past the hip ----------------------
{
  const mask = rect(blank(), 40, 55, 80, 125);   // one blob, hem below the hip
  const out = keepAnchoredComponents(mask, W, H, ANCHOR.tops);
  assert.equal(area(out), area(mask), 'a single connected top is never trimmed');
  console.log('2 long top untouched');
}

// ---- 3. two shoes are two blobs, both real -------------------------------
{
  const mask = blank();
  rect(mask, 42, 190, 58, 200);
  rect(mask, 62, 190, 78, 200);
  const out = keepAnchoredComponents(mask, W, H, ANCHOR.shoes);
  assert.equal(area(out), area(mask), 'both shoes survive');
  console.log('3 both shoes kept');
}

// ---- 4. fail open when nothing sits in the anchor band -------------------
{
  const mask = rect(blank(), 40, 150, 80, 180);  // knee height, called a top
  const out = keepAnchoredComponents(mask, W, H, ANCHOR.tops);
  assert.equal(area(out), area(mask), 'bad landmarks must not erase the garment');
  console.log('4 fails open, keeps everything');
}

// ---- 5. holes -------------------------------------------------------------
{
  const mask = rect(blank(), 30, 50, 90, 130);
  for (let y = 70; y < 78; y += 1) for (let x = 50; x < 58; x += 1) mask[y * W + x] = 0;
  const filled = fillEnclosedHoles(mask, W, H);
  assert.equal(filled[74 * W + 54], 1, 'small interior hole is restored');

  // A hole spanning a fifth of the garment is genuine and must stay.
  const big = rect(blank(), 30, 50, 90, 130);
  for (let y = 60; y < 110; y += 1) for (let x = 40; x < 80; x += 1) big[y * W + x] = 0;
  const kept = fillEnclosedHoles(big, W, H);
  assert.equal(kept[80 * W + 60], 0, 'large enclosed gap is left alone');
  console.log('5 small hole filled, large gap preserved');
}

// ---- 7. decontamination removes the background trace --------------------
{
  // A vertical edge: skin (220,180,150) on the left, garment (20,20,200) on
  // the right, and one boundary column drawn as a half-and-half mix at 50%
  // alpha. That column is exactly the fringe seen on the real jeans.
  const w = 7, h = 7;
  const kept = new Uint8Array(w * h);
  const data = new Uint8ClampedArray(w * h * 4);

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      const boundary = x === 3;
      kept[i] = x >= 3 ? 1 : 0;

      const [r, g, b, a] = x < 3
        ? [220, 180, 150, 0]
        : boundary
          ? [120, 100, 175, 128]     // (garment + skin) / 2
          : [20, 20, 200, 255];

      data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a;
    }
  }

  decontaminate(data, kept, w, h);

  const mid = (3 * w + 3) * 4;
  const [r, g, b] = [data[mid], data[mid + 1], data[mid + 2]];

  for (const [got, want, name] of [[r, 20, 'r'], [g, 20, 'g'], [b, 200, 'b']]) {
    assert.ok(Math.abs(got - want) <= 3, `${name}: ${got} should be ~${want}`);
  }
  assert.equal(data[mid + 3], 128, 'alpha is untouched');

  // Fully opaque interior must be left exactly as it was.
  const inner = (3 * w + 5) * 4;
  assert.deepEqual([data[inner], data[inner + 1], data[inner + 2]], [20, 20, 200]);

  console.log(`7 edge un-mixed to (${r},${g},${b}) — the skin trace is gone`);
}

// ---- 8. the feather never spreads outward -------------------------------
{
  const { featherEdges } = await import('../src/lib/mask.js');

  // Big enough that the middle is genuinely interior: the edge refinement
  // works over a window, so on a tiny square every pixel is a boundary pixel.
  const w = 60, h = 60;
  const kept = new Uint8Array(w * h);
  for (let y = 15; y < 45; y += 1) for (let x = 15; x < 45; x += 1) kept[y * w + x] = 1;

  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    // Garment inside, skin outside — so any outward bleed shows up as skin.
    const inside = kept[i];
    data[i * 4] = inside ? 20 : 220;
    data[i * 4 + 1] = inside ? 20 : 180;
    data[i * 4 + 2] = inside ? 200 : 150;
    data[i * 4 + 3] = inside ? 255 : 0;
  }

  const image = { data, width: w, height: h };
  const context = {
    getImageData: () => image,
    putImageData: () => {},
  };

  featherEdges(context, w, h, kept);

  for (let i = 0; i < w * h; i += 1) {
    if (!kept[i]) {
      assert.equal(data[i * 4 + 3], 0, `pixel ${i} outside the mask must stay fully transparent`);
    }
  }

  assert.equal(data[(30 * w + 30) * 4 + 3], 255, 'the interior stays opaque');

  const edge = data[(15 * w + 30) * 4 + 3];
  assert.ok(edge > 0 && edge < 255, `the boundary is softened, not binary (got ${edge})`);
  console.log(`8 no outward bleed; boundary alpha ${edge}`);
}

// ---- 9. bilinear class coverage -----------------------------------------
{
  // A 4x4 mask, left half clothes (4), right half hair (1).
  const m = new Uint8Array([
    4, 4, 1, 1,
    4, 4, 1, 1,
    4, 4, 1, 1,
    4, 4, 1, 1,
  ]);
  const CLOTHES = [4];

  // Deep inside each half, coverage is total or nothing.
  assert.equal(classCoverage(m, 4, 4, CLOTHES, 0.5, 1.5), 1, 'inside the garment');
  assert.equal(classCoverage(m, 4, 4, CLOTHES, 3.5, 1.5), 0, 'outside the garment');

  // Exactly between the last clothes texel and the first hair texel, coverage
  // is half — the boundary. Nearest-neighbour can only ever answer 0 or 1 here,
  // which is what made every edge a staircase.
  assert.equal(classCoverage(m, 4, 4, CLOTHES, 2.0, 1.5), 0.5, 'on the boundary');

  // And it moves smoothly across that gap rather than snapping.
  const ramp = [1.6, 1.8, 2.0, 2.2, 2.4].map(
    (x) => classCoverage(m, 4, 4, CLOTHES, x, 1.5),
  );
  for (let i = 1; i < ramp.length; i += 1) {
    assert.ok(ramp[i] < ramp[i - 1], `coverage falls monotonically: ${ramp}`);
  }
  assert.ok(new Set(ramp).size === ramp.length, 'every step is a distinct value');

  // Sampling outside the mask clamps rather than reading rubbish.
  assert.equal(classCoverage(m, 4, 4, CLOTHES, -5, -5), 1, 'clamps past the edge');
  assert.equal(classCoverage(m, 4, 4, CLOTHES, 99, 99), 0, 'clamps past the far edge');

  // Multi-class: shoes are filed under the catch-all, not under clothing.
  assert.equal(classCoverage(m, 4, 4, [4, 1], 2.0, 1.5), 1, 'both classes wanted');

  assert.equal(COVERAGE_THRESHOLD, 0.5);
  console.log(`9 coverage ramps smoothly across the boundary: ${ramp.map((v) => v.toFixed(2)).join(' ')}`);
}

// ---- 10. the baseline filter has to be sane to be believed ---------------
{
  // A white shirt over a skin-toned base: colour cannot separate them, so the
  // filter claims essentially the whole garment. That reading is rejected.
  assert.equal(trustsBaseline(10000, 120), false, 'a garment eaten whole is not believed');
  assert.equal(trustsBaseline(10000, 0), false, 'nothing left at all is not believed');

  // A crop top: most of its band is exposed base garment, and the filter
  // legitimately removes that. Roughly half surviving is normal and kept.
  assert.equal(trustsBaseline(10000, 5000), true, 'a crop top clears it comfortably');
  assert.equal(trustsBaseline(10000, 2600), true, 'so does a very revealing one');

  // The boundary itself.
  assert.equal(trustsBaseline(10000, 2500), true, 'exactly at the threshold is kept');
  assert.equal(trustsBaseline(10000, 2499), false, 'just under it is not');

  // Nothing in class at all is a different failure, and not this one's to call.
  assert.equal(trustsBaseline(0, 0), true, 'an empty class mask is not a baseline problem');

  console.log('10 baseline filter rejected when it claims the whole garment');
}

// ---- 11. a white shirt is not the cream base underneath it ---------------
{
  const BASE_TOL = 10;   // matches BASE_COLOUR_TOLERANCE in vision.js
  const UNCHANGED_TOL = 10;

  const CREAM = [232, 222, 196];   // the skin-toned bodysuit
  const WHITE = [250, 250, 248];   // a white tee over it
  const DENIM = [70, 90, 130];     // something obviously different
  const baseLab = rgbToLab(...CREAM);

  const decide = (pixel, avatarPixel) =>
    isUncoveredBase(pixel, baseLab, avatarPixel, BASE_TOL, UNCHANGED_TOL);

  // White is now far enough from cream to be kept on its own, without needing
  // the avatar to vouch for it. At the old tolerance of 22 it was not, and
  // every near-neutral pixel — white, grey, black — read as bodysuit.
  assert.equal(decide(WHITE, null), false, 'white is not cream, on colour alone');
  assert.equal(decide(WHITE, CREAM), false, 'nor with the avatar to compare');
  assert.equal(decide([210, 210, 212], CREAM), false, 'grey is not cream either');
  assert.equal(decide([40, 40, 42], CREAM), false, 'nor is near-black');

  // Uncovered base — cream then, cream now — is still removed.
  assert.equal(decide(CREAM, CREAM), true, 'exposed base is still dropped');

  // A shade of drift in the re-render must not resurrect the base.
  assert.equal(decide([236, 226, 200], [232, 222, 196]), true,
    'a slightly warmer re-render of the base is still base');

  // The jacket blob: an open jacket shades the bodysuit beneath it. Much
  // darker, same colour — so it is still base and must still be removed.
  assert.equal(decide([186, 178, 157], CREAM), true,
    'base in shadow is still base');
  assert.equal(decide([150, 143, 126], CREAM), true,
    'even in deep shadow');

  // And the shirt is still kept even when the same jacket shades it.
  assert.equal(decide([205, 205, 203], CREAM), false,
    'a shaded white shirt is still a shirt');

  // Anything plainly not the base colour never reaches the second test.
  assert.equal(decide(DENIM, CREAM), false, 'denim is never base');
  assert.equal(decide(DENIM, DENIM), false, 'not even where the avatar matches');

  console.log('11 neutrals kept on colour alone; cream dropped, lit or shaded');
}

// ---- 12. the guided filter snaps the edge onto the real one --------------
{
  // A photo whose garment ends sharply at column 30, and a mask that is wrong
  // about where that is: it ramps lazily from 25 to 35, as a low-resolution
  // model would. The refinement should pull the ramp onto column 30.
  const w = 60, h = 20;
  const guide = new Float32Array(w * h);
  const alpha = new Float32Array(w * h);

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      guide[i] = x < 30 ? 0.15 : 0.85;                        // dark garment, light background
      alpha[i] = x < 25 ? 1 : x > 35 ? 0 : (35 - x) / 10;     // a soft, misplaced edge
    }
  }

  const out = guidedFilterAlpha(alpha, guide, w, h, GUIDE_RADIUS, GUIDE_EPSILON);
  const at = (x) => out[10 * w + x];

  assert.ok(at(5) > 0.95, `deep inside stays opaque (got ${at(5).toFixed(2)})`);
  assert.ok(at(55) < 0.05, `deep outside stays clear (got ${at(55).toFixed(2)})`);

  // Either side of the true edge the mask should have become more decided,
  // because the picture is unambiguous there even though the mask was not.
  // This is a smoothing operator, not a threshold, so the test is that it moves
  // the right way and by a real margin — not that it snaps to 0 and 1.
  const was = (x) => alpha[10 * w + x];

  assert.ok(at(29) > was(29),
    `just inside the real edge got more solid: ${was(29).toFixed(2)} → ${at(29).toFixed(2)}`);
  assert.ok(at(31) < was(31),
    `just outside it got clearer: ${was(31).toFixed(2)} → ${at(31).toFixed(2)}`);

  // The half-way point should now fall on the garment's real edge, column 30,
  // rather than the column 31 the mask believed.
  const crossing = (plane) => {
    for (let x = 0; x < w; x += 1) if (plane[10 * w + x] < 0.5) return x;
    return -1;
  };

  assert.equal(crossing(alpha), 31, 'the mask was wrong by a pixel');
  assert.equal(crossing(out), 30, 'and now it is not');

  // And it must not have bought that by blurring: a hazier boundary is the
  // opposite of the point. Larger radii do exactly that, which is why this one
  // is 1.
  const width = (plane) => {
    let n = 0;
    for (let x = 0; x < w; x += 1) {
      const v = plane[10 * w + x];
      if (v > 0.05 && v < 0.95) n += 1;
    }
    return n;
  };

  assert.ok(width(out) <= width(alpha),
    `edge did not get hazier: ${width(alpha)}px → ${width(out)}px`);

  console.log(`12 edge moved onto the real one (col 31 → 30) without blurring: ${width(alpha)}px → ${width(out)}px`);
}

// ---- 13. an accessory is the one solid thing in its crop ------------------
{
  // What the wrist crop actually produces: a watch band, plus slivers where
  // the generator re-rendered the arm a shade differently and the hand moved a
  // pixel. Everything here "changed"; only one of them is the watch.
  const w = 80, h = 80;
  const mask = new Uint8Array(w * h);

  const box = (x0, y0, x1, y1) => {
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) mask[y * w + x] = 1;
  };

  box(30, 34, 50, 46);          // the watch
  box(20, 10, 22, 70);          // a sliver down the edge of the arm
  box(58, 20, 60, 64);          // and down the other edge
  box(40, 70, 46, 74);          // the hand, shifted

  const out = keepLargestComponent(mask, w, h);

  assert.equal(out[40 * w + 40], 1, 'the watch survives');
  assert.equal(out[40 * w + 21], 0, 'the arm sliver does not');
  assert.equal(out[40 * w + 59], 0, 'nor the other one');
  assert.equal(out[72 * w + 43], 0, 'nor the shifted hand');

  const area = out.reduce((n, v) => n + v, 0);
  assert.equal(area, 20 * 12, 'exactly the watch remains');

  // One blob in, the same blob out — nothing to choose between.
  const single = new Uint8Array(w * h);
  for (let y = 30; y < 50; y += 1) for (let x = 30; x < 50; x += 1) single[y * w + x] = 1;
  assert.deepEqual(keepLargestComponent(single, w, h), single, 'a lone blob is untouched');

  console.log('13 watch kept, re-render slivers dropped');
}

console.log('\nall assertions passed');
