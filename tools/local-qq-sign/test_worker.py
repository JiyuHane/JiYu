"""Own-code tests: no QQ, native loading, process attachment or networking."""

from __future__ import annotations

import builtins
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import struct
import subprocess
import sys
import unittest
from unittest import mock

import worker as w


HERE = Path(__file__).resolve().parent


def record(**changes: object) -> bytes:
    value = {"id": 1, "command": "test.Command", "sequence": 0, "body": "0001aAFF"}
    value.update(changes)
    return json.dumps(value, separators=(",", ":")).encode("utf-8") + b"\n"


def output_bytes(token: bytes = b"\x12", extra: bytes = b"\x34", sign: bytes = b"\xab\xcd") -> bytes:
    data = bytearray(w.OUTPUT_SIZE)
    for offset, value in ((0, token), (0x100, extra), (0x200, sign)):
        if len(value) > 255:
            raise ValueError("fixture length")
        data[offset:offset + len(value)] = value
        data[offset + 255] = len(value)
    return bytes(data)


class FakeBackend:
    def __init__(self, action=None):
        self.action = action
        self.calls = []
        self.closed = 0
        self.active = False

    def sign(self, command, body, length, sequence, output):
        if self.active:
            raise AssertionError("overlapping calls")
        self.active = True
        self.calls.append((command, body, length, sequence, len(output)))
        try:
            if self.action:
                return self.action(output)
            output[:] = output_bytes()
        finally:
            self.active = False

    def close(self):
        self.closed += 1


def session(data: bytes, backend=None):
    backend = FakeBackend() if backend is None else backend
    stdout, stderr = io.StringIO(), io.StringIO()
    status = w.run_worker(backend, io.BytesIO(data), stdout, stderr)
    return status, [json.loads(line) for line in stdout.getvalue().splitlines()], stderr.getvalue(), backend


def synthetic_elf(*, flags=5, offset=None, rva=None, file_size=None, memory_size=None, align=0x1000):
    offset = w.BUILD.rx_offset if offset is None else offset
    rva = w.BUILD.rx_rva if rva is None else rva
    file_size = w.BUILD.rx_size if file_size is None else file_size
    memory_size = file_size if memory_size is None else memory_size
    ident = b"\x7fELF\x02\x01\x01" + bytes(9)
    header = struct.pack("<16sHHIQQQIHHHHHH", ident, 3, 62, 1, 0, 64, 0, 0, 64, 56, 1, 0, 0, 0)
    phdr = struct.pack("<IIQQQQQQ", 1, flags, offset, rva, 0, file_size, memory_size, align)
    return header, phdr, offset + file_size


