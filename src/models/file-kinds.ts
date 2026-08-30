export type FileKind =
    | 'folder'
    | 'image'
    | 'script'
    | 'scene'
    | 'resource'
    | 'audio'
    | 'font'
    | 'text'
    | 'config'
    | 'file'

const IMAGE: readonly string[] = [
    'png',
    'jpg',
    'jpeg',
    'webp',
    'gif',
    'bmp',
    'ico',
    'tga',
    'tif',
    'tiff',
    'qoi',
    'hdr',
    'exr',
    'dds',
    'svg'
]

const BY_EXTENSION = new Map<string, FileKind>([
    ...IMAGE.map(extension => [extension, 'image'] as const),
    ...(['gd', 'cs', 'gdshader', 'glsl', 'shader'] as const).map(
        extension => [extension, 'script'] as const
    ),
    ...(['tscn', 'scn', 'escn'] as const).map(extension => [extension, 'scene'] as const),
    ...(['tres', 'res', 'material', 'theme', 'gdextension'] as const).map(
        extension => [extension, 'resource'] as const
    ),
    ...(['wav', 'ogg', 'mp3', 'flac'] as const).map(extension => [extension, 'audio'] as const),
    ...(['ttf', 'otf', 'woff', 'woff2', 'fnt'] as const).map(
        extension => [extension, 'font'] as const
    ),
    ...(['md', 'txt', 'rst'] as const).map(extension => [extension, 'text'] as const),
    ...(['godot', 'cfg', 'json', 'toml', 'yaml', 'yml', 'ini', 'import', 'uid'] as const).map(
        extension => [extension, 'config'] as const
    )
])

const GENERATED: readonly string[] = ['import', 'uid']

export function fileExtension(path: string): string {
    const name = path.slice(path.lastIndexOf('/') + 1)
    const dot = name.lastIndexOf('.')
    if (dot <= 0) return ''
    return name.slice(dot + 1).toLowerCase()
}

export function isGeneratedSidecar(path: string): boolean {
    return GENERATED.includes(fileExtension(path))
}

export function fileKind(path: string, isDirectory: boolean): FileKind {
    if (isDirectory) return 'folder'
    return BY_EXTENSION.get(fileExtension(path)) ?? 'file'
}

export function hasThumbnail(path: string, isDirectory: boolean): boolean {
    return !isDirectory && IMAGE.includes(fileExtension(path))
}
