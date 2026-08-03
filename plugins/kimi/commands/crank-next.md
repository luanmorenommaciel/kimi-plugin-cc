---
name: kimi:crank-next
description: Dispatch the single highest-priority ready task whose dependencies are satisfied.
argument-hint: [--force-dispatch] [--skip-preflight] [--model <model>]
allowed-tools: [Bash, Read, Write, Edit, Task]
---

# /kimi:crank-next

> Pick and run the next ready task from the backlog.

## Usage

```
/kimi:crank-next
/kimi:crank-next --skip-preflight
/kimi:crank-next --model kimi-code/k3
```

## Process

1. **Scan `tasks/` for specs with `status: ready`**
2. **Select highest priority (P0 > P1 > P2)** whose `depends_on` are all completed
3. **Dispatch via broker** with preflight + origin-state gates
4. **Return session ID** and task summary

## Notes

- If no tasks are ready, exits with message "No ready tasks"
- Honors `--force-dispatch` and `--skip-preflight` overrides
