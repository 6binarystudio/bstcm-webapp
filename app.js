// Speech Recognition Web App using Web Speech API

class SpeechRecognitionApp {
    constructor() {
        this.recognizer = null;
        this.isListening = false;
        this.isPlaying = false;
        this.audioContext = null;
        this.triggerPhrases = []; // Array of {phrase: string, audioFile: File/string, audioUrl: string}
        this.audioElements = new Map(); // Cache audio elements for iOS compatibility
        this.audioUnlocked = false; // Track if audio is unlocked for iOS
        this.pauseDuration = 1500;
        this.lastSpeechTime = 0;
        this.pauseTimer = null;
        this.currentTranscript = '';
        this.words = [];
        this.triggerDetectedInCurrentSession = false;
        this.detectedTrigger = null; // Store which trigger was detected
        this.lastProcessedResultIndex = -1; // Track the last result index we processed to avoid duplicates
        this.isCumulativePlatform = null; // Track if platform uses cumulative results (Android) or incremental (iPhone/Laptop)
        this.pendingFinalTranscript = ''; // Buffer final results until pause
        this.pauseCheckTimer = null; // Timer to check for pause
        
        this.initializeElements();
        this.setupEventListeners();
        this.initializeAudioContext();
        this.loadModel();
        // Load defaults after a short delay to ensure audio context is ready
        setTimeout(() => this.loadDefaultTriggers(), 100);
    }

    initializeElements() {
        this.statusIndicator = document.getElementById('statusIndicator');
        this.statusText = document.getElementById('statusText');
        this.statusDot = this.statusIndicator.querySelector('.status-dot');
        this.modelStatus = document.getElementById('modelStatus');
        this.startBtn = document.getElementById('startBtn');
        this.stopBtn = document.getElementById('stopBtn');
        this.clearBtn = document.getElementById('clearBtn');
        this.transcriptDiv = document.getElementById('transcript');
        this.triggerLog = document.getElementById('triggerLog');
        this.pauseDurationInput = document.getElementById('pauseDuration');
        this.debugLog = document.getElementById('debugLog');
        this.debugPanel = document.getElementById('debugPanel');
        this.toggleDebugBtn = document.getElementById('toggleDebug');
        this.clearDebugBtn = document.getElementById('clearDebug');
        
        // Initialize debug console
        this.setupDebugConsole();
    }

    setupEventListeners() {
        this.startBtn.addEventListener('click', () => this.startListening());
        this.stopBtn.addEventListener('click', () => this.stopListening());
        this.clearBtn.addEventListener('click', () => this.clearTranscript());
        this.pauseDurationInput.addEventListener('change', (e) => {
            this.pauseDuration = parseInt(e.target.value);
        });
        
        // Debug console controls
        if (this.toggleDebugBtn) {
            this.toggleDebugBtn.addEventListener('click', () => this.toggleDebugConsole());
        }
        if (this.clearDebugBtn) {
            this.clearDebugBtn.addEventListener('click', () => this.clearDebugConsole());
        }
    }

