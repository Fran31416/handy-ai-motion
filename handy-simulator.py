#!/usr/bin/env python3
"""
TheHandy Simulator for Intiface Central
========================================

This script creates a virtual linear actuator device that connects to Intiface Central
via the Websocket Device Manager (WSDM). It simulates TheHandy device and displays
all received movement commands with real-time position visualization.

The WSDM protocol uses Protocol Buffers (protobuf) encoding for messages.

Requirements:
- Python 3.7+
- websockets library: pip install websockets

Setup in Intiface Central:
1. Go to Settings -> Advanced
2. Enable "Use Device Websocket Server"
3. Note the port (default is 54817)
4. Start the server
5. Run this script
"""

import asyncio
import json
import struct
import sys
import os
import time
from datetime import datetime
from dataclasses import dataclass
from typing import Optional, List, Tuple

try:
    import websockets
except ImportError:
    print("Error: websockets library not found.")
    print("Install it with: pip install websockets")
    sys.exit(1)

# Configuration
WSDM_HOST = "localhost"
WSDM_PORT = 54817
DEVICE_NAME = "SimulatedHandy"
UPDATE_INTERVAL_MS = 20

# Display configuration
BAR_WIDTH = 40


def get_time_ms() -> float:
    """Get current time in milliseconds using monotonic clock."""
    return time.monotonic() * 1000.0


def decode_varint(data: bytes, offset: int = 0) -> Tuple[int, int]:
    """Decode a protobuf varint. Returns (value, bytes_consumed)."""
    result = 0
    shift = 0
    consumed = 0
    
    while offset + consumed < len(data):
        byte = data[offset + consumed]
        result |= (byte & 0x7F) << shift
        consumed += 1
        
        if not (byte & 0x80):
            break
        
        shift += 7
        if shift > 63:
            raise ValueError("Varint too long")
    
    return result, consumed


def parse_linear_cmd_from_protobuf(data: bytes) -> Optional[dict]:
    """
    Parse a LinearCmd from protobuf-encoded WSDM message.
    
    The message structure is:
    - Position: encoded as double (0.0-1.0), usually at the end
    - Duration: encoded as varint after field tag 0x10 (field 2, wire type 0)
    """
    position = None
    duration = None
    
    # Method 1: Extract position (double, 0.0-1.0)
    # Position is usually the last valid double in the message
    for i in range(len(data) - 7, -1, -1):
        try:
            val = struct.unpack('<d', data[i:i+8])[0]
            if 0.0 <= val <= 1.0:
                position = val
                break
        except:
            pass
    
    # Method 2: Find duration after field tag 0x10
    # In WSDM protobuf, duration is in field 2 (tag = 0x10 = field 2, wire type 0)
    # Pattern: 10 <varint_duration>
    for i in range(len(data) - 2):
        if data[i] == 0x10:
            # Check if next byte looks like start of varint
            try:
                dur, consumed = decode_varint(data, i + 1)
                # Duration should be reasonable (10ms to 10 seconds)
                if 10 <= dur <= 10000:
                    duration = dur
                    break
            except:
                pass
    
    if position is not None:
        return {
            "vectors": [{
                "position": position,
                "duration_ms": duration if duration else 500
            }]
        }
    
    return None


@dataclass
class Movement:
    """Represents an ongoing movement."""
    start_position: float
    target_position: float
    duration_ms: int
    start_time_ms: float
    is_active: bool = True


