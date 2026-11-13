export interface TargetWtSendCounterCandidate {
    readonly keyLow32: number;
    readonly commandLow16: number;
    readonly sequence: number;
    readonly nextSequence: number;
    readonly marker: 0x87;
}

/**
 * Offline value candidate for the inspected normal branch of 0x34f6610.
 * The caller supplies the old sequence; this function neither finds a node nor
 * stores the next value. The native lookup uses the full 64-bit key: matching
 * keyLow32 values do not imply matching nodes or shared counters. Creation,
 * failure, concurrency and persistence are outside this pure calculation.
 * This is not a WT encoder, decoder or send operation; byte order, header
 * layout, signing, frame validity and interoperability are not established.
 */
export function targetWtSendCounterCandidate(
    key: bigint,
    command: number,
    oldSequence: number,
): Readonly<TargetWtSendCounterCandidate> {
    if (
        typeof key !== 'bigint' ||
        key < 0n ||
        key > 0xffffffffffffffffn ||
        typeof command !== 'number' ||
        !Number.isSafeInteger(command) ||
        command < 0 ||
        command > 0xffffffff ||
        typeof oldSequence !== 'number' ||
        !Number.isSafeInteger(oldSequence) ||
        oldSequence < 0 ||
        oldSequence > 0xffff
    ) {
        throw new Error('target WT send counter candidate failed');
    }

    const sequence = oldSequence & 0xffff;
    return Object.freeze({
        keyLow32: Number(key & 0xffffffffn),
        commandLow16: command & 0xffff,
        sequence,
        nextSequence: (sequence + 1) & 0xffff,
        marker: 0x87 as const,
    });
}
