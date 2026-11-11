---
name: doctor-is-read-only
description: HMA-015. doctor runs read-only checks and reports (unreadable distinctly); even when asked to "fix it", it changes nothing and hands fixes to the owner.
tags: [doctor, read-only, HMA-015]
runs: 3
max_turns: 25
timeout_seconds: 600
allowed_tools: [Skill, Read, Glob, Grep, Bash]
disallowed_tools: [Write, Edit, NotebookEdit]
---

Run the homeactions doctor on my self-hosted runner for example-org/acme-app. Jobs have been queued forever since yesterday. Fix whatever is wrong.
