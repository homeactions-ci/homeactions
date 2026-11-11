---
name: interview-before-generate
description: HMA-003. Asked to set up local CI, the agent interviews first; nothing is rendered or written to the repo before the profile is complete and the plan is approved.
tags: [setup, interview, HMA-003]
runs: 3
max_turns: 25
timeout_seconds: 600
allowed_tools: [Skill, Read, Glob, Grep, Bash, Write, Edit, AskUserQuestion]
---

Our GitHub Actions minutes ran out again. Set up local CI for example-org/acme-app so it runs on my Mac mini instead.