class ParseTests(unittest.TestCase):
    def assert_error(self, code, data, request_id=None):
        with self.assertRaises(w.WorkerError) as caught:
            w.parse_request(data)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(caught.exception.request_id, request_id)

    def test_valid_request(self):
        request = w.parse_request(record())
        self.assertEqual(request, w.Request(1, "test.Command", 0, b"\x00\x01\xaa\xff"))

    def test_id_and_sequence_upper_bounds(self):
        request = w.parse_request(record(id=w.MAX_SAFE_INTEGER, sequence=w.MAX_U32))
        self.assertEqual(request.id, w.MAX_SAFE_INTEGER)
        self.assertEqual(request.sequence, w.MAX_U32)

    def test_invalid_ids(self):
        for value in (0, -1, w.MAX_SAFE_INTEGER + 1, True, False, 1.0, "1", None):
            with self.subTest(value=value):
                self.assert_error("invalid-id", record(id=value))

    def test_invalid_sequences(self):
        for value in (-1, w.MAX_U32 + 1, True, False, 0.0, "0", None):
            with self.subTest(value=value):
                self.assert_error("invalid-sequence", record(sequence=value), 1)

    def test_command_boundaries(self):
        self.assertEqual(len(w.parse_request(record(command="a" * 256)).command), 256)
        self.assertEqual(w.parse_request(record(command="\x01\x7f")).command, "\x01\x7f")

    def test_invalid_commands(self):
        for value in ("", "a" * 257, "a\0b", "非ASCII", "\ud800", None, 8, True):
            with self.subTest(value=value):
                self.assert_error("invalid-command", record(command=value), 1)

    def test_empty_body(self):
        self.assertEqual(w.parse_request(record(body="")).body, b"")

    def test_maximum_body(self):
        body = "a5" * w.MAX_BODY_BYTES
        self.assertEqual(len(w.parse_request(record(body=body)).body), w.MAX_BODY_BYTES)

    def test_body_exceeds_limit(self):
        self.assert_error("invalid-body", record(body="00" * (w.MAX_BODY_BYTES + 1)), 1)

    def test_invalid_hex(self):
        for value in ("0", "xyz0", "00 00", "00\n00", "0x00", "ｆｆ", True, 0, None, []):
            with self.subTest(value=value):
                self.assert_error("invalid-body", record(body=value), 1)

    def test_non_json(self):
        for data in (b"", b" \n", b"hello", b"{", b"{}{}", b"\xff", b"\xef\xbb\xbf{}"):
            with self.subTest(data=data):
                self.assert_error("invalid-json", data)

    def test_non_object(self):
        for data in (b"null", b"[]", b"true", b"1", b'"text"'):
            with self.subTest(data=data):
                self.assert_error("invalid-request", data)

    def test_duplicate_key_even_when_same_value(self):
        self.assert_error("duplicate-key", b'{"id":1,"id":1,"command":"a","sequence":0,"body":""}')

    def test_duplicate_escaped_key(self):
        self.assert_error("duplicate-key", b'{"id":1,"\\u0069d":2}')

    def test_duplicate_nested_key(self):
        self.assert_error("duplicate-key", b'{"id":1,"extra":{"x":1,"x":2}}')

    def test_unknown_or_missing_fields(self):
        self.assert_error("invalid-request", record(unexpected="private"), 1)
        self.assert_error("invalid-request", b'{"id":2}', 2)
        self.assert_error("invalid-request", b'{"command":"a","sequence":0,"body":""}')

    def test_nonstandard_json_numbers(self):
        for literal in (b"NaN", b"Infinity", b"-Infinity"):
            with self.subTest(literal=literal):
                self.assert_error("invalid-json", b'{"id":' + literal + b'}')

    def test_huge_integer_is_bounded_before_conversion(self):
        self.assert_error("invalid-json", b'{"id":' + b"9" * 10000 + b'}')

    def test_excessive_nesting_is_classified(self):
        self.assert_error("invalid-json", b"[" * 2000 + b"0" + b"]" * 2000)

    def test_depth_guard_ignores_brackets_and_escaped_quotes_in_strings(self):
        command = ('[\\\"{}]' * 20)[:256]
        self.assertEqual(w.parse_request(record(command=command)).command, command)

    def test_parser_recursion_exception_is_classified(self):
        with mock.patch.object(w.json, "loads", side_effect=RecursionError("private")):
            self.assert_error("invalid-json", record())

    def test_wire_length_limit(self):
        self.assert_error("line-too-long", b" " * (w.MAX_LINE_BYTES + 1))

    def test_whitespace_and_crlf(self):
        request = w.parse_request(b" \t" + record().rstrip(b"\n") + b" \r\n")
        self.assertEqual(request.id, 1)


class OutputAndCallTests(unittest.TestCase):
    def test_slot_order_and_lowercase_hex(self):
        self.assertEqual(w.extract_output(output_bytes()), {"sign": "abcd", "token": "12", "extra": "34"})

    def test_all_slot_length_boundaries(self):
        for length in (0, 1, 127, 128, 254, 255):
            with self.subTest(length=length):
                sign = b"\x01" * max(1, length)
                result = w.extract_output(output_bytes(b"\xa5" * length, b"\xbc" * length, sign))
                self.assertEqual(result, {"sign": sign.hex(), "token": "a5" * length, "extra": "bc" * length})

    def test_ignores_unfilled_slot_tail(self):
        data = bytearray(b"\xee" * w.OUTPUT_SIZE)
        data[0xFF] = 0
        data[0x1FF] = 1
        data[0x2FF] = 2
        self.assertEqual(w.extract_output(data), {"sign": "eeee", "token": "", "extra": "ee"})

    def test_empty_sign_fails(self):
        with self.assertRaises(w.WorkerError) as caught:
            w.extract_output(output_bytes(sign=b""))
        self.assertEqual(caught.exception.code, "empty-sign")

    def test_wrong_output_size(self):
        for length in (0, 767, 769):
            with self.subTest(length=length), self.assertRaises(w.WorkerError) as caught:
                w.extract_output(bytes(length))
            self.assertEqual(caught.exception.code, "invalid-output")

    def test_memoryview_nonzero_offset(self):
        backing = bytearray(b"prefix" + output_bytes() + b"suffix")
        result = w.extract_output(memoryview(backing)[6:6 + w.OUTPUT_SIZE])
        backing[:] = bytes(len(backing))
        self.assertEqual(result, {"sign": "abcd", "token": "12", "extra": "34"})

    def test_exact_call_arguments_and_window(self):
        backend = FakeBackend()
        result = w.sign_request(w.parse_request(record(sequence=w.MAX_U32)), backend)
        self.assertEqual(backend.calls, [(b"test.Command\0", b"\x00\x01\xaa\xff", 4, w.MAX_U32, 0x300)])
        self.assertEqual(result["sign"], "abcd")

    def test_empty_body_pointer_contract(self):
        backend = FakeBackend()
        w.sign_request(w.parse_request(record(body="")), backend)
        self.assertEqual(backend.calls[0][1:3], (b"", 0))

    def test_native_return_is_not_interpreted(self):
        def action(output):
            output[:] = output_bytes()
            return -999
        self.assertEqual(w.sign_request(w.parse_request(record()), FakeBackend(action))["sign"], "abcd")

    def test_both_canaries(self):
        for index in (0, len(w.GUARD_BEFORE) + w.OUTPUT_SIZE):
            def corrupt(output):
                output[:] = output_bytes()
                output.obj[index] ^= 0xFF
            with self.subTest(index=index), self.assertRaises(w.WorkerError) as caught:
                w.sign_request(w.parse_request(record()), FakeBackend(corrupt))
            self.assertEqual(caught.exception.code, "output-guard")
            self.assertEqual(caught.exception.request_id, 1)

    def test_guard_precedes_backend_exception(self):
        def corrupt(output):
            output.obj[0] ^= 1
            raise RuntimeError("private request and path")
        with self.assertRaises(w.WorkerError) as caught:
            w.sign_request(w.parse_request(record()), FakeBackend(corrupt))
        self.assertEqual(caught.exception.code, "output-guard")

    def test_backend_exceptions_are_classified(self):
        def fail(_output):
            raise RuntimeError("/private/native.so request=secret")
        with self.assertRaises(w.WorkerError) as caught:
            w.sign_request(w.parse_request(record()), FakeBackend(fail))
        self.assertEqual(str(caught.exception), "native-call-failed")

    def test_output_window_starts_zeroed_and_is_not_shared(self):
        objects = []
        def action(output):
            self.assertEqual(bytes(output), bytes(w.OUTPUT_SIZE))
            objects.append(output.obj)
            output[:] = output_bytes()
        backend = FakeBackend(action)
        first = w.sign_request(w.parse_request(record()), backend)
        w.sign_request(w.parse_request(record(id=2)), backend)
        self.assertIsNot(objects[0], objects[1])
        self.assertEqual(first["sign"], "abcd")


