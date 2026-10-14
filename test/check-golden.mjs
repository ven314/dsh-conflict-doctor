/**
 * Assert that a real profile still produces the same diagnosis.
 *
 * Fixtures prove the detectors are correct; only real data proves they are
 * useful. This walks whichever profiles exist on the machine (they vary by
 * install) and compares each finding's CODE SET against a golden file.
 *
 * Compared: finding codes with their severity, plus the coverage counts.
 * NOT compared: free text, timestamps, absolute paths, per-machine package
 * counts — those legitimately differ between machines and would make the gate
 * useless noise.
 *
 * The golden is deliberately a promise about **no new conflicts**: adding a
 * detector that fires on a healthy real profile is exactly the regression this
 * catches, because that is how the seven false positives happened.
 *
 * Usage:
 *   node test/check-golden.mjs            # compare
 *   node test/check-golden.mjs --update   # re-record after a deliberate change
 *
 * @module dsh-conflict-doctor/check-golden
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectStatic, detect } from '../lib/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GOLDEN_DIR = join(ROOT, 'test', 'golden')
const UPDATE = process.argv.includes('--update')

/** Profile roots to audit, in discovery order. */
function profileDirs() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const explicit = process.env.DSH_PROFILE_DIR
  if (explicit) return [explicit]
  const explicitNamed = process.env.DSH_PROFILE
  if (explicitNamed) return [join(home, 'profiles', explicitNamed)]
  const base = join(home, 'profiles')
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(base, entry.name))
    .filter((dir) => existsSync(join(dir, 'package.json')))
}

/** Reduce one audit to the stable part worth comparing. */
function digest(report) {
  // Counted, not listed: `profile/row-config-replaced` legitimately fires three
  // times on a healthy real profile. A plain list comparison cannot see one of
  // three identical entries disappear, which is the drift most likely to slip
  // through unnoticed.
  const counts = {}
  for (const f of report.findings) {
    const key = `${f.severity} ${f.code}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return {
    authority: report.authority,
    layers: report.layers,
    patchLayers: report.snapshot.layers.length,
    // W1-19: record WHICH host supplied the version baseline. Without this an
    // app update changes the findings and the gate reports "drift" with no way
    // to tell a regression from a new host. With it, the diff names the cause.
    hostOrigin: report.snapshot.hostOrigin ?? null,
    hostHostVersion: report.snapshot.hostBundleVersions?.['@deepseek-ai/dsh-base'] ?? null,
    diskHostVersion: report.snapshot.hostVersion ?? null,
    findings: Object.entries(counts)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, count]) => (count === 1 ? key : `${key} x${count}`)),
  }
}

const dirs = profileDirs()
if (dirs.length === 0) {
  console.log('  SKIP no DSH profile found on this machine (nothing to compare)')
  process.exit(0)
}

mkdirSync(GOLDEN_DIR, { recursive: true })

let failed = 0
for (const dir of dirs) {
  const name = dir.split(/[\\/]/).filter(Boolean).pop()
  // Empty live versions on purpose: this exercises the RUNNING HOST path, so the
  // golden pins what the archive actually proves — including which host it was.
  const snapshot = collectStatic(dir, [], undefined)
  const findings = detect({ profile: snapshot, nodeVersion: process.version })
  const current = digest({ authority: snapshot.versionAuthority, layers: snapshot.layers.length, snapshot, findings })

  const goldenPath = join(GOLDEN_DIR, `${name}.json`)
  console.log(`\n  profile: ${name}`)
  console.log(`    authority=${current.authority} layers=${current.patchLayers} findings=${current.findings.length}`)
  for (const line of current.findings) console.log(`      ${line}`)

  if (!existsSync(goldenPath) || UPDATE) {
    writeFileSync(goldenPath, JSON.stringify(current, null, 2) + '\n', 'utf8')
    console.log(`    RECORDED ${goldenPath}`)
    continue
  }

  const golden = JSON.parse(readFileSync(goldenPath, 'utf8'))
  const added = current.findings.filter((f) => !golden.findings.includes(f))
  const removed = golden.findings.filter((f) => !current.findings.includes(f))

  // A changed host moves the baseline on purpose. Reporting that as plain
  // "drift" would train the reader to re-record without looking, which is how a
  // real false positive gets waved through.
  const hostChanged =
    (golden.hostHostVersion ?? null) !== current.hostHostVersion || (golden.hostOrigin ?? null) !== current.hostOrigin
  if (hostChanged) {
    console.log(
      `    NOTE host changed since this golden was recorded: ` +
        `${golden.diskHostVersion ?? '?'} → disk ${current.diskHostVersion ?? '?'}, ` +
        `running ${golden.hostHostVersion ?? '?'} → ${current.hostHostVersion ?? '?'}`,
    )
  }

  const codesMatch = added.length === 0 && removed.length === 0
  if (!codesMatch) failed += 1

  console.log(
    `    ${codesMatch ? 'OK  ' : 'FAIL'} finding set unchanged` +
      (added.length ? `  +${JSON.stringify(added)}` : '') +
      (removed.length ? `  -${JSON.stringify(removed)}` : ''),
  )
  if (!codesMatch) {
    console.log(
      hostChanged
        ? '         The host moved, so this may be expected. Confirm each addition is real before re-recording.'
        : '         A NEW finding on a healthy real profile is a false positive until proven otherwise.',
    )
    console.log('         Review every addition; re-record only with evidence:')
    console.log(`         node test/check-golden.mjs --update`)
  }
}

console.log(failed === 0 ? '\n  goldens match.' : `\n  ${failed} profile(s) drifted.`)
process.exit(failed === 0 ? 0 : 1)
