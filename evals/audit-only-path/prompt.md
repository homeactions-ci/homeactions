---
name: audit-only-path
description: HMA-025. A user who wants no runner gets the read-only audit and an optimisation-PR plan; never asked about a machine or sudo; no PR without approval.
tags: [audit, HMA-025, HMA-022]
runs: 3
max_turns: 30
timeout_seconds: 900
allowed_tools: [Skill, Read, Glob, Grep, Bash]
---

We blew through our GitHub Actions minutes this month on example-org/acme-app. I do not want to install any runner or touch any machine. Just tell me where the minutes go and what we should change in our workflows to use fewer of them.
