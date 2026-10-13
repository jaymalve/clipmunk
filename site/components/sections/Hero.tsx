import CopyCommand from "@/components/ui/CopyCommand";
import CopyPromptButton from "@/components/ui/CopyPromptButton";
import HeroScene from "./HeroScene";

/** The copy, then the scene underneath at the full width of the page. */
export default function Hero() {
  return (
    <section className="hero" id="top">
      <div className="wrap hero__top">
        <div className="hero__copy">
          <h1 className="hero__h1">TypeScript SDK for product videos</h1>

          <p className="hero__tag">
            Ship the feature. <span className="munk">Clipmunk cuts the clip.</span>
          </p>

          <div className="hero__ctas">
            <CopyPromptButton />
            <CopyCommand />
          </div>
        </div>
      </div>

      <div className="hero__art">
        <HeroScene />
      </div>
    </section>
  );
}
