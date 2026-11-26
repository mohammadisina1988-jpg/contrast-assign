# ContrastAssign

**Category** · Intelligent Contracts

**One-line description** · Find the minimum number of interface roles that must change to satisfy text contrast constraints using an independently fetched design palette.

## What it does

ContrastAssign is a standalone GenLayer primitive for design-system teams and release tooling. A caller provides an Open Color commit SHA and a baseline mapping of six palette slots to six interface roles. The contract tries every one-to-one assignment, minimizes the number of changed roles, and stores the chosen assignment alongside the original and repaired contrast checks. An infeasible study records `no_certified_assignment`.

## Why GenLayer

The caller identifies the revision and mapping. The leader and each validator independently fetch the palette from Open Color within the nondeterministic execution, normalize the six RGB values, and recompute the optimization. Equivalence requires an exact match on the canonical palette, decision, move count, assignment, and every audited pair. Changed fetched values can change the feasible set and the resulting onchain assignment. Integer luminance bounds keep the 4.5:1 threshold decision consistent, including at the boundary.

## What reviewers can try

The reproducible example starts with `012345`. Two roles must change. The minimum repair is `032145`, which swaps the panel and link colors and passes all five configured checks. Publishing `032145` as the baseline yields zero moves. The contract persists both studies under separate keys, and downstream consumers can query either result independently.

The direct tests compare the optimizer with an independent exhaustive reference, verify that changed evidence causes a validator to disagree, and exercise both sides of the threshold. The contract exposes a narrow guarantee for five configured pairs of opaque sRGB colors using the [WCAG 2.2 text-contrast criterion](https://www.w3.org/TR/WCAG22/#contrast-minimum).

## Links

- [GitHub repository](https://github.com/mohammadisina1988-jpg/contrast-assign)
- [StudioNet contract `0x2bA9e2F9717996d0A9A71D401F04B87f719baeBC`](https://explorer-studio.genlayer.com/address/0x2bA9e2F9717996d0A9A71D401F04B87f719baeBC)
- [Finalized deployment](https://explorer-studio.genlayer.com/tx/0xe46ebbdb2c53733a680438ad219a7ca25b78342d41b0abf7dbb51b294e03c499)
- [Finalized two-move repair](https://explorer-studio.genlayer.com/tx/0x37d3dbb8bad2c5b90ceedd76fcc2cbb5fad79470d36833e572c530e07bcef035)
- [Finalized zero-move confirmation](https://explorer-studio.genlayer.com/tx/0xb72d37a99665e76d64a33629072467914f9639744f019ee526849faeac22614e)
- [Replayable proof JSON](https://github.com/mohammadisina1988-jpg/contrast-assign/blob/main/proofs/studionet.json)
- [Passing GenVM checks](https://github.com/mohammadisina1988-jpg/contrast-assign/actions/runs/45773238416)
