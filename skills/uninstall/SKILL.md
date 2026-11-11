---
name: uninstall
description: "Remove a homeactions self-hosted runner: fallback to hosted, owner runs the uninstaller, PR reverting the workflow changes."
argument-hint: "[owner/repo]"
user-invocable: true
disable-model-invocation: true
---

# homeactions uninstall

Read `${CLAUDE_SKILL_DIR}/../homeactions/SKILL.md` now and follow it in mode **`uninstall`**, with these arguments: $ARGUMENTS

Plan the removal (yes/no), hand the owner the variable deletion and uninstall.sh commands, open the revert PR, then verify read-only.

Its non-negotiable rules apply in full: never run a privileged command (hand it to the owner), never ask for or use a token in chat, and write nothing to the repo before the profile validates and the user approves the plan.
