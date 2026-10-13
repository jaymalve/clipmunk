"use client";

import { type ComponentType, useRef, useState } from "react";
import FilmSlide from "./FilmSlide";
import LiveSlide from "./LiveSlide";
import type { SlideProps } from "./slide";
import TakeSlide from "./TakeSlide";

const SLIDES: { id: string; label: string; Slide: ComponentType<SlideProps> }[] = [
  { id: "film", label: "Cinematic", Slide: FilmSlide },
  { id: "live", label: "Live", Slide: LiveSlide },
  { id: "take", label: "Take", Slide: TakeSlide },
];

/**
 * The hero's player: three kinds of video Clipmunk makes, one at a time.
 * It moves on by itself when a slide finishes, until the visitor picks a tab or touches a slide;
 * after that it stays where they put it.
 */
export default function HeroPlayer() {
  const [active, setActive] = useState(0);
  const [kept, setKept] = useState(false);
  const line = useRef<HTMLSpanElement>(null);
  const current = SLIDES[active]!;

  function pick(index: number) {
    setKept(true);
    setActive(index);
  }

  return (
    <div className="player">
      <div className="player__bar">
        <span className="player__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <div className="player__tabs" role="tablist" aria-label="Kinds of video">
          {SLIDES.map((slide, index) => (
            <button
              key={slide.id}
              type="button"
              role="tab"
              id={`player-tab-${slide.id}`}
              aria-selected={index === active}
              aria-controls="player-stage"
              className={index === active ? "is-on" : ""}
              onClick={() => pick(index)}
            >
              {slide.label}
              {index === active && <span ref={line} className="player__line" />}
            </button>
          ))}
        </div>
      </div>
      <div className="player__stage" id="player-stage" role="tabpanel" aria-labelledby={`player-tab-${current.id}`}>
        <current.Slide
          key={current.id}
          onProgress={(fraction) => line.current?.style.setProperty("--played", String(fraction))}
          onDone={() => {
            if (!kept) setActive((index) => (index + 1) % SLIDES.length);
          }}
          onTouch={() => setKept(true)}
        />
      </div>
    </div>
  );
}
