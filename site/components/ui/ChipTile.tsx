import Chip, { type ChipEye, type ChipProp } from "@/components/chip/Chip";

/** The lit square with Chip in it that sits above a section heading. */
export default function ChipTile({ eye = "open", prop = "none" }: { eye?: ChipEye; prop?: ChipProp }) {
  return (
    <div className="tile">
      <Chip eye={eye} prop={prop} />
    </div>
  );
}
