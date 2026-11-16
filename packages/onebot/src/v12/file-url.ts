export type FileUrlClassification =
    { kind: 'valid'; url: string } | { kind: 'unsupported' } | { kind: 'invalid' };

/** Classify a file URL without fetching or normalizing the returned value. */
export function classifyFileUrl(value: unknown): FileUrlClassification {
    if (typeof value !== 'string' || value.length > 8192) {
        return { kind: 'invalid' };
    }

    if (value.length === 0) {
        return { kind: 'unsupported' };
    }

    // WHATWG URL parsing can repair malformed Unicode and discard ASCII
    // whitespace or controls, so validate the original string first.
    for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i);

        if (code <= 0x20 || code === 0x7f) {
            return { kind: 'invalid' };
        }

        if (code === 0x25) {
            const pair = value.slice(i + 1, i + 3);

            if (!/^[0-9a-f]{2}$/i.test(pair)) {
                return { kind: 'invalid' };
            }

            i += 2;
        } else if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(i + 1);

            if (!(next >= 0xdc00 && next <= 0xdfff)) {
                return { kind: 'invalid' };
            }

            i += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return { kind: 'invalid' };
        }
    }

    let parsed: URL;

    try {
        parsed = new URL(value);
    } catch {
        return { kind: 'invalid' };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { kind: 'unsupported' };
    }

    // Require the original HTTP(S) authority syntax, without parser repairs.
    if (!/^https?:\/\//i.test(value) || value.includes('\\')) {
        return { kind: 'invalid' };
    }

    // URL normalizes an empty userinfo marker away; inspect the raw authority.
    const authority = value.slice(value.indexOf('://') + 3).split(/[/?#]/, 1)[0];

    if (
        !authority ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password ||
        authority.includes('@')
    ) {
        return { kind: 'invalid' };
    }

    return { kind: 'valid', url: value };
}
