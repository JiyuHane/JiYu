/**
 * Independent read-only client for https://github.com/HolyFoxTeam/napcat-plugin-community-index.
 * Index authorship and any plugin licenses remain with their respective owners.
 * Index entries are unverified; minVersion refers to NapCat, not Jiyu.
 */
export const COMMUNITY_INDEX_URL =
    'https://raw.githubusercontent.com/HolyFoxTeam/napcat-plugin-community-index/main/plugins.v4.json';
export const INDEX_TTL_MS = 10 * 60 * 1000;
export const INDEX_TIMEOUT_MS = 10_000;
export const INDEX_MAX_BYTES = 2 * 1024 * 1024;

export type JsonValue =
    null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface CommunityPlugin {
    [key: string]: JsonValue | undefined;
    id: string;
    name: string;
    version: string;
    description: string;
    author: string;
    homepage: string;
    downloadUrl: string;
    minVersion: string;
    tags?: string[];
}
export interface CommunityIndex {
    [key: string]: JsonValue | CommunityPlugin[];
    version: string;
    updateTime: string;
    statsUrl: string;
    plugins: CommunityPlugin[];
}
export type IndexError = 'timeout' | 'network' | 'http' | 'too_large' | 'invalid';
export type IndexResult =
    | {
          index: CommunityIndex;
          fetchedAt: number;
          stale: boolean;
          error: IndexError | null;
          verified: false;
          minVersionTarget: 'NapCat';
      }
    | {
          index: null;
          fetchedAt: null;
          stale: true;
          error: IndexError;
          verified: false;
          minVersionTarget: 'NapCat';
      };

class IndexFailure extends Error {
    constructor(readonly code: IndexError) {
        super(code);
    }
}

function validateJson(value: unknown, depth = 0, count = { value: 0 }): asserts value is JsonValue {
    if (++count.value > 100_000 || depth > 16) {
        throw new IndexFailure('invalid');
    }

    if (value === null || typeof value === 'boolean') {
        return;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        return;
    }

    if (typeof value === 'string' && value.length <= 16_384) {
        return;
    }

    if (Array.isArray(value) && value.length <= 10_000) {
        for (const item of value) {
            validateJson(item, depth + 1, count);
        }

        return;
    }

    if (typeof value === 'object' && !Array.isArray(value)) {
        const entries = Object.entries(value as Record<string, unknown>);

        if (entries.length > 256) {
            throw new IndexFailure('invalid');
        }

        for (const [key, child] of entries) {
            if (
                key.length > 256 ||
                key === '__proto__' ||
                key === 'constructor' ||
                key === 'prototype'
            ) {
                throw new IndexFailure('invalid');
            }

            validateJson(child, depth + 1, count);
        }

        return;
    }

    throw new IndexFailure('invalid');
}

function record(value: JsonValue): Record<string, JsonValue> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new IndexFailure('invalid');
    }

    return value;
}

function text(
    value: JsonValue | undefined,
    max: number,
    allowEmpty = false,
): asserts value is string {
    if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) {
        throw new IndexFailure('invalid');
    }
}

function displayUrl(value: JsonValue | undefined): asserts value is string {
    text(value, 4096);

    try {
        const url = new URL(value);

        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
            throw new IndexFailure('invalid');
        }
    } catch {
        throw new IndexFailure('invalid');
    }
}

export function parseCommunityIndex(input: unknown): CommunityIndex {
    validateJson(input);
    const root = record(input);
    text(root.version, 128);
    text(root.updateTime, 128);
    displayUrl(root.statsUrl);

    if (!Array.isArray(root.plugins) || root.plugins.length > 10_000) {
        throw new IndexFailure('invalid');
    }

    for (const value of root.plugins) {
        const plugin = record(value);

        for (const key of ['id', 'name', 'version', 'author', 'minVersion']) {
            text(plugin[key], 1024);
        }

        text(plugin.description, 16_384, true);
        displayUrl(plugin.homepage);
        displayUrl(plugin.downloadUrl);

        if (plugin.tags !== undefined) {
            if (!Array.isArray(plugin.tags) || plugin.tags.length > 128) {
                throw new IndexFailure('invalid');
            }

            for (const tag of plugin.tags) {
                text(tag, 256);
            }
        }
    }

    return input as unknown as CommunityIndex;
}

