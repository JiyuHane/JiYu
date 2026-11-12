import { MAX_SERVICE_FRAME_BYTES } from './service-frame';

/** Incrementally separate service frames from a TCP byte stream. */
export class ServiceFrameDecoder {
    private readonly prefix = new Uint8Array(4);
    private prefixUsed = 0;
    private frame: Uint8Array | null = null;
    private frameUsed = 0;
    private failed = false;

    /**
     * Returns complete frames in order and retains at most one partial frame.
     * An invalid length poisons this decoder: discard it with the connection.
     */
    push(chunk: Uint8Array): Uint8Array[] {
        if (this.failed) {
            throw new Error('service stream decoder is closed');
        }

        const completed: Uint8Array[] = [];
        let cursor = 0;

        while (cursor < chunk.length) {
            if (!this.frame) {
                const count = Math.min(4 - this.prefixUsed, chunk.length - cursor);
                this.prefix.set(chunk.subarray(cursor, cursor + count), this.prefixUsed);
                this.prefixUsed += count;
                cursor += count;

                if (this.prefixUsed < 4) {
                    continue;
                }

                const length = new DataView(this.prefix.buffer).getUint32(0);

                if (length < 14 || length > MAX_SERVICE_FRAME_BYTES) {
                    this.failed = true;
                    throw new Error('invalid service frame length');
                }

                this.frame = new Uint8Array(length);
                this.frame.set(this.prefix);
                this.frameUsed = 4;
                this.prefixUsed = 0;
            }

            const count = Math.min(this.frame.length - this.frameUsed, chunk.length - cursor);
            this.frame.set(chunk.subarray(cursor, cursor + count), this.frameUsed);
            this.frameUsed += count;
            cursor += count;

            if (this.frameUsed === this.frame.length) {
                completed.push(this.frame);
                this.frame = null;
                this.frameUsed = 0;
            }
        }

        return completed;
    }

    /** Reject end-of-stream while a length prefix or frame remains incomplete. */
    finish(): void {
        if (this.failed) {
            throw new Error('service stream decoder is closed');
        }

        this.failed = true;

        if (this.prefixUsed !== 0 || this.frame !== null) {
            throw new Error('truncated service frame');
        }
    }
}
