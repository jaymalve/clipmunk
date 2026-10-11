"use client";

import { useEffect, useRef, useState } from "react";
import Chip from "@/components/chip/Chip";
import { isMuted, setMuted, subscribeMute } from "@/components/chip/sound";

const STEPS = [
  { label: "Raw take", text: "You create and send an invoice, once. Wobbly cursor, flat frame, dead air." },
  { label: "Cursor", text: "Your real cursor is swapped for a smooth one. Every click gets a ripple." },
  {
    label: "Zoom",
    text: "The frame follows the work: the button, the form, the new row. Plain keyframes, so you can move them.",
  },
  { label: "Frame", text: "Padding, rounded corners, a shadow and a backdrop." },
  { label: "Camera", text: "Your face in a corner bubble, if you want it there." },
  { label: "Music", text: "A soundtrack written in code and timed to the key moments." },
  { label: "Export", text: "One MP4, in 1080p or 4K. Done before the kettle is." },
];
const INVOICES = [
  { client: "Globex", amount: "$1,850", paid: true },
  { client: "Initech", amount: "$920", paid: true },
  { client: "Hooli", amount: "$6,400", paid: false },
  { client: "Umbrella", amount: "$2,300", paid: true },
];
/** What the take clicks, in order, and how far across each one the cursor lands. */
const CLICKS = [
  { target: ".inv__new", across: 0.5 },
  { target: ".inv__input--client", across: 0.3 },
  { target: ".inv__input--amount", across: 0.3 },
  { target: ".inv__toggle i", across: 0.5 },
  { target: ".inv__send", across: 0.5 },
];
const LAST = STEPS.length - 1;
/** The pass that adds the soundtrack; from here on the replay has music. */
const MUSIC_STEP = 5;
const STEP_MS = 3600;
const WAVE = [
  5, 9, 14, 8, 12, 18, 10, 6, 13, 17, 9, 5, 11, 16, 12, 7, 14, 19, 11, 6, 9, 15, 10, 13, 18, 8, 5, 12, 16, 9, 7, 14,
];

