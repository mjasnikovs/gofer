export const PROTOCOL_VERSION = 1
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([PROTOCOL_VERSION])

export class ProtocolError extends Error {
    constructor(code, message, details = {}) {
        super(message)
        this.name = 'ProtocolError'
        this.code = code
        this.details = details
    }

    toPayload(id) {
        return {
            protocolVersion: PROTOCOL_VERSION,
            id,
            error: {code: this.code, message: this.message, details: this.details}
        }
    }
}

export function requireSupportedProtocolVersion(payload) {
    const version = payload?.protocolVersion
    if (SUPPORTED_PROTOCOL_VERSIONS.includes(version)) return version
    throw new ProtocolError(
        'unsupported_protocol_version',
        `Protocol version ${String(version)} is not supported`,
        {supportedVersions: SUPPORTED_PROTOCOL_VERSIONS}
    )
}