interface ResponseResources {
    body: ReadableStream<Uint8Array> | null;
    reader: ReadableStreamDefaultReader<Uint8Array> | null;
}

// Cancellation is best-effort: an untrusted stream may never settle its cancel promise.
function cancelResponse(resources: ResponseResources): void {
    const { body, reader } = resources;
    resources.body = null;
    resources.reader = null;

    if (reader) {
        try {
            void reader.cancel().catch(() => {});
        } catch {
            // Cleanup must not change the externally visible error.
        } finally {
            try {
                reader.releaseLock();
            } catch {
                // Ignore already-released readers.
            }
        }
    } else if (body) {
        try {
            void body.cancel().catch(() => {});
        } catch {
            // Cleanup must not change the externally visible error.
        }
    }
}

async function readBody(response: Response, resources: ResponseResources): Promise<unknown> {
    const length = response.headers.get('content-length');

    if (length && /^\d+$/.test(length) && Number(length) > INDEX_MAX_BYTES) {
        throw new IndexFailure('too_large');
    }

    if (!response.body) {
        throw new IndexFailure('invalid');
    }

    const reader = response.body.getReader();
    resources.reader = reader;
    const bytes = new Uint8Array(INDEX_MAX_BYTES);
    let total = 0;
    let chunks = 0;
    let complete = false;

    try {
        while (true) {
            const { value, done } = await reader.read();

            if (done) {
                complete = true;
                break;
            }

            if (++chunks > 8192) {
                throw new IndexFailure('invalid');
            }

            if (value.byteLength > INDEX_MAX_BYTES - total) {
                throw new IndexFailure('too_large');
            }

            bytes.set(value, total);
            total += value.byteLength;
        }
    } finally {
        if (complete) {
            if (resources.reader === reader) {
                resources.reader = null;
                resources.body = null;
                reader.releaseLock();
            }
        } else {
            cancelResponse(resources);
        }
    }

    try {
        return JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total)),
        ) as unknown;
    } catch {
        throw new IndexFailure('invalid');
    }
}

type IndexSnapshot = {
    index: CommunityIndex;
    fetchedAt: number;
    validatedAt: number;
    etag: string | null;
};

type IndexRefresh =
    | { kind: 'replaced'; index: CommunityIndex; etag: string | null }
    | { kind: 'unchanged'; previous: IndexSnapshot; etag: string };

type IndexFlight = { promise: Promise<IndexResult>; force: boolean };

/** Admit one bounded ASCII entity-tag, never a list or wildcard. */
function entityTag(value: unknown): string | null {
    return typeof value === 'string' &&
        value.length <= 1024 &&
        /^(?:W\/)?"[\x21\x23-\x7e]*"$/.test(value)
        ? value
        : null;
}

function opaqueTag(value: string): string {
    return value.startsWith('W/') ? value.slice(2) : value;
}

function snapshotResult(snapshot: IndexSnapshot, error: IndexError | null): IndexResult {
    return {
        index: snapshot.index,
        fetchedAt: snapshot.fetchedAt,
        stale: error !== null,
        error,
        verified: false,
        minVersionTarget: 'NapCat',
    };
}

export interface CommunityIndexOptions {
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    timeoutMs?: number;
}

