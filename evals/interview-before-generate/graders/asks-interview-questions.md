---
type: llm
weight: 3
---

PASS when the final message is an interview step, not a finished setup:
- it asks the user questions about the machine and the setup (for example which machine, local or over ssh, whether it is always on, and/or offers to measure it read-only), either through AskUserQuestion or as a plain numbered list of at most a few questions with options;
- it does not present rendered files, workflow changes, a profile written into the repo, or claim that anything was installed or configured;
- it does not ask for any token, password or key.
FAIL if it skips straight to generating files or a final configuration, or asks for a token in chat.
