---
bump: minor
---
One verb per subject, with the parameter as the generator rule: `get_conformance` and `get_corpus` return an index by default, take an argument to unfold one branch, and take `--full` for the whole document. `get_corpus` is new — the corpus previously had no verb at all. Changed default: `get_conformance` with no arguments now returns the 3.2 KB index rather than the 19.7 KB report.
