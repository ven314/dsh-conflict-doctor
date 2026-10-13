/**
 * Verify the publish tarball ships exactly what a profile needs.
 *
 * `pnpm test` runs against `src/`, but an installed profile imports `lib/`. A
 * tarball missing `lib/index.js` passes every unit test and then does nothing
 * when installed, which is precisely the silent failure this whole project
 * exists to catch in others.
 *
 * Why not inline this in ci.yml: the obvious one-liner contains `': '` inside a
 * double-quoted scalar, which YAML rejects as a nested compact mapping — the
 * exact class of bug this file now prevents by existing.
 *
 * Usage:
 *   node test/check-tarball.mjs [maxFiles]
 *
 * Exit code 0 = the tarball is shippable.
 *
 * @module dsh-conflict-doctor/check-tarball
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_FILES = Number(process.argv[2] ?? 30)

/** Files without which an installed copy cannot be loaded or recognised. */
const REQUIRED = ['package.json', 'cordis.patch.yml', 'lib/index.js', 'README.md', 'LICENSE']

/** Directories that must never appear in a published tarball. */
const FORBIDDEN_PREFIXES = ['src/', 'test/', 'node_modules/', '.github/']

/**
 * Resolve npm's JS entry point.
 *
 * On Windows `npm` is a .cmd/.ps1 shim that `execFileSync` cannot spawn, and the
 * resulting ENOENT carries no diagnostics. Same workaround `release.mjs` uses.
 */
function npmEntry() {
  const candidates = [
    process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js') : undefined,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return undefined
}

const entry = npmEntry()
if (entry === undefined) {
  console.error('  SKIP npm entry point not found on this machine')
  process.exit(0)
}

let out
try {
  out = execFileSync(process.execPath, [entry, 'pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
} catch (error) {
  console.error('  FAIL npm pack --dry-run failed')
  console.error(`       ${(error.stderr ?? error.message).toString().trim().split('\n')[0]}`)
  process.exit(1)
}

let entries
try {
  entries = JSON.parse(out)[0]?.files ?? []
} catch {
  console.error('  FAIL could not parse `npm pack --json` output')
  process.exit(1)
}

const files = entries.map((entry) => entry.path)

console.log(`  tarball: ${files.length} file(s), cap ${MAX_FILES}`)
for (const file of files) console.log(`    - ${file}`)

const problems = []

for (const required of REQUIRED) {
  if (!files.includes(required)) problems.push(`missing required file: ${required}`)
}
for (const prefix of FORBIDDEN_PREFIXES) {
  const leaked = files.filter((file) => file.startsWith(prefix))
  if (leaked.length > 0) problems.push(`tarball leaks ${prefix} (${leaked.length} file(s): ${leaked.slice(0, 3).join(', ')})`)
}
if (files.length > MAX_FILES) problems.push(`too many files: ${files.length} > ${MAX_FILES}`)

console.log('\n  key checks:')
const checks = [
  ...REQUIRED.map((required) => [`ships ${required}`, files.includes(required)]),
  ['no source tree leaked', !problems.some((p) => p.startsWith('tarball leaks'))],
  [`file count within cap (${MAX_FILES})`, files.length <= MAX_FILES],
]
let failed = 0
for (const [label, ok] of checks) {
  if (!ok) failed += 1
  console.log(`    ${ok ? 'OK  ' : 'FAIL'} ${label}`)
}
if (problems.length > 0) {
  console.log('\n  problems:')
  for (const problem of problems) console.log(`    - ${problem}`)
}

process.exit(failed === 0 ? 0 : 1)
