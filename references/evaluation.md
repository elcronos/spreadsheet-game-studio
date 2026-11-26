# Evaluation

Criteria are in `evals/criteria.md` (written before implementation). Evidence
lives in `evals/results/` and `evals/screenshots/`.

| Layer | Command | What it proves |
|---|---|---|
| Core | `npm test` | formula safety, validation, quantiser, diff, protocol round trip |
| Gameplay (headless) | `node --import tsx --test tests/gridlock/*.test.ts` | movement, vehicles (measured handling table), police escalate → pursue → search → escape, missions' objective/fail/restart logic, a physics-driven scripted driver winning the race, sheet edits changing behaviour |
| Second game | `node --import tsx --test tests/fieldbook/*.test.ts` | the contracts generalise |
| Bridge | `bash scripts/excel/run_tests.sh` | SGF1 parity, mock + LibreOffice Calc cell readback, edit sync, backpressure |
| Browser | `node evals/browser-evals.mjs` | cell store == pipeline frame == drawn pixels; no image/video/WebGL in sheet mode; UI edits and formulas change the game; invalid input rejected; per-resolution FPS / p95 frame time / changed cells, diff vs full; scene screenshots |
| Pipeline perf | `npm run bench:pipeline` | quantise/diff/encode cost and bytes per resolution |

## Critic agents

Give each critic only the evidence (screenshots, results JSON, code paths) and
the rubric. Require specific findings: location in the image or file, why it
is a problem, the concrete fix. Reject generic praise. Re-run the affected
evals after each fix.

## Honesty rules

- Record the rendering environment next to every number (headless SwiftShader
  is a CPU rasteriser: its FPS is a floor, not a forecast for a GPU).
- A scripted driver is weaker than a person; report its completion rate rather
  than tuning tests until they pass.
- Never mark native Excel performance as measured without a run on Excel.