    setupDebugConsole() {
        // Intercept console methods and display in debug panel
        const originalLog = console.log;
        const originalInfo = console.info;
        const originalWarn = console.warn;
        const originalError = console.error;

        const addToDebugLog = (message, type = 'log') => {
            if (!this.debugLog) return;
            
            const timestamp = new Date().toLocaleTimeString();
            const entry = document.createElement('div');
            entry.className = `debug-entry ${type}`;
            
            // Format message - handle objects and arrays
            let formattedMessage = message;
            if (typeof message === 'object') {
                try {
                    formattedMessage = JSON.stringify(message, null, 2);
                } catch (e) {
                    formattedMessage = String(message);
                }
            }
            
            entry.innerHTML = `<span class="debug-timestamp">[${timestamp}]</span>${formattedMessage}`;
            this.debugLog.appendChild(entry);
            
            // Auto-scroll to bottom
            this.debugLog.scrollTop = this.debugLog.scrollHeight;
            
            // Keep only last 100 entries to prevent memory issues
            const entries = this.debugLog.querySelectorAll('.debug-entry');
            if (entries.length > 100) {
                entries[0].remove();
            }
        };

        console.log = (...args) => {
            originalLog.apply(console, args);
            addToDebugLog(args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '), 'log');
        };

        console.info = (...args) => {
            originalInfo.apply(console, args);
            addToDebugLog(args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '), 'info');
        };

        console.warn = (...args) => {
            originalWarn.apply(console, args);
            addToDebugLog(args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '), 'warn');
        };

        console.error = (...args) => {
            originalError.apply(console, args);
            addToDebugLog(args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '), 'error');
        };

        // Add success method
        console.success = (...args) => {
            originalLog.apply(console, args);
            addToDebugLog(args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '), 'success');
        };
    }

    toggleDebugConsole() {
        if (this.debugPanel) {
            this.debugPanel.classList.toggle('collapsed');
            this.toggleDebugBtn.textContent = this.debugPanel.classList.contains('collapsed') ? 'Show' : 'Hide';
        }
    }

    clearDebugConsole() {
        if (this.debugLog) {
            this.debugLog.innerHTML = '';
        }
    }

    loadDefaultTriggers() {
        // Load default trigger phrases if any exist in localStorage
        const saved = localStorage.getItem('triggerPhrases');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                console.log(`Loading ${parsed.length} triggers from localStorage`);
                // Restore triggers with proper structure (File objects can't be saved)
                this.triggerPhrases = parsed.map((t, index) => ({
                    id: t.id || Date.now() + index + Math.random(), // Use saved ID or generate new one
                    phrase: t.phrase,
                    audioFile: t.audioFile || null, // Restore audioFile path if available
                    audioUrl: t.audioUrl || t.audioFile || null, // Use audioUrl or fallback to audioFile
                    isDefault: t.isDefault || false
                }));
                
                // Restore audioUrl from audioFile if audioUrl is missing
                this.triggerPhrases.forEach(trigger => {
                    if (!trigger.audioUrl && trigger.audioFile) {
                        trigger.audioUrl = trigger.audioFile;
                        console.log(`Restored audioUrl from audioFile for: ${trigger.phrase}`);
                    }
                });
                
                // Pre-load audio elements after restoring URLs
                this.preloadAudioElements();
                
                // If we have default triggers without audio URLs (blob URLs don't persist),
                // regenerate the audio for them
                const needsRegeneration = this.triggerPhrases.some(t => t.isDefault && !t.audioUrl);
                if (needsRegeneration) {
                    this.regenerateDefaultAudio();
                }
            } catch (e) {
                console.error('Error loading saved triggers:', e);
                // If loading fails, initialize defaults
                this.initializeDefaultTriggers();
            }
        } else {
            // No saved triggers, initialize defaults
            this.initializeDefaultTriggers();
        }
    }

    async initializeDefaultTriggers() {
        // First, try to load packaged triggers from triggers.json
        try {
            const response = await fetch('./triggers.json');
            if (response.ok) {
                const config = await response.json();
                if (config.triggers && config.triggers.length > 0) {
                    // Load packaged triggers with audio files
                    console.log(`Loading ${config.triggers.length} triggers from triggers.json`);
                    for (const trigger of config.triggers) {
                        try {
                            // Check if audio file exists
                            const audioResponse = await fetch(trigger.audioFile, { method: 'HEAD' });
                            if (audioResponse.ok) {
                                // Audio file exists, use it
                                console.log(`✓ Loading trigger: "${trigger.phrase}" with audio: ${trigger.audioFile}`);
                                this.addTriggerPhrase(trigger.phrase, trigger.audioFile, true);
                            } else {
                                // Audio file not found, generate tone as fallback
                                console.warn(`✗ Audio file not found (${audioResponse.status}): ${trigger.audioFile} for "${trigger.phrase}"`);
                                await this.addTriggerWithFallback(trigger.phrase);
                            }
                        } catch (error) {
                            console.warn(`✗ Audio file not found for "${trigger.phrase}", using generated tone:`, error);
                            await this.addTriggerWithFallback(trigger.phrase);
                        }
                    }
                    console.log(`✅ Loaded ${this.triggerPhrases.length} triggers total`);
                    // Pre-load audio elements for iOS compatibility
                    this.preloadAudioElements();
                    return; // Successfully loaded packaged triggers
                }
            }
        } catch (error) {
            console.log('No triggers.json found or error loading it, using built-in defaults:', error);
        }

        // Fallback to built-in default triggers with generated tones
        const defaultTriggers = [
            { phrase: 'hello assistant', frequency: 440, duration: 0.5 },
            { phrase: 'good morning', frequency: 523, duration: 0.5 },
            { phrase: 'good afternoon', frequency: 587, duration: 0.5 },
            { phrase: 'good evening', frequency: 659, duration: 0.5 },
            { phrase: 'thank you', frequency: 698, duration: 0.4 },
            { phrase: 'how are you', frequency: 784, duration: 0.6 }
        ];

        // Generate audio for each default trigger
        for (const trigger of defaultTriggers) {
            await this.addTriggerWithFallback(trigger.phrase, trigger.frequency, trigger.duration);
        }
        
        // Pre-load audio elements for iOS compatibility
        this.preloadAudioElements();
    }

    async addTriggerWithFallback(phrase, frequency = 440, duration = 0.5) {
        try {
            const audioUrl = await this.generateAudioTone(frequency, duration);
            this.addTriggerPhrase(phrase, audioUrl, true); // Mark as default
        } catch (error) {
            console.error(`Error generating audio for "${phrase}":`, error);
            // Add trigger without audio (will use text-to-speech fallback)
            this.addTriggerPhrase(phrase, null, true);
        }
    }

    async regenerateDefaultAudio() {
        // First try to reload from triggers.json if available
        try {
            const response = await fetch('./triggers.json');
            if (response.ok) {
                const config = await response.json();
                if (config.triggers) {
                    const triggerMap = {};
                    config.triggers.forEach(t => {
                        triggerMap[t.phrase] = t.audioFile;
                    });

                    for (const trigger of this.triggerPhrases) {
                        if (trigger.isDefault && !trigger.audioUrl && triggerMap[trigger.phrase]) {
                            try {
                                // Check if audio file exists
                                const audioResponse = await fetch(triggerMap[trigger.phrase], { method: 'HEAD' });
                                if (audioResponse.ok) {
                                    trigger.audioUrl = triggerMap[trigger.phrase];
                                }
                            } catch (error) {
                                // File not found, will fall through to generated tone
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.log('Could not reload from triggers.json:', error);
        }

        // Fallback: Regenerate audio tones for default triggers that lost their blob URLs
        const defaultFrequencies = {
            'hello assistant': 440,
            'good morning': 523,
            'good afternoon': 587,
            'good evening': 659,
            'thank you': 698,
            'how are you': 784
        };

        for (const trigger of this.triggerPhrases) {
            if (trigger.isDefault && !trigger.audioUrl && defaultFrequencies[trigger.phrase]) {
                try {
                    const frequency = defaultFrequencies[trigger.phrase];
                    const audioUrl = await this.generateAudioTone(frequency, 0.5);
                    trigger.audioUrl = audioUrl;
                } catch (error) {
                    console.error(`Error regenerating audio for "${trigger.phrase}":`, error);
                }
            }
        }
        this.saveTriggers();
    }

    async generateAudioTone(frequency = 440, duration = 0.5) {
        // Generate a simple audio tone using Web Audio API
        return new Promise(async (resolve, reject) => {
            try {
                if (!this.audioContext) {
                    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                }
                
                // Resume audio context if suspended (required by some browsers)
                if (this.audioContext.state === 'suspended') {
                    await this.audioContext.resume();
                }

                const sampleRate = this.audioContext.sampleRate;
                const numSamples = Math.floor(sampleRate * duration);
                const buffer = this.audioContext.createBuffer(1, numSamples, sampleRate);
                const data = buffer.getChannelData(0);

                // Generate a sine wave with a fade in/out to avoid clicks
                for (let i = 0; i < numSamples; i++) {
                    const t = i / sampleRate;
                    // Apply envelope (fade in/out)
                    const fadeIn = Math.min(1, i / (sampleRate * 0.05)); // 50ms fade in
                    const fadeOut = Math.min(1, (numSamples - i) / (sampleRate * 0.05)); // 50ms fade out
                    const envelope = fadeIn * fadeOut;
                    data[i] = Math.sin(2 * Math.PI * frequency * t) * envelope * 0.3;
                }

                // Convert AudioBuffer to WAV blob
                const wav = this.audioBufferToWav(buffer);
                const blob = new Blob([wav], { type: 'audio/wav' });
                const url = URL.createObjectURL(blob);
                
                resolve(url);
            } catch (error) {
                reject(error);
            }
        });
    }

    audioBufferToWav(buffer) {
        const length = buffer.length;
        const sampleRate = buffer.sampleRate;
        const arrayBuffer = new ArrayBuffer(44 + length * 2);
        const view = new DataView(arrayBuffer);
        const channels = 1;

        // WAV header
        const writeString = (offset, string) => {
            for (let i = 0; i < string.length; i++) {
                view.setUint8(offset + i, string.charCodeAt(i));
            }
        };

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + length * 2, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, channels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * channels * 2, true);
        view.setUint16(32, channels * 2, true);
        view.setUint16(34, 16, true);
        writeString(36, 'data');
        view.setUint32(40, length * 2, true);

        // Convert float samples to 16-bit PCM
        let offset = 44;
        for (let i = 0; i < length; i++) {
            const sample = Math.max(-1, Math.min(1, buffer.getChannelData(0)[i]));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
            offset += 2;
        }

        return arrayBuffer;
    }

    saveTriggers() {
        // Save trigger phrases to localStorage (without File objects, just URLs)
        // Note: blob URLs won't persist across page reloads, only file paths/URLs will
        // For default triggers with generated audio, we mark them with a special flag
        const toSave = this.triggerPhrases.map(t => ({
            id: t.id,
            phrase: t.phrase,
            audioUrl: t.audioUrl && !t.audioUrl.startsWith('blob:') ? t.audioUrl : null,
            isDefault: t.isDefault || false // Mark default triggers
        }));
        localStorage.setItem('triggerPhrases', JSON.stringify(toSave));
    }

    addTriggerPhrase(phrase = '', audioFile = null, isDefault = false) {
        const trigger = {
            id: Date.now() + Math.random(),
            phrase: phrase.toLowerCase().trim(),
            audioFile: audioFile,
            audioUrl: null,
            isDefault: isDefault
        };

        if (audioFile) {
            if (audioFile instanceof File) {
                trigger.audioUrl = URL.createObjectURL(audioFile);
            } else if (typeof audioFile === 'string') {
                // If it's a string, use it directly as the URL
                trigger.audioUrl = audioFile;
            }
        }

        console.log(`Adding trigger: "${trigger.phrase}", audioFile="${audioFile}", audioUrl="${trigger.audioUrl}", id=${trigger.id}`);
        
        this.triggerPhrases.push(trigger);
        this.saveTriggers();
    }

    async initializeAudioContext() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            
            // Resume audio context on user interaction (required by browsers, especially iOS)
            const unlockAudio = async () => {
                if (this.audioContext && this.audioContext.state === 'suspended') {
                    try {
                        await this.audioContext.resume();
                        console.log('Audio context resumed');
                    } catch (e) {
                        console.warn('Could not resume audio context:', e);
                    }
                }
                
                // Note: Audio unlocking is now handled in startListening() to ensure
                // it happens synchronously during the user interaction
            };
            
            // Unlock on any user interaction
            document.addEventListener('click', unlockAudio, { once: true });
            document.addEventListener('touchstart', unlockAudio, { once: true });
            document.addEventListener('touchend', unlockAudio, { once: true });
        } catch (error) {
            console.error('Error initializing audio context:', error);
        }
    }

    preloadAudioElements() {
        // Pre-load audio elements for all triggers (for iOS compatibility)
        console.log('Pre-loading audio elements...');
        console.log(`Total triggers: ${this.triggerPhrases.length}`);
        
        let preloadedCount = 0;
        let skippedCount = 0;
        
        this.triggerPhrases.forEach((trigger, index) => {
            console.log(`Trigger ${index + 1}: phrase="${trigger.phrase}", audioUrl="${trigger.audioUrl}", id=${trigger.id}`);
            
            if (!trigger.audioUrl) {
                console.warn(`  ⚠️ No audioUrl for trigger: ${trigger.phrase}`);
                skippedCount++;
                return;
            }
            
            if (this.audioElements.has(trigger.id)) {
                console.log(`  ⏭️ Audio element already exists for: ${trigger.phrase}`);
                return;
            }
            
            try {
                const audio = new Audio(trigger.audioUrl);
                audio.preload = 'auto';
                audio.volume = 1;
                
                // Store trigger info on audio element for debugging
                audio._triggerPhrase = trigger.phrase;
                audio._triggerId = trigger.id;
                
                // Store for later use
                this.audioElements.set(trigger.id, audio);
                preloadedCount++;
                console.log(`  ✅ Audio element pre-loaded for: ${trigger.phrase} (ID: ${trigger.id}, URL: ${trigger.audioUrl})`);
            } catch (error) {
                console.warn(`  ❌ Error pre-loading audio for ${trigger.phrase}:`, error);
                skippedCount++;
            }
        });
        
        console.log(`✅ Pre-loaded ${preloadedCount} audio elements, ${skippedCount} skipped, total in cache: ${this.audioElements.size}`);
    }

    async unlockAudioForIOS() {
        // Unlock ALL audio elements for iOS by playing/pausing them in response to user gesture
        // iOS requires each audio element to be "unlocked" individually
        // CRITICAL: This must happen synchronously during user interaction (no setTimeout delays)
        console.log('Unlocking all audio elements for iOS (silent unlock)...');
        console.log(`Found ${this.triggerPhrases.length} triggers, ${this.audioElements.size} pre-loaded audio elements`);
        
        let unlockedCount = 0;
        let failedCount = 0;
        let skippedCount = 0;
        
        // Unlock all audio elements sequentially WITHOUT delays to maintain user interaction context
        for (const trigger of this.triggerPhrases) {
            if (trigger.audioUrl) {
                const audio = this.audioElements.get(trigger.id);
                if (!audio) {
                    console.warn(`⚠️ Audio element not found for trigger: ${trigger.phrase} (ID: ${trigger.id})`);
                    skippedCount++;
                    continue;
                }
                
                if (audio._unlocked) {
                    console.log(`⏭️ Audio already unlocked: ${trigger.phrase}`);
                    unlockedCount++;
                    continue;
                }
                
                try {
                    // Set volume to 0 first
                    audio.volume = 0;
                    
                    // Load if needed and wait briefly for it to be ready
                    if (audio.readyState < 2) {
                        audio.load();
                        // Wait for audio to be ready, but with short timeout to maintain user interaction context
                        try {
                            await Promise.race([
                                new Promise(resolve => {
                                    if (audio.readyState >= 2) {
                                        resolve();
                                    } else {
                                        audio.addEventListener('canplay', resolve, { once: true });
                                    }
                                }),
                                new Promise(resolve => setTimeout(resolve, 200)) // Short timeout
                            ]);
                        } catch (e) {
                            // Continue even if timeout
                        }
                    }
                    
                    // CRITICAL: Play and immediately pause - must happen synchronously
                    // This unlocks the audio element for future use
                    try {
                        const playPromise = audio.play();
                        if (playPromise !== undefined) {
                            // Wait for play promise but with very short timeout
                            await Promise.race([
                                playPromise,
                                new Promise((_, reject) => setTimeout(() => reject(new Error('Play timeout')), 150))
                            ]);
                        }
                        
                        // Immediately pause (should be silent due to volume = 0)
                        audio.pause();
                        audio.currentTime = 0;
                        audio.volume = 1;
                        
                        // Mark as unlocked
                        audio._unlocked = true;
                        unlockedCount++;
                        console.log(`✅ Audio unlocked: ${trigger.phrase}`);
                    } catch (playErr) {
                        // If play fails, mark as attempted
                        console.warn(`Could not unlock audio for ${trigger.phrase}:`, playErr);
                        audio._unlockAttempted = true;
                        failedCount++;
                    }
                } catch (e) {
                    console.warn(`Error unlocking audio for ${trigger.phrase}:`, e);
                    if (audio) {
                        audio._unlockAttempted = true;
                    }
                    failedCount++;
                }
            }
        }
        
        console.log(`✅ Audio unlock complete: ${unlockedCount} unlocked, ${failedCount} failed, ${skippedCount} skipped`);
        
        // If some failed, log a warning
        if (failedCount > 0 || skippedCount > 0) {
            console.warn(`⚠️ ${failedCount} audio files failed to unlock, ${skippedCount} not found. They may not play on iOS.`);
        }
    }
    
    async unlockSingleAudioForIOS(audio, triggerPhrase) {
        // Unlock a single audio element when it's actually needed (lazy unlock)
        if (audio._unlocked) {
            return; // Already unlocked
        }
        
        try {
            console.log(`Unlocking audio for: ${triggerPhrase}`);
            // Set volume to 0 first
            audio.volume = 0;
            
            // Ensure audio is loaded
            if (audio.readyState < 2) {
                audio.load();
                await new Promise(resolve => {
                    if (audio.readyState >= 2) {
                        resolve();
                    } else {
                        audio.addEventListener('canplay', resolve, { once: true });
                        setTimeout(resolve, 2000);
                    }
                });
            }
            
            // Play and immediately pause (silent unlock for iOS)
            const playPromise = audio.play();
            if (playPromise !== undefined) {
                await playPromise;
            }
            // Immediately pause
            audio.pause();
            // Reset to beginning
            audio.currentTime = 0;
            // Restore volume
            audio.volume = 1;
            
            // Mark as unlocked
            audio._unlocked = true;
            console.log(`✅ Audio unlocked for: ${triggerPhrase}`);
        } catch (e) {
            console.warn(`Could not unlock audio for ${triggerPhrase}:`, e);
            // Even if unlock fails, mark as attempted so we don't keep trying
            audio._unlockAttempted = true;
        }
    }

    async loadModel() {
        try {
            this.updateStatus('Loading model...', 'initializing');
            this.modelStatus.textContent = 'Initializing speech recognition...';

            // Use Web Speech API directly
            this.setupWebSpeechAPI();
        } catch (error) {
            console.error('Error loading model:', error);
            this.updateStatus('Error loading model', 'error');
            this.modelStatus.textContent = `Error: ${error.message}`;
        }
    }

    setupWebSpeechAPI() {
        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            this.updateStatus('Speech recognition not supported', 'error');
            this.modelStatus.textContent = 'Your browser does not support speech recognition';
            return;
        }

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        this.recognizer = new SpeechRecognition();
        this.recognizer.continuous = true;
        this.recognizer.interimResults = true;
        this.recognizer.lang = 'en-US';

        this.recognizer.onresult = (event) => {
            this.handleRecognitionResult(event);
        };

        this.recognizer.onerror = (event) => {
            console.error('Recognition error:', event.error);
            // Don't stop on 'no-speech' errors, they're normal
            if (event.error !== 'no-speech' && event.error !== 'aborted') {
                console.warn('Speech recognition error:', event.error);
            }
        };

        this.recognizer.onend = () => {
            if (this.isListening && !this.isPlaying) {
                // Auto-restart if we're still supposed to be listening
                setTimeout(() => {
                    if (this.isListening && !this.isPlaying) {
                        this.recognizer.start();
                    }
                }, 100);
            }
        };

        this.updateStatus('Using Web Speech API', 'ready');
        this.modelStatus.textContent = 'Using browser speech recognition (requires internet)';
        this.startBtn.disabled = false;
    }

    handleRecognitionResult(event) {
        // Handle results - detect if platform uses cumulative (Android) or incremental (iPhone/Laptop) results
        let interimTranscript = '';
        let finalTranscript = '';
        let hasFinalResult = false;
        let hasInterimResult = false;

        // Find the last interim result index
        let lastInterimIndex = -1;
        for (let i = event.resultIndex; i < event.results.length; i++) {
            if (!event.results[i].isFinal) {
                lastInterimIndex = i;
                hasInterimResult = true;
            } else {
                hasFinalResult = true;
            }
        }

        // Process final results
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            if (result.isFinal) {
                const transcript = result[0].transcript.trim();
                if (transcript) {
                    const currentLower = this.currentTranscript.toLowerCase().trim();
                    const transcriptLower = transcript.toLowerCase();
                    
                    // Detect platform behavior on first final result
                    // Android: Results are cumulative (each contains full transcript so far)
                    // iPhone/Laptop: Results are incremental (each contains only new text)
                    if (this.isCumulativePlatform === null && currentLower) {
                        // First time detecting - check if transcript is clearly cumulative
                        // Cumulative: transcript contains ALL of current + new text
                        // We check if transcript is significantly longer AND contains current as a complete prefix
                        const currentWords = currentLower.split(/\s+/).filter(w => w.length > 0);
                        const transcriptWords = transcriptLower.split(/\s+/).filter(w => w.length > 0);
                        const isLonger = transcriptWords.length > currentWords.length;
                        const hasAllCurrentWords = currentWords.length > 0 && 
                            currentWords.every((word, idx) => idx < transcriptWords.length && transcriptWords[idx] === word);
                        
                        // Only mark as cumulative if transcript is clearly longer and contains all current words in order
                        this.isCumulativePlatform = isLonger && hasAllCurrentWords && transcriptWords.length > currentWords.length;
                        console.log('Platform detection:', this.isCumulativePlatform ? 'Cumulative (Android)' : 'Incremental (iPhone/Laptop)', {
                            currentWords: currentWords.length,
                            transcriptWords: transcriptWords.length,
                            hasAllCurrentWords,
                            currentText: currentLower.substring(0, 50),
                            transcriptText: transcriptLower.substring(0, 50)
                        });
                    }
                    
                    if (this.isCumulativePlatform && currentLower) {
                        // Android: cumulative - extract only new part using word-by-word comparison
                        const currentWords = currentLower.split(/\s+/).filter(w => w.length > 0);
                        const transcriptWords = transcriptLower.split(/\s+/).filter(w => w.length > 0);
                        
                        // Find where new words start by comparing word by word
                        let startIndex = 0;
                        for (let j = 0; j < Math.min(transcriptWords.length, currentWords.length); j++) {
                            if (transcriptWords[j] === currentWords[j]) {
                                startIndex = j + 1;
                            } else {
                                break;
                            }
                        }
                        
                        // Extract only the new words
                        if (startIndex < transcriptWords.length) {
                            const newWords = transcriptWords.slice(startIndex);
                            // Reconstruct the original text with proper spacing
                            const originalWords = transcript.split(/\s+/).filter(w => w.length > 0);
                            const newPart = originalWords.slice(startIndex).join(' ');
                            if (newPart) {
                                finalTranscript += newPart + ' ';
                                console.log('Android: Extracted new part:', newPart, 'from full:', transcript);
                            }
                        }
                    } else {
                        // iPhone/Laptop: incremental - use as-is (it's already new text)
                        // Or first result when currentTranscript is empty
                        finalTranscript += transcript + ' ';
                    }
                }
            }
        }

        // Process interim result (only the last/most complete one)
        if (lastInterimIndex >= 0) {
            const fullInterim = event.results[lastInterimIndex][0].transcript.trim();
            if (fullInterim) {
                const currentLower = this.currentTranscript.toLowerCase().trim();
                const fullInterimLower = fullInterim.toLowerCase();
                
                if (this.isCumulativePlatform && currentLower) {
                    // Android: cumulative - extract new part using word-by-word comparison
                    const currentWords = currentLower.split(/\s+/).filter(w => w.length > 0);
                    const interimWords = fullInterimLower.split(/\s+/).filter(w => w.length > 0);
                    
                    // Find where new words start
                    let startIndex = 0;
                    for (let j = 0; j < Math.min(interimWords.length, currentWords.length); j++) {
                        if (interimWords[j] === currentWords[j]) {
                            startIndex = j + 1;
                        } else {
                            break;
                        }
                    }
                    
                    // Extract only the new words
                    if (startIndex < interimWords.length) {
                        const originalInterimWords = fullInterim.split(/\s+/).filter(w => w.length > 0);
                        interimTranscript = originalInterimWords.slice(startIndex).join(' ');
                    }
                } else {
                    // iPhone/Laptop: incremental - use as-is, but check for overlap
                    if (currentLower && fullInterimLower.startsWith(currentLower)) {
                        // Has overlap - extract new part
                        interimTranscript = fullInterim.substring(this.currentTranscript.length).trim();
                    } else {
                        // No overlap or no current transcript - use as-is
                        interimTranscript = fullInterim;
                    }
                }
            }
        }

        // Buffer final results and only display after pause (no interim results for a period)
        if (finalTranscript) {
            // Add to pending buffer
            this.pendingFinalTranscript += finalTranscript + ' ';
            this.lastSpeechTime = Date.now();
        }
        
        // If we have interim results, we're still speaking - clear pause timer and don't display yet
        if (hasInterimResult) {
            this.resetPauseTimer();
            // Clear any pending pause check
            if (this.pauseCheckTimer) {
                clearTimeout(this.pauseCheckTimer);
                this.pauseCheckTimer = null;
            }
            // Don't update transcript while still speaking, but continue to check for triggers
        }
        
        // No interim results - we have a pause
        // Wait a bit to ensure no more results are coming, then display buffered final results
        if (this.pendingFinalTranscript && !hasInterimResult) {
            // Clear any existing pause check timer
            if (this.pauseCheckTimer) {
                clearTimeout(this.pauseCheckTimer);
            }
            
            // Set timer to display after short delay (ensures pause is real)
            this.pauseCheckTimer = setTimeout(() => {
                if (this.pendingFinalTranscript.trim()) {
                    const finalToDisplay = this.pendingFinalTranscript.trim();
                    this.processFinalTranscript(finalToDisplay);
                    this.updateTranscript(finalToDisplay, ''); // Display buffered final results
                    this.pendingFinalTranscript = ''; // Clear buffer
                    console.log('Displayed buffered final transcript after pause:', finalToDisplay);
                }
                this.pauseCheckTimer = null;
            }, 300); // 300ms delay to ensure pause is real
        }
        
        // If we have final results, check for trigger phrases
        // Use the buffered final transcript for trigger detection (includes all words spoken so far)
        if (hasFinalResult) {
            // Use combined pending + new final transcript for trigger detection
            const combinedFinal = (this.pendingFinalTranscript + finalTranscript).trim();
            // Prioritize checking the NEW final transcript first (most recent speech)
            // This prevents matching old triggers from earlier in the conversation
            const newFinalLower = combinedFinal.toLowerCase().trim();
            const fullTranscript = (this.currentTranscript + combinedFinal).toLowerCase().trim();
            
            console.log('🔍 Checking transcript for triggers:');
            console.log('  - New final transcript (PRIORITY):', `"${newFinalLower}"`);
            console.log('  - Full accumulated transcript:', `"${fullTranscript}"`);
            console.log('  - Available triggers:', this.triggerPhrases.map(t => `"${t.phrase}"`));
            
            // Debug: Check if "the peacock" appears anywhere
            if (newFinalLower.includes('peacock') || fullTranscript.includes('peacock')) {
                console.warn('⚠️ WARNING: Found "peacock" in transcript!');
                console.warn('   - In new final:', newFinalLower.includes('peacock'));
                console.warn('   - In full:', fullTranscript.includes('peacock'));
            } else {
                console.log('✓ Confirmed: "peacock" NOT in transcript');
            }
            
            // First, check the NEW final transcript chunk (most recent speech)
            // This ensures we match what was just said, not old text
            let matchedTrigger = null;
            let matchFoundInNew = false;
            
            // Check new final transcript first (highest priority)
            // Use strict matching - only match complete phrases, not partial words
            for (const trigger of this.triggerPhrases) {
                const triggerLower = trigger.phrase.toLowerCase().trim();
                
                // Method 1: Exact phrase match (most reliable)
                // Check if transcript contains the complete trigger phrase as a substring
                if (newFinalLower.includes(triggerLower)) {
                    matchedTrigger = trigger;
                    matchFoundInNew = true;
                    console.log(`✅ MATCH FOUND (exact phrase) in NEW transcript! Trigger: "${trigger.phrase}"`);
                    console.log(`   - Found in: "${newFinalLower}"`);
                    break;
                }
                
                // Method 2: Word boundary match (more flexible but still strict)
                // Match all words of the trigger phrase in order, but allow word boundaries
                const newWords = newFinalLower.split(/\s+/).map(w => w.replace(/[.,!?;:]/g, '').toLowerCase());
                const triggerWords = triggerLower.split(/\s+/).map(tw => tw.replace(/[.,!?;:]/g, '').toLowerCase());
                
                // Find if all trigger words appear in order in the transcript
                let wordIndex = 0;
                let allWordsFound = true;
                for (const triggerWord of triggerWords) {
                    let found = false;
                    // Look for this word starting from where we left off
                    for (let i = wordIndex; i < newWords.length; i++) {
                        const word = newWords[i];
                        // Exact word match (not partial)
                        if (word === triggerWord) {
                            found = true;
                            wordIndex = i + 1; // Move to next position
                            break;
                        }
                    }
                    if (!found) {
                        allWordsFound = false;
                        break;
                    }
                }
                
                if (allWordsFound && triggerWords.length > 0) {
                    matchedTrigger = trigger;
                    matchFoundInNew = true;
                    console.log(`✅ MATCH FOUND (word sequence) in NEW transcript! Trigger: "${trigger.phrase}"`);
                    console.log(`   - Words matched in order: ${triggerWords.join(' -> ')}`);
                    break;
                }
            }
            
            // If no match in new transcript, check full transcript (fallback)
            // But only check the recent portion to avoid matching old triggers
            if (!matchedTrigger) {
                // Only check the last portion of the transcript (last 200 characters)
                const recentTranscript = fullTranscript.slice(-200).toLowerCase();
                
                for (const trigger of this.triggerPhrases) {
                    const triggerLower = trigger.phrase.toLowerCase().trim();
                    
                    // Only check recent portion of transcript
                    if (recentTranscript.includes(triggerLower)) {
                        matchedTrigger = trigger;
                        console.log(`✅ MATCH FOUND in recent transcript! Trigger: "${trigger.phrase}"`);
                        console.log(`   - Found in recent portion: "${recentTranscript}"`);
                        break;
                    }
                }
            }
            
            if (matchedTrigger) {
                // Double-check: Verify the trigger phrase actually exists in the transcript
                const triggerLower = matchedTrigger.phrase.toLowerCase().trim();
                const actuallyInTranscript = newFinalLower.includes(triggerLower) || 
                                            fullTranscript.slice(-200).includes(triggerLower);
                
                if (!actuallyInTranscript) {
                    console.error('❌ ERROR: Trigger matched but phrase not found in transcript!');
                    console.error('   - Matched trigger:', matchedTrigger.phrase);
                    console.error('   - New transcript:', newFinalLower);
                    console.error('   - This should not happen - skipping trigger');
                    matchedTrigger = null; // Don't use this match
                } else {
                    // Trigger phrase detected - log it
                    if (!this.triggerDetectedInCurrentSession || matchFoundInNew) {
                        this.detectedTrigger = matchedTrigger;
                        this.handleTriggerDetected(newFinalLower, matchedTrigger.phrase);
                        this.triggerDetectedInCurrentSession = true;
                        console.log('📝 Trigger logged in trigger events');
                    }
                }
            }
            
            if (matchedTrigger) {
                // Clear transcript history immediately when trigger is detected
                // This prevents the same trigger from being detected again from accumulated transcript
                console.log('🧹 Clearing transcript history after trigger detection:', matchedTrigger.phrase);
                this.currentTranscript = '';
                this.words = [];
                this.pendingFinalTranscript = ''; // Clear buffered transcript too
                this.transcriptDiv.innerHTML = '';
                
                // If no interim results, we might be pausing - start timer
                if (!hasInterimResult) {
                    this.resetPauseTimer();
                    console.log(`⏱️ Starting pause timer (${this.pauseDuration}ms) for trigger: "${matchedTrigger.phrase}"`);
                    this.pauseTimer = setTimeout(() => {
                        if (this.isListening && !this.isPlaying) {
                            console.log('⏱️ Pause timer expired, playing audio for:', matchedTrigger.phrase);
                            this.playAudioForTrigger(matchedTrigger);
                            this.triggerDetectedInCurrentSession = false;
                            this.detectedTrigger = null;
                        } else {
                            console.log('⚠️ Cannot play audio - isListening:', this.isListening, 'isPlaying:', this.isPlaying);
                        }
                    }, this.pauseDuration);
                } else {
                    console.log('⏸️ Still speaking (interim results), waiting for pause...');
                }
            } else {
                // No trigger in this chunk, reset trigger flag
                console.log('❌ No trigger match found');
                console.log('   - Checked new transcript:', newFinalLower);
                this.triggerDetectedInCurrentSession = false;
                this.detectedTrigger = null;
            }
        }
    }

    processFinalTranscript(text) {
        // This method processes final transcript chunks
        // Trigger detection and pause handling is now done in handleRecognitionResult
        // to better track the flow of speech
    }

    handleTriggerDetected(transcript, triggerPhrase) {
        const timestamp = new Date().toLocaleTimeString();
        this.addTriggerLog(timestamp, transcript, triggerPhrase);
    }

    handlePause() {
        // This method is called when speech pauses
        // The pause detection is handled by the pause timer in handleTriggerDetected
        // This is kept for potential future enhancements
    }

    resetPauseTimer() {
        if (this.pauseTimer) {
            clearTimeout(this.pauseTimer);
            this.pauseTimer = null;
        }
        // Also clear pause check timer when resetting
        if (this.pauseCheckTimer) {
            clearTimeout(this.pauseCheckTimer);
            this.pauseCheckTimer = null;
        }
    }

    async playAudioForTrigger(trigger) {
        if (this.isPlaying) {
            console.log('Already playing audio, skipping');
            return;
        }

        console.log('Playing audio for trigger:', trigger.phrase, 'Audio URL:', trigger.audioUrl);

        if (!trigger.audioUrl) {
            console.warn('No audio file associated with trigger:', trigger.phrase);
            // Fallback to text-to-speech if no audio file
            await this.speakResponse(trigger.phrase);
            // Clear transcript after text-to-speech
            this.currentTranscript = '';
            this.words = [];
            this.transcriptDiv.innerHTML = '';
            console.log('🧹 Transcript cleared after text-to-speech');
            return;
        }

        this.isPlaying = true;
        this.updateStatus('Playing audio...', 'playing');
        
        // Stop listening temporarily
        if (this.isListening) {
            this.pauseListening();
        }

        try {
            // Pass trigger ID to use cached audio element (iOS compatibility)
            await this.playAudioFile(trigger.audioUrl, trigger.id);
        } catch (error) {
            console.error('Error playing audio:', error);
            // Fallback to text-to-speech on error
            await this.speakResponse(trigger.phrase);
        } finally {
            // Resume listening after playback
            this.isPlaying = false;
            
            // Clear transcript after audio plays
            this.currentTranscript = '';
            this.words = [];
            this.transcriptDiv.innerHTML = '';
            console.log('🧹 Transcript cleared after audio playback');
            
            if (this.isListening) {
                this.updateStatus('Listening...', 'listening');
                this.resumeListening();
            } else {
                this.updateStatus('Ready', 'ready');
            }
        }
    }

    async playAudioFile(audioUrl, triggerId = null) {
        return new Promise(async (resolve, reject) => {
            // Ensure audio context is resumed
            if (this.audioContext && this.audioContext.state === 'suspended') {
                try {
                    await this.audioContext.resume();
                } catch (e) {
                    console.warn('Could not resume audio context:', e);
                }
            }

            // For iOS: Use cached audio element if available
            let audio = null;
            console.log(`Attempting to play audio: ${audioUrl}, triggerId: ${triggerId}`);
            console.log(`Audio elements cache size: ${this.audioElements.size}`);
            
            if (triggerId && this.audioElements.has(triggerId)) {
                audio = this.audioElements.get(triggerId);
                console.log(`✅ Using cached audio element for trigger ID: ${triggerId}, phrase: ${audio._triggerPhrase || 'unknown'}`);
                
                // Ensure audio is unlocked (should already be unlocked from startListening)
                if (!audio._unlocked && !audio._unlockAttempted) {
                    console.log('⚠️ Audio not unlocked, attempting unlock before playback...');
                    await this.unlockSingleAudioForIOS(audio, triggerId);
                    // Small delay to ensure unlock is complete
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                
                // Reset audio to beginning and ensure it's ready
                audio.currentTime = 0;
                audio.volume = 1;
                
                // Reload if needed to ensure it's ready
                if (audio.readyState < 2) {
                    console.log('Reloading audio element...');
                    audio.load();
                }
                
                console.log('Using cached audio element, readyState:', audio.readyState, 'unlocked:', audio._unlocked);
            } else {
                // Try to find audio by URL as fallback
                console.warn(`⚠️ Audio element not found for triggerId: ${triggerId}`);
                console.log('Available trigger IDs:', Array.from(this.audioElements.keys()));
                
                // Try to find by URL
                let foundAudio = null;
                for (const [id, cachedAudio] of this.audioElements.entries()) {
                    if (cachedAudio.src === audioUrl || cachedAudio.src.endsWith(audioUrl)) {
                        foundAudio = cachedAudio;
                        console.log(`✅ Found audio element by URL match (ID: ${id})`);
                        break;
                    }
                }
                
                if (foundAudio) {
                    audio = foundAudio;
                    audio.currentTime = 0;
                    audio.volume = 1;
                    if (audio.readyState < 2) {
                        audio.load();
                    }
                } else {
                    // Create new audio element (shouldn't happen if preloading worked)
                    console.warn('⚠️ Creating new audio element (not pre-loaded) - this should not happen!');
                    audio = new Audio(audioUrl);
                    audio.preload = 'auto';
                    audio.volume = 1;
                    
                    // Try to unlock immediately if audio context is already unlocked
                    if (this.audioUnlocked) {
                        try {
                            audio.volume = 0;
                            await audio.load();
                            await new Promise(resolve => {
                                if (audio.readyState >= 2) {
                                    resolve();
                                } else {
                                    audio.addEventListener('canplay', resolve, { once: true });
                                    setTimeout(resolve, 2000);
                                }
                            });
                            await audio.play();
                            audio.pause();
                            audio.currentTime = 0;
                            audio.volume = 1;
                            audio._unlocked = true;
                            console.log('✅ New audio element unlocked');
                        } catch (e) {
                            console.warn('Could not unlock new audio element:', e);
                        }
                    }
                }
            }
            
            // Set up event handlers
            const onEnded = () => {
                setTimeout(resolve, 500); // Small delay before resuming
            };
            
            const onError = (error) => {
                console.error('Audio playback error:', error, 'URL:', audioUrl);
                console.error('Audio error details:', {
                    code: audio.error?.code,
                    message: audio.error?.message,
                    networkState: audio.networkState,
                    readyState: audio.readyState
                });
                reject(error);
            };

            // For cached audio elements, clone the handlers to avoid conflicts
            // Add new listeners (old ones with {once: true} auto-remove)
            audio.addEventListener('ended', onEnded, { once: true });
            audio.addEventListener('error', onError, { once: true });

            // Try to play when ready
            const tryPlay = async () => {
                try {
                    // For iOS: Ensure audio is ready
                    if (audio.readyState < 2) {
                        console.log('Audio not ready, waiting... readyState:', audio.readyState);
                        await new Promise((res) => {
                            if (audio.readyState >= 2) {
                                res();
                            } else {
                                audio.addEventListener('canplay', () => {
                                    console.log('Audio can now play');
                                    res();
                                }, { once: true });
                                audio.addEventListener('canplaythrough', () => {
                                    console.log('Audio can play through');
                                    res();
                                }, { once: true });
                                // Timeout after 3 seconds
                                setTimeout(() => {
                                    console.log('Audio load timeout, attempting to play anyway');
                                    res();
                                }, 3000);
                            }
                        });
                    }
                    
                    // Ensure audio context is resumed
                    if (this.audioContext && this.audioContext.state === 'suspended') {
                        await this.audioContext.resume();
                        console.log('Audio context resumed');
                    }
                    
                    // For cached audio elements, ensure they're reset
                    if (triggerId && this.audioElements.has(triggerId)) {
                        audio.currentTime = 0;
                        audio.volume = 1;
                    }
                    
                    console.log('Attempting to play audio, readyState:', audio.readyState, 'unlocked:', audio._unlocked);
                    
                    // For iOS: If audio is not unlocked, try to unlock it now
                    // (This shouldn't happen if unlockAudioForIOS worked, but just in case)
                    if (!audio._unlocked && !audio._unlockAttempted) {
                        console.warn('⚠️ Audio not unlocked, attempting emergency unlock...');
                        try {
                            audio.volume = 0;
                            await audio.play();
                            audio.pause();
                            audio.currentTime = 0;
                            audio.volume = 1;
                            audio._unlocked = true;
                            console.log('✅ Emergency unlock successful');
                        } catch (unlockErr) {
                            console.error('❌ Emergency unlock failed:', unlockErr);
                        }
                    }
                    
                    const playPromise = audio.play();
                    if (playPromise !== undefined) {
                        await playPromise;
                    }
                    console.log('✅ Audio playing successfully:', audioUrl);
                } catch (playError) {
                    console.error('❌ Error playing audio:', playError);
                    console.error('Audio state:', {
                        readyState: audio.readyState,
                        networkState: audio.networkState,
                        paused: audio.paused,
                        currentTime: audio.currentTime,
                        error: audio.error
                    });
                    
                    // If play fails with NotAllowedError, try to unlock and retry
                    if (playError.name === 'NotAllowedError' || playError.name === 'NotSupportedError') {
                        console.warn('NotAllowedError - attempting to unlock audio...');
                        
                        // Try to unlock this specific audio element
                        if (triggerId && this.audioElements.has(triggerId)) {
                            const audioToUnlock = this.audioElements.get(triggerId);
                            if (!audioToUnlock._unlocked) {
                                try {
                                    console.log('Unlocking audio element on-demand...');
                                    audioToUnlock.volume = 0;
                                    if (audioToUnlock.readyState < 2) {
                                        audioToUnlock.load();
                                        await new Promise(resolve => {
                                            if (audioToUnlock.readyState >= 2) {
                                                resolve();
                                            } else {
                                                audioToUnlock.addEventListener('canplay', resolve, { once: true });
                                                setTimeout(resolve, 2000);
                                            }
                                        });
                                    }
                                    await audioToUnlock.play();
                                    audioToUnlock.pause();
                                    audioToUnlock.currentTime = 0;
                                    audioToUnlock.volume = 1;
                                    audioToUnlock._unlocked = true;
                                    console.log('✅ Audio unlocked on-demand');
                                    
                                    // Now try playing again
                                    audio.currentTime = 0;
                                    await audio.play();
                                    console.log('✅ Audio playing after on-demand unlock:', audioUrl);
                                    return; // Success!
                                } catch (unlockError) {
                                    console.error('On-demand unlock failed:', unlockError);
                                }
                            }
                        }
                        
                        // Try to resume audio context
                        if (this.audioContext && this.audioContext.state === 'suspended') {
                            try {
                                await this.audioContext.resume();
                                console.log('Audio context resumed, retrying play...');
                                // Reset and retry
                                audio.currentTime = 0;
                                await audio.play();
                                console.log('✅ Audio playing after context resume:', audioUrl);
                                return; // Success!
                            } catch (retryError) {
                                console.error('Retry failed:', retryError);
                            }
                        }
                        
                        // If all retries failed, reject
                        console.error('All audio playback attempts failed, rejecting...');
                        reject(playError);
                    } else {
                        reject(playError);
                    }
                }
            };

            // If audio can play through, play it
            if (audio.readyState >= 2) {
                tryPlay();
            } else {
                audio.addEventListener('canplaythrough', () => tryPlay(), { once: true });
                audio.addEventListener('loadeddata', () => {
                    if (audio.readyState >= 2) {
                        tryPlay();
                    }
                }, { once: true });
                // Load the audio
                audio.load();
            }
        });
    }

    async speakResponse(phrase) {
        // Fallback text-to-speech when no audio file is available
        return new Promise((resolve) => {
            const utterance = new SpeechSynthesisUtterance();
            utterance.text = `Trigger phrase detected: ${phrase}`;
            utterance.lang = 'en-US';
            utterance.rate = 1.0;
            utterance.pitch = 1.0;
            utterance.volume = 1.0;

            utterance.onend = () => {
                setTimeout(resolve, 500);
            };

            utterance.onerror = (error) => {
                console.error('Speech synthesis error:', error);
                resolve();
            };

            window.speechSynthesis.speak(utterance);
        });
    }

    pauseListening() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (this.recognizer instanceof SpeechRecognition) {
            if (typeof this.recognizer.stop === 'function') {
                this.recognizer.stop();
            }
        }
    }

    resumeListening() {
        console.log('Resuming listening...', { isListening: this.isListening, isPlaying: this.isPlaying });
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (this.recognizer instanceof SpeechRecognition) {
            if (typeof this.recognizer.start === 'function') {
                setTimeout(() => {
                    if (this.isListening && !this.isPlaying) {
                        try {
                            this.recognizer.start();
                            console.log('✅ Listening resumed');
                        } catch (e) {
                            console.error('Error resuming listening:', e);
                            // If start fails (e.g., already started), that's okay
                            if (e.name !== 'InvalidStateError') {
                                console.warn('Unexpected error resuming:', e);
                            }
                        }
                    } else {
                        console.log('Cannot resume - isListening:', this.isListening, 'isPlaying:', this.isPlaying);
                    }
                }, 500); // Increased delay to ensure audio playback is complete
            }
        } else {
            console.warn('Recognizer is not a SpeechRecognition instance, cannot resume');
        }
    }

    async startListening() {
        if (this.isListening || !this.recognizer) return;

        try {
            // CRITICAL: Unlock audio on user interaction (iOS requirement)
            // This MUST happen synchronously during the click event
            // Only unlock once, and do it silently
            if (!this.audioUnlocked) {
                console.log('Unlocking audio elements (silent unlock for iOS)...');
                try {
                    // Unlock immediately - no delays to maintain user interaction context
                    await this.unlockAudioForIOS();
                    this.audioUnlocked = true;
                    console.log('✅ All audio elements unlocked');
                } catch (e) {
                    console.warn('Error unlocking audio:', e);
                    // Continue anyway - some audio might still work
                }
            }
            
            // Resume audio context if suspended
            if (this.audioContext && this.audioContext.state === 'suspended') {
                try {
                    await this.audioContext.resume();
                    console.log('✅ Audio context resumed');
                } catch (e) {
                    console.warn('Could not resume audio context:', e);
                }
            }

            this.isListening = true;
            this.updateStatus('Starting...', 'listening');
            this.startBtn.disabled = true;
            this.stopBtn.disabled = false;
            this.lastSpeechTime = Date.now();

            // Use Web Speech API
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (this.recognizer instanceof SpeechRecognition) {
                this.recognizer.start();
            } else {
                throw new Error('Recognizer not properly initialized');
            }

            this.updateStatus('Listening...', 'listening');
        } catch (error) {
            console.error('Error starting recognition:', error);
            this.updateStatus('Error starting', 'error');
            this.isListening = false;
            this.startBtn.disabled = false;
            this.stopBtn.disabled = true;
        }
    }


    stopListening() {
        this.isListening = false;
        this.updateStatus('Stopped', 'ready');
        this.startBtn.disabled = false;
        this.stopBtn.disabled = true;
        this.resetPauseTimer();

        if (this.recognizer && typeof this.recognizer.stop === 'function') {
            this.recognizer.stop();
        }
    }

    updateTranscript(final, interim) {
        // Only update transcript when we have final results (after pause)
        // Don't show interim results - wait for complete sentences
        if (final && final.trim()) {
            this.currentTranscript += final.trim() + ' ';
            this.words = this.currentTranscript.trim().split(/\s+/).filter(w => w.length > 0);
            console.log('Final transcript added:', final.trim());
            console.log('Current full transcript:', this.currentTranscript.trim());
        }

        // Build HTML display - only show final words (complete sentences)
        // No interim results shown - they will appear when finalized after pause
        let html = '';
        
        // Display all final words
        this.words.forEach((word, index) => {
            const wordLower = word.toLowerCase().replace(/[.,!?]/g, '');
            let className = 'word';
            
            // Check if this word is part of any trigger phrase
            const isPartOfTrigger = this.triggerPhrases.some(trigger => {
                const triggerWords = trigger.phrase.toLowerCase().split(' ');
                return triggerWords.some(tw => tw === wordLower || wordLower.includes(tw) || tw.includes(wordLower));
            });
            
            if (isPartOfTrigger) {
                className += ' trigger';
            }
            
            html += `<span class="${className}">${word}</span>`;
        });

        // Don't show interim results - wait for them to become final after pause

        this.transcriptDiv.innerHTML = html;
        this.transcriptDiv.scrollTop = this.transcriptDiv.scrollHeight;
    }

    addTriggerLog(timestamp, transcript, triggerPhrase) {
        const logEntry = document.createElement('div');
        logEntry.className = 'trigger-event';
        logEntry.innerHTML = `
            <time>${timestamp}</time>
            <div class="phrase">Trigger detected: "${triggerPhrase}"</div>
            <div class="transcript">Transcript: "${transcript}"</div>
        `;
        this.triggerLog.insertBefore(logEntry, this.triggerLog.firstChild);
        
        // Keep only last 10 entries
        while (this.triggerLog.children.length > 10) {
            this.triggerLog.removeChild(this.triggerLog.lastChild);
        }
    }

    clearTranscript() {
        this.transcriptDiv.innerHTML = '';
        this.currentTranscript = '';
        this.words = [];
        this.triggerLog.innerHTML = '';
        this.triggerDetectedInCurrentSession = false;
        this.detectedTrigger = null;
        this.lastProcessedResultIndex = -1; // Reset result tracking
        this.pendingFinalTranscript = ''; // Clear pending buffer
        this.resetPauseTimer();
    }

    updateStatus(text, state) {
        this.statusText.textContent = text;
        this.statusDot.className = 'status-dot ' + state;
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new SpeechRecognitionApp();
});

