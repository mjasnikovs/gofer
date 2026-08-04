// Protocol version 2: the persistent, authenticated Godot editor session contract.
// `protocol/README.md` is the frozen specification and `protocol/fixtures/v2` the golden payloads
// this module, `src-tauri/src/protocol_v2.rs`, and the Godot addon must agree on.

export const PROTOCOL_VERSION = 2
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [PROTOCOL_VERSION]

export const MAX_ENVELOPE_BYTES = 1048576
export const MAX_IMAGE_ENVELOPE_BYTES = 16777216
export const MAX_IMAGE_EDGE_PIXELS = 1920
export const MAX_ID_LENGTH = 128
export const MAX_TIMEOUT_MS = 600000
export const IMAGE_ENCODING = 'png-base64'
export const SESSION_TOKEN_LENGTH = 64

export const DOMAINS = [
    'session',
    'scene',
    'node',
    'project',
    'editor',
    'resource',
    'script',
    'debug',
    'runtime',
    'logs',
    'files',
    'docs'
] as const

export const MUTATING_COMMANDS: readonly string[] = [
    'session.undo',
    'session.redo',
    'scene.create',
    'scene.save',
    'scene.save_as',
    'scene.reload',
    'node.create',
    'node.duplicate',
    'node.rename',
    'node.reparent',
    'node.delete',
    'node.set_property',
    'node.add_to_group',
    'node.remove_from_group',
    'node.connect_signal',
    'node.disconnect_signal'
]

export const ENVELOPE_KINDS = ['handshake', 'request', 'response', 'event', 'error'] as const
export const READINESS_STATES = ['ready', 'starting', 'importing', 'unavailable'] as const

export type GodotDomain = (typeof DOMAINS)[number]
export type EnvelopeKind = (typeof ENVELOPE_KINDS)[number]
export type Readiness = (typeof READINESS_STATES)[number]

export type ProtocolFailure = Readonly<{
    code: string
    message: string
    retryable: boolean
    readiness: Readiness
    details: Readonly<Record<string, unknown>>
}>

export type EnvelopeResult =
    Readonly<{ok: true; kind: EnvelopeKind}> | Readonly<{ok: false; error: ProtocolFailure}>

export type ValueResult = Readonly<{ok: true}> | Readonly<{ok: false; error: ProtocolFailure}>

export type SessionLimits = Readonly<{
    maxEnvelopeBytes: number
    maxImageEnvelopeBytes: number
    maxImageEdgePixels: number
}>

export type GodotClient = Readonly<{
    name: string
    addonVersion: string
    engineVersion: string
    projectPath: string
    capabilities: readonly GodotDomain[]
}>

export type GodotHandshake = Readonly<{
    protocolVersion: typeof PROTOCOL_VERSION
    kind: 'handshake'
    id: string
    token: string
    acceptedVersions: readonly number[]
    client: GodotClient
}>

export type GodotRequest = Readonly<{
    protocolVersion: typeof PROTOCOL_VERSION
    kind: 'request'
    id: string
    command: string
    params: Readonly<Record<string, unknown>>
    expectedRevision?: number
    timeoutMs?: number
}>

export type GodotResponse = Readonly<{
    protocolVersion: typeof PROTOCOL_VERSION
    kind: 'response'
    id: string
    result: unknown
    revision?: number
}>

export type GodotEvent = Readonly<{
    protocolVersion: typeof PROTOCOL_VERSION
    kind: 'event'
    id: string
    sequence: number
    event: string
    data: Readonly<Record<string, unknown>>
}>

export type GodotErrorEnvelope = Readonly<{
    protocolVersion: typeof PROTOCOL_VERSION
    kind: 'error'
    id: string
    error: ProtocolFailure
}>

export type GodotEnvelope =
    GodotHandshake | GodotRequest | GodotResponse | GodotEvent | GodotErrorEnvelope

type NumericValueSpec = Readonly<{arity: number; integral: boolean}>

type ObjectValueSpec = Readonly<{
    requiredStrings: readonly string[]
    optionalStrings: readonly string[]
    requiredIntegers: readonly string[]
    optionalIntegers: readonly string[]
}>