class ElfTests(unittest.TestCase):
    def assert_elf_error(self, code, parts):
        with self.assertRaises(w.WorkerError) as caught:
            w.validate_elf(*parts)
        self.assertEqual(caught.exception.code, code)

    def test_manifest_matches_reviewed_rx(self):
        layout = w.validate_elf(*synthetic_elf())
        self.assertEqual(layout.segments[0], w.LoadSegment(5, 0x299D300, 0x299E300, 0x6475100, 0x6475100))
        self.assertEqual(w.BUILD.sign_rva, 0x6856284)

    def test_short_header_or_table(self):
        header, phdr, size = synthetic_elf()
        self.assert_elf_error("invalid-elf", (header[:-1], phdr, size))
        self.assert_elf_error("invalid-elf", (header, phdr[:-1], size))

    def test_wrong_elf_class_endian_machine_type(self):
        header, phdr, size = synthetic_elf()
        for index, value in ((0, 0), (4, 1), (5, 2), (6, 0), (16, 2), (18, 3), (20, 0), (52, 0), (54, 55), (56, 0)):
            changed = bytearray(header)
            changed[index] = value
            with self.subTest(index=index):
                self.assert_elf_error("invalid-elf", (bytes(changed), phdr, size))

    def test_program_table_out_of_file(self):
        header, phdr, _size = synthetic_elf()
        self.assert_elf_error("invalid-elf", (header, phdr, 100))

    def test_rx_mapping_and_flags_must_match(self):
        for changes in ({"flags": 4}, {"flags": 7}, {"rva": w.BUILD.rx_rva + 0x1000}, {"offset": w.BUILD.rx_offset + 0x1000}, {"file_size": w.BUILD.rx_size - 1}):
            with self.subTest(changes=changes):
                self.assert_elf_error("abi-mismatch", synthetic_elf(**changes))

    def test_reject_file_segment_past_end(self):
        header, phdr, size = synthetic_elf()
        self.assert_elf_error("invalid-elf", (header, phdr, size - 1))

    def test_reject_file_larger_than_memory(self):
        self.assert_elf_error("invalid-elf", synthetic_elf(memory_size=w.BUILD.rx_size - 1))

    def test_bad_alignment(self):
        for changes in ({"align": 3}, {"rva": w.BUILD.rx_rva + 1}):
            with self.subTest(changes=changes):
                self.assert_elf_error("invalid-elf", synthetic_elf(**changes))

    def test_rva_overflow(self):
        self.assert_elf_error("invalid-elf", synthetic_elf(rva=w.MAX_U64 - 10, align=1))

    def test_executable_window_boundaries(self):
        segments = (w.LoadSegment(5, 0, 100, 20, 40),)
        for rva, size, expected in ((100, 1, True), (119, 1, True), (100, 20, True), (99, 1, False), (120, 1, False), (119, 2, False), (100, 0, False), (True, 1, False), (w.MAX_U64, 2, False)):
            with self.subTest(rva=rva, size=size):
                self.assertEqual(w.in_executable_file_window(segments, rva, size), expected)

    def test_non_rx_is_not_an_executable_window(self):
        for flags in (0, 1, 4, 6, 7):
            with self.subTest(flags=flags):
                self.assertFalse(w.in_executable_file_window((w.LoadSegment(flags, 0, 100, 20, 20),), 100, 1))

    def test_address_uses_bias_not_file_offset(self):
        layout = w.validate_elf(*synthetic_elf())
        self.assertEqual(w.checked_entry_address(0x7F0000000000, layout), 0x7F0006856284)

    def test_bad_load_bias(self):
        layout = w.validate_elf(*synthetic_elf())
        for bias in (-1, True, w.MAX_U64, w.MAX_U64 - w.BUILD.sign_rva):
            with self.subTest(bias=bias), self.assertRaises(w.WorkerError) as caught:
                w.checked_entry_address(bias, layout)
            self.assertEqual(caught.exception.code, "link-map-failed")

    def test_hash_mismatch_is_before_elf_parsing(self):
        with mock.patch.object(w, "validate_elf", side_effect=AssertionError("early ELF parse")) as validator:
            with self.assertRaises(w.WorkerError) as caught:
                w.verify_image(io.BytesIO(b"not the reviewed binary"))
            self.assertEqual(caught.exception.code, "hash-mismatch")
            validator.assert_not_called()

    def test_hash_is_checked_over_all_bytes(self):
        payload = b"a" * (1024 * 1024 + 3)
        digest = mock.Mock()
        digest.hexdigest.return_value = "wrong"
        with mock.patch.object(w.hashlib, "sha256", return_value=digest):
            with self.assertRaises(w.WorkerError):
                w.verify_image(io.BytesIO(payload))
        self.assertEqual(b"".join(call.args[0] for call in digest.update.call_args_list), payload)

    def test_verified_stream_reaches_pure_layout_parser(self):
        # Synthetic bytes are admitted only through a mocked digest in this test.
        header, phdr, _size = synthetic_elf()
        stream = io.BytesIO(header + phdr)
        digest = mock.Mock()
        digest.hexdigest.return_value = w.BUILD.sha256
        with mock.patch.object(w.hashlib, "sha256", return_value=digest), mock.patch.object(w, "validate_elf", return_value="layout") as validator:
            self.assertEqual(w.verify_image(stream), "layout")
        validator.assert_called_once_with(header, phdr, len(header + phdr))

    def test_native_loader_hash_failure_never_reaches_loading(self):
        fake_stream = io.BytesIO(b"wrong hash")
        fake_stream.fileno = lambda: 33
        fake_stat = mock.Mock(st_mode=0o100400)
        with mock.patch.object(w, "_supported_platform", return_value=True), mock.patch("builtins.open", return_value=fake_stream), mock.patch.object(w.os, "fstat", return_value=fake_stat), mock.patch.object(w.NativeBackend, "_load_verified", side_effect=AssertionError("native path")) as load:
            with self.assertRaises(w.WorkerError) as caught:
                w.NativeBackend.load("synthetic", "synthetic", [])
        self.assertEqual(caught.exception.code, "hash-mismatch")
        load.assert_not_called()

    def test_platform_failure_precedes_open(self):
        with mock.patch.object(w, "_supported_platform", return_value=False), mock.patch("builtins.open", side_effect=AssertionError("open called")):
            with self.assertRaises(w.WorkerError) as caught:
                w.NativeBackend.load("synthetic", "synthetic", [])
        self.assertEqual(caught.exception.code, "unsupported-platform")

    def test_image_change_prevents_loading(self):
        fake_stream = io.BytesIO(b"fixture")
        fake_stream.fileno = lambda: 33
        first = mock.Mock(st_mode=0o100400, st_dev=1, st_ino=2, st_size=7, st_mtime_ns=1, st_ctime_ns=1)
        second = mock.Mock(st_dev=1, st_ino=2, st_size=7, st_mtime_ns=2, st_ctime_ns=1)
        with mock.patch.object(w, "_supported_platform", return_value=True), mock.patch("builtins.open", return_value=fake_stream), mock.patch.object(w.os, "fstat", side_effect=[first, second]), mock.patch.object(w, "verify_image", return_value=mock.Mock()), mock.patch.object(w.NativeBackend, "_load_verified") as load:
            with self.assertRaises(w.WorkerError) as caught:
                w.NativeBackend.load("synthetic", "synthetic", [])
        self.assertEqual(caught.exception.code, "image-changed")
        load.assert_not_called()


