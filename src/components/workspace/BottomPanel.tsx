import {useCallback, useMemo, useState} from 'react'
import {Badge} from '@astryxdesign/core/Badge'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {IconButton} from '@astryxdesign/core/IconButton'
import {Icon} from '@astryxdesign/core/Icon'
import {ChevronDownIcon, ChevronUpIcon} from '@heroicons/react/24/outline'
import {Divider} from '@astryxdesign/core/Divider'
import {Item} from '@astryxdesign/core/Item'
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {StatusDot} from '@astryxdesign/core/StatusDot'
import {Tab, TabList} from '@astryxdesign/core/TabList'
import {Text} from '@astryxdesign/core/Text'
import {TextInput} from '@astryxdesign/core/TextInput'
import {Toolbar} from '@astryxdesign/core/Toolbar'
import type {DebugSession} from '../../hooks/useDebugSession'
import {useLogHistory} from '../../hooks/useLogHistory'
import {useSessionLogs} from '../../hooks/useSessionLogs'
import {toGodotError} from '../../services/godot-session'
import type {GodotError, GodotLogSeverity, GodotSessionState} from '../../models/godot'
import type {ScriptDiagnostic} from '../../models/script'
import type {WorkspaceEntry} from '../../models/script'
import type {GodotCall} from '../../models/workspace'
import {PanelState} from './PanelState'

export type BottomTab = 'problems' | 'debugger' | 'output' | 'import'

type BottomPanelProps = Readonly<{
    tab: BottomTab
    onTabChange: (tab: BottomTab) => void
    isCollapsed: boolean
    onToggle: () => void
    call: GodotCall
    state: GodotSessionState
    diagnostics: Readonly<Record<string, readonly ScriptDiagnostic[]>>
    /** Owned by the frame: the Run control launches the very session this panel drives. */
    debug: DebugSession
    files: readonly WorkspaceEntry[]
    onOpenLocation: (path: string, line: number) => void
}>

type Problem = Readonly<{
    path: string
    line: number
    severity: number
    message: string
}>

const SEVERITY_LABEL = ['', 'Error', 'Warning', 'Information', 'Hint'] as const
const SEVERITY_VARIANT = ['neutral', 'error', 'warning', 'accent', 'neutral'] as const
const LOG_SEVERITIES: readonly GodotLogSeverity[] = ['info', 'warning', 'error']
/** Which output the panel is showing: the running editor's, or every recorded session's. */
type LogScope = 'session' | 'history'

function problems(diagnostics: Readonly<Record<string, readonly ScriptDiagnostic[]>>): Problem[] {
    return Object.entries(diagnostics)
        .flatMap(([path, entries]) =>
            entries.map(entry => ({
                path,
                line: entry.range.start.line + 1,
                severity: entry.severity ?? 1,
                message: entry.message
            }))
        )
        .sort(
            (left, right) =>
                left.severity - right.severity
                || left.path.localeCompare(right.path)
                || left.line - right.line
        )
}

/**
 * The bottom region: what is wrong, what the debugger is doing, what the editor printed, and what
 * the importer holds.
 *
 * Collapsing keeps the tab strip: an IDE's bottom panel is a place the user returns to, and hiding
 * its tabs as well would lose the only affordance that brings it back.
 */
