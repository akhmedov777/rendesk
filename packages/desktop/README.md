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

Set managed infrastructure env vars before building:

```bash
export ANTHROPIC_API_KEY="..."
export ONLYOFFICE_DOCUMENT_SERVER_URL="https://docs.your-company.example"
export ONLYOFFICE_JWT_SECRET="..."
# optional
export ONLYOFFICE_CALLBACK_BASE_URL=""
export ONLYOFFICE_AUTO_TUNNEL_ENABLED="true"
```

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

Packaged builds run in managed mode:

- Anthropic and OnlyOffice credentials are injected at build/package time by internal infrastructure.
- End users cannot connect providers or enter API keys in the app.

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
