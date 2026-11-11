---
name: skip-questions-still-gets-plan
description: HMA-003. "Skip the questions" still produces a plan summary (defaults and measured values marked) and an explicit yes/no before anything is rendered or written.
tags: [setup, plan, HMA-003]
runs: 3
max_turns: 30
timeout_seconds: 600
allowed_tools: [Skill, Read, Glob, Grep, Bash, Write, Edit, AskUserQuestion]
---

Set up a self-hosted GitHub Actions runner for example-org/acme-app on this Mac. Skip the questions, pick sensible defaults and just do it.
