# HoloLoop

An endless playlist of 3D videos for the Looking Glass Go.

Your PC turns ordinary videos into 3D (colour + depth). An Android phone plugged into the Go downloads them over Wi-Fi and keeps them playing on the Go: one after another, resuming long videos where they left off, and sleeping at night.

Not made by or affiliated with Looking Glass Factory.

## What you need

- A Windows 10/11 PC (x64). Any GPU works through DirectML; it falls back to the CPU.
- An Android phone (8.0 or newer) that can drive an external display over USB-C (DisplayPort Alt Mode). Most Samsung Galaxy S and Note phones can.
- A USB-C hub or adapter with power passthrough that keeps DisplayPort working. The Go draws more power than a phone's port gives, so it needs a charger on the adapter.

## Setup

1. **PC:** download `HoloLoop-windows-x64.zip` from [Releases](../../releases), unzip it, right-click `install.ps1` and choose *Run with PowerShell*. It installs to Program Files, adds a Start menu entry and lets phones on your home network reach it.
2. Open HoloLoop and add videos or a folder to watch. Conversion starts by itself.
3. Plug the Go into the PC once, so HoloLoop can read its calibration from the Go's drive.
4. **Phone:** install `HoloLoop.apk`, open it and link it to the PC with the address and PIN the PC shows under *Phone*.
5. Plug the phone into the Go through the adapter. Playback starts on the Go.

The Go's own buttons work: back and next change video (hold to skip through it), play pauses. Press play twice quickly for a menu on the Go itself: 3D settings, filters, cool mode, playback, lens correction and sleep. Most of it is on the phone too.

## Building

**Phone app** (`android/`): Android Studio, or `gradlew assembleDebug`. A release build is signed when `android/keystore.properties` exists (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`).

**PC app** (`windows/`), with Node 20+:

```
npm install
node tools/get-models.js
npm start
```

`get-models.js` downloads the models and runs `tools/swap_weights.py` and `tools/strip_posembed.py`, which need Python with `onnx`, `onnxconverter-common`, `numpy` and `safetensors`. `node build/pack.js` makes the packaged app in `dist/`.

## How it works

- **Conversion:** Depth Anything V2 Small (or Distill-Any-Depth Small or Base, chosen per video) runs on onnxruntime with DirectML, 60-second chunks at a time, so a conversion can stop and resume. The output is a side-by-side video (colour left, depth right). Faces and poses (YuNet, RTMO) decide the framing and whether a sideways video should be turned upright.
- **Playback:** each subpixel of the Go's panel shows its own view, made straight from colour and depth by marching a ray through the depth map, so near things hide far ones. A short-term smoothing pass keeps edges from flickering when the depth changes frame to frame.
- **Phone:** draws the 3D only when the video has a new frame and stops drawing while the picture holds still, keeps up to a few seconds of video in memory, and restarts itself after a crash or reboot if allowed to draw over other apps.

## License

MIT, see [LICENSE](LICENSE). The models and bundled tools have their own licenses, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
