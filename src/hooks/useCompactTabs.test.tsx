import {afterEach, describe, expect, it} from 'vitest'
import {cleanup, render, screen} from '@testing-library/react'
import {Tab, TabList} from '@astryxdesign/core/TabList'
import {stripOf} from './useCompactTabs'

afterEach(cleanup)

describe('the box the tabs are measured in', () => {
    it('is the one Astryx puts them in, not the landmark around it', () => {
        render(
            <TabList
                aria-label='Views'
                value='chat'
                onChange={() => undefined}
            >
                <Tab
                    value='chat'
                    label='Chat'
                />
                <Tab
                    value='scripts'
                    label='Scripts'
                />
            </TabList>
        )

        const landmark = screen.getByRole('navigation', {name: 'Views'})
        const strip = stripOf(landmark)

        expect(strip).not.toBe(landmark)
        expect([...strip.children]).toEqual(screen.getAllByRole('button'))
    })
})
