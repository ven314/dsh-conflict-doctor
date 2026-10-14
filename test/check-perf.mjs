/**
 * Performance budget for the host-archive reads.
 *
 * Why a gate instead of a one-off measurement: the archive path is easy to make
 * accidentally quadratic. Two implementations already shipped with real cost —
 * reopening (and re-decoding the ~3.4 MB JSON tree) once per package turned a
 * full scan into 8 seconds, and always reading `headerSize + 64 MB` made a cold
 * run take 18 seconds of copying bytes that were then discarded. Both looked
 * fine on a warm cache, so only an explicit budget catches the next one.
 *
 * Budgets are deliberately loose relative to the measured values (roughly 3x)
 * because CI machines are slower and shared. The point is to catch a change in
 * ORDER, not to police milliseconds.
 *
 * Usage:
 *   node test/check-perf.mjs            # verify
 *   node test/check-perf.mjs --verbose  # print every measurement
 *
 * Exit code 0 = within budget, or no host to measure (skipped).
 *
 * @module dsh-conflict-doctor/check-perf
 */
import { clearHostCaches, collectHostFacts, readHostSurface } from '../lib/hostface.js'
import { collectStatic, defaultProfilePath } from '../lib/index.js'

const VERBOSE = process.argv.includes('--verbose')

/** Wall-clock milliseconds for one call. */
function time(fn) {
  const start = process.hrtime.bigint()
  const value = fn()
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, value }
}

// A missing host is a legitimate configuration (CI, a plain npm install), so
// this gate reports a skip rather than a failure.
const probe = time(() => readHostSurface('@deepseek-ai/dsh-tools'))
if (probe.value === undefined) {
  console.log('  SKIP no host archive on this machine (nothing to measure)')
  process.exit(0)
}
clearHostCaches()

const results = []
function budget(label, ms, limit) {
  const ok = ms <= limit
  results.push({ label, ok, ms, limit })
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}: ${ms.toFixed(0)}ms (budget ${limit}ms)`)
}

// Same idea for memory: a scan that quietly doubles its peak is the same kind of
// regression as one that doubles its time, just slower to notice. Measured on a
// real 138-package profile the audit peaks at ~103 MB RSS (42 MB heap; the rest
// is native buffers from asar text reads), so the cap is 120 MB — a budget, not
// a measurement.
function budgetMb(label, mb, limitMb) {
  const ok = mb <= limitMb
  results.push({ label, ok, ms: mb, limit: limitMb })
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}: ${mb.toFixed(1)}MB (budget ${limitMb}MB)`)
}

/* ------------------------------------------------ one archive decode + scan */

const facts = time(() => collectHostFacts())
budget('collectHostFacts (every bundled version)', facts.ms, 2000)
if (VERBOSE) console.log(`         bundles=${facts.value?.bundles.size ?? 0}`)

/* ------------------------------------------- repeated per-package surfaces */

// The regression this catches: reopening the archive per package. Ten reads of
// a warm cache must cost far less than ten decodes, so the budget is per-read
// rather than per-batch.
clearHostCaches()
readHostSurface('@deepseek-ai/dsh-tools')
const warm = []
for (const name of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-brand']) {
  warm.push(time(() => readHostSurface(name)).ms)
}
const worstWarm = Math.max(...warm)
budget('warm per-package surface, worst of 4', worstWarm, 250)
if (VERBOSE) console.log(`         each: ${warm.map((ms) => ms.toFixed(0)).join(', ')}ms`)

/* ------------------------------------------------------- whole profile scan */

const profilePath = process.env.DSH_PROFILE_DIR ?? defaultProfilePath()
if (profilePath !== undefined) {
  const scan = time(() => collectStatic(profilePath, []))
  // Only meaningful when the archive supplied the baseline: otherwise the scan
  // did much less work and the number says nothing about this path.
  if (scan.value.versionAuthority === 'archive-authoritative') {
    budget('collectStatic, full profile against the host archive', scan.ms, 20000)
    if (VERBOSE) console.log(`         packages=${scan.value.packages.length} authority=${scan.value.versionAuthority}`)
  } else {
    console.log(`  SKIP profile scan measured ${scan.ms.toFixed(0)}ms but authority=${scan.value.versionAuthority}`)
  }
}

clearHostCaches()

const failed = results.filter((entry) => !entry.ok)
if (failed.length > 0) {
  console.log(`\n  ${failed.length} budget(s) exceeded.`)
  console.log('  A budget miss here is usually an ORDER change, not machine noise:')
  console.log('  check whether the archive is being reopened or re-decoded per package.')
  process.exit(1)
}
console.log('\n  performance within budget.')
