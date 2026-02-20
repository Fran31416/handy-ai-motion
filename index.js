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
    analysisPrompt: `You are a motion analysis AI. Your task is to analyze the following AI-generated message and extract movement instructions for a linear actuator device (TheHandy).

Analyze the message for emotional intensity, physical actions, pacing, and any implied movements. Generate a JSON response with movement patterns.

First, briefly explain your analysis of the scene (1-2 sentences), then provide the JSON in a code block.

The JSON format must be EXACTLY:
{
  "start": [
    "delayMs,posPercent", 
    "delayMs,posPercent", ...
  ],
  "loop": [
    "delayMs,posPercent", 
    "delayMs,posPercent", ...
  ]
}

You can add \\ comments, explanations, or extra text to the right of each action, as it will be parsed out automatically.

Where:
- start: movements that play ONCE at the beginning — use for buildup, teasing, setting the scene
- loop: movements that REPEAT until new instructions arrive — use for sustained rhythm
- delayMs: how long the movement takes (longer = slower, shorter = faster)
- posPercent: target position (0 = bottom, 100 = top)

Movement Intensity Guide:
- "Teasing hold": 2000-5000ms at partial positions (30-70%) — slow, anticipatory
- "Slow sensual stroke": 500-1000ms for full range — gentle, intimate
- "Building rhythm": 300-500ms for medium range — escalating pleasure
- "Intense grinding": 200-400ms for smaller range (20-50%) — sustained pressure
- "Climactic burst": 150-300ms for partial movements — peak intensity
- "Recovery/pause": 1000-3000ms holding position — moment of stillness

Position Meaning Guide (0-100% scale):
- 0%: Full retraction / deepest withdrawal / rest position
- 10-20%: Shallow tip teasing / minimal penetration
- 30-40%: Light engagement / gentle introduction
- 50%: Middle ground / comfortable depth
- 60-70%: Deep engagement / full sensation
- 80-90%: Near-maximum depth / intense pressure
- 100%: Full extension / complete stroke

Position Range Implications:
- Small ranges (10-20% width): Focused stimulation, teasing, grinding
- Medium ranges (30-50% width): Varied sensation, building tension
- Large ranges (70-100% width): Full strokes, intense movement

Contextual Positioning:
- Start sequences: Often begin partial (30-50%) to build anticipation
- Climax patterns: Often full range (0-100%) or deep (70-100%)
- Teasing: Short strokes in sensitive zones (40-60% or 20-40%)
- Recovery: Hold at neutral positions (40-60%)

Guidelines:
- Match the physical rhythm and intensity described in the scene
- Longer start sequences work well for anticipation and teasing
- Simpler loops create sustainable rhythms
- Vary positions naturally — avoid mechanical 0-100-0 patterns
- Consider the pacing: slow buildups, sustained middles, intense peaks
- Use holds and pauses where the scene suggests stillness or tension

AI Message to analyze:
{{message}}

You may also include a brief explanation before the JSON code block.`,
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
            const duration = movements[movements.length - 1].delay; // Use the duration of the last movement for the transition

            if (lastPos !== endPos) {
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

    analysisPrompt = settings.analysisPrompt.replace("{{message}}", message);
    
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

        const result = await tryIsolatedGeneration();
        if (result) {
            response = result.response;
            usedMethod = result.method;
        }
        
        
        // Last resort: Direct API call
        if (!response && ctx.api) {
            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} Trying direct API call as last resort`);
            }
            try {
                const apiResponse = await fetch('/api/backends/text-generation/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        prompt: analysisPrompt,
                        temperature: 0.7,
                    })
                });
                if (apiResponse.ok) {
                    const data = await apiResponse.json();
                    response = data.text || data.response || data.message || JSON.stringify(data);
                    usedMethod = 'direct_api';
                }
            } catch (apiErr) {
                console.warn(`${LOG_PREFIX} Direct API call failed:`, apiErr);
            }
        }
        
        if (response) {
            console.log(`${LOG_PREFIX} Generation completed using: ${usedMethod}`);
        }
        
        if (!response) {
            console.error(`${LOG_PREFIX} No LLM generation method available`);
            return { success: false, error: "No LLM generation method available" };
        }

        const trimmedResponse = response.trim();
        if (!trimmedResponse || trimmedResponse === '```') {
            return { success: false, error: "Empty or invalid response from LLM" };
        }

        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} LLM Response (${response.length} chars):`, response.substring(0, 500));
        }

        const extractedJson = extractJsonFromResponse(response, settings.debugMode);
        
        if (!extractedJson) {
            console.warn(`${LOG_PREFIX} No valid JSON found in LLM response`);
            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} Full response:`, response);
            }
            return { success: false, error: "No valid JSON found in response" };
        }

        try {
            const parsed = JSON.parse(extractedJson);
            
            if (!Array.isArray(parsed.start) || !Array.isArray(parsed.loop)) {
                console.warn(`${LOG_PREFIX} Invalid JSON structure - need start and loop arrays`);
                return { success: false, error: "Invalid JSON structure - need start and loop arrays" };
            }

            console.log(`${LOG_PREFIX} Successfully parsed movement JSON - start: ${parsed.start.length}, loop: ${parsed.loop.length}`);
            return { success: true, data: parsed };
        } catch (parseErr) {
            console.error(`${LOG_PREFIX} JSON parse error:`, parseErr);
            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} Extracted JSON string:`, extractedJson);
            }
            return { success: false, error: `JSON parse error: ${parseErr.message}` };
        }

    } catch (err) {
        console.error(`${LOG_PREFIX} LLM analysis failed:`, err);
        return { success: false, error: `LLM analysis failed: ${err.message}` };
    }
}

/* ================================================================================================
   TEST MOVEMENT
================================================================================================ */
/**
 * Runs a custom test pattern provided by the user in the UI.
 */
function runCustomTest() {
    const jsonInput = $("#ham_custom_test_json").val().trim();
    
    if (!jsonInput) {
        console.warn(`${LOG_PREFIX} No custom JSON provided`);
        if (window.toastr) {
            window.toastr.warning("Please enter a JSON pattern in the text area", "Handy AI Motion");
        }
        return;
    }
    
    try {
        const pattern = JSON.parse(jsonInput);
        
        // Validate structure
        if (!pattern.start && !pattern.loop) {
            throw new Error("JSON must have 'start' and/or 'loop' arrays");
        }
        
        if (pattern.start && !Array.isArray(pattern.start)) {
            throw new Error("'start' must be an array");
        }
        
        if (pattern.loop && !Array.isArray(pattern.loop)) {
            throw new Error("'loop' must be an array");
        }
        
        console.log(`${LOG_PREFIX} Running custom test:`, pattern);
        startPlayback(pattern);
        
        if (window.toastr) {
            window.toastr.success("Running custom pattern", "Handy AI Motion");
        }
        
    } catch (err) {
        console.error(`${LOG_PREFIX} Invalid JSON:`, err);
        if (window.toastr) {
            window.toastr.error(`Invalid JSON: ${err.message}`, "Handy AI Motion");
        }
    }
}

/**
 * Loads a random example movement pattern into the custom test area.
 */
function loadExamplePattern() {
    // Provide multiple example patterns
    const examples = [
        {
            name: "Slow Strokes",
            pattern: {
                start: ["1000,100", "1000,0"],
                loop: ["800,100", "800,0"]
            }
        },
        {
            name: "Fast Strokes",
            pattern: {
                start: ["200,100", "200,0", "200,100", "200,0"],
                loop: ["150,100", "150,0"]
            }
        },
        {
            name: "Teasing (Short Strokes)",
            pattern: {
                start: ["500,60", "400,40", "500,60", "400,40"],
                loop: ["300,70", "300,30"]
            }
        },
        {
            name: "Wave Pattern",
            pattern: {
                start: ["400,20", "400,40", "400,60", "400,80", "400,100"],
                loop: ["300,100", "300,50", "300,0", "300,50"]
            }
        },
        {
            name: "Warmup to Intense",
            pattern: {
                start: ["800,100", "800,0", "600,100", "600,0", "400,100", "400,0"],
                loop: ["250,100", "250,0"]
            }
        }
    ];
    
    // Pick a random example for variety
    const example = examples[Math.floor(Math.random() * examples.length)];
    
    const jsonStr = JSON.stringify(example.pattern, null, 2);
    $("#ham_custom_test_json").val(jsonStr);
    
    console.log(`${LOG_PREFIX} Loaded example: ${example.name}`);
    if (window.toastr) {
        window.toastr.info(`Loaded: ${example.name}`, "Handy AI Motion");
    }
}

/**
 * Tests the LLM analysis pipeline using the current test message.
 * Starts playback if successful.
 */
async function testLLMAnalysis() {
    console.log(`${LOG_PREFIX} Testing LLM Analysis...`);
    
    const settings = getConfig();
    const testMessage = $("#ham_test_message").val()?.trim() || settings.testMessage;
    
    if (!testMessage) {
        console.warn(`${LOG_PREFIX} No test message provided`);
        if (window.toastr) {
            window.toastr.warning("Please enter a test message", "Handy AI Motion");
        }
        return;
    }
    
    if (window.toastr) {
        window.toastr.info("Testing LLM connection...", "Handy AI Motion");
    }
    
    if (settings.debugMode) {
        console.log(`${LOG_PREFIX} Test message:`, testMessage.substring(0, 200));
    }
    
    try {
        const movementData = await analyzeMessageWithLLM(testMessage, "");
        
        if (movementData) {
            console.log(`${LOG_PREFIX} LLM test successful:`, movementData);
            startPlayback(movementData);
            
            if (window.toastr) {
                window.toastr.success("LLM Analysis successful! Starting playback.", "Handy AI Motion");
            }
        } else {
            console.error(`${LOG_PREFIX} LLM test failed - no valid data returned`);
            if (window.toastr) {
                window.toastr.error("LLM Analysis failed - check console for details", "Handy AI Motion");
            }
        }
    } catch (err) {
        console.error(`${LOG_PREFIX} LLM test error:`, err);
        if (window.toastr) {
            window.toastr.error(`LLM Analysis error: ${err.message}`, "Handy AI Motion");
        }
    }
}

/* ================================================================================================
   SETTINGS LOAD/BIND
================================================================================================ */
/**
 * Loads the extension settings from the global settings object.
 * Applies default values for any missing settings and updates the UI.
 */
async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    const settings = extension_settings[extensionName];

    // Apply defaults for any missing settings
    for (const k in defaultSettings) {
        if (settings[k] === undefined) settings[k] = defaultSettings[k];
    }

    // Update UI elements with current settings
    $("#ham_enabled").prop("checked", settings.enabled);
    $("#ham_auto_connect").prop("checked", settings.autoConnect);
    $("#ham_debug_mode").prop("checked", settings.debugMode);
    $("#ham_intiface_address").val(settings.intifaceAddress);
    $("#ham_min_speed").val(settings.minSpeed);
    $("#ham_max_speed").val(settings.maxSpeed);
    $("#ham_stroke_length").val(settings.strokeLength);
    $("#ham_expand_slow").prop("checked", settings.expandSlowMovements);
    $("#ham_step_size").val(settings.stepSize);
    $("#ham_retry_on_invalid").prop("checked", settings.retryOnInvalid);
    $("#ham_max_retries").val(settings.maxRetries);
    $("#ham_analysis_prompt").val(settings.analysisPrompt);
    $("#ham_test_message").val(settings.testMessage);
}

/**
 * Binds event listeners to UI elements for user interaction.
 * Updates settings and triggers actions based on user input.
 */
function bindEvents() {
    // Enable toggle
    $("#ham_enabled").on("change", function () {
        extension_settings[extensionName].enabled = this.checked;
        saveSettingsDebounced();
    });

    // Auto-connect toggle
    $("#ham_auto_connect").on("change", function () {
        extension_settings[extensionName].autoConnect = this.checked;
        saveSettingsDebounced();
    });

    // Debug mode toggle
    $("#ham_debug_mode").on("change", function () {
        extension_settings[extensionName].debugMode = this.checked;
        saveSettingsDebounced();
    });

    // Intiface address
    $("#ham_intiface_address").on("input", function () {
        extension_settings[extensionName].intifaceAddress = $(this).val();
        IntifaceState.SERVER_ADDRESS = $(this).val();
        saveSettingsDebounced();
    });

    // Speed range
    $("#ham_min_speed").on("input", function () {
        extension_settings[extensionName].minSpeed = Number(this.value);
        saveSettingsDebounced();
    });

    $("#ham_max_speed").on("input", function () {
        extension_settings[extensionName].maxSpeed = Number(this.value);
        saveSettingsDebounced();
    });

    // Stroke length
    $("#ham_stroke_length").on("input", function () {
        extension_settings[extensionName].strokeLength = Number(this.value);
        saveSettingsDebounced();
    });

    // Expand slow movements toggle
    $("#ham_expand_slow").on("change", function () {
        extension_settings[extensionName].expandSlowMovements = this.checked;
        saveSettingsDebounced();
    });

    // Step size for slow movement expansion
    $("#ham_step_size").on("input", function () {
        extension_settings[extensionName].stepSize = Number(this.value);
        saveSettingsDebounced();
    });

    // Retry on invalid
    $("#ham_retry_on_invalid").on("change", function () {
        extension_settings[extensionName].retryOnInvalid = this.checked;
        saveSettingsDebounced();
    });

    // Max retries
    $("#ham_max_retries").on("input", function () {
        extension_settings[extensionName].maxRetries = Number(this.value);
        saveSettingsDebounced();
    });

    // Analysis prompt
    $("#ham_analysis_prompt").on("input", function () {
        extension_settings[extensionName].analysisPrompt = $(this).val();
        saveSettingsDebounced();
    });

    // Test message
    $("#ham_test_message").on("input", function () {
        extension_settings[extensionName].testMessage = $(this).val();
        saveSettingsDebounced();
    });

    // Connection buttons
    $("#ham_connect_btn").on("click", function (e) {
        e.preventDefault();
        connectIntiface();
    });

    $("#ham_disconnect_btn").on("click", function (e) {
        e.preventDefault();
        disconnectIntiface();
    });

    $("#ham_stop_btn").on("click", function (e) {
        e.preventDefault();
        stopPlayback();
        DeviceCommands.stopAll();
    });

    // Custom test buttons
    $("#ham_custom_test_btn").on("click", function (e) {
        e.preventDefault();
        runCustomTest();
    });

    $("#ham_load_example_btn").on("click", function (e) {
        e.preventDefault();
        loadExamplePattern();
    });

    // LLM test button
    $("#ham_test_llm_btn").on("click", function (e) {
        e.preventDefault();
        testLLMAnalysis();
    });

    // Reset prompt button
    $("#ham_reset_prompt_btn").on("click", function (e) {
        e.preventDefault();
        extension_settings[extensionName].analysisPrompt = defaultSettings.analysisPrompt;
        $("#ham_analysis_prompt").val(defaultSettings.analysisPrompt);
        saveSettingsDebounced();
        
        if (window.toastr) {
            window.toastr.success("Analysis prompt reset to default", "Handy AI Motion");
        }
    });
}

/* ================================================================================================
   SILLYTAVERN EVENT HANDLERS
================================================================================================ */
/**
 * Handles a new message received event from SillyTavern and triggers analysis/playback if enabled.
 * @param {Object} eventData - The event data from SillyTavern.
 */
function handleMessageReceived(eventData) {
    const settings = getConfig();
    
    if (!settings.enabled) {
        return;
    }
    
    // Get the message content
    const ctx = window.SillyTavern?.getContext();
    if (!ctx) return;
    
    const chat = ctx.chat || [];
    const lastMessage = chat[chat.length - 1];
    
    if (!lastMessage || lastMessage.is_user) return;
    
    const messageText = lastMessage.mes || lastMessage.text || lastMessage.content || "";
    
    if (!messageText) return;
    
    if (settings.debugMode) {
        console.log(`${LOG_PREFIX} Processing message:`, messageText.substring(0, 200));
    }
    
    // Analyze and execute movement
    analyzeMessageWithLLM(messageText, chat).then(movementData => {
        if (movementData) {
            startPlayback(movementData);
        }
    }).catch(err => {
        console.error(`${LOG_PREFIX} Error processing message:`, err);
    });
}

/* ================================================================================================
   INITIALIZATION
================================================================================================ */
jQuery(async () => {
    // Load settings HTML
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings").append(settingsHtml);

    // Load and bind settings
    await loadSettings();
    bindEvents();

    // Set up Intiface server address from settings
    IntifaceState.SERVER_ADDRESS = extension_settings[extensionName]?.intifaceAddress || defaultSettings.intifaceAddress;

    // Register event handlers
    try {
        const { eventSource, event_types } = SillyTavern.getContext();
        
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handleMessageReceived);
        
        console.log(`${LOG_PREFIX} Event handlers registered`);
    } catch (err) {
        console.warn(`${LOG_PREFIX} Could not register event handlers:`, err);
    }

    // Auto-connect if enabled
    const settings = getConfig();
    if (settings.autoConnect) {
        setTimeout(() => {
            console.log(`${LOG_PREFIX} Auto-connecting to Intiface...`);
            connectIntiface();
        }, 2000);
    }

    console.log(`${LOG_PREFIX} Extension loaded successfully`);
});
