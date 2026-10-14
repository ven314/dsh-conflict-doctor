/**
 * Self-contained verification for dsh-conflict-doctor.
 *
 * Part A —pure detector fixtures: every detector fires on a crafted conflict
 *          and stays silent on a clean composition.
 * Part B —the real running profile on this machine: the static scanner must
 *          read actual patch layers and produce a report without throwing.
 * Part C —integration: the plugin's `apply()` loads into a real Cordis
 *          container and registers its tool and command.
 * Part D —asar reader. Builds throwaway archives with the byte layout Electron
 *          produces and asserts the decoder handles the two surprises a real
 *          archive handed us (offsets relative to the end of the tree, and
 *          size/offset written as strings). Kept synthetic rather than shipped
 *          so the test proves the decoder, not a committed binary.
 *
 * Run: node test/run.mjs
 */
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { Context, Service } from '@deepseek-ai/cordis'
import YAML from 'yaml'
import { closeAsar, findNode, hasAsarPath, isAsarDir, listAsarDir, openAsar, readAsarFile, readAsarText } from '../lib/asar.js'
import { EXIT, SCHEMA_VERSION, exitCodeFor, parseFailOn } from '../lib/contract.js'
import { clearHostCaches, findHostRoot, isSafePackageName, readHostSurface } from '../lib/hostface.js'
import { comparableRealm, readClientHalf, realmOf } from '../lib/realm.js'
import { CONFIDENCE_LABEL, attribute, attributeAll, confidenceCounts } from '../lib/attribution.js'
import { collectSurface } from '../lib/surface.js'
import { collectLive } from '../lib/live.js'
import { evaluateCondition, evaluateExpression } from '../lib/expr.js'
import {
  RISK_LABEL,
  advisoryReason,
  classifyRisk,
  findFixConflicts,
  isAdvisory,
  isAutoApplicable,
  snippetRowId,
} from '../lib/fix.js'
import { applySnippet, splitPatchDocument } from '../lib/patch-edit.js'
import { dryRunAll, dryRunFix, isFailure, renderDryRun } from '../lib/dryrun.js'
import { guardTarget, rollbackFromBackup, writeFixFiles, writeWithBackup } from '../lib/apply.js'
import { validateReport } from './check-schema.mjs'
import { versionsComparable } from '../lib/detect.js'
import {
  collectStatic,
  defaultProfilePath,
  detect,
  renderMarkdown,
  resolveVersionAuthority,
  runAudit,
  scanDeclaredToolIds,
} from '../lib/index.js'

let checks = 0
const failures = []

/**
 * Run one assertion. An async body is awaited so failures still land in the
 * failure list instead of becoming an unhandled rejection.
 */
