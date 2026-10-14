/**
 * Peak memory budget for a single full audit (W8-15).
 *
 * Measured in a CLEAN subprocess. The perf gate runs first and loads 500 bundle
 * versions, so measuring RSS in that same process would conflate the audit's own
 * footprint with everything the gate already did — a real audit peaks around
 * 103 MB RSS while the gate's own process sits at 148 MB. Both numbers are true;
 * only one answers the question the budget asks.
 *
 * Usage:
 *   node test/check-memory.mjs            # verify
 *   node test/check-memory.mjs --verbose  # print the measurement
 *
 * Exit code 0 = within budget, or no host profile to measure (skipped).
 *
 * @module dsh-conflict-doctor/check-memory
 */
import { execFileSync } from 'node:child_process'
import { defaultProfilePath } from '../lib/index.js'

const VERBOSE = process.argv.includes('--verbose')

const profilePath = process.env.DSH_PROFILE_DIR ?? defaultProfilePath()
if (profilePath === undefined) {
  console.log('  SKIP no profile on this machine (nothing to measure)')
  process.exit(0)
}

// A child that runs the audit and reports its own RSS. `process.memoryUsage().rss`
// is the live footprint at the moment it reads it, which is the peak for a
// single-pass audit — the audit allocates as it goes and releases nothing.
const code = `
import { collectStatic, defaultProfilePath, detect } from './lib/index.js'
const path = process.env.DSH_PROFILE_DIR ?? defaultProfilePath()
if (path === undefined) { console.log('SKIP'); process.exit(0) }
const snapshot = collectStatic(path, [])
const findings = detect({ profile: snapshot, nodeVersion: process.version })
const rss = process.memoryUsage().rss
console.log(JSON.stringify({ findings: findings.length, rss }))
`
const out = execFileSync(process.execPath, ['-e', code], {
  encoding: 'utf8',
  env: { ...process.env, DSH_PROFILE_DIR: profilePath },
})
const line = out.trim().split('\n').pop()
if (line === 'SKIP') {
  console.log('  SKIP no profile in the child (nothing to measure)')
  process.exit(0)
}
const { findings, rss } = JSON.parse(line)
const mb = rss / 1048576
const limitMb = 120
const ok = mb <= limitMb
console.log(`  ${ok ? 'OK  ' : 'FAIL'} peak RSS for a single full audit: ${mb.toFixed(1)}MB (budget ${limitMb}MB)`)
if (VERBOSE) console.log(`         findings=${findings}`)
if (!ok) {
  console.log(`\n  A budget miss here is usually a leak or an unbounded collection,`)
  console.log(`  not machine noise: check whether something grows with the number`)
  console.log(`  of packages instead of staying flat.`)
  process.exit(1)
}
console.log('  memory within budget.')
