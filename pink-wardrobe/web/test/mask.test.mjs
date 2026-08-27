import assert from 'node:assert/strict';
import {
  keepAnchoredComponents, fillEnclosedHoles, erodeMask, decontaminate,
  classCoverage, COVERAGE_THRESHOLD,
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

// ---- 6. erosion pulls in by exactly one pixel ----------------------------
{
  const mask = rect(blank(), 30, 50, 90, 130);
  const out = erodeMask(mask, W, H, 1);
  assert.equal(out[50 * W + 60], 0, 'the old boundary row is gone');
  assert.equal(out[51 * W + 60], 1, 'one row in is kept');
  assert.equal(out[50 * W + 30], 0);
  console.log('6 erode removes exactly one pixel of boundary');
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
  const w = 20, h = 20;
  const kept = new Uint8Array(w * h);
  for (let y = 5; y < 15; y += 1) for (let x = 5; x < 15; x += 1) kept[y * w + x] = 1;

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

  assert.equal(data[(10 * w + 10) * 4 + 3], 255, 'the interior stays opaque');

  const edge = data[(5 * w + 10) * 4 + 3];
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

console.log('\nall assertions passed');
