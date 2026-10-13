import Chip from "@/components/chip/Chip";
import EarlyAccessForm from "./EarlyAccessForm";

export default function FinalCTA() {
  return (
    <section className="cta" id="early-access">
      <div className="wrap cta__in">
        <div className="cta__chip">
          <Chip eye="happy" motion="float" />
        </div>
        <h2 className="cta__h2">Get early access.</h2>
        <p className="cta__sub">
          Ship the feature. Close the screen recorder you never liked. Clipmunk cuts the clip, and it is in the pull
          request before anyone asks to see it.
        </p>
        <EarlyAccessForm />
      </div>
    </section>
  );
}
