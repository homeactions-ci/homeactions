---
name: audit
description: "Free, read-only GitHub Actions cost audit: where your minutes go and which code, budget and infrastructure changes save them."
argument-hint: "[owner/repo]"
user-invocable: true
disable-model-invocation: true
---

# homeactions audit

Read `${CLAUDE_SKILL_DIR}/../homeactions/SKILL.md` now and follow it in mode **`audit`**, with these arguments: $ARGUMENTS

Run the read-only audit and present it; offer the optimisation PR for selected code and budget fixes. Never ask about a machine or sudo on this path.

Its non-negotiable rules apply in full: never run a privileged command (hand it to the owner), never ask for or use a token in chat, and write nothing to the repo before the profile validates and the user approves the plan.
