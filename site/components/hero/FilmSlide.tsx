"use client";

import { useEffect, useRef, useState } from "react";
import type { SlideProps } from "./slide";
import { prefersStillness } from "./useFit";

/** A real Clipmunk export: a stop-motion film of the dashboard, five scenes joined into one sequence, with generated music. */
export default function FilmSlide({ onProgress, onDone, onTouch }: SlideProps) {
  const video = useRef<HTMLVideoElement>(null);
  const [sound, setSound] = useState(false);

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

  function toggleSound() {
    const player = video.current;
    if (!player) return;
    onTouch();
    player.muted = sound;
    setSound(!sound);
    if (player.paused) player.play().catch(() => {});
  }

  return (
    <div className="slide slide--film">
      <video
        ref={video}
        src="/hero/film.mp4"
        poster="/hero/film.jpg"
        playsInline
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
      <button type="button" className="slide__chip display" onClick={toggleSound} aria-pressed={sound}>
        <span className={`slide__eq ${sound ? "is-on" : ""}`} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {sound ? "Sound on" : "Sound off"}
      </button>
      <p className="slide__note display">Shot and scored by Clipmunk. No editing.</p>
    </div>
  );
}
