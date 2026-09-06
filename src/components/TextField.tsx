import {useCallback} from 'react'
import type {ClipboardEvent, CSSProperties, KeyboardEvent, Ref} from 'react'
import {ChatComposerInput} from '@astryxdesign/core/Chat'
import type {ChatComposerInputHandle, ChatComposerTrigger} from '@astryxdesign/core/Chat'
import {TextArea} from '@astryxdesign/core/TextArea'
import {isImeKeyEvent} from '@astryxdesign/core/utils'

type TextFieldCommonProps = Readonly<{
    label: string
    value: string
    onChange: (value: string) => void
    placeholder?: string
    isDisabled?: boolean
}>

export type PlainTextFieldProps = TextFieldCommonProps
    & Readonly<{
        kind: 'plain'
        isLabelHidden?: boolean
        rows?: number
        size?: 'sm' | 'md' | 'lg'
        description?: string
        hasSpellCheck?: boolean
        hasAutoFocus?: boolean
    }>

export type RichTextFieldProps = TextFieldCommonProps
    & Readonly<{
        kind: 'rich'
        triggers?: readonly ChatComposerTrigger[]
        maxRows?: number
        handleRef?: Ref<ChatComposerInputHandle>
        rootRef?: (node: HTMLDivElement | null) => void
        /** Whether Enter has anything to send. False lets the key fall through as a newline. */
        canSubmit?: boolean
        onSubmit?: () => void
        onKeyDown?: (event: KeyboardEvent) => void
        onPaste?: (event: ClipboardEvent<HTMLDivElement>, text: string) => boolean | undefined
        onFiles?: (files: readonly File[]) => void
        hasPasteAsToken?: boolean
        style?: CSSProperties
    }>

export type TextFieldProps = PlainTextFieldProps | RichTextFieldProps

/**
 * Every multi-line field in Gofer. `plain` is a box for a document; `rich` adds trigger menus,
 * chips, files and Enter-to-send. One prop surface, so a site is configured rather than rebuilt.
 */
export function TextField(props: TextFieldProps) {
    if (props.kind === 'plain') return <PlainField {...props} />
    return <RichField {...props} />
}

function PlainField({kind: _kind, onChange, ...rest}: PlainTextFieldProps) {
    return (
        <TextArea
            {...rest}
            onChange={onChange}
        />
    )
}

function RichField({
    canSubmit = true,
    handleRef,
    isDisabled,
    kind: _kind,
    label,
    maxRows,
    onChange,
    onFiles,
    onKeyDown,
    onPaste,
    onSubmit,
    hasPasteAsToken = true,
    placeholder,
    rootRef,
    style,
    triggers,
    value
}: RichTextFieldProps) {
    const mountRoot = useCallback(
        (node: HTMLDivElement | null) => {
            node?.querySelector('[role="combobox"]')?.removeAttribute('aria-multiline')
            rootRef?.(node)
        },
        [rootRef]
    )

    const handleKeyDown = (event: KeyboardEvent) => {
        onKeyDown?.(event)
        if (event.defaultPrevented) return
        if (event.key !== 'Enter' || event.shiftKey) return
        // Taking the whole Enter takes the input's own IME guard with it, and isComposing alone
        // misses the IMEs that only report keyCode 229.
        if (isImeKeyEvent(event.nativeEvent)) return
        if (!onSubmit || !canSubmit) return
        // The input clears itself the moment it hands the text over, and only the caller knows
        // whether that text is being sent or queued. So the caller owns the whole Enter.
        event.preventDefault()
        onSubmit()
    }

    return (
        <ChatComposerInput
            ref={mountRoot}
            label={label}
            value={value}
            onChange={onChange}
            {...(handleRef && {handleRef})}
            {...(placeholder !== undefined && {placeholder})}
            {...(maxRows !== undefined && {maxRows})}
            {...(isDisabled !== undefined && {isDisabled})}
            {...(style !== undefined && {style})}
            {...(triggers && {triggers: [...triggers]})}
            {...(onFiles && {onFiles})}
            {...(onPaste && {onPaste})}
            {...(!hasPasteAsToken && {pasteAsToken: false as const})}
            hasHistory={false}
            onKeyDown={handleKeyDown}
        />
    )
}
