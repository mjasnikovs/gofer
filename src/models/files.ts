export type WorkspaceFileContents = Readonly<{
    path: string
    text: string
    hash: string
    bytes: number
}>

export type WorkspaceFileStamp = Readonly<{
    path: string
    hash: string
    bytes: number
}>

export type WorkspaceChangeKind = 'created' | 'modified' | 'removed'

export type WorkspaceFileChange = Readonly<{
    path: string
    kind: WorkspaceChangeKind
}>

/**
 * Every write states the hash it expects to replace. `expectedHash` is absent only when the caller
 * claims the file does not exist yet; a mismatch fails with `file_conflict` instead of overwriting.
 */
export type WriteWorkspaceFileRequest = Readonly<{
    path: string
    text: string
    expectedHash?: string | undefined
}>

export type EditWorkspaceFileRequest = Readonly<{
    path: string
    expectedHash: string
    find: string
    replace: string
}>

export type DeleteWorkspacePathRequest = Readonly<{
    path: string
    expectedHash?: string | undefined
}>

export type MoveWorkspacePathRequest = Readonly<{
    from: string
    to: string
}>

/** The structured failure every workspace file command rejects with. */
export type WorkspaceFileError = Readonly<{
    code: string
    message: string
    retryable: boolean
    details: Readonly<Record<string, unknown>>
}>
