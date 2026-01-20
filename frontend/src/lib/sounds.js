// Sound effects using Web Audio API
class SoundManager {
  constructor() {
    this.audioContext = null;
    this.enabled = true;
    this.volume = 0.3;
    
    // Load preference from localStorage
    const savedEnabled = localStorage.getItem('csvSoundsEnabled');
    if (savedEnabled !== null) {
      this.enabled = JSON.parse(savedEnabled);
    }
  }

  getContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return this.audioContext;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    localStorage.setItem('csvSoundsEnabled', JSON.stringify(enabled));
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
  }

  // Play a tone with given frequency and duration
  playTone(frequency, duration = 0.1, type = 'sine') {
    if (!this.enabled) return;
    
    try {
      const ctx = this.getContext();
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);
      
      oscillator.frequency.value = frequency;
      oscillator.type = type;
      
      gainNode.gain.setValueAtTime(this.volume, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
      
      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + duration);
    } catch (e) {
      console.warn('Sound playback failed:', e);
    }
  }

  // Play a sequence of tones
  playSequence(notes, interval = 0.1) {
    if (!this.enabled) return;
    
    notes.forEach((note, index) => {
      setTimeout(() => {
        this.playTone(note.freq, note.duration || 0.1, note.type || 'sine');
      }, index * interval * 1000);
    });
  }

  // Predefined sounds
  click() {
    this.playTone(800, 0.05, 'square');
  }

  hover() {
    this.playTone(600, 0.03, 'sine');
  }

  success() {
    this.playSequence([
      { freq: 523, duration: 0.1 },  // C5
      { freq: 659, duration: 0.1 },  // E5
      { freq: 784, duration: 0.15 }, // G5
    ], 0.1);
  }

  error() {
    this.playSequence([
      { freq: 200, duration: 0.15, type: 'sawtooth' },
      { freq: 150, duration: 0.2, type: 'sawtooth' },
    ], 0.15);
  }

  warning() {
    this.playSequence([
      { freq: 440, duration: 0.1 },
      { freq: 440, duration: 0.1 },
    ], 0.15);
  }

  upload() {
    this.playTone(440, 0.1, 'sine');
  }

  uploadComplete() {
    this.playSequence([
      { freq: 392, duration: 0.08 },  // G4
      { freq: 523, duration: 0.08 },  // C5
      { freq: 659, duration: 0.08 },  // E5
      { freq: 784, duration: 0.15 },  // G5
    ], 0.08);
  }

  processing() {
    this.playTone(300, 0.05, 'triangle');
  }

  log() {
    this.playTone(1000, 0.02, 'sine');
  }

  logError() {
    this.playTone(200, 0.08, 'square');
  }

  logWarning() {
    this.playTone(400, 0.05, 'triangle');
  }

  delete() {
    this.playSequence([
      { freq: 400, duration: 0.08, type: 'square' },
      { freq: 300, duration: 0.1, type: 'square' },
    ], 0.08);
  }

  toggle() {
    this.playTone(600, 0.04, 'sine');
  }

  notification() {
    this.playSequence([
      { freq: 880, duration: 0.1 },
      { freq: 1100, duration: 0.15 },
    ], 0.1);
  }
}

// Export singleton instance
const soundManager = new SoundManager();
export default soundManager;
