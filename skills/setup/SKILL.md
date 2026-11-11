---
name: setup
description: "Set up a safe, isolated, sudo-free self-hosted GitHub Actions runner on your own Mac or Linux box (audit, interview, plan, then owner steps)."
argument-hint: "[owner/repo]"
user-invocable: true
disable-model-invocation: true
---

# homeactions setup

Read `${CLAUDE_SKILL_DIR}/../homeactions/SKILL.md` now and follow it in mode **`setup`**, with these arguments: $ARGUMENTS

Run the full setup flow: step 0 audit, the 12-topic interview, the plan summary and its explicit yes, then render, PRs, owner steps, verify, smoke, canary, fallback switch and watch period.

Its non-negotiable rules apply in full: never run a privileged command (hand it to the owner), never ask for or use a token in chat, and write nothing to the repo before the profile validates and the user approves the plan.
