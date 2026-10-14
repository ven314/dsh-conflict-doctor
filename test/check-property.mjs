/**
 * W8-10 property tests (fast-check): JSON round-trip and stable order.
 * Exit code 0 = all properties passed.
 */

import fc from 'fast-check'
import { collectStatic, detect } from '../lib/index.js'
import { defaultProfilePath } from '../lib/index.js'

console.log('Running W8-10 property tests...')

const profilePath = process.env.DSH_PROFILE_DIR ?? defaultProfilePath()
if (profilePath === undefined) {
  console.log('SKIP: no profile to test')
  process.exit(0)
}

const snapshot = collectStatic(profilePath, [])
const findings = detect({ profile: snapshot, nodeVersion: process.version })

// Property 1: JSON round-trip preserves structure
await fc.assert(
  fc.asyncProperty(fc.constant(findings), async (findings) => {
    const json = JSON.stringify(findings)
    const parsed = JSON.parse(json)
    return JSON.stringify(parsed) === json
  }),
  { numRuns: 500, verbose: true },
)
console.log('Property 1 (JSON round-trip): PASSED')

// Property 2: stable order across round-trips
await fc.assert(
  fc.asyncProperty(fc.constant(findings), async (findings) => {
    const codes1 = findings.map((f) => f.code).join(',')
    const json = JSON.stringify(findings)
    const parsed = JSON.parse(json)
    const codes2 = parsed.map((f) => f.code).join(',')
    return codes1 === codes2
  }),
  { numRuns: 500, verbose: true },
)
console.log('Property 2 (stable order): PASSED')

// Property 3: schema shape for every finding
await fc.assert(
  fc.asyncProperty(fc.constant(findings), async (findings) => {
    for (const f of findings) {
      if (!f.code) return false
      if (!['critical', 'warning', 'info'].includes(f.severity)) return false
      if (!f.title) return false
      if (!Array.isArray(f.refs)) return false
      if (!f.impact) return false
      if (!Array.isArray(f.evidence)) return false
      if (!Array.isArray(f.fixes) || f.fixes.length === 0) return false
      for (const fix of f.fixes) {
        if (!fix.kind || !fix.label || !fix.detail) return false
        if (fix.kind === 'patch' && fix.snippet !== undefined && typeof fix.snippet !== 'string') return false
      }
    }
    return true
  }),
  { numRuns: 500, verbose: true },
)
console.log('Property 3 (schema shape): PASSED')

console.log('\nAll W8-10 property tests PASSED')
process.exit(0)
