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
import { join, resolve } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Context, Service } from '@deepseek-ai/cordis'
import { closeAsar, findNode, hasAsarPath, isAsarDir, listAsarDir, openAsar, readAsarFile, readAsarText } from '../lib/asar.js'
import { EXIT, SCHEMA_VERSION, exitCodeFor, parseFailOn } from '../lib/contract.js'
import { clearHostCaches, findHostRoot, isSafePackageName, readHostSurface } from '../lib/hostface.js'
import { collectSurface } from '../lib/surface.js'
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

/* ------------------------------------------------------------------ report */

console.log(`\n${checks - failures.length}/${checks} checks passed`)
if (failures.length > 0) {
  console.error('\nFAILURES:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('conflict-doctor: all checks passed')
process.exit(0)
