set shell := ["bash", "-uc"]

# List recipes
default:
    @just --list

# Install dependencies
setup:
    npm install

# Compile TypeScript -> out/
compile:
    npm run compile

# Format sources
fmt:
    npm run format

# Lint
lint:
    npm run lint

# CI-equivalent: format-check + lint + compile + verify vendored viewer
check:
    npm run check

# Run the Extension Development Host smoke test (headless via xvfb)
test:
    xvfb-run -a npm test

# Re-vendor the viewer artifact from ../openscad-web (build it there first)
sync-viewer *ARGS:
    npm run sync-viewer -- {{ARGS}}
