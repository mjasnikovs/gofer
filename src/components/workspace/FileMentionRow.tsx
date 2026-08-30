import {useEffect, useSyncExternalStore} from 'react'
import {TypeaheadItem} from '@astryxdesign/core/Typeahead'
import type {SearchableItem} from '@astryxdesign/core/Typeahead'
import {Icon} from '@astryxdesign/core/Icon'
import Cog6ToothIcon from '@heroicons/react/24/outline/Cog6ToothIcon'
import CodeBracketIcon from '@heroicons/react/24/outline/CodeBracketIcon'
import DocumentIcon from '@heroicons/react/24/outline/DocumentIcon'
import DocumentTextIcon from '@heroicons/react/24/outline/DocumentTextIcon'
import FilmIcon from '@heroicons/react/24/outline/FilmIcon'
import FolderIcon from '@heroicons/react/24/outline/FolderIcon'
import LanguageIcon from '@heroicons/react/24/outline/LanguageIcon'
import PhotoIcon from '@heroicons/react/24/outline/PhotoIcon'
import SpeakerWaveIcon from '@heroicons/react/24/outline/SpeakerWaveIcon'
import SwatchIcon from '@heroicons/react/24/outline/SwatchIcon'
import {fileKind, hasThumbnail} from '../../models/file-kinds'
import type {FileKind} from '../../models/file-kinds'
import {requestThumbnail, thumbnailFor, watchThumbnails} from '../../services/file-thumbnails'
import type {FileMention} from '../../models/file-mentions'

const ICONS: Readonly<Record<FileKind, typeof DocumentIcon>> = {
    folder: FolderIcon,
    image: PhotoIcon,
    script: CodeBracketIcon,
    scene: FilmIcon,
    resource: SwatchIcon,
    audio: SpeakerWaveIcon,
    font: LanguageIcon,
    text: DocumentTextIcon,
    config: Cog6ToothIcon,
    file: DocumentIcon
}

const THUMBNAIL_STYLE = {
    width: 'var(--spacing-4)',
    height: 'var(--spacing-4)',
    objectFit: 'contain',
    imageRendering: 'pixelated',
    borderRadius: 'var(--radius-element)',
    flexShrink: 0
} as const

export function FileMentionRow({item}: Readonly<{item: SearchableItem}>) {
    const mention = item.auxiliaryData as FileMention | undefined
    const path = mention?.path ?? item.id
    const isDirectory = mention?.isDirectory ?? false
    const kind = fileKind(path, isDirectory)

    const thumbnail = useSyncExternalStore(watchThumbnails, () => thumbnailFor(path))
    useEffect(() => {
        if (hasThumbnail(path, isDirectory)) requestThumbnail(path)
    }, [path, isDirectory])

    return (
        <TypeaheadItem
            item={isDirectory ? {...item, label: `${item.label}/`} : item}
            icon={
                thumbnail ?
                    <img
                        src={thumbnail}
                        alt=''
                        style={THUMBNAIL_STYLE}
                    />
                :   <Icon
                        icon={ICONS[kind]}
                        size='sm'
                        color='secondary'
                    />
            }
            description={mention?.directory ?? ''}
        />
    )
}
