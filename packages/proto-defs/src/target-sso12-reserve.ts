import type { bytes, pb, pb_optional, pb_repeated, uint_32 } from '@snowluma/proton';

// Partial target-static observations for wrapper.node SHA-256
// dc5209e20002735e31a20c9cded0a807d1db4779277dec66c9221ea28a870328.
// This remains a subset; meanings and wire compatibility remain unknown.
// Ascending parent serialization order is inferred.
export interface TargetSso12ReserveField23 {
    field1?: pb_optional<1, bytes>;
    field2?: pb_optional<2, bytes>;
}

export interface TargetSso12ReserveField24 {
    field1?: pb<1, bytes>;
    field2?: pb<2, bytes>;
    field3?: pb<3, bytes>;
}

export interface TargetSso12ReserveMessage {
    field12?: pb<12, bytes>;
    field13?: pb_optional<13, bytes>;
    field15?: pb_optional<15, bytes>;
    field16?: pb_optional<16, bytes>;
    field21?: pb_optional<21, uint_32>;
    field23?: pb_repeated<23, TargetSso12ReserveField23>;
    field24?: pb<24, TargetSso12ReserveField24>;
    field26?: pb_optional<26, uint_32>;
    field32?: pb<32, bytes>;
}