const NUMERIC_VALUES: Readonly<Record<string, NumericValueSpec>> = {
    vector2: {arity: 2, integral: false},
    vector2i: {arity: 2, integral: true},
    vector3: {arity: 3, integral: false},
    vector3i: {arity: 3, integral: true},
    vector4: {arity: 4, integral: false},
    vector4i: {arity: 4, integral: true},
    quaternion: {arity: 4, integral: false},
    color: {arity: 4, integral: false},
    plane: {arity: 4, integral: false},
    rect2: {arity: 4, integral: false},
    rect2i: {arity: 4, integral: true},
    transform2d: {arity: 6, integral: false},
    basis: {arity: 9, integral: false},
    transform3d: {arity: 12, integral: false}
}

const OBJECT_VALUES: Readonly<Record<string, ObjectValueSpec>> = {
    resource: {
        requiredStrings: ['path', 'resourceType'],
        optionalStrings: ['uid'],
        requiredIntegers: [],
        optionalIntegers: []
    },
    node: {
        requiredStrings: ['path', 'nodeType'],
        optionalStrings: [],
        requiredIntegers: [],
        optionalIntegers: ['instanceId']
    },
    object: {
        requiredStrings: ['className'],
        optionalStrings: [],
        requiredIntegers: ['instanceId'],
        optionalIntegers: []
    },
    opaque: {
        requiredStrings: ['typeName', 'text'],
        optionalStrings: [],
        requiredIntegers: [],
        optionalIntegers: []
    }
}

function invalid(message: string): ProtocolFailure {
    return {
        code: 'invalid_protocol_payload',
        message,
        retryable: false,
        readiness: 'ready',
        details: {}
    }
}

function unsupported(version: number): ProtocolFailure {
    return {
        code: 'unsupported_protocol_version',
        message: `Protocol version ${String(version)} is not supported`,
        retryable: false,
        readiness: 'unavailable',
        details: {supportedVersions: SUPPORTED_PROTOCOL_VERSIONS}
    }
}

function tooLarge(actualBytes: number, limitBytes: number): ProtocolFailure {
    return {
        code: 'payload_too_large',
        message: `The envelope is ${String(actualBytes)} bytes and the limit is ${String(limitBytes)} bytes`,
        retryable: false,
        readiness: 'ready',
        details: {actualBytes, limitBytes}
    }
}

/** Renders a failure as the envelope a receiver sends back for `id`. */
export function toErrorEnvelope(error: ProtocolFailure, id: string): GodotErrorEnvelope {
    return {protocolVersion: PROTOCOL_VERSION, kind: 'error', id, error}
}

/** Validates one decoded version 2 envelope and reports the kind it turned out to be. */
export function validateEnvelope(payload: unknown): EnvelopeResult {
    if (!isRecord(payload)) return {ok: false, error: invalid('payload must be an object')}
    const version = payload['protocolVersion']
    if (!isInteger(version) || version <= 0)
        return {ok: false, error: invalid('protocolVersion must be a positive integer')}
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version))
        return {ok: false, error: unsupported(version)}
    const kind = payload['kind']
    if (!isEnvelopeKind(kind)) return {ok: false, error: invalid('kind is not an envelope kind')}
    const id = payload['id']
    if (!isNonEmptyString(id) || id.length > MAX_ID_LENGTH)
        return {ok: false, error: invalid('id must be 1 to 128 characters')}
    const error = validateBody(kind, payload)
    if (error) return {ok: false, error}
    return {ok: true, kind}
}

/** Validates one tagged Godot value wherever a command contract places one. */
export function validateValue(value: unknown): ValueResult {
    const error = checkValue(value)
    if (error) return {ok: false, error}
    return {ok: true}
}

/** Reports the byte limit that applies to `payload`, which is larger for image frames. */
export function maxEnvelopeBytes(payload: unknown): number {
    if (!isRecord(payload)) return MAX_ENVELOPE_BYTES
    const body =
        payload['kind'] === 'response' ? payload['result']
        : payload['kind'] === 'event' ? payload['data']
        : undefined
    if (!isRecord(body)) return MAX_ENVELOPE_BYTES
    const frame = body['frame']
    if (!isRecord(frame) || frame['encoding'] !== IMAGE_ENCODING) return MAX_ENVELOPE_BYTES
    return MAX_IMAGE_ENVELOPE_BYTES
}