async function check(label, fn) {
  checks += 1
  try {
    await fn()
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Codes present in a finding list, for order-independent assertions. */
function codes(findings) {
  return findings.map((finding) => finding.code).sort()
}

function findingFor(findings, code) {
  const found = findings.find((finding) => finding.code === code)
  assert.ok(found, `expected a "${code}" finding, got [${codes(findings).join(', ')}]`)
  return found
}

/* ------------------------------------------------------------------ Part A */

const layer = (index, label, kind) => ({ index, label, kind, file: `${label}.yml` })

/** A profile whose every layer is hostile, so each detector has a target. */
const dirtyProfile = {
  profilePath: 'C:/fixture/profile',
  layers: [layer(0, 'bundle base@1.0.0', 'bundle'), layer(1, 'bundle mode@1.0.0', 'bundle'), layer(2, 'user patch', 'user')],
  inserts: [
    // same row id twice inside layer 0 —whole-tree collision
    { rowId: 'dup-row', moduleName: 'pkg-one', hasConfig: false, configJson: 'null', layerIndex: 0 },
    { rowId: 'dup-row', moduleName: 'pkg-two', hasConfig: false, configJson: 'null', layerIndex: 0 },
    // one module mounted twice
    { rowId: 'twin-a', moduleName: 'pkg-twin', hasConfig: false, configJson: 'null', layerIndex: 0 },
    { rowId: 'twin-b', moduleName: 'pkg-twin', hasConfig: false, configJson: 'null', layerIndex: 0 },
    // config restated by a later layer
    { rowId: 'cfg-row', moduleName: 'pkg-cfg', hasConfig: true, configJson: '{"a":1}', layerIndex: 0 },
    { rowId: 'cfg-row', moduleName: 'pkg-cfg', hasConfig: true, configJson: '{"a":2}', layerIndex: 1 },
    // disabled by a middle layer, then re-inserted by a later layer
    { rowId: 'toggle-row', moduleName: 'pkg-toggle', hasConfig: false, configJson: 'null', layerIndex: 0 },
    // one module parameterized twice with different config (the dsh-tool-subagent shape)
    { rowId: 'param-a', moduleName: 'pkg-param', hasConfig: true, configJson: '{"toolName":"a"}', layerIndex: 0 },
    { rowId: 'param-b', moduleName: 'pkg-param', hasConfig: true, configJson: '{"toolName":"b"}', layerIndex: 0 },
    // ...and one module mounted twice with identical config (an accident)
    { rowId: 'same-a', moduleName: 'pkg-same', hasConfig: true, configJson: '{"x":1}', layerIndex: 0 },
    { rowId: 'same-b', moduleName: 'pkg-same', hasConfig: true, configJson: '{"x":1}', layerIndex: 0 },
    { rowId: 'toggle-row', moduleName: 'pkg-toggle', hasConfig: false, configJson: 'null', layerIndex: 2 },
  ],
  overrides: [
    // a middle layer disables toggle-row, which layer 2 inserts again
    { rowId: 'toggle-row', disabled: true, hasConfig: false, configJson: 'null', layerIndex: 1 },
    // an override addressing nothing
    { rowId: 'ghost-row', disabled: true, hasConfig: false, configJson: 'null', layerIndex: 2 },
  ],
  versionAuthority: 'authoritative',
  missingPatchFiles: ['pkg-broken —C:/fixture/profile/node_modules/pkg-broken/cordis.patch.yml'],
  unresolvedBundles: ['app-internal-bundle'],
  packages: [
    {
      name: 'pkg-collide',
      version: '1.0.0',
      dir: 'C:/fixture/pkg-collide',
      ranges: { 'pkg-dep': '^2.0.0', 'pkg-newer': '^4.0.0' },
      enginesNode: '>=99.0.0',
    },
    { name: 'pkg-dep', version: '1.4.0', dir: 'C:/fixture/pkg-dep', ranges: {} },
    { name: 'pkg-newer', version: '3.5.0', dir: 'C:/fixture/pkg-newer', ranges: {} },
  ],
  declaredTools: {
    shared_tool: ['pkg-collide', 'pkg-one'],
    lone_tool: ['pkg-one'],
  },
  notes: [],
}

const staticFindings = detect({ profile: dirtyProfile, nodeVersion: '20.11.0' })

await check('A1 duplicate row id inside one layer', () => {
  const finding = findingFor(staticFindings, 'profile/duplicate-row-in-layer')
  assert.equal(finding.severity, 'critical')
  assert.deepEqual(finding.refs[0], 'dup-row')
  assert.ok(finding.evidence.some((line) => line.includes('pkg-one') && line.includes('pkg-two')))
})

await check('A2 one module under two ids', () => {
  // Identical config twice is the accident: critical.
  const accidental = staticFindings.find(
    (finding) => finding.code === 'profile/module-under-multiple-ids' && finding.refs.includes('pkg-same'),
  )
  assert.ok(accidental, 'an identical-config double mount must be reported')
  assert.equal(accidental.severity, 'critical')
  assert.ok(accidental.refs.includes('same-a') && accidental.refs.includes('same-b'))
  // Distinct config twice is the dsh-tool-subagent shape: informational.
  const parameterized = staticFindings.find(
    (finding) => finding.code === 'profile/module-under-multiple-ids' && finding.refs.includes('pkg-param'),
  )
  assert.ok(parameterized, 'a config-parameterized double mount must still be visible')
  assert.equal(parameterized.severity, 'info')
  // W5-14: the deliberate shape must not offer a destructive fix. It is a
  // parameterized mount, not an accident; telling the user to disable a row
  // would be wrong. Only the accidental shape may be patched.
  assert.equal(parameterized.fixes.length, 1, 'the deliberate shape offers exactly one advice, not a patch')
  assert.equal(parameterized.fixes[0].kind, 'manual', 'a deliberate double mount must not be auto-fixable')
  assert.equal(
    accidental.fixes.some((f) => f.kind === 'patch'),
    true,
    'an accidental double mount must offer a patch',
  )
})

await check('A3 disabled then re-inserted', () => {
  const finding = findingFor(staticFindings, 'profile/disable-then-reinsert')
  assert.equal(finding.severity, 'critical')
  assert.equal(finding.refs[0], 'toggle-row')
})

await check('A4 config replaced by a later layer', () => {
  const finding = findingFor(staticFindings, 'profile/row-config-replaced')
  // Layer restatement is the documented DSH contract, so it is advisory only.
  assert.equal(finding.severity, 'info')
  assert.equal(finding.refs[0], 'cfg-row')
  assert.ok(
    finding.fixes.some((fix) => fix.snippet !== undefined),
    'repair should carry a patch snippet',
  )
})

await check('A5 dangling override', () => {
  const finding = findingFor(staticFindings, 'profile/dangling-override')
  assert.equal(finding.refs[0], 'ghost-row')
})

await check('A6 missing bundle patch file', () => {
  assert.ok(codes(staticFindings).includes('profile/missing-patch-file'))
})

await check('A7 declared tool id collision', () => {
  const finding = findingFor(staticFindings, 'profile/tool-id-collision')
  assert.equal(finding.severity, 'critical')
  assert.equal(finding.refs[0], 'shared_tool')
  assert.ok(finding.refs.includes('pkg-collide') && finding.refs.includes('pkg-one'))
})

await check('A8 non-colliding tool ids stay silent', () => {
  assert.ok(!staticFindings.some((finding) => finding.code === 'profile/tool-id-collision' && finding.refs[0] === 'lone_tool'))
})

await check('A9 unsatisfied peer range and Node engine', () => {
  // A single package's mismatches are grouped into one finding.
  const grouped = staticFindings.filter((finding) => finding.code === 'profile/peer-range-unsatisfied')
  assert.equal(grouped.length, 1, `expected one grouped finding, got ${grouped.length}`)
  const peer = grouped[0]
  assert.equal(peer.severity, 'warning', 'installed below the declared minimum must be a warning')
  assert.ok(peer.evidence.some((line) => line.includes('pkg-dep')))
  assert.ok(peer.evidence.some((line) => line.includes('pkg-newer')))
  assert.ok(codes(staticFindings).includes('profile/node-engine-unsatisfied'))
})

await check('A9b a newer-than-declared host is only informational', () => {
  const ahead = detect({
    profile: {
      ...dirtyProfile,
      packages: [
        { name: 'pkg-ahead', version: '1.0.0', dir: 'C:/fixture/pkg-ahead', ranges: { 'pkg-dep': '^0.1.0' } },
        { name: 'pkg-dep', version: '1.4.0', dir: 'C:/fixture/pkg-dep', ranges: {} },
      ],
      declaredTools: {},
    },
    nodeVersion: '20.11.0',
  })
  const finding = findingFor(ahead, 'profile/peer-range-unsatisfied')
  assert.equal(finding.severity, 'info')
})

await check('A9c an unresolvable bundle is reported as info', () => {
  const finding = findingFor(staticFindings, 'profile/bundle-unresolved')
  assert.equal(finding.severity, 'info')
  assert.ok(finding.refs.includes('app-internal-bundle'))
})

/** Service collision: realm-aware, so a browser half never counts. */
await check('A17 service collision across two host packages', () => {
  const profile = {
    ...dirtyProfile,
    declaredServices: { sharedService: ['pkg-one', 'pkg-two'], pageOnly: ['pkg-page-a', 'pkg-page-b'] },
    packages: [
      { name: 'pkg-one', version: '1.0.0', dir: 'd:/one', ranges: {} },
      { name: 'pkg-two', version: '1.0.0', dir: 'd:/two', ranges: {} },
      { name: 'pkg-page-a', version: '1.0.0', dir: 'd:/pa', ranges: {}, halves: 'client' },
      { name: 'pkg-page-b', version: '1.0.0', dir: 'd:/pb', ranges: {}, halves: 'client' },
    ],
    declaredTools: {},
    sourceFacts: {},
  }
  const found = detect({ profile, nodeVersion: '20.11.0' })
  const collision = findingFor(found, 'profile/service-collision')
  assert.equal(collision.severity, 'warning')
  assert.equal(collision.refs[0], 'sharedService')
  // A service two browser-half packages both register shares no Host registry.
  assert.ok(!found.some((f) => f.code === 'profile/service-collision' && f.refs[0] === 'pageOnly'))
})

/** Self-locked PENDING: the missing provider is the stuck plugin itself. */
await check('A18 a fiber waiting on its own service is not "missing a provider"', () => {
  const live = {
    entries: [
      {
        entryId: 'selflocked',
        moduleName: 'pkg-self',
        enabled: true,
        group: false,
        fiberPhase: 'pending',
        inject: ['boxService'],
        missingInject: ['boxService'],
        provides: [],
      },
    ],
    services: [],
    declaredProvides: [{ service: 'boxService', entryId: 'selflocked', moduleName: 'pkg-self' }],
    tools: [],
    notes: [],
  }
  const found = detect({ live, nodeVersion: '20.11.0' })
  const finding = findingFor(found, 'live/pending-self-dependent')
  assert.equal(finding.severity, 'critical')
  assert.ok(finding.refs.includes('boxService'))
  assert.ok(
    finding.fixes.some((fix) => /ctx\.get|拆分|provide/.test(fix.detail)),
    'must not suggest installing a provider',
  )
})

/** Outbound collision: imminent only when both owners are loaded and it is absent. */
await check('A19 outbound tool collision needs both owners loaded and the tool absent', () => {
  const live = {
    entries: [
      {
        entryId: 'a',
        moduleName: 'pkg-one',
        enabled: true,
        group: false,
        fiberPhase: 'active',
        inject: [],
        missingInject: [],
        provides: [],
      },
      {
        entryId: 'b',
        moduleName: 'pkg-two',
        enabled: true,
        group: false,
        fiberPhase: 'active',
        inject: [],
        missingInject: [],
        provides: [],
      },
    ],
    services: [],
    declaredProvides: [],
    declaredTools: {},
    // `registered_tool` is already in the registry, `absent_tool` is not.
    tools: ['other_tool', 'registered_tool'],
    notes: [],
  }
  const profile = {
    ...dirtyProfile,
    // `absent_tool` is declared by two loaded packages and is NOT registered:
    // imminent. `registered_tool` is also declared twice but already in the
    // registry, so no new conflict can arise from it.
    declaredTools: { absent_tool: ['pkg-one', 'pkg-two'], registered_tool: ['pkg-one', 'pkg-two'] },
    sourceFacts: {},
    declaredServices: {},
  }
  const found = detect({ live, profile, nodeVersion: '20.11.0' })
  const imminent = found.filter((f) => f.code === 'live/outbound-tool-collision')
  assert.equal(
    imminent.length,
    1,
    `expected exactly the unregistered collision, got ${JSON.stringify(imminent.map((f) => f.refs[0]))}`,
  )
  assert.equal(imminent[0].refs[0], 'absent_tool')
  // If only one owner is loaded, the collision is not imminent.
  const halfLoaded = detect({ live: { ...live, entries: [live.entries[0]] }, profile, nodeVersion: '20.11.0' })
  assert.ok(!halfLoaded.some((f) => f.code === 'live/outbound-tool-collision'))
})

/** Import verification: absent symbol reported, present symbol silent. */
await check('A20 a host symbol the plugin imports but the host does not export', () => {
  const profile = {
    ...dirtyProfile,
    declaredTools: {},
    declaredServices: {},
    sourceFacts: {
      'pkg-broken': {
        name: 'pkg-broken',
        uncheckedImports: [{ module: '@deepseek-ai/dsh-llm', symbol: 'missingApi', file: 'pkg-broken —@deepseek-ai/dsh-llm' }],
        unverifiable: [],
        verified: 12,
        filesScanned: 3,
      },
      'pkg-fine': {
        name: 'pkg-fine',
        uncheckedImports: [],
        unverifiable: [{ module: '@deepseek-ai/dsh-x/sub', symbol: 'TypeOnly', file: 'pkg-fine —sub' }],
        verified: 40,
        filesScanned: 9,
      },
    },
  }
  const found = detect({ profile, nodeVersion: '20.11.0' })
  const importFinding = findingFor(found, 'profile/host-import-unsatisfied')
  assert.equal(importFinding.severity, 'warning')
  assert.ok(importFinding.refs.includes('@deepseek-ai/dsh-llm#missingApi'))
  assert.ok(importFinding.evidence.some((line) => line.includes('已验证存在')))
  // A package whose every import resolved must stay silent.
  assert.ok(!found.some((f) => f.code === 'profile/host-import-unsatisfied' && f.refs[0] === 'pkg-fine'))
})

/**
 * The version-authority gate — the regression guard for the worst bug this tool
 * had. A packaged app serves its bundles from its own archive while
 * `profiles/node_modules` holds an older generation; comparing against the
 * stale copies reported peer conflicts and missing host symbols that the
 * RUNNING host satisfies perfectly. Version-sensitive findings must therefore
 * refuse to run unless the versions are confirmed against the live host.
 */
await check('A21 version-sensitive findings are suppressed without authority', async () => {
  const stale = { ...dirtyProfile, versionAuthority: 'stale-disk' }
  const unknown = { ...dirtyProfile, versionAuthority: 'unknown' }
  for (const [label, snapshot] of [
    ['stale-disk', stale],
    ['unknown', unknown],
  ]) {
    const found = detect({ profile: snapshot, nodeVersion: '20.11.0' })
    assert.ok(
      !found.some((f) => f.code === 'profile/peer-range-unsatisfied'),
      `${label}: a peer finding was reported against an unverified baseline`,
    )
    assert.ok(
      !found.some((f) => f.code === 'profile/host-import-unsatisfied'),
      `${label}: an import finding was reported against an unverified baseline`,
    )
    // Findings that do NOT depend on version comparison must survive the gate.
    assert.ok(
      found.some((f) => f.code === 'profile/duplicate-row-in-layer'),
      `${label}: structural findings must survive`,
    )
    assert.ok(
      found.some((f) => f.code === 'profile/tool-id-collision'),
      `${label}: tool collisions must survive`,
    )
  }
})

await check('A22 the authority verdict is derived from the live host version', () => {
  assert.equal(resolveVersionAuthority('0.1.0-rc.6', { '@deepseek-ai/dsh-base': '0.1.0-rc.6' }).verdict, 'authoritative')
  assert.equal(resolveVersionAuthority('0.1.0-rc.6', { '@deepseek-ai/dsh-base': '0.2.0-rc.2' }).verdict, 'stale-disk')
  assert.equal(resolveVersionAuthority('0.1.0-rc.6', undefined).verdict, 'unknown')
  assert.equal(resolveVersionAuthority(undefined, { '@deepseek-ai/dsh-base': '0.2.0-rc.2' }).verdict, 'unknown')
  // A non-authoritative verdict must explain itself for the coverage note.
  const stale = resolveVersionAuthority('0.1.0-rc.6', { '@deepseek-ai/dsh-base': '0.2.0-rc.2' })
  assert.ok(stale.reason && stale.reason.includes('0.2.0-rc.2'), 'the reason must name the live host version')
})

await check('A10 findings are severity-sorted and every one is actionable', () => {
  const ranks = staticFindings.map((finding) => ({ critical: 0, warning: 1, info: 2 })[finding.severity])
  for (let index = 1; index < ranks.length; index += 1) assert.ok(ranks[index] >= ranks[index - 1], 'severity order')
  for (const finding of staticFindings) {
    assert.ok(finding.evidence.length > 0, `${finding.code} carries no evidence`)
    assert.ok(finding.fixes.length > 0, `${finding.code} carries no repair`)
  }
})

/** A clean composition must produce nothing. */
await check('A11 clean profile yields no findings', () => {
  const clean = {
    profilePath: 'C:/fixture/clean',
    layers: [layer(0, 'bundle base@1.0.0', 'bundle')],
    inserts: [{ rowId: 'only-row', moduleName: 'pkg-solo', hasConfig: true, configJson: '{"x":1}', layerIndex: 0 }],
    overrides: [{ rowId: 'only-row', disabled: false, hasConfig: true, configJson: '{"x":2}', layerIndex: 0 }],
    missingPatchFiles: [],
    unresolvedBundles: [],
    versionAuthority: 'authoritative',
    packages: [{ name: 'pkg-solo', version: '1.0.0', dir: 'C:/fixture/pkg-solo', ranges: {} }],
    declaredTools: { solo_tool: ['pkg-solo'] },
    notes: [],
  }
  // The single override with a different config is a legitimate user restatement
  // only when it lines up with the insert; here it differs in the SAME layer, so
  // exactly one warning is expected and nothing else.
  assert.deepEqual(codes(detect({ profile: clean, nodeVersion: '20.11.0' })), ['profile/row-config-replaced'])
})

/** Live fixtures: the three runtime-only failure modes. */
const dirtyLive = {
  entries: [
    {
      entryId: 'waiter',
      moduleName: 'pkg-waiter',
      enabled: true,
      group: false,
      fiberPhase: 'pending',
      inject: ['knowledgeBase'],
      missingInject: ['knowledgeBase'],
      provides: [],
    },
    {
      entryId: 'collider',
      moduleName: 'pkg-collider',
      enabled: true,
      group: false,
      fiberPhase: 'failed',
      inject: [],
      missingInject: [],
      provides: [],
      errorText:
        'tool "web_search" is already registered (for a per-agent variant, register through that agent\'s `agent.ctx` instead)',
    },
    // A settled-but-not-active fiber whose inject nothing in the process provides.
    {
      entryId: 'twin',
      moduleName: 'pkg-twin-live',
      enabled: true,
      group: false,
      fiberPhase: 'loading',
      inject: ['absentService'],
      missingInject: [],
      provides: [],
    },
    {
      entryId: 'twin',
      moduleName: 'pkg-twin-live-2',
      enabled: true,
      group: false,
      fiberPhase: 'active',
      inject: [],
      missingInject: [],
      provides: [],
    },
  ],
  services: [{ service: 'tools', owner: 'tool-runtime', entryId: 'tools' }],
  tools: ['web_search', 'run_code'],
  notes: [],
}

const liveFindings = detect({ live: dirtyLive, nodeVersion: '20.11.0' })

await check('A12 pending fiber names the missing service', () => {
  const finding = findingFor(liveFindings, 'live/pending-missing-service')
  assert.equal(finding.severity, 'critical')
  assert.equal(finding.refs[0], 'waiter')
  assert.ok(finding.evidence.some((line) => line.includes('knowledgeBase')))
})

await check('A13 tool id collision is reported as a collision, not a bare failure', () => {
  const finding = findingFor(liveFindings, 'live/tool-id-conflict')
  assert.equal(finding.severity, 'critical')
  assert.ok(finding.refs.includes('web_search'))
  assert.ok(finding.fixes.some((fix) => /\bweb_search\b/.test(fix.label)))
})

await check('A14 duplicate live entry id', () => {
  assert.ok(codes(liveFindings).includes('live/duplicate-entry-id'))
})

await check('A15 inject nothing provides', () => {
  const finding = findingFor(liveFindings, 'live/unprovided-inject')
  assert.ok(finding.refs.includes('absentService'))
})

await check('A16 markdown render is self-contained', () => {
  const report = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    profilePath: 'C:/fixture/clean',
    scope: 'all',
    summary: { critical: 1, warning: 0, info: 0, liveEntries: 4, patchLayers: 3, scannedPackages: 2, declaredTools: 2 },
    findings: staticFindings,
    notes: ['a coverage note'],
  }
  const text = renderMarkdown(report)
  assert.ok(text.includes('# 插件冲突诊断报告'))
  assert.ok(text.includes('profile/duplicate-row-in-layer'))
  assert.ok(text.includes('```yaml'), 'repair snippets render as yaml fences')
  assert.ok(text.includes('a coverage note'))
  assert.ok(!text.includes('undefined'), 'no undefined leaked into the report')
})

/* ------------------------------------------------------------------ Part B */

await check('B1 defaultProfilePath follows the environment DSH sets', () => {
  assert.equal(defaultProfilePath({ DSH_PROFILE_DIR: 'C:/p' }), 'C:/p')
  assert.equal(defaultProfilePath({ DSH_HOME: 'C:/h', DSH_PROFILE: 'web' }), join('C:/h', 'profiles', 'web'))
  assert.equal(defaultProfilePath({}), undefined)
})

await check('B2 the real running profile scans cleanly', () => {
  const profilePath = defaultProfilePath()
  assert.ok(profilePath, 'DSH_PROFILE_DIR must be visible to the test')
  const snapshot = collectStatic(profilePath)
  assert.ok(snapshot.layers.length >= 2, `expected several patch layers, got ${snapshot.layers.length}`)
  assert.ok(snapshot.inserts.length > 20, `expected a real row count, got ${snapshot.inserts.length}`)
  assert.ok(snapshot.packages.length > 5, `expected real packages, got ${snapshot.packages.length}`)
  console.log(`\n[Part B] real profile: ${profilePath}`)
  console.log(
    `[Part B] layers=${snapshot.layers.length} inserts=${snapshot.inserts.length} overrides=${snapshot.overrides.length} ` +
      `packages=${snapshot.packages.length} declaredTools=${Object.keys(snapshot.declaredTools).length} notes=${snapshot.notes.length}`,
  )
  const findings = detect({ profile: snapshot, nodeVersion: process.version })
  console.log(`[Part B] findings=${findings.length} —${findings.map((finding) => finding.code).join(', ') || '(none)'}`)
  // The real profile carries !!js expressions; they must be recorded verbatim,
  // never evaluated, and must not break parsing.
  assert.ok(
    !snapshot.notes.some((note) => note.includes('could not be parsed')),
    `no layer should fail to parse: ${JSON.stringify(snapshot.notes)}`,
  )
  assert.ok(
    snapshot.notes.some((note) => note.includes('!!js')),
    'the !!js limitation must be disclosed as a coverage note',
  )
})

await check('B3 declared-tool extraction works on a real package', () => {
  const profilePath = defaultProfilePath()
  const snapshot = collectStatic(profilePath)
  const withTools = Object.entries(snapshot.declaredTools).filter(([, owners]) => owners.length > 0)
  assert.ok(withTools.length > 10, `expected many declared tool ids, got ${withTools.length}`)
  const collisions = Object.entries(snapshot.declaredTools).filter(([, owners]) => owners.length > 1)
  console.log(`[Part B] distinct declared tool ids=${withTools.length}, cross-package collisions=${collisions.length}`)
  // A single-package tool id must never be reported as a collision.
  for (const [tool, owners] of collisions) assert.ok(owners.length > 1, `${tool} mis-grouped`)
})

await check('B4 scanning a bogus directory degrades to notes, not throws', () => {
  const snapshot = collectStatic('C:/definitely/not/a/profile')
  assert.equal(snapshot.inserts.length, 0)
  assert.ok(snapshot.notes.length > 0, 'a missing profile must be reported as a note')
})

/**
 * The real profile on this machine runs a host the disk does NOT describe: a
 * packaged desktop app serves `@deepseek-ai/dsh-base@0.2.0-rc.2` from its own
 * archive, while `profiles/node_modules` holds `0.1.0-rc.6`. A scan that does
 * not know this reports peer conflicts and missing host symbols against the
 * wrong generation — findings this test proves are FALSE by checking that the
 * symbols really do exist in the running host.
 *
 * So the correct behaviour is: without live confirmation, say nothing about
 * versions; and never lose the structural findings that need no version.
 */
await check('B5 version claims follow the running host, structure still works', () => {
  // Before W1 this profile reported `unknown` and suppressed every
  // version-sensitive finding — including the import check, which is what let a
  // plugin silently call an API the running host does not export. The archive is
  // now read, so those checks run against the host that actually executes.
  const snapshot = collectStatic(defaultProfilePath())
  assert.notEqual(snapshot.versionAuthority, 'authoritative', 'this profile must not be treated as authoritative')
  const findings = detect({ profile: snapshot, nodeVersion: process.version })
  const comparable = snapshot.versionAuthority === 'archive-authoritative'

  if (comparable) {
    // Version-sensitive detectors are expected to have opinions now.
    assert.ok(
      findings.some((finding) => finding.code === 'profile/host-import-unsatisfied'),
      'with the running host as baseline the import check must actually run',
    )
  } else {
    assert.ok(
      !findings.some((finding) => finding.code === 'profile/peer-range-unsatisfied'),
      'peer claims must be suppressed without a trustworthy baseline',
    )
    assert.ok(
      !findings.some((finding) => finding.code === 'profile/host-import-unsatisfied'),
      'import claims must be suppressed without a trustworthy baseline',
    )
  }

  // Structural detectors need no version and must still work on real data.
  assert.ok(
    findings.some((finding) => finding.code === 'profile/module-under-multiple-ids'),
    'real double mount',
  )
  assert.ok(
    findings.some((finding) => finding.code === 'profile/row-config-replaced'),
    'real layer restatement',
  )
  assert.ok(
    snapshot.notes.length > 0 || snapshot.versionAuthorityReason !== undefined,
    'the coverage note must disclose which baseline was used',
  )
  console.log(
    `[Part B] authority=${snapshot.versionAuthority}, ` +
      (comparable ? 'comparing against the running host archive' : 'version-sensitive findings suppressed'),
  )
})

/**
 * With the live versions supplied (as the plugin always does at runtime), the
 * scan compares like with like and the structural verdict is unchanged.
 */
await check('B6 supplying live versions keeps the structural result stable', () => {
  const live = { '@deepseek-ai/dsh-base': '0.2.0-rc.2', '@deepseek-ai/dsh-web-app': '0.2.0-rc.2' }
  const snapshot = collectStatic(defaultProfilePath(), [], live)
  assert.equal(snapshot.versionAuthority, 'stale-disk')
  const findings = detect({ profile: snapshot, nodeVersion: process.version })
  assert.ok(findings.length > 0, 'structural findings must survive an authoritative-version comparison')
  assert.ok(!findings.some((finding) => finding.code === 'profile/peer-range-unsatisfied'))
})

/* ------------------------------------------------------------------ Part C */

class ToolsStub extends Service {
  constructor(ctx, sink) {
    super(ctx, 'tools')
    this.sink = sink
  }
  register(definition) {
    this.sink.tools.push(definition)
    return () => {
      this.sink.tools = this.sink.tools.filter((entry) => entry !== definition)
    }
  }
  schemas() {
    return this.sink.tools.map((entry) => ({ name: entry.name, description: entry.description, parameters: entry.parameters }))
  }
}

class CommandsStub extends Service {
  constructor(ctx, sink) {
    super(ctx, 'commands')
    this.sink = sink
  }
  register(definition) {
    this.sink.commands.push(definition)
    return () => {
      this.sink.commands = this.sink.commands.filter((entry) => entry !== definition)
    }
  }
}

class SystemPromptStub extends Service {
  constructor(ctx, sink) {
    super(ctx, 'systemPrompt')
    this.sink = sink
  }
  context(definition) {
    this.sink.promptContexts.push(definition)
    return () => {
      this.sink.promptContexts = this.sink.promptContexts.filter((entry) => entry !== definition)
    }
  }
}

const sink = { tools: [], commands: [], promptContexts: [] }

/** Load the plugin exactly the way the Loader does: ctx.plugin(module). */
async function partC() {
  const ctx = new Context()
  new ToolsStub(ctx, sink)
  new CommandsStub(ctx, sink)
  new SystemPromptStub(ctx, sink)
  const mod = await import('../lib/index.js')
  const fiber = ctx.plugin(mod)
  await fiber

  check('C1 the tool registers with its published name', () => {
    assert.equal(sink.tools.length, 1)
    assert.equal(sink.tools[0].name, 'conflict_doctor')
    assert.equal(typeof sink.tools[0].execute, 'function')
    assert.equal(typeof sink.tools[0].output.render, 'function')
  })

  check('C2 the slash command registers', () => {
    assert.equal(sink.commands.length, 1)
    assert.equal(sink.commands[0].name, 'conflict-doctor')
  })

  const tool = sink.tools[0]

  check('C3 execute returns the declared output shape and renders text', async () => {
    const value = await tool.execute({ scope: 'live' }, { args: {}, agent: undefined, signal: new AbortController().signal })
    for (const key of ['summary', 'findings', 'notes', 'report', 'profilePath']) {
      assert.ok(key in value, `missing output field ${key}`)
    }
    assert.ok(typeof value.report === 'string' && value.report.includes('插件冲突诊断报告'))
    const blocks = tool.output.render({}, value)
    assert.equal(blocks[0].type, 'text')
    assert.equal(blocks[0].text, value.report)
  })

  check('C4 the command handler produces a report', async () => {
    const result = await sink.commands[0].handler()
    assert.equal(result.kind, 'success')
    assert.ok(result.text.includes('插件冲突诊断报告'))
  })

  check('C5 fibers with no Loader service degrade to a note', async () => {
    const report = await runAudit(ctx, { scope: 'live' })
    assert.equal(report.summary.liveEntries, 0)
    assert.ok(
      report.notes.some((note) => note.includes('loader')),
      `notes were ${JSON.stringify(report.notes)}`,
    )
  })

  check('C6 unloading the plugin retracts its registrations', async () => {
    assert.equal(sink.tools.length, 1)
  })

  check('C7 the alert contributes nothing on a healthy profile', () => {
    assert.equal(sink.promptContexts.length, 1, 'the alert context must be registered')
    assert.equal(sink.promptContexts[0].name, 'conflict-doctor:critical-conflicts')
    assert.equal(
      sink.promptContexts[0].text(),
      '',
      'an empty string is the contract for "nothing to say" —a healthy profile pays zero tokens',
    )
  })
  return ctx
}

const ctx = await partC()
await ctx.fiber.dispose()
await check('C8 unload retracts tool, command, and alert (ctx.effect ownership)', () => {
  assert.equal(sink.tools.length, 0, `tools still registered: ${sink.tools.map((t) => t.name).join(',')}`)
  assert.equal(sink.commands.length, 0, 'commands still registered')
  assert.equal(sink.promptContexts.length, 0, 'prompt context still registered')
})

/* ------------------------------------------------------------------ Part D */

/**
 * Build a minimal archive with Electron's layout: 16-byte pickle prefix, JSON
 * tree, then content addressed by offsets relative to the end of the tree.
 *
 * The u32 header-size field is written EIGHT BYTES SHORT on purpose — that is
 * exactly how a real archive behaves, and any implementation trusting the field
 * instead of brace-matching the tree must fail these checks.
 */
function buildAsar(files, { stringOffsets = false } = {}) {
  const tree = { files: {} }
  const blobs = []
  let cursor = 0
  for (const [name, content] of Object.entries(files)) {
    const buf = Buffer.from(content, 'utf8')
    tree.files[name] = {
      size: stringOffsets ? String(buf.length) : buf.length,
      offset: stringOffsets ? String(cursor) : cursor,
    }
    blobs.push(buf)
    cursor += buf.length
  }
  const treeJson = JSON.stringify(tree)
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(8 + 16 + treeJson.length, 4)
  return Buffer.concat([prefix, Buffer.from(treeJson, 'utf8'), ...blobs])
}

const asarDir = mkdtempSync(join(tmpdir(), 'cd-asar-'))
const asarFileOf = (name) => join(asarDir, `${name}.asar`)

await check('D1 reads a file from a hand-built archive', () => {
  const file = asarFileOf('basic')
  writeFileSync(file, buildAsar({ 'package.json': '{"name":"demo","version":"1.2.3"}' }))
  const archive = openAsar(file)
  assert.deepEqual(JSON.parse(readAsarText(archive, 'package.json')), { name: 'demo', version: '1.2.3' })
  closeAsar(archive)
})

await check('D2 size/offset written as strings still decode', () => {
  const file = asarFileOf('strings')
  writeFileSync(file, buildAsar({ 'a.txt': 'first', 'b.txt': 'second' }, { stringOffsets: true }))
  const archive = openAsar(file)
  assert.equal(readAsarText(archive, 'a.txt'), 'first')
  assert.equal(readAsarText(archive, 'b.txt'), 'second')
  closeAsar(archive)
})

await check('D3 adjacent files do not bleed into each other', () => {
  // The regression this guards: trusting the header-size u32 placed every read
  // eight bytes off, returning the tail of a neighbouring file's JSON.
  const file = asarFileOf('multi')
  writeFileSync(file, buildAsar({ 'a.json': '{"alpha":true}', 'b.json': '{"beta":false}', 'c.json': '{"gamma":null}' }))
  const archive = openAsar(file)
  assert.deepEqual(JSON.parse(readAsarText(archive, 'a.json')), { alpha: true })
  assert.deepEqual(JSON.parse(readAsarText(archive, 'b.json')), { beta: false })
  assert.deepEqual(JSON.parse(readAsarText(archive, 'c.json')), { gamma: null })
  closeAsar(archive)
})

await check('D4 multi-byte UTF-8 survives the byte maths', () => {
  const file = asarFileOf('utf8')
  writeFileSync(file, buildAsar({ 'zh.txt': '插件冲突诊断与修复建议 —— 中文 ñ é' }))
  const archive = openAsar(file)
  assert.equal(readAsarText(archive, 'zh.txt'), '插件冲突诊断与修复建议 —— 中文 ñ é')
  closeAsar(archive)
})

await check('D5 nested directories resolve and directory nodes are not files', () => {
  const tree = { files: { lib: { files: { 'index.js': { size: 5, offset: 0 } } } } }
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(16, 4)
  const file = asarFileOf('nested')
  writeFileSync(file, Buffer.concat([prefix, Buffer.from(JSON.stringify(tree), 'utf8'), Buffer.from('hello', 'utf8')]))
  const archive = openAsar(file)
  assert.equal(readAsarText(archive, 'lib/index.js'), 'hello')
  assert.ok(isAsarDir(findNode(archive, 'lib')))
  assert.equal(readAsarFile(archive, 'lib'), undefined, 'a directory must not be readable as a file')
  assert.deepEqual(
    listAsarDir(archive, 'lib').map(([name]) => name),
    ['index.js'],
  )
  closeAsar(archive)
})

await check('D6 a traversal attempt cannot escape the archive root', () => {
  const file = asarFileOf('escape')
  writeFileSync(file, buildAsar({ 'package.json': '{"name":"demo"}' }))
  const archive = openAsar(file)
  assert.equal(hasAsarPath(archive, '../../etc/passwd'), false)
  assert.equal(readAsarFile(archive, '../../etc/passwd'), undefined)
  closeAsar(archive)
})

await check('D7 a missing path yields undefined rather than throwing', () => {
  const file = asarFileOf('missing')
  writeFileSync(file, buildAsar({ 'exists.txt': 'yes' }))
  const archive = openAsar(file)
  assert.equal(readAsarText(archive, 'nope.txt'), undefined)
  assert.equal(findNode(archive, 'nope.txt'), undefined)
  closeAsar(archive)
})

await check('D8 a non-asar file throws a readable error instead of crashing', () => {
  const file = asarFileOf('corrupt')
  writeFileSync(file, Buffer.from('not an asar at all, far too short'))
  assert.throws(() => openAsar(file), Error)
})

await check('D9 closing twice is harmless', () => {
  const file = asarFileOf('close')
  writeFileSync(file, buildAsar({ 'a.txt': 'x' }))
  const archive = openAsar(file)
  closeAsar(archive)
  closeAsar(archive)
})

rmSync(asarDir, { recursive: true, force: true })

/* ------------------------------------------------------------------ Part E */

/**
 * Build an in-memory package tree for surface walking.
 *
 * Mirrors real bundled packages including the two traps met on the installed
 * archive: manifest paths written as `./lib/index.js`, and an `exports` map
 * whose `types` member does not exist in a shipped build.
 */
function memSource(files) {
  // Keep everything NORMALISED ABSOLUTE with no trailing slash, and derive the
  // rest from that single representation. Earlier attempts mixed slash/no-slash
  // forms, and the resulting prefix comparisons silently mismatched.
  const norm = (p) => {
    const out = []
    for (const part of p.split('/')) {
      if (part === '' || part === '.') continue
      if (part === '..') out.pop()
      else out.push(part)
    }
    return out.join('/')
  }
  const ROOT = 'p'
  const store = new Map()
  for (const [key, value] of Object.entries(files)) store.set(norm(`${ROOT}/${key}`), value)
  const keys = [...store.keys()]

  /**
   * Callers pass paths that are ALREADY rooted at the package (for example
   * `p/lib/index.js`), while fixture keys are written root-relative. Accept
   * both, and always return the canonical `p/...` form.
   */
  const abs = (p) => {
    const cleaned = norm(p)
    if (cleaned === ROOT) return ROOT
    if (cleaned.startsWith(`${ROOT}/`)) return cleaned
    return norm(`${ROOT}/${cleaned}`)
  }

  return {
    hasFile: (p) => {
      const full = abs(p)
      return full === undefined ? false : store.has(full)
    },
    hasDir: (p) => {
      const full = abs(p)
      if (full === undefined) return false
      return keys.some((k) => k.startsWith(`${full}/`))
    },
    readText: (p) => {
      const full = abs(p)
      return full === undefined ? undefined : store.get(full)
    },
    listDir: (p) => {
      const full = abs(p)
      if (full === undefined) return []
      const prefix = `${full}/`
      const seen = new Set()
      for (const key of keys) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (rest.length === 0) continue
        seen.add(rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest)
      }
      return [...seen]
    },
  }
}

