// A person's monogram and a category's mosaic, in the hues the server pages
// give the same names.
import { hueOf } from "../../src/ui/marks";

export function Mono(props: { name: string; size?: number }) {
  return (
    <span
      class="mono"
      style={{
        "--hue": String(hueOf(props.name)),
        "--s": props.size ? `${props.size}px` : undefined,
      }}
      aria-hidden="true"
    >
      {[...props.name][0] ?? "?"}
    </span>
  );
}

export function Mosaic(props: { seed: string }) {
  return (
    <span
      class="mosaic"
      style={{ "--hue": String(hueOf(props.seed)) }}
      aria-hidden="true"
    />
  );
}