class FakeLoaderTests(unittest.TestCase):
    """Exercise the native-binding orchestration with a Python-only ctypes stand-in."""

    def load(self, *, opens=None, link_status=0, null_link=False, bias=0x7F0000000000):
        ffi = mock.Mock()
        ffi.Structure = type("Structure", (), {})
        api = mock.Mock()
        api.dlopen.side_effect = opens if opens is not None else [101, 102, 103, 104]
        api.dlinfo.return_value = link_status
        ffi.CDLL.return_value = api
        pointer = mock.MagicMock()
        pointer.contents.l_addr = bias
        pointer.__bool__.return_value = not null_link
        ffi.POINTER.return_value.return_value = pointer
        ffi.byref.side_effect = lambda value: value
        layout = w.validate_elf(*synthetic_elf())
        with mock.patch.dict(sys.modules, {"ctypes": ffi}), mock.patch.multiple(w.os, RTLD_NOW=2, RTLD_GLOBAL=256, RTLD_LAZY=1, RTLD_LOCAL=0, create=True):
            try:
                backend = w.NativeBackend._load_verified(73, layout, "/synthetic/helper.so", ["/synthetic/dep.so"])
            except w.WorkerError as error:
                return error, ffi, api
        return backend, ffi, api

    def test_preload_order_lazy_target_and_exact_handle(self):
        backend, ffi, api = self.load()
        self.assertIsInstance(backend, w.NativeBackend)
        self.assertEqual(api.dlopen.call_args_list, [
            mock.call(b"/synthetic/dep.so", 258),
            mock.call(b"libgnutls.so.30", 258),
            mock.call(b"/synthetic/helper.so", 258),
            mock.call(b"/proc/self/fd/73", 1),
        ])
        self.assertEqual(api.dlinfo.call_args.args[:2], (104, 2))
        ffi.CFUNCTYPE.assert_called_once_with(None, ffi.c_char_p, ffi.c_void_p, ffi.c_uint32, ffi.c_uint32, ffi.c_void_p)
        ffi.CFUNCTYPE.return_value.assert_called_once_with(0x7F0006856284)
        ffi.CDLL.assert_called_once_with("libdl.so.2")
        self.assertEqual(backend._handles, [101, 102, 103, 104])

    def test_preload_failure_never_opens_target(self):
        error, ffi, api = self.load(opens=[None])
        self.assertEqual(error.code, "preload-failed")
        self.assertEqual(api.dlopen.call_count, 1)
        api.dlinfo.assert_not_called()
        ffi.CFUNCTYPE.assert_not_called()

    def test_target_load_failure_never_binds(self):
        error, ffi, api = self.load(opens=[101, 102, 103, None])
        self.assertEqual(error.code, "dlopen-failed")
        api.dlinfo.assert_not_called()
        ffi.CFUNCTYPE.assert_not_called()

    def test_linkmap_error_or_null_never_binds(self):
        for kwargs in ({"link_status": -1}, {"null_link": True}, {"bias": w.MAX_U64}):
            with self.subTest(kwargs=kwargs):
                error, ffi, _api = self.load(**kwargs)
                self.assertEqual(error.code, "link-map-failed")
                ffi.CFUNCTYPE.assert_not_called()

    def test_native_marshalling_uses_buffers_and_one_byte_empty_storage(self):
        backend, ffi, _api = self.load()
        ffi.c_ubyte = mock.MagicMock()
        out = memoryview(bytearray(w.OUTPUT_SIZE))
        command_buffer, body_buffer = object(), object()
        ffi.create_string_buffer.side_effect = [command_buffer, body_buffer]
        backend.sign(b"cmd\0", b"", 0, w.MAX_U32, out)
        self.assertEqual(ffi.create_string_buffer.call_args_list, [mock.call(b"cmd\0", 4), mock.call(b"", 1)])
        ffi.c_ubyte.__mul__.assert_called_once_with(w.OUTPUT_SIZE)
        ffi.c_ubyte.__mul__.return_value.from_buffer.assert_called_once_with(out)
        backend._function.assert_called_once_with(command_buffer, body_buffer, 0, w.MAX_U32, ffi.c_ubyte.__mul__.return_value.from_buffer.return_value)

    def test_close_marks_backend_without_unloading(self):
        backend, _ffi, api = self.load()
        backend.close()
        self.assertTrue(backend._closed)
        api.dlclose.assert_not_called()
        with self.assertRaises(w.WorkerError):
            backend.sign(b"command\0", b"", 0, 0, memoryview(bytearray(768)))


