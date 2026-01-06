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

  // Phase encoding steganography
  // Voice is hidden in the phase of birdsong (inaudible but perfectly recoverable)
  const PHASE_MOD_INDEX = 0.15; // Phase modulation strength for voice embedding

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

  // Bandpass filter (combines highpass and lowpass)
  const createBandpassFilter = (lowHz: number, highHz: number, length: number, sampleRate: number): Float32Array => {
    const lpf = createSincFilter(highHz, length, sampleRate);
    const hpfLow = createSincFilter(lowHz, length, sampleRate);
    const result = new Float32Array(length);
    const mid = Math.floor(length / 2);
    // Bandpass = lowpass(high) - lowpass(low) with spectral inversion for highpass
    for (let i = 0; i < length; i++) {
      result[i] = lpf[i] - hpfLow[i];
    }
    // Add impulse at center for proper bandpass
    result[mid] += 1;
    for (let i = 0; i < length; i++) {
      result[i] = lpf[i] - hpfLow[i];
    }
    return result;
  };

  // Encode voice to birdsong
  // Voice information is encoded in the birdsong's FM/AM structure
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
    let synthPhase = 0;
    for (let i = 0; i < length; i++) {
      const freq = (fmFiltered[i] * 2 * Math.PI) / rate;
      synthPhase += freq * FSCALE;
      birdsong[i] = Math.sin(synthPhase * PHASE_MULT) * amFiltered[i];
    }

    // Normalize birdsong to 0.85 for headroom
    let maxBird = 0;
    for (let i = 0; i < length; i++) {
      const abs = Math.abs(birdsong[i]);
      if (abs > maxBird) maxBird = abs;
    }
    if (maxBird > 0) {
      for (let i = 0; i < length; i++) birdsong[i] *= 0.85 / maxBird;
    }

    // === PHASE ENCODING STEGANOGRAPHY ===
    // Hide voice in the phase of birdsong for perfect reconstruction

    // Normalize voice for phase modulation
    let maxVoice = 0;
    for (let i = 0; i < length; i++) {
      const abs = Math.abs(input[i]);
      if (abs > maxVoice) maxVoice = abs;
    }
    const normalizedVoice = new Float32Array(length);
    if (maxVoice > 0) {
      for (let i = 0; i < length; i++) {
        normalizedVoice[i] = input[i] / maxVoice;
      }
    }

    // Create analytic signal of birdsong
    const birdReal = new Float32Array(birdsong);
    const birdImag = convolve(birdsong, hilbert);

    // Extract magnitude and phase
    const magnitude = new Float32Array(length);
    const phase = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      magnitude[i] = Math.sqrt(birdReal[i] * birdReal[i] + birdImag[i] * birdImag[i]);
      phase[i] = Math.atan2(birdImag[i], birdReal[i]);
    }

    // Phase modulation: embed voice in the phase
    const output = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const modulatedPhase = phase[i] + normalizedVoice[i] * PHASE_MOD_INDEX;
      output[i] = magnitude[i] * Math.cos(modulatedPhase);
    }

    // Final normalization
    let maxOut = 0;
    for (let i = 0; i < length; i++) {
      const abs = Math.abs(output[i]);
      if (abs > maxOut) maxOut = abs;
    }
    if (maxOut > 0) {
      for (let i = 0; i < length; i++) output[i] *= 0.9 / maxOut;
    }

    // Create MONO buffer with phase-encoded voice
    const ctx = audioContextRef.current!;
    const outputBuffer = ctx.createBuffer(1, length, rate);
    outputBuffer.getChannelData(0).set(output);

    return outputBuffer;
  };

  // Decode birdsong back to voice
  // Extracts voice from phase-encoded birdsong
  const decodeAudio = async (audioBuffer: AudioBuffer): Promise<AudioBuffer> => {
    const length = audioBuffer.length;
    const rate = audioBuffer.sampleRate;
    const ctx = audioContextRef.current!;
    const input = audioBuffer.getChannelData(0);

    const hilbert = createHilbertFilter(129);
    const lpf4000 = createSincFilter(4000, 513, rate);  // Voice bandwidth limit
    const lpf500 = createSincFilter(500, 1025, rate);   // For birdsong phase estimation

    // === PHASE DEMODULATION ===
    // Extract voice from phase-modulated birdsong

    // Create analytic signal
    const realPart = new Float32Array(input);
    const imagPart = convolve(input, hilbert);

    // Extract instantaneous phase
    const totalPhase = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      totalPhase[i] = Math.atan2(imagPart[i], realPart[i]);
    }

    // Unwrap phase (handle 2π discontinuities)
    const unwrappedPhase = new Float32Array(length);
    unwrappedPhase[0] = totalPhase[0];
    for (let i = 1; i < length; i++) {
      let delta = totalPhase[i] - totalPhase[i - 1];
      // Detect wrapping
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      unwrappedPhase[i] = unwrappedPhase[i - 1] + delta;
    }

    // Estimate birdsong phase (lowpass filter the total phase)
    // Birdsong phase varies slowly, voice modulation is faster
    const birdsongPhase = convolve(unwrappedPhase, lpf500);

    // Extract voice: voice = (total_phase - birdsong_phase) / PHASE_MOD_INDEX
    const voice = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      voice[i] = (unwrappedPhase[i] - birdsongPhase[i]) / PHASE_MOD_INDEX;
    }

    // Bandlimit to voice frequencies and remove any DC offset
    const voiceFiltered = convolve(voice, lpf4000);

    // Remove DC component
    let dcOffset = 0;
    for (let i = 0; i < length; i++) {
      dcOffset += voiceFiltered[i];
    }
    dcOffset /= length;
    for (let i = 0; i < length; i++) {
      voiceFiltered[i] -= dcOffset;
    }

    // Check if we successfully decoded voice (energy detection)
    let voiceEnergy = 0;
    for (let i = 0; i < Math.min(length, rate); i++) {
      voiceEnergy += voiceFiltered[i] * voiceFiltered[i];
    }
    voiceEnergy /= Math.min(length, rate);

    if (voiceEnergy > 0.0001) {
      // Normalize to audible level
      let maxAmp = 0;
      for (let i = 0; i < length; i++) {
        const abs = Math.abs(voiceFiltered[i]);
        if (abs > maxAmp) maxAmp = abs;
      }
      const normalizedVoice = new Float32Array(length);
      if (maxAmp > 0) {
        for (let i = 0; i < length; i++) {
          normalizedVoice[i] = voiceFiltered[i] * 0.9 / maxAmp;
        }
      }

      const outputBuffer = ctx.createBuffer(1, length, rate);
      outputBuffer.getChannelData(0).set(normalizedVoice);
      return outputBuffer;
    }

    // === LEGACY SUPPORT: Check for old stereo right channel embedding ===
    if (audioBuffer.numberOfChannels >= 2) {
      const rightChannel = audioBuffer.getChannelData(1);
      let rightEnergy = 0;
      for (let i = 0; i < Math.min(length, rate); i++) {
        rightEnergy += rightChannel[i] * rightChannel[i];
      }
      rightEnergy /= Math.min(length, rate);

      if (rightEnergy > 0.0000001) {
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

    // If no phase-encoded voice found, return empty/silence
    console.warn("No phase-encoded voice detected");
    const outputBuffer = ctx.createBuffer(1, length, rate);
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

        // Output is birdsong with voice hidden in phase (inaudible)
        setState("playing");
        const src = audioContextRef.current!.createBufferSource();
        src.buffer = birdBuffer;
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
        {(state === "processing" || state === "uploading") && (mode === "decode" ? "decoding" : "encoding")}
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
