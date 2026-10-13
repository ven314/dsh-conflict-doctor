/**
 * Verify the built artifact is importable and exports what a host expects.
 *
 * This runs against `lib/` — the files actually published — not `src/`. It
 * catches the failure mode where the package builds, tests pass, and the
 * installed plugin then exports nothing a host can call.
 *
 * Why a file and not an inline `node -e` in ci.yml: the one-liner contains
 * `': '` inside a double-quoted YAML scalar, which YAML rejects as a nested
 * compact mapping. Twice is twice too many, so it lives here where it is also
 * runnable locally.
 *
 * Exit code 0 = the entry point resolves and exports the required members.
 *
 * @module dsh-conflict-doctor/check-entry
 */
const EXPECTED_EXPORTS = ['apply', 'detect', 'runAudit', 'collectLive', 'collectStatic']

let mod
try {
  mod = await import('../lib/index.js')
} catch (error) {
  console.error('  FAIL lib/index.js could not be imported')
  console.error(`       ${error.message}`)
  console.error('       (run `pnpm build` first)')
  process.exit(1)
}

const names = Object.keys(mod)
console.log(`  exports (${names.length}): ${names.join(', ')}`)

let failed = 0
console.log('\n  key checks:')
for (const expected of EXPECTED_EXPORTS) {
  const ok = typeof mod[expected] !== 'undefined'
  if (!ok) failed += 1
  console.log(`    ${ok ? 'OK  ' : 'FAIL'} exports ${expected}${ok ? ` (${typeof mod[expected]})` : ''}`)
}

const applyIsFunction = typeof mod.apply === 'function'
if (!applyIsFunction) failed += 1
console.log(`    ${applyIsFunction ? 'OK  ' : 'FAIL'} apply is callable`)

const injectIsArray = Array.isArray(mod.inject)
if (!injectIsArray) failed += 1
console.log(`    ${injectIsArray ? 'OK  ' : 'FAIL'} inject is the cordis declaration array`)

process.exit(failed === 0 ? 0 : 1)
