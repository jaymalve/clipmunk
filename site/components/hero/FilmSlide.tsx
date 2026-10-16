"use client";

import { useEffect, useRef, useState } from "react";
import type { SlideProps } from "./slide";
import { prefersStillness } from "./useFit";

/** Clipmunk's launch video, made with Clipmunk: nine scenes joined into one sequence, with
 * Clipmunk's own music and key clicks. It starts silent, as browsers require; the speaker in
 * the corner turns the sound on.
 */
export default function FilmSlide({ onProgress, onDone, onTouch }: SlideProps) {
  const video = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);

  function toggleSound() {
    const player = video.current;
    if (!player) return;
    player.muted = !muted;
    setMuted(!muted);
    if (muted) {
      // Someone listening wants this video to keep playing, not move on to the next tab.
      onTouch();
      if (player.paused) player.play().catch(() => {});
    }
  }

  // The latest callback, so the loop below can start once and keep running.
  const report = useRef(onProgress);
  report.current = onProgress;

  useEffect(() => {
    const player = video.current;
    if (!player || prefersStillness()) return;
    // Browsers only start a video by themselves when it is silent.
    player.muted = true;
    player.play().catch(() => {});
    // A video reports its time only a few times a second, which makes a progress line stutter,
    // so read the time on every frame instead.
    let raf = requestAnimationFrame(function tick() {
      if (player.duration) report.current(player.currentTime / player.duration);
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="slide slide--film">
      <video
        ref={video}
        src="/hero/film.mp4"
        poster="/hero/film.jpg"
        playsInline
        disableRemotePlayback
        muted
        preload="auto"
        onEnded={(event) => {
          onDone();
          // Still here a moment later means the player kept this slide, so play it again.
          const player = event.currentTarget;
          window.setTimeout(() => {
            if (!player.isConnected) return;
            player.currentTime = 0;
            player.play().catch(() => {});
          }, 60);
        }}
      />
      <p className="slide__note display">Shot and scored by Clipmunk. No editing.</p>
      <button
        type="button"
        className="slide__sound"
        onClick={toggleSound}
        aria-pressed={!muted}
        aria-label={muted ? "Turn sound on" : "Turn sound off"}
        title={muted ? "Turn sound on" : "Turn sound off"}
      >
        <SpeakerIcon muted={muted} />
      </button>
    </div>
  );
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
      <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" fill="currentColor" />
      {muted ? (
        <path d="m16 9.5 5 5m0-5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      ) : (
        <path
          d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
