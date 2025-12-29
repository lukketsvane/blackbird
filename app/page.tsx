"use client";

import type React from "react";
import { useState, useRef, useCallback } from "react";

export default function BlackbirdConverter() {
  const [state, setState] = useState<"idle" | "recording" | "processing" | "playing">("idle");
  const [audioLevel, setAudioLevel] = useState(0);
  const [processedBuffer, setProcessedBuffer] = useState<AudioBuffer | null>(null);
  const [mode, setMode] = useState<"encode" | "decode">("encode");
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationRef = useRef<number>(0);
  const lastTapRef = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const SAMPLE_RATE = 44100;
  const FREQ_SCALE = 20;
  const VOICE_CUTOFF = 400;
  const BIRD_CUTOFF = 8000;
  const BASE_FREQ = 3000;

  const createHilbertFilter = (length: number): Float32Array => {
    const filter = new Float32Array(length);
    const mid = Math.floor(length / 2);
    for (let i = 0; i < length; i++) {
      const n = i - mid;
      if (n === 0) filter[i] = 0;
      else if (n % 2 !== 0) filter[i] = 2 / (Math.PI * n);
      else filter[i] = 0;
      filter[i] *= 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (length - 1));
    }
    return filter;
  };

  const createSincFilter = (cutoffHz: number, length: number, sampleRate: number): Float32Array => {
    const filter = new Float32Array(length);
    const mid = Math.floor(length / 2);
    const fc = cutoffHz / sampleRate;
    for (let i = 0; i < length; i++) {
      const n = i - mid;
      if (n === 0) filter[i] = 2 * Math.PI * fc;
      else filter[i] = Math.sin(2 * Math.PI * fc * n) / n;
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

  const getEnvelope = (signal: Float32Array, hilbert: Float32Array, lpf: Float32Array): Float32Array => {
    const imag = convolve(signal, hilbert);
    const envelope = new Float32Array(signal.length);
    for (let i = 0; i < signal.length; i++) {
      envelope[i] = Math.sqrt(signal[i] * signal[i] + imag[i] * imag[i]);
    }
    return convolve(envelope, lpf);
  };

  const getInstFreq = (signal: Float32Array, hilbert: Float32Array, rate: number): Float32Array => {
    const imag = convolve(signal, hilbert);
    const freq = new Float32Array(signal.length);
    for (let i = 1; i < signal.length; i++) {
      const re0 = signal[i - 1], im0 = imag[i - 1];
      const re1 = signal[i], im1 = imag[i];
      const cross = re1 * im0 - im1 * re0;
      const dot = re1 * re0 + im1 * im0;
      freq[i] = Math.atan2(cross, dot) * rate / (2 * Math.PI);
    }
    freq[0] = freq[1];
    return freq;
  };

  const encodeAudio = async (audioBuffer: AudioBuffer): Promise<AudioBuffer> => {
    const input = audioBuffer.getChannelData(0);
    const length = input.length;
    const rate = audioBuffer.sampleRate;

    const hilbert = createHilbertFilter(255);
    const voiceLpf = createSincFilter(VOICE_CUTOFF, 511, rate);
    const envLpf = createSincFilter(50, 255, rate);

    const voiceBand = convolve(input, voiceLpf);
    const envelope = getEnvelope(voiceBand, hilbert, envLpf);
    const instFreq = getInstFreq(voiceBand, hilbert, rate);
    const freqSmoothed = convolve(instFreq, envLpf);

    const output = new Float32Array(length);
    let phase = 0;
    
    for (let i = 0; i < length; i++) {
      const modulation = freqSmoothed[i] * FREQ_SCALE;
      const birdFreq = BASE_FREQ + modulation;
      phase += (2 * Math.PI * birdFreq) / rate;
      const fundamental = Math.sin(phase);
      const harmonic2 = 0.3 * Math.sin(phase * 2);
      const harmonic3 = 0.1 * Math.sin(phase * 3);
      output[i] = (fundamental + harmonic2 + harmonic3) * envelope[i];
    }

    let maxAbs = 0;
    for (let i = 0; i < length; i++) if (Math.abs(output[i]) > maxAbs) maxAbs = Math.abs(output[i]);
    if (maxAbs > 0) for (let i = 0; i < length; i++) output[i] *= 0.9 / maxAbs;

    const ctx = audioContextRef.current!;
    const outputBuffer = ctx.createBuffer(1, length, rate);
    outputBuffer.getChannelData(0).set(output);
    return outputBuffer;
  };

  const decodeAudio = async (audioBuffer: AudioBuffer): Promise<AudioBuffer> => {
    const input = audioBuffer.getChannelData(0);
    const length = input.length;
    const rate = audioBuffer.sampleRate;

    const hilbert = createHilbertFilter(255);
    const birdLpf = createSincFilter(BIRD_CUTOFF, 511, rate);
    const envLpf = createSincFilter(50, 255, rate);
    const voiceSmooth = createSincFilter(VOICE_CUTOFF, 255, rate);

    const birdBand = convolve(input, birdLpf);
    const envelope = getEnvelope(birdBand, hilbert, envLpf);
    const instFreq = getInstFreq(birdBand, hilbert, rate);
    const freqSmoothed = convolve(instFreq, envLpf);

    const output = new Float32Array(length);
    let phase = 0;
    
    for (let i = 0; i < length; i++) {
      const modulation = (freqSmoothed[i] - BASE_FREQ) / FREQ_SCALE;
      const voiceFreq = Math.max(80, Math.min(400, 150 + modulation));
      phase += (2 * Math.PI * voiceFreq) / rate;
      const saw = ((phase % (2 * Math.PI)) / Math.PI) - 1;
      const sine = Math.sin(phase);
      output[i] = (0.7 * sine + 0.3 * saw) * envelope[i];
    }

    const smoothed = convolve(output, voiceSmooth);
    let maxAbs = 0;
    for (let i = 0; i < length; i++) if (Math.abs(smoothed[i]) > maxAbs) maxAbs = Math.abs(smoothed[i]);
    if (maxAbs > 0) for (let i = 0; i < length; i++) smoothed[i] *= 0.9 / maxAbs;

    const ctx = audioContextRef.current!;
    const outputBuffer = ctx.createBuffer(1, length, rate);
    outputBuffer.getChannelData(0).set(smoothed);
    return outputBuffer;
  };

  const audioBufferToWav = (buffer: AudioBuffer): ArrayBuffer => {
    const samples = buffer.getChannelData(0);
    const wavBuffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(wavBuffer);
    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
    };
    writeString(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, samples.length * 2, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    return wavBuffer;
  };

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
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
    a.download = mode === "encode" ? "chirp.wav" : "decoded.wav";
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
    <div className="min-h-screen bg-neutral-950 flex flex-col items-center justify-center relative select-none">
      {/* Header */}
      <div className="absolute top-4 left-4 flex items-center gap-1.5">
        <svg className="w-4 h-4 text-neutral-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M16 7h.01M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.28L2 20l1.4-2Z" />
        </svg>
        <span className="text-[10px] font-mono text-neutral-500 uppercase tracking-wider">blackbird</span>
      </div>

      {/* Controls */}
      <div className="absolute top-4 right-4 flex items-center gap-2">
        <input 
          ref={fileInputRef} 
          type="file" 
          accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm" 
          onChange={handleFileSelect} 
          className="hidden" 
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="p-2 rounded-full hover:bg-neutral-800 transition-colors"
          title="Upload birdsong to decode"
        >
          <svg className="w-4 h-4 text-neutral-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
          </svg>
        </button>
        {processedBuffer && state === "idle" && (
          <button
            onClick={handleDownload}
            className="p-2 rounded-full hover:bg-neutral-800 transition-colors"
            title="Download"
          >
            <svg className="w-4 h-4 text-neutral-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
          </button>
        )}
      </div>

      {/* Main Button */}
      <button
        onClick={handleTap}
        disabled={state === "processing"}
        className="relative w-24 h-24 rounded-full bg-neutral-900 border border-neutral-800 flex items-center justify-center transition-all active:scale-95 hover:bg-neutral-800"
      >
        {state === "processing" ? (
          <svg className="w-6 h-6 text-neutral-500 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : state === "recording" ? (
          <>
            <div
              className="absolute inset-0 rounded-full bg-red-500/20 transition-transform"
              style={{ transform: `scale(${1 + audioLevel * 0.4})`, opacity: 0.5 + audioLevel * 0.5 }}
            />
            <div className="w-5 h-5 bg-red-500 rounded-sm" />
          </>
        ) : state === "playing" ? (
          <div className="w-5 h-5 bg-neutral-300 rounded-sm" />
        ) : (
          <svg className="w-7 h-7 text-neutral-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
          </svg>
        )}
      </button>

      {/* Status */}
      <p className="mt-6 text-[11px] text-neutral-500 font-mono">
        {state === "idle" && "tap to record voice"}
        {state === "recording" && "recording..."}
        {state === "processing" && (mode === "decode" ? "decoding birdsong..." : "encoding to birdsong...")}
        {state === "playing" && (mode === "decode" ? "▶ decoded voice" : "▶ birdsong")}
      </p>

      {/* Instructions */}
      <div className="absolute bottom-8 text-center">
        <p className="text-[10px] text-neutral-600 font-mono">
          record voice → birdsong • upload birdsong → voice
        </p>
      </div>
    </div>
  );
}
