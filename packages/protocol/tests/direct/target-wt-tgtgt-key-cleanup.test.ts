import { describe, expect, it, vi } from 'vitest';

type Failure = 'createHash' | 'update' | 'digest' | 'output-copy';
type FillFailure = 'message' | 'digest';

const failureMessage = 'target WT tgtgt key candidate failed';
const digestBytes = Array.from({ length: 16 }, (_, index) => index + 1);
const expectedMessage = [
    0x21, 0x43, 0x65, 0x87, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8,
];

async function exercise(failure?: Failure, fillFailure?: FillFailure): Promise<void> {
    const backing = Uint8Array.of(0xaa, 0x21, 0x43, 0x65, 0x87, 0xbb);
    const source = backing.subarray(1, 5);
    const digest = Uint8Array.from(digestBytes);
    const originalSet = Uint8Array.prototype.set;
    const originalFill = Uint8Array.prototype.fill;
    let message: Uint8Array | undefined;
    let output: Uint8Array | undefined;
    let snapshot: number[] | undefined;
    let active = false;
    let fillFailures = 0;
    let updateMessage: Uint8Array | undefined;
    let hashAlgorithm: string | undefined;
    const cleared: Uint8Array[] = [];
    let setSpy: ReturnType<typeof vi.spyOn> | undefined;
    let fillSpy: ReturnType<typeof vi.spyOn> | undefined;

    const digestFn = vi.fn(() => {
        if (failure === 'digest') {
            throw new Error('private digest failure');
        }

        return digest;
    });
    const update = vi.fn((bytes: Uint8Array) => {
        updateMessage = bytes;
        snapshot = Array.from(bytes);

        if (failure === 'update') {
            throw new Error('private update failure');
        }

        return { digest: digestFn };
    });
    const createHash = vi.fn((algorithm: string) => {
        hashAlgorithm = algorithm;
        snapshot = Array.from(message!);

        if (failure === 'createHash') {
            throw new Error('private createHash failure');
        }

        return { update };
    });

    vi.resetModules();

    try {
        vi.doMock('node:crypto', () => ({ createHash }));
        setSpy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            value: ArrayLike<number>,
            offset?: number,
        ) {
            if (!active) {
                originalSet.call(this, value, offset);
                return;
            }

            if (message === undefined) {
                message = this;
                originalSet.call(this, value, offset);
                return;
            }

            output = this;
            originalSet.call(this, value, offset);

            if (failure === 'output-copy') {
                throw new Error('private output copy failure');
            }
        });
        fillSpy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value: number,
            start?: number,
            end?: number,
        ) {
            if (active && (this === message || this === digest || this === output)) {
                cleared.push(this);

                if (
                    fillFailures === 0 &&
                    ((fillFailure === 'message' && this === message) ||
                        (fillFailure === 'digest' && this === digest))
                ) {
                    fillFailures++;
                    throw new Error('private fill failure');
                }
            }

            return originalFill.call(this, value, start, end);
        });

        const { deriveTargetWtTgtgtKeyCandidate } =
            await import('../../src/direct/target-wt-tgtgt-key-candidate');
        let result: Uint8Array | undefined;
        let thrown: unknown;
        active = true;

        try {
            result = deriveTargetWtTgtgtKeyCandidate(source, 0x0102030405060708n);
        } catch (error) {
            thrown = error;
        } finally {
            active = false;
        }

        if (failure) {
            expect(thrown).toBeInstanceOf(Error);
            expect((thrown as Error).message).toBe(failureMessage);
            expect(result).toBeUndefined();
        } else {
            expect(thrown).toBeUndefined();
        }

        expect(hashAlgorithm).toBe('md5');
        expect(createHash).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledTimes(failure === 'createHash' ? 0 : 1);
        expect(updateMessage).toBe(failure === 'createHash' ? undefined : message);
        expect(digestFn).toHaveBeenCalledTimes(
            failure === 'createHash' || failure === 'update' ? 0 : 1,
        );
        expect(snapshot).toEqual(expectedMessage);
        expect(message).toBeDefined();
        expect(backing).toEqual(Uint8Array.of(0xaa, 0x21, 0x43, 0x65, 0x87, 0xbb));
        expect(cleared.filter((bytes) => bytes === message)).toHaveLength(1);
        expect(Array.from(message!)).toEqual(
            fillFailure === 'message' ? expectedMessage : new Array(24).fill(0),
        );

        const hasDigest = failure !== 'createHash' && failure !== 'update' && failure !== 'digest';
        expect(cleared.filter((bytes) => bytes === digest)).toHaveLength(hasDigest ? 1 : 0);
        expect(Array.from(digest)).toEqual(
            hasDigest && fillFailure !== 'digest' ? new Array(16).fill(0) : digestBytes,
        );

        if (failure === 'output-copy') {
            expect(output).toBeDefined();
            expect(cleared.filter((bytes) => bytes === output)).toHaveLength(1);
            expect(Array.from(output!)).toEqual(new Array(16).fill(0));
        } else if (failure) {
            expect(output).toBeUndefined();
        } else {
            expect(result).toBe(output);
            expect(result).not.toBe(digest);
            expect(Array.from(result!)).toEqual(digestBytes);
            expect(cleared).not.toContain(output);
        }

        expect(fillFailures).toBe(fillFailure ? 1 : 0);
    } finally {
        active = false;
        fillSpy?.mockRestore();
        setSpy?.mockRestore();
        vi.doUnmock('node:crypto');
        vi.resetModules();
    }
}

describe('offline target WT tgtgt key candidate cleanup', () => {
    it.each(['createHash', 'update', 'digest', 'output-copy'] as const)(
        'sanitizes the %s failure and clears every allocated private buffer',
        async (failure) => {
            await exercise(failure);
        },
    );

    it('returns an independent digest while clearing private allocations', async () => {
        await exercise();
    });

    it.each(['message', 'digest'] as const)(
        'preserves the successful output when clearing %s throws once',
        async (buffer) => {
            await exercise(undefined, buffer);
        },
    );

    it.each(['message', 'digest'] as const)(
        'still clears the failed output when clearing %s throws once',
        async (buffer) => {
            await exercise('output-copy', buffer);
        },
    );
});
