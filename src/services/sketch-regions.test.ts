import {describe, expect, it} from 'vitest'
import {describeBlocked, remoteReferences} from './sketch-regions'

describe('describeBlocked', () => {
    it('keeps the origin and the filename and drops the query string', () => {
        expect(
            describeBlocked([
                'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap'
            ])
        ).toEqual(['https://fonts.googleapis.com/…/css2'])
    })

    it('names an origin on its own when there is no path to shorten', () => {
        expect(describeBlocked(['https://cdn.test/'])).toEqual(['https://cdn.test'])
    })

    it('reports one refusal once, however many times it was refused', () => {
        expect(
            describeBlocked(['https://x.test/a.png?v=1', 'https://x.test/a.png?v=2', ' '])
        ).toEqual(['https://x.test/…/a.png'])
    })
})

describe('remoteReferences', () => {
    it('finds every shape of request that leaves the machine', () => {
        const html = [
            '<link rel="stylesheet" href="https://fonts.test/css2?family=Inter">',
            '<style>@import "https://cdn.test/reset.css"; body{background:url(//img.test/bg.png)}</style>',
            '<img src="http://pics.test/hero.jpg">',
            '<img srcset="https://pics.test/hero@2x.jpg 2x">'
        ].join('')

        expect(remoteReferences(html)).toEqual([
            'https://fonts.test/…/css2',
            'http://pics.test/…/hero.jpg',
            'https://pics.test/…/hero@2x.jpg',
            '//img.test/…/bg.png',
            'https://cdn.test/…/reset.css'
        ])
    })

    it('says nothing about what is already in the document, or about a plain link', () => {
        const html =
            '<a href="https://godotengine.org/docs">docs</a>'
            + '<img src="data:image/png;base64,iVBOR">'
            + '<style>@font-face{src:url(data:font/woff2;base64,d09)}</style>'
        expect(remoteReferences(html)).toEqual([])
    })

    it('says nothing about a project asset', () => {
        const html =
            '<img src="res://ui/hero.png">'
            + '<style>@font-face{src:url(res://fonts/Title.ttf)}</style>'
        expect(remoteReferences(html)).toEqual([])
    })
})
