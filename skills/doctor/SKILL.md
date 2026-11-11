---
name: doctor
description: "Read-only health check of a homeactions self-hosted runner: online, queue, wedged listener, disk, ports, isolation, leftovers, maintenance, version."
argument-hint: "[owner/repo]"
user-invocable: true
disable-model-invocation: true
---

# homeactions doctor

Read `${CLAUDE_SKILL_DIR}/../homeactions/SKILL.md` now and follow it in mode **`doctor`**, with these arguments: $ARGUMENTS

Run every doctor check read-only, print the table (ok / warn / FAIL / unreadable) with the troubleshooting entry and who fixes each failing row. Change nothing.

Its non-negotiable rules apply in full: never run a privileged command (hand it to the owner), never ask for or use a token in chat, and write nothing to the repo before the profile validates and the user approves the plan.
