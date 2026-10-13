/**
 * Self-contained verification for dsh-conflict-doctor.
 *
 * Part A —pure detector fixtures: every detector fires on a crafted conflict
 *          and stays silent on a clean composition.
 * Part B —the real running profile on this machine: the static scanner must
 *          read actual patch layers and produce a report without throwing.
 * Part C —integration: the plugin's `apply()` loads into a real Cordis
 *          container and registers its tool and command.
 *
 * Run: node test/run.mjs
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
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
await check('B5 a stale on-disk host silences version claims but keeps structure', () => {
  const snapshot = collectStatic(defaultProfilePath())
  assert.notEqual(snapshot.versionAuthority, 'authoritative', 'this profile must not be treated as authoritative')
  const findings = detect({ profile: snapshot, nodeVersion: process.version })
  assert.ok(
    !findings.some((finding) => finding.code === 'profile/peer-range-unsatisfied'),
    `peer claims must be suppressed without authority; got ${JSON.stringify(findings.map((f) => f.code))}`,
  )
  assert.ok(
    !findings.some((finding) => finding.code === 'profile/host-import-unsatisfied'),
    'import claims must be suppressed without authority',
  )
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
    'the coverage note must disclose why version claims were withheld',
  )
  console.log(`[Part B] authority=${snapshot.versionAuthority}, version-sensitive findings suppressed`)
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

/* ------------------------------------------------------------------ report */

console.log(`\n${checks - failures.length}/${checks} checks passed`)
if (failures.length > 0) {
  console.error('\nFAILURES:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('conflict-doctor: all checks passed')
process.exit(0)
