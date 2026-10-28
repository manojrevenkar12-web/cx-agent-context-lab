# 5. Bets end in a decision made by a written rule

**Decision.** Every bet compares a baseline with its variants on the same scenarios and seeds,
paired, with a bootstrap confidence interval. A rule turns the result into one of four verdicts.
The thresholds are in `config/bets.yaml`.

- **Kill:** the primary gain is under 10%, or the interval reaches zero.
- **Iterate:** the resolved rate drops more than 2 points, or repeat questions rise more than 0.1 per conversation.
- **Hand off:** the gain is 25% or more, with the interval clear of zero.
- **Publish:** otherwise.

**Why.** A lab's output is a decision someone else acts on. Writing the rule down first stops the
verdict from bending to the result. The memo shows which branch fired and what the decision rests
on.

**Cost.** The thresholds are judgement calls. They are in config, so a team can argue about them
in a pull request rather than in the memo.
