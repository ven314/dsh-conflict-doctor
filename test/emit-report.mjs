/**
 * Emit the audit report for this machine, consulting the live host the way the
 * plugin does. One-off generator; the deliverable is the markdown it writes.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { attributionNote } from '../lib/attribution.js'
import { collectStatic, defaultProfilePath, detect, renderMarkdown } from '../lib/index.js'

const profilePath = defaultProfilePath()
// No artificial live versions: let the scanner consult the running host's own
// archive, exactly as the plugin does at runtime. Hardcoding 0.2.0-rc.2 here
// used to pin this report to `stale-disk` and hide every import finding.
const snapshot = collectStatic(profilePath, [])
const findings = detect({ profile: snapshot, nodeVersion: process.version })

const report = {
  generatedAt: new Date().toISOString(),
  profilePath,
  scope: 'profile',
  summary: {
    critical: findings.filter((f) => f.severity === 'critical').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
    liveEntries: 0,
    patchLayers: snapshot.layers.length,
    scannedPackages: snapshot.packages.length,
    declaredTools: Object.keys(snapshot.declaredTools).length,
  },
  findings,
  notes: [
    // Coverage notes come from the scan itself: which baseline was trusted, and
    // what could not be read. Nothing here hardcodes a host version.
    ...(snapshot.versionAuthorityReason === undefined ? [] : [snapshot.versionAuthorityReason]),
    ...(snapshot.hostOrigin === undefined
      ? []
      : [
          `版本敏感的结论（peer 范围、导入符号）以运行宿主的 ${snapshot.hostBundleVersions?.['@deepseek-ai/dsh-base'] ?? '未知版本'} 为准（` +
            `来源：${snapshot.hostOrigin}），而不是磁盘上的 ${snapshot.hostVersion ?? '未解析到版本'}。`,
        ]),
    ...snapshot.notes,
    // Shared with runAudit and the CLI, so this report cannot drift into
    // omitting that some name could not be attributed.
    ...(attributionNote(snapshot) === undefined ? [] : [attributionNote(snapshot)]),
  ],
}

// Portable output path: the repo root, one level above this package.
const out = fileURLToPath(new URL('../../conflict-doctor-report.md', import.meta.url))
writeFileSync(out, renderMarkdown(report) + '\n', 'utf8')
console.log(`wrote ${out}`)
console.log(
  `authority=${snapshot.versionAuthority} findings=${findings.length} layers=${snapshot.layers.length} packages=${snapshot.packages.length}`,
)
console.log('codes:', [...new Set(findings.map((f) => `${f.severity}:${f.code}`))].join('\n  '))