/** Rejects a framed line that is larger than the limit its payload is allowed to use. */
export function enforceEnvelopeSize(rawBytes: number, payload: unknown): ProtocolFailure | null {
    const limit = maxEnvelopeBytes(payload)
    if (rawBytes > limit) return tooLarge(rawBytes, limit)
    return null
}

function validateBody(
    kind: EnvelopeKind,
    payload: Record<string, unknown>
): ProtocolFailure | null {
    if (kind === 'handshake') return checkHandshake(payload)
    if (kind === 'request') return checkRequest(payload)
    if (kind === 'response') return checkResponse(payload)
    if (kind === 'event') return checkEvent(payload)
    return checkError(payload['error'])
}

function checkHandshake(payload: Record<string, unknown>): ProtocolFailure | null {
    const token = payload['token']
    if (!isNonEmptyString(token) || !isSessionToken(token))
        return invalid('token must be 64 lowercase hexadecimal characters')
    const versions = payload['acceptedVersions']
    if (!Array.isArray(versions) || versions.length === 0)
        return invalid('acceptedVersions must be a non-empty array')
    for (const version of versions as readonly unknown[]) {
        if (!isInteger(version) || version <= 0)
            return invalid('acceptedVersions must hold positive integers')
    }
    const client = payload['client']
    if (!isRecord(client)) return invalid('client must be an object')
    for (const name of ['name', 'addonVersion'])
        if (!isNonEmptyString(client[name])) return invalid(`client.${name} must be a string`)
    const engineVersion = client['engineVersion']
    if (!isNonEmptyString(engineVersion) || !isEngineVersion(engineVersion))
        return invalid('client.engineVersion must be major.minor.patch.channel')
    const projectPath = client['projectPath']
    if (!isNonEmptyString(projectPath) || !isAbsolutePath(projectPath))
        return invalid('client.projectPath must be absolute')
    const capabilities = client['capabilities']
    if (!Array.isArray(capabilities)) return invalid('client.capabilities must be an array')
    for (const capability of capabilities as readonly unknown[]) {
        if (!isNonEmptyString(capability) || !isDomain(capability))
            return invalid('client.capabilities must name domains')
    }
    return null
}

function checkRequest(payload: Record<string, unknown>): ProtocolFailure | null {
    const command = payload['command']
    if (!isNonEmptyString(command) || !isDomainOperation(command))
        return invalid('command must be a domain.operation name')
    if (!isRecord(payload['params'])) return invalid('params must be an object')
    const revision = payload['expectedRevision']
    if (MUTATING_COMMANDS.includes(command) && revision === undefined)
        return invalid('a mutating command requires expectedRevision')
    if (revision !== undefined && (!isInteger(revision) || revision < 0))
        return invalid('expectedRevision must not be negative')
    const timeout = payload['timeoutMs']
    if (timeout !== undefined && (!isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS))
        return invalid('timeoutMs must be between 1 and 600000')
    return null
}

function checkResponse(payload: Record<string, unknown>): ProtocolFailure | null {
    if (!('result' in payload)) return invalid('result is required')
    const revision = payload['revision']
    if (revision !== undefined && (!isInteger(revision) || revision < 0))
        return invalid('revision must not be negative')
    return null
}

function checkEvent(payload: Record<string, unknown>): ProtocolFailure | null {
    const sequence = payload['sequence']
    if (!isInteger(sequence) || sequence < 0) return invalid('sequence must not be negative')
    const event = payload['event']
    if (!isNonEmptyString(event) || !isDomainOperation(event))
        return invalid('event must be a domain.operation name')
    if (!isRecord(payload['data'])) return invalid('data must be an object')
    return null
}

function checkError(value: unknown): ProtocolFailure | null {
    if (!isRecord(value)) return invalid('error must be an object')
    const code = value['code']
    if (!isNonEmptyString(code) || !isSnakeCase(code))
        return invalid('error.code must be lowercase snake case')
    if (!isNonEmptyString(value['message'])) return invalid('error.message must be a string')
    if (typeof value['retryable'] !== 'boolean') return invalid('error.retryable must be a boolean')
    const readiness = value['readiness']
    if (!isNonEmptyString(readiness) || !isReadiness(readiness))
        return invalid('error.readiness is not a known state')
    if (!isRecord(value['details'])) return invalid('error.details must be an object')
    return null
}

