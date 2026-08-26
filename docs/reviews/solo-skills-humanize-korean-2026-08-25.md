# `solo-skills` Korean copyediting review — 2026-08-25

MuncheKit reviewed `bam-bam-2/solo-skills` at commit [`d5789f5`](https://github.com/bam-bam-2/solo-skills/tree/d5789f592af17980054052fc7c05fe8a8e46be79), focusing on [`humanize-korean`](https://github.com/bam-bam-2/solo-skills/blob/d5789f592af17980054052fc7c05fe8a8e46be79/skills/humanize-korean/SKILL.md), its [quick rules](https://github.com/bam-bam-2/solo-skills/blob/d5789f592af17980054052fc7c05fe8a8e46be79/skills/humanize-korean/references/quick-rules.md), and its [rewriting playbook](https://github.com/bam-bam-2/solo-skills/blob/d5789f592af17980054052fc7c05fe8a8e46be79/skills/humanize-korean/references/rewriting-playbook.md). This note records an independent implementation review; no rule text or code was copied.

## Adopted

- Keep every edit local and explain it as an exact `before → after` pair.
- Preserve meaning, facts, genre, register, names, products, institutions, numbers, dates, units, quotations, and standard abbreviations.
- Leave uncertain passages unchanged and send them to human review.
- Treat change ratios as damage limits, never as targets. MuncheKit retains its stricter default limit and semantic guards.
- Do not vary endings, rhythm, or sentence length merely to make the text look less machine-generated.

This patch applies those decisions by adding exact rewrite-change reporting, strengthening the provider contract, repairing duplicate HTML rewrite ranges, and allowing the narrow dental attachment diagnostic to cross only a layout `<br>` while preserving that tag.

## Already covered

MuncheKit already implements guarded register, tense, negation/modality, particle-role, sentence-force, literal, structure, and change-ratio checks. Double-passive reduction is already limited to the high-confidence `KO-VOICE-001` safe fix. These controls remain narrower than a general-purpose rewriting recipe.

## Rejected

- Turning possibility or uncertainty into a categorical claim, such as changing “할 수 있다” into “한다.”
- Forcing ending, tense, aspect, or sentence-length variation for rhythm.
- Deleting causal, conditional, contrastive, or connective markers without preserving their relation.
- Replacing an abstract statement with a new number, example, actor, benefit, or medical promise.
- Treating a target percentage of changed text as evidence of quality.
- Framing the tool as authorship detection or detector evasion.

These recipes can change claims even when they sound smoother. In particular, MuncheKit does not adopt a blanket ban on `~을 위해`: that phrase is the explicit, review-only purpose candidate for `KO-ATTACH-001`.

## Deferred until corpus evaluation

Potential review-only diagnostics include `~에 있어(서)`, `~와 관련하여`, limited double-particle constructions, light-verb phrases, and repeated connective punctuation. Each needs positive cases, hard negatives, profile scoping, and false-positive measurement before entering the rule catalog. No external recipe is accepted as an exact replacement merely because it appears in a style guide.
