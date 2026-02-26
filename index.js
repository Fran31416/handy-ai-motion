import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "handy-ai-motion";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const LOG_PREFIX = "[Handy AI Motion]";

const defaultSettings = {
    intifaceAddress: "ws://localhost:12345",
    enabled: true,
    autoConnect: true,
    minSpeed: 32,        // mm/s - TheHandy minimum
    maxSpeed: 450,       // mm/s - TheHandy maximum (use 800 for overclocked)
    strokeLength: 125,   // mm - TheHandy 2 stroke length
    expandSlowMovements: true, // Break slow movements into step-and-hold segments
    stepSize: 1,         // Position % per step when expanding slow movements
    testMessage: "She slowly moved closer, her breath warm against his skin. Her fingers traced gentle patterns down his chest as she pressed her body against his, a soft moan escaping her lips.",
    retryOnInvalid: true,
    maxRetries: 3,
    usePatternsFile: false, // Use predefined patterns from patterns.json
    analysisPrompt: `AI MESSAGE:
"""
{{message}}
"""


You are a motion analysis AI. Your task is to analyze the following AI-generated message and extract movement instructions for a linear actuator device (TheHandy), focusing solely on the male character's penile sensations.

Step 1 — Scene Classification

Classify the scene into ONE stimulation state:

- NONE: No sexual stimulation occurring.
- IMPLIED: Sexual tension or anticipation, but no active stimulation.
- ACTIVE: Explicit physical sexual stimulation occurring.
- INTENSE: Explicit stimulation with high intensity or climax-level energy.

Then determine:

- Intensity progression (static / building / peaking / fluctuating)
- Rhythm style (teasing hold / slow stroke / steady stroke / grinding / pulsing / mixed)
- Stroke range width (small 10–20% / medium 30–50% / large 70–100%)
- Dominant depth zone (shallow 10–30% / mid 40–60% / deep 70–90% / full range)
- Complexity level (low / moderate / high)

Complexity guidance:
- low: 2–4 movements in loop
- moderate: 4–8 movements in loop
- high: 8–20 movements allowed if justified by scene

Step 2 — Motion Generation Rules

CRITICAL BEHAVIOR RULES:

If state = NONE:
- Output empty arrays OR a single hold position.
- No rhythmic loop.

If state = IMPLIED:
- Use slow holds or subtle pulsing only.
- Avoid full-range strokes.
- Loop must be minimal and gentle.

If state = ACTIVE:
- Generate rhythmic motion reflecting described stimulation.

If state = INTENSE:
- Increase tempo and/or depth variation appropriately.

Technical Rules:
- delayMs = duration of movement toward the target position.
- If position does not change, this represents a hold.
- Movements must be physically plausible.
- Maintain internal rhythm coherence.
- Avoid unnecessary mechanical repetition unless the scene implies it.
- If nothing happens, it is acceptable and needed to output:
  { "start": [], "loop": [] }

Output format:

Brief explanation (1–2 sentences)

Motion Profile:
- Stimulation state: ...
- Intensity progression: ...
- Rhythm style: ...
- Stroke range width: ...
- Dominant depth zone: ...
- Complexity level: ...

Then JSON in a code block EXACTLY as:

{
  "start": [
    "delayMs,posPercent"
  ],
  "loop": [
    "delayMs,posPercent"
  ]
}

You can add comments to the lines if needed

Numeric Constraints:
- delayMs must be a positive integer (> 0).
- posPercent must be an integer from 0 to 100 inclusive.
- Never output negative numbers.
- Never output decimals.


ANALYSIS START (optional 1-2 sentences and detailed mandatory JSON with start and loop):
`,
    patternsPrompt: `AI MESSAGE:
"""
{{message}}
"""

AVAILABLE PATTERNS:
{{pattern_data}}

You are a motion pattern selector AI. Your task is to analyze the AI-generated message and select the most appropriate pattern from the available patterns above, then customize it with speed and range modifiers.

Step 1 — Scene Classification

Classify the scene into ONE stimulation state:
- NONE: No sexual stimulation occurring.
- IMPLIED: Sexual tension or anticipation, but no active stimulation.
- ACTIVE: Explicit physical sexual stimulation occurring.
- INTENSE: Explicit stimulation with high intensity or climax-level energy.

Step 2 — Pattern Selection Rules

If state = NONE:
- Select any gentle pattern with speed_percent: 20 or lower.
- Range modifiers should keep movements minimal.

If state = IMPLIED:
- Select patterns like "sine", "pulse", or "slow_tease".
- Use speed_percent between 20-50.

If state = ACTIVE:
- Select patterns that match the described rhythm.
- Use speed_percent between 50-80.

If state = INTENSE:
- Select patterns like "fast_stroke", "depth_thrust", or "wave_build".
- Use speed_percent between 80-100.

Range Modifiers:
- range_min: New minimum position (0-100, default from pattern)
- range_max: New maximum position (0-100, default from pattern)
- Use these to shift or compress the pattern's range.

Output format:

Brief explanation (1–2 sentences)

Then JSON in a code block EXACTLY as:

{
  "pattern": "pattern_name",
  "speed_percent": 50,
  "range_min": 0,
  "range_max": 100
}

Where:
- pattern: The exact name of the selected pattern from the available patterns
- speed_percent: Speed modifier from 0-100 (0 = very slow, 100 = maximum speed)
- range_min: Minimum position boundary (optional, uses pattern default if omitted)
- range_max: Maximum position boundary (optional, uses pattern default if omitted)


ANALYSIS START:
`,
    debugMode: false,
};

// Default duration when LLM returns 0 or missing delay (in ms)
const DEFAULT_MOVEMENT_DURATION = 250;

// State objects - initialized before any function calls
const IntifaceState = {
    SERVER_ADDRESS: "ws://localhost:12345",
    socket: null,
    messageId: 1,
    reconnectTimer: null,
    reconnectAttempts: 0,
    maxReconnectAttempts: 10,
    defaultDeviceIndex: null,
    deviceCapabilities: {
        canLinear: false,
        canStopDevice: false,
    },
};

const PlaybackState = {
    isPlaying: false,
    startQueue: [],
    loopQueue: [],
    currentTimeout: null,
    currentPhase: null,
    loopIndex: 0,
    abortController: null,
    currentPosition: 0,  // Track position across movements (0-100%)
};

// Cache for loaded patterns
let cachedPatterns = null;

/* ================================================================================================
   CONFIG ACCESSOR
================================================================================================ */
/**
 * Retrieves the configuration settings for the extension.
 * Merges default settings with user-defined settings.
 * @returns {Object} The configuration object.
 */
function getConfig() {
    const s = extension_settings?.[extensionName];
    return s ? { ...defaultSettings, ...s } : { ...defaultSettings };
}

/* ================================================================================================
   PATTERNS FILE HANDLING
================================================================================================ */
/**
 * Loads patterns from the patterns.json file.
 * @returns {Promise<Array>} Array of pattern objects.
 */
async function loadPatterns() {
    if (cachedPatterns) {
        return cachedPatterns;
    }
    
    try {
        const response = await fetch(`${extensionFolderPath}/patterns.json`);
        if (!response.ok) {
            console.warn(`${LOG_PREFIX} Could not load patterns.json: ${response.status}`);
            return [];
        }
        
        const data = await response.json();
        cachedPatterns = data.patterns || [];
        
        if (cachedPatterns.length > 0) {
            console.log(`${LOG_PREFIX} Loaded ${cachedPatterns.length} patterns from patterns.json`);
        }
        
        return cachedPatterns;
    } catch (err) {
        console.warn(`${LOG_PREFIX} Error loading patterns.json:`, err);
        return [];
    }
}