class VisualDisplay:
    """Handles the visual representation of the simulator state."""
    
    def __init__(self, bar_width: int = BAR_WIDTH):
        self.bar_width = bar_width
        self.last_display = ""
        self.initialized = False
        
    def _clear_screen(self):
        """Clear screen and reset cursor."""
        # Use a simple approach: clear and go to home position
        sys.stdout.write("\033[2J\033[H")
        sys.stdout.flush()
        self.initialized = True
    
    def _move_to_top(self):
        """Move cursor to top of screen."""
        sys.stdout.write("\033[H")
        sys.stdout.flush()
    
    def _clear_from_cursor(self):
        """Clear from cursor to end of screen."""
        sys.stdout.write("\033[J")
        sys.stdout.flush()
    
    def draw_position_bar(self, position: float, target: float, 
                          moving: bool, speed_mms: float = 0) -> str:
        """Draw an ASCII position bar with current and target indicators."""
        pos_idx = int(position * self.bar_width)
        tgt_idx = int(target * self.bar_width)
        
        pos_idx = max(0, min(self.bar_width, pos_idx))
        tgt_idx = max(0, min(self.bar_width, tgt_idx))
        
        bar = list("─" * self.bar_width)
        
        if 0 <= tgt_idx < self.bar_width:
            bar[tgt_idx] = "◦"
        
        if 0 <= pos_idx < self.bar_width:
            bar[pos_idx] = "█"
        
        bar_str = "".join(bar)
        
        pos_pct = position * 100
        tgt_pct = target * 100
        
        if moving:
            status = f"▶ MOVING"
            if speed_mms > 0:
                status += f" @ {speed_mms:.0f} mm/s"
        else:
            status = "■ IDLE"
        
        return f"[{bar_str}] {pos_pct:5.1f}% → {tgt_pct:5.1f}% {status}"
    
    def draw_progress_bar(self, progress: float, remaining_ms: float) -> str:
        """Draw a progress bar for the current movement."""
        progress_clamped = min(1.0, max(0.0, progress))
        filled = int(progress_clamped * 20)
        bar = "█" * filled + "░" * (20 - filled)
        return f"Progress: [{bar}] {progress_clamped*100:.0f}% | {remaining_ms:.0f}ms remaining"
    
    def update_display(self, position: float, target: float, moving: bool,
                       movement: Optional[Movement], speed_mms: float = 0,
                       command_info: str = ""):
        """Update the full display."""
        lines = []
        lines.append("┌" + "─" * (self.bar_width + 30) + "┐")
        lines.append(f"│ {'TheHandy Simulator':^58} │")
        lines.append("├" + "─" * (self.bar_width + 30) + "┤")
        lines.append(f"│ {self.draw_position_bar(position, target, moving, speed_mms):^58} │")
        
        if movement and movement.is_active:
            now_ms = get_time_ms()
            elapsed_ms = now_ms - movement.start_time_ms
            remaining_ms = max(0, movement.duration_ms - elapsed_ms)
            progress = elapsed_ms / movement.duration_ms if movement.duration_ms > 0 else 1.0
            
            lines.append(f"│ {self.draw_progress_bar(progress, remaining_ms):^58} │")
        
        lines.append("└" + "─" * (self.bar_width + 30) + "┘")
        
        if command_info:
            lines.append(f"  Last: {command_info}")
        
        output = "\n".join(lines)
        
        # Only redraw if content changed
        if output != self.last_display:
            self._move_to_top()
            self._clear_from_cursor()
            print(output, flush=True)
            self.last_display = output