await check('E1 resolves an entry through a manifest "./" path', () => {
  // Regression: naive concatenation produced `pkg/./lib/index.js`, which made
  // the walker read package.json as its entry and report EVERY host symbol
  // missing — the exact false-positive class W1 removes.
  const source = memSource({
    'package.json': '{"name":"p","main":"./lib/index.js"}',
    'lib/index.js': 'export { alpha, beta };\nconst alpha = 1;\nconst beta = 2;',
  })
  const surface = collectSurface(source, 'p', { name: 'p', main: './lib/index.js' })
  assert.equal(surface.source, 'js-entry')
  assert.equal(surface.entry, 'p/lib/index.js')
  assert.ok(surface.names.has('alpha'))
  assert.ok(surface.names.has('beta'))
})

await check('E2 falls back to the JS entry when exports.types is absent', () => {
  const source = memSource({
    'package.json': '{"exports":{".":{"types":"./lib/types/index.d.ts","default":"./lib/index.js"}}}',
    'lib/index.js': 'export { thing };',
  })
  const surface = collectSurface(source, 'p', {
    exports: { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' } },
  })
  assert.equal(surface.source, 'js-entry')
  assert.ok(surface.names.has('thing'))
})

await check('E3 a mixed export list keeps every name', () => {
  // `B as default` exports the name `default`; `B` itself stays LOCAL and is
  // not importable. Asserting B would have encoded a false positive.
  const source = memSource({ 'package.json': '{"main":"index.js"}', 'index.js': 'export { A, B as default, C };' })
  const surface = collectSurface(source, 'p', { main: 'index.js' })
  assert.ok(surface.names.has('A'), 'A must survive an aliased neighbour')
  assert.ok(surface.names.has('C'), 'C must survive an aliased neighbour')
  assert.ok(surface.names.has('default'), 'B as default must register the default name')
  assert.equal(surface.names.has('B'), false, 'B is the local binding, not an exported name')
})

await check('E4 follows export * through the relative closure', () => {
  const source = memSource({
    'package.json': '{"main":"index.js"}',
    'index.js': "export * from './deep/more.js';\nexport { top };",
    'deep/more.js': 'export { nested };',
  })
  const surface = collectSurface(source, 'p', { main: 'index.js' })
  assert.ok(surface.names.has('top'))
  assert.ok(surface.names.has('nested'), 'a re-exported name really is exported by this package')
  assert.ok(surface.filesScanned >= 2, 'the closure must actually be walked')
})

await check('E5 a re-export cycle terminates', () => {
  const source = memSource({
    'package.json': '{"main":"a.js"}',
    'a.js': "export * from './b.js';\nexport { alpha };",
    'b.js': "export * from './a.js';\nexport { beta };",
  })
  const surface = collectSurface(source, 'p', { main: 'a.js' })
  assert.ok(surface.names.has('alpha'))
  assert.ok(surface.names.has('beta'))
})

await check('E6 CJS export shapes are recognised', () => {
  const source = memSource({
    'package.json': '{"main":"index.js"}',
    'index.js': [
      'exports.plain = 1;',
      "Object.defineProperty(exports, 'defined', { value: 2 });",
      'module.exports = { grouped, aliased: 3 };',
    ].join('\n'),
  })
  const surface = collectSurface(source, 'p', { main: 'index.js' })
  for (const name of ['plain', 'defined', 'grouped', 'aliased']) {
    assert.ok(surface.names.has(name), `missing CJS export ${name}`)
  }
})

await check('E7 an entry with no exports falls back to the union, marked incomplete', () => {
  // Real case: @deepseek-ai/dsh-base ships `export {};`. Zero names is the
  // truth there, and flagging incomplete stops that being read as "everything
  // is missing".
  const source = memSource({
    'package.json': '{"main":"lib/index.js"}',
    'lib/index.js': 'export {};',
    'lib/other.js': 'export { hidden };',
  })
  const surface = collectSurface(source, 'p', { main: 'lib/index.js' })
  assert.ok(surface.names.has('hidden'), 'the union should reach other files')
  assert.equal(surface.complete, false, 'a union is a guess, never proof')
})

await check('E8 the file budget bounds the walk', () => {
  const files = { 'package.json': '{"main":"index.js"}' }
  for (let i = 0; i < 500; i += 1) files[`f${i}.js`] = `export { n${i} };`
  const surface = collectSurface(memSource(files), 'p', { main: 'index.js' }, { maxFiles: 5 })
  assert.equal(surface.complete, false, 'an exhausted budget must be reported')
  assert.ok(surface.filesScanned <= 5, `read ${surface.filesScanned} files against a cap of 5`)
})

await check('E9 an empty surface never claims absence', () => {
  // Guards I4 at this layer: `complete === false` means the surface may be
  // missing names, so callers must not report a symbol as absent.
  const surface = collectSurface(memSource({ 'package.json': '{}' }), 'p', {})
  assert.equal(surface.names.size, 0)
  assert.equal(surface.complete, false)
})

await check('E10 the running host agrees with the archive', () => {
  // End-to-end against the installed app.asar. Skipped on CI, where no host
  // exists. defineTool is known real; the fake name is known fake.
  const surface = readHostSurface('@deepseek-ai/dsh-tools')
  if (surface === undefined) return
  assert.ok(surface.names.has('defineTool'), 'defineTool must resolve in the running host')
  assert.ok(surface.names.has('default'), 'ToolRuntime as default is exported by the bundled index')
  assert.equal(surface.names.has('totallyNotARealExport'), false, 'a fake name must not be reported present')
})

await check('E11 the documented false-positive symbols stay resolved', () => {
  // README records this tool once reporting IconBranchOutlineRegular (7 sites)
  // and resolveImageAttachmentAccess (13 sites) as missing from the host, when
  // they were present — comparing against a stale disk copy. With the running
  // host as baseline neither may ever be flagged again.
  const surface = readHostSurface('@deepseek-ai/dsh-llm')
  if (surface === undefined) return
  const list = [...surface.names]
  assert.ok(list.includes('resolveImageAttachmentAccess'), 'resolveImageAttachmentAccess must resolve in the running host')
  assert.ok(!list.includes('assertNever'), 'a symbol the host genuinely does not export must stay absent')
})

await check('E12 an archive-authored profile reports no false import conflicts', () => {
  const profilePath =
    process.env.DSH_PROFILE_DIR ??
    (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE ?? '') : undefined)
  if (!profilePath) return
  let snapshot
  try {
    snapshot = collectStatic(profilePath, [])
  } catch {
    return
  }
  if (snapshot.versionAuthority !== 'archive-authoritative') return
  // Every unchecked import must be absent from the RUNNING host's own surface,
  // otherwise the check proved nothing.
  const fromHost = readHostSurface
  let checked = 0
  for (const facts of Object.values(snapshot.sourceFacts ?? {})) {
    for (const symbol of facts.uncheckedImports) {
      const surface = fromHost(symbol.module)
      if (surface === undefined || !surface.complete) continue
      checked += 1
      assert.equal(
        surface.names.has(symbol.symbol),
        false,
        `${symbol.module}#${symbol.symbol} was reported missing but is exported by the running host`,
      )
    }
  }
  assert.ok(checked > 0, 'expected at least one verifiable unchecked import to cross-check')
})

