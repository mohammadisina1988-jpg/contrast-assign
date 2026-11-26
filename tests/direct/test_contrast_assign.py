from itertools import permutations
import json
from pathlib import Path
import re

import pytest


REVISION = "3a716ee1f5ff5456db33cb8a6e964afdca1e7bc3"
SOURCE = f"https://raw.githubusercontent.com/yeun/open-color/{REVISION}/open-color.json"
BODY = Path("fixtures/open-color.json").read_bytes()
BASELINE = "012345"
PALETTE = ["#f8f9fa", "#212529", "#1864ab", "#c5f6fa", "#ffe8cc", "#5f3dc4"]
PAIRS = [(2, 0), (2, 1), (3, 0), (3, 1), (5, 4)]
ROLES = ["canvas", "panel", "body_text", "link_text", "badge_background", "badge_text"]


@pytest.fixture
def contract(direct_deploy):
    return direct_deploy("contracts/contrast_assign.py", sdk_version="v0.2.16")


def provide(vm, body=BODY, status=200):
    vm.mock_web(re.escape(SOURCE), {"status": status, "body": body})


def reference_ratio(left, right):
    def luminance(color):
        srgb = bytes.fromhex(color[1:])
        return sum(weight * (c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
                   for c, weight in zip((value / 255 for value in srgb), (0.2126, 0.7152, 0.0722)))

    low, high = sorted((luminance(left), luminance(right)))
    return (high + 0.05) / (low + 0.05)


def test_public_optimizer_matches_exhaustive_reference(direct_vm, contract, direct_bob):
    assert contract.get_study(REVISION, BASELINE) is None
    provide(direct_vm)
    with direct_vm.prank(direct_bob):
        key = contract.publish(REVISION, BASELINE)
    assert direct_vm.run_validator() is True
    assert key == f"{REVISION}:{BASELINE}"
    study = contract.get_study(REVISION, BASELINE)
    assert study["palette"] == PALETTE
    expected = min((sum(slot != i for i, slot in enumerate(candidate)), candidate)
                   for candidate in permutations(range(6))
                   if all(reference_ratio(PALETTE[candidate[fg]], PALETTE[candidate[bg]]) >= 4.5
                          for fg, bg in PAIRS))
    actual = tuple(study["assignment"][role] for role in ROLES)
    assert (study["moves"], actual) == expected
    assert study["moves"] > 0
    assert any(check[2] == "fail" for check in study["baseline_checks"])
    for result, (fg, bg) in zip(study["checks"], PAIRS, strict=True):
        exact = reference_ratio(PALETTE[actual[fg]], PALETTE[actual[bg]])
        assert result[:3] == [ROLES[fg], ROLES[bg], "pass"]
        assert 0 <= exact - result[3] / 1000 < 0.002

    baseline = "".join(map(str, actual))
    contract.publish(REVISION, baseline)
    assert contract.get_study(REVISION, baseline)["moves"] == 0
    direct_vm.clear_mocks()
    assert contract.publish(REVISION, BASELINE) == key


def test_validator_requires_exact_evidence_and_decision(direct_vm, contract):
    provide(direct_vm)
    contract.publish(REVISION, BASELINE)
    differently_encoded = re.sub(rb"#[0-9a-f]{6}", lambda color: color.group().upper(),
                                 json.dumps(json.loads(BODY)).encode())
    direct_vm.clear_mocks()
    provide(direct_vm, differently_encoded)
    assert direct_vm.run_validator() is True

    direct_vm.clear_mocks()
    provide(direct_vm, BODY.replace(b"#f8f9fa", b"#f8f9fb"))
    assert direct_vm.run_validator() is False

    direct_vm.clear_mocks()
    unavailable = BODY
    for color in PALETTE:
        unavailable = unavailable.replace(color.encode(), b"#ffffff")
    provide(direct_vm, unavailable)
    assert direct_vm.run_validator() is False
    contract.publish(REVISION, "102345")
    assert direct_vm.run_validator() is True
    study = contract.get_study(REVISION, "102345")
    assert study["status"] == "no_certified_assignment"
    assert study["assignment"] is None and study["moves"] is None and study["checks"] == []


@pytest.mark.parametrize("body", [b"{}", b"[]", b"\xff", BODY.replace(b"#f8f9fa", b"#f8f9fx"),
                                  b'{"gray":[],"gray":[]}'])
def test_malformed_evidence_cannot_write(direct_vm, contract, body):
    provide(direct_vm, body)
    with direct_vm.expect_revert("Invalid Open Color palette"):
        contract.publish(REVISION, BASELINE)
    assert contract.get_study(REVISION, BASELINE) is None


def test_bad_inputs_and_unavailable_source_leave_storage_empty(direct_vm, contract):
    with direct_vm.expect_revert("Expected a lowercase upstream commit SHA"):
        contract.publish("master", BASELINE)
    with direct_vm.expect_revert("Baseline must be a permutation of 012345"):
        contract.publish(REVISION, "012344")
    provide(direct_vm, status=503)
    with direct_vm.expect_revert("Open Color palette acquisition failed"):
        contract.publish(REVISION, BASELINE)
    assert contract.get_study(REVISION, BASELINE) is None


def test_checks_on_both_sides_of_threshold(direct_vm, contract):
    # Black against #747474 falls below 4.5; black against #757575 exceeds it.
    payload = BODY.replace(b"#f8f9fa", b"#747474").replace(b"#212529", b"#757575")
    provide(direct_vm, payload.replace(b"#1864ab", b"#000000"))
    contract.publish(REVISION, BASELINE)
    checks = contract.get_study(REVISION, BASELINE)["baseline_checks"]
    assert checks[0][2] == "fail" and checks[0][3] < 4500
    assert checks[1][2] == "pass" and checks[1][3] >= 4500
