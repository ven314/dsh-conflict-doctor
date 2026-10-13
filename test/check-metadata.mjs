/** Validate the publish metadata by behaviour, not by eye. */
import { readFileSync } from 'node:fs'
import { satisfies } from 'semver'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

console.log('  name:         ', pkg.name)
console.log('  version:      ', pkg.version)
console.log('  engines.node: ', pkg.engines.node)
console.log('  engines.dsh:  ', pkg.engines.dsh)
console.log('  dsh.bundle:   ', pkg.dsh.bundle.patch)
console.log('  compatibility:', Object.keys(pkg.dsh.compatibility.dshReleases).join(', '))
console.log('  description chars:', pkg.description.length, '(npm warns above 350)')
console.log('  files:', pkg.files.join(', '))
console.log('  exports:', JSON.stringify(pkg.exports))

console.log('\n  engines.dsh behaviour against real hosts:')
for (const host of ['0.1.0-rc.6', '0.1.7-rc.2', '0.2.0-rc.2']) {
  const ok = satisfies(host, pkg.engines.dsh, { includePrerelease: true })
  console.log(`    ${host.padEnd(12)} ${ok ? 'compatible' : 'NOT matched'}`)
}

console.log('\n  key checks:')
const script = (name) => typeof pkg.scripts?.[name] === 'string'
const gate = pkg.scripts?.prepublishOnly ?? ''
const checks = [
  ['name is the available one', pkg.name === 'dsh-conflict-doctor'],
  ['no publishConfig blocking public access', pkg.publishConfig === undefined || pkg.publishConfig.access === 'public'],
  ['lib is shipped', pkg.files.includes('lib')],
  ['patch file is shipped', pkg.files.includes('cordis.patch.yml')],
  ['LICENSE is shipped', pkg.files.includes('LICENSE')],
  [
    'peer deps are host-provided',
    '@deepseek-ai/dsh-tools' in pkg.peerDependencies && !('@deepseek-ai/dsh-tools' in pkg.dependencies),
  ],
  ['prepublishOnly gates the release', typeof pkg.scripts.prepublishOnly === 'string'],
  ['dsh keywords present', pkg.keywords.includes('dsh-plugin') && pkg.keywords.includes('deepseek-harness')],
  // W0-4: the release gate must actually run every verification we ship, or it
  // is decoration. Each entry below is a real script this repo has.
  ['prepublishOnly runs build and test', /pnpm build/.test(gate) && /pnpm test/.test(gate)],
  ['prepublishOnly runs the metadata gate', /check-metadata/.test(gate)],
  ['prepublishOnly runs the version gate', /check-version/.test(gate)],
  ['a version-check script exists', script('check:version')],
  ['a format check exists', script('format:check')],
]
let failed = 0
for (const [label, ok] of checks) {
  if (!ok) failed += 1
  console.log(`    ${ok ? 'OK  ' : 'FAIL'} ${label}`)
}
process.exit(failed === 0 ? 0 : 1)
