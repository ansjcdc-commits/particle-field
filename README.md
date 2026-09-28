# Particle Field — Hand Interaction

A full-screen Three.js/WebGL particle field controlled by MediaPipe hand landmarks, with mouse and touch fallback.

## Run locally

On macOS, double-click **启动粒子场.command** to start the local server and open the page at `http://localhost:8000/`. The launcher reuses the running instance, so you can run it again whenever you want to reopen the same link. Keep using the same launcher after updates; the project files stay in this folder, so refreshing the page loads the latest changes. If port 8000 is already occupied by another app, close that app before launching.

From this folder, run:

```sh
python3 -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000). Click **ENABLE CAMERA** to request video only; no microphone is requested. While the camera starts or tracks a hand, click the same button (shown as **TURN OFF** or **LOADING MODEL · TURN OFF**) at any time to stop the stream and release the camera. Click **ENABLE CAMERA** again to restart. Camera access requires `localhost` or HTTPS, and may be blocked inside embedded preview panes. Open the URL in a full Chrome, Safari, or Edge window and allow camera access when prompted. If the hand model fails to load, the camera preview stays on; turn the camera off and on to retry. If the camera request times out, check the site camera permission in the browser address-bar settings and close other apps using the camera. If camera access is unavailable, move the mouse to interact, hold the mouse button to pinch, or use two fingers on a touch screen.

## Controls

- Extend the index finger to attract particles to the fingertip. Pinch thumb and index finger to gather particles into a horizontal ring that follows the pinch midpoint in all directions. Make a fist to gather particles into a 3D sphere around the palm.
- Extend exactly three fingers to gather the particles into the word **HELLO**.
- Extend the four fingers while keeping the thumb folded to gather the particles into **ANSJ**. Open the thumb too to keep the existing open-palm scatter gesture.
- Open the palm to quickly restore particles to a jittered, grid-spaced layout covering the full screen. The particles stay distributed across the view rather than being pushed into a clump or a single area. Move the mouse to attract particles, hold the mouse button to form the ring, or use two fingers on a touch screen to pinch.
- Click **DEBUG** to display frame rate and tracking data.

The central `CONFIG` object in `main.js` contains the particle count, field strengths, damping, trails, and camera smoothing parameters. Three.js and MediaPipe Tasks Vision load from pinned jsDelivr versions; the hand landmark model loads from Google's MediaPipe model storage.
