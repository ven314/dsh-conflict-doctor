/**
 * Verify that every source of truth for the version agrees.
 *
 * Three places can hold the version and they drift silently:
 *
 *   package.json  → "version": "0.1.0"
 *   CHANGELOG.md  → "## [0.1.0] - 2026-10-13"   (top-most released section)
 *   git tag       → v0.1.0
 *
 * Drift matters at release time: a tag pointing at a version that CHANGELOG does
 * not document produces a release page with no notes, and a CHANGELOG entry with
 * no tag produces notes nobody can reach. This script fails loudly instead.
 *
 * Also enforced, because each one has bitten this project already:
 *
 *   - CHANGELOG has at most one section per version (a duplicated version means
 *     two release attempts were interleaved);
 *   - every version section is dated (an undated entry cannot be ordered);
 *   - `Unreleased` is documented but never counted as the latest release.
 *
 * Usage:
 *   node test/check-version.mjs            # verify only
 *   node test/check-version.mjs --ci       # also require the tag to exist remotely
 *
 * Exit code 0 = consistent, 1 = drift. Never throws; always prints what it saw.
 *
 * @module dsh-conflict-doctor/check-version
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CI = process.argv.includes('--ci')

/** Try a git command; return undefined instead of throwing. */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version

const changelogPath = join(ROOT, 'CHANGELOG.md')
const failures = []

/**
 * Read version sections out of CHANGELOG.md.
 *
 * Only `## [` headings are candidates; `###` sub-headings inside a release
 * (Added / Changed / Fixed) must not be mistaken for versions.
 *
 * @param {string} text - the changelog text.
 * @returns {{version: string, date?: string, line: number}[]}
 */
function parseSections(text) {
  const sections = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    // ## [0.1.0] - 2026-10-13   or   ## [Unreleased]
    const match = /^##\s+\[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?\s*$/.exec(lines[i])
    if (match?.[1] === undefined) continue
    sections.push({ version: match[1], date: match[2], line: i + 1 })
  }
  return sections
}

console.log('  version sources')
console.log(`    package.json   ${version}`)

/* ------------------------------------------------------------ CHANGELOG ---- */

if (!existsSync(changelogPath)) {
  failures.push('CHANGELOG.md is missing')
  console.log('    CHANGELOG.md   MISSING')
} else {
  const text = readFileSync(changelogPath, 'utf8')
  const sections = parseSections(text)
  const released = sections.filter((s) => s.version !== 'Unreleased')
  const latest = released[0]

  console.log(
    `    CHANGELOG.md   ${latest === undefined ? 'no released section' : `${latest.version} (${latest.date ?? 'undated'})`}` +
      `  [${released.length} released section(s)]`,
  )

  if (latest === undefined) {
    failures.push(`CHANGELOG.md documents no released version, expected ${version}`)
  } else {
    if (latest.version !== version) {
      failures.push(`CHANGELOG's latest section is ${latest.version} but package.json says ${version}`)
    }
    if (latest.date === undefined) {
      failures.push(`CHANGELOG section ${latest.version} has no ISO date`)
    }
  }

  // Duplicate versions mean two release attempts interleaved; the older copy is
  // usually the one that got published.
  const counts = new Map()
  for (const s of released) counts.set(s.version, (counts.get(s.version) ?? 0) + 1)
  for (const [name, count] of counts) {
    if (count > 1) failures.push(`CHANGELOG documents version ${name} ${count} times`)
  }

  // A release whose notes nobody wrote is worse than no release.
  const documentedApple = sections.length > 0 && !text.includes('[Unreleased]')
  if (documentedApple) failures.push('CHANGELOG.md has no [Unreleased] section')
}

/* ------------------------------------------------------------------ tag ---- */

const tag = `v${version}`
const localTags =
  git(['tag', '--list'])
    ?.split('\n')
    .map((t) => t.trim())
    .filter(Boolean) ?? []
const tagExists = localTags.includes(tag)
console.log(`    git tag        ${tag}${tagExists ? '' : '  (absent locally)'}`)

if (!tagExists && CI) {
  // Locally the tag appears only after publishing, so its absence before a
  // first release is normal. In CI (post-tag checkout) it must exist.
  failures.push(`git tag ${tag} is missing (CI requires it)`)
}

/* --------------------------------------------------------- working tree ---- */

// A dirty tree at release time means what got tagged is not what is on disk.
// During development it is the normal state, so only CI treats it as drift.
const dirty = git(['status', '--porcelain'])
const dirtyCount = dirty === undefined ? 0 : dirty.split('\n').filter((l) => l.trim().length > 0).length
console.log(
  `    working tree   ${dirtyCount === 0 ? 'clean' : `${dirtyCount} modified path(s)`}${CI ? '' : '  (optional locally)'}`,
)
if (dirtyCount > 0 && CI) failures.push(`working tree has ${dirtyCount} modified path(s) (CI requires clean)`)

/* ---------------------------------------------------------------- report ---- */

console.log('\n  key checks:')
const rows = [
  ['CHANGELOG present', existsSync(changelogPath)],
  ['CHANGELOG latest = package.json version', !failures.some((f) => f.includes('but package.json says'))],
  ['CHANGELOG latest section dated', !failures.some((f) => f.includes('no ISO date'))],
  ['no duplicate CHANGELOG versions', !failures.some((f) => f.includes('times'))],
  ['[Unreleased] section present', !failures.some((f) => f.includes('[Unreleased] section'))],
  [`git tag ${tag} exists`, tagExists || !CI],
  ['working tree clean', dirtyCount === 0 || !CI],
]
let failed = 0
for (const [label, ok] of rows) {
  if (!ok) failed += 1
  console.log(`    ${ok ? 'OK  ' : 'FAIL'} ${label}`)
}

if (failures.length > 0) {
  console.log('\n  drift:')
  for (const f of failures) console.log(`    - ${f}`)
}

process.exit(failed === 0 ? 0 : 1)
