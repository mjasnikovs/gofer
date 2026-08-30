import {Button} from '@astryxdesign/core/Button'
import {TextInput} from '@astryxdesign/core/TextInput'
import KeyIcon from '@heroicons/react/24/outline/KeyIcon'
import type {SecretName} from '../../models/settings'
import type {KeyDraft, SettingsAction} from '../../models/settings-draft'

export type TypedSecret = Exclude<SecretName, 'chat-gpt'>

type StoredKeyCopy = Readonly<{
    label: string
    placeholder: string
    description: string
    removeLabel: string
    keepLabel: string
    isRequired: boolean
    isOptional: boolean
}>

const STORED_KEY_COPY: Readonly<Record<TypedSecret, StoredKeyCopy>> = {
    'ai-default': {
        label: 'API key',
        placeholder: '',
        description:
            'Not required by local servers. Enter a key only if this server requires authentication.',
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
    cerebras: {
        label: 'API key',
        placeholder: 'csk-…',
        description: 'Create one at cloud.cerebras.ai under API Keys.',
        removeLabel: 'Remove stored API key',
        keepLabel: 'Keep stored API key',
        isRequired: true,
        isOptional: false
    },
    brave: {
        label: 'Brave Search API key',
        placeholder: '',
        description:
            'From api.search.brave.com. Stored in the operating system credential store, never in the settings file.',
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
                placeholder={draft.isStored ? '' : copy.placeholder}
                description={
                    isRemoving ? 'The stored key will be removed when you save.'
                    : draft.isStored ?
                        'A key is stored. Leave this blank to keep it in the operating system credential store.'
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
