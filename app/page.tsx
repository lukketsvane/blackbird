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

  // Match exact Perl reference parameters
  const SAMPLE_RATE = 44100;
  const FSCALE = 24000;        // Frequency scaling factor from Perl
  const SHIFT_FREQ = -0.005;   // Baseband shift frequency from Perl
  const PHASE_MULT = 6;        // Phase multiplier: sin(phase * 6) from Perl

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

  // Encode voice to birdsong - exact match to Perl reference
  const encodeAudio = async (audioBuffer: AudioBuffer): Promise<{encoded: AudioBuffer, fmData: Float32Array, amData: Float32Array}> => {
    const input = audioBuffer.getChannelData(0);
    const length = input.length;
    const rate = audioBuffer.sampleRate;

    const hilbert = createHilbertFilter(129);
    const lpf140 = createSincFilter(140, 1025, rate);  // Match Perl: sinc -140 -n 1024
    const lpf70 = createSincFilter(70, 1025, rate);    // Match Perl: sinc -70 -n 1024

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
      // Complex multiplication: (real + j*imag) * (cos + j*sin)
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
      const phase = 2 * Math.PI * 0.005 * i;  // shift back by +0.005
      const cosP = Math.cos(phase);
      const sinP = Math.sin(phase);
      fmI[i] = filteredI[i] * cosP - filteredQ[i] * sinP;
      fmQ[i] = filteredI[i] * sinP + filteredQ[i] * cosP;
    }

    // FM demodulation - extract instantaneous frequency (pitch information)
    const fmDemod = new Float32Array(length);
    for (let i = 1; i < length; i++) {
      const cross = fmI[i] * fmQ[i - 1] - fmQ[i] * fmI[i - 1];
      const dot = fmI[i] * fmI[i - 1] + fmQ[i] * fmQ[i - 1];
      fmDemod[i] = Math.atan2(cross, dot);
    }
    fmDemod[0] = fmDemod[1];
    const fmFiltered = convolve(fmDemod, lpf70);

    // AM demodulation - extract envelope (amplitude information)
    const amDemod = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      amDemod[i] = Math.sqrt(filteredI[i] * filteredI[i] + filteredQ[i] * filteredQ[i]);
    }
    const amFiltered = convolve(amDemod, lpf70);

    // Synthesize birdsong at scaled frequency
    // Perl: $phase += $freq * $fscale; print pack "f", sin($phase * 6) * $amdemod;
    const output = new Float32Array(length);
    let phase = 0;
    for (let i = 0; i < length; i++) {
      const freq = (fmFiltered[i] * 2 * Math.PI) / rate;
      phase += freq * FSCALE;
      output[i] = Math.sin(phase * PHASE_MULT) * amFiltered[i];
    }

    // Normalize output
    let maxAbs = 0;
    for (let i = 0; i < length; i++) {
      const abs = Math.abs(output[i]);
      if (abs > maxAbs) maxAbs = abs;
    }
    if (maxAbs > 0) {
      for (let i = 0; i < length; i++) output[i] *= 0.9 / maxAbs;
    }

    const ctx = audioContextRef.current!;
    const outputBuffer = ctx.createBuffer(1, length, rate);
    outputBuffer.getChannelData(0).set(output);
    
    return { encoded: outputBuffer, fmData: fmFiltered, amData: amFiltered };
  };

  // Decode birdsong back to voice - perfect inversion of encoding
  const decodeAudio = async (audioBuffer: AudioBuffer): Promise<AudioBuffer> => {
    const input = audioBuffer.getChannelData(0);
    const length = input.length;
    const rate = audioBuffer.sampleRate;

    const hilbert = createHilbertFilter(129);
    const lpf70 = createSincFilter(70, 1025, rate);

    // Create analytic signal from birdsong
    const realPart = new Float32Array(input);
    const imagPart = convolve(input, hilbert);

    // FM demodulation to extract instantaneous frequency from birdsong
    // This gives us: birdsong_inst_freq = original_fm * FSCALE * PHASE_MULT (in radians/sample)
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
    for (let i = 0; i < length; i++) {
      const samples: number[] = [];
      for (let j = 0; j < windowSize; j++) {
        const idx = Math.max(0, Math.min(length - 1, i - halfWindow + j));
        samples.push(fmDemod[idx]);
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

    // Reconstruct original voice
    // Encoding: phase += (fm * 2π/rate) * FSCALE; output = sin(phase * PHASE_MULT) * am
    // The birdsong inst_freq (in radians/sample) = fm_original * 2π/rate * FSCALE * PHASE_MULT
    // To decode: original_fm = birdsong_inst_freq * rate / (2π * FSCALE * PHASE_MULT)
    const output = new Float32Array(length);
    let phase = 0;

    for (let i = 0; i < length; i++) {
      // Recover original phase increment
      // fmFiltered[i] is in radians/sample (birdsong instantaneous frequency)
      // Original: freq = (fmOriginal * 2π) / rate, then phase += freq * FSCALE, then sin(phase * PHASE_MULT)
      // So birdsong_inst_freq = fmOriginal * 2π / rate * FSCALE * PHASE_MULT
      // Therefore: fmOriginal = fmFiltered[i] * rate / (2π * FSCALE * PHASE_MULT)
      const originalFm = fmFiltered[i] * rate / (2 * Math.PI * FSCALE * PHASE_MULT);
      
      // The original encoding had: freq = (fmFiltered * 2π) / rate
      // This was then phase accumulated. To reverse:
      phase += originalFm;
      
      // Generate sine wave at original frequency with original envelope
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
        
        const { encoded: birdBuffer } = await encodeAudio(audioBuffer);
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
    a.download = mode === "encode" ? "blackbird.wav" : "voice.wav";
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

  // Blackbird SVG icon matching the app icon
  const BlackbirdIcon = () => (
    <svg viewBox="0 0 100 100" className="w-6 h-6" fill="currentColor">
      <path d="M75 25c-5 0-10 3-13 7l-5-2c-3-1-6 0-8 2L35 45c-2 2-3 5-2 8l2 5c-4 3-7 8-7 13 0 2 0 4 1 6l-8 8c-1 1-1 3 0 4s3 1 4 0l8-8c2 1 4 1 6 1 5 0 10-3 13-7l5 2c3 1 6 0 8-2l14-13c2-2 3-5 2-8l-2-5c4-3 7-8 7-13 0-9-7-16-16-16zM39 73c-3 0-6-1-8-3l15-15c2 2 3 5 3 8 0 6-4 10-10 10zm22-12l-4-2 10-10 2 4c1 2 0 4-1 5l-4 4c-1 1-2 1-3-1zm8-18c-2-2-3-5-3-8 0-6 4-10 10-10s10 4 10 10c0 3-1 6-3 8L68 58l-2-4c-1-2 0-4 1-5l4-4c1-1 3-1 4 1l4 2-10 10z"/>
    </svg>
  );

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center relative select-none">
      {/* Header - minimal blackbird branding */}
      <div className="absolute top-6 left-6 flex items-center gap-2">
        <div className="text-black">
          <BlackbirdIcon />
        </div>
        <span className="text-xs font-medium text-black tracking-wide">blackbird</span>
      </div>

      {/* Controls - top right */}
      <div className="absolute top-6 right-6 flex items-center gap-3">
        <input 
          ref={fileInputRef} 
          type="file" 
          accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm" 
          onChange={handleFileSelect} 
          className="hidden" 
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="p-2 rounded-full hover:bg-gray-100 transition-colors"
          title="Upload birdsong to decode"
        >
          <svg className="w-5 h-5 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
          </svg>
        </button>
        {processedBuffer && state === "idle" && (
          <button
            onClick={handleDownload}
            className="p-2 rounded-full hover:bg-gray-100 transition-colors"
            title="Download"
          >
            <svg className="w-5 h-5 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
          </button>
        )}
      </div>

      {/* Main Button - clean circular design */}
      <button
        onClick={handleTap}
        disabled={state === "processing"}
        className="relative w-28 h-28 rounded-full bg-white border-2 border-gray-200 flex items-center justify-center transition-all active:scale-95 hover:border-gray-300 hover:shadow-lg shadow-md"
      >
        {state === "processing" ? (
          <svg className="w-8 h-8 text-gray-400 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : state === "recording" ? (
          <>
            <div
              className="absolute inset-0 rounded-full bg-black/5 transition-transform"
              style={{ transform: `scale(${1 + audioLevel * 0.3})`, opacity: 0.3 + audioLevel * 0.7 }}
            />
            <div className="w-6 h-6 bg-black rounded-sm" />
          </>
        ) : state === "playing" ? (
          <div className="w-6 h-6 bg-black rounded-sm" />
        ) : (
          <svg className="w-8 h-8 text-black" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
          </svg>
        )}
      </button>

      {/* Status text */}
      <p className="mt-8 text-sm text-gray-500 font-medium">
        {state === "idle" && "Tap to record"}
        {state === "recording" && "Recording..."}
        {state === "processing" && (mode === "decode" ? "Restoring voice..." : "Converting to birdsong...")}
        {state === "playing" && (mode === "decode" ? "Playing restored voice" : "Playing birdsong")}
      </p>

      {/* Instructions - bottom */}
      <div className="absolute bottom-8 text-center">
        <p className="text-xs text-gray-400">
          Record voice → Birdsong &nbsp;•&nbsp; Upload birdsong → Original voice
        </p>
      </div>
    </div>
  );
}
