import {useCallback, useEffect, useState} from 'react'
import PencilSquareIcon from '@heroicons/react/24/outline/PencilSquareIcon'
import TrashIcon from '@heroicons/react/24/outline/TrashIcon'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {Divider} from '@astryxdesign/core/Divider'
import {Icon} from '@astryxdesign/core/Icon'
import {Item} from '@astryxdesign/core/Item'
import {Layout, LayoutContent, LayoutFooter} from '@astryxdesign/core/Layout'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Switch} from '@astryxdesign/core/Switch'
import {Text} from '@astryxdesign/core/Text'
import {Token} from '@astryxdesign/core/Token'
import {choosePath} from '../../services/file-dialog'
import {
    deleteSkill,
    importSkill,
    listSkills,
    readSkill,
    setSkillEnabled,
    writeSkill
} from '../../services/skills'
import {toCommandError} from '../../utils/command-error'
import type {CommandError} from '../../models/errors'
import type {Skill, SkillsResponse} from '../../models/skills'
import {PanelState} from './PanelState'
import {SkillEditor} from './SkillEditor'

/** Which skill is open, and the text as the user has it. */
type OpenSkill = Readonly<{name: string; text: string}>

/**
 * The skills this project gives its agent.
 *
 * A skill is a Markdown file with a description. The description is the whole of what the model
 * sees until it decides the skill applies, so it is on the row rather than behind the editor: a
 * skill nobody can describe is a skill the model will never open.
 *
 * Every call that changes something answers with the whole list. An import can produce a warning
 * instead of a row, and a save can turn a warning back into a row, so patching one row locally
 * would draw a list the backend does not have.
 */
