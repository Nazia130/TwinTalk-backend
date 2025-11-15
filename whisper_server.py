import os
import subprocess
import whisper
from flask import Flask, request, jsonify
from flask_cors import CORS
import base64
import tempfile
import logging

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Test FFmpeg availability
try:
    result = subprocess.run(['ffmpeg', '-version'], capture_output=True, text=True)
    if result.returncode == 0:
        logger.info("✅ FFmpeg is available")
    else:
        logger.error("❌ FFmpeg not working")
except Exception as e:
    logger.error(f"❌ FFmpeg test failed: {e}")

app = Flask(__name__)
CORS(app)

class WhisperTranscriber:
    def __init__(self, model_size="base"):
        self.model_size = model_size
        self.model = None
        self.is_loaded = False
        
    def load_model(self):
        """Load Whisper model - call this once at startup"""
        try:
            logger.info(f"🚀 Loading Whisper model: {self.model_size}")
            self.model = whisper.load_model(self.model_size)
            self.is_loaded = True
            logger.info("✅ Whisper model loaded successfully")
            return True
        except Exception as e:
            logger.error(f"❌ Failed to load Whisper model: {str(e)}")
            self.is_loaded = False
            return False
    
    def transcribe_webm_base64(self, audio_data_url):
        """
        Transcribe base64 WebM audio data using Whisper
        """
        try:
            if not self.is_loaded or self.model is None:
                if not self.load_model():
                    return {
                        'success': False,
                        'error': 'Whisper model failed to load',
                        'text': ''
                    }
            
            # Extract base64 data
            if 'base64,' in audio_data_url:
                audio_data = audio_data_url.split('base64,')[1]
            else:
                audio_data = audio_data_url
            
            audio_bytes = base64.b64decode(audio_data)
            
            logger.info(f"📊 Audio data size: {len(audio_bytes)} bytes")
            
            # Create temporary file
            with tempfile.NamedTemporaryFile(delete=False, suffix='.webm') as temp_file:
                temp_file.write(audio_bytes)
                temp_path = temp_file.name
            
            logger.info(f"🎵 Starting transcription for: {temp_path}")
            
            # Transcribe using Whisper
            result = self.model.transcribe(temp_path)
            
            # Clean up temporary file
            os.unlink(temp_path)
            
            transcription_text = result.get('text', '').strip()
            
            logger.info(f"✅ Transcription completed: {len(transcription_text)} characters")
            
            return {
                'success': True,
                'text': transcription_text,
                'language': result.get('language', 'en'),
                'model': self.model_size
            }
            
        except Exception as e:
            logger.error(f"❌ Transcription error: {str(e)}")
            # Clean up temp file if it exists
            try:
                if 'temp_path' in locals():
                    os.unlink(temp_path)
            except:
                pass
            
            return {
                'success': False,
                'error': str(e),
                'text': ''
            }

# Global transcriber instance
transcriber = WhisperTranscriber("base")

@app.route('/api/transcribe', methods=['POST'])
def transcribe_endpoint():
    """Transcription endpoint using offline Whisper"""
    try:
        data = request.get_json()
        
        if not data or 'audioData' not in data:
            return jsonify({
                'success': False,
                'error': 'No audio data provided'
            })
        
        audio_data = data['audioData']
        recording_id = data.get('recordingId', 'unknown')
        
        logger.info(f"🔄 Transcribing recording: {recording_id}")
        
        # Perform offline transcription
        result = transcriber.transcribe_webm_base64(audio_data)
        
        return jsonify(result)
        
    except Exception as e:
        logger.error(f"❌ Server error: {str(e)}")
        return jsonify({
            'success': False,
            'error': f'Server error: {str(e)}'
        })

@app.route('/api/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    status = "loaded" if transcriber.is_loaded else "loading"
    return jsonify({
        'status': 'healthy',
        'service': 'offline-whisper',
        'model': transcriber.model_size,
        'model_status': status
    })

if __name__ == '__main__':
    print("🚀 Starting Offline Whisper Transcription Server")
    print("📝 Model: whisper-base (100% offline, no API keys)")
    print("🔊 Endpoint: http://localhost:5001/api/transcribe")
    print("💡 FFmpeg status: Check logs above")
    
    # Pre-load the model on startup
    transcriber.load_model()
    
    app.run(debug=True, port=5001, host='0.0.0.0')