export function BottomPanel({
    tab,
    onTabChange,
    isCollapsed,
    onToggle,
    call,
    state,
    diagnostics,
    debug,
    files,
    onOpenLocation
}: BottomPanelProps) {
    const [minSeverity, setMinSeverity] = useState<GodotLogSeverity>('info')
    const [contains, setContains] = useState('')
    const [scope, setScope] = useState<LogScope>('session')
    const [rescan, setRescan] = useState<GodotError>()
    const [isRescanning, setIsRescanning] = useState(false)
    const isOffline = state === 'offline' || state === 'error'
    const isOutput = !isCollapsed && tab === 'output'
    const logs = useSessionLogs({
        enabled: isOutput && scope === 'session' && !isOffline,
        minSeverity,
        contains
    })
    // The archive is searched, not followed: it holds the sessions that already stopped, so it
    // answers a query rather than a filter over what is on screen.
    const history = useLogHistory({enabled: isOutput && scope === 'history', query: contains})

    const listed = useMemo(() => problems(diagnostics), [diagnostics])
    const imported = useMemo(
        () =>
            files
                .filter(file => file.path.endsWith('.import'))
                .map(file => file.path.slice(0, -'.import'.length)),
        [files]
    )

    const runRescan = useCallback(() => {
        setIsRescanning(true)
        void call('resource.rescan')
            .then(() => {
                setRescan(undefined)
            })
            .catch((failure: unknown) => {
                setRescan(toGodotError(failure))
            })
            .finally(() => {
                setIsRescanning(false)
            })
    }, [call])

    const errorCount = listed.filter(problem => problem.severity === 1).length

    const debugToolbar = (
        <Toolbar
            label='Debugger controls'
            size='sm'
            dividers={['bottom']}
            startContent={
                <Text
                    type='supporting'
                    color='secondary'
                >
                    {debug.stopped ?
                        `Stopped: ${debug.stopped.reason}`
                    : debug.isLaunched ?
                        'Running'
                    :   'Not running'}
                </Text>
            }
            endContent={
                <HStack gap={1}>
                    <Button
                        label='Launch'
                        size='sm'
                        isDisabled={isOffline || debug.isLaunched || debug.isBusy}
                        clickAction={() => {
                            void debug.launch()
                        }}
                    />
                    <Button
                        label='Continue'
                        size='sm'
                        variant='ghost'
                        isDisabled={!debug.stopped || debug.isBusy}
                        clickAction={() => {
                            void debug.resume('continue')
                        }}
                    />
                    <Button
                        label='Pause'
                        size='sm'
                        variant='ghost'
                        isDisabled={!debug.isLaunched || Boolean(debug.stopped) || debug.isBusy}
                        clickAction={() => {
                            void debug.pause()
                        }}
                    />
                    <Button
                        label='Step over'
                        size='sm'
                        variant='ghost'
                        isDisabled={!debug.stopped || debug.isBusy}
                        clickAction={() => {
                            void debug.resume('stepOver')
                        }}
                    />
                    <Button
                        label='Step in'
                        size='sm'
                        variant='ghost'
                        isDisabled={!debug.stopped || debug.isBusy}
                        clickAction={() => {
                            void debug.resume('stepIn')
                        }}
                    />
                    <Button
                        label='Step out'
                        size='sm'
                        variant='ghost'
                        isDisabled={!debug.stopped || debug.isBusy}
                        clickAction={() => {
                            void debug.resume('stepOut')
                        }}
                    />
                    <Button
                        label='Terminate'
                        size='sm'
                        variant='ghost'
                        isDisabled={!debug.isLaunched || debug.isBusy}
                        clickAction={() => {
                            void debug.terminate()
                        }}
                    />
                </HStack>
            }
        />
    )

    return (
        <VStack
            gap={0}
            height='100%'
        >
            <HStack
                gap={2}
                width='100%'
                align='center'
                justify='between'
            >
                <StackItem
                    size='fill'
                    isScrollable
                >
                    <TabList
                        size='sm'
                        aria-label='Bottom panel views'
                        value={tab}
                        onChange={value => {
                            onTabChange(value as BottomTab)
                        }}
                    >
                        <Tab
                            value='problems'
                            label='Problems'
                            endContent={
                                errorCount > 0 ?
                                    <Badge
                                        variant='error'
                                        label={String(errorCount)}
                                    />
                                :   undefined
                            }
                        />
                        <Tab
                            value='debugger'
                            label='Debugger'
                        />
                        <Tab
                            value='output'
                            label='Output'
                        />
                        <Tab
                            value='import'
                            label='Import'
                        />
                    </TabList>
                </StackItem>
                <StackItem>
                    <HStack paddingInline={2}>
                        <IconButton
                            label={isCollapsed ? 'Show panel' : 'Hide panel'}
                            // Through `Icon`, which sizes the drawing: a bare Heroicon has only a
                            // `viewBox`, and WebKit — what the desktop renders in — draws that at
                            // nothing, leaving an empty button where the chevron should be.
                            icon={
                                <Icon
                                    icon={isCollapsed ? ChevronUpIcon : ChevronDownIcon}
                                    size='sm'
                                />
                            }
                            size='sm'
                            variant='ghost'
                            aria-expanded={!isCollapsed}
                            aria-controls='gofer-bottom-panel'
                            clickAction={onToggle}
                        />
                    </HStack>
                </StackItem>
            </HStack>
            <Divider />
            {isCollapsed ? null : (
                <StackItem
                    size='fill'
                    isScrollable
                >
                    <VStack
                        gap={0}
                        id='gofer-bottom-panel'
                        height='100%'
                    >
                        {tab === 'problems' && (
                            <PanelState
                                label='problem list'
                                isLoading={false}
                                isEmpty={listed.length === 0}
                                emptyTitle='No problems'
                                emptyDescription='Diagnostics arrive from Godot’s language server as scripts change.'
                            >
                                {listed.map(problem => (
                                    <Item
                                        key={`${problem.path}:${String(problem.line)}:${problem.message}`}
                                        as='div'
                                        density='compact'
                                        marker={
                                            <StatusDot
                                                variant={
                                                    SEVERITY_VARIANT[problem.severity] ?? 'neutral'
                                                }
                                                label={
                                                    SEVERITY_LABEL[problem.severity] ?? 'Diagnostic'
                                                }
                                            />
                                        }
                                        label={problem.message}
                                        labelLines={1}
                                        description={`${problem.path}:${String(problem.line)}`}
                                        onClick={() => {
                                            onOpenLocation(problem.path, problem.line)
                                        }}
                                    />
                                ))}
                            </PanelState>
                        )}
                        {tab === 'debugger' && (
                            <VStack
                                gap={0}
                                height='100%'
                            >
                                {debugToolbar}
                                <PanelState
                                    label='debugger state'
                                    isLoading={debug.isBusy && debug.frames.length === 0}
                                    error={debug.error}
                                    isEmpty={debug.frames.length === 0}
                                    emptyTitle='The game is not stopped'
                                    emptyDescription='Set a breakpoint in a script, then launch the game under the debugger.'
                                >
                                    <HStack
                                        gap={0}
                                        height='100%'
                                        align='stretch'
                                    >
                                        <VStack
                                            gap={0}
                                            width={280}
                                        >
                                            {debug.frames.map(frame => (
                                                <Item
                                                    key={frame.id}
                                                    as='div'
                                                    density='compact'
                                                    label={frame.name}
                                                    labelLines={1}
                                                    isSelected={debug.frameId === frame.id}
                                                    description={
                                                        frame.path ?
                                                            `${frame.path}:${String(frame.line)}`
                                                        :   `line ${String(frame.line)}`
                                                    }
                                                    onClick={() => {
                                                        void debug.selectFrame(frame.id)
                                                        if (frame.path)
                                                            onOpenLocation(frame.path, frame.line)
                                                    }}
                                                />
                                            ))}
                                        </VStack>
                                        <Divider orientation='vertical' />
                                        <StackItem
                                            size='fill'
                                            isScrollable
                                        >
                                            {debug.scopes.map(entry => (
                                                <VStack
                                                    key={entry.scope.variablesReference}
                                                    gap={0}
                                                >
                                                    <VStack
                                                        paddingInline={3}
                                                        paddingBlock={1}
                                                    >
                                                        <Text
                                                            type='supporting'
                                                            weight='semibold'
                                                        >
                                                            {entry.scope.name}
                                                        </Text>
                                                    </VStack>
                                                    {entry.variables.map(variable => (
                                                        <Item
                                                            key={`${entry.scope.name}:${variable.name}`}
                                                            as='div'
                                                            density='compact'
                                                            label={variable.name}
                                                            labelLines={1}
                                                            description={variable.value}
                                                            descriptionLines={1}
                                                            endContent={
                                                                variable.type ?
                                                                    <Text
                                                                        type='supporting'
                                                                        color='secondary'
                                                                    >
                                                                        {variable.type}
                                                                    </Text>
                                                                :   undefined
                                                            }
                                                        />
                                                    ))}
                                                </VStack>
                                            ))}
                                        </StackItem>
                                    </HStack>
                                </PanelState>
                            </VStack>
                        )}
                        {tab === 'output' && (
                            <VStack
                                gap={0}
                                height='100%'
                            >
                                <Toolbar
                                    label='Output filters'
                                    size='sm'
                                    dividers={['bottom']}
                                    startContent={
                                        <SegmentedControl
                                            label='Minimum severity'
                                            size='sm'
                                            value={minSeverity}
                                            onChange={value => {
                                                setMinSeverity(
                                                    LOG_SEVERITIES.find(
                                                        severity => severity === value
                                                    ) ?? 'info'
                                                )
                                            }}
                                        >
                                            <SegmentedControlItem
                                                value='info'
                                                label='All'
                                            />
                                            <SegmentedControlItem
                                                value='warning'
                                                label='Warnings'
                                            />
                                            <SegmentedControlItem
                                                value='error'
                                                label='Errors'
                                            />
                                        </SegmentedControl>
                                    }
                                    endContent={
                                        <HStack
                                            gap={2}
                                            align='center'
                                        >
                                            <SegmentedControl
                                                label='Output source'
                                                size='sm'
                                                value={scope}
                                                onChange={value => {
                                                    setScope(
                                                        value === 'history' ? 'history' : 'session'
                                                    )
                                                }}
                                            >
                                                <SegmentedControlItem
                                                    value='session'
                                                    label='Session'
                                                />
                                                <SegmentedControlItem
                                                    value='history'
                                                    label='History'
                                                />
                                            </SegmentedControl>
                                            <TextInput
                                                label={
                                                    scope === 'history' ? 'Search recorded output'
                                                    :   'Filter output'
                                                }
                                                isLabelHidden
                                                size='sm'
                                                placeholder={
                                                    scope === 'history' ? 'Search recorded output'
                                                    :   'Filter output'
                                                }
                                                value={contains}
                                                hasClear
                                                onChange={setContains}
                                            />
                                        </HStack>
                                    }
                                />
                                {scope === 'session' && logs.dropped > 0 ?
                                    <Banner
                                        container='section'
                                        status='warning'
                                        title='Older output was discarded'
                                        description={`${String(logs.dropped)} line(s) left the session buffer before this panel read them.`}
                                    />
                                :   null}
                                {scope === 'session' ?
                                    <PanelState
                                        label='session output'
                                        isLoading={false}
                                        error={logs.error}
                                        isEmpty={logs.entries.length === 0}
                                        emptyTitle='No output'
                                        emptyDescription='The editor, its importer, the plugin, and the game it launches all print here.'
                                    >
                                        <VStack
                                            gap={0}
                                            paddingBlock={1}
                                        >
                                            {logs.entries.map(entry => (
                                                <Item
                                                    key={entry.sequence}
                                                    as='div'
                                                    density='compact'
                                                    marker={
                                                        <StatusDot
                                                            variant={
                                                                entry.severity === 'error' ? 'error'
                                                                : entry.severity === 'warning' ?
                                                                    'warning'
                                                                :   'neutral'
                                                            }
                                                            label={entry.severity}
                                                        />
                                                    }
                                                    label={entry.message}
                                                    labelLines={2}
                                                />
                                            ))}
                                        </VStack>
                                    </PanelState>
                                :   <PanelState
                                        label='recorded output'
                                        isLoading={history.isLoading}
                                        error={history.error}
                                        isEmpty={history.hits.length === 0}
                                        emptyTitle='Nothing found'
                                        emptyDescription='Search the warnings and errors recorded for every session, including the ones that have already stopped.'
                                    >
                                        <VStack
                                            gap={0}
                                            paddingBlock={1}
                                        >
                                            {history.hits.map(hit => (
                                                <Item
                                                    key={`${hit.runId}:${String(hit.timestamp)}:${hit.message}`}
                                                    as='div'
                                                    density='compact'
                                                    marker={
                                                        <StatusDot
                                                            variant={
                                                                hit.level === 'error' ?
                                                                    'error'
                                                                :   'warning'
                                                            }
                                                            label={hit.level}
                                                        />
                                                    }
                                                    label={hit.message}
                                                    labelLines={2}
                                                    description={`${new Date(hit.timestamp).toLocaleString()} · session ${hit.sessionId ?? 'before managed sessions'}`}
                                                    descriptionLines={1}
                                                />
                                            ))}
                                        </VStack>
                                    </PanelState>
                                }
                            </VStack>
                        )}
                        {tab === 'import' && (
                            <VStack
                                gap={0}
                                height='100%'
                            >
                                <Toolbar
                                    label='Import actions'
                                    size='sm'
                                    dividers={['bottom']}
                                    startContent={
                                        <Text
                                            type='supporting'
                                            color='secondary'
                                        >
                                            {state === 'importing' ?
                                                'The editor is importing'
                                            :   `${String(imported.length)} imported asset(s)`}
                                        </Text>
                                    }
                                    endContent={
                                        <Button
                                            label='Rescan project'
                                            size='sm'
                                            variant='ghost'
                                            isDisabled={isOffline || isRescanning}
                                            clickAction={runRescan}
                                        />
                                    }
                                />
                                <PanelState
                                    label='import state'
                                    isLoading={false}
                                    error={rescan}
                                    isEmpty={imported.length === 0}
                                    emptyTitle='Nothing imported'
                                    emptyDescription='Godot writes an .import sidecar next to every asset it converts.'
                                >
                                    {imported.map(path => (
                                        <Item
                                            key={path}
                                            as='div'
                                            density='compact'
                                            label={path}
                                            labelLines={1}
                                        />
                                    ))}
                                </PanelState>
                            </VStack>
                        )}
                    </VStack>
                </StackItem>
            )}
        </VStack>
    )
}
