import CopyCommand from "@/components/ui/CopyCommand";
import CopyPromptButton from "@/components/ui/CopyPromptButton";
import HeroScene from "./HeroScene";

/** Two columns of about the same height: the copy, and the scene beside it. */
export default function Hero() {
  return (
    <section className="hero" id="top">
      <div className="wrap hero__grid">
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

        <div className="hero__art">
          <HeroScene />
        </div>
      </div>
    </section>
  );
}