function checkValue(value: unknown): ProtocolFailure | null {
    if (!isRecord(value)) return invalid('value must be an object')
    const kind = value['type']
    if (!isNonEmptyString(kind)) return invalid('value.type must be a string')
    const payload = value['value']
    if (kind === 'null')
        return payload === undefined || payload === null ?
                null
            :   invalid('a null value carries no value')
    if (kind === 'bool')
        return typeof payload === 'boolean' ? null : invalid('a bool value carries a boolean')
    if (kind === 'int')
        return isInteger(payload) ? null : invalid('an int value carries an integer')
    if (kind === 'float')
        return isFiniteNumber(payload) ? null : invalid('a float value carries a number')
    if (kind === 'string')
        return typeof payload === 'string' ? null : invalid('a string value carries a string')
    if (kind === 'array') {
        if (!Array.isArray(payload)) return invalid('an array value carries an array')
        for (const entry of payload as readonly unknown[]) {
            const error = checkValue(entry)
            if (error) return error
        }
        return null
    }
    if (kind === 'dictionary') {
        if (!Array.isArray(payload)) return invalid('a dictionary value carries entries')
        for (const entry of payload as readonly unknown[]) {
            if (!isRecord(entry)) return invalid('a dictionary entry must be an object')
            const error = checkValue(entry['key']) ?? checkValue(entry['value'])
            if (error) return error
        }
        return null
    }
    return checkCompositeValue(kind, payload)
}

function checkCompositeValue(kind: string, payload: unknown): ProtocolFailure | null {
    const numeric = NUMERIC_VALUES[kind]
    if (numeric) {
        if (!Array.isArray(payload) || payload.length !== numeric.arity)
            return invalid('the value has the wrong number of components')
        for (const component of payload as readonly unknown[]) {
            if (!isFiniteNumber(component)) return invalid('the components must be numbers')
            if (numeric.integral && !Number.isInteger(component))
                return invalid('the components must be integers')
        }
        return null
    }
    const spec = OBJECT_VALUES[kind]
    if (!spec) return invalid(`${kind} is not a Godot value type`)
    if (!isRecord(payload)) return invalid('value must be an object')
    for (const name of spec.requiredStrings)
        if (!isNonEmptyString(payload[name])) return invalid(`${name} must be a string`)
    for (const name of spec.optionalStrings) {
        const field = payload[name]
        if (field !== undefined && !isNonEmptyString(field))
            return invalid(`${name} must be a string`)
    }
    for (const name of spec.requiredIntegers)
        if (!isInteger(payload[name])) return invalid(`${name} must be an integer`)
    for (const name of spec.optionalIntegers) {
        const field = payload[name]
        if (field !== undefined && !isInteger(field)) return invalid(`${name} must be an integer`)
    }
    return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
}

function isInteger(value: unknown): value is number {
    return isFiniteNumber(value) && Number.isInteger(value)
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0
}

function isEnvelopeKind(value: unknown): value is EnvelopeKind {
    return isNonEmptyString(value) && (ENVELOPE_KINDS as readonly string[]).includes(value)
}

function isReadiness(value: string): value is Readiness {
    return (READINESS_STATES as readonly string[]).includes(value)
}

function isDomain(value: string): value is GodotDomain {
    return (DOMAINS as readonly string[]).includes(value)
}

function isSessionToken(token: string): boolean {
    return token.length === SESSION_TOKEN_LENGTH && /^[0-9a-f]+$/u.test(token)
}

function isAbsolutePath(path: string): boolean {
    return path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path)
}

function isEngineVersion(version: string): boolean {
    return /^[0-9]+\.[0-9]+\.[0-9]+\.[a-z]+$/u.test(version)
}

function isDomainOperation(name: string): boolean {
    const [domain, operation, ...rest] = name.split('.')
    if (domain === undefined || operation === undefined || rest.length > 0) return false
    return isDomain(domain) && isSnakeCase(operation)
}

function isSnakeCase(name: string): boolean {
    return /^[a-z][a-z0-9_]*$/u.test(name)
}
