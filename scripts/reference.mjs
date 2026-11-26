import assert from "node:assert/strict";

const roles = ["canvas", "panel", "body_text", "link_text", "badge_background", "badge_text"];
const pairs = [[2, 0], [2, 1], [3, 0], [3, 1], [5, 4]];

export function readPalette(json) {
  return [json.gray[0], json.gray[9], json.blue[9], json.cyan[1], json.orange[1], json.violet[9]];
}

function luminance(color) {
  const rgb = Buffer.from(color.slice(1), "hex");
  return [0.2126, 0.7152, 0.0722].reduce((total, weight, index) => {
    const channel = rgb[index] / 255;
    return total + weight * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  }, 0);
}

function ratio(lights, first, second) {
  return (Math.max(lights[first], lights[second]) + 0.05) / (Math.min(lights[first], lights[second]) + 0.05);
}

export function chooseAssignment(palette, baseline) {
  const lights = palette.map(luminance);
  let best = null;
  function visit(prefix, available, moves) {
    if (best && moves >= best.moves) return;
    if (available.length === 0) {
      if (pairs.every(([fg, bg]) => ratio(lights, prefix[fg], prefix[bg]) >= 4.5)) best = { slots: prefix, moves };
      return;
    }
    for (const slot of available) {
      visit([...prefix, slot], available.filter(other => other !== slot), moves + Number(slot !== Number(baseline[prefix.length])));
    }
  }
  visit([], palette.map((_, index) => index), 0);
  return best;
}

export function verifyStudy(study, expected) {
  const { revision, source, baseline, palette } = expected;
  assert.equal(study.revision, revision);
  assert.equal(study.source, source);
  assert.equal(study.baseline, baseline);
  assert.deepEqual(study.palette, palette);
  const best = chooseAssignment(palette, baseline);
  assert(best, "The StudioNet example must have a feasible assignment");
  assert.equal(study.status, "assigned");
  assert.equal(study.moves, best.moves);
  assert.deepEqual(study.assignment, Object.fromEntries(roles.map((role, i) => [role, best.slots[i]])));

  const lights = palette.map(luminance);
  function check(audits, slots) {
    assert.equal(audits.length, pairs.length);
    for (const [index, [fg, bg]] of pairs.entries()) {
      const exact = ratio(lights, slots[fg], slots[bg]);
      const [foreground, background, decision, lower] = audits[index];
      assert.deepEqual([foreground, background, decision], [roles[fg], roles[bg], exact >= 4.5 ? "pass" : "fail"]);
      assert(Number.isInteger(lower) && exact - lower / 1000 >= 0 && exact - lower / 1000 < 0.002);
    }
  }
  check(study.baseline_checks, [...baseline].map(Number));
  check(study.checks, best.slots);
}
