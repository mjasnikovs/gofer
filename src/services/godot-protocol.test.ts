/// <reference types="vite/client" />
import {describe, expect, it} from 'vitest'
import {
    MAX_ENVELOPE_BYTES,
    MAX_IMAGE_EDGE_PIXELS,
    MAX_IMAGE_ENVELOPE_BYTES,
    enforceEnvelopeSize,
    maxEnvelopeBytes,
    toErrorEnvelope,
    validateEnvelope,
    validateValue
} from './godot-protocol'
import type {EnvelopeResult, ValueResult} from './godot-protocol'

type FixtureModule = Readonly<{default: unknown}>
type Fixture = Readonly<{name: string; payload: unknown}>

const modules = import.meta.glob<FixtureModule>('../../protocol/fixtures/v2/**/*.json', {
    eager: true
})

function fixtures(kind: string): readonly Fixture[] {
    return Object.entries(modules)
        .filter(([path]) => path.includes(`/v2/${kind}/`))
        .map(([path, contents]) => ({
            name: path.split('/').at(-1) ?? '',
            payload: contents.default
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
}

function fixture(kind: string, name: string): unknown {
    const match = fixtures(kind).find(entry => entry.name === name)
    if (!match) throw new Error(`Missing protocol fixture ${kind}/${name}`)
    return match.payload
}

function validate({name, payload}: Fixture): EnvelopeResult | ValueResult {
    if (name.startsWith('value')) return validateValue(payload)
    return validateEnvelope(payload)
}

describe('the frozen protocol v2 golden fixtures', () => {
    it.each(fixtures('valid'))('accepts $name', entry => {
        expect(validate(entry)).toMatchObject({ok: true})
    })

    it.each(fixtures('invalid'))('rejects $name', entry => {
        const result = validate(entry)
        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.error.code).toBe('invalid_protocol_payload')
        expect(result.error.retryable).toBe(false)
    })

    it('reports the kind of every valid envelope', () => {
        for (const entry of fixtures('valid').filter(({name}) => !name.startsWith('value')))
            expect(validateEnvelope(entry.payload)).toEqual({
                ok: true,
                kind: entry.name.split('-')[0]
            })
    })

    it('rejects unsupported versions with the versions it does support', () => {
        expect(validateEnvelope(fixture('unsupported', 'handshake-version-3.json'))).toEqual({
            ok: false,
            error: {
                code: 'unsupported_protocol_version',
                message: 'Protocol version 3 is not supported',
                retryable: false,
                readiness: 'unavailable',
                details: {supportedVersions: [2]}
            }
        })
    })

    it('ignores unknown optional fields so version 2 can grow', () => {
        const payload = fixture('valid', 'request-scene-open.json') as Record<string, unknown>
        expect(validateEnvelope({...payload, futureOptionalField: {nested: true}})).toEqual({
            ok: true,
            kind: 'request'
        })
    })

    it('publishes the frozen limits in the handshake result', () => {
        const accepted = fixture('valid', 'response-handshake-accepted.json') as Record<
            string,
            Record<string, unknown>
        >
        expect(accepted['result']?.['limits']).toEqual({
            maxEnvelopeBytes: MAX_ENVELOPE_BYTES,
            maxImageEnvelopeBytes: MAX_IMAGE_ENVELOPE_BYTES,
            maxImageEdgePixels: MAX_IMAGE_EDGE_PIXELS
        })
    })

    it('lets only image frames exceed the JSON envelope limit', () => {
        const screenshot = fixture('valid', 'response-runtime-screenshot.json')
        const log = fixture('valid', 'event-log-appended.json')
        expect(maxEnvelopeBytes(screenshot)).toBe(MAX_IMAGE_ENVELOPE_BYTES)
        expect(maxEnvelopeBytes(log)).toBe(MAX_ENVELOPE_BYTES)
        expect(maxEnvelopeBytes('not an envelope')).toBe(MAX_ENVELOPE_BYTES)
        expect(maxEnvelopeBytes({kind: 'response', result: 4})).toBe(MAX_ENVELOPE_BYTES)
        expect(enforceEnvelopeSize(MAX_ENVELOPE_BYTES + 1, screenshot)).toBeNull()
        expect(enforceEnvelopeSize(MAX_ENVELOPE_BYTES + 1, log)).toMatchObject({
            code: 'payload_too_large',
            details: {limitBytes: MAX_ENVELOPE_BYTES}
        })
    })

    it('renders failures as correlated error envelopes', () => {
        const result = validateEnvelope({protocolVersion: 2, kind: 'request', id: 'request-1'})
        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(toErrorEnvelope(result.error, 'request-1')).toEqual({
            protocolVersion: 2,
            kind: 'error',
            id: 'request-1',
            error: result.error
        })
    })
})