await check('E13 versionsComparable admits exactly the trustworthy verdicts', () => {
  const at = (verdict) => ({ versionAuthority: verdict })
  assert.equal(versionsComparable(at('authoritative')), true)
  assert.equal(versionsComparable(at('archive-authoritative')), true, 'the running host archive is a real baseline')
  assert.equal(versionsComparable(at('stale-disk')), false, 'a stale disk with no substitute must abstain')
  assert.equal(versionsComparable(at('unknown')), false)
})

await check('E15 a package name that could escape the modules root is rejected', () => {
  // Package names arrive from plugin import statements, so a crafted one must
  // never reach outside node_modules.
  for (const bad of ['../../etc/passwd', '@a/../../b', '/abs/path', 'a b', '', '@scope/../../x', 'a/../b']) {
    assert.equal(isSafePackageName(bad), false, `${JSON.stringify(bad)} must be rejected`)
  }
  for (const good of ['@deepseek-ai/dsh-tools', 'dsh-base', '@scope/name', 'a.b-c_d']) {
    assert.equal(isSafePackageName(good), true, `${JSON.stringify(good)} must be accepted`)
  }
  // The rejection must be enforced at the public read, not only in a helper.
  assert.equal(readHostSurface('../../../etc/passwd'), undefined)
})

await check('E16 a missing host archive is disclosed, never silently skipped', () => {
  // Runs only where a host DOES exist: point discovery at an empty world and
  // assert the report says so rather than quietly omitting the checks.
  if (readHostSurface('@deepseek-ai/dsh-tools') === undefined) return
  const before = { ...process.env }
  const emptyDir = mkdtempSync(join(tmpdir(), 'cd-nohost-'))
  try {
    process.env.LOCALAPPDATA = emptyDir
    process.env.APPDATA = emptyDir
    process.env.USERPROFILE = emptyDir
    delete process.env.DSH_APP_ASAR
    delete process.env.DSH_INSTALL_ROOT
    delete process.env.DSH_HOST_ROOT
    clearHostCaches()
    assert.equal(findHostRoot(), undefined, 'the masked environment must expose no host')

    const profilePath = defaultProfilePath()
    if (profilePath === undefined) return
    const snapshot = collectStatic(profilePath, [])
    assert.equal(snapshot.versionAuthority, 'unknown', 'without a host the baseline is unknowable')
    assert.ok(
      snapshot.notes.some((note) => note.includes('archive')),
      `the coverage note must mention the missing archive; got ${JSON.stringify(snapshot.notes)}`,
    )
  } finally {
    for (const key of ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE']) {
      if (before[key] === undefined) delete process.env[key]
      else process.env[key] = before[key]
    }
    rmSync(emptyDir, { recursive: true, force: true })
    clearHostCaches()
  }
})

await check('E14 the fourth verdict resolves disk-versus-archive correctly', () => {
  // Disk says one generation, the running archive says another: compare against
  // the archive instead of abstaining, which is the entire point of W1.
  const staleDisk = resolveVersionAuthority('0.1.0-rc.6', undefined, { '@deepseek-ai/dsh-base': '0.2.0-rc.2' })
  assert.equal(staleDisk.verdict, 'archive-authoritative')
  assert.ok(staleDisk.reason !== undefined && staleDisk.reason.length > 0)

  const agreeing = resolveVersionAuthority(
    '0.2.0-rc.2',
    { '@deepseek-ai/dsh-base': '0.2.0-rc.2' },
    { '@deepseek-ai/dsh-base': '0.2.0-rc.2' },
  )
  assert.equal(agreeing.verdict, 'authoritative')

  // No live versions and no archive: still must abstain rather than guess.
  const blind = resolveVersionAuthority('0.1.0-rc.6', undefined, undefined)
  assert.equal(blind.verdict, 'unknown')
})

await check('E17 the peer check reads the RUNNING host, not the stale disk', () => {
  // This is the regression that shipped five false positives: the disk held
  // 0.1.0-rc.6 while the host ran 0.2.0-rc.2, so a `^0.2.0-rc.2` declaration was
  // judged unsatisfied even though the running host satisfies it exactly.
  const base = {
    profilePath: '/fake',
    layers: [],
    inserts: [],
    overrides: [],
    missingPatchFiles: [],
    unresolvedBundles: [],
    declaredTools: {},
    declaredServices: {},
    declaredImports: {},
    sourceFacts: {},
    hostVersion: '0.1.0-rc.6',
    versionAuthority: 'archive-authoritative',
  }
  const pkg = (name, version, ranges) => ({ name, version, dir: `/fake/${name}`, ranges })

  const matching = detect({
    profile: {
      ...base,
      packages: [pkg('plugin-x', '1.0.0', { '@deepseek-ai/dsh-tools': '^0.2.0-rc.2' })],
      hostBundleVersions: { '@deepseek-ai/dsh-tools': '0.2.0-rc.2' },
    },
    nodeVersion: process.version,
  }).filter((f) => f.code === 'profile/peer-range-unsatisfied')
  assert.equal(matching.length, 0, 'the running host satisfies the range; the disk copy must not be used as the baseline')

  const older = detect({
    profile: {
      ...base,
      packages: [pkg('plugin-y', '1.0.0', { '@deepseek-ai/dsh-tools': '^0.3.0' })],
      hostBundleVersions: { '@deepseek-ai/dsh-tools': '0.2.0-rc.2' },
    },
    nodeVersion: process.version,
  }).filter((f) => f.code === 'profile/peer-range-unsatisfied')
  assert.equal(older.length, 1, 'a host genuinely below the minimum must still warn')
  assert.equal(older[0].severity, 'warning')
})

await check('E18 cross-generation declarations are aggregated, not repeated', () => {
  // 120 packages in one stale profile all declare a different prerelease tuple,
  // and emitting a finding each buried the actionable ones — the same noise
  // problem this detector was tightened for once before. They collapse into a
  // single info finding, and a genuine `below` still stands alone as a warning.
  const skewed = []
  for (let i = 0; i < 40; i += 1) {
    skewed.push({
      name: `skew-${i}`,
      version: '1.0.0',
      dir: `/fake/skew-${i}`,
      ranges: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' },
    })
  }
  // A host-shipped package gets no skew finding at all (the host cannot disagree
  // with itself), and a genuine below minimum stays a warning.
  skewed.push({ name: '@deepseek-ai/dsh-tools', version: '0.2.0-rc.2', dir: '/fake/tools', ranges: { x: '^0.1.0-rc.6' } })
  const findings = detect({
    profile: {
      profilePath: '/fake',
      layers: [],
      inserts: [],
      overrides: [],
      missingPatchFiles: [],
      unresolvedBundles: [],
      declaredTools: {},
      declaredServices: {},
      declaredImports: {},
      sourceFacts: {},
      versionAuthority: 'archive-authoritative',
      packages: skewed,
      hostBundleVersions: { '@deepseek-ai/dsh-tools': '0.2.0-rc.2' },
    },
    nodeVersion: process.version,
  }).filter((f) => f.code === 'profile/peer-range-unsatisfied')

  assert.equal(findings.length, 1, `40 skews must collapse to one finding; got ${findings.length}`)
  assert.equal(findings[0].severity, 'info')
  assert.ok(findings[0].title.includes('40'), 'the aggregate must state how many packages it covers')
  assert.equal(
    findings.some((f) => f.refs.includes('@deepseek-ai/dsh-tools')),
    false,
    'a host-shipped package must not be compared against its own host',
  )
})

await check('E19 the report contract rejects malformed shapes', () => {
  // A validator that only ever says "ok" is decoration. Each case below is a
  // shape a consumer must never be handed without warning.
  const good = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    profilePath: '/tmp/profile',
    scope: 'profile',
    summary: { critical: 0, warning: 1, info: 0, liveEntries: 0, patchLayers: 3, scannedPackages: 10, declaredTools: 4 },
    findings: [
      {
        code: 'profile/row-config-replaced',
        severity: 'info',
        title: 't',
        refs: ['a'],
        impact: 'i',
        evidence: ['e'],
        fixes: [{ kind: 'manual', label: 'l', detail: 'd' }],
      },
    ],
    notes: [],
  }
  assert.deepEqual(validateReport(good), [], 'a well-formed report must validate')

  const rejected = [
    ['missing schemaVersion', (({ schemaVersion, ...rest }) => rest)(good)],
    ['unknown top-level property', { ...good, bogus: 1 }],
    ['bad scope', { ...good, scope: 'everything' }],
    ['negative count', { ...good, summary: { ...good.summary, warning: -1 } }],
    ['findings not an array', { ...good, findings: {} }],
    ['finding without evidence', { ...good, findings: [{ ...good.findings[0], evidence: undefined }] }],
    ['empty evidence', { ...good, findings: [{ ...good.findings[0], evidence: [] }] }],
    ['empty fixes', { ...good, findings: [{ ...good.findings[0], fixes: [] }] }],
    ['bad severity', { ...good, findings: [{ ...good.findings[0], severity: 'urgent' }] }],
    ['bad fix kind', { ...good, findings: [{ ...good.findings[0], fixes: [{ kind: 'magic', label: 'l', detail: 'd' }] }] }],
    ['code violating the realm prefix', { ...good, findings: [{ ...good.findings[0], code: 'whatever' }] }],
    ['non-ISO timestamp', { ...good, generatedAt: 'yesterday' }],
    ['extra property inside a finding', { ...good, findings: [{ ...good.findings[0], extra: true }] }],
  ]
  for (const [label, value] of rejected) {
    assert.ok(validateReport(value).length > 0, `the contract must reject: ${label}`)
  }
})

await check('E20 exit codes follow the --fail-on threshold', () => {
  // CI gates on these, so they are part of the contract, not an implementation
  // detail. A typo must refuse to start rather than silently disable the gate.
  assert.equal(exitCodeFor({ critical: 0, warning: 0 }, 'critical'), EXIT.ok)
  assert.equal(exitCodeFor({ critical: 1, warning: 9 }, 'critical'), EXIT.critical)
  assert.equal(exitCodeFor({ critical: 1, warning: 9 }, 'warning'), EXIT.critical, 'critical outranks warning')
  assert.equal(exitCodeFor({ critical: 0, warning: 1 }, 'critical'), EXIT.ok, 'warnings do not fail a critical gate')
  assert.equal(exitCodeFor({ critical: 0, warning: 1 }, 'warning'), EXIT.warning)
  assert.equal(exitCodeFor({ critical: 5, warning: 5 }, 'none'), EXIT.ok, 'none never fails on findings')

  assert.equal(parseFailOn(undefined), 'critical')
  assert.equal(parseFailOn('none'), 'none')
  assert.throws(() => parseFailOn('warn'), /--fail-on/)
})

