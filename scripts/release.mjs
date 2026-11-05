// Publishes a new version: node scripts/release.mjs [patch|minor|major]
// Bumps package.json, builds, and uploads the installer, blockmap and latest.yml to qpsychocode/stub-releases.
// Every running STUB picks the release up from there.
import { execFileSync, execSync } from 'node:child_process'
import { copyFileSync, readFileSync } from 'node:fs'

const REPO = 'qpsychocode/stub-releases'
const level = process.argv[2] ?? 'patch'
if (!['patch', 'minor', 'major'].includes(level)) throw new Error(`unknown level: ${level}`)
const run = (cmd) => execSync(cmd, { stdio: 'inherit' })

run('npm run typecheck')
run(`npm version ${level} --no-git-tag-version`)
run('npm run dist')
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
// latest.yml goes last on purpose: running apps only see a version once all of its files are there.
const tag = `v${version}`
// A stable name for the website's download button; updates use the versioned file.
copyFileSync(`dist/STUB-Setup-${version}.exe`, 'dist/STUB-Setup.exe')
execFileSync('gh', ['release', 'create', tag, '--repo', REPO, '--title', version, '--notes', `STUB ${version}`, `dist/STUB-Setup-${version}.exe`, `dist/STUB-Setup-${version}.exe.blockmap`, 'dist/STUB-Setup.exe'], { stdio: 'inherit' })
execFileSync('gh', ['release', 'upload', tag, 'dist/latest.yml', '--repo', REPO], { stdio: 'inherit' })
