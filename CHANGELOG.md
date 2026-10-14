# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Codes below are the `Finding.code` values the audit emits. Their severity lives
in `src/detect.ts`; the user-facing table lives in README.

## [Unreleased]

Nothing yet.

## [0.2.0] - 2026-10-14

The headline: version-sensitive checks now compare against **the host that is
actually running**, not the profile's on-disk copies. On a packaged desktop
install that took one profile from 5 findings to 45, with every addition
verified genuine. Detection also grew a client-realm half, a frozen output
contract, and a repair engine — dry-run difference tables, pickable patch
files, and risk grading — while the tool itself stays read-only.

### Added

**Host archive reading — the release's main change**

- Zero-dependency asar reader (`src/asar.ts`), export-surface walker
  (`src/surface.ts`), and host locator (`src/hostroot.ts`). A packaged app
  serves its bundles from its own archive while `profiles/node_modules` may hold
  a different generation; comparing against the stale copy is how this tool once
  reported seven missing symbols that were present in the running host.
- A fourth version-authority verdict, `archive-authoritative`. Previously
  `stale-disk` meant every version-sensitive detector abstained, so a typical
  desktop install never reported API-level conflicts at all.
- `profile/host-subpath-not-exported` — an import of a subpath the running host
  does not expose through `exports`. Node throws
  `ERR_PACKAGE_PATH_NOT_EXPORTED` even when the file exists, so no symbol-level
  check can see it.

**Client realm detectors**

- `client/inject-unprovided` — the client-side twin of
  `live/pending-missing-service`. When a browser half injects a client module
  nothing provides, the half is silently inert.
- `client/service-name-shared-with-host` — a service name on both sides.
  Reported as `info`, because the page and the host keep separate registries and
  a shared name is legitimate; the point is that the exclusion used to be silent.
- Realm-aware report grouping, so host-side and browser-side findings are read
  separately (they are fixed differently).

**Attribution confidence**

- Tool ids and service names are now graded `certain` / `probable` /
  `ambiguous` / `unknown` instead of the README's blanket "cannot be attributed
  with certainty". On this machine: 83 names, 79 certain, 4 probable, 0
  ambiguous. Weaker attributions are listed first.

**Layer semantics**

- A whitelist `!!js` interpreter (`src/expr.ts`) that decides pure expressions
  (literals, `process.platform`/`arch`/`version`, comparisons, `!`/`&&`/`||`/`??`)
  and refuses everything else — no `eval`, no `Function`, no property chains, no
  function calls, no template literals. 5 of the 17 expressions on this profile
  are now decided; the other 12 are still recorded verbatim and disclosed.
- `profile/inject-cycle` — a cycle among patch-layer `inject` declarations.
  Detected without knowing who provides what, so it does not depend on the
  provider-scan blind spot.
- Key-level config provenance for `profile/row-config-replaced`: which keys
  changed and between which values, which the last layer added, and which were
  dropped. A dropped key upgrades the finding to `warning`.

**Output contract and CLI**

- Frozen JSON contract (`schema/audit-report.schema.json`, JSON Schema 2020-12)
  with a `schemaVersion` field, shipped in the tarball.
- `conflict-doctor` CLI with stable exit codes: 0 clean, 1 warning under
  `--fail-on warning`, 2 critical (default), 3 the audit could not run. An
  unknown flag or a bad `--fail-on` refuses to start.
- `--fail-on none|warning|critical`, `--format markdown|json`, `--out <file>`.

**Repair engine — the middle ground between "read-only" and "edit your config"**

- Risk grading: every `patch` fix is classified from its own snippet —
  `safe` (inserts a new row), `caution` (replaces an existing `config`),
  `destructive` (disables or removes a row). Computed at `detect()`'s single
  exit, so every fix has a grade by construction; `manual`/`command` and
  `destructive` fixes are never auto-applicable.
- Fix-conflict detection: two fixes that change the same row in incompatible
  ways (one disables, one reconfigures) now report
  `fix/mutually-exclusive`. Same-direction pairs are redundant, not conflicts.
- `--dry-run`: applies each applicable repair to an **in-memory** copy of the
  patch file, re-runs the full layer simulator and detectors, and prints a
  before/after difference table. Nothing is written.
- Advisory repairs are not reported as failures: a repair whose purpose is to
  make the last layer authoritative (e.g. `profile/row-config-replaced`)
  correctly leaves its finding in place. The table says
  "ℹ️ 仅建议（不消除结论）" rather than "❌ 未解决", and `isFailure()` keeps
  genuinely unresolved repairs marked as failures.
- `--fix-out <dir>`: writes each applicable repair as its own `.patch.yml`
  file plus a `README.md` manifest. The files are inert — DSH never loads a
  `.patch.yml` beside `cordis.patch.yml` — so a wrong pick cannot break
  anything. Same-code repairs get distinct filenames (`-2` suffix).
