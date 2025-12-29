# Blackbird

Voice to birdsong converter. Records audio, extracts pitch and amplitude using DSP, synthesizes birdsong at ultrasonic-range frequencies.

## How it works

1. **Encode (voice to birdsong)**: Records voice, applies Hilbert transform to create analytic signal, extracts pitch via FM demodulation and envelope via AM demodulation, synthesizes birdsong by scaling frequency 24000x. The original voice is embedded in the stereo WAV file for perfect reconstruction.
2. **Decode (birdsong to voice)**: Extracts the original voice from the embedded data in the stereo file, producing fully intelligible speech.

## Usage

- Tap button to record voice, release to convert to birdsong
- Upload existing birdsong file (from this app) to decode back to voice
- Download processed audio as WAV (stereo: left=birdsong, right=original voice)

## Tech

- Next.js + React
- Web Audio API for real-time processing
- DSP: Hilbert transform, sinc filters, FM/AM modulation
- Steganographic embedding for lossless voice recovery

## Run locally

```bash
npm install
npm run dev
```

---

made with <3 by [@lukketsvane](https://github.com/lukketsvane/blackbird)
