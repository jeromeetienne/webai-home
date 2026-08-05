# WebRTC data channel trick log

Experiment 06 of [`@webai/idle-experiments`](../../README.md), built for [issue #83](https://github.com/webai-at-home/webai-at-home/issues/83).

Chrome's [background tabs article](https://developer.chrome.com/blog/background_tabs) names two exemptions from background tab timer throttling: audio playback, and "real-time connections (WebSockets and WebRTC)". [`../silent_audio_log`](../silent_audio_log) tests the first. This experiment tests the second.

The page opens two `RTCPeerConnection` objects that connect only to each other, inside this same page, and keeps a data channel open between them with one ping a second. No signaling server and no second machine are needed: both sides negotiate their own local host candidates and connect over the loopback address. Alongside that it runs the identical timer drift, animation frame, and fixed computation loop measurement as [`../visibility_timer_log`](../visibility_timer_log), so the two logs can be compared directly.

## Run

```sh
npm run dev --workspace @webai/idle-experiments
```

Open the printed local address and follow the link to this experiment, or go straight to `webrtc_datachannel_log/`.

## Test it

1. Leave the tab as it is for about 30 seconds. The log should settle into a steady rhythm that includes a round trip row roughly once a second, and the status badge should read open rather than connecting.
2. Move the window to a corner of the screen, not covered by anything, and work in a different window without clicking back into this one.
3. Come back and compare the timer drift and computation loop rows against experiment 01's log taken under the same conditions without the data channel.
4. Repeat with the window fully covered or minimized.

## What was measured

Nothing conclusive yet. This is the one experiment in the package that has not produced a usable result.

Attempted on 2026-08-05: the loopback connection stayed at connecting for more than 20 seconds with no errors reported to the console, and no round trip rows ever appeared. Timer drift over that stretch sat at +990 to +1007 milliseconds, which is simply the unmitigated hidden tab baseline — the exemption was never actually exercised, so the measurement says nothing about whether it works.

The negotiation logic in [`src/webrtc_loopback.ts`](src/webrtc_loopback.ts) was read through afterwards and the offer, answer, and candidate exchange all look correct. The most likely explanation is that the sandboxed browser environment used for that attempt blocked the candidate gathering WebRTC needs, rather than a fault in this page.

Retest this in an ordinary desktop Chrome window before drawing any conclusion. If the badge reaches open and round trip rows appear, the measurement is valid; if it stays at connecting, the environment is blocking WebRTC and the run should be discarded rather than recorded as a negative result.

See [`../../README.md`](../../README.md) for the other experiments in this package.
