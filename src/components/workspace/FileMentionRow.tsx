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

/**
 * One row of the `@` menu: a picture if the file is one, otherwise the icon for its kind.
 *
 * A name alone does not separate `player.gd` from `player.tscn` from `player.png`, which is most of
 * why the menu was hard to read. The picture is 16px — the same box the icon occupies — so a row
 * never grows and the popover keeps showing six of them rather than three. That is enough to tell
 * one sprite from another, which is the question being asked at this size.
 */

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

/** The 16px box. `Icon size='sm'` is exactly 1rem, so a square never shifts the row an icon held. */
const THUMBNAIL_STYLE = {
    width: 'var(--spacing-4)',
    height: 'var(--spacing-4)',
    objectFit: 'contain',
    // Pixel art has to stay pixels: the browser's default smoothing turns a 32px tile into a smear
    // at this size, which is the one size where it needed to stay legible.
    imageRendering: 'pixelated',
    borderRadius: 'var(--radius-element)',
    flexShrink: 0
} as const

export function FileMentionRow({item}: Readonly<{item: SearchableItem}>) {
    const mention = item.auxiliaryData as FileMention | undefined
    const path = mention?.path ?? item.id
    const isDirectory = mention?.isDirectory ?? false
    const kind = fileKind(path, isDirectory)

    // The cache lives outside React because the menu unmounts every row on every keystroke, and a
    // square already fetched must not be fetched again when the same row comes back.
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
            // What tells `hud.gd` from the other three. Empty at the worktree root, where it would
            // only repeat the name already on the row above it.
            description={mention?.directory ?? ''}
        />
    )
}
