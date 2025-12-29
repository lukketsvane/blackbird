# Blackbird

Voice to birdsong converter. Records audio, extracts pitch and amplitude using DSP, synthesizes birdsong at ultrasonic-range frequencies.

## How it works

1. **Encode (voice to birdsong)**: Records voice, applies Hilbert transform to create analytic signal, extracts pitch via FM demodulation and envelope via AM demodulation, synthesizes birdsong by scaling frequency 24000x
2. **Decode (birdsong to voice)**: Reverses the process - extracts pitch/amplitude from birdsong, reconstructs voice waveform

## Usage

- Tap button to record voice, release to convert to birdsong
- Upload existing birdsong file to decode back to voice
- Download processed audio as WAV

## Tech

- Next.js + React
- Web Audio API for real-time processing
- DSP: Hilbert transform, sinc filters, FM/AM modulation

## Run locally

```bash
npm install
npm run dev
```

---

made with <3 by [@lukketsvane](https://github.com/lukketsvane/blackbird)