/**
 * Generates pattern data string for LLM prompt.
 * @param {Array} patterns - Array of pattern objects.
 * @returns {string} Formatted pattern data for LLM.
 */
function generatePatternDataForLLM(patterns) {
    if (!patterns || patterns.length === 0) {
        return "No patterns available.";
    }
    
    const patternLines = patterns.map(p => {
        return `- "${p.name}": ${p.description}`;
    });
    
    return patternLines.join('\n');
}

/**
 * Finds a pattern by name.
 * @param {string} name - The pattern name to find.
 * @param {Array} patterns - Array of pattern objects.
 * @returns {Object|null} The found pattern or null.
 */
function findPatternByName(name, patterns) {
    return patterns.find(p => p.name === name) || null;
}

/**
 * Applies speed and range modifiers to a pattern.
 * @param {Object} pattern - The pattern object with start and loop arrays.
 * @param {number} speedPercent - Speed modifier (0-100, where 100 = original speed).
 * @param {number} rangeMin - Minimum position boundary (optional).
 * @param {number} rangeMax - Maximum position boundary (optional).
 * @returns {Object} Modified pattern with adjusted timing and positions.
 */
function applyPatternModifiers(pattern, speedPercent, rangeMin = null, rangeMax = null) {
    const speedMultiplier = Math.max(0.1, speedPercent / 100);
    
    // Determine original range from pattern
    const allPositions = [...(pattern.pattern.start || []), ...(pattern.pattern.loop || [])]
        .map(s => {
            const parts = s.split(',');
            return parseInt(parts[1]) || 0;
        });
    
    const originalMin = Math.min(...allPositions);
    const originalMax = Math.max(...allPositions);
    const originalRange = originalMax - originalMin;
    
    // Use provided range or keep original
    const newMin = rangeMin !== null ? rangeMin : originalMin;
    const newMax = rangeMax !== null ? rangeMax : originalMax;
    const newRange = newMax - newMin;
    
    /**
     * Modifies a movement string with speed and range adjustments.
     * @param {string} movementStr - The movement string "delayMs,posPercent".
     * @returns {string} Modified movement string.
     */
    const modifyMovement = (movementStr) => {
        const parts = movementStr.split(',');
        if (parts.length !== 2) return movementStr;
        
        const delay = parseInt(parts[0]);
        let pos = parseFloat(parts[1]);
        
        if (isNaN(delay) || isNaN(pos)) return movementStr;
        
        // Apply speed modifier (inverse: lower speed = longer delay)
        const newDelay = Math.round(delay / speedMultiplier);
        
        // Apply range modifier
        if (originalRange > 0) {
            // Normalize position to 0-1 within original range
            const normalizedPos = (pos - originalMin) / originalRange;
            // Map to new range
            pos = Math.round(newMin + (normalizedPos * newRange));
        }
        
        // Clamp position to valid range
        pos = Math.max(0, Math.min(100, pos));
        
        return `${newDelay},${pos}`;
    };
    
    return {
        start: (pattern.pattern.start || []).map(modifyMovement),
        loop: (pattern.pattern.loop || []).map(modifyMovement)
    };
}

/**
 * Parses LLM response for pattern selection.
 * @param {string} response - The LLM response text.
 * @param {boolean} debugMode - Whether to log debug info.
 * @returns {Object|null} Parsed pattern selection or null.
 */
function parsePatternSelection(response, debugMode = false) {
    if (!response || typeof response !== 'string') {
        return null;
    }
    
    // Try to extract JSON from the response
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/i);
    let jsonStr = null;
    
    if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
    } else {
        // Try to find a JSON object directly
        const directJsonMatch = response.match(/\{[\s\S]*?"pattern"[\s\S]*?\}/i);
        if (directJsonMatch) {
            jsonStr = directJsonMatch[0];
        }
    }
    
    if (!jsonStr) {
        if (debugMode) {
            console.log(`${LOG_PREFIX} No JSON found in pattern selection response`);
        }
        return null;
    }
    
    try {
        const parsed = JSON.parse(jsonStr);
        
        if (!parsed.pattern || typeof parsed.pattern !== 'string') {
            return null;
        }
        
        return {
            pattern: parsed.pattern,
            speed_percent: parsed.speed_percent !== undefined ? parsed.speed_percent : 50,
            range_min: parsed.range_min !== undefined ? parsed.range_min : null,
            range_max: parsed.range_max !== undefined ? parsed.range_max : null
        };
    } catch (err) {
        if (debugMode) {
            console.log(`${LOG_PREFIX} Failed to parse pattern selection JSON:`, err);
        }
        return null;
    }
}

/* ================================================================================================
   STATUS UI HELPERS
================================================================================================ */
/**
 * Updates the Intiface connection status in the UI.
 * @param {boolean} isConnected - Whether the Intiface server is connected.
 */
function updateIntifaceStatus(isConnected) {
    const el = document.getElementById("ham_intiface_status");
    if (!el) return;

    if (isConnected) {
        el.textContent = "Connected";
        el.classList.remove("error");
        el.classList.add("ready");
    } else {
        el.textContent = "Not Connected";
        el.classList.remove("ready");
        el.classList.add("error");
    }
}

/**
 * Updates the device connection status in the UI.
 * @param {boolean} hasDevice - Whether a compatible device is connected.
 */
function updateDeviceStatus(hasDevice) {
    const el = document.getElementById("ham_device_status");
    if (!el) return;

    if (hasDevice) {
        el.textContent = "TheHandy Ready";
        el.classList.remove("error");
        el.classList.add("ready");
    } else {
        el.textContent = "No Device";
        el.classList.remove("ready");
        el.classList.add("error");
    }
}

/**
 * Updates the playback status in the UI.
 * @param {boolean} isPlaying - Whether playback is currently active.
 */
function updatePlaybackStatus(isPlaying) {
    const el = document.getElementById("ham_playback_status");
    if (!el) return;

    if (isPlaying) {
        el.textContent = "Playing";
        el.classList.remove("idle");
        el.classList.add("playing");
    } else {
        el.textContent = "Idle";
        el.classList.remove("playing");
        el.classList.add("idle");
    }
}

