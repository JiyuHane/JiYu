#!/usr/bin/env python3
"""Jiyu's opt-in, build-pinned local signing worker; importing performs no loading."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import signal
import stat
import struct
import sys
from dataclasses import dataclass
from typing import BinaryIO, Callable, Protocol, TextIO


@dataclass(frozen=True)
class BuildManifest:
    build: str = "3.2.35-54395"
    sha256: str = "dc5209e20002735e31a20c9cded0a807d1db4779277dec66c9221ea28a870328"
    sign_rva: int = 0x6856284
    rx_rva: int = 0x299E300
    rx_offset: int = 0x299D300
    rx_size: int = 0x6475100


# One reviewed build, with no configuration, environment or CLI offset override.
BUILD = BuildManifest()
PROTOCOL_VERSION = 1
MAX_SAFE_INTEGER = (1 << 53) - 1
MAX_U32 = (1 << 32) - 1
MAX_U64 = (1 << 64) - 1
MAX_BODY_BYTES = 1024 * 1024
MAX_COMMAND_BYTES = 256
# Wire framing has its own bound, including JSON syntax, whitespace and LF/CRLF.
MAX_LINE_BYTES = 2 * MAX_BODY_BYTES + 4096
OUTPUT_SIZE = 0x300
GUARD_BEFORE = bytes.fromhex("75bfa92301d8ce60418f56a204bad9ed") * 2
GUARD_AFTER = bytes.fromhex("9c0851ef74a0b263daf103e6428f5bc7") * 2
HEX_BODY = re.compile(r"[0-9a-fA-F]*", re.ASCII)
ERROR_CODES = frozenset(
    {
        "invalid-arguments", "unsupported-platform", "image-io", "image-changed",
        "hash-mismatch", "invalid-elf", "abi-mismatch", "core-limit-failed", "preload-failed",
        "dlopen-failed", "link-map-failed", "native-bind-failed", "startup-failed",
        "invalid-json", "duplicate-key", "invalid-request", "invalid-id",
        "invalid-command", "invalid-sequence", "invalid-body", "line-too-long",
        "native-call-failed", "output-guard", "invalid-output", "empty-sign",
        "backend-close-failed", "io-failed", "stopped", "internal-error",
    }
)
FATAL_REQUEST_CODES = frozenset({"native-call-failed", "output-guard", "invalid-output"})
HELP = (
    "Jiyu local signing worker (Python 3.9+, Linux x86-64/glibc)\n"
    "Usage: worker.py --wrapper /absolute/wrapper.node "
    "--host-symbols /absolute/libqq_host_symbols.so "
    "[--preload /absolute/dependency.so ...]\n"
    "stdin/stdout: JSONL protocol 1. See the adjacent README for the contract.\n"
)


class WorkerError(Exception):
    """Closed, input-free error vocabulary at the process boundary."""

    def __init__(self, code: str, request_id: int | None = None):
        self.code = code if code in ERROR_CODES else "internal-error"
        self.request_id = request_id if is_request_id(request_id) else None
        super().__init__(self.code)


class ShutdownRequested(BaseException):
    def __init__(self, signum: int):
        self.signum = signum


def is_request_id(value: object) -> bool:
    return type(value) is int and 1 <= value <= MAX_SAFE_INTEGER


@dataclass(frozen=True)
class Request:
    id: int
    command: str
    sequence: int
    body: bytes


class Backend(Protocol):
    def sign(
        self, command_cstring: bytes, body: bytes, body_length: int,
        sequence: int, output: memoryview,
    ) -> None: ...

    def close(self) -> None: ...


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise WorkerError("duplicate-key")
        result[key] = value
    return result


def _reject_constant(_value: str) -> None:
    raise WorkerError("invalid-json")


def _parse_integer(value: str) -> int:
    # Bound decimal conversion even on Python versions without an int digit cap.
    if len(value) > 17:
        raise WorkerError("invalid-json")
    return int(value)


def _check_json_depth(line: bytes) -> None:
    # Valid requests are flat. Bound parser work independently of Python's
    # version-dependent recursion limit, without counting brackets in strings.
    depth, in_string, escaped = 0, False, False
    for value in line:
        if in_string:
            if escaped:
                escaped = False
            elif value == 92:
                escaped = True
            elif value == 34:
                in_string = False
        elif value == 34:
            in_string = True
        elif value in (91, 123):
            depth += 1
            if depth > 16:
                raise WorkerError("invalid-json")
        elif value in (93, 125):
            depth -= 1


def parse_request(line: bytes) -> Request:
    """Parse exactly one bounded JSON record without calling any backend."""
    if len(line) > MAX_LINE_BYTES:
        raise WorkerError("line-too-long")
    _check_json_depth(line)
    try:
        data = json.loads(
            line.decode("utf-8"), object_pairs_hook=_unique_object,
            parse_constant=_reject_constant, parse_int=_parse_integer,
        )
    except WorkerError:
        raise
    except (ValueError, UnicodeError, RecursionError):
        raise WorkerError("invalid-json") from None
    if type(data) is not dict:
        raise WorkerError("invalid-request")
    request_id = data.get("id") if is_request_id(data.get("id")) else None
    if set(data) != {"id", "command", "sequence", "body"}:
        raise WorkerError("invalid-request", request_id)
    if request_id is None:
        raise WorkerError("invalid-id")
    command = data["command"]
    if (
        type(command) is not str or not 1 <= len(command) <= MAX_COMMAND_BYTES
        or not command.isascii() or "\0" in command
    ):
        raise WorkerError("invalid-command", request_id)
    sequence = data["sequence"]
    if type(sequence) is not int or not 0 <= sequence <= MAX_U32:
        raise WorkerError("invalid-sequence", request_id)
    body = data["body"]
    if (
        type(body) is not str or len(body) > 2 * MAX_BODY_BYTES or len(body) % 2
        or HEX_BODY.fullmatch(body) is None
    ):
        raise WorkerError("invalid-body", request_id)
    return Request(request_id, command, sequence, bytes.fromhex(body))


def extract_output(output: bytes | bytearray | memoryview) -> dict[str, str]:
    """Copy only the length-bounded bytes, never the unused bytes of a slot."""
    raw = bytes(output)
    if len(raw) != OUTPUT_SIZE:
        raise WorkerError("invalid-output")
    result = {
        name: raw[offset:offset + raw[offset + 0xFF]].hex()
        for name, offset in (("sign", 0x200), ("token", 0), ("extra", 0x100))
    }
    if not result["sign"]:
        raise WorkerError("empty-sign")
    return result


def sign_request(request: Request, backend: Backend) -> dict[str, str]:
    storage = bytearray(GUARD_BEFORE + bytes(OUTPUT_SIZE) + GUARD_AFTER)
    start = len(GUARD_BEFORE)
    window = memoryview(storage)[start:start + OUTPUT_SIZE]
    failed = False
    try:
        try:
            # A native return value is deliberately not interpreted.
            backend.sign(
                request.command.encode("ascii") + b"\0", request.body,
                len(request.body), request.sequence, window,
            )
        except Exception:
            failed = True
        if storage[:start] != GUARD_BEFORE or storage[start + OUTPUT_SIZE:] != GUARD_AFTER:
            raise WorkerError("output-guard", request.id)
        if failed:
            raise WorkerError("native-call-failed", request.id)
        return extract_output(window)
    finally:
        window.release()
        # This drops one mutable copy, not a secure-erasure guarantee.
        storage[:] = bytes(len(storage))


@dataclass(frozen=True)
class LoadSegment:
    flags: int
    offset: int
    rva: int
    file_size: int
    memory_size: int


@dataclass(frozen=True)
class ImageLayout:
    segments: tuple[LoadSegment, ...]


def _elf_header(header: bytes, file_size: int) -> tuple[int, int]:
    if len(header) != 64 or type(file_size) is not int or file_size < 64:
        raise WorkerError("invalid-elf")
    values = struct.unpack("<16sHHIQQQIHHHHHH", header)
    ident, elf_type, machine, version = values[:4]
    phoff, ehsize, phentsize, phnum = values[5], values[8], values[9], values[10]
    if (
        ident[:7] != b"\x7fELF\x02\x01\x01" or elf_type != 3 or machine != 62
        or version != 1 or ehsize != 64 or phentsize != 56
        or not 1 <= phnum <= 4096 or phoff < 64 or phoff + phnum * 56 > file_size
    ):
        raise WorkerError("invalid-elf")
    return phoff, phnum


def in_executable_file_window(segments: tuple[LoadSegment, ...], rva: int, size: int) -> bool:
    """Check a whole range in one file-backed, readable/executable, nonwritable LOAD."""
    if type(rva) is not int or type(size) is not int or rva < 0 or size < 1:
        return False
    if rva + size > MAX_U64:
        return False
    return any(
        segment.flags == 5 and segment.rva <= rva
        and rva + size <= segment.rva + segment.file_size
        for segment in segments
    )


def validate_elf(header: bytes, program_headers: bytes, file_size: int) -> ImageLayout:
    """Pure ELF64LE/x86-64 and manifest/RX-window validation."""
    _phoff, phnum = _elf_header(header, file_size)
    if len(program_headers) != phnum * 56:
        raise WorkerError("invalid-elf")
    segments = []
    for values in struct.iter_unpack("<IIQQQQQQ", program_headers):
        kind, flags, offset, rva, _physical, size, memory_size, alignment = values
        if kind != 1:
            continue
        if (
            size > memory_size or offset + size > file_size
            or rva + memory_size > MAX_U64
            or (alignment > 1 and (
                alignment & (alignment - 1) or offset % alignment != rva % alignment
            ))
        ):
            raise WorkerError("invalid-elf")
        segments.append(LoadSegment(flags, offset, rva, size, memory_size))
    layout = ImageLayout(tuple(segments))
    expected = LoadSegment(5, BUILD.rx_offset, BUILD.rx_rva, BUILD.rx_size, BUILD.rx_size)
    if layout.segments.count(expected) != 1:
        raise WorkerError("abi-mismatch")
    if not in_executable_file_window(layout.segments, BUILD.sign_rva, 1):
        raise WorkerError("abi-mismatch")
    return layout


def verify_image(stream: BinaryIO) -> ImageLayout:
    """Read-only validation, completed before the first dependency/target dlopen."""
    stream.seek(0)
    digest = hashlib.sha256()
    file_size = 0
    while True:
        chunk = stream.read(1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
        file_size += len(chunk)
    if digest.hexdigest() != BUILD.sha256:
        raise WorkerError("hash-mismatch")
    stream.seek(0)
    header = stream.read(64)
    phoff, phnum = _elf_header(header, file_size)
    stream.seek(phoff)
    return validate_elf(header, stream.read(phnum * 56), file_size)


def checked_entry_address(load_bias: int, layout: ImageLayout) -> int:
    if (
        type(load_bias) is not int or load_bias < 0 or load_bias > MAX_U64 - BUILD.sign_rva
        or not in_executable_file_window(layout.segments, BUILD.sign_rva, 1)
        or any(load_bias + s.rva + s.memory_size > MAX_U64 for s in layout.segments)
    ):
        raise WorkerError("link-map-failed")
    return load_bias + BUILD.sign_rva


def _stat_identity(info: os.stat_result) -> tuple[int, ...]:
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _supported_platform() -> bool:
    return sys.platform == "linux" and platform.machine() in {"x86_64", "AMD64"} and struct.calcsize("P") == 8


def _disable_core_dumps() -> None:
    # This changes limits only in the explicitly started native worker, never on
    # import or in the backend-independent protocol loop.
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        if resource.getrlimit(resource.RLIMIT_CORE) != (0, 0):
            raise WorkerError("core-limit-failed")
    except Exception:
        raise WorkerError("core-limit-failed") from None


class NativeBackend:
    """Explicit CLI construction only. All ctypes interaction is lazy."""

    @classmethod
    def load(cls, wrapper: str, host_symbols: str, preloads: list[str]) -> NativeBackend:
        if not _supported_platform():
            raise WorkerError("unsupported-platform")
        try:
            stream = open(wrapper, "rb")
            try:
                before = os.fstat(stream.fileno())
                if not stat.S_ISREG(before.st_mode):
                    raise WorkerError("image-io")
                layout = verify_image(stream)
                if _stat_identity(before) != _stat_identity(os.fstat(stream.fileno())):
                    raise WorkerError("image-changed")
                # Use the verified open inode, rather than reopening a pathname that
                # could have been replaced. The owner must still prevent in-place writes.
                _disable_core_dumps()
                backend = cls._load_verified(stream.fileno(), layout, host_symbols, preloads)
                # Keep /proc/self/fd/<fd> resolvable throughout the worker lifetime.
                backend._image_stream = stream
                return backend
            except BaseException:
                stream.close()
                raise
        except WorkerError:
            raise
        except OSError:
            raise WorkerError("image-io") from None

    @classmethod
    def _load_verified(
        cls, fd: int, layout: ImageLayout, host_symbols: str, preloads: list[str],
    ) -> NativeBackend:
        import ctypes

        try:
            api = ctypes.CDLL("libdl.so.2")
            api.dlopen.argtypes = [ctypes.c_char_p, ctypes.c_int]
            api.dlopen.restype = ctypes.c_void_p
            api.dlinfo.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
            api.dlinfo.restype = ctypes.c_int
        except Exception:
            raise WorkerError("native-bind-failed") from None
        handles = []
        for name in [*preloads, "libgnutls.so.30", host_symbols]:
            handle = api.dlopen(os.fsencode(name), os.RTLD_NOW | os.RTLD_GLOBAL)
            if not handle:
                raise WorkerError("preload-failed")
            handles.append(handle)
        # ctypes.CDLL adds RTLD_NOW on POSIX; raw dlopen preserves RTLD_LAZY.
        handle = api.dlopen(os.fsencode(f"/proc/self/fd/{fd}"), os.RTLD_LAZY | os.RTLD_LOCAL)
        if not handle:
            raise WorkerError("dlopen-failed")
        handles.append(handle)

        class LinkMap(ctypes.Structure):
            _fields_ = [
                ("l_addr", ctypes.c_size_t), ("l_name", ctypes.c_void_p),
                ("l_ld", ctypes.c_void_p), ("l_next", ctypes.c_void_p),
                ("l_prev", ctypes.c_void_p),
            ]

        link_map = ctypes.POINTER(LinkMap)()
        # glibc RTLD_DI_LINKMAP == 2. This exact handle is the identity, not l_name.
        if api.dlinfo(handle, 2, ctypes.byref(link_map)) != 0 or not link_map:
            raise WorkerError("link-map-failed")
        entry = checked_entry_address(link_map.contents.l_addr, layout)
        try:
            function = ctypes.CFUNCTYPE(
                None, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_uint32,
                ctypes.c_uint32, ctypes.c_void_p,
            )(entry)
        except Exception:
            raise WorkerError("native-bind-failed") from None
        backend = cls()
        backend._ctypes = ctypes
        backend._api = api
        backend._handles = handles
        backend._function = function
        backend._closed = False
        return backend

    def sign(
        self, command_cstring: bytes, body: bytes, body_length: int,
        sequence: int, output: memoryview,
    ) -> None:
        if self._closed:
            raise WorkerError("native-call-failed")
        ffi = self._ctypes
        command_buffer = ffi.create_string_buffer(command_cstring, len(command_cstring))
        body_buffer = ffi.create_string_buffer(body, max(1, body_length))
        output_buffer = (ffi.c_ubyte * OUTPUT_SIZE).from_buffer(output)
        self._function(command_buffer, body_buffer, body_length, sequence, output_buffer)

    def close(self) -> None:
        # Do not unload a library whose internal thread/destructor lifecycle is unknown.
        # The dedicated CLI process owns its lifetime and exits on EOF or a signal.
        self._closed = True


def error_record(code: str, request_id: int | None = None) -> dict[str, object]:
    error = WorkerError(code, request_id)
    return {"id": error.request_id, "error": {"code": error.code}}


def _emit(output: TextIO, value: dict[str, object]) -> None:
    output.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n")
    output.flush()


def _diagnose(stderr: TextIO, code: str) -> None:
    stderr.write("local-qq-sign: " + WorkerError(code).code + "\n")
    stderr.flush()


def run_worker(backend: Backend, stdin: BinaryIO, stdout: TextIO, stderr: TextIO) -> int:
    status = 0
    try:
        _emit(stdout, {
            "type": "ready", "protocol": PROTOCOL_VERSION,
            "build": BUILD.build, "sha256": BUILD.sha256,
        })
        while True:
            # One extra byte detects overflow, with no unbounded drain or fragment retry.
            line = stdin.readline(MAX_LINE_BYTES + 1)
            if not line:
                break
            if len(line) > MAX_LINE_BYTES:
                _emit(stdout, error_record("line-too-long"))
                _diagnose(stderr, "line-too-long")
                status = 1
                break
            request_id = None
            try:
                request = parse_request(line)
                request_id = request.id
                result = sign_request(request, backend)
                _emit(stdout, {"id": request.id, "result": result})
            except WorkerError as error:
                _emit(stdout, error_record(error.code, request_id or error.request_id))
                if error.code in FATAL_REQUEST_CODES:
                    _diagnose(stderr, error.code)
                    status = 1
                    break
            except Exception:
                _emit(stdout, error_record("internal-error", request_id))
                _diagnose(stderr, "internal-error")
                status = 1
                break
    except ShutdownRequested as stopped:
        _diagnose(stderr, "stopped")
        status = 128 + stopped.signum
    except (OSError, ValueError):
        _diagnose(stderr, "io-failed")
        status = 1
    finally:
        try:
            backend.close()
        except Exception:
            _diagnose(stderr, "backend-close-failed")
            status = 1
    return status


class _ArgumentParser(argparse.ArgumentParser):
    def error(self, _message: str) -> None:
        raise WorkerError("invalid-arguments")


def parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = _ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument("--wrapper", required=True)
    parser.add_argument("--host-symbols", required=True)
    parser.add_argument("--preload", action="append", default=[])
    args = parser.parse_args(argv)
    for path in [args.wrapper, args.host_symbols, *args.preload]:
        if not os.path.isabs(path) or "\0" in path:
            raise WorkerError("invalid-arguments")
    return args


def main(
    argv: list[str], stdin: BinaryIO, stdout: TextIO, stderr: TextIO,
    *, backend_factory: Callable[[str, str, list[str]], Backend] | None = None,
) -> int:
    if argv == ["--help"]:
        stderr.write(HELP)
        stderr.flush()
        return 0
    try:
        args = parse_arguments(argv)
        factory = NativeBackend.load if backend_factory is None else backend_factory
        backend = factory(args.wrapper, args.host_symbols, args.preload)
    except WorkerError as error:
        _emit(stdout, error_record(error.code))
        _diagnose(stderr, error.code)
        return 2
    except ShutdownRequested as stopped:
        _diagnose(stderr, "stopped")
        return 128 + stopped.signum
    except Exception:
        _emit(stdout, error_record("startup-failed"))
        _diagnose(stderr, "startup-failed")
        return 2
    return run_worker(backend, stdin, stdout, stderr)


def _signal_handler(signum: int, _frame: object) -> None:
    raise ShutdownRequested(signum)


def _entrypoint() -> int:
    # Keep fd 1/2 suppressed for the process lifetime, including native destructors.
    # Dedicated duplicated channels carry only our serialized protocol/fixed diagnostics.
    protocol = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n", buffering=1)
    diagnostics = os.fdopen(os.dup(2), "w", encoding="utf-8", newline="\n", buffering=1)
    try:
        with open(os.devnull, "wb") as sink:
            os.dup2(sink.fileno(), 1)
            os.dup2(sink.fileno(), 2)
        signal.signal(signal.SIGINT, _signal_handler)
        signal.signal(signal.SIGTERM, _signal_handler)
        return main(sys.argv[1:], sys.stdin.buffer, protocol, diagnostics)
    except ShutdownRequested as stopped:
        _diagnose(diagnostics, "stopped")
        return 128 + stopped.signum
    except Exception:
        try:
            _diagnose(diagnostics, "io-failed")
        except Exception:
            pass
        return 1
    finally:
        protocol.close()
        diagnostics.close()


if __name__ == "__main__":
    raise SystemExit(_entrypoint())
