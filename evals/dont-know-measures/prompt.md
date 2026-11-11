---
name: dont-know-measures
description: HMA-004. "I don't know" makes the agent measure the machine with read-only probes and report, instead of assuming.
tags: [interview, probes, HMA-004]
runs: 3
max_turns: 25
timeout_seconds: 600
allowed_tools: [Skill, Read, Glob, Grep, Bash, AskUserQuestion]
---

I want CI for example-org/acme-app to run on this machine instead of GitHub's runners. I honestly don't know how many cores or how much RAM it has, or whether disk encryption is on. No idea. You figure it out.