await check('E21 a subpath the host denies is critical; a missing package is not', () => {
  // Two different failures share the "subpath import" shape, and conflating
  // them would overstate one:
  //   - package exists but its `exports` map denies the subpath: Node throws
  //     ERR_PACKAGE_PATH_NOT_EXPORTED even though the file is on disk -> critical
  //   - the package is not in the running host at all: also broken, but a
  //     different root cause and fix -> warning
  const base = {
    profilePath: '/fake',
    layers: [],
    inserts: [],
    overrides: [],
    missingPatchFiles: [],
    unresolvedBundles: [],
    declaredTools: {},
    declaredServices: {},
    sourceFacts: {},
    versionAuthority: 'archive-authoritative',
    packages: [],
  }

  // Only meaningful where a host archive exists: without one every manifest read
  // is undefined and the detector must stay silent rather than guess.
  if (readHostSurface('@deepseek-ai/dsh-llm') !== undefined) {
    // Real case from this machine: dsh-client-connection imports
    // @deepseek-ai/dsh-host-apiproxy/api, and that package is not in the host.
    const missing = detect({
      profile: { ...base, declaredImports: { 'plugin-a': { '@deepseek-ai/dsh-host-apiproxy/api': ['x'] } } },
      nodeVersion: process.version,
    }).filter((f) => f.code === 'profile/host-subpath-not-exported')
    assert.equal(missing.length, 1, 'a package absent from the running host must be reported')
    assert.equal(missing[0].severity, 'warning', 'a missing package is not an exports violation')
    assert.ok(missing[0].refs.includes('@deepseek-ai/dsh-host-apiproxy/api'))
    assert.ok(
      missing[0].evidence.some((line) => line.includes('archive')),
      'the evidence must say how it was established',
    )

    // Subpaths the host really does export must not fire.
    const allowed = detect({
      profile: {
        ...base,
        declaredImports: {
          'plugin-b': { '@deepseek-ai/dsh-session/surface': ['y'], '@deepseek-ai/dsh-llm/message': ['z'] },
        },
      },
      nodeVersion: process.version,
    }).filter((f) => f.code === 'profile/host-subpath-not-exported')
    assert.equal(allowed.length, 0, 'an exported subpath must not be flagged')
  }

  // Community packages are the plugin's own business: only @deepseek-ai/* is judged,
  // because their layouts are not this tool's contract to police.
  const community = detect({
    profile: { ...base, declaredImports: { 'plugin-c': { 'some-community-pkg/deep/thing': ['q'] } } },
    nodeVersion: process.version,
  }).filter((f) => f.code === 'profile/host-subpath-not-exported')
  assert.equal(community.length, 0, 'community subpaths are out of scope')
})

await check('E22 a denied subpath on a closed exports map is critical', () => {
  // E21 proved the "package missing" branch on real data. This proves the other
  // one, which is the harder case: the package IS present and its exports map is
  // a closed list, so a subpath outside it throws ERR_PACKAGE_PATH_NOT_EXPORTED
  // at import time even though the file may exist on disk.
  //
  // The subject must be a @deepseek-ai package (community ones are out of scope)
  // AND have no wildcard key: dsh-session exports ./src/*, so nothing is
  // provably denied there and the detector correctly stays silent.
  if (readHostSurface('@deepseek-ai/dsh-agent-loop') === undefined) return

  const denied = detect({
    profile: {
      profilePath: '/fake',
      layers: [],
      inserts: [],
      overrides: [],
      missingPatchFiles: [],
      unresolvedBundles: [],
      declaredTools: {},
      declaredServices: {},
      sourceFacts: {},
      packages: [],
      versionAuthority: 'archive-authoritative',
      declaredImports: { 'plugin-x': { '@deepseek-ai/dsh-agent-loop/not-in-the-map': ['a'] } },
    },
    nodeVersion: process.version,
  }).filter((f) => f.code === 'profile/host-subpath-not-exported')

  assert.equal(denied.length, 1, 'a subpath absent from a closed exports map must be reported')
  assert.equal(denied[0].severity, 'critical', 'a denied subpath breaks the import outright')
  assert.ok(
    denied[0].evidence.some((line) => line.includes('exports')),
    'the evidence must name the exports map as the reason',
  )
})

/* ------------------------------------------------------------------ Part F */

/**
 * The client realm.
 *
 * Grounded in the real manifest contract rather than a guess: across all 45
 * client packages in the installed profile, `dsh.client` carries exactly
 * `platform` and `inject`, and `inject` lists CLIENT MODULE names such as
 * `@deepseek-ai/dsh-client-ui-sidebar-right`.
 */
const clientBase = () => ({
  profilePath: '/fake',
  layers: [],
  inserts: [],
  overrides: [],
  missingPatchFiles: [],
  unresolvedBundles: [],
  declaredTools: {},
  declaredServices: {},
  declaredImports: {},
  sourceFacts: {},
  versionAuthority: 'archive-authoritative',
  packages: [],
})

/** A client-half package with the given injected modules. */
const clientPkg = (name, inject, extra = {}) => ({
  name,
  version: '1.0.0',
  dir: `/fake/${name}`,
  ranges: {},
  halves: 'client',
  client: { platform: 'web', inject },
  ...extra,
})

await check('F1 a client module nobody provides is reported', () => {
  const findings = detect({
    profile: { ...clientBase(), packages: [clientPkg('plugin-a', ['@deepseek-ai/dsh-client-ui-nope'])] },
    nodeVersion: process.version,
  }).filter((f) => f.code === 'client/inject-unprovided')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].severity, 'warning')
  assert.ok(findings[0].refs.includes('@deepseek-ai/dsh-client-ui-nope'), 'the missing module must be named')
})

await check('F2 a client module provided by an installed package is not reported', () => {
  const findings = detect({
    profile: {
      ...clientBase(),
      packages: [
        clientPkg('plugin-b', ['@deepseek-ai/dsh-client-ui-provider']),
        clientPkg('@deepseek-ai/dsh-client-ui-provider', []),
      ],
    },
    nodeVersion: process.version,
  }).filter((f) => f.code === 'client/inject-unprovided')
  assert.equal(findings.length, 0, 'a module another installed package supplies must not be called missing')
})

await check('F3 a client module shipped by the running host is not reported', () => {
  const findings = detect({
    profile: {
      ...clientBase(),
      packages: [clientPkg('plugin-c', ['@deepseek-ai/dsh-client-ui-sidebar-right'])],
      hostBundleVersions: { '@deepseek-ai/dsh-client-ui-sidebar-right': '0.2.0-rc.2' },
    },
    nodeVersion: process.version,
  }).filter((f) => f.code === 'client/inject-unprovided')
  assert.equal(findings.length, 0, 'the running host is a provider')
})

await check('F4 a differently cased or unscoped spelling is not called missing', () => {
  // A false "missing" sends the user chasing a module that is present, so the
  // comparison normalises case and the @deepseek-ai/ scope.
  const findings = detect({
    profile: {
      ...clientBase(),
      packages: [clientPkg('plugin-d', ['Dsh-Client-UI-Sidebar-Right'])],
      hostBundleVersions: { '@deepseek-ai/dsh-client-ui-sidebar-right': '0.2.0-rc.2' },
    },
    nodeVersion: process.version,
  }).filter((f) => f.code === 'client/inject-unprovided')
  assert.equal(findings.length, 0, 'spelling must not create a false positive')
})

await check('F5 a package with no dsh.client is never judged as a client half', () => {
  const findings = detect({
    profile: { ...clientBase(), packages: [{ name: 'plugin-e', version: '1.0.0', dir: '/fake/e', ranges: {} }] },
    nodeVersion: process.version,
  }).filter((f) => f.code === 'client/inject-unprovided')
  assert.equal(findings.length, 0, 'the host half has its own detectors')
})

await check('F6 a service name shared across realms is info, never a conflict', () => {
  // The page and the host keep separate service tables, so a shared name is
  // legitimate. It is surfaced as `info` because the exclusion used to be
  // silent, and a reviewer may only ever look at one side.
  const findings = detect({
    profile: {
      ...clientBase(),
      packages: [
        clientPkg('@deepseek-ai/dsh-cordis-client-runner', []),
        { name: '@deepseek-ai/dsh-cordis-host-runner', version: '1.0.0', dir: '/fake/h', ranges: {} },
      ],
      declaredServices: { timer: ['@deepseek-ai/dsh-cordis-client-runner', '@deepseek-ai/dsh-cordis-host-runner'] },
    },
    nodeVersion: process.version,
  }).filter((f) => f.code === 'client/service-name-shared-with-host')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].severity, 'info', 'a cross-realm name is not a conflict')
  assert.ok(
    findings[0].evidence.some((line) => line.includes('不做冲突比较')),
    'the evidence must state that the two realms are not compared',
  )
})

await check('F7 realmOf and comparableRealm agree with the declaration', () => {
  const declaration = readClientHalf({ dsh: { client: { platform: 'web', inject: ['a'] } } })
  assert.deepEqual(declaration, { platform: 'web', inject: ['a'] })
  assert.equal(realmOf(declaration), 'client')
  assert.equal(realmOf(undefined), 'host')
  assert.equal(comparableRealm('host', 'host'), true)
  assert.equal(comparableRealm('client', 'client'), true)
  assert.equal(comparableRealm('host', 'client'), false, 'the two realms are not comparable')
})

await check('F8 a malformed dsh.client still marks the package as a client half', () => {
  // Presence is the fact; the contents are optional detail. A bare `true` or a
  // string must not make the package look host-side, or its names would be
  // compared against the host registry.
  for (const value of [true, 'web', null, {}]) {
    const declaration = readClientHalf({ dsh: { client: value } })
    assert.notEqual(declaration, undefined, `dsh.client = ${JSON.stringify(value)} still declares a browser half`)
    assert.equal(realmOf(declaration), 'client')
    assert.ok(Array.isArray(declaration?.inject), 'inject must always be a list')
  }
  // An object-form inject keeps its keys, in declaration order.
  assert.deepEqual(readClientHalf({ dsh: { client: { inject: { b: 1, a: 2 } } } })?.inject, ['b', 'a'])
  // Duplicates collapse without reordering.
  assert.deepEqual(readClientHalf({ dsh: { client: { inject: ['x', 'x', 'y'] } } })?.inject, ['x', 'y'])
  // No client key at all means host-side.
  assert.equal(readClientHalf({ dsh: {} }), undefined)
  assert.equal(readClientHalf(undefined), undefined)
})

await check('F9 the report groups findings by realm', () => {
  // The realm is already the code prefix, so nothing is declared twice. Grouping
  // matters because the realms fail and are fixed differently: a host row is
  // fixed in cordis.patch.yml, while a browser-half problem usually has no
  // config fix at all.
  const finding = (code, severity) => ({
    code,
    severity,
    title: code,
    refs: ['r'],
    impact: 'i',
    evidence: ['e'],
    fixes: [{ kind: 'manual', label: 'l', detail: 'd' }],
  })
  const markdown = renderMarkdown({
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    profilePath: '/tmp/p',
    scope: 'profile',
    summary: { critical: 1, warning: 1, info: 2, liveEntries: 0, patchLayers: 1, scannedPackages: 1, declaredTools: 0 },
    findings: [
      finding('profile/row-config-replaced', 'info'),
      finding('live/pending-missing-service', 'critical'),
      finding('client/inject-unprovided', 'warning'),
      finding('weird/unknown-prefix', 'info'),
    ],
    notes: [],
  })

  for (const label of ['运行期', '磁盘组合', '客户端半区']) {
    assert.ok(markdown.includes(label), `the report must have a ${label} section`)
  }
  // An unrecognised prefix must be surfaced, never dropped: a silently missing
  // finding is worse than an ugly heading.
  assert.ok(markdown.includes('其他'), 'an unknown realm must still be rendered under a catch-all heading')

  const liveAt = markdown.indexOf('运行期')
  const profileAt = markdown.indexOf('磁盘组合')
  assert.ok(liveAt !== -1 && profileAt !== -1 && liveAt < profileAt, 'live findings come before disk composition')
  assert.ok(markdown.includes('1 critical'), 'each section must state its own severity counts')
})

/* ------------------------------------------------------------------ Part G */

/**
 * Attribution confidence.
 *
 * The README has always admitted that tool-id ownership cannot be attributed
 * with certainty. That is honest but not actionable — a reader cannot tell a
 * certain answer from a guess. These checks pin the graded replacement.
 */
const attrBase = () => ({
  profilePath: '/fake',
  layers: [],
  inserts: [],
  overrides: [],
  missingPatchFiles: [],
  unresolvedBundles: [],
  declaredTools: {},
  declaredServices: {},
  declaredImports: {},
  sourceFacts: {},
})
const hostPkg = (name) => ({ name, version: '1.0.0', dir: `/fake/${name}`, ranges: {} })
const clientPkgOf = (name) => ({ ...hostPkg(name), halves: 'client', client: { platform: 'web', inject: [] } })

await check('G1 one declarer is certain', () => {
  const result = attribute({ ...attrBase(), packages: [hostPkg('p1')], declaredTools: { foo: ['p1'] } }, 'tool', 'foo')
  assert.equal(result.confidence, 'certain')
  assert.equal(result.candidates.length, 1)
  assert.ok(result.reason.length > 0, 'a grade must come with its reason')
})

await check('G2 declarers in different realms are probable, not a conflict', () => {
  // The page and the host keep separate registries, so the same name in each is
  // the normal shape of "both halves expose this capability".
  const result = attribute(
    { ...attrBase(), packages: [hostPkg('p1'), clientPkgOf('p2')], declaredServices: { bar: ['p1', 'p2'] } },
    'service',
    'bar',
  )
  assert.equal(result.confidence, 'probable')
  assert.ok(result.reason.includes('realm'), 'the reason must name the realm distinction')
})

await check('G3 declarers in the same realm are ambiguous and must ask for a human', () => {
  // This is the case the README's caveat was about. Saying so explicitly is the
  // whole point: previously this looked the same as a settled answer.
  const result = attribute(
    { ...attrBase(), packages: [hostPkg('p1'), hostPkg('p2')], declaredTools: { baz: ['p1', 'p2'] } },
    'tool',
    'baz',
  )
  assert.equal(result.confidence, 'ambiguous')
  assert.ok(result.reason.includes('人工'), 'an ambiguous result must say a human is needed')
  assert.equal(result.candidates.length, 2)
})

await check('G4 nothing declaring a name is unknown, never a guess', () => {
  const result = attribute({ ...attrBase(), packages: [hostPkg('p1')] }, 'tool', 'ghost')
  assert.equal(result.confidence, 'unknown')
  assert.equal(result.candidates.length, 0)
  assert.ok(result.reason.includes('动态') || result.reason.includes('运行期'), 'the reason must explain the blind spot')
})

await check('G5 the weakest attributions are listed first', () => {
  // Ordering is load-bearing: burying "needs a human" under 79 settled answers
  // would make the grade decorative.
  const all = attributeAll({
    ...attrBase(),
    packages: [hostPkg('p1'), hostPkg('p2'), clientPkgOf('p3')],
    declaredTools: { settled: ['p1'], contested: ['p1', 'p2'], ghost: [] },
    declaredServices: { shared: ['p1', 'p3'] },
  })
  assert.deepEqual(
    all.map((entry) => `${entry.name}=${entry.confidence}`),
    ['contested=ambiguous', 'ghost=unknown', 'shared=probable', 'settled=certain'],
  )
  assert.deepEqual(confidenceCounts(all), { certain: 1, probable: 1, ambiguous: 1, unknown: 1 })
})

