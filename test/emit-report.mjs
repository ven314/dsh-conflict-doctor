/**
 * Emit the audit report for this machine, consulting the live host the way the
 * plugin does. One-off generator; the deliverable is the markdown it writes.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { collectStatic, defaultProfilePath, detect, renderMarkdown } from '../lib/index.js'

const profilePath = defaultProfilePath()
// The versions the RUNNING packaged app reports for its bundles.
const live = { '@deepseek-ai/dsh-base': '0.2.0-rc.2', '@deepseek-ai/dsh-web-app': '0.2.0-rc.2' }

const snapshot = collectStatic(profilePath, [], live)
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
    `运行中的宿主是 @deepseek-ai/dsh-base@${live['@deepseek-ai/dsh-base']}（打包应用自带），` +
      `而 profiles/node_modules 里的副本是 ${snapshot.hostVersion}——两者不是同一代。`,
    '因此 peer 范围与导入符号这两类「需要与运行宿主逐条比对」的检查被跳过：用旧副本比对会产出并不存在的冲突（这一点已被实测证伪过一次）。',
    ...snapshot.notes,
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
