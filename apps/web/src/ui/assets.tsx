// The browser assets Vite built into dist/ (vite.config.ts). File names carry
// a content hash, so pages read them from the build manifest; the manifest
// exists once `vite build` has run, which the npm scripts do first.
import manifest from "../../dist/.vite/manifest.json";

type Chunk = { file: string; imports?: string[] };
const chunks: Record<string, Chunk> = manifest;

const url = (key: string) => {
  const chunk = chunks[key];
  if (!chunk) throw new Error(`${key} is not in the Vite manifest`);
  return `/${chunk.file}`;
};

// Stylesheets by page group, in the order a page lists them; every page
// starts with "common".
export type Style = "common" | "site" | "admin" | "game" | "room" | "screen";
export type Script = "site" | "room" | "solo" | "match" | "screen";

export const fontUrl = url("client/fonts/bricolage-latin.woff2");

export function Styles({ names }: { names: Style[] }) {
  return (
    <>
      {names.map((name) => (
        <link rel="stylesheet" href={url(`client/styles/${name}.css`)} />
      ))}
    </>
  );
}

// A module script, with a preload for each chunk it imports, so the browser
// fetches them in parallel instead of after parsing the entry.
export function ScriptTag({ name }: { name: Script }) {
  const key = `client/${name}.js`;
  return (
    <>
      {(chunks[key]?.imports ?? []).map((chunk) => (
        <link rel="modulepreload" href={url(chunk)} />
      ))}
      <script type="module" src={url(key)} />
    </>
  );
}
