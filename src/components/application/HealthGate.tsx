import {useCallback, useEffect, useRef, useState} from 'react'
import {AppShell} from '@astryxdesign/core/AppShell'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {Icon} from '@astryxdesign/core/Icon'
import {Layout, LayoutContent} from '@astryxdesign/core/Layout'
import {List, ListItem} from '@astryxdesign/core/List'
import {Spinner} from '@astryxdesign/core/Spinner'
import {HStack, VStack} from '@astryxdesign/core/Stack'
import {StatusDot} from '@astryxdesign/core/StatusDot'
import {Heading, Text} from '@astryxdesign/core/Text'
import WrenchScrewdriverIcon from '@heroicons/react/24/outline/WrenchScrewdriverIcon'
import {schedule} from '../../services/clock'
import {isTauri} from '../../services/desktop'
import {applyHealthRemedy, checkWorkspaceHealth, choosePath} from '../../services/health-check'
import type {HealthCheck, HealthRemedy, HealthReport} from '../../models/health'
import {blockingSummary, statusLabel, statusVariant} from '../../models/health'

type HealthGateProps = Readonly<{
    /** Called once nothing is blocking, which is the ordinary case and shows no interface at all. */
    onReady: () => void
}>

/** The width the checklist reads at: long paths and instructions, one column. */
const GATE_WIDTH = 720
/** How long the first check may take before it is worth telling the user it is running. */
const SLOW_CHECK_MS = 400

export function HealthGate({onReady}: HealthGateProps) {
    const [report, setReport] = useState<HealthReport>()
    const [error, setError] = useState<string>()
    const [busyAction, setBusyAction] = useState<string>()
    const [isSlow, setIsSlow] = useState(false)
    const hasStarted = useRef(false)

    const accept = useCallback(
        (next: HealthReport) => {
            setReport(next)
            if (next.isReady) onReady()
        },
        [onReady]
    )

    const check = useCallback(async () => {
        // Outside the desktop shell there is no workspace to check, and the browser-driven suites
        // must not sit behind a gate that can never pass.
        if (!isTauri()) {
            onReady()
            return
        }
        setError(undefined)
        try {
            accept(await checkWorkspaceHealth())
        } catch (caught) {
            setError(String(caught))
        }
    }, [accept, onReady])

    useEffect(() => {
        if (hasStarted.current) return
        hasStarted.current = true
        void check()
    }, [check])

    useEffect(() => {
        if (report) return
        return schedule(() => {
            setIsSlow(true)
        }, SLOW_CHECK_MS)
    }, [report])

    const applyRemedy = useCallback(
        async (remedy: HealthRemedy) => {
            setError(undefined)
            setBusyAction(remedy.action)
            try {
                let path: string | undefined
                if (remedy.input !== 'none') {
                    path = await choosePath({
                        directory: remedy.input === 'directory',
                        multiple: false,
                        title: remedy.label.replace('…', ''),
                        ...(report
                            && remedy.input === 'directory' && {
                                defaultPath: report.workspace
                            })
                    })
                    // A cancelled picker is not a failure; the user simply changed their mind.
                    if (path === undefined) return
                }
                accept(
                    await applyHealthRemedy({
                        action: remedy.action,
                        ...(path !== undefined && {path})
                    })
                )
            } catch (caught) {
                setError(String(caught))
            } finally {
                setBusyAction(undefined)
            }
        },
        [accept, report]
    )

    // Nothing renders while the first check runs, so a healthy workspace opens straight into the
    // workspace rather than flashing a checklist that immediately disappears. A check that outlasts
    // the delay is one the user is waiting on — almost always the AI server being asked whether it
    // is there — and an empty window would read as a hang.
    if (!report && !error) {
        return isSlow ?
                <AppShell
                    contentPadding={6}
                    variant='wash'
                >
                    <Layout
                        height='fill'
                        contentWidth={GATE_WIDTH}
                        content={
                            <LayoutContent padding={6}>
                                <VStack
                                    height='100%'
                                    vAlign='center'
                                    hAlign='center'
                                >
                                    <Spinner
                                        size='lg'
                                        label='Checking this project…'
                                    />
                                </VStack>
                            </LayoutContent>
                        }
                    />
                </AppShell>
            :   null
    }
    if (report?.isReady) return null

    return (
        <AppShell
            contentPadding={6}
            variant='wash'
        >
            <Layout
                height='fill'
                contentWidth={GATE_WIDTH}
                content={
                    <LayoutContent padding={6}>
                        <VStack
                            gap={6}
                            hAlign='stretch'
                        >
                            {/* One axis, the same one the splash uses. */}
                            <VStack
                                gap={3}
                                hAlign='start'
                            >
                                <Icon
                                    icon={WrenchScrewdriverIcon}
                                    size='lg'
                                    color='accent'
                                />
                                <VStack
                                    gap={1}
                                    hAlign='start'
                                >
                                    <Heading
                                        level={1}
                                        type='display-2'
                                    >
                                        Set up this project
                                    </Heading>
                                    <Text color='secondary'>
                                        {report ?
                                            blockingSummary(report)
                                        :   'The workspace could not be checked.'}
                                    </Text>
                                </VStack>
                            </VStack>

                            {error ?
                                <Banner
                                    status='error'
                                    title='That did not work'
                                    description={error}
                                />
                            :   null}

                            {report ?
                                <List hasDividers>
                                    {report.checks.map(check_ => (
                                        <CheckRow
                                            key={check_.id}
                                            check={check_}
                                            busyAction={busyAction}
                                            onApply={applyRemedy}
                                        />
                                    ))}
                                </List>
                            :   null}

                            <HStack
                                gap={3}
                                hAlign='end'
                            >
                                <Button
                                    label='Check again'
                                    variant='secondary'
                                    isDisabled={busyAction !== undefined}
                                    clickAction={() => {
                                        void check()
                                    }}
                                />
                            </HStack>
                        </VStack>
                    </LayoutContent>
                }
            />
        </AppShell>
    )
}

type CheckRowProps = Readonly<{
    check: HealthCheck
    busyAction?: string | undefined
    onApply: (remedy: HealthRemedy) => Promise<void>
}>

function CheckRow({check, busyAction, onApply}: CheckRowProps) {
    const {remedy} = check
    return (
        <ListItem
            label={check.title}
            startContent={
                <StatusDot
                    variant={statusVariant(check.status)}
                    label={statusLabel(check.status)}
                />
            }
            description={
                <VStack gap={1}>
                    <Text
                        type='supporting'
                        color={check.status === 'ok' ? 'secondary' : 'primary'}
                    >
                        {check.detail}
                    </Text>
                    {remedy ?
                        <Text
                            type='supporting'
                            color='secondary'
                        >
                            {remedy.description}
                        </Text>
                    :   null}
                </VStack>
            }
            {...(remedy && {
                endContent: (
                    <Button
                        label={remedy.label}
                        // The fix for what is stopping the user leads; a fix offered next to a
                        // check that already passes is an option, not an instruction.
                        variant={check.status === 'blocked' ? 'primary' : 'secondary'}
                        size='sm'
                        isDisabled={busyAction !== undefined && busyAction !== remedy.action}
                        clickAction={() => onApply(remedy)}
                    />
                )
            })}
        />
    )
}
