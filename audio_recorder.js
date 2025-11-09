// audio_recorder.js - Client-side audio recording for TwinTalk
class AudioRecorder {
    constructor() {
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.isRecording = false;
        this.socket = null;
        this.roomId = null;
        this.userName = null;
        this.recordingInterval = null;
    }

    // Initialize the recorder with socket connection
    initialize(socket, roomId, userName) {
        this.socket = socket;
        this.roomId = roomId;
        this.userName = userName;
        console.log("🎙️ Audio recorder initialized for:", userName, "in room:", roomId);
    }

    // Start recording audio
    async startRecording() {
        try {
            console.log("🎙️ Starting audio recording...");
            
            // Request microphone access
            const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    sampleRate: 16000,
                    channelCount: 1
                } 
            });

            // Create MediaRecorder with WAV format
            const options = {
                mimeType: 'audio/webm;codecs=opus',
                audioBitsPerSecond: 128000
            };

            this.mediaRecorder = new MediaRecorder(stream, options);
            this.audioChunks = [];

            // Handle data available event
            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    this.audioChunks.push(event.data);
                    this.sendAudioChunk(event.data);
                }
            };

            // Handle recording stop
            this.mediaRecorder.onstop = () => {
                console.log("⏹️ Audio recording stopped");
                this.saveRecording();
                this.cleanup();
            };

            // Start recording
            this.mediaRecorder.start(1000); // Collect data every 1 second
            this.isRecording = true;

            // Set up periodic sending
            this.recordingInterval = setInterval(() => {
                if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
                    this.mediaRecorder.requestData();
                }
            }, 1000);

            console.log("✅ Audio recording started successfully");

        } catch (error) {
            console.error("❌ Failed to start audio recording:", error);
            throw error;
        }
    }

    // Convert blob to base64 and send via socket
    async sendAudioChunk(audioBlob) {
        if (!this.socket || !this.isRecording) return;

        try {
            const base64Data = await this.blobToBase64(audioBlob);
            
            // Send audio chunk to server
            this.socket.emit("audio-chunk", {
                roomId: this.roomId,
                audio: base64Data,
                userName: this.userName,
                timestamp: Date.now()
            });

        } catch (error) {
            console.error("❌ Failed to send audio chunk:", error);
        }
    }

    // Convert blob to base64
    blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                // Remove data URL prefix
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    // Stop recording
    stopRecording() {
        if (this.mediaRecorder && this.isRecording) {
            this.mediaRecorder.stop();
            this.isRecording = false;
            
            if (this.recordingInterval) {
                clearInterval(this.recordingInterval);
                this.recordingInterval = null;
            }
            
            console.log("🛑 Audio recording stop requested");
        }
    }

    // Save final recording
    async saveRecording() {
        if (this.audioChunks.length === 0) {
            console.log("⚠️ No audio data to save");
            return;
        }

        try {
            const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
            const audioUrl = URL.createObjectURL(audioBlob);
            
            // Create download link (optional - for debugging)
            this.createDownloadLink(audioUrl);
            
            console.log("💾 Recording saved locally, URL:", audioUrl);
            
        } catch (error) {
            console.error("❌ Failed to save recording:", error);
        }
    }

    // Create download link for testing
    createDownloadLink(audioUrl) {
        const a = document.createElement('a');
        a.href = audioUrl;
        a.download = `recording-${this.roomId}-${Date.now()}.webm`;
        a.textContent = 'Download Recording';
        a.style.display = 'none';
        
        document.body.appendChild(a);
        // Note: Auto-download might be blocked by browsers
        setTimeout(() => {
            document.body.removeChild(a);
        }, 1000);
    }

    // Clean up resources
    cleanup() {
        if (this.mediaRecorder && this.mediaRecorder.stream) {
            this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
        }
        
        this.audioChunks = [];
        this.isRecording = false;
        
        if (this.recordingInterval) {
            clearInterval(this.recordingInterval);
            this.recordingInterval = null;
        }
        
        console.log("🧹 Audio recorder cleaned up");
    }

    // Get recording status
    getStatus() {
        return {
            isRecording: this.isRecording,
            roomId: this.roomId,
            userName: this.userName
        };
    }

    // Check if browser supports recording
    static isSupported() {
        return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && MediaRecorder);
    }

    // Get available audio formats
    static getSupportedMimeTypes() {
        const types = [
            'audio/webm',
            'audio/webm;codecs=opus',
            'audio/mp4',
            'audio/ogg;codecs=opus'
        ];
        
        return types.filter(type => {
            return MediaRecorder.isTypeSupported(type);
        });
    }
}

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AudioRecorder;
} else {
    window.AudioRecorder = AudioRecorder;
}