# HQPlayer protocol fixtures

Empty on purpose until the first real `hqp-probe` report arrives from HQPlayer Desktop 6.

Rules for anything added here:

- Only **sanitised** request/response samples (as produced by `hqp-probe` without `--include-raw`).
- Name files `<command>.<hqplayer-version>.xml`, e.g. `Status.6.0.3.xml`, and note the probe report they came from.
- Never add licence data, local paths, track titles, playlist names or host names.
- Synthetic test responses live in `packages/hqplayer-adapter/src/testing/` and are clearly marked as synthetic — they are not evidence of engine behaviour.
