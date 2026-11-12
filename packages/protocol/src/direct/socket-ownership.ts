import type { Socket } from 'node:net';

// Shared by all direct socket transports; it does not restrict caller listeners.
const owners = new WeakMap<Socket, object>();

/** Claim a socket until the returned idempotent release is called. */
export function claimDirectSocket(socket: Socket): () => void {
    if (owners.has(socket)) {
        throw new Error('socket already owned by a direct transport');
    }

    const token = {};
    owners.set(socket, token);

    return () => {
        if (owners.get(socket) === token) {
            owners.delete(socket);
        }
    };
}
