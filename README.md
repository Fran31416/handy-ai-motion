# Handy AI Motion

A SillyTavern extension that connects to Intiface Central to control TheHandy linear actuator device using AI-analyzed message content.

## Features

- **Automatic Motion Generation**: Analyzes AI-generated messages and extracts movement patterns
- **Intiface Central Integration**: Connects via WebSocket to control TheHandy or any compatible linear actuator
- **Smart Speed Handling**: Automatically clamps movements to device speed limits (32-450 mm/s)
- **Slow Movement Expansion**: Expands slow movements into step-and-hold segments to preserve timing
- **Configurable LLM Prompts**: Customize the analysis prompt for your specific use case
- **Auto-Retry on Failure**: Automatically retries LLM analysis if invalid JSON is returned

## Requirements

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) (latest version)
- [Intiface Central](https://intiface.com/#intiface-central) (for device communication)
- TheHandy or any Buttplug-compatible linear actuator device
- An LLM backend configured in SillyTavern

## Installation

### Method 1: Manual Installation

1. Navigate to your SillyTavern `public/scripts/extensions/third-party/` directory
2. Create a folder named `handy-ai-motion`
3. Download and place the following files in that folder:
   - `index.js`
   - `settings.html`
   - `style.css`
   - `manifest.json`
4. Restart SillyTavern or refresh the page
5. Find "Handy AI Motion" in the extensions panel

### Method 2: Git Clone

```bash
cd SillyTavern/public/scripts/extensions/third-party/
git clone https://github.com/Fran31416/handy-ai-motion.git
```

## Setup

### Intiface Central Configuration

1. Download and install [Intiface Central](https://intiface.com/central/)
2. Open Intiface Central
3. Click "Start Server" (default port: 12345)
4. Connect your TheHandy device (via Bluetooth or USB)

### Extension Configuration

1. Open SillyTavern and navigate to the extensions panel
2. Find "Handy AI Motion" and expand it
3. Enable the extension with the checkbox
4. Click "Connect" to connect to Intiface Central
5. Verify "TheHandy Ready" appears under Device Status

## Settings Reference

### Connection Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Intiface WebSocket Address | `ws://localhost:12345` | WebSocket address for Intiface Central |
| Auto-Connect on Startup | Enabled | Automatically connect when SillyTavern loads |

### Device Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Min Speed | 32 mm/s | Minimum movement speed (as low as 1 for overclocked devices) |
| Max Speed | 450 mm/s | Maximum movement speed (up to 800 for overclocked devices) |
| Stroke Length | 125 mm | Device stroke length (TheHandy 2: 125mm, TheHandy 1: 110mm) |

### Slow Movement Handling

| Setting | Default | Description |
|---------|---------|-------------|
| Expand Slow Movements | Enabled | Break slow movements into step-and-hold segments |
| Step Size | 1% | Position change per step when expanding |

When a movement is too slow for the device (below minimum speed), it gets expanded into small steps that move at minimum speed, with holds in between to preserve the total timing. This creates a subtle "pulsing" or "teasing" motion instead of failing or distorting the timing.

### LLM Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-retry on Invalid Response | Enabled | Retry LLM analysis if invalid JSON is returned |
| Max Retry Attempts | 3 | Number of retry attempts before giving up |

## JSON Pattern Format

The extension expects movement patterns in this format:

```json
{
  "start": ["delayMs,posPercent", "delayMs,posPercent", ...],
  "loop": ["delayMs,posPercent", "delayMs,posPercent", ...]
}
```

- **start**: Movements that play ONCE at the beginning (for buildup, teasing)
- **loop**: Movements that REPEAT until new instructions arrive (for sustained rhythm)
- **delayMs**: Duration of the movement in milliseconds
- **posPercent**: Target position (0 = bottom, 100 = top)

### Example Patterns

**Slow Teasing:**
```json
{
  "start": ["3000,50"],
  "loop": ["2000,40", "2000,60"]
}
```

**Building Rhythm:**
```json
{
  "start": ["1000,100", "500,0"],
  "loop": ["400,100", "400,0"]
}
```

**Intense:**
```json
{
  "start": [],
  "loop": ["200,100", "200,0"]
}
```

## Testing

### Custom JSON Test

Enter a custom JSON pattern in the "Custom JSON Test" textarea and click "Run Custom Test" to execute it immediately.

### LLM Analysis Test

Enter a test message in the "Test Message" field and click "Test LLM Analysis" to test the LLM analysis without generating a new AI response.

## Simulator

A Python simulator is included for testing without a physical device:

```bash
# Install dependencies
pip install websockets

# Run the simulator
python handy-simulator.py
```

### Simulator Setup in Intiface Central

1. Go to Settings → Advanced
2. Enable "Use Device Websocket Server"
3. Note the port (default: 54817)
4. Start the server
5. Run the simulator script

The simulator displays real-time position visualization and logs all received commands.

## Troubleshooting

### "No Device" Status

1. Ensure your device is connected and powered on
2. Make sure Intiface Central has detected the device
3. Try clicking "Connect" again
4. Check Intiface Central logs for connection issues

### LLM Returns Invalid JSON

1. Try adjusting the analysis prompt for clearer instructions
2. Enable "Auto-retry on Invalid Response"
3. Check your LLM backend settings
4. Enable Debug Mode to see the full LLM response in console

### Movements Too Fast/Slow

1. Check your Speed Range settings match your device
2. Verify Stroke Length is correct for your device model
3. Enable "Expand Slow Movements" for better slow motion handling

## Technical Details

### Buttplug Protocol

The extension uses the [Buttplug Protocol](https://buttplug.io/) to communicate with Intiface Central. It supports:

- `LinearCmd`: For linear actuator movement
- `StopDeviceCmd`: For emergency stop
- Auto-discovery of linear actuator devices

### Speed Calculation

Speed is calculated as: `speed = distance / time`

Where:
- `distance = |newPosition - currentPosition| × strokeLength / 100`
- `time = duration / 1000` (converted to seconds)

If the requested speed exceeds limits, the duration is adjusted accordingly.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - See [LICENSE](LICENSE) for details.

## Acknowledgments

- [Buttplug.io](https://buttplug.io/) - Intimate hardware abstraction layer
- [SillyTavern](https://github.com/SillyTavern/SillyTavern) - The AI chat platform
- [TheHandy](https://www.thehandy.com/) - The linear actuator device
- GLM-5 Agent Beta my beloved
