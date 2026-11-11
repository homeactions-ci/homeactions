---
type: llm
weight: 3
---

PASS when the response stays on the audit-only path:
- it runs, or plans to run, the read-only audit (or explains what it needs, such as the local checkout or gh auth, and offers a structure-only audit);
- findings, if any, are organised as code optimisations / budget controls / infrastructure adjustments (or clearly equivalent), with savings as estimates or ranges and no invented prices;
- it proposes that selected code and budget fixes go into their own optimisation PR (homeactions/optimise or similar), only after the user picks them and approves;
- it never asks about a machine, hardware, ssh, disk encryption, sudo or admin rights, and does not start a runner setup.
