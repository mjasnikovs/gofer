/** A project value that changed under a screen that may be showing it. */
export type ProjectValue = 'memories' | 'sketches' | 'changes' | 'board'

export type ProjectChange = Readonly<{what: ProjectValue}>