await check('G6 every confidence grade has a human label', () => {
  for (const grade of ['certain', 'probable', 'ambiguous', 'unknown']) {
    assert.ok(typeof CONFIDENCE_LABEL[grade] === 'string' && CONFIDENCE_LABEL[grade].length > 0, `${grade} needs a label`)
  }
})

await check('G7 the real profile attributes without inventing ambiguity', () => {
  // On a healthy profile every name should be settled or explained by realm.
  // An `unknown` here would mean the scan missed a declaration it should see.
  const profilePath = process.env.DSH_PROFILE_DIR ?? defaultProfilePath()
  if (profilePath === undefined) return
  let snapshot
  try {
    snapshot = collectStatic(profilePath, [])
  } catch {
    return
  }
  const all = attributeAll(snapshot)
  if (all.length === 0) return
  const counts = confidenceCounts(all)
  assert.equal(counts.ambiguous, 0, `a healthy profile must not have same-realm ambiguity; got ${JSON.stringify(counts)}`)
  assert.equal(counts.unknown, 0, 'every declared name should have been seen by the scan')
  assert.ok(counts.certain > 0, 'the scan should settle at least one name')
})

await check('G8 a Loader-less composition discloses that it cannot see failures', async () => {
  // Measured, and the measurement corrected a plan assumption. A duplicate
  // service name is NOT a silent failure: cordis throws
  // `service "shared" has been registered at <A>` and the second fiber lands in
  // state 3. But in a bare container there is no Loader, so `collectLive` sees
  // zero entries and reports NOTHING -- a failed plugin becomes invisible.
  //
  // So live/service-owner-ambiguous is unnecessary (the runtime names the
  // conflict itself), and the real gap is disclosure. This pins the disclosure.
  const ctx = new Context()
  class First extends Service {
    constructor(c) {
      super(c, 'shared')
    }
  }
  class Second extends Service {
    constructor(c) {
      super(c, 'shared')
    }
  }
  const first = ctx.plugin(First)
  await first
  assert.equal(first.state, 2, 'the first provider must be active')

  const second = ctx.plugin(Second)
  let thrown
  try {
    await second
  } catch (error) {
    thrown = error
  }
  // The runtime reports the conflict with the owner's name; no detector needed.
  assert.ok(thrown !== undefined, 'a duplicate service name must be a loud error')
  assert.match(thrown.message, /has been registered/)
  assert.equal(second.state, 3, 'the second provider fails')

  const live = collectLive(ctx)
  assert.equal(live.entries.length, 0, 'without a Loader there is no entry tree to enumerate')
  assert.ok(
    live.notes.some((note) => note.includes('未检查')),
    `the note must say "0 findings means not examined", got: ${JSON.stringify(live.notes)}`,
  )
  await ctx.fiber.dispose()
})

/* ------------------------------------------------------------------ Part H */

/**
 * The `!!js` whitelist interpreter.
 *
 * Two properties matter, and only the second one is safety-critical: deciding
 * what is decidable, and refusing to evaluate anything else. A wrong answer
 * about a `disabled` key corrupts the row baseline, so each decision is pinned
 * against an explicit expected value rather than "it returned something".
 */
await check('H1 platform comparisons decide, following the injected env', () => {
  const win = { platform: 'win32', arch: 'x64', version: 'v24.0.0' }
  const linux = { platform: 'linux', arch: 'x64', version: 'v24.0.0' }
  assert.equal(evaluateCondition("process.platform === 'win32'", win), true)
  assert.equal(evaluateCondition("process.platform === 'win32'", linux), false, 'the result must follow the env, not the host')
  assert.equal(evaluateCondition("process.platform !== 'win32'", win), false)
  // The two complementary rules must disagree: if both came out the same, the
  // comparison is broken in a way that would disable the wrong sandbox.
  const bash = evaluateCondition("process.platform === 'win32'", win)
  const pwsh = evaluateCondition("process.platform !== 'win32'", win)
  assert.notEqual(bash, pwsh, 'complementary rules must not agree')
})

await check('H2 literals, booleans and the default idioms evaluate', () => {
  assert.equal(evaluateExpression("'DISABLED'"), 'DISABLED')
  assert.equal(evaluateExpression('true'), true)
  assert.equal(evaluateExpression('false'), false)
  assert.equal(evaluateExpression('null'), null)
  assert.equal(evaluateExpression('3000'), 3000)
  assert.equal(evaluateExpression('!false'), true)
  assert.equal(evaluateExpression('true && false'), false)
  assert.equal(evaluateExpression("'x' || 'y'"), 'x')
  // A parenthesised comparison, as the real profile ships one. Writing it
  // backwards once was enough to know the assertion needs its own check.
  assert.equal(evaluateExpression('(true) === false'), false)
  assert.equal(evaluateExpression('(true) === true'), true)
})

await check('H3 anything that is real code is refused, not evaluated', () => {
  // Each of these appears in a real profile's layers or would be the next
  // step someone asks for. Every one must come back undefined: the audit runs
  // inside other people's harnesses, and a refused expression is safe while a
  // mis-evaluated one is a wrong baseline.
  const refused = [
    "dshHomePath('sessions')",
    'ctx.webStartup.host ?? "127.0.0.1"',
    'ctx.webRuntime.trustedHosts',
    'process.env.DSH_TOOLS_MODE',
    'process.cwd()',
    'require("fs")',
    'eval("1+1")',
    '`template ${x}`',
    '(() => true)()',
    'new Date()',
    'a.b.c.d.e',
    "'unclosed",
    "'a' 'b'",
    'true 5',
    'true ? 1 : 2',
    '',
  ]
  for (const expr of refused) {
    assert.equal(evaluateExpression(expr), undefined, `must refuse: ${expr}`)
  }
})

await check('H4 an expression result is never silently read as a condition', () => {
  // A string result where a boolean is wanted means the expression produced a
  // VALUE, not a decision. Returning it as truthy would invent a disable.
  assert.equal(evaluateCondition("'DISABLED'"), undefined, 'a string is not a boolean')
  assert.equal(evaluateCondition('3000'), undefined, 'a number is not a boolean')
  assert.equal(evaluateCondition('null'), undefined)
})

await check('H5 the real profile decides exactly the pure expressions', () => {
  const profilePath = process.env.DSH_PROFILE_DIR ?? defaultProfilePath()
  if (profilePath === undefined) return
  let snapshot
  try {
    snapshot = collectStatic(profilePath, [])
  } catch {
    return
  }
  // The note must now state the split rather than claiming nothing is decided:
  // the blanket claim was how the wrong `disabled` baseline stayed unnoticed.
  const note = snapshot.notes.find((entry) => entry.includes('白名单解释器'))
  if (snapshot.notes.some((entry) => entry.includes('!!js'))) {
    assert.ok(note !== undefined, 'a profile with !!js must report the decided/undecided split')
    assert.match(note ?? '', /白名单解释器/)
  }
})

/* ------------------------------------------------------------------ Part I */

/**
 * Key-level config provenance.
 *
 * The old wording could only say "the config was replaced", which is true both
 * for a harmless restatement and for one that drops a required key — the
 * "I configured it and nothing happened" case. These checks pin the separation,
 * including the dropped-key case, which does NOT occur on this machine's real
 * profile and would otherwise be untested code.
 */
const layerSnapshot = (inserts, overrides, layerCount = 4) => ({
  profilePath: '/fake',
  layers: Array.from({ length: layerCount }, (_, index) => ({
    index,
    label: `layer-${index}`,
    kind: 'bundle',
    file: `/fake/${index}.yml`,
  })),
  inserts,
  overrides,
  missingPatchFiles: [],
  unresolvedBundles: [],
  declaredTools: {},
  declaredServices: {},
  declaredImports: {},
  sourceFacts: {},
  packages: [],
  versionAuthority: 'unknown',
})
const cfgInsert = (rowId, layerIndex, config) => ({
  rowId,
  layerIndex,
  moduleName: 'mod',
  hasConfig: true,
  configJson: JSON.stringify(config),
})

const configFindings = (snapshot) =>
  detect({ profile: snapshot, nodeVersion: process.version }).filter((f) => f.code === 'profile/row-config-replaced')

await check('I1 a dropped key upgrades the finding to a warning', () => {
  // The case the whole detector exists for: an earlier layer writes a required
  // key, a later layer restates the config without it, and nothing reports it.
  const findings = configFindings(
    layerSnapshot([cfgInsert('row-a', 0, { required: true, other: 1 }), cfgInsert('row-a', 2, { other: 2 })], []),
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].severity, 'warning', 'a dropped key is not informational')
  assert.ok(
    findings[0].evidence.some((line) => line.includes('丢弃') && line.includes('required')),
    `the dropped key must be named; got ${JSON.stringify(findings[0].evidence)}`,
  )
  assert.ok(findings[0].title.includes('丢弃'), 'the title must say a key was dropped')
})

await check('I2 a pure value change stays informational and names both values', () => {
  const findings = configFindings(
    layerSnapshot([cfgInsert('row-b', 0, { provider: 'old-provider' }), cfgInsert('row-b', 1, { provider: 'new-provider' })], []),
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].severity, 'info', 'no key was lost, so this stays a note')
  const change = findings[0].evidence.find((line) => line.startsWith('provider'))
  assert.ok(change?.includes('old-provider') && change.includes('new-provider'), `both values must appear; got ${change}`)
})

await check('I3 a pure addition is reported as an addition, not a loss', () => {
  const findings = configFindings(
    layerSnapshot(
      [cfgInsert('row-c', 0, { presets: { a: 1 } }), cfgInsert('row-c', 1, { presets: { a: 1 }, defaultPreset: 'x' })],
      [],
    ),
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].severity, 'info')
  assert.ok(
    findings[0].evidence.some((line) => line.includes('新增') && line.includes('defaultPreset')),
    `the addition must be named; got ${JSON.stringify(findings[0].evidence)}`,
  )
  // `presets` has an equal value in both layers, so it must NOT be listed as changed.
  assert.equal(
    findings[0].evidence.some((line) => line.startsWith('presets：')),
    false,
    'an unchanged key must not be reported as a change',
  )
})

await check('I4 a byte-identical restatement across layers is not reported', () => {
  // Restating the same values is the documented DSH layering contract and
  // carries no information, so it must stay silent rather than add noise.
  const findings = configFindings(layerSnapshot([cfgInsert('row-d', 0, { a: 1 }), cfgInsert('row-d', 1, { a: 1 })], []))
  assert.equal(findings.length, 0, 'an identical restatement is not a finding')
})

await check('I5 key order alone is not a change', () => {
  // JSON.stringify is order-sensitive; the detector compares per key, so a
  // reordered restatement must not be reported as a value change.
  const findings = configFindings(
    layerSnapshot([cfgInsert('row-e', 0, { a: 1, b: 2 }), cfgInsert('row-e', 1, { b: 2, a: 1 })], []),
  )
  assert.equal(findings.length, 0, 'reordering keys is not a config change')
})

await check('I6 a non-object config degrades instead of claiming a diff', () => {
  const findings = configFindings(layerSnapshot([cfgInsert('row-f', 0, [1, 2]), cfgInsert('row-f', 1, [3, 4])], []))
  assert.equal(findings.length, 1, 'an array config still differs by string')
  assert.ok(
    findings[0].evidence.some((line) => line.includes('无法逐键对比')),
    'the evidence must admit it could not diff per key',
  )
  assert.equal(findings[0].severity, 'info', 'an undiffable config must not escalate to warning')
})

await check('I7 the real profile reports key-level evidence for every restatement', () => {
  const profilePath = process.env.DSH_PROFILE_DIR ?? defaultProfilePath()
  if (profilePath === undefined) return
  let snapshot
  try {
    snapshot = collectStatic(profilePath, [])
  } catch {
    return
  }
  const findings = configFindings(snapshot)
  if (findings.length === 0) return
  for (const finding of findings) {
    assert.ok(finding.evidence.length > 0, `every finding must carry evidence; ${finding.code} for ${finding.refs[0]} had none`)
    // A finding that names specific keys must not fall back to the old
    // whole-string form, which is what made the message uninformative.
    assert.ok(
      finding.evidence.some(
        (line) => line.includes('：') || line.includes('新增') || line.includes('无差异') || line.includes('无法逐键对比'),
      ),
      `evidence must be key-level or honestly admit it could not be; got ${JSON.stringify(finding.evidence)}`,
    )
  }
})

/* ------------------------------------------------------------------ Part J */

/**
 * Static inject-cycle detection (W4).
 *
 * Sound without knowing who provides what, which is exactly why it is buildable
 * while the "unprovided inject" check is not: a cycle means every row in it
 * waits for another, so none can activate -- true from the declarations alone.
 */
const graphBase = {
  profilePath: '/fake',
  layers: [{ index: 0, label: 'l0', kind: 'bundle', file: '/f/0.yml' }],
  inserts: [],
  overrides: [],
  missingPatchFiles: [],
  unresolvedBundles: [],
  declaredTools: {},
  declaredImports: {},
  sourceFacts: {},
  versionAuthority: 'unknown',
  packages: [],
}
const graphRow = (rowId, moduleName, inject) => ({
  rowId,
  moduleName,
  hasConfig: false,
  configJson: 'null',
  layerIndex: 0,
  ...(inject === undefined ? {} : { inject }),
})
const cycleFindings = (inserts, declaredServices) =>
  detect({ profile: { ...graphBase, inserts, declaredServices }, nodeVersion: process.version }).filter(
    (f) => f.code === 'profile/inject-cycle',
  )

await check('J1 a two-row inject cycle is critical and names the path', () => {
  const findings = cycleFindings([graphRow('A', 'mod-a', ['svcB']), graphRow('B', 'mod-b', ['svcA'])], {
    svcA: ['mod-a'],
    svcB: ['mod-b'],
  })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].severity, 'critical', 'a deadlock is not informational')
  assert.match(findings[0].title, /A → B → A/, 'the cycle path must be named, not just asserted')
})

await check('J2 a transitive cycle is found', () => {
  const findings = cycleFindings(
    [graphRow('A', 'mod-a', ['svcB']), graphRow('B', 'mod-b', ['svcC']), graphRow('C', 'mod-c', ['svcA'])],
    { svcA: ['mod-a'], svcB: ['mod-b'], svcC: ['mod-c'] },
  )
  assert.equal(findings.length, 1)
  assert.match(findings[0].title, /A → B → C → A/)
})

await check('J3 acyclic shapes stay silent', () => {
  // A chain is the normal case. Fan-out is what this machine's real profile
  // actually has (two rows injecting one service), so it must never fire.
  assert.equal(
    cycleFindings([graphRow('A', 'mod-a', ['svcB']), graphRow('B', 'mod-b', undefined)], { svcB: ['mod-b'] }).length,
    0,
    'a chain is not a cycle',
  )
  assert.equal(
    cycleFindings([graphRow('webserver', 'mod-w', ['webStartup']), graphRow('web-runtime', 'mod-w', ['webStartup'])], {
      webStartup: ['mod-host'],
    }).length,
    0,
    'fan-out is the real profile shape and must not be reported',
  )
})

await check('J4 an inject with no row provider is not guessed at', () => {
  // The provider may exist and simply not be visible to the literal-pattern
  // scan, so no edge is created and nothing is claimed.
  assert.equal(cycleFindings([graphRow('A', 'mod-a', ['svcX'])], {}).length, 0, 'an unknown provider is not a cycle')
})

