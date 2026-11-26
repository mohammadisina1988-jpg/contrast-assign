# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

import json
from itertools import permutations

from genlayer import *


SOURCE = "https://raw.githubusercontent.com/yeun/open-color/{}/open-color.json"
HEX = "0123456789abcdef"
SLOTS = (("gray", 0), ("gray", 9), ("blue", 9), ("cyan", 1), ("orange", 1), ("violet", 9))
ROLES = ("canvas", "panel", "body_text", "link_text", "badge_background", "badge_text")
PAIRS = ((2, 0), (2, 1), (3, 0), (3, 1), (5, 4))
SCALE = 1_000_000
BIAS = SCALE * 10_000 // 20


def _channel_bounds(channel: int) -> tuple[int, int]:
    if channel == 0 or channel == 255:
        exact = channel * SCALE // 255
        return exact, exact
    if channel <= 10:
        lower = channel * 100 * SCALE // (255 * 1292)
        return lower, lower + 1

    # Linear sRGB = ((200c + 2805) / 53805) ** (12/5).
    target = (200 * channel + 2805) ** 12 * SCALE**5 // 53805**12
    lower, upper = 0, SCALE
    while upper - lower > 1:
        middle = (lower + upper) // 2
        if middle**5 <= target:
            lower = middle
        else:
            upper = middle
    return lower, upper


def _luminance_bounds(color: str) -> tuple[int, int]:
    channels = [_channel_bounds(int(color[i:i + 2], 16)) for i in (1, 3, 5)]
    weights = (2126, 7152, 722)
    return (
        sum(weight * channel[0] for weight, channel in zip(weights, channels)),
        sum(weight * channel[1] for weight, channel in zip(weights, channels)),
    )


def _contrast(left: tuple[int, int], right: tuple[int, int]) -> tuple[str, int]:
    lo_num = max(left[0], right[0]) + BIAS
    lo_den = min(left[1], right[1]) + BIAS
    hi_num = max(left[1], right[1]) + BIAS
    hi_den = min(left[0], right[0]) + BIAS
    if 2 * lo_num >= 9 * lo_den:
        decision = "pass"
    elif 2 * hi_num < 9 * hi_den:
        decision = "fail"
    else:
        decision = "indeterminate"
    return decision, max(1000, lo_num * 1000 // lo_den)


def _unique_keys(pairs: list) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def _fetch_palette(url: str) -> list[str]:
    response = gl.nondet.web.get(url)
    if response.status != 200 or len(response.body) > 16_384:
        raise gl.vm.UserError("Open Color palette acquisition failed")
    try:
        source = json.loads(response.body.decode("utf-8"), object_pairs_hook=_unique_keys)
        if not isinstance(source, dict):
            raise ValueError("Expected a palette object")
        palette = []
        for family, index in SLOTS:
            shades = source[family]
            if not isinstance(shades, list):
                raise ValueError("Expected a shade list")
            color = shades[index]
            if not isinstance(color, str) or len(color) != 7 or color[0] != "#":
                raise ValueError("Expected an RGB hex color")
            color = color.lower()
            if any(digit not in HEX for digit in color[1:]):
                raise ValueError("Invalid RGB hex digit")
            palette.append(color)
        return palette
    except (ValueError, IndexError, KeyError, RecursionError):
        raise gl.vm.UserError("Invalid Open Color palette")


def _solve(palette: list[str], baseline: tuple[int, ...]) -> dict:
    luminance = [_luminance_bounds(color) for color in palette]
    checks = [[_contrast(left, right) for right in luminance] for left in luminance]
    feasible = (
        (sum(slot != old for slot, old in zip(candidate, baseline)), candidate)
        for candidate in permutations(range(len(SLOTS)))
        if all(checks[candidate[fg]][candidate[bg]][0] == "pass" for fg, bg in PAIRS)
    )
    optimum = min(feasible, default=None)

    def audits(slots: tuple[int, ...]) -> list:
        return [[ROLES[fg], ROLES[bg], *checks[slots[fg]][slots[bg]]] for fg, bg in PAIRS]

    return {
        "baseline_checks": audits(baseline),
        "status": "no_certified_assignment" if optimum is None else "assigned",
        "moves": None if optimum is None else optimum[0],
        "assignment": None if optimum is None else dict(zip(ROLES, optimum[1])),
        "checks": [] if optimum is None else audits(optimum[1]),
    }


def _study_key(revision: str, baseline: str) -> str:
    if len(revision) != 40 or any(digit not in HEX for digit in revision):
        raise gl.vm.UserError("Expected a lowercase upstream commit SHA")
    if len(baseline) != len(SLOTS) or sorted(baseline) != list("012345"):
        raise gl.vm.UserError("Baseline must be a permutation of 012345")
    return revision + ":" + baseline


class ContrastAssign(gl.Contract):
    studies: TreeMap[str, str]

    def __init__(self):
        pass

    @gl.public.write
    def publish(self, revision: str, baseline: str) -> str:
        key = _study_key(revision, baseline)
        if key in self.studies:
            return key
        source = SOURCE.format(revision)
        slots = tuple(int(slot) for slot in baseline)

        def observe():
            palette = _fetch_palette(source)
            study = {
                "source": source,
                "revision": revision,
                "baseline": baseline,
                "palette": palette,
                **_solve(palette, slots),
            }
            return json.dumps(study, sort_keys=True, separators=(",", ":"))

        def validate(leader):
            if not isinstance(leader, gl.vm.Return):
                return False
            try:
                return observe() == leader.calldata
            except gl.vm.UserError:
                return False

        self.studies[key] = gl.vm.run_nondet_unsafe(observe, validate)
        return key

    @gl.public.view
    def get_study(self, revision: str, baseline: str) -> dict | None:
        key = _study_key(revision, baseline)
        if key in self.studies:
            return json.loads(self.studies[key])
        return None
