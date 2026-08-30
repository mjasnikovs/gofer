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

export type WorkspaceFileError = Readonly<{
    code: string
    message: string
    retryable: boolean
    details: Readonly<Record<string, unknown>>
}>
