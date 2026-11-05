---
description: Whether the PR's tests fail without the fix
stages: [implement, review]
labels:
  - value: proves
    description: A new test fails without the fix and passes with it
    score: 1
  - value: partial
    description: Tests cover the change but would pass without the fix
    score: 0.5
  - value: none
    description: No test covers the change
    score: 0
pass: 0.5
sample: 50
---

Read the diff and the tests. Check out the base commit and run the new tests against it.
