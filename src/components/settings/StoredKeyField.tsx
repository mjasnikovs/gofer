import {Button} from '@astryxdesign/core/Button'
import {TextInput} from '@astryxdesign/core/TextInput'
import KeyIcon from '@heroicons/react/24/outline/KeyIcon'
import type {SecretName} from '../../models/settings'
import type {KeyDraft, SettingsAction} from '../../models/settings-draft'

/** The three secrets a person types. ChatGPT is the fourth, and it is a sign-in rather than a box. */
type TypedSecret = Exclude<SecretName, 'chat-gpt'>

/**
 * What one key box says, which is the whole of what ever differed between the three.
 *
 * Everything else — "Stored securely", "Leave blank to keep…", the removal button and when it is
 * shown — was written out once per secret and had to be kept in step by hand.
 */
type StoredKeyCopy = Readonly<{
    label: string
    /**
     * The box's own hint, shown only while nothing is stored. A format example or a statement about
     * the field, never its name: a placeholder that names the field disappears when it is typed in.
     */
    placeholder: string
    /** What to say when there is no stored key to leave alone. */
    description: string
    removeLabel: string
    keepLabel: string
    /** Which of the two hints the label carries, and neither is the third answer: no hint at all. */
    isRequired: boolean
    isOptional: boolean
}>

const STORED_KEY_COPY: Readonly<Record<TypedSecret, StoredKeyCopy>> = {
    'ai-default': {
        label: 'API key',
        placeholder: 'Not required by local servers',
        description: 'Enter a key only if this server requires authentication.',
        removeLabel: 'Remove stored API key',
        keepLabel: 'Keep stored API key',
        isRequired: false,
        isOptional: true
    },
    openrouter: {
        label: 'API key',
        placeholder: 'sk-or-v1-…',
        description: 'Create one at openrouter.ai under Keys.',
        removeLabel: 'Remove stored API key',
        keepLabel: 'Keep stored API key',
        isRequired: true,
        isOptional: false
    },
    brave: {
        label: 'Brave Search API key',
        placeholder: 'From api.search.brave.com',
        description: 'Stored in the operating system credential store, never in the settings file.',
        removeLabel: 'Remove stored Brave key',
        keepLabel: 'Keep stored Brave key',
        isRequired: false,
        isOptional: false
    }
}

type StoredKeyFieldProps = Readonly<{
    secret: TypedSecret
    draft: KeyDraft
    dispatch: (action: SettingsAction) => void
}>

/**
 * One secret's box, and the button that takes the stored one off the machine.
 *
 * The two belong together: the box cannot mean "remove it" — the page never reads a stored secret
 * back, so an emptied box is "leave it alone" — and the button is the only thing that can. This was
 * written out three times, differing in a noun, and the removal button sat a screenful away from
 * the field it was about.
 */
export function StoredKeyField({secret, draft, dispatch}: StoredKeyFieldProps) {
    const copy = STORED_KEY_COPY[secret]
    const isRemoving = draft.intent === 'clear'
    return (
        <>
            <TextInput
                label={copy.label}
                type='password'
                value={draft.typed}
                isRequired={copy.isRequired}
                isOptional={copy.isOptional}
                startIcon={KeyIcon}
                placeholder={draft.isStored ? 'Stored securely' : copy.placeholder}
                description={
                    isRemoving ? 'The stored key will be removed when you save.'
                    : draft.isStored ?
                        'Leave blank to keep the key stored in the operating system credential store.'
                    :   copy.description
                }
                onChange={value => {
                    dispatch({type: 'key-typed', secret, value})
                }}
            />
            {(draft.isStored || isRemoving) && (
                <Button
                    label={isRemoving ? copy.keepLabel : copy.removeLabel}
                    variant='ghost'
                    clickAction={() => {
                        dispatch({type: 'key-removal-toggled', secret})
                    }}
                />
            )}
        </>
    )
}
