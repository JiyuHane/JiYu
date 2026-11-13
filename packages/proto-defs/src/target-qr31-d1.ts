import type { bytes, pb, pb_optional, uint_32 } from '@snowluma/proton';

// Partial static observation in wrapper.node SHA-256
// dc5209e20002735e31a20c9cded0a807d1db4779277dec66c9221ea28a870328
// at 0x34601d0. Empty-byte wire presence is a single static observation and a
// local encoding policy, not independently confirmed target wire behavior.
// Field meanings and peer interoperability remain unverified.
export interface TargetQr31D1Field1 {
    field1: pb_optional<1, bytes>;
    field2: pb_optional<2, bytes>;
}

export interface TargetQr31D1Field4 {
    field6: pb<6, uint_32>;
}

export interface TargetQr31D1 {
    field1: pb<1, TargetQr31D1Field1>;
    field4: pb<4, TargetQr31D1Field4>;
}
