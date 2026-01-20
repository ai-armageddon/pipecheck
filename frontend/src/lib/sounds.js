// Sound effects using Web Audio API - Pleasant UI sounds
class SoundManager {
  constructor() {
    this.audioContext = null;
    this.enabled = true;
    this.volume = 0.15; // Lower volume for subtlety
    
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

  // Play a soft tone with envelope for pleasant sound
  playTone(frequency, duration = 0.1, type = 'sine', attack = 0.01, decay = 0.05) {
    if (!this.enabled) return;
    
    try {
      const ctx = this.getContext();
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);
      
      oscillator.frequency.value = frequency;
      oscillator.type = type;
      
      // Smooth envelope for pleasant sound
      const now = ctx.currentTime;
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(this.volume, now + attack);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + duration);
      
      oscillator.start(now);
      oscillator.stop(now + duration);
    } catch (e) {
      console.warn('Sound playback failed:', e);
    }
  }

  // Play a chord (multiple frequencies at once)
  playChord(frequencies, duration = 0.15) {
    if (!this.enabled) return;
    
    frequencies.forEach(freq => {
      this.playTone(freq, duration, 'sine', 0.01, 0.1);
    });
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

  // === UI Sounds ===
  
  // Soft click for buttons
  click() {
    this.playTone(1200, 0.04, 'sine');
  }

  // Subtle hover
  hover() {
    this.playTone(800, 0.02, 'sine');
  }

  // Success - pleasant ascending arpeggio
  success() {
    this.playSequence([
      { freq: 523, duration: 0.08 },  // C5
      { freq: 659, duration: 0.08 },  // E5
      { freq: 784, duration: 0.12 },  // G5
    ], 0.07);
  }

  // Error - soft descending tone
  error() {
    this.playSequence([
      { freq: 330, duration: 0.12 },  // E4
      { freq: 262, duration: 0.15 },  // C4
    ], 0.1);
  }

  // Warning - double beep
  warning() {
    this.playSequence([
      { freq: 523, duration: 0.08 },
      { freq: 523, duration: 0.08 },
    ], 0.12);
  }

  // Upload start - soft whoosh up
  upload() {
    this.playSequence([
      { freq: 400, duration: 0.06 },
      { freq: 600, duration: 0.06 },
      { freq: 800, duration: 0.08 },
    ], 0.05);
  }

  // Upload complete - triumphant chord
  uploadComplete() {
    this.playChord([523, 659, 784], 0.2); // C major chord
  }

  // Processing tick
  processing() {
    this.playTone(600, 0.03, 'sine');
  }

  // Log entry - very subtle
  log() {
    this.playTone(1000, 0.015, 'sine');
  }

  // Log error - soft low tone
  logError() {
    this.playTone(220, 0.06, 'sine');
  }

  // Log warning - medium tone
  logWarning() {
    this.playTone(440, 0.04, 'sine');
  }

  // Delete - descending notes
  delete() {
    this.playSequence([
      { freq: 600, duration: 0.06 },
      { freq: 400, duration: 0.08 },
    ], 0.06);
  }

  // Toggle switch
  toggle() {
    this.playTone(880, 0.03, 'sine');
  }

  // Notification - pleasant two-tone
  notification() {
    this.playSequence([
      { freq: 784, duration: 0.08 },  // G5
      { freq: 1047, duration: 0.1 },  // C6
    ], 0.08);
  }
}

// Export singleton instance
const soundManager = new SoundManager();
export default soundManager;