export function SkillsView() {
    const [response, setResponse] = useState<SkillsResponse>()
    const [error, setError] = useState<CommandError>()
    const [isLoading, setIsLoading] = useState(true)
    const [open, setOpen] = useState<OpenSkill>()
    const [busy, setBusy] = useState<string>()
    /** The skill the user pressed Delete on, held until they say so a second time. */
    const [deleting, setDeleting] = useState<Skill>()

    const run = useCallback(async (work: () => Promise<SkillsResponse>) => {
        try {
            setResponse(await work())
            setError(undefined)
        } catch (failure: unknown) {
            setError(toCommandError(failure))
        }
    }, [])

    // Inlined rather than run through `run` above: nothing is set synchronously here, because
    // `isLoading` is already true on mount and every other state change happens in a `then`.
    useEffect(() => {
        let cancelled = false
        void listSkills()
            .then(answer => {
                if (cancelled) return
                setResponse(answer)
                setError(undefined)
            })
            .catch((failure: unknown) => {
                if (!cancelled) setError(toCommandError(failure))
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [])

    /**
     * Two pickers rather than one, because the native dialog cannot offer both at once.
     *
     * A skill is often a folder: `SKILL.md` names the rest by relative path, and the agent opens
     * those once the description matches. Picking only the Markdown file would copy in a skill
     * whose every reference points at nothing, so the folder is the one offered first.
     */
    const add = useCallback(
        async (folder: boolean) => {
            const chosen = await choosePath(
                folder ?
                    {multiple: false, directory: true, title: 'Add a skill folder'}
                :   {
                        multiple: false,
                        title: 'Add a skill',
                        filters: [{name: 'Skill', extensions: ['md']}]
                    }
            )
            // A cancelled picker is not a failure; the user simply changed their mind.
            if (chosen === undefined) return
            await run(() => importSkill(chosen))
        },
        [run]
    )

    const edit = useCallback(async (name: string) => {
        setBusy(name)
        try {
            setOpen({name, text: await readSkill(name)})
            setError(undefined)
        } catch (failure: unknown) {
            setError(toCommandError(failure))
        } finally {
            setBusy(undefined)
        }
    }, [])

    /**
     * Closes the editor only when the save worked.
     *
     * `run` turns a failure into a banner rather than a rejection, so closing on the way past threw
     * away everything the user had typed — a body over the size cap came back refused and the
     * editor was already gone with the text in it.
     */
    const save = useCallback(async () => {
        if (!open) return
        setBusy(open.name)
        try {
            setResponse(await writeSkill(open.name, open.text))
            setError(undefined)
            setOpen(undefined)
        } catch (failure: unknown) {
            setError(toCommandError(failure))
        } finally {
            setBusy(undefined)
        }
    }, [open])

    if (open)
        return (
            <VStack
                gap={0}
                height='100%'
            >
                <HStack
                    gap={2}
                    padding={3}
                    align='center'
                >
                    <StackItem size='fill'>
                        <Text type='label'>{open.name}</Text>
                    </StackItem>
                    <Button
                        label='Cancel'
                        size='sm'
                        variant='ghost'
                        clickAction={() => {
                            setOpen(undefined)
                        }}
                    />
                    <Button
                        label='Save'
                        size='sm'
                        variant='primary'
                        isDisabled={busy === open.name}
                        clickAction={save}
                    />
                </HStack>
                <Divider />
                {error && (
                    <Banner
                        container='section'
                        status='error'
                        title='The skill could not be saved'
                        description={`${error.message} (${error.code})`}
                    />
                )}
                <SkillEditor
                    text={open.text}
                    onChange={text => {
                        setOpen(current => (current ? {...current, text} : current))
                    }}
                />
            </VStack>
        )

    const skills = response?.skills ?? []
    const warnings = response?.warnings ?? []
    return (
        <VStack
            gap={0}
            height='100%'
        >
            <HStack
                gap={2}
                padding={3}
                align='center'
            >
                <StackItem size='fill'>
                    <Text
                        type='supporting'
                        color='secondary'
                    >
                        The agent reads a skill when its description matches the work.
                    </Text>
                </StackItem>
                <Button
                    label='Add file…'
                    size='sm'
                    variant='secondary'
                    clickAction={() => void add(false)}
                />
                <Button
                    label='Add folder…'
                    size='sm'
                    variant='primary'
                    clickAction={() => void add(true)}
                />
            </HStack>
            <Divider />
            <StackItem
                size='fill'
                isScrollable
            >
                <PanelState
                    label='skills'
                    isLoading={isLoading}
                    {...(error
                        && !response && {
                            // Never retryable: a skills read fails because the worker is missing or
                            // the directory cannot be read, and neither of those repairs itself.
                            error: {code: error.code, message: error.message, retryable: false}
                        })}
                    isEmpty={skills.length === 0 && warnings.length === 0}
                    emptyTitle='No skills yet'
                    emptyDescription='A skill is a folder holding a SKILL.md with a name and a description. Add one and the agent finds it on its own.'
                >
                    <VStack
                        gap={3}
                        padding={3}
                    >
                        {error && response && (
                            <Banner
                                container='section'
                                status='error'
                                title='That did not work'
                                description={`${error.message} (${error.code})`}
                                isDismissable
                                onDismiss={() => {
                                    setError(undefined)
                                }}
                            />
                        )}
                        {skills.map(skill => (
                            <SkillRow
                                key={skill.name}
                                skill={skill}
                                isBusy={busy === skill.name}
                                onEdit={() => void edit(skill.name)}
                                onDelete={() => {
                                    setDeleting(skill)
                                }}
                                onToggle={enabled =>
                                    run(() => setSkillEnabled(skill.name, enabled))
                                }
                            />
                        ))}
                        {warnings.length > 0 && (
                            <Banner
                                container='section'
                                status='warning'
                                /*
                                 * "has something wrong with it", not "is not a skill". pi warns
                                 * about files that load perfectly well — a name that disagrees
                                 * with its directory, a description over 1,024 characters — so
                                 * the old wording put a row and a banner denying its existence on
                                 * the same screen.
                                 */
                                title={
                                    warnings.length === 1 ?
                                        'One file needs attention'
                                    :   `${String(warnings.length)} files need attention`
                                }
                                description={warnings
                                    .map(one => `${one.path}: ${one.message}`)
                                    .join('\n')}
                            />
                        )}
                    </VStack>
                </PanelState>
            </StackItem>
            {deleting && (
                <DeleteSkillDialog
                    skill={deleting}
                    onCancel={() => {
                        setDeleting(undefined)
                    }}
                    onConfirm={() => {
                        const name = deleting.name
                        setDeleting(undefined)
                        void run(() => deleteSkill(name))
                    }}
                />
            )}
        </VStack>
    )
}

type DeleteSkillDialogProps = Readonly<{
    skill: Skill
    onCancel: () => void
    onConfirm: () => void
}>

/**
 * The second press, because the first one cannot be taken back.
 *
 * Delete removes the skill's whole directory, and a skill is usually a folder — a `SKILL.md` and
 * the reference files it points at, all of them written by hand. `.gofer/.gitignore` is `*`, so
 * none of it is in Git and nothing brings it back. The memory rows this tab sits beside are
 * database rows; these are the user's files.
 */
function DeleteSkillDialog({skill, onCancel, onConfirm}: DeleteSkillDialogProps) {
    return (
        <Dialog
            isOpen
            purpose='form'
            width={480}
            onOpenChange={next => {
                if (!next) onCancel()
            }}
        >
            <Layout
                header={
                    <DialogHeader
                        title={`Delete ${skill.name}?`}
                        onOpenChange={onCancel}
                    />
                }
                content={
                    <LayoutContent>
                        <VStack gap={2}>
                            <Text type='body'>
                                This removes the whole skill folder, and everything the SKILL.md
                                points at with it. Gofer keeps no copy.
                            </Text>
                            <Text
                                type='supporting'
                                color='secondary'
                            >
                                {skill.path}
                            </Text>
                        </VStack>
                    </LayoutContent>
                }
                footer={
                    <LayoutFooter>
                        <HStack
                            gap={2}
                            hAlign='end'
                        >
                            <Button
                                label='Cancel'
                                variant='ghost'
                                onClick={onCancel}
                            />
                            <Button
                                label='Delete'
                                variant='destructive'
                                onClick={onConfirm}
                            />
                        </HStack>
                    </LayoutFooter>
                }
            />
        </Dialog>
    )
}

type SkillRowProps = Readonly<{
    skill: Skill
    isBusy: boolean
    onEdit: () => void
    onDelete: () => void
    onToggle: (enabled: boolean) => Promise<void>
}>

/**
 * One skill. The row itself is not clickable: it holds a switch and two buttons, and an
 * interactive row around interactive controls is a click target inside a click target.
 */
function SkillRow({skill, isBusy, onEdit, onDelete, onToggle}: SkillRowProps) {
    return (
        <Item
            as='div'
            align='start'
            /*
             * Three lines, not the one the row defaults to. The description is the only thing that
             * decides whether the model ever opens this skill, so a tab that cuts it at forty
             * characters cannot answer the question the user came here to ask — is this
             * description good enough to be matched against?
             */
            descriptionLines={3}
            label={
                <HStack
                    gap={2}
                    align='center'
                >
                    <Text type='label'>{skill.name}</Text>
                    {/*
                     * A file that turned itself off is not a switch the user can win against, so
                     * the row says which of the two reasons it is off for.
                     */}
                    {skill.hidden && <Token label='Hidden by the file' />}
                </HStack>
            }
            description={
                skill.description === '' ?
                    'No description, so the agent has nothing to match against.'
                :   skill.description
            }
            endContent={
                <HStack
                    gap={2}
                    align='center'
                >
                    <Switch
                        label={`Send ${skill.name} to the agent`}
                        isLabelHidden
                        value={skill.enabled}
                        isDisabled={skill.hidden}
                        changeAction={onToggle}
                    />
                    {/*
                     * Icons, and the skill's own name in the label. A row of buttons all reading
                     * "Edit" is one accessible name repeated down the list, so nothing spoken
                     * says which skill is about to be edited.
                     */}
                    <Button
                        label={`Edit ${skill.name}`}
                        size='sm'
                        variant='secondary'
                        isIconOnly
                        icon={<Icon icon={PencilSquareIcon} />}
                        tooltip='Edit'
                        isDisabled={isBusy}
                        clickAction={onEdit}
                    />
                    <Button
                        label={`Delete ${skill.name}`}
                        size='sm'
                        variant='ghost'
                        isIconOnly
                        icon={<Icon icon={TrashIcon} />}
                        tooltip='Delete'
                        isDisabled={isBusy}
                        clickAction={onDelete}
                    />
                </HStack>
            }
        />
    )
}