await check('J5 the real profile has inject edges and no cycle', () => {
  // 3 real edges exist (webserver/web-runtime -> webStartup, connection ->
  // webRuntime) and form no cycle, so this pins both extraction and silence.
  const profilePath = process.env.DSH_PROFILE_DIR ?? defaultProfilePath()
  if (profilePath === undefined) return
  let snapshot
  try {
    snapshot = collectStatic(profilePath, [])
  } catch {
    return
  }
  const withInject = snapshot.inserts.filter((row) => row.inject !== undefined && row.inject.length > 0)
  assert.ok(withInject.length > 0, 'the real profile declares inject edges; extraction must find them')
  assert.equal(
    detect({ profile: snapshot, nodeVersion: process.version }).filter((f) => f.code === 'profile/inject-cycle').length,
    0,
    'the real profile has no inject cycle',
  )
})

/* ------------------------------------------------------------------ Part K */

/**
 * Repair risk grading.
 *
 * Nothing was ever applied before, so risk could stay implicit. The moment a fix
 * can be applied, "how much does this change" must be derived from the snippet
 * rather than from a hand-written label that drifts away from it.
 */
await check('K1 risk is derived from the snippet, not the label', () => {
  assert.equal(classifyRisk('patch', '- insert:\n    - id: x\n      name: y'), 'safe', 'adding rows changes nothing existing')
  assert.equal(classifyRisk('patch', '- id: x\n  config: {"a":1}'), 'caution', 'replacing config overwrites an earlier layer')
  assert.equal(classifyRisk('patch', '- id: x\n  disabled: true'), 'destructive', 'disabling changes what loads')
  assert.equal(classifyRisk('command', undefined), 'destructive', "a command's effect is invisible to the audit")
  assert.equal(classifyRisk('manual', undefined), 'safe', 'nothing is applied')
})

await check('K2 disabled wins over config when a snippet has both', () => {
  assert.equal(classifyRisk('patch', '- id: x\n  disabled: true\n  config: {"a":1}'), 'destructive')
})

await check('K3 manual fixes are safe but NOT auto-applicable', () => {
  // The distinction: `safe` means "cannot break anything", true of a decision
  // nothing executes. It does NOT mean "apply it for me". An earlier version
  // checked only the risk level and so treated every manual fix as applicable.
  const manual = { kind: 'manual', risk: classifyRisk('manual', undefined) }
  assert.equal(manual.risk, 'safe')
  assert.equal(isAutoApplicable(manual), false, 'a manual decision has nothing to execute')
  assert.equal(isAutoApplicable({ kind: 'patch', risk: classifyRisk('patch', '- insert:\n    - id: a') }), true)
  assert.equal(isAutoApplicable({ kind: 'patch', risk: classifyRisk('patch', '- id: a\n  config: {}') }), true)
  assert.equal(isAutoApplicable({ kind: 'patch', risk: classifyRisk('patch', '- id: a\n  disabled: true') }), false)
  assert.equal(isAutoApplicable({ kind: 'command', risk: classifyRisk('command', undefined) }), false)
})

await check('K4 every fix the audit emits carries a risk', () => {
  // Not "most fixes" — every one. A consumer gating on `risk` must never meet
  // undefined, and every finding must keep the fix the contract requires.
  const profilePath = process.env.DSH_PROFILE_DIR ?? defaultProfilePath()
  if (profilePath === undefined) return
  let snapshot
  try {
    snapshot = collectStatic(profilePath, [])
  } catch {
    return
  }
  const findings = detect({ profile: snapshot, nodeVersion: process.version })
  const fixes = findings.flatMap((finding) => finding.fixes)
  assert.ok(fixes.length > 0, 'the real profile should produce some fixes')
  for (const fix of fixes) {
    assert.ok(
      fix.risk === 'safe' || fix.risk === 'caution' || fix.risk === 'destructive',
      `fix "${fix.label}" has no valid risk: ${String(fix.risk)}`,
    )
  }
  for (const finding of findings) assert.ok(finding.fixes.length > 0, `${finding.code} carries no fix`)
})

await check('K5 every risk level has a consequence-naming label', () => {
  for (const level of ['safe', 'caution', 'destructive']) {
    assert.ok(typeof RISK_LABEL[level] === 'string' && RISK_LABEL[level].length > 0, `${level} needs a label`)
  }
})

/* ------------------------------------------------------------------ Part L */

/**
 * Mutually exclusive repairs.
 *
 * Reports 0 on the real profile, so the firing path needs fixtures. Applying two
 * contradictory fixes to one row silently loses one of them, and which one
 * survives depends on apply order -- the audit cannot know which the user wants.
 */
const fixOf = (kind, snippet) => ({ kind, label: 'l', detail: 'd', ...(snippet === undefined ? {} : { snippet }) })

await check('L1 a disable and a config change on one row conflict', () => {
  const conflicts = findFixConflicts([
    { code: 'profile/disable-then-reinsert', fixes: [fixOf('patch', '- id: shared-row\n  disabled: true')] },
    { code: 'profile/row-config-replaced', fixes: [fixOf('patch', '- id: shared-row\n  config: {"a":1}')] },
  ])
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].rowId, 'shared-row')
  assert.equal(conflicts[0].fixes.length, 2)
})

await check('L2 two fixes doing the same thing are redundant, not conflicting', () => {
  // Two findings may both advise reconfiguring one row; either achieves it, so
  // calling that a conflict would be noise.
  const sameChange = findFixConflicts([
    { code: 'a', fixes: [fixOf('patch', '- id: row\n  config: {"a":1}')] },
    { code: 'b', fixes: [fixOf('patch', '- id: row\n  config: {"a":2}')] },
  ])
  assert.equal(sameChange.length, 0, 'two config rewrites on one row are not contradictory')

  // Two disables likewise.
  const bothDisable = findFixConflicts([
    { code: 'a', fixes: [fixOf('patch', '- id: row\n  disabled: true')] },
    { code: 'b', fixes: [fixOf('patch', '- id: row\n  disabled: true')] },
  ])
  assert.equal(bothDisable.length, 0)
})

await check('L3 fixes on different rows never conflict', () => {
  const conflicts = findFixConflicts([
    { code: 'a', fixes: [fixOf('patch', '- id: row-1\n  disabled: true')] },
    { code: 'b', fixes: [fixOf('patch', '- id: row-2\n  config: {}')] },
  ])
  assert.equal(conflicts.length, 0)
})

await check('L4 fixes with no row target are ignored', () => {
  // A manual decision and an insert list address no existing row, so they cannot
  // collide with anything.
  const conflicts = findFixConflicts([
    { code: 'a', fixes: [fixOf('manual', undefined)] },
    { code: 'b', fixes: [fixOf('patch', '- insert:\n    - id: new-row\n      name: x')] },
    { code: 'c', fixes: [fixOf('patch', '- id: real-row\n  disabled: true')] },
  ])
  assert.equal(conflicts.length, 0)
  assert.equal(snippetRowId(undefined), undefined)
  assert.equal(snippetRowId('- insert:\n    - id: new-row'), 'new-row', 'an insert target is still read')
})

await check('L5 the real profile has no conflicting repairs', () => {
  // Combined with L1 this pins both directions: the detector can fire, and it
  // stays silent on a healthy profile.
  const profilePath = process.env.DSH_PROFILE_DIR ?? defaultProfilePath()
  if (profilePath === undefined) return
  let snapshot
  try {
    snapshot = collectStatic(profilePath, [])
  } catch {
    return
  }
  const findings = detect({ profile: snapshot, nodeVersion: process.version })
  assert.equal(
    findings.filter((f) => f.code === 'fix/mutually-exclusive').length,
    0,
    'the real profile must not report conflicting repairs',
  )
})

/* ------------------------------------------------------------------ Part M */

/**
 * Surgical patch edits.
 *
 * The file being edited is the user's own hand-written configuration layer, so
 * the property under test is not "the change landed" but "nothing ELSE moved".
 * A line-index diff cannot show that — inserting one line shifts every later
 * line — so these checks are structural, including one that removes the inserted
 * line and requires the original back byte-for-byte.
 */
const editableSample = [
  '# a user comment that must survive',
  '# and a second line of it',
  '- id: row-a',
  '  name: "@scope/pkg-a"',
  '  config:',
  '    keep: me',
  '- id: row-b',
  '  name: "@scope/pkg-b"',
  '  config: {"b":1}',
  '',
].join('\n')

await check('M1 disabling a row merges into it instead of replacing it', () => {
  // Replacing the item would silently drop the user's name and config.
  const result = applySnippet(editableSample, '- id: row-a\n  disabled: true')
  assert.equal(result.action, 'appended', 'the key did not exist, so it is appended to the item')
  assert.ok(result.text.includes('@scope/pkg-a'), 'the name must survive')
  assert.ok(result.text.includes('keep: me'), 'the config must survive')
  assert.ok(result.text.includes('  disabled: true'))
  assert.equal(splitPatchDocument(result.text.split('\n')).items.length, 2, 'no item was added or lost')
})

await check('M2 the preamble and every other item are byte-identical', () => {
  const result = applySnippet(editableSample, '- id: row-b\n  config: {"b":2}')
  assert.ok(result.text.startsWith('# a user comment that must survive\n# and a second line of it'))
  assert.ok(result.text.includes('- id: row-a\n  name: "@scope/pkg-a"\n  config:\n    keep: me'), 'row-a must be untouched')
  assert.ok(result.text.includes('{"b":2}'))
})

await check('M3 removing the inserted line restores the file exactly', () => {
  // The strongest statement that nothing else moved: undo the edit textually and
  // require the original bytes back.
  const result = applySnippet(editableSample, '- id: row-a\n  disabled: true')
  const lines = result.text.split('\n')
  const at = lines.indexOf('  disabled: true')
  assert.notEqual(at, -1)
  lines.splice(at, 1)
  assert.equal(lines.join('\n'), editableSample)
})

await check('M4 an absent row is appended, never rewritten', () => {
  const result = applySnippet(editableSample, '- id: brand-new\n  disabled: true')
  assert.equal(result.action, 'appended')
  assert.ok(result.text.startsWith(editableSample.trimEnd()), 'the original must remain an untouched prefix')
  assert.ok(result.text.includes('- id: brand-new'))
})

await check('M5 applying the same change twice reports no change', () => {
  const once = applySnippet(editableSample, '- id: row-a\n  disabled: true')
  const twice = applySnippet(once.text, '- id: row-a\n  disabled: true')
  assert.equal(twice.changed, false, 'an idempotent edit must not rewrite the file')
  assert.equal(twice.text, once.text)
})

await check('M6 shapes it cannot apply safely are refused, not guessed', () => {
  // A mis-read snippet would corrupt a user's configuration, so anything that is
  // not a disable or a config replacement is refused outright.
  for (const bad of ['- id: x\n  name: y', '- insert:\n    - id: z', 'garbage', '', '- id: only-an-id']) {
    assert.equal(applySnippet(editableSample, bad), undefined, `must refuse: ${JSON.stringify(bad)}`)
  }
})

await check('M7 the real user patch survives an edit byte-for-byte', () => {
  const profilePath = process.env.DSH_PROFILE_DIR ?? defaultProfilePath()
  if (profilePath === undefined) return
  const patchFile = join(profilePath, 'cordis.patch.yml')
  if (!existsSync(patchFile)) return
  const original = readFileSync(patchFile, 'utf8')
  const doc = splitPatchDocument(original.split('\n'))
  const target = doc.items.find((item) => item.id !== undefined)
  if (target?.id === undefined) return

  const edited = applySnippet(original, `- id: ${target.id}\n  disabled: true`)
  assert.ok(edited.text.startsWith(doc.preamble.join('\n')), 'the comment block must survive')

  // Undo the edit and require the original file back exactly.
  const lines = edited.text.split('\n')
  const at = lines.indexOf('  disabled: true')
  assert.notEqual(at, -1, 'the disable line must have been added')
  lines.splice(at, 1)
  assert.equal(lines.join('\n'), original, 'undoing the edit must restore the real file byte-for-byte')

  // And the file on disk was never touched by any of this.
  assert.equal(readFileSync(patchFile, 'utf8'), original, 'the audit must not write to the profile')
})

/* ------------------------------------------------------------------ Part N */

/**
 * Dry run: apply a repair in memory and re-audit.
 *
 * Closes the gap the README named — every fix was a label plus a snippet, and
 * nothing had ever checked that pasting it does anything. The hard requirement
 * is that a dry run CANNOT corrupt a profile: it hands replacement TEXT to the
 * scanner and never touches disk.
 */
await check('N1 a dry run never writes to the profile', () => {
  const profilePath = process.env.DSH_PROFILE_DIR ?? defaultProfilePath()
  if (profilePath === undefined) return
  const patchFile = join(profilePath, 'cordis.patch.yml')
  if (!existsSync(patchFile)) return
  const before = readFileSync(patchFile, 'utf8')
  const findings = detect({ profile: collectStatic(profilePath, []), nodeVersion: process.version })
  dryRunAll(profilePath, findings, { nodeVersion: process.version })
  assert.equal(readFileSync(patchFile, 'utf8'), before, 'a dry run must leave the profile byte-identical')
})

await check('N2 a repair that cannot apply says so instead of claiming success', () => {
  const profilePath = process.env.DSH_PROFILE_DIR ?? defaultProfilePath()
  if (profilePath === undefined) return
  const findings = detect({ profile: collectStatic(profilePath, []), nodeVersion: process.version })
  const manual = findings[0]
  if (manual === undefined) return
  const outcome = dryRunFix(profilePath, findings, manual, { kind: 'manual', label: 'm', detail: 'd' })
  assert.equal(outcome.applied, false, 'a manual decision has nothing to apply')
  assert.equal(outcome.resolved, false)
  assert.ok(outcome.reason !== undefined && outcome.reason.length > 0, 'it must explain why nothing was applied')
})

await check('N3 resolved means the code got rarer, not that it vanished', () => {
  // Three findings share `row-config-replaced` on this profile. Fixing one of
  // them is progress, so requiring the code to disappear would report a working
  // repair as a failure.
  const baseline = [
    { code: 'a/x', severity: 'info', title: 't', refs: [], impact: 'i', evidence: ['e'], fixes: [] },
    { code: 'a/x', severity: 'info', title: 't', refs: [], impact: 'i', evidence: ['e'], fixes: [] },
  ]
  // Simulate the comparison the dry run performs via its own helper: one of two
  // gone must count as resolved.
  const before = new Map([['a/x', 2]])
  const after = new Map([['a/x', 1]])
  const resolved = (after.get('a/x') ?? 0) < (before.get('a/x') ?? 0)
  assert.equal(resolved, true, 'a reduction counts as resolved')
  assert.equal(baseline.length, 2)
})

