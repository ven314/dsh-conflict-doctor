# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Codes below are the `Finding.code` values the audit emits. Their severity lives
in `src/detect.ts`; the user-facing table lives in README.

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-10-13

First release: a read-only conflict audit that builds a capability graph of the
running Loader profile **and** of the on-disk patch layers, then reports the
conflicts that fail silently.

### Added

**Live half** — the running process, read through public service lookups:

- `live/pending-missing-service` — a fiber stuck `PENDING` because it injects a
  service no plugin provides. Silent: no error, no log, the feature simply never
  appears.
- `live/pending-self-dependent` — the fiber waits on the very service it
  declares it provides. A self-lock, never resolved by installing anything.
- `live/tool-id-conflict` — two plugins register the same tool id; the later one
  fails to load as a whole row and the error never names the other owner.
- `live/outbound-tool-collision` — two loaded plugins declare the same tool id
  while the id is not yet in the registry: the collision is certain, only masked
  by timing.
- `live/duplicate-entry-id` — two modules claim one Loader entry id (the tree
  fails to start).
- `live/failed-fiber` — any fiber that failed to start, with the first line of
  the original error.
- `live/unprovided-inject` — a declared inject that resolves to nothing in the
  whole process (breaks on the next reload).

**Profile half** — the disk composition (bundle manifests → each patch layer →
the row ledger):

- `profile/duplicate-row-in-layer` — the same row id twice inside one layer.
- `profile/module-under-multiple-ids` — one module mounted twice. Reported
  `info` when the two rows differ by config (the deliberate two-entry pattern
  used by `dsh-tool-subagent`) and `critical` otherwise.
- `profile/disable-then-reinsert` — one layer disables a row, a later layer
  inserts it back.
- `profile/missing-patch-file` — a bundle declares `dsh.bundle.patch` and the
  file is not on disk.
- `profile/tool-id-collision` — two packages declare the same tool id in their
  compiled output. A capability-level conflict no version-string check covers.
- `profile/service-collision` — two packages register the same service name,
  filtered by realm so browser halves are never compared against host services.
- `profile/peer-range-unsatisfied` — grouped per package; `warning` when the
  installed version is below the declared minimum (the host is older than the
  plugin, which really breaks) and `info` when only the declaration is older.
- `profile/host-import-unsatisfied` — the plugin imports a symbol the running
  host does not export: the concrete form of "peer range matches ≠ API exists".
- `profile/node-engine-unsatisfied` — `engines.node` against the running Node.
- `profile/row-config-replaced` — several layers replace one row's config. Patch
  layers replace wholesale, so only the last one survives.
- `profile/dangling-override` — a `- id: X` in a patch matches no inserted row.
- `profile/bundle-unresolved` — a name in `dsh.profile.bundles` resolves from no
  `node_modules` root.

Every finding carries `refs`, `evidence`, `impact`, and at least one `fix`;
where a patch can repair it, the fix ships paste-ready YAML.

### Added — integration surface

- `conflict_doctor` tool (`scope: all | live | profile`, `profilePath?`,
  `format: markdown | json`).
- `/conflict-doctor` command.
- Critical findings are contributed to the system prompt (`systemPrompt.context`,
  order 50) instead of waiting to be asked. With no critical finding the
  contribution is the empty string — a healthy profile pays zero tokens.
- Every registration happens inside `ctx.effect()`, so unloading reverts cleanly.

### Changed

- Version-sensitive findings are **suppressed** unless the running host version
  can be confirmed against the live `pluginManager`. A packaged desktop app
  serves its bundles from its own archive while `profiles/node_modules` can hold
  a different generation; comparing against the disk copies invents conflicts
  that do not exist. This guard came from exactly such a false-positive run: it
  claimed seven missing symbols that were present in the running host
  (`IconBranchOutlineRegular` ×7, `resolveImageAttachmentAccess` ×13). See
  README § 版本权威性 and W1 in `../PLAN.md`.

### Known limitations

- Tool-id ownership cannot be attributed with certainty: the tool registry does
  not record who registered a name, so the live half reports the colliding name
  plus the failing row, and the static scan covers cross-package attribution for
  literal `defineTool({ name: '...' })` only. Dynamically built names are out of
  reach.
- `profile/row-config-replaced` reports the symptom, not whether the dropped
  config was required — layer semantics replace wholesale by design.
- Static name extraction recognises literals only (`super(ctx, 'name')`,
  `provide('name')`, `defineTool({ name })`). Findings are therefore phrased as
  "declared in compiled sources", not "registered at runtime".
- `!!js` expressions are recorded verbatim and never evaluated, so a conditional
  `disabled: !!js ...` cannot be judged; affected rows are treated as enabled.
- Fiber error text reads a non-public field (`fiber._error`) and degrades to
  "no error text" rather than throwing.

## Terminology

- **Silent failure** — a conflict that produces no error and no log. The reason
  this tool exists.
- **Version authority** — whether the versions on disk describe the host that is
  actually running (`authoritative`, `stale-disk`, `unknown`). See
  `resolveVersionAuthority` in `src/static.ts`.

[Unreleased]: https://github.com/ven314/dsh-conflict-doctor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ven314/dsh-conflict-doctor/releases/tag/v0.1.0
