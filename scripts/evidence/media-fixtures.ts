// Media fixtures for the live media probe (scripts/evidence/live/m1-media-probe.ts): a PNG, a spoken WAV and a VP9 WebM,
// each carrying the code word, so that an answer naming it proves the model read the medium (a colour can be guessed;
// a word cannot). The PDF is built in code by e3-fidelity.ts (codeWordPdf). Tools: ImageMagick (PNG, frames), espeak
// (speech), an ffmpeg with the libvpx-vp9 encoder (frames → WebM; ACCOUNTS_PROXY_FFMPEG names it). Writes
// tests/fixtures/media/{code-word.png,code-word.wav,code-word.webm,manifest.json}; the manifest records each file's
// size, sha256 and the tool versions that made it.
// Usage: bun scripts/evidence/media-fixtures.ts [--check]   (--check: the committed files equal the manifest)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot } from "@accounts-proxy/scripts/gate/instrument.ts";
import { removeTemporary } from "@accounts-proxy/test-support/temporary.ts";

export const MEDIA_CODE_WORD = "PELICAN";
export const MEDIA_DIR = join(repositoryRoot, "tests", "fixtures", "media");
export const IMAGE_FILE = "code-word.png";
export const AUDIO_FILE = "code-word.wav";
export const VIDEO_FILE = "code-word.webm";

type Entry = { readonly file: string; readonly mimeType: string; readonly bytes: number; readonly sha256: string; readonly madeWith: string };
export type MediaManifest = { readonly codeWord: string; readonly files: readonly Entry[] };

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function run(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error !== undefined) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`);
  return `${result.stdout}${result.stderr}`;
}

const firstLine = (text: string) => text.trim().split("\n")[0]!.trim();

export function readManifest(): MediaManifest {
  return JSON.parse(readFileSync(join(MEDIA_DIR, "manifest.json"), "utf8")) as MediaManifest;
}

/** The fixture's bytes, after checking them against the manifest. */
export function mediaBytes(file: string): Uint8Array {
  const entry = readManifest().files.find((f) => f.file === file);
  if (entry === undefined) throw new Error(`tests/fixtures/media/manifest.json has no ${file}`);
  const bytes = readFileSync(join(MEDIA_DIR, file));
  if (sha256(bytes) !== entry.sha256) throw new Error(`tests/fixtures/media/${file} differs from its manifest sha256`);
  return bytes;
}

function generate(): MediaManifest {
  const ffmpeg = process.env["ACCOUNTS_PROXY_FFMPEG"] ?? "ffmpeg";
  mkdirSync(MEDIA_DIR, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "ap-media-"));

  run("magick", ["-size", "320x180", "xc:white", "-fill", "black", "-gravity", "center", "-pointsize", "56", "-annotate", "+0+0", MEDIA_CODE_WORD, "-strip", join(MEDIA_DIR, IMAGE_FILE)]);

  const audio = join(MEDIA_DIR, AUDIO_FILE);
  run("espeak", ["-v", "en-us", "-s", "140", "-w", audio, `The code word is ${MEDIA_CODE_WORD}.`]);

  // 3 s at 4 fps, 320×180: the word on every frame.
  for (let i = 0; i < 12; i++) {
    run("magick", ["-size", "320x180", "xc:#1f4e9c", "-fill", "white", "-gravity", "center", "-pointsize", "48", "-annotate", "+0+0", MEDIA_CODE_WORD, join(work, `f${String(i).padStart(2, "0")}.jpg`)]);
  }
  const frames = readdirSync(work).filter((f) => f.endsWith(".jpg")).sort();
  const piped = Buffer.concat(frames.map((f) => readFileSync(join(work, f))));
  const video = join(MEDIA_DIR, VIDEO_FILE);
  const encode = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", "4", "-i", "pipe:0", "-c:v", "libvpx-vp9", "-b:v", "200k", "-pix_fmt", "yuv420p", "-fflags", "+bitexact", video], { input: piped });
  removeTemporary(work);
  if (encode.status !== 0) throw new Error(`${ffmpeg} exited ${encode.status}: ${String(encode.stderr)}`);

  const entry = (file: string, mimeType: string, madeWith: string): Entry => {
    const bytes = readFileSync(join(MEDIA_DIR, file));
    return { file, mimeType, bytes: bytes.length, sha256: sha256(bytes), madeWith };
  };
  const manifest: MediaManifest = {
    codeWord: MEDIA_CODE_WORD,
    files: [
      entry(IMAGE_FILE, "image/png", firstLine(run("magick", ["-version"]))),
      entry(AUDIO_FILE, "audio/wav", firstLine(run("espeak", ["--version"]))),
      entry(VIDEO_FILE, "video/webm", `${firstLine(run("magick", ["-version"]))}; ${firstLine(run(ffmpeg, ["-hide_banner", "-version"]))}`),
    ],
  };
  writeFileSync(join(MEDIA_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    for (const f of readManifest().files) mediaBytes(f.file);
    console.log("media fixtures match tests/fixtures/media/manifest.json");
  } else {
    const manifest = generate();
    for (const f of manifest.files) console.log(`${f.file} ${f.bytes} bytes sha256 ${f.sha256}`);
  }
}
