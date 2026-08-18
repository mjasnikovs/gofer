import {spawnSync} from 'node:child_process'
import {existsSync} from 'node:fs'

if (!existsSync('.git')) process.exit(0)

const configure = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {encoding: 'utf8'})
if (configure.status !== 0) throw new Error(configure.stderr || 'Could not configure Git hooks')
const verify = spawnSync('git', ['config', '--get', 'core.hooksPath'], {encoding: 'utf8'})
if (verify.status !== 0 || verify.stdout.trim() !== '.githooks') {
    throw new Error('Git hook installation could not be verified')
}
