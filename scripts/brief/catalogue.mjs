export const BRIEF_PHASES = [
    {name: 'refine', field: 'refined'},
    {name: 'research', field: 'research'},
    {name: 'grill', field: 'qa'},
    {name: 'compose', field: 'spec'}
]

export const BRIEF_STATUSES = ['running', 'done', 'failed', 'stopped']

export const RESEARCH_SECTIONS = ['FILES', 'APIS', 'CONTEXT', 'TOOLING']

export const WORKER_KINDS = ['ok', 'empty', 'runaway']

export const BRIEF_EVENTS = [
    'brief-started',
    'brief-phase-start',
    'brief-phase',
    'brief-worker',
    'brief-worker-step',
    'brief-worker-done',
    'brief-question-settled',
    'brief-cost',
    'brief-log',
    'brief-stopped',
    'brief-failed'
]
