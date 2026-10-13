/** What the player gives each slide. */
export type SlideProps = {
  /** How far through one showing the slide is, from 0 to 1, for the line under its tab. */
  onProgress: (fraction: number) => void;
  /** The slide has played once through. */
  onDone: () => void;
  /** The visitor did something to the slide itself, so the player should stay on it. */
  onTouch: () => void;
};