- Guarded-write primitives (`guardTarget`, `writeWithBackup`,
  `rollbackFromBackup`) with the path-safety gate: target must resolve inside
  the profile (`path.relative` containment, so `sibling-node_modules` is not a
  prefix trap), `node_modules` is refused, missing targets are refused,
  backups + atomic rename. **Wired to no CLI flag yet** — `--apply` is
  deliberately not enabled until rollback, non-TTY confirmation, and an
  end-to-end integration test are in. See `docs/apply.md`.
- `profile/host-generation-mismatch`: when many packages all import symbols a
  single host package no longer exports, the per-package findings (each true)
  are summarised into one root-cause finding: the profile's plugin generation
  and the running host have drifted. The summary adds; it never replaces or
  softens an individual finding.

**Quality gates and docs**

- Gates: `check-metadata`, `check-version`, `check-tarball`, `check-entry`,
  `check-schema`, `check-golden`, `check-perf`, `check-memory` (see `pnpm
  check`), plus a three-OS × two-Node CI matrix. The memory gate runs a full
  audit in a clean subprocess (102 MB RSS against a 120 MB budget) because the
  perf gate's own process has already loaded 500 bundle versions.
- Docs: `version-authority.md`, `realms.md`, `layer-semantics.md`,
  `report-format.md`, `apply.md`. `docs/` ships in the tarball.
- `tsconfig` runs with `strict`, `noUncheckedIndexedAccess`, and
  `exactOptionalPropertyTypes`; the last one caught a real bug where
  `HostRoot` optional fields were assigned `undefined`, which would have
  serialised as `null` in JSON output.
- Test suite grew from 38 to 141 checks, covering asar byte layout, export
  extraction, the four verdicts, the expression whitelist, key-level diffs,
  inject cycles, every confidence grade, the repair engine, and dry-run.

### Changed

- The import check resolves symbols against the running host's export surface,
  cached per package, instead of the profile's stale copy.
- Peer-range comparisons use the running host's versions. The disk only fills
  gaps for packages the host does not ship.
- Cross-generation peer declarations (a whole stale profile against a newer
  host) collapse into one aggregated `info` rather than one finding per package.
  The previous per-package form produced 127 findings and buried the actionable
  ones. The same treatment now applies to masses of `host-import-unsatisfied`
  against one host package: on this profile 32 per-package findings (each
  verified against the archive's own bytes) plus one
  `profile/host-generation-mismatch` root-cause finding.
- A missing host archive, and a Loader-less composition, are now disclosed in
  the report instead of silently skipping the checks that depend on them.
- Several planned detectors were deliberately **not** built because the evidence
  to support them does not exist; each is documented with its reasoning in
  `docs/realms.md` and `docs/layer-semantics.md`.

### Fixed

- **Every conditional disable was silently read as enabled.** `disabled` was
  compared with `=== true`, and a `!!js` expression is a string, so
  `disabled: !!js process.platform === 'win32'` was ignored. On Windows that
  meant rows that are actually disabled (`bash-sandbox`, `tool-bash`) were
  treated as running.
- A 121 MB archive's u32 header-size field does not locate the JSON tree (it is
  8 bytes short), and content offsets are relative to the end of the tree rather
  than the file start. Both were established by SHA-256 against the archive's own
  `integrity` records.
- A key-order-only restatement produced a finding whose own evidence said "no
  differences". The per-key diff now decides, and reports nothing.
- `!false` evaluated to `false`: the truthiness check inside `!` was inverted.
  Truthiness now lives in one helper shared by `!`/`&&`/`||`.
- Reading the archive per package made a full scan take 8s, and always reading
  `headerSize + 64 MB` made a cold scan take 18s. Now ~1.9s warm, with a budget
  gate.
- **`profile/disable-then-reinsert` fired when the row ended up disabled.** The
  detector recorded the finding at the moment of re-insertion and never looked
  at what came after, so a row the user later re-disabled was still reported as
  "实际它还在加载" — a flat-out lie. It now reports only when the row's final
  state is enabled.
- `--fix-out` silently overwrote one repair file with the next when two findings
  shared a code: the per-finding filename counter made both write
  `profile-row-config-replaced.patch.yml` while the CLI still reported two
  files written. Counters now run across findings, so the second gets a `-2`
  suffix.
- `isAutoApplicable` once treated a `manual` fix as auto-applicable when its
  risk happened to be low. It now inspects the whole fix: `manual`, `command`,
  and `destructive` are never auto-applicable, whatever the risk.

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
  actually running (`authoritative`, `archive-authoritative`, `stale-disk`,
  `unknown`). See `resolveVersionAuthority` in `src/static.ts` and
  [`docs/version-authority.md`](docs/version-authority.md).

[Unreleased]: https://github.com/ven314/dsh-conflict-doctor/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ven314/dsh-conflict-doctor/releases/tag/v0.2.0
[0.1.0]: https://github.com/ven314/dsh-conflict-doctor/releases/tag/v0.1.0
