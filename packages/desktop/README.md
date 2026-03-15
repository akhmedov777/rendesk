# Rendesk

Electron desktop shell for Rendesk.

## Prerequisites

Install workspace dependencies first:

```bash
bun install
```

## Development

From the repo root:

```bash
bun run --cwd packages/desktop dev
```

## Build

```bash
bun run --cwd packages/desktop build
```

## Package Installers

Build unsigned installers locally:

```bash
bun run --cwd packages/desktop dist:mac
bun run --cwd packages/desktop dist:win
```

Artifacts are written to `packages/desktop/release/`.

## Downloads

Tagged releases publish download assets to GitHub Releases:

- macOS Apple Silicon: `.dmg` and `.zip`
- macOS Intel: `.dmg` and `.zip`
- Windows x64: `.exe` installer

## First Run

Packaged builds no longer require a local `.env.local` file. Users connect Anthropic from the existing provider settings and the API key is stored under the desktop app's `userData` directory.

## Unsigned Beta Install Notes

Because the first downloadable release is unsigned, operating systems will warn before launch.

### macOS

1. Download the `.dmg` from GitHub Releases.
2. Drag `Rendesk.app` into `Applications`.
3. If macOS blocks launch, right-click the app and choose `Open`, or allow it in `System Settings > Privacy & Security`.

### Windows

1. Download the `.exe` installer from GitHub Releases.
2. If SmartScreen warns, select `More info` and then `Run anyway`.
3. Finish the NSIS installer and launch `Rendesk`.
