import type {ReactNode} from 'react'
import {Icon} from '@astryxdesign/core/Icon'
import type {IconType} from '@astryxdesign/core/Icon'
import AdjustmentsHorizontalIcon from '@heroicons/react/24/outline/AdjustmentsHorizontalIcon'
import ArrowDownTrayIcon from '@heroicons/react/24/outline/ArrowDownTrayIcon'
import ArrowsRightLeftIcon from '@heroicons/react/24/outline/ArrowsRightLeftIcon'
import BoltIcon from '@heroicons/react/24/outline/BoltIcon'
import BookOpenIcon from '@heroicons/react/24/outline/BookOpenIcon'
import BugAntIcon from '@heroicons/react/24/outline/BugAntIcon'
import ChatBubbleLeftRightIcon from '@heroicons/react/24/outline/ChatBubbleLeftRightIcon'
import CircleStackIcon from '@heroicons/react/24/outline/CircleStackIcon'
import CodeBracketIcon from '@heroicons/react/24/outline/CodeBracketIcon'
import Cog6ToothIcon from '@heroicons/react/24/outline/Cog6ToothIcon'
import CpuChipIcon from '@heroicons/react/24/outline/CpuChipIcon'
import CubeIcon from '@heroicons/react/24/outline/CubeIcon'
import DocumentTextIcon from '@heroicons/react/24/outline/DocumentTextIcon'
import ExclamationTriangleIcon from '@heroicons/react/24/outline/ExclamationTriangleIcon'
import FolderIcon from '@heroicons/react/24/outline/FolderIcon'
import LinkIcon from '@heroicons/react/24/outline/LinkIcon'
import ListBulletIcon from '@heroicons/react/24/outline/ListBulletIcon'
import PaintBrushIcon from '@heroicons/react/24/outline/PaintBrushIcon'
import PencilSquareIcon from '@heroicons/react/24/outline/PencilSquareIcon'
import PlayIcon from '@heroicons/react/24/outline/PlayIcon'
import RectangleGroupIcon from '@heroicons/react/24/outline/RectangleGroupIcon'
import SparklesIcon from '@heroicons/react/24/outline/SparklesIcon'
import WrenchScrewdriverIcon from '@heroicons/react/24/outline/WrenchScrewdriverIcon'
import AdjustmentsHorizontalSolid from '@heroicons/react/24/solid/AdjustmentsHorizontalIcon'
import ArrowDownTraySolid from '@heroicons/react/24/solid/ArrowDownTrayIcon'
import ArrowsRightLeftSolid from '@heroicons/react/24/solid/ArrowsRightLeftIcon'
import BoltSolid from '@heroicons/react/24/solid/BoltIcon'
import BookOpenSolid from '@heroicons/react/24/solid/BookOpenIcon'
import BugAntSolid from '@heroicons/react/24/solid/BugAntIcon'
import ChatBubbleLeftRightSolid from '@heroicons/react/24/solid/ChatBubbleLeftRightIcon'
import CircleStackSolid from '@heroicons/react/24/solid/CircleStackIcon'
import CodeBracketSolid from '@heroicons/react/24/solid/CodeBracketIcon'
import Cog6ToothSolid from '@heroicons/react/24/solid/Cog6ToothIcon'
import CpuChipSolid from '@heroicons/react/24/solid/CpuChipIcon'
import CubeSolid from '@heroicons/react/24/solid/CubeIcon'
import DocumentTextSolid from '@heroicons/react/24/solid/DocumentTextIcon'
import ExclamationTriangleSolid from '@heroicons/react/24/solid/ExclamationTriangleIcon'
import FolderSolid from '@heroicons/react/24/solid/FolderIcon'
import LinkSolid from '@heroicons/react/24/solid/LinkIcon'
import ListBulletSolid from '@heroicons/react/24/solid/ListBulletIcon'
import PaintBrushSolid from '@heroicons/react/24/solid/PaintBrushIcon'
import PencilSquareSolid from '@heroicons/react/24/solid/PencilSquareIcon'
import PlaySolid from '@heroicons/react/24/solid/PlayIcon'
import RectangleGroupSolid from '@heroicons/react/24/solid/RectangleGroupIcon'
import SparklesSolid from '@heroicons/react/24/solid/SparklesIcon'
import WrenchScrewdriverSolid from '@heroicons/react/24/solid/WrenchScrewdriverIcon'

export type TabIcons = Readonly<{
    icon: ReactNode
    selectedIcon: ReactNode
}>

// no `label` on either Icon: a named icon joins the tab's accessible name, and every
// tab selector in the suites matches the label exactly.
const pair = (outline: IconType, solid: IconType): TabIcons => ({
    icon: (
        <Icon
            icon={outline}
            size='sm'
        />
    ),
    selectedIcon: (
        <Icon
            icon={solid}
            size='sm'
        />
    )
})

export const CHAT_TAB = pair(ChatBubbleLeftRightIcon, ChatBubbleLeftRightSolid)
export const SCRIPTS_TAB = pair(CodeBracketIcon, CodeBracketSolid)
export const GAME_TAB = pair(PlayIcon, PlaySolid)
export const DOCS_TAB = pair(BookOpenIcon, BookOpenSolid)
export const MEMORY_TAB = pair(CircleStackIcon, CircleStackSolid)
export const DESIGN_TAB = pair(PaintBrushIcon, PaintBrushSolid)
export const SKILLS_TAB = pair(SparklesIcon, SparklesSolid)
export const CHANGES_TAB = pair(ArrowsRightLeftIcon, ArrowsRightLeftSolid)

export const SCENE_TAB = pair(RectangleGroupIcon, RectangleGroupSolid)
export const FILES_TAB = pair(FolderIcon, FolderSolid)
export const RUNTIME_TAB = pair(BoltIcon, BoltSolid)

export const NODE_TAB = pair(CubeIcon, CubeSolid)
export const PROJECT_TAB = pair(Cog6ToothIcon, Cog6ToothSolid)
export const EDITOR_TAB = pair(WrenchScrewdriverIcon, WrenchScrewdriverSolid)

export const PROBLEMS_TAB = pair(ExclamationTriangleIcon, ExclamationTriangleSolid)
export const DEBUGGER_TAB = pair(BugAntIcon, BugAntSolid)
export const OUTPUT_TAB = pair(ListBulletIcon, ListBulletSolid)
export const IMPORT_TAB = pair(ArrowDownTrayIcon, ArrowDownTraySolid)

export const AI_SETTINGS_TAB = pair(LinkIcon, LinkSolid)
export const PROMPT_SETTINGS_TAB = pair(PencilSquareIcon, PencilSquareSolid)
export const GODOT_SETTINGS_TAB = pair(AdjustmentsHorizontalIcon, AdjustmentsHorizontalSolid)
export const MODELS_SETTINGS_TAB = pair(CpuChipIcon, CpuChipSolid)
export const STORAGE_SETTINGS_TAB = pair(CircleStackIcon, CircleStackSolid)

export const SCRIPT_BUFFER_TAB = pair(DocumentTextIcon, DocumentTextSolid)
