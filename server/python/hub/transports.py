"""
Hardware transport abstraction.

Transport interface:
    start(on_byte, on_connect)  — start the transport and register callbacks
    write(data: bytes)          — send raw bytes to the device
    connected() -> bool         — whether the device is currently connected

Built-in implementations:
    NullTransport   — no hardware, web dashboard only (--transport none)
    SerialTransport — USB serial (--transport serial)
    BleTransport    — BLE Nordic UART Service (--transport ble)
"""
from __future__ import annotations

import asyncio
import glob
import sys
import threading
import time
from typing import Callable

# BLE Nordic UART Service UUIDs
_NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
_NUS_RX      = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"  # host → device
_NUS_TX      = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"  # device → host


def _log(*a):
    print(*a, file=sys.stderr, flush=True)


class Transport:
    """Abstract base transport — all methods must be overridden by subclasses."""

    def start(self, on_byte: Callable[[int], None], on_connect: Callable | None = None) -> None:
        raise NotImplementedError

    def write(self, data: bytes) -> None:
        raise NotImplementedError

    def connected(self) -> bool:
        return False


class NullTransport(Transport):
    """No hardware — web dashboard only."""

    def start(self, on_byte: Callable[[int], None], on_connect: Callable | None = None) -> None:
        if on_connect:
            on_connect()

    def write(self, data: bytes) -> None:
        pass  # intentional no-op: nothing to send when there is no device

    def connected(self) -> bool:
        return True


class SerialTransport(Transport):
    """USB serial transport at 115200 baud."""

    def __init__(self, port: str):
        try:
            import serial
            self._ser = serial.Serial(port, 115200, timeout=0.2)
        except Exception as exc:
            sys.exit(f"[error] cannot open serial port {port!r}: {exc}")
        self._lock = threading.Lock()
        time.sleep(0.2)
        _log(f"[serial] opened {port}")

    def start(self, on_byte: Callable[[int], None], on_connect: Callable | None = None) -> None:
        if on_connect:
            on_connect()
        threading.Thread(target=self._reader, args=(on_byte,), daemon=True, name="serial-rx").start()

    def _reader(self, on_byte: Callable[[int], None]) -> None:
        while True:
            try:
                for b in self._ser.read(256):
                    on_byte(b)
            except Exception as e:
                _log(f"[serial] read error: {e}")
                time.sleep(1)

    def write(self, data: bytes) -> None:
        with self._lock:
            try:
                self._ser.write(data)
            except Exception as e:
                _log(f"[serial] write error: {e}")

    def connected(self) -> bool:
        return True


class BleTransport(Transport):
    """BLE transport using Nordic UART Service (NUS)."""

    def __init__(self, name_prefix: str = "Claude-"):
        self._prefix     = name_prefix
        self._client     = None
        self._loop : asyncio.AbstractEventLoop | None = None
        self._on_byte    : Callable[[int], None] | None = None
        self._on_connect : Callable | None = None
        self._connected  = threading.Event()

    def start(self, on_byte: Callable[[int], None], on_connect: Callable | None = None) -> None:
        self._on_byte    = on_byte
        self._on_connect = on_connect
        threading.Thread(target=self._run, daemon=True, name="ble-main").start()

    def _run(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._main())

    async def _main(self) -> None:
        try:
            from bleak import BleakScanner, BleakClient
        except ImportError:
            _log("[ble] bleak not installed — run: uv add bleak")
            return

        def _on_notify(_, data: bytearray) -> None:
            for b in data:
                if self._on_byte:
                    self._on_byte(b)

        while True:
            _log(f"[ble] scanning for '{self._prefix}*'…")
            device = None
            try:
                device = await BleakScanner.find_device_by_filter(
                    lambda d, _: bool(d.name) and d.name.startswith(self._prefix),
                    timeout=10.0)
            except Exception as e:
                _log(f"[ble] scan error: {e}")

            if not device:
                _log("[ble] not found, retry in 5s")
                await asyncio.sleep(5)
                continue

            _log(f"[ble] connecting to {device.name}")
            try:
                async with BleakClient(device) as client:
                    self._client = client
                    await client.start_notify(_NUS_TX, _on_notify)
                    self._connected.set()
                    _log("[ble] connected")
                    if self._on_connect:
                        threading.Thread(
                            target=self._on_connect, daemon=True, name="ble-on-connect").start()
                    while client.is_connected:
                        await asyncio.sleep(1)
                    _log("[ble] link lost")
            except Exception as e:
                _log(f"[ble] error: {e!r}")
            finally:
                self._client = None
                self._connected.clear()
            await asyncio.sleep(2)

    def write(self, data: bytes) -> None:
        client = self._client
        loop   = self._loop
        if not client or not client.is_connected or not loop:
            return
        # Fire-and-forget: response=False means no ACK needed; do not block the caller.
        try:
            asyncio.run_coroutine_threadsafe(
                client.write_gatt_char(_NUS_RX, data, response=False), loop)
        except Exception as e:
            _log(f"[ble] write error: {e!r}")

    def connected(self) -> bool:
        return self._connected.is_set()


def make_transport(mode: str, explicit_port: str | None = None) -> Transport:
    """Instantiate the transport selected by --transport / --serial-port."""
    if explicit_port:
        return SerialTransport(explicit_port)
    if mode == "none":
        return NullTransport()
    if mode == "ble":
        return BleTransport()
    candidates = sorted(glob.glob("/dev/cu.usbserial-*") + glob.glob("/dev/ttyUSB*"))
    if mode == "serial":
        if not candidates:
            sys.exit("[error] --transport serial: no serial device found")
        return SerialTransport(candidates[0])
    # auto: try serial first, fall back to BLE
    if candidates:
        _log("[transport] USB serial found")
        return SerialTransport(candidates[0])
    _log("[transport] no serial device, falling back to BLE")
    return BleTransport()