/** One recording, replayed while each of Chip's passes is switched on in turn. */
export default function Take() {
  const panel = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const screen = useRef<HTMLDivElement>(null);

  // Tell the stylesheet where each click target really is, so the cursor and its ripples land on them at any size.
  useEffect(() => {
    const frame = screen.current;
    if (!frame) return;
    function aim() {
      if (!frame) return;
      CLICKS.forEach((click, index) => {
        const target = frame.querySelector<HTMLElement>(click.target);
        if (!target) return;
        let x = target.offsetWidth * click.across;
        let y = target.offsetHeight / 2;
        for (
          let node: HTMLElement | null = target;
          node && node !== frame;
          node = node.offsetParent as HTMLElement | null
        ) {
          x += node.offsetLeft;
          y += node.offsetTop;
        }
        frame.style.setProperty(`--x${index + 1}`, `${((x / frame.offsetWidth) * 100).toFixed(2)}%`);
        frame.style.setProperty(`--y${index + 1}`, `${((y / frame.offsetHeight) * 100).toFixed(2)}%`);
      });
    }
    aim();
    const watcher = new ResizeObserver(aim);
    watcher.observe(frame);
    return () => watcher.disconnect();
  }, []);
  const [visible, setVisible] = useState(false);
  // Whether the soundtrack is audible. A browser refuses sound until the visitor has clicked something on the page.
  const [audible, setAudible] = useState(false);
  // The visitor turned the soundtrack off here; stay quiet until they turn it back on.
  const [hushed, setHushed] = useState(false);

  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        const seen = entries.some((entry) => entry.isIntersecting);
        setVisible(seen);
        if (seen) setPlaying(true);
      },
      { threshold: 0.45 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const scored = step >= MUSIC_STEP;

  useEffect(() => {
    const player = audio.current;
    if (!player) return;
    if (!scored || !visible || hushed || isMuted()) {
      player.pause();
      setAudible(false);
      if (!scored) player.currentTime = 0;
      return;
    }
    player.volume = 0.6;
    player.play().then(
      () => setAudible(true),
      () => setAudible(false),
    );
  }, [scored, visible, hushed]);

  useEffect(
    () =>
      subscribeMute(() => {
        if (!isMuted()) return;
        audio.current?.pause();
        setAudible(false);
      }),
    [],
  );

  function toggleSound() {
    const player = audio.current;
    if (!player) return;
    if (audible) {
      setHushed(true);
      return;
    }
    if (isMuted()) setMuted(false);
    setHushed(false);
    player.volume = 0.6;
    player.play().then(
      () => setAudible(true),
      () => setAudible(false),
    );
  }

  useEffect(() => {
    if (!playing || step >= LAST) return;
    const timer = window.setTimeout(() => setStep((value) => value + 1), STEP_MS);
    return () => window.clearTimeout(timer);
  }, [playing, step]);

  const reached = STEPS.slice(0, step + 1)
    .map((_, index) => `is-s${index}`)
    .join(" ");

  return (
    <section className="take" id="take">
      <div className="wrap">
        <div ref={panel} className={`take__panel lit ${reached}`}>
          <div className="take__top">
            <div className="tv">
              <div className="tv__screen">
                <div ref={screen} className="tv__zoom">
                  <div className="win__bar">
                    <span className="win__dots">
                      <i />
                      <i />
                      <i />
                    </span>
                    acme.app/invoices
                  </div>
                  <div className="inv">
                    <ul className="inv__side">
                      <li>Overview</li>
                      <li className="is-on">Invoices</li>
                      <li>Clients</li>
                      <li>Payouts</li>
                    </ul>
                    <div className="inv__main">
                      <div className="inv__head">
                        <p>
                          Invoices <span>October</span>
                        </p>
                        <span className="inv__new">+ New invoice</span>
                      </div>
                      <ul className="inv__rows">
                        <li className="inv__row inv__row--new">
                          <b>Northwind Co</b>
                          <span>$4,200</span>
                          <i className="is-sent">Sent</i>
                        </li>
                        {INVOICES.map((invoice) => (
                          <li key={invoice.client} className="inv__row">
                            <b>{invoice.client}</b>
                            <span>{invoice.amount}</span>
                            <i className={invoice.paid ? "" : "is-due"}>{invoice.paid ? "Paid" : "Due"}</i>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  <div className="inv__veil" />
                  <div className="inv__modal">
                    <p className="inv__title">New invoice</p>
                    <span className="inv__label">Client</span>
                    <span className="inv__input inv__input--client">
                      <i className="inv__type inv__type--client">Northwind Co</i>
                    </span>
                    <span className="inv__label">Amount</span>
                    <span className="inv__input inv__input--amount">
                      <i className="inv__type inv__type--amount">$4,200</i>
                    </span>
                    <span className="inv__toggle">
                      Remind after 7 days <i />
                    </span>
                    <span className="inv__send">Send invoice</span>
                  </div>
                  <p className="inv__toast">Invoice sent to Northwind Co</p>
                  <span className="tv__ripples">
                    <i className="tv__ripple tv__ripple--1" />
                    <i className="tv__ripple tv__ripple--2" />
                    <i className="tv__ripple tv__ripple--3" />
                    <i className="tv__ripple tv__ripple--4" />
                    <i className="tv__ripple tv__ripple--5" />
                  </span>
                  <svg className="tv__cursor tv__cursor--raw" viewBox="0 0 20 22" aria-hidden="true">
                    <path d="M2 1.5v16l4.4-3.9 2.9 6.6 2.7-1.2-2.9-6.5h6.1z" />
                  </svg>
                  <svg className="tv__cursor tv__cursor--smooth" viewBox="0 0 20 22" aria-hidden="true">
                    <path d="M2 1.5v16l4.4-3.9 2.9 6.6 2.7-1.2-2.9-6.5h6.1z" />
                  </svg>
                </div>
              </div>
              <div className="tv__cam">
                <Chip prop="headphones" eye="happy" interactive={false} track={false} />
              </div>
              {/* biome-ignore lint/a11y/useMediaCaption: instrumental music, nothing to caption */}
              <audio ref={audio} src="/music/upbeat.m4a" loop preload="none" />
              <button
                type="button"
                className={`tv__sound mono ${audible ? "is-on" : ""}`}
                onClick={toggleSound}
                aria-pressed={audible}
                tabIndex={scored ? 0 : -1}
              >
                <span className="tv__eq" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                {audible ? "upbeat · playing" : "Hear the soundtrack"}
              </button>
              <p className="tv__stamp mono">
                <b>send-invoice.mp4</b> · 1920 × 1080 · 0:12
              </p>
            </div>

            <ol className="take__steps">
              {STEPS.map((item, index) => (
                <li key={item.label} className={index === step ? "is-now" : index < step ? "is-done" : ""}>
                  <button
                    type="button"
                    onClick={() => {
                      setPlaying(false);
                      setStep(index);
                    }}
                  >
                    <span className="take__num mono">{index < step ? "✓" : String(index + 1).padStart(2, "0")}</span>
                    <span>
                      <b>{item.label}</b>
                      <em>{item.text}</em>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </div>

          <div className="tl mono" aria-hidden>
            <span className="tl__head" />
            <div className="tl__row tl__row--screen">
              <span>Screen</span>
              <div className="tl__lane">
                <i className="tl__bar" />
              </div>
            </div>
            <div className="tl__row tl__row--cursor">
              <span>Cursor</span>
              <div className="tl__lane">
                <svg viewBox="0 0 400 20" preserveAspectRatio="none" aria-hidden="true">
                  <path
                    className="tl__raw"
                    d="M0 14 l12 -5 9 6 8 -9 11 7 7 -4 10 8 9 -11 12 6 8 -3 10 7 9 -9 11 5 8 4 10 -8 9 6 12 -7 8 5 10 -3 9 8 11 -10 8 6 10 -4 9 7 12 -8 8 3 10 5 9 -9 11 6 8 -2 10 7 9 -6 12 4 8 -5 10 6 11 -4"
                  />
                  <path className="tl__smooth" d="M0 14 C 60 14, 80 5, 140 5 S 220 15, 280 15 S 360 6, 400 8" />
                </svg>
              </div>
            </div>
            <div className="tl__row tl__row--zoom">
              <span>Zoom</span>
              <div className="tl__lane">
                <i className="tl__block" style={{ left: "5%", width: "8%" }} />
                <i className="tl__block" style={{ left: "16%", width: "49%" }} />
                <i className="tl__block" style={{ left: "68%", width: "22%" }} />
              </div>
            </div>
            <div className="tl__row tl__row--cam">
              <span>Camera</span>
              <div className="tl__lane">
                <i className="tl__bar" />
              </div>
            </div>
            <div className="tl__row tl__row--music">
              <span>Music</span>
              <div className="tl__lane tl__wave">
                {WAVE.map((height, index) => (
                  <i key={index} style={{ height, animationDelay: `${(index % 8) * 0.09}s` }} />
                ))}
              </div>
            </div>
            <div className="tl__export">
              <span>Export</span>
              <div className="tl__progress">
                <i />
              </div>
              <b>100%</b>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