/* ================================================================================================
   DEVICE COMMANDS
================================================================================================ */
const DeviceCommands = {
    /**
     * Clamps a position value to the range 0-100%.
     * @param {number} pos - The position value to clamp.
     * @returns {number} The clamped position value.
     */
    clampPosition(pos) {
        return Math.max(0, Math.min(1, pos / 100));
    },

    /**
     * Sends a linear movement command to the connected device.
     * @param {number} position - Target position (0-100%).
     * @param {number} durationMs - Duration of the movement in milliseconds.
     * @returns {boolean} Whether the command was successfully sent.
     */
    linear(position, durationMs) {
        if (IntifaceState.defaultDeviceIndex === null) {
            console.warn(`${LOG_PREFIX} No device connected`);
            return false;
        }

        if (!IntifaceState.deviceCapabilities.canLinear) {
            console.warn(`${LOG_PREFIX} Device does not support linear commands`);
            return false;
        }

        const pos = this.clampPosition(position);
        const duration = Math.max(0, durationMs);

        const settings = getConfig();
        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Linear: pos=${pos.toFixed(2)} (${position}%), duration=${duration}ms`);
        }

        return intifaceSend({
            LinearCmd: {
                Id: IntifaceState.messageId++,
                DeviceIndex: IntifaceState.defaultDeviceIndex,
                Vectors: [{
                    Index: 0,
                    Position: pos,
                    Duration: duration,
                }],
            }
        });
    },

    /**
     * Stops all device movements.
     */
    stopAll() {
        if (IntifaceState.defaultDeviceIndex === null) return;

        this.linear(0, 200);

        if (IntifaceState.deviceCapabilities.canStopDevice) {
            intifaceSend({
                StopDeviceCmd: {
                    Id: IntifaceState.messageId++,
                    DeviceIndex: IntifaceState.defaultDeviceIndex,
                }
            });
        }

        console.log(`${LOG_PREFIX} Device stopped`);
    }
};

/* ================================================================================================
   INTIFACE CONNECTION FUNCTIONS
================================================================================================ */
/**
 * Sends a message to the Intiface server via WebSocket.
 * @param {Object} msgObj - The message object to send.
 * @returns {boolean} Whether the message was successfully sent.
 */
function intifaceSend(msgObj) {
    if (!IntifaceState.socket || IntifaceState.socket.readyState !== WebSocket.OPEN) {
        console.warn(`${LOG_PREFIX} Cannot send - not connected`);
        return false;
    }
    
    try {
        IntifaceState.socket.send(JSON.stringify([msgObj]));
        return true;
    } catch (err) {
        console.error(`${LOG_PREFIX} Send failed:`, err);
        return false;
    }
}

/**
 * Handles incoming messages from the Intiface server and updates device state accordingly.
 * @param {Object} msg - The message object received from the Intiface server.
 */
function handleIntifaceMessage(msg) {
    const settings = getConfig();
    
    if (settings.debugMode) {
        console.log(`${LOG_PREFIX} Received:`, msg);
    }

    if (msg.ServerInfo) {
        console.log(`${LOG_PREFIX} Server info received:`, msg.ServerInfo);
        intifaceSend({ StartScanning: { Id: IntifaceState.messageId++ } });
        intifaceSend({ RequestDeviceList: { Id: IntifaceState.messageId++ } });
        return;
    }

    if (msg.DeviceList || msg.DeviceAdded) {
        const devices = msg.DeviceList?.Devices || (msg.DeviceAdded ? [msg.DeviceAdded] : []);
        
        for (const d of devices) {
            const rawMsgs = d.DeviceMessages || [];
            let msgNames = [];
            
            if (Array.isArray(rawMsgs)) {
                msgNames = rawMsgs.flatMap(m => {
                    if (typeof m === "string") return [m];
                    if (m && typeof m === "object") return Object.keys(m);
                    return [];
                });
            } else if (rawMsgs && typeof rawMsgs === "object") {
                msgNames = Object.keys(rawMsgs);
            }

            const canLinear = msgNames.some(n => /Linear/i.test(n));
            
            if (canLinear) {
                IntifaceState.defaultDeviceIndex = d.DeviceIndex;
                IntifaceState.deviceCapabilities = {
                    canLinear: true,
                    canStopDevice: msgNames.some(n => /StopDevice/i.test(n)),
                };
                
                console.log(`${LOG_PREFIX} Device found: ${d.DeviceName || 'Unknown'} (Index: ${d.DeviceIndex})`);
                console.log(`${LOG_PREFIX} Capabilities:`, IntifaceState.deviceCapabilities);
                updateDeviceStatus(true);
                
                intifaceSend({ StopScanning: { Id: IntifaceState.messageId++ } });
                return;
            }
        }

        if (msg.DeviceList) {
            console.log(`${LOG_PREFIX} No linear actuator device found in device list`);
            updateDeviceStatus(false);
        }
        return;
    }

    if (msg.DeviceRemoved) {
        if (msg.DeviceRemoved.DeviceIndex === IntifaceState.defaultDeviceIndex) {
            IntifaceState.defaultDeviceIndex = null;
            IntifaceState.deviceCapabilities = { canLinear: false, canStopDevice: false };
            updateDeviceStatus(false);
            stopPlayback();
            console.log(`${LOG_PREFIX} Device removed`);
        }
        return;
    }

    if (msg.ScanningFinished) {
        console.log(`${LOG_PREFIX} Scanning finished`);
        return;
    }

    if (msg.Error) {
        console.error(`${LOG_PREFIX} Intiface Error:`, msg.Error);
    }
}

/**
 * Establishes a WebSocket connection to the Intiface server and sets up event handlers.
 */
function connectIntiface() {
    if (IntifaceState.socket &&
        (IntifaceState.socket.readyState === WebSocket.OPEN ||
            IntifaceState.socket.readyState === WebSocket.CONNECTING)) {
        console.log(`${LOG_PREFIX} Already connected or connecting`);
        return;
    }

    console.log(`${LOG_PREFIX} Connecting to Intiface at ${IntifaceState.SERVER_ADDRESS}...`);
    
    try {
        IntifaceState.socket = new WebSocket(IntifaceState.SERVER_ADDRESS);
    } catch (err) {
        console.error(`${LOG_PREFIX} WebSocket creation failed:`, err);
        updateIntifaceStatus(false);
        return;
    }

    IntifaceState.socket.onopen = () => {
        console.log(`${LOG_PREFIX} WebSocket connected`);
        updateIntifaceStatus(true);
        IntifaceState.reconnectAttempts = 0;
        
        intifaceSend({
            RequestServerInfo: {
                Id: IntifaceState.messageId++,
                ClientName: "SillyTavern Handy AI Motion",
                MessageVersion: 3,
            }
        });
    };

    IntifaceState.socket.onclose = () => {
        updateIntifaceStatus(false);
        updateDeviceStatus(false);
        IntifaceState.defaultDeviceIndex = null;
        console.log(`${LOG_PREFIX} WebSocket closed`);

        const settings = getConfig();
        if (settings.autoConnect && IntifaceState.reconnectAttempts < IntifaceState.maxReconnectAttempts) {
            if (IntifaceState.reconnectTimer) return;
            
            IntifaceState.reconnectAttempts++;
            console.log(`${LOG_PREFIX} Reconnecting in 2s (attempt ${IntifaceState.reconnectAttempts}/${IntifaceState.maxReconnectAttempts})`);
            
            IntifaceState.reconnectTimer = setTimeout(() => {
                IntifaceState.reconnectTimer = null;
                connectIntiface();
            }, 2000);
        }
    };

    IntifaceState.socket.onerror = (err) => {
        updateIntifaceStatus(false);
        console.error(`${LOG_PREFIX} WebSocket error:`, err);
    };

    IntifaceState.socket.onmessage = (evt) => {
        let messages;
        try {
            messages = JSON.parse(evt.data);
        } catch {
            console.warn(`${LOG_PREFIX} Failed to parse message:`, evt.data);
            return;
        }
        
        if (!Array.isArray(messages)) {
            messages = [messages];
        }
        
        messages.forEach((m) => handleIntifaceMessage(m));
    };
}

/**
 * Disconnects from the Intiface server, clears reconnect attempts, and resets device state.
 */
function disconnectIntiface() {
    if (IntifaceState.reconnectTimer) {
        clearTimeout(IntifaceState.reconnectTimer);
        IntifaceState.reconnectTimer = null;
    }
    IntifaceState.reconnectAttempts = IntifaceState.maxReconnectAttempts;
    
    if (IntifaceState.socket) {
        IntifaceState.socket.close();
        IntifaceState.socket = null;
    }
    
    stopPlayback();
    updateIntifaceStatus(false);
    updateDeviceStatus(false);
    IntifaceState.defaultDeviceIndex = null;
    console.log(`${LOG_PREFIX} Disconnected`);
}

/* ================================================================================================
   PLAYBACK ENGINE
================================================================================================ */
/**
 * Executes the next movement in the playback queue.
 * Handles both the start and loop phases of the playback.
 * If no movements are left, stops the playback.
 */
function executeNextMovement() {
    if (!PlaybackState.isPlaying || PlaybackState.abortController?.aborted) {
        return;
    }

    let movement = null;

    if (PlaybackState.currentPhase === 'start' && PlaybackState.startQueue.length > 0) {
        movement = PlaybackState.startQueue.shift();
    } else if (PlaybackState.loopQueue.length > 0) {
        PlaybackState.currentPhase = 'loop';
        movement = PlaybackState.loopQueue[PlaybackState.loopIndex];
        PlaybackState.loopIndex = (PlaybackState.loopIndex + 1) % PlaybackState.loopQueue.length;
    }

    if (!movement) {
        stopPlayback();
        return;
    }

    const { delay, pos } = movement;
    const settings = getConfig();
    
    // Get the requested duration, use default if delay is 0 or missing
    let duration = delay > 0 ? delay : DEFAULT_MOVEMENT_DURATION;
    
    // Calculate speed and clamp if necessary
    const currentPos = PlaybackState.currentPosition;
    const positionDelta = Math.abs(pos - currentPos);
    
    // Only apply speed clamping if there's actual movement
    if (positionDelta > 0) {
        const strokeLength = settings.strokeLength || 125;
        const minSpeed = settings.minSpeed || 32;
        const maxSpeed = settings.maxSpeed || 450;
        
        // Calculate distance in mm
        const distanceMm = (positionDelta / 100) * strokeLength;
        
        // Calculate requested speed in mm/s
        const requestedSpeed = distanceMm / (duration / 1000);
        
        // Clamp speed to min/max range
        let actualSpeed = requestedSpeed;
        if (requestedSpeed > maxSpeed) {
            actualSpeed = maxSpeed;
        } else if (requestedSpeed < minSpeed) {
            actualSpeed = minSpeed;
        }
        
        // Recalculate duration based on clamped speed
        if (actualSpeed !== requestedSpeed) {
            duration = Math.round((distanceMm / actualSpeed) * 1000);
        }
    }
    
    // Update current position
    PlaybackState.currentPosition = pos;

    // Execute the linear command
    DeviceCommands.linear(pos, duration);

    // Wait for the movement to complete before executing the next movement
    PlaybackState.currentTimeout = setTimeout(() => {
        if (PlaybackState.abortController?.aborted) return;
        executeNextMovement();
    }, duration);
}

/**
 * Parses a movement string in the format "delay,pos" into an object.
 * @param {string} str - The movement string to parse.
 * @returns {{delay: number, pos: number} | null} The parsed movement object or null if invalid.
 */
function parseMovementString(str) {
    const parts = str.split(",");
    if (parts.length !== 2) return null;
    
    const delay = parseInt(parts[0]);
    const pos = parseFloat(parts[1]);
    
    if (isNaN(delay) || isNaN(pos)) return null;
    
    return { delay, pos };
}

/**
 * Parses movement data containing 'start' and 'loop' arrays of movement strings.
 * @param {Object} data - The movement data object.
 * @returns {{start: Array, loop: Array}} Parsed movement arrays.
 */
function parseMovementData(data) {
    const start = [];
    const loop = [];

    if (data.start && Array.isArray(data.start)) {
        for (const s of data.start) {
            const parsed = parseMovementString(s);
            if (parsed) start.push(parsed);
        }
    }

    if (data.loop && Array.isArray(data.loop)) {
        for (const s of data.loop) {
            const parsed = parseMovementString(s);
            if (parsed) loop.push(parsed);
        }
    }

    return { start, loop };
}

/**
 * Starts the playback of the movement data.
 * Parses and optionally expands the movement data, then begins execution.
 * @param {Object} data - The movement data containing start and loop arrays.
 */
function startPlayback(data) {
    const settings = getConfig();
    
    stopPlayback();

    let { start, loop } = parseMovementData(data);

    if (start.length === 0 && loop.length === 0) {
        console.warn(`${LOG_PREFIX} No valid movement data`);
        return;
    }

    // Expand slow movements if enabled
    if (settings.expandSlowMovements) {
        // For start expansion, use the starting position of the loop phase
        // This ensures the first loop movement is expanded correctly
        const firstLoopPos = loop.length > 0 ? loop[0].pos : PlaybackState.currentPosition;
        start = expandMovements(start, settings, "start", firstLoopPos);
        
        // For loop expansion, use the last position of the loop phase
        // This ensures the last loop movement connects properly with the first loop movement, creating a seamless cycle
        const lastLoopPos = loop.length > 0 ? loop[loop.length - 1].pos : PlaybackState.currentPosition;
        loop = expandMovements(loop, settings, "loop", lastLoopPos);
    }

    if (settings.debugMode) {
        console.log(`${LOG_PREFIX} Parsed movements - Start:`, start, "Loop:", loop);
    }

    PlaybackState.startQueue = [...start];
    PlaybackState.loopQueue = [...loop];
    PlaybackState.isPlaying = true;
    PlaybackState.currentPhase = 'start';
    PlaybackState.loopIndex = 0;
    PlaybackState.abortController = { aborted: false };

    updatePlaybackStatus(true);

    executeNextMovement();
}

/**
 * Stops the current playback and resets the playback state.
 * Clears any active timeouts and aborts the playback controller.
 */
function stopPlayback() {
    if (PlaybackState.currentTimeout) {
        clearTimeout(PlaybackState.currentTimeout);
        PlaybackState.currentTimeout = null;
    }

    if (PlaybackState.abortController) {
        PlaybackState.abortController.aborted = true;
        PlaybackState.abortController = null;
    }

    PlaybackState.isPlaying = false;
    PlaybackState.startQueue = [];
    PlaybackState.loopQueue = [];
    PlaybackState.currentPhase = null;
    PlaybackState.loopIndex = 0;

    updatePlaybackStatus(false);
    
    console.log(`${LOG_PREFIX} Playback stopped`);
}

/* ================================================================================================
   SLOW MOVEMENT EXPANSION
   Breaks slow movements into step-and-hold segments to preserve timing while staying
   within device speed limits. Creates a subtle "pulsing" or "teasing" motion.
================================================================================================ */
/**
 * Expands all slow movements in start and loop arrays.
 * Ensures proper transitions between the end of the start phase and the beginning of the loop phase,
 * and ensures the loop phase forms a complete cycle.
 * 
 * @param {Array} movements - Array of { delay, pos } objects
 * @param {object} settings - Settings object
 * @param {string} phaseName - "start" or "loop" for debug logging
 * @param {number} endPos - Optional final position (0-100), used between start and loop, and for loop cycle completion
 * @returns {Array} Expanded movements array
 */
function expandMovements(movements, settings, phaseName = "movements", endPos = null) {
    if (!settings.expandSlowMovements) {
        return movements;
    }
    
    if (!Array.isArray(movements) || movements.some(m => typeof m.pos !== 'number' || typeof m.delay !== 'number')) {
        console.warn(`${LOG_PREFIX} Invalid movements data`);
        return [];
    }

    const expanded = [];
    let currentPosition = 0;
    // If the phaseName is start or the start is empty, PlaybackState.currentPosition, or fall back to 0. If the phaseName is loop, use the first position of the loop
    if (phaseName === "start") {
        currentPosition = (typeof PlaybackState.currentPosition === 'number') ? PlaybackState.currentPosition : 0;
    } else if (phaseName === "loop") {
        currentPosition = movements.length > 0 ? movements[0].pos : (typeof PlaybackState.currentPosition === 'number' ? PlaybackState.currentPosition : 0);
    } else {
        return movements;
    }

    // Only for start phase, ensure we transition smoothly to the first loop position if endPos is provided
    if (phaseName === "start") {
        for (let i = 0; i < movements.length; i++) {
            const movement = movements[i];
            const fromPos = currentPosition;
            const toPos = movement.pos;
            const duration = movement.delay > 0 ? movement.delay : DEFAULT_MOVEMENT_DURATION;
        
            // Expand this movement if needed
            const expandedSteps = expandSlowMovement(fromPos, toPos, duration, settings);
            expanded.push(...expandedSteps);
        
            // Track position for next movement
            currentPosition = toPos;
        }
        // Handle transition between start and loop
        if (endPos !== null && expanded.length > 0) {
            const lastPos = expanded[expanded.length - 1].pos;
            const duration = movements[movements.length - 1]?.delay; // Use the duration of the last movement for the transition

            if (duration && lastPos !== endPos) {
                // Add a transition movement from the last position to the end position
                const transitionSteps = expandSlowMovement(lastPos, endPos, duration, settings);
                expanded.push(...transitionSteps);
            }
        }
    } else if (phaseName === "loop") {
        for (let i = 0; i < movements.length; i++) {
            const movement = movements[i];
            const fromPos = movement.pos;
            const toPos = (i < movements.length - 1) ? movements[i + 1].pos : movements[0].pos;
            const duration = movement.delay > 0 ? movement.delay : DEFAULT_MOVEMENT_DURATION;
        
            // Expand this movement if needed
            const expandedSteps = expandSlowMovement(fromPos, toPos, duration, settings);
            expanded.push(...expandedSteps);
        
            // Track position for next movement
            currentPosition = toPos;
        }
    }
    
    if (settings.debugMode && expanded.length !== movements.length) {
        console.log(`${LOG_PREFIX} Expanded ${phaseName}: ${movements.length} -> ${expanded.length} movements`);
    }
    
    return expanded;
}

/**
 * Expands a slow movement into multiple step-and-hold segments.
 * Each step moves a small amount at minimum speed, then holds to maintain total timing.
 * 
 * @param {number} fromPos - Starting position (0-100%)
 * @param {number} toPos - Target position (0-100%)
 * @param {number} duration - Total duration in ms
 * @param {object} settings - Settings object with minSpeed, strokeLength, stepSize
 * @returns {Array} Array of movement objects { delay, pos }
 */
function expandSlowMovement(fromPos, toPos, duration, settings) {
    const strokeLength = settings.strokeLength || 125;
    const minSpeed = settings.minSpeed || 32;
    const stepSize = settings.stepSize || 1;
    
    const positionDelta = Math.abs(toPos - fromPos);
    
    // No movement needed
    if (positionDelta < 0.01) {
        return [{ delay: duration, pos: toPos }];
    }
    
    // Calculate if expansion is needed
    const distanceMm = (positionDelta / 100) * strokeLength;
    const requestedSpeed = distanceMm / (duration / 1000);
    
    // If speed is within limits, return original movement
    if (requestedSpeed >= minSpeed) {
        return [{ delay: duration, pos: toPos }];
    }
    
    // Need to expand into step-and-hold segments
    const direction = toPos > fromPos ? 1 : -1;
    const steps = [];
    
    // Calculate number of steps (use configured step size, but ensure at least 1 step)
    const actualStepSize = Math.min(stepSize, positionDelta);
    const numSteps = Math.max(1, Math.ceil(positionDelta / actualStepSize));
    const actualStepDelta = positionDelta / numSteps; // Distribute evenly
    
    // Calculate timing per step
    const distancePerStepMm = (actualStepDelta / 100) * strokeLength;
    const moveTimePerStep = Math.max(1, Math.round((distancePerStepMm / minSpeed) * 1000));
    const totalTimePerStep = duration / numSteps;
    const holdTimePerStep = Math.max(0, Math.round(totalTimePerStep - moveTimePerStep));
    
    if (settings.debugMode) {
        console.log(`${LOG_PREFIX} Expanding slow movement: ${fromPos}% -> ${toPos}% over ${duration}ms`);
        console.log(`${LOG_PREFIX} Requested speed: ${requestedSpeed.toFixed(1)}mm/s (min: ${minSpeed}mm/s)`);
        console.log(`${LOG_PREFIX} Expanding to ${numSteps} steps: ${moveTimePerStep}ms move + ${holdTimePerStep}ms hold each`);
    }
    
    let currentPos = fromPos;
    for (let i = 1; i <= numSteps; i++) {
        const nextPos = i === numSteps ? toPos : currentPos + (direction * actualStepDelta);
        
        steps.push({ 
            delay: moveTimePerStep, 
            pos: Math.round(nextPos * 100) / 100 // Round to 2 decimal places
        });
        
        if (holdTimePerStep > 0 && i < numSteps) {
            steps.push({ 
                delay: holdTimePerStep, 
                pos: Math.round(nextPos * 100) / 100 
            });
        }
        
        currentPos = nextPos;
    }
    
    return steps;
}

/* ================================================================================================
   JSON EXTRACTION HELPER
================================================================================================ */
/**
 * Extracts JSON object from LLM response, handling various formats:
 * - Markdown code blocks: ```json { ... } ```
 * - Plain JSON objects
 * - JSON embedded in text before/after explanations
 * - JSON with comments (single-line // and multi-line slash-asterisk style)
 */
function extractJsonFromResponse(response, debugMode = false) {
    if (!response || typeof response !== 'string') {
        return null;
    }
    
    // Handle empty or whitespace-only responses
    const trimmedResponse = response.trim();
    if (!trimmedResponse || trimmedResponse === '```') {
        if (debugMode) {
            console.log(`${LOG_PREFIX} Empty or incomplete response`);
        }
        return null;
    }
    
    // Method 1: Try to extract from markdown code block first (```json ... ``` or ``` ... ```)
    const codeBlockMatch = trimmedResponse.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (codeBlockMatch) {
        const codeContent = codeBlockMatch[1].trim();
        if (debugMode) {
            console.log(`${LOG_PREFIX} Found code block content:`, codeContent.substring(0, 200));
        }
        
        // Skip empty code blocks
        if (!codeContent) {
            if (debugMode) {
                console.log(`${LOG_PREFIX} Code block is empty`);
            }
        } else {
            // Strip comments from the code block content
            const cleanedContent = stripJsonComments(codeContent);
            
            // Try to parse the cleaned code block content
            try {
                JSON.parse(cleanedContent);
                return cleanedContent;
            } catch {
                // Code block might contain extra content, try to extract JSON from it
                const jsonInCode = extractJsonObject(cleanedContent, debugMode);
                if (jsonInCode) return jsonInCode;
            }
        }
    }
    
    // Method 1b: Handle incomplete code blocks (opening ``` without closing)
    const incompleteBlockMatch = trimmedResponse.match(/```(?:json)?\s*([\s\S]*)$/i);
    if (incompleteBlockMatch && !codeBlockMatch) {
        const codeContent = incompleteBlockMatch[1].trim();
        if (debugMode) {
            console.log(`${LOG_PREFIX} Found incomplete code block:`, codeContent.substring(0, 200));
        }
        
        if (codeContent) {
            const cleanedContent = stripJsonComments(codeContent);
            const jsonInCode = extractJsonObject(cleanedContent, debugMode);
            if (jsonInCode) return jsonInCode;
        }
    }
    
    // Method 2: Look for JSON object with "start" and "loop" keys anywhere in response
    // First strip comments from the whole response
    const cleanedResponse = stripJsonComments(trimmedResponse);
    const jsonExtracted = extractJsonObject(cleanedResponse, debugMode);
    if (jsonExtracted) return jsonExtracted;
    
    // Method 3: Try to find any valid JSON object in the response
    const anyJsonMatch = cleanedResponse.match(/\{[\s\S]*?\}/g);
    if (anyJsonMatch) {
        for (const match of anyJsonMatch) {
            try {
                const parsed = JSON.parse(match);
                if (parsed.start || parsed.loop) {
                    if (debugMode) {
                        console.log(`${LOG_PREFIX} Found JSON object with movement data`);
                    }
                    return match;
                }
            } catch {
                // Continue to next match
            }
        }
    }
    
    return null;
}

/**
 * Strips comments from JSON-like content.
 * Handles single-line (//) and multi-line (slash-asterisk) comment styles.
 * @param {string} str - The string to process.
 * @returns {string} The string with comments removed.
 */
function stripJsonComments(str) {
    if (!str) return str;
    
    let result = '';
    let i = 0;
    let inString = false;
    let escapeNext = false;
    
    while (i < str.length) {
        const char = str[i];
        const nextChar = str[i + 1];
        
        if (escapeNext) {
            result += char;
            escapeNext = false;
            i++;
            continue;
        }
        
        if (char === '\\' && inString) {
            result += char;
            escapeNext = true;
            i++;
            continue;
        }
        
        if (char === '"') {
            inString = !inString;
            result += char;
            i++;
            continue;
        }
        
        // Only process comments outside strings
        if (!inString) {
            // Single-line comment // ... until newline
            if (char === '/' && nextChar === '/') {
                // Skip until end of line
                i += 2;
                while (i < str.length && str[i] !== '\n' && str[i] !== '\r') {
                    i++;
                }
                // Keep the newline for formatting
                continue;
            }
            
            // Multi-line comment /* ... */
            if (char === '/' && nextChar === '*') {
                i += 2;
                while (i < str.length - 1) {
                    if (str[i] === '*' && str[i + 1] === '/') {
                        i += 2;
                        break;
                    }
                    i++;
                }
                continue;
            }
        }
        
        result += char;
        i++;
    }
    
    return result;
}

/**
 * Extracts a complete JSON object from text, handling nested braces.
 * @param {string} text - The text containing the JSON object.
 * @param {boolean} [debugMode=false] - Whether to log debug information.
 * @returns {string|null} The extracted JSON string or null if not found.
 */
function extractJsonObject(text, debugMode = false) {
    // Find the position of "start" or "loop" key to locate the JSON object
    const keyMatch = text.match(/"start"\s*:\s*\[|"loop"\s*:\s*\[/);
    if (!keyMatch) return null;
    
    // Find the opening brace before this key
    const keyIndex = keyMatch.index;
    let braceIndex = text.lastIndexOf('{', keyIndex);
    if (braceIndex === -1) return null;
    
    // Count braces to find the matching closing brace
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    
    for (let i = braceIndex; i < text.length; i++) {
        const char = text[i];
        
        if (escapeNext) {
            escapeNext = false;
            continue;
        }
        
        if (char === '\\') {
            escapeNext = true;
            continue;
        }
        
        if (char === '"') {
            inString = !inString;
            continue;
        }
        
        if (!inString) {
            if (char === '{') depth++;
            else if (char === '}') {
                depth--;
                if (depth === 0) {
                    // Found the complete JSON object
                    const jsonStr = text.substring(braceIndex, i + 1);
                    if (debugMode) {
                        console.log(`${LOG_PREFIX} Extracted JSON object (${jsonStr.length} chars)`);
                    }
                    return jsonStr;
                }
            }
        }
    }
    
    return null;
}

/* ================================================================================================
   LLM ANALYSIS
================================================================================================ */
async function analyzeMessageWithLLM(message, chat) {
    const settings = getConfig();
    
    if (!settings.enabled) {
        console.log(`${LOG_PREFIX} Extension disabled, skipping analysis`);
        return null;
    }

    const retryOnInvalid = settings.retryOnInvalid !== false; // Default to true
    const maxRetries = settings.maxRetries || 3;
    
    let attempt = 0;
    let lastError = null;
    
    while (attempt <= (retryOnInvalid ? maxRetries : 0)) {
        attempt++;
        
        if (attempt > 1) {
            console.log(`${LOG_PREFIX} Retry attempt ${attempt - 1}/${maxRetries}...`);
        }
        
        const result = await performLLMAnalysis(message, settings, chat);
        
        if (result.success) {
            return result.data;
        }
        
        lastError = result.error;
        
        // If retry is disabled or we've exhausted retries, break
        if (!retryOnInvalid || attempt > maxRetries) {
            break;
        }
        
        // Small delay before retry
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.error(`${LOG_PREFIX} All ${attempt} attempt(s) failed. Last error: ${lastError}`);
    return null;
}

/**
 * Performs a single LLM analysis attempt.
 * Returns { success: boolean, data?: parsed JSON, error?: string }
 * @param {string} message - The message to analyze.
 * @param {Object} settings - The configuration settings.
 * @param {Array} fullContext - The full conversation context (array of messages).
 * @returns {Promise<{success: boolean, data?: Object, error?: string}>} The result of the analysis.
 */
async function performLLMAnalysis(message, settings, fullContext = []) {
    let analysisPrompt;

    // Check if patterns mode is enabled
    if (settings.usePatternsFile) {
        const patterns = await loadPatterns();
        
        if (patterns.length === 0) {
            console.warn(`${LOG_PREFIX} Patterns mode enabled but no patterns loaded`);
            // Fall back to standard analysis
            analysisPrompt = settings.analysisPrompt.replace("{{message}}", message);
        } else {
            // Use patterns prompt
            const patternData = generatePatternDataForLLM(patterns);
            analysisPrompt = (settings.patternsPrompt || defaultSettings.patternsPrompt)
                .replace("{{message}}", message)
                .replace("{{pattern_data}}", patternData);
            
            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} Using patterns mode with ${patterns.length} patterns`);
            }
            
            // Perform pattern-based analysis
            return await performPatternAnalysis(message, settings, patterns, analysisPrompt);
        }
    } else {
        // Standard analysis
        analysisPrompt = settings.analysisPrompt.replace("{{message}}", message);
    }
    
    if (settings.debugMode) {
        console.log(`${LOG_PREFIX} Analysis prompt length: ${analysisPrompt.length} chars`);
    }

    try {
        const ctx = window.SillyTavern?.getContext();
        if (!ctx) {
            return { success: false, error: "SillyTavern context not available" };
        }

        let response;
        let usedMethod = "unknown";
        
        // Helper function for isolated/raw generation (no context)
        const tryIsolatedGeneration = async () => {
            if (typeof ctx.generateRaw === 'function') {
                if (settings.debugMode) {
                    console.log(`${LOG_PREFIX} Trying generateRaw (isolated prompt)`);
                }
                return { response: await ctx.generateRaw(analysisPrompt), method: 'generateRaw' };
            }
            return null;
        };
        
        // Helper function for quiet generation (with extension context)
        const tryQuietGeneration = async () => {
            if (typeof ctx.generateQuietPrompt === 'function') {
                if (settings.debugMode) {
                    console.log(`${LOG_PREFIX} Trying generateQuietPrompt (with context)`);
                }
                return { response: await ctx.generateQuietPrompt(analysisPrompt, false, false, ''), method: 'generateQuietPrompt' };
            }
            return null;
        };
        
        // Try isolated generation first (preferred for analysis tasks)
        const isolatedResult = await tryIsolatedGeneration();
        if (isolatedResult) {
            response = isolatedResult.response;
            usedMethod = isolatedResult.method;
        }
        
        // Fall back to quiet generation if isolated failed or returned empty
        if (!response && response !== '') {
            const quietResult = await tryQuietGeneration();
            if (quietResult) {
                response = quietResult.response;
                usedMethod = quietResult.method;
            }
        }
        
        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Used method: ${usedMethod}`);
            console.log(`${LOG_PREFIX} LLM response length: ${response?.length || 0} chars`);
            if (response) {
                console.log(`${LOG_PREFIX} LLM response preview:`, response.substring(0, 500));
            }
        }
        
        if (!response || response.trim() === '') {
            return { success: false, error: "Empty response from LLM" };
        }
        
        // Extract JSON from the response
        const jsonStr = extractJsonFromResponse(response, settings.debugMode);
        
        if (!jsonStr) {
            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} No valid JSON found in response`);
            }
            return { success: false, error: "No valid JSON found in response" };
        }
        
        try {
            const parsed = JSON.parse(jsonStr);
            
            // Validate the parsed data has required structure
            if (!parsed.start && !parsed.loop) {
                return { success: false, error: "JSON missing 'start' or 'loop' arrays" };
            }
            
            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} Successfully parsed movement data`);
            }
            
            return { success: true, data: parsed };
        } catch (parseErr) {
            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} JSON parse error:`, parseErr);
            }
            return { success: false, error: `JSON parse error: ${parseErr.message}` };
        }
    } catch (err) {
        console.error(`${LOG_PREFIX} LLM analysis error:`, err);
        return { success: false, error: err.message || "Unknown error" };
    }
}

