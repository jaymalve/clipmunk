import CopyPromptButton from "@/components/ui/CopyPromptButton";
import HeroScene from "./HeroScene";

/** Copy on the left, then the scene, wide and tilted, underneath. */
export default function Hero() {
  return (
    <section className="hero" id="top">
      <div className="wrap hero__top">
        <div className="hero__copy">
          <h1 className="hero__h1">TypeScript SDK for product videos</h1>

          <p className="hero__tag">
            Ship the feature. <span className="munk">Clipmunk cuts the clip.</span>
          </p>

          <p className="hero__sub">For React and Next.js apps. Added with one command.</p>

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