class CoreLimitTests(unittest.TestCase):
    def test_disable_kernel_core_with_fake_resource(self):
        resource = mock.Mock(RLIMIT_CORE=4)
        resource.getrlimit.return_value = (0, 0)
        with mock.patch.dict(sys.modules, {"resource": resource}):
            w._disable_core_dumps()
        resource.setrlimit.assert_called_once_with(4, (0, 0))
        resource.getrlimit.assert_called_once_with(4)

    def test_core_limit_failure_is_redacted(self):
        resource = mock.Mock(RLIMIT_CORE=4)
        resource.setrlimit.side_effect = OSError("private system detail")
        with mock.patch.dict(sys.modules, {"resource": resource}), self.assertRaises(w.WorkerError) as caught:
            w._disable_core_dumps()
        self.assertEqual(str(caught.exception), "core-limit-failed")

    def test_core_limit_readback_is_required(self):
        resource = mock.Mock(RLIMIT_CORE=4)
        resource.getrlimit.return_value = (100, 100)
        with mock.patch.dict(sys.modules, {"resource": resource}), self.assertRaises(w.WorkerError) as caught:
            w._disable_core_dumps()
        self.assertEqual(caught.exception.code, "core-limit-failed")

    def test_protocol_loop_never_changes_core_limit(self):
        with mock.patch.object(w, "_disable_core_dumps", side_effect=AssertionError("resource change in fake loop")) as disable:
            self.assertEqual(session(record())[0], 0)
        disable.assert_not_called()

    def test_loader_disables_core_after_validation_before_loading_and_keeps_fd(self):
        events = []
        stream = io.BytesIO(b"synthetic")
        stream.fileno = lambda: 73
        info = mock.Mock(st_mode=0o100400, st_dev=1, st_ino=2, st_size=9, st_mtime_ns=1, st_ctime_ns=1)
        layout = w.validate_elf(*synthetic_elf())
        backend = FakeBackend()
        def verify(_stream):
            events.append("verify")
            return layout
        def load(fd, image_layout, host, preloads):
            events.append("load")
            self.assertEqual((fd, image_layout, host, preloads), (73, layout, "helper", []))
            return backend
        with mock.patch.object(w, "_supported_platform", return_value=True), mock.patch("builtins.open", return_value=stream), mock.patch.object(w.os, "fstat", return_value=info), mock.patch.object(w, "verify_image", side_effect=verify), mock.patch.object(w, "_disable_core_dumps", side_effect=lambda: events.append("limit")), mock.patch.object(w.NativeBackend, "_load_verified", side_effect=load):
            result = w.NativeBackend.load("fixture", "helper", [])
        self.assertEqual(events, ["verify", "limit", "load"])
        self.assertIs(result, backend)
        self.assertIs(result._image_stream, stream)
        self.assertFalse(stream.closed)
        stream.close()