/**
 * Performs pattern-based LLM analysis.
 * @param {string} message - The message to analyze.
 * @param {Object} settings - The configuration settings.
 * @param {Array} patterns - Available patterns.
 * @param {string} analysisPrompt - The prepared prompt.
 * @returns {Promise<{success: boolean, data?: Object, error?: string}>} The result.
 */
async function performPatternAnalysis(message, settings, patterns, analysisPrompt) {
    try {
        const ctx = window.SillyTavern?.getContext();
        if (!ctx) {
            return { success: false, error: "SillyTavern context not available" };
        }

        let response;
        
        // Try generateRaw first
        if (typeof ctx.generateRaw === 'function') {
            response = await ctx.generateRaw(analysisPrompt);
        } else if (typeof ctx.generateQuietPrompt === 'function') {
            response = await ctx.generateQuietPrompt(analysisPrompt, false, false, '');
        }
        
        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Pattern selection response:`, response?.substring(0, 500));
        }
        
        if (!response || response.trim() === '') {
            return { success: false, error: "Empty response from LLM for pattern selection" };
        }
        
        // Parse the pattern selection
        const selection = parsePatternSelection(response, settings.debugMode);
        
        if (!selection) {
            return { success: false, error: "Could not parse pattern selection from LLM response" };
        }
        
        // Find the selected pattern
        const pattern = findPatternByName(selection.pattern, patterns);
        
        if (!pattern) {
            return { success: false, error: `Pattern "${selection.pattern}" not found` };
        }
        
        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Selected pattern: ${selection.pattern}, speed: ${selection.speed_percent}%, range: ${selection.range_min}-${selection.range_max}`);
        }
        
        // Apply modifiers to the pattern
        const modifiedPattern = applyPatternModifiers(
            pattern,
            selection.speed_percent,
            selection.range_min,
            selection.range_max
        );
        
        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Modified pattern:`, modifiedPattern);
        }
        
        return { success: true, data: modifiedPattern };
    } catch (err) {
        console.error(`${LOG_PREFIX} Pattern analysis error:`, err);
        return { success: false, error: err.message || "Unknown error" };
    }
}

/* ================================================================================================
   EVENT HANDLERS AND INITIALIZATION
================================================================================================ */
/**
 * Handles incoming chat messages and triggers LLM analysis.
 * @param {number} messageId - The ID of the incoming message.
 */
async function onMessageReceived(messageId) {
    const settings = getConfig();
    
    if (!settings.enabled) {
        return;
    }
    
    try {
        const ctx = window.SillyTavern?.getContext();
        if (!ctx) {
            console.warn(`${LOG_PREFIX} No SillyTavern context available`);
            return;
        }
        
        // Get the message at the specified index
        const chat = ctx.chat;
        if (!chat || !chat[messageId]) {
            return;
        }
        
        const message = chat[messageId];
        
        // Only process AI/user messages (not system messages)
        if (message.is_system) {
            return;
        }
        
        // Get the message text
        let messageText = message.mes || message.message || '';
        
        if (!messageText || messageText.trim() === '') {
            return;
        }
        
        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Processing message ${messageId}: ${messageText.substring(0, 100)}...`);
        }
        
        // Analyze the message with LLM
        const movementData = await analyzeMessageWithLLM(messageText, chat);
        
        if (movementData) {
            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} Starting playback with movement data`);
            }
            startPlayback(movementData);
        }
    } catch (err) {
        console.error(`${LOG_PREFIX} Error in onMessageReceived:`, err);
    }
}

/**
 * Opens the patterns.json file in the system's default editor.
 */
function openPatternsFile() {
    // In SillyTavern, we can use the built-in file open functionality
    // This will open the file in a new browser tab for editing
    const patternsUrl = `${extensionFolderPath}/patterns.json`;
    window.open(patternsUrl, '_blank');
}

/**
 * Reloads patterns from the patterns.json file.
 */
async function reloadPatterns() {
    cachedPatterns = null;
    const patterns = await loadPatterns();
    
    if (patterns.length > 0) {
        toastr?.success?.(`Loaded ${patterns.length} patterns`, 'Handy AI Motion');
    } else {
        toastr?.warning?.('No patterns loaded', 'Handy AI Motion');
    }
    
    return patterns;
}

/**
 * Initializes the extension settings and UI.
 */
async function initExtension() {
    const settings = getConfig();
    
    // Create settings HTML
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $('#extensions_settings2').append(settingsHtml);
    
    // Initialize UI elements with current settings
    $('#ham_enabled').prop('checked', settings.enabled);
    $('#ham_auto_connect').prop('checked', settings.autoConnect);
    $('#ham_debug_mode').prop('checked', settings.debugMode);
    $('#ham_intiface_address').val(settings.intifaceAddress);
    $('#ham_min_speed').val(settings.minSpeed);
    $('#ham_max_speed').val(settings.maxSpeed);
    $('#ham_stroke_length').val(settings.strokeLength);
    $('#ham_expand_slow').prop('checked', settings.expandSlowMovements);
    $('#ham_step_size').val(settings.stepSize);
    $('#ham_retry_on_invalid').prop('checked', settings.retryOnInvalid);
    $('#ham_max_retries').val(settings.maxRetries);
    $('#ham_test_message').val(settings.testMessage);
    $('#ham_analysis_prompt').val(settings.analysisPrompt);
    $('#ham_use_patterns').prop('checked', settings.usePatternsFile);
    $('#ham_patterns_prompt').val(settings.patternsPrompt || defaultSettings.patternsPrompt);
    
    // Bind event handlers
    $('#ham_enabled').on('change', function() {
        extension_settings[extensionName].enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });
    
    $('#ham_auto_connect').on('change', function() {
        extension_settings[extensionName].autoConnect = $(this).prop('checked');
        saveSettingsDebounced();
    });
    
    $('#ham_debug_mode').on('change', function() {
        extension_settings[extensionName].debugMode = $(this).prop('checked');
        saveSettingsDebounced();
    });
    
    $('#ham_intiface_address').on('input', function() {
        const addr = $(this).val().trim();
        extension_settings[extensionName].intifaceAddress = addr;
        IntifaceState.SERVER_ADDRESS = addr;
        saveSettingsDebounced();
    });
    
    $('#ham_min_speed').on('input', function() {
        extension_settings[extensionName].minSpeed = parseInt($(this).val()) || 32;
        saveSettingsDebounced();
    });
    
    $('#ham_max_speed').on('input', function() {
        extension_settings[extensionName].maxSpeed = parseInt($(this).val()) || 450;
        saveSettingsDebounced();
    });
    
    $('#ham_stroke_length').on('input', function() {
        extension_settings[extensionName].strokeLength = parseInt($(this).val()) || 125;
        saveSettingsDebounced();
    });
    
    $('#ham_expand_slow').on('change', function() {
        extension_settings[extensionName].expandSlowMovements = $(this).prop('checked');
        saveSettingsDebounced();
    });
    
    $('#ham_step_size').on('input', function() {
        extension_settings[extensionName].stepSize = parseFloat($(this).val()) || 1;
        saveSettingsDebounced();
    });
    
    $('#ham_retry_on_invalid').on('change', function() {
        extension_settings[extensionName].retryOnInvalid = $(this).prop('checked');
        saveSettingsDebounced();
    });
    
    $('#ham_max_retries').on('input', function() {
        extension_settings[extensionName].maxRetries = parseInt($(this).val()) || 3;
        saveSettingsDebounced();
    });
    
    $('#ham_test_message').on('input', function() {
        extension_settings[extensionName].testMessage = $(this).val();
        saveSettingsDebounced();
    });
    
    $('#ham_analysis_prompt').on('input', function() {
        extension_settings[extensionName].analysisPrompt = $(this).val();
        saveSettingsDebounced();
    });
    
    $('#ham_use_patterns').on('change', function() {
        extension_settings[extensionName].usePatternsFile = $(this).prop('checked');
        saveSettingsDebounced();
    });
    
    $('#ham_patterns_prompt').on('input', function() {
        extension_settings[extensionName].patternsPrompt = $(this).val();
        saveSettingsDebounced();
    });
    
    // Connection buttons
    $('#ham_connect_btn').on('click', function() {
        IntifaceState.SERVER_ADDRESS = settings.intifaceAddress;
        connectIntiface();
    });
    
    $('#ham_disconnect_btn').on('click', disconnectIntiface);
    
    $('#ham_stop_btn').on('click', function() {
        stopPlayback();
        DeviceCommands.stopAll();
    });
    
    // Reset prompt button
    $('#ham_reset_prompt_btn').on('click', function() {
        $('#ham_analysis_prompt').val(defaultSettings.analysisPrompt);
        extension_settings[extensionName].analysisPrompt = defaultSettings.analysisPrompt;
        saveSettingsDebounced();
    });
    
    // Reset patterns prompt button
    $('#ham_reset_patterns_prompt_btn').on('click', function() {
        $('#ham_patterns_prompt').val(defaultSettings.patternsPrompt);
        extension_settings[extensionName].patternsPrompt = defaultSettings.patternsPrompt;
        saveSettingsDebounced();
    });
    
    // Test LLM button
    $('#ham_test_llm_btn').on('click', async function() {
        const testMessage = $('#ham_test_message').val();
        if (!testMessage || testMessage.trim() === '') {
            toastr?.warning?.('Please enter a test message', 'Handy AI Motion');
            return;
        }
        
        toastr?.info?.('Running LLM analysis...', 'Handy AI Motion');
        
        const result = await analyzeMessageWithLLM(testMessage, []);
        
        if (result) {
            toastr?.success?.('Analysis complete, starting playback', 'Handy AI Motion');
            startPlayback(result);
        } else {
            toastr?.error?.('Analysis failed', 'Handy AI Motion');
        }
    });
    
    // Custom JSON test
    $('#ham_custom_test_btn').on('click', function() {
        const jsonStr = $('#ham_custom_test_json').val();
        if (!jsonStr || jsonStr.trim() === '') {
            toastr?.warning?.('Please enter a JSON pattern', 'Handy AI Motion');
            return;
        }
        
        try {
            const data = JSON.parse(jsonStr);
            startPlayback(data);
        } catch (err) {
            toastr?.error?.(`Invalid JSON: ${err.message}`, 'Handy AI Motion');
        }
    });
    
    // Load example button
    $('#ham_load_example_btn').on('click', function() {
        const example = {
            start: ["1000,50"],
            loop: ["400,100", "400,0"]
        };
        $('#ham_custom_test_json').val(JSON.stringify(example, null, 2));
    });
    
    // Patterns file buttons
    $('#ham_open_patterns_btn').on('click', openPatternsFile);
    $('#ham_reload_patterns_btn').on('click', reloadPatterns);
    
    // Auto-connect if enabled
    if (settings.autoConnect) {
        IntifaceState.SERVER_ADDRESS = settings.intifaceAddress;
        setTimeout(connectIntiface, 1000);
    }
    
    // Register event listener for incoming messages
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.MESSAGE_SENT, () => {
        // Stop playback when user sends a message
        stopPlayback();
    });
    
    console.log(`${LOG_PREFIX} Extension initialized`);
}

// Import event types and event source from SillyTavern
import { event_types, eventSource } from "../../../../script.js";

// Initialize when jQuery is ready
jQuery(async () => {
    await initExtension();
});
