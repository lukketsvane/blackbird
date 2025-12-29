"use client"

import type React from "react"

import { useState, useRef, useCallback } from "react"
import { Bird, Mic, Square, Loader2, Download, Upload } from "lucide-react"

export function BlackbirdConverter() {
  const [state, setState] = useState<"idle" | "recording" | "processing" | "playing" | "realtime">("idle")
  const [audioLevel, setAudioLevel] = useState(0)
  const [processedBuffer, setProcessedBuffer] = useState<AudioBuffer | null>(null)
  const [mode, setMode] = useState<"encode" | "decode">("encode")
  const audioContextRef = useRef<AudioContext | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animationRef = useRef<number>(0)
  const lastTapRef = useRef<number>(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const realtimeRef = useRef<{
    stream: MediaStream
    processor: ScriptProcessorNode
    source: MediaStreamAudioSourceNode
  } | null>(null)

  const SAMPLE_RATE = 44100
  const FSCALE = 24000
  const SHIFT_FREQ = -0.005

  const createHilbertFilter = (length: number): Float32Array => {
    const filter = new Float32Array(length)
    const mid = Math.floor(length / 2)
    for (let i = 0; i < length; i++) {
      const n = i - mid
      if (n === 0) {
        filter[i] = 0
      } else if (n % 2 !== 0) {
        filter[i] = 2 / (Math.PI * n)
      } else {
        filter[i] = 0
      }
      filter[i] *= 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (length - 1))
    }
    return filter
  }

  const createSincFilter = (cutoffHz: number, length: number, sampleRate: number): Float32Array => {
    const filter = new Float32Array(length)
    const mid = Math.floor(length / 2)
    const fc = cutoffHz / sampleRate
    for (let i = 0; i < length; i++) {
      const n = i - mid
      if (n === 0) {
        filter[i] = 2 * Math.PI * fc
      } else {
        filter[i] = Math.sin(2 * Math.PI * fc * n) / n
      }
      filter[i] *=
        0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (length - 1))
    }
    let sum = 0
    for (let i = 0; i < length; i++) sum += filter[i]
    for (let i = 0; i < length; i++) filter[i] /= sum
    return filter
  }

  const convolve = (signal: Float32Array, filter: Float32Array): Float32Array => {
    const result = new Float32Array(signal.length)
    const filterLen = filter.length
    const mid = Math.floor(filterLen / 2)
    for (let i = 0; i < signal.length; i++) {
      let sum = 0
      for (let j = 0; j < filterLen; j++) {
        const idx = i - mid + j
        if (idx >= 0 && idx < signal.length) {
          sum += signal[idx] * filter[j]
        }
      }
      result[i] = sum
    }
    return result
  }

  const encodeAudio = async (audioBuffer: AudioBuffer): Promise<AudioBuffer> => {
    const input = audioBuffer.getChannelData(0)
    const length = input.length
    const rate = audioBuffer.sampleRate

    const hilbert = createHilbertFilter(129)
    const lpf140 = createSincFilter(140, 1025, rate)
    const lpf70 = createSincFilter(70, 1025, rate)

    // Create analytic signal
    const realPart = new Float32Array(input)
    const imagPart = convolve(input, hilbert)

    // Shift to baseband
    const shiftedI = new Float32Array(length)
    const shiftedQ = new Float32Array(length)
    const shiftOmega = 2 * Math.PI * SHIFT_FREQ
    for (let i = 0; i < length; i++) {
      const phase = shiftOmega * i
      const cosP = Math.cos(phase)
      const sinP = Math.sin(phase)
      shiftedI[i] = realPart[i] * cosP + imagPart[i] * sinP
      shiftedQ[i] = imagPart[i] * cosP - realPart[i] * sinP
    }

    // Filter at 140Hz
    const filteredI = convolve(shiftedI, lpf140)
    const filteredQ = convolve(shiftedQ, lpf140)

    // Shift back for FM demod
    const fmI = new Float32Array(length)
    const fmQ = new Float32Array(length)
    for (let i = 0; i < length; i++) {
      const phase = 2 * Math.PI * 0.005 * i
      const cosP = Math.cos(phase)
      const sinP = Math.sin(phase)
      fmI[i] = filteredI[i] * cosP + filteredQ[i] * sinP
      fmQ[i] = filteredQ[i] * cosP - filteredI[i] * sinP
    }

    // FM demodulation - extract pitch
    const fmDemod = new Float32Array(length)
    for (let i = 1; i < length; i++) {
      const cross = fmI[i] * fmQ[i - 1] - fmQ[i] * fmI[i - 1]
      const dot = fmI[i] * fmI[i - 1] + fmQ[i] * fmQ[i - 1]
      fmDemod[i] = Math.atan2(cross, dot)
    }
    const fmFiltered = convolve(fmDemod, lpf70)

    // AM demodulation - extract envelope
    const amDemod = new Float32Array(length)
    for (let i = 0; i < length; i++) {
      amDemod[i] = Math.sqrt(filteredI[i] * filteredI[i] + filteredQ[i] * filteredQ[i])
    }
    const amFiltered = convolve(amDemod, lpf70)

    // Synthesize birdsong at scaled frequency
    const output = new Float32Array(length)
    let phase = 0
    for (let i = 0; i < length; i++) {
      const freq = (fmFiltered[i] * 2 * Math.PI) / rate
      phase += freq * FSCALE
      output[i] = Math.sin(phase * 6) * amFiltered[i]
    }

    // Normalize
    let maxAbs = 0
    for (let i = 0; i < length; i++) {
      const abs = Math.abs(output[i])
      if (abs > maxAbs) maxAbs = abs
    }
    if (maxAbs > 0) {
      for (let i = 0; i < length; i++) output[i] *= 0.9 / maxAbs
    }

    const ctx = audioContextRef.current!
    const outputBuffer = ctx.createBuffer(1, length, rate)
    outputBuffer.getChannelData(0).set(output)
    return outputBuffer
  }

  const decodeAudio = async (audioBuffer: AudioBuffer): Promise<AudioBuffer> => {
    const input = audioBuffer.getChannelData(0)
    const length = input.length
    const rate = audioBuffer.sampleRate

    const hilbert = createHilbertFilter(129)
    // Higher cutoff for birdsong frequencies
    const lpfHigh = createSincFilter(4000, 1025, rate)
    const lpfLow = createSincFilter(200, 1025, rate)

    // Create analytic signal from birdsong
    const realPart = new Float32Array(input)
    const imagPart = convolve(input, hilbert)

    // FM demodulation to extract pitch contour from birdsong
    const fmDemod = new Float32Array(length)
    for (let i = 1; i < length; i++) {
      const cross = realPart[i] * imagPart[i - 1] - imagPart[i] * realPart[i - 1]
      const dot = realPart[i] * realPart[i - 1] + imagPart[i] * imagPart[i - 1]
      fmDemod[i] = Math.atan2(cross, dot)
    }
    const fmFiltered = convolve(fmDemod, lpfHigh)

    // AM demodulation for envelope
    const amDemod = new Float32Array(length)
    for (let i = 0; i < length; i++) {
      amDemod[i] = Math.sqrt(realPart[i] * realPart[i] + imagPart[i] * imagPart[i])
    }
    const amFiltered = convolve(amDemod, lpfLow)

    // Synthesize voice at SCALED DOWN frequency (divide by FSCALE instead of multiply)
    const output = new Float32Array(length)
    let phase = 0
    for (let i = 0; i < length; i++) {
      // Scale frequency DOWN by FSCALE to get back to voice range
      const freq = (fmFiltered[i] * 2 * Math.PI) / rate
      phase += freq / 6 // Reverse the *6 harmonic
      // Use sawtooth-ish wave for more voice-like timbre
      const saw = (phase % (2 * Math.PI)) / Math.PI - 1
      output[i] = saw * amFiltered[i]
    }

    // Apply smoothing filter for voice
    const voiceLpf = createSincFilter(3000, 257, rate)
    const smoothed = convolve(output, voiceLpf)

    // Normalize
    let maxAbs = 0
    for (let i = 0; i < length; i++) {
      const abs = Math.abs(smoothed[i])
      if (abs > maxAbs) maxAbs = abs
    }
    if (maxAbs > 0) {
      for (let i = 0; i < length; i++) smoothed[i] *= 0.9 / maxAbs
    }

    const ctx = audioContextRef.current!
    const outputBuffer = ctx.createBuffer(1, length, rate)
    outputBuffer.getChannelData(0).set(smoothed)
    return outputBuffer
  }

  const audioBufferToWav = (buffer: AudioBuffer): ArrayBuffer => {
    const numChannels = 1
    const sampleRate = buffer.sampleRate
    const samples = buffer.getChannelData(0)
    const wavBuffer = new ArrayBuffer(44 + samples.length * 2)
    const view = new DataView(wavBuffer)

    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i))
      }
    }

    writeString(0, "RIFF")
    view.setUint32(4, 36 + samples.length * 2, true)
    writeString(8, "WAVE")
    writeString(12, "fmt ")
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, numChannels, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * numChannels * 2, true)
    view.setUint16(32, numChannels * 2, true)
    view.setUint16(34, 16, true)
    writeString(36, "data")
    view.setUint32(40, samples.length * 2, true)

    let offset = 44
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]))
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      offset += 2
    }
    return wavBuffer
  }

  const startRealtime = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: SAMPLE_RATE },
      })
      audioContextRef.current = new AudioContext({ sampleRate: SAMPLE_RATE })
      const ctx = audioContextRef.current
      const source = ctx.createMediaStreamSource(stream)
      const processor = ctx.createScriptProcessor(4096, 1, 1)

      const hilbert = createHilbertFilter(65)
      const lpf140 = createSincFilter(140, 257, SAMPLE_RATE)
      const lpf70 = createSincFilter(70, 257, SAMPLE_RATE)

      const bufferSize = 8192
      const inputBuffer = new Float32Array(bufferSize)
      const hilbertBuffer = new Float32Array(bufferSize)
      const shiftedI = new Float32Array(bufferSize)
      const shiftedQ = new Float32Array(bufferSize)
      const filteredI = new Float32Array(bufferSize)
      const filteredQ = new Float32Array(bufferSize)
      const fmI = new Float32Array(bufferSize)
      const fmQ = new Float32Array(bufferSize)
      const fmDemod = new Float32Array(bufferSize)
      const fmFiltered = new Float32Array(bufferSize)
      const amDemod = new Float32Array(bufferSize)
      const amFiltered = new Float32Array(bufferSize)

      let writePos = 0,
        shiftPhase = 0,
        shiftBackPhase = 0,
        synthPhase = 0,
        prevFmI = 0,
        prevFmQ = 0

      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0)
        const output = e.outputBuffer.getChannelData(0)
        const len = input.length

        let sum = 0
        for (let i = 0; i < len; i++) sum += Math.abs(input[i])
        setAudioLevel(Math.min(1, (sum / len) * 10))

        for (let i = 0; i < len; i++) {
          const pos = (writePos + i) % bufferSize
          inputBuffer[pos] = input[i]

          let hilbertSum = 0
          for (let j = 0; j < hilbert.length; j++) {
            const idx = (pos - Math.floor(hilbert.length / 2) + j + bufferSize) % bufferSize
            hilbertSum += inputBuffer[idx] * hilbert[j]
          }
          hilbertBuffer[pos] = hilbertSum

          shiftPhase += 2 * Math.PI * SHIFT_FREQ
          const cosP = Math.cos(shiftPhase),
            sinP = Math.sin(shiftPhase)
          shiftedI[pos] = inputBuffer[pos] * cosP + hilbertBuffer[pos] * sinP
          shiftedQ[pos] = hilbertBuffer[pos] * cosP - inputBuffer[pos] * sinP

          let sumI = 0,
            sumQ = 0
          for (let j = 0; j < lpf140.length; j++) {
            const idx = (pos - Math.floor(lpf140.length / 2) + j + bufferSize) % bufferSize
            sumI += shiftedI[idx] * lpf140[j]
            sumQ += shiftedQ[idx] * lpf140[j]
          }
          filteredI[pos] = sumI
          filteredQ[pos] = sumQ

          shiftBackPhase += 2 * Math.PI * 0.005
          const cosB = Math.cos(shiftBackPhase),
            sinB = Math.sin(shiftBackPhase)
          fmI[pos] = filteredI[pos] * cosB + filteredQ[pos] * sinB
          fmQ[pos] = filteredQ[pos] * cosB - filteredI[pos] * sinB

          const cross = fmI[pos] * prevFmQ - fmQ[pos] * prevFmI
          const dot = fmI[pos] * prevFmI + fmQ[pos] * prevFmQ
          fmDemod[pos] = Math.atan2(cross, dot)
          prevFmI = fmI[pos]
          prevFmQ = fmQ[pos]

          let fmSum = 0
          for (let j = 0; j < lpf70.length; j++) {
            const idx = (pos - Math.floor(lpf70.length / 2) + j + bufferSize) % bufferSize
            fmSum += fmDemod[idx] * lpf70[j]
          }
          fmFiltered[pos] = fmSum

          amDemod[pos] = Math.sqrt(filteredI[pos] * filteredI[pos] + filteredQ[pos] * filteredQ[pos])

          let amSum = 0
          for (let j = 0; j < lpf70.length; j++) {
            const idx = (pos - Math.floor(lpf70.length / 2) + j + bufferSize) % bufferSize
            amSum += amDemod[idx] * lpf70[j]
          }
          amFiltered[pos] = amSum

          const freq = (fmFiltered[pos] * 2 * Math.PI) / SAMPLE_RATE
          synthPhase += freq * FSCALE
          output[i] = Math.sin(synthPhase * 6) * amFiltered[pos] * 3
        }
        writePos = (writePos + len) % bufferSize
      }

      source.connect(processor)
      processor.connect(ctx.destination)
      realtimeRef.current = { stream, processor, source }
      setState("realtime")
    } catch (err) {
      console.error("Mic access denied:", err)
    }
  }, [])

  const stopRealtime = useCallback(() => {
    if (realtimeRef.current) {
      realtimeRef.current.processor.disconnect()
      realtimeRef.current.source.disconnect()
      realtimeRef.current.stream.getTracks().forEach((t) => t.stop())
      realtimeRef.current = null
    }
    setState("idle")
    setAudioLevel(0)
  }, [])

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: SAMPLE_RATE },
      })
      audioContextRef.current = new AudioContext({ sampleRate: SAMPLE_RATE })
      const analyser = audioContextRef.current.createAnalyser()
      analyser.fftSize = 256
      analyserRef.current = analyser
      const source = audioContextRef.current.createMediaStreamSource(stream)
      source.connect(analyser)

      const updateLevel = () => {
        const data = new Uint8Array(analyser.frequencyBinCount)
        analyser.getByteFrequencyData(data)
        const avg = data.reduce((a, b) => a + b, 0) / data.length
        setAudioLevel(avg / 255)
        animationRef.current = requestAnimationFrame(updateLevel)
      }
      updateLevel()

      chunksRef.current = []
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" })
      mediaRecorderRef.current = mediaRecorder

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      mediaRecorder.onstop = async () => {
        cancelAnimationFrame(animationRef.current)
        stream.getTracks().forEach((t) => t.stop())
        setState("processing")

        const blob = new Blob(chunksRef.current, { type: "audio/webm" })
        const arrayBuffer = await blob.arrayBuffer()
        const audioBuffer = await audioContextRef.current!.decodeAudioData(arrayBuffer)
        const birdBuffer = await encodeAudio(audioBuffer)
        setProcessedBuffer(birdBuffer)
        setMode("encode")

        setState("playing")
        const source = audioContextRef.current!.createBufferSource()
        source.buffer = birdBuffer
        source.connect(audioContextRef.current!.destination)
        sourceRef.current = source
        source.onended = () => {
          setState("idle")
          setAudioLevel(0)
        }
        source.start()
      }

      mediaRecorder.start()
      setState("recording")
    } catch (err) {
      console.error("Mic access denied:", err)
    }
  }, [])

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop()
  }, [])
  const stopPlayback = useCallback(() => {
    sourceRef.current?.stop()
    setState("idle")
    setAudioLevel(0)
  }, [])

  const handleDownload = useCallback(() => {
    if (!processedBuffer) return
    const wavData = audioBufferToWav(processedBuffer)
    const blob = new Blob([wavData], { type: "audio/wav" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = mode === "encode" ? "chirp.wav" : "decoded.wav"
    a.click()
    URL.revokeObjectURL(url)
  }, [processedBuffer, mode])

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ""

    try {
      setState("processing")
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext({ sampleRate: SAMPLE_RATE })
      }

      const arrayBuffer = await file.arrayBuffer()
      const audioBuffer = await audioContextRef.current.decodeAudioData(arrayBuffer)

      // Decode birdsong back to voice
      const voiceBuffer = await decodeAudio(audioBuffer)
      setProcessedBuffer(voiceBuffer)
      setMode("decode")

      setState("playing")
      const source = audioContextRef.current.createBufferSource()
      source.buffer = voiceBuffer
      source.connect(audioContextRef.current.destination)
      sourceRef.current = source
      source.onended = () => {
        setState("idle")
        setAudioLevel(0)
      }
      source.start()
    } catch (err) {
      console.error("Failed to decode:", err)
      setState("idle")
    }
  }, [])

  const handleTap = () => {
    const now = Date.now()
    const timeSinceLastTap = now - lastTapRef.current
    lastTapRef.current = now

    if (state === "realtime") {
      stopRealtime()
      return
    }
    if (timeSinceLastTap < 300 && state === "idle") {
      startRealtime()
      return
    }
    if (state === "idle") {
      setTimeout(() => {
        if (Date.now() - lastTapRef.current >= 280) startRecording()
      }, 300)
    } else if (state === "recording") {
      stopRecording()
    } else if (state === "playing") {
      stopPlayback()
    }
  }

  return (
    <main className="fixed inset-0 flex flex-col items-center justify-center bg-background select-none">
      <div className="absolute top-4 left-4 flex items-center gap-1.5">
        <Bird className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">blackbird</span>
      </div>

      <div className="absolute top-4 right-4 flex items-center gap-2">
        <input ref={fileInputRef} type="file" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.webm" onChange={handleFileSelect} className="hidden" />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="p-2 rounded-full hover:bg-secondary transition-colors"
          style={{ WebkitTapHighlightColor: "transparent" }}
        >
          <Upload className="w-4 h-4 text-muted-foreground" />
        </button>
        {processedBuffer && state === "idle" && (
          <button
            onClick={handleDownload}
            className="p-2 rounded-full hover:bg-secondary transition-colors"
            style={{ WebkitTapHighlightColor: "transparent" }}
          >
            <Download className="w-4 h-4 text-muted-foreground" />
          </button>
        )}
      </div>

      <button
        onClick={handleTap}
        disabled={state === "processing"}
        className="relative w-20 h-20 rounded-full bg-foreground/5 border border-border flex items-center justify-center transition-all active:scale-95 hover:bg-foreground/10"
        style={{ WebkitTapHighlightColor: "transparent" }}
      >
        {state === "processing" ? (
          <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
        ) : state === "recording" || state === "realtime" ? (
          <>
            <div
              className="absolute inset-0 rounded-full bg-foreground/10 transition-transform"
              style={{ transform: `scale(${1 + audioLevel * 0.3})`, opacity: audioLevel }}
            />
            <Square className="w-5 h-5 text-foreground fill-current" />
          </>
        ) : state === "playing" ? (
          <Square className="w-5 h-5 text-foreground" />
        ) : (
          <Mic className="w-6 h-6 text-foreground" />
        )}
      </button>

      <p className="mt-6 text-[10px] text-muted-foreground font-mono">
        {state === "idle" && "tap to record"}
        {state === "recording" && "recording"}
        {state === "processing" && (mode === "decode" ? "decoding" : "encoding")}
        {state === "playing" && (mode === "decode" ? "voice" : "birdsong")}
        {state === "realtime" && "realtime"}
      </p>
    </main>
  )
}
