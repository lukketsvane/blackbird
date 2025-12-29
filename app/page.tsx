"use client";

import type React from "react";
import { useState, useRef, useCallback } from "react";

export default function BlackbirdConverter() {
  const [state, setState] = useState<"idle" | "recording" | "processing" | "playing" | "uploading">("idle");
  const [audioLevel, setAudioLevel] = useState(0);
  const [processedBuffer, setProcessedBuffer] = useState<AudioBuffer | null>(null);
  const [mode, setMode] = useState<"encode" | "decode">("encode");
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationRef = useRef<number>(0);
  const lastTapRef = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Match exact Perl reference parameters
  const SAMPLE_RATE = 44100;
  const FSCALE = 24000;        // Frequency scaling factor from Perl
  const SHIFT_FREQ = -0.005;   // Baseband shift frequency from Perl
  const PHASE_MULT = 6;        // Phase multiplier: sin(phase * 6) from Perl
  
  // Steganographic embedding constants
  // The original voice is stored in a stereo file:
  // - Left channel: Birdsong (audible)
  // - Right channel: Original voice (for decoding)

  // Hilbert transform filter (90-degree phase shifter)
  const createHilbertFilter = (length: number): Float32Array => {
    const filter = new Float32Array(length);
    const mid = Math.floor(length / 2);
    for (let i = 0; i < length; i++) {
      const n = i - mid;
      if (n === 0) filter[i] = 0;
      else if (n % 2 !== 0) filter[i] = 2 / (Math.PI * n);
      else filter[i] = 0;
      // Hamming window
      filter[i] *= 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (length - 1));
    }
    return filter;
  };

  // Sinc lowpass filter with Blackman window
  const createSincFilter = (cutoffHz: number, length: number, sampleRate: number): Float32Array => {
    const filter = new Float32Array(length);
    const mid = Math.floor(length / 2);
    const fc = cutoffHz / sampleRate;
    for (let i = 0; i < length; i++) {
      const n = i - mid;
      if (n === 0) filter[i] = 2 * Math.PI * fc;
      else filter[i] = Math.sin(2 * Math.PI * fc * n) / n;
      // Blackman window for sharp cutoff
      filter[i] *= 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1)) + 
                  0.08 * Math.cos((4 * Math.PI * i) / (length - 1));
    }
    let sum = 0;
    for (let i = 0; i < length; i++) sum += filter[i];
    for (let i = 0; i < length; i++) filter[i] /= sum;
    return filter;
  };

  const convolve = (signal: Float32Array, filter: Float32Array): Float32Array => {
    const result = new Float32Array(signal.length);
    const filterLen = filter.length;
    const mid = Math.floor(filterLen / 2);
    for (let i = 0; i < signal.length; i++) {
      let sum = 0;
      for (let j = 0; j < filterLen; j++) {
        const idx = i - mid + j;
        if (idx >= 0 && idx < signal.length) sum += signal[idx] * filter[j];
      }
      result[i] = sum;
    }
    return result;
  };

  // Encode voice to birdsong with steganographic embedding
  // Creates a stereo file: Left = birdsong (audible), Right = original voice (for decoding)
  const encodeAudio = async (audioBuffer: AudioBuffer): Promise<AudioBuffer> => {
    const input = audioBuffer.getChannelData(0);
    const length = input.length;
    const rate = audioBuffer.sampleRate;

    const hilbert = createHilbertFilter(129);
    const lpf140 = createSincFilter(140, 1025, rate);
    const lpf70 = createSincFilter(70, 1025, rate);

    // Create analytic signal (real + j*hilbert)
    const realPart = new Float32Array(input);
    const imagPart = convolve(input, hilbert);

    // Shift to baseband: multiply by exp(j * 2π * SHIFT_FREQ * n)
    const shiftedI = new Float32Array(length);
    const shiftedQ = new Float32Array(length);
    const shiftOmega = 2 * Math.PI * SHIFT_FREQ;
    for (let i = 0; i < length; i++) {
      const phase = shiftOmega * i;
      const cosP = Math.cos(phase);
      const sinP = Math.sin(phase);
      shiftedI[i] = realPart[i] * cosP - imagPart[i] * sinP;
      shiftedQ[i] = realPart[i] * sinP + imagPart[i] * cosP;
    }

    // Filter at 140Hz to extract baseband signal
    const filteredI = convolve(shiftedI, lpf140);
    const filteredQ = convolve(shiftedQ, lpf140);

    // Shift back for FM demodulation
    const fmI = new Float32Array(length);
    const fmQ = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const phase = 2 * Math.PI * (-SHIFT_FREQ) * i;
      const cosP = Math.cos(phase);
      const sinP = Math.sin(phase);
      fmI[i] = filteredI[i] * cosP - filteredQ[i] * sinP;
      fmQ[i] = filteredI[i] * sinP + filteredQ[i] * cosP;
    }

    // FM demodulation - extract instantaneous frequency
    const fmDemod = new Float32Array(length);
    for (let i = 1; i < length; i++) {
      const cross = fmI[i] * fmQ[i - 1] - fmQ[i] * fmI[i - 1];
      const dot = fmI[i] * fmI[i - 1] + fmQ[i] * fmQ[i - 1];
      fmDemod[i] = Math.atan2(cross, dot);
    }
    fmDemod[0] = fmDemod[1];
    const fmFiltered = convolve(fmDemod, lpf70);

    // AM demodulation - extract envelope
    const amDemod = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      amDemod[i] = Math.sqrt(filteredI[i] * filteredI[i] + filteredQ[i] * filteredQ[i]);
    }
    const amFiltered = convolve(amDemod, lpf70);

    // Synthesize birdsong at scaled frequency
    const birdsong = new Float32Array(length);
    let phase = 0;
    for (let i = 0; i < length; i++) {
      const freq = (fmFiltered[i] * 2 * Math.PI) / rate;
      phase += freq * FSCALE;
      birdsong[i] = Math.sin(phase * PHASE_MULT) * amFiltered[i];
    }

    // Normalize birdsong
    let maxBird = 0;
    for (let i = 0; i < length; i++) {
      const abs = Math.abs(birdsong[i]);
      if (abs > maxBird) maxBird = abs;
    }
    if (maxBird > 0) {
      for (let i = 0; i < length; i++) birdsong[i] *= 0.9 / maxBird;
    }

    // Embed original voice at inaudible level (-60dB = 0.001 amplitude)
    const HIDDEN_AMPLITUDE = 0.001;
    const hiddenVoice = new Float32Array(length);
    let maxVoice = 0;
    for (let i = 0; i < length; i++) {
      const abs = Math.abs(input[i]);
      if (abs > maxVoice) maxVoice = abs;
    }
    if (maxVoice > 0) {
      for (let i = 0; i < length; i++) hiddenVoice[i] = input[i] * HIDDEN_AMPLITUDE / maxVoice;
    }

    // Create stereo buffer: Left = birdsong, Right = hidden voice (inaudible)
    const ctx = audioContextRef.current!;
    const outputBuffer = ctx.createBuffer(2, length, rate);
    outputBuffer.getChannelData(0).set(birdsong);     // Left: birdsong (audible)
    outputBuffer.getChannelData(1).set(hiddenVoice);  // Right: hidden voice at -60dB (inaudible)
    
    return outputBuffer;
  };

  // Decode birdsong back to voice
  // If stereo file (from our encoder), extracts the original voice from right channel
  // If mono file, falls back to signal processing reconstruction
  const decodeAudio = async (audioBuffer: AudioBuffer): Promise<AudioBuffer> => {
    const length = audioBuffer.length;
    const rate = audioBuffer.sampleRate;
    const ctx = audioContextRef.current!;
    
    // Check if this is a stereo file with embedded original voice at -60dB
    if (audioBuffer.numberOfChannels >= 2) {
      // Extract the hidden voice from the right channel
      const rightChannel = audioBuffer.getChannelData(1);

      // Check if right channel has meaningful audio (detect -60dB signal)
      let rightEnergy = 0;
      for (let i = 0; i < Math.min(length, 44100); i++) {
        rightEnergy += rightChannel[i] * rightChannel[i];
      }
      rightEnergy /= Math.min(length, 44100);

      // If right channel has audio (threshold for -60dB signal), amplify and use it
      if (rightEnergy > 0.0000001) {
        // Amplify the hidden voice back to audible level
        const amplifiedVoice = new Float32Array(length);
        let maxAmp = 0;
        for (let i = 0; i < length; i++) {
          const abs = Math.abs(rightChannel[i]);
          if (abs > maxAmp) maxAmp = abs;
        }
        if (maxAmp > 0) {
          for (let i = 0; i < length; i++) amplifiedVoice[i] = rightChannel[i] * 0.9 / maxAmp;
        }
        const outputBuffer = ctx.createBuffer(1, length, rate);
        outputBuffer.getChannelData(0).set(amplifiedVoice);
        return outputBuffer;
      }
    }
    
    // Fallback: mono file or empty right channel - use signal processing
    const input = audioBuffer.getChannelData(0);
    const hilbert = createHilbertFilter(129);
    const lpf70 = createSincFilter(70, 1025, rate);

    // Create analytic signal from birdsong
    const realPart = new Float32Array(input);
    const imagPart = convolve(input, hilbert);

    // FM demodulation to extract instantaneous frequency from birdsong
    const fmDemod = new Float32Array(length);
    for (let i = 1; i < length; i++) {
      const cross = realPart[i] * imagPart[i - 1] - imagPart[i] * realPart[i - 1];
      const dot = realPart[i] * realPart[i - 1] + imagPart[i] * imagPart[i - 1];
      fmDemod[i] = Math.atan2(cross, dot);
    }
    fmDemod[0] = fmDemod[1];

    // Median filter to remove spikes from FM demodulation
    const medianFiltered = new Float32Array(length);
    const windowSize = 5;
    const halfWindow = Math.floor(windowSize / 2);
    const samples = new Array<number>(windowSize);
    for (let i = 0; i < length; i++) {
      for (let j = 0; j < windowSize; j++) {
        const idx = Math.max(0, Math.min(length - 1, i - halfWindow + j));
        samples[j] = fmDemod[idx];
      }
      samples.sort((a, b) => a - b);
      medianFiltered[i] = samples[halfWindow];
    }

    // Smooth the frequency
    const fmFiltered = convolve(medianFiltered, lpf70);

    // AM demodulation to extract original envelope
    const amDemod = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      amDemod[i] = Math.sqrt(realPart[i] * realPart[i] + imagPart[i] * imagPart[i]);
    }
    const amFiltered = convolve(amDemod, lpf70);

    // Reconstruct voice (best effort for mono files without embedded data)
    const output = new Float32Array(length);
    let phase = 0;

    for (let i = 0; i < length; i++) {
      const originalFm = fmFiltered[i] * rate / (2 * Math.PI * FSCALE * PHASE_MULT);
      phase += originalFm;
      output[i] = Math.sin(phase) * amFiltered[i];
    }

    // Apply lowpass filter to remove high frequency artifacts
    const lpf4000 = createSincFilter(4000, 257, rate);
    const smoothed = convolve(output, lpf4000);

    // Normalize
    let maxAbs = 0;
    for (let i = 0; i < length; i++) {
      const abs = Math.abs(smoothed[i]);
      if (abs > maxAbs) maxAbs = abs;
    }
    if (maxAbs > 0) {
      for (let i = 0; i < length; i++) smoothed[i] *= 0.9 / maxAbs;
    }

    const outputBuffer = ctx.createBuffer(1, length, rate);
    outputBuffer.getChannelData(0).set(smoothed);
    return outputBuffer;
  };

  // Convert AudioBuffer to WAV format (supports mono and stereo)
  const audioBufferToWav = (buffer: AudioBuffer): ArrayBuffer => {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const numSamples = buffer.length;
    const bytesPerSample = 2; // 16-bit
    const dataSize = numSamples * numChannels * bytesPerSample;
    
    const wavBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(wavBuffer);
    
    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
    };
    
    // RIFF header
    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, "WAVE");
    
    // fmt chunk
    writeString(12, "fmt ");
    view.setUint32(16, 16, true); // chunk size
    view.setUint16(20, 1, true);  // audio format (PCM)
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // byte rate
    view.setUint16(32, numChannels * bytesPerSample, true); // block align
    view.setUint16(34, bytesPerSample * 8, true); // bits per sample
    
    // data chunk
    writeString(36, "data");
    view.setUint32(40, dataSize, true);
    
    // Interleave samples for stereo, direct write for mono
    let offset = 44;
    if (numChannels === 2) {
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      for (let i = 0; i < numSamples; i++) {
        // Left channel
        const l = Math.max(-1, Math.min(1, left[i]));
        view.setInt16(offset, l < 0 ? l * 0x8000 : l * 0x7fff, true);
        offset += 2;
        // Right channel
        const r = Math.max(-1, Math.min(1, right[i]));
        view.setInt16(offset, r < 0 ? r * 0x8000 : r * 0x7fff, true);
        offset += 2;
      }
    } else {
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
      }
    }
    
    return wavBuffer;
  };

  // Upload WAV to Vercel Blob storage
  const uploadToBlob = async (wavData: ArrayBuffer): Promise<string | null> => {
    try {
      const blob = new Blob([wavData], { type: "audio/wav" });
      const formData = new FormData();
      formData.append("file", blob, `chirp_${Date.now()}.wav`);

      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        console.error("Upload failed:", response.statusText);
        return null;
      }

      const data = await response.json();
      return data.url;
    } catch (err) {
      console.error("Upload error:", err);
      return null;
    }
  };

  // Copy URL to clipboard
  const copyToClipboard = async () => {
    if (!blobUrl) return;
    try {
      await navigator.clipboard.writeText(blobUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Copy failed:", err);
    }
  };

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: SAMPLE_RATE },
      });
      audioContextRef.current = new AudioContext({ sampleRate: SAMPLE_RATE });
      const analyser = audioContextRef.current.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;
      const source = audioContextRef.current.createMediaStreamSource(stream);
      source.connect(analyser);

      const updateLevel = () => {
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setAudioLevel(avg / 255);
        animationRef.current = requestAnimationFrame(updateLevel);
      };
      updateLevel();

      chunksRef.current = [];
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        cancelAnimationFrame(animationRef.current);
        stream.getTracks().forEach((t) => t.stop());
        setState("processing");

        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await audioContextRef.current!.decodeAudioData(arrayBuffer);

        const birdBuffer = await encodeAudio(audioBuffer);
        setProcessedBuffer(birdBuffer);
        setMode("encode");
        setBlobUrl(null); // Reset previous URL

        // Convert to WAV and upload to Vercel Blob
        const wavData = audioBufferToWav(birdBuffer);
        setState("uploading");
        const url = await uploadToBlob(wavData);
        if (url) {
          setBlobUrl(url);
        }

        // Create a mono buffer from just the left channel (birdsong) for playback
        // The full stereo buffer is kept for download (with embedded voice in right channel)
        const monoPlayback = audioContextRef.current!.createBuffer(1, birdBuffer.length, birdBuffer.sampleRate);
        monoPlayback.getChannelData(0).set(birdBuffer.getChannelData(0));

        setState("playing");
        const src = audioContextRef.current!.createBufferSource();
        src.buffer = monoPlayback;
        src.connect(audioContextRef.current!.destination);
        sourceRef.current = src;
        src.onended = () => { setState("idle"); setAudioLevel(0); };
        src.start();
      };

      mediaRecorder.start();
      setState("recording");
    } catch (err) {
      console.error("Mic access denied:", err);
    }
  }, []);

  const stopRecording = useCallback(() => { mediaRecorderRef.current?.stop(); }, []);
  const stopPlayback = useCallback(() => { sourceRef.current?.stop(); setState("idle"); setAudioLevel(0); }, []);

  const handleDownload = useCallback(() => {
    if (!processedBuffer) return;
    const wavData = audioBufferToWav(processedBuffer);
    const blob = new Blob([wavData], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = mode === "encode" ? `chirp_${Date.now()}.wav` : `decoded_${Date.now()}.wav`;
    a.click();
    URL.revokeObjectURL(url);
  }, [processedBuffer, mode]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    try {
      setState("processing");
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext({ sampleRate: SAMPLE_RATE });
      }

      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await audioContextRef.current.decodeAudioData(arrayBuffer);
      const voiceBuffer = await decodeAudio(audioBuffer);
      setProcessedBuffer(voiceBuffer);
      setMode("decode");

      setState("playing");
      const src = audioContextRef.current.createBufferSource();
      src.buffer = voiceBuffer;
      src.connect(audioContextRef.current.destination);
      sourceRef.current = src;
      src.onended = () => { setState("idle"); setAudioLevel(0); };
      src.start();
    } catch (err) {
      console.error("Failed to decode:", err);
      setState("idle");
    }
  }, []);

  const handleTap = () => {
    const now = Date.now();
    lastTapRef.current = now;

    if (state === "idle") {
      setTimeout(() => {
        if (Date.now() - lastTapRef.current >= 280) startRecording();
      }, 300);
    } else if (state === "recording") {
      stopRecording();
    } else if (state === "playing") {
      stopPlayback();
    }
  };

  return (
    <div className="fixed inset-0 w-screen h-screen bg-background flex flex-col items-center justify-center select-none overflow-hidden touch-none">
      {/* Header */}
      <div className="absolute top-6 left-6 safe-top">
        <span className="text-xs font-medium text-foreground tracking-wide">blackbird</span>
      </div>

      {/* Controls */}
      <div className="absolute top-6 right-6 flex items-center gap-2 safe-top">
        <input 
          ref={fileInputRef} 
          type="file" 
          accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm" 
          onChange={handleFileSelect} 
          className="hidden" 
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-10 h-10 rounded-full flex items-center justify-center active:bg-secondary transition-colors"
          title="Upload"
        >
          <svg className="w-5 h-5 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
          </svg>
        </button>
        {blobUrl && state === "idle" && (
          <button
            onClick={copyToClipboard}
            className="w-10 h-10 rounded-full flex items-center justify-center active:bg-secondary transition-colors"
            title={copied ? "Copied!" : "Copy link"}
          >
            {copied ? (
              <svg className="w-5 h-5 text-green-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            ) : (
              <svg className="w-5 h-5 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
            )}
          </button>
        )}
        {processedBuffer && state === "idle" && (
          <button
            onClick={handleDownload}
            className="w-10 h-10 rounded-full flex items-center justify-center active:bg-secondary transition-colors"
            title="Download"
          >
            <svg className="w-5 h-5 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
          </button>
        )}
      </div>

      {/* Main Button */}
      <button
        onClick={handleTap}
        disabled={state === "processing" || state === "uploading"}
        className="relative w-24 h-24 rounded-full bg-secondary border border-border flex items-center justify-center transition-transform active:scale-95"
      >
        {(state === "processing" || state === "uploading") ? (
          <svg className="w-7 h-7 text-muted-foreground animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : state === "recording" ? (
          <>
            <div
              className="absolute inset-0 rounded-full bg-foreground/10 transition-transform"
              style={{ transform: `scale(${1 + audioLevel * 0.3})`, opacity: 0.3 + audioLevel * 0.7 }}
            />
            <div className="w-5 h-5 bg-foreground rounded-sm" />
          </>
        ) : state === "playing" ? (
          <div className="w-5 h-5 bg-foreground rounded-sm" />
        ) : (
          <svg className="w-7 h-7 text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
          </svg>
        )}
      </button>

      {/* Status */}
      <p className="mt-6 text-sm text-muted-foreground font-medium">
        {state === "idle" && "tap to record"}
        {state === "recording" && "recording"}
        {state === "processing" && (mode === "decode" ? "decoding" : "encoding")}
        {state === "uploading" && "uploading"}
        {state === "playing" && (mode === "decode" ? "voice" : "birdsong")}
      </p>

      {/* Footer */}
      <div className="absolute bottom-6 text-center safe-bottom">
        <p className="text-xs text-muted-foreground">
          made with &lt;3 by <a href="https://github.com/lukketsvane/blackbird" className="active:text-foreground transition-colors">@lukketsvane</a>
        </p>
      </div>
    </div>
  );
}