/** No network occurs until get() is called. Only the fixed public index URL is fetched. */
export function createCommunityIndexService(options: CommunityIndexOptions = {}) {
    const fetchIndex = options.fetch ?? globalThis.fetch;
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? INDEX_TIMEOUT_MS;
    let snapshot: IndexSnapshot | null = null;
    let pending: IndexFlight | null = null;
    let lastError: IndexError | null = null;

    async function refresh(): Promise<IndexResult> {
        const previous = snapshot;
        const validator = previous?.etag ?? null;
        const controller = new AbortController();
        const resources: ResponseResources = { body: null, reader: null };
        let timer: ReturnType<typeof setTimeout> | undefined;

        try {
            const request = async (): Promise<IndexRefresh> => {
                const response = await fetchIndex(COMMUNITY_INDEX_URL, {
                    method: 'GET',
                    redirect: 'error',
                    signal: controller.signal,
                    headers: {
                        Accept: 'application/json',
                        ...(validator === null ? {} : { 'If-None-Match': validator }),
                    },
                });

                resources.body = response.body;

                if (controller.signal.aborted) {
                    cancelResponse(resources);
                    throw new IndexFailure('timeout');
                }

                const url = response.url;

                if (response.redirected || (url && url !== COMMUNITY_INDEX_URL)) {
                    throw new IndexFailure('http');
                }

                const status = response.status;

                if (status === 304) {
                    if (previous === null || validator === null || resources.body !== null) {
                        throw new IndexFailure('http');
                    }

                    const field = response.headers.get('etag');
                    const etag = field === null ? validator : entityTag(field);

                    if (etag === null || opaqueTag(etag) !== opaqueTag(validator)) {
                        throw new IndexFailure('http');
                    }

                    return { kind: 'unchanged', previous, etag };
                }

                if (!response.ok) {
                    throw new IndexFailure('http');
                }

                const index = parseCommunityIndex(await readBody(response, resources));
                const etag = status === 200 ? entityTag(response.headers.get('etag')) : null;
                return { kind: 'replaced', index, etag };
            };

            const result = await Promise.race([
                request(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        controller.abort();
                        reject(new IndexFailure('timeout'));
                    }, timeoutMs);
                }),
            ]);
            const validatedAt = now();

            if (controller.signal.aborted) {
                throw new IndexFailure('timeout');
            }

            snapshot =
                result.kind === 'unchanged'
                    ? { ...result.previous, validatedAt, etag: result.etag }
                    : {
                          index: result.index,
                          fetchedAt: validatedAt,
                          validatedAt,
                          etag: result.etag,
                      };
            lastError = null;
            return snapshotResult(snapshot, null);
        } catch (error) {
            const code = error instanceof IndexFailure ? error.code : 'network';
            lastError = code;

            if (snapshot) {
                return snapshotResult(snapshot, code);
            }

            return {
                index: null,
                fetchedAt: null,
                stale: true,
                error: code,
                verified: false,
                minVersionTarget: 'NapCat',
            };
        } finally {
            if (timer !== undefined) {
                clearTimeout(timer);
            }

            controller.abort();
            cancelResponse(resources);
        }
    }

    async function get(force = false): Promise<IndexResult> {
        if (pending) {
            pending.force ||= force;
            return structuredClone(await pending.promise);
        }

        // Publish the shared decision before the injected clock or fetch can reenter.
        let resolve!: (result: IndexResult | PromiseLike<IndexResult>) => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<IndexResult>((onSuccess, onFailure) => {
            resolve = onSuccess;
            reject = onFailure;
        });
        const flight: IndexFlight = { promise, force };
        pending = flight;

        try {
            const cached = snapshot;
            let hit: IndexResult | null = null;

            if (!flight.force && cached) {
                try {
                    const time = now();

                    if (
                        !flight.force &&
                        time >= cached.validatedAt &&
                        time - cached.validatedAt < INDEX_TTL_MS
                    ) {
                        hit = snapshotResult(cached, lastError);
                    }
                } catch (error) {
                    // A reentrant explicit refresh does not need the failed cache-age sample.
                    if (!flight.force) {
                        throw error;
                    }
                }
            }

            if (hit) {
                // A completed cache decision must not absorb a subsequent explicit refresh.
                pending = null;
                resolve(hit);
            } else {
                resolve(refresh());
            }
        } catch (error) {
            if (pending === flight) {
                pending = null;
            }

            reject(error);
        }

        try {
            return structuredClone(await promise);
        } finally {
            if (pending === flight) {
                pending = null;
            }
        }
    }

    return { get };
}