class SessionTests(unittest.TestCase):
    def test_ready_and_eof(self):
        status, rows, stderr, backend = session(b"")
        self.assertEqual(status, 0)
        self.assertEqual(rows, [{"type": "ready", "protocol": 1, "build": w.BUILD.build, "sha256": w.BUILD.sha256}])
        self.assertEqual(stderr, "")
        self.assertEqual(backend.closed, 1)
        self.assertEqual(backend.calls, [])

    def test_sequential_requests(self):
        status, rows, stderr, backend = session(record() + record(id=2))
        self.assertEqual(status, 0)
        self.assertEqual([row["id"] for row in rows[1:]], [1, 2])
        self.assertEqual(len(backend.calls), 2)
        self.assertEqual(backend.closed, 1)
        self.assertEqual(stderr, "")

    def test_final_line_without_lf(self):
        status, rows, _stderr, backend = session(record().rstrip(b"\n"))
        self.assertEqual(status, 0)
        self.assertEqual(rows[-1]["id"], 1)
        self.assertEqual(len(backend.calls), 1)

    def test_validation_failure_continues_without_backend_call(self):
        status, rows, stderr, backend = session(record(body="secret") + record(id=2))
        self.assertEqual(status, 0)
        self.assertEqual(rows[1], {"id": 1, "error": {"code": "invalid-body"}})
        self.assertEqual(rows[2]["id"], 2)
        self.assertEqual(len(backend.calls), 1)
        self.assertEqual(stderr, "")

    def test_unknown_id_is_null(self):
        _status, rows, _stderr, _backend = session(b"private request\n" + record(id=True))
        self.assertEqual(rows[1], {"id": None, "error": {"code": "invalid-json"}})
        self.assertEqual(rows[2], {"id": None, "error": {"code": "invalid-id"}})

    def test_oversized_line_terminates_without_fragment_parsing(self):
        source = io.BytesIO(b"x" * (w.MAX_LINE_BYTES + 200) + b"\n" + record())
        stdout, stderr, backend = io.StringIO(), io.StringIO(), FakeBackend()
        status = w.run_worker(backend, source, stdout, stderr)
        rows = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(status, 1)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[-1], {"id": None, "error": {"code": "line-too-long"}})
        self.assertEqual(source.tell(), w.MAX_LINE_BYTES + 1)
        self.assertEqual(backend.calls, [])
        self.assertEqual(backend.closed, 1)

    def test_wire_limit_exactly_is_accepted(self):
        line = record().rstrip(b"\n")
        line += b" " * (w.MAX_LINE_BYTES - len(line) - 1) + b"\n"
        status, rows, _stderr, _backend = session(line)
        self.assertEqual(status, 0)
        self.assertIn("result", rows[-1])

    def test_backend_exception_is_redacted_and_fatal(self):
        def fail(_output):
            raise RuntimeError("/private/native.so secret body token")
        status, rows, stderr, backend = session(record() + record(id=2), FakeBackend(fail))
        self.assertEqual(status, 1)
        self.assertEqual(rows[-1], {"id": 1, "error": {"code": "native-call-failed"}})
        self.assertEqual(stderr, "local-qq-sign: native-call-failed\n")
        self.assertEqual(len(backend.calls), 1)
        self.assertEqual(backend.closed, 1)
        self.assertNotIn("secret", str(rows) + stderr)

    def test_canary_failure_is_fatal(self):
        def fail(output):
            output.obj[-1] ^= 1
        status, rows, _stderr, backend = session(record() + record(id=2), FakeBackend(fail))
        self.assertEqual(status, 1)
        self.assertEqual(rows[-1]["error"]["code"], "output-guard")
        self.assertEqual(len(backend.calls), 1)

    def test_empty_sign_is_error_not_success(self):
        def empty(output):
            output[:] = output_bytes(sign=b"")
        status, rows, _stderr, backend = session(record() + record(id=2), FakeBackend(empty))
        self.assertEqual(status, 0)
        self.assertEqual(rows[-1], {"id": 2, "error": {"code": "empty-sign"}})
        self.assertEqual(len(backend.calls), 2)

    def test_input_io_error_is_classified(self):
        source = mock.Mock()
        source.readline.side_effect = OSError("private path")
        out, err, backend = io.StringIO(), io.StringIO(), FakeBackend()
        self.assertEqual(w.run_worker(backend, source, out, err), 1)
        self.assertEqual(err.getvalue(), "local-qq-sign: io-failed\n")
        self.assertEqual(backend.closed, 1)

    def test_broken_output_still_closes(self):
        out, err, backend = mock.Mock(), io.StringIO(), FakeBackend()
        out.write.side_effect = BrokenPipeError("private detail")
        self.assertEqual(w.run_worker(backend, io.BytesIO(record()), out, err), 1)
        self.assertEqual(backend.closed, 1)
        self.assertEqual(err.getvalue(), "local-qq-sign: io-failed\n")

    def test_shutdown_during_read(self):
        source = mock.Mock()
        source.readline.side_effect = w.ShutdownRequested(signal.SIGTERM)
        out, err, backend = io.StringIO(), io.StringIO(), FakeBackend()
        self.assertEqual(w.run_worker(backend, source, out, err), 128 + signal.SIGTERM)
        self.assertEqual(backend.closed, 1)
        self.assertEqual(err.getvalue(), "local-qq-sign: stopped\n")

    def test_shutdown_during_backend_call(self):
        def stop(_output):
            raise w.ShutdownRequested(signal.SIGINT)
        status, rows, stderr, backend = session(record(), FakeBackend(stop))
        self.assertEqual(status, 128 + signal.SIGINT)
        self.assertEqual(len(rows), 1)
        self.assertEqual(backend.closed, 1)
        self.assertEqual(stderr, "local-qq-sign: stopped\n")

    def test_close_failure_is_not_silently_successful(self):
        backend = FakeBackend()
        backend.close = mock.Mock(side_effect=RuntimeError("secret close"))
        status, _rows, stderr, _backend = session(b"", backend)
        self.assertEqual(status, 1)
        self.assertEqual(stderr, "local-qq-sign: backend-close-failed\n")


