import Chip from "@/components/chip/Chip";
import CopyCommand from "@/components/ui/CopyCommand";
import CopyPromptButton from "@/components/ui/CopyPromptButton";

/** The closing call to action: the same two ways in as the hero. */
export default function FinalCTA() {
  return (
    <section className="cta" id="start">
      <div className="wrap cta__in">
        <div className="cta__chip">
          <Chip eye="happy" motion="float" />
        </div>
        <h2 className="cta__h2">Start with one prompt.</h2>
        <p className="cta__sub">
          Ship the feature. Close the screen recorder you never liked. Clipmunk cuts the clip, and it is in the pull
          request before anyone asks to see it.
        </p>
        <div className="cta__actions">
          <CopyPromptButton />
          <CopyCommand />
        </div>
      </div>
    </section>
  );
}
