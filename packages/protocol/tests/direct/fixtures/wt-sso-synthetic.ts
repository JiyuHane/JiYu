import { createWtEcdh } from '../../../src/direct/wt-ecdh';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../../src/direct/qq-tea';
import { encodeWtTlv } from '../../../src/direct/wt-tlv';
import { encodeWtQrD1 } from '../../../src/direct/wt-qr-protobuf';

// Synthetic fixture only: this policy does not establish server identity or QQ compatibility.
export const peer = createWtEcdh(Buffer.concat([Buffer.alloc(23), Buffer.of(2)]));
const key = new Uint8Array(16).fill(4);

const int = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n | 0);
    return b;
};

const field = (b: Uint8Array) => Buffer.concat([int(b.length + 4), b]);
const header = (code: number) => Buffer.from([0, 0, 0, 0, 0, 42, code]);
export const fetchBody = () =>
    Buffer.concat([
        header(0),
        Buffer.from([0, 3, 1, 2, 3]),
        encodeWtTlv([
            { tag: 0x17, value: Uint8Array.of(7, 8) },
            { tag: 0xd1, value: encodeWtQrD1({ qrUrl: 'https://example.invalid/qr' }) },
        ]),
    ]);
export const pollBody = (code: number, uin = 123n) =>
    code
        ? header(code)
        : Buffer.concat(
              [
                  header(0),
                  Buffer.from('000000000000000000000000', 'hex'),
                  encodeWtTlv([
                      { tag: 0x1e, value: key },
                      { tag: 0x19, value: Uint8Array.of(5) },
                      { tag: 0x18, value: Uint8Array.of(6) },
                  ]),
              ].map((b, i) => {
                  if (i === 1) {
                      b.writeBigInt64BE(uin);
                  }

                  return b;
              }),
          );

export function parseWt(frame: Uint8Array) {
    const b = Buffer.from(frame);
    const start = 9 + b.readUInt32BE(9) + 1,
        end = start + b.readUInt32BE(start);
    const account = b.subarray(start + 4, end).toString();
    const sso = Buffer.from(qqTeaDecrypt(b.subarray(end), new Uint8Array(16)));
    let pos = 28;

    const read = () => {
        const n = sso.readUInt32BE(pos);
        const v = sso.subarray(pos + 4, pos + n);
        pos += n;
        return v;
    };

    read();
    const command = read().toString();
    read();
    read();
    read();
    pos += sso.readUInt16BE(pos);
    const reserved = Buffer.from(read());
    const oicq = Buffer.from(sso.subarray(sso.readUInt32BE(0) + 4));
    const point = Buffer.from(oicq.subarray(48, 73));
    const shared = peer.deriveTeaKey(point);
    const business = Buffer.from(qqTeaDecrypt(oicq.subarray(73, -1), shared));
    return {
        account,
        seq: sso.readUInt32BE(4),
        command,
        reserved,
        oicq,
        point,
        shared,
        business,
        kind: oicq.readUInt16BE(5) === 0x810 ? 0x810 : business.readUInt16BE(21),
    };
}

type Request = ReturnType<typeof parseWt>;

export function replyWt(req: Request, business: Uint8Array) {
    let body: Uint8Array = business;

    if (req.kind !== 0x810) {
        const layer = Buffer.alloc(43);
        layer.writeUInt16BE(req.kind, 3);
        layer.writeBigInt64BE(0n, 35);
        const code2d = Buffer.concat([layer, business]);
        body = Buffer.concat([
            Buffer.from([0, 0, code2d.length >> 8, code2d.length & 255, 0]),
            code2d,
        ]);
    }

    const cipher = qqTeaEncrypt(body, req.shared);
    const wt = Buffer.alloc(17 + cipher.length);
    wt[0] = 2;
    wt.writeUInt16BE(wt.length, 1);
    wt.writeUInt16BE(req.kind === 0x810 ? 0x810 : 0x812, 5);
    wt.writeUInt32BE(req.kind === 0x810 ? 123 : 0, 9);
    wt.set(cipher, 16);
    wt[wt.length - 1] = 3;
    const sso = Buffer.concat([
        field(
            Buffer.concat([
                int(req.seq),
                int(0),
                field(Buffer.alloc(0)),
                field(Buffer.from(req.command)),
                field(Buffer.alloc(0)),
                int(0),
                field(Buffer.alloc(0)),
            ]),
        ),
        field(wt),
    ]);
    const encrypted = qqTeaEncrypt(sso, new Uint8Array(16));
    const account = Buffer.from(req.kind === 0x810 ? '123' : '999');
    return Buffer.concat([
        int(14 + account.length + encrypted.length),
        int(12),
        Buffer.of(2, 0),
        field(account),
        encrypted,
    ]);
}

export const loginReply = () =>
    Buffer.concat([
        Buffer.of(0, 9, 0),
        encodeWtTlv([
            {
                tag: 0x119,
                value: qqTeaEncrypt(
                    encodeWtTlv([
                        { tag: 0x143, value: Uint8Array.of(9) },
                        { tag: 0x305, value: new Uint8Array(16).fill(10) },
                        { tag: 0x10a, value: Uint8Array.of(11) },
                        { tag: 0x106, value: Uint8Array.of(12) },
                    ]),
                    key,
                ),
            },
        ]),
    ]);