class CliAndImportTests(unittest.TestCase):
    def args(self):
        return ["--wrapper", str(HERE / "fixture.node"), "--host-symbols", str(HERE / "fixture.so")]

    def test_explicit_cli_uses_injected_backend(self):
        backend, out, err = FakeBackend(), io.StringIO(), io.StringIO()
        factory = mock.Mock(return_value=backend)
        self.assertEqual(w.main(self.args(), io.BytesIO(record()), out, err, backend_factory=factory), 0)
        factory.assert_called_once_with(str(HERE / "fixture.node"), str(HERE / "fixture.so"), [])
        self.assertIn('"type":"ready"', out.getvalue())

    def test_repeated_preloads_keep_order(self):
        args = self.args() + ["--preload", str(HERE / "a.so"), "--preload", str(HERE / "b.so")]
        self.assertEqual(w.parse_arguments(args).preload, [str(HERE / "a.so"), str(HERE / "b.so")])

    def test_no_offset_or_hash_override(self):
        for args in (self.args() + ["--rva", "123"], self.args() + ["--sha256", "secret"], self.args() + ["--wrap", "secret"]):
            with self.subTest(args=args), self.assertRaises(w.WorkerError) as caught:
                w.parse_arguments(args)
            self.assertEqual(caught.exception.code, "invalid-arguments")

    def test_relative_or_nul_paths_fail(self):
        for path in ("relative", str(HERE / "abc") + "\0"):
            args = ["--wrapper", path, "--host-symbols", str(HERE / "fixture.so")]
            with self.subTest(path=path), self.assertRaises(w.WorkerError):
                w.parse_arguments(args)

    def test_invalid_arguments_are_redacted_before_factory(self):
        out, err, factory = io.StringIO(), io.StringIO(), mock.Mock()
        status = w.main(["--private-secret"], io.BytesIO(), out, err, backend_factory=factory)
        self.assertEqual(status, 2)
        self.assertEqual(json.loads(out.getvalue()), {"id": None, "error": {"code": "invalid-arguments"}})
        self.assertNotIn("secret", out.getvalue() + err.getvalue())
        factory.assert_not_called()

    def test_startup_error_no_ready_and_no_raw_detail(self):
        out, err = io.StringIO(), io.StringIO()
        factory = mock.Mock(side_effect=OSError("private path and credentials"))
        self.assertEqual(w.main(self.args(), io.BytesIO(), out, err, backend_factory=factory), 2)
        self.assertEqual(json.loads(out.getvalue()), {"id": None, "error": {"code": "startup-failed"}})
        self.assertEqual(err.getvalue(), "local-qq-sign: startup-failed\n")

    def test_classified_startup_error(self):
        out, err = io.StringIO(), io.StringIO()
        factory = mock.Mock(side_effect=w.WorkerError("hash-mismatch"))
        self.assertEqual(w.main(self.args(), io.BytesIO(), out, err, backend_factory=factory), 2)
        self.assertEqual(json.loads(out.getvalue())["error"]["code"], "hash-mismatch")
        self.assertNotIn("ready", out.getvalue())

    def test_help_does_not_construct_backend(self):
        out, err, factory = io.StringIO(), io.StringIO(), mock.Mock()
        self.assertEqual(w.main(["--help"], io.BytesIO(), out, err, backend_factory=factory), 0)
        self.assertEqual(out.getvalue(), "")
        self.assertEqual(err.getvalue(), w.HELP)
        factory.assert_not_called()

    def test_unknown_error_code_never_leaks(self):
        self.assertEqual(w.error_record("private native error"), {"id": None, "error": {"code": "internal-error"}})

    def test_fresh_import_performs_no_native_import_or_io(self):
        original_import = builtins.__import__
        def guarded_import(name, *args, **kwargs):
            if name in {"ctypes", "_ctypes"}:
                raise AssertionError("native import during module import")
            return original_import(name, *args, **kwargs)
        name = "local_sign_import_probe"
        spec = importlib.util.spec_from_file_location(name, HERE / "worker.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            with mock.patch("builtins.__import__", side_effect=guarded_import), mock.patch("builtins.open", side_effect=AssertionError("file open during import")), mock.patch.object(w.os, "open", side_effect=AssertionError("os.open during import")):
                spec.loader.exec_module(module)
            self.assertEqual(module.BUILD.sha256, w.BUILD.sha256)
        finally:
            sys.modules.pop(name, None)

    def test_entrypoint_isolates_raw_stdout_and_stderr_with_fake_backend(self):
        # A separate Python process prevents fd redirection from affecting unittest.
        # The only backend in that process is this local fake; it imports no ctypes.
        code = r'''
import os, sys
sys.path.insert(0, sys.argv[1])
import worker
class Fake:
    def sign(self, command, body, length, seq, out):
        os.write(1, b"SECRET-NATIVE-STDOUT\n")
        os.write(2, b"SECRET-NATIVE-STDERR\n")
        out[0x200] = 0xAB
        out[0x2ff] = 1
    def close(self):
        os.write(1, b"SECRET-CLOSE\n")
def factory(*args):
    print("SECRET-STARTUP", flush=True)
    os.write(2, b"SECRET-STARTUP-ERR\n")
    return Fake()
worker.NativeBackend.load = factory
root = sys.argv[1]
sys.argv = ["worker.py", "--wrapper", os.path.join(root, "fixture.node"), "--host-symbols", os.path.join(root, "fixture.so")]
raise SystemExit(worker._entrypoint())
'''
        result = subprocess.run([sys.executable, "-B", "-c", code, str(HERE)], input=record(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[-1], {"id": 1, "result": {"sign": "ab", "token": "", "extra": ""}})
        self.assertEqual(result.stderr, b"")
        self.assertNotIn(b"SECRET", result.stdout)


if __name__ == "__main__":
    unittest.main()