class HandySimulator:
    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port
        self.websocket = None
        self.running = False
        
        # Position state
        self.current_position = 0.5
        self.target_position = 0.5
        self.current_movement: Optional[Movement] = None
        self.speed_mms = 0.0
        
        # Visual display
        self.display = VisualDisplay()
        self.last_command_info = ""
        
        # Tasks
        self._movement_task: Optional[asyncio.Task] = None
        self._display_task: Optional[asyncio.Task] = None
        self._message_task: Optional[asyncio.Task] = None
        
    def log(self, message: str, level: str = "INFO"):
        timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        # Print below the display
        print(f"\n[{timestamp}] [{level}] {message}", flush=True)
    
    async def send_handshake(self):
        """Send device announcement to the WSDM."""
        handshake = {
            "identifier": DEVICE_NAME,
            "address": "simulator-001",
            "version": 0,
            "name": DEVICE_NAME,
        }
        
        await self.websocket.send(json.dumps(handshake))
        self.log(f"Sent handshake: {handshake}")
    
    async def handle_message(self, data: bytes):
        """Handle incoming protobuf message from Intiface."""
        parsed = parse_linear_cmd_from_protobuf(data)
        
        if parsed and parsed.get("vectors"):
            for v in parsed["vectors"]:
                pos = v["position"]
                dur = v["duration_ms"]
                self.log(f"📦 LinearCmd: Position={pos*100:.1f}%, Duration={dur}ms")
                self.last_command_info = f"Position={pos*100:.1f}%, Duration={dur}ms"
                self.start_movement(position=pos, duration_ms=dur)
        else:
            hex_preview = data[:min(40, len(data))].hex()
            self.log(f"📥 Unknown ({len(data)}b): {hex_preview}", "DEBUG")
    
    def start_movement(self, position: float, duration_ms: int):
        """Start a new movement."""
        position = max(0.0, min(1.0, position))
        duration_ms = max(10, duration_ms)
        
        distance = abs(position - self.current_position)
        if distance > 0.001:
            stroke_mm = 125
            distance_mm = distance * stroke_mm
            self.speed_mms = distance_mm / (duration_ms / 1000.0)
        else:
            self.speed_mms = 0
        
        self.current_movement = Movement(
            start_position=self.current_position,
            target_position=position,
            duration_ms=duration_ms,
            start_time_ms=get_time_ms(),
            is_active=True
        )
        
        self.target_position = position
        
        self.log(f"Movement: {self.current_movement.start_position*100:.1f}% → {position*100:.1f}% in {duration_ms}ms")
    
    def update_position(self):
        """Update current position based on active movement."""
        if self.current_movement and self.current_movement.is_active:
            movement = self.current_movement
            now_ms = get_time_ms()
            elapsed_ms = now_ms - movement.start_time_ms
            
            if elapsed_ms >= movement.duration_ms:
                self.current_position = movement.target_position
                self.speed_mms = 0
                self.current_movement.is_active = False
                self.current_movement = None
            else:
                progress = elapsed_ms / movement.duration_ms
                self.current_position = (
                    movement.start_position + 
                    (movement.target_position - movement.start_position) * progress
                )
    
    async def movement_loop(self):
        """Main loop for position updates."""
        while self.running:
            try:
                self.update_position()
                await asyncio.sleep(UPDATE_INTERVAL_MS / 1000.0)
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.log(f"Error in movement loop: {e}", "ERROR")
    
    async def display_loop(self):
        """Main loop for display updates."""
        while self.running:
            try:
                moving = self.current_movement is not None and self.current_movement.is_active
                
                self.display.update_display(
                    position=self.current_position,
                    target=self.target_position,
                    moving=moving,
                    movement=self.current_movement,
                    speed_mms=self.speed_mms,
                    command_info=self.last_command_info
                )
                await asyncio.sleep(UPDATE_INTERVAL_MS / 1000.0)
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.log(f"Error in display loop: {e}", "ERROR")
    
    async def message_loop(self):
        """Main loop for receiving messages."""
        while self.running:
            try:
                message = await asyncio.wait_for(self.websocket.recv(), timeout=0.1)
                
                if isinstance(message, bytes):
                    await self.handle_message(message)
                elif isinstance(message, str):
                    self.log(f"Text: {message[:100]}...", "DEBUG")
            except asyncio.TimeoutError:
                continue
            except websockets.exceptions.ConnectionClosed:
                self.log("Connection closed by server", "WARN")
                self.running = False
                break
            except Exception as e:
                self.log(f"Error receiving: {e}", "ERROR")
    
    async def run(self):
        """Main loop to connect and receive messages."""
        uri = f"ws://{self.host}:{self.port}"
        
        print("\n" + "=" * 62)
        print("  TheHandy Simulator for Intiface Central")
        print("  Websocket Device Manager (WSDM) Client")
        print("=" * 62)
        print(f"\n  Connecting to: {uri}")
        print("  Make sure Intiface Central is running with")
        print("  'Use Device Websocket Server' enabled\n")
        
        try:
            async with websockets.connect(uri) as ws:
                self.websocket = ws
                self.running = True
                
                await self.send_handshake()
                
                print(f"✅ Connected as '{DEVICE_NAME}'")
                print("Listening for commands... (Press Ctrl+C to stop)\n")
                
                # Initialize display
                self.display._clear_screen()
                
                self._movement_task = asyncio.create_task(self.movement_loop())
                self._display_task = asyncio.create_task(self.display_loop())
                self._message_task = asyncio.create_task(self.message_loop())
                
                done, pending = await asyncio.wait(
                    [self._movement_task, self._display_task, self._message_task],
                    return_when=asyncio.FIRST_COMPLETED
                )
                
                for task in pending:
                    task.cancel()
                    
        except ConnectionRefusedError:
            self.log(f"Could not connect to {uri}", "ERROR")
            self.log("Make sure Intiface Central is running and WSDM is enabled", "ERROR")
        except Exception as e:
            self.log(f"Error: {e}", "ERROR")
        finally:
            self.running = False
            print("\nDisconnected")


async def main():
    simulator = HandySimulator(WSDM_HOST, WSDM_PORT)
    
    try:
        await simulator.run()
    except KeyboardInterrupt:
        print("\nStopping...")


if __name__ == "__main__":
    try:
        if sys.platform == "win32":
            os.system("")
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