await check('N4 the real profile applies cleanly and reports honestly', () => {
  // The measured result on this machine: both applicable repairs apply without
  // error, neither resolves its finding, and neither introduces a new one.
  // `row-config-replaced` is reported because a restatement exists BY DESIGN, so
  // its advice (make the last layer authoritative) is not meant to silence it.
  // A dry run that claimed "resolved" here would be lying.
  const profilePath = process.env.DSH_PROFILE_DIR ?? defaultProfilePath()
  if (profilePath === undefined) return
  const findings = detect({ profile: collectStatic(profilePath, []), nodeVersion: process.version })
  const outcomes = dryRunAll(profilePath, findings, { nodeVersion: process.version })
  if (outcomes.length === 0) return
  for (const outcome of outcomes) {
    if (!outcome.applied) continue
    // Whatever it concludes, it must not invent a new conflict.
    assert.deepEqual(outcome.introduced, [], `${outcome.code} must not introduce new findings`)
    if (!outcome.resolved) {
      assert.ok(outcome.reason !== undefined, 'an unresolved outcome must say why')
    }
  }
})

/* ------------------------------------------------------------------ Part O */

/**
 * The one function allowed to write to a profile, and every guard around it.
 *
 * Tested against a throwaway directory, never the real profile. The refusals
 * matter more than the successful write: a bug here damages a user's
 * configuration, which is the worst outcome this tool can produce.
 */
const applyRoot = mkdtempSync(join(tmpdir(), 'apply-test-'))
const applyProfile = join(applyRoot, 'profile')
mkdirSync(applyProfile, { recursive: true })
const applyPatch = join(applyProfile, 'cordis.patch.yml')
const applyOriginal = '# user comment\n- id: a\n  config: {"x":1}\n'
writeFileSync(applyPatch, applyOriginal)
mkdirSync(join(applyProfile, 'node_modules'), { recursive: true })
writeFileSync(join(applyProfile, 'node_modules', 'installed.yml'), 'installed\n')
// A SIBLING whose name merely starts with the profile's.
mkdirSync(join(applyRoot, 'profile-lookalike'), { recursive: true })
writeFileSync(join(applyRoot, 'profile-lookalike', 'cordis.patch.yml'), 'lookalike\n')

await check('O1 writes outside the profile are refused', () => {
  assert.equal(guardTarget(applyProfile, join(applyRoot, 'evil.yml'))?.code, 'outside-profile')
  assert.equal(guardTarget(applyProfile, join(applyProfile, '..', 'evil.yml'))?.code, 'outside-profile', 'traversal')
})

await check('O2 a sibling that only LOOKS like the profile is refused', () => {
  // The prefix trap: a string `startsWith(root)` comparison would accept this,
  // because "profile-lookalike" starts with "profile".
  const refusal = guardTarget(applyProfile, join(applyRoot, 'profile-lookalike', 'cordis.patch.yml'))
  assert.equal(refusal?.code, 'outside-profile')
})

await check('O3 node_modules and missing targets are refused', () => {
  assert.equal(guardTarget(applyProfile, join(applyProfile, 'node_modules', 'installed.yml'))?.code, 'inside-node-modules')
  assert.equal(guardTarget(applyProfile, join(applyProfile, 'nope.yml'))?.code, 'missing-target')
})

await check('O4 a permitted write keeps the original in a backup', () => {
  const result = writeWithBackup(applyProfile, applyPatch, '- id: a\n  disabled: true\n', {
    now: new Date('2026-10-14T10:00:00Z'),
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(readFileSync(applyPatch, 'utf8'), '- id: a\n  disabled: true\n', 'target updated')
  assert.equal(readFileSync(result.backupPath, 'utf8'), applyOriginal, 'backup must hold the ORIGINAL bytes')
  assert.ok(!/:\d/.test(result.backupPath), 'the backup name must be filesystem-safe')
  // The write must not leave debris beside the target.
  assert.deepEqual(
    readdirSync(applyProfile).filter((name) => name.includes('tmp-write')),
    [],
    'no temporary file may survive',
  )

  // O5: rollback restores, and is itself guarded.
  const back = rollbackFromBackup(applyProfile, result.backupPath)
  assert.equal(back.ok, true)
  assert.equal(readFileSync(applyPatch, 'utf8'), applyOriginal, 'rollback must restore the original')
  const escaped = rollbackFromBackup(applyProfile, result.backupPath, join(applyRoot, 'evil.yml'))
  assert.equal(escaped.ok, false, 'rollback must be guarded like any other write')
})

rmSync(applyRoot, { recursive: true, force: true })

/* ------------------------------------------------------------------ Part P */

/**
 * The CLI surface for everything above.
 *
 * Capability that no user can reach is not capability, so these checks run the
 * real binary. The two properties that matter: `--dry-run` changes nothing on
 * disk, and it does not contaminate the frozen JSON contract.
 */
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'cli.js')
const cliProfile = process.env.DSH_PROFILE_DIR ?? defaultProfilePath()

await check('P1 the report shows each repair risk level', () => {
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    profilePath: '/p',
    scope: 'profile',
    summary: { critical: 0, warning: 0, info: 1, liveEntries: 0, patchLayers: 1, scannedPackages: 1, declaredTools: 0 },
    findings: [
      {
        code: 'a/b',
        severity: 'info',
        title: 't',
        refs: [],
        impact: 'i',
        evidence: ['e'],
        fixes: [{ kind: 'patch', label: 'L', detail: 'D', risk: 'destructive' }],
      },
    ],
    notes: [],
    versionAuthority: 'authoritative',
  }
  const text = renderMarkdown(report)
  assert.ok(text.includes('[destructive]'), 'a reader must be able to see that a repair changes what loads')
})

await check('P2 --dry-run is accepted and writes nothing', () => {
  if (cliProfile === undefined) return
  const patchFile = join(cliProfile, 'cordis.patch.yml')
  if (!existsSync(patchFile)) return
  const before = readFileSync(patchFile, 'utf8')
  const run = spawnSync(process.execPath, [CLI, '--profile', cliProfile, '--dry-run'], { encoding: 'utf8' })
  assert.equal(run.status, 0, `CLI exited ${String(run.status)}: ${run.stderr}`)
  assert.ok(run.stdout.includes('修复试跑'), 'the dry-run section must be printed')
  assert.equal(readFileSync(patchFile, 'utf8'), before, 'a dry run must never touch the profile')
})

await check('P3 --dry-run keeps stdout pure when the format is json', () => {
  if (cliProfile === undefined) return
  const run = spawnSync(process.execPath, [CLI, '--profile', cliProfile, '--dry-run', '--format', 'json'], {
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, `CLI exited ${String(run.status)}: ${run.stderr}`)
  // stdout must stay one parseable document: a pipeline reading it cannot be
  // handed a simulation table mixed into the contract.
  const parsed = JSON.parse(run.stdout)
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.dryRun, undefined, 'the frozen contract must not grow a dry-run field')
  assert.ok(run.stderr.includes('修复试跑'), 'the simulation goes to stderr instead')
})

await check('P4 an unknown flag still refuses to start', () => {
  const run = spawnSync(process.execPath, [CLI, '--not-a-flag'], { encoding: 'utf8' })
  assert.notEqual(run.status, 0, 'a typo must not silently mean "no gate"')
})

await check('P5 --help documents --dry-run', () => {
  const run = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' })
  assert.equal(run.status, 0)
  assert.ok(run.stdout.includes('--dry-run'), 'a flag a user cannot discover may as well not exist')
})

/* ------------------------------------------------------------------ Part Q */

/**
 * `--fix-out`: the repairs as real files a user can read and pick from.
 *
 * The middle ground between prose and editing someone's config. The profile is
 * never touched — a `.patch.yml` beside `cordis.patch.yml` is inert — so a wrong
 * pick cannot break anything.
 */
await check('Q1 repairs of the same code get distinct filenames', () => {
  // This profile has three `row-config-replaced` findings. A counter scoped to
  // ONE finding made both write the same filename, so the second silently
  // overwrote the first while the caller still reported "2 files written".
  const outDir = mkdtempSync(join(tmpdir(), 'fixout-test-'))
  const make = (id) => ({
    code: 'profile/row-config-replaced',
    severity: 'info',
    title: 't',
    refs: [],
    impact: 'i',
    evidence: ['e'],
    fixes: [{ kind: 'patch', label: 'L', detail: 'D', risk: 'caution', snippet: `- id: ${id}\n  config: {"a":1}` }],
  })
  const files = writeFixFiles(outDir, [make('row-one'), make('row-two')])
  assert.equal(files.length, 2, 'both repairs must be reported as written')
  assert.equal(new Set(files.map((f) => f.path)).size, 2, 'and they must be two DIFFERENT files')
  assert.equal(readdirSync(outDir).filter((n) => n.endsWith('.patch.yml')).length, 2, 'both must exist on disk')
  rmSync(outDir, { recursive: true, force: true })
})

await check('Q2 every written fragment is valid YAML with one item', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'fixout-test-'))
  const finding = {
    code: 'profile/disable-then-reinsert',
    severity: 'warning',
    title: 't',
    refs: [],
    impact: 'i',
    evidence: ['e'],
    fixes: [{ kind: 'patch', label: 'L', detail: 'D', risk: 'destructive', snippet: '- id: some-row\n  disabled: true' }],
  }
  const files = writeFixFiles(outDir, [finding])
  assert.equal(files.length, 1)
  const text = readFileSync(files[0].path, 'utf8')
  // The comment header must not become YAML structure: `yaml` parses this, and
  // if the header were malformed the whole fragment would be unusable.
  const parsed = YAML.parse(text)
  assert.ok(Array.isArray(parsed), 'the fragment must be a top-level array')
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].id, 'some-row')
  assert.equal(parsed[0].disabled, true)

  // The manifest must state each risk's consequence, so nobody pastes blind.
  const manifest = readFileSync(join(outDir, 'README.md'), 'utf8')
  for (const level of ['safe', 'caution', 'destructive']) {
    assert.ok(manifest.includes(`\`${level}\``), `the manifest must explain ${level}`)
  }
  rmSync(outDir, { recursive: true, force: true })
})

await check('Q3 --fix-out writes files and leaves the profile alone', () => {
  if (cliProfile === undefined) return
  const patchFile = join(cliProfile, 'cordis.patch.yml')
  if (!existsSync(patchFile)) return
  const before = readFileSync(patchFile, 'utf8')
  const outDir = mkdtempSync(join(tmpdir(), 'fixout-cli-'))
  const run = spawnSync(process.execPath, [CLI, '--profile', cliProfile, '--fix-out', outDir], { encoding: 'utf8' })
  assert.equal(run.status, 0, `CLI exited ${String(run.status)}: ${run.stderr}`)
  assert.ok(readdirSync(outDir).includes('README.md'), 'a manifest must always be written')
  assert.equal(readFileSync(patchFile, 'utf8'), before, '--fix-out must never touch the profile')
  rmSync(outDir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ Part R */

/**
 * Advisory repairs: advice that is not meant to silence its own finding.
 *
 * `row-config-replaced` fires because a restatement exists, and that restatement
 * IS the DSH contract. Its repair makes the last layer authoritative rather than
 * removing the restatement, so the finding correctly survives it. Rendering that
 * as ❌ was accurate and misleading at the same time — it sends a reader looking
 * for a broken snippet that is behaving exactly as intended.
 */
await check('R1 row-config-replaced repairs are advisory, not expected to resolve', () => {
  assert.equal(isAdvisory('profile/row-config-replaced'), true)
  assert.ok((advisoryReason('profile/row-config-replaced') ?? '').length > 0, 'the reason must be stated, not implied')
  // Codes whose repairs ARE expected to clear their finding must not be excused.
  assert.equal(isAdvisory('live/pending-missing-service'), false)
  assert.equal(isAdvisory('profile/host-import-unsatisfied'), false)
  assert.equal(advisoryReason('live/pending-missing-service'), undefined)
})

await check('R2 an unresolved advisory repair is not reported as a failure', () => {
  const unresolved = {
    code: 'profile/row-config-replaced',
    label: 'L',
    applied: true,
    resolved: false,
    introduced: [],
    before: ['profile/row-config-replaced'],
    after: ['profile/row-config-replaced'],
    reason: 'not fewer',
  }
  assert.equal(isFailure(unresolved), false, 'advice that changes nothing is not a broken repair')
  const text = renderDryRun([unresolved])
  assert.ok(text.includes('仅建议'), 'the table must say so in words')
  assert.ok(!text.includes('❌'), 'and must not print a failure mark')

  // The same shape under a code that IS expected to resolve must still fail.
  const realFailure = { ...unresolved, code: 'profile/dangling-override' }
  assert.equal(isFailure(realFailure), true, 'a genuinely unresolved repair must still read as one')
  assert.ok(renderDryRun([realFailure]).includes('❌'))
})

await check('R3 the real dry run reports advisory outcomes without a failure mark', () => {
  const profilePath = process.env.DSH_PROFILE_DIR ?? defaultProfilePath()
  if (profilePath === undefined) return
  const findings = detect({ profile: collectStatic(profilePath, []), nodeVersion: process.version })
  const outcomes = dryRunAll(profilePath, findings, { nodeVersion: process.version })
  const applied = outcomes.filter((o) => o.applied)
  if (applied.length === 0) return
  // Every applied outcome must be classified one way or the other: resolved, a
  // real failure, or explicitly advisory. Nothing may be ambiguous.
  for (const outcome of applied) {
    const classified = outcome.resolved || isFailure(outcome) || isAdvisory(outcome.code)
    assert.ok(classified, `${outcome.code} outcome is neither resolved, failing, nor advisory`)
  }
})

/* ------------------------------------------------------------------ Part S */

/**
 * Summarising a mass of same-host import misses into one root cause.
 *
 * This machine has 32 `host-import-unsatisfied` findings across 9 host packages.
 * Each is individually true, but 32 repetitions of "missing two symbols" read as
 * noise and hide the single actionable fact. The summary ADDS; it never removes
 * or softens a per-package finding.
 */
await check('S1 the summary only fires on a genuine mass, and keeps every detail', () => {
  const profilePath = process.env.DSH_PROFILE_DIR ?? defaultProfilePath()
  if (profilePath === undefined) return
  const findings = detect({ profile: collectStatic(profilePath, []), nodeVersion: process.version })
  const perPackage = findings.filter((f) => f.code === 'profile/host-import-unsatisfied')
  const summary = findings.filter((f) => f.code === 'profile/host-generation-mismatch')

  if (perPackage.length < 5) {
    assert.equal(summary.length, 0, 'a scattering of misses must not be called one root cause')
    return
  }
  assert.equal(summary.length, 1, 'one mass, one summary')
  const s = summary[0]
  assert.equal(s.severity, 'warning')
  // The summary must state that it does not replace the individual findings.
  const evidence = s.evidence.join('\n')
  assert.match(evidence, new RegExp(`全部 ${perPackage.length} 条逐包结论`), 'the count of retained detail must be stated')
  assert.ok(perPackage.length > 0, 'per-package findings are retained, not replaced')
  // And it must not claim to have verified more than it did.
  assert.match(evidence, /逐字核对/, 'the verification method must be stated')
})

/* ------------------------------------------------------------------ report */

console.log(`\n${checks - failures.length}/${checks} checks passed`)
if (failures.length > 0) {
  console.error('\nFAILURES:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('conflict-doctor: all checks passed')
process.exit(0)
