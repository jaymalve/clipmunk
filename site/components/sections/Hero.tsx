import CopyPromptButton from "@/components/ui/CopyPromptButton";
import HeroScene from "./HeroScene";

/** Copy on the left, then the scene, wide and tilted, underneath. */
export default function Hero() {
  return (
    <section className="hero" id="top">
      <div className="wrap hero__top">
        <div className="hero__copy">
          <h1 className="hero__h1">
            Ship the feature. <span className="munk">Clipmunk cuts the clip.</span>
          </h1>

          <p className="hero__sub">
            Clipmunk is a drop-in SDK for React and Next.js apps, added with one command. Your coding agent directs{" "}
            <strong>cinematic shots of your real UI</strong>, or you record a take yourself. Out comes a polished MP4
            with a smooth cursor, auto-zooms and music, made on your machine.
          </p>

          <div className="hero__ctas">
            <CopyPromptButton />
            <a href="#early-access" className="btn">
              Get early access
            </a>
          </div>
        </div>
      </div>

      <div className="hero__art">
        <div className="hero__glow" aria-hidden />
        <HeroScene />
      </div>
    </section>
  );
}
