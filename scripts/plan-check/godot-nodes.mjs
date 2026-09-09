// FIX 4b - resolve a runtime node path against the scene files.
//
// `/root/MainWorld/SwarmDirector` is wrong because MainWorld is instanced under
// PixelPerfectShell, and no single line of any .tscn says so: one file records
// SwarmDirector's parent, another records where MainWorld is mounted. So this
// builds the tree across files and walks the path against it.
//
// Godot only. A repo with no project.godot yields nothing.

import {readFileSync, existsSync, readdirSync, statSync} from 'node:fs'
import {join, relative} from 'node:path'

const NODE_RE = /^\[node name="([^"]+)"(?:[^\]]*?)\s(?:type|instance)=([^\s\]]+)/
const PARENT_RE = /\sparent="([^"]*)"/
const EXT_RE = /^\[ext_resource\s+type="PackedScene"[^\]]*path="res:\/\/([^"]+)"[^\]]*id="([^"]+)"/

export function isGodotRepo(repo) {
    return existsSync(join(repo, 'project.godot'))
}

function scenes(repo) {
    const out = []
    const walk = dir => {
        for (const d of readdirSync(dir, {withFileTypes: true})) {
            const p = join(dir, d.name)
            if (d.name.startsWith('.')) continue
            if (d.isDirectory()) walk(p)
            else if (d.name.endsWith('.tscn')) out.push(p)
        }
    }
    walk(repo)
    return out
}

/** One scene's nodes: name, parent path (Godot's own "." / "A/B" form), and
 *  the sub-scene it instances, if any. */
function parseScene(file) {
    const text = readFileSync(file, 'utf8')
    const ext = new Map()
    for (const line of text.split('\n')) {
        const e = line.match(EXT_RE)
        if (e) ext.set(e[2].replace(/"/g, ''), e[1])
    }
    const nodes = []
    for (const line of text.split('\n')) {
        const m = line.match(NODE_RE)
        if (!m) continue
        const parent = line.match(PARENT_RE)?.[1] ?? null
        const inst =
            m[2].startsWith('ExtResource') ?
                ext.get(m[2].replace(/ExtResource\(?"?|"?\)?/g, ''))
            :   null
        nodes.push({name: m[1], parent, instances: inst ?? null})
    }
    return nodes
}

/** Children of `path` within one scene, following an instanced sub-scene into
 *  its own root's children. */
function childrenAt(repo, sceneFile, path) {
    const nodes = parseScene(sceneFile)
    const root = nodes.find(n => n.parent === null)
    if (!root) return []
    if (path.length === 0) return [{name: root.name, scene: sceneFile, node: root}]
    if (path[0] !== root.name) return []
    let inner = path.slice(1)
    // Walk down this scene as far as its own nodes go.
    for (;;) {
        const key = inner.length === 0 ? '.' : inner.join('/')
        const kids = nodes.filter(n => n.parent === key)
        if (inner.length === 0) return kids.map(n => ({name: n.name, scene: sceneFile, node: n}))
        const here = nodes.find(
            n => (n.parent === '.' ? n.name : `${n.parent}/${n.name}`) === inner.join('/')
        )
        if (!here) return []
        if (here.instances) {
            // Cross into the instanced scene; its root IS this node.
            const sub = join(repo, here.instances)
            if (!existsSync(sub)) return []
            const subNodes = parseScene(sub)
            const subRoot = subNodes.find(n => n.parent === null)
            return subNodes
                .filter(n => n.parent === '.')
                .map(n => ({name: n.name, scene: sub, node: n}))
        }
        return kids.map(n => ({name: n.name, scene: sceneFile, node: n}))
    }
}

/**
 * Can `/root/Foo/Bar` be reached in this repo? Returns the scenes where the
 * full path resolves. Empty means no scene produces it.
 *
 * `/root/X` is the scene root of any scene whose root node is named X, because
 * a scene run as the main scene is mounted directly under /root.
 */
export function resolveNodePath(repo, nodePath) {
    const parts = nodePath
        .replace(/^\/root\/?/, '')
        .split('/')
        .filter(Boolean)
    if (parts.length === 0) return []
    const hits = []
    for (const scene of scenes(repo)) {
        let cur = [parts[0]]
        const nodes = parseScene(scene)
        const root = nodes.find(n => n.parent === null)
        if (!root || root.name !== parts[0]) continue
        let ok = true
        for (const seg of parts.slice(1)) {
            const kids = childrenAt(repo, scene, cur)
            if (!kids.some(k => k.name === seg)) {
                ok = false
                break
            }
            cur.push(seg)
        }
        if (ok) hits.push(relative(repo, scene))
    }
    return hits
}

/** Where a node of this name actually lives, for a "did you mean" line. */
export function findNodeByName(repo, name) {
    const out = []
    for (const scene of scenes(repo)) {
        for (const n of parseScene(scene)) {
            if (n.name === name)
                out.push(`${relative(repo, scene)} (parent="${n.parent ?? 'ROOT'}")`)
        }
    }
    return out
}

/**
 * The precise check: a runtime node path is only meaningful relative to the
 * scene that was RUN. `/root/MainWorld/SwarmDirector` resolves under
 * main_world.tscn and not under main.tscn, whose root is `Main` - so a plan
 * that runs main.tscn and then inspects that path is naming a node that will
 * not be there.
 *
 * Returns {ok, root, why}. An unreadable or missing scene yields ok:null, which
 * the caller reports as undecided rather than as a finding.
 */
export function checkNodePathInScene(repo, sceneRel, nodePath) {
    const scene = join(repo, sceneRel)
    if (!existsSync(scene)) return {ok: null, why: `run scene ${sceneRel} does not exist`}
    const nodes = parseScene(scene)
    const root = nodes.find(n => n.parent === null)
    if (!root) return {ok: null, why: `${sceneRel} declares no root node`}
    const parts = nodePath
        .replace(/^\/root\/?/, '')
        .split('/')
        .filter(Boolean)
    if (parts.length === 0) return {ok: null, why: 'empty node path'}
    if (parts[0] !== root.name) {
        return {
            ok: false,
            root: root.name,
            why: `${sceneRel} roots at \`${root.name}\`, not \`${parts[0]}\``
        }
    }
    let cur = [parts[0]]
    for (const seg of parts.slice(1)) {
        const kids = childrenAt(repo, scene, cur)
        if (!kids.some(k => k.name === seg)) {
            return {
                ok: false,
                root: root.name,
                why: `no child \`${seg}\` under \`/${cur.join('/')}\``
            }
        }
        cur.push(seg)
    }
    return {ok: true, root: root.name, why: 'resolves'}
}
