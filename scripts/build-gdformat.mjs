import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {
    appendFile,
    chmod,
    copyFile,
    mkdir,
    readFile,
    readdir,
    rm,
    writeFile
} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {basename, dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sidecarDirectory = join(root, 'src-tauri/sidecar')
const buildDirectory =
    process.env.GOFER_GDFORMAT_BUILD_DIR ?? join(root, 'src-tauri/target/gdformat-build')

const manifest = JSON.parse(await readFile(join(root, 'protocol/gdformat-sidecar.json'), 'utf8'))
const binaryName = manifest.targets[process.platform]
if (!binaryName) {
    throw new Error(`No pinned gdformat sidecar target for platform ${process.platform}`)
}

function run(command, arguments_, options = {}) {
    const result = spawnSync(command, arguments_, {encoding: 'utf8', ...options})
    if (result.error) throw result.error
    return result
}

function must(label, command, arguments_, options = {}) {
    const result = run(command, arguments_, options)
    if (result.status === 0) return result
    const output = result.stderr || result.stdout || ''
    throw new Error(`${label} failed (exit ${String(result.status)}):\n${output}`)
}

function hostPython() {
    const candidates = process.env.GOFER_PYTHON ? [process.env.GOFER_PYTHON] : ['python3', 'python']
    for (const candidate of candidates) {
        if (run(candidate, ['--version']).status === 0) return candidate
    }
    throw new Error(
        'A Python 3 interpreter is required to freeze the gdformat sidecar. Install one, or set '
            + 'GOFER_PYTHON to its path.'
    )
}

const windows = process.platform === 'win32'
const venv = join(buildDirectory, 'venv')
const venvPython = join(venv, windows ? 'Scripts/python.exe' : 'bin/python')

await rm(buildDirectory, {recursive: true, force: true})
await mkdir(buildDirectory, {recursive: true})

const python = hostPython()
process.stdout.write(`Freezing gdformat ${manifest.version} with ${python}\n`)
must('Creating the build virtual environment', python, ['-m', 'venv', venv])
must('Upgrading pip', venvPython, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip'])
must('Installing the pinned requirements', venvPython, [
    '-m',
    'pip',
    'install',
    '--quiet',
    ...manifest.requirements,
    ...manifest.builder
])

const [module, attribute] = manifest.entryPoint.split(':')
const entry = join(buildDirectory, 'gdformat_entry.py')
await writeFile(
    entry,
    `import sys\nfrom ${module} import ${attribute}\n\n`
        + 'if __name__ == "__main__":\n'
        + '    sys.argv[0] = sys.argv[0].removesuffix(".exe")\n'
        + `    sys.exit(${attribute}())\n`,
    'utf8'
)

const distribution = join(buildDirectory, 'dist')
must('Freezing gdformat', venvPython, [
    '-m',
    'PyInstaller',
    '--onefile',
    '--clean',
    '--noconfirm',
    '--name',
    'gdformat',
    '--distpath',
    distribution,
    '--workpath',
    join(buildDirectory, 'work'),
    '--specpath',
    join(buildDirectory, 'spec'),
    ...manifest.collect.flatMap(name => ['--collect-all', name]),
    entry
])

const frozen = join(distribution, binaryName)
if (!existsSync(frozen)) throw new Error(`PyInstaller produced no executable at ${frozen}`)

function normalize(name) {
    return name.toLowerCase().replaceAll(/[-_.]+/g, '-')
}

async function collectLicences() {
    const shipped = new Set(manifest.requirements.map(pin => normalize(pin.split('==')[0])))
    const libraries = JSON.parse(
        must('Locating the build environment packages', venvPython, [
            '-c',
            'import json, site; print(json.dumps(site.getsitepackages()))'
        ]).stdout
    )
    const sections = []
    const covered = new Set()
    for (const library of libraries) {
        if (!existsSync(library)) continue
        for (const entry_ of (await readdir(library)).sort()) {
            if (!entry_.endsWith('.dist-info')) continue
            const name = entry_.replace(/\.dist-info$/, '')
            const distribution_ = normalize(name.replace(/-[^-]+$/, ''))
            if (!shipped.has(distribution_)) continue
            const directory = join(library, entry_)
            const files = await readdir(directory, {recursive: true, withFileTypes: true})
            const licences = files
                .filter(file => file.isFile() && /^(licen[cs]e|copying)/i.test(file.name))
                .map(file => join(file.parentPath, file.name))
                .sort()
            for (const file of licences) {
                const text = (await readFile(file, 'utf8')).trim()
                sections.push(`## ${name} — ${basename(file)}\n\n\`\`\`\n${text}\n\`\`\`\n`)
                covered.add(distribution_)
            }
        }
    }
    const missing = [...shipped].filter(name => !covered.has(name))
    if (missing.length > 0) {
        throw new Error(`No licence was found for ${missing.join(', ')}; the sidecar cannot ship`)
    }
    const interpreter = must('Reading the interpreter version', venvPython, [
        '-c',
        'import platform; print(platform.python_version())'
    ]).stdout.trim()
    return (
        '# gdformat sidecar licences\n\n'
        + `Gofer ships this directory's \`${binaryName}\` as a frozen, single-file executable `
        + `containing gdtoolkit ${manifest.version}, the packages listed below, and CPython `
        + `${interpreter} — the Python Software Foundation License Version 2, `
        + 'https://docs.python.org/3/license.html. None of it is compiled into Gofer; the sidecar '
        + 'is launched as a separate process and its licences travel with it.\n\n'
        + `This file is generated by \`scripts/build-gdformat.mjs\`.\n\n`
        + sections.join('\n')
    )
}

const licences = await collectLicences()

const version = must('Running the frozen gdformat', frozen, ['--version']).stdout.trim()
if (version !== `gdformat ${manifest.version}`) {
    throw new Error(`The frozen sidecar reports ${version}, not gdformat ${manifest.version}`)
}

for (const fixture of manifest.proof) {
    const parsed = run(frozen, ['--check', join(root, fixture)])
    if (parsed.status !== 0 && parsed.status !== 1) {
        throw new Error(`The frozen sidecar could not parse ${fixture}:\n${parsed.stderr}`)
    }
}

const probe = await readFile(join(root, manifest.proof[0]), 'utf8')
const once = must('Formatting the probe fixture', frozen, ['-'], {input: probe}).stdout
const twice = must('Re-formatting the probe fixture', frozen, ['-'], {input: once}).stdout
if (once !== twice) throw new Error(`The frozen sidecar is not idempotent on ${manifest.proof[0]}`)

const broken = run(frozen, ['-'], {input: 'func broken(:\n\tpass\n'})
if (broken.status === 0 || broken.stdout !== '') {
    throw new Error('The frozen sidecar produced output for invalid syntax; it must write nothing')
}

const installed = join(sidecarDirectory, binaryName)
await mkdir(sidecarDirectory, {recursive: true})
await copyFile(frozen, installed)
if (!windows) await chmod(installed, 0o755)

const digest = createHash('sha256')
    .update(await readFile(installed))
    .digest('hex')
await writeFile(
    join(sidecarDirectory, `${binaryName}.sha256`),
    `${digest}  ${binaryName}\n`,
    'utf8'
)
await writeFile(join(sidecarDirectory, 'LICENSES.md'), licences, 'utf8')

process.stdout.write(`${installed}\nsha256 ${digest}\n`)
if (process.env.GITHUB_ENV) {
    await appendFile(process.env.GITHUB_ENV, `GOFER_GDFORMAT=${installed}\n`)
}
