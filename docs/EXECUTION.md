# Execution plane

## Boundary

The API process never runs user commands on its own host. A coding session is
queued into `ExecutionWorker`, which provisions one Docker container and one
Docker volume per session. The worker persists the database sandbox row, then
uses the narrow tool adapters in `src/tools/sandboxTools.ts`.

```text
API route
  -> ExecutionWorker (bounded in-process queue; replaceable by BullMQ)
      -> DockerSandboxRuntime
          -> container: non-root uid 1000, no capabilities, no-new-privileges,
             CPU/memory/PID quotas, /workspace volume, network=none by default
              -> filesystem / shell / git / tests tools
      -> events table (persist before SSE broadcast)
```

The runtime interface is deliberately independent of Docker. OpenSandbox can
replace `DockerSandboxRuntime` by implementing `SandboxRuntime` with the same
`create`, `exec`, and `destroy` contract. The worker does not receive a Docker
socket and the model never receives host paths or host credentials.

## Isolation defaults

- `KILN_SANDBOX_NETWORK=none` is the default. Enable a pre-created, policy-
  controlled Docker network only when a job needs package or GitHub access.
- Containers run as uid/gid `1000:1000`, with all Linux capabilities dropped,
  `no-new-privileges`, CPU/memory/PID limits, and a bounded command timeout.
- Commands are executed with `docker exec` in `/workspace`; cwd and filesystem
  paths reject traversal outside that directory.
- Tool output is capped at 512 KiB per command and terminal events are emitted
  as durable session events.
- The default image is built from `sandbox/Dockerfile`. Set
  `KILN_SANDBOX_IMAGE` to a pinned registry digest in production.
- `KILN_KEEP_SANDBOX=true` is a development-only setting. Production workers
  destroy the container and volume after the bootstrap job until snapshot/export
  storage is implemented.

This is a Docker isolation baseline, not a claim that Docker is a hostile,
multi-tenant boundary. For untrusted tenants, run the same runtime contract
behind OpenSandbox with gVisor, Kata, or Firecracker and a network policy.

## Tools

- `shellExec`: bounded shell execution with stdout/stderr events.
- `readFile`, `writeFile`, `listDir`, `searchFiles`, `applyPatch`:
  workspace-scoped file access with size, entry, and patch limits; writes emit
  file/diff events.
- `gitClone`, `gitStatus`, `gitDiff`, `gitBranch`, `gitCommit`: HTTPS-only clone,
  safe branch names, and local commits. Push/PR creation remains a separate
  approval-gated integration.
- `runTests`: explicit command or conservative detection for npm, pytest, Go,
  and Cargo tests; emits a normalized `test.result` event.

The tool layer is pure against a `SandboxRuntime`, so it can be tested without
Docker and the runtime can be swapped for OpenSandbox without changing agent
code.

## Worker lifecycle

1. `POST /sessions` queues a coding job only when `KILN_EXECUTION_ENABLED=true`
   and `ORCHESTRATOR_MODE=coding`; otherwise the backend fails honestly.
2. The worker creates the container and volume, records `sandboxes`, and links
   `sessions.sandbox_id`.
3. It clones the requested HTTPS repository, checks out the requested branch,
   reports status, and runs the detected test command if available.
4. Tool events are persisted before they reach SSE clients.
5. The worker marks the sandbox idle and the session done after bootstrap. The
   future agent loop will call the same tools one todo at a time, with approval
   gates before commits, pushes, package installs, deploys, and external writes.
6. On failure or cancellation, the session is marked failed and the sandbox is
   destroyed unless explicitly retained for development diagnosis.

The current queue is intentionally small and in-process. For multiple API
instances, move `CodingJob` messages to BullMQ/Redis and run workers in a
separate deployment; keep the runtime/tool interfaces unchanged.
