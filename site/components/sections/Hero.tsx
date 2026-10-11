import HeroScene from "./HeroScene";

/** Copy on the left, then the scene, wide and tilted, underneath. */
export default function Hero() {
  return (
    <section className="hero" id="top">
      <div className="wrap hero__top">
        <div className="hero__copy">
          <h1 className="hero__h1">
            Ship the feature. <span className="grad">Clipmunk cuts the clip.</span>
          </h1>

          <p className="hero__sub">
            Clipmunk lives inside your web app. Your coding agent directs{" "}
            <strong>cinematic shots of your real UI</strong>, you record a take with one shortcut, and Clipmunk handles
            the cursor, zooms and soundtrack. You get an MP4, made on your machine.
          </p>

          <div className="hero__ctas">
            <a href="#early-access" className="btn btn--munk">
              Get early access
            </a>
            <a href="#take" className="btn btn--ghost">
              Watch a take <span className="chev">›</span>
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
